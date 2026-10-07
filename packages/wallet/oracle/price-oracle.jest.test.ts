import {
  computeEnergyBasketIndex,
  calculateAvuRate,
  convertRawToAvu,
  formatAvu,
  calculateSwapParity,
  getDefaultOracleSnapshot,
  fetchOracleSnapshot,
  PYTH_FEED_IDS,
} from './index'

describe('Energy Basket & Price Oracle (@frank/wallet/oracle)', () => {
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

  describe('calculateAvuRate', () => {
    it('calculates AVU conversion rate using baseline anchor factor 1.25', () => {
      // 1 AVU = $1.25 when basket index is 1.0
      // An asset at $3.75 should equal 3.0 AVU
      expect(calculateAvuRate(3.75, 1.0)).toBeCloseTo(3.0, 4)
    })

    it('returns 0 for non-positive spot price or index', () => {
      expect(calculateAvuRate(0, 1.0)).toBe(0)
      expect(calculateAvuRate(100, 0)).toBe(0)
    })
  })

  describe('convertRawToAvu', () => {
    it('converts Monad 18 decimals correctly', () => {
      // 1 MON = 10^18 wei, default rate = 2.80 AVU
      const oneMon = 1_000_000_000_000_000_000n
      expect(convertRawToAvu(oneMon, 'monad')).toBeCloseTo(2.8, 4)

      // 5 MON = 14.0 AVU
      expect(convertRawToAvu(5n * oneMon, 'monad')).toBeCloseTo(14.0, 4)
    })

    it('converts eCash 2 decimals correctly', () => {
      // 1 XEC = 100 satoshis. Default rate = 0.000028 AVU
      // 1,000,000 XEC = 100,000,000 satoshis -> 28.0 AVU
      const oneMillionXecSat = 100_000_000n
      expect(convertRawToAvu(oneMillionXecSat, 'ecash')).toBeCloseTo(28.0, 4)
    })

    it('converts Solana 9 decimals correctly', () => {
      // 1 SOL = 10^9 lamports. Default rate = 120.0 AVU
      const oneSol = 1_000_000_000n
      expect(convertRawToAvu(oneSol, 'solana')).toBeCloseTo(120.0, 4)
      expect(convertRawToAvu(oneSol / 2n, 'solana')).toBeCloseTo(60.0, 4)
    })

    it('converts Tempo USD 6 decimals correctly', () => {
      // 1 USD = 10^6 micro-dollars. Default rate = 0.80 AVU
      const tenUsd = 10_000_000n
      expect(convertRawToAvu(tenUsd, 'tempo')).toBeCloseTo(8.0, 4)
    })

    it('converts Ethereum 18 decimals correctly', () => {
      // 1 ETH = 10^18 wei. Default rate = 2,080.0 AVU
      const oneEth = 1_000_000_000_000_000_000n
      expect(convertRawToAvu(oneEth, 'ethereum')).toBeCloseTo(2080.0, 4)
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
      // Send 10 MON (28 AVU) and receive ~28 AVU
      const tenMon = 10n * 10n ** 18n
      const oneMillionXec = 100_000_000n // 28 AVU

      const res = calculateSwapParity(tenMon, 'monad', oneMillionXec, 'ecash')
      expect(res.status).toBe('fair')
      expect(res.parityPercent).toBeCloseTo(0, 1)
    })

    it('returns premium when receiving more value than sending', () => {
      const tenMon = 10n * 10n ** 18n // 28 AVU
      const onePointTwoMillionXec = 120_000_000n // 33.6 AVU (+20%)

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
      const tenMon = 10n * 10n ** 18n // 28 AVU
      const nineHundredK = 90_000_000n // 25.2 AVU (-10%)

      const res = calculateSwapParity(tenMon, 'monad', nineHundredK, 'ecash')
      expect(res.status).toBe('discount')
      expect(res.parityPercent).toBeCloseTo(-10.0, 1)
    })

    it('returns warning when receiving significantly less value (> 20% disparity)', () => {
      const tenMon = 10n * 10n ** 18n // 28 AVU
      const halfMillionXec = 50_000_000n // 14 AVU (-50%)

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
      expect(snapshot.epoch).toBe('energy-basket-v1')
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
