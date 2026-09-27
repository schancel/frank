//! Contains `DbMonadProfiles`, storage for Monad-native profile registrations (`PUT`/`GET
//! /metadata/monad/:addr`, ticket #45), keyed directly by the registrant's raw 20-byte Monad
//! address.
//!
//! ## Why this is a separate store from `DbMetadata`
//!
//! `DbMetadata` (`crate::store::metadata`) keys by `crate::store::pubkeyhash::PubKeyHash`, whose
//! only constructor (`PubKeyHash::from_address`) derives a hash from a `LotusAddress`'s P2PKH
//! script -- there's no Monad-address equivalent, and per this session's established "don't make
//! `PubKeyHash`/`SignedPayload` dual-chain, build a parallel Monad-native path" precedent (PLAN.md
//! constraint 5/6, and this ticket's own issue text), this crate doesn't try to make `PubKeyHash`
//! accept a second address format. This store is therefore new and parallel, mirroring
//! `DbMonadMessages`'s "new CF, keyed directly by the chain-native identifier" shape, minus that
//! store's by-time secondary index -- nothing here needs a `list_since`-style range scan, since a
//! Monad profile is looked up by its owning address only, exactly like `DbMetadata::get(&PubKeyHash)`.
//!
//! ## What's stored
//!
//! The *exact* `cashweb_payload::proto::SignedPayload` envelope the client `PUT`s -- not a custom
//! wrapper -- mirroring `DbMetadata::put`/`get`'s own "store/return the wire `SignedPayload`
//! as-is" shape. This matters because `GET /metadata/monad/:addr` (and the plain `/metadata/:addr`
//! route's Monad dispatch branch) must return something `app/src/cashweb/wallet/monad-identity.ts`'s
//! `fetchMonadIdentityPubKey` can decode with a bare `SignedPayload.deserializeBinary(response.data)`
//! -- verified against that file directly (see `crate::monad_profile_verify`'s module docs for the
//! full wire-format cross-check this ticket did against the real, already-merged TS client), not
//! assumed.

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::ColumnFamilyDescriptor;
use thiserror::Error;

use crate::{
    monad_http::Address,
    store::db::{Db, CF, CF_MONAD_PROFILES},
};

/// Allows access to stored Monad-native profile registrations.
pub struct DbMonadProfiles<'a> {
    db: &'a Db,
    cf_monad_profiles: &'a CF,
}

/// Errors indicating some Monad-profile store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadProfilesError {
    /// Database contains an invalid protobuf `SignedPayload`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode SignedPayload: {0}")]
    CannotDecodeSignedPayload(String),
}

use self::DbMonadProfilesError::*;

impl<'a> DbMonadProfiles<'a> {
    /// Create a new [`DbMonadProfiles`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_profiles = db.cf(CF_MONAD_PROFILES).unwrap();
        DbMonadProfiles {
            db,
            cf_monad_profiles,
        }
    }

    /// Store a [`cashweb_payload::proto::SignedPayload`] under `address`, overwriting any
    /// previous registration -- idempotent, mirroring `DbMonadMessages::put`'s "overwrite" model.
    /// Monotonic-timestamp enforcement (rejecting a stale re-registration) is the caller's job
    /// (see `Registry::put_monad_profile`), the same layering `Registry::put_metadata` uses for
    /// the Lotus path.
    pub fn put(
        &self,
        address: &Address,
        signed: &cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_monad_profiles, address.0, signed.encode_to_vec());
        self.db.write_batch(batch)?;
        Ok(())
    }

    /// Retrieve a [`cashweb_payload::proto::SignedPayload`] previously registered under
    /// `address`. [`None`] if nothing is registered there yet.
    pub fn get(&self, address: &Address) -> Result<Option<cashweb_payload::proto::SignedPayload>> {
        let serialized = match self.db.get(self.cf_monad_profiles, address.0)? {
            Some(serialized) => serialized,
            None => return Ok(None),
        };
        let signed = cashweb_payload::proto::SignedPayload::decode(serialized.as_ref())
            .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&serialized)))?;
        Ok(Some(signed))
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_PROFILES,
            rocksdb::Options::default(),
        ));
    }
}

impl Debug for DbMonadProfiles<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbMonadProfiles {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;

    use crate::{monad_http::Address, store::db::Db};

    fn sample_signed_payload(timestamp_seed: u8) -> cashweb_payload::proto::SignedPayload {
        cashweb_payload::proto::SignedPayload {
            pubkey: vec![2; 33],
            sig: vec![timestamp_seed; 5],
            sig_scheme: 1,
            payload: vec![9, 9, 9],
            payload_hash: vec![],
            burn_amount: 0,
            burn_txs: vec![],
        }
    }

    #[test]
    fn test_db_monad_profiles() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let address = Address([7u8; 20]);

        assert_eq!(db.monad_profiles().get(&address)?, None);

        let signed = sample_signed_payload(1);
        db.monad_profiles().put(&address, &signed)?;
        assert_eq!(db.monad_profiles().get(&address)?, Some(signed.clone()));

        // A different address is unaffected.
        let other_address = Address([8u8; 20]);
        assert_eq!(db.monad_profiles().get(&other_address)?, None);

        // Overwriting replaces the stored value.
        let updated = sample_signed_payload(2);
        db.monad_profiles().put(&address, &updated)?;
        assert_eq!(db.monad_profiles().get(&address)?, Some(updated));

        Ok(())
    }

    #[test]
    fn test_db_monad_profiles_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(
            format!("{:?}", db.monad_profiles()),
            "DbMonadProfiles { .. }"
        );
        Ok(())
    }
}
