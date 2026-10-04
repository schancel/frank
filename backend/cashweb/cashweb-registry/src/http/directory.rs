//! Exact CBOR directory routes. Capacity is reserved before request-body collection.
//!
//! Publishing is open: any key may PUT its own signed entry. The only gates are the signature,
//! the chain rules, a relay-wide subject cap and a per-source limit on first publications.
use super::hourly_quota::{normalize_quota_ip, FixedHourQuota};
use crate::directory_runtime::{DirectoryRuntime, Evidence, Operation, RuntimeError};
use axum::{
    body::HttpBody,
    extract::{connect_info::ConnectInfo, Extension, Path, RawBody},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing, Json, Router,
};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
const MEDIA: &str = "application/vnd.frank.cbor";
pub(crate) fn error(e: RuntimeError) -> Response {
    let (status, text) = match e {
        RuntimeError::Busy => (StatusCode::TOO_MANY_REQUESTS, "busy/not-started"),
        RuntimeError::NotStarted => (StatusCode::SERVICE_UNAVAILABLE, "unavailable/not-started"),
        RuntimeError::OutcomeUnknown => (
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable/outcome-unknown",
        ),
        RuntimeError::NotFound => (StatusCode::NOT_FOUND, "not-found"),
        RuntimeError::Invalid => (StatusCode::BAD_REQUEST, "invalid"),
        RuntimeError::Trust | RuntimeError::Forked => (StatusCode::CONFLICT, "trust/continuity"),
        RuntimeError::Expired => (StatusCode::CONFLICT, "expired"),
        RuntimeError::Resource => (StatusCode::TOO_MANY_REQUESTS, "capacity"),
    };
    (
        status,
        [
            (header::CONTENT_TYPE, "text/plain"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::HeaderName::from_static("x-frank-directory-disposition"),
                match e {
                    RuntimeError::Busy | RuntimeError::NotStarted => "not-started",
                    RuntimeError::OutcomeUnknown => "outcome-unknown",
                    _ => "rejected",
                },
            ),
        ],
        text,
    )
        .into_response()
}
fn evidence(result: std::result::Result<Evidence, RuntimeError>) -> Response {
    match result {
        Err(e) => error(e),
        Ok(e) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, MEDIA),
                (header::CACHE_CONTROL, "no-store"),
                (
                    header::HeaderName::from_static("x-frank-directory-evidence"),
                    if e.historical {
                        "historical"
                    } else {
                        "fresh-current"
                    },
                ),
            ],
            e.attestation,
        )
            .into_response(),
    }
}
/// Shared state of the directory routes.
#[derive(Debug)]
pub(crate) struct Routes {
    pub(crate) runtime: Arc<DirectoryRuntime>,
    enrollments: FixedHourQuota<IpAddr>,
}
/// Largest directory entry accepted over HTTP. An ordinary entry is under 600 bytes.
pub(crate) const MAX_ENTRY_BYTES: usize = 8 * 1024;
impl Routes {
    /// The address a first publication is charged to: the connecting address, or, only when
    /// that address is a reverse proxy the operator listed, the client that proxy reports.
    fn source(&self, peer: Option<ConnectInfo<SocketAddr>>, headers: &HeaderMap) -> IpAddr {
        let peer = peer.map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |peer| peer.0.ip());
        let forwarded = if self
            .runtime
            .trusted_proxies()
            .contains(&normalize_quota_ip(peer))
        {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.rsplit(',').next())
                .and_then(|value| value.trim().parse::<IpAddr>().ok())
        } else {
            None
        };
        normalize_quota_ip(forwarded.unwrap_or(peer))
    }
}
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
async fn current(routes: &Routes, network: &str, subject: &str) -> Result<Evidence, RuntimeError> {
    let slot = routes.runtime.reserve(network, subject)?;
    routes.runtime.submit(slot, Operation::Current).wait().await
}
/// `GET …/{P}/head` and `GET …/address/{0x-address}` share one route shape.
async fn lookup(
    Extension(routes): Extension<Arc<Routes>>,
    Path((network, first, second)): Path<(String, String, String)>,
) -> Response {
    if first == "address" {
        let Ok(address) = crate::monad_http::Address::from_hex(&second) else {
            return error(RuntimeError::Invalid);
        };
        let Some(subject) = routes.runtime.subject_for_address(&network, &address.0) else {
            return error(RuntimeError::NotFound);
        };
        let mut response = evidence(current(&routes, &network, &subject).await);
        if response.status() == StatusCode::OK {
            response.headers_mut().insert(
                header::HeaderName::from_static("x-frank-directory-subject"),
                subject.parse().expect("hex"),
            );
        }
        return response;
    }
    if second != "head" {
        return error(RuntimeError::NotFound);
    }
    evidence(current(&routes, &network, &first).await)
}
async fn historical(
    Extension(routes): Extension<Arc<Routes>>,
    Path((network, subject, t1)): Path<(String, String, String)>,
) -> Response {
    let runtime = &routes.runtime;
    if t1.len() != 64
        || !t1
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return error(RuntimeError::Invalid);
    }
    let hash = hex::decode(t1).unwrap().try_into().unwrap();
    match runtime.reserve(&network, &subject) {
        Err(e) => error(e),
        Ok(slot) => evidence(
            runtime
                .submit(slot, Operation::Historical(hash))
                .wait()
                .await,
        ),
    }
}
async fn put(
    Extension(routes): Extension<Arc<Routes>>,
    Path((network, subject, leaf)): Path<(String, String, String)>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    RawBody(mut body): RawBody,
) -> Response {
    let runtime = &routes.runtime;
    if leaf != "head" || subject == "address" {
        return error(RuntimeError::NotFound);
    }
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some(MEDIA)
    {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "media").into_response();
    }
    // The whole body is read before any of the directory's few queue slots is taken, so a slow
    // or stalled upload cannot hold one.
    let collect = async {
        let mut bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|_| RuntimeError::Invalid)?;
            if bytes.len() + chunk.len() > MAX_ENTRY_BYTES {
                return Err(RuntimeError::Resource);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    let bytes = match tokio::time::timeout(Duration::from_secs(5), collect).await {
        Err(_) => return error(RuntimeError::NotStarted),
        Ok(Err(e)) => return error(e),
        Ok(Ok(bytes)) => bytes,
    };
    if !crate::directory_runtime::valid_key(&network, &subject) {
        return error(RuntimeError::Invalid);
    }
    // Publishing is free, so a key this relay has never seen is charged to its source, and only
    // once the entry is known to be signed by that key: a forgery costs its sender nothing here
    // and cannot use up anyone's allowance.
    if !runtime.is_published(&network, &subject) {
        let signed_by_subject = frank_cbor::verify_preview_directory_evidence(&bytes, &network)
            .ok()
            .is_some_and(|verified| {
                matches!(
                    verified.statement_frame().typed.as_deref(),
                    Some(frank_cbor::TypedPayload::DirectoryStatement { subject: signer, .. })
                        if hex::encode(&signer.key_bytes) == subject
                )
            });
        if !signed_by_subject {
            return error(RuntimeError::Invalid);
        }
        if routes
            .enrollments
            .charge(routes.source(peer, &headers), 1, now_seconds())
            .is_err()
        {
            return error(RuntimeError::Resource);
        }
    }
    let slot = match runtime.reserve(&network, &subject) {
        Ok(s) => s,
        Err(e) => return error(e),
    };
    evidence(runtime.submit(slot, Operation::Put(bytes)).wait().await)
}
/// The relay-wide tuple an account embeds in its own entry.
async fn info(Extension(routes): Extension<Arc<Routes>>) -> Response {
    let info = routes.runtime.info();
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "network": info.network,
            "relayId": hex::encode(&info.binding.relay_id),
            "endpoint": info.binding.endpoint,
            "relayKey": hex::encode(&info.binding.identity.key_bytes),
            "bindingExpiry": info.binding_expiry_ns(),
            // Whether this relay accepts a message for a recipient whose entry names another
            // relay and forwards it there. While false such a message is answered as undeliverable.
            "forwarding": false,
        })),
    )
        .into_response()
}
/// Mount the open directory. Present whenever the relay has a `[registry.directory]` tuple.
pub fn router(runtime: Arc<DirectoryRuntime>) -> Router {
    let routes = Arc::new(Routes {
        enrollments: FixedHourQuota::new(runtime.enrollments_per_source_per_hour()),
        runtime,
    });
    Router::new()
        .route(
            "/directory/v1/:network/:subject/:leaf",
            routing::get(lookup).put(put),
        )
        .route(
            "/directory/v1/:network/:subject/statements/:t1",
            routing::get(historical),
        )
        .route("/relay/v1/info", routing::get(info))
        .layer(Extension(routes))
}
#[cfg(test)]
#[path = "directory_tests.rs"]
pub(crate) mod tests;
