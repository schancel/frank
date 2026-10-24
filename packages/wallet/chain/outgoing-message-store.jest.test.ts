import { mkdtempSync, rmSync } from 'fs'
import level, { type LevelDB } from 'level'
import { tmpdir } from 'os'
import { join } from 'path'

import * as durability from '../storage/level-durability'
import { LevelOutgoingMessageStore } from './canonical-dm'

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

type Row = Parameters<LevelOutgoingMessageStore['put']>[0]

const NAMESPACE = 'outgoing-messages-v1'

function row(id: string, extra: Partial<Row> = {}): Row {
  return {
    version: 1,
    consumerId: `frank-dm:${id}`,
    digest: `digest-${id}`,
    recipientSubject: '02' + 'ab'.repeat(32),
    request: { body: '0a0b', contentType: 'multipart/form-data; boundary=x' },
    payments: [
      { index: 3, address: '0x' + '0a'.repeat(20), rawTx: '0x02', state: 'pending' },
    ],
    otherTransactions: [],
    createdAt: 1_700_000_000_000,
    ...extra,
  }
}
function sharedRow(id: string): Row {
  return {
    ...row(id, {
      version: 2,
      digest: 'a'.repeat(64),
      recipientSubject: '02' + 'ab'.repeat(32),
      payments: [
        {
          index: 3,
          address: '0x' + '0a'.repeat(20),
          rawTx: '0x02',
          state: 'pending',
          source: 'coin',
        },
      ],
      transactionSetOperationId: `stamp-${id}`,
      otherTransactions: [],
      construction: {
        network: 'monad-testnet',
        payload: '02',
        context: '03',
        amountWei: '1',
        boundary: 'frank-' + '0a'.repeat(24),
      },
    }),
  }
}
const key = (id: string) => `frank-dm:${id}`

function handle(store: LevelOutgoingMessageStore): LevelDB {
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

describe('LevelOutgoingMessageStore: the durable record of sent messages', () => {
  let location: string
  let opened: LevelOutgoingMessageStore[]

  async function open(): Promise<LevelOutgoingMessageStore> {
    const store = await LevelOutgoingMessageStore.open(location)
    opened.push(store)
    return store
  }

  async function close(store: LevelOutgoingMessageStore): Promise<void> {
    opened.splice(opened.indexOf(store), 1)
    await store.close()
  }

  beforeEach(() => {
    location = mkdtempSync(join(tmpdir(), 'frank-outgoing-messages-'))
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

  it('writes every message with the durable write options', async () => {
    const store = await open()
    const put = jest.spyOn(handle(store), 'put')
    const first = row('attempt-a')

    await store.put(first)
    await store.put({ ...first, outcome: 'delivered', accounted: true })

    expect(put.mock.calls).toEqual([
      [key('attempt-a'), JSON.stringify(first), { sync: true }],
      [
        key('attempt-a'),
        JSON.stringify({ ...first, outcome: 'delivered', accounted: true }),
        { sync: true },
      ],
    ])
    for (const call of put.mock.calls)
      expect(call[2]).toBe(durability.DURABLE_LEVEL_WRITE_OPTIONS)
  })

  it('stores one JSON row per message, keyed by its message identity', async () => {
    const store = await open()
    const link = row('attempt-a', { outcome: 'dead', reason: 'rejected' })
    await store.put(link)
    expect(store.get(key('attempt-a'))).toEqual(link)
    expect(store.get(key('attempt-b'))).toBeUndefined()
    await close(store)

    expect(await rawEntries(location)).toEqual([
      [key('attempt-a'), JSON.stringify(link)],
    ])
  })

  it('refuses a record it does not understand, naming the development reset, and holds no handle', async () => {
    const old = level(join(location, NAMESPACE))
    await old.put(key('attempt-a'), JSON.stringify({ ...row('attempt-a'), version: 0 }))
    await old.close()

    await expect(LevelOutgoingMessageStore.open(location)).rejects.toThrow(
      /Unsupported sent-message record in outgoing-messages-v1\. Development reset: close the wallet and delete that directory \(it holds no keys\)/,
    )

    // The handle was closed: the directory can be opened (or deleted) again.
    const again = level(join(location, NAMESPACE))
    await again.close()
  })

  it('returns written rows after close and reopen', async () => {
    const store = await open()
    const links = [row('attempt-a'), row('attempt-b', { outcome: 'delivered' })]
    for (const link of links) await store.put(link)
    await close(store)

    const reopened = await open()

    expect(reopened.all()).toEqual(links)
  })

  it('validates v2 transaction-set facts on reopen and closes an invalid store', async () => {
    const invalid = sharedRow('shared-a')
    invalid.otherTransactions = undefined as never
    const old = level(join(location, NAMESPACE))
    await old.put(key('shared-a'), JSON.stringify(invalid))
    await old.close()

    await expect(LevelOutgoingMessageStore.open(location)).rejects.toThrow(
      'Invalid shared transaction-set sent-message record',
    )
    const repair = level(join(location, NAMESPACE))
    await repair.put(key('shared-a'), JSON.stringify(sharedRow('shared-a')))
    await repair.close()
    const reopened = await open()
    expect(reopened.get(key('shared-a'))).toEqual(sharedRow('shared-a'))
  })

  it('interprets an absent v1 otherTransactions field as no stored change, without rewriting it', async () => {
    const legacy = row('legacy-a')
    const { otherTransactions: _derived, ...persisted } = legacy
    const old = level(join(location, NAMESPACE))
    await old.put(key('legacy-a'), JSON.stringify(persisted))
    await old.close()

    const reopened = await open()
    expect(reopened.get(key('legacy-a'))?.otherTransactions).toEqual([])
    await close(reopened)
    expect(await rawEntries(location)).toEqual([
      [key('legacy-a'), JSON.stringify(persisted)],
    ])
  })

  it('keeps an unpaid envelope by message ID across close and reopen, apart from the links, until it is dropped', async () => {
    const envelope = {
      digest: 'aa',
      delivery: '0102',
      context: '03',
      recipientSubject: '02ff',
      boundary: 'frank-' + '0a'.repeat(24),
    }
    const first = await LevelOutgoingMessageStore.open(location)
    await first.put(row('a'))
    await first.setUnpaid('00112233', envelope)
    await first.close()

    const second = await LevelOutgoingMessageStore.open(location)
    expect(second.unpaid('00112233')).toEqual(envelope)
    expect(second.unpaid('other')).toBeUndefined()
    // Not a sent-message record: the payment workflow never sees it.
    expect(second.all().map(r => r.consumerId)).toEqual([key('a')])
    await second.setUnpaid('00112233', undefined)
    await second.close()

    const third = await LevelOutgoingMessageStore.open(location)
    expect(third.unpaid('00112233')).toBeUndefined()
    expect(third.all()).toHaveLength(1)
    await third.close()
  })

  it('preserves a staged v2 recipient/change record and its exact stored bytes across reopen', async () => {
    const staged: Row = {
      ...sharedRow('staged'),
      transactionSetOperationId: 'payment-original',
      transactionSetStageId: 'stamp-staged',
      paymentOperationId: 'payment-original',
      exposurePending: true,
      otherTransactions: [
        {
          source: 'coin',
          address: '0x' + '0b'.repeat(20),
          rawTx: '0x0304',
          state: 'pending',
        },
      ],
    }
    // Capture expectations before the writer can mutate its input.
    const expectedBytes = JSON.stringify(staged)
    const expectedRow = JSON.parse(expectedBytes) as Row
    const expected = [[key('staged'), expectedBytes]]
    const store = await open()
    await store.put(staged)
    await close(store)

    expect(await rawEntries(location)).toEqual(expected)
    const reopened = await open()
    expect(reopened.get(key('staged'))).toEqual(expectedRow)
    await close(reopened)
    // Hydration must not rewrite the stored intent, barrier or either signed-byte list.
    expect(await rawEntries(location)).toEqual(expected)
  })

  it.each(['write', 'delete'] as const)(
    'retains a host-bound free envelope in memory and on disk when its %s fails',
    async (operation) => {
      const envelope = {
        digest: 'aa',
        delivery: '0102',
        context: '03',
        recipientSubject: '02ff',
        boundary: 'frank-' + '0a'.repeat(24),
        hostBound: true as const,
        exposurePending: true as const,
      }
      const store = await open()
      await store.setUnpaid('stable-message', envelope)
      const failure = new Error('durable envelope mutation refused')
      const mutation =
        operation === 'write'
          ? jest.spyOn(handle(store), 'put').mockRejectedValue(failure)
          : jest.spyOn(handle(store), 'del').mockRejectedValue(failure)

      await expect(
        store.setUnpaid(
          'stable-message',
          operation === 'write'
            ? { ...envelope, exposurePending: undefined }
            : undefined,
        ),
      ).rejects.toBe(failure)
      expect(store.unpaid('stable-message')).toEqual(envelope)
      expect(store.unpaidByDigest('aa')).toEqual({
        ...envelope,
        messageId: 'stable-message',
      })
      mutation.mockRestore()
      await close(store)

      const reopened = await open()
      expect(reopened.unpaid('stable-message')).toEqual(envelope)
      expect(reopened.unpaidByDigest('aa')).toEqual({
        ...envelope,
        messageId: 'stable-message',
      })
    },
  )

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
    await legacy.put(key('attempt-a'), 'not-json')
    await legacy.close()

    await expect(LevelOutgoingMessageStore.open(location)).rejects.toBeInstanceOf(
      SyntaxError,
    )

    const repair = level(join(location, NAMESPACE))
    await repair.put(key('attempt-a'), JSON.stringify(row('attempt-a')))
    await repair.close()
    const store = await open()
    expect(store.all()).toEqual([row('attempt-a')])
  })
})
