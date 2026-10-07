import type {
  PriceProviderId,
  PriceSample,
  SampledPriceResult,
  SamplingStrategy,
} from './types'

export const DEFAULT_PROVIDER_PRIORITY: PriceProviderId[] = [
  'chainlink',
  'pyth',
  'coinbase',
  'kraken',
  'coingecko',
  'binance',
]

export interface SamplerOptions {
  outlierThresholdPct?: number
  providerPriority?: PriceProviderId[]
}

/**
 * Samples a collection of provider price samples using the specified strategy.
 */
export function samplePrices(
  asset: string,
  samples: PriceSample[],
  strategy: SamplingStrategy = 'median',
  options: SamplerOptions = {},
): SampledPriceResult {
  const now = Date.now()
  if (!samples || samples.length === 0) {
    return {
      asset: asset.toUpperCase(),
      price: 0,
      strategy,
      sampleCount: 0,
      spreadPct: 0,
      samples: [],
      sampledAt: now,
    }
  }

  if (samples.length === 1) {
    const single = samples[0]
    return {
      asset: asset.toUpperCase(),
      price: single.price,
      strategy,
      sampleCount: 1,
      spreadPct: 0,
      samples: [single],
      sampledAt: now,
    }
  }

  // Calculate spread across all input samples
  const allPrices = samples.map(s => s.price)
  const minPrice = Math.min(...allPrices)
  const maxPrice = Math.max(...allPrices)
  const spreadPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : 0

  // Outlier filtering if 3 or more samples
  let filteredSamples = [...samples]
  const outlierThresholdPct = options.outlierThresholdPct ?? 40

  if (samples.length >= 3) {
    // Determine raw median
    const sorted = [...allPrices].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const rawMedian =
      sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2

    filteredSamples = samples.filter(s => {
      const diffPct = Math.abs((s.price - rawMedian) / rawMedian) * 100
      return diffPct <= outlierThresholdPct
    })

    // If filtering eliminated too many samples, fall back to all samples
    if (filteredSamples.length === 0) {
      filteredSamples = samples
    }
  }

  let finalPrice: number
  const workingPrices = filteredSamples.map(s => s.price)

  switch (strategy) {
    case 'waterfall': {
      const priority = options.providerPriority || DEFAULT_PROVIDER_PRIORITY
      const priorityMap = new Map(priority.map((p, idx) => [p, idx]))
      const sortedByPriority = [...filteredSamples].sort((a, b) => {
        const pA = priorityMap.get(a.provider) ?? 999
        const pB = priorityMap.get(b.provider) ?? 999
        return pA - pB
      })
      finalPrice = sortedByPriority[0].price
      break
    }
    case 'mean': {
      const sum = workingPrices.reduce((acc, p) => acc + p, 0)
      finalPrice = sum / workingPrices.length
      break
    }
    case 'median':
    default: {
      const sorted = [...workingPrices].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      finalPrice =
        sorted.length % 2 !== 0
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2
      break
    }
  }

  return {
    asset: asset.toUpperCase(),
    price: Math.round(finalPrice * 1e8) / 1e8,
    strategy,
    sampleCount: filteredSamples.length,
    spreadPct: Math.round(spreadPct * 100) / 100,
    samples,
    sampledAt: now,
  }
}
