import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, DirectMessageReceived, WalletHandle } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { JournaledFrankMailbox } from '../src/relay/journaled-frank-mailbox';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const ACCOUNT = `0x${'9'.repeat(40)}`;
const PEER = `0x${'a'.repeat(40)}`;
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const message = (name: string, receivedTime: number): DirectMessageReceived => ({
  senderAddress: { raw: PEER },
  recipientAddress: { raw: ACCOUNT },
  items: [],
  payloadDigest: digest(name),
  stampValueWei: 0n,
  stampPayments: [],
  receivedTime,
}) as DirectMessageReceived;

describe('journaled Frank mailbox', () => {
  let dir: string;
  let file: string;
  let ledger: CreditLedger;
  let journal: MailJournal;
  let wallet: WalletHandle;
  let chain: ActiveChain;
  let inbox: DirectMessageReceived[];
  let incomplete: number | undefined;
  let quarantine: { time: number; identity: string } | undefined;
  let truncateAt: number | undefined;
  let seenSince: number[];

  const open = () => {
    ledger = new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: 'monad-testnet', gatewayAccount: ACCOUNT, gatewayDomain: 'gw.example',
    });
  };
  const close = () => ledger.sqlite!.close();
  const record = (msg: DirectMessageReceived) => {
    journal.recordFrankMessage({
      outcome: 'rejected', reason: 'no_email_item', payloadDigest: msg.payloadDigest,
      receivedTimeMs: msg.receivedTime, stampValue: '0', scopeAccount: PEER,
    });
  };
  const poller = (handle: (msg: DirectMessageReceived) => Promise<void>) =>
    new JournaledFrankMailbox({ chain, wallet, journal, handle });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cursor-'));
    file = path.join(dir, 'mail.sqlite3');
    open();
    wallet = { identity: { address: { raw: ACCOUNT } } } as WalletHandle;
    inbox = [];
    incomplete = undefined;
    quarantine = undefined;
    truncateAt = undefined;
    seenSince = [];
    chain = {
      chainIdentifier: 'monad-testnet',
      directMessages: {
        fetchSince: async ({ sinceMs, onIncompleteTimestamp, onQuarantinedTimestamp, onTruncated }) => {
          seenSince.push(sinceMs);
          if (incomplete !== undefined) onIncompleteTimestamp?.(incomplete);
          if (quarantine) onQuarantinedTimestamp?.(quarantine.time, quarantine.identity);
          if (truncateAt !== undefined) onTruncated?.(new Error('later page unavailable'));
          return inbox.filter((msg) => msg.receivedTime >= sinceMs &&
            (truncateAt === undefined || msg.receivedTime <= truncateAt));
        },
      },
    } as ActiveChain;
  });
  afterEach(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replays the inclusive timestamp after a long restart without duplicating a durable outcome', async () => {
    inbox = [message('one', 1000), message('two', 1000)];
    const first = poller(async (msg) => { record(msg); });
    expect(await first.pollOnce()).toEqual({ processed: 2, cursorMs: 1000 });
    close(); open();
    inbox.push(message('three', 1000), message('four', 86_400_000));
    const second = poller(async (msg) => { record(msg); });
    expect(await second.pollOnce()).toEqual({ processed: 4, cursorMs: 86_400_000 });
    expect(seenSince).toEqual([0, 1000]);
    for (const msg of inbox) expect(journal.findFrankInbound(msg.payloadDigest)).toBeDefined();
  });

  it('does not move the cursor when a handler returns before committing or throws', async () => {
    inbox = [message('one', 1000), message('two', 2000)];
    await expect(poller(async () => {}).pollOnce()).rejects.toThrow('durable journal');
    expect(journal.frankCursor().cursorMs).toBeUndefined();
    await expect(poller(async (msg) => { record(msg); if (msg.receivedTime === 2000) throw new Error('cut'); }).pollOnce())
      .rejects.toThrow('cut');
    expect(journal.frankCursor().cursorMs).toBeUndefined();
    close(); open();
    expect((await poller(async (msg) => { record(msg); }).pollOnce()).cursorMs).toBe(2000);
  });

  it('keeps an incomplete timestamp inclusive and durably records terminal quarantine', async () => {
    inbox = [message('one', 1000), message('two', 3000)];
    incomplete = 1500;
    quarantine = { time: 2000, identity: 'relay-submission-1' };
    expect((await poller(async (msg) => { record(msg); }).pollOnce()).cursorMs).toBe(1500);
    expect(journal.frankCursor().incompleteFloorMs).toBe(1500);
    const quarantinedDigest = digest('mailbox-quarantine:relay-submission-1');
    expect(journal.findFrankInbound(quarantinedDigest)?.disposition).toBe('quarantined');
    incomplete = undefined;
    close(); open();
    expect((await poller(async (msg) => { record(msg); }).pollOnce()).cursorMs).toBe(3000);
    expect(seenSince).toEqual([0, 1500]);
  });

  it('advances only over a complete fetched prefix when a later page is truncated', async () => {
    inbox = [message('one', 1000), message('two', 2000)];
    truncateAt = 1000;
    expect((await poller(async (msg) => { record(msg); }).pollOnce()).cursorMs).toBe(1000);
    truncateAt = undefined;
    close(); open();
    expect((await poller(async (msg) => { record(msg); }).pollOnce()).cursorMs).toBe(2000);
    expect(journal.findFrankInbound(inbox[1].payloadDigest)).toBeDefined();
  });

  it('refuses a different chain or gateway wallet before fetching', () => {
    expect(() => new JournaledFrankMailbox({ chain: { ...chain, chainIdentifier: 'ethereum-sepolia' }, wallet, journal,
      handle: async () => {} })).toThrow('chain identifiers differ');
    expect(() => new JournaledFrankMailbox({ chain, wallet: { identity: { address: { raw: PEER } } } as WalletHandle,
      journal, handle: async () => {} })).toThrow('another gateway wallet');
    expect(seenSince).toHaveLength(0);
  });
});
