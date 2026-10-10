import type { PriceFeedProvider, PriceSample } from '../types'
import { ORACLE_ENDPOINTS } from '../config'

export const BINANCE_SYMBOLS: Record<string, string> = {
  XEC: 'XECUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BTC: 'BTCUSDT',
  BCH: 'BCHUSDT',
  DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT',
  HYPE: 'HYPEUSDT',
}

/**
 * Symbols binance.us must not be asked for: its XECUSDT market has no trades (zero
 * volume, the same price hour after hour), so its "price" is not a market price.
 */
export const BINANCE_US_UNTRADED = new Set(['XECUSDT'])

export const BINANCE_API_BASE = ORACLE_ENDPOINTS.binance.ticker
export const BINANCE_US_API_BASE = ORACLE_ENDPOINTS.binance.tickerUs

export class BinanceProvider implements PriceFeedProvider {
  readonly id = 'binance' as const
  private baseUrl: string
  private fallbackUrl: string
  private fetchFn: typeof fetch

  constructor(
    options: {
      baseUrl?: string
      fallbackUrl?: string
      fetchFn?: typeof fetch
    } = {},
  ) {
    this.baseUrl = options.baseUrl || BINANCE_API_BASE
    this.fallbackUrl = options.fallbackUrl || BINANCE_US_API_BASE
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(BINANCE_SYMBOLS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const symbol = BINANCE_SYMBOLS[asset.toUpperCase()]
    if (!symbol) return null

    const startTime = Date.now()
    // Try main endpoint first, then fallback
    for (const endpoint of [this.baseUrl, this.fallbackUrl]) {
      if (endpoint === BINANCE_US_API_BASE && BINANCE_US_UNTRADED.has(symbol)) {
        continue
      }
      try {
        const url = `${endpoint}?symbol=${symbol}`
        const response = await this.fetchFn(url, {
          signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) continue

        const data = await response.json()
        const price = parseFloat(data?.price)

        if (!isNaN(price) && price > 0) {
          return {
            provider: 'binance',
            asset: asset.toUpperCase(),
            price,
            timestamp: Date.now(),
            latencyMs: Date.now() - startTime,
          }
        }
      } catch {
        // try next endpoint
      }
    }

    return null
  }
}
