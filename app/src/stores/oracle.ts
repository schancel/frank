import { defineStore, getActivePinia } from 'pinia'
import { toRaw } from 'vue'
import {
  type AvuHash,
  STALE_AFTER_MS,
  MINING_STALE_AFTER_MS,
  type AvuRates,
  type AvuSpot,
  type FeedRequest,
  type OracleFeed,
  type OracleInputs,
  type OracleRates,
  type SupportedAsset,
  DIRECT_FEED_REFRESH_INTERVAL_MS,
  ORACLE_REFRESH_INTERVAL_MS,
  at as pointAt,
  computeOracleRates,
  convertRawToAvu,
  fetchOracleFeed,
  temporaryDirectFeed,
  unavailableOracleRates,
} from '@frank/wallet/oracle'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain'
import { translateMessage } from 'src/i18n'
import { UNIT_RATE_ASSET_METRICS, formatAvu } from 'src/utils/avu-units'
import { useSettingsStore } from './settings'
import {
  type OracleCache,
  coverLatest,
  coverRange,
  emptyOracleCache,
  mergeFeed,
  missingRanges,
  oracleInputs,
  restoreOracleCache,
  saveOracleCache,
} from './oracle-series'

export interface OracleState {
  /** The local timeseries: every feed point received, and what stretches they cover. */
  cache: OracleCache
  /**
   * The AVU rate of every asset, AVU_hash and AVU_spot, computed once from the series
   * each time a latest answer arrives (or the cache is restored). Every balance and amount
   * on screen reads this; nothing computes a rate per component.
   */
  current: OracleRates
}

const POLL_SECONDS = ORACLE_REFRESH_INTERVAL_MS / 1000
export { STALE_AFTER_MS, MINING_STALE_AFTER_MS } from '@frank/wallet/oracle'
/**
 * While the app is visible, how often the store looks whether the feed has come due.
 * Looking costs nothing; the feed is still asked for once per ORACLE_REFRESH_INTERVAL_MS.
 */
const CHECK_EVERY_MS = 60 * 1000
/**
 * After a failed request the wait before the next try doubles: one interval, then two,
 * four, eight, and sixteen from then on. A successful one returns to one interval.
 */
const MAX_BACKOFF_INTERVALS = 16

export function retryDelayMs(consecutiveFailures: number): number {
  return (
    ORACLE_REFRESH_INTERVAL_MS *
    Math.min(2 ** Math.max(0, consecutiveFailures - 1), MAX_BACKOFF_INTERVALS)
  )
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The one place the app asks for the oracle feed: its relay first; the temporary direct
 * adapter only when the relay answers 404 for the route (it does not serve the feed yet).
 * Undefined when the relay failed in any other way: what was last received stays.
 */
export type FeedSource = (
  request: FeedRequest,
  /** The time (unix seconds) of the latest fetched point held for a series, if any. */
  heldAt: (seriesName: string) => number | undefined,
) => Promise<FeedAnswer | undefined>

/** A feed, and how often its source is to be asked again when that is not the default. */
export type FeedAnswer = OracleFeed | { feed: OracleFeed; refreshMs: number }

async function relayThenDirect(
  request: FeedRequest,
  heldAt: (seriesName: string) => number | undefined,
): Promise<FeedAnswer | undefined> {
  const answer = await fetchOracleFeed(
    loadMonadChainConfigFromEnv().relayBaseUrl,
    request,
  )
  if (answer.status === 'ok') return answer.feed
  // TEMPORARY: delete this branch with packages/price-feeds/src/temporary-direct-feed.ts
  // when relays serve /oracle/v1/feed. The adapter asks every provider for every coin,
  // so it is asked less often than a relay, and it is told what the saved series
  // already hold so a restart does not repeat a chain reading taken this hour.
  if (answer.status === 'not-served') {
    return {
      feed: await temporaryDirectFeed(request, { heldAt }),
      refreshMs: DIRECT_FEED_REFRESH_INTERVAL_MS,
    }
  }
  return undefined
}

interface Schedule {
  /** How many holders want the feed kept current (the app shell, while it is mounted). */
  holders: number
  latestInFlight: Promise<void> | null
  rangesInFlight: Map<string, Promise<void>>
  failures: number
  retryAt: number
  lastLatestAt: number
  timer: ReturnType<typeof setInterval> | null
  onVisibilityChange: (() => void) | null
  source: FeedSource
}

/**
 * Per store; none of it is state and none of it is saved. Keyed by the store's state object
 * (as the forum and topic stores key theirs), never by the `this` of an action: in a
 * development build Pinia's devtools plugin calls every action with a new Proxy of the
 * store as `this`, so a map keyed by `this` gave each call a schedule of its own. `acquire`
 * then counted its holder on one schedule, `refreshDue` read no holder on another, and the
 * feed was never asked for.
 */
const schedules = new WeakMap<object, Schedule>()

function scheduleOf(store: { $state: object }): Schedule {
  const owner = toRaw(store.$state)
  let schedule = schedules.get(owner)
  if (!schedule) {
    schedule = {
      holders: 0,
      latestInFlight: null,
      rangesInFlight: new Map(),
      failures: 0,
      retryAt: 0,
      lastLatestAt: 0,
      timer: null,
      onVisibilityChange: null,
      source: relayThenDirect,
    }
    schedules.set(owner, schedule)
  }
  return schedule
}

function windowHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function translate(key: string, params: Record<string, string>): string {
  let message = translateMessage(key)
  for (const [name, value] of Object.entries(params)) {
    message = message.replaceAll(`{${name}}`, value)
  }
  return message
}

/** "12 min", "3 h", "2 d": how old a value is. */
export function formatAge(ageMs: number): string {
  const minutes = Math.max(1, Math.round(ageMs / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

export const useOracleStore = defineStore('oracle', {
  state: (): OracleState => ({
    cache: emptyOracleCache(),
    current: unavailableOracleRates(),
  }),

  getters: {
    rates(state): AvuRates {
      return state.current.rates
    },

    /** kWh per unit of value read off mining; undefined when no basket entry has its inputs. */
    avuHash(state): AvuHash | undefined {
      return state.current.avuHash
    },

    avuSpot(state): AvuSpot {
      return state.current.avuSpot
    },

    /** What the formulas read, for a view that evaluates them at other times (the chart). */
    inputs(state): OracleInputs | undefined {
      return oracleInputs(state.cache)
    },

    /**
     * How old AVU_hash's oldest market or chain reading is, when that makes it stale: older
     * than a couple of chain-statistics refreshes, or served flagged stale. Undefined while
     * current, and when there is no AVU_hash.
     */
    avuHashStaleAgeMs(state) {
      return (now = Date.now()): number | undefined => {
        const avuHash = state.current.avuHash
        if (!avuHash) return undefined
        const age = Math.max(0, now - avuHash.oldestInputAt * 1000)
        return age > MINING_STALE_AFTER_MS || avuHash.stale ? age : undefined
      }
    },

    /** How old an asset's price is, or undefined when it has no rate. */
    priceAgeMs(state) {
      return (asset: SupportedAsset, now = Date.now()): number | undefined => {
        const at = state.current.priceAt[asset]
        return isPositive(at) && isPositive(state.current.rates[asset])
          ? Math.max(0, now - at * 1000)
          : undefined
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

    /**
     * Whether the wallets hold test-network coins. Their AVU value is the main network
     * coin's (the feed prices by main network only) and is shown marked as testnet.
     */
    valuesAreTestnet(): boolean {
      return useSettingsStore().networkMode === 'testnet'
    },

    /** AVU value of a raw amount; 0 when the asset has no rate to value it with. */
    getAvu(state) {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): number =>
        convertRawToAvu(rawAmount, asset, state.current.rates[asset]) ?? 0
    },

    /**
     * THE helper for showing what an amount is worth: a raw amount of an asset in, a short
     * AVU string out, or nothing. "≈ 92.5 AVU"; "≈ 1.31 kAVU · testnet" for a test-network
     * coin; with its age once the price or AVU_hash behind it has gone stale. Empty when
     * there is no rate (first launch, offline, a coin nobody prices) or nothing to value:
     * the caller then shows the coin amount alone. Never a dollar figure, never a guess.
     */
    formatAvuAmount() {
      return (
        asset: SupportedAsset,
        rawAmount: bigint | null | undefined,
      ): string => {
        const figure = formatAvu(this.getAvu(asset, rawAmount))
        return figure ? this.marked(asset, `≈ ${figure}`) : ''
      }
    },

    /** The same for an AVU value already computed (a decimal token amount times a rate). */
    formatAvuValue() {
      return (asset: SupportedAsset, avu: number): string => {
        const figure = formatAvu(avu)
        return figure ? this.marked(asset, `≈ ${figure}`) : ''
      }
    },

    /** Adds the testnet marker and, once stale, the age to a figure. */
    marked() {
      return (asset: SupportedAsset, figure: string): string => {
        let line = figure
        if (this.valuesAreTestnet) {
          line = translate('walletPanel.avuTestnetValue', { rate: line })
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

    /** "1 SOL ≈ 1.31 kAVU", marked like any other figure. Empty with no rate. */
    formatUnitRate(state) {
      return (asset: SupportedAsset): string => {
        const rate = state.current.rates[asset]
        if (!isPositive(rate)) return ''
        const metric = UNIT_RATE_ASSET_METRICS[asset] ?? {
          symbol: `1 ${asset.toUpperCase()}`,
          multiplier: 1,
        }
        return this.marked(
          asset,
          `${metric.symbol} ≈ ${formatAvu(rate * metric.multiplier)}`,
        )
      }
    },
  },

  actions: {
    /** Replaces how the feed is asked for. For tests. */
    useFeedSource(source: FeedSource): void {
      scheduleOf(this).source = source
    },

    /**
     * Says the app is showing AVU values, and returns the function that says it no longer
     * is. Held once by the app shell for as long as it is mounted, because AVU figures
     * stand beside balances and amounts everywhere. While held, the latest feed is asked
     * for once per ORACLE_REFRESH_INTERVAL_MS, and never while the window is hidden. With
     * no holder nothing is fetched and no timer runs.
     */
    acquire(): () => void {
      const schedule = scheduleOf(this)
      schedule.holders++
      if (schedule.timer === null) {
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
        schedule.holders--
        if (schedule.holders > 0) return
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
     * When the latest feed was last received: in this session, or, after a restart, by
     * the saved series (the end of the newest stretch of latest answers they record).
     */
    lastLatestAt(): number {
      const saved = this.cache.coverage
        .filter(c => c.step === POLL_SECONDS)
        .reduce((newest, c) => Math.max(newest, c.until), 0)
      return Math.max(scheduleOf(this).lastLatestAt, saved * 1000)
    },

    /** How often the source of the last answer is to be asked: a relay's 10 minutes by default. */
    refreshIntervalMs(): number {
      return this.cache.refreshMs ?? ORACLE_REFRESH_INTERVAL_MS
    },

    /** The earliest time the latest feed may be asked for again. */
    nextFetchAt(): number {
      const last = this.lastLatestAt()
      return Math.max(
        last ? last + this.refreshIntervalMs() : 0,
        scheduleOf(this).retryAt,
      )
    },

    /** The time of the latest point held for a series that was fetched, not bundled. */
    heldAt(seriesName: string): number | undefined {
      const held = this.cache.series[seriesName]
      return held && !held.stale
        ? pointAt(held.points, Infinity)?.[0]
        : undefined
    },

    /**
     * Asks for the latest feed if it has come due. Nothing happens while the window is
     * hidden or nobody holds the feed; a failed request waits out its back-off.
     */
    async refreshDue(): Promise<void> {
      const schedule = scheduleOf(this)
      if (schedule.holders === 0 || windowHidden()) return
      try {
        // What is cached is shown before anything is fetched.
        await this.restored
      } catch {
        // The cache could not be read: carry on with what is fetched from here.
      }
      if (windowHidden() || Date.now() < this.nextFetchAt()) return
      await this.fetchLatest()
    },

    /** One request for the latest feed, however many ask while it is under way. */
    fetchLatest(): Promise<void> {
      const schedule = scheduleOf(this)
      if (schedule.latestInFlight) return schedule.latestInFlight
      const request = schedule
        .source({ latest: true }, name => this.heldAt(name))
        .catch(() => undefined)
        .then(answer => {
          schedule.latestInFlight = null
          const now = Date.now()
          const feed = answer && 'feed' in answer ? answer.feed : answer
          const refreshMs =
            answer && 'feed' in answer
              ? answer.refreshMs
              : ORACLE_REFRESH_INTERVAL_MS
          if (!feed) {
            // What was last received stays, with its own time; the next try waits.
            schedule.failures++
            schedule.retryAt = now + retryDelayMs(schedule.failures)
            return
          }
          schedule.failures = 0
          schedule.retryAt = 0
          schedule.lastLatestAt = now
          const nowSeconds = Math.floor(now / 1000)
          const merged = mergeFeed(this.cache, feed, nowSeconds)
          this.$patch({
            cache: {
              ...merged,
              refreshMs,
              coverage: coverLatest(
                merged.coverage,
                nowSeconds,
                POLL_SECONDS,
                (3 * refreshMs) / 1000,
              ),
            },
            current: ratesAt(merged, nowSeconds),
          })
        })
      schedule.latestInFlight = request
      return request
    },

    /**
     * Makes the local series hold [since, now] at `step` seconds or finer, for a chart
     * that is on screen: asks the feed for exactly the stretches they lack (before the
     * first local point, or while the app was closed) and stores what comes back in the
     * same series. A stretch already held, or already asked for, is not asked for again.
     */
    async ensureHistory(since: number, step: number): Promise<void> {
      const schedule = scheduleOf(this)
      try {
        await this.restored
      } catch {
        // Carry on with what is in memory.
      }
      const until = Math.floor(Date.now() / 1000)
      await Promise.all(
        missingRanges(this.cache.coverage, since, until, step).map(range => {
          const key = `${range.since}:${range.until}:${step}`
          const underWay = schedule.rangesInFlight.get(key)
          if (underWay) return underWay
          const request = schedule
            .source({ ...range, step }, name => this.heldAt(name))
            .catch(() => undefined)
            .then(answer => {
              schedule.rangesInFlight.delete(key)
              const feed = answer && 'feed' in answer ? answer.feed : answer
              if (!feed) return
              const merged = mergeFeed(
                this.cache,
                feed,
                Math.floor(Date.now() / 1000),
              )
              this.$patch({
                cache: {
                  ...merged,
                  coverage: coverRange(
                    merged.coverage,
                    range.since,
                    range.until,
                    step,
                  ),
                },
              })
            })
          schedule.rangesInFlight.set(key, request)
          return request
        }),
      )
    },
  },

  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveOracleCache(storage, state.cache)
    },
    async restore(storage): Promise<Partial<OracleState>> {
      const cache = await restoreOracleCache(storage)
      return { cache, current: ratesAt(cache, Math.floor(Date.now() / 1000)) }
    },
  },
})

function ratesAt(cache: OracleCache, nowSeconds: number): OracleRates {
  const inputs = oracleInputs(cache)
  return inputs
    ? computeOracleRates(inputs, nowSeconds)
    : unavailableOracleRates(nowSeconds)
}

export type OracleStore = ReturnType<typeof useOracleStore>

/**
 * The oracle store, or, where no Pinia is active, a stand-in that knows no rates: every
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
  return {
    cache: emptyOracleCache(),
    current: unavailableOracleRates(),
    rates: {},
    avuHash: undefined,
    avuSpot: unavailableOracleRates().avuSpot,
    inputs: undefined,
    valuesAreTestnet: false,
    avuHashStaleAgeMs: () => undefined,
    valueStaleAgeMs: () => undefined,
    priceAgeMs: () => undefined,
    getAvu: () => 0,
    formatAvuAmount: () => '',
    formatAvuValue: () => '',
    formatUnitRate: () => '',
    acquire: () => () => undefined,
    refreshDue: async () => undefined,
    ensureHistory: async () => undefined,
  } as unknown as OracleStore
}
