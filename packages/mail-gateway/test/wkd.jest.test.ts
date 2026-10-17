import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SigningKey } from 'ethers';
import { deriveOpenPgpSeeds } from '@frank/domain-roots';
import type { EmailItem } from '@frank/cashweb/types/messages';
import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';
import { ResendWebhookHttp } from '../src/host/resend-webhook-http';
import type { ResendInboundWebhook } from '../src/smtp/resend-inbound-webhook';
import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { createIssuedMailboxLookup } from '../src/smtp/issued-mailbox-lookup';
import { JournaledFrankOutbound } from '../src/relay/journaled-frank-outbound';
import {
  armorOpenPgpPublicKey,
  buildSecp256k1OpenPgpPublicKey,
  computeOpenPgpV4Fingerprint,
  dearmorOpenPgpPublicKey,
  decryptOpenPgpMessage,
  deriveDeterministicOpenPgpKeypair,
  discoverWkdPublicKey,
  encryptOpenPgpMessage,
  isOpenPgpArmoredMessage,
  isValidWkdHash,
  wkdHashLocalPart,
  wkdUrlsForAddress,
} from '../src/wkd/wkd';

const PRIV_KEY_ALICE = '0x' + '11'.repeat(32);
const SIGNING_KEY_ALICE = new SigningKey(PRIV_KEY_ALICE);
const COMPRESSED_PUB_ALICE = SIGNING_KEY_ALICE.compressedPublicKey;
const UNCOMPRESSED_PUB_ALICE = SIGNING_KEY_ALICE.publicKey;
const SCOPE_ALICE = '0x' + 'a'.repeat(40);
const GATEWAY_ACCOUNT = '0x' + '9'.repeat(40);
const SALT = new Uint8Array(32).fill(7);

describe('OpenPGP Web Key Directory (WKD) server & client discovery', () => {
  describe('wkdHashLocalPart & wkdUrlsForAddress', () => {
    it('matches the official draft-koch-openpgp-webkey-service test vector for Joe.Doe@Example.ORG', () => {
      expect(wkdHashLocalPart('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
      expect(wkdHashLocalPart('  JOE.DOE  ')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
      expect(isValidWkdHash('iy9q119eutrkn8s1mk4r39qejnbu3n5q')).toBe(true);
      expect(isValidWkdHash('invalid-hash')).toBe(false);
    });

    it('builds both Advanced and Direct WKD lookup and policy URLs', () => {
      const urls = wkdUrlsForAddress('Joe.Doe@Example.ORG');
      expect(urls).toEqual({
        localPart: 'joe.doe',
        domain: 'example.org',
        hu: 'iy9q119eutrkn8s1mk4r39qejnbu3n5q',
        advancedUrl:
          'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=joe.doe',
        directUrl:
          'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=joe.doe',
        advancedPolicyUrl: 'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/policy',
        directPolicyUrl: 'https://example.org/.well-known/openpgpkey/policy',
      });
    });
  });

  describe('RFC 4880 / RFC 6637 secp256k1 OpenPGP public key synthesis & armoring', () => {
    it('synthesizes identical binary OpenPGP public keys from compressed and uncompressed secp256k1 keys', () => {
      const fromCompressed = buildSecp256k1OpenPgpPublicKey({
        compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
        userId: 'alice@signet.mx',
        creationTimeSeconds: 1_700_000_000,
      });
      const fromUncompressed = buildSecp256k1OpenPgpPublicKey({
        compressedOrUncompressedPubKey: UNCOMPRESSED_PUB_ALICE,
        userId: 'alice@signet.mx',
        creationTimeSeconds: 1_700_000_000,
      });
      expect(fromCompressed.equals(fromUncompressed)).toBe(true);

      // Packet 1: Tag 6 (0xC6), body length 79 (0x4F), version 4 (0x04), algorithm 19 (ECDSA)
      expect(fromCompressed[0]).toBe(0xc6);
      expect(fromCompressed[1]).toBe(79);
      expect(fromCompressed[2]).toBe(0x04);
      expect(fromCompressed[7]).toBe(19);
      // secp256k1 OID: 0x05 2B 81 04 00 0A
      expect(fromCompressed.subarray(8, 14)).toEqual(
        Buffer.from([0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]),
      );
      // MPI bit length 515 (0x0203) + 0x04 uncompressed prefix
      expect(fromCompressed[14]).toBe(0x02);
      expect(fromCompressed[15]).toBe(0x03);
      expect(fromCompressed[16]).toBe(0x04);

      const fpFromFull = computeOpenPgpV4Fingerprint(fromCompressed);
      const fpFromBody = computeOpenPgpV4Fingerprint(fromCompressed.subarray(2, 2 + 79));
      expect(fpFromFull).toMatch(/^[0-9a-f]{40}$/);
      expect(fpFromFull).toBe(fpFromBody);

      const armored = armorOpenPgpPublicKey(fromCompressed);
      expect(armored).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
      expect(armored).toContain('-----END PGP PUBLIC KEY BLOCK-----');
      const dearmored = dearmorOpenPgpPublicKey(armored);
      expect(dearmored.equals(fromCompressed)).toBe(true);
      expect(dearmorOpenPgpPublicKey(fromCompressed).equals(fromCompressed)).toBe(true);
    });

    it('rejects corrupted CRC-24 checksums in ASCII armor', () => {
      const keyBytes = buildSecp256k1OpenPgpPublicKey({
        compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
        userId: 'alice@signet.mx',
      });
      const armored = armorOpenPgpPublicKey(keyBytes);
      const tampered = armored.replace(/=[A-Za-z0-9+/]{4}\n-----END/, '=AAAA\n-----END');
      expect(() => dearmorOpenPgpPublicKey(tampered)).toThrow('CRC-24 checksum mismatch');
    });
  });

  describe('Mail Gateway WKD HTTP Server & MailJournal WKD Hash Lookup', () => {
    let dir: string;
    let ledger: CreditLedger;
    let journal: MailJournal;
    let server: ResendWebhookHttp;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-wkd-http-'));
      ledger = new CreditLedger(
        path.join(dir, 'mail.sqlite'),
        new LocalFsBlobStore({ inMemory: true }),
      );
      journal = new MailJournal(ledger, {
        chainIdentifier: 'monad-testnet',
        gatewayAccount: GATEWAY_ACCOUNT,
        gatewayDomain: 'signet.mx',
        now: () => 1000,
      });
      journal.issueMailbox({ localPart: 'alice', scopeAccount: SCOPE_ALICE });

      const relayFetcher = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/directory/users?addresses=${encodeURIComponent(SCOPE_ALICE)}`)) {
          return new Response(
            JSON.stringify({
              users: [
                {
                  address: SCOPE_ALICE,
                  username: 'alice',
                  publicKey: COMPRESSED_PUB_ALICE,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('/usernames/bob')) {
          return new Response(
            JSON.stringify({
              address: SCOPE_ALICE,
              username: 'bob',
              publicKey: COMPRESSED_PUB_ALICE,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const issuedMailboxLookup = createIssuedMailboxLookup(journal, {
        relayUrl: 'https://relay.signet.mx',
        fetcher: relayFetcher,
      });

      server = new ResendWebhookHttp({
        importer: { handle: jest.fn() } as unknown as ResendInboundWebhook,
        host: '127.0.0.1',
        port: 0,
        wkd: {
          gatewayDomain: 'signet.mx',
          journal,
          issuedMailboxLookup,
          relayUrl: 'https://relay.signet.mx',
          fetcher: relayFetcher,
        },
      });
      await server.start();
    });

    afterEach(async () => {
      await server.stop();
      ledger.sqlite?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('serves Direct and Advanced WKD policy endpoints with CORS headers', async () => {
      const base = server.address();
      const directPolicy = await fetch(`${base}/.well-known/openpgpkey/policy`);
      expect(directPolicy.status).toBe(200);
      expect(directPolicy.headers.get('access-control-allow-origin')).toBe('*');
      expect(await directPolicy.text()).toBe('');

      const advancedPolicy = await fetch(`${base}/.well-known/openpgpkey/signet.mx/policy`);
      expect(advancedPolicy.status).toBe(200);
      expect(advancedPolicy.headers.get('access-control-allow-origin')).toBe('*');
      expect(await advancedPolicy.text()).toBe('');
    });

    it('serves OpenPGP binary key for Direct and Advanced WKD lookups with and without ?l= param', async () => {
      const base = server.address();
      const huAlice = wkdHashLocalPart('alice');
      const expectedKey = buildSecp256k1OpenPgpPublicKey({
        compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
        userId: 'alice@signet.mx',
      });

      // 1. Direct WKD with ?l=alice
      const directRes = await fetch(`${base}/.well-known/openpgpkey/hu/${huAlice}?l=alice`);
      expect(directRes.status).toBe(200);
      expect(directRes.headers.get('content-type')).toBe('application/octet-stream');
      expect(directRes.headers.get('access-control-allow-origin')).toBe('*');
      const directBytes = Buffer.from(await directRes.arrayBuffer());
      expect(directBytes.equals(expectedKey)).toBe(true);

      // 2. Advanced WKD with ?l=alice
      const advancedRes = await fetch(
        `${base}/.well-known/openpgpkey/signet.mx/hu/${huAlice}?l=alice`,
      );
      expect(advancedRes.status).toBe(200);
      const advancedBytes = Buffer.from(await advancedRes.arrayBuffer());
      expect(advancedBytes.equals(expectedKey)).toBe(true);

      // 3. Direct WKD WITHOUT ?l= query parameter (resolved via journal.issuedMailboxByWkdHash)
      const hashOnlyRes = await fetch(`${base}/.well-known/openpgpkey/hu/${huAlice}`);
      expect(hashOnlyRes.status).toBe(200);
      const hashOnlyBytes = Buffer.from(await hashOnlyRes.arrayBuffer());
      expect(hashOnlyBytes.equals(expectedKey)).toBe(true);

      // 4. Relay username lookup when not yet in issued_mailbox ('bob')
      const huBob = wkdHashLocalPart('bob');
      const bobRes = await fetch(`${base}/.well-known/openpgpkey/hu/${huBob}?l=bob`);
      expect(bobRes.status).toBe(200);
      const bobBytes = Buffer.from(await bobRes.arrayBuffer());
      expect(
        bobBytes.equals(
          buildSecp256k1OpenPgpPublicKey({
            compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
            userId: 'bob@signet.mx',
          }),
        ),
      ).toBe(true);
    });

    it('returns 404 when local-part hash mismatches ?l= parameter or user is unknown', async () => {
      const base = server.address();
      const huAlice = wkdHashLocalPart('alice');
      const mismatchRes = await fetch(`${base}/.well-known/openpgpkey/hu/${huAlice}?l=charlie`);
      expect(mismatchRes.status).toBe(404);

      const huUnknown = wkdHashLocalPart('unknown-user');
      const unknownRes = await fetch(
        `${base}/.well-known/openpgpkey/hu/${huUnknown}?l=unknown-user`,
      );
      expect(unknownRes.status).toBe(404);
    });
  });

  describe('External WKD Client Discovery (discoverWkdPublicKey) & Outbound OpenPGP Header', () => {
    it('discovers keys from providers supporting Advanced WKD, falls back to Direct WKD, and returns undefined when absent', async () => {
      const sampleKey = buildSecp256k1OpenPgpPublicKey({
        compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
        userId: 'peer@proton.me',
      });
      const urls = wkdUrlsForAddress('peer@proton.me');

      // Case 1: Provider serves Advanced WKD
      const advancedFetch = jest.fn(async (input: RequestInfo | URL) => {
        if (String(input) === urls.advancedUrl) {
          return new Response(new Uint8Array(sampleKey), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const advResult = await discoverWkdPublicKey('Peer@Proton.ME', { fetch: advancedFetch });
      expect(advResult).toBeDefined();
      expect(advResult?.method).toBe('advanced');
      expect(advResult?.url).toBe(urls.advancedUrl);
      expect(advResult?.keyBytes.equals(sampleKey)).toBe(true);

      // Case 2: Advanced returns 404, Direct returns ASCII-armored key
      const directFetch = jest.fn(async (input: RequestInfo | URL) => {
        if (String(input) === urls.directUrl) {
          return new Response(armorOpenPgpPublicKey(sampleKey), {
            status: 200,
            headers: { 'content-type': 'application/pgp-keys' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const dirResult = await discoverWkdPublicKey('peer@proton.me', { fetch: directFetch });
      expect(dirResult).toBeDefined();
      expect(dirResult?.method).toBe('direct');
      expect(dirResult?.url).toBe(urls.directUrl);
      expect(dirResult?.keyBytes.equals(sampleKey)).toBe(true);

      // Case 3: Neither exists
      const noneFetch = jest.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
      expect(await discoverWkdPublicKey('nobody@gmail.com', { fetch: noneFetch })).toBeUndefined();
    });

    it('advertises OpenPGP WKD URL header on outbound emails and supports optional WKD encryption', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-wkd-outbound-'));
      const ledger = new CreditLedger(
        path.join(dir, 'mail.sqlite'),
        new LocalFsBlobStore({ inMemory: true }),
      );
      try {
        const journal = new MailJournal(ledger, {
          chainIdentifier: 'monad-testnet',
          gatewayAccount: GATEWAY_ACCOUNT,
          gatewayDomain: 'signet.mx',
          now: () => 1000,
        });
        const recipientKey = buildSecp256k1OpenPgpPublicKey({
          compressedOrUncompressedPubKey: COMPRESSED_PUB_ALICE,
          userId: 'bob@proton.me',
        });
        const outbound = new JournaledFrankOutbound({
          journal,
          ledger,
          gatewayDomain: 'signet.mx',
          mailboxSalt: SALT,
          now: () => 1000,
          resolveSenderUsername: async () => 'alice',
          discoverRecipientWkdKey: async (addr) =>
            addr === 'bob@proton.me'
              ? { keyBytes: recipientKey, url: wkdUrlsForAddress(addr).advancedUrl }
              : undefined,
          encryptBodyWithOpenPgp: async (plaintext) =>
            `-----BEGIN PGP MESSAGE-----\n\nEncrypted(${plaintext})\n-----END PGP MESSAGE-----`,
        });

        const message: DirectMessageReceived = {
          senderAddress: { raw: SCOPE_ALICE },
          recipientAddress: { raw: GATEWAY_ACCOUNT },
          payloadDigest: 'c'.repeat(64),
          stampValueWei: 1000n,
          stampPayments: [],
          receivedTime: 1000,
          conversationId: '00000000-0000-0000-0000-000000000002',
          messageId: '00000000-0000-0000-0000-000000000001',
          items: [
            {
              type: 'email',
              messageId: '<msg-wkd-1@signet.mx>',
              from: { address: 'alice@signet.mx', name: 'Alice' },
              to: [{ address: 'bob@proton.me' }],
              subject: 'Hello via WKD',
              textBody: 'Secret message',
            },
          ],
        };

        await outbound.handle(message);
        const [job] = journal.listDueOutboundJobs(1000, 10);
        expect(job).toBeDefined();
        if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline bytes');
        const raw = Buffer.from(job.signedRfc822.bytes).toString('utf8');
        const huAlice = wkdHashLocalPart('alice');
        expect(raw).toContain(
          `OpenPGP: url=https://signet.mx/.well-known/openpgpkey/hu/${huAlice}?l=alice`,
        );
        expect(raw).toContain('Encrypted(Secret message)');
      } finally {
        ledger.sqlite?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('End-to-End Deterministic OpenPGP Key Derivation & Ciphertext Passthrough (#1695)', () => {
    const ACCOUNT_ROOT_SEED = Uint8Array.from(
      { length: 32 },
      (_, idx) => (idx * 17 + 0x23) & 0xff,
    );

    it('restores identical Ed25519 + X25519 WKD/OpenPGP public keys from the same seed and decrypts messages encrypted to it', () => {
      const restoredWalletA = deriveDeterministicOpenPgpKeypair(
        new Uint8Array(ACCOUNT_ROOT_SEED),
        'alice@signet.mx',
      );
      const restoredWalletB = deriveDeterministicOpenPgpKeypair(
        new Uint8Array(ACCOUNT_ROOT_SEED),
        'alice@signet.mx',
      );

      expect(restoredWalletA.publicKeyPacket.equals(restoredWalletB.publicKeyPacket)).toBe(true);
      expect(restoredWalletA.armoredPublicKey).toBe(restoredWalletB.armoredPublicKey);
      expect(restoredWalletA.fingerprint).toBe(restoredWalletB.fingerprint);
      expect(restoredWalletA.subkeyFingerprint).toBe(restoredWalletB.subkeyFingerprint);

      const cleartext = 'End-to-end encrypted message across wallet recovery!';
      const armoredCiphertext = encryptOpenPgpMessage(
        cleartext,
        restoredWalletA.publicKeyPacket,
      );
      expect(isOpenPgpArmoredMessage(armoredCiphertext)).toBe(true);

      // Both restored wallets (using either accountRootSeed or deriveOpenPgpSeeds output) decrypt the ciphertext
      expect(decryptOpenPgpMessage(armoredCiphertext, ACCOUNT_ROOT_SEED)).toBe(cleartext);
      expect(
        decryptOpenPgpMessage(armoredCiphertext, deriveOpenPgpSeeds(ACCOUNT_ROOT_SEED)),
      ).toBe(cleartext);
      expect(
        decryptOpenPgpMessage(armoredCiphertext, restoredWalletB.encryptionSubkeySeed),
      ).toBe(cleartext);
    });

    it('passes already OpenPGP-encrypted outbound email bodies through unchanged without double-encryption', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-wkd-e2e-outbound-'));
      const ledger = new CreditLedger(
        path.join(dir, 'mail.sqlite'),
        new LocalFsBlobStore({ inMemory: true }),
      );
      try {
        const journal = new MailJournal(ledger, {
          chainIdentifier: 'monad-testnet',
          gatewayAccount: GATEWAY_ACCOUNT,
          gatewayDomain: 'signet.mx',
          now: () => 1000,
        });
        const bobOpenPgp = deriveDeterministicOpenPgpKeypair(
          ACCOUNT_ROOT_SEED,
          'bob@proton.me',
        );
        const clientCiphertext = encryptOpenPgpMessage(
          'Client-side pre-encrypted payload',
          bobOpenPgp.publicKeyPacket,
        );

        const encryptSpy = jest.fn(async (plaintext: string) =>
          encryptOpenPgpMessage(plaintext, bobOpenPgp.publicKeyPacket),
        );

        const outbound = new JournaledFrankOutbound({
          journal,
          ledger,
          gatewayDomain: 'signet.mx',
          mailboxSalt: SALT,
          now: () => 1000,
          resolveSenderUsername: async () => 'alice',
          discoverRecipientWkdKey: async (addr) =>
            addr === 'bob@proton.me'
              ? { keyBytes: bobOpenPgp.publicKeyPacket, url: wkdUrlsForAddress(addr).advancedUrl }
              : undefined,
          encryptBodyWithOpenPgp: encryptSpy,
        });

        const message: DirectMessageReceived = {
          senderAddress: { raw: SCOPE_ALICE },
          recipientAddress: { raw: GATEWAY_ACCOUNT },
          payloadDigest: 'd'.repeat(64),
          stampValueWei: 1000n,
          stampPayments: [],
          receivedTime: 1000,
          conversationId: '00000000-0000-0000-0000-000000000003',
          messageId: '00000000-0000-0000-0000-000000000004',
          items: [
            {
              type: 'email',
              messageId: '<msg-e2e-preencrypted@signet.mx>',
              inReplyTo: '<parent-1@proton.me>',
              references: ['<root-1@proton.me>', '<parent-1@proton.me>'],
              from: { address: 'alice@signet.mx', name: 'Alice' },
              to: [{ address: 'bob@proton.me' }],
              subject: 'E2E OpenPGP Pre-Encrypted',
              textBody: clientCiphertext,
            },
          ],
        };

        await outbound.handle(message);
        expect(encryptSpy).not.toHaveBeenCalled();

        const [job] = journal.listDueOutboundJobs(1000, 10);
        expect(job).toBeDefined();
        if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline bytes');
        const rawRfc822 = Buffer.from(job.signedRfc822.bytes).toString('utf8');

        expect(rawRfc822).toContain('From: "Alice" <alice@signet.mx>');
        expect(rawRfc822).toContain('To: bob@proton.me');
        expect(rawRfc822).toContain('Message-ID: <msg-e2e-preencrypted@signet.mx>');
        expect(rawRfc822).toContain('In-Reply-To: <parent-1@proton.me>');
        expect(rawRfc822).toContain('References: <root-1@proton.me> <parent-1@proton.me>');
        expect(rawRfc822).toContain('Content-Transfer-Encoding: 7bit');

        const expectedCrLfCiphertext = clientCiphertext.replace(/\r?\n/g, '\r\n');
        expect(rawRfc822).toContain(expectedCrLfCiphertext);

        // Recipient decrypts the exact body from the outbound RFC 5322 message
        const bodySection = rawRfc822.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        expect(decryptOpenPgpMessage(bodySection, ACCOUNT_ROOT_SEED)).toBe(
          'Client-side pre-encrypted payload',
        );
      } finally {
        ledger.sqlite?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('forwards inbound OpenPGP-encrypted email intact into Frank EmailItem and decrypts with seed-derived OpenPGP key', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-wkd-e2e-inbound-'));
      const ledger = new CreditLedger(
        path.join(dir, 'mail.sqlite'),
        new LocalFsBlobStore({ inMemory: true }),
      );
      try {
        const aliceOpenPgp = deriveDeterministicOpenPgpKeypair(
          ACCOUNT_ROOT_SEED,
          'alice@signet.mx',
        );
        const inboundCiphertext = encryptOpenPgpMessage(
          'Inbound secret from external ProtonMail sender',
          aliceOpenPgp.publicKeyPacket,
        );

        ledger.grantReplyAllowance('peer@proton.me', SCOPE_ALICE, 2);

        const deliveredCalls: Array<{
          recipientAddress: string;
          items: unknown[];
        }> = [];

        const handler = new InboundEmailHandler({
          gatewayDomain: 'signet.mx',
          ledger,
          stampProvider: {
            chainFamily: 'evm',
            assetUnit: 'wei',
            getBalance: async () => ({
              raw: 10_000_000_000_000_000_000n,
              display: '10 MON',
              isLowBalance: false,
            }),
            checkHealth: async () => ({ ok: true }),
            stampAndSendDirectMessage: async (params) => {
              deliveredCalls.push({
                recipientAddress: params.recipientAddress,
                items: params.items ?? [],
              });
              return {
                txHash: '0x' + 'f'.repeat(64),
                payloadDigest: 'e'.repeat(64),
                recipientAddress: params.recipientAddress,
              };
            },
          },
          relayLookup: async (localPart) =>
            localPart === 'alice' ? { accountAddress: SCOPE_ALICE } : undefined,
        });

        // 1. Direct armored textBody
        const res1 = await handler.processInboundEmail({
          messageId: '<inbound-pgp-1@proton.me>',
          fromAddress: 'peer@proton.me',
          fromName: 'Peer',
          fromDomain: 'proton.me',
          toAddress: 'alice@signet.mx',
          localPart: 'alice',
          subject: 'Encrypted Reply',
          textBody: inboundCiphertext,
          dkimValid: true,
          spfValid: true,
          rawRfc822: Buffer.from(
            `From: peer@proton.me\r\nTo: alice@signet.mx\r\nSubject: Encrypted Reply\r\n\r\n${inboundCiphertext}`,
            'utf8',
          ),
        });

        expect(res1.status).toBe('delivered');
        expect(deliveredCalls).toHaveLength(1);
        const bridgedEmail1 = (deliveredCalls[0].items as EmailItem[]).find(
          (i) => i.type === 'email',
        );
        expect(bridgedEmail1).toBeDefined();
        expect(bridgedEmail1!.textBody).toBe(inboundCiphertext);
        expect(
          decryptOpenPgpMessage(bridgedEmail1!.textBody, ACCOUNT_ROOT_SEED),
        ).toBe('Inbound secret from external ProtonMail sender');

        // 2. PGP/MIME multipart/encrypted where textBody is empty and ciphertext is in rawRfc822
        const mimeRaw = [
          'From: peer@proton.me',
          'To: alice@signet.mx',
          'Subject: PGP/MIME Encrypted',
          'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="pgp-b"',
          '',
          '--pgp-b',
          'Content-Type: application/pgp-encrypted',
          '',
          'Version: 1',
          '',
          '--pgp-b',
          'Content-Type: application/octet-stream; name="encrypted.asc"',
          '',
          inboundCiphertext,
          '--pgp-b--',
        ].join('\r\n');

        const res2 = await handler.processInboundEmail({
          messageId: '<inbound-pgp-2@proton.me>',
          fromAddress: 'peer@proton.me',
          fromName: 'Peer',
          fromDomain: 'proton.me',
          toAddress: 'alice@signet.mx',
          localPart: 'alice',
          subject: 'PGP/MIME Encrypted',
          textBody: '',
          dkimValid: true,
          spfValid: true,
          rawRfc822: Buffer.from(mimeRaw, 'utf8'),
        });

        expect(res2.status).toBe('delivered');
        expect(deliveredCalls).toHaveLength(2);
        const bridgedEmail2 = (deliveredCalls[1].items as EmailItem[]).find(
          (i) => i.type === 'email',
        );
        expect(bridgedEmail2).toBeDefined();
        expect(bridgedEmail2!.textBody).toBe(inboundCiphertext);
        expect(
          decryptOpenPgpMessage(bridgedEmail2!.textBody, ACCOUNT_ROOT_SEED),
        ).toBe('Inbound secret from external ProtonMail sender');
      } finally {
        ledger.sqlite?.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
