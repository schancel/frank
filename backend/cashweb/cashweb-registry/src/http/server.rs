//! Module containing [`RegistryServer`] to run the registry HTTP server.

use crate::{
    http::bitcoin_proxy::{
        issue_chronik_challenge, proxy_chronik, proxy_chronik_capability, BitcoinProxyRuntime,
        BITCOIN_PROXY_CORS_HEADERS,
    },
    http::curated_defaults::{handle_get_curated_default_contacts, CuratedDefaultContact},
    http::error::HttpRegistryError,
    http::evm_rpc::{
        handle_issue_rpc_capability, handle_issue_rpc_capability_challenge,
        handle_issue_rpc_challenge, handle_proxy_rpc, handle_proxy_rpc_capability, handle_proxy_ws,
        EvmRpcRuntime, RPC_CORS_HEADERS,
    },
    http::monad_profile::{
        fetch_profile_raw_or_not_found, handle_get_monad_profile, handle_list_monad_profiles,
        handle_put_monad_profile, handle_search_monad_profiles, BoundedProfileBody,
    },
    http::monad_topics::{
        handle_forum_status, handle_get_monad_topic_post, handle_list_monad_topic_posts,
        handle_list_topics, handle_put_monad_topic_post, handle_put_monad_topic_vote,
    },
    http::pop_protection::{self, MonadReceiptVerifier, PopChallenge, PopGate, PopGateConfigError},
    http::solana_proxy::SolanaProxyRuntime,
    monad_http::{Address as MonadAddress, HttpTransport},
    monad_mailbox::MonadMailboxRuntime,
    p2p::{peers::Peers, relay_info::RelayInfo},
    proto::{self},
    registry::Registry,
};
use axum::{
    extract::{Path, Query},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::from_fn,
    response::{IntoResponse, Response},
    routing, Extension, Json, Router,
};
use bitcoinsuite_core::{Hashed, LotusAddress, LotusAddressError};
use bitcoinsuite_error::{ErrorMeta, Report, Result};
use cashweb_http_utils::protobuf::Protobuf;
use cashweb_payload::proto::SignedPayloadSet;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, collections::HashMap, path::PathBuf, str::FromStr, sync::Arc};
use thiserror::Error;
use tower_http::cors::{Any, CorsLayer};
use tracing::Level;

#[derive(Serialize)]
struct ChainDiscovery {
    schema_version: u32,
    chains: Vec<AdvertisedChain>,
}

#[derive(Serialize)]
struct AdvertisedChain {
    id: String,
    family: cashweb_config::ProtocolChainFamily,
    network: String,
    caip2: Option<String>,
    native_chain_id: Option<String>,
    capabilities: Vec<cashweb_config::ProtocolProxyCapability>,
}

async fn handle_get_chains(Extension(server): Extension<RegistryServer>) -> Json<ChainDiscovery> {
    use cashweb_config::{protocol_chain, ProtocolProxyCapability};

    let mut configured = HashMap::<String, Vec<ProtocolProxyCapability>>::new();
    if let Some(runtime) = &server.evm_rpc {
        for id in runtime.chain_ids() {
            configured.insert(id, vec![ProtocolProxyCapability::JsonRpc]);
        }
    }
    if let Some(runtime) = &server.bitcoin_proxy {
        for (id, json_rpc, chronik, electrum) in runtime.configured_capabilities() {
            let capabilities = configured.entry(id).or_default();
            if json_rpc {
                capabilities.push(ProtocolProxyCapability::JsonRpc);
            }
            if chronik {
                capabilities.push(ProtocolProxyCapability::Chronik);
            }
            if electrum {
                capabilities.push(ProtocolProxyCapability::Electrum);
            }
        }
    }
    if let Some(runtime) = &server.solana_proxy {
        for id in runtime.chain_ids() {
            configured.insert(id, vec![ProtocolProxyCapability::JsonRpc]);
        }
    }
    let mut chains = configured
        .into_iter()
        .filter_map(|(id, capabilities)| {
            let row = protocol_chain(&id)?;
            Some(AdvertisedChain {
                id,
                family: row.family,
                network: row.network.clone(),
                caip2: row.caip2.clone(),
                native_chain_id: row.native_chain_id.clone(),
                capabilities,
            })
        })
        .collect::<Vec<_>>();
    chains.sort_by(|left, right| left.id.cmp(&right.id));
    Json(ChainDiscovery {
        schema_version: 1,
        chains,
    })
}

#[derive(Serialize)]
struct PeerDiscovery {
    relays: Vec<String>,
}

async fn handle_get_peers(Extension(server): Extension<RegistryServer>) -> Json<PeerDiscovery> {
    Json(PeerDiscovery {
        relays: server.peers.public_origins(),
    })
}

#[derive(Deserialize)]
struct MessagesQuery {
    from: Option<i64>,
    to: Option<i64>,
}

/// Provides endpoints to read and write from the Cashweb Registry.
#[derive(Debug, Clone)]
pub struct RegistryServer {
    /// [`Registry`] this server accesses.
    pub registry: Arc<Registry>,
    /// [`Peers`] connected to the server.
    pub peers: Arc<Peers>,
    /// POP (proof-of-payment) protection gate for [`handle_put_registry`] (ticket #4/#24), built
    /// once at construction time from real config (see `http::pop_protection`'s module docs'
    /// "Configuration" section) rather than lazily from raw env vars.
    ///
    /// Ticket #35 adds a third, explicit state on top of #4's fail-closed `Result`, via the outer
    /// `Option` (see [`pop_protection::PopGate::from_conf_if_enabled`], which builds this field):
    ///
    /// - `None`: POP is intentionally disabled (`PopConf::enabled = false`, the hackathon demo
    ///   default) -- [`handle_put_registry`] skips the gate entirely: no token check, no 402
    ///   challenge, the request proceeds as if no gate existed at all.
    /// - `Some(Err(_))`: POP is enabled but this server was constructed with an invalid
    ///   [`cashweb_config::PopConf`]; every metadata-PUT request then fails closed with a `500`
    ///   (see [`PutRegistryError::PopUnavailable`]) rather than silently skipping POP protection.
    /// - `Some(Ok(gate))`: POP is enabled and configured correctly; requests are gated normally.
    ///
    /// These two failure/off states are deliberately kept distinct (`None` vs. `Some(Err(_))`)
    /// rather than collapsed into one -- "disabled" must never be reachable by a config that's
    /// simply broken, and "misconfigured" must never silently degrade into "disabled".
    pub pop_gate:
        Arc<Option<Result<PopGate<MonadReceiptVerifier<HttpTransport>>, PopGateConfigError>>>,
    /// Operator-curated default contacts (ticket #49), parsed once at construction time from
    /// `cashweb_config::RegistryConf::curated_defaults`. Each entry's address is validated as a
    /// real Monad `monad_http::Address` at construction time (fail the whole server startup on a
    /// malformed operator config, rather than silently dropping or 500-ing per-request) -- same
    /// "no silently bad config" principle as the rest of this crate, just without `pop_gate`'s
    /// `None`/disabled state since there's no disabled state here (an empty `Vec` already means
    /// "no curated defaults", no separate on/off flag needed).
    pub curated_defaults: Arc<Vec<CuratedDefaultContact>>,
    /// Validated direct-message mailbox lifecycle. Disabled mode has no admission route.
    pub monad_mailbox: MonadMailboxRuntime,
    /// Optional customer-authenticated EVM proxy runtime. `None` installs no EVM chain routes.
    pub evm_rpc: Option<Arc<EvmRpcRuntime>>,
    /// Optional Bitcoin-family JSON-RPC and Chronik runtime.
    pub bitcoin_proxy: Option<Arc<BitcoinProxyRuntime>>,
    /// Optional Solana JSON-RPC runtime.
    pub solana_proxy: Option<Arc<SolanaProxyRuntime>>,
    /// Optional directory to serve Single Page Application (SPA) static files from.
    pub spa_dir: Option<PathBuf>,
    /// Notification event bus for real-time relay message fan-out (ticket #982 / track C).
    pub event_bus: Arc<dyn crate::events::RelayEventBus>,
}

/// Relevant parts of an HTTP request to put new address metadata.
#[derive(Debug, Clone)]
pub struct PutMetadataRequest {
    /// Address the metadata should be updated for.
    pub address: LotusAddress,
    /// HTTP headers of the PUT request.
    pub header_map: HeaderMap,
    /// Signed serialized [`proto::AddressMetadata`] payload.
    pub signed_metadata: cashweb_payload::proto::SignedPayload,
}

/// Relevant parts of an HTTP request to put new broadcast messages.
#[derive(Debug, Clone)]
pub struct PutMessageRequest {
    /// HTTP headers of the PUT request.
    pub header_map: HeaderMap,
    /// Signed serialized [`proto::AddressMetadata`] payload.
    pub signed_message: cashweb_payload::proto::SignedPayload,
    /// TX ids involved in this particular instance of the message
    pub tx_ids: Vec<Vec<u8>>,
}

/// Errors indicating invalid requests being sent to the Registry endpoint.
#[derive(Debug, Error, ErrorMeta)]
pub enum RegistryServerError {
    /// Invalid lotus address in request.
    #[invalid_user_input()]
    #[error("Invalid lotus address: {0}")]
    InvalidAddress(LotusAddressError),

    /// Address metadata not found in registry.
    #[not_found()]
    #[error("Not found: No address metadata for {0} in registry")]
    AddressMetadataNotFound(LotusAddress),

    /// A query param is not valid.
    #[invalid_client_input()]
    #[error("Invalid {param}: {value:?} is invalid: {msg}")]
    InvalidQueryParam {
        /// Name of the query param in question.
        param: &'static str,
        /// Value provided for the query param.
        value: String,
        /// Why the value is invalid.
        msg: String,
    },
}

use self::RegistryServerError::*;

async fn log_request<B>(
    request: axum::http::Request<B>,
    next: axum::middleware::Next<B>,
) -> axum::response::Response {
    let method = request.method().to_owned();
    let is_pna_requested = request
        .headers()
        .get("access-control-request-private-network")
        .and_then(|v| v.to_str().ok())
        == Some("true");
    let path = safe_log_path(request.uri().path()).into_owned();
    let start = std::time::Instant::now();

    let mut response = next.run(request).await;

    if is_pna_requested {
        response.headers_mut().insert(
            header::HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }

    tracing::event!(
        Level::INFO,
        method = method.as_str(),
        path = path.as_str(),
        // latency = format_args!("{} ms", latency.as_millis()),
        status = response.status().as_u16(),
        duration = format!("{} mcs", start.elapsed().as_micros()),
        "finished processing request"
    );

    response
}

fn safe_log_path(path: &str) -> Cow<'_, str> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match segments.as_slice() {
        ["directory", "v1", _, subject, "head"] if *subject != "address" => {
            Cow::Borrowed("/directory/v1/:network/:subject/head")
        }
        ["directory", "v1", _, _, "statements", _] => {
            Cow::Borrowed("/directory/v1/:network/:subject/statements/:t1")
        }
        ["relay", "v1", "info"] => Cow::Borrowed("/relay/v1/info"),
        ["directory", "v1", _, "address", _] => {
            Cow::Borrowed("/directory/v1/:network/address/:address")
        }
        ["chains"] => Cow::Borrowed("/chains"),
        ["peers"] => Cow::Borrowed("/peers"),
        ["metadata"] => Cow::Borrowed("/metadata"),
        ["metadata", _] => Cow::Borrowed("/metadata/:address"),
        ["metadata", "monad"] => Cow::Borrowed("/metadata/monad"),
        ["metadata", "monad", "curated-defaults"] => {
            Cow::Borrowed("/metadata/monad/curated-defaults")
        }
        ["metadata", "monad", "search"] => Cow::Borrowed("/metadata/monad/search"),
        ["metadata", "monad", _] => Cow::Borrowed("/metadata/monad/:address"),
        ["profiles"] => Cow::Borrowed("/profiles"),
        ["profiles", "curated-defaults"] => Cow::Borrowed("/profiles/curated-defaults"),
        ["profiles", "search"] => Cow::Borrowed("/profiles/search"),
        ["chain-rpc", _, "rpc"] => Cow::Borrowed("/chain-rpc/:chain/rpc"),
        ["chain-rpc", _, "rpc", "auth"] => Cow::Borrowed("/chain-rpc/:chain/rpc/auth"),
        ["chain-rpc", _, "capability"] => Cow::Borrowed("/chain-rpc/:chain/capability"),
        ["chain-rpc", _, "capability", "auth"] => {
            Cow::Borrowed("/chain-rpc/:chain/capability/auth")
        }
        ["chain-rpc", _, "cap", _, "rpc"] => Cow::Borrowed("/chain-rpc/:chain/cap/:capability/rpc"),
        ["chain-rpc", _, "cap", _, "ws"] => Cow::Borrowed("/chain-rpc/:chain/cap/:capability/ws"),
        ["chain-rpc", _, "cap", _, "chronik", ..] => {
            Cow::Borrowed("/chain-rpc/:chain/cap/:capability/chronik/*path")
        }
        ["chain-rpc", _, "chronik", ..] => Cow::Borrowed("/chain-rpc/:chain/chronik/*path"),
        ["chain-rpc", _, "electrum"] => Cow::Borrowed("/chain-rpc/:chain/electrum"),
        ["chain-rpc", _, "chronik-auth", ..] => {
            Cow::Borrowed("/chain-rpc/:chain/chronik-auth/*path")
        }
        ["message"] => Cow::Borrowed("/message"),
        ["message", "auth", _] => Cow::Borrowed("/message/auth/:recipient"),
        ["message", "inbox", _] => Cow::Borrowed("/message/inbox/:recipient"),
        ["message", "mailbox", _] => Cow::Borrowed("/message/mailbox/:address"),
        ["message", "mailbox", _, "ws"] => Cow::Borrowed("/message/mailbox/:address/ws"),
        ["message", "monad", "topics"] => Cow::Borrowed("/message/monad/topics"),
        ["message", "monad", "topics", "vote"] => Cow::Borrowed("/message/monad/topics/vote"),
        ["message", "monad", "topics", "discover"] => {
            Cow::Borrowed("/message/monad/topics/discover")
        }
        ["message", "monad", "topics", "status"] => Cow::Borrowed("/message/monad/topics/status"),
        ["message", "monad", "topics", _] => Cow::Borrowed("/message/monad/topics/:payload_hash"),
        // Unknown paths under this namespace are fail-closed. Routers may percent-decode
        // or normalize segments differently than this logging middleware, so no
        // chain-rpc-shaped miss is allowed to copy attacker-controlled path text to logs.
        _ if segments.iter().any(|segment| *segment == "chain-rpc") => {
            Cow::Borrowed("/chain-rpc/*redacted")
        }
        // Never log an unclassified raw path: percent-encoding and case variants can disguise
        // credential-bearing route segments from a literal matcher.
        _ => Cow::Borrowed("/*redacted"),
    }
}

#[cfg(test)]
mod request_log_tests {
    use super::safe_log_path;

    #[test]
    fn directory_identity_and_evidence_hash_never_enter_request_log_paths() {
        let head = "/directory/v1/sentinel-network/sentinel-principal/head";
        let history = "/directory/v1/sentinel-network/sentinel-principal/statements/sentinel-hash";
        assert_eq!(safe_log_path(head), "/directory/v1/:network/:subject/head");
        assert_eq!(
            safe_log_path(history),
            "/directory/v1/:network/:subject/statements/:t1"
        );
        for path in [
            head,
            history,
            "/directory/v1/sentinel-network/sentinel-principal/unrecognized",
        ] {
            let logged = safe_log_path(path);
            assert!(!logged.contains("sentinel"));
        }
    }

    #[test]
    fn capability_credentials_never_enter_request_log_paths() {
        let token = "sentinel-capability-secret";
        for transport in ["rpc", "ws"] {
            let path = format!("/chain-rpc/monad-testnet/cap/{token}/{transport}");
            let logged = safe_log_path(&path);
            assert!(!logged.contains(token));
            assert_eq!(
                logged,
                format!("/chain-rpc/:chain/cap/:capability/{transport}")
            );
        }
        let chronik_path =
            format!("/chain-rpc/xec-mainnet/cap/{token}/chronik/script/p2pkh/sensitive/utxos");
        let logged = safe_log_path(&chronik_path);
        assert!(!logged.contains(token));
        assert!(!logged.contains("sensitive"));
        assert_eq!(logged, "/chain-rpc/:chain/cap/:capability/chronik/*path");
        for malformed in [
            format!("/chain-rpc/monad-testnet/cap/{token}"),
            format!("/chain-rpc/monad-testnet/cap/{token}/rpc/extra"),
            format!("/chain-rpc/monad-testnet/cap/{token}/unknown"),
            format!("/chain-rpc//monad-testnet/cap/{token}/rpc"),
            format!("/prefix/chain-rpc/monad-testnet/cap/{token}/rpc"),
            format!("/chain-rpc/monad-testnet/c%61p/{token}/rpc"),
            format!("/chain-rpc/monad-testnet/CAP/{token}/rpc"),
            format!("/chain%2Drpc/monad-testnet/cap/{token}/rpc"),
            format!("/CHAIN-RPC/monad-testnet/cap/{token}/rpc"),
        ] {
            let logged = safe_log_path(&malformed);
            assert!(!logged.contains(token));
            assert!(matches!(
                logged.as_ref(),
                "/chain-rpc/*redacted" | "/*redacted"
            ));
        }
        assert_eq!(
            safe_log_path("/chain-rpc/monad-testnet/rpc"),
            "/chain-rpc/:chain/rpc"
        );
        assert_eq!(
            safe_log_path("/message/mailbox/0x08d818283fbf30eae4ff96b7a8428739b2aecb11"),
            "/message/mailbox/:address"
        );
        for path in [
            "/chain-rpc/xec-mainnet/chronik/script/p2pkh/sentinel-wallet/history",
            "/chain-rpc/xec-mainnet/chronik-auth/script/p2pkh/sentinel-wallet/utxos",
        ] {
            let logged = safe_log_path(path);
            assert!(!logged.contains("sentinel-wallet"));
            assert!(logged.ends_with("/*path"));
        }
    }
}

impl RegistryServer {
    /// Notification event bus used for real-time relay message fan-out.
    pub fn event_bus(&self) -> &Arc<dyn crate::events::RelayEventBus> {
        &self.event_bus
    }

    /// Turn this registry server into a [`Router`].
    pub fn into_router(self) -> Router {
        self.into_router_with_directory(None)
    }

    /// Add the explicitly configured directory owner without changing legacy constructors.
    pub fn into_router_with_directory(
        self,
        directory: Option<Arc<crate::directory_runtime::DirectoryRuntime>>,
    ) -> Router {
        let mailbox_enabled = self.monad_mailbox.as_enabled().is_some();
        let canonical_enabled = mailbox_enabled
            && directory.as_ref().is_some_and(|directory| {
                self.registry
                    .canonical_dm()
                    .attach_directory(Arc::clone(directory))
                    .is_ok()
            });
        let rpc_enabled =
            self.evm_rpc.is_some() || self.bitcoin_proxy.is_some() || self.solana_proxy.is_some();
        let bitcoin_proxy_enabled = self.bitcoin_proxy.is_some();
        let router = Router::new()
            .route("/chains", routing::get(handle_get_chains))
            .route("/peers", routing::get(handle_get_peers))
            .route("/metadata", routing::get(handle_get_metadata_range))
            .route(
                "/metadata/:addr",
                routing::put(handle_put_registry).get(handle_get_registry),
            )
            // Monad-native profile registration (ticket #45), additive alongside the Lotus-only
            // route above (a different path depth, so no route-matching conflict) -- see
            // `crate::http::monad_profile`'s module docs for why a Monad address is *also*
            // handled by `handle_put_registry`/`handle_get_registry` themselves (the plain route
            // above), not only here.
            .route(
                "/metadata/monad/:addr",
                routing::put(handle_put_monad_profile).get(handle_get_monad_profile),
            )
            // `GET /metadata/monad?since=<timestamp>` (ticket #75): registration discovery, e.g.
            // for a bot to auto-greet/auto-fund new signups -- see
            // `crate::http::monad_profile`'s module docs. No `:addr` segment, so this can't
            // collide with the route directly above.
            .route("/metadata/monad", routing::get(handle_list_monad_profiles))
            // `GET /metadata/monad/curated-defaults` (ticket #49): the relay's operator-curated
            // default-contacts list -- see `crate::http::curated_defaults`'s module docs for the
            // security-model rationale. A static segment, so axum/matchit matches it in
            // preference to the dynamic `/metadata/monad/:addr` route above -- the exact same
            // static-vs-dynamic precedence already relied on for `/message/monad/topics` vs.
            // `/message/monad/topics/:payload_hash` further below, so there's no routing
            // collision here either.
            .route(
                "/metadata/monad/curated-defaults",
                routing::get(handle_get_curated_default_contacts),
            )
            // `GET /metadata/monad/search?prefix=<text>&limit=<n>` (ticket #48): prefix-search
            // registered profiles by normalized `display_name` -- see
            // `crate::http::monad_profile`'s module docs for the design this implements. Another
            // static segment alongside `/metadata/monad/curated-defaults` above, so the same
            // static-vs-dynamic precedence reasoning already documented there applies here too:
            // this can't collide with the dynamic `/metadata/monad/:addr` route.
            .route(
                "/metadata/monad/search",
                routing::get(handle_search_monad_profiles),
            )
            // Canonical network-agnostic profile endpoints (docs/backend-topology.md)
            .route(
                "/profiles/curated-defaults",
                routing::get(handle_get_curated_default_contacts),
            )
            .route(
                "/profiles/search",
                routing::get(handle_search_monad_profiles),
            )
            .route("/profiles", routing::get(handle_list_monad_profiles))
            // Protobuf topic endpoints are deprecated and dead; canonical CBOR topic
            // endpoints (/message/monad/topics) are the only active routes.
            .route(
                "/messages/:topic",
                routing::any(|| async { StatusCode::GONE }),
            )
            .route("/messages", routing::any(|| async { StatusCode::GONE }))
            .route(
                "/message/:payload_hash",
                routing::any(|| async { StatusCode::GONE }),
            );
        let router = if rpc_enabled {
            router
                .route("/chain-rpc/:chain/rpc", routing::post(handle_proxy_rpc))
                .route(
                    "/chain-rpc/:chain/rpc/auth",
                    routing::post(handle_issue_rpc_challenge),
                )
                .route(
                    "/chain-rpc/:chain/capability/auth",
                    routing::post(handle_issue_rpc_capability_challenge),
                )
                .route(
                    "/chain-rpc/:chain/capability",
                    routing::post(handle_issue_rpc_capability),
                )
                .route(
                    "/chain-rpc/:chain/cap/:capability/rpc",
                    routing::post(handle_proxy_rpc_capability),
                )
                .route(
                    "/chain-rpc/:chain/cap/:capability/ws",
                    routing::get(handle_proxy_ws),
                )
        } else {
            router
        };
        let router = if bitcoin_proxy_enabled {
            router
                .route(
                    "/chain-rpc/:chain/chronik/*path",
                    routing::any(proxy_chronik),
                )
                .route(
                    "/chain-rpc/:chain/electrum",
                    routing::get(crate::http::electrum_proxy::handle_electrum_ws),
                )
                .route(
                    "/chain-rpc/:chain/chronik-auth/*path",
                    routing::post(issue_chronik_challenge),
                )
                .route(
                    "/chain-rpc/:chain/cap/:capability/chronik/*path",
                    routing::any(proxy_chronik_capability),
                )
        } else {
            router
        };
        let mut router = router
            // Monad topic post + burn-weighted vote path (ticket #30), additive alongside
            // the plain Monad-message route above -- see `crate::http::monad_topics`'s module docs.
            // Static segments ("topics", "topics/vote") take priority over the `:payload_hash`
            // wildcard segment at the same position, so these don't conflict with the route
            // above.
            // `GET /message/monad/topics?topic=<topic>&since=<timestamp>` (ticket #40):
            // topic-filtered post listing, added at the same path as the `PUT` above -- the same
            // same-path-different-method precedent as `/message/monad`'s `PUT`/`GET(since=)` pair
            // just above.
            .route(
                "/message/monad/topics",
                routing::put(handle_put_monad_topic_post).get(handle_list_monad_topic_posts),
            )
            .route(
                "/message/monad/topics/vote",
                routing::put(handle_put_monad_topic_vote),
            )
            // `GET /message/monad/topics/discover` (ticket #72): topic-discovery listing -- see
            // `crate::http::monad_topics::handle_list_topics`'s docs. Another static segment at
            // the same path depth as "vote" above, so the same "static segments take priority
            // over the `:payload_hash` wildcard segment at this position" reasoning already
            // documented just above applies here too: this can't be shadowed by, or shadow,
            // `/message/monad/topics/:payload_hash` below.
            .route(
                "/message/monad/topics/discover",
                routing::get(handle_list_topics),
            )
            .route(
                "/message/monad/topics/status",
                routing::post(handle_forum_status),
            )
            .route(
                "/message/monad/topics/:payload_hash",
                routing::get(handle_get_monad_topic_post),
            );
        if canonical_enabled {
            use crate::http::monad_message_cbor::{
                handle_challenge, handle_inbox, handle_mailbox, handle_mailbox_ws, handle_put,
            };
            router = router
                // The one message transport.
                .route(
                    "/message",
                    routing::on(
                        routing::MethodFilter::POST | routing::MethodFilter::PUT,
                        handle_put,
                    ),
                )
                .route("/message/auth/:recipient", routing::post(handle_challenge))
                .route("/message/inbox/:recipient", routing::get(handle_inbox))
                .route("/message/mailbox/:address", routing::get(handle_mailbox))
                .route(
                    "/message/mailbox/:address/ws",
                    routing::get(handle_mailbox_ws),
                );
        }
        if let Some(runtime) = directory {
            router = router
                .merge(crate::http::usernames::router(Arc::clone(&runtime)))
                .merge(crate::http::directory::router(runtime));
        }
        if let Some(spa_dir) = &self.spa_dir {
            use tower_http::services::{ServeDir, ServeFile};
            let index_file = spa_dir.join("index.html");
            let serve_dir = ServeDir::new(spa_dir).fallback(ServeFile::new(index_file));
            router = router.fallback(axum::routing::get_service(serve_dir).handle_error(
                |err: std::io::Error| async move {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Unhandled static file error: {}", err),
                    )
                },
            ));
        }
        router
            .layer(Extension(self))
            .layer(
                CorsLayer::new()
                    .allow_methods([
                        Method::GET,
                        Method::PUT,
                        Method::POST,
                        Method::HEAD,
                        Method::OPTIONS,
                    ])
                    .allow_headers([
                        header::CONTENT_TYPE,
                        header::ACCEPT,
                        header::HeaderName::from_static("x-frank-mailbox-epoch"),
                        header::HeaderName::from_static("x-frank-mailbox-nonce"),
                        header::HeaderName::from_static("x-frank-mailbox-expires-at-ms"),
                        header::HeaderName::from_static("x-frank-mailbox-signature"),
                        header::HeaderName::from_static("x-frank-mailbox-token"),
                        header::HeaderName::from_static("x-frank-mailbox-subject"),
                        header::HeaderName::from_static("x-frank-rpc-subject"),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[0]),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[1]),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[2]),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[3]),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[4]),
                        header::HeaderName::from_static(RPC_CORS_HEADERS[5]),
                        header::HeaderName::from_static(BITCOIN_PROXY_CORS_HEADERS[0]),
                        header::HeaderName::from_static("ngrok-skip-browser-warning"),
                        header::HeaderName::from_static("access-control-request-private-network"),
                    ])
                    .expose_headers([
                        header::CONTENT_TYPE,
                        header::HeaderName::from_static("x-frank-mailbox-next-cursor"),
                        header::HeaderName::from_static("x-frank-directory-evidence"),
                        header::HeaderName::from_static("x-frank-directory-disposition"),
                        header::HeaderName::from_static("x-frank-directory-subject"),
                    ])
                    // Topic list/discovery responses negotiate on Accept. tower-http replaces a
                    // handler's Vary values with this CORS list, so retain its three defaults and
                    // add Accept here rather than silently dropping the cache key.
                    .vary([
                        header::ORIGIN,
                        header::ACCESS_CONTROL_REQUEST_METHOD,
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        header::ACCEPT,
                    ])
                    // allow requests from any origin
                    .allow_origin(Any),
            )
            .layer(from_fn(log_request))
    }
}

/// Response body for a `402`-style POP challenge (see `http::pop_protection`'s module docs for
/// the full request-shape contract this pairs with).
#[derive(Debug, Serialize)]
struct PopChallengeBody {
    error: &'static str,
    reason: &'static str,
    detail: Option<String>,
    /// `0x`-prefixed Monad address the payment must be sent to.
    recipient: String,
    /// Minimum payment amount, in wei, as a decimal string.
    min_value_wei: String,
    how_to_pay: &'static str,
}

impl From<PopChallenge> for PopChallengeBody {
    fn from(challenge: PopChallenge) -> Self {
        let reason = match challenge.reason {
            pop_protection::ChallengeReason::NoTokenOrProof => "no_token_or_proof",
            pop_protection::ChallengeReason::InvalidToken => "invalid_token",
            pop_protection::ChallengeReason::InvalidProof => "invalid_proof",
        };
        PopChallengeBody {
            error: "payment_required",
            reason,
            detail: challenge.detail,
            recipient: challenge.expected.recipient.to_hex(),
            min_value_wei: challenge.expected.min_value_wei.to_string(),
            how_to_pay: "Retry this PUT with query param pop_tx_hash=0x<32-byte Monad tx hash> \
                         once a payment to `recipient` for at least `min_value_wei` confirms. On \
                         success, the response carries an X-Pop-Token header; present it on later \
                         requests to the same address via `Authorization: POP <token>` (or \
                         `?access_token=POP <token>`) instead of paying again.",
        }
    }
}

/// Error type for [`handle_put_registry`]: wraps pre-existing registry/validation errors
/// unchanged, plus this ticket's (#24) new POP-gating outcomes.
#[derive(Debug)]
enum PutRegistryError {
    /// Pre-existing error path (invalid address, relay-info, registry/store errors, ...),
    /// unchanged from before this ticket.
    Registry(HttpRegistryError),
    /// POP protection is misconfigured (see [`RegistryServer::pop_gate`]). Fails closed rather
    /// than silently allowing the request through unauthenticated, since ticket #1 flagged
    /// exactly that (zero gating) as the bug this ticket fixes.
    PopUnavailable(PopGateConfigError),
    /// No valid bearer token or verifying payment proof was presented; challenge the client for
    /// payment.
    PaymentRequired(PopChallenge),
}

impl From<Report> for PutRegistryError {
    fn from(err: Report) -> Self {
        PutRegistryError::Registry(err.into())
    }
}

impl From<RegistryServerError> for PutRegistryError {
    fn from(err: RegistryServerError) -> Self {
        PutRegistryError::Registry(err.into())
    }
}

impl IntoResponse for PutRegistryError {
    fn into_response(self) -> Response {
        match self {
            PutRegistryError::Registry(err) => err.into_response(),
            PutRegistryError::PopUnavailable(err) => {
                tracing::event!(
                    Level::ERROR,
                    error = %err,
                    "POP protection is misconfigured; rejecting metadata-put"
                );
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
            PutRegistryError::PaymentRequired(challenge) => (
                StatusCode::PAYMENT_REQUIRED,
                Json(PopChallengeBody::from(challenge)),
            )
                .into_response(),
        }
    }
}

/// Successful [`handle_put_registry`] response. If this request minted a fresh POP bearer token
/// from an inline payment proof (see `http::pop_protection`'s module docs), it's surfaced via an
/// `X-Pop-Token` response header so the client can reuse it on later requests instead of paying
/// again.
struct PutRegistrySuccess {
    body: proto::PutSignedPayloadResponse,
    issued_token: Option<String>,
}

impl IntoResponse for PutRegistrySuccess {
    fn into_response(self) -> Response {
        let mut response = Protobuf(self.body).into_response();
        if let Some(token) = self.issued_token {
            if let Ok(value) = HeaderValue::from_str(&format!("POP {token}")) {
                response.headers_mut().insert("x-pop-token", value);
            }
        }
        response
    }
}

async fn handle_put_registry(
    Path(address): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    Extension(server): Extension<RegistryServer>,
    header_map: HeaderMap,
    BoundedProfileBody(body_bytes): BoundedProfileBody,
) -> Result<PutRegistrySuccess, PutRegistryError> {
    // Monad-native dispatch (ticket #45): see `crate::http::monad_profile`'s module docs for why
    // a Monad address reaching this historically Lotus-only route must be handled here too, not
    // only at the dedicated `/metadata/monad/:addr` route below -- the real, already-merged TS
    // client this route needs to unblock (`app/src/cashweb/wallet/monad-identity.ts`) calls this
    // plain route with a Monad address, never `/metadata/monad/:addr`. No POP gating on this
    // branch: profile registration was never POP-gated to begin with, and this ticket's non-goals
    // explicitly exclude adding it.
    if let Ok(monad_address) = MonadAddress::from_str(&address) {
        let is_cbor = header_map
            .get(header::CONTENT_TYPE)
            .and_then(|val| val.to_str().ok())
            .map(|ct| ct.starts_with("application/cbor"))
            .unwrap_or(false)
            || crate::store::monad_profiles::is_cbor_frame(&body_bytes);

        if is_cbor {
            server
                .registry
                .put_monad_profile_cbor(monad_address, &body_bytes)?;
        } else {
            let signed_metadata = cashweb_payload::proto::SignedPayload::decode(
                body_bytes.as_ref(),
            )
            .map_err(|err| {
                PutRegistryError::from(Report::from(
                    crate::monad_profile_verify::MonadProfileVerifyError::InvalidProfilePayload(
                        err.to_string(),
                    ),
                ))
            })?;
            server
                .registry
                .put_monad_profile(monad_address, signed_metadata)?;
        }
        return Ok(PutRegistrySuccess {
            body: proto::PutSignedPayloadResponse { txid: vec![] },
            issued_token: None,
        });
    }

    let address = address.parse::<LotusAddress>().map_err(InvalidAddress)?;
    let signed_metadata = cashweb_payload::proto::SignedPayload::decode(body_bytes.as_ref())
        .map_err(|err| {
            PutRegistryError::from(Report::from(
                crate::monad_profile_verify::MonadProfileVerifyError::InvalidProfilePayload(
                    err.to_string(),
                ),
            ))
        })?;

    // --- POP protection (ticket #24, config-wired for real in ticket #4, made toggleable in #35)
    // ---
    // Gate this endpoint behind a valid bearer token, minted from a verified Monad payment --
    // unless POP is explicitly disabled (`PopConf::enabled = false`), in which case the request
    // proceeds immediately, exactly as if this gate didn't exist. This is a genuinely different
    // path from "the gate exists but is misconfigured" (`Some(Err(_))` below), which must keep
    // failing closed with a `500` -- see [`RegistryServer::pop_gate`]'s doc comment.
    //
    // Previously this endpoint had no payment gating at all (ticket #1's finding); see
    // `http::pop_protection`'s module docs for the exact request shape a client uses to present a
    // token or submit a payment proof.
    let issued_token = match server.pop_gate.as_ref() {
        None => None,
        Some(Err(err)) => return Err(PutRegistryError::PopUnavailable(err.clone())),
        Some(Ok(gate)) => {
            let scope = address.as_str().as_bytes();
            pop_protection::authorize_put(gate, scope, &header_map, &query)
                .await
                .map_err(PutRegistryError::PaymentRequired)?
        }
    };
    // --- end POP protection ---

    let request = PutMetadataRequest {
        address,
        header_map,
        signed_metadata,
    };

    let relay_info = RelayInfo::parse_from_headers(&request.header_map)?;
    let result = server
        .registry
        .put_metadata(&request.address, &request.signed_metadata)
        .await?;
    // Relay to peers in a separate task
    tokio::spawn({
        let signed_metadata = result.signed_metadata.clone();
        let peers = Arc::clone(&server.peers);
        async move {
            peers
                .relay_metadata(&relay_info, &request, &signed_metadata)
                .await
        }
    });

    Ok(PutRegistrySuccess {
        body: proto::PutSignedPayloadResponse {
            txid: result
                .txids
                .into_iter()
                .map(|txid| txid.as_slice().to_vec())
                .collect(),
        },
        issued_token,
    })
}

async fn handle_get_registry(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Response, HttpRegistryError> {
    // Monad-native dispatch (ticket #45) -- see `handle_put_registry`'s identical branch, and
    // `crate::http::monad_profile`'s module docs, for why.
    if let Ok(monad_address) = MonadAddress::from_str(&address) {
        let raw = fetch_profile_raw_or_not_found(&server.registry, monad_address)?;
        let content_type = if crate::store::monad_profiles::is_cbor_frame(&raw) {
            "application/cbor"
        } else {
            "application/x-protobuf"
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(axum::body::boxed(axum::body::Body::from(raw)))
            .unwrap();
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
        return Ok(response);
    }

    let address = address.parse::<LotusAddress>().map_err(InvalidAddress)?;
    let signed_payload = server
        .registry
        .get_metadata(&address)?
        .ok_or(AddressMetadataNotFound(address))?;
    Ok(Protobuf(signed_payload.to_proto()).into_response())
}

async fn handle_get_metadata_range(
    Query(params): Query<HashMap<String, String>>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<proto::GetMetadataRangeResponse>, HttpRegistryError> {
    const START_TIMESTAMP: &str = "start_timestamp";
    const END_TIMESTAMP: &str = "end_timestamp";
    const NUM_ITEMS: &str = "num_items";
    const LAST_ADDRESS: &str = "last_address";
    const MAX_NUM_ITEMS: usize = 100;
    let start_timestamp = match params.get(START_TIMESTAMP) {
        Some(start_timestamp) => {
            start_timestamp
                .parse::<i64>()
                .map_err(|err| InvalidQueryParam {
                    param: START_TIMESTAMP,
                    value: start_timestamp.to_string(),
                    msg: err.to_string(),
                })?
        }
        None => 0,
    };
    let end_timestamp = match params.get(END_TIMESTAMP) {
        Some(end_timestamp) => {
            Some(
                end_timestamp
                    .parse::<i64>()
                    .map_err(|err| InvalidQueryParam {
                        param: END_TIMESTAMP,
                        value: end_timestamp.to_string(),
                        msg: err.to_string(),
                    })?,
            )
        }
        None => None,
    };
    let num_items = match params.get(NUM_ITEMS) {
        Some(num_items) => num_items
            .parse::<usize>()
            .map_err(|err| InvalidQueryParam {
                param: NUM_ITEMS,
                value: num_items.to_string(),
                msg: err.to_string(),
            })?
            .min(MAX_NUM_ITEMS),
        None => MAX_NUM_ITEMS,
    };
    let last_address = match params.get(LAST_ADDRESS) {
        Some(last_address) => {
            Some(
                LotusAddress::from_str(last_address).map_err(|err| InvalidQueryParam {
                    param: LAST_ADDRESS,
                    value: last_address.to_string(),
                    msg: err.to_string(),
                })?,
            )
        }
        None => None,
    };
    let metadata_range = server.registry.get_metadata_range(
        start_timestamp,
        end_timestamp,
        last_address.as_ref(),
        num_items,
    )?;
    Ok(Protobuf(proto::GetMetadataRangeResponse {
        entries: metadata_range
            .entries
            .into_iter()
            .map(|(address, signed_payload)| proto::GetMetadataRangeEntry {
                address: address.as_str().to_string(),
                signed_payload: Some(signed_payload.to_proto()),
            })
            .collect(),
    }))
}

#[allow(dead_code)]
#[deprecated(
    note = "Protobuf topic endpoints are deprecated and retired; use /message/monad/topics (CBOR)"
)]
async fn handle_get_messages(
    Path(topic): Path<String>,
    Query(params): Query<MessagesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayloadSet>, HttpRegistryError> {
    let from = params.from.unwrap_or_default();
    let to = params.to.unwrap_or(i64::MAX);

    let signed_payloads = server
        .registry
        .get_messages(topic.as_str(), from, to)?
        .iter()
        .map(|signed_payload| signed_payload.to_proto())
        .collect();

    let payload_page = SignedPayloadSet {
        items: signed_payloads,
    };

    Ok(Protobuf(payload_page))
}

#[allow(dead_code)]
#[deprecated(
    note = "Protobuf topic endpoints are deprecated and retired; use /message/monad/topics (CBOR)"
)]
async fn handle_get_all_messages(
    Query(params): Query<MessagesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayloadSet>, HttpRegistryError> {
    let from = params.from.unwrap_or_default();
    let to = params.to.unwrap_or(i64::MAX);

    let signed_payloads = server
        .registry
        .get_messages("", from, to)?
        .iter()
        .map(|signed_payload| signed_payload.to_proto())
        .collect();

    let payload_page = SignedPayloadSet {
        items: signed_payloads,
    };

    Ok(Protobuf(payload_page))
}

#[allow(dead_code)]
#[deprecated(
    note = "Protobuf topic endpoints are deprecated and retired; use /message/monad/topics (CBOR)"
)]
async fn handle_get_message(
    Path(hex_hash): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> Result<Protobuf<cashweb_payload::proto::SignedPayload>, HttpRegistryError> {
    let payload_hash = hex::decode(&hex_hash).map_err(|err| HttpRegistryError(err.into()))?;
    let message = server.registry.get_message(payload_hash)?;

    Ok(Protobuf(message.to_proto()))
}

#[allow(dead_code)]
#[deprecated(
    note = "Protobuf topic endpoints are deprecated and retired; use /message/monad/topics (CBOR)"
)]
async fn handle_put_message(
    Protobuf(message): Protobuf<cashweb_payload::proto::SignedPayload>,
    Extension(server): Extension<RegistryServer>,
    header_map: HeaderMap,
) -> Result<Protobuf<proto::PutSignedPayloadResponse>, HttpRegistryError> {
    let result = server.registry.put_message(&message).await?;
    let tx_ids: Vec<Vec<u8>> = result
        .txids
        .into_iter()
        .map(|txid| txid.as_slice().to_vec())
        .collect();
    let request = PutMessageRequest {
        header_map,
        signed_message: message,
        tx_ids: tx_ids.clone(),
    };
    let relay_info = RelayInfo::parse_from_headers(&request.header_map)?;

    // Relay to peers in a separate task
    tokio::spawn({
        let peers = Arc::clone(&server.peers);
        async move { peers.relay_message(&relay_info, &request).await }
    });

    Ok(Protobuf(proto::PutSignedPayloadResponse { txid: tx_ids }))
}

#[cfg(test)]
mod spa_tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use bitcoinsuite_core::Net;
    use std::fs;
    use std::sync::Arc;
    use tempdir::TempDir;
    use tower::ServiceExt;

    use super::RegistryServer;
    use crate::{
        disabled_chain_adapter::DisabledChainAdapter, p2p::peers::Peers, registry::Registry,
        store::db::Db,
    };

    fn test_server(spa_dir: Option<std::path::PathBuf>) -> (TempDir, RegistryServer) {
        let tempdir = TempDir::new("cashweb-registry--spa-test").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(DisabledChainAdapter), Net::Regtest);
        let event_bus = registry.event_bus().clone();
        let server = RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(None),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
            solana_proxy: None,
            spa_dir,
            event_bus,
        };
        (tempdir, server)
    }

    async fn response_bytes(response: axum::response::Response) -> Vec<u8> {
        hyper::body::to_bytes(response.into_body())
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn spa_disabled_returns_404_for_unknown_routes() {
        let (_db_dir, server) = test_server(None);
        let router = server.into_router();

        let response = router
            .clone()
            .oneshot(Request::get("/chains").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = router
            .oneshot(
                Request::get("/some/client/route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn spa_enabled_serves_static_assets_and_falls_back_to_index() {
        let spa_dir = TempDir::new("signet-spa").unwrap();
        let index_html = "<!DOCTYPE html><html><body><h1>Signet SPA</h1></body></html>";
        fs::write(spa_dir.path().join("index.html"), index_html).unwrap();

        let assets_dir = spa_dir.path().join("assets");
        fs::create_dir_all(&assets_dir).unwrap();
        fs::write(assets_dir.join("app.js"), "console.log('signet');").unwrap();

        let (_db_dir, server) = test_server(Some(spa_dir.path().to_path_buf()));
        let router = server.into_router();

        // 1. API routes take precedence and are not shadowed
        let response = router
            .clone()
            .oneshot(Request::get("/chains").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // 2. Root serves index.html
        let response = router
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_bytes(response).await;
        assert_eq!(std::str::from_utf8(&body).unwrap(), index_html);

        // 3. Static assets are served directly
        let response = router
            .clone()
            .oneshot(Request::get("/assets/app.js").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_bytes(response).await;
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            "console.log('signet');"
        );

        // 4. Client-side routes (HTML5 history) fall back to index.html
        for client_route in ["/chat", "/chat/0x1234", "/settings/keys", "/profile/edit"] {
            let response = router
                .clone()
                .oneshot(Request::get(client_route).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "Route {client_route} should return 200"
            );
            let body = response_bytes(response).await;
            assert_eq!(std::str::from_utf8(&body).unwrap(), index_html);
        }
    }
}
