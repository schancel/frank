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
//!
//! ## `search_by_name` (ticket #48)
//!
//! `CF_MONAD_PROFILES_BY_NAME` is a second secondary index, keyed by `normalized_name.as_bytes()
//! ++ address` (value: the raw address), maintained alongside `CF_MONAD_PROFILES_BY_TIME` on
//! every [`DbMonadProfiles::put`]. `normalized_name` is the first `entries` item with `kind ==
//! "display_name"`, its `body` decoded as UTF-8 and lowercased -- see
//! [`normalized_display_name`]. A profile with no `display_name` entry, an empty/whitespace-only
//! one, or one whose body isn't valid UTF-8, isn't indexed at all (nothing to search on; this is a
//! best-effort optional field, not an error). Keeping the raw (unhashed) UTF-8 bytes as the key
//! prefix -- unlike `CF_MONAD_TOPIC_POSTS_BY_TOPIC`'s hashed-topic index -- is deliberate: this
//! index's whole purpose is prefix scanning ([`DbMonadProfiles::search_by_name`]), and hashing
//! would destroy the sort order a prefix scan depends on. Search is intentionally prefix-only (not
//! fuzzy) for this first pass, matching ticket #48's own scoping decision.

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use thiserror::Error;

use crate::{
    monad_http::Address,
    proto,
    store::db::{Db, CF, CF_MONAD_PROFILES, CF_MONAD_PROFILES_BY_NAME, CF_MONAD_PROFILES_BY_TIME},
};

/// Server-side clamp on how many results [`DbMonadProfiles::search_by_name`] (and therefore `GET
/// /metadata/monad/search`) will ever return in one page, regardless of what a caller requests --
/// matches `/metadata`'s existing Lotus range-endpoint convention
/// (`crate::http::server::handle_get_metadata_range`'s `MAX_NUM_ITEMS`).
pub const MAX_SEARCH_RESULTS: usize = 100;

/// Build the `CF_MONAD_PROFILES_BY_TIME` key for a given `(timestamp, address)` pair. Kept as a
/// free function so [`DbMonadProfiles::put`] and [`DbMonadProfiles::list_since`] can't disagree on
/// the encoding -- mirrors `store::monad_messages::by_time_key` exactly.
fn by_time_key(timestamp: i64, address: &[u8]) -> Vec<u8> {
    [timestamp.to_be_bytes().as_ref(), address].concat()
}

/// Build the `CF_MONAD_PROFILES_BY_NAME` key for a given `(normalized_name, address)` pair. Kept
/// as a free function so [`DbMonadProfiles::put`] and [`DbMonadProfiles::search_by_name`] can't
/// disagree on the encoding -- mirrors [`by_time_key`] exactly.
fn by_name_key(normalized_name: &str, address: &[u8]) -> Vec<u8> {
    [normalized_name.as_bytes(), address].concat()
}

/// Lowercase-normalize a raw display-name string -- the same normalization applied both when
/// indexing a profile's `display_name` entry ([`normalized_display_name`]) and when a search
/// prefix is submitted ([`DbMonadProfiles::search_by_name`]), so the two can't drift. Trims
/// leading/trailing whitespace first; an empty result means "nothing to search on".
fn normalize_name(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Extract and normalize `profile`'s `display_name`, if it has one worth indexing (ticket #48):
/// the first `entries` item with `kind == "display_name"`, its `body` decoded as UTF-8 and
/// lowercased via [`normalize_name`]. Returns [`None`] -- not an error -- if there's no such
/// entry, its body isn't valid UTF-8, or the normalized name is empty; a malformed/absent optional
/// field must never fail the whole `put`.
fn normalized_display_name(profile: &proto::MonadProfile) -> Option<String> {
    let entry = profile
        .entries
        .iter()
        .find(|entry| entry.kind == "display_name")?;
    let raw = std::str::from_utf8(&entry.body).ok()?;
    let normalized = normalize_name(raw);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Allows access to stored Monad-native profile registrations.
pub struct DbMonadProfiles<'a> {
    db: &'a Db,
    cf_monad_profiles: &'a CF,
    cf_monad_profiles_by_time: &'a CF,
    cf_monad_profiles_by_name: &'a CF,
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

/// Check if a byte slice begins with Frank-CBOR magic (`FRAME_MAGIC`) and version 1.
pub fn is_cbor_frame(bytes: &[u8]) -> bool {
    bytes.starts_with(b"FRNK\x01")
}

/// Key information extracted from an existing stored profile for index cleanup.
#[derive(Debug, Clone)]
pub struct StoredProfileIndexInfo {
    /// Milliseconds since Unix epoch.
    pub timestamp_ms: i64,
    /// Normalized display name, if any.
    pub normalized_name: Option<String>,
}

/// Metadata extracted from a stored Frank-CBOR directory attestation.
#[derive(Debug, Clone)]
pub struct CborStatementInfo {
    /// Statement revision (field 2).
    pub revision: u64,
    /// Statement timestamp in milliseconds (join_ms).
    pub timestamp_ms: i64,
    /// Exact type-4 directory statement frame bytes, suitable as `PriorStatement::Frame`.
    pub type_4_frame: Vec<u8>,
}

fn parse_index_info(raw_bytes: &[u8]) -> Option<StoredProfileIndexInfo> {
    if is_cbor_frame(raw_bytes) {
        let ctx = frank_cbor::ValidationContext {
            operation: frank_cbor::Operation::Typed,
            route_byte_limit: frank_cbor::MAX_FRAME_BYTES as u64,
            reader_version: 2,
            supported_schemas: frank_cbor::default_context().supported_schemas,
            opaque_retention_allowed: false,
            prior: frank_cbor::PriorStatement::None,
        };
        if let Ok(frank_cbor::ValidationResult::Parsed(parsed)) =
            frank_cbor::validate_frame(raw_bytes, &ctx)
        {
            if let Some(frank_cbor::TypedPayload::DirectoryAttestation { statement, .. }) =
                parsed.typed.as_deref()
            {
                if let Some(frank_cbor::TypedPayload::DirectoryStatement {
                    timestamp,
                    profile_entries,
                    ..
                }) = statement.typed.as_deref()
                {
                    let timestamp_ms: i64 =
                        frank_cbor::join_ms(timestamp.seconds, timestamp.nanoseconds)
                            .ok()?
                            .try_into()
                            .ok()?;
                    let normalized_name = profile_entries.as_ref().and_then(|entries| {
                        entries
                            .iter()
                            .find(|e| e.kind == "display_name")
                            .and_then(|e| {
                                let raw = std::str::from_utf8(&e.body).ok()?;
                                let norm = normalize_name(raw);
                                if norm.is_empty() {
                                    None
                                } else {
                                    Some(norm)
                                }
                            })
                    });
                    return Some(StoredProfileIndexInfo {
                        timestamp_ms,
                        normalized_name,
                    });
                }
            }
        }
        None
    } else {
        let signed = cashweb_payload::proto::SignedPayload::decode(raw_bytes).ok()?;
        let profile = proto::MonadProfile::decode(signed.payload.as_slice()).ok()?;
        Some(StoredProfileIndexInfo {
            timestamp_ms: profile.timestamp,
            normalized_name: normalized_display_name(&profile),
        })
    }
}

impl<'a> DbMonadProfiles<'a> {
    /// Create a new [`DbMonadProfiles`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_profiles = db.cf(CF_MONAD_PROFILES).unwrap();
        let cf_monad_profiles_by_time = db.cf(CF_MONAD_PROFILES_BY_TIME).unwrap();
        let cf_monad_profiles_by_name = db.cf(CF_MONAD_PROFILES_BY_NAME).unwrap();
        DbMonadProfiles {
            db,
            cf_monad_profiles,
            cf_monad_profiles_by_time,
            cf_monad_profiles_by_name,
        }
    }

    /// Store raw profile bytes (`SignedPayload` or Frank-CBOR frame) under `address`,
    /// atomically updating primary storage and secondary indices (`CF_MONAD_PROFILES_BY_TIME`
    /// and `CF_MONAD_PROFILES_BY_NAME`). Any stale secondary index entries from a previously
    /// stored profile (whether protobuf or CBOR) are cleaned up in the same batch.
    pub fn put_raw(
        &self,
        address: &Address,
        raw_bytes: &[u8],
        timestamp_ms: i64,
        normalized_name: Option<&str>,
    ) -> Result<()> {
        let mut batch = rocksdb::WriteBatch::default();
        if let Some(existing_bytes) = self.get_raw(address)? {
            if let Some(info) = parse_index_info(&existing_bytes) {
                batch.delete_cf(
                    self.cf_monad_profiles_by_time,
                    by_time_key(info.timestamp_ms, &address.0),
                );
                if let Some(old_name) = info.normalized_name {
                    batch.delete_cf(
                        self.cf_monad_profiles_by_name,
                        by_name_key(&old_name, &address.0),
                    );
                }
            }
        }
        batch.put_cf(self.cf_monad_profiles, address.0, raw_bytes);
        batch.put_cf(
            self.cf_monad_profiles_by_time,
            by_time_key(timestamp_ms, &address.0),
            address.0,
        );
        if let Some(new_name) = normalized_name {
            batch.put_cf(
                self.cf_monad_profiles_by_name,
                by_name_key(new_name, &address.0),
                address.0,
            );
        }
        self.db.write_batch(batch)?;
        Ok(())
    }

    /// Store a [`cashweb_payload::proto::SignedPayload`] under `address`, overwriting any
    /// previous registration -- idempotent, mirroring `DbMonadMessages::put`'s "overwrite" model.
    pub fn put(
        &self,
        address: &Address,
        signed: &cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let profile = proto::MonadProfile::decode(signed.payload.as_slice())
            .wrap_err_with(|| CannotDecodeMonadProfile(hex::encode(&signed.payload)))?;
        let name = normalized_display_name(&profile);
        self.put_raw(
            address,
            &signed.encode_to_vec(),
            profile.timestamp,
            name.as_deref(),
        )
    }

    /// Store a canonical Frank-CBOR type-2 account registration frame under `address`.
    pub fn put_cbor(
        &self,
        address: &Address,
        frame_bytes: &[u8],
        timestamp_ms: i64,
        normalized_name: Option<&str>,
    ) -> Result<()> {
        self.put_raw(address, frame_bytes, timestamp_ms, normalized_name)
    }

    /// Retrieve raw bytes previously registered under `address`, or [`None`] if not found.
    pub fn get_raw(&self, address: &Address) -> Result<Option<Vec<u8>>> {
        let serialized = match self.db.get(self.cf_monad_profiles, address.0)? {
            Some(serialized) => serialized.as_ref().to_vec(),
            None => return Ok(None),
        };
        Ok(Some(serialized))
    }

    /// Retrieve a [`cashweb_payload::proto::SignedPayload`] previously registered under
    /// `address`. Returns [`None`] if nothing is registered or if the record is a CBOR frame.
    pub fn get(&self, address: &Address) -> Result<Option<cashweb_payload::proto::SignedPayload>> {
        let raw = match self.get_raw(address)? {
            Some(raw) => raw,
            None => return Ok(None),
        };
        if is_cbor_frame(&raw) {
            return Ok(None);
        }
        let signed = cashweb_payload::proto::SignedPayload::decode(raw.as_slice())
            .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&raw)))?;
        Ok(Some(signed))
    }

    /// Retrieve the 33-byte compressed secp256k1 public key of the registered profile,
    /// whether stored as legacy protobuf or canonical Frank-CBOR.
    pub fn get_pubkey(&self, address: &Address) -> Result<Option<Vec<u8>>> {
        let raw = match self.get_raw(address)? {
            Some(raw) => raw,
            None => return Ok(None),
        };
        if is_cbor_frame(&raw) {
            let ctx = frank_cbor::ValidationContext {
                operation: frank_cbor::Operation::Typed,
                route_byte_limit: frank_cbor::MAX_FRAME_BYTES as u64,
                reader_version: 2,
                supported_schemas: frank_cbor::default_context().supported_schemas,
                opaque_retention_allowed: false,
                prior: frank_cbor::PriorStatement::None,
            };
            if let Ok(frank_cbor::ValidationResult::Parsed(parsed)) =
                frank_cbor::validate_frame(&raw, &ctx)
            {
                if let Some(frank_cbor::TypedPayload::DirectoryAttestation { statement, .. }) =
                    parsed.typed.as_deref()
                {
                    if let Some(frank_cbor::TypedPayload::DirectoryStatement { subject, .. }) =
                        statement.typed.as_deref()
                    {
                        return Ok(Some(subject.key_bytes.clone()));
                    }
                }
            }
            return Ok(None);
        }
        let signed = cashweb_payload::proto::SignedPayload::decode(raw.as_slice())
            .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&raw)))?;
        Ok(Some(signed.pubkey))
    }

    /// Extract statement metadata (revision, timestamp_ms, and type-4 statement frame bytes)
    /// from a stored Frank-CBOR directory registration, for monotonic revision checks.
    pub fn get_cbor_statement_info(&self, address: &Address) -> Result<Option<CborStatementInfo>> {
        let raw = match self.get_raw(address)? {
            Some(raw) => raw,
            None => return Ok(None),
        };
        if !is_cbor_frame(&raw) {
            return Ok(None);
        }
        let ctx = frank_cbor::ValidationContext {
            operation: frank_cbor::Operation::Typed,
            route_byte_limit: frank_cbor::MAX_FRAME_BYTES as u64,
            reader_version: 2,
            supported_schemas: frank_cbor::default_context().supported_schemas,
            opaque_retention_allowed: false,
            prior: frank_cbor::PriorStatement::None,
        };
        if let Ok(frank_cbor::ValidationResult::Parsed(parsed)) =
            frank_cbor::validate_frame(&raw, &ctx)
        {
            if let Some(frank_cbor::TypedPayload::DirectoryAttestation { statement, .. }) =
                parsed.typed.as_deref()
            {
                if let Some(frank_cbor::TypedPayload::DirectoryStatement {
                    revision,
                    timestamp,
                    ..
                }) = statement.typed.as_deref()
                {
                    let timestamp_ms =
                        frank_cbor::join_ms(timestamp.seconds, timestamp.nanoseconds)
                            .ok()
                            .and_then(|ms| ms.try_into().ok())
                            .unwrap_or(0);
                    return Ok(Some(CborStatementInfo {
                        revision: *revision,
                        timestamp_ms,
                        type_4_frame: statement.frame.clone(),
                    }));
                }
            }
        }
        Ok(None)
    }

    /// List every `(address, raw_bytes)` registered with timestamp >= `since`, ordered by
    /// timestamp ascending.
    pub fn list_since_raw(&self, since: i64) -> Result<Vec<(Address, Vec<u8>)>> {
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
            let raw = self.get_raw(&address)?.ok_or_else(|| {
                CannotDecodeSignedPayload(format!(
                    "indexed address {} has no primary record",
                    hex::encode(address.0)
                ))
            })?;
            Ok((address, raw))
        })
        .collect()
    }

    /// List every `(address, SignedPayload)` registered with the profile's own `timestamp >=
    /// since`. CBOR records are omitted from the protobuf-specific view.
    pub fn list_since(
        &self,
        since: i64,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        let entries = self.list_since_raw(since)?;
        let mut results = Vec::new();
        for (address, raw) in entries {
            if is_cbor_frame(&raw) {
                continue;
            }
            let signed = cashweb_payload::proto::SignedPayload::decode(raw.as_slice())
                .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&raw)))?;
            results.push((address, signed));
        }
        Ok(results)
    }

    /// Prefix-search `CF_MONAD_PROFILES_BY_NAME` for every profile whose normalized `display_name`
    /// starts with `prefix`, returning `(address, raw_bytes)` pairs.
    pub fn search_by_name_raw(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<(Address, Vec<u8>)>> {
        let limit = limit.min(MAX_SEARCH_RESULTS);
        let normalized_prefix = normalize_name(prefix);
        let prefix_bytes = normalized_prefix.as_bytes();
        let start_key = by_name_key(&normalized_prefix, &[]);
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_profiles_by_name,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        let mut results = Vec::new();
        for item in iter {
            if results.len() == limit {
                break;
            }
            let (key, address_bytes) = item?;
            if !key.starts_with(prefix_bytes) {
                break;
            }
            let address = Address(
                address_bytes
                    .as_ref()
                    .try_into()
                    .map_err(|_| InvalidIndexedAddress(hex::encode(&address_bytes)))?,
            );
            let raw = self.get_raw(&address)?.ok_or_else(|| {
                CannotDecodeSignedPayload(format!(
                    "indexed address {} has no primary record",
                    hex::encode(address.0)
                ))
            })?;
            results.push((address, raw));
        }
        Ok(results)
    }

    /// Prefix-search `CF_MONAD_PROFILES_BY_NAME` returning decoded protobuf `SignedPayload`s.
    /// CBOR records are omitted from this legacy view.
    pub fn search_by_name(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<(Address, cashweb_payload::proto::SignedPayload)>> {
        let entries = self.search_by_name_raw(prefix, limit)?;
        let mut results = Vec::new();
        for (address, raw) in entries {
            if is_cbor_frame(&raw) {
                continue;
            }
            let signed = cashweb_payload::proto::SignedPayload::decode(raw.as_slice())
                .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&raw)))?;
            results.push((address, signed));
        }
        Ok(results)
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
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_PROFILES_BY_NAME,
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

    use super::{normalized_display_name, MAX_SEARCH_RESULTS};

    /// `timestamp` is a real field now (ticket #75's by-time index decodes it), not just a seed
    /// for varying the `sig` bytes -- callers pick it explicitly so tests can assert ordering.
    fn sample_signed_payload(timestamp: i64) -> cashweb_payload::proto::SignedPayload {
        sample_signed_payload_with_entries(timestamp, vec![])
    }

    /// Like [`sample_signed_payload`], but with caller-specified `entries` -- lets ticket #48's
    /// tests build a `display_name` `AddressEntry` (or, for the non-UTF8 test, one with an
    /// intentionally invalid body).
    fn sample_signed_payload_with_entries(
        timestamp: i64,
        entries: Vec<proto::AddressEntry>,
    ) -> cashweb_payload::proto::SignedPayload {
        let profile = proto::MonadProfile {
            timestamp,
            ttl: 0,
            entries,
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

    /// Like [`sample_signed_payload`], but with a `display_name` `AddressEntry` whose body is
    /// `name` (as raw bytes -- may be invalid UTF-8, for ticket #48's non-UTF8 test).
    fn sample_signed_payload_named(
        timestamp: i64,
        name: impl AsRef<[u8]>,
    ) -> cashweb_payload::proto::SignedPayload {
        sample_signed_payload_with_entries(
            timestamp,
            vec![proto::AddressEntry {
                kind: "display_name".to_string(),
                headers: Default::default(),
                body: name.as_ref().to_vec(),
            }],
        )
    }

    #[test]
    fn test_db_monad_profiles() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let db = Db::open(&db_path)?;
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
        assert_eq!(db.monad_profiles().get(&address)?, Some(updated.clone()));

        drop(db);
        let reopened = Db::open(&db_path)?;
        assert_eq!(
            reopened.monad_profiles().get(&address)?,
            Some(updated),
            "Monad profiles must survive a server/database restart"
        );

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
        let tempdir =
            tempdir::TempDir::new("cashweb-registry-store--monad-profiles-list-since-retry")?;
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

    #[test]
    fn test_normalized_display_name() {
        let named = |body: &[u8]| proto::MonadProfile {
            timestamp: 0,
            ttl: 0,
            entries: vec![proto::AddressEntry {
                kind: "display_name".to_string(),
                headers: Default::default(),
                body: body.to_vec(),
            }],
        };
        // Normal case: lowercased.
        assert_eq!(
            normalized_display_name(&named(b"AliceInWonderland")),
            Some("aliceinwonderland".to_string())
        );
        // Leading/trailing whitespace trimmed.
        assert_eq!(
            normalized_display_name(&named(b"  Bob  ")),
            Some("bob".to_string())
        );
        // No entries at all: nothing to index.
        assert_eq!(
            normalized_display_name(&proto::MonadProfile {
                timestamp: 0,
                ttl: 0,
                entries: vec![],
            }),
            None
        );
        // Entry present, but wrong kind: nothing to index.
        assert_eq!(
            normalized_display_name(&proto::MonadProfile {
                timestamp: 0,
                ttl: 0,
                entries: vec![proto::AddressEntry {
                    kind: "avatar".to_string(),
                    headers: Default::default(),
                    body: b"Alice".to_vec(),
                }],
            }),
            None
        );
        // Empty-string name: nothing to index.
        assert_eq!(normalized_display_name(&named(b"")), None);
        // Whitespace-only name: nothing to index.
        assert_eq!(normalized_display_name(&named(b"   ")), None);
        // Non-UTF8 body: nothing to index (not an error).
        assert_eq!(normalized_display_name(&named(&[0xff, 0xfe, 0xfd])), None);
    }

    #[test]
    fn test_search_by_name_prefix_matches_and_ordering() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-search")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_profiles();

        let alice = Address([1u8; 20]);
        let alicia = Address([2u8; 20]);
        let bob = Address([3u8; 20]);
        let no_name = Address([4u8; 20]);
        let empty_name = Address([5u8; 20]);
        let bad_utf8 = Address([6u8; 20]);

        let alice_payload = sample_signed_payload_named(100, "Alice");
        let alicia_payload = sample_signed_payload_named(101, "ALICIA");
        let bob_payload = sample_signed_payload_named(102, "Bob");
        let no_name_payload = sample_signed_payload(103);
        let empty_name_payload = sample_signed_payload_named(104, "");
        // An AddressEntry with kind "display_name" but a non-UTF8 body -- must not error the put,
        // and must not be indexed/searchable.
        let bad_utf8_payload = sample_signed_payload_named(105, [0xff, 0xfe, 0xfd]);

        store.put(&alice, &alice_payload)?;
        store.put(&alicia, &alicia_payload)?;
        store.put(&bob, &bob_payload)?;
        store.put(&no_name, &no_name_payload)?;
        store.put(&empty_name, &empty_name_payload)?;
        store.put(&bad_utf8, &bad_utf8_payload)?;

        // Prefix "ali" matches both "alice" and "alicia" (case-insensitively), not "bob".
        let mut results = store.search_by_name("ali", 10)?;
        results.sort_by_key(|(addr, _)| addr.0);
        let mut expected = vec![
            (alice, alice_payload.clone()),
            (alicia, alicia_payload.clone()),
        ];
        expected.sort_by_key(|(addr, _)| addr.0);
        assert_eq!(results, expected);

        // Search prefix itself is case-insensitive too.
        assert_eq!(
            store.search_by_name("ALI", 10)?.len(),
            2,
            "uppercase search prefix should still match lowercased index entries"
        );

        // Exact, non-overlapping prefix.
        assert_eq!(store.search_by_name("bob", 10)?, vec![(bob, bob_payload)]);

        // No match.
        assert_eq!(store.search_by_name("zzz", 10)?, vec![]);

        // Profiles with no name, an empty name, or a non-UTF8 name body are never returned by any
        // search, including the empty-prefix "match everything named" case.
        let all_named = store.search_by_name("", 10)?;
        let all_named_addresses: Vec<Address> = all_named.iter().map(|(addr, _)| *addr).collect();
        assert!(!all_named_addresses.contains(&no_name));
        assert!(!all_named_addresses.contains(&empty_name));
        assert!(!all_named_addresses.contains(&bad_utf8));
        assert_eq!(all_named_addresses.len(), 3); // alice, alicia, bob

        Ok(())
    }

    #[test]
    fn test_search_by_name_update_removes_stale_entry() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir =
            tempdir::TempDir::new("cashweb-registry-store--monad-profiles-search-update")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_profiles();
        let address = Address([9u8; 20]);

        store.put(&address, &sample_signed_payload_named(100, "OldName"))?;
        assert_eq!(store.search_by_name("old", 10)?.len(), 1);

        // Re-registering under a new name must remove the old by-name index entry, not just add a
        // new one -- otherwise searching by the old prefix would still find this address.
        let updated = sample_signed_payload_named(200, "NewName");
        store.put(&address, &updated)?;

        assert_eq!(store.search_by_name("old", 10)?, vec![]);
        assert_eq!(store.search_by_name("new", 10)?, vec![(address, updated)]);

        // Re-registering with the name removed entirely must also remove the old by-name index
        // entry.
        let unnamed = sample_signed_payload(300);
        store.put(&address, &unnamed)?;
        assert_eq!(store.search_by_name("new", 10)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_search_by_name_clamps_to_max_results() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-search-clamp")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_profiles();

        // Register more than MAX_SEARCH_RESULTS profiles sharing a common name prefix.
        let total = MAX_SEARCH_RESULTS + 5;
        for i in 0..total {
            let mut address_bytes = [0u8; 20];
            address_bytes[16..20].copy_from_slice(&(i as u32).to_be_bytes());
            let address = Address(address_bytes);
            let name = format!("shared-{i:04}");
            store.put(&address, &sample_signed_payload_named(i as i64, name))?;
        }

        // Even asking for more than the max, and more than `total`, yields at most
        // MAX_SEARCH_RESULTS.
        let results = store.search_by_name("shared", total * 2)?;
        assert_eq!(results.len(), MAX_SEARCH_RESULTS);

        Ok(())
    }
}
