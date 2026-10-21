//! Bitcoin-family (UTXO) chain adapter: one per configured `[[registry.bitcoin_proxy.chains]]`
//! row.

use std::{fmt, time::Duration};

use bitcoinsuite_chronik_client::proto;
use cashweb_config::{BitcoinProxyChainConf, ProtocolChainDescriptor, ProtocolProxyCapability};
use prost::Message;
use serde_json::json;
use url::Url;

use super::{
    get_startup_bytes, post_startup_json,
    upstreams::{resolve_urls, UpstreamSet},
    ChainsStartError, IdentityError,
};
use crate::http::json_rpc::JsonRpcVersion;

/// One Bitcoin-family network the relay is configured for: node JSON-RPC and Chronik upstreams,
/// each verified at the chain's checkpoint before it carries traffic, and Electrum upstreams,
/// which are verified on every connection instead (`http/electrum_proxy.rs`).
pub struct BitcoinChainAdapter {
    descriptor: &'static ProtocolChainDescriptor,
    rpc: UpstreamSet,
    chronik: UpstreamSet,
    electrum_urls: Vec<Url>,
    checkpoint_height: u64,
    /// Lowercase conventional (big-endian) block hash.
    checkpoint_hash: String,
    client: reqwest::Client,
    timeout: Duration,
}

impl BitcoinChainAdapter {
    /// Build the adapter for `row`, resolving its secret upstream URLs from `env`. A capability
    /// that is configured but whose variables are all unset is a startup error.
    pub(crate) fn from_row(
        row: &BitcoinProxyChainConf,
        timeout: Duration,
        env: &impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ChainsStartError> {
        let resolve = |primary: &Option<String>, extras: &[String], schemes: &[&str]| {
            let names = primary
                .iter()
                .chain(extras.iter())
                .map(String::as_str)
                .collect::<Vec<_>>();
            let Some(first) = names.first() else {
                return Ok(Vec::new());
            };
            let urls = resolve_urls(names.iter().copied(), schemes, env)
                .map_err(ChainsStartError::InvalidUpstream)?;
            if urls.is_empty() {
                return Err(ChainsStartError::MissingUpstream(first.to_string()));
            }
            Ok(urls)
        };
        let http = ["http", "https"];
        let descriptor = cashweb_config::protocol_chain(&row.id).ok_or_else(|| {
            ChainsStartError::InvalidConfig(format!("{} is not a registry chain", row.id))
        })?;
        Ok(Self {
            descriptor,
            rpc: UpstreamSet::new(resolve(
                &row.rpc_upstream_env,
                &row.rpc_upstream_envs,
                &http,
            )?),
            chronik: UpstreamSet::new(resolve(
                &row.chronik_upstream_env,
                &row.chronik_upstream_envs,
                &http,
            )?),
            electrum_urls: resolve(
                &row.electrum_upstream_env,
                &row.electrum_upstream_envs,
                &["tcp", "ssl", "ws", "wss"],
            )?,
            checkpoint_height: row.checkpoint_height,
            checkpoint_hash: row.checkpoint_hash.to_ascii_lowercase(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| ChainsStartError::InvalidConfig("HTTP client".to_string()))?,
            timeout,
        })
    }

    /// An adapter for local test endpoints whose identity the test is not about: its node and
    /// Chronik upstreams count as verified. The checkpoint is a placeholder.
    #[cfg(test)]
    pub(crate) fn assume_verified(id: &str, rpc: Vec<Url>, chronik: Vec<Url>) -> Self {
        let adapter = Self {
            descriptor: cashweb_config::protocol_chain(id).expect("registry chain"),
            rpc: UpstreamSet::new(rpc),
            chronik: UpstreamSet::new(chronik),
            electrum_urls: Vec::new(),
            checkpoint_height: 1,
            checkpoint_hash: "00".repeat(32),
            client: reqwest::Client::new(),
            timeout: Duration::from_secs(10),
        };
        adapter.rpc.assume_verified();
        adapter.chronik.assume_verified();
        adapter
    }

    /// Canonical chain identifier, e.g. `xec-testnet`.
    pub fn id(&self) -> &'static str {
        self.descriptor.id.as_str()
    }

    /// The chain's row in `docs/protocol/chains/v1.json`.
    pub fn descriptor(&self) -> &'static ProtocolChainDescriptor {
        self.descriptor
    }

    /// Node JSON-RPC upstreams and their identity verdicts.
    pub fn rpc_upstreams(&self) -> &UpstreamSet {
        &self.rpc
    }

    /// Chronik upstreams and their identity verdicts.
    pub fn chronik_upstreams(&self) -> &UpstreamSet {
        &self.chronik
    }

    /// Electrum upstreams. Each connection proves the chain's identity before carrying a frame.
    pub fn electrum_urls(&self) -> &[Url] {
        &self.electrum_urls
    }

    /// The block `(height, lowercase hash)` every upstream must have.
    pub fn checkpoint(&self) -> (u64, &str) {
        (self.checkpoint_height, self.checkpoint_hash.as_str())
    }

    /// Proxy capabilities backed by a configured upstream.
    pub fn configured_capabilities(&self) -> Vec<ProtocolProxyCapability> {
        [
            self.rpc
                .is_configured()
                .then_some(ProtocolProxyCapability::JsonRpc),
            self.chronik
                .is_configured()
                .then_some(ProtocolProxyCapability::Chronik),
            (!self.electrum_urls.is_empty()).then_some(ProtocolProxyCapability::Electrum),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// Probe every node and Chronik upstream not yet verified; mark those that pass. Returns
    /// whether all are now verified.
    pub(crate) async fn verify_pending(&self) -> bool {
        let rpc = self.rpc.pending().map(|upstream| async move {
            self.record(self.probe_rpc(upstream.url()).await, || {
                upstream.mark_verified()
            });
        });
        let chronik = self.chronik.pending().map(|upstream| async move {
            self.record(self.probe_chronik(upstream.url()).await, || {
                upstream.mark_verified()
            });
        });
        tokio::join!(
            futures::future::join_all(rpc),
            futures::future::join_all(chronik)
        );
        self.rpc.all_verified() && self.chronik.all_verified()
    }

    fn record(&self, outcome: Result<(), IdentityError>, verified: impl FnOnce()) {
        match outcome {
            Ok(()) => verified(),
            Err(error) => tracing::error!(
                chain = %self.id(),
                error = %error,
                "A Bitcoin-family upstream is NOT used: it did not pass the checkpoint check. It \
                 is checked again until it passes; the chain's verified upstreams carry on"
            ),
        }
    }

    /// Check that the node at `url` has the checkpoint block.
    pub(crate) async fn probe_rpc(&self, url: &Url) -> Result<(), IdentityError> {
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let body = json!({
            "jsonrpc": "1.0",
            "id": "startup",
            "method": "getblockhash",
            "params": [self.checkpoint_height]
        });
        let bytes = post_startup_json(&self.client, url, &body, self.timeout)
            .await
            .ok_or_else(unavailable)?;
        let actual = crate::http::json_rpc::startup_result(
            &bytes,
            JsonRpcVersion::Legacy,
            &json!("startup"),
        )
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(unavailable)?;
        if !actual.eq_ignore_ascii_case(&self.checkpoint_hash) {
            return Err(IdentityError::CheckpointMismatch(self.id().to_string()));
        }
        Ok(())
    }

    /// Check that the Chronik indexer at `base` has the checkpoint block.
    pub(crate) async fn probe_chronik(&self, base: &Url) -> Result<(), IdentityError> {
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let url = crate::http::bitcoin_proxy::chronik_endpoint_url(
            base,
            &format!("block/{}", self.checkpoint_height),
            None,
        )
        .map_err(|_| unavailable())?;
        let bytes = get_startup_bytes(&self.client, url, self.timeout)
            .await
            .ok_or_else(unavailable)?;
        let mut hash = proto::Block::decode(bytes.as_ref())
            .ok()
            .and_then(|block| block.block_info)
            .ok_or_else(unavailable)?
            .hash;
        hash.reverse();
        if hex::encode(hash) != self.checkpoint_hash {
            return Err(IdentityError::CheckpointMismatch(self.id().to_string()));
        }
        Ok(())
    }
}

impl fmt::Debug for BitcoinChainAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitcoinChainAdapter")
            .field("id", &self.id())
            .field("rpc", &self.rpc)
            .field("chronik", &self.chronik)
            .field("electrum_urls_count", &self.electrum_urls.len())
            .field("checkpoint_height", &self.checkpoint_height)
            .finish()
    }
}
