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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const recorded = require('./fixtures/blockchair-stats-2026-10-10.json')

describe('the scrypt and RandomX chains, against what Blockchair answered on 2026-10-10', () => {
  it('reads Litecoin: 8 decimals, and difficulty x 2^32 expected hashes per block', async () => {
    const stats = await fetchMiningStats('litecoin', {
      fetchFn: statsResponse(recorded.litecoin),
    })
    // 3,518.75851979 LTC minted in 563 blocks: 6.25 LTC a block (halved August 2023).
    expect(stats?.subsidyCoinsPerBlock).toBeCloseTo(6.25, 4)
    expect(stats?.circulatingCoins).toBeCloseTo(77_700_417.14498554, 3)
    expect(stats?.hashesPerBlock).toBe(95937773.26992714 * 2 ** 32)
    // Unit check against the hashrate the same answer reports: expected hashes per block
    // over the 150-second block time is 2.75e15 H/s; Blockchair says 2.69e15.
    const impliedHashrate = stats!.hashesPerBlock / 150
    expect(impliedHashrate / Number(recorded.litecoin.hashrate_24h)).toBeCloseTo(1, 0)
  })

  it('reads Dogecoin: 8 decimals, 10,000 DOGE a block, the same difficulty rule', async () => {
    const stats = await fetchMiningStats('dogecoin', {
      fetchFn: statsResponse(recorded.dogecoin),
    })
    expect(stats?.subsidyCoinsPerBlock).toBe(10_000)
    expect(stats?.circulatingCoins).toBeCloseTo(156_268_596_383.7, 0)
    expect(stats?.hashesPerBlock).toBe(45261326.03663414 * 2 ** 32)
    // 60-second blocks: 3.24e15 H/s implied; Blockchair says 3.09e15.
    expect(
      stats!.hashesPerBlock / 60 / Number(recorded.dogecoin.hashrate_24h),
    ).toBeCloseTo(1, 0)
  })

  it('reads Monero: 12 decimals, and the difficulty itself is the expected hashes per block', async () => {
    const stats = await fetchMiningStats('monero', {
      fetchFn: statsResponse(recorded.monero),
    })
    // No 2^32 factor.
    expect(stats?.hashesPerBlock).toBe(735582551412)
    // Unit check: 735,582,551,412 hashes over the 120-second block time is
    // 6,129,854,595 H/s, exactly the hashrate the same answer reports.
    expect(Math.round(stats!.hashesPerBlock / 120)).toBe(
      recorded.monero.hashrate_24h,
    )
    expect(stats?.circulatingCoins).toBeCloseTo(18_815_849.49018812, 3)
    // Blockchair publishes no issuance for Monero (no inflation_24h, no blocks_24h): the
    // block reward is the consensus tail emission, 0.6 XMR.
    expect(recorded.monero.inflation_24h).toBeUndefined()
    expect(stats?.subsidyCoinsPerBlock).toBe(0.6)
  })
})
