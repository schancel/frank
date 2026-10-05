#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]
#![forbid(unsafe_code)]

//! Version-1 Frank-CBOR frames and the restricted canonical-CBOR profile.
//!
//! This crate is the Rust proof for the normative text in `docs/protocol/cbor/`.
//! It implements section 9 stages 1-9 plus stage 10.6: every type-2 signature entry and
//! key-transition authorization verifies as a strict-DER low-S secp256k1 ECDSA signature over
//! the frozen T2/T2a digests (algorithm 1, key type 1; M7 puts allocated-but-unverifiable
//! algorithms at `unsupported` before any verification). The separate DM validation session
//! resumes the structural required-child part of 10.1 only, matching TypeScript; it does not
//! authenticate plaintext or verify S8/T1a, T3, DLEQ, or payment observations. Ordinary `full`
//! type-1 parsing is still unsupported. The pure-value M2/M3/M6 mappings of section 11 (lossless
//! milliseconds, Keccak-256 address derivation) are in [`registration`]. Cashwebd consumes this
//! crate for explicit CBOR account registration and opt-in CBOR topics. Direct-message and mailbox
//! paths are not wired to it.
//! Provisional directory schema4/min4 is opt-in via [`preview_directory_context`].
//! [`verify_preview_directory_evidence`] verifies bounded signed evidence only; full trusted
//! directory admission requires a separately reviewed stateful runtime successor.

mod blackjack;
mod cbor;
mod crypto;
mod directory_preview;
mod dm;
mod error;
mod forum;
mod frame;
mod hash;
mod keccak;
mod limits;
mod model;
mod registration;
mod schema;
mod semantic;
mod validate;

pub use blackjack::{
    encode_blackjack_hand_item, encode_blackjack_item, is_blackjack_hand_frame,
    project_blackjack_hand_item, project_blackjack_item, BlackjackHandItem,
    BlackjackHandProjection, BlackjackItem, BlackjackProjection,
};
pub use cbor::{cbor_map, decode_canonical, encode_canonical, is_valid_canonical, CborValue};
pub use crypto::{has_low_s, parse_strict_der, verify_algorithm_1};
pub use directory_preview::{
    preview_directory_context, verify_preview_directory_evidence, PreviewDirectoryEvidence,
};
pub use dm::{
    encode_direct_message_crypto_context, DirectMessageCryptoContext, DM_CRYPTO_CONTEXT_DOMAIN,
    DM_CRYPTO_MIN_READER_VERSION, DM_CRYPTO_SCHEMA_VERSION, DM_CRYPTO_SUITE, DM_CRYPTO_TYPE,
};
pub use error::{CborPass, CodecError, ContextError, Error, ErrorCategory, ErrorStage, UsageError};
pub use forum::{
    decode_forum_cursor, encode_forum_cursor, encode_forum_post, encode_forum_read_frame,
    forum_cursor_from_transport, forum_cursor_to_transport, match_forum_operation,
    ForumOperationExpectation,
};
pub use frame::{encode_frame, wrap_frame, EnvelopeFields, FramePayload};
pub use hash::{
    common_transcript, content_hash, content_hash_network, directory_signature_digest,
    key_transition_signature_digest, message_content_digest, payment_commitment,
    recipient_payload_digest, topic_vote_commitment,
};
pub use keccak::keccak256;
pub use limits::{
    FRAME_HEADER_BYTES, FRAME_MAGIC, FRAME_VERSION, KNOWN_TYPES, MAX_ARRAY_ELEMENTS,
    MAX_BODY_BYTES, MAX_BYTE_STRING_BYTES, MAX_CONTAINERS, MAX_DEPTH, MAX_FRAME_BYTES, MAX_ITEMS,
    MAX_MAP_ENTRIES, MAX_TEXT_STRING_BYTES,
};
pub use model::{
    AccountRef, ChildFrame, FrameOnly, JournalFact, KeyTransition, OpaqueSection, ParsedFrame,
    PaymentMember, PreviewDirectoryRoles, ProfileEntry, ProfileHeader, Projection, RelayBinding,
    RetainedFrame, RetentionReason, SignatureEntry, Timestamp, TypedPayload, ValidationResult,
};
pub use model::{BlackjackAction, BlackjackFields, BlackjackMessageItem, BlackjackOutcome};
pub use model::{BlackjackHandAction, BlackjackHandFields, BlackjackHandMessageItem};
pub use model::{
    ForumAggregate, ForumContent, ForumCursor, ForumCursorPosition, ForumDiscoveryEntry,
    ForumDiscoveryPage, ForumEntry, ForumOperationEvidence, ForumOperationStatus, ForumPostContent,
    ForumTopicPage, ForumView,
};
pub use registration::{
    address_from_compressed_pubkey, address_from_uncompressed_pubkey, expiry_timestamp, join_ms,
    registration_from_ms, split_timestamp_ms, uncompressed_pubkey, uncompressed_pubkey_xy,
};
pub use validate::{
    begin_direct_message_validation, default_context, relay_context, validate_frame,
    DirectMessageValidatedContent, DirectMessageValidationSession, Operation, PriorStatement,
    SupportedSchema, ValidationContext,
};

/// Alias of [`validate_frame`].
pub fn parse_frame(bytes: &[u8], ctx: &ValidationContext) -> Result<ValidationResult, Error> {
    validate_frame(bytes, ctx)
}
