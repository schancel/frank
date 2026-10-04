/**
 * Unit tests for `utils/sorting.ts` -- the Forum's "hot"/"top"/"new" ranking algorithms
 * (`Forum.vue`'s `sortPostsByMode` call, ticket #61). Pure functions over `MessageWithReplies[]`,
 * no store/wallet/network dependencies, so no mocking is needed here.
 */
import type { MessageWithReplies } from 'src/stores/forum'
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
  const timestamp = overrides.timestamp ?? new Date()
  const milliseconds = new Date(timestamp).valueOf()
  const seconds = Math.floor(milliseconds / 1000)
  const visibleTimestamp = overrides.visibleTimestamp ?? {
    seconds: String(seconds),
    nanoseconds: (milliseconds - seconds * 1000) * 1_000_000,
  }
  return {
    poster: '0xposter',
    topic: 'stamp',
    voteWeightWei: '0',
    visibleTimestamp,
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    entries: [{ kind: 'post', message: 'hello' }],
    payloadDigest: 'deadbeef',
    timestamp,
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
      voteWeightWei: '1000',
      timestamp: new Date(now - 1000 * 60 * 60 * 24 * 10), // 10 days old
    })
    const newSmall = makePost({
      payloadDigest: 'new-small',
      voteWeightWei: '10',
      timestamp: new Date(now),
    })
    const sorted = halfLifeSort([oldBig, newSmall])
    expect(sorted.map(p => p.payloadDigest)).toEqual(['new-small', 'old-big'])
  })

  it('does not mutate the input array', () => {
    const posts = [
      makePost({ payloadDigest: 'a', voteWeightWei: '1' }),
      makePost({ payloadDigest: 'b', voteWeightWei: '2' }),
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
    const low = makePost({ payloadDigest: 'low', voteWeightWei: '1' })
    const high = makePost({ payloadDigest: 'high', voteWeightWei: '100' })
    expect(voteSort([low, high]).map(p => p.payloadDigest)).toEqual([
      'high',
      'low',
    ])
  })

  it('does not mutate the input array', () => {
    const posts = [
      makePost({ payloadDigest: 'a', voteWeightWei: '1' }),
      makePost({ payloadDigest: 'b', voteWeightWei: '2' }),
    ]
    const original = [...posts]
    voteSort(posts)
    expect(posts).toEqual(original)
  })
})

describe('sortPostsByMode', () => {
  const older = makePost({
    payloadDigest: 'older-high-vote',
    voteWeightWei: '100',
    timestamp: new Date('2026-01-01'),
  })
  const newer = makePost({
    payloadDigest: 'newer-low-vote',
    voteWeightWei: '1',
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

it('orders adjacent wide signed weights exactly and resolves ties deterministically', () => {
  const positive = 2n ** 255n - 1n
  const rows = [
    makePost({ payloadDigest: 'b', voteWeightWei: positive.toString() }),
    makePost({ payloadDigest: 'a', voteWeightWei: positive.toString() }),
    makePost({ payloadDigest: 'c', voteWeightWei: (positive - 1n).toString() }),
    makePost({ payloadDigest: 'e', voteWeightWei: (-positive).toString() }),
    makePost({
      payloadDigest: 'd',
      voteWeightWei: (-positive + 1n).toString(),
    }),
  ]
  expect(voteSort(rows).map(row => row.payloadDigest)).toEqual([
    'a',
    'b',
    'c',
    'd',
    'e',
  ])
  expect(voteSort([...rows].reverse())).toEqual(voteSort(rows))
})
it('hot ranking uses deterministic exact ties without modifying stored amounts', () => {
  const rows = [
    makePost({
      payloadDigest: 'b',
      voteWeightWei: '9007199254740992',
      timestamp: '2026-01-01',
    }),
    makePost({
      payloadDigest: 'a',
      voteWeightWei: '9007199254740993',
      timestamp: '2026-01-01',
    }),
  ]
  expect(halfLifeSort(rows)[0].payloadDigest).toBe('a')
  expect(rows[1].voteWeightWei).toBe('9007199254740993')
})

it('orders canonical nanoseconds within one display millisecond', () => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const older = makePost({
    payloadDigest: 'a',
    timestamp,
    visibleTimestamp: { seconds: '1767225600', nanoseconds: 1 },
  })
  const newer = makePost({
    payloadDigest: 'b',
    timestamp,
    visibleTimestamp: { seconds: '1767225600', nanoseconds: 999999 },
  })
  expect(new Date(older.timestamp).valueOf()).toBe(
    new Date(newer.timestamp).valueOf(),
  )
  expect(timeSort([older, newer]).map(row => row.payloadDigest)).toEqual([
    'b',
    'a',
  ])
})
it('orders wide signed canonical seconds exactly with stable digest ties', () => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const rows = [
    makePost({
      payloadDigest: 'c',
      timestamp,
      visibleTimestamp: {
        seconds: '9223372036854775806',
        nanoseconds: 999999999,
      },
    }),
    makePost({
      payloadDigest: 'b',
      timestamp,
      visibleTimestamp: { seconds: '9223372036854775807', nanoseconds: 0 },
    }),
    makePost({
      payloadDigest: 'a',
      timestamp,
      visibleTimestamp: { seconds: '9223372036854775807', nanoseconds: 0 },
    }),
    makePost({
      payloadDigest: 'e',
      timestamp,
      visibleTimestamp: {
        seconds: '-9223372036854775808',
        nanoseconds: 999999999,
      },
    }),
    makePost({
      payloadDigest: 'd',
      timestamp,
      visibleTimestamp: { seconds: '-9223372036854775807', nanoseconds: 0 },
    }),
  ]
  expect(timeSort(rows).map(row => row.payloadDigest)).toEqual([
    'a',
    'b',
    'c',
    'd',
    'e',
  ])
  expect(timeSort([...rows].reverse())).toEqual(timeSort(rows))
  expect(rows[0].visibleTimestamp.seconds).toBe('9223372036854775806')
  expect(rows[3].visibleTimestamp.seconds).toBe('-9223372036854775808')
  expect(JSON.parse(JSON.stringify(rows))[0].visibleTimestamp.seconds).toBe(
    '9223372036854775806',
  )
})
it('does not fall back to a display Date when canonical timestamp data is missing', () => {
  const malformed = makePost({ visibleTimestamp: undefined })
  expect(() => timeSort([makePost(), malformed])).toThrow()
})
