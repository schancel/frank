//! Capability boundary for records that may enter public federation.
//!
//! Public peer code receives this narrow wrapper instead of [`crate::registry::Registry`] or
//! [`crate::store::db::Db`]. The wrapper deliberately exposes only the legacy public address
//! directory used by today's initial metadata download. Public Monad directory and pubsub
//! capabilities will be added explicitly when their own stores and validators land; presentation
//! profiles and mailbox state do not belong here.

use std::fmt::{Debug, Formatter};

use bitcoinsuite_core::{LotusAddress, Net};
use bitcoinsuite_error::Result;
use cashweb_payload::payload::SignedPayload;

use crate::{proto, registry::Registry};

/// Narrow access to records approved for public peer replication.
///
/// The wrapped [`Registry`] reference is private so callers cannot unwrap this capability into
/// generic database, profile, or mailbox access.
///
/// The absence of private-record methods is intentional and compile-time enforced:
///
/// ```compile_fail
/// use cashweb_registry::p2p::public_store::PublicFederationStore;
///
/// fn read_private_mailbox(store: &PublicFederationStore<'_>) {
///     let _ = store.list_monad_messages_since(0);
/// }
/// ```
///
/// ```compile_fail
/// use cashweb_registry::p2p::public_store::PublicFederationStore;
///
/// fn read_relay_local_profiles(store: &PublicFederationStore<'_>) {
///     let _ = store.list_monad_profiles_since(0);
/// }
/// ```
#[derive(Clone, Copy)]
pub struct PublicFederationStore<'a> {
    registry: &'a Registry,
}

impl<'a> PublicFederationStore<'a> {
    /// Restrict an existing registry to its explicitly public federation capabilities.
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    /// Network used to construct the legacy directory's zero/start address.
    pub fn legacy_network(&self) -> Net {
        self.registry.net()
    }

    /// Latest cursor in the legacy public address-directory index.
    pub fn latest_legacy_directory_entry(&self) -> Result<Option<(i64, LotusAddress)>> {
        self.registry.get_latest_metadata()
    }

    /// Validate and apply one legacy public address-directory record learned from a peer.
    pub async fn apply_legacy_directory_entry(
        &self,
        address: &LotusAddress,
        signed_metadata: &SignedPayload<proto::AddressMetadata>,
    ) -> Result<()> {
        self.registry
            .put_metadata(address, &signed_metadata.to_proto())
            .await?;
        Ok(())
    }
}

impl Debug for PublicFederationStore<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublicFederationStore")
            .finish_non_exhaustive()
    }
}
