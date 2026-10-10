import { windowedElectricityAggregate } from '../src/electricity-aggregate'
import { at, type SeriesPoint } from '../src/timeseries'

const DAY = 86_400
/** Daily prices from day 1; a null is a day the region has no price for. */
const daily = (prices: Array<number | null>): SeriesPoint[] =>
  prices.flatMap((price, day) =>
    price === null ? [] : [[(day + 1) * DAY, price] as const],
  )

describe('the windowed electricity aggregate', () => {
  it('is a region’s mean over the window, zero and negative days included', () => {
    const { points } = windowedElectricityAggregate(
      { a: daily([0.08, 0, -0.02, 0.06]) },
      30,
      1,
    )
    // Day 4: (0.08 + 0 - 0.02 + 0.06) / 4 = 0.03.
    expect(points.map(point => point[0])).toEqual([DAY, 2 * DAY, 3 * DAY, 4 * DAY])
    expect(at(points, 4 * DAY)?.[1]).toBeCloseTo(0.03, 12)
    // Day 3: (0.08 + 0 - 0.02) / 3 = 0.02.
    expect(at(points, 3 * DAY)?.[1]).toBeCloseTo(0.02, 12)
  })

  it('weighs regions equally, however many days each has', () => {
    // A publishes all six days at 0.20; B trades on two of them at 0.05.
    const { points } = windowedElectricityAggregate(
      {
        a: daily([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
        b: daily([0.05, null, null, 0.05, null, null]),
      },
      30,
      1,
    )
    // (0.20 + 0.05) / 2 = 0.125, not the day-weighted (6 x 0.20 + 2 x 0.05) / 8 = 0.1625.
    expect(at(points, 6 * DAY)?.[1]).toBeCloseTo(0.125, 12)
  })

  it('leaves a region out of a day’s point while it has too few days in the window', () => {
    const { points, lastContributed } = windowedElectricityAggregate(
      { a: daily([0.1, 0.1, 0.1, 0.1]), b: daily([null, null, 0.9, 0.9]) },
      30,
      2,
    )
    // Day 1: nobody has two days yet, so there is no point.
    expect(at(points, DAY)).toBeUndefined()
    // Day 3: only A qualifies (B has one day).
    expect(at(points, 3 * DAY)?.[1]).toBeCloseTo(0.1, 12)
    // Day 4: both: (0.1 + 0.9) / 2.
    expect(at(points, 4 * DAY)?.[1]).toBeCloseTo(0.5, 12)
    expect(lastContributed).toEqual({ a: 4 * DAY, b: 4 * DAY })
  })

  it('uses only the window ending at each day, and says when a region last counted', () => {
    const a = Array.from({ length: 40 }, (_, day) => (day < 10 ? 1 : 0.05))
    // B stops after day 12: by day 40 it has no price in the window.
    const b = Array.from({ length: 40 }, (_, day) => (day < 12 ? 0.3 : null))
    const { points, lastContributed } = windowedElectricityAggregate(
      { a: daily(a), b: daily(b) },
      30,
      10,
    )
    expect(at(points, 40 * DAY)?.[1]).toBeCloseTo(0.05, 12)
    // B's last ten days in a window: days 3..12 are inside the window ending day 32.
    expect(lastContributed.b).toBe(32 * DAY)
    expect(lastContributed.a).toBe(40 * DAY)
  })

  it('can come out zero or negative: inverting is the reader’s business', () => {
    const { points } = windowedElectricityAggregate(
      { a: daily([0.01, -0.03]) },
      30,
      1,
    )
    expect(at(points, 2 * DAY)?.[1]).toBeCloseTo(-0.01, 12)
  })
})
