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
  formatAge,
  retryDelayMs,
} from './oracle'
import { oracleInputs } from './oracle-series'
import { recordingSource, testFeed } from './oracle-test-feed'
import * as oracleSdk from '@frank/wallet/oracle'
import type { FeedRequest, OracleFeed } from '@frank/wallet/oracle'

// The two ways the app can get a feed: its relay, and the temporary direct adapter.
jest.mock('@frank/wallet/oracle', () => ({
  ...jest.requireActual('@frank/wallet/oracle'),
  fetchOracleFeed: jest.fn(),
  temporaryDirectFeed: jest.fn(),
  computeOracleRates: jest.fn(),
}))

const fetchOracleFeed = oracleSdk.fetchOracleFeed as jest.Mock
const temporaryDirectFeed = oracleSdk.temporaryDirectFeed as jest.Mock
const computeOracleRates = oracleSdk.computeOracleRates as jest.Mock
const realSdk = jest.requireActual('@frank/wallet/oracle') as typeof oracleSdk
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const INTERVAL = oracleSdk.ORACLE_REFRESH_INTERVAL_MS
const ONE_SOL = 1_000_000_000n
const START = Date.UTC(2026, 9, 10, 12, 0, 0)
const seconds = () => Math.floor(Date.now() / 1000)

const settle = () => jest.advanceTimersByTimeAsync(0)
const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms)

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A feed stamped now: AVU_hash is 10 kWh per unit of value, SOL is priced 110. */
function latestNow(): OracleFeed {
  return testFeed([seconds()], { prices: { 'solana-mainnet': 110 } })
}

const isLatest = (request: FeedRequest) => 'latest' in request

beforeEach(() => {
  // Level's own callbacks run on real ticks; only the clock and the timers are simulated.
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    now: START,
  })
  setActivePinia(createPinia())
  jest.resetAllMocks()
  // The real computation, counted.
  computeOracleRates.mockImplementation(realSdk.computeOracleRates)
})

afterEach(() => {
  delete (document as Partial<Document>).hidden
  jest.useRealTimers()
})

describe('refresh policy: one latest request per interval, never while hidden', () => {
  it('asks for nothing just because the store exists', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(latestNow)
    store.useFeedSource(source)
    await pass(6 * HOUR)
    expect(requests).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
    expect(store.rates).toEqual({})
    for (const asset of ['monad', 'solana', 'ethereum', 'ecash'] as const) {
      expect(store.formatUnitRate(asset)).toBe('')
      expect(store.formatAvuAmount(asset, 10n ** 20n)).toBe('')
      expect(store.getAvu(asset, 10n ** 20n)).toBe(0)
    }
  })

  it('held once by the app, asks for the latest feed once per interval', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(latestNow)
    store.useFeedSource(source)
    const release = store.acquire()
    await settle()
    expect(requests).toEqual([{ latest: true }])
    await pass(INTERVAL - MINUTE)
    expect(requests).toHaveLength(1)
    await pass(2 * MINUTE)
    expect(requests).toHaveLength(2)
    // Fifty-eight minutes open: requests at 0, 10, 20, 30, 40 and 50 minutes. Six an hour.
    await pass(HOUR - INTERVAL - 3 * MINUTE)
    expect(requests).toHaveLength(6)
    expect(requests.every(isLatest)).toBe(true)
    release()
    expect(jest.getTimerCount()).toBe(0)
    await pass(HOUR)
    expect(requests).toHaveLength(6)
  })

  it('two holders share one request, also one that is still under way', async () => {
    let answer!: (feed: OracleFeed) => void
    const asked: FeedRequest[] = []
    const store = useOracleStore()
    store.useFeedSource(request => {
      asked.push(request)
      return new Promise(resolve => (answer = resolve))
    })
    const first = store.acquire()
    await settle()
    const second = store.acquire()
    await settle()
    expect(asked).toHaveLength(1)
    answer(latestNow())
    await settle()
    expect(store.rates.solana).toBeCloseTo(1100, 9)
    first()
    expect(jest.getTimerCount()).toBe(1)
    second()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('makes no request while the window is hidden, and catches up when it shows again', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(latestNow)
    store.useFeedSource(source)
    setHidden(true)
    const release = store.acquire()
    await pass(3 * HOUR)
    expect(requests).toEqual([])
    setHidden(false)
    await settle()
    expect(requests).toHaveLength(1)
    setHidden(true)
    await pass(3 * HOUR)
    expect(requests).toHaveLength(1)
    release()
  })

  it('backs off after failures and keeps what it last received', async () => {
    const store = useOracleStore()
    let failing = false
    const { source, requests } = recordingSource(() =>
      failing ? undefined : latestNow(),
    )
    store.useFeedSource(source)
    const release = store.acquire()
    await settle()
    failing = true
    await pass(INTERVAL + MINUTE)
    expect(requests).toHaveLength(2)
    // One interval after the first failure, then two after the second.
    await pass(INTERVAL)
    expect(requests).toHaveLength(3)
    await pass(INTERVAL)
    expect(requests).toHaveLength(3)
    await pass(INTERVAL)
    expect(requests).toHaveLength(4)
    expect(store.rates.solana).toBeCloseTo(1100, 9)
    expect(retryDelayMs(1)).toBe(INTERVAL)
    expect(retryDelayMs(3)).toBe(4 * INTERVAL)
    expect(retryDelayMs(40)).toBe(16 * INTERVAL)
    release()
  })
})

describe('where the feed comes from', () => {
  it('is the relay, in one request, when the relay serves it', async () => {
    fetchOracleFeed.mockImplementation(async () => ({
      status: 'ok',
      feed: latestNow(),
    }))
    const store = useOracleStore()
    const release = store.acquire()
    await settle()
    expect(fetchOracleFeed).toHaveBeenCalledTimes(1)
    expect(fetchOracleFeed.mock.calls[0][1]).toEqual({ latest: true })
    expect(temporaryDirectFeed).not.toHaveBeenCalled()
    expect(store.rates.solana).toBeCloseTo(1100, 9)
    release()
  })

  it('is the temporary direct adapter only when the relay answers 404 for the route', async () => {
    fetchOracleFeed.mockResolvedValue({ status: 'not-served' })
    temporaryDirectFeed.mockImplementation(async () => latestNow())
    const store = useOracleStore()
    const release = store.acquire()
    await settle()
    expect(temporaryDirectFeed.mock.calls[0][0]).toEqual({ latest: true })
    expect(store.rates.solana).toBeCloseTo(1100, 9)
    release()
  })

  it('asks the adapter every 30 minutes, not every 10: it calls every provider itself', async () => {
    fetchOracleFeed.mockResolvedValue({ status: 'not-served' })
    temporaryDirectFeed.mockImplementation(async () => latestNow())
    const store = useOracleStore()
    const release = store.acquire()
    await settle()
    await pass(29 * MINUTE)
    expect(temporaryDirectFeed).toHaveBeenCalledTimes(1)
    await pass(2 * MINUTE)
    expect(temporaryDirectFeed).toHaveBeenCalledTimes(2)
    // Polls half an hour apart are still one covered stretch: no gap for the chart.
    expect(store.cache.coverage).toHaveLength(1)
    release()
  })

  it('tells the adapter what the saved series already hold', async () => {
    fetchOracleFeed.mockResolvedValue({ status: 'not-served' })
    const held: Array<number | undefined> = []
    temporaryDirectFeed.mockImplementation(async (_request, options) => {
      held.push(options.heldAt('difficulty/btc-mainnet'))
      expect(options.heldAt('difficulty/unknown-mainnet')).toBeUndefined()
      return latestNow()
    })
    const store = useOracleStore()
    const release = store.acquire()
    await settle()
    const first = seconds()
    await pass(31 * MINUTE)
    // Nothing held at the first request; the first answer's reading at the second.
    expect(held).toEqual([undefined, first])
    release()
  })
})

describe('the rates every screen reads', () => {
  it('are computed once per answer and are the history function evaluated now', async () => {
    const store = useOracleStore()
    store.useFeedSource(recordingSource(latestNow).source)
    const compute = computeOracleRates
    compute.mockClear()
    const release = store.acquire()
    await settle()
    expect(compute).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 50; i++) store.formatAvuAmount('solana', ONE_SOL)
    expect(compute).toHaveBeenCalledTimes(1)
    const inputs = oracleInputs(store.cache)!
    expect(store.current.avuHash).toEqual(
      oracleSdk.avuHashAt(inputs, store.current.at),
    )
    expect(store.avuHash?.kwhPerValue).toBeCloseTo(10, 9)
    release()
  })

  it('show an AVU figure, compact, marked as testnet, never a dollar', async () => {
    const store = useOracleStore()
    store.useFeedSource(recordingSource(latestNow).source)
    const release = store.acquire()
    await settle()
    expect(store.valuesAreTestnet).toBe(true)
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1.1 kAVU · testnet',
    )
    expect(store.formatAvuAmount('solana', ONE_SOL / 1000n)).toBe(
      '≈ 1.1 AVU · testnet',
    )
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 1.1 kAVU · testnet')
    expect(store.formatAvuValue('solana', 42)).toBe('≈ 42 AVU · testnet')
    for (const text of [
      store.formatAvuAmount('solana', ONE_SOL),
      store.formatUnitRate('solana'),
    ]) {
      expect(text).not.toMatch(/\$|USD/)
    }
    // Nothing to value, or a coin the feed has no price for: the amount stands alone.
    expect(store.formatAvuAmount('solana', 0n)).toBe('')
    expect(store.formatAvuAmount('solana', null)).toBe('')
    expect(store.formatAvuAmount('ethereum', 10n ** 18n)).toBe('')
    expect(store.formatUnitRate('tempo')).toBe('')
    release()
  })

  it('never show a stale figure without its age', async () => {
    const store = useOracleStore()
    let failing = false
    store.useFeedSource(
      recordingSource(() => (failing ? undefined : latestNow())).source,
    )
    const release = store.acquire()
    await settle()
    failing = true
    await pass(45 * MINUTE)
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1.1 kAVU · testnet (45 min old)',
    )
    expect(store.valueStaleAgeMs('solana')).toBe(45 * MINUTE)
    await pass(3 * HOUR)
    expect(store.avuHashStaleAgeMs()).toBe(3 * HOUR + 45 * MINUTE)
    release()
  })

  it('formats ages', () => {
    expect(formatAge(30_000)).toBe('1 min')
    expect(formatAge(12 * MINUTE)).toBe('12 min')
    expect(formatAge(3 * HOUR)).toBe('3 h')
    expect(formatAge(72 * HOUR)).toBe('3 d')
  })
})

describe('the local series the chart reads', () => {
  it('polling latest N times builds N points, drawn with no range request', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(latestNow)
    store.useFeedSource(source)
    const startSeconds = seconds()
    const release = store.acquire()
    await settle()
    await pass(5 * INTERVAL + MINUTE)
    expect(requests).toHaveLength(6)
    expect(store.cache.series['price/solana-mainnet'].points).toHaveLength(6)
    expect(store.cache.series['price/btc-mainnet'].points).toHaveLength(6)
    // The chart asks for the stretch since the first poll at the poll's resolution.
    await store.ensureHistory(startSeconds, 600)
    expect(requests.filter(request => !isLatest(request))).toEqual([])
    release()
  })

  it('a gap while the app was closed triggers exactly one range request, for that gap', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(request =>
      'latest' in request
        ? latestNow()
        : testFeed([request.since + 3600, request.since + 7200]),
    )
    store.useFeedSource(source)
    const firstPoll = seconds()
    let release = store.acquire()
    await settle()
    await pass(INTERVAL + MINUTE)
    release()
    const lastBeforeGap = store.cache.coverage[0].until
    // The app is closed for eight hours.
    jest.setSystemTime(Date.now() + 8 * HOUR)
    release = store.acquire()
    await settle()
    const afterGap = seconds()

    await store.ensureHistory(firstPoll, 600)
    const ranges = requests.filter(request => !isLatest(request))
    expect(ranges).toEqual([
      { since: lastBeforeGap, until: afterGap, step: 600 },
    ])
    // What came back is in the same local series, between the two recordings.
    const times = store.cache.series['price/btc-mainnet'].points.map(p => p[0])
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times).toContain(lastBeforeGap + 3600)

    // Asked for once: showing the chart again asks for nothing.
    await store.ensureHistory(firstPoll, 600)
    expect(requests.filter(request => !isLatest(request))).toHaveLength(1)
    release()
  })

  it('asks for the stretch before its first local point once, at the chart’s step', async () => {
    const store = useOracleStore()
    const { source, requests } = recordingSource(request =>
      'latest' in request ? latestNow() : testFeed([request.since]),
    )
    store.useFeedSource(source)
    const release = store.acquire()
    await settle()
    const now = seconds()
    const since = now - 30 * 86_400
    await Promise.all([
      store.ensureHistory(since, 21_600),
      store.ensureHistory(since, 21_600),
    ])
    expect(requests.filter(request => !isLatest(request))).toEqual([
      { since, until: now, step: 21_600 },
    ])
    release()
  })

  it('a range that could not be fetched is asked for again next time', async () => {
    const store = useOracleStore()
    let failing = true
    const { source, requests } = recordingSource(request =>
      'latest' in request
        ? latestNow()
        : failing
        ? undefined
        : testFeed([request.since]),
    )
    store.useFeedSource(source)
    const since = seconds() - 86_400
    await store.ensureHistory(since, 3600)
    failing = false
    await store.ensureHistory(since, 3600)
    await store.ensureHistory(since, 3600)
    expect(requests).toHaveLength(2)
  })
})

describe('across a restart', () => {
  let directory: string
  let storage: LevelDB

  function open() {
    const pinia = createPinia()
    pinia.use(
      createStoragePlugin(
        storage,
        Promise.resolve({ networkName: 'testnet', version: 1 }),
      ),
    )
    createApp({}).use(pinia)
    setActivePinia(pinia)
    return useOracleStore()
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'frank-oracle-store-'))
    storage = level(directory)
  })

  afterEach(async () => {
    await storage.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('a launch with a fresh saved cache makes zero requests, then asks when the interval is up', async () => {
    const first = open()
    await first.restored
    first.useFeedSource(recordingSource(latestNow).source)
    const release = first.acquire()
    await settle()
    await first.flushPersistence()
    release()

    // Four minutes later the app is reloaded.
    jest.setSystemTime(START + 4 * MINUTE)
    const second = open()
    const { source, requests } = recordingSource(latestNow)
    second.useFeedSource(source)
    const releaseSecond = second.acquire()
    await second.restored
    await settle()
    expect(requests).toEqual([])
    expect(second.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1.1 kAVU · testnet',
    )
    await pass(5 * MINUTE)
    expect(requests).toEqual([])
    await pass(2 * MINUTE)
    expect(requests).toEqual([{ latest: true }])
    releaseSecond()
  })

  it('remembers across a restart that its source is the adapter, asked every 30 minutes', async () => {
    const first = open()
    await first.restored
    first.useFeedSource(async () => ({
      feed: latestNow(),
      refreshMs: 30 * MINUTE,
    }))
    const release = first.acquire()
    await settle()
    await first.flushPersistence()
    release()

    jest.setSystemTime(START + 20 * MINUTE)
    const second = open()
    const { source, requests } = recordingSource(latestNow)
    second.useFeedSource(source)
    const releaseSecond = second.acquire()
    await second.restored
    await settle()
    await pass(5 * MINUTE)
    expect(requests).toEqual([])
    await pass(6 * MINUTE)
    expect(requests).toHaveLength(1)
    releaseSecond()
  })

  it('shows what was last received, with its age, before anything is fetched', async () => {
    const first = open()
    await first.restored
    first.useFeedSource(recordingSource(latestNow).source)
    const release = first.acquire()
    await settle()
    await first.flushPersistence()
    release()

    jest.setSystemTime(START + 5 * HOUR)
    const second = open()
    expect(await second.restored).toBe(true)
    expect(second.cache.series['price/solana-mainnet'].points).toHaveLength(1)
    expect(second.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1.1 kAVU · testnet (5 h old)',
    )
  })
})

describe('without Pinia', () => {
  it('reports no value for anything and fetches nothing', () => {
    setActivePinia(undefined as never)
    const store = useSafeOracleStore()
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe('')
    expect(store.formatUnitRate('solana')).toBe('')
    expect(store.getAvu('solana', ONE_SOL)).toBe(0)
    expect(store.avuHash).toBeUndefined()
    store.acquire()()
  })
})
