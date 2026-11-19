/**
 * IndexedDB store of HTLC swap records: database `frank-swap-htlc-v1-<namespace>`, one object
 * store of `{revision, raw}` rows keyed by swapId. Revision CAS inside one `readwrite`
 * transaction (strict durability), serialized across tabs by a Web Lock, as the earlier
 * execution store did. Rows are opaque here; `parseHtlcSwapRecord` validates them on read.
 */
import type { HtlcSwapRecordStore } from '../htlc-swap-runner'

const STORE_NAME = 'records'
const NAMESPACE = /^[a-zA-Z0-9_:-]{1,128}$/

type Row = { revision: number; raw: string }

function openDatabase(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`frank-swap-htlc-v1-${namespace}`, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () =>
      reject(req.error ?? new Error('Swap record IndexedDB open failed'))
    req.onblocked = () =>
      reject(new Error('Swap record IndexedDB open blocked'))
  })
}

function validRow(value: unknown): value is Row {
  const row = value as Row | undefined
  return (
    typeof row === 'object' &&
    row !== null &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0 &&
    typeof row.raw === 'string'
  )
}

export class BrowserHtlcSwapRecordStore implements HtlcSwapRecordStore {
  readonly namespace: string
  private readonly lockName: string
  private dbPromise?: Promise<IDBDatabase>

  constructor(namespace: string) {
    if (typeof namespace !== 'string' || !NAMESPACE.test(namespace))
      throw new Error('Invalid browser swap record namespace')
    this.namespace = namespace
    this.lockName = `frank-swap-htlc-lock-${namespace}`
  }

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDatabase(this.namespace)
    return this.dbPromise
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request)
      return navigator.locks.request(this.lockName, work) as Promise<T>
    return work()
  }

  async getRecord(key: string): Promise<Row | undefined> {
    return this.exclusive(async () => {
      const db = await this.db()
      return new Promise<Row | undefined>((resolve, reject) => {
        const req = db
          .transaction(STORE_NAME, 'readonly')
          .objectStore(STORE_NAME)
          .get(key)
        req.onsuccess = () => {
          if (req.result === undefined) return resolve(undefined)
          if (!validRow(req.result))
            return reject(new Error(`Corrupt swap record row ${key}`))
          resolve({ revision: req.result.revision, raw: req.result.raw })
        }
        req.onerror = () =>
          reject(req.error ?? new Error('Failed to read swap record'))
      })
    })
  }

  async listRecords(): Promise<readonly (Row & { key: string })[]> {
    return this.exclusive(async () => {
      const db = await this.db()
      return new Promise<(Row & { key: string })[]>((resolve, reject) => {
        const out: (Row & { key: string })[] = []
        const req = db
          .transaction(STORE_NAME, 'readonly')
          .objectStore(STORE_NAME)
          .openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return resolve(out)
          if (!validRow(cursor.value))
            return reject(
              new Error(`Corrupt swap record row ${String(cursor.key)}`),
            )
          out.push({
            key: String(cursor.key),
            revision: cursor.value.revision,
            raw: cursor.value.raw,
          })
          cursor.continue()
        }
        req.onerror = () =>
          reject(req.error ?? new Error('Failed to list swap records'))
      })
    })
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number,
    nextRaw: string,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('Invalid expected swap record revision')
    return this.exclusive(async () => {
      const db = await this.db()
      return new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite', {
          durability: 'strict',
        })
        const store = tx.objectStore(STORE_NAME)
        let matched = false
        tx.oncomplete = () => resolve(matched)
        tx.onabort = () =>
          reject(tx.error ?? new Error('Swap record CAS transaction aborted'))
        const get = store.get(key)
        get.onsuccess = () => {
          const current = get.result as Row | undefined
          if (current !== undefined && !validRow(current)) {
            tx.abort()
            return
          }
          if ((current?.revision ?? 0) !== expectedRevision) return
          matched = true
          store.put({ revision: expectedRevision + 1, raw: nextRaw }, key)
        }
      })
    })
  }

  async close(): Promise<void> {
    const db = await this.dbPromise?.catch(() => undefined)
    db?.close()
    this.dbPromise = undefined
  }
}
