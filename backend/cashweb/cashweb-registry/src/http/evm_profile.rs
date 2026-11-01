//! EVM-addressed profile HTTP routes: submit, fetch, list and prefix search.
//!
//! The registry owns validation and transactional indexes. Existing public URL paths and
//! response encodings remain unchanged; this is source naming, not a protocol migration.

use std::str::FromStr;

use axum::body::Body;
use axum::{
    extract::{Path, Query},
    http::{
        header::{HeaderMap, HeaderValue, CONTENT_TYPE},
        StatusCode,
    },
    response::{IntoResponse, Response},
    Extension,
};
use bitcoinsuite_error::{ErrorMeta, Report, Result};
use cashweb_http_utils::protobuf::Protobuf;
use prost::Message;
use serde::Deserialize;
use thiserror::Error;
use tracing::Level;

use crate::{
    evm_rpc::{Address, HexTypeError},
    http::{error::HttpRegistryError, server::RegistryServer},
    proto,
    registry::Registry,
};

/// Maximum accepted payload size for Monad profile registration (1 MiB),
/// matching the CBOR validation route byte limit.
pub const MAX_PROFILE_PAYLOAD_BYTES: usize = 1_048_576;

/// A raw request body bounded to [`MAX_PROFILE_PAYLOAD_BYTES`] before reading into memory,
/// protecting against unauthenticated OOM without requiring a Content-Length header.
#[derive(Debug)]
pub struct BoundedProfileBody(pub axum::body::Bytes);

#[async_trait::async_trait]
impl axum::extract::FromRequest<axum::body::Body> for BoundedProfileBody {
    type Rejection = (StatusCode, &'static str);

    async fn from_request(
        req: &mut axum::extract::RequestParts<axum::body::Body>,
    ) -> std::result::Result<Self, Self::Rejection> {
        use axum::body::HttpBody;
        let mut body = req
            .take_body()
            .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "body already taken"))?;
        let mut body_bytes = Vec::new();
        while let Some(chunk_result) = body.data().await {
            let chunk = chunk_result
                .map_err(|_| (StatusCode::BAD_REQUEST, "failed to read request body"))?;
            if body_bytes.len().saturating_add(chunk.len()) > MAX_PROFILE_PAYLOAD_BYTES {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "profile payload exceeds 1 MiB limit",
                ));
            }
            body_bytes.extend_from_slice(&chunk);
        }
        Ok(BoundedProfileBody(body_bytes.into()))
    }
}

/// Errors indicating an invalid request to the Monad profile routes, independent of the
/// pre-existing Lotus [`crate::http::server::RegistryServerError`] (this route has its own address
/// format entirely, so it doesn't share that enum).
#[derive(Debug, Error, ErrorMeta, Clone, PartialEq, Eq)]
pub enum EvmProfileRouteError {
    /// The `:addr` path segment wasn't a valid `0x`-prefixed 20-byte Monad address.
    #[invalid_client_input()]
    #[error("Invalid Monad address: {0}")]
    InvalidAddress(HexTypeError),

    /// No profile is registered under the given address.
    #[not_found()]
    #[error("Not found: no Monad profile registered for {0}")]
    ProfileNotFound(Address),
}

use self::EvmProfileRouteError::*;

/// Parse `:addr` as a Monad [`Address`], mapping a failure to
/// [`EvmProfileRouteError::InvalidAddress`].
fn parse_addr(addr: &str) -> Result<Address> {
    Ok(Address::from_str(addr).map_err(InvalidAddress)?)
}

/// `PUT /metadata/monad/:addr`: verify and store a Monad-native profile registration (see this
/// module's docs, and `crate::evm_profile_verify`, for the full verification scheme). Reuses
/// [`proto::PutSignedPayloadResponse`] for its response shape (with an always-empty `txid` list,
/// since profile registration is never burn-gated) purely to match `PUT /metadata/:addr`'s
/// existing response shape -- not because a burn tx could ever appear here.
/// Accepts either canonical Frank-CBOR type-2 registration attestation or legacy protobuf SignedPayload.
pub async fn handle_put_evm_profile(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
    BoundedProfileBody(body_bytes): BoundedProfileBody,
) -> std::result::Result<Protobuf<proto::PutSignedPayloadResponse>, HttpRegistryError> {
    let address = parse_addr(&address)?;
    let is_cbor = headers
        .get(CONTENT_TYPE)
        .and_then(|val| val.to_str().ok())
        .map(|ct| ct.starts_with("application/cbor"))
        .unwrap_or(false)
        || crate::store::evm_profiles::is_cbor_frame(&body_bytes);

    if is_cbor {
        server.registry.put_evm_profile_cbor(
            address,
            server.chains.network().id.as_str(),
            &body_bytes,
        )?;
    } else {
        let signed_metadata = cashweb_payload::proto::SignedPayload::decode(body_bytes.as_ref())
            .map_err(|err| {
                HttpRegistryError(Report::from(
                    crate::evm_profile_verify::EvmProfileVerifyError::InvalidProfilePayload(
                        err.to_string(),
                    ),
                ))
            })?;
        server.registry.put_evm_profile(address, signed_metadata)?;
    }
    Ok(Protobuf(proto::PutSignedPayloadResponse { txid: vec![] }))
}

/// `GET /metadata/monad/:addr`: fetch a previously-registered Monad profile's exact stored bytes.
/// Returns Content-Type application/cbor for CBOR registrations, or application/x-protobuf for legacy.
pub async fn handle_get_evm_profile(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> std::result::Result<Response, HttpRegistryError> {
    let address = parse_addr(&address)?;
    let raw = fetch_profile_raw_or_not_found(&server.registry, address)?;
    let content_type = if crate::store::evm_profiles::is_cbor_frame(&raw) {
        "application/cbor"
    } else {
        "application/x-protobuf"
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(axum::body::boxed(Body::from(raw)))
        .unwrap();
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(response)
}

/// Fetch raw registered profile bytes, or fail with [`EvmProfileRouteError::ProfileNotFound`].
pub(crate) fn fetch_profile_raw_or_not_found(
    registry: &Registry,
    address: Address,
) -> Result<Vec<u8>> {
    Ok(registry
        .get_evm_profile_raw(address)?
        .ok_or(ProfileNotFound(address))?)
}

/// Query parameters for [`handle_list_evm_profiles`].
#[derive(Debug, Deserialize)]
pub struct ListEvmProfilesQuery {
    /// Only return profiles registered at or after this many milliseconds since the Unix epoch.
    /// Defaults to `0` (i.e. every registered profile) when omitted.
    since: Option<i64>,
}

/// Error type for [`handle_list_evm_profiles`].
#[derive(Debug)]
pub enum ListEvmProfilesError {
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListEvmProfilesError {
    fn into_response(self) -> Response {
        match self {
            ListEvmProfilesError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure listing Monad profiles");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /metadata/monad?since=<timestamp>`: list every Monad profile registered at or after
/// `since` (milliseconds since the Unix epoch), ordered by registration timestamp ascending
/// (ticket #75). See this module's docs for the registration-discovery use case. The relay reads
/// the listing in batches, so it may repeat an address whose profile was replaced while paging;
/// clients dedupe by address.
pub async fn handle_list_evm_profiles(
    Query(params): Query<ListEvmProfilesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> std::result::Result<Protobuf<proto::ListMonadProfilesResponse>, ListEvmProfilesError> {
    let since = params.since.unwrap_or(0);
    let entries = server
        .registry
        .list_evm_profiles_since_raw(since)
        .map_err(ListEvmProfilesError::Infrastructure)?
        .into_iter()
        .map(|(address, raw_bytes)| proto::ListMonadProfilesEntry {
            address: address.to_hex(),
            signed_payload: raw_bytes,
        })
        .collect();
    Ok(Protobuf(proto::ListMonadProfilesResponse { entries }))
}

/// Default `limit` for [`handle_search_evm_profiles`] when the query param is omitted --
/// distinct from (and smaller than) `crate::store::evm_profiles::MAX_SEARCH_RESULTS`, which is
/// the hard clamp applied regardless of what a caller asks for.
const DEFAULT_SEARCH_LIMIT: usize = 20;

/// Query parameters for [`handle_search_evm_profiles`].
#[derive(Debug, Deserialize)]
pub struct SearchEvmProfilesQuery {
    /// Name prefix to search for, matched case-insensitively against each profile's normalized
    /// `display_name` entry. Defaults to `""` (matches every named profile) when omitted.
    prefix: Option<String>,
    /// Maximum number of results to return. Defaults to [`DEFAULT_SEARCH_LIMIT`] when omitted,
    /// clamped to `crate::store::evm_profiles::MAX_SEARCH_RESULTS` regardless of what's
    /// requested.
    limit: Option<usize>,
}

/// `GET /metadata/monad/search?prefix=<text>&limit=<n>`: prefix-search registered Monad profiles
/// by their normalized `display_name` (ticket #48). See this module's docs for the design this
/// implements. Reuses [`ListEvmProfilesError`]/[`proto::ListMonadProfilesResponse`] --
/// infrastructure failures here are the same shape as [`handle_list_evm_profiles`]'s.
pub async fn handle_search_evm_profiles(
    Query(params): Query<SearchEvmProfilesQuery>,
    Extension(server): Extension<RegistryServer>,
) -> std::result::Result<Protobuf<proto::ListMonadProfilesResponse>, ListEvmProfilesError> {
    let prefix = params.prefix.unwrap_or_default();
    let limit = params.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    let entries = server
        .registry
        .search_evm_profiles_by_name_raw(&prefix, limit)
        .map_err(ListEvmProfilesError::Infrastructure)?
        .into_iter()
        .map(|(address, raw_bytes)| proto::ListMonadProfilesEntry {
            address: address.to_hex(),
            signed_payload: raw_bytes,
        })
        .collect();
    Ok(Protobuf(proto::ListMonadProfilesResponse { entries }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bitcoinsuite_core::{ecc::Ecc, Hashed, Net, Sha256};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use cashweb_payload::payload::SignatureScheme;
    use hyper::{Body, Request, StatusCode};
    use prost::Message;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        evm_transaction::address_from_uncompressed_pubkey,
        http::{pop_protection::PopGate, server::RegistryServer},
        p2p::peers::Peers,
        store::db::Db,
        test_instance::placeholder_pop_conf,
    };

    /// A [`cashweb_payload::chain_adapter::ChainAdapter`] never actually called -- Monad profile
    /// registration never touches it (see `Registry::put_evm_profile`'s docs). Mirrors
    /// `registry::tests::NeverCalledChainAdapter` exactly, duplicated here (rather than exported
    /// from `registry`'s `#[cfg(test)]` module, which isn't visible to this module) since it's a
    /// small, self-contained test fixture.
    #[derive(Debug)]
    struct NeverCalledChainAdapter;

    #[async_trait::async_trait]
    impl cashweb_payload::chain_adapter::ChainAdapter for NeverCalledChainAdapter {
        async fn submit_tx(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::SubmitTxOutcome> {
            Ok(cashweb_payload::chain_adapter::SubmitTxOutcome::AlreadyConfirmed)
        }
        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::MempoolAcceptResult>
        {
            Ok(Ok(()))
        }
        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            let (_sender, receiver) = tokio::sync::mpsc::channel(1);
            Ok(receiver)
        }
        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<bitcoinsuite_core::Sha256> {
            unimplemented!("Monad profile registration never touches ChainAdapter")
        }
    }

    fn test_registry(name: &str) -> (tempdir::TempDir, Registry) {
        let tempdir = tempdir::TempDir::new(name).unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(NeverCalledChainAdapter), Net::Regtest);
        (tempdir, registry)
    }

    fn test_server(registry: Registry) -> RegistryServer {
        let pop_gate = PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        let event_bus = registry.event_bus().clone();
        RegistryServer {
            quota_backend: crate::http::hourly_quota::QuotaBackend::local(),
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            curated_defaults: Arc::new(vec![]),
            evm_mailbox: crate::evm_mailbox::EvmMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
            solana_proxy: None,
            chains: std::sync::Arc::new(
                crate::chains::RelayChains::network_only("monad-testnet").unwrap(),
            ),
            forum: None,
            group_writes: None,
            spa_dir: None,
            event_bus,
        }
    }

    /// Builds a validly-signed [`cashweb_payload::proto::SignedPayload`] for `profile`, signed by
    /// `seckey_byte` -- mirrors `registry::tests::sign_evm_profile` exactly (duplicated for the
    /// same reason as [`NeverCalledChainAdapter`] above), and the [`Address`] it registers under.
    fn sign_evm_profile(
        seckey_byte: u8,
        profile: &proto::MonadProfile,
    ) -> (cashweb_payload::proto::SignedPayload, Address) {
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([seckey_byte; 32]).unwrap();
        let pubkey = ecc.derive_pubkey(&seckey);
        let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
        let address = address_from_uncompressed_pubkey(&uncompressed);

        let payload = profile.encode_to_vec();
        let payload_hash = Sha256::digest(payload.clone().into());
        let sig = ecc.sign(&seckey, payload_hash.byte_array().clone());

        let signed = cashweb_payload::proto::SignedPayload {
            pubkey: pubkey.as_slice().to_vec(),
            sig: sig.to_vec(),
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            burn_amount: 0,
            burn_txs: vec![],
        };
        (signed, address)
    }

    fn named_profile(timestamp: i64, name: &str) -> proto::MonadProfile {
        proto::MonadProfile {
            timestamp,
            ttl: 1000 * 60 * 60 * 24 * 365,
            entries: vec![proto::AddressEntry {
                kind: "display_name".to_string(),
                headers: Default::default(),
                body: name.as_bytes().to_vec(),
            }],
        }
    }

    #[tokio::test]
    async fn handler_returns_matching_profiles() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-match");
        let (alice_signed, alice_address) = sign_evm_profile(1, &named_profile(100, "Alice"));
        registry
            .put_evm_profile(alice_address, alice_signed.clone())
            .unwrap();
        let (bob_signed, bob_address) = sign_evm_profile(2, &named_profile(101, "Bob"));
        registry.put_evm_profile(bob_address, bob_signed).unwrap();
        let server = test_server(registry);

        let query = SearchEvmProfilesQuery {
            prefix: Some("ali".to_string()),
            limit: None,
        };
        let Protobuf(response) = handle_search_evm_profiles(Query(query), Extension(server))
            .await
            .unwrap();
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].address, alice_address.to_hex());
        assert_eq!(
            response.entries[0].signed_payload,
            alice_signed.encode_to_vec()
        );
    }

    #[tokio::test]
    async fn handler_returns_empty_when_nothing_matches() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-empty");
        let (signed, address) = sign_evm_profile(1, &named_profile(100, "Alice"));
        registry.put_evm_profile(address, signed).unwrap();
        let server = test_server(registry);

        let query = SearchEvmProfilesQuery {
            prefix: Some("zzz".to_string()),
            limit: None,
        };
        let Protobuf(response) = handle_search_evm_profiles(Query(query), Extension(server))
            .await
            .unwrap();
        assert_eq!(response.entries, vec![]);
    }

    #[tokio::test]
    async fn handler_clamps_limit_to_max_search_results() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-clamp");
        for i in 0..10u8 {
            let (signed, address) =
                sign_evm_profile(i + 1, &named_profile(100 + i as i64, &format!("name{i}")));
            registry.put_evm_profile(address, signed).unwrap();
        }
        let server = test_server(registry);

        // Request far fewer than what's available; the handler must not silently ignore `limit`.
        let query = SearchEvmProfilesQuery {
            prefix: Some("name".to_string()),
            limit: Some(3),
        };
        let Protobuf(response) = handle_search_evm_profiles(Query(query), Extension(server))
            .await
            .unwrap();
        assert_eq!(response.entries.len(), 3);
    }

    /// Exercises the *real* router built by [`RegistryServer::into_router`] end-to-end -- proves
    /// the static `/metadata/monad/search` segment isn't swallowed by the dynamic
    /// `/metadata/monad/:addr` route registered just above it, mirroring
    /// `http::curated_defaults::tests::route_is_not_swallowed_by_dynamic_addr_route`'s identical
    /// precedent for the sibling `/metadata/monad/curated-defaults` route.
    #[tokio::test]
    async fn route_is_not_swallowed_by_dynamic_addr_route() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-router");
        let (signed, address) = sign_evm_profile(1, &named_profile(100, "Alice"));
        registry.put_evm_profile(address, signed.clone()).unwrap();
        let server = test_server(registry);
        let router = server.into_router();

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/metadata/monad/search?prefix=ali")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body_bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body = proto::ListMonadProfilesResponse::decode(body_bytes).unwrap();
        assert_eq!(body.entries.len(), 1);
        assert_eq!(body.entries[0].address, address.to_hex());
        assert_eq!(body.entries[0].signed_payload, signed.encode_to_vec());
    }
}
