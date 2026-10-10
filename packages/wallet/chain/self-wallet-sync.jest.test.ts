/**
 * A wallet's note to itself after a native transfer, across the real canonical path.
 *
 * Two handles of the SAME account stand for two devices: separate storage, one identity, one relay
 * mailbox. Device one sends a native transfer; the wallet writes a `wallet-sync` note to its own
 * mailbox; device two reads it and hands it to the wallet sync boundary. One process may hold an
 * account open once, so device one is closed before device two is opened. Real typed custody, real
 * journals, real sealing and opening; only the chain RPC and the relay's HTTP surface are
 * stand-ins (`canonical-two-wallets.testutil.ts`).
 */
import * as syncDispatch from '@frank/cashweb/sync-dispatcher'
import * as canonicalDm from '@frank/cashweb/relay/canonical-dm'
import type {
  MessageItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import { encodePluginMessageItem, toHex } from '@frank/codec'
import {
  Transaction,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'

import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../message-item-plugins/registry'
import * as wire from '../message-item-plugins/wire'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { isDirectMessageNotAttempted } from './active-chain'
import {
  STAMP,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  providerBroadcasts,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { EvmNativeOperationPendingError } from './evm-legacy-consolidator'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
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

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)
const subjectOf = (wallet: EvmChainWalletHandle) =>
  toHex(wallet.identity.compressedPubKey)

/** The chain as a native send sees it: a broadcast transfer is mined at once, with a receipt. */
function minesNativeTransfers(wallet: EvmChainWalletHandle) {
  const transactions = new Map<string, TransactionResponse>()
  const receipts = new Map<string, TransactionReceipt>()
  const blockHash = '0x' + '11'.repeat(32)
  jest
    .spyOn(wallet.provider, 'getTransaction')
    .mockImplementation(async hash => transactions.get(hash) ?? null)
  jest
    .spyOn(wallet.provider, 'getTransactionReceipt')
    .mockImplementation(async hash => receipts.get(hash) ?? null)
  const broadcast = wallet.provider.broadcastTransaction.bind(wallet.provider)
  jest
    .spyOn(wallet.provider, 'broadcastTransaction')
    .mockImplementation(async raw => {
      const answer = await broadcast(raw)
      const tx = Transaction.from(raw)
      transactions.set(
        tx.hash!,
        Object.assign(tx, {
          blockHash,
          blockNumber: 1,
          index: 0,
        }) as unknown as TransactionResponse,
      )
      receipts.set(tx.hash!, {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        blockHash,
        blockNumber: 1,
        index: 0,
        status: 1,
        gasPrice: 1n,
        gasUsed: 21000n,
      } as TransactionReceipt)
      return answer
    })
}

describe("a wallet's sync note to itself", () => {
  jest.setTimeout(120_000)
  let one: Fixture
  let two: Fixture | undefined
  /** The account's one relay mailbox, read by both devices. */
  let mailbox: InboxRecord[]
  let bobMailbox: InboxRecord[]
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

  beforeEach(async () => {
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    providerBroadcasts.length = 0
    useProviderStandIns()
    one = await device()
    two = undefined
    mailbox = []
    bobMailbox = []
    mailboxes.set(subjectOf(one.alice), mailbox)
    mailboxes.set(subjectOf(one.bob), bobMailbox)
    applied = jest.spyOn(syncDispatch, 'applyWalletSyncItem')
  })
  afterEach(async () => {
    useProviderStandIns(false)
    jest.restoreAllMocks()
    await (two ?? one).close()
  })

  async function device(): Promise<Fixture> {
    const f = await fixture()
    installCanonicalDirectory(f.alice, await selfAware(f))
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    return f
  }
  /** The same account opened on another device: device one is closed, its storage is not used. */
  async function otherDevice(): Promise<Fixture> {
    const subject = subjectOf(one.alice)
    const balances = new Map(mockBalances)
    await one.close()
    two = await device()
    // The chain did not change because another device was opened.
    for (const [address, value] of balances) mockBalances.set(address, value)
    expect(subjectOf(two.alice)).toBe(subject)
    return two
  }

  const note = (): WalletSyncItem => ({
    type: 'wallet-sync',
    direction: 'out',
    chainIdentifier: 'monad-testnet',
    txHash: '0x' + 'ab'.repeat(32),
    spentInputs: [{ address: '0x' + '0a'.repeat(20), nonce: 3, valueWei: '21' }],
    createdOutputs: [{ address: '0x' + '0b'.repeat(20), valueWei: '20' }],
    timestamp: 1728000000000,
  })
  const read = async (
    f: Fixture,
    wallet: EvmChainWalletHandle,
    sinceMs = 0,
  ) => {
    const passed: [number, string][] = []
    const held: number[] = []
    const messages = await f.chain.directMessages.fetchSince({
      wallet,
      sinceMs,
      onQuarantinedTimestamp: (time, digest) => passed.push([time, digest]),
      onIncompleteTimestamp: time => held.push(time),
    })
    return { messages, passed, held }
  }

  it('travels to the same account on another device and is applied there once, never shown as a message', async () => {
    one.setMailbox(mailbox)
    const sent = await one.chain.directMessages.send({
      wallet: one.alice,
      recipient: one.alice.identity.address,
      items: [note()],
    })
    one.setMailbox(undefined)
    expect(mailbox).toHaveLength(1)
    // What the note costs: the wallet's default stamp, in one payment to its own stamp key, and
    // the two single-use sender accounts the main account funds for any message.
    expect(sent.stampValueWei).toBe(STAMP)
    expect(sent.stampPayments.map(payment => payment.valueWei)).toEqual([STAMP])
    expect(mockFunded).toHaveLength(2)
    expect(new Set(mockFunded.map(move => move.from))).toEqual(
      new Set([(await one.alice.getReceiveAddress()).raw.toLowerCase()]),
    )

    const other = await otherDevice()
    const first = await read(other, other.alice)
    expect(first.messages).toEqual([])
    expect(first.held).toEqual([])
    expect(first.passed).toEqual([[mailbox[0].timestampMs, sent.payloadDigest]])
    expect(applied).toHaveBeenCalledTimes(1)
    expect(applied.mock.calls[0][0]).toBe(other.alice)
    expect(applied.mock.calls[0][1]).toEqual(note())
    await expect(applied.mock.results[0].value).resolves.toEqual({})

    // Read again from the start, as a poll whose cursor has not moved does: nothing new.
    const again = await read(other, other.alice)
    expect(again.messages).toEqual([])
    expect(again.passed).toEqual(first.passed)
    expect(applied).toHaveBeenCalledTimes(1)
  })

  it('is refused, before anything is paid, in a message to anyone else', async () => {
    one.setMailbox(bobMailbox)
    const error = await one.chain.directMessages
      .send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [note()],
        stampValue: STAMP,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(wire.MessageItemNotCarriedError)
    expect(isDirectMessageNotAttempted(error)).toBe(true)
    expect(one.requests).toHaveLength(0)
    expect(mockFunded).toHaveLength(0)
    expect(bobMailbox).toHaveLength(0)
  })

  it('from a different sender arrives unsupported and reaches no wallet state', async () => {
    // A peer running other code: its sender writes the frame this wallet's sender refuses.
    const forged = encodePluginMessageItem({
      itemType: 'wallet-sync',
      data: registry.encodeItem(note()).bytes,
    })
    const peer = jest
      .spyOn(wire, 'encodeItemFrames')
      .mockReturnValueOnce([forged, canonicalDm.directMessageText('synced')])
    one.setMailbox(mailbox)
    const sent = await one.chain.directMessages.send({
      wallet: one.bob,
      recipient: one.alice.identity.address,
      items: [{ type: 'text', text: 'placeholder' }],
      stampValue: STAMP,
    })
    one.setMailbox(undefined)
    peer.mockRestore()

    const { messages, passed, held } = await read(one, one.alice)
    expect(passed).toEqual([])
    expect(held).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0].payloadDigest).toBe(sent.payloadDigest)
    expect(messages[0].senderAddress.raw).toBe(one.bob.identity.address.raw)
    expect(messages[0].items).toEqual([
      {
        type: 'unsupported',
        reason: 'unknown-type',
        itemType: 'wallet-sync',
        frameType: 27,
        frame: toHex(forged),
      },
      { type: 'text', text: 'synced' },
    ] satisfies MessageItem[])
    expect(applied).not.toHaveBeenCalled()
  })

  // The app's Send page sends through `nativeTransfers.sendLegacy`, which waits to see the
  // transfer included and then hands the note to transport, all in the one call.
  describe('after a native send', () => {
    const send = (f: Fixture) =>
      f.chain.nativeTransfers.sendLegacy!({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        value: 1_000n,
      })
    const operation = (wallet: EvmChainWalletHandle) => {
      const rows = wallet.getNativeOperations!()
      expect(rows).toHaveLength(1)
      // What the app's Wallet and Send pages read for each operation
      // (`inspectNativeTransferOperations`).
      return { row: rows[0], shown: summarizeEvmNativeOperation(rows[0]) }
    }

    it('the note is delivered and the operation is recorded as synchronized', async () => {
      minesNativeTransfers(one.alice)
      one.setMailbox(mailbox)
      const sent = await send(one)
      one.setMailbox(undefined)
      const { row, shown } = operation(one.alice)
      expect(shown).toMatchObject({
        payment: 'included',
        finalTransactionHash: sent.txHash,
        syncCallbackComplete: true,
      })
      expect(row.members.every(member => member.syncApplied)).toBe(true)
      expect(mailbox).toHaveLength(1)
      // The wallet accounts for its own note: no host is asked about a payment with no message.
      expect(
        await one.chain.directMessages.unattributedAttempts({
          wallet: one.alice,
          knownDigests: [],
        }),
      ).toEqual([])

      // This device reads its own note back. It already recorded the spend: nothing changes.
      const pool = JSON.stringify(one.alice.pool.records())
      const own = await read(one, one.alice)
      expect(own.messages).toEqual([])
      expect(own.passed).toHaveLength(1)
      expect(applied).toHaveBeenCalledTimes(1)
      await expect(applied.mock.results[0].value).resolves.toEqual({})
      expect(JSON.stringify(one.alice.pool.records())).toBe(pool)
      expect(operation(one.alice).row).toEqual(row)

      // The account's other device gets the member's own signed transaction.
      const signed = row.members[row.members.length - 1].signed!
      const other = await otherDevice()
      applied.mockClear()
      const there = await read(other, other.alice)
      expect(there.messages).toEqual([])
      expect(applied).toHaveBeenCalledTimes(1)
      expect(applied.mock.calls[0][0]).toBe(other.alice)
      expect(applied.mock.calls[0][1]).toMatchObject({
        type: 'wallet-sync',
        direction: 'out',
        chainIdentifier: 'monad-testnet',
        txHash: signed.transactionHash,
        rawTx: signed.rawTransaction,
      })
      await expect(applied.mock.results[0].value).resolves.toEqual({})
    })

    it('a note the relay did not take leaves the transfer included, and asking again delivers the same note without paying twice', async () => {
      minesNativeTransfers(one.alice)
      one.setMailbox(mailbox)
      one.setPhase('fail')
      const failed = await send(one).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(failed).toBeInstanceOf(EvmNativeOperationPendingError)
      const before = operation(one.alice)
      expect(before.shown).toMatchObject({
        payment: 'included',
        syncCallbackComplete: false,
      })
      expect(providerBroadcasts).toHaveLength(1)
      expect(mailbox).toHaveLength(0)
      // The note was paid for and is the wallet's to deliver: its accounts are funded.
      const funded = mockFunded.length
      expect(funded).toBe(2)

      // Asked again with the relay back, twice: the transfer is not sent again, and the note is
      // the one already paid for. The same bytes go to the relay and no new account is funded.
      one.setPhase('delivered')
      for (let attempt = 0; attempt < 2; attempt++)
        await one.alice.resumeLegacySend!(before.row.operationId)
      const after = operation(one.alice)
      expect(after.shown).toMatchObject({
        payment: 'included',
        finalTransactionHash: before.shown.finalTransactionHash,
        syncCallbackComplete: true,
      })
      expect(providerBroadcasts).toHaveLength(1)
      expect(mailbox).toHaveLength(1)
      expect(mockFunded).toHaveLength(funded)
      expect(one.requests.length).toBeGreaterThan(0)
      for (const request of one.requests)
        expect(toHex(request.body)).toBe(toHex(one.requests[0].body))
      expect(
        await one.chain.directMessages.unattributedAttempts({
          wallet: one.alice,
          knownDigests: [],
        }),
      ).toEqual([])
    })
  })
})
