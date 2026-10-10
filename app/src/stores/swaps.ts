import { defineStore } from 'pinia'
import {
  cborMap,
  decodeCanonical,
  encodeCanonical,
  fromHex,
  toHex,
} from '@frank/codec'
import type { SwapRecordItem } from '@frank/cashweb/types/messages'
import { useChatStore } from './chats'

export interface SwapRecord {
  id: string
  timestamp: number
  chain: string
  fromAsset: string
  toAsset: string
  fromAmount: string
  toAmount: string
  txHash: string
  route: string
  feeDisplay: string
  destinationAddress?: string
  status: 'confirmed' | 'pending' | 'failed'
  cborPayload?: string
  /** Canonical chain identifier the swap was made on (`chain` is the wallet page's alias). */
  chainIdentifier?: string
  /** Why a failed swap failed, as a short code the view translates. */
  failureReason?: string
  /**
   * What is needed to finish a swap that was submitted but not yet seen in a block: the wallet's
   * recorded operation and the exact call. Removed once the outcome is known.
   */
  recovery?: SwapRecovery
  /** True once the note to self carrying this record has been accepted by the relay. */
  noted?: boolean
}

export interface SwapRecovery {
  /** This device's wallet operation. Absent on a record learned from the account's mailbox:
   * another device made the swap, and only it can re-send it. */
  operationId?: string
  /** The venue the swap was made on; it is finished there and nowhere else. */
  venueId: string
  account: string
  /** The venue's own description of the route, as its quote gave it. */
  route: unknown
  /** The exact call, on the device that made the swap. */
  call?: { to: string; data: string; value: string }
  toDecimals: number
}

export const SWAP_STORAGE_KEY = 'frank_swap_history'

/**
 * Encodes a swap record into canonical CBOR map bytes.
 * Keys:
 * 0: id (string)
 * 1: chain (string)
 * 2: fromAsset (string)
 * 3: toAsset (string)
 * 4: fromAmount (string)
 * 5: toAmount (string)
 * 6: txHash (string)
 * 7: route (string)
 * 8: feeDisplay (string)
 * 9: timestamp (uint)
 * 10: status (string)
 * 11: destinationAddress (string)
 */
export function encodeSwapRecord(record: SwapRecord): Uint8Array {
  return encodeCanonical(
    cborMap([
      [0, record.id],
      [1, record.chain.toLowerCase()],
      [2, record.fromAsset],
      [3, record.toAsset],
      [4, record.fromAmount],
      [5, record.toAmount],
      [6, record.txHash],
      [7, record.route],
      [8, record.feeDisplay],
      [9, BigInt(record.timestamp)],
      [10, record.status],
      [11, record.destinationAddress || ''],
      // What another frontend of the account needs to show this swap on its own network and
      // read its outcome from the chain: the canonical chain, the venue, the account, the route.
      [12, record.chainIdentifier || ''],
      [
        13,
        record.recovery
          ? JSON.stringify({
              venueId: record.recovery.venueId,
              account: record.recovery.account,
              route: record.recovery.route,
              toDecimals: record.recovery.toDecimals,
            })
          : '',
      ],
    ]),
  )
}

function decodedExtras(
  map: Map<number | bigint, any>,
): Pick<SwapRecord, 'chainIdentifier' | 'recovery'> {
  const chainIdentifier = map.get(12n) ?? map.get(12)
  const recovery = map.get(13n) ?? map.get(13)
  const extras: Pick<SwapRecord, 'chainIdentifier' | 'recovery'> = {}
  if (typeof chainIdentifier === 'string' && chainIdentifier)
    extras.chainIdentifier = chainIdentifier
  if (typeof recovery === 'string' && recovery) {
    try {
      const parsed = JSON.parse(recovery)
      if (
        typeof parsed?.venueId === 'string' &&
        typeof parsed.account === 'string' &&
        typeof parsed.toDecimals === 'number'
      )
        extras.recovery = {
          venueId: parsed.venueId,
          account: parsed.account,
          route: parsed.route,
          toDecimals: parsed.toDecimals,
        }
    } catch {
      /* A record without usable extras is still a record. */
    }
  }
  return extras
}

/** The record as the typed item a note to self carries. */
export function swapRecordItem(record: SwapRecord): SwapRecordItem {
  return {
    type: 'swap-record',
    swapId: record.id,
    chain: record.chain,
    fromAsset: record.fromAsset,
    toAsset: record.toAsset,
    fromAmount: record.fromAmount,
    toAmount: record.toAmount,
    txHash: record.txHash,
    route: record.route,
    feeDisplay: record.feeDisplay,
    destinationAddress: record.destinationAddress,
    status: record.status,
    timestamp: record.timestamp,
    cborPayload: toHex(encodeSwapRecord(record)),
  }
}

export function decodeSwapRecord(bytes: Uint8Array): Partial<SwapRecord> {
  const map = decodeCanonical(bytes) as Map<number | bigint, any>
  return {
    id: map.get(0n) ?? map.get(0),
    chain: map.get(1n) ?? map.get(1),
    fromAsset: map.get(2n) ?? map.get(2),
    toAsset: map.get(3n) ?? map.get(3),
    fromAmount: map.get(4n) ?? map.get(4),
    toAmount: map.get(5n) ?? map.get(5),
    txHash: map.get(6n) ?? map.get(6),
    route: map.get(7n) ?? map.get(7),
    feeDisplay: map.get(8n) ?? map.get(8),
    timestamp: Number(map.get(9n) ?? map.get(9) ?? Date.now()),
    status: (map.get(10n) ??
      map.get(10) ??
      'confirmed') as SwapRecord['status'],
    destinationAddress: map.get(11n) ?? map.get(11) ?? undefined,
    ...decodedExtras(map),
  }
}

export const useSwapStore = defineStore('swaps', {
  state: () => {
    let initialSwaps: SwapRecord[] = []
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(SWAP_STORAGE_KEY)
        if (raw) {
          initialSwaps = JSON.parse(raw)
        }
      } catch {
        // Ignore storage parse errors
      }
    }
    return {
      swaps: initialSwaps as SwapRecord[],
    }
  },

  getters: {
    allSwaps: state => {
      return [...state.swaps].sort((a, b) => b.timestamp - a.timestamp)
    },

    getSwapsForChain:
      state => (chainName: string, chainIdentifier?: string) => {
        const c = chainName.toLowerCase()
        return state.swaps.filter(
          s =>
            (s.chain === c || (c === 'solana' && s.chain.includes('solana'))) &&
            // A swap that names its network is shown only on that network.
            (!chainIdentifier ||
              !s.chainIdentifier ||
              s.chainIdentifier === chainIdentifier),
        )
      },
  },

  actions: {
    saveToStorage() {
      if (typeof window === 'undefined' || !window.localStorage) return
      try {
        window.localStorage.setItem(
          SWAP_STORAGE_KEY,
          JSON.stringify(this.swaps.slice(0, 100)),
        )
      } catch {
        // Ignore write error
      }
    },

    /**
     * Writes one swap to this device's history and nothing else, or throws. A swap is saved
     * here as pending before it is broadcast, then again with its outcome.
     */
    saveLocal(record: SwapRecord): void {
      const index = this.swaps.findIndex(s => s.id === record.id)
      const next =
        index >= 0
          ? this.swaps.map((s, i) => (i === index ? record : s))
          : [record, ...this.swaps.slice(0, 99)]
      // Throws when the device cannot store it. A swap is saved here before it is broadcast,
      // and a save that silently did nothing would let a swap go out with no record of it.
      window.localStorage.setItem(SWAP_STORAGE_KEY, JSON.stringify(next))
      this.swaps = next
    },

    /**
     * Writes the swap as a typed note among the account's own messages (no text item, so it
     * is not a chat). Never throws: a note that could not be written is only a note owed.
     */
    async noteToSelf(record: SwapRecord): Promise<void> {
      try {
        const chats = useChatStore()
        if (typeof chats?.selfSendMessage !== 'function') return
        let cborPayload = record.cborPayload
        if (!cborPayload) {
          try {
            cborPayload = toHex(encodeSwapRecord(record))
          } catch {
            cborPayload = undefined
          }
        }
        const swapItem: SwapRecordItem = {
          type: 'swap-record',
          swapId: record.id,
          chain: record.chain,
          fromAsset: record.fromAsset,
          toAsset: record.toAsset,
          fromAmount: record.fromAmount,
          toAmount: record.toAmount,
          txHash: record.txHash,
          route: record.route,
          feeDisplay: record.feeDisplay,
          destinationAddress: record.destinationAddress,
          status: record.status,
          timestamp: record.timestamp,
          cborPayload,
        }
        await chats.selfSendMessage({
          items: [swapItem],
          type: 'swap',
          meta: {
            swapId: record.id,
            chain: record.chain,
            txHash: record.txHash,
          },
        })
      } catch (err) {
        console.warn(
          '[useSwapStore] Failed to write the swap note to self:',
          err,
        )
      }
    },

    /** Marks a swap's note to self as accepted by the relay. */
    markNoted(id: string): void {
      const index = this.swaps.findIndex(s => s.id === id)
      if (index < 0) return
      this.swaps[index] = { ...this.swaps[index], noted: true }
      this.saveToStorage()
    },

    async recordSwap(
      params: Omit<SwapRecord, 'id' | 'timestamp' | 'status'> & {
        id?: string
        timestamp?: number
        status?: 'confirmed' | 'pending' | 'failed'
      },
    ): Promise<SwapRecord> {
      const id =
        params.id ||
        'swap-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7)
      const timestamp = params.timestamp || Date.now()
      const status = params.status || 'confirmed'

      const record: SwapRecord = {
        id,
        timestamp,
        chain: params.chain.toLowerCase(),
        fromAsset: params.fromAsset,
        toAsset: params.toAsset,
        fromAmount: params.fromAmount,
        toAmount: params.toAmount,
        txHash: params.txHash,
        route: params.route,
        feeDisplay: params.feeDisplay,
        destinationAddress: params.destinationAddress,
        status,
      }

      // Encode typed canonical CBOR payload
      let cborBytes: Uint8Array | undefined
      try {
        cborBytes = encodeSwapRecord(record)
        record.cborPayload = toHex(cborBytes)
      } catch (err) {
        console.warn('[useSwapStore] Failed to encode CBOR swap payload:', err)
      }

      // Prepend to reactive state (deduplicating by id and txHash)
      const existingIdx = this.swaps.findIndex(
        s => s.id === record.id || (s.txHash && s.txHash === record.txHash),
      )
      if (existingIdx >= 0) {
        this.swaps[existingIdx] = record
      } else {
        this.swaps = [record, ...this.swaps.slice(0, 99)]
      }
      this.saveToStorage()

      await this.noteToSelf(record)

      return record
    },

    /**
     * Message handler for incoming or self-sent swap items.
     * Extracts swap record, decodes CBOR if available, and reactively updates state.
     */
    handleSwapItem(item: SwapRecordItem): void {
      if (!item || item.type !== 'swap-record') return

      let record: SwapRecord = {
        id: item.swapId,
        timestamp: item.timestamp || Date.now(),
        chain: (item.chain || 'solana').toLowerCase(),
        fromAsset: item.fromAsset,
        toAsset: item.toAsset,
        fromAmount: item.fromAmount,
        toAmount: item.toAmount,
        txHash: item.txHash,
        route: item.route,
        feeDisplay: item.feeDisplay,
        destinationAddress: item.destinationAddress,
        status: item.status || 'confirmed',
        cborPayload: item.cborPayload,
      }

      // If cborPayload is present, decode to ensure consistency
      if (item.cborPayload) {
        try {
          const decoded = decodeSwapRecord(fromHex(item.cborPayload))
          record = { ...record, ...decoded }
        } catch {
          // Keep raw fields if decode fails
        }
      }

      const existingIdx = this.swaps.findIndex(
        s => s.id === record.id || (s.txHash && s.txHash === record.txHash),
      )
      if (existingIdx >= 0) {
        const existing = this.swaps[existingIdx]
        this.swaps[existingIdx] = {
          ...existing,
          ...record,
          // A note says what was signed. What this device has since read from the chain, and
          // what only this device knows about its own operation, are not undone by it.
          ...(existing.status !== 'pending'
            ? {
                status: existing.status,
                toAmount: existing.toAmount,
                feeDisplay: existing.feeDisplay,
              }
            : {}),
          recovery: existing.recovery ?? record.recovery,
          noted: existing.noted,
        }
      } else {
        this.swaps = [record, ...this.swaps.slice(0, 99)]
      }
      this.saveToStorage()
    },
  },
})
