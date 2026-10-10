import type { PriceFeedProvider, PriceSample } from '../types'

export const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  SOL: 'solana',
  XEC: 'ecash',
  BTC: 'bitcoin',
  BCH: 'bitcoin-cash',
  DOGE: 'dogecoin',
  HYPE: 'hyperliquid',
  MON: 'monad',
}

export const COINGECKO_API_BASE =
  'https://api.coingecko.com/api/v3/simple/price'

export class CoinGeckoProvider implements PriceFeedProvider {
  readonly id = 'coingecko' as const
  private baseUrl: string
  private fetchFn: typeof fetch

  constructor(options: { baseUrl?: string; fetchFn?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl || COINGECKO_API_BASE
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(COINGECKO_IDS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const id = COINGECKO_IDS[asset.toUpperCase()]
    if (!id) return null

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}?ids=${id}&vs_currencies=usd`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return null

      const data = await response.json()
      const price = data?.[id]?.usd

      if (typeof price !== 'number' || price <= 0) return null

      return {
        provider: 'coingecko',
        asset: asset.toUpperCase(),
        price,
        timestamp: Date.now(),
        latencyMs: Date.now() - startTime,
      }
    } catch {
      return null
    }
  }

  async fetchPrices(
    assets: string[],
    signal?: AbortSignal,
  ): Promise<PriceSample[]> {
    const idToAsset = new Map<string, string>()
    const ids: string[] = []

    for (const asset of assets) {
      const id = COINGECKO_IDS[asset.toUpperCase()]
      if (id) {
        idToAsset.set(id, asset.toUpperCase())
        ids.push(id)
      }
    }

    if (ids.length === 0) return []

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}?ids=${ids.join(',')}&vs_currencies=usd`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return []

      const data = await response.json()
      const samples: PriceSample[] = []
      const now = Date.now()
      const latency = now - startTime

      for (const [id, asset] of idToAsset.entries()) {
        const price = data?.[id]?.usd
        if (typeof price === 'number' && price > 0) {
          samples.push({
            provider: 'coingecko',
            asset,
            price,
            timestamp: now,
            latencyMs: latency,
          })
        }
      }

      return samples
    } catch {
      return []
    }
  }
}
