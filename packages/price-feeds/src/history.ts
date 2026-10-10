/**
 * Price history from the exchanges' own public candle endpoints.
 *
 * Every point returned is a price the provider published for that time. Nothing is
 * interpolated, smoothed or filled in: when no provider has history for an asset the
 * result is empty, and a short history stays short.
 */
import { ORACLE_ENDPOINTS } from './config'
import { BINANCE_SYMBOLS, BINANCE_US_UNTRADED } from './providers/binance'
import { COINBASE_PAIRS } from './providers/coinbase'
import { COINGECKO_IDS } from './providers/coingecko'
import { KRAKEN_PAIRS } from './providers/kraken'
import type { PriceProviderId } from './types'

export type HistoryRange = '24h' | '7d' | '30d' | '1y'

export interface PriceHistoryPoint {
  /** Unix time in milliseconds of the observation. */
  timestamp: number
  /** Price in US dollars. */
  price: number
}

export interface PriceHistory {
  asset: string
  range: HistoryRange
  /** The one provider every point came from, or null when none had history. */
  provider: PriceProviderId | null
  /** Oldest first. */
  points: PriceHistoryPoint[]
}

const DAY_SECONDS = 86_400

/** How far back each range reaches and how far apart its candles are, in seconds. */
export const HISTORY_RANGES: Record<
  HistoryRange,
  { spanSeconds: number; stepSeconds: number }
> = {
  '24h': { spanSeconds: DAY_SECONDS, stepSeconds: 3_600 },
  '7d': { spanSeconds: 7 * DAY_SECONDS, stepSeconds: 4 * 3_600 },
  '30d': { spanSeconds: 30 * DAY_SECONDS, stepSeconds: DAY_SECONDS },
  '1y': { spanSeconds: 365 * DAY_SECONDS, stepSeconds: 7 * DAY_SECONDS },
}

export const COINBASE_CANDLES_URL = ORACLE_ENDPOINTS.coinbase.candles
export const KRAKEN_OHLC_URL = ORACLE_ENDPOINTS.kraken.ohlc
export const BINANCE_US_KLINES_URL = ORACLE_ENDPOINTS.binance.klinesUs
export const COINGECKO_COINS_URL = ORACLE_ENDPOINTS.coingecko.coins

type HistoryFetcher = (
  asset: string,
  range: HistoryRange,
  fetchFn: typeof fetch,
  nowMs: number,
  signal?: AbortSignal,
) => Promise<PriceHistoryPoint[]>

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchFn(url, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return null
  return response.json()
}

function cleaned(points: PriceHistoryPoint[]): PriceHistoryPoint[] {
  return points
    .filter(
      p =>
        Number.isFinite(p.timestamp) && Number.isFinite(p.price) && p.price > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
}

/** Coinbase Exchange candles: [time s, low, high, open, close, volume], newest first, 300 at most. */
const coinbaseHistory: HistoryFetcher = async (
  asset,
  range,
  fetchFn,
  nowMs,
  signal,
) => {
  const pair = COINBASE_PAIRS[asset]
  // Coinbase has no weekly candle and returns at most 300 daily ones, short of a year.
  const granularity = { '24h': 3_600, '7d': 21_600, '30d': 86_400, '1y': 0 }[
    range
  ]
  if (!pair || !granularity) return []
  const end = new Date(nowMs).toISOString()
  const start = new Date(
    nowMs - HISTORY_RANGES[range].spanSeconds * 1000,
  ).toISOString()
  const data = await getJson(
    fetchFn,
    `${COINBASE_CANDLES_URL}/${pair}/candles?granularity=${granularity}&start=${start}&end=${end}`,
    signal,
  )
  if (!Array.isArray(data)) return []
  return data.map((c: number[]) => ({
    timestamp: Number(c?.[0]) * 1000,
    price: Number(c?.[4]),
  }))
}

/** Kraken OHLC: result[pair] = [[time s, open, high, low, close, vwap, volume, count], ...]. */
const krakenHistory: HistoryFetcher = async (
  asset,
  range,
  fetchFn,
  nowMs,
  signal,
) => {
  const pair = KRAKEN_PAIRS[asset]
  if (!pair) return []
  const interval = { '24h': 60, '7d': 240, '30d': 1_440, '1y': 10_080 }[range]
  const since = Math.floor(nowMs / 1000) - HISTORY_RANGES[range].spanSeconds
  const data = (await getJson(
    fetchFn,
    `${KRAKEN_OHLC_URL}?pair=${pair}&interval=${interval}&since=${since}`,
    signal,
  )) as { error?: unknown[]; result?: Record<string, unknown> } | null
  if (!data?.result || (Array.isArray(data.error) && data.error.length > 0)) {
    return []
  }
  const rows = Object.entries(data.result).find(([key]) => key !== 'last')?.[1]
  if (!Array.isArray(rows)) return []
  return rows.map((c: Array<number | string>) => ({
    timestamp: Number(c?.[0]) * 1000,
    price: Number(c?.[4]),
  }))
}

/** Binance.US klines: [[open time ms, open, high, low, close, ...], ...], oldest first. */
const binanceHistory: HistoryFetcher = async (
  asset,
  range,
  fetchFn,
  _nowMs,
  signal,
) => {
  const symbol = BINANCE_SYMBOLS[asset]
  if (!symbol || BINANCE_US_UNTRADED.has(symbol)) return []
  const [interval, limit] = (
    {
      '24h': ['1h', 24],
      '7d': ['4h', 42],
      '30d': ['1d', 30],
      '1y': ['1w', 52],
    } as const
  )[range]
  const data = await getJson(
    fetchFn,
    `${BINANCE_US_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    signal,
  )
  if (!Array.isArray(data)) return []
  return data.map((c: Array<number | string>) => ({
    timestamp: Number(c?.[0]),
    price: Number(c?.[4]),
  }))
}

/**
 * CoinGecko market chart: { prices: [[time ms, price], ...] }, finer than the range's
 * step. Only observations are kept (the last one in each step), never an average.
 */
const coingeckoHistory: HistoryFetcher = async (
  asset,
  range,
  fetchFn,
  _nowMs,
  signal,
) => {
  const id = COINGECKO_IDS[asset]
  if (!id) return []
  const days = { '24h': 1, '7d': 7, '30d': 30, '1y': 365 }[range]
  const data = (await getJson(
    fetchFn,
    `${COINGECKO_COINS_URL}/${id}/market_chart?vs_currency=usd&days=${days}`,
    signal,
  )) as { prices?: unknown } | null
  if (!Array.isArray(data?.prices)) return []
  const stepMs = HISTORY_RANGES[range].stepSeconds * 1000
  const lastInStep = new Map<number, PriceHistoryPoint>()
  for (const row of data.prices as number[][]) {
    const timestamp = Number(row?.[0])
    lastInStep.set(Math.floor(timestamp / stepMs), {
      timestamp,
      price: Number(row?.[1]),
    })
  }
  return Array.from(lastInStep.values())
}

const HISTORY_PROVIDERS: Array<[PriceProviderId, HistoryFetcher]> = [
  ['coinbase', coinbaseHistory],
  ['kraken', krakenHistory],
  ['binance', binanceHistory],
  ['coingecko', coingeckoHistory],
]

/**
 * Asks the providers in turn and returns the first one's history for the asset.
 * Points from different providers are never mixed into one line.
 */
export async function fetchPriceHistory(
  asset: string,
  range: HistoryRange,
  options: { fetchFn?: typeof fetch; timeoutMs?: number; now?: number } = {},
): Promise<PriceHistory> {
  const symbol = asset.toUpperCase()
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const nowMs = options.now ?? Date.now()
  const oldest = nowMs - HISTORY_RANGES[range].spanSeconds * 1000

  for (const [provider, fetcher] of HISTORY_PROVIDERS) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 8000,
    )
    try {
      const points = cleaned(
        await fetcher(symbol, range, fetchFn, nowMs, controller.signal),
      ).filter(p => p.timestamp >= oldest && p.timestamp <= nowMs)
      if (points.length > 0) {
        return { asset: symbol, range, provider, points }
      }
    } catch {
      // This provider failed; ask the next one.
    } finally {
      clearTimeout(timer)
    }
  }
  return { asset: symbol, range, provider: null, points: [] }
}
