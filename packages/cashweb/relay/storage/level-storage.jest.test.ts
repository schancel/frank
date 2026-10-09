import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'

import type { Message, MessageWrapper } from '../../types/messages'
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

/** An inbound relay receipt for `recipient`, the only row kind that anchors the frontier.
 * `destinationAddress` is carried at runtime for relay receipts (see `stores/chats.ts`'s
 * `messageDestinationAddress`) but predates the Monad field on `messages.ts`'s `Message`. */
function inbound(
  index: string,
  receivedTime: number,
  recipient = '0xAa',
): MessageWrapper {
  const message: Message & { destinationAddress?: string } = {
    outbound: false,
    status: 'confirmed',
    receivedTime,
    serverTime: receivedTime,
    items: [{ type: 'text', text: 'hello' }],
    outpoints: [],
    senderAddress: 'sender',
    destinationAddress: recipient,
  }
  return {
    index,
    outbound: false,
    senderAddress: 'sender',
    copartyAddress: recipient,
    message,
  }
}

/** A pre-#420 v2 reader iterates every message-database row, skips only `lastServerTime`, and
 * feeds each remaining value to `deserializeMessageWrapper` -- exactly this. */
async function v2ReaderRows(
  db: RawDb,
): Promise<Array<{ key: string; value: string }>> {
  const rows: Array<{ key: string; value: string }> = []
  await new Promise<void>((resolve, reject) => {
    const iterator = (db as any).iterator({})
    const step = () =>
      iterator.next((error: Error, key: string, value: string) => {
        if (error) {
          iterator.end(() => reject(error))
          return
        }
        if (!key) {
          iterator.end((endError: Error | undefined) => {
            if (endError) {
              reject(endError)
              return
            }
            resolve()
          })
          return
        }
        rows.push({ key, value })
        step()
      })
    step()
  })
  return rows
}

type RawDb = {
  put(key: string, value: string, options?: unknown): Promise<void>
  get(key: string): Promise<string>
  batch(
    operations: Array<{ type: string; key: string; value?: string }>,
    options?: unknown,
  ): Promise<void>
}

const rawDb = (store: LevelMessageStore, name: 'db' | 'metadataDb') =>
  Reflect.get(store, name) as unknown as RawDb

type StoredRows = {
  messages?: Record<string, string>
  metadata?: Record<string, string>
}
async function seed(location: string, rows: StoredRows): Promise<void> {
  for (const component of ['messages', 'metadata'] as const) {
    const db = level(join(location, component))
    try {
      for (const [key, value] of Object.entries(rows[component] ?? {}))
        await db.put(key, value)
    } finally {
      await db.close()
    }
  }
}
async function snapshot(location: string): Promise<StoredRows> {
  const result: StoredRows = {}
  for (const component of ['messages', 'metadata'] as const) {
    const db = level(join(location, component))
    try {
      result[component] = Object.fromEntries(
        (await v2ReaderRows(db as unknown as RawDb)).map(row => [
          row.key,
          String(row.value),
        ]),
      )
    } finally {
      await db.close()
    }
  }
  return result
}

describe('LevelMessageStore', () => {
  it('opens pristine storage without writing an application schema marker', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-pristine-read-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      expect(await store.mostRecentMessageTime()).toBe(0)
      await expect(
        rawDb(store, 'metadataDb').get('schemaVersion'),
      ).rejects.toMatchObject({ type: 'NotFoundError' })
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('reads the valid zero timestamp without dispatching a repair write', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-zero-read-'))
    const db = level(join(location, 'messages'))
    const metadata = level(join(location, 'metadata'))
    await db.put('lastServerTime', '0')
    await metadata.put('schemaVersion', '2')
    await Promise.all([db.close(), metadata.close()])
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      const put = jest.spyOn(rawDb(store, 'db'), 'put')
      expect(await store.mostRecentMessageTime()).toBe(0)
      expect(put).not.toHaveBeenCalled()
      expect(await rawDb(store, 'db').get('lastServerTime')).toBe('0')
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })
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

      const inboundRow = wrapper('inbound-digest')
      inboundRow.outbound = false
      inboundRow.message.outbound = false
      await store.saveMessage(inboundRow)
      expect(await store.mostRecentMessageTime()).toBe(456)

      const persisted: MessageWrapper[] = []
      for await (const message of await store.getIterator()) {
        persisted.push(message)
      }
      expect(persisted).toEqual([inboundRow, wrapper()])

      await store.deleteMessage('payload-digest')
      expect(await store.getMessage('payload-digest')).toBeUndefined()
      expect(await store.mostRecentMessageTime()).toBe(456)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('derives the frontier from inbound receipts only and never persists a cursor row', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-cursor-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(inbound('in-500', 500))
      // Outbound rows to another recipient, self-route loopbacks, and pending sends are not
      // receipt evidence for this mailbox; the legacy global metadata cursor is ignored too.
      const loopback = wrapper('self-loopback') as MessageWrapper & {
        message: Message & { destinationAddress?: string }
      }
      loopback.message.destinationAddress = '0xAa'
      loopback.message.receivedTime = 9000
      await store.saveMessage(loopback, { advanceCursor: false })
      const pending = wrapper('pending-self') as MessageWrapper & {
        message: Message & { destinationAddress?: string }
      }
      pending.message.destinationAddress = '0xAa'
      pending.message.status = 'pending'
      await store.saveMessage(pending, { advanceCursor: false })
      const metadataDb = rawDb(store, 'metadataDb')
      await metadataDb.put('relayCursor:0xaa', JSON.stringify(8000))

      expect(await store.relayCursor('0xAa')).toBe(500)
      expect(await store.relayCursor('0xbb')).toBe(0)

      // Case-insensitive recipient scoping.
      expect(await store.relayCursor('0xaA')).toBe(500)

      // No cursor row may exist in the message database (and the store never writes one to the
      // metadata database either): the unsafe state where saved progress outruns a lost receipt
      // is unrepresentable by construction.
      await expect(
        rawDb(store, 'db').get('relayCursor:0xaa'),
      ).rejects.toMatchObject({ type: 'NotFoundError' })
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('derives the frontier only from rows with safe receipt evidence', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-message-cursor-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(inbound('in-100', 100))
      const unsafe = inbound('in-unsafe', 100)
      unsafe.message = {
        ...unsafe.message,
        receivedTime: '9007199254740992' as unknown as number,
      }
      await store.saveMessage(unsafe, { advanceCursor: false })
      const future = inbound('in-future', Date.now() + 6 * 60 * 1000)
      await store.saveMessage(future, { advanceCursor: false })

      expect(await store.relayCursor('0xAa')).toBe(100)
      await expect(
        store.quarantineRelayReceipts('0xAa', [
          { payloadDigest: 'poison', receivedTime: -1 },
        ]),
      ).rejects.toThrow('Unsafe relay receipt timestamp')
      expect(await store.relayCursor('0xAa')).toBe(100)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('keeps delayed-receipt suppression durable and anchors the frontier once observed', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-suppression-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.suppressAndDelete(
        '0xAa',
        [],
        [{ payloadDigest: 'delayed-receipt' }],
      )
      // An unobserved tombstone has no receipt evidence and cannot anchor the frontier.
      expect(await store.relayCursor('0xaA')).toBe(0)
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
      // Observing the receipt time turns the tombstone into a frontier anchor, so the
      // suppressed relay row cannot pin the inclusive replay window.
      expect(await store.relayCursor('0xAA')).toBe(456)
      // Tombstones are never collected: an anchor dropped while its receipt evidence could be
      // re-fetched would let a deleted message redeliver. Suppression keeps holding.
      expect(await store.suppressedRelayReceipts('0xAA', [receipt])).toEqual(
        new Set(['delayed-receipt']),
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

  it('keeps the message when the tombstone commit fails, and completes deletion on retry', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-suppression-fault-'))
    const store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(inbound('deleted-receipt', 456))
      const metadataDb = rawDb(store, 'metadataDb')
      const batch = jest
        .spyOn(metadataDb, 'batch')
        .mockRejectedValueOnce(new Error('tombstone commit failed'))
      await expect(
        store.suppressAndDelete(
          '0xAa',
          ['deleted-receipt'],
          [{ payloadDigest: 'deleted-receipt', receivedTime: 456 }],
        ),
      ).rejects.toThrow('tombstone commit failed')
      // The tombstone commits BEFORE the message rows disappear, so an interrupted deletion
      // never loses a message whose relay row could still be re-fetched.
      expect(await store.getMessage('deleted-receipt')).toEqual(
        inbound('deleted-receipt', 456),
      )
      batch.mockRestore()

      await store.suppressAndDelete(
        '0xAa',
        ['deleted-receipt'],
        [{ payloadDigest: 'deleted-receipt', receivedTime: 456 }],
      )
      expect(await store.getMessage('deleted-receipt')).toBeUndefined()
      expect(await store.relayCursor('0xaA')).toBe(456)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('never pins the frontier past a receipt the browser lost (fault-injected relaxed durability)', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-cursor-fault-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(inbound('kept', 500))

      // level-js resolves every write as its own default-durability IndexedDB transaction and
      // ignores { sync: true }. A power loss may lose this completed receipt put while keeping
      // earlier ones. Simulate exactly that: the write "succeeds" but never persists.
      const db = rawDb(store, 'db')
      const realPut = db.put.bind(db)
      db.put = (key, value, options) =>
        key === 'lost' ? Promise.resolve() : realPut(key, value, options)
      // Poll deliveries persist receipts with `advanceCursor: false` (a single put per
      // receipt) -- exactly the write this fault targets.
      await store.saveMessage(inbound('lost', 700), { advanceCursor: false })
      db.put = realPut
      await store.Close()

      // "Power restored": a fresh process opens the same store.
      store = new LevelMessageStore(location)
      await store.Open()
      expect(await store.getMessage('lost')).toBeUndefined()
      expect(await store.getMessage('kept')).toEqual(inbound('kept', 500))
      // The derived frontier is computed FROM durable receipts, so it cannot name a time whose
      // receipt evidence is missing: the poll resumes inclusively at 500 and re-fetches the
      // lost row, instead of the old bug (cursor batch survived, receipt lost, row skipped).
      expect(await store.relayCursor('0xAa')).toBe(500)

      // The next poll redelivers the row and dedupes by digest; the frontier then covers it.
      await store.saveMessage(inbound('lost', 700), { advanceCursor: false })
      expect(await store.relayCursor('0xAa')).toBe(700)

      // No cursor row exists anywhere: the crash-unsafe state is unrepresentable.
      await expect(
        rawDb(store, 'metadataDb').get('relayCursor:0xaa'),
      ).rejects.toMatchObject({
        type: 'NotFoundError',
      })
      await expect(
        rawDb(store, 'db').get('relayCursor:0xaa'),
      ).rejects.toMatchObject({
        type: 'NotFoundError',
      })
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('anchors the frontier on quarantined terminal receipts and bounds a poisoned backlog', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-quarantine-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.quarantineRelayReceipts('0xAa', [
        { payloadDigest: 'poison-a', receivedTime: 100 },
      ])
      await store.Close()

      store = new LevelMessageStore(location)
      await store.Open()
      // The quarantine survives the restart and anchors the frontier inclusively, so the
      // terminal row is re-fetched at most once per restart, re-classified (idempotent), and
      // never pins the scan.
      expect(await store.relayCursor('0xAa')).toBe(100)

      // Bounded backlog: newer valid mail raises the frontier past the poisoned prefix.
      await store.saveMessage(inbound('valid-900', 900))
      expect(await store.relayCursor('0xAa')).toBe(900)
      expect(await store.relayCursor('0xBb')).toBe(0)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('rejects a legacy v4 layout without moving or deleting its evidence', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-v4-preserve-'))
    const store = new LevelMessageStore(location)
    try {
      await seed(location, {
        messages: {
          'kept': serializeMessageWrapper(inbound('kept', 400)),
          'relayCursor:0xaa': '5000',
          'relaySuppressionIndex:0xaa': JSON.stringify([
            { payloadDigest: 'gone', receivedTime: 456 },
          ]),
        },
        metadata: { schemaVersion: '4' },
      })
      const before = await snapshot(location)
      await expect(store.Open()).rejects.toMatchObject({
        code: 'unsupported-schema',
      })
      await store.Close()
      expect(await snapshot(location)).toEqual(before)
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })

  it('a schema-v2 reader opening this store finds only real messages (rollback coverage)', async () => {
    const location = await mkdtemp(join(tmpdir(), 'frank-v2-reader-'))
    let store = new LevelMessageStore(location)
    try {
      await store.Open()
      await store.saveMessage(inbound('in-500', 500))
      await store.saveMessage(wrapper('outbound-row'), {
        advanceCursor: false,
      })
      await store.suppressAndDelete(
        '0xAa',
        [],
        [{ payloadDigest: 'tombstoned' }],
      )
      await store.quarantineRelayReceipts('0xAa', [
        { payloadDigest: 'poison', receivedTime: 100 },
      ])
      await store.Close()

      // A pre-#420 build (schema v2) reopens the same location. Its Open() sees an equal
      // schema version, so it warns about nothing and continues.
      store = new LevelMessageStore(location)
      const warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      await store.Open()
      expect(warnSpy).not.toHaveBeenCalled()

      // Its iterator filters only `lastServerTime` and feeds every other row to
      // deserializeMessageWrapper. Chat restoration must not wedge: the message database
      // contains only real message rows. Run the v2 reader's exact iteration semantics.
      const db = rawDb(store, 'db')
      const rawRows = await v2ReaderRows(db)
      // level orders keys lexicographically.
      expect(rawRows.map(row => row.key)).toEqual([
        'in-500',
        'lastServerTime',
        'outbound-row',
      ])
      const restored = rawRows
        .filter(row => row.key !== 'lastServerTime')
        .map(row => deserializeMessageWrapper(row.value))
      expect(restored).toEqual([
        inbound('in-500', 500),
        wrapper('outbound-row'),
      ])
      warnSpy.mockRestore()
    } finally {
      await store.Close()
      await rm(location, { recursive: true, force: true })
    }
  })
})

describe('message store schema and mutation lifecycle', () => {
  let location: string
  let store: LevelMessageStore
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-readonly-store-'))
    store = new LevelMessageStore(location)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.Close()
    await rm(location, { recursive: true, force: true })
  })

  it.each([
    'null',
    'false',
    '0',
    '1',
    '4',
    '99',
    '"2"',
    '{}',
    '2.1',
    '1e999',
    'broken',
  ])(
    'rejects schema marker %s unchanged and releases backend ownership',
    async marker => {
      await seed(location, {
        metadata: { 'schemaVersion': marker, 'relayCursor:old': '456' },
        messages: { retained: 'original bytes' },
      })
      const before = await snapshot(location)
      await expect(store.Open()).rejects.toMatchObject({
        code: 'unsupported-schema',
      })
      await expect(store.getMessage('retained')).rejects.toMatchObject({
        code: 'unavailable',
      })
      await expect(store.saveMessage(wrapper())).rejects.toMatchObject({
        code: 'unavailable',
      })
      await expect(store.clear()).rejects.toMatchObject({ code: 'unavailable' })
      await store.Close()
      expect(await snapshot(location)).toEqual(before)
    },
  )

  it.each<StoredRows>([
    { messages: { message: serializeMessageWrapper(wrapper('message')) } },
    { messages: { lastServerTime: '0' } },
    { metadata: { 'relaySuppressionIndex:0xaa': '[]' } },
    { metadata: { 'relayQuarantineIndex:0xaa': '[]' } },
    {
      messages: { message: 'retained' },
      metadata: { 'relayCursor:0xaa': '8' },
    },
  ])(
    'rejects populated unversioned stores without repairing them: %j',
    async rows => {
      await seed(location, rows)
      const before = await snapshot(location)
      await expect(store.Open()).rejects.toMatchObject({
        code: 'unsupported-schema',
      })
      await store.Close()
      expect(await snapshot(location)).toEqual(before)
    },
  )

  it.each([undefined, '0', '123456', String(Number.MAX_SAFE_INTEGER)])(
    'reads current timestamp %s without writing',
    async time => {
      await seed(location, {
        metadata: { schemaVersion: '2' },
        messages: {
          saved: serializeMessageWrapper(inbound('saved', 456)),
          ...(time === undefined ? {} : { lastServerTime: time }),
        },
      })
      const before = await snapshot(location)
      await store.Open()
      const data = rawDb(store, 'db')
      const metadata = rawDb(store, 'metadataDb')
      const writes = [
        jest.spyOn(data, 'put'),
        jest.spyOn(data, 'batch'),
        jest.spyOn(metadata, 'put'),
        jest.spyOn(metadata, 'batch'),
      ]
      expect(await store.mostRecentMessageTime()).toBe(
        time === undefined ? 0 : Number(time),
      )
      expect(await store.getMessage('saved')).toEqual(inbound('saved', 456))
      const iterated = []
      for await (const row of await store.getIterator()) iterated.push(row)
      expect(iterated).toEqual([inbound('saved', 456)])
      expect(await store.relayCursor('0xaa')).toBe(456)
      for (const write of writes) expect(write).not.toHaveBeenCalled()
      await store.Close()
      expect(await snapshot(location)).toEqual(before)
    },
  )

  it.each(['"0"', 'null', 'false', '-1', '1.5', '1e999', '{}', 'bad'])(
    'rejects malformed timestamp %s without repair',
    async time => {
      await seed(location, {
        metadata: { schemaVersion: '2' },
        messages: { lastServerTime: time },
      })
      await store.Open()
      const put = jest.spyOn(rawDb(store, 'db'), 'put')
      await expect(store.mostRecentMessageTime()).rejects.toThrow()
      await expect(store.saveMessage(wrapper())).rejects.toThrow()
      expect(put).not.toHaveBeenCalled()
      await store.Close()
      expect(await snapshot(location)).toEqual({
        metadata: { schemaVersion: '2' },
        messages: { lastServerTime: time },
      })
    },
  )

  it('coalesces opening, refuses unvalidated lifetimes and closes outstanding iterators', async () => {
    await expect(store.getIterator()).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(store.deleteMessage('absent')).rejects.toMatchObject({
      code: 'unavailable',
    })
    const first = store.Open()
    expect(store.Open()).toBe(first)
    await first
    await store.saveMessage(wrapper())
    expect(store.Open()).toBe(first)
    const iterator = await store.getIterator()
    await iterator.next()
    const closing = store.Close()
    expect(store.Close()).toBe(closing)
    await expect(store.saveMessage(wrapper('late'))).rejects.toMatchObject({
      code: 'unavailable',
    })
    await closing
    await expect(iterator.next()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(store.Open()).rejects.toMatchObject({ code: 'unavailable' })
    store = new LevelMessageStore(location)
    await store.Open()
    expect(await store.getMessage('payload-digest')).toEqual(wrapper())
  })

  it('leaves pristine no-ops and invalid operations uninitialized', async () => {
    await store.Open()
    await store.deleteMessage('absent')
    await store.clear()
    await store.quarantineRelayReceipts('0xaa', [])
    await store.suppressAndDelete('0xaa', ['absent'], [])
    expect(
      await store.suppressedRelayReceipts('0xaa', [
        { payloadDigest: 'absent', receivedTime: 12 },
      ]),
    ).toEqual(new Set())
    await expect(
      store.quarantineRelayReceipts('0xaa', [
        { payloadDigest: 'bad', receivedTime: -1 },
      ]),
    ).rejects.toThrow()
    await expect(
      store.suppressAndDelete(
        '0xaa',
        [],
        [{ payloadDigest: 'bad', receivedTime: -1 }],
      ),
    ).rejects.toThrow()
    const bad = wrapper()
    bad.message.serverTime = NaN
    await expect(store.saveMessage(bad)).rejects.toThrow()
    await expect(
      store.saveMessage(bad, { advanceCursor: false }),
    ).rejects.toThrow()
    await store.Close()
    expect(await snapshot(location)).toEqual({ messages: {}, metadata: {} })
  })

  it.each(['save', 'save-no-cursor', 'quarantine', 'suppress'])(
    'initializes before the first %s write and reopens',
    async writer => {
      await store.Open()
      const metadata = rawDb(store, 'metadataDb')
      const marker = jest.spyOn(metadata, 'put')
      if (writer === 'save' || writer === 'save-no-cursor')
        await store.saveMessage(wrapper(), { advanceCursor: writer === 'save' })
      if (writer === 'quarantine')
        await store.quarantineRelayReceipts('0xaa', [
          { payloadDigest: 'anchored', receivedTime: 123 },
        ])
      if (writer === 'suppress')
        await store.suppressAndDelete(
          '0xaa',
          [],
          [{ payloadDigest: 'anchored' }],
        )
      expect(marker.mock.calls[0]).toEqual([
        'schemaVersion',
        '2',
        { sync: true },
      ])
      await store.Close()
      store = new LevelMessageStore(location)
      await store.Open()
      if (writer.startsWith('save')) {
        expect(await store.getMessage('payload-digest')).toEqual(wrapper())
        expect(await store.mostRecentMessageTime()).toBe(
          writer === 'save' ? 456 : 0,
        )
      } else {
        expect(await store.relayCursor('0xaa')).toBe(
          writer === 'quarantine' ? 123 : 0,
        )
        if (writer === 'suppress') {
          await store.suppressedRelayReceipts('0xaa', [
            { payloadDigest: 'anchored', receivedTime: 124 },
          ])
          expect(await store.relayCursor('0xaa')).toBe(124)
        }
      }
    },
  )

  it('serializes concurrent first writes behind the marker and preserves the message/timestamp batch', async () => {
    await store.Open()
    const metadata = rawDb(store, 'metadataDb')
    const put = metadata.put.bind(metadata)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const marker = jest
      .spyOn(metadata, 'put')
      .mockImplementationOnce(async (...args) => {
        entered()
        await gate
        await put(...args)
      })
    const batch = jest.spyOn(rawDb(store, 'db'), 'batch')
    const dataPut = jest.spyOn(rawDb(store, 'db'), 'put')
    const first = store.saveMessage(wrapper('first'))
    const second = store.saveMessage(wrapper('second'), {
      advanceCursor: false,
    })
    await started
    expect(batch).not.toHaveBeenCalled()
    expect(dataPut).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(marker).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0].map(item => item.key)).toEqual([
      'first',
      'lastServerTime',
    ])
    expect(await store.getMessage('first')).toEqual(wrapper('first'))
    expect(await store.getMessage('second')).toEqual(wrapper('second'))
  })

  it.each([false, true])(
    'holds after schema write failure (committed before error: %s)',
    async committed => {
      await store.Open()
      const metadata = rawDb(store, 'metadataDb')
      const put = metadata.put.bind(metadata)
      const cause = new Error('synthetic quota failure')
      jest.spyOn(metadata, 'put').mockImplementationOnce(async (...args) => {
        if (committed) await put(...args)
        throw cause
      })
      const batch = jest.spyOn(rawDb(store, 'db'), 'batch')
      await expect(store.saveMessage(wrapper())).rejects.toMatchObject({
        code: 'write-uncertain',
        cause,
      })
      expect(batch).not.toHaveBeenCalled()
      await expect(store.saveMessage(wrapper('later'))).rejects.toMatchObject({
        code: 'unavailable',
      })
      await expect(store.Open()).rejects.toMatchObject({ code: 'unavailable' })
      await store.Close()
      expect(await snapshot(location)).toEqual({
        messages: {},
        metadata: committed ? { schemaVersion: '2' } : {},
      })
      store = new LevelMessageStore(location)
      await store.Open()
      await store.saveMessage(wrapper('recovered'))
    },
  )

  it('keeps marker-only state after data failure and initializes again after successful clear', async () => {
    await store.Open()
    jest
      .spyOn(rawDb(store, 'db'), 'batch')
      .mockRejectedValueOnce(new Error('data unavailable'))
    await expect(store.saveMessage(wrapper())).rejects.toThrow(
      'data unavailable',
    )
    await store.Close()
    expect(await snapshot(location)).toEqual({
      messages: {},
      metadata: { schemaVersion: '2' },
    })
    store = new LevelMessageStore(location)
    await store.Open()
    await store.saveMessage(wrapper())
    await store.clear()
    await expect(
      rawDb(store, 'metadataDb').get('schemaVersion'),
    ).rejects.toMatchObject({ type: 'NotFoundError' })
    await store.saveMessage(wrapper('after-clear'), { advanceCursor: false })
    expect(await rawDb(store, 'metadataDb').get('schemaVersion')).toBe('2')
  })

  it('retains anchors when message deletion fails after their commit', async () => {
    await store.Open()
    await store.saveMessage(inbound('saved', 123))
    jest
      .spyOn(rawDb(store, 'db'), 'batch')
      .mockRejectedValueOnce(new Error('delete unavailable'))
    await expect(
      store.suppressAndDelete(
        '0xaa',
        ['saved'],
        [{ payloadDigest: 'saved', receivedTime: 123 }],
      ),
    ).rejects.toThrow('delete unavailable')
    await store.Close()
    store = new LevelMessageStore(location)
    await store.Open()
    expect(await store.getMessage('saved')).toEqual(inbound('saved', 123))
    expect(
      await store.suppressedRelayReceipts('0xaa', [
        { payloadDigest: 'saved', receivedTime: 123 },
      ]),
    ).toEqual(new Set(['saved']))
  })

  it.each(['messages', 'metadata'] as const)(
    'holds after partial %s clear without repairing surviving bytes',
    async component => {
      await store.Open()
      await store.saveMessage(wrapper())
      await store.suppressAndDelete('0xaa', [], [{ payloadDigest: 'anchor' }])
      const db = component === 'messages' ? store.db : store.metadataDb
      jest.spyOn(db, 'clear').mockImplementationOnce(async () => {
        if (component === 'metadata') await db.del('schemaVersion')
        throw new Error('clear interrupted')
      })
      await expect(store.clear()).rejects.toMatchObject({
        code: 'write-uncertain',
      })
      await expect(store.saveMessage(wrapper('new'))).rejects.toMatchObject({
        code: 'unavailable',
      })
      await store.Close()
      const before = await snapshot(location)
      store = new LevelMessageStore(location)
      if (component === 'messages') await store.Open()
      else
        await expect(store.Open()).rejects.toMatchObject({
          code: 'unsupported-schema',
        })
      await store.Close()
      expect(await snapshot(location)).toEqual(before)
    },
  )
})

describe('message store IO and cleanup boundaries', () => {
  const LevelUp = jest.requireActual('levelup')
  let location: string
  let store: LevelMessageStore
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-store-io-'))
    store = new LevelMessageStore(location)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.Close()
    await rm(location, { recursive: true, force: true })
  })

  it('observes a second backend open failure and releases the already opened database', async () => {
    await writeFile(join(location, 'metadata'), 'synthetic non-database file')
    await expect(store.Open()).rejects.toMatchObject({
      code: 'unavailable',
      cause: expect.any(Error),
    })
    await store.Close()
    expect(await readFile(join(location, 'metadata'), 'utf8')).toBe(
      'synthetic non-database file',
    )
    const first = level(join(location, 'messages'))
    try {
      expect(await v2ReaderRows(first as unknown as RawDb)).toEqual([])
    } finally {
      await first.close()
    }
  })

  it('propagates schema IO errors as causes, closes both handles, and never treats them as absence', async () => {
    const cause = new Error('read unavailable')
    const read = jest
      .spyOn(LevelUp.prototype, 'get')
      .mockRejectedValueOnce(cause)
    const close = jest.spyOn(LevelUp.prototype, 'close')
    await expect(store.Open()).rejects.toMatchObject({
      code: 'unavailable',
      cause,
    })
    expect(close).toHaveBeenCalledTimes(2)
    read.mockRestore()
    expect(await snapshot(location)).toEqual({ messages: {}, metadata: {} })
  })

  it('bounds empty-store probes and closes their iterator on IO failure', async () => {
    const createIterator = LevelUp.prototype.iterator
    const cause = new Error('iterator unavailable')
    let ended: jest.SpyInstance | undefined
    const probe = jest
      .spyOn(LevelUp.prototype, 'iterator')
      .mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
        const iterator = createIterator.apply(this, args)
        ended = jest.spyOn(iterator, 'end')
        jest
          .spyOn(iterator, 'next')
          .mockImplementationOnce((callback: unknown) => {
            ;(callback as (error: Error) => void)(cause)
          })
        return iterator
      })
    await expect(store.Open()).rejects.toMatchObject({
      code: 'unavailable',
      cause,
    })
    expect(probe).toHaveBeenCalledWith({ limit: 1, values: false })
    expect(ended).toHaveBeenCalledTimes(1)
    probe.mockRestore()
    expect(await snapshot(location)).toEqual({ messages: {}, metadata: {} })
  })

  it('does not scan current history while accepting a current marker', async () => {
    await seed(location, {
      metadata: { schemaVersion: '2' },
      messages: { malformed: 'not JSON' },
    })
    const probe = jest.spyOn(LevelUp.prototype, 'iterator')
    await store.Open()
    expect(probe).not.toHaveBeenCalled()
    const iterator = await store.getIterator()
    await expect(iterator.next()).rejects.toThrow()
    await store.Close()
    expect(await snapshot(location)).toEqual({
      metadata: { schemaVersion: '2' },
      messages: { malformed: 'not JSON' },
    })
  })

  it('preserves the validation failure if cleanup also reports an error', async () => {
    await seed(location, { metadata: { schemaVersion: '4' } })
    jest
      .spyOn(LevelUp.prototype, 'close')
      .mockRejectedValueOnce(new Error('cleanup also failed'))
    await expect(store.Open()).rejects.toMatchObject({
      code: 'unsupported-schema',
    })
    await store.Close()
    expect(await snapshot(location)).toEqual({
      messages: {},
      metadata: { schemaVersion: '4' },
    })
  })

  it('can retry explicit cleanup after a backend close failure without reopening admission', async () => {
    await store.Open()
    jest
      .spyOn(store.db, 'close')
      .mockRejectedValueOnce(new Error('close unavailable'))
    await expect(store.Close()).rejects.toThrow('close unavailable')
    await expect(store.getMessage('absent')).rejects.toMatchObject({
      code: 'unavailable',
    })
    await store.Close()
    expect(await snapshot(location)).toEqual({ messages: {}, metadata: {} })
  })

  it('does not convert timestamp IO failure to a zero or a successful write', async () => {
    await store.Open()
    const cause = new Error('timestamp read unavailable')
    jest.spyOn(rawDb(store, 'db'), 'get').mockRejectedValueOnce(cause)
    const write = jest.spyOn(rawDb(store, 'db'), 'put')
    await expect(store.mostRecentMessageTime()).rejects.toBe(cause)
    expect(write).not.toHaveBeenCalled()
    await store.Close()
    expect(await snapshot(location)).toEqual({ messages: {}, metadata: {} })
  })
})
