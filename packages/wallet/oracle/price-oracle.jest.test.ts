import {
  computeEnergyBasketIndex,
  calculateAvuRate,
  convertRawToAvu,
  formatAvu,
  calculateSwapParity,
  unavailableOracleSnapshot,
  miningDollarsPerKwh,
  ASSET_FEED_SYMBOLS,
  fetchOracleSnapshot,
  PriceFeedsClient,
  calculatePoWEnergyCost,
  POW_BASELINE_DOLLARS_PER_KWH,
  AVU_PER_DOLLAR,
} from './index'

describe('PoW Thermodynamic Energy Standard & Price Oracle (@frank/wallet/oracle)', () => {
  describe('computeEnergyBasketIndex', () => {
    it('evaluates to 1.0 when prices match reference anchor prices', () => {
      const index = computeEnergyBasketIndex({
        brentCrude: 75.0,
        naturalGas: 2.5,
        nuclear: 80.0,
        gold: 2650.0,
      })
      expect(index).toBeCloseTo(1.0, 5)
    })

    it('evaluates to 1.0 on empty inputs using default reference prices', () => {
      expect(computeEnergyBasketIndex({})).toBeCloseTo(1.0, 5)
    })

    it('correctly weighs constituent price shifts using geometric mean', () => {
      // Gold has weight 0.25. If gold doubles while others stay constant:
      // index = (2)^0.25 ~= 1.1892
      const index = computeEnergyBasketIndex({
        gold: 5300.0, // 2x
      })
      expect(index).toBeCloseTo(Math.pow(2, 0.25), 3)
    })
  })

  describe('calculatePoWEnergyCost', () => {
    it('computes physical power, $/kWh, and AVU/$ accurately from network stats', () => {
      // 1000 H/s at 1 J/H = 1000 Watts
      // Reward = $1 every 1000 seconds => $0.001 / sec
      // $/Joule = $0.001 / 1000 W = 1e-6 $/J
      // $/kWh = 1e-6 * 3.6e6 = $3.60 / kWh
      // AVU/$ = 1 / 3.60 = 0.2778
      const res = calculatePoWEnergyCost({
        spotPriceUsd: 1.0,
        rewardPerBlock: 1.0,
        blockTimeSec: 1000,
        hashrateHps: 1000,
        joulesPerHash: 1.0,
      })

      expect(res.powerWatts).toBe(1000)
      expect(res.revenuePerSec).toBe(0.001)
      expect(res.dollarsPerKwh).toBeCloseTo(3.6, 4)
      expect(res.avuPerDollar).toBeCloseTo(1 / 3.6, 4)
    })

    it('returns default baseline on invalid zero or negative inputs', () => {
      const res = calculatePoWEnergyCost({
        spotPriceUsd: 0,
        rewardPerBlock: 3.125,
        blockTimeSec: 600,
        hashrateHps: 1e21,
        joulesPerHash: 17.5e-12,
      })
      expect(res.dollarsPerKwh).toBe(POW_BASELINE_DOLLARS_PER_KWH)
      expect(res.avuPerDollar).toBe(AVU_PER_DOLLAR)
    })
  })

  describe('calculateAvuRate', () => {
    it('calculates AVU conversion rate using baseline anchor factor $0.084/kWh (1 AVU = 1 kWh)', () => {
      // 1 AVU = $0.084 when basket index is 1.0 (11.90476 AVU / $)
      // An asset at $0.084 should equal 1.0 AVU
      expect(calculateAvuRate(0.084, 1.0)).toBeCloseTo(1.0, 4)
      // An asset at $8.40 should equal 100.0 AVU
      expect(calculateAvuRate(8.4, 1.0)).toBeCloseTo(100.0, 4)
    })

    it('returns 0 for non-positive spot price or index', () => {
      expect(calculateAvuRate(0, 1.0)).toBe(0)
      expect(calculateAvuRate(100, 0)).toBe(0)
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

  describe('miningDollarsPerKwh', () => {
    it('turns dollars per hash into dollars per kWh at the stated joules per hash', () => {
      // 1e-6 $ per hash at 1 J per hash is 1e-6 $/J = 3.6 $/kWh
      expect(miningDollarsPerKwh(1e-6, 1)).toBeCloseTo(3.6, 6)
    })
    it('has no answer without real inputs', () => {
      expect(miningDollarsPerKwh(0, 17.5e-12)).toBeUndefined()
    })
  })

  describe('fetchOracleSnapshot', () => {
    function clientReturning(prices: Record<string, number>) {
      return {
        getSnapshot: jest.fn(async (symbols: string[]) =>
          Object.fromEntries(
            symbols.map(symbol => [symbol, { price: prices[symbol] ?? 0 }]),
          ),
        ),
      } as unknown as PriceFeedsClient
    }

    it('asks for a market price for every asset in the table, including MON, HYPE, BTC, BCH and DOGE', async () => {
      const client = clientReturning({})
      await fetchOracleSnapshot(undefined, 1000, client)
      const asked = (client.getSnapshot as jest.Mock).mock.calls[0][0]
      expect(asked.sort()).toEqual(
        ['BCH', 'BTC', 'DOGE', 'ETH', 'HYPE', 'MON', 'SOL', 'XEC'].sort(),
      )
      expect(ASSET_FEED_SYMBOLS.tempo).toBeUndefined()
    })

    it('states each fetched price in AVU by dividing by the one AVU rate', async () => {
      const snapshot = await fetchOracleSnapshot(
        undefined,
        1000,
        clientReturning({ SOL: 110, MON: 0.025, BTC: 82000 }),
      )
      expect(snapshot.prices).toEqual({
        solana: 110,
        monad: 0.025,
        bitcoin: 82000,
      })
      expect(snapshot.rates.solana).toBeCloseTo(
        110 / POW_BASELINE_DOLLARS_PER_KWH,
        6,
      )
      expect(snapshot.rates.monad).toBeCloseTo(
        0.025 / POW_BASELINE_DOLLARS_PER_KWH,
        6,
      )
      expect(snapshot.fetchedAt.solana).toBe(snapshot.timestamp)
      // Any two coins compare through the unit: the ratio of rates is the ratio of prices.
      expect(snapshot.rates.bitcoin! / snapshot.rates.solana!).toBeCloseTo(
        82000 / 110,
        6,
      )
    })

    it('gives an asset whose price did not come back no rate at all', async () => {
      const snapshot = await fetchOracleSnapshot(
        undefined,
        1000,
        clientReturning({ SOL: 110 }),
      )
      expect(Object.keys(snapshot.rates)).toEqual(['solana'])
      expect(snapshot.rates.monad).toBeUndefined()
      expect(snapshot.prices.ethereum).toBeUndefined()
    })

    it('has no prices when the fetch fails: a failure is never a default price', async () => {
      const failing = {
        getSnapshot: jest.fn().mockRejectedValue(new Error('offline')),
      } as unknown as PriceFeedsClient
      const snapshot = await fetchOracleSnapshot(undefined, 1000, failing)
      expect(snapshot).toMatchObject(unavailableOracleSnapshot())
      expect(snapshot.rates).toEqual({})
    })

    it('has no prices when every provider request fails over HTTP', async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error('network down'))
      const snapshot = await fetchOracleSnapshot(
        fetchFn as unknown as typeof fetch,
        500,
      )
      expect(fetchFn).toHaveBeenCalled()
      expect(snapshot.prices).toEqual({})
      expect(snapshot.rates).toEqual({})
    })
  })
})
