import { defineStore, getActivePinia } from 'pinia'
import {
  type AvuHash,
  type AvuRates,
  type HistoryRange,
  type OracleSnapshot,
  type PriceHistoryPoint,
  type PriceProviderId,
  type SupportedAsset,
  ASSET_FEED_SYMBOLS,
  AVU_HASH_CHAINS,
  HISTORY_RANGES,
  CHAIN_STATS_REFRESH_INTERVAL_MS,
  ORACLE_REFRESH_INTERVAL_MS,
  convertRawToAvu,
  fetchMiningStats,
  fetchPriceHistory,
  fetchPrices,
  formatAvu,
  latestHashingEfficiency,
  miningDollarsPerKwh,
  unavailableOracleSnapshot,
} from '@frank/wallet/oracle'
import { translateMessage } from 'src/i18n'
import { UNIT_RATE_ASSET_METRICS } from 'src/utils/avu-units'
import { useSettingsStore } from './settings'
import {
  type OracleSeries,
  joinPriceSeries,
  restoreOracleSeries,
  saveOracleSeries,
  snapshotFromSeries,
  thinOldObservations,
} from './oracle-series'

export type { PriceObservation, ProviderCandles } from './oracle-series'

/** A price line for one asset over one range, and where its points came from. */
export interface AssetHistory {
  /** Oldest first, one per step of the range at most. */
  points: PriceHistoryPoint[]
  /** How many of the points are prices this app fetched and recorded itself. */
  recorded: number
  /** The provider whose candles the other points are; null when there are none. */
  provider: PriceProviderId | null
}

export interface OracleState extends OracleSeries {
  /**
   * The current prices, chain statistics, AVU_hash and AVU rates. A view of the series
   * (snapshotFromSeries), replaced whenever an observation is recorded or restored.
   */
  snapshot: OracleSnapshot
}

/**
 * What a view on screen needs kept current: 'live' is the prices and the mined chains'
 * statistics every AVU value is computed from; a history feed is one coin's candles for
 * one chart range.
 */
export type OracleFeed = 'live' | `history:${SupportedAsset}:${HistoryRange}`

export function historyFeed(
  asset: SupportedAsset,
  range: HistoryRange,
): OracleFeed {
  return `history:${asset}:${range}`
}

const HOUR_MS = 60 * 60 * 1000
/** A price this old has missed a refresh. */
export const STALE_AFTER_MS = 2 * ORACLE_REFRESH_INTERVAL_MS
/** Difficulty, subsidy and supply move slowly: chain statistics this old are stale. */
export const MINING_STALE_AFTER_MS = 2 * HOUR_MS
/**
 * While something is on screen, how often the store looks for a series that has come due.
 * Looking costs nothing; a series is still fetched once per ORACLE_REFRESH_INTERVAL_MS.
 */
const CHECK_EVERY_MS = 60 * 1000
/**
 * After a failed fetch the wait before the next try doubles: one interval, then two,
 * four, eight, and sixteen from then on (10, 20, 40, 80, 160 minutes at the default).
 * A successful fetch returns the series to one interval.
 */
const MAX_BACKOFF_INTERVALS = 16

export function retryDelayMs(consecutiveFailures: number): number {
  return (
    ORACLE_REFRESH_INTERVAL_MS *
    Math.min(2 ** Math.max(0, consecutiveFailures - 1), MAX_BACKOFF_INTERVALS)
  )
}

/**
 * Assets whose wallet here holds test-network coins while the fetched price is the
 * mainnet coin's. The unit rate is shown labelled as mainnet; a balance gets no value.
 */
const MAINNET_PRICE_ONLY_ON_TESTNET: readonly SupportedAsset[] = ['monad']

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// ---- What is fetched, and when ---------------------------------------------------------------
//
// A series is one of: 'prices' (one request round to the price providers, every coin),
// 'mining:<chain>' (one chain's statistics) or 'history:<asset>:<range>' (one coin's
// candles). Each is fetched on its own schedule, shared by everything that shows it.

function seriesOf(feed: OracleFeed): string[] {
  if (feed === 'live') {
    return ['prices', ...AVU_HASH_CHAINS.map(chain => `mining:${chain}`)]
  }
  // A coin with no price source has no history to ask anyone for.
  const asset = feed.split(':')[1] as SupportedAsset
  return ASSET_FEED_SYMBOLS[asset] ? [feed] : []
}

interface Schedule {
  /** How many mounted, visible views want each series. */
  wanted: Map<string, number>
  /** The request under way for a series, shared by everyone who asks meanwhile. */
  inFlight: Map<string, Promise<void>>
  /** Consecutive failures of a series and the earliest time of its next try. */
  failed: Map<string, { count: number; retryAt: number }>
  timer: ReturnType<typeof setInterval> | null
  onVisibilityChange: (() => void) | null
}

/** Per store instance; none of it is state and none of it is saved. */
const schedules = new WeakMap<object, Schedule>()

function scheduleOf(store: object): Schedule {
  let schedule = schedules.get(store)
  if (!schedule) {
    schedule = {
      wanted: new Map(),
      inFlight: new Map(),
      failed: new Map(),
      timer: null,
      onVisibilityChange: null,
    }
    schedules.set(store, schedule)
  }
  return schedule
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function translate(key: string, params: Record<string, string>): string {
  let message = translateMessage(key)
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{${name}}`, value)
  }
  return message
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

export const useOracleStore = defineStore('oracle', {
  state: (): OracleState => ({
    snapshot: snapshotFromSeries({
      priceObservations: [],
      miningObservations: {},
    }),
    priceObservations: [],
    miningObservations: {},
    candles: {},
  }),

  getters: {
    rates(state): AvuRates {
      return state.snapshot.rates
    },

    /** kWh per dollar read off mining; undefined when no basket coin has all its inputs. */
    avuHash(state): AvuHash | undefined {
      return state.snapshot.avuHash
    },

    /**
     * How old AVU_hash's oldest input is, when that makes it stale: a basket coin's price
     * that missed several refreshes, or chain statistics that missed several refetches.
     * Undefined while every input is current, and when there is no AVU_hash.
     */
    avuHashStaleAgeMs(state) {
      return (now = Date.now()): number | undefined => {
        const avuHash = state.snapshot.avuHash
        if (!avuHash) return undefined
        const priceAge = now - avuHash.pricesAsOf
        const chainAge = now - avuHash.chainsAsOf
        const stale = [
          priceAge > STALE_AFTER_MS ? priceAge : 0,
          chainAge > MINING_STALE_AFTER_MS ? chainAge : 0,
        ]
        return Math.max(...stale) || undefined
      }
    },

    /**
     * How old the oldest stale input of an asset's AVU value is: its own price or
     * AVU_hash. Undefined while both are current.
     */
    valueStaleAgeMs() {
      return (asset: SupportedAsset, now = Date.now()): number | undefined => {
        const priceAge = this.priceAgeMs(asset, now)
        const stale = [
          priceAge !== undefined && priceAge > STALE_AFTER_MS ? priceAge : 0,
          this.avuHashStaleAgeMs(now) ?? 0,
        ]
        return Math.max(...stale) || undefined
      }
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
     * "≈ 92.50 AVU", or empty when there is no real price, no AVU_hash or nothing to
     * value. Valued at a price or an AVU_hash that has gone stale, it says how old that
     * is, as the unit rate line does.
     */
    formatAvuAmount() {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): string => {
        const avu = this.getAvu(asset, rawAmount)
        if (!(avu > 0)) return ''
        const amount = `≈ ${formatAvu(avu)}`
        const age = this.valueStaleAgeMs(asset)
        return age !== undefined
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
        const age = this.valueStaleAgeMs(asset)
        if (age !== undefined) {
          line = translate('walletPanel.avuStalePrice', {
            rate: line,
            age: formatAge(age),
          })
        }
        return line
      }
    },

    /**
     * The price line to draw for an asset and range: the prices this app recorded inside
     * the range, with the provider's candles wherever the app has no record of its own
     * (joinPriceSeries). Every point is a fetched price; where there is neither, there
     * is no point.
     */
    historyFor(state) {
      return (
        asset: SupportedAsset,
        range: HistoryRange,
        now = Date.now(),
      ): AssetHistory => {
        const { spanSeconds, stepSeconds } = HISTORY_RANGES[range]
        const oldest = now - spanSeconds * 1000
        const recorded = state.priceObservations.flatMap(o => {
          const price = o.prices[asset]
          return o.timestamp >= oldest && o.timestamp <= now && price
            ? [{ timestamp: o.timestamp, price: price.usd }]
            : []
        })
        const candles = state.candles[`${asset}:${range}`]
        const joined = joinPriceSeries(
          recorded,
          (candles?.points ?? []).filter(p => p.timestamp >= oldest),
          stepSeconds * 1000,
        )
        return {
          ...joined,
          provider:
            candles && joined.points.length > joined.recorded
              ? candles.provider
              : null,
        }
      }
    },

    /**
     * Bitcoin's kWh per dollar at each time this app recorded a bitcoin price, inside a
     * range: that price with the chain statistics recorded at or before it, by the same
     * formula and efficiency figure as the bundled months. It continues the bundled
     * monthly line with the app's own record. A price with no chain statistics recorded
     * shortly before it has no point. One point per step of the range at most.
     */
    bitcoinAvuHashHistory(state) {
      return (
        range: HistoryRange,
        now = Date.now(),
      ): Array<{ timestamp: number; kwhPerDollar: number }> => {
        const efficiency = latestHashingEfficiency('sha256')
        const chain = state.miningObservations.bitcoin ?? []
        if (!efficiency || chain.length === 0) return []
        const { spanSeconds, stepSeconds } = HISTORY_RANGES[range]
        const oldest = now - spanSeconds * 1000
        const points: PriceHistoryPoint[] = []
        let next = 0
        for (const observation of state.priceObservations) {
          const priceUsd = observation.prices.bitcoin?.usd
          while (
            next < chain.length &&
            chain[next].fetchedAt <= observation.timestamp
          ) {
            next++
          }
          const stats = chain[next - 1]
          if (
            !priceUsd ||
            !stats ||
            observation.timestamp < oldest ||
            observation.timestamp - stats.fetchedAt > MINING_STALE_AFTER_MS
          ) {
            continue
          }
          const dollarsPerKwh = miningDollarsPerKwh({
            priceUsd,
            coinsPerBlock: stats.subsidyCoinsPerBlock,
            hashesPerBlock: stats.hashesPerBlock,
            hashesPerKwh: efficiency.hashesPerKwh,
          })
          if (dollarsPerKwh !== undefined) {
            points.push({
              timestamp: observation.timestamp,
              price: 1 / dollarsPerKwh,
            })
          }
        }
        return joinPriceSeries(points, [], stepSeconds * 1000).points.map(
          p => ({ timestamp: p.timestamp, kwhPerDollar: p.price }),
        )
      }
    },
  },

  actions: {
    /**
     * Says a view on screen is showing a feed, and returns the function that says it no
     * longer is. While at least one view holds a feed, its series are fetched when they
     * are older than ORACLE_REFRESH_INTERVAL_MS and the tab is visible. With no holder
     * nothing is fetched and no timer runs.
     */
    acquire(feed: OracleFeed): () => void {
      const schedule = scheduleOf(this)
      const series = seriesOf(feed)
      for (const name of series) {
        schedule.wanted.set(name, (schedule.wanted.get(name) ?? 0) + 1)
      }
      if (schedule.wanted.size > 0 && schedule.timer === null) {
        schedule.timer = setInterval(
          () => void this.refreshDue(),
          CHECK_EVERY_MS,
        )
        if (typeof document !== 'undefined') {
          schedule.onVisibilityChange = () => void this.refreshDue()
          document.addEventListener(
            'visibilitychange',
            schedule.onVisibilityChange,
          )
        }
      }
      void this.refreshDue()

      let released = false
      return () => {
        if (released) return
        released = true
        for (const name of series) {
          const holders = (schedule.wanted.get(name) ?? 1) - 1
          if (holders > 0) schedule.wanted.set(name, holders)
          else schedule.wanted.delete(name)
        }
        if (schedule.wanted.size > 0) return
        if (schedule.timer !== null) clearInterval(schedule.timer)
        schedule.timer = null
        if (schedule.onVisibilityChange) {
          document.removeEventListener(
            'visibilitychange',
            schedule.onVisibilityChange,
          )
          schedule.onVisibilityChange = null
        }
      }
    },

    /**
     * Fetches every series a view on screen wants that has come due. A series fetched
     * within the interval is served from the cache; one whose last fetch failed waits out
     * its back-off (retryDelayMs). Nothing happens while the tab is hidden or nothing
     * wants anything.
     */
    async refreshDue(): Promise<void> {
      const schedule = scheduleOf(this)
      if (schedule.wanted.size === 0 || tabHidden()) return
      try {
        // What is cached is shown, and decides what is due, before anything is fetched.
        await this.restored
      } catch {
        // The cache could not be read: carry on with what is fetched from here.
      }
      if (tabHidden()) return
      const now = Date.now()
      await Promise.all(
        Array.from(schedule.wanted.keys())
          .filter(name => now >= this.nextFetchAt(name))
          .map(name => this.fetchSeries(name)),
      )
    },

    /** The earliest time a series may be fetched again. */
    nextFetchAt(name: string): number {
      const [kind, ...rest] = name.split(':')
      let fetchedAt = 0
      if (kind === 'prices') {
        const observations = this.priceObservations
        fetchedAt = observations[observations.length - 1]?.timestamp ?? 0
      } else if (kind === 'mining') {
        const observations = this.miningObservations[rest[0]] ?? []
        fetchedAt = observations[observations.length - 1]?.fetchedAt ?? 0
      } else {
        fetchedAt = this.candles[rest.join(':')]?.fetchedAt ?? 0
      }
      const interval =
        kind === 'mining'
          ? CHAIN_STATS_REFRESH_INTERVAL_MS
          : ORACLE_REFRESH_INTERVAL_MS
      return Math.max(
        fetchedAt ? fetchedAt + interval : 0,
        scheduleOf(this).failed.get(name)?.retryAt ?? 0,
      )
    },

    /** One request for a series, however many ask while it is under way. */
    fetchSeries(name: string): Promise<void> {
      const schedule = scheduleOf(this)
      const underWay = schedule.inFlight.get(name)
      if (underWay) return underWay
      const request = this.fetchAndRecord(name)
        .catch(() => false)
        .then(recorded => {
          schedule.inFlight.delete(name)
          if (recorded) {
            schedule.failed.delete(name)
            return
          }
          // What was last recorded stays, with its own time; the next try waits.
          const count = (schedule.failed.get(name)?.count ?? 0) + 1
          schedule.failed.set(name, {
            count,
            retryAt: Date.now() + retryDelayMs(count),
          })
        })
      schedule.inFlight.set(name, request)
      return request
    },

    /**
     * Fetches one series and appends what came back to the cache. False when nothing came
     * back: nothing is recorded then, and nothing already recorded is touched.
     */
    async fetchAndRecord(name: string): Promise<boolean> {
      const [kind, ...rest] = name.split(':')
      if (kind === 'prices') {
        const fetched = await fetchPrices()
        const last = this.priceObservations[this.priceObservations.length - 1]
        if (
          Object.keys(fetched.prices).length === 0 ||
          (last && fetched.timestamp <= last.timestamp)
        ) {
          return false
        }
        this.priceObservations = thinOldObservations(
          [...this.priceObservations, fetched],
          o => o.timestamp,
          fetched.timestamp,
        )
      } else if (kind === 'mining') {
        const stats = await fetchMiningStats(rest[0])
        const recorded = this.miningObservations[rest[0]] ?? []
        const last = recorded[recorded.length - 1]
        if (!stats || (last && stats.fetchedAt <= last.fetchedAt)) return false
        this.miningObservations = {
          ...this.miningObservations,
          [rest[0]]: thinOldObservations(
            [...recorded, stats],
            o => o.fetchedAt,
            stats.fetchedAt,
          ),
        }
      } else {
        const [asset, range] = rest as [SupportedAsset, HistoryRange]
        const symbol = ASSET_FEED_SYMBOLS[asset]
        if (!symbol) return false
        const history = await fetchPriceHistory(symbol, range)
        if (!history.provider || history.points.length === 0) return false
        this.candles = {
          ...this.candles,
          [`${asset}:${range}`]: {
            provider: history.provider,
            points: history.points,
            fetchedAt: Date.now(),
          },
        }
        return true
      }
      this.snapshot = snapshotFromSeries(this)
      return true
    },
  },

  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveOracleSeries(storage, state)
    },
    async restore(storage): Promise<Partial<OracleState>> {
      const series = await restoreOracleSeries(storage)
      return { ...series, snapshot: snapshotFromSeries(series) }
    },
  },
})

export type OracleStore = ReturnType<typeof useOracleStore>

/**
 * The oracle store, or, where no Pinia is active, a stand-in that knows no prices: every
 * value it reports is "none", never a default, and it fetches nothing.
 */
export function useSafeOracleStore(): OracleStore {
  try {
    if (typeof getActivePinia === 'function' && getActivePinia()) {
      return useOracleStore()
    }
  } catch {
    // Pinia not active or uninitialized
  }
  const none: AssetHistory = { points: [], recorded: 0, provider: null }
  return {
    snapshot: unavailableOracleSnapshot(),
    priceObservations: [],
    miningObservations: {},
    candles: {},
    rates: {},
    avuHash: undefined,
    avuHashStaleAgeMs: () => undefined,
    valueStaleAgeMs: () => undefined,
    priceAgeMs: () => undefined,
    balanceHasMarketValue: () => false,
    getAvu: () => 0,
    formatAvuAmount: () => '',
    formatUnitRate: () => '',
    historyFor: () => none,
    bitcoinAvuHashHistory: () => [],
    acquire: () => () => undefined,
    refreshDue: async () => undefined,
  } as unknown as OracleStore
}
