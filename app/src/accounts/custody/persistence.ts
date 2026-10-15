import { parse } from './records'
import { parseRetention, type RetentionRecord } from './retention'
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

export interface CustodyRecords {
  readonly account: CustodySnapshot
  readonly retention: RetentionRecord
}

/** Account and retention authority linearize in this one cross-tab transaction. */
export function custodyTransaction(
  db: IDBDatabase,
  change?: (current: CustodyRecords) => CustodyRecords,
): Promise<CustodyRecords> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        'state',
        change ? 'readwrite' : 'readonly',
        change ? { durability: 'strict' } : undefined,
      )
      if (change && tx.durability !== 'strict') {
        tx.abort()
        throw new CustodyError('storage-failed')
      }
    } catch {
      reject(new CustodyError('storage-failed'))
      return
    }
    let result: CustodyRecords, failure: CustodyError | undefined
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(failure ?? new CustodyError('storage-failed'))
    tx.onerror = () => {
      /* onabort is authoritative. */
    }
    const store = tx.objectStore('state')
    const accountRequest = store.get('account'),
      retentionRequest = store.get('retention-v1')
    let remaining = 2
    const loaded = () => {
      if (--remaining !== 0) return
      try {
        const account = parse(accountRequest.result)
        const retention = parseRetention(retentionRequest.result, account)
        const current = { account, retention }
        const changed = change ? change(current) : current
        const nextAccount = parse(changed.account)
        result = {
          account: nextAccount,
          retention: parseRetention(changed.retention, nextAccount),
        }
        if (changed.account !== account) store.put(result.account, 'account')
        if (changed.retention !== retention)
          store.put(result.retention, 'retention-v1')
      } catch (error) {
        failure =
          error instanceof CustodyError
            ? error
            : new CustodyError('storage-failed')
        tx.abort()
      }
    }
    accountRequest.onsuccess = loaded
    retentionRequest.onsuccess = loaded
  })
}

export async function stateTransaction(
  db: IDBDatabase,
): Promise<CustodySnapshot> {
  return (await custodyTransaction(db)).account
}
