import {
  codex32SecretPayloadSymbols,
  createMasterPayload,
  decodeCodex32,
  recoverCodex32Exact,
  splitCodex32,
  validateMasterPayload,
  type Codex32ErrorCode,
  type RecoveredCodex32,
  type SplitCodex32Input,
} from '@frank/codex32'
import {
  DERIVATION_REGISTRY_CODE,
  DERIVATION_REGISTRY_ID,
  DOMAIN_PURPOSES,
  RECOVERY_FORMAT_CODE,
  RECOVERY_FORMAT_ID,
  deriveDomainRoot,
  type DomainPurpose,
  type DomainRoot,
} from '@frank/domain-roots'
import { AccountRecoveryError, type ShareVerdict } from './errors.js'
import { searchShares } from './share-search.js'

export { maxSharesForThreshold } from './share-search.js'
import {
  deriveRecoveryPublicMetadata,
  snapshotBytes,
  snapshotPublicDescriptor,
  type PublicRecoveryDescriptor,
  type RecoveryPublicMetadata,
} from './public-metadata.js'

export {
  AccountRecoveryError,
  type AccountRecoveryErrorCode,
  type ShareStatus,
  type ShareVerdict,
} from './errors.js'
export {
  decodeRecoveryDescriptor,
  decodeRecoveryFingerprint,
  deriveRecoveryPublicMetadata,
  encodeRecoveryDescriptor,
  encodeRecoveryFingerprint,
  type PublicRecoveryDescriptor,
  type RecoveryPublicMetadata,
} from './public-metadata.js'

const ACCOUNT_ROOT_LENGTH = 32
const MASTER_LENGTH = 64
const CODEX32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
/** Every share index except the secret index `s`. */
const BACKUP_SHARE_INDICES = Object.freeze(
  Array.from(CODEX32_ALPHABET).filter(index => index !== 's'),
)

/** Share-family metadata only; it never authenticates account identity. */
export interface RecoveryFamilyMetadata {
  readonly recoveryFormat: typeof RECOVERY_FORMAT_ID
  readonly recoveryFormatCode: typeof RECOVERY_FORMAT_CODE
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly registryCode: typeof DERIVATION_REGISTRY_CODE
  readonly threshold: SplitCodex32Input['threshold']
  readonly identifier: string
}

/** @deprecated Use RecoveryFamilyMetadata; this is not a frankdesc identity envelope. */
export type RecoveryDescriptor = RecoveryFamilyMetadata

export type AccountDomainRoots = {
  readonly [Purpose in DomainPurpose]: DomainRoot<Purpose>
}

export interface PendingCodex32Signup {
  /** @deprecated Family metadata only. Prefer familyMetadata. */
  readonly descriptor: RecoveryDescriptor
  readonly familyMetadata: RecoveryFamilyMetadata
  /** Public descriptor to retain independently before the caller activates an account. */
  readonly publicDescriptor: PublicRecoveryDescriptor
  /** Immutable strings retained until confirm/cancel; callers own any copies. */
  readonly shares: readonly string[]
  confirm(shares: readonly string[]): AccountDomainRoots
  confirmWithMetadata(shares: readonly string[]): RecoveredCodex32Account
  cancel(): void
}

export interface RecoveredCodex32Account {
  readonly roots: AccountDomainRoots
  readonly metadata: RecoveryPublicMetadata
  /**
   * Owned copy of the 32-byte account root R the roots were derived from. It is what a
   * later backup must split; wipe it with destroyRecoveredAccount when custody has it.
   */
  readonly accountRoot: Uint8Array
}

export interface ExportCodex32BackupInput {
  /** The stored 32-byte account root R. Never a derived domain root. */
  readonly accountRoot: Uint8Array
  /** The account's own recorded public descriptor; the root must reproduce it. */
  readonly expected: PublicRecoveryDescriptor
  readonly threshold: SplitCodex32Input['threshold']
  readonly shareCount: number
  readonly randomBytes: (length: number) => Uint8Array
}

export interface PendingCodex32Restore<
  T extends PublicRecoveryDescriptor | undefined =
    | PublicRecoveryDescriptor
    | undefined,
> {
  /** Immutable snapshot; selecting another descriptor requires a new ceremony. */
  readonly descriptor: T
  /** Invalid M can retry; a valid M with a different fingerprint consumes the ceremony. */
  recover(shares: readonly string[]): RecoveredCodex32Account
  /**
   * Recover from the threshold number of shares or more, tolerating bad ones. See
   * recoverFromAnyShares. With a pinned descriptor only the matching account is returned.
   * Success consumes the ceremony.
   */
  recoverAny(shares: readonly string[]): Codex32ShareRecovery
  cancel(): void
}

/** One account that a threshold-sized subset of the supplied shares reconstructs. */
export interface Codex32RecoveryCandidate {
  /** Caller-owned; wipe every candidate, chosen or not, with destroyRecoveredAccount. */
  readonly account: RecoveredCodex32Account
  /** Positions of the supplied shares that belong to this account's share set. */
  readonly supporting: readonly number[]
}

/**
 * The outcome of examining a pile of shares. One candidate is the normal case. More than
 * one means the pile contains complete share sets of different accounts: the caller must
 * show them and let the user choose; nothing here prefers one.
 */
export interface Codex32ShareRecovery {
  readonly candidates: readonly Codex32RecoveryCandidate[]
  readonly shares: readonly ShareVerdict[]
}

export interface BeginCodex32SignupInput {
  readonly threshold: SplitCodex32Input['threshold']
  readonly identifier: string
  readonly indices: readonly string[]
  readonly randomBytes: (length: number) => Uint8Array
}

export interface RecoverCodex32AccountInput {
  readonly descriptor?: RecoveryDescriptor
  readonly shares: readonly string[]
}

/** Start a transient signup ceremony. No default threshold, share count, or RNG is selected. */
export function beginCodex32Signup(
  input: BeginCodex32SignupInput,
): PendingCodex32Signup {
  const signup = snapshotSignupInput(input)
  const root = secureRandom(signup.randomBytes, ACCOUNT_ROOT_LENGTH)
  let master: Uint8Array | null = null
  let expectedSymbols: Uint8Array | null = null
  try {
    master = unwrap(createMasterPayload(root))
    const metadata = deriveRecoveryPublicMetadata(master)
    const shares = unwrap(
      splitCodex32({
        threshold: signup.threshold,
        identifier: signup.identifier,
        indices: signup.indices,
        secret: master,
        randomBytes: signup.randomBytes,
      }),
    )
    expectedSymbols = unwrap(codex32SecretPayloadSymbols(master))
    const descriptor = descriptorFor(signup.threshold, signup.identifier)
    let retainedSymbols: Uint8Array | null = expectedSymbols
    expectedSymbols = null
    let exportedShares: readonly string[] = Object.freeze(Array.from(shares))
    let active = true

    const consume = (): Uint8Array => {
      if (!active || retainedSymbols === null) {
        throw new AccountRecoveryError('ceremony-consumed')
      }
      active = false
      exportedShares = Object.freeze([])
      const owned = retainedSymbols
      retainedSymbols = null
      return owned
    }

    const confirm = (
      candidateShares: readonly string[],
    ): RecoveredCodex32Account => {
      if (!active || retainedSymbols === null) {
        throw new AccountRecoveryError('ceremony-consumed')
      }
      const sharesSnapshot = snapshotShares(candidateShares)
      if (!active || retainedSymbols === null) {
        throw new AccountRecoveryError('ceremony-consumed')
      }
      assertCeremonyFamily(descriptor, sharesSnapshot)
      const recovered = recoverMaster(sharesSnapshot)
      try {
        if (!equalBytes(recovered.payloadSymbols, retainedSymbols)) {
          throw new AccountRecoveryError('confirmation-mismatch')
        }
        const expected = consume()
        expected.fill(0)
        return accountFrom(recovered.secret, metadata)
      } finally {
        recovered.secret.fill(0)
        recovered.payloadSymbols.fill(0)
      }
    }

    return Object.freeze({
      descriptor,
      familyMetadata: descriptor,
      publicDescriptor: metadata.descriptor,
      get shares(): readonly string[] {
        return exportedShares
      },
      confirm(candidateShares: readonly string[]): AccountDomainRoots {
        const account = confirm(candidateShares)
        account.accountRoot.fill(0)
        return account.roots
      },
      confirmWithMetadata: confirm,
      cancel(): void {
        if (!active) return
        const expected = consume()
        expected.fill(0)
      },
    })
  } finally {
    root.fill(0)
    master?.fill(0)
    // Ownership moves into the returned ceremony. On an exception, wipe it here.
    if (expectedSymbols !== null) expectedSymbols.fill(0)
  }
}

/**
 * @deprecated Validates a master and family only; does not authenticate an expected
 * account. Normal restore must use beginCodex32Restore with independent public authority.
 */
export function recoverCodex32Account(
  input: RecoverCodex32AccountInput,
): AccountDomainRoots {
  const recovery = snapshotRecoveryInput(input)
  const descriptor =
    recovery.descriptor !== undefined
      ? snapshotDescriptor(recovery.descriptor)
      : undefined
  const shares = snapshotShares(recovery.shares)
  if (descriptor !== undefined) {
    assertCeremonyFamily(descriptor, shares)
  }
  const recovered = recoverMaster(shares)
  try {
    const account = accountFrom(recovered.secret)
    account.accountRoot.fill(0)
    return account.roots
  } finally {
    recovered.secret.fill(0)
    recovered.payloadSymbols.fill(0)
  }
}

/**
 * Direct recovery from Codex32 shares without a descriptor.
 * Reconstructs M = R || V directly from shares, validates the master payload,
 * and derives the 5 domain roots and public metadata.
 */
export function recoverCodex32Shares(
  candidateShares: readonly string[],
): RecoveredCodex32Account {
  const shares = snapshotShares(candidateShares)
  const recovered = recoverMaster(shares)
  try {
    return accountFrom(recovered.secret)
  } finally {
    recovered.secret.fill(0)
    recovered.payloadSymbols.fill(0)
  }
}

/**
 * Recover from any number of shares from the threshold up, some of which may be wrong.
 *
 * Every share is decoded on its own; shares are grouped by backup set (identifier and
 * threshold) and never mixed across sets; every threshold-sized subset of each set is tried
 * for one that reconstructs a valid Frank master; and every share is then classified against
 * what was found. To keep that exhaustive search small, one set may hold at most
 * maxSharesForThreshold(threshold) shares (`too-many-shares` otherwise). Throws an
 * AccountRecoveryError carrying the per-share findings when no account can be reconstructed.
 *
 * Without `expected`, every reconstructible account is returned and the caller must not
 * choose between several on the user's behalf. With `expected`, only the account with that
 * fingerprint is returned (`descriptor-mismatch` if none has it).
 */
export function recoverFromAnyShares(
  candidateShares: readonly string[],
  options: { readonly expected?: PublicRecoveryDescriptor } = {},
): Codex32ShareRecovery {
  if (Array.isArray(candidateShares) && candidateShares.length > 31) {
    throw new AccountRecoveryError('too-many-shares', undefined, 31)
  }
  const shares = snapshotShares(candidateShares)
  const expected =
    options.expected !== undefined
      ? snapshotPublicDescriptor(options.expected).publicRecoveryFingerprint
      : undefined
  const found = searchShares(shares)
  const candidates: Codex32RecoveryCandidate[] = []
  try {
    for (const { master, supporting } of found.masters) {
      candidates.push({ account: accountFrom(master), supporting })
    }
    if (expected === undefined) {
      const result = Object.freeze({
        candidates: Object.freeze(
          candidates.map(value => Object.freeze(value)),
        ),
        shares: found.shares,
      })
      candidates.length = 0 // ownership moved to the caller
      return result
    }
    const wanted = candidates.findIndex(candidate =>
      equalBytes(
        candidate.account.metadata.descriptor.publicRecoveryFingerprint,
        expected,
      ),
    )
    if (wanted < 0) {
      throw new AccountRecoveryError('descriptor-mismatch', found.shares)
    }
    const [chosen] = candidates.splice(wanted, 1)
    const mine = new Set((chosen as Codex32RecoveryCandidate).supporting)
    return Object.freeze({
      candidates: Object.freeze([
        Object.freeze(chosen as Codex32RecoveryCandidate),
      ]),
      // Shares of any other account in the pile are simply not part of this one.
      shares: Object.freeze(
        found.shares.map(share =>
          share.status !== 'supports'
            ? share
            : Object.freeze({
                ...share,
                status: mine.has(share.position) ? 'supports' : 'inconsistent',
                candidates: Object.freeze(mine.has(share.position) ? [0] : []),
              } as ShareVerdict),
        ),
      ),
    })
  } finally {
    for (const { master } of found.masters) master.fill(0)
    for (const candidate of candidates)
      destroyRecoveredAccount(candidate.account)
  }
}

/**
 * Pin an independently trusted decoded descriptor before accepting shares.
 * The caller owns descriptor provenance and ceremony/account binding. This API
 * checks equality with that authority; decoding a descriptor does not authenticate it.
 * If omitted, shares are recovered directly without descriptor pinning.
 */
export function beginCodex32Restore(
  value: PublicRecoveryDescriptor,
): PendingCodex32Restore<PublicRecoveryDescriptor>
export function beginCodex32Restore(
  value?: undefined,
): PendingCodex32Restore<undefined>
export function beginCodex32Restore(
  value?: PublicRecoveryDescriptor,
): PendingCodex32Restore<PublicRecoveryDescriptor | undefined>
export function beginCodex32Restore(
  value?: PublicRecoveryDescriptor,
): PendingCodex32Restore<any> {
  const descriptor =
    value !== undefined ? snapshotPublicDescriptor(value) : undefined
  const expected = descriptor?.publicRecoveryFingerprint
  let active = true
  return Object.freeze({
    descriptor,
    recover(candidateShares: readonly string[]): RecoveredCodex32Account {
      if (!active) throw new AccountRecoveryError('ceremony-consumed')
      const shares = snapshotShares(candidateShares)
      if (!active) throw new AccountRecoveryError('ceremony-consumed')
      const recovered = recoverMaster(shares)
      try {
        const metadata = masterMetadata(recovered.secret)
        if (
          expected !== undefined &&
          !equalBytes(metadata.descriptor.publicRecoveryFingerprint, expected)
        ) {
          active = false
          throw new AccountRecoveryError('descriptor-mismatch')
        }
        active = false
        return accountFrom(recovered.secret, metadata)
      } finally {
        recovered.secret.fill(0)
        recovered.payloadSymbols.fill(0)
      }
    },
    recoverAny(candidateShares: readonly string[]): Codex32ShareRecovery {
      if (!active) throw new AccountRecoveryError('ceremony-consumed')
      try {
        const recovery = recoverFromAnyShares(candidateShares, {
          expected: descriptor,
        })
        active = false
        return recovery
      } catch (error) {
        // As with recover: a wrong account for a pinned descriptor ends the ceremony.
        if ((error as AccountRecoveryError)?.code === 'descriptor-mismatch')
          active = false
        throw error
      }
    },
    cancel(): void {
      active = false
    },
  })
}

/**
 * Split the stored account root into a fresh, independent set of backup shares.
 *
 * The root is wrapped as the same master payload M = R || V that signup splits, so the
 * shares restore exactly the account signup created. Before any share is returned the
 * root must reproduce the account's recorded public fingerprint, and the new shares must
 * themselves reconstruct M. Each call draws a new random identifier, so shares from two
 * backups are told apart and refused as inconsistent instead of being combined.
 */
export function exportCodex32Backup(
  input: ExportCodex32BackupInput,
): readonly string[] {
  let threshold: SplitCodex32Input['threshold']
  let shareCount: number
  let randomBytes: (length: number) => Uint8Array
  let root: Uint8Array
  let expected: Uint8Array
  try {
    threshold = input.threshold
    shareCount = input.shareCount
    randomBytes = input.randomBytes
    expected = snapshotPublicDescriptor(
      input.expected,
    ).publicRecoveryFingerprint
    root = snapshotBytes(input.accountRoot, ACCOUNT_ROOT_LENGTH, 'bad-format')
  } catch (error) {
    if (error instanceof AccountRecoveryError) throw error
    throw new AccountRecoveryError('bad-format')
  }
  let master: Uint8Array | null = null
  try {
    if (
      !Number.isInteger(threshold) ||
      threshold < 2 ||
      threshold > 9 ||
      !Number.isInteger(shareCount) ||
      shareCount < threshold ||
      shareCount > BACKUP_SHARE_INDICES.length
    ) {
      throw new AccountRecoveryError('invalid-threshold')
    }
    master = unwrap(createMasterPayload(root))
    if (!masterMatches(master, expected)) {
      throw new AccountRecoveryError('descriptor-mismatch')
    }
    const shares = unwrap(
      splitCodex32({
        threshold,
        identifier: randomCodex32Identifier(randomBytes),
        indices: BACKUP_SHARE_INDICES.slice(0, shareCount),
        secret: master,
        randomBytes: length => secureRandom(randomBytes, length),
      }),
    )
    // Read every share back: each one, together with the threshold - 1 shares that
    // follow it (wrapping round), must reconstruct exactly the master that was split.
    for (let first = 0; first < shares.length; first += 1) {
      const subset = Array.from(
        { length: threshold },
        (_, offset) => shares[(first + offset) % shares.length] ?? '',
      )
      const check = recoverMaster(subset)
      try {
        if (!equalBytes(check.secret, master)) {
          throw new AccountRecoveryError('confirmation-mismatch')
        }
      } finally {
        check.secret.fill(0)
        check.payloadSymbols.fill(0)
      }
    }
    return Object.freeze(Array.from(shares))
  } finally {
    root.fill(0)
    master?.fill(0)
  }
}

/**
 * Whether these 32 bytes are the account root of the account `expected` describes.
 * Custody asks before storing a root for later backups; a derived root never matches.
 */
export function isAccountRootOf(
  accountRoot: Uint8Array,
  expected: PublicRecoveryDescriptor,
): boolean {
  const fingerprint =
    snapshotPublicDescriptor(expected).publicRecoveryFingerprint
  const root = snapshotBytes(accountRoot, ACCOUNT_ROOT_LENGTH, 'bad-format')
  let master: Uint8Array | null = null
  try {
    master = unwrap(createMasterPayload(root))
    return masterMatches(master, fingerprint)
  } finally {
    root.fill(0)
    master?.fill(0)
  }
}

function masterMatches(master: Uint8Array, fingerprint: Uint8Array): boolean {
  return equalBytes(
    deriveRecoveryPublicMetadata(master).descriptor.publicRecoveryFingerprint,
    fingerprint,
  )
}

/** A fresh four-character Codex32 identifier naming one split. It carries no secret. */
export function randomCodex32Identifier(
  randomBytes: (length: number) => Uint8Array,
): string {
  const bytes = secureRandom(randomBytes, 4)
  try {
    return Array.from(bytes, byte => CODEX32_ALPHABET[byte & 31]).join('')
  } finally {
    bytes.fill(0)
  }
}

/** Best-effort release of caller-owned derived material. */
export function destroyAccountDomainRoots(roots: AccountDomainRoots): void {
  for (const purpose of DOMAIN_PURPOSES) roots[purpose].bytes.fill(0)
}

/** Best-effort release of everything secret a recovery handed to its caller. */
export function destroyRecoveredAccount(
  account: RecoveredCodex32Account,
): void {
  destroyAccountDomainRoots(account.roots)
  account.accountRoot.fill(0)
}

/** Interpolate an exact threshold set; codec errors keep their own codes. */
function recoverMaster(shares: readonly string[]): RecoveredCodex32 {
  return unwrap(recoverCodex32Exact(shares))
}

/**
 * The only gate from reconstructed bytes to an account. The bytes must be Frank's master
 * payload M = R || SHA-256("frank/master-validation/v1" || 0 || R); anything else that a
 * valid share set happens to carry is refused, never turned into a new empty account.
 */
function masterMetadata(secret: Uint8Array): RecoveryPublicMetadata {
  const validated =
    secret.length === MASTER_LENGTH ? validateMasterPayload(secret) : undefined
  if (!validated?.ok) throw new AccountRecoveryError('not-account-backup')
  validated.value.fill(0)
  return deriveRecoveryPublicMetadata(secret)
}

function accountFrom(
  master: Uint8Array,
  metadata: RecoveryPublicMetadata = masterMetadata(master),
): RecoveredCodex32Account {
  const accountRoot = unwrap(validateMasterPayload(master))
  const derived: DomainRoot[] = []
  try {
    for (const purpose of DOMAIN_PURPOSES)
      derived.push(deriveDomainRoot(accountRoot, purpose))
    return Object.freeze({
      roots: Object.freeze(
        Object.fromEntries(derived.map(value => [value.purpose, value])),
      ) as AccountDomainRoots,
      metadata,
      accountRoot,
    })
  } catch (error) {
    for (const value of derived) value.bytes.fill(0)
    accountRoot.fill(0)
    throw error
  }
}

function descriptorFor(
  threshold: SplitCodex32Input['threshold'],
  identifier: string,
): RecoveryDescriptor {
  return Object.freeze({
    recoveryFormat: RECOVERY_FORMAT_ID,
    recoveryFormatCode: RECOVERY_FORMAT_CODE,
    registry: DERIVATION_REGISTRY_ID,
    registryCode: DERIVATION_REGISTRY_CODE,
    threshold,
    identifier,
  })
}

function assertDescriptor(descriptor: RecoveryDescriptor): void {
  if (
    descriptor.recoveryFormat !== RECOVERY_FORMAT_ID ||
    descriptor.recoveryFormatCode !== RECOVERY_FORMAT_CODE
  ) {
    throw new AccountRecoveryError('wrong-recovery-format')
  }
  if (
    descriptor.registry !== DERIVATION_REGISTRY_ID ||
    descriptor.registryCode !== DERIVATION_REGISTRY_CODE
  ) {
    throw new AccountRecoveryError('wrong-registry')
  }
}

function snapshotDescriptor(value: RecoveryDescriptor): RecoveryDescriptor {
  let descriptor: RecoveryDescriptor
  try {
    descriptor = {
      recoveryFormat: value.recoveryFormat,
      recoveryFormatCode: value.recoveryFormatCode,
      registry: value.registry,
      registryCode: value.registryCode,
      threshold: value.threshold,
      identifier: value.identifier,
    }
  } catch {
    throw new AccountRecoveryError('bad-format')
  }
  assertDescriptor(descriptor)
  return Object.freeze(descriptor)
}

function snapshotSignupInput(
  value: BeginCodex32SignupInput,
): BeginCodex32SignupInput {
  let threshold: SplitCodex32Input['threshold']
  let identifier: string
  let randomBytes: (length: number) => Uint8Array
  let rawIndices: readonly string[]
  try {
    threshold = value.threshold
    identifier = value.identifier
    randomBytes = value.randomBytes
    rawIndices = value.indices
  } catch {
    throw new AccountRecoveryError('bad-format')
  }
  const indices = snapshotShares(rawIndices)
  return { threshold, identifier, indices, randomBytes }
}

function snapshotRecoveryInput(
  value: RecoverCodex32AccountInput,
): RecoverCodex32AccountInput {
  try {
    return {
      descriptor: value.descriptor !== undefined ? value.descriptor : undefined,
      shares: value.shares,
    }
  } catch {
    throw new AccountRecoveryError('bad-format')
  }
}

function snapshotShares(values: readonly string[]): string[] {
  let isArray: boolean
  try {
    isArray = Array.isArray(values)
  } catch {
    throw new AccountRecoveryError('bad-format')
  }
  if (!isArray) throw new AccountRecoveryError('bad-format')
  let length: number
  try {
    length = values.length
  } catch {
    throw new AccountRecoveryError('bad-format')
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > 31) {
    throw new AccountRecoveryError('insufficient-shares')
  }
  const copied = new Array<string>(length)
  for (let index = 0; index < length; index += 1) {
    try {
      const value = values[index]
      if (typeof value !== 'string') {
        throw new AccountRecoveryError('bad-format')
      }
      copied[index] = value
    } catch {
      throw new AccountRecoveryError('bad-format')
    }
  }
  return copied
}

function assertCeremonyFamily(
  descriptor: RecoveryDescriptor,
  shares: readonly string[],
): void {
  assertDescriptor(descriptor)
  const first = unwrap(decodeCodex32(shares[0] ?? ''))
  try {
    if (
      first.threshold !== descriptor.threshold ||
      first.identifier !== descriptor.identifier
    ) {
      throw new AccountRecoveryError('wrong-ceremony-family')
    }
  } finally {
    first.payload.fill(0)
    first.seed?.fill(0)
  }
}

function secureRandom(
  randomBytes: (length: number) => Uint8Array,
  length: number,
): Uint8Array {
  if (typeof randomBytes !== 'function') {
    throw new AccountRecoveryError('rng-failed')
  }
  try {
    const supplied = randomBytes(length)
    return snapshotBytes(supplied, length, 'rng-failed')
  } catch {
    throw new AccountRecoveryError('rng-failed')
  }
}

function unwrap<T>(result: {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: Codex32ErrorCode }
}): T {
  if (result.ok && result.value !== undefined) return result.value
  throw new AccountRecoveryError(result.error?.code ?? 'bad-format')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}
