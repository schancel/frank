import {
  CHAIN_STATS_REFRESH_INTERVAL_MS,
  DIRECT_ASSETS,
  DIRECT_BASKET,
  ELECTRICITY_AGGREGATE,
  at,
  bundledFeed,
  bundledSeries,
  directLatestFeed,
  hashesPerKwh,
  multiplySeries,
  parseOracleFeed,
  resetDirectFeedCache,
  type MiningStats,
} from '../src'

const seconds = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000

describe('the basket the adapter declares', () => {
  it('has five entries: Litecoin and Dogecoin are one, and Monero has no 2^32 factor', () => {
    expect(DIRECT_BASKET.entries.map(entry => entry.id)).toEqual([
      'bitcoin',
      'bitcoin-cash',
      'ecash',
      'scrypt',
      'monero',
    ])
    const scrypt = DIRECT_BASKET.entries[3]
    expect(scrypt.chains.map(chain => chain.chain)).toEqual([
      'ltc-mainnet',
      'doge-mainnet',
    ])
    expect(scrypt.chains.every(c => c.hashesPerDifficulty === 2 ** 32)).toBe(true)
    expect(DIRECT_BASKET.entries[4].chains).toEqual([
      { chain: 'xmr-mainnet', hashesPerDifficulty: 1 },
    ])
    expect(DIRECT_BASKET.weightCap).toEqual({ entry: 'bitcoin', max: 0.6 })
  })
})

describe('stepped efficiency, looked up by date', () => {
  const scrypt = bundledSeries()['efficiency/scrypt']
  const randomx = bundledSeries()['efficiency/randomx']

  it('lands on the machine on sale at each date', () => {
    // Antminer L3+ until the L7 of November 2021, the L9 from May 2024.
    expect(at(scrypt.points, seconds('2020-06-15'))?.[1]).toBeCloseTo(
      hashesPerKwh(504e6, 800),
      -3,
    )
    expect(at(scrypt.points, seconds('2021-10-31'))?.[1]).toBeCloseTo(
      hashesPerKwh(504e6, 800),
      -3,
    )
    expect(at(scrypt.points, seconds('2021-11-01'))?.[1]).toBeCloseTo(
      hashesPerKwh(9.5e9, 3425),
      -3,
    )
    expect(at(scrypt.points, seconds('2024-12-01'))?.[1]).toBeCloseTo(
      hashesPerKwh(16e9, 3360),
      -3,
    )
  })

  it('has no value before the first step: nothing is extended backwards', () => {
    expect(at(scrypt.points, seconds('2017-05-31'))).toBeUndefined()
    expect(at(randomx.points, seconds('2019-11-29'))).toBeUndefined()
  })

  it('marks the RandomX steps before the first ASIC as estimates', () => {
    expect(randomx.estimatedBefore).toBe(seconds('2023-09-01'))
    expect(at(randomx.points, seconds('2020-01-01'))?.[1]).toBeCloseTo(
      hashesPerKwh(18379, 142),
      0,
    )
    expect(at(randomx.points, seconds('2026-10-10'))?.[1]).toBeCloseTo(
      hashesPerKwh(212000, 1350),
      0,
    )
    expect(scrypt.estimatedBefore).toBeUndefined()
  })
})

describe('the dated miner share', () => {
  it('makes the block reward the share in force at each date times the subsidy', () => {
    // A subsidy of 6.25M XEC a block all along, with eCash's two steps.
    const reward = multiplySeries(
      [[seconds('2020-12-01'), 6_250_000]],
      [
        [0, 1],
        [seconds('2020-11-15'), 0.92],
        [seconds('2023-11-15'), 0.58],
      ],
    )
    expect(at(reward, seconds('2021-06-01'))?.[1]).toBeCloseTo(5_750_000, 6)
    expect(at(reward, seconds('2023-11-14'))?.[1]).toBeCloseTo(5_750_000, 6)
    // The step lands on its own date, not at the next monthly point.
    expect(at(reward, seconds('2023-11-15'))?.[1]).toBeCloseTo(3_625_000, 6)
    expect(at(reward, seconds('2026-01-01'))?.[1]).toBeCloseTo(3_625_000, 6)
    // No subsidy known yet: no reward, whatever the share.
    expect(at(reward, seconds('2020-11-20'))).toBeUndefined()
  })

  it('is applied to the bundled eCash history', () => {
    const all = bundledSeries()
    const reward = all['blockReward/xec-mainnet']
    const before = at(reward.points, seconds('2023-11-14'))![1]
    const after = at(reward.points, seconds('2023-11-15'))![1]
    expect(after / before).toBeCloseTo(0.58 / 0.92, 6)
  })
})

describe('a range answer from the bundled history', () => {
  it('is a valid feed, one point per step, with the floor point in front', () => {
    const since = seconds('2024-01-10')
    const until = seconds('2024-06-10')
    const feed = bundledFeed({ since, until, step: 30 * 86_400 }, 0)
    expect(parseOracleFeed(JSON.parse(JSON.stringify(feed)))).toBeDefined()
    const prices = feed.series['price/btc-mainnet'].points
    // January's monthly point (stamped 1 January) is the floor at 10 January.
    expect(prices[0][0]).toBe(seconds('2024-01-01'))
    expect(prices[prices.length - 1][0]).toBe(seconds('2024-06-01'))
    // The electricity window before the start comes with it.
    const electricity = feed.series[ELECTRICITY_AGGREGATE].points
    expect(electricity[0][0]).toBeLessThan(since)
    expect(electricity[0][0]).toBeGreaterThan(since - 31 * 86_400)
  })
})

describe('the latest answer, filled directly', () => {
  const NOW = Date.parse('2026-10-10T17:00:00Z')
  const stats = (chain: string): MiningStats => ({
    chain,
    subsidyCoinsPerBlock: chain === 'ecash' ? 3_125_000 : 6.25,
    difficulty: 1000,
    hashesPerBlock: 1000,
    circulatingCoins: 1_000_000,
    fetchedAt: NOW,
  })
  const everyPrice = async (symbols: string[]) =>
    Object.fromEntries(symbols.map(symbol => [symbol, 10]))

  beforeEach(() => resetDirectFeedCache())

  it('carries one live point per series, and the miner’s part of the eCash reward', async () => {
    const feed = await directLatestFeed({
      now: () => NOW,
      fetchPrices: everyPrice,
      fetchStats: async chain => stats(chain),
    })
    expect(parseOracleFeed(JSON.parse(JSON.stringify(feed)))).toBeDefined()
    const t = NOW / 1000
    for (const asset of Object.keys(DIRECT_ASSETS)) {
      expect(feed.series[`price/${asset}`]).toMatchObject({
        stale: false,
        points: [[t, 10]],
      })
    }
    expect(feed.series['marketCap/ltc-mainnet'].points).toEqual([[t, 10_000_000]])
    expect(feed.series['difficulty/xmr-mainnet'].points).toEqual([[t, 1000]])
    // 58% of 3,125,000 XEC.
    expect(feed.series['blockReward/xec-mainnet'].points[0][1]).toBeCloseTo(
      1_812_500,
      6,
    )
    expect(feed.series['blockReward/ltc-mainnet'].points).toEqual([[t, 6.25]])
    // A lookup at the feed's own time finds every point of it.
    expect(feed.generatedAt).toBe(t)
    // The efficiency step in force, and the electricity window.
    expect(feed.series['efficiency/scrypt'].points).toHaveLength(1)
    expect(feed.series[ELECTRICITY_AGGREGATE].points.length).toBeGreaterThan(10)
    expect(feed.series[ELECTRICITY_AGGREGATE].points.length).toBeLessThanOrEqual(30)
  })

  it('leaves the last bundled value, old and marked stale, where nothing could be fetched', async () => {
    const feed = await directLatestFeed({
      now: () => NOW,
      fetchPrices: async () => ({}),
      fetchStats: async () => null,
    })
    const price = feed.series['price/btc-mainnet']
    expect(price.stale).toBe(true)
    expect(price.points).toHaveLength(1)
    // The gap: the bundled history ends with September 2026's monthly point.
    expect(price.points[0][0]).toBe(seconds('2026-09-01'))
    expect(feed.series['difficulty/ltc-mainnet'].stale).toBe(true)
    // A coin with no bundled history and no fetched price is simply absent.
    expect(feed.series['price/monad-mainnet']).toBeUndefined()
  })

  it('asks for chain statistics once an hour, however often it is called', async () => {
    let clock = NOW
    const fetchStats = jest.fn(async (chain: string) => ({
      ...stats(chain),
      fetchedAt: clock,
    }))
    const options = { now: () => clock, fetchPrices: everyPrice, fetchStats }
    await directLatestFeed(options)
    expect(fetchStats).toHaveBeenCalledTimes(6)
    clock += 10 * 60 * 1000
    await directLatestFeed(options)
    clock += 40 * 60 * 1000
    await directLatestFeed(options)
    expect(fetchStats).toHaveBeenCalledTimes(6)
    clock += CHAIN_STATS_REFRESH_INTERVAL_MS
    await directLatestFeed(options)
    expect(fetchStats).toHaveBeenCalledTimes(12)
  })
})
