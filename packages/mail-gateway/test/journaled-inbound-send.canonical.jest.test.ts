/** Mail host admission/recovery composed with real canonical custody and receiver.
 * Only chain RPC and relay HTTP use offline stand-ins. SQLite and wallet Level
 * stores close/reopen; the injected failure is the actual host linkage boundary.
 */
import {
  fixture, roots, mailboxes, mockBalances, mockFunded, offlineChain,
  type Fixture, type InboxRecord,
} from '@frank/wallet/chain/canonical-two-wallets.testutil';
import { getBytes } from 'ethers';
import { join } from 'node:path';
import { toHex } from '@frank/codec';
import { installCanonicalDirectory } from '@frank/wallet/chain/evm-chain';
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle';
import { EvmNativeOperationJournal } from '@frank/wallet/storage/evm-native-operation-journal';
import { LevelOutgoingMessageStore } from '@frank/wallet/storage/outgoing-message-store';
import { freezeCanonicalRequest, restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { JournaledInboundSend } from '../src/relay/journaled-inbound-send';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';

jest.mock('@frank/wallet/evm-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule());
jest.mock('@frank/wallet/evm-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule());
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule());

const SENDER = 'carol@mail.example';
const CONVERSATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('mail journal to canonical wallet and receiver across interrupted linkage', () => {
  jest.setTimeout(60_000);
  let f: Fixture;
  let wallet: EvmChainWalletHandle;
  let ledger: CreditLedger;
  let journal: MailJournal;
  let opened: jest.SpyInstance;
  let signed: jest.SpyInstance;
  let externalFetch: jest.SpyInstance;

  function openHost() {
    ledger = new CreditLedger(join(f.root, 'mail.sqlite3'), new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: f.chain.chainIdentifier,
      gatewayAccount: wallet.identity.address.raw.toLowerCase(),
      gatewayDomain: 'gw.example',
    });
    return new JournaledInboundSend({ chain: f.chain, wallet, ledger, journal });
  }
  async function sentStore(): Promise<LevelOutgoingMessageStore> {
    const address = (await wallet.getReceiveAddress()).raw.toLowerCase();
    const index = opened.mock.calls.map(call => String(call[0]).endsWith(`-evm-${address}`)).lastIndexOf(true);
    expect(index).toBeGreaterThanOrEqual(0);
    return opened.mock.results[index].value;
  }

  beforeEach(async () => {
    offlineChain.reset();
    mockBalances.clear();
    mockFunded.length = 0;
    mailboxes.clear();
    externalFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external network request'));
    opened = jest.spyOn(LevelOutgoingMessageStore, 'open');
    signed = jest.spyOn(EvmNativeOperationJournal.prototype, 'prepare');
    f = await fixture();
    wallet = f.alice;
  });
  afterEach(async () => {
    ledger?.sqlite?.close();
    await wallet?.close();
    await f?.close();
    jest.restoreAllMocks();
  });

  it.each([['paid', 1000n], ['free', 0n]] as const)('%s: reopens one debited slot and delivers the original encrypted email', async (_kind, stampValue) => {
    const directory = await f.directoryFor('gateway', wallet, f.bob);
    installCanonicalDirectory(wallet, directory);
    installCanonicalDirectory(f.bob, await f.directoryFor('recipient', f.bob, wallet));
    const inbox: InboxRecord[] = [];
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), inbox);
    f.setMailbox(inbox);
    let host = openHost();
    const recipient = f.bob.identity.address.raw.toLowerCase();
    journal.issueMailbox({ localPart: 'alice', scopeAccount: recipient, conversationId: CONVERSATION });
    ledger.addCredits(SENDER, 2, 'synthetic-purchase', 'test');
    const raw = Buffer.from(`From: Carol <${SENDER}>\r\nTo: alice@gw.example\r\nMessage-ID: <original-mail@mail.example>\r\nSubject: Original email\r\n\r\nOriginal body.`);
    const verified = { email: parseRawRfc822(raw), verifiedTransportId: 'synthetic-authenticated-ingress', authenticatedSenderEmail: SENDER };
    const admission = host.admit(verified, recipient, stampValue, CONVERSATION, 'alice');
    expect(admission.kind).toBe('queued');
    if (admission.kind !== 'queued') throw new Error('Expected queued admission');
    const slot = admission.slot;
    expect(ledger.getBalance(SENDER)).toBe(1);
    expect(host.admit(verified, recipient, stampValue, CONVERSATION, 'alice')).toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: slot.slotId, frankMessageId: slot.frankMessageId } });
    const link = jest.spyOn(journal, 'linkFrankSend').mockImplementation(() => { throw new Error('host link interrupted before commit'); });
    await expect(host.resume(slot.slotId)).rejects.toThrow('host link interrupted before commit');
    expect(link).toHaveBeenCalledTimes(2); // barrier, then the host's catch/lookup repair
    expect(journal.findFrankSend(slot.slotId)).toMatchObject({ state: 'sending' });
    expect(journal.findFrankSend(slot.slotId)?.payloadDigest).toBeFalsy();
    expect(f.requests).toHaveLength(0);
    const known = await f.chain.directMessages.attemptOf!({ wallet, messageId: slot.frankMessageId });
    expect(known).toEqual({ payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/), paid: stampValue > 0n });
    const store = await sentStore();
    const compactId = slot.frankMessageId.replace(/-/g, '');
    const paid = store.get(`frank-dm:${compactId}`);
    const free = store.unpaid(compactId);
    const original = free ? freezeCanonicalRequest({ delivery: getBytes(`0x${free.delivery}`), context: getBytes(`0x${free.context}`), transactions: [] }, free.boundary)
      : restoreCanonicalRequest({ body: getBytes(`0x${paid!.request!.body}`), contentType: paid!.request!.contentType });
    expect(original.body.length).toBeGreaterThan(0);
    expect((paid ?? free)?.exposurePending).toBe(true);
    const operationId = paid?.transactionSetOperationId;
    const nativeBytes = operationId ? wallet.transactionSetPreparer!.getOperation(operationId)!.members.map(member => member.signed!.rawTransaction) : [];
    if (stampValue > 0n) {
      expect(paid?.payments.length).toBeGreaterThan(0);
      expect(paid?.otherTransactions.length).toBeGreaterThan(0);
      expect(nativeBytes.length).toBeGreaterThan(1);
      expect(nativeBytes.every(bytes => bytes.startsWith('0x') && bytes.length > 2)).toBe(true);
    } else {
      expect(paid).toBeUndefined();
      expect(signed).not.toHaveBeenCalled();
      expect(offlineChain.walletBroadcasts).toHaveLength(0);
    }
    const prepareCount = signed.mock.calls.length;
    link.mockRestore();
    ledger.sqlite!.close();
    await wallet.close();
    wallet = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle;
    installCanonicalDirectory(wallet, directory);
    host = openHost();
    expect(await f.chain.directMessages.attemptOf!({ wallet, messageId: slot.frankMessageId })).toEqual(known);
    expect(journal.issuedMailbox('alice')).toMatchObject({ conversationId: CONVERSATION, scopeAccount: recipient });
    expect(journal.findFrankSend(slot.slotId)).toMatchObject({ frankMessageId: slot.frankMessageId, state: 'sending' });
    expect(ledger.getBalance(SENDER)).toBe(1);
    f.setPhase('retained');
    // The mail host reports paid retention as pending; the canonical free send
    // surfaces its non-delivery error. Both leave the same slot recoverable.
    await expect(host.recover()).resolves.toMatchObject({
      attempted: 1, delivered: 0, pending: stampValue > 0n ? 1 : 0, held: 0,
      errors: stampValue > 0n ? [] : [{ slotId: slot.slotId, kind: 'UnpaidDirectMessageNotDeliveredError' }],
    });
    expect(journal.findFrankSend(slot.slotId)).toMatchObject({ state: 'linked', payloadDigest: known!.payloadDigest });
    expect(inbox).toHaveLength(0);
    f.setPhase('delivered');
    await expect(host.recover()).resolves.toMatchObject({ attempted: 1, delivered: 1, pending: 0, held: 0, errors: [] });
    expect(journal.findFrankSend(slot.slotId)).toMatchObject({ state: 'delivered', payloadDigest: known!.payloadDigest });
    expect(f.requests.length).toBeGreaterThan(0);
    for (const request of f.requests) {
      expect(toHex(request.body)).toBe(toHex(original.body));
      expect(request.contentType).toBe(original.contentType);
    }
    expect(signed.mock.calls.length).toBe(prepareCount);
    if (operationId) expect(wallet.transactionSetPreparer!.getOperation(operationId)!.members.map(member => member.signed!.rawTransaction)).toEqual(nativeBytes);
    else expect(offlineChain.walletBroadcasts).toHaveLength(0);
    const received = await f.chain.directMessages.fetchSince({ wallet: f.bob, sinceMs: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ messageId: slot.frankMessageId, conversationId: CONVERSATION, payloadDigest: known!.payloadDigest,
      items: [{ type: 'email', from: { address: SENDER }, to: [{ address: 'alice@gw.example' }], subject: 'Original email', textBody: 'Original body.' }] });
    const requestCount = f.requests.length;
    await expect(host.recover()).resolves.toMatchObject({ attempted: 0, errors: [] });
    await expect(host.resume(slot.slotId)).resolves.toBe('delivered');
    expect(f.requests).toHaveLength(requestCount);
    expect(ledger.getBalance(SENDER)).toBe(1);
    expect(externalFetch).not.toHaveBeenCalled();
  });
});
