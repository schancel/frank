import {
  HISTORICAL_MACRO_ARCHIVE_1930_2019,
  COMMODITY_ANCHORS,
  getHistoricalMacroSlice,
  getHistoricalMacroPoint,
  interpolateMacroPoint,
  getTimestepConversionContext,
  convertUsdToAvuAtTimestep,
  convertAssetUsdToAvuAtTimestep,
  convertAssetHistoryToAvu,
  cpiAdjustToEpoch,
  TimestepSeriesConverter,
} from '../src/historical'

describe('Historical Macro Archive (1930-2019)', () => {
  test('contains complete contiguous records for all 90 years from 1930 through 2019', () => {
    expect(HISTORICAL_MACRO_ARCHIVE_1930_2019.length).toBe(90)
    for (let i = 0; i < 90; i++) {
      const expectedYear = 1930 + i
      expect(HISTORICAL_MACRO_ARCHIVE_1930_2019[i].year).toBe(expectedYear)
    }
  })

  test('validates mathematical consistency and bounds across economic series', () => {
    for (const pt of HISTORICAL_MACRO_ARCHIVE_1930_2019) {
      expect(pt.centsPerKwh).toBeGreaterThan(0)
      expect(pt.usdKwh).toBeGreaterThan(0)
      expect(pt.goldUsd).toBeGreaterThan(0)
      expect(pt.goldAvu).toBeGreaterThan(0)

      // Inverse relationship: usdKwh ≈ 100 / centsPerKwh (within ±10% due to industrial vs retail power weighting)
      const theoreticalKwh = 100 / pt.centsPerKwh
      expect(pt.usdKwh).toBeGreaterThan(theoreticalKwh * 0.7)
      expect(pt.usdKwh).toBeLessThan(theoreticalKwh * 1.5)

      // Energy valuation: goldAvu should track goldUsd * usdKwh
      const computedAvu = pt.goldUsd * pt.usdKwh
      expect(pt.goldAvu).toBeGreaterThan(computedAvu * 0.7)
      expect(pt.goldAvu).toBeLessThan(computedAvu * 1.3)
    }
  })

  test('verifies PoW emergence benchmarks exist exclusively from 2009 onwards', () => {
    for (const pt of HISTORICAL_MACRO_ARCHIVE_1930_2019) {
      if (pt.year < 2009) {
        expect(pt.powHashRate).toBeUndefined()
      } else {
        expect(pt.powHashRate).toBeDefined()
        expect(pt.powHashRate!).toBeGreaterThan(0)
      }
    }
    // Satoshi genesis anchor
    const pt2009 = getHistoricalMacroPoint(2009)
    expect(pt2009?.powHashRate).toBe(1.0)
    expect(pt2009?.notes).toContain('Bitcoin Genesis block')
  })

  test('verifies key historical monetary inflection milestones', () => {
    // 1930: Classical gold standard peg ($20.67/oz)
    const pt1930 = getHistoricalMacroPoint(1930)
    expect(pt1930?.goldUsd).toBe(20.67)
    expect(pt1930?.usdKwh).toBeCloseTo(142.9, 0.5)

    // 1934: FDR Gold Reserve Act peg ($35.00/oz)
    const pt1934 = getHistoricalMacroPoint(1934)
    expect(pt1934?.goldUsd).toBe(35.0)

    // 1971: Nixon Shock closing the gold window
    const pt1971 = getHistoricalMacroPoint(1971)
    expect(pt1971?.goldUsd).toBe(40.8)
    expect(pt1971?.notes).toContain('Nixon closes gold window')

    // 1980: Inflation peak and Volcker monetary tightening
    const pt1980 = getHistoricalMacroPoint(1980)
    expect(pt1980?.goldUsd).toBe(615.0)
    expect(pt1980?.cpiIndex).toBe(82.4)
  })

  test('slices historical intervals accurately', () => {
    const postBrettonWoods = getHistoricalMacroSlice(1971, 2000)
    expect(postBrettonWoods.length).toBe(30)
    expect(postBrettonWoods[0].year).toBe(1971)
    expect(postBrettonWoods[postBrettonWoods.length - 1].year).toBe(2000)
  })

  test('interpolates points smoothly for fractional years', () => {
    const mid1971 = interpolateMacroPoint(1971.5)
    expect(mid1971.year).toBe(1971.5)
    // Between 1971 (40.80) and 1972 (58.16)
    expect(mid1971.goldUsd).toBeGreaterThan(40.8)
    expect(mid1971.goldUsd).toBeLessThan(58.16)

    // Boundary conditions
    const pre1930 = interpolateMacroPoint(1920)
    expect(pre1930.year).toBe(1930)

    const post2019 = interpolateMacroPoint(2025)
    expect(post2019.year).toBe(2019)
  })

  test('validates commodity physical anchor definitions', () => {
    expect(COMMODITY_ANCHORS.gold.price1971).toBe(40.8)
    expect(COMMODITY_ANCHORS.gold.price2020).toBe(1769.64)

    expect(COMMODITY_ANCHORS.crude_oil.energyDensityKwh).toBe(1700)
    expect(COMMODITY_ANCHORS.natural_gas.energyDensityKwh).toBeCloseTo(
      293.07,
      1,
    )
  })
})

describe('Timestep-Specific Thermodynamic Conversion Engine', () => {
  test('retrieves accurate timestep conversion context across historical and modern epochs', () => {
    // 1930 Great Depression epoch
    const ctx1930 = getTimestepConversionContext(1930)
    expect(ctx1930.year).toBe(1930)
    expect(ctx1930.usdKwh).toBeCloseTo(142.9, 0.5)
    expect(ctx1930.goldUsd).toBe(20.67)
    expect(ctx1930.goldAvu).toBe(2953)

    // 1971 Nixon Shock epoch
    const ctx1971 = getTimestepConversionContext(1971)
    expect(ctx1971.year).toBe(1971)
    expect(ctx1971.usdKwh).toBe(68.2)
    expect(ctx1971.centsPerKwh).toBe(1.47)
    expect(ctx1971.usdPerKwh).toBe(0.0147)
    expect(ctx1971.goldUsd).toBe(40.8)
    expect(ctx1971.goldAvu).toBe(Math.round(40.8 * 68.2))

    // 2026 Modern baseline epoch
    const ctx2026 = getTimestepConversionContext(2026)
    expect(ctx2026.year).toBe(2026)
    expect(ctx2026.usdKwh).toBe(12.0)
    expect(ctx2026.goldAvu).toBe(31547)
    expect(ctx2026.powHashRate).toBe(11.9)
  })

  test('prevents anachronistic tariff error when converting historical assets', () => {
    // In 1971, Gold was $40.80/oz
    const goldUsd1971 = 40.8
    // With 1971 tariff (68.2 AVU/$), gold is ~2,783 AVU/oz
    const goldAvu1971Correct = convertAssetUsdToAvuAtTimestep(goldUsd1971, 1971)
    expect(goldAvu1971Correct).toBe(2782.56)

    // Using modern 2026 rate (12.0 AVU/$) on 1971 gold would be anachronistic (~489.6 AVU)
    const erroneousModernConversion = convertAssetUsdToAvuAtTimestep(
      goldUsd1971,
      2026,
    )
    expect(erroneousModernConversion).toBe(489.6)

    // The error factor is > 5.6x if modern rate is applied to 1971!
    expect(goldAvu1971Correct / erroneousModernConversion).toBeCloseTo(5.68, 1)
  })

  test('converts multi-year asset history using each year respective tariff', () => {
    const ethUsdHistory: Record<number, number> = {
      2015: 1.0,
      2016: 10.0,
      2017: 750.0,
      2020: 750.0,
      2026: 2579.36,
    }

    const ethAvuHistory = convertAssetHistoryToAvu(ethUsdHistory)

    // 2015: $1.00 * 18.9 usdKwh = 18.9 AVU
    expect(ethAvuHistory[2015]).toBe(18.9)
    // 2016: $10.00 * 17.5 usdKwh = 175.0 AVU
    expect(ethAvuHistory[2016]).toBe(175.0)
    // 2017: $750.00 * 16.8 usdKwh = 12,600.0 AVU
    expect(ethAvuHistory[2017]).toBe(12600.0)
    // 2020: $750.00 * 15.1 usdKwh = 11,325.0 AVU
    expect(ethAvuHistory[2020]).toBe(11325.0)
    // 2026: $2579.36 * 12.0 usdKwh = 30,952.32 AVU
    expect(ethAvuHistory[2026]).toBeCloseTo(30952.32, 1)
  })

  test('adjusts nominal values for CPI inflation between historical epochs', () => {
    // 1971 (CPI ~40.5) to 2026 (CPI ~329.5) -> ~8.1x increase
    const purchasingPower2026 = cpiAdjustToEpoch(100, 1971, 2026)
    expect(purchasingPower2026).toBeGreaterThan(750)
    expect(purchasingPower2026).toBeLessThan(850)
  })

  test('TimestepSeriesConverter caches contexts and enriches points', () => {
    const converter = new TimestepSeriesConverter()
    const point = { year: 1980, label: 'Inflation Peak' }
    const enriched = converter.enrichPoint(point)

    expect(enriched.usdKwh).toBe(27.0)
    expect(enriched.centsPerKwh).toBe(3.7)
    expect(enriched.usdPerKwh).toBe(0.037)
    expect(enriched.conversionContext.goldUsd).toBe(615.0)
  })
})
