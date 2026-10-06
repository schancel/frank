//! Version-1 limits and assigned identifiers (README sections 1, 2, and 4).

/// ASCII `FRNK`.
pub const FRAME_MAGIC: [u8; 4] = [0x46, 0x52, 0x4e, 0x4b];
/// Nine-byte header: magic, version, big-endian body length.
pub const FRAME_HEADER_BYTES: usize = 9;
/// The only frame version this reader interprets.
pub const FRAME_VERSION: u8 = 1;

/// Complete frame, including the nine-byte header.
pub const MAX_FRAME_BYTES: usize = 8_388_617;
/// Envelope CBOR body.
pub const MAX_BODY_BYTES: usize = 8_388_608;
/// Nested arrays and maps, including the envelope and the payload.
pub const MAX_DEPTH: u32 = 32;
/// Arrays plus maps in one validation operation.
pub const MAX_CONTAINERS: u32 = 16_384;
/// Scalars plus containers, including every map key.
pub const MAX_ITEMS: u32 = 131_072;
/// Entries in any one map.
pub const MAX_MAP_ENTRIES: usize = 256;
/// Elements in any one array.
pub const MAX_ARRAY_ELEMENTS: usize = 8_192;
/// Any byte string before a type-specific limit.
pub const MAX_BYTE_STRING_BYTES: usize = 8_388_608;
/// Any UTF-8 text string.
pub const MAX_TEXT_STRING_BYTES: usize = 262_144;

/// R2 direct-message frame limit.
pub(crate) const MAX_DIRECT_MESSAGE_FRAME_BYTES: usize = 1_048_576;
/// R3 directory-attestation frame limit.
pub(crate) const MAX_DIRECTORY_ATTESTATION_FRAME_BYTES: usize = 262_144;
/// R2 message items across one opened item graph.
pub(crate) const MAX_MESSAGE_ITEMS_TOTAL: u32 = 256;
/// Message items in one array.
pub(crate) const MAX_MESSAGE_ITEMS_PER_ARRAY: usize = 256;
/// R6 topic post and post-submission frame limit.
pub(crate) const MAX_TOPIC_FRAME_BYTES: usize = 1_048_576;
/// R6 topic vote-submission frame limit.
pub(crate) const MAX_TOPIC_VOTE_FRAME_BYTES: usize = 65_536;
/// R6 topic post body.
pub(crate) const MAX_TOPIC_BODY_BYTES: usize = 524_288;
pub(crate) const MAX_FORUM_VIEW_BYTES: usize = 2_097_152;
pub(crate) const MAX_FORUM_PAGE_BYTES: usize = 4_194_304;
pub(crate) const MAX_FORUM_ROWS: usize = 128;
pub(crate) const MAX_FORUM_ENTRIES: usize = 64;
pub(crate) const MAX_FORUM_CURSOR_BYTES: usize = 2048;
/// Payment members in one delivery.
pub(crate) const MAX_PAYMENT_MEMBERS: usize = 64;
/// Ciphertext bytes in one recipient payload.
pub(crate) const MAX_CIPHERTEXT_BYTES: usize = 524_288;
/// Complete deterministic-CBOR crypto-box envelope, including bounded overhead.
pub(crate) const MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES: usize = MAX_CIPHERTEXT_BYTES + 88;
/// Relay bindings in one statement.
pub(crate) const MAX_RELAY_BINDINGS: usize = 32;
/// Signature entries in one attestation.
pub(crate) const MAX_SIGNATURES: usize = 16;
/// Journal facts in one checkpoint.
pub(crate) const MAX_JOURNAL_FACTS: usize = 4_096;
/// Opaque sections in one checkpoint.
pub(crate) const MAX_OPAQUE_SECTIONS: usize = 4_096;

/// Inclusive CBOR uint maximum (`2^64 - 1`).
pub(crate) const U64_MAX: i128 = u64::MAX as i128;
/// Inclusive CBOR nint minimum (`-2^64`).
pub(crate) const NINT_MIN: i128 = -1 - U64_MAX;

pub(crate) const TYPE_DIRECT_MESSAGE: u32 = 1;
pub(crate) const TYPE_DIRECTORY_ATTESTATION: u32 = 2;
pub(crate) const TYPE_MAILBOX_CHECKPOINT: u32 = 3;
pub(crate) const TYPE_DIRECTORY_STATEMENT: u32 = 4;
pub(crate) const TYPE_RECIPIENT_PAYLOAD: u32 = 5;
pub(crate) const TYPE_ENCRYPTED_CONTENT: u32 = 6;
pub(crate) const TYPE_KEY_TRANSITION_STATEMENT: u32 = 7;
pub(crate) const TYPE_MESSAGE_REVISION: u32 = 8;
pub(crate) const TYPE_TOPIC_POST: u32 = 9;
pub(crate) const TYPE_TOPIC_POST_SUBMISSION: u32 = 10;
pub(crate) const TYPE_TOPIC_VOTE_SUBMISSION: u32 = 11;
pub(crate) const TYPE_FORUM_VIEW: u32 = 12;
pub(crate) const TYPE_FORUM_TOPIC_PAGE: u32 = 13;
pub(crate) const TYPE_FORUM_DISCOVERY_PAGE: u32 = 14;
pub(crate) const TYPE_FORUM_OPERATION_STATUS: u32 = 15;
pub(crate) const TYPE_CONTAINER_ITEM: u32 = 16;
pub(crate) const TYPE_TEXT_ITEM: u32 = 17;
/// Type18 frame limit at both root and nested positions.
pub(crate) const MAX_BLACKJACK_FRAME_BYTES: usize = 4096;
pub(crate) const TYPE_BLACKJACK_ITEM: u32 = 18;
/// Type 25 forwarding envelope frame limit (32 MiB).
pub const MAX_FORWARDING_DELIVERY_FRAME_BYTES: usize = 33_554_432;
/// Type 25: outer relay forwarding delivery envelope.
pub const TYPE_FORWARDING_DELIVERY: u32 = 25;

/// Types with a version-1 schema in this codec (E5). `0xffff0001` is not included.
pub const KNOWN_TYPES: [u32; 19] = [
    TYPE_DIRECT_MESSAGE,
    TYPE_DIRECTORY_ATTESTATION,
    TYPE_MAILBOX_CHECKPOINT,
    TYPE_DIRECTORY_STATEMENT,
    TYPE_RECIPIENT_PAYLOAD,
    TYPE_ENCRYPTED_CONTENT,
    TYPE_KEY_TRANSITION_STATEMENT,
    TYPE_MESSAGE_REVISION,
    TYPE_TOPIC_POST,
    TYPE_TOPIC_POST_SUBMISSION,
    TYPE_TOPIC_VOTE_SUBMISSION,
    TYPE_FORUM_VIEW,
    TYPE_FORUM_TOPIC_PAGE,
    TYPE_FORUM_DISCOVERY_PAGE,
    TYPE_FORUM_OPERATION_STATUS,
    TYPE_CONTAINER_ITEM,
    TYPE_TEXT_ITEM,
    TYPE_BLACKJACK_ITEM,
    TYPE_FORWARDING_DELIVERY,
];

/// Frank-CBOR production DM suite (S2c): authenticated XChaCha20-Poly1305.
pub(crate) const ENCRYPTION_SUITE_DM_AUTH_XCHACHA: u32 = 1;
/// Proof-only encryption suite (S2c).
pub(crate) const ENCRYPTION_SUITE_PROOF: u32 = 65_535;

pub(crate) fn is_known_type(type_id: u32) -> bool {
    KNOWN_TYPES.contains(&type_id)
}
