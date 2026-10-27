// Version-1 constants from docs/protocol/cbor/README.md sections 1 and 4.

export const FRAME_MAGIC = new Uint8Array([0x46, 0x52, 0x4e, 0x4b]) // "FRNK"
export const FRAME_VERSION = 1
export const FRAME_HEADER_BYTES = 9

/** The stage-1 ceiling (10 MiB body + 9). Only a direct message (types 10 and 11, R2) may be this
 * large; every other known type is bounded at stage 8.1 by its own limit or by
 * MAX_GENERAL_FRAME_BYTES. */
export const MAX_FRAME_BYTES = 10_485_769
export const MAX_BODY_BYTES = 10_485_760
/** Root frame of a known type with no limit of its own, and a decrypted type-12 frame (8 MiB body
 * + 9). Unchanged when the direct-message limit was raised. */
export const MAX_GENERAL_FRAME_BYTES = 8_388_617
export const MAX_DEPTH = 32
export const MAX_CONTAINERS = 16_384
export const MAX_ITEMS = 131_072
export const MAX_MAP_ENTRIES = 256
export const MAX_ARRAY_ELEMENTS = 8_192
export const MAX_BYTE_STRING_BYTES = 10_485_760
export const MAX_TEXT_STRING_BYTES = 262_144

// R2 through R4, applied at stage 8.1.
/** R2 (10 MiB): a type-10 delivery and its type-11 payload. It holds the largest crypto-box
 * envelope (8 MiB + 88) and leaves 2 MiB for the type-11 fields and up to 64 payment members at
 * their CDDL maxima (about 17 KB each). */
export const MAX_DIRECT_MESSAGE_FRAME_BYTES = 10_485_760
export const MAX_DIRECTORY_ATTESTATION_FRAME_BYTES = 262_144
export const MAX_MESSAGE_ITEMS_TOTAL = 256
export const MAX_MESSAGE_ITEMS_PER_ARRAY = 256
export const MAX_PAYMENT_MEMBERS = 64
/** Most burn transactions one topic post or vote may carry (types 41 and 42). */
export const MAX_TOPIC_BURNS = 16
/** Crypto-box ciphertext in one direct message's type-11 schema-2 payload (8 MiB). */
export const MAX_DM_CIPHERTEXT_BYTES = 8_388_608
/** Crypto-box's maximum deterministic-CBOR envelope overhead is 88 bytes. */
export const MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES = MAX_DM_CIPHERTEXT_BYTES + 88
/** Ciphertext of a type-11 schema-1 payload, kept only for the reserved proof fixture. */
export const MAX_V1_CIPHERTEXT_BYTES = 524_288
// R6: topic events.
export const MAX_TOPIC_FRAME_BYTES = 1_048_576
export const MAX_TOPIC_VOTE_FRAME_BYTES = 65_536
export const MAX_TOPIC_BODY_BYTES = 524_288
export const MAX_FORUM_VIEW_BYTES = 2_097_152
export const MAX_FORUM_PAGE_BYTES = 4_194_304
export const MAX_FORUM_ROWS = 128
export const MAX_FORUM_ENTRIES = 64
export const MAX_FORUM_CURSOR_BYTES = 2_048
export const MAX_FORUM_CURSOR_TRANSPORT = 2_731
/** Longest signed validity of one directory entry: 366 days, in nanoseconds. */
export const MAX_DIRECTORY_VALIDITY_NS = 31_622_400_000_000_000n
export const MAX_RELAY_BINDINGS = 32
export const MAX_SIGNATURES = 16
export const MAX_JOURNAL_FACTS = 4_096
export const MAX_OPAQUE_SECTIONS = 4_096

export const U32_MAX = 4_294_967_295
export const U64_MAX = 18_446_744_073_709_551_615n
export const I64_MIN = -9_223_372_036_854_775_808n
export const I64_MAX = 9_223_372_036_854_775_807n

/** Assigned type identifiers (README E5), generated from docs/protocol/message-types/v1.json. */
export * from './message-types.generated'
/** Map field keys and enumerated values, generated from docs/protocol/message-types/fields/. */
export * from './message-fields.generated'
import { ENCRYPTION_SUITE } from './message-fields.generated'

export const MAX_BLACKJACK_FRAME_BYTES = 4096
export const MAX_STEALTH_MESSAGE_ITEM_FRAME_BYTES = 65_536
export const MAX_CHANNEL_UPDATE_FRAME_BYTES = 131_072
export const MAX_CHANNEL_ALLOCATIONS = 8
export const MAX_CHANNEL_PARTICIPANTS = 16
export const MAX_CHANNEL_SIGNATURES = 4
export const MAX_CHANNEL_APP_STATE_BYTES = 65_536
export const MAX_FORWARDING_DELIVERY_FRAME_BYTES = 33_554_432
export const MAX_EMAIL_MESSAGE_ITEM_FRAME_BYTES = 1_048_576
export const MAX_EMAIL_RECIPIENTS = 64
export const MAX_EMAIL_ATTACHMENTS = 16
/** UTF-8 bytes of a plugin item type identifier (the identifier is ASCII). */
export const MAX_PLUGIN_ITEM_TYPE_BYTES = 64
/** A plugin's bytes in one type-27 item (512 KiB). Its own limit: raising the direct-message
 * limit did not raise it. */
export const MAX_PLUGIN_ITEM_PAYLOAD_BYTES = 524_288

/** Reserved for schema-1 opaque proof-vector ciphertext (S2c). */
export const ENCRYPTION_SUITE_PROOF = ENCRYPTION_SUITE.proof
/** Authenticated/deniable secp256k1 + HKDF-SHA256 + XChaCha20-Poly1305. */
export const ENCRYPTION_SUITE_DM_AUTH_XCHACHA = ENCRYPTION_SUITE.dmAuthXchacha
