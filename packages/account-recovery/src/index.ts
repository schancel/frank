import {
  codex32SecretPayloadSymbols,
  createMasterPayload,
  decodeCodex32,
  recoverCodex32Exact,
  splitCodex32,
  validateMasterPayload,
  type Codex32ErrorCode,
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
import { AccountRecoveryError } from './errors.js'
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
  cancel(): void
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
      const recovered = unwrap(recoverCodex32Exact(sharesSnapshot))
      try {
        if (!equalBytes(recovered.payloadSymbols, retainedSymbols)) {
          throw new AccountRecoveryError('confirmation-mismatch')
        }
        const expected = consume()
        expected.fill(0)
        return Object.freeze({
          roots: deriveValidatedRoots(recovered.secret),
          metadata,
        })
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
        return confirm(candidateShares).roots
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
  const recovered = unwrap(recoverCodex32Exact(shares))
  try {
    return deriveValidatedRoots(recovered.secret)
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
  const recovered = unwrap(recoverCodex32Exact(shares))
  try {
    const metadata = deriveRecoveryPublicMetadata(recovered.secret)
    return Object.freeze({
      roots: deriveValidatedRoots(recovered.secret),
      metadata,
    })
  } finally {
    recovered.secret.fill(0)
    recovered.payloadSymbols.fill(0)
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
      const recovered = unwrap(recoverCodex32Exact(shares))
      try {
        // Master validation happens inside metadata derivation before fingerprinting.
        const metadata = deriveRecoveryPublicMetadata(recovered.secret)
        if (
          expected !== undefined &&
          !equalBytes(metadata.descriptor.publicRecoveryFingerprint, expected)
        ) {
          active = false
          throw new AccountRecoveryError('descriptor-mismatch')
        }
        active = false
        return Object.freeze({
          roots: deriveValidatedRoots(recovered.secret),
          metadata,
        })
      } finally {
        recovered.secret.fill(0)
        recovered.payloadSymbols.fill(0)
      }
    },
    cancel(): void {
      active = false
    },
  })
}

/** Best-effort release of caller-owned derived material. */
export function destroyAccountDomainRoots(roots: AccountDomainRoots): void {
  for (const purpose of DOMAIN_PURPOSES) roots[purpose].bytes.fill(0)
}

function deriveValidatedRoots(master: Uint8Array): AccountDomainRoots {
  const root = unwrap(validateMasterPayload(master))
  const derived: DomainRoot[] = []
  try {
    for (const purpose of DOMAIN_PURPOSES)
      derived.push(deriveDomainRoot(root, purpose))
    return Object.freeze(
      Object.fromEntries(derived.map(value => [value.purpose, value])),
    ) as AccountDomainRoots
  } catch (error) {
    for (const value of derived) value.bytes.fill(0)
    throw error
  } finally {
    root.fill(0)
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
      descriptor:
        value.descriptor !== undefined ? value.descriptor : undefined,
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
