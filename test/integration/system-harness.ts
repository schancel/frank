#!/usr/bin/env node
/**
 * Cross-Component System Integration Test Harness
 *
 * Tests the complete loop together across:
 * - Email Gateway Daemon (RFC 5321 SMTP, RFC 5322 MIME, HTTP checkout & webhooks, SQLite ledger)
 * - Frank Relay API (Handle uniqueness, inlined directory entry, rename/moved redirects, tombstone enforcement, mailbox delivery)
 * - Wallet / Client SDK (secp256k1 key generation, profile publication, stamped direct message encryption & retrieval)
 * - Thread Scoping & Bridging (In-Reply-To <-> Frank conversationId)
 * - Real CLI (`signet inbox`, `signet mail send` / `signet send`) with end-to-end cryptographic challenge auth & AES-256-GCM envelope decryption
 *
 * Usage:
 *   node --import tsx test/integration/system-harness.ts
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { EmailGatewayDaemon } from '../../packages/mail-gateway/src/index';
import { GatewayConfig } from '../../packages/mail-gateway/src/types';
import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from '../../packages/mail-gateway/src/stamps/stamp-provider.interface';
import { MockMailboxRelay } from '../../packages/cashweb/relay/monad-mailbox-mock-relay.testutil';
import { buildEnvelope } from '../../packages/cashweb/relay/monad-message-envelope';
import {
  MonadIdentity,
  registerMonadIdentityCbor,
  decodeProfileBytes,
} from '../../packages/wallet/monad-identity';
import { saveIdentity, saveConfig } from '../../packages/cli/src/config';

// -----------------------------------------------------------------------------
// 1. In-Memory Mock/Emulated Frank Relay Server
// -----------------------------------------------------------------------------
interface RelayDirectoryUserRecord {
  username: string;
  account_address: string;
  status: 'active' | 'tombstoned' | 'moved';
  updated_at_ms: number;
  tombstone_expires_at_ms?: number;
  redirect_to?: string;
}

class EmulatedFrankRelay {
  private server?: http.Server;
  private port: number = 0;
  readonly usernames = new Map<string, RelayDirectoryUserRecord>();
  readonly profiles = new Map<string, { contentType: string; rawHex: string }>();
  readonly pubKeys = new Map<string, Buffer>();
  readonly mockMailbox = new MockMailboxRelay({ networkTag: Buffer.from('MONT') });

  registerProfilePubKey(address: string, compressedPubKey: Uint8Array | Buffer) {
    const raw = address.toLowerCase();
    const normalized = raw.startsWith('0x') ? raw : `0x${raw}`;
    const pubBuf = Buffer.from(compressedPubKey);
    this.pubKeys.set(normalized, pubBuf);
    this.mockMailbox.registerProfile(normalized, pubBuf);
  }

  getProfilePubKey(address: string): Uint8Array | undefined {
    const raw = address.toLowerCase();
    const normalized = raw.startsWith('0x') ? raw : `0x${raw}`;
    return this.pubKeys.get(normalized);
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

        // GET /directory/user/:username
        if (req.method === 'GET' && url.pathname.startsWith('/directory/user/')) {
          const rawUser = url.pathname.slice('/directory/user/'.length);
          const normalized = rawUser.trim().toLowerCase();

          if (normalized.length < 3 || normalized.length > 32) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Username must be between 3 and 32 characters' }));
            return;
          }

          const record = this.usernames.get(normalized);
          if (!record) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `User '${normalized}' not found` }));
            return;
          }

          const entry =
            record.status === 'active' ? this.profiles.get(record.account_address.toLowerCase()) : undefined;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              username: record.username,
              account_address: record.account_address,
              status: record.status,
              updated_at_ms: record.updated_at_ms,
              tombstone_expires_at_ms: record.tombstone_expires_at_ms ?? null,
              redirect_to: record.redirect_to ?? null,
              entry: entry
                ? { content_type: entry.contentType, raw_hex: entry.rawHex }
                : null,
            })
          );
          return;
        }

        // PUT /metadata/:address or /metadata/monad/:address
        if (
          req.method === 'PUT' &&
          (url.pathname.startsWith('/metadata/monad/') || url.pathname.startsWith('/metadata/'))
        ) {
          const address = (
            url.pathname.startsWith('/metadata/monad/')
              ? url.pathname.slice('/metadata/monad/'.length)
              : url.pathname.slice('/metadata/'.length)
          ).toLowerCase();
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const contentType = (req.headers['content-type'] as string) || 'application/cbor';
            this.profiles.set(address, {
              contentType,
              rawHex: raw.toString('hex'),
            });
            try {
              const decoded = decodeProfileBytes(new Uint8Array(raw));
              this.registerProfilePubKey(address, decoded.pubKey);
            } catch {
              // Non-CBOR or raw payload
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ txid: [] }));
          });
          return;
        }

        // GET /metadata/:address or /metadata/monad/:address
        if (
          req.method === 'GET' &&
          (url.pathname.startsWith('/metadata/monad/') || url.pathname.startsWith('/metadata/'))
        ) {
          const address = (
            url.pathname.startsWith('/metadata/monad/')
              ? url.pathname.slice('/metadata/monad/'.length)
              : url.pathname.slice('/metadata/'.length)
          ).toLowerCase();
          const profile = this.profiles.get(address);
          if (!profile) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Profile not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': profile.contentType });
          res.end(Buffer.from(profile.rawHex, 'hex'));
          return;
        }

        // Delegate /message/monad/* to MockMailboxRelay
        if (url.pathname.startsWith('/message/monad/')) {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', async () => {
            const body = Buffer.concat(chunks);
            const params: Record<string, string> = {};
            for (const [k, v] of url.searchParams.entries()) {
              params[k] = v;
            }
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers[k] = v;
              else if (Array.isArray(v)) headers[k] = v.join(', ');
            }

            try {
              const result = await this.mockMailbox.http({
                url: url.toString(),
                method: (req.method ?? 'GET').toLowerCase(),
                headers,
                params,
                data: new Uint8Array(body),
              });

              res.writeHead(result.status, result.headers);
              res.end(Buffer.from(result.data));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: msg }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

// -----------------------------------------------------------------------------
// 2. Direct Stamp Provider connected to the Emulated Relay
// -----------------------------------------------------------------------------
class RelayConnectedStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  readonly sentMessages: Array<{
    recipientAddress: string;
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
  }> = [];

  constructor(
    private readonly relay: EmulatedFrankRelay,
    private readonly gatewayIdentity: MonadIdentity
  ) {}

  async getBalance(): Promise<GatewayWalletBalance> {
    return { raw: 10000000000000000000n, display: '10 MON', isLowBalance: false };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'RelayConnectedStampProvider healthy' };
  }

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
  }): Promise<StampSubmissionResult> {
    this.sentMessages.push(params);

    const recipient = params.recipientAddress.toLowerCase();
    const recipientPubKey = this.relay.getProfilePubKey(recipient);
    if (!recipientPubKey) {
      throw new Error(`Cannot find recipient pubKey for ${recipient}`);
    }

    // Build real MonadMessageEnvelopeV2 with AES-256-GCM authenticated encryption
    const encryptedPayload = buildEnvelope({
      fromAddress: this.gatewayIdentity.displayAddress,
      fromPrivateKey: this.gatewayIdentity.toNakamotoPrivateKey(),
      toAddress: params.recipientAddress,
      toPubKey: recipientPubKey,
      plaintext: params.text ?? '',
      networkTag: 'MONT',
    });

    const payloadHash = crypto.createHash('sha256').update(encryptedPayload).digest();

    this.relay.mockMailbox.addMessage({
      recipient,
      timestamp: Date.now(),
      payloadHash,
      encryptedPayload: Buffer.from(encryptedPayload),
      networkTag: Buffer.from('MONT'),
    });

    const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    return {
      txHash,
      payloadDigest: `0x${payloadHash.toString('hex')}`,
      recipientAddress: params.recipientAddress,
    };
  }
}

// -----------------------------------------------------------------------------
// 3. Helper: Raw TCP SMTP Client
// -----------------------------------------------------------------------------
function sendSmtpCommands(port: number, commands: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const responses: string[] = [];
    let buffer = '';
    let cmdIndex = 0;

    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      while (buffer.includes('\n')) {
        const idx = buffer.indexOf('\n');
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        responses.push(line);

        if (
          line.match(/^220 /) ||
          line.match(/^250 /) ||
          line.match(/^354 /) ||
          line.match(/^550 /)
        ) {
          if (cmdIndex < commands.length) {
            const cmd = commands[cmdIndex++];
            socket.write(cmd + '\r\n');
          } else if (line.startsWith('221 ') || line.startsWith('550 ')) {
            socket.end();
          }
        }
      }
    });

    socket.on('close', () => resolve(responses));
  });
}

// -----------------------------------------------------------------------------
// 4. Helper: Asynchronous CLI Invocation
// -----------------------------------------------------------------------------
const cliPath = path.resolve(__dirname, '../../packages/cli/bin/signet.js');
const cliTsconfig = path.resolve(__dirname, '../../packages/cli/tsconfig.json');

async function runCli(args: string[], dataDir: string): Promise<any> {
  const fullArgs = [
    '--import',
    'tsx',
    cliPath,
    ...args,
    '--data-dir',
    dataDir,
    '--json',
  ];
  const { stdout, stderr } = await execFileAsync(process.execPath, fullArgs, {
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: cliTsconfig,
      _SIGNET_SPAWNED: '1',
    },
    timeout: 15000,
  });

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse CLI JSON output: "${stdout}"\nStderr: "${stderr}"`);
  }
}

// -----------------------------------------------------------------------------
// 5. Test Assertion Utilities
// -----------------------------------------------------------------------------
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

// -----------------------------------------------------------------------------
// 6. Main Test Runner Execution
// -----------------------------------------------------------------------------
async function runSystemHarness() {
  console.log('\n============================================================');
  console.log('  STARTING FRANK GATEWAY & IDENTITY SYSTEM INTEGRATION HARNESS');
  console.log('============================================================\n');

  // Step 1: Boot Frank Relay
  const relay = new EmulatedFrankRelay();
  await relay.start();
  console.log(`[INIT] Frank Relay listening at ${relay.getUrl()}`);

  // Step 2: Register Gateway Identity on Relay
  const gatewayIdentity = MonadIdentity.generate();
  await registerMonadIdentityCbor({
    relayBaseUrl: relay.getUrl(),
    identity: gatewayIdentity,
    profile: {
      name: 'Frank Mail Gateway',
      username: 'mail_gateway',
    },
    network: 'monad-testnet',
  });
  relay.registerProfilePubKey(gatewayIdentity.displayAddress, gatewayIdentity.compressedPubKey);

  // Step 3: Boot Email Gateway Daemon
  const stripeWebhookSecret = 'whsec_harness_test_999';
  const stampProvider = new RelayConnectedStampProvider(relay, gatewayIdentity);
  const gatewayConfig: GatewayConfig = {
    gatewayDomain: 'frank.org',
    gatewayRelayUrl: relay.getUrl(),
    stampChain: 'monad',
    httpPort: 0,
    smtpPort: 0,
    dkimSelector: 'default',
    dkimPrivateKey: 'mock-key',
    lowBalanceThresholdWei: 1000n,
    stripeWebhookSecret,
  };

  const daemon = new EmailGatewayDaemon(gatewayConfig, stampProvider, { dbPath: ':memory:' });
  await daemon.start();
  const httpPort = daemon.checkoutServer.getPort();
  const smtpPort = daemon.smtpListener.getPort();
  console.log(`[INIT] Gateway Checkout HTTP listening on port ${httpPort}`);
  console.log(`[INIT] Gateway SMTP listening on port ${smtpPort}\n`);

  // Step 4: Create Isolated Alice CLI Environment
  const aliceDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-alice-cli-'));
  const aliceIdentity = MonadIdentity.generate();
  const aliceAddress = aliceIdentity.displayAddress.toLowerCase();

  await saveIdentity(aliceDataDir, {
    identity: aliceIdentity,
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  });

  saveConfig(aliceDataDir, {
    rpcUrl: 'http://127.0.0.1:8545',
    relayUrl: relay.getUrl(),
    networkTag: 'MONT',
    chainId: 10143,
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    activeIdentity: aliceAddress,
    gatewayUrl: `http://127.0.0.1:${httpPort}`,
  });

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Alice creates an account and claims canonical username 'alice'
    // -------------------------------------------------------------------------
    console.log('--- SCENARIO 1: Identity Registration & Inlined Directory Entry ---');

    // Register 'alice' in relay
    relay.usernames.set('alice', {
      username: 'alice',
      account_address: aliceAddress,
      status: 'active',
      updated_at_ms: Date.now(),
    });

    // Publish Alice's CBOR profile metadata to relay
    await registerMonadIdentityCbor({
      relayBaseUrl: relay.getUrl(),
      identity: aliceIdentity,
      profile: {
        name: 'Alice Liddell',
        username: 'alice',
      },
      network: 'monad-testnet',
    });
    relay.registerProfilePubKey(aliceAddress, aliceIdentity.compressedPubKey);

    // Verify GET /directory/user/alice returns active status AND inlined entry
    const userRes = await fetch(`${relay.getUrl()}/directory/user/alice`);
    assert(userRes.status === 200, 'Relay returns 200 for user lookup');
    const userData = (await userRes.json()) as any;
    assert(userData.username === 'alice', 'Username is alice');
    assert(userData.status === 'active', 'Status is active');
    assert(userData.account_address === aliceAddress, 'Address matches Alice key');
    assert(userData.entry !== null, 'Profile entry is inlined in single round trip');
    assert(userData.entry.content_type === 'application/cbor', 'Profile content-type is CBOR');

    // -------------------------------------------------------------------------
    // Scenario 2: Username Rename & Moved Transition
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 2: Username Rename & Moved / Redirect Handling ---');
    // Alice renames 'alice' -> 'alice_v2'
    relay.usernames.set('alice_v2', {
      username: 'alice_v2',
      account_address: aliceAddress,
      status: 'active',
      updated_at_ms: Date.now(),
    });
    relay.usernames.set('alice', {
      username: 'alice',
      account_address: aliceAddress,
      status: 'moved',
      updated_at_ms: Date.now(),
      tombstone_expires_at_ms: Date.now() + 86400000,
      redirect_to: 'alice_v2',
    });

    const oldUserRes = await fetch(`${relay.getUrl()}/directory/user/alice`);
    const oldUserData = (await oldUserRes.json()) as any;
    assert(oldUserData.status === 'moved', 'Old handle status is moved');
    assert(oldUserData.redirect_to === 'alice_v2', 'Redirect pointer points to alice_v2');

    const newUserRes = await fetch(`${relay.getUrl()}/directory/user/alice_v2`);
    const newUserData = (await newUserRes.json()) as any;
    assert(newUserData.status === 'active', 'New handle status is active');
    assert(newUserData.account_address === aliceAddress, 'New handle owned by Alice');

    // -------------------------------------------------------------------------
    // Scenario 3: Cold Inbound Email -> Spool -> Checkout Webhook -> CLI Inbox
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Inbound Cold Email -> Funding -> Relay Delivery -> CLI Inbox ---');
    const coldEmail =
      'From: stranger@example.com\r\n' +
      'To: alice_v2@frank.org\r\n' +
      'Subject: Hello from the Internet\r\n' +
      'Message-ID: <cold_msg_001@example.com>\r\n' +
      'Authentication-Results: dkim=pass\r\n' +
      '\r\n' +
      'Excited to chat with you on Frank!\r\n' +
      '.';

    const coldSmtpResponses = await sendSmtpCommands(smtpPort, [
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<alice_v2@frank.org>',
      'DATA',
      coldEmail,
      'QUIT',
    ]);

    assert(
      coldSmtpResponses.some((r) => r.includes('250 2.0.0 Message queued for funding')),
      'Gateway queued unfunded email with 250 hold response'
    );

    const held = daemon.ledger.findLatestHeldMessage('stranger@example.com', aliceAddress);
    assert(held !== undefined, 'Held message record located in SQLite');
    assert(held?.status === 'held', 'Held message status is held');

    // Stranger pays via Stripe webhook
    const eventPayload = JSON.stringify({
      id: 'evt_stripe_test_100',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: held!.id,
          customer_email: 'stranger@example.com',
          amount_total: 100,
          payment_status: 'paid',
        },
      },
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', stripeWebhookSecret)
      .update(`${timestamp}.${eventPayload}`)
      .digest('hex');

    const webhookRes = await fetch(`http://127.0.0.1:${httpPort}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: eventPayload,
    });
    assert(webhookRes.status === 200, 'Stripe webhook accepted with 200');

    // Verify delivery directly via Alice's CLI: authenticates to relay, decrypts AES-256-GCM envelope
    const inboxResult = await runCli(['inbox'], aliceDataDir);
    assert(
      Array.isArray(inboxResult) && inboxResult.length >= 1,
      'Alice CLI inbox successfully fetched message from relay mailbox'
    );
    const receivedColdMsg = inboxResult[0];
    assert(
      receivedColdMsg.text.includes('Excited to chat with you on Frank!'),
      'Alice CLI successfully authenticated challenge and decrypted cold email plaintext'
    );

    // -------------------------------------------------------------------------
    // Scenario 4: CLI Outbound Reply & Inbound Follow-up Thread Bridging
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 4: CLI Outbound Reply, Thread Bridging & Follow-up Inbound ---');
    const frankConvId = 'conv_frank_test_thread_777';
    const frankMsgId = 'frank_msg_001';

    // Alice replies outbound via the CLI (`signet mail send`)
    const cliSendResult = await runCli(
      [
        'mail',
        'send',
        'stranger@example.com',
        'Hey Stranger, message received loud and clear!',
        '--subject',
        'Re: Hello from the Internet',
        '--conversation',
        frankConvId,
        '--message-id',
        frankMsgId,
      ],
      aliceDataDir
    );

    assert(cliSendResult.ok === true, 'CLI mail send succeeded');
    assert(
      typeof cliSendResult.rfc822MessageId === 'string' && cliSendResult.rfc822MessageId.length > 0,
      'CLI outbound response returned valid RFC 822 Message-ID'
    );
    assert(
      cliSendResult.conversationId === frankConvId,
      'CLI outbound response preserved Frank conversation ID'
    );
    assert(
      cliSendResult.grantedReplyAllowance >= 1,
      'CLI outbound dispatch granted free reply allowance'
    );

    // Stranger replies back over SMTP referencing Alice's Message-ID
    const replyEmail =
      'From: stranger@example.com\r\n' +
      'To: alice_v2@frank.org\r\n' +
      `In-Reply-To: ${cliSendResult.rfc822MessageId}\r\n` +
      'Subject: Re: Hello from the Internet\r\n' +
      'Authentication-Results: dkim=pass\r\n' +
      '\r\n' +
      'Awesome! Continuing this thread for free.\r\n' +
      '.';

    const replySmtpResponses = await sendSmtpCommands(smtpPort, [
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<alice_v2@frank.org>',
      'DATA',
      replyEmail,
      'QUIT',
    ]);

    assert(
      replySmtpResponses.some((r) => r.includes('250 2.0.0 Message accepted and delivered')),
      'Follow-up reply delivered immediately via reply allowance'
    );

    // Verify Alice receives the stranger's reply via CLI inbox check
    const inboxAfterReply = await runCli(['inbox'], aliceDataDir);
    assert(
      Array.isArray(inboxAfterReply) && inboxAfterReply.length >= 2,
      'Alice CLI inbox received follow-up reply message'
    );
    assert(
      inboxAfterReply.some((m: any) =>
        m.text.includes('Awesome! Continuing this thread for free.')
      ),
      'Alice CLI inbox decrypted stranger follow-up reply body'
    );

    // Verify Frank conversationId was preserved in the bridged direct message
    const latestSent = stampProvider.sentMessages[stampProvider.sentMessages.length - 1];
    assert(latestSent.conversationId === frankConvId, 'Bridged email preserved Frank conversationId');
    assert(
      latestSent.inReplyToFrankMessageId === frankMsgId,
      'Bridged email preserved parent frankMessageId'
    );

    // -------------------------------------------------------------------------
    // Scenario 5: Tombstone Rejection
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 5: Tombstone Rejection ---');
    relay.usernames.set('charlie_deleted', {
      username: 'charlie_deleted',
      account_address: '0x3333333333333333333333333333333333333333',
      status: 'tombstoned',
      updated_at_ms: Date.now(),
      tombstone_expires_at_ms: Date.now() + 86400000,
    });

    const tombstoneSmtp = await sendSmtpCommands(smtpPort, [
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<charlie_deleted@frank.org>',
      'DATA',
      'From: stranger@example.com\r\nTo: charlie_deleted@frank.org\r\nSubject: Hi\r\n\r\nTest\r\n.',
      'QUIT',
    ]);

    assert(
      tombstoneSmtp.some((r) => r.startsWith('550 5.2.1 Recipient account deactivated and tombstoned')),
      'Gateway strictly rejected tombstoned handle with RFC 550 5.2.1'
    );

    console.log('\n============================================================');
    console.log('  ALL INTEGRATION SCENARIOS PASSED SUCCESSFULLY (5/5)');
    console.log('============================================================\n');
  } finally {
    await daemon.stop();
    await relay.stop();
    if (fs.existsSync(aliceDataDir)) {
      fs.rmSync(aliceDataDir, { recursive: true, force: true });
    }
  }
}

runSystemHarness().catch((err) => {
  console.error('\n\x1b[31m[FATAL] System integration harness failed:\x1b[0m', err);
  process.exit(1);
});
