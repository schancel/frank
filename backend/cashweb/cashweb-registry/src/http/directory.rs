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
    announcements: Arc<tokio::sync::Semaphore>,
}
use crate::directory_runtime::MAX_ENTRY_BYTES;
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
fn from_relay(headers: &HeaderMap) -> bool {
    headers.contains_key(crate::directory_federation::REPLICA_HEADER)
}
/// `GET …/{P}/head`, `…/{P}/chain` and `…/address/{0x-address}` share one route shape.
async fn lookup(
    Extension(routes): Extension<Arc<Routes>>,
    Path((network, first, second)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let runtime = &routes.runtime;
    // A key or address this relay does not hold is looked for on its peers before it is called
    // unknown. A peer asking on its own behalf is answered from what is held.
    let peers = runtime
        .federation()
        .filter(|_| !from_relay(&headers) && network == runtime.info().network);
    if first == "address" {
        let Ok(address) = crate::monad_http::Address::from_hex(&second) else {
            return error(RuntimeError::Invalid);
        };
        let mut subject = runtime.subject_for_address(&network, &address.0);
        if let (None, Some(peers)) = (&subject, peers) {
            subject = peers.learn_address(runtime, &network, address).await;
        }
        let Some(subject) = subject else {
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
    if !crate::directory_runtime::valid_key(&network, &first) {
        return error(RuntimeError::Invalid);
    }
    match second.as_str() {
        "head" => {
            if let Some(peers) = peers {
                peers.learn(runtime, &network, &first).await;
            }
            evidence(current(&routes, &network, &first).await)
        }
        // Every record held for the key, as one CBOR array of byte strings, for a peer relay
        // to verify. Served whether or not the head is still current.
        "chain" => match runtime.reserve(&network, &first) {
            Err(e) => error(e),
            Ok(slot) => match runtime.submit(slot, Operation::Chain).wait().await {
                Err(e) => error(e),
                Ok(chain) => (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, "application/cbor"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    chain.attestation,
                )
                    .into_response(),
            },
        },
        _ => error(RuntimeError::NotFound),
    }
}
#[derive(serde::Deserialize)]
struct ListQuery {
    after: Option<String>,
    limit: Option<usize>,
}
/// One page of the keys this relay holds, in key order, with head hash and record count, so a
/// peer can see what differs from its own copy.
async fn subjects(
    Extension(routes): Extension<Arc<Routes>>,
    Path(network): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Response {
    let limit = query.limit.unwrap_or(256).clamp(1, 256);
    let Some(page) = routes.runtime.list(&network, query.after.as_deref(), limit) else {
        return error(RuntimeError::Invalid);
    };
    let next = (page.len() == limit)
        .then(|| page.last().map(|row| row.0.clone()))
        .flatten();
    Json(serde_json::json!({
        "subjects": page.into_iter().map(|(subject, head, retained, forked)| serde_json::json!({
            "subject": subject, "head": head, "retained": retained, "forked": forked,
        })).collect::<Vec<_>>(),
        "next": next,
    }))
    .into_response()
}
/// A peer says a key's chain changed there. This relay then copies it from its own configured
/// peers; the request itself carries nothing that has to be believed.
async fn announce(
    Extension(routes): Extension<Arc<Routes>>,
    Path((network, subject, leaf)): Path<(String, String, String)>,
) -> Response {
    let runtime = routes.runtime.clone();
    if leaf != "announce" || !crate::directory_runtime::valid_key(&network, &subject) {
        return error(RuntimeError::NotFound);
    }
    let Some(federation) = runtime.federation().cloned() else {
        return error(RuntimeError::NotFound);
    };
    if let Ok(permit) = routes.announcements.clone().try_acquire_owned() {
        tokio::spawn(async move {
            federation.announced(&runtime, &network, &subject).await;
            drop(permit);
        });
    }
    StatusCode::ACCEPTED.into_response()
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
    // Before a first entry for a key is accepted here, peers are asked whether the key already
    // has a chain. If it has, that chain is copied first, so an account restored on this relay
    // gets 409 for a fresh revision 0 and adopts its existing entry instead of forking itself.
    if let Some(peers) = runtime.federation().filter(|_| !from_relay(&headers)) {
        peers.learn(runtime, &network, &subject).await;
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
    let result = runtime.submit(slot, Operation::Put(bytes)).wait().await;
    if let (Ok(_), Some(peers)) = (&result, runtime.federation()) {
        peers.announce(&network, &subject);
    }
    evidence(result)
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
            // True only when the operator enabled it and it is running.
            "forwarding": routes.runtime.federation().is_some_and(|peers| peers.forwarding()),
        })),
    )
        .into_response()
}
/// Mount the open directory. Present whenever the relay has a `[registry.directory]` tuple.
pub fn router(runtime: Arc<DirectoryRuntime>) -> Router {
    let routes = Arc::new(Routes {
        enrollments: FixedHourQuota::new(runtime.enrollments_per_source_per_hour()),
        announcements: Arc::new(tokio::sync::Semaphore::new(4)),
        runtime,
    });
    Router::new()
        .route(
            "/directory/v1/:network/:subject/:leaf",
            routing::get(lookup).put(put).post(announce),
        )
        .route("/directory/v1/:network/subjects", routing::get(subjects))
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
