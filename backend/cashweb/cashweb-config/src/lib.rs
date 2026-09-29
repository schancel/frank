//! Crate for parsing configuration for cashweb, registry etc.

#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

use std::{error::Error, fmt, net::SocketAddr, path::PathBuf};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClientConf;
use bitcoinsuite_core::Net;
use bitcoinsuite_error::Result;
use serde::Deserialize;

/// Configuration of a cashwebd instance
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CashwebdConf {
    /// Where to bind the cashwebd server to
    pub host: SocketAddr,
    /// Under what URL we advertise ourselves to the outside world
    pub url: url::Url,
    /// Registry configuration
    pub registry: RegistryConf,
    /// Bitcoin/Lotus JSON-RPC configuration. Omit for a Monad-only server; legacy Lotus routes
    /// then fail closed while Monad routes remain available.
    #[serde(default)]
    pub bitcoin_rpc: Option<BitcoindRpcClientConf>,
}

/// Configuration for a registry server
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct RegistryConf {
    /// Path where the Registry's RocksDB database is stored.
    pub db_path: PathBuf,
    /// Whether we are on mainnet or regtest net.
    /// This is relevant for address parsing.
    pub net: Net,
    /// Peers this registry it connected to.
    pub peers: Vec<url::Url>,
    /// How to initally download metadata from peers
    #[serde(default)]
    pub imd: InitialMetadataDownloadConf,
    /// POP (proof-of-payment) protection config for the metadata-put endpoint (ticket #4).
    pub pop: PopConf,
    /// Durable Monad mailbox admission/reconciliation lifecycle. This is required so disabled is
    /// an explicit operator choice rather than an accidental missing RPC environment variable.
    pub monad_mailbox: MonadMailboxConf,
    /// Operator-curated default contacts advertised to fresh clients (ticket #49). Empty by
    /// default -- unlike `PopConf` this is display-only config with no security implications, so
    /// (unlike `pop`) it's safe to default to "none" rather than requiring an explicit value.
    #[serde(default)]
    pub curated_defaults: Vec<CuratedContactConf>,
}

/// Typed durable Monad mailbox configuration.
///
/// Disabling the mailbox is the supported rollback and preserves durable rows for the current
/// binary. Operators requiring binary downgrade must snapshot before upgrading because older
/// binaries cannot read newer versioned outbox rows.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct MonadMailboxConf {
    /// Whether admission and reconciliation are enabled. A disabled deployment must omit the
    /// admission route and does not start a worker; durable rows remain readable.
    pub enabled: bool,
    /// Monad JSON-RPC endpoint. Required exactly when `enabled` is true.
    pub rpc_url: Option<url::Url>,
    /// Aggregate direct-message stamp minimum, as a decimal string because TOML has no `u128`.
    /// Required exactly when the mailbox is enabled.
    pub min_value_wei: Option<String>,
}

/// Validated mailbox mode consumed once, before database open or socket readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MonadMailboxMode {
    /// No worker; the HTTP owner must omit the admission route.
    Disabled,
    /// Worker and admission use the same validated endpoint.
    Enabled {
        /// Validated Monad JSON-RPC endpoint.
        rpc_url: url::Url,
        /// Validated aggregate direct-message stamp minimum.
        min_value_wei: u128,
    },
}

/// Invalid enabled mailbox RPC configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MonadMailboxConfigError {
    /// Enabled mode omitted its mandatory endpoint.
    MissingRpcUrl,
    /// The endpoint is not a hosted HTTP(S) URL.
    InvalidRpcUrl,
    /// Enabled mode omitted or malformed its aggregate stamp minimum.
    InvalidMinValueWei,
}

impl fmt::Display for MonadMailboxConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRpcUrl => f.write_str(
                "registry.monad_mailbox.rpc_url is required when the mailbox is enabled",
            ),
            Self::InvalidRpcUrl => f.write_str(
                "registry.monad_mailbox.rpc_url must be a hosted http(s) URL when the mailbox is enabled",
            ),
            Self::InvalidMinValueWei => f.write_str(
                "registry.monad_mailbox.min_value_wei must be a decimal u128 when the mailbox is enabled",
            ),
        }
    }
}

impl Error for MonadMailboxConfigError {}

impl MonadMailboxConf {
    /// Validate the enabled/endpoint relationship before any service becomes ready.
    pub fn mode(&self) -> std::result::Result<MonadMailboxMode, MonadMailboxConfigError> {
        if !self.enabled {
            return Ok(MonadMailboxMode::Disabled);
        }
        let rpc_url = self
            .rpc_url
            .clone()
            .ok_or(MonadMailboxConfigError::MissingRpcUrl)?;
        if !matches!(rpc_url.scheme(), "http" | "https") || rpc_url.host_str().is_none() {
            return Err(MonadMailboxConfigError::InvalidRpcUrl);
        }
        let min_value_wei = self
            .min_value_wei
            .as_deref()
            .ok_or(MonadMailboxConfigError::InvalidMinValueWei)?
            .parse()
            .map_err(|_| MonadMailboxConfigError::InvalidMinValueWei)?;
        Ok(MonadMailboxMode::Enabled {
            rpc_url,
            min_value_wei,
        })
    }
}

/// One operator-curated default contact (ticket #49) -- see `RegistryConf::curated_defaults`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CuratedContactConf {
    /// `0x`-prefixed, 20-byte Monad address.
    pub address: String,
    /// Display name shown to the user before they've ever messaged this contact.
    pub name: String,
}

/// Configuration for POP (proof-of-payment) protection on the registry metadata-put endpoint
/// (`cashweb_registry::http::pop_protection`).
///
/// This is a required field of [`RegistryConf`] rather than an `Option`, deliberately: ticket #1
/// flagged the metadata-put endpoint having *no* payment gating at all as a bug, and #24/#4 fixed
/// that on the principle that missing configuration should fail closed. Requiring this at
/// config-parse time fails even earlier (at startup, with a clear "missing field" error) than the
/// previous per-request runtime check.
///
/// Ticket #35: `enabled` is a distinct, explicit third state from "misconfigured". When
/// `enabled = false`, POP gating is skipped entirely (fail-*open*, by deliberate operator intent
/// -- e.g. the hackathon demo, where signing up should require no payment). When `enabled = true`
/// but the rest of this struct doesn't parse into a valid gate (bad `payment_recipient`/
/// `min_value_wei`), behavior is unchanged from before this ticket: fail *closed* with a `500`
/// (see `cashweb_registry::http::pop_protection::PopGateConfigError` and
/// `cashweb_registry::http::server::RegistryServer::pop_gate`'s doc comment for how these two
/// states are kept from collapsing into each other). There's deliberately no `#[serde(default)]`
/// on this field: an operator must say explicitly whether POP is on, the same "no silent
/// defaults" principle the rest of this struct already follows.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PopConf {
    /// Whether POP gating is active at all. `false` (the hackathon demo default) skips POP
    /// gating entirely for every request -- no token check, no 402 challenge. `true` requires
    /// the rest of this struct to parse into a valid gate at server-construction time, or every
    /// gated request fails closed with a `500` (see this struct's docs).
    pub enabled: bool,
    /// Monad JSON-RPC endpoint used to verify payment transaction receipts (same convention as
    /// the `MONAD_TESTNET_HTTP_RPC_URL` env var used elsewhere in this crate/`cashweb-registry`).
    pub monad_rpc_url: url::Url,
    /// Server-side secret used to sign/verify bearer tokens (HMAC). Must be a long random string
    /// kept only in server config; there is deliberately no built-in default.
    pub hmac_secret: String,
    /// `0x`-prefixed, 20-byte Monad address payments must be sent to. Kept as a plain `String`
    /// here (rather than a `cashweb-registry`-defined address type) so this crate doesn't need to
    /// depend on `cashweb-registry`; it's parsed downstream by
    /// `cashweb_registry::http::pop_protection::PopGate::from_conf`.
    pub payment_recipient: String,
    /// Minimum payment amount, in wei, as a decimal string. Kept as a `String` (rather than
    /// `u128`) since TOML has no native 128-bit integer type; parsed downstream the same way as
    /// `payment_recipient`.
    pub min_value_wei: String,
}

/// How to initally download metadata from peers
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct InitialMetadataDownloadConf {
    /// How many peers will be sampled each round when syncing
    #[serde(default = "default_num_sampled_peers")]
    pub num_sampled_peers: usize,
    /// When we stop waiting for a peer to respond, in milliseconds
    #[serde(default = "default_timeout_peer_ms")]
    pub timeout_peer_ms: u64,
    /// How many failed rounds (rounds with no successful results at all)
    /// of querying peers we do before we wait some time
    #[serde(default = "default_num_failed_for_wait")]
    pub num_failed_for_wait: usize,
    /// How long we wait after N rounds failed, in seconds
    #[serde(default = "default_fail_wait_duration_s")]
    pub fail_wait_duration_s: u64,
}

/// Parse the configuration file from a string
pub fn parse_conf(conf_str: &str) -> Result<CashwebdConf> {
    Ok(toml::from_str(conf_str)?)
}

impl Default for InitialMetadataDownloadConf {
    fn default() -> Self {
        InitialMetadataDownloadConf {
            num_sampled_peers: default_num_sampled_peers(),
            timeout_peer_ms: default_timeout_peer_ms(),
            num_failed_for_wait: default_num_failed_for_wait(),
            fail_wait_duration_s: default_fail_wait_duration_s(),
        }
    }
}

fn default_num_sampled_peers() -> usize {
    3
}

fn default_timeout_peer_ms() -> u64 {
    1500
}

fn default_num_failed_for_wait() -> usize {
    3
}

fn default_fail_wait_duration_s() -> u64 {
    30
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClientConf;
    use bitcoinsuite_core::Net;
    use bitcoinsuite_error::Result;

    use crate::{
        parse_conf, CashwebdConf, CuratedContactConf, InitialMetadataDownloadConf,
        MonadMailboxConf, MonadMailboxConfigError, MonadMailboxMode, PopConf, RegistryConf,
    };

    #[test]
    fn test_config_err() -> Result<()> {
        let err = parse_conf("").unwrap_err().downcast::<toml::de::Error>()?;
        assert_eq!(err.to_string(), "missing field `host`");
        Ok(())
    }

    #[test]
    fn test_config_partial_imd_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf,
            CashwebdConf {
                host: "127.0.0.1:6543".parse()?,
                url: "https://cashweb.registry".parse()?,
                registry: RegistryConf {
                    db_path: "/test/path".into(),
                    net: Net::Mainnet,
                    peers: vec![
                        "https://example.com".parse()?,
                        "http://123.45.67.89".parse()?,
                    ],
                    imd: InitialMetadataDownloadConf {
                        num_sampled_peers: 3,
                        timeout_peer_ms: 1500,
                        num_failed_for_wait: 3,
                        fail_wait_duration_s: 30,
                    },
                    pop: PopConf {
                        enabled: true,
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                    monad_mailbox: MonadMailboxConf {
                        enabled: false,
                        rpc_url: None,
                        min_value_wei: None,
                    },
                    curated_defaults: vec![],
                },
                bitcoin_rpc: Some(BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                }),
            }
        );
        Ok(())
    }

    #[test]
    fn test_config_default_imd_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]
                [registry.imd]
                num_sampled_peers = 2

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf,
            CashwebdConf {
                host: "127.0.0.1:6543".parse()?,
                url: "https://cashweb.registry".parse()?,
                registry: RegistryConf {
                    db_path: "/test/path".into(),
                    net: Net::Mainnet,
                    peers: vec![
                        "https://example.com".parse()?,
                        "http://123.45.67.89".parse()?,
                    ],
                    imd: InitialMetadataDownloadConf {
                        num_sampled_peers: 2,
                        timeout_peer_ms: 1500,
                        num_failed_for_wait: 3,
                        fail_wait_duration_s: 30,
                    },
                    pop: PopConf {
                        enabled: true,
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                    monad_mailbox: MonadMailboxConf {
                        enabled: false,
                        rpc_url: None,
                        min_value_wei: None,
                    },
                    curated_defaults: vec![],
                },
                bitcoin_rpc: Some(BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                }),
            }
        );
        Ok(())
    }

    #[test]
    fn test_config_monad_only_without_bitcoin_rpc() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:8098"
                url = "http://127.0.0.1:8098"

                [registry]
                db_path = "data/registry.rocksdb"
                net = "mainnet"
                peers = []

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = false
                monad_rpc_url = "http://unused.invalid"
                hmac_secret = "unused"
                payment_recipient = "0x0000000000000000000000000000000000000000"
                min_value_wei = "0"
            "#,
        )?;

        assert_eq!(conf.bitcoin_rpc, None);
        assert_eq!(
            conf.registry.db_path,
            PathBuf::from("data/registry.rocksdb")
        );
        Ok(())
    }

    #[test]
    fn test_config_curated_defaults_success() -> Result<()> {
        let conf = parse_conf(
            r#"
                host = "127.0.0.1:6543"
                url = "https://cashweb.registry"

                [registry]
                db_path = "/test/path"
                net = "mainnet"
                peers = ["https://example.com", "http://123.45.67.89"]

                [registry.monad_mailbox]
                enabled = false

                [registry.pop]
                enabled = true
                monad_rpc_url = "https://monad.rpc"
                hmac_secret = "super-secret"
                payment_recipient = "0x0000000000000000000000000000000000000abc"
                min_value_wei = "1000000000000000000"

                [[registry.curated_defaults]]
                address = "0x1111111111111111111111111111111111111111"
                name = "Welcome Bot"

                [[registry.curated_defaults]]
                address = "0x2222222222222222222222222222222222222222"
                name = "Support"

                [bitcoin_rpc]
                url = "https://bitcoin.rpc"
                rpc_user = "user"
                rpc_pass = "passwd"
            "#,
        )?;
        assert_eq!(
            conf.registry.curated_defaults,
            vec![
                CuratedContactConf {
                    address: "0x1111111111111111111111111111111111111111".to_string(),
                    name: "Welcome Bot".to_string(),
                },
                CuratedContactConf {
                    address: "0x2222222222222222222222222222222222222222".to_string(),
                    name: "Support".to_string(),
                },
            ]
        );
        Ok(())
    }

    #[test]
    fn mailbox_mode_requires_rpc_exactly_when_enabled() {
        assert_eq!(
            MonadMailboxConf {
                enabled: false,
                rpc_url: None,
                min_value_wei: None,
            }
            .mode()
            .unwrap(),
            MonadMailboxMode::Disabled
        );
        assert!(MonadMailboxConf {
            enabled: true,
            rpc_url: None,
            min_value_wei: Some("1".to_string()),
        }
        .mode()
        .is_err());
        let rpc_url: url::Url = "https://rpc.example".parse().unwrap();
        assert_eq!(
            MonadMailboxConf {
                enabled: true,
                rpc_url: Some(rpc_url.clone()),
                min_value_wei: Some("1000".to_string()),
            }
            .mode()
            .unwrap(),
            MonadMailboxMode::Enabled {
                rpc_url,
                min_value_wei: 1000,
            }
        );
        let missing: MonadMailboxConf = toml::from_str("enabled = true").unwrap();
        assert!(missing.mode().is_err());
        assert!(toml::from_str::<MonadMailboxConf>(
            "enabled = true\nrpc_url = 'this is not a URL'"
        )
        .is_err());
        for rejected in [
            "file:///tmp/rpc",
            "ftp://rpc.example/path",
            "data:text/plain,rpc",
        ] {
            assert_eq!(
                MonadMailboxConf {
                    enabled: true,
                    rpc_url: Some(rejected.parse().unwrap()),
                    min_value_wei: Some("1".to_string()),
                }
                .mode(),
                Err(MonadMailboxConfigError::InvalidRpcUrl)
            );
        }
    }
}
