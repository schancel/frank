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
//! algorithms at `unsupported` before any verification). Stages 10.1-10.5 (the type-1 stamp
//! checks: decrypted frame, T3, DLEQ, payment observations) are out of scope, matching the
//! TypeScript reference codec. The pure-value M2/M3/M6 mappings of section 11 (lossless
//! milliseconds, Keccak-256 address derivation) are in [`registration`]. Cashwebd consumes this
//! crate for explicit CBOR account registration and opt-in CBOR topics. Direct-message and mailbox
//! paths are not wired to it.

mod cbor;
mod crypto;
mod dm;
mod error;
mod frame;
mod hash;
mod keccak;
mod limits;
mod model;
mod registration;
mod schema;
mod semantic;
mod validate;

pub use cbor::{cbor_map, decode_canonical, encode_canonical, is_valid_canonical, CborValue};
pub use crypto::{has_low_s, parse_strict_der, verify_algorithm_1};
pub use dm::{
    encode_direct_message_crypto_context, DirectMessageCryptoContext, DM_CRYPTO_CONTEXT_DOMAIN,
    DM_CRYPTO_MIN_READER_VERSION, DM_CRYPTO_SCHEMA_VERSION, DM_CRYPTO_SUITE, DM_CRYPTO_TYPE,
};
pub use error::{CborPass, CodecError, ContextError, Error, ErrorCategory, ErrorStage, UsageError};
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
    PaymentMember, ProfileEntry, ProfileHeader, Projection, RelayBinding, RetainedFrame,
    RetentionReason, SignatureEntry, Timestamp, TypedPayload, ValidationResult,
};
pub use registration::{
    address_from_compressed_pubkey, address_from_uncompressed_pubkey, expiry_timestamp, join_ms,
    registration_from_ms, split_timestamp_ms, uncompressed_pubkey, uncompressed_pubkey_xy,
};
pub use validate::{
    default_context, validate_frame, Operation, PriorStatement, SupportedSchema, ValidationContext,
};

/// Alias of [`validate_frame`].
pub fn parse_frame(bytes: &[u8], ctx: &ValidationContext) -> Result<ValidationResult, Error> {
    validate_frame(bytes, ctx)
}
