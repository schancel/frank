import type { PriceFeedProvider, PriceSample } from '../types'

export const BINANCE_SYMBOLS: Record<string, string> = {
  XEC: 'XECUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BTC: 'BTCUSDT',
}

export const BINANCE_API_BASE = 'https://api.binance.com/api/v3/ticker/price'
export const BINANCE_US_API_BASE = 'https://api.binance.us/api/v3/ticker/price'

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
