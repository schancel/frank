import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createMasterPayload, splitCodex32 } from '@frank/codex32'
import {
  AccountRecoveryError,
  beginCodex32Restore,
  beginCodex32Signup,
  destroyRecoveredAccount,
  exportCodex32Backup,
  maxSharesForThreshold,
  recoverFromAnyShares,
  type Codex32ShareRecovery,
  type RecoveredCodex32Account,
} from './index.js'

const randomBytes = (length: number) => new Uint8Array(nodeRandomBytes(length))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const INDICES = Array.from('qpzry9x8gf2tvdw03jn54khce6mua7l')

function account() {
  const pending = beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p'],
    randomBytes,
  })
  return pending.confirmWithMetadata([...pending.shares])
}
function backup(
  of: RecoveredCodex32Account,
  threshold: number,
  shareCount: number,
) {
  return [
    ...exportCodex32Backup({
      accountRoot: of.accountRoot,
      expected: of.metadata.descriptor,
      threshold: threshold as 2,
      shareCount,
      randomBytes,
    }),
  ]
}
/** A well-formed share (valid checksum) with the same header and index, but wrong contents. */
function poisoned(share: string): string {
  const split = splitCodex32({
    threshold: Number(share[3]) as 2,
    identifier: share.slice(4, 8),
    indices: [share[8]!, ...INDICES.filter(i => i !== share[8]).slice(0, 8)],
    secret: randomBytes(64),
    randomBytes,
  })
  if (!split.ok) throw new Error(split.error.code)
  return split.value[0]!
}
/** Shares of another valid account, forged under the header of an existing set. */
function rival(
  of: RecoveredCodex32Account,
  like: readonly string[],
  count: number,
) {
  const master = createMasterPayload(of.accountRoot)
  if (!master.ok) throw new Error('fixture')
  const used = new Set(like.map(share => share[8]))
  const split = splitCodex32({
    threshold: Number(like[0]![3]) as 2,
    identifier: like[0]!.slice(4, 8),
    indices: INDICES.filter(index => !used.has(index)).slice(0, count),
    secret: master.value,
    randomBytes,
  })
  if (!split.ok) throw new Error(split.error.code)
  return [...split.value]
}
const fingerprint = (value: RecoveredCodex32Account) =>
  hex(value.metadata.descriptor.publicRecoveryFingerprint)
const statuses = (recovery: { shares: Codex32ShareRecovery['shares'] }) =>
  recovery.shares.map(share => share.status)
function failure(action: () => unknown): AccountRecoveryError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecoveryError)
    return error as AccountRecoveryError
  }
  throw new Error('expected an AccountRecoveryError')
}
function release(recovery: Codex32ShareRecovery) {
  for (const candidate of recovery.candidates)
    destroyRecoveredAccount(candidate.account)
}

describe('restoring from more shares than the threshold', () => {
  it('4-of-10 with six shares, two of them poisoned: restores the account and names the two', () => {
    const original = account()
    const shares = backup(original, 4, 10).slice(0, 6)
    shares[1] = poisoned(shares[1]!)
    shares[4] = poisoned(shares[4]!)
    const recovery = recoverFromAnyShares(shares)
    expect(recovery.candidates).toHaveLength(1)
    const [found] = recovery.candidates
    expect(hex(found!.account.accountRoot)).toBe(hex(original.accountRoot))
    expect(fingerprint(found!.account)).toBe(fingerprint(original))
    expect(found!.supporting).toEqual([0, 2, 3, 5])
    expect(statuses(recovery)).toEqual([
      'supports',
      'inconsistent',
      'supports',
      'supports',
      'inconsistent',
      'supports',
    ])
    expect(recovery.shares[1]).toMatchObject({
      position: 1,
      index: shares[1]![8],
      identifier: shares[1]!.slice(4, 8),
      candidates: [],
    })
    release(recovery)
  })

  it('one poisoned among five of a 4-of-10', () => {
    const original = account()
    const shares = backup(original, 4, 10).slice(3, 8)
    shares[0] = poisoned(shares[0]!)
    const recovery = recoverFromAnyShares(shares)
    expect(recovery.candidates).toHaveLength(1)
    expect(fingerprint(recovery.candidates[0]!.account)).toBe(
      fingerprint(original),
    )
    expect(statuses(recovery)).toEqual([
      'inconsistent',
      'supports',
      'supports',
      'supports',
      'supports',
    ])
    release(recovery)
  })

  it('all shares good: every one supports the single account, at any count up to the whole set', () => {
    const original = account()
    const all = backup(original, 3, 31)
    for (const count of [3, 4, 10, 31]) {
      const recovery = recoverFromAnyShares(all.slice(0, count))
      expect(recovery.candidates).toHaveLength(1)
      expect(fingerprint(recovery.candidates[0]!.account)).toBe(
        fingerprint(original),
      )
      expect(new Set(statuses(recovery))).toEqual(new Set(['supports']))
      release(recovery)
    }
  })

  it('poisoned shares that are themselves a complete set of another account: both returned, nothing chosen', () => {
    const original = account()
    const attacker = account()
    const good = backup(original, 4, 10).slice(0, 5)
    const forged = rival(attacker, good, 4)
    const shares = [
      good[0]!,
      forged[0]!,
      good[1]!,
      forged[1]!,
      good[2]!,
      forged[2]!,
      good[3]!,
      forged[3]!,
      good[4]!,
    ]
    const recovery = recoverFromAnyShares(shares)
    expect(recovery.candidates).toHaveLength(2)
    const byFingerprint = new Map(
      recovery.candidates.map(candidate => [
        fingerprint(candidate.account),
        candidate.supporting,
      ]),
    )
    expect(byFingerprint.get(fingerprint(original))).toEqual([0, 2, 4, 6, 8])
    expect(byFingerprint.get(fingerprint(attacker))).toEqual([1, 3, 5, 7])
    // Even though the genuine account has more shares behind it, it is not preferred.
    expect(new Set(statuses(recovery))).toEqual(new Set(['supports']))
    for (const share of recovery.shares) {
      expect(share.candidates).toHaveLength(1)
      expect(recovery.candidates[share.candidates[0]!]!.supporting).toContain(
        share.position,
      )
    }
    release(recovery)

    // A pinned descriptor selects the expected account and reports the rest as not its shares.
    for (const [expected, mine] of [
      [original, [0, 2, 4, 6, 8]],
      [attacker, [1, 3, 5, 7]],
    ] as const) {
      const pinned = beginCodex32Restore(
        expected.metadata.descriptor,
      ).recoverAny(shares)
      expect(pinned.candidates).toHaveLength(1)
      expect(fingerprint(pinned.candidates[0]!.account)).toBe(
        fingerprint(expected),
      )
      expect(pinned.candidates[0]!.supporting).toEqual(mine)
      expect(
        pinned.shares
          .filter(share => share.status === 'supports')
          .map(share => share.position),
      ).toEqual(mine)
      expect(
        pinned.shares
          .filter(share => share.status === 'inconsistent')
          .map(share => share.position),
      ).toEqual(
        shares
          .map((_s, i) => i)
          .filter(i => !(mine as readonly number[]).includes(i)),
      )
      release(pinned)
    }
    const third = account()
    expect(
      failure(() =>
        beginCodex32Restore(third.metadata.descriptor).recoverAny(shares),
      ).code,
    ).toBe('descriptor-mismatch')
  })

  it('a complete set of another account under its own identifier is also offered, never dropped', () => {
    const original = account()
    const other = account()
    const shares = [
      ...backup(original, 2, 3),
      ...backup(other, 2, 3).slice(0, 2),
    ]
    const recovery = recoverFromAnyShares(shares)
    expect(recovery.candidates.map(c => fingerprint(c.account)).sort()).toEqual(
      [fingerprint(original), fingerprint(other)].sort(),
    )
    release(recovery)
  })

  it('shares of a different backup set mixed in are reported as a different set', () => {
    const original = account()
    const set = backup(original, 3, 5)
    const stray = backup(original, 3, 5)[0]!
    const typo = set[4]!.slice(0, -1) + (set[4]!.endsWith('q') ? 'p' : 'q')
    const recovery = recoverFromAnyShares([
      set[0]!,
      stray,
      set[1]!,
      set[2]!,
      set[1]!,
      typo,
    ])
    expect(recovery.candidates).toHaveLength(1)
    expect(statuses(recovery)).toEqual([
      'supports',
      'different-set',
      'supports',
      'supports',
      'duplicate',
      'invalid',
    ])
    expect(recovery.shares[5]!.code).toBe('bad-checksum')
    expect(recovery.shares[1]!.identifier).toBe(stray.slice(4, 8))
    release(recovery)
  })

  it('exactly the threshold with one bad share: refused, with every share accounted for', () => {
    const original = account()
    const set = backup(original, 4, 10)
    const shares = set.slice(0, 4)
    shares[2] = poisoned(shares[2]!)
    const error = failure(() => recoverFromAnyShares(shares))
    expect(error.code).toBe('not-account-backup')
    expect(error.shares).toHaveLength(4)
    expect(error.shares!.map(share => share.status)).toEqual([
      'inconsistent',
      'inconsistent',
      'inconsistent',
      'inconsistent',
    ])
    // One more share is enough to identify the bad one.
    const more = recoverFromAnyShares([...shares, set[4]!])
    expect(more.candidates).toHaveLength(1)
    expect(fingerprint(more.candidates[0]!.account)).toBe(fingerprint(original))
    expect(statuses(more)).toEqual([
      'supports',
      'supports',
      'inconsistent',
      'supports',
      'supports',
    ])
    release(more)
  })

  it('keeps the exact-threshold failure codes', () => {
    const original = account()
    const set = backup(original, 3, 5)
    const other = backup(original, 3, 5)
    const typo = set[0]!.slice(0, -1) + (set[0]!.endsWith('q') ? 'p' : 'q')
    expect(failure(() => recoverFromAnyShares(set.slice(0, 2))).code).toBe(
      'insufficient-shares',
    )
    expect(
      failure(() => recoverFromAnyShares([set[0]!, set[0]!, set[1]!])).code,
    ).toBe('duplicate-share')
    expect(
      failure(() => recoverFromAnyShares([set[0]!, set[1]!, other[2]!])).code,
    ).toBe('inconsistent-share')
    const bad = failure(() => recoverFromAnyShares([typo, set[1]!, set[2]!]))
    expect(bad.code).toBe('bad-checksum')
    expect(bad.shares![0]).toMatchObject({ position: 0, status: 'invalid' })
  })

  it('never puts share text or secrets in errors or verdicts', () => {
    const original = account()
    const shares = backup(original, 3, 6)
    shares[0] = poisoned(shares[0]!)
    const recovery = recoverFromAnyShares(shares)
    const error = failure(() => recoverFromAnyShares(shares.slice(0, 3)))
    const text =
      JSON.stringify(recovery.shares) +
      JSON.stringify(error.shares) +
      error.message +
      String(error.stack)
    for (const share of shares) expect(text).not.toContain(share.slice(9))
    expect(text).not.toContain(hex(original.accountRoot))
    release(recovery)
  })
})

describe('the search tries every subset, so the number of shares per backup set is limited', () => {
  it.each([
    [2, 31],
    [3, 31],
    [4, 20],
    [5, 16],
    [6, 14],
    [9, 14],
  ])(
    'threshold %i: at most %i shares, and never fewer than the threshold plus two',
    (threshold, limit) => {
      expect(maxSharesForThreshold(threshold)).toBe(limit)
      expect(limit).toBeGreaterThanOrEqual(threshold + 2)
    },
  )

  it('at the limit: restores, names the bad shares, and is quick', () => {
    const original = account()
    const shares = backup(original, 9, 14)
    for (const position of [0, 5, 13])
      shares[position] = poisoned(shares[position]!)
    const started = Date.now()
    const recovery = recoverFromAnyShares(shares)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(recovery.candidates).toHaveLength(1)
    expect(fingerprint(recovery.candidates[0]!.account)).toBe(
      fingerprint(original),
    )
    expect(
      recovery.shares
        .filter(share => share.status === 'inconsistent')
        .map(share => share.position),
    ).toEqual([0, 5, 13])
    release(recovery)
  })

  it('the slowest allowed input, every share wrong, is refused in well under a second or two', () => {
    const original = account()
    for (const [threshold, count] of [
      [4, 20],
      [5, 16],
      [9, 14],
    ] as const) {
      const shares = backup(original, threshold, count).map(poisoned)
      const started = Date.now()
      const error = failure(() => recoverFromAnyShares(shares))
      expect(Date.now() - started).toBeLessThan(3000)
      expect(error.code).toBe('not-account-backup')
      expect(error.shares).toHaveLength(count)
    }
  })

  it('one share over the limit is refused with the limit, before anything is searched', () => {
    const original = account()
    for (const [threshold, limit] of [
      [5, 16],
      [9, 14],
    ] as const) {
      const shares = backup(original, threshold, limit + 1)
      const error = failure(() => recoverFromAnyShares(shares))
      expect(error.code).toBe('too-many-shares')
      expect(error.maxShares).toBe(limit)
      // Even a pinned descriptor does not lift it: the answer is to enter fewer shares.
      expect(
        failure(() =>
          recoverFromAnyShares(shares, {
            expected: original.metadata.descriptor,
          }),
        ).code,
      ).toBe('too-many-shares')
      const allowed = recoverFromAnyShares(shares.slice(0, limit))
      expect(allowed.candidates).toHaveLength(1)
      release(allowed)
    }
  })

  it('the limit is per backup set: shares of another set neither count against it nor are mixed in', () => {
    const original = account()
    const other = account()
    const mine = backup(original, 5, 16)
    const theirs = backup(other, 5, 15)
    const both = recoverFromAnyShares([...theirs, ...mine])
    expect(both.candidates.map(c => fingerprint(c.account)).sort()).toEqual(
      [fingerprint(original), fingerprint(other)].sort(),
    )
    release(both)
    expect(
      failure(() => recoverFromAnyShares([...theirs, ...mine, mine[0]!]))
        .maxShares,
    ).toBe(31)
    // A set too small to reconstruct anything is reported as a different set.
    const stray = recoverFromAnyShares([...theirs.slice(0, 4), ...mine])
    expect(stray.candidates).toHaveLength(1)
    expect(fingerprint(stray.candidates[0]!.account)).toBe(
      fingerprint(original),
    )
    expect(stray.shares.slice(0, 4).map(share => share.status)).toEqual([
      'different-set',
      'different-set',
      'different-set',
      'different-set',
    ])
    release(stray)
  })
})
