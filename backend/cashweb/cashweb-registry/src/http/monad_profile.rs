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

use std::str::FromStr;

use axum::{extract::Path, Extension};
use bitcoinsuite_error::{ErrorMeta, Result};
use cashweb_http_utils::protobuf::Protobuf;
use thiserror::Error;

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
}

use self::MonadProfileRouteError::*;

/// Parse `:addr` as a Monad [`Address`], mapping a failure to
/// [`MonadProfileRouteError::InvalidAddress`].
fn parse_addr(addr: &str) -> Result<Address> {
    Ok(Address::from_str(addr).map_err(InvalidAddress)?)
}

/// `PUT /metadata/monad/:addr`: verify and store a Monad-native profile registration (see this
/// module's docs, and `crate::monad_profile_verify`, for the full verification scheme). Reuses
/// [`proto::PutSignedPayloadResponse`] for its response shape (with an always-empty `txid` list,
/// since profile registration is never burn-gated) purely to match `PUT /metadata/:addr`'s
/// existing response shape -- not because a burn tx could ever appear here.
pub async fn handle_put_monad_profile(
    Path(address): Path<String>,
    Protobuf(signed_metadata): Protobuf<cashweb_payload::proto::SignedPayload>,
    Extension(server): Extension<RegistryServer>,
) -> std::result::Result<Protobuf<proto::PutSignedPayloadResponse>, HttpRegistryError> {
    let address = parse_addr(&address)?;
    server
        .registry
        .put_monad_profile(address, signed_metadata)?;
    Ok(Protobuf(proto::PutSignedPayloadResponse { txid: vec![] }))
}

/// `GET /metadata/monad/:addr`: fetch a previously-registered Monad profile's
/// `cashweb_payload::proto::SignedPayload` envelope.
pub async fn handle_get_monad_profile(
    Path(address): Path<String>,
    Extension(server): Extension<RegistryServer>,
) -> std::result::Result<Protobuf<cashweb_payload::proto::SignedPayload>, HttpRegistryError> {
    let address = parse_addr(&address)?;
    let signed = fetch_profile_or_not_found(&server.registry, address)?;
    Ok(Protobuf(signed))
}

/// Fetch a registered Monad profile, or fail with [`MonadProfileRouteError::ProfileNotFound`] --
/// shared by [`handle_get_monad_profile`] and `crate::http::server::handle_get_registry`'s
/// Monad-address dispatch branch, so the two routes can't drift on "not found" handling.
pub(crate) fn fetch_profile_or_not_found(
    registry: &Registry,
    address: Address,
) -> Result<cashweb_payload::proto::SignedPayload> {
    Ok(registry
        .get_monad_profile(address)?
        .ok_or(ProfileNotFound(address))?)
}
