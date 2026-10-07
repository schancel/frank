/**
 * Thermodynamic Energy Basket for Frank's Arbitrary Value Unit (AVU).
 *
 * Physical Baseline: 1 AVU = 10 Kilowatt-Hours (kWh) / 36 Megajoules (MJ)
 * of global multi-carrier energy equivalent.
 *
 * Components & Target Weights:
 * - Brent Crude Oil: 35% (Transport & liquid fuels)
 * - Natural Gas (Henry Hub): 25% (Thermal & electric generation)
 * - Nuclear / Clean Base (Uranium U3O8): 15% (Clean base-load generation)
 * - Gold (XAU): 25% (Thermodynamic capital store & volatility dampener)
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
 * Epoch Genesis Anchor Factor:
 * Represents the cost in nominal base currency of 10 kWh of global multi-carrier energy.
 * Baseline: 1 AVU = 10 kWh energy equivalent ≈ $1.25 at epoch t0.
 */
export const AVU_ENERGY_ANCHOR_NOMINAL = 1.25

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
 * Given the current basket index and an asset's spot price,
 * calculates the asset's exchange rate in AVU (1 Asset = X AVU).
 *
 * (Asset / Base) / (Basket / Base) = Asset / Basket = AVU.
 */
export function calculateAvuRate(
  assetSpotPrice: number,
  basketIndex: number,
): number {
  if (assetSpotPrice <= 0 || basketIndex <= 0) return 0
  const basketNominalCost = AVU_ENERGY_ANCHOR_NOMINAL * basketIndex
  return assetSpotPrice / basketNominalCost
}
