// One SHA-256 of relay plaintext before the salt HMAC (decision #602).
// Matches Node createHash('sha256') and bitcore crypto.Hash.sha256.
// Not double-SHA256. cryptoBackend rejects Buffer, so the caller bytes
// are copied into a Uint8Array. The HMAC stays on bitcore.
import { cryptoBackend } from '@frank/nakamoto'

export function relayPlainPayloadDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}
