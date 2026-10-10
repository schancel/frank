/**
 * A received coin's note to self: how the account's other devices, and a wallet restored from the
 * seed, find money a message brought without that message.
 *
 * Two handles of the SAME account stand for two devices (separate storage, one identity, one relay
 * mailbox), as in `self-wallet-sync.jest.test.ts`. UNIT tests: real typed custody, real coin
 * stores, real sealing and opening, the real item codec. The chain RPC and the relay's HTTP
 * surface are the repo's stand-ins (`canonical-two-wallets.testutil.ts`), so nothing here says the
 * coin can be SPENT, or anything about a real relay: that the restored key really signs for the
 * money is shown against a real EVM node in `received-payments.anvil.integration.ts`.
 */
import * as syncDispatch from '@frank/cashweb/sync-dispatcher'
import type {
  ReceivedCoinItem,
  StealthItem,
} from '@frank/cashweb/types/messages'
import { toHex } from '@frank/codec'
import { hexlify } from 'ethers'

import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { deriveEvmStealthAddress } from '../monad-stealth'
import {
  STAMP,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './monad-chain'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

const subjectOf = (wallet: EvmChainWalletHandle) =>
  toHex(wallet.identity.compressedPubKey)

describe("a received coin's note to self", () => {
  jest.setTimeout(120_000)
  let one: Fixture
  let two: Fixture | undefined
  /** The account's one relay mailbox, read by both devices. */
  let mailbox: InboxRecord[]
  let applied: jest.SpyInstance

  /** A directory in which the wallet can also find itself, as a relay answers for any key. */
  async function selfAware(f: Fixture) {
    const base = await f.directoryFor('alice', f.alice, f.bob)
    const subject = subjectOf(f.alice)
    const address = f.alice.identity.address.raw.toLowerCase()
    return {
      ...base,
      peerCurrent: async (
        wanted: { address: string } | { subject: string },
      ) =>
        ('subject' in wanted
          ? wanted.subject === subject
          : wanted.address.toLowerCase() === address)
          ? {
              subject,
              endpoint: base.homeEndpoint,
              current: await base.selfCurrent(),
            }
          : base.peerCurrent(wanted),
    }
  }
  async function device(): Promise<Fixture> {
    const f = await fixture()
    installCanonicalDirectory(f.alice, await selfAware(f))
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    // Every message of this suite is for the account under test.
    f.setMailbox(mailbox)
    return f
  }
  /** The same account opened on another device: device one is closed, its storage is not used. */
  async function otherDevice(): Promise<Fixture> {
    const subject = subjectOf(one.alice)
    const balances = new Map(mockBalances)
    await one.close()
    two = await device()
    for (const [address, value] of balances) mockBalances.set(address, value)
    expect(subjectOf(two.alice)).toBe(subject)
    return two
  }
  const read = (f: Fixture) =>
    f.chain.directMessages.fetchSince({ wallet: f.alice, sinceMs: 0 })
  /** A mailbox read, and the wallet's note pass that follows it, finished. */
  async function readAndNote(f: Fixture) {
    const messages = await read(f)
    await f.alice.noteReceivedCoins!()
    return messages
  }
  const coinsOf = (f: Fixture) => f.alice.getReceivedPayments!()
  const notesApplied = (): ReceivedCoinItem[] =>
    applied.mock.calls
      .map(([, item]) => item as ReceivedCoinItem)
      .filter(item => item.type === 'received-coin')

  beforeEach(async () => {
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    useProviderStandIns()
    mailbox = []
    one = await device()
    two = undefined
    mailboxes.set(subjectOf(one.alice), mailbox)
    applied = jest.spyOn(syncDispatch, 'applyWalletSyncItem')
  })
  afterEach(async () => {
    useProviderStandIns(false)
    jest.restoreAllMocks()
    await (two ?? one).close()
  })

  /** Bob sends alice a stamped message: the stamp is money at a one-time account of alice's. */
  async function stampedMessage(text = 'hello') {
    return one.chain.directMessages.send({
      wallet: one.bob,
      recipient: one.alice.identity.address,
      items: [{ type: 'text', text }],
      stampValue: STAMP,
    })
  }

  it('is written once per coin, free, with the derivation data and no key or message content; the host never sees it', async () => {
    const sent = await stampedMessage('the secret text')
    expect(mailbox).toHaveLength(1)
    const messages = await readAndNote(one)
    expect(messages.map(m => m.payloadDigest)).toEqual([sent.payloadDigest])
    const [coin] = coinsOf(one)
    expect(coin).toMatchObject({ origin: 'stamp', claimedAmountWei: STAMP })

    // One more row in the account's own mailbox: the note. Nothing was paid for it.
    expect(mailbox).toHaveLength(2)
    const funded = mockFunded.length
    const requests = one.requests.length

    // The note comes back on the next read. It is the wallet's, not a chat message.
    const passed: string[] = []
    const again = await one.chain.directMessages.fetchSince({
      wallet: one.alice,
      sinceMs: 0,
      onQuarantinedTimestamp: (_time, digest) => passed.push(digest),
    })
    await one.alice.noteReceivedCoins!()
    expect(again.map(m => m.payloadDigest)).toEqual([sent.payloadDigest])
    expect(passed).toHaveLength(1)
    const [note] = notesApplied()
    expect(note).toEqual({
      type: 'received-coin',
      chainIdentifier: 'monad-testnet',
      address: coin.address,
      origin: 'stamp',
      stampSharedPoint: expect.stringMatching(/^[0-9a-f]{66}$/),
      childIndex: coin.childIndex,
      claimedAmountWei: STAMP.toString(),
      transactions: [expect.stringMatching(/^[0-9a-f]+$/)],
      payloadDigest: sent.payloadDigest,
      timestamp: mailbox[0].timestampMs,
    })
    expect(JSON.stringify(note)).not.toContain('the secret text')
    // Written once: reading it back, and any number of later passes, send nothing more.
    await readAndNote(one)
    expect(mailbox).toHaveLength(2)
    expect(one.requests).toHaveLength(requests)
    expect(mockFunded).toHaveLength(funded)
    expect(coinsOf(one)).toHaveLength(1)
  })

  it('lets a second device with empty state find the coin when the message is gone, and it does not write the note again', async () => {
    await stampedMessage()
    await readAndNote(one)
    const known = coinsOf(one)
    expect(known).toHaveLength(1)
    // The message that brought the money no longer exists anywhere: only the note is left.
    mailbox.splice(0, 1)
    expect(mailbox).toHaveLength(1)

    const other = await otherDevice()
    expect(coinsOf(other)).toEqual([])
    const messages = await readAndNote(other)
    expect(messages).toEqual([])
    expect(coinsOf(other)).toEqual([
      expect.objectContaining({
        address: known[0].address,
        origin: 'stamp',
        childIndex: known[0].childIndex,
        payloadDigest: known[0].payloadDigest,
        claimedAmountWei: STAMP,
        // Not money yet: only the chain makes it so.
        status: 'pending',
        spendable: false,
      }),
    ])
    expect(mailbox).toHaveLength(1)
    expect(other.requests).toHaveLength(0)
    // Read again: the same coin, once.
    await readAndNote(other)
    expect(coinsOf(other)).toHaveLength(1)
    expect(mailbox).toHaveLength(1)
  })

  it('a wallet that reads both the message and its note keeps one coin and sends nothing', async () => {
    await stampedMessage()
    await readAndNote(one)
    expect(mailbox).toHaveLength(2)
    const other = await otherDevice()
    await readAndNote(other)
    expect(coinsOf(other)).toHaveLength(1)
    expect(mailbox).toHaveLength(2)
    expect(other.requests).toHaveLength(0)
  })

  it('carries a stealth payment the same way', async () => {
    const destination = deriveEvmStealthAddress({
      recipientSpendPubKey: one.alice.identity.compressedPubKey,
    })
    const item: StealthItem = {
      type: 'stealth',
      networkTag: 'MONT',
      keyType: 1,
      ephemeralPubKey: hexlify(destination.ephemeralPubKey).slice(2),
      transactions: ['66'.repeat(32)],
      amount: 7_000_000,
      amountWei: '7000000',
    }
    await one.alice.recordStealthPayment(item, {
      payloadDigest: 'ab'.repeat(32),
      timestampMs: 5,
    })
    await readAndNote(one)
    expect(mailbox).toHaveLength(1)

    const other = await otherDevice()
    await readAndNote(other)
    expect(coinsOf(other)).toEqual([
      expect.objectContaining({
        address: destination.stealthAddress.toLowerCase(),
        origin: 'stealth',
        ephemeralPubKey: item.ephemeralPubKey,
        payloadDigest: 'ab'.repeat(32),
        claimedAmountWei: 7_000_000n,
        status: 'pending',
      }),
    ])
  })

  it('a relay that cannot be reached leaves the coin to be noted by a later pass', async () => {
    await stampedMessage()
    one.setPhase('fail')
    await readAndNote(one)
    expect(mailbox).toHaveLength(1)
    expect(coinsOf(one)).toHaveLength(1)
    one.setPhase('delivered')
    await readAndNote(one)
    expect(mailbox).toHaveLength(2)
  })

  it('records nothing for a note whose account this wallet cannot open, and refuses another chain', async () => {
    await stampedMessage()
    await readAndNote(one)
    await read(one)
    const [note] = notesApplied()
    const other = await otherDevice()
    // The same derivation data under someone else's account: the key does not open it.
    expect(
      await syncDispatch.applyWalletSyncItem(other.alice, {
        ...note,
        address: '0x' + 'ee'.repeat(20),
      }),
    ).toEqual({})
    // Bob's wallet cannot derive alice's coin from alice's note.
    expect(await syncDispatch.applyWalletSyncItem(other.bob, note)).toEqual({})
    await expect(
      syncDispatch.applyWalletSyncItem(other.alice, {
        ...note,
        chainIdentifier: 'ethereum-sepolia',
      }),
    ).rejects.toBeInstanceOf(syncDispatch.WalletSyncItemRejectedError)
    expect(coinsOf(other)).toEqual([])
    expect(other.bob.getReceivedPayments!()).toEqual([])
    // And the real one, twice: one coin.
    for (let round = 0; round < 2; round++)
      expect(await syncDispatch.applyWalletSyncItem(other.alice, note)).toEqual(
        { recordedCoins: [note.address] },
      )
    expect(coinsOf(other)).toHaveLength(1)
  })
})
