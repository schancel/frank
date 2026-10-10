/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import {
  useOracleStore,
  useSafeOracleStore,
  formatUnitRate,
  formatAge,
} from './oracle'
import * as oracleSdk from '@frank/wallet/oracle'

// The provider seam: no test here touches the network.
jest.mock('@frank/wallet/oracle', () => ({
  ...jest.requireActual('@frank/wallet/oracle'),
  fetchOracleSnapshot: jest.fn(),
  fetchPriceHistory: jest.fn(),
}))

const fetchOracleSnapshot = oracleSdk.fetchOracleSnapshot as jest.Mock
const fetchPriceHistory = oracleSdk.fetchPriceHistory as jest.Mock
const BTC_USD = 80_000
const HOUR = 3_600_000
const ONE_SOL = 1_000_000_000n
const ONE_MON = 1_000_000_000_000_000_000n

/**
 * Bitcoin chain statistics at which AVU_hash, computed by the real formula with the
 * bundled efficiency, comes to exactly `kwhPerDollar` when bitcoin is BTC_USD:
 * kWh/$ = hashes per block / (price x subsidy x hashes per kWh).
 */
function bitcoinStats(kwhPerDollar: number, fetchedAt: number) {
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

/**
 * What a fetch returns: the given prices and bitcoin's, with bitcoin's chain statistics
 * (unless `kwhPerDollar` is null: the statistics did not arrive). AVU_hash is 12 kWh/$
 * unless stated.
 */
function fetched(
  prices: oracleSdk.UsdPrices,
  timestamp = Date.now(),
  kwhPerDollar: number | null = 12,
  miningAt = timestamp,
) {
  const snapshot = oracleSdk.unavailableOracleSnapshot()
  snapshot.timestamp = timestamp
  for (const [asset, price] of Object.entries({
    ...prices,
    bitcoin: BTC_USD,
  }) as Array<[oracleSdk.SupportedAsset, number]>) {
    snapshot.prices[asset] = price
    snapshot.fetchedAt[asset] = timestamp
    snapshot.priceSources[asset] = 4
  }
  if (kwhPerDollar !== null) {
    snapshot.mining.bitcoin = bitcoinStats(kwhPerDollar, miningAt)
  }
  return oracleSdk.rateOracleSnapshot(snapshot)
}

describe('useOracleStore', () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    jest.clearAllMocks()
  })

  afterEach(() => {
    useOracleStore().stopBackgroundWorker()
    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    } else {
      delete (document as Partial<Document>).hidden
    }
  })

  it('starts with no prices at all: nothing is assumed before a fetch', () => {
    const store = useOracleStore()
    expect(store.snapshot.prices).toEqual({})
    expect(store.rates).toEqual({})
    expect(store.observations).toEqual([])
    for (const asset of ['monad', 'solana', 'ethereum', 'ecash'] as const) {
      expect(store.formatUnitRate(asset)).toBe('')
      expect(store.formatAvuAmount(asset, 10n ** 20n)).toBe('')
      expect(store.getAvu(asset, 10n ** 20n)).toBe(0)
    }
  })

  it('values a balance at the fetched price times AVU_hash', async () => {
    fetchOracleSnapshot.mockResolvedValue(fetched({ solana: 110.06 }))
    const store = useOracleStore()
    await store.refresh()

    // AVU_hash is 12 kWh per dollar, so 1 SOL at $110.06 is 1,320.72 kWh.
    expect(store.avuHash?.kwhPerDollar).toBeCloseTo(12, 9)
    expect(store.getAvu('solana', 2n * ONE_SOL)).toBeCloseTo(2 * 110.06 * 12, 6)
    expect(store.formatAvuAmount('solana', 2n * ONE_SOL)).toBe('≈ 2,641.4 AVU')
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 1,320.72 AVU')
    expect(store.formatAvuAmount('solana', 0n)).toBe('')
    expect(store.formatAvuAmount('solana', null)).toBe('')
  })

  it('has no constant in the path: every AVU value moves in step with the mining inputs', async () => {
    const store = useOracleStore()
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ solana: 110.06, ethereum: 2500, ecash: 7.2e-6 }),
    )
    await store.refresh()
    const before = { ...store.rates }
    // The same prices; twice the hashes per block means twice the kWh per dollar.
    fetchOracleSnapshot.mockResolvedValue(
      fetched(
        { solana: 110.06, ethereum: 2500, ecash: 7.2e-6 },
        Date.now(),
        24,
      ),
    )
    await store.refresh()
    expect(Object.keys(store.rates).sort()).toEqual(
      ['bitcoin', 'ecash', 'ethereum', 'solana'].sort(),
    )
    for (const asset of Object.keys(before) as oracleSdk.SupportedAsset[]) {
      expect(store.rates[asset]! / before[asset]!).toBeCloseTo(2, 9)
    }
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 2,641.44 AVU')
  })

  it('shows no AVU value for anything while AVU_hash is unavailable: there is no fallback rate', async () => {
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ solana: 110.06 }, Date.now(), null),
    )
    const store = useOracleStore()
    await store.refresh()
    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.avuHash).toBeUndefined()
    expect(store.rates).toEqual({})
    expect(store.formatUnitRate('solana')).toBe('')
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe('')
    expect(store.getAvu('solana', ONE_SOL)).toBe(0)
  })

  it('keeps the last chain statistics when they fail to arrive, and marks every value with their age once stale', async () => {
    const then = Date.now() - 5 * HOUR
    const store = useOracleStore()
    fetchOracleSnapshot.mockResolvedValue(fetched({ solana: 100 }, then))
    await store.refresh()

    // Prices arrive now; the chain statistics do not.
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ solana: 110.06 }, Date.now(), null),
    )
    await store.refresh()
    expect(store.snapshot.mining.bitcoin.fetchedAt).toBe(then)
    expect(store.avuHash?.kwhPerDollar).toBeCloseTo(12, 9)
    expect(store.avuHashStaleAgeMs()).toBeGreaterThanOrEqual(5 * HOUR)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (5 h old)',
    )
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1,320.7 AVU (5 h old)',
    )
  })

  it('refetches chain statistics only once they are half an hour old', async () => {
    const store = useOracleStore()
    const recent = Date.now() - 10 * 60_000
    fetchOracleSnapshot.mockResolvedValue(fetched({ solana: 100 }, recent))
    await store.refresh()
    expect(fetchOracleSnapshot.mock.calls[0][0]).toEqual({ knownMining: {} })

    await store.refresh()
    expect(
      Object.keys(fetchOracleSnapshot.mock.calls[1][0].knownMining),
    ).toEqual(['bitcoin'])

    store.snapshot.mining.bitcoin.fetchedAt = Date.now() - 31 * 60_000
    await store.refresh()
    expect(fetchOracleSnapshot.mock.calls[2][0]).toEqual({ knownMining: {} })
  })

  it('shows nothing for a coin whose price did not come back, even when others did', async () => {
    fetchOracleSnapshot.mockResolvedValue(fetched({ solana: 110.06 }))
    const store = useOracleStore()
    await store.refresh()
    expect(store.formatUnitRate('ethereum')).toBe('')
    expect(store.formatAvuAmount('ethereum', ONE_MON)).toBe('')
    expect(store.formatUnitRate('tempo')).toBe('')
    expect(store.formatAvuAmount('tempo', 5_000_000n)).toBe('')
  })

  it('a failed fetch leaves no price where there was none', async () => {
    fetchOracleSnapshot.mockResolvedValue(oracleSdk.unavailableOracleSnapshot())
    const store = useOracleStore()
    await store.refresh()
    expect(store.rates).toEqual({})
    expect(store.formatUnitRate('monad')).toBe('')
    expect(store.observations).toEqual([])
    expect(localStorage.getItem('frank_oracle_snapshot_v3')).toBeNull()

    fetchOracleSnapshot.mockRejectedValue(new Error('offline'))
    await store.refresh()
    expect(store.rates).toEqual({})
    expect(store.isRefreshing).toBe(false)
  })

  it('a failed fetch keeps the last real price with its own time, shown as stale with its age', async () => {
    const then = Date.now() - 3 * HOUR
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ solana: 110.06, ethereum: 2496.78 }, then),
    )
    const store = useOracleStore()
    await store.refresh()

    // Now only ETH comes back; SOL keeps its three-hour-old price and says so.
    fetchOracleSnapshot.mockResolvedValue(fetched({ ethereum: 2500 }))
    await store.refresh()
    expect(store.snapshot.prices.solana).toBe(110.06)
    expect(store.snapshot.fetchedAt.solana).toBe(then)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (3 h old)',
    )
    expect(store.formatUnitRate('ethereum')).toBe('1 ETH ≈ 30,000.00 AVU')
    // A balance valued at the stale price says so too; one at a fresh price does not.
    expect(store.formatAvuAmount('solana', ONE_SOL)).toBe(
      '≈ 1,320.7 AVU (3 h old)',
    )
    expect(store.formatAvuAmount('ethereum', 10n ** 18n)).toBe('≈ 30,000 AVU')

    // Then nothing comes back: both remain, both aged, neither replaced by a default.
    fetchOracleSnapshot.mockResolvedValue(oracleSdk.unavailableOracleSnapshot())
    await store.refresh()
    expect(store.snapshot.prices).toEqual({
      solana: 110.06,
      ethereum: 2500,
      bitcoin: BTC_USD,
    })
    expect(store.priceAgeMs('solana')).toBeGreaterThanOrEqual(3 * HOUR)
  })

  it('prices MON as mainnet MON and gives a testnet MON balance no value', async () => {
    fetchOracleSnapshot.mockResolvedValue(fetched({ monad: 0.025 }))
    const store = useOracleStore()
    await store.refresh()
    expect(store.formatUnitRate('monad')).toBe(
      '1 MON ≈ 0.30 AVU (mainnet price; testnet coins have no market value)',
    )
    expect(store.getAvu('monad', 100n * ONE_MON)).toBe(0)
    expect(store.formatAvuAmount('monad', 100n * ONE_MON)).toBe('')
  })

  it('never reads the old v1 records, which could hold typed-in prices', () => {
    localStorage.setItem(
      'frank_oracle_snapshot_v1',
      JSON.stringify({
        basketIndex: 1,
        rates: { monad: 41.67, solana: 1785.71 },
      }),
    )
    localStorage.setItem(
      'frank_oracle_history_v1',
      JSON.stringify([{ timestamp: 1, rates: { monad: 41.67 } }]),
    )
    setActivePinia(createPinia())
    const store = useOracleStore()
    expect(store.rates).toEqual({})
    expect(store.observations).toEqual([])
    expect(store.formatUnitRate('monad')).toBe('')
  })

  it('restores a saved snapshot only from fetched prices and chain statistics, recomputing AVU_hash and every value', () => {
    const fetchedAt = Date.now() - HOUR
    const saved = {
      timestamp: fetchedAt,
      prices: {
        solana: 110.06,
        ethereum: 2496.78,
        hyperliquid: -1,
        bitcoin: BTC_USD,
      },
      // Stored rates and a stored AVU_hash are ignored: both are recomputed.
      rates: { solana: 999999, monad: 41.67 },
      avuHash: { kwhPerDollar: 999 },
      fetchedAt: {
        solana: fetchedAt,
        bitcoin: fetchedAt,
        hyperliquid: fetchedAt,
      },
      priceSources: { solana: 3, bitcoin: 0 },
      mining: {
        'bitcoin': bitcoinStats(12, fetchedAt),
        // Incomplete statistics are not restored.
        'bitcoin-cash': { chain: 'bitcoin-cash', difficulty: 5 },
      },
    }
    localStorage.setItem('frank_oracle_snapshot_v3', JSON.stringify(saved))
    setActivePinia(createPinia())
    const store = useOracleStore()
    // ETH has no fetch time, HYPE no real price and MON no price: none is restored.
    expect(Object.keys(store.rates).sort()).toEqual(['bitcoin', 'solana'])
    expect(Object.keys(store.snapshot.mining)).toEqual(['bitcoin'])
    expect(store.avuHash?.kwhPerDollar).toBeCloseTo(12, 9)
    expect(store.snapshot.priceSources).toEqual({ solana: 3 })
    expect(store.rates.solana).toBeCloseTo(110.06 * 12, 6)
    expect(store.formatUnitRate('solana')).toBe(
      '1 SOL ≈ 1,320.72 AVU (1 h old)',
    )

    // The v2 record, written when AVU was a typed-in rate, is never read.
    localStorage.clear()
    localStorage.setItem('frank_oracle_snapshot_v2', JSON.stringify(saved))
    setActivePinia(createPinia())
    expect(useOracleStore().snapshot.prices).toEqual({})
  })

  it('records its own fetched prices at most once an hour, and only what was fetched', async () => {
    const start = Date.now() - 2 * HOUR
    const store = useOracleStore()
    fetchOracleSnapshot.mockResolvedValue(fetched({ solana: 100 }, start))
    await store.refresh()
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ solana: 101 }, start + 10 * 60_000),
    )
    await store.refresh()
    fetchOracleSnapshot.mockResolvedValue(
      fetched({ ecash: 7.24e-6 }, start + HOUR + 1),
    )
    await store.refresh()

    expect(store.observations).toEqual([
      { timestamp: start, prices: { solana: 100, bitcoin: BTC_USD } },
      {
        timestamp: start + HOUR + 1,
        prices: { ecash: 7.24e-6, bitcoin: BTC_USD },
      },
    ])
    expect(
      JSON.parse(localStorage.getItem('frank_oracle_observations_v2')!),
    ).toHaveLength(2)
  })

  describe('price history', () => {
    it('serves the provider’s candles unchanged and does not refetch within the cache time', async () => {
      const points = [
        { timestamp: Date.now() - 2 * HOUR, price: 108.5 },
        { timestamp: Date.now() - HOUR, price: 110.06 },
      ]
      fetchPriceHistory.mockResolvedValue({
        asset: 'SOL',
        range: '24h',
        provider: 'kraken',
        points,
      })
      const store = useOracleStore()
      await store.loadHistory('solana', '24h')
      await store.loadHistory('solana', '24h')

      expect(fetchPriceHistory).toHaveBeenCalledTimes(1)
      expect(fetchPriceHistory).toHaveBeenCalledWith('SOL', '24h')
      const history = store.historyFor('solana', '24h')
      expect(history.source).toBe('kraken')
      expect(history.points).toEqual(points)
    })

    it('has no history for a coin with no price source, without asking anyone', async () => {
      const store = useOracleStore()
      await store.loadHistory('tempo', '7d')
      expect(fetchPriceHistory).not.toHaveBeenCalled()
      expect(store.historyFor('tempo', '7d')).toMatchObject({
        source: null,
        points: [],
      })
    })

    it('when no provider has history, shows only its own records inside the range', async () => {
      fetchPriceHistory.mockResolvedValue({
        asset: 'XEC',
        range: '24h',
        provider: null,
        points: [],
      })
      const store = useOracleStore()
      const now = Date.now()
      store.observations = [
        { timestamp: now - 30 * HOUR, prices: { ecash: 7.5e-6 } },
        { timestamp: now - 5 * HOUR, prices: { ecash: 7.3e-6 } },
        { timestamp: now - 4 * HOUR, prices: { solana: 110 } },
      ]
      await store.loadHistory('ecash', '24h')
      const history = store.historyFor('ecash', '24h', now)
      expect(history.source).toBe('observed')
      expect(history.points).toEqual([
        { timestamp: now - 5 * HOUR, price: 7.3e-6 },
      ])
    })
  })

  it('manages background polling worker lifecycle without duplicating intervals', () => {
    jest.useFakeTimers()
    const store = useOracleStore()
    const refreshSpy = jest.spyOn(store, 'refresh').mockResolvedValue()

    store.startBackgroundWorker(10000)
    store.startBackgroundWorker(10000)
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(10000)
    expect(refreshSpy).toHaveBeenCalledTimes(2)

    store.stopBackgroundWorker()
    jest.advanceTimersByTime(20000)
    expect(refreshSpy).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it('skips background worker refresh when document is hidden', () => {
    jest.useFakeTimers()
    const store = useOracleStore()
    const refreshSpy = jest.spyOn(store, 'refresh').mockResolvedValue()
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    })

    store.startBackgroundWorker(10000)
    jest.advanceTimersByTime(20000)
    expect(refreshSpy).not.toHaveBeenCalled()

    store.stopBackgroundWorker()
    jest.useRealTimers()
  })
})

describe('outside a Pinia, the oracle knows no prices', () => {
  it('reports no value for anything instead of default rates', () => {
    setActivePinia(undefined)
    const oracle = useSafeOracleStore()
    expect(oracle.rates).toEqual({})
    expect(oracle.formatUnitRate('monad')).toBe('')
    expect(oracle.formatAvuAmount('solana', ONE_SOL)).toBe('')
    expect(oracle.getAvu('ethereum', ONE_MON)).toBe(0)
    expect(oracle.historyFor('solana', '24h').points).toEqual([])
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
