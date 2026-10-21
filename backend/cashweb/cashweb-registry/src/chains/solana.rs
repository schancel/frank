//! Solana-family chain adapter: one per configured `[[registry.solana_proxy.chains]]` row.

use std::{fmt, time::Duration};

use cashweb_config::{ProtocolChainDescriptor, ProtocolProxyCapability, SolanaProxyChainConf};
use serde_json::json;
use url::Url;

use super::{
    post_startup_json,
    upstreams::{resolve_urls, UpstreamSet},
    ChainsStartError, IdentityError,
};
use crate::http::json_rpc::JsonRpcVersion;

/// One Solana network the relay is configured for: its JSON-RPC upstreams, each verified
/// against the pinned genesis hash before it carries traffic.
pub struct SolanaChainAdapter {
    descriptor: &'static ProtocolChainDescriptor,
    http: UpstreamSet,
    expected_genesis_hash: String,
    client: reqwest::Client,
    timeout: Duration,
}

impl SolanaChainAdapter {
    /// Build the adapter for `row`, resolving its secret upstream URLs from `env`. A row whose
    /// variables are all unset is a startup error.
    pub(crate) fn from_row(
        row: &SolanaProxyChainConf,
        timeout: Duration,
        env: &impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ChainsStartError> {
        let urls = resolve_urls(
            std::iter::once(row.upstream_env.as_str())
                .chain(row.upstream_envs.iter().map(String::as_str)),
            &["http", "https"],
            env,
        )
        .map_err(ChainsStartError::InvalidUpstream)?;
        if urls.is_empty() {
            return Err(ChainsStartError::MissingUpstream(row.upstream_env.clone()));
        }
        let descriptor = cashweb_config::protocol_chain(&row.id).ok_or_else(|| {
            ChainsStartError::InvalidConfig(format!("{} is not a registry chain", row.id))
        })?;
        Ok(Self {
            descriptor,
            http: UpstreamSet::new(urls),
            expected_genesis_hash: row.expected_genesis_hash.clone(),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| ChainsStartError::InvalidConfig("HTTP client".to_string()))?,
            timeout,
        })
    }

    /// Canonical chain identifier, e.g. `solana-devnet`.
    pub fn id(&self) -> &'static str {
        self.descriptor.id.as_str()
    }

    /// The chain's row in `docs/protocol/chains/v1.json`.
    pub fn descriptor(&self) -> &'static ProtocolChainDescriptor {
        self.descriptor
    }

    /// The JSON-RPC upstreams and their identity verdicts.
    pub fn http_upstreams(&self) -> &UpstreamSet {
        &self.http
    }

    /// Proxy capabilities backed by a configured upstream.
    pub fn configured_capabilities(&self) -> Vec<ProtocolProxyCapability> {
        vec![ProtocolProxyCapability::JsonRpc]
    }

    /// Probe every upstream not yet verified; mark those that pass. Returns whether all are now
    /// verified.
    pub(crate) async fn verify_pending(&self) -> bool {
        let probes = self.http.pending().map(|upstream| async move {
            match self.probe(upstream.url()).await {
                Ok(()) => upstream.mark_verified(),
                Err(error) => tracing::error!(
                    chain = %self.id(),
                    error = %error,
                    "A Solana upstream is NOT used: it did not pass the genesis hash check. It is \
                     checked again until it passes; the chain's verified upstreams carry on"
                ),
            }
        });
        futures::future::join_all(probes).await;
        self.http.all_verified()
    }

    /// Check that `url` reports the chain's genesis hash.
    pub(crate) async fn probe(&self, url: &Url) -> Result<(), IdentityError> {
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let body = json!({"jsonrpc": "2.0", "id": "startup", "method": "getGenesisHash"});
        let bytes = post_startup_json(&self.client, url, &body, self.timeout)
            .await
            .ok_or_else(unavailable)?;
        let actual =
            crate::http::json_rpc::startup_result(&bytes, JsonRpcVersion::V2, &json!("startup"))
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(unavailable)?;
        if actual != self.expected_genesis_hash {
            return Err(IdentityError::GenesisHashMismatch(self.id().to_string()));
        }
        Ok(())
    }
}

impl fmt::Debug for SolanaChainAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SolanaChainAdapter")
            .field("id", &self.id())
            .field("http", &self.http)
            .field("expected_genesis_hash", &self.expected_genesis_hash)
            .finish()
    }
}
