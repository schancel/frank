//! HTTP endpoints for Shared Group Mailboxes, Atomic Epoch CAS, Sealed-Sender Group
//! Messages, and Home-Relay Oblivious Proxy / Auto-Mirroring (Issue #70).
//!
//! Routes:
//! - `PUT /groups/:group_id/epochs` — Atomic Compare-And-Swap (CAS) epoch creation/transition.
//! - `GET /groups/:group_id/epochs` — Fetch current (or specific `?epoch=<u64>`) [`GroupEpochFrame`].
//! - `PUT /groups/:group_id/messages` — Submit a sealed-sender [`GroupMessageEnvelope`] signed by $w_{G,e}$.
//! - `GET /groups/:group_id/messages?after_seq=<u64>&limit=<u16>` — Sync ordered group messages
//!   authenticated via `X-Group-Read-Token`, with automatic Home-Relay proxying (`< n` local
//!   subscribers) and local mirror promotion (`>= n` local subscribers) when
//!   `X-Group-Upstream-Relay` is specified.

mod live;
#[cfg(test)]
mod nats_tests;

use axum::{
    body::Bytes,
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing, Extension, Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    http::server::RegistryServer,
    store::groups::{
        parse_group_id_hex, GroupEpochFrame, GroupError, GroupMessageEnvelope, GroupStore,
        StoredGroupMessage,
    },
};

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
        GroupError::Storage(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody { error: msg }),
        )
            .into_response(),
    }
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

fn decode_message_envelope(
    headers: &HeaderMap,
    body: &[u8],
) -> Result<GroupMessageEnvelope, GroupError> {
    if is_cbor_content_type(headers) {
        GroupMessageEnvelope::from_cbor_bytes(body)
    } else {
        serde_json::from_slice::<GroupMessageEnvelope>(body).map_err(|e| {
            GroupError::InvalidInput(format!("invalid GroupMessageEnvelope JSON: {e}"))
        })
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
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
    match store.get_mirror_state(group_id)? {
        Some(state) if state.upstream_relay != upstream => {
            return Err(GroupError::Forbidden(
                "upstream conflicts with established group ownership".into(),
            ))
        }
        None if store.get_current_epoch(group_id)?.is_some() => {
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
    .map_err(|_| GroupError::InvalidInput("upstream DNS lookup timed out".into()))?
    .map_err(|error| GroupError::InvalidInput(format!("upstream DNS lookup failed: {error}")))?
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
            return Err(GroupError::Storage(
                "upstream response exceeds body budget".into(),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| GroupError::Storage(format!("upstream body failed: {error}")))?
        {
            if chunk.len() > budget.saturating_sub(body.len()) {
                return Err(GroupError::Storage(
                    "upstream response exceeds body budget".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
    .map_err(|_| GroupError::Storage("upstream body deadline exceeded".into()))?
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
}

/// Standalone router backed directly by a [`GroupStore`] (convenient for isolated unit/integration tests).
pub fn router_with_store(store: GroupStore) -> Router {
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
        .layer(Extension(store))
        .layer(Extension(
            std::sync::Arc::new(crate::events::StandaloneEventBus::new())
                as std::sync::Arc<dyn crate::events::RelayEventBus>,
        ))
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
            Err(e) => {
                return group_error_response(GroupError::Storage(format!(
                    "upstream proxy error: {e}"
                )))
            }
        };
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let resp_bytes = match read_upstream_body(resp, UPSTREAM_EPOCH_BUDGET).await {
            Ok(body) => body,
            Err(error) => return group_error_response(error),
        };
        if status.is_success() {
            if let Ok(committed) = serde_json::from_slice::<GroupEpochFrame>(&resp_bytes) {
                if let Ok(Some(mirror)) = store.get_mirror_state(&group_id) {
                    if mirror.mirrored {
                        let _ = store.ingest_mirrored_upstream(&group_id, Some(committed), &[]);
                    }
                }
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

    match store.put_epoch(&group_id, frame) {
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
        .map_err(|error| GroupError::Storage(format!("upstream epoch fetch failed: {error}")))?;
    let bytes = read_upstream_body(response, UPSTREAM_EPOCH_BUDGET).await?;
    let frame: GroupEpochFrame = serde_json::from_slice(&bytes)
        .map_err(|error| GroupError::Storage(format!("invalid upstream epoch JSON: {error}")))?;
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
        match store.get_mirror_state(&group_id) {
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
        let local_epoch = match query.epoch {
            Some(epoch) => store.get_epoch(&group_id, epoch),
            None => store.get_current_epoch(&group_id),
        };
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
            Err(e) => {
                return group_error_response(GroupError::Storage(format!(
                    "upstream proxy error: {e}"
                )))
            }
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
                    return group_error_response(GroupError::Storage(format!(
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
    body: Bytes,
) -> Response {
    let bus = server.event_bus().clone();
    let store = match registry_group_store(&server).await {
        Ok(s) => s,
        Err(e) => return group_error_response(e),
    };
    let response = put_group_message_impl(store, group_id.clone(), headers, body).await;
    if response.status().is_success() {
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
    Extension(bus): Extension<std::sync::Arc<dyn crate::events::RelayEventBus>>,
    body: Bytes,
) -> Response {
    let response = put_group_message_impl(store, group_id.clone(), headers, body).await;
    if response.status().is_success() {
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
    group_id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let group_id = group_id.to_lowercase();
    if let Err(e) = parse_group_id_hex(&group_id) {
        return group_error_response(e);
    }
    let envelope = match decode_message_envelope(&headers, &body) {
        Ok(env) => env,
        Err(e) => return group_error_response(e),
    };

    // If this group is hosted on a foreign upstream relay, proxy the write server-to-server
    // so the foreign relay only ever sees the Home Relay's IP.
    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let (upstream, client) = match upstream_transport(&store, &group_id, upstream_raw).await {
            Ok(transport) => transport,
            Err(error) => return group_error_response(error),
        };
        let url = format!("{upstream}/groups/{group_id}/messages");
        let payload = serde_json::to_vec(&envelope).unwrap_or_default();
        let resp = match client
            .put(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return group_error_response(GroupError::Storage(format!(
                    "upstream proxy error: {e}"
                )))
            }
        };
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
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

    match store.put_message(&group_id, envelope) {
        Ok(stored) => (
            StatusCode::OK,
            [(
                header::HeaderName::from_static(HEADER_GROUP_RELAY_MODE),
                HeaderValue::from_static("local"),
            )],
            Json(stored),
        )
            .into_response(),
        Err(e) => group_error_response(e),
    }
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
        match store.get_current_epoch(&group_id) {
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
                return group_error_response(GroupError::Storage(format!(
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
                return group_error_response(GroupError::Storage(format!(
                    "invalid upstream read JSON: {error}"
                )))
            }
        };
        if upstream_body.group_id != group_id || upstream_body.epoch != upstream_epoch.epoch {
            return group_error_response(GroupError::Forbidden(
                "upstream response does not match authenticated group epoch".into(),
            ));
        }
        let mirror_state = match store.record_foreign_subscriber(
            &group_id,
            &upstream,
            header_str(&headers, HEADER_GROUP_SUBSCRIBER_TAG),
            &upstream_epoch,
            read_token,
        ) {
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
                return group_error_response(GroupError::Storage(format!(
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
                return group_error_response(GroupError::Storage(format!(
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
            match store.get_epoch(&group_id, epoch) {
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
            if let Err(error) = store.ingest_mirrored_upstream(&group_id, Some(frame), &[]) {
                return group_error_response(error);
            }
        }
        if let Err(e) =
            store.ingest_mirrored_upstream(&group_id, Some(upstream_epoch), &synced_batch.messages)
        {
            return group_error_response(e);
        }

        // Serve directly from the local mirrored GroupStore!
        let current_epoch = match store.verify_read_token(&group_id, read_token) {
            Ok(ep) => ep,
            Err(e) => return group_error_response(e),
        };
        let messages = match store.list_messages(&group_id, after_seq, limit) {
            Ok(m) => m,
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
    let current_epoch = match store.verify_read_token(&group_id, read_token) {
        Ok(ep) => ep,
        Err(e) => return group_error_response(e),
    };
    let messages = match store.list_messages(&group_id, after_seq, limit) {
        Ok(m) => m,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{groups::derive_group_id, kv_store::MemoryKvStore};
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
            upstream_transport(&GroupStore::new_in_memory(), &"00".repeat(32), &origin)
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
        let app = router_with_store(GroupStore::new_in_memory());
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
        let store = GroupStore::new_in_memory();
        let app = router_with_store(store);

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
                    .body(Body::from(serde_json::to_vec(&msg).unwrap()))
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
                    .body(Body::from(serde_json::to_vec(&bad_msg).unwrap()))
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
        let upstream = GroupStore::new_in_memory();
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
                .serve(router_with_store(upstream).into_make_service())
                .await
                .unwrap();
        });
        let home = GroupStore::with_mirror_threshold(Arc::new(MemoryKvStore::new()), 1);
        let router = router_with_store(home.clone());
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
        let task = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router_with_store(store).into_make_service())
                .await
                .unwrap();
        });
        (origin, task)
    }

    #[tokio::test]
    async fn foreign_latest_refresh_and_write_ack_preserve_contiguous_backlog() {
        let upstream = GroupStore::new_in_memory();
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
        let home = GroupStore::with_mirror_threshold(Arc::new(MemoryKvStore::new()), 1);
        let router = router_with_store(home.clone());
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
                    .body(Body::from(serde_json::to_vec(&message(4)).unwrap()))
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
        let (origin, origin_task) = spawn_group_router(GroupStore::new_in_memory()).await;
        let (home, home_task) = spawn_group_router(GroupStore::new_in_memory()).await;
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
        let upstream_store = GroupStore::new_in_memory();
        let upstream_app = router_with_store(upstream_store.clone());
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
        let home_store = GroupStore::with_mirror_threshold(Arc::new(MemoryKvStore::new()), 2);
        let home_app = router_with_store(home_store.clone());

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
                    .body(Body::from(serde_json::to_vec(&local_message).unwrap()))
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
}
