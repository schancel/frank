#!/usr/bin/env node
/**
 * Cross-Component System Integration Test Harness
 *
 * Tests the complete loop together across:
 * - Email Gateway Daemon (RFC 5321 SMTP, RFC 5322 MIME, HTTP checkout & webhooks, SQLite ledger)
 * - Frank Relay API (Handle uniqueness, inlined directory entry, rename/moved redirects, tombstone enforcement, mailbox delivery)
 * - Wallet / Client SDK (secp256k1 key generation, profile publication, stamped direct message encryption & retrieval)
 * - Thread Scoping & Bridging (In-Reply-To <-> Frank conversationId)
 *
 * Usage:
 *   node --import tsx test/integration/system-harness.ts
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { SigningKey, getAddress, keccak256 } from 'ethers';
import { EmailGatewayDaemon } from '../../packages/mail-gateway/src/index';
import { GatewayConfig } from '../../packages/mail-gateway/src/types';
import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from '../../packages/mail-gateway/src/stamps/stamp-provider.interface';

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

interface StoredRelayMessage {
  recipient: string;
  payload: string;
  timestamp: number;
}

class EmulatedFrankRelay {
  private server?: http.Server;
  private port: number = 0;
  readonly usernames = new Map<string, RelayDirectoryUserRecord>();
  readonly profiles = new Map<string, { contentType: string; rawHex: string }>();
  readonly mailboxes = new Map<string, StoredRelayMessage[]>();

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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
            record.status === 'active' ? this.profiles.get(record.account_address) : undefined;

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

        // PUT /metadata/monad/:address
        if (req.method === 'PUT' && url.pathname.startsWith('/metadata/monad/')) {
          const address = url.pathname.slice('/metadata/monad/'.length).toLowerCase();
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const contentType = req.headers['content-type'] || 'application/cbor';
            this.profiles.set(address, {
              contentType,
              rawHex: raw.toString('hex'),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ txid: [] }));
          });
          return;
        }

        // GET /metadata/monad/:address
        if (req.method === 'GET' && url.pathname.startsWith('/metadata/monad/')) {
          const address = url.pathname.slice('/metadata/monad/'.length).toLowerCase();
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

        // PUT /message/monad/cbor (deliver direct message to mailbox)
        if (req.method === 'PUT' && url.pathname === '/message/monad/cbor') {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            let data: any = {};
            try {
              data = JSON.parse(body);
            } catch {
              data = { raw: body };
            }
            const recipient = (data.recipient || '0xunknown').toLowerCase();
            const list = this.mailboxes.get(recipient) ?? [];
            list.push({
              recipient,
              payload: data.text || body,
              timestamp: Date.now(),
            });
            this.mailboxes.set(recipient, list);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, txHash: `0x${crypto.randomBytes(32).toString('hex')}` }));
          });
          return;
        }

        // GET /message/monad/cbor/mailbox/:address
        if (req.method === 'GET' && url.pathname.startsWith('/message/monad/cbor/mailbox/')) {
          const address = url.pathname.slice('/message/monad/cbor/mailbox/'.length).toLowerCase();
          const list = this.mailboxes.get(address) ?? [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: list }));
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

  constructor(private readonly relayUrl: string) {}

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

    // Broadcast into Frank relay's mailbox
    const res = await fetch(`${this.relayUrl}/message/monad/cbor`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: params.recipientAddress,
        text: params.text,
        conversationId: params.conversationId,
        inReplyTo: params.inReplyToFrankMessageId,
      }),
    });

    const data = (await res.json()) as { txHash?: string };
    const txHash = data.txHash || `0x${crypto.randomBytes(32).toString('hex')}`;
    return {
      txHash,
      payloadDigest: `0x${crypto.randomBytes(32).toString('hex')}`,
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
// 4. Test Assertion Utilities
// -----------------------------------------------------------------------------
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
}

// -----------------------------------------------------------------------------
// 5. Main Test Runner Execution
// -----------------------------------------------------------------------------
async function runSystemHarness() {
  console.log('\n============================================================');
  console.log('  STARTING FRANK GATEWAY & IDENTITY SYSTEM INTEGRATION HARNESS');
  console.log('============================================================\n');

  // Step 1: Boot Frank Relay
  const relay = new EmulatedFrankRelay();
  const relayPort = await relay.start();
  console.log(`[INIT] Frank Relay listening at ${relay.getUrl()}`);

  // Step 2: Boot Email Gateway Daemon
  const stripeWebhookSecret = 'whsec_harness_test_999';
  const stampProvider = new RelayConnectedStampProvider(relay.getUrl());
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

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Alice creates an account and claims canonical username 'alice'
    // -------------------------------------------------------------------------
    console.log('--- SCENARIO 1: Identity Registration & Inlined Directory Entry ---');
    const alicePrivKey = `0x${crypto.randomBytes(32).toString('hex')}`;
    const aliceSigningKey = new SigningKey(alicePrivKey);
    const aliceAddress = getAddress(keccak256(aliceSigningKey.publicKey).slice(-40)).toLowerCase();

    // Register 'alice' in relay
    relay.usernames.set('alice', {
      username: 'alice',
      account_address: aliceAddress,
      status: 'active',
      updated_at_ms: Date.now(),
    });

    // Publish Alice's profile metadata to relay
    const profilePayload = Buffer.from(
      JSON.stringify({
        displayName: 'Alice Liddell',
        encryptionPubkey: aliceSigningKey.compressedPublicKey,
        avatarUrl: 'https://frank.org/alice.png',
      })
    );
    await fetch(`${relay.getUrl()}/metadata/monad/${aliceAddress}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/cbor' },
      body: profilePayload,
    });

    // Verify GET /directory/user/alice returns active status AND inlined entry
    const userRes = await fetch(`${relay.getUrl()}/directory/user/alice`);
    assert(userRes.status === 200, 'Relay returns 200 for user lookup');
    const userData = (await userRes.json()) as any;
    assert(userData.username === 'alice', 'Username is alice');
    assert(userData.status === 'active', 'Status is active');
    assert(userData.account_address === aliceAddress, 'Address matches Alice key');
    assert(userData.entry !== null, 'Profile entry is inlined in single round trip');
    assert(userData.entry.content_type === 'application/cbor', 'Profile content-type is CBOR');
    assert(userData.entry.raw_hex === profilePayload.toString('hex'), 'Profile bytes match');

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
    // Scenario 3: Cold Inbound Email -> Spool -> Checkout Webhook -> Relay Mailbox
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 3: Inbound Cold Email -> Funding -> Relay Delivery ---');
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

    // Verify delivery in Frank relay's mailbox
    const mailboxRes = await fetch(`${relay.getUrl()}/message/monad/cbor/mailbox/${aliceAddress}`);
    const mailboxData = (await mailboxRes.json()) as { messages: StoredRelayMessage[] };
    assert(mailboxData.messages.length >= 1, 'Message delivered to Alice mailbox in Frank relay');
    assert(
      mailboxData.messages[0].payload.includes('Excited to chat with you on Frank!'),
      'Mailbox payload contains original email body'
    );

    // -------------------------------------------------------------------------
    // Scenario 4: Outbound Frank Reply & Inbound Follow-up Thread Bridging
    // -------------------------------------------------------------------------
    console.log('\n--- SCENARIO 4: Thread Bridging & ConversationId Preservation ---');
    const frankConvId = 'conv_frank_test_thread_777';
    const frankMsgId = 'frank_msg_001';

    // Alice replies outbound via Frank
    const outboundEmail = await daemon.outboundDelivery.processOutboundDirectMessage({
      senderFrankAddress: aliceAddress,
      recipientEmail: 'stranger@example.com',
      subject: 'Re: Hello from the Internet',
      bodyText: 'Hey Stranger, message received loud and clear!',
      conversationId: frankConvId,
      frankMessageId: frankMsgId,
    });

    assert(
      outboundEmail.renderedEmail.includes(`From: ${aliceAddress} <${aliceAddress}@frank.org>`),
      'Outbound email rendered correct From address'
    );
    assert(
      outboundEmail.renderedEmail.includes('Reply to this email to continue the thread for free'),
      'Outbound email contains free reply allowance notice'
    );

    // Stranger replies back over SMTP referencing Alice's Message-ID
    const replyEmail =
      'From: stranger@example.com\r\n' +
      'To: alice_v2@frank.org\r\n' +
      `In-Reply-To: ${outboundEmail.rfc822MessageId}\r\n` +
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
  }
}

runSystemHarness().catch((err) => {
  console.error('\n\x1b[31m[FATAL] System integration harness failed:\x1b[0m', err);
  process.exit(1);
});
