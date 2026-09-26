//! Standalone WebSocket subscriber for Monad's `eth_subscribe("newHeads")` feed (served by
//! Alchemy for Monad testnet/mainnet).
//!
//! This is the direct replacement for `cashweb-registry`'s ZMQ-style block-tip watcher (see
//! [`crate::lotus_adapter::LotusAdapter::subscribe_new_blocks`] for the polling-based pattern
//! this is meant to eventually replace for Monad).
//!
//! Deliberately **not** wired up to anything yet:
//! - It does not implement `cashweb_payload::chain_adapter::ChainAdapter`. A future
//!   `MonadAdapter` (assembled once both this ticket and the sibling HTTP JSON-RPC ticket land,
//!   see ticket #2) will implement `ChainAdapter::subscribe_new_blocks` by delegating to
//!   [`MonadBlockSubscriber`] here.
//! - It is not called from `Registry` or any other application code.
//!
//! [`MonadNewHead::hash`] is kept as a plain `0x`-prefixed hex string rather than parsed into
//! `bitcoinsuite_core::Sha256d`: Ethereum-style (and Monad) hashes are serialized big-endian with
//! no byte reversal, whereas `Sha256d::from_hex_be` reverses bytes to match Lotus/Bitcoin's
//! display convention. Converting to a chain-agnostic hash type is left to whichever future
//! ticket assembles the real `ChainAdapter` impl.

use std::time::Duration;

use bitcoinsuite_error::{ErrorMeta, Report, Result};
use futures::{SinkExt, StreamExt};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

/// Initial delay before the first reconnect attempt after a dropped/failed connection.
const INITIAL_RECONNECT_BACKOFF: Duration = Duration::from_millis(500);

/// Cap on the exponential reconnect backoff, so we don't end up waiting minutes between retries.
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);

/// JSON-RPC request id used for the `eth_subscribe` call. There's only ever one in-flight
/// subscription per connection, so a fixed id is fine.
const SUBSCRIBE_REQUEST_ID: i32 = 1;

/// A new block head observed from Monad's `eth_subscribe("newHeads")` feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadNewHead {
    /// The new block's hash, as the `0x`-prefixed hex string reported by the node (see the
    /// module docs for why this isn't parsed into `Sha256d`).
    pub hash: String,
    /// The new block's height ("number" in the `newHeads` payload), if present and parseable as
    /// a `0x`-prefixed hex integer.
    pub number: Option<u64>,
}

/// Errors from [`MonadBlockSubscriber`].
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum MonadWsError {
    /// The initial WS handshake/connect to the Monad WS endpoint failed.
    #[critical()]
    #[error("Failed to connect to Monad WS endpoint: {0}")]
    ConnectFailed(String),

    /// Sending the `eth_subscribe` request over the WS connection failed.
    #[critical()]
    #[error("Failed to send eth_subscribe request: {0}")]
    SubscribeSendFailed(String),

    /// The node responded to `eth_subscribe` with a JSON-RPC error instead of a subscription id.
    #[critical()]
    #[error("eth_subscribe was rejected by the node: {0}")]
    SubscribeRejected(String),

    /// The WS connection closed or errored out (whether cleanly or not) while we were reading
    /// from it. Triggers a reconnect.
    #[critical()]
    #[error("Monad WS connection closed: {0}")]
    ConnectionClosed(String),
}

/// Maps errors occurring in this module to an [`ErrorMeta`] trait object.
pub fn extract_error_meta(report: &Report) -> Option<&dyn ErrorMeta> {
    report
        .downcast_ref::<MonadWsError>()
        .map(|err| err as &dyn ErrorMeta)
}

/// Subscribes to Monad's `eth_subscribe("newHeads")` feed over a WS JSON-RPC endpoint (e.g.
/// Alchemy's Monad testnet/mainnet WS URL), reconnecting with exponential backoff whenever the
/// connection drops.
///
/// This is a plain standalone subscriber, not a [`ChainAdapter`](cashweb_payload::chain_adapter::ChainAdapter)
/// implementation -- see the module docs.
#[derive(Debug, Clone)]
pub struct MonadBlockSubscriber {
    ws_url: String,
}

impl MonadBlockSubscriber {
    /// Create a new subscriber against the given WS JSON-RPC endpoint.
    ///
    /// The URL is never hardcoded by this module: callers must source it themselves, e.g. from
    /// the `MONAD_TESTNET_WS_RPC_URL` env var (see `frank/.env`, which is gitignored).
    pub fn new(ws_url: impl Into<String>) -> Self {
        MonadBlockSubscriber {
            ws_url: ws_url.into(),
        }
    }

    /// Start subscribing in the background, returning a channel that yields each new block head
    /// as it arrives.
    ///
    /// If the connection drops (or the initial connect/subscribe fails), this logs the failure
    /// via `tracing::warn!` and reconnects with exponential backoff (starting at
    /// [`INITIAL_RECONNECT_BACKOFF`], capped at [`MAX_RECONNECT_BACKOFF`], reset after each
    /// successful (re)connect) -- it does not silently stop. It only stops retrying once the
    /// returned receiver is dropped.
    ///
    /// Note: Monad/Alchemy WS subscriptions are not resumed from where they left off on
    /// reconnect (`eth_subscribe` has no cursor/replay semantics); a reconnect can miss whatever
    /// blocks landed during the outage. Callers that need gap-free coverage should reconcile
    /// against the current tip (e.g. via the HTTP JSON-RPC adapter) after a reconnect.
    pub fn subscribe(&self) -> mpsc::Receiver<MonadNewHead> {
        let (sender, receiver) = mpsc::channel(64);
        let ws_url = self.ws_url.clone();
        tokio::spawn(async move {
            let mut backoff = INITIAL_RECONNECT_BACKOFF;
            loop {
                if sender.is_closed() {
                    break;
                }
                match run_subscription(&ws_url, &sender).await {
                    Ok(()) => {
                        // Receiver was dropped; clean shutdown, nothing to reconnect for.
                        break;
                    }
                    Err(err) => {
                        warn!(
                            "Monad WS subscription dropped, reconnecting in {:?}: {:#}",
                            backoff, err
                        );
                    }
                }
                if sender.is_closed() {
                    break;
                }
                tokio::time::sleep(backoff).await;
                backoff = std::cmp::min(backoff * 2, MAX_RECONNECT_BACKOFF);
            }
        });
        receiver
    }
}

/// Runs a single WS connection end-to-end: connect, send `eth_subscribe("newHeads")`, then
/// forward every `newHeads` notification to `sender` until the connection closes/errors or
/// `sender`'s receiver is dropped.
///
/// Returns `Ok(())` only on a clean shutdown (receiver dropped). Any connection problem is
/// surfaced as `Err` so the caller can reconnect.
async fn run_subscription(ws_url: &str, sender: &mpsc::Sender<MonadNewHead>) -> Result<()> {
    let (ws_stream, _response) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|err| MonadWsError::ConnectFailed(err.to_string()))?;
    debug!("Connected to Monad WS endpoint");
    let (mut write, mut read) = ws_stream.split();

    let subscribe_request = json::object! {
        jsonrpc: "2.0",
        id: SUBSCRIBE_REQUEST_ID,
        method: "eth_subscribe",
        params: ["newHeads"],
    };
    write
        .send(Message::Text(subscribe_request.dump()))
        .await
        .map_err(|err| MonadWsError::SubscribeSendFailed(err.to_string()))?;

    // Whether we've seen the JSON-RPC response acking (or rejecting) the `eth_subscribe` call.
    let mut subscription_confirmed = false;

    while let Some(msg) = read.next().await {
        let msg =
            msg.map_err(|err| MonadWsError::ConnectionClosed(format!("WS read error: {err}")))?;
        match msg {
            Message::Text(text) => {
                let value = match json::parse(&text) {
                    Ok(value) => value,
                    Err(err) => {
                        warn!("Ignoring malformed WS message from Monad node: {err}");
                        continue;
                    }
                };

                if !subscription_confirmed && value["id"].as_i32() == Some(SUBSCRIBE_REQUEST_ID) {
                    if !value["error"].is_null() {
                        return Err(MonadWsError::SubscribeRejected(value["error"].dump()).into());
                    }
                    subscription_confirmed = true;
                    debug!(
                        "Monad eth_subscribe confirmed, subscription id {}",
                        value["result"]
                    );
                    continue;
                }

                if value["method"].as_str() == Some("eth_subscription") {
                    let result = &value["params"]["result"];
                    let hash = match result["hash"].as_str() {
                        Some(hash) => hash.to_string(),
                        None => {
                            warn!(
                                "Ignoring newHeads notification missing a hash field: {}",
                                value.dump()
                            );
                            continue;
                        }
                    };
                    let number = result["number"]
                        .as_str()
                        .and_then(|hex| hex.strip_prefix("0x"))
                        .and_then(|hex| u64::from_str_radix(hex, 16).ok());

                    if sender.send(MonadNewHead { hash, number }).await.is_err() {
                        // Receiver dropped; clean shutdown.
                        return Ok(());
                    }
                }
            }
            Message::Ping(payload) => {
                if write.send(Message::Pong(payload)).await.is_err() {
                    return Err(
                        MonadWsError::ConnectionClosed("failed to send pong".into()).into(),
                    );
                }
            }
            Message::Close(frame) => {
                return Err(MonadWsError::ConnectionClosed(format!(
                    "closed by peer: {frame:?}"
                ))
                .into());
            }
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {
                // Not expected from an `eth_subscribe` feed; ignore.
            }
        }
    }

    // Stream ended without an explicit `Close` message.
    Err(MonadWsError::ConnectionClosed("stream ended unexpectedly".into()).into())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use tokio::time::timeout;

    use super::MonadBlockSubscriber;

    /// Live smoke test against the real Monad testnet WS endpoint (via Alchemy). This is the
    /// "did it really work" proof for ticket #15: it requires genuine network access and a real
    /// `MONAD_TESTNET_WS_RPC_URL`, so it's `#[ignore]`d by default (not run as part of the
    /// regular `cargo test` gate, matching how other live-network tests in this workspace are
    /// handled). Run explicitly with:
    ///
    /// ```sh
    /// MONAD_TESTNET_WS_RPC_URL=<url from frank/.env> \
    ///     cargo test -p cashweb-registry --lib monad_ws::tests::live_smoke_test_observes_new_block \
    ///     -- --ignored --nocapture
    /// ```
    #[ignore = "requires live network access and MONAD_TESTNET_WS_RPC_URL"]
    #[tokio::test]
    async fn live_smoke_test_observes_new_block() {
        let _ = bitcoinsuite_error::install();
        let ws_url = std::env::var("MONAD_TESTNET_WS_RPC_URL")
            .expect("MONAD_TESTNET_WS_RPC_URL must be set to run this live smoke test");

        let subscriber = MonadBlockSubscriber::new(ws_url);
        let mut new_heads = subscriber.subscribe();

        let start = Instant::now();
        let head = timeout(Duration::from_secs(30), new_heads.recv())
            .await
            .expect("timed out waiting for a live new block from Monad testnet")
            .expect("new block channel closed unexpectedly");
        let elapsed = start.elapsed();

        println!(
            "Observed live Monad testnet block: hash={} number={:?} (after {:?})",
            head.hash, head.number, elapsed
        );

        assert!(head.hash.starts_with("0x"), "hash should be 0x-prefixed");
    }
}
