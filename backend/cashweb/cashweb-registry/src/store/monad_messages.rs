//! Contains `DbMonadMessages`, allowing storage of Monad-stamped broadcast messages
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
//! Lotus `Tx` to hand it (its `raw_burn_tx` is an RLP-encoded EVM transaction), so it can't be
//! wrapped into a `SignedPayload<proto::BroadcastMessage>` without either faking a `BurnTx` (which
//! would corrupt `DbTopics`'s indexing invariants) or forking `SignedPayload` itself (out of scope
//! -- `cashweb-payload` is explicitly off limits for this ticket). Hence: a separate, much simpler
//! store, keyed directly by `payload_hash` (mirroring `DbTopics`'s `cf_payloads` column family,
//! minus the topic-indexing machinery this simpler message shape doesn't need).

use std::fmt::Debug;

use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::ColumnFamilyDescriptor;
use thiserror::Error;

use crate::{
    proto,
    store::db::{Db, CF, CF_MONAD_MESSAGES},
};

/// Allows access to stored Monad-stamped messages.
pub struct DbMonadMessages<'a> {
    db: &'a Db,
    cf_monad_messages: &'a CF,
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
        DbMonadMessages {
            db,
            cf_monad_messages,
        }
    }

    /// Store a [`proto::StoredMonadMessage`], keyed by its inner message's `payload_hash`.
    ///
    /// Idempotent: storing the same `payload_hash` again (e.g. a client retrying a request whose
    /// response it never saw) simply overwrites the entry with the same content, mirroring
    /// `DbTopics::put_message`'s "already known payload hash" handling for the Lotus path.
    pub fn put(&self, payload_hash: &[u8], message: &proto::StoredMonadMessage) -> Result<()> {
        self.db
            .rocksdb()
            .put_cf(self.cf_monad_messages, payload_hash, message.encode_to_vec())
            .wrap_err(super::db::DbError::RocksDb)?;
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

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_MONAD_MESSAGES, options));
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
                raw_burn_tx: vec![1, 2, 3],
                encrypted_payload: vec![4, 5, 6],
                payload_hash: payload_hash.clone(),
            }),
            sender_address: vec![9u8; 20],
            tx_hash: vec![8u8; 32],
            timestamp: 1234,
        };
        db.monad_messages().put(&payload_hash, &stored)?;
        assert_eq!(db.monad_messages().get(&payload_hash)?, Some(stored.clone()));
        assert_eq!(db.monad_messages().get_existing(&payload_hash)?, stored);

        Ok(())
    }

    #[test]
    fn test_db_monad_messages_debug() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages-debug")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        assert_eq!(format!("{:?}", db.monad_messages()), "DbMonadMessages { .. }");
        Ok(())
    }
}
