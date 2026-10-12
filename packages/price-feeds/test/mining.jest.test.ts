import { fetchMiningStats } from '../src'

function responses(
  overrides: Record<string, unknown> = {},
  aggregate: Record<string, unknown> = {},
) {
  return jest.fn(async (url: string) => ({
    ok: true,
    json: async () => ({
      data: url.includes('/stats')
        ? {
            inflation_24h: 1_000_000_000,
            blocks_24h: 10,
            best_block_height: 109,
            best_block_time: '2026-10-10 17:00:00',
            circulation: 2_000_000_000_000_000,
            hashrate_24h: '123456789',
            difficulty: -100,
            ...overrides,
          }
        : [
            {
              'sum(generation)': 1_000_000_000,
              'sum(fee_total)': 100_000,
              'count()': 10,
              ...aggregate,
            },
          ],
    }),
  })) as unknown as typeof fetch
}

describe('observed mining receipts and work', () => {
  it.each([
    ['bitcoin', 1e8],
    ['bitcoin-cash', 1e8],
    ['litecoin', 1e8],
    ['dogecoin', 1e8],
    ['ecash', 100],
  ])(
    'normalizes %s receipts in native coins and uses observed hashrate even with invalid difficulty',
    async (chain, unit) => {
      const fetchFn = responses()
      const stats = await fetchMiningStats(chain as string, { fetchFn })
      expect(stats).toMatchObject({
        subsidyCoins24h: 1e9 / Number(unit),
        feeCoins24h: 1e5 / Number(unit),
        hashrate24h: 123456789,
        observationEnd: Date.parse('2026-10-10T17:00:00Z') / 1000,
        firstBlock: 100,
        lastBlock: 109,
      })
      const subsidyOnly = await fetchMiningStats(chain as string, {
        fetchFn: responses({}, { 'sum(fee_total)': undefined }),
      })
      expect(subsidyOnly?.subsidyCoins24h).toBe(1e9 / Number(unit))
      expect(subsidyOnly?.feeCoins24h).toBeUndefined()
      const query = new URL((fetchFn as jest.Mock).mock.calls[1][0])
        .searchParams
      expect(query.get('q')).toBe('id(100..109)')
      expect(query.get('a')).toBe('sum(fee_total),sum(generation),count()')
    },
  )
  it.each([
    undefined,
    null,
    '',
    '2026-02-30 12:00:00',
    '2026-10-10 24:00:00',
    123,
  ])('rejects absent or invalid provider block time %p', async time => {
    expect(
      await fetchMiningStats('ecash', {
        fetchFn: responses({ best_block_time: time }),
      }),
    ).toBeNull()
  })
  it('accepts explicitly observed zero fees', async () => {
    expect(
      (
        await fetchMiningStats('bitcoin', {
          fetchFn: responses({}, { 'sum(fee_total)': 0 }),
        })
      )?.feeCoins24h,
    ).toBe(0)
  })
  it.each([null, undefined, '', 'bad', -1, Infinity, true])(
    'keeps observed subsidy but never fabricates missing/malformed fees %p',
    async fee => {
      expect(
        await fetchMiningStats('bitcoin', {
          fetchFn: responses({}, { 'sum(fee_total)': fee }),
        }),
      ).toMatchObject({ subsidyCoins24h: 10 })
      expect(
        (
          await fetchMiningStats('bitcoin', {
            fetchFn: responses({}, { 'sum(fee_total)': fee }),
          })
        )?.feeCoins24h,
      ).toBeUndefined()
    },
  )
  it.each([
    { 'count()': 9 },
    { 'sum(generation)': 999 },
    { 'sum(generation)': null },
  ])(
    'does not label mismatched aggregate receipts as observed fees %p',
    async aggregate => {
      expect(
        await fetchMiningStats('bitcoin', {
          fetchFn: responses({}, aggregate),
        }),
      ).toMatchObject({ subsidyCoins24h: 10 })
      expect(
        (
          await fetchMiningStats('bitcoin', {
            fetchFn: responses({}, aggregate),
          })
        )?.feeCoins24h,
      ).toBeUndefined()
    },
  )
  it.each([0, null, undefined, Infinity, 'NaN'])(
    'never substitutes difficulty for absent hashrate %p',
    async h => {
      expect(
        await fetchMiningStats('bitcoin', {
          fetchFn: responses({ hashrate_24h: h }),
        }),
      ).toBeNull()
    },
  )
  it.each([null, undefined, 0, -1, 'bad'])(
    'requires observed stats issuance %p even for subsidy-only',
    async issuance => {
      expect(
        await fetchMiningStats('bitcoin', {
          fetchFn: responses({ inflation_24h: issuance }),
        }),
      ).toBeNull()
    },
  )
  it('does not invent Monero receipts from tail subsidy', async () => {
    expect(
      await fetchMiningStats('monero', {
        fetchFn: responses({ inflation_24h: null, blocks_24h: null }),
      }),
    ).toBeNull()
  })
  it('retains explicitly subsidy-only stats on failed fee aggregate', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            blocks_24h: 10,
            best_block_height: 109,
            best_block_time: '2026-10-10 17:00:00',
            hashrate_24h: 100,
            circulation: 100,
            inflation_24h: 100,
          },
        }),
      })
      .mockResolvedValueOnce({ ok: false }) as unknown as typeof fetch
    expect(await fetchMiningStats('bitcoin', { fetchFn })).toMatchObject({
      subsidyCoins24h: 0.000001,
      hashrate24h: 100,
    })
  })
})
