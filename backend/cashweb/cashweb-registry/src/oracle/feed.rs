//! Builds the answers of `GET /oracle/v1/feed` from the store and the seed.
//!
//! One series is read through [`Feed::points`]: bundled points up to the first collected point,
//! collected points from there on. `electricity/aggregate` is not stored: it is derived from the
//! regions' daily series when read (see [`Feed::aggregate`]), so it can never disagree with them.
//!
//! The latest answer is built after each collector round and kept in memory; serving it reads
//! nothing.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, RwLock},
};

use bitcoinsuite_error::Result;
use sha2::{Digest, Sha256};

use super::{
    seed::{is_series_name, Seed},
    store::OracleStore,
    Plan,
};

const DAY_S: u64 = 86_400;
/// The series AVU_spot is computed from.
pub const ELECTRICITY_AGGREGATE: &str = "electricity/aggregate";
/// Most points one series carries in a range answer, not counting what leads up to `since`.
pub const MAX_RANGE_POINTS: u64 = 1000;
/// A series whose newest collected point is older than this many intervals is stale.
const STALE_AFTER_INTERVALS: u64 = 3;

/// A built answer and its validator.
#[derive(Debug)]
pub struct Answer {
    /// The JSON body.
    pub body: Vec<u8>,
    /// Quoted entity tag of the body.
    pub etag: String,
}

impl Answer {
    fn new(json: &serde_json::Value) -> Self {
        let body = serde_json::to_vec(json).expect("a JSON value serialises");
        let etag = format!("\"{}\"", hex::encode(&Sha256::digest(&body)[..12]));
        Answer { body, etag }
    }
}

/// Why a range request is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeError {
    /// `since` is after `until`, or `step` is zero.
    Invalid,
    /// The range holds more than [`MAX_RANGE_POINTS`] steps; this is the smallest step allowed.
    StepTooSmall(u64),
}

/// Reads store and seed; owns the cached latest answer.
pub struct Feed {
    plan: Plan,
    store: OracleStore,
    seed: Seed,
    latest: RwLock<Arc<Answer>>,
}

impl std::fmt::Debug for Feed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Feed {{ .. }}")
    }
}

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// At most one point per `step` seconds: the last point of each step.
fn thin(points: Vec<(u64, f64)>, step: u64) -> Vec<(u64, f64)> {
    let mut thinned: Vec<(u64, f64)> = Vec::new();
    for point in points {
        match thinned.last_mut() {
            Some(last) if last.0 / step == point.0 / step => *last = point,
            _ => thinned.push(point),
        }
    }
    thinned
}

impl Feed {
    /// A feed over `store` and `seed`, with the latest answer built from what they hold now.
    pub fn new(plan: Plan, store: OracleStore, seed: Seed) -> Self {
        let feed = Feed {
            plan,
            store,
            seed,
            latest: RwLock::new(Arc::new(Answer::new(&serde_json::Value::Null))),
        };
        feed.rebuild_latest(now_s());
        feed
    }

    /// The bundled data.
    pub fn seed(&self) -> &Seed {
        &self.seed
    }

    /// The collector's store.
    pub fn store(&self) -> &OracleStore {
        &self.store
    }

    /// Regions: configured rows, then regions only the seed knows (which count in the aggregate).
    /// `(id, label, attribution, counts in the aggregate)`.
    fn regions(&self) -> Vec<(String, String, String, bool)> {
        let mut regions = self
            .plan
            .conf
            .electricity
            .iter()
            .map(|row| {
                (
                    row.region.clone(),
                    row.label.clone(),
                    row.attribution.clone(),
                    row.in_aggregate,
                )
            })
            .collect::<Vec<_>>();
        for region in &self.seed.regions {
            if !regions.iter().any(|(id, ..)| *id == region.id) {
                regions.push((
                    region.id.clone(),
                    region.label.clone(),
                    region.attribution.clone(),
                    true,
                ));
            }
        }
        regions
    }

    /// `electricity/aggregate` over all time, and per region the latest day it counted in.
    ///
    /// The point for day `d` is the equally weighted mean, over the regions, of each region's
    /// mean daily price in the `electricity_window_days` days ending at `d`. A region with
    /// fewer than `electricity_min_days` prices in that window is left out of that day; a day
    /// on which no region qualifies has no point. Only days some region has a price for are
    /// considered: the series is never carried past the newest data.
    fn aggregate(&self) -> Result<(Vec<(u64, f64)>, BTreeMap<String, u64>)> {
        let window = self.plan.conf.electricity_window_days;
        let min_days = self.plan.conf.electricity_min_days as usize;
        let mut regions = Vec::new();
        for (region, _, _, counts) in self.regions() {
            if counts {
                let daily = self
                    .stored(&format!("electricity/{region}"), 0, u64::MAX)?
                    .into_iter()
                    .map(|(time, price)| (time / DAY_S, price))
                    .collect::<Vec<_>>();
                regions.push((region, daily));
            }
        }
        // One candidate day per day any counting region has a price for, as the client's
        // `windowedElectricityAggregate` (packages/price-feeds/src/electricity-aggregate.ts).
        let days = regions
            .iter()
            .flat_map(|(_, daily)| daily.iter().map(|(day, _)| *day))
            .collect::<BTreeSet<_>>();
        let mut points = Vec::new();
        let mut last_contributed = BTreeMap::new();
        for day in days {
            let mut sum = 0.0;
            let mut qualifying = 0u32;
            for (region, daily) in &regions {
                // The region's prices of the days (day - window, day].
                let end = daily.partition_point(|(at, _)| *at <= day);
                let start = daily.partition_point(|(at, _)| *at + window <= day);
                let in_window = &daily[start..end];
                if in_window.is_empty() || in_window.len() < min_days {
                    continue;
                }
                sum +=
                    in_window.iter().map(|(_, price)| price).sum::<f64>() / in_window.len() as f64;
                qualifying += 1;
                last_contributed.insert(region.clone(), day * DAY_S);
            }
            if qualifying > 0 {
                points.push((day * DAY_S, sum / f64::from(qualifying)));
            }
        }
        Ok((points, last_contributed))
    }

    /// Seed points before the first collected point, collected points from it on.
    fn stored(&self, name: &str, from: u64, to: u64) -> Result<Vec<(u64, f64)>> {
        let first_collected = self.store.first(name)?.map_or(u64::MAX, |(time, _)| time);
        let mut points = self
            .seed
            .series
            .get(name)
            .map(|series| {
                series
                    .points
                    .iter()
                    .copied()
                    .filter(|(time, _)| (from..=to).contains(time) && *time < first_collected)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        points.extend(self.store.points(name, from, to)?);
        Ok(points)
    }

    /// The points of a served series with `from <= time <= to`, oldest first.
    pub fn points(&self, name: &str, from: u64, to: u64) -> Result<Vec<(u64, f64)>> {
        if name == ELECTRICITY_AGGREGATE {
            let (mut points, _) = self.aggregate()?;
            points.retain(|(time, _)| (from..=to).contains(time));
            Ok(points)
        } else {
            self.stored(name, from, to)
        }
    }

    /// The latest point of a served series at or before `time`.
    pub fn floor(&self, name: &str, time: u64) -> Result<Option<(u64, f64)>> {
        if name == ELECTRICITY_AGGREGATE {
            return Ok(self.points(name, 0, time)?.pop());
        }
        if let Some(point) = self.store.floor(name, time)? {
            return Ok(Some(point));
        }
        Ok(self.seed.series.get(name).and_then(|series| {
            let index = series.points.partition_point(|(at, _)| *at <= time);
            index.checked_sub(1).map(|index| series.points[index])
        }))
    }

    /// Every series the relay can serve.
    pub fn names(&self) -> Result<BTreeSet<String>> {
        let mut names = self
            .store
            .names()?
            .into_iter()
            .filter(|name| is_series_name(name))
            .chain(self.seed.series.keys().cloned())
            .collect::<BTreeSet<_>>();
        if names.iter().any(|name| name.starts_with("electricity/")) {
            names.insert(ELECTRICITY_AGGREGATE.to_owned());
        }
        Ok(names)
    }

    /// `(unit, source, interval of the collector round that refreshes it, promised live)`.
    fn describe(&self, name: &str) -> (&'static str, String, u64, bool) {
        let conf = &self.plan.conf;
        let (kind, id) = name.split_once('/').unwrap_or((name, ""));
        let stats = conf.chain_stats.as_ref();
        let seed_source = || {
            self.seed
                .series
                .get(name)
                .map(|series| series.source.clone())
        };
        match kind {
            "price" => {
                let providers = self
                    .plan
                    .price_providers()
                    .filter(|provider| provider.symbols.contains_key(id))
                    .map(|provider| provider.id.as_str())
                    .collect::<Vec<_>>();
                let source = match providers.as_slice() {
                    [] => seed_source().unwrap_or_default(),
                    [only] => format!("relay: {only} only (single source)"),
                    many => format!("relay: smoothed over {}", many.join(", ")),
                };
                ("USD", source, conf.price_interval_s, !providers.is_empty())
            }
            "marketCap" | "difficulty" | "blockReward" => {
                let unit = match kind {
                    "marketCap" => "USD",
                    "difficulty" => "difficulty",
                    _ => "coins per block to the miner",
                };
                let collected = stats.filter(|stats| stats.chains.contains_key(id));
                let source = match (collected, kind) {
                    (Some(stats), "marketCap") => {
                        format!("price x coins in existence ({})", stats.id)
                    }
                    (Some(stats), _) => stats.id.clone(),
                    (None, _) => seed_source().unwrap_or_default(),
                };
                // Only difficulty is certain to be collected for a configured chain.
                let promised = collected.is_some() && kind == "difficulty";
                (unit, source, conf.stats_interval_s, promised)
            }
            "electricity" if name == ELECTRICITY_AGGREGATE => {
                let regions = self
                    .regions()
                    .into_iter()
                    .filter(|(_, _, _, counts)| *counts)
                    .map(|(id, ..)| id)
                    .collect::<Vec<_>>();
                (
                    "USD/kWh",
                    format!(
                        "mean of each region's {}-day mean wholesale price: {}",
                        conf.electricity_window_days,
                        regions.join(", ")
                    ),
                    conf.electricity_interval_s,
                    !conf.electricity.is_empty(),
                )
            }
            "electricity" => {
                let row = conf.electricity.iter().find(|row| row.region == id);
                let source = row
                    .map(|row| row.attribution.clone())
                    .or_else(seed_source)
                    .unwrap_or_default();
                (
                    "USD/kWh",
                    source,
                    conf.electricity_interval_s,
                    row.is_some(),
                )
            }
            _ => ("hashes/kWh", seed_source().unwrap_or_default(), 0, false),
        }
    }

    /// One series of an answer: metadata and `points`. `None` when there are no points.
    fn series(
        &self,
        name: &str,
        points: Vec<(u64, f64)>,
        now: u64,
    ) -> Result<Option<serde_json::Value>> {
        if points.is_empty() {
            return Ok(None);
        }
        let (unit, source, interval, promised) = self.describe(name);
        let newest_collected = if name == ELECTRICITY_AGGREGATE {
            self.floor(name, u64::MAX)?
        } else {
            self.store.floor(name, u64::MAX)?
        }
        .map(|(time, _)| time);
        let seed_as_of = self.seed.series.get(name).map(|series| series.as_of);
        let stale = match newest_collected {
            Some(time) => now.saturating_sub(time) > STALE_AFTER_INTERVALS * interval,
            None => promised,
        };
        let mut entry = serde_json::json!({
            "unit": unit,
            "source": source,
            "asOf": newest_collected.or(seed_as_of).unwrap_or(0),
            "stale": stale,
            "points": points,
        });
        // Bundled points before this time are estimates; the seed says so and the feed repeats it.
        let estimated = self
            .seed
            .series
            .get(name)
            .and_then(|series| series.estimated_before);
        if let Some(estimated_before) = estimated {
            entry["estimatedBefore"] = estimated_before.into();
        }
        Ok(Some(entry))
    }

    fn envelope(
        &self,
        now: u64,
        series: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let (_, last_contributed) = self.aggregate()?;
        let regions = self
            .regions()
            .into_iter()
            .map(|(id, label, attribution, _)| {
                let mut region =
                    serde_json::json!({ "id": id, "label": label, "attribution": attribution });
                if let Some(day) = last_contributed.get(&id) {
                    region["lastContributed"] = (*day).into();
                }
                region
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({
            "version": 1,
            "generatedAt": now,
            "basket": self.seed.basket,
            "electricity": {
                "windowDays": self.plan.conf.electricity_window_days,
                "minDays": self.plan.conf.electricity_min_days,
                "regions": regions,
            },
            "series": series,
        }))
    }

    /// The latest answer: exactly one point per series, its latest. (A day-ahead electricity
    /// price is stamped at the start of its day, so the latest point may be today's.)
    fn build_latest(&self, now: u64) -> Result<serde_json::Value> {
        let mut series = serde_json::Map::new();
        for name in self.names()? {
            let horizon = if name.starts_with("electricity/") {
                now + DAY_S
            } else {
                now
            };
            let points = self.floor(&name, horizon)?.into_iter().collect();
            if let Some(entry) = self.series(&name, points, now)? {
                series.insert(name, entry);
            }
        }
        self.envelope(now, series)
    }

    /// Rebuilds the cached latest answer. Called after each collector round. On a store error
    /// the previous answer stays.
    pub fn rebuild_latest(&self, now: u64) {
        match self.build_latest(now) {
            Ok(json) => {
                let answer = Arc::new(Answer::new(&json));
                *self
                    .latest
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = answer;
            }
            Err(error) => tracing::error!(%error, "oracle: could not rebuild the latest feed"),
        }
    }

    /// The cached latest answer.
    pub fn latest(&self) -> Arc<Answer> {
        Arc::clone(
            &self
                .latest
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// A range answer: per series the floor point at `since`, then the points in
    /// `(since, until]` thinned to the last of each `step` seconds.
    pub fn range(
        &self,
        since: u64,
        until: u64,
        step: u64,
        now: u64,
    ) -> std::result::Result<Result<Answer>, RangeError> {
        if step == 0 || since > until {
            return Err(RangeError::Invalid);
        }
        let smallest = (until - since).div_ceil(MAX_RANGE_POINTS).max(1);
        if step < smallest {
            return Err(RangeError::StepTooSmall(smallest));
        }
        Ok((|| {
            let mut series = serde_json::Map::new();
            for name in self.names()? {
                let mut points: Vec<_> = self.floor(&name, since)?.into_iter().collect();
                if since < until {
                    points.extend(thin(self.points(&name, since + 1, until)?, step));
                }
                if let Some(entry) = self.series(&name, points, now)? {
                    series.insert(name, entry);
                }
            }
            Ok(Answer::new(&self.envelope(now, series)?))
        })())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::oracle::seed::{SeedRegion, SeedSeries};

    pub(crate) const CONF: &str = r#"
non_network_ids = ["ltc-mainnet"]

[[price_providers]]
id = "a"
adapter = "kraken"
api_url = "http://127.0.0.1:1/a"
symbols = { btc-mainnet = "BTC", ltc-mainnet = "LTC" }

[[price_providers]]
id = "b"
adapter = "kraken"
api_url = "http://127.0.0.1:1/b"
symbols = { btc-mainnet = "BTC" }

[chain_stats]
id = "stats"
api_url = "http://127.0.0.1:1/stats"
[chain_stats.chains.btc-mainnet]
name = "bitcoin"
decimals = 8

[[electricity]]
region = "de-lu"
label = "Germany-Luxembourg day-ahead"
attribution = "Bundesnetzagentur | SMARD.de, CC BY 4.0"
adapter = "energy-charts"
api_url = "http://127.0.0.1:1/price"
zone = "DE-LU"
fx_url = "http://127.0.0.1:1/fx"
"#;

    pub(crate) fn plan(conf: &str) -> Plan {
        let conf: cashweb_config::OracleConf = toml::from_str(conf).expect("test conf parses");
        conf.validate().expect("test conf is valid");
        Plan::new(conf, |_| None)
    }

    fn seed() -> Seed {
        let series = |source: &str, points: &[(u64, f64)]| SeedSeries {
            unit: "u".to_owned(),
            source: source.to_owned(),
            as_of: 5_000_000,
            estimated_before: (source == "curated").then_some(2 * DAY_S),
            points: points.to_vec(),
        };
        Seed {
            basket: serde_json::json!({"weightCap": {"entry": "bitcoin", "max": 0.6}, "entries": []}),
            miner_share: [("xec-mainnet".to_owned(), vec![(0, 0.92), (DAY_S, 0.58)])].into(),
            regions: vec![SeedRegion {
                id: "us-pjm-west".to_owned(),
                label: "PJM West".to_owned(),
                attribution: "ICE via EIA".to_owned(),
            }],
            series: [
                (
                    "price/btc-mainnet".to_owned(),
                    series(
                        "monthly history",
                        &[
                            (10 * DAY_S, 100.0),
                            (40 * DAY_S, 200.0),
                            (70 * DAY_S, 999.0),
                        ],
                    ),
                ),
                (
                    "efficiency/sha256".to_owned(),
                    series("curated", &[(DAY_S, 5e16)]),
                ),
                (
                    "electricity/us-pjm-west".to_owned(),
                    series("ICE via EIA", &[(58 * DAY_S, 0.04), (59 * DAY_S, 0.06)]),
                ),
                (
                    "electricity/de-lu".to_owned(),
                    series("bundled", &[(58 * DAY_S, 0.10)]),
                ),
            ]
            .into(),
        }
    }

    pub(crate) fn feed(dir: &tempdir::TempDir, conf: &str) -> Feed {
        let store = OracleStore::open(dir.path().join("oracle")).expect("store opens");
        Feed::new(plan(conf), store, seed())
    }

    fn point(name: &str, time: u64, value: f64) -> (String, u64, f64) {
        (name.to_owned(), time, value)
    }

    fn json(answer: &Answer) -> serde_json::Value {
        serde_json::from_slice(&answer.body).expect("answer is JSON")
    }

    /// Bundled history is served until the relay has collected something; from the first
    /// collected point on, collected data is the series, even where the bundle has points.
    #[test]
    fn collected_points_take_over_from_bundled_history() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let feed = feed(&dir, CONF);
        let name = "price/btc-mainnet";
        assert_eq!(feed.points(name, 0, u64::MAX)?.len(), 3);
        feed.store().write(
            &[],
            &[
                point(name, 60 * DAY_S, 300.0),
                point(name, 60 * DAY_S + 600, 301.0),
            ],
        )?;
        assert_eq!(
            feed.points(name, 0, u64::MAX)?,
            vec![
                (10 * DAY_S, 100.0),
                (40 * DAY_S, 200.0),
                (60 * DAY_S, 300.0),
                (60 * DAY_S + 600, 301.0),
            ],
            "the bundled point at day 70 lies after collection began and is not served"
        );
        assert_eq!(feed.floor(name, 50 * DAY_S)?, Some((40 * DAY_S, 200.0)));
        assert_eq!(
            feed.floor(name, 80 * DAY_S)?,
            Some((60 * DAY_S + 600, 301.0))
        );
        assert_eq!(
            feed.floor(name, DAY_S)?,
            None,
            "nothing is extended backwards"
        );
        Ok(())
    }

    /// A three-day window needing two days, so the arithmetic fits in a comment.
    fn short_window() -> String {
        format!("electricity_window_days = 3\nelectricity_min_days = 2\n{CONF}")
    }

    /// The aggregate point of a day is the mean, over regions, of each region's mean price in
    /// the window ending that day; a region with too few days in the window is left out, a day
    /// nobody qualifies has no point, and each region reports the last day it counted in.
    #[test]
    fn the_aggregate_is_the_mean_of_each_regions_window_mean() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let feed = feed(&dir, &short_window());
        // de-lu: day 58 (bundled) 0.10, then collected; us-pjm-west (bundled): 58 0.04, 59 0.06.
        feed.store().write(
            &[],
            &[
                point("electricity/de-lu", 59 * DAY_S, -0.02),
                point("electricity/de-lu", 60 * DAY_S, 0.2),
                point("electricity/de-lu", 61 * DAY_S, 0.3),
            ],
        )?;
        let aggregate = feed.points(ELECTRICITY_AGGREGATE, 0, u64::MAX)?;
        let days = aggregate
            .iter()
            .map(|(time, _)| time / DAY_S)
            .collect::<Vec<_>>();
        assert_eq!(days, [59, 60, 61], "day 58: one day each, nobody qualifies");
        let close = |index: usize, expected: f64| (aggregate[index].1 - expected).abs() < 1e-12;
        // 59: de (0.10 - 0.02) / 2 = 0.04, us (0.04 + 0.06) / 2 = 0.05. Negative days are kept.
        assert!(close(0, 0.045), "{aggregate:?}");
        // 60: de (0.10 - 0.02 + 0.2) / 3, us still 0.05 from its two days in the window.
        assert!(close(1, (0.28 / 3.0 + 0.05) / 2.0), "{aggregate:?}");
        // 61: us has one day left in the window and is left out; de (-0.02 + 0.2 + 0.3) / 3.
        assert!(close(2, 0.16), "{aggregate:?}");
        assert_eq!(
            feed.floor(ELECTRICITY_AGGREGATE, 61 * DAY_S - 1)?,
            Some(aggregate[1])
        );

        let answer = json(
            &feed
                .range(0, 100 * DAY_S, DAY_S, 100 * DAY_S)
                .expect("valid")?,
        );
        assert_eq!(
            answer["electricity"],
            serde_json::json!({
                "windowDays": 3,
                "minDays": 2,
                "regions": [
                    { "id": "de-lu", "label": "Germany-Luxembourg day-ahead",
                      "attribution": "Bundesnetzagentur | SMARD.de, CC BY 4.0",
                      "lastContributed": 61 * DAY_S },
                    { "id": "us-pjm-west", "label": "PJM West", "attribution": "ICE via EIA",
                      "lastContributed": 60 * DAY_S },
                ],
            })
        );

        // A region configured out of the aggregate is still served, and does not count.
        let out =
            short_window().replace("zone = \"DE-LU\"", "zone = \"DE-LU\"\nin_aggregate = false");
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let only_us = super::tests::feed(&dir, &out);
        let aggregate = only_us.points(ELECTRICITY_AGGREGATE, 0, u64::MAX)?;
        assert_eq!(aggregate.len(), 1);
        assert_eq!(aggregate[0].0, 59 * DAY_S);
        assert!((aggregate[0].1 - 0.05).abs() < 1e-12);
        assert_eq!(only_us.points("electricity/de-lu", 0, u64::MAX)?.len(), 1);
        Ok(())
    }

    /// What the app polls: exactly one point per series, and metadata that tells a live series
    /// from a bundled one and a fresh one from a stale one.
    #[test]
    fn the_latest_answer_has_exactly_one_point_per_series() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let feed = feed(&dir, &short_window());
        let now = 60 * DAY_S + 1200;
        feed.store().write(
            &[],
            &[
                point("price/btc-mainnet", now - 1200, 300.0),
                point("price/btc-mainnet", now - 600, 301.0),
                point("difficulty/btc-mainnet", now - 5 * 3600, 7.0),
                point("electricity/de-lu", 59 * DAY_S, 0.1),
                point("electricity/de-lu", 60 * DAY_S, 0.2),
            ],
        )?;
        feed.rebuild_latest(now);
        let latest = json(&feed.latest());
        assert_eq!(latest["version"], 1);
        assert_eq!(latest["generatedAt"], now);
        let series = latest["series"].as_object().expect("series");
        for (name, entry) in series {
            assert_eq!(entry["points"].as_array().map(Vec::len), Some(1), "{name}");
        }
        let price = &series["price/btc-mainnet"];
        assert_eq!(price["points"], serde_json::json!([[now - 600, 301.0]]));
        assert_eq!(price["asOf"], now - 600);
        assert_eq!(price["stale"], false);
        assert_eq!(price["source"], "relay: smoothed over a, b");
        // Five hours without chain statistics on an hourly round: stale, and it says so.
        assert_eq!(series["difficulty/btc-mainnet"]["stale"], true);
        // Curated steps are bundled: the bundle's date, never stale, estimates marked.
        let efficiency = &series["efficiency/sha256"];
        assert_eq!(efficiency["points"], serde_json::json!([[DAY_S, 5e16]]));
        assert_eq!(efficiency["asOf"], 5_000_000);
        assert_eq!(efficiency["stale"], false);
        assert_eq!(efficiency["estimatedBefore"], 2 * DAY_S);
        assert!(price.get("estimatedBefore").is_none());
        // Electricity: today's day-ahead point, and today's aggregate:
        // de (0.10 + 0.1 + 0.2) / 3 and us (0.04 + 0.06) / 2, averaged.
        assert_eq!(
            series["electricity/de-lu"]["points"],
            serde_json::json!([[60 * DAY_S, 0.2]])
        );
        let aggregate = &series[ELECTRICITY_AGGREGATE]["points"][0];
        assert_eq!(aggregate[0], 60 * DAY_S);
        assert!((aggregate[1].as_f64().unwrap() - (0.4 / 3.0 + 0.05) / 2.0).abs() < 1e-12);
        assert_eq!(series[ELECTRICITY_AGGREGATE]["stale"], false);
        // A region with bundled history only and no collector row.
        assert_eq!(series["electricity/us-pjm-west"]["asOf"], 5_000_000);
        // Nothing the relay has no point for is listed.
        assert!(series.get("price/ltc-mainnet").is_none());
        // The answer changes only when its content does.
        let etag = feed.latest().etag.clone();
        feed.rebuild_latest(now);
        assert_eq!(feed.latest().etag, etag);
        feed.rebuild_latest(now + 1);
        assert_ne!(feed.latest().etag, etag);
        Ok(())
    }

    /// A chart's request: the floor point at `since`, then the last point of each step, and a
    /// refusal instead of an unbounded answer.
    #[test]
    fn a_range_is_led_by_the_floor_point_thinned_by_step_and_bounded() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let feed = feed(&dir, CONF);
        let start = 60 * DAY_S;
        let points = (0..36)
            .map(|i| point("price/btc-mainnet", start + i * 600, 300.0 + i as f64))
            .collect::<Vec<_>>();
        feed.store().write(&[], &points)?;
        feed.store()
            .write(&[], &[point("electricity/de-lu", 59 * DAY_S, 0.1)])?;
        let since = start + 3000;
        let until = start + 6 * 3600;
        let answer = json(&feed.range(since, until, 3600, until).expect("valid")?);
        let price = answer["series"]["price/btc-mainnet"]["points"]
            .as_array()
            .expect("points")
            .clone();
        // Floor at `since` (the point at +3000), then the last point of each hour.
        assert_eq!(price[0], serde_json::json!([start + 3000, 305.0]));
        assert_eq!(price[1], serde_json::json!([start + 2 * 3600 - 600, 311.0]));
        assert_eq!(price[5], serde_json::json!([start + 6 * 3600 - 600, 335.0]));
        assert_eq!(price.len(), 1 + 5);
        // Electricity is led by its floor point like any other series.
        assert_eq!(
            answer["series"]["electricity/de-lu"]["points"],
            serde_json::json!([[59 * DAY_S, 0.1]])
        );
        // An instant: just what evaluates the series there.
        let instant = json(&feed.range(since, since, 1, until).expect("valid")?);
        assert_eq!(
            instant["series"]["price/btc-mainnet"]["points"],
            serde_json::json!([[start + 3000, 305.0]])
        );
        // Bounds.
        assert_eq!(
            feed.range(10, 5, 60, until).err(),
            Some(RangeError::Invalid)
        );
        assert_eq!(feed.range(0, 10, 0, until).err(), Some(RangeError::Invalid));
        assert_eq!(
            feed.range(0, 365 * DAY_S, 600, until).err(),
            Some(RangeError::StepTooSmall(365 * DAY_S / 1000))
        );
        assert!(feed.range(0, 365 * DAY_S, DAY_S, until).is_ok());
        Ok(())
    }

    /// The bundled regional prices give the figure the client's reviewer computed by hand for
    /// 2026-10-09: Germany's 30-day mean 0.178915 and PJM West's 0.078556 (its last price is
    /// from 30 September, still ten or more days inside the window), equally weighted.
    #[test]
    fn the_bundled_regions_give_the_reviewed_aggregate_for_2026_10_09() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-feed")?;
        let store = OracleStore::open(dir.path().join("oracle"))?;
        let feed = Feed::new(plan(""), store, Seed::embedded()?);
        let day = 1_791_504_000;
        let (time, value) = feed.floor(ELECTRICITY_AGGREGATE, day)?.expect("a point");
        assert_eq!(time, day);
        assert!((value - 0.128_736).abs() < 1e-6, "{value}");
        let (_, last_contributed) = feed.aggregate()?;
        assert_eq!(last_contributed["de-lu"], day);
        assert_eq!(last_contributed["us-pjm-west"], day);
        Ok(())
    }
}
