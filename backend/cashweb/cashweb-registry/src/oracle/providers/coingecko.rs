//! CoinGecko `GET /api/v3/simple/price?ids=a,b&vs_currencies=usd`. Symbols are CoinGecko coin
//! ids (`bitcoin-cash`).

use std::collections::BTreeMap;

use super::{positive, Quotes, Unreadable, UpstreamRequest};

pub(super) fn request(url: &url::Url, symbols: &BTreeMap<String, String>) -> UpstreamRequest {
    let ids = symbols.values().cloned().collect::<Vec<_>>().join(",");
    UpstreamRequest::get(super::with_query(
        url,
        &[("ids", &ids), ("vs_currencies", "usd")],
    ))
}

pub(super) fn parse(body: &[u8], symbols: &BTreeMap<String, String>) -> Result<Quotes, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let coins = json.as_object().ok_or(Unreadable)?;
    Ok(symbols
        .iter()
        .filter_map(|(asset, id)| Some((asset.clone(), positive(&coins.get(id)?["usd"])?)))
        .collect())
}
