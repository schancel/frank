//! Module containing [`RegistryServer`] to run the registry HTTP server.

use crate::{
    http::error::HttpRegistryError,
    http::monad_message::{
        handle_get_monad_message, handle_list_monad_messages, handle_put_monad_message,
    },
    http::monad_profile::{
        fetch_profile_or_not_found, handle_get_monad_profile, handle_list_monad_profiles,
        handle_put_monad_profile,
    },
    http::monad_topics::{
        handle_get_monad_topic_post, handle_list_monad_topic_posts, handle_put_monad_topic_post,
        handle_put_monad_topic_vote,
    },
    http::pop_protection::{self, MonadReceiptVerifier, PopChallenge, PopGate, PopGateConfigError},
    monad_http::{Address as MonadAddress, HttpTransport},
    p2p::{peers::Peers, relay_info::RelayInfo},
    proto::{self},
    registry::Registry,
};
use axum::{
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::from_fn,
    response::{IntoResponse, Response},
    routing, Extension, Json, Router,
};
use bitcoinsuite_core::{Hashed, LotusAddress, LotusAddressError};
use bitcoinsuite_error::{ErrorMeta, Report, Result};
use cashweb_http_utils::protobuf::Protobuf;
use cashweb_payload::proto::SignedPayloadSet;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, str::FromStr, sync::Arc};
use thiserror::Error;
use tower_http::cors::{Any, CorsLayer};
use tracing::Level;

#[derive(Deserialize)]
struct MessagesQuery {
    from: Option<i64>,
    to: Option<i64>,
}

/// Provides endpoints to read and write from the Cashweb Registry.
#[derive(Debug, Clone)]
pub struct RegistryServer {
    /// [`Registry`] this server accesses.
    pub registry: Arc<Registry>,
    /// [`Peers`] connected to the server.
    pub peers: Arc<Peers>,
    /// POP (proof-of-payment) protection gate for [`handle_put_registry`] (ticket #4/#24), built
    /// once at construction time from real config (see `http::pop_protection`'s module docs'
    /// "Configuration" section) rather than lazily from raw env vars.
    ///
    /// Ticket #35 adds a third, explicit state on top of #4's fail-closed `Result`, via the outer
    /// `Option` (see [`pop_protection::PopGate::from_conf_if_enabled`], which builds this field):
    ///
    /// - `None`: POP is intentionally disabled (`PopConf::enabled = false`, the hackathon demo
    ///   default) -- [`handle_put_registry`] skips the gate entirely: no token check, no 402
    ///   challenge, the request proceeds as if no gate existed at all.
    /// - `Some(Err(_))`: POP is enabled but this server was constructed with an invalid
    ///   [`cashweb_config::PopConf`]; every metadata-PUT request then fails closed with a `500`
    ///   (see [`PutRegistryError::PopUnavailable`]) rather than silently skipping POP protection.
    /// - `Some(Ok(gate))`: POP is enabled and configured correctly; requests are gated normally.
    ///
    /// These two failure/off states are deliberately kept distinct (`None` vs. `Some(Err(_))`)
    /// rather than collapsed into one -- "disabled" must never be reachable by a config that's
    /// simply broken, and "misconfigured" must never silently degrade into "disabled".
    pub pop_gate:
        Arc<Option<Result<PopGate<MonadReceiptVerifier<HttpTransport>>, PopGateConfigError>>>,
}

/// Relevant parts of an HTTP request to put new address metadata.
#[derive(Debug, Clone)]
pub struct PutMetadataRequest {
    /// Address the metadata should be updated for.
    pub address: LotusAddress,
    /// HTTP headers of the PUT request.
    pub header_map: HeaderMap,
    /// Signed serialized [`proto::AddressMetadata`] payload.
    pub signed_metadata: cashweb_payload::proto::SignedPayload,
}

/// Relevant parts of an HTTP request to put new broadcast messages.
#[derive(Debug, Clone)]
pub struct PutMessageRequest {
    /// HTTP headers of the PUT request.
    pub header_map: HeaderMap,
    /// Signed serialized [`proto::AddressMetadata`] payload.
    pub signed_message: cashweb_payload::proto::SignedPayload,
    /// TX ids involved in this particular instance of the message
    pub tx_ids: Vec<Vec<u8>>,
}

/// Errors indicating invalid requests being sent to the Registry endpoint.
#[derive(Debug, Error, ErrorMeta)]
pub enum RegistryServerError {
    /// Invalid lotus address in request.
    #[invalid_user_input()]
    #[error("Invalid lotus address: {0}")]
    InvalidAddress(LotusAddressError),

    /// Address metadata not found in registry.
    #[not_found()]
    #[error("Not found: No address metadata for {0} in registry")]
    AddressMetadataNotFound(LotusAddress),

    /// A query param is not valid.
    #[invalid_client_input()]
    #[error("Invalid {param}: {value:?} is invalid: {msg}")]
    InvalidQueryParam {
        /// Name of the query param in question.
        param: &'static str,
        /// Value provided for the query param.
        value: String,
        /// Why the value is invalid.
        msg: String,
    },
}

use self::RegistryServerError::*;

async fn log_request<B>(
    request: axum::http::Request<B>,
    next: axum::middleware::Next<B>,
) -> axum::response::Response {
    let method = request.method().to_owned();
    let uri = request.uri().to_owned();
    let start = std::time::Instant::now();

    let response = next.run(request).await;

    tracing::event!(
        Level::INFO,
        method = method.as_str(),
        path = uri.path(),
        // latency = format_args!("{} ms", latency.as_millis()),
        status = response.status().as_u16(),
        duration = format!("{} mcs", start.elapsed().as_micros()),
        "finished processing request"
    );

    response
}

impl RegistryServer {
    /// Turn this registry server into a [`Router`].
    pub fn into_router(self) -> Router {
        Router::new()
            .route("/metadata", routing::get(handle_get_metadata_range))
            .route(
                "/metadata/:addr",
                routing::put(handle_put_registry).get(handle_get_registry),
            )
            // Monad-native profile registration (ticket #45), additive alongside the Lotus-only
            // route above (a different path depth, so no route-matching conflict) -- see
            // `crate::http::monad_profile`'s module docs for why a Monad address is *also*
            // handled by `handle_put_registry`/`handle_get_registry` themselves (the plain route
            // above), not only here.
            .route(
                "/metadata/monad/:addr",
                routing::put(handle_put_monad_profile).get(handle_get_monad_profile),
            )
            // `GET /metadata/monad?since=<timestamp>` (ticket #75): registration discovery, e.g.
            // for a bot to auto-greet/auto-fund new signups -- see
            // `crate::http::monad_profile`'s module docs. No `:addr` segment, so this can't
            // collide with the route directly above.
            .route("/metadata/monad", routing::get(handle_list_monad_profiles))
            .route("/messages/:topic", routing::get(handle_get_messages))
            .route("/messages", routing::get(handle_get_all_messages))
            .route("/message", routing::put(handle_put_message))
            .route("/message/:payload_hash", routing::get(handle_get_message))
            // Monad-native stamped message path (ticket #27), additive alongside the Lotus
            // `/message` route above -- see `crate::http::monad_message`'s module docs for why
            // this is a separate route/message shape rather than an extension of
            // `handle_put_message`/`SignedPayload`.
            // `GET /message/monad?since=<timestamp>` (ticket #37): message discovery, listing
            // messages by store time rather than requiring an exact `payload_hash` -- see
            // `crate::http::monad_message`'s module docs for the full rationale (including the
            // recipient-addressing gap this endpoint doesn't attempt to paper over).
            .route(
                "/message/monad",
                routing::put(handle_put_monad_message).get(handle_list_monad_messages),
            )
            .route(
                "/message/monad/:payload_hash",
                routing::get(handle_get_monad_message),
            )
            // Monad topic post + burn-weighted vote path (ticket #30), additive alongside
            // the plain Monad-message route above -- see `crate::http::monad_topics`'s module docs.
            // Static segments ("topics", "topics/vote") take priority over the `:payload_hash`
            // wildcard segment at the same position, so these don't conflict with the route
            // above.
            // `GET /message/monad/topics?topic=<topic>&since=<timestamp>` (ticket #40):
            // topic-filtered post listing, added at the same path as the `PUT` above -- the same
            // same-path-different-method precedent as `/message/monad`'s `PUT`/`GET(since=)` pair
            // just above.
            .route(
                "/message/monad/topics",
                routing::put(handle_put_monad_topic_post).get(handle_list_monad_topic_posts),
            )
            .route(
                "/message/monad/topics/vote",
                routing::put(handle_put_monad_topic_vote),
            )
            .route(
                "/message/monad/topics/:payload_hash",
                routing::get(handle_get_monad_topic_post),
            )
            .layer(Extension(self))
            .layer(
                CorsLayer::new()
                    .allow_methods([
                        Method::GET,
                        Method::PUT,
                        Method::POST,
                        Method::HEAD,
                        Method::OPTIONS,
                    ])
                    .allow_headers([header::CONTENT_TYPE])
                    // allow requests from any origin
                    .allow_origin(Any),
            )
            .layer(from_fn(log_request))
    }
}

/// Response body for a `402`-style POP challenge (see `http::pop_protection`'s module docs for
/// the full request-shape contract this pairs with).
#[derive(Debug, Serialize)]
struct PopChallengeBody {
    error: &'static str,
    reason: &'static str,
    detail: Option<String>,
    /// `0x`-prefixed Monad address the payment must be sent to.
    recipient: String,
    /// Minimum payment amount, in wei, as a decimal string.
    min_value_wei: String,
    how_to_pay: &'static str,
}

impl From<PopChallenge> for PopChallengeBody {
    fn from(challenge: PopChallenge) -> Self {
        let reason = match challenge.reason {
            pop_protection::ChallengeReason::NoTokenOrProof => "no_token_or_proof",
            pop_protection::ChallengeReason::InvalidToken => "invalid_token",
            pop_protection::ChallengeReason::InvalidProof => "invalid_proof",
        };
        PopChallengeBody {
            error: "payment_required",
            reason,
            detail: challenge.detail,
            recipient: challenge.expected.recipient.to_hex(),
            min_value_wei: challenge.expected.min_value_wei.to_string(),
            how_to_pay: "Retry this PUT with query param pop_tx_hash=0x<32-byte Monad tx hash> \
                         once a payment to `recipient` for at least `min_value_wei` confirms. On \
                         success, the response carries an X-Pop-Token header; present it on later \
                         requests to the same address via `Authorization: POP <token>` (or \
                         `?access_token=POP <token>`) instead of paying again.",
        }
    }
}

/// Error type for [`handle_put_registry`]: wraps pre-existing registry/validation errors
/// unchanged, plus this ticket's (#24) new POP-gating outcomes.
#[derive(Debug)]
enum PutRegistryError {
    /// Pre-existing error path (invalid address, relay-info, registry/store errors, ...),
    /// unchanged from before this ticket.
    Registry(HttpRegistryError),
    /// POP protection is misconfigured (see [`RegistryServer::pop_gate`]). Fails closed rather
    /// than silently allowing the request through unauthenticated, since ticket #1 flagged
    /// exactly that (zero gating) as the bug this ticket fixes.
    PopUnavailable(PopGateConfigError),
    /// No valid bearer token or verifying payment proof was presented; challenge the client for
    /// payment.
    PaymentRequired(PopChallenge),
}

impl From<Report> for PutRegistryError {
    fn from(err: Report) -> Self {
        PutRegistryError::Registry(err.into())
    }
}

impl From<RegistryServerError> for PutRegistryError {
    fn from(err: RegistryServerError) -> Self {
        PutRegistryError::Registry(err.into())
    }
}

impl IntoResponse for PutRegistryError {
    fn into_response(self) -> Response {
        match self {
            PutRegistryError::Registry(err) => err.into_response(),
            PutRegistryError::PopUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "POP protection is misconfigured; rejecting metadata-put"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutRegistryError::PaymentRequired(challenge) => (
                StatusCode::PAYMENT_REQUIRED,
                Json(PopChallengeBody::from(challenge)),
            )
                .into_response(),
        }
    }
}

/// Successful [`handle_put_registry`] response. If this request minted a fresh POP bearer token
/// from an inline payment proof (see `http::pop_protection`'s module docs), it's surfaced via an
/// `X-Pop-Token` response header so the client can reuse it on later requests instead of paying
/// again.
struct PutRegistrySuccess {
    body: proto::PutSignedPayloadResponse,
    issued_token: Option<String>,
}

impl IntoResponse for PutRegistrySuccess {
    fn into_response(self) -> Response {
        let mut response = Protobuf(self.body).into_response();
        if let Some(token) = self.issued_token {
            if let Ok(value) = HeaderValue::from_str(&format!("POP {token}")) {
                response.headers_mut().insert("x-pop-token", value);
            }
        }
        response
    }
}

async fn handle_put_registry(
    Path(address): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    Protobuf(signed_metadata): Protobuf<cashweb_payload::proto::SignedPayload>,
    Extension(server): Extension<RegistryServer>,
    header_map: HeaderMap,
) -> Result<PutRegistrySuccess, PutRegistryError> {
    // Monad-native dispatch (ticket #45): see `crate::http::monad_profile`'s module docs for why
    // a Monad address reaching this historically Lotus-only route must be handled here too, not
    // only at the dedicated `/metadata/monad/:addr` route below -- the real, already-merged TS
    // client this route needs to unblock (`app/src/cashweb/wallet/monad-identity.ts`) calls this
    // plain route with a Monad address, never `/metadata/monad/:addr`. No POP gating on this
    // branch: profile registration was never POP-gated to begin with, and this ticket's non-goals
    // explicitly exclude adding it.
    if let Ok(monad_address) = MonadAddress::from_str(&address) {
        server
            .registry
            .put_monad_profile(monad_address, signed_metadata)?;
        return Ok(PutRegistrySuccess {
            body: proto::PutSignedPayloadResponse { txid: vec![] },
            issued_token: None,
        });
    }

    let address = address.parse::<LotusAddress>().map_err(InvalidAddress)?;

    // --- POP protection (ticket #24, config-wired for real in ticket #4, made toggleable in #35)
    // ---
    // Gate this endpoint behind a valid bearer token, minted from a verified Monad payment --
    // unless POP is explicitly disabled (`PopConf::enabled = false`), in which case the request
    // proceeds immediately, exactly as if this gate didn't exist. This is a genuinely different
    // path from "the gate exists but is misconfigured" (`Some(Err(_))` below), which must keep
    // failing closed with a `500` -- see [`RegistryServer::pop_gate`]'s doc comment.
    //
    // Previously this endpoint had no payment gating at all (ticket #1's finding); see
    // `http::pop_protection`'s module docs for the exact request shape a client uses to present a
    // token or submit a payment proof.
    let issued_token = match server.pop_gate.as_ref() {
        None => None,
        Some(Err(err)) => return Err(PutRegistryError::PopUnavailable(err.clone())),
        Some(Ok(gate)) => {
            let scope = address.as_str().as_bytes();
            pop_protection::authorize_put(gate, scope, &header_map, &query)
                .await
                .map_err(PutRegistryError::PaymentRequired)?
        }
    };
    // --- end POP protection ---

    let request = PutMetadataRequest {
        address,
        header_map,
        signed_metadata,
    };

    let relay_info = RelayInfo::parse_from_headers(&request.header_map)?;
    let result = server
        .registry
        .put_metadata(&request.address, &request.signed_metadata)
        .await?;
    // Relay to peers in a separate task
    tokio::spawn({
        let signed_metadata = result.signed_metadata.clone();
        let peers = Arc::clone(&server.peers);
        async move {
            peers
                .relay_metadata(&relay_info, &request, &signed_metadata)
                .await
        }
    });

    Ok(PutRegistrySuccess {
        body: proto::PutSignedPayloadResponse {
            txid: result
                .txids
                .into_iter()
                .map(|txid| txid.as_slice().to_vec())
                .collect(),
        },
        issued_token,
    })
}

async fn handle_get_registry(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayload>, HttpRegistryError> {
    // Monad-native dispatch (ticket #45) -- see `handle_put_registry`'s identical branch, and
    // `crate::http::monad_profile`'s module docs, for why.
    if let Ok(monad_address) = MonadAddress::from_str(&address) {
        let signed_payload = fetch_profile_or_not_found(&server.registry, monad_address)?;
        return Ok(Protobuf(signed_payload));
    }

    let address = address.parse::<LotusAddress>().map_err(InvalidAddress)?;
    let signed_payload = server
        .registry
        .get_metadata(&address)?
        .ok_or(AddressMetadataNotFound(address))?;
    Ok(Protobuf(signed_payload.to_proto()))
}

async fn handle_get_metadata_range(
    Query(params): Query<HashMap<String, String>>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::GetMetadataRangeResponse>, HttpRegistryError> {
    const START_TIMESTAMP: &str = "start_timestamp";
    const END_TIMESTAMP: &str = "end_timestamp";
    const NUM_ITEMS: &str = "num_items";
    const LAST_ADDRESS: &str = "last_address";
    const MAX_NUM_ITEMS: usize = 100;
    let start_timestamp = match params.get(START_TIMESTAMP) {
        Some(start_timestamp) => {
            start_timestamp
                .parse::<i64>()
                .map_err(|err| InvalidQueryParam {
                    param: START_TIMESTAMP,
                    value: start_timestamp.to_string(),
                    msg: err.to_string(),
                })?
        }
        None => 0,
    };
    let end_timestamp = match params.get(END_TIMESTAMP) {
        Some(end_timestamp) => {
            Some(
                end_timestamp
                    .parse::<i64>()
                    .map_err(|err| InvalidQueryParam {
                        param: END_TIMESTAMP,
                        value: end_timestamp.to_string(),
                        msg: err.to_string(),
                    })?,
            )
        }
        None => None,
    };
    let num_items = match params.get(NUM_ITEMS) {
        Some(num_items) => num_items
            .parse::<usize>()
            .map_err(|err| InvalidQueryParam {
                param: NUM_ITEMS,
                value: num_items.to_string(),
                msg: err.to_string(),
            })?
            .min(MAX_NUM_ITEMS),
        None => MAX_NUM_ITEMS,
    };
    let last_address = match params.get(LAST_ADDRESS) {
        Some(last_address) => {
            Some(
                LotusAddress::from_str(last_address).map_err(|err| InvalidQueryParam {
                    param: LAST_ADDRESS,
                    value: last_address.to_string(),
                    msg: err.to_string(),
                })?,
            )
        }
        None => None,
    };
    let metadata_range = server.registry.get_metadata_range(
        start_timestamp,
        end_timestamp,
        last_address.as_ref(),
        num_items,
    )?;
    Ok(Protobuf(proto::GetMetadataRangeResponse {
        entries: metadata_range
            .entries
            .into_iter()
            .map(|(address, signed_payload)| proto::GetMetadataRangeEntry {
                address: address.as_str().to_string(),
                signed_payload: Some(signed_payload.to_proto()),
            })
            .collect(),
    }))
}

async fn handle_get_messages(
    Path(topic): Path<String>,
    Query(params): Query<MessagesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayloadSet>, HttpRegistryError> {
    let from = params.from.unwrap_or_default();
    let to = params.to.unwrap_or(i64::MAX);

    let signed_payloads = server
        .registry
        .get_messages(topic.as_str(), from, to)?
        .iter()
        .map(|signed_payload| signed_payload.to_proto())
        .collect();

    let payload_page = SignedPayloadSet {
        items: signed_payloads,
    };

    Ok(Protobuf(payload_page))
}

async fn handle_get_all_messages(
    Query(params): Query<MessagesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayloadSet>, HttpRegistryError> {
    let from = params.from.unwrap_or_default();
    let to = params.to.unwrap_or(i64::MAX);

    let signed_payloads = server
        .registry
        .get_messages("", from, to)?
        .iter()
        .map(|signed_payload| signed_payload.to_proto())
        .collect();

    let payload_page = SignedPayloadSet {
        items: signed_payloads,
    };

    Ok(Protobuf(payload_page))
}

async fn handle_get_message(
    Path(hex_hash): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayload>, HttpRegistryError> {
    let payload_hash = hex::decode(&hex_hash).map_err(|err| HttpRegistryError(err.into()))?;
    let message = server.registry.get_message(payload_hash)?;

    Ok(Protobuf(message.to_proto()))
}

async fn handle_put_message(
    Protobuf(message): Protobuf<cashweb_payload::proto::SignedPayload>,
    Extension(server): Extension<RegistryServer>,
    header_map: HeaderMap,
) -> Result<Protobuf<proto::PutSignedPayloadResponse>, HttpRegistryError> {
    let result = server.registry.put_message(&message).await?;
    let tx_ids: Vec<Vec<u8>> = result
        .txids
        .into_iter()
        .map(|txid| txid.as_slice().to_vec())
        .collect();
    let request = PutMessageRequest {
        header_map,
        signed_message: message,
        tx_ids: tx_ids.clone(),
    };
    let relay_info = RelayInfo::parse_from_headers(&request.header_map)?;

    // Relay to peers in a separate task
    tokio::spawn({
        let peers = Arc::clone(&server.peers);
        async move { peers.relay_message(&relay_info, &request).await }
    });

    Ok(Protobuf(proto::PutSignedPayloadResponse { txid: tx_ids }))
}
