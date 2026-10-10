import {
  fetchMiningStats,
  BLOCKCHAIR_API_BASE,
  HASHES_PER_DIFFICULTY,
} from '../src'

function statsResponse(data: unknown, ok = true) {
  return jest.fn(async () => ({
    ok,
    json: async () => ({ data }),
  })) as unknown as typeof fetch
}

describe('fetchMiningStats', () => {
  it('reads coins per block and hashes per block from the chain’s own statistics', async () => {
    // The figures Blockchair returned for bitcoin on 2026-10-10: issuance in satoshis.
    const fetchFn = statsResponse({
      inflation_24h: 44_062_500_000,
      blocks_24h: 141,
      difficulty: 132716002350731.3,
      circulation: 2009602416655096,
      hashrate_24h: '931390342732432625315',
      market_price_usd: 82738,
    })
    const stats = await fetchMiningStats('bitcoin', { fetchFn })
    expect((fetchFn as jest.Mock).mock.calls[0][0]).toBe(
      `${BLOCKCHAIR_API_BASE}/bitcoin/stats`,
    )
    // 440.625 BTC minted in 141 blocks is 3.125 BTC a block.
    expect(stats?.subsidyCoinsPerBlock).toBeCloseTo(3.125, 9)
    expect(stats?.difficulty).toBe(132716002350731.3)
    // difficulty x 2^32 = 5.70e23 hashes expected per block
    expect(HASHES_PER_DIFFICULTY).toBe(4294967296)
    expect(stats?.hashesPerBlock).toBe(132716002350731.3 * 4294967296)
    expect(stats?.hashesPerBlock).toBeCloseTo(5.7e23, -21)
    expect(stats?.circulatingCoins).toBeCloseTo(20_096_024.16655096, 6)
  })

  it('reads eCash issuance at two decimals: the whole subsidy, before any split', async () => {
    const stats = await fetchMiningStats('ecash', {
      fetchFn: statsResponse({
        inflation_24h: 43_750_000_000,
        blocks_24h: 140,
        difficulty: 5833105685.4014,
        circulation: 2009500839678193,
      }),
    })
    expect(stats?.subsidyCoinsPerBlock).toBeCloseTo(3_125_000, 6)
    expect(stats?.circulatingCoins).toBeCloseTo(20_095_008_396_781.93, 0)
  })

  it('takes no price from the chain statistics', async () => {
    const stats = await fetchMiningStats('bitcoin', {
      fetchFn: statsResponse({
        inflation_24h: 312_500_000,
        blocks_24h: 1,
        difficulty: 1,
        circulation: 100_000_000,
        market_price_usd: 0,
      }),
    })
    expect(stats).toMatchObject({ subsidyCoinsPerBlock: 3.125, difficulty: 1 })
    expect(Object.keys(stats ?? {}).sort()).toEqual([
      'chain',
      'circulatingCoins',
      'difficulty',
      'fetchedAt',
      'hashesPerBlock',
      'subsidyCoinsPerBlock',
    ])
  })

  it.each([
    ['a failed request', statsResponse({}, false)],
    [
      'a missing difficulty',
      statsResponse({ inflation_24h: 1, blocks_24h: 1, circulation: 1 }),
    ],
    [
      'no blocks in the day',
      statsResponse({
        inflation_24h: 1,
        blocks_24h: 0,
        difficulty: 1,
        circulation: 1,
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

  it('reads Monero, whose difficulty is hashes per block and whose subsidy is the tail emission', async () => {
    // The figures Blockchair returned for monero on 2026-10-10: it publishes no issuance.
    const stats = await fetchMiningStats('monero', {
      fetchFn: statsResponse({
        inflation_24h: null,
        blocks_24h: null,
        difficulty: 753447676646,
        circulation: 1.881567909076546e19,
      }),
    })
    expect(stats?.subsidyCoinsPerBlock).toBe(0.6)
    expect(stats?.hashesPerBlock).toBe(753447676646)
    expect(stats?.circulatingCoins).toBeCloseTo(18_815_679.09, 2)
  })

  it('answers nothing for a chain it has no unit scale for', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch
    expect(await fetchMiningStats('kaspa', { fetchFn })).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
