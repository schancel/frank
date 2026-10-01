import { cryptoBackend } from '@frank/nakamoto'

/** One SHA-256 of relay `Message.payload` bytes. Matches the `payload_digest`
 * comment in `packages/cashweb/relay/proto/relay.proto` and stamp type
 * `MessageCommitment` (`d + SHA-256(payload)`). Not double-SHA256.
 * cryptoBackend rejects Buffer. The plaintext digest that feeds the salt
 * HMAC, the HMAC itself, salt, and envelope ECDH stay on bitcore
 * (decision #509, issue #258). Broadcast message digests stay on bitcore. */
export function relayCipherPayloadDigest(payload: Uint8Array): Uint8Array {
  return cryptoBackend.sha256(Uint8Array.from(payload))
}
