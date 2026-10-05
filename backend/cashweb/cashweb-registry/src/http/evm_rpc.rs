//! Customer-authenticated, allowlisted EVM JSON-RPC relay proxy.
//!
//! The proxy has its own signing domain and binds authorization to the exact request bytes. Its
//! upstream URL is process-owned secret state: responses and diagnostics name only the public
//! chain id. Challenge issuance validates and hashes a bounded request but never contacts the
//! provider.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{boxed, Bytes, HttpBody},
    extract::{
        connect_info::ConnectInfo,
        ws::{Message as ClientWsMessage, WebSocket, WebSocketUpgrade},
        Extension, Path,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use cashweb_config::EvmRpcConf;
use futures::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message as UpstreamWsMessage},
};
use url::Url;

use crate::{
    http::{
        bitcoin_proxy::BitcoinProxyRuntime,
        hourly_quota::{normalize_quota_ip, FixedHourQuota, QuotaDenial},
        server::RegistryServer,
    },
    monad_http::Address,
    store::monad_messages::ChallengeConsumption,
};

type HmacSha256 = Hmac<Sha256>;

/// Hard all-family extraction ceiling. Each runtime applies its lower configured limit afterward.
pub const MAX_RPC_REQUEST_BYTES: usize = 512 * 1024;
pub(crate) const RPC_AUTH_DOMAIN: &str = "frank:rpc-http-auth:v1";
const RPC_CHALLENGE_MAC_DOMAIN: &[u8] = b"frank:rpc-challenge-mac:v1\0";
const RPC_CHALLENGE_TTL_MS: i64 = 60_000;
const RPC_CAPABILITY_MAC_DOMAIN: &[u8] = b"frank:rpc-capability-mac:v1\0";
const RPC_CAPABILITY_CUSTOMER_DOMAIN: &[u8] = b"frank:rpc-capability-customer:v1\0";
const RPC_CAPABILITY_NONCE_BYTES: usize = 16;
const RPC_CAPABILITY_BYTES: usize = 1 + 20 + 8 + RPC_CAPABILITY_NONCE_BYTES + 32;
const RPC_CAPABILITY_VERSION: u8 = 1;
const MAX_WS_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_WS_SUBSCRIPTIONS: usize = 32;
const MAX_WS_PENDING_REQUESTS: usize = 128;
const MAX_STARTUP_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_WS_SUBSCRIPTION_ID_BYTES: usize = 256;
// EVM clients batch when they can, but boot-time log scans and multi-account sweeps can still
// legitimately exceed the mailbox's much smaller read cadence. This is replay-retention capacity,
// not the usage limit; weighted fixed-hour quotas remain the resource-control boundary.
const MAX_USED_RPC_CHALLENGES_PER_CUSTOMER: usize = 2_048;
pub(crate) const RPC_CUSTOMER_HEADER: &str = "x-frank-rpc-customer";
/// Optional: the caller's directory key, lowercase compressed hex.
pub(crate) const RPC_SUBJECT_HEADER: &str = "x-frank-rpc-subject";
const RPC_EPOCH_HEADER: &str = "x-frank-rpc-epoch";
const RPC_NONCE_HEADER: &str = "x-frank-rpc-nonce";
const RPC_EXPIRY_HEADER: &str = "x-frank-rpc-expires-at-ms";
const RPC_TOKEN_HEADER: &str = "x-frank-rpc-token";
const RPC_SIGNATURE_HEADER: &str = "x-frank-rpc-signature";
const MIN_ECDSA_DER_SIGNATURE_BYTES: usize = 8;
const MAX_ECDSA_DER_SIGNATURE_BYTES: usize = 72;

/// A request body bounded before allocation, including for chunked requests.
#[derive(Debug)]
pub(crate) struct BoundedRpcBody {
    pub(crate) bytes: Bytes,
    pub(crate) _permit: OwnedSemaphorePermit,
}

#[async_trait::async_trait]
impl axum::extract::FromRequest<axum::body::Body> for BoundedRpcBody {
    type Rejection = RpcRejection;

    async fn from_request(
        req: &mut axum::extract::RequestParts<axum::body::Body>,
    ) -> Result<Self, Self::Rejection> {
        let path = req.uri().path();
        let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
        let chronik_path_start = if segments.get(2) == Some(&"chronik") {
            Some(3)
        } else if segments.get(2) == Some(&"cap") && segments.get(4) == Some(&"chronik") {
            Some(5)
        } else {
            None
        };
        let broadcast_route = req.method() == axum::http::Method::POST
            && chronik_path_start
                .and_then(|index| segments.get(index))
                .is_some_and(|segment| matches!(*segment, "broadcast-tx" | "broadcast-txs"));
        let server = req
            .extensions()
            .get::<RegistryServer>()
            .ok_or_else(|| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_unavailable"))
            .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
        let chain_id = segments
            .get(1)
            .filter(|_| segments.first() == Some(&"chain-rpc"))
            .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))
            .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
        let chronik_route = segments.get(2) == Some(&"chronik")
            || segments.get(2) == Some(&"chronik-auth")
            || (segments.get(2) == Some(&"cap") && segments.get(4) == Some(&"chronik"));
        let (permits, max_bytes, timeout) = if chronik_route {
            server
                .bitcoin_proxy
                .as_deref()
                .filter(|runtime| runtime.has_chronik_chain(chain_id))
                .map(BitcoinProxyRuntime::body_admission)
        } else {
            server
                .evm_rpc
                .as_deref()
                .filter(|runtime| runtime.has_chain(chain_id))
                .map(EvmRpcRuntime::body_admission)
                .or_else(|| {
                    server
                        .bitcoin_proxy
                        .as_deref()
                        .filter(|runtime| {
                            if segments.get(2) == Some(&"capability") {
                                runtime.has_chain(chain_id)
                            } else {
                                runtime.has_rpc_chain(chain_id)
                            }
                        })
                        .map(BitcoinProxyRuntime::body_admission)
                })
                .or_else(|| {
                    server
                        .solana_proxy
                        .as_deref()
                        .filter(|runtime| runtime.has_chain(chain_id))
                        .map(crate::http::solana_proxy::SolanaProxyRuntime::body_admission)
                })
        }
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))
        .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
        let permit = permits
            .try_acquire_owned()
            .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_ingress_busy"))
            .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
        let mut body = req
            .take_body()
            .ok_or_else(|| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_body_unavailable"))
            .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
        let read_body = async {
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::time::timeout(timeout, body.data())
                    .await
                    .map_err(|_| rpc_error(StatusCode::REQUEST_TIMEOUT, "rpc_body_timeout"))
                    .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
                let Some(chunk) = chunk else {
                    break;
                };
                let chunk = chunk
                    .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_rpc_body"))
                    .map_err(|error| preflight_broadcast_error(error, broadcast_route))?;
                if bytes.len().saturating_add(chunk.len()) > max_bytes {
                    return Err(preflight_broadcast_error(
                        rpc_error(StatusCode::PAYLOAD_TOO_LARGE, "rpc_request_too_large"),
                        broadcast_route,
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, RpcRejection>(bytes)
        };
        let bytes = tokio::time::timeout(timeout, read_body)
            .await
            .map_err(|_| rpc_error(StatusCode::REQUEST_TIMEOUT, "rpc_body_timeout"))
            .map_err(|error| preflight_broadcast_error(error, broadcast_route))??;
        Ok(Self {
            bytes: bytes.into(),
            _permit: permit,
        })
    }
}

#[derive(Clone)]
struct EvmChainRuntime {
    id: String,
    expected_chain_id: u64,
    upstream_url: Url,
    upstream_ws_url: Option<Url>,
    checkpoint: Option<(u64, String)>,
    max_get_logs_range: u64,
}

impl fmt::Debug for EvmChainRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvmChainRuntime")
            .field("id", &self.id)
            .field("expected_chain_id", &self.expected_chain_id)
            .field("upstream_url", &"<redacted>")
            .field(
                "upstream_ws_url",
                &self.upstream_ws_url.as_ref().map(|_| "<redacted>"),
            )
            .field("checkpoint", &self.checkpoint)
            .field("max_get_logs_range", &self.max_get_logs_range)
            .finish()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RpcChallenge {
    pub(crate) epoch: [u8; 32],
    pub(crate) nonce: [u8; 32],
    pub(crate) expires_at_ms: i64,
    pub(crate) token: [u8; 32],
}

#[derive(Clone)]
pub(crate) struct RpcBinding {
    pub(crate) customer: Address,
    pub(crate) chain: String,
    pub(crate) body_sha256: [u8; 32],
    pub(crate) resource: RpcResource,
}

#[derive(Clone, Copy)]
pub(crate) enum RpcResource {
    Rpc,
    Capability,
}

impl RpcBinding {
    fn append_canonical(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(b"POST\0/chain-rpc/");
        bytes.extend_from_slice(&(self.chain.len() as u32).to_be_bytes());
        bytes.extend_from_slice(self.chain.as_bytes());
        bytes.extend_from_slice(match self.resource {
            RpcResource::Rpc => b"\0rpc",
            RpcResource::Capability => b"\0capability",
        });
        bytes.extend_from_slice(&self.customer.0);
        bytes.extend_from_slice(&self.body_sha256);
    }
}

pub(crate) struct RpcAuthState {
    epoch: [u8; 32],
    secret: [u8; 32],
}

impl fmt::Debug for RpcAuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RpcAuthState")
            .field("epoch", &self.epoch)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl RpcAuthState {
    fn capability_customer_mask(&self, chain: &str, nonce: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts 32 bytes");
        mac.update(RPC_CAPABILITY_CUSTOMER_DOMAIN);
        mac.update(&(chain.len() as u32).to_be_bytes());
        mac.update(chain.as_bytes());
        mac.update(nonce);
        mac.finalize().into_bytes().into()
    }

    pub(crate) fn new() -> Self {
        let mut epoch = [0; 32];
        let mut secret = [0; 32];
        rand::thread_rng().fill_bytes(&mut epoch);
        rand::thread_rng().fill_bytes(&mut secret);
        Self { epoch, secret }
    }

    fn preimage(&self, binding: &RpcBinding, nonce: [u8; 32], expires_at_ms: i64) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(180 + binding.chain.len());
        bytes.extend_from_slice(RPC_CHALLENGE_MAC_DOMAIN);
        bytes.extend_from_slice(&self.epoch);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&expires_at_ms.to_be_bytes());
        binding.append_canonical(&mut bytes);
        bytes
    }

    pub(crate) fn issue(&self, binding: &RpcBinding, now_ms: i64) -> RpcChallenge {
        let mut nonce = [0; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        let expires_at_ms = now_ms.saturating_add(RPC_CHALLENGE_TTL_MS);
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts 32 bytes");
        mac.update(&self.preimage(binding, nonce, expires_at_ms));
        RpcChallenge {
            epoch: self.epoch,
            nonce,
            expires_at_ms,
            token: mac.finalize().into_bytes().into(),
        }
    }

    fn verify(&self, binding: &RpcBinding, challenge: RpcChallenge, now_ms: i64) -> bool {
        if challenge.epoch != self.epoch || challenge.expires_at_ms < now_ms {
            return false;
        }
        let Ok(mut mac) = HmacSha256::new_from_slice(&self.secret) else {
            return false;
        };
        mac.update(&self.preimage(binding, challenge.nonce, challenge.expires_at_ms));
        mac.verify_slice(&challenge.token).is_ok()
    }

    pub(crate) fn issue_capability(
        &self,
        customer: Address,
        chain: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> (String, i64) {
        let expires_at_ms = now_ms.saturating_add(ttl_ms);
        let mut nonce = [0; RPC_CAPABILITY_NONCE_BYTES];
        rand::thread_rng().fill_bytes(&mut nonce);
        let customer_mask = self.capability_customer_mask(chain, &nonce);
        let mut bytes = Vec::with_capacity(RPC_CAPABILITY_BYTES);
        bytes.push(RPC_CAPABILITY_VERSION);
        bytes.extend(
            customer
                .0
                .iter()
                .zip(customer_mask)
                .map(|(customer, mask)| customer ^ mask),
        );
        bytes.extend_from_slice(&expires_at_ms.to_be_bytes());
        bytes.extend_from_slice(&nonce);
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts 32 bytes");
        mac.update(RPC_CAPABILITY_MAC_DOMAIN);
        mac.update(&(chain.len() as u32).to_be_bytes());
        mac.update(chain.as_bytes());
        mac.update(&bytes);
        bytes.extend_from_slice(&mac.finalize().into_bytes());
        (hex::encode(bytes), expires_at_ms)
    }

    pub(crate) fn verify_capability(
        &self,
        token: &str,
        chain: &str,
        now_ms: i64,
    ) -> Option<(Address, i64)> {
        if token.len() != RPC_CAPABILITY_BYTES * 2 {
            return None;
        }
        let bytes = hex::decode(token).ok()?;
        if bytes.first().copied()? != RPC_CAPABILITY_VERSION {
            return None;
        }
        let expires_at_ms = i64::from_be_bytes(bytes[21..29].try_into().ok()?);
        if expires_at_ms < now_ms {
            return None;
        }
        let payload_len = RPC_CAPABILITY_BYTES - 32;
        let mut mac = HmacSha256::new_from_slice(&self.secret).ok()?;
        mac.update(RPC_CAPABILITY_MAC_DOMAIN);
        mac.update(&(chain.len() as u32).to_be_bytes());
        mac.update(chain.as_bytes());
        mac.update(&bytes[..payload_len]);
        mac.verify_slice(&bytes[payload_len..]).ok()?;
        let nonce = &bytes[29..29 + RPC_CAPABILITY_NONCE_BYTES];
        let customer_mask = self.capability_customer_mask(chain, nonce);
        let mut customer = [0; 20];
        for (index, byte) in customer.iter_mut().enumerate() {
            *byte = bytes[index + 1] ^ customer_mask[index];
        }
        Some((Address(customer), expires_at_ms))
    }
}

/// Validated process-owned EVM proxy state.
pub struct EvmRpcRuntime {
    chains: HashMap<String, EvmChainRuntime>,
    client: reqwest::Client,
    auth: RpcAuthState,
    network_tag: Vec<u8>,
    permits: Arc<Semaphore>,
    ingress_permits: Arc<Semaphore>,
    max_request_bytes: usize,
    max_batch_len: usize,
    max_response_bytes: usize,
    timeout: Duration,
    customer_quota: Arc<FixedHourQuota<Address>>,
    anonymous_quota: FixedHourQuota<IpAddr>,
    capability_ttl: Duration,
    ws_permits: Arc<Semaphore>,
    ws_customers: Arc<Mutex<HashMap<Address, usize>>>,
    ws_per_customer_limit: usize,
}

struct WsCustomerAdmission {
    customers: Arc<Mutex<HashMap<Address, usize>>>,
    customer: Address,
}

impl Drop for WsCustomerAdmission {
    fn drop(&mut self) {
        let Ok(mut customers) = self.customers.lock() else {
            return;
        };
        if let Some(count) = customers.get_mut(&self.customer) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                customers.remove(&self.customer);
            }
        }
    }
}

impl fmt::Debug for EvmRpcRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvmRpcRuntime")
            .field("chains", &self.chains)
            .field("auth", &self.auth)
            .field("network_tag", &self.network_tag)
            .field("max_request_bytes", &self.max_request_bytes)
            .field("max_batch_len", &self.max_batch_len)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Startup failure that deliberately never contains an upstream URL or response body.
#[derive(Debug, thiserror::Error)]
pub enum EvmRpcStartError {
    /// Static configuration is invalid.
    #[error("invalid EVM RPC configuration: {0}")]
    InvalidConfig(cashweb_config::EvmRpcConfigError),
    /// The named server-only environment variable is absent.
    #[error("missing EVM RPC upstream environment variable {0}")]
    MissingUpstream(String),
    /// The named environment variable does not contain a hosted URL of the required transport.
    #[error("EVM RPC upstream environment variable {0} is not a valid hosted transport URL")]
    InvalidUpstream(String),
    /// The upstream could not be validated before readiness.
    #[error("EVM RPC chain {0} failed startup identity validation")]
    UpstreamUnavailable(String),
    /// The upstream reported a different chain.
    #[error("EVM RPC chain {id} reported {actual}, expected {expected}")]
    ChainMismatch {
        /// Public registry id.
        id: String,
        /// Configured EIP-155 id.
        expected: u64,
        /// Reported EIP-155 id.
        actual: u64,
    },
    /// The upstream returned a different block at the configured checkpoint.
    #[error("EVM RPC chain {0} failed startup checkpoint validation")]
    CheckpointMismatch(String),
}

impl EvmRpcRuntime {
    pub(crate) fn has_chain(&self, id: &str) -> bool {
        self.chains.contains_key(id)
    }

    pub(crate) fn body_admission(&self) -> (Arc<Semaphore>, usize, Duration) {
        (
            Arc::clone(&self.ingress_permits),
            self.max_request_bytes,
            self.timeout,
        )
    }

    pub(crate) fn chain_ids(&self) -> Vec<String> {
        self.chains.keys().cloned().collect()
    }

    fn admit_ws_customer(&self, customer: Address) -> Result<WsCustomerAdmission, RpcRejection> {
        let mut customers = self
            .ws_customers
            .lock()
            .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"))?;
        let count = customers.entry(customer).or_default();
        if *count >= self.ws_per_customer_limit {
            return Err(rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"));
        }
        *count += 1;
        Ok(WsCustomerAdmission {
            customers: Arc::clone(&self.ws_customers),
            customer,
        })
    }

    /// Resolve secret URLs from the environment and verify every upstream before readiness.
    pub async fn from_conf_with_env(
        conf: &EvmRpcConf,
        network_tag: Vec<u8>,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Arc<Self>>, EvmRpcStartError> {
        conf.validate().map_err(EvmRpcStartError::InvalidConfig)?;
        if !conf.enabled {
            return Ok(None);
        }
        let mut chains = HashMap::new();
        for chain in &conf.chains {
            let raw = env(&chain.upstream_env)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| EvmRpcStartError::MissingUpstream(chain.upstream_env.clone()))?;
            let upstream_url = raw
                .trim()
                .parse::<Url>()
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
                .ok_or_else(|| EvmRpcStartError::InvalidUpstream(chain.upstream_env.clone()))?;
            let upstream_ws_url = chain
                .upstream_ws_env
                .as_deref()
                .and_then(|name| env(name).map(|raw| (name, raw)))
                .filter(|(_, raw)| !raw.trim().is_empty())
                .map(|(name, raw)| {
                    raw.trim()
                        .parse::<Url>()
                        .ok()
                        .filter(|url| {
                            matches!(url.scheme(), "ws" | "wss") && url.host_str().is_some()
                        })
                        .ok_or_else(|| EvmRpcStartError::InvalidUpstream(name.to_string()))
                })
                .transpose()?;
            chains.insert(
                chain.id.clone(),
                EvmChainRuntime {
                    id: chain.id.clone(),
                    expected_chain_id: chain.expected_chain_id,
                    upstream_url,
                    upstream_ws_url,
                    checkpoint: chain
                        .checkpoint_block_number
                        .zip(chain.checkpoint_block_hash.clone()),
                    max_get_logs_range: chain.max_get_logs_range,
                },
            );
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable("client".to_string()))?;
        let runtime = Arc::new(Self {
            chains,
            client,
            auth: RpcAuthState::new(),
            network_tag,
            permits: Arc::new(Semaphore::new(conf.max_concurrency)),
            ingress_permits: Arc::new(Semaphore::new(conf.max_concurrency)),
            max_request_bytes: conf.max_request_bytes,
            max_batch_len: conf.max_batch_len,
            max_response_bytes: conf.max_response_bytes,
            timeout: Duration::from_millis(conf.timeout_ms),
            customer_quota: Arc::new(FixedHourQuota::new(conf.customer_units_per_hour)),
            anonymous_quota: FixedHourQuota::new(conf.anonymous_units_per_hour),
            capability_ttl: Duration::from_millis(conf.capability_ttl_ms),
            ws_permits: Arc::new(Semaphore::new(conf.max_concurrency)),
            ws_customers: Arc::new(Mutex::new(HashMap::new())),
            ws_per_customer_limit: (conf.max_concurrency / 4).max(1),
        });
        runtime.verify_chain_identities().await?;
        Ok(Some(runtime))
    }

    async fn verify_chain_identities(&self) -> Result<(), EvmRpcStartError> {
        for chain in self.chains.values() {
            let response = tokio::time::timeout(
                self.timeout,
                self.client
                    .post(chain.upstream_url.clone())
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#)
                    .send(),
            )
            .await
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
            if !response.status().is_success() {
                return Err(EvmRpcStartError::UpstreamUnavailable(chain.id.clone()));
            }
            let bytes = tokio::time::timeout(
                self.timeout,
                read_startup_response(response, MAX_STARTUP_RESPONSE_BYTES, &chain.id),
            )
            .await
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))??;
            let result = super::json_rpc::startup_result(
                &bytes,
                super::json_rpc::JsonRpcVersion::V2,
                &json!(1),
            )
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|value| u64::from_str_radix(value.strip_prefix("0x")?, 16).ok())
            .ok_or_else(|| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
            if result != chain.expected_chain_id {
                return Err(EvmRpcStartError::ChainMismatch {
                    id: chain.id.clone(),
                    expected: chain.expected_chain_id,
                    actual: result,
                });
            }
            if let Some((block_number, expected_hash)) = &chain.checkpoint {
                let body = json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_getBlockByNumber",
                    "params": [format!("0x{block_number:x}"), false]
                });
                let response = tokio::time::timeout(
                    self.timeout,
                    self.client
                        .post(chain.upstream_url.clone())
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(serde_json::to_vec(&body).expect("JSON value serializes"))
                        .send(),
                )
                .await
                .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?
                .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !response.status().is_success() {
                    return Err(EvmRpcStartError::UpstreamUnavailable(chain.id.clone()));
                }
                let bytes = tokio::time::timeout(
                    self.timeout,
                    read_startup_response(response, MAX_STARTUP_RESPONSE_BYTES, &chain.id),
                )
                .await
                .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))??;
                let actual = super::json_rpc::startup_result(
                    &bytes,
                    super::json_rpc::JsonRpcVersion::V2,
                    &json!(1),
                )
                .and_then(|value| value.get("hash")?.as_str().map(str::to_owned))
                .ok_or_else(|| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !actual.eq_ignore_ascii_case(expected_hash) {
                    return Err(EvmRpcStartError::CheckpointMismatch(chain.id.clone()));
                }
            }
            if let Some(url) = &chain.upstream_ws_url {
                self.verify_ws_identity(chain, url).await?;
            }
        }
        Ok(())
    }

    async fn verify_ws_identity(
        &self,
        chain: &EvmChainRuntime,
        url: &Url,
    ) -> Result<(), EvmRpcStartError> {
        let config = WebSocketConfig {
            max_send_queue: Some(4),
            max_message_size: Some(self.max_response_bytes.min(MAX_WS_RESPONSE_BYTES)),
            max_frame_size: Some(self.max_response_bytes.min(MAX_WS_RESPONSE_BYTES)),
            accept_unmasked_frames: false,
        };
        let (mut socket, _) = tokio::time::timeout(
            self.timeout,
            connect_async_with_config(url.as_str(), Some(config)),
        )
        .await
        .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?
        .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
        let deadline = tokio::time::Instant::now() + self.timeout;
        verify_ws_socket(&mut socket, chain, deadline).await?;
        let _ = tokio::time::timeout_at(deadline, socket.close(None)).await;
        Ok(())
    }
}

async fn verify_ws_socket<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    chain: &EvmChainRuntime,
    deadline: tokio::time::Instant,
) -> Result<(), EvmRpcStartError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let chain_id = ws_startup_call(
        socket,
        json!({"jsonrpc":"2.0","id":"frank-chain-id","method":"eth_chainId","params":[]}),
        "frank-chain-id",
        deadline,
        &chain.id,
    )
    .await?
    .as_str()
    .and_then(|value| u64::from_str_radix(value.strip_prefix("0x")?, 16).ok())
    .ok_or_else(|| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
    if chain_id != chain.expected_chain_id {
        return Err(EvmRpcStartError::ChainMismatch {
            id: chain.id.clone(),
            expected: chain.expected_chain_id,
            actual: chain_id,
        });
    }
    if let Some((block_number, expected_hash)) = &chain.checkpoint {
        let result = ws_startup_call(
            socket,
            json!({
                "jsonrpc":"2.0",
                "id":"frank-checkpoint",
                "method":"eth_getBlockByNumber",
                "params":[format!("0x{block_number:x}"), false]
            }),
            "frank-checkpoint",
            deadline,
            &chain.id,
        )
        .await?;
        let actual = result
            .pointer("/hash")
            .and_then(Value::as_str)
            .ok_or_else(|| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
        if !actual.eq_ignore_ascii_case(expected_hash) {
            return Err(EvmRpcStartError::CheckpointMismatch(chain.id.clone()));
        }
    }
    Ok(())
}

async fn ws_startup_call<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    request: Value,
    expected_id: &str,
    deadline: tokio::time::Instant,
    chain_id: &str,
) -> Result<Value, EvmRpcStartError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout_at(deadline, async {
        socket
            .send(UpstreamWsMessage::Text(request.to_string()))
            .await
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()))?;
        loop {
            match socket.next().await {
                Some(Ok(UpstreamWsMessage::Text(text))) => {
                    let value = super::json_rpc::parse_without_duplicate_keys(text.as_bytes())
                        .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()))?;
                    if !valid_ws_response(&value)
                        || value.get("id").and_then(Value::as_str) != Some(expected_id)
                    {
                        return Err(EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()));
                    }
                    return value.get("result").cloned().ok_or_else(|| {
                        EvmRpcStartError::UpstreamUnavailable(chain_id.to_string())
                    });
                }
                Some(Ok(UpstreamWsMessage::Ping(payload))) => {
                    socket
                        .send(UpstreamWsMessage::Pong(payload))
                        .await
                        .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()))?;
                }
                Some(Ok(UpstreamWsMessage::Pong(_))) => {}
                _ => return Err(EvmRpcStartError::UpstreamUnavailable(chain_id.to_string())),
            }
        }
    })
    .await
    .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()))?
}

async fn read_startup_response(
    mut response: reqwest::Response,
    max_bytes: usize,
    chain_id: &str,
) -> Result<Bytes, EvmRpcStartError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(EvmRpcStartError::UpstreamUnavailable(chain_id.to_string()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.into())
}

#[derive(Serialize)]
pub(crate) struct RpcChallengeBody {
    pub(crate) epoch: String,
    pub(crate) nonce: String,
    pub(crate) expires_at_ms: i64,
    pub(crate) token: String,
    pub(crate) signing_domain: &'static str,
    pub(crate) customer: String,
    pub(crate) chain: String,
    pub(crate) body_sha256: String,
    pub(crate) network_tag: String,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RpcRejection {
    status: StatusCode,
    code: &'static str,
    broadcast_state: Option<&'static str>,
    quota_reset_unix_seconds: Option<u64>,
}

impl RpcRejection {
    #[allow(dead_code)]
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    #[allow(dead_code)]
    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl IntoResponse for RpcRejection {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.code });
        if let Some(state) = self.broadcast_state {
            body["broadcast_state"] = Value::String(state.to_string());
        }
        if let Some(reset) = self.quota_reset_unix_seconds {
            body["reset_at_unix_seconds"] = Value::from(reset);
        }
        let mut response = (self.status, Json(body)).into_response();
        if let Some(reset) = self.quota_reset_unix_seconds {
            let retry_after = reset.saturating_sub(now_seconds()).max(1).to_string();
            if let Ok(value) = axum::http::HeaderValue::from_str(&retry_after) {
                response
                    .headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, value);
            }
        }
        response
    }
}

pub(crate) fn rpc_error(status: StatusCode, code: &'static str) -> RpcRejection {
    RpcRejection {
        status,
        code,
        broadcast_state: None,
        quota_reset_unix_seconds: None,
    }
}

pub(crate) fn broadcast_error(
    status: StatusCode,
    code: &'static str,
    broadcast: bool,
    attempted: bool,
) -> RpcRejection {
    RpcRejection {
        status,
        code,
        broadcast_state: broadcast.then_some(if attempted {
            "unknown"
        } else {
            "not-attempted"
        }),
        quota_reset_unix_seconds: None,
    }
}

pub(crate) fn preflight_broadcast_error(
    mut rejection: RpcRejection,
    broadcast: bool,
) -> RpcRejection {
    if broadcast {
        rejection.broadcast_state = Some("not-attempted");
    }
    rejection
}

pub(crate) fn quota_error(
    code: &'static str,
    broadcast: bool,
    denial: QuotaDenial,
) -> RpcRejection {
    let (status, response_code, reset) = match denial {
        QuotaDenial::Exhausted { reset_unix_seconds } => (
            StatusCode::TOO_MANY_REQUESTS,
            code,
            Some(reset_unix_seconds),
        ),
        QuotaDenial::Disabled => (StatusCode::FORBIDDEN, "rpc_quota_disabled", None),
        QuotaDenial::RequestTooLarge => (
            StatusCode::TOO_MANY_REQUESTS,
            "rpc_quota_request_too_large",
            None,
        ),
        QuotaDenial::Capacity | QuotaDenial::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "rpc_quota_unavailable",
            None,
        ),
    };
    let mut rejection = broadcast_error(status, response_code, broadcast, false);
    if let Some(reset_unix_seconds) = reset {
        rejection.quota_reset_unix_seconds = Some(reset_unix_seconds);
    }
    rejection
}

fn parse_hex_quantity(value: &Value) -> Option<u64> {
    let value = value.as_str()?.strip_prefix("0x")?;
    (!value.is_empty())
        .then(|| u64::from_str_radix(value, 16).ok())
        .flatten()
}

#[derive(Clone, Copy)]
struct CallCost {
    units: u32,
    anonymous: bool,
    broadcast: bool,
}

fn validate_call(call: &Value, chain: &EvmChainRuntime) -> Result<CallCost, RpcRejection> {
    let object = call
        .as_object()
        .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !object.contains_key("id")
        || object.get("method").and_then(Value::as_str).is_none()
    {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
    }
    let method = object["method"].as_str().expect("checked above");
    let allowed = matches!(
        method,
        "eth_chainId"
            | "eth_blockNumber"
            | "eth_getBalance"
            | "eth_getTransactionCount"
            | "eth_gasPrice"
            | "eth_feeHistory"
            | "eth_maxPriorityFeePerGas"
            | "eth_estimateGas"
            | "eth_call"
            | "eth_getTransactionByHash"
            | "eth_getTransactionReceipt"
            | "eth_getBlockByNumber"
            | "eth_getLogs"
            | "eth_sendRawTransaction"
    );
    if !allowed {
        return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied"));
    }
    let params = object.get("params").unwrap_or(&Value::Null);
    if method == "eth_getBlockByNumber"
        && params
            .as_array()
            .and_then(|items| items.get(1))
            .and_then(Value::as_bool)
            != Some(false)
    {
        return Err(rpc_error(StatusCode::FORBIDDEN, "full_blocks_denied"));
    }
    if method == "eth_getLogs" {
        let filter = params
            .as_array()
            .and_then(|items| items.first())
            .and_then(Value::as_object)
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "bounded_log_range_required"))?;
        let from = filter
            .get("fromBlock")
            .and_then(parse_hex_quantity)
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "bounded_log_range_required"))?;
        let to = filter
            .get("toBlock")
            .and_then(parse_hex_quantity)
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "bounded_log_range_required"))?;
        if to < from || to.saturating_sub(from).saturating_add(1) > chain.max_get_logs_range {
            return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_log_range_denied"));
        }
    }
    if method == "eth_feeHistory" {
        let count = params
            .as_array()
            .and_then(|items| items.first())
            .and_then(parse_hex_quantity)
            .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "bounded_fee_history_required"))?;
        if count == 0 || count > 20 {
            return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_fee_history_denied"));
        }
    }
    let cost = match method {
        "eth_chainId" | "eth_blockNumber" | "eth_gasPrice" | "eth_maxPriorityFeePerGas" => {
            CallCost {
                units: 1,
                anonymous: true,
                broadcast: false,
            }
        }
        "eth_getBalance"
        | "eth_getTransactionCount"
        | "eth_getTransactionByHash"
        | "eth_getTransactionReceipt" => CallCost {
            units: 2,
            anonymous: true,
            broadcast: false,
        },
        "eth_feeHistory" => CallCost {
            units: 5,
            anonymous: true,
            broadcast: false,
        },
        "eth_sendRawTransaction" => CallCost {
            units: 20,
            anonymous: true,
            broadcast: true,
        },
        "eth_getBlockByNumber" => CallCost {
            units: 5,
            anonymous: false,
            broadcast: false,
        },
        "eth_estimateGas" | "eth_call" => CallCost {
            units: 20,
            anonymous: false,
            broadcast: false,
        },
        "eth_getLogs" => CallCost {
            units: 25,
            anonymous: false,
            broadcast: false,
        },
        _ => unreachable!("allowlist checked above"),
    };
    Ok(cost)
}

fn validate_body(
    runtime: &EvmRpcRuntime,
    chain: &EvmChainRuntime,
    body: &[u8],
) -> Result<CallCost, RpcRejection> {
    if body.is_empty() || body.len() > runtime.max_request_bytes {
        return Err(rpc_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "rpc_request_too_large",
        ));
    }
    let value = super::json_rpc::parse_without_duplicate_keys(body)
        .map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
    match value {
        Value::Array(calls) => {
            if calls.is_empty() || calls.len() > runtime.max_batch_len {
                return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit"));
            }
            let mut units = 0u32;
            let mut anonymous = true;
            let mut broadcast = false;
            let mut ids = Vec::with_capacity(calls.len());
            for call in &calls {
                let cost = validate_call(call, chain)?;
                let id = call.get("id").expect("validate_call requires an id");
                if ids.contains(id) {
                    return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
                }
                ids.push(id.clone());
                units = units.saturating_add(cost.units);
                anonymous &= cost.anonymous;
                broadcast |= cost.broadcast;
            }
            Ok(CallCost {
                units,
                anonymous,
                broadcast,
            })
        }
        value => validate_call(&value, chain),
    }
}

fn quota_ip(address: SocketAddr) -> IpAddr {
    normalize_quota_ip(address.ip())
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn body_hash(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}

fn auth_preimage(challenge: RpcChallenge, binding: &RpcBinding, network_tag: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(220 + binding.chain.len() + network_tag.len());
    bytes.extend_from_slice(RPC_AUTH_DOMAIN.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&challenge.epoch);
    bytes.extend_from_slice(&challenge.nonce);
    bytes.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(&challenge.token);
    binding.append_canonical(&mut bytes);
    bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
    bytes.extend_from_slice(network_tag);
    bytes
}

fn parse_hex_header(headers: &HeaderMap, name: &'static str) -> Result<[u8; 32], RpcRejection> {
    let value = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    if value.len() != 64 {
        return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"));
    }
    let mut decoded = [0; 32];
    hex::decode_to_slice(value, &mut decoded)
        .map_err(|_| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    Ok(decoded)
}

#[cfg(test)]
thread_local! {
    static DIRECTORY_LOOKUPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The key of the published directory subject whose address is `customer`, when its entry is
/// current. A canonical account has no legacy profile key on this relay, so this is the only key
/// its RPC proxy signature can be checked against. The caller may present its key in
/// `x-frank-rpc-subject`; otherwise the relay finds it through its address index. Either way the
/// key must hash to `customer` and must have a published, unexpired entry on the network whose
/// chain is the one being proxied.
///
/// `Ok(None)` means the customer has no such entry and the legacy profile key applies. Asking the
/// owner takes one of its few queue slots, so callers do it only after the challenge was verified.
/// When the owner cannot answer now the request is refused as retryable instead of being judged
/// without its key.
async fn admitted_customer(
    server: &RegistryServer,
    headers: &HeaderMap,
    network_tag: &[u8],
    expected_chain_id: u64,
    customer: Address,
) -> Result<Option<Vec<u8>>, RpcRejection> {
    let Some(descriptor) = crate::network_tag::monad_network(network_tag) else {
        return Ok(None);
    };
    if descriptor.evm_chain_id != expected_chain_id {
        return Ok(None);
    }
    let Some(directory) = server.registry.canonical_dm().directory() else {
        return Ok(None);
    };
    let presented = match headers.get(RPC_SUBJECT_HEADER) {
        Some(value) => Some(
            value
                .to_str()
                .ok()
                .filter(|point| {
                    crate::directory_runtime::valid_key(descriptor.cbor_identifier, point)
                })
                .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?
                .to_owned(),
        ),
        None => directory.subject_for_address(descriptor.cbor_identifier, &customer.0),
    };
    let Some(point) = presented.and_then(|point| hex::decode(point).ok()) else {
        return Ok(None);
    };
    #[cfg(test)]
    DIRECTORY_LOOKUPS.set(DIRECTORY_LOOKUPS.get() + 1);
    super::monad_message_cbor::admitted_point_or_busy(server, descriptor, customer, point)
        .await
        .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_auth_busy"))
}

/// The parts of a customer proof that are checked without the customer's key.
struct ParsedAuthentication {
    challenge: RpcChallenge,
    signature: Vec<u8>,
}

/// Parse the proof headers and verify the challenge (epoch, MAC, expiry and binding). Reads no
/// key and no storage, so a request that fails here costs nothing else.
fn parse_authentication(
    headers: &HeaderMap,
    auth: &RpcAuthState,
    binding: &RpcBinding,
) -> Result<ParsedAuthentication, RpcRejection> {
    let challenge = RpcChallenge {
        epoch: parse_hex_header(headers, RPC_EPOCH_HEADER)?,
        nonce: parse_hex_header(headers, RPC_NONCE_HEADER)?,
        token: parse_hex_header(headers, RPC_TOKEN_HEADER)?,
        expires_at_ms: headers
            .get(RPC_EXPIRY_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?,
    };
    let signature = headers
        .get(RPC_SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    if signature.len() % 2 != 0
        || signature.len() < MIN_ECDSA_DER_SIGNATURE_BYTES * 2
        || signature.len() > MAX_ECDSA_DER_SIGNATURE_BYTES * 2
        || !auth.verify(binding, challenge, now_ms())
    {
        return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"));
    }
    let signature = hex::decode(signature)
        .map_err(|_| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    Ok(ParsedAuthentication {
        challenge,
        signature,
    })
}

/// Verify the signature and consume the challenge. `admitted` is a key from
/// [`admitted_customer`]; without one the customer's legacy profile key is used.
fn finish_authentication(
    server: &RegistryServer,
    network_tag: &[u8],
    binding: &RpcBinding,
    parsed: ParsedAuthentication,
    admitted: Option<&[u8]>,
) -> Result<(), RpcRejection> {
    let ParsedAuthentication {
        challenge,
        signature,
    } = parsed;
    let digest: [u8; 32] = Sha256::digest(auth_preimage(challenge, binding, network_tag)).into();
    let valid = match admitted {
        Some(point) => server.registry.verify_admitted_monad_recipient_signature(
            binding.customer,
            Some(point),
            digest,
            &signature,
        ),
        None => {
            server
                .registry
                .verify_monad_recipient_signature(binding.customer, digest, &signature)
        }
    }
    .map_err(|_| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_auth_unavailable"))?;
    if !valid {
        return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"));
    }
    match server
        .registry
        .consume_monad_mailbox_challenge(
            challenge.epoch,
            binding.customer,
            challenge.nonce,
            challenge.expires_at_ms,
            now_ms(),
            MAX_USED_RPC_CHALLENGES_PER_CUSTOMER,
        )
        .map_err(|_| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_auth_unavailable"))?
    {
        ChallengeConsumption::Consumed => Ok(()),
        ChallengeConsumption::Rejected => {
            Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
        }
        ChallengeConsumption::AtCapacity => Err(rpc_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rpc_auth_capacity",
        )),
    }
}

/// Legacy profile-key proof. The Bitcoin-family proxy uses only this.
pub(crate) fn authenticate(
    headers: &HeaderMap,
    server: &RegistryServer,
    auth: &RpcAuthState,
    network_tag: &[u8],
    binding: &RpcBinding,
) -> Result<(), RpcRejection> {
    let parsed = parse_authentication(headers, auth, binding)?;
    finish_authentication(server, network_tag, binding, parsed, None)
}

/// EVM proxy proof: the challenge is verified first, and only then is the directory asked whether
/// the customer has a current published entry. Any other customer is checked against its legacy
/// profile key exactly as [`authenticate`] does.
async fn authenticate_customer(
    headers: &HeaderMap,
    server: &RegistryServer,
    auth: &RpcAuthState,
    network_tag: &[u8],
    expected_chain_id: u64,
    binding: &RpcBinding,
) -> Result<(), RpcRejection> {
    let parsed = parse_authentication(headers, auth, binding)?;
    let admitted = admitted_customer(
        server,
        headers,
        network_tag,
        expected_chain_id,
        binding.customer,
    )
    .await?;
    finish_authentication(server, network_tag, binding, parsed, admitted.as_deref())
}

pub(crate) async fn handle_issue_rpc_challenge(
    Path(chain_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let Some(runtime) = server
        .evm_rpc
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
    else {
        if server
            .bitcoin_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_rpc_chain(&chain_id))
        {
            return crate::http::bitcoin_proxy::issue_rpc_challenge(chain_id, headers, server, body)
                .await;
        }
        if server
            .solana_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::solana_proxy::issue_rpc_challenge(chain_id, headers, server, body)
                .await;
        }
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    };
    let chain = &runtime.chains[&chain_id];
    validate_body(runtime, chain, &body)?;
    let customer = headers
        .get(RPC_CUSTOMER_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Address::from_hex(value).ok())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
        resource: RpcResource::Rpc,
    };
    let challenge = runtime.auth.issue(&binding, now_ms());
    Ok(Json(RpcChallengeBody {
        epoch: hex::encode(challenge.epoch),
        nonce: hex::encode(challenge.nonce),
        expires_at_ms: challenge.expires_at_ms,
        token: hex::encode(challenge.token),
        signing_domain: RPC_AUTH_DOMAIN,
        customer: customer.to_hex(),
        chain: chain_id,
        body_sha256: hex::encode(binding.body_sha256),
        network_tag: hex::encode(&runtime.network_tag),
    }))
}

/// Issue a challenge for a reusable, expiring capability URL. The empty body is intentional: the
/// resulting signature authorizes only capability issuance for this customer and chain, not an
/// arbitrary RPC request.
pub(crate) async fn handle_issue_rpc_capability_challenge(
    Path(chain_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    if !body.is_empty() {
        return Err(rpc_error(
            StatusCode::BAD_REQUEST,
            "invalid_capability_request",
        ));
    }
    let Some(runtime) = server
        .evm_rpc
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
    else {
        if server
            .bitcoin_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::bitcoin_proxy::issue_capability_challenge(
                chain_id, headers, server, body,
            );
        }
        if server
            .solana_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::solana_proxy::issue_capability_challenge(
                chain_id, headers, server, body,
            );
        }
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    };
    let customer = headers
        .get(RPC_CUSTOMER_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Address::from_hex(value).ok())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
        resource: RpcResource::Capability,
    };
    let challenge = runtime.auth.issue(&binding, now_ms());
    Ok(Json(RpcChallengeBody {
        epoch: hex::encode(challenge.epoch),
        nonce: hex::encode(challenge.nonce),
        expires_at_ms: challenge.expires_at_ms,
        token: hex::encode(challenge.token),
        signing_domain: RPC_AUTH_DOMAIN,
        customer: customer.to_hex(),
        chain: chain_id,
        body_sha256: hex::encode(binding.body_sha256),
        network_tag: hex::encode(&runtime.network_tag),
    }))
}

#[derive(Serialize)]
pub(crate) struct RpcCapabilityBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rpc_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) chronik_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ws_path: Option<String>,
    pub(crate) expires_at_ms: i64,
}

/// Exchange one valid profile signature for a URL bearer capability. The bearer is deliberately
/// returned in a path segment so unmodified browser WebSocket and JSON-RPC clients can use it.
pub(crate) async fn handle_issue_rpc_capability(
    Path(chain_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Json<RpcCapabilityBody>, RpcRejection> {
    if !body.is_empty() {
        return Err(rpc_error(
            StatusCode::BAD_REQUEST,
            "invalid_capability_request",
        ));
    }
    let Some(runtime) = server
        .evm_rpc
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
    else {
        if server
            .bitcoin_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::bitcoin_proxy::issue_capability(chain_id, headers, server, body);
        }
        if server
            .solana_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::solana_proxy::issue_capability(chain_id, headers, server, body);
        }
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    };
    let customer = headers
        .get(RPC_CUSTOMER_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Address::from_hex(value).ok())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
        resource: RpcResource::Capability,
    };
    authenticate_customer(
        &headers,
        &server,
        &runtime.auth,
        &runtime.network_tag,
        runtime.chains[&chain_id].expected_chain_id,
        &binding,
    )
    .await?;
    let ttl_ms = i64::try_from(runtime.capability_ttl.as_millis()).unwrap_or(i64::MAX);
    let (token, expires_at_ms) =
        runtime
            .auth
            .issue_capability(customer, &chain_id, now_ms(), ttl_ms);
    Ok(Json(RpcCapabilityBody {
        rpc_path: Some(format!("/chain-rpc/{chain_id}/cap/{token}/rpc")),
        chronik_path: None,
        ws_path: runtime.chains[&chain_id]
            .upstream_ws_url
            .as_ref()
            .map(|_| format!("/chain-rpc/{chain_id}/cap/{token}/ws")),
        expires_at_ms,
    }))
}

/// Authenticate and forward an exact allowlisted JSON-RPC request.
pub(crate) async fn handle_proxy_rpc(
    Path(chain_id): Path<String>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Response, RpcRejection> {
    proxy_rpc_inner(chain_id, peer, headers, server, body, None).await
}

pub(crate) async fn handle_proxy_rpc_capability(
    Path((chain_id, capability)): Path<(String, String)>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Response, RpcRejection> {
    if server
        .evm_rpc
        .as_deref()
        .is_some_and(|runtime| runtime.has_chain(&chain_id))
    {
        proxy_rpc_inner(chain_id, peer, headers, server, body, Some(capability)).await
    } else if server
        .bitcoin_proxy
        .as_deref()
        .is_some_and(|runtime| runtime.has_chain(&chain_id))
    {
        crate::http::bitcoin_proxy::proxy_rpc_capability(
            chain_id, capability, headers, server, body,
        )
        .await
    } else if server
        .solana_proxy
        .as_deref()
        .is_some_and(|runtime| runtime.has_chain(&chain_id))
    {
        crate::http::solana_proxy::proxy_rpc_capability(
            chain_id, capability, headers, server, body,
        )
        .await
    } else {
        Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))
    }
}

fn validate_ws_call(
    call: &Value,
    chain: &EvmChainRuntime,
) -> Result<(CallCost, bool), RpcRejection> {
    let object = call
        .as_object()
        .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || !object.contains_key("id") {
        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
    }
    match object.get("method").and_then(Value::as_str) {
        Some("eth_subscribe") => {
            let params = object
                .get("params")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"))?;
            match params.first().and_then(Value::as_str) {
                Some("newHeads") if params.len() == 1 => Ok((
                    CallCost {
                        units: 5,
                        anonymous: false,
                        broadcast: false,
                    },
                    true,
                )),
                Some("logs") if params.len() == 2 => {
                    if !bounded_log_subscription_filter(&params[1]) {
                        return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied"));
                    }
                    Ok((
                        CallCost {
                            units: 20,
                            anonymous: false,
                            broadcast: false,
                        },
                        true,
                    ))
                }
                _ => Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied")),
            }
        }
        Some("eth_unsubscribe") => {
            let valid = object
                .get("params")
                .and_then(Value::as_array)
                .filter(|params| params.len() == 1)
                .and_then(|params| params.first())
                .and_then(Value::as_str)
                .is_some_and(|subscription| subscription.len() <= MAX_WS_SUBSCRIPTION_ID_BYTES);
            if !valid {
                return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"));
            }
            Ok((
                CallCost {
                    units: 1,
                    anonymous: false,
                    broadcast: false,
                },
                false,
            ))
        }
        Some(_) => validate_call(call, chain).map(|cost| (cost, false)),
        None => Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc")),
    }
}

fn fixed_hex(value: &Value, hex_digits: usize) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == hex_digits + 2
            && value.starts_with("0x")
            && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn bounded_log_subscription_filter(value: &Value) -> bool {
    let Some(filter) = value.as_object() else {
        return false;
    };
    if filter.is_empty()
        || filter.len() > 2
        || filter
            .keys()
            .any(|key| !matches!(key.as_str(), "address" | "topics"))
    {
        return false;
    }
    let address_restrictive = match filter.get("address") {
        None => false,
        Some(address) if fixed_hex(address, 40) => true,
        Some(Value::Array(addresses)) => {
            !addresses.is_empty()
                && addresses.len() <= 32
                && addresses.iter().all(|address| fixed_hex(address, 40))
        }
        Some(_) => return false,
    };
    let topics_restrictive = match filter.get("topics") {
        None => false,
        Some(Value::Array(topics)) if topics.len() <= 4 => {
            let mut restrictive = false;
            for topic in topics {
                match topic {
                    Value::Null => {}
                    topic if fixed_hex(topic, 64) => restrictive = true,
                    Value::Array(alternatives)
                        if !alternatives.is_empty()
                            && alternatives.len() <= 32
                            && alternatives.iter().all(|topic| fixed_hex(topic, 64)) =>
                    {
                        restrictive = true;
                    }
                    _ => return false,
                }
            }
            restrictive
        }
        Some(_) => return false,
    };
    address_restrictive || topics_restrictive
}

fn ws_error(id: Value, code: i64, message: &'static str) -> ClientWsMessage {
    ClientWsMessage::Text(
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string(),
    )
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum WsRpcId {
    String(String),
    Number(String),
    Null,
}

impl WsRpcId {
    fn from_value(value: &Value) -> Option<Self> {
        if !super::json_rpc::rpc_id_is_bounded(value) {
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

enum WsPendingKind {
    Call,
    Subscribe,
    Unsubscribe(String),
}

struct WsPending {
    id: Value,
    kind: WsPendingKind,
    deadline: tokio::time::Instant,
    _permit: OwnedSemaphorePermit,
}

fn valid_ws_response(value: &Value) -> bool {
    value.is_object()
        && super::json_rpc::is_response_envelope(value, super::json_rpc::JsonRpcVersion::V2)
}

fn ws_subscription_notification(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.get("jsonrpc")?.as_str()? != "2.0"
        || object.get("method")?.as_str()? != "eth_subscription"
        || object.len() != 3
    {
        return None;
    }
    let params = object.get("params")?.as_object()?;
    if params.len() != 2 || !params.contains_key("result") {
        return None;
    }
    params
        .get("subscription")?
        .as_str()
        .filter(|subscription| subscription.len() <= MAX_WS_SUBSCRIPTION_ID_BYTES)
}

fn ws_write_deadline(
    pending: &HashMap<WsRpcId, WsPending>,
    request_timeout: Duration,
    expiry_deadline: tokio::time::Instant,
) -> tokio::time::Instant {
    pending
        .values()
        .map(|request| request.deadline)
        .min()
        .unwrap_or_else(|| tokio::time::Instant::now() + request_timeout)
        .min(expiry_deadline)
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
    Path((chain_id, capability)): Path<(String, String)>,
    Extension(server): Extension<RegistryServer>,
    ws: WebSocketUpgrade,
) -> Result<Response, RpcRejection> {
    let runtime = server
        .evm_rpc
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let chain = runtime.chains.get(&chain_id).expect("chain checked above");
    let upstream_url = chain
        .upstream_ws_url
        .clone()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_ws_disabled"))?;
    let (customer, expires_at_ms) = runtime
        .auth
        .verify_capability(&capability, &chain_id, now_ms())
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let customer_admission = runtime.admit_ws_customer(customer)?;
    let permit = Arc::clone(&runtime.ws_permits)
        .try_acquire_owned()
        .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_busy"))?;
    let max_client_bytes = runtime.max_request_bytes;
    let max_upstream_bytes = runtime.max_response_bytes.min(MAX_WS_RESPONSE_BYTES);
    let timeout = runtime.timeout;
    let quota = runtime.customer_quota.clone();
    let request_permits = Arc::clone(&runtime.permits);
    let chain = chain.clone();
    let lifetime_ms = expires_at_ms.saturating_sub(now_ms()).max(1) as u64;
    let expiry_deadline = tokio::time::Instant::now() + Duration::from_millis(lifetime_ms);
    Ok(ws
        .max_message_size(max_client_bytes)
        .max_frame_size(max_client_bytes)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let _customer_admission = customer_admission;
            let config = WebSocketConfig {
                max_send_queue: Some(32),
                max_message_size: Some(max_upstream_bytes),
                max_frame_size: Some(max_upstream_bytes),
                accept_unmasked_frames: false,
            };
            let connect_deadline = expiry_deadline.min(tokio::time::Instant::now() + timeout);
            let connected = tokio::time::timeout_at(
                connect_deadline,
                connect_async_with_config(upstream_url.as_str(), Some(config)),
            )
            .await;
            let Ok(Ok((mut upstream, _response))) = connected else {
                return;
            };
            if verify_ws_socket(&mut upstream, &chain, connect_deadline)
                .await
                .is_err()
            {
                return;
            }
            proxy_ws_connection(
                socket,
                upstream,
                chain,
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

async fn proxy_ws_connection<S>(
    socket: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<S>,
    chain: EvmChainRuntime,
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
    let mut subscription_attempts = 0usize;
    let mut active_subscriptions = HashSet::new();
    let mut pending = HashMap::<WsRpcId, WsPending>::new();
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
                    ws_error(id, -32002, "upstream request timed out"),
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
                // The outer biased select keeps expiry and request deadlines authoritative. This
                // inner select is deliberately fair: a client that continuously has buffered
                // frames must not starve ready upstream responses (or vice versa).
                tokio::select! {
                    client = client_read.next() => WsEvent::Client(client),
                    upstream = upstream_read.next() => WsEvent::Upstream(upstream),
                }
            } => match event {
            WsEvent::Client(client) => {
                let Some(Ok(client)) = client else { break; };
                match client {
                    ClientWsMessage::Text(text) => {
                        let parsed = super::json_rpc::parse_without_duplicate_keys(text.as_bytes());
                        let id = parsed.as_ref().ok().and_then(|value| value.get("id")).cloned().unwrap_or(Value::Null);
                        let Ok(value) = parsed else {
                            if !bounded_ws_send(&mut client_write, ws_error(id, -32600, "invalid request"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                            continue;
                        };
                        let Some(id_key) = WsRpcId::from_value(&id) else {
                            if !bounded_ws_send(&mut client_write, ws_error(Value::Null, -32600, "invalid request id"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                            continue;
                        };
                        if pending.len() >= MAX_WS_PENDING_REQUESTS || pending.contains_key(&id_key) {
                            if !bounded_ws_send(&mut client_write, ws_error(id, -32005, "pending request limit exceeded"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                            continue;
                        }
                        let Ok((cost, subscribes)) = validate_ws_call(&value, &chain) else {
                            if !bounded_ws_send(&mut client_write, ws_error(id, -32601, "method denied by relay"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                            continue;
                        };
                        if subscribes {
                            subscription_attempts = subscription_attempts.saturating_add(1);
                            if subscription_attempts > MAX_WS_SUBSCRIPTIONS {
                                if !bounded_ws_send(&mut client_write, ws_error(id, -32005, "subscription limit exceeded"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                                continue;
                            }
                        }
                        let request_permit = match Arc::clone(&request_permits).try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                if !bounded_ws_send(&mut client_write, ws_error(id, -32005, "relay busy"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                                continue;
                            }
                        };
                        if quota.charge(customer, cost.units, now_seconds()).is_err() {
                            if !bounded_ws_send(&mut client_write, ws_error(id, -32005, "hourly quota exceeded"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                            continue;
                        }
                        let method = value.get("method").and_then(Value::as_str);
                        let kind = if subscribes {
                            WsPendingKind::Subscribe
                        } else if method == Some("eth_unsubscribe") {
                            let subscription = value
                                .get("params")
                                .and_then(Value::as_array)
                                .and_then(|params| params.first())
                                .and_then(Value::as_str)
                                .expect("validated unsubscribe")
                                .to_string();
                            WsPendingKind::Unsubscribe(subscription)
                        } else {
                            WsPendingKind::Call
                        };
                        pending.insert(id_key.clone(), WsPending {
                            id: id.clone(),
                            kind,
                            deadline: tokio::time::Instant::now() + request_timeout,
                            _permit: request_permit,
                        });
                        if !bounded_ws_send(&mut upstream_write, UpstreamWsMessage::Text(text), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await {
                            pending.remove(&id_key);
                            break;
                        }
                    }
                    ClientWsMessage::Ping(payload) => {
                        if !bounded_ws_send(&mut client_write, ClientWsMessage::Pong(payload), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { break; }
                    }
                    ClientWsMessage::Close(_) => break,
                    ClientWsMessage::Binary(_) => {
                        if !bounded_ws_send(&mut client_write, ws_error(Value::Null, -32600, "binary requests are not supported"), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { return; }
                    }
                    ClientWsMessage::Pong(_) => {}
                }
            }
            WsEvent::Upstream(upstream) => {
                let Some(Ok(upstream)) = upstream else { break; };
                match upstream {
                    UpstreamWsMessage::Text(text) => {
                        let Ok(mut value) = super::json_rpc::parse_without_duplicate_keys(text.as_bytes()) else { break; };
                        let mut delivery_deadline = ws_write_deadline(&pending, request_timeout, expiry_deadline);
                        if let Some(id) = value.get("id").cloned() {
                            if !valid_ws_response(&value) {
                                break;
                            }
                            let Some(id_key) = WsRpcId::from_value(&id) else { break; };
                            let Some(request) = pending.remove(&id_key) else { break; };
                            delivery_deadline = delivery_deadline.min(request.deadline);
                            if request.deadline <= tokio::time::Instant::now() {
                                pending.clear();
                                let _ = bounded_ws_send(
                                    &mut client_write,
                                    ws_error(request.id, -32002, "upstream request timed out"),
                                    delivery_deadline,
                                ).await;
                                return;
                            }
                            if value.get("error").is_none() {
                                match request.kind {
                                    WsPendingKind::Subscribe => {
                                        let Some(subscription) = value.get("result").and_then(Value::as_str) else { break; };
                                        if subscription.len() > MAX_WS_SUBSCRIPTION_ID_BYTES {
                                            break;
                                        }
                                        active_subscriptions.insert(subscription.to_string());
                                    }
                                    WsPendingKind::Unsubscribe(subscription) => {
                                        if value.get("result").and_then(Value::as_bool) == Some(true) {
                                            active_subscriptions.remove(&subscription);
                                        }
                                    }
                                    WsPendingKind::Call => {}
                                }
                            }
                        } else {
                            let Some(subscription) = ws_subscription_notification(&value) else { break; };
                            if !active_subscriptions.contains(subscription) {
                                break;
                            }
                            if quota.charge(customer, 1, now_seconds()).is_err() {
                                let _ = bounded_ws_send(
                                    &mut client_write,
                                    ClientWsMessage::Close(None),
                                    ws_write_deadline(&pending, request_timeout, expiry_deadline),
                                ).await;
                                break;
                            }
                        }
                        super::json_rpc::sanitize_response_errors(&mut value);
                        if !bounded_ws_send(&mut client_write, ClientWsMessage::Text(value.to_string()), delivery_deadline).await { break; }
                    }
                    UpstreamWsMessage::Ping(payload) => {
                        if !bounded_ws_send(&mut upstream_write, UpstreamWsMessage::Pong(payload), ws_write_deadline(&pending, request_timeout, expiry_deadline)).await { break; }
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
    if tokio::time::Instant::now() >= expiry_deadline {
        return;
    }
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

async fn proxy_rpc_inner(
    chain_id: String,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
    capability: Option<String>,
) -> Result<Response, RpcRejection> {
    let Some(runtime) = server
        .evm_rpc
        .as_deref()
        .filter(|runtime| runtime.has_chain(&chain_id))
    else {
        if server
            .bitcoin_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_rpc_chain(&chain_id))
        {
            return crate::http::bitcoin_proxy::proxy_rpc(chain_id, peer, headers, server, body).await;
        }
        if server
            .solana_proxy
            .as_deref()
            .is_some_and(|runtime| runtime.has_chain(&chain_id))
        {
            return crate::http::solana_proxy::proxy_rpc(chain_id, peer, headers, server, body).await;
        }
        return Err(rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"));
    };
    let chain = &runtime.chains[&chain_id];
    let cost = validate_body(runtime, chain, &body)?;
    let correlation = super::json_rpc::request_correlation(&body).map_err(|_| {
        preflight_broadcast_error(
            rpc_error(StatusCode::BAD_REQUEST, "invalid_json_rpc"),
            cost.broadcast,
        )
    })?;
    let customer = if let Some(capability) = capability.as_deref() {
        Some(
            runtime
                .auth
                .verify_capability(capability, &chain_id, now_ms())
                .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
                .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?
                .0,
        )
    } else {
        headers
            .get(RPC_CUSTOMER_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(Address::from_hex)
            .transpose()
            .map_err(|_| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))
            .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?
    };
    let permit = Arc::clone(&runtime.permits)
        .try_acquire_owned()
        .map_err(|_| {
            broadcast_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "rpc_busy",
                cost.broadcast,
                false,
            )
        })?;
    if let Some(customer) = customer {
        if capability.is_none() {
            let binding = RpcBinding {
                customer,
                chain: chain_id.clone(),
                body_sha256: body_hash(&body),
                resource: RpcResource::Rpc,
            };
            authenticate_customer(
                &headers,
                &server,
                &runtime.auth,
                &runtime.network_tag,
                chain.expected_chain_id,
                &binding,
            )
            .await
            .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?;
        }
        runtime
            .customer_quota
            .charge(customer, cost.units, now_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", cost.broadcast, denial))?;
    } else {
        if !cost.anonymous {
            return Err(preflight_broadcast_error(
                rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"),
                cost.broadcast,
            ));
        }
        let peer = peer
            .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_source_required"))
            .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?;
        runtime
            .anonymous_quota
            .charge(quota_ip(peer.0), cost.units, now_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", cost.broadcast, denial))?;
    }
    let deadline = tokio::time::Instant::now() + runtime.timeout;
    let upstream = async {
        let response = runtime
            .client
            .post(chain.upstream_url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.clone())
            .send()
            .await
            .map_err(|_| {
                broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    cost.broadcast,
                    true,
                )
            })?;
        super::json_rpc::spool_response(response, runtime.max_response_bytes, runtime.timeout)
            .await
            .map_err(|error| match error {
                super::json_rpc::SpoolError::TooLarge => broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_response_too_large",
                    cost.broadcast,
                    true,
                ),
                super::json_rpc::SpoolError::Timeout => broadcast_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "rpc_upstream_timeout",
                    cost.broadcast,
                    true,
                ),
                super::json_rpc::SpoolError::Io => broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    cost.broadcast,
                    true,
                ),
            })
    };
    let spool = tokio::time::timeout_at(deadline, upstream)
        .await
        .map_err(|_| {
            broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                cost.broadcast,
                true,
            )
        })??;
    let inspected = tokio::time::timeout_at(
        deadline,
        spool.inspect(super::json_rpc::JsonRpcVersion::V2, correlation),
    )
    .await
    .map_err(|_| {
        broadcast_error(
            StatusCode::GATEWAY_TIMEOUT,
            "rpc_upstream_timeout",
            cost.broadcast,
            true,
        )
    })?
    .map_err(|_| {
        broadcast_error(
            StatusCode::BAD_GATEWAY,
            "invalid_rpc_upstream_response",
            cost.broadcast,
            true,
        )
    })?;
    let response_body = spool
        .into_body(inspected.error_rewrites)
        .await
        .map_err(|_| {
            broadcast_error(
                StatusCode::BAD_GATEWAY,
                "rpc_upstream_unavailable",
                cost.broadcast,
                true,
            )
        })?;
    let mut response = Response::new(boxed(response_body));
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

/// CORS request headers used by the RPC signature protocol.
pub const RPC_CORS_HEADERS: [&str; 6] = [
    RPC_CUSTOMER_HEADER,
    RPC_EPOCH_HEADER,
    RPC_NONCE_HEADER,
    RPC_EXPIRY_HEADER,
    RPC_TOKEN_HEADER,
    RPC_SIGNATURE_HEADER,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::atomic::{AtomicUsize, Ordering},
    };

    const TEST_CHECKPOINT_HASH: &str =
        "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9";

    fn checkpoint_response(request: &Value) -> Option<Value> {
        (request["method"] == "eth_getBlockByNumber").then(|| {
            json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": { "hash": TEST_CHECKPOINT_HASH }
            })
        })
    }

    use axum::{body::Body, http::Request, routing, Router};
    use bitcoinsuite_core::{ecc::Ecc, Hashed, Net, Sha256 as BitcoinSha256};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};
    use prost::Message;
    use tempdir::TempDir;
    use tower::ServiceExt;

    use crate::{
        http::{pop_protection::PopGate, server::RegistryServer},
        p2p::peers::Peers,
        proto,
        registry::Registry,
        store::db::Db,
        test_instance::placeholder_pop_conf,
    };

    fn chain() -> EvmChainRuntime {
        EvmChainRuntime {
            id: "monad-testnet".to_string(),
            expected_chain_id: 10_143,
            upstream_url: "http://127.0.0.1:1/provider-secret".parse().unwrap(),
            upstream_ws_url: None,
            checkpoint: None,
            max_get_logs_range: 10,
        }
    }

    fn runtime() -> EvmRpcRuntime {
        let chain = chain();
        EvmRpcRuntime {
            chains: HashMap::from([(chain.id.clone(), chain)]),
            client: reqwest::Client::new(),
            auth: RpcAuthState::new(),
            network_tag: b"MONT".to_vec(),
            permits: Arc::new(Semaphore::new(1)),
            ingress_permits: Arc::new(Semaphore::new(1)),
            max_request_bytes: MAX_RPC_REQUEST_BYTES,
            max_batch_len: 2,
            max_response_bytes: 1024,
            timeout: Duration::from_secs(1),
            customer_quota: Arc::new(FixedHourQuota::new(10_000)),
            anonymous_quota: FixedHourQuota::new(500),
            capability_ttl: Duration::from_secs(60 * 60),
            ws_permits: Arc::new(Semaphore::new(1)),
            ws_customers: Arc::new(Mutex::new(HashMap::new())),
            ws_per_customer_limit: 1,
        }
    }

    #[test]
    fn websocket_admission_is_fair_per_customer_and_releases_on_drop() {
        let runtime = runtime();
        let customer = customer_address();
        let other = Address([0x22; 20]);

        let admission = runtime.admit_ws_customer(customer).unwrap();
        assert!(runtime.admit_ws_customer(customer).is_err());
        let other_admission = runtime.admit_ws_customer(other).unwrap();
        drop(admission);
        assert!(runtime.admit_ws_customer(customer).is_ok());
        drop(other_admission);
    }

    #[test]
    fn allowlist_rejects_dangerous_and_unbounded_calls() {
        let runtime = runtime();
        let chain = runtime.chains.get("monad-testnet").unwrap();
        let denied = [
            json!({"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":[]}),
            json!({"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",true]}),
            json!({"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0xb"}]}),
        ];
        for request in denied {
            assert!(validate_call(&request, chain).is_err(), "{request}");
        }
        validate_call(
            &json!({"jsonrpc":"2.0","id":"same","method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0xa"}]}),
            chain,
        )
        .unwrap();
    }

    #[test]
    fn challenge_is_bound_to_customer_chain_and_exact_body() {
        let runtime = runtime();
        let base = RpcBinding {
            customer: Address([1; 20]),
            chain: "monad-testnet".to_string(),
            body_sha256: body_hash(br#"{"jsonrpc":"2.0"}"#),
            resource: RpcResource::Rpc,
        };
        let challenge = runtime.auth.issue(&base, 100);
        assert!(runtime.auth.verify(&base, challenge, 101));
        let mut changed = base.clone();
        changed.body_sha256[0] ^= 1;
        assert!(!runtime.auth.verify(&changed, challenge, 101));
        changed = base.clone();
        changed.customer = Address([2; 20]);
        assert!(!runtime.auth.verify(&changed, challenge, 101));
    }

    #[test]
    fn capability_is_chain_bound_tamper_evident_and_expiring() {
        let auth = RpcAuthState::new();
        let customer = Address([4; 20]);
        let issued_at = 1_000_000;
        let (token, expires_at) =
            auth.issue_capability(customer, "monad-testnet", issued_at, 60_000);

        assert_eq!(expires_at, issued_at + 60_000);
        assert_eq!(
            auth.verify_capability(&token, "monad-testnet", issued_at),
            Some((customer, expires_at))
        );
        assert_eq!(
            auth.verify_capability(&token, "monad-mainnet", issued_at),
            None
        );
        assert_eq!(
            auth.verify_capability(&token, "monad-testnet", expires_at + 1),
            None
        );

        let mut tampered = token.into_bytes();
        tampered[10] = if tampered[10] == b'0' { b'1' } else { b'0' };
        assert_eq!(
            auth.verify_capability(
                std::str::from_utf8(&tampered).unwrap(),
                "monad-testnet",
                issued_at
            ),
            None
        );
    }

    #[test]
    fn rpc_challenge_cannot_authorize_capability_issuance() {
        let auth = RpcAuthState::new();
        let rpc = RpcBinding {
            customer: Address([1; 20]),
            chain: "monad-testnet".to_string(),
            body_sha256: body_hash(b""),
            resource: RpcResource::Rpc,
        };
        let capability = RpcBinding {
            resource: RpcResource::Capability,
            ..rpc.clone()
        };
        let challenge = auth.issue(&rpc, 1_000);
        assert!(auth.verify(&rpc, challenge, 1_001));
        assert!(!auth.verify(&capability, challenge, 1_001));
    }

    #[test]
    fn request_batch_and_concurrency_limits_fail_closed() {
        let mut runtime = runtime();
        runtime.max_request_bytes = 64;
        let chain = runtime.chains.get("monad-testnet").unwrap();
        assert!(validate_body(&runtime, chain, &[b'x'; 65]).is_err());
        runtime.max_request_bytes = 1024;
        let chain = runtime.chains.get("monad-testnet").unwrap();
        let notification = br#"{"jsonrpc":"2.0","method":"eth_chainId","params":[]}"#;
        assert!(validate_body(&runtime, chain, notification).is_err());
        let too_many = serde_json::to_vec(&vec![
            json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]});
            3
        ])
        .unwrap();
        assert!(validate_body(&runtime, chain, &too_many).is_err());
        let duplicate_ids = br#"[
            {"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
            {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
        ]"#;
        assert!(validate_body(&runtime, chain, duplicate_ids).is_err());
        let first = Arc::clone(&runtime.permits).try_acquire_owned().unwrap();
        assert!(Arc::clone(&runtime.permits).try_acquire_owned().is_err());
        drop(first);
        assert!(Arc::clone(&runtime.permits).try_acquire_owned().is_ok());
    }

    #[test]
    fn request_rejects_duplicate_rpc_members() {
        let runtime = runtime();
        let chain = runtime.chains.get("monad-testnet").unwrap();
        let ambiguous = br#"{"jsonrpc":"2.0","id":1,"method":"personal_sign","method":"eth_chainId","params":[]}"#;
        assert!(validate_body(&runtime, chain, ambiguous).is_err());
    }

    #[test]
    fn websocket_policy_allows_bounded_subscriptions_only() {
        let chain = chain();
        let new_heads = json!({
            "jsonrpc":"2.0", "id":1, "method":"eth_subscribe", "params":["newHeads"]
        });
        let logs = json!({
            "jsonrpc":"2.0", "id":2, "method":"eth_subscribe",
            "params":["logs", {"address": [format!("0x{}", "11".repeat(20))], "topics": []}]
        });
        let topic_logs = json!({
            "jsonrpc":"2.0", "id":3, "method":"eth_subscribe",
            "params":["logs", {"topics": [null, format!("0x{}", "22".repeat(32))]}]
        });
        assert!(validate_ws_call(&new_heads, &chain).unwrap().1);
        assert!(validate_ws_call(&logs, &chain).unwrap().1);
        assert!(validate_ws_call(&topic_logs, &chain).unwrap().1);

        for denied in [
            json!({"jsonrpc":"2.0", "id":4, "method":"eth_subscribe", "params":["newPendingTransactions"]}),
            json!({"jsonrpc":"2.0", "id":5, "method":"eth_subscribe", "params":["logs"]}),
            json!({"jsonrpc":"2.0", "id":6, "method":"eth_subscribe", "params":["logs", {}]}),
            json!({"jsonrpc":"2.0", "id":7, "method":"eth_subscribe", "params":["logs", {"topics": []}]}),
            json!({"jsonrpc":"2.0", "id":8, "method":"eth_subscribe", "params":["logs", {"topics": [null, null]}]}),
            json!({"jsonrpc":"2.0", "id":9, "method":"eth_subscribe", "params":["logs", {"address": []}]}),
            json!({"jsonrpc":"2.0", "id":10, "method":"eth_subscribe", "params":["logs", {"address": "0x12"}]}),
            json!({"jsonrpc":"2.0", "id":11, "method":"eth_subscribe", "params":["logs", {"fromBlock":"0x1"}]}),
            json!({"jsonrpc":"2.0", "id":12, "method":"debug_subscribe", "params":[]}),
        ] {
            assert!(validate_ws_call(&denied, &chain).is_err(), "{denied}");
        }

        assert!(valid_ws_response(
            &json!({"jsonrpc":"2.0","id":1,"result":"0x1"})
        ));
        assert!(!valid_ws_response(
            &json!({"jsonrpc":"2.0","id":1,"result":"0x1","error":null})
        ));
        for malformed in [
            json!({"jsonrpc":"2.0","id":1,"error":null}),
            json!({"jsonrpc":"2.0","id":1,"error":"no"}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-1}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"message":"no"}}),
        ] {
            assert!(!valid_ws_response(&malformed), "{malformed}");
        }
        assert_eq!(
            ws_subscription_notification(&json!({
                "jsonrpc":"2.0",
                "method":"eth_subscription",
                "params":{"subscription":"sub-1","result":{"number":"0x1"}}
            })),
            Some("sub-1")
        );
        assert!(ws_subscription_notification(&json!({
            "jsonrpc":"2.0",
            "method":"other",
            "params":{"subscription":"sub-1","result":{}}
        }))
        .is_none());
    }

    #[test]
    fn debug_output_never_contains_provider_url() {
        let runtime = runtime();
        let rendered = format!("{runtime:?}");
        assert!(!rendered.contains("provider-secret"));
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn upstream_errors_keep_codes_but_scrub_provider_secrets() {
        let mut response = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "error": {
                "code": -32000,
                "message": "provider http://127.0.0.1:1/provider-secret rejected provider-secret"
            }
        });
        crate::http::json_rpc::sanitize_response_errors(&mut response);
        assert_eq!(response["id"], 7);
        assert_eq!(response["error"]["code"], -32000);
        let rendered = response.to_string();
        assert!(!rendered.contains("provider-secret"));
        assert!(!rendered.contains("http://127.0.0.1:1"));
        assert!(rendered.contains("upstream RPC error"));
    }

    #[derive(Debug)]
    struct UnusedChainAdapter;

    #[async_trait::async_trait]
    impl ChainAdapter for UnusedChainAdapter {
        async fn submit_tx(&self, _raw_tx: &[u8]) -> bitcoinsuite_error::Result<SubmitTxOutcome> {
            unimplemented!("not used by the EVM proxy")
        }

        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            unimplemented!("not used by the EVM proxy")
        }

        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<MempoolAcceptResult> {
            unimplemented!("not used by the EVM proxy")
        }

        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            unimplemented!("not used by the EVM proxy")
        }

        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<BitcoinSha256> {
            unimplemented!("not used by the EVM proxy")
        }
    }

    fn customer_secret() -> bitcoinsuite_core::ecc::SecKey {
        EccSecp256k1::default()
            .seckey_from_array([0x63; 32])
            .unwrap()
    }

    fn customer_address() -> Address {
        let ecc = EccSecp256k1::default();
        let pubkey = ecc.derive_pubkey(&customer_secret());
        crate::monad_evm_tx::address_from_uncompressed_pubkey(
            &ecc.serialize_pubkey_uncompressed(&pubkey),
        )
    }

    fn registered_server(runtime: Arc<EvmRpcRuntime>) -> (TempDir, RegistryServer) {
        let tempdir = TempDir::new("cashweb-registry--evm-rpc").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(UnusedChainAdapter), Net::Regtest);
        register_legacy_profile(&registry);
        let pop_gate = PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        (
            tempdir,
            RegistryServer {
                registry: Arc::new(registry),
                peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
                pop_gate: Arc::new(pop_gate),
                curated_defaults: Arc::new(vec![]),
                monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
                evm_rpc: Some(runtime),
                bitcoin_proxy: None,
                solana_proxy: None,
            },
        )
    }

    /// Stores the legacy Monad profile whose key `customer_secret` signs for.
    fn register_legacy_profile(registry: &Registry) {
        let ecc = EccSecp256k1::default();
        let secret = customer_secret();
        let pubkey = ecc.derive_pubkey(&secret);
        let payload = proto::MonadProfile {
            timestamp: 1,
            ttl: 1_000_000,
            entries: vec![],
        }
        .encode_to_vec();
        let hash = BitcoinSha256::digest(payload.clone().into());
        registry
            .put_monad_profile(
                customer_address(),
                cashweb_payload::proto::SignedPayload {
                    pubkey: pubkey.as_slice().to_vec(),
                    sig: ecc.sign(&secret, hash.byte_array().clone()).to_vec(),
                    sig_scheme: cashweb_payload::proto::signed_payload::SignatureScheme::Ecdsa
                        .into(),
                    payload,
                    payload_hash: hash.as_slice().to_vec(),
                    burn_amount: 0,
                    burn_txs: vec![],
                },
            )
            .unwrap();
    }

    fn signed_headers(challenge: &Value, customer: Address, resource: &str) -> HeaderMap {
        let mut preimage = Vec::new();
        preimage.extend_from_slice(challenge["signing_domain"].as_str().unwrap().as_bytes());
        preimage.push(0);
        preimage.extend_from_slice(&hex::decode(challenge["epoch"].as_str().unwrap()).unwrap());
        preimage.extend_from_slice(&hex::decode(challenge["nonce"].as_str().unwrap()).unwrap());
        preimage.extend_from_slice(&challenge["expires_at_ms"].as_i64().unwrap().to_be_bytes());
        preimage.extend_from_slice(&hex::decode(challenge["token"].as_str().unwrap()).unwrap());
        preimage.extend_from_slice(b"POST\0/chain-rpc/");
        let chain = challenge["chain"].as_str().unwrap();
        preimage.extend_from_slice(&(chain.len() as u32).to_be_bytes());
        preimage.extend_from_slice(chain.as_bytes());
        preimage.extend_from_slice(b"\0");
        preimage.extend_from_slice(resource.as_bytes());
        preimage.extend_from_slice(&customer.0);
        preimage
            .extend_from_slice(&hex::decode(challenge["body_sha256"].as_str().unwrap()).unwrap());
        let network_tag = hex::decode(challenge["network_tag"].as_str().unwrap()).unwrap();
        preimage.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
        preimage.extend_from_slice(&network_tag);
        let digest = BitcoinSha256::digest(preimage.into());
        let signature =
            EccSecp256k1::default().sign(&customer_secret(), digest.byte_array().clone());
        let mut headers = HeaderMap::new();
        headers.insert(RPC_CUSTOMER_HEADER, customer.to_hex().parse().unwrap());
        for (name, field) in [
            (RPC_EPOCH_HEADER, "epoch"),
            (RPC_NONCE_HEADER, "nonce"),
            (RPC_TOKEN_HEADER, "token"),
        ] {
            headers.insert(name, challenge[field].as_str().unwrap().parse().unwrap());
        }
        headers.insert(
            RPC_EXPIRY_HEADER,
            challenge["expires_at_ms"]
                .as_i64()
                .unwrap()
                .to_string()
                .parse()
                .unwrap(),
        );
        headers.insert(
            RPC_SIGNATURE_HEADER,
            hex::encode(signature).parse().unwrap(),
        );
        headers
    }

    async fn response_json(response: Response) -> Value {
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn public_discovery_reports_configured_family_capabilities_and_relays() {
        let (_tempdir, server) = registered_server(Arc::new(runtime()));
        let router = server.into_router();

        let response = router
            .clone()
            .oneshot(Request::get("/chains").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({
                "schema_version": 1,
                "chains": [{
                    "id": "monad-testnet",
                    "family": "evm",
                    "network": "testnet",
                    "caip2": "eip155:10143",
                    "native_chain_id": "10143",
                    "capabilities": ["json-rpc"]
                }]
            })
        );

        let response = router
            .oneshot(Request::get("/peers").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({"relays": ["http://127.0.0.1:1"]})
        );
    }

    #[tokio::test]
    async fn body_admission_and_deadline_apply_before_challenge_processing() {
        let mut runtime = runtime();
        runtime.timeout = Duration::from_millis(20);
        let ingress = Arc::clone(&runtime.ingress_permits);
        let (_tempdir, server) = registered_server(Arc::new(runtime));
        let router = server.into_router();

        let held = Arc::clone(&ingress).try_acquire_owned().unwrap();
        let response = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc/auth")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response_json(response).await["error"], "rpc_ingress_busy");
        drop(held);

        let stalled =
            Body::wrap_stream(futures::stream::pending::<Result<Bytes, std::io::Error>>());
        let response = router
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc/auth")
                    .body(stalled)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(response_json(response).await["error"], "rpc_body_timeout");
    }

    #[tokio::test]
    async fn broadcast_failures_distinguish_preflight_rejection_from_unknown_delivery() {
        let not_attempted = broadcast_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rpc_hourly_quota",
            true,
            false,
        )
        .into_response();
        assert_eq!(
            response_json(not_attempted).await,
            json!({
                "error": "rpc_hourly_quota",
                "broadcast_state": "not-attempted"
            })
        );

        let exhausted = quota_error(
            "rpc_hourly_quota",
            true,
            QuotaDenial::Exhausted {
                reset_unix_seconds: now_seconds() + 120,
            },
        )
        .into_response();
        assert_eq!(exhausted.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(exhausted
            .headers()
            .contains_key(axum::http::header::RETRY_AFTER));
        let body = response_json(exhausted).await;
        assert_eq!(body["error"], "rpc_hourly_quota");
        assert!(body["reset_at_unix_seconds"].as_u64().is_some());

        let unknown = broadcast_error(
            StatusCode::GATEWAY_TIMEOUT,
            "rpc_upstream_timeout",
            true,
            true,
        )
        .into_response();
        assert_eq!(
            response_json(unknown).await,
            json!({
                "error": "rpc_upstream_timeout",
                "broadcast_state": "unknown"
            })
        );
    }

    async fn request_with_proof(
        router: &Router,
        body: &'static [u8],
        customer: Address,
    ) -> Request<Body> {
        let challenge = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc/auth")
                    .header("content-type", "application/json")
                    .header(RPC_CUSTOMER_HEADER, customer.to_hex())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(challenge.status(), StatusCode::OK);
        let challenge = response_json(challenge).await;
        let mut request = Request::post("/chain-rpc/monad-testnet/rpc")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        *request.headers_mut() = signed_headers(&challenge, customer, "rpc");
        request
    }

    #[tokio::test]
    async fn router_boundary_requires_registered_single_use_customer_proof() {
        let upstream_calls = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&upstream_calls);
        let upstream = Router::new().route(
            "/provider-secret",
            routing::post(move |body: Bytes| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    if let Some(response) = checkpoint_response(&request) {
                        Json(response)
                    } else if request["method"] == "eth_chainId" {
                        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":"0x279f"}))
                    } else {
                        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":"0x2a"}))
                    }
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
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 1024,
            max_concurrency: 1,
            timeout_ms: 1_000,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
            capability_ttl_ms: 60 * 60 * 1000,
        };
        let upstream_url = format!("http://{address}/provider-secret");
        let runtime = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |name| {
            (name == "TEST_UPSTREAM").then(|| upstream_url.clone())
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);
        let (_tempdir, server) = registered_server(runtime);
        let router = server.into_router();
        let body = br#"{"jsonrpc":"2.0","id":"client-id","method":"eth_blockNumber","params":[]}"#;

        let preflight = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/chain-rpc/monad-testnet/rpc")
                    .header("origin", "https://app.example")
                    .header("access-control-request-method", "POST")
                    .header("access-control-request-headers", RPC_CORS_HEADERS.join(","))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::OK);
        let allowed_headers = preflight
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        for name in RPC_CORS_HEADERS {
            assert!(allowed_headers.contains(name), "missing {name}");
        }
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);

        let unauthorized = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc")
                    .header("content-type", "application/json")
                    .body(Body::from(body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);

        let unregistered = Address([0x44; 20]);
        let unregistered_challenge = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc/auth")
                    .header("content-type", "application/json")
                    .header(RPC_CUSTOMER_HEADER, unregistered.to_hex())
                    .body(Body::from(body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let unregistered_challenge = response_json(unregistered_challenge).await;
        let unregistered_headers = signed_headers(&unregistered_challenge, unregistered, "rpc");
        let mut unregistered_request = Request::post("/chain-rpc/monad-testnet/rpc")
            .body(Body::from(body.as_slice()))
            .unwrap();
        *unregistered_request.headers_mut() = unregistered_headers;
        let unregistered_response = router.clone().oneshot(unregistered_request).await.unwrap();
        assert_eq!(unregistered_response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);

        let challenge_response = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/rpc/auth")
                    .header("content-type", "application/json")
                    .header(RPC_CUSTOMER_HEADER, customer_address().to_hex())
                    .body(Body::from(body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(challenge_response.status(), StatusCode::OK);
        let challenge = response_json(challenge_response).await;
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);
        let headers = signed_headers(&challenge, customer_address(), "rpc");

        let request = || {
            let mut request = Request::post("/chain-rpc/monad-testnet/rpc")
                .header("content-type", "application/json")
                .body(Body::from(body.as_slice()))
                .unwrap();
            *request.headers_mut() = headers.clone();
            request
        };
        let authorized = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);
        assert_eq!(
            response_json(authorized).await,
            json!({"jsonrpc":"2.0","id":"client-id","result":"0x2a"})
        );
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 3);

        let replay = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 3);

        let capability_challenge = router
            .clone()
            .oneshot(
                Request::post("/chain-rpc/monad-testnet/capability/auth")
                    .header(RPC_CUSTOMER_HEADER, customer_address().to_hex())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capability_challenge.status(), StatusCode::OK);
        let capability_challenge = response_json(capability_challenge).await;
        let capability_headers =
            signed_headers(&capability_challenge, customer_address(), "capability");
        let mut issuance = Request::post("/chain-rpc/monad-testnet/capability")
            .body(Body::empty())
            .unwrap();
        *issuance.headers_mut() = capability_headers;
        let issued = router.clone().oneshot(issuance).await.unwrap();
        assert_eq!(issued.status(), StatusCode::OK);
        let rpc_path = response_json(issued).await["rpc_path"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(rpc_path.starts_with("/chain-rpc/monad-testnet/cap/"));

        for expected_calls in [4, 5] {
            let capability_request = Request::post(&rpc_path)
                .header("content-type", "application/json")
                .body(Body::from(body.as_slice()))
                .unwrap();
            let response = router.clone().oneshot(capability_request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(upstream_calls.load(Ordering::SeqCst), expected_calls);
        }

        let mut bad_path = rpc_path.into_bytes();
        let token_byte = bad_path.len() - "/rpc".len() - 1;
        bad_path[token_byte] = if bad_path[token_byte] == b'0' {
            b'1'
        } else {
            b'0'
        };
        let bad_path = String::from_utf8(bad_path).unwrap();
        let rejected = router
            .clone()
            .oneshot(
                Request::post(&bad_path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.as_slice()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 5);

        let mut tampered = Request::post("/chain-rpc/monad-testnet/rpc")
            .body(Body::from(
                br#"{"jsonrpc":"2.0","id":"changed","method":"eth_blockNumber","params":[]}"#
                    .as_slice(),
            ))
            .unwrap();
        *tampered.headers_mut() = headers;
        let tampered = router.oneshot(tampered).await.unwrap();
        assert_eq!(tampered.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn websocket_proxy_uses_capability_policy_and_customer_quota() {
        let ws_calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&ws_calls);
        let upstream = Router::new().route(
            "/provider-secret",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                Json(checkpoint_response(&request).unwrap_or_else(
                    || json!({"jsonrpc":"2.0","id":request["id"],"result":"0x279f"}),
                ))
            })
            .get(move |ws: WebSocketUpgrade| {
                let counted = Arc::clone(&counted);
                async move {
                    ws.on_upgrade(move |mut socket| async move {
                        while let Some(Ok(ClientWsMessage::Text(text))) = socket.next().await {
                            counted.fetch_add(1, Ordering::SeqCst);
                            let request: Value = serde_json::from_str(&text).unwrap();
                            if request["method"] == "eth_getBalance"
                                && request["params"].get(0) == Some(&json!("hold"))
                            {
                                continue;
                            }
                            let response_id = if request["method"] == "eth_blockNumber" {
                                json!(999)
                            } else {
                                request["id"].clone()
                            };
                            let response = checkpoint_response(&request).unwrap_or_else(|| {
                                json!({
                                    "jsonrpc":"2.0",
                                    "id":response_id,
                                    "result":"0x279f"
                                })
                            });
                            if socket.send(ClientWsMessage::Pong(vec![1])).await.is_err() {
                                break;
                            }
                            if socket
                                .send(ClientWsMessage::Text(response.to_string()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    })
                }
            }),
        );
        let upstream_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        upstream_listener.set_nonblocking(true).unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(upstream_listener)
                .unwrap()
                .serve(upstream.into_make_service()),
        );
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: Some("TEST_WS_UPSTREAM".to_string()),
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            max_concurrency: 256,
            timeout_ms: 100,
            ..EvmRpcConf::default()
        };
        let http_url = format!("http://{upstream_address}/provider-secret");
        let ws_url = format!("ws://{upstream_address}/provider-secret");
        let runtime =
            EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |name| match name {
                "TEST_UPSTREAM" => Some(http_url.clone()),
                "TEST_WS_UPSTREAM" => Some(ws_url.clone()),
                _ => None,
            })
            .await
            .unwrap()
            .unwrap();
        let (capability, _) =
            runtime
                .auth
                .issue_capability(customer_address(), "monad-testnet", now_ms(), 60_000);
        let (_tempdir, server) = registered_server(runtime);
        let relay_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        relay_listener.set_nonblocking(true).unwrap();
        let relay_address = relay_listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(relay_listener)
                .unwrap()
                .serve(server.into_router().into_make_service()),
        );

        let url = format!("ws://{relay_address}/chain-rpc/monad-testnet/cap/{capability}/ws");
        let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        client
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":7,"method":"eth_chainId","params":[]}).to_string(),
            ))
            .await
            .unwrap();
        let response = client.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&response).unwrap()["id"], 7);
        assert_eq!(ws_calls.load(Ordering::SeqCst), 5);

        let (mut malicious, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        malicious
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":9,"method":"eth_blockNumber","params":[]}).to_string(),
            ))
            .await
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(1), malicious.next())
            .await
            .unwrap();
        assert!(match closed {
            None => true,
            Some(Ok(message)) => message.is_close(),
            Some(Err(_)) => true,
        });

        let (mut bounded, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        for id in 0..MAX_WS_PENDING_REQUESTS {
            bounded
                .send(UpstreamWsMessage::Text(
                    json!({"jsonrpc":"2.0","id":id,"method":"eth_getBalance","params":["hold","latest"]})
                        .to_string(),
                ))
                .await
                .unwrap();
        }
        bounded
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":"overflow","method":"eth_getBalance","params":["hold","latest"]})
                    .to_string(),
            ))
            .await
            .unwrap();
        let limited = tokio::time::timeout(Duration::from_secs(1), bounded.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&limited).unwrap()["error"]["code"],
            -32005
        );

        client
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":8,"method":"debug_traceTransaction","params":[]})
                    .to_string(),
            ))
            .await
            .unwrap();
        let denied = client.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&denied).unwrap()["error"]["code"],
            -32601
        );

        let (mut timed_out, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        timed_out
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":77,"method":"eth_getBalance","params":["hold","latest"]})
                    .to_string(),
            ))
            .await
            .unwrap();
        let timeout_error = tokio::time::timeout(Duration::from_secs(2), timed_out.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&timeout_error).unwrap()["error"]["code"],
            -32002
        );
        let closed = tokio::time::timeout(Duration::from_secs(1), timed_out.next())
            .await
            .unwrap();
        assert!(match closed {
            None => true,
            Some(Ok(message)) => message.is_close(),
            Some(Err(_)) => true,
        });
    }

    #[tokio::test]
    async fn startup_rejects_wrong_chain_without_leaking_url() {
        let upstream = Router::new().route(
            "/sentinel-api-key",
            routing::post(|| async { Json(json!({"jsonrpc":"2.0","id":1,"result":"0x1"})) }),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(upstream.into_make_service()),
        );
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            ..EvmRpcConf::default()
        };
        let secret_url = format!("http://{address}/sentinel-api-key");
        let error = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |_| {
            Some(secret_url.clone())
        })
        .await
        .unwrap_err();
        let rendered = format!("{error:?} {error}");
        assert!(rendered.contains("reported 1, expected 10143"));
        assert!(!rendered.contains("sentinel-api-key"));
        assert!(!rendered.contains(&secret_url));
    }

    #[tokio::test]
    async fn startup_rejects_wrong_websocket_chain_identity() {
        let upstream = Router::new().route(
            "/provider-secret",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                Json(checkpoint_response(&request).unwrap_or_else(
                    || json!({"jsonrpc":"2.0","id":request["id"],"result":"0x279f"}),
                ))
            })
            .get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(move |mut socket| async move {
                    if let Some(Ok(ClientWsMessage::Text(text))) = socket.next().await {
                        let request: Value = serde_json::from_str(&text).unwrap();
                        let _ = socket
                            .send(ClientWsMessage::Text(
                                json!({"jsonrpc":"2.0","id":request["id"],"result":"0x1"})
                                    .to_string(),
                            ))
                            .await;
                    }
                })
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
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_HTTP".to_string(),
                upstream_ws_env: Some("TEST_WS".to_string()),
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            ..EvmRpcConf::default()
        };
        let error = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |name| match name {
            "TEST_HTTP" => Some(format!("http://{address}/provider-secret")),
            "TEST_WS" => Some(format!("ws://{address}/provider-secret")),
            _ => None,
        })
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            EvmRpcStartError::ChainMismatch {
                expected: 10_143,
                actual: 1,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn production_boundary_caps_response_bytes_and_total_time() {
        let upstream = Router::new().route(
            "/",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                match request["method"].as_str().unwrap() {
                    "eth_chainId" => Json(json!({
                        "jsonrpc":"2.0","id":request["id"],"result":"0x279f"
                    }))
                    .into_response(),
                    "eth_getBlockByNumber" => {
                        Json(checkpoint_response(&request).unwrap()).into_response()
                    }
                    "eth_getBalance" => Json(json!({
                        "jsonrpc":"2.0",
                        "id":request["id"],
                        "result":"x".repeat(512)
                    }))
                    .into_response(),
                    "eth_gasPrice" => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":"0x1"}))
                            .into_response()
                    }
                    "eth_blockNumber" => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({
                            "jsonrpc":"2.0",
                            "id":request["id"],
                            "error":{"code":-32000,"message":"provider secret"}
                        })),
                    )
                        .into_response(),
                    "eth_sendRawTransaction" => Json(json!({
                        "jsonrpc":"2.0",
                        "id":"wrong-id",
                        "result":"0xdeadbeef"
                    }))
                    .into_response(),
                    other => panic!("unexpected method {other}"),
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
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 128,
            max_concurrency: 1,
            timeout_ms: 25,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
            capability_ttl_ms: 60 * 60 * 1000,
        };
        let upstream_url = format!("http://{address}/");
        let runtime = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |_| {
            Some(upstream_url.clone())
        })
        .await
        .unwrap()
        .unwrap();
        let (_tempdir, server) = registered_server(runtime);
        let router = server.into_router();

        let large_body = br#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","latest"]}"#;
        let large = router
            .clone()
            .oneshot(request_with_proof(&router, large_body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(large.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response_json(large).await["error"],
            "rpc_upstream_response_too_large"
        );

        let slow_body = br#"{"jsonrpc":"2.0","id":2,"method":"eth_gasPrice","params":[]}"#;
        let slow = router
            .clone()
            .oneshot(request_with_proof(&router, slow_body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(slow.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(response_json(slow).await["error"], "rpc_upstream_timeout");

        let error_body = br#"{"jsonrpc":"2.0","id":4,"method":"eth_blockNumber","params":[]}"#;
        let upstream_error = router
            .clone()
            .oneshot(request_with_proof(&router, error_body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(upstream_error.status(), StatusCode::OK);
        assert_eq!(
            response_json(upstream_error).await,
            json!({
                "jsonrpc":"2.0",
                "id":4,
                "error":{"code":-32000,"message":"upstream RPC error"}
            })
        );

        let broadcast_body =
            br#"{"jsonrpc":"2.0","id":3,"method":"eth_sendRawTransaction","params":["0x00"]}"#;
        let mismatched = router
            .clone()
            .oneshot(request_with_proof(&router, broadcast_body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(mismatched.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response_json(mismatched).await,
            json!({
                "error":"invalid_rpc_upstream_response",
                "broadcast_state":"unknown"
            })
        );
    }

    #[tokio::test]
    async fn production_pipeline_limits_and_inspects_decoded_gzip_bytes() {
        let upstream = Router::new().route(
            "/",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                let response = if let Some(response) = checkpoint_response(&request) {
                    response
                } else if request["method"] == "eth_chainId" {
                    json!({"jsonrpc":"2.0","id":request["id"],"result":"0x279f"})
                } else {
                    json!({"jsonrpc":"2.0","id":request["id"],"result":"0x2a"})
                };
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(response.to_string().as_bytes()).unwrap();
                let mut response =
                    axum::response::Response::new(boxed(Body::from(encoder.finish().unwrap())));
                response.headers_mut().insert(
                    axum::http::header::CONTENT_TYPE,
                    axum::http::HeaderValue::from_static("application/json"),
                );
                response.headers_mut().insert(
                    axum::http::header::CONTENT_ENCODING,
                    axum::http::HeaderValue::from_static("gzip"),
                );
                response
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
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 1024,
            max_concurrency: 1,
            timeout_ms: 1_000,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
            capability_ttl_ms: 60 * 60 * 1000,
        };
        let upstream_url = format!("http://{address}/");
        let runtime = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |_| {
            Some(upstream_url.clone())
        })
        .await
        .unwrap()
        .unwrap();
        let (_tempdir, server) = registered_server(runtime);
        let router = server.into_router();
        let body = br#"{"jsonrpc":"2.0","id":8,"method":"eth_blockNumber","params":[]}"#;
        let response = router
            .clone()
            .oneshot(request_with_proof(&router, body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({"jsonrpc":"2.0","id":8,"result":"0x2a"})
        );
    }

    #[tokio::test]
    #[ignore = "250 MiB production streaming proof"]
    async fn production_pipeline_streams_250_mib_result_without_materializing_it() {
        const RESULT_BYTES: usize = 250 * 1024 * 1024;
        const CHUNK_BYTES: usize = 64 * 1024;
        let upstream = Router::new().route(
            "/",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                if request["method"] == "eth_chainId" {
                    return Json(json!({
                        "jsonrpc":"2.0",
                        "id":request["id"],
                        "result":"0x279f"
                    }))
                    .into_response();
                }
                if let Some(response) = checkpoint_response(&request) {
                    return Json(response).into_response();
                }
                let prefix = Bytes::from(format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":\"",
                    request["id"]
                ));
                let chunk = Bytes::from(vec![b'x'; CHUNK_BYTES]);
                let suffix = Bytes::from_static(br#""}"#);
                let chunks = std::iter::once(Ok::<_, std::convert::Infallible>(prefix))
                    .chain(
                        std::iter::repeat(Ok::<_, std::convert::Infallible>(chunk))
                            .take(RESULT_BYTES / CHUNK_BYTES),
                    )
                    .chain(std::iter::once(Ok::<_, std::convert::Infallible>(suffix)));
                let mut response = axum::response::Response::new(boxed(Body::wrap_stream(
                    futures::stream::iter(chunks),
                )));
                response.headers_mut().insert(
                    axum::http::header::CONTENT_TYPE,
                    axum::http::HeaderValue::from_static("application/json"),
                );
                response
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
        let conf = EvmRpcConf {
            enabled: true,
            chains: vec![cashweb_config::EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "TEST_UPSTREAM".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 300 * 1024 * 1024,
            max_concurrency: 1,
            timeout_ms: 120_000,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
            capability_ttl_ms: 60 * 60 * 1000,
        };
        conf.validate().unwrap();
        let upstream_url = format!("http://{address}/");
        let runtime = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |_| {
            Some(upstream_url.clone())
        })
        .await
        .unwrap()
        .unwrap();
        let (_tempdir, server) = registered_server(runtime);
        let router = server.into_router();
        let request_body = br#"{"jsonrpc":"2.0","id":7,"method":"eth_getLogs","params":[{"fromBlock":"0x1","toBlock":"0x2"}]}"#;
        let response = router
            .clone()
            .oneshot(request_with_proof(&router, request_body, customer_address()).await)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body();
        let mut received = 0usize;
        while let Some(chunk) = body.data().await {
            received += chunk.unwrap().len();
        }
        let prefix_len = br#"{"jsonrpc":"2.0","id":7,"result":""#.len();
        assert_eq!(received, prefix_len + RESULT_BYTES + 2);
    }

    /// The directory-admitted principal class of the EVM proxy, against the real directory owner.
    mod directory_principal {
        use super::*;
        use crate::{
            directory_runtime::{Operation, Submission},
            http::monad_message_cbor::tests::{public_p_signature, NativeDirectoryFixture},
        };

        const CHAIN_ID: u64 = 10_143;

        fn lookups() -> usize {
            DIRECTORY_LOOKUPS.get()
        }

        fn server(fixture: &NativeDirectoryFixture, runtime: EvmRpcRuntime) -> RegistryServer {
            RegistryServer {
                registry: fixture.registry.clone(),
                peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
                pop_gate: Arc::new(PopGate::from_conf_if_enabled(&placeholder_pop_conf())),
                curated_defaults: Arc::new(vec![]),
                monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
                evm_rpc: Some(Arc::new(runtime)),
                bitcoin_proxy: None,
                solana_proxy: None,
            }
        }

        /// The self-published account the fixture's wallet signer holds the key of.
        fn subject(fixture: &NativeDirectoryFixture) -> (String, Address) {
            let point = fixture.accounts[1].subject.clone();
            let address = crate::monad_stamp_stealth::recipient_address_from_public_key(
                &hex::decode(&point).unwrap(),
            )
            .unwrap();
            (point, address)
        }

        fn binding(customer: Address) -> RpcBinding {
            RpcBinding {
                customer,
                chain: "monad-testnet".to_string(),
                body_sha256: body_hash(b""),
                resource: RpcResource::Capability,
            }
        }

        fn proof(challenge: RpcChallenge, customer: Address, signature: &[u8]) -> HeaderMap {
            let mut headers = HeaderMap::new();
            headers.insert(RPC_CUSTOMER_HEADER, customer.to_hex().parse().unwrap());
            for (name, value) in [
                (RPC_EPOCH_HEADER, hex::encode(challenge.epoch)),
                (RPC_NONCE_HEADER, hex::encode(challenge.nonce)),
                (RPC_TOKEN_HEADER, hex::encode(challenge.token)),
                (RPC_EXPIRY_HEADER, challenge.expires_at_ms.to_string()),
                (RPC_SIGNATURE_HEADER, hex::encode(signature)),
            ] {
                headers.insert(name, value.parse().unwrap());
            }
            headers
        }

        fn digest(challenge: RpcChallenge, binding: &RpcBinding, tag: &[u8]) -> [u8; 32] {
            Sha256::digest(auth_preimage(challenge, binding, tag)).into()
        }

        /// A fresh challenge for the published account, signed by its real wallet key.
        async fn subject_proof(
            fixture: &NativeDirectoryFixture,
            auth: &RpcAuthState,
            tag: &[u8],
        ) -> (RpcBinding, HeaderMap) {
            let (point, customer) = subject(fixture);
            let binding = binding(customer);
            let challenge = auth.issue(&binding, now_ms());
            let signature = public_p_signature(
                fixture.root.path(),
                digest(challenge, &binding, tag),
                &point,
            )
            .await;
            (binding.clone(), proof(challenge, customer, &signature))
        }

        /// A fresh challenge signed by the legacy test customer's key.
        fn legacy_proof(auth: &RpcAuthState, tag: &[u8]) -> (RpcBinding, HeaderMap) {
            let binding = binding(customer_address());
            let challenge = auth.issue(&binding, now_ms());
            let signature = EccSecp256k1::default()
                .sign(&customer_secret(), digest(challenge, &binding, tag).into());
            (
                binding.clone(),
                proof(challenge, binding.customer, &signature),
            )
        }

        async fn check(
            server: &RegistryServer,
            auth: &RpcAuthState,
            tag: &[u8],
            chain_id: u64,
            proof: &(RpcBinding, HeaderMap),
        ) -> Result<(), (StatusCode, &'static str)> {
            authenticate_customer(&proof.1, server, auth, tag, chain_id, &proof.0)
                .await
                .map_err(|rejection| (rejection.status, rejection.code))
        }

        const REFUSED: Result<(), (StatusCode, &str)> =
            Err((StatusCode::UNAUTHORIZED, "rpc_auth_failed"));

        /// Occupies the directory owner and fills its whole queue, so one more lookup is Busy.
        /// Returns what to send and await to let it drain.
        async fn fill_directory_queue(
            fixture: &NativeDirectoryFixture,
        ) -> (std::sync::mpsc::Sender<()>, Vec<Submission>) {
            let directory = &fixture.directory;
            let principal = &fixture.accounts[0];
            let reserve = || {
                directory
                    .reserve(&principal.network, &principal.subject)
                    .unwrap()
            };
            let (entered, started) = tokio::sync::oneshot::channel();
            let (release, barrier) = std::sync::mpsc::channel();
            let mut held = vec![directory.submit(
                reserve(),
                Operation::Barrier {
                    entered,
                    release: barrier,
                    next: Box::new(Operation::Current),
                },
            )];
            started.await.unwrap();
            for _ in 0..8 {
                held.push(directory.submit(reserve(), Operation::Current));
            }
            assert!(matches!(
                directory.reserve(&principal.network, &principal.subject),
                Err(crate::directory_runtime::RuntimeError::Busy)
            ));
            (release, held)
        }

        async fn drain(release: std::sync::mpsc::Sender<()>, held: Vec<Submission>) {
            release.send(()).unwrap();
            for submission in held {
                submission.wait().await.unwrap();
            }
        }

        #[tokio::test]
        async fn evm_rpc_admitted_installed_subject_gets_a_capability_through_the_route() {
            let fixture = NativeDirectoryFixture::new().await;
            let (point, customer) = subject(&fixture);
            let router = server(&fixture, runtime()).into_router();
            let challenge = router
                .clone()
                .oneshot(
                    Request::post("/chain-rpc/monad-testnet/capability/auth")
                        .header(RPC_CUSTOMER_HEADER, customer.to_hex())
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(challenge.status(), StatusCode::OK);
            let challenge = response_json(challenge).await;
            let field = |name: &str| {
                let mut bytes = [0; 32];
                hex::decode_to_slice(challenge[name].as_str().unwrap(), &mut bytes).unwrap();
                bytes
            };
            let issued = RpcChallenge {
                epoch: field("epoch"),
                nonce: field("nonce"),
                token: field("token"),
                expires_at_ms: challenge["expires_at_ms"].as_i64().unwrap(),
            };
            let signature = public_p_signature(
                fixture.root.path(),
                digest(issued, &binding(customer), b"MONT"),
                &point,
            )
            .await;
            let request = || {
                let mut request = Request::post("/chain-rpc/monad-testnet/capability")
                    .body(Body::empty())
                    .unwrap();
                *request.headers_mut() = proof(issued, customer, &signature);
                request
            };
            DIRECTORY_LOOKUPS.set(0);
            let response = router.clone().oneshot(request()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let capability = response_json(response).await;
            assert!(capability["rpc_path"]
                .as_str()
                .unwrap()
                .starts_with("/chain-rpc/monad-testnet/cap/"));
            assert_eq!(lookups(), 1);
            // The proof is single-use, exactly like a legacy customer's.
            let replay = router.clone().oneshot(request()).await.unwrap();
            assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response_json(replay).await["error"], "rpc_auth_failed");
            fixture.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_self_published_account_is_admitted_and_an_unpublished_key_is_not() {
            // The same account and the same valid signature: published on one relay, never
            // published on the other. Neither relay has any per-account configuration.
            let published = NativeDirectoryFixture::new().await;
            let unpublished = NativeDirectoryFixture::publishing(|index| index != 1).await;
            assert_eq!(subject(&published), subject(&unpublished));
            let runtime = runtime();
            let (auth, tag) = (&runtime.auth, b"MONT".as_slice());
            let proof = subject_proof(&published, auth, tag).await;
            let mut presenting = proof.clone();
            presenting
                .1
                .insert(RPC_SUBJECT_HEADER, subject(&published).0.parse().unwrap());

            let stranger = server(&unpublished, self::runtime());
            DIRECTORY_LOOKUPS.set(0);
            // Without its key in the request the relay has no index entry to find it by.
            assert_eq!(check(&stranger, auth, tag, CHAIN_ID, &proof).await, REFUSED);
            assert_eq!(lookups(), 0);
            // Presenting the key does not help: the directory is asked and has no entry for it.
            assert_eq!(
                check(&stranger, auth, tag, CHAIN_ID, &presenting).await,
                REFUSED
            );
            assert_eq!(lookups(), 1);

            let server = server(&published, self::runtime());
            // The legacy profile path alone has no key for a canonical account.
            assert!(matches!(
                authenticate(&proof.1, &server, auth, tag, &proof.0),
                Err(rejection) if rejection.status == StatusCode::UNAUTHORIZED
            ));
            DIRECTORY_LOOKUPS.set(0);
            // Found through the address index, with no key header.
            assert_eq!(check(&server, auth, tag, CHAIN_ID, &proof).await, Ok(()));
            assert_eq!(lookups(), 1);
            // Found by the presented key.
            let again = subject_proof(&published, auth, tag).await;
            let mut again_presenting = again.clone();
            again_presenting
                .1
                .insert(RPC_SUBJECT_HEADER, subject(&published).0.parse().unwrap());
            assert_eq!(
                check(&server, auth, tag, CHAIN_ID, &again_presenting).await,
                Ok(())
            );
            // A presented key that is someone else's published key does not authenticate.
            let other = subject_proof(&published, auth, tag).await;
            let mut wrong_key = other.clone();
            wrong_key.1.insert(
                RPC_SUBJECT_HEADER,
                published.accounts[0].subject.parse().unwrap(),
            );
            assert_eq!(
                check(&server, auth, tag, CHAIN_ID, &wrong_key).await,
                REFUSED
            );
            published.stop().await;
            unpublished.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_admitted_subject_of_another_network_or_chain_is_not_looked_up() {
            let fixture = NativeDirectoryFixture::new().await;
            let server = server(&fixture, runtime());
            let runtime = runtime();
            let auth = &runtime.auth;
            DIRECTORY_LOOKUPS.set(0);

            // The relay proxies mainnet; the account published on testnet.
            let mainnet = subject_proof(&fixture, auth, b"MON1").await;
            assert_eq!(check(&server, auth, b"MON1", 143, &mainnet).await, REFUSED);

            // The relay's network is the subject's, but the proxied chain is not that network's.
            let testnet = subject_proof(&fixture, auth, b"MONT").await;
            assert_eq!(check(&server, auth, b"MONT", 143, &testnet).await, REFUSED);
            assert_eq!(lookups(), 0);

            // The refusals were about the network: the second proof is good on its own chain.
            assert_eq!(
                check(&server, auth, b"MONT", CHAIN_ID, &testnet).await,
                Ok(())
            );
            fixture.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_admitted_class_excludes_an_address_that_never_published() {
            let fixture = NativeDirectoryFixture::new().await;
            let server = server(&fixture, runtime());
            let runtime = runtime();
            let (auth, tag) = (&runtime.auth, b"MONT".as_slice());
            // A valid signature by a key that has neither published nor stored a profile.
            let stranger = legacy_proof(auth, tag);
            DIRECTORY_LOOKUPS.set(0);
            assert_eq!(
                check(&server, auth, tag, CHAIN_ID, &stranger).await,
                REFUSED
            );
            assert_eq!(lookups(), 0);
            fixture.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_admitted_lookup_never_happens_before_the_challenge_is_verified() {
            let fixture = NativeDirectoryFixture::new().await;
            let server = server(&fixture, runtime());
            let runtime = runtime();
            let (auth, tag) = (&runtime.auth, b"MONT".as_slice());
            let (_, customer) = subject(&fixture);
            let binding = binding(customer);
            let issued = auth.issue(&binding, now_ms());
            let well_formed_signature = [0x30; MIN_ECDSA_DER_SIGNATURE_BYTES];
            let mut wrong_mac = issued;
            wrong_mac.token[0] ^= 1;
            let mut wrong_epoch = issued;
            wrong_epoch.epoch[0] ^= 1;
            let mut other_expiry = issued;
            other_expiry.expires_at_ms -= 1;
            let other_relay = RpcAuthState::new().issue(&binding, now_ms());
            let unverified = [wrong_mac, wrong_epoch, other_expiry, other_relay].map(|challenge| {
                (
                    binding.clone(),
                    proof(challenge, customer, &well_formed_signature),
                )
            });
            let mut missing_signature = proof(issued, customer, &well_formed_signature);
            missing_signature.remove(RPC_SIGNATURE_HEADER);
            let missing_signature = (binding.clone(), missing_signature);

            DIRECTORY_LOOKUPS.set(0);
            for attempt in unverified.iter().chain([&missing_signature]) {
                assert_eq!(check(&server, auth, tag, CHAIN_ID, attempt).await, REFUSED);
            }
            assert_eq!(lookups(), 0);

            // With the owner's queue full, a lookup would be answered 503. None of these is.
            let (release, held) = fill_directory_queue(&fixture).await;
            for attempt in unverified.iter().chain([&missing_signature]) {
                assert_eq!(check(&server, auth, tag, CHAIN_ID, attempt).await, REFUSED);
            }
            assert_eq!(lookups(), 0);
            drain(release, held).await;

            // The counter does see a lookup: a verified challenge with a wrong signature asks.
            let verified = (
                binding.clone(),
                proof(issued, customer, &well_formed_signature),
            );
            assert_eq!(
                check(&server, auth, tag, CHAIN_ID, &verified).await,
                REFUSED
            );
            assert_eq!(lookups(), 1);
            fixture.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_admitted_subject_gets_retryable_503_while_the_directory_is_busy() {
            let fixture = NativeDirectoryFixture::new().await;
            let server = server(&fixture, runtime());
            let runtime = runtime();
            let (auth, tag) = (&runtime.auth, b"MONT".as_slice());
            let proof = subject_proof(&fixture, auth, tag).await;

            let (release, held) = fill_directory_queue(&fixture).await;
            let busy = authenticate_customer(&proof.1, &server, auth, tag, CHAIN_ID, &proof.0)
                .await
                .unwrap_err();
            assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(busy.code, "rpc_auth_busy");
            let response = busy.into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response_json(response).await["error"], "rpc_auth_busy");
            drain(release, held).await;

            // Nothing was consumed: the very same proof succeeds once the directory answers.
            assert_eq!(check(&server, auth, tag, CHAIN_ID, &proof).await, Ok(()));
            fixture.stop().await;
        }

        #[tokio::test]
        async fn evm_rpc_admitted_class_leaves_a_legacy_principal_exactly_as_before() {
            let fixture = NativeDirectoryFixture::new().await;
            register_legacy_profile(&fixture.registry);
            let server = server(&fixture, runtime());
            let runtime = runtime();
            let (auth, tag) = (&runtime.auth, b"MONT".as_slice());

            // The same kind of proof through the old entry point and the new one.
            let old = legacy_proof(auth, tag);
            let new = legacy_proof(auth, tag);
            DIRECTORY_LOOKUPS.set(0);
            assert!(authenticate(&old.1, &server, auth, tag, &old.0).is_ok());
            assert_eq!(check(&server, auth, tag, CHAIN_ID, &new).await, Ok(()));
            // Both are single-use.
            assert!(matches!(
                authenticate(&old.1, &server, auth, tag, &old.0),
                Err(rejection) if rejection.status == StatusCode::UNAUTHORIZED
                    && rejection.code == "rpc_auth_failed"
            ));
            assert_eq!(check(&server, auth, tag, CHAIN_ID, &new).await, REFUSED);

            // A wrong signature is refused the same way by both.
            let (binding, mut headers) = legacy_proof(auth, tag);
            let other = EccSecp256k1::default().sign(&customer_secret(), [7; 32].into());
            headers.insert(RPC_SIGNATURE_HEADER, hex::encode(other).parse().unwrap());
            assert!(matches!(
                authenticate(&headers, &server, auth, tag, &binding),
                Err(rejection) if rejection.status == StatusCode::UNAUTHORIZED
                    && rejection.code == "rpc_auth_failed"
            ));
            assert_eq!(
                check(&server, auth, tag, CHAIN_ID, &(binding, headers)).await,
                REFUSED
            );

            // A legacy principal never touches the directory, so a full queue cannot refuse it.
            let (release, held) = fill_directory_queue(&fixture).await;
            let during = legacy_proof(auth, tag);
            assert_eq!(check(&server, auth, tag, CHAIN_ID, &during).await, Ok(()));
            assert_eq!(lookups(), 0);
            drain(release, held).await;
            fixture.stop().await;
        }
    }
}
