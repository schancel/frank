//! EVM-addressed profile records and transactional timestamp/name indexes.
//!
//! Records use the existing 20-byte address keys and exact retained protobuf or canonical CBOR
//! bytes. `p/`, `pt/`, `pn/` and `pc` are persistent protocol facts and remain unchanged. Profile
//! replacement updates the record and its derived indexes in one transaction. Historical
//! protobuf DTO names are retained; their names do not define this store's network identity.

use frank_cbor::message_types::TYPE_DIRECTORY_ATTESTATION;
use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use thiserror::Error;

use crate::{
    evm_rpc::Address,
    proto,
    store::{
        db::{get_value, mark_format, prefix_end, put_value, Db, SCAN_BATCH},
        kv_store::{key_after, KvTransaction},
    },
};

const PROFILES_PREFIX: &[u8] = b"p/";
const BY_TIME_PREFIX: &[u8] = b"pt/";
const BY_NAME_PREFIX: &[u8] = b"pn/";
const COUNT_KEY: &[u8] = b"pc";

fn profile_key(address: &[u8]) -> Vec<u8> {
    [PROFILES_PREFIX, address].concat()
}

/// Server-side clamp on how many results [`DbEvmProfiles::search_by_name`] (and therefore `GET
/// /metadata/monad/search`) will ever return in one page, regardless of what a caller requests --
/// matches `/metadata`'s existing Lotus range-endpoint convention
/// (`crate::http::server::handle_get_metadata_range`'s `MAX_NUM_ITEMS`).
pub const MAX_SEARCH_RESULTS: usize = 100;

/// Build the by-time index (`pt/`) key for a given `(timestamp, address)` pair. Kept as a
/// free function so [`DbEvmProfiles::put`] and [`DbEvmProfiles::list_since`] can't disagree on
/// the encoding -- mirrors `store::monad_messages::by_time_key` exactly.
fn by_time_key(timestamp: i64, address: &[u8]) -> Vec<u8> {
    [BY_TIME_PREFIX, timestamp.to_be_bytes().as_ref(), address].concat()
}

/// Build the by-name index (`pn/`) key for a given `(normalized_name, address)` pair. Kept
/// as a free function so [`DbEvmProfiles::put`] and [`DbEvmProfiles::search_by_name`] can't
/// disagree on the encoding -- mirrors [`by_time_key`] exactly.
fn by_name_key(normalized_name: &str, address: &[u8]) -> Vec<u8> {
    [BY_NAME_PREFIX, normalized_name.as_bytes(), address].concat()
}

/// Lowercase-normalize a raw display-name string -- the same normalization applied both when
/// indexing a profile's `display_name` entry ([`normalized_display_name`]) and when a search
/// prefix is submitted ([`DbEvmProfiles::search_by_name`]), so the two can't drift. Trims
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
pub struct DbEvmProfiles<'a> {
    db: &'a Db,
}

/// The record a profile replace writes, with the index facts derived from it.
#[derive(Debug, Clone)]
pub struct ProfileRow {
    /// Exact stored bytes (`SignedPayload` or Frank-CBOR frame).
    pub raw: Vec<u8>,
    /// Registration timestamp, milliseconds since the Unix epoch.
    pub timestamp_ms: i64,
    /// Normalized display name to index, if any.
    pub normalized_name: Option<String>,
}

impl ProfileRow {
    /// The row for a protobuf registration.
    pub fn protobuf(signed: &cashweb_payload::proto::SignedPayload) -> Result<Self> {
        let profile = proto::MonadProfile::decode(signed.payload.as_slice())
            .wrap_err_with(|| CannotDecodeEvmProfile(hex::encode(&signed.payload)))?;
        Ok(Self {
            raw: signed.encode_to_vec(),
            timestamp_ms: profile.timestamp,
            normalized_name: normalized_display_name(&profile),
        })
    }
}

/// Errors indicating some Monad-profile store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbEvmProfilesError {
    /// Database contains an invalid protobuf `SignedPayload`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode SignedPayload: {0}")]
    CannotDecodeSignedPayload(String),

    /// A `SignedPayload`'s `payload` field isn't a valid `proto::MonadProfile` -- ticket #75's
    /// by-time index needs to decode this to get the registration's `timestamp`. In practice this
    /// can't happen via the real `PUT /metadata/monad/:addr` path (`Registry::put_evm_profile`
    /// already requires a valid `MonadProfile` to check the monotonic-timestamp invariant before
    /// ever calling `DbEvmProfiles::put`), so this is a caller-contract violation, not a
    /// reachable runtime state.
    #[critical()]
    #[error("Cannot index profile by time: payload doesn't decode as MonadProfile: {0}")]
    CannotDecodeEvmProfile(String),

    /// Database contains an invalid by-time index entry (not a 20-byte Monad address).
    #[critical()]
    #[error("Inconsistent db: by-time index value isn't a 20-byte address: {0}")]
    InvalidIndexedAddress(String),
}

use self::DbEvmProfilesError::*;

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
    /// Exact type-1 directory statement frame bytes, suitable as `PriorStatement::Frame`.
    pub type_4_frame: Vec<u8>,
}

/// Extract the parsed inner Type-1 directory statement and its exact frame bytes from a
/// stored Type-2 directory attestation without running Stage 10 key-transition semantic
/// assertions that require a `prior` statement.
fn extract_cbor_directory_statement(
    raw_bytes: &[u8],
) -> Option<(frank_cbor::ParsedFrame, Vec<u8>)> {
    if !is_cbor_frame(raw_bytes) {
        return None;
    }
    let ctx = frank_cbor::ValidationContext {
        operation: frank_cbor::Operation::Generic,
        route_byte_limit: frank_cbor::MAX_FRAME_BYTES as u64,
        reader_version: 2,
        supported_schemas: frank_cbor::default_context().supported_schemas,
        opaque_retention_allowed: false,
        prior: frank_cbor::PriorStatement::None,
    };
    if let Ok(frank_cbor::ValidationResult::Parsed(parsed)) =
        frank_cbor::validate_frame(raw_bytes, &ctx)
    {
        if parsed.type_id == TYPE_DIRECTORY_ATTESTATION {
            if let frank_cbor::CborValue::Map(entries) = &parsed.payload {
                if let Some((_, frank_cbor::CborValue::Bytes(stmt_bytes))) =
                    entries.iter().find(|(k, _)| *k == 0)
                {
                    let stmt_ctx = frank_cbor::ValidationContext {
                        operation: frank_cbor::Operation::Typed,
                        route_byte_limit: frank_cbor::MAX_FRAME_BYTES as u64,
                        reader_version: 2,
                        supported_schemas: frank_cbor::default_context().supported_schemas,
                        opaque_retention_allowed: false,
                        prior: frank_cbor::PriorStatement::None,
                    };
                    if let Ok(frank_cbor::ValidationResult::Parsed(stmt_parsed)) =
                        frank_cbor::validate_frame(stmt_bytes, &stmt_ctx)
                    {
                        return Some((stmt_parsed, stmt_bytes.clone()));
                    }
                }
            }
        }
    }
    None
}

fn parse_index_info(raw_bytes: &[u8]) -> Option<StoredProfileIndexInfo> {
    if is_cbor_frame(raw_bytes) {
        if let Some((statement, _)) = extract_cbor_directory_statement(raw_bytes) {
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

/// Statement metadata (revision, timestamp_ms and type-1 statement frame bytes) of stored
/// Frank-CBOR registration bytes, for monotonic revision checks; `None` for anything else.
pub fn cbor_statement_info(raw: &[u8]) -> Option<CborStatementInfo> {
    if !is_cbor_frame(raw) {
        return None;
    }
    let (statement, type_4_frame) = extract_cbor_directory_statement(raw)?;
    let frank_cbor::TypedPayload::DirectoryStatement {
        revision,
        timestamp,
        ..
    } = statement.typed.as_deref()?
    else {
        return None;
    };
    let timestamp_ms = frank_cbor::join_ms(timestamp.seconds, timestamp.nanoseconds)
        .ok()
        .and_then(|ms| ms.try_into().ok())
        .unwrap_or(0);
    Some(CborStatementInfo {
        revision: *revision,
        timestamp_ms,
        type_4_frame,
    })
}

fn indexed_address(bytes: &[u8]) -> Result<Address> {
    Ok(Address(
        bytes
            .try_into()
            .map_err(|_| InvalidIndexedAddress(hex::encode(bytes)))?,
    ))
}

/// The primary record an index row points to; its absence is an inconsistent database.
fn indexed_record(tx: &mut dyn KvTransaction, address: &Address) -> Result<Vec<u8>> {
    Ok(get_value(tx, &profile_key(&address.0))?.ok_or_else(|| {
        CannotDecodeSignedPayload(format!(
            "indexed address {} has no primary record",
            hex::encode(address.0)
        ))
    })?)
}

impl<'a> DbEvmProfiles<'a> {
    /// Create a new [`DbEvmProfiles`] instance.
    pub fn new(db: &'a Db) -> Self {
        DbEvmProfiles { db }
    }

    /// Replace the profile at `address` in one transaction. `decide` receives the stored bytes
    /// (if any) read in that transaction and returns the new row, or an error that leaves the
    /// stored profile untouched. It may run more than once and must have no other effects.
    /// The new record is written, the old record's index rows (whether protobuf or CBOR) are
    /// removed and the new ones added, together.
    pub fn replace(
        &self,
        address: &Address,
        mut decide: impl FnMut(Option<&[u8]>) -> Result<ProfileRow>,
    ) -> Result<()> {
        let key = profile_key(&address.0);
        self.db.transact(|tx| {
            let existing = get_value(tx, &key)?;
            let row = decide(existing.as_deref())?;
            match existing.as_deref().and_then(parse_index_info) {
                Some(info) => {
                    tx.clear(&by_time_key(info.timestamp_ms, &address.0))?;
                    if let Some(old_name) = info.normalized_name {
                        tx.clear(&by_name_key(&old_name, &address.0))?;
                    }
                }
                None if existing.is_none() => tx.atomic_add(COUNT_KEY, 1)?,
                None => {}
            }
            mark_format(tx)?;
            put_value(tx, &key, &row.raw)?;
            tx.set(&by_time_key(row.timestamp_ms, &address.0), &address.0)?;
            if let Some(name) = &row.normalized_name {
                tx.set(&by_name_key(name, &address.0), &address.0)?;
            }
            Ok(())
        })
    }

    /// Store raw profile bytes (`SignedPayload` or Frank-CBOR frame) under `address`,
    /// unconditionally replacing any stored profile and its index rows.
    pub fn put_raw(
        &self,
        address: &Address,
        raw_bytes: &[u8],
        timestamp_ms: i64,
        normalized_name: Option<&str>,
    ) -> Result<()> {
        self.replace(address, |_| {
            Ok(ProfileRow {
                raw: raw_bytes.to_vec(),
                timestamp_ms,
                normalized_name: normalized_name.map(str::to_owned),
            })
        })
    }

    /// Store a [`cashweb_payload::proto::SignedPayload`] under `address`, overwriting any
    /// previous registration -- idempotent, mirroring `DbMonadMessages::put`'s "overwrite" model.
    pub fn put(
        &self,
        address: &Address,
        signed: &cashweb_payload::proto::SignedPayload,
    ) -> Result<()> {
        let row = ProfileRow::protobuf(signed)?;
        self.replace(address, |_| Ok(row.clone()))
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
        let key = profile_key(&address.0);
        self.db.transact(|tx| get_value(tx, &key))
    }

    /// Count current profile rows without decoding payloads or returning addresses.
    pub fn count_records(&self) -> Result<u64> {
        let count = self.db.transact(|tx| Ok(tx.get(COUNT_KEY)?))?;
        Ok(count.map_or(0, |bytes| {
            let mut le = [0u8; 8];
            let len = bytes.len().min(8);
            le[..len].copy_from_slice(&bytes[..len]);
            u64::from_le_bytes(le)
        }))
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
            if let Some((statement, _)) = extract_cbor_directory_statement(&raw) {
                if let Some(frank_cbor::TypedPayload::DirectoryStatement { subject, .. }) =
                    statement.typed.as_deref()
                {
                    return Ok(Some(subject.key_bytes.clone()));
                }
            }
            return Ok(None);
        }
        let signed = cashweb_payload::proto::SignedPayload::decode(raw.as_slice())
            .wrap_err_with(|| CannotDecodeSignedPayload(hex::encode(&raw)))?;
        Ok(Some(signed.pubkey))
    }

    /// Extract statement metadata (revision, timestamp_ms, and type-1 statement frame bytes)
    /// from a stored Frank-CBOR directory registration, for monotonic revision checks.
    pub fn get_cbor_statement_info(&self, address: &Address) -> Result<Option<CborStatementInfo>> {
        Ok(self
            .get_raw(address)?
            .and_then(|raw| cbor_statement_info(&raw)))
    }

    /// List every `(address, raw_bytes)` registered with timestamp >= `since`, ordered by
    /// timestamp ascending. Each transaction reads [`SCAN_BATCH`] index rows and their records,
    /// so a batch is consistent; a profile replaced during the listing can appear at both its
    /// old and its new timestamp, still in ascending order.
    pub fn list_since_raw(&self, since: i64) -> Result<Vec<(Address, Vec<u8>)>> {
        let mut start = by_time_key(since, &[]);
        let end = prefix_end(BY_TIME_PREFIX);
        let mut results = Vec::new();
        loop {
            let (batch, next) = self.db.transact(|tx| {
                let rows = tx.get_range(&start, &end, SCAN_BATCH)?;
                let next = (rows.len() == SCAN_BATCH)
                    .then(|| rows.last().map(|(key, _)| key_after(key)))
                    .flatten();
                let mut batch = Vec::with_capacity(rows.len());
                for (_, address_bytes) in rows {
                    let address = indexed_address(&address_bytes)?;
                    batch.push((address, indexed_record(tx, &address)?));
                }
                Ok((batch, next))
            })?;
            results.extend(batch);
            match next {
                Some(next) => start = next,
                None => return Ok(results),
            }
        }
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

    /// Prefix-search the by-name index for every profile whose normalized `display_name`
    /// starts with `prefix`, returning `(address, raw_bytes)` pairs, in one transaction.
    pub fn search_by_name_raw(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<(Address, Vec<u8>)>> {
        let limit = limit.min(MAX_SEARCH_RESULTS);
        let start = by_name_key(&normalize_name(prefix), &[]);
        self.db.transact(|tx| {
            let rows = tx.scan_prefix(&start, None, limit)?;
            let mut results = Vec::with_capacity(rows.len());
            for (_, address_bytes) in rows {
                let address = indexed_address(&address_bytes)?;
                results.push((address, indexed_record(tx, &address)?));
            }
            Ok(results)
        })
    }

    /// Prefix-search the by-name index returning decoded protobuf `SignedPayload`s.
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
}

impl Debug for DbEvmProfiles<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbEvmProfiles {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;
    use prost::Message;

    use crate::{evm_rpc::Address, proto, store::db::Db};

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
    fn test_db_evm_profiles() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let db = Db::open(&db_path)?;
        let address = Address([7u8; 20]);

        assert_eq!(db.evm_profiles().get(&address)?, None);
        assert_eq!(db.evm_profiles().count_records()?, 0);

        let signed = sample_signed_payload(100);
        db.evm_profiles().put(&address, &signed)?;
        assert_eq!(db.evm_profiles().count_records()?, 1);
        assert_eq!(db.evm_profiles().get(&address)?, Some(signed.clone()));

        // A different address is unaffected.
        let other_address = Address([8u8; 20]);
        assert_eq!(db.evm_profiles().get(&other_address)?, None);

        // Overwriting replaces the stored value.
        let updated = sample_signed_payload(200);
        db.evm_profiles().put(&address, &updated)?;
        assert_eq!(db.evm_profiles().count_records()?, 1);
        assert_eq!(db.evm_profiles().get(&address)?, Some(updated.clone()));

        drop(db);
        let reopened = Db::open(&db_path)?;
        assert_eq!(
            reopened.evm_profiles().get(&address)?,
            Some(updated),
            "Monad profiles must survive a server/database restart"
        );

        Ok(())
    }

    #[test]
    fn test_db_evm_profiles_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(format!("{:?}", db.evm_profiles()), "DbEvmProfiles { .. }");
        Ok(())
    }

    #[test]
    fn test_list_since_orders_by_timestamp_and_respects_cursor() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-profiles-list-since")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.evm_profiles();

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
        let store = db.evm_profiles();
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
        let store = db.evm_profiles();

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
        let store = db.evm_profiles();
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
        let store = db.evm_profiles();

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
