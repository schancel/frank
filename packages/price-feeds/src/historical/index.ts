/**
 * Bundled long-range history. Every value is copied from a public source file by
 * scripts/build-historical.py and scripts/build-btc-mining-history.py (sources and the
 * regeneration commands are in those scripts and in each JSON's `sources`). Nothing here
 * is interpolated: a year or month a source does not cover is simply absent.
 */
import data from './us-electricity-gold.json'
import btcMining from './btc-mining-monthly.json'
import minedChains from './mined-chains-monthly.json'
import curated from './curated-steps.json'
import wholesale from './wholesale-electricity-daily.json'

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
  /** Bitcoin in existence: the mean over the month. */
  supplyBtc: number
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

// ---- Inputs of the basket beyond Bitcoin -----------------------------------------------

/**
 * One calendar month of a mined chain: [YYYY-MM, US dollars per coin, difficulty, coins
 * minted per block (the whole subsidy), coins in existence]. Built by
 * scripts/build-mined-chains-history.py; each chain says where its figures come from.
 */
export type MinedChainMonth = [string, number, number, number, number]

export interface MinedChainHistory {
  source: string
  sourceUrl: string
  firstMonth: string
  monthly: MinedChainMonth[]
}

/** By feed chain id (ltc-mainnet, doge-mainnet, ...). Bitcoin is BTC_MINING_MONTHLY. */
export const MINED_CHAINS_MONTHLY = minedChains.chains as unknown as Record<
  string,
  MinedChainHistory
>
export const MINED_CHAINS_RETRIEVED: string = minedChains.retrieved

/** One curated hardware step: the machine assumed for an algorithm from a date on. */
export interface EfficiencyStep {
  /** YYYY-MM-DD the step holds from. */
  from: string
  hardware: string
  hashesPerSecond: number
  watts: number
  /** What the power figure measures. */
  power: string
  /** True when the step is an estimate and not a rated wall figure. */
  estimate?: boolean
  sourceUrl: string
  sourceNote?: string
  powerSourceUrl?: string
  powerSourceNote?: string
  retrieved: string
}

export const EFFICIENCY_RULE: string = curated.efficiency.rule
export const EFFICIENCY_STEPS: Record<
  'scrypt' | 'randomx',
  { note: string; steps: EfficiencyStep[] }
> = {
  scrypt: curated.efficiency.scrypt,
  randomx: curated.efficiency.randomx,
}

/** Hashes one kWh buys on a machine of this hashrate and power. */
export function hashesPerKwh(hashesPerSecond: number, watts: number): number {
  return (hashesPerSecond * 3600 * 1000) / watts
}

/** The part of the block subsidy consensus pays the miner, from a date on. */
export interface MinerShareStep {
  from: string
  fromHeight: number
  share: number
  split: string
  evidence: string
  retrieved: string
}

/** By feed chain id. A chain absent here pays its miners the whole subsidy. */
export const MINER_SHARE_STEPS: Record<string, MinerShareStep[]> = {
  'xec-mainnet': curated.minerShare['xec-mainnet'].steps,
}

/** A day's wholesale price: [YYYY-MM-DD, US dollars per kWh]. */
export type ElectricityDay = [string, number]

export interface WholesaleRegion {
  label: string
  attribution: string
  sourceUrl: string
  daily: ElectricityDay[]
}

/**
 * Daily wholesale day-ahead electricity prices, built by
 * scripts/build-wholesale-electricity.py. Seed data: the relay is to serve this series.
 */
export const WHOLESALE_ELECTRICITY = wholesale as unknown as {
  unit: string
  retrieved: string
  aggregate: { rule: string; daily: ElectricityDay[] }
  regions: Record<string, WholesaleRegion>
}
