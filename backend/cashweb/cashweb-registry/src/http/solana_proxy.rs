//! Solana JSON-RPC relay proxy.
//!
//! Solana nodes use JSON-RPC 2.0. The proxy enforces strict allowlists, parameter bounds,
//! burstable quotas, and startup genesis hash verification (`getGenesisHash`).
//! Upstream URLs are process-owned secret state and never leak in responses or error messages.

use std::{
    collections::HashMap,
    fmt,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::{boxed, Bytes},
    extract::connect_info::ConnectInfo,
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use cashweb_config::{SolanaProxyConf, SolanaProxyConfigError};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use url::Url;

use crate::{
    http::{
        evm_rpc::{
            authenticate, body_hash, broadcast_error, now_ms, preflight_broadcast_error,
            quota_error, rpc_error, RpcAuthState, RpcBinding, RpcCapabilityBody, RpcChallengeBody,
            RpcRejection, RpcResource, RPC_AUTH_DOMAIN, RPC_CUSTOMER_HEADER,
        },
        hourly_quota::{normalize_quota_ip, FixedHourQuota},
        server::RegistryServer,
        upstream_cooldown::UpstreamCooldownTracker,
    },
    monad_http::Address,
};

const MAX_STARTUP_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_ACCOUNTS_IN_BATCH_QUERY: usize = 100;
const MAX_SIGNATURES_LIMIT: u64 = 1000;
const MAX_WIRE_TRANSACTION_CHARS: usize = 4096;
/// Longest startup waits for the first identity check of this proxy's chains.
const STARTUP_WAIT: Duration = Duration::from_secs(2);
/// How often an upstream that has not yet proved its identity is asked again.
const IDENTITY_RETRY: Duration = if cfg!(test) {
    Duration::from_millis(50)
} else {
    Duration::from_secs(30)
};

#[derive(Clone)]
struct SolanaChain {
    id: String,
    upstream_urls: Vec<Url>,
    expected_genesis_hash: String,
    /// The chain's upstreams have proved they are the configured chain. Until they do, nothing
    /// is forwarded to them.
    verified: Arc<std::sync::atomic::AtomicBool>,
}

impl fmt::Debug for SolanaChain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SolanaChain")
            .field("id", &self.id)
            .field("upstream_urls_count", &self.upstream_urls.len())
            .field("expected_genesis_hash", &self.expected_genesis_hash)
            .finish()
    }
}

/// Validated Solana proxy runtime state.
pub struct SolanaProxyRuntime {
    chains: HashMap<String, SolanaChain>,
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
    capability_ttl: Duration,
    cooldowns: UpstreamCooldownTracker,
}

impl fmt::Debug for SolanaProxyRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SolanaProxyRuntime")
            .field("chains", &self.chains)
            .field("max_request_bytes", &self.max_request_bytes)
            .field("max_batch_len", &self.max_batch_len)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// Startup errors never contain a secret upstream URL or response body.
#[derive(Debug, thiserror::Error)]
pub enum SolanaProxyStartError {
    /// Static proxy configuration is invalid.
    #[error("invalid Solana proxy configuration: {0}")]
    InvalidConfig(SolanaProxyConfigError),
    /// A named server-only environment variable is absent.
    #[error("missing Solana proxy upstream environment variable {0}")]
    MissingUpstream(String),
    /// A named environment variable is not a hosted HTTP(S) URL.
    #[error("invalid Solana proxy upstream environment variable {0}")]
    InvalidUpstream(String),
    /// An upstream did not return a usable startup identity response.
    #[error("Solana proxy chain {0} failed startup genesis hash validation")]
    UpstreamUnavailable(String),
    /// An upstream returned a genesis hash other than the expected one.
    #[error("Solana proxy chain {id} genesis hash mismatch")]
    GenesisHashMismatch {
        /// Stable public protocol chain id.
        id: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CallCost {
    units: u32,
    anonymous: bool,
    broadcast: bool,
}

impl SolanaProxyRuntime {
    /// Whether the chain is configured in this runtime.
    pub(crate) fn has_chain(&self, id: &str) -> bool {
        self.chains.contains_key(id)
    }

    /// Return all configured chain IDs.
    pub(crate) fn chain_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.chains.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub(crate) fn body_admission(&self) -> (Arc<Semaphore>, usize, Duration) {
        (
            Arc::clone(&self.ingress_permits),
            self.max_request_bytes,
            self.timeout,
        )
    }

    /// Resolve upstream URLs and check each configured chain's genesis hash. Only a bad
    /// configuration is an error: an upstream that is down or is the wrong chain leaves that
    /// chain unserved, never the relay unstarted.
    pub async fn from_conf_with_env(
        conf: &SolanaProxyConf,
        network_tag: Vec<u8>,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Arc<Self>>, SolanaProxyStartError> {
        conf.validate()
            .map_err(SolanaProxyStartError::InvalidConfig)?;
        if !conf.enabled {
            return Ok(None);
        }
        let mut chains = HashMap::new();
        for row in &conf.chains {
            let mut upstream_urls = Vec::new();
            let mut all_envs = vec![row.upstream_env.as_str()];
            for env_name in &row.upstream_envs {
                all_envs.push(env_name.as_str());
            }
            for env_name in all_envs {
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
                                matches!(u.scheme(), "http" | "https") && u.host_str().is_some()
                            })
                            .ok_or_else(|| {
                                SolanaProxyStartError::InvalidUpstream(env_name.to_string())
                            })?;
                        if !upstream_urls.contains(&url) {
                            upstream_urls.push(url);
                        }
                    }
                }
            }
            if upstream_urls.is_empty() {
                return Err(SolanaProxyStartError::MissingUpstream(
                    row.upstream_env.clone(),
                ));
            }
            chains.insert(
                row.id.clone(),
                SolanaChain {
                    id: row.id.clone(),
                    upstream_urls,
                    expected_genesis_hash: row.expected_genesis_hash.clone(),
                    verified: Default::default(),
                },
            );
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| SolanaProxyStartError::UpstreamUnavailable("client".into()))?;
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
            capability_ttl: Duration::from_millis(conf.capability_ttl_ms),
            cooldowns: UpstreamCooldownTracker::default(),
        });
        runtime.start_verifying().await;
        Ok(Some(runtime))
    }

    async fn verify_genesis_hash(&self, chain: &SolanaChain) -> Result<(), SolanaProxyStartError> {
        {
            let body = json!({
                "jsonrpc": "2.0",
                "id": "startup",
                "method": "getGenesisHash",
            });
            let body_bytes = serde_json::to_vec(&body).unwrap();
            for upstream_url in &chain.upstream_urls {
                let response = tokio::time::timeout(
                    self.timeout,
                    self.client
                        .post(upstream_url.clone())
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(body_bytes.clone())
                        .send(),
                )
                .await
                .map_err(|_| SolanaProxyStartError::UpstreamUnavailable(chain.id.clone()))?
                .map_err(|_| SolanaProxyStartError::UpstreamUnavailable(chain.id.clone()))?;

                if !response.status().is_success() {
                    return Err(SolanaProxyStartError::UpstreamUnavailable(chain.id.clone()));
                }
                let bytes = read_response(response, MAX_STARTUP_RESPONSE_BYTES)
                    .await
                    .map_err(|_| SolanaProxyStartError::UpstreamUnavailable(chain.id.clone()))?;

                let actual = super::json_rpc::startup_result(
                    &bytes,
                    super::json_rpc::JsonRpcVersion::V2,
                    &json!("startup"),
                )
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| SolanaProxyStartError::UpstreamUnavailable(chain.id.clone()))?;

                if actual != chain.expected_genesis_hash {
                    return Err(SolanaProxyStartError::GenesisHashMismatch {
                        id: chain.id.clone(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Check the identity of every chain not yet verified. A chain whose upstream cannot be
    /// reached, or answers as a different chain, stays unserved and is reported; the relay
    /// and its other chains carry on. Returns whether every chain is now verified.
    async fn verify_unverified_chains(&self) -> bool {
        use std::sync::atomic::Ordering;
        let checks = self
            .chains
            .values()
            .filter(|chain| !chain.verified.load(Ordering::Relaxed))
            .map(|chain| async move {
                match self.verify_genesis_hash(chain).await {
                    Ok(()) => {
                        chain.verified.store(true, Ordering::Relaxed);
                        true
                    }
                    Err(error) => {
                        tracing::event!(
                            tracing::Level::ERROR,
                            chain = %chain.id,
                            error = %error,
                            "Solana proxy chain is NOT being served: its upstream did not pass \
                             the genesis hash check. Requests for it answer unavailable; the check \
                             is repeated until it passes"
                        );
                        false
                    }
                }
            });
        futures::future::join_all(checks)
            .await
            .into_iter()
            .all(|verified| verified)
    }

    /// Check every chain's identity in the background, again and again until all pass or the
    /// relay stops. Startup waits only briefly for the first round, so a healthy upstream is
    /// verified before the first request and a dead one never holds the relay up.
    async fn start_verifying(self: &Arc<Self>) {
        let runtime = Arc::downgrade(self);
        let (first_round, first_round_done) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut first_round = Some(first_round);
            loop {
                let Some(runtime) = runtime.upgrade() else {
                    return;
                };
                let all_verified = runtime.verify_unverified_chains().await;
                drop(runtime);
                if let Some(first_round) = first_round.take() {
                    let _ = first_round.send(());
                }
                if all_verified {
                    return;
                }
                tokio::time::sleep(IDENTITY_RETRY).await;
            }
        });
        let _ = tokio::time::timeout(STARTUP_WAIT, first_round_done).await;
    }

    /// Refuse a request for a chain whose upstream has not proved its identity.
    fn require_verified(
        &self,
        verified: &std::sync::atomic::AtomicBool,
    ) -> Result<(), RpcRejection> {
        if verified.load(std::sync::atomic::Ordering::Relaxed) {
            Ok(())
        } else {
            Err(rpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "rpc_upstream_unavailable",
            ))
        }
    }
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

fn validate_call(call: &Value) -> Result<CallCost, RpcRejection> {
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
        "getGenesisHash"
            | "getLatestBlockhash"
            | "getBalance"
            | "getAccountInfo"
            | "getMultipleAccounts"
            | "getSignatureStatuses"
            | "getTransaction"
            | "getSignaturesForAddress"
            | "getSlot"
            | "getBlock"
            | "getBlockHeight"
            | "getFeeForMessage"
            | "getEpochInfo"
            | "getVersion"
            | "getHealth"
            | "simulateTransaction"
            | "sendTransaction"
            | "getTokenAccountsByOwner"
            | "getTokenAccountBalance"
            | "getTokenLargestAccounts"
            | "getTokenSupply"
            | "getMinimumBalanceForRentExemption"
            | "getRecentPrioritizationFees"
    );
    if !allowed {
        return Err(rpc_error(StatusCode::FORBIDDEN, "rpc_method_denied"));
    }

    let params = object.get("params").unwrap_or(&Value::Null);

    // Validate parameters for bounded consumption
    match method {
        "getMultipleAccounts" | "getSignatureStatuses" => {
            if let Some(params_arr) = params.as_array() {
                if let Some(first) = params_arr.first() {
                    if let Some(accounts) = first.as_array() {
                        if accounts.len() > MAX_ACCOUNTS_IN_BATCH_QUERY {
                            return Err(rpc_error(
                                StatusCode::BAD_REQUEST,
                                "rpc_batch_limit_exceeded",
                            ));
                        }
                    }
                }
            }
        }
        "getSignaturesForAddress" => {
            if let Some(params_arr) = params.as_array() {
                if let Some(second) = params_arr.get(1) {
                    if let Some(config_obj) = second.as_object() {
                        if let Some(limit) = config_obj.get("limit").and_then(Value::as_u64) {
                            if limit > MAX_SIGNATURES_LIMIT {
                                return Err(rpc_error(
                                    StatusCode::BAD_REQUEST,
                                    "rpc_signature_limit_exceeded",
                                ));
                            }
                        }
                    }
                }
            }
        }
        "sendTransaction" => {
            if let Some(params_arr) = params.as_array() {
                if let Some(tx_str) = params_arr.first().and_then(Value::as_str) {
                    if tx_str.len() > MAX_WIRE_TRANSACTION_CHARS {
                        return Err(rpc_error(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "rpc_transaction_too_large",
                        ));
                    }
                }
            }
        }
        "getTokenAccountsByOwner" => {
            if let Some(params_arr) = params.as_array() {
                if params_arr.len() > 3 {
                    return Err(rpc_error(
                        StatusCode::BAD_REQUEST,
                        "invalid_token_accounts_params",
                    ));
                }
                if let Some(owner) = params_arr.first().and_then(Value::as_str) {
                    if owner.len() > 50 {
                        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_owner_address"));
                    }
                }
            }
        }
        "getTokenAccountBalance" => {
            if let Some(params_arr) = params.as_array() {
                if params_arr.len() > 2 {
                    return Err(rpc_error(
                        StatusCode::BAD_REQUEST,
                        "invalid_token_account_balance_params",
                    ));
                }
                if let Some(account) = params_arr.first().and_then(Value::as_str) {
                    if account.len() > 50 {
                        return Err(rpc_error(
                            StatusCode::BAD_REQUEST,
                            "invalid_account_address",
                        ));
                    }
                }
            }
        }
        "getTokenLargestAccounts" | "getTokenSupply" => {
            if let Some(params_arr) = params.as_array() {
                if params_arr.len() > 2 {
                    return Err(rpc_error(
                        StatusCode::BAD_REQUEST,
                        "invalid_token_supply_params",
                    ));
                }
                if let Some(mint) = params_arr.first().and_then(Value::as_str) {
                    if mint.len() > 50 {
                        return Err(rpc_error(StatusCode::BAD_REQUEST, "invalid_mint_address"));
                    }
                }
            }
        }
        "getMinimumBalanceForRentExemption" => {
            if let Some(params_arr) = params.as_array() {
                if params_arr.len() > 2 {
                    return Err(rpc_error(
                        StatusCode::BAD_REQUEST,
                        "invalid_rent_exemption_params",
                    ));
                }
                if let Some(size) = params_arr.first().and_then(Value::as_u64) {
                    if size > 10_000_000 {
                        return Err(rpc_error(
                            StatusCode::BAD_REQUEST,
                            "rent_exemption_size_limit_exceeded",
                        ));
                    }
                }
            }
        }
        "getRecentPrioritizationFees" => {
            if let Some(params_arr) = params.as_array() {
                if let Some(first) = params_arr.first() {
                    if let Some(accounts) = first.as_array() {
                        if accounts.len() > MAX_ACCOUNTS_IN_BATCH_QUERY {
                            return Err(rpc_error(
                                StatusCode::BAD_REQUEST,
                                "rpc_batch_limit_exceeded",
                            ));
                        }
                    }
                }
            }
        }
        _ => {}
    }

    let cost = match method {
        "getGenesisHash"
        | "getLatestBlockhash"
        | "getSlot"
        | "getBlockHeight"
        | "getEpochInfo"
        | "getVersion"
        | "getHealth"
        | "getMinimumBalanceForRentExemption" => CallCost {
            units: 1,
            anonymous: true,
            broadcast: false,
        },
        "getBalance"
        | "getAccountInfo"
        | "getSignatureStatuses"
        | "getTransaction"
        | "getFeeForMessage"
        | "getTokenAccountBalance"
        | "getTokenSupply"
        | "getRecentPrioritizationFees" => CallCost {
            units: 2,
            anonymous: true,
            broadcast: false,
        },
        "getMultipleAccounts"
        | "getSignaturesForAddress"
        | "getTokenAccountsByOwner"
        | "getTokenLargestAccounts" => CallCost {
            units: 5,
            anonymous: true,
            broadcast: false,
        },
        "getBlock" => CallCost {
            units: 10,
            anonymous: false,
            broadcast: false,
        },
        "simulateTransaction" => CallCost {
            units: 20,
            anonymous: false,
            broadcast: false,
        },
        "sendTransaction" => CallCost {
            units: 20,
            anonymous: true,
            broadcast: true,
        },
        _ => unreachable!("allowlist checked above"),
    };
    Ok(cost)
}

fn validate_body(
    runtime: &SolanaProxyRuntime,
    _chain: &SolanaChain,
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
    let calls: Vec<&Value> = match &value {
        Value::Array(items) if !items.is_empty() && items.len() <= runtime.max_batch_len => {
            items.iter().collect()
        }
        Value::Array(_) => {
            return Err(rpc_error(StatusCode::BAD_REQUEST, "rpc_batch_limit"));
        }
        object => vec![object],
    };
    let mut total_units = 0u32;
    let mut all_anonymous = true;
    let mut contains_broadcast = false;
    for call in calls {
        let cost = validate_call(call)?;
        total_units = total_units.saturating_add(cost.units);
        all_anonymous &= cost.anonymous;
        contains_broadcast |= cost.broadcast;
    }
    Ok(CallCost {
        units: total_units.max(1),
        anonymous: all_anonymous,
        broadcast: contains_broadcast,
    })
}

pub(crate) async fn issue_rpc_challenge(
    chain_id: String,
    headers: HeaderMap,
    server: RegistryServer,
    body: Bytes,
) -> Result<Json<RpcChallengeBody>, RpcRejection> {
    let runtime = server
        .solana_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let chain = runtime
        .chains
        .get(&chain_id)
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    validate_body(runtime, chain, &body)?;
    let customer = parse_customer(&headers)?
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_failed"))?;
    let binding = RpcBinding {
        customer,
        chain: chain_id.clone(),
        body_sha256: body_hash(&body),
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
        chain: chain_id,
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
        .solana_proxy
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
        .solana_proxy
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
    Ok(Json(RpcCapabilityBody {
        rpc_path: Some(format!("/chain-rpc/{chain_id}/cap/{token}/rpc")),
        chronik_path: None,
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
        .solana_proxy
        .as_deref()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let chain = runtime
        .chains
        .get(&chain_id)
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let cost = validate_body(runtime, chain, &body)?;
    runtime
        .require_verified(&chain.verified)
        .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?;
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
            authenticate(
                &headers,
                &server,
                &runtime.auth,
                &runtime.network_tag,
                &binding,
            )
            .map_err(|error| preflight_broadcast_error(error, cost.broadcast))?;
        }
        runtime
            .customer_quota
            .charge(customer, cost.units, unix_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", cost.broadcast, denial))?;
    } else {
        if !cost.anonymous {
            return Err(preflight_broadcast_error(
                rpc_error(StatusCode::UNAUTHORIZED, "rpc_auth_required"),
                cost.broadcast,
            ));
        }
        let peer_ip =
            peer_ip(peer).map_err(|error| preflight_broadcast_error(error, cost.broadcast))?;
        runtime
            .anonymous_quota
            .charge(peer_ip, cost.units, unix_seconds())
            .map_err(|denial| quota_error("rpc_hourly_quota", cost.broadcast, denial))?;
    }

    let deadline = tokio::time::Instant::now() + runtime.timeout;
    let ordered_upstreams = runtime.cooldowns.splay_order(&chain.upstream_urls);
    if ordered_upstreams.is_empty() {
        return Err(broadcast_error(
            StatusCode::BAD_GATEWAY,
            "rpc_upstream_unavailable",
            cost.broadcast,
            true,
        ));
    }
    let mut last_error = None;
    let mut spool = None;

    for (attempt, upstream_url) in ordered_upstreams.iter().enumerate() {
        let remaining_time = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining_time.is_zero() {
            return Err(broadcast_error(
                StatusCode::GATEWAY_TIMEOUT,
                "rpc_upstream_timeout",
                cost.broadcast,
                true,
            ));
        }

        let upstream = async {
            let response = runtime
                .client
                .post((*upstream_url).clone())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone())
                .send()
                .await
                .map_err(|_| {
                    runtime.cooldowns.mark_failure(upstream_url);
                    broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        cost.broadcast,
                        true,
                    )
                })?;
            let status = response.status();
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                runtime.cooldowns.mark_failure(upstream_url);
                if attempt + 1 < ordered_upstreams.len() {
                    return Err(broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_unavailable",
                        cost.broadcast,
                        true,
                    ));
                }
            } else {
                runtime.cooldowns.mark_success(upstream_url);
            }
            super::json_rpc::spool_response(response, runtime.max_response_bytes, remaining_time)
                .await
                .map_err(|error| match error {
                    super::json_rpc::SpoolError::TooLarge => broadcast_error(
                        StatusCode::BAD_GATEWAY,
                        "rpc_upstream_response_too_large",
                        cost.broadcast,
                        true,
                    ),
                    super::json_rpc::SpoolError::Timeout => {
                        runtime.cooldowns.mark_failure(upstream_url);
                        broadcast_error(
                            StatusCode::GATEWAY_TIMEOUT,
                            "rpc_upstream_timeout",
                            cost.broadcast,
                            true,
                        )
                    }
                    super::json_rpc::SpoolError::Io => {
                        runtime.cooldowns.mark_failure(upstream_url);
                        broadcast_error(
                            StatusCode::BAD_GATEWAY,
                            "rpc_upstream_unavailable",
                            cost.broadcast,
                            true,
                        )
                    }
                })
        };

        match tokio::time::timeout_at(deadline, upstream).await {
            Ok(Ok(s)) => {
                spool = Some(s);
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
                    cost.broadcast,
                    true,
                ));
            }
        }
    }

    let spool = match spool {
        Some(s) => s,
        None => {
            return Err(last_error.unwrap_or_else(|| {
                broadcast_error(
                    StatusCode::BAD_GATEWAY,
                    "rpc_upstream_unavailable",
                    cost.broadcast,
                    true,
                )
            }));
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{body::Body, http::Request, routing, Router};
    use bitcoinsuite_core::Net;
    use cashweb_config::SolanaProxyChainConf;
    use tempdir::TempDir;
    use tower::ServiceExt;

    use crate::{
        disabled_chain_adapter::DisabledChainAdapter, http::pop_protection::PopGate,
        p2p::peers::Peers, registry::Registry, store::db::Db, test_instance::placeholder_pop_conf,
    };

    #[tokio::test]
    async fn startup_verification_succeeds_on_matching_genesis_hash() {
        let genesis_hash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
        let mock_server = Router::new().route(
            "/",
            routing::post(move || async move {
                Json(json!({
                    "jsonrpc": "2.0",
                    "result": genesis_hash,
                    "id": "startup"
                }))
            }),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(mock_server.into_make_service()),
        );

        let conf = SolanaProxyConf {
            enabled: true,
            chains: vec![SolanaProxyChainConf {
                id: "solana-devnet".to_string(),
                upstream_env: "SOLANA_DEVNET_RPC".to_string(),
                upstream_envs: vec![],
                expected_genesis_hash: genesis_hash.to_string(),
            }],
            ..SolanaProxyConf::default()
        };
        let upstream_url = format!("http://{addr}");
        let runtime =
            SolanaProxyRuntime::from_conf_with_env(&conf, vec![], |_| Some(upstream_url.clone()))
                .await
                .unwrap()
                .expect("must start");
        assert!(runtime.has_chain("solana-devnet"));
        assert_eq!(runtime.chain_ids(), vec!["solana-devnet"]);
    }

    const DEVNET: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    const MAINNET: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

    /// A node of the chain with this genesis hash. `forwarded` counts every call other than
    /// the identity check.
    fn node(genesis_hash: &'static str, forwarded: Arc<AtomicUsize>) -> Router {
        Router::new().route(
            "/",
            routing::post(move |Json(call): Json<Value>| async move {
                let result = if call["method"] == "getGenesisHash" {
                    json!(genesis_hash)
                } else {
                    forwarded.fetch_add(1, Ordering::SeqCst);
                    json!(7)
                };
                Json(json!({"jsonrpc": "2.0", "result": result, "id": call["id"]}))
            }),
        )
    }
    fn serve(listener: std::net::TcpListener, router: Router) {
        listener.set_nonblocking(true).unwrap();
        tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service()),
        );
    }
    fn chain(id: &str, env: &str, genesis_hash: &str) -> SolanaProxyChainConf {
        SolanaProxyChainConf {
            id: id.to_string(),
            upstream_env: env.to_string(),
            upstream_envs: vec![],
            expected_genesis_hash: genesis_hash.to_string(),
        }
    }
    /// A relay with this proxy and nothing else, and a way to ask it for the slot of `chain`.
    fn relay_with(runtime: Arc<SolanaProxyRuntime>) -> (Router, impl Fn(&str) -> Request<Body>) {
        let tempdir = TempDir::new("cashweb-registry--solana-startup").unwrap();
        let registry = Registry::new(
            Db::open(tempdir.path().join("db.rocksdb")).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        );
        let event_bus = registry.event_bus().clone();
        let auth = Arc::clone(&runtime);
        let router = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(PopGate::from_conf_if_enabled(&placeholder_pop_conf())),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
            solana_proxy: Some(runtime),
            spa_dir: None,
            event_bus,
        }
        .into_router();
        let slot = move |chain: &str| {
            let _keep = &tempdir;
            let (capability, _) =
                auth.auth
                    .issue_capability(Address([7; 20]), chain, now_ms(), 60 * 60 * 1000);
            Request::post(format!("/chain-rpc/{chain}/cap/{capability}/rpc"))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}"#,
                ))
                .unwrap()
        };
        (router, slot)
    }
    async fn error_code(response: Response) -> Value {
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        serde_json::from_slice::<Value>(&body).unwrap()["error"].clone()
    }

    #[tokio::test]
    async fn an_upstream_down_at_startup_leaves_only_its_chain_unserved_until_it_answers() {
        let forwarded = Arc::new(AtomicUsize::new(0));
        let up = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let up_url = format!("http://{}", up.local_addr().unwrap());
        serve(up, node(DEVNET, Arc::clone(&forwarded)));
        // Nothing listens at the second chain's upstream yet.
        let down = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let down_address = down.local_addr().unwrap();
        drop(down);
        let down_url = format!("http://{down_address}");
        let conf = SolanaProxyConf {
            enabled: true,
            chains: vec![
                chain("solana-devnet", "UP", DEVNET),
                chain("solana-mainnet", "DOWN", MAINNET),
            ],
            ..SolanaProxyConf::default()
        };
        // The relay starts.
        let runtime = SolanaProxyRuntime::from_conf_with_env(&conf, vec![], |name| {
            Some(if name == "UP" {
                up_url.clone()
            } else {
                down_url.clone()
            })
        })
        .await
        .unwrap()
        .unwrap();
        let (router, slot) = relay_with(runtime);
        // The chain whose upstream answers is served; the other answers unavailable.
        let served = router.clone().oneshot(slot("solana-devnet")).await.unwrap();
        assert_eq!(served.status(), StatusCode::OK);
        let unserved = router
            .clone()
            .oneshot(slot("solana-mainnet"))
            .await
            .unwrap();
        assert_eq!(unserved.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(unserved).await, "rpc_upstream_unavailable");
        assert_eq!(forwarded.load(Ordering::SeqCst), 1);

        // Its upstream comes up; the repeated check finds it and the chain is served.
        serve(
            std::net::TcpListener::bind(down_address).unwrap(),
            node(MAINNET, Arc::clone(&forwarded)),
        );
        let mut status = StatusCode::SERVICE_UNAVAILABLE;
        for _ in 0..100 {
            status = router
                .clone()
                .oneshot(slot("solana-mainnet"))
                .await
                .unwrap()
                .status();
            if status == StatusCode::OK {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn an_upstream_that_is_another_chain_is_never_forwarded_to() {
        let forwarded = Arc::new(AtomicUsize::new(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        // The upstream answers, as mainnet, where devnet is configured.
        serve(listener, node(MAINNET, Arc::clone(&forwarded)));
        let conf = SolanaProxyConf {
            enabled: true,
            chains: vec![chain("solana-devnet", "URL", DEVNET)],
            ..SolanaProxyConf::default()
        };
        let runtime = SolanaProxyRuntime::from_conf_with_env(&conf, vec![], |_| Some(url.clone()))
            .await
            .unwrap()
            .unwrap();
        let (router, slot) = relay_with(runtime);
        // Refused now, and still refused after the check has been repeated several times.
        for _ in 0..2 {
            let refused = router.clone().oneshot(slot("solana-devnet")).await.unwrap();
            assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error_code(refused).await, "rpc_upstream_unavailable");
            tokio::time::sleep(IDENTITY_RETRY * 5).await;
        }
        assert_eq!(forwarded.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn startup_verification_multi_upstream_loads_and_verifies_all() {
        let genesis_hash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
        let make_server = || {
            Router::new().route(
                "/",
                routing::post(move || async move {
                    Json(json!({
                        "jsonrpc": "2.0",
                        "result": genesis_hash,
                        "id": "startup"
                    }))
                }),
            )
        };
        let l1 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr1 = l1.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(l1)
                .unwrap()
                .serve(make_server().into_make_service()),
        );

        let l2 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr2 = l2.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(l2)
                .unwrap()
                .serve(make_server().into_make_service()),
        );

        let conf = SolanaProxyConf {
            enabled: true,
            chains: vec![SolanaProxyChainConf {
                id: "solana-devnet".to_string(),
                upstream_env: "SOLANA_RPC_1".to_string(),
                upstream_envs: vec!["SOLANA_RPC_2".to_string()],
                expected_genesis_hash: genesis_hash.to_string(),
            }],
            ..SolanaProxyConf::default()
        };
        let u1 = format!("http://{addr1}");
        let u2 = format!("http://{addr2}");
        let runtime = SolanaProxyRuntime::from_conf_with_env(&conf, vec![], |name| match name {
            "SOLANA_RPC_1" => Some(u1.clone()),
            "SOLANA_RPC_2" => Some(u2.clone()),
            _ => None,
        })
        .await
        .unwrap()
        .expect("must start");

        let chain = runtime.chains.get("solana-devnet").unwrap();
        assert_eq!(chain.upstream_urls.len(), 2);
    }

    #[test]
    fn validate_call_allowlist_and_restrictions() {
        // Allowed read methods
        for method in [
            "getGenesisHash",
            "getLatestBlockhash",
            "getBalance",
            "getAccountInfo",
            "getSlot",
            "getBlockHeight",
            "getFeeForMessage",
            "getEpochInfo",
            "getVersion",
            "getHealth",
            "getTokenAccountsByOwner",
            "getTokenAccountBalance",
            "getTokenLargestAccounts",
            "getTokenSupply",
            "getMinimumBalanceForRentExemption",
            "getRecentPrioritizationFees",
        ] {
            let call = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": []
            });
            let cost = validate_call(&call).expect(method);
            assert!(cost.anonymous);
            assert!(!cost.broadcast);
        }

        // Send transaction is broadcast and anonymous
        let send_tx = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": ["dGVzdA=="]
        });
        let cost = validate_call(&send_tx).unwrap();
        assert!(cost.broadcast);
        assert!(cost.anonymous);

        // Heavy getBlock requires authentication (anonymous: false)
        let get_block = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBlock",
            "params": [12345]
        });
        let cost = validate_call(&get_block).unwrap();
        assert!(!cost.anonymous);

        // Forbidden method
        let forbidden = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "requestAirdrop",
            "params": []
        });
        assert_eq!(
            validate_call(&forbidden).unwrap_err().status(),
            StatusCode::FORBIDDEN
        );
    }
}
