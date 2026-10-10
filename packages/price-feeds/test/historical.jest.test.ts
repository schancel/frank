import { readFileSync } from 'fs'
import { join } from 'path'
import {
  BTC_MINING_MONTHLY,
  BTC_MINING_SOURCES,
  HISTORICAL_SOURCES,
  US_ANNUAL_ELECTRICITY_AND_GOLD,
  US_MONTHLY_INDUSTRIAL_ELECTRICITY,
  kwhPerDollar,
} from '../src'

const file = JSON.parse(
  readFileSync(
    join(__dirname, '../src/historical/us-electricity-gold.json'),
    'utf8',
  ),
)

describe('bundled long-range history', () => {
  it('is the data file, loaded as data: the exports are its arrays unchanged', () => {
    expect(US_ANNUAL_ELECTRICITY_AND_GOLD).toEqual(file.annual)
    expect(US_MONTHLY_INDUSTRIAL_ELECTRICITY).toEqual(file.monthlyCentsPerKwh)
    expect(HISTORICAL_SOURCES).toEqual(file.sources)
  })

  it('names the published source of each column', () => {
    expect(HISTORICAL_SOURCES.centsPerKwh).toMatch(/EIA.*Table 9\.8.*ESICUUS/)
    expect(HISTORICAL_SOURCES.goldUsd).toMatch(/World Bank.*Pink Sheet/)
    // The file says where each source was downloaded from and on what date.
    expect(HISTORICAL_SOURCES.centsPerKwhUrl).toMatch(/^https:\/\/www\.eia\.gov\//)
    expect(HISTORICAL_SOURCES.goldUsdUrl).toMatch(
      /^https:\/\/thedocs\.worldbank\.org\//,
    )
    expect(HISTORICAL_SOURCES.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('holds the values the sources publish (spot checks against the source files)', () => {
    const year = (y: number) =>
      US_ANNUAL_ELECTRICITY_AND_GOLD.find(p => p.year === y)
    // EIA Table 9.8, industrial, annual average
    expect(year(1960)?.centsPerKwh).toBe(1.1)
    expect(year(1990)?.centsPerKwh).toBe(4.74)
    expect(year(2010)?.centsPerKwh).toBe(6.77)
    expect(year(2024)?.centsPerKwh).toBe(8.13)
    // World Bank Pink Sheet, gold, annual average
    expect(year(1961)?.goldUsd).toBe(35.25)
    expect(year(2024)?.goldUsd).toBe(2387.7)
  })

  it('leaves out what a source does not cover instead of filling it in', () => {
    const years = US_ANNUAL_ELECTRICITY_AND_GOLD.map(p => p.year)
    expect(Math.min(...years)).toBe(1960)
    // The Pink Sheet edition bundled ends at 2024; EIA has 2025.
    expect(US_ANNUAL_ELECTRICITY_AND_GOLD.find(p => p.year === 2025)).toEqual({
      year: 2025,
      centsPerKwh: 8.62,
    })
  })

  it('is not a smooth generated curve: real series move unevenly and reverse', () => {
    const cents = US_ANNUAL_ELECTRICITY_AND_GOLD.map(p => p.centsPerKwh)
    const steps = cents.slice(1).map((v, i) => v - cents[i])
    expect(steps.some(s => s < 0)).toBe(true)
    expect(steps.some(s => s > 0)).toBe(true)
    expect(new Set(steps.map(s => s.toFixed(2))).size).toBeGreaterThan(20)
  })

  it('converts a tariff to kWh per dollar', () => {
    expect(kwhPerDollar(8)).toBeCloseTo(12.5, 6)
  })
})

const miningFile = JSON.parse(
  readFileSync(
    join(__dirname, '../src/historical/btc-mining-monthly.json'),
    'utf8',
  ),
)

describe('bundled Bitcoin mining history (the inputs of AVU_hash)', () => {
  it('is the data file, loaded as data: the exports are its contents unchanged', () => {
    expect(BTC_MINING_MONTHLY).toEqual(miningFile.monthly)
    expect(BTC_MINING_SOURCES).toEqual(miningFile.sources)
  })

  it('states where each input came from and when it was downloaded', () => {
    expect(BTC_MINING_SOURCES.chain).toMatch(/blockchain\.com charts API/)
    expect(BTC_MINING_SOURCES.chainUrls).toHaveLength(4)
    for (const url of BTC_MINING_SOURCES.chainUrls) {
      expect(url).toMatch(/^https:\/\/api\.blockchain\.info\/charts\//)
    }
    expect(BTC_MINING_SOURCES.subsidy).toMatch(/GetBlockSubsidy/)
    expect(BTC_MINING_SOURCES.efficiency).toMatch(/Cambridge.*CBECI/)
    // The efficiency is an estimate and the file says under which assumption.
    expect(BTC_MINING_SOURCES.efficiency).toMatch(/estimate/)
    expect(BTC_MINING_SOURCES.efficiency).toMatch(/0\.05 USD\/kWh/)
    expect(BTC_MINING_SOURCES.efficiencyUrl).toMatch(/^https:\/\/ccaf\.io\//)
    expect(BTC_MINING_SOURCES.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('holds one row per month, in order, with every input present and positive', () => {
    const months = BTC_MINING_MONTHLY.map(m => m.month)
    expect(months).toEqual([...months].sort())
    expect(new Set(months).size).toBe(months.length)
    for (const m of BTC_MINING_MONTHLY) {
      expect(m.month).toMatch(/^\d{4}-\d{2}$/)
      expect(m.btcUsd).toBeGreaterThan(0)
      expect(m.difficulty).toBeGreaterThan(0)
      expect(m.joulesPerTerahashLow).toBeGreaterThan(0)
      expect(m.joulesPerTerahash).toBeGreaterThan(m.joulesPerTerahashLow)
      expect(m.joulesPerTerahashHigh).toBeGreaterThan(m.joulesPerTerahash)
    }
  })

  it('follows the consensus subsidy schedule the supply chart implies', () => {
    const month = (m: string) => BTC_MINING_MONTHLY.find(p => p.month === m)
    expect(month('2012-10')?.subsidyBtc).toBe(50)
    expect(month('2012-12')?.subsidyBtc).toBe(25)
    expect(month('2016-08')?.subsidyBtc).toBe(12.5)
    expect(month('2020-06')?.subsidyBtc).toBe(6.25)
    expect(month('2024-05')?.subsidyBtc).toBe(3.125)
    // The month a halving fell in is the mean of its days: between the two subsidies.
    const halving = month('2024-04')?.subsidyBtc ?? 0
    expect(halving).toBeGreaterThan(3.125)
    expect(halving).toBeLessThan(6.25)
  })

  it('is not a smooth generated curve: difficulty and price both rise and fall', () => {
    const steps = (values: number[]) => values.slice(1).map((v, i) => v - values[i])
    for (const column of ['btcUsd', 'difficulty'] as const) {
      const moves = steps(BTC_MINING_MONTHLY.map(m => m[column]))
      expect(moves.some(s => s < 0)).toBe(true)
      expect(moves.some(s => s > 0)).toBe(true)
    }
  })
})
