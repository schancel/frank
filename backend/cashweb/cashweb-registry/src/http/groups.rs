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
    let parsed = url::Url::parse(raw).map_err(|e| {
        GroupError::InvalidInput(format!("invalid X-Group-Upstream-Relay URL: {e}"))
    })?;
    match parsed.scheme() {
        "http" | "https" => Ok(raw.trim_end_matches('/').to_string()),
        _ => Err(GroupError::InvalidInput(
            "X-Group-Upstream-Relay must use http or https".into(),
        )),
    }
}

/// Build the `/groups/:group_id/*` router using the server's `Registry` group store.
pub fn router() -> Router {
    Router::new()
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
            "/groups/:group_id/epochs",
            routing::put(handle_put_group_epoch_store).get(handle_get_group_epoch_store),
        )
        .route(
            "/groups/:group_id/messages",
            routing::put(handle_put_group_message_store).get(handle_get_group_messages_store),
        )
        .layer(Extension(store))
}

async fn handle_put_group_epoch(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    body: Bytes,
) -> Response {
    let store = match server.registry.groups() {
        Ok(s) => s.clone(),
        Err(e) => return group_error_response(e),
    };
    put_group_epoch_impl(store, group_id, headers, body).await
}

async fn handle_put_group_epoch_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    body: Bytes,
) -> Response {
    put_group_epoch_impl(store, group_id, headers, body).await
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
        let upstream = match validate_upstream_url(upstream_raw) {
            Ok(u) => u,
            Err(e) => return group_error_response(e),
        };
        let client = reqwest::Client::new();
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
        let resp_bytes = resp.bytes().await.unwrap_or_default();
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
    let store = match server.registry.groups() {
        Ok(s) => s.clone(),
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

    let local_epoch = match query.epoch {
        Some(e) => store.get_epoch(&group_id, e),
        None => store.get_current_epoch(&group_id),
    };
    match local_epoch {
        Ok(Some(frame)) => return (StatusCode::OK, Json(frame)).into_response(),
        Err(e) => return group_error_response(e),
        Ok(None) => {}
    }

    if let Some(upstream_raw) = header_str(&headers, HEADER_GROUP_UPSTREAM_RELAY) {
        let upstream = match validate_upstream_url(upstream_raw) {
            Ok(u) => u,
            Err(e) => return group_error_response(e),
        };
        let client = reqwest::Client::new();
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
        let resp_bytes = resp.bytes().await.unwrap_or_default();
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
    let store = match server.registry.groups() {
        Ok(s) => s.clone(),
        Err(e) => return group_error_response(e),
    };
    put_group_message_impl(store, group_id, headers, body).await
}

async fn handle_put_group_message_store(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    Extension(store): Extension<GroupStore>,
    body: Bytes,
) -> Response {
    put_group_message_impl(store, group_id, headers, body).await
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
        let upstream = match validate_upstream_url(upstream_raw) {
            Ok(u) => u,
            Err(e) => return group_error_response(e),
        };
        let client = reqwest::Client::new();
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
        let resp_bytes = resp.bytes().await.unwrap_or_default();
        if status.is_success() {
            if let Ok(stored_msg) = serde_json::from_slice::<StoredGroupMessage>(&resp_bytes) {
                if let Ok(Some(mirror)) = store.get_mirror_state(&group_id) {
                    if mirror.mirrored {
                        let _ = store.ingest_mirrored_upstream(&group_id, None, &[stored_msg]);
                    }
                }
            }
        }
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
    let store = match server.registry.groups() {
        Ok(s) => s.clone(),
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
        let upstream = match validate_upstream_url(upstream_raw) {
            Ok(u) => u,
            Err(e) => return group_error_response(e),
        };
        let subscriber_tag =
            header_str(&headers, HEADER_GROUP_SUBSCRIBER_TAG).unwrap_or(read_token);
        let mirror_state =
            match store.record_foreign_subscriber(&group_id, &upstream, subscriber_tag) {
                Ok(state) => state,
                Err(e) => return group_error_response(e),
            };

        let client = reqwest::Client::new();
        if !mirror_state.mirrored {
            // `< mirror_threshold` local subscribers: Stateless Oblivious Proxy mode!
            let url = format!(
                "{}/groups/{}/messages?after_seq={}&limit={}",
                mirror_state.upstream_relay, group_id, after_seq, limit
            );
            let resp = match client
                .get(&url)
                .header(HEADER_GROUP_READ_TOKEN, read_token)
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
            if !resp.status().is_success() {
                let status =
                    StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                let body = resp.bytes().await.unwrap_or_default();
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
            let resp_bytes = resp.bytes().await.unwrap_or_default();
            let mut upstream_body: GroupMessagesResponse = match serde_json::from_slice(&resp_bytes)
            {
                Ok(b) => b,
                Err(e) => {
                    return group_error_response(GroupError::Storage(format!(
                        "invalid upstream response JSON: {e}"
                    )))
                }
            };
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
        let epoch_url = format!("{}/groups/{}/epochs", mirror_state.upstream_relay, group_id);
        let upstream_epoch = match client.get(&epoch_url).send().await {
            Ok(r) if r.status().is_success() => {
                let bytes = r.bytes().await.unwrap_or_default();
                serde_json::from_slice::<GroupEpochFrame>(&bytes).ok()
            }
            _ => None,
        };
        let sync_url = format!(
            "{}/groups/{}/messages?after_seq={}&limit=500",
            mirror_state.upstream_relay, group_id, mirror_state.last_synced_seq
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
            let body = upstream_msgs_resp.bytes().await.unwrap_or_default();
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
        let synced_bytes = upstream_msgs_resp.bytes().await.unwrap_or_default();
        let synced_batch: GroupMessagesResponse = match serde_json::from_slice(&synced_bytes) {
            Ok(b) => b,
            Err(e) => {
                return group_error_response(GroupError::Storage(format!(
                    "invalid upstream mirror sync JSON: {e}"
                )))
            }
        };
        if let Err(e) =
            store.ingest_mirrored_upstream(&group_id, upstream_epoch, &synced_batch.messages)
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

    fn sign_digest(sk: &SecretKey, digest: &[u8; 32]) -> String {
        let secp = Secp256k1::new();
        let msg = SecpMessage::from_slice(digest).unwrap();
        let sig = secp.sign(&msg, sk);
        hex::encode(sig.serialize_compact())
    }

    #[tokio::test]
    async fn http_epochs_cas_and_sealed_sender_messages_enforce_w_g_e() {
        let store = GroupStore::new_in_memory();
        let app = router_with_store(store);

        let (_, group_pk) = keypair(5);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (write_sk_0, write_pk_0) = keypair(50);
        let read_token_0 = hex::encode([0x42u8; 32]);
        let read_token_hash_0 = hex::encode(Sha256::digest([0x42u8; 32]));

        let epoch0 = GroupEpochFrame {
            group_id: group_id.clone(),
            epoch: 0,
            prev_epoch_hash: "00".repeat(32),
            write_pubkey: hex::encode(write_pk_0),
            read_token_hash: read_token_hash_0,
            encrypted_epoch_descriptor: hex::encode(b"epoch-0-desc"),
            admin_sig: "ab".repeat(64),
            epoch_hash: String::new(),
        };

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
        let (_, group_pk) = keypair(7);
        let group_id = hex::encode(derive_group_id(&group_pk));
        let (write_sk, write_pk) = keypair(70);
        let read_token_bytes = [0x77u8; 32];
        let read_token_hex = hex::encode(read_token_bytes);
        let read_token_hash = hex::encode(Sha256::digest(read_token_bytes));

        upstream_store
            .put_epoch(
                &group_id,
                GroupEpochFrame {
                    group_id: group_id.clone(),
                    epoch: 0,
                    prev_epoch_hash: "00".repeat(32),
                    write_pubkey: hex::encode(write_pk),
                    read_token_hash,
                    encrypted_epoch_descriptor: hex::encode(b"foreign-desc"),
                    admin_sig: "11".repeat(64),
                    epoch_hash: String::new(),
                },
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

        // Create a Home Relay (`Relay_Home`) with `mirror_threshold = 2`
        let home_store = GroupStore::with_mirror_threshold(Arc::new(MemoryKvStore::new()), 2);
        let home_app = router_with_store(home_store.clone());

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
        assert_eq!(sub1_body.messages.len(), 1);
        // Verify `Relay_Home` has NOT mirrored the group into local storage yet
        assert!(home_store.get_current_epoch(&group_id).unwrap().is_none());

        // Subscriber 2 (`sub-bob`) queries `Relay_Home` (>= 2 subscribers) -> Auto-Mirror Promotion!
        let res_sub2 = home_app
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
        assert_eq!(sub2_body.messages.len(), 1);

        // Verify `Relay_Home` now holds a local mirror of both the epoch metadata and messages!
        assert!(home_store.get_current_epoch(&group_id).unwrap().is_some());
        let mirrored_msgs = home_store.list_messages(&group_id, 0, 10).unwrap();
        assert_eq!(mirrored_msgs.len(), 1);
        assert_eq!(mirrored_msgs[0].server_seq, 1);
    }
}
