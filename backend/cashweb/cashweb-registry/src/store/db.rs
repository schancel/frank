//! Module for `Db` and `DbError`.

use std::{fmt::Debug, path::Path};

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use rocksdb::ColumnFamilyDescriptor;
use thiserror::Error;

use crate::store::metadata::DbMetadata;
use crate::store::monad_messages::DbMonadMessages;
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

pub(crate) type CF = rocksdb::ColumnFamily;

/// Registry database.
/// Owns the underlying rocksdb::DB instance.
pub struct Db {
    db: rocksdb::DB,
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
        let mut cfs = Vec::new();
        DbMetadata::add_cfs(&mut cfs);
        DbTopics::add_cfs(&mut cfs);
        DbMonadMessages::add_cfs(&mut cfs);
        DbMonadTopicPosts::add_cfs(&mut cfs);
        DbMonadTopicVotes::add_cfs(&mut cfs);
        Self::open_with_cfs(path, cfs)
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
    pub fn monad_messages(&self) -> DbMonadMessages<'_> {
        DbMonadMessages::new(self)
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
        Ok(Db { db })
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
}
