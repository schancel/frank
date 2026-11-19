import { defineStore } from 'pinia'
import type { TableHtlcRecordItem } from '@frank/cashweb/types/messages'

/**
 * The account's game-table buy-in locks, as its own notes say them.
 *
 * Every GenericHTLC call the wallet makes for a table (a buy-in lock, its refund) is journaled
 * with a `table-htlc` record and, once included, sent in a free note from the account to itself
 * carrying a `table-htlc-record` item. This store is the fold of those items as the mailbox
 * delivers them (`handleTableHtlcRecord`), so another device of the account knows which locks it
 * has, at which table, and can show and refund them. What a lock holds and whether it is still
 * open is read from the chain by its id; this only remembers which locks exist and the
 * transactions that made and ended them. A cache in localStorage; losing it loses nothing (the
 * lock id also follows from the table's terms and the account's main account).
 */
export interface TableLockRecord {
  chainIdentifier: string
  game: string
  tableId: string
  lockId: string
  lockTxHash?: string
  refundTxHash?: string
  /** First seen, ms. */
  timestamp: number
}

export const TABLE_LOCK_STORAGE_KEY = 'frank_table_locks'
const MAX_RECORDS = 500

const keyOf = (chainIdentifier: string, lockId: string) =>
  `${chainIdentifier}:${lockId.toLowerCase()}`

function load(): TableLockRecord[] {
  try {
    const raw =
      typeof window !== 'undefined'
        ? window.localStorage?.getItem(TABLE_LOCK_STORAGE_KEY)
        : null
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? parsed.filter(
          (r): r is TableLockRecord =>
            !!r &&
            typeof r === 'object' &&
            typeof (r as TableLockRecord).lockId === 'string' &&
            typeof (r as TableLockRecord).tableId === 'string' &&
            typeof (r as TableLockRecord).chainIdentifier === 'string',
        )
      : []
  } catch {
    return []
  }
}

export const useTableLockStore = defineStore('tableLocks', {
  state: () => ({ records: load() }),

  getters: {
    /** The account's locks at one table on one network, oldest first. */
    locksAt:
      state => (chainIdentifier: string, game: string, tableId: string) =>
        state.records
          .filter(
            r =>
              r.chainIdentifier === chainIdentifier &&
              r.game === game &&
              r.tableId === tableId,
          )
          .sort((a, b) => a.timestamp - b.timestamp),
  },

  actions: {
    saveToStorage() {
      try {
        window.localStorage?.setItem(
          TABLE_LOCK_STORAGE_KEY,
          JSON.stringify(this.records.slice(-MAX_RECORDS)),
        )
      } catch {
        // A cache that cannot be written is rebuilt from the mailbox and the chain.
      }
    },

    /** One record, from a note to self or from this device's own call. Idempotent. A
     * `distribute` is an arbiter's record, not a player's lock: it is not kept. */
    handleTableHtlcRecord(item: TableHtlcRecordItem): void {
      if (
        !item ||
        item.type !== 'table-htlc-record' ||
        (item.action !== 'lock' && item.action !== 'refund') ||
        item.lockIds?.length !== 1
      )
        return
      const lockId = item.lockIds[0]!.toLowerCase()
      const key = keyOf(item.chainIdentifier, lockId)
      const index = this.records.findIndex(
        r => keyOf(r.chainIdentifier, r.lockId) === key,
      )
      const existing = index >= 0 ? this.records[index] : undefined
      const next: TableLockRecord = {
        chainIdentifier: item.chainIdentifier,
        game: item.game,
        tableId: item.tableId,
        lockId,
        ...(existing?.lockTxHash ? { lockTxHash: existing.lockTxHash } : {}),
        ...(existing?.refundTxHash
          ? { refundTxHash: existing.refundTxHash }
          : {}),
        ...(item.action === 'lock'
          ? { lockTxHash: item.txHash }
          : { refundTxHash: item.txHash }),
        timestamp: Math.min(
          existing?.timestamp ?? item.timestamp,
          item.timestamp,
        ),
      }
      if (existing) this.records.splice(index, 1, next)
      else this.records.push(next)
      this.saveToStorage()
    },
  },
})
