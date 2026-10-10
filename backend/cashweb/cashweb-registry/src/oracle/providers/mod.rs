//! Provider adapters. Each module turns one provider's answer into normalised values and knows
//! nothing about sampling or storage. A provider's symbols come from configuration; an adapter
//! never names an asset.
//!
//! Every price adapter asks for all its assets in one request.

use std::collections::BTreeMap;

use cashweb_config::{OraclePriceAdapter, OraclePriceProviderConf};

pub mod binance;
pub mod blockchair;
pub mod chainlink;
pub mod coinbase;
pub mod coingecko;
pub mod ecb;
pub mod eia;
pub mod energy_charts;
pub mod kraken;

/// One HTTP request to a provider. `body` makes it a JSON `POST`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpstreamRequest {
    /// Complete URL. May carry a key: never logged.
    pub url: String,
    /// JSON body of a `POST`, or `None` for a `GET`.
    pub body: Option<String>,
}

impl UpstreamRequest {
    pub(crate) fn get(url: impl Into<String>) -> Self {
        UpstreamRequest {
            url: url.into(),
            body: None,
        }
    }
}

/// The answer could not be read as what the adapter expects. Carries no upstream text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unreadable;

/// Asset identifier -> US dollars per whole coin.
pub type Quotes = BTreeMap<String, f64>;

/// `base?key=value&...` with values percent-encoded; `base` may already carry a query.
pub(crate) fn with_query(base: &url::Url, pairs: &[(&str, &str)]) -> String {
    let mut url = base.clone();
    url.query_pairs_mut().extend_pairs(pairs);
    url.into()
}

/// A positive finite number from a JSON number or a numeric string.
pub(crate) fn positive(value: &serde_json::Value) -> Option<f64> {
    let number = match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.parse().ok(),
        _ => None,
    }?;
    (number.is_finite() && number > 0.0).then_some(number)
}

/// The request asking `provider` for `symbols` (asset -> provider symbol).
pub fn price_request(
    provider: &OraclePriceProviderConf,
    symbols: &BTreeMap<String, String>,
) -> UpstreamRequest {
    match provider.adapter {
        OraclePriceAdapter::Coinbase => coinbase::request(&provider.api_url),
        OraclePriceAdapter::Kraken => kraken::request(&provider.api_url, symbols),
        OraclePriceAdapter::Binance => binance::request(&provider.api_url, symbols),
        OraclePriceAdapter::Coingecko => coingecko::request(&provider.api_url, symbols),
        OraclePriceAdapter::Chainlink => chainlink::request(&provider.api_url, symbols),
    }
}

/// Reads `provider`'s answer to [`price_request`] for the same `symbols`.
pub fn parse_prices(
    adapter: OraclePriceAdapter,
    body: &[u8],
    symbols: &BTreeMap<String, String>,
) -> Result<Quotes, Unreadable> {
    match adapter {
        OraclePriceAdapter::Coinbase => coinbase::parse(body, symbols),
        OraclePriceAdapter::Kraken => kraken::parse(body, symbols),
        OraclePriceAdapter::Binance => binance::parse(body, symbols),
        OraclePriceAdapter::Coingecko => coingecko::parse(body, symbols),
        OraclePriceAdapter::Chainlink => chainlink::parse(body, symbols),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month = i64::from(month);
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `YYYY-MM-DD` of the UTC day containing `unix_seconds`.
pub(crate) fn utc_date(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Unix seconds of 00:00 UTC on `YYYY-MM-DD`, or on the first of the month for `YYYY-MM`.
pub(crate) fn parse_utc_date(text: &str) -> Option<u64> {
    let mut parts = text.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = match parts.next() {
        Some(day) => day.get(..2)?.parse().ok()?,
        None => 1,
    };
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) as u64 * 86_400)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use cashweb_config::OraclePriceAdapter;

    use super::{parse_prices, parse_utc_date, price_request, utc_date, Unreadable};

    /// The shipped configuration: the symbols tested here are the ones a relay really sends.
    fn shipped() -> cashweb_config::OracleConf {
        cashweb_config::parse_conf(include_str!("../../../../cashwebd.local.toml"))
            .expect("shipped config parses")
            .registry
            .oracle
            .expect("shipped config has the oracle")
    }

    fn fixture(provider: &str) -> &'static [u8] {
        match provider {
            "coinbase" => include_bytes!("../fixtures/coinbase.json"),
            "kraken" => include_bytes!("../fixtures/kraken.json"),
            "coingecko" => include_bytes!("../fixtures/coingecko.json"),
            "binance" => include_bytes!("../fixtures/binance.json"),
            "binance-us" => include_bytes!("../fixtures/binance_us.json"),
            "chainlink" => include_bytes!("../fixtures/chainlink.json"),
            other => panic!("no recorded answer for {other}"),
        }
    }

    /// Every price adapter, on the answer its provider really gave (all recorded within a
    /// minute on 2026-10-10), with the shipped symbols: each configured asset the provider
    /// answered for comes out in US dollars per whole coin. Units are checked by agreement:
    /// independent providers put the same coin within 1% of each other, which an inverted
    /// rate, a wrong decimal count or a swapped symbol would break by orders of magnitude.
    #[test]
    fn every_price_adapter_reads_its_recorded_answer_in_dollars_per_coin() {
        let conf = shipped();
        let mut by_asset = BTreeMap::<String, Vec<(String, f64)>>::new();
        for provider in &conf.price_providers {
            let parsed = parse_prices(provider.adapter, fixture(&provider.id), &provider.symbols);
            if provider.id == "binance" {
                // binance.com refused this machine (451, a JSON object): not a price list.
                assert_eq!(parsed, Err(Unreadable));
                continue;
            }
            let quotes = parsed.unwrap_or_else(|_| panic!("{} answer is readable", provider.id));
            assert_eq!(
                quotes.keys().collect::<Vec<_>>(),
                provider.symbols.keys().collect::<Vec<_>>(),
                "{} answered for every asset it is configured to list",
                provider.id
            );
            for (asset, price) in quotes {
                by_asset
                    .entry(asset)
                    .or_default()
                    .push((provider.id.clone(), price));
            }
        }
        let price = |asset: &str, provider: &str| {
            by_asset[asset]
                .iter()
                .find(|(id, _)| id == provider)
                .map(|(_, price)| *price)
                .unwrap_or_else(|| panic!("{provider} has no {asset}"))
        };
        // Spot values from the recorded answers.
        assert!((price("btc-mainnet", "coinbase") - 82_957.38).abs() < 0.01);
        assert_eq!(price("btc-mainnet", "kraken"), 82_985.3);
        assert_eq!(price("btc-mainnet", "binance-us"), 83_062.48);
        assert_eq!(price("btc-mainnet", "coingecko"), 82_953.0);
        assert_eq!(price("btc-mainnet", "chainlink"), 82_946.69688311);
        assert_eq!(price("ethereum-mainnet", "chainlink"), 2_502.82870993);
        assert_eq!(price("doge-mainnet", "kraken"), 0.086_051_8);
        assert_eq!(price("xmr-mainnet", "kraken"), 523.08);
        assert_eq!(price("xec-mainnet", "coingecko"), 7.34e-06);
        assert_eq!(price("monad-mainnet", "kraken"), 0.024_71);
        for (asset, quotes) in &by_asset {
            let low = quotes.iter().map(|(_, p)| *p).fold(f64::INFINITY, f64::min);
            let high = quotes.iter().map(|(_, p)| *p).fold(0.0, f64::max);
            assert!(high / low < 1.01, "{asset}: {quotes:?}");
        }
        // Every asset the feed prices is listed by someone, and the basket coins by two.
        for asset in [
            "btc-mainnet",
            "bch-mainnet",
            "ltc-mainnet",
            "doge-mainnet",
            "xmr-mainnet",
        ] {
            assert!(by_asset[asset].len() >= 2, "{asset}");
        }
    }

    /// One request per provider carries every asset it lists.
    #[test]
    fn a_provider_is_asked_for_all_its_assets_in_one_request() {
        let conf = shipped();
        let request = |id: &str| {
            let provider = conf.price_providers.iter().find(|p| p.id == id).expect(id);
            price_request(provider, &provider.symbols)
        };
        let kraken = request("kraken");
        assert_eq!(kraken.body, None);
        assert!(kraken
            .url
            .starts_with("https://api.kraken.com/0/public/Ticker?pair=BCHUSD%2C"));
        assert_eq!(kraken.url.matches("%2C").count(), 10, "eleven pairs");
        assert_eq!(
            request("coinbase").url,
            "https://api.coinbase.com/v2/exchange-rates?currency=USD"
        );
        let binance = url::Url::parse(&request("binance-us").url).unwrap();
        let symbols = binance.query_pairs().next().unwrap().1.into_owned();
        assert!(
            symbols.starts_with("[\"BCHUSDT\",\"BTCUSDT\","),
            "{symbols}"
        );
        assert!(request("coingecko").url.ends_with("&vs_currencies=usd"));
        let chainlink = request("chainlink");
        let calls: serde_json::Value = serde_json::from_str(&chainlink.body.unwrap()).unwrap();
        assert_eq!(calls.as_array().map(Vec::len), Some(2));
        assert_eq!(calls[0]["params"][0]["data"], "0xfeaf968c");
    }

    #[test]
    fn an_answer_that_is_not_the_expected_document_is_unreadable_not_empty() {
        let symbols = BTreeMap::from([("btc-mainnet".to_owned(), "BTC".to_owned())]);
        for adapter in [
            OraclePriceAdapter::Coinbase,
            OraclePriceAdapter::Kraken,
            OraclePriceAdapter::Binance,
            OraclePriceAdapter::Coingecko,
            OraclePriceAdapter::Chainlink,
        ] {
            assert_eq!(
                parse_prices(adapter, b"unauthorized", &symbols),
                Err(Unreadable)
            );
        }
        // Zero, negative and non-numeric prices are no price.
        let kraken = br#"{"error":[],"result":{"BTC":{"c":["0","1"]}}}"#;
        assert_eq!(
            parse_prices(OraclePriceAdapter::Kraken, kraken, &symbols),
            Ok(BTreeMap::new())
        );
    }

    /// EIA v2 as its documentation shows it; not a recorded answer (no key was available).
    #[test]
    fn eia_rows_become_dollars_per_kwh_by_period() {
        let body = br#"{"response":{"total":"3","data":[
            {"period":"2026-10-08","hub":"A","price":"40.0","price-units":"$/MWh"},
            {"period":"2026-10-08","hub":"B","price":60},
            {"period":"2026-10-07","hub":"A","price":-5.0},
            {"period":"2026-10-06","hub":"A","price":null}]}}"#;
        let days = super::eia::parse(body, "price", 0.001).expect("readable");
        assert_eq!(
            days.into_iter().collect::<Vec<_>>(),
            vec![
                (parse_utc_date("2026-10-07").unwrap(), -0.005),
                (parse_utc_date("2026-10-08").unwrap(), 0.05),
            ]
        );
        let request = super::eia::request(
            &"https://api.eia.gov/v2/x/data/?frequency=daily"
                .parse()
                .unwrap(),
            "k",
        );
        assert_eq!(
            request.url,
            "https://api.eia.gov/v2/x/data/?frequency=daily&api_key=k"
        );
    }

    #[test]
    fn dates_round_trip_through_unix_seconds() {
        assert_eq!(parse_utc_date("1970-01-01"), Some(0));
        assert_eq!(parse_utc_date("2026-10-09"), Some(1_791_504_000));
        assert_eq!(utc_date(1_791_504_000 + 86_399), "2026-10-09");
        assert_eq!(
            parse_utc_date("2024-02-29").map(utc_date).unwrap(),
            "2024-02-29"
        );
        assert_eq!(parse_utc_date("2026-10"), parse_utc_date("2026-10-01"));
        assert_eq!(parse_utc_date("2026-13-01"), None);
    }
}
