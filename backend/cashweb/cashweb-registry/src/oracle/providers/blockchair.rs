//! Observed 24-hour hash rates and supply from Blockchair `/stats`, with an exact
//! fee/issuance aggregate over the same tip-anchored block set. Missing fees are not zero.

use super::{positive, with_query, Unreadable, UpstreamRequest};
use cashweb_config::OracleStatsChainConf;
use std::collections::BTreeMap;

/// Statistics for a chain; mining revenue requires a separate validated aggregate.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainStats {
    /// Observed average hashes per second over the provider's 24-hour window.
    pub hashrate: f64,
    /// Whole coins in existence.
    pub supply: f64,
    /// Block set whose issuance/count can be independently checked. Monero lacks this data.
    pub window: Option<BlockWindow>,
}

/// Exact base-unit issuance and block range reported by the same stats snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockWindow {
    /// Inclusive final height of the stats snapshot.
    pub tip: u64,
    /// Number of blocks in its trailing 24-hour window.
    pub blocks: u64,
    /// Newly issued base units, excluding transaction fees.
    pub issuance: u64,
    /// Last block's timestamp, for consensus-split boundary checks.
    pub end: u64,
}

/// Exact aggregated base-unit quantities, retained before conversion to whole coins.
#[derive(Clone, Debug, PartialEq)]
pub struct MiningTotals {
    /// Sum of transaction fees in base units.
    pub fees: u64,
    /// Newly issued base units, excluding transaction fees.
    pub issuance: u64,
}

fn integer(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn timestamp(value: &serde_json::Value) -> Option<u64> {
    let text = value.as_str()?;
    if text.len() != 19 {
        return None;
    }
    let day = super::parse_utc_date(text.get(..10)?)?;
    let hour: u64 = text.get(11..13)?.parse().ok()?;
    let minute: u64 = text.get(14..16)?.parse().ok()?;
    let second: u64 = text.get(17..19)?.parse().ok()?;
    (hour < 24 && minute < 60 && second < 60).then_some(day + hour * 3600 + minute * 60 + second)
}

pub(crate) fn request(url: &url::Url) -> UpstreamRequest {
    UpstreamRequest::get(url.to_string())
}

/// Keep operator-supplied query credentials; replace only the `/stats` resource path.
pub(crate) fn totals_request(
    base: &url::Url,
    name: &str,
    window: &BlockWindow,
) -> Option<UpstreamRequest> {
    let first = window.tip.checked_add(1)?.checked_sub(window.blocks)?;
    let mut url = base.clone();
    let prefix = url.path().strip_suffix("/stats")?;
    url.set_path(&format!("{prefix}/{name}/blocks"));
    Some(UpstreamRequest::get(with_query(
        &url,
        &[
            ("a", "sum(fee_total),sum(generation),count()"),
            ("q", &format!("id({first}..{})", window.tip)),
        ],
    )))
}

/// Reject truncated/different snapshots rather than estimating fees from a rounded mean.
pub(crate) fn parse_totals(
    body: &[u8],
    expected: &BlockWindow,
) -> Result<MiningTotals, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let rows = json["data"].as_array().ok_or(Unreadable)?;
    if rows.len() != 1 {
        return Err(Unreadable);
    }
    let row = &rows[0];
    let fees = integer(&row["sum(fee_total)"]).ok_or(Unreadable)?;
    let issuance = integer(&row["sum(generation)"]).ok_or(Unreadable)?;
    let count = integer(&row["count()"]).ok_or(Unreadable)?;
    if count != expected.blocks
        || issuance != expected.issuance
        || fees.checked_add(issuance).is_none()
    {
        return Err(Unreadable);
    }
    Ok(MiningTotals { fees, issuance })
}

pub(crate) fn parse(
    body: &[u8],
    chains: &BTreeMap<String, OracleStatsChainConf>,
) -> Result<BTreeMap<String, ChainStats>, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let data = json["data"].as_object().ok_or(Unreadable)?;
    Ok(chains
        .iter()
        .filter_map(|(chain, row)| {
            let stats = &data.get(&row.name)?["data"];
            let window = (|| {
                let tip = integer(&stats["best_block_height"])?;
                let blocks = integer(&stats["blocks_24h"])?;
                let issuance = integer(&stats["inflation_24h"])?;
                if blocks == 0 || blocks > tip.checked_add(1)? || issuance == 0 {
                    return None;
                }
                Some(BlockWindow {
                    tip,
                    blocks,
                    issuance,
                    end: timestamp(&stats["best_block_time"])?,
                })
            })();
            Some((
                chain.clone(),
                ChainStats {
                    hashrate: positive(&stats["hashrate_24h"])?,
                    supply: positive(&stats["circulation"])? / 10f64.powi(row.decimals as i32),
                    window,
                },
            ))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window() -> BlockWindow {
        BlockWindow {
            tip: 100,
            blocks: 2,
            issuance: 625000000,
            end: 1791651600,
        }
    }
    #[test]
    fn observed_hashrate_does_not_require_or_fall_back_to_difficulty() {
        let chains = [(
            "btc-mainnet".to_owned(),
            OracleStatsChainConf {
                name: "bitcoin".to_owned(),
                decimals: 8,
            },
        )]
        .into();
        let body = br#"{"data":{"bitcoin":{"data":{"hashrate_24h":"123456789","difficulty":999,"circulation":100000000}}}}"#;
        let parsed = parse(body, &chains).unwrap();
        assert_eq!(parsed["btc-mainnet"].hashrate, 123456789.0);
        assert_eq!(parsed["btc-mainnet"].supply, 1.0);
        assert_eq!(parsed["btc-mainnet"].window, None);
        let missing = std::str::from_utf8(body)
            .unwrap()
            .replace("\"hashrate_24h\":\"123456789\",", "");
        assert!(parse(missing.as_bytes(), &chains).unwrap().is_empty());
    }

    #[test]
    fn exact_fees_require_matching_issuance_and_count_and_explicit_zero() {
        let body =
            br#"{"data":[{"sum(fee_total)":10000000,"sum(generation)":625000000,"count()":2}]}"#;
        assert_eq!(
            parse_totals(body, &window()),
            Ok(MiningTotals {
                fees: 10000000,
                issuance: 625000000
            })
        );
        let text = std::str::from_utf8(body).unwrap();
        for bad in [
            text.replace("625000000", "625000001"),
            text.replace("\"count()\":2", "\"count()\":1"),
            text.replace("10000000", "null"),
            text.replace("10000000", "-1"),
            text.replace("10000000", "1.5"),
        ] {
            assert_eq!(parse_totals(bad.as_bytes(), &window()), Err(Unreadable));
        }
        assert_eq!(
            parse_totals(text.replace("10000000", "0").as_bytes(), &window())
                .unwrap()
                .fees,
            0
        );
    }
    #[test]
    fn aggregate_is_anchored_to_stats_tip_and_keeps_credentials() {
        let request = totals_request(
            &url::Url::parse("https://provider/stats?key=test").unwrap(),
            "bitcoin",
            &window(),
        )
        .unwrap();
        let url = url::Url::parse(&request.url).unwrap();
        assert_eq!(url.path(), "/bitcoin/blocks");
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["q"], "id(99..100)");
        assert_eq!(query["key"], "test");
        assert_eq!(query["a"], "sum(fee_total),sum(generation),count()");
    }
}
