//! [`MonadAdapter`]: the Monad (EVM-compatible, via Alchemy) implementation of
//! [`cashweb_payload::chain_adapter::ChainAdapter`], assembled from ticket #12's
//! [`crate::monad_http::MonadHttpClient`] (submit/read HTTPS JSON-RPC) and ticket #15's
//! [`crate::monad_ws::MonadBlockSubscriber`] (new-block WS feed).
//!
//! ## Scope (ticket #25)
//!
//! This ticket only assembles the two already-landed standalone pieces behind the `ChainAdapter`
//! trait boundary (see the parent umbrella, ticket #2/PLAN.md's M2). Per the ticket's non-goals,
//! `MonadAdapter` is **not** wired into `Registry`/`Wallet` as the active adapter here -- Lotus
//! (`crate::lotus_adapter::LotusAdapter`) stays the default. `MonadHttpClient` and
//! `MonadBlockSubscriber` also keep working standalone for direct callers (tickets #11/#14's
//! `MonadAccountTxSigner`) that don't go through this trait.
//!
//! While assembling this, ticket #25 also found (and fixed) a corroborated gap: two independent
//! tickets (#16's `monad_stamp_verify`, #23's `monad_pop_verify`) had each hit
//! `MonadHttpClient`'s missing `eth_getTransactionByHash` support and worked around it their own
//! way. See `crate::monad_http::MonadHttpClient::get_transaction_by_hash`'s docs and both
//! modules' updated module docs for how that was consolidated.
//!
//! ## A note on `Sha256d` and Monad hash byte order
//!
//! [`ChainAdapter`] is typed in terms of `bitcoinsuite_core::Sha256d`, a Bitcoin/Lotus-flavored
//! hash type whose `Display`/[`Hashed::to_hex_be`]/[`Hashed::from_hex_be`] all apply Bitcoin's
//! byte-reversal display convention (reversing the wire bytes to match how bitcoind shows a
//! txid/block hash). See [`crate::monad_ws`]'s module docs for the same gotcha at the raw-hex-
//! string layer: that module deliberately keeps `MonadNewHead::hash` as a plain string instead of
//! going through `Sha256d`, explicitly deferring the conversion to "whichever future ticket
//! assembles the real `ChainAdapter` impl" -- this one.
//!
//! Monad/Ethereum-style hashes have no such reversal convention: the `0x`-prefixed hex string
//! reported over JSON-RPC/WS *is* the hash's true byte order, full stop. So converting a Monad
//! hash into `Sha256d` here goes through [`Hashed::from_slice`]/[`Hashed::as_slice`] (raw bytes,
//! untouched) -- **never** [`Hashed::from_hex_be`]/[`Hashed::to_hex_be`]/`Display`, which would
//! silently byte-reverse it (exactly the mistake `monad_ws`'s docs warn against, just one layer
//! up, at the `Sha256d` boundary instead of the raw string).
//!
//! The corollary: a `Sha256d` produced by this module, if ever `Display`ed or `to_hex_be`'d,
//! prints the *byte-reversed* form, not the canonical `0x...` string a Monad explorer would show.
//! Nothing downstream of `ChainAdapter` today displays these hashes to a human; if that ever
//! changes, go back through the original `0x`-prefixed hex (or [`crate::monad_http::Hash32`]'s own
//! `to_hex`) rather than `Sha256d`'s own `Display`/`to_hex_be`.

use async_trait::async_trait;
use bitcoinsuite_core::{Hashed, Script, Sha256, Sha256d};
use bitcoinsuite_error::{bail, Result};
use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};
use tokio::sync::mpsc;
use tracing::warn;

use crate::{
    monad_http::{Hash32, HttpTransport, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_verify::parse_commitment_calldata,
    monad_ws::MonadBlockSubscriber,
};

/// Convert a Monad [`Hash32`] (already in the correct, un-reversed byte order -- see the module
/// docs) into the chain-agnostic [`Sha256d`] [`ChainAdapter`] uses.
fn hash32_to_sha256d(hash: Hash32) -> Sha256d {
    Sha256d::new(hash.0)
}

/// Convert a [`Sha256d`] built via [`hash32_to_sha256d`]/[`monad_hash_hex_to_sha256d`] (i.e.
/// already in Monad's raw byte order, per the module docs) back into a Monad [`Hash32`].
fn sha256d_to_hash32(hash: &Sha256d) -> Hash32 {
    Hash32(hash.byte_array().array())
}

/// Parse a `0x`-prefixed Monad hash hex string (e.g. [`crate::monad_ws::MonadNewHead::hash`])
/// into a [`Sha256d`], preserving raw byte order (see the module docs).
fn monad_hash_hex_to_sha256d(hex_str: &str) -> Result<Sha256d> {
    let stripped = match hex_str.strip_prefix("0x") {
        Some(stripped) => stripped,
        None => bail!("expected a 0x-prefixed Monad block hash, got {hex_str:?}"),
    };
    let bytes = hex::decode(stripped)?;
    Ok(Sha256d::from_slice(&bytes)?)
}

/// [`ChainAdapter`] implementation for Monad, combining [`MonadHttpClient`] (submit/read HTTPS
/// JSON-RPC) and [`MonadBlockSubscriber`] (new-block WS notifications).
///
/// Generic over [`JsonRpcTransport`] (like [`MonadHttpClient`] itself) so tests can substitute a
/// mock transport; [`MonadAdapter::new`] (real HTTPS transport) covers ordinary construction.
#[derive(Debug, Clone)]
pub struct MonadAdapter<T: JsonRpcTransport = HttpTransport> {
    http: MonadHttpClient<T>,
    block_subscriber: MonadBlockSubscriber,
}

impl<T: JsonRpcTransport> MonadAdapter<T> {
    /// Assemble a [`MonadAdapter`] from an HTTP JSON-RPC client and a WS block subscriber. Both
    /// are constructed independently by the caller (they talk to separate HTTP/WS endpoints, e.g.
    /// `MONAD_TESTNET_HTTP_RPC_URL`/`MONAD_TESTNET_WS_RPC_URL` -- this module never reads
    /// env/config itself) -- this just wires the two together behind `ChainAdapter`.
    pub fn new(http: MonadHttpClient<T>, block_subscriber: MonadBlockSubscriber) -> Self {
        MonadAdapter {
            http,
            block_subscriber,
        }
    }
}

#[async_trait]
impl<T: JsonRpcTransport> ChainAdapter for MonadAdapter<T> {
    async fn submit_tx(&self, raw_tx: &[u8]) -> Result<SubmitTxOutcome> {
        match self.http.send_raw_transaction(raw_tx).await {
            Ok(submitted) => Ok(SubmitTxOutcome::Broadcast(hash32_to_sha256d(
                submitted.tx_hash,
            ))),
            // Mirrors `LotusAdapter::submit_tx`'s handling of bitcoind's "already in blockchain"
            // error: the node already knows this exact tx (a broadcast race, not a rejection of
            // the tx itself), so treat it the same as a successful (re-)broadcast.
            Err(MonadRpcError::AlreadyKnown { .. }) => Ok(SubmitTxOutcome::AlreadyConfirmed),
            Err(err) => Err(err.into()),
        }
    }

    async fn get_tx(&self, txid: &Sha256d) -> Result<Option<Vec<u8>>> {
        let tx_hash = sha256d_to_hash32(txid);
        Ok(self.http.get_raw_transaction_by_hash(tx_hash).await?)
    }

    async fn test_accept(&self, _raw_tx: &[u8]) -> Result<MempoolAcceptResult> {
        // Bitcoin/Lotus's `testmempoolaccept` has no direct Monad/EVM JSON-RPC analog: there is
        // no RPC that validates an already-signed raw tx against current mempool/state policy
        // without either broadcasting it, or fully RLP-decoding it (to recover its sender/nonce)
        // to drive an `eth_call`/`eth_estimateGas`-based simulation -- out of scope for this
        // ticket (see the handoff). Since `MonadAdapter` isn't wired into any active submission
        // path yet (this ticket's non-goals), this is a permissive stub that never blocks a
        // submission locally, deferring all real acceptance/rejection decisions to `submit_tx`
        // itself. A follow-up ticket should replace this once real pre-flight validation is
        // needed before `MonadAdapter` is wired in as an active adapter.
        Ok(Ok(()))
    }

    async fn subscribe_new_blocks(&self) -> Result<mpsc::Receiver<Sha256d>> {
        let mut new_heads = self.block_subscriber.subscribe();
        let (sender, receiver) = mpsc::channel(16);
        tokio::spawn(async move {
            while let Some(head) = new_heads.recv().await {
                let hash = match monad_hash_hex_to_sha256d(&head.hash) {
                    Ok(hash) => hash,
                    Err(err) => {
                        warn!(
                            "Ignoring malformed Monad new-block hash {:?}: {err:#}",
                            head.hash
                        );
                        continue;
                    }
                };
                if sender.send(hash).await.is_err() {
                    // Receiver dropped; stop forwarding.
                    break;
                }
            }
        });
        Ok(receiver)
    }

    fn decode_burn(&self, commitment_id: [u8; 4], burn_output_script: &Script) -> Result<Sha256> {
        // `burn_output_script` is `ChainAdapter`'s chain-agnostic (Bitcoin-`Script`-shaped)
        // carrier for "the burn output's raw bytes"; on Monad there's no Bitcoin Script at all,
        // just calldata, so this treats the script's raw bytecode as the tx's calldata and
        // decodes it via `monad_stamp_verify`'s existing calldata parser (not reimplemented here).
        let calldata = burn_output_script.bytecode().as_ref();
        Ok(parse_commitment_calldata(commitment_id, calldata)?)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use async_trait::async_trait;
    use serde_json::{json, Value};
    use tokio::time::{timeout, Duration};

    use super::*;

    /// A canned outcome [`MockTransport`] returns for one JSON-RPC method. `MonadRpcError` isn't
    /// `Clone`, so this is a small stand-in the mock can store/clone freely and turn into a real
    /// `MonadRpcError` at call time.
    #[derive(Debug, Clone)]
    enum MockOutcome {
        Ok(Value),
        /// The node already knows this exact tx (mirrors `HttpTransport`'s message-pattern
        /// classification of a real "already known" JSON-RPC error into
        /// `MonadRpcError::AlreadyKnown`).
        AlreadyKnown,
        /// Any other RPC-level error, not otherwise classified.
        Other(String),
    }

    /// Mock [`JsonRpcTransport`] returning a canned response per JSON-RPC method, so
    /// [`MonadAdapter`]'s `ChainAdapter` methods can be exercised without a network call. Shares
    /// state across `Clone`s (via `Arc`) so a test can keep a handle to inspect `calls()` after
    /// handing a clone off to `MonadHttpClient::with_transport`.
    #[derive(Debug, Clone, Default)]
    struct MockTransport {
        responses: std::sync::Arc<Mutex<HashMap<String, MockOutcome>>>,
        calls: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl MockTransport {
        fn set_ok(&self, method: &str, response: Value) {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), MockOutcome::Ok(response));
        }

        fn set_already_known(&self, method: &str) {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), MockOutcome::AlreadyKnown);
        }

        fn set_err(&self, method: &str, message: &str) {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), MockOutcome::Other(message.to_string()));
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            match self.responses.lock().unwrap().get(method) {
                Some(MockOutcome::Ok(value)) => Ok(value.clone()),
                Some(MockOutcome::AlreadyKnown) => Err(MonadRpcError::AlreadyKnown {
                    method: method.to_string(),
                    message: "already known".to_string(),
                }),
                Some(MockOutcome::Other(message)) => Err(MonadRpcError::Rpc {
                    method: method.to_string(),
                    code: -32000,
                    message: message.clone(),
                    data: None,
                }),
                None => Err(MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured for this method".to_string(),
                }),
            }
        }
    }

    fn adapter(transport: &MockTransport) -> MonadAdapter<MockTransport> {
        let http = MonadHttpClient::with_transport(transport.clone());
        let block_subscriber = MonadBlockSubscriber::new("ws://127.0.0.1:1/does-not-matter");
        MonadAdapter::new(http, block_subscriber)
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    #[tokio::test]
    async fn submit_tx_reports_broadcast() {
        let transport = MockTransport::default();
        transport.set_ok("eth_sendRawTransaction", json!(hex_hash(0x11)));
        let adapter = adapter(&transport);

        let outcome = adapter.submit_tx(&[0xde, 0xad]).await.unwrap();
        let expected_hash = hash32_to_sha256d(Hash32::from_hex(&hex_hash(0x11)).unwrap());
        assert_eq!(outcome, SubmitTxOutcome::Broadcast(expected_hash));
        assert_eq!(transport.calls(), vec!["eth_sendRawTransaction"]);
    }

    #[tokio::test]
    async fn submit_tx_maps_already_known_to_already_confirmed() {
        let transport = MockTransport::default();
        transport.set_already_known("eth_sendRawTransaction");
        let adapter = adapter(&transport);

        let outcome = adapter.submit_tx(&[0xde, 0xad]).await.unwrap();
        assert_eq!(outcome, SubmitTxOutcome::AlreadyConfirmed);
    }

    #[tokio::test]
    async fn submit_tx_propagates_other_errors() {
        let transport = MockTransport::default();
        transport.set_err("eth_sendRawTransaction", "insufficient funds for gas");
        let adapter = adapter(&transport);

        let err = adapter.submit_tx(&[0xde, 0xad]).await.unwrap_err();
        assert!(err.to_string().contains("insufficient funds"));
    }

    #[tokio::test]
    async fn get_tx_round_trips_hash_and_returns_raw_bytes() {
        let transport = MockTransport::default();
        transport.set_ok("eth_getRawTransactionByHash", json!("0xdeadbeef"));
        let adapter = adapter(&transport);

        let txid = hash32_to_sha256d(Hash32::from_hex(&hex_hash(0x22)).unwrap());
        let raw = adapter.get_tx(&txid).await.unwrap();
        assert_eq!(raw, Some(vec![0xde, 0xad, 0xbe, 0xef]));
        assert_eq!(transport.calls(), vec!["eth_getRawTransactionByHash"]);
    }

    #[tokio::test]
    async fn get_tx_returns_none_when_unknown() {
        let transport = MockTransport::default();
        transport.set_ok("eth_getRawTransactionByHash", Value::Null);
        let adapter = adapter(&transport);

        let txid = hash32_to_sha256d(Hash32::from_hex(&hex_hash(0x33)).unwrap());
        assert_eq!(adapter.get_tx(&txid).await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_accept_is_a_permissive_stub() {
        let adapter = adapter(&MockTransport::default());
        assert_eq!(adapter.test_accept(&[1, 2, 3]).await.unwrap(), Ok(()));
    }

    #[test]
    fn decode_burn_delegates_to_parse_commitment_calldata() {
        let transport = MockTransport::default();
        let http = MonadHttpClient::with_transport(transport);
        let block_subscriber = MonadBlockSubscriber::new("ws://127.0.0.1:1/does-not-matter");
        let adapter = MonadAdapter::new(http, block_subscriber);

        let commitment = Sha256::new([7u8; 32]);
        let mut calldata = Vec::new();
        calldata.extend_from_slice(b"STMP");
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        let script = Script::from_slice(&calldata);

        let decoded = adapter.decode_burn(*b"STMP", &script).unwrap();
        assert_eq!(decoded, commitment);
    }

    #[test]
    fn decode_burn_rejects_wrong_lokad_id() {
        let transport = MockTransport::default();
        let http = MonadHttpClient::with_transport(transport);
        let block_subscriber = MonadBlockSubscriber::new("ws://127.0.0.1:1/does-not-matter");
        let adapter = MonadAdapter::new(http, block_subscriber);

        let mut calldata = Vec::new();
        calldata.extend_from_slice(b"POND");
        calldata.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(&[1u8; 32]);
        let script = Script::from_slice(&calldata);

        assert!(adapter.decode_burn(*b"STMP", &script).is_err());
    }

    #[test]
    fn hash32_sha256d_round_trip_preserves_byte_order() {
        // Asymmetric bytes (not a repeated single byte), so the sanity check below actually
        // distinguishes "preserved order" from "reversed order".
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = i as u8;
        }
        let hash = Hash32(bytes);
        let sha256d = hash32_to_sha256d(hash);
        let round_tripped = sha256d_to_hash32(&sha256d);
        assert_eq!(hash, round_tripped);
        // Explicitly not equal to what `from_hex_be`/`to_hex_be` (Bitcoin display convention)
        // would produce -- that's the whole point of going through `from_slice`/`as_slice`
        // instead of the `_be` variants or `Display`.
        assert_ne!(
            sha256d.as_slice().to_vec(),
            sha256d.to_vec_be(),
            "sanity check: this hash is asymmetric under reversal"
        );
        assert_eq!(sha256d.as_slice(), bytes.as_slice());
    }

    #[test]
    fn monad_hash_hex_to_sha256d_rejects_missing_prefix() {
        assert!(monad_hash_hex_to_sha256d("deadbeef").is_err());
    }

    #[tokio::test]
    async fn subscribe_new_blocks_compiles_and_returns_a_receiver() {
        // `MonadBlockSubscriber` always connects over a real WS socket (see its own module docs
        // and tests): this only proves `MonadAdapter::subscribe_new_blocks` wires up correctly
        // and returns promptly with a (here: perpetually empty, since the WS URL is unreachable)
        // receiver, not that a real block notification round-trips -- that's `monad_ws`'s own
        // `#[ignore]`d live smoke test's job.
        let adapter = adapter(&MockTransport::default());
        let mut receiver = adapter.subscribe_new_blocks().await.unwrap();
        let result = timeout(Duration::from_millis(50), receiver.recv()).await;
        assert!(
            result.is_err(),
            "expected no block within the short timeout"
        );
    }
}
