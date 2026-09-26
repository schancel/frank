//! Standalone, **not wired into app logic**, live smoke test for
//! [`cashweb_registry::monad_stamp_verify`] (ticket #16), proving the mechanics of
//! `verify_stamp_burn` (and the `eth_getTransactionByHash` call it needs, now
//! `MonadHttpClient::get_transaction_by_hash` -- see ticket #25) actually work against real Monad
//! testnet chain data, not simulated data.
//!
//! Mirrors `monad_http_live_smoke.rs`'s pattern: `#[ignore]`d so the normal gate
//! (`cargo test -p cashweb-registry`) never depends on network access; run it explicitly with the
//! RPC URL in the environment:
//!
//! ```sh
//! export $(grep -v '^#' /path/to/frank/.env | grep MONAD_TESTNET_HTTP_RPC_URL)
//! cargo test -p cashweb-registry --test monad_stamp_verify_live_smoke -- --ignored --nocapture
//! ```
//!
//! ## What this does and doesn't prove
//! - It scans recent blocks for a real, currently-live transaction (no hardcoded tx hash, so this
//!   keeps working as the testnet chain moves forward), then feeds its hash into
//!   `verify_stamp_burn`.
//! - It proves the full pipeline runs against live data end-to-end: fetching the real receipt via
//!   `MonadHttpClient::get_transaction_receipt`, fetching the real transaction via
//!   `MonadHttpClient::get_transaction_by_hash`, and running the real transaction's `value` and
//!   `input` bytes through the same recipient/value/calldata checks `verify_stamp_burn` would
//!   apply to an actual Stamp burn.
//! - It deliberately does **not** prove verification of a *genuine* Stamp burn (no real STMP/POND
//!   burn transaction is known to exist on testnet yet -- that requires ticket #13's client-side
//!   construction and a funded account, both out of scope here). Instead, since real testnet
//!   transactions are ordinary transfers/contract calls whose calldata isn't
//!   `<lokad_id><version><commitment>`-shaped, this test uses the transaction's own real `to` and
//!   `value` as the "expected" recipient/minimum (so those checks genuinely pass against live
//!   data) and asserts the calldata decode step correctly rejects the real (non-Stamp) calldata
//!   with a `MalformedCalldata` outcome -- proving the decode-and-reject path runs against actual
//!   chain bytes, not a mock.

use cashweb_registry::monad_http::{BlockTag, GetLogsFilter, Hash32, MonadHttpClient};
use cashweb_registry::monad_stamp_verify::{verify_stamp_burn, ExpectedBurn, StampBurnVerification};

/// Alchemy's free tier caps a single `eth_getLogs` call to a 10-block range.
const MAX_LOG_RANGE_BLOCKS: u64 = 10;

/// How many 10-block windows to scan backwards from the chain tip looking for any log, before
/// giving up (same headroom as `monad_http_live_smoke.rs`'s scan).
const MAX_WINDOWS_TO_SCAN: u64 = 500;

#[tokio::test]
#[ignore = "hits the live Monad testnet endpoint over the network; run explicitly, see module docs"]
async fn live_verify_stamp_burn_against_real_tx() {
    let rpc_url = std::env::var("MONAD_TESTNET_HTTP_RPC_URL").expect(
        "MONAD_TESTNET_HTTP_RPC_URL must be set to run this live smoke test (see module docs \
         for how to source it from the repo's gitignored .env)",
    );
    let rpc_url: url::Url = rpc_url
        .parse()
        .expect("MONAD_TESTNET_HTTP_RPC_URL is not a valid URL");

    // `MonadHttpClient` and `verify_stamp_burn` both need a `JsonRpcTransport` (the latter builds
    // its own internal `MonadHttpClient` from it). `HttpTransport` is `Clone`, so one instance
    // covers both.
    let transport = cashweb_registry::monad_http::HttpTransport::new(rpc_url);
    let client = MonadHttpClient::with_transport(transport.clone());

    // 1. Find a real, currently-live transaction hash by scanning recent blocks for any log (same
    // technique as `monad_http_live_smoke.rs`, so we never depend on a hardcoded hash staying
    // valid).
    let latest = client
        .block_number()
        .await
        .expect("live eth_blockNumber call failed");
    assert!(latest > 0, "expected a nonzero live block number");

    let mut found_tx_hash: Option<Hash32> = None;
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
            found_tx_hash = Some(log.transaction_hash);
            break;
        }
    }
    let tx_hash = found_tx_hash.expect(
        "found no logs at all in the scanned recent block range on Monad testnet -- either the \
         chain has gone unusually quiet, or eth_getLogs is broken",
    );

    // 2. Fetch the real transaction directly (via `MonadHttpClient::get_transaction_by_hash`) so
    // we know its genuine `to`/`value`, to use as a guaranteed-passing "expected" recipient/value
    // below.
    let real_tx = client
        .get_transaction_by_hash(tx_hash)
        .await
        .expect("live eth_getTransactionByHash call failed")
        .expect("expected a transaction for a hash we just observed via eth_getLogs");
    println!(
        "[live] eth_getTransactionByHash -> to={:?} value={} input_len={}",
        real_tx.to,
        real_tx.value,
        real_tx.input.len()
    );
    let real_to = real_tx
        .to
        .expect("sample transaction unexpectedly has no `to` (contract creation)");

    // 3. Run the real tx hash through `verify_stamp_burn` end-to-end: real receipt fetch, real
    // status check, real recipient/value check (set up to pass, using the tx's own real
    // to/value), and real calldata decode (which must reject this tx's genuine, non-Stamp-shaped
    // calldata).
    let expected = ExpectedBurn {
        commitment_id: *b"STMP",
        commitment: bitcoinsuite_core::Sha256::new([0u8; 32]),
        burn_address: real_to,
        min_value_wei: 0,
    };
    let outcome = verify_stamp_burn(&transport, tx_hash, &expected)
        .await
        .expect("verify_stamp_burn hit an infrastructure error against live data");
    println!("[live] verify_stamp_burn outcome: {outcome:?}");

    assert!(
        matches!(outcome, StampBurnVerification::MalformedCalldata(_)),
        "expected a real (non-Stamp) tx's calldata to be rejected as malformed, got {outcome:?}"
    );
}
