import type {
  PriceFeedProvider,
  PriceFeedsClientOptions,
  PriceProviderId,
  PriceSample,
  SampledPriceResult,
  SamplingStrategy,
} from './types'
import {
  BinanceProvider,
  ChainlinkProvider,
  CoinbaseProvider,
  CoinGeckoProvider,
  KrakenProvider,
  PythProvider,
} from './providers'
import { samplePrices } from './sampler'

export class PriceFeedsClient {
  private providers: PriceFeedProvider[]
  private defaultStrategy: SamplingStrategy
  private timeoutMs: number

  constructor(options: PriceFeedsClientOptions = {}) {
    this.defaultStrategy = options.defaultStrategy || 'median'
    this.timeoutMs = options.timeoutMs || 3500

    const fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis)
    const enabledIds = new Set<PriceProviderId>(
      options.providers || [
        'chainlink',
        'pyth',
        'coinbase',
        'kraken',
        'coingecko',
        'binance',
      ],
    )

    const allProviders: PriceFeedProvider[] = [
      new ChainlinkProvider({
        rpcUrl: options.ethRpcUrl,
        relayRpcUrl: options.relayRpcUrl,
        fetchFn,
      }),
      new PythProvider({ fetchFn }),
      new CoinbaseProvider({ fetchFn }),
      new KrakenProvider({ fetchFn }),
      new CoinGeckoProvider({ fetchFn }),
      new BinanceProvider({ fetchFn }),
    ]

    this.providers = allProviders.filter(p => enabledIds.has(p.id))
  }

  getActiveProviders(): PriceProviderId[] {
    return this.providers.map(p => p.id)
  }

  async getPrice(
    asset: string,
    strategy?: SamplingStrategy,
  ): Promise<SampledPriceResult> {
    const strat = strategy || this.defaultStrategy
    const candidateProviders = this.providers.filter(p =>
      p.supportsAsset(asset),
    )

    if (candidateProviders.length === 0) {
      return samplePrices(asset, [], strat)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const promises = candidateProviders.map(async provider => {
        try {
          return await provider.fetchPrice(asset, controller.signal)
        } catch {
          return null
        }
      })

      const results = await Promise.allSettled(promises)
      const samples: PriceSample[] = []

      for (const res of results) {
        if (
          res.status === 'fulfilled' &&
          res.value !== null &&
          res.value.price > 0
        ) {
          samples.push(res.value)
        }
      }

      return samplePrices(asset, samples, strat)
    } finally {
      clearTimeout(timer)
    }
  }

  async getSnapshot(
    assets: string[],
    strategy?: SamplingStrategy,
  ): Promise<Record<string, SampledPriceResult>> {
    const strat = strategy || this.defaultStrategy
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const providerPromises = this.providers.map(async provider => {
        const supported = assets.filter(a => provider.supportsAsset(a))
        if (supported.length === 0) return []

        try {
          if (typeof provider.fetchPrices === 'function') {
            return await provider.fetchPrices(supported, controller.signal)
          }

          const individual = await Promise.all(
            supported.map(a => provider.fetchPrice(a, controller.signal)),
          )
          return individual.filter(
            (s): s is PriceSample => s !== null && s.price > 0,
          )
        } catch {
          return []
        }
      })

      const providerResults = await Promise.allSettled(providerPromises)
      const assetSamples = new Map<string, PriceSample[]>()
      for (const asset of assets) {
        assetSamples.set(asset.toUpperCase(), [])
      }

      for (const res of providerResults) {
        if (res.status === 'fulfilled') {
          for (const sample of res.value) {
            const list = assetSamples.get(sample.asset.toUpperCase())
            if (list) {
              list.push(sample)
            }
          }
        }
      }

      const snapshot: Record<string, SampledPriceResult> = {}
      for (const asset of assets) {
        const samples = assetSamples.get(asset.toUpperCase()) || []
        snapshot[asset.toUpperCase()] = samplePrices(asset, samples, strat)
      }

      return snapshot
    } finally {
      clearTimeout(timer)
    }
  }
}
