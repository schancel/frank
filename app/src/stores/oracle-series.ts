/**
 * The oracle's local time series: what the app has fetched, kept on the device.
 *
 * Every successful fetch is one more timestamped record:
 *   - a price observation: for each coin, every provider's answer and their median;
 *   - a mining observation per chain: difficulty, issuance and supply;
 *   - a provider's candles for a coin and chart range, replaced whole when refetched.
 *
 * They are stored in the app's LevelDB (the one the Pinia storage plugin hands every
 * store), one key per observation. An append is then one small write and trimming is a
 * few deletes; localStorage would mean rewriting the whole history as one string on every
 * fetch, inside a quota of a few megabytes shared with everything else.
 *
 * Nothing here fetches, and nothing here invents a value: these functions only select
 * among records that were fetched.
 */
import type { LevelBatchOperation, LevelDB } from 'level'
import {
  ASSET_FEED_SYMBOLS,
  AVU_HASH_CHAINS,
  rateOracleSnapshot,
  unavailableOracleSnapshot,
  type FetchedPrice,
  type MiningStats,
  type OracleSnapshot,
  type PriceHistoryPoint,
  type PriceProviderId,
  type SupportedAsset,
} from '@frank/wallet/oracle'

/** The prices one fetch returned, and when. */
export interface PriceObservation {
  timestamp: number
  prices: Partial<Record<SupportedAsset, FetchedPrice>>
}

/** One provider's candles for a coin and chart range, as last fetched. */
export interface ProviderCandles {
  provider: PriceProviderId
  points: PriceHistoryPoint[]
  fetchedAt: number
}

export interface OracleSeries {
  /** Oldest first, no two with the same timestamp. */
  priceObservations: PriceObservation[]
  /** By Blockchair chain name; each oldest first. */
  miningObservations: Record<string, MiningStats[]>
  /** By `${asset}:${range}`. */
  candles: Record<string, ProviderCandles>
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Every observation is kept for this long. The finest line the chart draws further back
 * than a week has one point a day, so nothing drawn needs more than that from older data.
 */
export const FULL_RESOLUTION_MS = 14 * DAY_MS

/**
 * Bounds what is stored: observations older than FULL_RESOLUTION_MS are thinned to the
 * first one recorded in each UTC day. What remains are observations exactly as fetched;
 * none is averaged or moved. Nothing depends on the bound being reached: at ten-minute
 * fetches it is about 2,000 recent records per series plus one a day of history.
 */
export function thinOldObservations<T>(
  observations: readonly T[],
  timestampOf: (observation: T) => number,
  now: number,
): T[] {
  const cutoff = now - FULL_RESOLUTION_MS
  let lastDayKept = -Infinity
  return observations.filter(observation => {
    const timestamp = timestampOf(observation)
    if (timestamp >= cutoff) return true
    const day = Math.floor(timestamp / DAY_MS)
    if (day === lastDayKept) return false
    lastDayKept = day
    return true
  })
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The current prices and chain statistics, read from the series: for each coin the newest
 * observation that has it, with that observation's own time; for each chain its newest
 * statistics. AVU_hash and every AVU rate are computed from those. This is the only way
 * a snapshot is made, so computing AVU never asks the network for anything.
 */
export function snapshotFromSeries(
  series: Pick<OracleSeries, 'priceObservations' | 'miningObservations'>,
): OracleSnapshot {
  const snapshot = unavailableOracleSnapshot()
  const observations = series.priceObservations
  const missing = new Set(Object.keys(ASSET_FEED_SYMBOLS) as SupportedAsset[])
  for (let i = observations.length - 1; i >= 0 && missing.size > 0; i--) {
    for (const asset of Array.from(missing)) {
      const price = observations[i].prices[asset]
      if (!price) continue
      snapshot.prices[asset] = price.usd
      snapshot.fetchedAt[asset] = observations[i].timestamp
      snapshot.priceSources[asset] = price.sources
      missing.delete(asset)
    }
  }
  for (const chain of AVU_HASH_CHAINS) {
    const recorded = series.miningObservations[chain]
    const latest = recorded?.[recorded.length - 1]
    if (latest) snapshot.mining[chain] = latest
  }
  if (observations.length > 0) {
    snapshot.timestamp = observations[observations.length - 1].timestamp
  }
  return rateOracleSnapshot(snapshot)
}

/**
 * One line from two sets of real points: the last recorded point in each step of the
 * range, and, in a step with none, the provider's last candle in that step. A step with
 * neither has no point. Sorted, one point per step, so no timestamp appears twice.
 */
export function joinPriceSeries(
  recorded: readonly PriceHistoryPoint[],
  candles: readonly PriceHistoryPoint[],
  stepMs: number,
): { points: PriceHistoryPoint[]; recorded: number } {
  const lastInStep = (points: readonly PriceHistoryPoint[]) => {
    const steps = new Map<number, PriceHistoryPoint>()
    for (const point of points) {
      const step = Math.floor(point.timestamp / stepMs)
      const held = steps.get(step)
      if (!held || point.timestamp >= held.timestamp) steps.set(step, point)
    }
    return steps
  }
  const own = lastInStep(recorded)
  const joined = new Map(lastInStep(candles))
  own.forEach((point, step) => joined.set(step, point))
  return {
    points: Array.from(joined.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    ),
    recorded: own.size,
  }
}

// ---- Persistence ---------------------------------------------------------------------------

// v1 of the series. The localStorage records the oracle kept before (frank_oracle_*) are
// never read.
const PREFIX = 'oracle:v1:'
const PRICE_PREFIX = `${PREFIX}price:`
const MINING_PREFIX = `${PREFIX}mining:`
const CANDLES_PREFIX = `${PREFIX}candles:`

/** Unix milliseconds as text that sorts in time order. */
function timeKey(timestamp: number): string {
  return String(Math.floor(timestamp)).padStart(15, '0')
}

/** Every record the series should have on disk: key, a stamp that changes with its value, and the value. */
function records(
  series: OracleSeries,
): Map<string, { stamp: number; value: () => string }> {
  const wanted = new Map<string, { stamp: number; value: () => string }>()
  for (const observation of series.priceObservations) {
    wanted.set(`${PRICE_PREFIX}${timeKey(observation.timestamp)}`, {
      stamp: observation.timestamp,
      value: () => JSON.stringify(observation),
    })
  }
  for (const [chain, observations] of Object.entries(
    series.miningObservations,
  )) {
    for (const stats of observations) {
      wanted.set(`${MINING_PREFIX}${chain}:${timeKey(stats.fetchedAt)}`, {
        stamp: stats.fetchedAt,
        value: () => JSON.stringify(stats),
      })
    }
  }
  for (const [key, candles] of Object.entries(series.candles)) {
    wanted.set(`${CANDLES_PREFIX}${key}`, {
      stamp: candles.fetchedAt,
      value: () => JSON.stringify(candles),
    })
  }
  return wanted
}

/** What each database is known to hold, so a save writes only what changed. */
const written = new WeakMap<LevelDB, Map<string, number>>()

/** Writes the records the database lacks and deletes the ones the series dropped. */
export async function saveOracleSeries(
  storage: LevelDB,
  series: OracleSeries,
): Promise<void> {
  const onDisk = written.get(storage) ?? new Map<string, number>()
  written.set(storage, onDisk)
  const wanted = records(series)
  const operations: LevelBatchOperation[] = []
  wanted.forEach((record, key) => {
    if (onDisk.get(key) !== record.stamp) {
      operations.push({ type: 'put', key, value: record.value() })
    }
  })
  onDisk.forEach((_stamp, key) => {
    if (!wanted.has(key)) operations.push({ type: 'del', key })
  })
  if (operations.length === 0) return
  // Marked before the write so a second save in the same tick does not repeat it.
  for (const operation of operations) {
    if (operation.type === 'put') {
      onDisk.set(operation.key, wanted.get(operation.key)!.stamp)
    } else {
      onDisk.delete(operation.key)
    }
  }
  try {
    await storage.batch(operations)
  } catch (error) {
    // Unknown what landed: forget these keys so the next save writes them again.
    for (const operation of operations) onDisk.delete(operation.key)
    throw error
  }
}

function isPriceObservation(value: unknown): value is PriceObservation {
  const observation = value as PriceObservation | null
  return (
    isPositive(observation?.timestamp) &&
    typeof observation?.prices === 'object' &&
    observation.prices !== null &&
    Object.values(observation.prices).every(
      price =>
        isPositive(price?.usd) &&
        isPositive(price?.sources) &&
        typeof price?.providers === 'object',
    )
  )
}

function isMiningStats(value: unknown): value is MiningStats {
  const stats = value as MiningStats | null
  return (
    typeof stats?.chain === 'string' &&
    isPositive(stats.subsidyCoinsPerBlock) &&
    isPositive(stats.difficulty) &&
    isPositive(stats.hashesPerBlock) &&
    isPositive(stats.circulatingCoins) &&
    isPositive(stats.fetchedAt)
  )
}

function isProviderCandles(value: unknown): value is ProviderCandles {
  const candles = value as ProviderCandles | null
  return (
    typeof candles?.provider === 'string' &&
    isPositive(candles.fetchedAt) &&
    Array.isArray(candles.points) &&
    candles.points.every(p => isPositive(p?.timestamp) && isPositive(p?.price))
  )
}

/**
 * Reads the series back. A record that is not a complete fetched observation is left out
 * (and deleted by the next save); it is never repaired or filled in.
 */
export async function restoreOracleSeries(
  storage: LevelDB,
): Promise<OracleSeries> {
  const series: OracleSeries = {
    priceObservations: [],
    miningObservations: {},
    candles: {},
  }
  const onDisk = new Map<string, number>()
  // ';' is the character after ':', so this range is every key under the prefix, in order.
  const range = { gte: PREFIX, lt: `${PREFIX.slice(0, -1)};` }
  for await (const [key, text] of storage.iterator(range)) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    // Known to be on disk whatever it holds; a stamp of 0 never matches a real record.
    onDisk.set(key, 0)
    if (key.startsWith(PRICE_PREFIX) && isPriceObservation(value)) {
      series.priceObservations.push(value)
      onDisk.set(key, value.timestamp)
    } else if (key.startsWith(MINING_PREFIX) && isMiningStats(value)) {
      const chain = (series.miningObservations[value.chain] ??= [])
      chain.push(value)
      onDisk.set(key, value.fetchedAt)
    } else if (key.startsWith(CANDLES_PREFIX) && isProviderCandles(value)) {
      series.candles[key.slice(CANDLES_PREFIX.length)] = value
      onDisk.set(key, value.fetchedAt)
    }
  }
  written.set(storage, onDisk)
  return series
}
