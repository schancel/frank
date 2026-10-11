import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createLongBchChecksum, interpolateGf32Symbols } from '@frank/codex32'
import { decodeFrankRecoveryShare } from './frank-shares.js'
import {
  AccountRecoveryError,
  beginCodex32Signup,
  destroyRecoveredAccount,
  exportCodex32Backup,
  exportRecoveryShares,
  recoverFromAnyShares,
  type Codex32ShareRecovery,
  type RecoveredCodex32Account,
} from './index.js'

const randomBytes = (length: number) => new Uint8Array(nodeRandomBytes(length))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const INDICES = Array.from(CHARSET).filter(index => index !== 's')

function account() {
  const pending = beginCodex32Signup({
    threshold: 2,
    identifier: 'frnk',
    indices: ['q', 'p'],
    randomBytes,
  })
  return pending.confirmWithMetadata([...pending.shares])
}
function backup(of: RecoveredCodex32Account, threshold: number, count: number) {
  return [
    ...exportCodex32Backup({
      accountRoot: of.accountRoot,
      expected: of.metadata.descriptor,
      threshold: threshold as 2,
      shareCount: count,
      randomBytes,
    }),
  ]
}
const fingerprint = (value: RecoveredCodex32Account) =>
  hex(value.metadata.descriptor.publicRecoveryFingerprint)
function release(recovery: Codex32ShareRecovery) {
  for (const candidate of recovery.candidates)
    destroyRecoveredAccount(candidate.account)
}

/**
 * What an insider who has seen ONE genuine share can do: build shares of an account they
 * control on a polynomial that also passes through that genuine share. An attacker can interpolate payloads through a genuine point and their own valid
 * secret, then recompute the public BCH framing. No per-share checksum can distinguish
 * these; bounded search must expose every valid account instead of choosing the largest set.
 */
function forgeThrough(
  seen: string,
  attacker: RecoveredCodex32Account,
  count: number,
  avoid: readonly string[],
): string[] {
  const decoded = decodeFrankRecoveryShare(seen)
  if (!decoded.ok) throw new Error('fixture')
  const header = decoded.value
  const threshold = header.threshold
  const attackerSet = exportRecoveryShares({
    format: 'root',
    secret: attacker.accountRoot,
    threshold,
    shareCount: threshold,
    identifier: header.identifier,
    randomBytes,
  })
  const attackerRows = attackerSet.map(text => {
    const row = decodeFrankRecoveryShare(text)
    if (!row.ok) throw new Error('fixture')
    return row.value
  })
  const secret = interpolateGf32Symbols(attackerRows, 's')
  if (!secret.ok) throw new Error('fixture')
  const used = new Set(avoid.map(text => text[12]))
  const free = INDICES.filter(index => !used.has(index))
  const filler = free.slice(0, threshold - 2).map(index => ({
    index,
    payload: Uint8Array.from(
      randomBytes(header.payload.length),
      byte => byte & 31,
    ),
  }))
  const points = [{ index: 's', payload: secret.value }, header, ...filler]
  try {
    return free.slice(0, count).map(index => {
      const derived = interpolateGf32Symbols(points, index)
      if (!derived.ok) throw new Error('fixture')
      const data = [
        ...header.commonMetadata,
        CHARSET.indexOf(index),
        ...derived.value,
      ]
      try {
        const text = `fr1${[...data, ...createLongBchChecksum('fr', data)]
          .map(value => CHARSET[value])
          .join('')}`
        const verified = decodeFrankRecoveryShare(text)
        if (!verified.ok) throw new Error('forged framing invalid')
        verified.value.payload.fill(0)
        return text
      } finally {
        data.fill(0)
        derived.value.fill(0)
      }
    })
  } finally {
    header.payload.fill(0)
    secret.value.fill(0)
    attackerRows.forEach(row => row.payload.fill(0))
    filler.forEach(row => row.payload.fill(0))
  }
}

describe('forged shares built through one genuine share', () => {
  it.each([4, 8, 11])(
    'with %i forged shares beside the 5 genuine ones, both accounts are returned and none is chosen',
    forgedCount => {
      const victim = account()
      const attacker = account()
      const honest = backup(victim, 5, 5)
      const forged = forgeThrough(honest[2]!, attacker, forgedCount, honest)
      const pile = [...forged.slice(0, 3), ...honest, ...forged.slice(3)]
      const recovery = recoverFromAnyShares(pile)
      expect(
        recovery.candidates.map(c => fingerprint(c.account)).sort(),
      ).toEqual([fingerprint(victim), fingerprint(attacker)].sort())
      // The seen share lies on both splits and is credited to both.
      const seenAt = pile.indexOf(honest[2]!)
      for (const candidate of recovery.candidates)
        expect(candidate.supporting).toContain(seenAt)
      expect(recovery.shares[seenAt]!.candidates).toHaveLength(2)
      const mine = recovery.candidates.find(
        candidate => fingerprint(candidate.account) === fingerprint(victim),
      )
      expect(mine!.supporting).toEqual(
        honest.map(share => pile.indexOf(share)).sort((a, b) => a - b),
      )
      release(recovery)

      // A pinned descriptor gets the account it names, never the other.
      for (const expected of [victim, attacker]) {
        const pinned = recoverFromAnyShares(pile, {
          expected: expected.metadata.descriptor,
        })
        expect(pinned.candidates.map(c => fingerprint(c.account))).toEqual([
          fingerprint(expected),
        ])
        release(pinned)
      }
    },
  )

  it('the reviewed case, 16 forged making 21 shares at threshold 5, is refused: enter at most 16', () => {
    const victim = account()
    const attacker = account()
    const honest = backup(victim, 5, 5)
    const forged = forgeThrough(honest[2]!, attacker, 16, honest)
    const pile = [...forged.slice(0, 3), ...honest, ...forged.slice(3)]
    let error: AccountRecoveryError | undefined
    try {
      release(recoverFromAnyShares(pile))
    } catch (failure) {
      error = failure as AccountRecoveryError
    }
    expect(error).toBeInstanceOf(AccountRecoveryError)
    expect(error!.code).toBe('too-many-shares')
    expect(error!.maxShares).toBe(16)
  })
})
