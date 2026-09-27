//! Storage for Monad forum posts and their burn-weighted votes (ticket #30):
//! [`DbForumPosts`] (parallel to [`crate::store::monad_messages::DbMonadMessages`]) and
//! [`DbForumVotes`] (able to tally multiple votes against the same `payload_hash`).
//!
//! ## Why separate stores, and why votes are keyed the way they are
//!
//! Same reasoning as `crate::store::monad_messages`'s module docs: `DbTopics`'s indexing is built
//! entirely around a Lotus `SignedPayload<BroadcastMessage>` shape a
//! [`crate::proto::MonadForumPost`]/[`crate::proto::MonadForumVote`] doesn't have, so this is a
//! new, chain-agnostic-in-practice-if-not-in-name pair of stores, not a reuse of `DbTopics`.
//!
//! [`DbForumPosts`] is keyed directly by `payload_hash`, exactly like `DbMonadMessages`.
//!
//! [`DbForumVotes`] needs to support *multiple* votes accumulating against the same
//! `payload_hash` (a post's initial vote, plus zero or more later [`crate::proto::
//! MonadForumVote`]s) and to tally them cheaply. It's keyed by `target_payload_hash (32 bytes) ++
//! tx_hash (32 bytes)` so that:
//! - A prefix scan over `target_payload_hash` (via `rocksdb`'s prefix iterator) enumerates every
//!   vote recorded against one post, for [`DbForumVotes::tally`].
//! - Keying the second half by the vote's own burn `tx_hash` makes storing the same
//!   already-verified vote twice (e.g. a client retrying a request whose response it never saw)
//!   an idempotent overwrite rather than a double-counted duplicate entry, mirroring
//!   `DbMonadMessages::put`'s same idempotency note for the analogous replay case.

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, IteratorMode};
use thiserror::Error;

use crate::{
    proto,
    store::db::{Db, CF, CF_FORUM_POSTS, CF_FORUM_VOTES},
};

/// Allows access to stored [`proto::StoredMonadForumPost`]s.
pub struct DbForumPosts<'a> {
    db: &'a Db,
    cf_forum_posts: &'a CF,
}

/// Errors indicating some forum-post store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbForumPostsError {
    /// Database contains an invalid protobuf `StoredMonadForumPost`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadForumPost: {0}")]
    CannotDecodeStoredPost(String),

    /// No post stored for the given `payload_hash`.
    #[invalid_user_input()]
    #[error("No forum post found for payload hash {0}")]
    NotFound(String),
}

use self::DbForumPostsError::*;

impl<'a> DbForumPosts<'a> {
    /// Create a new [`DbForumPosts`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_forum_posts = db.cf(CF_FORUM_POSTS).unwrap();
        DbForumPosts { db, cf_forum_posts }
    }

    /// Store a [`proto::StoredMonadForumPost`], keyed by its inner post's `payload_hash`.
    /// Idempotent, mirroring `DbMonadMessages::put`.
    pub fn put(&self, payload_hash: &[u8], post: &proto::StoredMonadForumPost) -> Result<()> {
        self.db
            .rocksdb()
            .put_cf(self.cf_forum_posts, payload_hash, post.encode_to_vec())
            .wrap_err(super::db::DbError::RocksDb)?;
        Ok(())
    }

    /// Retrieve a [`proto::StoredMonadForumPost`] by its `payload_hash`. [`None`] if not found.
    pub fn get(&self, payload_hash: &[u8]) -> Result<Option<proto::StoredMonadForumPost>> {
        let serialized = match self.db.get(self.cf_forum_posts, payload_hash)? {
            Some(serialized) => serialized,
            None => return Ok(None),
        };
        let post = proto::StoredMonadForumPost::decode(serialized.as_ref())
            .wrap_err_with(|| CannotDecodeStoredPost(hex::encode(&serialized)))?;
        Ok(Some(post))
    }

    /// Retrieve a [`proto::StoredMonadForumPost`] by its `payload_hash`, erroring with
    /// [`DbForumPostsError::NotFound`] if it doesn't exist.
    pub fn get_existing(&self, payload_hash: &[u8]) -> Result<proto::StoredMonadForumPost> {
        self.get(payload_hash)?
            .ok_or_else(|| NotFound(hex::encode(payload_hash)).into())
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_FORUM_POSTS, options));
    }
}

impl Debug for DbForumPosts<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbForumPosts {{ .. }}")
    }
}

/// Length, in bytes, of the `target_payload_hash` prefix of a [`DbForumVotes`] key.
const VOTE_KEY_TARGET_LEN: usize = 32;

/// Allows access to stored [`proto::StoredMonadForumVoteEntry`]s and their per-post tally.
pub struct DbForumVotes<'a> {
    db: &'a Db,
    cf_forum_votes: &'a CF,
}

/// Errors indicating some forum-vote store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbForumVotesError {
    /// Database contains an invalid protobuf `StoredMonadForumVoteEntry`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadForumVoteEntry: {0}")]
    CannotDecodeStoredVote(String),
}

use self::DbForumVotesError::*;

fn vote_key(target_payload_hash: &[u8], tx_hash: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(target_payload_hash.len() + tx_hash.len());
    key.extend_from_slice(target_payload_hash);
    key.extend_from_slice(tx_hash);
    key
}

impl<'a> DbForumVotes<'a> {
    /// Create a new [`DbForumVotes`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_forum_votes = db.cf(CF_FORUM_VOTES).unwrap();
        DbForumVotes { db, cf_forum_votes }
    }

    /// Record a single verified vote against `entry.target_payload_hash`. Keyed by
    /// `target_payload_hash ++ entry.tx_hash`, so recording the same already-verified vote tx
    /// twice overwrites the same entry rather than double-counting it in [`Self::tally`] (see
    /// module docs).
    pub fn add_vote(&self, entry: &proto::StoredMonadForumVoteEntry) -> Result<()> {
        let key = vote_key(&entry.target_payload_hash, &entry.tx_hash);
        self.db
            .rocksdb()
            .put_cf(self.cf_forum_votes, key, entry.encode_to_vec())
            .wrap_err(super::db::DbError::RocksDb)?;
        Ok(())
    }

    /// Every vote recorded against `target_payload_hash`, in an unspecified order (sufficient for
    /// tallying; ticket #30's non-goals explicitly exclude pagination/ordering parity with the
    /// Lotus registry).
    pub fn votes_for(
        &self,
        target_payload_hash: &[u8],
    ) -> Result<Vec<proto::StoredMonadForumVoteEntry>> {
        let mut votes = Vec::new();
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_forum_votes,
            IteratorMode::From(target_payload_hash, rocksdb::Direction::Forward),
        );
        for item in iter {
            let (key, value) = item.wrap_err(super::db::DbError::RocksDb)?;
            if key.len() < VOTE_KEY_TARGET_LEN || &key[..VOTE_KEY_TARGET_LEN] != target_payload_hash
            {
                // Past the end of this target's key range (rocksdb keys are lexicographically
                // ordered, so once the prefix no longer matches, nothing further in this forward
                // scan can either).
                break;
            }
            let entry = proto::StoredMonadForumVoteEntry::decode(value.as_ref())
                .wrap_err_with(|| CannotDecodeStoredVote(hex::encode(&value)))?;
            votes.push(entry);
        }
        Ok(votes)
    }

    /// Sum of every vote's signed `weight` recorded against `target_payload_hash` (0 if none are
    /// recorded yet).
    pub fn tally(&self, target_payload_hash: &[u8]) -> Result<i64> {
        Ok(self
            .votes_for(target_payload_hash)?
            .into_iter()
            .map(|entry| entry.weight)
            .sum())
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_FORUM_VOTES, options));
    }
}

impl Debug for DbForumVotes<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbForumVotes {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;

    use crate::{proto, store::db::Db};

    fn post(payload_hash: &[u8]) -> proto::StoredMonadForumPost {
        proto::StoredMonadForumPost {
            post: Some(proto::MonadForumPost {
                topic: "test.topic".to_string(),
                parent_post_hash: vec![],
                raw_burn_tx: vec![1, 2, 3],
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.to_vec(),
            }),
            sender_address: vec![9u8; 20],
            tx_hash: vec![8u8; 32],
            timestamp: 1234,
            network_tag: Vec::new(),
        }
    }

    fn vote(
        target_payload_hash: &[u8],
        tx_hash: u8,
        weight: i64,
    ) -> proto::StoredMonadForumVoteEntry {
        proto::StoredMonadForumVoteEntry {
            target_payload_hash: target_payload_hash.to_vec(),
            sender_address: vec![tx_hash; 20],
            tx_hash: vec![tx_hash; 32],
            timestamp: 1234,
            weight,
        }
    }

    #[test]
    fn test_db_forum_posts() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--forum-posts")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let payload_hash = vec![7u8; 32];
        assert_eq!(db.forum_posts().get(&payload_hash)?, None);
        assert!(db.forum_posts().get_existing(&payload_hash).is_err());

        let stored = post(&payload_hash);
        db.forum_posts().put(&payload_hash, &stored)?;
        assert_eq!(db.forum_posts().get(&payload_hash)?, Some(stored.clone()));
        assert_eq!(db.forum_posts().get_existing(&payload_hash)?, stored);

        Ok(())
    }

    #[test]
    fn test_db_forum_votes_tally_multiple() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--forum-votes")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let target = vec![1u8; 32];
        assert_eq!(db.forum_votes().tally(&target)?, 0);

        // Initial vote (up, weight +1000), then two more votes (up +500, down -200).
        db.forum_votes().add_vote(&vote(&target, 0xaa, 1000))?;
        db.forum_votes().add_vote(&vote(&target, 0xbb, 500))?;
        db.forum_votes().add_vote(&vote(&target, 0xcc, -200))?;

        assert_eq!(db.forum_votes().tally(&target)?, 1300);
        assert_eq!(db.forum_votes().votes_for(&target)?.len(), 3);

        // A different post's votes don't leak into this tally.
        let other_target = vec![2u8; 32];
        db.forum_votes().add_vote(&vote(&other_target, 0xdd, 999))?;
        assert_eq!(db.forum_votes().tally(&target)?, 1300);
        assert_eq!(db.forum_votes().tally(&other_target)?, 999);

        Ok(())
    }

    #[test]
    fn test_db_forum_votes_retry_is_idempotent() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--forum-votes-idempotent")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let target = vec![3u8; 32];
        // Same tx_hash recorded twice (e.g. a client retry) must not double-count.
        db.forum_votes().add_vote(&vote(&target, 0xee, 1000))?;
        db.forum_votes().add_vote(&vote(&target, 0xee, 1000))?;

        assert_eq!(db.forum_votes().tally(&target)?, 1000);
        assert_eq!(db.forum_votes().votes_for(&target)?.len(), 1);

        Ok(())
    }

    #[test]
    fn test_db_forum_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--forum-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(format!("{:?}", db.forum_posts()), "DbForumPosts { .. }");
        assert_eq!(format!("{:?}", db.forum_votes()), "DbForumVotes { .. }");
        Ok(())
    }
}
