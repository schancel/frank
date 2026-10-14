//! Content-addressed encrypted blob store (`PUT /blobs/:sha256`, `HEAD /blobs/:sha256`,
//! `GET /blobs/:sha256`) and SSRF-safe server-to-server Home-Relay proxy (`?origin=<relay_url>`).

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Path, Query, RawBody},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use futures::StreamExt;
use hyper::body::HttpBody;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::http::server::RegistryServer;

/// Maximum encrypted blob chunk size accepted or proxied by a relay (512 KB).
pub const MAX_BLOB_CHUNK_BYTES: usize = 512 * 1024;

/// Cache-Control header value for content-addressed immutable ciphertext chunks.
pub const BLOB_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Optional request header carrying the foreign origin relay hint on `GET /blobs/:sha256`.
pub const BLOB_ORIGIN_HEADER: &str = "x-blob-origin-relay";

const STORE_EXTENSION: &str = "blobs-v1";
const UPSTREAM_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Content-addressed blob store. The lazy RocksDB sidecar (`*.blobs-v1`) is the sole
/// owner of blob bytes; requests retain no permanent in-memory copy.
#[derive(Debug)]
pub struct BlobStore {
    db_path: PathBuf,
    rocks: OnceLock<rocksdb::DB>,
    rocks_lock: Mutex<()>,
    allow_loopback_origins: AtomicBool,
}

impl BlobStore {
    /// Creates a new [`BlobStore`] whose RocksDB directory sits beside `registry_db_path`.
    pub fn new(registry_db_path: PathBuf) -> Self {
        Self {
            db_path: registry_db_path.with_extension(STORE_EXTENSION),
            rocks: OnceLock::new(),
            rocks_lock: Mutex::new(()),
            allow_loopback_origins: AtomicBool::new(false),
        }
    }

    /// Enables or disables loopback (`127.0.0.1` / `localhost` / `[::1]`) and `http://` origins
    /// for local multi-relay integration tests. Private/link-local/metadata IPs remain blocked.
    pub fn set_allow_loopback_origins(&self, allow: bool) {
        self.allow_loopback_origins.store(allow, Ordering::SeqCst);
    }

    /// Returns whether loopback origins are permitted for server-to-server blob proxying.
    pub fn allow_loopback_origins(&self) -> bool {
        self.allow_loopback_origins.load(Ordering::SeqCst)
    }

    fn open_rocks(&self) -> Result<&rocksdb::DB, rocksdb::Error> {
        if let Some(db) = self.rocks.get() {
            return Ok(db);
        }
        let _guard = self
            .rocks_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(db) = self.rocks.get() {
            return Ok(db);
        }
        let mut opts = rocksdb::Options::default();
        opts.create_if_missing(true);
        let db = rocksdb::DB::open(&opts, &self.db_path)?;
        let _ = self.rocks.set(db);
        Ok(self.rocks.get().expect("database initialized under lock"))
    }

    /// Looks up a verified blob without hiding storage failures as cache misses.
    pub fn get(&self, hash: &[u8; 32]) -> Result<Option<Vec<u8>>, rocksdb::Error> {
        if self.rocks.get().is_none() && !self.db_path.exists() {
            return Ok(None);
        }
        self.open_rocks()?.get(hash)
    }

    /// Idempotently persists a verified blob before acknowledgment. Synchronous WAL
    /// writes preserve successful uploads across process restart and host interruption.
    pub fn put(&self, hash: &[u8; 32], bytes: Vec<u8>) -> Result<(), rocksdb::Error> {
        let mut options = rocksdb::WriteOptions::default();
        options.set_sync(true);
        self.open_rocks()?.put_opt(hash, bytes, &options)
    }
}

/// Query parameters for `GET /blobs/:sha256`.
#[derive(Debug, Deserialize, Default)]
pub struct GetBlobQuery {
    /// Optional origin relay URL to proxy from on a local cache miss.
    pub origin: Option<String>,
}

#[derive(Debug, Serialize)]
struct BlobErrorBody {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
struct PutBlobResponseBody {
    sha256: String,
    size: usize,
}

fn error_response(
    status: StatusCode,
    error: &'static str,
    detail: impl Into<Option<String>>,
) -> Response {
    (
        status,
        Json(BlobErrorBody {
            error,
            detail: detail.into(),
        }),
    )
        .into_response()
}

fn storage_error_response() -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "blob_storage_failed",
        None,
    )
}

/// Resolve once, fail closed, and bind the actual connector to an approved address.
/// A fresh client avoids pooled connections from any other origin or DNS decision.
async fn origin_client<F, Fut>(
    origin: &Url,
    allow_loopback: bool,
    resolve: F,
) -> Result<reqwest::Client, (StatusCode, &'static str)>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .https_only(!allow_loopback)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(UPSTREAM_FETCH_TIMEOUT);
    if let Some(url::Host::Domain(domain)) = origin.host() {
        let addresses = tokio::time::timeout(
            UPSTREAM_FETCH_TIMEOUT,
            resolve(
                domain.to_string(),
                origin.port_or_known_default().unwrap_or(443),
            ),
        )
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "origin DNS lookup timed out"))?
        .map_err(|_| (StatusCode::BAD_GATEWAY, "origin DNS lookup failed"))?;
        let first = *addresses.first().ok_or((
            StatusCode::BAD_GATEWAY,
            "origin domain did not resolve to any IP address",
        ))?;
        if addresses
            .iter()
            .any(|address| is_forbidden_ip(address.ip(), allow_loopback))
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "origin domain resolved to a forbidden IP address",
            ));
        }
        // reqwest 0.11.11 supports one override per hostname. Pin the first
        // approved address, preserving the URL hostname for TLS SNI and Host.
        builder = builder.resolve(domain, first);
    }
    builder.build().map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "origin HTTP client initialization failed",
        )
    })
}

fn blob_ok_response(bytes: Vec<u8>, head_only: bool) -> Response {
    let len = bytes.len();
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(axum::body::boxed(body))
        .unwrap();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(BLOB_CACHE_CONTROL),
    );
    if let Ok(len_val) = HeaderValue::from_str(&len.to_string()) {
        headers.insert(header::CONTENT_LENGTH, len_val);
    }
    response
}

/// Strictly parses a 64-character lowercase hexadecimal SHA-256 digest.
pub fn parse_sha256_lower_hex(input: &str) -> Option<[u8; 32]> {
    if input.len() != 64 {
        return None;
    }
    if !input
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let decoded = hex::decode(input).ok()?;
    decoded.try_into().ok()
}

fn is_forbidden_ipv4(ip: Ipv4Addr, allow_loopback: bool) -> bool {
    if ip.is_loopback() {
        return !allow_loopback;
    }
    let octets = ip.octets();
    octets[0] == 0
        || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // RFC 6598 Carrier-Grade NAT (100.64.0.0/10)
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 64)
        // IETF protocol assignments & benchmarking (192.0.0.0/24, 198.18.0.0/15, 240.0.0.0/4)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || octets[0] >= 240
}

fn is_forbidden_ipv6(ip: Ipv6Addr, allow_loopback: bool) -> bool {
    if let Some(mapped_v4) = ip.to_ipv4_mapped() {
        return is_forbidden_ipv4(mapped_v4, allow_loopback);
    }
    if ip.is_loopback() {
        return !allow_loopback;
    }
    let segments = ip.segments();
    // Permit native global unicast only; reject deprecated transition and
    // special-purpose ranges that can carry private IPv4 destinations.
    (segments[0] & 0xe000) != 0x2000
        || (segments[0] == 0x2001 && segments[1] < 0x0200)
        || segments[0] == 0x2002
        || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
        || ip.is_unspecified()
        || ip.is_multicast()
        // Unique local (fc00::/7)
        || (segments[0] & 0xfe00) == 0xfc00
        // Link-local unicast (fe80::/10)
        || (segments[0] & 0xffc0) == 0xfe80
        // Documentation (2001:db8::/32)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn is_forbidden_ip(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_ipv4(v4, allow_loopback),
        IpAddr::V6(v6) => is_forbidden_ipv6(v6, allow_loopback),
    }
}

/// Validates a foreign relay origin URL against SSRF rules before server-to-server fetching.
pub fn validate_origin_relay_url(
    raw_origin: &str,
    allow_loopback: bool,
) -> Result<Url, &'static str> {
    let parsed = Url::parse(raw_origin).map_err(|_| "malformed origin URL")?;
    match parsed.scheme() {
        "https" => {}
        "http" if allow_loopback => {}
        "http" => return Err("origin URL must use https://"),
        _ => return Err("unsupported origin URL scheme"),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("origin URL must not contain credentials");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("origin URL must not contain query or fragment");
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        return Err("origin URL must not contain a path prefix");
    }
    let host = parsed.host().ok_or("origin URL missing host")?;
    match host {
        url::Host::Ipv4(v4) => {
            if is_forbidden_ipv4(v4, allow_loopback) {
                return Err("origin IPv4 address is forbidden by SSRF policy");
            }
        }
        url::Host::Ipv6(v6) => {
            if is_forbidden_ipv6(v6, allow_loopback) {
                return Err("origin IPv6 address is forbidden by SSRF policy");
            }
        }
        url::Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if lower.is_empty() {
                return Err("origin domain is empty");
            }
            if lower == "localhost"
                || lower.ends_with(".localhost")
                || lower.ends_with(".local")
                || lower.ends_with(".internal")
            {
                if !(allow_loopback && (lower == "localhost" || lower.ends_with(".localhost"))) {
                    return Err("origin local domain is forbidden by SSRF policy");
                }
            }
        }
    }
    Ok(parsed)
}

async fn read_bounded_body(mut body: Body, max_bytes: usize) -> Result<Vec<u8>, StatusCode> {
    let mut out = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
        if out.len().saturating_add(chunk.len()) > max_bytes {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// `PUT /blobs/:sha256` — verifies `:sha256` format, enforces `<= 512 KB`, verifies
/// `SHA256(body) == :sha256`, and stores idempotently.
pub async fn handle_put_blob(
    Path(sha256_hex): Path<String>,
    Extension(server): Extension<RegistryServer>,
    RawBody(body): RawBody,
) -> Response {
    let Some(expected_hash) = parse_sha256_lower_hex(&sha256_hex) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_blob_hash",
            Some("Blob hash must be 64 lowercase hexadecimal characters".to_string()),
        );
    };

    let bytes = match read_bounded_body(body, MAX_BLOB_CHUNK_BYTES).await {
        Ok(b) => b,
        Err(StatusCode::PAYLOAD_TOO_LARGE) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "blob_too_large",
                Some(format!(
                    "Blob chunk exceeds maximum size of {} bytes",
                    MAX_BLOB_CHUNK_BYTES
                )),
            );
        }
        Err(status) => {
            return error_response(status, "invalid_blob_body", None);
        }
    };

    let actual_digest: [u8; 32] = Sha256::digest(&bytes).into();
    if actual_digest != expected_hash {
        return error_response(
            StatusCode::BAD_REQUEST,
            "blob_hash_mismatch",
            Some(format!(
                "Expected SHA-256 {}, got {}",
                sha256_hex,
                hex::encode(actual_digest)
            )),
        );
    }

    let size = bytes.len();
    if server.registry.blobs().put(&expected_hash, bytes).is_err() {
        return storage_error_response();
    }

    (
        StatusCode::OK,
        Json(PutBlobResponseBody {
            sha256: sha256_hex,
            size,
        }),
    )
        .into_response()
}

/// `HEAD /blobs/:sha256` — checks local blob store for deduplicated upload skipping.
pub async fn handle_head_blob(
    Path(sha256_hex): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Response {
    let Some(expected_hash) = parse_sha256_lower_hex(&sha256_hex) else {
        return error_response(StatusCode::BAD_REQUEST, "invalid_blob_hash", None);
    };
    match server.registry.blobs().get(&expected_hash) {
        Ok(Some(bytes)) => blob_ok_response(bytes, true),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "blob_not_found", None),
        Err(_) => storage_error_response(),
    }
}

/// `GET /blobs/:sha256?origin=<optional_origin_relay_url>` — serves from the local blob store
/// if cached, or proxies server-to-server from the origin relay after SSRF validation, verifies
/// `SHA256(upstream_bytes) == :sha256`, caches locally, and returns `200 OK`.
pub async fn handle_get_blob(
    Path(sha256_hex): Path<String>,
    Query(query): Query<GetBlobQuery>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
) -> Response {
    let Some(expected_hash) = parse_sha256_lower_hex(&sha256_hex) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_blob_hash",
            Some("Blob hash must be 64 lowercase hexadecimal characters".to_string()),
        );
    };

    let blob_store = server.registry.blobs();

    // 1. Local cache hit: serve immediately with immutable Cache-Control.
    match blob_store.get(&expected_hash) {
        Ok(Some(bytes)) => return blob_ok_response(bytes, false),
        Ok(None) => {}
        Err(_) => return storage_error_response(),
    }

    // 2. Local cache miss: check `?origin=` query param or `X-Blob-Origin-Relay` header.
    let origin_hint = query
        .origin
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get(BLOB_ORIGIN_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });

    let Some(raw_origin) = origin_hint else {
        return error_response(StatusCode::NOT_FOUND, "blob_not_found", None);
    };

    let allow_loopback = blob_store.allow_loopback_origins();
    let origin_url = match validate_origin_relay_url(raw_origin, allow_loopback) {
        Ok(url) => url,
        Err(reason) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_origin_url",
                Some(reason.to_string()),
            );
        }
    };

    let http_client = match origin_client(&origin_url, allow_loopback, |domain, port| async move {
        tokio::net::lookup_host((domain.as_str(), port))
            .await
            .map(|addresses| addresses.collect())
    })
    .await
    {
        Ok(client) => client,
        Err((status, reason)) => {
            return error_response(status, "invalid_origin_url", Some(reason.to_string()));
        }
    };

    let upstream_url = format!(
        "{}/blobs/{}",
        origin_url.as_str().trim_end_matches('/'),
        sha256_hex
    );

    let upstream_res = match http_client.get(&upstream_url).send().await {
        Ok(res) => res,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_fetch_failed",
                Some(err.to_string()),
            );
        }
    };

    if upstream_res.status() == StatusCode::NOT_FOUND {
        return error_response(StatusCode::NOT_FOUND, "blob_not_found", None);
    }
    if upstream_res.status() != StatusCode::OK {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_bad_status",
            Some(format!(
                "Upstream relay returned HTTP {}",
                upstream_res.status().as_u16()
            )),
        );
    }

    let mut upstream_bytes = Vec::new();
    let mut stream = upstream_res.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(err) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    "upstream_fetch_failed",
                    Some(err.to_string()),
                );
            }
        };
        if upstream_bytes.len().saturating_add(chunk.len()) > MAX_BLOB_CHUNK_BYTES {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_blob_too_large",
                Some(format!(
                    "Upstream blob exceeded maximum size of {} bytes",
                    MAX_BLOB_CHUNK_BYTES
                )),
            );
        }
        upstream_bytes.extend_from_slice(&chunk);
    }

    let actual_digest: [u8; 32] = Sha256::digest(&upstream_bytes).into();
    if actual_digest != expected_hash {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_blob_hash_mismatch",
            Some(format!(
                "Upstream relay returned tampered bytes: expected {}, got {}",
                sha256_hex,
                hex::encode(actual_digest)
            )),
        );
    }

    // Cache verified ciphertext chunk locally so subsequent reads require zero upstream calls.
    if blob_store
        .put(&expected_hash, upstream_bytes.clone())
        .is_err()
    {
        return storage_error_response();
    }

    blob_ok_response(upstream_bytes, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        disabled_chain_adapter::DisabledChainAdapter, p2p::peers::Peers, registry::Registry,
        store::db::Db,
    };
    use axum::http::Request;
    use bitcoinsuite_core::Net;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tempdir::TempDir;
    use tower::ServiceExt;

    fn make_test_server() -> (TempDir, RegistryServer) {
        let tempdir = TempDir::new("cashweb-registry--blobs-test").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(DisabledChainAdapter), Net::Regtest);
        let event_bus = registry.event_bus().clone();
        let server = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(None),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
            solana_proxy: None,
            spa_dir: None,
            event_bus,
        };
        (tempdir, server)
    }

    async fn spawn_test_relay(server: RegistryServer) -> (String, tokio::task::JoinHandle<()>) {
        let router = server.into_router();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service())
                .await
                .unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    #[tokio::test]
    async fn put_blob_verifies_sha256_and_get_reads_locally_with_immutable_cache_headers() {
        let (_dir, server) = make_test_server();
        let router = server.into_router();

        let payload = b"encrypted-xchacha20poly1305-ciphertext-chunk-0".to_vec();
        let valid_hash = hex::encode(Sha256::digest(&payload));
        let wrong_hash = "aa".repeat(32);

        // 1. Mismatched hash is rejected with 400 blob_hash_mismatch
        let bad_res = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/blobs/{}", wrong_hash))
                    .body(Body::from(payload.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_res.status(), StatusCode::BAD_REQUEST);
        let bad_body = hyper::body::to_bytes(bad_res.into_body()).await.unwrap();
        let bad_json: serde_json::Value = serde_json::from_slice(&bad_body).unwrap();
        assert_eq!(bad_json["error"], "blob_hash_mismatch");

        // 2. Uppercase or non-64-hex hash is rejected with 400 invalid_blob_hash
        let upper_res = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/blobs/{}", valid_hash.to_uppercase()))
                    .body(Body::from(payload.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(upper_res.status(), StatusCode::BAD_REQUEST);

        // 3. Oversized chunk (> 512 KB) is rejected with 413 Payload Too Large
        let oversized = vec![0x42u8; MAX_BLOB_CHUNK_BYTES + 1];
        let oversized_hash = hex::encode(Sha256::digest(&oversized));
        let large_res = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/blobs/{}", oversized_hash))
                    .body(Body::from(oversized))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(large_res.status(), StatusCode::PAYLOAD_TOO_LARGE);

        // 4. Valid PUT succeeds idempotently
        for _ in 0..2 {
            let put_res = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(format!("/blobs/{}", valid_hash))
                        .body(Body::from(payload.clone()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(put_res.status(), StatusCode::OK);
        }

        // 5. HEAD and GET return 200 OK with application/octet-stream and immutable Cache-Control
        let head_res = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("HEAD")
                    .uri(format!("/blobs/{}", valid_hash))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head_res.status(), StatusCode::OK);
        assert_eq!(
            head_res.headers().get(header::CACHE_CONTROL).unwrap(),
            BLOB_CACHE_CONTROL
        );

        let get_res = router
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/blobs/{}", valid_hash))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_res.status(), StatusCode::OK);
        assert_eq!(
            get_res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            get_res.headers().get(header::CACHE_CONTROL).unwrap(),
            BLOB_CACHE_CONTROL
        );
        let get_bytes = hyper::body::to_bytes(get_res.into_body()).await.unwrap();
        assert_eq!(get_bytes.as_ref(), payload.as_slice());
    }

    #[tokio::test]
    async fn storage_open_failure_never_acknowledges_or_serves_unpersisted_bytes() {
        let (_dir, server) = make_test_server();
        std::fs::write(
            &server.registry.blobs().db_path,
            b"not a database directory",
        )
        .unwrap();
        assert_storage_failure(server, StatusCode::INTERNAL_SERVER_ERROR).await;
    }

    #[tokio::test]
    async fn storage_write_failure_never_acknowledges_or_caches_bytes() {
        let (_dir, server) = make_test_server();
        let store = server.registry.blobs();
        let mut options = rocksdb::Options::default();
        options.create_if_missing(true);
        drop(rocksdb::DB::open(&options, &store.db_path).unwrap());
        let read_only = rocksdb::DB::open_for_read_only(&options, &store.db_path, false).unwrap();
        store.rocks.set(read_only).unwrap();
        assert_storage_failure(server, StatusCode::NOT_FOUND).await;
    }

    #[tokio::test]
    async fn proxy_storage_write_failure_does_not_claim_a_cached_success() {
        let (_dir_a, origin) = make_test_server();
        let bytes = b"verified upstream bytes still need durable storage".to_vec();
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        origin.registry.blobs().put(&hash, bytes).unwrap();
        let (url, handle) = spawn_test_relay(origin).await;
        let (_dir_b, home) = make_test_server();
        let store = home.registry.blobs();
        store.set_allow_loopback_origins(true);
        let mut options = rocksdb::Options::default();
        options.create_if_missing(true);
        drop(rocksdb::DB::open(&options, &store.db_path).unwrap());
        store
            .rocks
            .set(rocksdb::DB::open_for_read_only(&options, &store.db_path, false).unwrap())
            .unwrap();
        let encoded = url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>();
        let router = home.into_router();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/blobs/{}?origin={}", hex::encode(hash), encoded))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/blobs/{}", hex::encode(hash)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        handle.abort();
    }

    async fn assert_storage_failure(server: RegistryServer, read_status: StatusCode) {
        let payload = b"must not acknowledge a volatile upload".to_vec();
        let hash = hex::encode(Sha256::digest(&payload));
        let router = server.into_router();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/blobs/{}", hash))
                    .body(Body::from(payload))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["error"],
            "blob_storage_failed"
        );
        for method in ["GET", "HEAD"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(format!("/blobs/{}", hash))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), read_status);
        }
    }

    #[tokio::test]
    async fn anonymous_uploads_have_one_durable_owner_and_survive_reopen() {
        let (dir, server) = make_test_server();
        let path = server.registry.blobs().db_path.clone();
        let router = server.clone().into_router();
        let mut blobs = Vec::new();
        for index in 0..16u8 {
            let bytes = vec![index; MAX_BLOB_CHUNK_BYTES];
            let hash: [u8; 32] = Sha256::digest(&bytes).into();
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri(format!("/blobs/{}", hex::encode(hash)))
                        .body(Body::from(bytes.clone()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            blobs.push((hash, bytes));
        }
        // No redundant process cache can keep deleted durable bytes alive.
        server
            .registry
            .blobs()
            .open_rocks()
            .unwrap()
            .delete(blobs[0].0)
            .unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/blobs/{}", hex::encode(blobs[0].0)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        drop(router);
        drop(server);
        let reopened = BlobStore::new(dir.path().join("db.rocksdb"));
        assert_eq!(reopened.db_path, path);
        assert_eq!(reopened.get(&blobs[0].0).unwrap(), None);
        for (hash, bytes) in &blobs[1..] {
            assert_eq!(reopened.get(hash).unwrap().as_ref(), Some(bytes));
        }
    }

    #[tokio::test]
    async fn origin_dns_errors_empty_and_mixed_private_answers_fail_closed() {
        let url = validate_origin_relay_url("https://unresolvable.invalid", false).unwrap();
        let failed = origin_client(&url, false, |_, _| async {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "synthetic DNS failure",
            ))
        })
        .await;
        assert_eq!(failed.unwrap_err().0, StatusCode::BAD_GATEWAY);
        let empty = origin_client(&url, false, |_, _| async { Ok(vec![]) }).await;
        assert_eq!(empty.unwrap_err().0, StatusCode::BAD_GATEWAY);
        for private in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "169.254.169.254:443",
            "[::ffff:127.0.0.1]:443",
            "[2002:7f00:1::]:443",
        ] {
            let result = origin_client(&url, false, |_, _| async move {
                Ok(vec![
                    "8.8.8.8:443".parse().unwrap(),
                    private.parse().unwrap(),
                ])
            })
            .await;
            assert_eq!(result.unwrap_err().0, StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn approved_dns_is_used_by_actual_connection_without_second_lookup_or_redirect() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/",
            axum::routing::get(|headers: HeaderMap| async move {
                assert!(headers
                    .get(header::HOST)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("never-resolves.invalid:"));
                (
                    StatusCode::FOUND,
                    [(header::LOCATION, "http://169.254.169.254/")],
                    "pinned connection",
                )
            }),
        );
        let handle = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service())
                .await
                .unwrap();
        });
        let url = validate_origin_relay_url(
            &format!("http://never-resolves.invalid:{}", address.port()),
            true,
        )
        .unwrap();
        let client = origin_client(&url, true, |domain, port| async move {
            assert_eq!(domain, "never-resolves.invalid");
            assert_eq!(port, address.port());
            Ok(vec![address])
        })
        .await
        .unwrap();
        // This test also runs with ambient proxy variables pointing at a dead
        // local port, proving they cannot override the validated connection.
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.text().await.unwrap(), "pinned connection");
        handle.abort();
    }

    #[test]
    fn ssrf_validation_rejects_loopback_private_link_local_and_non_https_by_default() {
        // Default production policy (allow_loopback = false):
        assert!(validate_origin_relay_url("https://relay.signet.mx", false).is_ok());
        assert!(validate_origin_relay_url("http://relay.signet.mx", false).is_err());
        assert!(validate_origin_relay_url("http://127.0.0.1:8080", false).is_err());
        assert!(validate_origin_relay_url("https://127.0.0.1:8443", false).is_err());
        assert!(validate_origin_relay_url("https://[::1]:8443", false).is_err());
        assert!(validate_origin_relay_url("https://localhost:8443", false).is_err());
        assert!(validate_origin_relay_url("https://10.0.0.1", false).is_err());
        assert!(validate_origin_relay_url("https://192.168.1.1", false).is_err());
        assert!(validate_origin_relay_url("https://172.16.0.1", false).is_err());
        assert!(validate_origin_relay_url("https://169.254.169.254", false).is_err());
        assert!(validate_origin_relay_url("file:///etc/passwd", false).is_err());
        assert!(validate_origin_relay_url("https://user:pass@relay.signet.mx", false).is_err());

        // Even with allow_loopback = true in test config, private & link-local IPs are blocked!
        assert!(validate_origin_relay_url("http://127.0.0.1:8080", true).is_ok());
        assert!(validate_origin_relay_url("http://169.254.169.254", true).is_err());
        assert!(validate_origin_relay_url("http://10.0.0.1", true).is_err());
        assert!(validate_origin_relay_url("http://192.168.1.1", true).is_err());
    }

    #[tokio::test]
    async fn home_relay_proxies_cross_relay_blobs_caches_locally_and_rejects_tampered_upstream() {
        let (_dir_a, server_a) = make_test_server();
        let (_dir_b, server_b) = make_test_server();
        server_b.registry.blobs().set_allow_loopback_origins(true);

        let (relay_a_url, relay_a_handle) = spawn_test_relay(server_a.clone()).await;
        let router_b = server_b.into_router();

        // 1. Upload valid chunk to Relay A
        let chunk_bytes = vec![0x7au8; 64 * 1024];
        let chunk_hash = hex::encode(Sha256::digest(&chunk_bytes));
        let put_res = reqwest::Client::new()
            .put(format!("{}/blobs/{}", relay_a_url, chunk_hash))
            .body(chunk_bytes.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(put_res.status(), StatusCode::OK);

        // 2. Client requests chunk from its Home Relay (Relay B) with `?origin=<relay_a_url>`
        let encoded_origin =
            url::form_urlencoded::byte_serialize(relay_a_url.as_bytes()).collect::<String>();
        let proxy_res = router_b
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/blobs/{}?origin={}", chunk_hash, encoded_origin))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(proxy_res.status(), StatusCode::OK);
        assert_eq!(
            proxy_res.headers().get(header::CACHE_CONTROL).unwrap(),
            BLOB_CACHE_CONTROL
        );
        let proxied_bytes = hyper::body::to_bytes(proxy_res.into_body()).await.unwrap();
        assert_eq!(proxied_bytes.as_ref(), chunk_bytes.as_slice());

        // 3. Shut down Relay A completely; Relay B still serves the cached blob locally!
        relay_a_handle.abort();
        let cached_res = router_b
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/blobs/{}", chunk_hash))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached_res.status(), StatusCode::OK);
        let cached_bytes = hyper::body::to_bytes(cached_res.into_body()).await.unwrap();
        assert_eq!(cached_bytes.as_ref(), chunk_bytes.as_slice());

        // 4. Spawn a malicious foreign relay that returns tampered bytes for a requested hash
        let tampered_hash = "cc".repeat(32);
        let malicious_router = axum::Router::new().route(
            "/blobs/:sha256",
            axum::routing::get(|| async { vec![0xffu8; 1024] }),
        );
        let malicious_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        malicious_listener.set_nonblocking(true).unwrap();
        let malicious_addr = malicious_listener.local_addr().unwrap();
        let malicious_handle = tokio::spawn(async move {
            axum::Server::from_tcp(malicious_listener)
                .unwrap()
                .serve(malicious_router.into_make_service())
                .await
                .unwrap();
        });
        let malicious_origin =
            url::form_urlencoded::byte_serialize(format!("http://{}", malicious_addr).as_bytes())
                .collect::<String>();

        let tampered_res = router_b
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/blobs/{}?origin={}",
                        tampered_hash, malicious_origin
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(tampered_res.status(), StatusCode::BAD_GATEWAY);
        let tampered_body = hyper::body::to_bytes(tampered_res.into_body())
            .await
            .unwrap();
        let tampered_json: serde_json::Value = serde_json::from_slice(&tampered_body).unwrap();
        assert_eq!(tampered_json["error"], "upstream_blob_hash_mismatch");

        // Verify tampered bytes were NOT cached in Relay B's blob store
        let after_tamper_res = router_b
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/blobs/{}", tampered_hash))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(after_tamper_res.status(), StatusCode::NOT_FOUND);
        malicious_handle.abort();

        // 5. Verify X-Blob-Origin-Relay header also works for server-to-server proxying
        let (_dir_c, server_c) = make_test_server();
        let (relay_c_url, relay_c_handle) = spawn_test_relay(server_c.clone()).await;
        let header_chunk = b"chunk-via-x-blob-origin-relay-header".to_vec();
        let header_chunk_hash = hex::encode(Sha256::digest(&header_chunk));
        reqwest::Client::new()
            .put(format!("{}/blobs/{}", relay_c_url, header_chunk_hash))
            .body(header_chunk.clone())
            .send()
            .await
            .unwrap();

        let header_proxy_res = router_b
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/blobs/{}", header_chunk_hash))
                    .header(BLOB_ORIGIN_HEADER, &relay_c_url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(header_proxy_res.status(), StatusCode::OK);
        let header_proxy_bytes = hyper::body::to_bytes(header_proxy_res.into_body())
            .await
            .unwrap();
        assert_eq!(header_proxy_bytes.as_ref(), header_chunk.as_slice());
        relay_c_handle.abort();
    }
}
