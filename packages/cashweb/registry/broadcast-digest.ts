// One SHA-256 of BroadcastMessage protobuf bytes (decision #598).
// Matches Node createHash('sha256') and bitcore crypto.Hash.sha256.
// Not double-SHA256. cryptoBackend rejects Buffer, so the caller bytes
// are copied into a Uint8Array. parseWrapper uses registryWrapperDigest
// (decision #601). Its poster address string stays on bitcore (#242).
import { cryptoBackend } from '@frank/nakamoto'

export function registryBroadcastDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}
