//! The collector: a task of its own that asks providers on a schedule and is the only writer of
//! the oracle store. Nothing else in the relay waits for it, and no provider failure leaves it:
//! a provider that fails is skipped for the round and left alone for a while.
//!
//! Requests per round: a price round asks two providers chosen at random, each once, for every
//! asset it lists; a further provider is asked only for the assets whose two answers disagree,
//! jump away from the smoothed value, or start a series, or that the two drawn do not list. A statistics round is one request. An
//! electricity round is one request per collected region plus one for the euro reference rates.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use bitcoinsuite_error::Result;
use cashweb_config::{OracleElectricityAdapter, OraclePriceProviderConf};
use rand::{seq::SliceRandom, Rng, SeedableRng};

use super::{
    feed::Feed,
    providers::{self, UpstreamRequest},
    sampling::{judge, smooth, Rules, Verdict},
    store::RawSample,
    Plan,
};

const DAY_S: u64 = 86_400;
/// A failed provider is left alone this long, doubling with each further failure.
const BACKOFF_BASE_S: u64 = 600;
const BACKOFF_MAX_S: u64 = 6 * 3600;
/// No provider answer the relay reads is larger than a few hundred kilobytes.
const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;
const USER_AGENT: &str = concat!("frank-relay-oracle/", env!("CARGO_PKG_VERSION"));

/// Why a provider gave nothing. Deliberately carries no URL and no upstream text: a URL may
/// hold a key, and an upstream body is not ours to log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpstreamError {
    /// A status other than 2xx.
    Status(u16),
    /// No complete answer within the timeout.
    Timeout,
    /// No connection.
    Unreachable,
    /// The answer exceeded the size the relay reads.
    TooLarge,
    /// The answer was not what the adapter expects.
    Unreadable,
}

/// The one way the collector reaches a provider. Tests answer in its place.
#[async_trait]
pub trait Upstream: Send + Sync {
    /// Performs `request` and returns the body of a 2xx answer.
    async fn fetch(&self, request: &UpstreamRequest)
        -> std::result::Result<Vec<u8>, UpstreamError>;
}

/// [`Upstream`] over HTTP.
#[derive(Debug)]
pub struct HttpUpstream {
    client: reqwest::Client,
}

impl HttpUpstream {
    /// A client whose every request completes or fails within `timeout`.
    pub fn new(timeout: Duration) -> Self {
        HttpUpstream {
            client: reqwest::Client::builder()
                .timeout(timeout)
                .user_agent(USER_AGENT)
                .build()
                .unwrap_or_default(),
        }
    }
}

#[async_trait]
impl Upstream for HttpUpstream {
    async fn fetch(
        &self,
        request: &UpstreamRequest,
    ) -> std::result::Result<Vec<u8>, UpstreamError> {
        let classify = |error: reqwest::Error| {
            if error.is_timeout() {
                UpstreamError::Timeout
            } else {
                UpstreamError::Unreachable
            }
        };
        let builder = match &request.body {
            Some(body) => self
                .client
                .post(&request.url)
                .header("content-type", "application/json")
                .body(body.clone()),
            None => self.client.get(&request.url),
        };
        let mut response = builder
            .header("accept", "application/json, */*;q=0.5")
            .send()
            .await
            .map_err(classify)?;
        if !response.status().is_success() {
            return Err(UpstreamError::Status(response.status().as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(classify)? {
            if body.len() + chunk.len() > MAX_ANSWER_BYTES {
                return Err(UpstreamError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

/// What one round did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoundReport {
    /// Requests sent, by provider id.
    pub requests: BTreeMap<String, u32>,
    /// Providers that failed this round, and how.
    pub failures: BTreeMap<String, UpstreamError>,
    /// Series points written.
    pub points: usize,
}

/// The collector's state between rounds.
pub struct Collector {
    plan: Plan,
    rules: Rules,
    feed: Arc<Feed>,
    upstream: Arc<dyn Upstream>,
    /// Provider id -> (consecutive failures, not to be asked before).
    backoff: HashMap<String, (u32, u64)>,
}

impl std::fmt::Debug for Collector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Collector {{ .. }}")
    }
}

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl Collector {
    /// A collector writing to `feed`'s store and asking through `upstream`.
    pub fn new(plan: Plan, feed: Arc<Feed>, upstream: Arc<dyn Upstream>) -> Self {
        Collector {
            rules: Rules::from(&plan.conf),
            plan,
            feed,
            upstream,
            backoff: HashMap::new(),
        }
    }

    fn rested(&self, provider: &str, now: u64) -> bool {
        self.backoff
            .get(provider)
            .is_none_or(|(_, until)| now >= *until)
    }

    /// Sends one request for `provider` and reads the answer with `parse`. A failure is
    /// recorded, logged without URL or body, and starts or lengthens the provider's rest.
    async fn ask<T>(
        &mut self,
        provider: &str,
        request: UpstreamRequest,
        now: u64,
        report: &mut RoundReport,
        parse: impl FnOnce(&[u8]) -> std::result::Result<T, providers::Unreadable>,
    ) -> Option<T> {
        *report.requests.entry(provider.to_owned()).or_default() += 1;
        let answer = self
            .upstream
            .fetch(&request)
            .await
            .and_then(|body| parse(&body).map_err(|_| UpstreamError::Unreadable));
        match answer {
            Ok(value) => {
                self.backoff.remove(provider);
                Some(value)
            }
            Err(error) => {
                let failures = self.backoff.get(provider).map_or(0, |(count, _)| *count) + 1;
                let rest = (BACKOFF_BASE_S << (failures - 1).min(10)).min(BACKOFF_MAX_S);
                self.backoff
                    .insert(provider.to_owned(), (failures, now + rest));
                report.failures.insert(provider.to_owned(), error);
                tracing::warn!(
                    provider,
                    error = ?error,
                    failures,
                    rest_s = rest,
                    "oracle: provider gave no usable answer; skipped this round"
                );
                None
            }
        }
    }

    /// One price round at `now`.
    pub async fn price_round(&mut self, now: u64, rng: &mut impl Rng) -> Result<RoundReport> {
        let mut report = RoundReport::default();
        let mut providers = self
            .plan
            .price_providers()
            .filter(|provider| self.rested(&provider.id, now))
            .cloned()
            .collect::<Vec<OraclePriceProviderConf>>();
        providers.shuffle(rng);
        let assets = self.plan.assets();
        let previous = assets
            .iter()
            .map(|asset| {
                Ok((
                    asset.clone(),
                    self.feed.store().floor(&format!("price/{asset}"), now)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let mut asked = HashSet::new();
        let mut failed = HashSet::new();
        // An asset's providers this round: those listing it that are neither resting nor failed.
        let listed = |asset: &str, failed: &HashSet<String>| {
            providers
                .iter()
                .filter(|provider| {
                    provider.symbols.contains_key(asset) && !failed.contains(&provider.id)
                })
                .count()
        };
        let mut answers = BTreeMap::<String, Vec<(String, f64)>>::new();
        // The two providers of the round carry every asset they list.
        let mut wanted: Option<HashSet<String>> = None;
        loop {
            let next = providers.iter().find(|provider| {
                !asked.contains(&provider.id)
                    && wanted.as_ref().is_none_or(|wanted| {
                        provider.symbols.keys().any(|asset| wanted.contains(asset))
                    })
            });
            let Some(provider) = next.cloned() else { break };
            asked.insert(provider.id.clone());
            let symbols = provider
                .symbols
                .iter()
                .filter(|(asset, _)| wanted.as_ref().is_none_or(|wanted| wanted.contains(*asset)))
                .map(|(asset, symbol)| (asset.clone(), symbol.clone()))
                .collect::<BTreeMap<_, _>>();
            let request = providers::price_request(&provider, &symbols);
            let quotes = self
                .ask(&provider.id, request, now, &mut report, |body| {
                    providers::parse_prices(provider.adapter, body, &symbols)
                })
                .await;
            if quotes.is_none() {
                failed.insert(provider.id.clone());
            }
            for (asset, price) in quotes.unwrap_or_default() {
                answers
                    .entry(asset)
                    .or_default()
                    .push((provider.id.clone(), price));
            }
            if asked.len() < 2 {
                continue;
            }
            // From the third provider on, only assets that need another answer are asked for.
            wanted = Some(
                assets
                    .iter()
                    .filter(|asset| {
                        let can_ask = providers.iter().any(|provider| {
                            !asked.contains(&provider.id) && provider.symbols.contains_key(*asset)
                        });
                        let listed = listed(asset, &failed);
                        self.verdict(asset, &answers, listed, can_ask, previous[*asset], now)
                            == Verdict::AskAnother
                    })
                    .cloned()
                    .collect(),
            );
        }
        let mut raw = Vec::new();
        let mut points = Vec::new();
        for asset in &assets {
            let name = format!("price/{asset}");
            for (provider, value) in answers.get(asset).into_iter().flatten() {
                raw.push(RawSample {
                    name: name.clone(),
                    time: now,
                    provider: provider.clone(),
                    value: *value,
                });
            }
            // Kept beside the answers so the series can be recomputed from them.
            raw.push(RawSample {
                name: format!("providers/{asset}"),
                time: now,
                provider: "relay".to_owned(),
                value: listed(asset, &failed) as f64,
            });
            let listed = listed(asset, &failed);
            if let Verdict::Sample(sample) =
                self.verdict(asset, &answers, listed, false, previous[asset], now)
            {
                points.push((name, now, smooth(previous[asset], now, sample, &self.rules)));
            }
        }
        report.points = points.len();
        self.feed.store().write(&raw, &points)?;
        Ok(report)
    }

    fn verdict(
        &self,
        asset: &str,
        answers: &BTreeMap<String, Vec<(String, f64)>>,
        listed: usize,
        can_ask: bool,
        previous: Option<(u64, f64)>,
        now: u64,
    ) -> Verdict {
        let values = answers
            .get(asset)
            .map(|answers| answers.iter().map(|(_, value)| *value).collect::<Vec<_>>())
            .unwrap_or_default();
        judge(&values, listed, can_ask, previous, now, &self.rules)
    }

    /// One chain-statistics round at `now`: difficulty, block reward (the miner's part of the
    /// subsidy the chain paid) and market capitalisation (coins in existence times the relay's
    /// current smoothed price) of every configured chain.
    pub async fn stats_round(&mut self, now: u64) -> Result<RoundReport> {
        let mut report = RoundReport::default();
        let Some(stats) = self.plan.conf.chain_stats.clone() else {
            return Ok(report);
        };
        if !self.rested(&stats.id, now) {
            return Ok(report);
        }
        let request = providers::blockchair::request(&stats.api_url);
        let Some(chains) = self
            .ask(&stats.id, request, now, &mut report, |body| {
                providers::blockchair::parse(body, &stats.chains)
            })
            .await
        else {
            return Ok(report);
        };
        let mut raw = Vec::new();
        let mut points = Vec::new();
        for (chain, answer) in chains {
            let mut record = |kind: &str, value: f64| {
                raw.push(RawSample {
                    name: format!("{kind}/{chain}"),
                    time: now,
                    provider: stats.id.clone(),
                    value,
                });
            };
            record("difficulty", answer.difficulty);
            record("supply", answer.supply);
            points.push((format!("difficulty/{chain}"), now, answer.difficulty));
            if let Some(subsidy) = answer.subsidy {
                record("subsidy", subsidy);
                // The miner's part comes from the bundled dated steps, the one source of it.
                let share = self.feed.seed().miner_share(&chain, now);
                points.push((format!("blockReward/{chain}"), now, subsidy * share));
            }
            let price = self
                .feed
                .store()
                .floor(&format!("price/{chain}"), now)?
                .filter(|(time, _)| now - time <= self.rules.long_gap_s);
            if let Some((_, price)) = price {
                points.push((format!("marketCap/{chain}"), now, answer.supply * price));
            }
        }
        report.points = points.len();
        self.feed.store().write(&raw, &points)?;
        Ok(report)
    }

    /// One electricity round at `now`: each collected region's daily means, in US dollars per
    /// kWh, stamped at the start of the UTC day.
    pub async fn electricity_round(&mut self, now: u64) -> Result<RoundReport> {
        let mut report = RoundReport::default();
        let today = now - now % DAY_S;
        let mut euro_rates: Option<BTreeMap<u64, f64>> = None;
        let mut raw = Vec::new();
        let mut points = Vec::new();
        for row in self.plan.conf.electricity.clone() {
            if !self.plan.collects(&row) || !self.rested(&row.region, now) {
                continue;
            }
            let name = format!("electricity/{}", row.region);
            match row.adapter {
                OracleElectricityAdapter::EnergyCharts => {
                    let (Some(zone), Some(fx_url)) = (&row.zone, &row.fx_url) else {
                        continue;
                    };
                    // From the day after the newest collected one, but always the last two days
                    // again (a day is only kept once complete), and never more than the window.
                    let window_start =
                        today.saturating_sub(self.plan.conf.electricity_window_days * DAY_S);
                    let newest = self.feed.store().floor(&name, u64::MAX)?;
                    let first_day = newest
                        .map_or(window_start, |(day, _)| day + DAY_S)
                        .min(today.saturating_sub(2 * DAY_S))
                        .max(window_start);
                    let request = providers::energy_charts::request(
                        &row.api_url,
                        zone,
                        first_day,
                        today + DAY_S,
                    );
                    let Some(days) = self
                        .ask(
                            &row.region,
                            request,
                            now,
                            &mut report,
                            providers::energy_charts::parse,
                        )
                        .await
                    else {
                        continue;
                    };
                    if euro_rates.is_none() && self.rested("ecb", now) {
                        euro_rates = self
                            .ask(
                                "ecb",
                                providers::ecb::request(fx_url),
                                now,
                                &mut report,
                                providers::ecb::parse,
                            )
                            .await;
                        for (day, rate) in euro_rates.iter().flatten() {
                            raw.push(RawSample {
                                name: "fx/eur-usd".to_owned(),
                                time: *day,
                                provider: "ecb".to_owned(),
                                value: *rate,
                            });
                        }
                    }
                    for (day, eur_per_mwh) in days {
                        // The reference rate of the day, or of the last working day before it.
                        let rate = euro_rates
                            .as_ref()
                            .and_then(|rates| rates.range(..=day).next_back());
                        let Some((_, usd_per_eur)) = rate else {
                            continue;
                        };
                        raw.push(RawSample {
                            name: name.clone(),
                            time: day,
                            provider: "energy-charts".to_owned(),
                            value: eur_per_mwh,
                        });
                        points.push((name.clone(), day, eur_per_mwh * usd_per_eur / 1000.0));
                    }
                }
                OracleElectricityAdapter::Eia => {
                    let (Some(key), Some(field), Some(factor)) = (
                        self.plan.electricity_key(&row).map(str::to_owned),
                        row.value_field.clone(),
                        row.usd_per_kwh_factor
                            .as_deref()
                            .and_then(cashweb_config::parse_positive_decimal),
                    ) else {
                        continue;
                    };
                    let request = providers::eia::request(&row.api_url, &key);
                    let Some(days) = self
                        .ask(&row.region, request, now, &mut report, |body| {
                            providers::eia::parse(body, &field, factor)
                        })
                        .await
                    else {
                        continue;
                    };
                    for (day, usd_per_kwh) in days {
                        raw.push(RawSample {
                            name: name.clone(),
                            time: day,
                            provider: "eia".to_owned(),
                            value: usd_per_kwh,
                        });
                        points.push((name.clone(), day, usd_per_kwh));
                    }
                }
            }
        }
        report.points = points.len();
        self.feed.store().write(&raw, &points)?;
        Ok(report)
    }

    /// Runs every round that is due at `now`, remembers that it ran, and rebuilds the latest
    /// answer. Returns the seconds until the next round is due.
    async fn tick(&mut self, now: u64, rng: &mut impl Rng) -> u64 {
        let conf = &self.plan.conf;
        let schedule = [
            ("price", conf.price_interval_s),
            ("stats", conf.stats_interval_s),
            ("electricity", conf.electricity_interval_s),
        ];
        let mut next = u64::MAX;
        for (kind, interval) in schedule {
            let key = format!("last-round/{kind}");
            let last = self.feed.store().meta(&key).ok().flatten();
            let due = last.map_or(0, |last| last + interval);
            if now < due {
                next = next.min(due - now);
                continue;
            }
            // Whom this round asks: their rests decide when a round that got nothing is retried.
            let providers: Vec<String> = match kind {
                "price" => self.plan.price_providers().map(|p| p.id.clone()).collect(),
                "stats" => self
                    .plan
                    .conf
                    .chain_stats
                    .iter()
                    .map(|s| s.id.clone())
                    .collect(),
                _ => self
                    .plan
                    .conf
                    .electricity
                    .iter()
                    .filter(|row| self.plan.collects(row))
                    .map(|row| row.region.clone())
                    .chain(["ecb".to_owned()])
                    .collect(),
            };
            let result = match kind {
                "price" => self.price_round(now, rng).await,
                "stats" => self.stats_round(now).await,
                _ => self.electricity_round(now).await,
            };
            match result {
                Ok(report) => tracing::info!(
                    round = kind,
                    requests = ?report.requests,
                    failures = ?report.failures,
                    points = report.points,
                    "oracle: round finished"
                ),
                Err(error) => tracing::error!(round = kind, %error, "oracle: store failed"),
            }
            // While one of the round's providers is resting after a failure the round stays
            // due: it comes round again when the earliest rest ends, not a whole interval
            // later, so statistics do not lose an hour or electricity a day to a provider that
            // was down for minutes. A resting provider is not asked, so this costs no requests.
            let rest_ends = providers
                .iter()
                .filter_map(|id| self.backoff.get(id).map(|(_, until)| *until))
                .filter(|until| *until > now)
                .min();
            let next_due = rest_ends.map_or(now + interval, |end| end.min(now + interval));
            let ran_at = next_due - interval;
            next = next.min(next_due - now);
            if let Err(error) = self.feed.store().set_meta(&key, ran_at) {
                tracing::error!(%error, "oracle: store failed");
            }
            if kind == "electricity" {
                let days = self.plan.conf.full_resolution_days;
                if let Err(error) = self.feed.store().thin(now, days) {
                    tracing::error!(%error, "oracle: thinning failed");
                }
            }
            self.feed.rebuild_latest(now);
        }
        next
    }

    /// Runs until the relay stops. A round that is not yet due after a restart is not repeated.
    pub async fn run(mut self) {
        let mut rng = rand::rngs::StdRng::from_entropy();
        loop {
            let wait = self.tick(now_s(), &mut rng).await;
            tokio::time::sleep(Duration::from_secs(wait.clamp(5, 3600))).await;
        }
    }
}

/// How long after the collector task ended before it is started again.
const RESTART_PAUSE: Duration = Duration::from_secs(60);

/// Keeps a collector running: when its task ends or panics, that is logged and a new collector
/// (built by `make`) is started after `pause`. The relay itself is never affected. `runs`
/// counts the collectors started, for tests.
pub async fn supervise<F, Fut>(make: F, pause: Duration, runs: Arc<std::sync::atomic::AtomicU64>)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    loop {
        runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match tokio::spawn(make()).await {
            Ok(()) => tracing::error!("oracle: the collector stopped; starting it again"),
            Err(error) if error.is_panic() => {
                tracing::error!("oracle: the collector panicked; starting it again")
            }
            // Cancelled: the runtime is shutting down.
            Err(_) => return,
        }
        tokio::time::sleep(pause).await;
    }
}

/// [`supervise`] with the pause the relay uses.
pub async fn supervise_collector(plan: Plan, feed: Arc<Feed>, upstream: Arc<dyn Upstream>) {
    let make = move || Collector::new(plan.clone(), Arc::clone(&feed), Arc::clone(&upstream)).run();
    supervise(make, RESTART_PAUSE, Arc::default()).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rand::rngs::StdRng;

    use super::*;
    use crate::oracle::{
        feed::tests::{feed, plan, CONF},
        sampling::replay,
    };

    /// Four providers reading the same answer format (Kraken's), distinguished by path.
    const FOUR: &str = r#"
non_network_ids = ["rare", "pair"]

[[price_providers]]
id = "a"
adapter = "kraken"
api_url = "http://stub/a"
symbols = { btc-mainnet = "BTC", xec-mainnet = "XEC", rare = "RARE", pair = "PAIR" }

[[price_providers]]
id = "b"
adapter = "kraken"
api_url = "http://stub/b"
symbols = { btc-mainnet = "BTC", xec-mainnet = "XEC", pair = "PAIR" }

[[price_providers]]
id = "c"
adapter = "kraken"
api_url = "http://stub/c"
symbols = { btc-mainnet = "BTC", xec-mainnet = "XEC" }

[[price_providers]]
id = "d"
adapter = "kraken"
api_url = "http://stub/d"
symbols = { btc-mainnet = "BTC", xec-mainnet = "XEC" }
"#;

    /// Answers in place of the network: `price(provider, symbol)` decides each quote, `None`
    /// fails the whole provider. Every request is logged as `provider?symbols`.
    struct Stub<F> {
        price: F,
        log: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl<F> Upstream for Stub<F>
    where
        F: Fn(&str, &str) -> Option<f64> + Send + Sync,
    {
        async fn fetch(
            &self,
            request: &UpstreamRequest,
        ) -> std::result::Result<Vec<u8>, UpstreamError> {
            let url = url::Url::parse(&request.url).expect("request URL");
            let provider = url.path().trim_start_matches('/').to_owned();
            let pairs = url
                .query_pairs()
                .find(|(key, _)| key == "pair")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            self.log.lock().unwrap().push(format!("{provider}?{pairs}"));
            let mut result = serde_json::Map::new();
            for symbol in pairs.split(',') {
                let price = (self.price)(&provider, symbol).ok_or(UpstreamError::Status(503))?;
                result.insert(
                    symbol.to_owned(),
                    serde_json::json!({ "c": [price.to_string()] }),
                );
            }
            Ok(serde_json::json!({ "error": [], "result": result })
                .to_string()
                .into_bytes())
        }
    }

    struct Harness<F> {
        _dir: tempdir::TempDir,
        feed: Arc<Feed>,
        stub: Arc<Stub<F>>,
        collector: Collector,
        rng: StdRng,
    }

    fn harness<F>(conf: &str, seed: u64, price: F) -> Harness<F>
    where
        F: Fn(&str, &str) -> Option<f64> + Send + Sync + 'static,
    {
        let dir = tempdir::TempDir::new("oracle-collector").expect("temp dir");
        let feed = Arc::new(feed(&dir, conf));
        let stub = Arc::new(Stub {
            price,
            log: Mutex::new(Vec::new()),
        });
        let upstream: Arc<dyn Upstream> = stub.clone();
        Harness {
            _dir: dir,
            collector: Collector::new(plan(conf), Arc::clone(&feed), upstream),
            feed,
            stub,
            rng: StdRng::seed_from_u64(seed),
        }
    }

    impl<F> Harness<F> {
        fn requests(&self) -> Vec<String> {
            std::mem::take(&mut *self.stub.log.lock().unwrap())
        }
        fn price(&self, asset: &str) -> Vec<(u64, f64)> {
            self.feed
                .store()
                .points(&format!("price/{asset}"), 0, u64::MAX)
                .expect("store reads")
        }
    }

    const T0: u64 = 1_800_000_000;

    /// With a smoothed value in place and providers that agree, a round costs two requests:
    /// two providers, each asked once for everything it lists. Which two changes with the seed.
    #[tokio::test]
    async fn a_quiet_round_asks_two_random_providers_once_each() -> Result<()> {
        let mut pairs_seen = HashSet::new();
        for seed in 0..12 {
            let mut h = harness(FOUR, seed, |_, symbol| {
                Some(if symbol == "BTC" { 100.0 } else { 2.0 })
            });
            // The first round starts every series and may ask a third; the second is quiet.
            h.collector.price_round(T0, &mut h.rng).await?;
            h.requests();
            let report = h.collector.price_round(T0 + 600, &mut h.rng).await?;
            let requests = h.requests();
            let providers = requests
                .iter()
                .map(|request| request.split('?').next().unwrap().to_owned())
                .collect::<Vec<_>>();
            // `rare` is listed by `a` alone and `pair` by `a` and `b`: a round that did not
            // draw them asks them only for those, never for everything again.
            let full = requests
                .iter()
                .filter(|request| request.contains("BTC"))
                .count();
            assert_eq!(full, 2, "seed {seed}: {requests:?}");
            assert_eq!(
                report.requests.values().copied().max(),
                Some(1),
                "{requests:?}"
            );
            pairs_seen.insert(providers[..2].to_vec());
        }
        assert!(
            pairs_seen.len() > 3,
            "the pair is drawn at random: {pairs_seen:?}"
        );
        Ok(())
    }

    /// Two that disagree bring in one more provider, asked only for the asset in question, and
    /// the median of three is what is smoothed in.
    #[tokio::test]
    async fn a_disagreement_asks_one_more_provider_for_that_asset_only() -> Result<()> {
        let plain = FOUR[FOUR.find("[[price_providers]]").unwrap()..]
            .replace(", rare = \"RARE\", pair = \"PAIR\"", "")
            .replace(", pair = \"PAIR\"", "");
        let mut h = harness(&plain, 7, |provider, symbol| {
            Some(match (symbol, provider) {
                ("BTC", _) => 100.0,
                // Every provider has its own idea of XEC; any two are more than 2% apart.
                (_, "a") => 1.00,
                (_, "b") => 1.04,
                (_, "c") => 1.08,
                _ => 1.12,
            })
        });
        // Give both assets a smoothed value so only disagreement can ask a third.
        h.feed.store().write(
            &[],
            &[
                ("price/btc-mainnet".to_owned(), T0 - 600, 100.0),
                ("price/xec-mainnet".to_owned(), T0 - 600, 1.06),
            ],
        )?;
        h.collector.price_round(T0, &mut h.rng).await?;
        let requests = h.requests();
        assert_eq!(requests.len(), 3, "{requests:?}");
        assert!(requests[0].contains("BTC") && requests[1].contains("BTC"));
        assert!(requests[2].ends_with("?XEC"), "{requests:?}");
        // Three answers for XEC, two for BTC, exactly as asked.
        let store = h.feed.store();
        let xec = store.raw("price/xec-mainnet", T0, T0)?;
        assert_eq!(xec.len(), 3);
        assert_eq!(store.raw("price/btc-mainnet", T0, T0)?.len(), 2);
        let mut values = xec.iter().map(|sample| sample.value).collect::<Vec<_>>();
        values.sort_by(f64::total_cmp);
        let expected = smooth(Some((T0 - 600, 1.06)), T0, values[1], &h.collector.rules);
        assert_eq!(h.price("xec-mainnet").last(), Some(&(T0, expected)));
        Ok(())
    }

    /// An asset one provider lists is served from it; an asset exactly two list gets no sample
    /// while they are far apart.
    #[tokio::test]
    async fn single_source_assets_are_served_and_two_far_apart_are_not() -> Result<()> {
        let mut h = harness(FOUR, 3, |provider, symbol| {
            Some(match (symbol, provider) {
                ("PAIR", "a") => 10.0,
                ("PAIR", _) => 13.0,
                ("RARE", _) => 0.5,
                _ => 100.0,
            })
        });
        h.collector.price_round(T0, &mut h.rng).await?;
        assert_eq!(h.price("rare"), vec![(T0, 0.5)]);
        assert_eq!(h.price("pair"), vec![]);
        assert_eq!(
            h.feed.store().raw("price/pair", T0, T0)?.len(),
            2,
            "answers are kept"
        );
        h.feed.rebuild_latest(T0);
        let latest: serde_json::Value = serde_json::from_slice(&h.feed.latest().body)?;
        assert_eq!(
            latest["series"]["price/rare"]["source"],
            "relay: a only (single source)"
        );
        Ok(())
    }

    /// A 20% jump is applied only once a third provider's median confirms it. A provider that
    /// fails is skipped, rests, and is asked again later.
    #[tokio::test]
    async fn a_jump_waits_for_a_third_provider_and_failures_back_off() -> Result<()> {
        let level = Arc::new(Mutex::new(100.0));
        let down = Arc::new(Mutex::new(Vec::<String>::new()));
        let (level_in, down_in) = (Arc::clone(&level), Arc::clone(&down));
        let plain = FOUR[FOUR.find("[[price_providers]]").unwrap()..]
            .replace(", rare = \"RARE\", pair = \"PAIR\"", "")
            .replace(", pair = \"PAIR\"", "");
        let mut h = harness(&plain, 11, move |provider, _| {
            let up = !down_in.lock().unwrap().iter().any(|down| down == provider);
            up.then(|| *level_in.lock().unwrap())
        });
        h.collector.price_round(T0, &mut h.rng).await?;
        assert_eq!(h.price("btc-mainnet"), vec![(T0, 100.0)]);
        h.requests();

        // The market jumps 20%: the two providers of the round agree with each other, and a
        // third is asked before the jump is smoothed in.
        *level.lock().unwrap() = 120.0;
        let report = h.collector.price_round(T0 + 600, &mut h.rng).await?;
        assert_eq!(report.requests.len(), 3, "a third was asked to confirm");
        let applied = h.price("btc-mainnet")[1].1;
        let expected = smooth(Some((T0, 100.0)), T0 + 600, 120.0, &h.collector.rules);
        assert_eq!(applied, expected);
        assert!(
            applied > 100.0 && applied < 110.0,
            "smoothed in, not jumped to: {applied}"
        );

        // Another jump while three of the four providers fail: one answers, and one alone
        // cannot confirm a jump.
        *level.lock().unwrap() = 200.0;
        *down.lock().unwrap() = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let report = h.collector.price_round(T0 + 1200, &mut h.rng).await?;
        assert_eq!(report.failures.len(), 3);
        assert_eq!(report.requests.len(), 4, "everyone was tried once");
        assert_eq!(
            h.price("btc-mainnet").len(),
            2,
            "unconfirmed jump is not applied"
        );
        assert_eq!(
            h.feed
                .store()
                .raw("price/btc-mainnet", T0 + 1200, T0 + 1200)?
                .len(),
            1
        );

        // The failed providers rest: the next round does not ask them at all.
        *down.lock().unwrap() = vec![];
        h.requests();
        h.collector.price_round(T0 + 1260, &mut h.rng).await?;
        let requests = h.requests();
        assert_eq!(requests, ["d?BTC,XEC"]);
        assert_eq!(h.price("btc-mainnet").len(), 2);
        // After the rest they are asked again, and the jump is confirmed and smoothed in.
        h.collector
            .price_round(T0 + 1200 + BACKOFF_BASE_S, &mut h.rng)
            .await?;
        assert_eq!(h.requests().len(), 3);
        let series = h.price("btc-mainnet");
        assert_eq!(series.len(), 3);
        assert!(series[2].1 > series[1].1 && series[2].1 < 200.0);
        Ok(())
    }

    /// The stored smoothed series is exactly what replaying the stored answers gives, through
    /// agreement, disagreement, jumps, outages and a long gap; and it is all there after the
    /// store is closed and reopened.
    #[tokio::test]
    async fn the_smoothed_series_is_recomputable_from_the_stored_answers() -> Result<()> {
        let clock = Arc::new(Mutex::new(0u64));
        let clock_in = Arc::clone(&clock);
        let dir = tempdir::TempDir::new("oracle-replay")?;
        let stub = Arc::new(Stub {
            price: move |provider: &str, symbol: &str| {
                let round = *clock_in.lock().unwrap();
                let base = if symbol == "BTC" { 100.0 } else { 3.0 };
                // A slow drift, a per-provider offset that sometimes exceeds the tolerance,
                // a 25% jump from round 20, and provider `b` down for rounds 8..12.
                let offset = match (provider, round % 5) {
                    ("a", 3) => 0.035,
                    ("c", 1) => -0.03,
                    ("d", _) => 0.004,
                    _ => 0.0,
                };
                let jump = if round >= 20 { 1.25 } else { 1.0 };
                (!(provider == "b" && (8..12).contains(&round)))
                    .then_some(base * jump * (1.0 + 0.002 * round as f64) * (1.0 + offset))
            },
            log: Mutex::new(Vec::new()),
        });
        let mut rng = StdRng::seed_from_u64(42);
        let mut times = Vec::new();
        {
            let feed = Arc::new(feed(&dir, FOUR));
            let upstream: Arc<dyn Upstream> = stub.clone();
            let mut collector = Collector::new(plan(FOUR), Arc::clone(&feed), upstream);
            let mut now = T0;
            for round in 0..40u64 {
                *clock.lock().unwrap() = round;
                // Ten-minute rounds, with one gap longer than the long gap.
                now += if round == 30 { 8 * 3600 } else { 600 };
                times.push(now);
                collector.price_round(now, &mut rng).await?;
            }
        }
        // Reopened: a restart loses nothing.
        let feed = feed(&dir, FOUR);
        let plan = plan(FOUR);
        let rules = Rules::from(&plan.conf);
        for asset in plan.assets() {
            let name = format!("price/{asset}");
            let raw = feed.store().raw(&name, 0, u64::MAX)?;
            let listed = feed
                .store()
                .raw(&format!("providers/{asset}"), 0, u64::MAX)?;
            assert_eq!(listed.len(), times.len());
            let rounds = listed
                .iter()
                .map(|round| {
                    let answers = raw
                        .iter()
                        .filter(|sample| sample.time == round.time)
                        .map(|sample| sample.value)
                        .collect::<Vec<_>>();
                    (round.time, round.value as usize, answers)
                })
                .collect::<Vec<_>>();
            let stored = feed.store().points(&name, 0, u64::MAX)?;
            assert!(stored.len() > 20, "{asset}: {} points", stored.len());
            assert_eq!(replay(&rounds, None, &rules), stored, "{asset}");
        }
        // The jump shows in the series, the gap restarts it, and neither lost a round's answers.
        let btc = feed.store().points("price/btc-mainnet", 0, u64::MAX)?;
        assert!(btc.last().unwrap().1 > 125.0);
        Ok(())
    }

    /// Every provider unreachable (a real HTTP client against a closed port): rounds finish,
    /// nothing is stored, the feed still answers from the bundle, and the providers rest.
    #[tokio::test]
    async fn rounds_finish_and_the_feed_answers_when_nothing_is_reachable() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-unreachable")?;
        let feed = Arc::new(feed(&dir, CONF));
        let upstream: Arc<dyn Upstream> = Arc::new(HttpUpstream::new(Duration::from_secs(2)));
        let mut collector = Collector::new(plan(CONF), Arc::clone(&feed), upstream);
        let mut rng = StdRng::seed_from_u64(1);
        let wait = collector.tick(T0, &mut rng).await;
        assert_eq!(wait, 600);
        assert_eq!(feed.store().names()?, Vec::<String>::new());
        assert_eq!(feed.store().meta("last-round/price")?, Some(T0));
        for provider in ["a", "b", "stats", "de-lu"] {
            assert!(!collector.rested(provider, T0 + 1), "{provider} rests");
        }
        let latest: serde_json::Value = serde_json::from_slice(&feed.latest().body)?;
        assert_eq!(latest["generatedAt"], T0);
        assert!(latest["series"]["efficiency/sha256"]["points"].is_array());
        // Nothing is asked again before the providers have rested, however often the task
        // wakes; then the hourly and daily rounds come round again too, not an interval later.
        assert_eq!(collector.tick(T0 + 60, &mut rng).await, 540);
        assert_eq!(
            feed.store().meta("last-round/electricity")?,
            Some(T0 + 600 - 86_400)
        );
        collector.tick(T0 + 600, &mut rng).await;
        assert_eq!(
            feed.store().meta("last-round/electricity")?,
            Some(T0 + 1800 - 86_400),
            "failed twice: it rests twenty minutes, and the round is due again exactly then"
        );
        assert!(
            !collector.rested("de-lu", T0 + 601),
            "asked again, failed again, rests longer"
        );
        Ok(())
    }

    /// Answers a fixed body whatever is asked, per URL path.
    struct Canned(Vec<(&'static str, &'static [u8])>);

    #[async_trait]
    impl Upstream for Canned {
        async fn fetch(
            &self,
            request: &UpstreamRequest,
        ) -> std::result::Result<Vec<u8>, UpstreamError> {
            self.0
                .iter()
                .find(|(path, _)| request.url.contains(path))
                .map(|(_, body)| body.to_vec())
                .ok_or(UpstreamError::Status(404))
        }
    }

    const STATS_AND_POWER: &str = r#"
non_network_ids = ["xmr-mainnet"]

[chain_stats]
id = "blockchair"
api_url = "http://stub/stats"
[chain_stats.chains.btc-mainnet]
name = "bitcoin"
decimals = 8
[chain_stats.chains.xec-mainnet]
name = "ecash"
decimals = 2
[chain_stats.chains.xmr-mainnet]
name = "monero"
decimals = 12
[chain_stats.chains.doge-mainnet]
name = "dogecoin"
decimals = 8
hashrate_block_seconds = 60

[[electricity]]
region = "de-lu"
label = "Germany-Luxembourg day-ahead"
attribution = "Bundesnetzagentur | SMARD.de, CC BY 4.0"
adapter = "energy-charts"
api_url = "http://stub/price"
zone = "DE-LU"
fx_url = "http://stub/fx"
"#;

    /// Chain statistics from the recorded Blockchair answer become the three series the
    /// contract names, in its units; electricity from the recorded Energy-Charts and ECB
    /// answers becomes US dollars per kWh per complete UTC day.
    #[tokio::test]
    async fn statistics_and_electricity_rounds_store_the_contract_units() -> Result<()> {
        let dir = tempdir::TempDir::new("oracle-stats")?;
        let feed = Arc::new(feed(&dir, STATS_AND_POWER));
        let upstream: Arc<dyn Upstream> = Arc::new(Canned(vec![
            ("/stats", include_bytes!("fixtures/blockchair.json")),
            ("/price", include_bytes!("fixtures/energy_charts.json")),
            ("/fx", include_bytes!("fixtures/ecb_hist_90d.xml")),
        ]));
        let mut collector = Collector::new(plan(STATS_AND_POWER), Arc::clone(&feed), upstream);
        let store = feed.store();
        // 2026-10-10 17:05 UTC, when the fixtures were recorded.
        let now = 1_791_651_900;
        store.write(
            &[],
            &[("price/btc-mainnet".to_owned(), now - 300, 83_000.0)],
        )?;

        let report = collector.stats_round(now).await?;
        assert_eq!(report.requests, [("blockchair".to_owned(), 1)].into());
        let at = |name: &str| store.floor(name, now).unwrap().map(|(_, value)| value);
        assert_eq!(at("difficulty/btc-mainnet"), Some(132_716_002_350_731.3));
        assert_eq!(at("blockReward/btc-mainnet"), Some(3.125));
        // eCash paid 3,125,000 XEC a block; the miner's 58% (the bundled step in force) is
        // what the feed carries.
        assert_eq!(at("blockReward/xec-mainnet"), Some(3_125_000.0 * 0.58));
        // 20,096,217.9 BTC in existence at the relay's own price.
        let cap = at("marketCap/btc-mainnet").expect("market cap");
        assert!(
            (cap - 20_096_217.916_550_96 * 83_000.0).abs() < 1.0,
            "{cap}"
        );
        // No price collected for eCash: no market cap is made up.
        assert_eq!(at("marketCap/xec-mainnet"), None);
        // Dogecoin retargets every block (56.1M at that moment): the feed carries the 24-hour
        // hash rate, 3,826,509,895,446,723 H/s over 60-second blocks, as difficulty.
        let doge = at("difficulty/doge-mainnet").expect("doge difficulty");
        assert_eq!(doge, 3_826_509_895_446_723.0 * 60.0 / 4_294_967_296.0);
        assert!((53.0e6..54.0e6).contains(&doge), "{doge}");
        // Monero: difficulty, and no block reward because Blockchair publishes no issuance.
        assert_eq!(at("difficulty/xmr-mainnet"), Some(740_020_798_194.0));
        assert_eq!(at("blockReward/xmr-mainnet"), None);

        let report = collector.electricity_round(now).await?;
        assert_eq!(
            report.requests,
            [("de-lu".to_owned(), 1), ("ecb".to_owned(), 1)].into()
        );
        // The recorded answer covers 2026-10-07 22:00 to 2026-10-10 22:00 UTC: the 8th and
        // 9th are complete days, the 7th and 10th are not and are left out.
        let days = store.points("electricity/de-lu", 0, u64::MAX)?;
        let day = |date: &str| providers::parse_utc_date(date).unwrap();
        assert_eq!(
            days.iter().map(|(time, _)| *time).collect::<Vec<_>>(),
            vec![day("2026-10-08"), day("2026-10-09")]
        );
        let raw = store.raw("electricity/de-lu", 0, u64::MAX)?;
        let rate = store
            .raw("fx/eur-usd", day("2026-10-09"), day("2026-10-09"))?
            .first()
            .map(|sample| sample.value)
            .expect("reference rate of the 9th");
        // EUR/MWh x USD/EUR / 1000 = USD/kWh: around a tenth of a dollar, not a hundred.
        assert_eq!(days[1].1, raw[1].value * rate / 1000.0);
        assert!((0.03..0.4).contains(&days[1].1), "{}", days[1].1);
        assert!((1.0..1.3).contains(&rate), "{rate}");
        Ok(())
    }

    /// A statistics provider that is down for two rounds and then answers: the round stays due
    /// and is retried when each rest ends, so the reading arrives half an hour late, not after
    /// the hour (or more) a round marked as run would have cost.
    #[tokio::test]
    async fn a_round_that_got_nothing_stays_due_until_the_providers_rest_ends() -> Result<()> {
        struct Flaky {
            up: Mutex<bool>,
            asked: Mutex<u32>,
        }
        #[async_trait]
        impl Upstream for Flaky {
            async fn fetch(
                &self,
                _request: &UpstreamRequest,
            ) -> std::result::Result<Vec<u8>, UpstreamError> {
                *self.asked.lock().unwrap() += 1;
                if *self.up.lock().unwrap() {
                    Ok(include_bytes!("fixtures/blockchair.json").to_vec())
                } else {
                    Err(UpstreamError::Status(430))
                }
            }
        }
        let only_stats = &STATS_AND_POWER[..STATS_AND_POWER.find("[[electricity]]").unwrap()];
        let dir = tempdir::TempDir::new("oracle-retry")?;
        let feed = Arc::new(feed(&dir, only_stats));
        let flaky = Arc::new(Flaky {
            up: Mutex::new(false),
            asked: Mutex::new(0),
        });
        let upstream: Arc<dyn Upstream> = flaky.clone();
        let mut collector = Collector::new(plan(only_stats), Arc::clone(&feed), upstream);
        let mut rng = StdRng::seed_from_u64(1);
        let asked = || *flaky.asked.lock().unwrap();

        let due =
            || -> Result<u64> { Ok(feed.store().meta("last-round/stats")?.expect("ran") + 3600) };

        // Fails: rests ten minutes, and the round is due again then.
        collector.tick(T0, &mut rng).await;
        assert_eq!((asked(), due()?), (1, T0 + 600));
        // Fails again: rests twenty minutes. Waking earlier asks nobody and changes nothing.
        collector.tick(T0 + 600, &mut rng).await;
        assert_eq!((asked(), due()?), (2, T0 + 1800));
        collector.tick(T0 + 1200, &mut rng).await;
        assert_eq!((asked(), due()?), (2, T0 + 1800));
        // Back up when the rest ends: asked at once, and the reading is stored.
        *flaky.up.lock().unwrap() = true;
        collector.tick(T0 + 1800, &mut rng).await;
        assert_eq!(asked(), 3);
        assert_eq!(
            feed.store()
                .floor("difficulty/btc-mainnet", u64::MAX)?
                .map(|(time, _)| time),
            Some(T0 + 1800)
        );
        // From here the statistics round keeps its hour.
        assert_eq!(due()?, T0 + 1800 + 3600);
        collector.tick(T0 + 1860, &mut rng).await;
        assert_eq!(asked(), 3);
        Ok(())
    }

    /// A collector that panics or returns is started again after the pause; nothing else notices.
    #[tokio::test]
    async fn a_collector_that_panics_or_stops_is_started_again() {
        let runs = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let seen = Arc::clone(&runs);
        let make = move || {
            let run = seen.load(std::sync::atomic::Ordering::SeqCst);
            async move {
                match run {
                    1 => panic!("a provider answered something the collector could not survive"),
                    2 => {}
                    _ => std::future::pending::<()>().await,
                }
            }
        };
        let supervisor = tokio::spawn(supervise(make, Duration::from_millis(5), Arc::clone(&runs)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert!(!supervisor.is_finished(), "the third collector is running");
        supervisor.abort();
    }
}
