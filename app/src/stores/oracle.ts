import { defineStore, getActivePinia } from 'pinia'
import {
  type AvuRates,
  type HistoryRange,
  type MiningStats,
  type OracleSnapshot,
  type PriceHistoryPoint,
  type PriceProviderId,
  type SupportedAsset,
  type UsdPrices,
  ASSET_FEED_SYMBOLS,
  HISTORY_RANGES,
  calculateAvuRate,
  convertRawToAvu,
  fetchMiningStats,
  fetchOracleSnapshot,
  fetchPriceHistory,
  formatAvu,
  unavailableOracleSnapshot,
} from '@frank/wallet/oracle'
import { translateMessage } from 'src/i18n'
import { UNIT_RATE_ASSET_METRICS } from 'src/utils/avu-units'
import { useSettingsStore } from './settings'

/** One hourly record of the prices the oracle itself fetched. */
export interface PriceObservation {
  timestamp: number
  prices: UsdPrices
}

/** A price line for one asset over one range, and where every point came from. */
export interface AssetHistory {
  /**
   * The provider whose candles these are; 'observed' when no provider had history and
   * the points are this app's own past fetches; null when there is nothing at all.
   */
  source: PriceProviderId | 'observed' | null
  points: PriceHistoryPoint[]
  fetchedAt: number
}

export interface OracleState {
  snapshot: OracleSnapshot
  observations: PriceObservation[]
  histories: Record<string, AssetHistory>
  mining: Record<string, MiningStats>
  lastFetched: number
  isRefreshing: boolean
}

// v2: the v1 records could hold prices that were typed-in constants, so they are never read.
const STORAGE_KEY_SNAPSHOT = 'frank_oracle_snapshot_v2'
const STORAGE_KEY_OBSERVATIONS = 'frank_oracle_observations_v2'
const HOUR_MS = 60 * 60 * 1000
/** A year of hourly records is the longest range the chart draws. */
const OBSERVATION_RETENTION_MS = 366 * 24 * HOUR_MS
/** Prices are refetched every five minutes; one this old has missed several refreshes. */
export const STALE_AFTER_MS = 15 * 60 * 1000
const HISTORY_TTL_MS: Record<HistoryRange, number> = {
  '24h': 10 * 60 * 1000,
  '7d': 30 * 60 * 1000,
  '30d': 6 * HOUR_MS,
  '1y': 6 * HOUR_MS,
}
const MINING_TTL_MS = 30 * 60 * 1000
/** The proof-of-work chains whose mining pay is compared. All three use SHA-256. */
export const MINING_CHAINS = ['bitcoin', 'bitcoin-cash', 'ecash'] as const

/**
 * Assets whose wallet here holds test-network coins while the fetched price is the
 * mainnet coin's. The unit rate is shown labelled as mainnet; a balance gets no value.
 */
const MAINNET_PRICE_ONLY_ON_TESTNET: readonly SupportedAsset[] = ['monad']

function readJson(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return null
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value))
    }
  } catch {
    // Storage full or disabled: the value stays in memory only.
  }
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Keeps only what a real fetch can have written: an asset needs a positive price and the
 * time it was fetched. The AVU rate is recomputed from the price, never read back.
 */
function loadStoredSnapshot(): OracleSnapshot {
  const snapshot = unavailableOracleSnapshot()
  const stored = readJson(
    STORAGE_KEY_SNAPSHOT,
  ) as Partial<OracleSnapshot> | null
  if (!stored?.prices || !stored.fetchedAt) return snapshot
  for (const asset of Object.keys(ASSET_FEED_SYMBOLS) as SupportedAsset[]) {
    const price = stored.prices[asset]
    const fetchedAt = stored.fetchedAt[asset]
    if (isPositive(price) && isPositive(fetchedAt)) {
      snapshot.prices[asset] = price
      snapshot.rates[asset] = calculateAvuRate(price)
      snapshot.fetchedAt[asset] = fetchedAt
    }
  }
  snapshot.timestamp = isPositive(stored.timestamp) ? stored.timestamp : 0
  return snapshot
}

function loadStoredObservations(): PriceObservation[] {
  const stored = readJson(STORAGE_KEY_OBSERVATIONS)
  if (!Array.isArray(stored)) return []
  return stored.filter(
    (o): o is PriceObservation =>
      isPositive(o?.timestamp) && typeof o?.prices === 'object' && o.prices,
  )
}

/**
 * "1 SOL ≈ 1,309.52 AVU" for a fetched rate. Empty when there is no rate: an asset
 * without a real price has no AVU value to state.
 */
export function formatUnitRate(asset: SupportedAsset, rate?: number): string {
  if (!isPositive(rate)) return ''
  const metric = UNIT_RATE_ASSET_METRICS[asset] ?? {
    symbol: `1 ${asset.toUpperCase()}`,
    multiplier: 1,
  }
  const formatted = (rate * metric.multiplier).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${metric.symbol} ≈ ${formatted} AVU`
}

/** "12 min", "3 h", "2 d": how old a price is. */
export function formatAge(ageMs: number): string {
  const minutes = Math.max(1, Math.round(ageMs / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

function translate(key: string, params: Record<string, string>): string {
  let message = translateMessage(key)
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{${name}}`, value)
  }
  return message
}

function historyKey(asset: SupportedAsset, range: HistoryRange): string {
  return `${asset}:${range}`
}

let workerIntervalId: ReturnType<typeof setInterval> | null = null

export const useOracleStore = defineStore('oracle', {
  state: (): OracleState => ({
    snapshot: loadStoredSnapshot(),
    observations: loadStoredObservations(),
    histories: {},
    mining: {},
    lastFetched: 0,
    isRefreshing: false,
  }),

  getters: {
    rates(state): AvuRates {
      return state.snapshot.rates
    },

    /** How old an asset's price is, or undefined when it has none. */
    priceAgeMs(state) {
      return (asset: SupportedAsset, now = Date.now()): number | undefined => {
        const fetchedAt = state.snapshot.fetchedAt[asset]
        return isPositive(fetchedAt) && isPositive(state.snapshot.rates[asset])
          ? Math.max(0, now - fetchedAt)
          : undefined
      }
    },

    /**
     * Whether a balance of this asset has a market value here. A testnet coin has none
     * even when its mainnet namesake has a price.
     */
    balanceHasMarketValue() {
      return (asset: SupportedAsset): boolean =>
        !(
          useSettingsStore().networkMode === 'testnet' &&
          MAINNET_PRICE_ONLY_ON_TESTNET.includes(asset)
        )
    },

    /** AVU value of a balance; 0 when the asset has no real price to value it with. */
    getAvu(state) {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): number => {
        if (!this.balanceHasMarketValue(asset)) return 0
        return (
          convertRawToAvu(rawAmount, asset, state.snapshot.rates[asset]) ?? 0
        )
      }
    },

    /**
     * "≈ 92.50 AVU", or empty when there is no real price or nothing to value. Valued at a
     * price that has gone stale, it says how old the price is, as the unit rate line does.
     */
    formatAvuAmount() {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): string => {
        const avu = this.getAvu(asset, rawAmount)
        if (!(avu > 0)) return ''
        const amount = `≈ ${formatAvu(avu)}`
        const age = this.priceAgeMs(asset)
        return age !== undefined && age > STALE_AFTER_MS
          ? translate('walletPanel.avuStalePrice', {
              rate: amount,
              age: formatAge(age),
            })
          : amount
      }
    },

    /**
     * The unit rate line. Empty with no price; marked with the price's age once stale;
     * marked as the mainnet coin's price where the wallet holds testnet coins.
     */
    formatUnitRate(state) {
      return (asset: SupportedAsset): string => {
        let line = formatUnitRate(asset, state.snapshot.rates[asset])
        if (!line) return ''
        if (!this.balanceHasMarketValue(asset)) {
          line = translate('walletPanel.avuMainnetPrice', { rate: line })
        }
        const age = this.priceAgeMs(asset)
        if (age !== undefined && age > STALE_AFTER_MS) {
          line = translate('walletPanel.avuStalePrice', {
            rate: line,
            age: formatAge(age),
          })
        }
        return line
      }
    },

    /**
     * The price line to draw for an asset and range: the provider's candles when it has
     * any, otherwise this app's own hourly records inside the range, otherwise nothing.
     */
    historyFor(state) {
      return (
        asset: SupportedAsset,
        range: HistoryRange,
        now = Date.now(),
      ): AssetHistory => {
        const fetched = state.histories[historyKey(asset, range)]
        if (fetched && fetched.points.length > 0) return fetched
        const oldest = now - HISTORY_RANGES[range].spanSeconds * 1000
        const points = state.observations.flatMap(o => {
          const price = o.prices[asset]
          return o.timestamp >= oldest && isPositive(price)
            ? [{ timestamp: o.timestamp, price }]
            : []
        })
        return {
          source: points.length > 0 ? 'observed' : null,
          points,
          fetchedAt: fetched?.fetchedAt ?? 0,
        }
      }
    },
  },

  actions: {
    /**
     * Fetches prices. An asset whose price came back is replaced; one that did not keeps
     * its last fetched price and that price's own time, so it shows as stale, never fresh.
     */
    async refresh(): Promise<void> {
      if (this.isRefreshing) return
      this.isRefreshing = true

      try {
        const fetched = await fetchOracleSnapshot()
        if (Object.keys(fetched.prices).length === 0) return

        this.snapshot = {
          ...fetched,
          prices: { ...this.snapshot.prices, ...fetched.prices },
          rates: { ...this.snapshot.rates, ...fetched.rates },
          fetchedAt: { ...this.snapshot.fetchedAt, ...fetched.fetchedAt },
        }
        this.lastFetched = fetched.timestamp
        writeJson(STORAGE_KEY_SNAPSHOT, this.snapshot)

        // One record an hour, of the prices this fetch returned and nothing else.
        const last = this.observations[this.observations.length - 1]
        if (!last || fetched.timestamp - last.timestamp >= HOUR_MS) {
          const oldest = fetched.timestamp - OBSERVATION_RETENTION_MS
          this.observations = [
            ...this.observations.filter(o => o.timestamp >= oldest),
            { timestamp: fetched.timestamp, prices: { ...fetched.prices } },
          ]
          writeJson(STORAGE_KEY_OBSERVATIONS, this.observations)
        }
      } catch {
        // Keep what was last fetched; its age shows it is no longer current.
      } finally {
        this.isRefreshing = false
      }
    },

    /** Loads an asset's price history from the providers, at most once per TTL. */
    async loadHistory(
      asset: SupportedAsset,
      range: HistoryRange,
    ): Promise<void> {
      const symbol = ASSET_FEED_SYMBOLS[asset]
      if (!symbol) return
      const key = historyKey(asset, range)
      const cached = this.histories[key]
      if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS[range])
        return
      const history = await fetchPriceHistory(symbol, range)
      // A failed reload keeps the candles already fetched; it never blanks or invents them.
      if (history.points.length === 0 && cached) return
      this.histories[key] = {
        source: history.provider,
        points: history.points,
        fetchedAt: Date.now(),
      }
    },

    /** Loads the proof-of-work chains' issuance and hashrate, at most once per TTL. */
    async loadMiningStats(): Promise<void> {
      await Promise.all(
        MINING_CHAINS.map(async chain => {
          const cached = this.mining[chain]
          if (cached && Date.now() - cached.fetchedAt < MINING_TTL_MS) return
          const stats = await fetchMiningStats(chain)
          if (stats) this.mining[chain] = stats
        }),
      )
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

export type OracleStore = ReturnType<typeof useOracleStore>

/**
 * The oracle store, or, where no Pinia is active, a stand-in that knows no prices: every
 * value it reports is "none", never a default.
 */
export function useSafeOracleStore(): OracleStore {
  try {
    if (typeof getActivePinia === 'function' && getActivePinia()) {
      return useOracleStore()
    }
  } catch {
    // Pinia not active or uninitialized
  }
  const none: AssetHistory = { source: null, points: [], fetchedAt: 0 }
  return {
    snapshot: unavailableOracleSnapshot(),
    observations: [],
    histories: {},
    mining: {},
    lastFetched: 0,
    isRefreshing: false,
    rates: {},
    priceAgeMs: () => undefined,
    balanceHasMarketValue: () => false,
    getAvu: () => 0,
    formatAvuAmount: () => '',
    formatUnitRate: () => '',
    historyFor: () => none,
    refresh: async () => undefined,
    loadHistory: async () => undefined,
    loadMiningStats: async () => undefined,
    startBackgroundWorker: () => undefined,
    stopBackgroundWorker: () => undefined,
  } as unknown as OracleStore
}
