//! Durable HTTP admission and recipient-private reads for Monad-stamped direct messages.
//!
//! `PUT /message/monad` exists only when the process-owned mailbox runtime is enabled. Admission
//! validates the complete request before atomically claiming its exact bytes in the canonical
//! outbox, then uses the same reconciler and frozen policy as startup recovery. Only durable inbox
//! publication returns success.
//!
//! Inbox pagination and confirmed-prefix recovery require a registered-profile ECDSA signature
//! over a domain-, runtime-epoch-, nonce-, expiry-, method-, path-, recipient-, cursor-, limit-,
//! and network-bound request. Challenges are random, capped, short-lived and single-use. The old
//! unauthenticated exact/global GET routes are deliberately not installed.
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
//! **not** chain-agnostic despite living in the same crate. [`process_monad_message`] therefore
//! stores through a new, parallel path instead: [`Registry::put_monad_message`] /
//! [`crate::store::monad_messages::DbMonadMessages`] (see that module's docs for the full
//! reasoning).
//!
//! RPC endpoint and aggregate minimum come only from the validated `RegistryServer` mailbox
//! runtime; this module never reparses environment configuration.

#[cfg(test)]
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock, Weak},
};
use std::{collections::HashSet, fmt};

use axum::{
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::{BoundedProtobufBody, Protobuf};
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use prost::Message;
use serde::{Deserialize, Serialize};
use sha3::{Digest as _, Keccak256};
use tracing::Level;

const MAX_PRIVATE_MAILBOX_PAGE: usize = 100;
const MAILBOX_AUTH_DOMAIN: &[u8] = b"frank:mailbox-http-auth:v1\0";
const MAILBOX_EPOCH_HEADER: &str = "x-frank-mailbox-epoch";
const MAILBOX_NONCE_HEADER: &str = "x-frank-mailbox-nonce";
const MAILBOX_EXPIRY_HEADER: &str = "x-frank-mailbox-expires-at-ms";
const MAILBOX_SIGNATURE_HEADER: &str = "x-frank-mailbox-signature";

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{decode_signed_transaction, EvmTxError},
    monad_http::{Address, Hash32, JsonRpcTransport},
    monad_outbox::{reconcile_monad_outbox, MonadOutboxReconcileOutcome},
    monad_stamp_relay::StampRelayOutcome,
    monad_stamp_stealth::{derive_monad_stamp_child_public, StampStealthError},
    monad_stamp_verify::parse_commitment_calldata,
    proto,
    registry::Registry,
    store::monad_messages::MonadMessageAttemptClaim,
    store::monad_outbox::{
        MonadOutboxClaim, MonadOutboxLifecycle, MonadOutboxPolicy, MonadOutboxTerminal,
    },
};

#[cfg(test)]
use crate::{
    monad_http::HttpTransport,
    monad_stamp_relay::{broadcast_and_verify_stamp, PollConfig},
    monad_stamp_verify::ExpectedStampTransaction,
    store::monad_messages::MonadMessageAttemptPolicy,
};

const MAX_STAMP_PAYMENTS: usize = 64;
const MAX_MONAD_MESSAGE_BODY_BYTES: usize = 2 * 1024 * 1024;
const MIN_ENVELOPE_BODY_HEADROOM_BYTES: usize = 128 * 1024;
const MAX_ENVELOPE_JSON_OVERHEAD_BYTES: usize = 1024;
const MAX_ENVELOPE_CIPHERTEXT_BYTES: usize = (MAX_MONAD_MESSAGE_BODY_BYTES
    - MIN_ENVELOPE_BODY_HEADROOM_BYTES
    - MAX_ENVELOPE_JSON_OVERHEAD_BYTES)
    / 2;
const MAX_ENVELOPE_NETWORK_TAG_BYTES: usize = 32;
const ENVELOPE_HKDF_SALT_BYTES: usize = 32;
const ENVELOPE_GCM_NONCE_BYTES: usize = 12;
const ENVELOPE_GCM_TAG_BYTES: usize = 16;
#[cfg(test)]
static PAYMENT_SET_LOCKS: OnceLock<
    tokio::sync::Mutex<HashMap<(usize, [u8; 32]), Weak<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();
#[cfg(test)]
static PAYMENT_RELAY_SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
#[cfg(test)]
const MAX_CONCURRENT_PAYMENT_RELAYS: usize = 32;
#[cfg(test)]
const PAYMENT_RELAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(test)]
async fn try_lock_payment_set(
    registry_id: usize,
    payload_hash: [u8; 32],
) -> Result<tokio::sync::OwnedMutexGuard<()>, ProcessMonadMessageError> {
    let locks = PAYMENT_SET_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let lock = {
        let mut locks = locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let key = (registry_id, payload_hash);
        match locks.get(&key).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        }
    };
    lock.try_lock_owned()
        .map_err(|_| ProcessMonadMessageError::PaymentSetBusy)
}

/// Errors processing a [`proto::MonadStampedMessage`], independent of HTTP/axum (see
/// [`process_monad_message`]) so this logic can be unit-tested directly against a mock
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
    /// A direct message must carry at least one payment transaction.
    MissingStampPayments,
    /// Payment-set cardinality is bounded before any transaction cryptography or RPC work.
    TooManyStampPayments(usize),
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
    /// The exact durable claim remains pending after this bounded request.
    OutboxPending,
    /// A claimed row disappeared while the bounded reconciler was running.
    OutboxUnavailable,
    /// The exact durable claim reached a stable terminal state.
    OutboxTerminal(MonadOutboxTerminal),
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
            ProcessMonadMessageError::MissingStampPayments => {
                write!(f, "a direct message requires at least one stamp payment")
            }
            ProcessMonadMessageError::TooManyStampPayments(actual) => write!(
                f,
                "a direct message may contain at most {MAX_STAMP_PAYMENTS} stamp payments, got {actual}"
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
            ProcessMonadMessageError::OutboxPending => {
                write!(f, "the exact stamp-payment set is pending durable reconciliation")
            }
            ProcessMonadMessageError::OutboxUnavailable => {
                write!(f, "the durable stamp outbox is temporarily unavailable")
            }
            ProcessMonadMessageError::OutboxTerminal(terminal) => {
                write!(f, "the exact stamp-payment set is terminal: {terminal:?}")
            }
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
                write!(f, "Monad stamp rejected before retaining its payment set: {outcome:?}")
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

const PAYMENT_COMMITMENT_DOMAIN: &[u8] = b"frank:dm-stamp-payment:v1";

fn payment_commitment(payload_hash: &[u8; 32], child_index: u32) -> Sha256 {
    let mut preimage = Vec::with_capacity(PAYMENT_COMMITMENT_DOMAIN.len() + 36);
    preimage.extend_from_slice(PAYMENT_COMMITMENT_DOMAIN);
    preimage.extend_from_slice(payload_hash);
    preimage.extend_from_slice(&child_index.to_be_bytes());
    Sha256::digest(preimage.into())
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
) -> Result<(), ProcessMonadMessageError> {
    if request.stamp_payments.is_empty() {
        return Err(ProcessMonadMessageError::MissingStampPayments);
    }
    if request.stamp_payments.len() > MAX_STAMP_PAYMENTS {
        return Err(ProcessMonadMessageError::TooManyStampPayments(
            request.stamp_payments.len(),
        ));
    }
    let mut child_indices = HashSet::new();
    let mut funding_accounts = HashSet::new();
    let mut transaction_hashes = HashSet::new();
    let mut destination_addresses = HashSet::new();
    let mut total_value_wei = 0u128;
    for (position, payment) in request.stamp_payments.iter().enumerate() {
        if payment.child_index as usize != position {
            return Err(ProcessMonadMessageError::NonCanonicalChildIndex {
                position,
                actual: payment.child_index,
            });
        }
        if !child_indices.insert(payment.child_index) {
            return Err(ProcessMonadMessageError::DuplicateChildIndex(
                payment.child_index,
            ));
        }
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .map_err(ProcessMonadMessageError::FundingAccountRecoveryFailed)?;
        if !transaction_hashes.insert(decoded.tx_hash) {
            return Err(ProcessMonadMessageError::DuplicateTransaction(
                decoded.tx_hash,
            ));
        }
        if !funding_accounts.insert(decoded.sender) {
            return Err(ProcessMonadMessageError::DuplicateFundingAccount(
                decoded.sender,
            ));
        }
        let destination = derive_monad_stamp_child_public(
            payload_hash,
            &policy.recipient_pubkey,
            payment.child_index,
        )
        .map_err(ProcessMonadMessageError::InvalidStealthDestination)?;
        let destination_address = Address(destination.address);
        destination_addresses.insert(destination_address);
        let expected_commitment = payment_commitment(&payload_hash, payment.child_index);
        if decoded.destination != Some(destination_address) {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "destination {:?} does not match expected {destination_address}",
                    decoded.destination
                ),
            });
        }
        if decoded.value_wei == 0 {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: "value must be positive".to_string(),
            });
        }
        let actual_commitment =
            parse_commitment_calldata(BROADCAST_MESSAGE_LOKAD_ID, &decoded.input).map_err(
                |err| ProcessMonadMessageError::InvalidPaymentPreflight {
                    child_index: payment.child_index,
                    detail: err.to_string(),
                },
            )?;
        if actual_commitment != expected_commitment {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "commitment {actual_commitment} does not match expected {expected_commitment}"
                ),
            });
        }
        total_value_wei = total_value_wei
            .checked_add(decoded.value_wei)
            .ok_or(ProcessMonadMessageError::TotalValueOverflow)?;
    }
    if let Some(address) = funding_accounts.intersection(&destination_addresses).next() {
        return Err(ProcessMonadMessageError::FundingAccountIsDestination(
            *address,
        ));
    }
    if total_value_wei < policy.min_value_wei {
        return Err(ProcessMonadMessageError::InsufficientTotalValue {
            required: policy.min_value_wei,
            actual: total_value_wei,
        });
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

/// Validate, atomically claim, and reconcile one request through durable inbox publication.
async fn admit_monad_message<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    config: &crate::monad_outbox::MonadOutboxReconcileConfig,
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
    if let Some(existing) = registry
        .get_monad_message(declared_hash.as_slice())
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        return if existing.message.as_ref() == Some(&request) {
            Ok(existing)
        } else {
            Err(ProcessMonadMessageError::ConflictingPaymentSet)
        };
    }

    let canonical = request.encode_to_vec();
    if let Some(existing) = registry
        .monad_outbox_record(declared_hash.as_slice())
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        if existing.canonical_message.as_deref() != Some(canonical.as_slice()) {
            return Err(ProcessMonadMessageError::ConflictingPaymentSet);
        }
        return match reconcile_monad_outbox(transport, registry, declared_hash.as_slice(), config)
            .await
            .map_err(ProcessMonadMessageError::Infrastructure)?
        {
            MonadOutboxReconcileOutcome::Delivered(stored) => Ok(stored),
            MonadOutboxReconcileOutcome::Pending => Err(ProcessMonadMessageError::OutboxPending),
            MonadOutboxReconcileOutcome::Terminal(terminal) => {
                Err(ProcessMonadMessageError::OutboxTerminal(terminal))
            }
            MonadOutboxReconcileOutcome::Missing => {
                Err(ProcessMonadMessageError::OutboxUnavailable)
            }
        };
    }

    let policy = match registry
        .get_monad_message_attempt(declared_hash.as_slice(), &request)
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadMessageAttemptClaim::ExistingExact(legacy) => {
            let routing = routing_from_claimed_envelope(&request.encrypted_payload)?;
            MonadOutboxPolicy {
                recipient: routing.recipient,
                recipient_pubkey: legacy.recipient_pubkey,
                min_value_wei: legacy.min_value_wei,
                network_tag: legacy
                    .network_tag
                    .or(routing.network_tag)
                    .unwrap_or_default(),
            }
        }
        MonadMessageAttemptClaim::Conflict => {
            return Err(ProcessMonadMessageError::ConflictingPaymentSet)
        }
        MonadMessageAttemptClaim::Missing => {
            let recipient = validate_envelope(&request.encrypted_payload, network_tag)?.recipient;
            let profile = registry
                .get_monad_profile(recipient)
                .map_err(ProcessMonadMessageError::Infrastructure)?
                .ok_or(ProcessMonadMessageError::RecipientProfileNotFound(
                    recipient,
                ))?;
            MonadOutboxPolicy {
                recipient,
                recipient_pubkey: profile.pubkey,
                min_value_wei,
                network_tag: network_tag.to_vec(),
            }
        }
        MonadMessageAttemptClaim::New => unreachable!("lookup cannot create an attempt"),
    };
    let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().expect("checked");
    validate_payment_set(&request, payload_hash, &policy)?;
    match registry
        .claim_monad_outbox(&request, &policy, now_ms(), &config.limits)
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadOutboxClaim::Conflict => return Err(ProcessMonadMessageError::ConflictingPaymentSet),
        MonadOutboxClaim::AtCapacity => return Err(ProcessMonadMessageError::OutboxAtCapacity),
        MonadOutboxClaim::New | MonadOutboxClaim::ExistingExact(_) => {}
    }
    match reconcile_monad_outbox(transport, registry, declared_hash.as_slice(), config)
        .await
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        MonadOutboxReconcileOutcome::Delivered(stored) => Ok(stored),
        MonadOutboxReconcileOutcome::Pending => Err(ProcessMonadMessageError::OutboxPending),
        MonadOutboxReconcileOutcome::Terminal(terminal) => {
            Err(ProcessMonadMessageError::OutboxTerminal(terminal))
        }
        MonadOutboxReconcileOutcome::Missing => Err(ProcessMonadMessageError::OutboxUnavailable),
    }
}

/// Decode, verify, broadcast-and-confirm, and (on success) store a [`proto::MonadStampedMessage`].
///
/// Mirrors `Registry::put_message`'s Lotus flow (decode -> verify stamp -> store) at a high level,
/// but every step is Monad-specific:
/// 1. `payload_hash` must be exactly 32 bytes and match `SHA256(encrypted_payload)` (the
///    client-side integrity check `SignedPayload::parse_proto` does for Lotus).
/// 2. The recipient routing address is parsed from the envelope and resolved to its registered
///    secp256k1 public key.
/// 3. Each raw payment signature recovers a distinct disposable funding account. This does not
///    authenticate the claimed message author and deliberately preserves deniability.
/// 4. For every declared child index, the relay independently derives the expected one-time
///    destination from the recipient public key and payload hash, broadcasts the transaction, and
///    verifies its destination, commitment, success, and positive value.
/// 5. The independently verified values must sum to at least `min_value_wei`. A single payment is
///    valid fallback; using two or more is a sender-side privacy goal, not a relay validity rule.
/// 6. Only [`StampRelayOutcome::Verified`] leads to a store, via [`Registry::put_monad_message`]
///    -- every other outcome is [`ProcessMonadMessageError::Rejected`].
///
/// `network_tag` (ticket #39, see `crate::network_tag`'s module docs) is stamped onto the stored
/// record by [`Registry::put_monad_message`] itself -- passed through here as an explicit
/// parameter (resolved by the caller from [`crate::network_tag::frank_network_tag`]) rather than
/// read from the environment inside this function, mirroring how `min_value_wei`/`poll` are
/// already resolved by the HTTP handler and threaded in, keeping this function directly
/// unit-testable against a mock transport without touching real process environment state.
#[cfg(test)]
pub async fn process_monad_message<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    min_value_wei: u128,
    poll: PollConfig,
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
    // Completed exact retries are immutable historical facts. Return them before consulting
    // mutable current relay policy (envelope version, minimum value, profile rotation, network
    // configuration). The hash was still checked above, and exact request equality prevents a
    // caller from rebinding the stored payload to another payment set.
    if let Some(existing) = registry
        .get_monad_message(declared_hash.as_slice())
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        if existing.message.as_ref() == Some(&request) {
            return Ok(existing);
        }
        return Err(ProcessMonadMessageError::ConflictingPaymentSet);
    }
    if request.stamp_payments.is_empty() {
        return Err(ProcessMonadMessageError::MissingStampPayments);
    }
    if request.stamp_payments.len() > MAX_STAMP_PAYMENTS {
        return Err(ProcessMonadMessageError::TooManyStampPayments(
            request.stamp_payments.len(),
        ));
    }

    let payload_hash: [u8; 32] = request
        .payload_hash
        .as_slice()
        .try_into()
        .expect("payload hash length was checked above");

    // Serialize one payload hash from durable claim through final storage. This prevents two
    // concurrent requests from broadcasting different sets before either one becomes visible.
    let registry_id = registry as *const Registry as usize;
    let _payment_set_guard = try_lock_payment_set(registry_id, payload_hash).await?;
    if let Some(existing) = registry
        .get_monad_message(declared_hash.as_slice())
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        if existing.message.as_ref() == Some(&request) {
            return Ok(existing);
        }
        return Err(ProcessMonadMessageError::ConflictingPaymentSet);
    }
    let existing_attempt = registry
        .get_monad_message_attempt(declared_hash.as_slice(), &request)
        .map_err(ProcessMonadMessageError::Infrastructure)?;
    let (policy, recipient, admitted_network_tag) = match &existing_attempt {
        MonadMessageAttemptClaim::ExistingExact(policy) => {
            let routing = routing_from_claimed_envelope(&request.encrypted_payload)?;
            // Format-v1 claims predate frozen network attribution. Recover their historically
            // admitted optional tag from the exact payload. If the base historical shape had no
            // tag, preserve that uncertainty as the established empty/unknown stored tag rather
            // than falsely rebinding the record to today's relay configuration.
            let admitted_network_tag = policy
                .network_tag
                .clone()
                .or(routing.network_tag)
                .unwrap_or_default();
            (policy.clone(), routing.recipient, admitted_network_tag)
        }
        MonadMessageAttemptClaim::Conflict => {
            return Err(ProcessMonadMessageError::ConflictingPaymentSet)
        }
        MonadMessageAttemptClaim::Missing => {
            // Only a genuinely new payload is subject to today's admission policy. In particular,
            // do not strand a pre-upgrade v1 attempt after one of its exact payments was already
            // broadcast: its durable claim freezes the policy and owns these exact bytes.
            let recipient = validate_envelope(&request.encrypted_payload, network_tag)?.recipient;
            let recipient_profile = registry
                .get_monad_profile(recipient)
                .map_err(ProcessMonadMessageError::Infrastructure)?
                .ok_or(ProcessMonadMessageError::RecipientProfileNotFound(
                    recipient,
                ))?;
            (
                MonadMessageAttemptPolicy {
                    recipient_pubkey: recipient_profile.pubkey,
                    min_value_wei,
                    network_tag: Some(network_tag.to_vec()),
                },
                recipient,
                network_tag.to_vec(),
            )
        }
        MonadMessageAttemptClaim::New => unreachable!("lookup cannot create an attempt"),
    };
    let _relay_slot = PAYMENT_RELAY_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAYMENT_RELAYS)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ProcessMonadMessageError::RelayBusy)?;

    let mut child_indices = HashSet::new();
    let mut funding_accounts = HashSet::new();
    let mut transaction_hashes = HashSet::new();
    let mut expected_payments = Vec::with_capacity(request.stamp_payments.len());
    let mut destination_addresses = HashSet::new();
    let mut preflight_total_value_wei = 0u128;
    for (position, payment) in request.stamp_payments.iter().enumerate() {
        if payment.child_index as usize != position {
            return Err(ProcessMonadMessageError::NonCanonicalChildIndex {
                position,
                actual: payment.child_index,
            });
        }
        if !child_indices.insert(payment.child_index) {
            return Err(ProcessMonadMessageError::DuplicateChildIndex(
                payment.child_index,
            ));
        }
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .map_err(ProcessMonadMessageError::FundingAccountRecoveryFailed)?;
        if !transaction_hashes.insert(decoded.tx_hash) {
            return Err(ProcessMonadMessageError::DuplicateTransaction(
                decoded.tx_hash,
            ));
        }
        if !funding_accounts.insert(decoded.sender) {
            return Err(ProcessMonadMessageError::DuplicateFundingAccount(
                decoded.sender,
            ));
        }
        let destination = derive_monad_stamp_child_public(
            payload_hash,
            &policy.recipient_pubkey,
            payment.child_index,
        )
        .map_err(ProcessMonadMessageError::InvalidStealthDestination)?;
        let destination_address = Address(destination.address);
        destination_addresses.insert(destination_address);
        let expected_commitment = payment_commitment(&payload_hash, payment.child_index);
        if decoded.destination != Some(destination_address) {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "destination {:?} does not match expected {destination_address}",
                    decoded.destination
                ),
            });
        }
        if decoded.value_wei == 0 {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: "value must be positive".to_string(),
            });
        }
        let actual_commitment =
            parse_commitment_calldata(BROADCAST_MESSAGE_LOKAD_ID, &decoded.input).map_err(
                |err| ProcessMonadMessageError::InvalidPaymentPreflight {
                    child_index: payment.child_index,
                    detail: err.to_string(),
                },
            )?;
        if actual_commitment != expected_commitment {
            return Err(ProcessMonadMessageError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "commitment {actual_commitment} does not match expected {expected_commitment}"
                ),
            });
        }
        preflight_total_value_wei = preflight_total_value_wei
            .checked_add(decoded.value_wei)
            .ok_or(ProcessMonadMessageError::TotalValueOverflow)?;
        expected_payments.push(ExpectedStampTransaction {
            commitment_id: BROADCAST_MESSAGE_LOKAD_ID,
            commitment: expected_commitment,
            destination_address,
            // The configured minimum applies to the set. Requiring one wei here rejects zero-value
            // padding entries without forcing any particular split across the real payments.
            min_value_wei: 1,
        });
    }
    if let Some(address) = funding_accounts.intersection(&destination_addresses).next() {
        return Err(ProcessMonadMessageError::FundingAccountIsDestination(
            *address,
        ));
    }
    if preflight_total_value_wei < policy.min_value_wei {
        return Err(ProcessMonadMessageError::InsufficientTotalValue {
            required: policy.min_value_wei,
            actual: preflight_total_value_wei,
        });
    }

    if matches!(existing_attempt, MonadMessageAttemptClaim::Missing) {
        match registry
            .claim_monad_message_attempt(declared_hash.as_slice(), &request, &policy)
            .map_err(ProcessMonadMessageError::Infrastructure)?
        {
            MonadMessageAttemptClaim::New => {}
            MonadMessageAttemptClaim::ExistingExact(_)
            | MonadMessageAttemptClaim::Conflict
            | MonadMessageAttemptClaim::Missing => {
                return Err(ProcessMonadMessageError::ConflictingPaymentSet)
            }
        }
    }

    let mut total_value_wei = 0u128;
    for (payment, expected) in request.stamp_payments.iter().zip(&expected_payments) {
        let outcome = tokio::time::timeout(
            PAYMENT_RELAY_TIMEOUT,
            broadcast_and_verify_stamp(transport, &payment.raw_tx, expected, poll),
        )
        .await
        .map_err(|_| ProcessMonadMessageError::RelayTimedOut)?
        .map_err(ProcessMonadMessageError::Infrastructure)?;
        match outcome {
            StampRelayOutcome::Verified { value_wei, .. } => {
                total_value_wei = total_value_wei
                    .checked_add(value_wei)
                    .ok_or(ProcessMonadMessageError::TotalValueOverflow)?;
            }
            outcome @ StampRelayOutcome::BroadcastFailed(
                crate::monad_http::MonadRpcError::InsufficientFunds { .. },
            ) if total_value_wei == 0 => {
                // The node definitively refused the first member; no prefix can have landed in
                // this attempt. Releasing the claim avoids a free, permanent disk-growth vector.
                // Transport errors, nonce ambiguity, timeouts, and failures after any verified
                // prefix deliberately retain the exact set.
                registry
                    .delete_monad_message_attempt(declared_hash.as_slice())
                    .map_err(ProcessMonadMessageError::Infrastructure)?;
                return Err(ProcessMonadMessageError::RejectedWithoutRetainedSet(
                    outcome,
                ));
            }
            outcome @ StampRelayOutcome::VerificationFailed { .. } => {
                // The exact transaction has a confirmed receipt and permanently failed stamp
                // verification. Replaying the same signed bytes cannot change that result, even
                // if an earlier member of this set verified. Release the claim so the client can
                // retire every sender account in the failed set and construct a replacement.
                registry
                    .delete_monad_message_attempt(declared_hash.as_slice())
                    .map_err(ProcessMonadMessageError::Infrastructure)?;
                return Err(ProcessMonadMessageError::RejectedWithoutRetainedSet(
                    outcome,
                ));
            }
            other => return Err(ProcessMonadMessageError::Rejected(other)),
        }
    }
    if total_value_wei < policy.min_value_wei {
        return Err(ProcessMonadMessageError::InsufficientTotalValue {
            required: policy.min_value_wei,
            actual: total_value_wei,
        });
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let stored = proto::StoredMonadMessage {
        message: Some(request),
        timestamp,
        network_tag: Vec::new(),
    };

    let stored = registry
        .put_monad_message(
            declared_hash.as_slice(),
            recipient,
            stored,
            &admitted_network_tag,
        )
        .map_err(ProcessMonadMessageError::Infrastructure)?;

    Ok(stored)
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
    /// [`process_monad_message`] rejected (or failed to process) the message.
    Process(ProcessMonadMessageError),
}

fn exact_set_retained(err: &ProcessMonadMessageError) -> Option<bool> {
    match err {
        ProcessMonadMessageError::Rejected(_)
        | ProcessMonadMessageError::RelayTimedOut
        | ProcessMonadMessageError::OutboxPending => Some(true),
        ProcessMonadMessageError::RejectedWithoutRetainedSet(_) => Some(false),
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
                    exact_set_retained: Some(true),
                }),
            )
                .into_response(),
            PutMonadMessageError::Process(err @ ProcessMonadMessageError::OutboxTerminal(_)) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(MonadMessageErrorBody {
                    error: "mailbox_terminal",
                    detail: err.to_string(),
                    exact_set_retained: Some(true),
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

/// `PUT /message/monad`: decode a [`proto::MonadStampedMessage`], recover its sender, verify its
/// Monad stamp (broadcasting it, per ticket #19), and store it on success.
pub async fn handle_put_monad_message(
    BoundedProtobufBody(body): BoundedProtobufBody<MAX_MONAD_MESSAGE_BODY_BYTES>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessage>, PutMonadMessageError> {
    validate_payment_wire_cardinality(&body).map_err(PutMonadMessageError::Decode)?;
    let message = proto::MonadStampedMessage::decode(body.as_slice())
        .map_err(|err| PutMonadMessageError::Decode(err.to_string()))?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .expect("disabled mailbox has no PUT route");
    let stored = admit_monad_message(
        runtime.transport(),
        &server.registry,
        runtime.reconcile(),
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
    signing_domain: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConfirmedPrefixBody {
    payload_hash: String,
    canonical_message: String,
    confirmed_children: Vec<u32>,
    lifecycle: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConfirmedPrefixesBody {
    recoveries: Vec<ConfirmedPrefixBody>,
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
    after: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PrivateRecoveryQuery {
    limit: Option<usize>,
}

#[derive(Debug)]
pub(crate) enum PrivateMailboxError {
    Unauthorized,
    InvalidRecipient,
    InvalidLimit,
    AtCapacity,
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
            Self::AtCapacity => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "mailbox_auth_retryable"})),
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

fn parse_private_recipient(value: &str) -> Result<Address, PrivateMailboxError> {
    Address::from_hex(value).map_err(|_| PrivateMailboxError::InvalidRecipient)
}

fn mailbox_auth_preimage(
    epoch: [u8; 32],
    nonce: [u8; 32],
    expires_at_ms: i64,
    method: &str,
    path: &str,
    recipient: Address,
    since: i64,
    after: Option<[u8; 32]>,
    limit: usize,
    network_tag: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(160 + path.len() + network_tag.len());
    bytes.extend_from_slice(MAILBOX_AUTH_DOMAIN);
    bytes.extend_from_slice(&epoch);
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(method.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(path.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&recipient.0);
    bytes.extend_from_slice(&since.to_be_bytes());
    match after {
        Some(after) => {
            bytes.push(1);
            bytes.extend_from_slice(&after);
        }
        None => bytes.push(0),
    }
    bytes.extend_from_slice(&(limit as u64).to_be_bytes());
    bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
    bytes.extend_from_slice(network_tag);
    bytes
}

async fn authenticate_private_mailbox(
    headers: &HeaderMap,
    server: &RegistryServer,
    recipient: Address,
    method: &str,
    path: &str,
    since: i64,
    after: Option<[u8; 32]>,
    limit: usize,
) -> Result<(), PrivateMailboxError> {
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let parse_hex_header = |name: &'static str| -> Result<[u8; 32], PrivateMailboxError> {
        let value = headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or(PrivateMailboxError::Unauthorized)?;
        let decoded = hex::decode(value).map_err(|_| PrivateMailboxError::Unauthorized)?;
        decoded
            .try_into()
            .map_err(|_| PrivateMailboxError::Unauthorized)
    };
    let epoch = parse_hex_header(MAILBOX_EPOCH_HEADER)?;
    let nonce = parse_hex_header(MAILBOX_NONCE_HEADER)?;
    let expires_at_ms = headers
        .get(MAILBOX_EXPIRY_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let signature = headers
        .get(MAILBOX_SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| hex::decode(value).ok())
        .ok_or(PrivateMailboxError::Unauthorized)?;
    let digest = Sha256::digest(
        mailbox_auth_preimage(
            epoch,
            nonce,
            expires_at_ms,
            method,
            path,
            recipient,
            since,
            after,
            limit,
            runtime.network_tag(),
        )
        .into(),
    );
    let signature_valid = server
        .registry
        .verify_monad_recipient_signature(
            recipient,
            digest.as_slice().try_into().expect("SHA256 is 32 bytes"),
            &signature,
        )
        .map_err(PrivateMailboxError::Infrastructure)?;
    if !signature_valid
        || !runtime.consume_challenge(recipient, epoch, nonce, expires_at_ms, now_ms())
    {
        return Err(PrivateMailboxError::Unauthorized);
    }
    Ok(())
}

/// Issue a bounded one-time challenge without revealing whether the recipient is registered.
pub(crate) async fn handle_issue_mailbox_challenge(
    Path(recipient): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Json<MailboxChallengeBody>, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let challenge = server
        .monad_mailbox
        .as_enabled()
        .and_then(|runtime| runtime.issue_challenge(recipient, now_ms()))
        .ok_or(PrivateMailboxError::AtCapacity)?;
    Ok(Json(MailboxChallengeBody {
        epoch: hex::encode(challenge.epoch),
        nonce: hex::encode(challenge.nonce),
        expires_at_ms: challenge.expires_at_ms,
        signing_domain: "frank:mailbox-http-auth:v1",
    }))
}

/// Return one authenticated, recipient-scoped, capped inbox page.
pub(crate) async fn handle_get_private_monad_messages(
    Path(recipient): Path<String>,
    Query(params): Query<PrivateInboxQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessages>, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let since = params.since.unwrap_or(0);
    let after = params
        .after
        .as_deref()
        .map(hex::decode)
        .transpose()
        .map_err(|_| PrivateMailboxError::InvalidLimit)?
        .map(|bytes| {
            bytes
                .try_into()
                .map_err(|_| PrivateMailboxError::InvalidLimit)
        })
        .transpose()?;
    let limit = private_limit(params.limit, 50)?;
    let path = format!("/message/monad/inbox/{}", recipient.to_hex());
    authenticate_private_mailbox(
        &headers, &server, recipient, "GET", &path, since, after, limit,
    )
    .await?;
    let messages = server
        .registry
        .list_monad_messages_for_recipient_since_capped(recipient, since, after, limit)
        .map_err(PrivateMailboxError::Infrastructure)?;
    Ok(Protobuf(proto::StoredMonadMessages { messages }))
}

/// Return authenticated confirmed-prefix recovery facts for one recipient.
pub(crate) async fn handle_get_private_monad_recovery(
    Path(recipient): Path<String>,
    Query(params): Query<PrivateRecoveryQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Result<Json<ConfirmedPrefixesBody>, PrivateMailboxError> {
    let recipient = parse_private_recipient(&recipient)?;
    let limit = private_limit(params.limit, 20)?;
    let path = format!("/message/monad/recovery/{}", recipient.to_hex());
    authenticate_private_mailbox(&headers, &server, recipient, "GET", &path, 0, None, limit)
        .await?;
    let recoveries = server
        .registry
        .confirmed_monad_outbox_prefixes(recipient, limit)
        .map_err(PrivateMailboxError::Infrastructure)?
        .into_iter()
        .map(|recovery| ConfirmedPrefixBody {
            payload_hash: hex::encode(recovery.payload_hash),
            canonical_message: hex::encode(recovery.message.encode_to_vec()),
            confirmed_children: recovery
                .confirmed_prefix
                .into_iter()
                .map(|member| member.child_index)
                .collect(),
            lifecycle: recovery_lifecycle(recovery.lifecycle),
        })
        .collect();
    Ok(Json(ConfirmedPrefixesBody { recoveries }))
}

/// Error type for [`handle_get_monad_message`].
#[derive(Debug)]
pub enum GetMonadMessageError {
    /// The `:payload_hash` path segment wasn't valid hex.
    InvalidHex(hex::FromHexError),
    /// No message stored for the given `payload_hash`.
    NotFound,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for GetMonadMessageError {
    fn into_response(self) -> Response {
        match self {
            GetMonadMessageError::InvalidHex(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadMessageErrorBody {
                    error: "invalid_payload_hash",
                    detail: err.to_string(),
                    exact_set_retained: None,
                }),
            )
                .into_response(),
            GetMonadMessageError::NotFound => StatusCode::NOT_FOUND.into_response(),
            GetMonadMessageError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure fetching Monad message");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad/:payload_hash`: fetch a previously-stored [`proto::StoredMonadMessage`] by
/// its hex-encoded `payload_hash`. Exists mainly so the accept path (this ticket's acceptance
/// criteria) can be proven end-to-end: PUT, then GET the same `payload_hash` back.
pub async fn handle_get_monad_message(
    Path(hex_hash): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessage>, GetMonadMessageError> {
    let payload_hash = hex::decode(&hex_hash).map_err(GetMonadMessageError::InvalidHex)?;
    let stored = server
        .registry
        .get_monad_message(&payload_hash)
        .map_err(GetMonadMessageError::Infrastructure)?
        .ok_or(GetMonadMessageError::NotFound)?;
    Ok(Protobuf(stored))
}

/// Query parameters for [`handle_list_monad_messages`].
#[derive(Debug, Deserialize)]
pub struct ListMonadMessagesQuery {
    /// Only return messages stored at or after this many milliseconds since the Unix epoch.
    /// Defaults to `0` (i.e. every stored message) when omitted.
    since: Option<i64>,
}

/// Error type for [`handle_list_monad_messages`].
#[derive(Debug)]
pub enum ListMonadMessagesError {
    /// A storage-level error.
    Infrastructure(Report),
}

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
pub async fn handle_list_monad_messages(
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
        collections::{HashMap, VecDeque},
        fmt,
        sync::{Arc, Mutex},
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
        monad_evm_tx::test_support::signed_eip1559_tx, monad_http::MonadRpcError,
        monad_stamp_relay::PollConfig, store::db::Db,
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

    /// [`ChainAdapter`] stub: `process_monad_message`/`Registry::put_monad_message` never touch
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

    fn fast_poll() -> PollConfig {
        PollConfig {
            interval: std::time::Duration::from_millis(1),
            max_attempts: 3,
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
        response_sequences: Arc<Mutex<HashMap<String, VecDeque<Value>>>>,
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

        fn set_sequence(&self, method: &str, responses: Vec<Value>) -> &Self {
            self.response_sequences
                .lock()
                .unwrap()
                .insert(method.to_string(), responses.into());
            self
        }
    }

    impl fmt::Debug for MockTransport {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("MockTransport").finish()
        }
    }

    #[derive(Clone, Debug, Default)]
    struct InsufficientFundsTransport;

    #[async_trait]
    impl JsonRpcTransport for InsufficientFundsTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            if method == "eth_sendRawTransaction" {
                return Err(MonadRpcError::InsufficientFunds {
                    method: method.to_string(),
                    message: "insufficient funds for gas * price + value".to_string(),
                });
            }
            Err(MonadRpcError::InvalidResponse {
                method: method.to_string(),
                reason: "unexpected call after definitive broadcast rejection".to_string(),
            })
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            if let Some(response) = self
                .response_sequences
                .lock()
                .unwrap()
                .get_mut(method)
                .and_then(VecDeque::pop_front)
            {
                return Ok(response);
            }
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
        let mut envelope: Value =
            serde_json::from_slice(&valid_envelope(recipient_address(), "MONT")).unwrap();
        envelope["ciphertext"] = serde_json::json!(format!("{ciphertext_byte:02x}"));
        let encrypted_payload = serde_json::to_vec(&envelope).unwrap();
        let payload_hash = Sha256::digest(encrypted_payload.clone().into());
        let destination = stamp_destination(&payload_hash);
        let sender = EccSecp256k1::default()
            .seckey_from_array([signer_byte; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&payload_hash, 0),
        );
        make_message(raw_tx, encrypted_payload)
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

        let retried = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MON1",
            message.clone(),
        )
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

        let retried = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MON1",
            message.clone(),
        )
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
    async fn recipient_payment_is_accepted_and_stored() {
        let (_tempdir, registry) = test_registry();
        // Ticket #57: encrypted_payload must parse as a MonadMessageEnvelope now, since the
        // expected payment destination comes from its own `to` field rather than a fixed address.
        let encrypted_payload = valid_envelope(recipient_address(), "MON1");
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let calldata = commitment_calldata_bytes(&commitment, 0);
        let payment_destination = stamp_destination(&commitment);
        let (raw_payment_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, payment_destination, 10_000, &calldata);

        let message = make_message(raw_payment_tx.clone(), encrypted_payload);

        let to = hex_addr(payment_destination);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment, 0)),
        );

        let stored = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MON1",
            message.clone(),
        )
        .await
        .expect("valid stamp should be accepted");

        assert_eq!(stored.message, Some(message.clone()));
        // Ticket #39: the relay's configured network tag is stamped onto the stored record.
        assert_eq!(stored.network_tag, b"MON1");

        // And it's retrievable afterwards.
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
        let retried = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect("an exact retry should return the already-stored message");
        assert_eq!(retried, stored);
        assert_eq!(
            transport.calls().len(),
            calls_after_first_submission,
            "an exact retry must not rebroadcast the payment"
        );

        let alternate_sender = EccSecp256k1::default()
            .seckey_from_array([0x78; 32])
            .unwrap();
        let (alternate_raw_tx, _) = signed_eip1559_tx(
            &alternate_sender,
            41454,
            0,
            payment_destination,
            10_000,
            &calldata,
        );
        let conflicting = make_message(alternate_raw_tx, message.encrypted_payload.clone());
        let err = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            conflicting,
        )
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
        let calldata_0 = commitment_calldata(&commitment, 0);
        let calldata_1 = commitment_calldata(&commitment, 1);
        let calldata_bytes_0 = commitment_calldata_bytes(&commitment, 0);
        let calldata_bytes_1 = commitment_calldata_bytes(&commitment, 1);
        let destination_0 = stamp_destination_at(&commitment, 0);
        let destination_1 = stamp_destination_at(&commitment, 1);
        let sender_0 = EccSecp256k1::default()
            .seckey_from_array([0x71; 32])
            .unwrap();
        let sender_1 = EccSecp256k1::default()
            .seckey_from_array([0x72; 32])
            .unwrap();
        let (raw_tx_0, _) =
            signed_eip1559_tx(&sender_0, 41454, 0, destination_0, 4_000, &calldata_bytes_0);
        let (raw_tx_1, _) =
            signed_eip1559_tx(&sender_1, 41454, 0, destination_1, 6_000, &calldata_bytes_1);
        let message = proto::MonadStampedMessage {
            encrypted_payload,
            payload_hash: commitment.as_slice().to_vec(),
            stamp_payments: vec![
                proto::MonadStampPayment {
                    child_index: 0,
                    raw_tx: raw_tx_0,
                },
                proto::MonadStampPayment {
                    child_index: 1,
                    raw_tx: raw_tx_1,
                },
            ],
        };

        let transport = MockTransport::default();
        transport
            .set_sequence(
                "eth_sendRawTransaction",
                vec![Value::String(hex_hash(0x11)), Value::String(hex_hash(0x12))],
            )
            .set_sequence(
                "eth_getTransactionReceipt",
                vec![
                    receipt_json(&hex_addr(destination_0), "0x1"),
                    receipt_json(&hex_addr(destination_1), "0x1"),
                ],
            )
            .set_sequence(
                "eth_getTransactionByHash",
                vec![
                    tx_json(&hex_addr(destination_0), 4_000, &calldata_0),
                    tx_json(&hex_addr(destination_1), 6_000, &calldata_1),
                ],
            );

        let stored = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect("the two distinct payments should satisfy the aggregate minimum");

        assert_eq!(stored.message, Some(message));
        assert_eq!(
            transport
                .calls()
                .iter()
                .filter(|method| method.as_str() == "eth_sendRawTransaction")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn unfinished_exact_retry_uses_its_original_minimum() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let destination = stamp_destination(&commitment);
        let sender = EccSecp256k1::default()
            .seckey_from_array([0x79; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&commitment, 0),
        );
        let message = make_message(raw_tx, encrypted_payload);
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

        let to = hex_addr(destination);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment, 0)),
        );

        let stored = process_monad_message(
            &transport,
            &registry,
            20_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect("an unfinished exact retry keeps the minimum accepted before its first broadcast");
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
        let destination = stamp_destination(&commitment);
        let sender = EccSecp256k1::default()
            .seckey_from_array([0x7c; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&commitment, 0),
        );
        let message = make_message(raw_tx, encrypted_payload);
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

        let to = hex_addr(destination);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment, 0)),
        );

        let stored = process_monad_message(
            &transport,
            &registry,
            20_000,
            fast_poll(),
            b"MON1",
            message.clone(),
        )
        .await
        .expect("a durable exact versionless attempt resumes under its frozen policy");

        assert_eq!(stored.message, Some(message.clone()));
        assert_eq!(
            stored.network_tag, b"MONT",
            "an old-format claim recovers attribution from its exact historical envelope"
        );
        assert_eq!(
            transport
                .calls()
                .iter()
                .filter(|method| method.as_str() == "eth_sendRawTransaction")
                .count(),
            1,
            "the exact payment is broadcast only once during this resume"
        );
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing,
            "the successful inbox write deletes its claim in the same database batch"
        );
        assert_eq!(
            registry
                .list_monad_messages_for_recipient_since(recipient_address(), 0)
                .unwrap(),
            vec![stored]
        );
    }

    #[tokio::test]
    async fn first_insufficient_funds_rejection_releases_exact_set_claim() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let destination = stamp_destination(&commitment);
        let sender = EccSecp256k1::default()
            .seckey_from_array([0x7a; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&commitment, 0),
        );
        let message = make_message(raw_tx, encrypted_payload);

        let err = process_monad_message(
            &InsufficientFundsTransport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect_err("an unfunded first payment must be rejected");
        assert!(matches!(
            err,
            ProcessMonadMessageError::RejectedWithoutRetainedSet(
                StampRelayOutcome::BroadcastFailed(MonadRpcError::InsufficientFunds { .. })
            )
        ));
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing,
            "a free rejection must not leave a permanent exact-set claim"
        );
    }

    #[tokio::test]
    async fn confirmed_failed_payment_releases_unreplayable_exact_set_claim() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());
        let destination = stamp_destination(&commitment);
        let sender = EccSecp256k1::default()
            .seckey_from_array([0x7b; 32])
            .unwrap();
        let (raw_tx, _) = signed_eip1559_tx(
            &sender,
            41454,
            0,
            destination,
            10_000,
            &commitment_calldata_bytes(&commitment, 0),
        );
        let message = make_message(raw_tx, encrypted_payload);
        let to = hex_addr(destination);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x0"));

        let err = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect_err("a confirmed failed payment can never make this exact set valid");

        assert!(matches!(
            err,
            ProcessMonadMessageError::RejectedWithoutRetainedSet(
                StampRelayOutcome::VerificationFailed {
                    outcome: crate::monad_stamp_verify::StampTransactionVerification::TxFailed,
                    ..
                }
            )
        ));
        assert_eq!(
            registry
                .get_monad_message_attempt(&message.payload_hash, &message)
                .unwrap(),
            MonadMessageAttemptClaim::Missing,
            "a permanently invalid exact set must not block replacement messages"
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

        let err =
            process_monad_message(&transport, &registry, 10_000, fast_poll(), b"MONT", message)
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

        let err = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
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
            let err = process_monad_message(
                &transport,
                &registry,
                10_000,
                fast_poll(),
                b"MONT",
                message.clone(),
            )
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

        let err =
            process_monad_message(&transport, &registry, 10_000, fast_poll(), b"MONT", message)
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
    async fn insufficient_stamp_value_is_rejected_and_not_stored() {
        let (_tempdir, registry) = test_registry();
        // Ticket #57: see recipient_payment_is_accepted_and_stored's comment -- must parse as an
        // envelope.
        let encrypted_payload = valid_envelope(recipient_address(), "MONT");
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let calldata = commitment_calldata_bytes(&commitment, 0);
        // Pays only 500 wei, below the 10_000 wei minimum configured below.
        let payment_destination = stamp_destination(&commitment);
        let (raw_payment_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, payment_destination, 500, &calldata);

        let message = make_message(raw_payment_tx, encrypted_payload);

        let to = hex_addr(payment_destination);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 500, &commitment_calldata(&commitment, 0)),
        );

        let err = process_monad_message(
            &transport,
            &registry,
            10_000,
            fast_poll(),
            b"MONT",
            message.clone(),
        )
        .await
        .expect_err("insufficient stamp value should be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::InsufficientTotalValue {
                required: 10_000,
                actual: 500,
            }
        ));
        assert_eq!(
            registry.get_monad_message(&message.payload_hash).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn mismatched_payload_hash_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let mut message = make_message(vec![0xc0], b"hello".to_vec());
        // Corrupt the declared payload_hash so it no longer matches SHA256(encrypted_payload).
        message.payload_hash[0] ^= 0xff;

        // No transport responses configured at all: if this reached the network, it would panic.
        let transport = MockTransport::default();

        let err =
            process_monad_message(&transport, &registry, 10_000, fast_poll(), b"MONT", message)
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

        let err =
            process_monad_message(&transport, &registry, 10_000, fast_poll(), b"MONT", message)
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
        let stored = admit_monad_message(
            &transport,
            &registry,
            &config,
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
            admit_monad_message(&transport, &registry, &config, 10_000, b"MONT", conflicting,)
                .await,
            Err(ProcessMonadMessageError::ConflictingPaymentSet)
        ));
        assert_eq!(transport.calls().len(), calls_after_delivery);

        let (_capacity_tempdir, capacity_registry) = test_registry();
        let blocker = valid_signed_message(0x55, 0x42);
        let target = valid_signed_message(0x66, 0x43);
        let mut capacity_config = crate::monad_outbox::MonadOutboxReconcileConfig::default();
        capacity_config.limits.max_active_claims = 1;
        let recipient_pubkey = EccSecp256k1::default().derive_pubkey(&recipient_seckey());
        let policy = MonadOutboxPolicy {
            recipient: recipient_address(),
            recipient_pubkey: recipient_pubkey.as_slice().to_vec(),
            min_value_wei: 10_000,
            network_tag: b"MONT".to_vec(),
        };
        assert!(matches!(
            capacity_registry
                .claim_monad_outbox(&blocker, &policy, 1, &capacity_config.limits)
                .unwrap(),
            MonadOutboxClaim::New
        ));
        let capacity_transport = MockTransport::default();
        assert!(matches!(
            admit_monad_message(
                &capacity_transport,
                &capacity_registry,
                &capacity_config,
                10_000,
                b"MONT",
                target,
            )
            .await,
            Err(ProcessMonadMessageError::OutboxAtCapacity)
        ));
        assert!(capacity_transport.calls().is_empty());
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
        let challenge = runtime.issue_challenge(recipient, now_ms()).unwrap();
        let path = format!("/message/monad/inbox/{}", recipient.to_hex());
        let digest = Sha256::digest(
            mailbox_auth_preimage(
                challenge.epoch,
                challenge.nonce,
                challenge.expires_at_ms,
                "GET",
                &path,
                recipient,
                7,
                None,
                10,
                b"MONT",
            )
            .into(),
        );
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
            MAILBOX_SIGNATURE_HEADER,
            hex::encode(signature).parse().unwrap(),
        );

        authenticate_private_mailbox(&headers, &server, recipient, "GET", &path, 7, None, 10)
            .await
            .unwrap();
        assert!(matches!(
            authenticate_private_mailbox(&headers, &server, recipient, "GET", &path, 7, None, 10,)
                .await,
            Err(PrivateMailboxError::Unauthorized)
        ));

        let cross_challenge = runtime.issue_challenge(recipient, now_ms()).unwrap();
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
        assert!(matches!(
            authenticate_private_mailbox(
                &cross_headers,
                &server,
                Address([9; 20]),
                "GET",
                "/message/monad/inbox/0x0909090909090909090909090909090909090909",
                7,
                None,
                10,
            )
            .await,
            Err(PrivateMailboxError::Unauthorized)
        ));
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
