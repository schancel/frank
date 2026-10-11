import { BIP39_DERIVATION } from '@frank/domain-roots'
import {
  beginCodex32Signup,
  destroyRecoveredBackup,
  exportHistoricalCodex32Backup,
  recoverAccountBackupShares,
} from './index.js'

function random() {
  let offset = 0
  return (length: number) =>
    Uint8Array.from({ length }, () => (offset++ * 17 + 31) & 255)
}
const seed = (offset = 0) =>
  Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + offset) & 255)
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

test.each([
  [2, 3],
  [3, 5],
] as const)(
  'historical %i-of-%i backup reconstructs every original seed byte',
  (threshold, shareCount) => {
    const original = seed()
    const shares = exportHistoricalCodex32Backup({
      seed: original,
      threshold,
      shareCount,
      randomBytes: random(),
    })
    expect(shares.length).toBe(shareCount)
    const recovered = recoverAccountBackupShares(shares.slice(-threshold))
    try {
      expect(recovered.candidates.length).toBe(1)
      const account = recovered.candidates[0]!.account
      expect('seed' in account).toBe(true)
      if (!('seed' in account)) throw new Error('Expected historical material')
      expect(account.derivation).toBe(BIP39_DERIVATION)
      expect(same(account.seed, original)).toBe(true)
      expect(recovered.shares.every(share => share.status === 'supports')).toBe(
        true,
      )
    } finally {
      recovered.candidates.forEach(value =>
        destroyRecoveredBackup(value.account),
      )
      original.fill(0)
    }
  },
)

test('historical validation rejects a seed paired with another seed’s check, without converting it to a root', () => {
  const a = seed(),
    b = seed(1)
  try {
    const left = exportHistoricalCodex32Backup({
      seed: a,
      threshold: 2,
      shareCount: 3,
      randomBytes: random(),
    })
    const right = exportHistoricalCodex32Backup({
      seed: b,
      threshold: 2,
      shareCount: 3,
      randomBytes: random(),
    })
    const mixed = left.slice(0, 2).map((line, i) => {
      const parts = line.split(':')
      return `${parts[0]}:${parts[1]}:${right[i]!.split(':')[2]}`
    })
    expect(() => recoverAccountBackupShares(mixed)).toThrow(
      'not-account-backup',
    )
    expect(() => recoverAccountBackupShares(left.slice(0, 1))).toThrow(
      'insufficient-shares',
    )
    expect(() =>
      recoverAccountBackupShares(
        left.slice(0, 2).map(line => line.split(':')[1]!),
      ),
    ).toThrow('not-account-backup')
  } finally {
    a.fill(0)
    b.fill(0)
  }
})

test('root and historical backups in one pile remain separate explicit candidates with truthful share verdicts', () => {
  const signup = beginCodex32Signup({
    threshold: 2,
    identifier: 'test',
    indices: ['q', 'p', 'z'],
    randomBytes: random(),
  })
  const original = seed()
  const historical = exportHistoricalCodex32Backup({
    seed: original,
    threshold: 2,
    shareCount: 3,
    randomBytes: random(),
  })
  const result = recoverAccountBackupShares([
    ...signup.shares.slice(0, 2),
    ...historical.slice(0, 2),
  ])
  try {
    expect(result.candidates.length).toBe(2)
    expect(
      result.candidates.filter(value => 'seed' in value.account).length,
    ).toBe(1)
    expect(result.shares.map(share => share.candidates)).toEqual([
      [0],
      [0],
      [1],
      [1],
    ])
  } finally {
    result.candidates.forEach(value => destroyRecoveredBackup(value.account))
    signup.cancel()
    original.fill(0)
  }
})

test('one corrupted historical paper share is diagnosed while intact shares restore the seed', () => {
  const original = seed()
  const shares = exportHistoricalCodex32Backup({
    seed: original,
    threshold: 2,
    shareCount: 3,
    randomBytes: random(),
  })
  const broken =
    shares[2]!.slice(0, -1) + (shares[2]!.endsWith('q') ? 'p' : 'q')
  const result = recoverAccountBackupShares([shares[0]!, shares[1]!, broken])
  try {
    expect(result.candidates.length).toBe(1)
    expect(result.shares[2]?.status).toBe('invalid')
    expect(result.shares[2]?.code).toBe('bad-checksum')
  } finally {
    result.candidates.forEach(value => destroyRecoveredBackup(value.account))
    original.fill(0)
  }
})
