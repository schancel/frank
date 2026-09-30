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
//! It implements section 9 stages 1-9 and the pure hashes T1, T1a, T3, and T4.
//! Stage 10 (`full`: signatures, payment observations, T3a derivation) is out of
//! scope, matching the TypeScript reference codec. Nothing here is wired into
//! cashwebd or a stored record format.

mod cbor;
mod error;
mod frame;
mod hash;
mod limits;
mod model;
mod schema;
mod semantic;
mod validate;

pub use cbor::{cbor_map, decode_canonical, encode_canonical, is_valid_canonical, CborValue};
pub use error::{CborPass, CodecError, ContextError, Error, ErrorCategory, ErrorStage, UsageError};
pub use frame::{encode_frame, wrap_frame, EnvelopeFields, FramePayload};
pub use hash::{
    common_transcript, content_hash, content_hash_network, message_content_digest,
    payment_commitment, recipient_payload_digest,
};
pub use limits::{
    FRAME_HEADER_BYTES, FRAME_MAGIC, FRAME_VERSION, KNOWN_TYPES, MAX_ARRAY_ELEMENTS,
    MAX_BODY_BYTES, MAX_BYTE_STRING_BYTES, MAX_CONTAINERS, MAX_DEPTH, MAX_FRAME_BYTES, MAX_ITEMS,
    MAX_MAP_ENTRIES, MAX_TEXT_STRING_BYTES,
};
pub use model::{
    AccountRef, ChildFrame, FrameOnly, JournalFact, KeyTransition, OpaqueSection, ParsedFrame,
    PaymentMember, Projection, RelayBinding, RetainedFrame, RetentionReason, SignatureEntry,
    Timestamp, TypedPayload, ValidationResult,
};
pub use validate::{
    default_context, validate_frame, Operation, PriorStatement, SupportedSchema, ValidationContext,
};

/// Alias of [`validate_frame`].
pub fn parse_frame(bytes: &[u8], ctx: &ValidationContext) -> Result<ValidationResult, Error> {
    validate_frame(bytes, ctx)
}
