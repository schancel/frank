import {
  codex32SymbolsToBytes,
  decodeCodex32,
  interpolateCodex32Symbols,
  validateMasterPayload,
  type Codex32ErrorCode,
} from '@frank/codex32'
import {
  AccountRecoveryError,
  type ShareStatus,
  type ShareVerdict,
} from './errors.js'

/**
 * The search tries every threshold-sized subset of a backup set, so the number of shares
 * accepted for one set is limited to keep that small: the most shares whose subsets number
 * at most this many, and never fewer than the threshold plus two, so that one or two wrong
 * shares can always be identified.
 */
const MAX_SUBSETS = 5_000

/** The most shares of one backup set with this threshold that restore will examine. */
export function maxSharesForThreshold(threshold: number): number {
  let count = threshold + 2
  while (count < 31 && combinations(count + 1, threshold) <= MAX_SUBSETS)
    count++
  return count
}

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
 * Shares are grouped by backup set (identifier and threshold) and never mixed across sets.
 * Within a set every threshold-sized subset is tried; a reconstruction is recognisable
 * because the payload must be R || SHA-256(tag || R). Every share of the set is then tested
 * against each master found by interpolating that split at the share's own index. A share
 * may lie on more than one split (two polynomials can cross) and is credited to each.
 *
 * A set with more shares than maxSharesForThreshold allows is refused with `too-many-shares`.
 * Nothing about share contents or reconstructed secrets is placed in the verdicts or errors.
 */
export function searchShares(shares: readonly string[]): ShareSearchResult {
  const status = new Array<ShareStatus>(shares.length).fill('inconsistent')
  const codes = new Array<Codex32ErrorCode | null>(shares.length).fill(null)
  const candidatesOf = shares.map((): number[] => [])
  const headers = new Array<{ identifier: string; index: string } | null>(
    shares.length,
  ).fill(null)
  const entries: Entry[] = []
  const masters: { master: Uint8Array; supporting: number[] }[] = []
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
    for (const members of ordered) {
      const threshold = members[0]?.threshold ?? 0
      const limit = maxSharesForThreshold(threshold)
      if (members.length > limit) {
        throw new AccountRecoveryError('too-many-shares', undefined, limit)
      }
    }
    const searched = new Set<string>()
    for (const members of ordered) {
      const threshold = members[0]?.threshold ?? 0
      if (new Set(members.map(member => member.index)).size < threshold)
        continue
      searched.add(members[0]?.group ?? '')
      searchGroup(members, threshold, found => {
        const known = masters.findIndex(other =>
          equal(other.master, found.master),
        )
        if (known >= 0) {
          found.master.fill(0)
          return known
        }
        masters.push(found)
        return masters.length - 1
      })
    }
    masters.forEach((found, candidate) => {
      for (const position of found.supporting) {
        candidatesOf[position]?.push(candidate)
        status[position] = 'supports'
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
        candidates: Object.freeze(
          status[position] === 'supports' ? candidatesOf[position] ?? [] : [],
        ),
        code: codes[position] ?? null,
      }),
    )
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
 * Try every threshold-sized subset of one backup set. `report` receives each valid master
 * found, with every share of the set that lies on its split, and returns its candidate
 * number. Shares already credited to one master stay in play for the others.
 */
function searchGroup(
  members: readonly Entry[],
  threshold: number,
  report: (found: { master: Uint8Array; supporting: number[] }) => number,
): void {
  const supporters: Set<Entry>[] = []
  const picks = Array.from({ length: threshold }, (_, i) => i)
  for (;;) {
    const subset = picks.map(pick => members[pick] as Entry)
    if (
      new Set(subset.map(entry => entry.index)).size === subset.length &&
      // A subset inside one known split can only reconstruct that split again.
      !supporters.some(set => subset.every(entry => set.has(entry)))
    ) {
      const master = reconstruct(subset)
      if (master) {
        const supporting = members.filter(entry => liesOn(subset, entry))
        const candidate = report({
          master,
          supporting: supporting.map(entry => entry.position),
        })
        supporters[candidate] = new Set(supporting)
      }
    }
    let slot = threshold - 1
    while (slot >= 0 && picks[slot] === members.length - threshold + slot)
      slot--
    if (slot < 0) return
    picks[slot] = (picks[slot] ?? 0) + 1
    for (let next = slot + 1; next < threshold; next++)
      picks[next] = (picks[next - 1] ?? 0) + 1
  }
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

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}
