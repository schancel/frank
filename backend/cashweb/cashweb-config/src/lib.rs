//! Crate for parsing configuration for cashweb, registry etc.

#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

use std::{
    collections::HashSet, error::Error, fmt, net::SocketAddr, path::PathBuf, sync::OnceLock,
};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClientConf;
use bitcoinsuite_core::Net;
use bitcoinsuite_error::Result;
use serde::{Deserialize, Serialize};

const PROTOCOL_CHAIN_REGISTRY_V1: &str = include_str!("../../../../docs/protocol/chains/v1.json");

/// Versioned protocol registry used by clients and relay family dispatch.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolChainRegistry {
    /// Registry schema version.
    pub schema_version: u32,
    /// Canonical chain rows.
    pub chains: Vec<ProtocolChainDescriptor>,
}

/// One canonical protocol chain identifier and its permitted proxy surface.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolChainDescriptor {
    /// Stable Frank identifier used in URLs and signed scopes.
    pub id: String,
    /// Handler family selected by the relay.
    pub family: ProtocolChainFamily,
    /// Human-readable network class.
    pub network: String,
    /// Optional CAIP-2 alias when it identifies this network without ambiguity.
    pub caip2: Option<String>,
    /// Optional native chain ID, represented as decimal text to avoid JSON integer limits.
    pub native_chain_id: Option<String>,
    /// Proxy capabilities this chain is permitted to expose.
    pub allowed_proxy_capabilities: Vec<ProtocolProxyCapability>,
    /// Required probes that bind an upstream to this exact protocol chain.
    pub identity_probes: Vec<ProtocolIdentityProbe>,
}

/// One machine-readable upstream identity requirement.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProtocolIdentityProbe {
    /// Require the EVM upstream to report this decimal EIP-155 chain ID.
    EvmChainId {
        /// Proxy capability whose upstream is probed.
        capability: ProtocolProxyCapability,
        /// Expected decimal EIP-155 chain ID.
        expected: String,
    },
    /// Require the upstream block hash at a protocol-pinned height.
    BlockHash {
        /// Proxy capability whose upstream is probed.
        capability: ProtocolProxyCapability,
        /// Block height to probe.
        height: u64,
        /// Expected lowercase `0x`-prefixed block hash.
        expected: String,
    },
    /// Require the operator configuration to provide a block checkpoint.
    OperatorBlockCheckpoint {
        /// Proxy capability whose upstream is probed.
        capability: ProtocolProxyCapability,
    },
}

impl ProtocolIdentityProbe {
    fn capability(&self) -> ProtocolProxyCapability {
        match self {
            Self::EvmChainId { capability, .. }
            | Self::BlockHash { capability, .. }
            | Self::OperatorBlockCheckpoint { capability } => *capability,
        }
    }
}

/// Relay proxy handler family.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolChainFamily {
    /// Ethereum-compatible JSON-RPC.
    Evm,
    /// Bitcoin-family node JSON-RPC and optional Chronik.
    Bitcoin,
}

/// Capability names advertised by chain discovery.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtocolProxyCapability {
    /// Allowlisted JSON-RPC.
    JsonRpc,
    /// Bitcoin-family Chronik HTTP/Protobuf API.
    Chronik,
}

/// Return the compiled protocol chain registry.
pub fn protocol_chain_registry() -> &'static ProtocolChainRegistry {
    static REGISTRY: OnceLock<ProtocolChainRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let registry: ProtocolChainRegistry = serde_json::from_str(PROTOCOL_CHAIN_REGISTRY_V1)
            .expect("checked-in protocol chain registry must be valid JSON");
        assert_eq!(
            registry.schema_version, 1,
            "unsupported chain registry schema"
        );
        let mut ids = HashSet::new();
        let mut aliases = HashSet::new();
        for chain in &registry.chains {
            assert!(ids.insert(chain.id.as_str()), "duplicate protocol chain id");
            assert!(
                !chain.id.is_empty()
                    && chain.id.len() <= 64
                    && chain.id.bytes().all(|byte| byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || byte == b'-'),
                "unsafe protocol chain id"
            );
            assert!(
                matches!(chain.network.as_str(), "mainnet" | "testnet" | "regtest"),
                "unsupported protocol network"
            );
            if let Some(alias) = &chain.caip2 {
                assert!(
                    !alias.is_empty() && aliases.insert(alias.as_str()),
                    "empty or duplicate CAIP-2 alias"
                );
            }
            assert!(!chain.allowed_proxy_capabilities.is_empty());
            assert_eq!(
                chain
                    .allowed_proxy_capabilities
                    .iter()
                    .copied()
                    .collect::<HashSet<_>>()
                    .len(),
                chain.allowed_proxy_capabilities.len(),
                "duplicate protocol capability"
            );
            assert!(chain.allowed_proxy_capabilities.iter().all(|capability| {
                *capability == ProtocolProxyCapability::JsonRpc
                    || chain.family == ProtocolChainFamily::Bitcoin
            }));
            assert!(!chain.identity_probes.is_empty());
            assert_eq!(
                chain
                    .identity_probes
                    .iter()
                    .cloned()
                    .collect::<HashSet<_>>()
                    .len(),
                chain.identity_probes.len(),
                "duplicate protocol identity probe"
            );
            assert!(chain.identity_probes.iter().all(|probe| chain
                .allowed_proxy_capabilities
                .contains(&probe.capability())));
            match chain.family {
                ProtocolChainFamily::Evm => {
                    let native_chain_id = chain
                        .native_chain_id
                        .as_deref()
                        .expect("EVM registry row must have a native chain ID");
                    assert!(chain.identity_probes.iter().any(|probe| matches!(
                        probe,
                        ProtocolIdentityProbe::EvmChainId { capability: ProtocolProxyCapability::JsonRpc, expected }
                            if expected == native_chain_id
                    )));
                    let expected_caip2 = format!("eip155:{native_chain_id}");
                    assert_eq!(
                        chain.caip2.as_deref(),
                        Some(expected_caip2.as_str()),
                        "EVM CAIP-2 alias contradicts native chain ID"
                    );
                    assert!(chain.identity_probes.iter().any(|probe| matches!(
                        probe,
                        ProtocolIdentityProbe::BlockHash { capability: ProtocolProxyCapability::JsonRpc, .. }
                    )));
                }
                ProtocolChainFamily::Bitcoin => {
                    assert!(chain.allowed_proxy_capabilities.iter().all(|capability| chain
                        .identity_probes
                        .iter()
                        .any(|probe| probe.capability() == *capability)));
                    if chain.network != "regtest" {
                        assert!(chain.allowed_proxy_capabilities.iter().all(|capability| chain
                            .identity_probes
                            .iter()
                            .any(|probe| matches!(probe, ProtocolIdentityProbe::BlockHash { capability: probe_capability, expected, .. }
                                if probe_capability == capability
                                    && expected.len() == 64
                                    && expected.bytes().all(|byte| byte.is_ascii_hexdigit())))));
                    }
                }
            }
        }
        registry
    })
}

/// Look up one stable protocol chain identifier.
pub fn protocol_chain(id: &str) -> Option<&'static ProtocolChainDescriptor> {
    protocol_chain_registry()
        .chains
        .iter()
        .find(|chain| chain.id == id)
}

/// Configuration of a cashwebd instance
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CashwebdConf {
    /// Where to bind the cashwebd server to
    pub host: SocketAddr,
    /// Under what URL we advertise ourselves to the outside world
    pub url: url::Url,
    /// Registry configuration
    pub registry: RegistryConf,
    /// Bitcoin/Lotus JSON-RPC configuration. Omit for a Monad-only server; legacy Lotus routes
    /// then fail closed while Monad routes remain available.
    #[serde(default)]
    pub bitcoin_rpc: Option<BitcoindRpcClientConf>,
}

/// Configuration for a registry server
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct RegistryConf {
    /// Path where the Registry's RocksDB database is stored.
    pub db_path: PathBuf,
    /// Open directory: this relay's own tuple and publishing limits. Omitted keeps the
    /// directory and canonical message routes disabled.
    #[serde(default)]
    pub directory: Option<DirectoryConf>,
    /// Whether we are on mainnet or regtest net.
    /// This is relevant for address parsing.
    pub net: Net,
    /// Peers this registry it connected to.
    pub peers: Vec<url::Url>,
    /// Explicit public relay origins advertised to unauthenticated clients. Operational peers are
    /// never inferred to be public.
    #[serde(default)]
    pub public_relay_urls: Vec<url::Url>,
    /// How to initally download metadata from peers
    #[serde(default)]
    pub imd: InitialMetadataDownloadConf,
    /// POP (proof-of-payment) protection config for the metadata-put endpoint (ticket #4).
    pub pop: PopConf,
    /// Durable Monad mailbox admission/reconciliation lifecycle. This is required so disabled is
    /// an explicit operator choice rather than an accidental missing RPC environment variable.
    pub monad_mailbox: MonadMailboxConf,
    /// Customer-authenticated, allowlisted EVM JSON-RPC proxy. Omitted means disabled so old
    /// operator configurations do not acquire a new network surface on upgrade.
    #[serde(default)]
    pub evm_rpc: EvmRpcConf,
    /// Bitcoin-family JSON-RPC and Chronik proxy. Omitted means disabled.
    #[serde(default)]
    pub bitcoin_proxy: BitcoinProxyConf,
    /// Operator-curated default contacts advertised to fresh clients (ticket #49). Empty by
    /// default -- unlike `PopConf` this is display-only config with no security implications, so
    /// (unlike `pop`) it's safe to default to "none" rather than requiring an explicit value.
    #[serde(default)]
    pub curated_defaults: Vec<CuratedContactConf>,
}

/// The open directory: accounts publish their own signed entries, the relay only names itself.
///
/// There is no per-account configuration. `clock_file` and `principals` from the earlier
/// operator-installed design are still recognised so an old file fails with a clear message
/// instead of an unknown-field error; see [`DirectoryConf::validate`].
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DirectoryConf {
    /// Exact protocol network this relay accepts entries for, e.g. `monad-testnet`.
    #[serde(default)]
    pub network: String,
    /// This relay's 16-byte identifier, lowercase hex.
    #[serde(default)]
    pub relay_id: String,
    /// This relay's compressed secp256k1 public key, lowercase hex.
    #[serde(default)]
    pub relay_identity: String,
    /// This relay's public HTTPS origin, without a trailing slash.
    #[serde(default)]
    pub endpoint: String,
    /// When the relay tuple above stops being valid, as decimal Unix nanoseconds. Entries
    /// cannot outlive it, so set it comfortably in the future.
    #[serde(default)]
    pub binding_expiry_ns: String,
    /// Most accounts that live on this relay.
    #[serde(default = "default_directory_max_subjects")]
    pub max_subjects: u64,
    /// Most keys of accounts that live on other relays this relay will hold copies of. A
    /// separate budget, so copies from peers cannot block sign-ups here.
    #[serde(default = "default_directory_max_subjects")]
    pub max_replicated_subjects: u64,
    /// Accept a message for a recipient on another relay and forward it there.
    #[serde(default = "default_true")]
    pub forwarding: bool,
    /// Seconds between rounds of comparing entries with peers and retrying forwards.
    #[serde(default = "default_directory_sync_interval_s")]
    pub sync_interval_s: u64,
    /// First-time publications accepted from one source address per clock hour.
    #[serde(default = "default_directory_enrollments_per_source_per_hour")]
    pub enrollments_per_source_per_hour: u32,
    /// Addresses of reverse proxies in front of this relay. Only a connection from one of
    /// these may say, in the last element of `x-forwarded-for`, which client it is for; the
    /// proxy must append that element itself. Empty: the connecting address is the client.
    #[serde(default)]
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// Removed. Present only to explain the change to operators with an old file.
    #[serde(default, skip_serializing)]
    pub clock_file: Option<RemovedSetting>,
    /// Removed. Present only to explain the change to operators with an old file.
    #[serde(default, skip_serializing)]
    pub principals: Option<RemovedSetting>,
}

const fn default_directory_max_subjects() -> u64 {
    1_000_000
}

const fn default_true() -> bool {
    true
}

const fn default_directory_sync_interval_s() -> u64 {
    30
}

const fn default_directory_enrollments_per_source_per_hour() -> u32 {
    30
}

/// Placeholder that accepts any value of a setting which no longer exists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RemovedSetting;

impl<'de> Deserialize<'de> for RemovedSetting {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(deserializer).map(|_| Self)
    }
}

impl Serialize for RemovedSetting {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_unit()
    }
}

/// Why a `[registry.directory]` section cannot be used.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectoryConfError {
    /// The file still carries the operator-installed account list or clock file.
    RemovedSettings,
    /// A required relay field is absent.
    Missing(&'static str),
}

impl fmt::Display for DirectoryConfError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RemovedSettings => formatter.write_str(
                "registry.directory.clock_file and [[registry.directory.principals]] were \
                 removed: accounts now publish their own directory entries and the relay uses \
                 the system clock. Delete them and keep only network, relay_id, relay_identity, \
                 endpoint and binding_expiry_ns",
            ),
            Self::Missing(field) => write!(formatter, "registry.directory.{field} is required"),
        }
    }
}

impl Error for DirectoryConfError {}

impl DirectoryConf {
    /// Reject old operator-installed files and incomplete relay tuples with a plain message.
    pub fn validate(&self) -> Result<(), DirectoryConfError> {
        if self.clock_file.is_some() || self.principals.is_some() {
            return Err(DirectoryConfError::RemovedSettings);
        }
        for (field, value) in [
            ("network", &self.network),
            ("relay_id", &self.relay_id),
            ("relay_identity", &self.relay_identity),
            ("endpoint", &self.endpoint),
            ("binding_expiry_ns", &self.binding_expiry_ns),
        ] {
            if value.is_empty() {
                return Err(DirectoryConfError::Missing(field));
            }
        }
        Ok(())
    }
}

/// Invalid resource relationship spanning multiple registry proxy families.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryConfigError {
    /// A configured concurrency-and-size product exceeds the process ceiling.
    InvalidLimit(&'static str),
}

impl fmt::Display for RegistryConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit(limit) => write!(formatter, "invalid registry limit: {limit}"),
        }
    }
}

impl Error for RegistryConfigError {}

impl RegistryConf {
    /// Validate process-wide resource bounds shared by otherwise independent proxy families.
    pub fn validate_rpc_resource_limits(&self) -> Result<(), RegistryConfigError> {
        let family_bytes = |enabled: bool, response: usize, concurrency: usize| {
            if enabled {
                response.checked_mul(concurrency)
            } else {
                Some(0)
            }
        };
        let evm = family_bytes(
            self.evm_rpc.enabled,
            self.evm_rpc.max_response_bytes,
            self.evm_rpc.max_concurrency,
        );
        let bitcoin = family_bytes(
            self.bitcoin_proxy.enabled,
            self.bitcoin_proxy.max_response_bytes,
            self.bitcoin_proxy.max_concurrency,
        );
        if evm
            .and_then(|evm| bitcoin.and_then(|bitcoin| evm.checked_add(bitcoin)))
            .map_or(true, |bytes| bytes > MAX_AGGREGATE_RPC_RESPONSE_BYTES)
        {
            return Err(RegistryConfigError::InvalidLimit(
                "aggregate RPC response bytes",
            ));
        }
        Ok(())
    }
}

/// Relay-owned EVM JSON-RPC proxy configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct EvmRpcConf {
    /// Whether the relay installs EVM `/chain-rpc/:chain/rpc` routes.
    #[serde(default)]
    pub enabled: bool,
    /// Chain rows served by the single EVM-family handler.
    #[serde(default)]
    pub chains: Vec<EvmRpcChainConf>,
    /// Maximum accepted request body, before JSON parsing.
    #[serde(default = "default_rpc_request_bytes")]
    pub max_request_bytes: usize,
    /// Maximum number of calls in one JSON-RPC batch.
    #[serde(default = "default_rpc_batch_len")]
    pub max_batch_len: usize,
    /// Maximum accepted upstream response body.
    #[serde(default = "default_rpc_response_bytes")]
    pub max_response_bytes: usize,
    /// Maximum in-flight upstream requests for this relay.
    #[serde(default = "default_rpc_concurrency")]
    pub max_concurrency: usize,
    /// Complete upstream request timeout.
    #[serde(default = "default_rpc_timeout_ms")]
    pub timeout_ms: u64,
    /// Fixed-hour quota units for an authenticated customer. Expensive methods cost more than one
    /// unit; this is deliberately a burstable quota rather than a rolling rate.
    #[serde(default = "default_evm_customer_units_per_hour")]
    pub customer_units_per_hour: u32,
    /// Fixed-hour quota units for an anonymous source IP. Zero disables anonymous EVM access.
    #[serde(default = "default_evm_anonymous_units_per_hour")]
    pub anonymous_units_per_hour: u32,
    /// Lifetime of an authenticated customer capability URL. Capability URLs are bearer
    /// credentials and should be renewed rather than stored permanently.
    #[serde(default = "default_rpc_capability_ttl_ms")]
    pub capability_ttl_ms: u64,
}

impl Default for EvmRpcConf {
    fn default() -> Self {
        Self {
            enabled: false,
            chains: vec![],
            max_request_bytes: default_rpc_request_bytes(),
            max_batch_len: default_rpc_batch_len(),
            max_response_bytes: default_rpc_response_bytes(),
            max_concurrency: default_rpc_concurrency(),
            timeout_ms: default_rpc_timeout_ms(),
            customer_units_per_hour: default_evm_customer_units_per_hour(),
            anonymous_units_per_hour: default_evm_anonymous_units_per_hour(),
            capability_ttl_ms: default_rpc_capability_ttl_ms(),
        }
    }
}

const fn default_evm_customer_units_per_hour() -> u32 {
    10_000
}

const fn default_evm_anonymous_units_per_hour() -> u32 {
    500
}

const fn default_rpc_capability_ttl_ms() -> u64 {
    60 * 60 * 1000
}

const fn default_rpc_request_bytes() -> usize {
    256 * 1024
}

const fn default_rpc_batch_len() -> usize {
    20
}

const fn default_rpc_response_bytes() -> usize {
    4 * 1024 * 1024
}

const fn default_rpc_concurrency() -> usize {
    32
}

const fn default_rpc_timeout_ms() -> u64 {
    15_000
}

const MAX_AGGREGATE_RPC_RESPONSE_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// One EVM chain row. The upstream itself is named by environment variable so provider secrets
/// are never serialized into the checked-in operator configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct EvmRpcChainConf {
    /// Stable URL path id, for example `monad-testnet`.
    pub id: String,
    /// EIP-155 chain id the upstream must report before readiness.
    pub expected_chain_id: u64,
    /// Name of the server-only environment variable containing the upstream HTTP(S) URL.
    pub upstream_env: String,
    /// Optional server-only environment variable containing the upstream WebSocket URL.
    #[serde(default)]
    pub upstream_ws_env: Option<String>,
    /// Protocol-pinned block number whose hash must match before readiness.
    pub checkpoint_block_number: Option<u64>,
    /// Protocol-pinned `0x`-prefixed 32-byte hash for `checkpoint_block_number`.
    pub checkpoint_block_hash: Option<String>,
    /// Largest inclusive explicit block range accepted by `eth_getLogs`.
    #[serde(default = "default_rpc_log_range")]
    pub max_get_logs_range: u64,
}

const fn default_rpc_log_range() -> u64 {
    10
}

/// Invalid EVM proxy configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EvmRpcConfigError {
    /// Enabled mode has no chain rows.
    MissingChains,
    /// A chain id is empty, unsafe for a path segment, or duplicated.
    InvalidChainId(String),
    /// The id is not registered as an EVM-family chain.
    WrongChainFamily(String),
    /// The configured native chain ID contradicts the protocol registry.
    NativeChainIdMismatch(String),
    /// The configured checkpoint contradicts or omits the protocol-pinned checkpoint.
    CheckpointMismatch(String),
    /// An upstream environment-variable name is empty or malformed.
    InvalidUpstreamEnv(String),
    /// A numeric protection limit is zero or exceeds its hard ceiling.
    InvalidLimit(&'static str),
}

impl fmt::Display for EvmRpcConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingChains => f.write_str("registry.evm_rpc.chains is required when enabled"),
            Self::InvalidChainId(id) => write!(f, "invalid or duplicate EVM RPC chain id {id:?}"),
            Self::WrongChainFamily(id) => write!(f, "chain id {id:?} is not registered as EVM"),
            Self::NativeChainIdMismatch(id) => {
                write!(
                    f,
                    "EVM chain id for {id:?} contradicts the protocol registry"
                )
            }
            Self::CheckpointMismatch(id) => {
                write!(
                    f,
                    "EVM checkpoint for {id:?} contradicts the protocol registry"
                )
            }
            Self::InvalidUpstreamEnv(name) => {
                write!(f, "invalid EVM RPC upstream environment name {name:?}")
            }
            Self::InvalidLimit(name) => write!(f, "invalid registry.evm_rpc limit {name}"),
        }
    }
}

impl Error for EvmRpcConfigError {}

impl EvmRpcConf {
    /// Validate the bounded, chain-as-data shape without reading environment secrets.
    pub fn validate(&self) -> std::result::Result<(), EvmRpcConfigError> {
        if !self.enabled {
            return Ok(());
        }
        if self.chains.is_empty() {
            return Err(EvmRpcConfigError::MissingChains);
        }
        if self.max_request_bytes == 0 || self.max_request_bytes > 256 * 1024 {
            return Err(EvmRpcConfigError::InvalidLimit("max_request_bytes"));
        }
        if self.max_batch_len == 0 || self.max_batch_len > 100 {
            return Err(EvmRpcConfigError::InvalidLimit("max_batch_len"));
        }
        // Responses are disk-spooled and inspected incrementally; permit a
        // single legitimate 250 MiB `eth_getLogs` result while retaining a
        // finite operator-controlled ceiling.
        if self.max_response_bytes == 0 || self.max_response_bytes > 512 * 1024 * 1024 {
            return Err(EvmRpcConfigError::InvalidLimit("max_response_bytes"));
        }
        if self.max_concurrency == 0 || self.max_concurrency > 1024 {
            return Err(EvmRpcConfigError::InvalidLimit("max_concurrency"));
        }
        if self
            .max_response_bytes
            .checked_mul(self.max_concurrency)
            .map_or(true, |bytes| bytes > MAX_AGGREGATE_RPC_RESPONSE_BYTES)
        {
            return Err(EvmRpcConfigError::InvalidLimit("aggregate response bytes"));
        }
        if self.timeout_ms == 0 || self.timeout_ms > 120_000 {
            return Err(EvmRpcConfigError::InvalidLimit("timeout_ms"));
        }
        if self.customer_units_per_hour == 0 {
            return Err(EvmRpcConfigError::InvalidLimit("customer_units_per_hour"));
        }
        if self.capability_ttl_ms < 60_000 || self.capability_ttl_ms > 24 * 60 * 60 * 1000 {
            return Err(EvmRpcConfigError::InvalidLimit("capability_ttl_ms"));
        }
        let mut ids = HashSet::new();
        for chain in &self.chains {
            let valid_id = !chain.id.is_empty()
                && chain.id.len() <= 64
                && chain
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
            if !valid_id || !ids.insert(chain.id.as_str()) {
                return Err(EvmRpcConfigError::InvalidChainId(chain.id.clone()));
            }
            let protocol = protocol_chain(&chain.id)
                .filter(|row| row.family == ProtocolChainFamily::Evm)
                .ok_or_else(|| EvmRpcConfigError::WrongChainFamily(chain.id.clone()))?;
            if protocol
                .native_chain_id
                .as_deref()
                .and_then(|id| id.parse::<u64>().ok())
                != Some(chain.expected_chain_id)
            {
                return Err(EvmRpcConfigError::NativeChainIdMismatch(chain.id.clone()));
            }
            let valid_env = !chain.upstream_env.is_empty()
                && chain.upstream_env.len() <= 128
                && chain.upstream_env.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_uppercase()
                        || byte == b'_'
                        || (index > 0 && byte.is_ascii_digit())
                });
            if !valid_env {
                return Err(EvmRpcConfigError::InvalidUpstreamEnv(
                    chain.upstream_env.clone(),
                ));
            }
            if let Some(upstream_ws_env) = &chain.upstream_ws_env {
                let valid_ws_env = !upstream_ws_env.is_empty()
                    && upstream_ws_env.len() <= 128
                    && upstream_ws_env.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_uppercase()
                            || byte == b'_'
                            || (index > 0 && byte.is_ascii_digit())
                    });
                if !valid_ws_env {
                    return Err(EvmRpcConfigError::InvalidUpstreamEnv(
                        upstream_ws_env.clone(),
                    ));
                }
            }
            if chain.expected_chain_id == 0 || chain.max_get_logs_range == 0 {
                return Err(EvmRpcConfigError::InvalidLimit("chain row"));
            }
            let (checkpoint_height, checkpoint_hash) = protocol
                .identity_probes
                .iter()
                .find_map(|probe| match probe {
                    ProtocolIdentityProbe::BlockHash {
                        capability: ProtocolProxyCapability::JsonRpc,
                        height,
                        expected,
                    } => Some((*height, expected.as_str())),
                    _ => None,
                })
                .expect("validated EVM registry row must pin a JSON-RPC checkpoint");
            if chain.checkpoint_block_number != Some(checkpoint_height)
                || chain.checkpoint_block_hash.as_deref() != Some(checkpoint_hash)
            {
                return Err(EvmRpcConfigError::CheckpointMismatch(chain.id.clone()));
            }
        }
        Ok(())
    }
}

/// Bitcoin-family JSON-RPC and Chronik proxy configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct BitcoinProxyConf {
    /// Whether any Bitcoin-family proxy route is installed.
    #[serde(default)]
    pub enabled: bool,
    /// Chain rows served by the shared handlers.
    #[serde(default)]
    pub chains: Vec<BitcoinProxyChainConf>,
    /// Maximum request body accepted by JSON-RPC and Chronik POST endpoints.
    #[serde(default = "default_bitcoin_request_bytes")]
    pub max_request_bytes: usize,
    /// Maximum upstream response body.
    #[serde(default = "default_bitcoin_response_bytes")]
    pub max_response_bytes: usize,
    /// Maximum in-flight Bitcoin-family upstream requests.
    #[serde(default = "default_rpc_concurrency")]
    pub max_concurrency: usize,
    /// Complete upstream request timeout.
    #[serde(default = "default_rpc_timeout_ms")]
    pub timeout_ms: u64,
    /// High, burstable fixed-hour Chronik bootstrap allowance per source IP.
    #[serde(default = "default_chronik_anonymous_requests_per_hour")]
    pub anonymous_chronik_requests_per_hour: u32,
    /// Small, burstable fixed-hour raw-transaction broadcast allowance per source IP.
    #[serde(default = "default_anonymous_broadcasts_per_hour")]
    pub anonymous_broadcasts_per_hour: u32,
    /// Lifetime of a registered-customer bearer capability URL.
    #[serde(default = "default_rpc_capability_ttl_ms")]
    pub capability_ttl_ms: u64,
}

impl Default for BitcoinProxyConf {
    fn default() -> Self {
        Self {
            enabled: false,
            chains: vec![],
            max_request_bytes: default_bitcoin_request_bytes(),
            max_response_bytes: default_bitcoin_response_bytes(),
            max_concurrency: default_rpc_concurrency(),
            timeout_ms: default_rpc_timeout_ms(),
            anonymous_chronik_requests_per_hour: default_chronik_anonymous_requests_per_hour(),
            anonymous_broadcasts_per_hour: default_anonymous_broadcasts_per_hour(),
            capability_ttl_ms: default_rpc_capability_ttl_ms(),
        }
    }
}

const fn default_bitcoin_request_bytes() -> usize {
    512 * 1024
}
const fn default_bitcoin_response_bytes() -> usize {
    16 * 1024 * 1024
}
const fn default_chronik_anonymous_requests_per_hour() -> u32 {
    20_000
}
const fn default_anonymous_broadcasts_per_hour() -> u32 {
    20
}

/// One Bitcoin-family chain and its optional node/indexer upstreams.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct BitcoinProxyChainConf {
    /// Stable public path id, e.g. `btc-mainnet`.
    pub id: String,
    /// Server-only environment variable containing a Bitcoin JSON-RPC URL.
    pub rpc_upstream_env: Option<String>,
    /// Server-only environment variable containing a Chronik base URL.
    pub chronik_upstream_env: Option<String>,
    /// Checkpoint height queried on every configured upstream before readiness.
    pub checkpoint_height: u64,
    /// Expected conventional big-endian block hash at the checkpoint.
    pub checkpoint_hash: String,
}

/// Invalid Bitcoin-family proxy configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BitcoinProxyConfigError {
    /// Enabled mode has no chain rows.
    MissingChains,
    /// Chain id is unsafe or duplicated.
    InvalidChainId(String),
    /// The id is not registered as a Bitcoin-family chain.
    WrongChainFamily(String),
    /// Neither node nor indexer upstream is configured.
    MissingUpstream(String),
    /// An environment variable name is malformed.
    InvalidUpstreamEnv(String),
    /// Checkpoint hash is not 32-byte lowercase/uppercase hex.
    InvalidCheckpoint(String),
    /// Checkpoint contradicts a protocol-pinned chain checkpoint.
    CheckpointMismatch(String),
    /// Protection limit is invalid.
    InvalidLimit(&'static str),
}

impl fmt::Display for BitcoinProxyConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid registry.bitcoin_proxy configuration: {self:?}")
    }
}

impl Error for BitcoinProxyConfigError {}

impl BitcoinProxyConf {
    /// Validate the bounded chain-as-data configuration without resolving secrets.
    pub fn validate(&self) -> std::result::Result<(), BitcoinProxyConfigError> {
        if !self.enabled {
            return Ok(());
        }
        if self.chains.is_empty() {
            return Err(BitcoinProxyConfigError::MissingChains);
        }
        if self.max_request_bytes == 0 || self.max_request_bytes > 512 * 1024 {
            return Err(BitcoinProxyConfigError::InvalidLimit("max_request_bytes"));
        }
        if self.max_response_bytes == 0 || self.max_response_bytes > 32 * 1024 * 1024 {
            return Err(BitcoinProxyConfigError::InvalidLimit("max_response_bytes"));
        }
        if self.max_concurrency == 0
            || self.max_concurrency > 1024
            || self.timeout_ms == 0
            || self.timeout_ms > 120_000
        {
            return Err(BitcoinProxyConfigError::InvalidLimit("runtime limit"));
        }
        if self
            .max_response_bytes
            .checked_mul(self.max_concurrency)
            .map_or(true, |bytes| bytes > MAX_AGGREGATE_RPC_RESPONSE_BYTES)
        {
            return Err(BitcoinProxyConfigError::InvalidLimit(
                "aggregate response bytes",
            ));
        }
        if self.capability_ttl_ms < 60_000 || self.capability_ttl_ms > 24 * 60 * 60 * 1000 {
            return Err(BitcoinProxyConfigError::InvalidLimit("capability_ttl_ms"));
        }
        let mut ids = HashSet::new();
        for chain in &self.chains {
            let valid_id = !chain.id.is_empty()
                && chain.id.len() <= 64
                && chain
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !valid_id || !ids.insert(chain.id.as_str()) {
                return Err(BitcoinProxyConfigError::InvalidChainId(chain.id.clone()));
            }
            let protocol = protocol_chain(&chain.id)
                .filter(|row| row.family == ProtocolChainFamily::Bitcoin)
                .ok_or_else(|| BitcoinProxyConfigError::WrongChainFamily(chain.id.clone()))?;
            if chain.rpc_upstream_env.is_none() && chain.chronik_upstream_env.is_none() {
                return Err(BitcoinProxyConfigError::MissingUpstream(chain.id.clone()));
            }
            for name in chain
                .rpc_upstream_env
                .iter()
                .chain(chain.chronik_upstream_env.iter())
            {
                let valid = !name.is_empty()
                    && name.len() <= 128
                    && name.bytes().enumerate().all(|(i, b)| {
                        b.is_ascii_uppercase() || b == b'_' || (i > 0 && b.is_ascii_digit())
                    });
                if !valid {
                    return Err(BitcoinProxyConfigError::InvalidUpstreamEnv(name.clone()));
                }
            }
            if chain.checkpoint_hash.len() != 64
                || !chain.checkpoint_hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(BitcoinProxyConfigError::InvalidCheckpoint(chain.id.clone()));
            }
            let configured_capabilities = [
                chain
                    .rpc_upstream_env
                    .as_ref()
                    .map(|_| ProtocolProxyCapability::JsonRpc),
                chain
                    .chronik_upstream_env
                    .as_ref()
                    .map(|_| ProtocolProxyCapability::Chronik),
            ];
            for capability in configured_capabilities.into_iter().flatten() {
                if let Some((height, expected)) =
                    protocol
                        .identity_probes
                        .iter()
                        .find_map(|probe| match probe {
                            ProtocolIdentityProbe::BlockHash {
                                capability: probe_capability,
                                height,
                                expected,
                            } if *probe_capability == capability => {
                                Some((*height, expected.as_str()))
                            }
                            _ => None,
                        })
                {
                    if chain.checkpoint_height != height
                        || !chain.checkpoint_hash.eq_ignore_ascii_case(expected)
                    {
                        return Err(BitcoinProxyConfigError::CheckpointMismatch(
                            chain.id.clone(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

/// Typed durable Monad mailbox configuration.
///
/// Disabling the mailbox is the supported rollback and preserves durable rows for the current
/// binary. Operators requiring binary downgrade must snapshot before upgrading because older
/// binaries cannot read newer versioned outbox rows.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct MonadMailboxConf {
    /// Whether admission and reconciliation are enabled. This is the only switch for
    /// `PUT /message/monad` and the private mailbox routes (the shipped configs enable it). The
    /// one environment input is `cashwebd-exe` filling a missing `rpc_url` from
    /// `MONAD_TESTNET_HTTP_RPC_URL`; this type itself never reads the environment. A disabled deployment omits those routes (every `/message/monad` request
    /// other than the separate topic routes answers 404) and does not start a worker; durable rows
    /// remain readable.
    pub enabled: bool,
    /// Monad JSON-RPC endpoint. Required exactly when `enabled` is true; the shipped configs omit it
    /// and `cashwebd-exe` supplies it from the environment before calling `mode()`.
    pub rpc_url: Option<url::Url>,
    /// Aggregate direct-message stamp minimum, as a decimal string because TOML has no `u128`.
    /// Required exactly when the mailbox is enabled.
    pub min_value_wei: Option<String>,
    /// EIP-155/EIP-1559 chain ID every signed stamp payment must carry.
    /// Required exactly when the mailbox is enabled.
    pub expected_chain_id: Option<u64>,
}

/// Validated mailbox mode consumed once, before database open or socket readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MonadMailboxMode {
    /// No worker; the HTTP owner must omit the admission route.
    Disabled,
    /// Worker and admission use the same validated endpoint.
    Enabled {
        /// Validated Monad JSON-RPC endpoint.
        rpc_url: url::Url,
        /// Validated aggregate direct-message stamp minimum.
        min_value_wei: u128,
        /// Required EVM chain identity for signed stamp payments.
        expected_chain_id: u64,
    },
}

/// Invalid enabled mailbox RPC configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MonadMailboxConfigError {
    /// Enabled mode omitted its mandatory endpoint.
    MissingRpcUrl,
    /// The endpoint is not a hosted HTTP(S) URL.
    InvalidRpcUrl,
    /// Enabled mode omitted or malformed its aggregate stamp minimum.
    InvalidMinValueWei,
    /// Enabled mode omitted its expected EVM chain identity.
    MissingExpectedChainId,
}

impl fmt::Display for MonadMailboxConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRpcUrl => f.write_str(
                "registry.monad_mailbox.rpc_url is required when the mailbox is enabled",
            ),
            Self::InvalidRpcUrl => f.write_str(
                "registry.monad_mailbox.rpc_url must be a hosted http(s) URL when the mailbox is enabled",
            ),
            Self::InvalidMinValueWei => f.write_str(
                "registry.monad_mailbox.min_value_wei must be a decimal u128 when the mailbox is enabled",
            ),
            Self::MissingExpectedChainId => f.write_str(
                "registry.monad_mailbox.expected_chain_id is required when the mailbox is enabled",
            ),
        }
    }
}

impl Error for MonadMailboxConfigError {}

impl MonadMailboxConf {
    /// Validate the enabled/endpoint relationship before any service becomes ready.
    pub fn mode(&self) -> std::result::Result<MonadMailboxMode, MonadMailboxConfigError> {
        if !self.enabled {
            return Ok(MonadMailboxMode::Disabled);
        }
        let rpc_url = self
            .rpc_url
            .clone()
            .ok_or(MonadMailboxConfigError::MissingRpcUrl)?;
        if !matches!(rpc_url.scheme(), "http" | "https") || rpc_url.host_str().is_none() {
            return Err(MonadMailboxConfigError::InvalidRpcUrl);
        }
        let min_value_wei = self
            .min_value_wei
            .as_deref()
            .ok_or(MonadMailboxConfigError::InvalidMinValueWei)?
            .parse()
            .map_err(|_| MonadMailboxConfigError::InvalidMinValueWei)?;
        let expected_chain_id = self
            .expected_chain_id
            .ok_or(MonadMailboxConfigError::MissingExpectedChainId)?;
        Ok(MonadMailboxMode::Enabled {
            rpc_url,
            min_value_wei,
            expected_chain_id,
        })
    }
}

/// One operator-curated default contact (ticket #49) -- see `RegistryConf::curated_defaults`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CuratedContactConf {
    /// `0x`-prefixed, 20-byte Monad address.
    pub address: String,
    /// Display name shown to the user before they've ever messaged this contact.
    pub name: String,
}

/// Configuration for POP (proof-of-payment) protection on the registry metadata-put endpoint
/// (`cashweb_registry::http::pop_protection`).
///
/// This is a required field of [`RegistryConf`] rather than an `Option`, deliberately: ticket #1
/// flagged the metadata-put endpoint having *no* payment gating at all as a bug, and #24/#4 fixed
/// that on the principle that missing configuration should fail closed. Requiring this at
/// config-parse time fails even earlier (at startup, with a clear "missing field" error) than the
/// previous per-request runtime check.
///
/// Ticket #35: `enabled` is a distinct, explicit third state from "misconfigured". When
/// `enabled = false`, POP gating is skipped entirely (fail-*open*, by deliberate operator intent
/// -- e.g. the hackathon demo, where signing up should require no payment). When `enabled = true`
/// but the rest of this struct doesn't parse into a valid gate (bad `payment_recipient`/
/// `min_value_wei`), behavior is unchanged from before this ticket: fail *closed* with a `500`
/// (see `cashweb_registry::http::pop_protection::PopGateConfigError` and
/// `cashweb_registry::http::server::RegistryServer::pop_gate`'s doc comment for how these two
/// states are kept from collapsing into each other). There's deliberately no `#[serde(default)]`
/// on this field: an operator must say explicitly whether POP is on, the same "no silent
/// defaults" principle the rest of this struct already follows.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PopConf {
    /// Whether POP gating is active at all. `false` (the hackathon demo default) skips POP
    /// gating entirely for every request -- no token check, no 402 challenge. `true` requires
    /// the rest of this struct to parse into a valid gate at server-construction time, or every
    /// gated request fails closed with a `500` (see this struct's docs).
    pub enabled: bool,
    /// Monad JSON-RPC endpoint used to verify payment transaction receipts. (The direct-message
    /// mailbox has its own `registry.monad_mailbox.rpc_url`; only the topic routes still read the
    /// `MONAD_TESTNET_HTTP_RPC_URL` environment variable.)
    pub monad_rpc_url: url::Url,
    /// Server-side secret used to sign/verify bearer tokens (HMAC). Must be a long random string
    /// kept only in server config; there is deliberately no built-in default.
    pub hmac_secret: String,
    /// `0x`-prefixed, 20-byte Monad address payments must be sent to. Kept as a plain `String`
    /// here (rather than a `cashweb-registry`-defined address type) so this crate doesn't need to
    /// depend on `cashweb-registry`; it's parsed downstream by
    /// `cashweb_registry::http::pop_protection::PopGate::from_conf`.
    pub payment_recipient: String,
    /// Minimum payment amount, in wei, as a decimal string. Kept as a `String` (rather than
    /// `u128`) since TOML has no native 128-bit integer type; parsed downstream the same way as
    /// `payment_recipient`.
    pub min_value_wei: String,
}

/// How to initally download metadata from peers
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct InitialMetadataDownloadConf {
    /// How many peers will be sampled each round when syncing
    #[serde(default = "default_num_sampled_peers")]
    pub num_sampled_peers: usize,
    /// When we stop waiting for a peer to respond, in milliseconds
    #[serde(default = "default_timeout_peer_ms")]
    pub timeout_peer_ms: u64,
    /// How many failed rounds (rounds with no successful results at all)
    /// of querying peers we do before we wait some time
    #[serde(default = "default_num_failed_for_wait")]
    pub num_failed_for_wait: usize,
    /// How long we wait after N rounds failed, in seconds
    #[serde(default = "default_fail_wait_duration_s")]
    pub fail_wait_duration_s: u64,
}

/// Parse the configuration file from a string
pub fn parse_conf(conf_str: &str) -> Result<CashwebdConf> {
    Ok(toml::from_str(conf_str)?)
}

impl Default for InitialMetadataDownloadConf {
    fn default() -> Self {
        InitialMetadataDownloadConf {
            num_sampled_peers: default_num_sampled_peers(),
            timeout_peer_ms: default_timeout_peer_ms(),
            num_failed_for_wait: default_num_failed_for_wait(),
            fail_wait_duration_s: default_fail_wait_duration_s(),
        }
    }
}

fn default_num_sampled_peers() -> usize {
    3
}

fn default_timeout_peer_ms() -> u64 {
    1500
}

fn default_num_failed_for_wait() -> usize {
    3
}

fn default_fail_wait_duration_s() -> u64 {
    30
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClientConf;
    use bitcoinsuite_core::Net;
    use bitcoinsuite_error::Result;

    use crate::{
        parse_conf, protocol_chain_registry, BitcoinProxyChainConf, BitcoinProxyConf, CashwebdConf,
        CuratedContactConf, EvmRpcChainConf, EvmRpcConf, EvmRpcConfigError,
        InitialMetadataDownloadConf, MonadMailboxConf, MonadMailboxConfigError, MonadMailboxMode,
        PopConf, ProtocolChainFamily, ProtocolProxyCapability, RegistryConf, RegistryConfigError,
    };

    #[test]
    fn directory_section_is_only_the_relay_tuple_and_old_files_get_a_plain_error() {
        let minimal: crate::DirectoryConf = toml::from_str(
            r#"
network = "monad-testnet"
relay_id = "000102030405060708090a0b0c0d0e0f"
relay_identity = "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13"
endpoint = "https://relay.example.org"
binding_expiry_ns = "1893456000000000000"
"#,
        )
        .unwrap();
        minimal.validate().unwrap();
        assert_eq!(minimal.max_subjects, 1_000_000);
        assert_eq!(minimal.enrollments_per_source_per_hour, 30);

        let old: crate::DirectoryConf = toml::from_str(
            r#"
clock_file = "/var/lib/frank/clock"
[[principals]]
network = "monad-testnet"
subject = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
mode = "new"
continuity_file = "/var/lib/frank/continuity"
"#,
        )
        .unwrap();
        assert_eq!(
            old.validate(),
            Err(crate::DirectoryConfError::RemovedSettings)
        );
        assert!(old
            .validate()
            .unwrap_err()
            .to_string()
            .contains("accounts now publish their own directory entries"));
        // A misspelt setting is still an error rather than silently ignored.
        assert!(toml::from_str::<crate::DirectoryConf>("netwrok = \"x\"").is_err());
    }

    #[test]
    fn evm_rpc_is_disabled_when_omitted_and_validates_enabled_rows() -> Result<()> {
        let base = EvmRpcConf::default();
        assert!(!base.enabled);
        assert_eq!(base.validate(), Ok(()));

        let mut enabled = EvmRpcConf {
            enabled: true,
            chains: vec![EvmRpcChainConf {
                id: "monad-testnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "MONAD_TESTNET_HTTP_RPC_URL".to_string(),
                upstream_ws_env: None,
                checkpoint_block_number: Some(0),
                checkpoint_block_hash: Some(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9"
                        .to_string(),
                ),
                max_get_logs_range: 10,
            }],
            ..base
        };
        assert_eq!(enabled.validate(), Ok(()));

        enabled.chains[0].checkpoint_block_hash = Some(format!("0x{}", "00".repeat(32)));
        assert_eq!(
            enabled.validate(),
            Err(EvmRpcConfigError::CheckpointMismatch(
                "monad-testnet".to_string()
            ))
        );
        enabled.chains[0].checkpoint_block_hash =
            Some("0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9".to_string());

        enabled.capability_ttl_ms = 59_999;
        assert_eq!(
            enabled.validate(),
            Err(EvmRpcConfigError::InvalidLimit("capability_ttl_ms"))
        );
        enabled.capability_ttl_ms = 24 * 60 * 60 * 1000 + 1;
        assert_eq!(
            enabled.validate(),
            Err(EvmRpcConfigError::InvalidLimit("capability_ttl_ms"))
        );
        enabled.capability_ttl_ms = 60 * 60 * 1000;
        enabled.chains[0].upstream_ws_env = Some(String::new());
        assert_eq!(
            enabled.validate(),
            Err(EvmRpcConfigError::InvalidUpstreamEnv(String::new()))
        );
        enabled.chains[0].upstream_ws_env = Some("MONAD_TESTNET_WS_RPC_URL".to_string());

        enabled.max_response_bytes = 512 * 1024 * 1024;
        enabled.max_concurrency = 5;
        assert_eq!(
            enabled.validate(),
            Err(EvmRpcConfigError::InvalidLimit("aggregate response bytes"))
        );
        enabled.max_response_bytes = 64 * 1024 * 1024;
        enabled.max_concurrency = 32;
        assert_eq!(enabled.validate(), Ok(()));

        enabled.chains.push(enabled.chains[0].clone());
        assert!(matches!(
            enabled.validate(),
            Err(EvmRpcConfigError::InvalidChainId(id)) if id == "monad-testnet"
        ));
        Ok(())
    }

    #[test]
    fn protocol_registry_is_unique_and_family_validation_fails_closed() {
        let registry = protocol_chain_registry();
        assert_eq!(registry.schema_version, 1);
        assert_eq!(registry.chains.len(), 14);
        assert_eq!(
            registry
                .chains
                .iter()
                .find(|chain| chain.id == "monad-testnet")
                .unwrap()
                .allowed_proxy_capabilities,
            vec![ProtocolProxyCapability::JsonRpc]
        );

        let wrong_evm = EvmRpcConf {
            enabled: true,
            chains: vec![EvmRpcChainConf {
                id: "btc-mainnet".to_string(),
                expected_chain_id: 10_143,
                upstream_env: "BTC_RPC".to_string(),
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
        assert_eq!(
            wrong_evm.validate(),
            Err(EvmRpcConfigError::WrongChainFamily(
                "btc-mainnet".to_string()
            ))
        );

        let mut bitcoin = BitcoinProxyConf {
            enabled: true,
            chains: vec![BitcoinProxyChainConf {
                id: "xec-mainnet".to_string(),
                rpc_upstream_env: None,
                chronik_upstream_env: Some("XEC_CHRONIK".to_string()),
                checkpoint_height: 661_648,
                checkpoint_hash: "000000000000000004284c9d8b2c8ff731efeaec6be50729bdc9bd07f910757d"
                    .to_string(),
            }],
            ..BitcoinProxyConf::default()
        };
        assert_eq!(bitcoin.validate(), Ok(()));
        bitcoin.chains[0].checkpoint_height = 0;
        assert_eq!(
            bitcoin.validate(),
            Err(crate::BitcoinProxyConfigError::CheckpointMismatch(
                "xec-mainnet".to_string()
            ))
        );
        bitcoin.chains[0].checkpoint_height = 661_648;
        bitcoin.capability_ttl_ms = 59_999;
        assert_eq!(
            bitcoin.validate(),
            Err(crate::BitcoinProxyConfigError::InvalidLimit(
                "capability_ttl_ms"
            ))
        );
        bitcoin.capability_ttl_ms = 24 * 60 * 60 * 1000 + 1;
        assert_eq!(
            bitcoin.validate(),
            Err(crate::BitcoinProxyConfigError::InvalidLimit(
                "capability_ttl_ms"
            ))
        );
        bitcoin.capability_ttl_ms = 60 * 60 * 1000;
        bitcoin.max_response_bytes = 32 * 1024 * 1024;
        bitcoin.max_concurrency = 65;
        assert_eq!(
            bitcoin.validate(),
            Err(crate::BitcoinProxyConfigError::InvalidLimit(
                "aggregate response bytes"
            ))
        );
        bitcoin.max_concurrency = 64;
        assert_eq!(bitcoin.validate(), Ok(()));
        assert!(registry
            .chains
            .iter()
            .filter(|chain| chain.family == ProtocolChainFamily::Bitcoin)
            .all(|chain| chain
                .allowed_proxy_capabilities
                .contains(&ProtocolProxyCapability::JsonRpc)));
    }

    #[test]
    fn test_config_err() -> Result<()> {
        let err = parse_conf("").unwrap_err().downcast::<toml::de::Error>()?;
        assert_eq!(err.to_string(), "missing field `host`");
        Ok(())
    }

    #[test]
    fn test_config_partial_imd_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf,
            CashwebdConf {
                host: "127.0.0.1:6543".parse()?,
                url: "https://cashweb.registry".parse()?,
                registry: RegistryConf {
                    directory: None,
                    db_path: "/test/path".into(),
                    net: Net::Mainnet,
                    peers: vec![
                        "https://example.com".parse()?,
                        "http://123.45.67.89".parse()?,
                    ],
                    public_relay_urls: vec![],
                    imd: InitialMetadataDownloadConf {
                        num_sampled_peers: 3,
                        timeout_peer_ms: 1500,
                        num_failed_for_wait: 3,
                        fail_wait_duration_s: 30,
                    },
                    pop: PopConf {
                        enabled: true,
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                    monad_mailbox: MonadMailboxConf {
                        enabled: false,
                        rpc_url: None,
                        min_value_wei: None,
                        expected_chain_id: None,
                    },
                    evm_rpc: EvmRpcConf::default(),
                    bitcoin_proxy: BitcoinProxyConf::default(),
                    curated_defaults: vec![],
                },
                bitcoin_rpc: Some(BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                }),
            }
        );
        Ok(())
    }

    #[test]
    fn test_config_default_imd_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]
                [registry.imd]
                num_sampled_peers = 2

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf,
            CashwebdConf {
                host: "127.0.0.1:6543".parse()?,
                url: "https://cashweb.registry".parse()?,
                registry: RegistryConf {
                    directory: None,
                    db_path: "/test/path".into(),
                    net: Net::Mainnet,
                    peers: vec![
                        "https://example.com".parse()?,
                        "http://123.45.67.89".parse()?,
                    ],
                    public_relay_urls: vec![],
                    imd: InitialMetadataDownloadConf {
                        num_sampled_peers: 2,
                        timeout_peer_ms: 1500,
                        num_failed_for_wait: 3,
                        fail_wait_duration_s: 30,
                    },
                    pop: PopConf {
                        enabled: true,
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                    monad_mailbox: MonadMailboxConf {
                        enabled: false,
                        rpc_url: None,
                        min_value_wei: None,
                        expected_chain_id: None,
                    },
                    evm_rpc: EvmRpcConf::default(),
                    bitcoin_proxy: BitcoinProxyConf::default(),
                    curated_defaults: vec![],
                },
                bitcoin_rpc: Some(BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                }),
            }
        );
        Ok(())
    }

    #[test]
    fn test_config_monad_only_without_bitcoin_rpc() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:8098"
                url = "http://127.0.0.1:8098"

                [registry]
                db_path = "data/registry.rocksdb"
                net = "mainnet"
                peers = []

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = false
                monad_rpc_url = "http://unused.invalid"
                hmac_secret = "unused"
                payment_recipient = "0x0000000000000000000000000000000000000000"
                min_value_wei = "0"
            "#,
        )?;

        assert_eq!(conf.bitcoin_rpc, None);
        assert_eq!(
            conf.registry.db_path,
            PathBuf::from("data/registry.rocksdb")
        );
        Ok(())
    }

    #[test]
    fn test_config_curated_defaults_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [[registry.curated_defaults]]
                address = "0x1111111111111111111111111111111111111111"
                name = "Welcome Bot"

                [[registry.curated_defaults]]
                address = "0x2222222222222222222222222222222222222222"
                name = "Support"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf.registry.curated_defaults,
            vec![
                CuratedContactConf {
                    address: "0x1111111111111111111111111111111111111111".to_string(),
                    name: "Welcome Bot".to_string(),
                },
                CuratedContactConf {
                    address: "0x2222222222222222222222222222222222222222".to_string(),
                    name: "Support".to_string(),
                },
            ]
        );
        Ok(())
    }

    #[test]
    fn deployed_default_configurations_enable_mailbox_and_evm_proxy() {
        // The mailbox is on by default (owner decision, ticket #279): both checked-in defaults
        // must parse enabled with the safe non-secret keys. The RPC URL is deliberately absent
        // (secret-bearing); `cashwebd-exe` resolves it from MONAD_TESTNET_HTTP_RPC_URL, so
        // `mode()` alone reports it missing while the file is otherwise complete.
        for (name, config) in [
            (
                "cashwebd.local.toml",
                include_str!("../../cashwebd.local.toml"),
            ),
            (
                "docker/cashwebd.toml",
                include_str!("../../../docker/cashwebd.toml"),
            ),
        ] {
            let mut conf = parse_conf(config).unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!(
                conf.registry.monad_mailbox,
                MonadMailboxConf {
                    enabled: true,
                    rpc_url: None,
                    min_value_wei: Some("1000000000000".to_string()),
                    expected_chain_id: Some(10143),
                },
                "{name}"
            );
            assert_eq!(
                conf.registry.monad_mailbox.mode(),
                Err(MonadMailboxConfigError::MissingRpcUrl),
                "{name}"
            );
            let rpc_url: url::Url = "http://127.0.0.1:1".parse().unwrap();
            conf.registry.monad_mailbox.rpc_url = Some(rpc_url.clone());
            assert_eq!(
                conf.registry.monad_mailbox.mode(),
                Ok(MonadMailboxMode::Enabled {
                    rpc_url,
                    min_value_wei: 1_000_000_000_000,
                    expected_chain_id: 10143,
                }),
                "{name}"
            );
            assert!(conf.registry.evm_rpc.enabled, "{name}");
            assert_eq!(conf.registry.evm_rpc.chains.len(), 1, "{name}");
            assert_eq!(
                conf.registry.evm_rpc.chains[0].id, "monad-testnet",
                "{name}"
            );
            assert_eq!(
                conf.registry.evm_rpc.chains[0].upstream_env, "MONAD_TESTNET_HTTP_RPC_URL",
                "{name}"
            );
            assert_eq!(
                conf.registry.evm_rpc.chains[0].upstream_ws_env.as_deref(),
                Some("MONAD_TESTNET_WS_RPC_URL"),
                "{name}"
            );
            conf.registry.evm_rpc.validate().unwrap();
            assert!(conf.registry.bitcoin_proxy.enabled, "{name}");
            assert_eq!(conf.registry.bitcoin_proxy.chains.len(), 1, "{name}");
            assert_eq!(
                conf.registry.bitcoin_proxy.chains[0].id, "xec-testnet",
                "{name}"
            );
            assert_eq!(
                conf.registry.bitcoin_proxy.chains[0].chronik_upstream_env.as_deref(),
                Some("XEC_TESTNET_CHRONIK_URL"),
                "{name}"
            );
            conf.registry.bitcoin_proxy.validate().unwrap();
            assert_eq!(
                conf.registry.validate_rpc_resource_limits(),
                Ok(()),
                "{name}"
            );

            // Each family may fit its local ceiling while their combined in-flight response
            // reservations exceed the process-wide ceiling.
            conf.registry.evm_rpc.max_response_bytes = 512 * 1024 * 1024;
            conf.registry.evm_rpc.max_concurrency = 4;
            conf.registry.bitcoin_proxy.enabled = true;
            conf.registry.bitcoin_proxy.max_response_bytes = 32 * 1024 * 1024;
            conf.registry.bitcoin_proxy.max_concurrency = 64;
            assert_eq!(
                conf.registry.validate_rpc_resource_limits(),
                Err(RegistryConfigError::InvalidLimit(
                    "aggregate RPC response bytes"
                )),
                "{name}"
            );
            conf.registry.evm_rpc.max_concurrency = 3;
            conf.registry.bitcoin_proxy.max_concurrency = 16;
            assert_eq!(
                conf.registry.validate_rpc_resource_limits(),
                Ok(()),
                "{name}"
            );
        }
    }

    #[test]
    fn mailbox_mode_requires_rpc_exactly_when_enabled() {
        assert_eq!(
            MonadMailboxConf {
                enabled: false,
                rpc_url: None,
                min_value_wei: None,
                expected_chain_id: None,
            }
            .mode()
            .unwrap(),
            MonadMailboxMode::Disabled
        );
        assert!(MonadMailboxConf {
            enabled: true,
            rpc_url: None,
            min_value_wei: Some("1".to_string()),
            expected_chain_id: Some(41454),
        }
        .mode()
        .is_err());
        let rpc_url: url::Url = "https://rpc.example".parse().unwrap();
        assert_eq!(
            MonadMailboxConf {
                enabled: true,
                rpc_url: Some(rpc_url.clone()),
                min_value_wei: Some("1000".to_string()),
                expected_chain_id: Some(41454),
            }
            .mode()
            .unwrap(),
            MonadMailboxMode::Enabled {
                rpc_url,
                min_value_wei: 1000,
                expected_chain_id: 41454,
            }
        );
        let missing: MonadMailboxConf = toml::from_str("enabled = true").unwrap();
        assert!(missing.mode().is_err());
        assert_eq!(
            MonadMailboxConf {
                enabled: true,
                rpc_url: Some("https://rpc.example".parse().unwrap()),
                min_value_wei: Some("1".to_string()),
                expected_chain_id: None,
            }
            .mode(),
            Err(MonadMailboxConfigError::MissingExpectedChainId)
        );
        assert!(toml::from_str::<MonadMailboxConf>(
            "enabled = true\nrpc_url = 'this is not a URL'"
        )
        .is_err());
        for rejected in [
            "file:///tmp/rpc",
            "ftp://rpc.example/path",
            "data:text/plain,rpc",
        ] {
            assert_eq!(
                MonadMailboxConf {
                    enabled: true,
                    rpc_url: Some(rejected.parse().unwrap()),
                    min_value_wei: Some("1".to_string()),
                    expected_chain_id: Some(41454),
                }
                .mode(),
                Err(MonadMailboxConfigError::InvalidRpcUrl)
            );
        }
    }
}
