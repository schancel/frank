//! `PUT /message/monad/topics`, `PUT /message/monad/topics/vote`, and
//! `GET /message/monad/topics/:payload_hash`: the HTTP path for Monad topic posts and their
//! burn-weighted votes (ticket #30).
//!
//! Mirrors `crate::http::monad_message`'s decode -> verify -> store shape (ticket #27) closely,
//! with two Monad-topic-specific differences:
//! - Verification goes through [`crate::monad_topic_verify::verify_topic_vote_burn`] (via
//!   [`crate::monad_topic_relay::broadcast_and_verify_topic_vote`]) rather than
//!   `monad_stamp_verify::verify_stamp_transaction`/`monad_stamp_relay::broadcast_and_verify_stamp` --
//!   see those modules' docs for the calldata-layout and outcome-type reasons they can't be
//!   reused as-is here.
//! - A verified burn doesn't just gate a store, it also *is* a vote: both `PUT` routes below
//!   record a [`proto::StoredMonadTopicVoteEntry`] alongside whatever else they store (a new post
//!   also creates its own initial vote entry), so [`Registry::get_monad_topic_post_view`]'s tally is
//!   simply the sum of every recorded entry for a `payload_hash`.
//!
//! The opt-in CBOR writer declares `application/cbor` and submits frozen type-10/type-11 frames;
//! the normal wallet remains protobuf until CBOR read views are frozen. Each decoder remains
//! behind its own explicit content type during the bounded window documented in
//! `docs/protocol/cbor/topic-http-coexistence.md`; bytes are never sniffed or retried. CBOR post
//! writes and exact GETs return only the already-frozen type-9 frame, while derived read models
//! remain protobuf and exclude CBOR-origin rows.
//!
//! ## Configuration
//!
//! Reads two canonical env vars (`MONAD_TESTNET_HTTP_RPC_URL`, `MONAD_STAMP_BURN_ADDRESS` -- see
//! `.env.example`) through [`MonadTopicGateConfig`], rather than inventing topic-specific ones: a
//! topic vote burns to the same configured Stamp burn address, just tagged with
//! [`crate::monad_topic_verify::TOPIC_VOTE_LOKAD_ID`] in its calldata, so there's no reason for a
//! second, easy-to-typo burn-address var. There is no minimum-value config: a topic vote's exact
//! value *is* its weight, never thresholded against a minimum (see `monad_topic_verify`'s module
//! docs).
//!
//! The direct-message route (`crate::http::monad_message`) no longer uses environment gating at
//! all: it exists only when `[registry.monad_mailbox]` is enabled in the validated `cashwebd`
//! configuration, which carries its own RPC URL, aggregate minimum, and expected chain ID.
//!
//! This module reads its own process-wide `OnceLock`, following the fail-closed convention
//! (`crate::http::pop_protection`'s "read once from the environment on first use" pattern).

use std::{fmt, sync::OnceLock};

use axum::{
    body::Bytes,
    extract::{FromRequest, Path, Query, RawQuery, RequestParts},
    http::{
        header::{ACCEPT, CONTENT_TYPE, VARY},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use cashweb_http_utils::protobuf::Protobuf;
use prost::Message;
use serde::{Deserialize, Serialize};
use tracing::Level;

use crate::{
    http::server::RegistryServer,
    monad_evm_tx::{recover_sender, EvmTxError},
    monad_http::{Address, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_cbor::{
        broadcast_and_verify_topic_event, parse_topic_event, validate_topic_post_target,
        TopicBurnError, TopicBurnPolicy, TopicEvent, TopicEventError, MAX_TOPIC_EVENT_FRAME_BYTES,
    },
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
    /// An infrastructure-level failure after broadcast or during durable storage.
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
/// post by [`Registry::admit_legacy_monad_topic_post`] itself, mirroring `crate::http::monad_message::
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
            ..
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
        cbor_post_frame: Vec::new(),
        confirmed_block_number: 0,
        confirmed_transaction_index: 0,
    };

    let vote_entry = proto::StoredMonadTopicVoteEntry {
        target_payload_hash: declared_hash.as_slice().to_vec(),
        sender_address: sender.0.to_vec(),
        tx_hash: tx_hash.0.to_vec(),
        timestamp,
        weight: saturate_weight(direction.signed_weight(value_wei)),
    };
    let stored = registry
        .admit_legacy_monad_topic_post(declared_hash.as_slice(), stored, network_tag, &vote_entry)
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
    /// Infrastructure failed before broadcast (currently only target lookup).
    Infrastructure(Report),
    /// Infrastructure/storage failed after the transaction may have been broadcast.
    OutcomeUnknown(Report),
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
            ProcessMonadTopicVoteError::OutcomeUnknown(err) => {
                write!(f, "post-broadcast outcome unknown: {err}")
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

    let target = registry
        .get_monad_topic_post(target_hash.as_slice())
        .map_err(ProcessMonadTopicVoteError::Infrastructure)?
        .ok_or(ProcessMonadTopicVoteError::UnknownTargetPost)?;
    if !Registry::is_legacy_topic_post(&target) {
        return Err(ProcessMonadTopicVoteError::UnknownTargetPost);
    }

    let sender = recover_sender(&request.raw_burn_tx)
        .map_err(ProcessMonadTopicVoteError::SenderRecoveryFailed)?;

    let expected = ExpectedTopicBurn {
        commitment: target_hash.clone(),
        burn_address,
    };

    let outcome = broadcast_and_verify_topic_vote(transport, &request.raw_burn_tx, &expected, poll)
        .await
        .map_err(ProcessMonadTopicVoteError::OutcomeUnknown)?;

    let (tx_hash, value_wei, direction) = match outcome {
        TopicVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
            ..
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
        .map_err(ProcessMonadTopicVoteError::OutcomeUnknown)?;

    Ok(vote_entry)
}

/// Stored projection produced after a deterministic-CBOR topic event is verified.
#[derive(Debug)]
pub enum StoredCborTopicEvent {
    /// A type-10 submission stored as the legacy-at-rest post projection.
    Post(proto::StoredMonadTopicPost),
    /// A type-11 submission stored as the legacy-at-rest vote projection.
    Vote(proto::StoredMonadTopicVoteEntry),
}

/// Root event accepted by a specific HTTP write route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CborTopicEventKind {
    /// Type 10 only.
    Post,
    /// Type 11 only.
    Vote,
}

/// Failure while admitting a deterministic-CBOR topic event.
#[derive(Debug)]
pub enum ProcessCborTopicEventError {
    /// The frame failed strict deterministic-CBOR or network validation.
    Event(TopicEventError),
    /// A vote named a post that is not stored locally.
    UnknownTargetPost,
    /// The signed burn transaction failed before or after broadcast.
    Burn(TopicBurnError),
    /// Infrastructure failed before broadcast (currently only target lookup).
    Infrastructure(Report),
    /// Durable storage failed after the burn verified.
    OutcomeUnknown(Report),
}

impl fmt::Display for ProcessCborTopicEventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Event(err) => write!(f, "{err}"),
            Self::UnknownTargetPost => write!(f, "no topic post found for the target hash"),
            Self::Burn(err) => write!(f, "{err}"),
            Self::Infrastructure(err) => write!(f, "infrastructure failure: {err}"),
            Self::OutcomeUnknown(err) => write!(f, "post-broadcast outcome unknown: {err}"),
        }
    }
}

/// Strictly validate, verify, and persist one type-10 or type-11 deterministic-CBOR event.
/// RocksDB remains protobuf-at-rest during coexistence; the exact type-9 frame is retained in the
/// additive `cbor_post_frame` field so its T1 identity is never reconstructed or transcoded.
pub async fn process_cbor_topic_event<T: JsonRpcTransport + Clone>(
    transport: &T,
    registry: &Registry,
    burn_address: Address,
    poll: PollConfig,
    frame: &[u8],
    expected_kind: CborTopicEventKind,
) -> Result<StoredCborTopicEvent, ProcessCborTopicEventError> {
    let network = registry.expected_cbor_network();
    let event = parse_topic_event(frame, network).map_err(ProcessCborTopicEventError::Event)?;
    match (&event, expected_kind) {
        (TopicEvent::Post(_), CborTopicEventKind::Post)
        | (TopicEvent::Vote(_), CborTopicEventKind::Vote) => {}
        (TopicEvent::Post(_), CborTopicEventKind::Vote) => {
            return Err(ProcessCborTopicEventError::Event(
                TopicEventError::UnexpectedRoot(10),
            ))
        }
        (TopicEvent::Vote(_), CborTopicEventKind::Post) => {
            return Err(ProcessCborTopicEventError::Event(
                TopicEventError::UnexpectedRoot(11),
            ))
        }
    }
    if let TopicEvent::Vote(vote) = &event {
        let target = registry
            .get_monad_topic_post(&vote.target_hash)
            .map_err(ProcessCborTopicEventError::Infrastructure)?
            .ok_or(ProcessCborTopicEventError::UnknownTargetPost)?;
        if target.cbor_post_frame.is_empty() {
            return Err(ProcessCborTopicEventError::UnknownTargetPost);
        }
        validate_topic_post_target(&target.cbor_post_frame, &vote.network, &vote.target_hash)
            .map_err(ProcessCborTopicEventError::Event)?;
    }
    let verified = broadcast_and_verify_topic_event(
        transport,
        &event,
        &TopicBurnPolicy {
            burn_address,
            expected_chain_id: registry.expected_monad_chain_id(),
        },
        poll,
    )
    .await
    .map_err(ProcessCborTopicEventError::Burn)?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let weight = saturate_weight(verified.direction.signed_weight(verified.value_wei));

    match event {
        TopicEvent::Post(post) => {
            let legacy_post = proto::MonadTopicPost {
                topic: post.topic,
                parent_post_hash: post.parent_hash.map_or_else(Vec::new, |hash| hash.to_vec()),
                raw_burn_tx: post.burn_tx,
                encrypted_payload: post.body,
                payload_hash: post.post_hash.to_vec(),
            };
            let stored = proto::StoredMonadTopicPost {
                post: Some(legacy_post),
                sender_address: verified.sender.0.to_vec(),
                tx_hash: verified.tx_hash.0.to_vec(),
                timestamp,
                network_tag: Vec::new(),
                cbor_post_frame: post.post_frame,
                confirmed_block_number: verified.block_number,
                confirmed_transaction_index: verified.transaction_index,
            };
            let initial_vote = proto::StoredMonadTopicVoteEntry {
                target_payload_hash: post.post_hash.to_vec(),
                sender_address: verified.sender.0.to_vec(),
                tx_hash: verified.tx_hash.0.to_vec(),
                timestamp,
                weight,
            };
            let stored = proto::StoredMonadTopicPost {
                network_tag: crate::network_tag::frank_network_tag().to_vec(),
                ..stored
            };
            let admitted = registry
                .admit_cbor_topic_post(&post.post_hash, stored, &initial_vote)
                .map_err(ProcessCborTopicEventError::OutcomeUnknown)?;
            Ok(StoredCborTopicEvent::Post(admitted.post))
        }
        TopicEvent::Vote(vote) => {
            let stored = proto::StoredMonadTopicVoteEntry {
                target_payload_hash: vote.target_hash.to_vec(),
                sender_address: verified.sender.0.to_vec(),
                tx_hash: verified.tx_hash.0.to_vec(),
                timestamp,
                weight,
            };
            registry
                .add_monad_topic_vote(&stored)
                .map_err(ProcessCborTopicEventError::OutcomeUnknown)?;
            Ok(StoredCborTopicEvent::Vote(stored))
        }
    }
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

fn cbor_burn_outcome_unknown(error: &TopicBurnError) -> bool {
    match error {
        TopicBurnError::Infrastructure(_) | TopicBurnError::TxHashMismatch { .. } => true,
        TopicBurnError::Rejected(TopicVoteRelayOutcome::ConfirmationTimedOut { .. }) => true,
        TopicBurnError::Rejected(TopicVoteRelayOutcome::BroadcastFailed(error)) => {
            !error.definitively_rejected_send()
        }
        _ => false,
    }
}

fn relay_burn_outcome_unknown(outcome: &TopicVoteRelayOutcome) -> bool {
    match outcome {
        TopicVoteRelayOutcome::ConfirmationTimedOut { .. }
        | TopicVoteRelayOutcome::NodeHashMismatch { .. } => true,
        TopicVoteRelayOutcome::BroadcastFailed(error) => !error.definitively_rejected_send(),
        _ => false,
    }
}

fn cbor_outcome_unknown_response(detail: String) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(MonadTopicErrorBody {
            error: "topic_burn_outcome_unknown",
            detail,
        }),
    )
        .into_response()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopicRequestFormat {
    Cbor,
    Protobuf,
}

/// Select the write decoder solely from the declared media type. Parameters are accepted only for
/// protobuf compatibility; deterministic CBOR requires the exact bare media type.
fn topic_request_format(headers: &HeaderMap) -> Option<TopicRequestFormat> {
    let declared = headers.get(CONTENT_TYPE)?.to_str().ok()?.trim();
    if declared.eq_ignore_ascii_case("application/cbor") {
        return Some(TopicRequestFormat::Cbor);
    }
    let media_type = declared.split(';').next()?.trim().to_ascii_lowercase();
    match media_type.as_str() {
        "application/x-protobuf" => Some(TopicRequestFormat::Protobuf),
        _ => None,
    }
}

fn vary_accept(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Accept"));
    response
}

/// Split one HTTP list or parameter list without treating delimiters inside quoted strings as
/// syntax. Reject unbalanced quotes and dangling quoted-pair escapes.
fn split_quoted(value: &str, delimiter: char) -> Option<Vec<&str>> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
        } else if !quoted && ch == delimiter {
            pieces.push(&value[start..index]);
            start = index + ch.len_utf8();
        }
    }
    if quoted || escaped {
        return None;
    }
    pieces.push(&value[start..]);
    Some(pieces)
}

/// Test whether an `Accept` header permits one exact topic representation. GET handlers inspect
/// row origin first: wildcard requests receive that row's sole semantically valid representation,
/// never a projection into the other format.
fn topic_accepts(headers: &HeaderMap, expected: &str) -> bool {
    if !headers.contains_key(ACCEPT) {
        return true;
    }
    let expected = expected.to_ascii_lowercase();
    let Some((expected_type, _)) = expected.split_once('/') else {
        return false;
    };
    let type_wildcard = format!("{expected_type}/*");
    let mut selected: Option<(u8, f32)> = None;

    for value in headers.get_all(ACCEPT).iter() {
        let Ok(value) = value.to_str() else {
            return false;
        };
        let Some(ranges) = split_quoted(value, ',') else {
            return false;
        };
        for range in ranges {
            let Some(mut parts) = split_quoted(range, ';') else {
                return false;
            };
            let media_type = parts.remove(0).trim().to_ascii_lowercase();
            let specificity = if media_type == expected {
                2
            } else if media_type == type_wildcard {
                1
            } else if media_type == "*/*" {
                0
            } else {
                continue;
            };
            let mut quality = 1.0;
            let mut before_quality = true;
            let mut matches_offered_parameters = true;
            for parameter in parts {
                let mut pair = parameter.trim().splitn(2, '=');
                let name = pair.next().unwrap_or_default().trim();
                let value = pair.next().map(str::trim);
                if before_quality && name.eq_ignore_ascii_case("q") {
                    quality = value
                        .and_then(|quality| quality.trim().parse::<f32>().ok())
                        .filter(|quality| quality.is_finite() && (0.0..=1.0).contains(quality))
                        .unwrap_or(0.0);
                    before_quality = false;
                } else if before_quality {
                    // The server offers bare application/cbor and application/x-protobuf. A
                    // media parameter before q constrains the representation and therefore does
                    // not match either offer. Parameters after q are RFC 7231 accept extensions.
                    matches_offered_parameters = false;
                }
            }
            if !matches_offered_parameters {
                continue;
            }
            match selected {
                Some((selected_specificity, selected_quality))
                    if selected_specificity > specificity
                        || (selected_specificity == specificity && selected_quality >= quality) => {
                }
                _ => selected = Some((specificity, quality)),
            }
        }
    }
    selected.is_some_and(|(_, quality)| quality > 0.0)
}

/// Error type for [`handle_put_monad_topic_post`].
#[derive(Debug)]
pub enum PutMonadTopicPostError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(MonadTopicGateConfigError),
    /// [`process_monad_topic_post`] rejected (or failed to process) the post.
    Process(ProcessMonadTopicPostError),
    /// Deterministic-CBOR decoding, verification, or storage failed.
    Cbor(ProcessCborTopicEventError),
    /// The request declared neither supported wire format.
    UnsupportedMediaType,
    /// A legacy protobuf request body was malformed.
    InvalidProtobuf(String),
    /// The caller requested a response representation not allocated by the frozen protocol.
    NotAcceptable,
    /// The request exceeded the frozen topic-event route limit.
    PayloadTooLarge,
}

impl IntoResponse for PutMonadTopicPostError {
    fn into_response(self) -> Response {
        match self {
            PutMonadTopicPostError::Process(ProcessMonadTopicPostError::Infrastructure(err)) => {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicPostError::Process(ProcessMonadTopicPostError::Rejected(ref outcome))
                if relay_burn_outcome_unknown(outcome) =>
            {
                cbor_outcome_unknown_response(format!("{outcome:?}"))
            }
            PutMonadTopicPostError::Cbor(ProcessCborTopicEventError::Burn(err))
                if cbor_burn_outcome_unknown(&err) =>
            {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicPostError::Cbor(ProcessCborTopicEventError::OutcomeUnknown(err)) => {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicPostError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "topic-vote gate is misconfigured; rejecting topic post"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicPostError::Cbor(ProcessCborTopicEventError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing CBOR topic post");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicPostError::UnsupportedMediaType => {
                StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response()
            }
            PutMonadTopicPostError::NotAcceptable => StatusCode::NOT_ACCEPTABLE.into_response(),
            PutMonadTopicPostError::PayloadTooLarge => {
                StatusCode::PAYLOAD_TOO_LARGE.into_response()
            }
            PutMonadTopicPostError::InvalidProtobuf(detail) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_post",
                    detail,
                }),
            )
                .into_response(),
            PutMonadTopicPostError::Cbor(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_post",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
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

/// `PUT /message/monad/topics`: dispatch from the declared content type, validate either a type-10
/// CBOR submission or a legacy [`proto::MonadTopicPost`], verify its initial burn, and store the
/// post plus its initial vote on success.
pub async fn handle_put_monad_topic_post(
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, PutMonadTopicPostError> {
    let request_format =
        topic_request_format(&headers).ok_or(PutMonadTopicPostError::UnsupportedMediaType)?;
    if request_format == TopicRequestFormat::Cbor && body.len() as u64 > MAX_TOPIC_EVENT_FRAME_BYTES
    {
        return Err(PutMonadTopicPostError::PayloadTooLarge);
    }
    let expected_response = match request_format {
        TopicRequestFormat::Cbor => "application/cbor",
        TopicRequestFormat::Protobuf => "application/x-protobuf",
    };
    if !topic_accepts(&headers, expected_response) {
        return Err(PutMonadTopicPostError::NotAcceptable);
    }
    let config = monad_topic_gate()
        .as_ref()
        .map_err(|err| PutMonadTopicPostError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    if request_format == TopicRequestFormat::Cbor {
        if let Some(response) = forum_submission(
            &server.registry,
            &transport,
            config.burn_address,
            &body,
            true,
        )
        .await
        {
            return Ok(response);
        }
    }
    match request_format {
        TopicRequestFormat::Cbor => match process_cbor_topic_event(
            &transport,
            &server.registry,
            config.burn_address,
            PollConfig::default(),
            &body,
            CborTopicEventKind::Post,
        )
        .await
        .map_err(PutMonadTopicPostError::Cbor)?
        {
            StoredCborTopicEvent::Post(stored) => {
                Ok(([(CONTENT_TYPE, "application/cbor")], stored.cbor_post_frame).into_response())
            }
            StoredCborTopicEvent::Vote(_) => unreachable!("event kind checked before broadcast"),
        },
        TopicRequestFormat::Protobuf => {
            let post = proto::MonadTopicPost::decode(body.as_ref())
                .map_err(|err| PutMonadTopicPostError::InvalidProtobuf(err.to_string()))?;
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
            Ok(Protobuf(stored).into_response())
        }
    }
}

/// Error type for [`handle_put_monad_topic_vote`].
#[derive(Debug)]
pub enum PutMonadTopicVoteError {
    /// The gate is misconfigured; fails closed (`500`).
    GateUnavailable(MonadTopicGateConfigError),
    /// [`process_monad_topic_vote`] rejected (or failed to process) the vote.
    Process(ProcessMonadTopicVoteError),
    /// Deterministic-CBOR decoding, verification, or storage failed.
    Cbor(ProcessCborTopicEventError),
    /// The request declared neither supported wire format.
    UnsupportedMediaType,
    /// A legacy protobuf request body was malformed.
    InvalidProtobuf(String),
    /// The caller requested a response representation not allocated by the frozen protocol.
    NotAcceptable,
    /// The request exceeded the frozen topic-event route limit.
    PayloadTooLarge,
}

impl IntoResponse for PutMonadTopicVoteError {
    fn into_response(self) -> Response {
        match self {
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::OutcomeUnknown(err)) => {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::Rejected(ref outcome))
                if relay_burn_outcome_unknown(outcome) =>
            {
                cbor_outcome_unknown_response(format!("{outcome:?}"))
            }
            PutMonadTopicVoteError::Cbor(ProcessCborTopicEventError::Burn(err))
                if cbor_burn_outcome_unknown(&err) =>
            {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicVoteError::Cbor(ProcessCborTopicEventError::OutcomeUnknown(err)) => {
                cbor_outcome_unknown_response(err.to_string())
            }
            PutMonadTopicVoteError::GateUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "topic-vote gate is misconfigured; rejecting topic vote"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure before processing topic vote");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicVoteError::Cbor(ProcessCborTopicEventError::Infrastructure(err)) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure processing CBOR topic vote");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutMonadTopicVoteError::UnsupportedMediaType => {
                StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response()
            }
            PutMonadTopicVoteError::NotAcceptable => StatusCode::NOT_ACCEPTABLE.into_response(),
            PutMonadTopicVoteError::PayloadTooLarge => {
                StatusCode::PAYLOAD_TOO_LARGE.into_response()
            }
            PutMonadTopicVoteError::InvalidProtobuf(detail) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_vote",
                    detail,
                }),
            )
                .into_response(),
            PutMonadTopicVoteError::Cbor(err) => (
                StatusCode::BAD_REQUEST,
                Json(MonadTopicErrorBody {
                    error: "invalid_topic_vote",
                    detail: err.to_string(),
                }),
            )
                .into_response(),
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

/// `PUT /message/monad/topics/vote`: dispatch from the declared content type, validate either a
/// type-11 CBOR submission or a legacy [`proto::MonadTopicVote`], verify its burn, and record it
/// against its target post on success.
pub async fn handle_put_monad_topic_vote(
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, PutMonadTopicVoteError> {
    let request_format =
        topic_request_format(&headers).ok_or(PutMonadTopicVoteError::UnsupportedMediaType)?;
    if request_format == TopicRequestFormat::Cbor && body.len() as u64 > MAX_TOPIC_EVENT_FRAME_BYTES
    {
        return Err(PutMonadTopicVoteError::PayloadTooLarge);
    }
    let expected_response = match request_format {
        TopicRequestFormat::Cbor => "application/cbor",
        TopicRequestFormat::Protobuf => "application/x-protobuf",
    };
    if !topic_accepts(&headers, expected_response) {
        return Err(PutMonadTopicVoteError::NotAcceptable);
    }
    let config = monad_topic_gate()
        .as_ref()
        .map_err(|err| PutMonadTopicVoteError::GateUnavailable(err.clone()))?;
    let transport = HttpTransport::new(config.rpc_url.clone());
    if request_format == TopicRequestFormat::Cbor {
        if let Some(response) = forum_submission(
            &server.registry,
            &transport,
            config.burn_address,
            &body,
            false,
        )
        .await
        {
            return Ok(response);
        }
    }
    match request_format {
        TopicRequestFormat::Cbor => match process_cbor_topic_event(
            &transport,
            &server.registry,
            config.burn_address,
            PollConfig::default(),
            &body,
            CborTopicEventKind::Vote,
        )
        .await
        .map_err(PutMonadTopicVoteError::Cbor)?
        {
            StoredCborTopicEvent::Vote(_) => Ok(StatusCode::NO_CONTENT.into_response()),
            StoredCborTopicEvent::Post(_) => unreachable!("event kind checked before broadcast"),
        },
        TopicRequestFormat::Protobuf => {
            let vote = proto::MonadTopicVote::decode(body.as_ref())
                .map_err(|err| PutMonadTopicVoteError::InvalidProtobuf(err.to_string()))?;
            let stored = process_monad_topic_vote(
                &transport,
                &server.registry,
                config.burn_address,
                PollConfig::default(),
                vote,
            )
            .await
            .map_err(PutMonadTopicVoteError::Process)?;
            Ok(Protobuf(stored).into_response())
        }
    }
}

/// Error type for [`handle_get_monad_topic_post`].
#[derive(Debug)]
pub enum GetMonadTopicPostError {
    /// The `:payload_hash` path segment wasn't valid hex.
    InvalidHex(hex::FromHexError),
    /// No post stored for the given `payload_hash`.
    NotFound,
    /// The caller accepts neither supported representation.
    NotAcceptable,
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
            GetMonadTopicPostError::NotAcceptable => StatusCode::NOT_ACCEPTABLE.into_response(),
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
    headers: HeaderMap,
) -> Result<Response, GetMonadTopicPostError> {
    let payload_hash = hex::decode(&hex_hash).map_err(GetMonadTopicPostError::InvalidHex)?;
    let accepts_cbor = topic_accepts(&headers, "application/cbor");
    let accepts_protobuf = topic_accepts(&headers, "application/x-protobuf");
    if !accepts_cbor && !accepts_protobuf {
        return Err(GetMonadTopicPostError::NotAcceptable);
    }
    let stored = server
        .registry
        .get_monad_topic_post(&payload_hash)
        .map_err(GetMonadTopicPostError::Infrastructure)?;
    if stored.is_none() && accepts_cbor {
        if monad_topic_gate().is_err() && server.registry.forum().exists().unwrap_or(true) {
            return Ok(forum_error(crate::store::forum::ForumError::Unavailable));
        }
        if let (Ok(hash), Ok(config)) = (
            <[u8; 32]>::try_from(payload_hash.as_slice()),
            monad_topic_gate().as_ref(),
        ) {
            let policy = crate::forum::policy(
                server.registry.expected_monad_chain_id(),
                config.burn_address,
            );
            match server.registry.forum().view(
                server.registry.expected_cbor_network(),
                policy,
                &hash,
            ) {
                Ok(Some(frame)) => return Ok(forum_bytes(frame)),
                Err(error) => return Ok(forum_error(error)),
                Ok(None) => (),
            }
        }
    }
    let stored = stored.ok_or(GetMonadTopicPostError::NotFound)?;
    if !stored.cbor_post_frame.is_empty() {
        if !accepts_cbor {
            return Err(GetMonadTopicPostError::NotFound);
        }
        let expected_hash: [u8; 32] = payload_hash
            .as_slice()
            .try_into()
            .map_err(|_| GetMonadTopicPostError::NotFound)?;
        validate_topic_post_target(
            &stored.cbor_post_frame,
            server.registry.expected_cbor_network(),
            &expected_hash,
        )
        .map_err(|err| GetMonadTopicPostError::Infrastructure(Report::msg(err.to_string())))?;
        return Ok(forum_bytes(stored.cbor_post_frame));
    }
    if !accepts_protobuf || !Registry::is_legacy_topic_post(&stored) {
        return Err(GetMonadTopicPostError::NotFound);
    }
    let view = server
        .registry
        .get_monad_topic_post_view(&payload_hash)
        .map_err(GetMonadTopicPostError::Infrastructure)?
        .ok_or(GetMonadTopicPostError::NotFound)?;
    Ok(vary_accept(Protobuf(view).into_response()))
}

fn forum_bytes(frame: Vec<u8>) -> Response {
    vary_accept(([(CONTENT_TYPE, "application/cbor")], frame).into_response())
}

fn forum_error(error: crate::store::forum::ForumError) -> Response {
    use crate::store::forum::ForumError::*;
    let (status, code) = match &error {
        Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_forum_request"),
        NotFound => (StatusCode::NOT_FOUND, "topic_target_not_found"),
        Conflict => (StatusCode::CONFLICT, "topic_operation_conflict"),
        Capacity => (StatusCode::SERVICE_UNAVAILABLE, "topic_pending_capacity"),
        Expired => (StatusCode::GONE, "forum_cursor_expired"),
        SnapshotCapacity => (StatusCode::SERVICE_UNAVAILABLE, "forum_snapshot_capacity"),
        SnapshotTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "forum_snapshot_too_large"),
        RowTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "forum_row_too_large"),
        OutcomeUnknown(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "topic_burn_outcome_unknown",
        ),
        Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "forum_unavailable"),
    };
    vary_accept(
        (
            status,
            Json(MonadTopicErrorBody {
                error: code,
                detail: error.to_string(),
            }),
        )
            .into_response(),
    )
}

async fn forum_submission<T: JsonRpcTransport + Clone>(
    registry: &Registry,
    transport: &T,
    burn: Address,
    frame: &[u8],
    post: bool,
) -> Option<Response> {
    let event = match parse_topic_event(frame, registry.expected_cbor_network()) {
        Ok(event) => event,
        Err(_) => return None, // The existing explicitly selected CBOR decoder reports its error.
    };
    let policy = crate::forum::policy(registry.expected_monad_chain_id(), burn);
    let selected = match &event {
        TopicEvent::Post(value) if post => value.schema_version >= 2,
        TopicEvent::Vote(value) if !post => {
            match registry.get_monad_topic_post(&value.target_hash) {
                Ok(Some(_)) => return None,
                Err(_) => return Some(forum_error(crate::store::forum::ForumError::Unavailable)),
                Ok(None) => (),
            }
            match registry.forum().contains(
                registry.expected_cbor_network(),
                policy,
                &value.target_hash,
            ) {
                Ok(true) => true,
                Ok(false) => return Some(forum_error(crate::store::forum::ForumError::NotFound)),
                Err(error) => return Some(forum_error(error)),
            }
        }
        _ => return None,
    };
    if !selected {
        return None;
    }
    Some(
        match registry
            .forum()
            .submit(
                registry.expected_cbor_network(),
                policy,
                frame,
                transport,
                PollConfig::default(),
            )
            .await
        {
            Ok(frame) => forum_bytes(frame),
            Err(error) => forum_error(error),
        },
    )
}

/// Read-only exact-operation status; never admits or broadcasts the supplied request.
pub async fn handle_forum_status(
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if topic_request_format(&headers) != Some(TopicRequestFormat::Cbor) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    if !topic_accepts(&headers, "application/cbor") {
        return StatusCode::NOT_ACCEPTABLE.into_response();
    }
    if body.len() as u64 > MAX_TOPIC_EVENT_FRAME_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Ok(config) = monad_topic_gate().as_ref() else {
        return forum_error(crate::store::forum::ForumError::Unavailable);
    };
    let policy = crate::forum::policy(
        server.registry.expected_monad_chain_id(),
        config.burn_address,
    );
    match server
        .registry
        .forum()
        .status(server.registry.expected_cbor_network(), policy, &body)
    {
        Ok(frame) => forum_bytes(frame),
        Err(error) => forum_error(error),
    }
}

fn exclusive_forum_read(headers: &HeaderMap) -> bool {
    topic_accepts(headers, "application/cbor") && !topic_accepts(headers, "application/x-protobuf")
}

fn forum_query(
    raw: Option<&str>,
    discovery: bool,
) -> crate::store::forum::Result<(crate::forum::Query, Option<Vec<u8>>)> {
    use crate::store::forum::invalid;
    let mut fields = std::collections::BTreeMap::new();
    // Bound encoded input before URL decoding and cursor allocation.
    if raw.unwrap_or("").len() > 8192 {
        return Err(invalid("query exceeds bound"));
    }
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = forum_query_component(key)?;
        let value = forum_query_component(value)?;
        let allowed = if discovery {
            key == "cursor"
        } else {
            matches!(key.as_str(), "topic" | "since" | "cursor")
        };
        if !allowed || fields.insert(key, value).is_some() {
            return Err(invalid("duplicate or unknown query field"));
        }
    }
    let cursor = fields
        .remove("cursor")
        .map(|value| {
            frank_cbor::forum_cursor_from_transport(&value)
                .map(|cursor| cursor.bytes)
                .map_err(invalid)
        })
        .transpose()?;
    let query = if discovery {
        crate::forum::Query::Discovery
    } else {
        let topic = fields
            .remove("topic")
            .ok_or_else(|| invalid("topic required"))?;
        if topic.is_empty() || topic.len() > 512 {
            return Err(invalid("topic byte bound"));
        }
        let since = fields.remove("since").unwrap_or_else(|| "0".into());
        let digits = since.strip_prefix('-').unwrap_or(&since);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("invalid signed milliseconds"));
        }
        let millis = since.parse::<i64>().map_err(invalid)?;
        crate::forum::Query::Topic {
            topic,
            since: frank_cbor::Timestamp {
                seconds: millis.div_euclid(1000),
                nanoseconds: (millis.rem_euclid(1000) * 1_000_000) as u32,
            },
        }
    };
    Ok((query, cursor))
}

fn forum_query_component(raw: &str) -> crate::store::forum::Result<String> {
    use crate::store::forum::invalid;
    let mut decoded = Vec::with_capacity(raw.len());
    let mut input = raw.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        decoded.push(match byte {
            b'+' => b' ',
            b'%' => {
                let hi = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(|| invalid("malformed query escape"))?;
                let lo = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(|| invalid("malformed query escape"))?;
                ((hi << 4) | lo) as u8
            }
            other => other,
        });
    }
    String::from_utf8(decoded).map_err(invalid)
}

/// Explicit CBOR reads are separate from predecessor list selection.
pub async fn handle_forum_topic_pages(
    RawQuery(raw): RawQuery,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
) -> Response {
    if !exclusive_forum_read(&headers) {
        let uri = match format!("/message/monad/topics?{}", raw.as_deref().unwrap_or(""))
            .parse::<axum::http::Uri>()
        {
            Ok(uri) => uri,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        let request = axum::http::Request::builder()
            .uri(uri)
            .body(())
            .expect("validated URI");
        let mut parts = RequestParts::new(request);
        let params = match Query::<ListMonadTopicPostsQuery>::from_request(&mut parts).await {
            Ok(params) => params,
            Err(error) => return error.into_response(),
        };
        return handle_list_monad_topic_posts(params, Extension(server), headers)
            .await
            .into_response();
    }
    forum_page(&server.registry, raw.as_deref(), false)
}

/// Discovery uses the same explicit representation boundary as topic pages.
pub async fn handle_forum_discovery_pages(
    RawQuery(raw): RawQuery,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
) -> Response {
    if !exclusive_forum_read(&headers) {
        return handle_list_topics(Extension(server), headers)
            .await
            .into_response();
    }
    forum_page(&server.registry, raw.as_deref(), true)
}

fn forum_page(registry: &Registry, raw: Option<&str>, discovery: bool) -> Response {
    let (query, cursor) = match forum_query(raw, discovery) {
        Ok(value) => value,
        Err(error) => return forum_error(error),
    };
    let Ok(config) = monad_topic_gate().as_ref() else {
        return forum_error(crate::store::forum::ForumError::Unavailable);
    };
    let policy = crate::forum::policy(registry.expected_monad_chain_id(), config.burn_address);
    match registry.forum().page(
        registry.expected_cbor_network(),
        policy,
        query,
        cursor.as_deref(),
    ) {
        Ok(frame) => forum_bytes(frame),
        Err(error) => forum_error(error),
    }
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
    /// The caller excluded the only allocated list representation.
    NotAcceptable,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListMonadTopicPostsError {
    fn into_response(self) -> Response {
        match self {
            ListMonadTopicPostsError::NotAcceptable => {
                vary_accept(StatusCode::NOT_ACCEPTABLE.into_response())
            }
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
    headers: HeaderMap,
) -> Result<Response, ListMonadTopicPostsError> {
    if !topic_accepts(&headers, "application/x-protobuf") {
        return Err(ListMonadTopicPostsError::NotAcceptable);
    }
    let since = params.since.unwrap_or(0);
    let views = server
        .registry
        .list_monad_topic_posts_by_topic(&params.topic, since)
        .map_err(ListMonadTopicPostsError::Infrastructure)?;
    Ok(vary_accept(
        Protobuf(proto::MonadTopicPostViews { views }).into_response(),
    ))
}

/// Error type for [`handle_list_topics`].
#[derive(Debug)]
pub enum ListTopicsError {
    /// The caller excluded the only allocated discovery representation.
    NotAcceptable,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListTopicsError {
    fn into_response(self) -> Response {
        match self {
            ListTopicsError::NotAcceptable => {
                vary_accept(StatusCode::NOT_ACCEPTABLE.into_response())
            }
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
    headers: HeaderMap,
) -> Result<Response, ListTopicsError> {
    if !topic_accepts(&headers, "application/x-protobuf") {
        return Err(ListTopicsError::NotAcceptable);
    }
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
    Ok(vary_accept(
        Protobuf(proto::ListTopicsResponse { entries }).into_response(),
    ))
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
    use frank_cbor::{cbor_map, encode_frame, CborValue, EnvelopeFields, FramePayload};
    use serde_json::Value;
    use tempdir::TempDir;

    use super::*;
    use crate::{
        monad_evm_tx::{decode_signed_transaction, test_support::signed_eip1559_tx},
        monad_http::{Hash32, MonadRpcError},
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

    fn cbor_frame(type_id: u32, payload: CborValue) -> Vec<u8> {
        encode_frame(
            EnvelopeFields {
                type_id,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&payload),
        )
        .unwrap()
    }

    fn cbor_post_frame() -> Vec<u8> {
        cbor_frame(
            9,
            cbor_map(vec![
                (0, CborValue::Text("monad-testnet".to_string())),
                (1, CborValue::Text("test.topic".to_string())),
                (3, CborValue::Bytes(b"hello from CBOR".to_vec())),
            ]),
        )
    }

    fn cbor_submission(post_frame: &[u8], burn_tx: &[u8]) -> Vec<u8> {
        cbor_frame(
            10,
            cbor_map(vec![
                (0, CborValue::Text("monad-testnet".to_string())),
                (1, CborValue::Bytes(post_frame.to_vec())),
                (2, CborValue::Bytes(burn_tx.to_vec())),
            ]),
        )
    }

    fn cbor_vote_submission(target_hash: &[u8; 32], burn_tx: &[u8]) -> Vec<u8> {
        cbor_frame(
            11,
            cbor_map(vec![
                (0, CborValue::Text("monad-testnet".to_string())),
                (1, CborValue::Bytes(target_hash.to_vec())),
                (2, CborValue::Bytes(burn_tx.to_vec())),
            ]),
        )
    }

    fn cbor_topic_calldata(direction: u8, commitment: &[u8; 32]) -> Vec<u8> {
        let mut calldata = TOPIC_VOTE_LOKAD_ID.to_vec();
        calldata.push(0x02);
        calldata.push(direction);
        calldata.extend_from_slice(commitment);
        calldata
    }

    fn receipt_json(to: &str, status: &str) -> Value {
        serde_json::json!({
            "transactionHash": hex_hash(0x11),
            "blockHash": hex_hash(0x22),
            "blockNumber": "0x2a",
            "transactionIndex": "0x0",
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
        send_raw_transaction_already_known: Arc<Mutex<bool>>,
        call_count: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
        }

        fn set_already_known(&self) {
            *self.send_raw_transaction_already_known.lock().unwrap() = true;
        }

        fn call_count(&self) -> usize {
            self.call_count.load(std::sync::atomic::Ordering::SeqCst)
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
            self.call_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if method == "eth_sendRawTransaction" {
                if *self.send_raw_transaction_already_known.lock().unwrap() {
                    return Err(MonadRpcError::AlreadyKnown {
                        method: method.to_string(),
                        message: "already known".to_string(),
                    });
                }
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

    #[test]
    fn forum_query_rejects_cross_family_unknown_duplicate_and_lossy_time_inputs() {
        assert!(forum_query(Some("topic=%ff"), false).is_err());
        assert!(forum_query(Some("topic=%"), false).is_err());
        assert!(forum_query(Some("topic=x&topic=y"), false).is_err());
        assert!(forum_query(Some("topic=x&since=9007199254740993&extra=1"), false).is_err());
        assert!(forum_query(Some("topic=x"), true).is_err());
        assert!(forum_query(Some("topic=x&since=1.0"), false).is_err());
        let (query, _) = forum_query(Some("topic=x&since=-1"), false).unwrap();
        assert_eq!(
            query,
            crate::forum::Query::Topic {
                topic: "x".into(),
                since: frank_cbor::Timestamp {
                    seconds: -1,
                    nanoseconds: 999_000_000
                }
            }
        );
        let (query, _) = forum_query(Some("topic=x&since=9007199254740993"), false).unwrap();
        assert_eq!(
            query,
            crate::forum::Query::Topic {
                topic: "x".into(),
                since: frank_cbor::Timestamp {
                    seconds: 9_007_199_254_740,
                    nanoseconds: 993_000_000
                }
            }
        );
    }

    #[tokio::test]
    async fn forum_over_ceiling_and_post_down_burn_reject_before_admission_or_rpc() {
        use crate::store::forum::tests::{observation, observation_with_amount};
        let (directory, registry) = test_registry();
        let transport = MockTransport::default();
        let over = observation_with_amount(0, None, false, i64::MAX as u128 + 1);
        let response = forum_submission(&registry, &transport, burn_address(), over.frame(), true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(transport.call_count(), 0);
        assert!(!directory.path().join("db.rocksdb.forum-cbor-v1").exists());
        let post = observation(1, None, false);
        let vote = observation(2, Some(*post.event.target_hash()), true);
        let TopicEvent::Post(post) = post.event else {
            panic!()
        };
        let frame = cbor_submission(&post.post_frame, vote.event.burn_tx());
        let response = forum_submission(&registry, &transport, burn_address(), &frame, true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(transport.call_count(), 0);
        assert!(!directory.path().join("db.rocksdb.forum-cbor-v1").exists());
    }

    #[tokio::test]
    async fn forum_receipt_sender_mismatch_keeps_pending_exact_operation() {
        use crate::store::forum::tests::observation;
        let (_directory, registry) = test_registry();
        let op = observation(0, None, false);
        let hash = op.checked.decoded.tx_hash.to_hex();
        let transport = MockTransport::default();
        transport.set("eth_sendRawTransaction", Value::String(hash.clone()));
        transport.set("eth_getTransactionReceipt",serde_json::json!({"transactionHash":hash,"blockHash":hex_hash(2),"blockNumber":"0x0","transactionIndex":"0x0","from":Address([9;20]).to_hex(),"to":burn_address().to_hex(),"contractAddress":null,"gasUsed":"0x5208","status":"0x1","logs":[]}));
        transport.set("eth_getTransactionByHash",serde_json::json!({"hash":hash,"from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"value":"0x7","input":format!("0x{}",hex::encode(&op.checked.decoded.input))}));
        let response = forum_submission(&registry, &transport, burn_address(), op.frame(), true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let policy = crate::forum::policy(10143, burn_address());
        let status = registry
            .forum()
            .status("monad-testnet", policy, op.frame())
            .unwrap();
        let frank_cbor::ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&status, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let frank_cbor::TypedPayload::ForumOperationStatus(status) =
            parsed.typed.as_deref().unwrap()
        else {
            panic!()
        };
        assert_eq!(status.evidence, frank_cbor::ForumOperationEvidence::Pending);
        assert!(!registry
            .forum()
            .contains("monad-testnet", policy, op.event.target_hash())
            .unwrap());
    }

    #[tokio::test]
    async fn forum_retained_vote_missing_post_is_unavailable() {
        const CHILD: &str = "FRANK_FORUM_CORRUPT_REBUILD_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .env(CHILD, "1")
                .args([
                    "--exact",
                    "http::monad_topics::tests::forum_retained_vote_missing_post_is_unavailable",
                    "--nocapture",
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use crate::store::forum::{
            tests::{facts, observation},
            Store,
        };
        use frank_cbor::Timestamp;
        use tower::ServiceExt;
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1/");
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
        let (healthy_directory, healthy_registry) = test_registry();
        let healthy = test_server(healthy_registry).into_router();
        let unknown = observation(3, Some([0xaa; 32]), false);
        for (method, path, bytes) in [
            (
                "GET",
                format!("/message/monad/topics/{}", hex::encode([0xaa; 32])),
                Vec::new(),
            ),
            (
                "PUT",
                "/message/monad/topics/vote".into(),
                unknown.frame().to_vec(),
            ),
        ] {
            let response = healthy
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header(CONTENT_TYPE, "application/cbor")
                        .header(ACCEPT, "application/cbor")
                        .body(axum::body::Body::from(bytes))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "healthy unknown target remains 404 before RPC"
            );
        }
        assert!(
            !Store::path(&healthy_directory.path().join("db.rocksdb"))
                .unwrap()
                .exists(),
            "unknown targets must not create Forum obligations"
        );
        drop(healthy);
        let (directory, registry) = test_registry();
        let legacy = directory.path().join("db.rocksdb");
        let policy = crate::forum::policy(10143, burn_address());
        let post = observation(0, None, false);
        let vote = observation(1, Some(*post.event.target_hash()), true);
        let at = Timestamp {
            seconds: 200,
            nanoseconds: 0,
        };
        let mut store = Store::open(&legacy, "monad-testnet", policy).unwrap();
        for op in [&post, &vote] {
            store.admit(op.clone()).unwrap();
            store
                .confirm(&op.checked.decoded.tx_hash.0, &facts(op, 10, 0), at)
                .unwrap();
        }
        drop(store);
        let mut vote_key = vec![b'e'];
        vote_key.extend(vote.checked.decoded.tx_hash.0);
        let retained;
        {
            let db = rocksdb::DB::open_default(Store::path(&legacy).unwrap()).unwrap();
            retained = db.get(&vote_key).unwrap().unwrap();
            let mut key = vec![b'e'];
            key.extend(post.checked.decoded.tx_hash.0);
            db.delete(key).unwrap();
            db.flush().unwrap();
        }
        let router = test_server(registry).into_router();
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/message/monad/topics/{}",
                        hex::encode(post.event.target_hash())
                    ))
                    .header(ACCEPT, "application/cbor")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        drop(router);
        let db = rocksdb::DB::open_default(Store::path(&legacy).unwrap()).unwrap();
        assert_eq!(
            db.get(&vote_key).unwrap().unwrap(),
            retained,
            "retained authority must not be rewritten"
        );
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            String::from_utf8_lossy(&body)
        );
        assert!(String::from_utf8_lossy(&body).contains("forum_unavailable"));
    }

    #[tokio::test]
    async fn forum_actual_router_post_vote_read_status_and_restart() {
        // A fresh process isolates the existing process-wide environment gate. No
        // other test sees a changed RPC URL, and no external chain is contacted.
        const CHILD: &str = "FRANK_FORUM_ROUTER_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output=std::process::Command::new(std::env::current_exe().unwrap())
                .env(CHILD,"1").args(["--exact","http::monad_topics::tests::forum_actual_router_post_vote_read_status_and_restart","--nocapture"])
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use crate::store::forum::tests::observation;
        use frank_cbor::{ForumOperationEvidence, TypedPayload, ValidationResult};
        use tower::ServiceExt;
        let post = observation(0, None, false);
        let vote = observation(1, Some(*post.event.target_hash()), true);
        let unknown = observation(2, None, false);
        let ops = Arc::new(vec![post.clone(), vote.clone()]);
        let rpc_ops = ops.clone();
        let rpc=axum::Router::new().route("/",axum::routing::post(move |Json(request):Json<Value>| {
            let ops=rpc_ops.clone(); async move {
                let method=request["method"].as_str().unwrap();
                let hash=if method=="eth_sendRawTransaction" {
                    let raw=hex::decode(request["params"][0].as_str().unwrap().trim_start_matches("0x")).unwrap();
                    decode_signed_transaction(&raw).unwrap().tx_hash.to_hex()
                }else{request["params"][0].as_str().unwrap().to_string()};
                let op=ops.iter().find(|op|op.checked.decoded.tx_hash.to_hex()==hash);
                let result=match (method,op) {
                    ("eth_sendRawTransaction",Some(_))=>Value::String(hash.clone()),
                    ("eth_getTransactionReceipt",Some(op))=>serde_json::json!({"transactionHash":hash,"blockHash":hex_hash(0x22),"blockNumber":"0x1","transactionIndex":"0x0","from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"contractAddress":null,"gasUsed":"0x5208","status":"0x1","logs":[]}),
                    ("eth_getTransactionByHash",Some(op))=>serde_json::json!({"hash":hash,"from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"value":"0x7","input":format!("0x{}",hex::encode(&op.checked.decoded.input))}),
                    _=>Value::Null,
                };
                Json(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
            }
        }));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", format!("http://{address}/"));
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
        let task = tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(rpc.into_make_service()),
        );
        let (directory, registry) = test_registry();
        let mut router = test_server(registry).into_router();
        async fn call(router: &axum::Router, method: &str, path: &str, bytes: &[u8]) -> Vec<u8> {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header(CONTENT_TYPE, "application/cbor")
                        .header(ACCEPT, "application/cbor")
                        .body(axum::body::Body::from(bytes.to_vec()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = hyper::body::to_bytes(response.into_body())
                .await
                .unwrap()
                .to_vec();
            assert_eq!(
                status,
                StatusCode::OK,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
            let ValidationResult::Parsed(_) =
                frank_cbor::validate_frame(&bytes, &frank_cbor::default_context()).unwrap()
            else {
                panic!()
            };
            bytes
        }
        let submitted = call(&router, "PUT", "/message/monad/topics", post.frame()).await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&submitted, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumOperationStatus(status) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert!(matches!(
            status.evidence,
            ForumOperationEvidence::Confirmed { .. }
        ));
        call(&router, "PUT", "/message/monad/topics/vote", vote.frame()).await;
        let hash = hex::encode(post.event.target_hash());
        call(
            &router,
            "GET",
            &format!("/message/monad/topics/{hash}"),
            &[],
        )
        .await;
        call(
            &router,
            "GET",
            "/message/monad/topics?topic=test.topic&since=0",
            &[],
        )
        .await;
        call(&router, "GET", "/message/monad/topics/discover", &[]).await;
        let response = call(
            &router,
            "POST",
            "/message/monad/topics/status",
            unknown.frame(),
        )
        .await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&response, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumOperationStatus(status) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert_eq!(status.evidence, ForumOperationEvidence::UnknownRequest);
        drop(router);
        let registry = Registry::new(
            Db::open(directory.path().join("db.rocksdb")).unwrap(),
            Arc::new(UnusedChainAdapter),
            Net::Regtest,
        );
        router = test_server(registry).into_router();
        call(
            &router,
            "POST",
            "/message/monad/topics/status",
            post.frame(),
        )
        .await;
        call(&router, "PUT", "/message/monad/topics", post.frame()).await;
        let view = call(
            &router,
            "GET",
            &format!("/message/monad/topics/{hash}"),
            &[],
        )
        .await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&view, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumView(view) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert_eq!(view.aggregate.magnitude, [0; 32]);
        task.abort();
    }

    #[test]
    fn predecessor_accept_defaults_do_not_select_exclusive_cbor_reads() {
        // #769 must leave absent/wildcard and dual-format callers on the predecessor
        // list/discovery representation. Only an explicit protobuf exclusion selects
        // the new Forum read family; preference order alone is not an exclusion.
        for accept in [
            None,
            Some("*/*"),
            Some("application/cbor, application/x-protobuf;q=0.1"),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(accept) = accept {
                headers.insert(ACCEPT, accept.parse().unwrap());
            }
            assert!(topic_accepts(&headers, "application/x-protobuf"));
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            "application/cbor, application/x-protobuf;q=0, */*;q=1"
                .parse()
                .unwrap(),
        );
        assert!(topic_accepts(&headers, "application/cbor"));
        assert!(!topic_accepts(&headers, "application/x-protobuf"));
    }

    #[test]
    fn write_format_is_selected_only_from_content_type() {
        let mut headers = HeaderMap::new();
        assert_eq!(topic_request_format(&headers), None);
        headers.insert(CONTENT_TYPE, "application/cbor".parse().unwrap());
        assert_eq!(
            topic_request_format(&headers),
            Some(TopicRequestFormat::Cbor)
        );
        headers.insert(
            CONTENT_TYPE,
            "application/x-protobuf; charset=binary".parse().unwrap(),
        );
        assert_eq!(
            topic_request_format(&headers),
            Some(TopicRequestFormat::Protobuf)
        );
        headers.insert(CONTENT_TYPE, "application/octet-stream".parse().unwrap());
        assert_eq!(topic_request_format(&headers), None);

        headers.remove(CONTENT_TYPE);
        assert!(topic_accepts(&headers, "application/x-protobuf"));
        headers.insert(ACCEPT, "application/x-protobuf".parse().unwrap());
        assert!(topic_accepts(&headers, "application/x-protobuf"));
        headers.insert(
            ACCEPT,
            "application/cbor, application/x-protobuf".parse().unwrap(),
        );
        assert!(topic_accepts(&headers, "application/x-protobuf"));
        headers.insert(ACCEPT, "application/cbor".parse().unwrap());
        assert!(!topic_accepts(&headers, "application/x-protobuf"));

        for expected in ["application/cbor", "application/x-protobuf"] {
            headers.insert(
                ACCEPT,
                format!("{expected};q=0, application/*;q=1, */*;q=1")
                    .parse()
                    .unwrap(),
            );
            assert!(
                !topic_accepts(&headers, expected),
                "an exact refusal must override positive wildcards for {expected}"
            );
            headers.insert(ACCEPT, "application/*;q=0, */*;q=1".parse().unwrap());
            assert!(
                !topic_accepts(&headers, expected),
                "a type-wildcard refusal must override a positive global wildcard for {expected}"
            );
            headers.insert(
                ACCEPT,
                format!("{expected};q=0.4, */*;q=0").parse().unwrap(),
            );
            assert!(
                topic_accepts(&headers, expected),
                "a positive exact range must override a refused wildcard for {expected}"
            );
            headers.insert(ACCEPT, format!("{expected};profile=next").parse().unwrap());
            assert!(
                !topic_accepts(&headers, expected),
                "a parameter-constrained range must not match a bare offer for {expected}"
            );
            headers.insert(
                ACCEPT,
                format!(r#"{expected};profile="comma,semicolon;safe""#)
                    .parse()
                    .unwrap(),
            );
            assert!(!topic_accepts(&headers, expected));
            headers.insert(
                ACCEPT,
                format!("{expected};profile=next;q=1, {expected};q=0")
                    .parse()
                    .unwrap(),
            );
            assert!(!topic_accepts(&headers, expected));
            headers.insert(
                ACCEPT,
                format!("{expected};profile=next;q=0, {expected};q=1")
                    .parse()
                    .unwrap(),
            );
            assert!(topic_accepts(&headers, expected));
            headers.insert(
                ACCEPT,
                format!(r#"{expected};q=1;ext="comma,semicolon;safe""#)
                    .parse()
                    .unwrap(),
            );
            assert!(
                topic_accepts(&headers, expected),
                "post-q accept extensions remain non-constraining for {expected}"
            );
        }
    }

    #[tokio::test]
    async fn post_broadcast_timeout_has_a_machine_readable_ambiguous_outcome() {
        let timeout = ProcessCborTopicEventError::Burn(TopicBurnError::Rejected(
            TopicVoteRelayOutcome::ConfirmationTimedOut {
                tx_hash: Hash32([0x42; 32]),
            },
        ));
        for response in [
            PutMonadTopicPostError::Cbor(timeout).into_response(),
            PutMonadTopicVoteError::Cbor(ProcessCborTopicEventError::Burn(
                TopicBurnError::Rejected(TopicVoteRelayOutcome::ConfirmationTimedOut {
                    tx_hash: Hash32([0x42; 32]),
                }),
            ))
            .into_response(),
            PutMonadTopicPostError::Process(ProcessMonadTopicPostError::Rejected(
                TopicVoteRelayOutcome::ConfirmationTimedOut {
                    tx_hash: Hash32([0x42; 32]),
                },
            ))
            .into_response(),
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::Rejected(
                TopicVoteRelayOutcome::ConfirmationTimedOut {
                    tx_hash: Hash32([0x42; 32]),
                },
            ))
            .into_response(),
            PutMonadTopicVoteError::Process(ProcessMonadTopicVoteError::OutcomeUnknown(
                Report::msg("storage failed after confirmation"),
            ))
            .into_response(),
            PutMonadTopicPostError::Cbor(ProcessCborTopicEventError::OutcomeUnknown(Report::msg(
                "storage failed after confirmation",
            )))
            .into_response(),
        ] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["error"], "topic_burn_outcome_unknown");
        }
    }

    #[tokio::test]
    async fn cbor_post_is_verified_and_keeps_its_exact_type_9_frame_at_rest() {
        let (_tempdir, registry) = test_registry();
        let post_frame = cbor_post_frame();
        let preliminary =
            parse_topic_event(&cbor_submission(&post_frame, &[1]), "monad-testnet").unwrap();
        let commitment = *preliminary.commitment();
        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x71; 32])
            .unwrap();
        let calldata = cbor_topic_calldata(0x01, &commitment);
        let (raw_burn_tx, sender) =
            signed_eip1559_tx(&seckey, 10_143, 0, burn_address(), 7_000, &calldata);
        let decoded_tx = decode_signed_transaction(&raw_burn_tx).unwrap();
        let tx_hash = format!("0x{}", hex::encode(decoded_tx.tx_hash.0));
        let to = hex_addr(burn_address());
        let transport = MockTransport::default();
        transport.set("eth_sendRawTransaction", Value::String(tx_hash.clone()));
        transport.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": tx_hash,
                "blockHash": hex_hash(0x22),
                "blockNumber": "0x2a",
                "transactionIndex": "0x0",
                "from": sender.to_hex(),
                "to": to,
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": format!("0x{}", hex::encode(decoded_tx.tx_hash.0)),
                "to": hex_addr(burn_address()),
                "value": "0x1b58",
                "input": format!("0x{}", hex::encode(&calldata)),
                "from": sender.to_hex(),
            }),
        );

        let submission = cbor_submission(&post_frame, &raw_burn_tx);
        let stored = process_cbor_topic_event(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &submission,
            CborTopicEventKind::Post,
        )
        .await
        .unwrap();
        let StoredCborTopicEvent::Post(stored) = stored else {
            panic!("expected post")
        };
        assert_eq!(stored.cbor_post_frame, post_frame);
        assert_eq!(stored.sender_address, sender.0);
        let inner = stored.post.unwrap();
        assert_eq!(inner.topic, "test.topic");
        assert_eq!(inner.encrypted_payload, b"hello from CBOR");
        assert_eq!(
            registry
                .get_monad_topic_post(&inner.payload_hash)
                .unwrap()
                .unwrap()
                .cbor_post_frame,
            post_frame
        );
        assert!(registry
            .get_monad_topic_post_view(&inner.payload_hash)
            .unwrap()
            .is_none());

        let server = test_server(registry);
        for accept in [
            None,
            Some("*/*"),
            Some("application/*"),
            Some("application/cbor, application/x-protobuf"),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(accept) = accept {
                headers.insert(ACCEPT, accept.parse().unwrap());
            }
            let response = handle_get_monad_topic_post(
                Path(hex::encode(&inner.payload_hash)),
                Extension(server.clone()),
                headers,
            )
            .await
            .unwrap();
            assert_eq!(response.headers()[CONTENT_TYPE], "application/cbor");
            assert_eq!(
                hyper::body::to_bytes(response.into_body()).await.unwrap(),
                post_frame.as_slice()
            );
        }
        let mut protobuf_only = HeaderMap::new();
        protobuf_only.insert(
            ACCEPT,
            "application/cbor;q=0, application/x-protobuf;q=1, */*;q=1"
                .parse()
                .unwrap(),
        );
        assert!(matches!(
            handle_get_monad_topic_post(
                Path(hex::encode(&inner.payload_hash)),
                Extension(server.clone()),
                protobuf_only,
            )
            .await,
            Err(GetMonadTopicPostError::NotFound)
        ));
        let mut constrained_cbor = HeaderMap::new();
        constrained_cbor.insert(
            ACCEPT,
            "application/cbor;profile=next, application/x-protobuf"
                .parse()
                .unwrap(),
        );
        assert!(matches!(
            handle_get_monad_topic_post(
                Path(hex::encode(&inner.payload_hash)),
                Extension(server.clone()),
                constrained_cbor,
            )
            .await,
            Err(GetMonadTopicPostError::NotFound)
        ));
        let mut neither = HeaderMap::new();
        neither.insert(ACCEPT, "text/plain".parse().unwrap());
        assert!(matches!(
            handle_get_monad_topic_post(
                Path(hex::encode(&inner.payload_hash)),
                Extension(server),
                neither,
            )
            .await,
            Err(GetMonadTopicPostError::NotAcceptable)
        ));
    }

    #[tokio::test]
    async fn cbor_post_http_processing_is_idempotent_after_already_known() {
        let (_tempdir, registry) = test_registry();
        let post_frame = cbor_post_frame();
        let preliminary =
            parse_topic_event(&cbor_submission(&post_frame, &[1]), "monad-testnet").unwrap();
        let commitment = *preliminary.commitment();
        let seckey = EccSecp256k1::default()
            .seckey_from_array([0x72; 32])
            .unwrap();
        let calldata = cbor_topic_calldata(0x01, &commitment);
        let (raw_burn_tx, sender) =
            signed_eip1559_tx(&seckey, 10_143, 0, burn_address(), 7_000, &calldata);
        let decoded_tx = decode_signed_transaction(&raw_burn_tx).unwrap();
        let tx_hash = format!("0x{}", hex::encode(decoded_tx.tx_hash.0));
        let transport = MockTransport::default();
        transport.set("eth_sendRawTransaction", Value::String(tx_hash.clone()));
        transport.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": tx_hash,
                "blockHash": hex_hash(0x22),
                "blockNumber": "0x2a",
                "transactionIndex": "0x0",
                "from": sender.to_hex(),
                "to": hex_addr(burn_address()),
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": format!("0x{}", hex::encode(decoded_tx.tx_hash.0)),
                "to": hex_addr(burn_address()),
                "value": "0x1b58",
                "input": format!("0x{}", hex::encode(&calldata)),
                "from": sender.to_hex(),
            }),
        );
        let submission = cbor_submission(&post_frame, &raw_burn_tx);

        process_cbor_topic_event(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &submission,
            CborTopicEventKind::Post,
        )
        .await
        .unwrap();
        transport.set_already_known();
        process_cbor_topic_event(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &submission,
            CborTopicEventKind::Post,
        )
        .await
        .expect("an already-known retry must still verify and store idempotently");
    }

    #[tokio::test]
    async fn legacy_post_get_negotiation_serves_only_its_protobuf_representation() {
        let (_tempdir, registry) = test_registry();
        let hash = store_monad_topic_post_at(&registry, b"legacy-body".to_vec(), "legacy", 1);
        let server = test_server(registry);
        for accept in [
            None,
            Some("*/*"),
            Some("application/*"),
            Some("application/cbor, application/x-protobuf"),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(accept) = accept {
                headers.insert(ACCEPT, accept.parse().unwrap());
            }
            let response = handle_get_monad_topic_post(
                Path(hex::encode(&hash)),
                Extension(server.clone()),
                headers,
            )
            .await
            .unwrap();
            assert_eq!(response.headers()[CONTENT_TYPE], "application/x-protobuf");
        }
        let mut cbor_only = HeaderMap::new();
        cbor_only.insert(
            ACCEPT,
            "application/x-protobuf;q=0, application/cbor;q=1, */*;q=1"
                .parse()
                .unwrap(),
        );
        assert!(matches!(
            handle_get_monad_topic_post(
                Path(hex::encode(&hash)),
                Extension(server.clone()),
                cbor_only,
            )
            .await,
            Err(GetMonadTopicPostError::NotFound)
        ));
        let mut constrained_protobuf = HeaderMap::new();
        constrained_protobuf.insert(
            ACCEPT,
            "application/x-protobuf;profile=next, application/cbor"
                .parse()
                .unwrap(),
        );
        assert!(matches!(
            handle_get_monad_topic_post(
                Path(hex::encode(&hash)),
                Extension(server.clone()),
                constrained_protobuf,
            )
            .await,
            Err(GetMonadTopicPostError::NotFound)
        ));
        let mut neither = HeaderMap::new();
        neither.insert(ACCEPT, "text/plain".parse().unwrap());
        assert!(matches!(
            handle_get_monad_topic_post(Path(hex::encode(hash)), Extension(server), neither).await,
            Err(GetMonadTopicPostError::NotAcceptable)
        ));
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
                "transactionIndex": "0x0",
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
    async fn cbor_vote_on_unknown_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let vote = cbor_vote_submission(&[0xaa; 32], &[0x01, 0xc0]);
        let transport = MockTransport::default();

        let err = process_cbor_topic_event(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &vote,
            CborTopicEventKind::Vote,
        )
        .await
        .expect_err("voting on an unknown post should be rejected");

        assert!(matches!(err, ProcessCborTopicEventError::UnknownTargetPost));
    }

    #[tokio::test]
    async fn cbor_vote_on_legacy_post_is_rejected_before_touching_the_network() {
        let (_tempdir, registry) = test_registry();
        let target = store_monad_topic_post_at(&registry, b"legacy-target".to_vec(), "legacy", 100);
        let target: [u8; 32] = target.try_into().unwrap();
        let vote = cbor_vote_submission(&target, &[0x01, 0xc0]);
        let transport = MockTransport::default();

        let err = process_cbor_topic_event(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            &vote,
            CborTopicEventKind::Vote,
        )
        .await
        .expect_err("a type-11 vote must not target a legacy protobuf row");

        assert!(matches!(err, ProcessCborTopicEventError::UnknownTargetPost));
    }

    #[tokio::test]
    async fn legacy_vote_on_cbor_post_is_rejected_before_rpc_and_does_not_change_tally() {
        let (_tempdir, registry) = test_registry();
        let frame = cbor_post_frame();
        let event = parse_topic_event(&cbor_submission(&frame, &[1]), "monad-testnet").unwrap();
        let TopicEvent::Post(post) = event else {
            panic!("expected post")
        };
        let stored = proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost {
                topic: post.topic,
                parent_post_hash: vec![],
                raw_burn_tx: vec![1],
                encrypted_payload: post.body,
                payload_hash: post.post_hash.to_vec(),
            }),
            sender_address: vec![2; 20],
            tx_hash: vec![3; 32],
            timestamp: 1,
            network_tag: crate::network_tag::frank_network_tag().to_vec(),
            cbor_post_frame: frame,
            confirmed_block_number: 1,
            confirmed_transaction_index: 0,
        };
        let initial_vote = proto::StoredMonadTopicVoteEntry {
            target_payload_hash: post.post_hash.to_vec(),
            sender_address: vec![2; 20],
            tx_hash: vec![3; 32],
            timestamp: 1,
            weight: 7,
        };
        registry
            .admit_cbor_topic_post(&post.post_hash, stored, &initial_vote)
            .unwrap();
        let before = registry.monad_topic_vote_tally(&post.post_hash).unwrap();
        let transport = MockTransport::default();
        let error = process_monad_topic_vote(
            &transport,
            &registry,
            burn_address(),
            fast_poll(),
            proto::MonadTopicVote {
                target_payload_hash: post.post_hash.to_vec(),
                raw_burn_tx: vec![0xc0],
            },
        )
        .await
        .expect_err("legacy votes must not target a CBOR-origin row");
        assert!(matches!(
            error,
            ProcessMonadTopicVoteError::UnknownTargetPost
        ));
        assert_eq!(transport.call_count(), 0);
        assert_eq!(
            registry.monad_topic_vote_tally(&post.post_hash).unwrap(),
            before
        );
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
        payload_seed: Vec<u8>,
        topic: &str,
        timestamp: i64,
    ) -> Vec<u8> {
        let encrypted_payload = payload_seed;
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        let stored = proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost {
                topic: topic.to_string(),
                parent_post_hash: vec![],
                raw_burn_tx: vec![1, 2, 3],
                encrypted_payload,
                payload_hash: payload_hash.clone(),
            }),
            sender_address: vec![9u8; 20],
            tx_hash: vec![8u8; 32],
            timestamp,
            network_tag: Vec::new(),
            cbor_post_frame: Vec::new(),
            confirmed_block_number: 0,
            confirmed_transaction_index: 0,
        };
        registry
            .put_monad_topic_post(&payload_hash, stored, &[])
            .unwrap();
        payload_hash
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
        // Insert out of order, and interleaved with a different topic, to prove both the ordering
        // and the topic filter.
        let hash_b = store_monad_topic_post_at(&registry, vec![0xbb; 32], "topic.one", 200);
        let hash_other = store_monad_topic_post_at(&registry, vec![0xcc; 32], "topic.two", 150);
        let hash_a = store_monad_topic_post_at(&registry, vec![0xaa; 32], "topic.one", 100);

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
        store_monad_topic_post_at(&registry, vec![0x11; 32], "topic.cursor", 100);
        let hash_new = store_monad_topic_post_at(&registry, vec![0x22; 32], "topic.cursor", 200);

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
        let hash = store_monad_topic_post_at(&registry, vec![0x33; 32], "topic.tally", 100);

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
        let response = handle_list_topics(Extension(server), HeaderMap::new())
            .await
            .expect("listing discovered topics should succeed");
        assert_eq!(response.headers()[VARY], "Accept");
        let response = proto::ListTopicsResponse::decode(
            hyper::body::to_bytes(response.into_body())
                .await
                .unwrap()
                .as_ref(),
        )
        .unwrap();

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
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
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

    #[tokio::test]
    async fn topic_lists_select_canonical_reads_and_preserve_legacy_accept_responses() {
        const CHILD: &str = "FRANK_FORUM_ACCEPT_COEXISTENCE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .env(CHILD, "1")
                .args(["--exact", "http::monad_topics::tests::topic_lists_select_canonical_reads_and_preserve_legacy_accept_responses", "--nocapture"])
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1/");
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
        use tower::ServiceExt;

        let (_tempdir, registry) = test_registry();
        store_monad_topic_post_at(&registry, vec![0xab; 32], "topic.accept", 500);
        let router = test_server(registry).into_router();

        for uri in [
            "/message/monad/topics?topic=topic.accept",
            "/message/monad/topics/discover",
        ] {
            for accept in ["application/cbor", "application/x-protobuf;q=0, */*;q=1"] {
                let request = axum::http::Request::builder()
                    .method("GET")
                    .uri(uri)
                    .header(ACCEPT, accept)
                    .body(hyper::Body::empty())
                    .unwrap();
                let response = router.clone().oneshot(request).await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers()[CONTENT_TYPE], "application/cbor");
                assert!(response
                    .headers()
                    .get_all(VARY)
                    .iter()
                    .any(|value| value.as_bytes().eq_ignore_ascii_case(b"accept")));
                let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
                let frank_cbor::ValidationResult::Parsed(parsed) =
                    frank_cbor::validate_frame(&body, &frank_cbor::default_context()).unwrap()
                else {
                    panic!()
                };
                match parsed.typed.as_deref().unwrap() {
                    frank_cbor::TypedPayload::ForumTopicPage(page) => assert!(page.rows.is_empty()),
                    frank_cbor::TypedPayload::ForumDiscoveryPage(page) => {
                        assert!(page.entries.is_empty())
                    }
                    _ => panic!("canonical read family required"),
                }
            }
            for accept in [
                "application/json",
                "application/cbor;q=0, application/x-protobuf;q=0, */*;q=1",
            ] {
                let response = router
                    .clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .uri(uri)
                            .header(ACCEPT, accept)
                            .body(hyper::Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::NOT_ACCEPTABLE);
                assert!(response
                    .headers()
                    .get_all(VARY)
                    .iter()
                    .any(|value| value.as_bytes().eq_ignore_ascii_case(b"accept")));
            }
            let mut legacy_bytes = None;
            for accept in [None, Some("*/*"), Some("application/x-protobuf")] {
                let mut request = axum::http::Request::builder().method("GET").uri(uri);
                if let Some(accept) = accept {
                    request = request.header(ACCEPT, accept);
                }
                let response = router
                    .clone()
                    .oneshot(request.body(hyper::Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert!(response
                    .headers()
                    .get_all(VARY)
                    .iter()
                    .any(|value| value.as_bytes().eq_ignore_ascii_case(b"accept")));
                assert_eq!(response.headers()[CONTENT_TYPE], "application/x-protobuf");
                let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
                if let Some(previous) = &legacy_bytes {
                    assert_eq!(&body, previous);
                } else {
                    legacy_bytes = Some(body);
                }
            }
        }
    }

    #[tokio::test]
    async fn monad_topic_write_routes_enforce_declared_request_and_response_media_types() {
        use tower::ServiceExt;

        let (_tempdir, registry) = test_registry();
        let server = test_server(registry);
        let stored = Arc::clone(&server.registry);
        let router = server.into_router();
        let unsupported = axum::http::Request::builder()
            .method("PUT")
            .uri("/message/monad/topics")
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(hyper::Body::from(vec![0u8]))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(unsupported).await.unwrap().status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );

        for uri in ["/message/monad/topics", "/message/monad/topics/vote"] {
            let parameterized_cbor = axum::http::Request::builder()
                .method("PUT")
                .uri(uri)
                .header(CONTENT_TYPE, "application/cbor; charset=binary")
                .header(ACCEPT, "application/cbor")
                .body(hyper::Body::from(vec![0xff]))
                .unwrap();
            assert_eq!(
                router
                    .clone()
                    .oneshot(parameterized_cbor)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            );
        }

        for (uri, content_type, accept) in [
            (
                "/message/monad/topics",
                "application/cbor",
                "application/cbor;q=0, application/*;q=1, */*;q=1",
            ),
            (
                "/message/monad/topics/vote",
                "application/x-protobuf",
                "application/x-protobuf;q=0, application/*;q=1, */*;q=1",
            ),
            (
                "/message/monad/topics",
                "application/cbor",
                "application/cbor;profile=next",
            ),
            (
                "/message/monad/topics/vote",
                "application/x-protobuf",
                "application/x-protobuf;profile=next",
            ),
        ] {
            let explicitly_refused = axum::http::Request::builder()
                .method("PUT")
                .uri(uri)
                .header(CONTENT_TYPE, content_type)
                .header(ACCEPT, accept)
                .body(hyper::Body::from(vec![0xff]))
                .unwrap();
            assert_eq!(
                router
                    .clone()
                    .oneshot(explicitly_refused)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_ACCEPTABLE,
                "an exact q=0 must reject before malformed-body decode or RPC"
            );
        }
        assert!(
            stored.list_topics().unwrap().is_empty(),
            "refused writes must not mutate topic storage"
        );

        let oversized = axum::http::Request::builder()
            .method("PUT")
            .uri("/message/monad/topics")
            .header(CONTENT_TYPE, "application/cbor")
            .header(ACCEPT, "application/cbor")
            .body(hyper::Body::from(vec![
                0u8;
                MAX_TOPIC_EVENT_FRAME_BYTES as usize
                    + 1
            ]))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(oversized).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );

        let legacy_over_cbor_cap = axum::http::Request::builder()
            .method("PUT")
            .uri("/message/monad/topics")
            .header(CONTENT_TYPE, "application/x-protobuf")
            .header(ACCEPT, "application/x-protobuf")
            .body(hyper::Body::from(vec![
                0u8;
                MAX_TOPIC_EVENT_FRAME_BYTES as usize
                    + 1
            ]))
            .unwrap();
        assert_ne!(
            router.oneshot(legacy_over_cbor_cap).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "the CBOR R6 cap must not silently narrow the legacy protobuf collector"
        );
    }
}
