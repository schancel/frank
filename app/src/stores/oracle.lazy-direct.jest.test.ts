/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-var-requires -- This module-evaluation regression deliberately defers CommonJS loads until counters are installed; static imports would invalidate the boundary assertions. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import type { DirectFeedOptions } from '@frank/price-feeds/temporary-direct-feed'

const NOW = Date.UTC(2026, 9, 10, 12)
const mockEvaluated = { direct: 0, history: 0, aggregate: 0 }
const mockHeldAt: Array<number | undefined> = []
const mockProviders: DirectFeedOptions = {
  now: () => NOW,
  fetchPrices: async () => ({ BTC: 90_000, SOL: 110 }),
  fetchGold: async () => null,
  fetchStats: async () => null,
}

// Observe actual module evaluation, not merely whether an exported function is called.
jest.mock('@frank/price-feeds/historical', () => {
  mockEvaluated.history++
  return jest.requireActual('@frank/price-feeds/historical')
})
jest.mock('@frank/price-feeds/electricity-aggregate', () => {
  const actual = jest.requireActual('@frank/price-feeds/electricity-aggregate')
  return {
    ...actual,
    windowedElectricityAggregate: (
      ...args: Parameters<
        typeof import('@frank/price-feeds').windowedElectricityAggregate
      >
    ) => {
      mockEvaluated.aggregate++
      return actual.windowedElectricityAggregate(...args)
    },
  }
})
jest.mock('@frank/price-feeds/temporary-direct-feed', () => {
  mockEvaluated.direct++
  const actual = jest.requireActual(
    '@frank/price-feeds/temporary-direct-feed',
  ) as typeof import('@frank/price-feeds/temporary-direct-feed')
  return {
    ...actual,
    temporaryDirectFeed: jest.fn(
      (
        request: Parameters<typeof actual.temporaryDirectFeed>[0],
        options: DirectFeedOptions,
      ) => {
        mockHeldAt.push(options.heldAt?.('hashrate/btc-mainnet'))
        // Keep the real adapter and replace only its external-provider option seams.
        return actual.temporaryDirectFeed(request, {
          ...options,
          ...mockProviders,
        })
      },
    ),
  }
})
jest.mock('@frank/wallet/oracle', () => ({
  ...jest.requireActual('@frank/wallet/oracle'),
  fetchOracleFeed: jest.fn(),
}))

it('loads optional history exactly once after a real store request receives 404', async () => {
  const sdk =
    require('@frank/wallet/oracle') as typeof import('@frank/wallet/oracle')
  const { useOracleStore } = require('./oracle') as typeof import('./oracle')
  expect(mockEvaluated).toEqual({ direct: 0, history: 0, aggregate: 0 })

  const { createApp } = require('vue') as typeof import('vue')
  const { createPinia, setActivePinia } =
    require('pinia') as typeof import('pinia')
  const { createStoragePlugin } =
    require('../boot/pinia') as typeof import('../boot/pinia')
  const { testFeed } =
    require('./oracle-test-feed') as typeof import('./oracle-test-feed')
  const { emptyOracleCache, mergeFeed, coverLatest, saveOracleCache } =
    require('./oracle-series') as typeof import('./oracle-series')
  const { retainOracleView } =
    require('./oracle-view') as typeof import('./oracle-view')
  const at = NOW / 1000
  const feed = testFeed([at], { prices: { 'solana-mainnet': 110 } })
  const directory = mkdtempSync(join(tmpdir(), 'frank-oracle-lazy-direct-'))
  const storage = level(directory)
  const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW)
  let release: (() => void) | undefined
  let store: ReturnType<typeof useOracleStore> | undefined
  try {
    await saveOracleCache(storage, {
      ...mergeFeed(emptyOracleCache(), feed, at),
      coverage: coverLatest([], at, sdk.ORACLE_REFRESH_INTERVAL_MS / 1000),
    })
    const pinia = createPinia()
    pinia.use(
      createStoragePlugin(
        storage,
        Promise.resolve({ networkName: 'testnet', version: 1 }),
      ),
    )
    createApp({}).use(pinia)
    setActivePinia(pinia)
    store = useOracleStore()
    await store.restored
    expect(store.current).toEqual(
      retainOracleView(
        sdk.computeOracleRates(
          {
            basket: feed.basket,
            electricity: feed.electricity,
            series: feed.series,
          },
          at,
        ),
        undefined,
        at,
      ),
    )
    release = store.acquire()
    await store.refreshDue()
    expect(sdk.fetchOracleFeed).not.toHaveBeenCalled()
    expect(mockEvaluated).toEqual({ direct: 0, history: 0, aggregate: 0 })

    const fetchRelay = sdk.fetchOracleFeed as jest.Mock
    fetchRelay.mockResolvedValue({ status: 'ok', feed })
    await store.fetchLatest()
    fetchRelay.mockResolvedValue({ status: 'failed' })
    await store.fetchLatest()
    expect(mockEvaluated).toEqual({ direct: 0, history: 0, aggregate: 0 })

    fetchRelay.mockResolvedValue({ status: 'not-served' })
    const before = store.cache
    const previousView = before.lastValid ?? store.current
    const first = store.fetchLatest()
    const concurrent = store.fetchLatest()
    await Promise.all([first, concurrent])
    expect(mockEvaluated).toEqual({ direct: 1, history: 1, aggregate: 1 })
    const direct =
      require('@frank/price-feeds/temporary-direct-feed') as typeof import('@frank/price-feeds/temporary-direct-feed')
    expect(direct.temporaryDirectFeed).toHaveBeenCalledTimes(1)
    expect((direct.temporaryDirectFeed as jest.Mock).mock.calls[0][0]).toEqual({
      latest: true,
    })
    expect(mockHeldAt).toEqual([at])
    const expected = await jest
      .requireActual<typeof direct>('@frank/price-feeds/temporary-direct-feed')
      .temporaryDirectFeed(
        { latest: true },
        {
          ...mockProviders,
          heldAt: name => {
            const one = before.series[name]
            return one && !one.stale
              ? one.points[one.points.length - 1]?.[0]
              : undefined
          },
        },
      )
    const merged = mergeFeed(before, expected, at)
    expect(store.cache.basket).toEqual(expected.basket)
    expect(store.cache.electricity).toEqual(expected.electricity)
    expect(store.cache.series).toEqual(merged.series)
    const expectedView = retainOracleView(
      sdk.computeOracleRates(
        {
          basket: expected.basket,
          electricity: expected.electricity,
          series: merged.series,
        },
        at,
      ),
      previousView,
      at,
    )
    expect(store.current).toEqual(expectedView)
    expect(store.cache.lastValid).toEqual(expectedView)
    expect(store.refreshIntervalMs()).toBe(sdk.DIRECT_FEED_REFRESH_INTERVAL_MS)

    const since = Date.UTC(2024, 0, 1) / 1000
    const until = Date.UTC(2024, 1, 1) / 1000
    const step = 86_400
    expect(await store.ensureHistory(since, step, until)).toEqual([
      direct.bundledFeed({ since, until, step }, NOW),
    ])
    expect(mockEvaluated).toEqual({ direct: 1, history: 1, aggregate: 1 })
  } finally {
    release?.()
    await store?.flushPersistence()
    await storage.close()
    clock.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
