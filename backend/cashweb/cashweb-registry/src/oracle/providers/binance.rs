//! Binance and Binance.US `GET /api/v3/ticker/price?symbols=["A","B"]`. Symbols are market names
//! (`BTCUSDT`). The quote currency is whatever the market trades against; the relay treats a
//! USDT market as dollars, as the app did.

use std::collections::BTreeMap;

use super::{positive, Quotes, Unreadable, UpstreamRequest};

pub(super) fn request(url: &url::Url, symbols: &BTreeMap<String, String>) -> UpstreamRequest {
    let markets = serde_json::to_string(&symbols.values().collect::<Vec<_>>())
        .expect("a list of strings serialises");
    UpstreamRequest::get(super::with_query(url, &[("symbols", &markets)]))
}

pub(super) fn parse(body: &[u8], symbols: &BTreeMap<String, String>) -> Result<Quotes, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let rows = json.as_array().ok_or(Unreadable)?;
    Ok(symbols
        .iter()
        .filter_map(|(asset, market)| {
            let row = rows.iter().find(|row| row["symbol"] == market.as_str())?;
            Some((asset.clone(), positive(&row["price"])?))
        })
        .collect())
}
