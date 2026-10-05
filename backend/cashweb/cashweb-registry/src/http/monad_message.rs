//! Durable HTTP admission and recipient-private reads for Monad-stamped direct messages.
//!
//! `PUT /message/monad` exists only when the process-owned mailbox runtime is enabled. Admission
//! validates the complete request before atomically claiming its exact bytes in the canonical
//! outbox, then uses the same reconciler and frozen policy as startup recovery. Only durable inbox
//! publication returns success.
//!
//! Inbox pagination and confirmed-prefix recovery require a registered-profile ECDSA signature
//! over a domain-, runtime-epoch-, nonce-, expiry-, method-, path-, recipient-, cursor-, limit-,
//! and network-bound request. Challenges are stateless server-MACed tokens with random nonces;
//! replay state is allocated only after successful recipient authentication. Consumed nonces are
//! durable, single-use, and never evicted before expiry; the cap is recipient-local, so one
//! identity cannot exhaust another identity's authority. Inbox pages use `(timestamp,
//! payload_hash)` ordering and recovery pages use `payload_hash` ordering. Their authenticated
//! cursor is strict-forward, returned in `x-frank-mailbox-next-cursor`, and must be supplied in
//! the next signed query. The signature binds the opaque cursor token as length-prefixed UTF-8
//! exactly as returned; a client never decodes the relay-authenticated cursor position. The old
//! unauthenticated exact/global GET routes are deliberately not installed.
//!
//! ```compile_fail
//! use cashweb_registry::http::monad_message::handle_get_monad_message;
//! ```
//!
//! ```compile_fail
//! use cashweb_registry::http::monad_message::handle_list_monad_messages;
//! ```
//!
//! ## Why a separate route, and a separate message type, instead of extending `PUT /message`
//!
//! `handle_put_message` (in `crate::http::server`) decodes a `cashweb_payload::proto::
//! SignedPayload`, whose `burn_txs: repeated BurnTx { bytes tx, uint32 burn_idx }` is structurally
//! UTXO-shaped: `burn_idx` indexes into a Lotus transaction's *output list*, which an EVM
//! transaction doesn't have. `SignedPayload::parse_proto`/`verify` (`cashweb-payload/src/
//! payload.rs`/`verify.rs`) unconditionally deserialize every `burn_tx.tx` as a Lotus
//! `UnhashedTx` -- there's no branch point to feed a raw EVM tx through instead, and editing those
//! files is explicitly out of scope for this ticket (Lotus must keep working exactly as-is). A
//! Monad stamp therefore needs its own message shape ([`proto::MonadStampedMessage`], a new
//! proto file owned by this crate rather than `cashweb-payload`, avoiding the circular-dependency
//! problem `monad_stamp_relay`'s docs describe -- `cashweb-payload` is lower-level than
//! `cashweb-registry`, where `monad_stamp_relay`/`monad_stamp_verify` live) and its own route.
//!
//! Unlike a Lotus `SignedPayload`, [`proto::MonadStampedMessage`] carries no separate pubkey or
//! signature. The raw transaction signatures authenticate only disposable funding accounts, not
//! the claimed message author; that is intentional and preserves Stamp's deniability. Recipient-
//! verifiable authentication belongs inside the encrypted content. The payload hash instead binds
//! each payment transaction to this exact encrypted payload, preventing reuse with substituted
//! content.
//!
//! ## Storage: why this doesn't go through `Registry::put_message`/`DbTopics`
//!
//! `Registry::put_message` (and the `DbTopics` store it writes through) operates on
//! `cashweb_payload::payload::SignedPayload<proto::BroadcastMessage>`, whose `burn_txs: Vec<
//! BurnTx>` wraps a Lotus `Tx` and whose indexing (`lotus_txid`, per-topic burn dedup) is built
//! entirely around that shape -- checked while implementing this ticket, not assumed. It is
//! **not** chain-agnostic despite living in the same crate. `admit_monad_message` therefore
//! stores through a new, parallel path instead: [`Registry::put_monad_message`] /
//! [`crate::store::monad_messages::DbMonadMessages`] (see that module's docs for the full
//! reasoning).
//!
//! RPC endpoint and aggregate minimum come only from the validated `RegistryServer` mailbox
//! runtime; this module never reparses environment configuration.

use std::fmt;
#[cfg(test)]
use std::{collections::HashMap, sync::OnceLock};

use axum::{
    extract::{Path, Query},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::{BoundedProtobufBody, Protobuf};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha3::{Digest as _, Keccak256};
use tracing::Level;

const MAX_PRIVATE_MAILBOX_PAGE: usize = 100;
const MAX_PRIVATE_MAILBOX_RESPONSE_BYTES: usize = MAX_MONAD_MESSAGE_BODY_BYTES * 2 + 16 * 1024;
const DEFAULT_PRIVATE_MAILBOX_RESPONSE_BYTES: usize = MAX_PRIVATE_MAILBOX_RESPONSE_BYTES;
const MAX_PRIVATE_RECOVERY_SCAN: usize = 512;
// Recovery JSON hex encoding needs at most two response bytes per canonical protobuf byte, while
// inspected RocksDB work is independently capped at the full requested response-byte ceiling.
const PRIVATE_RECOVERY_CANONICAL_BUDGET_DIVISOR: usize = 2;
const PRIVATE_RECOVERY_WORK_BUDGET_DIVISOR: usize = 1;
pub(crate) const MAILBOX_AUTH_DOMAIN: &str = "frank:mailbox-http-auth:v2";
const MAILBOX_EPOCH_HEADER: &str = "x-frank-mailbox-epoch";
const MAILBOX_NONCE_HEADER: &str = "x-frank-mailbox-nonce";
const MAILBOX_EXPIRY_HEADER: &str = "x-frank-mailbox-expires-at-ms";
const MAILBOX_SIGNATURE_HEADER: &str = "x-frank-mailbox-signature";
const MAILBOX_TOKEN_HEADER: &str = "x-frank-mailbox-token";
const MAILBOX_NEXT_CURSOR_HEADER: &str = "x-frank-mailbox-next-cursor";
const MIN_ECDSA_DER_SIGNATURE_BYTES: usize = 8;
const MAX_ECDSA_DER_SIGNATURE_BYTES: usize = 72;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::EvmTxError,
    monad_http::{Address, Hash32, JsonRpcTransport},
    monad_mailbox::{
        MailboxChallenge, MailboxCursor, MailboxCursorBinding, MailboxRequestBinding,
        MailboxResource, CHALLENGE_TTL_MS, MAX_USED_CHALLENGES_PER_RECIPIENT,
    },
    monad_outbox::{
        reconcile_monad_outbox_with_permits, MonadOutboxPermitPool, MonadOutboxReconcileOutcome,
    },
    monad_stamp_relay::StampRelayOutcome,
    monad_stamp_stealth::StampStealthError,
    proto,
    registry::Registry,
    store::monad_messages::{ChallengeConsumption, RecipientMessageCursor},
    store::monad_outbox::{
        MonadMessageOwnership, MonadOutboxClaim, MonadOutboxLifecycle, MonadOutboxPolicy,
        MonadOutboxTerminal, MonadRecoveryAck,
    },
};

#[cfg(test)]
use crate::{
    monad_evm_tx::decode_signed_transaction,
    monad_http::HttpTransport,
    monad_outbox::financial::payment_commitment,
    store::monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy},
    store::monad_outbox::MonadOutboxLeaseAcquire,
};

use crate::monad_outbox::financial::MAX_STAMP_PAYMENTS;
const MAX_MONAD_MESSAGE_BODY_BYTES: usize = 2 * 1024 * 1024;
const MIN_ENVELOPE_BODY_HEADROOM_BYTES: usize = 128 * 1024;
const MAX_ENVELOPE_JSON_OVERHEAD_BYTES: usize = 1024;
const MAX_ENVELOPE_CIPHERTEXT_BYTES: usize = (MAX_MONAD_MESSAGE_BODY_BYTES
    - MIN_ENVELOPE_BODY_HEADROOM_BYTES
    - MAX_ENVELOPE_JSON_OVERHEAD_BYTES)
    / 2;
const MAX_ENVELOPE_NETWORK_TAG_BYTES: usize = crate::network_tag::MAX_NETWORK_TAG_BYTES;
const ENVELOPE_HKDF_SALT_BYTES: usize = 32;
const ENVELOPE_GCM_NONCE_BYTES: usize = 12;
const ENVELOPE_GCM_TAG_BYTES: usize = 16;
#[cfg(test)]
type AdmissionRaceHook = Box<dyn FnOnce() + Send>;
#[cfg(test)]
static ADMISSION_RACE_HOOKS: OnceLock<std::sync::Mutex<HashMap<[u8; 32], AdmissionRaceHook>>> =
    OnceLock::new();

/// Errors processing a [`proto::MonadStampedMessage`], independent of HTTP/axum (see
/// `admit_monad_message`) so this logic can be unit-tested directly against a mock
/// [`JsonRpcTransport`], the same way `monad_stamp_relay`/`monad_stamp_verify` test themselves.
#[derive(Debug)]
pub enum ProcessMonadMessageError {
    /// `encrypted_payload` is not a complete, canonical v2 authenticated envelope.
    InvalidEnvelope(String),
    /// The envelope was hashed for a different Frank network than this relay serves.
    NetworkTagMismatch {
        /// Relay-configured tag.
        expected: Vec<u8>,
        /// Envelope tag, or none when omitted.
        actual: Option<String>,
    },
    /// No registered recipient public key exists, so stealth destinations cannot be verified.
    RecipientProfileNotFound(Address),
    /// A signed payment belongs to a different EVM chain than this relay.
    UnexpectedChainId {
        /// Configured chain identity.
        expected: u64,
        /// Signed chain identity, or none for an unprotected legacy transaction.
        actual: Option<u64>,
    },
    /// A direct message must carry at least one payment transaction.
    MissingStampPayments,
    /// Payment-set cardinality is bounded before any transaction cryptography or RPC work.
    TooManyStampPayments {
        /// Submitted payment count.
        actual: usize,
        /// Applicable fixed wire or current new-admission ceiling.
        maximum: usize,
    },
    /// This payload hash is already bound to a different canonical raw payment set.
    ConflictingPaymentSet,
    /// Another request for this payload hash is already being reconciled.
    PaymentSetBusy,
    /// The relay is at its bounded number of concurrent external RPC operations.
    RelayBusy,
    /// A node RPC remained unresolved past the route's admission timeout.
    RelayTimedOut,
    /// The durable admission bound was reached without writing a claim.
    OutboxAtCapacity,
    /// Capacity blocked migration, while the exact legacy owner remains durable.
    OutboxAtCapacityExactLegacy,
    /// The exact durable claim remains pending after this bounded request.
    OutboxPending,
    /// A claimed row disappeared while the bounded reconciler was running.
    OutboxUnavailable,
    /// The exact durable claim reached a stable terminal state.
    OutboxTerminal {
        /// Stable terminal reason.
        terminal: MonadOutboxTerminal,
        /// Whether the exact caller bytes still have a durable owner after terminal GC.
        retained: bool,
    },
    /// Validation failed before an exact digest-only predecessor owner could be adopted. The
    /// inner error is preserved while the HTTP response reports that the exact set remains owned.
    LegacyExactRetained(Box<ProcessMonadMessageError>),
    /// Reusing a child index would send multiple payments to the same one-time destination.
    DuplicateChildIndex(u32),
    /// Child indices must be exactly `0..n-1` in wire order.
    NonCanonicalChildIndex {
        /// Position within `stamp_payments`.
        position: usize,
        /// Index found at that position.
        actual: u32,
    },
    /// Multiple payments must not expose the same sender funding account.
    DuplicateFundingAccount(Address),
    /// Identical signed transactions must not appear twice in a canonical set.
    DuplicateTransaction(Hash32),
    /// A disposable funding account must not also be one of this set's recipient destinations.
    FundingAccountIsDestination(Address),
    /// A signed payment's own fields fail a check that can be completed before broadcasting.
    InvalidPaymentPreflight {
        /// Canonical child whose transaction failed.
        child_index: u32,
        /// Concrete failed invariant.
        detail: String,
    },
    /// The expected one-time payment destination could not be derived canonically.
    InvalidStealthDestination(StampStealthError),
    /// `payload_hash` wasn't exactly 32 bytes.
    InvalidPayloadHashLength(usize),
    /// `payload_hash` didn't match `SHA256(encrypted_payload)`.
    PayloadHashMismatch {
        /// The client-declared `payload_hash`.
        declared: Sha256,
        /// The actual hash of `encrypted_payload`.
        actual: Sha256,
    },
    /// [`recover_sender`] couldn't recover a funding account from a raw payment transaction.
    FundingAccountRecoveryFailed(EvmTxError),
    /// The individually verified payments did not meet the message-wide minimum.
    InsufficientTotalValue {
        /// Required aggregate value in wei.
        required: u128,
        /// Actual aggregate value in wei.
        actual: u128,
    },
    /// Summing payment values overflowed the relay's `u128` value representation.
    TotalValueOverflow,
    /// The stamp didn't verify -- see the wrapped [`StampRelayOutcome`] for exactly why (a
    /// broadcast-time RPC failure, a confirmation timeout, or a specific verification failure).
    /// Every non-[`StampRelayOutcome::Verified`] outcome is a rejection, never a silent store, per
    /// ticket #19's acceptance criteria.
    Rejected(StampRelayOutcome),
    /// The first payment was definitively refused before any set member was accepted, so the
    /// durable exact-set claim was released and the sender may safely construct another set.
    RejectedWithoutRetainedSet(StampRelayOutcome),
    /// An infrastructure-level failure (RPC/transport error, or a storage error) rather than a
    /// rejection of the message itself.
    Infrastructure(Report),
}

impl fmt::Display for ProcessMonadMessageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessMonadMessageError::InvalidEnvelope(detail) => {
                write!(f, "invalid Monad message envelope: {detail}")
            }
            ProcessMonadMessageError::NetworkTagMismatch { expected, actual } => write!(
                f,
                "message network tag {:?} does not match relay tag {}",
                actual,
                String::from_utf8_lossy(expected)
            ),
            ProcessMonadMessageError::RecipientProfileNotFound(address) => {
                write!(f, "recipient {address} has no registered Monad profile")
            }
            ProcessMonadMessageError::UnexpectedChainId { expected, actual } => write!(
                f,
                "stamp payment chain ID {actual:?} does not match relay chain ID {expected}"
            ),
            ProcessMonadMessageError::MissingStampPayments => {
                write!(f, "a direct message requires at least one stamp payment")
            }
            ProcessMonadMessageError::TooManyStampPayments { actual, maximum } => write!(
                f,
                "a direct message may contain at most {maximum} stamp payments, got {actual}"
            ),
            ProcessMonadMessageError::ConflictingPaymentSet => write!(
                f,
                "payload hash is already bound to a different stamp-payment set"
            ),
            ProcessMonadMessageError::PaymentSetBusy => {
                write!(f, "this stamp-payment set is already being reconciled")
            }
            ProcessMonadMessageError::RelayBusy => {
                write!(f, "the stamp relay is temporarily at capacity")
            }
            ProcessMonadMessageError::RelayTimedOut => {
                write!(f, "the stamp relay timed out waiting for the Monad node")
            }
            ProcessMonadMessageError::OutboxAtCapacity => {
                write!(f, "the durable stamp outbox is temporarily at capacity")
            }
            ProcessMonadMessageError::OutboxAtCapacityExactLegacy => write!(
                f,
                "the exact legacy stamp owner is retained while the durable outbox is at capacity"
            ),
            ProcessMonadMessageError::OutboxPending => {
                write!(
                    f,
                    "the exact stamp-payment set is pending durable reconciliation"
                )
            }
            ProcessMonadMessageError::OutboxUnavailable => {
                write!(f, "the durable stamp outbox is temporarily unavailable")
            }
            ProcessMonadMessageError::OutboxTerminal { terminal, .. } => {
                write!(f, "the exact stamp-payment set is terminal: {terminal:?}")
            }
            ProcessMonadMessageError::LegacyExactRetained(err) => err.fmt(f),
            ProcessMonadMessageError::DuplicateChildIndex(index) => {
                write!(f, "stamp payment child index {index} is duplicated")
            }
            ProcessMonadMessageError::NonCanonicalChildIndex { position, actual } => write!(
                f,
                "stamp payment at position {position} has child index {actual}; expected {position}"
            ),
            ProcessMonadMessageError::DuplicateFundingAccount(address) => {
                write!(f, "stamp funding account {address} is reused")
            }
            ProcessMonadMessageError::DuplicateTransaction(hash) => {
                write!(f, "stamp transaction {hash} is duplicated")
            }
            ProcessMonadMessageError::FundingAccountIsDestination(address) => write!(
                f,
                "stamp funding account {address} is also a recipient child destination"
            ),
            ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index,
                detail,
            } => write!(
                f,
                "stamp payment child {child_index} failed preflight validation: {detail}"
            ),
            ProcessMonadMessageError::InvalidStealthDestination(err) => {
                write!(f, "invalid stamp stealth destination: {err}")
            }
            ProcessMonadMessageError::InvalidPayloadHashLength(len) => {
                write!(f, "payload_hash must be 32 bytes, got {len}")
            }
            ProcessMonadMessageError::PayloadHashMismatch { declared, actual } => write!(
                f,
                "payload_hash {declared} doesn't match SHA256(encrypted_payload) {actual}"
            ),
            ProcessMonadMessageError::FundingAccountRecoveryFailed(err) => {
                write!(
                    f,
                    "couldn't recover funding account from stamp payment: {err}"
                )
            }
            ProcessMonadMessageError::InsufficientTotalValue { required, actual } => {
                write!(
                    f,
                    "stamp payment set carries {actual} wei, below required {required} wei"
                )
            }
            ProcessMonadMessageError::TotalValueOverflow => {
                write!(f, "stamp payment value sum overflowed u128")
            }
            ProcessMonadMessageError::Rejected(outcome) => {
                write!(f, "Monad stamp rejected: {outcome:?}")
            }
            ProcessMonadMessageError::RejectedWithoutRetainedSet(outcome) => {
                write!(
                    f,
                    "Monad stamp rejected before retaining its payment set: {outcome:?}"
                )
            }
            ProcessMonadMessageError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// The client's authenticated v2 envelope. `#[derive(Deserialize)]` ignores additive fields, but
/// duplicate required fields remain ambiguous JSON and are rejected by serde.
#[derive(Deserialize)]
struct MonadMessageEnvelope {
    v: u64,
    #[serde(rename = "networkTag")]
    network_tag: String,
    from: String,
    to: String,
    salt: String,
    nonce: String,
    ciphertext: String,
    tag: String,
}

struct ValidatedMonadMessageEnvelope {
    recipient: Address,
}

/// The base historical routing shape needed when resuming a durable exact attempt. Records before
/// envelope versioning had no `v`, so exact compatibility must neither require nor interpret it.
/// The attempt digest proves these are the payload bytes which created the claim.
#[derive(Deserialize)]
struct ClaimedMonadMessageEnvelope {
    to: String,
    #[serde(rename = "networkTag")]
    network_tag: Option<String>,
}

struct ClaimedMonadMessageRouting {
    recipient: Address,
    network_tag: Option<Vec<u8>>,
}

fn validate_lower_hex_field(
    name: &str,
    value: &str,
    exact_bytes: Option<usize>,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<(), ProcessMonadMessageError> {
    if value.is_empty()
        || value.len() % 2 != 0
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
            "{name} must be canonical lower-case hex"
        )));
    }
    let bytes = value.len() / 2;
    if let Some(expected) = exact_bytes {
        if bytes != expected {
            return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
                "{name} must be exactly {expected} bytes"
            )));
        }
    } else if bytes < min_bytes || bytes > max_bytes {
        return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
            "{name} must be {min_bytes}..={max_bytes} bytes"
        )));
    }
    Ok(())
}

/// Accept the canonical lower-case EVM form or a correctly checksummed EIP-55 form. Upper-case
/// non-checksummed and incorrectly checksummed mixed-case spellings are rejected so routing and
/// authenticated associated data have one meaningful representation per accepted spelling.
fn parse_canonical_address(name: &str, value: &str) -> Result<Address, ProcessMonadMessageError> {
    let address = Address::from_hex(value).map_err(|err| {
        ProcessMonadMessageError::InvalidEnvelope(format!("invalid {name} address: {err}"))
    })?;
    let body = &value[2..];
    let lower = body.to_ascii_lowercase();
    if body != lower {
        let checksum = Keccak256::digest(lower.as_bytes());
        let valid_checksum = body.bytes().enumerate().all(|(index, byte)| {
            if byte.is_ascii_digit() {
                return true;
            }
            let hash_byte = checksum[index / 2];
            let nibble = if index % 2 == 0 {
                hash_byte >> 4
            } else {
                hash_byte & 0x0f
            };
            byte.is_ascii_uppercase() == (nibble >= 8)
        });
        if !valid_checksum {
            return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
                "{name} address is not canonical lower-case or valid EIP-55"
            )));
        }
    }
    Ok(address)
}

/// Fully validate a new authenticated envelope before transaction decoding, RPC, attempt claims,
/// or storage. The relay cannot verify AEAD authenticity, but it rejects malformed, legacy, and
/// unsupported shapes and reuses the validated `to` address for payment routing. Exact retries of
/// records already in storage are returned before this validator so historical envelopes remain
/// retrievable after admission policy changes.
fn validate_envelope(
    encrypted_payload: &[u8],
    expected_network_tag: &[u8],
) -> Result<ValidatedMonadMessageEnvelope, ProcessMonadMessageError> {
    let envelope: MonadMessageEnvelope = serde_json::from_slice(encrypted_payload)
        .map_err(|err| ProcessMonadMessageError::InvalidEnvelope(err.to_string()))?;
    if envelope.v != 2 {
        return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
            "unsupported version {} (expected 2)",
            envelope.v
        )));
    }
    if envelope.network_tag.is_empty()
        || envelope.network_tag.len() > MAX_ENVELOPE_NETWORK_TAG_BYTES
    {
        return Err(ProcessMonadMessageError::InvalidEnvelope(format!(
            "networkTag must be 1..={MAX_ENVELOPE_NETWORK_TAG_BYTES} UTF-8 bytes"
        )));
    }
    let _sender = parse_canonical_address("from", &envelope.from)?;
    let recipient = parse_canonical_address("to", &envelope.to)?;
    validate_lower_hex_field("salt", &envelope.salt, Some(ENVELOPE_HKDF_SALT_BYTES), 0, 0)?;
    validate_lower_hex_field(
        "nonce",
        &envelope.nonce,
        Some(ENVELOPE_GCM_NONCE_BYTES),
        0,
        0,
    )?;
    validate_lower_hex_field(
        "ciphertext",
        &envelope.ciphertext,
        None,
        1,
        MAX_ENVELOPE_CIPHERTEXT_BYTES,
    )?;
    validate_lower_hex_field("tag", &envelope.tag, Some(ENVELOPE_GCM_TAG_BYTES), 0, 0)?;
    if envelope.network_tag.as_bytes() != expected_network_tag {
        return Err(ProcessMonadMessageError::NetworkTagMismatch {
            expected: expected_network_tag.to_vec(),
            actual: Some(envelope.network_tag),
        });
    }
    Ok(ValidatedMonadMessageEnvelope { recipient })
}

fn routing_from_claimed_envelope(
    encrypted_payload: &[u8],
) -> Result<ClaimedMonadMessageRouting, ProcessMonadMessageError> {
    let envelope: ClaimedMonadMessageEnvelope = serde_json::from_slice(encrypted_payload)
        .map_err(|err| ProcessMonadMessageError::InvalidEnvelope(err.to_string()))?;
    let recipient = Address::from_hex(&envelope.to).map_err(|err| {
        ProcessMonadMessageError::InvalidEnvelope(format!("invalid claimed to address: {err}"))
    })?;
    Ok(ClaimedMonadMessageRouting {
        recipient,
        network_tag: envelope.network_tag.map(String::into_bytes),
    })
}

/// Complete all CPU-only payment validation before creating a durable claim or issuing RPC.
fn validate_payment_set(
    request: &proto::MonadStampedMessage,
    payload_hash: [u8; 32],
    policy: &MonadOutboxPolicy,
    expected_chain_id: u64,
) -> Result<(), ProcessMonadMessageError> {
    use crate::monad_outbox::financial::PaymentPreflightError;
    crate::monad_outbox::financial::validate_payment_set(
        request,
        payload_hash,
        policy,
        expected_chain_id,
    )
    .map(|_| ())
    .map_err(|error| match error {
        PaymentPreflightError::MissingStampPayments => {
            ProcessMonadMessageError::MissingStampPayments
        }
        PaymentPreflightError::TooManyStampPayments { actual, maximum } => {
            ProcessMonadMessageError::TooManyStampPayments { actual, maximum }
        }
        PaymentPreflightError::NonCanonicalChildIndex { position, actual } => {
            ProcessMonadMessageError::NonCanonicalChildIndex { position, actual }
        }
        PaymentPreflightError::DuplicateChildIndex(value) => {
            ProcessMonadMessageError::DuplicateChildIndex(value)
        }
        PaymentPreflightError::FundingAccountRecoveryFailed(value) => {
            ProcessMonadMessageError::FundingAccountRecoveryFailed(value)
        }
        PaymentPreflightError::UnexpectedChainId { expected, actual } => {
            ProcessMonadMessageError::UnexpectedChainId { expected, actual }
        }
        PaymentPreflightError::DuplicateTransaction(value) => {
            ProcessMonadMessageError::DuplicateTransaction(value)
        }
        PaymentPreflightError::DuplicateFundingAccount(value) => {
            ProcessMonadMessageError::DuplicateFundingAccount(value)
        }
        PaymentPreflightError::InvalidStealthDestination(value) => {
            ProcessMonadMessageError::InvalidStealthDestination(value)
        }
        PaymentPreflightError::InvalidPaymentPreflight {
            child_index,
            detail,
        } => ProcessMonadMessageError::InvalidPaymentPreflight {
            child_index,
            detail,
        },
        PaymentPreflightError::TotalValueOverflow => ProcessMonadMessageError::TotalValueOverflow,
        PaymentPreflightError::FundingAccountIsDestination(value) => {
            ProcessMonadMessageError::FundingAccountIsDestination(value)
        }
        PaymentPreflightError::InsufficientTotalValue { required, actual } => {
            ProcessMonadMessageError::InsufficientTotalValue { required, actual }
        }
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn reread_delivered_owner(
    registry: &Registry,
    request: &proto::MonadStampedMessage,
) -> Result<proto::StoredMonadMessage, ProcessMonadMessageError> {
    match registry
        .classify_monad_message_ownership(request)
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadMessageOwnership::DeliveredExact(stored) => Ok(stored),
        MonadMessageOwnership::Conflict => Err(ProcessMonadMessageError::ConflictingPaymentSet),
        MonadMessageOwnership::Missing
        | MonadMessageOwnership::OutboxExact(_)
        | MonadMessageOwnership::LegacyExact(_) => Err(ProcessMonadMessageError::OutboxUnavailable),
    }
}

fn exact_owner_retained(
    registry: &Registry,
    request: &proto::MonadStampedMessage,
) -> Result<bool, ProcessMonadMessageError> {
    Ok(matches!(
        registry
            .classify_monad_message_ownership(request)
            .map_err(ProcessMonadMessageError::Infrastructure)?,
        MonadMessageOwnership::DeliveredExact(_)
            | MonadMessageOwnership::OutboxExact(_)
            | MonadMessageOwnership::LegacyExact(_)
    ))
}

fn terminal_process_error(
    registry: &Registry,
    request: &proto::MonadStampedMessage,
    terminal: MonadOutboxTerminal,
) -> ProcessMonadMessageError {
    match exact_owner_retained(registry, request) {
        Ok(retained) => ProcessMonadMessageError::OutboxTerminal { terminal, retained },
        Err(err) => err,
    }
}

fn classify_after_reconcile_error(
    registry: &Registry,
    request: &proto::MonadStampedMessage,
    original: Report,
) -> Result<proto::StoredMonadMessage, ProcessMonadMessageError> {
    match registry
        .classify_monad_message_ownership(request)
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadMessageOwnership::DeliveredExact(stored) => Ok(stored),
        MonadMessageOwnership::OutboxExact(record) => Err(match record.lifecycle {
            MonadOutboxLifecycle::Terminal(terminal) => ProcessMonadMessageError::OutboxTerminal {
                terminal,
                retained: true,
            },
            MonadOutboxLifecycle::Pending | MonadOutboxLifecycle::FullyConfirmed => {
                ProcessMonadMessageError::OutboxPending
            }
            MonadOutboxLifecycle::Delivered => ProcessMonadMessageError::Infrastructure(original),
        }),
        MonadMessageOwnership::LegacyExact(_) => Err(ProcessMonadMessageError::OutboxPending),
        MonadMessageOwnership::Conflict => Err(ProcessMonadMessageError::ConflictingPaymentSet),
        MonadMessageOwnership::Missing => Err(ProcessMonadMessageError::OutboxUnavailable),
    }
}

/// Validate, atomically claim, and reconcile one request through durable inbox publication.
async fn admit_monad_message<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    config: &crate::monad_outbox::MonadOutboxReconcileConfig,
    permits: &MonadOutboxPermitPool,
    min_value_wei: u128,
    network_tag: &[u8],
    request: proto::MonadStampedMessage,
) -> Result<proto::StoredMonadMessage, ProcessMonadMessageError> {
    let declared_hash = Sha256::from_slice(&request.payload_hash).map_err(|_| {
        ProcessMonadMessageError::InvalidPayloadHashLength(request.payload_hash.len())
    })?;
    let actual_hash = Sha256::digest(request.encrypted_payload.clone().into());
    if declared_hash != actual_hash {
        return Err(ProcessMonadMessageError::PayloadHashMismatch {
            declared: declared_hash,
            actual: actual_hash,
        });
    }
    let ownership = registry
        .classify_monad_message_ownership(&request)
        .map_err(ProcessMonadMessageError::Infrastructure)?;
    if let MonadMessageOwnership::DeliveredExact(existing) = &ownership {
        return Ok(existing.clone());
    }
    if matches!(&ownership, MonadMessageOwnership::Conflict) {
        return Err(ProcessMonadMessageError::ConflictingPaymentSet);
    }
    if matches!(&ownership, MonadMessageOwnership::OutboxExact(_)) {
        #[cfg(test)]
        {
            let hook_key: [u8; 32] = declared_hash.as_slice().try_into().expect("SHA256 length");
            if let Some(hook) = ADMISSION_RACE_HOOKS
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .remove(&hook_key)
            {
                hook();
            }
        }
        return match reconcile_monad_outbox_with_permits(
            transport,
            registry,
            declared_hash.as_slice(),
            config,
            permits,
        )
        .await
        {
            Err(err) => classify_after_reconcile_error(registry, &request, err),
            Ok(MonadOutboxReconcileOutcome::Delivered(stored)) => Ok(stored),
            Ok(MonadOutboxReconcileOutcome::Pending) => {
                Err(ProcessMonadMessageError::OutboxPending)
            }
            Ok(MonadOutboxReconcileOutcome::Terminal(terminal)) => {
                Err(terminal_process_error(registry, &request, terminal))
            }
            Ok(MonadOutboxReconcileOutcome::Missing) => reread_delivered_owner(registry, &request),
        };
    }
    if matches!(&ownership, MonadMessageOwnership::Missing)
        && request.stamp_payments.len() > config.limits.max_members
    {
        return Err(ProcessMonadMessageError::TooManyStampPayments {
            actual: request.stamp_payments.len(),
            maximum: config.limits.max_members,
        });
    }

    let legacy_owned = matches!(&ownership, MonadMessageOwnership::LegacyExact(_));

    let policy = match ownership {
        MonadMessageOwnership::LegacyExact(legacy) => {
            let routing = routing_from_claimed_envelope(&request.encrypted_payload)
                .map_err(|err| ProcessMonadMessageError::LegacyExactRetained(Box::new(err)))?;
            MonadOutboxPolicy::new(
                routing.recipient,
                legacy.recipient_pubkey,
                legacy.min_value_wei,
                legacy
                    .network_tag
                    .or(routing.network_tag)
                    .unwrap_or_default(),
            )
            .map_err(|err| {
                ProcessMonadMessageError::LegacyExactRetained(Box::new(
                    ProcessMonadMessageError::InvalidEnvelope(err.to_string()),
                ))
            })?
        }
        MonadMessageOwnership::Missing => {
            let recipient = validate_envelope(&request.encrypted_payload, network_tag)?.recipient;
            let profile = registry
                .get_monad_profile(recipient)
                .map_err(ProcessMonadMessageError::Infrastructure)?
                .ok_or(ProcessMonadMessageError::RecipientProfileNotFound(
                    recipient,
                ))?;
            MonadOutboxPolicy::new(
                recipient,
                profile.pubkey,
                min_value_wei,
                network_tag.to_vec(),
            )
            .map_err(|err| ProcessMonadMessageError::InvalidEnvelope(err.to_string()))?
        }
        MonadMessageOwnership::Conflict
        | MonadMessageOwnership::DeliveredExact(_)
        | MonadMessageOwnership::OutboxExact(_) => unreachable!("handled above"),
    };
    let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().expect("checked");
    validate_payment_set(&request, payload_hash, &policy, config.expected_chain_id).map_err(
        |err| {
            if legacy_owned {
                ProcessMonadMessageError::LegacyExactRetained(Box::new(err))
            } else {
                err
            }
        },
    )?;
    match registry
        .claim_monad_outbox(&request, &policy, now_ms(), &config.limits)
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadOutboxClaim::Conflict => return Err(ProcessMonadMessageError::ConflictingPaymentSet),
        MonadOutboxClaim::AtCapacity => return Err(ProcessMonadMessageError::OutboxAtCapacity),
        MonadOutboxClaim::AtCapacityExactLegacy => {
            return Err(ProcessMonadMessageError::OutboxAtCapacityExactLegacy)
        }
        MonadOutboxClaim::New | MonadOutboxClaim::ExistingExact(_) => {}
    }
    match reconcile_monad_outbox_with_permits(
        transport,
        registry,
        declared_hash.as_slice(),
        config,
        permits,
    )
    .await
    {
        Err(err) => classify_after_reconcile_error(registry, &request, err),
        Ok(MonadOutboxReconcileOutcome::Delivered(stored)) => Ok(stored),
        Ok(MonadOutboxReconcileOutcome::Pending) => Err(ProcessMonadMessageError::OutboxPending),
        Ok(MonadOutboxReconcileOutcome::Terminal(terminal)) => {
            Err(terminal_process_error(registry, &request, terminal))
        }
        Ok(MonadOutboxReconcileOutcome::Missing) => reread_delivered_owner(registry, &request),
    }
}

/// JSON error body for a rejected `PUT`/`GET /message/monad` request.
#[derive(Debug, Serialize)]
struct MonadMessageErrorBody {
    error: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exact_set_retained: Option<bool>,
}

/// Error type for [`handle_put_monad_message`].
#[derive(Debug)]
pub enum PutMonadMessageError {
    /// The bounded request body is not a valid or admissible Monad message protobuf.
    Decode(String),
    /// The semantic message decoded, but its protobuf wire bytes are not canonical.
    NoncanonicalProtobuf {
        /// Whether normalized semantic ownership was already durable at lookup time.
        retained: bool,
    },
    /// `admit_monad_message` rejected (or failed to process) the message.
    Process(ProcessMonadMessageError),
}

fn exact_set_retained(err: &ProcessMonadMessageError) -> Option<bool> {
    match err {
        ProcessMonadMessageError::Rejected(_)
        | ProcessMonadMessageError::RelayTimedOut
        | ProcessMonadMessageError::OutboxPending
        | ProcessMonadMessageError::OutboxAtCapacityExactLegacy
        | ProcessMonadMessageError::LegacyExactRetained(_) => Some(true),
        ProcessMonadMessageError::RejectedWithoutRetainedSet(_) => Some(false),
        ProcessMonadMessageError::OutboxTerminal { retained, .. } => Some(*retained),
        ProcessMonadMessageError::PaymentSetBusy | ProcessMonadMessageError::RelayBusy => None,
        _ => Some(false),
    }
}

impl IntoResponse for PutMonadMessageError {
    fn into_response(self) -> Response {
        match self {
            PutMonadMessageError::Process(ProcessMonadMessageError::Infrastructure(err)) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "infrastructure failure processing Monad-stamped message"
                );
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(MonadMessageErrorBody {
                        error: "mailbox_retryable",
                        detail: "mailbox infrastructure is temporarily unavailable".to_string(),
                        // A storage failure can happen on either side of the atomic claim, so the
                        // response must not assert whether this exact set was retained.
                        exact_set_retained: None,
                    }),
                )
                    .into_response()
            }
            PutMonadMessageError::Process(
                err @ (ProcessMonadMessageError::OutboxAtCapacity
                | ProcessMonadMessageError::OutboxAtCapacityExactLegacy
                | ProcessMonadMessageError::OutboxPending
                | ProcessMonadMessageError::OutboxUnavailable
                | ProcessMonadMessageError::RelayBusy
                | ProcessMonadMessageError::RelayTimedOut),
            ) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(MonadMessageErrorBody {
                    error: "mailbox_retryable",
                    detail: err.to_string(),
                    exact_set_retained: exact_set_retained(&err),
                }),
            )
                .into_response(),
            PutMonadMessageError::Process(
                err @ ProcessMonadMessageError::ConflictingPaymentSet,
            ) => (
                StatusCode::CONFLICT,
                Json(MonadMessageErrorBody {
                    error: "mailbox_conflict",
                    detail: err.to_string(),
                    // The caller-provided set is not the durable owner. Wallets must release any
                    // reservation for these bytes rather than treating another owner's claim as
                    // retention of this request.
                    exact_set_retained: Some(false),
                }),
            )
                .into_response(),
            PutMonadMessageError::Process(
                err @ ProcessMonadMessageError::OutboxTerminal { retained, .. },
            ) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(MonadMessageErrorBody {
                    error: "mailbox_terminal",
                    detail: err.to_string(),
                    exact_set_retained: Some(retained),
                }),
            )
                .into_response(),
            PutMonadMessageError::Decode(detail) => (
                StatusCode::BAD_REQUEST,
                Json(MonadMessageErrorBody {
                    error: "invalid_monad_message",
                    detail,
                    exact_set_retained: Some(false),
                }),
            )
                .into_response(),
            PutMonadMessageError::NoncanonicalProtobuf { retained } => (
                StatusCode::BAD_REQUEST,
                Json(MonadMessageErrorBody {
                    error: "noncanonical_protobuf",
                    detail: "noncanonical Monad message protobuf".to_string(),
                    exact_set_retained: Some(retained),
                }),
            )
                .into_response(),
            PutMonadMessageError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadMessageErrorBody {
                    error: "invalid_monad_message",
                    detail: err.to_string(),
                    exact_set_retained: exact_set_retained(&err),
                }),
            )
                .into_response(),
        }
    }
}

fn read_varint(bytes: &[u8], position: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes
            .get(*position)
            .ok_or_else(|| "truncated protobuf varint".to_string())?;
        *position += 1;
        if shift == 63 && byte > 1 {
            return Err("protobuf varint overflow".to_string());
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("protobuf varint overflow".to_string())
}

/// Count repeated payment messages without asking prost to allocate an attacker-sized vector.
fn validate_payment_wire_cardinality(bytes: &[u8]) -> Result<(), String> {
    let mut position = 0usize;
    let mut payments = 0usize;
    while position < bytes.len() {
        let key = read_varint(bytes, &mut position)?;
        let field = key >> 3;
        let wire = key & 7;
        if field == 4 {
            payments += 1;
            if payments > MAX_STAMP_PAYMENTS {
                return Err(format!(
                    "too many stamp payments: {payments} (maximum {MAX_STAMP_PAYMENTS})"
                ));
            }
        }
        match wire {
            0 => {
                read_varint(bytes, &mut position)?;
            }
            1 => position = position.saturating_add(8),
            2 => {
                let length = read_varint(bytes, &mut position)? as usize;
                position = position.saturating_add(length);
            }
            5 => position = position.saturating_add(4),
            _ => return Err(format!("unsupported protobuf wire type {wire}")),
        }
        if position > bytes.len() {
            return Err("truncated protobuf field".to_string());
        }
    }
    Ok(())
}

/// `PUT /message/monad`: Legacy protobuf DM transport (deprecated in favor of canonical CBOR
/// `/message/monad/cbor`). Decodes a [`proto::MonadStampedMessage`], recovers its sender, verifies its
/// Monad stamp (broadcasting it, per ticket #19), and stores it on success.
#[deprecated(
    note = "Legacy protobuf DM transport; canonical CBOR (/message/monad/cbor) is the active path"
)]
pub async fn handle_put_monad_message(
    BoundedProtobufBody(body): BoundedProtobufBody<MAX_MONAD_MESSAGE_BODY_BYTES>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessage>, PutMonadMessageError> {
    validate_payment_wire_cardinality(&body).map_err(PutMonadMessageError::Decode)?;
    let message = proto::MonadStampedMessage::decode(body.as_slice())
        .map_err(|err| PutMonadMessageError::Decode(err.to_string()))?;
    if message.encode_to_vec() != body {
        let Ok(payload_hash): Result<[u8; 32], _> = message.payload_hash.as_slice().try_into()
        else {
            return Err(PutMonadMessageError::NoncanonicalProtobuf { retained: false });
        };
        if Sha256::digest(message.encrypted_payload.clone().into()).as_slice() != payload_hash {
            return Err(PutMonadMessageError::NoncanonicalProtobuf { retained: false });
        }
        return match server
            .registry
            .classify_monad_message_ownership(&message)
            .map_err(|err| {
                PutMonadMessageError::Process(ProcessMonadMessageError::Infrastructure(err))
            })? {
            MonadMessageOwnership::DeliveredExact(_)
            | MonadMessageOwnership::OutboxExact(_)
            | MonadMessageOwnership::LegacyExact(_) => {
                Err(PutMonadMessageError::NoncanonicalProtobuf { retained: true })
            }
            MonadMessageOwnership::Conflict => Err(PutMonadMessageError::Process(
                ProcessMonadMessageError::ConflictingPaymentSet,
            )),
            MonadMessageOwnership::Missing => {
                Err(PutMonadMessageError::NoncanonicalProtobuf { retained: false })
            }
        };
    }
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .expect("disabled mailbox has no PUT route");
    let stored = admit_monad_message(
        runtime.transport(),
        &server.registry,
        runtime.reconcile(),
        runtime.outbox_permits(),
        runtime.min_value_wei(),
        runtime.network_tag(),
        message,
    )
    .await
    .map_err(PutMonadMessageError::Process)?;
    Ok(Protobuf(stored))
}

#[derive(Debug, Serialize)]
pub(crate) struct MailboxChallengeBody {
    epoch: String,
    nonce: String,
    expires_at_ms: i64,
    token: String,
    signing_domain: &'static str,
    resource: &'static str,
    since: i64,
    cursor: Option<String>,
    limit: usize,
    max_bytes: usize,
    network_tag: String,
    recovery_payload_hash: Option<String>,
    recovery_obligation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConfirmedPrefixBody {
    payload_hash: String,
    obligation_id: String,
    canonical_message: String,
    confirmed_children: Vec<u32>,
    lifecycle: String,
}

fn recovery_lifecycle(lifecycle: MonadOutboxLifecycle) -> String {
    match lifecycle {
        MonadOutboxLifecycle::Pending => "pending".to_string(),
        MonadOutboxLifecycle::FullyConfirmed => "fully_confirmed".to_string(),
        MonadOutboxLifecycle::Delivered => "delivered".to_string(),
        MonadOutboxLifecycle::Terminal(reason) => format!(
            "terminal:{}",
            match reason {
                MonadOutboxTerminal::StaleNonce => "stale_nonce",
                MonadOutboxTerminal::VerificationFailed => "verification_failed",
                MonadOutboxTerminal::BroadcastRejected => "broadcast_rejected",
                MonadOutboxTerminal::CorruptReference => "corrupt_reference",
                MonadOutboxTerminal::InsufficientTotal => "insufficient_total",
                MonadOutboxTerminal::Expired => "expired",
                MonadOutboxTerminal::AttemptsExhausted => "attempts_exhausted",
            }
        ),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct PrivateInboxQuery {
    since: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PrivateRecoveryQuery {
    cursor: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PrivateChallengeQuery {
    resource: String,
    since: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
    recovery_payload_hash: Option<String>,
    recovery_obligation_id: Option<String>,
}

#[derive(Debug)]
pub(crate) enum PrivateMailboxError {
    Unauthorized,
    InvalidRecipient,
    InvalidLimit,
    StaleCursor,
    RecordTooLarge,
    AtCapacity,
    /// The recipient already holds the maximum number of live consumed challenges. Distinct from
    /// an authentication failure so a well-behaved client backs off instead of re-authenticating.
    ChallengeCapacity,
    RecoveryActive,
    Infrastructure(Report),
}

impl IntoResponse for PrivateMailboxError {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized | Self::InvalidRecipient => (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "mailbox_auth_failed"})),
            )
                .into_response(),
            Self::InvalidLimit => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid_mailbox_limit"})),
            )
                .into_response(),
            Self::StaleCursor => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid_mailbox_cursor"})),
            )
                .into_response(),
            Self::RecordTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({"error": "mailbox_record_exceeds_page_budget"})),
            )
                .into_response(),
            Self::AtCapacity => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "mailbox_auth_retryable"})),
            )
                .into_response(),
            Self::ChallengeCapacity => (
                StatusCode::TOO_MANY_REQUESTS,
                // Consumed challenges are retained until they expire, so capacity returns within
                // one challenge lifetime.
                [(
                    axum::http::header::RETRY_AFTER,
                    (CHALLENGE_TTL_MS / 1000).to_string(),
                )],
                Json(serde_json::json!({"error": "mailbox_challenge_capacity"})),
            )
                .into_response(),
            Self::RecoveryActive => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": "recovery_obligation_is_active"})),
            )
                .into_response(),
            Self::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "private mailbox infrastructure failure");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

fn private_limit(requested: Option<usize>, default: usize) -> Result<usize, PrivateMailboxError> {
    let limit = requested.unwrap_or(default);
    if limit == 0 || limit > MAX_PRIVATE_MAILBOX_PAGE {
        return Err(PrivateMailboxError::InvalidLimit);
    }
    Ok(limit)
}

fn private_max_bytes(requested: Option<usize>) -> Result<usize, PrivateMailboxError> {
    let max_bytes = requested.unwrap_or(DEFAULT_PRIVATE_MAILBOX_RESPONSE_BYTES);
    if max_bytes == 0 || max_bytes > MAX_PRIVATE_MAILBOX_RESPONSE_BYTES {
        return Err(PrivateMailboxError::InvalidLimit);
    }
    Ok(max_bytes)
}

fn private_since(requested: Option<i64>) -> Result<i64, PrivateMailboxError> {
    let since = requested.unwrap_or(0);
    if since < 0 {
        return Err(PrivateMailboxError::InvalidLimit);
    }
    Ok(since)
}

fn parse_private_recipient(value: &str) -> Result<Address, PrivateMailboxError> {
    Address::from_hex(value).map_err(|_| PrivateMailboxError::InvalidRecipient)
}

fn parse_recovery_payload_hash(value: &str) -> Result<[u8; 32], PrivateMailboxError> {
    if value.len() != 64 {
        return Err(PrivateMailboxError::InvalidLimit);
    }
    let mut payload_hash = [0; 32];
    hex::decode_to_slice(value, &mut payload_hash)
        .map_err(|_| PrivateMailboxError::InvalidLimit)?;
    Ok(payload_hash)
}

pub(crate) fn mailbox_auth_preimage(
    challenge: MailboxChallenge,
    binding: &MailboxRequestBinding,
    network_tag: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(224 + network_tag.len());
    bytes.extend_from_slice(MAILBOX_AUTH_DOMAIN.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&challenge.epoch);
    bytes.extend_from_slice(&challenge.nonce);
    bytes.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(&challenge.token);
    binding.append_canonical(&mut bytes);
    bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
    bytes.extend_from_slice(network_tag);
    bytes
}

fn private_binding(
    server: &RegistryServer,
    recipient: Address,
    resource: MailboxResource,
    since: i64,
    cursor: Option<&str>,
    limit: usize,
    max_bytes: usize,
    recovery_payload_hash: Option<[u8; 32]>,
    recovery_obligation_id: Option<[u8; 32]>,
) -> Result<MailboxRequestBinding, PrivateMailboxError> {
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let cursor = cursor
        .map(|token| {
            runtime
                .decode_cursor(recipient, resource, token)
                .map(|position| MailboxCursorBinding {
                    position,
                    token: token.to_string(),
                })
                .ok_or(PrivateMailboxError::Unauthorized)
        })
        .transpose()?;
    Ok(MailboxRequestBinding {
        resource,
        recipient,
        since,
        cursor,
        limit,
        max_bytes,
        recovery_payload_hash,
        recovery_obligation_id,
    })
}

pub(crate) struct ParsedPrivateAuthentication {
    pub(crate) challenge: MailboxChallenge,
    pub(crate) signature: Vec<u8>,
}

fn parse_private_authentication(
    headers: &HeaderMap,
    server: &RegistryServer,
    binding: &MailboxRequestBinding,
) -> Result<ParsedPrivateAuthentication, PrivateMailboxError> {
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    parse_private_authentication_for_runtime(
        headers,
        runtime,
        binding,
        crate::monad_mailbox::MailboxNamespace::Legacy,
    )
}

pub(crate) fn parse_private_authentication_for_runtime(
    headers: &HeaderMap,
    runtime: &crate::monad_mailbox::EnabledMonadMailboxRuntime,
    binding: &MailboxRequestBinding,
    namespace: crate::monad_mailbox::MailboxNamespace,
) -> Result<ParsedPrivateAuthentication, PrivateMailboxError> {
    let parse_hex_header = |name: &'static str| -> Result<[u8; 32], PrivateMailboxError> {
        let value = headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or(PrivateMailboxError::Unauthorized)?;
        if value.len() != 64 {
            return Err(PrivateMailboxError::Unauthorized);
        }
        let mut decoded = [0u8; 32];
        hex::decode_to_slice(value, &mut decoded).map_err(|_| PrivateMailboxError::Unauthorized)?;
        Ok(decoded)
    };
    let epoch = parse_hex_header(MAILBOX_EPOCH_HEADER)?;
    let nonce = parse_hex_header(MAILBOX_NONCE_HEADER)?;
    let token = parse_hex_header(MAILBOX_TOKEN_HEADER)?;
    let expires_at_ms = headers
        .get(MAILBOX_EXPIRY_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let signature = headers
        .get(MAILBOX_SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(PrivateMailboxError::Unauthorized)?;
    if signature.len() % 2 != 0
        || signature.len() < MIN_ECDSA_DER_SIGNATURE_BYTES * 2
        || signature.len() > MAX_ECDSA_DER_SIGNATURE_BYTES * 2
    {
        return Err(PrivateMailboxError::Unauthorized);
    }
    let signature_len = signature.len() / 2;
    let mut signature_bytes = [0u8; MAX_ECDSA_DER_SIGNATURE_BYTES];
    hex::decode_to_slice(signature, &mut signature_bytes[..signature_len])
        .map_err(|_| PrivateMailboxError::Unauthorized)?;
    let challenge = MailboxChallenge {
        epoch,
        nonce,
        expires_at_ms,
        token,
    };
    let authentication_time = now_ms();
    if !runtime.verify_namespace_challenge(namespace, binding, challenge, authentication_time) {
        return Err(PrivateMailboxError::Unauthorized);
    }
    Ok(ParsedPrivateAuthentication {
        challenge,
        signature: signature_bytes[..signature_len].to_vec(),
    })
}

fn authenticate_private_recipient(
    parsed: ParsedPrivateAuthentication,
    server: &RegistryServer,
    binding: &MailboxRequestBinding,
) -> Result<(), PrivateMailboxError> {
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let authentication_time = now_ms();
    let digest = Sha256::digest(
        mailbox_auth_preimage(parsed.challenge, binding, runtime.network_tag()).into(),
    );
    let signature_valid = server
        .registry
        .verify_monad_recipient_signature(
            binding.recipient,
            digest.as_slice().try_into().expect("SHA256 is 32 bytes"),
            &parsed.signature,
        )
        .map_err(PrivateMailboxError::Infrastructure)?;
    if !signature_valid {
        return Err(PrivateMailboxError::Unauthorized);
    }
    let consumed = server
        .registry
        .consume_monad_mailbox_challenge(
            parsed.challenge.epoch,
            binding.recipient,
            parsed.challenge.nonce,
            parsed.challenge.expires_at_ms,
            authentication_time,
            MAX_USED_CHALLENGES_PER_RECIPIENT,
        )
        .map_err(PrivateMailboxError::Infrastructure)?;
    match consumed {
        ChallengeConsumption::Consumed => Ok(()),
        ChallengeConsumption::Rejected => Err(PrivateMailboxError::Unauthorized),
        ChallengeConsumption::AtCapacity => Err(PrivateMailboxError::ChallengeCapacity),
    }
}

/// Issue a stateless server-authenticated challenge without revealing recipient registration.
pub(crate) async fn handle_issue_mailbox_challenge(
    Path(recipient): Path<String>,
    Query(params): Query<PrivateChallengeQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Json<MailboxChallengeBody>, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let requested_since = private_since(params.since)?;
    let (resource, default_limit, since, recovery_payload_hash, recovery_obligation_id) =
        match params.resource.as_str() {
            "inbox"
                if params.recovery_payload_hash.is_none()
                    && params.recovery_obligation_id.is_none() =>
            {
                (MailboxResource::Inbox, 50, requested_since, None, None)
            }
            "recovery"
                if requested_since == 0
                    && params.recovery_payload_hash.is_none()
                    && params.recovery_obligation_id.is_none() =>
            {
                (MailboxResource::Recovery, 20, 0, None, None)
            }
            "recovery_ack"
                if requested_since == 0
                    && params.cursor.is_none()
                    && params.limit.is_none()
                    && params.max_bytes.is_none() =>
            {
                let payload_hash = params
                    .recovery_payload_hash
                    .as_deref()
                    .and_then(|value| {
                        let mut decoded = [0; 32];
                        (value.len() == 64)
                            .then(|| hex::decode_to_slice(value, &mut decoded).ok())
                            .flatten()
                            .map(|()| decoded)
                    })
                    .ok_or(PrivateMailboxError::InvalidLimit)?;
                let obligation_id = params
                    .recovery_obligation_id
                    .as_deref()
                    .and_then(|value| {
                        let mut decoded = [0; 32];
                        (value.len() == 64)
                            .then(|| hex::decode_to_slice(value, &mut decoded).ok())
                            .flatten()
                            .map(|()| decoded)
                    })
                    .ok_or(PrivateMailboxError::InvalidLimit)?;
                (
                    MailboxResource::RecoveryAck,
                    1,
                    0,
                    Some(payload_hash),
                    Some(obligation_id),
                )
            }
            _ => return Err(PrivateMailboxError::InvalidLimit),
        };
    let limit = if resource == MailboxResource::RecoveryAck {
        1
    } else {
        private_limit(params.limit, default_limit)?
    };
    let max_bytes = if resource == MailboxResource::RecoveryAck {
        0
    } else {
        private_max_bytes(params.max_bytes)?
    };
    let binding = private_binding(
        &server,
        recipient,
        resource,
        since,
        params.cursor.as_deref(),
        limit,
        max_bytes,
        recovery_payload_hash,
        recovery_obligation_id,
    )?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let challenge = runtime.issue_challenge(&binding, now_ms());
    Ok(Json(MailboxChallengeBody {
        epoch: hex::encode(challenge.epoch),
        nonce: hex::encode(challenge.nonce),
        expires_at_ms: challenge.expires_at_ms,
        token: hex::encode(challenge.token),
        signing_domain: MAILBOX_AUTH_DOMAIN,
        resource: match resource {
            MailboxResource::Inbox => "inbox",
            MailboxResource::Recovery => "recovery",
            MailboxResource::RecoveryAck => "recovery_ack",
        },
        since,
        cursor: params.cursor,
        limit,
        max_bytes,
        network_tag: hex::encode(runtime.network_tag()),
        recovery_payload_hash: recovery_payload_hash.map(hex::encode),
        recovery_obligation_id: recovery_obligation_id.map(hex::encode),
    }))
}

/// Return one authenticated, recipient-scoped, capped inbox page.
pub(crate) async fn handle_get_private_monad_messages(
    Path(recipient): Path<String>,
    Query(params): Query<PrivateInboxQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Result<Response, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let since = private_since(params.since)?;
    let limit = private_limit(params.limit, 50)?;
    let max_bytes = private_max_bytes(params.max_bytes)?;
    let binding = private_binding(
        &server,
        recipient,
        MailboxResource::Inbox,
        since,
        params.cursor.as_deref(),
        limit,
        max_bytes,
        None,
        None,
    )?;
    let authentication = parse_private_authentication(&headers, &server, &binding)?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let _read_permit = runtime
        .try_acquire_private_read()
        .ok_or(PrivateMailboxError::AtCapacity)?;
    authenticate_private_recipient(authentication, &server, &binding)?;
    let cursor = match binding.cursor.as_ref().map(|cursor| cursor.position) {
        Some(MailboxCursor::Inbox {
            timestamp,
            payload_hash,
        }) => Some(RecipientMessageCursor {
            timestamp,
            payload_hash,
        }),
        Some(MailboxCursor::Recovery { .. }) => return Err(PrivateMailboxError::Unauthorized),
        None => None,
    };
    let page = server
        .registry
        .list_monad_messages_for_recipient_since_capped(recipient, since, cursor, limit, max_bytes)
        .map_err(map_private_store_error)?;
    debug_assert!(page.encoded_bytes <= max_bytes);
    let mut response = Protobuf(proto::StoredMonadMessages {
        messages: page.messages,
    })
    .into_response();
    if let Some(cursor) = page.next_cursor {
        let encoded = runtime.encode_cursor(
            recipient,
            MailboxCursor::Inbox {
                timestamp: cursor.timestamp,
                payload_hash: cursor.payload_hash,
            },
        );
        response.headers_mut().insert(
            MAILBOX_NEXT_CURSOR_HEADER,
            HeaderValue::from_str(&encoded).expect("hex cursor is a valid header"),
        );
    }
    Ok(response)
}

/// Return authenticated confirmed-prefix recovery facts for one recipient.
pub(crate) async fn handle_get_private_monad_recovery(
    Path(recipient): Path<String>,
    Query(params): Query<PrivateRecoveryQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Result<Response, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let limit = private_limit(params.limit, 20)?;
    let max_bytes = private_max_bytes(params.max_bytes)?;
    let binding = private_binding(
        &server,
        recipient,
        MailboxResource::Recovery,
        0,
        params.cursor.as_deref(),
        limit,
        max_bytes,
        None,
        None,
    )?;
    let authentication = parse_private_authentication(&headers, &server, &binding)?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let _read_permit = runtime
        .try_acquire_private_read()
        .ok_or(PrivateMailboxError::AtCapacity)?;
    authenticate_private_recipient(authentication, &server, &binding)?;
    let cursor = match binding.cursor.as_ref().map(|cursor| cursor.position) {
        Some(MailboxCursor::Recovery { payload_hash }) => Some(payload_hash),
        Some(MailboxCursor::Inbox { .. }) => return Err(PrivateMailboxError::Unauthorized),
        None => None,
    };
    // Recovery JSON hex-encodes canonical protobuf bytes. Limiting materialized protobuf to half
    // the response budget bounds both DB work and the larger JSON representation.
    let page = server
        .registry
        .confirmed_monad_outbox_prefixes_page(
            recipient,
            cursor,
            limit,
            MAX_PRIVATE_RECOVERY_SCAN,
            max_bytes / PRIVATE_RECOVERY_CANONICAL_BUDGET_DIVISOR,
            max_bytes / PRIVATE_RECOVERY_WORK_BUDGET_DIVISOR,
        )
        .map_err(map_private_store_error)?;
    debug_assert!(page.scanned <= MAX_PRIVATE_RECOVERY_SCAN);
    debug_assert!(page.canonical_bytes <= max_bytes / PRIVATE_RECOVERY_CANONICAL_BUDGET_DIVISOR);
    // The work meter includes one bounded record/member lookahead used to discover overflow, so
    // it may exceed the half-budget while the omitted row remains reachable from the cursor.
    for recovery in &page.recoveries {
        crate::monad_outbox::validate_monad_recovery_record(recovery, runtime.expected_chain_id())
            .map_err(PrivateMailboxError::Infrastructure)?;
    }
    let recoveries = page
        .recoveries
        .into_iter()
        .map(|recovery| ConfirmedPrefixBody {
            payload_hash: hex::encode(recovery.payload_hash),
            obligation_id: hex::encode(recovery.obligation_id),
            canonical_message: hex::encode(recovery.message.encode_to_vec()),
            confirmed_children: recovery
                .confirmed_prefix
                .into_iter()
                .map(|member| member.child_index)
                .collect(),
            lifecycle: recovery_lifecycle(recovery.lifecycle),
        })
        .collect::<Vec<_>>();
    let mut encoded_recoveries = recoveries
        .iter()
        .map(|recovery| {
            serde_json::to_vec(recovery)
                .map_err(|err| PrivateMailboxError::Infrastructure(err.into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let hashes = recoveries
        .iter()
        .map(|recovery| {
            hex::decode(&recovery.payload_hash)
                .expect("recovery payload hash was encoded locally")
                .try_into()
                .expect("recovery payload hash is 32 bytes")
        })
        .collect::<Vec<[u8; 32]>>();
    let mut next_hash = page.next_cursor;
    let cursor_len = runtime
        .encode_cursor(
            recipient,
            MailboxCursor::Recovery {
                payload_hash: [0; 32],
            },
        )
        .len();
    let mut records_len = encoded_recoveries.iter().map(Vec::len).sum::<usize>();
    while recovery_json_size(
        records_len,
        encoded_recoveries.len(),
        next_hash.is_some(),
        cursor_len,
    ) > max_bytes
    {
        if encoded_recoveries.len() <= 1 {
            return Err(PrivateMailboxError::RecordTooLarge);
        }
        records_len -= encoded_recoveries.pop().expect("length checked").len();
        next_hash = Some(hashes[encoded_recoveries.len() - 1]);
    }
    let next_cursor = next_hash.map(|payload_hash| {
        runtime.encode_cursor(recipient, MailboxCursor::Recovery { payload_hash })
    });
    let body = encode_recovery_json(&encoded_recoveries, next_cursor.as_deref());
    debug_assert!(body.len() <= max_bytes);
    let mut response = (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response();
    if let Some(cursor) = next_cursor {
        response.headers_mut().insert(
            MAILBOX_NEXT_CURSOR_HEADER,
            HeaderValue::from_str(&cursor).expect("hex cursor is a valid header"),
        );
    }
    Ok(response)
}

/// Retire one exact terminal recovery obligation after the recipient has durably imported it.
pub(crate) async fn handle_ack_private_monad_recovery(
    Path((recipient, payload_hash, obligation_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Result<Response, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let payload_hash = parse_recovery_payload_hash(&payload_hash)?;
    let obligation_id = parse_recovery_payload_hash(&obligation_id)?;
    let binding = private_binding(
        &server,
        recipient,
        MailboxResource::RecoveryAck,
        0,
        None,
        1,
        0,
        Some(payload_hash),
        Some(obligation_id),
    )?;
    let authentication = parse_private_authentication(&headers, &server, &binding)?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let _read_permit = runtime
        .try_acquire_private_read()
        .ok_or(PrivateMailboxError::AtCapacity)?;
    authenticate_private_recipient(authentication, &server, &binding)?;
    match server
        .registry
        .acknowledge_monad_outbox_recovery(recipient, &payload_hash, &obligation_id)
        .map_err(PrivateMailboxError::Infrastructure)?
    {
        // An authenticated recipient learns nothing about obligations it does not own: a wrong
        // recipient, an absent obligation, and a stale obligation id are one outward status.
        MonadRecoveryAck::Acknowledged
        | MonadRecoveryAck::Absent
        | MonadRecoveryAck::WrongRecipient => Ok(StatusCode::NO_CONTENT.into_response()),
        MonadRecoveryAck::Active => Err(PrivateMailboxError::RecoveryActive),
    }
}

fn recovery_json_size(
    records_len: usize,
    records: usize,
    has_cursor: bool,
    cursor_len: usize,
) -> usize {
    b"{\"recoveries\":[".len()
        + records_len
        + records.saturating_sub(1)
        + b"]".len()
        + if has_cursor {
            b",\"next_cursor\":\"\"}".len() + cursor_len
        } else {
            b"}".len()
        }
}

fn encode_recovery_json(records: &[Vec<u8>], next_cursor: Option<&str>) -> Vec<u8> {
    let records_len = records.iter().map(Vec::len).sum::<usize>();
    let mut body = Vec::with_capacity(recovery_json_size(
        records_len,
        records.len(),
        next_cursor.is_some(),
        next_cursor.map_or(0, str::len),
    ));
    body.extend_from_slice(b"{\"recoveries\":[");
    for (index, record) in records.iter().enumerate() {
        if index != 0 {
            body.push(b',');
        }
        body.extend_from_slice(record);
    }
    body.push(b']');
    if let Some(cursor) = next_cursor {
        body.extend_from_slice(b",\"next_cursor\":\"");
        body.extend_from_slice(cursor.as_bytes());
        body.push(b'\"');
    }
    body.push(b'}');
    body
}

fn map_private_store_error(err: Report) -> PrivateMailboxError {
    use crate::store::{monad_messages::DbMonadMessagesError, monad_outbox::DbMonadOutboxError};

    if matches!(
        err.downcast_ref::<DbMonadMessagesError>(),
        Some(DbMonadMessagesError::StalePrivateCursor)
    ) {
        PrivateMailboxError::StaleCursor
    } else if matches!(
        err.downcast_ref::<DbMonadMessagesError>(),
        Some(DbMonadMessagesError::RecordExceedsPageBudget { .. })
    ) || matches!(
        err.downcast_ref::<DbMonadOutboxError>(),
        Some(DbMonadOutboxError::RecoveryRecordExceedsPageBudget { .. })
    ) {
        PrivateMailboxError::RecordTooLarge
    } else {
        PrivateMailboxError::Infrastructure(err)
    }
}

/// Query parameters for [`handle_list_monad_messages`].
#[cfg(test)]
#[derive(Debug, Deserialize)]
pub(crate) struct ListMonadMessagesQuery {
    /// Only return messages stored at or after this many milliseconds since the Unix epoch.
    /// Defaults to `0` (i.e. every stored message) when omitted.
    since: Option<i64>,
}

/// Error type for [`handle_list_monad_messages`].
#[cfg(test)]
#[derive(Debug)]
pub(crate) enum ListMonadMessagesError {
    /// A storage-level error.
    Infrastructure(Report),
}

#[cfg(test)]
impl IntoResponse for ListMonadMessagesError {
    fn into_response(self) -> Response {
        match self {
            ListMonadMessagesError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure listing Monad messages");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad?since=<timestamp>`: list every [`proto::StoredMonadMessage`] stored at or
/// after `since` (milliseconds since the Unix epoch), ordered by `timestamp` ascending (ticket
/// #37). This is the message-discovery route: a recipient can poll it with an advancing cursor
/// (the highest `timestamp` it's already seen, plus one) to find new messages without already
/// knowing their `payload_hash` out of band. See this module's docs for why it can't additionally
/// filter by intended recipient (no such field exists on the wire format yet).
#[cfg(test)]
pub(crate) async fn handle_list_monad_messages(
    Query(params): Query<ListMonadMessagesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessages>, ListMonadMessagesError> {
    let since = params.since.unwrap_or(0);
    let messages = server
        .registry
        .list_monad_messages_since(since)
        .map_err(ListMonadMessagesError::Infrastructure)?;
    Ok(Protobuf(proto::StoredMonadMessages { messages }))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::{ecc::Ecc, Net};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use prost::Message;
    use serde_json::Value;
    use tempdir::TempDir;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        monad_evm_tx::test_support::signed_eip1559_tx, monad_http::MonadRpcError, store::db::Db,
    };
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};

    #[test]
    fn rejects_more_than_64_payment_fields_before_protobuf_decode() {
        // Field 4, length-delimited, empty nested message. Prost would allocate one vector entry
        // for each occurrence; the wire scanner must reject the 65th first.
        let bytes = [0x22, 0x00].repeat(MAX_STAMP_PAYMENTS + 1);
        assert!(validate_payment_wire_cardinality(&bytes)
            .unwrap_err()
            .contains("too many stamp payments"));
        assert!(
            validate_payment_wire_cardinality(&[0x22, 0x00].repeat(MAX_STAMP_PAYMENTS)).is_ok()
        );
    }

    /// [`ChainAdapter`] stub: `admit_monad_message`/`Registry::put_monad_message` never touch
    /// `Registry::chain_adapter` (see this module's docs on why the Monad path bypasses it
    /// entirely), so this only exists to satisfy `Registry::new`'s constructor and is never
    /// actually called.
    #[derive(Debug)]
    struct UnusedChainAdapter;

    #[async_trait]
    impl ChainAdapter for UnusedChainAdapter {
        async fn submit_tx(&self, _raw_tx: &[u8]) -> bitcoinsuite_error::Result<SubmitTxOutcome> {
            unimplemented!("not used by the Monad message path")
        }
        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            unimplemented!("not used by the Monad message path")
        }
        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<MempoolAcceptResult> {
            unimplemented!("not used by the Monad message path")
        }
        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            unimplemented!("not used by the Monad message path")
        }
        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<Sha256> {
            unimplemented!("not used by the Monad message path")
        }
    }

    fn test_registry() -> (TempDir, Registry) {
        let tempdir = TempDir::new("cashweb-registry--monad-message-route").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(UnusedChainAdapter), Net::Regtest);
        let ecc = EccSecp256k1::default();
        let seckey = recipient_seckey();
        let pubkey = ecc.derive_pubkey(&seckey);
        let profile_payload = proto::MonadProfile {
            timestamp: 1,
            ttl: 1_000_000,
            entries: vec![],
        }
        .encode_to_vec();
        let profile_hash = Sha256::digest(profile_payload.clone().into());
        registry
            .put_monad_profile(
                recipient_address(),
                cashweb_payload::proto::SignedPayload {
                    pubkey: pubkey.as_slice().to_vec(),
                    sig: ecc
                        .sign(&seckey, profile_hash.byte_array().clone())
                        .to_vec(),
                    sig_scheme: cashweb_payload::proto::signed_payload::SignatureScheme::Ecdsa
                        .into(),
                    payload: profile_payload,
                    payload_hash: profile_hash.as_slice().to_vec(),
                    burn_amount: 0,
                    burn_txs: vec![],
                },
            )
            .unwrap();
        (tempdir, registry)
    }

    fn recipient_seckey() -> bitcoinsuite_core::ecc::SecKey {
        EccSecp256k1::default()
            .seckey_from_array([0x55; 32])
            .unwrap()
    }

    fn recipient_address() -> Address {
        let ecc = EccSecp256k1::default();
        let pubkey = ecc.derive_pubkey(&recipient_seckey());
        crate::monad_evm_tx::address_from_uncompressed_pubkey(
            &ecc.serialize_pubkey_uncompressed(&pubkey),
        )
    }

    fn test_outbox_policy() -> MonadOutboxPolicy {
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        MonadOutboxPolicy::new(
            recipient_address(),
            recipient_pubkey.as_slice().to_vec(),
            10_000,
            b"MONT".to_vec(),
        )
        .unwrap()
    }

    fn stamp_destination_at(payload_hash: &Sha256, child_index: u32) -> Address {
        let pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        let child = crate::monad_stamp_stealth::derive_monad_stamp_child_public(
            payload_hash.as_slice().try_into().unwrap(),
            pubkey.as_slice(),
            child_index,
        )
        .unwrap();
        Address(child.address)
    }

    fn stamp_destination(payload_hash: &Sha256) -> Address {
        stamp_destination_at(payload_hash, 0)
    }

    fn broadcast_burn_address() -> Address {
        Address([0xde; 20])
    }

    fn hex_addr(addr: Address) -> String {
        addr.to_hex()
    }

    fn valid_envelope(recipient: Address, network_tag: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "v": 2,
            "networkTag": network_tag,
            "from": "0x52908400098527886E0F7030069857D2E4169EE7",
            "to": recipient.to_hex(),
            "salt": "00".repeat(ENVELOPE_HKDF_SALT_BYTES),
            "nonce": "11".repeat(ENVELOPE_GCM_NONCE_BYTES),
            "ciphertext": "22",
            "tag": "33".repeat(ENVELOPE_GCM_TAG_BYTES),
            "futureField": "ignored",
        }))
        .unwrap()
    }

    fn envelope_with_field(base: &Value, name: &str, value: Value) -> Vec<u8> {
        let mut envelope = base.clone();
        envelope
            .as_object_mut()
            .expect("test envelope is an object")
            .insert(name.to_string(), value);
        serde_json::to_vec(&envelope).unwrap()
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    /// Production admission (`admit_monad_message`) under a fast, deterministic reconcile config.
    async fn admit_for_test<T: JsonRpcTransport + Clone>(
        transport: &T,
        registry: &Registry,
        min_value_wei: u128,
        network_tag: &[u8],
        request: proto::MonadStampedMessage,
    ) -> Result<proto::StoredMonadMessage, ProcessMonadMessageError> {
        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.poll_interval = std::time::Duration::from_millis(1);
        config.receipt_poll_attempts = 1;
        config.limits.retry_backoff_base = std::time::Duration::ZERO;
        config.limits.max_retry_backoff = std::time::Duration::ZERO;
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        admit_monad_message(
            transport,
            registry,
            &config,
            &permits,
            min_value_wei,
            network_tag,
            request,
        )
        .await
    }

    /// A node that confirms any transaction it is sent and knows nothing else, answering every
    /// lookup with that transaction's own hash, sender, destination, value and calldata (unlike
    /// `MockTransport`, whose canned bodies cannot satisfy the production exact-hash checks).
    #[derive(Clone, Default)]
    struct ChainTransport {
        confirmed: Arc<Mutex<HashMap<String, crate::monad_evm_tx::DecodedSignedTransaction>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl ChainTransport {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn sends(&self) -> usize {
            self.calls()
                .iter()
                .filter(|method| method.as_str() == "eth_sendRawTransaction")
                .count()
        }
    }

    impl fmt::Debug for ChainTransport {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("ChainTransport").finish()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for ChainTransport {
        async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            let requested = || params[0].as_str().unwrap().to_ascii_lowercase();
            match method {
                "eth_sendRawTransaction" => {
                    let raw = hex::decode(requested().trim_start_matches("0x")).unwrap();
                    let decoded = decode_signed_transaction(&raw).unwrap();
                    let hash = decoded.tx_hash.to_hex();
                    self.confirmed.lock().unwrap().insert(hash.clone(), decoded);
                    Ok(Value::String(hash))
                }
                "eth_getTransactionReceipt" => {
                    Ok(match self.confirmed.lock().unwrap().get(&requested()) {
                        None => Value::Null,
                        Some(tx) => serde_json::json!({
                            "transactionHash": tx.tx_hash.to_hex(),
                            "blockHash": hex_hash(0x22),
                            "blockNumber": "0x2a",
                            "from": tx.sender.to_hex(),
                            "to": tx.destination.map(|to| to.to_hex()),
                            "contractAddress": null,
                            "gasUsed": "0x5208",
                            "status": "0x1",
                            "logs": [],
                        }),
                    })
                }
                "eth_getTransactionByHash" => {
                    Ok(match self.confirmed.lock().unwrap().get(&requested()) {
                        None => Value::Null,
                        Some(tx) => serde_json::json!({
                            "hash": tx.tx_hash.to_hex(),
                            "to": tx.destination.map(|to| to.to_hex()),
                            "value": format!("0x{:x}", tx.value_wei),
                            "input": format!("0x{}", hex::encode(&tx.input)),
                            "from": tx.sender.to_hex(),
                        }),
                    })
                }
                other => Err(MonadRpcError::InvalidResponse {
                    method: other.to_string(),
                    reason: "unexpected method".to_string(),
                }),
            }
        }
    }

    fn signed_payment(
        seed: u8,
        payload_hash: &Sha256,
        child_index: u32,
        value_wei: u128,
    ) -> proto::MonadStampPayment {
        let sender = EccSecp256k1::default()
            .seckey_from_array([seed; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41_454,
            0,
            stamp_destination_at(payload_hash, child_index),
            value_wei,
            &commitment_calldata_bytes(payload_hash, child_index),
        );
        proto::MonadStampPayment {
            child_index,
            raw_tx,
        }
    }

    fn message_with_payments(
        encrypted_payload: Vec<u8>,
        payments: Vec<proto::MonadStampPayment>,
    ) -> proto::MonadStampedMessage {
        proto::MonadStampedMessage {
            payload_hash: Sha256::digest(encrypted_payload.clone().into())
                .as_slice()
                .to_vec(),
            encrypted_payload,
            stamp_payments: payments,
        }
    }

    const STMP_BROADCAST: [u8; 4] = *b"POND";

    fn commitment_calldata(payload_hash: &Sha256, child_index: u32) -> String {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP_BROADCAST);
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        let payload_hash: [u8; 32] = payload_hash.as_slice().try_into().unwrap();
        calldata.extend_from_slice(payment_commitment(&payload_hash, child_index).as_slice());
        format!("0x{}", hex::encode(calldata))
    }

    fn commitment_calldata_bytes(payload_hash: &Sha256, child_index: u32) -> Vec<u8> {
        hex::decode(commitment_calldata(payload_hash, child_index).trim_start_matches("0x"))
            .unwrap()
    }

    fn receipt_json(to: &str, status: &str) -> Value {
        serde_json::json!({
            "transactionHash": hex_hash(0x11),
            "blockHash": hex_hash(0x22),
            "blockNumber": "0x2a",
            "from": "0x3333333333333333333333333333333333333333",
            "to": to,
            "contractAddress": null,
            "gasUsed": "0x5208",
            "status": status,
            "logs": [],
        })
    }

    fn tx_json(to: &str, value_wei: u128, input_hex: &str) -> Value {
        serde_json::json!({
            "hash": hex_hash(0x11),
            "to": to,
            "value": format!("0x{:x}", value_wei),
            "input": input_hex,
            "from": "0x3333333333333333333333333333333333333333",
        })
    }

    #[derive(Clone, Default)]
    struct MockTransport {
        responses: Arc<Mutex<HashMap<String, Value>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl fmt::Debug for MockTransport {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("MockTransport").finish()
        }
    }

    #[derive(Clone, Debug, Default)]
    struct NeverReturnsTransport;

    #[async_trait]
    impl JsonRpcTransport for NeverReturnsTransport {
        async fn call(&self, _method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            std::future::pending().await
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            if method == "eth_sendRawTransaction" {
                return Ok(Value::String(hex_hash(0x11)));
            }
            self.responses
                .lock()
                .unwrap()
                .get(method)
                .cloned()
                .ok_or_else(|| MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured".to_string(),
                })
        }
    }

    fn make_message(raw_tx: Vec<u8>, encrypted_payload: Vec<u8>) -> proto::MonadStampedMessage {
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        proto::MonadStampedMessage {
            encrypted_payload,
            payload_hash,
            stamp_payments: vec![proto::MonadStampPayment {
                child_index: 0,
                raw_tx,
            }],
        }
    }

    fn valid_signed_message(ciphertext_byte: u8, signer_byte: u8) -> proto::MonadStampedMessage {
        valid_signed_message_with_members(ciphertext_byte, &[signer_byte])
    }

    fn valid_signed_message_with_members(
        ciphertext_byte: u8,
        signer_bytes: &[u8],
    ) -> proto::MonadStampedMessage {
        let mut envelope: Value =
            serde_json::from_slice(&valid_envelope(recipient_address(), "MONT")).unwrap();
        envelope["ciphertext"] = serde_json::json!(format!("{ciphertext_byte:02x}"));
        let encrypted_payload = serde_json::to_vec(&envelope).unwrap();
        let payload_hash = Sha256::digest(encrypted_payload.clone().into());
        let ecc = EccSecp256k1::default();
        let stamp_payments = signer_bytes
            .iter()
            .enumerate()
            .map(|(child_index, signer_byte)| {
                let sender = ecc.seckey_from_array([*signer_byte; 32]).unwrap();
                let (raw_tx, _) = signed_eip1559_tx(
                    &sender,
                    41_454,
                    0,
                    stamp_destination_at(&payload_hash, child_index as u32),
                    10_000,
                    &commitment_calldata_bytes(&payload_hash, child_index as u32),
                );
                proto::MonadStampPayment {
                    child_index: child_index as u32,
                    raw_tx,
                }
            })
            .collect();
        proto::MonadStampedMessage {
            encrypted_payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            stamp_payments,
        }
    }

    fn signed_message_for_envelope(
        encrypted_payload: Vec<u8>,
        signer_byte: u8,
        chain_id: u64,
    ) -> proto::MonadStampedMessage {
        let payload_hash = Sha256::digest(encrypted_payload.clone().into());
        let destination = stamp_destination(&payload_hash);
        let sender = EccSecp256k1::default()
            .seckey_from_array([signer_byte; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            chain_id,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&payload_hash, 0),
        );
        make_message(raw_tx, encrypted_payload)
    }

    fn append_varint(mut value: usize, out: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                return;
            }
        }
    }

    fn append_len_field(tag: u8, value: &[u8], out: &mut Vec<u8>) {
        out.push(tag);
        append_varint(value.len(), out);
        out.extend_from_slice(value);
    }

    fn reordered_message_wire(message: &proto::MonadStampedMessage) -> Vec<u8> {
        let mut body = Vec::new();
        append_len_field(0x1a, &message.payload_hash, &mut body);
        append_len_field(0x12, &message.encrypted_payload, &mut body);
        for payment in &message.stamp_payments {
            append_len_field(0x22, &payment.encode_to_vec(), &mut body);
        }
        body
    }

    fn message_wire_with_payment(
        message: &proto::MonadStampedMessage,
        payment_wire: &[u8],
        duplicate_payload: bool,
    ) -> Vec<u8> {
        let mut body = Vec::new();
        append_len_field(0x12, &message.encrypted_payload, &mut body);
        if duplicate_payload {
            append_len_field(0x12, &message.encrypted_payload, &mut body);
        }
        append_len_field(0x1a, &message.payload_hash, &mut body);
        append_len_field(0x22, payment_wire, &mut body);
        body
    }

    fn noncanonical_message_bodies(message: &proto::MonadStampedMessage) -> Vec<Vec<u8>> {
        let canonical = message.encode_to_vec();
        let mut unknown_field = canonical.clone();
        unknown_field.extend_from_slice(&[0x98, 0x06, 0x01]);
        let reordered = reordered_message_wire(message);
        let mut nonminimal_tag = canonical.clone();
        assert_eq!(nonminimal_tag[0], 0x12);
        nonminimal_tag.splice(0..1, [0x92, 0x00]);
        let mut nested_unknown_payment = message.stamp_payments[0].encode_to_vec();
        nested_unknown_payment.extend_from_slice(&[0x78, 0x01]);
        let nested_unknown = message_wire_with_payment(message, &nested_unknown_payment, false);
        let duplicate =
            message_wire_with_payment(message, &message.stamp_payments[0].encode_to_vec(), true);

        let bodies = vec![
            unknown_field,
            nested_unknown,
            duplicate,
            reordered,
            nonminimal_tag,
        ];
        for body in &bodies {
            assert_ne!(body, &canonical);
            assert_eq!(
                proto::MonadStampedMessage::decode(body.as_slice()).unwrap(),
                *message
            );
        }
        bodies
    }

    fn signed_private_headers(
        server: &RegistryServer,
        binding: &MailboxRequestBinding,
    ) -> HeaderMap {
        let runtime = server.monad_mailbox.as_enabled().unwrap();
        let challenge = runtime.issue_challenge(binding, now_ms());
        let digest =
            Sha256::digest(mailbox_auth_preimage(challenge, binding, runtime.network_tag()).into());
        let signature =
            EccSecp256k1::default().sign(&recipient_seckey(), digest.byte_array().clone());
        let mut headers = HeaderMap::new();
        headers.insert(
            MAILBOX_EPOCH_HEADER,
            hex::encode(challenge.epoch).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_NONCE_HEADER,
            hex::encode(challenge.nonce).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_EXPIRY_HEADER,
            challenge.expires_at_ms.to_string().parse().unwrap(),
        );
        headers.insert(
            MAILBOX_TOKEN_HEADER,
            hex::encode(challenge.token).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_SIGNATURE_HEADER,
            hex::encode(signature).parse().unwrap(),
        );
        headers
    }

    fn client_mailbox_auth_preimage(challenge: &Value, recipient: Address) -> Vec<u8> {
        let signing_domain = challenge["signing_domain"].as_str().unwrap();
        let resource = challenge["resource"].as_str().unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(signing_domain.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&hex::decode(challenge["epoch"].as_str().unwrap()).unwrap());
        bytes.extend_from_slice(&hex::decode(challenge["nonce"].as_str().unwrap()).unwrap());
        bytes.extend_from_slice(&challenge["expires_at_ms"].as_i64().unwrap().to_be_bytes());
        bytes.extend_from_slice(&hex::decode(challenge["token"].as_str().unwrap()).unwrap());
        match resource {
            "inbox" => {
                bytes.extend_from_slice(b"GET\0/message/monad/");
                bytes.extend_from_slice(b"inbox/");
                bytes.push(1);
            }
            "recovery" => {
                bytes.extend_from_slice(b"GET\0/message/monad/");
                bytes.extend_from_slice(b"recovery/");
                bytes.push(2);
            }
            "recovery_ack" => {
                bytes.extend_from_slice(b"POST\0/message/monad/");
                bytes.extend_from_slice(b"recovery-ack/");
                bytes.push(3);
            }
            other => panic!("unexpected public mailbox resource {other}"),
        }
        bytes.extend_from_slice(&recipient.0);
        bytes.extend_from_slice(&challenge["since"].as_i64().unwrap().to_be_bytes());
        if let Some(cursor) = challenge["cursor"].as_str() {
            bytes.push(1);
            bytes.extend_from_slice(&(cursor.len() as u32).to_be_bytes());
            bytes.extend_from_slice(cursor.as_bytes());
        } else {
            bytes.push(0);
        }
        bytes.extend_from_slice(&challenge["limit"].as_u64().unwrap().to_be_bytes());
        bytes.extend_from_slice(&challenge["max_bytes"].as_u64().unwrap().to_be_bytes());
        if resource == "recovery_ack" {
            bytes.extend_from_slice(
                &hex::decode(challenge["recovery_payload_hash"].as_str().unwrap()).unwrap(),
            );
            bytes.extend_from_slice(
                &hex::decode(challenge["recovery_obligation_id"].as_str().unwrap()).unwrap(),
            );
        }
        let network_tag = hex::decode(challenge["network_tag"].as_str().unwrap()).unwrap();
        bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&network_tag);
        bytes
    }

    fn signed_public_challenge_headers(challenge: &Value, preimage: &[u8]) -> HeaderMap {
        let digest = Sha256::digest(preimage.into());
        let signature =
            EccSecp256k1::default().sign(&recipient_seckey(), digest.byte_array().clone());
        let mut headers = HeaderMap::new();
        headers.insert(
            MAILBOX_EPOCH_HEADER,
            challenge["epoch"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert(
            MAILBOX_NONCE_HEADER,
            challenge["nonce"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert(
            MAILBOX_EXPIRY_HEADER,
            challenge["expires_at_ms"]
                .as_i64()
                .unwrap()
                .to_string()
                .parse()
                .unwrap(),
        );
        headers.insert(
            MAILBOX_TOKEN_HEADER,
            challenge["token"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert(
            MAILBOX_SIGNATURE_HEADER,
            hex::encode(signature).parse().unwrap(),
        );
        headers
    }

    fn persist_message(
        registry: &Registry,
        message: proto::MonadStampedMessage,
        network_tag: &[u8],
    ) -> proto::StoredMonadMessage {
        let payload_hash = message.payload_hash.clone();
        registry
            .put_monad_message(
                &payload_hash,
                recipient_address(),
                proto::StoredMonadMessage {
                    message: Some(message),
                    timestamp: 123,
                    network_tag: Vec::new(),
                },
                network_tag,
            )
            .unwrap()
    }

    #[tokio::test]
    async fn recipient_payment_is_accepted_and_stored() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MON1");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let message = message_with_payments(
            encrypted_payload,
            vec![signed_payment(0x77, &commitment, 0, 10_000)],
        );
        let transport = ChainTransport::default();

        let stored = admit_for_test(&transport, &registry, 10_000, b"MON1", message.clone())
            .await
            .expect("valid stamp should be accepted");

        assert_eq!(stored.message, Some(message.clone()));
        assert_eq!(stored.network_tag, b"MON1");
        let fetched = registry
            .get_monad_message(&message.payload_hash)
            .unwrap()
            .expect("message should be stored");
        assert_eq!(fetched, stored);
        assert_eq!(
            registry
                .list_monad_messages_for_recipient_since(recipient_address(), 0)
                .unwrap(),
            vec![stored.clone()],
            "the validated envelope recipient must own the mailbox index entry"
        );
        assert!(registry
            .list_monad_messages_for_recipient_since(Address([0x99; 20]), 0)
            .unwrap()
            .is_empty());

        let calls_after_first_submission = transport.calls().len();
        let retried = admit_for_test(&transport, &registry, 10_000, b"MONT", message.clone())
            .await
            .expect("an exact retry should return the already-stored message");
        assert_eq!(retried, stored);
        assert_eq!(
            transport.calls().len(),
            calls_after_first_submission,
            "an exact retry must not rebroadcast the payment"
        );

        let conflicting = message_with_payments(
            message.encrypted_payload.clone(),
            vec![signed_payment(0x78, &commitment, 0, 10_000)],
        );
        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", conflicting)
            .await
            .expect_err("a payload cannot be rebound to a different payment set");
        assert!(matches!(
            err,
            ProcessMonadMessageError::ConflictingPaymentSet
        ));
        assert_eq!(transport.calls().len(), calls_after_first_submission);
    }

    #[tokio::test]
    async fn distinct_payment_set_is_verified_and_summed() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let message = message_with_payments(
            encrypted_payload,
            vec![
                signed_payment(0x71, &commitment, 0, 4_000),
                signed_payment(0x72, &commitment, 1, 6_000),
            ],
        );
        let transport = ChainTransport::default();

        let stored = admit_for_test(&transport, &registry, 10_000, b"MONT", message.clone())
            .await
            .expect("the two distinct payments should satisfy the aggregate minimum");

        assert_eq!(stored.message, Some(message));
        assert_eq!(transport.sends(), 2);
    }

    /// The production minimum-stamp guard (`validate_payment_set`): a set below the relay's
    /// aggregate minimum is refused before any claim, RPC, or storage.
    #[tokio::test]
    async fn insufficient_stamp_value_is_rejected_before_claim_rpc_or_storage() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        // Pays only 500 wei, below the 10_000 wei minimum configured below.
        let message = message_with_payments(
            encrypted_payload,
            vec![signed_payment(0x77, &commitment, 0, 500)],
        );
        let transport = ChainTransport::default();

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message.clone())
            .await
            .expect_err("insufficient stamp value should be rejected");

        assert!(
            matches!(
                err,
                ProcessMonadMessageError::InsufficientTotalValue {
                    required: 10_000,
                    actual: 500,
                }
            ),
            "{err}"
        );
        assert!(transport.calls().is_empty(), "rejected before any RPC");
        assert_eq!(
            registry.get_monad_message(&message.payload_hash).unwrap(),
            None
        );
        assert!(registry
            .monad_outbox_record(&message.payload_hash)
            .unwrap()
            .is_none());
        assert_eq!(
            exact_set_retained(&err),
            Some(false),
            "no exact set is retained for a request refused before its claim"
        );
    }

    /// Same guard through the real router: the response is a client error, the RPC endpoint (an
    /// unroutable address) is never contacted, and nothing is claimed.
    #[tokio::test]
    async fn production_route_rejects_below_minimum_stamp_before_rpc_or_claim() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let message = message_with_payments(
            encrypted_payload,
            vec![signed_payment(0x7d, &commitment, 0, 500)],
        );
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            10_000,
            b"MONT".to_vec(),
        );
        let registry = Arc::clone(&server.registry);
        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(message.encode_to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            response.status().is_client_error(),
            "unexpected status {}",
            response.status()
        );
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["exact_set_retained"], false, "{body}");
        assert!(registry
            .monad_outbox_record(&message.payload_hash)
            .unwrap()
            .is_none());
        assert!(registry
            .get_monad_message(&message.payload_hash)
            .unwrap()
            .is_none());
    }

    /// A relay whose minimum was raised after a legacy digest-only claim was durably admitted
    /// still completes that exact set under the minimum it was admitted with.
    #[tokio::test]
    async fn unfinished_exact_retry_uses_its_original_minimum() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let message = message_with_payments(
            encrypted_payload,
            vec![signed_payment(0x79, &commitment, 0, 10_000)],
        );
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        let policy = MonadMessageAttemptPolicy {
            recipient_pubkey: recipient_pubkey.as_slice().to_vec(),
            min_value_wei: 10_000,
            network_tag: Some(b"MONT".to_vec()),
        };
        assert_eq!(
            registry
                .claim_monad_message_attempt(&message.payload_hash, &message, &policy)
                .unwrap(),
            MonadMessageAttemptClaim::New
        );
        let transport = ChainTransport::default();

        let stored = admit_for_test(&transport, &registry, 20_000, b"MONT", message.clone())
            .await
            .expect(
                "an unfinished exact retry keeps the minimum accepted before its first broadcast",
            );
        assert_eq!(stored.message, Some(message));
    }

    #[tokio::test]
    async fn unfinished_versionless_exact_retry_resumes_with_historical_network() {
        let (_tempdir, registry) = test_registry();
        let uppercase = |address: Address| {
            let hex = address.to_hex();
            format!("0x{}", hex[2..].to_ascii_uppercase())
        };
        let encrypted_payload = serde_json::to_vec(&serde_json::json!({
            "networkTag": "MONT",
            "from": uppercase(Address([0xab; 20])),
            "to": uppercase(recipient_address()),
            "salt": "00".repeat(16),
            "ciphertext": "11".repeat(16),
        }))
        .unwrap();
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let message = message_with_payments(
            encrypted_payload,
            vec![signed_payment(0x7c, &commitment, 0, 10_000)],
        );
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        let policy = MonadMessageAttemptPolicy {
            recipient_pubkey: recipient_pubkey.as_slice().to_vec(),
            min_value_wei: 10_000,
            network_tag: None,
        };
        assert_eq!(
            registry
                .claim_monad_message_attempt(&message.payload_hash, &message, &policy)
                .unwrap(),
            MonadMessageAttemptClaim::New
        );
        let transport = ChainTransport::default();

        let stored = admit_for_test(&transport, &registry, 20_000, b"MON1", message.clone())
            .await
            .expect("a durable exact versionless attempt resumes under its frozen policy");

        assert_eq!(stored.message, Some(message.clone()));
        assert_eq!(
            stored.network_tag, b"MONT",
            "an old-format claim recovers attribution from its exact historical envelope"
        );
        assert_eq!(
            transport.sends(),
            1,
            "the exact payment is broadcast only once during this resume"
        );
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing,
            "the exact adoption deletes the digest-only claim in the same database batch"
        );
        assert_eq!(
            registry
                .list_monad_messages_for_recipient_since(recipient_address(), 0)
                .unwrap(),
            vec![stored]
        );
    }

    #[test]
    fn canonical_address_vectors_match_envelope_builders() {
        for address in [
            "0xde709f2102306220921060314715629080e2fb77",
            "0x52908400098527886E0F7030069857D2E4169EE7",
            "0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE",
        ] {
            parse_canonical_address("from", address).unwrap();
        }
        assert!(
            parse_canonical_address("from", "0x5AEDA56215b167893e80B4fE645BA6d5Bab767De").is_err()
        );
    }

    #[test]
    fn envelope_ciphertext_boundary_preserves_request_framing_headroom() {
        assert_eq!(MAX_ENVELOPE_CIPHERTEXT_BYTES, 982_528);
        let base: Value =
            serde_json::from_slice(&valid_envelope(recipient_address(), "MONT")).unwrap();
        let at_limit = envelope_with_field(
            &base,
            "ciphertext",
            serde_json::json!("00".repeat(MAX_ENVELOPE_CIPHERTEXT_BYTES)),
        );
        assert!(at_limit.len() <= MAX_MONAD_MESSAGE_BODY_BYTES - MIN_ENVELOPE_BODY_HEADROOM_BYTES);
        validate_envelope(&at_limit, b"MONT").unwrap();

        let over_limit = envelope_with_field(
            &base,
            "ciphertext",
            serde_json::json!("00".repeat(MAX_ENVELOPE_CIPHERTEXT_BYTES + 1)),
        );
        assert!(matches!(
            validate_envelope(&over_limit, b"MONT"),
            Err(ProcessMonadMessageError::InvalidEnvelope(_))
        ));
    }

    #[tokio::test]
    async fn stored_v2_exact_retry_precedes_current_network_validation() {
        let (_tempdir, registry) = test_registry();
        let message = make_message(vec![0xc0], valid_envelope(recipient_address(), "MONT"));
        let stored = persist_message(&registry, message.clone(), b"MONT");
        let before_index = registry
            .list_monad_messages_for_recipient_since(recipient_address(), 0)
            .unwrap();
        let transport = MockTransport::default();

        let retried = admit_for_test(&transport, &registry, 10_000, b"MON1", message.clone())
            .await
            .expect("an exact stored retry is independent of current network policy");

        assert_eq!(retried, stored);
        assert!(transport.calls().is_empty());
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing
        );
        assert_eq!(
            registry
                .list_monad_messages_for_recipient_since(recipient_address(), 0)
                .unwrap(),
            before_index
        );
    }

    #[tokio::test]
    async fn stored_legacy_v1_exact_retry_precedes_current_envelope_validation() {
        let (_tempdir, registry) = test_registry();
        let legacy_envelope = serde_json::to_vec(&serde_json::json!({
            "v": 1,
            "networkTag": "MONT",
            "from": Address([0x11; 20]).to_hex(),
            "to": recipient_address().to_hex(),
            "salt": "00".repeat(16),
            "ciphertext": "11".repeat(16),
        }))
        .unwrap();
        let message = make_message(vec![0xc0], legacy_envelope);
        let stored = persist_message(&registry, message.clone(), b"MONT");
        let before_index = registry
            .list_monad_messages_for_recipient_since(recipient_address(), 0)
            .unwrap();
        let transport = MockTransport::default();

        let retried = admit_for_test(&transport, &registry, 10_000, b"MON1", message.clone())
            .await
            .expect("an exact stored legacy retry remains readable");

        assert_eq!(retried, stored);
        assert!(transport.calls().is_empty());
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing
        );
        assert_eq!(
            registry
                .list_monad_messages_for_recipient_since(recipient_address(), 0)
                .unwrap(),
            before_index
        );
    }

    #[tokio::test]
    async fn noncanonical_child_index_is_rejected_before_broadcast() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let sender = EccSecp256k1::default()
            .seckey_from_array([0x73; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            stamp_destination_at(&commitment, 1),
            10_000,
            &commitment_calldata_bytes(&commitment, 1),
        );
        let mut message = make_message(raw_tx, encrypted_payload);
        message.stamp_payments[0].child_index = 1;
        let transport = MockTransport::default();

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message)
            .await
            .expect_err("a one-payment set must start at child zero");

        assert!(matches!(
            err,
            ProcessMonadMessageError::NonCanonicalChildIndex {
                position: 0,
                actual: 1
            }
        ));
        assert!(transport.calls().is_empty());
    }

    /// Regression for #57's economic boundary. Before the fix, supplying
    /// `broadcast_burn_address()` as the server-wide configured destination made this transaction
    /// acceptable even though the envelope names a different recipient. The DM path must now
    /// reject that broadcast burn destination and leave storage untouched.
    #[tokio::test]
    async fn fixed_broadcast_burn_address_is_rejected_for_direct_message() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let calldata = commitment_calldata_bytes(&commitment, 0);
        let (raw_payment_tx, _sender) = signed_eip1559_tx(
            &seckey,
            41454,
            0,
            broadcast_burn_address(),
            10_000,
            &calldata,
        );
        let message = make_message(raw_payment_tx, encrypted_payload);

        let actual_to = hex_addr(broadcast_burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&actual_to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&actual_to, 10_000, &commitment_calldata(&commitment, 0)),
        );

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message.clone())
            .await
            .expect_err("a DM payment to the broadcast burn address must be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: 0,
                detail
            } if detail.contains("destination")
        ));
        assert!(transport.calls().is_empty());
        assert_eq!(
            registry.get_monad_message(&message.payload_hash).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn malformed_envelopes_are_rejected_before_decode_rpc_claim_or_storage() {
        let base: Value =
            serde_json::from_slice(&valid_envelope(recipient_address(), "MONT")).unwrap();
        let without_tag = {
            let mut value = base.clone();
            value.as_object_mut().unwrap().remove("tag");
            value
        };
        let malformed = vec![
            ("not JSON", b"not-json".to_vec()),
            (
                "missing required field",
                serde_json::to_vec(&without_tag).unwrap(),
            ),
            (
                "legacy v1",
                serde_json::to_vec(&serde_json::json!({
                    "v": 1,
                    "networkTag": "MONT",
                    "from": Address([0x11; 20]).to_hex(),
                    "to": recipient_address().to_hex(),
                    "salt": "00".repeat(16),
                    "ciphertext": "11".repeat(16),
                }))
                .unwrap(),
            ),
            (
                "unclaimed versionless historical envelope",
                serde_json::to_vec(&serde_json::json!({
                    "networkTag": "MONT",
                    "from": Address([0x11; 20]).to_hex(),
                    "to": recipient_address().to_hex(),
                    "salt": "00".repeat(16),
                    "ciphertext": "11".repeat(16),
                }))
                .unwrap(),
            ),
            (
                "unknown version",
                envelope_with_field(&base, "v", serde_json::json!(3)),
            ),
            (
                "invalid from address",
                envelope_with_field(&base, "from", serde_json::json!("0x11")),
            ),
            (
                "noncanonical to address",
                envelope_with_field(
                    &base,
                    "to",
                    serde_json::json!(format!("0x{}", "AA".repeat(20))),
                ),
            ),
            (
                "short salt",
                envelope_with_field(&base, "salt", serde_json::json!("00")),
            ),
            (
                "non-hex salt",
                envelope_with_field(
                    &base,
                    "salt",
                    serde_json::json!("gg".repeat(ENVELOPE_HKDF_SALT_BYTES)),
                ),
            ),
            (
                "long nonce",
                envelope_with_field(
                    &base,
                    "nonce",
                    serde_json::json!("00".repeat(ENVELOPE_GCM_NONCE_BYTES + 1)),
                ),
            ),
            (
                "empty ciphertext",
                envelope_with_field(&base, "ciphertext", serde_json::json!("")),
            ),
            (
                "oversized ciphertext",
                envelope_with_field(
                    &base,
                    "ciphertext",
                    serde_json::json!("00".repeat(MAX_ENVELOPE_CIPHERTEXT_BYTES + 1)),
                ),
            ),
            (
                "short tag",
                envelope_with_field(&base, "tag", serde_json::json!("00")),
            ),
        ];

        for (case, encrypted_payload) in malformed {
            let (_tempdir, registry) = test_registry();
            let commitment = Sha256::digest(encrypted_payload.clone().into());
            let seckey = EccSecp256k1::default()
                .seckey_from_array([0x77; 32])
                .unwrap();
            let calldata = commitment_calldata_bytes(&commitment, 0);
            let (raw_payment_tx, _sender) = signed_eip1559_tx(
                &seckey,
                41454,
                0,
                stamp_destination(&commitment),
                10_000,
                &calldata,
            );
            let message = make_message(raw_payment_tx, encrypted_payload);

            // No RPC responses are configured. Reaching broadcast would therefore produce an
            // infrastructure error instead of the required structural rejection.
            let transport = MockTransport::default();
            let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message.clone())
                .await
                .unwrap_err();

            assert!(
                matches!(err, ProcessMonadMessageError::InvalidEnvelope(_)),
                "{case}: {err}"
            );
            assert_eq!(
                exact_set_retained(&err),
                Some(false),
                "{case}: a request rejected before any claim must report that no set is retained"
            );
            assert_eq!(
                transport.calls(),
                Vec::<String>::new(),
                "{case}: malformed envelope must be rejected before any RPC"
            );
            assert_eq!(
                registry.get_monad_message(&message.payload_hash).unwrap(),
                None,
                "{case}: malformed envelope must not be stored"
            );
            assert_eq!(
                registry
                    .get_monad_message_attempt(&message.payload_hash, &message)
                    .unwrap(),
                MonadMessageAttemptClaim::Missing,
                "{case}: malformed envelope must not claim a payment attempt"
            );
            assert!(
                registry
                    .list_monad_messages_for_recipient_since(recipient_address(), 0)
                    .unwrap()
                    .is_empty(),
                "{case}: malformed envelope must not create a recipient index row"
            );
        }
    }

    #[tokio::test]
    async fn wrong_network_tag_is_rejected_before_broadcast() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MON1");
        let message = make_message(vec![0xc0], encrypted_payload);
        let transport = MockTransport::default();

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message)
            .await
            .expect_err("a payload hashed for another network must be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::NetworkTagMismatch { expected, actual }
                if expected == b"MONT" && actual.as_deref() == Some("MON1")
        ));
        assert!(transport.calls().is_empty());
    }

    #[tokio::test]
    async fn mismatched_payload_hash_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let mut message = make_message(vec![0xc0], b"hello".to_vec());
        // Corrupt the declared payload_hash so it no longer matches SHA256(encrypted_payload).
        message.payload_hash[0] ^= 0xff;

        // No transport responses configured at all: if this reached the network, it would panic.
        let transport = MockTransport::default();

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message)
            .await
            .expect_err("mismatched payload_hash should be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::PayloadHashMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn malformed_raw_payment_tx_is_rejected() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let message = make_message(vec![0x01, 0xc0], encrypted_payload);
        let transport = MockTransport::default();

        let err = admit_for_test(&transport, &registry, 10_000, b"MONT", message)
            .await
            .expect_err("malformed stamp payment should be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::FundingAccountRecoveryFailed(_)
        ));
    }

    /// Build a [`RegistryServer`] around `registry`, wired the same harmless way
    /// `crate::test_instance::RegistryTestInstance` wires one (POP disabled, no real peers) but
    /// without needing a bitcoind instance -- this ticket's endpoint doesn't touch either.
    fn test_server(registry: Registry) -> RegistryServer {
        use crate::{p2p::peers::Peers, test_instance::placeholder_pop_conf};

        let pop_gate =
            crate::http::pop_protection::PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            // No curated defaults needed by this route's tests (ticket #49).
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
        }
    }

    #[tokio::test]
    async fn disabled_mailbox_omits_private_and_admission_routes() {
        let (_tempdir, registry) = test_registry();
        let router = test_server(registry).into_router();
        for (method, uri) in [
            ("PUT", "/message/monad"),
            ("GET", "/message/monad"),
            ("GET", "/message/monad/00"),
            (
                "POST",
                "/message/monad/auth/0x0000000000000000000000000000000000000000",
            ),
            (
                "GET",
                "/message/monad/inbox/0x0000000000000000000000000000000000000000",
            ),
            (
                "GET",
                "/message/monad/recovery/0x0000000000000000000000000000000000000000",
            ),
            (
                "POST",
                concat!(
                    "/message/monad/recovery/",
                    "0x0000000000000000000000000000000000000000/",
                    "0000000000000000000000000000000000000000000000000000000000000000/ack"
                ),
            ),
        ] {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(uri)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn enabled_mailbox_rejects_malformed_body_before_rpc() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(vec![0xff]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn enabled_mailbox_omits_legacy_exact_and_global_get_routes() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        let router = server.into_router();
        for uri in ["/message/monad", "/message/monad/00"] {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("GET")
                        .uri(uri)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "GET {uri}");
        }
    }

    #[tokio::test]
    async fn conflict_response_tells_wallet_to_release_the_submitted_reservation() {
        let response =
            PutMonadMessageError::Process(ProcessMonadMessageError::ConflictingPaymentSet)
                .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "mailbox_conflict");
        assert_eq!(body["exact_set_retained"], false);
    }

    #[tokio::test]
    async fn production_route_rejects_valid_protobuf_poison_before_rpc_or_claim() {
        let cases = [
            (
                signed_message_for_envelope(b"{}".to_vec(), 0x50, 41_454),
                "invalid Monad message envelope",
            ),
            (
                signed_message_for_envelope(
                    valid_envelope(Address([0xee; 20]), "MONT"),
                    0x51,
                    41_454,
                ),
                "no registered Monad profile",
            ),
            (
                signed_message_for_envelope(
                    valid_envelope(recipient_address(), "OTHER"),
                    0x52,
                    41_454,
                ),
                "network tag",
            ),
        ];
        for (message, expected_detail) in cases {
            let payload_hash = message.payload_hash.clone();
            let (_tempdir, registry) = test_registry();
            let mut server = test_server(registry);
            server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
                HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
                Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
                1,
                b"MONT".to_vec(),
            );
            let registry = Arc::clone(&server.registry);
            let response = server
                .into_router()
                .oneshot(
                    axum::http::Request::builder()
                        .method("PUT")
                        .uri("/message/monad")
                        .header("content-type", "application/x-protobuf")
                        .body(axum::body::Body::from(message.encode_to_vec()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["exact_set_retained"], false);
            assert!(
                body["detail"].as_str().unwrap().contains(expected_detail),
                "unexpected error body: {body}"
            );
            assert!(registry
                .monad_outbox_record(&payload_hash)
                .unwrap()
                .is_none());
            assert!(registry.get_monad_message(&payload_hash).unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn production_route_rejects_noncanonical_protobuf_before_claim_or_rpc() {
        let message = valid_signed_message(0x73, 0x53);
        for body in noncanonical_message_bodies(&message) {
            let (_tempdir, registry) = test_registry();
            let mut server = test_server(registry);
            server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
                HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
                Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
                10_000,
                b"MONT".to_vec(),
            );
            let registry = Arc::clone(&server.registry);
            let response = server
                .into_router()
                .oneshot(
                    axum::http::Request::builder()
                        .method("PUT")
                        .uri("/message/monad")
                        .header("content-type", "application/x-protobuf")
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let response_body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let response_body: Value = serde_json::from_slice(&response_body).unwrap();
            assert_eq!(response_body["error"], "noncanonical_protobuf");
            assert_eq!(response_body["exact_set_retained"], false);
            assert!(registry
                .monad_outbox_record(&message.payload_hash)
                .unwrap()
                .is_none());
            assert!(registry
                .get_monad_message(&message.payload_hash)
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn noncanonical_exact_retry_uses_existing_semantic_owner_without_rpc() {
        let message = valid_signed_message(0x75, 0x56);
        let (_tempdir, registry) = test_registry();
        persist_message(&registry, message.clone(), b"MONT");
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            10_000,
            b"MONT".to_vec(),
        );
        let router = server.into_router();

        for body in noncanonical_message_bodies(&message) {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("PUT")
                        .uri("/message/monad")
                        .header("content-type", "application/x-protobuf")
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let response = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let response: Value = serde_json::from_slice(&response).unwrap();
            assert_eq!(response["error"], "noncanonical_protobuf");
            assert_eq!(response["exact_set_retained"], true);
        }
    }

    #[tokio::test]
    async fn noncanonical_pending_owner_reports_retained_without_rpc() -> Result<(), Report> {
        let message = valid_signed_message(0x76, 0x57);
        let (_tempdir, registry) = test_registry();
        let policy = test_outbox_policy();
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        assert!(matches!(
            registry.claim_monad_outbox(&message, &policy, 1, &config.limits)?,
            MonadOutboxClaim::New
        ));
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config),
            10_000,
            b"MONT".to_vec(),
        );
        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(
                        noncanonical_message_bodies(&message).remove(0),
                    ))
                    .unwrap(),
            )
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = hyper::body::to_bytes(response.into_body()).await?;
        let response: Value = serde_json::from_slice(&response)?;
        assert_eq!(response["error"], "noncanonical_protobuf");
        assert_eq!(response["exact_set_retained"], true);
        Ok(())
    }

    #[tokio::test]
    async fn noncanonical_legacy_owner_uses_stable_retained_code() -> Result<(), Report> {
        let message = valid_signed_message(0x79, 0x5a);
        let (_tempdir, registry) = test_registry();
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        assert!(matches!(
            registry.claim_monad_message_attempt(
                &message.payload_hash,
                &message,
                &MonadMessageAttemptPolicy {
                    recipient_pubkey: recipient_pubkey.as_slice().to_vec(),
                    min_value_wei: 10_000,
                    network_tag: Some(b"MONT".to_vec()),
                },
            )?,
            MonadMessageAttemptClaim::New
        ));
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            10_000,
            b"MONT".to_vec(),
        );
        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(
                        noncanonical_message_bodies(&message).remove(0),
                    ))
                    .unwrap(),
            )
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = hyper::body::to_bytes(response.into_body()).await?;
        let response: Value = serde_json::from_slice(&response)?;
        assert_eq!(response["error"], "noncanonical_protobuf");
        assert_eq!(response["exact_set_retained"], true);
        Ok(())
    }

    #[tokio::test]
    async fn legacy_recipient_pubkey_mismatch_rejects_before_claim_or_rpc() -> Result<(), Report> {
        let message = valid_signed_message(0x7a, 0x5b);
        let (_tempdir, registry) = test_registry();
        let ecc = EccSecp256k1::default();
        let unrelated_secret = ecc.seckey_from_array([0x66; 32]).unwrap();
        let unrelated_pubkey = ecc.derive_pubkey(&unrelated_secret);
        assert!(matches!(
            registry.claim_monad_message_attempt(
                &message.payload_hash,
                &message,
                &MonadMessageAttemptPolicy {
                    recipient_pubkey: unrelated_pubkey.as_slice().to_vec(),
                    min_value_wei: 10_000,
                    network_tag: Some(b"MONT".to_vec()),
                },
            )?,
            MonadMessageAttemptClaim::New
        ));
        let transport = MockTransport::default();
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        let error = admit_monad_message(
            &transport,
            &registry,
            &config,
            &permits,
            10_000,
            b"MONT",
            message.clone(),
        )
        .await
        .expect_err("legacy routing cannot be rebound to an unrelated public key");
        // The unrelated legacy attempt row is retained, but the rebinding itself is rejected.
        assert!(matches!(
            error,
            ProcessMonadMessageError::LegacyExactRetained(inner)
                if matches!(*inner, ProcessMonadMessageError::InvalidEnvelope(_))
        ));
        assert!(transport.calls().is_empty());
        assert!(registry
            .monad_outbox_record(&message.payload_hash)?
            .is_none());
        assert!(registry.get_monad_message(&message.payload_hash)?.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn terminal_response_reports_post_gc_retention_truth() -> Result<(), Report> {
        let message = valid_signed_message(0x77, 0x58);
        let (_tempdir, registry) = test_registry();
        let policy = test_outbox_policy();
        let mut limits = crate::store::monad_outbox::MonadOutboxLimits::default();
        limits.max_history_records = 0;
        assert!(matches!(
            registry.claim_monad_outbox(&message, &policy, 1, &limits)?,
            MonadOutboxClaim::New
        ));
        assert!(matches!(
            registry.terminal_monad_outbox_claim(
                &message.payload_hash,
                MonadOutboxTerminal::VerificationFailed,
                "terminal fixture",
                2,
                &limits,
            )?,
            crate::store::monad_outbox::MonadOutboxTransition::Applied
        ));
        assert!(registry
            .monad_outbox_record(&message.payload_hash)?
            .is_none());

        let error =
            terminal_process_error(&registry, &message, MonadOutboxTerminal::VerificationFailed);
        assert!(matches!(
            error,
            ProcessMonadMessageError::OutboxTerminal {
                retained: false,
                ..
            }
        ));
        let response = PutMonadMessageError::Process(error).into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let response = hyper::body::to_bytes(response.into_body()).await?;
        let response: Value = serde_json::from_slice(&response)?;
        assert_eq!(response["exact_set_retained"], false);
        Ok(())
    }

    #[tokio::test]
    async fn reconciliation_timeout_rereads_durable_exact_ownership() -> Result<(), Report> {
        let message = valid_signed_message(0x78, 0x59);
        let (_tempdir, registry) = test_registry();
        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.claim_timeout = std::time::Duration::from_millis(5);
        config.rpc_timeout = std::time::Duration::from_secs(30);
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);

        let error = admit_monad_message(
            &NeverReturnsTransport,
            &registry,
            &config,
            &permits,
            10_000,
            b"MONT",
            message.clone(),
        )
        .await
        .expect_err("claim timeout must be retryable rather than successful");
        assert!(matches!(error, ProcessMonadMessageError::OutboxPending));
        let record = registry
            .monad_outbox_record(&message.payload_hash)?
            .expect("timed out claim remains durable");
        assert_eq!(
            record.canonical_message.as_deref(),
            Some(message.encode_to_vec().as_slice())
        );
        let response = PutMonadMessageError::Process(error).into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let response = hyper::body::to_bytes(response.into_body()).await?;
        let response: Value = serde_json::from_slice(&response)?;
        assert_eq!(response["exact_set_retained"], true);
        Ok(())
    }

    #[tokio::test]
    async fn foreign_chain_is_rejected_without_ownership_and_corrected_payment_is_accepted() {
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let foreign = signed_message_for_envelope(encrypted_payload.clone(), 0x54, 1);
        let corrected = signed_message_for_envelope(encrypted_payload, 0x54, 41_454);
        assert_eq!(foreign.payload_hash, corrected.payload_hash);
        let (_tempdir, registry) = test_registry();
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        let transport = MockTransport::default();
        assert!(matches!(
            admit_monad_message(
                &transport, &registry, &config, &permits, 10_000, b"MONT", foreign,
            )
            .await,
            Err(ProcessMonadMessageError::UnexpectedChainId {
                expected: 41_454,
                actual: Some(1),
            })
        ));
        assert!(transport.calls().is_empty());
        assert!(registry
            .monad_outbox_record(&corrected.payload_hash)
            .unwrap()
            .is_none());

        let decoded = decode_signed_transaction(&corrected.stamp_payments[0].raw_tx).unwrap();
        let destination = decoded.destination.unwrap();
        transport.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": decoded.tx_hash.to_hex(),
                "blockHash": hex_hash(0x22),
                "blockNumber": "0x2a",
                "from": decoded.sender.to_hex(),
                "to": destination.to_hex(),
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": decoded.tx_hash.to_hex(),
                "to": destination.to_hex(),
                "value": format!("0x{:x}", decoded.value_wei),
                "input": format!("0x{}", hex::encode(&decoded.input)),
                "from": decoded.sender.to_hex(),
            }),
        );
        let stored = admit_monad_message(
            &transport,
            &registry,
            &config,
            &permits,
            10_000,
            b"MONT",
            corrected.clone(),
        )
        .await
        .unwrap();
        assert_eq!(stored.message, Some(corrected));
    }

    #[tokio::test]
    async fn production_router_returns_only_after_durable_inbox_publication() {
        let message = valid_signed_message(0x74, 0x45);
        let decoded = decode_signed_transaction(&message.stamp_payments[0].raw_tx).unwrap();
        let destination = decoded.destination.unwrap();
        let rpc = axum::Router::new().route(
            "/",
            axum::routing::post({
                let decoded = decoded.clone();
                move |axum::Json(request): axum::Json<Value>| {
                    let decoded = decoded.clone();
                    async move {
                        let result = match request["method"].as_str().unwrap() {
                            "eth_getTransactionReceipt" => serde_json::json!({
                                "transactionHash": decoded.tx_hash.to_hex(),
                                "blockHash": hex_hash(0x22),
                                "blockNumber": "0x2a",
                                "from": decoded.sender.to_hex(),
                                "to": destination.to_hex(),
                                "contractAddress": null,
                                "gasUsed": "0x5208",
                                "status": "0x1",
                                "logs": [],
                            }),
                            "eth_getTransactionByHash" => serde_json::json!({
                                "hash": decoded.tx_hash.to_hex(),
                                "to": destination.to_hex(),
                                "value": format!("0x{:x}", decoded.value_wei),
                                "input": format!("0x{}", hex::encode(&decoded.input)),
                                "from": decoded.sender.to_hex(),
                            }),
                            method => panic!("unexpected RPC method {method}"),
                        };
                        axum::Json(serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": request["id"],
                            "result": result,
                        }))
                    }
                }
            }),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let rpc_url: url::Url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let rpc_task = tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(rpc.into_make_service()),
        );

        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new(rpc_url),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            10_000,
            b"MONT".to_vec(),
        );
        let registry = Arc::clone(&server.registry);
        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(message.encode_to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let stored = proto::StoredMonadMessage::decode(body).unwrap();
        assert_eq!(stored.message, Some(message.clone()));
        assert_eq!(
            registry.get_monad_message(&message.payload_hash).unwrap(),
            Some(stored)
        );
        rpc_task.abort();
    }

    #[tokio::test]
    async fn production_router_adopts_legacy_owner_after_member_limit_is_lowered() {
        let message = valid_signed_message_with_members(0x75, &[0x46, 0x47]);
        let (_tempdir, registry) = test_registry();
        let db_path = _tempdir.path().join("db.rocksdb");
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        let legacy_policy = MonadMessageAttemptPolicy {
            recipient_pubkey: recipient_pubkey.as_slice().to_vec(),
            min_value_wei: 20_000,
            network_tag: Some(b"MONT".to_vec()),
        };
        assert!(matches!(
            registry
                .claim_monad_message_attempt(&message.payload_hash, &message, &legacy_policy)
                .unwrap(),
            MonadMessageAttemptClaim::New
        ));
        drop(registry);

        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.limits.max_members = 1;
        let registry = Registry::new(
            Db::open_with_monad_outbox_limits(&db_path, &config.limits).unwrap(),
            Arc::new(UnusedChainAdapter),
            Net::Regtest,
        );
        assert!(matches!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::ExistingExact(_)
        ));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let rpc_url: url::Url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let mut server = test_server(registry);
        let registry = Arc::clone(&server.registry);
        let decoded = Arc::new(
            message
                .stamp_payments
                .iter()
                .map(|payment| decode_signed_transaction(&payment.raw_tx).unwrap())
                .map(|tx| (tx.tx_hash.to_hex(), tx))
                .collect::<HashMap<_, _>>(),
        );
        let rpc_calls = Arc::new(AtomicUsize::new(0));
        let rpc = axum::Router::new().route(
            "/",
            axum::routing::post({
                let decoded = Arc::clone(&decoded);
                let registry = Arc::clone(&registry);
                let message = message.clone();
                let legacy_policy = legacy_policy.clone();
                let rpc_calls = Arc::clone(&rpc_calls);
                move |axum::Json(request): axum::Json<Value>| {
                    let decoded = Arc::clone(&decoded);
                    let registry = Arc::clone(&registry);
                    let message = message.clone();
                    let legacy_policy = legacy_policy.clone();
                    let rpc_calls = Arc::clone(&rpc_calls);
                    async move {
                        rpc_calls.fetch_add(1, Ordering::SeqCst);
                        assert!(matches!(
                            registry
                                .get_monad_message_attempt(&message.payload_hash, &message)
                                .unwrap(),
                            MonadMessageAttemptClaim::Missing
                        ));
                        let record = registry
                            .monad_outbox_record(&message.payload_hash)
                            .unwrap()
                            .expect("canonical ownership is durable before the first RPC");
                        let policy = record
                            .policy
                            .expect("active adopted ownership retains its frozen policy");
                        assert_eq!(policy.recipient_pubkey, legacy_policy.recipient_pubkey);
                        assert_eq!(policy.min_value_wei, legacy_policy.min_value_wei);
                        assert_eq!(policy.network_tag, b"MONT");
                        let method = request["method"].as_str().unwrap();
                        let tx = match method {
                            "eth_sendRawTransaction" => {
                                let raw = hex::decode(
                                    request["params"][0]
                                        .as_str()
                                        .unwrap()
                                        .trim_start_matches("0x"),
                                )
                                .unwrap();
                                decode_signed_transaction(&raw).unwrap()
                            }
                            "eth_getTransactionReceipt" | "eth_getTransactionByHash" => decoded
                                .get(request["params"][0].as_str().unwrap())
                                .unwrap()
                                .clone(),
                            other => panic!("unexpected RPC method {other}"),
                        };
                        let result = match method {
                            "eth_sendRawTransaction" => Value::String(tx.tx_hash.to_hex()),
                            "eth_getTransactionReceipt" => serde_json::json!({
                                "transactionHash": tx.tx_hash.to_hex(),
                                "blockHash": hex_hash(0x22),
                                "blockNumber": "0x2a",
                                "from": tx.sender.to_hex(),
                                "to": tx.destination.unwrap().to_hex(),
                                "contractAddress": null,
                                "gasUsed": "0x5208",
                                "status": "0x1",
                                "logs": [],
                            }),
                            "eth_getTransactionByHash" => serde_json::json!({
                                "hash": tx.tx_hash.to_hex(),
                                "to": tx.destination.unwrap().to_hex(),
                                "value": format!("0x{:x}", tx.value_wei),
                                "input": format!("0x{}", hex::encode(&tx.input)),
                                "from": tx.sender.to_hex(),
                            }),
                            _ => unreachable!(),
                        };
                        axum::Json(serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": request["id"],
                            "result": result,
                        }))
                    }
                }
            }),
        );
        let rpc_task = tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(rpc.into_make_service()),
        );
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new(rpc_url),
            Arc::new(config.clone()),
            99_999,
            b"DIFFERENT".to_vec(),
        );

        let response = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("PUT")
                    .uri("/message/monad")
                    .header("content-type", "application/x-protobuf")
                    .body(axum::body::Body::from(message.encode_to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let stored = proto::StoredMonadMessage::decode(body).unwrap();
        assert_eq!(stored.message, Some(message.clone()));
        assert_eq!(stored.network_tag, b"MONT");
        assert_eq!(rpc_calls.load(Ordering::SeqCst), 4);
        assert!(matches!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing
        ));
        assert_eq!(
            registry.get_monad_message(&message.payload_hash).unwrap(),
            Some(stored)
        );
        rpc_task.abort();

        let (_new_tempdir, new_registry) = test_registry();
        let new_message = valid_signed_message_with_members(0x76, &[0x48, 0x49]);
        let transport = MockTransport::default();
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        assert!(matches!(
            admit_monad_message(
                &transport,
                &new_registry,
                &config,
                &permits,
                10_000,
                b"MONT",
                new_message.clone(),
            )
            .await,
            Err(ProcessMonadMessageError::TooManyStampPayments {
                actual: 2,
                maximum: 1
            })
        ));
        assert!(transport.calls().is_empty());
        assert!(new_registry
            .monad_outbox_record(&new_message.payload_hash)
            .unwrap()
            .is_none());
        assert!(new_registry
            .get_monad_message(&new_message.payload_hash)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn canonical_admission_covers_new_exact_conflict_and_capacity_without_early_rpc() {
        let (_tempdir, registry) = test_registry();
        let message = valid_signed_message(0x44, 0x41);
        let decoded = decode_signed_transaction(&message.stamp_payments[0].raw_tx).unwrap();
        let destination = decoded.destination.unwrap();
        let tx_hash = decoded.tx_hash.to_hex();
        let transport = MockTransport::default();
        transport.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": tx_hash,
                "blockHash": hex_hash(0x22),
                "blockNumber": "0x2a",
                "from": decoded.sender.to_hex(),
                "to": destination.to_hex(),
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": decoded.tx_hash.to_hex(),
                "to": destination.to_hex(),
                "value": format!("0x{:x}", decoded.value_wei),
                "input": format!("0x{}", hex::encode(&decoded.input)),
                "from": decoded.sender.to_hex(),
            }),
        );
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        let stored = admit_monad_message(
            &transport,
            &registry,
            &config,
            &permits,
            10_000,
            b"MONT",
            message.clone(),
        )
        .await
        .unwrap();
        assert_eq!(stored.message, Some(message.clone()));
        assert!(!transport.calls().is_empty());

        let calls_after_delivery = transport.calls().len();
        assert_eq!(
            admit_monad_message(
                &transport,
                &registry,
                &config,
                &permits,
                20_000,
                b"DIFFERENT",
                message.clone(),
            )
            .await
            .unwrap(),
            stored
        );
        assert_eq!(transport.calls().len(), calls_after_delivery);

        let mut conflicting = message;
        conflicting.stamp_payments[0].raw_tx.push(0);
        assert!(matches!(
            admit_monad_message(
                &transport,
                &registry,
                &config,
                &permits,
                10_000,
                b"MONT",
                conflicting,
            )
            .await,
            Err(ProcessMonadMessageError::ConflictingPaymentSet)
        ));
        assert_eq!(transport.calls().len(), calls_after_delivery);

        let (_capacity_tempdir, capacity_registry) = test_registry();
        let blocker = valid_signed_message(0x55, 0x42);
        let target = valid_signed_message(0x66, 0x43);
        let mut capacity_config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        capacity_config.limits.max_active_claims = 1;
        let policy = test_outbox_policy();
        assert!(matches!(
            capacity_registry
                .claim_monad_outbox(&blocker, &policy, 1, &capacity_config.limits)
                .unwrap(),
            MonadOutboxClaim::New
        ));
        let capacity_transport = MockTransport::default();
        let capacity_permits = MonadOutboxPermitPool::new(capacity_config.max_concurrency);
        assert!(matches!(
            admit_monad_message(
                &capacity_transport,
                &capacity_registry,
                &capacity_config,
                &capacity_permits,
                10_000,
                b"MONT",
                target.clone(),
            )
            .await,
            Err(ProcessMonadMessageError::OutboxAtCapacity)
        ));
        assert!(capacity_transport.calls().is_empty());

        let target_policy = MonadMessageAttemptPolicy {
            recipient_pubkey: policy.recipient_pubkey.clone(),
            min_value_wei: policy.min_value_wei,
            network_tag: Some(policy.network_tag.clone()),
        };
        assert!(matches!(
            capacity_registry
                .claim_monad_message_attempt(&target.payload_hash, &target, &target_policy)
                .unwrap(),
            MonadMessageAttemptClaim::New
        ));
        let error = admit_monad_message(
            &capacity_transport,
            &capacity_registry,
            &capacity_config,
            &capacity_permits,
            10_000,
            b"MONT",
            target,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            ProcessMonadMessageError::OutboxAtCapacityExactLegacy
        ));
        let response = PutMonadMessageError::Process(error).into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["exact_set_retained"], true);
        assert!(capacity_transport.calls().is_empty());
    }

    #[tokio::test]
    async fn exact_retry_survives_finalize_and_compaction_race_without_rpc() -> Result<(), Report> {
        let (_tempdir, registry) = test_registry();
        let registry = Arc::new(registry);
        let message = valid_signed_message(0x67, 0x44);
        let policy = test_outbox_policy();
        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.limits.max_history_records = 0;
        registry.claim_monad_outbox(&message, &policy, 1, &config.limits)?;
        let lease = match registry.acquire_monad_outbox_reconcile_lease(
            &message.payload_hash,
            0,
            2,
            &config.limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected race fixture lease, got {other:?}"),
        };
        registry.complete_confirmed_monad_outbox_member(
            &message.payload_hash,
            0,
            lease,
            10_000,
            7,
            3,
        )?;
        assert!(registry.mark_monad_outbox_fully_confirmed(&message.payload_hash, 4)?);

        let hash: [u8; 32] = message.payload_hash.as_slice().try_into().unwrap();
        let registry_for_hook = Arc::clone(&registry);
        let limits_for_hook = config.limits.clone();
        ADMISSION_RACE_HOOKS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(
                hash,
                Box::new(move || {
                    registry_for_hook
                        .finalize_monad_outbox(&hash, 5, 41_454, &limits_for_hook)
                        .unwrap();
                    registry_for_hook
                        .gc_monad_outbox_history(6, &limits_for_hook)
                        .unwrap();
                }),
            );
        let transport = MockTransport::default();
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        let stored = admit_monad_message(
            &transport,
            &registry,
            &config,
            &permits,
            10_000,
            b"MONT",
            message.clone(),
        )
        .await
        .expect("exact retry should reread the delivered inbox owner");
        assert_eq!(stored.message, Some(message.clone()));
        assert!(transport.calls().is_empty());
        assert!(registry
            .monad_outbox_record(&message.payload_hash)?
            .is_none());

        let mut mismatched = message;
        mismatched.stamp_payments[0].raw_tx.push(0);
        assert!(matches!(
            admit_monad_message(
                &transport, &registry, &config, &permits, 10_000, b"MONT", mismatched,
            )
            .await,
            Err(ProcessMonadMessageError::ConflictingPaymentSet)
        ));
        assert!(transport.calls().is_empty());
        Ok(())
    }

    /// Private-read capacity exhaustion is a retryable 503 with a stable error code.
    #[tokio::test]
    async fn private_read_capacity_maps_to_retryable_503() {
        let response = PrivateMailboxError::AtCapacity.into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "mailbox_auth_retryable");
    }

    #[tokio::test]
    async fn private_read_capacity_is_checked_before_profile_or_signature_work() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.max_concurrency = 1;
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config),
            1,
            b"MONT".to_vec(),
        );
        let recipient = recipient_address();
        let binding = MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient,
            since: 0,
            cursor: None,
            limit: 1,
            max_bytes: 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        };
        let mut headers = signed_private_headers(&server, &binding);
        headers.insert(
            MAILBOX_SIGNATURE_HEADER,
            "00".repeat(MIN_ECDSA_DER_SIGNATURE_BYTES).parse().unwrap(),
        );
        let held = server
            .monad_mailbox
            .as_enabled()
            .unwrap()
            .try_acquire_private_read()
            .unwrap();
        crate::registry::reset_recipient_signature_work();
        assert!(matches!(
            handle_get_private_monad_messages(
                Path(recipient.to_hex()),
                Query(PrivateInboxQuery {
                    since: Some(0),
                    cursor: None,
                    limit: Some(1),
                    max_bytes: Some(1024),
                }),
                headers,
                Extension(server),
            )
            .await,
            Err(PrivateMailboxError::AtCapacity)
        ));
        assert_eq!(crate::registry::recipient_signature_work(), 0);
        drop(held);
    }

    #[tokio::test]
    async fn private_routes_reject_negative_since_before_authentication() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        assert!(matches!(
            handle_get_private_monad_messages(
                Path(recipient_address().to_hex()),
                Query(PrivateInboxQuery {
                    since: Some(-1),
                    cursor: None,
                    limit: Some(1),
                    max_bytes: Some(1024),
                }),
                HeaderMap::new(),
                Extension(server),
            )
            .await,
            Err(PrivateMailboxError::InvalidLimit)
        ));
    }

    #[tokio::test]
    async fn public_challenge_fields_sign_opaque_cursor_and_reject_equivalent_substitution() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        let recipient = recipient_address();
        let runtime = server.monad_mailbox.as_enabled().unwrap();
        let position = MailboxCursor::Recovery {
            payload_hash: [0xab; 32],
        };
        let cursor = runtime.encode_cursor(recipient, position);

        let Json(challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(PrivateChallengeQuery {
                resource: "recovery".to_string(),
                since: None,
                cursor: Some(cursor.clone()),
                limit: Some(1),
                max_bytes: Some(1024),
                recovery_payload_hash: None,
                recovery_obligation_id: None,
            }),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let challenge = serde_json::to_value(challenge).unwrap();
        let preimage = client_mailbox_auth_preimage(&challenge, recipient);
        let headers = signed_public_challenge_headers(&challenge, &preimage);
        let response = handle_get_private_monad_recovery(
            Path(recipient.to_hex()),
            Query(PrivateRecoveryQuery {
                cursor: Some(cursor.clone()),
                limit: Some(1),
                max_bytes: Some(1024),
            }),
            headers,
            Extension(server.clone()),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let Json(challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(PrivateChallengeQuery {
                resource: "recovery".to_string(),
                since: None,
                cursor: Some(cursor.clone()),
                limit: Some(1),
                max_bytes: Some(1024),
                recovery_payload_hash: None,
                recovery_obligation_id: None,
            }),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let challenge = serde_json::to_value(challenge).unwrap();
        let preimage = client_mailbox_auth_preimage(&challenge, recipient);
        let headers = signed_public_challenge_headers(&challenge, &preimage);
        let substituted = cursor.to_ascii_uppercase();
        assert_ne!(substituted, cursor);
        assert_eq!(
            runtime.decode_cursor(recipient, MailboxResource::Recovery, &substituted),
            Some(position),
            "the alternate token spelling decodes to the same private position"
        );
        assert!(matches!(
            handle_get_private_monad_recovery(
                Path(recipient.to_hex()),
                Query(PrivateRecoveryQuery {
                    cursor: Some(substituted),
                    limit: Some(1),
                    max_bytes: Some(1024),
                }),
                headers,
                Extension(server),
            )
            .await,
            Err(PrivateMailboxError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn challenge_exposes_empty_runtime_network_tag_for_client_only_preimage() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            Vec::new(),
        );
        let recipient = recipient_address();
        let Json(challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(PrivateChallengeQuery {
                resource: "inbox".to_string(),
                since: Some(0),
                cursor: None,
                limit: Some(1),
                max_bytes: Some(1024),
                recovery_payload_hash: None,
                recovery_obligation_id: None,
            }),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let challenge = serde_json::to_value(challenge).unwrap();
        assert_eq!(challenge["network_tag"], "");
        let headers = signed_public_challenge_headers(
            &challenge,
            &client_mailbox_auth_preimage(&challenge, recipient),
        );
        let response = handle_get_private_monad_messages(
            Path(recipient.to_hex()),
            Query(PrivateInboxQuery {
                since: Some(0),
                cursor: None,
                limit: Some(1),
                max_bytes: Some(1024),
            }),
            headers,
            Extension(server),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn registry_server_debug_redacts_mailbox_hmac_secret() {
        let secret = [0xa5; 32];
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox =
            crate::monad_mailbox::MonadMailboxRuntime::enabled_with_auth_secret_for_test(
                HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
                Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
                1,
                b"MONT".to_vec(),
                secret,
            );
        let formatted = format!("{server:?}");
        assert!(formatted.contains("<redacted>"));
        assert!(!formatted.contains(&format!("{secret:?}")));
        assert!(!formatted.contains(&hex::encode(secret)));
    }

    #[tokio::test]
    async fn recipient_ack_is_payload_bound_idempotent_and_releases_only_terminal_quota() {
        let (_tempdir, registry) = test_registry();
        let mut config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        config.limits.max_recovery_records = 2;
        config.limits.max_recovery_records_per_recipient = 2;
        let policy = test_outbox_policy();
        let terminal = valid_signed_message_with_members(0x91, &[0x71, 0x72]);
        assert_eq!(
            registry
                .claim_monad_outbox(&terminal, &policy, 1, &config.limits)
                .unwrap(),
            MonadOutboxClaim::New
        );
        let first_lease = match registry
            .acquire_monad_outbox_reconcile_lease(&terminal.payload_hash, 0, 2, &config.limits)
            .unwrap()
        {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected first acknowledgement lease, got {other:?}"),
        };
        registry
            .complete_confirmed_monad_outbox_member(
                &terminal.payload_hash,
                0,
                first_lease,
                10_000,
                7,
                3,
            )
            .unwrap();
        let second_lease = match registry
            .acquire_monad_outbox_reconcile_lease(&terminal.payload_hash, 1, 4, &config.limits)
            .unwrap()
        {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected terminal acknowledgement lease, got {other:?}"),
        };
        registry
            .complete_terminal_monad_outbox_member(
                &terminal.payload_hash,
                1,
                second_lease,
                MonadOutboxTerminal::StaleNonce,
                "terminal prefix",
                5,
                &config.limits,
            )
            .unwrap();

        let blocked = valid_signed_message(0x92, 0x73);
        let active = valid_signed_message(0x93, 0x74);
        assert_eq!(
            registry
                .claim_monad_outbox(&active, &policy, 7, &config.limits)
                .unwrap(),
            MonadOutboxClaim::New
        );
        assert_eq!(
            registry
                .claim_monad_outbox(&blocked, &policy, 6, &config.limits)
                .unwrap(),
            MonadOutboxClaim::AtCapacity
        );

        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config.clone()),
            10_000,
            vec![0, 0xff, 0x80],
        );
        let recipient = recipient_address();
        let issue = |payload_hash: &[u8]| PrivateChallengeQuery {
            resource: "recovery_ack".to_string(),
            since: None,
            cursor: None,
            limit: None,
            max_bytes: None,
            recovery_payload_hash: Some(hex::encode(payload_hash)),
            recovery_obligation_id: Some(hex::encode(
                server
                    .registry
                    .confirmed_monad_outbox_prefixes(recipient, 10)
                    .unwrap()
                    .into_iter()
                    .find(|recovery| recovery.payload_hash.as_slice() == payload_hash)
                    .map(|recovery| recovery.obligation_id)
                    .unwrap_or([0; 32]),
            )),
        };

        let Json(challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(issue(&terminal.payload_hash)),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let challenge = serde_json::to_value(challenge).unwrap();
        assert_eq!(challenge["network_tag"], "00ff80");
        let headers = signed_public_challenge_headers(
            &challenge,
            &client_mailbox_auth_preimage(&challenge, recipient),
        );
        assert!(matches!(
            handle_ack_private_monad_recovery(
                Path((
                    recipient.to_hex(),
                    hex::encode(&active.payload_hash),
                    challenge["recovery_obligation_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )),
                headers,
                Extension(server.clone()),
            )
            .await,
            Err(PrivateMailboxError::Unauthorized)
        ));
        assert!(server
            .registry
            .monad_outbox_record(&terminal.payload_hash)
            .unwrap()
            .is_some());

        let wrong_recipient = Address([9; 20]);
        let Json(wrong_challenge) = handle_issue_mailbox_challenge(
            Path(wrong_recipient.to_hex()),
            Query(issue(&terminal.payload_hash)),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let wrong_challenge = serde_json::to_value(wrong_challenge).unwrap();
        let wrong_headers = signed_public_challenge_headers(
            &wrong_challenge,
            &client_mailbox_auth_preimage(&wrong_challenge, wrong_recipient),
        );
        assert!(matches!(
            handle_ack_private_monad_recovery(
                Path((
                    wrong_recipient.to_hex(),
                    hex::encode(&terminal.payload_hash),
                    wrong_challenge["recovery_obligation_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )),
                wrong_headers,
                Extension(server.clone()),
            )
            .await,
            Err(PrivateMailboxError::Unauthorized)
        ));
        assert!(server
            .registry
            .monad_outbox_record(&terminal.payload_hash)
            .unwrap()
            .is_some());

        let Json(active_challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(issue(&active.payload_hash)),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let active_challenge = serde_json::to_value(active_challenge).unwrap();
        let active_headers = signed_public_challenge_headers(
            &active_challenge,
            &client_mailbox_auth_preimage(&active_challenge, recipient),
        );
        assert!(matches!(
            handle_ack_private_monad_recovery(
                Path((
                    recipient.to_hex(),
                    hex::encode(&active.payload_hash),
                    active_challenge["recovery_obligation_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )),
                active_headers,
                Extension(server.clone()),
            )
            .await,
            Err(PrivateMailboxError::RecoveryActive)
        ));

        let Json(challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(issue(&terminal.payload_hash)),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let challenge = serde_json::to_value(challenge).unwrap();
        let headers = signed_public_challenge_headers(
            &challenge,
            &client_mailbox_auth_preimage(&challenge, recipient),
        );
        assert_eq!(
            handle_ack_private_monad_recovery(
                Path((
                    recipient.to_hex(),
                    hex::encode(&terminal.payload_hash),
                    challenge["recovery_obligation_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )),
                headers,
                Extension(server.clone()),
            )
            .await
            .unwrap()
            .status(),
            StatusCode::NO_CONTENT
        );
        assert!(server
            .registry
            .monad_outbox_record(&terminal.payload_hash)
            .unwrap()
            .is_none());
        assert_eq!(
            server
                .registry
                .claim_monad_outbox(&blocked, &policy, 8, &config.limits)
                .unwrap(),
            MonadOutboxClaim::New,
            "acknowledgement must release the exact durable reservation"
        );

        let Json(retry_challenge) = handle_issue_mailbox_challenge(
            Path(recipient.to_hex()),
            Query(issue(&terminal.payload_hash)),
            Extension(server.clone()),
        )
        .await
        .unwrap();
        let retry_challenge = serde_json::to_value(retry_challenge).unwrap();
        let retry_headers = signed_public_challenge_headers(
            &retry_challenge,
            &client_mailbox_auth_preimage(&retry_challenge, recipient),
        );
        assert_eq!(
            handle_ack_private_monad_recovery(
                Path((
                    recipient.to_hex(),
                    hex::encode(&terminal.payload_hash),
                    retry_challenge["recovery_obligation_id"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                )),
                retry_headers,
                Extension(server),
            )
            .await
            .unwrap()
            .status(),
            StatusCode::NO_CONTENT,
            "a response-lost retry is idempotent"
        );
    }

    #[tokio::test]
    async fn private_auth_verifies_signature_and_rejects_replay_and_cross_recipient() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        let recipient = recipient_address();
        let runtime = server.monad_mailbox.as_enabled().unwrap();
        let binding = MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient,
            since: 7,
            cursor: None,
            limit: 10,
            max_bytes: 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        };
        let challenge = runtime.issue_challenge(&binding, now_ms());
        let digest = Sha256::digest(mailbox_auth_preimage(challenge, &binding, b"MONT").into());
        let signature =
            EccSecp256k1::default().sign(&recipient_seckey(), digest.byte_array().clone());
        let mut headers = HeaderMap::new();
        headers.insert(
            MAILBOX_EPOCH_HEADER,
            hex::encode(challenge.epoch).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_NONCE_HEADER,
            hex::encode(challenge.nonce).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_EXPIRY_HEADER,
            challenge.expires_at_ms.to_string().parse().unwrap(),
        );
        headers.insert(
            MAILBOX_TOKEN_HEADER,
            hex::encode(challenge.token).parse().unwrap(),
        );
        headers.insert(
            MAILBOX_SIGNATURE_HEADER,
            hex::encode(signature).parse().unwrap(),
        );

        let parsed = parse_private_authentication(&headers, &server, &binding).unwrap();
        let _permit = runtime.try_acquire_private_read().unwrap();
        authenticate_private_recipient(parsed, &server, &binding).unwrap();
        assert!(matches!(
            authenticate_private_recipient(
                parse_private_authentication(&headers, &server, &binding).unwrap(),
                &server,
                &binding,
            ),
            Err(PrivateMailboxError::Unauthorized)
        ));

        let cross_challenge = runtime.issue_challenge(&binding, now_ms());
        let mut cross_headers = headers;
        cross_headers.insert(
            MAILBOX_EPOCH_HEADER,
            hex::encode(cross_challenge.epoch).parse().unwrap(),
        );
        cross_headers.insert(
            MAILBOX_NONCE_HEADER,
            hex::encode(cross_challenge.nonce).parse().unwrap(),
        );
        cross_headers.insert(
            MAILBOX_EXPIRY_HEADER,
            cross_challenge.expires_at_ms.to_string().parse().unwrap(),
        );
        cross_headers.insert(
            MAILBOX_TOKEN_HEADER,
            hex::encode(cross_challenge.token).parse().unwrap(),
        );
        let cross_binding = MailboxRequestBinding {
            recipient: Address([9; 20]),
            ..binding
        };
        assert!(matches!(
            parse_private_authentication(&cross_headers, &server, &cross_binding),
            Err(PrivateMailboxError::Unauthorized)
        ));
    }

    fn enabled_test_server(registry: Registry) -> RegistryServer {
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        server
    }

    fn inbox_binding(recipient: Address) -> MailboxRequestBinding {
        MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient,
            since: 0,
            cursor: None,
            limit: 10,
            max_bytes: 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        }
    }

    /// The per-recipient consumed-challenge cap is a retryable resource condition, reported as
    /// `429` with `Retry-After`, and is distinguishable from an authentication failure (`401`).
    #[tokio::test]
    async fn exhausted_challenge_capacity_is_a_retryable_429_not_an_auth_failure() {
        let (_tempdir, registry) = test_registry();
        let server = enabled_test_server(registry);
        let recipient = recipient_address();
        let binding = inbox_binding(recipient);
        assert_eq!(MAX_USED_CHALLENGES_PER_RECIPIENT, 30);
        let mut replayable = None;
        for _ in 0..MAX_USED_CHALLENGES_PER_RECIPIENT {
            let headers = signed_private_headers(&server, &binding);
            let parsed = parse_private_authentication(&headers, &server, &binding).unwrap();
            authenticate_private_recipient(parsed, &server, &binding).unwrap();
            replayable = Some(headers);
        }

        // A fresh, correctly signed challenge now finds the recipient at capacity.
        let headers = signed_private_headers(&server, &binding);
        let parsed = parse_private_authentication(&headers, &server, &binding).unwrap();
        let err = authenticate_private_recipient(parsed, &server, &binding).unwrap_err();
        assert!(
            matches!(err, PrivateMailboxError::ChallengeCapacity),
            "{err:?}"
        );
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .unwrap(),
            "60",
            "capacity returns when live challenges expire (one challenge lifetime)"
        );
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "mailbox_challenge_capacity");

        // Replaying an already consumed nonce stays an ordinary authentication failure.
        let replay = authenticate_private_recipient(
            parse_private_authentication(&replayable.unwrap(), &server, &binding).unwrap(),
            &server,
            &binding,
        )
        .unwrap_err();
        assert!(
            matches!(replay, PrivateMailboxError::Unauthorized),
            "{replay:?}"
        );
        assert_eq!(replay.into_response().status(), StatusCode::UNAUTHORIZED);
    }

    /// An authenticated recipient learns nothing about obligations it does not own: another
    /// recipient's terminal or active claim and a nonexistent claim produce the same response.
    #[tokio::test]
    async fn recipient_ack_reveals_nothing_about_other_recipients_obligations() {
        let (_tempdir, registry) = test_registry();
        let limits = crate::monad_outbox::MonadOutboxReconcileConfig::default().limits;
        let other_seckey = EccSecp256k1::default()
            .seckey_from_array([0x42; 32])
            .unwrap();
        let other_pubkey = EccSecp256k1::default().derive_pubkey(&other_seckey);
        let other =
            crate::monad_stamp_stealth::recipient_address_from_public_key(other_pubkey.as_slice())
                .unwrap();
        let other_policy = MonadOutboxPolicy::new(
            other,
            other_pubkey.as_slice().to_vec(),
            10_000,
            b"MONT".to_vec(),
        )
        .unwrap();

        // A terminal claim (confirmed prefix, then a lost child) owned by `other`.
        let terminal = valid_signed_message_with_members(0xa1, &[0x81, 0x82]);
        assert_eq!(
            registry
                .claim_monad_outbox(&terminal, &other_policy, 1, &limits)
                .unwrap(),
            MonadOutboxClaim::New
        );
        let lease = match registry
            .acquire_monad_outbox_reconcile_lease(&terminal.payload_hash, 0, 2, &limits)
            .unwrap()
        {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        registry
            .complete_confirmed_monad_outbox_member(&terminal.payload_hash, 0, lease, 10_000, 7, 3)
            .unwrap();
        let lease = match registry
            .acquire_monad_outbox_reconcile_lease(&terminal.payload_hash, 1, 4, &limits)
            .unwrap()
        {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        registry
            .complete_terminal_monad_outbox_member(
                &terminal.payload_hash,
                1,
                lease,
                MonadOutboxTerminal::StaleNonce,
                "lost",
                5,
                &limits,
            )
            .unwrap();
        let obligation_id = registry
            .confirmed_monad_outbox_prefixes(other, 10)
            .unwrap()
            .into_iter()
            .find(|recovery| recovery.payload_hash == terminal.payload_hash.as_slice())
            .unwrap()
            .obligation_id;
        // And an active (pending) claim owned by `other`.
        let active = valid_signed_message(0xa2, 0x83);
        assert_eq!(
            registry
                .claim_monad_outbox(&active, &other_policy, 6, &limits)
                .unwrap(),
            MonadOutboxClaim::New
        );

        let server = enabled_test_server(registry);
        let recipient = recipient_address();
        assert_ne!(recipient, other);
        let ack = |payload_hash: Vec<u8>, obligation_id: [u8; 32]| {
            let server = server.clone();
            async move {
                let Json(challenge) = handle_issue_mailbox_challenge(
                    Path(recipient.to_hex()),
                    Query(PrivateChallengeQuery {
                        resource: "recovery_ack".to_string(),
                        since: None,
                        cursor: None,
                        limit: None,
                        max_bytes: None,
                        recovery_payload_hash: Some(hex::encode(&payload_hash)),
                        recovery_obligation_id: Some(hex::encode(obligation_id)),
                    }),
                    Extension(server.clone()),
                )
                .await
                .unwrap();
                let challenge = serde_json::to_value(challenge).unwrap();
                let headers = signed_public_challenge_headers(
                    &challenge,
                    &client_mailbox_auth_preimage(&challenge, recipient),
                );
                let response = handle_ack_private_monad_recovery(
                    Path((
                        recipient.to_hex(),
                        hex::encode(&payload_hash),
                        hex::encode(obligation_id),
                    )),
                    headers,
                    Extension(server),
                )
                .await
                .map(IntoResponse::into_response)
                .unwrap_or_else(IntoResponse::into_response);
                let status = response.status();
                let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
                (status, body)
            }
        };

        let foreign_terminal = ack(terminal.payload_hash.clone(), obligation_id).await;
        let foreign_active = ack(active.payload_hash.clone(), [0x11; 32]).await;
        let absent = ack(vec![0x77; 32], [0x22; 32]).await;
        assert_eq!(foreign_terminal.0, StatusCode::NO_CONTENT);
        assert_eq!(foreign_terminal, absent);
        assert_eq!(
            foreign_active, absent,
            "another recipient's active claim is not revealed"
        );
        // Nothing owned by `other` was touched, and its owner can still retire it.
        assert!(server
            .registry
            .monad_outbox_record(&terminal.payload_hash)
            .unwrap()
            .is_some());
        assert_eq!(
            server
                .registry
                .acknowledge_monad_outbox_recovery(other, &terminal.payload_hash, &obligation_id)
                .unwrap(),
            MonadRecoveryAck::Acknowledged
        );
    }

    /// Browsers can only read the pagination cursor when the relay exposes it via CORS.
    #[tokio::test]
    async fn cors_exposes_mailbox_cursor_header_and_allows_mailbox_auth_headers() {
        let (_tempdir, registry) = test_registry();
        let server = enabled_test_server(registry);
        let response = server
            .clone()
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/message/monad/inbox/{}",
                        recipient_address().to_hex()
                    ))
                    .header("origin", "https://client.example")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let exposed = response
            .headers()
            .get(axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS)
            .expect("actual responses must carry the CORS expose list")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(
            exposed
                .split(',')
                .any(|name| name.trim() == MAILBOX_NEXT_CURSOR_HEADER),
            "cursor header not exposed: {exposed}"
        );

        let preflight = server
            .into_router()
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri(format!("/message/monad/inbox/{}", recipient_address().to_hex()))
                    .header("origin", "https://client.example")
                    .header("access-control-request-method", "GET")
                    .header(
                        "access-control-request-headers",
                        format!(
                            "{MAILBOX_SIGNATURE_HEADER},{MAILBOX_TOKEN_HEADER},{MAILBOX_NONCE_HEADER},{MAILBOX_EPOCH_HEADER},{MAILBOX_EXPIRY_HEADER}"
                        ),
                    )
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let allowed = preflight
            .headers()
            .get(axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS)
            .expect("preflight must list allowed request headers")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        for header in [
            MAILBOX_SIGNATURE_HEADER,
            MAILBOX_TOKEN_HEADER,
            MAILBOX_NONCE_HEADER,
            MAILBOX_EPOCH_HEADER,
            MAILBOX_EXPIRY_HEADER,
        ] {
            assert!(allowed.contains(header), "{header} not allowed: {allowed}");
        }
    }

    #[test]
    fn oversized_auth_hex_and_cursor_are_rejected_before_signature_work() {
        let (_tempdir, registry) = test_registry();
        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(crate::monad_outbox::MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        );
        let binding = MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient: recipient_address(),
            since: 0,
            cursor: None,
            limit: 1,
            max_bytes: 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        };
        for header in [MAILBOX_EPOCH_HEADER, MAILBOX_SIGNATURE_HEADER] {
            let mut headers = signed_private_headers(&server, &binding);
            headers.insert(header, "aa".repeat(1024).parse().unwrap());
            crate::registry::reset_recipient_signature_work();
            assert!(matches!(
                parse_private_authentication(&headers, &server, &binding),
                Err(PrivateMailboxError::Unauthorized)
            ));
            assert_eq!(crate::registry::recipient_signature_work(), 0);
        }
        assert!(matches!(
            private_binding(
                &server,
                binding.recipient,
                MailboxResource::Inbox,
                0,
                Some(&"aa".repeat(4096)),
                1,
                1024,
                None,
                None,
            ),
            Err(PrivateMailboxError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn signed_recovery_cursor_survives_deleted_prior_row_and_matches_json_header(
    ) -> Result<(), Report> {
        let (_tempdir, registry) = test_registry();
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        let policy = test_outbox_policy();
        let mut messages = vec![
            valid_signed_message(0x81, 0x61),
            valid_signed_message(0x82, 0x62),
            valid_signed_message(0x83, 0x63),
        ];
        for message in &messages {
            assert!(matches!(
                registry.claim_monad_outbox(message, &policy, 1, &config.limits)?,
                MonadOutboxClaim::New
            ));
            let lease = match registry.acquire_monad_outbox_reconcile_lease(
                &message.payload_hash,
                0,
                2,
                &config.limits,
            )? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected recovery lease, got {other:?}"),
            };
            registry.complete_confirmed_monad_outbox_member(
                &message.payload_hash,
                0,
                lease,
                10_000,
                7,
                3,
            )?;
        }
        messages.sort_by(|left, right| left.payload_hash.cmp(&right.payload_hash));

        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config.clone()),
            10_000,
            b"MONT".to_vec(),
        );
        let recipient = recipient_address();
        let first_binding = MailboxRequestBinding {
            resource: MailboxResource::Recovery,
            recipient,
            since: 0,
            cursor: None,
            limit: 1,
            max_bytes: 64 * 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        };
        let mut first_request = axum::http::Request::builder()
            .method("GET")
            .uri(format!(
                "/message/monad/recovery/{}?limit=1&max_bytes={}",
                recipient.to_hex(),
                first_binding.max_bytes
            ))
            .body(axum::body::Body::empty())
            .unwrap();
        *first_request.headers_mut() = signed_private_headers(&server, &first_binding);
        let router = server.clone().into_router();
        let first_response = router.clone().oneshot(first_request).await.unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        let first_header = first_response
            .headers()
            .get(MAILBOX_NEXT_CURSOR_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let first_body = hyper::body::to_bytes(first_response.into_body())
            .await
            .unwrap();
        let first_body: Value = serde_json::from_slice(&first_body).unwrap();
        assert_eq!(first_body["next_cursor"], first_header);
        assert_eq!(
            first_body["recoveries"][0]["payload_hash"],
            hex::encode(&messages[0].payload_hash)
        );

        assert!(server
            .registry
            .mark_monad_outbox_fully_confirmed(&messages[0].payload_hash, 4)?);
        server.registry.finalize_monad_outbox(
            &messages[0].payload_hash,
            5,
            config.expected_chain_id,
            &config.limits,
        )?;
        let cursor = server
            .monad_mailbox
            .as_enabled()
            .unwrap()
            .decode_cursor(recipient, MailboxResource::Recovery, &first_header)
            .unwrap();
        assert_eq!(
            cursor,
            MailboxCursor::Recovery {
                payload_hash: messages[0].payload_hash.as_slice().try_into().unwrap()
            }
        );
        let second_binding = MailboxRequestBinding {
            cursor: Some(MailboxCursorBinding {
                position: cursor,
                token: first_header.clone(),
            }),
            ..first_binding
        };
        let mut second_request = axum::http::Request::builder()
            .method("GET")
            .uri(format!(
                "/message/monad/recovery/{}?cursor={}&limit=1&max_bytes={}",
                recipient.to_hex(),
                first_header,
                second_binding.max_bytes
            ))
            .body(axum::body::Body::empty())
            .unwrap();
        *second_request.headers_mut() = signed_private_headers(&server, &second_binding);
        let second_response = router.oneshot(second_request).await.unwrap();
        assert_eq!(second_response.status(), StatusCode::OK);
        let second_header = second_response
            .headers()
            .get(MAILBOX_NEXT_CURSOR_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let second_body = hyper::body::to_bytes(second_response.into_body())
            .await
            .unwrap();
        let second_body: Value = serde_json::from_slice(&second_body).unwrap();
        assert_eq!(second_body["next_cursor"], second_header);
        assert_eq!(
            second_body["recoveries"][0]["payload_hash"],
            hex::encode(&messages[1].payload_hash)
        );
        Ok(())
    }

    #[tokio::test]
    async fn private_recovery_fails_closed_on_corrupt_canonical_state() -> Result<(), Report> {
        let (_tempdir, registry) = test_registry();
        let config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        let policy = test_outbox_policy();
        let message = valid_signed_message(0x84, 0x64);
        registry.claim_monad_outbox(&message, &policy, 1, &config.limits)?;
        let lease = match registry.acquire_monad_outbox_reconcile_lease(
            &message.payload_hash,
            0,
            2,
            &config.limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected recovery lease, got {other:?}"),
        };
        registry.complete_confirmed_monad_outbox_member(
            &message.payload_hash,
            0,
            lease,
            10_000,
            7,
            3,
        )?;
        let mut corrupted = message.clone();
        corrupted.encrypted_payload.push(0xff);
        registry.replace_monad_outbox_canonical_for_test(&message.payload_hash, &corrupted)?;

        let mut server = test_server(registry);
        server.monad_mailbox = crate::monad_mailbox::MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config),
            10_000,
            b"MONT".to_vec(),
        );
        let binding = MailboxRequestBinding {
            resource: MailboxResource::Recovery,
            recipient: recipient_address(),
            since: 0,
            cursor: None,
            limit: 1,
            max_bytes: 64 * 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        };
        let headers = signed_private_headers(&server, &binding);
        let error = handle_get_private_monad_recovery(
            Path(recipient_address().to_hex()),
            Query(PrivateRecoveryQuery {
                cursor: None,
                limit: Some(1),
                max_bytes: Some(64 * 1024),
            }),
            headers,
            Extension(server),
        )
        .await
        .expect_err("corrupt recovery state must not be serialized");
        assert!(matches!(error, PrivateMailboxError::Infrastructure(_)));
        Ok(())
    }

    /// Store a valid, verified [`proto::MonadStampedMessage`] straight into `registry` (bypassing
    /// the HTTP `PUT` + stamp-verification machinery, which [`valid_stamp_is_accepted_and_stored`]
    /// already covers) with an explicit `timestamp`, for [`list_since`]-focused tests below where
    /// the interesting behavior is the read side, not verification.
    fn store_at(registry: &Registry, payload_hash: Vec<u8>, timestamp: i64) {
        let recipient = Address([0x44; 20]);
        let stored = proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
                stamp_payments: vec![proto::MonadStampPayment {
                    child_index: 0,
                    raw_tx: vec![1, 2, 3],
                }],
            }),
            timestamp,
            network_tag: Vec::new(),
        };
        registry
            .put_monad_message(&payload_hash, recipient, stored, &[])
            .unwrap();
    }

    /// Ticket #37's core acceptance criterion: a recipient can discover a newly-stored message
    /// via `GET /message/monad?since=<timestamp>` without ever having been told its
    /// `payload_hash` out of band -- the handler is called with only a `since` cursor, and the
    /// returned `payload_hash`es are read back *from the response*, never supplied to the call.
    #[tokio::test]
    async fn discovers_new_messages_via_list_since_without_knowing_payload_hash_up_front() {
        let (_tempdir, registry) = test_registry();
        let hash_a = vec![0xaa; 32];
        let hash_b = vec![0xbb; 32];
        store_at(&registry, hash_a.clone(), 100);
        store_at(&registry, hash_b.clone(), 200);

        let server = test_server(registry);

        let Protobuf(page) = handle_list_monad_messages(
            Query(ListMonadMessagesQuery { since: None }),
            Extension(server),
        )
        .await
        .expect("listing should succeed");

        let discovered_hashes: Vec<Vec<u8>> = page
            .messages
            .iter()
            .map(|m| m.message.as_ref().unwrap().payload_hash.clone())
            .collect();
        assert_eq!(discovered_hashes, vec![hash_a, hash_b]);
    }

    #[tokio::test]
    async fn list_since_excludes_messages_stored_before_the_cursor() {
        let (_tempdir, registry) = test_registry();
        let hash_old = vec![0x11; 32];
        let hash_new = vec![0x22; 32];
        store_at(&registry, hash_old, 100);
        store_at(&registry, hash_new.clone(), 200);

        let server = test_server(registry);

        let Protobuf(page) = handle_list_monad_messages(
            Query(ListMonadMessagesQuery { since: Some(150) }),
            Extension(server),
        )
        .await
        .expect("listing should succeed");

        assert_eq!(page.messages.len(), 1);
        assert_eq!(
            page.messages[0].message.as_ref().unwrap().payload_hash,
            hash_new
        );
    }

    #[tokio::test]
    async fn list_since_with_no_matching_messages_returns_an_empty_page() {
        let (_tempdir, registry) = test_registry();
        let server = test_server(registry);

        let Protobuf(page) = handle_list_monad_messages(
            Query(ListMonadMessagesQuery { since: Some(0) }),
            Extension(server),
        )
        .await
        .expect("listing should succeed even with nothing stored");

        assert!(page.messages.is_empty());
    }
}
