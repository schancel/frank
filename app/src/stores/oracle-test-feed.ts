/**
 * Test support: small, hand-made oracle feeds. Not a relay stand-in: tests hand these to
 * the store at the one seam it asks for the feed through (useFeedSource).
 */
import type { FeedRequest, OracleFeed, SeriesPoint } from '@frank/wallet/oracle'

export const TEST_BASKET: OracleFeed['basket'] = {
  weightCap: { entry: 'bitcoin', max: 0.6 },
  entries: [
    {
      id: 'bitcoin',
      label: 'BTC',
      algorithm: 'sha256',
      chains: [{ chain: 'btc-mainnet', hashesPerDifficulty: 1 }],
    },
    {
      id: 'monero',
      label: 'XMR',
      algorithm: 'randomx',
      chains: [{ chain: 'xmr-mainnet', hashesPerDifficulty: 1 }],
    },
  ],
}

export const TEST_ELECTRICITY: OracleFeed['electricity'] = {
  windowDays: 30,
  regions: [
    { id: 'test', label: 'Test region day-ahead', attribution: 'Test market' },
  ],
}

function series(points: SeriesPoint[], source = 'test') {
  const asOf = points.length > 0 ? points[points.length - 1][0] : 0
  return { unit: 'test', source, asOf, stale: false, points }
}

/**
 * A feed in which Bitcoin alone makes AVU_hash exactly `kwhPerValue` at every one of
 * `times`: price 100, reward 1, efficiency 1, so value per kWh = 100 / difficulty and the
 * difficulty is 100 x kwhPerValue. `prices` are per feed asset id.
 */
export function testFeed(
  times: number[],
  options: {
    kwhPerValue?: number
    prices?: Record<string, number>
    electricity?: SeriesPoint[]
  } = {},
): OracleFeed {
  const kwhPerValue = options.kwhPerValue ?? 10
  const at = (value: number): SeriesPoint[] => times.map(t => [t, value])
  const feed: OracleFeed = {
    version: 1,
    generatedAt: times[times.length - 1] ?? 0,
    basket: TEST_BASKET,
    electricity: TEST_ELECTRICITY,
    series: {
      'price/btc-mainnet': series(at(100), 'test prices'),
      'marketCap/btc-mainnet': series(at(1e12)),
      'difficulty/btc-mainnet': series(
        at(100 * kwhPerValue),
        'test chain statistics',
      ),
      'blockReward/btc-mainnet': series(at(1)),
      'efficiency/sha256': series(at(1), 'test efficiency'),
    },
  }
  for (const [asset, price] of Object.entries(options.prices ?? {})) {
    feed.series[`price/${asset}`] = series(at(price), 'test prices')
  }
  if (options.electricity) {
    feed.series['electricity/aggregate'] = series(
      options.electricity,
      'test electricity',
    )
  }
  return feed
}

/** A feed source that records what it was asked and answers from `answer`. */
export function recordingSource(
  answer: (request: FeedRequest) => OracleFeed | undefined,
) {
  const requests: FeedRequest[] = []
  const source = async (request: FeedRequest) => {
    requests.push(request)
    return answer(request)
  }
  return { source, requests }
}
