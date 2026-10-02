//! Module for `Db` and `DbError`.

use std::{fmt::Debug, path::Path, sync::Mutex};

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use rocksdb::ColumnFamilyDescriptor;
use thiserror::Error;

use crate::store::metadata::DbMetadata;
use crate::store::monad_messages::DbMonadMessages;
use crate::store::monad_outbox::{DbMonadOutbox, MonadOutboxLimits};
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
/// Ticket #27: stores [`crate::proto::StoredMonadMessage`], keyed by `payload_hash`. Kept
/// separate from `CF_PAYLOADS`/`CF_MESSAGES`/`CF_TOPIC_BURNS` since those are indexed around a
/// Lotus `Tx` shape a Monad message doesn't have -- see `crate::store::monad_messages`'s module
/// docs for why that storage path isn't reusable as-is.
pub(crate) const CF_MONAD_MESSAGES: &str = "monad_messages";
/// Ticket #37: secondary index over `CF_MONAD_MESSAGES`, keyed by `timestamp.to_be_bytes() ++
/// payload_hash` (value: the `payload_hash`, so a range scan doesn't need a second lookup to know
/// which `CF_MONAD_MESSAGES` entry to fetch). Lets `DbMonadMessages::list_since` iterate messages
/// in timestamp order without scanning the whole (payload_hash-keyed) primary CF -- mirrors
/// `DbTopics`'s `CF_MESSAGES` "topic_digest ++ timestamp" key layout, minus the topic prefix.
pub(crate) const CF_MONAD_MESSAGES_BY_TIME: &str = "monad_messages_by_time";
/// Recipient-scoped secondary index over `CF_MONAD_MESSAGES`, keyed by the recipient's raw
/// 20-byte address followed by `timestamp.to_be_bytes() ++ payload_hash`. This is derived from
/// the already-validated routing envelope and lets a mailbox read only its own journal without
/// changing the stored protobuf record.
pub(crate) const CF_MONAD_MESSAGES_BY_RECIPIENT_TIME: &str = "monad_messages_by_recipient_time";
/// Canonical in-progress direct-message payment sets, keyed by payload hash. Persisting the exact
/// set makes crash/retry resume the original raw transactions instead of accepting a second set.
pub(crate) const CF_MONAD_MESSAGE_ATTEMPTS: &str = "monad_message_attempts";
/// Versioned canonical direct-message relay records keyed by payload hash. Unlike the legacy
/// digest-only attempt CF, each value owns the exact canonical request bytes needed for recovery.
pub(crate) const CF_MONAD_OUTBOX_V1: &str = "monad_outbox_v1";
/// Per-payment recovery state keyed by `payload_hash ++ child_index.to_be_bytes()`.
pub(crate) const CF_MONAD_OUTBOX_MEMBERS_V1: &str = "monad_outbox_members_v1";
/// Bounded set of claims which still need reconciliation, keyed by payload hash.
pub(crate) const CF_MONAD_OUTBOX_ACTIVE_V1: &str = "monad_outbox_active_v1";
/// Recipient-private recovery index keyed by `recipient_address ++ payload_hash`.
pub(crate) const CF_MONAD_OUTBOX_RECIPIENT_V1: &str = "monad_outbox_recipient_v1";
/// Time-ordered bounded history index for compact delivered tombstones and terminal claims that
/// have no confirmed-prefix recovery obligation. Values store the total retained record bytes.
pub(crate) const CF_MONAD_OUTBOX_HISTORY_V2: &str = "monad_outbox_history_v2";
/// Small schema/migration markers for additive outbox upgrades.
pub(crate) const CF_MONAD_OUTBOX_META_V2: &str = "monad_outbox_meta_v2";
/// Ticket #30: stores [`crate::proto::StoredMonadTopicPost`], keyed by `payload_hash`. Parallel
/// to `CF_MONAD_MESSAGES` -- see `crate::store::monad_topics`'s module docs.
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
    monad_outbox_lock: Mutex<()>,
    /// Serializes profile writes and secondary index cleanups across formats.
    monad_profile_lock: Mutex<()>,
    /// Serializes compare-and-batch topic-author admission inside this process.
    monad_topic_lock: Mutex<()>,
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
}

use self::DbError::*;

impl Db {
    /// Opens the database under the specified path.
    /// Creates the database file and necessary column families if necessary.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_monad_outbox_limits(path, &MonadOutboxLimits::default())
    }

    /// Open with the exact runtime outbox retention policy. Production startup uses this path so
    /// migration cannot delete history under temporary defaults before readiness applies config.
    pub fn open_with_monad_outbox_limits(
        path: impl AsRef<Path>,
        limits: &MonadOutboxLimits,
    ) -> Result<Self> {
        limits.validate()?;
        let mut cfs = Vec::new();
        DbMetadata::add_cfs(&mut cfs);
        DbTopics::add_cfs(&mut cfs);
        DbMonadMessages::add_cfs(&mut cfs);
        DbMonadOutbox::add_cfs(&mut cfs);
        DbMonadTopicPosts::add_cfs(&mut cfs);
        DbMonadTopicVotes::add_cfs(&mut cfs);
        DbMonadProfiles::add_cfs(&mut cfs);
        let db = Self::open_with_cfs(path, cfs)?;
        db.monad_outbox()
            .migrate_legacy_delivered_ownership(limits)?;
        Ok(db)
    }

    /// Returns `DbMetadata`, allowing access to registry metadata.
    pub fn metadata(&self) -> DbMetadata<'_> {
        DbMetadata::new(self)
    }

    /// Returns `DbTopics`, allowing access to registry metadata.
    pub fn topics(&self) -> DbTopics<'_> {
        DbTopics::new(self)
    }

    /// Returns `DbMonadMessages`, allowing access to stored Monad-stamped messages (ticket #27).
    pub(crate) fn monad_messages(&self) -> DbMonadMessages<'_> {
        DbMonadMessages::new(self)
    }

    /// Returns the durable Monad payment outbox facade.
    pub(crate) fn monad_outbox(&self) -> DbMonadOutbox<'_> {
        DbMonadOutbox::new(self)
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

    pub(crate) fn open_with_cfs(
        path: impl AsRef<Path>,
        cfs: Vec<ColumnFamilyDescriptor>,
    ) -> Result<Self> {
        let mut db_options = rocksdb::Options::default();
        db_options.create_if_missing(true);
        db_options.create_missing_column_families(true);
        let db = rocksdb::DB::open_cf_descriptors(&db_options, path, cfs).wrap_err(RocksDb)?;
        Ok(Db {
            db,
            monad_outbox_lock: Mutex::new(()),
            monad_profile_lock: Mutex::new(()),
            monad_topic_lock: Mutex::new(()),
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

    pub(crate) fn write_batch(&self, write_batch: rocksdb::WriteBatch) -> Result<()> {
        self.db.write(write_batch)?;
        Ok(())
    }

    pub(crate) fn lock_monad_outbox(&self) -> std::sync::MutexGuard<'_, ()> {
        self.monad_outbox_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
    fn existing_database_reopens_with_additive_outbox_column_families() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--db-additive-cfs")?;
        let path = tempdir.path().join("db.rocksdb");
        drop(rocksdb::DB::open_default(&path)?);
        let db = Db::open(&path)?;
        assert!(db.monad_outbox().list_active(1)?.is_empty());
        Ok(())
    }
}
