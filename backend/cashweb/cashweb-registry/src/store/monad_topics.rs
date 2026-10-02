//! Storage for Monad topic posts and their burn-weighted votes (ticket #30):
//! [`DbMonadTopicPosts`] (parallel to [`crate::store::monad_messages::DbMonadMessages`]) and
//! [`DbMonadTopicVotes`] (able to tally multiple votes against the same `payload_hash`).
//!
//! ## Why separate stores, and why votes are keyed the way they are
//!
//! Same reasoning as `crate::store::monad_messages`'s module docs: `DbTopics`'s indexing is built
//! entirely around a Lotus `SignedPayload<BroadcastMessage>` shape a
//! [`crate::proto::MonadTopicPost`]/[`crate::proto::MonadTopicVote`] doesn't have, so this is a
//! new, chain-agnostic-in-practice-if-not-in-name pair of stores, not a reuse of `DbTopics`.
//!
//! [`DbMonadTopicPosts`] is keyed directly by `payload_hash`, exactly like `DbMonadMessages`.
//!
//! ## `list_by_topic` (ticket #40)
//!
//! `CF_MONAD_TOPIC_POSTS_BY_TOPIC` is a secondary index, keyed by `SHA256(topic) ++
//! timestamp.to_be_bytes() ++ payload_hash` (value: the `payload_hash`), maintained alongside the
//! primary `CF_MONAD_TOPIC_POSTS` on every [`DbMonadTopicPosts::put`] -- directly mirroring
//! `crate::store::monad_messages::CF_MONAD_MESSAGES_BY_TIME`'s layout and its "delete the stale
//! index entry first, in the same batch, if a retry changes the indexed fields" idempotency
//! handling.
//!
//! Two judgment calls worth documenting explicitly:
//! - **Hash the topic, don't use it raw.** The ticket's own suggested layout was
//!   `topic ++ timestamp.to_be_bytes() ++ payload_hash`, but a raw, variable-length `topic` prefix
//!   is ambiguous for a prefix scan: topic `"a"` is a byte-prefix of topic `"ab"`, so scanning for
//!   everything starting with `"a"`'s bytes would incorrectly also return `"ab"`'s posts. This
//!   crate already solved exactly this problem for the Lotus path
//!   (`crate::store::topics::DbTopics::get_messages_to`'s `topic_digest`, a `SHA256(topic)`
//!   prefix) -- reusing that fix here instead of reintroducing the bug it fixed.
//! - **Value is the `payload_hash`, not the full `StoredMonadTopicPost`.** [`Registry::
//!   get_monad_topic_post_view`](crate::registry::Registry::get_monad_topic_post_view) needs the post's
//!   current vote tally regardless, which always requires a `DbMonadTopicVotes::tally` lookup keyed by
//!   `payload_hash` -- so listing can never avoid a second lookup the way `CF_MONAD_MESSAGES_BY_TIME`
//!   avoided one for `list_since` (which has no tally to attach). Given that second lookup is
//!   unavoidable either way, storing the full post redundantly in the secondary index would only
//!   add a second place [`DbMonadTopicPosts::put`] must keep in sync (and a second place a decode error
//!   could occur), for no lookup savings. Keeping the index value as just the `payload_hash` (like
//!   `CF_MONAD_MESSAGES_BY_TIME`) keeps `CF_MONAD_TOPIC_POSTS` the single source of truth for post
//!   content.
//!
//! [`DbMonadTopicVotes`] needs to support *multiple* votes accumulating against the same
//! `payload_hash` (a post's initial vote, plus zero or more later [`crate::proto::
//! MonadTopicVote`]s) and to tally them cheaply. It's keyed by `target_payload_hash (32 bytes) ++
//! tx_hash (32 bytes)` so that:
//! - A prefix scan over `target_payload_hash` (via `rocksdb`'s prefix iterator) enumerates every
//!   vote recorded against one post, for [`DbMonadTopicVotes::tally`].
//! - Keying the second half by the vote's own burn `tx_hash` makes storing the same
//!   already-verified vote twice (e.g. a client retrying a request whose response it never saw)
//!   an idempotent overwrite rather than a double-counted duplicate entry, mirroring
//!   `DbMonadMessages::put`'s same idempotency note for the analogous replay case.
//!
//! ## Topic discovery (`list_topics`, ticket #72)
//!
//! Per the design decision on GitHub issue #72, topics stay emergent/tag-based: there's no
//! separate topic-registration flow, and no separate anti-spam gate for showing up in a discovery
//! index -- a topic post already requires a real burn transaction to store (see
//! `monad_topic_verify`'s module docs), so a topic name appearing in `CF_MONAD_TOPIC_DISCOVERY` is
//! already gated by that same cost.
//!
//! `CF_MONAD_TOPIC_DISCOVERY` is a secondary index over `CF_MONAD_TOPIC_POSTS`, keyed by the raw
//! topic name string itself (value: an encoded [`proto::TopicDiscoveryStats`]), maintained
//! alongside the other indexes on every [`DbMonadTopicPosts::put`], in the same `WriteBatch`. Two
//! judgment calls worth documenting explicitly:
//! - **Don't hash the topic here.** Unlike `CF_MONAD_TOPIC_POSTS_BY_TOPIC`, this index is only
//!   ever looked up by exact topic match (`get`), never range/prefix-scanned -- its whole purpose
//!   is to reveal topic names, so there's no ambiguity to hash away and hashing would just make
//!   the stored key unreadable for no benefit.
//! - **Full scan + in-memory sort for [`DbMonadTopicPosts::list_topics`], not a second,
//!   time-ordered index.** Sorting by `last_activity_ms` descending across the whole keyspace
//!   would need either that, or a full scan here. This is expected to stay a small number of
//!   distinct topics (tens to low thousands, not millions), so a full scan + in-memory sort is the
//!   right, simple choice -- don't over-engineer a second index until this is an actual, measured
//!   scaling problem.
//!
//! `post_count` is incremented by exactly one only when [`DbMonadTopicPosts::put`] is storing a
//! genuinely new `payload_hash` (i.e. `self.get(payload_hash)?` returned `None` before this call)
//! -- a client retrying a request whose response it never saw re-`put`s the same `payload_hash`
//! and must not double-count. `last_activity_ms` is instead updated unconditionally to
//! `max(existing, post.timestamp)`, even on a retry: a legitimate update landing with a later
//! timestamp should still be able to bump last-activity.

use std::fmt::Debug;

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use thiserror::Error;

use crate::{
    proto,
    store::db::{
        Db, CF, CF_MONAD_TOPIC_DISCOVERY, CF_MONAD_TOPIC_POSTS, CF_MONAD_TOPIC_POSTS_BY_TOPIC,
        CF_MONAD_TOPIC_VOTES,
    },
};

/// SHA256 digest of a topic string, used as `CF_MONAD_TOPIC_POSTS_BY_TOPIC`'s key prefix instead
/// of the raw topic bytes (see module docs for why).
fn topic_digest(topic: &str) -> Vec<u8> {
    Sha256::digest(topic.as_bytes().into()).to_vec_be()
}

/// Build the `CF_MONAD_TOPIC_POSTS_BY_TOPIC` key for a given `(topic_digest, timestamp, payload_hash)`
/// triple. Kept as a free function so [`DbMonadTopicPosts::put`] and [`DbMonadTopicPosts::list_by_topic`]
/// can't disagree on the encoding (mirrors `store::monad_messages::by_time_key`).
fn by_topic_key(topic_digest: &[u8], timestamp: i64, payload_hash: &[u8]) -> Vec<u8> {
    [topic_digest, timestamp.to_be_bytes().as_ref(), payload_hash].concat()
}

/// Allows access to stored [`proto::StoredMonadTopicPost`]s.
pub struct DbMonadTopicPosts<'a> {
    db: &'a Db,
    cf_monad_topic_posts: &'a CF,
    cf_monad_topic_posts_by_topic: &'a CF,
    cf_monad_topic_discovery: &'a CF,
    cf_monad_topic_votes: &'a CF,
}

/// Result of atomically admitting a CBOR post burn and its mandatory initial vote.
#[derive(Debug, Clone, PartialEq)]
pub struct CborPostAdmission {
    /// The immutable-author row selected by confirmed chain order.
    pub post: proto::StoredMonadTopicPost,
    /// Whether this burn installed or replaced the immutable author.
    pub author_changed: bool,
}

/// Errors indicating some topic-post store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadTopicPostsError {
    /// Database contains an invalid protobuf `StoredMonadTopicPost`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadTopicPost: {0}")]
    CannotDecodeStoredPost(String),

    /// No post stored for the given `payload_hash`.
    #[invalid_user_input()]
    #[error("No topic post found for payload hash {0}")]
    NotFound(String),

    /// Database contains an invalid protobuf `TopicDiscoveryStats` (ticket #72).
    #[critical()]
    #[error("Inconsistent db: Cannot decode TopicDiscoveryStats: {0}")]
    CannotDecodeDiscoveryStats(String),

    /// `CF_MONAD_TOPIC_DISCOVERY`'s key wasn't valid UTF-8 (ticket #72). Can't happen via the real
    /// `put` path (the key is always a `proto::MonadTopicPost.topic`, a `String`), so this is a
    /// caller-contract/db-consistency violation, not a reachable runtime state in practice.
    #[critical()]
    #[error("Inconsistent db: topic discovery key isn't valid UTF-8: {0}")]
    InvalidTopicKey(String),
}

use self::DbMonadTopicPostsError::*;

#[cfg(test)]
static ATOMIC_CBOR_POST_FAILPOINT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn arm_atomic_cbor_post_failpoint() {
    ATOMIC_CBOR_POST_FAILPOINT.store(true, std::sync::atomic::Ordering::SeqCst);
}

impl<'a> DbMonadTopicPosts<'a> {
    /// Create a new [`DbMonadTopicPosts`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_topic_posts = db.cf(CF_MONAD_TOPIC_POSTS).unwrap();
        let cf_monad_topic_posts_by_topic = db.cf(CF_MONAD_TOPIC_POSTS_BY_TOPIC).unwrap();
        let cf_monad_topic_discovery = db.cf(CF_MONAD_TOPIC_DISCOVERY).unwrap();
        let cf_monad_topic_votes = db.cf(CF_MONAD_TOPIC_VOTES).unwrap();
        DbMonadTopicPosts {
            db,
            cf_monad_topic_posts,
            cf_monad_topic_posts_by_topic,
            cf_monad_topic_discovery,
            cf_monad_topic_votes,
        }
    }

    /// Atomically record one CBOR post burn as a vote and install its author projection only when
    /// it is earlier in confirmed chain order than the currently selected CBOR author.
    ///
    /// CBOR rows deliberately do not enter legacy protobuf list/discovery indexes: their inner
    /// `payload_hash` is T1(frame), not legacy SHA256(body), and therefore must never be served as
    /// a `MonadTopicPost` read model during coexistence.
    pub fn admit_cbor_post(
        &self,
        payload_hash: &[u8],
        mut candidate: proto::StoredMonadTopicPost,
        initial_vote: &proto::StoredMonadTopicVoteEntry,
    ) -> Result<CborPostAdmission> {
        let _guard = self.db.lock_monad_topics();
        let existing = self.get(payload_hash)?;
        let (selected, author_changed) = match existing {
            Some(existing) if existing.cbor_post_frame.is_empty() => {
                return Err(bitcoinsuite_error::Report::msg(
                    "refusing to replace a legacy protobuf topic row with a CBOR identity",
                ))
            }
            Some(existing) => {
                let existing_order = (
                    existing.confirmed_block_number,
                    existing.confirmed_transaction_index,
                    existing.tx_hash.as_slice(),
                );
                let candidate_order = (
                    candidate.confirmed_block_number,
                    candidate.confirmed_transaction_index,
                    candidate.tx_hash.as_slice(),
                );
                if candidate_order < existing_order {
                    // Storage time is a relay observation, not chain order. Keep the first
                    // visible timestamp stable while replacing only chain-author facts.
                    candidate.timestamp = existing.timestamp;
                    (candidate, true)
                } else {
                    (existing, false)
                }
            }
            None => (candidate, true),
        };

        let mut batch = rocksdb::WriteBatch::default();
        if author_changed {
            batch.put_cf(
                self.cf_monad_topic_posts,
                payload_hash,
                selected.encode_to_vec(),
            );
        }
        batch.put_cf(
            self.cf_monad_topic_votes,
            vote_key(&initial_vote.target_payload_hash, &initial_vote.tx_hash),
            initial_vote.encode_to_vec(),
        );
        #[cfg(test)]
        if ATOMIC_CBOR_POST_FAILPOINT.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(bitcoinsuite_error::Report::msg(
                "test failpoint before atomic CBOR post batch",
            ));
        }
        self.db.write_batch(batch)?;
        Ok(CborPostAdmission {
            post: selected,
            author_changed,
        })
    }

    /// Store a [`proto::StoredMonadTopicPost`], keyed by its inner post's `payload_hash`, and
    /// index it by `(post.post.topic, post.timestamp)` (ticket #40's `list_by_topic`).
    ///
    /// Idempotent, mirroring `DbMonadMessages::put`: storing the same `payload_hash` again (e.g. a
    /// client retrying a request whose response it never saw) simply overwrites the entry. If a
    /// post already existed under this `payload_hash`, its old by-topic index entry is removed
    /// first (in the same batch) so a retry that lands with a different `timestamp` (or, in
    /// principle, a different `topic` -- `payload_hash` only binds `encrypted_payload`, not
    /// `topic`) doesn't leave a stale, orphaned index row behind.
    pub fn put(&self, payload_hash: &[u8], post: &proto::StoredMonadTopicPost) -> Result<()> {
        let mut batch = rocksdb::WriteBatch::default();
        let existing = self.get(payload_hash)?;
        // Ticket #72: whether this call is storing a genuinely new post (vs. a client retrying a
        // request whose response it never saw) -- only a genuinely new post bumps
        // `CF_MONAD_TOPIC_DISCOVERY`'s `post_count` below.
        let is_new_post = existing.is_none();
        if let Some(existing) = &existing {
            if let Some(existing_post) = existing.post.as_ref() {
                let existing_digest = topic_digest(&existing_post.topic);
                batch.delete_cf(
                    self.cf_monad_topic_posts_by_topic,
                    by_topic_key(&existing_digest, existing.timestamp, payload_hash),
                );
            }
        }
        batch.put_cf(
            self.cf_monad_topic_posts,
            payload_hash,
            post.encode_to_vec(),
        );
        if let Some(new_post) = post.post.as_ref() {
            let digest = topic_digest(&new_post.topic);
            batch.put_cf(
                self.cf_monad_topic_posts_by_topic,
                by_topic_key(&digest, post.timestamp, payload_hash),
                payload_hash,
            );

            // Ticket #72: keep the topic-discovery index up to date in the same batch as
            // everything else above -- see this module's docs for exactly how `post_count`/
            // `last_activity_ms` are meant to evolve.
            let existing_stats = self.discovery_stats(&new_post.topic)?;
            let base_count = existing_stats.as_ref().map_or(0, |stats| stats.post_count);
            let post_count = if is_new_post {
                base_count + 1
            } else {
                base_count
            };
            let last_activity_ms = existing_stats
                .map_or(0, |stats| stats.last_activity_ms)
                .max(post.timestamp);
            let stats = proto::TopicDiscoveryStats {
                post_count,
                last_activity_ms,
            };
            batch.put_cf(
                self.cf_monad_topic_discovery,
                new_post.topic.as_bytes(),
                stats.encode_to_vec(),
            );
        }
        self.db.write_batch(batch)?;
        Ok(())
    }

    /// Look up `topic`'s current [`proto::TopicDiscoveryStats`] in `CF_MONAD_TOPIC_DISCOVERY`.
    /// [`None`] if no post has ever been stored under `topic`.
    fn discovery_stats(&self, topic: &str) -> Result<Option<proto::TopicDiscoveryStats>> {
        let serialized = match self
            .db
            .get(self.cf_monad_topic_discovery, topic.as_bytes())?
        {
            Some(serialized) => serialized,
            None => return Ok(None),
        };
        let stats = proto::TopicDiscoveryStats::decode(serialized.as_ref())
            .wrap_err_with(|| CannotDecodeDiscoveryStats(hex::encode(&serialized)))?;
        Ok(Some(stats))
    }

    /// List every distinct topic name this relay has stored at least one post for, together with
    /// its current [`proto::TopicDiscoveryStats`], ordered by `last_activity_ms` descending
    /// (ticket #72). See this module's docs for why this is a full scan + in-memory sort rather
    /// than a second, time-ordered index -- no pagination cursor is offered (yet) for the same
    /// reason: this is expected to stay a small keyspace (tens to low thousands of distinct
    /// topics, not millions), so add pagination if that ever stops being true.
    pub fn list_topics(&self) -> Result<Vec<(String, proto::TopicDiscoveryStats)>> {
        let mut topics = Vec::new();
        let iter = self
            .db
            .rocksdb()
            .iterator_cf(self.cf_monad_topic_discovery, IteratorMode::Start);
        for item in iter {
            let (key, value) = item.wrap_err(super::db::DbError::RocksDb)?;
            let topic =
                String::from_utf8(key.to_vec()).map_err(|_| InvalidTopicKey(hex::encode(&key)))?;
            let stats = proto::TopicDiscoveryStats::decode(value.as_ref())
                .wrap_err_with(|| CannotDecodeDiscoveryStats(hex::encode(&value)))?;
            topics.push((topic, stats));
        }
        topics.sort_by(|a, b| b.1.last_activity_ms.cmp(&a.1.last_activity_ms));
        Ok(topics)
    }

    /// Retrieve a [`proto::StoredMonadTopicPost`] by its `payload_hash`. [`None`] if not found.
    pub fn get(&self, payload_hash: &[u8]) -> Result<Option<proto::StoredMonadTopicPost>> {
        let serialized = match self.db.get(self.cf_monad_topic_posts, payload_hash)? {
            Some(serialized) => serialized,
            None => return Ok(None),
        };
        let post = proto::StoredMonadTopicPost::decode(serialized.as_ref())
            .wrap_err_with(|| CannotDecodeStoredPost(hex::encode(&serialized)))?;
        Ok(Some(post))
    }

    /// Retrieve a [`proto::StoredMonadTopicPost`] by its `payload_hash`, erroring with
    /// [`DbMonadTopicPostsError::NotFound`] if it doesn't exist.
    pub fn get_existing(&self, payload_hash: &[u8]) -> Result<proto::StoredMonadTopicPost> {
        self.get(payload_hash)?
            .ok_or_else(|| NotFound(hex::encode(payload_hash)).into())
    }

    /// List every [`proto::StoredMonadTopicPost`] stored under `topic` with `timestamp >= since`
    /// (milliseconds since the Unix epoch), ordered by `timestamp` ascending (ticket #40).
    ///
    /// Signature note: takes a single `since` cursor rather than a Lotus-style `from`/`to` range
    /// (ticket #33's issue body mentions `getBroadcastMessages`'s `from`/`to` as one possible
    /// model) -- matching `DbMonadMessages::list_since`'s simpler shape instead, since ticket #40's
    /// own non-goals explicitly exclude pagination beyond a simple since/time-range cursor, and a
    /// `to` bound isn't needed to satisfy "fetch all messages for a topic" (ticket #33's actual
    /// requirement this unblocks). A `to` bound can be layered on later without changing this
    /// method's meaning for existing callers.
    pub fn list_by_topic(
        &self,
        topic: &str,
        since: i64,
    ) -> Result<Vec<proto::StoredMonadTopicPost>> {
        let digest = topic_digest(topic);
        let start_key = by_topic_key(&digest, since, &[]);
        let mut posts = Vec::new();
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_topic_posts_by_topic,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        for item in iter {
            let (key, payload_hash) = item.wrap_err(super::db::DbError::RocksDb)?;
            if !key.starts_with(&digest) {
                // Past the end of this topic's key range (rocksdb keys are lexicographically
                // ordered, so once the topic-digest prefix no longer matches, nothing further in
                // this forward scan can either).
                break;
            }
            posts.push(self.get_existing(&payload_hash)?);
        }
        Ok(posts)
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_MONAD_TOPIC_POSTS, options));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_TOPIC_POSTS_BY_TOPIC,
            rocksdb::Options::default(),
        ));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_TOPIC_DISCOVERY,
            rocksdb::Options::default(),
        ));
    }
}

impl Debug for DbMonadTopicPosts<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbMonadTopicPosts {{ .. }}")
    }
}

/// Length, in bytes, of the `target_payload_hash` prefix of a [`DbMonadTopicVotes`] key.
const VOTE_KEY_TARGET_LEN: usize = 32;

/// Allows access to stored [`proto::StoredMonadTopicVoteEntry`]s and their per-post tally.
pub struct DbMonadTopicVotes<'a> {
    db: &'a Db,
    cf_monad_topic_votes: &'a CF,
}

/// Errors indicating some topic-vote store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadTopicVotesError {
    /// Database contains an invalid protobuf `StoredMonadTopicVoteEntry`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadTopicVoteEntry: {0}")]
    CannotDecodeStoredVote(String),
}

use self::DbMonadTopicVotesError::*;

fn vote_key(target_payload_hash: &[u8], tx_hash: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(target_payload_hash.len() + tx_hash.len());
    key.extend_from_slice(target_payload_hash);
    key.extend_from_slice(tx_hash);
    key
}

impl<'a> DbMonadTopicVotes<'a> {
    /// Create a new [`DbMonadTopicVotes`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_topic_votes = db.cf(CF_MONAD_TOPIC_VOTES).unwrap();
        DbMonadTopicVotes {
            db,
            cf_monad_topic_votes,
        }
    }

    /// Record a single verified vote against `entry.target_payload_hash`. Keyed by
    /// `target_payload_hash ++ entry.tx_hash`, so recording the same already-verified vote tx
    /// twice overwrites the same entry rather than double-counting it in [`Self::tally`] (see
    /// module docs).
    pub fn add_vote(&self, entry: &proto::StoredMonadTopicVoteEntry) -> Result<()> {
        let key = vote_key(&entry.target_payload_hash, &entry.tx_hash);
        self.db
            .rocksdb()
            .put_cf(self.cf_monad_topic_votes, key, entry.encode_to_vec())
            .wrap_err(super::db::DbError::RocksDb)?;
        Ok(())
    }

    /// Every vote recorded against `target_payload_hash`, in an unspecified order (sufficient for
    /// tallying; ticket #30's non-goals explicitly exclude pagination/ordering parity with the
    /// Lotus registry).
    pub fn votes_for(
        &self,
        target_payload_hash: &[u8],
    ) -> Result<Vec<proto::StoredMonadTopicVoteEntry>> {
        let mut votes = Vec::new();
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_topic_votes,
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
            let entry = proto::StoredMonadTopicVoteEntry::decode(value.as_ref())
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
        columns.push(ColumnFamilyDescriptor::new(CF_MONAD_TOPIC_VOTES, options));
    }
}

impl Debug for DbMonadTopicVotes<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbMonadTopicVotes {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;
    use prost::Message;

    use crate::{proto, store::db::Db};

    use super::arm_atomic_cbor_post_failpoint;

    fn post(payload_hash: &[u8]) -> proto::StoredMonadTopicPost {
        proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost {
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
            cbor_post_frame: Vec::new(),
            confirmed_block_number: 0,
            confirmed_transaction_index: 0,
        }
    }

    fn post_with(
        payload_hash: Vec<u8>,
        topic: &str,
        timestamp: i64,
    ) -> proto::StoredMonadTopicPost {
        proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost {
                topic: topic.to_string(),
                parent_post_hash: vec![],
                raw_burn_tx: vec![1, 2, 3],
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
            }),
            sender_address: vec![9u8; 20],
            tx_hash: vec![8u8; 32],
            timestamp,
            network_tag: Vec::new(),
            cbor_post_frame: Vec::new(),
            confirmed_block_number: 0,
            confirmed_transaction_index: 0,
        }
    }

    fn vote(
        target_payload_hash: &[u8],
        tx_hash: u8,
        weight: i64,
    ) -> proto::StoredMonadTopicVoteEntry {
        proto::StoredMonadTopicVoteEntry {
            target_payload_hash: target_payload_hash.to_vec(),
            sender_address: vec![tx_hash; 20],
            tx_hash: vec![tx_hash; 32],
            timestamp: 1234,
            weight,
        }
    }

    fn cbor_post(
        payload_hash: &[u8],
        frame: &[u8],
        author_byte: u8,
        block: u64,
        tx_index: u64,
    ) -> proto::StoredMonadTopicPost {
        let mut stored = post(payload_hash);
        stored.sender_address = vec![author_byte; 20];
        stored.tx_hash = vec![author_byte; 32];
        stored.cbor_post_frame = frame.to_vec();
        stored.confirmed_block_number = block;
        stored.confirmed_transaction_index = tx_index;
        stored
    }

    #[test]
    fn test_db_monad_topic_posts() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-posts")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let db = Db::open(&db_path)?;

        let payload_hash = vec![7u8; 32];
        assert_eq!(db.monad_topic_posts().get(&payload_hash)?, None);
        assert!(db.monad_topic_posts().get_existing(&payload_hash).is_err());

        let stored = post(&payload_hash);
        db.monad_topic_posts().put(&payload_hash, &stored)?;
        assert_eq!(
            db.monad_topic_posts().get(&payload_hash)?,
            Some(stored.clone())
        );
        assert_eq!(db.monad_topic_posts().get_existing(&payload_hash)?, stored);

        drop(db);
        let reopened = Db::open(&db_path)?;
        assert_eq!(
            reopened.monad_topic_posts().get(&payload_hash)?,
            Some(post(&payload_hash)),
            "Monad pubsub records must survive a server/database restart"
        );

        Ok(())
    }

    #[test]
    fn test_db_monad_topic_votes_tally_multiple() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-votes")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let target = vec![1u8; 32];
        assert_eq!(db.monad_topic_votes().tally(&target)?, 0);

        // Initial vote (up, weight +1000), then two more votes (up +500, down -200).
        db.monad_topic_votes()
            .add_vote(&vote(&target, 0xaa, 1000))?;
        db.monad_topic_votes().add_vote(&vote(&target, 0xbb, 500))?;
        db.monad_topic_votes()
            .add_vote(&vote(&target, 0xcc, -200))?;

        assert_eq!(db.monad_topic_votes().tally(&target)?, 1300);
        assert_eq!(db.monad_topic_votes().votes_for(&target)?.len(), 3);

        // A different post's votes don't leak into this tally.
        let other_target = vec![2u8; 32];
        db.monad_topic_votes()
            .add_vote(&vote(&other_target, 0xdd, 999))?;
        assert_eq!(db.monad_topic_votes().tally(&target)?, 1300);
        assert_eq!(db.monad_topic_votes().tally(&other_target)?, 999);

        Ok(())
    }

    #[test]
    fn test_db_monad_topic_votes_retry_is_idempotent() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-votes-idempotent")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let target = vec![3u8; 32];
        // Same tx_hash recorded twice (e.g. a client retry) must not double-count.
        db.monad_topic_votes()
            .add_vote(&vote(&target, 0xee, 1000))?;
        db.monad_topic_votes()
            .add_vote(&vote(&target, 0xee, 1000))?;

        assert_eq!(db.monad_topic_votes().tally(&target)?, 1000);
        assert_eq!(db.monad_topic_votes().votes_for(&target)?.len(), 1);

        Ok(())
    }

    #[test]
    fn cbor_post_and_initial_vote_are_one_atomic_visibility_unit() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-cbor-atomic")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let target = [0x31; 32];
        let post = cbor_post(&target, b"authoritative-frame", 7, 10, 2);
        let initial_vote = vote(&target, 7, 500);

        arm_atomic_cbor_post_failpoint();
        assert!(db
            .monad_topic_posts()
            .admit_cbor_post(&target, post.clone(), &initial_vote)
            .is_err());
        assert_eq!(db.monad_topic_posts().get(&target)?, None);
        assert_eq!(db.monad_topic_votes().tally(&target)?, 0);

        db.monad_topic_posts()
            .admit_cbor_post(&target, post.clone(), &initial_vote)?;
        assert_eq!(db.monad_topic_posts().get(&target)?, Some(post));
        assert_eq!(db.monad_topic_votes().tally(&target)?, 500);
        Ok(())
    }

    #[test]
    fn cbor_author_is_earliest_confirmed_burn_sequentially_and_concurrently() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-cbor-author")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let target = [0x32; 32];
        let frame = b"same-authoritative-frame";

        db.monad_topic_posts().admit_cbor_post(
            &target,
            cbor_post(&target, frame, 9, 20, 4),
            &vote(&target, 9, 9),
        )?;
        db.monad_topic_posts().admit_cbor_post(
            &target,
            cbor_post(&target, frame, 3, 19, 8),
            &vote(&target, 3, 3),
        )?;
        assert_eq!(
            db.monad_topic_posts().get(&target)?.unwrap().sender_address,
            vec![3; 20]
        );

        std::thread::scope(|scope| {
            for (author, block, index) in [(8, 18, 2), (1, 18, 1), (7, 21, 0)] {
                let db = &db;
                scope.spawn(move || {
                    db.monad_topic_posts()
                        .admit_cbor_post(
                            &target,
                            cbor_post(&target, frame, author, block, index),
                            &vote(&target, author, author as i64),
                        )
                        .unwrap();
                });
            }
        });
        let selected = db.monad_topic_posts().get(&target)?.unwrap();
        assert_eq!(selected.confirmed_block_number, 18);
        assert_eq!(selected.confirmed_transaction_index, 1);
        assert_eq!(selected.sender_address, vec![1; 20]);
        assert_eq!(db.monad_topic_votes().votes_for(&target)?.len(), 5);
        Ok(())
    }

    #[test]
    fn cbor_frame_and_vote_survive_reopen_without_entering_legacy_indexes() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-cbor-reopen")?;
        let path = tempdir.path().join("db.rocksdb");
        let target = [0x33; 32];
        let frame = b"exact-frame-kept-byte-for-byte";
        {
            let db = Db::open(&path)?;
            db.monad_topic_posts().admit_cbor_post(
                &target,
                cbor_post(&target, frame, 4, 30, 5),
                &vote(&target, 4, 400),
            )?;
        }
        let reopened = Db::open(&path)?;
        assert_eq!(
            reopened
                .monad_topic_posts()
                .get(&target)?
                .unwrap()
                .cbor_post_frame,
            frame
        );
        assert_eq!(reopened.monad_topic_votes().tally(&target)?, 400);
        assert!(reopened
            .monad_topic_posts()
            .list_by_topic("test.topic", 0)?
            .is_empty());
        assert!(reopened.monad_topic_posts().list_topics()?.is_empty());
        Ok(())
    }

    #[test]
    fn pre_field_legacy_fixture_still_decodes_with_empty_cbor_author_fields() -> Result<()> {
        // Captured from the schema before fields 7/8 existed, rather than encoded by the current
        // generated type, so this guards the actual deployed wire compatibility.
        let bytes = hex::decode("0a380a0a746573742e746f7069631a0301020322030405062a203434343434343434343434343434343434343434343434343434343434343434121409090909090909090909090909090909090909091a20080808080808080808080808080808080808080808080808080808080808080820d209")?;
        let decoded = proto::StoredMonadTopicPost::decode(bytes.as_slice())?;
        assert_eq!(decoded.post.unwrap().payload_hash, vec![0x34; 32]);
        assert!(decoded.cbor_post_frame.is_empty());
        assert_eq!(decoded.confirmed_block_number, 0);
        assert_eq!(decoded.confirmed_transaction_index, 0);
        Ok(())
    }

    #[test]
    fn test_list_by_topic_orders_by_timestamp_and_respects_cursor() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-list-by-topic")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        let early = post_with(vec![1u8; 32], "some.topic", 100);
        let middle = post_with(vec![2u8; 32], "some.topic", 200);
        let late = post_with(vec![3u8; 32], "some.topic", 300);

        // Insert out of order to prove `list_by_topic` sorts by timestamp, not insertion order.
        store.put(&late.post.as_ref().unwrap().payload_hash, &late)?;
        store.put(&early.post.as_ref().unwrap().payload_hash, &early)?;
        store.put(&middle.post.as_ref().unwrap().payload_hash, &middle)?;

        assert_eq!(
            store.list_by_topic("some.topic", 0)?,
            vec![early.clone(), middle.clone(), late.clone()]
        );
        assert_eq!(
            store.list_by_topic("some.topic", 200)?,
            vec![middle.clone(), late.clone()]
        );
        assert_eq!(store.list_by_topic("some.topic", 301)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_list_by_topic_excludes_posts_for_a_different_topic() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-list-by-topic-excl")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        let wanted = post_with(vec![1u8; 32], "topic.one", 100);
        // Deliberately chosen so "topic.one" is a byte-prefix of this other topic, proving the
        // topic-digest hashing (not a raw-bytes prefix scan) is what keeps these separate.
        let other = post_with(vec![2u8; 32], "topic.one.sub", 150);
        let unrelated = post_with(vec![3u8; 32], "topic.two", 175);

        store.put(&wanted.post.as_ref().unwrap().payload_hash, &wanted)?;
        store.put(&other.post.as_ref().unwrap().payload_hash, &other)?;
        store.put(&unrelated.post.as_ref().unwrap().payload_hash, &unrelated)?;

        assert_eq!(store.list_by_topic("topic.one", 0)?, vec![wanted]);
        assert_eq!(store.list_by_topic("topic.one.sub", 0)?, vec![other]);
        assert_eq!(store.list_by_topic("topic.two", 0)?, vec![unrelated]);
        assert_eq!(store.list_by_topic("topic.three", 0)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_list_by_topic_after_retry_with_new_timestamp_has_no_stale_entry() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-list-by-topic-retry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        let payload_hash = vec![7u8; 32];
        let first = post_with(payload_hash.clone(), "retry.topic", 100);
        let retried = post_with(payload_hash.clone(), "retry.topic", 200);

        store.put(&payload_hash, &first)?;
        store.put(&payload_hash, &retried)?;

        // Only the latest write should show up -- the stale by-topic index entry from the first
        // `put` (timestamp 100) must have been cleaned up, not left as an orphaned duplicate.
        assert_eq!(store.list_by_topic("retry.topic", 0)?, vec![retried]);

        Ok(())
    }

    #[test]
    fn test_db_monad_topic_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(
            format!("{:?}", db.monad_topic_posts()),
            "DbMonadTopicPosts { .. }"
        );
        assert_eq!(
            format!("{:?}", db.monad_topic_votes()),
            "DbMonadTopicVotes { .. }"
        );
        Ok(())
    }

    /// Ticket #72: two posts to different topics, then a second post to one of them --
    /// `post_count` should increment correctly per-topic and `last_activity_ms` should advance to
    /// the newer post's timestamp without ever decreasing.
    #[test]
    fn test_list_topics_tracks_post_count_and_last_activity_per_topic() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-discovery")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        store.put(&[1u8; 32], &post_with(vec![1u8; 32], "topic.alpha", 100))?;
        store.put(&[2u8; 32], &post_with(vec![2u8; 32], "topic.beta", 150))?;
        // A second post to "topic.alpha", with a later timestamp.
        store.put(&[3u8; 32], &post_with(vec![3u8; 32], "topic.alpha", 300))?;

        let topics: std::collections::HashMap<String, proto::TopicDiscoveryStats> =
            store.list_topics()?.into_iter().collect();

        let alpha = topics.get("topic.alpha").expect("topic.alpha discovered");
        assert_eq!(alpha.post_count, 2);
        assert_eq!(alpha.last_activity_ms, 300);

        let beta = topics.get("topic.beta").expect("topic.beta discovered");
        assert_eq!(beta.post_count, 1);
        assert_eq!(beta.last_activity_ms, 150);

        Ok(())
    }

    /// Ticket #72: retrying a `put` for the same `payload_hash` (e.g. a client re-sending a
    /// request whose response it never saw) must not double-count `post_count`, even though
    /// `last_activity_ms` may still legitimately advance if the retry carries a later timestamp.
    #[test]
    fn test_list_topics_retry_of_same_payload_hash_does_not_double_count() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-discovery-retry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        let payload_hash = vec![7u8; 32];
        store.put(
            &payload_hash,
            &post_with(payload_hash.clone(), "retry.topic", 100),
        )?;
        // Same payload_hash, later timestamp -- a retry, not a new post.
        store.put(
            &payload_hash,
            &post_with(payload_hash.clone(), "retry.topic", 200),
        )?;

        let topics: std::collections::HashMap<String, proto::TopicDiscoveryStats> =
            store.list_topics()?.into_iter().collect();
        let stats = topics.get("retry.topic").expect("retry.topic discovered");
        assert_eq!(stats.post_count, 1);
        assert_eq!(stats.last_activity_ms, 200);

        Ok(())
    }

    /// Ticket #72: `list_topics` orders its results by `last_activity_ms` descending.
    #[test]
    fn test_list_topics_orders_by_last_activity_descending() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--topic-discovery-order")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_topic_posts();

        store.put(&[1u8; 32], &post_with(vec![1u8; 32], "topic.oldest", 100))?;
        store.put(&[2u8; 32], &post_with(vec![2u8; 32], "topic.newest", 300))?;
        store.put(&[3u8; 32], &post_with(vec![3u8; 32], "topic.middle", 200))?;

        let topics = store.list_topics()?;
        let names: Vec<String> = topics.into_iter().map(|(topic, _)| topic).collect();
        assert_eq!(names, vec!["topic.newest", "topic.middle", "topic.oldest"]);

        Ok(())
    }
}
