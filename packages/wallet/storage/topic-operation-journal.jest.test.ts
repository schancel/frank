import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { Wallet, Transaction } from 'ethers'
import {
  InMemoryTopicOperationJournal, LevelTopicOperationJournal,
  TOPIC_OPERATION_KEY_PREFIX, topicOperationKey,
  type OutgoingTopicOperation, type RetainedTopicOperation,
} from './topic-operation-journal'

async function retained(index: number, writeFormat?: RetainedTopicOperation['writeFormat']): Promise<RetainedTopicOperation> {
  const signer = new Wallet('0x' + (index + 1).toString(16).padStart(64, '0'))
  const rawTx = await signer.signTransaction({
    chainId: 10143, nonce: 0, to: '0x' + '12'.repeat(20), value: 7n,
    gasLimit: 21_000n, gasPrice: 1n,
  })
  return {
    version: 1, kind: 'post', requestBytes: [255, index, 0],
    ...(writeFormat ? { writeFormat } : {}), leaseIndex: index,
    senderAddress: signer.address, rawTx, txHash: Transaction.from(rawTx).hash!,
    valueWei: '7', direction: 'up', payloadHashHex: 'cd'.repeat(32),
  }
}
const keyOf = (row: RetainedTopicOperation) =>
  `${TOPIC_OPERATION_KEY_PREFIX}${row.kind}:${row.txHash.slice(2)}`
const current = (): OutgoingTopicOperation => ({
  version: 2, kind: 'post', writeFormat: 'forum-cbor', requestBytes: [],
  transactionSetOperationId: 'current-forum-operation', funders: [], rawTransactions: [],
  transactionSetHash: '', intendedValueWei: '7', valueWei: '7', direction: 'up',
  payloadHashHex: 'cd'.repeat(32),
  construction: { burnAddress: '0x' + '12'.repeat(20), postFrameHex: 'ff' },
})

test('current writer accepts v2 construction and refuses new legacy writes', async () => {
  const journal = new InMemoryTopicOperationJournal()
  const row = current()
  await journal.put(row)
  expect(journal.getAll()).toEqual([row])
  await expect(journal.put(await retained(0) as unknown as OutgoingTopicOperation)).rejects.toThrow('Unsupported Forum operation format')
  await expect(journal.put({ ...row, intendedValueWei: '8', valueWei: '8' })).rejects.toThrow('Cannot replace')
  expect(journal.getAll()).toEqual([row])
})

test('actual Level restart preserves signed legacy bytes separately from current operations', async () => {
  const location = mkdtempSync(join(tmpdir(), 'forum-journal-retention-'))
  const rows = await Promise.all(([undefined, 'protobuf', 'cbor', 'forum-cbor'] as const).map((format, index) => retained(index, format)))
  const encoded = rows.map(row => JSON.stringify(row))
  let db = level(location)
  try {
    for (let i = 0; i < rows.length; i++) await db.put(keyOf(rows[i]), encoded[i], { sync: true })
    await db.close()
    db = level(location)
    const journal = new LevelTopicOperationJournal(db, () => {})
    await journal.Open()
    expect(journal.getAll()).toEqual([])
    expect(journal.getRetainedLegacy().sort((a, b) => a.leaseIndex - b.leaseIndex)).toEqual(rows)
    for (let i = 0; i < rows.length; i++) {
      expect(await db.get(keyOf(rows[i]))).toBe(encoded[i])
      expect(journal.holdsRetainedSource(rows[i].senderAddress)).toBe(true)
    }
    expect(journal.holdsRetainedSource('0x' + '34'.repeat(20))).toBe(false)
    await expect(journal.put(rows[0] as unknown as OutgoingTopicOperation)).rejects.toThrow('Unsupported Forum operation format')
    await expect(journal.deleteRetained(rows[0])).rejects.toThrow('Unsupported retained Forum operation')
    const operation = current()
    await journal.put(operation)
    expect(await db.get(topicOperationKey(operation))).toBe(JSON.stringify(operation))
    for (let i = 0; i < rows.length; i++) expect(await db.get(keyOf(rows[i]))).toBe(encoded[i])
  } finally {
    await db.close()
    rmSync(location, { recursive: true, force: true })
  }
})
