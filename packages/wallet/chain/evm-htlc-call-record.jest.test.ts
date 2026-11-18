/**
 * The `htlc` contract-call record: a GenericHTLC step (lock, withdraw, refund) journaled with its
 * call, kept across a reopen, refused when malformed on write and on load, and carried exactly by
 * the account's note to itself, where a reader that is not the account, or bytes that are
 * malformed, leave it uninterpreted without losing the message. The provider is a stub at the
 * JSON-RPC seam; the same path on a real node is `swap/htlc-lock-resume.anvil.jest.test.ts`.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { Transaction, Wallet, keccak256, type Provider } from 'ethers'
import {
  TYPE_MESSAGE_CONTENT_REVISION,
  encodeFrame,
  standaloneItemBudget,
  validateFrame,
  type ChildFrame,
  type Encodable,
} from '@frank/codec'
import type {
  HtlcRecordItem,
  MessageItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import { pluginCapabilitiesNotYetAvailable } from '@frank/cashweb/message-items/registry'
import {
  EvmLegacyConsolidator,
  contractCallRecordItemOf,
  swapRecordItemOf,
} from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import {
  EvmNativeJournalError,
  EvmNativeOperationJournal,
  type EvmHtlcCallAction,
  type EvmHtlcCallRecord,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'
import {
  HTLC_NATIVE_TOKEN,
  encodeHtlcLock,
  encodeHtlcRefund,
  encodeHtlcWithdraw,
  htlcCallOf,
  htlcLockId,
} from '../swap-escrow'
import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import {
  decodeItemFrames,
  encodeItemFrames,
} from '../message-item-plugins/wire'

const main = new Wallet('0x' + '01'.padStart(64, '0'))
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'htlc-call-record-test',
}
const mainSource: EvmNativeSource = {
  kind: 'main',
  address: main.address.toLowerCase(),
}
const HTLC = '0x' + 'ab'.repeat(20)
const SWAP_ID = '5a'.repeat(32)
const terms = {
  recipient: '0x' + '22'.repeat(20),
  refundAddress: '0x' + '33'.repeat(20),
  token: HTLC_NATIVE_TOKEN,
  amount: 1_000n,
  hashLock: '0x' + '44'.repeat(32),
  expiresAt: 2_000_000_000n,
}
const LOCK_ID = htlcLockId(main.address, terms).toLowerCase()
const STEPS: Record<
  EvmHtlcCallAction,
  { call: { to: string; data: string; value: bigint } }
> = {
  lock: { call: encodeHtlcLock(HTLC, terms) },
  withdraw: { call: encodeHtlcWithdraw(HTLC, LOCK_ID, '0x' + '55'.repeat(32)) },
  refund: { call: encodeHtlcRefund(HTLC, LOCK_ID) },
}
const recordOf = (action: EvmHtlcCallAction): EvmHtlcCallRecord => ({
  kind: 'htlc',
  action,
  swapId: SWAP_ID,
  lockId: LOCK_ID,
})

/** A node that includes every transaction it is handed at once. */
function node() {
  const nonces = new Map<string, number>()
  const balances = new Map([[main.address.toLowerCase(), 10n ** 18n]])
  const transactions = new Map<string, object>()
  const receipts = new Map<string, object>()
  const raws: string[] = []
  const blockHash = '0x' + 'ab'.repeat(32)
  const provider = {
    getBlock: async () => ({ hash: blockHash, number: 1 }),
    getBalance: async (address: string) =>
      balances.get(address.toLowerCase()) ?? 0n,
    getTransactionCount: async (address: string) =>
      nonces.get(address.toLowerCase()) ?? 0,
    getFeeData: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 2n,
    }),
    estimateGas: async () => 100_000n,
    getTransaction: async (hash: string) => transactions.get(hash) ?? null,
    getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw)
      const tx = Transaction.from(raw)
      const from = tx.from!.toLowerCase()
      if (!receipts.has(tx.hash!)) {
        nonces.set(from, tx.nonce + 1)
        balances.set(
          from,
          balances.get(from)! - tx.gasLimit * tx.maxFeePerGas! - tx.value,
        )
        transactions.set(
          tx.hash!,
          Object.assign(tx, { blockHash, blockNumber: 1, index: 0 }),
        )
        receipts.set(tx.hash!, {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          status: 1,
          blockHash,
          blockNumber: 1,
          index: 0,
          gasUsed: tx.gasLimit,
          gasPrice: tx.maxFeePerGas,
          logs: [],
        })
      }
      return { hash: keccak256(raw) }
    },
  }
  return { provider: provider as unknown as Provider, raws }
}

/** The child frames a reader's validation opens for these item frames. */
function children(frames: Uint8Array[]): ChildFrame[] {
  const revision = validateFrame(
    encodeFrame(
      {
        typeId: TYPE_MESSAGE_CONTENT_REVISION,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (
    revision.kind !== 'parsed' ||
    revision.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('expected a revision')
  return revision.typed.items
}
const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)

describe('the htlc contract-call record', () => {
  let location: string
  let journal: EvmNativeOperationJournal
  const open = async () => {
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-htlc-record-'))
    await open()
  })
  afterEach(async () => {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  })
  const owner = (
    state: ReturnType<typeof node>,
    onSyncTransaction?: (
      item: WalletSyncItem,
      record?: MessageItem,
    ) => Promise<void>,
    htlcContract: (() => string) | null = () => HTLC,
  ) => {
    const sign = jest.fn(async (_source: EvmNativeSource, raw: string) =>
      main.signTransaction(Transaction.from(raw)),
    )
    return {
      sign,
      executor: new EvmLegacyConsolidator({
        journal,
        provider: state.provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        mainSource,
        ownedSource: address =>
          address.toLowerCase() === mainSource.address ? mainSource : undefined,
        sign,
        ...(htlcContract ? { htlcContract } : {}),
        ...(onSyncTransaction ? { onSyncTransaction } : {}),
      }),
    }
  }

  it('names the step and the lock its calldata is', () => {
    expect(htlcCallOf(main.address, STEPS.lock.call.data)).toEqual({
      action: 'lock',
      lockId: LOCK_ID,
    })
    expect(htlcCallOf(main.address, STEPS.withdraw.call.data)).toEqual({
      action: 'withdraw',
      lockId: LOCK_ID,
    })
    expect(htlcCallOf(main.address, STEPS.refund.call.data)).toEqual({
      action: 'refund',
      lockId: LOCK_ID,
    })
    // Another sender's lock has another id.
    expect(
      htlcCallOf('0x' + '99'.repeat(20), STEPS.lock.call.data).lockId,
    ).not.toBe(LOCK_ID)
    expect(() =>
      htlcCallOf(main.address, '0x3593564c' + '00'.repeat(32)),
    ).toThrow()
    expect(() =>
      htlcCallOf(main.address, STEPS.refund.call.data + '00'),
    ).toThrow()
  })

  it.each(['lock', 'withdraw', 'refund'] as const)(
    '%s: journaled with its call, kept across a reopen, and its note to self carries exactly it',
    async action => {
      const state = node()
      const { call } = STEPS[action]
      const record = recordOf(action)
      const sent = await owner(state).executor.sendContractCall({
        to: { raw: call.to },
        data: call.data,
        value: call.value,
        gasLimit: 250_000n,
        record,
      })
      expect(journal.get(sent.operationId).record).toEqual(record)
      await journal.Close()
      await open()
      expect(journal.get(sent.operationId).record).toEqual(record)

      // Included: the reopened wallet's sync event carries the record beside the wallet-sync item.
      const sync = jest.fn(
        async (_item: WalletSyncItem, _record?: MessageItem) => undefined,
      )
      const { executor } = owner(state, sync)
      await executor.observe(sent.operationId, 0)
      await executor.flushSync(sent.operationId)
      expect(sync).toHaveBeenCalledTimes(1)
      const [walletSync, note] = sync.mock.calls[0]!
      expect(walletSync).toMatchObject({
        type: 'wallet-sync',
        direction: 'out',
        chainIdentifier: 'monad-testnet',
        txHash: sent.txHash,
      })
      const expected: HtlcRecordItem = {
        type: 'htlc-record',
        chainIdentifier: 'monad-testnet',
        action,
        swapId: SWAP_ID,
        lockId: LOCK_ID,
        txHash: sent.txHash,
        timestamp: (note as HtlcRecordItem).timestamp,
      }
      expect(note).toEqual(expected)
      expect(contractCallRecordItemOf(journal.get(sent.operationId))).toEqual({
        ...expected,
        timestamp: expect.any(Number),
      })
      expect(swapRecordItemOf(journal.get(sent.operationId))).toBeUndefined()

      // The note's bytes, as another device of the account reads them.
      const frames = encodeItemFrames(registry, [walletSync, note!], {
        selfAddressed: true,
      })
      expect(
        decodeItemFrames(registry, children(frames), standaloneItemBudget(), {
          selfAddressed: true,
        }),
      ).toEqual([walletSync, expected])
      // The same bytes from anyone else are not interpreted.
      expect(
        decodeItemFrames(registry, children(frames), standaloneItemBudget(), {
          selfAddressed: false,
        }).map(item => item.type),
      ).toEqual(['unsupported', 'unsupported'])
    },
  )

  it('a malformed record in a note to self is kept uninterpreted; the message and its other items survive', () => {
    const good: HtlcRecordItem = {
      type: 'htlc-record',
      chainIdentifier: 'monad-testnet',
      action: 'refund',
      swapId: SWAP_ID,
      lockId: LOCK_ID,
      txHash: '0x' + 'ab'.repeat(32),
      timestamp: 1760000000000,
    }
    const frames = encodeItemFrames(
      registry,
      [good, { type: 'text', text: 'beside it' }],
      { selfAddressed: true },
    )
    // The same frame with the action's text replaced by a same-length unknown step.
    const at = Buffer.from(frames[0]!).indexOf(Buffer.from('refund'))
    expect(at).toBeGreaterThan(0)
    const bad = Uint8Array.from(frames[0]!)
    bad.set(new TextEncoder().encode('rescue'), at)
    const read = decodeItemFrames(
      registry,
      children([bad, frames[1]!]),
      standaloneItemBudget(),
      { selfAddressed: true },
    )
    expect(read[0]).toMatchObject({
      type: 'unsupported',
      reason: 'malformed',
      itemType: 'htlc-record',
    })
    expect(read[1]).toEqual({ type: 'text', text: 'beside it' })
  })

  it("sends an htlc call only to the network's GenericHTLC", async () => {
    const state = node()
    const refused = {
      name: 'EvmNativeJournalError',
      code: 'invalid',
      validation: 'record',
    }
    const { call } = STEPS.refund
    const params = (to: string) => ({
      to: { raw: to },
      data: call.data,
      value: 0n,
      gasLimit: 250_000n,
      record: recordOf('refund'),
    })
    const elsewhere = '0x' + '66'.repeat(20)
    const cases: Array<[string, (() => string) | null, string]> = [
      ['another contract', () => HTLC, elsewhere],
      ['no GenericHTLC configured', null, HTLC],
      [
        'none deployed on the network',
        () => {
          throw new Error('GenericHTLC is not deployed on monad-testnet')
        },
        HTLC,
      ],
      ['a malformed configured address', () => '0x1234', HTLC],
    ]
    for (const [, contract, to] of cases) {
      const { executor, sign } = owner(state, undefined, contract)
      await expect(executor.sendContractCall(params(to))).rejects.toMatchObject(
        refused,
      )
      expect(sign).not.toHaveBeenCalled()
    }
    expect(state.raws).toEqual([])
    expect(journal.list()).toEqual([])
    // The same call to that contract, in any letter case, goes; a call without an htlc record
    // is not bound to it.
    const { executor } = owner(state, undefined, () =>
      HTLC.toUpperCase().replace('0X', '0x'),
    )
    const sent = await executor.sendContractCall(params(HTLC))
    expect(journal.get(sent.operationId).record).toEqual(recordOf('refund'))
    const plain = await owner(state).executor.sendContractCall({
      ...params(elsewhere),
      record: undefined,
    })
    expect(journal.get(plain.operationId)).not.toHaveProperty('record')
  })

  it('refuses a malformed record, or one that is not its call, before anything is signed', async () => {
    const state = node()
    const { executor, sign } = owner(state)
    const send = (action: EvmHtlcCallAction, record: unknown) =>
      executor.sendContractCall({
        to: { raw: STEPS[action].call.to },
        data: STEPS[action].call.data,
        value: STEPS[action].call.value,
        gasLimit: 250_000n,
        record: record as EvmHtlcCallRecord,
      })
    const refused = {
      name: 'EvmNativeJournalError',
      code: 'invalid',
      validation: 'record',
    }
    const lock = recordOf('lock')
    for (const record of [
      { ...lock, action: 'claim' },
      { ...lock, swapId: '0x' + SWAP_ID },
      { ...lock, swapId: SWAP_ID.toUpperCase() },
      { ...lock, swapId: SWAP_ID.slice(2) },
      { ...lock, lockId: LOCK_ID.slice(2) },
      { ...lock, lockId: LOCK_ID.toUpperCase().replace('0X', '0x') },
      { ...lock, extra: 1 },
      { kind: 'htlc', action: 'lock', swapId: SWAP_ID },
      // Shape-valid, but not the call it travels with.
      { ...lock, lockId: '0x' + '77'.repeat(32) },
    ])
      await expect(send('lock', record)).rejects.toMatchObject(refused)
    // A withdraw recorded as a refund, and a refund recorded as a lock.
    await expect(send('withdraw', recordOf('refund'))).rejects.toMatchObject(
      refused,
    )
    await expect(send('refund', recordOf('lock'))).rejects.toMatchObject(
      refused,
    )
    expect(sign).not.toHaveBeenCalled()
    expect(state.raws).toEqual([])
    expect(journal.list()).toEqual([])
    // The journal refuses a malformed htlc record on any contract row it is asked to write,
    // and on any other kind of row at all.
    const plan = (kind: 'contract' | 'native', record: unknown) =>
      journal.prepare({
        kind,
        recipient: HTLC,
        intendedValueWei: '0',
        record: record as EvmHtlcCallRecord,
        members: [
          {
            source: mainSource,
            unsignedTransaction: Transaction.from({
              type: 2,
              to: HTLC,
              chainId: 10143n,
              nonce: 0,
              value: 0n,
              data: STEPS.refund.call.data,
              gasLimit: 100_000n,
              maxFeePerGas: 2n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
            dependencies: [],
          },
        ],
      })
    await expect(
      plan('contract', { ...recordOf('refund'), action: 'cancel' }),
    ).rejects.toMatchObject(refused)
    await expect(plan('native', recordOf('refund'))).rejects.toBeInstanceOf(
      EvmNativeJournalError,
    )
  })

  it('a stored row whose htlc record is malformed fails the journal open and is kept as it was', async () => {
    const state = node()
    const sent = await owner(state).executor.sendContractCall({
      to: { raw: STEPS.refund.call.to },
      data: STEPS.refund.call.data,
      value: 0n,
      gasLimit: 250_000n,
      record: recordOf('refund'),
    })
    const row = journal.get(sent.operationId)
    await journal.Close()
    const db = level(join(location, 'evm-native-operations-v1'))
    const key = `operation:${row.operationId}`
    const original = String(await db.get(key))
    expect(JSON.parse(original).record).toEqual(recordOf('refund'))
    const bytes = JSON.stringify({
      ...row,
      record: { ...row.record, action: 'rescue' },
    })
    await db.put(key, bytes)
    await db.close()
    await expect(journal.Open()).rejects.toThrow()
    const check = level(join(location, 'evm-native-operations-v1'))
    try {
      expect(String(await check.get(key))).toBe(bytes)
    } finally {
      await check.close()
    }
    // Restoring the row's own bytes opens it again, record and all.
    const restore = level(join(location, 'evm-native-operations-v1'))
    await restore.put(key, original)
    await restore.close()
    await open()
    expect(journal.get(sent.operationId).record).toEqual(recordOf('refund'))
  })
})
