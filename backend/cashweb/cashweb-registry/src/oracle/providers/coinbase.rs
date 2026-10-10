//! Coinbase `GET /v2/exchange-rates?currency=USD`: every currency Coinbase lists in one answer,
//! as units of the currency per US dollar. Symbols are Coinbase currency codes (`BTC`).

use std::collections::BTreeMap;

use super::{positive, Quotes, Unreadable, UpstreamRequest};

pub(super) fn request(url: &url::Url) -> UpstreamRequest {
    UpstreamRequest::get(super::with_query(url, &[("currency", "USD")]))
}

pub(super) fn parse(body: &[u8], symbols: &BTreeMap<String, String>) -> Result<Quotes, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let rates = json["data"]["rates"].as_object().ok_or(Unreadable)?;
    Ok(symbols
        .iter()
        .filter_map(|(asset, code)| {
            // Coins per dollar; the price is its inverse.
            let per_dollar = positive(rates.get(code)?)?;
            Some((asset.clone(), 1.0 / per_dollar))
        })
        .collect())
}
