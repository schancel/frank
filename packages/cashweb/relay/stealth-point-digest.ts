import { cryptoBackend } from '@frank/nakamoto'

/** One SHA-256 of a compressed ECDH point. This is H(ebG) in
 * `PayloadConstructor` stealth key derivation. Matches
 * `sha2::Sha256::digest` in bitcoinsuite, bitcore `crypto.Hash.sha256`,
 * and Node `crypto.createHash('sha256')`. Not double-SHA256.
 * cryptoBackend rejects Buffer. Point multiplication, HMAC, salt, the
 * plaintext digest, and envelope ECDH stay on bitcore (decision #511,
 * issue #258). */
export function stealthPointDigest(compressedPoint: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(compressedPoint))
}
