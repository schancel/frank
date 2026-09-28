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
//! `DbMonadMessages`'s "new CF, keyed directly by the chain-native identifier" shape.
//!
//! ## `list_since` (ticket #75)
//!
//! `CF_MONAD_PROFILES_BY_TIME` is a secondary index, keyed by `timestamp.to_be_bytes() ++ address`
//! (value: the raw address), maintained alongside the primary `CF_MONAD_PROFILES` on every
//! [`DbMonadProfiles::put`] -- mirrors `DbMonadMessages`'s identical `CF_MONAD_MESSAGES_BY_TIME`/
//! `list_since` pattern exactly. `timestamp` here is the *registration's own* timestamp (the
//! decoded `proto::MonadProfile.timestamp` inside `signed.payload` -- not any storage-write
//! wall-clock time), the same field `Registry::put_monad_profile`'s existing monotonic-timestamp
//! check already decodes. Lets a bot (or any other client) discover newly-registered profiles by
//! polling with an advancing cursor, without already knowing their addresses out of band.
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
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use thiserror::Error;

use crate::{
    monad_http::Address,
    proto,
    store::db::{Db, CF, CF_MONAD_PROFILES, CF_MONAD_PROFILES_BY_TIME},
};

/// Build the `CF_MONAD_PROFILES_BY_TIME` key for a given `(timestamp, address)` pair. Kept as a
/// free function so [`DbMonadProfiles::put`] and [`DbMonadProfiles::list_since`] can't disagree on
/// the encoding -- mirrors `store::monad_messages::by_time_key` exactly.
fn by_time_key(timestamp: i64, address: &[u8]) -> Vec<u8> {
    [timestamp.to_be_bytes().as_ref(), address].concat()
}

/// Allows access to stored Monad-native profile registrations.
pub struct DbMonadProfiles<'a> {
    db: &'a Db,
    cf_monad_profiles: &'a CF,
    cf_monad_profiles_by_time: &'a CF,
}

/// Errors indicating some Monad-profile store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadProfilesError {
    /// Database contains an invalid protobuf `SignedPayload`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode SignedPayload: {0}")]
    CannotDecodeSignedPayload(String),

    /// A `SignedPayload`'s `payload` field isn't a valid `proto::MonadProfile` -- ticket #75's
    /// by-time index needs to decode this to get the registration's `timestamp`. In practice this
    /// can't happen via the real `PUT /metadata/monad/:addr` path (`Registry::put_monad_profile`
    /// already requires a valid `MonadProfile` to check the monotonic-timestamp invariant before
    /// ever calling `DbMonadProfiles::put`), so this is a caller-contract violation, not a
    /// reachable runtime state.
    #[critical()]
    #[error("Cannot index profile by time: payload doesn't decode as MonadProfile: {0}")]
    CannotDecodeMonadProfile(String),

    /// Database contains an invalid by-time index entry (not a 20-byte Monad address).
    #[critical()]
    #[error("Inconsistent db: by-time index value isn't a 20-byte address: {0}")]
    InvalidIndexedAddress(String),
}

use self::DbMonadProfilesError::*;

impl<'a> DbMonadProfiles<'a> {
    /// Create a new [`DbMonadProfiles`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_profiles = db.cf(CF_MONAD_PROFILES).unwrap();
        let cf_monad_profiles_by_time = db.cf(CF_MONAD_PROFILES_BY_TIME).unwrap();
        DbMonadProfiles {
            db,
            cf_monad_profiles,
            cf_monad_profiles_by_time,
        }
    }

    /// Store a [`cashweb_payload::proto::SignedPayload`] under `address`, overwriting any
    /// previous registration -- idempotent, mirroring `DbMonadMessages::put`'s "overwrite" model.
    /// Monotonic-timestamp enforcement (rejecting a stale re-registration) is the caller's job
    /// (see `Registry::put_monad_profile`), the same layering `Registry::put_metadata` uses for
    /// the Lotus path.
    ///
    /// Also indexes `address` by the registration's own `timestamp` (ticket #75's `list_since`),
    /// decoded from `signed.payload` as a [`proto::MonadProfile`]. If a profile already existed
    /// under `address`, its old by-time index entry is removed first (in the same batch) so an
    /// update with a new `timestamp` doesn't leave a stale, orphaned index row behind -- mirrors
    /// `DbMonadMessages::put`'s identical "remove old index entry on overwrite" handling.
    pub fn put(
        &self,
        address: &Address,
        signed: &cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let profile = proto::MonadProfile::decode(signed.payload.as_slice())
            .wrap_err_with(|| CannotDecodeMonadProfile(hex::encode(&signed.payload)))?;

        let mut batch = rocksdb::WriteBatch::default();
        if let Some(existing) = self.get(address)? {
            if let Ok(existing_profile) = proto::MonadProfile::decode(existing.payload.as_slice())
            {
                batch.delete_cf(
                    self.cf_monad_profiles_by_time,
                    by_time_key(existing_profile.timestamp, &address.0),
                );
            }
        }
        batch.put_cf(self.cf_monad_profiles, address.0, signed.encode_to_vec());
        batch.put_cf(
            self.cf_monad_profiles_by_time,
            by_time_key(profile.timestamp, &address.0),
            address.0.to_vec(),
        );
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

    /// List every `(address, SignedPayload)` registered with the profile's own `timestamp >=
    /// since` (milliseconds since the Unix epoch), ordered by `timestamp` ascending (ticket #75).
    /// Lets a client (e.g. a bot auto-greeting/auto-funding new signups) discover newly-registered
    /// profiles by polling with an advancing cursor, without already knowing their addresses out
    /// of band -- mirrors `DbMonadMessages::list_since` exactly.
    pub fn list_since(
        &self,
        since: i64,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        let start_key = by_time_key(since, &[]);
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_profiles_by_time,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        iter.map(|item| {
            let (_, address_bytes) = item?;
            let address = Address(
                address_bytes
                    .as_ref()
                    .try_into()
                    .map_err(|_| InvalidIndexedAddress(hex::encode(&address_bytes)))?,
            );
            let signed = self.get(&address)?.ok_or_else(|| {
                CannotDecodeSignedPayload(format!(
                    "indexed address {} has no primary record",
                    hex::encode(address.0)
                ))
            })?;
            Ok((address, signed))
        })
        .collect()
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_PROFILES,
            rocksdb::Options::default(),
        ));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_PROFILES_BY_TIME,
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
    use prost::Message;

    use crate::{monad_http::Address, proto, store::db::Db};

    /// `timestamp` is a real field now (ticket #75's by-time index decodes it), not just a seed
    /// for varying the `sig` bytes -- callers pick it explicitly so tests can assert ordering.
    fn sample_signed_payload(timestamp: i64) -> cashweb_payload::proto::SignedPayload {
        let profile = proto::MonadProfile {
            timestamp,
            ttl: 0,
            entries: vec![],
        };
        cashweb_payload::proto::SignedPayload {
            pubkey: vec![2; 33],
            sig: vec![1; 5],
            sig_scheme: 1,
            payload: profile.encode_to_vec(),
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

        let signed = sample_signed_payload(100);
        db.monad_profiles().put(&address, &signed)?;
        assert_eq!(db.monad_profiles().get(&address)?, Some(signed.clone()));

        // A different address is unaffected.
        let other_address = Address([8u8; 20]);
        assert_eq!(db.monad_profiles().get(&other_address)?, None);

        // Overwriting replaces the stored value.
        let updated = sample_signed_payload(200);
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

    #[test]
    fn test_list_since_orders_by_timestamp_and_respects_cursor() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-list-since")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_profiles();

        let early = Address([1u8; 20]);
        let middle = Address([2u8; 20]);
        let late = Address([3u8; 20]);

        // Inserted out of order to prove list_since sorts by timestamp, not insertion order.
        store.put(&late, &sample_signed_payload(300))?;
        store.put(&early, &sample_signed_payload(100))?;
        store.put(&middle, &sample_signed_payload(200))?;

        assert_eq!(
            store.list_since(0)?,
            vec![
                (early, sample_signed_payload(100)),
                (middle, sample_signed_payload(200)),
                (late, sample_signed_payload(300)),
            ]
        );
        assert_eq!(
            store.list_since(200)?,
            vec![
                (middle, sample_signed_payload(200)),
                (late, sample_signed_payload(300)),
            ]
        );
        assert_eq!(store.list_since(301)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_list_since_after_retry_with_new_timestamp_has_no_stale_entry() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new(
            "cashweb-registry-store--monad-profiles-list-since-retry",
        )?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_profiles();
        let address = Address([7u8; 20]);

        store.put(&address, &sample_signed_payload(100))?;
        // Re-registering under a later timestamp must remove the old by-time index entry, not
        // just add a new one -- otherwise list_since(0) would return this address twice.
        let retried = sample_signed_payload(200);
        store.put(&address, &retried)?;

        assert_eq!(store.list_since(0)?, vec![(address, retried)]);

        Ok(())
    }
}
