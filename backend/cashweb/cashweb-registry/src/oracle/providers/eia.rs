//! US Energy Information Administration API v2. Needs a key, sent as the `api_key` query
//! parameter. The configured URL is a complete v2 `/data/` route; every v2 route answers
//! `{"response": {"data": [{"period": "2026-10-08", "<column>": <number or string>, ...}]}}`.
//!
//! NOT verified against the live API: no key was available when this was written. The test
//! below reads an answer written from EIA's published format, not a recorded one.

use std::collections::BTreeMap;

use super::{parse_utc_date, Unreadable, UpstreamRequest};

pub(crate) fn request(url: &url::Url, key: &str) -> UpstreamRequest {
    UpstreamRequest::get(super::with_query(url, &[("api_key", key)]))
}

/// Start of each period (a day, or the first of a month) -> US dollars per kWh. Rows of one
/// period (several hubs) are averaged. Zero and negative prices are kept.
pub(crate) fn parse(
    body: &[u8],
    value_field: &str,
    usd_per_kwh_factor: f64,
) -> Result<BTreeMap<u64, f64>, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    let rows = json["response"]["data"].as_array().ok_or(Unreadable)?;
    let mut periods = BTreeMap::<u64, (f64, u32)>::new();
    for row in rows {
        let value = match &row[value_field] {
            serde_json::Value::Number(number) => number.as_f64(),
            serde_json::Value::String(text) => text.parse().ok(),
            _ => None,
        };
        let period = row["period"].as_str().and_then(parse_utc_date);
        if let (Some(period), Some(value)) = (period, value.filter(|value| value.is_finite())) {
            let entry = periods.entry(period).or_insert((0.0, 0));
            entry.0 += value;
            entry.1 += 1;
        }
    }
    Ok(periods
        .into_iter()
        .map(|(period, (sum, count))| (period, sum / f64::from(count) * usd_per_kwh_factor))
        .collect())
}
