//! Typed projections of the version-1 payload schemas.
//!
//! Integers stay exact. `seconds` is an `i64` and `nanoseconds` is a `u32`;
//! neither is a float. Unknown fields are the original decoded values.

use crate::cbor::CborValue;

/// Why a frame was kept only as opaque bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionReason {
    /// `type_id` is not in the reader's supported schema list.
    UnknownType,
    /// Frame version byte is not 1. The length field was not interpreted.
    UnsupportedFrameVersion,
    /// `min_reader_version` is above the reader, and the type itself is known.
    UnsupportedMinReader,
}

impl RetentionReason {
    /// Stable reason token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownType => "unknown-type",
            Self::UnsupportedFrameVersion => "unsupported-frame-version",
            Self::UnsupportedMinReader => "unsupported-min-reader",
        }
    }
}

/// An exact, uninterpreted frame. The bytes are the input, not a reconstruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedFrame {
    /// Why the frame was not interpreted.
    pub reason: RetentionReason,
    /// Original frame bytes, header included.
    pub frame: Vec<u8>,
    /// Present unless the envelope was never read (unsupported frame version).
    pub type_id: Option<u32>,
    /// Envelope schema version, when the envelope was read.
    pub schema_version: Option<u32>,
    /// Envelope minimum reader version, when the envelope was read.
    pub min_reader_version: Option<u32>,
}

/// `exact` for a supported schema version, `newer-schema` for a V6.3 projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    /// `schema_version` is within the reader's highest supported schema.
    Exact,
    /// Newer compatible schema; unknown open-map fields are retained.
    NewerSchema,
}

/// Result of `operation: frame` (stages 1-4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameOnly {
    /// Original frame bytes.
    pub frame: Vec<u8>,
    /// Frame version byte.
    pub version: u8,
    /// Bytes after the nine-byte header. Not decoded.
    pub body: Vec<u8>,
}

/// A frame that passed the stages required by the requested operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFrame {
    /// Original frame bytes, header included. Never a re-encoding.
    pub frame: Vec<u8>,
    /// Envelope `type_id`.
    pub type_id: u32,
    /// Envelope `schema_version`.
    pub schema_version: u32,
    /// Envelope `min_reader_version`.
    pub min_reader_version: u32,
    /// The exact payload item bytes.
    pub payload_bytes: Vec<u8>,
    /// Generic decoded payload item.
    pub payload: CborValue,
    /// How unknown fields were treated.
    pub projection: Projection,
    /// Present when validation reached stage 8.
    pub typed: Option<Box<TypedPayload>>,
}

/// A child of an open message-item field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChildFrame {
    /// The child was interpreted.
    Parsed(ParsedFrame),
    /// The child was retained as exact bytes.
    Retained(RetainedFrame),
}

/// What [`crate::validate_frame`] returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationResult {
    /// Stages 1-4 passed and the operation stopped there.
    Frame(FrameOnly),
    /// Generic or typed success.
    Parsed(ParsedFrame),
    /// Opaque retention of the original frame.
    Retained(RetainedFrame),
}

/// Account reference ordered by `(key_type, key_bytes)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    /// Allocated key-type identifier.
    pub key_type: u32,
    /// Key bytes. Length is checked against the allocated type.
    pub key_bytes: Vec<u8>,
}

/// Timestamp. `seconds` is an i64; `nanoseconds` is `0..=999_999_999`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    /// Seconds since the Unix epoch, exact i64.
    pub seconds: i64,
    /// Nanoseconds, exact integer, not a float.
    pub nanoseconds: u32,
}

/// One payment member. `value` is a 32-byte big-endian quantity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentMember {
    /// Non-hardened BIP32 index.
    pub child_index: u32,
    /// Chain transaction identifier.
    pub transaction_id: Vec<u8>,
    /// 32-byte big-endian value.
    pub value: Vec<u8>,
    /// Destination address bytes.
    pub address: Vec<u8>,
    /// 32-byte T4 commitment.
    pub commitment: Vec<u8>,
}

/// One signature entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureEntry {
    /// Signature algorithm identifier.
    pub algorithm: u32,
    /// Signer account.
    pub signer: AccountRef,
    /// Signature bytes.
    pub signature: Vec<u8>,
}

/// One relay binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayBinding {
    /// Relay identifier.
    pub relay_id: Vec<u8>,
    /// Exact endpoint text. Not normalized.
    pub endpoint: String,
    /// Relay identity.
    pub identity: AccountRef,
    /// Binding expiry.
    pub expiry: Timestamp,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One key-transition entry after its type-7 frame has been opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyTransition {
    /// Opened type-7 statement frame.
    pub statement: ParsedFrame,
    /// Authorization algorithm.
    pub algorithm: u32,
    /// Signer. Must equal the statement's prior authority.
    pub signer: AccountRef,
    /// Signature bytes.
    pub signature: Vec<u8>,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One journal fact. `payload` is opaque in version 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalFact {
    /// Fact time.
    pub timestamp: Timestamp,
    /// 16-byte fact identifier.
    pub fact_id: Vec<u8>,
    /// Uninterpreted fact kind.
    pub kind: u32,
    /// Opaque payload bytes.
    pub payload: Vec<u8>,
    /// Fields kept under V6.3.
    pub unknown: Vec<(u64, CborValue)>,
}

/// One opaque checkpoint section. `value` is never opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueSection {
    /// Section type.
    pub section_type: u32,
    /// Section schema version.
    pub section_schema_version: u32,
    /// Exact section bytes.
    pub value: Vec<u8>,
}

/// Typed payload. Framed children are opened frames, not raw bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypedPayload {
    /// Type 1.
    DirectMessage {
        /// Field 0.
        network: String,
        /// Field 1.
        destination: AccountRef,
        /// Field 2, opened as type 5.
        payload_frame: ParsedFrame,
        /// Field 3.
        payload_digest: Vec<u8>,
        /// Field 4.
        payments: Vec<PaymentMember>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 2.
    DirectoryAttestation {
        /// Field 0, opened as type 4.
        statement: ParsedFrame,
        /// Field 1.
        signatures: Vec<SignatureEntry>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 3.
    MailboxCheckpoint {
        /// Field 0.
        network: String,
        /// Field 1.
        owner: AccountRef,
        /// Field 2.
        checkpoint_id: Vec<u8>,
        /// Field 3.
        timestamp: Timestamp,
        /// Field 4.
        facts: Vec<JournalFact>,
        /// Field 5, when present.
        sections: Option<Vec<OpaqueSection>>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 4.
    DirectoryStatement {
        /// Field 0.
        network: String,
        /// Field 1.
        subject: AccountRef,
        /// Field 2, exact u64.
        revision: u64,
        /// Field 3.
        timestamp: Timestamp,
        /// Field 4.
        relays: Vec<RelayBinding>,
        /// Field 5, when present.
        key_transitions: Option<Vec<KeyTransition>>,
        /// Field 6, when present.
        expiry: Option<Timestamp>,
        /// Field 7, when present.
        recovery: Option<Vec<AccountRef>>,
        /// The frame's envelope `schema_version`, kept for the S10a.2 same-subject order.
        schema_version: u32,
        /// Field 8, the stamp key `P'` (S10a.1): required in schema 2, undefined in schema 1.
        stamp_key: Option<AccountRef>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 5.
    RecipientPayload {
        /// Field 0.
        network: String,
        /// Field 1.
        sender: AccountRef,
        /// Field 2.
        recipient: AccountRef,
        /// Field 3.
        suite: u32,
        /// Field 4.
        nonce: Vec<u8>,
        /// Field 5.
        ciphertext: Vec<u8>,
        /// Field 6, `E = e*G`: a 33-byte compressed point (T3a, T3b encoding rules).
        ephemeral_point: Vec<u8>,
        /// Field 7, `X = e*P'`: a 33-byte compressed point (T3a).
        shared_point: Vec<u8>,
        /// Field 8, the DLEQ proof `c || s` (T3b); verified only at stage 10.
        dleq_proof: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 6.
    EncryptedContent {
        /// Field 0.
        network: String,
        /// Field 1.
        message_id: Vec<u8>,
        /// Field 2, opened as type 8.
        revision_frame: ParsedFrame,
        /// Field 3.
        content_digest: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 7.
    KeyTransitionStatement {
        /// Field 0.
        network: String,
        /// Field 1.
        subject: AccountRef,
        /// Field 2.
        prior_authority: AccountRef,
        /// Field 3, exact u64, at least 1.
        revision: u64,
        /// Field 4.
        new_key: AccountRef,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 9.
    TopicPost {
        /// Field 0.
        network: String,
        /// Field 1, exact UTF-8, not normalized.
        topic: String,
        /// Field 2, when present: T1 hash of the parent type-9 frame.
        parent_hash: Option<Vec<u8>>,
        /// Field 3, opaque.
        body: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 10.
    TopicPostSubmission {
        /// Field 0.
        network: String,
        /// Field 1, opened as type 9.
        post_frame: ParsedFrame,
        /// Field 2, raw signed chain transaction.
        burn_tx: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 11.
    TopicVoteSubmission {
        /// Field 0.
        network: String,
        /// Field 1: T1 hash of the target type-9 frame.
        target_hash: Vec<u8>,
        /// Field 2, raw signed chain transaction.
        burn_tx: Vec<u8>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 8.
    MessageRevision {
        /// Field 1 children.
        items: Vec<ChildFrame>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 16.
    ContainerItem {
        /// Field 0 children.
        items: Vec<ChildFrame>,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
    /// Type 17.
    TextItem {
        /// Field 0.
        text: String,
        /// V6.3 unknown fields.
        unknown: Vec<(u64, CborValue)>,
    },
}
