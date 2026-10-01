// Synchronous hash and secp256k1 seam. Callers pass Uint8Array and get
// Uint8Array back. WebCrypto is not part of this interface.

export const BACKEND_CODES = [
  'bad-length',
  'scalar-out-of-range',
  'point-invalid',
  'point-at-infinity',
  'high-s',
  'signature-invalid',
] as const

export type BackendCode = (typeof BACKEND_CODES)[number]

export class CryptoBackendError extends Error {
  readonly code: BackendCode
  readonly actual?: number

  constructor(code: BackendCode, actual?: number) {
    super(code)
    this.name = 'CryptoBackendError'
    this.code = code
    this.actual = actual
  }
}

export interface CryptoBackend {
  readonly name: string
  sha256(input: Uint8Array): Uint8Array
  sha256d(input: Uint8Array): Uint8Array
  ripemd160(input: Uint8Array): Uint8Array
  hash160(input: Uint8Array): Uint8Array
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array
  /** DER encoding of an RFC 6979 low-S signature. `digest` is 32 bytes. */
  signEcdsa(secret: Uint8Array, digest: Uint8Array): Uint8Array
  /**
   * True when the signature matches. High-S is an error, not `false`.
   * Accepts DER or 64-byte compact `r || s`.
   */
  verifyEcdsa(
    signature: Uint8Array,
    digest: Uint8Array,
    publicKey: Uint8Array,
  ): boolean
  /** 64-byte BIP340 signature. `aux` is 32 bytes and is not optional. */
  signSchnorr(
    secret: Uint8Array,
    message: Uint8Array,
    aux: Uint8Array,
  ): Uint8Array
  verifySchnorr(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ): boolean
  /** Compressed SEC1 shared point. No hash is applied. */
  ecdh(secret: Uint8Array, publicKey: Uint8Array): Uint8Array
  /** Compressed SEC1 sum. Infinity is an error. */
  pointAdd(left: Uint8Array, right: Uint8Array): Uint8Array
  /** Compressed SEC1 product. The scalar is in [1, n). */
  pointMultiply(publicPoint: Uint8Array, scalar: Uint8Array): Uint8Array
}
