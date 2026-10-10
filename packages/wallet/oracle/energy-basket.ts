/**
 * AVU: 1 AVU = 1 kWh. Two readings of how many kWh a dollar is worth.
 *
 * AVU_hash is read off proof-of-work mining and needs no electricity price. For each
 * entry of a basket of mined coins, the dollars one kWh of mining earns are
 *
 *   price [$/coin] x subsidy [coins/block] / hashes per block x efficiency [hashes/kWh]
 *
 * and its inverse is kWh per dollar. AVU_hash is the average of those kWh-per-dollar
 * values over the basket, weighted by market capitalisation with Bitcoin's weight capped
 * (basketWeights). The AVU value of any coin is its price times AVU_hash: kWh per coin.
 *
 * AVU_spot is kWh per dollar from a published electricity price: 1 / ($/kWh). It depends
 * on whoever publishes that price; AVU_hash does not. The two should roughly agree.
 *
 * Nothing here is a typed-in rate. An entry whose inputs are not all known is left out
 * and the weights are taken over the entries that are; with none, there is no AVU_hash.
 */
import {
  BTC_MINING_MONTHLY,
  US_MONTHLY_INDUSTRIAL_ELECTRICITY,
  kwhPerDollar,
  type MiningStats,
} from '@frank/price-feeds'

export const JOULES_PER_KWH = 3.6e6

export type HashAlgorithm = 'sha256' | 'scrypt' | 'randomx'

/** One chain a basket entry's hashing is paid by. */
export interface BasketChain {
  /** Price-feed symbol. */
  symbol: string
  /** Blockchair chain name the chain facts are read under. */
  chain: string
  /** The part of the block subsidy the miner receives; the formula is about miners' pay. */
  minerSubsidyShare: number
}

/**
 * One term of the basket: a body of hashing and every chain that pays for it. Merge-mined
 * chains are one entry, because one hash earns on all of them: their pay per hash is
 * summed and the energy is counted once.
 */
export interface BasketEntry {
  id: string
  label: string
  algorithm: HashAlgorithm
  chains: readonly BasketChain[]
}

/** Bitcoin's weight in the basket is capped at this share. */
export const BITCOIN_WEIGHT_CAP = 0.6
export const BITCOIN_ENTRY_ID = 'bitcoin'

/**
 * The basket: the largest mined coins the owner named (BTC, BCH, DOGE, XEC, XMR), with
 * LTC beside DOGE because the two are merge-mined.
 */
export const AVU_HASH_BASKET: readonly BasketEntry[] = [
  {
    id: BITCOIN_ENTRY_ID,
    label: 'BTC',
    algorithm: 'sha256',
    chains: [{ symbol: 'BTC', chain: 'bitcoin', minerSubsidyShare: 1 }],
  },
  {
    id: 'bitcoin-cash',
    label: 'BCH',
    algorithm: 'sha256',
    chains: [{ symbol: 'BCH', chain: 'bitcoin-cash', minerSubsidyShare: 1 }],
  },
  {
    id: 'ecash',
    label: 'XEC',
    algorithm: 'sha256',
    // eCash consensus sends 32% of the coinbase to the miner fund (MINER_FUND_RATIO,
    // src/policy/block/minerfund.cpp) and 10% to staking rewards (STAKING_REWARD_RATIO,
    // src/policy/block/stakingrewards.cpp); the miner keeps the other 58%.
    // Bitcoin-ABC/bitcoin-abc at f8ae6274, read 2026-10-09.
    chains: [{ symbol: 'XEC', chain: 'ecash', minerSubsidyShare: 0.58 }],
  },
  {
    id: 'scrypt',
    label: 'LTC+DOGE',
    algorithm: 'scrypt',
    chains: [
      { symbol: 'LTC', chain: 'litecoin', minerSubsidyShare: 1 },
      { symbol: 'DOGE', chain: 'dogecoin', minerSubsidyShare: 1 },
    ],
  },
  {
    id: 'monero',
    label: 'XMR',
    algorithm: 'randomx',
    chains: [{ symbol: 'XMR', chain: 'monero', minerSubsidyShare: 1 }],
  },
]

/** Hashes one kWh buys on hardware drawing `joulesPerTerahash`. */
export function hashesPerKwhAt(joulesPerTerahash: number): number {
  return JOULES_PER_KWH / (joulesPerTerahash * 1e-12)
}

export interface HashingEfficiency {
  /** YYYY-MM the figure is for. */
  month: string
  hashesPerKwh: number
}

/**
 * Hashing efficiency per algorithm, by month. This is the one input of AVU_hash that is a
 * curated estimate and not a reading of a chain or a market.
 *
 * SHA-256 is Cambridge's estimate of the Bitcoin fleet (see BTC_MINING_SOURCES); Bitcoin
 * Cash and eCash are mined on the same machines. No series is bundled for scrypt or
 * RandomX, so those basket entries cannot be computed yet and are left out.
 */
export const HASHING_EFFICIENCY: Partial<
  Record<HashAlgorithm, readonly HashingEfficiency[]>
> = {
  sha256: BTC_MINING_MONTHLY.map(m => ({
    month: m.month,
    hashesPerKwh: hashesPerKwhAt(m.joulesPerTerahash),
  })),
}

/** The latest bundled efficiency for an algorithm, or undefined when none is bundled. */
export function latestHashingEfficiency(
  algorithm: HashAlgorithm,
  series = HASHING_EFFICIENCY,
): HashingEfficiency | undefined {
  const months = series[algorithm]
  return months?.[months.length - 1]
}

/**
 * Dollars one kWh of mining earns: price x coins per block / hashes per block x hashes
 * per kWh. Undefined unless every input is a positive number.
 */
export function miningDollarsPerKwh(input: {
  priceUsd: number
  coinsPerBlock: number
  hashesPerBlock: number
  hashesPerKwh: number
}): number | undefined {
  const usdPerHash = miningDollarsPerHash(input)
  return usdPerHash === undefined || !(input.hashesPerKwh > 0)
    ? undefined
    : usdPerHash * input.hashesPerKwh
}

function miningDollarsPerHash(input: {
  priceUsd: number
  coinsPerBlock: number
  hashesPerBlock: number
}): number | undefined {
  if (
    !(input.priceUsd > 0) ||
    !(input.coinsPerBlock > 0) ||
    !(input.hashesPerBlock > 0)
  ) {
    return undefined
  }
  return (input.priceUsd * input.coinsPerBlock) / input.hashesPerBlock
}

/**
 * Basket weights from market capitalisations. Each weight is the entry's share of the
 * total; if Bitcoin's share is above the cap it is set to the cap and the rest is divided
 * among the other entries in proportion to their market capitalisations. Weights sum to 1.
 * Bitcoin alone has weight 1: there is nothing to give the remainder to.
 */
export function basketWeights(
  marketCaps: Record<string, number>,
  cap = BITCOIN_WEIGHT_CAP,
  cappedId = BITCOIN_ENTRY_ID,
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

/** A fetched price and when it was fetched. */
export interface PriceReading {
  usd: number
  fetchedAt: number
}

export interface AvuHashEntry {
  id: string
  label: string
  /** Dollars one kWh of this entry's mining earns. */
  dollarsPerKwh: number
  kwhPerDollar: number
  marketCapUsd: number
  weight: number
}

/** Why a basket entry is not in the computation. */
export type LeftOutReason = 'efficiency' | 'price' | 'chain'

export interface AvuHash {
  /** kWh per dollar: the weighted average of the entries' kWh per dollar. */
  kwhPerDollar: number
  entries: AvuHashEntry[]
  leftOut: Array<{ id: string; label: string; reason: LeftOutReason }>
  /** Entries in the basket, used or not. */
  basketSize: number
  /** The month of the bundled efficiency figures used. */
  efficiencyMonth: string
  /** When the oldest price used was fetched, and the oldest chain statistics. */
  pricesAsOf: number
  chainsAsOf: number
}

/**
 * AVU_hash from fetched prices and chain statistics. Undefined when no basket entry has
 * all its inputs.
 */
export function computeAvuHash(
  prices: Record<string, PriceReading | undefined>,
  mining: Record<string, MiningStats | undefined>,
  basket: readonly BasketEntry[] = AVU_HASH_BASKET,
  efficiencies = HASHING_EFFICIENCY,
): AvuHash | undefined {
  const used: Array<Omit<AvuHashEntry, 'weight'>> = []
  const leftOut: AvuHash['leftOut'] = []
  let efficiencyMonth = ''
  let pricesAsOf = Infinity
  let chainsAsOf = Infinity

  for (const entry of basket) {
    const efficiency = latestHashingEfficiency(entry.algorithm, efficiencies)
    let reason: LeftOutReason | undefined = efficiency
      ? undefined
      : 'efficiency'
    let usdPerHash = 0
    let marketCapUsd = 0
    let entryPricesAsOf = Infinity
    let entryChainsAsOf = Infinity
    for (const chain of reason ? [] : entry.chains) {
      const price = prices[chain.symbol]
      const stats = mining[chain.chain]
      const earned =
        price && stats
          ? miningDollarsPerHash({
              priceUsd: price.usd,
              coinsPerBlock:
                stats.subsidyCoinsPerBlock * chain.minerSubsidyShare,
              hashesPerBlock: stats.hashesPerBlock,
            })
          : undefined
      if (!price || !stats || earned === undefined) {
        reason = price ? 'chain' : 'price'
        break
      }
      usdPerHash += earned
      marketCapUsd += price.usd * stats.circulatingCoins
      entryPricesAsOf = Math.min(entryPricesAsOf, price.fetchedAt)
      entryChainsAsOf = Math.min(entryChainsAsOf, stats.fetchedAt)
    }
    if (reason || !efficiency || !(marketCapUsd > 0)) {
      leftOut.push({ id: entry.id, label: entry.label, reason: reason ?? 'chain' })
      continue
    }
    const dollarsPerKwh = usdPerHash * efficiency.hashesPerKwh
    used.push({
      id: entry.id,
      label: entry.label,
      dollarsPerKwh,
      kwhPerDollar: 1 / dollarsPerKwh,
      marketCapUsd,
    })
    if (efficiency.month > efficiencyMonth) efficiencyMonth = efficiency.month
    pricesAsOf = Math.min(pricesAsOf, entryPricesAsOf)
    chainsAsOf = Math.min(chainsAsOf, entryChainsAsOf)
  }

  if (used.length === 0) return undefined
  const weights = basketWeights(
    Object.fromEntries(used.map(e => [e.id, e.marketCapUsd])),
  )
  const entries = used.map(e => ({ ...e, weight: weights[e.id] }))
  return {
    kwhPerDollar: entries.reduce((sum, e) => sum + e.weight * e.kwhPerDollar, 0),
    entries,
    leftOut,
    basketSize: basket.length,
    efficiencyMonth,
    pricesAsOf,
    chainsAsOf,
  }
}

/** The AVU value of one coin: its price times AVU_hash. kWh per coin. */
export function avuPerCoin(
  priceUsd: number,
  avuHash: Pick<AvuHash, 'kwhPerDollar'> | undefined,
): number | undefined {
  if (!avuHash || !(avuHash.kwhPerDollar > 0) || !(priceUsd > 0)) {
    return undefined
  }
  return priceUsd * avuHash.kwhPerDollar
}

export interface MonthlyAvuHash {
  /** YYYY-MM */
  month: string
  kwhPerDollar: number
}

/**
 * AVU_hash by month from the bundled history, by the same formula. Bitcoin is the only
 * coin whose monthly inputs are bundled, so this is Bitcoin's term alone, not the basket.
 */
export const BTC_MONTHLY_AVU_HASH: readonly MonthlyAvuHash[] =
  BTC_MINING_MONTHLY.flatMap(m => {
    const dollarsPerKwh = miningDollarsPerKwh({
      priceUsd: m.btcUsd,
      coinsPerBlock: m.subsidyBtc,
      hashesPerBlock: m.difficulty * 2 ** 32,
      hashesPerKwh: hashesPerKwhAt(m.joulesPerTerahash),
    })
    return dollarsPerKwh === undefined
      ? []
      : [{ month: m.month, kwhPerDollar: 1 / dollarsPerKwh }]
  })

export interface AvuSpot {
  /** kWh per dollar at the published electricity price. */
  kwhPerDollar: number
  centsPerKwh: number
  /** YYYY-MM the price was published for. */
  month: string
}

/** AVU_spot for the latest month the bundled EIA industrial price covers. */
export function latestAvuSpot(
  monthly = US_MONTHLY_INDUSTRIAL_ELECTRICITY,
): AvuSpot | undefined {
  const latest = monthly[monthly.length - 1]
  return latest
    ? {
        kwhPerDollar: kwhPerDollar(latest.centsPerKwh),
        centsPerKwh: latest.centsPerKwh,
        month: latest.month,
      }
    : undefined
}
