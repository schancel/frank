//! Chainlink USD price feeds, read with `eth_call latestRoundData()` on an EVM JSON-RPC endpoint
//! (the shipped configuration uses Arbitrum One's public endpoint). Symbols are feed contract
//! addresses. All feeds are asked in one JSON-RPC batch, numbered from 1 in asset order. USD feeds have 8 decimals.

use std::collections::BTreeMap;

use super::{Quotes, Unreadable, UpstreamRequest};

/// `latestRoundData()`.
const SELECTOR: &str = "0xfeaf968c";
const USD_FEED_DECIMALS: i32 = 8;

pub(super) fn request(url: &url::Url, symbols: &BTreeMap<String, String>) -> UpstreamRequest {
    let calls = symbols
        .values()
        .zip(1u64..)
        .map(|(feed, id)| {
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "eth_call",
                "params": [{ "to": feed, "data": SELECTOR }, "latest"],
            })
        })
        .collect::<Vec<_>>();
    UpstreamRequest {
        url: url.to_string(),
        body: Some(serde_json::Value::Array(calls).to_string()),
    }
}

pub(super) fn parse(body: &[u8], symbols: &BTreeMap<String, String>) -> Result<Quotes, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let answers = json.as_array().ok_or(Unreadable)?;
    Ok(symbols
        .keys()
        .zip(1u64..)
        .filter_map(|(asset, id)| {
            let answer = answers.iter().find(|answer| answer["id"] == id)?;
            let hex = answer["result"].as_str()?.trim_start_matches("0x");
            // Five 32-byte words: roundId, answer, startedAt, updatedAt, answeredInRound.
            // Only hex digits are sliced: anything else is not an answer.
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            let word = hex.get(64..128)?;
            let (high, low) = word.split_at(32);
            // A price fits 128 bits; a set high half is a negative or absurd answer.
            if high.bytes().any(|digit| digit != b'0') {
                return None;
            }
            let raw = u128::from_str_radix(low, 16).ok()?;
            let price = raw as f64 / 10f64.powi(USD_FEED_DECIMALS);
            (price > 0.0).then(|| (asset.clone(), price))
        })
        .collect())
}
