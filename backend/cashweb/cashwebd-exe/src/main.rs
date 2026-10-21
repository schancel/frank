use std::{io::Read, net::SocketAddr, sync::Arc, time::Duration};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClient;
use bitcoinsuite_error::{Result, WrapErr};
use cashweb_config::{parse_conf, CashwebdConf, MonadMailboxMode};
use cashweb_registry::{
    chains::RelayChains,
    disabled_chain_adapter::DisabledChainAdapter,
    http::{
        bitcoin_proxy::BitcoinProxyRuntime, curated_defaults::build_curated_defaults,
        evm_rpc::EvmRpcRuntime, monad_topics::ForumRuntime, pop_protection::PopGate,
        server::RegistryServer, solana_proxy::SolanaProxyRuntime,
    },
    lotus_adapter::LotusAdapter,
    monad_mailbox::{MailboxConfig, MonadMailboxRuntime, SessionSecret},
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

fn read_and_validate_conf(
    conf_path: &str,
    stdin: &mut impl Read,
) -> Result<(CashwebdConf, MonadMailboxMode, RelayChains)> {
    read_and_validate_conf_with_env(conf_path, stdin, |name| std::env::var(name).ok())
}

/// Same as [`read_and_validate_conf`] with an injectable environment, so the fail-fast rules are
/// unit-testable without mutating the process environment. Builds the relay's chain adapters
/// from `[registry] network` and the proxy rows, resolving their upstream URLs from the
/// environment, but contacts no upstream: identity is verified when the relay starts.
fn read_and_validate_conf_with_env(
    conf_path: &str,
    stdin: &mut impl Read,
    env: impl Fn(&str) -> Option<String>,
) -> Result<(CashwebdConf, MonadMailboxMode, RelayChains)> {
    let conf_contents = read_conf_contents(conf_path, stdin)?;
    let conf =
        parse_conf(&conf_contents).wrap_err_with(|| InvalidConfigFail(conf_path.to_owned()))?;
    conf.registry
        .validate_cluster()
        .wrap_err("Invalid registry.cluster configuration")?;
    // Validate the mailbox lifecycle before opening the database or binding a socket. The same
    // typed mode is the serialized seam the HTTP owner will use to omit admission when disabled.
    let mailbox_mode = conf
        .registry
        .monad_mailbox
        .mode()
        .wrap_err("Invalid registry.monad_mailbox configuration")?;
    if let Some(oracle) = &conf.registry.oracle {
        oracle
            .validate()
            .wrap_err("Invalid registry.oracle configuration")?;
    }
    conf.registry
        .validate_rpc_resource_limits()
        .wrap_err("Invalid registry RPC resource limits")?;
    // The relay network must be a canonical registry EVM chain; with the mailbox or the forum
    // on, its `[[registry.evm_rpc.chains]]` row must have an upstream. Nothing defaults.
    let chains = RelayChains::from_conf(&conf.registry, env)
        .wrap_err("Invalid relay network or chain configuration")?;
    Ok((conf, mailbox_mode, chains))
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
    let (conf, mailbox_mode, chains) =
        read_and_validate_conf(&conf_path, &mut std::io::stdin().lock())?;
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
    let db = match conf.registry.storage_driver()? {
        cashweb_config::RelayStorageDriver::RocksDb => Db::open(&conf.registry.db_path)?,
    };
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
            // The connection URL may contain a password or token; keep it out of diagnostics.
            tracing::info!("Connecting to Clustered Core NATS notification bus");
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
    // Every upstream proves it is its chain before it carries traffic; startup waits briefly for
    // the first round and the rest are checked again in the background.
    let chains = Arc::new(chains);
    chains.start_verifying().await;
    let network_adapter = || {
        chains.network_adapter().cloned().ok_or_else(|| {
            bitcoinsuite_error::Report::msg(format!(
                "registry.network {} has no [[registry.evm_rpc.chains]] upstream",
                chains.network().id
            ))
        })
    };
    let monad_mailbox = match mailbox_mode {
        MonadMailboxMode::Disabled => {
            tracing::event!(
                tracing::Level::WARN,
                "Message routes are disabled by configuration: this relay stores and serves no \
                 direct messages"
            );
            MonadMailboxRuntime::Disabled
        }
        MonadMailboxMode::Enabled { min_value_wei } => MonadMailboxRuntime::enabled(
            network_adapter()?,
            MailboxConfig::default(),
            min_value_wei,
            &session,
        ),
    };
    let forum = match &conf.registry.forum {
        Some(forum) => Some(Arc::new(
            ForumRuntime::new(network_adapter()?, forum)
                .ok_or_else(|| bitcoinsuite_error::Report::msg("Invalid registry.forum"))?,
        )),
        None => {
            tracing::event!(
                tracing::Level::WARN,
                "Forum routes are disabled ([registry.forum] omitted)"
            );
            None
        }
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
    let evm_rpc = EvmRpcRuntime::new(&conf.registry.evm_rpc, Arc::clone(&chains), &session)
        .wrap_err("Starting customer-authenticated EVM RPC proxy")?;
    let bitcoin_proxy =
        BitcoinProxyRuntime::new(&conf.registry.bitcoin_proxy, Arc::clone(&chains), &session)
            .wrap_err("Starting Bitcoin-family RPC/indexer proxy")?;
    let solana_proxy =
        SolanaProxyRuntime::new(&conf.registry.solana_proxy, Arc::clone(&chains), &session)
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
        chains: Arc::clone(&chains),
        forum,
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
            &chains.network().id,
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
    let metrics_addr = match std::env::var("FRANK_METRICS_HOST") {
        Ok(value) => Some(value.parse::<SocketAddr>().map_err(|error| {
            bitcoinsuite_error::Report::msg(format!("Invalid FRANK_METRICS_HOST: {error}"))
        })?),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => {
            return Err(bitcoinsuite_error::Report::msg(format!(
                "Unable to read FRANK_METRICS_HOST: {error}"
            )))
        }
    };
    let metrics_registry = Arc::clone(&registry);
    let metrics_server = async move {
        if let Some(address) = metrics_addr {
            let metrics_router = cashweb_registry::metrics::router(metrics_registry);
            info!("Listening on private metrics address {}", address);
            axum::Server::bind(&address)
                .serve(metrics_router.into_make_service())
                .await
        } else {
            std::future::pending().await
        }
    };
    tokio::pin!(metrics_server);
    info!("Listening on {}", conf.host);
    let server = axum::Server::bind(&conf.host)
        .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>());
    tokio::pin!(server);
    let server_result = tokio::select! {
        result = &mut server => Some((false, result)),
        result = &mut metrics_server => Some((true, result)),
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
    if let Some((is_metrics_server, result)) = server_result {
        result?;
        if is_metrics_server {
            return Err(bitcoinsuite_error::Report::msg(
                "Private metrics listener stopped unexpectedly",
            ));
        }
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
    /// Every upstream variable the shipped configurations name for an enabled proxy row.
    const FULL_ENV: &[(&str, &str)] = &[
        ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
        ("XEC_TESTNET_CHRONIK_URL", "http://127.0.0.1:2"),
        ("BTC_TESTNET_ELECTRUM_URL", "tcp://127.0.0.1:3"),
        ("BCH_TESTNET_ELECTRUM_URL", "tcp://127.0.0.1:4"),
        ("SOLANA_DEVNET_HTTP_RPC_URL", "http://127.0.0.1:5"),
    ];

    /// `FULL_ENV` with `name` set to `value` (or removed, for `None`).
    fn full_env_with(name: &str, value: Option<&str>) -> Vec<(String, String)> {
        FULL_ENV
            .iter()
            .filter(|(key, _)| *key != name)
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .chain(value.map(|value| (name.to_string(), value.to_string())))
            .collect()
    }

    fn owned_env(pairs: Vec<(String, String)>) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    const SEPOLIA_ROW: &str = "[[registry.evm_rpc.chains]]\n\
id = \"ethereum-sepolia\"\n\
expected_chain_id = 11155111\n\
upstream_env = \"ETHEREUM_SEPOLIA_HTTP_RPC_URL\"\n\
checkpoint_block_number = 0\n\
checkpoint_block_hash = \"0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9\"\n\
max_get_logs_range = 10\n\n\
[registry.pop]";

    #[test]
    fn unsupported_storage_cannot_pass_the_real_startup_configuration_path() {
        for driver in ["foundationdb", "kvrocks", "resp", "rockdsb", ""] {
            let config = format!("{LOCAL}\n[registry.cluster]\ndriver = {driver:?}\n");
            let error = read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(&[]))
                .unwrap_err();
            // Validation runs before RPC environment resolution and before opening any DB.
            assert!(format!("{error:#}").contains("only rocksdb is implemented"));
        }
    }

    #[test]
    fn explicit_rocks_and_core_nats_are_independent_runtime_choices() {
        let config = format!(
            "{LOCAL}\n[registry.cluster]\ndriver = 'rocksdb'\n\
             [registry.cluster.nats]\nenabled = true\nurl = 'nats://localhost:4222'\n"
        );
        let (conf, _, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV)).unwrap();
        assert_eq!(
            conf.registry.storage_driver().unwrap(),
            cashweb_config::RelayStorageDriver::RocksDb
        );
        assert!(conf.registry.is_nats_enabled());
        assert_eq!(conf.registry.nats_url(), Some("nats://localhost:4222"));
    }

    #[test]
    fn disabled_nested_nats_table_wins_over_enabled_legacy_url_at_startup() {
        let config = format!(
            "{LOCAL}\n[registry.cluster]\nenabled = true\ndriver = 'rocksdb'\n\
             nats_url = 'nats://legacy.invalid:4222'\n\
             [registry.cluster.nats]\nenabled = false\nurl = 'invalid-but-disabled'\n"
        );
        let (conf, _, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV)).unwrap();
        assert!(!conf.registry.is_nats_enabled());
        assert_eq!(conf.registry.nats_url(), None);
    }

    #[test]
    fn shipped_configs_validate_with_the_required_environment() {
        for (name, config) in [("local", LOCAL), ("docker", DOCKER)] {
            let (conf, mode, chains) =
                read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV))
                    .unwrap_or_else(|err| panic!("{name}: {err:?}"));
            assert!(
                matches!(mode, MonadMailboxMode::Enabled { .. }),
                "{name}: mailbox must stay enabled"
            );
            assert_eq!(chains.network().id, "monad-testnet", "{name}");
            assert_eq!(chains.network_tag(), b"MONT", "{name}");
            let adapter = chains.network_adapter().expect("the network's EVM adapter");
            assert_eq!(adapter.evm_chain_id(), 10_143, "{name}");
            assert!(conf.registry.forum.is_some(), "{name}");
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
    fn the_relay_network_is_required_and_never_defaults() {
        for config in [LOCAL, DOCKER] {
            let missing = config.replace("network = \"monad-testnet\"\n", "");
            let error =
                read_and_validate_conf_with_env("-", &mut Cursor::new(missing), env(FULL_ENV))
                    .expect_err("a relay without [registry] network must not start");
            assert!(format!("{error:?}").contains("network"), "{error:?}");
            for network in ["monad", "evm", "MONT", "10143", "solana-devnet", "base-sepolia"] {
                let other = config.replace(
                    "network = \"monad-testnet\"\n",
                    &format!("network = {network:?}\n"),
                );
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(other), env(FULL_ENV))
                        .expect_err("an unknown, non-EVM or unproxied network must not start");
                assert!(format!("{error:?}").contains(network), "{network}: {error:?}");
            }
        }
    }

    #[test]
    fn dms_and_the_forum_run_on_any_configured_registry_evm_chain() {
        let sepolia = LOCAL
            .replace("network = \"monad-testnet\"\n", "network = \"ethereum-sepolia\"\n")
            .replacen("[registry.pop]", SEPOLIA_ROW, 1);
        let mut vars = full_env_with("ETHEREUM_SEPOLIA_HTTP_RPC_URL", Some("http://127.0.0.1:6"));
        let (_, mode, chains) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(&sepolia), owned_env(vars.clone()))
                .expect("a relay on ethereum-sepolia starts");
        assert!(matches!(mode, MonadMailboxMode::Enabled { .. }));
        assert_eq!(chains.network().id, "ethereum-sepolia");
        assert_eq!(chains.network_tag(), b"SEPO");
        let adapter = chains.network_adapter().unwrap();
        assert_eq!(adapter.id(), "ethereum-sepolia");
        assert_eq!(adapter.evm_chain_id(), 11_155_111);

        // The mailbox and the forum verify payments only through the network's own upstream.
        vars.retain(|(key, _)| key != "ETHEREUM_SEPOLIA_HTTP_RPC_URL");
        let error =
            read_and_validate_conf_with_env("-", &mut Cursor::new(&sepolia), owned_env(vars))
                .expect_err("no upstream for the relay network");
        assert!(format!("{error:?}").contains("ETHEREUM_SEPOLIA_HTTP_RPC_URL"));
    }

    #[test]
    fn enabled_mailbox_fails_fast_without_a_usable_network_upstream() {
        for value in [None, Some(""), Some("  "), Some("file:///x"), Some("not-a-url")] {
            for (name, config) in [("local", LOCAL), ("docker", DOCKER)] {
                let error = read_and_validate_conf_with_env(
                    "-",
                    &mut Cursor::new(config),
                    owned_env(full_env_with("MONAD_TESTNET_HTTP_RPC_URL", value)),
                )
                .expect_err("must fail fast");
                let text = format!("{error:?}");
                assert!(
                    text.contains("MONAD_TESTNET_HTTP_RPC_URL"),
                    "{name}/{value:?}: {text}"
                );
            }
        }
    }

    #[test]
    fn invalid_endpoint_lists_fail_without_exposing_endpoint_secrets() {
        for raw in [
            "https://rpc.example/first-secret,https://:bad/second-secret",
            "https://rpc.example/first-secret,file:///second-secret",
            "https://rpc.example/first-secret,not-a-url-second-secret",
            "https://user:password@rpc.example/first-secret,https://:bad/second-secret",
        ] {
            for config in [LOCAL, DOCKER] {
                let error = read_and_validate_conf_with_env(
                    "-",
                    &mut Cursor::new(config),
                    owned_env(full_env_with("MONAD_TESTNET_HTTP_RPC_URL", Some(raw))),
                )
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
    fn one_relay_may_proxy_several_evm_chains_beside_its_network() {
        let two_chains = LOCAL.replacen("[registry.pop]", SEPOLIA_ROW, 1);
        let (conf, _, chains) = read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(two_chains),
            owned_env(full_env_with(
                "ETHEREUM_SEPOLIA_HTTP_RPC_URL",
                Some("http://127.0.0.1:6"),
            )),
        )
        .expect("one relay may expose multiple canonical EVM target chains");
        let shipped_rows = LOCAL
            .lines()
            .filter(|line| *line == "[[registry.evm_rpc.chains]]")
            .count();
        assert_eq!(conf.registry.evm_rpc.chains.len(), shipped_rows + 1);
        assert!(chains.evm("ethereum-sepolia").is_some());
        assert_eq!(chains.network().id, "monad-testnet");
        // A row whose variable is unset is not served.
        assert!(chains.evm("base-sepolia").is_none());
    }

    #[test]
    fn a_relay_without_mailbox_or_forum_needs_no_network_upstream() {
        let off = LOCAL
            .replacen("enabled = true", "enabled = false", 1)
            .replace(
                "[registry.forum]\nburn_address = \"0x000000000000000000000000000000000000dEaD\"\n",
                "",
            );
        let (conf, mode, chains) = read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(&off),
            owned_env(full_env_with("MONAD_TESTNET_HTTP_RPC_URL", None)),
        )
        .expect("nothing verifies payments, so the network needs no upstream");
        assert!(matches!(mode, MonadMailboxMode::Disabled));
        assert!(conf.registry.forum.is_none());
        assert_eq!(chains.network().id, "monad-testnet");
        assert!(chains.network_adapter().is_none());
    }
}
