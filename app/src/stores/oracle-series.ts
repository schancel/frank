/**
 * The oracle's local timeseries: every point the app has received from the oracle feed,
 * kept on the device, one series per feed series name.
 *
 * A "latest" answer adds one point to each series; a range answer adds history. They are
 * the same kind of point and live in the same series: a point received later for a time
 * already held replaces it (mergeSeries). The Parity chart draws from these series and
 * asks the feed only for the stretches they lack (missingRanges).
 *
 * Stored in the app's LevelDB (the one the Pinia storage plugin hands every store), one
 * key per point, so an append is a few small writes.
 *
 * Nothing here fetches, and nothing here invents a value.
 */
import type { LevelBatchOperation, LevelDB } from 'level'
import {
  mergeSeries,
  type FeedBasket,
  type FeedElectricity,
  type OracleFeed,
  type OracleInputs,
  type SeriesPoint,
} from '@frank/wallet/oracle'

/** One local series: the feed's metadata as last received, and every point held. */
export interface LocalSeries {
  unit: string
  source: string
  asOf: number
  stale: boolean
  estimatedBefore?: number
  points: SeriesPoint[]
}

/** A stretch of time the local series are known to hold at a resolution. Unix seconds. */
export interface Coverage {
  from: number
  until: number
  /** One point per this many seconds, or finer. */
  step: number
}

export interface OracleCache {
  /** The basket and electricity definitions of the feed last received. */
  basket?: FeedBasket
  electricity?: FeedElectricity
  series: Record<string, LocalSeries>
  coverage: Coverage[]
}

export function emptyOracleCache(): OracleCache {
  return { series: {}, coverage: [] }
}

/** What the formulas read from the cache, or undefined before any feed was received. */
export function oracleInputs(cache: OracleCache): OracleInputs | undefined {
  return cache.basket && cache.electricity
    ? {
        basket: cache.basket,
        electricity: cache.electricity,
        series: cache.series,
      }
    : undefined
}

const DAY_SECONDS = 24 * 60 * 60

/**
 * Every point is kept for this long. The finest line the chart draws further back than a
 * week has one point a day, so nothing drawn needs more than that from older data.
 */
export const FULL_RESOLUTION_SECONDS = 14 * DAY_SECONDS

/**
 * Bounds what is stored: points older than FULL_RESOLUTION_SECONDS are thinned to the
 * first one of each UTC day. What remains are points exactly as received; none is
 * averaged or moved. The floor lookup works the same on a thinned series.
 */
export function thinOldPoints(
  points: readonly SeriesPoint[],
  nowSeconds: number,
): SeriesPoint[] {
  const cutoff = nowSeconds - FULL_RESOLUTION_SECONDS
  let lastDayKept = -Infinity
  return points.filter(point => {
    if (point[0] >= cutoff) return true
    const day = Math.floor(point[0] / DAY_SECONDS)
    if (day === lastDayKept) return false
    lastDayKept = day
    return true
  })
}

/** The cache with a feed answer's points and metadata added to it. */
export function mergeFeed(
  cache: OracleCache,
  feed: OracleFeed,
  nowSeconds: number,
): OracleCache {
  const series = { ...cache.series }
  for (const [name, received] of Object.entries(feed.series)) {
    const held = series[name]
    const points = thinOldPoints(
      mergeSeries(held?.points ?? [], received.points),
      nowSeconds,
    )
    // The metadata describes the newest data: an answer about the past (a range) does
    // not overwrite what a later answer said about the present.
    const newer = !held || received.asOf >= held.asOf
    series[name] = {
      ...(newer
        ? {
            unit: received.unit,
            source: received.source,
            asOf: received.asOf,
            stale: received.stale,
          }
        : {
            unit: held.unit,
            source: held.source,
            asOf: held.asOf,
            stale: held.stale,
          }),
      ...(received.estimatedBefore !== undefined
        ? { estimatedBefore: received.estimatedBefore }
        : held?.estimatedBefore !== undefined
        ? { estimatedBefore: held.estimatedBefore }
        : {}),
      points,
    }
  }
  return {
    basket: feed.basket,
    electricity: feed.electricity,
    series,
    coverage: cache.coverage,
  }
}

function normalise(coverage: Coverage[]): Coverage[] {
  const sorted = coverage
    .slice()
    .sort((a, b) => a.step - b.step || a.from - b.from)
  const merged: Coverage[] = []
  for (const one of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.step === one.step && one.from <= last.until) {
      last.until = Math.max(last.until, one.until)
    } else {
      merged.push({ ...one })
    }
  }
  return merged
}

/**
 * Records that a latest answer was received at `at`. Consecutive polls no further apart
 * than three intervals are one covered stretch at the poll interval; a longer silence
 * (the app was closed) starts a new stretch and leaves a gap between them.
 */
export function coverLatest(
  coverage: Coverage[],
  at: number,
  pollSeconds: number,
): Coverage[] {
  const open = coverage.find(
    c =>
      c.step === pollSeconds &&
      at >= c.until &&
      at - c.until <= 3 * pollSeconds,
  )
  return normalise(
    open
      ? coverage.map(c => (c === open ? { ...c, until: at } : c))
      : [...coverage, { from: at, until: at, step: pollSeconds }],
  )
}

/** Records that a range answer for [since, until] at `step` was received and stored. */
export function coverRange(
  coverage: Coverage[],
  since: number,
  until: number,
  step: number,
): Coverage[] {
  return normalise([...coverage, { from: since, until, step }])
}

/**
 * The stretches of [since, until] the local series do not hold at `step` or finer, oldest
 * first. A stretch shorter than one step is not worth a request and is left out.
 */
export function missingRanges(
  coverage: readonly Coverage[],
  since: number,
  until: number,
  step: number,
): Array<{ since: number; until: number }> {
  const held = coverage
    .filter(c => c.step <= step && c.until > since && c.from < until)
    .sort((a, b) => a.from - b.from)
  const missing: Array<{ since: number; until: number }> = []
  let cursor = since
  for (const one of held) {
    if (one.from - cursor >= step)
      missing.push({ since: cursor, until: one.from })
    cursor = Math.max(cursor, one.until)
  }
  if (until - cursor >= step) missing.push({ since: cursor, until })
  return missing
}

// ---- Persistence ---------------------------------------------------------------------------

// v2 of the local series: feed points. The v1 records (price and mining observations,
// provider candles) are never read; a development install drops them by clearing the
// app's site data.
const PREFIX = 'oracle:v2:'
const META_KEY = `${PREFIX}meta`
const POINT_PREFIX = `${PREFIX}pt:`

/** Unix seconds as text that sorts in time order. */
function timeKey(seconds: number): string {
  return String(Math.floor(seconds)).padStart(12, '0')
}

interface StoredMeta {
  basket?: FeedBasket
  electricity?: FeedElectricity
  coverage: Coverage[]
  series: Record<string, Omit<LocalSeries, 'points'>>
}

function metaOf(cache: OracleCache): string {
  const meta: StoredMeta = {
    basket: cache.basket,
    electricity: cache.electricity,
    coverage: cache.coverage,
    series: Object.fromEntries(
      Object.entries(cache.series).map(([name, one]) => {
        const { points: _points, ...rest } = one
        return [name, rest]
      }),
    ),
  }
  return JSON.stringify(meta)
}

/** What each database is known to hold, so a save writes only what changed. */
const written = new WeakMap<LevelDB, Map<string, string>>()

/** Writes the records the database lacks and deletes the ones the cache dropped. */
export async function saveOracleCache(
  storage: LevelDB,
  cache: OracleCache,
): Promise<void> {
  const onDisk = written.get(storage) ?? new Map<string, string>()
  written.set(storage, onDisk)
  const wanted = new Map<string, string>()
  wanted.set(META_KEY, metaOf(cache))
  for (const [name, one] of Object.entries(cache.series)) {
    for (const point of one.points) {
      wanted.set(
        `${POINT_PREFIX}${name}:${timeKey(point[0])}`,
        String(point[1]),
      )
    }
  }
  const operations: LevelBatchOperation[] = []
  wanted.forEach((value, key) => {
    if (onDisk.get(key) !== value) operations.push({ type: 'put', key, value })
  })
  onDisk.forEach((_value, key) => {
    if (!wanted.has(key)) operations.push({ type: 'del', key })
  })
  if (operations.length === 0) return
  // Marked before the write so a second save in the same tick does not repeat it.
  for (const operation of operations) {
    if (operation.type === 'put') onDisk.set(operation.key, operation.value)
    else onDisk.delete(operation.key)
  }
  try {
    await storage.batch(operations)
  } catch (error) {
    // Unknown what landed: forget these keys so the next save writes them again.
    for (const operation of operations) onDisk.delete(operation.key)
    throw error
  }
}

/**
 * Reads the cache back. A record that is not a point of a series the metadata names is
 * left out (and deleted by the next save); it is never repaired or filled in.
 */
export async function restoreOracleCache(
  storage: LevelDB,
): Promise<OracleCache> {
  const cache = emptyOracleCache()
  const onDisk = new Map<string, string>()
  let meta: StoredMeta | null = null
  const points = new Map<string, SeriesPoint[]>()
  // ';' is the character after ':', so this range is every key under the prefix, in order.
  const range = { gte: PREFIX, lt: `${PREFIX.slice(0, -1)};` }
  for await (const [key, text] of storage.iterator(range)) {
    onDisk.set(key, text)
    if (key === META_KEY) {
      try {
        meta = JSON.parse(text) as StoredMeta
      } catch {
        meta = null
      }
    } else if (key.startsWith(POINT_PREFIX)) {
      const rest = key.slice(POINT_PREFIX.length)
      const split = rest.lastIndexOf(':')
      const time = Number(rest.slice(split + 1))
      const value = Number(text)
      if (split > 0 && Number.isFinite(time) && Number.isFinite(value)) {
        const name = rest.slice(0, split)
        const list = points.get(name) ?? []
        list.push([time, value])
        points.set(name, list)
      }
    }
  }
  written.set(storage, onDisk)
  if (!meta || typeof meta !== 'object' || typeof meta.series !== 'object') {
    return cache
  }
  cache.basket = meta.basket
  cache.electricity = meta.electricity
  cache.coverage = Array.isArray(meta.coverage) ? meta.coverage : []
  for (const [name, described] of Object.entries(meta.series ?? {})) {
    const held = points.get(name)
    if (held) cache.series[name] = { ...described, points: held }
  }
  return cache
}
