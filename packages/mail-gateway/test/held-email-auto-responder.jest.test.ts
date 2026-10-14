import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import {
  HeldEmailAutoResponder,
  renderHeldChallengeEmail,
  shouldSuppressHeldAutoReply,
} from '../src/mta/held-email-auto-responder';
import { createJournaledMailHost } from '../src/host/journaled-mail-host';
import type { OutboundMailPort } from '../src/mta/journaled-outbound-worker';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';
import { verifyOnboardingClaimToken } from '../src/secure-link/secure-message-portal';
import type { InboundEmailRecord } from '../src/types';

interface SubmittedOutboundMail {
  readonly fromAddress: string;
  readonly recipientEmail: string;
  readonly signedRfc822: Uint8Array;
}

const GATEWAY = `0x${'9'.repeat(40)}`;
const DIGDEEP_ACCOUNT = '0xa4f0b44065b5ab3c8e4d1462fc509ebf425b4cf2';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frank-held-autoreply-test-'));
}

function makeRfc822(headers: Record<string, string>, body = 'Hello Digdeep'): Uint8Array {
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return Buffer.from([...headerLines, '', body].join('\r\n'), 'utf8');
}

describe('Unpaid Held-Email Auto-Responder & Payment/Onboarding Flow', () => {
  describe('shouldSuppressHeldAutoReply (RFC 3834 loop & backscatter prevention)', () => {
    it('allows normal human sender emails with no auto-reply headers', () => {
      const rawRfc822 = makeRfc822({
        From: 'Precious Effiang <preciouseffiang@gmail.com>',
        To: 'digdeep@signet.mx',
        Subject: 'First Stamp Mail',
        'Message-ID': '<8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>',
      });
      const res = shouldSuppressHeldAutoReply({
        senderEmail: 'preciouseffiang@gmail.com',
        gatewayDomain: 'signet.mx',
        rawRfc822,
      });
      expect(res).toEqual({ suppress: false });
    });

    it.each([
      ['mailer-daemon@googlemail.com', 'automated_sender'],
      ['postmaster@example.org', 'automated_sender'],
      ['noreply@github.com', 'automated_sender'],
      ['no-reply@accounts.google.com', 'automated_sender'],
      ['donotreply@service.io', 'automated_sender'],
      ['bounces+123@mail.example.com', 'automated_sender'],
      ['alice@signet.mx', 'own_domain'],
      ['alice@sub.signet.mx', 'own_domain'],
    ])('suppresses system or own-domain sender %s (%s)', (senderEmail, expectedReason) => {
      const res = shouldSuppressHeldAutoReply({
        senderEmail,
        gatewayDomain: 'signet.mx',
        rawRfc822: makeRfc822({ From: senderEmail, To: 'digdeep@signet.mx' }),
      });
      expect(res).toEqual({ suppress: true, reason: expectedReason });
    });

    it('suppresses when Auto-Submitted header is present and not "no"', () => {
      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({
            From: 'alice@example.com',
            'Auto-Submitted': 'auto-replied',
          }),
        }),
      ).toEqual({ suppress: true, reason: 'auto_submitted' });

      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({
            From: 'alice@example.com',
            'Auto-Submitted': 'no',
          }),
        }),
      ).toEqual({ suppress: false });
    });

    it('suppresses bulk/list Precedence, X-Auto-Response-Suppress, null Return-Path, mailing lists, and X-Loop', () => {
      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({ From: 'alice@example.com', Precedence: 'bulk' }),
        }),
      ).toEqual({ suppress: true, reason: 'precedence_bulk' });

      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({ From: 'alice@example.com', 'X-Auto-Response-Suppress': 'All' }),
        }),
      ).toEqual({ suppress: true, reason: 'x_auto_response_suppress' });

      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({ 'Return-Path': '<>', From: 'alice@example.com' }),
        }),
      ).toEqual({ suppress: true, reason: 'empty_return_path' });

      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({ From: 'alice@example.com', 'List-Id': '<announces.example.com>' }),
        }),
      ).toEqual({ suppress: true, reason: 'mailing_list' });

      expect(
        shouldSuppressHeldAutoReply({
          senderEmail: 'alice@example.com',
          gatewayDomain: 'signet.mx',
          rawRfc822: makeRfc822({ From: 'alice@example.com', 'X-Loop': 'postmaster@signet.mx' }),
        }),
      ).toEqual({ suppress: true, reason: 'x_loop' });
    });
  });

  describe('renderHeldChallengeEmail', () => {
    it('preserves long reference chains while folding outgoing physical header lines', () => {
      const references = Array.from({ length: 60 }, (_, i) => `<message-${i}-long-thread@example.com>`);
      const rendered = renderHeldChallengeEmail({
        gatewayDomain: 'signet.mx', senderEmail: 'alice@example.com',
        recipientDisplay: 'digdeep', recipientEmail: 'digdeep@signet.mx',
        scopeAccount: DIGDEEP_ACCOUNT, originalSubject: 'Long thread',
        originalMessageId: '<parent@example.com>', originalReferences: references,
        replyMessageId: '<challenge@signet.mx>', onboardingUrl: 'https://signet.mx/#/onboard',
        payUrl: 'https://signet.mx/pay/key', nowMs: Date.now(), expiresAtMs: Date.now() + 86400_000,
      });
      const headers = Buffer.from(rendered.rawRfc822).toString('utf8').split('\r\n\r\n')[0]!;
      expect(headers.split('\r\n').every((line) => Buffer.byteLength(line) <= 998)).toBe(true);
      const unfolded = headers.replace(/\r\n[ \t]+/g, ' ');
      expect(unfolded).toContain(`References: ${[...references, '<parent@example.com>'].join(' ')}`);
    });

    it('renders threaded RFC 3834 multipart/alternative email with Option 1 (onboard) and Option 2 (/pay/:mailKey)', () => {
      const nowMs = 1791957540225;
      const rendered = renderHeldChallengeEmail({
        gatewayDomain: 'signet.mx',
        senderEmail: 'preciouseffiang@gmail.com',
        recipientDisplay: 'digdeep@signet.mx',
        recipientEmail: 'digdeep@signet.mx',
        scopeAccount: DIGDEEP_ACCOUNT,
        originalSubject: 'First Stamp Mail',
        originalMessageId: '<8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>',
        replyMessageId: '<autoreply.3651de4563c3a41d5118123ca51b365a@signet.mx>',
        onboardingUrl: 'https://signet.mx/#/onboard?email=preciouseffiang%40gmail.com&claim=tok123',
        payUrl: 'https://signet.mx/pay/3651de4563c3a41d5118123ca51b365a1bbfadd78d99cfd9dc2d3295bf52cd18',
        expiresAtMs: nowMs + 72 * 3600_000,
        nowMs,
      });

      expect(rendered.fromAddress).toBe('postmaster@signet.mx');
      expect(rendered.recipientEmail).toBe('preciouseffiang@gmail.com');
      expect(rendered.subject).toBe(
        'Re: First Stamp Mail [Delivery paused — stamp or verification required]',
      );

      const raw = Buffer.from(rendered.rawRfc822).toString('utf8');
      expect(raw).toContain('From: "Frank Gateway (digdeep@signet.mx)" <postmaster@signet.mx>');
      expect(raw).toContain('To: preciouseffiang@gmail.com');
      expect(raw).toContain('In-Reply-To: <8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>');
      expect(raw).toContain('References: <8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>');
      expect(raw).toContain('Auto-Submitted: auto-replied');
      expect(raw).toContain('Precedence: bulk');
      expect(raw).toContain('X-Auto-Response-Suppress: All');
      expect(raw).toContain('X-Loop: signet.mx');
      expect(rendered.textBody).toContain(
        'https://signet.mx/pay/3651de4563c3a41d5118123ca51b365a1bbfadd78d99cfd9dc2d3295bf52cd18',
      );
      expect(rendered.textBody).toContain(
        'https://signet.mx/#/onboard?email=preciouseffiang%40gmail.com&claim=tok123',
      );
      expect(rendered.htmlBody).toContain(
        'https://signet.mx/pay/3651de4563c3a41d5118123ca51b365a1bbfadd78d99cfd9dc2d3295bf52cd18',
      );
      expect(rendered.htmlBody).toContain(
        'https://signet.mx/#/onboard?email=preciouseffiang%40gmail.com&amp;claim=tok123',
      );
    });
  });

  describe('HeldEmailAutoResponder unit behavior (idempotence & rate limiting)', () => {
    it('durably blocks concurrent dispatch and ambiguous provider retries after restart', async () => {
      const dir = makeTmpDir();
      const raw = makeRfc822({ From: 'alice@example.com', To: 'digdeep@signet.mx', Subject: 'Hello' });
      const row: InboundEmailRecord = {
        scopeAccount: DIGDEEP_ACCOUNT, mailKey: 'c'.repeat(64), stampValue: '1000',
        dataSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        rfcMessageId: '<concurrent@example.com>', senderEmail: 'alice@example.com',
        mailboxLocalPart: 'digdeep', disposition: 'held', raw: { kind: 'inline', bytes: raw },
        createdAtMs: Date.now(), expiresAtMs: Date.now() + 86400_000,
      };
      let rejectSubmission!: (error: Error) => void;
      let notifySubmission!: () => void;
      const submitted = new Promise<void>((resolve) => { notifySubmission = resolve; });
      const submit = jest.fn(async () => {
        notifySubmission();
        await new Promise<void>((_resolve, reject) => { rejectSubmission = reject; });
      });
      const options = {
        dbPath: path.join(dir, 'attempt.db'), journal: { listHeldInboundEmails: () => [row] },
        port: { submit }, gatewayDomain: 'signet.mx', onboardingSecret: Buffer.alloc(32, 7),
      };
      const responder = new HeldEmailAutoResponder(options);
      try {
        const first = responder.processHeldEmail(row);
        await submitted;
        expect(responder.getRecord(row.scopeAccount, row.mailKey)?.status).toBe('submitting');
        await expect(responder.processHeldEmail(row)).rejects.toThrow('uncertain');
        const competing = new HeldEmailAutoResponder(options);
        try {
          await expect(competing.processHeldEmail({ ...row, mailKey: 'd'.repeat(64) }))
            .resolves.toEqual({ status: 'suppressed', reason: 'rate_limited' });
        } finally { competing.close(); }
        rejectSubmission(new Error('SMTP timeout after DATA'));
        await expect(first).rejects.toThrow('SMTP timeout');
        responder.close();
        const reopened = new HeldEmailAutoResponder(options);
        try {
          await expect(reopened.processHeldEmail(row)).rejects.toThrow('uncertain');
          expect(reopened.getRecord(row.scopeAccount, row.mailKey)?.status).toBe('uncertain');
          expect(submit).toHaveBeenCalledTimes(1);
        } finally { reopened.close(); }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('sends exactly once per held email and rate-limits subsequent held emails from the same sender to the same recipient', async () => {
      const dir = makeTmpDir();
      try {
        const sentMessages: SubmittedOutboundMail[] = [];
        const port: OutboundMailPort = {
          submit: async (msg) => {
            sentMessages.push(msg);
          },
        };

        const nowMs = Date.now();
        const raw1 = makeRfc822(
          {
            From: 'Precious Effiang <preciouseffiang@gmail.com>',
            To: 'digdeep@signet.mx',
            Subject: 'First Stamp Mail',
            'Message-ID': '<msg-1@gmail.com>',
          },
          'Hello 1',
        );
        const raw2 = makeRfc822(
          {
            From: 'Precious Effiang <preciouseffiang@gmail.com>',
            To: 'digdeep@signet.mx',
            Subject: 'Second Unpaid Mail',
            'Message-ID': '<msg-2@gmail.com>',
          },
          'Hello 2',
        );

        const heldRows: InboundEmailRecord[] = [
          {
            scopeAccount: DIGDEEP_ACCOUNT,
            mailKey: 'a'.repeat(64),
            conversationId: '00112233-4455-6677-8899-aabbccddeeff',
            stampValue: '1000',
            dataSha256: crypto.createHash('sha256').update(raw1).digest('hex'),
            rfcMessageId: '<msg-1@gmail.com>',
            senderEmail: 'preciouseffiang@gmail.com',
            mailboxLocalPart: 'digdeep',
            disposition: 'held',
            heldMessageId: 'a'.repeat(64),
            raw: {
              kind: 'inline',
              bytes: raw1,
            },
            createdAtMs: nowMs,
            expiresAtMs: nowMs + 86400_000,
          },
          {
            scopeAccount: DIGDEEP_ACCOUNT,
            mailKey: 'b'.repeat(64),
            stampValue: '1000',
            dataSha256: crypto.createHash('sha256').update(raw2).digest('hex'),
            rfcMessageId: '<msg-2@gmail.com>',
            senderEmail: 'preciouseffiang@gmail.com',
            mailboxLocalPart: 'digdeep',
            disposition: 'held',
            heldMessageId: 'b'.repeat(64),
            raw: {
              kind: 'inline',
              bytes: raw2,
            },
            createdAtMs: nowMs + 1000,
            expiresAtMs: nowMs + 86400_000,
          },
        ];

        const responder = new HeldEmailAutoResponder({
          dbPath: path.join(dir, 'held-auto-reply.db'),
          journal: {
            listHeldInboundEmails: () => heldRows,
          },
          port,
          gatewayDomain: 'signet.mx',
          publicGatewayUrl: 'https://signet.mx',
          frankAppUrl: 'https://signet.mx',
          onboardingSecret: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
        });

        const firstBatch = await responder.processHeldEmails();
        expect(firstBatch).toEqual({
          sent: 1,
          suppressed: 1,
          skipped: 0,
          errors: [],
        });
        expect(sentMessages).toHaveLength(1);
        const mime = Buffer.from(sentMessages[0]!.signedRfc822).toString('utf8');
        const textPart = mime.split(/--frank-autoreply-[0-9a-f]+/)[1]!.split('\r\n\r\n')[1]!;
        const text = Buffer.from(textPart.replace(/\s+/g, ''), 'base64').toString('utf8');
        const onboardingLine = text.split('\r\n').find((line) => line.startsWith('https://signet.mx/#/onboard'))!;
        const claim = new URLSearchParams(onboardingLine.split('?')[1]).get('claim')!;
        expect(verifyOnboardingClaimToken(claim, Buffer.from('0123456789abcdef0123456789abcdef'))?.conversationId)
          .toBe('00112233-4455-6677-8899-aabbccddeeff');
        expect(responder.getRecord(DIGDEEP_ACCOUNT, 'a'.repeat(64))?.status).toBe('sent');
        expect(responder.getRecord(DIGDEEP_ACCOUNT, 'b'.repeat(64))?.status).toBe('suppressed');
        expect(responder.getRecord(DIGDEEP_ACCOUNT, 'b'.repeat(64))?.reason).toBe('rate_limited');

        // Calling processHeldEmails again skips both already-processed held emails
        const secondBatch = await responder.processHeldEmails();
        expect(secondBatch).toEqual({
          sent: 0,
          suppressed: 0,
          skipped: 2,
          errors: [],
        });
        expect(sentMessages).toHaveLength(1);

        responder.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('createJournaledMailHost end-to-end held email auto-reply + /pay/:mailKey + /onboard/claim/:token', () => {
    function createMockChainAndWallet(deliveredMessages: Array<{ messageId: string; to: string }>) {
      const attempts = new Map<string, string>();
      const digest = crypto.createHash('sha256').update('delivered-envelope').digest('hex');
      const wallet = { identity: { address: { raw: GATEWAY } } } as unknown as WalletHandle;
      const chain = {
        chainIdentifier: 'monad-testnet',
        parseAddress: (input: string) =>
          /^0x[0-9a-f]{40}$/i.test(input) ? { raw: input.toLowerCase() } : undefined,
        directMessages: {
          send: async (params: {
            recipient: { raw: string };
            messageId: string;
            onEnvelopeDurable: (digest: string) => Promise<void>;
          }) => {
            attempts.set(params.messageId, digest);
            await params.onEnvelopeDurable(digest);
            deliveredMessages.push({ messageId: params.messageId, to: params.recipient.raw });
            return {
              payloadDigest: digest,
              stampValueWei: 1000n,
              stampPayments: [],
              preparationTxHashes: [],
            };
          },
          attemptOf: async ({ messageId }: { messageId: string }) => {
            const payloadDigest = attempts.get(messageId);
            return payloadDigest ? { payloadDigest, paid: true } : undefined;
          },
          reconcileAttempts: async ({ payloadDigests }: { payloadDigests: string[] }) =>
            Object.fromEntries(payloadDigests.map((d) => [d, 'delivered'])),
        },
      } as unknown as ActiveChain;
      return { chain, wallet };
    }

    it('dispatches auto-reply and resolves onboarding metadata without releasing held mail after caller zeroes mailboxSalt', async () => {
      const dir = makeTmpDir();
      try {
        const sentAutoReplies: SubmittedOutboundMail[] = [];
        const outboundPort: OutboundMailPort = {
          submit: async (msg) => {
            sentAutoReplies.push(msg);
          },
        };

        const deliveredToFrank: Array<{ messageId: string; to: string }> = [];
        const { chain, wallet } = createMockChainAndWallet(deliveredToFrank);

        const mailboxSalt = new Uint8Array(Buffer.from('fedcba9876543210fedcba9876543210', 'utf8'));

        const host = createJournaledMailHost({
          chain,
          wallet,
          journalFile: path.join(dir, 'mail.sqlite3'),
          blobDirectory: path.join(dir, 'blobs'),
          journalMode: 'provision',
          gatewayDomain: 'signet.mx',
          mailboxSalt,
          resendApiKey: 're_test_key',
          resendWebhookSecret: 'whsec_test_secret',
          resendRawOrigins: ['https://raw.example.test'],
          inboundStampValue: 1000n,
          webhookHost: '127.0.0.1',
          webhookPort: 0,
          frankAppUrl: 'https://signet.mx',
          outboundPort,
        });

        // Simulate gateway-service.ts zeroing its input buffer after createJournaledMailHost returns
        mailboxSalt.fill(0);

        // Issue digdeep@signet.mx in journal
        host.journal.issueMailbox({
          localPart: 'digdeep',
          scopeAccount: DIGDEEP_ACCOUNT,
        });

        await host.webhook.start();
        const baseUrl = host.webhook.address();

        try {
          // 1. Admit unpaid email from preciouseffiang@gmail.com to digdeep@signet.mx
          const rawBytes = makeRfc822(
            {
              From: 'Precious Effiang <preciouseffiang@gmail.com>',
              To: 'digdeep@signet.mx',
              Subject: 'First Stamp Mail',
              'Message-ID': '<8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>',
            },
            "Hey Digdeep,\n\nIt’s a special opportunity to be part of this beautiful project.",
          );

          const admitRes = host.inbound.admit(
            {
              email: parseRawRfc822(rawBytes, 'preciouseffiang@gmail.com', 'digdeep@signet.mx'),
              verifiedTransportId: 'resend:email_precious_1',
              authenticatedSenderEmail: 'preciouseffiang@gmail.com',
            },
            DIGDEEP_ACCOUNT,
            1000n,
            undefined,
            'digdeep',
          );
          expect(admitRes.kind).toBe('held');

          // Run pending auto-replies (as ResendInboundWebhook/JournaledSmtpIngress and runtime tick do)
          await host.inbound.sendPendingHeldAutoReplies();

          const heldRows = host.journal.listHeldInboundEmails();
          expect(heldRows).toHaveLength(1);
          const mailKey = heldRows[0]!.mailKey;

          // 2. Verify auto-reply was dispatched via outboundPort
          expect(sentAutoReplies).toHaveLength(1);
          const autoReply = sentAutoReplies[0]!;
          expect(autoReply.fromAddress).toBe('');
          expect(autoReply.recipientEmail).toBe('preciouseffiang@gmail.com');
          const rawAutoReply = Buffer.from(autoReply.signedRfc822).toString('utf8');
          expect(rawAutoReply).toContain(
            'In-Reply-To: <8BFACE39-D459-44D9-9596-7FE829092887@gmail.com>',
          );
          expect(rawAutoReply).toContain('Auto-Submitted: auto-replied');
          const mimeParts = rawAutoReply.split(/--frank-autoreply-[0-9a-f]+/);
          const decodedTextPart = Buffer.from(
            (mimeParts[1]?.split('\r\n\r\n')[1] ?? '').replace(/\s+/g, ''),
            'base64',
          ).toString('utf8');
          expect(decodedTextPart).toContain(`https://signet.mx/pay/${mailKey}`);
          const onboardingLine = decodedTextPart.split('\r\n').find((line) => line.startsWith('https://signet.mx/#/onboard'))!;
          const onboardingParams = new URLSearchParams(onboardingLine.split('?')[1]);
          expect(onboardingParams.get('email')).toBe('preciouseffiang@gmail.com');
          expect(onboardingParams.has('claim')).toBe(false);
          expect(onboardingParams.has('conversationId')).toBe(false);
          expect(onboardingParams.has('peer')).toBe(false);

          // 3. Fetch GET /pay/:mailKey and verify 200 HTML page + extract onboarding claim token
          const payPageRes = await fetch(`${baseUrl}/pay/${mailKey}`);
          expect(payPageRes.status).toBe(200);
          const payHtml = await payPageRes.text();
          expect(payHtml).toContain('First Stamp Mail');

          const claimMatch = payHtml.match(/(?:[?&]|&amp;)claim=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
          expect(claimMatch).not.toBeNull();
          const claimToken = claimMatch![1]!;

          // 4. Redeem GET /onboard/claim/:claimToken (verifies mailboxSalt copy + held mail release!)
          const claimRes = await fetch(`${baseUrl}/onboard/claim/${claimToken}`);
          expect(claimRes.status).toBe(200);
          const claimJson = (await claimRes.json()) as {
            kind: string;
            peerAddress: string;
            email: string;
            subject: string;
            textBody: string;
          };
          expect(claimJson.kind).toBe('pay');
          expect(claimJson.email).toBe('preciouseffiang@gmail.com');
          expect(claimJson.peerAddress).toBe(DIGDEEP_ACCOUNT);
          expect(claimJson.subject).toBe('First Stamp Mail');
          expect(claimJson.textBody).toContain('special opportunity');

          // Resolving onboarding metadata does not authorize spending or release.
          expect(deliveredToFrank).toHaveLength(0);
          expect(host.journal.listHeldInboundEmails()).toHaveLength(1);
        } finally {
          await host.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

  });
});
