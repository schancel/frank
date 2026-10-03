import { openBrowserDirectoryStore } from '../src/browser'
import { runOwnership } from './ownership-cases'
import {
  anchor,
  candidate,
  context,
  runCorpus,
  facadeRegressions,
  checkpointRegressions,
  equal,
  rejects,
  assert,
} from './shared'

const stores = new Map()
const nativeTransaction = IDBDatabase.prototype.transaction
const nativePut = IDBObjectStore.prototype.put
const complete = Object.getOwnPropertyDescriptor(
  IDBTransaction.prototype,
  'oncomplete',
)
let fault = null
globalThis.commitBarrier = null
globalThis.snapshotReady = false
globalThis.releaseSnapshot = null
IDBDatabase.prototype.transaction = function (...args) {
  const transaction = nativeTransaction.apply(this, args)
  if (args[1] === 'readonly' && fault === 'snapshot') {
    Object.defineProperty(transaction, 'oncomplete', {
      set(handler) {
        complete.set.call(transaction, () => {
          globalThis.snapshotReady = true
          globalThis.releaseSnapshot = () => {
            fault = null
            handler.call(transaction)
          }
        })
      },
    })
  }
  if (args[1] === 'readwrite') {
    if (fault === 'durability')
      Object.defineProperty(transaction, 'durability', { value: 'relaxed' })
    if (fault === 'after') {
      Object.defineProperty(transaction, 'oncomplete', {
        set() {
          complete.set.call(transaction, () => {
            globalThis.commitBarrier = 'after'
          })
        },
      })
    }
  }
  return transaction
}
IDBObjectStore.prototype.put = function (...args) {
  if (fault === 'quota')
    throw new DOMException('injected quota exhaustion', 'QuotaExceededError')
  if (fault === 'before') {
    this.transaction.abort()
    globalThis.commitBarrier = 'before'
    throw new DOMException('injected before-commit abort', 'AbortError')
  }
  return nativePut.apply(this, args)
}
const pack = value =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? { bigint: item.toString() }
      : item instanceof Uint8Array
      ? { bytes: Array.from(item) }
      : item,
  )
const unpack = value =>
  JSON.parse(value, (_, item) =>
    item && typeof item === 'object' && Object.keys(item).length === 1
      ? 'bigint' in item
        ? BigInt(item.bigint)
        : 'bytes' in item
        ? Uint8Array.from(item.bytes)
        : item
      : item,
  )
const factory = (name, installed, mode) =>
  openBrowserDirectoryStore({ name, anchor: installed, mode })
async function raw(name, mutate) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = nativeTransaction.call(db, 'records', 'readwrite', {
        durability: 'strict',
      })
      const objectStore = transaction.objectStore('records')
      const request = objectStore.getAllKeys()
      request.onsuccess = () => mutate(objectStore, request.result)
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}
async function supplemental() {
  for (const kind of ['quota', 'before']) {
    const name = `failure-${kind}`
    let store = await factory(name, anchor(), { kind: 'new' })
    await store.enroll([candidate('bootstrap'), candidate('renew')], context())
    const before = await store.status()
    fault = kind
    try {
      await rejects(
        () => store.advance([candidate('rotate-stamp')], context()),
        'unavailable',
        `${kind} cannot acknowledge`,
      )
    } finally {
      fault = null
      await store.close()
    }
    store = await factory(name, anchor(), {
      kind: 'reopen',
      checkpoint: before.checkpoint,
    })
    equal(await store.status(), before, `${kind} leaves full prior state`)
    await store.close()
  }
  fault = 'durability'
  try {
    await rejects(
      () => factory('unsupported-strict', anchor(), { kind: 'new' }),
      'unavailable',
      'unsupported reported strict durability fails closed',
    )
  } finally {
    fault = null
  }
  for (const kind of ['format', 'missing', 'head', 'truncated']) {
    const name = `corrupt-${kind}`
    const store = await factory(name, anchor(), { kind: 'new' })
    await store.enroll(
      ['bootstrap', 'renew', 'rotate-stamp'].map(candidate),
      context(),
    )
    const before = await store.status()
    await store.close()
    await raw(name, (rows, keys) => {
      const evidence = keys.filter(key => key.startsWith('e:'))
      equal(evidence.length, 3, 'IndexedDB stores one evidence row per record')
      assert(keys.length <= 6, 'IndexedDB linear retained layout')
      if (kind === 'format') rows.put('directory-admission-v999', 'format')
      if (kind === 'missing') rows.delete(evidence[0])
      if (kind === 'head') rows.put('{}', 'head')
      if (kind === 'truncated') rows.put('{', evidence[0])
    })
    await rejects(
      () =>
        factory(name, anchor(), {
          kind: 'reopen',
          checkpoint: before.checkpoint,
        }),
      'unavailable',
      `reject corrupt ${kind}`,
    )
  }
  const deletion = await factory('deleted', anchor(), { kind: 'new' })
  await deletion.enroll([candidate('bootstrap')], context())
  const before = await deletion.status()
  await deletion.close()
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('deleted')
    request.onsuccess = resolve
    request.onerror = () => reject(request.error)
  })
  await rejects(
    () =>
      factory('deleted', anchor(), {
        kind: 'reopen',
        checkpoint: before.checkpoint,
      }),
    'unavailable',
    'eviction never silently reenrolls',
  )
  equal(
    (await indexedDB.databases()).some(db => db.name === 'deleted'),
    false,
    'failed reopen never creates deleted database',
  )
  return { failures: 3, corruption: 4, eviction: 1 }
}
async function dispatch(command) {
  if (command.action === 'ownership')
    return runOwnership(factory, command.selected)
  if (command.action === 'corpus')
    return {
      ...(await runCorpus(factory)),
      ...(await facadeRegressions(factory)),
      ...(await checkpointRegressions(factory)),
      ...(await supplemental()),
    }
  if (command.action === 'open') {
    const mode = command.checkpoint
      ? { kind: 'reopen', checkpoint: unpack(command.checkpoint) }
      : { kind: 'new' }
    const store = await factory(command.name, anchor(), mode)
    stores.set(command.handle, store)
    return true
  }
  if (command.action === 'fault') {
    fault = command.value
    globalThis.commitBarrier = null
    globalThis.snapshotReady = false
    return true
  }
  const store = stores.get(command.handle)
  assert(store, `missing handle ${command.handle}`)
  if (command.action === 'close') {
    await store.close()
    stores.delete(command.handle)
    return true
  }
  if (command.action === 'status') return store.status()
  if (command.action === 'evidence') {
    const status = await store.status()
    return store.historicalEvidence(status.head)
  }
  const ctx = context(command.seconds || '1700000100')
  if (command.nanos) ctx.now.nanoseconds = command.nanos
  if (command.action === 'current') return store.current(ctx)
  return store[command.action](command.ids.map(candidate), ctx)
}
globalThis.directoryTests = {
  async run(command) {
    try {
      return { ok: true, value: pack(await dispatch(command)) }
    } catch (error) {
      return {
        ok: false,
        code: error.code,
        error: error.stack || String(error),
      }
    }
  },
}
