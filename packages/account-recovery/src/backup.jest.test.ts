import { randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  createMasterPayload,
  decodeCodex32,
  splitCodex32,
} from '@frank/codex32'
import { DOMAIN_PURPOSES } from '@frank/domain-roots'
import {
  AccountRecoveryError,
  beginCodex32Restore,
  beginCodex32Signup,
  exportCodex32Backup,
  recoverCodex32Shares,
  type RecoveredCodex32Account,
} from './index.js'

const randomBytes = (length: number) => new Uint8Array(nodeRandomBytes(length))

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Everything that makes two recoveries "the same account". */
function fingerprintOf(account: RecoveredCodex32Account) {
  return {
    accountRoot: hex(account.accountRoot),
    roots: DOMAIN_PURPOSES.map(purpose => hex(account.roots[purpose].bytes)),
    descriptor: hex(account.metadata.descriptor.publicRecoveryFingerprint),
    retirement: hex(account.metadata.masterRetirementId),
    identity: hex(account.metadata.recoveryIdentityCommitment),
  }
}

function signup() {
  const pending = beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p', 'z'],
    randomBytes,
  })
  const shares = [...pending.shares]
  return { shares, account: pending.confirmWithMetadata(shares.slice(0, 2)) }
}

function backup(
  account: RecoveredCodex32Account,
  threshold: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 2,
  shareCount = 3,
  random = randomBytes,
) {
  return exportCodex32Backup({
    accountRoot: account.accountRoot,
    expected: account.metadata.descriptor,
    threshold,
    shareCount,
    randomBytes: random,
  })
}

function code(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRecoveryError)
    return (error as AccountRecoveryError).code
  }
  throw new Error('expected an AccountRecoveryError')
}

describe('backup shares issued after signup', () => {
  it('restore the same account as the signup shares, from any threshold subset', () => {
    const created = signup()
    const expected = fingerprintOf(created.account)
    const shares = backup(created.account)
    expect(shares).toHaveLength(3)
    for (const subset of [
      [shares[0]!, shares[1]!],
      [shares[1]!, shares[2]!],
      [shares[2]!, shares[0]!],
    ]) {
      expect(fingerprintOf(recoverCodex32Shares(subset))).toEqual(expected)
      // The default restore path pins no descriptor; a pinned one agrees too.
      expect(fingerprintOf(beginCodex32Restore().recover(subset))).toEqual(
        expected,
      )
      expect(
        fingerprintOf(
          beginCodex32Restore(created.account.metadata.descriptor).recover(
            subset,
          ),
        ),
      ).toEqual(expected)
    }
    expect(
      fingerprintOf(recoverCodex32Shares(created.shares.slice(1))),
    ).toEqual(expected)
  })

  it.each([
    [2, 3],
    [3, 5],
    [6, 10],
    [9, 31],
  ] as const)('supports a %i-of-%i set', (threshold, shareCount) => {
    const created = signup()
    const shares = backup(created.account, threshold, shareCount)
    expect(shares).toHaveLength(shareCount)
    expect(new Set(shares.map(share => share[8])).size).toBe(shareCount)
    expect(
      fingerprintOf(recoverCodex32Shares(shares.slice(-threshold))),
    ).toEqual(fingerprintOf(created.account))
  })

  it('can be re-issued from a restored account as well', () => {
    const created = signup()
    const restored = recoverCodex32Shares(backup(created.account).slice(0, 2))
    expect(
      fingerprintOf(recoverCodex32Shares(backup(restored).slice(1))),
    ).toEqual(fingerprintOf(created.account))
  })

  it('are a separate set per backup: each works alone and mixing is refused', () => {
    const created = signup()
    const first = backup(created.account)
    const second = backup(created.account)
    const expected = fingerprintOf(created.account)
    expect(fingerprintOf(recoverCodex32Shares(first.slice(0, 2)))).toEqual(
      expected,
    )
    expect(fingerprintOf(recoverCodex32Shares(second.slice(0, 2)))).toEqual(
      expected,
    )
    const idOf = (share: string) => {
      const decoded = decodeCodex32(share)
      if (!decoded.ok) throw new Error('share must decode')
      return decoded.value.identifier
    }
    expect(idOf(first[0]!)).not.toBe(idOf(second[0]!))
    expect(code(() => recoverCodex32Shares([first[0]!, second[1]!]))).toBe(
      'inconsistent-share',
    )
    // Signup shares and a later backup are different sets too.
    expect(
      code(() => recoverCodex32Shares([created.shares[0]!, first[1]!])),
    ).toBe('inconsistent-share')
  })

  it('refuses a mix even when two backups draw the same identifier', () => {
    const created = signup()
    // Same identifier bytes for both backups, different polynomial randomness.
    const colliding = () => {
      let calls = 0
      return (length: number) =>
        ++calls === 1 ? new Uint8Array(length).fill(9) : randomBytes(length)
    }
    const first = backup(created.account, 2, 3, colliding())
    const second = backup(created.account, 2, 3, colliding())
    expect(first[0]!.slice(0, 8)).toBe(second[0]!.slice(0, 8))
    expect(code(() => recoverCodex32Shares([first[0]!, second[1]!]))).toBe(
      'not-account-backup',
    )
    expect(
      code(() => beginCodex32Restore().recover([first[0]!, second[1]!])),
    ).toBe('not-account-backup')
  })

  it('will not split anything but the account root of the stated account', () => {
    const created = signup()
    // The defect this replaces: a derived domain root presented as the account root.
    for (const purpose of DOMAIN_PURPOSES) {
      expect(
        code(() =>
          exportCodex32Backup({
            accountRoot: created.account.roots[purpose].bytes,
            expected: created.account.metadata.descriptor,
            threshold: 2,
            shareCount: 3,
            randomBytes,
          }),
        ),
      ).toBe('descriptor-mismatch')
    }
    const other = signup()
    expect(
      code(() =>
        exportCodex32Backup({
          accountRoot: other.account.accountRoot,
          expected: created.account.metadata.descriptor,
          threshold: 2,
          shareCount: 3,
          randomBytes,
        }),
      ),
    ).toBe('descriptor-mismatch')
    expect(
      code(() =>
        exportCodex32Backup({
          accountRoot: new Uint8Array(31),
          expected: created.account.metadata.descriptor,
          threshold: 2,
          shareCount: 3,
          randomBytes,
        }),
      ),
    ).toBe('bad-format')
  })

  it.each([
    [1, 3],
    [10, 12],
    [3, 2],
    [2, 32],
    [2.5, 3],
  ])(
    'rejects a %s-of-%s policy instead of adjusting it',
    (threshold, count) => {
      const created = signup()
      expect(code(() => backup(created.account, threshold as 2, count))).toBe(
        'invalid-threshold',
      )
    },
  )

  it('does not change or wipe the caller-owned account root', () => {
    const created = signup()
    const before = hex(created.account.accountRoot)
    backup(created.account)
    expect(hex(created.account.accountRoot)).toBe(before)
  })
})

describe('restore refuses share sets that are not an account backup', () => {
  const split = (secret: Uint8Array) => {
    const shares = splitCodex32({
      threshold: 2,
      identifier: 'test',
      indices: ['q', 'p', 'z'],
      secret,
      randomBytes,
    })
    if (!shares.ok) throw new Error(shares.error.code)
    return shares.value.slice(0, 2)
  }

  it.each([
    [
      'a bare derived domain root',
      () => signup().account.roots['evm-wallet'].bytes,
    ],
    [
      'a bare account root without its validation half',
      () => signup().account.accountRoot,
    ],
    ['64 unrelated bytes', () => randomBytes(64)],
    ['a 16-byte seed', () => randomBytes(16)],
  ])('%s', (_name, secret) => {
    const shares = split(secret())
    expect(code(() => recoverCodex32Shares(shares))).toBe('not-account-backup')
    expect(code(() => beginCodex32Restore().recover(shares))).toBe(
      'not-account-backup',
    )
  })

  it('a pinned descriptor exposes shares made by the old Settings backup; without one they cannot be told from signup shares', () => {
    // Before this change Settings wrapped the derived EVM root as if it were an account
    // root. Such a set is byte-for-byte a valid old-format account backup of a different
    // (empty) account, so only the independently saved descriptor can reject it.
    const created = signup()
    const wrapped = createMasterPayload(
      created.account.roots['evm-wallet'].bytes,
    )
    if (!wrapped.ok) throw new Error('fixture')
    const old = split(wrapped.value)
    expect(
      code(() =>
        beginCodex32Restore(created.account.metadata.descriptor).recover(old),
      ),
    ).toBe('descriptor-mismatch')
    const wrong = recoverCodex32Shares(old)
    expect(fingerprintOf(wrong).descriptor).not.toBe(
      fingerprintOf(created.account).descriptor,
    )
  })
})
