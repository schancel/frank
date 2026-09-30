/**
 * Relay request-size limits shared by the envelope builder and by clients that vet untrusted
 * content (no imports, so it is safe to load anywhere, including browser tests).
 */
export const MAX_RELAY_BODY_BYTES = 2 * 1024 * 1024;
const MIN_RELAY_FRAMING_HEADROOM_BYTES = 128 * 1024;
const MAX_ENVELOPE_JSON_OVERHEAD_BYTES = 1024;
/**
 * Exact v2 plaintext/ciphertext bound. Hex encoding doubles ciphertext size; reserving 1 KiB for
 * the JSON fields and 128 KiB for protobuf/hash/payment framing ensures every builder output fits
 * the relay's 2 MiB request cap with useful framing headroom.
 */
export const MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES = Math.floor(
  (MAX_RELAY_BODY_BYTES -
    MIN_RELAY_FRAMING_HEADROOM_BYTES -
    MAX_ENVELOPE_JSON_OVERHEAD_BYTES) /
    2
);
