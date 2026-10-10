/**
 * TEMPORARY. Delete this file when relays serve GET /oracle/v1/feed
 * (docs/protocol/oracle/README.md), together with everything only it uses: the provider
 * adapters (src/providers), the median sampler and client (src/sampler.ts, src/client.ts),
 * the Blockchair reader (src/mining.ts), and the bundled history under src/historical
 * except what the app still draws from directly. The bundled files then become the
 * relay's seed data.
 *
 * It fills the feed contract from what the app could reach before the relay was the
 * oracle: prices fetched from the public providers (the median of those that answer),
 * chain statistics from Blockchair, and the bundled history. The app uses it only when its
 * relay answers 404 for the feed route.
 *
 * Display and valuation only: never a quote for anything that moves money.
 */
import { PriceFeedsClient } from './client'
import { CHAIN_STATS_REFRESH_INTERVAL_MS } from './config'
import {
  ELECTRICITY_AGGREGATE,
  seriesName,
  type FeedBasket,
  type FeedElectricity,
  type FeedRequest,
  type FeedSeries,
  type OracleFeed,
} from './feed'
import {
  BTC_MINING_MONTHLY,
  BTC_MINING_SOURCES,
  EFFICIENCY_STEPS,
  MINED_CHAINS_MONTHLY,
  MINED_CHAINS_RETRIEVED,
  MINER_SHARE_STEPS,
  WHOLESALE_ELECTRICITY,
  hashesPerKwh,
} from './historical'
import { fetchMiningStats, type MiningStats } from './mining'
import { at, sliceSeries, type SeriesPoint, type Timeseries } from './timeseries'

const SHA256_HASHES_PER_DIFFICULTY = 2 ** 32

/** The basket: the largest mined coins, merge-mined Litecoin and Dogecoin as one entry. */
export const DIRECT_BASKET: FeedBasket = {
  weightCap: { entry: 'bitcoin', max: 0.6 },
  entries: [
    {
      id: 'bitcoin',
      label: 'BTC',
      algorithm: 'sha256',
      chains: [
        { chain: 'btc-mainnet', hashesPerDifficulty: SHA256_HASHES_PER_DIFFICULTY },
      ],
    },
    {
      id: 'bitcoin-cash',
      label: 'BCH',
      algorithm: 'sha256',
      chains: [
        { chain: 'bch-mainnet', hashesPerDifficulty: SHA256_HASHES_PER_DIFFICULTY },
      ],
    },
    {
      id: 'ecash',
      label: 'XEC',
      algorithm: 'sha256',
      chains: [
        { chain: 'xec-mainnet', hashesPerDifficulty: SHA256_HASHES_PER_DIFFICULTY },
      ],
    },
    {
      // One hash earns on both chains: their pay is summed and the energy counted once.
      // Scrypt difficulty is defined as Bitcoin's is: 2^32 expected hashes per unit.
      id: 'scrypt',
      label: 'LTC+DOGE',
      algorithm: 'scrypt',
      chains: [
        { chain: 'ltc-mainnet', hashesPerDifficulty: SHA256_HASHES_PER_DIFFICULTY },
        { chain: 'doge-mainnet', hashesPerDifficulty: SHA256_HASHES_PER_DIFFICULTY },
      ],
    },
    {
      // Monero's difficulty is itself the expected number of hashes per block.
      id: 'monero',
      label: 'XMR',
      algorithm: 'randomx',
      chains: [{ chain: 'xmr-mainnet', hashesPerDifficulty: 1 }],
    },
  ],
}

/**
 * What each feed asset id is asked of the price providers as, and of Blockchair as.
 * Assets with no Blockchair name are priced only (they are not in the basket).
 */
export const DIRECT_ASSETS: Record<string, { symbol: string; blockchair?: string }> = {
  'btc-mainnet': { symbol: 'BTC', blockchair: 'bitcoin' },
  'bch-mainnet': { symbol: 'BCH', blockchair: 'bitcoin-cash' },
  'xec-mainnet': { symbol: 'XEC', blockchair: 'ecash' },
  'ltc-mainnet': { symbol: 'LTC', blockchair: 'litecoin' },
  'doge-mainnet': { symbol: 'DOGE', blockchair: 'dogecoin' },
  'xmr-mainnet': { symbol: 'XMR', blockchair: 'monero' },
  'monad-mainnet': { symbol: 'MON' },
  'ethereum-mainnet': { symbol: 'ETH' },
  'solana-mainnet': { symbol: 'SOL' },
  'hyperliquid-mainnet': { symbol: 'HYPE' },
}

const DAY_SECONDS = 86_400

function seconds(date: string): number {
  // "YYYY-MM" is the start of the month, "YYYY-MM-DD" the start of the day, UTC.
  return Date.parse(date.length === 7 ? `${date}-01T00:00:00Z` : `${date}T00:00:00Z`) / 1000
}

/** The product of two step series, at every time either changes and both have a value. */
export function multiplySeries(a: Timeseries, b: Timeseries): SeriesPoint[] {
  const times = Array.from(new Set([...a, ...b].map(point => point[0]))).sort(
    (x, y) => x - y,
  )
  const product: SeriesPoint[] = []
  for (const time of times) {
    const left = at(a, time)
    const right = at(b, time)
    if (left && right) product.push([time, left[1] * right[1]])
  }
  return product
}

/** The miner's share of a chain's subsidy as a step series; 1 throughout when none is curated. */
function minerShare(chain: string): Timeseries {
  const steps = MINER_SHARE_STEPS[chain]
  // Before the first curated step the miner was paid the whole subsidy.
  return [[0, 1], ...(steps ?? []).map(step => [seconds(step.from), step.share] as const)]
}

function series(
  unit: string,
  source: string,
  retrieved: string,
  points: SeriesPoint[],
  extra: Partial<FeedSeries> = {},
): FeedSeries {
  // Bundled history is as old as its file: it is stale by definition once anything
  // newer could be fetched. A live point replaces it and clears the flag.
  return { unit, source, asOf: seconds(retrieved), stale: true, ...extra, points }
}

let bundled: Record<string, FeedSeries> | undefined

/** Every bundled series, whole. Built once. */
export function bundledSeries(): Record<string, FeedSeries> {
  if (bundled) return bundled
  const all: Record<string, FeedSeries> = {}
  const btcRetrieved = BTC_MINING_SOURCES.retrieved
  const btc = BTC_MINING_MONTHLY.map(month => ({ ...month, t: seconds(month.month) }))
  all[seriesName('price', 'btc-mainnet')] = series(
    'USD',
    'blockchain.com, monthly mean',
    btcRetrieved,
    btc.map(m => [m.t, m.btcUsd]),
  )
  all[seriesName('marketCap', 'btc-mainnet')] = series(
    'USD',
    'blockchain.com, monthly mean',
    btcRetrieved,
    btc.map(m => [m.t, m.btcUsd * m.supplyBtc]),
  )
  all[seriesName('difficulty', 'btc-mainnet')] = series(
    'difficulty',
    'blockchain.com, monthly mean',
    btcRetrieved,
    btc.map(m => [m.t, m.difficulty]),
  )
  all[seriesName('blockReward', 'btc-mainnet')] = series(
    'coins per block to the miner',
    'Bitcoin consensus rule',
    btcRetrieved,
    btc.map(m => [m.t, m.subsidyBtc]),
  )
  // Bitcoin Cash and eCash are mined on the same machines as Bitcoin.
  all[seriesName('efficiency', 'sha256')] = series(
    'hashes/kWh',
    'Cambridge CBECI fleet estimate, curated',
    btcRetrieved,
    btc.map(m => [m.t, 3.6e6 / (m.joulesPerTerahash * 1e-12)]),
    { stale: false },
  )
  for (const algorithm of ['scrypt', 'randomx'] as const) {
    const steps = EFFICIENCY_STEPS[algorithm].steps
    const estimates = steps.filter(step => step.estimate)
    const firstMeasured = steps.find(step => !step.estimate)
    all[seriesName('efficiency', algorithm)] = series(
      'hashes/kWh',
      'best hardware on sale, curated',
      steps[steps.length - 1].retrieved,
      steps.map(step => [
        seconds(step.from),
        hashesPerKwh(step.hashesPerSecond, step.watts),
      ]),
      {
        stale: false,
        ...(estimates.length > 0 && firstMeasured
          ? { estimatedBefore: seconds(firstMeasured.from) }
          : {}),
      },
    )
  }
  for (const [chain, history] of Object.entries(MINED_CHAINS_MONTHLY)) {
    const months = history.monthly.map(row => ({
      t: seconds(row[0]),
      price: row[1],
      difficulty: row[2],
      subsidy: row[3],
      coins: row[4],
    }))
    const label = chain === 'xmr-mainnet' ? 'Kraken and a Monero node, monthly mean' : 'Blockchair, monthly mean'
    all[seriesName('price', chain)] = series(
      'USD',
      label,
      MINED_CHAINS_RETRIEVED,
      months.map(m => [m.t, m.price]),
    )
    all[seriesName('marketCap', chain)] = series(
      'USD',
      label,
      MINED_CHAINS_RETRIEVED,
      months.map(m => [m.t, m.price * m.coins]),
    )
    all[seriesName('difficulty', chain)] = series(
      'difficulty',
      label,
      MINED_CHAINS_RETRIEVED,
      months.map(m => [m.t, m.difficulty]),
    )
    all[seriesName('blockReward', chain)] = series(
      'coins per block to the miner',
      label,
      MINED_CHAINS_RETRIEVED,
      multiplySeries(
        months.map(m => [m.t, m.subsidy]),
        minerShare(chain),
      ),
    )
  }
  all[ELECTRICITY_AGGREGATE] = series(
    'USD/kWh',
    'day-ahead wholesale, mean of regions, bundled',
    WHOLESALE_ELECTRICITY.retrieved,
    WHOLESALE_ELECTRICITY.aggregate.daily.map(day => [seconds(day[0]), day[1]]),
  )
  for (const [region, data] of Object.entries(WHOLESALE_ELECTRICITY.regions)) {
    all[seriesName('electricity', region)] = series(
      'USD/kWh',
      data.label,
      WHOLESALE_ELECTRICITY.retrieved,
      data.daily.map(day => [seconds(day[0]), day[1]]),
    )
  }
  bundled = all
  return all
}

export const DIRECT_ELECTRICITY: FeedElectricity = {
  windowDays: 30,
  regions: Object.entries(WHOLESALE_ELECTRICITY.regions).map(([id, region]) => ({
    id,
    label: region.label,
    attribution: region.attribution,
  })),
}

function isElectricity(name: string): boolean {
  return name.startsWith('electricity/')
}

/** The bundled history for a range, cut as the contract says a range answer is. */
export function bundledFeed(
  request: { since: number; until: number; step: number },
  now = Date.now(),
): OracleFeed {
  const window = DIRECT_ELECTRICITY.windowDays * DAY_SECONDS
  const out: Record<string, FeedSeries> = {}
  for (const [name, one] of Object.entries(bundledSeries())) {
    const points = isElectricity(name)
      ? one.points.filter(
          point => point[0] > request.since - window && point[0] <= request.until,
        )
      : sliceSeries(one.points, request.since, request.until, request.step)
    if (points.length > 0) out[name] = { ...one, points }
  }
  return {
    version: 1,
    generatedAt: Math.floor(now / 1000),
    basket: DIRECT_BASKET,
    electricity: DIRECT_ELECTRICITY,
    series: out,
  }
}

export interface DirectFeedOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  now?: () => number
  /** Stand-ins for the two direct fetches, for tests. */
  fetchPrices?: (symbols: string[]) => Promise<Record<string, number>>
  fetchStats?: (blockchairChain: string) => Promise<MiningStats | null>
}

/** The chain statistics last fetched, kept so Blockchair is asked once an hour at most. */
const statsCache = new Map<string, MiningStats>()

/** Forgets the fetched chain statistics. For tests. */
export function resetDirectFeedCache(): void {
  statsCache.clear()
}

async function medianPrices(
  symbols: string[],
  options: DirectFeedOptions,
): Promise<Record<string, number>> {
  const client = new PriceFeedsClient({
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs ?? 4000,
    defaultStrategy: 'median',
  })
  const prices: Record<string, number> = {}
  try {
    const sampled = await client.getSnapshot(symbols)
    for (const symbol of symbols) {
      const price = sampled[symbol]?.price
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        prices[symbol] = price
      }
    }
  } catch {
    // No prices: the feed carries the bundled values, marked stale.
  }
  return prices
}

/**
 * The latest answer, filled directly: one point per series. A price or a chain's
 * statistics that could not be fetched leaves the last bundled value in its place, with
 * its own old time and the stale flag; where there is none either, the series is absent.
 */
export async function directLatestFeed(
  options: DirectFeedOptions = {},
): Promise<OracleFeed> {
  const clock = options.now ?? Date.now
  const now = clock()
  const fetchStats =
    options.fetchStats ??
    ((chain: string) =>
      fetchMiningStats(chain, {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
      }))
  const symbols = Object.values(DIRECT_ASSETS).map(asset => asset.symbol)
  const due = Object.values(DIRECT_ASSETS).flatMap(asset => {
    if (!asset.blockchair) return []
    const held = statsCache.get(asset.blockchair)
    return held && now - held.fetchedAt < CHAIN_STATS_REFRESH_INTERVAL_MS
      ? []
      : [asset.blockchair]
  })
  const [prices] = await Promise.all([
    (options.fetchPrices ?? (s => medianPrices(s, options)))(symbols),
    ...due.map(async chain => {
      const stats = await fetchStats(chain).catch(() => null)
      if (stats) statsCache.set(chain, stats)
    }),
  ])

  // Everything is stamped with the time the answers were in, so that a lookup at the
  // feed's own time finds every point of it.
  const nowSeconds = Math.ceil(clock() / 1000)
  const history = bundledSeries()
  const out: Record<string, FeedSeries> = {}
  const live = (unit: string, source: string, time: number, value: number): FeedSeries => ({
    unit,
    source,
    asOf: time,
    stale: false,
    points: [[time, value]],
  })
  const fallback = (name: string) => {
    const one = history[name]
    const last = one && at(one.points, nowSeconds)
    if (one && last) out[name] = { ...one, points: [last] }
  }

  for (const [asset, { symbol, blockchair }] of Object.entries(DIRECT_ASSETS)) {
    const price = prices[symbol]
    const priceName = seriesName('price', asset)
    if (price !== undefined) {
      out[priceName] = live('USD', 'median of public price providers', nowSeconds, price)
    } else {
      fallback(priceName)
    }
    if (!blockchair) continue
    const stats = statsCache.get(blockchair)
    if (!stats) {
      for (const kind of ['marketCap', 'difficulty', 'blockReward'] as const) {
        fallback(seriesName(kind, asset))
      }
      continue
    }
    const statsSeconds = Math.min(nowSeconds, Math.ceil(stats.fetchedAt / 1000))
    const share = at(minerShare(asset), statsSeconds)?.[1] ?? 1
    out[seriesName('difficulty', asset)] = live(
      'difficulty',
      'Blockchair',
      statsSeconds,
      stats.difficulty,
    )
    out[seriesName('blockReward', asset)] = live(
      'coins per block to the miner',
      'Blockchair',
      statsSeconds,
      stats.subsidyCoinsPerBlock * share,
    )
    // The market capitalisation is a price times a supply; it has the older time of the two.
    const pricePoint = out[priceName]?.points[0]
    if (pricePoint) {
      out[seriesName('marketCap', asset)] = {
        ...live(
          'USD',
          'price x coins in existence (Blockchair)',
          Math.min(pricePoint[0], statsSeconds),
          pricePoint[1] * stats.circulatingCoins,
        ),
        stale: out[priceName].stale,
      }
    }
  }
  for (const name of Object.keys(history)) {
    if (name.startsWith('efficiency/')) fallback(name)
    if (isElectricity(name)) {
      const window = DIRECT_ELECTRICITY.windowDays * DAY_SECONDS
      const points = history[name].points.filter(
        point => point[0] > nowSeconds - window && point[0] <= nowSeconds,
      )
      if (points.length > 0) out[name] = { ...history[name], points }
    }
  }
  return {
    version: 1,
    generatedAt: nowSeconds,
    basket: DIRECT_BASKET,
    electricity: DIRECT_ELECTRICITY,
    series: out,
  }
}

/** Answers a feed request without a relay. See the note at the top of this file. */
export function temporaryDirectFeed(
  request: FeedRequest,
  options: DirectFeedOptions = {},
): Promise<OracleFeed> {
  return 'latest' in request
    ? directLatestFeed(options)
    : Promise.resolve(bundledFeed(request, (options.now ?? Date.now)()))
}
