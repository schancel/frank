/** @jest-environment node */

/**
 * The oracle store against a real relay (the cashwebd-exe binary with [registry.oracle]),
 * with nothing between them stubbed: the store's own source asks the relay's
 * /oracle/v1/feed and the answer becomes the local series and the AVU rates.
 *
 * Runs only when FRANK_ORACLE_LIVE_RELAY_URL names a running relay, e.g.
 *   FRANK_ORACLE_LIVE_RELAY_URL=http://127.0.0.1:8098 \
 *     yarn --cwd app jest src/stores/oracle.live-relay.jest.test.ts
 */
import { setActivePinia, createPinia } from 'pinia'
import { useOracleStore } from './oracle'
import * as oracleSdk from '@frank/wallet/oracle'

// Everything real; the temporary direct adapter is only watched, and must stay unused.
jest.mock('@frank/wallet/oracle', () => {
  const real = jest.requireActual('@frank/wallet/oracle')
  return { ...real, temporaryDirectFeed: jest.fn(real.temporaryDirectFeed) }
})

const RELAY = process.env.FRANK_ORACLE_LIVE_RELAY_URL
const live = RELAY ? describe : describe.skip

live('the oracle store against a real relay', () => {
  const temporaryDirectFeed = oracleSdk.temporaryDirectFeed as jest.Mock
  let requests: string[]
  const realFetch = globalThis.fetch

  beforeEach(() => {
    process.env.MONAD_RELAY_BASE_URL = RELAY
    setActivePinia(createPinia())
    requests = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      return realFetch(input, init)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('reads latest from its relay, values coins from it, and never uses the direct adapter', async () => {
    const store = useOracleStore()
    await store.fetchLatest()

    expect(requests).toEqual([`${RELAY}/oracle/v1/feed?latest`])
    expect(temporaryDirectFeed).not.toHaveBeenCalled()

    // The answer is in the local series the charts and balances read.
    const inputs = store.inputs
    expect(inputs).toBeDefined()
    const price = inputs?.series['price/btc-mainnet']?.points ?? []
    expect(price.length).toBeGreaterThan(0)
    expect(price[price.length - 1][1]).toBeGreaterThan(1000)
    expect(
      inputs?.series['electricity/aggregate']?.points.length,
    ).toBeGreaterThan(0)

    // And both readings of AVU, and a coin's rate, come out of it.
    expect(store.avuHash?.kwhPerValue).toBeGreaterThan(0)
    expect(store.avuSpot.kwhPerValue).toBeGreaterThan(0)
    expect(store.rates.bitcoin).toBeGreaterThan(0)
    expect(store.lastLatestAt()).toBeGreaterThan(0)
  })

  it('asks the relay for a range once and appends it to the same local series', async () => {
    const store = useOracleStore()
    await store.fetchLatest()
    const before = store.inputs?.series['price/btc-mainnet']?.points.length ?? 0
    const now = Math.floor(Date.now() / 1000)

    await store.ensureHistory(now - 400 * 86_400, 86_400)

    const ranges = requests.filter(url => url.includes('since='))
    expect(ranges.length).toBeGreaterThan(0)
    expect(
      ranges.every(url => url.startsWith(`${RELAY}/oracle/v1/feed?since=`)),
    ).toBe(true)
    expect(
      store.inputs?.series['price/btc-mainnet']?.points.length,
    ).toBeGreaterThan(before)
    expect(temporaryDirectFeed).not.toHaveBeenCalled()

    // Held now: asking again asks nobody.
    const asked = requests.length
    await store.ensureHistory(now - 400 * 86_400, 86_400)
    expect(requests.length).toBe(asked)
  })
})
