import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain';
import {
  buildStripeWebhookSignatureHeader,
  CheckoutServer,
  verifyStripeWebhookSignature,
} from '../src/http/checkout-server';
import { ResendWebhookHttp } from '../src/host/resend-webhook-http';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { JournaledFrankOutbound } from '../src/relay/journaled-frank-outbound';
import {
  buildOnboardingDeepLink,
  createOnboardingClaimToken,
  decryptSecureMessagePayload,
  encryptSecureMessagePayload,
  maskEmailAddress,
  parseSubjectSecureDirective,
  SecureMessageAccessEvent,
  SecureMessagePortal,
  verifyOnboardingClaimToken,
} from '../src/secure-link/secure-message-portal';
import { ResendInboundWebhook } from '../src/smtp/resend-inbound-webhook';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const MASTER_SECRET = new Uint8Array(32).fill(0x42);
const SENDER_SCOPE = `0x${'a'.repeat(40)}`;
const GATEWAY_ACCOUNT = `0x${'9'.repeat(40)}`;
const CONVERSATION_ID = '00000000-0000-0000-0000-000000000077';

describe('SecureMessagePortal & Onboarding Claim Channel', () => {
  describe('AES-256-GCM envelope & key derivation', () => {
    it('encrypts and decrypts cleartext bound to tokenId AAD and rejects tokenId/ciphertext tampering', () => {
      const tokenId = 'a'.repeat(64);
      const otherTokenId = 'b'.repeat(64);
      const cleartext = {
        subject: 'Confidential Deal Memo',
        textBody: 'Here are the wire instructions and terms.',
        senderAddress: 'alice@mail.frank.test',
        senderDisplayName: 'Alice',
        recipientEmail: 'bob@gmail.com',
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_700_000_000_000,
      };

      const ciphertext = encryptSecureMessagePayload({
        cleartext,
        masterSecret: MASTER_SECRET,
        tokenId,
      });

      const decrypted = decryptSecureMessagePayload({
        ciphertext,
        masterSecret: MASTER_SECRET,
        tokenId,
      });
      expect(decrypted).toEqual(cleartext);

      // Rejects decryption under a different tokenId (AAD mismatch)
      expect(() =>
        decryptSecureMessagePayload({
          ciphertext,
          masterSecret: MASTER_SECRET,
          tokenId: otherTokenId,
        }),
      ).toThrow();

      // Rejects tampered ciphertext byte
      const tampered = Buffer.from(ciphertext);
      tampered[tampered.length - 1] ^= 0xff;
      expect(() =>
        decryptSecureMessagePayload({
          ciphertext: tampered,
          masterSecret: MASTER_SECRET,
          tokenId,
        }),
      ).toThrow();
    });

    it('derives key with scrypt when passphrase is provided and refuses wrong passphrase', () => {
      const tokenId = 'c'.repeat(64);
      const cleartext = {
        subject: 'Out-of-Band Secret',
        textBody: 'Passphrase-protected payload.',
        senderAddress: 'alice@mail.frank.test',
        recipientEmail: 'bob@yahoo.com',
        createdAtMs: 1_700_000_000_000,
      };

      const ciphertext = encryptSecureMessagePayload({
        cleartext,
        masterSecret: MASTER_SECRET,
        tokenId,
        passphrase: 'correct-horse-battery-staple',
      });

      expect(() =>
        decryptSecureMessagePayload({
          ciphertext,
          masterSecret: MASTER_SECRET,
          tokenId,
          passphrase: 'wrong-passphrase',
        }),
      ).toThrow();

      const decrypted = decryptSecureMessagePayload({
        ciphertext,
        masterSecret: MASTER_SECRET,
        tokenId,
        passphrase: 'correct-horse-battery-staple',
      });
      expect(decrypted).toEqual(cleartext);
    });
  });

  describe('Subject directive parsing & email masking', () => {
    it('parses [Secure], [Encrypted], [Secure:direct], [Secure:otp], and [Secure:<passphrase>]', () => {
      expect(parseSubjectSecureDirective('Regular subject')).toEqual({
        triggered: false,
        cleanSubject: 'Regular subject',
      });
      expect(parseSubjectSecureDirective('[Secure] Quarterly Report')).toEqual({
        triggered: true,
        cleanSubject: 'Quarterly Report',
      });
      expect(parseSubjectSecureDirective('[Encrypted] Tax Return')).toEqual({
        triggered: true,
        cleanSubject: 'Tax Return',
      });
      expect(parseSubjectSecureDirective('[Secure:direct] Quick Note')).toEqual({
        triggered: true,
        cleanSubject: 'Quick Note',
        authMode: 'direct',
      });
      expect(parseSubjectSecureDirective('[Secure:otp] Verification Needed')).toEqual({
        triggered: true,
        cleanSubject: 'Verification Needed',
        authMode: 'otp',
      });
      expect(parseSubjectSecureDirective('[Secure:my-shared-secret] Contract')).toEqual({
        triggered: true,
        cleanSubject: 'Contract',
        authMode: 'passphrase',
        passphrase: 'my-shared-secret',
      });
    });

    it('masks email addresses for challenge screens', () => {
      expect(maskEmailAddress('alice@gmail.com')).toBe('a***@gmail.com');
      expect(maskEmailAddress('x@outlook.com')).toBe('x***@outlook.com');
    });
  });

  describe('Portal authentication modes, lockout, and onboarding CTA + claim API', () => {
    let clock = 1_700_000_000_000;
    let sentOtps: Array<{ to: string; otp: string; tokenId: string }>;
    let accessEvents: SecureMessageAccessEvent[];
    let portal: SecureMessagePortal;

    beforeEach(() => {
      clock = 1_700_000_000_000;
      sentOtps = [];
      accessEvents = [];
      portal = new SecureMessagePortal({
        gatewayDomain: 'mail.frank.test',
        frankAppUrl: 'https://app.frank.test',
        masterSecret: MASTER_SECRET,
        now: () => clock,
        sendOtpEmail: async (params) => {
          sentOtps.push({ to: params.to, otp: params.otp, tokenId: params.tokenId });
        },
        onAccessEvent: (ev) => {
          accessEvents.push(ev);
        },
        resolveClaimedPayThread: async (payload) => ({
          kind: 'pay',
          peerAddress: payload.peerAddress,
          email: payload.email,
          conversationId: payload.conversationId,
          subject: payload.subject ?? 'Held Subject',
          textBody: 'Imported held email body from sender',
          createdAt: clock,
        }),
      });
    });

    afterEach(() => {
      portal.close();
    });

    it('unlocks direct-mode message via POST /secure/:tokenId/verify and renders onboarding deep link', async () => {
      const record = portal.createSecureMessage({
        senderScope: SENDER_SCOPE,
        authMode: 'direct',
        cleartext: {
          subject: 'Direct Portal Subject',
          textBody: 'Hello from Frank over TLS!',
          senderAddress: 'alice@mail.frank.test',
          senderDisplayName: 'Alice',
          recipientEmail: 'bob@gmail.com',
          conversationId: CONVERSATION_ID,
          createdAtMs: clock,
          attachments: [
            {
              filename: 'invoice.txt',
              contentType: 'text/plain',
              contentBase64: Buffer.from('Invoice #42').toString('base64'),
            },
          ],
        },
      });

      const getRes = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}`,
        method: 'GET',
      });
      expect(getRes?.status).toBe(200);
      expect(getRes?.headers['Cache-Control']).toContain('no-store');
      expect(getRes?.headers['Content-Security-Policy']).toContain("default-src 'none'");
      expect(getRes?.body).toContain('View Secure Message');
      expect(getRes?.body).toContain('Get a Free Native Frank Account');
      expect(getRes?.body).toContain('https://app.frank.test/#/onboard?');
      expect(getRes?.body).not.toContain('Hello from Frank over TLS!');

      const postRes = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}/verify`,
        method: 'POST',
        body: '',
      });
      expect(postRes?.status).toBe(200);
      expect(postRes?.body).toContain('Direct Portal Subject');
      expect(postRes?.body).toContain('Hello from Frank over TLS!');
      expect(postRes?.body).toContain('invoice.txt');
      expect(postRes?.body).toContain('https://app.frank.test/#/onboard?');

      // Extract the claim token from the rendered onboarding link and claim the thread via GET /onboard/claim/:claimToken
      const match = postRes?.body.match(/href="(https:\/\/app\.frank\.test\/#\/onboard\?[^"]+)"/);
      expect(match).toBeTruthy();
      const decodedHref = match![1].replace(/&amp;/g, '&');
      const queryStr = decodedHref.split('?')[1];
      const params = new URLSearchParams(queryStr);
      expect(params.get('peer')).toBe(SENDER_SCOPE);
      expect(params.get('email')).toBe('bob@gmail.com');
      expect(params.get('conversationId')).toBe(CONVERSATION_ID);
      const claimToken = params.get('claim')!;
      expect(claimToken).toBeTruthy();

      const corsPreflight = await portal.handleHttpRequest({
        pathname: `/onboard/claim/${encodeURIComponent(claimToken)}`,
        method: 'OPTIONS',
      });
      expect(corsPreflight?.status).toBe(204);
      expect(corsPreflight?.headers['Access-Control-Allow-Origin']).toBe('*');

      const claimRes = await portal.handleHttpRequest({
        pathname: `/onboard/claim/${encodeURIComponent(claimToken)}`,
        method: 'GET',
      });
      expect(claimRes?.status).toBe(200);
      expect(claimRes?.headers['Access-Control-Allow-Origin']).toBe('*');
      const claimedJson = JSON.parse(claimRes!.body);
      expect(claimedJson).toEqual({
        kind: 'secure',
        peerAddress: SENDER_SCOPE,
        email: 'bob@gmail.com',
        conversationId: CONVERSATION_ID,
        subject: 'Direct Portal Subject',
        textBody: 'Hello from Frank over TLS!',
        createdAt: clock,
      });
    });

    it('issues 6-digit email OTP, verifies constant-time HMAC, and locks after 5 failed attempts', async () => {
      const record = portal.createSecureMessage({
        senderScope: SENDER_SCOPE,
        authMode: 'otp',
        cleartext: {
          subject: 'OTP Protected Message',
          textBody: 'Top secret OTP body.',
          senderAddress: 'alice@mail.frank.test',
          recipientEmail: 'bob@gmail.com',
          conversationId: CONVERSATION_ID,
          createdAtMs: clock,
        },
      });

      const reqOtpRes = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}/request-otp`,
        method: 'POST',
      });
      expect(reqOtpRes?.status).toBe(200);
      expect(sentOtps).toHaveLength(1);
      expect(sentOtps[0].to).toBe('bob@gmail.com');
      const issuedOtp = sentOtps[0].otp;
      expect(issuedOtp).toMatch(/^[0-9]{6}$/);

      // 1 wrong attempt returns 401
      const wrongRes = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}/verify`,
        method: 'POST',
        body: new URLSearchParams({ otp: '000000' }).toString(),
      });
      expect(wrongRes?.status).toBe(401);
      expect(wrongRes?.body).toContain('Invalid or expired verification code');

      // Correct OTP unlocks
      const okRes = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}/verify`,
        method: 'POST',
        body: new URLSearchParams({ otp: issuedOtp }).toString(),
      });
      expect(okRes?.status).toBe(200);
      expect(okRes?.body).toContain('Top secret OTP body.');
      expect(portal.getSecureMessage(record.tokenId)?.readCount).toBe(1);
      expect(accessEvents.map((e) => e.type)).toEqual([
        'otp-requested',
        'failed-attempt',
        'unlocked',
      ]);

      // Now test 5-attempt brute-force lockout on a second message
      const record2 = portal.createSecureMessage({
        senderScope: SENDER_SCOPE,
        authMode: 'passphrase',
        passphrase: 'secret-passphrase',
        cleartext: {
          subject: 'Passphrase Message',
          textBody: 'Locked after 5 bad guesses',
          senderAddress: 'alice@mail.frank.test',
          recipientEmail: 'bob@gmail.com',
          createdAtMs: clock,
        },
      });

      for (let i = 1; i <= 4; i++) {
        const res = await portal.handleHttpRequest({
          pathname: `/secure/${record2.tokenId}/verify`,
          method: 'POST',
          body: new URLSearchParams({ passphrase: `wrong-${i}` }).toString(),
        });
        expect(res?.status).toBe(401);
      }

      const fifthRes = await portal.handleHttpRequest({
        pathname: `/secure/${record2.tokenId}/verify`,
        method: 'POST',
        body: new URLSearchParams({ passphrase: 'wrong-5' }).toString(),
      });
      expect(fifthRes?.status).toBe(429);
      expect(fifthRes?.body).toContain('Secure Message Locked');

      // Even with the right passphrase afterwards, it stays locked (429)
      const afterLock = await portal.handleHttpRequest({
        pathname: `/secure/${record2.tokenId}/verify`,
        method: 'POST',
        body: new URLSearchParams({ passphrase: 'secret-passphrase' }).toString(),
      });
      expect(afterLock?.status).toBe(429);
    });

    it('returns 410 Gone when secure message has expired and rejects expired claim tokens', async () => {
      const record = portal.createSecureMessage({
        senderScope: SENDER_SCOPE,
        authMode: 'direct',
        expiresAtMs: clock + 5_000,
        cleartext: {
          subject: 'Ephemeral Message',
          textBody: 'Expires soon',
          senderAddress: 'alice@mail.frank.test',
          recipientEmail: 'bob@gmail.com',
          conversationId: CONVERSATION_ID,
          createdAtMs: clock,
        },
      });

      const { claimToken } = buildOnboardingDeepLink({
        frankAppUrl: 'https://app.frank.test',
        secret: MASTER_SECRET,
        payload: {
          kind: 'secure',
          id: record.tokenId,
          peerAddress: SENDER_SCOPE,
          email: 'bob@gmail.com',
          conversationId: CONVERSATION_ID,
          exp: clock + 5_000,
        },
      });

      clock += 10_000;

      const expiredPage = await portal.handleHttpRequest({
        pathname: `/secure/${record.tokenId}`,
        method: 'GET',
      });
      expect(expiredPage?.status).toBe(410);
      expect(expiredPage?.body).toContain('Secure Message Expired');

      const expiredClaim = await portal.handleHttpRequest({
        pathname: `/onboard/claim/${encodeURIComponent(claimToken)}`,
        method: 'GET',
      });
      expect(expiredClaim?.status).toBe(404);
    });

    it('verifies pay-mode onboarding claim tokens via GET /onboard/claim/:claimToken', async () => {
      const claimToken = createOnboardingClaimToken(
        {
          kind: 'pay',
          id: 'held_msg_42',
          peerAddress: SENDER_SCOPE,
          email: 'external@gmail.com',
          conversationId: CONVERSATION_ID,
          subject: 'Held Inquiry',
          exp: clock + 60_000,
        },
        MASTER_SECRET,
      );

      expect(verifyOnboardingClaimToken(claimToken, MASTER_SECRET, clock)).toMatchObject({
        kind: 'pay',
        id: 'held_msg_42',
        peerAddress: SENDER_SCOPE,
        email: 'external@gmail.com',
        conversationId: CONVERSATION_ID,
      });

      const claimRes = await portal.handleHttpRequest({
        pathname: `/onboard/claim/${encodeURIComponent(claimToken)}`,
        method: 'GET',
      });
      expect(claimRes?.status).toBe(200);
      expect(JSON.parse(claimRes!.body)).toEqual({
        kind: 'pay',
        peerAddress: SENDER_SCOPE,
        email: 'external@gmail.com',
        conversationId: CONVERSATION_ID,
        subject: 'Held Inquiry',
        textBody: 'Imported held email body from sender',
        createdAt: clock,
      });
    });
  });

  describe('JournaledFrankOutbound + ResendWebhookHttp integration', () => {
    let dir: string;
    let ledger: CreditLedger;
    let journal: MailJournal;
    let portal: SecureMessagePortal;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-secure-portal-test-'));
      ledger = new CreditLedger(
        path.join(dir, 'journal.db'),
        new LocalFsBlobStore({ inMemory: true }),
      );
      journal = new MailJournal(ledger, {
        chainIdentifier: 'monad-testnet',
        gatewayAccount: GATEWAY_ACCOUNT,
        gatewayDomain: 'mail.frank.test',
        now: () => 1000,
      });
      portal = new SecureMessagePortal({
        gatewayDomain: 'mail.frank.test',
        frankAppUrl: 'https://app.frank.test',
        masterSecret: MASTER_SECRET,
        now: () => 1000,
      });
    });

    afterEach(() => {
      portal.close();
      ledger.sqlite?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('intercepts outbound mail when recipient has no WKD key (when-no-wkd) and serves portal + Stripe webhook over ResendWebhookHttp', async () => {
      const outbound = new JournaledFrankOutbound({
        journal,
        ledger,
        gatewayDomain: 'mail.frank.test',
        mailboxSalt: MASTER_SECRET,
        secureMessagePortal: portal,
        secureLinkPolicy: 'when-no-wkd',
        secureLinkDefaultAuthMode: 'direct',
        discoverRecipientWkdKey: async () => undefined,
        resolveSenderUsername: async () => 'alice',
        now: () => 1000,
      });

      const dm: DirectMessageReceived = {
        senderAddress: { raw: SENDER_SCOPE },
        recipientAddress: { raw: GATEWAY_ACCOUNT },
        payloadDigest: 'd'.repeat(64),
        stampValueWei: 1000n,
        stampPayments: [],
        receivedTime: 1000,
        conversationId: CONVERSATION_ID,
        messageId: '00000000-0000-0000-0000-000000000001',
        items: [
          {
            type: 'email',
            messageId: '<msg1@mail.frank.test>',
            from: { address: `${SENDER_SCOPE}@mail.frank.test`, name: 'Alice Frank' },
            to: [{ address: 'bob@gmail.com' }],
            subject: '[Secure:direct] Private Merger Proposal',
            textBody: 'Sensitive body that must never traverse Gmail in cleartext.',
            attachments: [
              {
                filename: 'term-sheet.pdf',
                contentType: 'application/pdf',
                content: new Uint8Array([1, 2, 3, 4]),
              },
            ],
          },
        ],
      };

      await outbound.handle(dm);

      const [job] = journal.listDueOutboundJobs(1000, 10);
      expect(job).toBeDefined();
      if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline RFC822');
      const rawEmail = Buffer.from(job.signedRfc822.bytes).toString('utf8');

      // Subject directive stripped, cleartext body stripped, secure link included
      expect(rawEmail).toContain('Subject: Private Merger Proposal');
      const [rawHeaders, rawBodyPart] = rawEmail.split('\r\n\r\n');
      const decodedBody = rawHeaders.includes('Content-Transfer-Encoding: base64')
        ? Buffer.from(rawBodyPart.replace(/\r?\n/g, ''), 'base64').toString('utf8')
        : rawBodyPart;
      expect(decodedBody).not.toContain(
        'Sensitive body that must never traverse Gmail in cleartext.',
      );
      const urlMatch = decodedBody.match(/https:\/\/mail\.frank\.test\/secure\/([0-9a-f]{64})/);
      expect(urlMatch).toBeTruthy();
      const tokenId = urlMatch![1];

      // Start ResendWebhookHttp with securePortal + checkoutServer mounted
      const stripeSecret = 'whsec_test_stripe_secret_999';
      let verifiedPaymentSender: string | undefined;
      const checkoutServer = new CheckoutServer({
        port: 0,
        ledger,
        stripeWebhookSecret: stripeSecret,
        frankAppUrl: 'https://app.frank.test',
        onboardingSecret: MASTER_SECRET,
        onPaymentVerified: (ev) => {
          verifiedPaymentSender = ev.senderEmail;
        },
      });

      const dummyImporter = {
        handle: async () => ({ kind: 'admitted' as const, admissions: [] }),
      } as unknown as ResendInboundWebhook;

      const httpIngress = new ResendWebhookHttp({
        importer: dummyImporter,
        host: '127.0.0.1',
        port: 0,
        securePortal: portal,
        checkoutServer,
      });
      await httpIngress.start();

      try {
        const baseUrl = httpIngress.address();

        // 1. Unlock the secure link via HTTP POST
        const verifyRes = await fetch(`${baseUrl}/secure/${tokenId}/verify`, {
          method: 'POST',
          body: '',
        });
        expect(verifyRes.status).toBe(200);
        const decryptedHtml = await verifyRes.text();
        expect(decryptedHtml).toContain('Sensitive body that must never traverse Gmail in cleartext.');
        expect(decryptedHtml).toContain('term-sheet.pdf');

        // 2. Verify Stripe webhook signature enforcement on POST /webhooks/stripe
        await ledger.holdMessage({
          id: 'held_stripe_1',
          senderEmail: 'bob@gmail.com',
          recipientAddress: SENDER_SCOPE,
          dkimDomain: 'gmail.com',
          subject: 'Re: Private Merger Proposal',
          rawRfc822: new TextEncoder().encode('Replying to Alice'),
          createdAtMs: 1000,
          expiresAtMs: Date.now() + 3600_000,
        });

        const payPageRes = await fetch(`${baseUrl}/pay/held_stripe_1`);
        expect(payPageRes.status).toBe(200);
        const payPageHtml = await payPageRes.text();
        expect(payPageHtml).toContain('Free Alternative: Message Directly on Frank');
        expect(payPageHtml).toContain('https://app.frank.test/#/onboard?');

        const webhookPayload = JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_live_abc',
              client_reference_id: 'held_stripe_1',
              customer_details: { email: 'bob@gmail.com' },
              metadata: { credits: '5', tierId: 'tier2' },
            },
          },
        });

        // Forged signature rejected with 400
        const badStripeRes = await fetch(`${baseUrl}/webhooks/stripe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': 't=1700000000,v1=' + '0'.repeat(64),
          },
          body: webhookPayload,
        });
        expect(badStripeRes.status).toBe(400);

        // Valid HMAC-SHA256 Stripe signature accepted with 200
        const validSig = buildStripeWebhookSignatureHeader(webhookPayload, stripeSecret);
        expect(verifyStripeWebhookSignature(webhookPayload, validSig, stripeSecret)).toBe(true);
        const goodStripeRes = await fetch(`${baseUrl}/webhooks/stripe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': validSig,
          },
          body: webhookPayload,
        });
        expect(goodStripeRes.status).toBe(200);
        expect(verifiedPaymentSender).toBe('bob@gmail.com');
        expect(ledger.getBalance('bob@gmail.com')).toBe(5);
      } finally {
        await httpIngress.stop();
      }
    });
  });
});
