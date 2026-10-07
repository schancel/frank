/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import { useOracleStore } from './oracle'
import * as oracleSdk from '@frank/wallet/oracle'

jest.mock('@frank/wallet/oracle', () => {
  const actual = jest.requireActual('@frank/wallet/oracle')
  return {
    ...actual,
    fetchOracleSnapshot: jest.fn(),
  }
})

describe('useOracleStore (Pinia Store)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    jest.clearAllMocks()
  })

  afterEach(() => {
    const store = useOracleStore()
    store.stopBackgroundWorker()
  })

  it('initializes with default PoW thermodynamic rates and zero history', () => {
    const store = useOracleStore()
    expect(store.snapshot.epoch).toBe('pow-energy-standard-v1')
    expect(store.snapshot.rates.monad).toBeCloseTo(41.67, 1)
    expect(store.history).toEqual([])
  })

  it('computes AVU equivalents and formats amounts correctly', () => {
    const store = useOracleStore()
    const oneMonWei = 1_000_000_000_000_000_000n

    const avu = store.getAvu('monad', oneMonWei)
    expect(avu).toBeCloseTo(41.67, 1)

    const formatted = store.formatAvuAmount('monad', oneMonWei)
    expect(formatted).toBe('≈ 41.67 AVU')

    // 0 or null returns empty string for clean UI rendering
    expect(store.formatAvuAmount('monad', 0n)).toBe('')
    expect(store.formatAvuAmount('monad', null)).toBe('')
  })

  it('formats unit rates for all supported assets correctly', () => {
    const store = useOracleStore()
    expect(store.formatUnitRate('monad')).toBe('1 MON ≈ 41.67 AVU')
    expect(store.formatUnitRate('solana')).toBe('1 SOL ≈ 1,785.71 AVU')
    expect(store.formatUnitRate('ethereum')).toBe('1 ETH ≈ 30,952.38 AVU')
    expect(store.formatUnitRate('hyperliquid')).toBe('1 HYPE ≈ 476.19 AVU')
    expect(store.formatUnitRate('tempo')).toBe('1 TUSD ≈ 11.90 AVU')
    expect(store.formatUnitRate('ecash')).toBe('1M XEC ≈ 416.67 AVU')
  })

  it('refreshes snapshot and records hourly historical trend points', async () => {
    const mockFetch = oracleSdk.fetchOracleSnapshot as jest.Mock
    mockFetch.mockResolvedValue({
      epoch: 'pow-energy-standard-v1',
      timestamp: Date.now(),
      basketIndex: 1.05,
      rates: {
        ...oracleSdk.DEFAULT_AVU_RATES,
        solana: 1785.0,
      },
    })

    const store = useOracleStore()
    await store.refresh()

    expect(mockFetch).toHaveBeenCalled()
    expect(store.snapshot.rates.solana).toBe(1785.0)
    expect(store.history.length).toBe(1)
    expect(store.history[0].rates.solana).toBe(1785.0)

    // Verify localStorage persistence
    const saved = localStorage.getItem('frank_oracle_snapshot_v1')
    expect(saved).toBeTruthy()
    expect(JSON.parse(saved!).rates.solana).toBe(1785.0)
  })

  it('manages background polling worker lifecycle without duplicating intervals', () => {
    jest.useFakeTimers()
    const store = useOracleStore()
    const refreshSpy = jest.spyOn(store, 'refresh').mockResolvedValue()

    store.startBackgroundWorker(10000)
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    // Starting again should be a no-op
    store.startBackgroundWorker(10000)
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(10000)
    expect(refreshSpy).toHaveBeenCalledTimes(2)

    store.stopBackgroundWorker()
    jest.advanceTimersByTime(20000)
    expect(refreshSpy).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })
})
