import { AdmissionError, fail } from '../policy/history'
import {
  boundedRow,
  FORMAT,
  MAX_ROWS,
  MAX_SERIALIZED_BYTES,
  Row,
  sameRows,
  sorted,
  Storage,
} from './records'

const STORE = 'records'
export async function openIndexedDb(
  name: string,
  intent: 'new' | 'reopen',
): Promise<Storage> {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 512 ||
    !globalThis.indexedDB
  )
    fail('unavailable')
  let unavailable = false
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    let created = false
    let failed = false
    const stop = () => {
      failed = true
      reject(new AdmissionError('unavailable'))
    }
    request.onblocked = stop
    request.onerror = stop
    request.onupgradeneeded = () => {
      // A missing reopen is never committed as an empty replacement database.
      if (intent !== 'new') {
        request.transaction!.abort()
        return
      }
      created = true
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      const value = request.result
      if (failed) {
        value.close()
        return
      }
      if (intent === 'new' && !created) {
        value.close()
        reject(new AdmissionError('already-enrolled'))
        return
      }
      if (
        value.version !== 1 ||
        value.objectStoreNames.length !== 1 ||
        !value.objectStoreNames.contains(STORE)
      ) {
        value.close()
        stop()
        return
      }
      resolve(value)
    }
  })
  db.onversionchange = () => {
    unavailable = true
    db.close()
  }
  db.onclose = () => {
    unavailable = true
  }

  function transaction(
    mode: IDBTransactionMode,
    expected?: readonly Row[],
    additions: readonly Row[] = [],
  ): Promise<Row[]> {
    if (unavailable) return Promise.reject(new AdmissionError('unavailable'))
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx =
          mode === 'readwrite'
            ? db.transaction(STORE, mode, { durability: 'strict' })
            : db.transaction(STORE, mode)
        if (mode === 'readwrite' && tx.durability !== 'strict') {
          tx.abort()
          fail('unavailable')
        }
      } catch {
        unavailable = true
        reject(new AdmissionError('unavailable'))
        return
      }
      let error: AdmissionError | null = null
      const rows: Row[] = []
      let bytes = 0
      tx.onabort = () => {
        if (error?.code !== 'retryable') unavailable = true
        reject(error ?? new AdmissionError('unavailable'))
      }
      tx.onerror = () => {
        /* abort/completion is the only result boundary */
      }
      tx.oncomplete = () => resolve(sorted(rows))
      const objectStore = tx.objectStore(STORE)
      const cursor = objectStore.openCursor()
      cursor.onsuccess = () => {
        try {
          const row = cursor.result
          if (row) {
            boundedRow(row.key, row.value)
            bytes += row.key.length + (row.value as string).length
            if (rows.length >= MAX_ROWS || bytes > MAX_SERIALIZED_BYTES)
              fail('unavailable')
            rows.push([row.key, row.value as string])
            row.continue()
          } else {
            if (expected && !sameRows(sorted(rows), expected)) fail('retryable')
            // This callback runs inside the same native transaction as the comparison.
            // Crypto already finished outside this transaction; there is no await here.
            for (const [key, value] of additions) objectStore.put(value, key)
          }
        } catch (e) {
          error =
            e instanceof AdmissionError ? e : new AdmissionError('unavailable')
          try {
            tx.abort()
          } catch {
            // An externally aborted transaction still settles through onabort.
          }
        }
      }
    })
  }
  try {
    if (intent === 'new')
      await transaction('readwrite', [], [['format', FORMAT]])
    else await transaction('readwrite') // Prove reported strict capability on every open.
  } catch (error) {
    db.close()
    throw error
  }
  return {
    read: () => transaction('readonly'),
    commit: async (expected, additions) => {
      await transaction('readwrite', expected, additions)
    },
    close: async () => {
      unavailable = true
      db.close()
    },
  }
}
