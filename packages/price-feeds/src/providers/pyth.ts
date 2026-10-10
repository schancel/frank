import type { PriceFeedProvider, PriceSample } from '../types'
import { ORACLE_ENDPOINTS } from '../config'

/**
 * Feed ids as listed by Hermes' public /v2/price_feeds directory. Hermes answers price
 * requests with 401 when no API key is sent, so without a key this provider returns
 * nothing and the other providers carry the price.
 */
export const PYTH_FEED_IDS: Record<string, string> = {
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: '0xe62df6e22e666f357632ddc6b45d24e71cc292e27dc64376c8409dd173237e2a',
  BCH: '0x3dd2b63686a450ec7290df3a1e0b583c0481f651351edfa7636f39aed55cf8a3',
  DOGE: '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
  HYPE: '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
  MON: '0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1',
  XEC: '0x44622616f246ce5fc46cf9ebdb879b0c0157275510744cea824ad206e48390b3',
  GOLD: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  XAU: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  BRENT: '0xf33ce961935076ef4dc98be75cf2126046eac1bffdcd7a0fa05ccf18b746fda6',
}

export const PYTH_HERMES_URL = ORACLE_ENDPOINTS.pyth.latestPrice

export class PythProvider implements PriceFeedProvider {
  readonly id = 'pyth' as const
  private baseUrl: string
  private fetchFn: typeof fetch

  constructor(options: { baseUrl?: string; fetchFn?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl || PYTH_HERMES_URL
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
  }

  supportsAsset(asset: string): boolean {
    return Boolean(PYTH_FEED_IDS[asset.toUpperCase()])
  }

  async fetchPrice(
    asset: string,
    signal?: AbortSignal,
  ): Promise<PriceSample | null> {
    const feedId = PYTH_FEED_IDS[asset.toUpperCase()]
    if (!feedId) return null

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}?ids[]=${feedId}`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return null

      const data = await response.json()
      const parsed = data?.parsed
      if (!Array.isArray(parsed) || parsed.length === 0) return null

      const priceData = parsed[0]?.price
      const rawPrice = Number(priceData?.price)
      const expo = Number(priceData?.expo)

      if (isNaN(rawPrice) || isNaN(expo) || rawPrice <= 0) return null
      const price = rawPrice * Math.pow(10, expo)

      return {
        provider: 'pyth',
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
    const feedIdToAsset = new Map<string, string>()
    const ids: string[] = []

    for (const asset of assets) {
      const id = PYTH_FEED_IDS[asset.toUpperCase()]
      if (id) {
        feedIdToAsset.set(id.toLowerCase(), asset.toUpperCase())
        ids.push(id)
      }
    }

    if (ids.length === 0) return []

    const startTime = Date.now()
    try {
      const url = `${this.baseUrl}?${ids.map(id => `ids[]=${id}`).join('&')}`
      const response = await this.fetchFn(url, {
        signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return []

      const data = await response.json()
      const parsed = data?.parsed
      if (!Array.isArray(parsed)) return []

      const samples: PriceSample[] = []
      const now = Date.now()
      const latency = now - startTime

      for (const item of parsed) {
        const id = item?.id
          ? `0x${item.id.toLowerCase().replace(/^0x/, '')}`
          : null
        const rawPrice = Number(item?.price?.price)
        const expo = Number(item?.price?.expo)
        if (
          id &&
          feedIdToAsset.has(id) &&
          !isNaN(rawPrice) &&
          !isNaN(expo) &&
          rawPrice > 0
        ) {
          const asset = feedIdToAsset.get(id)!
          const price = rawPrice * Math.pow(10, expo)
          samples.push({
            provider: 'pyth',
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
