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
            authenticate, body_hash, broadcast_error, now_ms, preflight_broadcast_error,
            quota_error, rpc_error, BoundedRpcBody, RpcAuthState, RpcBinding, RpcCapabilityBody,
            RpcChallengeBody, RpcRejection, RpcResource, RPC_AUTH_DOMAIN, RPC_CUSTOMER_HEADER,
        },
        hourly_quota::{normalize_quota_ip, FixedHourQuota},
        server::RegistryServer,
    },
    monad_http::Address,
};

const PROXY_METHOD_HEADER: &str = "x-frank-proxy-method";
const MAX_STARTUP_RESPONSE_BYTES: usize = 1024 * 1024;

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

#[cfg(test)]
#[derive(Clone, PartialEq, Message)]
struct ScriptRefWire {
    #[prost(string, tag = "1")]
    script_type: String,
    #[prost(bytes = "vec", tag = "2")]
    payload: Vec<u8>,
}

#[cfg(test)]
#[derive(Clone, PartialEq, Message)]
struct ScriptBatchParamsWire {
    #[prost(message, repeated, tag = "1")]
    scripts: Vec<ScriptRefWire>,
}

#[cfg(test)]
#[derive(Clone, PartialEq, Message)]
struct ScriptBatchRequestWire {
    #[prost(message, optional, tag = "1")]
    params: Option<ScriptBatchParamsWire>,
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
    capability_ttl: Duration,
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
    pub(crate) fn has_chain(&self, id: &str) -> bool {
        self.chains.contains_key(id)
    }

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
            capability_ttl: Duration::from_millis(conf.capability_ttl_ms),
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
                    .bounded_request_with_limit(
                        self.rpc_request_builder(url, serde_json::to_vec(&body).unwrap()),
                        MAX_STARTUP_RESPONSE_BYTES,
                    )
                    .await
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !response.status.is_success() {
                    return Err(BitcoinProxyStartError::UpstreamUnavailable(
                        chain.id.clone(),
                    ));
                }
                let actual = super::json_rpc::startup_result(
                    &response.body,
                    super::json_rpc::JsonRpcVersion::Legacy,
                    &json!("startup"),
                )
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !actual.eq_ignore_ascii_case(&chain.checkpoint_hash) {
                    return Err(BitcoinProxyStartError::CheckpointMismatch {
                        id: chain.id.clone(),
                    });
                }
            }
            if let Some(base) = &chain.chronik {
                let url =
                    chronik_endpoint_url(base, &format!("block/{}", chain.checkpoint_height), None)
                        .map_err(|_| {
                            BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone())
                        })?;
                let bytes = self
                    .simple_request_with_limit(self.client.get(url), MAX_STARTUP_RESPONSE_BYTES)
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

    async fn simple_request_with_limit(
        &self,
        request: reqwest::RequestBuilder,
        max_response_bytes: usize,
    ) -> Result<Bytes, ()> {
        let response = self
            .bounded_request_with_limit(request, max_response_bytes)
            .await?;
        if !response.status.is_success() {
            return Err(());
        }
        Ok(response.body)
    }

    async fn bounded_request(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<UpstreamResponse, ()> {
        self.bounded_request_with_limit(request, self.max_response_bytes)
            .await
    }

    async fn bounded_request_with_limit(
        &self,
        request: reqwest::RequestBuilder,
        max_response_bytes: usize,
    ) -> Result<UpstreamResponse, ()> {
        tokio::time::timeout(self.timeout, async {
            let response = request.send().await.map_err(|_| ())?;
            let status = response.status();
            let body = read_response(response, max_response_bytes).await?;
            Ok(UpstreamResponse { status, body })
        })
        .await
        .map_err(|_| ())?
    }

    fn rpc_request_builder(&self, url: &Url, body: Vec<u8>) -> reqwest::RequestBuilder {
        self.client
            .post(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
    }
}

fn chronik_endpoint_url(base: &Url, path: &str, query: Option<&str>) -> Result<Url, ()> {
    let mut url = base.clone();
    {
        let mut segments = url.path_segments_mut().map_err(|_| ())?;
        segments.pop_if_empty();
        for segment in path.split('/') {
            segments.push(segment);
        }
    }
    let combined_query = match (base.query(), query) {
        (Some(base), Some(request)) if !request.is_empty() => Some(format!("{base}&{request}")),
        (Some(base), _) => Some(base.to_string()),
        (None, Some(request)) if !request.is_empty() => Some(request.to_string()),
        (None, _) => None,
    };
    url.set_query(combined_query.as_deref());
    url.set_fragment(None);
    Ok(url)
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
) -> Result<(u32, bool, bool, super::json_rpc::JsonRpcVersion), RpcRejection> {
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
    let mut contains_send = false;
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
        contains_send |= method == "sendrawtransaction";
        units = units.saturating_add(if method == "sendrawtransaction" {
            10
        } else if matches!(method, "getblock" | "getrawtransaction") {
            5
        } else {
            1
        });
    }
    Ok((
        units,
        only_send,
        contains_send,
        version.expect("non-empty calls"),
    ))
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

pub(crate) fn issue_capability_challenge(
    chain_id: String,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    if !body.is_empty() {
        return Err(rpc_error(
            StatusCode::BAD_REQUEST,
            "invalid_capability_request",
        ));
    }
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let customer = parse_customer(&headers)?
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
        resource: RpcResource::Capability,
    };
    let issued = runtime.auth.issue(&binding, now_ms());
    Ok(Json(RpcChallengeBody {
        epoch: hex::encode(issued.epoch),
        nonce: hex::encode(issued.nonce),
        expires_at_ms: issued.expires_at_ms,
        token: hex::encode(issued.token),
        signing_domain: RPC_AUTH_DOMAIN,
        customer: customer.to_hex(),
        chain: chain_id,
        body_sha256: hex::encode(binding.body_sha256),
        network_tag: hex::encode(&runtime.network_tag),
    }))
}

pub(crate) fn issue_capability(
    chain_id: String,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Json<RpcCapabilityBody>, RpcRejection> {
    if !body.is_empty() {
        return Err(rpc_error(
            StatusCode::BAD_REQUEST,
            "invalid_capability_request",
        ));
    }
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let customer = parse_customer(&headers)?
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
        resource: RpcResource::Capability,
    };
    authenticate(
        &headers,
        &server,
        &runtime.auth,
        &runtime.network_tag,
        &binding,
    )?;
    let ttl_ms = i64::try_from(runtime.capability_ttl.as_millis()).unwrap_or(i64::MAX);
    let (token, expires_at_ms) =
        runtime
            .auth
            .issue_capability(customer, &chain_id, now_ms(), ttl_ms);
    let chain = &runtime.chains[&chain_id];
    Ok(Json(RpcCapabilityBody {
        rpc_path: chain
            .rpc
            .as_ref()
            .map(|_| format!("/chain-rpc/{chain_id}/cap/{token}/rpc")),
        chronik_path: chain
            .chronik
            .as_ref()
            .map(|_| format!("/chain-rpc/{chain_id}/cap/{token}/chronik")),
        ws_path: None,
        expires_at_ms,
    }))
}

pub(crate) async fn proxy_rpc(
    chain_id: String,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Response, RpcRejection> {
    proxy_rpc_inner(chain_id, peer, headers, server, body, None).await
}

pub(crate) async fn proxy_rpc_capability(
    chain_id: String,
    capability: String,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Response, RpcRejection> {
    proxy_rpc_inner(chain_id, None, headers, server, body, Some(capability)).await
}

async fn proxy_rpc_inner(
    chain_id: String,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
    capability: Option<String>,
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
    let (_units, send_only, contains_broadcast, version) =
        validate_rpc(&body, runtime.max_request_bytes)?;
    let correlation = super::json_rpc::request_correlation(&body).map_err(|_| {
        preflight_broadcast_error(
            rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"),
            contains_broadcast,
        )
    })?;
    let capability_customer = capability
        .as_deref()
        .map(|capability| {
            runtime
                .auth
                .verify_capability(capability, &chain_id, now_ms())
                .map(|verified| verified.0)
                .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
                .map_err(|error| preflight_broadcast_error(error, contains_broadcast))
        })
        .transpose()?;
    let anonymous_ip = if capability_customer.is_some() {
        None
    } else if let Some(customer) = parse_customer(&headers)
        .map_err(|error| preflight_broadcast_error(error, contains_broadcast))?
    {
        authenticate(
            &headers,
            &server,
            &runtime.auth,
            &runtime.network_tag,
            &RpcBinding {
                customer,
                chain: chain_id.clone(),
                body_sha256: body_hash(&body),
                resource: RpcResource::Rpc,
            },
        )
        .map_err(|error| preflight_broadcast_error(error, contains_broadcast))?;
        None
    } else {
        if !send_only {
            return Err(broadcast_error(
                StatusCode::UNAUTHORIZED,
                "rpc_auth_required",
                contains_broadcast,
                false,
            ));
        }
        Some(peer_ip(peer).map_err(|error| preflight_broadcast_error(error, contains_broadcast))?)
    };
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| {
            broadcast_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "rpc_busy",
                contains_broadcast,
                false,
            )
        })?;
    if let Some(ip) = anonymous_ip {
        runtime
            .broadcast_quota
            .charge(ip, 1, unix_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", true, denial))?;
    }
    let deadline = tokio::time::Instant::now() + runtime.timeout;
    let upstream = tokio::time::timeout_at(
        deadline,
        runtime
            .rpc_request_builder(chain.rpc.as_ref().unwrap(), body.to_vec())
            .send(),
    )
    .await
    .map_err(|_| {
        broadcast_error(
            StatusCode::GATEWAY_TIMEOUT,
            "rpc_upstream_timeout",
            contains_broadcast,
            true,
        )
    })?
    .map_err(|_| {
        broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            contains_broadcast,
            true,
        )
    })?;
    let upstream_status = upstream.status();
    let spool = tokio::time::timeout_at(
        deadline,
        super::json_rpc::spool_response(upstream, runtime.max_response_bytes, runtime.timeout),
    )
    .await
    .map_err(|_| {
        broadcast_error(
            StatusCode::GATEWAY_TIMEOUT,
            "rpc_upstream_timeout",
            contains_broadcast,
            true,
        )
    })?
    .map_err(|error| match error {
        super::json_rpc::SpoolError::TooLarge => broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_response_too_large",
            contains_broadcast,
            true,
        ),
        super::json_rpc::SpoolError::Timeout => broadcast_error(
            StatusCode::GATEWAY_TIMEOUT,
            "rpc_upstream_timeout",
            contains_broadcast,
            true,
        ),
        super::json_rpc::SpoolError::Io => broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            contains_broadcast,
            true,
        ),
    })?;
    let inspected = tokio::time::timeout_at(deadline, spool.inspect(version, correlation))
        .await
        .map_err(|_| {
            broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                contains_broadcast,
                true,
            )
        })?
        .map_err(|_| {
            broadcast_error(
                StatusCode::BAD_GATEWAY,
                "invalid_rpc_upstream_response",
                contains_broadcast,
                true,
            )
        })?;
    let body = spool
        .into_body(inspected.error_rewrites)
        .await
        .map_err(|_| {
            broadcast_error(
                StatusCode::BAD_GATEWAY,
                "rpc_upstream_unavailable",
                contains_broadcast,
                true,
            )
        })?;
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
        response,
        permit,
        runtime.timeout,
    ))
}

fn chronik_scope(chain: &str, method: &Method, path: &str, query: Option<&str>) -> String {
    format!(
        "chronik:{}:{}:/{}{}",
        chain,
        method,
        path,
        query.map(|query| format!("?{query}")).unwrap_or_default(),
    )
}

fn canonical_chronik_path(path: &str) -> Result<String, RpcRejection> {
    let path = path.strip_prefix('/').unwrap_or(path);
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty() || *segment == "." || *segment == ".." || segment.contains('\\')
        })
    {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_path"));
    }
    Ok(segments.join("/"))
}

fn validate_history_query(path: &str, query: Option<&str>) -> Result<(), RpcRejection> {
    if !matches!(
        path.rsplit('/').next(),
        Some("history" | "confirmed-txs" | "unconfirmed-txs")
    ) {
        return Ok(());
    }
    let mut page = false;
    let mut page_size = false;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "page" if !page => {
                value
                    .parse::<u32>()
                    .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_query"))?;
                page = true;
            }
            "page_size" if !page_size => {
                let size = value
                    .parse::<u32>()
                    .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_query"))?;
                if size == 0 || size > 200 {
                    return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_query"));
                }
                page_size = true;
            }
            _ => return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_query")),
        }
    }
    Ok(())
}

fn invalid_indexer_body() -> RpcRejection {
    rpc_error(StatusCode::BAD_REQUEST, "invalid_indexer_body")
}

fn read_protobuf_varint(body: &[u8], cursor: &mut usize) -> Result<u64, RpcRejection> {
    let mut value = 0_u64;
    for shift in (0..=63).step_by(7) {
        let byte = *body.get(*cursor).ok_or_else(invalid_indexer_body)?;
        *cursor += 1;
        if shift == 63 && byte > 1 {
            return Err(invalid_indexer_body());
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(invalid_indexer_body())
}

fn read_protobuf_bytes<'a>(body: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], RpcRejection> {
    let len =
        usize::try_from(read_protobuf_varint(body, cursor)?).map_err(|_| invalid_indexer_body())?;
    let end = cursor
        .checked_add(len)
        .filter(|end| *end <= body.len())
        .ok_or_else(invalid_indexer_body)?;
    let value = &body[*cursor..end];
    *cursor = end;
    Ok(value)
}

fn skip_protobuf_value(
    body: &[u8],
    cursor: &mut usize,
    wire_type: u64,
) -> Result<(), RpcRejection> {
    match wire_type {
        0 => {
            read_protobuf_varint(body, cursor)?;
        }
        1 => {
            *cursor = cursor
                .checked_add(8)
                .filter(|end| *end <= body.len())
                .ok_or_else(invalid_indexer_body)?;
        }
        2 => {
            read_protobuf_bytes(body, cursor)?;
        }
        5 => {
            *cursor = cursor
                .checked_add(4)
                .filter(|end| *end <= body.len())
                .ok_or_else(invalid_indexer_body)?;
        }
        _ => return Err(invalid_indexer_body()),
    }
    Ok(())
}

fn read_protobuf_key(body: &[u8], cursor: &mut usize) -> Result<(u64, u64), RpcRejection> {
    let key = read_protobuf_varint(body, cursor)?;
    let field = key >> 3;
    if field == 0 || field > 0x1fff_ffff {
        return Err(invalid_indexer_body());
    }
    Ok((field, key & 7))
}

fn validate_script_ref(body: &[u8]) -> Result<(), RpcRejection> {
    let mut cursor = 0;
    while cursor < body.len() {
        let (field, wire_type) = read_protobuf_key(body, &mut cursor)?;
        match (field, wire_type) {
            (1, 2) => {
                std::str::from_utf8(read_protobuf_bytes(body, &mut cursor)?)
                    .map_err(|_| invalid_indexer_body())?;
            }
            (2, 2) => {
                read_protobuf_bytes(body, &mut cursor)?;
            }
            (1 | 2, _) => return Err(invalid_indexer_body()),
            _ => skip_protobuf_value(body, &mut cursor, wire_type)?,
        }
    }
    Ok(())
}

fn count_script_batch_params(body: &[u8]) -> Result<u32, RpcRejection> {
    let mut cursor = 0;
    let mut count = 0_u32;
    while cursor < body.len() {
        let (field, wire_type) = read_protobuf_key(body, &mut cursor)?;
        if field == 1 {
            if wire_type != 2 {
                return Err(invalid_indexer_body());
            }
            let script = read_protobuf_bytes(body, &mut cursor)?;
            count += 1;
            if count > 500 {
                return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit"));
            }
            validate_script_ref(script)?;
        } else {
            skip_protobuf_value(body, &mut cursor, wire_type)?;
        }
    }
    if count == 0 {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit"));
    }
    Ok(count)
}

fn count_script_batch(body: &[u8]) -> Result<u32, RpcRejection> {
    let mut cursor = 0;
    let mut params = None;
    while cursor < body.len() {
        let (field, wire_type) = read_protobuf_key(body, &mut cursor)?;
        if field == 1 {
            if wire_type != 2 {
                return Err(invalid_indexer_body());
            }
            if params.is_some() {
                return Err(invalid_indexer_body());
            }
            params = Some(read_protobuf_bytes(body, &mut cursor)?);
        } else {
            skip_protobuf_value(body, &mut cursor, wire_type)?;
        }
    }
    count_script_batch_params(params.ok_or_else(invalid_indexer_body)?)
}

fn anonymous_chronik_units(
    method: &Method,
    path: &str,
    query: Option<&str>,
    body: &[u8],
) -> Result<u32, RpcRejection> {
    if method == Method::POST && matches!(path, "script/batch/utxos" | "script/batch/summary") {
        return count_script_batch(body);
    }
    validate_history_query(path, query)?;
    Ok(1)
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
    let path = canonical_chronik_path(&path)?;
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
    challenge(
        runtime,
        customer,
        chronik_scope(&chain_id, &method, &path, uri.query()),
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
    proxy_chronik_inner(
        chain_id, path, uri, method, peer, headers, server, body, None,
    )
    .await
}

pub(crate) async fn proxy_chronik_capability(
    Path((chain_id, capability, path)): Path<(String, String, String)>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Response, RpcRejection> {
    proxy_chronik_inner(
        chain_id,
        path,
        uri,
        method,
        None,
        headers,
        server,
        body,
        Some(capability),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn proxy_chronik_inner(
    chain_id: String,
    path: String,
    uri: axum::http::Uri,
    method: Method,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
    capability: Option<String>,
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
    let path = canonical_chronik_path(&path)?;
    let (public, broadcast) = chronik_policy(&method, &path)
        .ok_or_else(|| rpc_error(StatusCode::FORBIDDEN, "indexer_endpoint_denied"))?;
    if body.len() > runtime.max_request_bytes {
        return Err(preflight_broadcast_error(
            rpc_error(StatusCode::PAYLOAD_TOO_LARGE, "rpc_request_too_large"),
            broadcast,
        ));
    }
    let capability_customer = capability
        .as_deref()
        .map(|capability| {
            runtime
                .auth
                .verify_capability(capability, &chain_id, now_ms())
                .map(|verified| verified.0)
                .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
                .map_err(|error| preflight_broadcast_error(error, broadcast))
        })
        .transpose()?;
    let anonymous_charge = if capability_customer.is_some() {
        None
    } else if let Some(customer) =
        parse_customer(&headers).map_err(|error| preflight_broadcast_error(error, broadcast))?
    {
        authenticate(
            &headers,
            &server,
            &runtime.auth,
            &runtime.network_tag,
            &RpcBinding {
                customer,
                chain: chronik_scope(&chain_id, &method, &path, uri.query()),
                body_sha256: body_hash(&body),
                resource: RpcResource::Rpc,
            },
        )
        .map_err(|error| preflight_broadcast_error(error, broadcast))?;
        None
    } else {
        if !public && !broadcast {
            return Err(preflight_broadcast_error(
                rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"),
                broadcast,
            ));
        }
        let units = if broadcast {
            broadcast_units(&path, &body).map_err(|error| preflight_broadcast_error(error, true))?
        } else {
            anonymous_chronik_units(&method, &path, uri.query(), &body)?
        };
        Some((
            broadcast,
            peer_ip(peer).map_err(|error| preflight_broadcast_error(error, broadcast))?,
            units,
        ))
    };
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| {
            broadcast_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "rpc_busy",
                broadcast,
                false,
            )
        })?;
    if let Some((is_broadcast, ip, units)) = anonymous_charge {
        let quota = if is_broadcast {
            &runtime.broadcast_quota
        } else {
            &runtime.chronik_quota
        };
        quota
            .charge(ip, units, unix_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", is_broadcast, denial))?;
    }
    let url = chronik_endpoint_url(chain.chronik.as_ref().unwrap(), &path, uri.query()).map_err(
        |_| {
            broadcast_error(
                StatusCode::BAD_GATEWAY,
                "rpc_upstream_unavailable",
                broadcast,
                false,
            )
        },
    )?;
    let request = if method == Method::GET {
        runtime.client.get(url)
    } else {
        runtime
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
            .body(body.to_vec())
    };
    let upstream = runtime.bounded_request(request).await.map_err(|_| {
        broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            broadcast,
            true,
        )
    })?;
    let body = if upstream.status.is_success() {
        upstream.body
    } else {
        proto::Error::decode(upstream.body.as_ref()).map_err(|_| {
            broadcast_error(
                StatusCode::BAD_GATEWAY,
                "invalid_rpc_upstream_response",
                broadcast,
                true,
            )
        })?;
        // Provider-controlled errors are never forwarded verbatim: URL credentials can have
        // many equivalent encodings, so substring redaction cannot be complete.
        proto::Error {
            msg: "upstream Chronik error".to_string(),
        }
        .encode_to_vec()
        .into()
    };
    let response = (
        upstream.status,
        [(axum::http::header::CONTENT_TYPE, "application/x-protobuf")],
        body,
    )
        .into_response();
    Ok(crate::http::json_rpc::hold_response_permit(
        response,
        permit,
        runtime.timeout,
    ))
}

/// Extra request headers needed by Bitcoin-family proxy preflight requests.
pub const BITCOIN_PROXY_CORS_HEADERS: [&str; 1] = [PROXY_METHOD_HEADER];

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{body::Body, http::Request, routing, Router};
    use bitcoinsuite_core::Net;
    use cashweb_config::BitcoinProxyChainConf;
    use tempdir::TempDir;
    use tower::ServiceExt;

    use crate::{
        disabled_chain_adapter::DisabledChainAdapter, http::pop_protection::PopGate,
        p2p::peers::Peers, registry::Registry, store::db::Db, test_instance::placeholder_pop_conf,
    };

    #[test]
    fn node_rpc_allows_only_bounded_reads_and_anonymous_single_broadcast() {
        let read = br#"{"jsonrpc":"1.0","id":1,"method":"getblockhash","params":[1]}"#;
        assert_eq!(
            validate_rpc(read, 1024).unwrap(),
            (
                1,
                false,
                false,
                crate::http::json_rpc::JsonRpcVersion::Legacy
            )
        );
        let send = br#"{"jsonrpc":"1.0","id":1,"method":"sendrawtransaction","params":["00"]}"#;
        assert_eq!(
            validate_rpc(send, 1024).unwrap(),
            (
                10,
                true,
                true,
                crate::http::json_rpc::JsonRpcVersion::Legacy
            )
        );
        let v2 = br#"{"jsonrpc":"2.0","id":1,"method":"getblockhash","params":[1]}"#;
        assert_eq!(
            validate_rpc(v2, 1024).unwrap(),
            (1, false, false, crate::http::json_rpc::JsonRpcVersion::V2)
        );
        let denied = br#"{"jsonrpc":"1.0","id":1,"method":"dumpprivkey","params":[]}"#;
        assert!(validate_rpc(denied, 1024).is_err());
        let anonymous_batch = format!(
            "[{},{}]",
            String::from_utf8_lossy(send),
            String::from_utf8_lossy(send)
        );
        assert!(!validate_rpc(anonymous_batch.as_bytes(), 1024).unwrap().1);
        assert!(validate_rpc(anonymous_batch.as_bytes(), 1024).unwrap().2);
        let mixed_broadcast = format!(
            "[{},{}]",
            String::from_utf8_lossy(read),
            String::from_utf8_lossy(send)
        );
        let (_, send_only, contains_send, _) =
            validate_rpc(mixed_broadcast.as_bytes(), 1024).unwrap();
        assert!(!send_only);
        assert!(contains_send);
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
    fn chronik_paths_queries_and_batch_costs_are_bounded() {
        assert!(canonical_chronik_path("blocks/../pause").is_err());
        assert!(canonical_chronik_path("blocks\\..\\pause").is_err());
        assert_eq!(
            canonical_chronik_path("script/p2pkh/aa/history").unwrap(),
            "script/p2pkh/aa/history"
        );

        assert!(
            validate_history_query("script/p2pkh/aa/history", Some("page=0&page_size=200")).is_ok()
        );
        assert!(validate_history_query("script/p2pkh/aa/history", Some("page_size=201")).is_err());
        assert!(validate_history_query("script/p2pkh/aa/history", Some("page=0&page=1")).is_err());

        let body = ScriptBatchRequestWire {
            params: Some(ScriptBatchParamsWire {
                scripts: vec![
                    ScriptRefWire {
                        script_type: "p2pkh".to_string(),
                        payload: vec![1; 20],
                    },
                    ScriptRefWire {
                        script_type: "p2sh".to_string(),
                        payload: vec![2; 20],
                    },
                    ScriptRefWire {
                        script_type: "other".to_string(),
                        payload: vec![0x51],
                    },
                ],
            }),
        }
        .encode_to_vec();
        assert_eq!(
            anonymous_chronik_units(&Method::POST, "script/batch/utxos", None, &body).unwrap(),
            3
        );
        assert!(anonymous_chronik_units(&Method::POST, "script/batch/summary", None, &[]).is_err());

        let mut dense_params = Vec::new();
        for _ in 0..501 {
            dense_params.extend_from_slice(&[0x0a, 0x00]);
        }
        let mut dense_body = vec![0x0a, 0xea, 0x07];
        dense_body.extend_from_slice(&dense_params);
        assert!(
            anonymous_chronik_units(&Method::POST, "script/batch/utxos", None, &dense_body)
                .is_err()
        );

        assert!(anonymous_chronik_units(
            &Method::POST,
            "script/batch/utxos",
            None,
            &[0x0a, 0x02, 0x0a]
        )
        .is_err());
    }

    #[test]
    fn chronik_url_builder_cannot_escape_the_configured_base() {
        let base: Url = "https://user:secret@example.test/private?api_key=hidden"
            .parse()
            .unwrap();
        let url = chronik_endpoint_url(&base, "blocks/1/2", Some("page=0")).unwrap();
        assert_eq!(url.path(), "/private/blocks/1/2");
        assert_eq!(url.query(), Some("api_key=hidden&page=0"));
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
            capability_ttl: Duration::from_secs(60 * 60),
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
                id: "xec-regtest".to_string(),
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
        conf.chains[0].checkpoint_hash = hex::encode(&conventional_hash);
        assert!(matches!(
            BitcoinProxyRuntime::from_conf_with_env(&conf, vec![], |_| Some(url.clone())).await,
            Err(BitcoinProxyStartError::CheckpointMismatch { .. })
        ));

        conventional_hash[0] ^= 1;
        conf.chains[0].checkpoint_hash = hex::encode(&conventional_hash);
        conf.chains[0].rpc_upstream_env = Some("RPC_URL".to_string());
        let duplicate_rpc_body = format!(
            r#"{{"result":"{}","error":null,"id":"startup","id":"wrong"}}"#,
            hex::encode(conventional_hash)
        );
        let duplicate_rpc = Router::new().route(
            "/",
            routing::post(move || {
                let body = duplicate_rpc_body.clone();
                async move { body }
            }),
        );
        let rpc_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        rpc_listener.set_nonblocking(true).unwrap();
        let rpc_address = rpc_listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(rpc_listener)
                .unwrap()
                .serve(duplicate_rpc.into_make_service()),
        );
        let rpc_url = format!("http://{rpc_address}");
        assert!(matches!(
            BitcoinProxyRuntime::from_conf_with_env(&conf, vec![], |name| match name {
                "RPC_URL" => Some(rpc_url.clone()),
                "CHRONIK_URL" => Some(url.clone()),
                _ => None,
            })
            .await,
            Err(BitcoinProxyStartError::UpstreamUnavailable(_))
        ));
    }

    #[tokio::test]
    async fn capability_routes_forward_bitcoin_rpc_and_protected_chronik() {
        let upstream_calls = Arc::new(AtomicUsize::new(0));
        let rpc_calls = Arc::clone(&upstream_calls);
        let chronik_calls = Arc::clone(&upstream_calls);
        let chronik_body = proto::Block::default().encode_to_vec();
        let expected_chronik_body = chronik_body.clone();
        let mut chronik_error = proto::Error {
            msg: "txn-invalid".to_string(),
        }
        .encode_to_vec();
        chronik_error.extend_from_slice(&[0x7a, 0x03, b'a', b'b', b'c']);
        let error_calls = Arc::clone(&upstream_calls);
        let upstream = Router::new()
            .route(
                "/",
                routing::post(move |body: Bytes| {
                    let calls = Arc::clone(&rpc_calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        if request["jsonrpc"] == "2.0" {
                            (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({
                                    "jsonrpc": "2.0",
                                    "id": request["id"],
                                    "error": {"code": -26, "message": "rejected"}
                                })),
                            )
                                .into_response()
                        } else {
                            Json(json!({"result": "00", "error": null, "id": 1})).into_response()
                        }
                    }
                }),
            )
            .route(
                "/block/:id",
                routing::get(move || {
                    let calls = Arc::clone(&chronik_calls);
                    let body = chronik_body.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        body
                    }
                }),
            )
            .route(
                "/tx/:id",
                routing::get(move || {
                    let calls = Arc::clone(&error_calls);
                    let body = chronik_error.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        (StatusCode::BAD_REQUEST, body)
                    }
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

        let upstream_url: Url = format!("http://{address}").parse().unwrap();
        let runtime = Arc::new(BitcoinProxyRuntime {
            chains: HashMap::from([
                (
                    "xec-mainnet".to_string(),
                    Chain {
                        id: "xec-mainnet".to_string(),
                        rpc: Some(upstream_url.clone()),
                        chronik: Some(upstream_url.clone()),
                        checkpoint_height: 1,
                        checkpoint_hash: "00".repeat(32),
                    },
                ),
                (
                    "bch-mainnet".to_string(),
                    Chain {
                        id: "bch-mainnet".to_string(),
                        rpc: None,
                        chronik: Some(upstream_url),
                        checkpoint_height: 1,
                        checkpoint_hash: "00".repeat(32),
                    },
                ),
            ]),
            client: reqwest::Client::new(),
            auth: RpcAuthState::new(),
            network_tag: vec![],
            permits: Arc::new(Semaphore::new(4)),
            ingress_permits: Arc::new(Semaphore::new(4)),
            max_request_bytes: 1024,
            max_response_bytes: 1024,
            timeout: Duration::from_secs(1),
            chronik_quota: FixedHourQuota::new(100),
            broadcast_quota: FixedHourQuota::new(10),
            capability_ttl: Duration::from_secs(60 * 60),
        });
        let (capability, _) = runtime.auth.issue_capability(
            Address([7; 20]),
            "xec-mainnet",
            now_ms(),
            60 * 60 * 1000,
        );
        let (chronik_only_capability, _) = runtime.auth.issue_capability(
            Address([7; 20]),
            "bch-mainnet",
            now_ms(),
            60 * 60 * 1000,
        );
        let tempdir = TempDir::new("cashweb-registry--bitcoin-capability").unwrap();
        let registry = Registry::new(
            Db::open(tempdir.path().join("db.rocksdb")).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        );
        let server = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(PopGate::from_conf_if_enabled(&placeholder_pop_conf())),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: Some(runtime),
        };
        let router = server.into_router();
        let rpc_body = br#"{"jsonrpc":"1.0","id":1,"method":"getblockhash","params":[1]}"#;

        let rpc_response = router
            .clone()
            .oneshot(
                Request::post(format!("/chain-rpc/xec-mainnet/cap/{capability}/rpc"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(rpc_body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rpc_response.status(), StatusCode::OK);

        let rpc_v2_error = router
            .clone()
            .oneshot(
                Request::post(format!("/chain-rpc/xec-mainnet/cap/{capability}/rpc"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        br#"{"jsonrpc":"2.0","id":2,"method":"sendrawtransaction","params":["00"]}"#
                            .as_slice(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rpc_v2_error.status(), StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(
                &hyper::body::to_bytes(rpc_v2_error.into_body())
                    .await
                    .unwrap()
            )
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "error": {"code": -26, "message": "upstream RPC error"}
            })
        );

        let chronik_response = router
            .clone()
            .oneshot(
                Request::get(format!(
                    "/chain-rpc/xec-mainnet/cap/{capability}/chronik/block/abc"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(chronik_response.status(), StatusCode::OK);
        assert_eq!(
            hyper::body::to_bytes(chronik_response.into_body())
                .await
                .unwrap(),
            expected_chronik_body
        );

        let chronik_only_response = router
            .clone()
            .oneshot(
                Request::get(format!(
                    "/chain-rpc/bch-mainnet/cap/{chronik_only_capability}/chronik/block/abc"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(chronik_only_response.status(), StatusCode::OK);

        let chronik_error_response = router
            .clone()
            .oneshot(
                Request::get(format!(
                    "/chain-rpc/xec-mainnet/cap/{capability}/chronik/tx/abc"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(chronik_error_response.status(), StatusCode::BAD_REQUEST);
        let sanitized_chronik_error = proto::Error {
            msg: "upstream Chronik error".to_string(),
        }
        .encode_to_vec();
        assert_eq!(
            hyper::body::to_bytes(chronik_error_response.into_body())
                .await
                .unwrap(),
            sanitized_chronik_error
        );

        let anonymous_protected = router
            .clone()
            .oneshot(
                Request::get("/chain-rpc/xec-mainnet/chronik/block/abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anonymous_protected.status(), StatusCode::UNAUTHORIZED);

        let traversal = router
            .clone()
            .oneshot(
                Request::get(format!(
                    "/chain-rpc/xec-mainnet/cap/{capability}/chronik/blocks/%2e%2e/pause"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 5);

        let modified = router
            .oneshot(
                Request::post(format!("/chain-rpc/xec-mainnet/cap/{capability}0/rpc"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(rpc_body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(modified.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 5);
    }
}
