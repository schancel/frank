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

const ACCOUNT_ROOT_LENGTH = 32

export type AccountRecoveryErrorCode =
  | Codex32ErrorCode
  | 'ceremony-consumed'
  | 'confirmation-mismatch'
  | 'wrong-recovery-format'
  | 'wrong-registry'
  | 'wrong-ceremony-family'

export class AccountRecoveryError extends Error {
  readonly code: AccountRecoveryErrorCode

  constructor(code: AccountRecoveryErrorCode) {
    super(`Frank account recovery failed: ${code}`)
    this.name = 'AccountRecoveryError'
    this.code = code
  }
}

export interface RecoveryDescriptor {
  readonly recoveryFormat: typeof RECOVERY_FORMAT_ID
  readonly recoveryFormatCode: typeof RECOVERY_FORMAT_CODE
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly registryCode: typeof DERIVATION_REGISTRY_CODE
  readonly threshold: SplitCodex32Input['threshold']
  readonly identifier: string
}

export type AccountDomainRoots = {
  readonly [Purpose in DomainPurpose]: DomainRoot<Purpose>
}

export interface PendingCodex32Signup {
  /** Public ceremony metadata. This is not an authenticated recovery descriptor. */
  readonly descriptor: RecoveryDescriptor
  /** Caller-owned immutable strings. The service does not retain this array. */
  readonly shares: readonly string[]
  confirm(shares: readonly string[]): AccountDomainRoots
  cancel(): void
}

export interface BeginCodex32SignupInput {
  readonly threshold: SplitCodex32Input['threshold']
  readonly identifier: string
  readonly indices: readonly string[]
  readonly randomBytes: (length: number) => Uint8Array
}

export interface RecoverCodex32AccountInput {
  readonly descriptor: RecoveryDescriptor
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

    return Object.freeze({
      descriptor,
      get shares(): readonly string[] {
        return exportedShares
      },
      confirm(candidateShares: readonly string[]): AccountDomainRoots {
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
          return deriveValidatedRoots(recovered.secret)
        } finally {
          recovered.secret.fill(0)
          recovered.payloadSymbols.fill(0)
        }
      },
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

/** Recover and validate a Frank master before deriving any resident domain material. */
export function recoverCodex32Account(
  input: RecoverCodex32AccountInput,
): AccountDomainRoots {
  const recovery = snapshotRecoveryInput(input)
  const descriptor = snapshotDescriptor(recovery.descriptor)
  const shares = snapshotShares(recovery.shares)
  assertCeremonyFamily(descriptor, shares)
  const recovered = unwrap(recoverCodex32Exact(shares))
  try {
    return deriveValidatedRoots(recovered.secret)
  } finally {
    recovered.secret.fill(0)
    recovered.payloadSymbols.fill(0)
  }
}

/** Best-effort release of caller-owned derived material. */
export function destroyAccountDomainRoots(roots: AccountDomainRoots): void {
  for (const purpose of DOMAIN_PURPOSES) roots[purpose].bytes.fill(0)
}

function deriveValidatedRoots(master: Uint8Array): AccountDomainRoots {
  const root = unwrap(validateMasterPayload(master))
  try {
    return Object.freeze(
      Object.fromEntries(
        DOMAIN_PURPOSES.map(purpose => [
          purpose,
          deriveDomainRoot(root, purpose),
        ]),
      ),
    ) as AccountDomainRoots
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
    return { descriptor: value.descriptor, shares: value.shares }
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
    if (!(supplied instanceof Uint8Array) || supplied.length !== length) {
      throw new AccountRecoveryError('rng-failed')
    }
    return new Uint8Array(supplied)
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
