use std::{io::Read, sync::Arc, time::Duration};

use bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClient;
use bitcoinsuite_error::{Result, WrapErr};
use cashweb_config::parse_conf;
use cashweb_registry::{
    disabled_chain_adapter::DisabledChainAdapter,
    http::{
        curated_defaults::build_curated_defaults, pop_protection::PopGate, server::RegistryServer,
    },
    lotus_adapter::LotusAdapter,
    monad_http::HttpTransport,
    monad_outbox::{start_monad_outbox_worker, MonadOutboxReconcileConfig, MonadOutboxWorker},
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
    #[error("No configuration file provided. Specify like this: cargo run -- <config path>")]
    NoConfigFile,

    #[error("Opening configuration file {0} failed")]
    OpenConfigFail(String),

    #[error("Failed to read configuration file {0}")]
    ReadConfigFail(String),

    #[error("Invalid configuration file {0}")]
    InvalidConfigFail(String),
}

use self::CashwebdExeError::*;

#[tokio::main]
async fn main() -> Result<()> {
    let format = fmt::format()
        .with_level(true) // don't include levels in formatted output
        .with_target(false) // don't include targets
        .compact(); // use the `Compact` formatting style.

    tracing_subscriber::fmt().event_format(format).init();
    bitcoinsuite_error::install()?;

    let conf_path = std::env::args().nth(1).ok_or(NoConfigFile)?;
    let mut file =
        std::fs::File::open(&conf_path).wrap_err_with(|| OpenConfigFail(conf_path.clone()))?;
    let mut conf_contents = String::new();
    file.read_to_string(&mut conf_contents)
        .wrap_err_with(|| ReadConfigFail(conf_path.clone()))?;
    let conf = parse_conf(&conf_contents).wrap_err_with(|| InvalidConfigFail(conf_path.clone()))?;

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

    let registry = Arc::new(Registry::new(db, chain_adapter, conf.registry.net));
    let outbox_worker: Option<MonadOutboxWorker> = match std::env::var(
        "CASHWEB_MONAD_OUTBOX_RECONCILIATION_ENABLED",
    )
    .ok()
    .as_deref()
    {
        Some("0" | "false" | "off") => {
            tracing::event!(
                tracing::Level::WARN,
                "Monad outbox startup reconciliation is explicitly disabled; durable records remain readable"
            );
            None
        }
        _ => match std::env::var("MONAD_TESTNET_HTTP_RPC_URL") {
            Ok(value) => match value.parse() {
                Ok(rpc_url) => Some(start_monad_outbox_worker(
                    HttpTransport::new(rpc_url),
                    Arc::clone(&registry),
                    MonadOutboxReconcileConfig::default(),
                )),
                Err(err) => {
                    tracing::event!(
                        tracing::Level::ERROR,
                        error = %err,
                        "Monad outbox startup reconciliation is unavailable: MONAD_TESTNET_HTTP_RPC_URL is invalid"
                    );
                    None
                }
            },
            Err(err) => {
                tracing::event!(
                    tracing::Level::ERROR,
                    error = %err,
                    "Monad outbox startup reconciliation is unavailable: MONAD_TESTNET_HTTP_RPC_URL is unset"
                );
                None
            }
        },
    };
    let our_peers = conf
        .registry
        .peers
        .into_iter()
        .map(Peer::new)
        .collect::<Vec<_>>();
    let peers = Arc::new(Peers::new(conf.url.to_string(), our_peers));

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

    let server = RegistryServer {
        registry: Arc::clone(&registry),
        peers: Arc::clone(&peers),
        pop_gate,
        curated_defaults,
    };

    let router = server.into_router();
    info!("Listening on {}", conf.host);
    let server_result = axum::Server::bind(&conf.host)
        .serve(router.into_make_service())
        .await;
    if let Some(worker) = outbox_worker {
        worker.shutdown().await;
    }
    server_result?;

    Ok(())
}
