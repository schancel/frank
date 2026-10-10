/**
 * A wallet's sync note to itself, across the real canonical path, and what a native send does
 * (and does not) send.
 *
 * Two handles of the SAME account stand for two devices: separate storage, one identity, one relay
 * mailbox. A `wallet-sync` note addressed to the account's own mailbox is read by device two and
 * handed to the wallet sync boundary; from anyone else it is unsupported. The wallet itself sends
 * no such note after a native transfer (a note is a paid message). One process may hold an
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
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { SELF_NOTE_RETRY_MS, installCanonicalDirectory } from './monad-chain'
import { EvmInputAdmissionError } from '../evm-input-admission'
import { SubAccountSpendRefusedError } from '../monad-account-pool'

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

  describe('a received note that cannot be applied', () => {
    /** One note in the account's mailbox, and the account opened on the other device. */
    async function delivered() {
      one.setMailbox(mailbox)
      const sent = await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.alice.identity.address,
        items: [note()],
      })
      one.setMailbox(undefined)
      const other = await otherDevice()
      return { other, row: [mailbox[0].timestampMs, sent.payloadDigest] }
    }
    let warn: jest.SpyInstance
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    const warnings = () =>
      warn.mock.calls.filter(([text]) => String(text).includes('[wallet-sync]'))

    it.each([
      [
        'another chain',
        () =>
          new syncDispatch.WalletSyncItemRejectedError(
            'chain-mismatch',
            'monad-testnet',
            'ethereum-sepolia',
          ),
      ],
      [
        'a row of which only its terminal checkpoint remains',
        () =>
          new SubAccountSpendRefusedError(
            'held',
            0,
            'only a compacted terminal checkpoint remains',
          ),
      ],
      [
        'a row that already carries another spend',
        () =>
          new SubAccountSpendRefusedError(
            'held',
            0,
            'row is spent with another spend checkpoint',
          ),
      ],
      [
        'a transaction that does not agree with the note',
        () => new SubAccountSpendRefusedError('inconsistent-item', 0, 'x'),
      ],
      [
        'a transaction that is not this wallet\'s to record',
        () => new EvmInputAdmissionError('invalid-provenance'),
      ],
    ])(
      'refused for good (%s): passed at once with one warning, and not tried again',
      async (_why, refusal) => {
        const { other, row } = await delivered()
        applied.mockRejectedValue(refusal())
        for (let pass = 0; pass < 3; pass++) {
          const result = await read(other, other.alice)
          expect(result.messages).toEqual([])
          expect(result.held).toEqual([])
          expect(result.passed).toEqual([row])
        }
        expect(applied).toHaveBeenCalledTimes(1)
        expect(warnings()).toHaveLength(1)
      },
    )

    it('held for now: kept in the replay window and tried again, applied when it can be', async () => {
      const { other, row } = await delivered()
      applied.mockRejectedValueOnce(
        new SubAccountSpendRefusedError('held', 0, 'row is in-use'),
      )
      applied.mockRejectedValueOnce(
        new EvmInputAdmissionError('conflicting-authorization'),
      )
      for (let pass = 0; pass < 2; pass++) {
        const waiting = await read(other, other.alice)
        expect(waiting.messages).toEqual([])
        expect(waiting.passed).toEqual([])
        expect(waiting.held).toEqual([row[0]])
      }
      const done = await read(other, other.alice)
      expect(done.held).toEqual([])
      expect(done.passed).toEqual([row])
      expect(applied).toHaveBeenCalledTimes(3)
      expect(warnings()).toHaveLength(0)
    })

    it('still failing after the retry window: passed, with one warning, so the cursor is not held for good', async () => {
      const { other, row } = await delivered()
      applied.mockRejectedValue(
        new SubAccountSpendRefusedError('held', 0, 'row is in-use'),
      )
      const started = Date.now()
      const now = jest.spyOn(Date, 'now').mockReturnValue(started)
      expect((await read(other, other.alice)).held).toEqual([row[0]])
      now.mockReturnValue(started + SELF_NOTE_RETRY_MS - 1)
      expect((await read(other, other.alice)).held).toEqual([row[0]])
      expect(warnings()).toHaveLength(0)
      now.mockReturnValue(started + SELF_NOTE_RETRY_MS)
      for (let pass = 0; pass < 2; pass++) {
        const result = await read(other, other.alice)
        expect(result.held).toEqual([])
        expect(result.passed).toEqual([row])
      }
      expect(applied).toHaveBeenCalledTimes(3)
      expect(warnings()).toHaveLength(1)
    })
  })

  // The app's Send page sends through `nativeTransfers.sendLegacy`, which waits to see the
  // transfer included. The wallet sends no note afterwards: a note is a paid message, it would
  // pay a stamp to the wallet's own stamp key that nothing spends, and it would wait behind (and
  // hold) the one-pending-message gate.
  describe('after a native send', () => {
    const send = (f: Fixture) =>
      f.chain.nativeTransfers.sendLegacy!({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        value: 1_000n,
      })
    const nothingWasSent = async () => {
      const [row, ...more] = one.alice.getNativeOperations!()
      expect(more).toEqual([])
      // What the app's Wallet and Send pages read (`inspectNativeTransferOperations`).
      expect(summarizeEvmNativeOperation(row)).toMatchObject({
        payment: 'included',
        syncCallbackComplete: false,
      })
      // No paid message: nothing reached the relay, no sender account was funded, no stamp was
      // paid to the wallet's own key, and the message journal holds no attempt.
      expect(one.requests).toHaveLength(0)
      expect(mailbox).toHaveLength(0)
      expect(mockFunded).toHaveLength(0)
      expect(providerBroadcasts).toHaveLength(1)
      expect(
        await one.chain.directMessages.unattributedAttempts({
          wallet: one.alice,
          knownDigests: [],
        }),
      ).toEqual([])
      expect(applied).not.toHaveBeenCalled()
      return row
    }

    it('the send resolves once the transfer is included, and no paid message is created', async () => {
      minesNativeTransfers(one.alice)
      const messages = jest.spyOn(one.chain.directMessages, 'send')
      one.setMailbox(mailbox)
      const sent = await send(one)
      const row = await nothingWasSent()
      expect(sent.txHash).toBe(
        row.members[row.members.length - 1].signed!.transactionHash,
      )
      expect(messages).not.toHaveBeenCalled()
      // Asking again changes nothing and still sends nothing.
      await one.alice.resumeLegacySend!(row.operationId)
      await nothingWasSent()
      expect(messages).not.toHaveBeenCalled()
    })

    it('resolves while the relay is unreachable and while a chat message is still unresolved, and does not hold the next message', async () => {
      minesNativeTransfers(one.alice)
      // A chat message whose delivery is not known: a live attempt in the message journal.
      one.setMailbox(bobMailbox)
      one.setPhase('fail')
      const chat = await one.chain.directMessages
        .send({
          wallet: one.alice,
          recipient: one.bob.identity.address,
          items: [{ type: 'text', text: 'hello' }],
          stampValue: STAMP,
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(chat).toBeInstanceOf(Error)
      const funded = mockFunded.length
      const sent = await send(one)
      expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      const [row] = one.alice.getNativeOperations!()
      expect(summarizeEvmNativeOperation(row).payment).toBe('included')
      expect(mockFunded).toHaveLength(funded)
      // The unresolved chat message is delivered as it was; the send added nothing to wait for.
      one.setPhase('delivered')
      await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [{ type: 'text', text: 'again' }],
        stampValue: STAMP,
      })
      expect(bobMailbox).toHaveLength(2)
      expect(mailbox).toHaveLength(0)
    })
  })
})
