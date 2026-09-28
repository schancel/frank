//! `PUT /message/monad/topics`, `PUT /message/monad/topics/vote`, and
//! `GET /message/monad/topics/:payload_hash`: the HTTP path for Monad topic posts and their
//! burn-weighted votes (ticket #30).
//!
//! Mirrors `crate::http::monad_message`'s decode -> verify -> store shape (ticket #27) closely,
//! with two Monad-topic-specific differences:
//! - Verification goes through [`crate::monad_topic_verify::verify_topic_vote_burn`] (via
//!   [`crate::monad_topic_relay::broadcast_and_verify_topic_vote`]) rather than
//!   `monad_stamp_verify::verify_stamp_burn`/`monad_stamp_relay::broadcast_and_verify_stamp` --
//!   see those modules' docs for the calldata-layout and outcome-type reasons they can't be
//!   reused as-is here.
//! - A verified burn doesn't just gate a store, it also *is* a vote: both `PUT` routes below
//!   record a [`proto::StoredMonadTopicVoteEntry`] alongside whatever else they store (a new post
//!   also creates its own initial vote entry), so [`Registry::get_monad_topic_post_view`]'s tally is
//!   simply the sum of every recorded entry for a `payload_hash`.
//!
//! ## Configuration
//!
//! Reuses the *same* two canonical env vars `crate::http::monad_message`'s
//! `MonadMessageGateConfig` reads (`MONAD_TESTNET_HTTP_RPC_URL`, `MONAD_STAMP_BURN_ADDRESS` --
//! see `.env.example`), rather than inventing topic-specific ones: a topic vote burns to the same
//! configured Stamp burn address, just tagged with [`crate::monad_topic_verify::
//! TOPIC_VOTE_LOKAD_ID`] in its calldata instead of `POND`/`STMP`, so there's no reason for a
//! second, easy-to-typo burn-address var (exactly the class of bug ticket #8's e2e demo found and
//! fixed for `monad_message.rs`). Unlike that module's gate, there's no
//! `CASHWEB_STAMP_MIN_BURN_VALUE_WEI` equivalent here: a topic vote's exact value *is* its
//! weight, never thresholded against a minimum (see `monad_topic_verify`'s module docs), so
//! nothing here needs a minimum-value config at all.
//!
//! `monad_message_gate`'s own gate config (in `crate::http::monad_message`) is private to that
//! module and that module can't be edited to expose it, so this module reads its own
//! process-wide `OnceLock`, following the same fail-closed convention (`crate::http::
//! pop_protection`'s "read once from the environment on first use" pattern, restated in
//! `monad_message`'s own docs).

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
use serde::{Deserialize, Serialize};
use tracing::Level;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{recover_sender, EvmTxError},
    monad_http::{Address, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_relay::{broadcast_and_verify_topic_vote, TopicVoteRelayOutcome},
    monad_topic_verify::ExpectedTopicBurn,
    proto,
    registry::Registry,
};

/// Narrow an [`i128`] signed weight (see [`crate::monad_topic_verify::VoteDirection::
/// signed_weight`]) down to the `sint64` the wire format/store use, saturating rather than
/// wrapping for a burn value large enough to overflow `i64` (see `proto/topic_message.proto`'s
/// docs on why `i64` is an acceptable simplification for this ticket's scope). Saturating (rather
/// than truncating with `as i64`, which would silently wrap into an unrelated, possibly
/// wrong-signed value) keeps an out-of-range weight merely *capped*, not corrupted.
fn saturate_weight(weight: i128) -> i64 {
    weight.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// Errors processing a [`proto::MonadTopicPost`], independent of HTTP/axum, mirroring
/// `crate::http::monad_message::ProcessMonadMessageError`.
#[derive(Debug)]
pub enum ProcessMonadTopicPostError {
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
    /// The initial vote's burn didn't verify -- see the wrapped [`TopicVoteRelayOutcome`] for
    /// exactly why. Every non-[`TopicVoteRelayOutcome::Verified`] outcome is a rejection, never a
    /// silent store.
    Rejected(TopicVoteRelayOutcome),
    /// An infrastructure-level failure (RPC/transport error, or a storage error).
    Infrastructure(Report),
}

impl fmt::Display for ProcessMonadTopicPostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessMonadTopicPostError::InvalidPayloadHashLength(len) => {
                write!(f, "payload_hash must be 32 bytes, got {len}")
            }
            ProcessMonadTopicPostError::PayloadHashMismatch { declared, actual } => write!(
                f,
                "payload_hash {declared} doesn't match SHA256(encrypted_payload) {actual}"
            ),
            ProcessMonadTopicPostError::SenderRecoveryFailed(err) => {
                write!(f, "couldn't recover sender from raw_burn_tx: {err}")
            }
            ProcessMonadTopicPostError::Rejected(outcome) => {
                write!(f, "topic post's initial vote burn rejected: {outcome:?}")
            }
            ProcessMonadTopicPostError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// Decode, verify, broadcast-and-confirm, and (on success) store a [`proto::MonadTopicPost`]
/// together with its initial vote entry.
///
/// `network_tag` (ticket #39, see `crate::network_tag`'s module docs) is stamped onto the stored
/// post by [`Registry::put_monad_topic_post`] itself, mirroring `crate::http::monad_message::
/// process_monad_message`'s own `network_tag` parameter exactly -- resolved by the caller (from
/// [`crate::network_tag::frank_network_tag`]) and threaded through as an explicit argument rather
/// than read from the environment in here, keeping this function directly unit-testable.
pub async fn process_monad_topic_post<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    burn_address: Address,
    poll: PollConfig,
    network_tag: &[u8],
    request: proto::MonadTopicPost,
) -> Result<proto::StoredMonadTopicPost, ProcessMonadTopicPostError> {
    let declared_hash = Sha256::from_slice(&request.payload_hash).map_err(|_| {
        ProcessMonadTopicPostError::InvalidPayloadHashLength(request.payload_hash.len())
    })?;
    let actual_hash = Sha256::digest(request.encrypted_payload.clone().into());
    if declared_hash != actual_hash {
        return Err(ProcessMonadTopicPostError::PayloadHashMismatch {
            declared: declared_hash,
            actual: actual_hash,
        });
    }

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessMonadTopicPostError::SenderRecoveryFailed)?;

    let expected = ExpectedTopicBurn {
        commitment: declared_hash.clone(),
        burn_address,
    };

    let outcome = broadcast_and_verify_topic_vote(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessMonadTopicPostError::Infrastructure)?;

    let (tx_hash, value_wei, direction) = match outcome {
        TopicVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
        } => (tx_hash, value_wei, direction),
        other => return Err(ProcessMonadTopicPostError::Rejected(other)),
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let stored = proto::StoredMonadTopicPost {
        post: Some(request),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        network_tag: Vec::new(),
    };

    let stored = registry
        .put_monad_topic_post(declared_hash.as_slice(), stored, network_tag)
        .map_err(ProcessMonadTopicPostError::Infrastructure)?;

    let vote_entry = proto::StoredMonadTopicVoteEntry {
        target_payload_hash: declared_hash.as_slice().to_vec(),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        weight: saturate_weight(direction.signed_weight(value_wei)),
    };
    registry
        .add_monad_topic_vote(&vote_entry)
        .map_err(ProcessMonadTopicPostError::Infrastructure)?;

    Ok(stored)
}

/// Errors processing a [`proto::MonadTopicVote`], independent of HTTP/axum.
#[derive(Debug)]
pub enum ProcessMonadTopicVoteError {
    /// `target_payload_hash` wasn't exactly 32 bytes.
    InvalidTargetPayloadHashLength(usize),
    /// No post is stored for `target_payload_hash` -- rejected before any burn is broadcast (see
    /// `proto/topic_message.proto`'s `MonadTopicVote` docs).
    UnknownTargetPost,
    /// [`recover_sender`] couldn't recover a sender address from `raw_burn_tx`.
    SenderRecoveryFailed(EvmTxError),
    /// The vote's burn didn't verify -- see the wrapped [`TopicVoteRelayOutcome`] for exactly
    /// why.
    Rejected(TopicVoteRelayOutcome),
    /// An infrastructure-level failure (RPC/transport error, or a storage error).
    Infrastructure(Report),
}

impl fmt::Display for ProcessMonadTopicVoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessMonadTopicVoteError::InvalidTargetPayloadHashLength(len) => {
                write!(f, "target_payload_hash must be 32 bytes, got {len}")
            }
            ProcessMonadTopicVoteError::UnknownTargetPost => {
                write!(f, "no topic post found for the given target_payload_hash")
            }
            ProcessMonadTopicVoteError::SenderRecoveryFailed(err) => {
                write!(f, "couldn't recover sender from raw_burn_tx: {err}")
            }
            ProcessMonadTopicVoteError::Rejected(outcome) => {
                write!(f, "topic vote burn rejected: {outcome:?}")
            }
            ProcessMonadTopicVoteError::Infrastructure(err) => {
                write!(f, "infrastructure failure: {err}")
            }
        }
    }
}

/// Decode, verify, broadcast-and-confirm, and (on success) record a [`proto::MonadTopicVote`]
/// against its `target_payload_hash`.
pub async fn process_monad_topic_vote<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    burn_address: Address,
    poll: PollConfig,
    request: proto::MonadTopicVote,
) -> Result<proto::StoredMonadTopicVoteEntry, ProcessMonadTopicVoteError> {
    let target_hash = Sha256::from_slice(&request.target_payload_hash).map_err(|_| {
        ProcessMonadTopicVoteError::InvalidTargetPayloadHashLength(
            request.target_payload_hash.len(),
        )
    })?;

    registry
        .get_monad_topic_post(target_hash.as_slice())
        .map_err(ProcessMonadTopicVoteError::Infrastructure)?
        .ok_or(ProcessMonadTopicVoteError::UnknownTargetPost)?;

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessMonadTopicVoteError::SenderRecoveryFailed)?;

    let expected = ExpectedTopicBurn {
        commitment: target_hash.clone(),
        burn_address,
    };

    let outcome = broadcast_and_verify_topic_vote(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessMonadTopicVoteError::Infrastructure)?;

    let (tx_hash, value_wei, direction) = match outcome {
        TopicVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
        } => (tx_hash, value_wei, direction),
        other => return Err(ProcessMonadTopicVoteError::Rejected(other)),
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let vote_entry = proto::StoredMonadTopicVoteEntry {
        target_payload_hash: target_hash.as_slice().to_vec(),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        weight: saturate_weight(direction.signed_weight(value_wei)),
    };

    registry
        .add_monad_topic_vote(&vote_entry)
        .map_err(ProcessMonadTopicVoteError::Infrastructure)?;

    Ok(vote_entry)
}

/// Errors reading required topic-vote gate configuration from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadTopicGateConfigError {
    /// A required env var wasn't set.
    MissingEnv(&'static str),
    /// `MONAD_TESTNET_HTTP_RPC_URL` wasn't a valid URL.
    InvalidRpcUrl(String),
    /// `MONAD_STAMP_BURN_ADDRESS` wasn't a valid `0x`-prefixed 20-byte address.
    InvalidBurnAddress(String),
}

impl fmt::Display for MonadTopicGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MonadTopicGateConfigError::MissingEnv(name) => {
                write!(
                    f,
                    "missing required env var {name} (topic-vote gate is unconfigured)"
                )
            }
            MonadTopicGateConfigError::InvalidRpcUrl(msg) => {
                write!(f, "invalid MONAD_TESTNET_HTTP_RPC_URL: {msg}")
            }
            MonadTopicGateConfigError::InvalidBurnAddress(msg) => {
                write!(f, "invalid MONAD_STAMP_BURN_ADDRESS: {msg}")
            }
        }
    }
}

/// Configuration for the `PUT /message/monad/topics` and `PUT /message/monad/topics/vote` routes,
/// read once from the environment (see module docs).
#[derive(Debug, Clone)]
pub struct MonadTopicGateConfig {
    rpc_url: url::Url,
    burn_address: Address,
}

fn required_env(name: &'static str) -> Result<String, MonadTopicGateConfigError> {
    std::env::var(name).map_err(|_| MonadTopicGateConfigError::MissingEnv(name))
}

impl MonadTopicGateConfig {
    fn from_env() -> Result<Self, MonadTopicGateConfigError> {
        let rpc_url = required_env("MONAD_TESTNET_HTTP_RPC_URL")?;
        let rpc_url: url::Url = rpc_url
            .parse()
            .map_err(|err| MonadTopicGateConfigError::InvalidRpcUrl(format!("{err}")))?;
        let burn_address_hex = required_env("MONAD_STAMP_BURN_ADDRESS")?;
        let burn_address = Address::from_hex(&burn_address_hex)
            .map_err(|err| MonadTopicGateConfigError::InvalidBurnAddress(format!("{err}")))?;
        Ok(MonadTopicGateConfig {
            rpc_url,
            burn_address,
        })
    }
}

/// Process-wide, lazily-initialized gate config, built from the environment on first use.
fn monad_topic_gate() -> &'static Result<MonadTopicGateConfig, MonadTopicGateConfigError> {
    static GATE: OnceLock<Result<MonadTopicGateConfig, MonadTopicGateConfigError>> =
        OnceLock::new();
    GATE.get_or_init(MonadTopicGateConfig::from_env)
}

/// JSON error body for a rejected topic request.
#[derive(Debug, Serialize)]
struct MonadTopicErrorBody {
    error: &'static str,
    detail: String,
}

/// Error type for [`handle_put_monad_topic_post`].
#[derive(Debug)]
pub enum PutMonadTopicPostError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(MonadTopicGateConfigError),
    /// [`process_monad_topic_post`] rejected (or failed to process) the post.
    Process(ProcessMonadTopicPostError),
}

impl IntoResponse for PutMonadTopicPostError {
    fn into_response(self) -> Response {
        match self {
            PutMonadTopicPostError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "topic-vote gate is misconfigured; rejecting topic post"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicPostError::Process(ProcessMonadTopicPostError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing topic post");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicPostError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_post",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
        }
    }
}

/// `PUT /message/monad/topics`: decode a [`proto::MonadTopicPost`], recover its sender, verify its
/// initial vote's burn (broadcasting it), and store the post plus its initial vote on success.
pub async fn handle_put_monad_topic_post(
    Protobuf(post): Protobuf<proto::MonadTopicPost>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadTopicPost>, PutMonadTopicPostError> {
    let config = monad_topic_gate()
        .as_ref()
        .map_err(|err| PutMonadTopicPostError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    let stored = process_monad_topic_post(
        &transport,
        &server.registry,
        config.burn_address,
        PollConfig::default(),
        crate::network_tag::frank_network_tag(),
        post,
    )
    .await
    .map_err(PutMonadTopicPostError::Process)?;
    Ok(Protobuf(stored))
}

/// Error type for [`handle_put_monad_topic_vote`].
#[derive(Debug)]
pub enum PutMonadTopicVoteError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(MonadTopicGateConfigError),
    /// [`process_monad_topic_vote`] rejected (or failed to process) the vote.
    Process(ProcessMonadTopicVoteError),
}

impl IntoResponse for PutMonadTopicVoteError {
    fn into_response(self) -> Response {
        match self {
            PutMonadTopicVoteError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "topic-vote gate is misconfigured; rejecting topic vote"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing topic vote");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicVoteError::Process(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_vote",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
        }
    }
}

/// `PUT /message/monad/topics/vote`: decode a [`proto::MonadTopicVote`], recover its sender,
/// verify its burn (broadcasting it), and record it against its `target_payload_hash` on success.
pub async fn handle_put_monad_topic_vote(
    Protobuf(vote): Protobuf<proto::MonadTopicVote>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::StoredMonadTopicVoteEntry>, PutMonadTopicVoteError> {
    let config = monad_topic_gate()
        .as_ref()
        .map_err(|err| PutMonadTopicVoteError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    let stored = process_monad_topic_vote(
        &transport,
        &server.registry,
        config.burn_address,
        PollConfig::default(),
        vote,
    )
    .await
    .map_err(PutMonadTopicVoteError::Process)?;
    Ok(Protobuf(stored))
}

/// Error type for [`handle_get_monad_topic_post`].
#[derive(Debug)]
pub enum GetMonadTopicPostError {
    /// The `:payload_hash` path segment wasn't valid hex.
    InvalidHex(hex::FromHexError),
    /// No post stored for the given `payload_hash`.
    NotFound,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for GetMonadTopicPostError {
    fn into_response(self) -> Response {
        match self {
            GetMonadTopicPostError::InvalidHex(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_payload_hash",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
            GetMonadTopicPostError::NotFound => StatusCode::NOT_FOUND.into_response(),
            GetMonadTopicPostError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure fetching topic post");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad/topics/:payload_hash`: fetch a stored [`proto::StoredMonadTopicPost`]
/// together with its current tallied vote weight, as a [`proto::MonadTopicPostView`].
pub async fn handle_get_monad_topic_post(
    Path(hex_hash): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::MonadTopicPostView>, GetMonadTopicPostError> {
    let payload_hash = hex::decode(&hex_hash).map_err(GetMonadTopicPostError::InvalidHex)?;
    let view = server
        .registry
        .get_monad_topic_post_view(&payload_hash)
        .map_err(GetMonadTopicPostError::Infrastructure)?
        .ok_or(GetMonadTopicPostError::NotFound)?;
    Ok(Protobuf(view))
}

/// Query parameters for [`handle_list_monad_topic_posts`].
#[derive(Debug, Deserialize)]
pub struct ListMonadTopicPostsQuery {
    /// Topic to list posts for. Required, unlike `ListMonadMessagesQuery::since` -- there's no
    /// meaningful "every topic" default the way `GET /message/monad?since=` has one global feed;
    /// topic posts are always browsed per-topic (ticket #40).
    topic: String,
    /// Only return posts stored at or after this many milliseconds since the Unix epoch. Defaults
    /// to `0` (every stored post under `topic`) when omitted, mirroring `ListMonadMessagesQuery::
    /// since` (ticket #37).
    since: Option<i64>,
}

/// Error type for [`handle_list_monad_topic_posts`].
#[derive(Debug)]
pub enum ListMonadTopicPostsError {
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListMonadTopicPostsError {
    fn into_response(self) -> Response {
        match self {
            ListMonadTopicPostsError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure listing topic posts");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad/topics?topic=<topic>&since=<timestamp>` (ticket #40): list every
/// [`proto::StoredMonadTopicPost`] under `topic` stored at or after `since` (milliseconds since
/// the Unix epoch), ordered by `timestamp` ascending, each paired with its current tallied vote
/// weight -- mirrors `crate::http::monad_message::handle_list_monad_messages`'s `since`-cursor
/// discovery model (ticket #37), with `topic` required in addition (see
/// [`ListMonadTopicPostsQuery::topic`]'s doc). No gate/burn check here, same as
/// [`handle_get_monad_topic_post`] -- reads aren't payment/burn-gated anywhere in this crate.
pub async fn handle_list_monad_topic_posts(
    Query(params): Query<ListMonadTopicPostsQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::MonadTopicPostViews>, ListMonadTopicPostsError> {
    let since = params.since.unwrap_or(0);
    let views = server
        .registry
        .list_monad_topic_posts_by_topic(&params.topic, since)
        .map_err(ListMonadTopicPostsError::Infrastructure)?;
    Ok(Protobuf(proto::MonadTopicPostViews { views }))
}

/// Error type for [`handle_list_topics`].
#[derive(Debug)]
pub enum ListTopicsError {
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListTopicsError {
    fn into_response(self) -> Response {
        match self {
            ListTopicsError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure listing discovered topics");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /message/monad/topics/discover` (ticket #72): list every distinct topic name this relay
/// has stored at least one post for, each paired with its post count and last-activity timestamp,
/// ordered by last-activity descending.
///
/// Per the design decision recorded on GitHub issue #72, topics stay emergent/tag-based -- no
/// separate topic-registration flow, and no separate anti-spam gate for showing up in this index:
/// a topic post already requires a real burn transaction to store (see
/// [`handle_put_monad_topic_post`]/`monad_topic_verify`'s module docs), so a topic name appearing
/// here is already gated by that same cost. Accordingly, this route uses protobuf like the rest of
/// the `/message/monad/*` routes (unlike ticket #49's curated-defaults route, which deliberately
/// used plain JSON for an unrelated reason -- see that ticket's own route for why). No gate/burn
/// check here either, same as [`handle_list_monad_topic_posts`] -- reads aren't payment/burn-gated
/// anywhere in this crate. No `since`/pagination parameter -- see
/// `crate::store::monad_topics::DbMonadTopicPosts::list_topics`'s docs for why (small keyspace;
/// the client/route can add pagination later if that ever changes).
pub async fn handle_list_topics(
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::ListTopicsResponse>, ListTopicsError> {
    let entries = server
        .registry
        .list_topics()
        .map_err(ListTopicsError::Infrastructure)?
        .into_iter()
        .map(|(topic, stats)| proto::TopicDiscoveryEntry {
            topic,
            post_count: stats.post_count,
            last_activity_ms: stats.last_activity_ms,
        })
        .collect();
    Ok(Protobuf(proto::ListTopicsResponse { entries }))
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
        monad_http::MonadRpcError,
        monad_topic_verify::{TOPIC_COMMITMENT_VERSION_TAG, TOPIC_VOTE_LOKAD_ID},
        store::db::Db,
    };
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};

    /// [`ChainAdapter`] stub, mirroring `http::monad_message`'s test support: never touched by
    /// the topic path.
    #[derive(Debug)]
    struct UnusedChainAdapter;

    #[async_trait]
    impl ChainAdapter for UnusedChainAdapter {
        async fn submit_tx(&self, _raw_tx: &[u8]) -> bitcoinsuite_error::Result<SubmitTxOutcome> {
            unimplemented!("not used by the topic path")
        }
        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            unimplemented!("not used by the topic path")
        }
        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<MempoolAcceptResult> {
            unimplemented!("not used by the topic path")
        }
        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            unimplemented!("not used by the topic path")
        }
        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<Sha256> {
            unimplemented!("not used by the topic path")
        }
    }

    fn test_registry() -> (TempDir, Registry) {
        let tempdir = TempDir::new("cashweb-registry--topic-http-route").unwrap();
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

    fn topic_calldata(direction: u8, commitment: &Sha256) -> Vec<u8> {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&TOPIC_VOTE_LOKAD_ID);
        calldata.push(TOPIC_COMMITMENT_VERSION_TAG);
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
                // separately rather than colliding on `DbMonadTopicVotes`' tx_hash-keyed dedup) can
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

    fn make_post(raw_burn_tx: Vec<u8>, encrypted_payload: Vec<u8>) -> proto::MonadTopicPost {
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        proto::MonadTopicPost {
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
        let encrypted_payload = b"hello, topic".to_vec();
        let commitment = Sha256::digest(encrypted_payload.clone().into());

        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x77; 32])
            .unwrap();
        let calldata = topic_calldata(0x01, &commitment);
        let (raw_burn_tx, sender) =
            signed_eip1559_tx(&seckey, 41454, 0, burn_address(), 10_000, &calldata);

        let post = make_post(raw_burn_tx, encrypted_payload);

        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &topic_calldata(0x01, &commitment)),
        );

        let stored = process_monad_topic_post(
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
            .get_monad_topic_post_view(&post.payload_hash)
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
        let calldata = topic_calldata(0x00, &commitment);
        let (raw_burn_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, burn_address(), 5_000, &calldata);

        let post = make_post(raw_burn_tx, encrypted_payload);

        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 5_000, &topic_calldata(0x00, &commitment)),
        );

        process_monad_topic_post(
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
            .get_monad_topic_post_view(&post.payload_hash)
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
        let post_calldata = topic_calldata(0x01, &commitment);
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
            tx_json(&to, 1_000, &topic_calldata(0x01, &commitment)),
        );

        process_monad_topic_post(
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
                .get_monad_topic_post_view(&post.payload_hash)
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
        let vote_calldata = topic_calldata(0x01, &commitment);
        let (vote_raw_tx, vote_sender) = signed_eip1559_tx(
            &vote_seckey,
            41454,
            1,
            burn_address(),
            2_000,
            &vote_calldata,
        );
        let vote = proto::MonadTopicVote {
            target_payload_hash: post.payload_hash.clone(),
            raw_burn_tx: vote_raw_tx,
        };

        let transport2 = MockTransport::default();
        // Distinct broadcast tx hash from the first vote's (0x11): `DbMonadTopicVotes` keys each vote
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
                "input": format!("0x{}", hex::encode(topic_calldata(0x01, &commitment))),
                "from": "0x3333333333333333333333333333333333333333",
            }),
        );

        let vote_entry =
            process_monad_topic_vote(&transport2, &registry, burn_address(), fast_poll(), vote)
                .await
                .expect("additional vote should be accepted");
        assert_eq!(vote_entry.sender_address, vote_sender.0.to_vec());
        assert_eq!(vote_entry.weight, 2_000);

        let view = registry
            .get_monad_topic_post_view(&post.payload_hash)
            .unwrap()
            .unwrap();
        assert_eq!(view.vote_weight, 3_000);
    }

    #[tokio::test]
    async fn vote_on_unknown_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let vote = proto::MonadTopicVote {
            target_payload_hash: vec![0xaa; 32],
            raw_burn_tx: vec![0x01, 0xc0],
        };
        // No transport responses at all: if this reached the network, it would fail loudly with
        // "no mock response configured" rather than a clean rejection.
        let transport = MockTransport::default();

        let err =
            process_monad_topic_vote(&transport, &registry, burn_address(), fast_poll(), vote)
                .await
                .expect_err("voting on an unknown post should be rejected");

        assert!(matches!(err, ProcessMonadTopicVoteError::UnknownTargetPost));
    }

    #[tokio::test]
    async fn mismatched_payload_hash_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let mut post = make_post(vec![0xc0], b"hello".to_vec());
        post.payload_hash[0] ^= 0xff;

        let transport = MockTransport::default();
        let err = process_monad_topic_post(
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
            ProcessMonadTopicPostError::PayloadHashMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn malformed_raw_burn_tx_post_is_rejected() {
        let (_tempdir, registry) = test_registry();
        let post = make_post(vec![0x01, 0xc0], b"hello".to_vec());
        let transport = MockTransport::default();

        let err = process_monad_topic_post(
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
            ProcessMonadTopicPostError::SenderRecoveryFailed(_)
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
        let calldata = topic_calldata(0x01, &commitment);
        // Sent to a different address than `burn_address()`.
        let (raw_burn_tx, _sender) =
            signed_eip1559_tx(&seckey, 41454, 0, Address([0x99; 20]), 1_000, &calldata);
        let post = make_post(raw_burn_tx, encrypted_payload);

        let wrong_to = hex_addr(Address([0x99; 20]));
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&wrong_to, "0x1"));

        let err = process_monad_topic_post(
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
            ProcessMonadTopicPostError::Rejected(TopicVoteRelayOutcome::VerificationFailed { .. })
        ));
        assert_eq!(
            registry.get_monad_topic_post(&post.payload_hash).unwrap(),
            None
        );
    }

    #[test]
    fn gate_config_error_display_mentions_missing_var() {
        let err = MonadTopicGateConfigError::MissingEnv("MONAD_STAMP_BURN_ADDRESS");
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

    /// Store a valid, verified [`proto::StoredMonadTopicPost`] straight into `registry` (bypassing
    /// the HTTP `PUT` + burn-verification machinery, mirroring `http::monad_message`'s own
    /// `store_at` helper) with an explicit `topic`/`timestamp`, for ticket #40's
    /// `list_monad_topic_posts_by_topic`-focused tests below where the interesting behavior is the read
    /// side, not verification.
    fn store_monad_topic_post_at(
        registry: &Registry,
        payload_hash: Vec<u8>,
        topic: &str,
        timestamp: i64,
    ) {
        let stored = proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost {
                topic: topic.to_string(),
                parent_post_hash: vec![],
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
            .put_monad_topic_post(&payload_hash, stored, &[])
            .unwrap();
    }

    fn payload_hash_of(view: &proto::MonadTopicPostView) -> Vec<u8> {
        view.post
            .as_ref()
            .unwrap()
            .post
            .as_ref()
            .unwrap()
            .payload_hash
            .clone()
    }

    /// Ticket #40's core acceptance criteria: a topic-filtered listing excludes other topics'
    /// posts and orders by timestamp ascending -- mirroring `http::monad_message`'s own
    /// `discovers_new_messages_via_list_since_without_knowing_payload_hash_up_front`-style test.
    #[test]
    fn list_monad_topic_posts_by_topic_excludes_other_topics_and_orders_by_timestamp() {
        let (_tempdir, registry) = test_registry();
        let hash_a = vec![0xaa; 32];
        let hash_b = vec![0xbb; 32];
        let hash_other = vec![0xcc; 32];

        // Insert out of order, and interleaved with a different topic, to prove both the ordering
        // and the topic filter.
        store_monad_topic_post_at(&registry, hash_b.clone(), "topic.one", 200);
        store_monad_topic_post_at(&registry, hash_other.clone(), "topic.two", 150);
        store_monad_topic_post_at(&registry, hash_a.clone(), "topic.one", 100);

        let views = registry
            .list_monad_topic_posts_by_topic("topic.one", 0)
            .unwrap();
        let hashes: Vec<Vec<u8>> = views.iter().map(payload_hash_of).collect();
        assert_eq!(hashes, vec![hash_a, hash_b]);

        let other_views = registry
            .list_monad_topic_posts_by_topic("topic.two", 0)
            .unwrap();
        assert_eq!(
            other_views.iter().map(payload_hash_of).collect::<Vec<_>>(),
            vec![hash_other]
        );
    }

    #[test]
    fn list_monad_topic_posts_by_topic_respects_since_cursor() {
        let (_tempdir, registry) = test_registry();
        let hash_old = vec![0x11; 32];
        let hash_new = vec![0x22; 32];
        store_monad_topic_post_at(&registry, hash_old, "topic.cursor", 100);
        store_monad_topic_post_at(&registry, hash_new.clone(), "topic.cursor", 200);

        let views = registry
            .list_monad_topic_posts_by_topic("topic.cursor", 150)
            .unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(payload_hash_of(&views[0]), hash_new);
    }

    /// Ticket #40's tally acceptance criterion: the `vote_weight` a listing attaches to a post
    /// must match what `get_monad_topic_post_view` independently computes for that same post -- both go
    /// through `Registry::monad_topic_post_view` (see that method's docs), so this is really a
    /// regression guard against that shared path ever being bypassed for one caller but not the
    /// other.
    #[test]
    fn list_monad_topic_posts_by_topic_tally_matches_get_monad_topic_post_view() {
        let (_tempdir, registry) = test_registry();
        let hash = vec![0x33; 32];
        store_monad_topic_post_at(&registry, hash.clone(), "topic.tally", 100);

        registry
            .add_monad_topic_vote(&proto::StoredMonadTopicVoteEntry {
                target_payload_hash: hash.clone(),
                sender_address: vec![1u8; 20],
                tx_hash: vec![0xaa; 32],
                timestamp: 100,
                weight: 1_000,
            })
            .unwrap();
        registry
            .add_monad_topic_vote(&proto::StoredMonadTopicVoteEntry {
                target_payload_hash: hash.clone(),
                sender_address: vec![2u8; 20],
                tx_hash: vec![0xbb; 32],
                timestamp: 101,
                weight: -300,
            })
            .unwrap();

        let views = registry
            .list_monad_topic_posts_by_topic("topic.tally", 0)
            .unwrap();
        assert_eq!(views.len(), 1);
        let expected = registry.get_monad_topic_post_view(&hash).unwrap().unwrap();
        assert_eq!(views[0].vote_weight, expected.vote_weight);
        assert_eq!(views[0].vote_weight, 700);
    }

    /// Ticket #72: `handle_list_topics` surfaces every distinct topic discovered via `put`
    /// (through `store_monad_topic_post_at`), each with its own post count, ordered by
    /// last-activity descending.
    #[tokio::test]
    async fn handle_list_topics_returns_discovered_topics_ordered_by_last_activity() {
        let (_tempdir, registry) = test_registry();
        store_monad_topic_post_at(&registry, vec![0x01; 32], "topic.oldest", 100);
        store_monad_topic_post_at(&registry, vec![0x02; 32], "topic.newest", 300);
        // A second post to "topic.oldest", still older than "topic.newest"'s single post.
        store_monad_topic_post_at(&registry, vec![0x03; 32], "topic.oldest", 150);

        let server = test_server(registry);
        let Protobuf(response) = handle_list_topics(Extension(server))
            .await
            .expect("listing discovered topics should succeed");

        let entries: Vec<(String, u64, i64)> = response
            .entries
            .into_iter()
            .map(|entry| (entry.topic, entry.post_count, entry.last_activity_ms))
            .collect();
        assert_eq!(
            entries,
            vec![
                ("topic.newest".to_string(), 1, 300),
                ("topic.oldest".to_string(), 2, 150),
            ]
        );
    }

    /// Build a [`RegistryServer`] around `registry`, wired the same harmless way
    /// `crate::http::monad_message`'s own (module-private) `test_server` helper does (POP
    /// disabled, no real peers) -- needed by
    /// [`route_get_discover_hits_handle_list_topics_and_is_not_shadowed_by_sibling_routes`] below,
    /// which drives the real [`axum::Router`] rather than calling a handler function directly.
    fn test_server(registry: Registry) -> RegistryServer {
        use crate::{p2p::peers::Peers, test_instance::placeholder_pop_conf};

        let pop_gate =
            crate::http::pop_protection::PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            // No curated defaults needed by this route's tests (ticket #49, merged after this
            // helper was originally written).
            curated_defaults: Arc::new(vec![]),
        }
    }

    /// Ticket #72's route-level acceptance criterion: `GET /message/monad/topics/discover` must
    /// reach [`handle_list_topics`] through the *real* [`axum::Router`] built by
    /// [`crate::http::server::RegistryServer::into_router`] -- not just via a direct handler call
    /// -- and must not be swallowed by either sibling route registered under the same
    /// `/message/monad/topics` prefix: `GET /message/monad/topics` (topic-filtered listing, which
    /// requires `?topic=`) or `GET /message/monad/topics/:payload_hash` (a wildcard segment at the
    /// same path depth as "discover"). See `into_router`'s routing-precedence comment for why a
    /// static segment always wins over a wildcard one registered at the same position.
    #[tokio::test]
    async fn route_get_discover_hits_handle_list_topics_and_is_not_shadowed_by_sibling_routes() {
        use prost::Message;
        use tower::ServiceExt;

        let (_tempdir, registry) = test_registry();
        store_monad_topic_post_at(&registry, vec![0xaa; 32], "topic.discoverable", 500);

        let router = test_server(registry).into_router();

        let request = axum::http::Request::builder()
            .method("GET")
            .uri("/message/monad/topics/discover")
            .body(hyper::Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let decoded = proto::ListTopicsResponse::decode(body.as_ref())
            .expect("response body should decode as ListTopicsResponse");
        assert_eq!(decoded.entries.len(), 1);
        assert_eq!(decoded.entries[0].topic, "topic.discoverable");
        assert_eq!(decoded.entries[0].post_count, 1);
        assert_eq!(decoded.entries[0].last_activity_ms, 500);
    }
}
