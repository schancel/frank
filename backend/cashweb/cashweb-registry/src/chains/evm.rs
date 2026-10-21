//! EVM-family chain adapter: one per configured `[[registry.evm_rpc.chains]]` row.

use std::{fmt, time::Duration};

use cashweb_config::{EvmRpcChainConf, ProtocolChainDescriptor, ProtocolProxyCapability};
use serde_json::{json, Value};
use url::Url;

use super::{
    post_startup_json,
    upstreams::{resolve_urls, UpstreamSet},
    ChainsStartError, IdentityError,
};
use crate::{http::json_rpc::JsonRpcVersion, monad_http::HttpTransport};

/// One EVM network the relay is configured for: its protocol identity, its upstreams and
/// whether each has proved it is this chain.
///
/// The mailbox, the forum and the chain RPC proxy all reach the chain through this adapter, and
/// only through upstreams that have answered `eth_chainId` and the registry checkpoint.
pub struct EvmChainAdapter {
    descriptor: &'static ProtocolChainDescriptor,
    evm_chain_id: u64,
    network_tag: &'static [u8; 4],
    http: UpstreamSet,
    ws_url: Option<Url>,
    checkpoint: (u64, String),
    max_get_logs_range: u64,
    /// Probe and transport client: no redirects, every request bounded by `timeout`.
    client: reqwest::Client,
    timeout: Duration,
}

impl EvmChainAdapter {
    /// Build the adapter for `row`, resolving its secret upstream URLs from `env`. `Ok(None)`
    /// when no upstream URL is set: the row is not served.
    pub(crate) fn from_row(
        row: &EvmRpcChainConf,
        timeout: Duration,
        env: &impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, ChainsStartError> {
        let urls = resolve_urls(
            std::iter::once(row.upstream_env.as_str())
                .chain(row.upstream_envs.iter().map(String::as_str)),
            &["http", "https"],
            env,
        )
        .map_err(ChainsStartError::InvalidUpstream)?;
        if urls.is_empty() {
            return Ok(None);
        }
        let ws_url = match row.upstream_ws_env.as_deref() {
            Some(name) => resolve_urls([name], &["ws", "wss"], env)
                .map_err(ChainsStartError::InvalidUpstream)?
                .into_iter()
                .next(),
            None => None,
        };
        let checkpoint = row
            .checkpoint_block_number
            .zip(row.checkpoint_block_hash.clone())
            .ok_or_else(|| {
                ChainsStartError::InvalidConfig(format!("chain {} has no checkpoint", row.id))
            })?;
        Ok(Some(Self::new(
            &row.id,
            urls,
            ws_url,
            checkpoint,
            row.max_get_logs_range,
            timeout,
        )?))
    }

    fn new(
        id: &str,
        urls: Vec<Url>,
        ws_url: Option<Url>,
        checkpoint: (u64, String),
        max_get_logs_range: u64,
        timeout: Duration,
    ) -> Result<Self, ChainsStartError> {
        let unknown = || ChainsStartError::InvalidConfig(format!("{id} is not an EVM chain"));
        let descriptor = cashweb_config::protocol_chain(id).ok_or_else(unknown)?;
        let evm_chain_id = descriptor.evm_chain_id().ok_or_else(unknown)?;
        let network_tag = crate::network_tag::network_tag_for_chain_id(id).ok_or_else(unknown)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|_| ChainsStartError::InvalidConfig("HTTP client".to_string()))?;
        Ok(Self {
            descriptor,
            evm_chain_id,
            network_tag,
            http: UpstreamSet::new(urls),
            ws_url,
            checkpoint,
            max_get_logs_range,
            client,
            timeout,
        })
    }

    /// An adapter for a local test endpoint whose identity the test is not about: its upstreams
    /// count as verified. The checkpoint is a placeholder.
    #[cfg(test)]
    pub(crate) fn assume_verified(id: &str, urls: Vec<Url>) -> Self {
        let adapter = Self::new(
            id,
            urls,
            None,
            (0, format!("0x{}", "00".repeat(32))),
            10,
            Duration::from_secs(10),
        )
        .expect("test chain is a registry EVM chain");
        adapter.http.assume_verified();
        adapter
    }

    /// Canonical chain identifier, e.g. `monad-testnet`.
    pub fn id(&self) -> &'static str {
        self.descriptor.id.as_str()
    }

    /// The chain's row in `docs/protocol/chains/v1.json`.
    pub fn descriptor(&self) -> &'static ProtocolChainDescriptor {
        self.descriptor
    }

    /// EIP-155 chain id every transaction on this chain is signed for.
    pub fn evm_chain_id(&self) -> u64 {
        self.evm_chain_id
    }

    /// Four-byte wire network tag of this chain.
    pub fn network_tag(&self) -> &'static [u8; 4] {
        self.network_tag
    }

    /// The block `(number, hash)` every upstream must have.
    pub fn checkpoint(&self) -> (u64, &str) {
        (self.checkpoint.0, self.checkpoint.1.as_str())
    }

    /// Largest inclusive block range `eth_getLogs` may ask for.
    pub fn max_get_logs_range(&self) -> u64 {
        self.max_get_logs_range
    }

    /// The JSON-RPC upstreams and their identity verdicts.
    pub fn http_upstreams(&self) -> &UpstreamSet {
        &self.http
    }

    /// The configured WebSocket upstream. It is not trusted as such: every connection to it
    /// answers the identity probes before it carries a client frame.
    pub fn ws_url(&self) -> Option<&Url> {
        self.ws_url.as_ref()
    }

    /// Proxy capabilities backed by a configured upstream.
    pub fn configured_capabilities(&self) -> Vec<ProtocolProxyCapability> {
        vec![ProtocolProxyCapability::JsonRpc]
    }

    /// A JSON-RPC transport over the upstreams verified now, bounded by the chain's request
    /// timeout. `None` while no upstream has passed the identity check.
    pub fn transport(&self) -> Option<HttpTransport> {
        let urls = self.http.verified_urls();
        (!urls.is_empty()).then(|| HttpTransport::with_client(self.client.clone(), urls))
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
                    "An EVM upstream is NOT used: it did not pass the chain identity check. It \
                     is checked again until it passes; the chain's verified upstreams carry on"
                ),
            }
        });
        futures::future::join_all(probes).await;
        self.http.all_verified()
    }

    /// Check that `url` reports this chain's id and has its checkpoint block.
    pub(crate) async fn probe(&self, url: &Url) -> Result<(), IdentityError> {
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let reported = self
            .call(url, "eth_chainId", json!([]))
            .await?
            .as_str()
            .and_then(|value| u64::from_str_radix(value.strip_prefix("0x")?, 16).ok())
            .ok_or_else(unavailable)?;
        if reported != self.evm_chain_id {
            return Err(IdentityError::ChainIdMismatch {
                id: self.id().to_string(),
                expected: self.evm_chain_id,
                actual: reported,
            });
        }
        let (number, expected_hash) = self.checkpoint();
        let block = self
            .call(
                url,
                "eth_getBlockByNumber",
                json!([format!("0x{number:x}"), false]),
            )
            .await?;
        let hash = block
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(unavailable)?;
        if !hash.eq_ignore_ascii_case(expected_hash) {
            return Err(IdentityError::CheckpointMismatch(self.id().to_string()));
        }
        Ok(())
    }

    async fn call(&self, url: &Url, method: &str, params: Value) -> Result<Value, IdentityError> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let bytes = post_startup_json(&self.client, url, &body, self.timeout)
            .await
            .ok_or_else(|| IdentityError::Unavailable(self.id().to_string()))?;
        crate::http::json_rpc::startup_result(&bytes, JsonRpcVersion::V2, &json!(1))
            .ok_or_else(|| IdentityError::Unavailable(self.id().to_string()))
    }
}

impl fmt::Debug for EvmChainAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvmChainAdapter")
            .field("id", &self.id())
            .field("evm_chain_id", &self.evm_chain_id)
            .field("http", &self.http)
            .field("ws", &self.ws_url.as_ref().map(|_| "<redacted>"))
            .field("checkpoint", &self.checkpoint)
            .field("max_get_logs_range", &self.max_get_logs_range)
            .finish()
    }
}
