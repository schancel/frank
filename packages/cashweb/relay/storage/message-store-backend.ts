import {
  outgoingApplicationIntentPrefix,
  outgoingApplicationStoredRow,
  resolveOutgoingApplicationIntent,
  type OutgoingApplicationMessageRecord,
} from './outgoing-application-intent'

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

  outgoingApplicationIntent(
    requested: OutgoingApplicationMessageRecord,
    marker: readonly [string, string],
  ): Promise<OutgoingApplicationMessageRecord> {
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
      let result: OutgoingApplicationMessageRecord
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error('Message metadata transaction aborted'),
        )
      const rows: OutgoingApplicationMessageRecord[] = []
      const decode = (value: unknown): string =>
        typeof value === 'string'
          ? value
          : new TextDecoder().decode(value as ArrayBuffer)
      const range = IDBKeyRange.bound(
        this._serializeKey(outgoingApplicationIntentPrefix),
        this._serializeKey(outgoingApplicationIntentPrefix + '\uffff'),
        false,
        true,
      )
      const cursor = store.openCursor(range)
      cursor.onsuccess = () => {
        try {
          if (cursor.result) {
            rows.push(
              outgoingApplicationStoredRow(
                decode(cursor.result.key),
                decode(cursor.result.value),
              ),
            )
            cursor.result.continue()
            return
          }
          result = resolveOutgoingApplicationIntent(requested, rows)
          const key = outgoingApplicationIntentPrefix + result.intentKey
          const previous = rows.find(row => row.intentKey === result.intentKey)
          if (
            !previous ||
            JSON.stringify(previous) !== JSON.stringify(result)
          ) {
            store.put(
              this._serializeValue(JSON.stringify(result)),
              this._serializeKey(key),
            )
            store.put(
              this._serializeValue(marker[1]),
              this._serializeKey(marker[0]),
            )
          }
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
    })
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
  db: LevelDB
  /** Comparison and capacity inspection share the strict browser transaction or native queue. */
  outgoingApplicationIntent(
    requested: OutgoingApplicationMessageRecord,
    marker: readonly [string, string],
  ): Promise<OutgoingApplicationMessageRecord>
  /** Undefined expected means insert/idempotent only; exact expected permits the host's
   * pending-to-bound transition. The MessageStore mutation queue owns Node serialization. */
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
      outgoingApplicationIntent: (requested, marker) =>
        backend.outgoingApplicationIntent(requested, marker),
      bindImmutable: (key, value, marker, expected) =>
        backend.bindImmutable(key, value, marker, expected),
    }
  }
  const db = level(location, {}, error => callback(error ?? undefined))
  return {
    db,
    async outgoingApplicationIntent(requested, marker) {
      const rows: OutgoingApplicationMessageRecord[] = []
      for await (const [key, value] of db.iterator({
        gte: outgoingApplicationIntentPrefix,
        lt: outgoingApplicationIntentPrefix + '\uffff',
      }))
        rows.push(outgoingApplicationStoredRow(String(key), String(value)))
      const result = resolveOutgoingApplicationIntent(requested, rows)
      const previous = rows.find(row => row.intentKey === result.intentKey)
      if (!previous || JSON.stringify(previous) !== JSON.stringify(result))
        await db.batch(
          [
            { type: 'put', key: marker[0], value: marker[1] },
            {
              type: 'put',
              key: outgoingApplicationIntentPrefix + result.intentKey,
              value: JSON.stringify(result),
            },
          ],
          { sync: true },
        )
      return result
    },
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
