import { createLongBchChecksum, GF32_ALPHABET } from '@frank/codex32'
import {
  exportRecoveryShares,
  recoverAccountBackupShares,
  destroyRecoveredBackup,
  AccountRecoveryError,
} from './index.js'
import { decodeFrankRecoveryShare } from './frank-shares.js'
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i])
function random(start = 0) {
  let cursor = start
  return (length: number) =>
    Uint8Array.from({ length }, () => (cursor++ * 17 + 31) & 255)
}
function check(shares: readonly string[], originals: readonly Uint8Array[]) {
  const result = recoverAccountBackupShares(shares)
  try {
    expect(result.candidates.length).toBe(originals.length)
    expect(
      originals.every(original =>
        result.candidates.some(({ account }) =>
          same(
            'seed' in account ? account.seed : account.accountRoot,
            original,
          ),
        ),
      ),
    ).toBe(true)
    return result.shares
  } finally {
    result.candidates.forEach(({ account }) => destroyRecoveredBackup(account))
  }
}
test.each(['root', 'historical'] as const)(
  '%s uses the same public pipeline at each supported demo threshold',
  format => {
    const secret = random()(format === 'root' ? 32 : 64)
    try {
      for (const [threshold, shareCount] of [
        [1, 1],
        [2, 3],
        [3, 5],
      ]) {
        const shares = exportRecoveryShares({
          format,
          secret,
          threshold: threshold!,
          shareCount: shareCount!,
          randomBytes: random(10),
        })
        expect(shares.length).toBe(shareCount)
        expect(
          shares.every(
            share =>
              share.startsWith('fr1') &&
              share.length === (format === 'root' ? 131 : 182),
          ),
        ).toBe(true)
        check(shares.slice(-threshold!), [secret])
      }
    } finally {
      secret.fill(0)
    }
  },
)
test('ten mixed strings group full metadata, search conflicting indices and deduplicate the same account across sets', () => {
  const root = random(1)(32),
    historical = random(2)(64),
    other = random(3)(32)
  const make = (
    format: 'root' | 'historical',
    secret: Uint8Array,
    threshold: number,
    shareCount: number,
    identifier: string,
    start: number,
  ) =>
    exportRecoveryShares({
      format,
      secret,
      threshold,
      shareCount,
      identifier,
      randomBytes: random(start),
    })
  try {
    const first = make('root', root, 2, 3, 'test', 3)
    const collision = make('root', other, 2, 3, 'test', 7)
    const seed = make('historical', historical, 3, 5, 'test', 8)
    const duplicateAccount = make('root', root, 1, 1, 'same', 9)
    const pile = [
      ...first,
      ...collision,
      ...seed.slice(0, 3),
      ...duplicateAccount,
    ]
    expect(pile.length).toBe(10)
    const verdicts = check(pile, [root, historical, other])
    expect(verdicts.every(share => share.status === 'supports')).toBe(true)
    expect(verdicts[0]!.candidates).toEqual(verdicts[9]!.candidates)
  } finally {
    root.fill(0)
    historical.fill(0)
    other.fill(0)
  }
})
test('valid outer checksums cannot authorize a wrong reconstructed secret', () => {
  const secret = random()(64)
  try {
    const shares = exportRecoveryShares({
      format: 'historical',
      secret,
      threshold: 2,
      shareCount: 3,
      randomBytes: random(),
    })
    const forged = shares.slice(0, 2).map(text => {
      const values = Array.from(text.slice(3, -15), char =>
        GF32_ALPHABET.indexOf(char),
      )
      values[10] = values[10]! ^ 1
      try {
        return `fr1${[...values, ...createLongBchChecksum('fr', values)]
          .map(value => GF32_ALPHABET[value])
          .join('')}`
      } finally {
        values.fill(0)
      }
    })
    expect(() => recoverAccountBackupShares(forged)).toThrow(
      'not-account-backup',
    )
  } finally {
    secret.fill(0)
  }
})
test('metadata alteration fails BCH; incomplete sets report required and available distinct indices', () => {
  const secret = random()(32)
  try {
    const shares = exportRecoveryShares({
      format: 'root',
      secret,
      threshold: 3,
      shareCount: 5,
      randomBytes: random(),
    })
    const text = shares[0]!
    const changed =
      text.slice(0, 4) + (text[4] === 'q' ? 'p' : 'q') + text.slice(5)
    const decoded = decodeFrankRecoveryShare(changed)
    expect(!decoded.ok && decoded.error.code === 'bad-checksum').toBe(true)
    try {
      recoverAccountBackupShares([shares[0]!, shares[1]!, shares[0]!])
      throw new Error('Expected insufficient shares')
    } catch (error) {
      expect(error instanceof AccountRecoveryError).toBe(true)
      expect(
        (error as AccountRecoveryError).insufficientSets?.map(set => [
          set.required,
          set.available,
        ]),
      ).toEqual([[3, 2]])
    }
    expect(() =>
      exportRecoveryShares({
        format: 'root',
        secret,
        threshold: 1,
        shareCount: 2,
        randomBytes: random(),
      }),
    ).toThrow('invalid-threshold')
  } finally {
    secret.fill(0)
  }
})
