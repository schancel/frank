import {
  computeEnergyBasketIndex,
  calculateAvuRate,
  convertRawToAvu,
  formatAvu,
  calculateSwapParity,
  getDefaultOracleSnapshot,
  fetchOracleSnapshot,
  PYTH_FEED_IDS,
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
    it('converts Monad 18 decimals correctly', () => {
      // 1 MON = $3.50. At 11.90476 AVU/$, 1 MON ≈ 41.67 AVU
      const oneMon = 1_000_000_000_000_000_000n
      expect(convertRawToAvu(oneMon, 'monad')).toBeCloseTo(
        3.5 * AVU_PER_DOLLAR,
        2,
      )

      // 5 MON ≈ 208.33 AVU
      expect(convertRawToAvu(5n * oneMon, 'monad')).toBeCloseTo(
        5 * 3.5 * AVU_PER_DOLLAR,
        2,
      )
    })

    it('converts eCash 2 decimals correctly', () => {
      // 1 XEC = 100 satoshis. Default spot = $0.000035
      // 1,000,000 XEC = $35 -> 35 * 11.90476 ≈ 416.67 AVU
      const oneMillionXecSat = 100_000_000n
      expect(convertRawToAvu(oneMillionXecSat, 'ecash')).toBeCloseTo(
        35.0 * AVU_PER_DOLLAR,
        2,
      )
    })

    it('converts Solana 9 decimals correctly', () => {
      // 1 SOL = $150. 150 * 11.90476 ≈ 1,785.71 AVU
      const oneSol = 1_000_000_000n
      expect(convertRawToAvu(oneSol, 'solana')).toBeCloseTo(
        150.0 * AVU_PER_DOLLAR,
        2,
      )
      expect(convertRawToAvu(oneSol / 2n, 'solana')).toBeCloseTo(
        75.0 * AVU_PER_DOLLAR,
        2,
      )
    })

    it('converts Tempo USD 6 decimals correctly', () => {
      // 1 USD = 10^6 micro-dollars. $10 * 11.90476 ≈ 119.05 AVU
      const tenUsd = 10_000_000n
      expect(convertRawToAvu(tenUsd, 'tempo')).toBeCloseTo(
        10.0 * AVU_PER_DOLLAR,
        2,
      )
    })

    it('converts Ethereum 18 decimals correctly', () => {
      // 1 ETH = $2600. 2600 * 11.90476 ≈ 30,952.38 AVU
      const oneEth = 1_000_000_000_000_000_000n
      expect(convertRawToAvu(oneEth, 'ethereum')).toBeCloseTo(
        2600.0 * AVU_PER_DOLLAR,
        2,
      )
    })

    it('returns 0 for null, undefined, or 0n amounts', () => {
      expect(convertRawToAvu(null, 'monad')).toBe(0)
      expect(convertRawToAvu(undefined, 'solana')).toBe(0)
      expect(convertRawToAvu(0n, 'ethereum')).toBe(0)
    })
  })

  describe('formatAvu', () => {
    it('formats 0 and negatives cleanly', () => {
      expect(formatAvu(0)).toBe('0 AVU')
      expect(formatAvu(-5)).toBe('0 AVU')
    })

    it('formats small fractions below 0.01 as < 0.01 AVU', () => {
      expect(formatAvu(0.004)).toBe('< 0.01 AVU')
    })

    it('formats ordinary values with 2 decimals', () => {
      expect(formatAvu(42.856)).toBe('42.86 AVU')
      expect(formatAvu(3.1)).toBe('3.10 AVU')
    })

    it('formats large values with thousands separators', () => {
      expect(formatAvu(1250.4)).toBe('1,250.4 AVU')
    })
  })

  describe('calculateSwapParity', () => {
    it('returns fair for equal value swaps', () => {
      // Send 10 MON ($35 = ~416.7 AVU) and receive 1M XEC ($35 = ~416.7 AVU)
      const tenMon = 10n * 10n ** 18n
      const oneMillionXec = 100_000_000n

      const res = calculateSwapParity(tenMon, 'monad', oneMillionXec, 'ecash')
      expect(res.status).toBe('fair')
      expect(res.parityPercent).toBeCloseTo(0, 1)
    })

    it('returns premium when receiving more value than sending', () => {
      const tenMon = 10n * 10n ** 18n // $35
      const onePointTwoMillionXec = 120_000_000n // $42 (+20%)

      const res = calculateSwapParity(
        tenMon,
        'monad',
        onePointTwoMillionXec,
        'ecash',
      )
      expect(res.status).toBe('premium')
      expect(res.parityPercent).toBeCloseTo(20.0, 1)
    })

    it('returns discount when receiving slightly less value', () => {
      const tenMon = 10n * 10n ** 18n // $35
      const nineHundredK = 90_000_000n // $31.50 (-10%)

      const res = calculateSwapParity(tenMon, 'monad', nineHundredK, 'ecash')
      expect(res.status).toBe('discount')
      expect(res.parityPercent).toBeCloseTo(-10.0, 1)
    })

    it('returns warning when receiving significantly less value (> 20% disparity)', () => {
      const tenMon = 10n * 10n ** 18n // $35
      const halfMillionXec = 50_000_000n // $17.50 (-50%)

      const res = calculateSwapParity(tenMon, 'monad', halfMillionXec, 'ecash')
      expect(res.status).toBe('warning')
      expect(res.parityPercent).toBeCloseTo(-50.0, 1)
    })
  })

  describe('fetchOracleSnapshot', () => {
    it('parses valid Pyth Hermes response into OracleSnapshot', async () => {
      const mockFetch: any = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          parsed: [
            {
              id: PYTH_FEED_IDS.gold,
              price: { price: '270000000000', expo: -8 }, // 2700.00
            },
            {
              id: PYTH_FEED_IDS.brent,
              price: { price: '8000000000', expo: -8 }, // 80.00
            },
            {
              id: PYTH_FEED_IDS.solana,
              price: { price: '16000000000', expo: -8 }, // 160.00
            },
            {
              id: PYTH_FEED_IDS.ethereum,
              price: { price: '280000000000', expo: -8 }, // 2800.00
            },
          ],
        }),
      })

      const snapshot = await fetchOracleSnapshot(mockFetch)
      expect(snapshot.rates.solana).toBeGreaterThan(0)
      expect(snapshot.rates.ethereum).toBeGreaterThan(0)
      expect(snapshot.basketIndex).toBeGreaterThan(0)
      expect(snapshot.epoch).toBe('pow-energy-standard-v1')
    })

    it('falls back gracefully to default snapshot when fetch fails', async () => {
      const mockFailFetch: any = jest
        .fn()
        .mockRejectedValue(new Error('Network error'))
      const snapshot = await fetchOracleSnapshot(mockFailFetch)
      const def = getDefaultOracleSnapshot()
      expect(snapshot.epoch).toBe(def.epoch)
      expect(snapshot.rates.monad).toBeCloseTo(def.rates.monad, 4)
      expect(snapshot.rates.solana).toBeCloseTo(def.rates.solana, 4)
    })
  })
})
