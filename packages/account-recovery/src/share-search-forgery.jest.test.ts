import { randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  createMasterPayload,
  decodeCodex32,
  encodeCodex32,
  interpolateCodex32Symbols,
  splitCodex32,
} from '@frank/codex32'
import {
  AccountRecoveryError,
  beginCodex32Signup,
  destroyRecoveredAccount,
  exportCodex32Backup,
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
 * control on a polynomial that also passes through that genuine share. Codex32 strings
 * interpolate character by character (header and checksum included), so the forgeries are
 * well-formed shares of the same backup set as far as any per-share check can tell.
 */
function forgeThrough(
  seen: string,
  attacker: RecoveredCodex32Account,
  count: number,
  avoid: readonly string[],
): string[] {
  const threshold = Number(seen[3]) as 2
  const identifier = seen.slice(4, 8)
  const master = createMasterPayload(attacker.accountRoot)
  if (!master.ok) throw new Error('fixture')
  const secret = encodeCodex32({
    threshold,
    identifier,
    index: 's',
    secret: master.value,
  })
  if (!secret.ok) throw new Error(secret.error.code)
  const used = new Set(avoid.map(share => share[8]))
  const free = INDICES.filter(index => !used.has(index))
  // threshold - 2 arbitrary well-formed strings of this header fix the rest of the polynomial.
  const filler = splitCodex32({
    threshold,
    identifier,
    indices: [...free.slice(0, threshold - 2), ...free.slice(-2)].slice(
      0,
      Math.max(threshold, threshold - 2),
    ),
    secret: randomBytes(64),
    randomBytes,
  })
  if (!filler.ok) throw new Error(filler.error.code)
  const points = [secret.value, seen, ...filler.value.slice(0, threshold - 2)]
  const symbols = (text: string) => ({
    index: text[8]!,
    payload: Uint8Array.from(text.slice(3), character =>
      CHARSET.indexOf(character),
    ),
  })
  const forged = [
    ...filler.value.slice(0, threshold - 2),
    ...free.slice(threshold - 2, count).map(index => {
      const derived = interpolateCodex32Symbols(points.map(symbols), index)
      if (!derived.ok) throw new Error(derived.error.code)
      return `ms1${Array.from(derived.value, value => CHARSET[value]).join('')}`
    }),
  ].slice(0, count)
  for (const share of forged) {
    const decoded = decodeCodex32(share)
    if (!decoded.ok)
      throw new Error(`forged share invalid: ${decoded.error.code}`)
    expect(decoded.value.identifier).toBe(identifier)
  }
  return forged
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
