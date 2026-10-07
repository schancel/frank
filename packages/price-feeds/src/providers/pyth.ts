import type { PriceFeedProvider, PriceSample } from '../types'

export const PYTH_FEED_IDS: Record<string, string> = {
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: '0xe62df6e22e666f357632ddc6b45d24e71cc292e27dc64376c8409dd173237e2a',
  GOLD: '0x765d2ba906da5188bb6811c0f9d250760786520b41259398f6912f7166396344',
  XAU: '0x765d2ba906da5188bb6811c0f9d250760786520b41259398f6912f7166396344',
  BRENT: '0x27f547c8702b80053e1a74288b832b8519cf2d815777a164f0b2fbe8eb2eb471',
}

export const PYTH_HERMES_URL =
  'https://hermes.pyth.network/v2/updates/price/latest'

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
