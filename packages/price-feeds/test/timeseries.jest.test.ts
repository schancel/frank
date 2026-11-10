import {
  at,
  mergeSeries,
  sliceSeries,
  trailingMean,
  type Timeseries,
} from '../src/timeseries'

const series: Timeseries = [
  [100, 1],
  [200, 2],
  [300, 3],
]

describe('the floor lookup', () => {
  it('returns the point at an exact time', () => {
    expect(at(series, 200)).toEqual([200, 2])
  })
  it('holds the latest earlier point between two points', () => {
    expect(at(series, 299)).toEqual([200, 2])
  })
  it('has no value before the first point: the first value is never extended backwards', () => {
    expect(at(series, 99)).toBeUndefined()
    expect(at([], 500)).toBeUndefined()
    expect(at(undefined, 500)).toBeUndefined()
  })
  it('holds the last point after the end, with its own time', () => {
    expect(at(series, 1_000_000)).toEqual([300, 3])
  })
  it('works on a series thinned to one point a day', () => {
    const day = 86_400
    const thinned: Timeseries = [
      [0 * day + 5, 10],
      [1 * day + 7, 11],
      [5 * day + 1, 15],
    ]
    expect(at(thinned, 4 * day)).toEqual([1 * day + 7, 11])
  })
})

describe('joining series', () => {
  it('a point received later for a time already held replaces it', () => {
    expect(
      mergeSeries(series, [
        [200, 20],
        [250, 25],
        [400, 4],
      ]),
    ).toEqual([
      [100, 1],
      [200, 20],
      [250, 25],
      [300, 3],
      [400, 4],
    ])
  })
})

describe('what a range answer carries', () => {
  it('is the floor point at the start, then the points inside, one per step', () => {
    const long: Timeseries = [
      [10, 1],
      [95, 2],
      [101, 3],
      [109, 4],
      [112, 5],
      [130, 6],
    ]
    expect(sliceSeries(long, 100, 125)).toEqual([
      [95, 2],
      [101, 3],
      [109, 4],
      [112, 5],
    ])
    expect(sliceSeries(long, 100, 125, 10)).toEqual([
      [95, 2],
      [109, 4],
      [112, 5],
    ])
    expect(sliceSeries(long, 5, 9)).toEqual([])
  })
})

describe('the trailing mean', () => {
  it('is the mean of the values in the window, zero and negative ones included', () => {
    const prices: Timeseries = [
      [1, 100],
      [2, 0.08],
      [3, 0],
      [4, -0.02],
      [5, 0.06],
    ]
    // Window (1, 5]: (0.08 + 0 - 0.02 + 0.06) / 4 = 0.03
    const mean = trailingMean(prices, 5, 4)
    expect(mean?.count).toBe(4)
    expect(mean?.mean).toBeCloseTo(0.03, 12)
    expect(mean?.latest).toBe(5)
  })
  it('has no value when the window holds no point', () => {
    expect(trailingMean([[1, 5]], 100, 10)).toBeUndefined()
  })

  it('locates a historical window without reading the entire future tail', () => {
    const points: Timeseries = Object.freeze(
      Array.from({ length: 16_384 }, (_, time) =>
        Object.freeze([time, time / 7] as const),
      ),
    )
    let indexReads = 0
    const observed = new Proxy(points, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) indexReads++
        return Reflect.get(target, key, receiver)
      },
    })
    const result = trailingMean(observed, 128, 8)
    expect(result).toEqual(referenceTrailingMean(points, 128, 8))
    // Binary lookup, eight included points and the excluded lower boundary.
    expect(indexReads).toBeLessThanOrEqual(
      Math.ceil(Math.log2(points.length + 1)) + 9,
    )
  })

  it('preserves exact descending floating point sums and boundary behavior', () => {
    // Reversing the additions produces 1/3 instead of 0; approximate checks miss drift.
    expect(
      trailingMean(
        [
          [1, 1e16],
          [2, -1e16],
          [3, 1],
        ],
        3,
        3,
      )?.mean,
    ).toBe(0)

    let seed = 0x12345678
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const values = [
      0,
      -0,
      0.1,
      -0.2,
      1e16,
      -1e16,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      1 / 3,
    ]
    const inputs: Array<Timeseries | undefined> = [
      undefined,
      [],
      [[0, -0]],
      [[0, NaN]],
      [[0, Infinity]],
      [[0, -Infinity]],
    ]
    for (let sample = 0; sample < 8; sample++) {
      let time = -100
      inputs.push(
        Array.from({ length: 96 }, () => {
          time += 1 + (random() % 19)
          return [time, values[random() % values.length]] as const
        }),
      )
    }
    const windows = [-Infinity, -1, 0, 1, 17, 120, 10000, Infinity, NaN]
    for (const points of inputs) {
      const times = [-Infinity, -200, 0, 10000, Infinity, NaN]
      for (const [time] of points ?? [])
        times.push(time - 0.5, time, time + 0.5)
      for (const t of times) {
        for (const window of windows) {
          const expected = referenceTrailingMean(points, t, window)
          const actual = trailingMean(points, t, window)
          if (!expected) expect(actual).toBeUndefined()
          else {
            // toBe uses Object.is, including NaN and signed zero; no tolerance or rounding.
            expect(actual?.mean).toBe(expected.mean)
            expect(actual?.count).toBe(expected.count)
            expect(actual?.latest).toBe(expected.latest)
          }
        }
      }
    }
  })
})

/** Original implementation, retained as a numeric oracle for the optimized lookup. */
function referenceTrailingMean(
  series: Timeseries | undefined,
  t: number,
  windowSeconds: number,
) {
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
