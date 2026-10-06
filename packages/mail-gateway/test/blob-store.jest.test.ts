import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  BlobStore,
  BLOB_OFFLOAD_THRESHOLD_BYTES,
  createBlobStore,
  LocalFsBlobStore,
  S3BlobStore,
  CreditLedger,
  InboundEmailHandler,
  OutboundMtaWorker,
  OutboundEmailDelivery,
  DkimSigner,
  MxDirectTransport,
  CheckoutServer,
  GatewayConfig,
  InboundEmail,
} from '../src';

class MockStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  sentMessages: Array<{ recipientAddress: string; text: string }> = [];

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
  }) {
    this.sentMessages.push(params);
    return {
      success: true,
      txHash: `0xmock_tx_${Date.now()}`,
      payloadDigest: '0xmock_digest',
      recipientAddress: params.recipientAddress,
      feePaidWei: 1000n,
    };
  }

  async checkHealth() {
    return { ok: true, latencyMs: 1 };
  }

  async getBalance() {
    return { raw: 10000000000000000000n, display: '10.0 MON', isLowBalance: false };
  }
}

describe('Issue #983: Hybrid BlobStorage (S3/MinIO/LocalFS)', () => {
  describe('1. LocalFsBlobStore', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-store-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('stores, retrieves, checks existence, and deletes blobs on disk', async () => {
      const store = new LocalFsBlobStore({ storageDir: tmpDir });
      const testKey = 'held/msg-001.eml';
      const content = Buffer.from('Subject: Hello World\r\n\r\nThis is a test message.');

      // 1. Put
      const uri = await store.put(testKey, content);
      expect(uri).toBe(`blob://${testKey}`);

      // 2. Has
      expect(await store.has(testKey)).toBe(true);
      expect(await store.has(`blob://${testKey}`)).toBe(true);
      expect(await store.has('held/nonexistent.eml')).toBe(false);

      // 3. Get
      const retrieved = await store.get(testKey);
      expect(retrieved).not.toBeNull();
      expect(Buffer.from(retrieved!).toString('utf-8')).toBe(content.toString('utf-8'));

      // Also get with blob:// URI prefix
      const retrievedViaUri = await store.get(`blob://${testKey}`);
      expect(retrievedViaUri).not.toBeNull();
      expect(Buffer.from(retrievedViaUri!).toString('utf-8')).toBe(content.toString('utf-8'));

      // 4. Delete
      await store.delete(testKey);
      expect(await store.has(testKey)).toBe(false);
      expect(await store.get(testKey)).toBeNull();

      // Deleting already deleted key should be idempotent
      await expect(store.delete(testKey)).resolves.not.toThrow();
    });

    it('namespaces keys into 2-level subdirectories on disk', async () => {
      const store = new LocalFsBlobStore({ storageDir: tmpDir });
      // Use hex key to observe exact ab/cd/abcdef... subdirectories
      const hexKey = 'abcdef1234567890deadbeef';
      const data = 'Namespaced content';

      await store.put(hexKey, data);

      const expectedSubdir = path.join(tmpDir, 'ab', 'cd');
      expect(fs.existsSync(expectedSubdir)).toBe(true);

      const expectedFilePath = path.join(expectedSubdir, hexKey);
      expect(fs.existsSync(expectedFilePath)).toBe(true);
      expect(fs.readFileSync(expectedFilePath, 'utf-8')).toBe(data);

      const retrieved = await store.get(hexKey);
      expect(new TextDecoder().decode(retrieved!)).toBe(data);
    });

    it('supports memory fallback mode without touching disk', async () => {
      const store = new LocalFsBlobStore({ inMemory: true });
      const key = 'test-memory-key';
      const data = new Uint8Array([10, 20, 30, 40]);

      expect(await store.has(key)).toBe(false);
      expect(await store.get(key)).toBeNull();

      const uri = await store.put(key, data);
      expect(uri).toBe(`blob://${key}`);
      expect(await store.has(key)).toBe(true);

      const retrieved = await store.get(key);
      expect(retrieved).toEqual(data);

      await store.delete(key);
      expect(await store.has(key)).toBe(false);
      expect(await store.get(key)).toBeNull();
    });
  });

  describe('2. S3BlobStore & SigV4 Signer', () => {
    let mockS3Server: http.Server;
    let s3Port: number;
    const bucket = 'test-email-blobs';
    const accessKeyId = 'MOCK_ACCESS_KEY';
    const secretAccessKey = 'MOCK_SECRET_KEY_1234567890';
    const region = 'us-east-1';

    const s3Objects = new Map<string, { body: Buffer; contentType: string }>();
    const receivedAuthHeaders: string[] = [];

    beforeAll(async () => {
      mockS3Server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const auth = req.headers['authorization'];
        if (auth) {
          receivedAuthHeaders.push(auth);
        }

        // Expected path: /test-email-blobs/<key>
        const prefix = `/${bucket}/`;
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid bucket path');
          return;
        }

        const objectKey = decodeURIComponent(url.pathname.slice(prefix.length));

        // SigV4 authorization check
        if (!auth || !auth.startsWith('AWS4-HMAC-SHA256 Credential=' + accessKeyId)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: Invalid SigV4 signature');
          return;
        }

        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(Buffer.from(c)));
          req.on('end', () => {
            const body = Buffer.concat(chunks);
            s3Objects.set(objectKey, {
              body,
              contentType: (req.headers['content-type'] as string) || 'application/octet-stream',
            });
            res.writeHead(200);
            res.end();
          });
          return;
        }

        if (req.method === 'GET') {
          const obj = s3Objects.get(objectKey);
          if (!obj) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('NoSuchKey');
            return;
          }
          res.writeHead(200, { 'Content-Type': obj.contentType });
          res.end(obj.body);
          return;
        }

        if (req.method === 'HEAD') {
          const obj = s3Objects.get(objectKey);
          if (!obj) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': obj.contentType,
            'Content-Length': String(obj.body.length),
          });
          res.end();
          return;
        }

        if (req.method === 'DELETE') {
          s3Objects.delete(objectKey);
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(405);
        res.end();
      });

      await new Promise<void>((resolve) => {
        mockS3Server.listen(0, '127.0.0.1', () => {
          s3Port = (mockS3Server.address() as any).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => mockS3Server.close(() => resolve()));
    });

    beforeEach(() => {
      s3Objects.clear();
      receivedAuthHeaders.length = 0;
    });

    it('signs requests with valid SigV4 and performs Put, Get, Has, Delete against S3/MinIO', async () => {
      const s3Store = new S3BlobStore({
        endpoint: `http://127.0.0.1:${s3Port}`,
        bucket,
        accessKeyId,
        secretAccessKey,
        region,
        forcePathStyle: true,
      });

      const key = 'held/msg-s3-100.eml';
      const content = 'From: test@external.com\r\nSubject: S3 Offload Test\r\n\r\nLarge content body';

      // 1. Put
      const uri = await s3Store.put(key, content);
      expect(uri).toBe(`blob://${key}`);
      expect(s3Objects.has(key)).toBe(true);

      // Verify SigV4 Authorization header structure
      expect(receivedAuthHeaders.length).toBeGreaterThan(0);
      const lastAuth = receivedAuthHeaders[receivedAuthHeaders.length - 1];
      expect(lastAuth).toContain('AWS4-HMAC-SHA256');
      expect(lastAuth).toContain(`Credential=${accessKeyId}`);
      expect(lastAuth).toContain('SignedHeaders=');
      expect(lastAuth).toContain('Signature=');

      // 2. Has
      expect(await s3Store.has(key)).toBe(true);
      expect(await s3Store.has('nonexistent-key')).toBe(false);

      // 3. Get
      const retrieved = await s3Store.get(key);
      expect(retrieved).not.toBeNull();
      expect(new TextDecoder().decode(retrieved!)).toBe(content);

      // 4. Get 404 returns null
      expect(await s3Store.get('missing.eml')).toBeNull();

      // 5. Delete
      await s3Store.delete(key);
      expect(await s3Store.has(key)).toBe(false);
      expect(await s3Store.get(key)).toBeNull();
    });

    it('builds virtual hosted style and path style URLs correctly', () => {
      const pathStyleStore = new S3BlobStore({
        endpoint: 'https://minio.internal:9000',
        bucket: 'my-bucket',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        forcePathStyle: true,
      });
      const url1 = pathStyleStore.buildUrl('folder/file.eml');
      expect(url1.toString()).toBe('https://minio.internal:9000/my-bucket/folder/file.eml');

      const virtualHostStore = new S3BlobStore({
        bucket: 'my-bucket',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        region: 'us-west-2',
        forcePathStyle: false,
      });
      const url2 = virtualHostStore.buildUrl('folder/file.eml');
      expect(url2.toString()).toBe('https://my-bucket.s3.us-west-2.amazonaws.com/folder/file.eml');
    });
  });

  describe('3. Hybrid Threshold Offloading in CreditLedger', () => {
    it('stores small payload (<= 64KB) inline and offloads large payload (> 64KB) to BlobStore', async () => {
      const memoryStore = new LocalFsBlobStore({ inMemory: true });
      const ledger = new CreditLedger(':memory:', memoryStore);

      // 1. Small payload (1 KB <= 64KB)
      const smallText = 'A'.repeat(1024);
      const smallBytes = new TextEncoder().encode(smallText);
      await ledger.holdMessage({
        id: 'msg_small',
        senderEmail: 'sender1@example.com',
        recipientAddress: '0xrecipient1',
        dkimDomain: 'example.com',
        subject: 'Small Message',
        rawRfc822: smallBytes,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 100000,
      });

      const heldSmall = ledger.getHeldMessage('msg_small');
      expect(heldSmall).toBeDefined();
      // Should NOT be offloaded to memoryStore
      expect(await memoryStore.has('held/msg_small.eml')).toBe(false);
      // Stored inline
      expect(heldSmall?.rawRfc822.byteLength).toBe(smallBytes.byteLength);
      // resolvePayload returns inline text
      const resolvedSmall = await ledger.resolvePayload(heldSmall!.rawRfc822);
      expect(resolvedSmall).toBe(smallText);

      // 2. Large payload (70 KB > 64KB threshold)
      const largeText = 'B'.repeat(70 * 1024);
      const largeBytes = new TextEncoder().encode(largeText);
      await ledger.holdMessage({
        id: 'msg_large',
        senderEmail: 'sender2@example.com',
        recipientAddress: '0xrecipient2',
        dkimDomain: 'example.com',
        subject: 'Large Message',
        rawRfc822: largeBytes,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 100000,
      });

      const heldLarge = ledger.getHeldMessage('msg_large');
      expect(heldLarge).toBeDefined();
      // Should be offloaded to memoryStore under held/msg_large.eml
      expect(await memoryStore.has('held/msg_large.eml')).toBe(true);
      // Database stores pointer string: blob://held/msg_large.eml
      const storedPointer = new TextDecoder().decode(heldLarge!.rawRfc822);
      expect(storedPointer).toBe('blob://held/msg_large.eml');
      // resolvePayload transparently fetches the 70KB data from memoryStore
      const resolvedLarge = await ledger.resolvePayload(heldLarge!.rawRfc822);
      expect(resolvedLarge.length).toBe(70 * 1024);
      expect(resolvedLarge).toBe(largeText);
    });

    it('hybrid offloading for outbound spool jobs', async () => {
      const memoryStore = new LocalFsBlobStore({ inMemory: true });
      const ledger = new CreditLedger(':memory:', memoryStore);

      // 1. Small spool job
      const smallMime = 'From: frank@org\r\n\r\nSmall body';
      const smallJobId = await ledger.enqueueOutboundSpool({
        recipientEmail: 'client@remote.com',
        fromAddress: 'frank@org',
        rawRfc822: smallMime,
      });
      const smallJob = ledger.getOutboundJob(smallJobId);
      expect(smallJob?.rawRfc822).toBe(smallMime);
      expect(await ledger.resolvePayload(smallJob!.rawRfc822)).toBe(smallMime);

      // 2. Large spool job (> 64KB)
      const largeMime = 'From: frank@org\r\n\r\n' + 'X'.repeat(80 * 1024);
      const largeJobId = await ledger.enqueueOutboundSpool({
        recipientEmail: 'client@remote.com',
        fromAddress: 'frank@org',
        rawRfc822: largeMime,
      });
      const largeJob = ledger.getOutboundJob(largeJobId);
      expect(largeJob?.rawRfc822.startsWith('blob://spool/')).toBe(true);
      // resolvePayload recovers full 80KB+ MIME text
      const resolvedLarge = await ledger.resolvePayload(largeJob!.rawRfc822);
      expect(resolvedLarge).toBe(largeMime);
    });
  });

  describe('4. Factory createBlobStore', () => {
    it('creates LocalFsBlobStore with default directory', () => {
      const config: GatewayConfig = {
        gatewayDomain: 'frank.org',
        gatewayRelayUrl: 'https://relay.frank.org',
        stampChain: 'monad',
        httpPort: 8080,
        smtpPort: 2525,
        dkimSelector: 'mta',
        dkimPrivateKey: 'private-key',
        lowBalanceThresholdWei: 1000n,
      };

      const store = createBlobStore(config);
      expect(store).toBeInstanceOf(LocalFsBlobStore);
      expect((store as LocalFsBlobStore).storageDir).toBe('./data/blobs');
      expect((store as LocalFsBlobStore).inMemory).toBe(false);
    });

    it('creates LocalFsBlobStore in memory when provider is memory', () => {
      const config: GatewayConfig = {
        gatewayDomain: 'frank.org',
        gatewayRelayUrl: 'https://relay.frank.org',
        stampChain: 'monad',
        httpPort: 8080,
        smtpPort: 2525,
        dkimSelector: 'mta',
        dkimPrivateKey: 'private-key',
        lowBalanceThresholdWei: 1000n,
        blobStorage: {
          provider: 'memory',
        },
      };

      const store = createBlobStore(config);
      expect(store).toBeInstanceOf(LocalFsBlobStore);
      expect((store as LocalFsBlobStore).inMemory).toBe(true);
    });

    it('creates S3BlobStore when s3Bucket is configured', () => {
      const config: GatewayConfig = {
        gatewayDomain: 'frank.org',
        gatewayRelayUrl: 'https://relay.frank.org',
        stampChain: 'monad',
        httpPort: 8080,
        smtpPort: 2525,
        dkimSelector: 'mta',
        dkimPrivateKey: 'private-key',
        lowBalanceThresholdWei: 1000n,
        s3Bucket: 'my-production-blobs',
        s3Endpoint: 'https://s3.eu-central-1.amazonaws.com',
        s3AccessKeyId: 'AKIA_TEST',
        s3SecretAccessKey: 'SECRET_TEST',
        s3Region: 'eu-central-1',
      };

      const store = createBlobStore(config);
      expect(store).toBeInstanceOf(S3BlobStore);
      const s3 = store as S3BlobStore;
      expect(s3.bucket).toBe('my-production-blobs');
      expect(s3.region).toBe('eu-central-1');
      expect(s3.accessKeyId).toBe('AKIA_TEST');
    });
  });

  describe('5. End-to-End Inbound & Outbound Hybrid Integration', () => {
    let ledger: CreditLedger;
    let blobStore: BlobStore;
    let stampProvider: MockStampProvider;
    let inboundHandler: InboundEmailHandler;
    let checkoutServer: CheckoutServer;

    beforeEach(() => {
      blobStore = new LocalFsBlobStore({ inMemory: true });
      ledger = new CreditLedger(':memory:', blobStore);
      stampProvider = new MockStampProvider();
      inboundHandler = new InboundEmailHandler({
        gatewayDomain: 'frank.org',
        ledger,
        stampProvider,
        blobStore,
      });
      checkoutServer = new CheckoutServer({
        port: 0,
        ledger,
        stampProvider,
      });
    });

    it('inbound handler offloads >64KB email and checkout server resolves offloaded blob upon payment', async () => {
      const largeBody = 'C'.repeat(75 * 1024);
      const rawRfc822 = new TextEncoder().encode(
        `From: sender@outside.org\r\nTo: alice@frank.org\r\nSubject: Huge Attachment\r\n\r\n${largeBody}`
      );

      const email: InboundEmail = {
        messageId: '<huge_msg_1@outside.org>',
        fromAddress: 'sender@outside.org',
        fromDomain: 'outside.org',
        toAddress: 'alice@frank.org',
        localPart: 'alice',
        subject: 'Huge Attachment',
        textBody: largeBody,
        dkimValid: true,
        spfValid: true,
        rawRfc822,
      };

      // 1. Process inbound (0 credits -> held)
      const result = await inboundHandler.processInboundEmail(email);
      expect(result.status).toBe('held');
      expect(result.heldMessageId).toBeDefined();

      const heldId = result.heldMessageId!;
      // Verify offloaded to blobStore
      expect(await blobStore.has(`held/${heldId}.eml`)).toBe(true);

      // 2. Fulfill purchase via CheckoutServer
      await checkoutServer.fulfillPurchase({
        providerTxId: 'tx_pay_huge',
        provider: 'stripe',
        email: 'sender@outside.org',
        credits: 2,
        heldMessageId: heldId,
      });

      // 3. Stamped direct message should have received full resolved text
      expect(stampProvider.sentMessages.length).toBe(1);
      const sent = stampProvider.sentMessages[0];
      expect(sent.text).toContain('Huge Attachment');
      expect(sent.text).toContain(largeBody);
    });

    it('outbound MTA worker offloads >64KB message to spool and delivers resolved payload', async () => {
      let deliveredData = '';
      const mockMx: MxDirectTransport = {
        deliver: async (params: { rawRfc822: Buffer }) => {
          deliveredData = params.rawRfc822.toString('utf-8');
          return { success: true, responseCode: 250 };
        },
      } as any;

      const worker = new OutboundMtaWorker({
        gatewayDomain: 'frank.org',
        ledger,
        delivery: new OutboundEmailDelivery({ gatewayDomain: 'frank.org', ledger }),
        dkimSigner: { sign: (raw: string) => `DKIM-Signed\r\n${raw}` } as any,
        mxTransport: mockMx,
        blobStore,
      });

      // Spool a large message directly into ledger
      const largeEmail = 'From: alice@frank.org\r\nTo: bob@remote.com\r\n\r\n' + 'Z'.repeat(70 * 1024);
      const jobId = await ledger.enqueueOutboundSpool({
        recipientEmail: 'bob@remote.com',
        fromAddress: 'alice@frank.org',
        rawRfc822: largeEmail,
      });

      // Verify offloaded
      const job = ledger.getOutboundJob(jobId);
      expect(job?.rawRfc822.startsWith('blob://spool/')).toBe(true);

      // Process spool
      const summary = await worker.processSpool(Date.now() + 1000);
      expect(summary.succeeded).toBe(1);

      // Verify mock MX received the full resolved 70KB email, not the pointer
      expect(deliveredData).toContain('Z'.repeat(70 * 1024));
      expect(deliveredData).not.toContain('blob://spool/');
    });
  });
});
