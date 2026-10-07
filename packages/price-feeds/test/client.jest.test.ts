import { PriceFeedsClient } from '../src/client'

describe('PriceFeedsClient', () => {
  it('samples across multiple active providers with median strategy', async () => {
    const mockFetch: typeof fetch = jest.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('coinbase.com')) {
        return {
          ok: true,
          json: async () => ({
            data: { base: 'ETH', currency: 'USD', amount: '2600.00' },
          }),
        } as any
      }
      if (url.includes('kraken.com')) {
        return {
          ok: true,
          json: async () => ({
            result: { ETHUSD: { c: ['2610.00'] } },
          }),
        } as any
      }
      if (url.includes('coingecko.com')) {
        return {
          ok: true,
          json: async () => ({
            ethereum: { usd: 2605.0 },
          }),
        } as any
      }
      return { ok: false } as any
    })

    const client = new PriceFeedsClient({
      fetchFn: mockFetch,
      providers: ['coinbase', 'kraken', 'coingecko'],
      defaultStrategy: 'median',
    })

    const ethResult = await client.getPrice('ETH')
    expect(ethResult.asset).toBe('ETH')
    // Samples: 2600, 2605, 2610 -> Median = 2605
    expect(ethResult.price).toBe(2605)
    expect(ethResult.sampleCount).toBe(3)
    expect(ethResult.spreadPct).toBeGreaterThan(0)
  })

  it('generates multi-asset snapshot', async () => {
    const mockFetch: typeof fetch = jest.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('coingecko.com')) {
        return {
          ok: true,
          json: async () => ({
            ethereum: { usd: 2600 },
            solana: { usd: 150 },
            ecash: { usd: 0.000035 },
          }),
        } as any
      }
      return { ok: false } as any
    })

    const client = new PriceFeedsClient({
      fetchFn: mockFetch,
      providers: ['coingecko'],
    })

    const snapshot = await client.getSnapshot(['ETH', 'SOL', 'XEC'])
    expect(snapshot.ETH.price).toBe(2600)
    expect(snapshot.SOL.price).toBe(150)
    expect(snapshot.XEC.price).toBe(0.000035)
  })
})
