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
})
