import type { PriceFeedProvider, PriceSample } from '../types'

export const KRAKEN_PAIRS: Record<string, string> = {
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
  BTC: 'XBTUSD',
}

export const KRAKEN_API_BASE = 'https://api.kraken.com/0/public/Ticker'

export class KrakenProvider implements PriceFeedProvider {
  readonly id = 'kraken' as const
  private baseUrl: string
  private fetchFn: typeof fetch

  constructor(options: { baseUrl?: string; fetchFn?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl || KRAKEN_API_BASE
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(KRAKEN_PAIRS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const pair = KRAKEN_PAIRS[asset.toUpperCase()]
    if (!pair) return null

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}?pair=${pair}`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return null

      const data = await response.json()
      if (Array.isArray(data?.error) && data.error.length > 0) return null

      const result = data?.result
      if (!result || typeof result !== 'object') return null

      // Find the pair entry (Kraken may key by XETHZUSD or ETHUSD)
      const firstKey = Object.keys(result)[0]
      if (!firstKey) return null

      const ticker = result[firstKey]
      const lastCloseStr = ticker?.c?.[0]
      const price = parseFloat(lastCloseStr)

      if (isNaN(price) || price <= 0) return null

      return {
        provider: 'kraken',
        asset: asset.toUpperCase(),
        price,
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime,
      }
    } catch {
      return null
    }
  }
}
