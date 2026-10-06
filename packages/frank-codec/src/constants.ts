// Version-1 constants from docs/protocol/cbor/README.md sections 1 and 4.

export const FRAME_MAGIC = new Uint8Array([0x46, 0x52, 0x4e, 0x4b]) // "FRNK"
export const FRAME_VERSION = 1
export const FRAME_HEADER_BYTES = 9

export const MAX_FRAME_BYTES = 8_388_617
export const MAX_BODY_BYTES = 8_388_608
export const MAX_DEPTH = 32
export const MAX_CONTAINERS = 16_384
export const MAX_ITEMS = 131_072
export const MAX_MAP_ENTRIES = 256
export const MAX_ARRAY_ELEMENTS = 8_192
export const MAX_BYTE_STRING_BYTES = 8_388_608
export const MAX_TEXT_STRING_BYTES = 262_144

// R2 through R4, applied at stage 8.1.
export const MAX_DIRECT_MESSAGE_FRAME_BYTES = 1_048_576
export const MAX_DIRECTORY_ATTESTATION_FRAME_BYTES = 262_144
export const MAX_MESSAGE_ITEMS_TOTAL = 256
export const MAX_MESSAGE_ITEMS_PER_ARRAY = 256
export const MAX_PAYMENT_MEMBERS = 64
export const MAX_CIPHERTEXT_BYTES = 524_288
/** Crypto-box's maximum deterministic-CBOR envelope overhead is 88 bytes. */
export const MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES = MAX_CIPHERTEXT_BYTES + 88
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

/** Assigned type identifiers (README E5). */
export const TYPE_DIRECT_MESSAGE_DELIVERY = 1
export const TYPE_DIRECTORY_ATTESTATION = 2
export const TYPE_MAILBOX_CHECKPOINT = 3
export const TYPE_DIRECTORY_STATEMENT = 4
export const TYPE_RECIPIENT_ENCRYPTED_PAYLOAD = 5
export const TYPE_ENCRYPTED_MESSAGE_CONTENT = 6
export const TYPE_KEY_TRANSITION_STATEMENT = 7
export const TYPE_MESSAGE_CONTENT_REVISION = 8
export const TYPE_TOPIC_POST = 9
export const TYPE_TOPIC_POST_SUBMISSION = 10
export const TYPE_TOPIC_VOTE_SUBMISSION = 11
export const TYPE_FORUM_VIEW = 12
export const TYPE_FORUM_TOPIC_PAGE = 13
export const TYPE_FORUM_DISCOVERY_PAGE = 14
export const TYPE_FORUM_OPERATION_STATUS = 15
export const TYPE_CONTAINER_MESSAGE_ITEM = 16
export const TYPE_TEXT_MESSAGE_ITEM = 17
export const TYPE_BLACKJACK_MESSAGE_ITEM = 18
export const MAX_BLACKJACK_FRAME_BYTES = 4096
export const TYPE_STEALTH_MESSAGE_ITEM = 19
export const MAX_STEALTH_MESSAGE_ITEM_FRAME_BYTES = 65_536
export const TYPE_CHANNEL_UPDATE = 24
export const MAX_CHANNEL_UPDATE_FRAME_BYTES = 131_072
export const MAX_CHANNEL_ALLOCATIONS = 8
export const MAX_CHANNEL_PARTICIPANTS = 16
export const MAX_CHANNEL_SIGNATURES = 4
export const MAX_CHANNEL_APP_STATE_BYTES = 65_536
export const TYPE_FORWARDING_DELIVERY_ENVELOPE = 25
export const MAX_FORWARDING_DELIVERY_FRAME_BYTES = 2_097_152
export const TYPE_PROOF_UNKNOWN_ITEM = 0xffff0001

export const ENCRYPTION_SUITE_PROOF = 65535
/** Authenticated/deniable secp256k1 + HKDF-SHA256 + XChaCha20-Poly1305. */
export const ENCRYPTION_SUITE_DM_AUTH_XCHACHA = 1
