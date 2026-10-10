//! `[registry.oracle]`: the relay's price and energy feed (`GET /oracle/v1/feed`).
//!
//! Everything a provider needs to be asked is here: its URL, which adapter reads its answer, and
//! the symbol it uses for each asset or chain. (The key is `api_url`, not `url`: the local
//! launcher rewrites top-of-line `url =` and `endpoint =` keys to the relay's own address.) Assets and chains are named by their canonical
//! identifier from `docs/protocol/chains/v1.json`; identifiers the feed prices that are not Frank
//! networks (Litecoin, Monero, tokens) are listed once in `non_network_ids`.

use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
};

use serde::Deserialize;

use crate::protocol_chain;

/// The relay's price and energy oracle. The section's presence turns it on; without it no
/// collector runs and the feed route is not installed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OracleConf {
    /// Seconds between price rounds.
    #[serde(default = "default_price_interval_s")]
    pub price_interval_s: u64,
    /// Seconds between chain-statistics rounds.
    #[serde(default = "default_stats_interval_s")]
    pub stats_interval_s: u64,
    /// Seconds between electricity rounds.
    #[serde(default = "default_electricity_interval_s")]
    pub electricity_interval_s: u64,
    /// Two providers within this many basis points of each other agree; their mean is the sample.
    #[serde(default = "default_agree_tolerance_bps")]
    pub agree_tolerance_bps: u32,
    /// When only two providers answer for an asset and they differ by more than this many basis
    /// points, the round produces no sample for it.
    #[serde(default = "default_two_source_max_spread_bps")]
    pub two_source_max_spread_bps: u32,
    /// A sample further than this many basis points from the smoothed value needs a third
    /// provider before it is applied.
    #[serde(default = "default_outlier_threshold_bps")]
    pub outlier_threshold_bps: u32,
    /// Time constant of the smoothing, in seconds: `alpha = 1 - exp(-dt / tau)`.
    #[serde(default = "default_ewma_tau_s")]
    pub ewma_tau_s: u64,
    /// With no smoothed value newer than this many seconds, the next sample starts the series
    /// again (median of three providers where three list the asset) instead of being smoothed in.
    #[serde(default = "default_long_gap_s")]
    pub long_gap_s: u64,
    /// Days kept at full resolution; older points are thinned to the last one of each day.
    #[serde(default = "default_full_resolution_days")]
    pub full_resolution_days: u64,
    /// `electricity/aggregate` is each region's mean daily price over this many days.
    #[serde(default = "default_electricity_window_days")]
    pub electricity_window_days: u64,
    /// A region with fewer daily prices than this in the window is left out of the aggregate.
    #[serde(default = "default_electricity_min_days")]
    pub electricity_min_days: u64,
    /// Complete timeout of one upstream request.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// Identifiers the feed prices that have no row in the chain registry.
    #[serde(default)]
    pub non_network_ids: Vec<String>,
    /// Price providers. Each round asks two of them, chosen at random.
    #[serde(default)]
    pub price_providers: Vec<OraclePriceProviderConf>,
    /// Chain statistics (difficulty, coins in existence, block subsidy).
    #[serde(default)]
    pub chain_stats: Option<OracleChainStatsConf>,
    /// Wholesale electricity prices, one row per region.
    #[serde(default)]
    pub electricity: Vec<OracleElectricityConf>,
}

/// Which code reads a price provider's answer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OraclePriceAdapter {
    /// Coinbase `/v2/exchange-rates?currency=USD`.
    Coinbase,
    /// Kraken `/0/public/Ticker`.
    Kraken,
    /// Binance or Binance.US `/api/v3/ticker/price`.
    Binance,
    /// CoinGecko `/api/v3/simple/price`.
    Coingecko,
    /// Chainlink feed contracts read with `eth_call` over an EVM JSON-RPC endpoint.
    Chainlink,
}

/// One price provider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OraclePriceProviderConf {
    /// Name used in stored samples, logs and counts, e.g. `binance-us`.
    pub id: String,
    /// The code that reads this provider's answer.
    pub adapter: OraclePriceAdapter,
    /// The endpoint, without query parameters the adapter adds.
    pub api_url: url::Url,
    /// Environment variable holding this provider's API key. A provider whose variable is named
    /// here but unset is not asked.
    #[serde(default)]
    pub key_env: Option<String>,
    /// Asset identifier -> the provider's own symbol for it.
    pub symbols: BTreeMap<String, String>,
}

/// The chain-statistics provider (Blockchair `/stats`).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OracleChainStatsConf {
    /// Name used in stored samples, logs and counts.
    pub id: String,
    /// The endpoint answering every chain in one response.
    pub api_url: url::Url,
    /// Chain identifier -> how the provider reports it.
    pub chains: BTreeMap<String, OracleStatsChainConf>,
}

/// How one chain is read from the statistics provider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OracleStatsChainConf {
    /// The provider's name for the chain, e.g. `bitcoin-cash`.
    pub name: String,
    /// Base units per coin are `10^decimals`.
    pub decimals: u32,
    /// For a chain that retargets every block (Dogecoin), whose difficulty swings between
    /// readings: the chain's target block time in seconds. The feed then carries a 24-hour
    /// figure, the provider's 24-hour hash rate times this, as difficulty (per 2^32 hashes),
    /// instead of the difficulty of the moment. Only for chains with Bitcoin's difficulty rule.
    #[serde(default)]
    pub hashrate_block_seconds: Option<u64>,
}

/// Which code collects a region's electricity price.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OracleElectricityAdapter {
    /// Energy-Charts `/price` (EUR/MWh, day-ahead), converted with the ECB reference rate.
    EnergyCharts,
    /// US EIA API v2. Needs a key.
    Eia,
}

/// One electricity region.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OracleElectricityConf {
    /// Region identifier in the feed, e.g. `de-lu`.
    pub region: String,
    /// Display name, e.g. `Germany-Luxembourg day-ahead`.
    pub label: String,
    /// The attribution the source asks for.
    pub attribution: String,
    /// Whether this region counts in `electricity/aggregate`. Default true.
    #[serde(default = "default_true")]
    pub in_aggregate: bool,
    /// The code that reads this source.
    pub adapter: OracleElectricityAdapter,
    /// The endpoint. For `eia` this is the complete v2 data URL without `api_key`.
    pub api_url: url::Url,
    /// `energy-charts`: the bidding zone, e.g. `DE-LU`.
    #[serde(default)]
    pub zone: Option<String>,
    /// `energy-charts`: where the EUR->USD reference rate is read (ECB daily XML).
    #[serde(default)]
    pub fx_url: Option<url::Url>,
    /// Environment variable holding the API key. Named but unset: the region is not collected
    /// and only its bundled history is served.
    #[serde(default)]
    pub key_env: Option<String>,
    /// `eia`: the column of each row holding the price.
    #[serde(default)]
    pub value_field: Option<String>,
    /// `eia`: multiply the column by this decimal to get US dollars per kWh (`"0.001"` for $/MWh).
    #[serde(default)]
    pub usd_per_kwh_factor: Option<String>,
}

/// Invalid `[registry.oracle]` configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleConfigError {
    /// An interval, tolerance or time constant is zero or out of range.
    InvalidSetting(&'static str),
    /// A provider or region identifier is malformed or repeated.
    InvalidId(String),
    /// An asset or chain identifier is neither in the chain registry nor in `non_network_ids`.
    UnknownIdentifier(String),
    /// A URL is not http(s).
    InvalidUrl(String),
    /// An environment variable name is malformed.
    InvalidKeyEnv(String),
    /// A decimal setting does not parse as a positive number.
    InvalidDecimal(String),
    /// A provider row lacks a setting its adapter needs.
    MissingSetting(String),
}

impl fmt::Display for OracleConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid registry.oracle configuration: {self:?}")
    }
}

impl Error for OracleConfigError {}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_env(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_uppercase() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}

fn check_url(url: &url::Url) -> Result<(), OracleConfigError> {
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        Ok(())
    } else {
        // Only the host: a path or query may carry a credential.
        Err(OracleConfigError::InvalidUrl(
            url.host_str().unwrap_or("").to_owned(),
        ))
    }
}

/// A positive decimal setting such as `"0.58"`.
pub fn parse_positive_decimal(text: &str) -> Option<f64> {
    text.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
}

impl OracleConf {
    /// Check the configuration without resolving any key.
    pub fn validate(&self) -> Result<(), OracleConfigError> {
        use OracleConfigError::*;
        for (name, value) in [
            ("price_interval_s", self.price_interval_s),
            ("stats_interval_s", self.stats_interval_s),
            ("electricity_interval_s", self.electricity_interval_s),
        ] {
            if !(60..=7 * 86_400).contains(&value) {
                return Err(InvalidSetting(name));
            }
        }
        for (name, value) in [
            ("agree_tolerance_bps", self.agree_tolerance_bps),
            ("two_source_max_spread_bps", self.two_source_max_spread_bps),
            ("outlier_threshold_bps", self.outlier_threshold_bps),
        ] {
            if !(1..=10_000).contains(&value) {
                return Err(InvalidSetting(name));
            }
        }
        if self.ewma_tau_s == 0 {
            return Err(InvalidSetting("ewma_tau_s"));
        }
        if self.long_gap_s < self.price_interval_s {
            return Err(InvalidSetting("long_gap_s"));
        }
        if self.full_resolution_days == 0 {
            return Err(InvalidSetting("full_resolution_days"));
        }
        if !(1..=366).contains(&self.electricity_window_days) {
            return Err(InvalidSetting("electricity_window_days"));
        }
        if !(1..=self.electricity_window_days).contains(&self.electricity_min_days) {
            return Err(InvalidSetting("electricity_min_days"));
        }
        if self.timeout_ms == 0 || self.timeout_ms > 120_000 {
            return Err(InvalidSetting("timeout_ms"));
        }
        let extra: HashSet<&str> = self.non_network_ids.iter().map(String::as_str).collect();
        if let Some(bad) = self.non_network_ids.iter().find(|id| !valid_id(id)) {
            return Err(InvalidId(bad.clone()));
        }
        let known = |id: &str| -> Result<(), OracleConfigError> {
            if protocol_chain(id).is_some() || extra.contains(id) {
                Ok(())
            } else {
                Err(UnknownIdentifier(id.to_owned()))
            }
        };
        let mut ids = HashSet::new();
        for provider in &self.price_providers {
            if !valid_id(&provider.id) || !ids.insert(provider.id.as_str()) {
                return Err(InvalidId(provider.id.clone()));
            }
            check_url(&provider.api_url)?;
            if let Some(env) = &provider.key_env {
                if !valid_env(env) {
                    return Err(InvalidKeyEnv(env.clone()));
                }
            }
            for asset in provider.symbols.keys() {
                known(asset)?;
            }
        }
        if let Some(stats) = &self.chain_stats {
            if !valid_id(&stats.id) || !ids.insert(stats.id.as_str()) {
                return Err(InvalidId(stats.id.clone()));
            }
            check_url(&stats.api_url)?;
            for (chain, row) in &stats.chains {
                known(chain)?;
                if row.decimals > 30 {
                    return Err(InvalidSetting("chain_stats decimals"));
                }
            }
        }
        let mut regions = HashSet::new();
        for row in &self.electricity {
            if !valid_id(&row.region)
                || row.region == "aggregate"
                || !regions.insert(row.region.as_str())
            {
                return Err(InvalidId(row.region.clone()));
            }
            check_url(&row.api_url)?;
            if let Some(env) = &row.key_env {
                if !valid_env(env) {
                    return Err(InvalidKeyEnv(env.clone()));
                }
            }
            match row.adapter {
                OracleElectricityAdapter::EnergyCharts => {
                    if row.zone.as_deref().is_none_or(str::is_empty) {
                        return Err(MissingSetting(format!("{}: zone", row.region)));
                    }
                    match &row.fx_url {
                        Some(url) => check_url(url)?,
                        None => return Err(MissingSetting(format!("{}: fx_url", row.region))),
                    }
                }
                OracleElectricityAdapter::Eia => {
                    if row.key_env.is_none() {
                        return Err(MissingSetting(format!("{}: key_env", row.region)));
                    }
                    if row.value_field.as_deref().is_none_or(str::is_empty) {
                        return Err(MissingSetting(format!("{}: value_field", row.region)));
                    }
                    match row.usd_per_kwh_factor.as_deref() {
                        Some(text) if parse_positive_decimal(text).is_some() => {}
                        Some(text) => {
                            return Err(InvalidDecimal(format!("{}: {text}", row.region)))
                        }
                        None => {
                            return Err(MissingSetting(format!(
                                "{}: usd_per_kwh_factor",
                                row.region
                            )))
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn default_price_interval_s() -> u64 {
    600
}
fn default_stats_interval_s() -> u64 {
    3600
}
fn default_electricity_interval_s() -> u64 {
    86_400
}
fn default_agree_tolerance_bps() -> u32 {
    200
}
fn default_two_source_max_spread_bps() -> u32 {
    1000
}
fn default_outlier_threshold_bps() -> u32 {
    1000
}
fn default_ewma_tau_s() -> u64 {
    1800
}
fn default_long_gap_s() -> u64 {
    6 * 3600
}
fn default_full_resolution_days() -> u64 {
    14
}
fn default_electricity_window_days() -> u64 {
    30
}
fn default_electricity_min_days() -> u64 {
    10
}
fn default_true() -> bool {
    true
}
fn default_timeout_ms() -> u64 {
    10_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_conf;

    /// Both shipped configurations turn the oracle on, pass validation, and name no provider
    /// that needs a key: a fresh checkout collects without any secret.
    #[test]
    fn shipped_configurations_enable_the_oracle_with_keyless_providers_only() {
        for (name, config) in [
            (
                "cashwebd.local.toml",
                include_str!("../../cashwebd.local.toml"),
            ),
            (
                "docker/cashwebd.toml",
                include_str!("../../../docker/cashwebd.toml"),
            ),
        ] {
            let conf = parse_conf(config).unwrap_or_else(|err| panic!("{name}: {err}"));
            let oracle = conf
                .registry
                .oracle
                .unwrap_or_else(|| panic!("{name}: no [registry.oracle]"));
            assert_eq!(oracle.validate(), Ok(()), "{name}");
            assert!(oracle.price_providers.len() >= 3, "{name}");
            assert!(
                oracle.price_providers.iter().all(|p| p.key_env.is_none()),
                "{name}"
            );
            assert!(oracle.chain_stats.is_some(), "{name}");
            assert!(
                oracle.electricity.iter().any(|row| row.key_env.is_none()),
                "{name}"
            );
        }
    }

    fn minimal(extra: &str) -> OracleConf {
        toml::from_str(extra).expect("parses")
    }

    #[test]
    fn an_identifier_outside_the_registry_must_be_declared() {
        let undeclared = minimal(
            "[[price_providers]]\nid = \"kraken\"\nadapter = \"kraken\"\n\
             api_url = \"https://example.invalid/t\"\nsymbols = { ltc-mainnet = \"XLTCZUSD\" }\n",
        );
        assert_eq!(
            undeclared.validate(),
            Err(OracleConfigError::UnknownIdentifier(
                "ltc-mainnet".to_owned()
            ))
        );
        let declared = minimal(
            "non_network_ids = [\"ltc-mainnet\"]\n[[price_providers]]\nid = \"kraken\"\n\
             adapter = \"kraken\"\napi_url = \"https://example.invalid/t\"\n\
             symbols = { ltc-mainnet = \"XLTCZUSD\", btc-mainnet = \"XXBTZUSD\" }\n",
        );
        assert_eq!(declared.validate(), Ok(()));
    }

    #[test]
    fn a_keyed_adapter_without_a_key_variable_is_refused() {
        let eia = minimal(
            "[[electricity]]\nregion = \"us\"\nlabel = \"US\"\nattribution = \"EIA\"\nadapter = \"eia\"\n\
             api_url = \"https://example.invalid/v2\"\nvalue_field = \"price\"\n\
             usd_per_kwh_factor = \"0.01\"\n",
        );
        assert_eq!(
            eia.validate(),
            Err(OracleConfigError::MissingSetting("us: key_env".to_owned()))
        );
    }

    #[test]
    fn a_setting_out_of_range_is_refused() {
        assert_eq!(
            minimal("price_interval_s = 1").validate(),
            Err(OracleConfigError::InvalidSetting("price_interval_s"))
        );
        assert_eq!(minimal("").validate(), Ok(()));
    }
}
