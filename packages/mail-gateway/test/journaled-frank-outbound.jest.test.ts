import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, DirectMessageReceived, WalletHandle } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { JournaledFrankOutbound, replyAlias, userIdFallbackLocalPart } from '../src/relay/journaled-frank-outbound';
import { JournaledFrankMailbox } from '../src/relay/journaled-frank-mailbox';
import { JournaledInboundSend } from '../src/relay/journaled-inbound-send';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const SCOPE = `0x${'a'.repeat(40)}`;
const GATEWAY = `0x${'9'.repeat(40)}`;
const CONVERSATION = '00000000-0000-0000-0000-000000000002';
const MESSAGE = '00000000-0000-0000-0000-000000000001';
const DIGEST = 'a'.repeat(64);
const RFC_ID = '<authored@example.test>';
const SALT = new Uint8Array(32).fill(7);

function received(): DirectMessageReceived {
  return {
    senderAddress: { raw: SCOPE },
    recipientAddress: { raw: GATEWAY },
    payloadDigest: DIGEST,
    stampValueWei: 1000n,
    stampPayments: [],
    receivedTime: 1000,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    items: [{
      type: 'email',
      messageId: RFC_ID,
      from: { address: SCOPE },
      to: [{ address: 'recipient@example.test' }],
      subject: 'Test',
      textBody: 'Hello',
    }],
  };
}

describe('journaled Frank outbound bridge', () => {
  let dir: string;
  let ledger: CreditLedger;
  let journal: MailJournal;
  let handler: JournaledFrankOutbound;
  const open = () => {
    ledger = new CreditLedger(path.join(dir, 'mail.sqlite'), new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: 'monad-testnet', gatewayAccount: GATEWAY, gatewayDomain: 'gw.example', now: () => 1000,
    });
    handler = new JournaledFrankOutbound({
      journal, ledger, gatewayDomain: 'gw.example', mailboxSalt: SALT, now: () => 1000,
    });
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-outbound-bridge-'));
    open();
  });
  afterEach(() => {
    ledger.sqlite?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('atomically records the bridged message, issued reply address and exact job bytes', async () => {
    const message = received();
    await handler.handle(message);
    const alias = replyAlias(SALT, SCOPE, CONVERSATION);
    expect(journal.issuedMailbox(alias)).toMatchObject({ scopeAccount: SCOPE, conversationId: CONVERSATION });
    expect(journal.findFrankInbound(DIGEST)?.disposition).toBe('bridged');
    const [job] = journal.listDueOutboundJobs(1000, 10);
    expect(job).toMatchObject({ senderLocalPart: alias, recipientEmail: 'recipient@example.test', state: 'pending' });
    if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline mail');
    const raw = Buffer.from(job.signedRfc822.bytes).toString('utf8');
    expect(raw).toContain(`From: ${alias}@gw.example\r\nReply-To: ${alias}@gw.example`);
    expect(raw).toContain(`Message-ID: ${RFC_ID}`);
    expect(raw).toContain('Content-Transfer-Encoding: 7bit\r\n\r\nHello\r\n');
    ledger.sqlite?.close();
    open();
    await handler.handle(message);
    expect(journal.listDueOutboundJobs(1000, 10).map(row => row.jobId)).toEqual([job.jobId]);
    expect(journal.issuedMailbox(alias)).toMatchObject({ scopeAccount: SCOPE });
  });

  it('does not advance a disposition if job insertion fails, then replays the original message', async () => {
    ledger.sqlite!.exec("CREATE TEMP TRIGGER fail_job BEFORE INSERT ON outbound_job BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(handler.handle(received())).rejects.toThrow('injected');
    expect(journal.findFrankInbound(DIGEST)).toBeUndefined();
    expect(journal.issuedMailbox(replyAlias(SALT, SCOPE, CONVERSATION))).toBeUndefined();
    ledger.sqlite!.exec('DROP TRIGGER fail_job');
    await handler.handle(received());
    expect(journal.listDueOutboundJobs(1000, 10)).toHaveLength(1);
  });

  it('durably rejects unsupported multi-recipient mail without creating a delivery job', async () => {
    const message = received();
    const email = message.items[0];
    if (email.type !== 'email') throw new Error('Expected email');
    email.to.push({ address: 'other@example.test' });
    await handler.handle(message);
    expect(journal.findFrankInbound(DIGEST)).toMatchObject({ disposition: 'rejected', reason: 'bad_recipient' });
    expect(journal.listDueOutboundJobs(1000, 10)).toEqual([]);
  });

  it.each(['<x@no-message-id.gw.example>', '<x@NO-MESSAGE-ID.GW.EXAMPLE>'])(
    'durably rejects authored mail ID %s in a gateway-reserved namespace', async (authoredId) => {
      const message = received();
      const email = message.items[0];
      if (email.type !== 'email') throw new Error('Expected email');
      email.messageId = authoredId;
      await handler.handle(message);
      expect(journal.findFrankInbound(DIGEST)).toMatchObject({ disposition: 'rejected', reason: 'bad_message_id' });
      expect(journal.listDueOutboundJobs(1000, 10)).toEqual([]);
      ledger.sqlite?.close();
      open();
      await handler.handle(message);
      expect(journal.findFrankInbound(DIGEST)).toMatchObject({ disposition: 'rejected', reason: 'bad_message_id' });
    }
  );

  it('advances the mailbox past a reserved authored ID and bridges later mail', async () => {
    const reserved = received();
    const firstItem = reserved.items[0];
    if (firstItem.type !== 'email') throw new Error('Expected email');
    firstItem.messageId = '<x@no-message-id.gw.example>';
    const later = received();
    later.payloadDigest = 'b'.repeat(64);
    later.receivedTime = 2000;
    later.messageId = '00000000-0000-0000-0000-000000000003';
    const laterItem = later.items[0];
    if (laterItem.type !== 'email') throw new Error('Expected email');
    laterItem.messageId = '<later@example.test>';
    const wallet = { identity: { address: { raw: GATEWAY } } } as WalletHandle;
    const chain = {
      chainIdentifier: 'monad-testnet',
      directMessages: { fetchSince: async ({ sinceMs }: { sinceMs: number }) =>
        [reserved, later].filter(message => message.receivedTime >= sinceMs) },
    } as unknown as ActiveChain;
    const mailbox = new JournaledFrankMailbox({ chain, wallet, journal, handle: message => handler.handle(message) });
    expect(await mailbox.pollOnce()).toEqual({ processed: 2, cursorMs: 2000 });
    expect(journal.findFrankInbound(DIGEST)).toMatchObject({ disposition: 'rejected', reason: 'bad_message_id' });
    expect(journal.findFrankInbound(later.payloadDigest)?.disposition).toBe('bridged');
    expect(journal.listDueOutboundJobs(2000, 10)).toHaveLength(1);
  });

  it('encodes Unicode subject and body without changing the issued sender', async () => {
    const message = received();
    const email = message.items[0];
    if (email.type !== 'email') throw new Error('Expected email');
    email.subject = 'Bonjour 🌍';
    email.textBody = 'Salut 🌍';
    await handler.handle(message);
    const [job] = journal.listDueOutboundJobs(1000, 10);
    if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline mail');
    const raw = Buffer.from(job.signedRfc822.bytes).toString('utf8');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(raw).toContain(Buffer.from('Salut 🌍').toString('base64'));
    expect(raw).toContain(`Reply-To: ${replyAlias(SALT, SCOPE, CONVERSATION)}@gw.example`);
  });

  it('uses resolved relay username and display name in both From and Reply-To', async () => {
    const handlerWithUsername = new JournaledFrankOutbound({
      journal,
      ledger,
      gatewayDomain: 'gw.example',
      mailboxSalt: SALT,
      now: () => 1000,
      resolveSenderUsername: async (scope) => (scope === SCOPE ? 'shammah' : undefined),
    });
    const message = received();
    const email = message.items[0];
    if (email.type !== 'email') throw new Error('Expected email');
    email.from = { address: `${SCOPE}@gw.example`, name: 'Shammah Chancellor' };
    await handlerWithUsername.handle(message);

    const alias = replyAlias(SALT, SCOPE, CONVERSATION);
    expect(journal.issuedMailbox('shammah')).toEqual({ scopeAccount: SCOPE });
    expect(journal.issuedMailbox(alias)).toEqual({ scopeAccount: SCOPE, conversationId: CONVERSATION });
    const [job] = journal.listDueOutboundJobs(1000, 10);
    if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline mail');
    const raw = Buffer.from(job.signedRfc822.bytes).toString('utf8');
    expect(raw).toContain('From: "Shammah Chancellor" <shammah@gw.example>\r\nReply-To: shammah@gw.example');
  });

  it('falls back to canonical 0x account address in From and Reply-To when sender has no username', async () => {
    const handlerWithFallback = new JournaledFrankOutbound({
      journal,
      ledger,
      gatewayDomain: 'gw.example',
      mailboxSalt: SALT,
      now: () => 1000,
      resolveSenderUsername: async () => undefined,
    });
    const message = received();
    const email = message.items[0];
    if (email.type !== 'email') throw new Error('Expected email');
    email.from = { address: `${SCOPE}@gw.example`, name: 'Shammah' };
    await handlerWithFallback.handle(message);

    const fallbackLocal = userIdFallbackLocalPart(SCOPE);
    expect(fallbackLocal).toBe(SCOPE);
    const [job] = journal.listDueOutboundJobs(1000, 10);
    if (job.signedRfc822.kind !== 'inline') throw new Error('Expected inline mail');
    const raw = Buffer.from(job.signedRfc822.bytes).toString('utf8');
    expect(raw).toContain(`From: "Shammah" <${fallbackLocal}@gw.example>\r\nReply-To: ${fallbackLocal}@gw.example`);
  });

  it('routes inbound replies sent to canonical username or 0x address into existing conversation via In-Reply-To / References headers', async () => {
    const inboundStampValue = 300n;
    const handlerWithUsername = new JournaledFrankOutbound({
      journal,
      ledger,
      gatewayDomain: 'gw.example',
      mailboxSalt: SALT,
      inboundStampValue,
      now: () => 1000,
      resolveSenderUsername: async (scope) => (scope === SCOPE ? 'shammah' : undefined),
    });
    const message = received();
    message.stampValueWei = 900n;
    const email = message.items[0];
    if (email.type !== 'email') throw new Error('Expected email');
    email.from = { address: 'shammah@gw.example', name: 'Shammah Chancellor' };
    await handlerWithUsername.handle(message);

    expect(ledger.getThreadAllowance('recipient@example.test', SCOPE)).toBe(3);

    const wallet = { identity: { address: { raw: GATEWAY } } } as WalletHandle;
    const chain = {
      chainIdentifier: 'monad-testnet',
      parseAddress: (addr: string) => (/^0x[0-9a-f]{40}$/i.test(addr) ? { raw: addr.toLowerCase() } : undefined),
    } as unknown as ActiveChain;
    const inboundSend = new JournaledInboundSend({
      chain,
      wallet,
      ledger,
      journal,
    });

    // 1. Reply to shammah@gw.example referencing RFC Message-ID (no conversationId on issued_mailbox('shammah'))
    const replyToUsernameRfc822 = Buffer.from(
      [
        'From: recipient@example.test',
        'To: shammah@gw.example',
        'Subject: Re: Test',
        'Message-ID: <reply-username-1@example.test>',
        `In-Reply-To: ${RFC_ID}`,
        `References: ${RFC_ID}`,
        '',
        'Reply to canonical username address',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const admission1 = inboundSend.admit(
      {
        email: parseRawRfc822(replyToUsernameRfc822, 'recipient@example.test', 'shammah@gw.example'),
        verifiedTransportId: 'resend-username-1',
        authenticatedSenderEmail: 'recipient@example.test',
      },
      SCOPE,
      inboundStampValue,
      undefined,
      'shammah',
    );
    expect(admission1.kind).toBe('queued');
    expect(ledger.getThreadAllowance('recipient@example.test', SCOPE)).toBe(2);

    // 2. Reply to 0x...@gw.example referencing rendered <frankMessageId@gw.example> Message-ID
    const replyToAddressRfc822 = Buffer.from(
      [
        'From: recipient@example.test',
        `To: ${SCOPE}@gw.example`,
        'Subject: Re: Test',
        'Message-ID: <reply-address-2@example.test>',
        `In-Reply-To: <${MESSAGE}@gw.example>`,
        `References: ${RFC_ID} <${MESSAGE}@gw.example>`,
        '',
        'Reply to fallback 0x address',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const admission2 = inboundSend.admit(
      {
        email: parseRawRfc822(replyToAddressRfc822, 'recipient@example.test', `${SCOPE}@gw.example`),
        verifiedTransportId: 'resend-address-2',
        authenticatedSenderEmail: 'recipient@example.test',
      },
      SCOPE,
      inboundStampValue,
      undefined,
      SCOPE,
    );
    expect(admission2.kind).toBe('queued');
    expect(ledger.getThreadAllowance('recipient@example.test', SCOPE)).toBe(1);

    // Verify both inbound replies were recorded in the original Frank conversation
    expect(journal.findConversationByThreadHeaders({
      scopeAccount: SCOPE,
      inReplyTo: '<reply-username-1@example.test>',
    })).toBe(CONVERSATION);
    expect(journal.findConversationByThreadHeaders({
      scopeAccount: SCOPE,
      inReplyTo: '<reply-address-2@example.test>',
    })).toBe(CONVERSATION);
  });

  it('grants reply allowances in CreditLedger when outbound stamp covers inboundStampValue so external reply is queued immediately', async () => {
    const inboundStampValue = 300n;
    const handlerWithAllowance = new JournaledFrankOutbound({
      journal,
      ledger,
      gatewayDomain: 'gw.example',
      mailboxSalt: SALT,
      inboundStampValue,
      now: () => 1000,
    });
    const message = received();
    message.stampValueWei = 900n; // Covers 3x inboundStampValue
    await handlerWithAllowance.handle(message);

    expect(ledger.getThreadAllowance('recipient@example.test', SCOPE)).toBe(3);
    expect(journal.findFrankInbound(DIGEST)?.spent).toBe('900');

    const alias = replyAlias(SALT, SCOPE, CONVERSATION);
    const replyRfc822 = Buffer.from(
      [
        'From: recipient@example.test',
        `To: ${alias}@gw.example`,
        'Subject: Re: Test',
        'Message-ID: <reply-1@example.test>',
        `In-Reply-To: ${RFC_ID}`,
        `References: ${RFC_ID}`,
        '',
        'Sup?',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const wallet = { identity: { address: { raw: GATEWAY } } } as WalletHandle;
    const chain = {
      chainIdentifier: 'monad-testnet',
      parseAddress: (addr: string) => (/^0x[0-9a-f]{40}$/i.test(addr) ? { raw: addr.toLowerCase() } : undefined),
    } as unknown as ActiveChain;
    const inboundSend = new JournaledInboundSend({
      chain,
      wallet,
      ledger,
      journal,
    });
    const admission = inboundSend.admit(
      {
        email: parseRawRfc822(replyRfc822, 'recipient@example.test', `${alias}@gw.example`),
        verifiedTransportId: 'resend-1',
        authenticatedSenderEmail: 'recipient@example.test',
      },
      SCOPE,
      inboundStampValue,
      CONVERSATION,
      alias,
    );
    expect(admission.kind).toBe('queued');
    expect(ledger.getThreadAllowance('recipient@example.test', SCOPE)).toBe(2);
  });
});
