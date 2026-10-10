use std::{io::Read, sync::Arc, time::Duration};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClient;
use bitcoinsuite_error::{Result, WrapErr};
use cashweb_config::{parse_conf, CashwebdConf, MonadMailboxMode};
use cashweb_registry::{
    disabled_chain_adapter::DisabledChainAdapter,
    http::{
        bitcoin_proxy::BitcoinProxyRuntime, curated_defaults::build_curated_defaults,
        evm_rpc::EvmRpcRuntime, pop_protection::PopGate, server::RegistryServer,
        solana_proxy::SolanaProxyRuntime,
    },
    lotus_adapter::LotusAdapter,
    monad_http::HttpTransport,
    monad_mailbox::{MailboxConfig, MonadMailboxRuntime, SessionSecret},
    network_tag::{is_valid_network_tag, monad_network},
    p2p::{
        peer::Peer,
        peers::{InitialMetadataDownloadParams, Peers},
        public_store::PublicFederationStore,
    },
    registry::Registry,
    store::db::Db,
};
use thiserror::Error;
use tracing::info;
use tracing_subscriber::fmt;

#[derive(Error, Debug)]
pub enum CashwebdExeError {
    #[error(
        "No configuration provided. Specify a path, or '-' to read configuration from stdin: \
         cashwebd-exe [--check-config|--check-db] <config path|->"
    )]
    NoConfigFile,

    #[error("Opening configuration file {0} failed")]
    OpenConfigFail(String),

    #[error("Failed to read configuration file {0}")]
    ReadConfigFail(String),

    #[error("Invalid configuration file {0}")]
    InvalidConfigFail(String),

    #[error(
        "The Monad mailbox is enabled but no RPC URL is configured: set the \
         MONAD_TESTNET_HTTP_RPC_URL environment variable (or registry.monad_mailbox.rpc_url)"
    )]
    MissingRpcUrlEnv,

    #[error("Invalid registry.monad_mailbox configuration: MONAD_TESTNET_HTTP_RPC_URL must be a comma-separated list of HTTP(S) URLs")]
    InvalidRpcUrlEnv,

    #[error(
        "The Monad mailbox is enabled but FRANK_NETWORK_TAG is unset or invalid (1 to 32 bytes, no \
         surrounding whitespace): the relay would reject every direct message. Set it to MONT \
         (Monad testnet) or MON1 (Monad mainnet)"
    )]
    MissingNetworkTagEnv,

    #[error(
        "FRANK_NETWORK_TAG is set to a tag with no Frank-CBOR network identifier (known tags: \
         MONT, MON1, MONR): refusing to start rather than guess a network"
    )]
    UnknownNetworkTagEnv,

    #[error(
        "FRANK_NETWORK_TAG {tag} identifies EVM chain {expected_chain_id}, but \
         registry.monad_mailbox.expected_chain_id is {actual_chain_id}: refusing to start with \
         mismatched Frank-CBOR and transaction networks"
    )]
    NetworkChainMismatch {
        tag: String,
        expected_chain_id: u64,
        actual_chain_id: u64,
    },
}

use self::CashwebdExeError::*;

fn read_conf_contents(conf_path: &str, stdin: &mut impl Read) -> Result<String> {
    let mut conf_contents = String::new();
    if conf_path == "-" {
        stdin
            .read_to_string(&mut conf_contents)
            .wrap_err("Failed to read configuration from stdin")?;
    } else {
        let mut file = std::fs::File::open(conf_path)
            .wrap_err_with(|| OpenConfigFail(conf_path.to_owned()))?;
        file.read_to_string(&mut conf_contents)
            .wrap_err_with(|| ReadConfigFail(conf_path.to_owned()))?;
    }
    Ok(conf_contents)
}

/// Shared endpoint list whose first URL supplies the mailbox when configuration omits `rpc_url`.
const RPC_URL_ENV: &str = "MONAD_TESTNET_HTTP_RPC_URL";
/// Environment variable naming the network every stored/admitted message must carry.
const NETWORK_TAG_ENV: &str = "FRANK_NETWORK_TAG";

fn read_and_validate_conf(
    conf_path: &str,
    stdin: &mut impl Read,
) -> Result<(CashwebdConf, MonadMailboxMode)> {
    read_and_validate_conf_with_env(conf_path, stdin, |name| std::env::var(name).ok())
}

/// Same as [`read_and_validate_conf`] with an injectable environment, so the fail-fast rules are
/// unit-testable without mutating the process environment.
fn read_and_validate_conf_with_env(
    conf_path: &str,
    stdin: &mut impl Read,
    env: impl Fn(&str) -> Option<String>,
) -> Result<(CashwebdConf, MonadMailboxMode)> {
    let conf_contents = read_conf_contents(conf_path, stdin)?;
    let mut conf =
        parse_conf(&conf_contents).wrap_err_with(|| InvalidConfigFail(conf_path.to_owned()))?;
    // The shipped configs enable the mailbox without a URL because the endpoint is secret-bearing:
    // an explicit `rpc_url` wins, otherwise select the first configured endpoint. Validate the
    // complete list while preserving the environment for proxy and topic fallback consumers.
    let mailbox = &mut conf.registry.monad_mailbox;
    if mailbox.enabled && mailbox.rpc_url.is_none() {
        let raw = env(RPC_URL_ENV).filter(|value| !value.trim().is_empty());
        let raw = raw.ok_or(MissingRpcUrlEnv)?;
        let urls = raw
            .split(',')
            .map(|token| token.trim().parse())
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| InvalidRpcUrlEnv)?;
        mailbox.rpc_url = urls.first().cloned();
        if urls
            .iter()
            .any(|url| !matches!(url.scheme(), "http" | "https") || url.host_str().is_none())
        {
            return Err(InvalidRpcUrlEnv.into());
        }
    }
    // Validate the mailbox lifecycle before opening the database or binding a socket. The same
    // typed mode is the serialized seam the HTTP owner will use to omit admission when disabled.
    let mailbox_mode = conf
        .registry
        .monad_mailbox
        .mode()
        .wrap_err("Invalid registry.monad_mailbox configuration")?;
    conf.registry
        .evm_rpc
        .validate()
        .wrap_err("Invalid registry.evm_rpc configuration")?;
    conf.registry
        .bitcoin_proxy
        .validate()
        .wrap_err("Invalid registry.bitcoin_proxy configuration")?;
    conf.registry
        .solana_proxy
        .validate()
        .wrap_err("Invalid registry.solana_proxy configuration")?;
    if let Some(oracle) = &conf.registry.oracle {
        oracle
            .validate()
            .wrap_err("Invalid registry.oracle configuration")?;
    }
    conf.registry
        .validate_rpc_resource_limits()
        .wrap_err("Invalid registry RPC resource limits")?;
    // An enabled mailbox admits only envelopes carrying the relay's network tag; an unset tag would
    // silently reject every direct message, so refuse to start instead.
    let network_tag = env(NETWORK_TAG_ENV);
    if (matches!(mailbox_mode, MonadMailboxMode::Enabled { .. }) || conf.registry.evm_rpc.enabled)
        && !network_tag.as_deref().is_some_and(is_valid_network_tag)
    {
        return Err(MissingNetworkTagEnv.into());
    }
    // A tag that is set must identify one complete deployment (CBOR identifier and EVM chain).
    // An unset tag keeps its existing disabled-mailbox meaning.
    let network = match network_tag.as_deref() {
        Some(tag) => Some(monad_network(tag.as_bytes()).ok_or(UnknownNetworkTagEnv)?),
        None => None,
    };
    if let (
        Some(network),
        MonadMailboxMode::Enabled {
            expected_chain_id, ..
        },
    ) = (network, &mailbox_mode)
    {
        if network.evm_chain_id != *expected_chain_id {
            return Err(NetworkChainMismatch {
                tag: String::from_utf8_lossy(network.network_tag).into_owned(),
                expected_chain_id: network.evm_chain_id,
                actual_chain_id: *expected_chain_id,
            }
            .into());
        }
    }
    Ok((conf, mailbox_mode))
}

#[tokio::main]
async fn main() -> Result<()> {
    let format = fmt::format()
        .with_level(true) // don't include levels in formatted output
        .with_target(false) // don't include targets
        .compact(); // use the `Compact` formatting style.

    tracing_subscriber::fmt().event_format(format).init();
    bitcoinsuite_error::install()?;

    let mut args = std::env::args().skip(1);
    let first_arg = args.next().ok_or(NoConfigFile)?;
    // `--check-db` opens the registry database exactly as a start does and exits: a database
    // from an earlier development build is refused with the same message. The local launcher
    // uses it to move such a database aside before starting; a relay started directly keeps
    // refusing.
    let check_db = first_arg == "--check-db";
    let (check_only, conf_path) = if first_arg == "--check-config" || check_db {
        (!check_db, args.next().ok_or(NoConfigFile)?)
    } else {
        (false, first_arg)
    };
    let (conf, mailbox_mode) = read_and_validate_conf(&conf_path, &mut std::io::stdin().lock())?;
    if check_only {
        return Ok(());
    }
    if let Some(parent) = conf
        .registry
        .db_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).wrap_err_with(|| {
            format!(
                "Creating registry database directory {} failed",
                parent.display()
            )
        })?;
    }
    let db = Db::open(&conf.registry.db_path)?;
    if check_db {
        return Ok(());
    }
    // Challenges, cursors and RPC capabilities are signed with this, so they survive a restart.
    // It lives beside the database, not in it, and is not a wallet key.
    let session_path = conf.registry.db_path.with_extension("session-secret");
    let session = SessionSecret::load_or_create(&session_path)
        .wrap_err_with(|| format!("Reading session secret {}", session_path.display()))?;
    let chain_adapter = match conf.bitcoin_rpc.clone() {
        Some(bitcoin_rpc) => {
            let bitcoind = BitcoindRpcClient::new(bitcoin_rpc);
            Arc::new(LotusAdapter::new(bitcoind))
                as Arc<dyn cashweb_payload::chain_adapter::ChainAdapter>
        }
        None => {
            tracing::event!(
                tracing::Level::WARN,
                "Lotus support is disabled ([bitcoin_rpc] omitted); serving Monad routes only"
            );
            Arc::new(DisabledChainAdapter)
        }
    };

    let event_bus: Arc<dyn cashweb_registry::events::RelayEventBus> =
        if conf.registry.is_nats_enabled() {
            let nats_url = conf.registry.nats_url().unwrap_or("nats://127.0.0.1:4222");
            tracing::info!(
                nats_url = %nats_url,
                "Connecting to Clustered Core NATS notification bus"
            );
            Arc::new(
                cashweb_registry::events::CoreNatsEventBus::connect(nats_url)
                    .await
                    .wrap_err("Failed to connect to Ephemeral Core NATS")?,
            )
        } else {
            tracing::info!("Using standalone in-process notification bus (default)");
            Arc::new(cashweb_registry::events::StandaloneEventBus::new())
        };

    let registry = Arc::new(Registry::new_with_event_bus(
        db,
        chain_adapter,
        conf.registry.net,
        Arc::clone(&event_bus),
    ));
    let evm_rpc_conf = conf.registry.evm_rpc.clone();
    let bitcoin_proxy_conf = conf.registry.bitcoin_proxy.clone();
    let solana_proxy_conf = conf.registry.solana_proxy.clone();
    let monad_mailbox = match mailbox_mode {
        MonadMailboxMode::Disabled => {
            tracing::event!(
                tracing::Level::WARN,
                "Message routes are disabled by configuration: this relay stores and serves no \
                 direct messages"
            );
            MonadMailboxRuntime::Disabled
        }
        MonadMailboxMode::Enabled {
            rpc_url,
            min_value_wei,
            expected_chain_id,
        } => MonadMailboxRuntime::enabled(
            HttpTransport::new(rpc_url),
            MailboxConfig {
                expected_chain_id,
                ..MailboxConfig::default()
            },
            min_value_wei,
            cashweb_registry::network_tag::frank_network_tag().to_vec(),
            &session,
        ),
    };
    let our_peers = conf
        .registry
        .peers
        .into_iter()
        .map(Peer::new)
        .collect::<Vec<_>>();
    let peers = Arc::new(Peers::new_with_public_relays(
        conf.url.to_string(),
        our_peers,
        conf.registry.public_relay_urls,
    ));

    let imd_params = InitialMetadataDownloadParams {
        public_store: PublicFederationStore::new(registry.as_ref()),
        num_sampled_peers: conf.registry.imd.num_sampled_peers,
        timeout_peer: Duration::from_millis(conf.registry.imd.timeout_peer_ms),
        num_failed_for_wait: conf.registry.imd.num_failed_for_wait,
        fail_wait_duration: Duration::from_secs(conf.registry.imd.fail_wait_duration_s),
    };
    let mut rng = rand::thread_rng();
    peers
        .initial_metadata_download(&mut rng, &imd_params)
        .await?;

    // POP (proof-of-payment) protection for the metadata-put endpoint (ticket #4): built once
    // here from real config (`conf.registry.pop`, via `cashweb-config`) rather than lazily from
    // raw env vars (ticket #24's now-removed `PopGate::from_env`/`OnceLock`). An `Err` here still
    // doesn't crash the server at startup -- `RegistryServer::pop_gate` fails every metadata-PUT
    // request closed with a `500` instead (see `http::server::PutRegistryError::PopUnavailable`),
    // same fail-closed principle as before, just built once instead of lazily per request.
    //
    // Ticket #35: if `conf.registry.pop.enabled` is `false` (the hackathon demo default), no gate
    // is built at all (`None`) and every metadata-put request proceeds ungated -- a distinct,
    // intentional state from "built but invalid" (`Some(Err(_))`), which must keep failing closed.
    let pop_gate = Arc::new(PopGate::from_conf_if_enabled(&conf.registry.pop));
    match pop_gate.as_ref() {
        None => {
            tracing::event!(
                tracing::Level::WARN,
                "POP protection is disabled (PopConf::enabled = false); metadata-put requests \
                 require no payment"
            );
        }
        Some(Err(err)) => {
            tracing::event!(
                tracing::Level::ERROR,
                error = %err,
                "POP protection is misconfigured; every metadata-put request will fail closed with a 500 \
                 until this is fixed"
            );
        }
        Some(Ok(_)) => {}
    }

    // Operator-curated default contacts (ticket #49): built once here from real config
    // (`conf.registry.curated_defaults`), same "build once at startup from real config" pattern as
    // `pop_gate` just above. Unlike `pop_gate`, a bad entry here fails startup outright (`wrap_err`
    // below) rather than degrading to a per-request `500` -- there's no legitimate "serve traffic
    // with broken curated-defaults config" state to fall back to, so failing fast on an operator
    // typo is strictly better than shipping it.
    let curated_defaults = Arc::new(
        build_curated_defaults(&conf.registry.curated_defaults)
            .wrap_err("Invalid registry.curated_defaults entry in configuration file")?,
    );
    let evm_rpc = EvmRpcRuntime::from_conf_with_session(
        &evm_rpc_conf,
        cashweb_registry::network_tag::frank_network_tag().to_vec(),
        |name| std::env::var(name).ok(),
        &session,
    )
    .await
    .wrap_err("Starting customer-authenticated EVM RPC proxy")?;
    let bitcoin_proxy = BitcoinProxyRuntime::from_conf_with_session(
        &bitcoin_proxy_conf,
        cashweb_registry::network_tag::frank_network_tag().to_vec(),
        |name| std::env::var(name).ok(),
        &session,
    )
    .await
    .wrap_err("Starting Bitcoin-family RPC/indexer proxy")?;
    let solana_proxy = SolanaProxyRuntime::from_conf_with_session(
        &solana_proxy_conf,
        cashweb_registry::network_tag::frank_network_tag().to_vec(),
        |name| std::env::var(name).ok(),
        &session,
    )
    .await
    .wrap_err("Starting Solana-family JSON-RPC proxy")?;

    let spa_dir = conf.registry.spa_dir.clone().or_else(|| {
        std::env::var("FRANK_RELAY_SPA_DIR")
            .or_else(|_| std::env::var("SIGNET_RELAY_SPA_DIR"))
            .ok()
            .map(std::path::PathBuf::from)
    });
    if let Some(path) = &spa_dir {
        tracing::info!(path = %path.display(), "Serving static SPA files from configured directory");
    }

    let server = RegistryServer {
        registry: Arc::clone(&registry),
        peers: Arc::clone(&peers),
        pop_gate,
        curated_defaults,
        monad_mailbox,
        evm_rpc,
        bitcoin_proxy,
        solana_proxy,
        spa_dir,
        event_bus: Arc::clone(&event_bus),
    };

    let directory = if let Some(config) = conf.registry.directory.clone() {
        config
            .validate()
            .map_err(|error| bitcoinsuite_error::Report::msg(error.to_string()))?;
        let (runtime, ready) = cashweb_registry::directory_runtime::DirectoryRuntime::start(
            Arc::clone(&registry),
            config,
        )
        .map_err(|_| {
            bitcoinsuite_error::Report::msg(
                "registry.directory is invalid: relay_id must be 32 hex characters, \
                 relay_identity a compressed secp256k1 key in hex, endpoint an https origin \
                 without a trailing slash, binding_expiry_ns decimal Unix nanoseconds, \
                 reserved_usernames valid usernames mapped to compressed keys in hex",
            )
        })?;
        let runtime = Arc::new(runtime);
        match ready.await {
            Ok(Ok(())) => Some(runtime),
            _ => {
                runtime.begin_shutdown();
                runtime.wait_stopped().await;
                return Err(bitcoinsuite_error::Report::msg(
                    "Directory could not start: registry.directory.binding_expiry_ns is in the \
                     past or the directory database could not be read",
                ));
            }
        }
    } else {
        None
    };
    // The price and energy oracle is a task of its own: starting it opens its store and
    // touches no network, and nothing here waits for a provider. A store that cannot be opened
    // costs the feed, never the relay: messages are served and the feed path answers 404.
    let oracle = conf.registry.oracle.clone().and_then(|oracle| {
        let started = cashweb_registry::oracle::OracleRuntime::start(
            oracle,
            &conf.registry.db_path,
            |name| std::env::var(name).ok(),
        );
        match started {
            Ok(runtime) => Some(Arc::new(runtime)),
            Err(error) => {
                tracing::error!(
                    store = %conf.registry.db_path.with_extension("oracle-v1").display(),
                    error = %format!("{error:#}"),
                    "The oracle store could not be opened: this relay runs WITHOUT the price \
                     and energy feed (GET /oracle/v1/feed answers 404). Move the store aside \
                     or fix its permissions and restart"
                );
                None
            }
        }
    });
    let router = server.into_router_with_services(directory.clone(), oracle);
    info!("Listening on {}", conf.host);
    let server = axum::Server::bind(&conf.host)
        .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>());
    tokio::pin!(server);
    let server_result = tokio::select! {
        result = &mut server => Some(result),
        _ = shutdown_signal() => None,
    };
    if let Some(runtime) = directory {
        runtime.begin_shutdown();
        // A drain observation timeout is not cancellation: retain the owner and keep waiting.
        if tokio::time::timeout(Duration::from_secs(60), runtime.wait_stopped())
            .await
            .is_err()
        {
            tracing::warn!("Directory owner still draining");
            runtime.wait_stopped().await;
        }
    }
    if let Some(result) = server_result {
        result?;
    }

    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Error, ErrorKind, Read};

    use cashweb_config::MonadMailboxMode;

    use super::{read_and_validate_conf_with_env, read_conf_contents};

    #[test]
    fn reads_configuration_from_stdin_for_dash_path() {
        let mut stdin = Cursor::new(b"host = \"127.0.0.1:8098\"\n");
        let contents = read_conf_contents("-", &mut stdin).expect("stdin config should be read");
        assert_eq!(contents, "host = \"127.0.0.1:8098\"\n");
    }

    #[test]
    fn reports_stdin_read_failure_without_falling_back_to_a_named_file() {
        struct FailingReader;
        impl Read for FailingReader {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                Err(Error::new(ErrorKind::Other, "sentinel stdin failure"))
            }
        }

        let error = read_conf_contents("-", &mut FailingReader)
            .expect_err("stdin failure must stop configuration loading");
        assert!(error
            .to_string()
            .contains("Failed to read configuration from stdin"));
    }

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    const LOCAL: &str = include_str!("../../cashwebd.local.toml");
    const DOCKER: &str = include_str!("../../../docker/cashwebd.toml");
    const FULL_ENV: &[(&str, &str)] = &[
        ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
        ("FRANK_NETWORK_TAG", "MONT"),
    ];

    #[test]
    fn shipped_configs_validate_with_the_required_environment() {
        for (name, config) in [("local", LOCAL), ("docker", DOCKER)] {
            let (conf, mode) =
                read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV))
                    .unwrap_or_else(|err| panic!("{name}: {err:?}"));
            assert!(conf.registry.monad_mailbox.enabled, "{name}");
            let MonadMailboxMode::Enabled { rpc_url, .. } = mode else {
                panic!("{name}: mailbox must stay enabled");
            };
            assert_eq!(rpc_url.as_str(), "http://127.0.0.1:1/", "{name}");
            // The message routes exist only with both the mailbox and the directory configured.
            // Every shipped config has both, so a relay started from one can be messaged
            // through without a launcher adding anything.
            assert!(
                conf.registry.directory.is_some(),
                "{name}: no [registry.directory], so no /message routes"
            );
        }
    }

    #[test]
    fn mailbox_selects_first_endpoint_without_changing_the_shared_environment() {
        let raw = "  https://rpc.example/first-secret?key=first-secret , http://127.0.0.1:2/second-secret  ";
        let vars = [
            ("MONAD_TESTNET_HTTP_RPC_URL", raw),
            ("FRANK_NETWORK_TAG", "MONT"),
        ];
        let shared_env = env(&vars);
        for config in [LOCAL, DOCKER] {
            let (conf, mode) =
                read_and_validate_conf_with_env("-", &mut Cursor::new(config), &shared_env)
                    .expect("a configured endpoint list must select its first endpoint");
            let MonadMailboxMode::Enabled { rpc_url, .. } = mode else {
                panic!("mailbox must stay enabled");
            };
            assert_eq!(
                rpc_url.as_str(),
                "https://rpc.example/first-secret?key=first-secret"
            );
            assert_eq!(conf.registry.monad_mailbox.rpc_url.as_ref(), Some(&rpc_url));
            assert_eq!(
                shared_env("MONAD_TESTNET_HTTP_RPC_URL").as_deref(),
                Some(raw)
            );
            assert_eq!(
                conf.registry.evm_rpc.chains[0].upstream_env,
                "MONAD_TESTNET_HTTP_RPC_URL"
            );
        }
    }

    #[test]
    fn mailbox_rejects_invalid_endpoint_lists_without_exposing_endpoint_secrets() {
        for raw in [
            "https://rpc.example/first-secret,https://:bad/second-secret",
            "https://rpc.example/first-secret,",
            ",https://rpc.example/second-secret",
            "https://rpc.example/first-secret, ,https://rpc.example/second-secret",
            "https://rpc.example/first-secret,file:///second-secret",
            "https://rpc.example/first-secret,not-a-url-second-secret",
            "https://user:password@rpc.example/first-secret,https://:bad/second-secret",
            "",
            "  ",
        ] {
            let vars = [
                ("MONAD_TESTNET_HTTP_RPC_URL", raw),
                ("FRANK_NETWORK_TAG", "MONT"),
            ];
            for config in [LOCAL, DOCKER] {
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(&vars))
                        .expect_err("every configured endpoint must be valid");
                let diagnostic = format!("{error:?}");
                assert!(diagnostic.contains("MONAD_TESTNET_HTTP_RPC_URL"));
                for secret in [
                    "rpc.example",
                    "first-secret",
                    "second-secret",
                    "user",
                    "password",
                ] {
                    assert!(
                        !diagnostic.contains(secret),
                        "endpoint leaked in diagnostic"
                    );
                }
            }
        }
    }

    #[test]
    fn enabled_mailbox_fails_fast_without_rpc_url_or_network_tag() {
        type Case<'a> = (&'a str, &'a [(&'a str, &'a str)], &'a str);
        let cases: [Case; 7] = [
            (
                "no rpc",
                &[("FRANK_NETWORK_TAG", "MONT")],
                "MONAD_TESTNET_HTTP_RPC_URL",
            ),
            (
                "blank rpc",
                &[
                    ("MONAD_TESTNET_HTTP_RPC_URL", "  "),
                    ("FRANK_NETWORK_TAG", "MONT"),
                ],
                "MONAD_TESTNET_HTTP_RPC_URL",
            ),
            (
                "bad scheme",
                &[
                    ("MONAD_TESTNET_HTTP_RPC_URL", "file:///x"),
                    ("FRANK_NETWORK_TAG", "MONT"),
                ],
                "Invalid registry.monad_mailbox configuration",
            ),
            (
                "no tag",
                &[("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1")],
                "FRANK_NETWORK_TAG",
            ),
            (
                "blank tag",
                &[
                    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                    ("FRANK_NETWORK_TAG", " "),
                ],
                "FRANK_NETWORK_TAG",
            ),
            (
                "overlong tag",
                &[
                    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                    ("FRANK_NETWORK_TAG", "0123456789012345678901234567890123"),
                ],
                "FRANK_NETWORK_TAG",
            ),
            (
                "empty tag",
                &[
                    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                    ("FRANK_NETWORK_TAG", ""),
                ],
                "FRANK_NETWORK_TAG",
            ),
        ];
        for (name, config) in [("local", LOCAL), ("docker", DOCKER)] {
            for (case, vars, needle) in cases {
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(vars))
                        .expect_err("must fail fast");
                let text = format!("{error:?}");
                assert!(text.contains(needle), "{name}/{case}: {text}");
            }
        }
    }

    #[test]
    fn a_tag_must_name_a_known_cbor_network_on_the_configured_evm_chain() {
        for config in [LOCAL, DOCKER] {
            for tag in ["MONX", "mont", "TEST"] {
                let vars = [
                    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                    ("FRANK_NETWORK_TAG", tag),
                ];
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(&vars))
                        .expect_err("an unmapped tag must fail startup");
                assert!(format!("{error:?}").contains("no Frank-CBOR network identifier"));
            }
            read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV))
                .expect("MONT and chain 10143 start");

            let mainnet = config
                .replace("id = \"monad-testnet\"", "id = \"monad-mainnet\"")
                .replace("expected_chain_id = 10143", "expected_chain_id = 143")
                .replace(
                    "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9",
                    "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9",
                );
            let mainnet_vars = [
                ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                ("FRANK_NETWORK_TAG", "MON1"),
            ];
            read_and_validate_conf_with_env("-", &mut Cursor::new(&mainnet), env(&mainnet_vars))
                .expect("MON1 and chain 143 start");

            for (tag, needle) in [
                ("MON1", "identifies EVM chain 143"),
                ("MONT", "identifies EVM chain 10143"),
            ] {
                let crossed = if tag == "MON1" {
                    config.to_owned()
                } else {
                    mainnet.clone()
                };
                let vars = [
                    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                    ("FRANK_NETWORK_TAG", tag),
                ];
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(crossed), env(&vars))
                        .expect_err("a crossed tag and chain must fail startup");
                assert!(format!("{error:?}").contains(needle));
            }
        }
        // Also with the mailbox disabled: a set-but-unmapped tag still stamps topic records.
        let disabled = LOCAL.replace("enabled = true", "enabled = false");
        assert!(read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(disabled),
            env(&[("FRANK_NETWORK_TAG", "MONX")])
        )
        .is_err());

        let disabled_mainnet = LOCAL
            .replacen("enabled = true", "enabled = false", 1)
            .replace("id = \"monad-testnet\"", "id = \"monad-mainnet\"")
            .replace("expected_chain_id = 10143", "expected_chain_id = 143")
            .replace(
                "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9",
                "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9",
            );
        read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(disabled_mainnet),
            env(&[("FRANK_NETWORK_TAG", "MONT")]),
        )
        .expect("the relay identity and proxy target chain are independent");

        let two_chains = LOCAL.replace(
            "max_get_logs_range = 10\n\n[registry.pop]",
            "max_get_logs_range = 10\n\n\
[[registry.evm_rpc.chains]]\n\
id = \"monad-mainnet\"\n\
expected_chain_id = 143\n\
upstream_env = \"MONAD_MAINNET_HTTP_RPC_URL\"\n\
checkpoint_block_number = 0\n\
checkpoint_block_hash = \"0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9\"\n\
max_get_logs_range = 10\n\n\
[registry.pop]",
        );
        let (conf, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(two_chains), env(FULL_ENV))
                .expect("one relay may expose multiple canonical EVM target chains");
        assert_eq!(conf.registry.evm_rpc.chains.len(), 2);

        // Retained rows are inert when the EVM proxy is disabled. Operators may stage a future
        // chain or disable a bad upstream without unrelated network-tag validation blocking boot.
        let disabled_evm_mainnet = LOCAL
            .replacen("enabled = true", "enabled = false", 2)
            .replace("id = \"monad-testnet\"", "id = \"monad-mainnet\"")
            .replace("expected_chain_id = 10143", "expected_chain_id = 143")
            .replace(
                "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9",
                "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9",
            );
        read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(disabled_evm_mainnet),
            env(&[("FRANK_NETWORK_TAG", "MONT")]),
        )
        .expect("disabled EVM chain rows must be inert");
    }

    #[test]
    fn disabled_mailbox_needs_no_environment() {
        let disabled = LOCAL.replace("enabled = true", "enabled = false");
        for vars in [
            &[][..],
            &[("MONAD_TESTNET_HTTP_RPC_URL", "invalid-secret,")][..],
        ] {
            let (conf, mode) =
                read_and_validate_conf_with_env("-", &mut Cursor::new(&disabled), env(vars))
                    .expect("a disabled mailbox must not require or parse the RPC URL or tag");
            assert!(matches!(mode, MonadMailboxMode::Disabled));
            assert!(conf.registry.monad_mailbox.rpc_url.is_none());
        }
    }

    #[test]
    fn explicit_rpc_url_in_config_overrides_the_environment() {
        let explicit = LOCAL.replace(
            "enabled = true\n",
            "enabled = true\nrpc_url = \"https://rpc.example\"\n",
        );
        let (_, mode) = read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(explicit),
            env(&[
                ("FRANK_NETWORK_TAG", "MONT"),
                ("MONAD_TESTNET_HTTP_RPC_URL", "invalid-secret,"),
            ]),
        )
        .expect("explicit rpc_url overrides the RPC environment variable");
        let MonadMailboxMode::Enabled { rpc_url, .. } = mode else {
            panic!("mailbox must stay enabled");
        };
        assert_eq!(rpc_url.as_str(), "https://rpc.example/");
    }
}
