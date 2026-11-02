//! Exact CBOR directory routes. Bounded authenticated preparation precedes quota admission.
//!
//! Publishing is open: any key may PUT its own signed entry. The only gates are the signature,
//! the chain rules, a relay-wide subject cap and a per-source limit on first publications.
use super::hourly_quota::{normalize_quota_ip, FixedHourQuota, QuotaBackend, QuotaDomain};
use crate::directory_runtime::{
    DirectoryRuntime, Evidence, Operation, RuntimeError, FIRST_ACCEPTED_POSITION_BYTES,
};
use axum::{
    body::{Body, HttpBody},
    extract::{connect_info::ConnectInfo, Extension, FromRequest, Path, RequestParts},
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{from_fn, Next},
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
        let Ok(address) = crate::evm_rpc::Address::from_hex(&second) else {
            return error(RuntimeError::Invalid);
        };
        let Some(subject) = routes
            .runtime
            .subject_for_address(&network, &address.0)
            .await
        else {
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
struct PreparedDirectoryPut {
    network: String,
    subject: String,
    bytes: Vec<u8>,
}

async fn prepare_put(request: Request<Body>, next: Next<Body>) -> Response {
    let Some(routes) = request.extensions().get::<Arc<Routes>>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .cloned();
    let mut parts = RequestParts::new(request);
    let Path((network, subject, leaf)) =
        match Path::<(String, String, String)>::from_request(&mut parts).await {
            Ok(path) => path,
            Err(rejection) => return rejection.into_response(),
        };
    let request = match parts.try_into_request() {
        Ok(request) => request,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let headers = request.headers().clone();
    let (parts, mut body) = request.into_parts();
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
    if let Some(fed) = runtime.federation() {
        if fed.check_inbound_federation(&headers).await.is_err() {
            return error(RuntimeError::Invalid);
        }
    }
    // Publishing is free, so a key this relay has never seen is charged to its source, and only
    // once the entry is known to be signed by that key: a forgery costs its sender nothing here
    // and cannot use up anyone's allowance.
    let mut prepared = super::quota_middleware::PreparedQuota::<IpAddr>::Exempt;
    if !runtime.is_published(&network, &subject).await {
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
        prepared = super::quota_middleware::PreparedQuota::Charge {
            payer: routes.source(peer, &headers),
            units: 1,
        };
    }
    // The only body read and signature verification happened above. The generic layer
    // touches neither bytes nor authentication. The mutation consumes this exact owned body.
    let mut request = Request::from_parts(parts, Body::empty());
    request.extensions_mut().insert(prepared);
    request.extensions_mut().insert(PreparedDirectoryPut {
        network,
        subject,
        bytes,
    });
    next.run(request).await
}
async fn put(Extension(routes): Extension<Arc<Routes>>, mut request: Request<Body>) -> Response {
    let Some(PreparedDirectoryPut {
        network,
        subject,
        bytes,
    }) = request.extensions_mut().remove::<PreparedDirectoryPut>()
    else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let runtime = &routes.runtime;
    let slot = match runtime.reserve(&network, &subject) {
        Ok(s) => s,
        Err(e) => return error(e),
    };
    evidence(runtime.submit(slot, Operation::Put(bytes)).wait().await)
}
/// The relay-wide tuple an account embeds in its own entry.
async fn info(Extension(routes): Extension<Arc<Routes>>) -> Response {
    let info = routes.runtime.info();
    let mut val = serde_json::json!({
        "network": info.network,
        "relayId": hex::encode(&info.binding.relay_id),
        "endpoint": info.binding.endpoint,
        "relayKey": hex::encode(&info.binding.identity.key_bytes),
        "bindingExpiry": info.binding_expiry_ns(),
        // Whether this relay accepts a message for a recipient whose entry names another
        // relay and forwards it there. While false such a message is answered as undeliverable.
        "forwarding": false,
    });
    if let Some(gateway) = &info.email_gateway {
        val["emailGateway"] = serde_json::json!({
            "address": gateway.address,
            "domain": gateway.domain,
        });
    }
    if let Some(fed) = routes.runtime.federation() {
        if let Some(coord) = fed.cluster_coordinator() {
            if let Ok(lock) = coord.try_lock() {
                if let Some(cid) = lock.cluster_id() {
                    val["clusterId"] = serde_json::Value::String(cid.to_string());
                }
                if let Some(auth) = lock.cluster_authority_pubkey() {
                    val["clusterAuthorityPubkey"] = serde_json::Value::String(hex::encode(auth));
                }
                if let Some(desc) = lock.my_descriptor() {
                    val["clusterName"] = serde_json::Value::String(desc.cluster_name.clone());
                    val["clusterDescriptor"] = serde_json::to_value(desc).unwrap_or_default();
                }
            }
        }
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(val)).into_response()
}
/// Most accounts one listing of new accounts returns.
const NEW_ACCOUNTS_PAGE: usize = 100;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NewAccountsQuery {
    /// Unix milliseconds, inclusive. Used when no `after` is given. Defaults to 0.
    since: Option<u64>,
    /// The `cursor` of an earlier answer: continue strictly after it.
    after: Option<String>,
    /// At most this many positions are read; 1 to 100, default 100.
    limit: Option<usize>,
}
/// `GET /directory/v1/{network}/accounts?since=<ms>|after=<cursor>[&limit=<n>]`: addresses whose
/// first entry this relay accepted, oldest first. Public data only (address and time); a caller
/// that wants to message one still looks its entry up and verifies it.
async fn new_accounts(
    Extension(routes): Extension<Arc<Routes>>,
    Path(network): Path<String>,
    query: Result<axum::extract::Query<NewAccountsQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(axum::extract::Query(query)) = query else {
        return error(RuntimeError::Invalid);
    };
    let limit = query.limit.unwrap_or(NEW_ACCOUNTS_PAGE);
    if limit == 0 || limit > NEW_ACCOUNTS_PAGE {
        return error(RuntimeError::Invalid);
    }
    let after = match query.after.as_deref().map(hex::decode) {
        None => None,
        Some(Ok(bytes)) => match <[u8; FIRST_ACCEPTED_POSITION_BYTES]>::try_from(bytes) {
            Ok(position) => Some(position),
            Err(_) => return error(RuntimeError::Invalid),
        },
        Some(Err(_)) => return error(RuntimeError::Invalid),
    };
    let Some((accounts, cursor)) = routes
        .runtime
        .first_accepted(&network, query.since.unwrap_or(0), after.as_ref(), limit)
        .await
    else {
        return error(RuntimeError::NotFound);
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "accounts": accounts
                .iter()
                .map(|account| serde_json::json!({
                    "address": format!("0x{}", hex::encode(account.address)),
                    "acceptedMs": account.accepted_ms,
                }))
                .collect::<Vec<_>>(),
            // Pass this back as `after` to read what came later; absent while nothing was read.
            "cursor": cursor.map(hex::encode),
        })),
    )
        .into_response()
}
/// Mount the open directory. Present whenever the relay has a `[registry.directory]` tuple.
pub fn router(runtime: Arc<DirectoryRuntime>, quota_backend: QuotaBackend) -> Router {
    let policy = Arc::new(super::quota_middleware::QuotaPolicy::new(
        FixedHourQuota::<IpAddr>::with_backend(
            runtime.enrollments_per_source_per_hour(),
            QuotaDomain::DirectoryEnrollment,
            quota_backend,
        ),
        |_| error(RuntimeError::Resource),
    ));
    let routes = Arc::new(Routes { runtime });
    let publish = routing::put(put)
        .route_layer(from_fn(super::quota_middleware::admit::<IpAddr>))
        .route_layer(Extension(policy))
        .route_layer(from_fn(prepare_put));
    Router::new()
        .route(
            "/directory/v1/:network/:subject/:leaf",
            routing::get(lookup).merge(publish),
        )
        .route(
            "/directory/v1/:network/:subject/statements/:t1",
            routing::get(historical),
        )
        .route(
            "/directory/v1/:network/accounts",
            routing::get(new_accounts),
        )
        .route("/relay/v1/info", routing::get(info))
        .layer(Extension(routes))
}
#[cfg(test)]
#[path = "directory_tests.rs"]
pub(crate) mod tests;
