/**
 * The oracle feed: one normalised answer carrying every input of AVU_hash, AVU_spot and
 * the AVU value of a coin. The contract is docs/protocol/oracle/README.md; this file is
 * its TypeScript side: the types, the parser applied to whatever a relay answers, and the
 * one function that asks a relay for it.
 *
 * Display and valuation only. Nothing that moves money (a swap quote, a payment amount)
 * may be priced from this feed.
 */
import type { SeriesPoint } from './timeseries'

export type HashAlgorithm = 'sha256' | 'scrypt' | 'randomx'

export interface FeedSeries {
  /** What a value is, for a reader of the JSON. */
  unit: string
  /** Short label for display: where the values come from. */
  source: string
  /** Unix seconds the latest point was observed or published. */
  asOf: number
  /** The relay could not refresh the series within its normal interval. */
  stale: boolean
  points: SeriesPoint[]
}

export interface FeedBasketChain {
  /** Canonical chain identifier; also the asset id its coin is priced under. */
  chain: string
  /** Expected hashes per block for each unit of difficulty. */
  hashesPerDifficulty: number
}

/** One body of hashing and every chain it is paid by; merge-mined chains are one entry. */
export interface FeedBasketEntry {
  id: string
  label: string
  algorithm: HashAlgorithm
  chains: FeedBasketChain[]
}

export interface FeedBasket {
  weightCap: { entry: string; max: number }
  entries: FeedBasketEntry[]
}

export interface FeedElectricity {
  /** AVU_spot is taken over the mean daily price of this many days. */
  windowDays: number
  regions: Array<{ id: string; label: string }>
  /** The regions the headline AVU_spot is the mean of. */
  headline: string[]
}

export interface OracleFeed {
  version: 1
  generatedAt: number
  basket: FeedBasket
  electricity: FeedElectricity
  series: Record<string, FeedSeries>
}

export type SeriesKind =
  | 'price'
  | 'marketCap'
  | 'difficulty'
  | 'blockReward'
  | 'efficiency'
  | 'electricity'

export function seriesName(kind: SeriesKind, id: string): string {
  return `${kind}/${id}`
}

const SERIES_NAME =
  /^(price|marketCap|difficulty|blockReward|efficiency|electricity)\/[a-z0-9-]+$/
const ALGORITHMS: readonly string[] = ['sha256', 'scrypt', 'randomx']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseSeries(value: unknown): FeedSeries | undefined {
  if (
    !isRecord(value) ||
    typeof value.unit !== 'string' ||
    typeof value.source !== 'string' ||
    !isTime(value.asOf) ||
    typeof value.stale !== 'boolean' ||
    !Array.isArray(value.points)
  ) {
    return undefined
  }
  const points: SeriesPoint[] = []
  let previous = -1
  for (const point of value.points) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isTime(point[0]) ||
      typeof point[1] !== 'number' ||
      !Number.isFinite(point[1]) ||
      point[0] <= previous
    ) {
      return undefined
    }
    previous = point[0]
    points.push([point[0], point[1]])
  }
  return {
    unit: value.unit,
    source: value.source,
    asOf: value.asOf,
    stale: value.stale,
    points,
  }
}

/**
 * Checks an answer against the contract. Undefined when it is not a version 1 feed. A
 * series that is malformed makes the whole answer invalid: a feed is taken whole or not
 * at all, never repaired.
 */
export function parseOracleFeed(value: unknown): OracleFeed | undefined {
  if (!isRecord(value) || value.version !== 1 || !isTime(value.generatedAt)) {
    return undefined
  }
  const { basket, electricity, series } = value
  if (!isRecord(basket) || !isRecord(electricity) || !isRecord(series)) {
    return undefined
  }
  const cap = basket.weightCap
  if (
    !isRecord(cap) ||
    typeof cap.entry !== 'string' ||
    typeof cap.max !== 'number' ||
    !(cap.max > 0 && cap.max <= 1) ||
    !Array.isArray(basket.entries)
  ) {
    return undefined
  }
  const entries: FeedBasketEntry[] = []
  for (const entry of basket.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.label !== 'string' ||
      typeof entry.algorithm !== 'string' ||
      !ALGORITHMS.includes(entry.algorithm) ||
      !Array.isArray(entry.chains) ||
      entry.chains.length === 0
    ) {
      return undefined
    }
    const chains: FeedBasketChain[] = []
    for (const chain of entry.chains) {
      if (
        !isRecord(chain) ||
        typeof chain.chain !== 'string' ||
        typeof chain.hashesPerDifficulty !== 'number' ||
        !(chain.hashesPerDifficulty > 0)
      ) {
        return undefined
      }
      chains.push({
        chain: chain.chain,
        hashesPerDifficulty: chain.hashesPerDifficulty,
      })
    }
    entries.push({
      id: entry.id,
      label: entry.label,
      algorithm: entry.algorithm as HashAlgorithm,
      chains,
    })
  }
  if (
    !Number.isInteger(electricity.windowDays) ||
    !((electricity.windowDays as number) >= 1) ||
    !Array.isArray(electricity.regions) ||
    !Array.isArray(electricity.headline) ||
    !electricity.headline.every(id => typeof id === 'string') ||
    !electricity.regions.every(
      region =>
        isRecord(region) &&
        typeof region.id === 'string' &&
        typeof region.label === 'string',
    )
  ) {
    return undefined
  }
  const parsed: Record<string, FeedSeries> = {}
  for (const [name, raw] of Object.entries(series)) {
    const one = SERIES_NAME.test(name) ? parseSeries(raw) : undefined
    if (!one) return undefined
    parsed[name] = one
  }
  return {
    version: 1,
    generatedAt: value.generatedAt,
    basket: { weightCap: { entry: cap.entry, max: cap.max }, entries },
    electricity: {
      windowDays: electricity.windowDays as number,
      regions: (
        electricity.regions as Array<{ id: string; label: string }>
      ).map(region => ({ id: region.id, label: region.label })),
      headline: electricity.headline as string[],
    },
    series: parsed,
  }
}

/**
 * The two shapes of request. 'latest' is what the app polls: one point per series (and
 * the electricity window), a few kilobytes. A range is asked for only by a chart.
 */
export type FeedRequest =
  | { latest: true }
  | { since: number; until: number; step: number }

export const ORACLE_FEED_PATH = '/oracle/v1/feed'

export function feedUrl(relayBaseUrl: string, request: FeedRequest): string {
  const base = `${relayBaseUrl.replace(/\/+$/, '')}${ORACLE_FEED_PATH}`
  return 'latest' in request
    ? `${base}?latest`
    : `${base}?since=${request.since}&until=${request.until}&step=${request.step}`
}

export type FeedAnswer =
  | { status: 'ok'; feed: OracleFeed }
  /** The relay answered 404: it does not serve the feed. */
  | { status: 'not-served' }
  /** Anything else: no answer, an error status, or an answer that is not a feed. */
  | { status: 'failed' }

/** One request to the relay for the feed. The relay is trusted: its answer is not cross-checked. */
export async function fetchOracleFeed(
  relayBaseUrl: string,
  request: FeedRequest,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<FeedAnswer> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try {
    const response = await fetchFn(feedUrl(relayBaseUrl, request), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (response.status === 404) return { status: 'not-served' }
    if (!response.ok) return { status: 'failed' }
    const feed = parseOracleFeed(await response.json())
    return feed ? { status: 'ok', feed } : { status: 'failed' }
  } catch {
    return { status: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}
