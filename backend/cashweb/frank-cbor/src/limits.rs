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
/// Payment members in one delivery.
pub(crate) const MAX_PAYMENT_MEMBERS: usize = 64;
/// Ciphertext bytes in one recipient payload.
pub(crate) const MAX_CIPHERTEXT_BYTES: usize = 524_288;
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
pub(crate) const TYPE_CONTAINER_ITEM: u32 = 16;
pub(crate) const TYPE_TEXT_ITEM: u32 = 17;

/// Types with a version-1 schema in this codec (E5). `0xffff0001` is not included.
pub const KNOWN_TYPES: [u32; 10] = [
    TYPE_DIRECT_MESSAGE,
    TYPE_DIRECTORY_ATTESTATION,
    TYPE_MAILBOX_CHECKPOINT,
    TYPE_DIRECTORY_STATEMENT,
    TYPE_RECIPIENT_PAYLOAD,
    TYPE_ENCRYPTED_CONTENT,
    TYPE_KEY_TRANSITION_STATEMENT,
    TYPE_MESSAGE_REVISION,
    TYPE_CONTAINER_ITEM,
    TYPE_TEXT_ITEM,
];

/// Proof-only encryption suite (S2c). Production suites are unallocated.
pub(crate) const ENCRYPTION_SUITE_PROOF: u32 = 65_535;

pub(crate) fn is_known_type(type_id: u32) -> bool {
    KNOWN_TYPES.contains(&type_id)
}
