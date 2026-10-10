import {
  avuHashAt,
  avuPerCoin,
  avuSpotAt,
  basketWeights,
  type OracleInputs,
} from './energy-basket'
import {
  DIRECT_BASKET,
  DIRECT_ELECTRICITY,
  bundledSeries,
  type SeriesPoint,
} from '@frank/price-feeds'

const T = 1_000_000
const TWO_32 = 2 ** 32

/** A feed whose every series has one point, at T - 10. */
function inputsOf(
  chains: Record<
    string,
    { price: number; reward: number; difficulty: number; cap: number }
  >,
  efficiency: Record<string, number>,
): OracleInputs {
  const one = (value: number): { points: SeriesPoint[] } => ({
    points: [[T - 10, value]],
  })
  const series: OracleInputs['series'] = {}
  for (const [chain, facts] of Object.entries(chains)) {
    series[`price/${chain}`] = one(facts.price)
    series[`blockReward/${chain}`] = one(facts.reward)
    series[`difficulty/${chain}`] = one(facts.difficulty)
    series[`marketCap/${chain}`] = one(facts.cap)
  }
  for (const [algorithm, value] of Object.entries(efficiency)) {
    series[`efficiency/${algorithm}`] = one(value)
  }
  return { basket: DIRECT_BASKET, electricity: DIRECT_ELECTRICITY, series }
}

const FIVE = {
  'btc-mainnet': { price: 80_000, reward: 3.125, difficulty: 1.3e14, cap: 1.6e12 },
  'bch-mainnet': { price: 300, reward: 3.125, difficulty: 5e11, cap: 6e9 },
  'xec-mainnet': { price: 0.00001, reward: 1_812_500, difficulty: 6e9, cap: 2e8 },
  'ltc-mainnet': { price: 60, reward: 6.25, difficulty: 9e7, cap: 4.6e9 },
  'doge-mainnet': { price: 0.09, reward: 10_000, difficulty: 3.8e7, cap: 1.4e10 },
  'xmr-mainnet': { price: 500, reward: 0.6, difficulty: 7.4e11, cap: 9.4e9 },
}
const EFFICIENCY = { sha256: 1.9e17, scrypt: 2.4e13, randomx: 5.65e8 }

describe('the merge-mined scrypt entry', () => {
  it('earns the SUM of Litecoin’s and Dogecoin’s pay for the same hashes', () => {
    const hash = avuHashAt(inputsOf(FIVE, EFFICIENCY), T)!
    const scrypt = hash.entries.find(entry => entry.id === 'scrypt')!
    const ltc = (60 * 6.25) / (9e7 * TWO_32)
    const doge = (0.09 * 10_000) / (3.8e7 * TWO_32)
    expect(scrypt.valuePerKwh).toBeCloseTo((ltc + doge) * 2.4e13, 12)
    // Its inverse in AVU_hash is 1 over that sum, not a sum of two inverses.
    expect(scrypt.kwhPerValue).toBeCloseTo(1 / ((ltc + doge) * 2.4e13), 9)
    // Dogecoin alone would be less: the sum matters.
    expect(scrypt.valuePerKwh).toBeGreaterThan(doge * 2.4e13)
  })

  it('weighs in at the SUM of the two market capitalisations', () => {
    const hash = avuHashAt(inputsOf(FIVE, EFFICIENCY), T)!
    expect(hash.entries.find(entry => entry.id === 'scrypt')!.marketCap).toBe(
      4.6e9 + 1.4e10,
    )
  })

  it('is left out whole when either chain lacks an input', () => {
    const { 'doge-mainnet': _doge, ...withoutDoge } = FIVE
    const hash = avuHashAt(inputsOf(withoutDoge, EFFICIENCY), T)!
    expect(hash.entries.map(entry => entry.id)).not.toContain('scrypt')
    expect(hash.leftOut).toEqual([
      { id: 'scrypt', label: 'LTC+DOGE', reason: 'price' },
    ])
    expect(hash.entries).toHaveLength(4)
    expect(hash.basketSize).toBe(5)
  })

  /*
   * Hand check against the bundled history, September 2026 (the monthly values in
   * mined-chains-monthly.json; hardware in force: Bitdeer SealMiner DL1 Air, 25 GH/s at
   * 3,725 W, from May 2026):
   *
   *   hashes per kWh = 25e9 H/s x 3600 s / 3.725 kWh          = 2.41610738e13
   *   LTC:  59.1175 $ x 6.250017 LTC / (90,945,389.9 x 2^32)  = 9.459250e-16 $/hash
   *   DOGE: 0.09027908 $ x 10,000 DOGE / (38,389,625.4 x 2^32) = 5.475369e-15 $/hash
   *   sum                                                     = 6.421294e-15 $/hash
   *   x 2.41610738e13 hashes/kWh                              = 0.155145 $/kWh
   *   inverse                                                 = 6.4456 kWh/$
   *   market cap: 59.1175 x 77,665,310.8 + 0.09027908 x 156,136,356,000
   *             = 4.5914e9 + 1.40958e10                       = 1.86872e10 $
   */
  it('matches the hand computation for September 2026', () => {
    const inputs: OracleInputs = {
      basket: DIRECT_BASKET,
      electricity: DIRECT_ELECTRICITY,
      series: bundledSeries(),
    }
    const hash = avuHashAt(inputs, Date.UTC(2026, 8, 15) / 1000)!
    const scrypt = hash.entries.find(entry => entry.id === 'scrypt')!
    expect(scrypt.valuePerKwh).toBeCloseTo(0.155145, 5)
    expect(scrypt.kwhPerValue).toBeCloseTo(6.4456, 3)
    expect(scrypt.marketCap / 1e10).toBeCloseTo(1.86872, 4)
  })
})

describe('the RandomX entry', () => {
  it('takes the difficulty itself as the expected hashes per block: no 2^32', () => {
    const hash = avuHashAt(inputsOf(FIVE, EFFICIENCY), T)!
    const monero = hash.entries.find(entry => entry.id === 'monero')!
    expect(monero.valuePerKwh).toBeCloseTo(((500 * 0.6) / 7.4e11) * 5.65e8, 12)
    // With Bitcoin's rule it would be 2^32 times smaller.
    expect(monero.valuePerKwh / (((500 * 0.6) / (7.4e11 * TWO_32)) * 5.65e8)).toBeCloseTo(
      TWO_32,
      0,
    )
  })

  /*
   * Hand check against the bundled history, September 2026 (hardware in force: Bitmain
   * Antminer X5, 212 kH/s at 1,350 W, from September 2023):
   *
   *   hashes per kWh = 212,000 H/s x 3600 s / 1.35 kWh   = 5.65333333e8
   *   535.985 $ x 0.6 XMR / 736,247,623,000 hashes       = 4.367973e-10 $/hash
   *   x 5.65333333e8 hashes/kWh                          = 0.246936 $/kWh
   *   inverse                                            = 4.0496 kWh/$
   */
  it('matches the hand computation for September 2026', () => {
    const inputs: OracleInputs = {
      basket: DIRECT_BASKET,
      electricity: DIRECT_ELECTRICITY,
      series: bundledSeries(),
    }
    const hash = avuHashAt(inputs, Date.UTC(2026, 8, 15) / 1000)!
    const monero = hash.entries.find(entry => entry.id === 'monero')!
    expect(monero.valuePerKwh).toBeCloseTo(0.246936, 5)
    expect(monero.kwhPerValue).toBeCloseTo(4.0496, 3)
    expect(monero.estimated).toBe(false)
  })

  it('says when its efficiency figure is an estimate (the processors before the ASIC)', () => {
    const inputs: OracleInputs = {
      basket: DIRECT_BASKET,
      electricity: DIRECT_ELECTRICITY,
      series: bundledSeries(),
    }
    const hash = avuHashAt(inputs, Date.UTC(2021, 5, 15) / 1000)!
    expect(hash.entries.find(entry => entry.id === 'monero')!.estimated).toBe(true)
    expect(hash.entries.find(entry => entry.id === 'bitcoin')!.estimated).toBe(false)
  })
})

describe('the five-entry basket', () => {
  it('caps Bitcoin at 60% and shares the rest by market capitalisation', () => {
    const hash = avuHashAt(inputsOf(FIVE, EFFICIENCY), T)!
    expect(hash.entries.map(entry => entry.id)).toEqual([
      'bitcoin',
      'bitcoin-cash',
      'ecash',
      'scrypt',
      'monero',
    ])
    const weight = (id: string) => hash.entries.find(e => e.id === id)!.weight
    // Others: 6e9 + 2e8 + 1.86e10 + 9.4e9 = 3.42e10.
    expect(weight('bitcoin')).toBe(0.6)
    expect(weight('bitcoin-cash')).toBeCloseTo((0.4 * 6e9) / 3.42e10, 12)
    expect(weight('ecash')).toBeCloseTo((0.4 * 2e8) / 3.42e10, 12)
    expect(weight('scrypt')).toBeCloseTo((0.4 * 1.86e10) / 3.42e10, 12)
    expect(weight('monero')).toBeCloseTo((0.4 * 9.4e9) / 3.42e10, 12)
    expect(hash.entries.reduce((sum, e) => sum + e.weight, 0)).toBeCloseTo(1, 12)
    // AVU_hash is the weighted average of the entries' inverses.
    expect(hash.kwhPerValue).toBeCloseTo(
      hash.entries.reduce((sum, e) => sum + e.weight / e.valuePerKwh, 0),
      12,
    )
    expect(hash.leftOut).toEqual([])
  })

  it('renormalises over what is available and says why each missing entry is missing', () => {
    const { 'xmr-mainnet': _xmr, ...rest } = FIVE
    const inputs = inputsOf(rest, { sha256: 1.9e17, randomx: 5.65e8 })
    // Bitcoin Cash has a price but no chain statistics.
    delete inputs.series['difficulty/bch-mainnet']
    const hash = avuHashAt(inputs, T)!
    expect(hash.entries.map(entry => entry.id)).toEqual(['bitcoin', 'ecash'])
    expect(hash.leftOut).toEqual([
      { id: 'bitcoin-cash', label: 'BCH', reason: 'chain' },
      { id: 'scrypt', label: 'LTC+DOGE', reason: 'efficiency' },
      { id: 'monero', label: 'XMR', reason: 'price' },
    ])
    expect(hash.basketSize).toBe(5)
    expect(hash.entries[0].weight).toBe(0.6)
    expect(hash.entries[1].weight).toBeCloseTo(0.4, 12)
  })

  it('gives Bitcoin the whole weight when it is alone, and nothing when nothing is known', () => {
    const { 'btc-mainnet': btc } = FIVE
    const alone = avuHashAt(inputsOf({ 'btc-mainnet': btc }, EFFICIENCY), T)!
    expect(alone.entries).toHaveLength(1)
    expect(alone.entries[0].weight).toBe(1)
    expect(avuHashAt(inputsOf({}, EFFICIENCY), T)).toBeUndefined()
  })

  it('does not apply the cap when Bitcoin is under it', () => {
    expect(basketWeights({ bitcoin: 50, other: 50 }, 0.6, 'bitcoin')).toEqual({
      bitcoin: 0.5,
      other: 0.5,
    })
  })
})

describe('one function for today and for history', () => {
  const inputs = inputsOf(FIVE, EFFICIENCY)

  it('has no value before the series begin', () => {
    expect(avuHashAt(inputs, T - 11)).toBeUndefined()
  })

  it('reads every series by floor lookup at the time asked about', () => {
    const later: OracleInputs = {
      ...inputs,
      series: {
        ...inputs.series,
        'price/btc-mainnet': {
          points: [
            [T - 10, 80_000],
            [T + 100, 160_000],
          ],
        },
      },
    }
    const before = avuHashAt(later, T + 99)!.entries[0].valuePerKwh
    const after = avuHashAt(later, T + 100)!.entries[0].valuePerKwh
    expect(after / before).toBeCloseTo(2, 12)
    // The age of the oldest reading used is reported with the result.
    expect(avuHashAt(later, T + 5000)!.oldestInputAt).toBe(T - 10)
  })

  it('values a coin at its price times AVU_hash', () => {
    const hash = avuHashAt(inputs, T)!
    expect(avuPerCoin(2, hash)).toBeCloseTo(2 * hash.kwhPerValue, 12)
    expect(avuPerCoin(2, undefined)).toBeUndefined()
    expect(avuPerCoin(0, hash)).toBeUndefined()
  })
})

describe('AVU_spot', () => {
  const DAY = 86_400
  const withPrices = (prices: number[]): OracleInputs => ({
    basket: DIRECT_BASKET,
    electricity: { windowDays: 30, regions: [] },
    series: {
      'electricity/aggregate': {
        points: prices.map((price, day) => [(day + 1) * DAY, price]),
      },
    },
  })

  it('averages the prices first and inverts the mean, zero and negative days included', () => {
    // (0.08 + 0 - 0.02 + 0.06) / 4 = 0.03 per kWh: 33.33 kWh per unit of value.
    const spot = avuSpotAt(withPrices([0.08, 0, -0.02, 0.06]), 4 * DAY)
    expect(spot.kwhPerValue).toBeCloseTo(1 / 0.03, 9)
    expect(spot).toMatchObject({ days: 4, latestAt: 4 * DAY })
    // Not the mean of the inverses (one of which would be a division by zero).
  })

  it('uses only the days of the window ending at the time asked about', () => {
    const prices = Array.from({ length: 40 }, (_, day) => (day < 10 ? 1 : 0.05))
    const spot = avuSpotAt(withPrices(prices), 40 * DAY)
    expect(spot.kwhPerValue).toBeCloseTo(20, 9)
    expect(spot).toMatchObject({ days: 30 })
  })

  it('is unavailable, with the reason, when the mean is not positive or there is no price', () => {
    expect(avuSpotAt(withPrices([0.01, -0.03]), 2 * DAY)).toEqual({
      unavailable: 'not-positive',
    })
    expect(avuSpotAt(withPrices([]), 2 * DAY)).toEqual({ unavailable: 'no-data' })
    expect(avuSpotAt(withPrices([0.05]), 100 * DAY)).toEqual({
      unavailable: 'no-data',
    })
  })
})
