/** @jest-environment jsdom */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level, { type LevelDB } from 'level'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { createStoragePlugin } from '../boot/pinia'
import {
  useOracleStore,
  useSafeOracleStore,
  formatUnitRate,
  formatAge,
  historyFeed,
  retryDelayMs,
} from './oracle'
import {
  FULL_RESOLUTION_MS,
  joinPriceSeries,
  thinOldObservations,
} from './oracle-series'
import * as oracleSdk from '@frank/wallet/oracle'

// The provider seam: no test here touches the network.
jest.mock('@frank/wallet/oracle', () => ({
  ...jest.requireActual('@frank/wallet/oracle'),
  fetchPrices: jest.fn(),
  fetchMiningStats: jest.fn(),
  fetchPriceHistory: jest.fn(),
}))

const fetchPrices = oracleSdk.fetchPrices as jest.Mock
const fetchMiningStats = oracleSdk.fetchMiningStats as jest.Mock
const fetchPriceHistory = oracleSdk.fetchPriceHistory as jest.Mock
const BTC_USD = 80_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const INTERVAL = oracleSdk.ORACLE_REFRESH_INTERVAL_MS
const ONE_SOL = 1_000_000_000n
const ONE_MON = 1_000_000_000_000_000_000n
const START = Date.UTC(2026, 9, 10, 12, 0, 0)

/**
 * Bitcoin chain statistics at which AVU_hash, computed by the real formula with the
 * bundled efficiency, comes to exactly `kwhPerDollar` when bitcoin is BTC_USD:
 * kWh/$ = hashes per block / (price x subsidy x hashes per kWh).
 */
function bitcoinStats(kwhPerDollar: number, fetchedAt = Date.now()) {
  const hashesPerKwh = oracleSdk.latestHashingEfficiency('sha256')!.hashesPerKwh
  const hashesPerBlock = kwhPerDollar * BTC_USD * 3.125 * hashesPerKwh
  return {
    chain: 'bitcoin',
    subsidyCoinsPerBlock: 3.125,
    difficulty: hashesPerBlock / 2 ** 32,
    hashesPerBlock,
    circulatingCoins: 20_000_000,
    fetchedAt,
  }
}

/** What the providers answer: these prices and bitcoin's, each from three providers. */
function market(prices: oracleSdk.UsdPrices) {
  return async () => ({
    timestamp: Date.now(),
    prices: Object.fromEntries(
      Object.entries({ ...prices, bitcoin: BTC_USD }).map(([asset, usd]) => [
        asset,
        {
          usd,
          sources: 3,
          providers: {
            kraken: usd * 0.999,
            coinbase: usd,
            coingecko: usd * 1.001,
          },
        },
      ]),
    ),
  })
}
const noPrices = async () => ({ timestamp: Date.now(), prices: {} })

/** Bitcoin's statistics arrive (AVU_hash = kwhPerDollar); the other chains' do not. */
function chains(kwhPerDollar: number | null = 12) {
  return async (chain: string) =>
    chain === 'bitcoin' && kwhPerDollar !== null
      ? bitcoinStats(kwhPerDollar)
      : null
}

const realSetTimeout = globalThis.setTimeout
const settle = () => jest.advanceTimersByTimeAsync(0)
const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms)
const miningCalls = (chain: string) =>
  fetchMiningStats.mock.calls.filter(call => call[0] === chain).length

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  // Level's own callbacks run on real ticks; only the clock and the timers are simulated.
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: START,
  })
  setActivePinia(createPinia())
  jest.resetAllMocks()
  fetchPrices.mockImplementation(market({ solana: 110.06 }))
  fetchMiningStats.mockImplementation(chains())
  fetchPriceHistory.mockResolvedValue({
    asset: 'SOL',
    range: '24h',
    provider: null,
    points: [],
  })
})

afterEach(() => {
  delete (document as Partial<Document>).hidden
  jest.useRealTimers()
})

describe('refresh policy: fetched only while shown, once per interval', () => {
  it('fetches nothing just because the store exists', async () => {
    const store = useOracleStore()
    await pass(6 * HOUR)
    expect(fetchPrices).not.toHaveBeenCalled()
    expect(fetchMiningStats).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
    expect(store.snapshot.prices).toEqual({})
    expect(store.rates).toEqual({})
    for (const asset of ['monad', 'solana', 'ethereum', 'ecash'] as const) {
      expect(store.formatUnitRate(asset)).toBe('')
      expect(store.formatAvuAmount(asset, 10n ** 20n)).toBe('')
      expect(store.getAvu(asset, 10n ** 20n)).toBe(0)
    }
  })

  it('two views showing prices at once share one request per series', async () => {
    const store = useOracleStore()
    const releaseList = store.acquire('live')
    const releaseChart = store.acquire('live')
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    for (const chain of oracleSdk.AVU_HASH_CHAINS) {
      expect(miningCalls(chain)).toBe(1)
    }
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 1,320.72 AVU')
    releaseList()
    releaseChart()
  })

  it('shares the request that is still under way with a view that opens meanwhile', async () => {
    let answer!: (value: unknown) => void
    fetchPrices.mockImplementation(
      () => new Promise(resolve => (answer = resolve)),
    )
    const store = useOracleStore()
    const first = store.acquire('live')
    await settle()
    const second = store.acquire('live')
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    answer(await market({ solana: 100 })())
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    expect(store.snapshot.prices.solana).toBe(100)
    first()
    second()
  })

  it('a view opened inside the interval is served from the cache, and the series is refetched once the interval has passed', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    await pass(INTERVAL - MINUTE)
    const another = store.acquire('live')
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    expect(miningCalls('bitcoin')).toBe(1)
    // Shown at once from the cache, with its age.
    expect(store.priceAgeMs('solana')).toBe(INTERVAL - MINUTE)

    await pass(MINUTE)
    expect(fetchPrices).toHaveBeenCalledTimes(2)
    expect(miningCalls('bitcoin')).toBe(2)
    await pass(HOUR)
    // One fetch per interval while shown: the first, and seven in 70 minutes.
    expect(fetchPrices).toHaveBeenCalledTimes(8)
    release()
    another()
  })

  it('stops entirely when the last view showing prices goes away', async () => {
    const store = useOracleStore()
    const releaseList = store.acquire('live')
    const releaseChart = store.acquire('live')
    await settle()
    releaseList()
    await pass(INTERVAL)
    expect(fetchPrices).toHaveBeenCalledTimes(2)

    releaseChart()
    releaseChart()
    expect(jest.getTimerCount()).toBe(0)
    await pass(12 * HOUR)
    expect(fetchPrices).toHaveBeenCalledTimes(2)
    expect(miningCalls('bitcoin')).toBe(2)
  })

  it('fetches nothing while the tab is hidden, and catches up when it is shown again', async () => {
    setHidden(true)
    const store = useOracleStore()
    const release = store.acquire('live')
    await pass(3 * HOUR)
    expect(fetchPrices).not.toHaveBeenCalled()
    expect(fetchMiningStats).not.toHaveBeenCalled()

    setHidden(false)
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    setHidden(true)
    await pass(3 * HOUR)
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    release()
  })

  it('a failed fetch keeps the last real price with its age and waits longer before each retry', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    expect(store.snapshot.prices.solana).toBe(110.06)

    // Every provider stops answering; once, the request itself throws.
    fetchPrices.mockImplementation(noPrices)
    fetchPrices.mockRejectedValueOnce(new Error('offline'))
    const attemptsAfter = async (minutes: number) => {
      await pass(START + minutes * MINUTE - Date.now())
      return fetchPrices.mock.calls.length - 1
    }
    // Tries at 10, 20, 40, 80, 160 and 320 minutes, then every 160 minutes.
    expect(await attemptsAfter(10)).toBe(1)
    expect(await attemptsAfter(19)).toBe(1)
    expect(await attemptsAfter(20)).toBe(2)
    expect(await attemptsAfter(39)).toBe(2)
    expect(await attemptsAfter(40)).toBe(3)
    expect(await attemptsAfter(80)).toBe(4)
    expect(await attemptsAfter(159)).toBe(4)
    expect(await attemptsAfter(160)).toBe(5)
    expect(await attemptsAfter(320)).toBe(6)
    expect(await attemptsAfter(479)).toBe(6)
    expect(await attemptsAfter(480)).toBe(7)

    // The last real observation is still what is shown, at its own time: never a default.
    expect(store.priceObservations).toHaveLength(1)
    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.snapshot.fetchedAt.solana).toBe(START)
    expect(store.priceAgeMs('solana')).toBe(480 * MINUTE)
    // (Bitcoin's statistics kept arriving, so only the price is stale.)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (8 h old)',
    )
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1,320.7 AVU (8 h old)',
    )

    // A fetch that succeeds returns the series to one interval.
    fetchPrices.mockImplementation(market({ solana: 120 }))
    expect(await attemptsAfter(640)).toBe(8)
    expect(await attemptsAfter(650)).toBe(9)
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 1,440.00 AVU')
    release()
  })

  it('states the back-off schedule', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(n => retryDelayMs(n) / MINUTE)).toEqual([
      10, 20, 40, 80, 160, 160, 160,
    ])
  })

  it('opening a view does not bypass the back-off of a series that is failing', async () => {
    fetchPrices.mockImplementation(noPrices)
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) store.acquire('live')()
    await pass(INTERVAL - MINUTE)
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    release()
  })

  it('keeps the last chain statistics when they stop arriving, and marks every value with their age once stale', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    fetchMiningStats.mockImplementation(chains(null))
    await pass(5 * HOUR)

    expect(store.miningObservations.bitcoin).toHaveLength(1)
    expect(store.snapshot.mining.bitcoin.fetchedAt).toBe(START)
    expect(store.avuHash?.kwhPerDollar).toBeCloseTo(12, 9)
    expect(store.avuHashStaleAgeMs()).toBe(5 * HOUR)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (5 h old)',
    )
    // Blockchair was asked on the back-off schedule, not every interval: 10, 20, 40, 80, 160.
    expect(miningCalls('bitcoin')).toBe(1 + 5)
    release()
  })
})

describe('the cache is a time series of what was fetched', () => {
  it('records every fetch: each provider’s answer and the median, per coin, and each chain’s statistics', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    fetchPrices.mockImplementation(market({ solana: 111, ecash: 7.2e-6 }))
    await pass(INTERVAL)
    release()

    expect(store.priceObservations.map(o => o.timestamp)).toEqual([
      START,
      START + INTERVAL,
    ])
    expect(store.priceObservations[0].prices.solana).toEqual({
      usd: 110.06,
      sources: 3,
      providers: {
        kraken: 110.06 * 0.999,
        coinbase: 110.06,
        coingecko: 110.06 * 1.001,
      },
    })
    expect(Object.keys(store.priceObservations[1].prices).sort()).toEqual([
      'bitcoin',
      'ecash',
      'solana',
    ])
    expect(store.miningObservations.bitcoin.map(s => s.fetchedAt)).toEqual([
      START,
      START + INTERVAL,
    ])
    expect(store.snapshot.priceSources.solana).toBe(3)
  })

  it('a coin whose price did not come back keeps its last observation and its time; others move on', async () => {
    fetchPrices.mockImplementation(market({ solana: 110.06, ethereum: 2496 }))
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    fetchPrices.mockImplementation(market({ ethereum: 2500 }))
    await pass(3 * HOUR)
    release()

    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.snapshot.fetchedAt.solana).toBe(START)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (3 h old)',
    )
    expect(store.formatUnitRate('ethereum')).toBe('1 ETH ≈ 30,000.00 AVU')
    expect(store.formatAvuAmount('ethereum', 10n ** 18n)).toBe('≈ 30,000 AVU')
    expect(store.formatUnitRate('hyperliquid')).toBe('')
    expect(store.formatUnitRate('tempo')).toBe('')
  })

  it('computes AVU from the cache alone: reading values never fetches', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    release()
    fetchPrices.mockClear()
    fetchMiningStats.mockClear()

    await pass(2 * DAY)
    expect(store.getAvu('solana', 2n * ONE_SOL)).toBeCloseTo(2 * 110.06 * 12, 6)
    expect(store.formatAvuAmount('solana', 2n * ONE_SOL)).toContain('AVU')
    expect(store.avuHash?.kwhPerDollar).toBeCloseTo(12, 9)
    expect(store.historyFor('solana', '7d').points).toHaveLength(1)
    expect(store.bitcoinAvuHashHistory('7d')).toEqual([
      { timestamp: START, kwhPerDollar: expect.closeTo(12, 9) },
    ])
    expect(fetchPrices).not.toHaveBeenCalled()
    expect(fetchMiningStats).not.toHaveBeenCalled()
    expect(fetchPriceHistory).not.toHaveBeenCalled()
  })

  it('has no constant in the path: every AVU value moves in step with the mining inputs', async () => {
    fetchPrices.mockImplementation(
      market({ solana: 110.06, ethereum: 2500, ecash: 7.2e-6 }),
    )
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    const before = { ...store.rates }
    // The same prices; twice the hashes per block means twice the kWh per dollar.
    fetchMiningStats.mockImplementation(chains(24))
    await pass(INTERVAL)
    release()
    expect(Object.keys(store.rates).sort()).toEqual(
      ['bitcoin', 'ecash', 'ethereum', 'solana'].sort(),
    )
    for (const asset of Object.keys(before) as oracleSdk.SupportedAsset[]) {
      expect(store.rates[asset]! / before[asset]!).toBeCloseTo(2, 9)
    }
  })

  it('shows no AVU value for anything while AVU_hash is unavailable: there is no fallback rate', async () => {
    fetchMiningStats.mockImplementation(chains(null))
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    release()
    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.avuHash).toBeUndefined()
    expect(store.rates).toEqual({})
    expect(store.formatUnitRate('solana')).toBe('')
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe('')
    expect(store.getAvu('solana', ONE_SOL)).toBe(0)
  })

  it('prices MON as mainnet MON and gives a testnet MON balance no value', async () => {
    fetchPrices.mockImplementation(market({ monad: 0.025 }))
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    release()
    expect(store.formatUnitRate('monad')).toBe(
      '1 MON ≈ 0.30 AVU (mainnet price; testnet coins have no market value)',
    )
    expect(store.getAvu('monad', 100n * ONE_MON)).toBe(0)
    expect(store.formatAvuAmount('monad', 100n * ONE_MON)).toBe('')
  })

  it('never reads the records the oracle kept in localStorage before', () => {
    const saved = JSON.stringify({
      timestamp: START,
      prices: { solana: 110.06, bitcoin: BTC_USD },
      fetchedAt: { solana: START, bitcoin: START },
      mining: { bitcoin: bitcoinStats(12) },
    })
    for (const key of ['v1', 'v2', 'v3']) {
      localStorage.setItem(`frank_oracle_snapshot_${key}`, saved)
    }
    setActivePinia(createPinia())
    const store = useOracleStore()
    expect(store.snapshot.prices).toEqual({})
    expect(store.rates).toEqual({})
    localStorage.clear()
  })
})

describe('retention', () => {
  it('keeps every observation for two weeks, then the first real one of each day, unchanged', () => {
    const now = START
    const observations = []
    for (let t = now - 40 * DAY; t <= now; t += 6 * HOUR) {
      observations.push({ timestamp: t, value: t / 1000 })
    }
    const kept = thinOldObservations(observations, o => o.timestamp, now)

    const recent = observations.filter(
      o => o.timestamp >= now - FULL_RESOLUTION_MS,
    )
    expect(kept.slice(-recent.length)).toEqual(recent)
    const old = kept.slice(0, -recent.length)
    // Four a day went in; one a day stays, and it is the first that day has.
    expect(old).toHaveLength(27)
    expect(new Set(old.map(o => Math.floor(o.timestamp / DAY))).size).toBe(27)
    expect(old[0]).toBe(observations[0])
    for (const observation of old.slice(1)) {
      expect(observation.timestamp % DAY).toBe(0)
    }
    // Kept observations are the very records that were fetched: none is averaged or moved.
    for (const observation of kept) {
      expect(observations).toContain(observation)
    }
    expect(thinOldObservations(kept, o => o.timestamp, now)).toEqual(kept)
  })

  it('is applied as observations are recorded, and nothing stops working at the bound', async () => {
    const store = useOracleStore()
    // Twenty days of ten-minute fetches already recorded, the last ten minutes ago.
    const recorded = []
    for (let t = START - 20 * DAY; t < START; t += INTERVAL) {
      recorded.push({ ...(await market({ solana: 100 })()), timestamp: t })
    }
    store.priceObservations = recorded
    const release = store.acquire('live')
    await settle()
    release()
    const full = FULL_RESOLUTION_MS / INTERVAL
    // Every observation of the last two weeks, and one for each of the seven days before.
    expect(store.priceObservations).toHaveLength(full + 1 + 7)
    expect(store.priceObservations[0]).toEqual(recorded[0])
    // What is kept are records exactly as fetched.
    const byTime = new Map(recorded.map(o => [o.timestamp, o]))
    for (const observation of store.priceObservations.slice(0, -1)) {
      expect(observation).toEqual(byTime.get(observation.timestamp))
    }
    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.priceAgeMs('solana')).toBe(0)
    expect(store.historyFor('solana', '30d').points).toHaveLength(21)
  })
})

describe('price history: the app’s own record, back-filled by a provider’s candles', () => {
  const hourStart = Math.floor(START / HOUR) * HOUR

  it('joins recorded prices with provider candles into one line with no duplicate times', () => {
    const candles = Array.from({ length: 24 }, (_, i) => ({
      timestamp: hourStart - (23 - i) * HOUR,
      price: 100 + i,
    }))
    const recorded = [
      // Two in the hour that began three hours ago: the later one stands for that hour.
      { timestamp: hourStart - 3 * HOUR + 5 * MINUTE, price: 201 },
      { timestamp: hourStart - 3 * HOUR + 15 * MINUTE, price: 202 },
      // At exactly a candle's time: only one point may carry that timestamp.
      { timestamp: hourStart - HOUR, price: 203 },
      { timestamp: hourStart + 20 * MINUTE, price: 204 },
    ]
    const joined = joinPriceSeries(recorded, candles, HOUR)

    const times = joined.points.map(p => p.timestamp)
    expect(new Set(times).size).toBe(times.length)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(joined.points).toHaveLength(24)
    expect(joined.recorded).toBe(3)
    // Every point is one of the inputs, untouched.
    for (const point of joined.points) {
      expect([...recorded, ...candles]).toContainEqual(point)
    }
    expect(joined.points.map(p => p.price).slice(-4)).toEqual([
      202, 121, 203, 204,
    ])
  })

  it('draws the short-range line from recorded observations, with candles only where it has none', async () => {
    fetchPriceHistory.mockImplementation(async () => ({
      asset: 'SOL',
      range: '24h',
      provider: 'kraken',
      points: Array.from({ length: 24 }, (_, i) => ({
        timestamp: hourStart - (23 - i) * HOUR,
        price: 100 + i,
      })),
    }))
    const store = useOracleStore()
    const releaseLive = store.acquire('live')
    const releaseHistory = store.acquire(historyFeed('solana', '24h'))
    const releaseOther = store.acquire(historyFeed('solana', '24h'))
    await settle()
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1)
    expect(fetchPriceHistory).toHaveBeenCalledWith('SOL', '24h')

    await pass(2 * INTERVAL)
    expect(fetchPriceHistory).toHaveBeenCalledTimes(3)
    releaseLive()
    releaseHistory()
    releaseOther()
    await pass(HOUR)
    expect(fetchPriceHistory).toHaveBeenCalledTimes(3)

    const history = store.historyFor('solana', '24h', START + 2 * INTERVAL)
    const times = history.points.map(p => p.timestamp)
    expect(new Set(times).size).toBe(times.length)
    // 23 hours of kraken candles, and this hour from the app's own three observations.
    expect(history.provider).toBe('kraken')
    expect(history.recorded).toBe(1)
    expect(history.points).toHaveLength(24)
    expect(history.points[23]).toEqual({
      timestamp: START + 2 * INTERVAL,
      price: 110.06,
    })
    expect(history.points[22]).toEqual({
      timestamp: hourStart - HOUR,
      price: 122,
    })
  })

  it('with no provider history shows only its own record inside the range, and asks again on the back-off schedule', async () => {
    fetchPrices.mockImplementation(market({ ecash: 7.3e-6 }))
    const store = useOracleStore()
    const releaseLive = store.acquire('live')
    const releaseHistory = store.acquire(historyFeed('ecash', '24h'))
    await pass(30 * HOUR)
    releaseLive()
    releaseHistory()

    const history = store.historyFor('ecash', '24h')
    expect(history.provider).toBeNull()
    expect(history.recorded).toBe(history.points.length)
    expect(history.points.length).toBeGreaterThanOrEqual(24)
    expect(history.points.length).toBeLessThanOrEqual(25)
    expect(history.points[0].timestamp).toBeGreaterThanOrEqual(Date.now() - DAY)
    // 0, 10, 20, 40, 80, 160 minutes, then every 160: not once per interval.
    expect(fetchPriceHistory.mock.calls.length).toBeLessThanOrEqual(6 + 11)
  }, 60_000)

  it('has no history for a coin with no price source, without asking anyone', async () => {
    const store = useOracleStore()
    const release = store.acquire(historyFeed('tempo', '7d'))
    await pass(HOUR)
    release()
    expect(fetchPriceHistory).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
    expect(store.historyFor('tempo', '7d')).toEqual({
      points: [],
      recorded: 0,
      provider: null,
    })
  })

  it('continues Bitcoin’s kWh per dollar from recorded prices and chain statistics only', async () => {
    const store = useOracleStore()
    const release = store.acquire('live')
    await settle()
    fetchMiningStats.mockImplementation(chains(24))
    await pass(HOUR)
    // Statistics stop arriving: a price with none recorded in the two hours before it has no point.
    fetchMiningStats.mockImplementation(chains(null))
    await pass(4 * HOUR)
    release()

    const line = store.bitcoinAvuHashHistory('24h')
    expect(line[0]).toEqual({
      timestamp: START + 50 * MINUTE,
      kwhPerDollar: expect.closeTo(24, 9),
    })
    expect(line[line.length - 1].timestamp).toBe(START + 3 * HOUR)
    expect(line.every(p => Math.abs(p.kwhPerDollar - 24) < 1e-9)).toBe(true)
  })
})

describe('the series persists on the device', () => {
  let directory: string
  let storage: LevelDB

  function open() {
    const pinia = createPinia()
    pinia.use(
      createStoragePlugin(
        storage,
        Promise.resolve({ networkName: 'test', version: 4 }),
      ),
    )
    createApp({}).use(pinia)
    setActivePinia(pinia)
    return useOracleStore()
  }

  async function keysOnDisk(): Promise<string[]> {
    const keys: string[] = []
    for await (const [key] of storage.iterator({ values: false })) {
      keys.push(key)
    }
    return keys
  }

  /** Lets real LevelDB reads and writes finish; the simulated clock does not move. */
  async function io() {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => realSetTimeout(resolve, 2))
      await settle()
    }
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'frank-oracle-series-'))
    storage = level(directory)
    await storage.open()
  })

  afterEach(async () => {
    await storage.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('observations survive a reload, are shown at once with their age, and the series goes on from them', async () => {
    fetchPriceHistory.mockImplementation(async () => ({
      asset: 'SOL',
      range: '24h',
      provider: 'kraken',
      points: [{ timestamp: START - 5 * HOUR, price: 105 }],
    }))
    const first = open()
    const releaseLive = first.acquire('live')
    const releaseHistory = first.acquire(historyFeed('solana', '24h'))
    await io()
    await pass(INTERVAL)
    await io()
    releaseLive()
    releaseHistory()
    await first.flushPersistence()
    expect(first.priceObservations).toHaveLength(2)
    expect(await keysOnDisk()).toEqual([
      'oracle:v1:candles:solana:24h',
      `oracle:v1:mining:bitcoin:00${START}`,
      `oracle:v1:mining:bitcoin:00${START + INTERVAL}`,
      `oracle:v1:price:00${START}`,
      `oracle:v1:price:00${START + INTERVAL}`,
    ])

    // The app is closed for four minutes and opened again.
    jest.setSystemTime(START + INTERVAL + 4 * MINUTE)
    fetchPrices.mockClear()
    fetchMiningStats.mockClear()
    fetchPriceHistory.mockClear()
    fetchPrices.mockImplementation(market({ solana: 120 }))
    const second = open()
    expect(await second.restored).toBe(true)
    expect(second.priceObservations).toEqual(first.priceObservations)
    expect(second.miningObservations).toEqual(first.miningObservations)
    expect(second.candles).toEqual(first.candles)
    // Shown from the cache before anything is fetched: the real price, four minutes old.
    expect(second.snapshot.prices.solana).toBe(110.06)
    expect(second.priceAgeMs('solana')).toBe(4 * MINUTE)
    expect(second.formatUnitRate('solana')).toBe('1 SOL ≈ 1,320.72 AVU')

    const release = second.acquire('live')
    const releaseChart = second.acquire(historyFeed('solana', '24h'))
    await io()
    // Fetched four minutes ago: nothing is asked for again yet.
    expect(fetchPrices).not.toHaveBeenCalled()
    expect(fetchMiningStats).not.toHaveBeenCalledWith('bitcoin')
    expect(fetchPriceHistory).not.toHaveBeenCalled()

    await pass(6 * MINUTE)
    await io()
    expect(fetchPrices).toHaveBeenCalledTimes(1)
    release()
    releaseChart()
    await second.flushPersistence()
    expect(second.priceObservations.map(o => o.timestamp)).toEqual([
      START,
      START + INTERVAL,
      START + 2 * INTERVAL,
    ])
    expect(second.snapshot.prices.solana).toBe(120)

    // A third opening reads all three, and the chart line is the record plus the candle.
    const third = open()
    await third.restored
    expect(third.priceObservations).toHaveLength(3)
    expect(third.historyFor('solana', '24h')).toEqual({
      points: [
        { timestamp: START - 5 * HOUR, price: 105 },
        { timestamp: START + 2 * INTERVAL, price: 120 },
      ],
      recorded: 1,
      provider: 'kraken',
    })
  })

  it('a fetch that fails after a reload leaves the restored observation in place', async () => {
    const first = open()
    const releaseFirst = first.acquire('live')
    await io()
    releaseFirst()
    await first.flushPersistence()

    jest.setSystemTime(START + 3 * HOUR)
    fetchPrices.mockImplementation(noPrices)
    fetchMiningStats.mockImplementation(chains(null))
    const second = open()
    const release = second.acquire('live')
    await io()
    release()
    await second.flushPersistence()
    expect(fetchPrices).toHaveBeenCalledTimes(2)
    expect(second.snapshot.prices.solana).toBe(110.06)
    expect(second.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (3 h old)',
    )
    expect(await keysOnDisk()).toHaveLength(2)
  })

  it('deletes from the device what retention drops, and ignores records that are not whole observations', async () => {
    await storage.put('oracle:v1:price:000000000000001', '{"timestamp":1}')
    await storage.put('oracle:v1:price:000000000000002', 'not json')
    await storage.put('unrelated', 'kept')
    const store = open()
    await store.restored
    expect(store.priceObservations).toEqual([])

    // Sixteen days of fetches go to the device; the next fetch thins the oldest two days.
    const recorded = []
    for (let t = START - 16 * DAY; t < START; t += INTERVAL) {
      recorded.push({ ...(await market({ solana: 100 })()), timestamp: t })
    }
    store.priceObservations = recorded
    await store.flushPersistence()
    expect(
      (await keysOnDisk()).filter(key => key.startsWith('oracle:v1:price:')),
    ).toHaveLength(recorded.length)
    const release = store.acquire('live')
    await io()
    release()
    await store.flushPersistence()
    expect(store.priceObservations.length).toBeLessThan(recorded.length - 200)

    const keys = await keysOnDisk()
    const prices = keys.filter(key => key.startsWith('oracle:v1:price:'))
    expect(prices).toHaveLength(store.priceObservations.length)
    expect(prices).toEqual(
      store.priceObservations.map(o => `oracle:v1:price:00${o.timestamp}`),
    )
    // Two weeks in full and one for each of the two days before.
    expect(prices.length).toBeLessThan(FULL_RESOLUTION_MS / INTERVAL + 5)
    expect(keys).toContain('unrelated')
  }, 60_000)
})

describe('outside a Pinia, the oracle knows no prices', () => {
  it('reports no value for anything instead of default rates, and fetches nothing', async () => {
    setActivePinia(undefined)
    const oracle = useSafeOracleStore()
    expect(oracle.rates).toEqual({})
    expect(oracle.formatUnitRate('monad')).toBe('')
    expect(oracle.formatAvuAmount('solana', ONE_SOL)).toBe('')
    expect(oracle.getAvu('ethereum', ONE_MON)).toBe(0)
    expect(oracle.historyFor('solana', '24h').points).toEqual([])
    oracle.acquire('live')()
    await pass(HOUR)
    expect(fetchPrices).not.toHaveBeenCalled()
  })
})

describe('formatting', () => {
  it('formats a unit rate only when there is a rate', () => {
    expect(formatUnitRate('ecash', 0.0000862)).toBe('1M XEC ≈ 86.20 AVU')
    expect(formatUnitRate('monad')).toBe('')
    expect(formatUnitRate('monad', 0)).toBe('')
  })

  it('formats ages', () => {
    expect(formatAge(20 * 60_000)).toBe('20 min')
    expect(formatAge(3 * HOUR)).toBe('3 h')
    expect(formatAge(72 * HOUR)).toBe('3 d')
  })
})
