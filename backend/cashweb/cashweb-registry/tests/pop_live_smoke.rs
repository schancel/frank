//! Live smoke test for ticket #4's POP (proof-of-payment) protection: proves the *whole*
//! HTTP-level flow -- challenge -> real Monad-testnet payment verification -> bearer-token
//! minting -> reuse -- runs correctly against a real, running `cashweb-registry` HTTP server
//! (via [`RegistryTestInstance`]) and real Monad testnet chain data, not mocks.
//!
//! Mirrors `monad_http_live_smoke.rs`/`monad_stamp_verify_live_smoke.rs`'s pattern: `#[ignore]`d
//! so the normal gate (`cargo test -p cashweb-registry`) never depends on network access or a
//! lotusd-compatible binary.
//!
//! ## Requirements to run
//!
//! - `MONAD_TESTNET_HTTP_RPC_URL` in the environment (see the repo's gitignored `.env`).
//! - A lotusd-compatible binary via `BITCOINSUITE_BIN_DIR` (same requirement as
//!   `tests/test_http_endpoint.rs`/`tests/test_p2p.rs`; see issue #1) -- `RegistryTestInstance`
//!   needs a regtest node to serve the *rest* of `handle_put_registry` (burn-tx validation) once
//!   POP-gating lets a request through; that part of the pipeline has nothing to do with Monad.
//!
//! ```sh
//! export $(grep -v '^#' /path/to/frank/.env | grep MONAD_TESTNET_HTTP_RPC_URL)
//! export BITCOINSUITE_BIN_DIR=/path/to/lotusd/bin
//! cargo test -p cashweb-registry --test pop_live_smoke -- --ignored --nocapture
//! ```
//!
//! ## What this proves, and the one thing it doesn't (see ticket #4's handoff for the full story)
//!
//! Ticket #4's third acceptance criterion asks for protected endpoints to "work end-to-end
//! against a real Monad testnet payment". Making a *fresh* payment of our own choosing needs (a) a
//! funded testnet account and (b) a way to build+sign a raw Monad transaction. Neither is
//! available:
//!
//! - No private key/funded testnet account is documented anywhere in this repo. Checked:
//!   `frank/.env`, `frank/.env.example`, `PLAN.md`, and grepped the whole repo for
//!   `PRIVATE_KEY`/`funded`/`faucet` -- nothing. This is the same blocker the earlier demo spike
//!   and `monad_http_live_smoke.rs`/`monad_stamp_verify_live_smoke.rs` already hit and documented.
//! - Even with a funded account, this repo has **zero** EVM transaction-signing infrastructure: no
//!   `secp256k1`/`k256`, `rlp`, or `keccak`/`sha3` crate anywhere in `backend/cashweb/Cargo.lock`
//!   (checked directly). Building a raw-tx signer from scratch here would both reinvent, and cross
//!   into the scope of, the separate client-side-payment ticket that ticket #4's own non-goals
//!   explicitly defer ("blocked on the wallet rewrite").
//!
//! So this test cannot make its *own* payment to a recipient it picked in advance. Instead, it
//! borrows the exact workaround `monad_stamp_verify_live_smoke.rs` already established for the
//! identical problem: it finds a real, currently-live Monad testnet transaction (via
//! `eth_getLogs`, scanning backwards from the chain tip -- no hardcoded hash, so this keeps
//! working as the chain moves forward) and configures the POP gate's expected recipient/minimum to
//! match *that* transaction's own real `to`/`value`. The "payment" the server verifies is
//! therefore a genuine, unstaged, real transaction that really confirmed on live Monad testnet and
//! really paid its recipient at least the configured minimum -- so the full verification pipeline
//! (`eth_getTransactionReceipt` + `eth_getTransactionByHash` over the real RPC endpoint,
//! `verify_payment_via_receipt`, `MonadReceiptVerifier`, bearer-token minting/caching, and the
//! `handle_put_registry` HTTP wiring) runs against real chain data end-to-end.
//!
//! What this does **not** prove: that a wallet can decide, up front, to pay a specific
//! pre-configured merchant recipient and have that specific payment be accepted (that needs the
//! funded account + signer described above -- the actual blocked piece). It proves everything
//! downstream of "a valid payment proof was submitted" is wired correctly and verifies real
//! on-chain data, which is the risk this acceptance criterion is chiefly trying to retire.
//!
//! If/when a funded Monad testnet account becomes available, replace step 1 below with: build and
//! sign a real payment transaction to a recipient of your choosing (needs an EVM tx signer, not
//! present in this repo yet), broadcast it via
//! `cashweb_registry::monad_http::MonadHttpClient::send_raw_transaction`, and use its hash/
//! recipient/value directly instead of scanning for someone else's transaction. Everything from
//! step 2 onward (spinning up the server, making the HTTP requests, checking the token) needs no
//! changes.

use std::ffi::OsString;

use bitcoinsuite_bitcoind::instance::{BitcoindChain, BitcoindConf};
use bitcoinsuite_core::{
    ecc::Ecc, lotus_txid, Hashed, LotusAddress, Net, Network, Script, ShaRmd160,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::Result;
use bitcoinsuite_test_utils::bin_folder;
use bitcoinsuite_test_utils_blockchain::setup_bitcoind_coins;
use cashweb_config::PopConf;
use cashweb_http_utils::protobuf::CONTENT_TYPE_PROTOBUF;
use cashweb_registry::{
    monad_http::{BlockTag, GetLogsFilter, Hash32, HttpTransport, MonadHttpClient},
    proto,
    test_instance::{build_signed_metadata, RegistryTestInstance},
};
use prost::Message;
use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE, ORIGIN},
    StatusCode,
};

/// Alchemy's free tier caps a single `eth_getLogs` call to a 10-block range.
const MAX_LOG_RANGE_BLOCKS: u64 = 10;

/// How many 10-block windows to scan backwards from the chain tip looking for any log, before
/// giving up (same headroom as the other live smoke tests' scans).
const MAX_WINDOWS_TO_SCAN: u64 = 500;

/// Scan recent Monad testnet blocks for any real, currently-live transaction hash (same technique
/// `monad_http_live_smoke.rs`/`monad_stamp_verify_live_smoke.rs` use), so this test never depends
/// on a hardcoded hash staying valid.
async fn find_a_real_tx_hash(client: &MonadHttpClient<HttpTransport>) -> Hash32 {
    let latest = client
        .block_number()
        .await
        .expect("live eth_blockNumber call failed");
    assert!(latest > 0, "expected a nonzero live block number");

    for window in 0..MAX_WINDOWS_TO_SCAN {
        let to_block = latest.saturating_sub(window * MAX_LOG_RANGE_BLOCKS);
        let from_block = to_block.saturating_sub(MAX_LOG_RANGE_BLOCKS - 1);
        if to_block == 0 {
            break;
        }
        let filter = GetLogsFilter {
            from_block: Some(BlockTag::Number(from_block)),
            to_block: Some(BlockTag::Number(to_block)),
            address: None,
            topics: vec![],
        };
        let logs = client.get_logs(&filter).await.unwrap_or_else(|err| {
            panic!("live eth_getLogs call failed for [{from_block}, {to_block}]: {err}")
        });
        if let Some(log) = logs.first() {
            println!(
                "[live] found tx via eth_getLogs: tx_hash={} block=[{from_block:#x}, {to_block:#x}]",
                log.transaction_hash
            );
            return log.transaction_hash;
        }
    }
    panic!(
        "found no logs at all in the scanned recent block range on Monad testnet -- either the \
         chain has gone unusually quiet, or eth_getLogs is broken"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "hits the live Monad testnet endpoint over the network and needs a lotusd-compatible \
            binary (BITCOINSUITE_BIN_DIR); run explicitly, see module docs"]
async fn live_pop_gated_metadata_put_round_trip() -> Result<()> {
    let _ = bitcoinsuite_error::install();

    // --- 1. Find a real, currently-live Monad testnet tx and read its own to/value. ---
    // (See module docs: this stands in for "our own" payment, since neither a funded account nor
    // an EVM tx signer exists in this repo to make one.)
    let rpc_url = std::env::var("MONAD_TESTNET_HTTP_RPC_URL").expect(
        "MONAD_TESTNET_HTTP_RPC_URL must be set to run this live smoke test (see module docs \
         for how to source it from the repo's gitignored .env)",
    );
    let rpc_url: url::Url = rpc_url
        .parse()
        .expect("MONAD_TESTNET_HTTP_RPC_URL is not a valid URL");
    let transport = HttpTransport::new(rpc_url.clone());
    let monad_client = MonadHttpClient::with_transport(transport);

    let tx_hash = find_a_real_tx_hash(&monad_client).await;
    let real_tx = monad_client
        .get_transaction_by_hash(tx_hash)
        .await
        .expect("live eth_getTransactionByHash call failed")
        .expect("expected a transaction for a hash we just observed via eth_getLogs");
    let real_to = real_tx
        .to
        .expect("sample transaction unexpectedly has no `to` (contract creation)");
    println!(
        "[live] using real tx {tx_hash} to={real_to} value={} as the POP gate's expected payment",
        real_tx.value
    );

    // --- 2. Spin up a real RegistryTestInstance with POP gated to that real recipient/value. ---
    let pop_conf = PopConf {
        monad_rpc_url: rpc_url,
        hmac_secret: "pop-live-smoke-test-hmac-secret".to_string(),
        payment_recipient: real_to.to_hex(),
        min_value_wei: real_tx.value.to_string(),
    };

    let tempdir = tempdir::TempDir::new("cashweb-registry--pop-live-smoke")?;
    let bitcoind_conf = BitcoindConf::from_chain_regtest(
        bin_folder(),
        BitcoindChain::XPI,
        vec![OsString::from("-txindex")],
    )?;
    let mut instance =
        RegistryTestInstance::setup_with_pop_conf(tempdir.path(), bitcoind_conf, vec![], pop_conf)
            .await?;
    instance.wait_for_ready().await?;
    let url = instance.url.clone();

    // --- 3. Build a validly-signed metadata-PUT payload (same recipe as test_p2p.rs). ---
    let anyone_script = Script::from_slice(&[0x51]);
    let anyone_address = LotusAddress::new(
        "lotus",
        Net::Regtest,
        Script::p2sh(&ShaRmd160::digest(anyone_script.bytecode().clone())),
    );
    let mut utxos = setup_bitcoind_coins(
        instance.bitcoind.cli(),
        Network::XPI,
        1,
        anyone_address.as_str(),
        &anyone_address.script().hex(),
    )?;

    let ecc = EccSecp256k1::default();
    let seckey = ecc.seckey_from_array([9; 32])?;
    let pubkey = ecc.derive_pubkey(&seckey);
    let pkh = ShaRmd160::digest(pubkey.array().into());
    let address = LotusAddress::new("lotus", Net::Regtest, Script::p2pkh(&pkh));

    let (signed_metadata, tx) = build_signed_metadata(
        &seckey,
        pubkey,
        &ecc,
        &mut utxos,
        &anyone_script,
        proto::AddressMetadata {
            timestamp: 1234,
            ttl: 10,
            entries: vec![],
        },
    );

    let http = reqwest::Client::new();

    // --- 4. Unauthenticated PUT is still rejected with a 402 (sanity check the gate is live). ---
    let response = http
        .put(format!("{}/metadata/{}", url, address))
        .body(signed_metadata.encode_to_vec())
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://localhost")
        .send()
        .await
        .expect("unauthenticated PUT failed at the transport level");
    assert_eq!(
        response.status(),
        StatusCode::PAYMENT_REQUIRED,
        "expected an unauthenticated PUT to be challenged for payment"
    );

    // --- 5. PUT with the real payment proof (`pop_tx_hash`) -> 200 + a minted X-Pop-Token. ---
    let response = http
        .put(format!(
            "{}/metadata/{}?pop_tx_hash={}",
            url, address, tx_hash
        ))
        .body(signed_metadata.encode_to_vec())
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://localhost")
        .send()
        .await
        .expect("PUT with pop_tx_hash failed at the transport level");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "expected the real Monad payment proof to verify and the PUT to succeed"
    );
    let token_header = response
        .headers()
        .get("x-pop-token")
        .expect("expected an X-Pop-Token header on success")
        .to_str()
        .expect("X-Pop-Token header should be valid ASCII")
        .to_string();
    println!("[live] minted bearer token header: {token_header}");
    let mut body = response.bytes().await?;
    let broadcast_response = proto::PutSignedPayloadResponse::decode(&mut body)?;
    assert_eq!(
        broadcast_response,
        proto::PutSignedPayloadResponse {
            txid: vec![lotus_txid(&tx).as_slice().to_vec()],
        },
    );

    // --- 6. Reuse the minted token instead of paying again -> 200, no new proof needed. ---
    let response = http
        .put(format!("{}/metadata/{}", url, address))
        .body(signed_metadata.encode_to_vec())
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://localhost")
        .header(AUTHORIZATION, token_header)
        .send()
        .await
        .expect("PUT with the reused bearer token failed at the transport level");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "expected the reused bearer token to be accepted without a new payment"
    );

    Ok(())
}
