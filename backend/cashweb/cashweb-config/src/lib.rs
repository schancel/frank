//! Crate for parsing configuration for cashweb, registry etc.

#![warn(
    missing_debug_implementations,
    missing_docs,
    rust_2018_idioms,
    unreachable_pub
)]

use std::{net::SocketAddr, path::PathBuf};

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
    /// Bitcoin JSONRPC configuration
    pub bitcoin_rpc: BitcoindRpcClientConf,
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
}

/// Configuration for POP (proof-of-payment) protection on the registry metadata-put endpoint
/// (`cashweb_registry::http::pop_protection`).
///
/// This is a required field of [`RegistryConf`] rather than an `Option`, deliberately: ticket #1
/// flagged the metadata-put endpoint having *no* payment gating at all as a bug, and #24/#4 fixed
/// that on the principle that missing configuration should fail closed. Requiring this at
/// config-parse time fails even earlier (at startup, with a clear "missing field" error) than the
/// previous per-request runtime check.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PopConf {
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
    use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClientConf;
    use bitcoinsuite_core::Net;
    use bitcoinsuite_error::Result;

    use crate::{parse_conf, CashwebdConf, InitialMetadataDownloadConf, PopConf, RegistryConf};

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

                [registry.pop]
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
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                },
                bitcoin_rpc: BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                },
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

                [registry.pop]
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
                        monad_rpc_url: "https://monad.rpc".parse()?,
                        hmac_secret: "super-secret".to_string(),
                        payment_recipient: "0x0000000000000000000000000000000000000abc".to_string(),
                        min_value_wei: "1000000000000000000".to_string(),
                    },
                },
                bitcoin_rpc: BitcoindRpcClientConf {
                    url: "https://bitcoin.rpc".to_string(),
                    rpc_user: "user".to_string(),
                    rpc_pass: "passwd".to_string(),
                },
            }
        );
        Ok(())
    }
}
