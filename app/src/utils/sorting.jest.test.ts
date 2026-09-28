/**
 * Unit tests for `utils/sorting.ts` -- the Forum's "hot"/"top"/"new" ranking algorithms
 * (`Forum.vue`'s `sortPostsByMode` call, ticket #61). Pure functions over `MessageWithReplies[]`,
 * no store/wallet/network dependencies, so no mocking is needed here.
 */
import { MessageWithReplies } from 'src/stores/forum'
import {
  halfLife,
  halfLifeSort,
  timeSort,
  voteSort,
  sortPostsByMode,
} from './sorting'

function makePost(
  overrides: Partial<MessageWithReplies> = {},
): MessageWithReplies {
  return {
    poster: '0xposter',
    topic: 'stamp',
    satoshis: 0,
    entries: [{ kind: 'post', message: 'hello' }],
    payloadDigest: 'deadbeef',
    timestamp: new Date(),
    replies: [],
    ...overrides,
  }
}

describe('halfLife', () => {
  it('returns the full amount at timestamp == now', () => {
    const now = new Date('2026-01-08T00:00:00Z')
    expect(halfLife(100, now, now)).toBe(100)
  })

  it('halves the amount after exactly one day', () => {
    const now = new Date('2026-01-08T00:00:00Z')
    const oneDayAgo = new Date('2026-01-07T00:00:00Z')
    expect(halfLife(100, oneDayAgo, now)).toBeCloseTo(50)
  })

  it('quarters the amount after two days', () => {
    const now = new Date('2026-01-08T00:00:00Z')
    const twoDaysAgo = new Date('2026-01-06T00:00:00Z')
    expect(halfLife(100, twoDaysAgo, now)).toBeCloseTo(25)
  })

  it('scales linearly with the input amount', () => {
    const now = new Date('2026-01-08T00:00:00Z')
    expect(halfLife(200, now, now)).toBe(2 * halfLife(100, now, now))
  })
})

describe('halfLifeSort', () => {
  it('ranks a smaller, more recent post above a larger, older one once decay outweighs it', () => {
    const now = Date.now()
    const oldBig = makePost({
      payloadDigest: 'old-big',
      satoshis: 1000,
      timestamp: new Date(now - 1000 * 60 * 60 * 24 * 10), // 10 days old
    })
    const newSmall = makePost({
      payloadDigest: 'new-small',
      satoshis: 10,
      timestamp: new Date(now),
    })
    const sorted = halfLifeSort([oldBig, newSmall])
    expect(sorted.map(p => p.payloadDigest)).toEqual(['new-small', 'old-big'])
  })

  it('does not mutate the input array', () => {
    const posts = [
      makePost({ payloadDigest: 'a', satoshis: 1 }),
      makePost({ payloadDigest: 'b', satoshis: 2 }),
    ]
    const original = [...posts]
    halfLifeSort(posts)
    expect(posts).toEqual(original)
  })
})

describe('timeSort', () => {
  it('orders newest first', () => {
    const older = makePost({
      payloadDigest: 'older',
      timestamp: new Date('2026-01-01'),
    })
    const newer = makePost({
      payloadDigest: 'newer',
      timestamp: new Date('2026-01-02'),
    })
    expect(timeSort([older, newer]).map(p => p.payloadDigest)).toEqual([
      'newer',
      'older',
    ])
  })

  it('accepts a timestamp stored as a string (as it round-trips through storage)', () => {
    const older = makePost({
      payloadDigest: 'older',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    const newer = makePost({
      payloadDigest: 'newer',
      timestamp: '2026-01-02T00:00:00.000Z',
    })
    expect(timeSort([older, newer]).map(p => p.payloadDigest)).toEqual([
      'newer',
      'older',
    ])
  })

  it('does not mutate the input array', () => {
    const posts = [
      makePost({ payloadDigest: 'a', timestamp: new Date('2026-01-01') }),
      makePost({ payloadDigest: 'b', timestamp: new Date('2026-01-02') }),
    ]
    const original = [...posts]
    timeSort(posts)
    expect(posts).toEqual(original)
  })
})

describe('voteSort', () => {
  it('orders highest satoshis first', () => {
    const low = makePost({ payloadDigest: 'low', satoshis: 1 })
    const high = makePost({ payloadDigest: 'high', satoshis: 100 })
    expect(voteSort([low, high]).map(p => p.payloadDigest)).toEqual([
      'high',
      'low',
    ])
  })

  it('does not mutate the input array', () => {
    const posts = [
      makePost({ payloadDigest: 'a', satoshis: 1 }),
      makePost({ payloadDigest: 'b', satoshis: 2 }),
    ]
    const original = [...posts]
    voteSort(posts)
    expect(posts).toEqual(original)
  })
})

describe('sortPostsByMode', () => {
  const older = makePost({
    payloadDigest: 'older-high-vote',
    satoshis: 100,
    timestamp: new Date('2026-01-01'),
  })
  const newer = makePost({
    payloadDigest: 'newer-low-vote',
    satoshis: 1,
    timestamp: new Date('2026-01-02'),
  })

  it('"top" delegates to voteSort', () => {
    expect(sortPostsByMode([older, newer], 'top')).toEqual(
      voteSort([older, newer]),
    )
  })

  it('"new" delegates to timeSort', () => {
    expect(sortPostsByMode([older, newer], 'new')).toEqual(
      timeSort([older, newer]),
    )
  })

  it('"hot" delegates to halfLifeSort', () => {
    expect(sortPostsByMode([older, newer], 'hot')).toEqual(
      halfLifeSort([older, newer]),
    )
  })

  it('falls back to halfLifeSort for an unrecognized mode', () => {
    const unknownMode = 'unknown' as unknown as Parameters<
      typeof sortPostsByMode
    >[1]
    expect(sortPostsByMode([older, newer], unknownMode)).toEqual(
      halfLifeSort([older, newer]),
    )
  })
})
