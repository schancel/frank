import {
  SUPPORTED_ASSETS,
  computeOracleRates,
  convertRawToAvu,
  formatAvu,
  priceAssetId,
  unavailableOracleRates,
} from './price-oracle'
import { avuHashAt, type OracleInputs } from './energy-basket'
import { DIRECT_BASKET, DIRECT_ELECTRICITY } from '@frank/price-feeds'

const T = 2_000_000

const inputs: OracleInputs = {
  basket: DIRECT_BASKET,
  electricity: DIRECT_ELECTRICITY,
  series: {
    'price/btc-mainnet': { points: [[T - 60, 80_000]] },
    'marketCap/btc-mainnet': { points: [[T - 60, 1.6e12]] },
    'difficulty/btc-mainnet': { points: [[T - 60, 1.3e14]] },
    'blockReward/btc-mainnet': { points: [[T - 60, 3.125]] },
    'efficiency/sha256': { points: [[T - 60, 1.9e17]] },
    'price/monad-mainnet': { points: [[T - 30, 0.025]], stale: true },
    'price/solana-mainnet': { points: [[T + 30, 110]] },
  },
}

describe('the feed asset id of each wallet asset', () => {
  it('is its main network’s canonical chain id, whatever network the wallet is on', () => {
    expect(priceAssetId('monad')).toBe('monad-mainnet')
    expect(priceAssetId('ecash')).toBe('xec-mainnet')
    expect(priceAssetId('bitcoin')).toBe('btc-mainnet')
    expect(priceAssetId('bitcoincash')).toBe('bch-mainnet')
    expect(priceAssetId('dogecoin')).toBe('doge-mainnet')
    expect(priceAssetId('solana')).toBe('solana-mainnet')
    expect(priceAssetId('ethereum')).toBe('ethereum-mainnet')
    expect(priceAssetId('hyperliquid')).toBe('hyperliquid-mainnet')
  })
})

describe('the rates computed once from the feed', () => {
  it('are each asset’s price times AVU_hash, by floor lookup at the time asked about', () => {
    const rates = computeOracleRates(inputs, T)
    const hash = avuHashAt(inputs, T)!
    expect(rates.avuHash).toEqual(hash)
    expect(rates.rates.bitcoin).toBeCloseTo(80_000 * hash.kwhPerValue, 6)
    expect(rates.rates.monad).toBeCloseTo(0.025 * hash.kwhPerValue, 12)
    expect(rates.priceAt.monad).toBe(T - 30)
    expect(rates.priceStale.monad).toBe(true)
    expect(rates.priceStale.bitcoin).toBe(false)
    // Solana's first price is later than T: it has no value yet.
    expect(rates.rates.solana).toBeUndefined()
    // A coin the feed carries no price for has no rate: never a default.
    expect(rates.rates.ethereum).toBeUndefined()
    expect(rates.rates.tempo).toBeUndefined()
  })

  it('today’s rates are the history function evaluated now', () => {
    for (const t of [T, T + 30, T + 86_400]) {
      const rates = computeOracleRates(inputs, t)
      expect(rates.avuHash?.kwhPerValue).toBe(avuHashAt(inputs, t)?.kwhPerValue)
    }
    expect(computeOracleRates(inputs, T + 30).rates.solana).toBeDefined()
  })

  it('has no rate at all without AVU_hash', () => {
    const rates = computeOracleRates(inputs, T - 61)
    expect(rates.rates).toEqual({})
    expect(rates.avuHash).toBeUndefined()
    expect(unavailableOracleRates().rates).toEqual({})
  })

  it('knows every wallet asset', () => {
    expect(SUPPORTED_ASSETS).toContain('monad')
    expect(SUPPORTED_ASSETS).toHaveLength(9)
  })
})

describe('amounts in AVU', () => {
  it('converts a raw amount at a rate, and has no value without a rate', () => {
    expect(convertRawToAvu(1_500_000_000_000_000_000n, 'monad', 2)).toBeCloseTo(3, 9)
    expect(convertRawToAvu(150n, 'ecash', 4)).toBeCloseTo(6, 9)
    expect(convertRawToAvu(0n, 'monad', 2)).toBe(0)
    expect(convertRawToAvu(5n, 'monad', undefined)).toBeUndefined()
  })

  it('formats compactly, three significant digits with an SI prefix', () => {
    expect(formatAvu(92.5)).toBe('92.5 AVU')
    expect(formatAvu(1309.52)).toBe('1.31 kAVU')
    expect(formatAvu(2_500_000)).toBe('2.5 MAVU')
    expect(formatAvu(7.9e11)).toBe('790 GAVU')
    expect(formatAvu(0.0042)).toBe('4.2 mAVU')
    expect(formatAvu(0.00000012)).toBe('120 nAVU')
    expect(formatAvu(999.96)).toBe('1000 AVU')
    // Nothing, not "0 AVU", for nothing or an unknown value.
    expect(formatAvu(0)).toBe('')
    expect(formatAvu(Number.NaN)).toBe('')
  })
})
