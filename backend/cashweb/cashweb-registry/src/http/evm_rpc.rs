//! Customer-authenticated, allowlisted EVM JSON-RPC relay proxy.
//!
//! The proxy has its own signing domain and binds authorization to the exact request bytes. Its
//! upstream URL is process-owned secret state: responses and diagnostics name only the public
//! chain id. Challenge issuance validates and hashes a bounded request but never contacts the
//! provider.

use std::{
    collections::HashMap,
    fmt,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{Bytes, HttpBody},
    extract::{connect_info::ConnectInfo, Extension, Path},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use cashweb_config::EvmRpcConf;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::{
    http::{
        bitcoin_proxy::BitcoinProxyRuntime, hourly_quota::FixedHourQuota, server::RegistryServer,
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
// EVM clients batch when they can, but boot-time log scans and multi-account sweeps can still
// legitimately exceed the mailbox's much smaller read cadence. This is replay-retention capacity,
// not the usage limit; weighted fixed-hour quotas remain the resource-control boundary.
const MAX_USED_RPC_CHALLENGES_PER_CUSTOMER: usize = 2_048;
pub(crate) const RPC_CUSTOMER_HEADER: &str = "x-frank-rpc-customer";
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
        let server = req
            .extensions()
            .get::<RegistryServer>()
            .ok_or_else(|| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_unavailable"))?;
        let path = req.uri().path();
        let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
        let chain_id = segments
            .get(1)
            .filter(|_| segments.first() == Some(&"chain-rpc"))
            .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
        let (permits, max_bytes, timeout) =
            if segments.get(2) == Some(&"chronik") || segments.get(2) == Some(&"chronik-auth") {
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
                            .filter(|runtime| runtime.has_rpc_chain(chain_id))
                            .map(BitcoinProxyRuntime::body_admission)
                    })
            }
            .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
        let permit = permits
            .try_acquire_owned()
            .map_err(|_| rpc_error(StatusCode::SERVICE_UNAVAILABLE, "rpc_ingress_busy"))?;
        let mut body = req
            .take_body()
            .ok_or_else(|| rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "rpc_body_unavailable"))?;
        let read_body = async {
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::time::timeout(timeout, body.data())
                    .await
                    .map_err(|_| rpc_error(StatusCode::REQUEST_TIMEOUT, "rpc_body_timeout"))?;
                let Some(chunk) = chunk else {
                    break;
                };
                let chunk =
                    chunk.map_err(|_| rpc_error(StatusCode::BAD_REQUEST, "invalid_rpc_body"))?;
                if bytes.len().saturating_add(chunk.len()) > max_bytes {
                    return Err(rpc_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "rpc_request_too_large",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, RpcRejection>(bytes)
        };
        let bytes = tokio::time::timeout(timeout, read_body)
            .await
            .map_err(|_| rpc_error(StatusCode::REQUEST_TIMEOUT, "rpc_body_timeout"))??;
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
    checkpoint: Option<(u64, String)>,
    max_get_logs_range: u64,
}

impl fmt::Debug for EvmChainRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvmChainRuntime")
            .field("id", &self.id)
            .field("expected_chain_id", &self.expected_chain_id)
            .field("upstream_url", &"<redacted>")
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
}

impl RpcBinding {
    fn append_canonical(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(b"POST\0/chain-rpc/");
        bytes.extend_from_slice(&(self.chain.len() as u32).to_be_bytes());
        bytes.extend_from_slice(self.chain.as_bytes());
        bytes.extend_from_slice(b"\0rpc");
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
    customer_quota: FixedHourQuota<Address>,
    anonymous_quota: FixedHourQuota<IpAddr>,
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
    /// The named environment variable does not contain a hosted HTTP(S) URL.
    #[error("EVM RPC upstream environment variable {0} is not a hosted HTTP(S) URL")]
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
            chains.insert(
                chain.id.clone(),
                EvmChainRuntime {
                    id: chain.id.clone(),
                    expected_chain_id: chain.expected_chain_id,
                    upstream_url,
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
            customer_quota: FixedHourQuota::new(conf.customer_units_per_hour),
            anonymous_quota: FixedHourQuota::new(conf.anonymous_units_per_hour),
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
                read_startup_response(response, self.max_response_bytes, &chain.id),
            )
            .await
            .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))??;
            let result = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| value.get("result")?.as_str().map(str::to_owned))
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
                    read_startup_response(response, self.max_response_bytes, &chain.id),
                )
                .await
                .map_err(|_| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))??;
                let actual = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|value| value.pointer("/result/hash")?.as_str().map(str::to_owned))
                    .ok_or_else(|| EvmRpcStartError::UpstreamUnavailable(chain.id.clone()))?;
                if !actual.eq_ignore_ascii_case(expected_hash) {
                    return Err(EvmRpcStartError::CheckpointMismatch(chain.id.clone()));
                }
            }
        }
        Ok(())
    }
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
}

impl IntoResponse for RpcRejection {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.code });
        if let Some(state) = self.broadcast_state {
            body["broadcast_state"] = Value::String(state.to_string());
        }
        (self.status, Json(body)).into_response()
    }
}

pub(crate) fn rpc_error(status: StatusCode, code: &'static str) -> RpcRejection {
    RpcRejection {
        status,
        code,
        broadcast_state: None,
    }
}

fn broadcast_error(
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
    }
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
            for call in &calls {
                let cost = validate_call(call, chain)?;
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
    match address.ip() {
        IpAddr::V4(ip) => IpAddr::V4(ip),
        IpAddr::V6(ip) => IpAddr::V6(std::net::Ipv6Addr::from(u128::from(ip) & (!0u128 << 64))),
    }
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

pub(crate) fn authenticate(
    headers: &HeaderMap,
    server: &RegistryServer,
    auth: &RpcAuthState,
    network_tag: &[u8],
    binding: &RpcBinding,
) -> Result<(), RpcRejection> {
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
    let digest: [u8; 32] = Sha256::digest(auth_preimage(challenge, binding, network_tag)).into();
    let valid = server
        .registry
        .verify_monad_recipient_signature(binding.customer, digest, &signature)
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

/// Issue a request-bound challenge without contacting the upstream or revealing registration.
pub(crate) async fn handle_issue_rpc_challenge(
    Path(chain_id): Path<String>,
    headers: HeaderMap,
    Extension(server): Extension<RegistryServer>,
    BoundedRpcBody {
        bytes: body,
        _permit: _ingress_permit,
    }: BoundedRpcBody,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let Some(runtime) = server.evm_rpc.as_deref() else {
        return crate::http::bitcoin_proxy::issue_rpc_challenge(chain_id, headers, server, body)
            .await;
    };
    let Some(chain) = runtime.chains.get(&chain_id) else {
        return crate::http::bitcoin_proxy::issue_rpc_challenge(chain_id, headers, server, body)
            .await;
    };
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

async fn read_bounded_response(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Bytes, RpcRejection> {
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| rpc_error(StatusCode::BAD_GATEWAY, "rpc_upstream_unavailable"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(rpc_error(
                StatusCode::BAD_GATEWAY,
                "rpc_upstream_response_too_large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.into())
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
    let Some(runtime) = server.evm_rpc.as_deref() else {
        return crate::http::bitcoin_proxy::proxy_rpc(chain_id, peer, headers, server, body).await;
    };
    let Some(chain) = runtime.chains.get(&chain_id) else {
        return crate::http::bitcoin_proxy::proxy_rpc(chain_id, peer, headers, server, body).await;
    };
    let cost = validate_body(runtime, chain, &body)?;
    let customer = headers
        .get(RPC_CUSTOMER_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(Address::from_hex)
        .transpose()
        .map_err(|_| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
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
        let binding = RpcBinding {
            customer,
            chain: chain_id,
            body_sha256: body_hash(&body),
        };
        authenticate(
            &headers,
            &server,
            &runtime.auth,
            &runtime.network_tag,
            &binding,
        )?;
        runtime
            .customer_quota
            .charge(customer, cost.units, now_seconds())
            .ok_or_else(|| {
                broadcast_error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rpc_hourly_quota",
                    cost.broadcast,
                    false,
                )
            })?;
    } else {
        if !cost.anonymous {
            return Err(rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"));
        }
        let peer =
            peer.ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_source_required"))?;
        runtime
            .anonymous_quota
            .charge(quota_ip(peer.0), cost.units, now_seconds())
            .ok_or_else(|| {
                broadcast_error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rpc_hourly_quota",
                    cost.broadcast,
                    false,
                )
            })?;
    }
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
        if !response.status().is_success() {
            return Err(broadcast_error(
                StatusCode::BAD_GATEWAY,
                "rpc_upstream_unavailable",
                cost.broadcast,
                true,
            ));
        }
        read_bounded_response(response, runtime.max_response_bytes)
            .await
            .map_err(|error| {
                if cost.broadcast {
                    broadcast_error(error.status, error.code, true, true)
                } else {
                    error
                }
            })
    };
    let body = tokio::time::timeout(runtime.timeout, upstream)
        .await
        .map_err(|_| {
            broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                cost.broadcast,
                true,
            )
        })??;
    let mut value = serde_json::from_slice::<Value>(&body).map_err(|_| {
        broadcast_error(
            StatusCode::BAD_GATEWAY,
            "invalid_rpc_upstream_response",
            cost.broadcast,
            true,
        )
    })?;
    crate::http::json_rpc::sanitize_response_errors(&mut value);
    let body = serde_json::to_vec(&value).map_err(|_| {
        broadcast_error(
            StatusCode::BAD_GATEWAY,
            "invalid_rpc_upstream_response",
            cost.broadcast,
            true,
        )
    })?;
    let response = (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body,
    )
        .into_response();
    Ok(crate::http::json_rpc::hold_response_permit(
        response, permit,
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
            customer_quota: FixedHourQuota::new(10_000),
            anonymous_quota: FixedHourQuota::new(500),
        }
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
            },
        )
    }

    fn signed_headers(challenge: &Value, customer: Address) -> HeaderMap {
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
        preimage.extend_from_slice(b"\0rpc");
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
        *request.headers_mut() = signed_headers(&challenge, customer);
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
                    if request["method"] == "eth_chainId" {
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
                checkpoint_block_number: None,
                checkpoint_block_hash: None,
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 1024,
            max_concurrency: 1,
            timeout_ms: 1_000,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
        };
        let upstream_url = format!("http://{address}/provider-secret");
        let runtime = EvmRpcRuntime::from_conf_with_env(&conf, b"MONT".to_vec(), |name| {
            (name == "TEST_UPSTREAM").then(|| upstream_url.clone())
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);
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
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);

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
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);

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
        let unregistered_headers = signed_headers(&unregistered_challenge, unregistered);
        let mut unregistered_request = Request::post("/chain-rpc/monad-testnet/rpc")
            .body(Body::from(body.as_slice()))
            .unwrap();
        *unregistered_request.headers_mut() = unregistered_headers;
        let unregistered_response = router.clone().oneshot(unregistered_request).await.unwrap();
        assert_eq!(unregistered_response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);

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
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);
        let headers = signed_headers(&challenge, customer_address());

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
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);

        let replay = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);

        let mut tampered = Request::post("/chain-rpc/monad-testnet/rpc")
            .body(Body::from(
                br#"{"jsonrpc":"2.0","id":"changed","method":"eth_blockNumber","params":[]}"#
                    .as_slice(),
            ))
            .unwrap();
        *tampered.headers_mut() = headers;
        let tampered = router.oneshot(tampered).await.unwrap();
        assert_eq!(tampered.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(upstream_calls.load(Ordering::SeqCst), 2);
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
                checkpoint_block_number: None,
                checkpoint_block_hash: None,
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
    async fn production_boundary_caps_response_bytes_and_total_time() {
        let upstream = Router::new().route(
            "/",
            routing::post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                match request["method"].as_str().unwrap() {
                    "eth_chainId" => {
                        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":"0x279f"}))
                    }
                    "eth_getBalance" => Json(json!({
                        "jsonrpc":"2.0",
                        "id":request["id"],
                        "result":"x".repeat(512)
                    })),
                    "eth_gasPrice" => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":"0x1"}))
                    }
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
                checkpoint_block_number: None,
                checkpoint_block_hash: None,
                max_get_logs_range: 10,
            }],
            max_request_bytes: 1024,
            max_batch_len: 2,
            max_response_bytes: 128,
            max_concurrency: 1,
            timeout_ms: 25,
            customer_units_per_hour: 10_000,
            anonymous_units_per_hour: 500,
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
    }
}
