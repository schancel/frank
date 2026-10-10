import {
  fetchPriceHistory,
  HISTORY_RANGES,
  COINBASE_CANDLES_URL,
  KRAKEN_OHLC_URL,
  BINANCE_US_KLINES_URL,
  COINGECKO_COINS_URL,
} from '../src'

const NOW = 1_791_612_000_000
const HOUR = 3_600_000

function json(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response
}

/** Answers each provider's URL from the table; anything else fails like a dead network. */
function fetchFrom(table: Record<string, unknown>) {
  return jest.fn(async (url: string) => {
    for (const [prefix, body] of Object.entries(table)) {
      if (url.startsWith(prefix)) return json(body)
    }
    throw new Error('network down')
  }) as unknown as typeof fetch
}

describe('fetchPriceHistory', () => {
  it('returns exactly the closes Coinbase published, oldest first', async () => {
    // Coinbase answers newest first: [time s, low, high, open, close, volume]
    const candles = [
      [(NOW - 1 * HOUR) / 1000, 1, 9, 5, 82738.39, 1],
      [(NOW - 2 * HOUR) / 1000, 1, 9, 5, 82771.47, 1],
      [(NOW - 3 * HOUR) / 1000, 1, 9, 5, 82614.27, 1],
    ]
    const fetchFn = fetchFrom({ [COINBASE_CANDLES_URL]: candles })
    const history = await fetchPriceHistory('btc', '24h', {
      fetchFn,
      now: NOW,
    })

    expect(history.provider).toBe('coinbase')
    expect(history.points).toEqual([
      { timestamp: NOW - 3 * HOUR, price: 82614.27 },
      { timestamp: NOW - 2 * HOUR, price: 82771.47 },
      { timestamp: NOW - 1 * HOUR, price: 82738.39 },
    ])
    const url = (fetchFn as jest.Mock).mock.calls[0][0] as string
    expect(url).toContain('/BTC-USD/candles?granularity=3600')
  })

  it('shows a short history as short: three published points stay three points', async () => {
    const candles = [
      [(NOW - 1 * HOUR) / 1000, 0, 0, 0, 0.025, 1],
      [(NOW - 2 * HOUR) / 1000, 0, 0, 0, 0.0251, 1],
      [(NOW - 3 * HOUR) / 1000, 0, 0, 0, 0.0249, 1],
    ]
    const history = await fetchPriceHistory('MON', '30d', {
      fetchFn: fetchFrom({ [COINBASE_CANDLES_URL]: candles }),
      now: NOW,
    })
    expect(history.points).toHaveLength(3)
    expect(history.points.map(p => p.price)).toEqual([0.0249, 0.0251, 0.025])
  })

  it('falls through to Kraken, reading the close of each OHLC row', async () => {
    const fetchFn = fetchFrom({
      [KRAKEN_OHLC_URL]: {
        error: [],
        result: {
          XXBTZUSD: [
            [(NOW - 2 * HOUR) / 1000, '1', '2', '0.5', '82589.6', '1', '1', 1],
            [(NOW - 1 * HOUR) / 1000, '1', '2', '0.5', '82631.6', '1', '1', 1],
          ],
          last: 1791529200,
        },
      },
    })
    const history = await fetchPriceHistory('BTC', '24h', {
      fetchFn,
      now: NOW,
    })
    expect(history.provider).toBe('kraken')
    expect(history.points.map(p => p.price)).toEqual([82589.6, 82631.6])
  })

  it('never asks binance.us for XEC, whose market there has no trades', async () => {
    const fetchFn = fetchFrom({
      [BINANCE_US_KLINES_URL]: [[NOW - HOUR, '9', '9', '9', '0.00000911']],
      [`${COINGECKO_COINS_URL}/ecash`]: {
        prices: [
          [NOW - 2 * HOUR, 7.29e-6],
          [NOW - 2 * HOUR + 300_000, 7.28e-6],
          [NOW - 1 * HOUR, 7.24e-6],
        ],
      },
    })
    const history = await fetchPriceHistory('XEC', '24h', {
      fetchFn,
      now: NOW,
    })
    expect(history.provider).toBe('coingecko')
    const urls = (fetchFn as jest.Mock).mock.calls.map(c => c[0] as string)
    expect(urls.some(u => u.startsWith(BINANCE_US_KLINES_URL))).toBe(false)
    // CoinGecko's finer points are thinned to observed values, one per hour, not averaged.
    for (const point of history.points) {
      expect([7.29e-6, 7.28e-6, 7.24e-6]).toContain(point.price)
    }
  })

  it('has no points at all when every provider fails: no line is made up', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    for (const range of Object.keys(HISTORY_RANGES) as Array<
      keyof typeof HISTORY_RANGES
    >) {
      const history = await fetchPriceHistory('ETH', range, {
        fetchFn,
        now: NOW,
      })
      expect(history).toEqual({
        asset: 'ETH',
        range,
        provider: null,
        points: [],
      })
    }
  })

  it('has no points for an asset no provider lists', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch
    const history = await fetchPriceHistory('TUSD', '7d', {
      fetchFn,
      now: NOW,
    })
    expect(history.points).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('drops rows a provider sent without a usable price, and rows outside the range', async () => {
    const candles = [
      [(NOW - 1 * HOUR) / 1000, 0, 0, 0, 100, 1],
      [(NOW - 2 * HOUR) / 1000, 0, 0, 0, 0, 1],
      [(NOW - 3 * HOUR) / 1000, 0, 0, 0, 'n/a', 1],
      [(NOW - 40 * HOUR) / 1000, 0, 0, 0, 90, 1],
    ]
    const history = await fetchPriceHistory('SOL', '24h', {
      fetchFn: fetchFrom({ [COINBASE_CANDLES_URL]: candles }),
      now: NOW,
    })
    expect(history.points).toEqual([{ timestamp: NOW - HOUR, price: 100 }])
  })
})
