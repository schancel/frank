//! `PUT`/`GET /metadata/monad/:addr` (ticket #45): the dedicated Monad-native profile
//! registration route. See `crate::monad_profile_verify`'s module docs for how a registration is
//! authenticated (an explicit pubkey+signature field, mirroring Lotus's own solution to the
//! identical problem, rather than `ecrecover` -- there's no burn transaction here to `ecrecover`
//! from).
//!
//! ## Also reachable at the plain `/metadata/:addr` route
//!
//! `crate::http::server::handle_put_registry`/`handle_get_registry` *additionally* dispatch to
//! [`Registry::put_monad_profile`]/[`Registry::get_monad_profile`] directly whenever the `:addr`
//! path segment parses as a Monad address rather than a `LotusAddress`, bypassing this module's
//! own handlers (which exist for the separate, dedicated route below).
//!
//! This ticket's issue text asked only for `/metadata/monad/:addr`. The plain-route dispatch was
//! added after checking the real, already-merged TS client this ticket is meant to unblock
//! (`app/src/cashweb/wallet/monad-identity.ts`'s `registerMonadIdentity`/
//! `fetchMonadIdentityPubKey`, ticket #41) byte-for-byte against this route, per this ticket's own
//! explicit instruction not to design in isolation from it. That client calls the *plain*
//! `/metadata/:addr` route -- the exact same one `lotus-identity.ts`'s Lotus client already uses
//! -- not `/metadata/monad/:addr`; its own module docs even flag this as a known, then-unresolved
//! gap ("Known gap: `/metadata/:addr` is Lotus-address-only server-side, today"). Per this
//! ticket's instruction ("if it doesn't match, fix your Rust side to match the real existing TS
//! client -- don't ask the TS side to change, it's already merged and other code depends on its
//! current shape"), both paths now reach the same Monad-native logic:
//! - `/metadata/monad/:addr` for the literal route this ticket's acceptance criteria names (and
//!   for any future client that addresses Monad profiles explicitly), and
//! - the plain `/metadata/:addr` dispatch so the real, already-shipped `monad-identity.ts` client
//!   actually works against a live relay -- the concrete thing ticket #42 is blocked on.
//!
//! ## Registration discovery (`GET /metadata/monad?since=<timestamp>`, ticket #75)
//!
//! Mirrors `crate::http::monad_message`'s `GET /message/monad?since=` exactly: a client (e.g. a
//! bot that wants to auto-greet/auto-fund new signups) polls this with an advancing cursor (the
//! highest registration `timestamp` it's already seen, plus one) to discover newly-registered
//! profiles without already knowing their addresses out of band. Same-path-different-method
//! precedent as `/message/monad`'s own `PUT`/`GET(since=)` pair -- this route has no `:addr`
//! segment, so it can't collide with `/metadata/monad/:addr` above.
//!
//! ## Name search (`GET /metadata/monad/search?prefix=<text>&limit=<n>`, ticket #48)
//!
//! Prefix-only (not fuzzy) search over registered profiles' `display_name` `AddressEntry`, per
//! this ticket's own design-decision comment thread on GitHub issue #48. Reuses
//! [`proto::ListMonadProfilesResponse`]/[`proto::ListMonadProfilesEntry`] -- the exact same shape
//! ticket #75's `since`-listing route already defined -- since the entry shape (`address` +
//! `signed_payload`) is identical here; only the query/filter differs, so no new proto message was
//! needed. See `crate::store::monad_profiles`'s module docs for the `CF_MONAD_PROFILES_BY_NAME`
//! index this reads, and `crate::http::server`'s module docs on `into_router()` for why this is a
//! static path segment (so it can't collide with the dynamic `/metadata/monad/:addr` route).

use std::str::FromStr;

use axum::body::Body;
use axum::{
    extract::{Path, Query},
    http::{
        header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, RETRY_AFTER},
        StatusCode,
    },
    response::{IntoResponse, Response},
    Extension,
};
use bitcoinsuite_error::{ErrorMeta, Report, Result};
use cashweb_http_utils::protobuf::{CashwebProtobufError, Protobuf};
use prost::Message;
use serde::Deserialize;
use thiserror::Error;
use tracing::Level;

use crate::{
    http::{error::HttpRegistryError, server::RegistryServer},
    monad_http::{Address, HexTypeError},
    proto,
    registry::Registry,
};

/// Errors indicating an invalid request to the Monad profile routes, independent of the
/// pre-existing Lotus [`crate::http::server::RegistryServerError`] (this route has its own address
/// format entirely, so it doesn't share that enum).
#[derive(Debug, Error, ErrorMeta, Clone, PartialEq, Eq)]
pub enum MonadProfileRouteError {
    /// The `:addr` path segment wasn't a valid `0x`-prefixed 20-byte Monad address.
    #[invalid_client_input()]
    #[error("Invalid Monad address: {0}")]
    InvalidAddress(HexTypeError),

    /// No profile is registered under the given address.
    #[not_found()]
    #[error("Not found: no Monad profile registered for {0}")]
    ProfileNotFound(Address),

    /// Registration writes must declare one of the two supported wire formats exactly.
    #[invalid_client_input()]
    #[error("Unsupported Content-Type; expected application/cbor or application/x-protobuf")]
    UnsupportedContentType,

    /// Candidate CBOR frames have a smaller, protocol-defined route limit than legacy protobuf.
    #[invalid_client_input()]
    #[error("Monad profile body exceeds the {limit}-byte limit")]
    BodyTooLarge {
        /// Exact maximum accepted bytes for the selected wire format.
        limit: usize,
    },
}

use self::MonadProfileRouteError::*;

/// Parse `:addr` as a Monad [`Address`], mapping a failure to
/// [`MonadProfileRouteError::InvalidAddress`].
fn parse_addr(addr: &str) -> Result<Address> {
    Ok(Address::from_str(addr).map_err(InvalidAddress)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MonadProfileMediaType {
    Cbor,
    Protobuf,
}

/// Candidate CBOR registration route cap. The legacy protobuf route retains Axum's existing
/// 2 MiB default, so the opt-in predecessor does not silently tighten the old contract.
pub(crate) const CBOR_PROFILE_BODY_LIMIT: usize = 256 * 1024;

pub(crate) fn check_monad_profile_body_size(
    media_type: MonadProfileMediaType,
    body_len: usize,
) -> std::result::Result<(), MonadProfileRouteError> {
    if media_type == MonadProfileMediaType::Cbor && body_len > CBOR_PROFILE_BODY_LIMIT {
        return Err(BodyTooLarge {
            limit: CBOR_PROFILE_BODY_LIMIT,
        });
    }
    Ok(())
}

pub(crate) fn parse_monad_profile_content_type(
    headers: &HeaderMap,
) -> Result<MonadProfileMediaType> {
    match headers.get(CONTENT_TYPE).map(HeaderValue::as_bytes) {
        Some(b"application/cbor") => Ok(MonadProfileMediaType::Cbor),
        Some(b"application/x-protobuf") => Ok(MonadProfileMediaType::Protobuf),
        _ => Err(UnsupportedContentType.into()),
    }
}

fn explicitly_accepts_cbor(headers: &HeaderMap) -> bool {
    headers.get(ACCEPT).map(HeaderValue::as_bytes) == Some(b"application/cbor")
}

#[derive(Debug)]
/// Failures returned by the bounded profile-registration request boundary.
pub enum PutMonadProfileError {
    /// A validation, verification, or persistence error with the existing protobuf error body.
    Registry(HttpRegistryError),
    /// The global non-waiting admission pool is exhausted; the caller should retry later.
    Overloaded,
    /// The candidate body exceeded its route limit.
    BodyTooLarge {
        /// Exact maximum accepted bytes for candidate CBOR.
        limit: usize,
    },
}

impl From<Report> for PutMonadProfileError {
    fn from(err: Report) -> Self {
        Self::Registry(err.into())
    }
}

impl From<HttpRegistryError> for PutMonadProfileError {
    fn from(err: HttpRegistryError) -> Self {
        Self::Registry(err)
    }
}

pub(crate) fn profile_overloaded_response() -> Response {
    let mut response = StatusCode::SERVICE_UNAVAILABLE.into_response();
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

pub(crate) fn profile_body_too_large_response(limit: usize) -> Response {
    let body = Protobuf(cashweb_http_utils::proto::Error {
        error_code: "body-too-large".to_string(),
        msg: format!("Monad profile body exceeds the {limit}-byte limit"),
        is_user_error: false,
    });
    (StatusCode::PAYLOAD_TOO_LARGE, body).into_response()
}

impl IntoResponse for PutMonadProfileError {
    fn into_response(self) -> Response {
        match self {
            Self::Registry(err) => err.into_response(),
            Self::Overloaded => profile_overloaded_response(),
            Self::BodyTooLarge { limit } => profile_body_too_large_response(limit),
        }
    }
}

/// `PUT /metadata/monad/:addr`: verify and store a Monad-native profile registration (see this
/// module's docs, and `crate::monad_profile_verify`, for the full verification scheme). Reuses
/// [`proto::PutSignedPayloadResponse`] for its response shape (with an always-empty `txid` list,
/// since profile registration is never burn-gated) purely to match `PUT /metadata/:addr`'s
/// existing response shape -- not because a burn tx could ever appear here.
/// Accepts either canonical Frank-CBOR type-2 registration attestation or legacy protobuf SignedPayload.
pub async fn handle_put_monad_profile(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
    body_bytes: axum::body::Bytes,
) -> std::result::Result<Protobuf<proto::PutSignedPayloadResponse>, PutMonadProfileError> {
    let address = parse_addr(&address)?;
    let media_type = parse_monad_profile_content_type(&headers)?;
    check_monad_profile_body_size(media_type, body_bytes.len()).map_err(|err| match err {
        BodyTooLarge { limit } => PutMonadProfileError::BodyTooLarge { limit },
        _ => unreachable!("body-size validation returns only BodyTooLarge"),
    })?;
    let admission = server
        .registry
        .try_acquire_profile_registration(address)
        .map_err(|_| PutMonadProfileError::Overloaded)?;
    match media_type {
        MonadProfileMediaType::Cbor => {
            server
                .registry
                .put_monad_profile_cbor_async(address, body_bytes.to_vec(), admission)
                .await?
        }
        MonadProfileMediaType::Protobuf => {
            let signed_metadata = cashweb_payload::proto::SignedPayload::decode(
                body_bytes.as_ref(),
            )
            .map_err(|err| Report::from(CashwebProtobufError::BadProtobuf(err.to_string())))?;
            server
                .registry
                .put_monad_profile_async(address, signed_metadata, admission)
                .await?;
        }
    }
    Ok(Protobuf(proto::PutSignedPayloadResponse { txid: vec![] }))
}

/// `GET /metadata/monad/:addr`: fetch a previously registered Monad profile. Exact
/// `Accept: application/cbor` opts into the isolated CBOR candidate; every other request remains
/// on the legacy protobuf representation.
pub async fn handle_get_monad_profile(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
) -> std::result::Result<Response, HttpRegistryError> {
    let address = parse_addr(&address)?;
    let (raw, content_type) = if explicitly_accepts_cbor(&headers) {
        (
            fetch_profile_cbor_or_not_found(&server.registry, address)?,
            "application/cbor",
        )
    } else {
        let signed = fetch_profile_or_not_found(&server.registry, address)?;
        (signed.encode_to_vec(), "application/x-protobuf")
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

/// Fetch raw registered profile bytes, or fail with [`MonadProfileRouteError::ProfileNotFound`].
pub(crate) fn fetch_profile_or_not_found(
    registry: &Registry,
    address: Address,
) -> Result<cashweb_payload::proto::SignedPayload> {
    Ok(registry
        .get_monad_profile(address)?
        .ok_or(ProfileNotFound(address))?)
}

pub(crate) fn fetch_profile_cbor_or_not_found(
    registry: &Registry,
    address: Address,
) -> Result<Vec<u8>> {
    Ok(registry
        .get_monad_profile_cbor(address)?
        .ok_or(ProfileNotFound(address))?)
}

/// Query parameters for [`handle_list_monad_profiles`].
#[derive(Debug, Deserialize)]
pub struct ListMonadProfilesQuery {
    /// Only return profiles registered at or after this many milliseconds since the Unix epoch.
    /// Defaults to `0` (i.e. every registered profile) when omitted.
    since: Option<i64>,
}

/// Error type for [`handle_list_monad_profiles`].
#[derive(Debug)]
pub enum ListMonadProfilesError {
    /// There is no list/search response schema for CBOR candidate records yet.
    CborResponseSchemaUnavailable,
    /// A storage-level error.
    Infrastructure(Report),
}

impl IntoResponse for ListMonadProfilesError {
    fn into_response(self) -> Response {
        match self {
            ListMonadProfilesError::CborResponseSchemaUnavailable => {
                StatusCode::NOT_ACCEPTABLE.into_response()
            }
            ListMonadProfilesError::Infrastructure(err) => {
                tracing::event!(Level::ERROR, error = %err, "infrastructure failure listing Monad profiles");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

/// `GET /metadata/monad?since=<timestamp>`: list every Monad profile registered at or after
/// `since` (milliseconds since the Unix epoch), ordered by registration timestamp ascending
/// (ticket #75). See this module's docs for the registration-discovery use case.
pub async fn handle_list_monad_profiles(
    Query(params): Query<ListMonadProfilesQuery>,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
) -> std::result::Result<Protobuf<proto::ListMonadProfilesResponse>, ListMonadProfilesError> {
    if explicitly_accepts_cbor(&headers) {
        return Err(ListMonadProfilesError::CborResponseSchemaUnavailable);
    }
    let since = params.since.unwrap_or(0);
    let entries = server
        .registry
        .list_monad_profiles_since(since)
        .map_err(ListMonadProfilesError::Infrastructure)?
        .into_iter()
        .map(|(address, signed_payload)| proto::ListMonadProfilesEntry {
            address: address.to_hex(),
            signed_payload: Some(signed_payload),
        })
        .collect();
    Ok(Protobuf(proto::ListMonadProfilesResponse { entries }))
}

/// Default `limit` for [`handle_search_monad_profiles`] when the query param is omitted --
/// distinct from (and smaller than) `crate::store::monad_profiles::MAX_SEARCH_RESULTS`, which is
/// the hard clamp applied regardless of what a caller asks for.
const DEFAULT_SEARCH_LIMIT: usize = 20;

/// Query parameters for [`handle_search_monad_profiles`].
#[derive(Debug, Deserialize)]
pub struct SearchMonadProfilesQuery {
    /// Name prefix to search for, matched case-insensitively against each profile's normalized
    /// `display_name` entry. Defaults to `""` (matches every named profile) when omitted.
    prefix: Option<String>,
    /// Maximum number of results to return. Defaults to [`DEFAULT_SEARCH_LIMIT`] when omitted,
    /// clamped to `crate::store::monad_profiles::MAX_SEARCH_RESULTS` regardless of what's
    /// requested.
    limit: Option<usize>,
}

/// `GET /metadata/monad/search?prefix=<text>&limit=<n>`: prefix-search registered Monad profiles
/// by their normalized `display_name` (ticket #48). See this module's docs for the design this
/// implements. Reuses [`ListMonadProfilesError`]/[`proto::ListMonadProfilesResponse`] --
/// infrastructure failures here are the same shape as [`handle_list_monad_profiles`]'s.
pub async fn handle_search_monad_profiles(
    Query(params): Query<SearchMonadProfilesQuery>,
    Extension(server): Extension<RegistryServer>,
    headers: HeaderMap,
) -> std::result::Result<Protobuf<proto::ListMonadProfilesResponse>, ListMonadProfilesError> {
    if explicitly_accepts_cbor(&headers) {
        return Err(ListMonadProfilesError::CborResponseSchemaUnavailable);
    }
    let prefix = params.prefix.unwrap_or_default();
    let limit = params.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    let entries = server
        .registry
        .search_monad_profiles_by_name(&prefix, limit)
        .map_err(ListMonadProfilesError::Infrastructure)?
        .into_iter()
        .map(|(address, signed_payload)| proto::ListMonadProfilesEntry {
            address: address.to_hex(),
            signed_payload: Some(signed_payload),
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
        http::{pop_protection::PopGate, server::RegistryServer},
        monad_evm_tx::address_from_uncompressed_pubkey,
        p2p::peers::Peers,
        store::db::Db,
        test_instance::placeholder_pop_conf,
    };

    /// A [`cashweb_payload::chain_adapter::ChainAdapter`] never actually called -- Monad profile
    /// registration never touches it (see `Registry::put_monad_profile`'s docs). Mirrors
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
        RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
        }
    }

    /// Builds a validly-signed [`cashweb_payload::proto::SignedPayload`] for `profile`, signed by
    /// `seckey_byte` -- mirrors `registry::tests::sign_monad_profile` exactly (duplicated for the
    /// same reason as [`NeverCalledChainAdapter`] above), and the [`Address`] it registers under.
    fn sign_monad_profile(
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
        let (alice_signed, alice_address) = sign_monad_profile(1, &named_profile(100, "Alice"));
        registry
            .put_monad_profile(alice_address, alice_signed.clone())
            .unwrap();
        let (bob_signed, bob_address) = sign_monad_profile(2, &named_profile(101, "Bob"));
        registry.put_monad_profile(bob_address, bob_signed).unwrap();
        let server = test_server(registry);

        let query = SearchMonadProfilesQuery {
            prefix: Some("ali".to_string()),
            limit: None,
        };
        let Protobuf(response) =
            handle_search_monad_profiles(Query(query), Extension(server), HeaderMap::new())
                .await
                .unwrap();
        assert_eq!(response.entries.len(), 1);
        assert_eq!(response.entries[0].address, alice_address.to_hex());
        assert_eq!(response.entries[0].signed_payload, Some(alice_signed));
    }

    #[tokio::test]
    async fn handler_returns_empty_when_nothing_matches() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-empty");
        let (signed, address) = sign_monad_profile(1, &named_profile(100, "Alice"));
        registry.put_monad_profile(address, signed).unwrap();
        let server = test_server(registry);

        let query = SearchMonadProfilesQuery {
            prefix: Some("zzz".to_string()),
            limit: None,
        };
        let Protobuf(response) =
            handle_search_monad_profiles(Query(query), Extension(server), HeaderMap::new())
                .await
                .unwrap();
        assert_eq!(response.entries, vec![]);
    }

    #[tokio::test]
    async fn handler_clamps_limit_to_max_search_results() {
        let (_tempdir, registry) = test_registry("cashweb-registry--search-monad-profiles-clamp");
        for i in 0..10u8 {
            let (signed, address) =
                sign_monad_profile(i + 1, &named_profile(100 + i as i64, &format!("name{i}")));
            registry.put_monad_profile(address, signed).unwrap();
        }
        let server = test_server(registry);

        // Request far fewer than what's available; the handler must not silently ignore `limit`.
        let query = SearchMonadProfilesQuery {
            prefix: Some("name".to_string()),
            limit: Some(3),
        };
        let Protobuf(response) =
            handle_search_monad_profiles(Query(query), Extension(server), HeaderMap::new())
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
        let (signed, address) = sign_monad_profile(1, &named_profile(100, "Alice"));
        registry.put_monad_profile(address, signed.clone()).unwrap();
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
        assert_eq!(body.entries[0].signed_payload, Some(signed));
    }
}
