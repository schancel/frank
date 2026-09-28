//! `PUT /message/monad`, `GET /message/monad/:payload_hash`, and `GET /message/monad?since=
//! <timestamp>`: the live HTTP path for a Monad-stamped direct message (ticket #27),
//! completing the wiring `crate::monad_stamp_relay`'s module docs (ticket #19) left for
//! "whoever picks up the wire format decision".
//!
//! ## Message discovery (`GET /message/monad?since=<timestamp>`, ticket #37)
//!
//! Ticket #8's live e2e demo found that `GET /message/monad/:payload_hash` (exact-hash lookup)
//! is the *only* read path -- there's no way for a recipient to learn a new message exists
//! without already being told its `payload_hash` out of band. [`handle_list_monad_messages`]
//! adds the simpler of ticket #37's two documented options (a polling "list since" endpoint,
//! rather than a WS push route) -- chosen because:
//! - It reuses this route's existing gating/response conventions directly, with no new
//!   long-lived-connection lifecycle (auth-on-connect, backpressure, reconnect/resume-from-cursor
//!   on drop) to design and test under this ticket's scope.
//! - `crate::monad_ws.rs`'s WS code is a *client* of Monad's own `eth_subscribe` RPC (internal
//!   `ChainAdapter` plumbing) -- it's a reasonable reference for `tokio-tungstenite` mechanics but
//!   isn't a server-side push framework this route could extend, so following it would mean
//!   building a WS *server* route from scratch.
//! - The old Lotus-era `RelayClient`/`isomorphic-ws` code in `app/src/cashweb/relay/` is a
//!   different, pre-Monad relay-server protocol (explicitly out of scope per this ticket's
//!   instructions) and doesn't inform this decision either way.
//! - A polling `since` cursor is sufficient to satisfy the acceptance criterion (discover a new
//!   message without knowing its `payload_hash` out of band); WS push is strictly an optimization
//!   (lower latency, no polling interval to tune) that can be layered on top later without
//!   changing this endpoint's semantics.
//!
//! **Important gap, surfaced rather than silently patched over (see ticket #37's handoff for the
//! full writeup):** neither [`proto::MonadStampedMessage`] nor [`proto::StoredMonadMessage`]
//! carries an intended-*recipient* field at all -- a Monad message is addressed purely by content
//! hash, with the recipient routing address inside the client envelope. So unlike the `&recipient=
//! <address>` parameter ticket #37's issue text sketches, [`handle_list_monad_messages`] takes
//! only `since` and returns *every* message stored at or after that timestamp -- there is nothing
//! in the wire format for the relay to filter on server-side. This mirrors how `DbTopics`'s
//! existing topic-broadcast model already works for the Lotus path (subscribers to a topic fetch
//! everything under it and decrypt client-side to find what's theirs). A real fix would add a
//! recipient-identifying field to [`proto::MonadStampedMessage`] (additive -- proto3 field
//! addition is backward-compatible, e.g. `bytes recipient_address_hint = 4`) but that's a
//! deliberate wire-format decision left for review, not made unilaterally here, since #16/#19/#27/
//! #30 all build on this proto.
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
//! ## Configuration
//!
//! Following `crate::http::pop_protection`'s established convention (a process-wide [`OnceLock`],
//! read from the environment on first use, rather than plumbing config through
//! [`crate::http::server::RegistryServer`]'s fields and touching its other construction sites):
//!
//! - `MONAD_TESTNET_HTTP_RPC_URL`: Monad JSON-RPC endpoint (same var `pop_protection` and the live
//!   smoke tests use).
//! - `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`: minimum stamp value, in wei, as a decimal string. The
//!   environment variable retains its legacy name for deployment compatibility. It never
//!   had a canonical `.env` var before ticket #8's e2e demo added it (checked: absent from both
//!   `.env` and `.env.example`) -- an omission, not a naming mismatch, so this name is kept as-is.
//!
//! Ticket #57 (found live: real DMs were burning to a fixed address instead of paying the
//! recipient): this module used to also read `MONAD_STAMP_BURN_ADDRESS` here, same as
//! `monad_topics.rs`'s own separate config still does for broadcasts (no single recipient to
//! pay). `process_monad_message` no longer reads it at all -- the expected payment destination for
//! a direct message is the message's own claimed recipient ([`extract_recipient`]), not a
//! server-configured constant. See that function's doc comment for the full reasoning.
//!
//! An unconfigured or invalid gate fails every request closed (`500`), rather than silently
//! skipping stamp verification, mirroring `pop_protection`'s same fail-closed choice.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    sync::{Arc, OnceLock, Weak},
};

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::{BoundedProtobufBody, Protobuf};
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use prost::Message;
use serde::{Deserialize, Serialize};
use tracing::Level;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{decode_signed_transaction, EvmTxError},
    monad_http::{Address, Hash32, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::{broadcast_and_verify_stamp, PollConfig, StampRelayOutcome},
    monad_stamp_stealth::{derive_monad_stamp_child_public, StampStealthError},
    monad_stamp_verify::{parse_commitment_calldata, ExpectedStampTransaction},
    proto,
    registry::Registry,
    store::monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy},
};

const MAX_STAMP_PAYMENTS: usize = 64;
const MAX_MONAD_MESSAGE_BODY_BYTES: usize = 2 * 1024 * 1024;
static PAYMENT_SET_LOCKS: OnceLock<
    tokio::sync::Mutex<HashMap<(usize, [u8; 32]), Weak<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();
static PAYMENT_RELAY_SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
const MAX_CONCURRENT_PAYMENT_RELAYS: usize = 32;
const PAYMENT_RELAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    /// `encrypted_payload` doesn't parse as the client's own `MonadMessageEnvelope` JSON shape
    /// (`{v, networkTag, from, to, salt, ciphertext}`, `packages/cashweb/relay/monad-message-envelope.ts` --
    /// `to` is deliberately left unencrypted there for routing) -- see [`extract_recipient`]'s own
    /// doc comment for why this is required, not best-effort.
    MissingOrInvalidRecipient(String),
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
            ProcessMonadMessageError::MissingOrInvalidRecipient(detail) => {
                write!(
                    f,
                    "couldn't determine recipient address from encrypted_payload: {detail}"
                )
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

/// The client's own `MonadMessageEnvelope` JSON shape (`app/src/cashweb/wallet/
/// monad-message-envelope.ts`): `{v, networkTag, from, to, salt, ciphertext}`. Routing and network
/// binding matter here; encrypted content remains opaque. `#[derive(Deserialize)]` ignores other
/// fields by default, so this stays valid if the client adds additive fields later.
#[derive(Deserialize)]
struct MonadMessageEnvelope {
    to: String,
    #[serde(rename = "networkTag")]
    network_tag: Option<String>,
}

const PAYMENT_COMMITMENT_DOMAIN: &[u8] = b"frank:dm-stamp-payment:v1";

fn payment_commitment(payload_hash: &[u8; 32], child_index: u32) -> Sha256 {
    let mut preimage = Vec::with_capacity(PAYMENT_COMMITMENT_DOMAIN.len() + 36);
    preimage.extend_from_slice(PAYMENT_COMMITMENT_DOMAIN);
    preimage.extend_from_slice(payload_hash);
    preimage.extend_from_slice(&child_index.to_be_bytes());
    Sha256::digest(preimage.into())
}

/// Ticket #57 (found live: real Monad DMs were burning stamp value to the fixed relay-configured
/// address instead of paying the recipient -- the recipient got nothing). Parses
/// `encrypted_payload` as a [`MonadMessageEnvelope`] and returns its `to` field as an [`Address`].
///
/// This is **required**, not best-effort: `/message/monad` (this module) is exclusively the
/// direct-message path -- `MonadTopicPost`/`monad_topics.rs` is a separate proto and handler with
/// its own, still-fixed-address burn verification, since a topic broadcast genuinely has no
/// single recipient to pay. Every real `MonadStampedMessage` submission *is* a DM, so every one of
/// them must carry a real recipient to verify the stamp payment against -- a message that doesn't parse as
/// this envelope shape (or carries an invalid `to`) is rejected outright
/// ([`ProcessMonadMessageError::MissingOrInvalidRecipient`]), the same fail-closed posture
/// [`process_monad_message`]'s other checks already take, rather than silently falling back to
/// the fixed address (which would just resurrect this exact bug for any message the relay
/// happens not to be able to parse).
///
/// `to`/`from` are deliberately left unencrypted in the envelope for routing (see that file's own
/// header) -- only `ciphertext` is actually encrypted -- so this needs no decryption and no
/// knowledge of any private key, matching how the rest of this function treats
/// `encrypted_payload` as opaque *content* while still being able to check *structure* around it
/// (same principle as the `payload_hash` check just above, which hashes the whole blob without
/// needing to understand it).
fn extract_recipient(
    encrypted_payload: &[u8],
    expected_network_tag: &[u8],
) -> Result<Address, ProcessMonadMessageError> {
    let envelope: MonadMessageEnvelope = serde_json::from_slice(encrypted_payload)
        .map_err(|err| ProcessMonadMessageError::MissingOrInvalidRecipient(err.to_string()))?;
    if !expected_network_tag.is_empty()
        && envelope.network_tag.as_deref().map(str::as_bytes) != Some(expected_network_tag)
    {
        return Err(ProcessMonadMessageError::NetworkTagMismatch {
            expected: expected_network_tag.to_vec(),
            actual: envelope.network_tag,
        });
    }
    Address::from_hex(&envelope.to)
        .map_err(|err| ProcessMonadMessageError::MissingOrInvalidRecipient(err.to_string()))
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
    // mutable current relay policy (minimum value, profile rotation, network configuration).
    if let Some(existing) = registry
        .get_monad_message(declared_hash.as_slice())
        .map_err(ProcessMonadMessageError::Infrastructure)?
    {
        if existing.message.as_ref() == Some(&request) {
            return Ok(existing);
        }
        return Err(ProcessMonadMessageError::ConflictingPaymentSet);
    }

    let recipient = extract_recipient(&request.encrypted_payload, network_tag)?;
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
    let _relay_slot = PAYMENT_RELAY_SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAYMENT_RELAYS)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ProcessMonadMessageError::RelayBusy)?;
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
    let policy = match &existing_attempt {
        MonadMessageAttemptClaim::ExistingExact(policy) => policy.clone(),
        MonadMessageAttemptClaim::Conflict => {
            return Err(ProcessMonadMessageError::ConflictingPaymentSet)
        }
        MonadMessageAttemptClaim::Missing => {
            let recipient_profile = registry
                .get_monad_profile(recipient)
                .map_err(ProcessMonadMessageError::Infrastructure)?
                .ok_or(ProcessMonadMessageError::RecipientProfileNotFound(
                    recipient,
                ))?;
            MonadMessageAttemptPolicy {
                recipient_pubkey: recipient_profile.pubkey,
                min_value_wei,
            }
        }
        MonadMessageAttemptClaim::New => unreachable!("lookup cannot create an attempt"),
    };

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
        .put_monad_message(declared_hash.as_slice(), recipient, stored, network_tag)
        .map_err(ProcessMonadMessageError::Infrastructure)?;

    Ok(stored)
}

/// Errors reading required Monad-stamp gate configuration from the environment via
/// [`monad_message_gate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadMessageGateConfigError {
    /// A required env var wasn't set.
    MissingEnv(&'static str),
    /// `MONAD_TESTNET_HTTP_RPC_URL` wasn't a valid URL.
    InvalidRpcUrl(String),
    /// `CASHWEB_STAMP_MIN_BURN_VALUE_WEI` wasn't a valid non-negative decimal integer.
    InvalidMinValueWei(String),
}

impl fmt::Display for MonadMessageGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MonadMessageGateConfigError::MissingEnv(name) => {
                write!(
                    f,
                    "missing required env var {name} (Monad stamp gate is unconfigured)"
                )
            }
            MonadMessageGateConfigError::InvalidRpcUrl(msg) => {
                write!(f, "invalid MONAD_TESTNET_HTTP_RPC_URL: {msg}")
            }
            MonadMessageGateConfigError::InvalidMinValueWei(msg) => {
                write!(f, "invalid CASHWEB_STAMP_MIN_BURN_VALUE_WEI: {msg}")
            }
        }
    }
}

/// Configuration for the `PUT /message/monad` route, read once from the environment (see module
/// docs).
#[derive(Debug, Clone)]
pub struct MonadMessageGateConfig {
    rpc_url: url::Url,
    min_value_wei: u128,
}

fn required_env(name: &'static str) -> Result<String, MonadMessageGateConfigError> {
    std::env::var(name).map_err(|_| MonadMessageGateConfigError::MissingEnv(name))
}

impl MonadMessageGateConfig {
    fn from_env() -> Result<Self, MonadMessageGateConfigError> {
        let rpc_url = required_env("MONAD_TESTNET_HTTP_RPC_URL")?;
        let rpc_url: url::Url = rpc_url
            .parse()
            .map_err(|err| MonadMessageGateConfigError::InvalidRpcUrl(format!("{err}")))?;
        let min_value_wei_str = required_env("CASHWEB_STAMP_MIN_BURN_VALUE_WEI")?;
        let min_value_wei = min_value_wei_str
            .parse::<u128>()
            .map_err(|_| MonadMessageGateConfigError::InvalidMinValueWei(min_value_wei_str))?;
        Ok(MonadMessageGateConfig {
            rpc_url,
            min_value_wei,
        })
    }
}

/// Process-wide, lazily-initialized gate config for `PUT /message/monad`, built from the
/// environment on first use (see module docs and `pop_protection::pop_gate`, which this mirrors).
fn monad_message_gate() -> &'static Result<MonadMessageGateConfig, MonadMessageGateConfigError> {
    static GATE: OnceLock<Result<MonadMessageGateConfig, MonadMessageGateConfigError>> =
        OnceLock::new();
    GATE.get_or_init(MonadMessageGateConfig::from_env)
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
    /// The gate is misconfigured; fails closed (`500`) rather than silently skipping stamp
    /// verification.
    GateUnavailable(MonadMessageGateConfigError),
    /// The bounded request body is not a valid or admissible Monad message protobuf.
    Decode(String),
    /// [`process_monad_message`] rejected (or failed to process) the message.
    Process(ProcessMonadMessageError),
}

impl IntoResponse for PutMonadMessageError {
    fn into_response(self) -> Response {
        match self {
            PutMonadMessageError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "Monad stamp gate is misconfigured; rejecting message-put"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadMessageError::Process(ProcessMonadMessageError::Infrastructure(err)) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "infrastructure failure processing Monad-stamped message"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
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
                    exact_set_retained: match err {
                        ProcessMonadMessageError::Rejected(_)
                        | ProcessMonadMessageError::RelayTimedOut => Some(true),
                        ProcessMonadMessageError::RejectedWithoutRetainedSet(_) => Some(false),
                        ProcessMonadMessageError::PaymentSetBusy
                        | ProcessMonadMessageError::RelayBusy => None,
                        _ => Some(false),
                    },
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
    let config = monad_message_gate()
        .as_ref()
        .map_err(|err| PutMonadMessageError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    let stored = process_monad_message(
        &transport,
        &server.registry,
        config.min_value_wei,
        PollConfig::default(),
        crate::network_tag::frank_network_tag(),
        message,
    )
    .await
    .map_err(PutMonadMessageError::Process)?;
    Ok(Protobuf(stored))
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

    #[tokio::test]
    async fn recipient_payment_is_accepted_and_stored() {
        let (_tempdir, registry) = test_registry();
        // Ticket #57: encrypted_payload must parse as a MonadMessageEnvelope now, since the
        // expected payment destination comes from its own `to` field rather than a fixed address.
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
            b"MONT",
            message.clone(),
        )
        .await
        .expect("valid stamp should be accepted");

        assert_eq!(stored.message, Some(message.clone()));
        // Ticket #39: the relay's configured network tag is stamped onto the stored record.
        assert_eq!(stored.network_tag, b"MONT");

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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
    async fn first_insufficient_funds_rejection_releases_exact_set_claim() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
            &[],
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
    async fn invalid_recipient_is_rejected_before_broadcast_or_storage() {
        for encrypted_payload in [
            b"not-json".to_vec(),
            br#"{"from":"0x11"}"#.to_vec(),
            br#"{"to":"not-an-address"}"#.to_vec(),
        ] {
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
                &[],
                message.clone(),
            )
            .await
            .expect_err("invalid envelope recipient must be rejected");

            assert!(matches!(
                err,
                ProcessMonadMessageError::MissingOrInvalidRecipient(_)
            ));
            assert_eq!(
                transport.calls(),
                Vec::<String>::new(),
                "invalid recipient must be rejected before any RPC, especially broadcast"
            );
            assert_eq!(
                registry.get_monad_message(&message.payload_hash).unwrap(),
                None
            );
        }
    }

    #[tokio::test]
    async fn wrong_network_tag_is_rejected_before_broadcast() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MON1"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
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
            &[],
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

        let err = process_monad_message(&transport, &registry, 10_000, fast_poll(), &[], message)
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
        let encrypted_payload = format!(
            r#"{{"to":"{}","networkTag":"MONT"}}"#,
            hex_addr(recipient_address())
        )
        .into_bytes();
        let message = make_message(vec![0x01, 0xc0], encrypted_payload);
        let transport = MockTransport::default();

        let err = process_monad_message(&transport, &registry, 10_000, fast_poll(), &[], message)
            .await
            .expect_err("malformed stamp payment should be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::FundingAccountRecoveryFailed(_)
        ));
    }

    #[test]
    fn gate_config_error_display_mentions_missing_var() {
        // Ticket #57: MONAD_STAMP_BURN_ADDRESS is no longer part of this config (the DM path now
        // derives its expected payment destination from the message's own envelope, not a
        // server-configured constant), so this now exercises a var that's still actually required.
        let err = MonadMessageGateConfigError::MissingEnv("MONAD_TESTNET_HTTP_RPC_URL");
        assert!(err.to_string().contains("MONAD_TESTNET_HTTP_RPC_URL"));
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
        }
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
