// @frank/crypto-box public surface. Browser-safe: no Node built-ins.
// Suite 65535 is reserved and is never produced. Registry ids are not
// Frank CBOR version-1 production suites (decision 356).

import { producedSuiteIds, RESERVED_PROOF_SUITE_ID } from './ids.js'

export {
  AEAD_AES_256_GCM,
  AEAD_XCHACHA20_POLY1305,
  KDF_HKDF_SHA256,
  KEM_NAME,
  KEM_SECP256K1,
  MODE_AUTH,
  MODE_BASE,
  producedSuiteIds,
  RESERVED_PROOF_SUITE_ID,
  SUITE_AUTH_AES_GCM,
  SUITE_AUTH_XCHACHA,
  SUITE_BASE_AES_GCM,
  SUITE_BASE_XCHACHA,
  SUITES,
} from './ids.js'
export { isSuiteError } from './result.js'
export { hmacSha256, randomBytes, sha256 } from './primitives.js'
export { open, seal } from './seal.js'
export type { OpenArgs, SealArgs } from './seal.js'
export type { SuiteFailure, SuiteResult } from './result.js'
export type { SuiteSpec } from './ids.js'

export class ReservedSuiteError extends Error {
  readonly code = 'reserved-suite' as const
  readonly suiteId: number

  constructor(suiteId: number) {
    super('suite 65535 is reserved for proof vectors and is never produced')
    this.name = 'ReservedSuiteError'
    this.suiteId = suiteId
  }
}

export function isProducedSuite(suiteId: number): boolean {
  if (suiteId === RESERVED_PROOF_SUITE_ID) return false
  return producedSuiteIds.includes(suiteId)
}

/** Throws when a caller asks the library to emit the reserved proof suite. */
export function refuseReservedSuite(suiteId: number): void {
  if (suiteId === RESERVED_PROOF_SUITE_ID) {
    throw new ReservedSuiteError(suiteId)
  }
}

/**
 * Structural check. A second copy of this package does not share the class,
 * and callers branch on `code` plus `suiteId`.
 */
export function isReservedSuiteError(
  value: unknown,
): value is { readonly code: 'reserved-suite'; readonly suiteId: number } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { code?: unknown; suiteId?: unknown }
  return record.code === 'reserved-suite' && typeof record.suiteId === 'number'
}
