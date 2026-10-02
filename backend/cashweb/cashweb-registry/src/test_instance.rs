//! Module for [`RegistryTestInstance`].

use std::{net::SocketAddr, path::Path, sync::Arc, time::Duration};

use bitcoinsuite_bitcoind::instance::{BitcoindConf, BitcoindInstance};
use bitcoinsuite_core::{
    ecc::{Ecc, PubKey, SecKey},
    BitcoinCode, Hashed, Net, OutPoint, Script, Sha256, TxOutput, UnhashedTx,
};
use bitcoinsuite_error::Result;
use bitcoinsuite_test_utils::{is_free_tcp, pick_ports};
use bitcoinsuite_test_utils_blockchain::build_tx;
use cashweb_payload::{
    payload::SignatureScheme,
    verify::{build_commitment_script, ADDRESS_METADATA_LOKAD_ID},
};
use prost::Message;

use cashweb_config::PopConf;

use crate::{
    http::{pop_protection::PopGate, server::RegistryServer},
    lotus_adapter::LotusAdapter,
    p2p::{peer::Peer, peers::Peers},
    proto,
    registry::Registry,
    store::db::Db,
};

/// A Registry instance connected to a regtest bitcoind instance.
#[derive(Debug)]
pub struct RegistryTestInstance {
    /// Regtest bitcoind instance.
    pub bitcoind: BitcoindInstance,
    /// URL of the registry server.
    pub url: String,
    /// Port of the registry server.
    pub port: u16,
    /// Registry of the server.
    pub registry: Arc<Registry>,
    /// Peers of the server.
    pub peers: Arc<Peers>,
}

impl RegistryTestInstance {
    /// Setup a new bitcoind and registry instance on regtest.
    ///
    /// POP protection (ticket #4) is configured with [`placeholder_pop_conf`], which (ticket #35)
    /// has `enabled: false` -- the same hackathon-demo default `cashwebd-exe` ships with -- so the
    /// metadata-put endpoint requires no payment/token at all for the callers of this function
    /// (`tests/test_http_endpoint.rs`, `tests/test_p2p.rs`, `tests/test_imd.rs`), none of which
    /// exercise POP-gated request flows. A test that needs to (e.g. `tests/pop_live_smoke.rs`)
    /// should use [`Self::setup_with_pop_conf`] with an `enabled: true` conf instead.
    pub async fn setup(dir: &Path, conf: BitcoindConf, peers: Vec<Peer>) -> Result<Self> {
        Self::setup_with_pop_conf(dir, conf, peers, placeholder_pop_conf()).await
    }

    /// Same as [`Self::setup`], but with an explicit [`PopConf`] instead of the harmless
    /// [`placeholder_pop_conf`] default -- needed by tests that actually exercise POP-gated
    /// behavior (e.g. against a real Monad testnet payment recipient/minimum). `pop_conf.enabled`
    /// is honored the same way `cashwebd-exe` honors it in production (ticket #35): `false` skips
    /// the gate entirely, `true` builds it from the rest of `pop_conf` (failing closed with a
    /// `500` on every gated request if that doesn't parse into a valid gate).
    pub async fn setup_with_pop_conf(
        dir: &Path,
        conf: BitcoindConf,
        peers: Vec<Peer>,
        pop_conf: PopConf,
    ) -> Result<Self> {
        let db = Db::open(dir.join("db.rocksdb"))?;

        let bitcoind = BitcoindInstance::setup(conf)?;

        let port = pick_ports(1)?[0];
        let socket_addr = format!("127.0.0.1:{}", port).parse::<SocketAddr>()?;
        let url = format!("http://{}", socket_addr);

        let registry = Arc::new(Registry::new(
            db,
            Arc::new(LotusAdapter::new(bitcoind.rpc_client().clone())),
            Net::Regtest,
        ));
        let peers = Arc::new(Peers::new(url.clone(), peers));
        let pop_gate = Arc::new(PopGate::from_conf_if_enabled(&pop_conf));
        let server = RegistryServer {
            registry: Arc::clone(&registry),
            peers: Arc::clone(&peers),
            pop_gate,
            // No curated defaults needed by any current caller of this test instance (ticket #49).
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
        };

        let router = server.into_router();

        tokio::spawn(axum::Server::bind(&socket_addr).serve(router.into_make_service()));

        Ok(RegistryTestInstance {
            bitcoind,
            url,
            port,
            registry,
            peers,
        })
    }

    /// Wait until the bitcoind and registry server are live.
    pub async fn wait_for_ready(&mut self) -> Result<()> {
        self.bitcoind.wait_for_ready()?;
        let mut attempt = 0;
        while is_free_tcp(self.port) {
            attempt += 1;
            if attempt > 100 {
                panic!("Failed to start server");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }

    /// Clean up the instance.
    pub fn cleanup(&self) -> Result<()> {
        self.bitcoind.cleanup()
    }
}

impl Drop for RegistryTestInstance {
    fn drop(&mut self) {
        self.bitcoind.cleanup().ok();
    }
}

/// A [`PopConf`] that parses into a valid [`PopGate`] but doesn't point at any real Monad
/// endpoint/recipient -- used by [`RegistryTestInstance::setup`] as a harmless default for tests
/// that don't exercise POP-gated request flows at all.
///
/// Ticket #35: `enabled: false` here mirrors `cashwebd-exe`'s hackathon-demo default, so the
/// metadata-put endpoint requires no payment/token at all for callers of
/// [`RegistryTestInstance::setup`] -- rather than every such request getting a real `402`
/// challenge, which was this conf's behavior before this ticket (when POP couldn't be disabled at
/// all). The rest of the fields still parse into a valid gate (in case a test explicitly flips
/// `enabled` back to `true` via [`RegistryTestInstance::setup_with_pop_conf`] without changing
/// anything else), but still don't point at any real chain data.
///
/// Never use this for a test that needs POP verification to actually pass -- it's not connected
/// to any real chain data. Use [`RegistryTestInstance::setup_with_pop_conf`] with a conf pointed
/// at a real Monad RPC endpoint (and `enabled: true`) instead (see `tests/pop_live_smoke.rs`).
pub fn placeholder_pop_conf() -> PopConf {
    PopConf {
        // Ticket #35: disabled by default, matching the hackathon demo -- signing up should
        // require no payment. Flip to `true` (see this function's docs) for a test that needs the
        // gate active.
        enabled: false,
        // Deliberately not a real/reachable endpoint: nothing in this default config path should
        // ever need to make a live Monad RPC call.
        monad_rpc_url: "http://127.0.0.1:1".parse().expect("valid URL"),
        hmac_secret: "registry-test-instance-placeholder-hmac-secret-not-for-production"
            .to_string(),
        payment_recipient: format!("0x{}", "00".repeat(20)),
        min_value_wei: "0".to_string(),
    }
}

/// Build a [`cashweb_payload::proto::SignedPayload`] for testing.
pub fn build_signed_metadata(
    seckey: &SecKey,
    pubkey: PubKey,
    ecc: &dyn Ecc,
    utxos: &mut Vec<(OutPoint, i64)>,
    redeem_script: &Script,
    address_metadata: proto::AddressMetadata,
) -> (cashweb_payload::proto::SignedPayload, UnhashedTx) {
    let payload_hash = Sha256::digest(address_metadata.encode_to_vec().into());

    // Build burn commitment tx
    let (outpoint, amount) = utxos.pop().unwrap();
    let burn_amount = amount - 10_000;
    let tx = build_tx(
        outpoint,
        redeem_script,
        vec![TxOutput {
            value: burn_amount,
            script: build_commitment_script(
                ADDRESS_METADATA_LOKAD_ID,
                pubkey.array(),
                &payload_hash,
            ),
        }],
    );

    // Sign address metadata
    let signed_metadata = cashweb_payload::proto::SignedPayload {
        pubkey: pubkey.array().to_vec(),
        sig: ecc.sign(seckey, payload_hash.byte_array().clone()).to_vec(),
        sig_scheme: SignatureScheme::Ecdsa.into(),
        payload: address_metadata.encode_to_vec(),
        payload_hash: payload_hash.as_slice().to_vec(),
        burn_amount,
        burn_txs: vec![cashweb_payload::proto::BurnTx {
            tx: tx.ser().to_vec(),
            burn_idx: 0,
        }],
    };

    (signed_metadata, tx)
}
