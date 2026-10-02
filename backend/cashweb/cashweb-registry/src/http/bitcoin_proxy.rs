//! Bitcoin-family JSON-RPC and Chronik HTTP/Protobuf proxy.

use std::{
    collections::HashMap,
    fmt,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{boxed, Bytes},
    extract::{connect_info::ConnectInfo, Extension, OriginalUri, Path},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bitcoinsuite_chronik_client::proto;
use cashweb_config::{BitcoinProxyConf, BitcoinProxyConfigError};
use prost::Message;
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use url::Url;

use crate::{
    http::{
        evm_rpc::{
            authenticate, body_hash, now_ms, rpc_error, BoundedRpcBody, RpcAuthState, RpcBinding,
            RpcChallengeBody, RpcRejection, RpcResource, RPC_AUTH_DOMAIN, RPC_CUSTOMER_HEADER,
        },
        hourly_quota::{normalize_quota_ip, FixedHourQuota},
        server::RegistryServer,
    },
    monad_http::Address,
};

const PROXY_METHOD_HEADER: &str = "x-frank-proxy-method";

#[derive(Clone)]
struct Chain {
    id: String,
    rpc: Option<Url>,
    chronik: Option<Url>,
    checkpoint_height: u64,
    checkpoint_hash: String,
}

struct UpstreamResponse {
    status: StatusCode,
    body: Bytes,
}

impl fmt::Debug for Chain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitcoinProxyChain")
            .field("id", &self.id)
            .field("rpc", &self.rpc.as_ref().map(|_| "<redacted>"))
            .field("chronik", &self.chronik.as_ref().map(|_| "<redacted>"))
            .field("checkpoint_height", &self.checkpoint_height)
            .field("checkpoint_hash", &self.checkpoint_hash)
            .finish()
    }
}

/// Validated Bitcoin proxy state.
pub struct BitcoinProxyRuntime {
    chains: HashMap<String, Chain>,
    client: reqwest::Client,
    auth: RpcAuthState,
    network_tag: Vec<u8>,
    permits: Arc<Semaphore>,
    ingress_permits: Arc<Semaphore>,
    max_request_bytes: usize,
    max_response_bytes: usize,
    timeout: Duration,
    chronik_quota: FixedHourQuota<IpAddr>,
    broadcast_quota: FixedHourQuota<IpAddr>,
}

impl fmt::Debug for BitcoinProxyRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitcoinProxyRuntime")
            .field("chains", &self.chains)
            .field("max_request_bytes", &self.max_request_bytes)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Startup errors never contain a secret upstream URL or response.
#[derive(Debug, thiserror::Error)]
pub enum BitcoinProxyStartError {
    /// Static proxy configuration is invalid.
    #[error("invalid Bitcoin proxy configuration: {0}")]
    InvalidConfig(BitcoinProxyConfigError),
    /// A named server-only environment variable is absent.
    #[error("missing Bitcoin proxy upstream environment variable {0}")]
    MissingUpstream(String),
    /// A named environment variable is not a hosted HTTP(S) URL.
    #[error("invalid Bitcoin proxy upstream environment variable {0}")]
    InvalidUpstream(String),
    /// An upstream did not return a usable startup identity response.
    #[error("Bitcoin proxy chain {0} failed startup checkpoint validation")]
    UpstreamUnavailable(String),
    /// An upstream returned a block other than the configured checkpoint.
    #[error("Bitcoin proxy chain {id} checkpoint mismatch")]
    CheckpointMismatch {
        /// Stable public protocol chain id.
        id: String,
    },
}

impl BitcoinProxyRuntime {
    pub(crate) fn has_chronik_chain(&self, id: &str) -> bool {
        self.chains
            .get(id)
            .and_then(|chain| chain.chronik.as_ref())
            .is_some()
    }

    pub(crate) fn body_admission(&self) -> (Arc<Semaphore>, usize, Duration) {
        (
            Arc::clone(&self.ingress_permits),
            self.max_request_bytes,
            self.timeout,
        )
    }

    pub(crate) fn configured_capabilities(&self) -> Vec<(String, bool, bool)> {
        self.chains
            .values()
            .map(|chain| {
                (
                    chain.id.clone(),
                    chain.rpc.is_some(),
                    chain.chronik.is_some(),
                )
            })
            .collect()
    }

    /// Resolve secret URLs and verify every configured node/indexer before readiness.
    pub async fn from_conf_with_env(
        conf: &BitcoinProxyConf,
        network_tag: Vec<u8>,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Arc<Self>>, BitcoinProxyStartError> {
        conf.validate()
            .map_err(BitcoinProxyStartError::InvalidConfig)?;
        if !conf.enabled {
            return Ok(None);
        }
        let mut chains = HashMap::new();
        for row in &conf.chains {
            let resolve = |name: &Option<String>| -> Result<Option<Url>, BitcoinProxyStartError> {
                let Some(name) = name else { return Ok(None) };
                let raw = env(name)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| BitcoinProxyStartError::MissingUpstream(name.clone()))?;
                let url = raw
                    .trim()
                    .parse::<Url>()
                    .ok()
                    .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
                    .ok_or_else(|| BitcoinProxyStartError::InvalidUpstream(name.clone()))?;
                Ok(Some(url))
            };
            chains.insert(
                row.id.clone(),
                Chain {
                    id: row.id.clone(),
                    rpc: resolve(&row.rpc_upstream_env)?,
                    chronik: resolve(&row.chronik_upstream_env)?,
                    checkpoint_height: row.checkpoint_height,
                    checkpoint_hash: row.checkpoint_hash.to_ascii_lowercase(),
                },
            );
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable("client".into()))?;
        let runtime = Arc::new(Self {
            chains,
            client,
            auth: RpcAuthState::new(),
            network_tag,
            permits: Arc::new(Semaphore::new(conf.max_concurrency)),
            ingress_permits: Arc::new(Semaphore::new(conf.max_concurrency)),
            max_request_bytes: conf.max_request_bytes,
            max_response_bytes: conf.max_response_bytes,
            timeout: Duration::from_millis(conf.timeout_ms),
            chronik_quota: FixedHourQuota::new(conf.anonymous_chronik_requests_per_hour),
            broadcast_quota: FixedHourQuota::new(conf.anonymous_broadcasts_per_hour),
        });
        runtime.verify_checkpoints().await?;
        Ok(Some(runtime))
    }

    pub(crate) fn has_rpc_chain(&self, id: &str) -> bool {
        self.chains.get(id).and_then(|c| c.rpc.as_ref()).is_some()
    }

    async fn verify_checkpoints(&self) -> Result<(), BitcoinProxyStartError> {
        for chain in self.chains.values() {
            if let Some(url) = &chain.rpc {
                let body = json!({"jsonrpc":"1.0","id":"startup","method":"getblockhash","params":[chain.checkpoint_height]});
                let response = self
                    .rpc_request(url, serde_json::to_vec(&body).unwrap())
                    .await
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !response.status.is_success() {
                    return Err(BitcoinProxyStartError::UpstreamUnavailable(
                        chain.id.clone(),
                    ));
                }
                let actual = serde_json::from_slice::<Value>(&response.body)
                    .ok()
                    .and_then(|v| v.get("result")?.as_str().map(str::to_owned))
                    .ok_or_else(|| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !actual.eq_ignore_ascii_case(&chain.checkpoint_hash) {
                    return Err(BitcoinProxyStartError::CheckpointMismatch {
                        id: chain.id.clone(),
                    });
                }
            }
            if let Some(base) = &chain.chronik {
                let url = endpoint_url(base, &format!("block/{}", chain.checkpoint_height))
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                let bytes = self
                    .simple_request(self.client.get(url))
                    .await
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                let block = proto::Block::decode(bytes.as_ref())
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                let mut hash = block
                    .block_info
                    .ok_or_else(|| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?
                    .hash;
                hash.reverse();
                if hex::encode(hash) != chain.checkpoint_hash {
                    return Err(BitcoinProxyStartError::CheckpointMismatch {
                        id: chain.id.clone(),
                    });
                }
            }
        }
        Ok(())
    }

    async fn simple_request(&self, request: reqwest::RequestBuilder) -> Result<Bytes, ()> {
        let response = self.bounded_request(request).await?;
        if !response.status.is_success() {
            return Err(());
        }
        Ok(response.body)
    }

    async fn bounded_request(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<UpstreamResponse, ()> {
        tokio::time::timeout(self.timeout, async {
            let response = request.send().await.map_err(|_| ())?;
            let status = response.status();
            let body = read_response(response, self.max_response_bytes).await?;
            Ok(UpstreamResponse { status, body })
        })
        .await
        .map_err(|_| ())?
    }

    async fn rpc_request(&self, url: &Url, body: Vec<u8>) -> Result<UpstreamResponse, ()> {
        self.bounded_request(self.rpc_request_builder(url, body))
            .await
    }

    fn rpc_request_builder(&self, url: &Url, body: Vec<u8>) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .post(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        if !url.username().is_empty() {
            request = request.basic_auth(url.username(), url.password());
        }
        request
    }
}

fn endpoint_url(base: &Url, path: &str) -> Result<Url, ()> {
    let mut text = base.as_str().trim_end_matches('/').to_owned();
    text.push('/');
    text.push_str(path.trim_start_matches('/'));
    text.parse().map_err(|_| ())
}

async fn read_response(mut response: reqwest::Response, max: usize) -> Result<Bytes, ()> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if out.len().saturating_add(chunk.len()) > max {
            return Err(());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out.into())
}

fn parse_customer(headers: &HeaderMap) -> Result<Option<Address>, RpcRejection> {
    headers
        .get(RPC_CUSTOMER_HEADER)
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|s| Address::from_hex(s).ok())
                .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
        })
        .transpose()
}

fn validate_rpc(
    body: &[u8],
    max: usize,
) -> Result<(u32, bool, super::json_rpc::JsonRpcVersion), RpcRejection> {
    if body.is_empty() || body.len() > max {
        return Err(rpc_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "rpc_request_too_large",
        ));
    }
    let value = super::json_rpc::parse_without_duplicate_keys(body)
        .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
    let calls: Vec<&Value> = match &value {
        Value::Array(v) if !v.is_empty() && v.len() <= 20 => v.iter().collect(),
        Value::Array(_) => return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit")),
        v => vec![v],
    };
    let mut units = 0u32;
    let mut only_send = calls.len() == 1;
    let mut version = None;
    for call in calls {
        let obj = call
            .as_object()
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
        if !obj.contains_key("id") {
            return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
        }
        let call_version = match obj.get("jsonrpc").and_then(Value::as_str) {
            None | Some("1.0") => super::json_rpc::JsonRpcVersion::Legacy,
            Some("2.0") => super::json_rpc::JsonRpcVersion::V2,
            Some(_) => return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc")),
        };
        if version
            .replace(call_version)
            .is_some_and(|v| v != call_version)
        {
            return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
        }
        let method = obj
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
        let allowed = matches!(
            method,
            "getblockchaininfo"
                | "getnetworkinfo"
                | "getblockcount"
                | "getbestblockhash"
                | "getblockhash"
                | "getblockheader"
                | "getblock"
                | "getrawtransaction"
                | "gettxout"
                | "estimatesmartfee"
                | "sendrawtransaction"
        );
        if !allowed {
            return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied"));
        }
        only_send &= method == "sendrawtransaction";
        units = units.saturating_add(if method == "sendrawtransaction" {
            10
        } else if matches!(method, "getblock" | "getrawtransaction") {
            5
        } else {
            1
        });
    }
    Ok((units, only_send, version.expect("non-empty calls")))
}

fn peer_ip(peer: Option<ConnectInfo<SocketAddr>>) -> Result<IpAddr, RpcRejection> {
    let ip = peer
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_source_required"))?
        .0
        .ip();
    Ok(normalize_quota_ip(ip))
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) async fn issue_rpc_challenge(
    chain_id: String,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    if !runtime.has_rpc_chain(&chain_id) {
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    }
    validate_rpc(&body, runtime.max_request_bytes)?;
    let customer = parse_customer(&headers)?
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    challenge(runtime, customer, chain_id, &body)
}

fn challenge(
    runtime: &BitcoinProxyRuntime,
    customer: Address,
    scope: String,
    body: &[u8],
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let binding = RpcBinding {
        customer,
        chain: scope.clone(),
        body_sha256: body_hash(body),
        resource: RpcResource::Rpc,
    };
    let issued = runtime.auth.issue(&binding, now_ms());
    Ok(Json(RpcChallengeBody {
        epoch: hex::encode(issued.epoch),
        nonce: hex::encode(issued.nonce),
        expires_at_ms: issued.expires_at_ms,
        token: hex::encode(issued.token),
        signing_domain: RPC_AUTH_DOMAIN,
        customer: customer.to_hex(),
        chain: scope,
        body_sha256: hex::encode(binding.body_sha256),
        network_tag: hex::encode(&runtime.network_tag),
    }))
}

pub(crate) async fn proxy_rpc(
    chain_id: String,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Response, RpcRejection> {
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let chain = runtime
        .chains
        .get(&chain_id)
        .filter(|c| c.rpc.is_some())
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let (_units, send_only, version) = validate_rpc(&body, runtime.max_request_bytes)?;
    let expected_ids = super::json_rpc::request_ids(&body)
        .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
    let anonymous_ip = if let Some(customer) = parse_customer(&headers)? {
        authenticate(
            &headers,
            &server,
            &runtime.auth,
            &runtime.network_tag,
            &RpcBinding {
                customer,
                chain: chain_id,
                body_sha256: body_hash(&body),
                resource: RpcResource::Rpc,
            },
        )?;
        None
    } else {
        if !send_only {
            return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"));
        }
        Some(peer_ip(peer)?)
    };
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"))?;
    if let Some(ip) = anonymous_ip {
        runtime
            .broadcast_quota
            .charge(ip, 1, unix_seconds())
            .ok_or_else(|| rpc_error(StatusCode::TOO_MANY_REQUESTS, "rpc_hourly_quota"))?;
    }
    let deadline = tokio::time::Instant::now() + runtime.timeout;
    let upstream = tokio::time::timeout_at(
        deadline,
        runtime
            .rpc_request_builder(chain.rpc.as_ref().unwrap(), body.to_vec())
            .send(),
    )
    .await
    .map_err(|_| rpc_error(StatusCode::GATEWAY_TIMEOUT, "rpc_upstream_timeout"))?
    .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable"))?;
    let upstream_status = upstream.status();
    if version == super::json_rpc::JsonRpcVersion::V2 && upstream_status != StatusCode::OK {
        return Err(rpc_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
        ));
    }
    let spool = tokio::time::timeout_at(
        deadline,
        super::json_rpc::spool_response(upstream, runtime.max_response_bytes, runtime.timeout),
    )
    .await
    .map_err(|_| rpc_error(StatusCode::GATEWAY_TIMEOUT, "rpc_upstream_timeout"))?
    .map_err(|error| match error {
        super::json_rpc::SpoolError::TooLarge => {
            rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_response_too_large")
        }
        super::json_rpc::SpoolError::Timeout => {
            rpc_error(StatusCode::GATEWAY_TIMEOUT, "rpc_upstream_timeout")
        }
        super::json_rpc::SpoolError::Io => {
            rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable")
        }
    })?;
    let inspected = tokio::time::timeout_at(deadline, spool.inspect(version, expected_ids))
        .await
        .map_err(|_| rpc_error(StatusCode::GATEWAY_TIMEOUT, "rpc_upstream_timeout"))?
        .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "invalid_rpc_upstream_response"))?;
    let body = spool
        .into_body(inspected.error_rewrites)
        .await
        .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable"))?;
    let mut response = Response::new(boxed(body));
    *response.status_mut() = if version == super::json_rpc::JsonRpcVersion::V2 {
        StatusCode::OK
    } else {
        upstream_status
    };
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    Ok(crate::http::json_rpc::hold_response_permit(
        response, permit,
    ))
}

fn chronik_scope(chain: &str, method: &Method, uri: &axum::http::Uri) -> String {
    format!(
        "chronik:{}:{}:{}",
        chain,
        method,
        uri.path_and_query()
            .map(|v| v.as_str())
            .unwrap_or(uri.path())
    )
}

fn chronik_policy(method: &Method, path: &str) -> Option<(bool, bool)> {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    let public_get = method == Method::GET
        && (matches!(
            parts.as_slice(),
            ["blockchain-info"] | ["chronik-info"] | ["tx", _]
        ) || matches!(
            parts.as_slice(),
            [
                "script",
                _,
                _,
                "history" | "confirmed-txs" | "unconfirmed-txs" | "utxos"
            ]
        ));
    let public_post = method == Method::POST
        && matches!(parts.as_slice(), ["script", "batch", "utxos" | "summary"]);
    let broadcast =
        method == Method::POST && matches!(parts.as_slice(), ["broadcast-tx"] | ["broadcast-txs"]);
    let customer = public_get
        || public_post
        || broadcast
        || (method == Method::GET
            && matches!(
                parts.as_slice(),
                ["block", _]
                    | ["block-header", _]
                    | ["block-txs", _]
                    | ["blocks", _, _]
                    | ["block-headers", _, _]
                    | ["raw-tx", _]
                    | ["unconfirmed-txs"]
                    | ["token", _]
                    | [
                        "token-id",
                        _,
                        "confirmed-txs" | "history" | "unconfirmed-txs" | "utxos"
                    ]
                    | [
                        "lokad-id",
                        _,
                        "confirmed-txs" | "history" | "unconfirmed-txs"
                    ]
                    | ["plugin", _, "groups"]
                    | [
                        "plugin",
                        _,
                        _,
                        "confirmed-txs" | "history" | "unconfirmed-txs" | "utxos"
                    ]
            ))
        || (method == Method::POST && matches!(parts.as_slice(), ["validate-tx"]));
    customer.then_some((public_get || public_post, broadcast))
}

fn broadcast_units(path: &str, body: &[u8]) -> Result<u32, RpcRejection> {
    if path.trim_matches('/') == "broadcast-tx" {
        proto::BroadcastTxRequest::decode(body)
            .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_body"))?;
        return Ok(1);
    }
    let request = proto::BroadcastTxsRequest::decode(body)
        .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_body"))?;
    let count = u32::try_from(request.raw_txs.len())
        .map_err(|_| rpc_error(StatusCode::PAYLOAD_TOO_LARGE, "rpc_batch_limit"))?;
    if count == 0 || count > 20 {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit"));
    }
    Ok(count)
}

pub(crate) async fn issue_chronik_challenge(
    Path((chain_id, path)): Path<(String, String)>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let _chain = runtime
        .chains
        .get(&chain_id)
        .filter(|c| c.chronik.is_some())
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let method = headers
        .get(PROXY_METHOD_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Method::from_bytes(v.as_bytes()).ok())
        .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "proxy_method_required"))?;
    if body.len() > runtime.max_request_bytes {
        return Err(rpc_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "rpc_request_too_large",
        ));
    }
    if chronik_policy(&method, &path).is_none() {
        return Err(rpc_error(StatusCode::FORBIDDEN, "indexer_endpoint_denied"));
    }
    let customer = parse_customer(&headers)?
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let target_uri: axum::http::Uri = uri
        .to_string()
        .replace("/chronik-auth/", "/chronik/")
        .parse()
        .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_path"))?;
    challenge(
        runtime,
        customer,
        chronik_scope(&chain_id, &method, &target_uri),
        &body,
    )
}

pub(crate) async fn proxy_chronik(
    Path((chain_id, path)): Path<(String, String)>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Response, RpcRejection> {
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let chain = runtime
        .chains
        .get(&chain_id)
        .filter(|c| c.chronik.is_some())
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let (public, broadcast) = chronik_policy(&method, &path)
        .ok_or_else(|| rpc_error(StatusCode::FORBIDDEN, "indexer_endpoint_denied"))?;
    if body.len() > runtime.max_request_bytes {
        return Err(rpc_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "rpc_request_too_large",
        ));
    }
    let anonymous_charge = if let Some(customer) = parse_customer(&headers)? {
        authenticate(
            &headers,
            &server,
            &runtime.auth,
            &runtime.network_tag,
            &RpcBinding {
                customer,
                chain: chronik_scope(&chain_id, &method, &uri),
                body_sha256: body_hash(&body),
                resource: RpcResource::Rpc,
            },
        )?;
        None
    } else {
        if !public && !broadcast {
            return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"));
        }
        let units = if broadcast {
            broadcast_units(&path, &body)?
        } else {
            1
        };
        Some((broadcast, peer_ip(peer)?, units))
    };
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"))?;
    if let Some((is_broadcast, ip, units)) = anonymous_charge {
        let quota = if is_broadcast {
            &runtime.broadcast_quota
        } else {
            &runtime.chronik_quota
        };
        quota
            .charge(ip, units, unix_seconds())
            .ok_or_else(|| rpc_error(StatusCode::TOO_MANY_REQUESTS, "rpc_hourly_quota"))?;
    }
    let suffix = uri
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or(uri.path());
    let prefix = format!("/chain-rpc/{chain_id}/chronik/");
    let upstream_path = suffix
        .strip_prefix(&prefix)
        .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_path"))?;
    let url = endpoint_url(chain.chronik.as_ref().unwrap(), upstream_path)
        .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable"))?;
    let request = if method == Method::GET {
        runtime.client.get(url)
    } else {
        runtime
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
            .body(body.to_vec())
    };
    let upstream = runtime
        .bounded_request(request)
        .await
        .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable"))?;
    let body = if upstream.status.is_success() {
        upstream.body
    } else {
        let mut error = proto::Error::decode(upstream.body.as_ref())
            .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "invalid_rpc_upstream_response"))?;
        error.msg = "upstream Chronik error".to_string();
        error.encode_to_vec().into()
    };
    let response = (
        upstream.status,
        [(axum::http::header::CONTENT_TYPE, "application/x-protobuf")],
        body,
    )
        .into_response();
    Ok(crate::http::json_rpc::hold_response_permit(
        response, permit,
    ))
}

/// Extra request headers needed by Bitcoin-family proxy preflight requests.
pub const BITCOIN_PROXY_CORS_HEADERS: [&str; 1] = [PROXY_METHOD_HEADER];

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing, Router};
    use cashweb_config::BitcoinProxyChainConf;

    #[test]
    fn node_rpc_allows_only_bounded_reads_and_anonymous_single_broadcast() {
        let read = br#"{"jsonrpc":"1.0","id":1,"method":"getblockhash","params":[1]}"#;
        assert_eq!(
            validate_rpc(read, 1024).unwrap(),
            (1, false, crate::http::json_rpc::JsonRpcVersion::Legacy)
        );
        let send = br#"{"jsonrpc":"1.0","id":1,"method":"sendrawtransaction","params":["00"]}"#;
        assert_eq!(
            validate_rpc(send, 1024).unwrap(),
            (10, true, crate::http::json_rpc::JsonRpcVersion::Legacy)
        );
        let v2 = br#"{"jsonrpc":"2.0","id":1,"method":"getblockhash","params":[1]}"#;
        assert_eq!(
            validate_rpc(v2, 1024).unwrap(),
            (1, false, crate::http::json_rpc::JsonRpcVersion::V2)
        );
        let denied = br#"{"jsonrpc":"1.0","id":1,"method":"dumpprivkey","params":[]}"#;
        assert!(validate_rpc(denied, 1024).is_err());
        let anonymous_batch = format!(
            "[{},{}]",
            String::from_utf8_lossy(send),
            String::from_utf8_lossy(send)
        );
        assert!(!validate_rpc(anonymous_batch.as_bytes(), 1024).unwrap().1);
        let mixed_versions = format!(
            "[{},{}]",
            String::from_utf8_lossy(read),
            String::from_utf8_lossy(v2)
        );
        assert!(validate_rpc(mixed_versions.as_bytes(), 1024).is_err());
    }

    #[test]
    fn node_rpc_rejects_duplicate_method_before_anonymous_authorization() {
        // serde_json::Value resolves this to the final member while Bitcoin
        // Core and Bitcoin ABC's UniValue lookup resolves the first member.
        // The original bytes are forwarded, so accepting it would let an
        // anonymous caller authorize a broadcast but execute another method.
        let ambiguous = br#"{"jsonrpc":"1.0","id":1,"method":"dumpprivkey","method":"sendrawtransaction","params":["00"]}"#;
        assert!(validate_rpc(ambiguous, 1024).is_err());
    }

    #[test]
    fn chronik_policy_exposes_wallet_bootstrap_and_broadcast_but_not_admin() {
        assert_eq!(
            chronik_policy(&Method::GET, "script/p2pkh/aa/history"),
            Some((true, false))
        );
        assert_eq!(
            chronik_policy(&Method::POST, "script/batch/utxos"),
            Some((true, false))
        );
        assert_eq!(
            chronik_policy(&Method::POST, "broadcast-tx"),
            Some((false, true))
        );
        assert_eq!(
            chronik_policy(&Method::POST, "broadcast-txs"),
            Some((false, true))
        );
        assert_eq!(chronik_policy(&Method::GET, "pause"), None);
        assert_eq!(chronik_policy(&Method::GET, "ws"), None);
    }

    #[test]
    fn batch_broadcast_quota_counts_transactions_and_rejects_empty_or_large_batches() {
        let single = proto::BroadcastTxRequest {
            raw_tx: vec![1],
            skip_token_checks: false,
        }
        .encode_to_vec();
        assert_eq!(broadcast_units("broadcast-tx", &single).unwrap(), 1);

        let batch = |count: usize| {
            proto::BroadcastTxsRequest {
                raw_txs: vec![vec![1]; count],
                skip_token_checks: false,
            }
            .encode_to_vec()
        };
        assert_eq!(broadcast_units("broadcast-txs", &batch(3)).unwrap(), 3);
        assert!(broadcast_units("broadcast-txs", &batch(0)).is_err());
        assert!(broadcast_units("broadcast-txs", &batch(21)).is_err());
    }

    #[test]
    fn debug_output_redacts_both_upstream_urls() {
        let chain = Chain {
            id: "xec-mainnet".to_string(),
            rpc: Some("https://user:secret@rpc.example/key".parse().unwrap()),
            chronik: Some("https://chronik.example/secret".parse().unwrap()),
            checkpoint_height: 1,
            checkpoint_hash: "00".repeat(32),
        };
        let mut response = json!({
            "error": "https://user:secret@rpc.example/key rejected secret"
        });
        crate::http::json_rpc::sanitize_response_errors(&mut response);
        let response = response.to_string();
        assert!(!response.contains("secret"));
        assert!(!response.contains("rpc.example"));

        let runtime = BitcoinProxyRuntime {
            chains: HashMap::from([(chain.id.clone(), chain)]),
            client: reqwest::Client::new(),
            auth: RpcAuthState::new(),
            network_tag: vec![],
            permits: Arc::new(Semaphore::new(1)),
            ingress_permits: Arc::new(Semaphore::new(1)),
            max_request_bytes: 1024,
            max_response_bytes: 1024,
            timeout: Duration::from_secs(1),
            chronik_quota: FixedHourQuota::new(100),
            broadcast_quota: FixedHourQuota::new(10),
        };
        let debug = format!("{runtime:?}");
        assert!(!debug.contains("secret"));
        assert!(!debug.contains("rpc.example"));
        assert!(!debug.contains("chronik.example"));
    }

    #[tokio::test]
    async fn startup_verifies_chronik_checkpoint_and_fails_closed_on_mismatch() {
        let mut conventional_hash = (0u8..32).collect::<Vec<_>>();
        let mut chronik_hash = conventional_hash.clone();
        chronik_hash.reverse();
        let block = proto::Block {
            block_info: Some(proto::BlockInfo {
                hash: chronik_hash,
                ..Default::default()
            }),
        }
        .encode_to_vec();
        let upstream = Router::new().route(
            "/block/:height",
            routing::get(move || {
                let block = block.clone();
                async move { block }
            }),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(upstream.into_make_service()),
        );
        let mut conf = BitcoinProxyConf {
            enabled: true,
            chains: vec![BitcoinProxyChainConf {
                id: "xec-mainnet".to_string(),
                rpc_upstream_env: None,
                chronik_upstream_env: Some("CHRONIK_URL".to_string()),
                checkpoint_height: 42,
                checkpoint_hash: hex::encode(&conventional_hash),
            }],
            ..BitcoinProxyConf::default()
        };
        let url = format!("http://{address}");
        assert!(
            BitcoinProxyRuntime::from_conf_with_env(&conf, vec![], |_| Some(url.clone()))
                .await
                .unwrap()
                .is_some()
        );

        conventional_hash[0] ^= 1;
        conf.chains[0].checkpoint_hash = hex::encode(conventional_hash);
        assert!(matches!(
            BitcoinProxyRuntime::from_conf_with_env(&conf, vec![], |_| Some(url.clone())).await,
            Err(BitcoinProxyStartError::CheckpointMismatch { .. })
        ));
    }
}
