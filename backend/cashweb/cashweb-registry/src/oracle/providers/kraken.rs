//! Kraken `GET /0/public/Ticker?pair=a,b,c`. Symbols are the pair names Kraken answers under
//! (`XXBTZUSD`, `SOLUSD`); the price is the last trade (`c[0]`).

use std::collections::BTreeMap;

use super::{positive, Quotes, Unreadable, UpstreamRequest};

pub(super) fn request(url: &url::Url, symbols: &BTreeMap<String, String>) -> UpstreamRequest {
    let pairs = symbols.values().cloned().collect::<Vec<_>>().join(",");
    UpstreamRequest::get(super::with_query(url, &[("pair", &pairs)]))
}

pub(super) fn parse(body: &[u8], symbols: &BTreeMap<String, String>) -> Result<Quotes, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let result = json["result"].as_object().ok_or(Unreadable)?;
    Ok(symbols
        .iter()
        .filter_map(|(asset, pair)| Some((asset.clone(), positive(&result.get(pair)?["c"][0])?)))
        .collect())
}
