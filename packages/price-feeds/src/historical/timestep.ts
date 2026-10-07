/**
 * Timestep-Specific Thermodynamic & Econometric Conversion Engine.
 *
 * Prevents the anachronistic fallacy of applying current AVU/USD tariffs
 * to historical macroeconomic or crypto asset valuations.
 *
 * Definition of AVU: 1 AVU ≡ 1 kWh (3.6 MJ) of physical compute/work.
 * At any historical or intraday timestep t:
 *   - Energy Tariff: Tariff(t) = centsPerKwh(t) / 100 ($ / kWh)
 *   - Currency Purchasing Power: usdKwh(t) = 1 / Tariff(t) (AVU / $ = kWh / $)
 *   - Asset Price in AVU: Price_AVU(asset, t) = Price_USD(asset, t) * usdKwh(t)
 *   - Asset Price in USD: Price_USD(asset, t) = Price_AVU(asset, t) / usdKwh(t)
 */

import {
  HISTORICAL_MACRO_ARCHIVE_1930_2019,
  getHistoricalMacroPoint,
  interpolateMacroPoint,
} from './archive'
import type { HistoricalMacroPoint } from './types'

/**
 * Contextual macroeconomic and energy rates active at a specific timestep.
 */
export interface TimestepConversionContext {
  /** Timestep representation: calendar year (number), ISO date string, or timestamp label */
  timestep: number | string
  /** Resolved calendar year (or fractional year) */
  year: number
  /** USD purchasing power in kWh per $1 USD (AVU per USD: 1 / ($ / kWh)) */
  usdKwh: number
  /** Average retail/industrial electricity tariff in cents per kWh */
  centsPerKwh: number
  /** Energy tariff in USD per kWh ($ / AVU = centsPerKwh / 100) */
  usdPerKwh: number
  /** Benchmark Consumer Price Index (CPI-U, 1982-1984=100) at this timestep */
  cpiIndex?: number
  /** Implied Proof-of-Work energy purchasing power (kWh/$) */
  powHashRate?: number
  /** Gold price in nominal USD per troy ounce at this timestep */
  goldUsd?: number
  /** Implied Gold energy valuation in AVU (kWh per troy oz = goldUsd * usdKwh) */
  goldAvu?: number
  /** Historical context or notable milestone note */
  notes?: string
}

/**
 * Modern macroeconomic anchor points spanning 2020 through 2026.
 * All figures derived from EIA industrial power statistics, LBMA gold spot,
 * BLS CPI-U benchmarks, and Cambridge CBECI PoW fleet energy efficiency.
 */
export const MODERN_MACRO_ANCHORS: readonly HistoricalMacroPoint[] = [
  {
    year: 2020,
    centsPerKwh: 6.62,
    usdKwh: 15.1,
    goldUsd: 1801.32,
    goldAvu: 27200,
    cpiIndex: 258.8,
    powHashRate: 10.4,
    notes:
      'COVID-19 liquidity expansion; Bitcoin 3rd Halving (12.5 -> 6.25 BTC)',
  },
  {
    year: 2021,
    centsPerKwh: 7.19,
    usdKwh: 13.9,
    goldUsd: 2021.58,
    goldAvu: 28100,
    cpiIndex: 271.0,
    powHashRate: 11.2,
    notes: 'Global energy price spike; China mining ban and hash relocation',
  },
  {
    year: 2022,
    centsPerKwh: 7.46,
    usdKwh: 13.4,
    goldUsd: 2149.25,
    goldAvu: 28800,
    cpiIndex: 292.7,
    powHashRate: 11.4,
    notes:
      'Global inflation surge; Federal Reserve aggressive rate tightening cycle',
  },
  {
    year: 2023,
    centsPerKwh: 7.69,
    usdKwh: 13.0,
    goldUsd: 2261.54,
    goldAvu: 29400,
    cpiIndex: 304.7,
    powHashRate: 11.5,
    notes:
      'US Regional banking stress; institutional ETF filings; Ordinals emerge',
  },
  {
    year: 2024,
    centsPerKwh: 7.94,
    usdKwh: 12.6,
    goldUsd: 2388.89,
    goldAvu: 30100,
    cpiIndex: 314.5,
    powHashRate: 11.7,
    notes:
      'US Spot Bitcoin ETFs approved; Bitcoin 4th Halving (6.25 -> 3.125 BTC)',
  },
  {
    year: 2025,
    centsPerKwh: 8.13,
    usdKwh: 12.3,
    goldUsd: 2504.07,
    goldAvu: 30800,
    cpiIndex: 322.0,
    powHashRate: 11.8,
    notes: 'Grid compute integration & industrial PoW thermodynamic demand',
  },
  {
    year: 2026,
    centsPerKwh: 8.33,
    usdKwh: 12.0,
    goldUsd: 2628.92,
    goldAvu: 31547,
    cpiIndex: 329.5,
    powHashRate: 11.9,
    notes:
      'Thermodynamic parity standard stabilization ($0.084/kWh grid baseline)',
  },
] as const

/**
 * Contiguous 97-year combined macroeconomic archive from 1930 to 2026.
 */
export const COMBINED_MACRO_ARCHIVE_1930_PRESENT: readonly HistoricalMacroPoint[] =
  [...HISTORICAL_MACRO_ARCHIVE_1930_2019, ...MODERN_MACRO_ANCHORS]

/**
 * Resolves a calendar year (integer or fractional) from a diverse timestep specification.
 */
export function resolveYearFromTimestep(
  timestep: number | string | Date | TimestepConversionContext,
): number {
  if (
    typeof timestep === 'object' &&
    !(timestep instanceof Date) &&
    'year' in timestep
  ) {
    return (timestep as TimestepConversionContext).year
  }

  if (typeof timestep === 'number') {
    // If it's a Unix timestamp in milliseconds or seconds (> 1_000_000_000)
    if (timestep > 1_000_000_000_000) {
      const d = new Date(timestep)
      return d.getUTCFullYear() + (d.getUTCMonth() * 30 + d.getUTCDate()) / 365
    }
    if (timestep > 1_000_000_000) {
      const d = new Date(timestep * 1000)
      return d.getUTCFullYear() + (d.getUTCMonth() * 30 + d.getUTCDate()) / 365
    }
    return timestep
  }

  if (timestep instanceof Date) {
    return (
      timestep.getUTCFullYear() +
      (timestep.getUTCMonth() * 30 + timestep.getUTCDate()) / 365
    )
  }

  // String timestep
  const trimmed = timestep.trim()
  const parsedNum = Number(trimmed)
  if (!Number.isNaN(parsedNum) && parsedNum >= 1900 && parsedNum <= 2100) {
    return parsedNum
  }

  // Check ISO date format YYYY-MM-DD
  const dateMatch = trimmed.match(/^(\d{4})/)
  if (dateMatch) {
    const parsedDate = new Date(trimmed)
    if (!Number.isNaN(parsedDate.getTime())) {
      return (
        parsedDate.getUTCFullYear() +
        (parsedDate.getUTCMonth() * 30 + parsedDate.getUTCDate()) / 365
      )
    }
    return Number(dateMatch[1])
  }

  // Relative intraday offsets ('Now', '-1h', '-7d', etc.) default to current epoch (2026)
  return 2026
}

/**
 * Retrieves or interpolates the exact thermodynamic conversion context for any timestep.
 *
 * @param timestep Calendar year (e.g. 1971), Date, timestamp, or label
 * @param overrideRates Optional override for live or fine-grained simulation rates
 */
export function getTimestepConversionContext(
  timestep: number | string | Date | TimestepConversionContext,
  overrideRates?: Partial<TimestepConversionContext>,
): TimestepConversionContext {
  // If a pre-constructed context is passed in, return it directly with overrides
  if (
    typeof timestep === 'object' &&
    !(timestep instanceof Date) &&
    'usdKwh' in (timestep as any)
  ) {
    const ctx = timestep as unknown as TimestepConversionContext
    return {
      ...ctx,
      ...overrideRates,
      usdPerKwh:
        overrideRates?.usdPerKwh ??
        (overrideRates?.centsPerKwh !== undefined
          ? overrideRates.centsPerKwh / 100
          : ctx.usdPerKwh),
    }
  }

  const year = resolveYearFromTimestep(timestep)

  // 1. Direct match in modern anchors (2020..2026)
  const modernMatch = MODERN_MACRO_ANCHORS.find(
    p => p.year === Math.round(year),
  )
  if (modernMatch && Math.abs(year - modernMatch.year) < 0.01) {
    const usdPerKwh =
      Math.round((modernMatch.centsPerKwh / 100) * 100000) / 100000
    return {
      timestep: typeof timestep === 'object' ? year : timestep,
      year: modernMatch.year,
      usdKwh: modernMatch.usdKwh,
      centsPerKwh: modernMatch.centsPerKwh,
      usdPerKwh,
      cpiIndex: modernMatch.cpiIndex,
      powHashRate: modernMatch.powHashRate,
      goldUsd: modernMatch.goldUsd,
      goldAvu: modernMatch.goldAvu,
      notes: modernMatch.notes,
      ...overrideRates,
    }
  }

  // 2. Direct match in historical archive (1930..2019)
  const histMatch = getHistoricalMacroPoint(Math.round(year))
  if (histMatch && Math.abs(year - histMatch.year) < 0.01) {
    const usdPerKwh =
      Math.round((histMatch.centsPerKwh / 100) * 100000) / 100000
    return {
      timestep: typeof timestep === 'object' ? year : timestep,
      year: histMatch.year,
      usdKwh: histMatch.usdKwh,
      centsPerKwh: histMatch.centsPerKwh,
      usdPerKwh,
      cpiIndex: histMatch.cpiIndex,
      powHashRate: histMatch.powHashRate,
      goldUsd: histMatch.goldUsd,
      goldAvu: histMatch.goldAvu,
      notes: histMatch.notes,
      ...overrideRates,
    }
  }

  // 3. Interpolation between boundary years
  let basePoint: HistoricalMacroPoint
  if (year < 2019) {
    basePoint = interpolateMacroPoint(year)
  } else if (year >= 2026) {
    basePoint = MODERN_MACRO_ANCHORS[MODERN_MACRO_ANCHORS.length - 1]
  } else {
    // Interpolate within 2019..2026
    const p1920 = [
      HISTORICAL_MACRO_ARCHIVE_1930_2019[
        HISTORICAL_MACRO_ARCHIVE_1930_2019.length - 1
      ],
      ...MODERN_MACRO_ANCHORS,
    ]
    const floorYear = Math.floor(year)
    const ceilYear = Math.ceil(year)
    const p0 = p1920.find(p => p.year === floorYear) ?? p1920[0]
    const p1 = p1920.find(p => p.year === ceilYear) ?? p1920[p1920.length - 1]
    const t =
      floorYear === ceilYear ? 0 : (year - floorYear) / (ceilYear - floorYear)

    const usdKwh = p0.usdKwh + t * (p1.usdKwh - p0.usdKwh)
    const centsPerKwh = p0.centsPerKwh + t * (p1.centsPerKwh - p0.centsPerKwh)
    const goldUsd = p0.goldUsd + t * (p1.goldUsd - p0.goldUsd)
    const goldAvu = Math.round(p0.goldAvu + t * (p1.goldAvu - p0.goldAvu))

    let powHashRate: number | undefined = undefined
    if (p0.powHashRate !== undefined && p1.powHashRate !== undefined) {
      powHashRate = p0.powHashRate + t * (p1.powHashRate - p0.powHashRate)
    } else {
      powHashRate = p1.powHashRate ?? p0.powHashRate
    }

    let cpiIndex: number | undefined = undefined
    if (p0.cpiIndex !== undefined && p1.cpiIndex !== undefined) {
      cpiIndex = p0.cpiIndex + t * (p1.cpiIndex - p0.cpiIndex)
    }

    basePoint = {
      year,
      usdKwh: Math.round(usdKwh * 100) / 100,
      centsPerKwh: Math.round(centsPerKwh * 100) / 100,
      goldUsd: Math.round(goldUsd * 100) / 100,
      goldAvu,
      cpiIndex:
        cpiIndex !== undefined ? Math.round(cpiIndex * 10) / 10 : undefined,
      powHashRate:
        powHashRate !== undefined
          ? Math.round(powHashRate * 100) / 100
          : undefined,
    }
  }

  const usdPerKwh = Math.round((basePoint.centsPerKwh / 100) * 100000) / 100000
  return {
    timestep: typeof timestep === 'object' ? year : timestep,
    year,
    usdKwh: basePoint.usdKwh,
    centsPerKwh: basePoint.centsPerKwh,
    usdPerKwh,
    cpiIndex: basePoint.cpiIndex,
    powHashRate: basePoint.powHashRate,
    goldUsd: basePoint.goldUsd,
    goldAvu: basePoint.goldAvu,
    notes: basePoint.notes,
    ...overrideRates,
  }
}

/**
 * Converts a nominal USD amount to AVU (kWh) using the tariff active at the specified timestep.
 *
 * @param usdAmount Amount in nominal USD
 * @param timestep Timestep context or year/date
 */
export function convertUsdToAvuAtTimestep(
  usdAmount: number,
  timestep: number | string | Date | TimestepConversionContext,
): number {
  const ctx =
    typeof timestep === 'object' && 'usdKwh' in (timestep as any)
      ? (timestep as TimestepConversionContext)
      : getTimestepConversionContext(timestep)

  return Math.round(usdAmount * ctx.usdKwh * 100) / 100
}

/**
 * Converts an AVU amount to nominal USD using the tariff active at the specified timestep.
 *
 * @param avuAmount Amount in AVU (kWh)
 * @param timestep Timestep context or year/date
 */
export function convertAvuToUsdAtTimestep(
  avuAmount: number,
  timestep: number | string | Date | TimestepConversionContext,
): number {
  const ctx =
    typeof timestep === 'object' && 'usdKwh' in (timestep as any)
      ? (timestep as TimestepConversionContext)
      : getTimestepConversionContext(timestep)

  return Math.round((avuAmount / ctx.usdKwh) * 100) / 100
}

/**
 * Converts an asset's nominal USD price at a given timestep into its true physical AVU energy equivalent.
 *
 * Formula: Price_AVU(asset, t) = Price_USD(asset, t) * usdKwh(t)
 *
 * @param assetUsdPrice Asset price in USD at timestep t
 * @param timestep Timestep context or year/date
 */
export function convertAssetUsdToAvuAtTimestep(
  assetUsdPrice: number,
  timestep: number | string | Date | TimestepConversionContext,
): number {
  const ctx =
    typeof timestep === 'object' && 'usdKwh' in (timestep as any)
      ? (timestep as TimestepConversionContext)
      : getTimestepConversionContext(timestep)

  return Math.round(assetUsdPrice * ctx.usdKwh * 100) / 100
}

/**
 * Converts an asset's AVU energy valuation at a given timestep into its nominal USD equivalent.
 *
 * Formula: Price_USD(asset, t) = Price_AVU(asset, t) / usdKwh(t)
 *
 * @param assetAvuPrice Asset valuation in AVU at timestep t
 * @param timestep Timestep context or year/date
 */
export function convertAssetAvuToUsdAtTimestep(
  assetAvuPrice: number,
  timestep: number | string | Date | TimestepConversionContext,
): number {
  const ctx =
    typeof timestep === 'object' && 'usdKwh' in (timestep as any)
      ? (timestep as TimestepConversionContext)
      : getTimestepConversionContext(timestep)

  return Math.round((assetAvuPrice / ctx.usdKwh) * 100) / 100
}

/**
 * Transforms an entire historical timeline of nominal USD prices into AVU valuations,
 * ensuring each year uses its own historical tariff rather than modern rates.
 *
 * @param usdHistory Map of { [year: number]: number (price in USD) }
 * @returns Map of { [year: number]: number (price in AVU) }
 */
export function convertAssetHistoryToAvu(
  usdHistory: Record<number, number>,
): Record<number, number> {
  const avuHistory: Record<number, number> = {}

  for (const [yearStr, priceUsd] of Object.entries(usdHistory)) {
    const year = Number(yearStr)
    const ctx = getTimestepConversionContext(year)
    avuHistory[year] = Math.round(priceUsd * ctx.usdKwh * 100) / 100
  }

  return avuHistory
}

/**
 * Adjusts a nominal monetary value for CPI inflation between two timesteps.
 *
 * @param nominalValue Value in nominal currency at fromTimestep
 * @param fromTimestep Starting year or date
 * @param toTimestep Target year or date
 */
export function cpiAdjustToEpoch(
  nominalValue: number,
  fromTimestep: number | string | Date,
  toTimestep: number | string | Date,
): number {
  const fromCtx = getTimestepConversionContext(fromTimestep)
  const toCtx = getTimestepConversionContext(toTimestep)

  if (!fromCtx.cpiIndex || !toCtx.cpiIndex) {
    return nominalValue
  }

  const multiplier = toCtx.cpiIndex / fromCtx.cpiIndex
  return Math.round(nominalValue * multiplier * 100) / 100
}

/**
 * Batch converter class for time series pipelines and charts.
 */
export class TimestepSeriesConverter {
  private cache = new Map<number | string, TimestepConversionContext>()
  private liveOverrides?: Partial<TimestepConversionContext>

  constructor(liveOverrides?: Partial<TimestepConversionContext>) {
    this.liveOverrides = liveOverrides
  }

  /**
   * Retrieves or computes cached timestep context.
   */
  getContext(
    timestep: number | string | Date | TimestepConversionContext,
  ): TimestepConversionContext {
    const key =
      typeof timestep === 'object' && !(timestep instanceof Date)
        ? (timestep as any).year ?? 'custom'
        : String(timestep)

    const cached = this.cache.get(key)
    if (cached) return cached

    const ctx = getTimestepConversionContext(timestep, this.liveOverrides)
    this.cache.set(key, ctx)
    return ctx
  }

  /**
   * Converts USD to AVU at the given timestep using cached context.
   */
  usdToAvu(
    usdAmount: number,
    timestep: number | string | Date | TimestepConversionContext,
  ): number {
    const ctx = this.getContext(timestep)
    return Math.round(usdAmount * ctx.usdKwh * 100) / 100
  }

  /**
   * Converts AVU to USD at the given timestep using cached context.
   */
  avuToUsd(
    avuAmount: number,
    timestep: number | string | Date | TimestepConversionContext,
  ): number {
    const ctx = this.getContext(timestep)
    return Math.round((avuAmount / ctx.usdKwh) * 100) / 100
  }

  /**
   * Enriches a generic time series data point with timestep-accurate conversion context.
   */
  enrichPoint<T extends { year?: number | string; timeLabel?: string }>(
    point: T,
  ): T & {
    usdKwh: number
    usdPerKwh: number
    centsPerKwh: number
    conversionContext: TimestepConversionContext
  } {
    const ts = point.year ?? point.timeLabel ?? 2026
    const ctx = this.getContext(ts)
    return {
      ...point,
      usdKwh: ctx.usdKwh,
      usdPerKwh: ctx.usdPerKwh,
      centsPerKwh: ctx.centsPerKwh,
      conversionContext: ctx,
    }
  }
}
