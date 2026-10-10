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

import {
  EFFICIENCY_STEPS,
  MINED_CHAINS_MONTHLY,
  MINER_SHARE_STEPS,
  WHOLESALE_ELECTRICITY,
  hashesPerKwh,
} from '../src'

describe('curated hardware efficiency steps', () => {
  it('cites a source and the date it was read for every step', () => {
    for (const algorithm of ['scrypt', 'randomx'] as const) {
      for (const step of EFFICIENCY_STEPS[algorithm].steps) {
        expect(step.sourceUrl).toMatch(/^https:\/\//)
        expect(step.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(step.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(step.hashesPerSecond).toBeGreaterThan(0)
        expect(step.watts).toBeGreaterThan(0)
      }
    }
  })

  it('is a frontier: steps are in date order and each is more efficient than the last', () => {
    for (const algorithm of ['scrypt', 'randomx'] as const) {
      const steps = EFFICIENCY_STEPS[algorithm].steps
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].from > steps[i - 1].from).toBe(true)
        expect(
          hashesPerKwh(steps[i].hashesPerSecond, steps[i].watts),
        ).toBeGreaterThan(
          hashesPerKwh(steps[i - 1].hashesPerSecond, steps[i - 1].watts),
        )
      }
    }
  })

  it('covers scrypt from before 2020 and RandomX from its activation', () => {
    expect(EFFICIENCY_STEPS.scrypt.steps[0].from <= '2020-01-01').toBe(true)
    expect(EFFICIENCY_STEPS.randomx.steps[0].from).toBe('2019-11-30')
  })

  it('marks the processor steps as estimates and says what their power figure leaves out', () => {
    const steps = EFFICIENCY_STEPS.randomx.steps
    const processors = steps.filter(step => /Ryzen/.test(step.hardware))
    expect(processors.length).toBeGreaterThan(0)
    for (const step of processors) {
      expect(step.estimate).toBe(true)
      expect(step.power).toMatch(/excludes the rest of the system/)
      expect(step.powerSourceUrl).toMatch(/^https:\/\//)
    }
    // No ASIC step is an estimate, and the unshipped Antminer X9 is not a step.
    expect(steps.filter(step => !step.estimate).map(s => s.hardware)).toEqual([
      'Bitmain Antminer X5',
    ])
  })

  it('turns a hashrate and a power into hashes per kWh', () => {
    // Antminer L7: 9.5e9 H/s x 3600 s = 3.42e13 hashes an hour on 3.425 kWh
    // = 9.9854e12 hashes per kWh.
    expect(hashesPerKwh(9.5e9, 3425)).toBeCloseTo(9.985401459854e12, -3)
  })
})

describe('the eCash miner share', () => {
  it('is the split read from the coinbases, with the block each began at', () => {
    const steps = MINER_SHARE_STEPS['xec-mainnet']
    expect(
      steps.map(step => [step.from, step.fromHeight, step.share]),
    ).toEqual([
      ['2020-11-15', 661648, 0.92],
      ['2023-11-15', 818670, 0.58],
    ])
    // The two coinbases the owner named are the evidence of the current split.
    expect(steps[1].evidence).toContain(
      '27038d63376fd9ab0dc0fa18bff95f99ab0353b197c97e2578e1e0549ad56d6f',
    )
    expect(steps[1].evidence).toContain(
      'ebded42bd26ccff2c9fcd64547e177964d48e5d3a3b87a308bf05c252cc81a12',
    )
    // 1,812,500 of 3,125,000 XEC to the miner in block 970464.
    expect(1_812_500 / 3_125_000).toBe(0.58)
  })
})

describe('bundled monthly history of the other basket chains', () => {
  it('has, for each chain, months in order with every input positive, and says where they come from', () => {
    for (const [chain, history] of Object.entries(MINED_CHAINS_MONTHLY)) {
      expect(chain).toMatch(/^[a-z]+-mainnet$/)
      expect(history.source.length).toBeGreaterThan(20)
      expect(history.sourceUrl).toMatch(/^https:\/\//)
      const months = history.monthly.map(row => row[0])
      expect(months).toEqual([...months].sort())
      expect(new Set(months).size).toBe(months.length)
      for (const row of history.monthly) {
        expect(row[0]).toMatch(/^\d{4}-\d{2}$/)
        for (const value of row.slice(1) as number[]) {
          expect(value).toBeGreaterThan(0)
        }
      }
    }
  })

  it('covers the five chains of the basket that are not Bitcoin, each back to 2020 or its start', () => {
    expect(Object.keys(MINED_CHAINS_MONTHLY).sort()).toEqual([
      'bch-mainnet',
      'doge-mainnet',
      'ltc-mainnet',
      'xec-mainnet',
      'xmr-mainnet',
    ])
    const first = (chain: string) => MINED_CHAINS_MONTHLY[chain].monthly[0][0]
    expect(first('ltc-mainnet') <= '2020-01').toBe(true)
    expect(first('doge-mainnet')).toBe('2020-01')
    expect(first('bch-mainnet')).toBe('2017-09')
    // eCash began with the chain split of 15 November 2020.
    expect(first('xec-mainnet')).toBe('2020-12')
    // RandomX activated on 30 November 2019.
    expect(first('xmr-mainnet')).toBe('2019-12')
  })

  it('holds the consensus subsidies the chains really paid', () => {
    const month = (chain: string, m: string) =>
      MINED_CHAINS_MONTHLY[chain].monthly.find(row => row[0] === m)
    // Litecoin halved to 6.25 in August 2023; Dogecoin pays 10,000 a block.
    expect(month('ltc-mainnet', '2023-06')?.[3]).toBeCloseTo(12.5, 2)
    expect(month('ltc-mainnet', '2024-01')?.[3]).toBeCloseTo(6.25, 2)
    expect(month('doge-mainnet', '2024-01')?.[3]).toBe(10_000)
    // Monero's tail emission of 0.6 XMR began in June 2022.
    expect(month('xmr-mainnet', '2022-01')?.[3]).toBeGreaterThan(0.6)
    expect(month('xmr-mainnet', '2023-01')?.[3]).toBe(0.6)
  })
})

describe('bundled wholesale electricity prices', () => {
  it('names each region, its attribution and its source', () => {
    for (const region of Object.values(WHOLESALE_ELECTRICITY.regions)) {
      expect(region.label.length).toBeGreaterThan(5)
      expect(region.attribution.length).toBeGreaterThan(5)
      expect(region.sourceUrl).toMatch(/^https:\/\//)
      const days = region.daily.map(day => day[0])
      expect(days).toEqual([...days].sort())
    }
    expect(WHOLESALE_ELECTRICITY.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reaches back to 2020 or earlier in both regions', () => {
    for (const region of Object.values(WHOLESALE_ELECTRICITY.regions)) {
      expect(region.daily[0][0] < '2020-01-01').toBe(true)
    }
  })

  it('aggregates a day as the mean of the regions that have it', () => {
    const { regions, aggregate } = WHOLESALE_ELECTRICITY
    const byDay = (daily: Array<[string, number]>) => new Map(daily)
    const de = byDay(regions['de-lu'].daily)
    const us = byDay(regions['us-pjm-west'].daily)
    let both = 0
    let one = 0
    for (const [day, value] of aggregate.daily) {
      const parts = [de.get(day), us.get(day)].filter(
        (v): v is number => v !== undefined,
      )
      expect(parts.length).toBeGreaterThan(0)
      const mean = parts.reduce((sum, v) => sum + v, 0) / parts.length
      // Each figure in the file is rounded to five significant digits.
      expect(Math.abs(value - mean)).toBeLessThanOrEqual(
        Math.abs(mean) * 1e-3 + 1e-6,
      )
      if (parts.length === 2) both++
      else one++
    }
    expect(both).toBeGreaterThan(1000)
    expect(one).toBeGreaterThan(100)
  })

  it('keeps days whose price was zero or negative: they happened', () => {
    expect(
      WHOLESALE_ELECTRICITY.regions['de-lu'].daily.some(day => day[1] <= 0),
    ).toBe(true)
  })
})
