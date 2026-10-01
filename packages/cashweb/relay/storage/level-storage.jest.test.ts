import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level, { LevelDB } from 'level'

import type { MessageWrapper } from '../../types/messages'
import {
  deserializeMessageWrapper,
  LevelMessageStore,
  serializeMessageWrapper,
} from './level-storage'

const LARGE_WEI = 123_456_789_012_345_678_901n

function wrapper(index = 'payload-digest'): MessageWrapper {
  return {
    index,
    outbound: true,
    senderAddress: 'sender',
    copartyAddress: 'recipient',
    message: {
      outbound: true,
      status: 'confirmed',
      receivedTime: 123,
      serverTime: 456,
      items: [{ type: 'text', text: 'hello' }],
      outpoints: [],
      senderAddress: 'sender',
      stampValueWei: LARGE_WEI,
      stampPayments: [
        {
          txHash: '0xabc',
          destinationAddress: '0xdef',
          valueWei: LARGE_WEI - 1n,
        },
      ],
    },
  }
}

function relayWrapper(index = 'relay-receipt'): MessageWrapper {
  const received = wrapper(index)
  received.outbound = false
  received.message.outbound = false
  received.message.receivedTime = 456
  received.message.destinationAddress = '0xAa'
  return received
}

async function legacyV2Messages(db: LevelDB): Promise<MessageWrapper[]> {
  const result: MessageWrapper[] = []
  const iterator = db.iterator({})
  while (true) {
    const entry = await new Promise<
      { key: string; value: string } | undefined
    >((resolve, reject) => {
      iterator.next((error: Error, key: string, value: string) => {
        if (error) reject(error)
        else resolve(key ? { key, value } : undefined)
      })
    })
    if (!entry) break
    if (entry.key !== 'lastServerTime') {
      result.push(deserializeMessageWrapper(entry.value))
    }
  }
  await new Promise<void>((resolve, reject) =>
    iterator.end((error: Error) => (error ? reject(error) : resolve())),
  )
  return result
}

describe('LevelMessageStore schema v4', () => {
  it('round-trips financial integers beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const encoded = serializeMessageWrapper(wrapper())

    expect(encoded).toContain(`\"stampValueWei\":\"${LARGE_WEI}\"`)
    expect(deserializeMessageWrapper(encoded)).toEqual(wrapper())
  })

  it('rejects unsafe legacy JSON numbers instead of silently changing their value', () => {
    const sample = wrapper()
    const encoded = JSON.stringify({
      ...sample,
      message: {
        ...sample.message,
        stampValueWei: Number.MAX_SAFE_INTEGER + 1,
        stampPayments: undefined,
      },
    })

    expect(() => deserializeMessageWrapper(encoded)).toThrow(
      'Stored wei value is not a safe non-negative integer',
    )
  })

  it('commits a message and its resume cursor together and keeps deletion durable', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-store-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(wrapper(), { advanceCursor: false })

      expect(await store.getMessage('payload-digest')).toEqual(wrapper())
      expect(await store.mostRecentMessageTime()).toBe(0)

      const inbound = wrapper('inbound-digest')
      inbound.outbound = false
      inbound.message.outbound = false
      await store.saveMessage(inbound)
      expect(await store.mostRecentMessageTime()).toBe(456)

      const persisted: MessageWrapper[] = []
      for await (const message of await store.getIterator()) {
        persisted.push(message)
      }
      expect(persisted).toEqual([inbound, wrapper()])

      await store.deleteMessage('payload-digest')
      expect(await store.getMessage('payload-digest')).toBeUndefined()
      expect(await store.mostRecentMessageTime()).toBe(456)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('keeps relay progress recipient-scoped and ignores the legacy global cursor', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-cursor-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.mostRecentMessageTime(9000)
      expect(await store.relayCursor('0xAa')).toBe(0)
      await store.advanceRelayCursor('0xAa', 500)
      await store.advanceRelayCursor('0xaa', 400)
      await store.advanceRelayCursor('0xBb', 200)
      expect(await store.relayCursor('0xAA')).toBe(500)
      expect(await store.relayCursor('0xbb')).toBe(200)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('rejects unsafe cursor writes and conservatively ignores a poisoned stored cursor', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-cursor-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await expect(
        store.advanceRelayCursor('0xAa', Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow('Unsafe relay cursor timestamp')
      await expect(store.advanceRelayCursor('0xAa', -1)).rejects.toThrow(
        'Unsafe relay cursor timestamp',
      )
      const metadataDb = Reflect.get(store, 'metadataDb') as {
        put(key: string, value: string): Promise<void>
      }
      await metadataDb.put(
        'relayCursor:0xaa',
        JSON.stringify('9007199254740992'),
      )
      expect(await store.relayCursor('0xAA')).toBe(0)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('keeps delayed-receipt suppression durable until cursor acknowledgement safely collects it', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-suppression-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(wrapper('delayed-receipt'), {
        advanceCursor: false,
      })
      await store.suppressAndDelete(
        '0xAa',
        ['delayed-receipt'],
        [{ payloadDigest: 'delayed-receipt' }],
      )
      expect(await store.getMessage('delayed-receipt')).toBeUndefined()
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      const receipt = {
        payloadDigest: 'delayed-receipt',
        receivedTime: 456,
      }
      expect(await store.suppressedRelayReceipts('0xaa', [receipt])).toEqual(
        new Set(['delayed-receipt']),
      )
      await expect(
        store.advanceRelayCursor('0xaa', Number.MAX_SAFE_INTEGER, [receipt]),
      ).rejects.toThrow('Unsafe relay cursor timestamp')
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.suppressedRelayReceipts('0xAA', [receipt])).toEqual(
        new Set(['delayed-receipt']),
      )
      await store.advanceRelayCursor('0xAA', 457, [receipt])
      expect(await store.suppressedRelayReceipts('0xaa', [receipt])).toEqual(
        new Set(),
      )
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('hides suppression metadata from message iteration', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-suppression-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.suppressAndDelete(
        '0xAa',
        [],
        [{ payloadDigest: 'not-a-message' }],
      )
      const persisted: MessageWrapper[] = []
      for await (const message of await store.getIterator()) {
        persisted.push(message)
      }
      expect(persisted).toEqual([])
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('keeps a durable receipt when the later cursor commit fails', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-cursor-fault-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      const durableDb = Reflect.get(store, 'db') as {
        put: (...args: unknown[]) => Promise<void>
      }
      const put = jest.spyOn(durableDb, 'put')
      await store.saveMessage(wrapper('durable-before-cursor'), {
        advanceCursor: false,
      })
      expect(put).toHaveBeenCalledWith(
        'durable-before-cursor',
        expect.any(String),
        { sync: true },
      )
      put.mockRestore()
      const authorityDb = Reflect.get(store, 'metadataDb') as {
        batch: (...args: unknown[]) => Promise<void>
      }
      const batch = jest
        .spyOn(authorityDb, 'batch')
        .mockRejectedValueOnce(new Error('cursor commit failed'))
      await expect(
        store.advanceRelayCursor('0xAa', 457, [], [
          relayWrapper('durable-before-cursor'),
        ]),
      ).rejects.toThrow('cursor commit failed')
      expect(batch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'put', key: 'relayCursor:0xaa' }),
          expect.objectContaining({
            type: 'put',
            key: 'relayReceipt:0xaa:durable-before-cursor',
          }),
        ]),
        { sync: true },
      )
      batch.mockRestore()
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.relayCursor('0xaa')).toBe(0)
      expect(await store.getMessage('durable-before-cursor')).toEqual(
        wrapper('durable-before-cursor'),
      )
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('atomically retains both cursor and suppression when their shared commit fails', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-suppression-fault-'))
    let store = new LevelMessageStore(location)
    const receipt = { payloadDigest: 'deleted-receipt', receivedTime: 456 }
    try {
      await store.Open()
      await store.suppressAndDelete(
        '0xAa',
        ['deleted-receipt'],
        [{ payloadDigest: 'deleted-receipt' }],
      )
      expect(await store.suppressedRelayReceipts('0xAa', [receipt])).toEqual(
        new Set(['deleted-receipt']),
      )
      const authorityDb = Reflect.get(store, 'metadataDb') as {
        batch: (...args: unknown[]) => Promise<void>
      }
      const batch = jest
        .spyOn(authorityDb, 'batch')
        .mockRejectedValueOnce(new Error('atomic commit failed'))
      await expect(
        store.advanceRelayCursor('0xAa', 457, [receipt]),
      ).rejects.toThrow('atomic commit failed')
      expect(batch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'put', key: 'relayCursor:0xaa' }),
          expect.objectContaining({
            type: 'del',
            key: 'relaySuppressionIndex:0xaa',
          }),
        ]),
        { sync: true },
      )
      batch.mockRestore()
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.relayCursor('0xaa')).toBe(0)
      expect(await store.suppressedRelayReceipts('0xaa', [receipt])).toEqual(
        new Set(['deleted-receipt']),
      )
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('recovers a receipt when the earlier browser message transaction is lost after cursor commit', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-browser-journal-'))
    let store = new LevelMessageStore(location)
    const receipt = relayWrapper('browser-relaxed-loss')
    try {
      await store.Open()
      await store.saveMessage(receipt, { advanceCursor: false })
      const authorityDb = Reflect.get(store, 'metadataDb') as {
        batch: (...args: unknown[]) => Promise<void>
      }
      const authorityCommit = jest.spyOn(authorityDb, 'batch')
      await store.advanceRelayCursor('0xAa', 457, [], [receipt])
      expect(authorityCommit).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'put', key: 'relayCursor:0xaa' }),
          expect.objectContaining({
            type: 'put',
            key: 'relayReceipt:0xaa:browser-relaxed-loss',
          }),
        ]),
        { sync: true },
      )
      authorityCommit.mockRestore()

      // Model level-js retaining the later metadata IndexedDB transaction while losing the
      // earlier relaxed message transaction. The same-transaction journal is the authority.
      const messageDb = Reflect.get(store, 'db') as {
        del(key: string): Promise<void>
      }
      await messageDb.del(receipt.index)
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.relayCursor('0xaa')).toBe(457)
      expect(await store.getMessage(receipt.index)).toEqual(receipt)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('migrates c087 relay metadata out of the message keyspace for an exact v2 rollback', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-v2-rollback-'))
    let store = new LevelMessageStore(location)
    const receipt = relayWrapper('rollback-visible-message')
    try {
      await store.Open()
      await store.saveMessage(receipt, { advanceCursor: false })
      const messageDb = Reflect.get(store, 'db') as {
        put(key: string, value: string): Promise<void>
      }
      // Exact incompatible keys written by c087f6e.
      await messageDb.put('relayCursor:0xaa', JSON.stringify(457))
      await messageDb.put('relaySuppressionIndex:0xaa', JSON.stringify([]))
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.relayCursor('0xaa')).toBe(457)
      await store.Close()

      // Main's unchanged v2 reader iterates every message-db value except lastServerTime and
      // deserializes it as a MessageWrapper. This exact rollback fixture must not throw.
      const legacyDb = level(join(location, 'messages'))
      await expect(legacyV2Messages(legacyDb)).resolves.toEqual([receipt])
      await legacyDb.close()
    } finally {
      try {
        await store.Close()
      } catch {
        // The explicit rollback read above closes the current store before the v2 fixture.
      }
      await rm(location, { recursive: true, force: true })
    }
  })
})
