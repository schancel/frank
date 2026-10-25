//! Module for `Db` and `DbError`.
//!
//! The registry's own state -- legacy address metadata, legacy topics, profiles, usernames and
//! their derived indexes -- lives in one [`RelayKvStore`]: a RocksDB on this replica's disk, or a
//! FoundationDB subspace shared by every replica. Every mutation is one transaction that writes
//! the authoritative record together with its index rows, so replicas never need a process lock
//! to agree. Reads that span many rows run in bounded batches of their own transactions.
//!
//! Key layout (one byte-string key space; FoundationDB adds the subspace prefix):
//!
//! | Prefix | Row | Owner |
//! |---|---|---|
//! | `F` | format marker [`REGISTRY_FORMAT`] | this module |
//! | `m/` pkh | legacy `SignedPayload<AddressMetadata>` | `metadata.rs` |
//! | `mt/` timestamp_be ++ pkh | empty; derived by-time index | `metadata.rs` |
//! | `tp/` payload hash | topic `SignedPayload` (all known burns merged) | `topics.rs` |
//! | `tm/` topic digest ++ timestamp_be ++ txid | payload-less message; derived | `topics.rs` |
//! | `tb/` txid | empty; burns already indexed | `topics.rs` |
//! | `p/` address | profile bytes (protobuf or Frank-CBOR) | `monad_profiles.rs` |
//! | `pt/` timestamp_be ++ address | address; derived by-time index | `monad_profiles.rs` |
//! | `pn/` normalized name ++ address | address; derived by-name index | `monad_profiles.rs` |
//! | `pc` | profile count (little-endian u64, atomic add); derived | `monad_profiles.rs` |
//! | `u/n` name | username record (JSON) | `directory_usernames.rs` |
//! | `u/a` address | name; derived reverse index | `directory_usernames.rs` |
//! | `x/` key ++ part_be32 | parts of a value longer than the store's value limit | this module |
//!
//! Every derived row is written in the same transaction as the record it is derived from, and
//! can be rebuilt by scanning that record's prefix. There is no reader for the column families
//! of earlier builds: a database written by one is refused at startup with what to delete.

use std::{
    fmt::Debug,
    path::{Path, PathBuf},
    sync::Arc,
};

use bitcoinsuite_error::{ErrorMeta, Report, Result, WrapErr};
use thiserror::Error;

use crate::store::directory_usernames::DbDirectoryUsernames;
use crate::store::kv_store::{
    KvError, KvTransaction, RelayKvStore, RocksDbKvStore, Transact, MAX_VALUE_BYTES,
};
use crate::store::metadata::DbMetadata;
use crate::store::monad_profiles::DbMonadProfiles;
use crate::store::topics::DbTopics;

/// Format marker key; present once any registry row has been written by this format.
const FORMAT_KEY: &[u8] = b"F";
/// The registry format this build reads and writes.
pub(crate) const REGISTRY_FORMAT: &[u8] = b"registry-kv-v1";
/// Prefix of the parts of a value split by [`put_value`].
const PART_PREFIX: &[u8] = b"x/";
/// Prefixes this owner writes, checked to be empty before the format marker is first written.
const OWNED_PREFIXES: &[&[u8]] = &[
    b"m/",
    b"mt/",
    b"tp/",
    b"tm/",
    b"tb/",
    b"p/",
    b"pt/",
    b"pn/",
    b"pc",
    b"u/",
    PART_PREFIX,
];
/// Rows read per transaction by scans that may cover the whole registry.
pub(crate) const SCAN_BATCH: usize = 64;

/// Registry database: the registry's transaction store, and the local directory that anchors
/// the owners not yet moved to a shared store (forum, and the single-node directory store).
pub struct Db {
    kv: Arc<dyn RelayKvStore>,
    /// The RocksDB driver when the store is on this replica's disk.
    local: Option<Arc<RocksDbKvStore>>,
    path: PathBuf,
    /// Lazy owner of the directory's transaction store (preview evidence, subjects, forwards).
    /// Ordinary startup never opens it.
    directory: super::directory_store::Owner,
}

/// Errors indicating something went wrong with the database itself.
#[derive(Debug, Error, ErrorMeta)]
pub enum DbError {
    /// Column family requested but not defined during `Db::open`.
    #[critical()]
    #[error("Column family {0} doesn't exist")]
    NoSuchColumnFamily(String),

    /// Error with RocksDB itself, e.g. db inconsistency.
    #[critical()]
    #[error("RocksDB error")]
    RocksDb,

    /// The registry transaction store failed. Nothing was committed, unless the error says the
    /// commit outcome is unknown.
    #[critical()]
    #[error("Registry store error: {0}")]
    Store(KvError),

    /// A stored value is split into parts that are missing or out of order.
    #[critical()]
    #[error("Inconsistent db: incomplete split value")]
    IncompleteSplitValue,

    /// The files on disk were written by an earlier development build.
    #[critical()]
    #[error(
        "The relay database at {path} was written by an earlier development build ({found}) \
         and this build has no reader for it. Development reset: stop the relay and delete \
         {delete}. These hold messages, profiles, topics and directory entries only: no keys \
         and no funds. Wallets keep their own keys and are not affected."
    )]
    OldFormat {
        /// The registry database path.
        path: String,
        /// What was found that this build cannot read.
        found: String,
        /// Everything to delete, as a shell-ready list of paths.
        delete: String,
    },

    /// The shared registry store holds rows of another format, or rows without a format marker.
    #[critical()]
    #[error(
        "The shared registry store holds {found}, which this build has no reader for. \
         Development reset: clear only this relay cluster's registry subspace \
         ({store}). It holds profiles, usernames, metadata and topics only: no keys and no funds."
    )]
    OldSharedFormat {
        /// The store (driver and subspace).
        store: String,
        /// What was found.
        found: String,
    },
}

use self::DbError::*;

impl From<KvError> for DbError {
    fn from(error: KvError) -> Self {
        Store(error)
    }
}

impl Db {
    /// Opens the registry on this replica's disk (the RocksDB driver) under `path`, creating it
    /// when absent.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        Self::refuse_old_message_store(path)?;
        Self::refuse_old_directory_sidecars(path)?;
        let local = match RocksDbKvStore::open(path) {
            Ok(store) => Arc::new(store),
            // RocksDB refuses to open a database holding tables it was not told about, which is
            // what a database from a build with column families looks like.
            Err(KvError::Backend(error)) => {
                return Err(match error.split("Column families not opened: ").nth(1) {
                    Some(tables) => Self::old_format(
                        path,
                        format!(
                            "tables {}",
                            tables
                                .split(['"', '\n', ')'])
                                .next()
                                .unwrap_or(tables)
                                .trim()
                        ),
                    )
                    .into(),
                    None => Report::new(Store(KvError::Backend(error))),
                })
            }
            Err(error) => return Err(Store(error).into()),
        };
        let db = Self::with_store(path, local.clone(), Some(local))?;
        db.check_format().map_err(|error| match error {
            OldSharedFormat { found, .. } => Self::old_format(path, found),
            other => other,
        })?;
        Ok(db)
    }

    /// Opens the registry over a transaction store shared by every replica. `path` is this
    /// replica's local directory for the owners not yet on the shared store; it is created when
    /// absent and must not hold a registry database of the RocksDB driver. Nothing is read from
    /// `kv` here: composition calls [`Db::check_format`] on a blocking worker.
    pub fn open_shared(path: impl AsRef<Path>, kv: Arc<dyn RelayKvStore>) -> Result<Self> {
        let path = path.as_ref();
        Self::refuse_old_message_store(path)?;
        Self::refuse_old_directory_sidecars(path)?;
        if path.join("CURRENT").exists() {
            return Err(Self::old_format(
                path,
                "a registry database of the RocksDB driver; with a shared store the registry \
                 lives in the cluster"
                    .to_owned(),
            )
            .into());
        }
        std::fs::create_dir_all(path).wrap_err(RocksDb)?;
        Self::with_store(path, kv, None)
    }

    fn with_store(
        path: &Path,
        kv: Arc<dyn RelayKvStore>,
        local: Option<Arc<RocksDbKvStore>>,
    ) -> Result<Self> {
        let canonical = std::fs::canonicalize(path).wrap_err(RocksDb)?;
        // A single-node directory by default; composition chooses a shared one.
        let objects = Arc::new(super::large_values::LocalFsObjectStore::new(
            crate::registry::Registry::local_large_values_path(&canonical),
        ));
        Ok(Db {
            kv,
            local,
            path: path.to_path_buf(),
            directory: super::directory_store::Owner::new(
                super::directory_store::DirectoryBackend::RocksDbInside(canonical),
                objects,
            ),
        })
    }

    /// Read the format marker without writing anything. An empty store is accepted; rows of
    /// another format, or rows without a marker, are refused.
    pub fn check_format(&self) -> std::result::Result<(), DbError> {
        let found = self.blocking(|| {
            self.kv.transact(|tx| {
                Ok::<_, KvError>(match tx.get(FORMAT_KEY)? {
                    Some(format) if format == REGISTRY_FORMAT => None,
                    Some(format) => Some(format!(
                        "registry format {:?}",
                        String::from_utf8_lossy(&format)
                    )),
                    None => {
                        let mut found = None;
                        for prefix in OWNED_PREFIXES {
                            if !tx.scan_prefix(prefix, None, 1)?.is_empty() {
                                found = Some("registry rows without a format marker".to_owned());
                                break;
                            }
                        }
                        found
                    }
                })
            })
        })?;
        match found {
            None => Ok(()),
            Some(found) => Err(OldSharedFormat {
                store: format!("{:?}", self.kv),
                found,
            }),
        }
    }

    /// Run `body` as one transaction of the registry store. `Ok` commits, `Err` discards every
    /// write; the body may run more than once and must have no other effects. Mutating
    /// transactions call [`mark_format`] first.
    pub(crate) fn transact<T>(
        &self,
        mut body: impl FnMut(&mut dyn KvTransaction) -> Result<T>,
    ) -> Result<T> {
        self.blocking(|| {
            self.kv
                .transact(|tx| body(tx).map_err(RegistryTxError::Body))
                .map_err(|error| match error {
                    RegistryTxError::Body(report) => report,
                    RegistryTxError::Store(error) => Store(error).into(),
                })
        })
    }

    /// A shared store blocks on the network; on a multi-threaded runtime the worker is handed
    /// over to other tasks for the call. The RocksDB driver keeps its synchronous calls.
    fn blocking<T>(&self, call: impl FnOnce() -> T) -> T {
        use tokio::runtime::{Handle, RuntimeFlavor};
        match Handle::try_current() {
            Ok(handle)
                if self.local.is_none()
                    && handle.runtime_flavor() == RuntimeFlavor::MultiThread =>
            {
                tokio::task::block_in_place(call)
            }
            _ => call(),
        }
    }

    /// Frank has no users yet, so stored formats change without migration and there is no
    /// reader for an earlier one. A message store left beside the database under an earlier
    /// name stops the relay here, at startup, with what to delete.
    fn refuse_old_message_store(path: &Path) -> Result<()> {
        let left_behind = super::monad_dm_cbor::OLD_STORE_EXTENSIONS
            .iter()
            .any(|extension| path.with_extension(extension).exists());
        if left_behind {
            return Err(Self::old_format(path, "an earlier message store".to_owned()).into());
        }
        Ok(())
    }

    /// The directory once kept two RocksDB sidecars inside the registry path. This build keeps
    /// the directory in one transaction store and has no reader for them.
    fn refuse_old_directory_sidecars(path: &Path) -> Result<()> {
        let left: Vec<_> = super::directory_store::OLD_SIDECARS
            .iter()
            .map(|name| path.join(name))
            .filter(|sidecar| sidecar.exists())
            .collect();
        if left.is_empty() {
            return Ok(());
        }
        Err(OldFormat {
            path: path.display().to_string(),
            found: "earlier directory stores".to_owned(),
            delete: left
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" "),
        }
        .into())
    }

    fn old_format(path: &Path, found: String) -> DbError {
        let mut delete = vec![
            path.to_path_buf(),
            path.with_extension(super::monad_dm_cbor::STORE_EXTENSION),
        ];
        delete.extend(
            super::monad_dm_cbor::OLD_STORE_EXTENSIONS
                .iter()
                .map(|extension| path.with_extension(extension)),
        );
        OldFormat {
            path: path.display().to_string(),
            found,
            delete: delete
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    /// Returns `DbMetadata`, allowing access to registry metadata.
    pub fn metadata(&self) -> DbMetadata<'_> {
        DbMetadata::new(self)
    }

    /// Explicitly open an unused preview directory subject with installed trust and continuity.
    /// Opening validates retained history but does not grant a fresh head.
    pub fn directory_preview(
        &self,
        anchor: crate::directory_admission::Anchor,
        mode: crate::directory_admission::OpenMode,
    ) -> std::result::Result<
        crate::directory_admission::Directory<'_>,
        crate::directory_admission::AdmissionError,
    > {
        super::directory_preview::Directory::open(self, anchor, mode)
    }

    /// Continuity rows, indexes, counters and forwards of self-published directory subjects.
    /// Creates the directory store on first use.
    pub(crate) fn directory_subjects(
        &self,
    ) -> Result<super::directory_subjects::DbDirectorySubjects> {
        let store = self
            .directory
            .open(true)
            .map_err(|error| bitcoinsuite_error::Report::msg(error.to_string()))?;
        Ok(super::directory_subjects::DbDirectorySubjects::new(store))
    }

    /// The directory's transaction store. Without `create`, a store that does not exist yet is
    /// [`StoreError::Missing`](super::directory_store::StoreError::Missing) and nothing is written.
    pub(crate) fn directory_store(
        &self,
        create: bool,
    ) -> std::result::Result<
        std::sync::Arc<super::directory_store::DirectoryStore>,
        super::directory_store::StoreError,
    > {
        self.directory.open(create)
    }

    /// Choose where the directory keeps its state (composition, before first use).
    pub fn set_directory_backend(
        &mut self,
        backend: super::directory_store::DirectoryBackend,
        objects: std::sync::Arc<dyn super::large_values::ObjectStore>,
    ) {
        self.directory = super::directory_store::Owner::new(backend, objects);
    }

    /// Returns `DbTopics`, allowing access to registry metadata.
    pub fn topics(&self) -> DbTopics<'_> {
        DbTopics::new(self)
    }

    /// Returns `DbMonadProfiles`, allowing access to stored Monad-native profile registrations
    /// (ticket #45).
    pub fn monad_profiles(&self) -> DbMonadProfiles<'_> {
        DbMonadProfiles::new(self)
    }

    /// Returns `DbDirectoryUsernames`, the store of unique usernames.
    pub fn directory_usernames(&self) -> DbDirectoryUsernames<'_> {
        DbDirectoryUsernames::new(self)
    }

    /// The RocksDB driver's database, for tests that copy or inspect it directly.
    #[cfg(test)]
    pub(crate) fn rocksdb(&self) -> &rocksdb::DB {
        self.local
            .as_ref()
            .expect("a RocksDB-driver registry")
            .rocksdb()
    }

    /// Write one raw row, bypassing every owner rule: tests plant corrupt or stale rows.
    #[cfg(test)]
    pub(crate) fn raw_set(&self, key: &[u8], value: &[u8]) -> Result<()> {
        self.transact(|tx| Ok(tx.set(key, value)?))
    }

    /// Every raw row under `prefix`, in key order, with the prefix kept.
    #[cfg(test)]
    pub(crate) fn raw_rows(&self, prefix: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let mut rows = Vec::new();
        let mut after: Option<Vec<u8>> = None;
        loop {
            let batch =
                self.transact(|tx| Ok(tx.scan_prefix(prefix, after.as_deref(), 1000)?))?;
            let done = batch.len() < 1000;
            after = batch.last().map(|(key, _)| key.clone());
            rows.extend(batch);
            if done {
                return Ok(rows);
            }
        }
    }

    /// Estimated live key/value bytes of the RocksDB driver (not filesystem or PVC usage);
    /// `None` on a shared store, whose size this replica does not own.
    pub(crate) fn estimated_live_data_size_bytes(&self) -> Result<Option<u64>> {
        match &self.local {
            Some(local) => Ok(Some(local.estimated_live_data_size_bytes().map_err(Store)?)),
            None => Ok(None),
        }
    }

    /// Location owned by this database; private siblings must not add legacy CFs.
    pub(crate) fn owned_path(&self) -> &Path {
        &self.path
    }

}

/// A transaction body's own error, or the store's.
enum RegistryTxError {
    Body(Report),
    Store(KvError),
}

impl From<KvError> for RegistryTxError {
    fn from(error: KvError) -> Self {
        Self::Store(error)
    }
}

/// Write the format marker if this is the store's first registry write.
pub(crate) fn mark_format(tx: &mut dyn KvTransaction) -> Result<()> {
    if tx.get(FORMAT_KEY)?.is_none() {
        tx.set(FORMAT_KEY, REGISTRY_FORMAT)?;
    }
    Ok(())
}

fn part_prefix(key: &[u8]) -> Vec<u8> {
    [PART_PREFIX, key].concat()
}

fn split_header(stored: &[u8]) -> Result<Option<u32>> {
    match stored.first() {
        Some(0) => {
            let count: [u8; 4] = stored[1..].try_into().map_err(|_| IncompleteSplitValue)?;
            Ok(Some(u32::from_be_bytes(count)))
        }
        _ => Ok(None),
    }
}

/// Read a value written by [`put_value`], reassembling its parts.
pub(crate) fn get_value(tx: &mut dyn KvTransaction, key: &[u8]) -> Result<Option<Vec<u8>>> {
    let Some(stored) = tx.get(key)? else {
        return Ok(None);
    };
    let Some(count) = split_header(&stored)? else {
        return Ok(Some(stored));
    };
    let prefix = part_prefix(key);
    let parts = tx.scan_prefix(&prefix, None, count as usize + 1)?;
    if parts.len() != count as usize
        || parts
            .iter()
            .enumerate()
            .any(|(index, (k, _))| k[prefix.len()..] != (index as u32).to_be_bytes())
    {
        return Err(IncompleteSplitValue.into());
    }
    Ok(Some(parts.into_iter().flat_map(|(_, part)| part).collect()))
}

/// Remove the parts of a split value at `key`, if it is one. The key itself is left alone.
fn clear_parts(tx: &mut dyn KvTransaction, key: &[u8]) -> Result<()> {
    if let Some(previous) = tx.get(key)? {
        if let Some(count) = split_header(&previous)? {
            let prefix = part_prefix(key);
            for index in 0..count {
                tx.clear(&[prefix.as_slice(), &index.to_be_bytes()].concat())?;
            }
        }
    }
    Ok(())
}

/// Write `value` at `key`, split into parts in the same transaction when it is longer than the
/// store's value limit (or starts with `0x00`), and remove the parts of a value it replaces.
/// Interim until large values move to the object store; a value too large for one transaction
/// fails with [`KvError::TransactionTooLarge`] and nothing is written.
pub(crate) fn put_value(tx: &mut dyn KvTransaction, key: &[u8], value: &[u8]) -> Result<()> {
    clear_parts(tx, key)?;
    if value.len() <= MAX_VALUE_BYTES && value.first() != Some(&0) {
        tx.set(key, value)?;
        return Ok(());
    }
    let parts: Vec<&[u8]> = value.chunks(MAX_VALUE_BYTES).collect();
    let count = u32::try_from(parts.len()).map_err(|_| {
        Store(KvError::TransactionTooLarge {
            limit: crate::store::kv_store::MAX_TRANSACTION_BYTES,
        })
    })?;
    let prefix = part_prefix(key);
    tx.set(key, &[[0u8].as_slice(), &count.to_be_bytes()].concat())?;
    for (index, part) in (0u32..).zip(parts) {
        tx.set(&[prefix.as_slice(), &index.to_be_bytes()].concat(), part)?;
    }
    Ok(())
}

/// The smallest key after every key starting with `prefix`.
pub(crate) fn prefix_end(prefix: &[u8]) -> Vec<u8> {
    crate::store::kv_store::prefix_end(prefix)
}

impl Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Db {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use crate::store::db::Db;
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;

    #[test]
    fn test_db_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(format!("{:?}", db), "Db { .. }");
        Ok(())
    }

    #[test]
    fn a_fresh_or_current_database_opens_and_reopens() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-reopen")?;
        let path = tempdir.path().join("db.rocksdb");
        drop(Db::open(&path)?);
        drop(Db::open(&path)?);
        Ok(())
    }

    /// No migration and no reader for earlier formats: an old database stops the relay at
    /// startup and says what to delete.
    #[test]
    fn a_database_from_an_earlier_build_is_refused_with_what_to_delete() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-old-format")?;
        // A registry database holding a table this build does not know.
        let with_old_table = tempdir.path().join("old-table.rocksdb");
        {
            let mut options = rocksdb::Options::default();
            options.create_if_missing(true);
            options.create_missing_column_families(true);
            drop(rocksdb::DB::open_cf(
                &options,
                &with_old_table,
                ["monad_outbox_v1"],
            )?);
        }
        let error = format!("{:#}", Db::open(&with_old_table).unwrap_err());
        assert!(error.contains("monad_outbox_v1"), "{error}");
        assert!(error.contains("Development reset"), "{error}");
        assert!(
            error.contains(&with_old_table.display().to_string()),
            "{error}"
        );
        assert!(error.contains("no keys"), "{error}");

        // A fresh registry database beside a message store left under the earlier name.
        let beside_old_store = tempdir.path().join("beside.rocksdb");
        let old_store = tempdir.path().join("beside.monad-dm-cbor-v1");
        std::fs::create_dir(&old_store)?;
        let error = format!("{:#}", Db::open(&beside_old_store).unwrap_err());
        assert!(error.contains("an earlier message store"), "{error}");
        assert!(error.contains(&old_store.display().to_string()), "{error}");
        // Nothing was created by the refusal, and deleting what it names is all it takes.
        assert!(!beside_old_store.exists());
        std::fs::remove_dir(&old_store)?;
        drop(Db::open(&beside_old_store)?);
        Ok(())
    }

    /// A database of the previous build (registry column families) is refused, not read.
    #[test]
    fn a_registry_with_column_families_is_refused_with_what_to_delete() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-cf-format")?;
        let path = tempdir.path().join("db.rocksdb");
        {
            let mut options = rocksdb::Options::default();
            options.create_if_missing(true);
            options.create_missing_column_families(true);
            drop(rocksdb::DB::open_cf(
                &options,
                &path,
                ["metadata", "monad_profiles", "directory_usernames"],
            )?);
        }
        let error = format!("{:#}", Db::open(&path).unwrap_err());
        assert!(error.contains("monad_profiles"), "{error}");
        assert!(error.contains("Development reset"), "{error}");
        Ok(())
    }

    /// Rows of another format, or registry rows without a marker, are refused by both opens.
    #[test]
    fn a_store_of_another_format_is_refused_and_a_marked_one_reopens() -> Result<()> {
        use crate::store::kv_store::{RocksDbKvStore, Transact};
        use std::sync::Arc;
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-format")?;
        let path = tempdir.path().join("db.rocksdb");
        {
            let db = Db::open(&path)?;
            db.monad_profiles()
                .put_raw(&crate::monad_http::Address([1; 20]), b"raw", 1, None)?;
            assert_eq!(
                db.raw_rows(b"F")?,
                vec![(b"F".to_vec(), b"registry-kv-v1".to_vec())]
            );
        }
        drop(Db::open(&path)?);
        {
            let raw = RocksDbKvStore::open(&path)?;
            raw.transact(|tx| tx.set(b"F", b"registry-kv-v0"))?;
        }
        let error = format!("{:#}", Db::open(&path).unwrap_err());
        assert!(error.contains("registry-kv-v0"), "{error}");
        assert!(error.contains("Development reset"), "{error}");

        let shared = Arc::new(RocksDbKvStore::open_temporary()?);
        shared.transact(|tx| tx.set(b"u/nalice", b"{}"))?;
        let db = Db::open_shared(tempdir.path().join("replica"), shared)?;
        let error = db.check_format().unwrap_err().to_string();
        assert!(error.contains("without a format marker"), "{error}");
        // A replica directory that holds a RocksDB-driver registry is not silently ignored.
        let error = format!(
            "{:#}",
            Db::open_shared(&path, Arc::new(RocksDbKvStore::open_temporary()?)).unwrap_err()
        );
        assert!(error.contains("RocksDB driver"), "{error}");
        Ok(())
    }
}

/// Two replicas over one store, with a competing write committed between the first attempt of
/// a transaction and its commit: the transaction must re-run against the winner's rows.
#[cfg(test)]
mod replica_conflict_tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    use bitcoinsuite_core::{ecc::Ecc, Hashed, Sha256};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;
    use prost::Message;

    use super::Db;
    use crate::{
        monad_http::Address,
        proto,
        store::{
            directory_usernames::{
                claim_text, tests::signed_claim, verify_claim, ClaimOutcome, UsernameError,
            },
            kv_store::{KvError, KvTransaction, Outcome, RelayKvStore, RocksDbKvStore},
        },
    };

    type Interleave = Box<dyn FnOnce() + Send>;

    /// Runs `interleave` once, after the first attempt of the next transaction has run its body
    /// and before that attempt commits.
    #[derive(Default)]
    struct Interleaving {
        inner: Option<Arc<RocksDbKvStore>>,
        pending: Mutex<Option<Interleave>>,
        attempts: std::sync::atomic::AtomicU32,
    }

    impl std::fmt::Debug for Interleaving {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("Interleaving")
        }
    }

    impl RelayKvStore for Interleaving {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
        ) -> Result<Outcome, KvError> {
            self.inner.as_ref().unwrap().run_transaction(&mut |tx| {
                self.attempts.fetch_add(1, Ordering::SeqCst);
                let outcome = body(tx);
                if let Some(interleave) = self.pending.lock().unwrap().take() {
                    interleave();
                }
                outcome
            })
        }
    }

    fn replicas(dir: &std::path::Path) -> Result<(Arc<RocksDbKvStore>, Db, Arc<Interleaving>, Db)> {
        let store = Arc::new(RocksDbKvStore::open(dir.join("shared"))?);
        let a = Arc::new(Interleaving {
            inner: Some(store.clone()),
            ..Default::default()
        });
        let db_a = Db::open_shared(dir.join("a"), a.clone())?;
        let db_b = Db::open_shared(dir.join("b"), store.clone())?;
        Ok((store, db_a, a, db_b))
    }

    fn claim(
        secret: u8,
        name: &str,
        issued_ms: u64,
    ) -> crate::store::directory_usernames::UsernameRecord {
        let text = claim_text("monad-testnet", name, issued_ms);
        verify_claim(
            &EccSecp256k1::default(),
            &signed_claim([secret; 32], &text),
            "monad-testnet",
            issued_ms,
        )
        .unwrap()
    }

    #[test]
    fn a_name_claimed_on_two_replicas_at_once_has_one_holder_and_one_reverse_row() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let (_store, db_a, a, db_b) = replicas(dir.path())?;
        let db_b = Arc::new(db_b);
        let mallory = claim(2, "alice", 1_800_000_000_001);
        let committed = Arc::new(AtomicBool::new(false));
        {
            let (db_b, mallory, committed) = (db_b.clone(), mallory.clone(), committed.clone());
            *a.pending.lock().unwrap() = Some(Box::new(move || {
                let outcome = db_b
                    .directory_usernames()
                    .claim(&mallory, 7, false)
                    .unwrap();
                assert_eq!(outcome, Ok(ClaimOutcome::Claimed));
                committed.store(true, Ordering::SeqCst);
            }));
        }
        // A's first attempt saw a free name; B took it before A committed.
        let alice = claim(1, "alice", 1_800_000_000_000);
        assert_eq!(
            db_a.directory_usernames().claim(&alice, 5, false)?,
            Err(UsernameError::Taken)
        );
        assert!(committed.load(Ordering::SeqCst));
        assert_eq!(
            a.attempts.load(Ordering::SeqCst),
            2,
            "A re-ran after the conflict"
        );
        for db in [&db_a, db_b.as_ref()] {
            assert_eq!(
                db.raw_rows(b"u/")?
                    .into_iter()
                    .map(|(k, v)| (k, v.len()))
                    .map(|(k, _)| k)
                    .collect::<Vec<_>>(),
                vec![
                    [b"u/a".as_slice(), &mallory.address].concat(),
                    b"u/nalice".to_vec()
                ]
            );
            assert_eq!(
                db.directory_usernames().get("alice")?.unwrap().subject,
                mallory.subject
            );
            assert_eq!(db.directory_usernames().of_address(&alice.address)?, None);
        }
        Ok(())
    }

    fn signed_profile(timestamp: i64, name: &str) -> cashweb_payload::proto::SignedPayload {
        let payload = proto::MonadProfile {
            timestamp,
            ttl: 0,
            entries: vec![proto::AddressEntry {
                kind: "display_name".into(),
                headers: Default::default(),
                body: name.as_bytes().to_vec(),
            }],
        }
        .encode_to_vec();
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([3; 32]).unwrap();
        let payload_hash = Sha256::digest(payload.clone().into());
        cashweb_payload::proto::SignedPayload {
            pubkey: ecc.derive_pubkey(&seckey).as_slice().to_vec(),
            sig: ecc
                .sign(&seckey, payload_hash.byte_array().clone())
                .to_vec(),
            sig_scheme: 1,
            payload,
            payload_hash: payload_hash.as_slice().to_vec(),
            burn_amount: 0,
            burn_txs: vec![],
        }
    }

    #[test]
    fn a_profile_replaced_on_two_replicas_at_once_keeps_only_the_last_record_rows() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let (_store, db_a, a, db_b) = replicas(dir.path())?;
        let db_b = Arc::new(db_b);
        let address = Address([4; 20]);
        db_b.monad_profiles()
            .put(&address, &signed_profile(100, "OldName"))?;
        {
            let db_b = db_b.clone();
            *a.pending.lock().unwrap() = Some(Box::new(move || {
                db_b.monad_profiles()
                    .put(&address, &signed_profile(200, "Other"))
                    .unwrap();
            }));
        }
        // A's first attempt read OldName and staged removing its rows; B replaced it with Other
        // meanwhile, so A re-runs and removes Other's rows instead.
        let newest = signed_profile(300, "NewName");
        db_a.monad_profiles().put(&address, &newest)?;
        assert_eq!(a.attempts.load(Ordering::SeqCst), 2);
        for db in [&db_a, db_b.as_ref()] {
            let keys = |prefix: &[u8]| -> Result<Vec<Vec<u8>>> {
                Ok(db.raw_rows(prefix)?.into_iter().map(|(k, _)| k).collect())
            };
            assert_eq!(
                keys(b"pt/")?,
                vec![[b"pt/".as_slice(), &300i64.to_be_bytes(), &address.0].concat()]
            );
            assert_eq!(
                keys(b"pn/")?,
                vec![[b"pn/newname".as_slice(), &address.0].concat()]
            );
            assert_eq!(
                db.monad_profiles().list_since(0)?,
                vec![(address, newest.clone())]
            );
            assert_eq!(db.monad_profiles().count_records()?, 1);
            assert!(db.monad_profiles().search_by_name("old", 10)?.is_empty());
            assert!(db.monad_profiles().search_by_name("other", 10)?.is_empty());
        }
        Ok(())
    }
}
