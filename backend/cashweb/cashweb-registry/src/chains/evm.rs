//! EVM-family chain adapter: one per configured `[[registry.evm_rpc.chains]]` row.

use std::{fmt, sync::RwLock, time::Duration};

use cashweb_config::{
    EvmRpcChainConf, ProtocolChainDescriptor, ProtocolIdentityProbe, ProtocolProxyCapability,
};
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
    /// The block every upstream must have. Fixed for a registry-pinned row; for an operator row
    /// it starts at the configured block and moves forward only along the chain it attests (see
    /// [`Self::refresh_operator_checkpoint`]).
    checkpoint: RwLock<(u64, String)>,
    /// How often an operator checkpoint is re-attested.
    checkpoint_refresh: Duration,
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
        checkpoint_refresh: Duration,
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
            checkpoint_refresh,
        )?))
    }

    fn new(
        id: &str,
        urls: Vec<Url>,
        ws_url: Option<Url>,
        checkpoint: (u64, String),
        max_get_logs_range: u64,
        timeout: Duration,
        checkpoint_refresh: Duration,
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
            checkpoint: RwLock::new(checkpoint),
            checkpoint_refresh,
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
            Duration::from_secs(600),
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

    /// The block `(number, hash)` every upstream must have now.
    pub fn checkpoint(&self) -> (u64, String) {
        self.checkpoint
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Whether the registry row leaves the JSON-RPC checkpoint to the operator
    /// (`operator-block-checkpoint`, a local regtest chain).
    fn has_operator_checkpoint(&self) -> bool {
        self.descriptor.identity_probes.iter().any(|probe| {
            matches!(
                probe,
                ProtocolIdentityProbe::OperatorBlockCheckpoint {
                    capability: ProtocolProxyCapability::JsonRpc
                }
            )
        })
    }

    /// The operator's checkpoint, for a chain whose registry row leaves its JSON-RPC checkpoint
    /// to the operator (`operator-block-checkpoint`). `None` when the registry pins it: a
    /// protocol-pinned checkpoint is protocol data, never relay data.
    pub fn operator_checkpoint(&self) -> Option<(u64, String)> {
        self.has_operator_checkpoint().then(|| self.checkpoint())
    }

    /// How often [`Self::refresh_operator_checkpoint`] runs; `None` on a registry-pinned row,
    /// whose checkpoint never changes.
    pub(crate) fn operator_checkpoint_refresh(&self) -> Option<Duration> {
        self.has_operator_checkpoint()
            .then_some(self.checkpoint_refresh)
    }

    /// Re-attest an operator checkpoint: take the block [`OPERATOR_CHECKPOINT_DEPTH`] below the
    /// head of the first verified upstream (at most [`MAX_CHECKPOINT_ADVANCE`] past the current
    /// checkpoint), check every block between them links by parent hash back to the current
    /// checkpoint, check every other verified upstream has it, and only then make it the
    /// checkpoint. So the checkpoint stays on the chain the operator named, and stays inside the
    /// history a pruning regtest node keeps. A registry-pinned checkpoint is never touched.
    pub(crate) async fn refresh_operator_checkpoint(
        &self,
    ) -> Result<CheckpointRefresh, IdentityError> {
        if !self.has_operator_checkpoint() {
            return Ok(CheckpointRefresh::Pinned);
        }
        let urls = self.http.verified_urls();
        let Some(source) = urls.first() else {
            return Ok(CheckpointRefresh::NoVerifiedUpstream);
        };
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let (from, from_hash) = self.checkpoint();
        let head = self
            .call(source, "eth_blockNumber", json!([]))
            .await?
            .as_str()
            .and_then(parse_quantity)
            .ok_or_else(unavailable)?;
        let to = head
            .saturating_sub(OPERATOR_CHECKPOINT_DEPTH)
            .min(from.saturating_add(MAX_CHECKPOINT_ADVANCE));
        if to <= from {
            return Ok(CheckpointRefresh::Unchanged(from));
        }
        let mut parent = from_hash;
        for start in (from + 1..=to).step_by(CHECKPOINT_FETCH_BATCH) {
            let end = to.min(start + CHECKPOINT_FETCH_BATCH as u64 - 1);
            let blocks =
                futures::future::join_all((start..=end).map(|number| self.block(source, number)))
                    .await;
            for (number, block) in (start..=end).zip(blocks) {
                let (hash, parent_hash) = block?;
                if !parent_hash.eq_ignore_ascii_case(&parent) {
                    tracing::error!(
                        chain = %self.id(),
                        checkpoint = from,
                        block = number,
                        "The EVM upstream's chain no longer descends from the operator \
                         checkpoint; the checkpoint is NOT advanced"
                    );
                    return Err(IdentityError::CheckpointMismatch(self.id().to_string()));
                }
                parent = hash;
            }
        }
        for url in &urls[1..] {
            self.has_block(url, to, &parent).await?;
        }
        *self
            .checkpoint
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = (to, parent);
        Ok(CheckpointRefresh::Advanced { from, to })
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
        self.has_block(url, number, &expected_hash).await
    }

    /// Check that `url`'s block `number` is `expected_hash`.
    async fn has_block(
        &self,
        url: &Url,
        number: u64,
        expected_hash: &str,
    ) -> Result<(), IdentityError> {
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
            .ok_or_else(|| IdentityError::Unavailable(self.id().to_string()))?;
        if !hash.eq_ignore_ascii_case(expected_hash) {
            return Err(IdentityError::CheckpointMismatch(self.id().to_string()));
        }
        Ok(())
    }

    /// `url`'s block `number` as `(hash, parent hash)`. A missing block, or one that is not the
    /// number asked for, is no answer.
    async fn block(&self, url: &Url, number: u64) -> Result<(String, String), IdentityError> {
        let unavailable = || IdentityError::Unavailable(self.id().to_string());
        let block = self
            .call(
                url,
                "eth_getBlockByNumber",
                json!([format!("0x{number:x}"), false]),
            )
            .await?;
        let field = |name: &str| {
            block
                .get(name)
                .and_then(Value::as_str)
                .filter(|value| is_block_hash(value))
                .map(str::to_string)
        };
        let reported = block
            .get("number")
            .and_then(Value::as_str)
            .and_then(parse_quantity);
        match (reported, field("hash"), field("parentHash")) {
            (Some(reported), Some(hash), Some(parent)) if reported == number => Ok((hash, parent)),
            _ => Err(unavailable()),
        }
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

/// How far below the head a re-attested operator checkpoint sits, as the lab's first one does:
/// deep enough that the block is settled.
const OPERATOR_CHECKPOINT_DEPTH: u64 = 16;
/// The most blocks one re-attestation advances, so its parent-hash walk stays bounded. The next
/// round carries on from there.
const MAX_CHECKPOINT_ADVANCE: u64 = 4096;
/// Blocks fetched at once during the walk.
const CHECKPOINT_FETCH_BATCH: usize = 32;

/// What one [`EvmChainAdapter::refresh_operator_checkpoint`] did.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CheckpointRefresh {
    /// The registry pins this chain's checkpoint; nothing was asked or changed.
    Pinned,
    /// No upstream has proved its identity yet; the checkpoint is unchanged.
    NoVerifiedUpstream,
    /// The chain has not moved far enough; the checkpoint is still this block.
    Unchanged(u64),
    /// The checkpoint moved forward along the same chain.
    Advanced {
        /// The previous checkpoint block.
        from: u64,
        /// The new one.
        to: u64,
    },
}

fn parse_quantity(value: &str) -> Option<u64> {
    u64::from_str_radix(value.strip_prefix("0x")?, 16).ok()
}

fn is_block_hash(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
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

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use axum::{routing, Extension, Json, Router};

    use super::*;

    /// A JSON-RPC upstream serving a chain of synthetic blocks: block `n` of chain `seed` has
    /// hash `seed:n`, and its parent is block `n - 1` of the same chain. Blocks up to `fork_at`
    /// are chain 1's; above it, `chain`'s. Not a fake relay or a stand-in network: it stands for
    /// the one upstream answer each test is about.
    #[derive(Clone, Copy)]
    struct Chain {
        head: u64,
        fork_at: u64,
        chain: u64,
    }

    fn hash(seed: u64, number: u64) -> String {
        format!("0x{seed:032x}{number:032x}")
    }

    impl Chain {
        fn one(head: u64) -> Self {
            Self {
                head,
                fork_at: u64::MAX,
                chain: 1,
            }
        }

        fn hash(&self, number: u64) -> String {
            hash(
                if number <= self.fork_at {
                    1
                } else {
                    self.chain
                },
                number,
            )
        }
    }

    struct Upstream {
        chain: Arc<Mutex<Chain>>,
        requests: Arc<AtomicUsize>,
        url: Url,
    }

    fn upstream(chain: Chain) -> Upstream {
        let chain = Arc::new(Mutex::new(chain));
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/",
                routing::post(
                    |Extension((chain, requests)): Extension<(
                        Arc<Mutex<Chain>>,
                        Arc<AtomicUsize>,
                    )>,
                     Json(request): Json<Value>| async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        let chain = *chain.lock().unwrap();
                        let result = match request["method"].as_str().unwrap() {
                            "eth_chainId" => json!("0x4eaf"),
                            "eth_blockNumber" => json!(format!("0x{:x}", chain.head)),
                            "eth_getBlockByNumber" => {
                                let number =
                                    parse_quantity(request["params"][0].as_str().unwrap()).unwrap();
                                if number > chain.head {
                                    Value::Null
                                } else {
                                    json!({
                                        "number": format!("0x{number:x}"),
                                        "hash": chain.hash(number),
                                        "parentHash": chain.hash(number.saturating_sub(1)),
                                    })
                                }
                            }
                            method => panic!("unexpected {method}"),
                        };
                        Json(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                    },
                ),
            )
            .layer(Extension((chain.clone(), requests.clone())));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(app.into_make_service()),
        );
        Upstream {
            chain,
            requests,
            url: format!("http://{address}/").parse().unwrap(),
        }
    }

    fn adapter(
        id: &str,
        urls: Vec<Url>,
        checkpoint: (u64, String),
        refresh: Duration,
    ) -> EvmChainAdapter {
        EvmChainAdapter::new(
            id,
            urls,
            None,
            checkpoint,
            10,
            Duration::from_secs(5),
            refresh,
        )
        .unwrap()
    }

    fn regtest(urls: Vec<Url>, checkpoint: u64) -> EvmChainAdapter {
        let adapter = adapter(
            "monad-regtest",
            urls,
            (checkpoint, hash(1, checkpoint)),
            Duration::from_secs(600),
        );
        adapter.http.assume_verified();
        adapter
    }

    #[tokio::test]
    async fn an_operator_checkpoint_moves_forward_along_the_chain_it_attests() {
        let upstream = upstream(Chain::one(200));
        let chain = regtest(vec![upstream.url.clone()], 50);
        assert_eq!(
            chain.operator_checkpoint_refresh(),
            Some(Duration::from_secs(600))
        );
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Advanced { from: 50, to: 184 })
        );
        assert_eq!(chain.checkpoint(), (184, hash(1, 184)));
        assert_eq!(chain.operator_checkpoint(), Some((184, hash(1, 184))));
        // The new checkpoint is the one a new upstream (and the WebSocket probe) is checked
        // against.
        chain.probe(&upstream.url).await.unwrap();

        // Too few new blocks: it stays.
        upstream.chain.lock().unwrap().head = 195;
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Unchanged(184))
        );
        // The chain moves on: so does the checkpoint.
        upstream.chain.lock().unwrap().head = 1_000;
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Advanced { from: 184, to: 984 })
        );
        assert_eq!(chain.checkpoint(), (984, hash(1, 984)));
    }

    #[tokio::test]
    async fn one_refresh_advances_a_bounded_number_of_blocks() {
        let upstream = upstream(Chain::one(10_000));
        let chain = regtest(vec![upstream.url.clone()], 50);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Advanced {
                from: 50,
                to: 50 + MAX_CHECKPOINT_ADVANCE
            })
        );
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Advanced {
                from: 50 + MAX_CHECKPOINT_ADVANCE,
                to: 50 + 2 * MAX_CHECKPOINT_ADVANCE
            })
        );
    }

    #[tokio::test]
    async fn a_chain_that_does_not_descend_from_the_checkpoint_is_refused() {
        // A reorg below the head: blocks above 120 are now another chain's.
        let upstream = upstream(Chain {
            head: 300,
            fork_at: 120,
            chain: 2,
        });
        let chain = regtest(vec![upstream.url.clone()], 150);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Err(IdentityError::CheckpointMismatch(
                "monad-regtest".to_string()
            ))
        );
        assert_eq!(chain.checkpoint(), (150, hash(1, 150)));

        // The node was restarted as a new chain from the same genesis.
        *upstream.chain.lock().unwrap() = Chain {
            head: 300,
            fork_at: 0,
            chain: 3,
        };
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Err(IdentityError::CheckpointMismatch(
                "monad-regtest".to_string()
            ))
        );
        assert_eq!(chain.operator_checkpoint(), Some((150, hash(1, 150))));
    }

    #[tokio::test]
    async fn every_verified_upstream_must_have_the_new_checkpoint() {
        let first = upstream(Chain::one(300));
        let second = upstream(Chain {
            head: 300,
            fork_at: 200,
            chain: 2,
        });
        let chain = regtest(vec![first.url.clone(), second.url.clone()], 150);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Err(IdentityError::CheckpointMismatch(
                "monad-regtest".to_string()
            ))
        );
        assert_eq!(chain.checkpoint(), (150, hash(1, 150)));

        // An upstream that does not answer leaves the checkpoint where it was, too.
        *second.chain.lock().unwrap() = Chain::one(250);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Err(IdentityError::Unavailable("monad-regtest".to_string()))
        );
        assert_eq!(chain.checkpoint(), (150, hash(1, 150)));

        *second.chain.lock().unwrap() = Chain::one(300);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Advanced { from: 150, to: 284 })
        );
    }

    #[tokio::test]
    async fn nothing_is_attested_before_an_upstream_is_verified() {
        let upstream = upstream(Chain::one(300));
        let chain = adapter(
            "monad-regtest",
            vec![upstream.url.clone()],
            (150, hash(1, 150)),
            Duration::from_secs(600),
        );
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::NoVerifiedUpstream)
        );
        assert_eq!(upstream.requests.load(Ordering::SeqCst), 0);
        assert_eq!(chain.checkpoint(), (150, hash(1, 150)));
    }

    #[tokio::test]
    async fn a_registry_pinned_checkpoint_is_never_refreshed() {
        let pinned = (
            0,
            "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9".to_string(),
        );
        let upstream = upstream(Chain::one(10_000));
        let chain = adapter(
            "monad-testnet",
            vec![upstream.url.clone()],
            pinned.clone(),
            Duration::from_millis(20),
        );
        chain.http.assume_verified();
        assert_eq!(chain.operator_checkpoint(), None);
        assert_eq!(chain.operator_checkpoint_refresh(), None);
        assert_eq!(
            chain.refresh_operator_checkpoint().await,
            Ok(CheckpointRefresh::Pinned)
        );
        // Nor does the relay's background verification start refreshing it.
        let chains = Arc::new(super::super::RelayChains::for_test("monad-testnet").with_evm(chain));
        chains.start_verifying().await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(upstream.requests.load(Ordering::SeqCst), 0);
        let chain = chains.evm("monad-testnet").unwrap();
        assert_eq!(chain.checkpoint(), pinned);
        assert_eq!(chain.operator_checkpoint(), None);
    }

    #[tokio::test]
    async fn the_relay_keeps_its_operator_checkpoint_current_in_the_background() {
        let upstream = upstream(Chain::one(200));
        let chains = Arc::new(
            super::super::RelayChains::for_test("monad-regtest").with_evm(adapter(
                "monad-regtest",
                vec![upstream.url.clone()],
                (50, hash(1, 50)),
                Duration::from_millis(50),
            )),
        );
        chains.start_verifying().await;
        let chain = chains.evm("monad-regtest").unwrap().clone();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while chain.checkpoint().0 != 184 {
            assert!(tokio::time::Instant::now() < deadline, "not refreshed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        upstream.chain.lock().unwrap().head = 400;
        while chain.checkpoint().0 != 384 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "not refreshed again"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(chain.operator_checkpoint(), Some((384, hash(1, 384))));
        assert!(chain.http_upstreams().all_verified());
    }
}
