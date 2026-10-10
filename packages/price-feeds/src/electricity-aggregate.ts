/**
 * How `electricity/aggregate` is built from regional daily prices (the rule of
 * docs/protocol/oracle/README.md). Pure: the relay is to build its series the same way;
 * until it does, the temporary direct adapter runs this over the bundled regional files.
 */
import { trailingMean, type SeriesPoint, type Timeseries } from './timeseries'

const DAY_SECONDS = 86_400

export interface ElectricityAggregate {
  /** One point per day on which at least one region qualified. */
  points: SeriesPoint[]
  /** Per region, the latest day whose point it counted in. Absent if it never did. */
  lastContributed: Record<string, number>
}

/**
 * The point for day d is the equally weighted mean, over the regions, of each region's
 * mean daily price in the `windowDays` days ending at d. A region with fewer than
 * `minDays` daily prices in that window is left out of that day's point; a day on which
 * no region qualifies has no point.
 *
 * Each region's prices are averaged first, then the regions: a region that publishes
 * every day does not outweigh one that trades on weekdays only. Nothing is inverted here.
 */
export function windowedElectricityAggregate(
  regions: Record<string, Timeseries>,
  windowDays: number,
  minDays: number,
): ElectricityAggregate {
  const days = Array.from(
    new Set(
      Object.values(regions).flatMap(series => series.map(point => point[0])),
    ),
  ).sort((a, b) => a - b)
  const points: SeriesPoint[] = []
  const lastContributed: Record<string, number> = {}
  for (const day of days) {
    let sum = 0
    let counted = 0
    for (const [id, series] of Object.entries(regions)) {
      const mean = trailingMean(series, day, windowDays * DAY_SECONDS)
      if (!mean || mean.count < minDays) continue
      sum += mean.mean
      counted++
      lastContributed[id] = day
    }
    if (counted > 0) points.push([day, sum / counted])
  }
  return { points, lastContributed }
}
