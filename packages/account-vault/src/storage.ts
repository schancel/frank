import { MAX_SLOTS, intent, receipt, same } from './encoding.js'
import { VaultError, type VaultReceipt, type VaultWriteIntent } from './types.js'

export interface RecordRow { receipt: VaultReceipt; iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }
export interface KeyRow { receipt: VaultReceipt; key: CryptoKey }
interface Fence { revision: number; receipt: VaultReceipt | null; discardedIntent?: VaultWriteIntent }
export interface Inventory { record?: RecordRow; key?: KeyRow; fence?: Fence }
const STORES = ['records', 'keys', 'fences']

export function database(name: string, probe = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try { request = indexedDB.open(name, 1) }
    catch { reject(new VaultError('unavailable')); return }
    let settled = false
    request.onupgradeneeded = () => {
      for (const store of probe ? ['probe'] : STORES) request.result.createObjectStore(store)
    }
    request.onerror = () => reject(new VaultError('unavailable'))
    request.onblocked = () => { settled = true; reject(new VaultError('unavailable')) }
    request.onsuccess = () => {
      if (settled) { request.result.close(); return }
      const db = request.result
      db.onversionchange = () => db.close()
      const expected = probe ? ['probe'] : STORES
      if (db.objectStoreNames.length !== expected.length || expected.some(s => !db.objectStoreNames.contains(s))) {
        db.close(); reject(new VaultError('corrupt')); return
      }
      resolve(db)
    }
  })
}

/** Work and request callbacks are synchronous: crypto never holds a transaction open. */
export function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, result: (value: T) => void, fail: (error: VaultError) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try { tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined) }
    catch { reject(new VaultError('storage-failed')); return }
    let value: T, failure: VaultError | undefined
    const fail = (error: VaultError) => { failure = error; try { tx.abort() } catch { /* Already aborted. */ } }
    tx.oncomplete = () => resolve(value)
    tx.onabort = () => reject(failure ?? new VaultError('storage-failed'))
    tx.onerror = () => { /* Abort is the authoritative completion signal. */ }
    try { work(tx, result => { value = result }, fail) } catch { fail(new VaultError('storage-failed')) }
  })
}

/** A discard tombstone binds the complete intent, including its expected predecessor. */
function parseFence(fence: Fence): Fence {
  if (fence === null || typeof fence !== 'object' || !Number.isInteger(fence.revision) ||
      fence.revision < 1 || fence.revision > 0xffffffff) throw new VaultError('corrupt')
  if (fence.receipt !== null) {
    const current = receipt(fence.receipt)
    if (current.revision !== fence.revision || fence.discardedIntent !== undefined) throw new VaultError('corrupt')
    return { revision: current.revision, receipt: current }
  }
  if (fence.discardedIntent === undefined) return { revision: fence.revision, receipt: null }
  const discardedIntent = intent(fence.discardedIntent)
  if (fence.revision !== discardedIntent.receipt.revision + 1) throw new VaultError('corrupt')
  return { revision: fence.revision, receipt: null, discardedIntent }
}

function inspect(value: Inventory): Inventory {
  try {
    const { record: row, key } = value
    if (value.fence === undefined) {
      if (row !== undefined || key !== undefined) throw 0
      return value
    }
    const fence = parseFence(value.fence)
    if (fence.receipt === null) {
      if (row !== undefined || key !== undefined) throw 0
      return { fence }
    }
    const current = fence.receipt
    if (!row || !same(receipt(row.receipt), current) ||
        !(row.iv instanceof Uint8Array) || row.iv.length !== 12 ||
        !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length !== 18 + 33 * current.context.purposes.length) throw 0
    if (!key) throw new VaultError('locked')
    if (!same(receipt(key.receipt), current) || !validKey(key.key)) throw 0
    return { fence, record: { ...row, receipt: current }, key: { ...key, receipt: current } }
  } catch (error) {
    if (error instanceof VaultError && error.code === 'locked') throw error
    throw new VaultError('corrupt')
  }
}

export function validKey(key: CryptoKey): boolean {
  return key instanceof CryptoKey && !key.extractable && key.type === 'secret' && key.algorithm.name === 'AES-GCM' &&
    (key.algorithm as AesKeyAlgorithm).length === 256 && key.usages.length === 2 && key.usages.includes('encrypt') && key.usages.includes('decrypt')
}

function loadInventory(tx: IDBTransaction, id: string, done: (value: Inventory) => void, fail: (error: VaultError) => void): void {
  const value: Inventory = {}
  let remaining = 3
  for (const [store, field] of [['records', 'record'], ['keys', 'key'], ['fences', 'fence']] as const) {
    const request = tx.objectStore(store).get(id)
    request.onsuccess = () => {
      value[field] = request.result
      if (--remaining === 0) {
        try { done(value) } catch (error) { fail(error instanceof VaultError ? error : new VaultError('storage-failed')) }
      }
    }
  }
}

function load(tx: IDBTransaction, id: string, done: (value: Inventory) => void, fail: (error: VaultError) => void): void {
  loadInventory(tx, id, value => done(inspect(value)), fail)
}

export function read(db: IDBDatabase, id: string): Promise<Inventory> {
  return transaction(db, STORES, 'readonly', (tx, result, fail) => load(tx, id, result, fail))
}

export function commit(db: IDBDatabase, intent: VaultWriteIntent, row: RecordRow, key: CryptoKey): Promise<void> {
  return transaction(db, STORES, 'readwrite', (tx, result, fail) => {
    const id = intent.receipt.context.creationId
    load(tx, id, current => {
      const actual = current.fence?.receipt
      if (intent.expected === null ? current.fence !== undefined : !actual || !same(actual, intent.expected)) {
        fail(new VaultError('conflict')); return
      }
      const write = () => {
        tx.objectStore('records').put(row, id)
        tx.objectStore('keys').put({ receipt: intent.receipt, key } satisfies KeyRow, id)
        tx.objectStore('fences').put({ revision: intent.receipt.revision, receipt: intent.receipt } satisfies Fence, id)
        result(undefined)
      }
      if (current.fence) { write(); return }
      const count = tx.objectStore('fences').count()
      count.onsuccess = () => {
        if (count.result >= MAX_SLOTS) { fail(new VaultError('capacity')); return }
        try { write() } catch { fail(new VaultError('storage-failed')) }
      }
    }, fail)
  })
}

export function remove(db: IDBDatabase, target: VaultReceipt): Promise<void> {
  return transaction(db, STORES, 'readwrite', (tx, result, fail) => {
    const id = target.context.creationId
    // Cleanup may remove a missing/corrupt key or ciphertext; the fence still authorizes its exact inventory.
    const request = tx.objectStore('fences').get(id)
    request.onsuccess = () => {
      try {
        const fence = request.result as Fence | undefined
        if (fence?.receipt === null && fence.revision === target.revision + 1) { result(undefined); return }
        if (!fence?.receipt || !same(receipt(fence.receipt), target) || fence.revision !== target.revision) {
          fail(new VaultError('conflict')); return
        }
        try {
          tx.objectStore('records').delete(id)
          tx.objectStore('keys').delete(id)
          tx.objectStore('fences').put({ revision: target.revision + 1, receipt: null } satisfies Fence, id)
          result(undefined)
        } catch { fail(new VaultError('storage-failed')) }
      } catch { fail(new VaultError('corrupt')) }
    }
  })
}

export function discardIntent(db: IDBDatabase, target: VaultWriteIntent): Promise<void> {
  return transaction(db, STORES, 'readwrite', (tx, result, fail) => {
    const id = target.receipt.context.creationId
    loadInventory(tx, id, current => {
      let fence: Fence | undefined
      try { fence = current.fence === undefined ? undefined : parseFence(current.fence) }
      catch { fail(new VaultError('corrupt')); return }
      if (!fence || fence.receipt === null) {
        // No authorizing live fence: orphan material must never be silently deleted.
        if (current.record !== undefined || current.key !== undefined) { fail(new VaultError('corrupt')); return }
        if (fence) {
          const prior = fence.discardedIntent
          if (!prior || !same(prior.receipt, target.receipt) ||
              (prior.expected === null ? target.expected !== null : !target.expected || !same(prior.expected, target.expected))) {
            fail(new VaultError('conflict')); return
          }
          result(undefined); return
        }
        if (target.expected !== null) { fail(new VaultError('conflict')); return }
      } else if (!same(fence.receipt, target.receipt)) { fail(new VaultError('conflict')); return }

      const discard = () => {
        tx.objectStore('records').delete(id)
        tx.objectStore('keys').delete(id)
        tx.objectStore('fences').put({ revision: target.receipt.revision + 1, receipt: null, discardedIntent: target } satisfies Fence, id)
        result(undefined)
      }
      if (fence) { discard(); return }
      const count = tx.objectStore('fences').count()
      count.onsuccess = () => {
        if (count.result >= MAX_SLOTS) { fail(new VaultError('capacity')); return }
        try { discard() } catch { fail(new VaultError('storage-failed')) }
      }
    }, fail)
  })
}
