import example from '../../../docs/protocol/oracle/feed.example.json'
import { feedUrl, fetchOracleFeed, parseOracleFeed } from '../src/feed'

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response)) as typeof fetch
}

describe('the oracle feed contract', () => {
  it('accepts the example in docs/protocol/oracle', () => {
    const feed = parseOracleFeed(example)
    expect(feed).toBeDefined()
    expect(Object.keys(feed!.series).sort()).toEqual(
      Object.keys(example.series).sort(),
    )
    expect(feed!.series['electricity/aggregate'].points[1]).toEqual([
      1791590400, -0.0004,
    ])
  })

  it('refuses a feed whose series is out of order, misnamed or of another version', () => {
    const outOfOrder = JSON.parse(JSON.stringify(example))
    outOfOrder.series['price/btc-mainnet'].points.reverse()
    expect(parseOracleFeed(outOfOrder)).toBeUndefined()
    const misnamed = JSON.parse(JSON.stringify(example))
    misnamed.series['usd/BTC'] = misnamed.series['price/btc-mainnet']
    expect(parseOracleFeed(misnamed)).toBeUndefined()
    expect(parseOracleFeed({ ...example, version: 2 })).toBeUndefined()
  })

  it('names the two request shapes', () => {
    expect(feedUrl('https://relay.example/', { latest: true })).toBe(
      'https://relay.example/oracle/v1/feed?latest',
    )
    expect(
      feedUrl('https://relay.example', { since: 10, until: 20, step: 5 }),
    ).toBe('https://relay.example/oracle/v1/feed?since=10&until=20&step=5')
  })

  it('tells a relay that does not serve the feed from one that failed', async () => {
    const ask = (fetchFn: typeof fetch) =>
      fetchOracleFeed('https://relay.example', { latest: true }, { fetchFn })
    expect((await ask(answering(200, example))).status).toBe('ok')
    expect((await ask(answering(404, {}))).status).toBe('not-served')
    expect((await ask(answering(503, {}))).status).toBe('failed')
    expect((await ask(answering(200, { version: 1 }))).status).toBe('failed')
  })
})
