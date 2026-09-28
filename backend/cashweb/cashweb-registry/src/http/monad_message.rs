//! `PUT /message/monad`, `GET /message/monad/:payload_hash`, and `GET /message/monad?since=
//! <timestamp>`: the live HTTP path for a Monad-stamped broadcast message (ticket #27),
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
//! hash, with `encrypted_payload` opaque to the relay (Stamp's design centers on the *sender*
//! proving payment via the burn tx, not on recipient addressing). So unlike the `&recipient=
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
//! signature: per PLAN.md constraint 5, sender authentication comes for free from the raw burn
//! tx's own ECDSA signature, recoverable via [`crate::monad_evm_tx::recover_sender`] (Ethereum's
//! `ecrecover`) -- so requiring a client to *additionally* sign the message with a declared pubkey
//! would be redundant. In its place, [`proto::MonadStampedMessage::payload_hash`] is the binding
//! between this specific message and the on-chain burn: `raw_burn_tx`'s calldata must commit to
//! exactly this hash (checked by [`verify_stamp_burn`](crate::monad_stamp_verify::verify_stamp_burn)
//! via [`process_monad_message`] below), so a burn tx can't be replayed with a substituted payload.
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

use std::{fmt, sync::OnceLock};

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::Protobuf;
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use serde::{Deserialize, Serialize};
use tracing::Level;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{recover_sender, EvmTxError},
    monad_http::{Address, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::{broadcast_and_verify_stamp, PollConfig, StampRelayOutcome},
    monad_stamp_verify::ExpectedBurn,
    proto,
    registry::Registry,
};

/// Errors processing a [`proto::MonadStampedMessage`], independent of HTTP/axum (see
/// [`process_monad_message`]) so this logic can be unit-tested directly against a mock
/// [`JsonRpcTransport`], the same way `monad_stamp_relay`/`monad_stamp_verify` test themselves.
#[derive(Debug)]
pub enum ProcessMonadMessageError {
    /// `encrypted_payload` doesn't parse as the client's own `MonadMessageEnvelope` JSON shape
    /// (`{v, from, to, salt, ciphertext}`, `app/src/cashweb/wallet/monad-message-envelope.ts` --
    /// `to` is deliberately left unencrypted there for routing) -- see [`extract_recipient`]'s own
    /// doc comment for why this is required, not best-effort.
    MissingOrInvalidRecipient(String),
    /// `payload_hash` wasn't exactly 32 bytes.
    InvalidPayloadHashLength(usize),
    /// `payload_hash` didn't match `SHA256(encrypted_payload)`.
    PayloadHashMismatch {
        /// The client-declared `payload_hash`.
        declared: Sha256,
        /// The actual hash of `encrypted_payload`.
        actual: Sha256,
    },
    /// [`recover_sender`] couldn't recover a sender address from `raw_burn_tx`.
    SenderRecoveryFailed(EvmTxError),
    /// The stamp didn't verify -- see the wrapped [`StampRelayOutcome`] for exactly why (a
    /// broadcast-time RPC failure, a confirmation timeout, or a specific verification failure).
    /// Every non-[`StampRelayOutcome::Verified`] outcome is a rejection, never a silent store, per
    /// ticket #19's acceptance criteria.
    Rejected(StampRelayOutcome),
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
            ProcessMonadMessageError::InvalidPayloadHashLength(len) => {
                write!(f, "payload_hash must be 32 bytes, got {len}")
            }
            ProcessMonadMessageError::PayloadHashMismatch { declared, actual } => write!(
                f,
                "payload_hash {declared} doesn't match SHA256(encrypted_payload) {actual}"
            ),
            ProcessMonadMessageError::SenderRecoveryFailed(err) => {
                write!(f, "couldn't recover sender from raw_burn_tx: {err}")
            }
            ProcessMonadMessageError::Rejected(outcome) => {
                write!(f, "Monad stamp rejected: {outcome:?}")
            }
            ProcessMonadMessageError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// The client's own `MonadMessageEnvelope` JSON shape (`app/src/cashweb/wallet/
/// monad-message-envelope.ts`): `{v, from, to, salt, ciphertext}`. Only `to` matters here --
/// `#[derive(Deserialize)]` ignores the other fields by default, so this stays valid even if the
/// client adds fields to the envelope later (additive, non-breaking from this side).
#[derive(Deserialize)]
struct MonadMessageEnvelope {
    to: String,
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
fn extract_recipient(encrypted_payload: &[u8]) -> Result<Address, ProcessMonadMessageError> {
    let envelope: MonadMessageEnvelope = serde_json::from_slice(encrypted_payload)
        .map_err(|err| ProcessMonadMessageError::MissingOrInvalidRecipient(err.to_string()))?;
    Address::from_hex(&envelope.to)
        .map_err(|err| ProcessMonadMessageError::MissingOrInvalidRecipient(err.to_string()))
}

/// Decode, verify, broadcast-and-confirm, and (on success) store a [`proto::MonadStampedMessage`].
///
/// Mirrors `Registry::put_message`'s Lotus flow (decode -> verify burn -> store) at a high level,
/// but every step is Monad-specific:
/// 1. `payload_hash` must be exactly 32 bytes and match `SHA256(encrypted_payload)` (the
///    client-side integrity check `SignedPayload::parse_proto` does for Lotus).
/// 2. The sender is recovered from `raw_burn_tx` via [`recover_sender`] (`ecrecover`) rather than
///    read off an explicit pubkey field.
/// 3. The expected payment destination is the message's *own claimed recipient*
///    ([`extract_recipient`], ticket #57), not a fixed address -- this is the direct-message path,
///    and Stamp's actual design pays the recipient (mirroring the Lotus relay's
///    `constructStampTransactions`, which derives the stamp output address from the recipient's
///    own pubkey) rather than burning to a dead/unspendable address, which only broadcasts
///    (`monad_topics.rs`, no single recipient) correctly do.
/// 4. [`broadcast_and_verify_stamp`] (ticket #19) broadcasts `raw_burn_tx` and confirms its
///    calldata commits to `payload_hash`, sending at least `min_value_wei` to that recipient.
/// 5. Only [`StampRelayOutcome::Verified`] leads to a store, via [`Registry::put_monad_message`]
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

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessMonadMessageError::SenderRecoveryFailed)?;

    let recipient = extract_recipient(&request.encrypted_payload)?;

    let expected = ExpectedBurn {
        commitment_id: BROADCAST_MESSAGE_LOKAD_ID,
        commitment: declared_hash.clone(),
        destination_address: recipient,
        min_value_wei,
    };

    let outcome = broadcast_and_verify_stamp(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessMonadMessageError::Infrastructure)?;

    let tx_hash = match outcome {
        StampRelayOutcome::Verified { tx_hash } => tx_hash,
        other => return Err(ProcessMonadMessageError::Rejected(other)),
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let stored = proto::StoredMonadMessage {
        message: Some(request),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        network_tag: Vec::new(),
    };

    let stored = registry
        .put_monad_message(declared_hash.as_slice(), stored, network_tag)
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
}

/// Error type for [`handle_put_monad_message`].
#[derive(Debug)]
pub enum PutMonadMessageError {
    /// The gate is misconfigured; fails closed (`500`) rather than silently skipping stamp
    /// verification.
    GateUnavailable(MonadMessageGateConfigError),
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
            PutMonadMessageError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadMessageErrorBody {
                    error: "invalid_monad_message",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
        }
    }
}

/// `PUT /message/monad`: decode a [`proto::MonadStampedMessage`], recover its sender, verify its
/// Monad stamp (broadcasting it, per ticket #19), and store it on success.
pub async fn handle_put_monad_message(
    Protobuf(message): Protobuf<proto::MonadStampedMessage>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadMessage>, PutMonadMessageError> {
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
        collections::HashMap,
        fmt,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::{ecc::Ecc, Net};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use serde_json::Value;
    use tempdir::TempDir;

    use super::*;
    use crate::{
        monad_evm_tx::test_support::signed_eip1559_tx, monad_http::MonadRpcError,
        monad_stamp_relay::PollConfig, store::db::Db,
    };
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};

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
        (tempdir, registry)
    }

    fn recipient_address() -> Address {
        Address([0x44; 20])
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

    fn commitment_calldata(commitment: &Sha256) -> String {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP_BROADCAST);
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        format!("0x{}", hex::encode(calldata))
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

    fn make_message(
        raw_burn_tx: Vec<u8>,
        encrypted_payload: Vec<u8>,
    ) -> proto::MonadStampedMessage {
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        proto::MonadStampedMessage {
            raw_burn_tx,
            encrypted_payload,
            payload_hash,
        }
    }

    #[tokio::test]
    async fn recipient_payment_is_accepted_and_stored() {
        let (_tempdir, registry) = test_registry();
        // Ticket #57: encrypted_payload must parse as a MonadMessageEnvelope now, since the
        // expected payment destination comes from its own `to` field rather than a fixed address.
        let encrypted_payload =
            format!(r#"{{"to":"{}"}}"#, hex_addr(recipient_address())).into_bytes();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP_BROADCAST);
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        let (raw_burn_tx, sender) =
            signed_eip1559_tx(&seckey, 41454, 0, recipient_address(), 10_000, &calldata);

        let message = make_message(raw_burn_tx.clone(), encrypted_payload);

        let to = hex_addr(recipient_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment)),
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

        assert_eq!(stored.sender_address, sender.0.to_vec());
        assert_eq!(stored.message, Some(message.clone()));
        // Ticket #39: the relay's configured network tag is stamped onto the stored record.
        assert_eq!(stored.network_tag, b"MONT");

        // And it's retrievable afterwards.
        let fetched = registry
            .get_monad_message(&message.payload_hash)
            .unwrap()
            .expect("message should be stored");
        assert_eq!(fetched, stored);
    }

    /// Regression for #57's economic boundary. Before the fix, supplying
    /// `broadcast_burn_address()` as the server-wide configured destination made this transaction
    /// acceptable even though the envelope names a different recipient. The DM path must now
    /// reject that broadcast burn destination and leave storage untouched.
    #[tokio::test]
    async fn fixed_broadcast_burn_address_is_rejected_for_direct_message() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload =
            format!(r#"{{"to":"{}"}}"#, hex_addr(recipient_address())).into_bytes();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP_BROADCAST);
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        let (raw_burn_tx, _sender) = signed_eip1559_tx(
            &seckey,
            41454,
            0,
            broadcast_burn_address(),
            10_000,
            &calldata,
        );
        let message = make_message(raw_burn_tx, encrypted_payload);

        let actual_to = hex_addr(broadcast_burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&actual_to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&actual_to, 10_000, &commitment_calldata(&commitment)),
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
            ProcessMonadMessageError::Rejected(
                StampRelayOutcome::VerificationFailed {
                    outcome: crate::monad_stamp_verify::StampBurnVerification::WrongRecipient {
                        expected,
                        actual: Some(actual),
                    },
                    ..
                }
            ) if expected == recipient_address() && actual == broadcast_burn_address()
        ));
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
            let mut calldata = Vec::new();
            calldata.extend_from_slice(&STMP_BROADCAST);
            calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
            calldata.extend_from_slice(commitment.as_slice());
            let (raw_burn_tx, _sender) =
                signed_eip1559_tx(&seckey, 41454, 0, recipient_address(), 10_000, &calldata);
            let message = make_message(raw_burn_tx, encrypted_payload);

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
    async fn insufficient_stamp_value_is_rejected_and_not_stored() {
        let (_tempdir, registry) = test_registry();
        // Ticket #57: see recipient_payment_is_accepted_and_stored's comment -- must parse as an
        // envelope.
        let encrypted_payload =
            format!(r#"{{"to":"{}"}}"#, hex_addr(recipient_address())).into_bytes();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP_BROADCAST);
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        // Pays only 500 wei, below the 10_000 wei minimum configured below.
        let (raw_burn_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, recipient_address(), 500, &calldata);

        let message = make_message(raw_burn_tx, encrypted_payload);

        let to = hex_addr(recipient_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 500, &commitment_calldata(&commitment)),
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
            ProcessMonadMessageError::Rejected(StampRelayOutcome::VerificationFailed { .. })
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
    async fn malformed_raw_burn_tx_is_rejected() {
        let (_tempdir, registry) = test_registry();
        let message = make_message(vec![0x01, 0xc0], b"hello".to_vec());
        let transport = MockTransport::default();

        let err = process_monad_message(&transport, &registry, 10_000, fast_poll(), &[], message)
            .await
            .expect_err("malformed raw_burn_tx should be rejected");

        assert!(matches!(
            err,
            ProcessMonadMessageError::SenderRecoveryFailed(_)
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
        }
    }

    /// Store a valid, verified [`proto::MonadStampedMessage`] straight into `registry` (bypassing
    /// the HTTP `PUT` + stamp-verification machinery, which [`valid_stamp_is_accepted_and_stored`]
    /// already covers) with an explicit `timestamp`, for [`list_since`]-focused tests below where
    /// the interesting behavior is the read side, not verification.
    fn store_at(registry: &Registry, payload_hash: Vec<u8>, timestamp: i64) {
        let stored = proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                raw_burn_tx: vec![1, 2, 3],
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
            }),
            sender_address: vec![9u8; 20],
            tx_hash: vec![8u8; 32],
            timestamp,
            network_tag: Vec::new(),
        };
        registry
            .put_monad_message(&payload_hash, stored, &[])
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
