// Identifiers for the crypto-box registry. Frank CBOR version 1 allocates no
// production encryption suite. 65535 stays reserved. Decision 356.

/** RFC 9180 private-use KEM. Not a registered code point. */
export const KEM_SECP256K1 = 0xff00

export const KEM_NAME = 'DHKEM(secp256k1, HKDF-SHA256)'

/** Registered HPKE KDF id for HKDF-SHA256. */
export const KDF_HKDF_SHA256 = 0x0001

/** Registered HPKE AEAD id for AES-256-GCM. */
export const AEAD_AES_256_GCM = 0x0002

/**
 * Private-use HPKE AEAD id for XChaCha20-Poly1305.
 * Not a registered AEAD id. Named here: `XChaCha20-Poly1305`.
 */
export const AEAD_XCHACHA20_POLY1305 = 0xff01

export const MODE_BASE = 0x00
export const MODE_AUTH = 0x02

/** Reserved for proof vectors. Never emitted as a produced suite. */
export const RESERVED_PROOF_SUITE_ID = 65535

/** Library registry. Not a CBOR version-1 suite id. Waiting on the spec. */
export const SUITE_BASE_AES_GCM = 0xfe01
export const SUITE_BASE_XCHACHA = 0xfe02
export const SUITE_AUTH_AES_GCM = 0xfe03
export const SUITE_AUTH_XCHACHA = 0xfe04

export const SALT_LENGTH = 32
export const ENC_LENGTH = 33
export const ENVELOPE_VERSION = 1
export const MAX_MESSAGE = 1_048_576
export const MAX_PADDING = 65535

export type AeadName = 'aes-256-gcm' | 'xchacha20-poly1305'

export interface SuiteSpec {
  readonly id: number
  readonly name: string
  readonly mode: number
  readonly aeadId: number
  readonly aead: AeadName
  readonly nonceLength: number
  /** Frank CBOR version 1 has not allocated this id. */
  readonly cborVersion1: 'waiting'
}

function spec(
  id: number,
  name: string,
  mode: number,
  aeadId: number,
  aead: AeadName,
  nonceLength: number,
): SuiteSpec {
  return Object.freeze({
    id,
    name,
    mode,
    aeadId,
    aead,
    nonceLength,
    cborVersion1: 'waiting',
  })
}

export const SUITES: readonly SuiteSpec[] = Object.freeze([
  spec(
    SUITE_BASE_AES_GCM,
    'base-aes-256-gcm',
    MODE_BASE,
    AEAD_AES_256_GCM,
    'aes-256-gcm',
    12,
  ),
  spec(
    SUITE_BASE_XCHACHA,
    'base-xchacha20-poly1305',
    MODE_BASE,
    AEAD_XCHACHA20_POLY1305,
    'xchacha20-poly1305',
    24,
  ),
  spec(
    SUITE_AUTH_AES_GCM,
    'auth-aes-256-gcm',
    MODE_AUTH,
    AEAD_AES_256_GCM,
    'aes-256-gcm',
    12,
  ),
  spec(
    SUITE_AUTH_XCHACHA,
    'auth-xchacha20-poly1305',
    MODE_AUTH,
    AEAD_XCHACHA20_POLY1305,
    'xchacha20-poly1305',
    24,
  ),
])

export const producedSuiteIds: readonly number[] = Object.freeze(
  SUITES.map(suite => suite.id),
)

export function suiteById(suiteId: number): SuiteSpec | undefined {
  return SUITES.find(suite => suite.id === suiteId)
}
