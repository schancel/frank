//! `GET /metadata/monad/curated-defaults` (ticket #49): the relay's operator-curated list of
//! default contacts, advertised to a fresh client so it isn't dropped into an empty contact list
//! on first launch.
//!
//! ## Security model (ticket #49's "reasonably secure manner" question)
//!
//! Deliberately a **plain, unsigned, relay-hosted list** -- option 2 of the three the issue laid
//! out, not a signed bundle (option 1) or a pinned-server-set hybrid (option 3). A curated-default-
//! contacts list is not fund-custody-sensitive: adding a contact to someone's address book doesn't
//! move funds, sign anything, or leak keys. The client already trusts this relay's TLS/domain
//! identity for every profile/message it serves; a relay that wanted to attack a user already has
//! much higher-value avenues (serving a wrong pubkey for a real contact, censoring messages) than
//! adding a fake "official" entry to a suggestions list. This matches `cashweb-config`'s own
//! `RegistryConf::peers: Vec<url::Url>` precedent -- a plain, unsigned, operator-curated list --
//! and deliberately does *not* add a new proto message, signature, or trust primitive.
//!
//! ## Plain JSON, not the crate's protobuf [`cashweb_http_utils::protobuf::Protobuf`] extractor
//!
//! Deliberate, to avoid the proto-codegen/client-sync complexity this crate's other recent
//! tickets have flagged -- this is a small, display-only response shape with no existing proto
//! message of its own, so plain [`axum::Json`] is used instead.
//!
//! ## Routing
//!
//! Registered in `crate::http::server::RegistryServer::into_router` as a static
//! `/metadata/monad/curated-defaults` segment, immediately after the dynamic
//! `/metadata/monad/:addr` route -- see that route registration's comment for why a static segment
//! always wins over a dynamic one at the same position (the same reasoning already spelled out
//! there for `/message/monad/topics` vs. `/message/monad/topics/:payload_hash`).

use std::str::FromStr;

use axum::{Extension, Json};
use thiserror::Error;

use crate::{
    http::server::RegistryServer,
    monad_http::{Address, HexTypeError},
};

/// One operator-curated default contact, parsed once at server-construction time from
/// `cashweb_config::CuratedContactConf` -- see [`crate::http::server::RegistryServer::curated_defaults`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuratedDefaultContact {
    /// Monad address of this curated contact.
    pub address: Address,
    /// Display name shown to the user before they've ever messaged this contact.
    pub name: String,
}

/// Error building [`RegistryServer::curated_defaults`] from
/// `cashweb_config::RegistryConf::curated_defaults` (ticket #49).
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CuratedDefaultsConfigError {
    /// One entry's `address` field wasn't a valid `0x`-prefixed, 20-byte Monad address.
    #[error("Invalid address {address:?} for curated default contact {name:?}: {source}")]
    InvalidAddress {
        /// The offending config entry's raw `address` string.
        address: String,
        /// The offending config entry's `name`, included to help an operator find the typo.
        name: String,
        /// The underlying parse error.
        source: HexTypeError,
    },
}

/// Parse `conf` (`cashweb_config::RegistryConf::curated_defaults`) into
/// [`CuratedDefaultContact`]s, validating every entry's address up front. Fails the whole call on
/// the first malformed entry (naming it in the error) rather than silently dropping it or
/// deferring the failure to request time -- an operator typo in this config should fail server
/// startup with a clear error, not silently drop or 500 per-request (same "no silently bad
/// config" principle as the rest of this crate, e.g. `http::pop_protection::PopGate::from_conf`).
pub fn build_curated_defaults(
    conf: &[cashweb_config::CuratedContactConf],
) -> Result<Vec<CuratedDefaultContact>, CuratedDefaultsConfigError> {
    conf.iter()
        .map(|entry| {
            let address = Address::from_str(&entry.address).map_err(|source| {
                CuratedDefaultsConfigError::InvalidAddress {
                    address: entry.address.clone(),
                    name: entry.name.clone(),
                    source,
                }
            })?;
            Ok(CuratedDefaultContact {
                address,
                name: entry.name.clone(),
            })
        })
        .collect()
}

/// One entry in [`CuratedDefaultContactsResponse`]'s `entries` list.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct CuratedDefaultContactEntry {
    /// `0x`-prefixed, 20-byte Monad address.
    pub address: String,
    /// Display name shown to the user before they've ever messaged this contact.
    pub name: String,
}

/// Response body for `GET /metadata/monad/curated-defaults`.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct CuratedDefaultContactsResponse {
    /// The relay's operator-curated default contacts, in configured order. Empty when the relay
    /// operator hasn't configured any (`cashweb_config::RegistryConf::curated_defaults`'s default).
    pub entries: Vec<CuratedDefaultContactEntry>,
}

/// `GET /metadata/monad/curated-defaults`: return this relay's operator-curated default contacts
/// (see this module's docs for the security-model rationale). Always succeeds -- an empty list is
/// a perfectly valid, un-erroring response (no curated defaults configured).
pub async fn handle_get_curated_default_contacts(
    Extension(server): Extension<RegistryServer>,
) -> Json<CuratedDefaultContactsResponse> {
    let entries = server
        .curated_defaults
        .iter()
        .map(|contact| CuratedDefaultContactEntry {
            address: contact.address.to_hex(),
            name: contact.name.clone(),
        })
        .collect();
    Json(CuratedDefaultContactsResponse { entries })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bitcoinsuite_core::Net;
    use hyper::{Body, Request, StatusCode};
    use tower::ServiceExt;

    use super::*;
    use crate::{
        http::{pop_protection::PopGate, server::RegistryServer},
        p2p::peers::Peers,
        registry::Registry,
        store::db::Db,
        test_instance::placeholder_pop_conf,
    };

    fn addr(byte: u8) -> Address {
        Address([byte; 20])
    }

    fn test_registry() -> (tempdir::TempDir, Registry) {
        use async_trait::async_trait;

        #[derive(Debug)]
        struct UnusedChainAdapter;

        #[async_trait]
        impl cashweb_payload::chain_adapter::ChainAdapter for UnusedChainAdapter {
            async fn submit_tx(
                &self,
                _raw_tx: &[u8],
            ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::SubmitTxOutcome>
            {
                unimplemented!("not used by the curated-defaults route")
            }
            async fn get_tx(
                &self,
                _txid: &bitcoinsuite_core::Sha256d,
            ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
                unimplemented!("not used by the curated-defaults route")
            }
            async fn test_accept(
                &self,
                _raw_tx: &[u8],
            ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::MempoolAcceptResult>
            {
                unimplemented!("not used by the curated-defaults route")
            }
            async fn subscribe_new_blocks(
                &self,
            ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
            {
                unimplemented!("not used by the curated-defaults route")
            }
            fn decode_burn(
                &self,
                _commitment_id: [u8; 4],
                _burn_output_script: &bitcoinsuite_core::Script,
            ) -> bitcoinsuite_error::Result<bitcoinsuite_core::Sha256> {
                unimplemented!("not used by the curated-defaults route")
            }
        }

        let tempdir = tempdir::TempDir::new("cashweb-registry--curated-defaults").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(UnusedChainAdapter), Net::Regtest);
        (tempdir, registry)
    }

    fn test_server(
        registry: Registry,
        curated_defaults: Vec<CuratedDefaultContact>,
    ) -> RegistryServer {
        let pop_gate = PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        let event_bus = registry.event_bus().clone();
        RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            curated_defaults: Arc::new(curated_defaults),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
            solana_proxy: None,
            spa_dir: None,
            event_bus,
        }
    }

    #[tokio::test]
    async fn handler_returns_configured_list() {
        let (_tempdir, registry) = test_registry();
        let curated = vec![
            CuratedDefaultContact {
                address: addr(0x11),
                name: "Welcome Bot".to_string(),
            },
            CuratedDefaultContact {
                address: addr(0x22),
                name: "Support".to_string(),
            },
        ];
        let server = test_server(registry, curated.clone());
        let Json(response) = handle_get_curated_default_contacts(Extension(server)).await;
        assert_eq!(
            response,
            CuratedDefaultContactsResponse {
                entries: vec![
                    CuratedDefaultContactEntry {
                        address: addr(0x11).to_hex(),
                        name: "Welcome Bot".to_string(),
                    },
                    CuratedDefaultContactEntry {
                        address: addr(0x22).to_hex(),
                        name: "Support".to_string(),
                    },
                ],
            }
        );
    }

    #[tokio::test]
    async fn handler_returns_empty_list_when_unconfigured() {
        let (_tempdir, registry) = test_registry();
        let server = test_server(registry, vec![]);
        let Json(response) = handle_get_curated_default_contacts(Extension(server)).await;
        assert_eq!(response, CuratedDefaultContactsResponse { entries: vec![] });
    }

    #[test]
    fn build_curated_defaults_accepts_valid_conf() {
        let conf = vec![
            cashweb_config::CuratedContactConf {
                address: "0x1111111111111111111111111111111111111111".to_string(),
                name: "Welcome Bot".to_string(),
            },
            cashweb_config::CuratedContactConf {
                address: "0x2222222222222222222222222222222222222222".to_string(),
                name: "Support".to_string(),
            },
        ];
        let built = build_curated_defaults(&conf).unwrap();
        assert_eq!(
            built,
            vec![
                CuratedDefaultContact {
                    address: addr(0x11),
                    name: "Welcome Bot".to_string(),
                },
                CuratedDefaultContact {
                    address: addr(0x22),
                    name: "Support".to_string(),
                },
            ]
        );
    }

    #[test]
    fn build_curated_defaults_rejects_malformed_address() {
        let conf = vec![cashweb_config::CuratedContactConf {
            address: "not-an-address".to_string(),
            name: "Welcome Bot".to_string(),
        }];
        let err = build_curated_defaults(&conf).unwrap_err();
        assert_eq!(
            err,
            CuratedDefaultsConfigError::InvalidAddress {
                address: "not-an-address".to_string(),
                name: "Welcome Bot".to_string(),
                source: HexTypeError::InvalidHex("not-an-address".to_string()),
            }
        );
    }

    /// Exercises the *real* router built by [`RegistryServer::into_router`] end-to-end, proving
    /// the routing-precedence reasoning in this module's docs (static
    /// `/metadata/monad/curated-defaults` vs. dynamic `/metadata/monad/:addr`) holds in practice,
    /// not just in theory -- a bare `handle_get_curated_default_contacts` unit test wouldn't catch
    /// a route-registration mistake that let `:addr` swallow this path instead.
    #[tokio::test]
    async fn route_is_not_swallowed_by_dynamic_addr_route() {
        let (_tempdir, registry) = test_registry();
        let curated = vec![CuratedDefaultContact {
            address: addr(0x11),
            name: "Welcome Bot".to_string(),
        }];
        let server = test_server(registry, curated);
        let router = server.into_router();

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/metadata/monad/curated-defaults")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body_bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body: CuratedDefaultContactsResponseDe = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(body.entries.len(), 1);
        assert_eq!(body.entries[0].address, addr(0x11).to_hex());
        assert_eq!(body.entries[0].name, "Welcome Bot");
    }

    /// Deserializable mirror of [`CuratedDefaultContactsResponse`] (which only derives
    /// `Serialize`, since it's a response-only type) -- used solely by
    /// [`route_is_not_swallowed_by_dynamic_addr_route`] to parse the real HTTP response body back.
    #[derive(Debug, serde::Deserialize)]
    struct CuratedDefaultContactsResponseDe {
        entries: Vec<CuratedDefaultContactEntryDe>,
    }

    #[derive(Debug, serde::Deserialize)]
    struct CuratedDefaultContactEntryDe {
        address: String,
        name: String,
    }
}
