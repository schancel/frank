use std::{io::Read, net::SocketAddr, sync::Arc, time::Duration};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClient;
use bitcoinsuite_error::{Result, WrapErr};
use cashweb_config::{parse_conf, CashwebdConf, MonadMailboxMode, RelayStorageDriver};
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
    registry::{Registry, RegistryBackends},
    store::{db::Db, groups::GroupBackend, notification_policy::VapidKeyPair},
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

/// How often this replica tries to take the sweep lease and collect unreferenced objects.
const LARGE_VALUE_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Build the object store for values over the inline limit. Composition is the only reader of
/// the S3 credentials, from `credentials_file` or from the environment.
fn large_value_objects(
    registry: &cashweb_config::RegistryConf,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Arc<dyn cashweb_registry::store::large_values::ObjectStore>> {
    use cashweb_config::{LargeValuesConf, S3Credentials};
    use cashweb_registry::store::{
        blob_store::S3BlobStoreConfig, large_values::LocalFsObjectStore, s3_objects::S3ObjectStore,
    };
    let report = |message: String| bitcoinsuite_error::Report::msg(message);
    match &registry.large_values {
        None => {
            let path = Registry::local_large_values_path(&registry.db_path);
            info!(
                "Large values are stored in the local directory {} (single replica only)",
                path.display()
            );
            Ok(Arc::new(LocalFsObjectStore::new(path)))
        }
        Some(LargeValuesConf::Local { path }) => {
            info!(
                "Large values are stored in the local directory {}",
                path.display()
            );
            Ok(Arc::new(LocalFsObjectStore::new(path)))
        }
        Some(LargeValuesConf::S3 {
            endpoint,
            region,
            bucket,
            prefix,
            credentials_file,
        }) => {
            let credentials =
                match credentials_file {
                    Some(path) => {
                        let text = std::fs::read_to_string(path).wrap_err_with(|| {
                            format!("Reading S3 credentials file {}", path.display())
                        })?;
                        S3Credentials::parse(&text).map_err(|error| {
                            report(format!(
                                "Invalid S3 credentials file {}: {error}",
                                path.display()
                            ))
                        })?
                    }
                    None => match (
                        env("FRANK_S3_ACCESS_KEY_ID"),
                        env("FRANK_S3_SECRET_ACCESS_KEY"),
                    ) {
                        (Some(access_key_id), Some(secret_access_key)) => S3Credentials {
                            access_key_id,
                            secret_access_key,
                        },
                        _ => return Err(report(
                            "[registry.large_values] driver = \"s3\" needs credentials_file, or \
                             FRANK_S3_ACCESS_KEY_ID and FRANK_S3_SECRET_ACCESS_KEY"
                                .into(),
                        )),
                    },
                };
            info!("Large values are stored in S3 bucket {bucket} at {endpoint}");
            let store = S3ObjectStore::new(S3BlobStoreConfig {
                endpoint: endpoint.as_str().trim_end_matches('/').to_string(),
                region: region.clone(),
                bucket: bucket.clone(),
                prefix: prefix.clone(),
                access_key_id: credentials.access_key_id,
                secret_access_key: credentials.secret_access_key,
                force_path_style: true,
            })
            .map_err(|error| report(error.to_string()))?;
            Ok(Arc::new(store))
        }
    }
}

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

fn main() -> Result<()> {
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
    let driver = conf.registry.storage_driver()?;
    // The FDB client network is process-wide: boot it once, before any store opens, and stop it
    // only after the runtime and every blocking worker that may call a store have finished.
    let fdb_network = boot_fdb_network(&driver)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .wrap_err("Starting the async runtime")?;
    let result = runtime.block_on(run(conf, mailbox_mode, chains, driver, check_db));
    runtime.shutdown_timeout(Duration::from_secs(30));
    drop(fdb_network);
    result
}

#[cfg(feature = "foundationdb")]
type FdbNetwork = cashweb_registry::store::foundationdb_driver::FdbNetwork;
#[cfg(not(feature = "foundationdb"))]
type FdbNetwork = ();

fn boot_fdb_network(driver: &RelayStorageDriver) -> Result<Option<FdbNetwork>> {
    match driver {
        RelayStorageDriver::RocksDb => Ok(None),
        #[cfg(feature = "foundationdb")]
        RelayStorageDriver::FoundationDb { .. } => {
            // SAFETY: called once, from `main`, which drops the guard after the runtime.
            Ok(Some(unsafe { FdbNetwork::boot() }))
        }
        #[cfg(not(feature = "foundationdb"))]
        RelayStorageDriver::FoundationDb { .. } => Err(bitcoinsuite_error::Report::msg(
            "registry.cluster.driver = \"foundationdb\" needs a cashwebd-exe built with \
             `--features foundationdb` (which links the FoundationDB 7.3 client library)",
        )),
    }
}

/// The group backend selected by `registry.cluster.driver`. FoundationDB keys live under
/// `<fdb_subspace_prefix>groups-v1/`, so later owners can take their own sub-prefixes.
fn group_backend(
    driver: &RelayStorageDriver,
    registry_db: &std::path::Path,
) -> Result<GroupBackend> {
    match driver {
        RelayStorageDriver::RocksDb => Ok(GroupBackend::rocksdb_beside(registry_db)),
        #[cfg(feature = "foundationdb")]
        RelayStorageDriver::FoundationDb {
            cluster_file,
            subspace_prefix,
        } => {
            let cluster_file = cluster_file.to_str().ok_or_else(|| {
                bitcoinsuite_error::Report::msg("registry.cluster.fdb_cluster_file is not UTF-8")
            })?;
            let store = cashweb_registry::store::foundationdb_driver::FoundationDbKvStore::open(
                cluster_file,
                format!("{subspace_prefix}groups-v1/"),
            )
            .map_err(|error| {
                bitcoinsuite_error::Report::msg(format!("Opening FoundationDB: {error}"))
            })?;
            Ok(GroupBackend::Shared(Arc::new(store)))
        }
        #[cfg(not(feature = "foundationdb"))]
        RelayStorageDriver::FoundationDb { .. } => unreachable!("refused by boot_fdb_network"),
    }
}

/// Log the cluster shape once at startup: the shared backend and every owner whose state still
/// lives on this replica. Validation already refused cluster mode without the preview flag.
fn log_cluster_shape(registry: &cashweb_config::RegistryConf, driver: &RelayStorageDriver) {
    if let RelayStorageDriver::FoundationDb {
        subspace_prefix, ..
    } = driver
    {
        info!(
            subspace_prefix = %subspace_prefix,
            "Groups are stored in FoundationDB under {subspace_prefix}groups-v1/"
        );
    }
    if !registry.is_cluster_mode() {
        return;
    }
    let owners = registry.replica_local_owners();
    tracing::warn!(
        count = owners.len(),
        "Cluster preview (registry.cluster.preview_replica_local_owners): {} enabled owner(s) \
         still keep their state on this replica; replicas do not share it",
        owners.len()
    );
    for owner in owners {
        tracing::warn!(
            owner = owner.name(),
            "Replica-local owner: {}",
            owner.name()
        );
    }
}

async fn run(
    conf: CashwebdConf,
    mailbox_mode: MonadMailboxMode,
    chains: RelayChains,
    driver: RelayStorageDriver,
    check_db: bool,
) -> Result<()> {
    // Operator-provisioned identity files are read, never created, and before any state opens:
    // a replica with a missing or wrong file fails without touching its disk.
    let provisioned_session = conf
        .registry
        .session_secret_file
        .as_deref()
        .map(|path| {
            SessionSecret::load_provisioned(path).wrap_err_with(|| {
                format!("Reading registry.session_secret_file {}", path.display())
            })
        })
        .transpose()?;
    let provisioned_vapid = conf
        .registry
        .vapid_private_key_file
        .as_deref()
        .map(VapidKeyPair::load_provisioned)
        .transpose()
        .map_err(|error| {
            bitcoinsuite_error::Report::msg(format!("registry.vapid_private_key_file: {error}"))
        })?;
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
    log_cluster_shape(&conf.registry, &driver);
    let groups = group_backend(&driver, &conf.registry.db_path)?;
    // Challenges, cursors and RPC capabilities are signed with this, so they survive a restart.
    // A single node keeps it beside the database (not in it); it is not a wallet key.
    let session = match provisioned_session {
        Some(session) => session,
        None => {
            let session_path = conf.registry.db_path.with_extension("session-secret");
            SessionSecret::load_or_create(&session_path)
                .wrap_err_with(|| format!("Reading session secret {}", session_path.display()))?
        }
    };
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
        if let (Some(nats_url), Some(cluster)) =
            (conf.registry.nats_url(), conf.registry.nats_cluster_name())
        {
            // The connection URL may contain a password or token; keep it out of diagnostics.
            tracing::info!(
                cluster,
                "Connecting to Clustered Core NATS notification bus (subjects frank.{cluster}.…)"
            );
            Arc::new(
                cashweb_registry::events::CoreNatsEventBus::connect(nats_url, cluster)
                    .await
                    .wrap_err("Failed to connect to Ephemeral Core NATS")?,
            )
        } else {
            tracing::info!("Using standalone in-process notification bus (default)");
            Arc::new(cashweb_registry::events::StandaloneEventBus::new())
        };

    let objects = large_value_objects(&conf.registry, |name| std::env::var(name).ok())?;
    let registry = Arc::new(Registry::new_with_event_bus(
        db,
        chain_adapter,
        conf.registry.net,
        Arc::clone(&event_bus),
        RegistryBackends {
            groups,
            objects,
            group_policy: conf.registry.groups,
            provisioned_vapid,
        },
    ));
    if matches!(driver, RelayStorageDriver::FoundationDb { .. }) {
        // Fail the start, not the first request, when the cluster cannot be read.
        let probe = Arc::clone(&registry);
        tokio::time::timeout(
            Duration::from_secs(30),
            tokio::task::spawn_blocking(move || probe.check_group_store()),
        )
        .await
        .map_err(|_| {
            bitcoinsuite_error::Report::msg("FoundationDB did not answer within 30 seconds")
        })?
        .wrap_err("FoundationDB probe task failed")?
        .map_err(|error| {
            bitcoinsuite_error::Report::msg(format!(
                "Reading the FoundationDB group store: {error}"
            ))
        })?;
        info!("FoundationDB group store is readable");
    }
    // Collect unreferenced large values. Replicas compete for one lease; the others skip.
    {
        let registry = Arc::clone(&registry);
        let holder: [u8; 16] = rand::random();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(LARGE_VALUE_SWEEP_INTERVAL);
            loop {
                interval.tick().await;
                let registry = Arc::clone(&registry);
                let sweep =
                    tokio::task::spawn_blocking(move || registry.sweep_large_values(holder));
                match sweep.await {
                    Ok(Ok(report)) if report.deleted > 0 => {
                        info!("Large-value sweep deleted {} objects", report.deleted)
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => tracing::warn!("Large-value sweep failed: {error}"),
                    Err(error) => tracing::warn!("Large-value sweep panicked: {error}"),
                }
            }
        });
    }
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
        for driver in ["kvrocks", "resp", "rockdsb", "", "FoundationDB"] {
            let config = format!("{LOCAL}\n[registry.cluster]\ndriver = {driver:?}\n");
            let error = read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(&[]))
                .unwrap_err();
            // Validation runs before RPC environment resolution and before opening any DB.
            assert!(
                format!("{error:#}").contains("registry.cluster.driver is unsupported"),
                "{driver}: {error:#}"
            );
        }
    }

    #[test]
    fn the_foundationdb_driver_carries_its_cluster_file_and_prefix_to_composition() {
        let config = format!(
            "{LOCAL}\n[registry.cluster]\ndriver = 'foundationdb'\n\
             fdb_cluster_file = '/cluster/fdb.cluster'\nfdb_subspace_prefix = 'frank-lab/'\n"
        );
        let (conf, _, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV)).unwrap();
        assert_eq!(
            conf.registry.storage_driver().unwrap(),
            cashweb_config::RelayStorageDriver::FoundationDb {
                cluster_file: "/cluster/fdb.cluster".into(),
                subspace_prefix: "frank-lab/".into(),
            }
        );
        let missing = format!("{LOCAL}\n[registry.cluster]\ndriver = 'foundationdb'\n");
        let error =
            read_and_validate_conf_with_env("-", &mut Cursor::new(missing), env(&[])).unwrap_err();
        assert!(format!("{error:#}").contains("requires fdb_cluster_file"));
    }

    #[test]
    fn explicit_rocks_and_core_nats_are_independent_runtime_choices() {
        let config = format!(
            "{LOCAL}\n[registry.cluster]\ndriver = 'rocksdb'\ncluster_name = 'local'\n\
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
        assert_eq!(conf.registry.nats_cluster_name(), Some("local"));
        // NATS subjects are namespaced by cluster, so an unnamed bus is refused.
        let unnamed = format!(
            "{LOCAL}\n[registry.cluster]\ndriver = 'rocksdb'\n\
             [registry.cluster.nats]\nenabled = true\nurl = 'nats://localhost:4222'\n"
        );
        let error = read_and_validate_conf_with_env("-", &mut Cursor::new(unnamed), env(FULL_ENV))
            .unwrap_err();
        assert!(format!("{error:#}").contains("cluster_name"), "{error:#}");
    }

    #[test]
    fn disabled_nested_nats_table_wins_over_enabled_legacy_url_at_startup() {
        let single = format!(
            "{LOCAL}\n[registry.cluster]\ndriver = 'rocksdb'\n\
             nats_url = 'nats://legacy.invalid:4222'\n\
             [registry.cluster.nats]\nenabled = false\nurl = 'invalid-but-disabled'\n"
        );
        let (conf, _, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(single), env(FULL_ENV)).unwrap();
        assert!(!conf.registry.is_nats_enabled());
        assert_eq!(conf.registry.nats_url(), None);
        // In cluster mode the legacy URL still does not revive the bus, and no bus is refused.
        let clustered = format!(
            "{LOCAL}\n[registry.cluster]\nenabled = true\ndriver = 'rocksdb'\n\
             nats_url = 'nats://legacy.invalid:4222'\n\
             [registry.cluster.nats]\nenabled = false\nurl = 'invalid-but-disabled'\n"
        );
        let error =
            read_and_validate_conf_with_env("-", &mut Cursor::new(clustered), env(FULL_ENV))
                .unwrap_err();
        assert!(
            format!("{error:#}").contains("requires an enabled [registry.cluster.nats] bus"),
            "{error:#}"
        );
    }

    #[test]
    fn cluster_mode_names_every_replica_local_owner_unless_previewed() {
        let cluster = "[registry.cluster]\nenabled = true\ndriver = 'foundationdb'\n\
             fdb_cluster_file = '/cluster/fdb.cluster'\nfdb_subspace_prefix = 'frank/'\n\
             cluster_name = 'lab'\n";
        let nats = "[registry.cluster.nats]\nenabled = true\nurl = 'nats://nats:4222'\n";
        let secrets =
            "[registry]\nsession_secret_file = '/run/s'\nvapid_private_key_file = '/run/v'\n";
        let base = LOCAL.replacen("[registry]\n", secrets, 1);
        let refused = format!("{base}\n{cluster}{nats}");
        let error = read_and_validate_conf_with_env("-", &mut Cursor::new(&refused), env(FULL_ENV))
            .unwrap_err();
        let text = format!("{error:#}");
        for owner in [
            "registry database",
            "direct messages",
            "directory",
            "forum",
            "hourly RPC proxy quotas",
        ] {
            assert!(text.contains(owner), "{owner}: {text}");
        }
        // Groups are on FoundationDB here, so they are not replica-local.
        assert!(!text.contains("groups"), "{text}");
        let previewed = format!("{base}\n{cluster}preview_replica_local_owners = true\n{nats}");
        let (conf, _, _) =
            read_and_validate_conf_with_env("-", &mut Cursor::new(previewed), env(FULL_ENV))
                .unwrap();
        assert!(conf.registry.is_cluster_mode());
        assert_eq!(conf.registry.replica_local_owners().len(), 5);
        // Without the provisioned files, cluster mode never falls back to generated ones.
        let unprovisioned =
            format!("{LOCAL}\n{cluster}preview_replica_local_owners = true\n{nats}");
        let error =
            read_and_validate_conf_with_env("-", &mut Cursor::new(unprovisioned), env(FULL_ENV))
                .unwrap_err();
        assert!(format!("{error:#}").contains("session_secret_file"));
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
            for network in [
                "monad",
                "evm",
                "MONT",
                "10143",
                "solana-devnet",
                "base-sepolia",
            ] {
                let other = config.replace(
                    "network = \"monad-testnet\"\n",
                    &format!("network = {network:?}\n"),
                );
                let error =
                    read_and_validate_conf_with_env("-", &mut Cursor::new(other), env(FULL_ENV))
                        .expect_err("an unknown, non-EVM or unproxied network must not start");
                assert!(
                    format!("{error:?}").contains(network),
                    "{network}: {error:?}"
                );
            }
        }
    }

    #[test]
    fn dms_and_the_forum_run_on_any_configured_registry_evm_chain() {
        let sepolia = LOCAL
            .replace(
                "network = \"monad-testnet\"\n",
                "network = \"ethereum-sepolia\"\n",
            )
            .replacen("[registry.pop]", SEPOLIA_ROW, 1);
        let mut vars = full_env_with("ETHEREUM_SEPOLIA_HTTP_RPC_URL", Some("http://127.0.0.1:6"));
        let (_, mode, chains) = read_and_validate_conf_with_env(
            "-",
            &mut Cursor::new(&sepolia),
            owned_env(vars.clone()),
        )
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
        for value in [
            None,
            Some(""),
            Some("  "),
            Some("file:///x"),
            Some("not-a-url"),
        ] {
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

    #[test]
    fn s3_large_values_need_credentials_from_a_file_or_the_environment() {
        use super::large_value_objects;
        let s3 = "[registry.large_values]\ndriver = \"s3\"\nendpoint = \"http://127.0.0.1:9\"\n\
                  region = \"us-east-1\"\nbucket = \"frank\"\n";
        let parse = |extra: &str| {
            let config = format!("{LOCAL}\n{s3}{extra}");
            read_and_validate_conf_with_env("-", &mut Cursor::new(config), env(FULL_ENV))
                .unwrap()
                .0
        };
        let conf = parse("");
        let error = large_value_objects(&conf.registry, |_| None).unwrap_err();
        assert!(format!("{error:#}").contains("FRANK_S3_ACCESS_KEY_ID"));
        assert!(large_value_objects(&conf.registry, |name| match name {
            "FRANK_S3_ACCESS_KEY_ID" => Some("id".into()),
            "FRANK_S3_SECRET_ACCESS_KEY" => Some("secret".into()),
            _ => None,
        })
        .is_ok());

        let dir = tempdir::TempDir::new("s3-credentials").unwrap();
        let file = dir.path().join("s3.toml");
        let conf = parse(&format!(
            "credentials_file = {:?}\n",
            file.display().to_string()
        ));
        assert!(large_value_objects(&conf.registry, |_| None).is_err());
        std::fs::write(
            &file,
            "access_key_id = \"id\"\nsecret_access_key = \"hunter2\"\n",
        )
        .unwrap();
        assert!(large_value_objects(&conf.registry, |_| None).is_ok());
        std::fs::write(&file, "access_key_id = \"id\"\nsecret = \"hunter2\"\n").unwrap();
        let error = format!(
            "{:#}",
            large_value_objects(&conf.registry, |_| None).unwrap_err()
        );
        assert!(!error.contains("hunter2"), "{error}");
    }
}
