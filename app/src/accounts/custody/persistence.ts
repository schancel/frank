import { parse } from './records'
import { CustodyError, type CustodySnapshot } from './types'

/** An absent read aborts creation and leaves no database behind. */
export function database(namespace: string, create: true): Promise<IDBDatabase>
export function database(
  namespace: string,
  create?: false,
): Promise<IDBDatabase | undefined>
export function database(
  namespace: string,
  create = false,
): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(`frank-account-custody-${namespace}`, 1)
    } catch {
      reject(new CustodyError('unavailable'))
      return
    }
    let abandoned = false,
      absent = false
    request.onupgradeneeded = event => {
      if (!create || event.oldVersion !== 0) {
        absent = !create && event.oldVersion === 0
        request.transaction!.abort()
        return
      }
      request.result.createObjectStore('state')
    }
    request.onblocked = () => {
      abandoned = true
      reject(new CustodyError('unavailable'))
    }
    request.onerror = () => {
      if (absent && !abandoned) resolve(undefined)
      else reject(new CustodyError('unavailable'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (abandoned) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      if (
        db.objectStoreNames.length !== 1 ||
        !db.objectStoreNames.contains('state')
      ) {
        db.close()
        reject(new CustodyError('locked'))
        return
      }
      resolve(db)
    }
  })
}

/** CAS callbacks are synchronous within a single cross-tab IDB transaction. */
export function stateTransaction(
  db: IDBDatabase,
  change?: (current: CustodySnapshot) => CustodySnapshot,
): Promise<CustodySnapshot> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        'state',
        change ? 'readwrite' : 'readonly',
        change ? { durability: 'strict' } : undefined,
      )
    } catch {
      reject(new CustodyError('storage-failed'))
      return
    }
    let result: CustodySnapshot, failure: CustodyError | undefined
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(failure ?? new CustodyError('storage-failed'))
    tx.onerror = () => {
      /* onabort is authoritative. */
    }
    const request = tx.objectStore('state').get('account')
    request.onsuccess = () => {
      try {
        const current = parse(request.result)
        result = change ? parse(change(current)) : current
        if (change) tx.objectStore('state').put(result, 'account')
      } catch (error) {
        failure =
          error instanceof CustodyError
            ? error
            : new CustodyError('storage-failed')
        tx.abort()
      }
    }
  })
}
