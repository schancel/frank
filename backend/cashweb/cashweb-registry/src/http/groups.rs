//! HTTP endpoints for Shared Group Mailboxes, Atomic Epoch CAS, Sealed-Sender Group
//! Messages, and Home-Relay Oblivious Proxy / Auto-Mirroring (Issue #70).
//!
//! Routes:
//! - `PUT /groups/:group_id/epochs` — Atomic Compare-And-Swap (CAS) epoch creation/transition.
//! - `GET /groups/:group_id/epochs` — Fetch current (or specific `?epoch=<u64>`) [`GroupEpochFrame`].
//! - `PUT /groups/:group_id/messages` — Submit a sealed-sender [`GroupMessageEnvelope`] signed by $w_{G,e}$,
//!   with the payment for the write ([`GroupWriteRequest`]). Only the hosting relay verifies it.
//! - `GET /groups/:group_id/write-policy` — What a write to a group hosted here must pay
//!   ([`GroupWritePolicyBody`]); proxied to the host with `X-Group-Upstream-Relay`.
//! - `PUT /groups/:group_id/write-price` — The group's creator sets or changes its write price
//!   ([`GroupWritePrice`], signed with the group's root key); proxied to the host with
//!   `X-Group-Upstream-Relay`.
//! - `GET /groups/:group_id/messages?after_seq=<u64>&limit=<u16>` — Sync ordered group messages
//!   authenticated via `X-Group-Read-Token`, with automatic Home-Relay proxying (`< n` local
//!   subscribers) and local mirror promotion (`>= n` local subscribers) when
//!   `X-Group-Upstream-Relay` is specified.

mod live;
#[cfg(test)]
mod nats_tests;
mod payment;

pub use payment::{
    GroupWritePaymentWire, GroupWritePolicyBody, GroupWriteRefusal, GroupWriteRequest,
    GroupWriteRuntime,
};

use crate::group_write_payment::{GroupPaymentError, GroupWritePrice};

use crate::store::large_values::LargeValueError;
use axum::{
    body::Bytes,
    extract::{Path, Query, RawBody},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing, Extension, Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    http::server::RegistryServer,
    store::groups::{
        parse_group_id_hex, GroupEpochFrame, GroupError, GroupStore, StoredGroupMessage,
    },
};

/// Ephemeral append disposition; never authority for a durable cursor or financial fact.
pub const HEADER_GROUP_APPEND: &str = "x-group-append-disposition";
/// Request header carrying the hex-encoded 32-byte Group Read Token $R_{G,e}$.
pub const HEADER_GROUP_READ_TOKEN: &str = "x-group-read-token";
/// Optional request header naming the foreign authoritative relay URL for a group.
pub const HEADER_GROUP_UPSTREAM_RELAY: &str = "x-group-upstream-relay";
/// Optional request header carrying a blinded local subscriber tag for auto-mirror threshold counting.
pub const HEADER_GROUP_SUBSCRIBER_TAG: &str = "x-group-subscriber-tag";
/// Response header indicating whether the request was served `local`, `proxy`, or `mirrored`.
pub const HEADER_GROUP_RELAY_MODE: &str = "x-group-relay-mode";

/// CORS headers used by the group mailbox endpoints.
pub const GROUP_CORS_HEADERS: [&str; 3] = [
    HEADER_GROUP_READ_TOKEN,
    HEADER_GROUP_UPSTREAM_RELAY,
    HEADER_GROUP_SUBSCRIBER_TAG,
];

/// Query parameters for `GET /groups/:group_id/epochs`.
#[derive(Debug, Deserialize, Default)]
pub struct EpochQuery {
    /// Optional specific epoch number to retrieve (`None` returns the latest epoch).
    pub epoch: Option<u64>,
}

/// Query parameters for `GET /groups/:group_id/messages`.
#[derive(Debug, Deserialize, Default)]
pub struct GroupMessagesQuery {
    /// Exclusive lower bound on `server_seq`.
    pub after_seq: Option<u64>,
    /// Maximum number of messages to return (`1..=500`).
    pub limit: Option<u16>,
}

/// Response body returned by `GET /groups/:group_id/messages`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMessagesResponse {
    /// Hex-encoded 32-byte `group_id`.
    pub group_id: String,
    /// Current active epoch of the group.
    pub epoch: u64,
    /// Ordered messages with `server_seq > after_seq`.
    pub messages: Vec<StoredGroupMessage>,
    /// Cursor (`server_seq`) to pass as `after_seq` on the next poll.
    pub next_after_seq: u64,
    /// `"local"`, `"proxy"`, or `"mirror"`.
    pub mode: String,
    /// Number of local subscribers tracked for a foreign group on this Home Relay.
    pub subscriber_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct EpochConflictBody {
    error: &'static str,
    current_epoch: GroupEpochFrame,
}

#[derive(Debug, Serialize, Deserialize)]
struct ErrorBody {
    error: String,
}

fn group_error_response(err: GroupError) -> Response {
    match err {
        GroupError::InvalidInput(msg) => {
            (StatusCode::BAD_REQUEST, Json(ErrorBody { error: msg })).into_response()
        }
        GroupError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: format!("group not found: {msg}"),
            }),
        )
            .into_response(),
        GroupError::Forbidden(msg) => {
            (StatusCode::FORBIDDEN, Json(ErrorBody { error: msg })).into_response()
        }
        GroupError::EpochConflict { current } => (
            StatusCode::CONFLICT,
            Json(EpochConflictBody {
                error: "epoch_conflict",
                current_epoch: *current,
            }),
        )
            .into_response(),
        GroupError::PaymentNonceUsed => (
            StatusCode::PAYMENT_REQUIRED,
            Json(PaymentErrorBody {
                error: "group_payment_invalid",
                reason: "nonce_used",
                detail: GroupError::PaymentNonceUsed.to_string(),
            }),
        )
            .into_response(),
        GroupError::Underpaid { .. } => (
            StatusCode::PAYMENT_REQUIRED,
            Json(PaymentErrorBody {
                error: "group_payment_invalid",
                reason: "underpaid",
                detail: err.to_string(),
            }),
        )
            .into_response(),
        GroupError::WritePriceConflict { current } => (
            StatusCode::CONFLICT,
            Json(WritePriceConflictBody {
                error: "write_price_conflict",
                current: *current,
            }),
        )
            .into_response(),
        GroupError::WritePriceBelowMinimum { minimum } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(WritePriceBelowMinimumBody {
                error: "write_price_below_minimum",
                min_price_wei: minimum.to_string(),
            }),
        )
            .into_response(),
        GroupError::PaymentAlreadyUsed => (
            StatusCode::PAYMENT_REQUIRED,
            Json(PaymentErrorBody {
                error: "group_payment_invalid",
                reason: "already_used",
                detail: GroupError::PaymentAlreadyUsed.to_string(),
            }),
        )
            .into_response(),
        // The upstream relay could not be reached or answered unreadably: a gateway failure, never
        // a 4xx, so a writer cannot mistake it for the host's refusal.
        GroupError::Upstream(msg) => {
            (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: msg })).into_response()
        }
        GroupError::UpstreamTimeout(msg) => {
            (StatusCode::GATEWAY_TIMEOUT, Json(ErrorBody { error: msg })).into_response()
        }
        GroupError::Storage(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody { error: msg }),
        )
            .into_response(),
        GroupError::LargeValue(error) => {
            // The detail may name the object store endpoint, bucket and key: log, never echo.
            tracing::warn!("group large-value store: {error}");
            let (status, code) = match error {
                LargeValueError::Corrupt(_) | LargeValueError::NamespaceClaimed(_) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, "group_storage_error")
                }
                _ => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "group_large_value_store_unavailable",
                ),
            };
            (status, Json(ErrorBody { error: code.into() })).into_response()
        }
        // Both are retryable with the same request. A commit-unknown write may already be
        // stored, so the client must resend the same envelope or frame, never a new one.
        GroupError::CommitUnknown(_) => retryable_unavailable("group_commit_unknown"),
        GroupError::StorageTimedOut => retryable_unavailable("group_storage_timeout"),
    }
}

/// `503` with a stable error code and `Retry-After: 1`.
fn retryable_unavailable(code: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
        Json(ErrorBody { error: code.into() }),
    )
        .into_response()
}

fn is_cbor_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().contains("cbor"))
}

fn decode_epoch_frame(headers: &HeaderMap, body: &[u8]) -> Result<GroupEpochFrame, GroupError> {
    if is_cbor_content_type(headers) {
        GroupEpochFrame::from_cbor_bytes(body)
    } else {
        serde_json::from_slice::<GroupEpochFrame>(body)
            .map_err(|e| GroupError::InvalidInput(format!("invalid GroupEpochFrame JSON: {e}")))
    }
}

fn decode_write_request(headers: &HeaderMap, body: &[u8]) -> Result<GroupWriteRequest, GroupError> {
    if is_cbor_content_type(headers) {
        GroupWriteRequest::from_cbor_bytes(body)
    } else {
        serde_json::from_slice::<GroupWriteRequest>(body).map_err(|e| {
            GroupError::InvalidInput(format!("invalid GroupMessageEnvelope JSON: {e}"))
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct WritePriceConflictBody {
    error: &'static str,
    current: GroupWritePrice,
}

#[derive(Debug, Serialize, Deserialize)]
struct WritePriceBelowMinimumBody {
    error: &'static str,
    min_price_wei: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PaymentErrorBody {
    error: &'static str,
    reason: &'static str,
    detail: String,
}

/// A write refused for its payment: `402`, nothing stored and no sequence consumed.
fn payment_refusal_response(refusal: GroupWriteRefusal) -> Response {
    match refusal {
        GroupWriteRefusal::Group(error) => group_error_response(error),
        GroupWriteRefusal::StaleNonce => (
            StatusCode::PAYMENT_REQUIRED,
            Json(PaymentErrorBody {
                error: "group_payment_unfunded",
                reason: "stale_nonce",
                detail: "the payer has already used this payment's nonce, so it can never land"
                    .into(),
            }),
        )
            .into_response(),
        GroupWriteRefusal::NotReady(reason) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, HeaderValue::from_static("5"))],
            Json(PaymentErrorBody {
                error: "group_payment_not_ready",
                reason,
                detail: "the node does not show yet that this payment can land: its nonce is too \
                         far ahead of the payer's, or the payer's balance does not cover it; \
                         retry the same write"
                    .into(),
            }),
        )
            .into_response(),
        GroupWriteRefusal::CheckUnavailable(detail) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, HeaderValue::from_static("5"))],
            Json(PaymentErrorBody {
                error: "group_payment_check_unavailable",
                reason: "node_unavailable",
                detail,
            }),
        )
            .into_response(),
        GroupWriteRefusal::Payment(error) => (
            StatusCode::PAYMENT_REQUIRED,
            Json(PaymentErrorBody {
                error: "group_payment_invalid",
                reason: error.reason(),
                detail: error.to_string(),
            }),
        )
            .into_response(),
    }
}

fn payment_required_response() -> Response {
    (
        StatusCode::PAYMENT_REQUIRED,
        Json(PaymentErrorBody {
            error: "group_payment_required",
            reason: "missing",
            detail:
                "every new group write carries a payment; see GET /groups/:group_id/write-policy"
                    .into(),
        }),
    )
        .into_response()
}

fn group_writes_unavailable_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorBody {
            error: "group_writes_unavailable".into(),
        }),
    )
        .into_response()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// A request to the upstream relay that got no response.
fn upstream_send_error(error: reqwest::Error) -> GroupError {
    if error.is_timeout() {
        GroupError::UpstreamTimeout(format!("upstream relay timed out: {error}"))
    } else {
        GroupError::Upstream(format!("upstream relay unreachable: {error}"))
    }
}

fn validate_upstream_url(raw: &str) -> Result<String, GroupError> {
    let parsed = url::Url::parse(raw)
        .map_err(|error| GroupError::InvalidInput(format!("invalid upstream URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(GroupError::InvalidInput(
            "upstream must be an http(s) origin without credentials, path, query or fragment"
                .into(),
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn public_upstream_ip(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        std::net::IpAddr::V6(ip) => {
            let parts = ip.segments();
            // Native global unicast only: excludes mapped IPv4, NAT64, ULA and link-local.
            (parts[0] & 0xe000) == 0x2000
                && parts[0] != 0x2002
                && !(parts[0] == 0x2001 && (parts[1] < 0x0200 || parts[1] == 0x0db8))
                && !(parts[0] == 0x3fff && parts[1] < 0x1000)
        }
    }
}

async fn upstream_transport(
    store: &GroupStore,
    group_id: &str,
    raw: &str,
) -> Result<(String, reqwest::Client), GroupError> {
    let upstream = validate_upstream_url(raw)?;
    let owned_group_id = group_id.to_owned();
    let (mirror, local_epoch) = on_store(store, move |store| {
        Ok((
            store.get_mirror_state(&owned_group_id)?,
            store.get_current_epoch(&owned_group_id)?,
        ))
    })
    .await?;
    match mirror {
        Some(state) if state.upstream_relay != upstream => {
            return Err(GroupError::Forbidden(
                "upstream conflicts with established group ownership".into(),
            ))
        }
        None if local_epoch.is_some() => {
            return Err(GroupError::Forbidden(
                "local group does not accept foreign routing".into(),
            ))
        }
        _ => {}
    }
    let parsed =
        url::Url::parse(&upstream).map_err(|error| GroupError::InvalidInput(error.to_string()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| GroupError::InvalidInput("missing upstream host".into()))?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| GroupError::InvalidInput("missing upstream port".into()))?;
    let addresses: Vec<_> = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| GroupError::UpstreamTimeout("upstream DNS lookup timed out".into()))?
    .map_err(|error| GroupError::Upstream(format!("upstream DNS lookup failed: {error}")))?
    .collect();
    if addresses.is_empty()
        || addresses.iter().any(|address| {
            // Rust router tests explicitly use loopback fixtures; production binaries have no exception.
            #[cfg(test)]
            if address.ip().is_loopback() {
                return false;
            }
            !public_upstream_ip(address.ip())
        })
    {
        return Err(GroupError::Forbidden(
            "upstream must resolve exclusively to public addresses".into(),
        ));
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .resolve(host, addresses[0])
        .build()
        .map_err(|error| GroupError::Storage(format!("upstream client failed: {error}")))?;
    Ok((upstream, client))
}

// Eight maximum-size ciphertexts fit the 20 MiB decoded JSON budget. Returning a
// smaller page preserves cursor progress even for a backlog of maximum-size messages.
const UPSTREAM_PAGE_LIMIT: u16 = 8;
const UPSTREAM_BATCH_BUDGET: usize = 20 * 1024 * 1024;
const UPSTREAM_EPOCH_BUDGET: usize = 1024 * 1024;
const UPSTREAM_MESSAGE_BUDGET: usize = 3 * 1024 * 1024;

async fn read_upstream_body(
    response: reqwest::Response,
    budget: usize,
) -> Result<Vec<u8>, GroupError> {
    read_upstream_body_before(response, budget, std::time::Duration::from_secs(15)).await
}

async fn read_upstream_body_before(
    mut response: reqwest::Response,
    budget: usize,
    deadline: std::time::Duration,
) -> Result<Vec<u8>, GroupError> {
    let budget = if response.status().is_success() {
        budget
    } else {
        budget.min(64 * 1024)
    };
    tokio::time::timeout(deadline, async move {
        if response
            .content_length()
            .is_some_and(|length| length > budget as u64)
        {
            return Err(GroupError::Upstream(
                "upstream response exceeds body budget".into(),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| GroupError::Upstream(format!("upstream body failed: {error}")))?
        {
            if chunk.len() > budget.saturating_sub(body.len()) {
                return Err(GroupError::Upstream(
                    "upstream response exceeds body budget".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
    .map_err(|_| GroupError::UpstreamTimeout("upstream body deadline exceeded".into()))?
}

/// Largest group message request body: a JSON envelope carrying the largest ciphertext
/// (1 MiB, 2 MiB as hex) plus its other fields. Axum's default 2 MB extractor limit is below
/// that, so the message routes read their bodies themselves with this bound.
const MAX_GROUP_MESSAGE_BODY: usize = 2 * 1024 * 1024 + 64 * 1024;

/// Read a group message request body, or answer 413 once it exceeds
/// [`MAX_GROUP_MESSAGE_BODY`].
async fn read_message_body(mut body: axum::body::Body) -> Result<Bytes, Response> {
    use axum::body::HttpBody;
    let too_large = || {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorBody {
                error: "group message body too large".into(),
            }),
        )
            .into_response()
    };
    if body.size_hint().lower() > MAX_GROUP_MESSAGE_BODY as u64 {
        return Err(too_large());
    }
    let mut collected = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|error| {
            group_error_response(GroupError::InvalidInput(format!(
                "reading request body: {error}"
            )))
        })?;
        if chunk.len() > MAX_GROUP_MESSAGE_BODY - collected.len() {
            return Err(too_large());
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(collected))
}

/// Build the `/groups/:group_id/*` router using the server's `Registry` group store.
pub fn router() -> Router {
    Router::new()
        .route("/groups/:group_id/live", routing::get(live::handle_live))
        .route(
            "/groups/:group_id/epochs",
            routing::put(handle_put_group_epoch).get(handle_get_group_epoch),
        )
        .route(
            "/groups/:group_id/messages",
            routing::put(handle_put_group_message).get(handle_get_group_messages),
        )
        .route(
            "/groups/:group_id/write-policy",
            routing::get(handle_get_write_policy),
        )
        .route(
            "/groups/:group_id/write-price",
            routing::put(handle_put_write_price),
        )
}

/// Standalone router backed directly by a [`GroupStore`] (convenient for isolated unit/integration
/// tests), taking group writes priced and paid as `writes` says.
pub fn router_with_store(store: GroupStore, writes: std::sync::Arc<GroupWriteRuntime>) -> Router {
    Router::new()
        .route(
            "/groups/:group_id/live",
            routing::get(live::handle_live_store),
        )
        .route(
            "/groups/:group_id/epochs",
            routing::put(handle_put_group_epoch_store).get(handle_get_group_epoch_store),
        )
        .route(
            "/groups/:group_id/messages",
            routing::put(handle_put_group_message_store).get(handle_get_group_messages_store),
        )
        .route(
            "/groups/:group_id/write-policy",
            routing::get(handle_get_write_policy_store),
        )
        .route(
            "/groups/:group_id/write-price",
            routing::put(handle_put_write_price_store),
        )
        .layer(Extension(store))
        .layer(Extension(Some(writes)))
        .layer(Extension(
            std::sync::Arc::new(crate::events::StandaloneEventBus::new())
                as std::sync::Arc<dyn crate::events::RelayEventBus>,
        ))
}

/// Run one store call on a blocking worker. Every call waits on RocksDB or on FoundationDB
/// futures, so none runs on an async worker.
async fn on_store<T, F>(store: &GroupStore, call: F) -> Result<T, GroupError>
where
    T: Send + 'static,
    F: FnOnce(&GroupStore) -> Result<T, GroupError> + Send + 'static,
{
    let store = store.clone();
    tokio::task::spawn_blocking(move || call(&store))
        .await
        .map_err(|error| GroupError::Storage(error.to_string()))?
}

/// The first group request opens the store on disk; that blocking open stays off the runtime.
async fn registry_group_store(server: &RegistryServer) -> Result<GroupStore, GroupError> {
    let registry = server.registry.clone();
    tokio::task::spawn_blocking(move || registry.groups())
        .await
        .map_err(|e| GroupError::Storage(e.to_string()))?
}

async fn handle_put_group_epoch(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    body: Bytes,
) -> Response {
    let bus = server.event_bus().clone();
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    let response = put_group_epoch_impl(store, group_id.clone(), headers, body).await;
    if response.status().is_success() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            bus.publish_group_wakeup(&group_id.to_lowercase()),
        )
        .await;
    }
    response
}

async fn handle_put_group_epoch_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    Extension(bus): Extension<std::sync::Arc<dyn crate::events::RelayEventBus>>,
    body: Bytes,
) -> Response {
    let response = put_group_epoch_impl(store, group_id.clone(), headers, body).await;
    if response.status().is_success() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            bus.publish_group_wakeup(&group_id.to_lowercase()),
        )
        .await;
    }
    response
}

async fn put_group_epoch_impl(
    store: GroupStore,
    group_id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }
    let frame = match decode_epoch_frame(&headers, &body) {
        Ok(f) => f,
        Err(e) => return group_error_response(e),
    };

    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let url = format!("{upstream}/groups/{group_id}/epochs");
        let payload = serde_json::to_vec(&frame).unwrap_or_default();
        let resp = match client
            .put(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return group_error_response(upstream_send_error(e)),
        };
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let resp_bytes = match read_upstream_body(resp, UPSTREAM_EPOCH_BUDGET).await {
            Ok(body) => body,
            Err(error) => return group_error_response(error),
        };
        if status.is_success() {
            if let Ok(committed) = serde_json::from_slice::<GroupEpochFrame>(&resp_bytes) {
                let group_id = group_id.clone();
                let _ = on_store(&store, move |store| {
                    if let Some(mirror) = store.get_mirror_state(&group_id)? {
                        if mirror.mirrored {
                            store.ingest_mirrored_upstream(&group_id, Some(committed), &[])?;
                        }
                    }
                    Ok(())
                })
                .await;
            }
        }
        return (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            resp_bytes,
        )
            .into_response();
    }

    match on_store(&store, move |store| store.put_epoch(&group_id, frame)).await {
        Ok(committed) => (StatusCode::OK, Json(committed)).into_response(),
        Err(e) => group_error_response(e),
    }
}

async fn handle_get_group_epoch(
    Path(group_id): Path<String>,
    Query(query): Query<EpochQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Response {
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    get_group_epoch_impl(store, group_id, query, headers).await
}

async fn handle_get_group_epoch_store(
    Path(group_id): Path<String>,
    Query(query): Query<EpochQuery>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
) -> Response {
    get_group_epoch_impl(store, group_id, query, headers).await
}

async fn fetch_verified_epoch(
    client: &reqwest::Client,
    upstream: &str,
    group_id: &str,
    epoch: Option<u64>,
) -> Result<GroupEpochFrame, GroupError> {
    let mut url = format!("{upstream}/groups/{group_id}/epochs");
    if let Some(epoch) = epoch {
        url.push_str(&format!("?epoch={epoch}"));
    }
    let response = client
        .get(&url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| GroupError::Upstream(format!("upstream epoch fetch failed: {error}")))?;
    let bytes = read_upstream_body(response, UPSTREAM_EPOCH_BUDGET).await?;
    let frame: GroupEpochFrame = serde_json::from_slice(&bytes)
        .map_err(|error| GroupError::Upstream(format!("invalid upstream epoch JSON: {error}")))?;
    let frame = frame.normalized()?;
    frame.verify_authority(group_id)?;
    if epoch.is_some_and(|requested| frame.epoch != requested) {
        return Err(GroupError::Forbidden(
            "upstream epoch does not match requested epoch".into(),
        ));
    }
    Ok(frame)
}

async fn get_group_epoch_impl(
    store: GroupStore,
    group_id: String,
    query: EpochQuery,
    headers: HeaderMap,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }

    let requested_upstream = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY).map(str::to_owned);
    let upstream = if query.epoch.is_none() && requested_upstream.is_none() {
        let group_id = group_id.clone();
        match on_store(&store, move |store| store.get_mirror_state(&group_id)).await {
            Ok(state) => state.map(|state| state.upstream_relay),
            Err(error) => return group_error_response(error),
        }
    } else {
        requested_upstream
    };
    // Historical certificates are immutable, but a foreign "latest" read must reach
    // its trusted authority. Serving the mirror's stale head can prevent clients from
    // accepting a valid successor epoch and ever reaching message synchronization.
    if query.epoch.is_some() || upstream.is_none() {
        let (owned_group_id, requested) = (group_id.clone(), query.epoch);
        let local_epoch = on_store(&store, move |store| match requested {
            Some(epoch) => store.get_epoch(&owned_group_id, epoch),
            None => store.get_current_epoch(&owned_group_id),
        })
        .await;
        match local_epoch {
            Ok(Some(frame)) => return (StatusCode::OK, Json(frame)).into_response(),
            Err(error) => return group_error_response(error),
            Ok(None) => {}
        }
    }
    if let Some(upstream_raw) = upstream {
        let (upstream, client) = match upstream_transport(&store, &group_id, &upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let mut url = format!("{upstream}/groups/{group_id}/epochs");
        if let Some(e) = query.epoch {
            url.push_str(&format!("?epoch={e}"));
        }
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return group_error_response(upstream_send_error(e)),
        };
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let resp_bytes = match read_upstream_body(resp, UPSTREAM_EPOCH_BUDGET).await {
            Ok(body) => body,
            Err(error) => return group_error_response(error),
        };
        if status.is_success() {
            let frame = match serde_json::from_slice::<GroupEpochFrame>(&resp_bytes) {
                Ok(frame) => match frame.normalized() {
                    Ok(frame) => frame,
                    Err(error) => return group_error_response(error),
                },
                Err(error) => {
                    return group_error_response(GroupError::Upstream(format!(
                        "invalid upstream epoch JSON: {error}"
                    )))
                }
            };
            if let Err(error) = frame.verify_authority(&group_id) {
                return group_error_response(error);
            }
            if query.epoch.is_some_and(|epoch| epoch != frame.epoch) {
                return group_error_response(GroupError::Forbidden(
                    "upstream returned a different historical epoch".into(),
                ));
            }
            return (status, Json(frame)).into_response();
        }
        return (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            resp_bytes,
        )
            .into_response();
    }

    group_error_response(GroupError::NotFound(group_id))
}

async fn handle_put_group_message(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    RawBody(body): RawBody,
) -> Response {
    let body = match read_message_body(body).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let bus = server.event_bus().clone();
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    let writes = server.group_writes.clone();
    let response = put_group_message_impl(store, writes, group_id.clone(), headers, body).await;
    if response.status().is_success()
        && response
            .headers()
            .get(HEADER_GROUP_APPEND)
            .and_then(|v| v.to_str().ok())
            == Some("appended")
    {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            bus.publish_group_wakeup(&group_id.to_lowercase()),
        )
        .await;
    }
    response
}

async fn handle_put_group_message_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    Extension(writes): Extension<Option<std::sync::Arc<GroupWriteRuntime>>>,
    Extension(bus): Extension<std::sync::Arc<dyn crate::events::RelayEventBus>>,
    RawBody(body): RawBody,
) -> Response {
    let body = match read_message_body(body).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let response = put_group_message_impl(store, writes, group_id.clone(), headers, body).await;
    if response.status().is_success()
        && response
            .headers()
            .get(HEADER_GROUP_APPEND)
            .and_then(|v| v.to_str().ok())
            == Some("appended")
    {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            bus.publish_group_wakeup(&group_id.to_lowercase()),
        )
        .await;
    }
    response
}

async fn put_group_message_impl(
    store: GroupStore,
    writes: Option<std::sync::Arc<GroupWriteRuntime>>,
    group_id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }
    let request = match decode_write_request(&headers, &body) {
        Ok(request) => request,
        Err(e) => return group_error_response(e),
    };

    // If this group is hosted on a foreign upstream relay, proxy the write server-to-server
    // so the foreign relay only ever sees the Home Relay's IP. Only the host verifies the
    // payment: it pays the host, under the host's policy.
    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let url = format!("{upstream}/groups/{group_id}/messages");
        let payload = serde_json::to_vec(&request).unwrap_or_default();
        let resp = match client
            .put(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return group_error_response(upstream_send_error(e)),
        };
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let disposition = match resp
            .headers()
            .get(HEADER_GROUP_APPEND)
            .and_then(|value| value.to_str().ok())
        {
            Some("appended") => "appended",
            Some("existing") => "existing",
            _ if status.is_success() => {
                return group_error_response(GroupError::Upstream(
                    "upstream omitted valid append disposition".into(),
                ))
            }
            _ => "existing",
        };
        let resp_bytes = match read_upstream_body(resp, UPSTREAM_MESSAGE_BUDGET).await {
            Ok(body) => body,
            Err(error) => return group_error_response(error),
        };
        // A write acknowledgement is not a contiguous mailbox sync. Caching its row
        // or advancing the mirror watermark could expose N+10 before unseen N+1..N+9.
        // Let the next ordered upstream read import this message with the intervening rows.
        return (
            status,
            [
                (
                    header::HeaderName::from_static(HEADER_GROUP_APPEND),
                    HeaderValue::from_static(disposition),
                ),
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                ),
                (
                    header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
                    HeaderValue::from_static("proxy"),
                ),
            ],
            resp_bytes,
        )
            .into_response();
    }

    // A retry of a write this relay already accepted gets its original receipt before its
    // payment is looked at: the receipt stands whatever the price or payee is now, and nothing
    // is handed to the chain again.
    let GroupWriteRequest { envelope, payment } = request;
    let receipt = {
        let (group_id, envelope) = (group_id.clone(), envelope.clone());
        on_store(&store, move |store| {
            store.accepted_receipt(&group_id, envelope)
        })
        .await
    };
    match receipt {
        Ok(Some(message)) => return local_write_response(false, message),
        Ok(None) => {}
        Err(e) => return group_error_response(e),
    }
    // A new write to a group hosted here pays this relay. Every check reads only the request and
    // the policy, and all of them run before anything is stored or any sequence is allocated.
    let Some(writes) = writes else {
        return group_writes_unavailable_response();
    };
    let Some(payment) = payment else {
        return payment_required_response();
    };
    // The group's price as it stands now. The accept transaction checks it again, so a price
    // change that commits first refuses this write before its payment is handed to anyone.
    let creator_price = {
        let group_id = group_id.clone();
        on_store(&store, move |store| store.get_write_price(&group_id)).await
    };
    let creator_price = match creator_price {
        Ok(price) => price,
        Err(e) => return group_error_response(e),
    };
    let verified = match writes.verify(&group_id, &envelope, &payment, creator_price.as_ref()) {
        Ok(verified) => verified,
        // Below the price read above. `underpaid` is final for the writer, so it is answered
        // only from a transaction that finds no acceptance of this write and records the
        // payment as refused: a stalled earlier attempt of the same write can then never
        // commit with it.
        Err(GroupWriteRefusal::Payment(GroupPaymentError::Underpaid {
            required,
            actual,
            tx_hash,
        })) => {
            let refused = {
                let group_id = group_id.clone();
                on_store(&store, move |store| {
                    store.refuse_underpaid(&group_id, envelope, tx_hash, required, actual)
                })
                .await
            };
            return match refused {
                Ok(outcome) => local_write_response(false, outcome.message),
                Err(e) => group_error_response(e),
            };
        }
        Err(refusal) => return payment_refusal_response(refusal),
    };
    // The payment must be able to land now; the node is asked before anything is stored.
    if let Err(refusal) = writes.check_funded(&verified).await {
        return payment_refusal_response(refusal);
    }
    // The payment's record is written in the write's acceptance transaction, so one payment
    // funds one write even when replicas race.
    let fact = writes.fact(&verified);
    let min_price_wei = writes.policy().min_price_wei;
    let accepted = {
        let group_id = group_id.clone();
        on_store(&store, move |store| {
            store.put_paid_message(&group_id, envelope, &fact, min_price_wei)
        })
        .await
    };
    let outcome = match accepted {
        Ok(outcome) => outcome,
        Err(e) => return group_error_response(e),
    };
    // The write is committed. Only now may its payment reach the chain. A write accepted
    // meanwhile by a racing request is answered with the original receipt and hands nothing
    // over: a different payment presented with it would be a second payment for one write.
    if outcome.appended {
        writes.broadcast(&group_id, &verified).await;
    }
    local_write_response(outcome.appended, outcome.message)
}

fn local_write_response(appended: bool, message: StoredGroupMessage) -> Response {
    (
        StatusCode::OK,
        [
            (
                header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
                HeaderValue::from_static("local"),
            ),
            (
                header::HeaderName::from_static(HEADER_GROUP_APPEND),
                HeaderValue::from_static(if appended { "appended" } else { "existing" }),
            ),
        ],
        Json(message),
    )
        .into_response()
}

async fn handle_get_group_messages(
    Path(group_id): Path<String>,
    Query(query): Query<GroupMessagesQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Response {
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    get_group_messages_impl(store, group_id, query, headers).await
}

async fn handle_get_group_messages_store(
    Path(group_id): Path<String>,
    Query(query): Query<GroupMessagesQuery>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
) -> Response {
    get_group_messages_impl(store, group_id, query, headers).await
}

/// Check the read token against the current epoch, then read one page, on a blocking worker.
async fn read_local_page(
    store: &GroupStore,
    group_id: &str,
    read_token: &str,
    after_seq: u64,
    limit: u16,
) -> Result<(GroupEpochFrame, Vec<StoredGroupMessage>), GroupError> {
    let (group_id, read_token) = (group_id.to_owned(), read_token.to_owned());
    on_store(store, move |store| {
        let current_epoch = store.verify_read_token(&group_id, &read_token)?;
        let messages = store.list_messages(&group_id, after_seq, limit)?;
        Ok((current_epoch, messages))
    })
    .await
}

async fn get_group_messages_impl(
    store: GroupStore,
    group_id: String,
    query: GroupMessagesQuery,
    headers: HeaderMap,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }

    let Some(read_token) = header_str(&headers, HEADER_GROUP_READ_TOKEN) else {
        return group_error_response(GroupError::Forbidden(
            "missing X-Group-Read-Token header".into(),
        ));
    };

    let after_seq = query.after_seq.unwrap_or(0);
    let limit = query.limit.unwrap_or(100).clamp(1, 500);

    // Check if the caller specified an upstream relay for a foreign group
    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        // A successful response alone cannot authenticate a caller-chosen server: verify
        // the read capability against its root-signed certificate before forwarding it.
        let upstream_epoch = match fetch_verified_epoch(&client, &upstream, &group_id, None).await {
            Ok(frame) => frame,
            Err(error) => return group_error_response(error),
        };
        if let Err(error) = upstream_epoch.verify_read_token(read_token) {
            return group_error_response(error);
        }
        let owned_group_id = group_id.clone();
        match on_store(&store, move |store| {
            store.get_current_epoch(&owned_group_id)
        })
        .await
        {
            Ok(Some(current))
                if current.epoch > upstream_epoch.epoch
                    || (current.epoch == upstream_epoch.epoch
                        && current.epoch_hash != upstream_epoch.epoch_hash) =>
            {
                return group_error_response(GroupError::Forbidden(
                    "upstream epoch is older than trusted local state".into(),
                ))
            }
            Err(error) => return group_error_response(error),
            _ => {}
        }
        let upstream_limit = limit.min(UPSTREAM_PAGE_LIMIT);
        let url = format!(
            "{upstream}/groups/{group_id}/messages?after_seq={after_seq}&limit={upstream_limit}"
        );
        let response = match client
            .get(&url)
            .header(HEADER_GROUP_READ_TOKEN, read_token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return group_error_response(GroupError::Upstream(format!(
                    "upstream read failed: {error}"
                )))
            }
        };
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = match read_upstream_body(response, UPSTREAM_BATCH_BUDGET).await {
            Ok(bytes) => bytes,
            Err(error) => return group_error_response(error),
        };
        if !status.is_success() {
            return (status, bytes).into_response();
        }
        let mut upstream_body: GroupMessagesResponse = match serde_json::from_slice(&bytes) {
            Ok(body) => body,
            Err(error) => {
                return group_error_response(GroupError::Upstream(format!(
                    "invalid upstream read JSON: {error}"
                )))
            }
        };
        if upstream_body.group_id != group_id || upstream_body.epoch != upstream_epoch.epoch {
            return group_error_response(GroupError::Forbidden(
                "upstream response does not match authenticated group epoch".into(),
            ));
        }
        let (owned_group_id, owned_upstream, subscriber_tag, owned_epoch, owned_token) = (
            group_id.clone(),
            upstream.clone(),
            header_str(&headers, HEADER_GROUP_SUBSCRIBER_TAG).map(str::to_owned),
            upstream_epoch.clone(),
            read_token.to_owned(),
        );
        let mirror_state = match on_store(&store, move |store| {
            store.record_foreign_subscriber(
                &owned_group_id,
                &owned_upstream,
                subscriber_tag.as_deref(),
                &owned_epoch,
                &owned_token,
            )
        })
        .await
        {
            Ok(state) => state,
            Err(error) => return group_error_response(error),
        };
        if !mirror_state.mirrored {
            upstream_body.mode = "proxy".to_string();
            upstream_body.subscriber_count = mirror_state.subscribers.len();
            return (
                StatusCode::OK,
                [(
                    header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
                    HeaderValue::from_static("proxy"),
                )],
                Json(upstream_body),
            )
                .into_response();
        }

        // `>= mirror_threshold` local subscribers: Auto-Mirror Promotion!
        // Sync latest epoch & incremental messages from upstream into local `GroupStore`.
        let sync_url = format!(
            "{}/groups/{}/messages?after_seq={}&limit={}",
            mirror_state.upstream_relay,
            group_id,
            mirror_state.last_synced_seq,
            UPSTREAM_PAGE_LIMIT
        );
        let upstream_msgs_resp = match client
            .get(&sync_url)
            .header(HEADER_GROUP_READ_TOKEN, read_token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return group_error_response(GroupError::Upstream(format!(
                    "upstream mirror sync error: {e}"
                )))
            }
        };
        if !upstream_msgs_resp.status().is_success() {
            let status = StatusCode::from_u16(upstream_msgs_resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let body = match read_upstream_body(upstream_msgs_resp, UPSTREAM_BATCH_BUDGET).await {
                Ok(body) => body,
                Err(error) => return group_error_response(error),
            };
            return (
                status,
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/json"),
                )],
                body,
            )
                .into_response();
        }
        let synced_bytes = match read_upstream_body(upstream_msgs_resp, UPSTREAM_BATCH_BUDGET).await
        {
            Ok(body) => body,
            Err(error) => return group_error_response(error),
        };
        let synced_batch: GroupMessagesResponse = match serde_json::from_slice(&synced_bytes) {
            Ok(b) => b,
            Err(e) => {
                return group_error_response(GroupError::Upstream(format!(
                    "invalid upstream mirror sync JSON: {e}"
                )))
            }
        };
        // Backlogs can span rotations: authenticate each historical write key with its root certificate.
        let historical_epochs: std::collections::BTreeSet<u64> = synced_batch
            .messages
            .iter()
            .map(|message| message.epoch)
            .filter(|epoch| *epoch != upstream_epoch.epoch)
            .collect();
        for epoch in historical_epochs {
            let owned_group_id = group_id.clone();
            match on_store(&store, move |store| store.get_epoch(&owned_group_id, epoch)).await {
                Ok(Some(_)) => continue,
                Err(error) => return group_error_response(error),
                Ok(None) => {}
            }
            let frame = match fetch_verified_epoch(
                &client,
                &mirror_state.upstream_relay,
                &group_id,
                Some(epoch),
            )
            .await
            {
                Ok(frame) => frame,
                Err(error) => return group_error_response(error),
            };
            let owned_group_id = group_id.clone();
            if let Err(error) = on_store(&store, move |store| {
                store.ingest_mirrored_upstream(&owned_group_id, Some(frame), &[])
            })
            .await
            {
                return group_error_response(error);
            }
        }
        let owned_group_id = group_id.clone();
        if let Err(e) = on_store(&store, move |store| {
            store.ingest_mirrored_upstream(
                &owned_group_id,
                Some(upstream_epoch),
                &synced_batch.messages,
            )
        })
        .await
        {
            return group_error_response(e);
        }

        // Serve directly from the local mirrored GroupStore!
        let (current_epoch, messages) =
            match read_local_page(&store, &group_id, read_token, after_seq, limit).await {
                Ok(page) => page,
                Err(e) => return group_error_response(e),
            };
        let next_after_seq = messages.last().map(|m| m.server_seq).unwrap_or(after_seq);
        return (
            StatusCode::OK,
            [(
                header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
                HeaderValue::from_static("mirrored"),
            )],
            Json(GroupMessagesResponse {
                group_id,
                epoch: current_epoch.epoch,
                messages,
                next_after_seq,
                mode: "mirrored".to_string(),
                subscriber_count: mirror_state.subscribers.len(),
            }),
        )
            .into_response();
    }

    // Authoritative local group read path
    let (current_epoch, messages) =
        match read_local_page(&store, &group_id, read_token, after_seq, limit).await {
            Ok(page) => page,
            Err(e) => return group_error_response(e),
        };
    let next_after_seq = messages.last().map(|m| m.server_seq).unwrap_or(after_seq);
    (
        StatusCode::OK,
        [(
            header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
            HeaderValue::from_static("local"),
        )],
        Json(GroupMessagesResponse {
            group_id,
            epoch: current_epoch.epoch,
            messages,
            next_after_seq,
            mode: "local".to_string(),
            subscriber_count: 0,
        }),
    )
        .into_response()
}

async fn handle_get_write_policy(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Response {
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    get_write_policy_impl(store, server.group_writes.clone(), group_id, headers).await
}

async fn handle_get_write_policy_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    Extension(writes): Extension<Option<std::sync::Arc<GroupWriteRuntime>>>,
) -> Response {
    get_write_policy_impl(store, writes, group_id, headers).await
}

/// The hosting relay's policy for writes to `group_id`: this relay's own, or the upstream's
/// when the caller names one.
async fn get_write_policy_impl(
    store: GroupStore,
    writes: Option<std::sync::Arc<GroupWriteRuntime>>,
    group_id: String,
    headers: HeaderMap,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }
    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let response = match client
            .get(format!("{upstream}/groups/{group_id}/write-policy"))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return group_error_response(upstream_send_error(error)),
        };
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = match read_upstream_body(response, UPSTREAM_EPOCH_BUDGET).await {
            Ok(bytes) => bytes,
            Err(error) => return group_error_response(error),
        };
        if !status.is_success() {
            return (status, bytes).into_response();
        }
        return match serde_json::from_slice::<GroupWritePolicyBody>(&bytes) {
            Ok(body) => (StatusCode::OK, Json(body)).into_response(),
            Err(error) => group_error_response(GroupError::Upstream(format!(
                "invalid upstream write policy: {error}"
            ))),
        };
    }
    let Some(writes) = writes else {
        return group_writes_unavailable_response();
    };
    let creator_price = {
        let group_id = group_id.clone();
        on_store(&store, move |store| store.get_write_price(&group_id)).await
    };
    match creator_price {
        Ok(creator) => (StatusCode::OK, Json(writes.body(creator.as_ref()))).into_response(),
        Err(error) => group_error_response(error),
    }
}

async fn handle_put_write_price(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    body: Bytes,
) -> Response {
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    put_write_price_impl(store, server.group_writes.clone(), group_id, headers, body).await
}

async fn handle_put_write_price_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    Extension(writes): Extension<Option<std::sync::Arc<GroupWriteRuntime>>>,
    body: Bytes,
) -> Response {
    put_write_price_impl(store, writes, group_id, headers, body).await
}

/// Set or change a group's write price: on this relay when it hosts the group, or on the
/// upstream the caller names.
async fn put_write_price_impl(
    store: GroupStore,
    writes: Option<std::sync::Arc<GroupWriteRuntime>>,
    group_id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }
    let record = match serde_json::from_slice::<GroupWritePrice>(&body) {
        Ok(record) => record,
        Err(error) => {
            return group_error_response(GroupError::InvalidInput(format!(
                "invalid write price JSON: {error}"
            )))
        }
    };
    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let response = match client
            .put(format!("{upstream}/groups/{group_id}/write-price"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&record).unwrap_or_default())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return group_error_response(upstream_send_error(error)),
        };
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = match read_upstream_body(response, UPSTREAM_EPOCH_BUDGET).await {
            Ok(bytes) => bytes,
            Err(error) => return group_error_response(error),
        };
        return (
            status,
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            bytes,
        )
            .into_response();
    }
    let Some(writes) = writes else {
        return group_writes_unavailable_response();
    };
    let (network, min_price_wei) = (
        writes.policy().network.clone(),
        writes.policy().min_price_wei,
    );
    match on_store(&store, move |store| {
        store.put_write_price(&group_id, record, &network, min_price_wei)
    })
    .await
    {
        Ok(stored) => (StatusCode::OK, Json(stored)).into_response(),
        Err(error) => group_error_response(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        groups::{derive_group_id, GroupMessageEnvelope},
        kv_store::RocksDbKvStore,
    };
    use axum::http::Request;
    use hyper::Body;
    use secp256k1_abc::{Message as SecpMessage, PublicKey, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    use std::{net::SocketAddr, sync::Arc};
    use tower::ServiceExt;

    fn keypair(seed_byte: u8) -> (SecretKey, [u8; 33]) {
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&[seed_byte; 32]).unwrap();
        let pk = PublicKey::from_secret_key(&secp, &sk).serialize();
        (sk, pk)
    }

    pub(super) fn sign_digest(sk: &SecretKey, digest: &[u8; 32]) -> String {
        let secp = Secp256k1::new();
        let msg = SecpMessage::from_slice(digest).unwrap();
        let sig = secp.sign(&msg, sk);
        hex::encode(sig.serialize_compact())
    }

    pub(super) fn signed_epoch(sk: &SecretKey, mut frame: GroupEpochFrame) -> GroupEpochFrame {
        frame.admin_sig = sign_digest(sk, &frame.compute_epoch_hash().unwrap());
        frame
    }

    /// Host origin of the oneshot routers, which have no address of their own.
    pub(super) const TEST_HOST: &str = "http://group-host.test";
    /// The test relays' minimum price, and the price of a group whose creator set none, in wei.
    pub(super) const TEST_PRICE: u128 = 1_000;
    /// The test relays' payee: the burn address, as the labs use.
    pub(super) const TEST_PAYEE: [u8; 20] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xde, 0xad,
    ];

    /// The operator section with minimum `min_price_wei` paying `payee`.
    pub(super) fn writes_conf(min_price_wei: u128, payee: &str) -> cashweb_config::GroupWritesConf {
        cashweb_config::GroupWritesConf {
            min_price_wei: min_price_wei.to_string(),
            payee: payee.into(),
        }
    }

    /// Group writes on monad-testnet paid to [`TEST_PAYEE`], hosted at `host_origin`, no node.
    pub(super) fn test_writes(host_origin: &str) -> Arc<GroupWriteRuntime> {
        Arc::new(
            GroupWriteRuntime::loopback_fixture(
                "monad-testnet",
                &writes_conf(TEST_PRICE, cashweb_config::BURN_ADDRESS_HEX),
                &host_origin.parse().unwrap(),
            )
            .unwrap(),
        )
    }

    /// The standalone router with [`test_writes`] at [`TEST_HOST`].
    pub(super) fn test_router(store: GroupStore) -> Router {
        router_with_store(store, test_writes(TEST_HOST))
    }

    /// A payment signed by a real secp256k1 key, built like the TypeScript writer builds one.
    pub(super) fn payment_tx(
        chain_id: u64,
        to: [u8; 20],
        value_wei: u128,
        network: &str,
        host_origin: &str,
        envelope: &GroupMessageEnvelope,
    ) -> GroupWritePaymentWire {
        use crate::group_write_payment::{
            group_write_calldata, group_write_commitment, GroupWriteTarget,
        };
        let target = GroupWriteTarget {
            group_id: parse_group_id_hex(&envelope.group_id.to_lowercase()).unwrap(),
            epoch: envelope.epoch,
            signing_digest: envelope.signing_digest().unwrap(),
        };
        let calldata = group_write_calldata(&group_write_commitment(network, host_origin, &target));
        let payer = bitcoinsuite_core::ecc::Ecc::seckey_from_array(
            &bitcoinsuite_ecc_secp256k1::EccSecp256k1::default(),
            [0x42; 32],
        )
        .unwrap();
        // One accepted write per payer nonce: each write's payment takes its own nonce.
        let nonce = u64::from_be_bytes(target.signing_digest[..8].try_into().unwrap()) >> 1;
        let (raw, _) = crate::monad_evm_tx::test_support::signed_eip1559_tx(
            &payer,
            chain_id,
            nonce,
            crate::monad_http::Address(to),
            value_wei,
            &calldata,
        );
        GroupWritePaymentWire {
            network: network.into(),
            raw_transaction: hex::encode(raw),
        }
    }

    /// `envelope` with the payment that pays for it on the relay hosted at `host_origin`.
    pub(super) fn paid_for(
        host_origin: &str,
        envelope: &GroupMessageEnvelope,
    ) -> GroupWriteRequest {
        GroupWriteRequest {
            envelope: envelope.clone(),
            payment: Some(payment_tx(
                10143,
                TEST_PAYEE,
                TEST_PRICE,
                "monad-testnet",
                &canonical(host_origin),
                envelope,
            )),
        }
    }

    /// `envelope` paid for on the oneshot routers' [`TEST_HOST`].
    pub(super) fn paid(envelope: &GroupMessageEnvelope) -> GroupWriteRequest {
        paid_for(TEST_HOST, envelope)
    }

    fn canonical(origin: &str) -> String {
        crate::group_write_payment::canonical_host_origin(&origin.parse().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn a_1_mib_message_is_accepted_over_http_and_a_larger_body_is_refused() {
        let store = GroupStore::new_temporary();
        let (root_sk, root_pk) = keypair(7);
        let (write_sk, write_pk) = keypair(70);
        let group_id = hex::encode(derive_group_id(&root_pk));
        store
            .put_epoch(
                &group_id,
                signed_epoch(
                    &root_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(root_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"descriptor"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        let mut message = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([1; 24]),
            ciphertext: hex::encode(vec![0xab; 1024 * 1024]),
            write_sig: String::new(),
        };
        message.write_sig = sign_digest(&write_sk, &message.signing_digest().unwrap());
        let put = |body: Vec<u8>| {
            Request::builder()
                .method("PUT")
                .uri(format!("/groups/{group_id}/messages"))
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        let body = serde_json::to_vec(&paid(&message)).unwrap();
        assert!(body.len() > 2 * 1024 * 1024, "beyond axum's default limit");
        let response = test_router(store.clone()).oneshot(put(body)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[HEADER_GROUP_APPEND], "appended");
        assert_eq!(
            store.list_messages(&group_id, 0, 10).unwrap()[0].ciphertext,
            message.ciphertext
        );
        let response = test_router(store.clone())
            .oneshot(put(vec![b' '; MAX_GROUP_MESSAGE_BODY + 1]))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn object_store_errors_are_logged_and_answered_without_endpoint_or_key() {
        use crate::store::large_values::ObjectStoreError;
        let detail = "S3 PUT http://minio.internal:9000/frank-bucket/lab/groups/sha256/ab \
                      returned HTTP 403: <Error><Code>AccessDenied</Code></Error>";
        for (error, status) in [
            (
                LargeValueError::Unavailable(ObjectStoreError(detail.into())),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                LargeValueError::Corrupt(detail.into()),
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ] {
            let response = group_error_response(GroupError::LargeValue(error));
            assert_eq!(response.status(), status);
            let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body = String::from_utf8(body.to_vec()).unwrap();
            for secret in ["minio.internal", "frank-bucket", "sha256", "AccessDenied"] {
                assert!(!body.contains(secret), "{body}");
            }
        }
    }

    #[tokio::test]
    async fn upstream_body_limits_cover_chunked_errors_and_stalled_streams() {
        use futures::StreamExt;
        let fixture = Router::new()
            .route(
                "/chunked",
                routing::get(|| async {
                    axum::body::StreamBody::new(futures::stream::iter(vec![
                        Ok::<_, std::io::Error>(Bytes::from_static(b"0123456789012345")),
                        Ok(Bytes::from_static(b"01234567890123456")),
                    ]))
                }),
            )
            .route(
                "/error",
                routing::get(|| async {
                    (
                        StatusCode::BAD_REQUEST,
                        axum::body::StreamBody::new(futures::stream::iter(vec![
                            Ok::<_, std::io::Error>(Bytes::from_static(b"0123456789012345")),
                            Ok(Bytes::from_static(b"01234567890123456")),
                        ])),
                    )
                }),
            )
            .route(
                "/stall",
                routing::get(|| async {
                    axum::body::StreamBody::new(
                        futures::stream::once(async {
                            Ok::<_, std::io::Error>(Bytes::from_static(b"ready"))
                        })
                        .chain(futures::stream::pending()),
                    )
                }),
            )
            .route(
                "/declared",
                routing::get(|| async { "012345678901234567890123456789012" }),
            )
            .route(
                "/redirect",
                routing::get(|| async {
                    (
                        StatusCode::FOUND,
                        [(header::LOCATION, "http://169.254.169.254/admin")],
                    )
                }),
            );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(fixture.into_make_service())
                .await
                .unwrap();
        });
        let (_, client) =
            upstream_transport(&GroupStore::new_temporary(), &"00".repeat(32), &origin)
                .await
                .unwrap();
        for path in ["/chunked", "/error", "/declared"] {
            let response = client.get(format!("{origin}{path}")).send().await.unwrap();
            assert!(read_upstream_body(response, 32).await.is_err(), "{path}");
        }
        let response = client.get(format!("{origin}/stall")).send().await.unwrap();
        assert!(
            read_upstream_body_before(response, 32, std::time::Duration::from_millis(30))
                .await
                .is_err()
        );
        assert_eq!(
            client
                .get(format!("{origin}/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FOUND
        );
        server.abort();
    }

    #[tokio::test]
    async fn upstream_policy_blocks_internal_addresses_and_url_reinterpretation() {
        for origin in [
            "http://127.0.0.1/admin#",
            "http://user:secret@example.com/",
            "https://example.com/?q=x",
            "https://example.com/#x",
            "file:///etc/passwd",
        ] {
            assert!(validate_upstream_url(origin).is_err());
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::a00:1",
        ] {
            assert!(!public_upstream_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_upstream_ip("8.8.8.8".parse().unwrap()));
        assert!(public_upstream_ip("2606:4700:4700::1111".parse().unwrap()));
        let app = test_router(GroupStore::new_temporary());
        for origin in [
            "http://169.254.169.254",
            "http://10.0.0.1",
            "http://127.0.0.1/admin#",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/groups/{}/epochs", "00".repeat(32)))
                        .header(HEADER_GROUP_UPSTREAM_RELAY, origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(!response.status().is_success());
        }
    }

    #[tokio::test]
    async fn http_epochs_cas_and_sealed_sender_messages_enforce_w_g_e() {
        let store = GroupStore::new_temporary();
        let app = test_router(store);

        let (group_sk, group_pk) = keypair(5);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (write_sk_0, write_pk_0) = keypair(50);
        let read_token_0 = hex::encode([0x42u8; 32]);
        let read_token_hash_0 = hex::encode(Sha256::digest([0x42u8; 32]));

        let mut epoch0 = GroupEpochFrame {
            group_id: group_id.clone(),
            group_pubkey: hex::encode(group_pk),
            epoch: 0,
            prev_epoch_hash: "00".repeat(32),
            write_pubkey: hex::encode(write_pk_0),
            read_token_hash: read_token_hash_0,
            encrypted_epoch_descriptor: hex::encode(b"epoch-0-desc"),
            admin_sig: "ab".repeat(64),
            epoch_hash: String::new(),
        };

        epoch0.admin_sig = sign_digest(&group_sk, &epoch0.compute_epoch_hash().unwrap());

        // A member's shared write key cannot claim root epoch authority over HTTP.
        let mut forged_epoch = epoch0.clone();
        forged_epoch.admin_sig =
            sign_digest(&write_sk_0, &forged_epoch.compute_epoch_hash().unwrap());
        let forbidden = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/epochs"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&forged_epoch).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        // 1. PUT /groups/:group_id/epochs (epoch 0) -> 200 OK
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/epochs"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&epoch0).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body_bytes = hyper::body::to_bytes(res.into_body()).await.unwrap();
        let committed_0: GroupEpochFrame = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(committed_0.epoch, 0);

        // 2. Duplicate PUT epoch 0 -> 409 Conflict with current_epoch
        let res_conflict = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/epochs"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&epoch0).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_conflict.status(), StatusCode::CONFLICT);

        // 3. PUT /groups/:group_id/messages signed by valid W_{G,0} -> 200 OK
        let mut msg = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([7u8; 24]),
            ciphertext: hex::encode(b"encrypted-group-payload"),
            write_sig: String::new(),
        };
        msg.write_sig = sign_digest(&write_sk_0, &msg.signing_digest().unwrap());

        let res_msg = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&paid(&msg)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_msg.status(), StatusCode::OK);

        // 4. PUT /groups/:group_id/messages signed by outsider key -> 403 Forbidden
        let (outsider_sk, _) = keypair(99);
        let mut bad_msg = msg.clone();
        bad_msg.write_sig = sign_digest(&outsider_sk, &bad_msg.signing_digest().unwrap());
        let res_bad = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&paid(&bad_msg)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_bad.status(), StatusCode::FORBIDDEN);

        // 5. GET /groups/:group_id/messages without or with wrong X-Group-Read-Token -> 403 Forbidden
        let res_no_token = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/groups/{group_id}/messages?after_seq=0&limit=10"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_no_token.status(), StatusCode::FORBIDDEN);

        // 6. GET /groups/:group_id/messages with valid X-Group-Read-Token -> 200 OK
        let res_get = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/groups/{group_id}/messages?after_seq=0&limit=10"))
                    .header(HEADER_GROUP_READ_TOKEN, &read_token_0)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_get.status(), StatusCode::OK);
        let get_bytes = hyper::body::to_bytes(res_get.into_body()).await.unwrap();
        let list: GroupMessagesResponse = serde_json::from_slice(&get_bytes).unwrap();
        assert_eq!(list.messages.len(), 1);
        assert_eq!(list.messages[0].server_seq, 1);
        assert_eq!(list.mode, "local");
    }

    #[tokio::test]
    async fn mirror_pages_maximum_size_messages_without_exhausting_body_budget_or_losing_cursor_progress(
    ) {
        let upstream = GroupStore::new_temporary();
        let (root_sk, root_pk) = keypair(7);
        let (write_sk, write_pk) = keypair(70);
        let group_id = hex::encode(derive_group_id(&root_pk));
        let read_token = "00".repeat(32);
        upstream
            .put_epoch(
                &group_id,
                signed_epoch(
                    &root_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(root_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"descriptor"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        for nonce in 1..=10 {
            let mut message = GroupMessageEnvelope {
                group_id: group_id.clone(),
                epoch: 0,
                nonce: hex::encode([nonce; 24]),
                ciphertext: hex::encode(vec![nonce; 1024 * 1024]),
                write_sig: String::new(),
            };
            message.write_sig = sign_digest(&write_sk, &message.signing_digest().unwrap());
            upstream.put_message(&group_id, message).unwrap();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(test_router(upstream).into_make_service())
                .await
                .unwrap();
        });
        let home = GroupStore::with_mirror_threshold(
            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            Arc::new(crate::store::large_values::LocalFsObjectStore::temporary()),
            1,
        );
        let router = test_router(home.clone());
        for (cursor, count, next) in [(0, 8, 8), (8, 2, 10)] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/groups/{group_id}/messages?after_seq={cursor}&limit=500"
                        ))
                        .header(HEADER_GROUP_UPSTREAM_RELAY, &origin)
                        .header(HEADER_GROUP_READ_TOKEN, &read_token)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let batch: GroupMessagesResponse = serde_json::from_slice(&body).unwrap();
            assert_eq!(batch.messages.len(), count);
            assert_eq!(batch.next_after_seq, next);
        }
        assert_eq!(
            home.get_mirror_state(&group_id)
                .unwrap()
                .unwrap()
                .last_synced_seq,
            10
        );
        server.abort();
    }

    async fn spawn_group_router(store: GroupStore) -> (String, tokio::task::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        // Each spawned relay hosts its groups at its own origin, as a deployed relay does.
        let writes = test_writes(&origin);
        let task = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router_with_store(store, writes).into_make_service())
                .await
                .unwrap();
        });
        (origin, task)
    }

    /// When armed, the next transaction that writes either commits and then reports
    /// `CommitUnknownResult`, or (with `time_out`) is abandoned and reports
    /// `TransactionTimedOut`. Read-only transactions pass through.
    #[derive(Debug)]
    struct AmbiguousOnce {
        inner: RocksDbKvStore,
        armed: std::sync::atomic::AtomicBool,
        time_out: bool,
    }

    /// Forwards to the real transaction and records whether the attempt wrote anything.
    struct Tracking<'a> {
        tx: &'a mut dyn crate::store::kv_store::KvTransaction,
        wrote: bool,
    }

    impl crate::store::kv_store::KvTransaction for Tracking<'_> {
        fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, crate::store::kv_store::KvError> {
            self.tx.get(key)
        }
        fn get_range(
            &mut self,
            start: &[u8],
            end: &[u8],
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, crate::store::kv_store::KvError> {
            self.tx.get_range(start, end, limit)
        }
        fn get_range_reverse(
            &mut self,
            start: &[u8],
            end: &[u8],
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, crate::store::kv_store::KvError> {
            self.tx.get_range_reverse(start, end, limit)
        }
        fn set(&mut self, key: &[u8], value: &[u8]) -> Result<(), crate::store::kv_store::KvError> {
            self.wrote = true;
            self.tx.set(key, value)
        }
        fn clear(&mut self, key: &[u8]) -> Result<(), crate::store::kv_store::KvError> {
            self.wrote = true;
            self.tx.clear(key)
        }
        fn atomic_add(
            &mut self,
            key: &[u8],
            delta: i64,
        ) -> Result<(), crate::store::kv_store::KvError> {
            self.wrote = true;
            self.tx.atomic_add(key, delta)
        }
    }

    impl crate::store::kv_store::RelayKvStore for AmbiguousOnce {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(
                &mut dyn crate::store::kv_store::KvTransaction,
            ) -> crate::store::kv_store::Outcome,
        ) -> Result<crate::store::kv_store::Outcome, crate::store::kv_store::KvError> {
            use crate::store::kv_store::{KvError, Outcome};
            use std::sync::atomic::Ordering;
            let mut wrote = false;
            let outcome = self.inner.run_transaction(&mut |tx| {
                let mut tracking = Tracking { tx, wrote: false };
                let outcome = body(&mut tracking);
                wrote = tracking.wrote;
                if self.time_out
                    && wrote
                    && outcome == Outcome::Commit
                    && self.armed.load(Ordering::SeqCst)
                {
                    // Time out before committing: nothing is written.
                    return Outcome::Abort;
                }
                outcome
            })?;
            if wrote && self.armed.load(Ordering::SeqCst) {
                self.armed.store(false, Ordering::SeqCst);
                return Err(if self.time_out {
                    KvError::TransactionTimedOut
                } else {
                    // The write committed; only the answer is lost.
                    KvError::CommitUnknownResult("injected after commit".into())
                });
            }
            Ok(outcome)
        }
    }

    #[tokio::test]
    async fn ambiguous_or_timed_out_appends_are_retryable_503s_and_a_resend_keeps_one_row() {
        for (time_out, code) in [
            (false, "group_commit_unknown"),
            (true, "group_storage_timeout"),
        ] {
            let kv = Arc::new(AmbiguousOnce {
                inner: RocksDbKvStore::open_temporary().unwrap(),
                armed: std::sync::atomic::AtomicBool::new(false),
                time_out,
            });
            let store = GroupStore::new(
                Arc::clone(&kv) as Arc<dyn crate::store::kv_store::RelayKvStore>,
                Arc::new(crate::store::large_values::LocalFsObjectStore::temporary()),
            );
            let (root_sk, root_pk) = keypair(8);
            let (write_sk, write_pk) = keypair(80);
            let id = hex::encode(derive_group_id(&root_pk));
            store
                .put_epoch(
                    &id,
                    signed_epoch(
                        &root_sk,
                        GroupEpochFrame {
                            group_id: id.clone(),
                            group_pubkey: hex::encode(root_pk),
                            epoch: 0,
                            prev_epoch_hash: "00".repeat(32),
                            write_pubkey: hex::encode(write_pk),
                            read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                            encrypted_epoch_descriptor: hex::encode(b"roster"),
                            admin_sig: String::new(),
                            epoch_hash: String::new(),
                        },
                    ),
                )
                .unwrap();
            let mut message = GroupMessageEnvelope {
                group_id: id.clone(),
                epoch: 0,
                nonce: hex::encode([2u8; 24]),
                ciphertext: hex::encode(b"maybe stored"),
                write_sig: String::new(),
            };
            message.write_sig = sign_digest(&write_sk, &message.signing_digest().unwrap());
            let (origin, task) = spawn_group_router(store.clone()).await;
            let client = reqwest::Client::new();
            let send = || {
                client
                    .put(format!("{origin}/groups/{id}/messages"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(serde_json::to_vec(&paid_for(&origin, &message)).unwrap())
                    .send()
            };
            kv.armed.store(true, std::sync::atomic::Ordering::SeqCst);
            let first = send().await.unwrap();
            assert_eq!(first.status(), StatusCode::SERVICE_UNAVAILABLE, "{code}");
            assert_eq!(first.headers().get(header::RETRY_AFTER).unwrap(), "1");
            let error: serde_json::Value =
                serde_json::from_slice(&first.bytes().await.unwrap()).unwrap();
            assert_eq!(error["error"], code);
            // The client resends the same envelope: one row, whether or not the first committed.
            let retry = send().await.unwrap();
            assert_eq!(retry.status(), StatusCode::OK, "{code}");
            assert_eq!(
                retry.headers().get(HEADER_GROUP_APPEND).unwrap(),
                if time_out { "appended" } else { "existing" }
            );
            let row: StoredGroupMessage =
                serde_json::from_slice(&retry.bytes().await.unwrap()).unwrap();
            assert_eq!(row.server_seq, 1, "{code}");
            task.abort();
        }
    }

    /// A group on `store` with one epoch; returns its id and write key.
    fn hosted_group(store: &GroupStore, root_byte: u8) -> (String, SecretKey) {
        let (root_sk, root_pk) = keypair(root_byte);
        let (write_sk, write_pk) = keypair(root_byte.wrapping_add(63));
        let id = hex::encode(derive_group_id(&root_pk));
        store
            .put_epoch(
                &id,
                signed_epoch(
                    &root_sk,
                    GroupEpochFrame {
                        group_id: id.clone(),
                        group_pubkey: hex::encode(root_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"roster"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        (id, write_sk)
    }

    fn sealed(id: &str, write_sk: &SecretKey, nonce: u8) -> GroupMessageEnvelope {
        let mut message = GroupMessageEnvelope {
            group_id: id.to_owned(),
            epoch: 0,
            nonce: hex::encode([nonce; 24]),
            ciphertext: hex::encode(b"content"),
            write_sig: String::new(),
        };
        message.write_sig = sign_digest(write_sk, &message.signing_digest().unwrap());
        message
    }

    async fn put_json(
        url: String,
        upstream: Option<&str>,
        body: &impl Serialize,
    ) -> reqwest::Response {
        let mut request = reqwest::Client::new()
            .put(url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(body).unwrap());
        if let Some(upstream) = upstream {
            request = request.header(HEADER_GROUP_UPSTREAM_RELAY, upstream);
        }
        request.send().await.unwrap()
    }

    #[tokio::test]
    async fn unpaid_and_misdirected_writes_are_refused_before_any_sequence_is_consumed() {
        let store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&store, 7);
        let message = sealed(&id, &write_sk, 1);
        let (host, task) = spawn_group_router(store.clone()).await;
        let url = format!("{host}/groups/{id}/messages");
        let burn = TEST_PAYEE;
        let host_origin = canonical(&host);
        let other = |payment: GroupWritePaymentWire| GroupWriteRequest {
            envelope: message.clone(),
            payment: Some(payment),
        };
        let mut other_write = message.clone();
        other_write.nonce = hex::encode([9u8; 24]);
        let cases = [
            (
                GroupWriteRequest {
                    envelope: message.clone(),
                    payment: None,
                },
                "group_payment_required",
                "missing",
            ),
            (
                other(payment_tx(
                    10143,
                    burn,
                    TEST_PRICE - 1,
                    "monad-testnet",
                    &host_origin,
                    &message,
                )),
                "group_payment_invalid",
                "underpaid",
            ),
            (
                other(payment_tx(
                    10143,
                    [0xaa; 20],
                    TEST_PRICE,
                    "monad-testnet",
                    &host_origin,
                    &message,
                )),
                "group_payment_invalid",
                "wrong_payee",
            ),
            (
                other(payment_tx(
                    11_155_111,
                    burn,
                    TEST_PRICE,
                    "monad-testnet",
                    &host_origin,
                    &message,
                )),
                "group_payment_invalid",
                "wrong_chain",
            ),
            (
                other(payment_tx(
                    10143,
                    burn,
                    TEST_PRICE,
                    "ethereum-sepolia",
                    &host_origin,
                    &message,
                )),
                "group_payment_invalid",
                "wrong_network",
            ),
            (
                // Pays for another write on this relay.
                other(payment_tx(
                    10143,
                    burn,
                    TEST_PRICE,
                    "monad-testnet",
                    &host_origin,
                    &other_write,
                )),
                "group_payment_invalid",
                "wrong_commitment",
            ),
            (
                // Pays for this write on another relay.
                other(payment_tx(
                    10143,
                    burn,
                    TEST_PRICE,
                    "monad-testnet",
                    "https://other.example",
                    &message,
                )),
                "group_payment_invalid",
                "wrong_commitment",
            ),
            (
                other(GroupWritePaymentWire {
                    network: "monad-testnet".into(),
                    raw_transaction: "02c0".into(),
                }),
                "group_payment_invalid",
                "malformed",
            ),
        ];
        for (request, error, reason) in cases {
            let response = put_json(url.clone(), None, &request).await;
            assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED, "{reason}");
            let body: serde_json::Value =
                serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(body["error"], error, "{reason}");
            assert_eq!(body["reason"], reason, "{body}");
            assert!(
                store.list_messages(&id, 0, 10).unwrap().is_empty(),
                "{reason}"
            );
        }
        // Nothing above consumed a sequence: the first paid write is still number 1.
        let accepted = put_json(url.clone(), None, &paid_for(&host, &message)).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(accepted.headers()[HEADER_GROUP_APPEND], "appended");
        let row: StoredGroupMessage =
            serde_json::from_slice(&accepted.bytes().await.unwrap()).unwrap();
        assert_eq!(row.server_seq, 1);
        // An accepted retry, with the same payment, returns the original receipt.
        let retry = put_json(url, None, &paid_for(&host, &message)).await;
        assert_eq!(retry.headers()[HEADER_GROUP_APPEND], "existing");
        assert_eq!(
            serde_json::from_slice::<StoredGroupMessage>(&retry.bytes().await.unwrap()).unwrap(),
            row
        );
        assert_eq!(store.list_messages(&id, 0, 10).unwrap(), vec![row]);
        task.abort();
    }

    #[tokio::test]
    async fn underpaid_is_answered_only_when_no_attempt_was_accepted_and_is_final_for_its_payment()
    {
        let store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&store, 7);
        let (host, task) = spawn_group_router(store.clone()).await;
        let url = format!("{host}/groups/{id}/messages");
        let price = |version: u64, price_wei: u128| {
            let (root_sk, root_pk) = keypair(7);
            crate::group_write_payment::GroupWritePrice {
                group_id: id.clone(),
                network: "monad-testnet".into(),
                version,
                price_wei,
                admin_sig: sign_digest(
                    &root_sk,
                    &crate::group_write_payment::group_write_price_digest(
                        "monad-testnet",
                        &derive_group_id(&root_pk),
                        version,
                        price_wei,
                    ),
                ),
            }
        };
        let reason = |body: &[u8]| {
            serde_json::from_slice::<serde_json::Value>(body).unwrap()["reason"].clone()
        };

        // Accepted at the minimum; the creator then raises the price.
        let accepted_write = sealed(&id, &write_sk, 1);
        let accepted = put_json(url.clone(), None, &paid_for(&host, &accepted_write)).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let row: StoredGroupMessage =
            serde_json::from_slice(&accepted.bytes().await.unwrap()).unwrap();
        store
            .put_write_price(&id, price(1, TEST_PRICE * 5), "monad-testnet", TEST_PRICE)
            .unwrap();
        // A retry of the accepted write, short of the new price, is answered with its receipt.
        let retry = put_json(url.clone(), None, &paid_for(&host, &accepted_write)).await;
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(retry.headers()[HEADER_GROUP_APPEND], "existing");
        assert_eq!(
            serde_json::from_slice::<StoredGroupMessage>(&retry.bytes().await.unwrap()).unwrap(),
            row
        );

        // A write never accepted, short of it, is refused, and its payment for good: once the
        // price falls back, an attempt with that payment still in flight is refused too.
        let refused_write = sealed(&id, &write_sk, 2);
        let refused = put_json(url.clone(), None, &paid_for(&host, &refused_write)).await;
        assert_eq!(refused.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(reason(&refused.bytes().await.unwrap()), "underpaid");
        store
            .put_write_price(&id, price(2, TEST_PRICE), "monad-testnet", TEST_PRICE)
            .unwrap();
        let late = put_json(url.clone(), None, &paid_for(&host, &refused_write)).await;
        assert_eq!(late.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(reason(&late.bytes().await.unwrap()), "underpaid");
        assert_eq!(store.list_messages(&id, 0, 10).unwrap(), vec![row]);
        task.abort();
    }

    #[tokio::test]
    async fn a_payment_is_verified_only_by_the_host_and_replays_nowhere_else() {
        let host_store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&host_store, 7);
        let (host, host_task) = spawn_group_router(host_store.clone()).await;
        // The home relay has its own, different policy (another origin and payee rules); it
        // forwards the host's write without judging the payment.
        let home_store = GroupStore::new_temporary();
        let (home, home_task) = spawn_group_router(home_store.clone()).await;
        let message = sealed(&id, &write_sk, 1);

        // Paid to the home relay instead of the host: the host refuses it, through the proxy.
        let misdirected = put_json(
            format!("{home}/groups/{id}/messages"),
            Some(&host),
            &paid_for(&home, &message),
        )
        .await;
        assert_eq!(misdirected.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(host_store.list_messages(&id, 0, 10).unwrap().is_empty());

        let proxied = put_json(
            format!("{home}/groups/{id}/messages"),
            Some(&host),
            &paid_for(&host, &message),
        )
        .await;
        assert_eq!(proxied.status(), StatusCode::OK);
        assert_eq!(proxied.headers()[HEADER_GROUP_RELAY_MODE], "proxy");
        assert_eq!(proxied.headers()[HEADER_GROUP_APPEND], "appended");
        assert_eq!(host_store.list_messages(&id, 0, 10).unwrap().len(), 1);
        assert!(home_store.get_current_epoch(&id).unwrap().is_none());

        // The policy a writer reads through its home relay is the host's.
        let policy: GroupWritePolicyBody = serde_json::from_slice(
            &reqwest::Client::new()
                .get(format!("{home}/groups/{id}/write-policy"))
                .header(HEADER_GROUP_UPSTREAM_RELAY, &host)
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(policy.host_origin, canonical(&host));
        assert_eq!(policy.network, "monad-testnet");
        // No creator price yet: the host's minimum.
        assert_eq!(policy.price_wei, TEST_PRICE.to_string());
        assert_eq!(policy.price_version, 0);
        assert_eq!(policy.price_record, None);
        assert_eq!(policy.min_price_wei, TEST_PRICE.to_string());
        assert_eq!(policy.payee, "0x000000000000000000000000000000000000dead");

        // The same group and write hosted by another relay: the host's payment is refused there.
        let replica_of_group = GroupStore::new_temporary();
        let (same_id, _) = hosted_group(&replica_of_group, 7);
        assert_eq!(same_id, id);
        let (other, other_task) = spawn_group_router(replica_of_group.clone()).await;
        let replay = put_json(
            format!("{other}/groups/{id}/messages"),
            None,
            &paid_for(&host, &message),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::PAYMENT_REQUIRED);
        let body: serde_json::Value =
            serde_json::from_slice(&replay.bytes().await.unwrap()).unwrap();
        assert_eq!(body["reason"], "wrong_commitment");
        assert!(replica_of_group
            .list_messages(&id, 0, 10)
            .unwrap()
            .is_empty());
        host_task.abort();
        home_task.abort();
        other_task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_payment_sent_to_two_replicas_at_once_gives_one_append() {
        // Two replicas of one relay share its storage and its origin.
        let store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&store, 7);
        let message = sealed(&id, &write_sk, 1);
        let request = paid(&message);
        let replica_a = test_router(store.clone());
        let replica_b = test_router(store.clone());
        let send = |router: Router| {
            let body = serde_json::to_vec(&request).unwrap();
            let id = id.clone();
            async move {
                router
                    .oneshot(
                        Request::builder()
                            .method("PUT")
                            .uri(format!("/groups/{id}/messages"))
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap()
            }
        };
        let (a, b) = tokio::join!(tokio::spawn(send(replica_a)), tokio::spawn(send(replica_b)));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.status(), StatusCode::OK);
        assert_eq!(b.status(), StatusCode::OK);
        let mut dispositions = [
            a.headers()[HEADER_GROUP_APPEND]
                .to_str()
                .unwrap()
                .to_owned(),
            b.headers()[HEADER_GROUP_APPEND]
                .to_str()
                .unwrap()
                .to_owned(),
        ];
        dispositions.sort();
        assert_eq!(dispositions, ["appended", "existing"]);
        let a: StoredGroupMessage =
            serde_json::from_slice(&hyper::body::to_bytes(a.into_body()).await.unwrap()).unwrap();
        let b: StoredGroupMessage =
            serde_json::from_slice(&hyper::body::to_bytes(b.into_body()).await.unwrap()).unwrap();
        assert_eq!(a, b);
        assert_eq!(store.list_messages(&id, 0, 10).unwrap(), vec![a.clone()]);
        // The payment's record was written with the write it funded.
        let verified = test_writes(TEST_HOST)
            .verify(&id, &message, request.payment.as_ref().unwrap(), None)
            .unwrap();
        let record = store.payment_record(&verified.tx_hash.0).unwrap().unwrap();
        assert_eq!(
            (record.group_id.as_str(), record.server_seq),
            (id.as_str(), a.server_seq)
        );
        assert_eq!(record.value_wei, TEST_PRICE.to_string());
        assert_eq!(record.network, "monad-testnet");
    }

    #[test]
    fn a_payment_lands_in_the_payers_nonce_window_with_its_value_and_gas_covered() {
        use super::payment::{judge_funding, FundingProblem, PayerAccount, PAYMENT_NONCE_WINDOW};
        let payment = |nonce| crate::group_write_payment::VerifiedGroupPayment {
            tx_hash: crate::monad_http::Hash32([1; 32]),
            sender: crate::monad_http::Address([2; 20]),
            payee: [3; 20],
            value_wei: 1_000,
            nonce,
            max_gas_cost_wei: 500,
            raw_transaction: vec![],
        };
        let account = |pending_nonce, balance_wei| PayerAccount {
            pending_nonce,
            balance_wei,
        };
        assert_eq!(judge_funding(&payment(5), &account(5, 1_500), false), None);
        // Behind the wallet's own self-sends, shuffled before it in its set, or a stacked
        // successor: the predecessors are broadcast after the relay holds the write.
        assert_eq!(judge_funding(&payment(6), &account(5, 1_500), false), None);
        assert_eq!(
            judge_funding(
                &payment(5 + PAYMENT_NONCE_WINDOW),
                &account(5, 1_500),
                false
            ),
            None
        );
        assert_eq!(
            judge_funding(
                &payment(6 + PAYMENT_NONCE_WINDOW),
                &account(5, 1_500),
                false
            ),
            Some(FundingProblem::NonceGap)
        );
        assert_eq!(
            judge_funding(&payment(5), &account(5, 1_499), false),
            Some(FundingProblem::InsufficientBalance)
        );
        assert_eq!(
            judge_funding(&payment(5), &account(6, 10_000), false),
            Some(FundingProblem::StaleNonce)
        );
        // The node already holds this very payment: an earlier attempt's copy, or mined.
        assert_eq!(judge_funding(&payment(5), &account(6, 0), true), None);
    }

    #[tokio::test]
    async fn an_unreachable_upstream_is_a_gateway_error_never_a_refusal() {
        // The group is hosted elsewhere; this relay only proxies to the named upstream.
        let (id, write_sk) = hosted_group(&GroupStore::new_temporary(), 12);
        let message = sealed(&id, &write_sk, 1);
        let response = test_router(GroupStore::new_temporary())
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{id}/messages"))
                    .header("content-type", "application/json")
                    .header(HEADER_GROUP_UPSTREAM_RELAY, "https://no-such-relay.invalid")
                    .body(Body::from(serde_json::to_vec(&paid(&message)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            matches!(
                response.status(),
                StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT
            ),
            "{}",
            response.status()
        );
    }

    #[tokio::test]
    async fn the_creator_prices_a_group_through_its_home_relay_and_new_writes_pay_that_price() {
        let host_store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&host_store, 7);
        let (host, host_task) = spawn_group_router(host_store.clone()).await;
        let home_store = GroupStore::new_temporary();
        let (home, home_task) = spawn_group_router(home_store.clone()).await;
        let (root_sk, root_pub) = keypair(7);
        let record = |version: u64, price: u128, network: &str| {
            let digest = crate::group_write_payment::group_write_price_digest(
                network,
                &parse_group_id_hex(&id).unwrap(),
                version,
                price,
            );
            serde_json::json!({
                "group_id": id,
                "network": network,
                "version": version,
                "price_wei": price.to_string(),
                "admin_sig": sign_digest(&root_sk, &digest),
            })
        };
        let policy = || async {
            let body: GroupWritePolicyBody = reqwest::Client::new()
                .get(format!("{home}/groups/{id}/write-policy"))
                .header(HEADER_GROUP_UPSTREAM_RELAY, &host)
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .map(|bytes| serde_json::from_slice(&bytes).unwrap())
                .unwrap();
            // The signed record comes with the price, so a member checks it against the group key.
            assert_eq!(
                body.price_record.as_ref().map(|r| r.version).unwrap_or(0),
                body.price_version
            );
            if let Some(record) = &body.price_record {
                record.verify(&id, "monad-testnet", &root_pub).unwrap();
            }
            (body.price_wei, body.price_version)
        };
        let set = |body: serde_json::Value| {
            let (url, host) = (format!("{home}/groups/{id}/write-price"), host.clone());
            async move { put_json(url, Some(&host), &body).await }
        };
        assert_eq!(policy().await, (TEST_PRICE.to_string(), 0));

        // The creator sets five times the minimum, through its home relay.
        let response = set(record(1, TEST_PRICE * 5, "monad-testnet")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(policy().await, ((TEST_PRICE * 5).to_string(), 1));
        assert!(home_store.get_write_price(&id).unwrap().is_none());

        // Refused at create/change time: below the host's minimum, another network, version 0,
        // a stale version, another key's signature.
        let response = set(record(2, TEST_PRICE - 1, "monad-testnet")).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: serde_json::Value =
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(body["error"], "write_price_below_minimum");
        assert_eq!(body["min_price_wei"], TEST_PRICE.to_string());
        for (body, status) in [
            (
                record(2, TEST_PRICE, "monad-mainnet"),
                StatusCode::BAD_REQUEST,
            ),
            (
                record(0, TEST_PRICE, "monad-testnet"),
                StatusCode::BAD_REQUEST,
            ),
            (
                record(1, TEST_PRICE * 2, "monad-testnet"),
                StatusCode::CONFLICT,
            ),
        ] {
            assert_eq!(set(body).await.status(), status);
        }
        let mut forged = record(2, TEST_PRICE, "monad-testnet");
        forged["admin_sig"] = serde_json::Value::String(sign_digest(
            &keypair(8).0,
            &crate::group_write_payment::group_write_price_digest(
                "monad-testnet",
                &parse_group_id_hex(&id).unwrap(),
                2,
                TEST_PRICE,
            ),
        ));
        assert_eq!(set(forged).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(policy().await, ((TEST_PRICE * 5).to_string(), 1));

        // A write paying the minimum is now underpaid, and nothing is stored.
        let message = sealed(&id, &write_sk, 1);
        let refused = put_json(
            format!("{home}/groups/{id}/messages"),
            Some(&host),
            &paid_for(&host, &message),
        )
        .await;
        assert_eq!(refused.status(), StatusCode::PAYMENT_REQUIRED);
        let body: serde_json::Value =
            serde_json::from_slice(&refused.bytes().await.unwrap()).unwrap();
        assert_eq!(body["reason"], "underpaid");
        assert!(host_store.list_messages(&id, 0, 10).unwrap().is_empty());
        let paid_at_price = GroupWriteRequest {
            envelope: message.clone(),
            payment: Some(payment_tx(
                10143,
                TEST_PAYEE,
                TEST_PRICE * 5,
                "monad-testnet",
                &canonical(&host),
                &message,
            )),
        };
        let accepted = put_json(
            format!("{home}/groups/{id}/messages"),
            Some(&host),
            &paid_at_price,
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(host_store.list_messages(&id, 0, 10).unwrap().len(), 1);

        // Lowered again at version 2: the next write pays the lower price.
        assert_eq!(
            set(record(2, TEST_PRICE * 2, "monad-testnet"))
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(policy().await, ((TEST_PRICE * 2).to_string(), 2));
        let next = sealed(&id, &write_sk, 2);
        let response = put_json(
            format!("{host}/groups/{id}/messages"),
            None,
            &GroupWriteRequest {
                envelope: next.clone(),
                payment: Some(payment_tx(
                    10143,
                    TEST_PAYEE,
                    TEST_PRICE * 2,
                    "monad-testnet",
                    &canonical(&host),
                    &next,
                )),
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(host_store.list_messages(&id, 0, 10).unwrap().len(), 2);
        host_task.abort();
        home_task.abort();
    }

    #[tokio::test]
    async fn a_relay_without_an_upstream_refuses_new_writes_retryably() {
        let store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&store, 11);
        let message = sealed(&id, &write_sk, 1);
        let writes = Arc::new(
            GroupWriteRuntime::without_upstream(
                "monad-testnet",
                &writes_conf(TEST_PRICE, cashweb_config::BURN_ADDRESS_HEX),
                &TEST_HOST.parse().unwrap(),
            )
            .unwrap(),
        );
        let response = router_with_store(store.clone(), writes)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&paid(&message)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value =
            serde_json::from_slice(&hyper::body::to_bytes(response.into_body()).await.unwrap())
                .unwrap();
        assert_eq!(body["error"], "group_payment_check_unavailable");
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_accepted_retry_gets_its_receipt_after_the_price_and_payee_change() {
        async fn put(
            router: Router,
            id: &str,
            body: &impl Serialize,
        ) -> (StatusCode, String, Vec<u8>) {
            let response = router
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(format!("/groups/{id}/messages"))
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(body).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let disposition = response
                .headers()
                .get(HEADER_GROUP_APPEND)
                .map(|value| value.to_str().unwrap().to_owned())
                .unwrap_or_default();
            let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
            (status, disposition, body.to_vec())
        }
        let store = GroupStore::new_temporary();
        let (id, write_sk) = hosted_group(&store, 9);
        let message = sealed(&id, &write_sk, 1);
        let request = paid(&message);
        let (status, disposition, receipt) = put(test_router(store.clone()), &id, &request).await;
        assert_eq!((status, disposition.as_str()), (StatusCode::OK, "appended"));

        // The operator raises its minimum and moves its address; the same relay, the same store.
        let changed = || {
            router_with_store(
                store.clone(),
                Arc::new(
                    GroupWriteRuntime::loopback_fixture(
                        "monad-testnet",
                        &writes_conf(
                            TEST_PRICE * 10,
                            "0x00000000000000000000000000000000000000aa",
                        ),
                        &TEST_HOST.parse().unwrap(),
                    )
                    .unwrap(),
                ),
            )
        };
        // The retry, with its original payment or with none, gets its original receipt.
        for retry in [
            request.clone(),
            GroupWriteRequest {
                envelope: message.clone(),
                payment: None,
            },
        ] {
            let (status, disposition, body) = put(changed(), &id, &retry).await;
            assert_eq!((status, disposition.as_str()), (StatusCode::OK, "existing"));
            assert_eq!(body, receipt);
        }
        // A new write is held to the new policy.
        let (status, _, body) = put(changed(), &id, &paid(&sealed(&id, &write_sk, 2))).await;
        assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["reason"], "wrong_payee");
        assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn foreign_latest_refresh_and_write_ack_preserve_contiguous_backlog() {
        let upstream = GroupStore::new_temporary();
        let (root_sk, root_pk) = keypair(7);
        let (write_sk, write_pk) = keypair(70);
        let id = hex::encode(derive_group_id(&root_pk));
        let read_token = "00".repeat(32);
        let initial = upstream
            .put_epoch(
                &id,
                signed_epoch(
                    &root_sk,
                    GroupEpochFrame {
                        group_id: id.clone(),
                        group_pubkey: hex::encode(root_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"initial"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        let message = |nonce: u8| {
            let mut envelope = GroupMessageEnvelope {
                group_id: id.clone(),
                epoch: 0,
                nonce: hex::encode([nonce; 24]),
                ciphertext: hex::encode([nonce; 32]),
                write_sig: String::new(),
            };
            envelope.write_sig = sign_digest(&write_sk, &envelope.signing_digest().unwrap());
            envelope
        };
        upstream.put_message(&id, message(1)).unwrap();
        let (origin, origin_task) = spawn_group_router(upstream.clone()).await;
        let home = GroupStore::with_mirror_threshold(
            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            Arc::new(crate::store::large_values::LocalFsObjectStore::temporary()),
            1,
        );
        let router = test_router(home.clone());
        let read = |after| {
            Request::builder()
                .uri(format!("/groups/{id}/messages?after_seq={after}"))
                .header(HEADER_GROUP_UPSTREAM_RELAY, &origin)
                .header(HEADER_GROUP_READ_TOKEN, &read_token)
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            router.clone().oneshot(read(0)).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            home.get_mirror_state(&id).unwrap().unwrap().last_synced_seq,
            1
        );
        upstream.put_message(&id, message(2)).unwrap();
        upstream.put_message(&id, message(3)).unwrap();
        let acknowledgement = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{id}/messages"))
                    .header(HEADER_GROUP_UPSTREAM_RELAY, &origin)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&paid_for(&origin, &message(4))).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(acknowledgement.status(), StatusCode::OK);
        assert_eq!(
            home.get_mirror_state(&id).unwrap().unwrap().last_synced_seq,
            1
        );
        assert_eq!(home.list_messages(&id, 0, 10).unwrap().len(), 1);
        let backlog = router.clone().oneshot(read(1)).await.unwrap();
        assert_eq!(backlog.status(), StatusCode::OK);
        let backlog: GroupMessagesResponse =
            serde_json::from_slice(&hyper::body::to_bytes(backlog.into_body()).await.unwrap())
                .unwrap();
        assert_eq!(
            backlog
                .messages
                .iter()
                .map(|message| message.server_seq)
                .collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        let rotated = upstream
            .put_epoch(
                &id,
                signed_epoch(
                    &root_sk,
                    GroupEpochFrame {
                        group_id: id.clone(),
                        group_pubkey: hex::encode(root_pk),
                        epoch: 1,
                        prev_epoch_hash: initial.epoch_hash,
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest([1u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"successor"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(home.get_current_epoch(&id).unwrap().unwrap().epoch, 0);
        for route in [true, false] {
            let mut request = Request::builder().uri(format!("/groups/{id}/epochs"));
            if route {
                request = request.header(HEADER_GROUP_UPSTREAM_RELAY, &origin);
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let frame: GroupEpochFrame =
                serde_json::from_slice(&hyper::body::to_bytes(response.into_body()).await.unwrap())
                    .unwrap();
            assert_eq!(frame, rotated);
        }
        origin_task.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "Requires Node dependencies; runs the real TypeScript client against two Rust relay routers"]
    async fn typescript_foreign_client_against_real_rust_relays() {
        let (origin, origin_task) = spawn_group_router(GroupStore::new_temporary()).await;
        let (home, home_task) = spawn_group_router(GroupStore::new_temporary()).await;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .to_path_buf();
        let result = tokio::task::spawn_blocking(move || {
            std::process::Command::new("node")
                .current_dir(&root)
                .arg(root.join("node_modules/jest/bin/jest.js"))
                .args([
                    "--config",
                    "packages/cashweb/jest.config.js",
                    "--runInBand",
                    "--runTestsByPath",
                    "packages/cashweb/groups/group-http-foreign.jest.test.ts",
                    "packages/cashweb/groups/group-live-http.jest.test.ts",
                ])
                .env("FRANK_GROUP_HTTP_ORIGIN_URL", origin)
                .env("FRANK_GROUP_HTTP_HOME_URL", home)
                .output()
        })
        .await
        .unwrap();
        origin_task.abort();
        home_task.abort();
        let output =
            result.expect("failed to launch the TypeScript foreign relay integration gate");
        assert!(
            output.status.success(),
            "TypeScript foreign integration failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn home_relay_proxies_below_threshold_and_auto_promotes_to_local_mirror_at_threshold() {
        // Spawn an authoritative Upstream Foreign Relay (`Relay_G`)
        let upstream_store = GroupStore::new_temporary();
        let upstream_app = test_router(upstream_store.clone());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr: SocketAddr = listener.local_addr().unwrap();
        let upstream_url = format!("http://{upstream_addr}");
        tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(upstream_app.into_make_service())
                .await
                .unwrap();
        });

        // Create group and 1 message on `Relay_G`
        let (group_sk, group_pk) = keypair(7);
        let group_id = hex::encode(derive_group_id(&group_pk));
        let (write_sk, write_pk) = keypair(70);
        let read_token_bytes = [0x77u8; 32];
        let read_token_hex = hex::encode(read_token_bytes);
        let read_token_hash = hex::encode(Sha256::digest(read_token_bytes));

        upstream_store
            .put_epoch(
                &group_id,
                signed_epoch(
                    &group_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(group_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash,
                        encrypted_epoch_descriptor: hex::encode(b"foreign-desc"),
                        admin_sig: "11".repeat(64),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();

        let mut env1 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([9u8; 24]),
            ciphertext: hex::encode(b"hello-from-foreign-relay"),
            write_sig: String::new(),
        };
        env1.write_sig = sign_digest(&write_sk, &env1.signing_digest().unwrap());
        upstream_store.put_message(&group_id, env1).unwrap();

        // Rotate before the home relay first synchronizes, preserving messages in both epochs.
        let current = upstream_store
            .get_current_epoch(&group_id)
            .unwrap()
            .unwrap();
        upstream_store
            .put_epoch(
                &group_id,
                signed_epoch(
                    &group_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(group_pk),
                        epoch: 1,
                        prev_epoch_hash: current.epoch_hash,
                        write_pubkey: hex::encode(write_pk),
                        read_token_hash: hex::encode(Sha256::digest(read_token_bytes)),
                        encrypted_epoch_descriptor: hex::encode(b"rotated descriptor"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        let mut env2 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 1,
            nonce: hex::encode([10u8; 24]),
            ciphertext: hex::encode(b"after rotation"),
            write_sig: String::new(),
        };
        env2.write_sig = sign_digest(&write_sk, &env2.signing_digest().unwrap());
        upstream_store.put_message(&group_id, env2).unwrap();

        // Create a Home Relay (`Relay_Home`) with `mirror_threshold = 2`
        let home_store = GroupStore::with_mirror_threshold(
            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            Arc::new(crate::store::large_values::LocalFsObjectStore::temporary()),
            2,
        );
        let home_app = test_router(home_store.clone());

        let attacker_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = attacker_calls.clone();
        let attacker_router = Router::new().fallback(routing::any(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { StatusCode::FORBIDDEN }
        }));
        let attacker_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        attacker_listener.set_nonblocking(true).unwrap();
        let attacker_url = format!("http://{}", attacker_listener.local_addr().unwrap());
        let attacker_task = tokio::spawn(async move {
            axum::Server::from_tcp(attacker_listener)
                .unwrap()
                .serve(attacker_router.into_make_service())
                .await
                .unwrap();
        });
        for (origin, token) in [
            (&attacker_url, "01".repeat(32)),
            (&upstream_url, "01".repeat(32)),
        ] {
            let response = home_app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/groups/{group_id}/messages"))
                        .header(HEADER_GROUP_UPSTREAM_RELAY, origin)
                        .header(HEADER_GROUP_READ_TOKEN, token)
                        .header(HEADER_GROUP_SUBSCRIBER_TAG, "attacker")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(!response.status().is_success());
            assert!(home_store.get_mirror_state(&group_id).unwrap().is_none());
        }

        // Subscriber 1 (`sub-alice`) queries `Relay_Home` (< 2 subscribers) -> Stateless Oblivious Proxy!
        let res_sub1 = home_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/groups/{group_id}/messages?after_seq=0&limit=10"))
                    .header(HEADER_GROUP_READ_TOKEN, &read_token_hex)
                    .header(HEADER_GROUP_UPSTREAM_RELAY, &upstream_url)
                    .header(HEADER_GROUP_SUBSCRIBER_TAG, "sub-alice")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_sub1.status(), StatusCode::OK);
        assert_eq!(
            res_sub1
                .headers()
                .get(HEADER_GROUP_RELAY_MODE)
                .unwrap()
                .to_str()
                .unwrap(),
            "proxy"
        );
        let sub1_body: GroupMessagesResponse =
            serde_json::from_slice(&hyper::body::to_bytes(res_sub1.into_body()).await.unwrap())
                .unwrap();
        assert_eq!(sub1_body.mode, "proxy");
        assert_eq!(sub1_body.subscriber_count, 1);
        assert_eq!(sub1_body.messages.len(), 2);
        // Verify `Relay_Home` has NOT mirrored the group into local storage yet
        assert!(home_store.get_current_epoch(&group_id).unwrap().is_none());

        let calls_before = attacker_calls.load(std::sync::atomic::Ordering::SeqCst);
        for (origin, token) in [
            (&attacker_url, read_token_hex.clone()),
            (&upstream_url, "01".repeat(32)),
        ] {
            let response = home_app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/groups/{group_id}/messages"))
                        .header(HEADER_GROUP_UPSTREAM_RELAY, origin)
                        .header(HEADER_GROUP_READ_TOKEN, token)
                        .header(HEADER_GROUP_SUBSCRIBER_TAG, "untrusted")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let state = home_store.get_mirror_state(&group_id).unwrap().unwrap();
            assert_eq!(state.upstream_relay, upstream_url);
            assert_eq!(state.subscribers.len(), 1);
        }
        assert_eq!(
            attacker_calls.load(std::sync::atomic::Ordering::SeqCst),
            calls_before
        );

        // Subscriber 2 (`sub-bob`) queries `Relay_Home` (>= 2 subscribers) -> Auto-Mirror Promotion!
        let res_sub2 = home_app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/groups/{group_id}/messages?after_seq=0&limit=10"))
                    .header(HEADER_GROUP_READ_TOKEN, &read_token_hex)
                    .header(HEADER_GROUP_UPSTREAM_RELAY, &upstream_url)
                    .header(HEADER_GROUP_SUBSCRIBER_TAG, "sub-bob")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_sub2.status(), StatusCode::OK);
        assert_eq!(
            res_sub2
                .headers()
                .get(HEADER_GROUP_RELAY_MODE)
                .unwrap()
                .to_str()
                .unwrap(),
            "mirrored"
        );
        let sub2_body: GroupMessagesResponse =
            serde_json::from_slice(&hyper::body::to_bytes(res_sub2.into_body()).await.unwrap())
                .unwrap();
        assert_eq!(sub2_body.mode, "mirrored");
        assert_eq!(sub2_body.subscriber_count, 2);
        assert_eq!(sub2_body.messages.len(), 2);

        // Verify `Relay_Home` now holds a local mirror of both the epoch metadata and messages!
        assert!(home_store.get_current_epoch(&group_id).unwrap().is_some());
        let mirrored_msgs = home_store.list_messages(&group_id, 0, 10).unwrap();
        assert_eq!(mirrored_msgs.len(), 2);
        let mut local_message = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 1,
            nonce: "31".repeat(24),
            ciphertext: hex::encode(b"must not append to mirror"),
            write_sig: String::new(),
        };
        local_message.write_sig = sign_digest(&write_sk, &local_message.signing_digest().unwrap());
        let rejected = home_app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{group_id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&paid(&local_message)).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        assert_eq!(home_store.list_messages(&group_id, 0, 10).unwrap().len(), 2);
        attacker_task.abort();
        assert_eq!(mirrored_msgs[0].server_seq, 1);
        assert!(home_store.get_epoch(&group_id, 0).unwrap().is_some());
        assert_eq!(
            home_store
                .get_current_epoch(&group_id)
                .unwrap()
                .unwrap()
                .epoch,
            1
        );
    }
    #[tokio::test]
    async fn json_cbor_retries_return_original_receipt_without_second_wakeup() {
        use crate::events::{RelayEventBus, StandaloneEventBus};
        use frank_cbor::{cbor_map, encode_canonical, CborValue};
        let store = GroupStore::new_temporary();
        let (root, public) = keypair(7);
        let (write, write_public) = keypair(42);
        let id = hex::encode(derive_group_id(&public));
        store
            .put_epoch(
                &id,
                signed_epoch(
                    &root,
                    GroupEpochFrame {
                        group_id: id.clone(),
                        group_pubkey: hex::encode(public),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_public),
                        read_token_hash: hex::encode(Sha256::digest([0u8; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"roster"),
                        admin_sig: String::new(),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();
        let bus = Arc::new(StandaloneEventBus::new());
        let mut notifications = bus.subscribe_group(&id).await.unwrap();
        let app = Router::new()
            .route(
                "/groups/:group_id/messages",
                routing::put(handle_put_group_message_store),
            )
            .layer(Extension(store.clone()))
            .layer(Extension(Some(test_writes(TEST_HOST))))
            .layer(Extension(bus.clone() as Arc<dyn RelayEventBus>));
        let mut envelope = GroupMessageEnvelope {
            group_id: id.clone(),
            epoch: 0,
            nonce: hex::encode([0xabu8; 24]),
            ciphertext: hex::encode(b"encrypted payload"),
            write_sig: String::new(),
        };
        envelope.write_sig = sign_digest(&write, &envelope.signing_digest().unwrap());
        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{id}/messages"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&paid(&envelope)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()[HEADER_GROUP_APPEND], "appended");
        let receipt: StoredGroupMessage =
            serde_json::from_slice(&hyper::body::to_bytes(first.into_body()).await.unwrap())
                .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), notifications.recv())
                .await
                .is_ok()
        );
        let payment = paid(&envelope).payment.unwrap();
        let signature =
            secp256k1_abc::Signature::from_compact(&hex::decode(&envelope.write_sig).unwrap())
                .unwrap();
        let cbor = encode_canonical(&cbor_map(vec![
            (0, CborValue::Text(id.clone())),
            (1, CborValue::Int(0)),
            (
                2,
                CborValue::Text(format!("0x{}", envelope.nonce.to_uppercase())),
            ),
            (
                3,
                CborValue::Bytes(hex::decode(envelope.ciphertext).unwrap()),
            ),
            (4, CborValue::Bytes(signature.serialize_der().to_vec())),
            (
                5,
                cbor_map(vec![
                    (0, CborValue::Text(payment.network)),
                    (
                        1,
                        CborValue::Bytes(hex::decode(payment.raw_transaction).unwrap()),
                    ),
                ]),
            ),
        ]))
        .unwrap();
        let retry = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/groups/{id}/messages"))
                    .header("content-type", "application/cbor")
                    .body(Body::from(cbor))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(retry.headers()[HEADER_GROUP_APPEND], "existing");
        let repeated: StoredGroupMessage =
            serde_json::from_slice(&hyper::body::to_bytes(retry.into_body()).await.unwrap())
                .unwrap();
        assert_eq!(receipt, repeated);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), notifications.recv())
                .await
                .is_err()
        );
        assert_eq!(store.list_messages(&id, 0, 10).unwrap(), vec![receipt]);
    }
}
