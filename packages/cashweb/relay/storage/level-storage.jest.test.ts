import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

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
      const legacyMetadataDb = Reflect.get(store, 'metadataDb') as {
        put(key: string, value: string): Promise<void>
      }
      await legacyMetadataDb.put('relayCursor:0xaa', JSON.stringify(8000))
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
      const messageDb = Reflect.get(store, 'db') as {
        put(key: string, value: string): Promise<void>
      }
      await messageDb.put(
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
      const messageDb = Reflect.get(store, 'db') as {
        batch: (...args: unknown[]) => Promise<void>
      }
      const batch = jest
        .spyOn(messageDb, 'batch')
        .mockRejectedValueOnce(new Error('cursor commit failed'))
      await expect(store.advanceRelayCursor('0xAa', 457)).rejects.toThrow(
        'cursor commit failed',
      )
      expect(batch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'put', key: 'relayCursor:0xaa' }),
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
      const messageDb = Reflect.get(store, 'db') as {
        batch: (...args: unknown[]) => Promise<void>
      }
      const batch = jest
        .spyOn(messageDb, 'batch')
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
})
