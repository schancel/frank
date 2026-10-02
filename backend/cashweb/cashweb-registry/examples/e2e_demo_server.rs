//! Standalone, scriptable `cashweb-registry` HTTP server for ticket #8's live end-to-end demo
//! (identity registration + a real Monad-testnet stamped message, relay-to-relay).
//!
//! This is a *new* file (ticket #8's ownership rules prefer new demo scripts over touching merged
//! modules), not a replacement for `cashwebd-exe`. It differs from `cashwebd-exe`'s `main.rs` in
//! exactly one way: the `ChainAdapter` it wires in.
//!
//! ## Why not `cashwebd-exe`/`LotusAdapter` as-is
//!
//! `cashwebd-exe` always wires `Registry` up to a real `LotusAdapter`, which needs a real,
//! reachable `lotusd`-compatible bitcoind RPC endpoint (see `cashwebd-exe/src/main.rs`,
//! `RegistryTestInstance::setup` in `src/test_instance.rs`, and every `tests/*.rs` live/http test
//! in this crate, all of which spin up a real regtest `bitcoind` via `BITCOINSUITE_BIN_DIR`). No
//! such binary is available in this environment (checked: no `BITCOINSUITE_BIN_DIR`, no built
//! `lotusd` binary anywhere on this machine -- only its C++ *source* checked out at
//! `~/repos/lotusd`, which would need a from-scratch build).
//!
//! That dependency is *only* needed for `Registry::put_metadata`'s pre-existing (unmigrated,
//! out-of-scope-for-#8) Lotus-shaped burn-commitment bookkeeping: `AddressMetadata` is still keyed
//! by a `LotusAddress`, and its `SignedPayload` still carries a Lotus `BurnTx` structurally,
//! regardless of POP's payment gate being disabled (ticket #35). `validate_burn_tx`/
//! `validate_burn_txs` (`src/registry.rs`) unconditionally call `self.chain_adapter.{get_tx,
//! test_accept,submit_tx}` for that burn tx, chain-adapter-agnostic in principle but, via
//! `LotusAdapter`, backed by a real bitcoind RPC call in practice.
//!
//! [`DemoChainAdapter`] below is a permissive stand-in for exactly that: it accepts any raw tx
//! unconditionally and never reports one as already-known, so `put_metadata` proceeds without
//! ever touching any real or simulated Lotus network. This is legitimate, already-established
//! practice in this very crate -- see `src/http/monad_message.rs`'s own test module's
//! `UnusedChainAdapter` and `src/registry.rs`'s test doubles -- just promoted from a `#[cfg(test)]`
//! helper to something a standalone demo binary can run against. It never touches any real or
//! simulated blockchain, so it introduces no "self-hosted chain infrastructure" (`PLAN.md`
//! constraint 1) -- it isn't chain infrastructure at all, real or fake, it's a no-op.
//!
//! **This stub is scoped to the demo's identity-registration step only.** The actually-in-scope,
//! actually-real part of the original ticket -- the Monad-stamped-message path
//! (`src/http/monad_message.rs`) -- never touches `Registry::chain_adapter` at all (see that
//! module's own docs, "Storage" section). NOTE: that path now exists only when the durable mailbox
//! is enabled by `cashwebd` configuration, and this demo server constructs its router with the
//! mailbox **disabled**, so it does not serve `/message/monad`; use
//! `backend/cashweb/run-local-monad.sh` for the enabled relay.
//!
//! ## Usage
//!
//! See `backend/cashweb/cashweb-registry/examples/README.md` (ticket #8's runbook) for the full,
//! step-by-step demo. Short version:
//!
//! ```sh
//! cd backend/cashweb
//! set -a; source ../../.env; set +a   # MONAD_TESTNET_HTTP_RPC_URL, MONAD_STAMP_BURN_ADDRESS, ...
//! cargo run -p cashweb-registry --example e2e_demo_server -- 127.0.0.1:8098
//! ```

use std::{net::SocketAddr, str::FromStr, sync::Arc};

use async_trait::async_trait;
use bitcoinsuite_core::{Hashed, Net, Script, Sha256, Sha256d};
use bitcoinsuite_error::Result;
use cashweb_config::PopConf;
use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};
use cashweb_registry::{
    http::{
        curated_defaults::CuratedDefaultContact, pop_protection::PopGate, server::RegistryServer,
    },
    monad_http::Address,
    p2p::peers::Peers,
    registry::Registry,
    store::db::Db,
};
/// Minimal stand-in for `tracing::info!`, since `tracing_subscriber` (used by `cashwebd-exe` to
/// actually render `tracing` events) isn't a dependency of this crate and adding it just for this
/// example would be scope creep. Plain stdout is enough for a demo script to show progress.
macro_rules! info {
    ($($arg:tt)*) => {
        println!($($arg)*)
    };
}

/// Permissive `ChainAdapter` stub -- see this file's module docs for exactly what it stands in
/// for and why that's safe for this demo. Never touches a network; every operation is answered
/// locally and unconditionally.
#[derive(Debug)]
struct DemoChainAdapter;

#[async_trait]
impl ChainAdapter for DemoChainAdapter {
    async fn submit_tx(&self, raw_tx: &[u8]) -> Result<SubmitTxOutcome> {
        // Accept unconditionally. The returned "txid" is just a content hash of the raw bytes --
        // good enough to be a stable, unique identifier for the demo's own `PutMetadataResult`
        // response; nothing downstream treats it as a real Lotus txid that could be looked up on
        // any actual chain.
        info!(
            "[demo chain adapter] accepting metadata burn tx ({} bytes)",
            raw_tx.len()
        );
        Ok(SubmitTxOutcome::Broadcast(Sha256d::digest(
            raw_tx.to_vec().into(),
        )))
    }

    async fn get_tx(&self, _txid: &Sha256d) -> Result<Option<Vec<u8>>> {
        // Never "already known" -- every burn tx this demo builds is treated as freshly submitted.
        Ok(None)
    }

    async fn test_accept(&self, _raw_tx: &[u8]) -> Result<MempoolAcceptResult> {
        Ok(Ok(()))
    }

    async fn subscribe_new_blocks(&self) -> Result<tokio::sync::mpsc::Receiver<Sha256d>> {
        // Nothing in this demo needs new-block notifications for the Lotus side; return a
        // receiver that simply never yields anything.
        let (_sender, receiver) = tokio::sync::mpsc::channel(1);
        Ok(receiver)
    }

    fn decode_burn(&self, _commitment_id: [u8; 4], _burn_output_script: &Script) -> Result<Sha256> {
        unimplemented!(
            "not exercised by this demo: the metadata-put path this adapter serves never calls \
             decode_burn, and the Monad message path (the ticket's real subject) doesn't go \
             through ChainAdapter at all -- see this file's module docs"
        )
    }
}

/// A [`PopConf`] with `enabled: false` -- ticket #35's hackathon-demo default, matching
/// `cashwebd-exe`'s own default and this crate's `test_instance::placeholder_pop_conf`. Mirrors
/// that function rather than importing it (it's `#[cfg]`-gated to test builds, not available to
/// an `examples/` binary).
fn demo_pop_conf() -> PopConf {
    PopConf {
        enabled: false,
        monad_rpc_url: "http://127.0.0.1:1".parse().expect("valid URL"),
        hmac_secret: "e2e-demo-placeholder-hmac-secret-not-for-production".to_string(),
        payment_recipient: format!("0x{}", "00".repeat(20)),
        min_value_wei: "0".to_string(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    bitcoinsuite_error::install()?;

    let bind_addr: SocketAddr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:8098".to_string())
        .parse()
        .expect("usage: e2e_demo_server [host:port]");

    // This demo constructs its router with the durable Monad mailbox disabled (see
    // `monad_mailbox` below), so `PUT /message/monad` is not served. The mailbox is configured by
    // `[registry.monad_mailbox]` in a `cashwebd` config (see `backend/cashweb/run-local-monad.sh`),
    // never by environment variables. Only the separate topic routes still read
    // `MONAD_TESTNET_HTTP_RPC_URL`/`MONAD_STAMP_BURN_ADDRESS` from the environment.
    info!("Monad mailbox is disabled in this demo: /message/monad is not served");

    // Temp RocksDB dir for this demo run's registry state. Kept alive for the process's whole
    // lifetime by holding onto `_db_dir`; removed automatically on drop (process exit).
    let db_dir = tempdir::TempDir::new("cashweb-e2e-demo")?;
    info!("Registry DB: {}", db_dir.path().display());
    let db = Db::open(db_dir.path().join("db.rocksdb"))?;

    let chain_adapter: Arc<dyn ChainAdapter> = Arc::new(DemoChainAdapter);
    let registry = Arc::new(Registry::new(db, chain_adapter, Net::Regtest));
    let peers = Arc::new(Peers::new(format!("http://{bind_addr}"), vec![]));
    let pop_gate = Arc::new(PopGate::from_conf_if_enabled(&demo_pop_conf()));
    info!("POP protection is disabled for this demo (ticket #35 default) -- identity registration needs no payment");

    let curated_defaults = match std::env::var("FRANK_DEMO_CURATED_CONTACT_ADDRESS") {
        Ok(raw_address) => {
            let address = Address::from_str(&raw_address)
                .expect("FRANK_DEMO_CURATED_CONTACT_ADDRESS must be a 0x-prefixed EVM address");
            let name = std::env::var("FRANK_DEMO_CURATED_CONTACT_NAME")
                .unwrap_or_else(|_| "Qwen".to_string());
            info!("Curated default contact: {name} ({raw_address})");
            vec![CuratedDefaultContact { address, name }]
        }
        Err(_) => vec![],
    };

    let server = RegistryServer {
        registry,
        peers,
        pop_gate,
        curated_defaults: Arc::new(curated_defaults),
        monad_mailbox: cashweb_registry::monad_mailbox::MonadMailboxRuntime::Disabled,
        evm_rpc: None,
    };
    let router = server.into_router();

    info!("cashweb-registry e2e demo server listening on http://{bind_addr}");
    axum::Server::bind(&bind_addr)
        .serve(router.into_make_service())
        .await?;

    Ok(())
}
