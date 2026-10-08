//! Bitcoin-family JSON-RPC and Chronik HTTP/Protobuf proxy.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{boxed, Bytes},
    extract::{
        connect_info::ConnectInfo,
        ws::{Message as ClientWsMessage, WebSocket, WebSocketUpgrade},
        Extension, OriginalUri, Path,
    },
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bitcoinsuite_chronik_client::proto;
use cashweb_config::{BitcoinProxyConf, BitcoinProxyConfigError};
use futures::{SinkExt, StreamExt};
use prost::Message;
use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message as UpstreamWsMessage},
};
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
        upstream_cooldown::UpstreamCooldownTracker,
    },
    monad_http::Address,
};

const PROXY_METHOD_HEADER: &str = "x-frank-proxy-method";
const MAX_STARTUP_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct Chain {
    id: String,
    rpc_urls: Vec<Url>,
    chronik_urls: Vec<Url>,
    electrum_urls: Vec<Url>,
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
            .field("rpc_urls_count", &self.rpc_urls.len())
            .field("chronik_urls_count", &self.chronik_urls.len())
            .field("electrum_urls_count", &self.electrum_urls.len())
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
    cooldowns: UpstreamCooldownTracker,
    customer_quota: Arc<FixedHourQuota<Address>>,
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
            .map(|chain| !chain.chronik_urls.is_empty())
            .unwrap_or(false)
    }

    pub(crate) fn body_admission(&self) -> (Arc<Semaphore>, usize, Duration) {
        (
            Arc::clone(&self.ingress_permits),
            self.max_request_bytes,
            self.timeout,
        )
    }

    pub(crate) fn configured_capabilities(&self) -> Vec<(String, bool, bool, bool)> {
        self.chains
            .values()
            .map(|chain| {
                (
                    chain.id.clone(),
                    !chain.rpc_urls.is_empty(),
                    !chain.chronik_urls.is_empty(),
                    !chain.electrum_urls.is_empty(),
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
            let resolve_urls = |primary: &Option<String>,
                                extras: &[String]|
             -> Result<Vec<Url>, BitcoinProxyStartError> {
                if primary.is_none() && extras.is_empty() {
                    return Ok(Vec::new());
                }
                let mut urls = Vec::new();
                let mut all_envs = Vec::new();
                if let Some(p) = primary {
                    all_envs.push(p.as_str());
                }
                for extra in extras {
                    all_envs.push(extra.as_str());
                }
                for env_name in &all_envs {
                    if let Some(raw) = env(env_name).filter(|s| !s.trim().is_empty()) {
                        for token in raw
                            .split([',', ' ', '\n', '\t'])
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            let url = token
                                .parse::<Url>()
                                .ok()
                                .filter(|u| {
                                    matches!(
                                        u.scheme(),
                                        "http" | "https" | "ws" | "wss" | "ssl" | "tcp"
                                    ) && u.host_str().is_some()
                                })
                                .ok_or_else(|| {
                                    BitcoinProxyStartError::InvalidUpstream(env_name.to_string())
                                })?;
                            if !urls.contains(&url) {
                                urls.push(url);
                            }
                        }
                    }
                }
                if urls.is_empty() {
                    let missing = primary
                        .as_ref()
                        .cloned()
                        .unwrap_or_else(|| extras[0].clone());
                    return Err(BitcoinProxyStartError::MissingUpstream(missing));
                }
                Ok(urls)
            };
            chains.insert(
                row.id.clone(),
                Chain {
                    id: row.id.clone(),
                    rpc_urls: resolve_urls(&row.rpc_upstream_env, &row.rpc_upstream_envs)?,
                    chronik_urls: resolve_urls(
                        &row.chronik_upstream_env,
                        &row.chronik_upstream_envs,
                    )?,
                    electrum_urls: resolve_urls(
                        &row.electrum_upstream_env,
                        &row.electrum_upstream_envs,
                    )?,
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
            cooldowns: UpstreamCooldownTracker::default(),
            customer_quota: Arc::new(FixedHourQuota::new(10_000)),
        });
        runtime.verify_checkpoints().await?;
        Ok(Some(runtime))
    }

    pub(crate) fn has_rpc_chain(&self, id: &str) -> bool {
        self.chains
            .get(id)
            .map(|c| !c.rpc_urls.is_empty() || !c.electrum_urls.is_empty())
            .unwrap_or(false)
    }

    async fn verify_checkpoints(&self) -> Result<(), BitcoinProxyStartError> {
        for chain in self.chains.values() {
            for url in &chain.rpc_urls {
                if matches!(url.scheme(), "http" | "https") {
                    let body = json!({"jsonrpc":"1.0","id":"startup","method":"getblockhash","params":[chain.checkpoint_height]});
                    let response = self
                        .bounded_request_with_limit(
                            self.rpc_request_builder(url, serde_json::to_vec(&body).unwrap()),
                            MAX_STARTUP_RESPONSE_BYTES,
                        )
                        .await
                        .map_err(|_| {
                            BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone())
                        })?;
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
            }
            for base in &chain.chronik_urls {
                if matches!(base.scheme(), "http" | "https") {
                    let url = chronik_endpoint_url(
                        base,
                        &format!("block/{}", chain.checkpoint_height),
                        None,
                    )
                    .map_err(|_| BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone()))?;
                    let bytes = self
                        .simple_request_with_limit(self.client.get(url), MAX_STARTUP_RESPONSE_BYTES)
                        .await
                        .map_err(|_| {
                            BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone())
                        })?;
                    let block = proto::Block::decode(bytes.as_ref()).map_err(|_| {
                        BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone())
                    })?;
                    let mut hash = block
                        .block_info
                        .ok_or_else(|| {
                            BitcoinProxyStartError::UpstreamUnavailable(chain.id.clone())
                        })?
                        .hash;
                    hash.reverse();
                    if hex::encode(hash) != chain.checkpoint_hash {
                        return Err(BitcoinProxyStartError::CheckpointMismatch {
                            id: chain.id.clone(),
                        });
                    }
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
) -> Result<(u32, bool, bool, super::json_rpc::JsonRpcVersion, bool), RpcRejection> {
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
    let mut is_electrum = false;
    let mut is_core_rpc = false;
    for call in calls {
        let obj = call
            .as_object()
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
        if !obj.contains_key("id") {
            return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
        }
        let call_version = match obj.get("jsonrpc") {
            None => super::json_rpc::JsonRpcVersion::Legacy,
            Some(Value::String(version)) if version == "1.0" => {
                super::json_rpc::JsonRpcVersion::Legacy
            }
            Some(Value::String(version)) if version == "2.0" => super::json_rpc::JsonRpcVersion::V2,
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
        let is_electrum_method = matches!(
            method,
            "server.version"
                | "server.ping"
                | "server.banner"
                | "server.features"
                | "blockchain.headers.subscribe"
                | "blockchain.estimatefee"
                | "blockchain.block.header"
                | "blockchain.block.headers"
                | "blockchain.scripthash.get_balance"
                | "blockchain.scripthash.get_history"
                | "blockchain.scripthash.get_mempool"
                | "blockchain.scripthash.listunspent"
                | "blockchain.scripthash.subscribe"
                | "blockchain.transaction.get"
                | "blockchain.transaction.broadcast"
                | "blockchain.transaction.get_merkle"
        );
        let is_node_method = matches!(
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
        if !is_electrum_method && !is_node_method {
            return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied"));
        }
        if is_electrum_method {
            is_electrum = true;
        }
        if is_node_method {
            is_core_rpc = true;
        }
        let is_broadcast =
            method == "sendrawtransaction" || method == "blockchain.transaction.broadcast";
        only_send &= is_broadcast;
        contains_send |= is_broadcast;
        units = units.saturating_add(if is_broadcast {
            10
        } else if matches!(
            method,
            "getblock" | "getrawtransaction" | "blockchain.transaction.get"
        ) {
            5
        } else {
            1
        });
    }
    if is_electrum && is_core_rpc {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
    }
    Ok((
        units,
        only_send,
        contains_send,
        version.expect("non-empty calls"),
        is_electrum,
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
        rpc_path: if !chain.rpc_urls.is_empty() || !chain.electrum_urls.is_empty() {
            Some(format!("/chain-rpc/{chain_id}/cap/{token}/rpc"))
        } else {
            None
        },
        chronik_path: if !chain.chronik_urls.is_empty() {
            Some(format!("/chain-rpc/{chain_id}/cap/{token}/chronik"))
        } else {
            None
        },
        ws_path: if !chain.electrum_urls.is_empty() {
            Some(format!("/chain-rpc/{chain_id}/cap/{token}/ws"))
        } else {
            None
        },
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
        .filter(|c| !c.rpc_urls.is_empty() || !c.electrum_urls.is_empty())
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let (_units, send_only, contains_broadcast, version, is_electrum) =
        validate_rpc(&body, runtime.max_request_bytes)?;
    let target_upstreams = if is_electrum {
        if !chain.electrum_urls.is_empty() {
            &chain.electrum_urls
        } else {
            &chain.rpc_urls
        }
    } else {
        if !chain.rpc_urls.is_empty() {
            &chain.rpc_urls
        } else {
            &chain.electrum_urls
        }
    };
    if target_upstreams.is_empty() {
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    }
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
    let ordered_upstreams = runtime.cooldowns.splay_order(target_upstreams);
    if ordered_upstreams.is_empty() {
        return Err(broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            contains_broadcast,
            true,
        ));
    }
    let mut last_error = None;
    let mut upstream_res = None;

    for (attempt, upstream_url) in ordered_upstreams.iter().enumerate() {
        let remaining_time = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining_time.is_zero() {
            return Err(broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                contains_broadcast,
                true,
            ));
        }

        let send_attempt = async {
            let upstream = runtime
                .rpc_request_builder(upstream_url, body.to_vec())
                .send()
                .await
                .map_err(|_| {
                    runtime.cooldowns.mark_failure(upstream_url);
                    broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        contains_broadcast,
                        true,
                    )
                })?;
            let status = upstream.status();
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                runtime.cooldowns.mark_failure(upstream_url);
                if attempt + 1 < ordered_upstreams.len() {
                    return Err(broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        contains_broadcast,
                        true,
                    ));
                }
            } else {
                runtime.cooldowns.mark_success(upstream_url);
            }
            let spool = super::json_rpc::spool_response(
                upstream,
                runtime.max_response_bytes,
                remaining_time,
            )
            .await
            .map_err(|error| match error {
                super::json_rpc::SpoolError::TooLarge => broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_response_too_large",
                    contains_broadcast,
                    true,
                ),
                super::json_rpc::SpoolError::Timeout => {
                    runtime.cooldowns.mark_failure(upstream_url);
                    broadcast_error(
                        StatusCode::GATEWAY_TIMEOUT,
                        "rpc_upstream_timeout",
                        contains_broadcast,
                        true,
                    )
                }
                super::json_rpc::SpoolError::Io => {
                    runtime.cooldowns.mark_failure(upstream_url);
                    broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        contains_broadcast,
                        true,
                    )
                }
            })?;
            Ok((status, spool))
        };

        match tokio::time::timeout_at(deadline, send_attempt).await {
            Ok(Ok((status, spool))) => {
                upstream_res = Some((status, spool));
                break;
            }
            Ok(Err(err)) => {
                last_error = Some(err);
            }
            Err(_) => {
                runtime.cooldowns.mark_failure(upstream_url);
                last_error = Some(broadcast_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "rpc_upstream_timeout",
                    contains_broadcast,
                    true,
                ));
            }
        }
    }

    let (upstream_status, spool) = match upstream_res {
        Some(res) => res,
        None => {
            return Err(last_error.unwrap_or_else(|| {
                broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    contains_broadcast,
                    true,
                )
            }));
        }
    };
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
        .filter(|c| !c.chronik_urls.is_empty())
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
        .filter(|c| !c.chronik_urls.is_empty())
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
    let deadline = tokio::time::Instant::now() + runtime.timeout;
    let ordered_upstreams = runtime.cooldowns.splay_order(&chain.chronik_urls);
    if ordered_upstreams.is_empty() {
        return Err(broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            broadcast,
            true,
        ));
    }
    let mut last_error = None;
    let mut upstream_res = None;

    for (attempt, base) in ordered_upstreams.iter().enumerate() {
        let remaining_time = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining_time.is_zero() {
            return Err(broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                broadcast,
                true,
            ));
        }

        let url = match chronik_endpoint_url(base, &path, uri.query()) {
            Ok(url) => url,
            Err(_) => {
                return Err(broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    broadcast,
                    false,
                ));
            }
        };
        let request = if method == Method::GET {
            runtime.client.get(url)
        } else {
            runtime
                .client
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
                .body(body.to_vec())
        };

        let send_attempt = async {
            let upstream = runtime.bounded_request(request).await.map_err(|_| {
                runtime.cooldowns.mark_failure(base);
                broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    broadcast,
                    true,
                )
            })?;
            if upstream.status.is_server_error()
                || upstream.status == reqwest::StatusCode::TOO_MANY_REQUESTS
            {
                runtime.cooldowns.mark_failure(base);
                if attempt + 1 < ordered_upstreams.len() {
                    return Err(broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        broadcast,
                        true,
                    ));
                }
            } else {
                runtime.cooldowns.mark_success(base);
            }
            Ok(upstream)
        };

        match tokio::time::timeout_at(deadline, send_attempt).await {
            Ok(Ok(upstream)) => {
                upstream_res = Some(upstream);
                break;
            }
            Ok(Err(err)) => {
                last_error = Some(err);
            }
            Err(_) => {
                runtime.cooldowns.mark_failure(base);
                last_error = Some(broadcast_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "rpc_upstream_timeout",
                    broadcast,
                    true,
                ));
            }
        }
    }

    let upstream = match upstream_res {
        Some(u) => u,
        None => {
            return Err(last_error.unwrap_or_else(|| {
                broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    broadcast,
                    true,
                )
            }));
        }
    };
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

const MAX_ELECTRUM_WS_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ELECTRUM_WS_PENDING_REQUESTS: usize = 64;
const MAX_ELECTRUM_WS_SUBSCRIPTIONS: usize = 256;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum ElectrumWsRpcId {
    String(String),
    Number(String),
    Null,
}

impl ElectrumWsRpcId {
    fn from_value(value: &Value) -> Option<Self> {
        if !crate::http::json_rpc::rpc_id_is_bounded(value) {
            return None;
        }
        match value {
            Value::String(value) => Some(Self::String(value.clone())),
            Value::Number(value) => Some(Self::Number(value.to_string())),
            Value::Null => Some(Self::Null),
            _ => None,
        }
    }
}

enum ElectrumWsPendingKind {
    Call,
    SubscribeScriptHash(String),
    SubscribeHeaders,
    UnsubscribeScriptHash(String),
}

struct ElectrumWsPending {
    id: Value,
    kind: ElectrumWsPendingKind,
    deadline: tokio::time::Instant,
    _permit: OwnedSemaphorePermit,
}

fn electrum_ws_error(id: Value, code: i64, message: &'static str) -> ClientWsMessage {
    ClientWsMessage::Text(
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string(),
    )
}

async fn bounded_ws_send<S, M>(sink: &mut S, message: M, deadline: tokio::time::Instant) -> bool
where
    S: futures::Sink<M> + Unpin,
{
    matches!(
        tokio::time::timeout_at(deadline, sink.send(message)).await,
        Ok(Ok(()))
    )
}

pub(crate) async fn handle_proxy_ws(
    chain_id: String,
    capability: String,
    server: RegistryServer,
    ws: WebSocketUpgrade,
) -> Result<Response, RpcRejection> {
    let runtime = server
        .bitcoin_proxy
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let chain = runtime.chains.get(&chain_id).expect("chain checked above");
    if chain.electrum_urls.is_empty() {
        return Err(rpc_error(StatusCode::NOT_FOUND, "rpc_ws_disabled"));
    }
    let (customer, expires_at_ms) = runtime
        .auth
        .verify_capability(&capability, &chain_id, now_ms())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"))?;
    let max_client_bytes = runtime.max_request_bytes;
    let max_upstream_bytes = runtime
        .max_response_bytes
        .min(MAX_ELECTRUM_WS_RESPONSE_BYTES);
    let timeout = runtime.timeout;
    let quota = runtime.customer_quota.clone();
    let request_permits = Arc::clone(&runtime.permits);
    let electrum_urls = chain.electrum_urls.clone();
    let cooldowns = runtime.cooldowns.clone();
    let lifetime_ms = expires_at_ms.saturating_sub(now_ms()).max(1) as u64;
    let expiry_deadline = tokio::time::Instant::now() + Duration::from_millis(lifetime_ms);

    Ok(ws
        .max_message_size(max_client_bytes)
        .max_frame_size(max_client_bytes)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let config = WebSocketConfig {
                max_send_queue: Some(32),
                max_message_size: Some(max_upstream_bytes),
                max_frame_size: Some(max_upstream_bytes),
                accept_unmasked_frames: false,
            };
            let ordered_upstreams = cooldowns.splay_order(&electrum_urls);
            let mut connected = None;
            for upstream_url in &ordered_upstreams {
                if tokio::time::Instant::now() >= expiry_deadline {
                    break;
                }
                let connect_deadline = expiry_deadline.min(tokio::time::Instant::now() + timeout);
                let res = tokio::time::timeout_at(
                    connect_deadline,
                    connect_async_with_config(upstream_url.as_str(), Some(config)),
                )
                .await;
                match res {
                    Ok(Ok((upstream_stream, _))) => {
                        cooldowns.mark_success(upstream_url);
                        connected = Some(upstream_stream);
                        break;
                    }
                    _ => {
                        cooldowns.mark_failure(upstream_url);
                    }
                }
            }
            let Some(upstream) = connected else {
                return;
            };
            proxy_electrum_ws_connection(
                socket,
                upstream,
                customer,
                quota,
                request_permits,
                timeout,
                expiry_deadline,
            )
            .await;
        })
        .into_response())
}

async fn proxy_electrum_ws_connection<S>(
    socket: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<S>,
    customer: Address,
    quota: Arc<FixedHourQuota<Address>>,
    request_permits: Arc<Semaphore>,
    request_timeout: Duration,
    expiry_deadline: tokio::time::Instant,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    enum WsEvent<C, U> {
        Client(C),
        Upstream(U),
    }

    let (mut client_write, mut client_read) = socket.split();
    let (mut upstream_write, mut upstream_read) = upstream.split();
    let mut active_subscriptions = HashSet::<String>::new();
    let mut pending = HashMap::<ElectrumWsRpcId, ElectrumWsPending>::new();

    loop {
        if tokio::time::Instant::now() >= expiry_deadline {
            break;
        }
        let next_deadline = pending.values().map(|request| request.deadline).min();
        let deadline = next_deadline
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86_400));
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(expiry_deadline) => break,
            _ = tokio::time::sleep_until(deadline), if next_deadline.is_some() => {
                let request = pending
                    .iter()
                    .min_by_key(|(_, request)| request.deadline)
                    .map(|(key, request)| (key.clone(), request.id.clone()));
                let Some((key, id)) = request else { continue; };
                pending.remove(&key);
                pending.clear();
                let cleanup_deadline = (tokio::time::Instant::now() + request_timeout)
                    .min(expiry_deadline);
                let _ = bounded_ws_send(
                    &mut client_write,
                    electrum_ws_error(id, -32002, "upstream request timed out"),
                    cleanup_deadline,
                ).await;
                let _ = bounded_ws_send(
                    &mut client_write,
                    ClientWsMessage::Close(None),
                    cleanup_deadline,
                ).await;
                let _ = bounded_ws_send(
                    &mut upstream_write,
                    UpstreamWsMessage::Close(None),
                    cleanup_deadline,
                ).await;
                return;
            }
            event = async {
                tokio::select! {
                    client = client_read.next() => WsEvent::Client(client),
                    upstream = upstream_read.next() => WsEvent::Upstream(upstream),
                }
            } => match event {
                WsEvent::Client(client) => {
                    let Some(Ok(client)) = client else { break; };
                    match client {
                        ClientWsMessage::Text(text) => {
                            let parsed = crate::http::json_rpc::parse_without_duplicate_keys(text.as_bytes());
                            let id = parsed.as_ref().ok().and_then(|value| value.get("id")).cloned().unwrap_or(Value::Null);
                            let Ok(value) = parsed else {
                                if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32600, "invalid request"), expiry_deadline).await { return; }
                                continue;
                            };
                            let Some(id_key) = ElectrumWsRpcId::from_value(&id) else {
                                if !bounded_ws_send(&mut client_write, electrum_ws_error(Value::Null, -32600, "invalid request id"), expiry_deadline).await { return; }
                                continue;
                            };
                            if pending.len() >= MAX_ELECTRUM_WS_PENDING_REQUESTS || pending.contains_key(&id_key) {
                                if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32005, "pending request limit exceeded"), expiry_deadline).await { return; }
                                continue;
                            }
                            let obj = match value.as_object() {
                                Some(o) => o,
                                None => {
                                    if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32600, "invalid request"), expiry_deadline).await { return; }
                                    continue;
                                }
                            };
                            let method = match obj.get("method").and_then(Value::as_str) {
                                Some(m) => m,
                                None => {
                                    if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32600, "method required"), expiry_deadline).await { return; }
                                    continue;
                                }
                            };
                            let is_electrum_method = matches!(
                                method,
                                "server.version"
                                    | "server.ping"
                                    | "server.banner"
                                    | "server.features"
                                    | "blockchain.headers.subscribe"
                                    | "blockchain.estimatefee"
                                    | "blockchain.block.header"
                                    | "blockchain.block.headers"
                                    | "blockchain.scripthash.get_balance"
                                    | "blockchain.scripthash.get_history"
                                    | "blockchain.scripthash.get_mempool"
                                    | "blockchain.scripthash.listunspent"
                                    | "blockchain.scripthash.subscribe"
                                    | "blockchain.scripthash.unsubscribe"
                                    | "blockchain.transaction.get"
                                    | "blockchain.transaction.broadcast"
                                    | "blockchain.transaction.get_merkle"
                            );
                            if !is_electrum_method {
                                if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32601, "method denied by relay"), expiry_deadline).await { return; }
                                continue;
                            }
                            let is_broadcast = method == "blockchain.transaction.broadcast";
                            let cost = if is_broadcast {
                                10
                            } else if matches!(method, "blockchain.transaction.get" | "blockchain.block.header" | "blockchain.block.headers") {
                                5
                            } else {
                                1
                            };
                            let request_permit = match Arc::clone(&request_permits).try_acquire_owned() {
                                Ok(p) => p,
                                Err(_) => {
                                    if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32005, "relay busy"), expiry_deadline).await { return; }
                                    continue;
                                }
                            };
                            if quota.charge(customer, cost, unix_seconds()).is_err() {
                                if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32005, "hourly quota exceeded"), expiry_deadline).await { return; }
                                continue;
                            }
                            let kind = match method {
                                "blockchain.scripthash.subscribe" => {
                                    let scripthash = obj
                                        .get("params")
                                        .and_then(Value::as_array)
                                        .and_then(|p| p.first())
                                        .and_then(Value::as_str)
                                        .unwrap_or_default();
                                    if scripthash.len() != 64 || !scripthash.chars().all(|c| c.is_ascii_hexdigit()) {
                                        if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32602, "invalid scripthash"), expiry_deadline).await { return; }
                                        continue;
                                    }
                                    if active_subscriptions.len() >= MAX_ELECTRUM_WS_SUBSCRIPTIONS {
                                        if !bounded_ws_send(&mut client_write, electrum_ws_error(id, -32005, "subscription limit exceeded"), expiry_deadline).await { return; }
                                        continue;
                                    }
                                    ElectrumWsPendingKind::SubscribeScriptHash(scripthash.to_string())
                                }
                                "blockchain.headers.subscribe" => ElectrumWsPendingKind::SubscribeHeaders,
                                "blockchain.scripthash.unsubscribe" => {
                                    let scripthash = obj
                                        .get("params")
                                        .and_then(Value::as_array)
                                        .and_then(|p| p.first())
                                        .and_then(Value::as_str)
                                        .unwrap_or_default();
                                    ElectrumWsPendingKind::UnsubscribeScriptHash(scripthash.to_string())
                                }
                                _ => ElectrumWsPendingKind::Call,
                            };
                            pending.insert(
                                id_key.clone(),
                                ElectrumWsPending {
                                    id: id.clone(),
                                    kind,
                                    deadline: tokio::time::Instant::now() + request_timeout,
                                    _permit: request_permit,
                                },
                            );
                            if !bounded_ws_send(&mut upstream_write, UpstreamWsMessage::Text(text), expiry_deadline).await {
                                pending.remove(&id_key);
                                break;
                            }
                        }
                        ClientWsMessage::Ping(payload) => {
                            if !bounded_ws_send(&mut client_write, ClientWsMessage::Pong(payload), expiry_deadline).await { break; }
                        }
                        ClientWsMessage::Close(_) => break,
                        ClientWsMessage::Binary(_) => {
                            if !bounded_ws_send(&mut client_write, electrum_ws_error(Value::Null, -32600, "binary requests not supported"), expiry_deadline).await { return; }
                        }
                        ClientWsMessage::Pong(_) => {}
                    }
                }
                WsEvent::Upstream(upstream) => {
                    let Some(Ok(upstream)) = upstream else { break; };
                    match upstream {
                        UpstreamWsMessage::Text(text) => {
                            let Ok(mut value) = crate::http::json_rpc::parse_without_duplicate_keys(text.as_bytes()) else { break; };
                            if let Some(id) = value.get("id").cloned() {
                                if id.is_null() && value.get("method").is_some() {
                                    handle_push_notification(&value, &mut active_subscriptions, &quota, customer, &mut client_write, expiry_deadline).await;
                                    continue;
                                }
                                let Some(id_key) = ElectrumWsRpcId::from_value(&id) else { break; };
                                let Some(request) = pending.remove(&id_key) else { break; };
                                if request.deadline <= tokio::time::Instant::now() {
                                    let _ = bounded_ws_send(
                                        &mut client_write,
                                        electrum_ws_error(request.id, -32002, "upstream request timed out"),
                                        expiry_deadline,
                                    ).await;
                                    return;
                                }
                                if value.get("error").is_none() || value.get("error") == Some(&Value::Null) {
                                    match request.kind {
                                        ElectrumWsPendingKind::SubscribeScriptHash(scripthash) => {
                                            active_subscriptions.insert(scripthash);
                                        }
                                        ElectrumWsPendingKind::SubscribeHeaders => {
                                            active_subscriptions.insert("__headers__".to_string());
                                        }
                                        ElectrumWsPendingKind::UnsubscribeScriptHash(scripthash) => {
                                            active_subscriptions.remove(&scripthash);
                                        }
                                        ElectrumWsPendingKind::Call => {}
                                    }
                                }
                                crate::http::json_rpc::sanitize_response_errors(&mut value);
                                if !bounded_ws_send(&mut client_write, ClientWsMessage::Text(value.to_string()), expiry_deadline).await { break; }
                            } else if value.get("method").is_some() {
                                handle_push_notification(&value, &mut active_subscriptions, &quota, customer, &mut client_write, expiry_deadline).await;
                            }
                        }
                        UpstreamWsMessage::Ping(payload) => {
                            if !bounded_ws_send(&mut upstream_write, UpstreamWsMessage::Pong(payload), expiry_deadline).await { break; }
                        }
                        UpstreamWsMessage::Close(_) => break,
                        UpstreamWsMessage::Binary(_) => break,
                        UpstreamWsMessage::Pong(_) | UpstreamWsMessage::Frame(_) => {}
                    }
                }
            }
        }
    }
    pending.clear();
    let close_deadline = (tokio::time::Instant::now() + request_timeout).min(expiry_deadline);
    let _ = bounded_ws_send(
        &mut client_write,
        ClientWsMessage::Close(None),
        close_deadline,
    )
    .await;
    let _ = bounded_ws_send(
        &mut upstream_write,
        UpstreamWsMessage::Close(None),
        close_deadline,
    )
    .await;
}

async fn handle_push_notification<S>(
    value: &Value,
    active_subscriptions: &mut HashSet<String>,
    quota: &Arc<FixedHourQuota<Address>>,
    customer: Address,
    client_write: &mut S,
    expiry_deadline: tokio::time::Instant,
) where
    S: futures::Sink<ClientWsMessage> + Unpin,
{
    let method = value.get("method").and_then(Value::as_str);
    let is_subscribed = match method {
        Some("blockchain.scripthash.subscribe") => {
            let scripthash = value
                .get("params")
                .and_then(Value::as_array)
                .and_then(|p| p.first())
                .and_then(Value::as_str);
            scripthash.is_some_and(|sh| active_subscriptions.contains(sh))
        }
        Some("blockchain.headers.subscribe") => active_subscriptions.contains("__headers__"),
        _ => false,
    };
    if is_subscribed {
        if quota.charge(customer, 1, unix_seconds()).is_ok() {
            let _ = bounded_ws_send(
                client_write,
                ClientWsMessage::Text(value.to_string()),
                expiry_deadline,
            )
            .await;
        }
    }
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
                crate::http::json_rpc::JsonRpcVersion::Legacy,
                false
            )
        );
        let send = br#"{"jsonrpc":"1.0","id":1,"method":"sendrawtransaction","params":["00"]}"#;
        assert_eq!(
            validate_rpc(send, 1024).unwrap(),
            (
                10,
                true,
                true,
                crate::http::json_rpc::JsonRpcVersion::Legacy,
                false
            )
        );
        let v2 = br#"{"jsonrpc":"2.0","id":1,"method":"getblockhash","params":[1]}"#;
        assert_eq!(
            validate_rpc(v2, 1024).unwrap(),
            (
                1,
                false,
                false,
                crate::http::json_rpc::JsonRpcVersion::V2,
                false
            )
        );
        let electrum_read = br#"{"jsonrpc":"2.0","id":1,"method":"blockchain.scripthash.listunspent","params":["00"]}"#;
        assert_eq!(
            validate_rpc(electrum_read, 1024).unwrap(),
            (
                1,
                false,
                false,
                crate::http::json_rpc::JsonRpcVersion::V2,
                true
            )
        );
        let electrum_broadcast = br#"{"jsonrpc":"2.0","id":1,"method":"blockchain.transaction.broadcast","params":["00"]}"#;
        assert_eq!(
            validate_rpc(electrum_broadcast, 1024).unwrap(),
            (
                10,
                true,
                true,
                crate::http::json_rpc::JsonRpcVersion::V2,
                true
            )
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
        let (_, send_only, contains_send, _, _) =
            validate_rpc(mixed_broadcast.as_bytes(), 1024).unwrap();
        assert!(!send_only);
        assert!(contains_send);
        let mixed_versions = format!(
            "[{},{}]",
            String::from_utf8_lossy(read),
            String::from_utf8_lossy(v2)
        );
        assert!(validate_rpc(mixed_versions.as_bytes(), 1024).is_err());
        let mixed_family = format!(
            "[{},{}]",
            String::from_utf8_lossy(read),
            String::from_utf8_lossy(electrum_read)
        );
        assert!(validate_rpc(mixed_family.as_bytes(), 1024).is_err());
        for malformed in [
            br#"{"jsonrpc":null,"id":1,"method":"getblockhash","params":[1]}"#.as_slice(),
            br#"{"jsonrpc":false,"id":1,"method":"getblockhash","params":[1]}"#.as_slice(),
            br#"{"jsonrpc":1,"id":1,"method":"getblockhash","params":[1]}"#.as_slice(),
        ] {
            assert!(validate_rpc(malformed, 1024).is_err());
        }
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
            rpc_urls: vec!["https://user:secret@rpc.example/key".parse().unwrap()],
            chronik_urls: vec!["https://chronik.example/secret".parse().unwrap()],
            electrum_urls: vec![],
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
            cooldowns: UpstreamCooldownTracker::default(),
            customer_quota: Arc::new(FixedHourQuota::new(10_000)),
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
                rpc_upstream_envs: vec![],
                chronik_upstream_env: Some("CHRONIK_URL".to_string()),
                chronik_upstream_envs: vec![],
                electrum_upstream_env: None,
                electrum_upstream_envs: vec![],
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
                        rpc_urls: vec![upstream_url.clone()],
                        chronik_urls: vec![upstream_url.clone()],
                        electrum_urls: vec![],
                        checkpoint_height: 1,
                        checkpoint_hash: "00".repeat(32),
                    },
                ),
                (
                    "bch-mainnet".to_string(),
                    Chain {
                        id: "bch-mainnet".to_string(),
                        rpc_urls: vec![],
                        chronik_urls: vec![upstream_url],
                        electrum_urls: vec![],
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
            cooldowns: UpstreamCooldownTracker::default(),
            customer_quota: Arc::new(FixedHourQuota::new(10_000)),
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
        let event_bus = registry.event_bus().clone();
        let server = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(PopGate::from_conf_if_enabled(&placeholder_pop_conf())),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: Some(runtime),
            solana_proxy: None,
            spa_dir: None,
            event_bus,
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

    #[tokio::test]
    async fn test_multi_upstream_rpc_failover() {
        let failing_upstream = Router::new().route(
            "/",
            routing::post(|| async {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "upstream crashed"})),
                )
            }),
        );
        let failing_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        failing_listener.set_nonblocking(true).unwrap();
        let failing_addr = failing_listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(failing_listener)
                .unwrap()
                .serve(failing_upstream.into_make_service()),
        );

        let working_upstream = Router::new().route(
            "/",
            routing::post(|| async {
                Json(json!({"result": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "error": null, "id": 1}))
            }),
        );
        let working_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        working_listener.set_nonblocking(true).unwrap();
        let working_addr = working_listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(working_listener)
                .unwrap()
                .serve(working_upstream.into_make_service()),
        );

        let failing_url: Url = format!("http://{failing_addr}").parse().unwrap();
        let working_url: Url = format!("http://{working_addr}").parse().unwrap();

        let runtime = Arc::new(BitcoinProxyRuntime {
            chains: HashMap::from([(
                "btc-mainnet".to_string(),
                Chain {
                    id: "btc-mainnet".to_string(),
                    rpc_urls: vec![failing_url, working_url],
                    chronik_urls: vec![],
                    electrum_urls: vec![],
                    checkpoint_height: 1,
                    checkpoint_hash: "00".repeat(32),
                },
            )]),
            client: reqwest::Client::new(),
            auth: RpcAuthState::new(),
            network_tag: vec![],
            permits: Arc::new(Semaphore::new(4)),
            ingress_permits: Arc::new(Semaphore::new(4)),
            max_request_bytes: 1024,
            max_response_bytes: 1024,
            timeout: Duration::from_secs(2),
            chronik_quota: FixedHourQuota::new(100),
            broadcast_quota: FixedHourQuota::new(10),
            capability_ttl: Duration::from_secs(60 * 60),
            cooldowns: UpstreamCooldownTracker::default(),
            customer_quota: Arc::new(FixedHourQuota::new(10_000)),
        });

        let (capability, _) = runtime.auth.issue_capability(
            Address([1; 20]),
            "btc-mainnet",
            now_ms(),
            60 * 60 * 1000,
        );

        let tempdir = TempDir::new("cashweb-registry--failover-test").unwrap();
        let registry = Registry::new(
            Db::open(tempdir.path().join("db.rocksdb")).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        );
        let event_bus = registry.event_bus().clone();
        let server = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(PopGate::from_conf_if_enabled(&placeholder_pop_conf())),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: Some(runtime),
            solana_proxy: None,
            spa_dir: None,
            event_bus,
        };
        let router = server.into_router();

        let rpc_body = br#"{"jsonrpc":"1.0","id":1,"method":"getblockhash","params":[1]}"#;
        let response = router
            .oneshot(
                Request::post(format!("/chain-rpc/btc-mainnet/cap/{capability}/rpc"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(rpc_body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let response_bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let json_resp: Value = serde_json::from_slice(&response_bytes).unwrap();
        assert_eq!(
            json_resp["result"],
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        );
    }
}
