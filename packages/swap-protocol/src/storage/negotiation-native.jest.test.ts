import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import level from 'level/level.js'
import { inspectNegotiationJournalRecord } from '../negotiation-journal'
import { createNativeNegotiationJournalStore } from './negotiation-native'
import {
  bind,
  BINDING_KEY,
  type OwnedNegotiationJournalStore,
} from './negotiation-common'
import {
  a,
  b,
  binding,
  byteCapacity,
  emptyRow,
  engine,
  rowCapacity,
  signed,
  signedCases,
} from './storage-cases.testutil'
const io = require('node:fs/promises') as typeof fs
const nativeLevel = require('level/level.js') as typeof level
let root: string, stores: OwnedNegotiationJournalStore[]
async function owned(input = { ...binding, rootLocation: root }) {
  const store = await createNativeNegotiationJournalStore(input)
  stores.push(store)
  return store
}
async function raw(namespace: string) {
  return new Promise<ReturnType<typeof level>>((resolve, reject) => {
    const db = nativeLevel(
      join(root, namespace),
      {
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        createIfMissing: false,
        errorIfExists: false,
      },
      error => (error ? reject(error) : resolve(db)),
    )
  })
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'frank-negotiation-native-'))
  stores = []
})
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.allSettled(stores.map(store => store.close()))
  await fs.rm(root, { recursive: true, force: true })
})
jest.setTimeout(60000)
it('leaves absent reads/CAS refusals absent; rejects malformed/foreign proposals before creation and snapshots binding', async () => {
  const publicKey = Buffer.from(a),
    input = { ...binding, localPublicKey: publicKey, rootLocation: root }
  const creating = createNativeNegotiationJournalStore(input)
  publicKey.set(b)
  const store = await creating
  stores.push(store)
  const row = emptyRow(0)
  expect(await store.read(row.key)).toBeUndefined()
  expect(await store.compareAndSwap(row.key, 'missing', row.raw)).toBe(false)
  await expect(store.compareAndSwap('BAD', undefined, row.raw)).rejects.toThrow(
    'key',
  )
  await expect(store.compareAndSwap(row.key, undefined, '{}')).rejects.toThrow()
  const foreign = JSON.parse(row.raw)
  foreign.owner.accountIncarnation = 'foreign'
  const foreignRaw = JSON.stringify(foreign),
    foreignKey = inspectNegotiationJournalRecord(foreignRaw).rowKey
  await expect(
    store.compareAndSwap(foreignKey, undefined, foreignRaw),
  ).rejects.toThrow('affinity')
  await expect(
    store.compareAndSwap(row.key, undefined, ' '.repeat(262145)),
  ).rejects.toThrow()
  expect(await fs.readdir(root)).toEqual([])
  expect(await store.compareAndSwap(row.key, undefined, row.raw)).toBe(true)
  expect(await store.read(row.key)).toBe(row.raw)
})
it('runs actual signed journal admissions/CAS, duplicates and exact raw reopen', async () => {
  const store = await owned(),
    key = await signedCases(store),
    prior = await store.read(key)
  await store.close()
  const reopened = await owned()
  expect(await reopened.read(key)).toBe(prior)
  expect(
    (await engine(reopened).read()).reduction.usableAcceptance,
  ).not.toBeNull()
})
it('enforces actual128 rows across messaging chains, final-slot concurrency and updates/duplicates at capacity', async () => {
  await rowCapacity(await owned())
})
it('enforces actual8MiB UTF8 capacity without eviction and supports shrinking replacements', async () => {
  await byteCapacity(await owned())
})
it('uses Level exclusive ownership, including canonical root aliases', async () => {
  const first = await owned(),
    row = emptyRow(0)
  await first.compareAndSwap(row.key, undefined, row.raw)
  const before = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'native-child.mjs'), root],
    { cwd: join(__dirname, '../../../..'), encoding: 'utf8', timeout: 15000 },
  )
  expect(before.status).toBe(2)
  expect(before.stdout).toMatch(/lock|LOCK/)
  const second = await owned({ ...binding, rootLocation: root + '/.' })
  await expect(second.read(row.key)).rejects.toThrow(/lock|LOCK/)
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'native-child.mjs'), root],
    { cwd: join(__dirname, '../../../..'), encoding: 'utf8', timeout: 15000 },
  )
  if (child.status !== 2)
    throw new Error(
      'Native exclusion lost after duplicate open: ' +
        JSON.stringify({
          ownerNamespace: first.namespace,
          before: { status: before.status, stdout: before.stdout },
          after: { status: child.status, stdout: child.stdout },
        }),
    )
  expect(child.stdout).toMatch(/lock|LOCK/)
  await second.close()
  await first.close()
  const reopened = await owned()
  expect(await reopened.read(row.key)).toBe(row.raw)
})
it('fences every actual open/recovery and the new parent, with synchronous Level writes', async () => {
  const calls: string[] = [],
    open = io.open
  const batches = jest.spyOn(require('levelup').prototype, 'batch')
  jest
    .spyOn(io, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args),
        sync = handle.sync.bind(handle)
      handle.sync = async () => {
        calls.push(String(args[0]))
        await sync()
      }
      return handle
    })
  const store = await owned(),
    row = emptyRow(0)
  await store.compareAndSwap(row.key, undefined, row.raw)
  const location = join(await fs.realpath(root), store.namespace)
  expect(calls).toEqual([location, await fs.realpath(root)])
  expect(batches.mock.calls[0][1]).toEqual({ sync: true })
  await store.compareAndSwap(row.key, row.raw, row.raw + ' ')
  expect(batches.mock.calls[1][1]).toEqual({ sync: true })
  await store.close()
  await (await owned()).read(row.key)
  expect(calls).toEqual([location, await fs.realpath(root), location])
})
it.each([
  'metadata',
  'malformed',
  'foreign',
  'key',
  'unknown',
  'incomplete',
  'symlink',
  'layout',
])('rejects existing %s corruption without repair', async fault => {
  const store = await owned(),
    row = emptyRow(0)
  await store.compareAndSwap(row.key, undefined, row.raw)
  await store.close()
  if (fault === 'incomplete') {
    await fs.rm(join(root, store.namespace, 'CURRENT'))
  } else if (fault === 'symlink') {
    await fs.rename(join(root, store.namespace), join(root, 'moved'))
    await fs.symlink(join(root, 'moved'), join(root, store.namespace))
  } else if (fault === 'layout')
    await fs.writeFile(join(root, store.namespace, 'unexpected'), 'preserve')
  else {
    const db = await raw(store.namespace)
    let value = row.raw,
      key = row.key
    if (fault === 'metadata') {
      key = BINDING_KEY
      value = '{}'
    }
    if (fault === 'malformed') value = '{}'
    if (fault === 'foreign') {
      const parsed = JSON.parse(value)
      parsed.owner.accountIncarnation = 'foreign'
      value = JSON.stringify(parsed)
      key = inspectNegotiationJournalRecord(value).rowKey
    }
    if (fault === 'key') key = 'ab'.repeat(32)
    if (fault === 'unknown') key = 'unexpected'
    await db.batch([{ type: 'put', key, value }], { sync: true })
    await db.close()
  }
  const reopened = await owned()
  await expect(reopened.read(row.key)).rejects.toThrow()
})
it('poisons a failed directory barrier, closes acquired Level handle and permits explicit reconciliation', async () => {
  const store = await owned(),
    row = emptyRow(0),
    open = io.open
  jest
    .spyOn(io, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      handle.sync = async () => {
        throw Error('directory barrier failed')
      }
      return handle
    })
  const write = store.compareAndSwap(row.key, undefined, row.raw),
    queued = store.read(row.key)
  const results = await Promise.allSettled([write, queued])
  expect(results.map(x => x.status)).toEqual(['rejected', 'rejected'])
  await store.close()
  jest.restoreAllMocks()
  const reopened = await owned()
  expect(await reopened.read(row.key)).toBe(row.raw) // First sync:true batch committed before the barrier failure.
})
it('revokes new operations synchronously, drains admitted writes and closes once', async () => {
  const store = await owned(),
    row = emptyRow(0)
  const write = store.compareAndSwap(row.key, undefined, row.raw),
    closing = store.close()
  await expect(store.read(row.key)).rejects.toThrow('closed')
  expect(store.close()).toBe(closing)
  expect(await write).toBe(true)
  await closing
  expect(await (await owned()).read(row.key)).toBe(row.raw)
})
it('rejects incomplete schema-only namespaces instead of initializing them', async () => {
  const store = await owned(),
    location = join(root, store.namespace)
  await fs.mkdir(location)
  const db = await new Promise<ReturnType<typeof level>>((resolve, reject) => {
    const value = nativeLevel(
      location,
      {
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        createIfMissing: true,
        errorIfExists: true,
      },
      error => (error ? reject(error) : resolve(value)),
    )
  })
  await db.close()
  await expect(store.read(emptyRow(0).key)).rejects.toThrow('missing binding')
  const writer = await owned(),
    row = emptyRow(0)
  await expect(
    writer.compareAndSwap(row.key, undefined, row.raw),
  ).rejects.toThrow('missing binding')
  await writer.close()
  const persisted = await raw(store.namespace),
    entries = []
  for await (const entry of persisted.iterator()) entries.push(entry)
  expect(entries).toEqual([])
  await persisted.close()
})

it('rejects a lost write acknowledgment, poisons queued work and reopens original signed evidence', async () => {
  const store = await owned(),
    events = await signed(),
    journal = engine(store)
  const prototype = require('levelup').prototype,
    original = prototype.batch
  let entered!: () => void, release!: () => void
  const committed = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  jest
    .spyOn(prototype, 'batch')
    .mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
      await original.apply(this, args)
      entered()
      await gate
      throw new Error('lost durable write acknowledgment')
    })
  const admission = journal.admit(events.offer)
  await committed
  const queued = store.read(journal.rowKey)
  release()
  const outcomes = await Promise.allSettled([admission, queued])
  expect(outcomes.map(value => value.status)).toEqual(['rejected', 'rejected'])
  await store.close()
  jest.restoreAllMocks()
  const reopened = await owned(),
    restored = engine(reopened)
  expect((await restored.read()).entries[0].eventBytes).toEqual(
    events.offer.eventBytes,
  )
  expect((await restored.admit(events.offer)).admission).toBe('duplicate')
})

it('retains its own exclusion token on failed acquired-handle cleanup until explicit close succeeds', async () => {
  const store = await owned(),
    row = emptyRow(0),
    open = io.open
  jest
    .spyOn(io, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      handle.sync = async () => {
        throw Error('barrier fault')
      }
      return handle
    })
  jest
    .spyOn(require('levelup').prototype, 'close')
    .mockImplementationOnce(() => Promise.reject(new Error('close fault')))
  const error = await store
    .compareAndSwap(row.key, undefined, row.raw)
    .catch(error => error)
  expect(String(error.original)).toContain('barrier fault')
  expect(String(error.cleanup)).toContain('close fault')
  const duplicate = await owned()
  await expect(duplicate.read(row.key)).rejects.toThrow('already owned')
  await duplicate.close()
  jest.restoreAllMocks()
  await store.close()
  const restored = await owned()
  expect(await restored.read(row.key)).toBe(row.raw)
})
it('requires an existing approved root and refuses a symlink root without creating defaults', async () => {
  await expect(
    owned({ ...binding, rootLocation: join(root, 'missing') }),
  ).rejects.toThrow()
  await fs.symlink(root, join(root, 'alias'))
  await expect(
    owned({ ...binding, rootLocation: join(root, 'alias') }),
  ).rejects.toThrow('root')
  expect((await fs.readdir(root)).sort()).toEqual(['alias'])
})

it('preserves directory-sync and file-close failures while releasing acquired Level ownership', async () => {
  const store = await owned(),
    row = emptyRow(0),
    open = io.open
  jest
    .spyOn(io, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args),
        close = handle.close.bind(handle)
      handle.sync = async () => {
        throw new Error('sync failed')
      }
      handle.close = async () => {
        await close()
        throw new Error('directory file close failed')
      }
      return handle
    })
  const failure = await store
    .compareAndSwap(row.key, undefined, row.raw)
    .catch(error => error)
  expect(String(failure.original)).toContain('sync failed')
  expect(String(failure.cleanup)).toContain('directory file close failed')
  await store.close()
  jest.restoreAllMocks()
  expect(await (await owned()).read(row.key)).toBe(row.raw)
})
