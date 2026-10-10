//! The relay's price and energy oracle: a background collector, its store, and the feed it
//! serves at `GET /oracle/v1/feed` (contract: `docs/protocol/oracle/README.md`).
//!
//! Ownership:
//! - [`providers`]: one module per upstream, turning its answer into normalised numbers.
//! - [`sampling`]: what a round's answers mean and how samples are smoothed. Pure.
//! - [`collector`]: decides whom to ask and when, and is the only writer of the store.
//! - [`store`]: collected answers and series, persisted.
//! - [`seed`]: history and curated steps compiled into the binary. Never fetched.
//! - [`feed`]: reads store and seed and builds the answers. A request never reaches upstream.
//!
//! The relay does not compute AVU. It serves the inputs; the client's one function computes.

use std::{collections::BTreeMap, sync::Arc};

use cashweb_config::{
    OracleConf, OracleElectricityAdapter, OracleElectricityConf, OraclePriceProviderConf,
};

pub mod collector;
pub mod feed;
pub mod providers;
pub mod sampling;
pub mod seed;
pub mod store;

/// Configuration with keys resolved: who can actually be asked.
#[derive(Clone)]
pub struct Plan {
    /// The validated configuration.
    pub conf: OracleConf,
    /// Provider id or electricity region -> its API key.
    keys: BTreeMap<String, String>,
}

impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Keys are never printed, not even their names' values.
        f.debug_struct("Plan")
            .field("keys", &format_args!("<{} redacted>", self.keys.len()))
            .finish_non_exhaustive()
    }
}

impl Plan {
    /// Resolves the keys named in `conf` from `env`. A named key that is unset or empty makes
    /// its provider unusable; nothing else changes.
    pub fn new(conf: OracleConf, env: impl Fn(&str) -> Option<String>) -> Self {
        let mut keys = BTreeMap::new();
        let named = conf
            .price_providers
            .iter()
            .map(|provider| (&provider.id, &provider.key_env))
            .chain(
                conf.electricity
                    .iter()
                    .map(|row| (&row.region, &row.key_env)),
            );
        for (id, key_env) in named {
            let key = key_env
                .as_deref()
                .and_then(&env)
                .map(|key| key.trim().to_owned())
                .filter(|key| !key.is_empty());
            if let Some(key) = key {
                keys.insert(id.clone(), key);
            }
        }
        Plan { conf, keys }
    }

    /// Price providers that can be asked: those needing no key, or whose key is set.
    pub fn price_providers(&self) -> impl Iterator<Item = &OraclePriceProviderConf> {
        self.conf
            .price_providers
            .iter()
            .filter(|provider| provider.key_env.is_none() || self.keys.contains_key(&provider.id))
    }

    /// Every asset some usable provider lists.
    pub fn assets(&self) -> Vec<String> {
        let mut assets = self
            .price_providers()
            .flat_map(|provider| provider.symbols.keys().cloned())
            .collect::<Vec<_>>();
        assets.sort();
        assets.dedup();
        assets
    }

    /// The key of a keyed electricity region, when set.
    pub(crate) fn electricity_key(&self, row: &OracleElectricityConf) -> Option<&str> {
        self.keys.get(&row.region).map(String::as_str)
    }

    /// Whether a region can be collected now.
    pub fn collects(&self, row: &OracleElectricityConf) -> bool {
        match row.adapter {
            OracleElectricityAdapter::EnergyCharts => true,
            OracleElectricityAdapter::Eia => self.electricity_key(row).is_some(),
        }
    }
}

/// The oracle as the rest of the relay sees it.
#[derive(Debug, Clone)]
pub struct OracleRuntime {
    /// Builds the answers of the feed route.
    pub feed: Arc<feed::Feed>,
}

impl OracleRuntime {
    /// Opens the store beside the registry database and, unless `collect = false`, starts the
    /// collector as its own supervised task. Touches no network: the collector's first request
    /// happens after this returns, and no failure of any provider reaches the caller. With
    /// collection off no provider is ever asked: the feed serves the bundled seed and whatever
    /// the store already holds.
    pub fn start(
        conf: OracleConf,
        registry_db_path: &std::path::Path,
        env: impl Fn(&str) -> Option<String>,
    ) -> bitcoinsuite_error::Result<Self> {
        let plan = Plan::new(conf, env);
        let store =
            store::OracleStore::open(registry_db_path.with_extension(store::STORE_EXTENSION))?;
        let seed = seed::Seed::embedded()?;
        let feed = Arc::new(feed::Feed::new(plan.clone(), store, seed));
        if plan.conf.collect {
            let upstream = Arc::new(collector::HttpUpstream::new(
                std::time::Duration::from_millis(plan.conf.timeout_ms),
            ));
            tokio::spawn(collector::supervise_collector(
                plan,
                Arc::clone(&feed),
                upstream,
            ));
        } else {
            tracing::info!(
                "oracle: collection is off (registry.oracle.collect = false); serving bundled \
                 and stored data only"
            );
        }
        Ok(OracleRuntime { feed })
    }
}
