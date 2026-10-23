import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Wallet } from 'ethers'
import type { LevelDB } from 'level'
import * as durability from './level-durability'
import {
  EvmNativeOperationJournal, evmNativeOperationDigest,
  type EvmNativeOperation, type EvmNativePlan, type EvmNativeCompletionReceipt,
} from './evm-native-operation-journal'

jest.setTimeout(120_000)
const signer = new Wallet('0x' + '21'.repeat(32))
const address = signer.address.toLowerCase()
const destination = new Wallet('0x' + '22'.repeat(32)).address.toLowerCase()
const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'completed-history-tests' }
const blockHash = '0x' + '33'.repeat(32)
let root: string
let journal: EvmNativeOperationJournal
let database: LevelDB
let scans: unknown[]
const options = () => ({ location: root, binding, maxRecords: 1 })
function plan(nonce: number): EvmNativePlan {
  const tx = Transaction.from({ type: 0, chainId: 10143, nonce, to: destination, value: 1000n, gasLimit: 21000n, gasPrice: 1n })
  return {
    kind: 'transaction-set', preparationId: `evm-transaction-set:send${nonce}`,
    recipient: destination, intendedValueWei: '1000', members: [{
      source: { kind: 'coin', address }, unsignedTransaction: tx.unsignedSerialized, dependencies: [],
      transactionSet: { role: 'payment', logicalIndex: 0, balanceBeforeWei: '22000', balanceAfterWei: '0' },
    }],
  }
}
async function prepare(nonce: number) {
  const input = plan(nonce)
  return journal.prepare(input, [await signer.signTransaction(Transaction.from(input.members[0]!.unsignedTransaction))])
}
async function complete(row: EvmNativeOperation, state: 'included-success' | 'included-revert' | 'missing' = 'included-success') {
  await journal.authorizeTransactionSet(row.operationId)
  await journal.markExposed(row.operationId, 0)
  const nonce = Transaction.from(row.members[0]!.unsignedTransaction).nonce
  await journal.recordObservation(journal.beginCapture(row.operationId, 0),
    state === 'missing' ? { state } : {
      state, transactionHash: row.members[0]!.signed!.transactionHash,
      blockHash, blockNumber: 1, transactionIndex: 0, feeWei: '21000',
    }, { blockHash, blockNumber: 1, nonce: nonce + 1, balanceWei: '0' })
  await journal.markTransactionSetInventoryApplied(row.operationId, 0)
  return journal.get(row.operationId)
}
function receipt(row: EvmNativeOperation): EvmNativeCompletionReceipt {
  return { expectedOperationHash: evmNativeOperationDigest(row), ownerReference: `completed-owner:${row.operationId}`,
    sync: 'not-required', delivery: 'complete', dependencies: 'complete' }
}
async function reopen() {
  await journal.Close()
  journal = new EvmNativeOperationJournal(options())
  await journal.Open()
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'frank-completed-history-'))
  scans = []
  const open = durability.openDurableLevel
  jest.spyOn(durability, 'openDurableLevel').mockImplementation(async (...args) => {
    database = args[0]
    const iterate = database.iterator.bind(database)
    jest.spyOn(database, 'iterator').mockImplementation(input => {
      scans.push(input)
      return iterate(input)
    })
    return open(...args)
  })
  journal = new EvmNativeOperationJournal(options())
  await journal.Open()
})
afterEach(async () => {
  await journal.Close()
  jest.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('retains exact signed history, original preparation identity, and conflicts across reopen while freeing active capacity', async () => {
  const row = await complete(await prepare(0))
  await journal.archiveCompleted(row.operationId, receipt(row))
  expect(journal.list()).toEqual([])
  expect(() => journal.get(row.operationId)).toThrow('conflict')
  expect(await journal.readOperation(row.operationId)).toEqual(row)
  expect(await journal.refreshPreparation(row.preparationId!)).toEqual(row)
  expect(await journal.prepare(plan(0))).toEqual(row)
  await expect(journal.prepare({ ...plan(0), intendedValueWei: '999' })).rejects.toThrow('conflict')
  await expect(journal.archiveCompleted(row.operationId, receipt(row))).resolves.toBeUndefined()
  await reopen()
  expect(await journal.readOperation(row.operationId)).toEqual(row)
  expect(await journal.prepare(plan(0))).toEqual(row)
  await expect(prepare(1)).resolves.toMatchObject({ operationId: 'evm-native-v1:0000000000000002' })
})

it('keeps consumed pair protection after archival without a lifetime hot index', async () => {
  const row = await complete(await prepare(0))
  await journal.archiveCompleted(row.operationId, receipt(row))
  await reopen()
  const reused = { ...plan(0), preparationId: 'evm-transaction-set:another' }
  await expect(journal.prepare(reused)).rejects.toThrow('conflict')
  expect(journal.list()).toEqual([])
})

it('leaves unknown and partially projected journal operations active', async () => {
  const row = await prepare(0)
  await expect(journal.archiveCompleted(row.operationId, receipt(row))).rejects.toThrow('conflict')
  await journal.recordObservation(journal.beginCapture(row.operationId, 0), {
    state: 'included-success', transactionHash: row.members[0]!.signed!.transactionHash,
    blockHash, blockNumber: 1, transactionIndex: 0, feeWei: '21000',
  }, { blockHash, blockNumber: 1, nonce: 1, balanceWei: '0' })
  const unprojected = journal.get(row.operationId)
  await expect(journal.archiveCompleted(row.operationId, receipt(unprojected))).rejects.toThrow('conflict')
  expect(journal.list()).toHaveLength(1)
})

it.each(['included-revert', 'missing'] as const)('retains a recorded %s outcome as history after consumed inventory and owner obligations finish', async state => {
  const row = await complete(await prepare(0), state)
  await journal.archiveCompleted(row.operationId, receipt(row))
  await reopen()
  expect((await journal.readOperation(row.operationId))!.members[0]!.observation.state).toBe(state)
  await expect(prepare(1)).resolves.toBeDefined()
})

it('rejects stale snapshot or incomplete obligation receipts without retiring anything', async () => {
  const prepared = await prepare(0)
  const row = await complete(prepared)
  await expect(journal.archiveCompleted(row.operationId, receipt(prepared))).rejects.toThrow('conflict')
  expect(() => journal.archiveCompleted(row.operationId, { ...receipt(row), dependencies: 'pending' } as unknown as EvmNativeCompletionReceipt)).toThrow()
  expect(journal.list()).toHaveLength(1)
})

it.each(['before', 'after'] as const)('reopens the whole local archival transition after a write interruption %s the batch', async moment => {
  const row = await complete(await prepare(0))
  const write = durability.durableBatch
  jest.spyOn(durability, 'durableBatch').mockImplementationOnce(async (...args) => {
    if (moment === 'after') await write(...args)
    throw new Error('interrupted local write acknowledgement')
  })
  await expect(journal.archiveCompleted(row.operationId, receipt(row))).rejects.toThrow('interrupted')
  await reopen()
  expect(journal.list()).toHaveLength(moment === 'before' ? 1 : 0)
  expect(await journal.readOperation(row.operationId)).toEqual(row)
  await expect(journal.archiveCompleted(row.operationId, receipt(row))).resolves.toBeUndefined()
})

it.each(['history', 'completion', 'preparation', 'consumed'] as const)('reports missing required %s evidence instead of an empty successful lookup', async component => {
  const row = await complete(await prepare(0))
  await journal.archiveCompleted(row.operationId, receipt(row))
  const key = component === 'preparation' ? `preparation:${row.preparationId}`
    : component === 'consumed' ? `consumed:${address}:0` : `${component}:${row.operationId}`
  await database.del(key)
  await expect(journal.readOperation(row.operationId)).rejects.toThrow()
  if (component !== 'preparation') await expect(journal.refreshPreparation(row.preparationId!)).rejects.toThrow()
})

it('retains cancelled tombstones and never reuses their original preparation identity', async () => {
  const row = await journal.prepare(plan(0))
  const cancelled = await journal.cancelUnsigned(row.operationId)
  await journal.archiveCompleted(row.operationId, receipt(cancelled))
  await reopen()
  expect(await journal.readOperation(row.operationId)).toEqual(cancelled)
  await expect(journal.prepare(plan(0))).rejects.toThrow('conflict')
  await expect(journal.prepare({ ...plan(0), preparationId: 'evm-transaction-set:replacement' })).resolves.toBeDefined()
})

it('preserves old manifests and every existing row without a rewrite on open', async () => {
  const row = await prepare(0)
  const manifest = JSON.parse(String(await database.get('manifest'))) as Record<string, unknown>
  delete manifest.archivedCount
  await database.put('manifest', JSON.stringify(manifest))
  const exact = String(await database.get(`operation:${row.operationId}`))
  await reopen()
  expect(String(await database.get('manifest'))).toBe(JSON.stringify(manifest))
  expect(String(await database.get(`operation:${row.operationId}`))).toBe(exact)
  expect(journal.get(row.operationId)).toEqual(row)
})

it('passes the 1024 lifetime boundary with one active slot and bounded history pages/scans', async () => {
  let last!: EvmNativeOperation
  for (let nonce = 0; nonce < 1025; nonce++) {
    last = await complete(await prepare(nonce))
    await journal.archiveCompleted(last.operationId, receipt(last))
  }
  scans.length = 0
  await reopen()
  expect(journal.list()).toEqual([])
  expect(scans).toEqual([{ gte: 'operation:', lt: 'operation;' }])
  let count = 0, after: string | undefined
  do {
    const page = await journal.historyPage({ after, limit: 100 })
    expect(page.operations.length).toBeLessThanOrEqual(100)
    count += page.operations.length
    after = page.next
  } while (after)
  expect(count).toBe(1025)
  expect(await journal.readOperation(last.operationId)).toEqual(last)
  await expect(prepare(1025)).resolves.toBeDefined()
})
