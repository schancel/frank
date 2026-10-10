//! The European Central Bank's euro reference rates, last 90 days
//! (`eurofxref-hist-90d.xml`): US dollars per euro for each working day.

use std::collections::BTreeMap;

use super::{parse_utc_date, Unreadable, UpstreamRequest};

pub(crate) fn request(url: &url::Url) -> UpstreamRequest {
    UpstreamRequest::get(url.to_string())
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let rest = &tag[tag.find(&format!("{name}="))? + name.len() + 1..];
    let quote = rest.chars().next().filter(|c| matches!(c, '\'' | '"'))?;
    rest[1..].split(quote).next()
}

/// Start of each published UTC day -> US dollars per euro.
pub(crate) fn parse(body: &[u8]) -> Result<BTreeMap<u64, f64>, Unreadable> {
    let text = std::str::from_utf8(body).map_err(|_| Unreadable)?;
    let mut rates = BTreeMap::new();
    let mut day = None;
    for tag in text.split('<').filter(|tag| tag.starts_with("Cube")) {
        if let Some(time) = attribute(tag, "time") {
            day = parse_utc_date(time);
        } else if attribute(tag, "currency") == Some("USD") {
            let rate = attribute(tag, "rate")
                .and_then(|rate| rate.parse::<f64>().ok())
                .filter(|rate| rate.is_finite() && *rate > 0.0);
            if let (Some(day), Some(rate)) = (day, rate) {
                rates.insert(day, rate);
            }
        }
    }
    if rates.is_empty() {
        return Err(Unreadable);
    }
    Ok(rates)
}
