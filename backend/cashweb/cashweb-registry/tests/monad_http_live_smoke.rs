//! Standalone, **not wired into app logic**, live smoke test for [`MonadHttpClient`]
//! (ticket #12), proving the read-path JSON-RPC calls (`eth_getLogs`,
//! `eth_getTransactionReceipt`) actually work against the live Alchemy-hosted Monad testnet
//! endpoint.
//!
//! This test is `#[ignore]`d so `cargo test -p cashweb-registry` (the normal gate) never depends
//! on network access or a secret; run it explicitly with the RPC URL in the environment:
//!
//! ```sh
//! export $(grep -v '^#' /path/to/frank/.env | grep MONAD_TESTNET_HTTP_RPC_URL)
//! cargo test -p cashweb-registry --test monad_http_live_smoke -- --ignored --nocapture
//! ```
//!
//! ## What this does and doesn't prove
//! - It proves `block_number` and `get_logs` round-trip against the live endpoint, and that a
//!   `transactionHash` observed in a real `eth_getLogs` response can be fed straight into
//!   `get_transaction_receipt` and get back a matching, fully-parsed real receipt.
//! - It deliberately does **not** call `send_raw_transaction`: broadcasting a real tx needs a
//!   funded testnet account, which is out of scope for this ticket. `send_raw_transaction`'s
//!   request-shaping (method name, params encoding) and error classification are covered by
//!   mocked-transport unit tests in `cashweb-registry/src/monad_http.rs` instead.

use cashweb_registry::monad_http::{BlockTag, GetLogsFilter, MonadHttpClient};

/// Alchemy's free tier caps a single `eth_getLogs` call to a 10-block range.
const MAX_LOG_RANGE_BLOCKS: u64 = 10;

/// How many 10-block windows to scan backwards from the chain tip looking for any log, before
/// giving up. Monad testnet has been observed to have logs in essentially every recent window
/// (system/precompile activity), so this is generous headroom against a temporarily quiet spell.
const MAX_WINDOWS_TO_SCAN: u64 = 500;

#[tokio::test]
#[ignore = "hits the live Monad testnet endpoint over the network; run explicitly, see module docs"]
async fn live_get_logs_and_get_transaction_receipt_round_trip() {
    let rpc_url = std::env::var("MONAD_TESTNET_HTTP_RPC_URL").expect(
        "MONAD_TESTNET_HTTP_RPC_URL must be set to run this live smoke test (see module docs \
         for how to source it from the repo's gitignored .env)",
    );
    let rpc_url: url::Url = rpc_url
        .parse()
        .expect("MONAD_TESTNET_HTTP_RPC_URL is not a valid URL");
    let client = MonadHttpClient::new(rpc_url);

    // 1. `eth_blockNumber`: prove basic connectivity and get a real, current block number.
    let latest = client
        .block_number()
        .await
        .expect("live eth_blockNumber call failed");
    println!("[live] eth_blockNumber -> {latest}");
    assert!(latest > 0, "expected a nonzero live block number");

    // 2. `eth_getLogs`: scan backwards in 10-block windows (the free-tier range cap) from the
    // chain tip until we find at least one real log, proving the read-path + response parsing
    // works against live data.
    let mut found_logs = None;
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
        if !logs.is_empty() {
            println!(
                "[live] eth_getLogs [{from_block:#x}, {to_block:#x}] -> {} log(s)",
                logs.len()
            );
            found_logs = Some(logs);
            break;
        }
    }
    let logs = found_logs.expect(
        "found no logs at all in the scanned recent block range on Monad testnet -- either the \
         chain has gone unusually quiet, or eth_getLogs is broken",
    );
    let sample_log = &logs[0];
    println!(
        "[live] sample log: address={} tx_hash={} block_number={:?}",
        sample_log.address, sample_log.transaction_hash, sample_log.block_number
    );

    // 3. `eth_getTransactionReceipt`: feed the real transaction hash we just observed back in,
    // proving the full read-path round trip against live data (not just that *some* JSON came
    // back, but that a real, currently-valid hash resolves to a matching, fully-parsed receipt).
    let receipt = client
        .get_transaction_receipt(sample_log.transaction_hash)
        .await
        .expect("live eth_getTransactionReceipt call failed")
        .expect("expected a receipt for a transaction hash we just observed via eth_getLogs");
    println!(
        "[live] eth_getTransactionReceipt -> block_number={} gas_used={} succeeded={:?}",
        receipt.block_number,
        receipt.gas_used,
        receipt.succeeded()
    );
    assert_eq!(receipt.transaction_hash, sample_log.transaction_hash);
}
