// One SHA-256 of SignedPayload payload bytes (decision #601).
// Matches Node createHash('sha256') and bitcore crypto.Hash.sha256.
// Not double-SHA256. cryptoBackend rejects Buffer, so the caller bytes
// are copied into a Uint8Array. The poster address string in parseWrapper
// stays on bitcore (issue #242).
import { cryptoBackend } from '@frank/nakamoto'

export function registryWrapperDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}
