import { mkdtempSync, rmSync } from 'fs'
import level, { type LevelDB } from 'level'
import { tmpdir } from 'os'
import { join } from 'path'

import * as durability from '../storage/level-durability'
import { LevelCanonicalLinkStore } from './monad-canonical-dm'

// The real helpers run; the opener is only wrapped so the suite can see that it was the code path.
jest.mock('../storage/level-durability', () => {
  const actual = jest.requireActual<
    typeof import('../storage/level-durability')
  >('../storage/level-durability')
  return {
    ...actual,
    openDurableLevel: jest.fn(actual.openDurableLevel),
  }
})

type Row = Parameters<LevelCanonicalLinkStore['put']>[0]

const NAMESPACE = 'canonical-dm-workflow-links'

function row(attemptRef: string, extra: Partial<Row> = {}): Row {
  return {
    digest: `digest-${attemptRef}`,
    attemptRef,
    consumerId: `consumer-${attemptRef}`,
    prepared: { payload: '0a0b', context: '0c', economicBinding: '0d' },
    createdAt: 1_700_000_000_000,
    ...extra,
  }
}

function handle(store: LevelCanonicalLinkStore): LevelDB {
  return (store as unknown as { db: LevelDB }).db
}

async function rawEntries(location: string): Promise<Array<[string, string]>> {
  const database = level(join(location, NAMESPACE))
  const entries: Array<[string, string]> = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [key, value] of database.iterator({}) as any)
      entries.push([key, value])
  } finally {
    await database.close()
  }
  return entries
}

describe('LevelCanonicalLinkStore durability', () => {
  let location: string
  let opened: LevelCanonicalLinkStore[]

  async function open(): Promise<LevelCanonicalLinkStore> {
    const store = await LevelCanonicalLinkStore.open(location)
    opened.push(store)
    return store
  }

  async function close(store: LevelCanonicalLinkStore): Promise<void> {
    opened.splice(opened.indexOf(store), 1)
    await store.close()
  }

  beforeEach(() => {
    location = mkdtempSync(join(tmpdir(), 'frank-canonical-links-'))
    opened = []
    jest.mocked(durability.openDurableLevel).mockClear()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const store of opened) await store.close()
    rmSync(location, { recursive: true, force: true })
  })

  it('opens its namespace through the durable opener', async () => {
    const store = await open()

    expect(durability.openDurableLevel).toHaveBeenCalledTimes(1)
    expect(durability.openDurableLevel).toHaveBeenCalledWith(
      handle(store),
      location,
      NAMESPACE,
    )
  })

  it('writes every link with the durable write options', async () => {
    const store = await open()
    const put = jest.spyOn(handle(store), 'put')
    const first = row('attempt-a')

    await store.put(first)
    await store.put({ ...first, outcome: 'delivered', acknowledged: true })

    expect(put.mock.calls).toEqual([
      ['attempt-a', JSON.stringify(first), { sync: true }],
      [
        'attempt-a',
        JSON.stringify({ ...first, outcome: 'delivered', acknowledged: true }),
        { sync: true },
      ],
    ])
    for (const call of put.mock.calls)
      expect(call[2]).toBe(durability.DURABLE_LEVEL_WRITE_OPTIONS)
  })

  it('keeps the stored key and value format unchanged', async () => {
    const store = await open()
    const link = row('attempt-a', { outcome: 'dead', reason: 'rejected' })
    await store.put(link)
    await close(store)

    expect(await rawEntries(location)).toEqual([
      ['attempt-a', JSON.stringify(link)],
    ])
  })

  it('opens a store written by the earlier plain Level path and returns identical rows', async () => {
    const legacyRows = [
      row('attempt-b', { outcome: 'delivered', accounted: true }),
      row('attempt-a', { putAttempts: 2, lastPutAttemptAt: 1_700_000_000_500 }),
      row('attempt-c', { outcome: 'dead', reason: 'relay-rejected' }),
    ]
    const legacy = level(join(location, NAMESPACE))
    for (const legacyRow of legacyRows)
      await legacy.put(legacyRow.attemptRef, JSON.stringify(legacyRow))
    await legacy.close()

    const store = await open()

    // Rows load in key order, exactly as the earlier open loop produced them.
    expect(store.all()).toEqual([legacyRows[1], legacyRows[0], legacyRows[2]])

    const updated = { ...legacyRows[0], acknowledged: true }
    await store.put(updated)
    await close(store)
    const reopened = await open()
    expect(reopened.all()).toEqual([legacyRows[1], updated, legacyRows[2]])
  })

  it('returns written rows after close and reopen', async () => {
    const store = await open()
    const links = [row('attempt-a'), row('attempt-b', { outcome: 'delivered' })]
    for (const link of links) await store.put(link)
    await close(store)

    const reopened = await open()

    expect(reopened.all()).toEqual(links)
  })

  it('keeps an unpaid envelope by message ID across close and reopen, apart from the links, until it is dropped', async () => {
    const envelope = {
      digest: 'aa',
      delivery: '0102',
      context: '03',
      recipientSubject: '02ff',
    }
    const first = await LevelCanonicalLinkStore.open(location)
    await first.put(row('a'))
    await first.setUnpaid('00112233', envelope)
    await first.close()

    const second = await LevelCanonicalLinkStore.open(location)
    expect(second.unpaid('00112233')).toEqual(envelope)
    expect(second.unpaid('other')).toBeUndefined()
    // Not a link: the payment workflow never sees it.
    expect(second.all().map(r => r.attemptRef)).toEqual(['a'])
    await second.setUnpaid('00112233', undefined)
    await second.close()

    const third = await LevelCanonicalLinkStore.open(location)
    expect(third.unpaid('00112233')).toBeUndefined()
    expect(third.all()).toHaveLength(1)
    await third.close()
  })

  it('lists rows in first-write order, keeps a rewritten row in place, and returns copies', async () => {
    const store = await open()
    const second = row('attempt-b')
    const first = row('attempt-a')
    await store.put(second)
    await store.put(first)
    const rewritten = { ...second, outcome: 'delivered' as const }
    await store.put(rewritten)

    expect(store.all()).toEqual([rewritten, first])

    // The store keeps its own copy of a written row.
    rewritten.reason = 'mutated-by-caller'
    expect(store.all()[0]).toEqual({ ...second, outcome: 'delivered' })
  })

  it('rejects to the caller and leaves memory unchanged when the durable write rejects', async () => {
    const store = await open()
    const kept = row('attempt-a')
    await store.put(kept)
    const failure = new Error('stable storage refused the write')
    const put = jest.spyOn(handle(store), 'put').mockRejectedValue(failure)

    // Neither a new row nor a rewrite of an existing row reaches memory.
    await expect(store.put(row('attempt-b'))).rejects.toBe(failure)
    await expect(store.put({ ...kept, outcome: 'dead' })).rejects.toBe(failure)

    expect(put.mock.calls.map((call) => call[2])).toEqual([
      { sync: true },
      { sync: true },
    ])
    expect(store.all()).toEqual([kept])
    await close(store)
    const reopened = await open()
    expect(reopened.all()).toEqual([kept])
  })

  it('closes the handle when the stored rows cannot be read, so the namespace can reopen', async () => {
    const legacy = level(join(location, NAMESPACE))
    await legacy.put('attempt-a', 'not-json')
    await legacy.close()

    await expect(LevelCanonicalLinkStore.open(location)).rejects.toBeInstanceOf(
      SyntaxError,
    )

    const repair = level(join(location, NAMESPACE))
    await repair.put('attempt-a', JSON.stringify(row('attempt-a')))
    await repair.close()
    const store = await open()
    expect(store.all()).toEqual([row('attempt-a')])
  })
})
