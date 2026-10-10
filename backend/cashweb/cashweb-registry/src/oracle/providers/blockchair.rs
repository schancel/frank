//! Blockchair `GET /stats`: every chain's statistics in one answer (one request point).
//!
//! Per chain: `difficulty`; `circulation` (base units in existence); `inflation_24h` (base units
//! minted in the last 24 hours) and `blocks_24h`, whose quotient is the subsidy per block the
//! chain actually paid. Monero publishes no issuance here, so it gets no subsidy.

use std::collections::BTreeMap;

use cashweb_config::OracleStatsChainConf;

use super::{positive, Unreadable, UpstreamRequest};

/// What one chain's statistics say.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainStats {
    /// The chain's difficulty.
    pub difficulty: f64,
    /// Whole coins in existence.
    pub supply: f64,
    /// Whole coins minted per block over the last 24 hours, before any consensus split.
    pub subsidy: Option<f64>,
}

pub(crate) fn request(url: &url::Url) -> UpstreamRequest {
    UpstreamRequest::get(url.to_string())
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
            let unit = 10f64.powi(row.decimals as i32);
            let subsidy = positive(&stats["inflation_24h"])
                .zip(positive(&stats["blocks_24h"]))
                .map(|(minted, blocks)| minted / unit / blocks);
            Some((
                chain.clone(),
                ChainStats {
                    difficulty: positive(&stats["difficulty"])?,
                    supply: positive(&stats["circulation"])? / unit,
                    subsidy,
                },
            ))
        })
        .collect())
}
