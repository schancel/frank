//! Module for `Db` and `DbError`.

use std::{fmt::Debug, path::Path, sync::Mutex};

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use rocksdb::ColumnFamilyDescriptor;
use thiserror::Error;

use crate::store::directory_usernames::DbDirectoryUsernames;
use crate::store::metadata::DbMetadata;
use crate::store::monad_profiles::DbMonadProfiles;
use crate::store::monad_topics::{DbMonadTopicPosts, DbMonadTopicVotes};
use crate::store::topics::DbTopics;

// We collect the column family constants here so we have a nice overview.
// This makes it easier to keep cf names consistent and non-conflicting.
pub(crate) const CF_METADATA: &str = "metadata";
pub(crate) const CF_PKH_BY_TIME: &str = "pkh_by_time";
pub(crate) const CF_MESSAGES: &str = "topic_messages";
pub(crate) const CF_PAYLOADS: &str = "message_payloads";
pub(crate) const CF_TOPIC_BURNS: &str = "topic_burn_txs";
/// Ticket #30: stores [`crate::proto::StoredMonadTopicPost`], keyed by `payload_hash`. Parallel
/// See `crate::store::monad_topics`'s module docs.
pub(crate) const CF_MONAD_TOPIC_POSTS: &str = "monad_topic_posts";
/// Ticket #30: stores [`crate::proto::StoredMonadTopicVoteEntry`], keyed by
/// `target_payload_hash ++ tx_hash` so multiple votes can tally against the same post -- see
/// `crate::store::monad_topics`'s module docs.
pub(crate) const CF_MONAD_TOPIC_VOTES: &str = "monad_topic_votes";
/// Ticket #40: secondary index over `CF_MONAD_TOPIC_POSTS`, keyed by `SHA256(topic) ++
/// timestamp.to_be_bytes() ++ payload_hash` (value: the `payload_hash`) -- mirrors
/// `CF_MONAD_MESSAGES_BY_TIME`'s "value is just the payload_hash" layout, but hashes the topic
/// first (exactly like `DbTopics::get_messages_to`'s own `topic_digest`) rather than using the raw
/// topic bytes as a variable-length key prefix, which would let one topic's key range bleed into
/// another's (e.g. topic `"a"` is a byte-prefix of topic `"ab"`, so a raw-bytes prefix scan for
/// `"a"` would incorrectly also return `"ab"`'s posts). Lets `DbMonadTopicPosts::list_by_topic`
/// range-scan a single topic's posts in timestamp order -- see `crate::store::monad_topics`'s module docs.
pub(crate) const CF_MONAD_TOPIC_POSTS_BY_TOPIC: &str = "monad_topic_posts_by_topic";
/// Ticket #72: secondary index over `CF_MONAD_TOPIC_POSTS`, keyed directly by the raw topic name
/// string (value: an encoded `proto::TopicDiscoveryStats`) -- unlike
/// `CF_MONAD_TOPIC_POSTS_BY_TOPIC`, this index is looked up by exact topic match, never
/// prefix-scanned, so there's no byte-prefix ambiguity to hash away (see
/// `crate::store::monad_topics`'s module docs). Lets `DbMonadTopicPosts::list_topics` discover
/// every distinct topic name this relay has seen a post for, without a client already knowing
/// topic names out of band -- topics stay emergent/tag-based, so this is the closest thing to a
/// "topic list" this crate has.
pub(crate) const CF_MONAD_TOPIC_DISCOVERY: &str = "monad_topic_discovery";
/// Ticket #45: stores the `cashweb_payload::proto::SignedPayload` envelope of a Monad-native
/// profile registration (`PUT`/`GET /metadata/monad/:addr`), keyed directly by the registrant's
/// raw 20-byte Monad address -- see `crate::store::monad_profiles`'s module docs for why this is
/// separate from `CF_METADATA` (which is keyed by a Lotus-only `PubKeyHash`).
pub(crate) const CF_MONAD_PROFILES: &str = "monad_profiles";
/// Ticket #75: secondary index over `CF_MONAD_PROFILES`, keyed by `timestamp.to_be_bytes() ++
/// address` (value: the raw address, so a range scan doesn't need a second lookup to know which
/// `CF_MONAD_PROFILES` entry to fetch) -- mirrors `CF_MONAD_MESSAGES_BY_TIME` exactly. Lets
/// `DbMonadProfiles::list_since` discover newly-registered profiles in timestamp order, e.g. for a
/// bot to auto-greet/auto-fund new signups.
pub(crate) const CF_MONAD_PROFILES_BY_TIME: &str = "monad_profiles_by_time";
/// Ticket #48: secondary index over `CF_MONAD_PROFILES`, keyed by `normalized_name.as_bytes() ++
/// address` (value: the raw address) -- normalized_name is the profile's `display_name`
/// `AddressEntry` body, lowercased. Unlike `CF_MONAD_TOPIC_POSTS_BY_TOPIC`'s hashed-topic index,
/// this one keeps the raw (unhashed) UTF-8 bytes of the normalized name as the key prefix, because
/// its whole purpose is prefix scanning (`DbMonadProfiles::search_by_name`) -- hashing would
/// destroy the sort order a prefix scan depends on. Multiple profiles may share the same
/// normalized name, hence appending `address` to the key for uniqueness, same reasoning as
/// `CF_MONAD_PROFILES_BY_TIME`'s `timestamp ++ address` key. See
/// `crate::store::monad_profiles`'s module docs for how this is maintained/queried.
pub(crate) const CF_MONAD_PROFILES_BY_NAME: &str = "monad_profiles_by_name";

pub(crate) type CF = rocksdb::ColumnFamily;

/// Registry database.
/// Owns the underlying rocksdb::DB instance.
pub struct Db {
    db: rocksdb::DB,
    /// Serializes read-check-batch outbox mutations inside this process. RocksDB batches are
    /// atomic, but the active-claim bound also needs its preceding count to be serialized.
    /// Serializes profile writes and secondary index cleanups across formats.
    monad_profile_lock: Mutex<()>,
    /// Serializes compare-and-batch topic-author admission inside this process.
    monad_topic_lock: Mutex<()>,
    /// Serializes the check-then-write of a username claim inside this process.
    username_lock: Mutex<()>,
    /// Lazy separate store; ordinary legacy startup never opens or modifies preview storage.
    directory_preview_owner: super::directory_preview_owner::Owner,
    /// Lazy separate store of self-published subjects. Kept out of the registry's own column
    /// families so an earlier relay version can still open the registry.
    directory_subjects: std::sync::OnceLock<rocksdb::DB>,
    directory_subjects_lock: Mutex<()>,
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
}

use self::DbError::*;

impl Db {
    /// Opens the database under the specified path.
    /// Creates the database file and necessary column families if necessary.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut cfs = Vec::new();
        DbMetadata::add_cfs(&mut cfs);
        DbTopics::add_cfs(&mut cfs);
        DbMonadTopicPosts::add_cfs(&mut cfs);
        DbMonadTopicVotes::add_cfs(&mut cfs);
        DbMonadProfiles::add_cfs(&mut cfs);
        DbDirectoryUsernames::add_cfs(&mut cfs);
        let path = path.as_ref();
        Self::refuse_old_message_store(path)?;
        match Self::open_with_cfs(path, cfs) {
            Ok(db) => Ok(db),
            Err(error) => {
                // RocksDB refuses to open a database holding tables it was not told about,
                // which is what a database from before a table was removed looks like.
                let unknown_tables = format!("{error:?}");
                match unknown_tables.split("Column families not opened: ").nth(1) {
                    Some(tables) => Err(Self::old_format(
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
                    .into()),
                    None => Err(error),
                }
            }
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

    /// Continuity rows and the address index of self-published directory subjects.
    pub(crate) fn directory_subjects(
        &self,
    ) -> Result<super::directory_subjects::DbDirectorySubjects<'_>> {
        if self.directory_subjects.get().is_none() {
            let _guard = self
                .directory_subjects_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if self.directory_subjects.get().is_none() {
                let path = std::fs::canonicalize(self.db.path())
                    .wrap_err(RocksDb)?
                    .join(super::directory_subjects::STORE);
                let _ = self
                    .directory_subjects
                    .set(super::directory_subjects::open(&path)?);
            }
        }
        super::directory_subjects::DbDirectorySubjects::new(
            self.directory_subjects.get().ok_or(RocksDb)?,
        )
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

    /// Returns `DbMonadTopicPosts`, allowing access to stored Monad topic posts (ticket #30).
    pub fn monad_topic_posts(&self) -> DbMonadTopicPosts<'_> {
        DbMonadTopicPosts::new(self)
    }

    /// Returns `DbMonadTopicVotes`, allowing access to stored Monad topic vote and their per-post
    /// tally (ticket #30).
    pub fn monad_topic_votes(&self) -> DbMonadTopicVotes<'_> {
        DbMonadTopicVotes::new(self)
    }

    /// Returns `DbDirectoryUsernames`, the store of unique usernames.
    pub fn directory_usernames(&self) -> DbDirectoryUsernames<'_> {
        DbDirectoryUsernames::new(self)
    }

    pub(crate) fn open_with_cfs(
        path: impl AsRef<Path>,
        cfs: Vec<ColumnFamilyDescriptor>,
    ) -> Result<Self> {
        let mut db_options = rocksdb::Options::default();
        db_options.create_if_missing(true);
        db_options.create_missing_column_families(true);
        let db = rocksdb::DB::open_cf_descriptors(&db_options, path, cfs).wrap_err(RocksDb)?;
        let registry_path = std::fs::canonicalize(db.path()).wrap_err(RocksDb)?;
        Ok(Db {
            db,
            monad_profile_lock: Mutex::new(()),
            monad_topic_lock: Mutex::new(()),
            username_lock: Mutex::new(()),
            directory_preview_owner: super::directory_preview_owner::Owner::new(registry_path),
            directory_subjects: std::sync::OnceLock::new(),
            directory_subjects_lock: Mutex::new(()),
        })
    }

    pub(crate) fn cf(&self, name: &str) -> Result<&CF> {
        Ok(self
            .db
            .cf_handle(name)
            .ok_or_else(|| NoSuchColumnFamily(name.to_string()))?)
    }

    pub(crate) fn get(
        &self,
        cf: &CF,
        key: impl AsRef<[u8]>,
    ) -> Result<Option<rocksdb::DBPinnableSlice<'_>>> {
        self.db.get_pinned_cf(cf, key).wrap_err(RocksDb)
    }

    #[cfg(test)]
    pub(crate) fn put(
        &self,
        cf: &CF,
        key: impl AsRef<[u8]>,
        value: impl AsRef<[u8]>,
    ) -> Result<()> {
        self.db.put_cf(cf, key, value).wrap_err(RocksDb)
    }

    pub(crate) fn rocksdb(&self) -> &rocksdb::DB {
        &self.db
    }

    /// Location owned by this database; private siblings must not add legacy CFs.
    pub(crate) fn owned_path(&self) -> &Path {
        self.db.path()
    }

    pub(crate) fn write_batch(&self, write_batch: rocksdb::WriteBatch) -> Result<()> {
        self.db.write(write_batch)?;
        Ok(())
    }

    pub(crate) fn lock_monad_profiles(&self) -> std::sync::MutexGuard<'_, ()> {
        self.monad_profile_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn lock_monad_topics(&self) -> std::sync::MutexGuard<'_, ()> {
        self.monad_topic_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn lock_usernames(&self) -> std::sync::MutexGuard<'_, ()> {
        self.username_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn open_directory_preview(
        &self,
        mode: crate::directory_admission::OpenMode,
    ) -> std::result::Result<
        std::sync::Arc<super::directory_preview_owner::Store>,
        crate::directory_admission::AdmissionError,
    > {
        self.directory_preview_owner.open(mode)
    }
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
}
