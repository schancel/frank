import { readFileSync } from 'fs'
import { join } from 'path'
import {
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
