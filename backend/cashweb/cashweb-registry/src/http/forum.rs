//! `PUT /message/monad/forum`, `PUT /message/monad/forum/vote`, and
//! `GET /message/monad/forum/:payload_hash`: the HTTP path for Monad forum topic posts and their
//! burn-weighted votes (ticket #30).
//!
//! Mirrors `crate::http::monad_message`'s decode -> verify -> store shape (ticket #27) closely,
//! with two Monad-forum-specific differences:
//! - Verification goes through [`crate::monad_forum_verify::verify_forum_vote_burn`] (via
//!   [`crate::monad_forum_relay::broadcast_and_verify_forum_vote`]) rather than
//!   `monad_stamp_verify::verify_stamp_burn`/`monad_stamp_relay::broadcast_and_verify_stamp` --
//!   see those modules' docs for the calldata-layout and outcome-type reasons they can't be
//!   reused as-is here.
//! - A verified burn doesn't just gate a store, it also *is* a vote: both `PUT` routes below
//!   record a [`proto::StoredMonadForumVoteEntry`] alongside whatever else they store (a new post
//!   also creates its own initial vote entry), so [`Registry::get_forum_post_view`]'s tally is
//!   simply the sum of every recorded entry for a `payload_hash`.
//!
//! ## Configuration
//!
//! Reuses the *same* two canonical env vars `crate::http::monad_message`'s
//! `MonadMessageGateConfig` reads (`MONAD_TESTNET_HTTP_RPC_URL`, `MONAD_STAMP_BURN_ADDRESS` --
//! see `.env.example`), rather than inventing forum-specific ones: a forum vote burns to the same
//! configured Stamp burn address, just tagged with [`crate::monad_forum_verify::
//! FORUM_VOTE_LOKAD_ID`] in its calldata instead of `POND`/`STMP`, so there's no reason for a
//! second, easy-to-typo burn-address var (exactly the class of bug ticket #8's e2e demo found and
//! fixed for `monad_message.rs`). Unlike that module's gate, there's no
//! `CASHWEB_STAMP_MIN_BURN_VALUE_WEI` equivalent here: a forum vote's exact value *is* its
//! weight, never thresholded against a minimum (see `monad_forum_verify`'s module docs), so
//! nothing here needs a minimum-value config at all.
//!
//! `monad_message_gate`'s own gate config (in `crate::http::monad_message`) is private to that
//! module and that module can't be edited to expose it, so this module reads its own
//! process-wide `OnceLock`, following the same fail-closed convention (`crate::http::
//! pop_protection`'s "read once from the environment on first use" pattern, restated in
//! `monad_message`'s own docs).

use std::{fmt, sync::OnceLock};

use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::Protobuf;
use serde::Serialize;
use tracing::Level;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{recover_sender, EvmTxError},
    monad_forum_relay::{broadcast_and_verify_forum_vote, ForumVoteRelayOutcome},
    monad_forum_verify::ExpectedForumBurn,
    monad_http::{Address, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    proto,
    registry::Registry,
};

/// Narrow an [`i128`] signed weight (see [`crate::monad_forum_verify::VoteDirection::
/// signed_weight`]) down to the `sint64` the wire format/store use, saturating rather than
/// wrapping for a burn value large enough to overflow `i64` (see `proto/forum_message.proto`'s
/// docs on why `i64` is an acceptable simplification for this ticket's scope). Saturating (rather
/// than truncating with `as i64`, which would silently wrap into an unrelated, possibly
/// wrong-signed value) keeps an out-of-range weight merely *capped*, not corrupted.
fn saturate_weight(weight: i128) -> i64 {
    weight.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// Errors processing a [`proto::MonadForumPost`], independent of HTTP/axum, mirroring
/// `crate::http::monad_message::ProcessMonadMessageError`.
#[derive(Debug)]
pub enum ProcessForumPostError {
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
    /// The initial vote's burn didn't verify -- see the wrapped [`ForumVoteRelayOutcome`] for
    /// exactly why. Every non-[`ForumVoteRelayOutcome::Verified`] outcome is a rejection, never a
    /// silent store.
    Rejected(ForumVoteRelayOutcome),
    /// An infrastructure-level failure (RPC/transport error, or a storage error).
    Infrastructure(Report),
}

impl fmt::Display for ProcessForumPostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessForumPostError::InvalidPayloadHashLength(len) => {
                write!(f, "payload_hash must be 32 bytes, got {len}")
            }
            ProcessForumPostError::PayloadHashMismatch { declared, actual } => write!(
                f,
                "payload_hash {declared} doesn't match SHA256(encrypted_payload) {actual}"
            ),
            ProcessForumPostError::SenderRecoveryFailed(err) => {
                write!(f, "couldn't recover sender from raw_burn_tx: {err}")
            }
            ProcessForumPostError::Rejected(outcome) => {
                write!(f, "forum post's initial vote burn rejected: {outcome:?}")
            }
            ProcessForumPostError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// Decode, verify, broadcast-and-confirm, and (on success) store a [`proto::MonadForumPost`]
/// together with its initial vote entry.
///
/// `network_tag` (ticket #39, see `crate::network_tag`'s module docs) is stamped onto the stored
/// post by [`Registry::put_forum_post`] itself, mirroring `crate::http::monad_message::
/// process_monad_message`'s own `network_tag` parameter exactly -- resolved by the caller (from
/// [`crate::network_tag::frank_network_tag`]) and threaded through as an explicit argument rather
/// than read from the environment in here, keeping this function directly unit-testable.
pub async fn process_forum_post<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    burn_address: Address,
    poll: PollConfig,
    network_tag: &[u8],
    request: proto::MonadForumPost,
) -> Result<proto::StoredMonadForumPost, ProcessForumPostError> {
    let declared_hash = Sha256::from_slice(&request.payload_hash)
        .map_err(|_| ProcessForumPostError::InvalidPayloadHashLength(request.payload_hash.len()))?;
    let actual_hash = Sha256::digest(request.encrypted_payload.clone().into());
    if declared_hash != actual_hash {
        return Err(ProcessForumPostError::PayloadHashMismatch {
            declared: declared_hash,
            actual: actual_hash,
        });
    }

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessForumPostError::SenderRecoveryFailed)?;

    let expected = ExpectedForumBurn {
        commitment: declared_hash.clone(),
        burn_address,
    };

    let outcome = broadcast_and_verify_forum_vote(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessForumPostError::Infrastructure)?;

    let (tx_hash, value_wei, direction) = match outcome {
        ForumVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
        } => (tx_hash, value_wei, direction),
        other => return Err(ProcessForumPostError::Rejected(other)),
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let stored = proto::StoredMonadForumPost {
        post: Some(request),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        network_tag: Vec::new(),
    };

    let stored = registry
        .put_forum_post(declared_hash.as_slice(), stored, network_tag)
        .map_err(ProcessForumPostError::Infrastructure)?;

    let vote_entry = proto::StoredMonadForumVoteEntry {
        target_payload_hash: declared_hash.as_slice().to_vec(),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        weight: saturate_weight(direction.signed_weight(value_wei)),
    };
    registry
        .add_forum_vote(&vote_entry)
        .map_err(ProcessForumPostError::Infrastructure)?;

    Ok(stored)
}

/// Errors processing a [`proto::MonadForumVote`], independent of HTTP/axum.
#[derive(Debug)]
pub enum ProcessForumVoteError {
    /// `target_payload_hash` wasn't exactly 32 bytes.
    InvalidTargetPayloadHashLength(usize),
    /// No post is stored for `target_payload_hash` -- rejected before any burn is broadcast (see
    /// `proto/forum_message.proto`'s `MonadForumVote` docs).
    UnknownTargetPost,
    /// [`recover_sender`] couldn't recover a sender address from `raw_burn_tx`.
    SenderRecoveryFailed(EvmTxError),
    /// The vote's burn didn't verify -- see the wrapped [`ForumVoteRelayOutcome`] for exactly
    /// why.
    Rejected(ForumVoteRelayOutcome),
    /// An infrastructure-level failure (RPC/transport error, or a storage error).
    Infrastructure(Report),
}

impl fmt::Display for ProcessForumVoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessForumVoteError::InvalidTargetPayloadHashLength(len) => {
                write!(f, "target_payload_hash must be 32 bytes, got {len}")
            }
            ProcessForumVoteError::UnknownTargetPost => {
                write!(f, "no forum post found for the given target_payload_hash")
            }
            ProcessForumVoteError::SenderRecoveryFailed(err) => {
                write!(f, "couldn't recover sender from raw_burn_tx: {err}")
            }
            ProcessForumVoteError::Rejected(outcome) => {
                write!(f, "forum vote burn rejected: {outcome:?}")
            }
            ProcessForumVoteError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// Decode, verify, broadcast-and-confirm, and (on success) record a [`proto::MonadForumVote`]
/// against its `target_payload_hash`.
pub async fn process_forum_vote<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    burn_address: Address,
    poll: PollConfig,
    request: proto::MonadForumVote,
) -> Result<proto::StoredMonadForumVoteEntry, ProcessForumVoteError> {
    let target_hash = Sha256::from_slice(&request.target_payload_hash).map_err(|_| {
        ProcessForumVoteError::InvalidTargetPayloadHashLength(request.target_payload_hash.len())
    })?;

    registry
        .get_forum_post(target_hash.as_slice())
        .map_err(ProcessForumVoteError::Infrastructure)?
        .ok_or(ProcessForumVoteError::UnknownTargetPost)?;

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessForumVoteError::SenderRecoveryFailed)?;

    let expected = ExpectedForumBurn {
        commitment: target_hash.clone(),
        burn_address,
    };

    let outcome = broadcast_and_verify_forum_vote(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessForumVoteError::Infrastructure)?;

    let (tx_hash, value_wei, direction) = match outcome {
        ForumVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
        } => (tx_hash, value_wei, direction),
        other => return Err(ProcessForumVoteError::Rejected(other)),
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let vote_entry = proto::StoredMonadForumVoteEntry {
        target_payload_hash: target_hash.as_slice().to_vec(),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        weight: saturate_weight(direction.signed_weight(value_wei)),
    };

    registry
        .add_forum_vote(&vote_entry)
        .map_err(ProcessForumVoteError::Infrastructure)?;

    Ok(vote_entry)
}

/// Errors reading required forum-vote gate configuration from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumGateConfigError {
    /// A required env var wasn't set.
    MissingEnv(&'static str),
    /// `MONAD_TESTNET_HTTP_RPC_URL` wasn't a valid URL.
    InvalidRpcUrl(String),
    /// `MONAD_STAMP_BURN_ADDRESS` wasn't a valid `0x`-prefixed 20-byte address.
    InvalidBurnAddress(String),
}

impl fmt::Display for ForumGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ForumGateConfigError::MissingEnv(name) => {
                write!(
                    f,
                    "missing required env var {name} (forum-vote gate is unconfigured)"
                )
            }
            ForumGateConfigError::InvalidRpcUrl(msg) => {
                write!(f, "invalid MONAD_TESTNET_HTTP_RPC_URL: {msg}")
            }
            ForumGateConfigError::InvalidBurnAddress(msg) => {
                write!(f, "invalid MONAD_STAMP_BURN_ADDRESS: {msg}")
            }
        }
    }
}

/// Configuration for the `PUT /message/monad/forum` and `PUT /message/monad/forum/vote` routes,
/// read once from the environment (see module docs).
#[derive(Debug, Clone)]
pub struct ForumGateConfig {
    rpc_url: url::Url,
    burn_address: Address,
}

fn required_env(name: &'static str) -> Result<String, ForumGateConfigError> {
    std::env::var(name).map_err(|_| ForumGateConfigError::MissingEnv(name))
}

impl ForumGateConfig {
    fn from_env() -> Result<Self, ForumGateConfigError> {
        let rpc_url = required_env("MONAD_TESTNET_HTTP_RPC_URL")?;
        let rpc_url: url::Url = rpc_url
            .parse()
            .map_err(|err| ForumGateConfigError::InvalidRpcUrl(format!("{err}")))?;
        let burn_address_hex = required_env("MONAD_STAMP_BURN_ADDRESS")?;
        let burn_address = Address::from_hex(&burn_address_hex)
            .map_err(|err| ForumGateConfigError::InvalidBurnAddress(format!("{err}")))?;
        Ok(ForumGateConfig {
            rpc_url,
            burn_address,
        })
    }
}

/// Process-wide, lazily-initialized gate config, built from the environment on first use.
fn forum_gate() -> &'static Result<ForumGateConfig, ForumGateConfigError> {
    static GATE: OnceLock<Result<ForumGateConfig, ForumGateConfigError>> = OnceLock::new();
    GATE.get_or_init(ForumGateConfig::from_env)
}

/// JSON error body for a rejected forum request.
#[derive(Debug, Serialize)]
struct ForumErrorBody {
    error: &'static str,
    detail: String,
}

/// Error type for [`handle_put_forum_post`].
#[derive(Debug)]
pub enum PutForumPostError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(ForumGateConfigError),
    /// [`process_forum_post`] rejected (or failed to process) the post.
    Process(ProcessForumPostError),
}

impl IntoResponse for PutForumPostError {
    fn into_response(self) -> Response {
        match self {
            PutForumPostError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "forum-vote gate is misconfigured; rejecting forum post"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutForumPostError::Process(ProcessForumPostError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing forum post");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutForumPostError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(ForumErrorBody {
                    error: "invalid_forum_post",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
        }
    }
}

/// `PUT /message/monad/forum`: decode a [`proto::MonadForumPost`], recover its sender, verify its
/// initial vote's burn (broadcasting it), and store the post plus its initial vote on success.
pub async fn handle_put_forum_post(
    Protobuf(post): Protobuf<proto::MonadForumPost>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadForumPost>, PutForumPostError> {
    let config = forum_gate()
        .as_ref()
        .map_err(|err| PutForumPostError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    let stored = process_forum_post(
        &transport,
        &server.registry,
        config.burn_address,
        PollConfig::default(),
        crate::network_tag::frank_network_tag(),
        post,
    )
    .await
    .map_err(PutForumPostError::Process)?;
    Ok(Protobuf(stored))
}

/// Error type for [`handle_put_forum_vote`].
#[derive(Debug)]
pub enum PutForumVoteError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(ForumGateConfigError),
    /// [`process_forum_vote`] rejected (or failed to process) the vote.
    Process(ProcessForumVoteError),
}

impl IntoResponse for PutForumVoteError {
    fn into_response(self) -> Response {
        match self {
            PutForumVoteError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "forum-vote gate is misconfigured; rejecting forum vote"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutForumVoteError::Process(ProcessForumVoteError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing forum vote");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutForumVoteError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(ForumErrorBody {
                    error: "invalid_forum_vote",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
        }
    }
}

/// `PUT /message/monad/forum/vote`: decode a [`proto::MonadForumVote`], recover its sender,
/// verify its burn (broadcasting it), and record it against its `target_payload_hash` on success.
pub async fn handle_put_forum_vote(
    Protobuf(vote): Protobuf<proto::MonadForumVote>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadForumVoteEntry>, PutForumVoteError> {
    let config = forum_gate()
        .as_ref()
        .map_err(|err| PutForumVoteError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    let stored = process_forum_vote(
        &transport,
        &server.registry,
        config.burn_address,
        PollConfig::default(),
        vote,
    )
    .await
    .map_err(PutForumVoteError::Process)?;
    Ok(Protobuf(stored))
}

/// Error type for [`handle_get_forum_post`].
#[derive(Debug)]
pub enum GetForumPostError {
    /// The `:payload_hash` path segment wasn't valid hex.
    InvalidHex(hex::FromHexError),
    /// No post stored for the given `payload_hash`.
    NotFound,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for GetForumPostError {
    fn into_response(self) -> Response {
        match self {
            GetForumPostError::InvalidHex(err) => (
                StatusCode::BAD_REQUEST,
                Json(ForumErrorBody {
                    error: "invalid_payload_hash",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
            GetForumPostError::NotFound => StatusCode::NOT_FOUND.into_response(),
            GetForumPostError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure fetching forum post");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad/forum/:payload_hash`: fetch a stored [`proto::StoredMonadForumPost`]
/// together with its current tallied vote weight, as a [`proto::MonadForumPostView`].
pub async fn handle_get_forum_post(
    Path(hex_hash): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::MonadForumPostView>, GetForumPostError> {
    let payload_hash = hex::decode(&hex_hash).map_err(GetForumPostError::InvalidHex)?;
    let view = server
        .registry
        .get_forum_post_view(&payload_hash)
        .map_err(GetForumPostError::Infrastructure)?
        .ok_or(GetForumPostError::NotFound)?;
    Ok(Protobuf(view))
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
        monad_evm_tx::test_support::signed_eip1559_tx,
        monad_forum_verify::{FORUM_COMMITMENT_VERSION_TAG, FORUM_VOTE_LOKAD_ID},
        monad_http::MonadRpcError,
        store::db::Db,
    };
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};

    /// [`ChainAdapter`] stub, mirroring `http::monad_message`'s test support: never touched by
    /// the forum path.
    #[derive(Debug)]
    struct UnusedChainAdapter;

    #[async_trait]
    impl ChainAdapter for UnusedChainAdapter {
        async fn submit_tx(&self, _raw_tx: &[u8]) -> bitcoinsuite_error::Result<SubmitTxOutcome> {
            unimplemented!("not used by the forum path")
        }
        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            unimplemented!("not used by the forum path")
        }
        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<MempoolAcceptResult> {
            unimplemented!("not used by the forum path")
        }
        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            unimplemented!("not used by the forum path")
        }
        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<Sha256> {
            unimplemented!("not used by the forum path")
        }
    }

    fn test_registry() -> (TempDir, Registry) {
        let tempdir = TempDir::new("cashweb-registry--forum-http-route").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(UnusedChainAdapter), Net::Regtest);
        (tempdir, registry)
    }

    fn burn_address() -> Address {
        Address([0x44; 20])
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

    fn forum_calldata(direction: u8, commitment: &Sha256) -> Vec<u8> {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&FORUM_VOTE_LOKAD_ID);
        calldata.push(FORUM_COMMITMENT_VERSION_TAG);
        calldata.push(direction);
        calldata.extend_from_slice(commitment.as_slice());
        calldata
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

    fn tx_json(to: &str, value_wei: u128, input: &[u8]) -> Value {
        serde_json::json!({
            "hash": hex_hash(0x11),
            "to": to,
            "value": format!("0x{:x}", value_wei),
            "input": format!("0x{}", hex::encode(input)),
            "from": "0x3333333333333333333333333333333333333333",
        })
    }

    #[derive(Clone, Default)]
    struct MockTransport {
        responses: Arc<Mutex<HashMap<String, Value>>>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
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
            if method == "eth_sendRawTransaction" {
                // Defaults to hash 0x11 (matching the receipt/tx fixtures below), but tests that
                // need a *distinct* broadcast tx hash (e.g. to prove multiple votes tally
                // separately rather than colliding on `DbForumVotes`' tx_hash-keyed dedup) can
                // `set("eth_sendRawTransaction", ...)` to override it.
                return Ok(self
                    .responses
                    .lock()
                    .unwrap()
                    .get(method)
                    .cloned()
                    .unwrap_or_else(|| Value::String(hex_hash(0x11))));
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

    fn make_post(raw_burn_tx: Vec<u8>, encrypted_payload: Vec<u8>) -> proto::MonadForumPost {
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        proto::MonadForumPost {
            topic: "test.topic".to_string(),
            parent_post_hash: vec![],
            raw_burn_tx,
            encrypted_payload,
            payload_hash,
        }
    }

    #[tokio::test]
    async fn valid_up_vote_post_is_accepted_and_stored_with_positive_tally() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = b"hello, forum".to_vec();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let calldata = forum_calldata(0x01, &commitment);
        let (raw_burn_tx, sender) =
            signed_eip1559_tx(&seckey, 41454, 0, burn_address(), 10_000, &calldata);

        let post = make_post(raw_burn_tx, encrypted_payload);

        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &forum_calldata(0x01, &commitment)),
        );

        let stored = process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            b"MONT",
            post.clone(),
        )
        .await
        .expect("valid up-vote post should be accepted");

        assert_eq!(stored.sender_address, sender.0.to_vec());
        assert_eq!(stored.post, Some(post.clone()));
        // Ticket #39: the relay's configured network tag is stamped onto the stored post.
        assert_eq!(stored.network_tag, b"MONT");

        let view = registry
            .get_forum_post_view(&post.payload_hash)
            .unwrap()
            .expect("post should be stored");
        assert_eq!(view.post, Some(stored));
        assert_eq!(view.vote_weight, 10_000);
    }

    #[tokio::test]
    async fn valid_down_vote_post_has_negative_tally() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = b"down vote post".to_vec();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x88; 32])
            .unwrap();
        let calldata = forum_calldata(0x00, &commitment);
        let (raw_burn_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, burn_address(), 5_000, &calldata);

        let post = make_post(raw_burn_tx, encrypted_payload);

        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 5_000, &forum_calldata(0x00, &commitment)),
        );

        process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &[],
            post.clone(),
        )
        .await
        .expect("valid down-vote post should be accepted");

        let view = registry
            .get_forum_post_view(&post.payload_hash)
            .unwrap()
            .unwrap();
        assert_eq!(view.vote_weight, -5_000);
    }

    #[tokio::test]
    async fn multiple_votes_tally_correctly() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = b"post with multiple votes".to_vec();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let post_seckey = EccSecp256k1::default()
            .seckey_from_array([0x11; 32])
            .unwrap();
        let post_calldata = forum_calldata(0x01, &commitment);
        let (post_raw_tx, _post_sender) = signed_eip1559_tx(
            &post_seckey,
            41454,
            0,
            burn_address(),
            1_000,
            &post_calldata,
        );
        let post = make_post(post_raw_tx, encrypted_payload);

        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 1_000, &forum_calldata(0x01, &commitment)),
        );

        process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &[],
            post.clone(),
        )
        .await
        .expect("initial post should be accepted");
        assert_eq!(
            registry
                .get_forum_post_view(&post.payload_hash)
                .unwrap()
                .unwrap()
                .vote_weight,
            1_000
        );

        // Second vote: up-vote for +2_000 (new tx hash 0x22, since MockTransport always returns
        // the tx it's configured with -- reconfigure the mock's receipt/tx to a distinct hash for
        // clarity, keyed by the calldata/value below).
        let vote_seckey = EccSecp256k1::default()
            .seckey_from_array([0x22; 32])
            .unwrap();
        let vote_calldata = forum_calldata(0x01, &commitment);
        let (vote_raw_tx, vote_sender) = signed_eip1559_tx(
            &vote_seckey,
            41454,
            1,
            burn_address(),
            2_000,
            &vote_calldata,
        );
        let vote = proto::MonadForumVote {
            target_payload_hash: post.payload_hash.clone(),
            raw_burn_tx: vote_raw_tx,
        };

        let transport2 = MockTransport::default();
        // Distinct broadcast tx hash from the first vote's (0x11): `DbForumVotes` keys each vote
        // entry by `target_payload_hash ++ tx_hash`, so two votes sharing a tx hash would
        // (correctly) collapse into one idempotent entry instead of tallying separately.
        transport2.set("eth_sendRawTransaction", Value::String(hex_hash(0x22)));
        transport2.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": hex_hash(0x22),
                "blockHash": hex_hash(0x23),
                "blockNumber": "0x2b",
                "from": "0x3333333333333333333333333333333333333333",
                "to": to,
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport2.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": hex_hash(0x22),
                "to": to,
                "value": format!("0x{:x}", 2_000u128),
                "input": format!("0x{}", hex::encode(forum_calldata(0x01, &commitment))),
                "from": "0x3333333333333333333333333333333333333333",
            }),
        );

        let vote_entry =
            process_forum_vote(&transport2, &registry, burn_address(), fast_poll(), vote)
                .await
                .expect("additional vote should be accepted");
        assert_eq!(vote_entry.sender_address, vote_sender.0.to_vec());
        assert_eq!(vote_entry.weight, 2_000);

        let view = registry
            .get_forum_post_view(&post.payload_hash)
            .unwrap()
            .unwrap();
        assert_eq!(view.vote_weight, 3_000);
    }

    #[tokio::test]
    async fn vote_on_unknown_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let vote = proto::MonadForumVote {
            target_payload_hash: vec![0xaa; 32],
            raw_burn_tx: vec![0x01, 0xc0],
        };
        // No transport responses at all: if this reached the network, it would fail loudly with
        // "no mock response configured" rather than a clean rejection.
        let transport = MockTransport::default();

        let err = process_forum_vote(&transport, &registry, burn_address(), fast_poll(), vote)
            .await
            .expect_err("voting on an unknown post should be rejected");

        assert!(matches!(err, ProcessForumVoteError::UnknownTargetPost));
    }

    #[tokio::test]
    async fn mismatched_payload_hash_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let mut post = make_post(vec![0xc0], b"hello".to_vec());
        post.payload_hash[0] ^= 0xff;

        let transport = MockTransport::default();
        let err = process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &[],
            post,
        )
        .await
        .expect_err("mismatched payload_hash should be rejected");

        assert!(matches!(
            err,
            ProcessForumPostError::PayloadHashMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn malformed_raw_burn_tx_post_is_rejected() {
        let (_tempdir, registry) = test_registry();
        let post = make_post(vec![0x01, 0xc0], b"hello".to_vec());
        let transport = MockTransport::default();

        let err = process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &[],
            post,
        )
        .await
        .expect_err("malformed raw_burn_tx should be rejected");

        assert!(matches!(
            err,
            ProcessForumPostError::SenderRecoveryFailed(_)
        ));
    }

    #[tokio::test]
    async fn wrong_recipient_post_is_rejected_and_not_stored() {
        let (_tempdir, registry) = test_registry();
        let encrypted_payload = b"wrong recipient".to_vec();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x33; 32])
            .unwrap();
        let calldata = forum_calldata(0x01, &commitment);
        // Sent to a different address than `burn_address()`.
        let (raw_burn_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, Address([0x99; 20]), 1_000, &calldata);
        let post = make_post(raw_burn_tx, encrypted_payload);

        let wrong_to = hex_addr(Address([0x99; 20]));
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&wrong_to, "0x1"));

        let err = process_forum_post(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &[],
            post.clone(),
        )
        .await
        .expect_err("wrong recipient should be rejected");

        assert!(matches!(
            err,
            ProcessForumPostError::Rejected(ForumVoteRelayOutcome::VerificationFailed { .. })
        ));
        assert_eq!(registry.get_forum_post(&post.payload_hash).unwrap(), None);
    }

    #[test]
    fn gate_config_error_display_mentions_missing_var() {
        let err = ForumGateConfigError::MissingEnv("MONAD_STAMP_BURN_ADDRESS");
        assert!(err.to_string().contains("MONAD_STAMP_BURN_ADDRESS"));
    }

    #[test]
    fn saturate_weight_clamps_out_of_range_values() {
        assert_eq!(saturate_weight(0), 0);
        assert_eq!(saturate_weight(1_000), 1_000);
        assert_eq!(saturate_weight(-1_000), -1_000);
        assert_eq!(saturate_weight(i128::from(i64::MAX) + 10), i64::MAX);
        assert_eq!(saturate_weight(i128::from(i64::MIN) - 10), i64::MIN);
    }
}
