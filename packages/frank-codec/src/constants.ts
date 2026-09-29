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
export const TYPE_CONTAINER_MESSAGE_ITEM = 16
export const TYPE_TEXT_MESSAGE_ITEM = 17
export const TYPE_PROOF_UNKNOWN_ITEM = 0xffff0001

export const ENCRYPTION_SUITE_PROOF = 65535
