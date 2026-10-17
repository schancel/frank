import {
  COVERAGE_KEY,
  inventory,
  requireChain,
  requireCoverageChange,
  nextCoverage,
  appendRecord,
  bind,
  BINDING_KEY,
  checkCapacity,
  RECORDS_STORE,
  requireKey,
  StoreQueue,
  validateRecords,
  validateRow,
  negotiationStorageLimits,
  type Binding,
  type NegotiationStorageBinding,
  type OwnedNegotiationJournalStore,
} from './negotiation-common'
export { negotiationStorageLimits } from './negotiation-common'

function schema(db: IDBDatabase): void {
  if (
    db.version !== 1 ||
    db.objectStoreNames.length !== 1 ||
    !db.objectStoreNames.contains(RECORDS_STORE)
  )
    throw new Error('Unsupported negotiation IndexedDB schema')
}
/** All cursor validation, comparison and writes are synchronous in this one transaction. */
function transaction<T>(
  db: IDBDatabase,
  binding: Binding,
  change: boolean,
  work: (
    records: ReturnType<typeof validateRecords>,
    store: IDBObjectStore,
  ) => T,
  initial = false,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      schema(db)
      tx = change
        ? db.transaction(RECORDS_STORE, 'readwrite', { durability: 'strict' })
        : db.transaction(RECORDS_STORE, 'readonly')
    } catch (error) {
      reject(error)
      return
    }
    let failure: unknown,
      failed = false,
      result: T
    tx.oncomplete = () => {
      if (failed) reject(failure)
      else resolve(result)
    }
    tx.onabort = () =>
      reject(
        failed
          ? failure
          : tx.error ?? new Error('Negotiation transaction aborted'),
      )
    tx.onerror = () => {
      /* Abort/completion is the acknowledgment boundary. */
    }
    const abort = (error: unknown) => {
      failed = true
      failure = error
      try {
        tx.abort()
      } catch {
        /* Already terminating; observe its terminal event. */
      }
    }
    try {
      if (change && tx.durability !== 'strict')
        throw new Error(
          'Strict negotiation IndexedDB durability is unavailable',
        )
      const store = tx.objectStore(RECORDS_STORE)
      if (
        store.keyPath !== null ||
        store.autoIncrement ||
        store.indexNames.length !== 0
      )
        throw new Error('Unsupported negotiation records store')
      const entries: Array<[unknown, unknown]> = []
      let rawBytes = 0
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        try {
          const row = cursor.result
          if (row) {
            rawBytes += appendRecord(entries, row.key, row.value)
            if (rawBytes > negotiationStorageLimits.rawBytes)
              throw new Error('Existing negotiation storage exceeds capacity')
            row.continue()
          } else {
            if (initial && entries.length !== 0)
              throw new Error('Unexpected records during first initialization')
            result = work(
              initial
                ? { rows: new Map(), coverage: new Map() }
                : validateRecords(binding, entries),
              store,
            )
          }
        } catch (error) {
          abort(error)
        }
      }
    } catch (error) {
      abort(error)
    }
  })
}
/** No platform fallback and no database/default creation on factory or absent read. */
export function createBrowserNegotiationJournalStore(
  input: NegotiationStorageBinding,
): OwnedNegotiationJournalStore {
  const binding = bind(input)
  if (!globalThis.indexedDB || !globalThis.navigator?.locks)
    throw new Error('Negotiation storage requires IndexedDB and Web Locks')
  const queue = new StoreQueue(),
    stopping = new AbortController()
  const pending = new Set<Promise<void>>()
  let database: IDBDatabase | undefined, cancelOpen: (() => void) | undefined
  function release(db: IDBDatabase): void {
    db.onclose = null
    db.onversionchange = null
    db.close()
    if (database === db) database = undefined
  }
  async function requestOpen(
    create: boolean,
  ): Promise<{ db: IDBDatabase; created: boolean } | undefined> {
    let finish!: () => void
    const terminal = new Promise<void>(resolve => {
      finish = resolve
    })
    pending.add(terminal)
    return new Promise((resolve, reject) => {
      let abandoned = false,
        refusedCreation = false,
        created = false
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(binding.namespace, 1)
      } catch (error) {
        pending.delete(terminal)
        finish()
        reject(error)
        return
      }
      const cleanup = () => {
        pending.delete(terminal)
        finish()
        if (cancelOpen === cancel) cancelOpen = undefined
      }
      const cancel = () => {
        abandoned = true
        try {
          request.transaction?.abort()
        } catch {
          /* Observe late open outcome. */
        }
        reject(new Error('Negotiation open abandoned'))
      }
      cancelOpen = cancel
      request.onupgradeneeded = event => {
        if (abandoned || queue.isClosing || !create || event.oldVersion !== 0) {
          refusedCreation =
            !abandoned && !queue.isClosing && !create && event.oldVersion === 0
          request.transaction!.abort()
          return
        }
        created = true
        request.result.createObjectStore(RECORDS_STORE)
      }
      request.onerror = () => {
        abandoned = true
        cleanup()
        if (refusedCreation) resolve(undefined)
        else
          reject(
            request.error ?? new Error('Negotiation IndexedDB open failed'),
          )
      }
      request.onblocked = () => {
        abandoned = true
        reject(new Error('Negotiation IndexedDB open blocked'))
      }
      request.onsuccess = () => {
        cleanup()
        if (abandoned || queue.isClosing) {
          release(request.result)
          reject(new Error('Negotiation open abandoned'))
          return
        }
        resolve({ db: request.result, created })
      }
    })
  }
  async function open(first?: {
    key: string
    raw: string
  }): Promise<{ db: IDBDatabase; created: boolean } | undefined> {
    if (database) return { db: database, created: false }
    return navigator.locks.request(
      binding.namespace,
      { mode: 'exclusive', signal: stopping.signal },
      async () => {
        if (queue.isClosing) throw new Error('Negotiation storage is closing')
        const opened = await requestOpen(first !== undefined)
        if (!opened) return undefined
        const { db, created } = opened
        db.onversionchange = () => {
          queue.poison(new Error('Negotiation database version changed'))
          release(db)
        }
        db.onclose = () => {
          queue.poison(new Error('Negotiation database unexpectedly closed'))
          if (database === db) database = undefined
        }
        try {
          if (created) {
            if (!first) throw new Error('Missing first negotiation record')
            await transaction(
              db,
              binding,
              true,
              (_, store) => {
                store.put(binding.metadata, BINDING_KEY)
                store.put(first.raw, first.key)
              },
              true,
            )
          } else await transaction(db, binding, false, () => undefined)
          if (queue.isClosing)
            throw new Error('Negotiation storage closed during open')
          database = db
          return opened
        } catch (error) {
          release(db)
          throw error
        }
      },
    )
  }
  return {
    namespace: binding.namespace,
    async read(key) {
      queue.assertAvailable()
      requireKey(key)
      return queue.run(async () => {
        const opened = await open()
        return opened
          ? transaction(opened.db, binding, false, ({ rows }) => rows.get(key))
          : undefined
      })
    },
    async listRecords() {
      queue.assertAvailable()
      return queue.run(async () => {
        const opened = await open()
        return opened
          ? transaction(opened.db, binding, false, ({ rows }) =>
              inventory(rows),
            )
          : inventory(new Map())
      })
    },
    async readCoverage(chainIdentifier) {
      queue.assertAvailable()
      requireChain(chainIdentifier)
      return queue.run(async () => {
        const opened = await open()
        return opened
          ? transaction(opened.db, binding, false, ({ coverage }) =>
              coverage.get(chainIdentifier),
            )
          : undefined
      })
    },
    async compareAndSwapCoverage(chainIdentifier, expected, next) {
      queue.assertAvailable()
      requireCoverageChange(chainIdentifier, expected, next)
      return queue.run(async () => {
        const opened = await open(
          expected === undefined
            ? {
                key: COVERAGE_KEY,
                raw: nextCoverage(new Map(), chainIdentifier, next),
              }
            : undefined,
        )
        if (!opened) return false
        if (opened.created) return true
        return transaction(opened.db, binding, true, ({ coverage }, store) => {
          if (coverage.get(chainIdentifier) !== expected) return false
          store.put(nextCoverage(coverage, chainIdentifier, next), COVERAGE_KEY)
          return true
        })
      })
    },
    async compareAndSwap(key, expectedRaw, nextRaw) {
      queue.assertAvailable()
      requireKey(key)
      if (expectedRaw !== undefined && typeof expectedRaw !== 'string')
        throw new TypeError('Expected raw must be a string or undefined')
      const next = validateRow(binding, key, nextRaw)
      return queue.run(async () => {
        const opened = await open(
          expectedRaw === undefined ? { key, raw: next } : undefined,
        )
        if (!opened) return false
        if (opened.created) return true
        return transaction(opened.db, binding, true, ({ rows }, store) => {
          if (rows.get(key) !== expectedRaw) return false
          checkCapacity(rows, key, next)
          store.put(next, key)
          return true
        })
      })
    },
    close: () =>
      queue.close(
        async () => {
          if (database) release(database)
          await Promise.all(pending)
        },
        () => {
          stopping.abort()
          cancelOpen?.()
        },
      ),
  }
}
