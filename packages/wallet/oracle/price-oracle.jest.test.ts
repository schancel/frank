import {
  convertRawToAvu,
  formatAvu,
  calculateSwapParity,
  unavailableOracleSnapshot,
  rateOracleSnapshot,
  miningDollarsPerKwh,
  hashesPerKwhAt,
  basketWeights,
  computeAvuHash,
  avuPerCoin,
  latestAvuSpot,
  latestHashingEfficiency,
  AVU_HASH_BASKET,
  AVU_HASH_CHAINS,
  BITCOIN_WEIGHT_CAP,
  BTC_MONTHLY_AVU_HASH,
  BTC_MINING_MONTHLY,
  HASHING_EFFICIENCY,
  US_MONTHLY_INDUSTRIAL_ELECTRICITY,
  ASSET_FEED_SYMBOLS,
  fetchPrices,
  PriceFeedsClient,
  type HashingEfficiency,
  type MiningStats,
  type PriceReading,
} from './index'
import * as oracleModule from './index'

const NOW = 1_800_000_000_000

function stats(
  chain: string,
  subsidyCoinsPerBlock: number,
  hashesPerBlock: number,
  circulatingCoins: number,
  fetchedAt = NOW,
): MiningStats {
  return {
    chain,
    subsidyCoinsPerBlock,
    difficulty: hashesPerBlock / 2 ** 32,
    hashesPerBlock,
    circulatingCoins,
    fetchedAt,
  }
}

function reading(usd: number, fetchedAt = NOW): PriceReading {
  return { usd, fetchedAt }
}

describe('AVU_hash and the price oracle (@frank/wallet/oracle)', () => {
  describe('miningDollarsPerKwh: one coin of the basket', () => {
    it('is price x coins per block / hashes per block x hashes per kWh, in $/kWh', () => {
      // 100,000 $/BTC x 3.125 BTC/block = 312,500 $ per block.
      // Difficulty D = 1e14 -> D x 2^32 = 4.294967296e23 hashes per block.
      //   312,500 / 4.294967296e23 = 7.27596e-19 $ per hash.
      // Efficiency 20 J/TH = 2e-11 J per hash -> 3.6e6 / 2e-11 = 1.8e17 hashes per kWh.
      //   7.27596e-19 x 1.8e17 = 0.130967 $/kWh, i.e. 7.6355 kWh per dollar.
      expect(hashesPerKwhAt(20)).toBeCloseTo(1.8e17, -6)
      const dollarsPerKwh = miningDollarsPerKwh({
        priceUsd: 100_000,
        coinsPerBlock: 3.125,
        hashesPerBlock: 1e14 * 2 ** 32,
        hashesPerKwh: hashesPerKwhAt(20),
      })
      expect(dollarsPerKwh).toBeCloseTo(0.130967, 6)
      expect(1 / dollarsPerKwh!).toBeCloseTo(7.6355, 4)
    })

    it('keeps its units: 1 $ per block of 1000 hashes at 1 J per hash is 3,600 $/kWh', () => {
      // 1 J per hash = 1e12 J/TH; one kWh is 3.6e6 J, so 3.6e6 hashes per kWh.
      expect(hashesPerKwhAt(1e12)).toBeCloseTo(3.6e6, 6)
      expect(
        miningDollarsPerKwh({
          priceUsd: 1,
          coinsPerBlock: 1,
          hashesPerBlock: 1000,
          hashesPerKwh: 3.6e6,
        }),
      ).toBeCloseTo(3600, 9)
    })

    it.each([
      ['price', { priceUsd: 0 }],
      ['subsidy', { coinsPerBlock: 0 }],
      ['hashes per block', { hashesPerBlock: 0 }],
      ['efficiency', { hashesPerKwh: Number.NaN }],
    ])('has no answer without a real %s: never a baseline', (_name, missing) => {
      expect(
        miningDollarsPerKwh({
          priceUsd: 1,
          coinsPerBlock: 1,
          hashesPerBlock: 1,
          hashesPerKwh: 1,
          ...missing,
        }),
      ).toBeUndefined()
    })
  })

  describe('basketWeights: market-cap weights with Bitcoin capped at 60%', () => {
    const sum = (weights: Record<string, number>) =>
      Object.values(weights).reduce((a, b) => a + b, 0)

    it('caps Bitcoin and shares the rest among the others by market cap', () => {
      // Raw shares: bitcoin 900/1000 = 90%. Capped to 60%; the other 40% is split
      // 75:25 between a (75) and b (25): 30% and 10%.
      const weights = basketWeights({ bitcoin: 900, a: 75, b: 25 })
      expect(BITCOIN_WEIGHT_CAP).toBe(0.6)
      expect(weights.bitcoin).toBeCloseTo(0.6, 12)
      expect(weights.a).toBeCloseTo(0.3, 12)
      expect(weights.b).toBeCloseTo(0.1, 12)
      expect(sum(weights)).toBeCloseTo(1, 12)
    })

    it('applies no cap when Bitcoin is at or under 60%: plain market-cap shares', () => {
      const weights = basketWeights({ bitcoin: 50, a: 30, b: 20 })
      expect(weights).toEqual({ bitcoin: 0.5, a: 0.3, b: 0.2 })
      expect(basketWeights({ bitcoin: 60, a: 40 })).toEqual({
        bitcoin: 0.6,
        a: 0.4,
      })
    })

    it('renormalises over the coins present when one is missing', () => {
      // b is gone: the 40% beside capped Bitcoin all goes to a.
      const weights = basketWeights({ bitcoin: 900, a: 75 })
      expect(weights.bitcoin).toBeCloseTo(0.6, 12)
      expect(weights.a).toBeCloseTo(0.4, 12)
      // Bitcoin is gone: the others share everything by market cap.
      expect(basketWeights({ a: 75, b: 25 })).toEqual({ a: 0.75, b: 0.25 })
      // Bitcoin alone: nothing to give the remainder to.
      expect(basketWeights({ bitcoin: 900 })).toEqual({ bitcoin: 1 })
    })
  })

  describe('computeAvuHash', () => {
    // Efficiencies for the worked example. Not real hardware figures: round numbers so
    // the arithmetic can be followed by hand.
    const month = '2026-09'
    const efficiencies: Record<string, HashingEfficiency[]> = {
      sha256: [{ month, hashesPerKwh: 2e17 }],
      scrypt: [{ month, hashesPerKwh: 1e13 }],
      randomx: [{ month, hashesPerKwh: 5e7 }],
    }
    const prices = {
      BTC: reading(100_000),
      BCH: reading(400),
      XEC: reading(0.00001),
      LTC: reading(80),
      DOGE: reading(0.1),
      XMR: reading(300),
    }
    const mining = {
      'bitcoin': stats('bitcoin', 3.125, 5e23, 20_000_000),
      'bitcoin-cash': stats('bitcoin-cash', 3.125, 2e21, 20_000_000),
      'ecash': stats('ecash', 3_125_000, 2.5e19, 20_000_000_000_000),
      'litecoin': stats('litecoin', 6.25, 4e17, 75_000_000),
      'dogecoin': stats('dogecoin', 10_000, 2e17, 150_000_000_000),
      'monero': stats('monero', 0.6, 7.5e11, 18_000_000),
    }

    it('works the whole basket: BTC, BCH, XEC, merge-mined LTC+DOGE and XMR', () => {
      const avuHash = computeAvuHash(
        prices,
        mining,
        AVU_HASH_BASKET,
        efficiencies,
      )!
      const entry = (id: string) => avuHash.entries.find(e => e.id === id)!

      // BTC: 100,000 x 3.125 / 5e23 = 6.25e-19 $/hash x 2e17 hashes/kWh = 0.125 $/kWh
      expect(entry('bitcoin').dollarsPerKwh).toBeCloseTo(0.125, 12)
      expect(entry('bitcoin').kwhPerDollar).toBeCloseTo(8, 9)
      // BCH: 400 x 3.125 / 2e21 = 6.25e-19 x 2e17 = 0.125 $/kWh
      expect(entry('bitcoin-cash').dollarsPerKwh).toBeCloseTo(0.125, 12)
      // XEC: the miner receives 58% of the 3,125,000 XEC subsidy = 1,812,500 XEC.
      //   0.00001 x 1,812,500 / 2.5e19 = 7.25e-19 x 2e17 = 0.145 $/kWh
      expect(entry('ecash').dollarsPerKwh).toBeCloseTo(0.145, 12)
      // LTC+DOGE are merge-mined: one hash earns on both, so pay per hash is summed
      // and the energy counted once.
      //   LTC 80 x 6.25 / 4e17 = 1.25e-15; DOGE 0.1 x 10,000 / 2e17 = 5e-15
      //   (1.25e-15 + 5e-15) x 1e13 hashes/kWh = 0.0625 $/kWh = 16 kWh/$
      expect(entry('scrypt').dollarsPerKwh).toBeCloseTo(0.0625, 12)
      expect(entry('scrypt').kwhPerDollar).toBeCloseTo(16, 9)
      // XMR: 300 x 0.6 / 7.5e11 = 2.4e-10 x 5e7 = 0.012 $/kWh
      expect(entry('monero').dollarsPerKwh).toBeCloseTo(0.012, 12)

      // Market caps, $bn: BTC 2000, BCH 8, XEC 0.2, LTC+DOGE 6 + 15 = 21, XMR 5.4.
      expect(entry('bitcoin').marketCapUsd).toBeCloseTo(2e12, 0)
      expect(entry('scrypt').marketCapUsd).toBeCloseTo(21e9, 0)
      // Bitcoin's raw share is 98%, so it is capped at 60%; the others share 40% by
      // market cap out of 8 + 0.2 + 21 + 5.4 = 34.6.
      expect(entry('bitcoin').weight).toBeCloseTo(0.6, 12)
      expect(entry('bitcoin-cash').weight).toBeCloseTo((0.4 * 8) / 34.6, 12)
      expect(entry('ecash').weight).toBeCloseTo((0.4 * 0.2) / 34.6, 12)
      expect(entry('scrypt').weight).toBeCloseTo((0.4 * 21) / 34.6, 12)
      expect(entry('monero').weight).toBeCloseTo((0.4 * 5.4) / 34.6, 12)
      expect(
        avuHash.entries.reduce((total, e) => total + e.weight, 0),
      ).toBeCloseTo(1, 12)

      // AVU_hash is the weighted average of the kWh-per-dollar values.
      const expected =
        0.6 * 8 +
        ((0.4 * 8) / 34.6) * 8 +
        ((0.4 * 0.2) / 34.6) * (1 / 0.145) +
        ((0.4 * 21) / 34.6) * 16 +
        ((0.4 * 5.4) / 34.6) * (1 / 0.012)
      expect(avuHash.kwhPerDollar).toBeCloseTo(expected, 9)
      expect(avuHash.leftOut).toEqual([])
      expect(avuHash.basketSize).toBe(5)
      expect(avuHash.efficiencyMonth).toBe(month)
    })

    it('leaves out an entry missing a price or its chain statistics and reweights the rest', () => {
      const avuHash = computeAvuHash(
        { ...prices, BCH: undefined },
        { ...mining, monero: undefined },
        AVU_HASH_BASKET,
        efficiencies,
      )!
      expect(avuHash.entries.map(e => e.id)).toEqual([
        'bitcoin',
        'ecash',
        'scrypt',
      ])
      expect(avuHash.leftOut).toEqual([
        { id: 'bitcoin-cash', label: 'BCH', reason: 'price' },
        { id: 'monero', label: 'XMR', reason: 'chain' },
      ])
      expect(avuHash.entries[0].weight).toBeCloseTo(0.6, 12)
      expect(avuHash.entries[2].weight).toBeCloseTo((0.4 * 21) / 21.2, 12)
      expect(avuHash.basketSize).toBe(5)
    })

    it('leaves out a merge-mined entry when either of its chains is missing', () => {
      const avuHash = computeAvuHash(
        { ...prices, LTC: undefined },
        mining,
        AVU_HASH_BASKET,
        efficiencies,
      )!
      expect(avuHash.leftOut).toEqual([
        { id: 'scrypt', label: 'LTC+DOGE', reason: 'price' },
      ])
    })

    it('is unavailable when no entry resolves: there is no fallback rate', () => {
      expect(
        computeAvuHash({}, mining, AVU_HASH_BASKET, efficiencies),
      ).toBeUndefined()
      expect(
        computeAvuHash(prices, {}, AVU_HASH_BASKET, efficiencies),
      ).toBeUndefined()
      expect(computeAvuHash(prices, mining, AVU_HASH_BASKET, {})).toBeUndefined()
    })

    it('reports the oldest price and the oldest chain statistics it used', () => {
      const avuHash = computeAvuHash(
        { ...prices, BCH: reading(400, NOW - 5000) },
        { ...mining, ecash: stats('ecash', 3_125_000, 2.5e19, 2e13, NOW - 9000) },
        AVU_HASH_BASKET,
        efficiencies,
      )!
      expect(avuHash.pricesAsOf).toBe(NOW - 5000)
      expect(avuHash.chainsAsOf).toBe(NOW - 9000)
    })

    it('with the bundled efficiencies computes the SHA-256 coins and says the rest have no series', () => {
      expect(Object.keys(HASHING_EFFICIENCY)).toEqual(['sha256'])
      expect(AVU_HASH_CHAINS).toEqual(['bitcoin', 'bitcoin-cash', 'ecash'])
      const avuHash = computeAvuHash(prices, mining)!
      expect(avuHash.entries.map(e => e.id)).toEqual([
        'bitcoin',
        'bitcoin-cash',
        'ecash',
      ])
      expect(avuHash.leftOut).toEqual([
        { id: 'scrypt', label: 'LTC+DOGE', reason: 'efficiency' },
        { id: 'monero', label: 'XMR', reason: 'efficiency' },
      ])
      // The efficiency is the latest month of the bundled Cambridge series.
      const latest = BTC_MINING_MONTHLY[BTC_MINING_MONTHLY.length - 1]
      expect(avuHash.efficiencyMonth).toBe(latest.month)
      expect(latestHashingEfficiency('sha256')?.hashesPerKwh).toBe(
        hashesPerKwhAt(latest.joulesPerTerahash),
      )
      expect(avuHash.entries[0].dollarsPerKwh).toBeCloseTo(
        6.25e-19 * hashesPerKwhAt(latest.joulesPerTerahash),
        12,
      )
    })
  })

  describe('avuPerCoin: the AVU value of a coin is its price times AVU_hash', () => {
    it('is kWh per coin', () => {
      expect(avuPerCoin(110, { kwhPerDollar: 12 })).toBeCloseTo(1320, 9)
    })
    it('has no value without AVU_hash or without a price', () => {
      expect(avuPerCoin(110, undefined)).toBeUndefined()
      expect(avuPerCoin(0, { kwhPerDollar: 12 })).toBeUndefined()
    })
  })

  describe('no typed-in rate', () => {
    it('exports no dollars-per-kWh or AVU-per-dollar constant', () => {
      for (const name of [
        'POW_BASELINE_DOLLARS_PER_KWH',
        'AVU_PER_DOLLAR',
        'AVU_ENERGY_ANCHOR_NOMINAL',
        'calculateAvuRate',
        'POW_NETWORKS',
      ]) {
        expect(oracleModule).not.toHaveProperty(name)
      }
    })
  })

  describe('bundled history', () => {
    it('applies the same formula to each bundled month of Bitcoin inputs', () => {
      expect(BTC_MONTHLY_AVU_HASH).toHaveLength(BTC_MINING_MONTHLY.length)
      const m = BTC_MINING_MONTHLY.find(p => p.month === '2024-07')!
      const dollarsPerKwh =
        ((m.btcUsd * m.subsidyBtc) / (m.difficulty * 2 ** 32)) *
        (3.6e6 / (m.joulesPerTerahash * 1e-12))
      expect(
        BTC_MONTHLY_AVU_HASH.find(p => p.month === '2024-07')?.kwhPerDollar,
      ).toBeCloseTo(1 / dollarsPerKwh, 9)
    })

    it('reads AVU_spot from the latest published electricity month', () => {
      const latest =
        US_MONTHLY_INDUSTRIAL_ELECTRICITY[
          US_MONTHLY_INDUSTRIAL_ELECTRICITY.length - 1
        ]
      expect(latestAvuSpot()).toEqual({
        kwhPerDollar: 100 / latest.centsPerKwh,
        centsPerKwh: latest.centsPerKwh,
        month: latest.month,
      })
      // 8 cents per kWh is 12.5 kWh per dollar.
      expect(
        latestAvuSpot([{ month: '2026-01', centsPerKwh: 8 }])?.kwhPerDollar,
      ).toBeCloseTo(12.5, 9)
      expect(latestAvuSpot([])).toBeUndefined()
    })
  })

  describe('convertRawToAvu', () => {
    const oneMon = 1_000_000_000_000_000_000n

    it('converts base units at the given rate for each decimal scale', () => {
      expect(convertRawToAvu(5n * oneMon, 'monad', 0.3)).toBeCloseTo(1.5, 6)
      expect(convertRawToAvu(100_000_000n, 'ecash', 0.0001)).toBeCloseTo(100, 6)
      expect(convertRawToAvu(2_500_000_000n, 'solana', 37)).toBeCloseTo(92.5, 6)
    })

    it('has no value when there is no rate: an unknown price is not zero and not a default', () => {
      expect(convertRawToAvu(oneMon, 'monad')).toBeUndefined()
      expect(convertRawToAvu(oneMon, 'tempo', undefined)).toBeUndefined()
    })

    it('is zero for an empty balance', () => {
      expect(convertRawToAvu(0n, 'monad', 0.3)).toBe(0)
      expect(convertRawToAvu(null, 'monad', 0.3)).toBe(0)
    })
  })

  describe('formatAvu', () => {
    it('formats for display', () => {
      expect(formatAvu(0)).toBe('0 AVU')
      expect(formatAvu(0.001)).toBe('< 0.01 AVU')
      expect(formatAvu(41.666)).toBe('41.67 AVU')
      expect(formatAvu(30952.38)).toBe('30,952.4 AVU')
    })
  })

  describe('calculateSwapParity', () => {
    const rates = { monad: 0.3, solana: 1300 }
    const oneMon = 1_000_000_000_000_000_000n

    it('compares two coins through their AVU rates', () => {
      // 1300 / 0.3 MON is worth exactly 1 SOL
      const fair = calculateSwapParity(
        4333n * oneMon,
        'monad',
        1_000_000_000n,
        'solana',
        rates,
      )
      expect(fair?.status).toBe('fair')
      const bad = calculateSwapParity(
        4333n * oneMon,
        'monad',
        500_000_000n,
        'solana',
        rates,
      )
      expect(bad?.status).toBe('warning')
      expect(bad?.parityPercent).toBeCloseTo(-50, 0)
    })

    it('states no parity when either coin has no fetched price', () => {
      expect(
        calculateSwapParity(oneMon, 'monad', 1_000_000n, 'tempo', rates),
      ).toBeUndefined()
    })
  })

  describe('fetchPrices', () => {
    function clientReturning(prices: Record<string, number>) {
      return {
        getSnapshot: jest.fn(async (symbols: string[]) =>
          Object.fromEntries(
            symbols.map(symbol => {
              const price = prices[symbol] ?? 0
              const providers = symbol === 'XEC' ? ['coingecko'] : ['kraken', 'coinbase', 'coingecko']
              return [
                symbol,
                {
                  price,
                  sampleCount: price > 0 ? providers.length : 0,
                  // Each provider's own answer: one a little under, one a little over.
                  samples:
                    price > 0
                      ? providers.map((provider, index) => ({
                          provider,
                          asset: symbol,
                          price: price * (1 + (index - 1) / 1000),
                          timestamp: NOW,
                          latencyMs: 1,
                        }))
                      : [],
                },
              ]
            }),
          ),
        ),
      } as unknown as PriceFeedsClient
    }
    const chainStats: Record<string, MiningStats> = {
      'bitcoin': stats('bitcoin', 3.125, 5e23, 20_000_000),
      'bitcoin-cash': stats('bitcoin-cash', 3.125, 2e21, 20_000_000),
      'ecash': stats('ecash', 3_125_000, 2.5e19, 20_000_000_000_000),
    }
    const market = { SOL: 110, MON: 0.025, BTC: 82000, BCH: 300, XEC: 0.00001 }

    /** The snapshot the app builds from fetched prices and chain statistics. */
    async function snapshotOf(
      prices: Record<string, number>,
      mining: Record<string, MiningStats>,
    ) {
      const fetched = await fetchPrices({ client: clientReturning(prices) })
      const snapshot = unavailableOracleSnapshot()
      snapshot.timestamp = fetched.timestamp
      for (const [asset, price] of Object.entries(fetched.prices) as Array<
        [keyof typeof fetched.prices, NonNullable<(typeof fetched.prices)['solana']>]
      >) {
        snapshot.prices[asset] = price.usd
        snapshot.fetchedAt[asset] = fetched.timestamp
        snapshot.priceSources[asset] = price.sources
      }
      snapshot.mining = mining
      return rateOracleSnapshot(snapshot)
    }
    const scaled = (scale: number) =>
      Object.fromEntries(
        Object.entries(chainStats).map(([chain, s]) => [
          chain,
          { ...s, hashesPerBlock: s.hashesPerBlock * scale },
        ]),
      )

    it('asks for a market price for every asset in the table, including MON, HYPE, BTC, BCH and DOGE', async () => {
      const client = clientReturning({})
      await fetchPrices({ client })
      const asked = (client.getSnapshot as jest.Mock).mock.calls[0][0]
      expect(asked.sort()).toEqual(
        ['BCH', 'BTC', 'DOGE', 'ETH', 'HYPE', 'MON', 'SOL', 'XEC'].sort(),
      )
      expect(ASSET_FEED_SYMBOLS.tempo).toBeUndefined()
    })

    it('returns each asset’s median with every provider’s own answer and how many it rests on', async () => {
      const fetched = await fetchPrices({ client: clientReturning(market) })
      expect(Object.keys(fetched.prices).sort()).toEqual(
        ['bitcoin', 'bitcoincash', 'ecash', 'monad', 'solana'].sort(),
      )
      expect(fetched.prices.solana).toEqual({
        usd: 110,
        sources: 3,
        providers: {
          kraken: 110 * 0.999,
          coinbase: 110,
          coingecko: 110 * 1.001,
        },
      })
      expect(fetched.prices.ecash!.sources).toBe(1)
      expect(Object.keys(fetched.prices.ecash!.providers)).toEqual(['coingecko'])
      expect(fetched.timestamp).toBeGreaterThan(0)
    })

    it('states each fetched price in AVU by multiplying it by AVU_hash', async () => {
      const snapshot = await snapshotOf(market, chainStats)
      const kwhPerDollar = snapshot.avuHash!.kwhPerDollar
      expect(kwhPerDollar).toBeGreaterThan(0)
      expect(snapshot.avuHash!.entries.map(e => e.id)).toEqual([
        'bitcoin',
        'bitcoin-cash',
        'ecash',
      ])
      expect(snapshot.rates.solana).toBeCloseTo(110 * kwhPerDollar, 6)
      expect(snapshot.rates.monad).toBeCloseTo(0.025 * kwhPerDollar, 9)
      // Any two coins compare through the unit: the ratio of rates is the ratio of prices.
      expect(snapshot.rates.bitcoin! / snapshot.rates.solana!).toBeCloseTo(
        82000 / 110,
        6,
      )
    })

    it('has no constant in the path: doubling every chain’s hashes per block doubles every AVU value', async () => {
      const before = await snapshotOf(market, chainStats)
      const after = await snapshotOf(market, scaled(2))
      expect(Object.keys(after.rates).sort()).toEqual(
        Object.keys(before.rates).sort(),
      )
      expect(Object.keys(before.rates).length).toBeGreaterThan(3)
      for (const asset of Object.keys(before.rates) as Array<
        keyof typeof before.rates
      >) {
        expect(after.rates[asset]! / before.rates[asset]!).toBeCloseTo(2, 9)
      }
    })

    it('computes over the basket coins that resolved when one chain’s statistics are missing', async () => {
      const { 'bitcoin-cash': _missing, ...rest } = chainStats
      const snapshot = await snapshotOf(market, rest)
      expect(snapshot.avuHash!.entries.map(e => e.id)).toEqual([
        'bitcoin',
        'ecash',
      ])
      expect(snapshot.avuHash!.leftOut).toContainEqual({
        id: 'bitcoin-cash',
        label: 'BCH',
        reason: 'chain',
      })
      expect(snapshot.rates.solana).toBeGreaterThan(0)
    })

    it('has prices but no AVU value for anything without chain statistics', async () => {
      const snapshot = await snapshotOf(market, {})
      expect(snapshot.prices.solana).toBe(110)
      expect(snapshot.avuHash).toBeUndefined()
      expect(snapshot.rates).toEqual({})
    })

    it('gives an asset whose price did not come back no rate at all', async () => {
      const snapshot = await snapshotOf({ ...market, MON: 0 }, chainStats)
      expect(snapshot.rates.monad).toBeUndefined()
      expect(snapshot.prices.ethereum).toBeUndefined()
    })

    it('rerates a snapshot from its prices and statistics alone, ignoring stored rates', () => {
      const snapshot = unavailableOracleSnapshot()
      snapshot.prices = { bitcoin: 100_000, solana: 100 }
      snapshot.fetchedAt = { bitcoin: NOW, solana: NOW }
      snapshot.mining = { bitcoin: chainStats.bitcoin }
      snapshot.rates = { solana: 123456, tempo: 1 }
      const rated = rateOracleSnapshot(snapshot)
      expect(rated.avuHash!.entries.map(e => e.id)).toEqual(['bitcoin'])
      expect(rated.rates).toEqual({
        bitcoin: 100_000 * rated.avuHash!.kwhPerDollar,
        solana: 100 * rated.avuHash!.kwhPerDollar,
      })
    })

    it('has no prices when the fetch fails: a failure is never a default price', async () => {
      const failing = {
        getSnapshot: jest.fn().mockRejectedValue(new Error('offline')),
      } as unknown as PriceFeedsClient
      expect((await fetchPrices({ client: failing })).prices).toEqual({})
    })

    it('has no prices when every request fails over HTTP', async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error('network down'))
      const fetched = await fetchPrices({
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 500,
      })
      expect(fetchFn).toHaveBeenCalled()
      expect(fetched.prices).toEqual({})
    })
  })
})
