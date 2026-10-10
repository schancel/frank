import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level, { type LevelDB } from 'level'
import { at, type SeriesPoint } from '@frank/wallet/oracle'
import {
  FULL_RESOLUTION_SECONDS,
  coverLatest,
  coverRange,
  emptyOracleCache,
  mergeFeed,
  missingRanges,
  oracleInputs,
  restoreOracleCache,
  saveOracleCache,
  thinOldPoints,
} from './oracle-series'
import { testFeed } from './oracle-test-feed'

const DAY = 86_400
const NOW = 2_000_000_000

describe('the local series', () => {
  it('has nothing to compute from before a feed was received', () => {
    expect(oracleInputs(emptyOracleCache())).toBeUndefined()
  })

  it('adds each answer’s points to the series of the same name', () => {
    let cache = mergeFeed(emptyOracleCache(), testFeed([NOW - 600]), NOW)
    cache = mergeFeed(cache, testFeed([NOW]), NOW)
    expect(cache.series['price/btc-mainnet'].points).toEqual([
      [NOW - 600, 100],
      [NOW, 100],
    ])
    expect(oracleInputs(cache)?.basket.entries).toHaveLength(2)
  })

  it('a point received later for a time already held replaces it', () => {
    let cache = mergeFeed(emptyOracleCache(), testFeed([NOW - 600, NOW]), NOW)
    const again = testFeed([NOW - 600])
    again.series['price/btc-mainnet'].points = [[NOW - 600, 123]]
    cache = mergeFeed(cache, again, NOW)
    expect(cache.series['price/btc-mainnet'].points).toEqual([
      [NOW - 600, 123],
      [NOW, 100],
    ])
  })

  it('history received after live points does not overwrite what is said about the present', () => {
    const live = testFeed([NOW])
    live.series['price/btc-mainnet'].source = 'live source'
    let cache = mergeFeed(emptyOracleCache(), live, NOW)
    const history = testFeed([NOW - 400 * DAY])
    history.series['price/btc-mainnet'].stale = true
    cache = mergeFeed(cache, history, NOW)
    expect(cache.series['price/btc-mainnet']).toMatchObject({
      source: 'live source',
      stale: false,
    })
    expect(cache.series['price/btc-mainnet'].points).toHaveLength(2)
  })

  it('thins points older than two weeks to the first of each day, as received', () => {
    const old = NOW - FULL_RESOLUTION_SECONDS - 3 * DAY
    const startOfDay = Math.floor(old / DAY) * DAY
    const points: SeriesPoint[] = [
      [startOfDay + 10, 1],
      [startOfDay + 700, 2],
      [startOfDay + DAY + 5, 3],
      [NOW - 1200, 4],
      [NOW - 600, 5],
    ]
    const thinned = thinOldPoints(points, NOW)
    expect(thinned).toEqual([
      [startOfDay + 10, 1],
      [startOfDay + DAY + 5, 3],
      [NOW - 1200, 4],
      [NOW - 600, 5],
    ])
    // The floor lookup works the same on the thinned series.
    expect(at(thinned, startOfDay + 800)).toEqual([startOfDay + 10, 1])
  })
})

describe('what the local series cover', () => {
  it('consecutive latest answers are one covered stretch', () => {
    let coverage = coverLatest([], NOW, 600)
    coverage = coverLatest(coverage, NOW + 600, 600)
    coverage = coverLatest(coverage, NOW + 1500, 600)
    expect(coverage).toEqual([{ from: NOW, until: NOW + 1500, step: 600 }])
    expect(missingRanges(coverage, NOW, NOW + 1500, 600)).toEqual([])
  })

  it('a silence longer than three intervals leaves a gap between two stretches', () => {
    let coverage = coverLatest([], NOW, 600)
    coverage = coverLatest(coverage, NOW + 600, 600)
    coverage = coverLatest(coverage, NOW + 8 * 3600, 600)
    expect(coverage).toHaveLength(2)
    expect(missingRanges(coverage, NOW, NOW + 8 * 3600, 600)).toEqual([
      { since: NOW + 600, until: NOW + 8 * 3600 },
    ])
  })

  it('names the stretch before the first local point', () => {
    const coverage = coverLatest([], NOW, 600)
    expect(missingRanges(coverage, NOW - 7 * DAY, NOW, 3600)).toEqual([
      { since: NOW - 7 * DAY, until: NOW },
    ])
  })

  it('a range received is covered at its step and coarser, not at a finer one', () => {
    const coverage = coverRange([], NOW - 30 * DAY, NOW, DAY)
    expect(missingRanges(coverage, NOW - 30 * DAY, NOW, DAY)).toEqual([])
    expect(missingRanges(coverage, NOW - 30 * DAY, NOW, 30 * DAY)).toEqual([])
    expect(missingRanges(coverage, NOW - DAY, NOW, 3600)).toEqual([
      { since: NOW - DAY, until: NOW },
    ])
  })

  it('does not ask for a sliver shorter than one step', () => {
    const coverage = coverRange([], NOW - 1000, NOW - 300, 600)
    expect(missingRanges(coverage, NOW - 1200, NOW, 600)).toEqual([])
  })
})

describe('on the device', () => {
  let directory: string
  let storage: LevelDB

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'frank-oracle-cache-'))
    storage = level(directory)
  })

  afterEach(async () => {
    await storage.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('comes back as it was saved, and an append writes only the new points', async () => {
    let cache = mergeFeed(
      emptyOracleCache(),
      testFeed([NOW - 600], { electricity: [[NOW - DAY, -0.01]] }),
      NOW,
    )
    cache = { ...cache, coverage: coverLatest(cache.coverage, NOW - 600, 600) }
    await saveOracleCache(storage, cache)
    const batch = jest.spyOn(storage, 'batch')
    cache = mergeFeed(cache, testFeed([NOW]), NOW)
    await saveOracleCache(storage, cache)
    // One new point in each of five series, and the metadata.
    expect((batch.mock.calls[0][0] as unknown[]).length).toBe(6)

    const restored = await restoreOracleCache(storage)
    expect(restored).toEqual(cache)
    expect(restored.series['electricity/aggregate'].points).toEqual([
      [NOW - DAY, -0.01],
    ])
  })

  it('restores nothing from an empty database', async () => {
    expect(await restoreOracleCache(storage)).toEqual(emptyOracleCache())
  })
})
