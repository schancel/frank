//! Unified stateless Relay Chain Adapter and RPC Registry (`chain_registry_adapter`).
//!
//! Mirrors the frontend's `ChainAdapter` / `chains-registry` machinery on the relay without
//! relay-managed wallets. Every chain in [`cashweb_config::protocol_chain_registry`]
//! (`docs/protocol/chains/v1.json`) is automatically registered as a [`RelayChainAdapter`],
//! providing a single source of truth for:
//!
//! - Chain identity and metadata (`chain_id`, `family`, `network`, `caip2`, `evm_chain_id`,
//!   4-byte `network_tag`, `allowed_proxy_capabilities`, and `identity_probes`).
//! - Configured upstream RPC/indexer endpoints resolved from [`cashweb_config::RegistryConf`]
//!   (`evm_rpc`, `bitcoin_proxy`, `solana_proxy`, and `monad_mailbox`).
//! - Stateless RPC transport and transaction/stamp/POP verification helpers for EVM chains
//!   ([`MonadHttpClient`], [`HttpTransport`], [`MonadBlockSubscriber`], calldata commitment
//!   decoding, receipt-based POP verification, and stamp transaction verification).
//!
//! Legacy Lotus (`bitcoind`) support remains available in [`crate::lotus_adapter::LotusAdapter`]
//! behind [`cashweb_payload::chain_adapter::ChainAdapter`], and stays unwired
//! ([`crate::disabled_chain_adapter::DisabledChainAdapter`]) when `[bitcoin_rpc]` is omitted.

use std::collections::BTreeMap;

use bitcoinsuite_core::Sha256;
use cashweb_config::{
    protocol_chain, protocol_chain_by_evm_chain_id, protocol_chain_registry,
    ProtocolChainDescriptor, ProtocolChainFamily, ProtocolIdentityProbe, ProtocolProxyCapability,
    RegistryConf,
};
use thiserror::Error;
use url::Url;

use crate::{
    monad_http::{Hash32, HttpTransport, MonadHttpClient, MonadRpcError},
    monad_pop_verify::{verify_payment_via_receipt, ExpectedPayment, PopVerification},
    monad_stamp_verify::{
        parse_commitment_calldata, verify_stamp_transaction, CalldataCommitmentError,
        ExpectedStampTransaction, StampTransactionVerification,
    },
    monad_ws::MonadBlockSubscriber,
    network_tag::{network_tag_for_chain_id, protocol_chain_for_tag},
};

/// Errors resolving upstream RPC endpoints from operator configuration and environment variables.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RelayChainRegistryError {
    /// A required RPC URL environment variable was not set or was blank.
    #[error("missing required RPC URL environment variable {env_name}")]
    MissingRpcUrlEnv {
        /// Name of the unset environment variable.
        env_name: String,
    },
    /// An RPC URL environment variable contained a malformed or non-HTTP(S) URL.
    #[error("invalid HTTP(S) RPC URL list in environment variable {env_name}")]
    InvalidRpcUrlEnv {
        /// Name of the environment variable with an invalid URL list.
        env_name: String,
    },
}

/// Stateless relay-side chain adapter for one canonical protocol chain in
/// `docs/protocol/chains/v1.json`.
///
/// Unlike the frontend `ChainAdapter`, the relay manages no user wallets or private keys; it
/// exposes protocol metadata, configured upstream endpoints, and stateless RPC/verification
/// primitives for that chain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayChainAdapter {
    descriptor: &'static ProtocolChainDescriptor,
    http_rpc_urls: Vec<Url>,
    ws_rpc_url: Option<Url>,
    chronik_urls: Vec<Url>,
    electrum_urls: Vec<String>,
}

impl RelayChainAdapter {
    /// Construct a stateless adapter for `descriptor` with no configured upstream endpoints.
    pub fn new(descriptor: &'static ProtocolChainDescriptor) -> Self {
        Self {
            descriptor,
            http_rpc_urls: Vec::new(),
            ws_rpc_url: None,
            chronik_urls: Vec::new(),
            electrum_urls: Vec::new(),
        }
    }

    /// Underlying protocol chain descriptor from `docs/protocol/chains/v1.json`.
    pub fn descriptor(&self) -> &'static ProtocolChainDescriptor {
        self.descriptor
    }

    /// Canonical chain identifier (e.g. `monad-testnet`, `ethereum-mainnet`, `solana-devnet`).
    pub fn chain_id(&self) -> &'static str {
        self.descriptor.id.as_str()
    }

    /// Handler family (`evm`, `bitcoin`, `solana`).
    pub fn family(&self) -> ProtocolChainFamily {
        self.descriptor.family
    }

    /// Network class (`mainnet`, `testnet`, `devnet`, `regtest`).
    pub fn network(&self) -> &'static str {
        self.descriptor.network.as_str()
    }

    /// Canonical CAIP-2 identifier (e.g. `eip155:10143`, `bip122:...`, `solana:...`).
    pub fn caip2(&self) -> &'static str {
        self.descriptor.caip2.as_str()
    }

    /// Optional decimal native chain ID string.
    pub fn native_chain_id(&self) -> Option<&'static str> {
        self.descriptor.native_chain_id.as_deref()
    }

    /// Parsed EIP-155 numeric chain ID when this chain belongs to the `evm` family.
    pub fn evm_chain_id(&self) -> Option<u64> {
        self.descriptor.evm_chain_id()
    }

    /// Four-byte wire network tag (e.g. `b"MONT"`, `b"MON1"`, `b"ETH1"`, `b"SOL1"`).
    pub fn network_tag(&self) -> Option<&'static [u8; 4]> {
        network_tag_for_chain_id(self.chain_id())
    }

    /// Proxy capabilities permitted by the protocol registry for this chain.
    pub fn allowed_proxy_capabilities(&self) -> &'static [ProtocolProxyCapability] {
        self.descriptor.allowed_proxy_capabilities.as_slice()
    }

    /// Identity probes required by the protocol registry for this chain.
    pub fn identity_probes(&self) -> &'static [ProtocolIdentityProbe] {
        self.descriptor.identity_probes.as_slice()
    }

    /// Configured HTTP(S) JSON-RPC upstream URLs in priority order.
    pub fn http_rpc_urls(&self) -> &[Url] {
        &self.http_rpc_urls
    }

    /// Primary (first) configured HTTP(S) JSON-RPC upstream URL, if any.
    pub fn primary_http_rpc_url(&self) -> Option<&Url> {
        self.http_rpc_urls.first()
    }

    /// Configured WebSocket JSON-RPC upstream URL, if any.
    pub fn ws_rpc_url(&self) -> Option<&Url> {
        self.ws_rpc_url.as_ref()
    }

    /// Configured Chronik indexer URLs for Bitcoin-family chains.
    pub fn chronik_urls(&self) -> &[Url] {
        &self.chronik_urls
    }

    /// Configured Electrum indexer endpoints for Bitcoin-family chains.
    pub fn electrum_urls(&self) -> &[String] {
        &self.electrum_urls
    }

    /// Whether at least one upstream RPC or indexer endpoint is configured for this chain.
    pub fn has_configured_upstream(&self) -> bool {
        !self.http_rpc_urls.is_empty()
            || !self.chronik_urls.is_empty()
            || !self.electrum_urls.is_empty()
    }

    /// Capabilities currently backed by configured upstream endpoints on this adapter.
    pub fn configured_capabilities(&self) -> Vec<ProtocolProxyCapability> {
        let mut capabilities = Vec::new();
        if !self.http_rpc_urls.is_empty() {
            capabilities.push(ProtocolProxyCapability::JsonRpc);
        }
        if !self.chronik_urls.is_empty() {
            capabilities.push(ProtocolProxyCapability::Chronik);
        }
        if !self.electrum_urls.is_empty() {
            capabilities.push(ProtocolProxyCapability::Electrum);
        }
        capabilities
    }

    /// Build an [`HttpTransport`] for the primary configured EVM JSON-RPC upstream, if this is an
    /// EVM chain with a configured HTTP(S) RPC URL.
    pub fn evm_http_transport(&self) -> Option<HttpTransport> {
        if self.family() != ProtocolChainFamily::Evm {
            return None;
        }
        self.primary_http_rpc_url().cloned().map(HttpTransport::new)
    }

    /// Build [`HttpTransport`] instances for all configured EVM JSON-RPC upstreams in order.
    pub fn evm_http_transports(&self) -> Vec<HttpTransport> {
        if self.family() != ProtocolChainFamily::Evm {
            return Vec::new();
        }
        self.http_rpc_urls
            .iter()
            .cloned()
            .map(HttpTransport::new)
            .collect()
    }

    /// Build a stateless [`MonadHttpClient`] for the primary configured EVM JSON-RPC upstream.
    pub fn evm_http_client(&self) -> Option<MonadHttpClient<HttpTransport>> {
        if self.family() != ProtocolChainFamily::Evm {
            return None;
        }
        self.primary_http_rpc_url()
            .cloned()
            .map(MonadHttpClient::new)
    }

    /// Build a [`MonadBlockSubscriber`] for the configured EVM WebSocket upstream, if any.
    pub fn evm_block_subscriber(&self) -> Option<MonadBlockSubscriber> {
        if self.family() != ProtocolChainFamily::Evm {
            return None;
        }
        self.ws_rpc_url
            .as_ref()
            .map(|url| MonadBlockSubscriber::new(url.as_str()))
    }

    /// Statelessly decode a 32-byte commitment hash from `<lokad_id><version><commitment>` EVM
    /// calldata on this chain.
    pub fn decode_stamp_commitment(
        &self,
        commitment_id: [u8; 4],
        calldata: &[u8],
    ) -> std::result::Result<Sha256, CalldataCommitmentError> {
        parse_commitment_calldata(commitment_id, calldata)
    }

    /// Verify an on-chain POP payment transaction receipt and value on this EVM chain using its
    /// primary configured HTTP RPC upstream.
    pub async fn verify_pop_payment(
        &self,
        tx_hash: Hash32,
        expected: &ExpectedPayment,
    ) -> std::result::Result<Option<PopVerification>, MonadRpcError> {
        let Some(client) = self.evm_http_client() else {
            return Ok(None);
        };
        verify_payment_via_receipt(&client, tx_hash, expected)
            .await
            .map(Some)
    }

    /// Verify a Stamp commitment transaction on this EVM chain using its primary configured HTTP
    /// RPC upstream.
    pub async fn verify_stamp_transaction(
        &self,
        tx_hash: Hash32,
        expected: &ExpectedStampTransaction,
    ) -> bitcoinsuite_error::Result<Option<StampTransactionVerification>> {
        let Some(transport) = self.evm_http_transport() else {
            return Ok(None);
        };
        verify_stamp_transaction(&transport, tx_hash, expected)
            .await
            .map(Some)
    }
}

/// Resolved topic burn verification policy for an accepted payment network.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TopicBurnNetworkConfig {
    /// Canonical protocol chain identifier (e.g. `monad-testnet`, `monad-mainnet`).
    pub chain_id: String,
    /// Optional numeric EIP-155 chain ID when the payment network is an EVM chain.
    pub evm_chain_id: Option<u64>,
    /// Configured upstream HTTP(S) RPC endpoints for verifying burn transactions on this chain.
    pub rpc_urls: Vec<Url>,
    /// Required burn sink address on this network.
    pub burn_address: crate::monad_http::Address,
}

/// Stateless relay-wide registry of [`RelayChainAdapter`]s across all chains in
/// [`cashweb_config::protocol_chain_registry`].
///
/// Separate from [`Self::accepted_payment_networks`]: all canonical protocol chains remain
/// registered here so users can always use wallet RPC/indexer proxy APIs (`/chain-rpc/:chain/*`)
/// and stealth payments on any configured chain, while `accepted_payment_networks` scopes which
/// chains this relay accepts for stamp admission and topic burns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayChainRegistry {
    adapters: BTreeMap<String, RelayChainAdapter>,
    accepted_payment_networks: Vec<String>,
}

impl Default for RelayChainRegistry {
    fn default() -> Self {
        Self::from_protocol_registry()
    }
}

/// Parse a comma-separated list of HTTP(S) URLs from an environment variable value, rejecting
/// empty lists or non-HTTP(S) URLs.
pub fn parse_comma_separated_http_urls(
    env_name: &str,
    raw: &str,
) -> std::result::Result<Vec<Url>, RelayChainRegistryError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(RelayChainRegistryError::MissingRpcUrlEnv {
            env_name: env_name.to_string(),
        });
    }
    let urls = raw
        .split(',')
        .map(|token| token.trim().parse::<Url>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| RelayChainRegistryError::InvalidRpcUrlEnv {
            env_name: env_name.to_string(),
        })?;
    if urls.is_empty()
        || urls
            .iter()
            .any(|url| !matches!(url.scheme(), "http" | "https") || url.host_str().is_none())
    {
        return Err(RelayChainRegistryError::InvalidRpcUrlEnv {
            env_name: env_name.to_string(),
        });
    }
    Ok(urls)
}

/// Parse a whitespace- or comma-separated list of HTTP(S) URLs from an environment variable.
fn parse_whitespace_or_comma_http_urls(raw: &str) -> Vec<Url> {
    let mut urls = Vec::new();
    for token in raw
        .split([',', ' ', '\n', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(url) = token.parse::<Url>() {
            if matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && !urls.contains(&url)
            {
                urls.push(url);
            }
        }
    }
    urls
}

impl RelayChainRegistry {
    /// Construct a registry containing a [`RelayChainAdapter`] for every canonical chain in
    /// `docs/protocol/chains/v1.json`.
    pub fn from_protocol_registry() -> Self {
        let mut adapters = BTreeMap::new();
        for chain in &protocol_chain_registry().chains {
            adapters.insert(chain.id.clone(), RelayChainAdapter::new(chain));
        }
        Self {
            adapters,
            accepted_payment_networks: vec!["monad-testnet".to_string()],
        }
    }

    /// Construct a registry from [`RegistryConf`] and an environment lookup function, populating
    /// configured upstreams from `evm_rpc`, `bitcoin_proxy`, `solana_proxy`, and `monad_mailbox`,
    /// and recording `conf.effective_accepted_payment_networks()` for stamp and burn admission.
    pub fn from_conf_with_env(conf: &RegistryConf, env: impl Fn(&str) -> Option<String>) -> Self {
        let mut registry = Self::from_protocol_registry();
        registry.accepted_payment_networks = conf.effective_accepted_payment_networks();

        if conf.evm_rpc.enabled {
            for row in &conf.evm_rpc.chains {
                let Some(adapter) = registry.adapters.get_mut(&row.id) else {
                    continue;
                };
                for env_name in std::iter::once(&row.upstream_env).chain(row.upstream_envs.iter()) {
                    if let Some(raw) = env(env_name) {
                        for url in parse_whitespace_or_comma_http_urls(&raw) {
                            if !adapter.http_rpc_urls.contains(&url) {
                                adapter.http_rpc_urls.push(url);
                            }
                        }
                    }
                }
                if let Some(ws_env) = &row.upstream_ws_env {
                    if let Some(raw) = env(ws_env) {
                        if let Ok(url) = raw.trim().parse::<Url>() {
                            if matches!(url.scheme(), "ws" | "wss") && url.host_str().is_some() {
                                adapter.ws_rpc_url = Some(url);
                            }
                        }
                    }
                }
            }
        }

        if conf.bitcoin_proxy.enabled {
            for row in &conf.bitcoin_proxy.chains {
                let Some(adapter) = registry.adapters.get_mut(&row.id) else {
                    continue;
                };
                for env_name in row
                    .rpc_upstream_env
                    .iter()
                    .chain(row.rpc_upstream_envs.iter())
                {
                    if let Some(raw) = env(env_name) {
                        for url in parse_whitespace_or_comma_http_urls(&raw) {
                            if !adapter.http_rpc_urls.contains(&url) {
                                adapter.http_rpc_urls.push(url);
                            }
                        }
                    }
                }
                for env_name in row
                    .chronik_upstream_env
                    .iter()
                    .chain(row.chronik_upstream_envs.iter())
                {
                    if let Some(raw) = env(env_name) {
                        for url in parse_whitespace_or_comma_http_urls(&raw) {
                            if !adapter.chronik_urls.contains(&url) {
                                adapter.chronik_urls.push(url);
                            }
                        }
                    }
                }
                for env_name in row
                    .electrum_upstream_env
                    .iter()
                    .chain(row.electrum_upstream_envs.iter())
                {
                    if let Some(raw) = env(env_name) {
                        for token in raw
                            .split([',', ' ', '\n', '\t'])
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            if !adapter.electrum_urls.iter().any(|u| u == token) {
                                adapter.electrum_urls.push(token.to_string());
                            }
                        }
                    }
                }
            }
        }

        if conf.solana_proxy.enabled {
            for row in &conf.solana_proxy.chains {
                let Some(adapter) = registry.adapters.get_mut(&row.id) else {
                    continue;
                };
                for env_name in std::iter::once(&row.upstream_env).chain(row.upstream_envs.iter()) {
                    if let Some(raw) = env(env_name) {
                        for url in parse_whitespace_or_comma_http_urls(&raw) {
                            if !adapter.http_rpc_urls.contains(&url) {
                                adapter.http_rpc_urls.push(url);
                            }
                        }
                    }
                }
            }
        }

        if conf.monad_mailbox.enabled {
            if let (Some(expected_chain_id), Some(rpc_url)) = (
                conf.monad_mailbox.expected_chain_id,
                conf.monad_mailbox.rpc_url.as_ref(),
            ) {
                if let Some(protocol) = protocol_chain_by_evm_chain_id(expected_chain_id) {
                    if let Some(adapter) = registry.adapters.get_mut(&protocol.id) {
                        if !adapter.http_rpc_urls.contains(rpc_url) {
                            adapter.http_rpc_urls.insert(0, rpc_url.clone());
                        }
                    }
                }
            }
        }

        registry
    }

    /// Resolve the Monad mailbox RPC URL from [`RegistryConf`] and `env`.
    ///
    /// Resolution order when `conf.monad_mailbox.enabled` is true and `rpc_url` is omitted:
    /// 1. If `conf.evm_rpc` configures a chain matching `monad_mailbox.expected_chain_id` (or its
    ///    canonical `protocol_chain` ID) and its `upstream_env` / `upstream_envs` is set in `env`,
    ///    validate that comma-separated URL list and select its first URL.
    /// 2. Otherwise fall back to `default_rpc_env` (`MONAD_TESTNET_HTTP_RPC_URL`), validating its
    ///    comma-separated URL list and selecting its first URL.
    pub fn resolve_mailbox_rpc_url(
        conf: &RegistryConf,
        default_rpc_env: &str,
        env: impl Fn(&str) -> Option<String>,
    ) -> std::result::Result<Option<Url>, RelayChainRegistryError> {
        if !conf.monad_mailbox.enabled {
            return Ok(None);
        }
        if let Some(explicit) = &conf.monad_mailbox.rpc_url {
            return Ok(Some(explicit.clone()));
        }

        if let Some(expected_chain_id) = conf.monad_mailbox.expected_chain_id {
            let canonical_id =
                protocol_chain_by_evm_chain_id(expected_chain_id).map(|row| row.id.as_str());
            if let Some(evm_row) = conf.evm_rpc.chains.iter().find(|row| {
                row.expected_chain_id == expected_chain_id
                    || canonical_id.is_some_and(|id| row.id == id)
            }) {
                for env_name in
                    std::iter::once(&evm_row.upstream_env).chain(evm_row.upstream_envs.iter())
                {
                    if let Some(raw) = env(env_name) {
                        if !raw.trim().is_empty() {
                            let urls = parse_comma_separated_http_urls(env_name, &raw)?;
                            return Ok(urls.into_iter().next());
                        } else if env_name == default_rpc_env {
                            return Err(RelayChainRegistryError::MissingRpcUrlEnv {
                                env_name: default_rpc_env.to_string(),
                            });
                        }
                    }
                }
            }
        }

        let raw =
            env(default_rpc_env).ok_or_else(|| RelayChainRegistryError::MissingRpcUrlEnv {
                env_name: default_rpc_env.to_string(),
            })?;
        let urls = parse_comma_separated_http_urls(default_rpc_env, &raw)?;
        Ok(urls.into_iter().next())
    }

    /// Look up a [`RelayChainAdapter`] by canonical `chain_id` (e.g. `monad-testnet`).
    pub fn adapter(&self, chain_id: &str) -> Option<&RelayChainAdapter> {
        let canonical = protocol_chain(chain_id)
            .map(|row| row.id.as_str())
            .unwrap_or(chain_id);
        self.adapters.get(canonical)
    }

    /// Look up a mutable [`RelayChainAdapter`] by canonical `chain_id`.
    pub fn adapter_mut(&mut self, chain_id: &str) -> Option<&mut RelayChainAdapter> {
        self.adapters.get_mut(chain_id)
    }

    /// Look up a [`RelayChainAdapter`] by 4-byte wire tag (`b"MONT"`), canonical `chain_id`, or
    /// CAIP-2 string (`b"eip155:10143"`).
    pub fn adapter_by_tag(&self, tag_or_id: &[u8]) -> Option<&RelayChainAdapter> {
        let descriptor = protocol_chain_for_tag(tag_or_id)?;
        self.adapters.get(&descriptor.id)
    }

    /// Look up a [`RelayChainAdapter`] by numeric EIP-155 chain ID (e.g. `10143`, `143`, `1`).
    pub fn adapter_by_evm_chain_id(&self, evm_chain_id: u64) -> Option<&RelayChainAdapter> {
        let descriptor = protocol_chain_by_evm_chain_id(evm_chain_id)?;
        self.adapters.get(&descriptor.id)
    }

    /// Iterate over all registered [`RelayChainAdapter`]s in canonical `chain_id` order.
    pub fn chains(&self) -> impl Iterator<Item = &RelayChainAdapter> {
        self.adapters.values()
    }

    /// Return all registered [`RelayChainAdapter`]s belonging to `family`.
    pub fn chains_by_family(&self, family: ProtocolChainFamily) -> Vec<&RelayChainAdapter> {
        self.adapters
            .values()
            .filter(|adapter| adapter.family() == family)
            .collect()
    }

    /// Return all [`RelayChainAdapter`]s that currently have at least one configured upstream URL.
    pub fn configured_chains(&self) -> Vec<&RelayChainAdapter> {
        self.adapters
            .values()
            .filter(|adapter| adapter.has_configured_upstream())
            .collect()
    }

    /// Canonical protocol chain IDs accepted by this relay for stamp admission and topic burns.
    ///
    /// Does not restrict wallet RPC/indexer proxy routes (`/chain-rpc/:chain/*`).
    pub fn accepted_payment_networks(&self) -> &[String] {
        &self.accepted_payment_networks
    }

    /// Override the accepted stamp/burn payment networks on this registry.
    pub fn with_accepted_payment_networks(mut self, networks: Vec<String>) -> Self {
        self.accepted_payment_networks = networks;
        self
    }

    /// Whether `chain_id_or_tag` (canonical chain ID, 4-byte wire tag, or CAIP-2 string) is an
    /// accepted stamp/burn payment network on this relay.
    pub fn is_payment_network_accepted(&self, chain_id_or_tag: &str) -> bool {
        let resolved_id = self
            .adapter(chain_id_or_tag)
            .or_else(|| self.adapter_by_tag(chain_id_or_tag.as_bytes()))
            .map(RelayChainAdapter::chain_id)
            .unwrap_or(chain_id_or_tag);
        self.accepted_payment_networks
            .iter()
            .any(|accepted| accepted == resolved_id)
    }

    /// Resolve the topic burn verification policy for `chain_id_or_tag` when that chain is in
    /// [`Self::accepted_payment_networks`].
    pub fn resolve_topic_burn_policy(
        &self,
        chain_id_or_tag: &str,
        burn_address: crate::monad_http::Address,
    ) -> Option<TopicBurnNetworkConfig> {
        if !self.is_payment_network_accepted(chain_id_or_tag) {
            return None;
        }
        let adapter = self
            .adapter(chain_id_or_tag)
            .or_else(|| self.adapter_by_tag(chain_id_or_tag.as_bytes()))?;
        Some(TopicBurnNetworkConfig {
            chain_id: adapter.chain_id().to_string(),
            evm_chain_id: adapter.evm_chain_id(),
            rpc_urls: adapter.http_rpc_urls().to_vec(),
            burn_address,
        })
    }
}

#[cfg(test)]
mod tests {
    use cashweb_config::parse_conf;

    use super::*;

    const LOCAL_CONF: &str = include_str!("../../cashwebd.local.toml");

    #[test]
    fn registers_every_protocol_chain_from_v1_json() {
        let registry = RelayChainRegistry::from_protocol_registry();
        let expected_count = protocol_chain_registry().chains.len();
        assert_eq!(registry.chains().count(), expected_count);

        let monad_testnet = registry.adapter("monad-testnet").unwrap();
        assert_eq!(monad_testnet.family(), ProtocolChainFamily::Evm);
        assert_eq!(monad_testnet.network(), "testnet");
        assert_eq!(monad_testnet.evm_chain_id(), Some(10_143));
        assert_eq!(monad_testnet.network_tag(), Some(b"MONT"));
        assert_eq!(monad_testnet.caip2(), "eip155:10143");

        assert_eq!(
            registry.adapter_by_tag(b"MONT").unwrap().chain_id(),
            "monad-testnet"
        );
        assert_eq!(
            registry.adapter_by_tag(b"eip155:143").unwrap().chain_id(),
            "monad-mainnet"
        );
        assert_eq!(
            registry.adapter_by_evm_chain_id(8453).unwrap().chain_id(),
            "base-mainnet"
        );
        assert_eq!(
            registry.adapter_by_tag(b"SOL1").unwrap().chain_id(),
            "solana-mainnet"
        );
        assert_eq!(
            registry.adapter_by_tag(b"XECT").unwrap().chain_id(),
            "xec-testnet"
        );
    }

    #[test]
    fn resolves_configured_upstreams_across_evm_bitcoin_and_solana_families() {
        let conf = parse_conf(LOCAL_CONF).unwrap();
        let vars = [
            (
                "MONAD_TESTNET_HTTP_RPC_URL",
                "https://testnet-rpc.monad.example,https://backup-rpc.monad.example",
            ),
            ("MONAD_TESTNET_WS_RPC_URL", "wss://testnet-ws.monad.example"),
            (
                "XEC_TESTNET_CHRONIK_URL",
                "https://chronik-testnet.ecash.example",
            ),
            (
                "BTC_TESTNET_ELECTRUM_URL",
                "ssl://electrum-testnet.btc.example:50002",
            ),
            (
                "SOLANA_DEVNET_HTTP_RPC_URL",
                "https://api.devnet.solana.example",
            ),
        ];
        let registry = RelayChainRegistry::from_conf_with_env(&conf.registry, |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_string())
        });

        let monad = registry.adapter("monad-testnet").unwrap();
        assert_eq!(monad.http_rpc_urls().len(), 2);
        assert_eq!(
            monad.primary_http_rpc_url().unwrap().as_str(),
            "https://testnet-rpc.monad.example/"
        );
        assert_eq!(
            monad.ws_rpc_url().unwrap().as_str(),
            "wss://testnet-ws.monad.example/"
        );
        assert!(monad.evm_http_transport().is_some());
        assert_eq!(monad.evm_http_transports().len(), 2);
        assert!(monad.evm_http_client().is_some());
        assert!(monad.evm_block_subscriber().is_some());

        let xec = registry.adapter("xec-testnet").unwrap();
        assert_eq!(xec.chronik_urls().len(), 1);
        assert_eq!(
            xec.configured_capabilities(),
            vec![ProtocolProxyCapability::Chronik]
        );

        let btc = registry.adapter("btc-testnet").unwrap();
        assert_eq!(
            btc.electrum_urls(),
            &["ssl://electrum-testnet.btc.example:50002".to_string()]
        );

        let solana = registry.adapter("solana-devnet").unwrap();
        assert_eq!(
            solana.primary_http_rpc_url().unwrap().as_str(),
            "https://api.devnet.solana.example/"
        );

        // Payment networks scope stamps/burns to monad-testnet while keeping all wallet chains
        // available for RPC/Chronik/Electrum proxy use.
        assert_eq!(
            registry.accepted_payment_networks(),
            &["monad-testnet".to_string()]
        );
        assert!(registry.is_payment_network_accepted("monad-testnet"));
        assert!(registry.is_payment_network_accepted("MONT"));
        assert!(!registry.is_payment_network_accepted("solana-devnet"));
        assert!(!registry.is_payment_network_accepted("tempo-testnet"));

        let burn_sink = crate::monad_http::Address([0x11; 20]);
        let burn_policy = registry
            .resolve_topic_burn_policy("monad-testnet", burn_sink)
            .unwrap();
        assert_eq!(burn_policy.chain_id, "monad-testnet");
        assert_eq!(burn_policy.evm_chain_id, Some(10_143));
        assert_eq!(burn_policy.rpc_urls.len(), 2);
        assert_eq!(burn_policy.burn_address, burn_sink);
        assert!(registry
            .resolve_topic_burn_policy("solana-devnet", burn_sink)
            .is_none());
    }

    #[test]
    fn mailbox_rpc_url_falls_back_to_matching_evm_rpc_chain_upstream() {
        let mainnet_toml = LOCAL_CONF
            .replace("id = \"monad-testnet\"", "id = \"monad-mainnet\"")
            .replace("expected_chain_id = 10143", "expected_chain_id = 143")
            .replace(
                "upstream_env = \"MONAD_TESTNET_HTTP_RPC_URL\"",
                "upstream_env = \"MONAD_MAINNET_HTTP_RPC_URL\"",
            )
            .replace(
                "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9",
                "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9",
            );
        let conf = parse_conf(&mainnet_toml).unwrap();
        let resolved = RelayChainRegistry::resolve_mailbox_rpc_url(
            &conf.registry,
            "MONAD_TESTNET_HTTP_RPC_URL",
            |name| match name {
                "MONAD_MAINNET_HTTP_RPC_URL" => {
                    Some("https://mainnet-rpc.monad.example,https://backup.monad.example".into())
                }
                _ => None,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(resolved.as_str(), "https://mainnet-rpc.monad.example/");
    }

    #[test]
    fn decodes_stamp_commitment_statelessly() {
        use bitcoinsuite_core::Hashed;

        let registry = RelayChainRegistry::from_protocol_registry();
        let monad = registry.adapter("monad-testnet").unwrap();

        let expected = Sha256::new([0x42; 32]);
        let mut calldata = Vec::new();
        calldata.extend_from_slice(b"STMP");
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(expected.as_slice());

        let decoded = monad.decode_stamp_commitment(*b"STMP", &calldata).unwrap();
        assert_eq!(decoded, expected);
    }
}
