import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../ledger/credit-ledger';
import { MailJournal, MAIL_JOURNAL_FORMAT } from '../ledger/mail-journal';
import { LocalFsBlobStore } from '../storage/local-fs-blob-store';
import { JournaledInboundSend } from '../relay/journaled-inbound-send';
import { JournaledFrankMailbox } from '../relay/journaled-frank-mailbox';
import { JournaledFrankOutbound } from '../relay/journaled-frank-outbound';
import { createIssuedMailboxLookup } from '../smtp/issued-mailbox-lookup';
import { createResendInboundPort, ResendInboundWebhook } from '../smtp/resend-inbound-webhook';
import { createResendSmtpPort } from '../mta/resend-smtp-port';
import { createResendSentMailEvidencePort, ResendOutboundReconciler } from '../mta/resend-outbound-reconciler';
import { JournaledOutboundWorker } from '../mta/journaled-outbound-worker';
import { JournaledMailRuntime } from './journaled-runtime';
import { ResendWebhookHttp } from './resend-webhook-http';
import { JournaledSmtpIngress, JournaledSmtpServer } from '../smtp/journaled-smtp-ingress';
import { CheckoutServer } from '../http/checkout-server';
import { parseRawRfc822 } from '../smtp/smtp-listener';
import {
  SecureMessagePortal,
  type SecureLinkPolicy,
  type SecureMessageAuthMode,
} from '../secure-link/secure-message-portal';

export interface JournaledMailHostOptions {
  readonly chain: ActiveChain;
  readonly wallet: WalletHandle;
  readonly journalFile: string;
  readonly blobDirectory: string;
  /** Explicit operator provisioning is required for a new journal. Normal restart refuses its absence. */
  readonly journalMode: 'existing' | 'provision';
  readonly gatewayDomain: string;
  readonly mailboxSalt: Uint8Array;
  readonly resendApiKey: string;
  readonly resendWebhookSecret: string;
  readonly resendRawOrigins: readonly string[];
  readonly inboundStampValue: bigint;
  readonly webhookHost: string;
  readonly webhookPort: number;
  readonly relayBaseUrl?: string;
  readonly frankAppUrl?: string;
  readonly stripeWebhookSecret?: string;
  readonly stripePaymentLinkTier1?: string;
  readonly stripePaymentLinkTier2?: string;
  readonly stripePaymentLinkTier3?: string;
  readonly operatorAccountAddress?: string;
  readonly operatorForwardEmail?: string;
  readonly resolveSenderUsername?: (scopeAccount: string) => Promise<string | undefined>;
  readonly resolveAccountPublicKey?: (
    accountAddress: string,
    localPart?: string,
  ) => Promise<Uint8Array | string | undefined>;
  readonly secureLinkPolicy?: SecureLinkPolicy;
  readonly secureLinkDefaultAuthMode?: SecureMessageAuthMode;
  readonly secureMessagePortal?: SecureMessagePortal;
  readonly nativeSmtp?: {
    readonly hostname: string;
    readonly tlsKey: Buffer;
    readonly tlsCert: Buffer;
  };
}

export interface JournaledMailHost {
  readonly journal: MailJournal;
  readonly runtime: JournaledMailRuntime;
  readonly webhook: ResendWebhookHttp;
  readonly securePortal: SecureMessagePortal;
  readonly checkoutServer: CheckoutServer;
  readonly smtp?: JournaledSmtpServer;
  close(): Promise<void>;
}

function createRelaySenderUsernameLookup(
  relayBaseUrl: string,
  fetcher: typeof fetch = fetch,
): (scopeAccount: string) => Promise<string | undefined> {
  const base = relayBaseUrl.replace(/\/+$/, '');
  return async (scopeAccount: string) => {
    const normalized = scopeAccount.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized)) return undefined;
    try {
      const response = await fetcher(
        `${base}/directory/users?addresses=${encodeURIComponent(normalized)}`,
        {
          method: 'GET',
          headers: { 'ngrok-skip-browser-warning': '1' },
        },
      );
      if (!response.ok) return undefined;
      const body = (await response.json().catch(() => undefined)) as
        | { users?: Array<{ username?: unknown; address?: unknown }> }
        | undefined;
      const entry = body?.users?.find(
        (u) => typeof u?.address === 'string' && u.address.toLowerCase() === normalized,
      ) ?? body?.users?.[0];
      return typeof entry?.username === 'string' ? entry.username.trim().toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Read-only preflight avoids silently replacing the mail admission history on restart. */
function requireJournalMode(input: JournaledMailHostOptions): void {
  const present = existsSync(input.journalFile);
  if (input.journalMode === 'provision') {
    if (present) throw new Error('Mail journal already exists; refuse provisioning');
    return;
  }
  if (!present) throw new Error('Existing mail journal is missing');
  const database = new DatabaseSync(input.journalFile, { readOnly: true });
  try {
    const row = database.prepare('SELECT format, chain_identifier, gateway_account, gateway_domain FROM mail_journal_meta WHERE id = 1')
      .get() as { format: number; chain_identifier: string; gateway_account: string; gateway_domain: string } | undefined;
    if (!row || row.format !== MAIL_JOURNAL_FORMAT ||
      row.chain_identifier !== input.chain.chainIdentifier ||
      row.gateway_account !== input.wallet.identity.address.raw.toLowerCase() ||
      row.gateway_domain !== input.gatewayDomain) {
      throw new Error('Existing mail journal identity or format differs');
    }
  } finally {
    database.close();
  }
}

/**
 * Production-effect composition after a separately admitted, persistent wallet
 * has opened. Wallet owns encrypted sends and spend recovery; this single SQLite
 * ledger owns credit, mail dispositions, mailbox position and SMTP jobs.
 */
export function createJournaledMailHost(input: JournaledMailHostOptions): JournaledMailHost {
  if (input.chain.chainIdentifier !== 'monad-testnet') throw new Error('Mail host chain must be monad-testnet');
  if (!isAbsolute(input.journalFile) || !isAbsolute(input.blobDirectory))
    throw new Error('Mail journal and blob paths must be absolute');
  if (!input.resendApiKey || !input.resendWebhookSecret) throw new Error('Resend credentials are required');
  requireJournalMode(input);

  const blobStore = new LocalFsBlobStore({ storageDir: input.blobDirectory });
  const ledger = new CreditLedger(input.journalFile, blobStore);
  let createdPortal: SecureMessagePortal | undefined;
  try {
    const journal = new MailJournal(ledger, {
      chainIdentifier: input.chain.chainIdentifier,
      gatewayAccount: input.wallet.identity.address.raw.toLowerCase(),
      gatewayDomain: input.gatewayDomain,
    });
    mkdirSync(input.blobDirectory, { recursive: true });
    const securePortal =
      input.secureMessagePortal ??
      (createdPortal = new SecureMessagePortal({
        gatewayDomain: input.gatewayDomain,
        masterSecret: input.mailboxSalt,
        ...(input.frankAppUrl ? { frankAppUrl: input.frankAppUrl } : {}),
        dbPath: join(input.blobDirectory, 'secure-portal.db'),
        resolveClaimedPayThread: async (payload) => {
          const found = journal.findInboundEmailByKey(payload.id);
          if (!found) return undefined;
          let subject = payload.subject ?? 'Held Message';
          let textBody = '';
          let htmlBody: string | undefined;
          if (found.raw) {
            try {
              const rawBytes =
                found.raw.kind === 'inline'
                  ? Buffer.from(found.raw.bytes)
                  : Buffer.from((await blobStore.get(found.raw.sha256)) ?? new Uint8Array());
              const parsed = parseRawRfc822(
                rawBytes,
                found.senderEmail,
                found.mailboxLocalPart
                  ? `${found.mailboxLocalPart}@${input.gatewayDomain}`
                  : found.scopeAccount,
              );
              subject = parsed.subject || subject;
              textBody = parsed.textBody || '';
              htmlBody = parsed.htmlBody;
            } catch {
              // Keep fallback metadata if raw blob cannot be read
            }
          }
          return {
            kind: 'pay',
            peerAddress: found.scopeAccount,
            email: found.senderEmail,
            conversationId: found.conversationId ?? payload.conversationId,
            subject,
            textBody,
            ...(htmlBody ? { htmlBody } : {}),
            createdAt: found.createdAtMs,
          };
        },
      }));
    const inbound = new JournaledInboundSend({
      chain: input.chain, wallet: input.wallet, ledger, journal, blobStore,
    });
    const checkoutServer = new CheckoutServer({
      port: 0,
      ledger,
      stripeWebhookSecret: input.stripeWebhookSecret,
      stripePaymentLinkTier1: input.stripePaymentLinkTier1,
      stripePaymentLinkTier2: input.stripePaymentLinkTier2,
      stripePaymentLinkTier3: input.stripePaymentLinkTier3,
      frankAppUrl: input.frankAppUrl ?? `https://${input.gatewayDomain}`,
      onboardingSecret: input.mailboxSalt,
      findHeldMail: (tokenOrId) => {
        const found = journal.findInboundEmailByKey(tokenOrId);
        if (!found) return undefined;
        let subject = 'Held Email';
        if (found.raw?.kind === 'inline') {
          try {
            const parsed = parseRawRfc822(
              Buffer.from(found.raw.bytes),
              found.senderEmail,
              found.scopeAccount,
            );
            if (parsed.subject) subject = parsed.subject;
          } catch {
            // Keep default subject
          }
        }
        return {
          id: found.heldMessageId ?? found.mailKey,
          senderEmail: found.senderEmail,
          recipientAddress: found.scopeAccount,
          subject,
          status:
            found.disposition === 'held'
              ? 'held'
              : found.disposition === 'expired'
                ? 'expired'
                : 'released',
          expiresAtMs: found.expiresAtMs ?? found.createdAtMs + 72 * 60 * 60 * 1000,
          conversationId: found.conversationId,
        };
      },
      onPaymentVerified: async () => {
        await inbound.releaseHeld(100);
      },
    });
    const resolveSenderUsername =
      input.resolveSenderUsername ??
      (input.relayBaseUrl ? createRelaySenderUsernameLookup(input.relayBaseUrl) : undefined);
    const outboundHandler = new JournaledFrankOutbound({
      journal,
      ledger,
      gatewayDomain: input.gatewayDomain,
      mailboxSalt: input.mailboxSalt,
      secureMessagePortal: securePortal,
      ...(input.secureLinkPolicy ? { secureLinkPolicy: input.secureLinkPolicy } : {}),
      ...(input.secureLinkDefaultAuthMode
        ? { secureLinkDefaultAuthMode: input.secureLinkDefaultAuthMode }
        : {}),
      ...(resolveSenderUsername ? { resolveSenderUsername } : {}),
    });
    const mailbox = new JournaledFrankMailbox({
      chain: input.chain, wallet: input.wallet, journal,
      handle: message => outboundHandler.handle(message),
    });
    const outbound = new JournaledOutboundWorker({
      journal, gatewayDomain: input.gatewayDomain, blobStore,
      port: createResendSmtpPort(input.resendApiKey),
    });
    const outboundReconciler = new ResendOutboundReconciler(
      journal, createResendSentMailEvidencePort(input.resendApiKey)
    );
    const lookupOptions = {
      ...(input.relayBaseUrl ? { relayUrl: input.relayBaseUrl } : {}),
      ...(input.operatorAccountAddress ? { operatorAccountAddress: input.operatorAccountAddress } : {}),
    };
    const issuedMailboxLookup = createIssuedMailboxLookup(journal, lookupOptions);
    const importer = new ResendInboundWebhook({
      port: createResendInboundPort(input.resendApiKey),
      webhookSecret: input.resendWebhookSecret,
      gatewayDomain: input.gatewayDomain,
      rawOrigins: input.resendRawOrigins,
      issuedMailboxLookup,
      sender: inbound,
      stampValue: input.inboundStampValue,
    });
    const gatewayPubKey = (
      input.wallet.identity as unknown as {
        signingPublicKey?: Uint8Array | string;
        publicKey?: Uint8Array | string;
      }
    )?.signingPublicKey ??
      (input.wallet.identity as unknown as { publicKey?: Uint8Array | string })?.publicKey;
    const webhook = new ResendWebhookHttp({
      importer,
      host: input.webhookHost,
      port: input.webhookPort,
      securePortal,
      checkoutServer,
      wkd: {
        gatewayDomain: input.gatewayDomain,
        journal,
        issuedMailboxLookup,
        ...(input.relayBaseUrl ? { relayUrl: input.relayBaseUrl } : {}),
        ...(gatewayPubKey ? { gatewayPublicKey: gatewayPubKey } : {}),
        ...(input.resolveAccountPublicKey
          ? { resolveAccountPublicKey: input.resolveAccountPublicKey }
          : {}),
      },
    });
    const smtp = input.nativeSmtp && new JournaledSmtpServer({
      ingress: new JournaledSmtpIngress({
        gatewayDomain: input.gatewayDomain,
        issuedMailboxLookup,
        sender: inbound,
        stampValue: input.inboundStampValue,
      }),
      hostname: input.nativeSmtp.hostname,
      tlsKey: input.nativeSmtp.tlsKey,
      tlsCert: input.nativeSmtp.tlsCert,
    });
    return {
      journal,
      runtime: new JournaledMailRuntime({ inbound, frankMailbox: mailbox, outbound, outboundReconciler }),
      webhook,
      securePortal,
      checkoutServer,
      smtp,
      close: async () => {
        try { if (smtp) await smtp.stop(); }
        finally {
          try { await webhook.stop(); }
          finally {
            try { if (createdPortal) createdPortal.close(); }
            finally { ledger.closeSqlite(); }
          }
        }
      },
    };
  } catch (error) {
    if (createdPortal) createdPortal.close();
    ledger.closeSqlite();
    throw error;
  }
}
