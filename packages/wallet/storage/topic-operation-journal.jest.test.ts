import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import {
  InMemoryTopicOperationJournal,
  LevelTopicOperationJournal,
  topicOperationKey,
} from './topic-operation-journal'
import type { OutgoingTopicOperation } from './topic-operation-journal'

function row(
  index: number,
  format?: 'protobuf' | 'cbor' | 'forum-cbor',
): OutgoingTopicOperation {
  return {
    version: 1,
    kind: index % 2 ? 'vote' : 'post',
    requestBytes: [255, index, 0],
    ...(format ? { writeFormat: format } : {}),
    leaseIndex: index,
    senderAddress: '0x' + '12'.repeat(20),
    rawTx: 'opaque historical signed bytes',
    txHash: '0x' + index.toString(16).padStart(64, '0'),
    valueWei: '7',
    direction: 'up',
    ...(index % 2
      ? { targetPayloadHashHex: 'ab'.repeat(32) }
      : { payloadHashHex: 'cd'.repeat(32) }),
  } as OutgoingTopicOperation
}

test('closed version1 map accepts old discriminants and explicit canonical rows without rewriting', async () => {
  const journal = new InMemoryTopicOperationJournal()
  const rows = [
    row(0),
    row(1, 'protobuf'),
    row(2, 'cbor'),
    row(3, 'forum-cbor'),
  ]
  for (const operation of rows) await journal.put(operation)
  expect(journal.getAll()).toEqual(rows)
  for (const operation of rows)
    expect(journal.referencesLeaseIndex(operation.leaseIndex)).toBe(true)
  await expect(
    journal.put({ ...rows[0], writeFormat: 'forum-cbor' }),
  ).rejects.toThrow('Cannot replace')
  await expect(
    journal.put({
      ...rows[0],
      writeFormat: 'sniffed' as any,
      txHash: 'ef'.repeat(32),
    }),
  ).rejects.toThrow()
  expect(journal.getAll()).toEqual(rows)
})

test('actual Level restart preserves exact serialized mixed old rows and their lease references', async () => {
  const location = mkdtempSync(join(tmpdir(), 'forum-journal-retention-'))
  const rows = [
    row(0),
    row(1, 'protobuf'),
    row(2, 'cbor'),
    row(3, 'forum-cbor'),
  ]
  const encoded = rows.map(r => JSON.stringify(r))
  let db = level(location)
  try {
    for (let i = 0; i < rows.length; i++)
      await db.put(topicOperationKey(rows[i]), encoded[i], { sync: true })
    await db.close()
    db = level(location)
    const journal = new LevelTopicOperationJournal(db, () => {})
    await journal.Open()
    expect(
      journal.getAll().sort((a, b) => a.leaseIndex - b.leaseIndex),
    ).toEqual(rows)
    for (let i = 0; i < rows.length; i++) {
      expect(await db.get(topicOperationKey(rows[i]))).toBe(encoded[i])
      expect(journal.referencesLeaseIndex(i)).toBe(true)
    }
    await expect(
      journal.put({ ...rows[1], requestBytes: [1] }),
    ).rejects.toThrow('Cannot replace')
    expect(await db.get(topicOperationKey(rows[1]))).toBe(encoded[1])
  } finally {
    await db.close()
    rmSync(location, { recursive: true, force: true })
  }
})
