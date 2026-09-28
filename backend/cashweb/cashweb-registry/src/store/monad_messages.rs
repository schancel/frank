//! Contains `DbMonadMessages`, allowing storage of Monad-stamped direct messages
//! ([`proto::StoredMonadMessage`], ticket #27).
//!
//! ## Why this is a separate store from `DbTopics`
//!
//! `DbTopics` (see `crate::store::topics`) stores `cashweb_payload::payload::SignedPayload<
//! proto::BroadcastMessage>` -- a type whose `burn_txs: Vec<BurnTx>` wraps a Lotus
//! `bitcoinsuite_core::Tx` (see `cashweb-payload/src/payload.rs`), and whose indexing
//! (`lotus_txid`, `add_burn_txs`, the per-topic key layout) is built entirely around that Lotus
//! `Tx` shape. That storage path is therefore **not** chain-agnostic despite appearances -- it was
//! checked (not assumed) while implementing this ticket, per the ticket's own instruction to find
//! out whether the existing storage path could be reused. A [`proto::MonadStampedMessage`] has no
//! Lotus `Tx` to hand it (its `stamp_payments` are RLP-encoded EVM transactions), so it can't be
//! wrapped into a `SignedPayload<proto::BroadcastMessage>` without either faking a `BurnTx` (which
//! would corrupt `DbTopics`'s indexing invariants) or forking `SignedPayload` itself (out of scope
//! -- `cashweb-payload` is explicitly off limits for this ticket). Hence: a separate, much simpler
//! store, keyed directly by `payload_hash` (mirroring `DbTopics`'s `cf_payloads` column family,
//! minus the topic-indexing machinery this simpler message shape doesn't need).
//!
//! ## `list_since` (ticket #37)
//!
//! `CF_MONAD_MESSAGES_BY_TIME` is a secondary index, keyed by `timestamp.to_be_bytes() ++
//! payload_hash` (value: the `payload_hash`), maintained alongside the primary
//! `CF_MONAD_MESSAGES` on every [`DbMonadMessages::put`]. It exists so [`DbMonadMessages::
//! list_since`] can range-scan messages in timestamp order -- mirroring `DbTopics`'s `CF_MESSAGES`
//! "topic_digest ++ timestamp" key layout (see `crate::store::topics::DbTopics::get_messages_to`),
//! minus the topic prefix this simpler message shape has no equivalent of. See `crate::http::
//! monad_message`'s module docs (and ticket #37's handoff) for why this can list messages by time
//! but **not** filter by intended recipient: nothing in [`proto::MonadStampedMessage`]/
//! [`proto::StoredMonadMessage`] identifies one.

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use thiserror::Error;

use crate::{
    proto,
    store::db::{Db, CF, CF_MONAD_MESSAGES, CF_MONAD_MESSAGES_BY_TIME},
};

/// Build the `CF_MONAD_MESSAGES_BY_TIME` key for a given `(timestamp, payload_hash)` pair. Kept
/// as a free function so [`DbMonadMessages::put`] and [`DbMonadMessages::list_since`] can't
/// disagree on the encoding.
fn by_time_key(timestamp: i64, payload_hash: &[u8]) -> Vec<u8> {
    [timestamp.to_be_bytes().as_ref(), payload_hash].concat()
}

/// Allows access to stored Monad-stamped messages.
pub struct DbMonadMessages<'a> {
    db: &'a Db,
    cf_monad_messages: &'a CF,
    cf_monad_messages_by_time: &'a CF,
}

/// Errors indicating some Monad-message store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadMessagesError {
    /// Database contains an invalid protobuf `StoredMonadMessage`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadMessage: {0}")]
    CannotDecodeStoredMessage(String),

    /// No message stored for the given `payload_hash`.
    #[invalid_user_input()]
    #[error("No Monad message found for payload hash {0}")]
    NotFound(String),
}

use self::DbMonadMessagesError::*;

impl<'a> DbMonadMessages<'a> {
    /// Create a new [`DbMonadMessages`] instance.
    pub fn new(db: &'a Db) -> Self {
        let cf_monad_messages = db.cf(CF_MONAD_MESSAGES).unwrap();
        let cf_monad_messages_by_time = db.cf(CF_MONAD_MESSAGES_BY_TIME).unwrap();
        DbMonadMessages {
            db,
            cf_monad_messages,
            cf_monad_messages_by_time,
        }
    }

    /// Store a [`proto::StoredMonadMessage`], keyed by its inner message's `payload_hash`, and
    /// index it by `message.timestamp` (ticket #37's `list_since`).
    ///
    /// Idempotent: storing the same `payload_hash` again (e.g. a client retrying a request whose
    /// response it never saw) simply overwrites the entry with the same content, mirroring
    /// `DbTopics::put_message`'s "already known payload hash" handling for the Lotus path. If a
    /// message already existed under this `payload_hash`, its old by-time index entry is removed
    /// first (in the same batch) so a retry with a different `timestamp` doesn't leave a stale,
    /// orphaned index row behind.
    pub fn put(&self, payload_hash: &[u8], message: &proto::StoredMonadMessage) -> Result<()> {
        let mut batch = rocksdb::WriteBatch::default();
        if let Some(existing) = self.get(payload_hash)? {
            batch.delete_cf(
                self.cf_monad_messages_by_time,
                by_time_key(existing.timestamp, payload_hash),
            );
        }
        batch.put_cf(
            self.cf_monad_messages,
            payload_hash,
            message.encode_to_vec(),
        );
        batch.put_cf(
            self.cf_monad_messages_by_time,
            by_time_key(message.timestamp, payload_hash),
            payload_hash,
        );
        self.db.write_batch(batch)?;
        Ok(())
    }

    /// Retrieve a [`proto::StoredMonadMessage`] by its `payload_hash`. [`None`] if not found.
    pub fn get(&self, payload_hash: &[u8]) -> Result<Option<proto::StoredMonadMessage>> {
        let serialized = match self.db.get(self.cf_monad_messages, payload_hash)? {
            Some(serialized) => serialized,
            None => return Ok(None),
        };
        let message = proto::StoredMonadMessage::decode(serialized.as_ref())
            .wrap_err_with(|| CannotDecodeStoredMessage(hex::encode(&serialized)))?;
        Ok(Some(message))
    }

    /// Retrieve a [`proto::StoredMonadMessage`] by its `payload_hash`, erroring with
    /// [`DbMonadMessagesError::NotFound`] if it doesn't exist.
    pub fn get_existing(&self, payload_hash: &[u8]) -> Result<proto::StoredMonadMessage> {
        self.get(payload_hash)?
            .ok_or_else(|| NotFound(hex::encode(payload_hash)).into())
    }

    /// List every [`proto::StoredMonadMessage`] stored with `timestamp >= since` (milliseconds
    /// since the Unix epoch), ordered by `timestamp` ascending (ticket #37). Lets a client
    /// discover newly-stored messages by polling with an advancing cursor, without already
    /// knowing their `payload_hash` out of band -- see this module's docs for why this can't
    /// additionally filter by intended recipient.
    pub fn list_since(&self, since: i64) -> Result<Vec<proto::StoredMonadMessage>> {
        let start_key = by_time_key(since, &[]);
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_messages_by_time,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        iter.map(|item| {
            let (_, payload_hash) = item?;
            self.get_existing(&payload_hash)
        })
        .collect()
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_MONAD_MESSAGES, options));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_MESSAGES_BY_TIME,
            rocksdb::Options::default(),
        ));
    }
}

impl Debug for DbMonadMessages<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbMonadMessages {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_error::Result;
    use pretty_assertions::assert_eq;

    use crate::{proto, store::db::Db};

    #[test]
    fn test_db_monad_messages() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        let payload_hash = vec![7u8; 32];
        assert_eq!(db.monad_messages().get(&payload_hash)?, None);
        assert!(db.monad_messages().get_existing(&payload_hash).is_err());

        let stored = proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
                stamp_payments: vec![proto::MonadStampPayment {
                    child_index: 0,
                    raw_tx: vec![1, 2, 3],
                }],
            }),
            timestamp: 1234,
            network_tag: Vec::new(),
        };
        db.monad_messages().put(&payload_hash, &stored)?;
        assert_eq!(
            db.monad_messages().get(&payload_hash)?,
            Some(stored.clone())
        );
        assert_eq!(db.monad_messages().get_existing(&payload_hash)?, stored);

        Ok(())
    }

    #[test]
    fn test_db_monad_messages_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(
            format!("{:?}", db.monad_messages()),
            "DbMonadMessages { .. }"
        );
        Ok(())
    }

    fn make_stored(payload_hash: Vec<u8>, timestamp: i64) -> proto::StoredMonadMessage {
        proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
                stamp_payments: vec![proto::MonadStampPayment {
                    child_index: 0,
                    raw_tx: vec![1, 2, 3],
                }],
            }),
            timestamp,
            network_tag: Vec::new(),
        }
    }

    #[test]
    fn test_list_since_orders_by_timestamp_and_respects_cursor() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages-list-since")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();

        let early = make_stored(vec![1u8; 32], 100);
        let middle = make_stored(vec![2u8; 32], 200);
        let late = make_stored(vec![3u8; 32], 300);

        // Insert out of order to prove `list_since` sorts by timestamp, not insertion order.
        store.put(&late.message.as_ref().unwrap().payload_hash, &late)?;
        store.put(&early.message.as_ref().unwrap().payload_hash, &early)?;
        store.put(&middle.message.as_ref().unwrap().payload_hash, &middle)?;

        assert_eq!(
            store.list_since(0)?,
            vec![early.clone(), middle.clone(), late.clone()]
        );
        assert_eq!(store.list_since(200)?, vec![middle.clone(), late.clone()]);
        assert_eq!(store.list_since(301)?, vec![]);

        Ok(())
    }

    #[test]
    fn test_list_since_after_retry_with_new_timestamp_has_no_stale_entry() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages-retry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();

        let payload_hash = vec![7u8; 32];
        let first = make_stored(payload_hash.clone(), 100);
        let retried = make_stored(payload_hash.clone(), 200);

        store.put(&payload_hash, &first)?;
        store.put(&payload_hash, &retried)?;

        // Only the latest write should show up -- the stale by-time index entry from the first
        // `put` (timestamp 100) must have been cleaned up, not left as an orphaned duplicate.
        assert_eq!(store.list_since(0)?, vec![retried]);

        Ok(())
    }
}
