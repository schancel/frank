import 'fake-indexeddb/auto'
import { IDBObjectStore, IDBDatabase } from 'fake-indexeddb'
import level from 'level'
import { join } from 'path'
import { LevelMessageStore, serializeMessageWrapper } from './level-storage'
import type { MessageWrapper } from '../../types/messages'

// Production LevelMessageStore runs against the installed browser backend, not a
// replacement MessageStore algorithm. This fixture does not simulate power loss.
jest.mock('level', () => jest.requireActual('level/browser'))

const message: MessageWrapper = {
  index: 'browser-message',
  outbound: false,
  senderAddress: 'sender',
  copartyAddress: '0xaa',
  message: {
    outbound: false,
    status: 'confirmed',
    serverTime: 12,
    receivedTime: 12,
    senderAddress: 'sender',
    items: [{ type: 'text', text: 'synthetic browser fixture' }],
    outpoints: [],
  },
}

type Rows = {
  messages: Record<string, string>
  metadata: Record<string, string>
}
async function raw(location: string, seed?: Rows): Promise<Rows> {
  const rows: Rows = { messages: {}, metadata: {} }
  for (const component of ['messages', 'metadata'] as const) {
    const db = level(join(location, component))
    try {
      for (const [key, value] of Object.entries(seed?.[component] ?? {}))
        await db.put(key, value)
      for await (const [key, value] of db.iterator())
        rows[component][String(key)] = String(value)
    } finally {
      await db.close()
    }
  }
  return rows
}

let sequence = 0
describe('actual browser message-store application records', () => {
  let location: string
  let store: LevelMessageStore
  beforeEach(() => {
    location = `/synthetic-message-store-browser-${++sequence}`
    store = new LevelMessageStore(location)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.Close()
    for (const component of ['messages', 'metadata'])
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(
          `level-js-${join(location, component)}`,
        )
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () =>
          reject(new Error('test leaked a browser database handle'))
      })
  })

  it.each<Rows & { label: string; accepted: boolean }>([
    { label: 'nothing survived', accepted: true, messages: {}, metadata: {} },
    {
      label: 'marker only',
      accepted: true,
      messages: {},
      metadata: { schemaVersion: '2' },
    },
    {
      label: 'current message and zero timestamp',
      accepted: true,
      messages: {
        'browser-message': serializeMessageWrapper(message),
        'lastServerTime': '0',
      },
      metadata: { schemaVersion: '2' },
    },
    {
      label: 'later message survived without schema',
      accepted: false,
      messages: { 'browser-message': serializeMessageWrapper(message) },
      metadata: {},
    },
    {
      label: 'suppression survived without schema',
      accepted: false,
      messages: {},
      metadata: {
        'relaySuppressionIndex:0xaa':
          '[{"payloadDigest":"kept","receivedTime":null}]',
      },
    },
    {
      label: 'quarantine survived without schema',
      accepted: false,
      messages: {},
      metadata: {
        'relayQuarantineIndex:0xaa':
          '[{"payloadDigest":"kept","receivedTime":12}]',
      },
    },
    {
      label: 'unsupported marker',
      accepted: false,
      messages: { retained: 'original bytes' },
      metadata: { schemaVersion: '4' },
    },
  ])('preserves surviving state: $label', async fixture => {
    const before = await raw(location, fixture)
    const mutations = [
      jest.spyOn(IDBObjectStore.prototype, 'put'),
      jest.spyOn(IDBObjectStore.prototype, 'delete'),
      jest.spyOn(IDBObjectStore.prototype, 'clear'),
    ]
    const close = jest.spyOn(IDBDatabase.prototype, 'close')
    if (fixture.accepted) {
      await store.Open()
      expect(await store.mostRecentMessageTime()).toBe(0)
      const iterator = await store.getIterator()
      for await (const row of iterator) expect(row).toEqual(message)
      await store.relayCursor('0xaa')
    } else
      await expect(store.Open()).rejects.toMatchObject({
        code: 'unsupported-schema',
      })
    await store.Close()
    expect(close).toHaveBeenCalledTimes(2)
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled()
    expect(await raw(location)).toEqual(before)
  })

  it('awaits the schema transaction before a separate atomic message/timestamp transaction', async () => {
    await store.Open()
    const events: string[] = []
    const put = IDBObjectStore.prototype.put
    const mutations = jest
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (
        this: InstanceType<typeof IDBObjectStore>,
        value,
        key,
      ) {
        if (String(key) === 'schemaVersion') {
          events.push('marker-put')
          this.transaction.addEventListener('complete', () =>
            events.push('marker-complete'),
          )
        } else events.push(`data-${String(key)}`)
        return put.call(this, value, key)
      })
    await store.saveMessage(message)
    expect(events).toEqual([
      'marker-put',
      'marker-complete',
      'data-browser-message',
      'data-lastServerTime',
    ])
    expect(mutations.mock.instances[0].transaction).not.toBe(
      mutations.mock.instances[1].transaction,
    )
    expect(mutations.mock.instances[1].transaction).toBe(
      mutations.mock.instances[2].transaction,
    )
    await store.Close()
    expect(await raw(location)).toEqual({
      messages: {
        'browser-message': serializeMessageWrapper(message),
        'lastServerTime': '12',
      },
      metadata: { schemaVersion: '2' },
    })
  })

  it('refuses the fault-injected loss of an earlier marker while later message data survives', async () => {
    await store.Open()
    await store.saveMessage(message)
    await store.Close()
    const metadata = level(join(location, 'metadata'))
    await metadata.del('schemaVersion')
    await metadata.close()
    const before = await raw(location)
    store = new LevelMessageStore(location)
    await expect(store.Open()).rejects.toMatchObject({
      code: 'unsupported-schema',
    })
    await store.Close()
    expect(await raw(location)).toEqual(before)
    expect(before.messages['browser-message']).toBe(
      serializeMessageWrapper(message),
    )
  })
})
