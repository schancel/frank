import { defineStore, getActivePinia } from 'pinia'
import {
  type OracleSnapshot,
  type SupportedAsset,
  getDefaultOracleSnapshot,
  fetchOracleSnapshot,
  convertRawToAvu,
  formatAvu,
  DEFAULT_AVU_RATES,
} from '@frank/wallet/oracle'

export interface PriceHistoryPoint {
  timestamp: number
  rates: Record<SupportedAsset, number>
}

export interface OracleState {
  snapshot: OracleSnapshot
  history: PriceHistoryPoint[]
  lastFetched: number
  isRefreshing: boolean
}

const STORAGE_KEY_SNAPSHOT = 'frank_oracle_snapshot_v1'
const STORAGE_KEY_HISTORY = 'frank_oracle_history_v1'
const MAX_HISTORY_POINTS = 168 // 7 days of hourly points

function loadStoredSnapshot(): OracleSnapshot {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY_SNAPSHOT)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed?.rates && typeof parsed?.basketIndex === 'number') {
          return parsed
        }
      }
    }
  } catch {
    // Ignore storage parsing errors and use default
  }
  return getDefaultOracleSnapshot()
}

function loadStoredHistory(): PriceHistoryPoint[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY_HISTORY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) {
          return parsed
        }
      }
    }
  } catch {
    // Ignore storage parsing errors
  }
  return []
}

export const UNIT_RATE_ASSET_METRICS: Record<
  SupportedAsset,
  { symbol: string; multiplier: number }
> = {
  monad: { symbol: '1 MON', multiplier: 1 },
  solana: { symbol: '1 SOL', multiplier: 1 },
  ethereum: { symbol: '1 ETH', multiplier: 1 },
  hyperliquid: { symbol: '1 HYPE', multiplier: 1 },
  tempo: { symbol: '1 TUSD', multiplier: 1 },
  ecash: { symbol: '1M XEC', multiplier: 1_000_000 },
}

/**
 * Returns formatted 1-unit physical compute AVU equivalent string for an asset,
 * e.g. "1 MON ≈ 41.67 AVU" or "1M XEC ≈ 416.67 AVU".
 */
export function formatUnitRate(
  asset: SupportedAsset,
  customRate?: number,
): string {
  const metric = UNIT_RATE_ASSET_METRICS[asset] ?? {
    symbol: `1 ${asset.toUpperCase()}`,
    multiplier: 1,
  }
  const rate = customRate ?? DEFAULT_AVU_RATES[asset] ?? 0
  const avu = rate * metric.multiplier
  const formatted = avu.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${metric.symbol} ≈ ${formatted} AVU`
}

let workerIntervalId: ReturnType<typeof setInterval> | null = null

export const useOracleStore = defineStore('oracle', {
  state: (): OracleState => ({
    snapshot: loadStoredSnapshot(),
    history: loadStoredHistory(),
    lastFetched: 0,
    isRefreshing: false,
  }),

  getters: {
    rates(state): Record<SupportedAsset, number> {
      return state.snapshot.rates
    },

    getAvu(state) {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): number => {
        return convertRawToAvu(rawAmount, asset, state.snapshot.rates[asset])
      }
    },

    formatAvuAmount(state) {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): string => {
        const avu = convertRawToAvu(
          rawAmount,
          asset,
          state.snapshot.rates[asset],
        )
        if (avu <= 0) return ''
        return `≈ ${formatAvu(avu)}`
      }
    },

    formatUnitRate(state) {
      return (asset: SupportedAsset): string => {
        return formatUnitRate(asset, state.snapshot.rates[asset])
      }
    },

    historicalTrend(state): PriceHistoryPoint[] {
      return state.history
    },
  },

  actions: {
    async refresh(): Promise<void> {
      if (this.isRefreshing) return
      this.isRefreshing = true

      try {
        const newSnapshot = await fetchOracleSnapshot()
        this.snapshot = newSnapshot
        this.lastFetched = Date.now()

        // Persist latest snapshot to local storage for instant cold-starts
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(
              STORAGE_KEY_SNAPSHOT,
              JSON.stringify(newSnapshot),
            )
          }
        } catch {
          // Storage quota exceeded or disabled
        }

        // Rolling hourly history compaction (max 168 points = 7 days)
        const lastPoint = this.history[this.history.length - 1]
        const ONE_HOUR_MS = 60 * 60 * 1000
        if (!lastPoint || Date.now() - lastPoint.timestamp >= ONE_HOUR_MS) {
          this.history.push({
            timestamp: Date.now(),
            rates: { ...newSnapshot.rates },
          })
          if (this.history.length > MAX_HISTORY_POINTS) {
            this.history.shift()
          }
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(
                STORAGE_KEY_HISTORY,
                JSON.stringify(this.history),
              )
            }
          } catch {
            // Storage quota exceeded or disabled
          }
        }
      } catch {
        // Fall back gracefully to existing in-memory snapshot
      } finally {
        this.isRefreshing = false
      }
    },

    startBackgroundWorker(intervalMs = 300000): void {
      if (workerIntervalId !== null) return
      // Trigger initial async refresh in background if visible
      if (typeof document === 'undefined' || !document.hidden) {
        void this.refresh()
      }
      workerIntervalId = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        void this.refresh()
      }, intervalMs)
    },

    stopBackgroundWorker(): void {
      if (workerIntervalId !== null) {
        clearInterval(workerIntervalId)
        workerIntervalId = null
      }
    },
  },
})

export function useSafeOracleStore() {
  try {
    if (typeof getActivePinia === 'function' && getActivePinia()) {
      return useOracleStore()
    }
  } catch {
    // Pinia not active or uninitialized
  }
  return {
    snapshot: getDefaultOracleSnapshot(),
    history: [],
    lastFetched: 0,
    isRefreshing: false,
    rates: DEFAULT_AVU_RATES,
    getAvu: (asset: SupportedAsset, rawAmount: bigint | null | undefined) =>
      convertRawToAvu(rawAmount, asset),
    formatAvuAmount: (
      asset: SupportedAsset,
      rawAmount: bigint | null | undefined,
    ) => {
      const avu = convertRawToAvu(rawAmount, asset)
      return avu > 0 ? `≈ ${formatAvu(avu)}` : ''
    },
    formatUnitRate: (asset: SupportedAsset) => formatUnitRate(asset),
    historicalTrend: [],
    refresh: async () => {
      // no-op in safe fallback
    },
    startBackgroundWorker: () => {
      // no-op in safe fallback
    },
    stopBackgroundWorker: () => {
      // no-op in safe fallback
    },
  }
}
