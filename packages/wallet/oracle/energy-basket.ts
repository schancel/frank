/**
 * Thermodynamic Proof-of-Work Energy Standard for Frank's Arbitrary Value Unit (AVU).
 *
 * Physical Baseline: 1 AVU = 1 Kilowatt-Hour (kWh) / 3.6 Megajoules (MJ)
 * of physical computation.
 *
 * Empirical Benchmark:
 * Derived from the global Proof-of-Work mining fleet (Bitcoin, Bitcoin Cash, eCash,
 * Merged Scrypt, Kaspa). The empirical cost of physical electricity converges to:
 * 0.084 USD per kWh (matching the US EIA National Industrial Average of $0.082/kWh).
 *
 * Inverting this rate yields:
 * 1 USD ≈ 11.90 AVU (11.90 kWh of digital hashing energy per dollar).
 */

export interface EnergyBasketConstituent {
  name: string
  symbol: string
  weight: number
  /** Reference anchor price in nominal currency (e.g. USD) at epoch genesis */
  referencePrice: number
  /** Energy density equivalent (in kWh per market unit) */
  energyKwhPerUnit: number
}

/**
 * Macro commodity multi-carrier basket (used for macro volatility dampening).
 */
export const ENERGY_BASKET_CONSTITUENTS: Record<
  string,
  EnergyBasketConstituent
> = {
  brentCrude: {
    name: 'Brent Crude Oil',
    symbol: 'BRENT',
    weight: 0.35,
    referencePrice: 75.0, // $75 / bbl
    energyKwhPerUnit: 1700, // ~1,700 kWh / barrel (6.1 GJ)
  },
  naturalGas: {
    name: 'Natural Gas (Henry Hub)',
    symbol: 'NATGAS',
    weight: 0.25,
    referencePrice: 2.5, // $2.50 / MMBtu
    energyKwhPerUnit: 293, // ~293 kWh / MMBtu (1.055 GJ)
  },
  nuclear: {
    name: 'Uranium (U3O8)',
    symbol: 'U3O8',
    weight: 0.15,
    referencePrice: 80.0, // $80 / lb
    energyKwhPerUnit: 55555, // in commercial nuclear fuel cycle
  },
  gold: {
    name: 'Physical Gold',
    symbol: 'XAU',
    weight: 0.25,
    referencePrice: 2650.0, // $2,650 / troy oz
    energyKwhPerUnit: 21000, // marginal thermodynamic extraction equivalent
  },
}

/**
 * Physical Baseline Definition:
 * 1 AVU = 1 Kilowatt-Hour (kWh) = 3.6 Megajoules (MJ).
 */
export const AVU_KWH_PER_UNIT = 1.0

/**
 * PoW Mining Energy Baseline:
 * Represents the empirical cost of 1 kWh of physical computation in the decentralized mining fleet.
 * Default baseline: $0.084 / kWh (~8.40 cents/kWh).
 */
export const POW_BASELINE_DOLLARS_PER_KWH = 0.084

/**
 * Legacy alias for backwards compatibility.
 * Represents the cost in nominal base currency (USD) of 1 AVU (1 kWh).
 */
export const AVU_ENERGY_ANCHOR_NOMINAL = POW_BASELINE_DOLLARS_PER_KWH

/**
 * Conversion Multiplier:
 * Inverted cost of energy, representing how many AVU (kWh) $1 USD commands in the mining economy.
 * 1 / $0.084 ≈ 11.90476 AVU / $.
 */
export const AVU_PER_DOLLAR = 1 / POW_BASELINE_DOLLARS_PER_KWH

export interface PoWNetworkConfig {
  id: string
  name: string
  algo: string
  joulesPerHash: number
  blockSubsidy: number
  blockTimeSec: number
}

export const POW_NETWORKS: Record<string, PoWNetworkConfig> = {
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin (BTC)',
    algo: 'SHA-256',
    joulesPerHash: 17.5e-12, // 17.5 J/TH (Antminer S21 tier)
    blockSubsidy: 3.125,
    blockTimeSec: 600,
  },
  bitcoinCash: {
    id: 'bitcoinCash',
    name: 'Bitcoin Cash (BCH)',
    algo: 'SHA-256',
    joulesPerHash: 17.5e-12,
    blockSubsidy: 3.125,
    blockTimeSec: 600,
  },
  ecash: {
    id: 'ecash',
    name: 'eCash (XEC)',
    algo: 'SHA-256',
    joulesPerHash: 17.5e-12,
    blockSubsidy: 2125000, // net miner block reward (after 32% fund split)
    blockTimeSec: 600,
  },
  scrypt: {
    id: 'scrypt',
    name: 'Merged Scrypt (LTC + DOGE)',
    algo: 'Scrypt',
    joulesPerHash: 0.59e-6, // 0.59 J/MH (Antminer L9 tier)
    blockSubsidy: 6.25, // LTC base
    blockTimeSec: 150,
  },
  kaspa: {
    id: 'kaspa',
    name: 'Kaspa (KAS)',
    algo: 'kHeavyHash',
    joulesPerHash: 140e-12, // 140 J/TH (KS5 tier)
    blockSubsidy: 2.06,
    blockTimeSec: 0.1, // 10 blocks/sec
  },
}

/**
 * Calculates physical energy cost (Dollars per kWh) and AVU multiplier
 * for a mining network given live stats.
 *
 * Formula:
 * Revenue/sec = (Spot Price * Block Reward) / BlockTimeSec
 * Power Watts = Hashrate * JoulesPerHash
 * DollarsPerJoule = Revenue/sec / Power Watts
 * DollarsPerKwh = DollarsPerJoule * 3,600,000
 * AvuPerDollar = 1 / DollarsPerKwh
 */
export function calculatePoWEnergyCost(params: {
  spotPriceUsd: number
  rewardPerBlock: number
  blockTimeSec: number
  hashrateHps: number
  joulesPerHash: number
}): {
  revenuePerSec: number
  powerWatts: number
  dollarsPerKwh: number
  avuPerDollar: number
} {
  if (
    params.spotPriceUsd <= 0 ||
    params.rewardPerBlock <= 0 ||
    params.blockTimeSec <= 0 ||
    params.hashrateHps <= 0 ||
    params.joulesPerHash <= 0
  ) {
    return {
      revenuePerSec: 0,
      powerWatts: 0,
      dollarsPerKwh: POW_BASELINE_DOLLARS_PER_KWH,
      avuPerDollar: AVU_PER_DOLLAR,
    }
  }

  const revenuePerSec =
    (params.spotPriceUsd * params.rewardPerBlock) / params.blockTimeSec
  const powerWatts = params.hashrateHps * params.joulesPerHash
  const dollarsPerJoule = revenuePerSec / powerWatts
  const dollarsPerKwh = dollarsPerJoule * 3.6e6
  const avuPerDollar = dollarsPerKwh > 0 ? 1 / dollarsPerKwh : 0

  return {
    revenuePerSec,
    powerWatts,
    dollarsPerKwh,
    avuPerDollar,
  }
}

/**
 * Computes the normalized geometric mean index from spot constituent prices.
 *
 * Formula: Index(t) = Product_{i=1..n} (P_i(t) / P_i(0)) ^ w_i
 */
export function computeEnergyBasketIndex(
  currentPrices: Partial<Record<string, number>> = {},
): number {
  let logSum = 0
  let totalWeight = 0

  for (const [key, constituent] of Object.entries(ENERGY_BASKET_CONSTITUENTS)) {
    const spot = currentPrices[key] ?? constituent.referencePrice
    if (spot > 0) {
      const ratio = spot / constituent.referencePrice
      logSum += constituent.weight * Math.log(ratio)
      totalWeight += constituent.weight
    }
  }

  if (totalWeight <= 0) return 1.0
  const normalizedLogSum = logSum / totalWeight
  return Math.exp(normalizedLogSum)
}

/**
 * Given an asset's spot price in USD, calculates the asset's exchange rate in AVU
 * (where 1 AVU = 1 kWh of physical work).
 *
 * Formula: AVU = SpotPrice / (DollarsPerKwh * basketIndex) = SpotPrice * (AVU_PER_DOLLAR / basketIndex)
 */
export function calculateAvuRate(
  assetSpotPrice: number,
  basketIndex = 1.0,
  dollarsPerKwh = POW_BASELINE_DOLLARS_PER_KWH,
): number {
  if (assetSpotPrice <= 0 || basketIndex <= 0 || dollarsPerKwh <= 0) return 0
  const effectiveCostPerKwh = dollarsPerKwh * basketIndex
  return assetSpotPrice / effectiveCostPerKwh
}
