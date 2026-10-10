/**
 * Bundled long-range history. Every value is copied from a public source file by
 * scripts/build-historical.py and scripts/build-btc-mining-history.py (sources and the
 * regeneration commands are in those scripts and in each JSON's `sources`). Nothing here
 * is interpolated: a year or month a source does not cover is simply absent.
 */
import data from './us-electricity-gold.json'
import btcMining from './btc-mining-monthly.json'

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

/** What each column is, where its file was downloaded from, and on what date. */
export const HISTORICAL_SOURCES: {
  centsPerKwh: string
  centsPerKwhUrl: string
  goldUsd: string
  goldUsdUrl: string
  retrieved: string
} = data.sources

export const US_ANNUAL_ELECTRICITY_AND_GOLD: readonly AnnualEnergyPoint[] =
  data.annual

export const US_MONTHLY_INDUSTRIAL_ELECTRICITY: readonly MonthlyElectricityPoint[] =
  data.monthlyCentsPerKwh

/** kWh one US dollar bought at an industrial tariff given in cents per kWh. */
export function kwhPerDollar(centsPerKwh: number): number {
  return 100 / centsPerKwh
}

/**
 * One calendar month of the inputs of Bitcoin's AVU_hash, each the mean of the daily
 * values published for that month. The formula itself is applied by
 * @frank/wallet/oracle, not stored here.
 */
export interface BtcMiningMonth {
  /** YYYY-MM */
  month: string
  /** US dollars per bitcoin. */
  btcUsd: number
  difficulty: number
  /** Bitcoin minted per block. Between two values in the month a halving fell in. */
  subsidyBtc: number
  /**
   * Electricity the mining fleet drew per terahash, in joules: Cambridge's best-guess
   * network power demand divided by the network hashrate. An estimate of the hardware in
   * use, not a chain reading.
   */
  joulesPerTerahash: number
  /** The same from Cambridge's lower and upper bounds on power demand. */
  joulesPerTerahashLow: number
  joulesPerTerahashHigh: number
}

/** What each column is, where its files were downloaded from, and on what date. */
export const BTC_MINING_SOURCES: {
  chain: string
  chainUrls: string[]
  subsidy: string
  efficiency: string
  efficiencyUrl: string
  retrieved: string
} = btcMining.sources

export const BTC_MINING_MONTHLY: readonly BtcMiningMonth[] = btcMining.monthly
