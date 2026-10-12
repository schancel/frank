//! Chainlink USD price feeds, read with `eth_call latestRoundData()` on an EVM JSON-RPC endpoint
//! (the shipped configuration uses Arbitrum One's public endpoint). Symbols are feed contract
//! addresses. All feeds are asked in one JSON-RPC batch, numbered from 1 in asset order. USD feeds have 8 decimals.

use std::collections::BTreeMap;

use super::{ObservedQuotes, PriceObservation, Unreadable, UpstreamRequest};

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

pub(super) fn parse(
    body: &[u8],
    symbols: &BTreeMap<String, String>,
) -> Result<ObservedQuotes, Unreadable> {
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
            if hex.len() != 320 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            let integer = |index: usize| {
                let word = hex.get(index * 64..(index + 1) * 64)?;
                u128::from_str_radix(word, 16).ok()
            };
            let round = integer(0)?;
            let started = u64::try_from(integer(2)?).ok()?;
            let observed = u64::try_from(integer(3)?).ok()?;
            if round == 0 || started == 0 || started > observed || integer(4)? < round {
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
            (price.is_finite() && price > 0.0).then(|| {
                (
                    asset.clone(),
                    PriceObservation {
                        value: price,
                        observed_at: Some(observed),
                    },
                )
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(words: [u128; 5]) -> Vec<u8> {
        let hex = words
            .iter()
            .map(|word| format!("{word:064x}"))
            .collect::<String>();
        serde_json::json!([{ "id": 1, "result": format!("0x{hex}") }])
            .to_string()
            .into_bytes()
    }
    #[test]
    fn reads_actual_round_timestamp_and_rejects_incomplete_rounds() {
        let symbols = BTreeMap::from([("gold".to_owned(), "proxy".to_owned())]);
        let valid = [2, 400_000_000_000, 100, 200, 2];
        let quotes = parse(&body(valid), &symbols).unwrap();
        assert_eq!(
            quotes["gold"],
            PriceObservation {
                value: 4000.0,
                observed_at: Some(200)
            }
        );
        for (index, value) in [(0, 0), (1, 0), (2, 0), (2, 201), (3, 0), (4, 1)] {
            let mut words = valid;
            words[index] = value;
            assert!(parse(&body(words), &symbols).unwrap().is_empty());
        }
        assert!(parse(br#"[{"id":1,"result":"0x01"}]"#, &symbols)
            .unwrap()
            .is_empty());
    }
}
