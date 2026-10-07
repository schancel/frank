/**
 * Historical macroeconomic data structures for the Thermodynamic Energy Standard (AVU).
 */

export interface HistoricalMacroPoint {
  /** Calendar year (e.g. 1930) */
  year: number
  /** USD purchasing power in kWh per $1 USD (1 / ($ / kWh)) */
  usdKwh: number
  /** Average retail/industrial electricity tariff in cents per kWh */
  centsPerKwh: number
  /** Gold price in nominal USD per troy ounce (LBMA / US Treasury peg / FRED) */
  goldUsd: number
  /** Implied Gold energy valuation in AVU (kWh per troy ounce = goldUsd * usdKwh) */
  goldAvu: number
  /** Consumer Price Index (CPI-U benchmark, 1982-1984=100) */
  cpiIndex?: number
  /** Implied Proof-of-Work energy purchasing power (kWh/$), available starting 2009 */
  powHashRate?: number
  /** Notable historical or monetary event milestone */
  notes?: string
}

export interface CommodityAnchor {
  name: string
  symbol: string
  unit: string
  /** Reference price at 1971 Bretton Woods suspension */
  price1971: number
  /** Reference price at 2020 epoch */
  price2020: number
  /** Physical energy density in kWh per native unit (if applicable) */
  energyDensityKwh?: number
  notes?: string
}
