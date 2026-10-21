//! The relay's configured networks and one chain adapter for each.
//!
//! At startup the relay builds [`RelayChains`] once from its configuration: its own network
//! (`registry.network`, a canonical identifier from `docs/protocol/chains/v1.json`) and one
//! adapter per configured chain row, by family as peers: [`EvmChainAdapter`],
//! [`BitcoinChainAdapter`] and [`SolanaChainAdapter`]. Each adapter owns its chain's upstreams and
//! the identity verdict of every one of them; an upstream carries traffic only after it has
//! answered the registry's identity probes (EVM chain id and checkpoint block, Bitcoin-family
//! checkpoint block, Solana genesis hash). Upstreams that have not are probed again in the
//! background, so one that is down at startup costs nothing but itself.
//!
//! The adapters are handed explicitly to what needs them: the mailbox and the forum take the
//! network's EVM adapter, the chain RPC proxies take their family's adapters, and `GET /chains`
//! reads what is configured. Nothing reads the network from the environment, and nothing falls
//! back to a default network: a missing or unknown network is a startup error.

pub mod bitcoin;
pub mod evm;
pub mod solana;
pub mod upstreams;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use axum::body::Bytes;
use cashweb_config::{
    BitcoinProxyConf, EvmRpcConf, ProtocolChainDescriptor, ProtocolProxyCapability, RegistryConf,
    SolanaProxyConf,
};
use url::Url;

pub use self::{
    bitcoin::BitcoinChainAdapter, evm::EvmChainAdapter, solana::SolanaChainAdapter,
    upstreams::UpstreamSet,
};

/// Longest a startup identity response may be.
const MAX_STARTUP_RESPONSE_BYTES: usize = 1024 * 1024;
/// Longest startup waits for the first identity check of every upstream.
pub(crate) const STARTUP_WAIT: Duration = Duration::from_secs(2);
/// How often an upstream that has not yet proved its identity is asked again.
pub(crate) const IDENTITY_RETRY: Duration = if cfg!(test) {
    Duration::from_millis(50)
} else {
    Duration::from_secs(30)
};

/// Why the relay's chains could not be built. Never contains an upstream URL.
#[derive(Debug, thiserror::Error)]
pub enum ChainsStartError {
    /// The configuration is invalid.
    #[error("{0}")]
    InvalidConfig(String),
    /// The named environment variable does not hold hosted URLs of the transport it is for.
    #[error("upstream environment variable {0} is not a valid hosted URL list for its transport")]
    InvalidUpstream(String),
    /// The named environment variable, required by the configuration, is unset or blank.
    #[error("upstream environment variable {0} is not set")]
    MissingUpstream(String),
    /// The mailbox or forum is on, and the relay network has no upstream to verify payments on.
    #[error(
        "relay network {network}: the mailbox and the forum need its upstream, and environment \
         variable {env} is not set"
    )]
    MissingNetworkUpstream {
        /// Canonical chain identifier of the relay network.
        network: String,
        /// The variable its `[[registry.evm_rpc.chains]]` row names.
        env: String,
    },
}

/// Why an upstream did not prove it is the configured chain. Never contains its URL.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum IdentityError {
    /// The upstream did not give a usable answer.
    #[error("chain {0}: the upstream did not answer the identity probe")]
    Unavailable(String),
    /// An EVM upstream reported another chain id.
    #[error("chain {id}: the upstream reported chain id {actual}, expected {expected}")]
    ChainIdMismatch {
        /// Canonical chain identifier.
        id: String,
        /// The chain's EIP-155 id.
        expected: u64,
        /// What the upstream reported.
        actual: u64,
    },
    /// The upstream does not have the chain's checkpoint block.
    #[error("chain {0}: the upstream does not have the checkpoint block")]
    CheckpointMismatch(String),
    /// A Solana upstream reported another genesis hash.
    #[error("chain {0}: the upstream reported another genesis hash")]
    GenesisHashMismatch(String),
}

/// The relay's network and the adapters of every chain it is configured for.
#[derive(Debug)]
pub struct RelayChains {
    network: &'static ProtocolChainDescriptor,
    network_tag: &'static [u8; 4],
    evm: BTreeMap<&'static str, Arc<EvmChainAdapter>>,
    bitcoin: BTreeMap<&'static str, Arc<BitcoinChainAdapter>>,
    solana: BTreeMap<&'static str, Arc<SolanaChainAdapter>>,
}

impl RelayChains {
    /// Build the relay's chains from its configuration, resolving secret upstream URLs from
    /// `env`. Nothing is probed yet: see [`Self::start_verifying`].
    ///
    /// When the mailbox or the forum is on, the network's EVM row must have an upstream URL set:
    /// both verify payments through it.
    pub fn from_conf(
        conf: &RegistryConf,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ChainsStartError> {
        let network = conf
            .validate_network()
            .map_err(|error| ChainsStartError::InvalidConfig(error.to_string()))?;
        let chains = Self::from_families(
            &network.id,
            &conf.evm_rpc,
            &conf.bitcoin_proxy,
            &conf.solana_proxy,
            env,
        )?;
        if (conf.monad_mailbox.enabled || conf.forum.is_some())
            && chains.network_adapter().is_none()
        {
            let row = conf
                .evm_rpc
                .chains
                .iter()
                .find(|row| row.id == network.id)
                .expect("validate_network requires the network's row");
            return Err(ChainsStartError::MissingNetworkUpstream {
                network: network.id.clone(),
                env: row.upstream_env.clone(),
            });
        }
        Ok(chains)
    }

    /// A relay on `network` that proxies no chain: no mailbox, forum or chain RPC can be served.
    pub fn network_only(network: &str) -> Result<Self, ChainsStartError> {
        Self::from_families(
            network,
            &Default::default(),
            &Default::default(),
            &Default::default(),
            |_| None,
        )
    }

    /// Build adapters for the rows of each enabled family, on `network`.
    pub fn from_families(
        network: &str,
        evm: &EvmRpcConf,
        bitcoin: &BitcoinProxyConf,
        solana: &SolanaProxyConf,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ChainsStartError> {
        let unknown = || ChainsStartError::InvalidConfig(format!("unknown network {network:?}"));
        let network = cashweb_config::protocol_chain(network).ok_or_else(unknown)?;
        let network_tag =
            crate::network_tag::network_tag_for_chain_id(&network.id).ok_or_else(unknown)?;
        let invalid =
            |error: &dyn std::fmt::Display| ChainsStartError::InvalidConfig(error.to_string());
        evm.validate().map_err(|error| invalid(&error))?;
        bitcoin.validate().map_err(|error| invalid(&error))?;
        solana.validate().map_err(|error| invalid(&error))?;
        let mut chains = Self {
            network,
            network_tag,
            evm: BTreeMap::new(),
            bitcoin: BTreeMap::new(),
            solana: BTreeMap::new(),
        };
        if evm.enabled {
            let timeout = Duration::from_millis(evm.timeout_ms);
            for row in &evm.chains {
                // A row with no URL set is not served; setting it and restarting serves it.
                if let Some(adapter) = EvmChainAdapter::from_row(row, timeout, &env)? {
                    chains.evm.insert(adapter.id(), Arc::new(adapter));
                }
            }
        }
        if bitcoin.enabled {
            let timeout = Duration::from_millis(bitcoin.timeout_ms);
            for row in &bitcoin.chains {
                let adapter = BitcoinChainAdapter::from_row(row, timeout, &env)?;
                chains.bitcoin.insert(adapter.id(), Arc::new(adapter));
            }
        }
        if solana.enabled {
            let timeout = Duration::from_millis(solana.timeout_ms);
            for row in &solana.chains {
                let adapter = SolanaChainAdapter::from_row(row, timeout, &env)?;
                chains.solana.insert(adapter.id(), Arc::new(adapter));
            }
        }
        Ok(chains)
    }

    /// Chains for a test: `network` with no adapter yet; add them with `with_*`.
    #[cfg(test)]
    pub(crate) fn for_test(network: &str) -> Self {
        Self::network_only(network).expect("registry chain")
    }

    /// `self` with `adapter` added.
    #[cfg(test)]
    pub(crate) fn with_evm(mut self, adapter: EvmChainAdapter) -> Self {
        self.evm.insert(adapter.id(), Arc::new(adapter));
        self
    }

    /// `self` with `adapter` added.
    #[cfg(test)]
    pub(crate) fn with_bitcoin(mut self, adapter: BitcoinChainAdapter) -> Self {
        self.bitcoin.insert(adapter.id(), Arc::new(adapter));
        self
    }

    /// The network this relay's directory, mailbox, forum and profiles run on.
    pub fn network(&self) -> &'static ProtocolChainDescriptor {
        self.network
    }

    /// Four-byte wire tag of [`Self::network`], bound into every signed relay request.
    pub fn network_tag(&self) -> &'static [u8; 4] {
        self.network_tag
    }

    /// The EVM adapter of [`Self::network`], when its row has an upstream configured.
    pub fn network_adapter(&self) -> Option<&Arc<EvmChainAdapter>> {
        self.evm.get(self.network.id.as_str())
    }

    /// The configured EVM chain `id`.
    pub fn evm(&self, id: &str) -> Option<&Arc<EvmChainAdapter>> {
        self.evm.get(id)
    }

    /// Every configured EVM chain, by identifier.
    pub fn evm_chains(&self) -> impl Iterator<Item = &Arc<EvmChainAdapter>> {
        self.evm.values()
    }

    /// The configured Bitcoin-family chain `id`.
    pub fn bitcoin(&self, id: &str) -> Option<&Arc<BitcoinChainAdapter>> {
        self.bitcoin.get(id)
    }

    /// Every configured Bitcoin-family chain, by identifier.
    pub fn bitcoin_chains(&self) -> impl Iterator<Item = &Arc<BitcoinChainAdapter>> {
        self.bitcoin.values()
    }

    /// The configured Solana chain `id`.
    pub fn solana(&self, id: &str) -> Option<&Arc<SolanaChainAdapter>> {
        self.solana.get(id)
    }

    /// Every configured Solana chain, by identifier.
    pub fn solana_chains(&self) -> impl Iterator<Item = &Arc<SolanaChainAdapter>> {
        self.solana.values()
    }

    /// Every configured chain with the proxy capabilities this relay advertises for it: those
    /// backed by a configured upstream that the protocol registry permits on that chain.
    pub fn advertised_capabilities(
        &self,
    ) -> Vec<(
        &'static ProtocolChainDescriptor,
        Vec<ProtocolProxyCapability>,
    )> {
        let evm = self
            .evm
            .values()
            .map(|chain| (chain.descriptor(), chain.configured_capabilities()));
        let bitcoin = self
            .bitcoin
            .values()
            .map(|chain| (chain.descriptor(), chain.configured_capabilities()));
        let solana = self
            .solana
            .values()
            .map(|chain| (chain.descriptor(), chain.configured_capabilities()));
        let mut chains = evm
            .chain(bitcoin)
            .chain(solana)
            .map(|(descriptor, configured)| {
                let permitted = configured
                    .into_iter()
                    .filter(|capability| descriptor.allowed_proxy_capabilities.contains(capability))
                    .collect::<Vec<_>>();
                (descriptor, permitted)
            })
            .filter(|(_, capabilities)| !capabilities.is_empty())
            .collect::<Vec<_>>();
        chains.sort_by(|left, right| left.0.id.cmp(&right.0.id));
        chains
    }

    /// Probe every upstream not yet verified, on every chain at once. Returns whether all are
    /// now verified.
    pub(crate) async fn verify_pending(&self) -> bool {
        let (evm, bitcoin, solana) = tokio::join!(
            futures::future::join_all(self.evm.values().map(|chain| chain.verify_pending())),
            futures::future::join_all(self.bitcoin.values().map(|chain| chain.verify_pending())),
            futures::future::join_all(self.solana.values().map(|chain| chain.verify_pending())),
        );
        evm.into_iter()
            .chain(bitcoin)
            .chain(solana)
            .all(|verified| verified)
    }

    /// Check every upstream's identity in the background, again and again until all pass or the
    /// relay stops. Startup waits only briefly for the first round, so a healthy upstream is
    /// verified before the first request and a dead one never holds the relay up.
    pub async fn start_verifying(self: &Arc<Self>) {
        let chains = Arc::downgrade(self);
        let (first_round, first_round_done) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut first_round = Some(first_round);
            loop {
                let Some(chains) = chains.upgrade() else {
                    return;
                };
                let all_verified = chains.verify_pending().await;
                drop(chains);
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
}

/// POST a JSON body to `url` and return the bounded response body of a 2xx answer.
async fn post_startup_json(
    client: &reqwest::Client,
    url: &Url,
    body: &serde_json::Value,
    timeout: Duration,
) -> Option<Bytes> {
    let request = client
        .post(url.clone())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(body).expect("JSON value serializes"));
    startup_response(request, timeout).await
}

/// GET `url` and return the bounded response body of a 2xx answer.
async fn get_startup_bytes(client: &reqwest::Client, url: Url, timeout: Duration) -> Option<Bytes> {
    startup_response(client.get(url), timeout).await
}

async fn startup_response(request: reqwest::RequestBuilder, timeout: Duration) -> Option<Bytes> {
    tokio::time::timeout(timeout, async {
        let mut response = request.send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > MAX_STARTUP_RESPONSE_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        Some(Bytes::from(bytes))
    })
    .await
    .ok()
    .flatten()
}
