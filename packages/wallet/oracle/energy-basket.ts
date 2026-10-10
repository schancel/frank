/**
 * AVU: 1 AVU = 1 kWh. A unit of account, never a coin, a token or a side of a swap.
 *
 * Two readings of how much energy a unit of value is worth, both computed here from the
 * oracle feed's series and nothing else (docs/protocol/oracle/README.md), by one lookup:
 * the value of a series at a time is its latest point at or before that time.
 *
 * AVU_hash(t) is read off proof-of-work mining. For each entry of the feed's basket (one
 * body of hashing and every chain it is paid by), one kWh of mining earns
 *
 *   sum over its chains of price(t) x blockReward(t) / (difficulty(t) x hashesPerDifficulty)
 *     x efficiency(t)                                                   [value per kWh]
 *
 * and the inverse is kWh per unit of value. AVU_hash is the average of those inverses
 * weighted by market capitalisation, with the capped entry's weight limited
 * (basketWeights). An entry lacking any input at t is left out and the weights are taken
 * over the rest; with none there is no AVU_hash.
 *
 * AVU_spot(t) is read off the wholesale electricity market: the inverse of the mean daily
 * price over the feed's window ending at t.
 *
 * Today's figure and every point of a chart are this same function at different times.
 */
import {
  ELECTRICITY_AGGREGATE,
  at,
  seriesName,
  trailingMean,
  type FeedBasket,
  type FeedElectricity,
  type Timeseries,
} from '@frank/price-feeds'

/** What the formulas read: a feed, or the app's local series under the feed's names. */
export interface OracleInputs {
  basket: FeedBasket
  electricity: FeedElectricity
  series: Record<
    string,
    { points: Timeseries; stale?: boolean; estimatedBefore?: number } | undefined
  >
}

/**
 * Basket weights from market capitalisations. Each weight is the entry's share of the
 * total; if the capped entry's share is above the cap it is set to the cap and the rest is
 * divided among the other entries in proportion to their market capitalisations. Weights
 * sum to 1. The capped entry alone has weight 1: there is nothing to give the rest to.
 */
export function basketWeights(
  marketCaps: Record<string, number>,
  cap: number,
  cappedId: string,
): Record<string, number> {
  const ids = Object.keys(marketCaps).filter(id => marketCaps[id] > 0)
  const total = ids.reduce((sum, id) => sum + marketCaps[id], 0)
  const others = total - (marketCaps[cappedId] > 0 ? marketCaps[cappedId] : 0)
  const capApplies =
    ids.includes(cappedId) && others > 0 && marketCaps[cappedId] / total > cap
  return Object.fromEntries(
    ids.map(id => {
      if (!capApplies) return [id, marketCaps[id] / total]
      return [
        id,
        id === cappedId ? cap : ((1 - cap) * marketCaps[id]) / others,
      ]
    }),
  )
}

export interface AvuHashEntry {
  id: string
  label: string
  /** Value one kWh of this entry's mining earns, in the feed's price unit. */
  valuePerKwh: number
  /** The inverse: kWh per unit of value. */
  kwhPerValue: number
  marketCap: number
  weight: number
  /** The efficiency figure used is an estimate (see the series' estimatedBefore). */
  estimated: boolean
}

/** Which input a left-out entry lacks at the time asked about. */
export type LeftOutReason = 'efficiency' | 'price' | 'chain'

export interface AvuHash {
  /** kWh per unit of value: the weighted average of the entries' kwhPerValue. */
  kwhPerValue: number
  entries: AvuHashEntry[]
  leftOut: Array<{ id: string; label: string; reason: LeftOutReason }>
  /** Entries in the basket, used or not. */
  basketSize: number
  /**
   * The time (unix seconds) of the oldest market or chain reading used: a price, a
   * difficulty or a market capitalisation. Curated steps (efficiency, block reward) are
   * not readings and do not count.
   */
  oldestInputAt: number
  /** A series used was flagged stale by whoever served it. */
  stale: boolean
}

/** AVU_hash at a time. Undefined when no basket entry has all its inputs then. */
export function avuHashAt(inputs: OracleInputs, t: number): AvuHash | undefined {
  const used: Array<Omit<AvuHashEntry, 'weight'>> = []
  const leftOut: AvuHash['leftOut'] = []
  let oldestInputAt = Infinity
  let stale = false

  for (const entry of inputs.basket.entries) {
    const efficiencySeries = inputs.series[seriesName('efficiency', entry.algorithm)]
    const efficiency = at(efficiencySeries?.points, t)
    let reason: LeftOutReason | undefined = efficiency ? undefined : 'efficiency'
    let valuePerHash = 0
    let marketCap = 0
    let entryOldest = Infinity
    let entryStale = false
    for (const chain of reason ? [] : entry.chains) {
      const read = (kind: 'price' | 'marketCap' | 'difficulty' | 'blockReward') => {
        const one = inputs.series[seriesName(kind, chain.chain)]
        const point = at(one?.points, t)
        if (point && one?.stale) entryStale = true
        return point
      }
      const price = read('price')
      if (!price || !(price[1] > 0)) {
        reason = 'price'
        break
      }
      const cap = read('marketCap')
      const difficulty = read('difficulty')
      const reward = read('blockReward')
      if (
        !cap ||
        !difficulty ||
        !reward ||
        !(cap[1] > 0) ||
        !(difficulty[1] > 0) ||
        !(reward[1] > 0)
      ) {
        reason = 'chain'
        break
      }
      valuePerHash +=
        (price[1] * reward[1]) / (difficulty[1] * chain.hashesPerDifficulty)
      marketCap += cap[1]
      entryOldest = Math.min(entryOldest, price[0], cap[0], difficulty[0])
    }
    if (reason || !efficiency || !(valuePerHash > 0)) {
      leftOut.push({ id: entry.id, label: entry.label, reason: reason ?? 'chain' })
      continue
    }
    const valuePerKwh = valuePerHash * efficiency[1]
    used.push({
      id: entry.id,
      label: entry.label,
      valuePerKwh,
      kwhPerValue: 1 / valuePerKwh,
      marketCap,
      estimated:
        efficiencySeries?.estimatedBefore !== undefined &&
        efficiency[0] < efficiencySeries.estimatedBefore,
    })
    oldestInputAt = Math.min(oldestInputAt, entryOldest)
    stale = stale || entryStale
  }

  if (used.length === 0) return undefined
  const weights = basketWeights(
    Object.fromEntries(used.map(e => [e.id, e.marketCap])),
    inputs.basket.weightCap.max,
    inputs.basket.weightCap.entry,
  )
  const entries = used.map(e => ({ ...e, weight: weights[e.id] }))
  return {
    kwhPerValue: entries.reduce((sum, e) => sum + e.weight * e.kwhPerValue, 0),
    entries,
    leftOut,
    basketSize: inputs.basket.entries.length,
    oldestInputAt,
    stale,
  }
}

/** The AVU value of one coin: its price times AVU_hash. kWh per coin. */
export function avuPerCoin(
  price: number,
  avuHash: Pick<AvuHash, 'kwhPerValue'> | undefined,
): number | undefined {
  if (!avuHash || !(avuHash.kwhPerValue > 0) || !(price > 0)) return undefined
  return price * avuHash.kwhPerValue
}

const DAY_SECONDS = 86_400

export type AvuSpot =
  | {
      /** kWh per unit of value at the mean wholesale price of the window. */
      kwhPerValue: number
      /** That mean price, per kWh. */
      meanPricePerKwh: number
      /** Days in the window that had a price. */
      days: number
      /** The time (unix seconds) of the latest daily price used. */
      latestAt: number
      stale: boolean
    }
  | {
      kwhPerValue?: undefined
      /** 'no-data': no price in the window. 'not-positive': their mean is zero or below. */
      unavailable: 'no-data' | 'not-positive'
    }

/**
 * AVU_spot at a time: the inverse of the mean of the daily wholesale prices in the feed's
 * window ending then. The prices are averaged first and the mean is inverted: single days
 * go to zero and below, and a mean of inverses would be meaningless.
 */
export function avuSpotAt(inputs: OracleInputs, t: number): AvuSpot {
  const series = inputs.series[ELECTRICITY_AGGREGATE]
  const mean = trailingMean(
    series?.points,
    t,
    inputs.electricity.windowDays * DAY_SECONDS,
  )
  if (!mean) return { unavailable: 'no-data' }
  if (!(mean.mean > 0)) return { unavailable: 'not-positive' }
  return {
    kwhPerValue: 1 / mean.mean,
    meanPricePerKwh: mean.mean,
    days: mean.count,
    latestAt: mean.latest,
    stale: Boolean(series?.stale),
  }
}
