/**
 * The one timeseries mechanism of the oracle.
 *
 * A series is a list of [unixSeconds, value] points, oldest first, no two at the same
 * time. There is one lookup, `at`: the latest point at or before a time (step-hold).
 * Nothing is interpolated, and before the first point a series has no value: a first value
 * is never extended backwards. After the last point the last value holds; a reader that
 * cares how old it is looks at the point's own time.
 *
 * Every input of AVU_hash and AVU_spot is such a series (docs/protocol/oracle/README.md).
 */

/** [unix seconds, value] */
export type SeriesPoint = readonly [number, number]
export type Timeseries = readonly SeriesPoint[]

/** The latest point whose time is <= t, or undefined when t is before the first point. */
export function at(series: Timeseries | undefined, t: number): SeriesPoint | undefined {
  if (!series || series.length === 0 || !(t >= series[0][0])) return undefined
  let low = 0
  let high = series.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (series[middle][0] <= t) low = middle
    else high = middle - 1
  }
  return series[low]
}

/**
 * One series from two: every point of both, in time order; where both have a point at the
 * same time, the one from `newer` is kept. Points fetched later replace what was held.
 */
export function mergeSeries(held: Timeseries, newer: Timeseries): SeriesPoint[] {
  const merged: SeriesPoint[] = []
  let i = 0
  let j = 0
  while (i < held.length || j < newer.length) {
    if (j >= newer.length || (i < held.length && held[i][0] < newer[j][0])) {
      merged.push(held[i++])
    } else {
      if (i < held.length && held[i][0] === newer[j][0]) i++
      merged.push(newer[j++])
    }
  }
  return merged
}

/**
 * Bundled history continued by a live recording: the bundled points older than the first
 * live point, then the live points. Where both cover a time the live recording wins, so a
 * coarse bundled point never lands in the middle of what was recorded live. A lookup
 * between the end of the bundled history and the first live point returns the last bundled
 * point, with its own (old) time.
 */
export function spliceSeries(bundled: Timeseries, live: Timeseries): SeriesPoint[] {
  if (live.length === 0) return bundled.slice()
  const firstLive = live[0][0]
  return [...bundled.filter(point => point[0] < firstLive), ...live]
}

/**
 * The points inside [since, until], with the floor point at `since` in front when there is
 * one, thinned to the last point of each `step` seconds. This is what a feed answer
 * carries for a range (see "What a response must contain" in the contract).
 */
export function sliceSeries(
  series: Timeseries,
  since: number,
  until: number,
  step?: number,
): SeriesPoint[] {
  const floor = at(series, since)
  const inside = series.filter(point => point[0] > since && point[0] <= until)
  const points = floor ? [floor, ...inside] : inside
  if (!step || !(step > 0)) return points
  const thinned: SeriesPoint[] = []
  for (const point of points) {
    const last = thinned[thinned.length - 1]
    if (last && Math.floor(last[0] / step) === Math.floor(point[0] / step)) {
      thinned[thinned.length - 1] = point
    } else {
      thinned.push(point)
    }
  }
  return thinned
}

/**
 * The plain mean of the points in the `windowSeconds` ending at t (t - window, t], or
 * undefined when there are none. The mean is of the values themselves: a caller that
 * wants an inverse inverts the mean, never the points.
 */
export function trailingMean(
  series: Timeseries | undefined,
  t: number,
  windowSeconds: number,
): { mean: number; count: number; latest: number } | undefined {
  if (!series) return undefined
  let sum = 0
  let count = 0
  let latest = 0
  for (let i = series.length - 1; i >= 0; i--) {
    const [time, value] = series[i]
    if (time > t) continue
    if (time <= t - windowSeconds) break
    sum += value
    count++
    if (count === 1) latest = time
  }
  return count === 0 ? undefined : { mean: sum / count, count, latest }
}
