import {
  codex32SymbolsToBytes,
  decodeCodex32,
  interpolateCodex32Symbols,
  validateMasterPayload,
  type Codex32ErrorCode,
} from '@frank/codex32'
import { sha256 } from '@noble/hashes/sha256.js'
import {
  AccountRecoveryError,
  type ShareStatus,
  type ShareVerdict,
} from './errors.js'

/** Reconstructions attempted before giving up. Each is a few thousand field operations. */
export const DEFAULT_MAX_RECONSTRUCTIONS = 20_000

interface Entry {
  readonly position: number
  readonly identifier: string
  readonly threshold: number
  readonly index: string
  readonly payload: Uint8Array
  readonly group: string
}

/** One valid master found among the supplied shares. The caller owns and wipes `master`. */
export interface FoundMaster {
  readonly master: Uint8Array
  /** Positions (in the supplied order) of every share that lies on this master's split. */
  readonly supporting: readonly number[]
}

export interface ShareSearchResult {
  readonly masters: readonly FoundMaster[]
  readonly shares: readonly ShareVerdict[]
}

/**
 * Find every Frank master that a threshold-sized subset of the supplied shares reconstructs,
 * and say for each supplied share whether it belongs to one.
 *
 * A reconstruction is recognisable: the payload must be R || SHA-256(tag || R). Once one is
 * found, every other share of the same header is tested against it by interpolating that
 * split at the share's own index, not by trying more subsets. Work is capped; when the cap
 * is reached before the answer is known the search fails rather than guessing.
 *
 * Nothing about share contents or reconstructed secrets is placed in the verdicts or errors.
 */
export function searchShares(
  shares: readonly string[],
  maxReconstructions: number = DEFAULT_MAX_RECONSTRUCTIONS,
): ShareSearchResult {
  const status = new Array<ShareStatus>(shares.length).fill('inconsistent')
  const codes = new Array<Codex32ErrorCode | null>(shares.length).fill(null)
  const candidateOf = new Array<number | null>(shares.length).fill(null)
  const headers = new Array<{ identifier: string; index: string } | null>(
    shares.length,
  ).fill(null)
  const entries: Entry[] = []
  const masters: { master: Uint8Array; supporting: number[] }[] = []
  let exhausted = false
  try {
    const seen = new Map<string, Entry[]>()
    shares.forEach((text, position) => {
      const decoded = decodeCodex32(text)
      if (!decoded.ok) {
        status[position] = 'invalid'
        codes[position] = decoded.error.code
        return
      }
      const share = decoded.value
      share.seed?.fill(0)
      headers[position] = { identifier: share.identifier, index: share.index }
      // An encoded secret, or an unshared (threshold 0) string, is not a backup share.
      if (share.index === 's' || share.threshold === 0) {
        share.payload.fill(0)
        status[position] = 'invalid'
        codes[position] = 'invalid-index'
        return
      }
      const group = `${share.identifier}/${share.threshold}/${share.payload.length}`
      const sameIndex = seen.get(`${group}/${share.index}`) ?? []
      if (sameIndex.some(other => equal(other.payload, share.payload))) {
        share.payload.fill(0)
        status[position] = 'duplicate'
        return
      }
      const entry: Entry = {
        position,
        identifier: share.identifier,
        threshold: share.threshold,
        index: share.index,
        payload: share.payload,
        group,
      }
      sameIndex.push(entry)
      seen.set(`${group}/${share.index}`, sameIndex)
      entries.push(entry)
    })

    const groups = new Map<string, Entry[]>()
    for (const entry of entries) {
      const members = groups.get(entry.group) ?? []
      members.push(entry)
      groups.set(entry.group, members)
    }
    // Largest set first; ties keep the order the user entered them.
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length)
    const primary = ordered[0]
    const budget = { left: Math.max(1, Math.floor(maxReconstructions)) }
    const random = sampler(shares)
    const searched = new Set<string>()
    for (const members of ordered) {
      const threshold = members[0]?.threshold ?? 0
      if (new Set(members.map(member => member.index)).size < threshold)
        continue
      searched.add(members[0]?.group ?? '')
      const complete = searchGroup(
        members,
        threshold,
        budget,
        random,
        found => {
          const known = masters.findIndex(other =>
            equal(other.master, found.master),
          )
          if (known >= 0) {
            found.master.fill(0)
            return known
          }
          masters.push(found)
          return masters.length - 1
        },
      )
      if (!complete) exhausted = true
    }
    masters.forEach((found, candidate) => {
      for (const position of found.supporting) {
        if (candidateOf[position] === null) {
          candidateOf[position] = candidate
          status[position] = 'supports'
        }
      }
    })
    const withCandidate = new Set(
      masters.flatMap(found =>
        found.supporting.map(
          position => entries.find(e => e.position === position)?.group,
        ),
      ),
    )
    for (const entry of entries) {
      if (status[entry.position] === 'supports') continue
      status[entry.position] =
        entry.group === primary?.[0]?.group || withCandidate.has(entry.group)
          ? 'inconsistent'
          : 'different-set'
    }
    const verdicts: ShareVerdict[] = shares.map((_text, position) =>
      Object.freeze({
        position,
        identifier: headers[position]?.identifier ?? null,
        index: headers[position]?.index ?? null,
        status: status[position] ?? 'invalid',
        candidate: candidateOf[position] ?? null,
        code: codes[position] ?? null,
      }),
    )
    if (exhausted) {
      // Something may still be hidden in what was not examined: do not answer.
      throw new AccountRecoveryError('too-many-inconsistent-shares', verdicts)
    }
    if (masters.length === 0) {
      throw new AccountRecoveryError(
        failureCode(searched.size > 0, status, codes, groups.size),
        verdicts,
      )
    }
    const result = Object.freeze({
      masters: Object.freeze(masters.map(found => Object.freeze(found))),
      shares: Object.freeze(verdicts),
    })
    masters.length = 0 // ownership moved to the caller
    return result
  } finally {
    for (const entry of entries) entry.payload.fill(0)
    for (const found of masters) found.master.fill(0)
  }
}

/** Why no account could be reconstructed, in the terms the exact-threshold path used. */
function failureCode(
  anySetReachedThreshold: boolean,
  status: readonly ShareStatus[],
  codes: readonly (Codex32ErrorCode | null)[],
  groupCount: number,
): AccountRecoveryError['code'] {
  if (anySetReachedThreshold) return 'not-account-backup'
  const invalid = codes.find(code => code !== null)
  if (invalid) return invalid
  if (status.includes('duplicate')) return 'duplicate-share'
  if (groupCount > 1) return 'inconsistent-share'
  return 'insufficient-shares'
}

/**
 * Search one header group. Returns false when the cap was reached before the group was
 * settled. `report` receives each distinct valid master and returns its candidate number.
 */
function searchGroup(
  members: readonly Entry[],
  threshold: number,
  budget: { left: number },
  random: (bound: number) => number,
  report: (found: { master: Uint8Array; supporting: number[] }) => number,
): boolean {
  const supporters: Set<Entry>[] = []
  const attempt = (subset: readonly Entry[]): void => {
    if (new Set(subset.map(entry => entry.index)).size !== subset.length) return
    // A subset inside one known split can only reconstruct that split again.
    if (supporters.some(set => subset.every(entry => set.has(entry)))) return
    budget.left -= 1
    const master = reconstruct(subset)
    if (!master) return
    const supporting = members.filter(entry => liesOn(subset, entry))
    const candidate = report({
      master,
      supporting: supporting.map(entry => entry.position),
    })
    supporters[candidate] = new Set([
      ...(supporters[candidate] ?? []),
      ...supporting,
    ])
  }
  const exhaustive = (pool: readonly Entry[]): boolean => {
    const picks = Array.from({ length: threshold }, (_, i) => i)
    for (;;) {
      if (budget.left <= 0) return false
      attempt(picks.map(pick => pool[pick] as Entry))
      let slot = threshold - 1
      while (slot >= 0 && picks[slot] === pool.length - threshold + slot) slot--
      if (slot < 0) return true
      picks[slot] = (picks[slot] ?? 0) + 1
      for (let next = slot + 1; next < threshold; next++)
        picks[next] = (picks[next - 1] ?? 0) + 1
    }
  }
  if (combinations(members.length, threshold) <= budget.left) {
    return exhaustive(members)
  }
  // Too many subsets to try them all. Sample: when most shares are good a random subset is
  // all good with high probability. After a hit, only shares off that split remain suspect.
  let pool = [...members]
  while (budget.left > 0) {
    if (pool.length < threshold) return true
    if (combinations(pool.length, threshold) <= budget.left) {
      return exhaustive(pool)
    }
    const subset: Entry[] = []
    const rest = [...pool]
    while (subset.length < threshold) {
      subset.push(...rest.splice(random(rest.length), 1))
    }
    const before = supporters.length
    const spent = budget.left
    attempt(subset)
    // A skipped sample still counts, so the loop always ends.
    if (budget.left === spent) budget.left -= 1
    if (supporters.length > before) {
      const found = supporters[supporters.length - 1] as Set<Entry>
      pool = pool.filter(entry => !found.has(entry))
    }
  }
  return false
}

function reconstruct(subset: readonly Entry[]): Uint8Array | null {
  const symbols = interpolateCodex32Symbols(subset, 's')
  if (!symbols.ok) return null
  const bytes = codex32SymbolsToBytes(symbols.value)
  symbols.value.fill(0)
  if (!bytes.ok) return null
  const validated =
    bytes.value.length === 64 ? validateMasterPayload(bytes.value) : undefined
  if (!validated?.ok) {
    bytes.value.fill(0)
    return null
  }
  validated.value.fill(0)
  return bytes.value
}

function liesOn(subset: readonly Entry[], entry: Entry): boolean {
  if (subset.includes(entry)) return true
  const expected = interpolateCodex32Symbols(subset, entry.index)
  if (!expected.ok) return false
  try {
    return equal(expected.value, entry.payload)
  } finally {
    expected.value.fill(0)
  }
}

function combinations(n: number, k: number): number {
  let result = 1
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i
    if (result > Number.MAX_SAFE_INTEGER / 64) return Infinity
  }
  return Math.round(result)
}

/**
 * Sampling order derived from the input itself: the same shares always search the same
 * way, and no fixed pattern exists for a pile of bad shares to be arranged against.
 */
function sampler(shares: readonly string[]): (bound: number) => number {
  const seed = sha256(
    Uint8Array.from(
      shares.join('\n'),
      character => character.charCodeAt(0) & 255,
    ),
  )
  let a = 0
  let b = 0
  for (let i = 0; i < 4; i++) {
    a = (a << 8) | (seed[i] ?? 0)
    b = (b << 8) | (seed[i + 4] ?? 0)
  }
  seed.fill(0)
  let state = (a ^ (b << 1)) >>> 0 || 0x9e3779b9
  return bound => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state % bound
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}
