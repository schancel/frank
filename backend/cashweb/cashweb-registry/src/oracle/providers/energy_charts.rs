//! Energy-Charts `GET /price?bzn=<zone>&start=<date>&end=<date>`: day-ahead wholesale prices of a
//! European bidding zone in EUR/MWh, at 15-minute or hourly resolution. Licence CC BY 4.0
//! (Bundesnetzagentur | SMARD.de). Keyless, rate-limited: asked once a day.

use std::collections::BTreeMap;

use super::{utc_date, Unreadable, UpstreamRequest};

/// A day counts when its prices reach from within an hour of 00:00 to within an hour of 24:00.
const EDGE_SLACK_S: u64 = 3600;

pub(crate) fn request(
    url: &url::Url,
    zone: &str,
    first_day: u64,
    last_day: u64,
) -> UpstreamRequest {
    UpstreamRequest::get(super::with_query(
        url,
        &[
            ("bzn", zone),
            ("start", &utc_date(first_day)),
            ("end", &utc_date(last_day)),
        ],
    ))
}

/// Start of each complete UTC day -> the mean of its prices, in EUR/MWh.
pub(crate) fn parse(body: &[u8]) -> Result<BTreeMap<u64, f64>, Unreadable> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| Unreadable)?;
    if json["unit"].as_str().map(|unit| unit.replace(' ', "")) != Some("EUR/MWh".to_owned()) {
        return Err(Unreadable);
    }
    let times = json["unix_seconds"].as_array().ok_or(Unreadable)?;
    let prices = json["price"].as_array().ok_or(Unreadable)?;
    // day -> (sum, count, first time, last time)
    let mut days = BTreeMap::<u64, (f64, u32, u64, u64)>::new();
    for (time, price) in times.iter().zip(prices) {
        // Hours not yet auctioned are null.
        let (Some(time), Some(price)) = (time.as_u64(), price.as_f64()) else {
            continue;
        };
        let day = time - time % 86_400;
        let entry = days.entry(day).or_insert((0.0, 0, time, time));
        entry.0 += price;
        entry.1 += 1;
        entry.3 = time;
    }
    Ok(days
        .into_iter()
        .filter(|(day, (_, _, first, last))| {
            *first <= day + EDGE_SLACK_S && *last >= day + 86_400 - EDGE_SLACK_S
        })
        .map(|(day, (sum, count, _, _))| (day, sum / f64::from(count)))
        .collect())
}
