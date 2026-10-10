/**
 * Bundled long-range history. Every value is copied from a public source file by
 * scripts/build-historical.py (sources and the regeneration command are in that
 * script and in the JSON's `sources`). Nothing here is interpolated or estimated:
 * a year a source does not cover is simply absent.
 */
import data from './us-electricity-gold.json'

export interface AnnualEnergyPoint {
  year: number
  /** Average US industrial electricity price, nominal cents per kWh (EIA). */
  centsPerKwh: number
  /** Gold, nominal US dollars per troy ounce (World Bank). Absent where not published. */
  goldUsd?: number
}

export interface MonthlyElectricityPoint {
  /** YYYY-MM */
  month: string
  centsPerKwh: number
}

export const HISTORICAL_SOURCES: { centsPerKwh: string; goldUsd: string } =
  data.sources

export const US_ANNUAL_ELECTRICITY_AND_GOLD: readonly AnnualEnergyPoint[] =
  data.annual

export const US_MONTHLY_INDUSTRIAL_ELECTRICITY: readonly MonthlyElectricityPoint[] =
  data.monthlyCentsPerKwh

/** kWh one US dollar bought at an industrial tariff given in cents per kWh. */
export function kwhPerDollar(centsPerKwh: number): number {
  return 100 / centsPerKwh
}
