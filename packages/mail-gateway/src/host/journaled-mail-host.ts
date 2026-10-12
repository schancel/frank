import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
  readonly smtp?: JournaledSmtpServer;
  close(): Promise<void>;
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
  try {
    const journal = new MailJournal(ledger, {
      chainIdentifier: input.chain.chainIdentifier,
      gatewayAccount: input.wallet.identity.address.raw.toLowerCase(),
      gatewayDomain: input.gatewayDomain,
    });
    const inbound = new JournaledInboundSend({
      chain: input.chain, wallet: input.wallet, ledger, journal, blobStore,
    });
    const outboundHandler = new JournaledFrankOutbound({
      journal, ledger, gatewayDomain: input.gatewayDomain, mailboxSalt: input.mailboxSalt,
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
    const importer = new ResendInboundWebhook({
      port: createResendInboundPort(input.resendApiKey),
      webhookSecret: input.resendWebhookSecret,
      gatewayDomain: input.gatewayDomain,
      rawOrigins: input.resendRawOrigins,
      issuedMailboxLookup: createIssuedMailboxLookup(journal),
      sender: inbound,
      stampValue: input.inboundStampValue,
    });
    const webhook = new ResendWebhookHttp({
      importer, host: input.webhookHost, port: input.webhookPort,
    });
    const smtp = input.nativeSmtp && new JournaledSmtpServer({
      ingress: new JournaledSmtpIngress({
        gatewayDomain: input.gatewayDomain,
        issuedMailboxLookup: createIssuedMailboxLookup(journal),
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
      smtp,
      close: async () => {
        try { if (smtp) await smtp.stop(); }
        finally {
          try { await webhook.stop(); }
          finally { ledger.closeSqlite(); }
        }
      },
    };
  } catch (error) {
    ledger.closeSqlite();
    throw error;
  }
}
