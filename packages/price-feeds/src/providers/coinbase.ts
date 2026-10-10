import type { PriceFeedProvider, PriceSample } from '../types'
import { ORACLE_ENDPOINTS } from '../config'

export const COINBASE_PAIRS: Record<string, string> = {
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  BTC: 'BTC-USD',
  BCH: 'BCH-USD',
  DOGE: 'DOGE-USD',
  LTC: 'LTC-USD',
  HYPE: 'HYPE-USD',
  MON: 'MON-USD',
}

export const COINBASE_API_BASE = ORACLE_ENDPOINTS.coinbase.spotPrice

export class CoinbaseProvider implements PriceFeedProvider {
  readonly id = 'coinbase' as const
  private baseUrl: string
  private fetchFn: typeof fetch

  constructor(options: { baseUrl?: string; fetchFn?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl || COINBASE_API_BASE
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(COINBASE_PAIRS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const pair = COINBASE_PAIRS[asset.toUpperCase()]
    if (!pair) return null

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}/${pair}/spot`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return null

      const data = await response.json()
      const amountStr = data?.data?.amount
      const price = parseFloat(amountStr)

      if (isNaN(price) || price <= 0) return null

      return {
        provider: 'coinbase',
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
