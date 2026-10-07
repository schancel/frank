export type PriceProviderId =
  | 'chainlink'
  | 'pyth'
  | 'coinbase'
  | 'kraken'
  | 'coingecko'
  | 'binance'

export type SupportedFeedAsset =
  | 'ETH'
  | 'SOL'
  | 'XEC'
  | 'BTC'
  | 'GOLD'
  | 'BRENT'
  | 'MON'
  | 'HYPE'
  | 'TUSD'
  | (string & {})

export type SamplingStrategy = 'median' | 'mean' | 'waterfall'

export interface PriceSample {
  provider: PriceProviderId
  asset: string
  price: number
  timestamp: number
  latencyMs: number
}

export interface SampledPriceResult {
  asset: string
  price: number
  strategy: SamplingStrategy
  sampleCount: number
  spreadPct: number
  samples: PriceSample[]
  sampledAt: number
}

export interface PriceFeedProvider {
  readonly id: PriceProviderId
  supportsAsset(asset: string): boolean
  fetchPrice(asset: string, signal?: AbortSignal): Promise<PriceSample | null>
  fetchPrices?(assets: string[], signal?: AbortSignal): Promise<PriceSample[]>
}

export interface PriceFeedsClientOptions {
  providers?: PriceProviderId[]
  defaultStrategy?: SamplingStrategy
  timeoutMs?: number
  fetchFn?: typeof fetch
  relayRpcUrl?: string
  ethRpcUrl?: string
}
