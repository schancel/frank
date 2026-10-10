import { defineStore } from 'pinia'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'

/**
 * The account's swap history, as its own notes say it.
 *
 * A swap is recorded by the wallet: the record is journaled with the swap's transaction and,
 * once that is included, sent in a free note from the account to itself. This store is the fold
 * of those notes as the mailbox delivers them (`handleSwapItem`, called for every `swap-record`
 * item of a self message), so a reload or another device rebuilds the same list. On the device
 * that made a swap the wallet's own journal supplies the same record at once.
 *
 * What a swap did is not part of its record: it is read from the chain by its transaction.
 * `outcomes` only remembers what was read, so the chain is not asked again on every display.
 * Both are caches in localStorage; losing them loses nothing.
 */
export type SwapRecord = Omit<SwapRecordItem, 'type'>

export interface SwapOutcome {
  status: 'confirmed' | 'failed'
  /** What arrived, in the output asset's smallest unit; absent when the receipt did not show it. */
  amountOut?: string
  /** Network fees charged, in the native coin's smallest unit. */
  feeWei?: string
  /** Why a failed swap failed, as a short code the view translates. */
  reason?: string
}

export const SWAP_STORAGE_KEY = 'frank_swap_records'

interface Stored {
  records: SwapRecord[]
  outcomes: Record<string, SwapOutcome>
}

function load(): Stored {
  try {
    const raw =
      typeof window !== 'undefined'
        ? window.localStorage?.getItem(SWAP_STORAGE_KEY)
        : null
    const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : {}
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      outcomes:
        parsed.outcomes && typeof parsed.outcomes === 'object'
          ? parsed.outcomes
          : {},
    }
  } catch {
    return { records: [], outcomes: {} }
  }
}

export const useSwapStore = defineStore('swaps', {
  state: (): Stored => load(),

  getters: {
    /** The swaps made on one canonical chain, newest first. */
    getSwapsForChain: state => (chainIdentifier: string | undefined) =>
      state.records
        .filter(record => record.chainIdentifier === chainIdentifier)
        .sort((a, b) => b.timestamp - a.timestamp),
  },

  actions: {
    saveToStorage() {
      try {
        window.localStorage?.setItem(
          SWAP_STORAGE_KEY,
          JSON.stringify({
            records: this.records.slice(0, 200),
            outcomes: this.outcomes,
          }),
        )
      } catch {
        // A cache that cannot be written is rebuilt from the mailbox and the chain.
      }
    },

    /** One swap record, from a note to self or from this device's wallet journal. Idempotent. */
    handleSwapItem(item: SwapRecordItem): void {
      if (!item || item.type !== 'swap-record' || !item.swapId) return
      const { type: _type, ...record } = item
      const index = this.records.findIndex(r => r.swapId === record.swapId)
      if (index >= 0)
        // The same swap again: keep the time it was first seen, so the order is stable.
        this.records[index] = {
          ...record,
          timestamp: Math.min(this.records[index].timestamp, record.timestamp),
        }
      else this.records = [record, ...this.records]
      this.saveToStorage()
    },

    /** Remembers what the chain said a swap did. */
    cacheOutcome(swapId: string, outcome: SwapOutcome): void {
      this.outcomes = { ...this.outcomes, [swapId]: outcome }
      this.saveToStorage()
    },
  },
})
