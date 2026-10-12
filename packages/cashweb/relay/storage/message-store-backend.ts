import level, { type LevelDB } from 'level'
import LevelJS from 'level-js'
import packager from 'level-packager'

/** Only MessageStore owns this adapter. All its browser metadata mutations use strict
 * transactions; wallet databases keep their existing adapters. LevelJS owns serialization. */
class StrictMessageMetadata extends LevelJS {
  store(mode: IDBTransactionMode): IDBObjectStore {
    const transaction =
      mode === 'readonly'
        ? this.db.transaction([this.location], mode)
        : this.db.transaction([this.location], mode, { durability: 'strict' })
    if (mode !== 'readonly' && transaction.durability !== 'strict') {
      transaction.abort()
      throw new Error('Strict message metadata durability unavailable')
    }
    return transaction.objectStore(this.location)
  }

  bindImmutable(
    key: string,
    value: string,
    marker: readonly [string, string],
    expected?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let store: IDBObjectStore
      try {
        store = this.store('readwrite')
      } catch (error) {
        reject(error)
        return
      }
      const transaction = store.transaction
      let failure: unknown
      transaction.oncomplete = () => resolve()
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error('Message metadata transaction aborted'),
        )
      // The adapter is packaged with fixed UTF-8 key/value encodings (strings), exactly
      // the defaults used by Level. Invoke inherited LevelJS serialization unchanged.
      const encodedKey = this._serializeKey(key)
      const request = store.get(encodedKey)
      request.onsuccess = () => {
        try {
          if (
            request.result === undefined
              ? expected !== undefined
              : indexedDB.cmp(request.result, this._serializeValue(value)) !==
                  0 &&
                (expected === undefined ||
                  indexedDB.cmp(
                    request.result,
                    this._serializeValue(expected),
                  ) !== 0)
          )
            throw new Error('Financial envelope binding conflict')
          if (request.result === undefined || expected !== undefined)
            store.put(this._serializeValue(value), encodedKey)
          // Commit the format marker with the binding even on the first mutation.
          store.put(
            this._serializeValue(marker[1]),
            this._serializeKey(marker[0]),
          )
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
    })
  }
}

export interface MessageMetadataBackend {
  /** Undefined expected means insert/idempotent only; exact expected permits the host's
   * pending-to-bound transition. The MessageStore mutation queue owns Node serialization. */
  db: LevelDB
  bindImmutable(
    key: string,
    value: string,
    marker: readonly [string, string],
    expected?: string,
  ): Promise<void>
}

export function messageMetadataBackend(
  location: string,
  callback: (error?: Error) => void,
): MessageMetadataBackend {
  if (typeof indexedDB !== 'undefined') {
    const backend = new StrictMessageMetadata(location)
    const factory = packager(() => backend)
    const db = factory(
      location,
      { keyEncoding: 'utf8', valueEncoding: 'utf8' },
      callback,
    )
    return {
      db,
      bindImmutable: (key, value, marker, expected) =>
        backend.bindImmutable(key, value, marker, expected),
    }
  }
  const db = level(location, {}, error => callback(error ?? undefined))
  return {
    db,
    async bindImmutable(key, value, marker, expected) {
      // The caller's mutation queue plus LevelDB's exclusive handle serialize this CAS.
      let previous: string | undefined
      try {
        previous = await db.get(key)
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'notFound' in error &&
            error.notFound === true
          )
        )
          throw error
      }
      if (
        previous === undefined
          ? expected !== undefined
          : previous !== value && previous !== expected
      )
        throw new Error('Financial envelope binding conflict')
      await db.batch(
        [
          { type: 'put', key: marker[0], value: marker[1] },
          { type: 'put', key, value },
        ],
        { sync: true },
      )
    },
  }
}
