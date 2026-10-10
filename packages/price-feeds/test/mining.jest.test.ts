import { fetchMiningStats, BLOCKCHAIR_API_BASE } from '../src'

function statsResponse(data: unknown, ok = true) {
  return jest.fn(async () => ({
    ok,
    json: async () => ({ data }),
  })) as unknown as typeof fetch
}

describe('fetchMiningStats', () => {
  it('computes dollars issued per hash from the chain’s own 24h issuance, hashrate and price', async () => {
    // Figures in the shape Blockchair returned for bitcoin: issuance in satoshis.
    const fetchFn = statsResponse({
      inflation_24h: 44_062_500_000,
      hashrate_24h: '931390342732432625315',
      market_price_usd: 82763,
    })
    const stats = await fetchMiningStats('bitcoin', { fetchFn })
    expect((fetchFn as jest.Mock).mock.calls[0][0]).toBe(
      `${BLOCKCHAIR_API_BASE}/bitcoin/stats`,
    )
    const usdPerSecond = (440.625 * 82763) / 86_400
    expect(stats?.issuanceUsdPerSecond).toBeCloseTo(usdPerSecond, 6)
    expect(stats?.hashrateHps).toBeCloseTo(9.3139034e20, -14)
    expect(stats?.usdPerHash).toBeCloseTo(usdPerSecond / 9.31390342732e20, 30)
  })

  it('reads eCash issuance at two decimals', async () => {
    const stats = await fetchMiningStats('ecash', {
      fetchFn: statsResponse({
        inflation_24h: 42_500_000_000,
        hashrate_24h: '39355669122534140',
        market_price_usd: 7.24e-6,
      }),
    })
    expect(stats?.issuanceUsdPerSecond).toBeCloseTo(
      (425_000_000 * 7.24e-6) / 86_400,
      9,
    )
  })

  it.each([
    ['a failed request', statsResponse({}, false)],
    [
      'a missing hashrate',
      statsResponse({ inflation_24h: 1, market_price_usd: 1 }),
    ],
    [
      'a zero price',
      statsResponse({
        inflation_24h: 1,
        hashrate_24h: '1',
        market_price_usd: 0,
      }),
    ],
    [
      'a dead network',
      jest
        .fn()
        .mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    ],
  ])(
    'answers nothing for %s instead of a baseline figure',
    async (_name, fetchFn) => {
      expect(await fetchMiningStats('bitcoin', { fetchFn })).toBeNull()
    },
  )

  it('answers nothing for a chain it has no unit scale for', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch
    expect(await fetchMiningStats('kaspa', { fetchFn })).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
