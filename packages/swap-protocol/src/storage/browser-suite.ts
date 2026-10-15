import { inspectNegotiationJournalRecord } from '../negotiation-journal'
import { createBrowserNegotiationJournalStore } from './negotiation-browser'
import {
  BINDING_KEY,
  RECORDS_STORE,
  type OwnedNegotiationJournalStore,
} from './negotiation-common'
import {
  a,
  b,
  assert,
  binding,
  byteCapacity,
  emptyRow,
  engine,
  rejects,
  rowCapacity,
  signed,
  signedCases,
} from './storage-cases.testutil'

type Fault = 'schema-gap' | 'strict' | 'lost-ack' | null
let fault: Fault = null
const flags: Record<string, unknown> = {}
;(
  globalThis as typeof globalThis & { negotiationTest: typeof flags }
).negotiationTest = flags
const nativeOpen = IDBFactory.prototype.open
const success = Object.getOwnPropertyDescriptor(
  IDBRequest.prototype,
  'onsuccess',
)!
const complete = Object.getOwnPropertyDescriptor(
  IDBTransaction.prototype,
  'oncomplete',
)!
const nativeTransaction = IDBDatabase.prototype.transaction
IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
  flags.openedName = args[0]
  const request = nativeOpen.apply(this, args)
  if (fault === 'schema-gap')
    Object.defineProperty(request, 'onsuccess', {
      set(handler: (event: Event) => void) {
        success.set!.call(request, (event: Event) => {
          flags.schemaReady = true
          flags.releaseSchema = () => {
            fault = null
            handler.call(request, event)
          }
        })
      },
    })
  return request
}
IDBDatabase.prototype.transaction = function (
  ...args: Parameters<IDBDatabase['transaction']>
) {
  const tx = nativeTransaction.apply(this, args)
  if (args[1] === 'readwrite' && fault === 'strict')
    Object.defineProperty(tx, 'durability', { value: 'relaxed' })
  if (args[1] === 'readwrite' && fault === 'lost-ack')
    Object.defineProperty(tx, 'oncomplete', {
      set() {
        complete.set!.call(tx, () => {
          flags.ackReady = true
          flags.releaseAck = () => {
            fault = null
            tx.onabort?.call(tx, new Event('abort'))
          }
        })
      },
    })
  return tx
}
const stores: OwnedNegotiationJournalStore[] = []
function owned(name: string, key = a): OwnedNegotiationJournalStore {
  const store = createBrowserNegotiationJournalStore({
    ...binding,
    hostDiscriminator: name,
    localPublicKey: key,
  })
  stores.push(store)
  return store
}
async function closeAll() {
  await Promise.all(stores.splice(0).map(store => store.close()))
}
async function raw(
  name: string,
  change?: (store: IDBObjectStore) => void,
): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
          RECORDS_STORE,
          change ? 'readwrite' : 'readonly',
          change ? { durability: 'strict' } : undefined,
        ),
        store = tx.objectStore(RECORDS_STORE)
      let rows: unknown[] = []
      const request = store.getAll()
      request.onsuccess = () => {
        rows = request.result
      }
      change?.(store)
      tx.oncomplete = () => resolve(rows)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let tries = 0
    const poll = () => {
      if (check()) resolve()
      else if (++tries > 500)
        reject(new Error('Browser barrier did not arrive'))
      else setTimeout(poll, 10)
    }
    poll()
  })
}
export async function run(phase: string): Promise<Record<string, unknown>> {
  if (phase === 'stage') {
    const store = owned('committed'),
      key = await signedCases(store)
    flags.namespace = store.namespace
    // Keep the qualified connection open until the harness kills this Chrome process.
    return { key, namespace: store.namespace }
  }
  if (phase === 'reopen') {
    const store = owned('committed'),
      journal = engine(store),
      snapshot = await journal.read()
    assert(
      snapshot.entries.length === 2 &&
        snapshot.reduction.usableAcceptance !== null,
      'Killed process lost committed signed evidence',
    )
    await closeAll()
    return { entries: snapshot.entries.length }
  }
  if (phase === 'regressions') {
    const inventory = JSON.stringify(await indexedDB.databases()),
      absent = owned('absent'),
      row = emptyRow(0)
    assert((await absent.read(row.key)) === undefined)
    assert(!(await absent.compareAndSwap(row.key, 'missing', row.raw)))
    await rejects(() => absent.compareAndSwap('BAD', undefined, row.raw), 'key')
    await rejects(() => absent.compareAndSwap(row.key, undefined, '{}'))
    const foreign = JSON.parse(row.raw)
    foreign.owner.accountIncarnation = 'foreign'
    const foreignRaw = JSON.stringify(foreign)
    await rejects(
      () =>
        absent.compareAndSwap(
          inspectNegotiationJournalRecord(foreignRaw).rowKey,
          undefined,
          foreignRaw,
        ),
      'affinity',
    )
    await rejects(() =>
      absent.compareAndSwap(row.key, undefined, ' '.repeat(262145)),
    )
    assert(
      JSON.stringify(await indexedDB.databases()) === inventory,
      'Absent/invalid operations created a database',
    )
    assert(await absent.compareAndSwap(row.key, undefined, row.raw))
    await absent.close()
    const live = owned('signed')
    await signedCases(live)
    await rowCapacity(owned('row-capacity'))
    await byteCapacity(owned('byte-capacity'))
    // Strict refusal applies to the FIRST row commit, not an empty later probe.
    fault = 'strict'
    const strict = owned('strict-refused')
    await rejects(
      () => strict.compareAndSwap(row.key, undefined, row.raw),
      'Strict',
    )
    fault = null
    await strict.close()
    const refused = owned('strict-refused')
    await rejects(() => refused.read(row.key), 'missing binding')
    await refused.close()
    assert((await raw(strict.namespace)).length === 0)
    // A successful reopen must perform readonly inspection only.
    let writes = 0
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      if (args[1] === 'readwrite') writes++
      return nativeTransaction.apply(this, args)
    }
    const reopening = owned('signed')
    await reopening.read(engine(reopening).rowKey)
    assert(writes === 0, 'Reopen performed a write capability probe')
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      const tx = nativeTransaction.apply(this, args)
      return tx
    }
    await closeAll()
    return {
      actualRows: 128,
      actualBytes: 8388608,
      strictFirstCommit: 'refused',
      reopenWrites: writes,
    }
  }
  if (phase === 'corruption') {
    const row = emptyRow(0)
    for (const kind of [
      'metadata',
      'malformed',
      'missing',
      'foreign',
      'key',
      'unknown',
      'store',
      'version',
    ]) {
      const store = owned('corrupt-' + kind)
      await store.compareAndSwap(row.key, undefined, row.raw)
      await store.close()
      if (kind === 'store' || kind === 'version') {
        const request = indexedDB.open(store.namespace, 2)
        await new Promise<void>((resolve, reject) => {
          request.onupgradeneeded = () => {
            if (kind === 'store') request.result.createObjectStore('unexpected')
          }
          request.onsuccess = () => {
            request.result.close()
            resolve()
          }
          request.onerror = () => reject(request.error)
        })
      } else
        await raw(store.namespace, records => {
          if (kind === 'metadata') records.put('{}', BINDING_KEY)
          if (kind === 'malformed') records.put('{}', row.key)
          if (kind === 'missing') records.delete(BINDING_KEY)
          if (kind === 'foreign') {
            const foreign = JSON.parse(row.raw)
            foreign.owner.accountIncarnation = 'foreign'
            const foreignRaw = JSON.stringify(foreign)
            records.put(
              foreignRaw,
              inspectNegotiationJournalRecord(foreignRaw).rowKey,
            )
          }
          if (kind === 'key') records.put(row.raw, 'ab'.repeat(32))
          if (kind === 'unknown') records.put(row.raw, 'unexpected')
        })
      const reopened = owned('corrupt-' + kind)
      await rejects(() => reopened.read(row.key))
      await reopened.close()
    }
    for (const config of ['keyPath', 'autoIncrement', 'index']) {
      const store = owned('store-config-' + config)
      const request = indexedDB.open(store.namespace, 1)
      await new Promise<void>((resolve, reject) => {
        request.onupgradeneeded = () => {
          const records = request.result.createObjectStore(
            RECORDS_STORE,
            config === 'keyPath'
              ? { keyPath: 'id' }
              : config === 'autoIncrement'
              ? { autoIncrement: true }
              : undefined,
          )
          if (config === 'index') records.createIndex('unexpected', 'field')
        }
        request.onsuccess = () => {
          request.result.close()
          resolve()
        }
        request.onerror = () => reject(request.error)
      })
      await rejects(() => store.read(row.key), 'records store')
      await store.close()
    }
    await closeAll()
    return { corruptions: 11 }
  }
  if (phase === 'independent-init') {
    const store = owned('independent'),
      row = emptyRow(0)
    await store.compareAndSwap(row.key, undefined, row.raw)
    await closeAll()
    return { key: row.key }
  }
  if (phase === 'independent-cas') {
    const store = owned('independent'),
      row = emptyRow(0)
    const won = await store.compareAndSwap(row.key, row.raw, row.raw + ' ')
    await closeAll()
    return { won }
  }
  if (phase === 'page-capacity-init') {
    const store = owned('page-capacity')
    for (let i = 0; i < 127; i++) {
      const row = emptyRow(i, i % 2 ? 'xec-testnet' : 'monad-testnet')
      assert(await store.compareAndSwap(row.key, undefined, row.raw))
    }
    await closeAll()
    return { rows: 127 }
  }
  if (phase === 'page-last-left' || phase === 'page-last-right') {
    const store = owned('page-capacity'),
      row = emptyRow(phase === 'page-last-left' ? 127 : 128)
    let won = false,
      capacity = false
    try {
      won = await store.compareAndSwap(row.key, undefined, row.raw)
    } catch (error) {
      assert(String(error).includes('capacity'))
      capacity = true
    }
    assert(
      (await store.read(emptyRow(0).key)) !== undefined,
      'Refusal poisoned independent handle',
    )
    await closeAll()
    return { won, capacity }
  }
  if (phase === 'gap-create' || phase === 'gap-kill-create') {
    const store = owned(phase === 'gap-create' ? 'gap' : 'gap-kill'),
      row = emptyRow(0)
    flags.namespace = store.namespace
    fault = 'schema-gap'
    const committed = await store.compareAndSwap(row.key, undefined, row.raw)
    await closeAll()
    return { committed }
  }
  if (phase === 'gap-read') {
    const store = owned('gap')
    flags.namespace = store.namespace
    flags.started = true
    const value = await store.read(emptyRow(0).key)
    flags.completed = true
    await closeAll()
    return { present: value !== undefined }
  }
  if (phase === 'gap-cas') {
    const store = owned('gap'),
      row = emptyRow(1)
    flags.namespace = store.namespace
    flags.started = true
    const committed = await store.compareAndSwap(row.key, undefined, row.raw)
    flags.completed = true
    await closeAll()
    return { committed }
  }
  if (phase === 'gap-kill-reopen') {
    const store = owned('gap-kill')
    await rejects(() => store.read(emptyRow(0).key), 'missing binding')
    await store.close()
    assert(
      (await raw(store.namespace)).length === 0,
      'Incomplete namespace was repaired',
    )
    const writer = owned('gap-kill'),
      row = emptyRow(0)
    await rejects(
      () => writer.compareAndSwap(row.key, undefined, row.raw),
      'missing binding',
    )
    await writer.close()
    assert(
      (await raw(store.namespace)).length === 0,
      'CAS repaired incomplete namespace',
    )
    await closeAll()
    return { incomplete: 'preserved and rejected' }
  }
  if (phase === 'lost-ack') {
    const store = owned('lost-ack'),
      journal = engine(store),
      events = await signed()
    // Reinstall the faulting completion hook after the readonly-reopen assertion restored it.
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      const tx = nativeTransaction.apply(this, args)
      if (args[1] === 'readwrite')
        Object.defineProperty(tx, 'oncomplete', {
          set() {
            complete.set!.call(tx, () => {
              flags.ackReady = true
              flags.releaseAck = () => {
                tx.onabort?.call(tx, new Event('abort'))
              }
            })
          },
        })
      return tx
    }
    const admission = journal.admit(events.offer)
    await waitFor(() => flags.ackReady === true)
    const queued = store.read(journal.rowKey)
    ;(flags.releaseAck as () => void)()
    const outcomes = await Promise.allSettled([admission, queued])
    assert(
      outcomes.every(value => value.status === 'rejected'),
      'Failed owner admitted queued work',
    )
    IDBDatabase.prototype.transaction = nativeTransaction
    await store.close()
    const reopened = owned('lost-ack'),
      snapshot = await engine(reopened).read()
    assert(
      snapshot.entries.length === 1 &&
        bytesEqual(snapshot.entries[0].eventBytes, events.offer.eventBytes),
    )
    assert(
      (await engine(reopened).admit(events.offer)).admission === 'duplicate',
    )
    await closeAll()
    return { committedEvidence: 1, queued: 'rejected' }
  }
  if (phase === 'close-wait') {
    const store = owned('close-lock'),
      row = emptyRow(0)
    let entered!: () => void, release!: () => void
    const held = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const lock = navigator.locks.request(store.namespace, async () => {
      entered()
      await gate
    })
    await held
    const reading = store.read(row.key)
    await waitForAsync(
      async () =>
        (
          await navigator.locks.query()
        ).pending?.some(lock => lock.name === store.namespace) === true,
    )
    const closing = store.close()
    await rejects(() => store.read(row.key), 'closed')
    await rejects(() => reading)
    release()
    await lock
    await closing
    assert(
      !(await indexedDB.databases()).some(db => db.name === store.namespace),
    )
    // An actual open is queued behind a blocked deletion. Closing must abort its late creation.
    const blocked = owned('blocked'),
      first = emptyRow(0)
    await blocked.compareAndSwap(first.key, undefined, first.raw)
    await blocked.close()
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(blocked.namespace)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    connection.onversionchange = () => {
      /* Deliberately hold this owned blocker. */
    }
    const deletion = indexedDB.deleteDatabase(blocked.namespace)
    await new Promise<void>((resolve, reject) => {
      deletion.onblocked = () => resolve()
      deletion.onerror = () => reject(deletion.error)
    })
    flags.openedName = null
    const waiting = owned('blocked'),
      result = waiting.read(first.key)
    await waitFor(() => flags.openedName === blocked.namespace)
    const stopped = waiting.close()
    const rejection = rejects(() => result)
    connection.close()
    await rejection
    await stopped
    assert(
      !(await indexedDB.databases()).some(db => db.name === blocked.namespace),
      'Late abandoned upgrade created a replacement',
    )
    await closeAll()
    return { closeWaiting: 'revoked', abandonedOpen: 'late upgrade aborted' }
  }
  throw new Error('Unknown browser qualification phase ' + phase)
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

async function waitForAsync(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Browser async barrier did not arrive')
}
