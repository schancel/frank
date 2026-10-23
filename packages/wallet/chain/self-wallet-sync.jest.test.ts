/**
 * A wallet's sync note to itself, across the real canonical path, and what a native send does
 * (and does not) send.
 *
 * Two handles of the SAME account stand for two devices: separate storage, one identity, one relay
 * mailbox. A `wallet-sync` note addressed to the account's own mailbox is read by device two and
 * handed to the wallet sync boundary; from anyone else it is unsupported. A note to oneself is
 * free: it carries no stamp. After a native transfer the wallet sends one itself. One process may hold an
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
import { restoreCanonicalRequest, type CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import { encodePluginMessageItem, parseFrame, toHex } from '@frank/codec'
import {
  Transaction,
  type TransactionReceipt,
  type TransactionResponse,
} from 'ethers'

import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/cashweb/message-items/registry'
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
  roots,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { SELF_NOTE_RETRY_MS, createEvmChain, installCanonicalDirectory } from './evm-chain'
import type { EvmChainConfig } from './evm-chain-config'
import { EvmInputAdmissionError } from '../evm-input-admission'
import { SubAccountSpendRefusedError } from '../evm-account-pool'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
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
  let routeByRecipient = false

  /** A directory in which the wallet can also find itself, as a relay answers for any key. */
  async function selfAware(f: Fixture) {
    const base = await f.directoryFor('alice', f.alice, f.bob)
    const subject = subjectOf(f.alice)
    const address = f.alice.identity.address.raw.toLowerCase()
    return {
      ...base,
      fetch: async (url: string, init: Parameters<CanonicalFetch>[1]) => {
        if (routeByRecipient && f === one) {
          const request = restoreCanonicalRequest({
            body: new Uint8Array(init.body!), contentType: init.headers['Content-Type'],
          })
          const recipient = request.identity.recipient
          expect([f.alice.identity.address.raw.toLowerCase(), f.bob.identity.address.raw.toLowerCase()]).toContain(recipient)
          f.setMailbox(recipient === f.alice.identity.address.raw.toLowerCase() ? mailbox : bobMailbox)
        }
        return base.fetch!(url, init)
      },
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
    routeByRecipient = false
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
    onForeignWalletSync?: (item: WalletSyncItem) => Promise<void>,
  ) => {
    const passed: [number, string][] = []
    const held: number[] = []
    const messages = await f.chain.directMessages.fetchSince({
      wallet,
      sinceMs,
      onQuarantinedTimestamp: (time, digest) => passed.push([time, digest]),
      onIncompleteTimestamp: time => held.push(time),
      onForeignWalletSync,
    })
    return { messages, passed, held }
  }

  it('travels to the same account on another device and is applied there once, never shown as a message', async () => {
    one.setMailbox(mailbox)
    const sent = await one.chain.directMessages.send({
      wallet: one.alice,
      recipient: one.alice.identity.address,
      items: [note()],
      stampValue: 0n,
    })
    one.setMailbox(undefined)
    expect(mailbox).toHaveLength(1)
    // What the note costs: nothing. No stamp, no payment, no funded sender account.
    expect(sent.stampValueWei).toBe(0n)
    expect(sent.stampPayments).toEqual([])
    expect(mockFunded).toHaveLength(0)

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

  it('delivers a Sepolia spend through the primary mailbox to the other device’s Sepolia owner', async () => {
    const config: EvmChainConfig = {
      networkId: 'ethereum-sepolia',
      rpcChain: 'ethereum-sepolia',
      chainIdentifier: 'ethereum-sepolia',
      chainId: 11155111,
      networkTag: 'SEPO',
      relayBaseUrl: 'http://127.0.0.1:1',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 1,
      nativeInclusionWaitMs: 0,
      walletStorageLocation: false,
      emitWalletSync: (item, record, messageId) => one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.alice.identity.address,
        items: record ? [item, record] : [item],
        stampValue: 0n,
        messageId,
      }).then(() => undefined),
    }
    const sendingChain = createEvmChain(config)
    const sender = await sendingChain.createWallet(roots(0)) as EvmChainWalletHandle
    try {
      const [source] = sender.pool.ensureSize(1)
      await sender.pool.flush()
      mockBalances.set(source.address.toLowerCase(), 10n ** 17n)
      minesNativeTransfers(sender)
      one.setMailbox(mailbox)
      const sent = await sendingChain.nativeTransfers.send({
        wallet: sender,
        recipient: { raw: one.bob.identity.address.raw },
        value: 1_000n,
      })
      await sender.reobserveNativeOperations!()
      await sender.flushNativeSync!()
      expect(mailbox).toHaveLength(1)
      expect(sender.getNativeOperations!()[0]!.members[0]!.signed!.transactionHash).toBe(sent.txHash)
      one.setMailbox(undefined)
      await sender.close()
      const other = await otherDevice()
      const receivingChain = createEvmChain({ ...config, emitWalletSync: async () => undefined })
      const target = await receivingChain.createWallet(roots(0)) as EvmChainWalletHandle
      try {
        const [counterpart] = target.pool.ensureSize(1)
        expect(counterpart.address.toLowerCase()).toBe(source.address.toLowerCase())
        await expect(read(other, other.alice, 0, async () => {
          throw new Error('secondary owner temporarily unavailable')
        })).rejects.toThrow('secondary owner temporarily unavailable')
        expect(applied).not.toHaveBeenCalled()
        const readResult = await read(other, other.alice, 0, item =>
          syncDispatch.applyWalletSyncItem(target, item).then(() => undefined),
        )
        expect(readResult.messages).toEqual([])
        expect(readResult.held).toEqual([])
        expect(applied).toHaveBeenCalledWith(target, expect.objectContaining({
          chainIdentifier: 'ethereum-sepolia', txHash: sent.txHash,
        }))
        expect(target.pool.getRecord(counterpart.index)?.status).not.toBe('available')
      } finally {
        await target.close()
      }
    } finally {
      await sender.close()
    }
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
        stampValue: 0n,
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
  // transfer included. Afterwards the wallet tells the account's other devices with a free note
  // to itself. The send does not wait for that note and never fails for it.
  describe('after a native send', () => {
    const send = (f: Fixture) =>
      f.chain.nativeTransfers.sendLegacy!({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        value: 1_000n,
      })
    /** What the app's Wallet and Send pages read (`inspectNativeTransferOperations`). */
    const status = () => {
      const [row, ...more] = one.alice.getNativeOperations!().filter(
        operation => operation.transactionSetStages?.some(stage => stage.legacy),
      )
      expect(more).toEqual([])
      return {
        row,
        ...summarizeEvmNativeOperation(
          row,
          one.alice.nativeOperationSyncFailed!(row.operationId),
        ),
      }
    }
    /** The note is sent after the send has resolved: wait for what it leaves behind. */
    const until = async (done: () => boolean) => {
      for (let waited = 0; !done() && waited < 10_000; waited += 10)
        await new Promise(resolve => setTimeout(resolve, 10))
      expect(done()).toBe(true)
    }
    const nothingPaid = async () => {
      expect(mockFunded).toHaveLength(0)
      expect(providerBroadcasts).toHaveLength(status().row.members.length)
      expect(
        await one.chain.directMessages.unattributedAttempts({
          wallet: one.alice,
          knownDigests: [],
        }),
      ).toEqual([])
    }

    it('free notes for every signed movement reach the relay and the other device applies them once', async () => {
      minesNativeTransfers(one.alice)
      one.setMailbox(mailbox)
      const sent = await send(one)
      expect(status().payment).toBe('included')
      await until(() => status().sharing === 'shared')
      const { row } = status()
      const payments = row.members.filter(member => member.transactionSet?.role === 'payment')
      expect(payments).toHaveLength(1)
      expect(sent.txHash).toBe(payments[0].signed!.transactionHash)
      expect(row.members.some(member => member.transactionSet?.role === 'change')).toBe(true)
      expect(row.members.every(member => member.observation.state === 'included-success')).toBe(true)
      // One free self-note per original signed member, including every owned change movement.
      expect(one.requests).toHaveLength(row.members.length)
      expect(mailbox).toHaveLength(row.members.length)
      for (const encoded of one.requests) {
        const request = restoreCanonicalRequest(encoded)
        expect(request.parts.transactions).toEqual([])
        expect(request.identity.recipient).toBe(
          one.alice.identity.address.raw.toLowerCase(),
        )
        const delivery = parseFrame(request.parts.delivery)
        if (delivery.kind !== 'parsed' || delivery.typed?.type !== 1)
          throw new Error('not a delivery')
        expect(delivery.schemaVersion).toBe(2)
        expect(delivery.typed.payments).toEqual([])
      }
      await nothingPaid()
      // This device recorded its own spend in the send; the note is for the others.
      expect(applied).not.toHaveBeenCalled()
      // Asking again sends nothing more.
      await one.alice.resumeLegacySend!(row.operationId)
      await one.alice.resumeNativeOperation!(row.operationId)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(one.requests).toHaveLength(row.members.length)

      one.setMailbox(undefined)
      const other = await otherDevice()
      const first = await read(other, other.alice)
      expect(first.messages).toEqual([])
      expect(applied).toHaveBeenCalledTimes(row.members.length)
      expect(applied.mock.calls.every(([wallet]) => wallet === other.alice)).toBe(true)
      expect(applied.mock.calls.map(([, item]) => ({
        type: item.type, chainIdentifier: item.chainIdentifier, txHash: item.txHash, rawTx: item.rawTx,
      }))).toEqual(row.members.map(member => ({
        type: 'wallet-sync', chainIdentifier: 'monad-testnet',
        txHash: member.signed!.transactionHash, rawTx: member.signed!.rawTransaction,
      })))
      // Applied, not merely passed: the other device now has the spend on record.
      for (const result of applied.mock.results) await expect(result.value).resolves.toBeDefined()
      expect(first.held).toEqual([])
      expect(first.passed).toEqual(mailbox.map(record => [record.timestampMs, expect.any(String)]))
      // Reading it again applies nothing more.
      await read(other, other.alice)
      expect(applied).toHaveBeenCalledTimes(row.members.length)
    })

    it('a wallet whose only money is at its identity address sends it natively', async () => {
      minesNativeTransfers(one.alice)
      const main = (await one.alice.getReceiveAddress()).raw.toLowerCase()
      const identity = one.alice.identity.address.raw.toLowerCase()
      mockBalances.set(main, 0n)
      mockBalances.set(identity, 10n ** 17n)
      const sent = await send(one)
      expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      const [row] = one.alice.getNativeOperations!()
      expect(summarizeEvmNativeOperation(row).payment).toBe('included')
      expect(row.members.length).toBeGreaterThan(1)
      expect(row.members.every(member => Transaction.from(member.signed!.rawTransaction).from!.toLowerCase() === identity)).toBe(true)
      expect(row.members.filter(member => member.transactionSet?.role === 'payment')).toHaveLength(1)
      expect(row.members.every(member => member.observation.state === 'included-success')).toBe(true)
      expect(mockBalances.get(main)).toBe(0n)
    })

    it('resolves with the relay down and a paid chat message unresolved; the note is sent on a later flush, and neither holds the other', async () => {
      minesNativeTransfers(one.alice)
      // Route by the signed request recipient, including self-notes emitted during recovery.
      routeByRecipient = true
      // A chat message whose delivery is not known, paid from a funded single-use account. (One
      // paid from the main account holds that account until the chain shows its payment, and a
      // native send from it waits for that.)
      const [stampAccount] = one.alice.pool.ensureSize(1)
      await one.alice.pool.flush()
      mockBalances.set(stampAccount.address.toLowerCase(), STAMP + 63_000n)
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
      const [chatOperation] = one.alice.getNativeOperations!()
      expect(chatOperation).toBeDefined()
      const chatBytes = chatOperation.members.map(member => member.signed!.rawTransaction)
      const funded = mockFunded.length
      // Relay still down: the send resolves on inclusion, and says the note did not get through.
      const sent = await send(one)
      expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(status().payment).toBe('included')
      expect(status().row.operationId).not.toBe(chatOperation.operationId)
      expect(one.alice.getNativeOperations!().find(row => row.operationId === chatOperation.operationId)!.members.map(member => member.signed!.rawTransaction)).toEqual(chatBytes)
      await until(() => status().sharing === 'failed')
      expect(status().payment).toBe('included')
      expect(mockFunded).toHaveLength(funded)
      expect(mailbox).toHaveLength(0)

      // The relay is back. A later flush sends the note; the unresolved chat message is not
      // re-sent, finished or touched by it.
      one.setPhase('delivered')
      one.setMailbox(mailbox)
      await one.alice.resumeLegacySend!(status().row.operationId)
      await until(() => status().sharing === 'shared')
      expect(mailbox).toHaveLength(status().row.members.length)
      expect(bobMailbox).toHaveLength(0)
      expect(mockFunded).toHaveLength(funded)
      const noted = parseFrame(mailbox[0].delivery)
      expect(noted.kind === 'parsed' && noted.typed?.type === 1 && noted.typed.payments).toEqual([])

      // The unresolved chat message is delivered as it was, and the next one goes out.
      one.setMailbox(bobMailbox)
      await one.chain.directMessages.send({
        wallet: one.alice,
        recipient: one.bob.identity.address,
        items: [{ type: 'text', text: 'again' }],
        stampValue: STAMP,
      })
      // Recovery of the older message may complete independently during the new send.
      expect(bobMailbox.length).toBeGreaterThanOrEqual(1)
      expect(bobMailbox.length).toBeLessThanOrEqual(2)
      await one.chain.directMessages.reconcileAttempts({
        wallet: one.alice,
        payloadDigests: [],
      })
      expect(bobMailbox).toHaveLength(2)
      expect(new Set(bobMailbox.map(record => record.submissionIdentity)).size).toBe(2)
      for (const record of bobMailbox) {
        const request = one.requests.map(restoreCanonicalRequest).find(request =>
          request.identity.submission_identity === record.submissionIdentity)!
        expect(request.identity.recipient).toBe(one.bob.identity.address.raw.toLowerCase())
        expect(request.parts.transactions.length).toBeGreaterThan(0)
      }
      await expect(one.alice.flushNativeSync!()).resolves.toEqual([])
      const members = one.alice.getNativeOperations!().flatMap(row => row.members)
        .filter(member => member.observation.state === 'included-success')
      expect(members.every(member => member.syncApplied)).toBe(true)
      expect(mailbox).toHaveLength(members.length)
      const other = await otherDevice()
      one.setMailbox(undefined)
      const first = await read(other, other.alice)
      expect(first.held).toEqual([])
      expect(first.messages).toEqual([])
      expect(applied).toHaveBeenCalledTimes(members.length)
      expect(applied.mock.calls.map(([, item]) => item.rawTx).sort())
        .toEqual(members.map(member => member.signed!.rawTransaction).sort())
      expect(applied.mock.calls.map(([, item]) => item.txHash)).toContain(sent.txHash)
      for (const result of applied.mock.results) await expect(result.value).resolves.toBeDefined()
      await read(other, other.alice)
      expect(applied).toHaveBeenCalledTimes(members.length)
    })
  })
})
