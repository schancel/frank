//! History and curated steps compiled into the binary: `docs/protocol/oracle/seed.json`, a
//! generated file (source: `packages/price-feeds/src/historical/`, generator:
//! `packages/price-feeds/scripts/build-oracle-seed.py`). The relay serves it and never fetches
//! it. It also carries the basket definition and the labels of regions that have history.

use std::collections::BTreeMap;

use bitcoinsuite_error::{Report, Result};
use serde::Deserialize;

const EMBEDDED: &str = include_str!("../../../../../docs/protocol/oracle/seed.json");

/// The kinds of series the feed serves.
pub const SERIES_KINDS: [&str; 6] = [
    "price",
    "marketCap",
    "difficulty",
    "blockReward",
    "efficiency",
    "electricity",
];

/// Whether `name` is `<kind>/<id>` with a served kind and an id of `a-z 0-9 -`.
pub fn is_series_name(name: &str) -> bool {
    name.split_once('/').is_some_and(|(kind, id)| {
        SERIES_KINDS.contains(&kind)
            && !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// One bundled series.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedSeries {
    /// What a value is.
    pub unit: String,
    /// Where the values come from, for display.
    pub source: String,
    /// When the data was retrieved, unix seconds.
    pub as_of: u64,
    /// `[unixSeconds, value]`, oldest first, strictly increasing times.
    pub points: Vec<(u64, f64)>,
}

/// A region the seed has history for.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SeedRegion {
    /// Region id.
    pub id: String,
    /// Display name.
    pub label: String,
    /// The attribution the source asks for.
    pub attribution: String,
}

/// Everything bundled.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Seed {
    /// The basket definition, served verbatim as the feed's `basket`.
    pub basket: serde_json::Value,
    /// Labels of the electricity regions the seed has history for.
    #[serde(default)]
    pub regions: Vec<SeedRegion>,
    /// Bundled history and curated steps, by series name.
    pub series: BTreeMap<String, SeedSeries>,
}

impl Seed {
    /// The seed compiled into this binary.
    pub fn embedded() -> Result<Self> {
        Self::parse(EMBEDDED)
    }

    /// Reads and checks a seed document.
    pub fn parse(text: &str) -> Result<Self> {
        let seed: Seed = serde_json::from_str(text)?;
        if !seed.basket["entries"].is_array() || !seed.basket["weightCap"].is_object() {
            return Err(Report::msg(
                "oracle seed: basket lacks entries or weightCap",
            ));
        }
        for (name, series) in &seed.series {
            let ordered = series.points.windows(2).all(|pair| pair[0].0 < pair[1].0);
            let finite = series.points.iter().all(|(_, value)| value.is_finite());
            if !is_series_name(name) || !ordered || !finite || series.points.is_empty() {
                return Err(Report::msg(format!(
                    "oracle seed: series {name} is invalid"
                )));
            }
        }
        Ok(seed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file compiled into the relay must be one the relay accepts, and must carry what a
    /// response cannot do without: the basket, and an efficiency series for a basket algorithm.
    #[test]
    fn the_embedded_seed_is_valid_and_defines_the_basket() {
        let seed = Seed::embedded().expect("embedded seed parses");
        let entries = seed.basket["entries"].as_array().expect("entries");
        assert!(entries.iter().any(|entry| entry["id"] == "bitcoin"));
        for entry in entries {
            for chain in entry["chains"].as_array().expect("chains") {
                assert!(chain["hashesPerDifficulty"].as_f64().unwrap_or(0.0) > 0.0);
                assert!(chain["chain"].is_string());
            }
        }
        assert!(seed.series.contains_key("efficiency/sha256"));
    }

    #[test]
    fn a_seed_with_unordered_points_or_a_foreign_name_is_refused() {
        let ok = r#"{"basket":{"weightCap":{"entry":"bitcoin","max":0.6},"entries":[]},
            "series":{"price/btc-mainnet":{"unit":"USD","source":"s","asOf":1,"points":[[1,2.0],[2,3.0]]}}}"#;
        assert!(Seed::parse(ok).is_ok());
        assert!(Seed::parse(&ok.replace("[2,3.0]", "[1,3.0]")).is_err());
        assert!(Seed::parse(&ok.replace("price/btc-mainnet", "supply/btc-mainnet")).is_err());
    }
}
