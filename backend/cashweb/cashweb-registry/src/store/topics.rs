//! Contains `DbTopics`, allowing access to topic data.
//!
//! `tp/` + payload hash holds the message with every burn known for it; each new burn adds one
//! `tm/` row per topic prefix (`sha256(prefix) ++ timestamp_be ++ txid`, value: the message
//! without its payload) and marks the burn in `tb/`. A put is one transaction, so a burn
//! offered to two replicas at once is indexed once.

use crate::{
    proto,
    store::{
        db::{get_value, mark_format, put_value, Db, SCAN_BATCH},
        kv_store::key_after,
    },
};
use bitcoinsuite_core::{lotus_txid, Hashed, Sha256};
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use cashweb_payload::payload::SignedPayload;
use prost::Message;
use std::fmt::Debug;
use thiserror::Error;

type TopicPayload = SignedPayload<proto::BroadcastMessage>;

const PAYLOADS_PREFIX: &[u8] = b"tp/";
const MESSAGES_PREFIX: &[u8] = b"tm/";
const BURNS_PREFIX: &[u8] = b"tb/";

fn payload_key(payload_hash: &[u8]) -> Vec<u8> {
    [PAYLOADS_PREFIX, payload_hash].concat()
}

fn burn_key(txid: &[u8]) -> Vec<u8> {
    [BURNS_PREFIX, txid].concat()
}

/// Allows access to registry metadata.
pub struct DbTopics<'a> {
    db: &'a Db,
}

/// Errors indicating some registry topic error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbTopicsError {
    /// Value not found in message
    #[critical()]
    #[error("Value not found in messages: {0}")]
    MissingValue(String),

    /// Topic has too many separators
    #[critical()]
    #[error("Topic has too many separators: {0} > 10")]
    TopicTooLong(usize),

    /// Topic contains invalid characters
    #[critical()]
    #[error("Topic contains invalid characters")]
    TopicInvalidCharacters(),

    /// Topic contains empty segments
    #[critical()]
    #[error("Topic contains empty segments")]
    TopicInvalidSegments(),

    /// Database contains an invalid protobuf MetadataEntry.
    #[critical()]
    #[error("Inconsistent db: Invalid SignedPayload in DB")]
    InvalidSignedPayloadInDb,

    /// Attempting to write message with no payload
    #[critical()]
    #[error("Attempting to write message with no payload")]
    MissingPayload(),
}
use self::DbTopicsError::*;

fn decode(bytes: &[u8]) -> Result<TopicPayload> {
    let proto = cashweb_payload::proto::SignedPayload::decode(bytes)?;
    TopicPayload::parse_proto(&proto).wrap_err(InvalidSignedPayloadInDb)
}

/// Allows access to registry topics.
impl<'a> DbTopics<'a> {
    /// Create a new [`DbTopic`] instance.
    pub fn new(db: &'a Db) -> Self {
        DbTopics { db }
    }

    /// Put a `Message`, or another burn for a known one, in one transaction: the stored
    /// message gains the new burns, and each burn not seen before is indexed under every topic
    /// prefix.
    pub fn put_message(&self, timestamp: u64, message: &TopicPayload) -> Result<()> {
        let payload_hash = message.payload_hash().as_slice();
        let index_value = message.to_proto_without_payload().encode_to_vec();
        self.db.transact(|tx| {
            let (stored, new_burns) = match get_value(tx, &payload_key(payload_hash))? {
                Some(bytes) => {
                    let mut found = decode(&bytes)?;
                    let new_burns = found.add_burn_txs(message.txs());
                    (found, new_burns)
                }
                None => {
                    message.payload().as_ref().ok_or(MissingPayload())?;
                    (message.clone(), message.txs().iter().collect())
                }
            };
            let topic = stored
                .payload()
                .as_ref()
                .ok_or(MissingPayload())?
                .topic
                .clone();
            let split_topic = topic.split('.').collect::<Vec<_>>();
            if split_topic.len() > 10 {
                return Err(TopicTooLong(split_topic.len()))?;
            }
            if split_topic.iter().any(|segment| segment.is_empty()) {
                return Err(TopicInvalidSegments())?;
            }
            mark_format(tx)?;
            put_value(
                tx,
                &payload_key(payload_hash),
                &stored.to_proto().encode_to_vec(),
            )?;
            for burn_tx in new_burns {
                let tx_id = lotus_txid(burn_tx.tx().unhashed_tx()).to_vec_be();
                // A burn already recorded is not indexed again.
                if tx.get(&burn_key(&tx_id))?.is_some() {
                    continue;
                }
                tx.set(&burn_key(&tx_id), &[])?;
                for idx in 0..split_topic.len() + 1 {
                    let base_topic_parts = split_topic[..idx].join(".");
                    let topic_digest =
                        Sha256::digest(base_topic_parts.as_bytes().into()).to_vec_be();
                    let topical_key = [
                        MESSAGES_PREFIX,
                        &topic_digest,
                        timestamp.to_be_bytes().as_ref(),
                        &tx_id,
                    ]
                    .concat();
                    tx.set(&topical_key, &index_value)?;
                }
            }
            Ok(())
        })
    }

    /// Get serialized `messages` from database, [`SCAN_BATCH`] index rows per transaction.
    pub fn get_messages_to(&self, topic: &str, from: i64, to: i64) -> Result<Vec<TopicPayload>> {
        let valid_topic = topic
            .chars()
            .all(|c| c.is_lowercase() || c.is_numeric() || c == '.' || c == '-');
        if !valid_topic {
            return Err(TopicInvalidCharacters())?;
        }

        let topic_digest = Sha256::digest(topic.as_bytes().into()).to_vec_be();
        let mut start = [MESSAGES_PREFIX, &topic_digest, from.to_be_bytes().as_ref()].concat();
        // Rows with timestamps in `[from, to)`.
        let end = [MESSAGES_PREFIX, &topic_digest, to.to_be_bytes().as_ref()].concat();
        let mut messages = Vec::new();
        loop {
            let rows = self
                .db
                .transact(|tx| Ok(tx.get_range(&start, &end, SCAN_BATCH)?))?;
            let full = rows.len() == SCAN_BATCH;
            if let Some((last, _)) = rows.last() {
                start = key_after(last);
            }
            for (_, wrapper) in rows {
                messages.push(decode(&wrapper)?);
            }
            if !full {
                return Ok(messages);
            }
        }
    }

    /// Get a vector of messages starting at some unix timestamp.
    pub fn get_messages(&self, topic: &str, from: i64) -> Result<Vec<TopicPayload>> {
        self.get_messages_to(topic, from, i64::MAX)
    }

    /// Get a specific message by payload hash.
    pub fn get_message(&self, payload_digest: &[u8]) -> Result<TopicPayload> {
        let wrapper_bytes = self
            .db
            .transact(|tx| get_value(tx, &payload_key(payload_digest)))?
            .ok_or_else(|| MissingValue(hex::encode(payload_digest)))?;
        decode(&wrapper_bytes)
    }

    /// Whether a message with this payload hash is stored.
    pub fn does_message_exist(&self, payload_digest: &[u8]) -> Result<bool> {
        Ok(self
            .db
            .transact(|tx| Ok(tx.get(&payload_key(payload_digest))?))?
            .is_some())
    }
}

impl Debug for DbTopics<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DbTopics {{ .. }}")
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_core::{BitcoinCode, Hashed, Script, Sha256, TxOutput, UnhashedTx};
    use bitcoinsuite_error::Result;
    use cashweb_payload::payload::{SignatureScheme, SignedPayload};
    use pretty_assertions::assert_eq;
    use prost::Message;

    use crate::{proto, store::db::Db};
    type TopicPayload = SignedPayload<proto::BroadcastMessage>;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn messages() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--metadata")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;

        // Tx parses, but the output burn_index points to doesn't exist
        let broadcast_message_one = proto::BroadcastMessage {
            timestamp: 1234,
            entries: vec![],
            topic: "foo.bar.bob".to_owned(),
        };
        let payload_hash_one = Sha256::digest(broadcast_message_one.encode_to_vec().into())
            .as_slice()
            .to_vec();
        let tx1 = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: 1_000_000,
                script: Script::default(),
            }],
            lock_time: 0,
        };
        let message_one = TopicPayload::parse_proto(&cashweb_payload::proto::SignedPayload {
            pubkey: vec![2; 33],
            sig: vec![], // invalid sig
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload: broadcast_message_one.encode_to_vec(), // invalid payload
            payload_hash: payload_hash_one.clone(),
            burn_amount: 1_000_000,
            burn_txs: vec![cashweb_payload::proto::BurnTx {
                tx: tx1.ser().to_vec(),
                burn_idx: 0,
            }],
        })?;

        // Tx parses, but the output burn_index points to doesn't exist
        let broadcast_message_two = proto::BroadcastMessage {
            timestamp: 1234,
            entries: vec![],
            topic: "foo.bar".to_owned(),
        };
        let payload_hash_two = Sha256::digest(broadcast_message_two.encode_to_vec().into())
            .as_slice()
            .to_vec();
        let tx2 = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: 1_200_000,
                script: Script::default(),
            }],
            lock_time: 0,
        };
        let message_two = TopicPayload::parse_proto(&cashweb_payload::proto::SignedPayload {
            pubkey: vec![2; 33],
            sig: vec![], // invalid sig
            sig_scheme: SignatureScheme::Ecdsa.into(),
            payload: broadcast_message_two.encode_to_vec(), // invalid payload
            payload_hash: payload_hash_two.clone(),
            burn_amount: 1_200_000,
            burn_txs: vec![cashweb_payload::proto::BurnTx {
                tx: tx2.ser().to_vec(),
                burn_idx: 0,
            }],
        })?;

        let database = db.topics();

        let data_wrapper_out_0 = database.get_messages("foo.bar.bob", 0)?;
        assert_eq!(data_wrapper_out_0.len(), 0);

        // Put to database
        database.put_message(1, &message_one)?;

        // Get from database
        let data_wrapper_out = database.get_messages("foo.bar.bob", 0)?;
        assert_eq!(data_wrapper_out.len(), 1);
        let full_wrapper_out =
            database.get_message(data_wrapper_out[0].payload_hash().as_slice())?;

        assert_eq!(message_one, full_wrapper_out);

        // Get from database
        let data_wrapper_out = database.get_messages("foo", 0)?;
        assert_eq!(data_wrapper_out.len(), 1);
        // Ensure we're storing the payload correctly.
        assert_eq!(
            message_one.payload_hash(),
            data_wrapper_out[0].payload_hash()
        );

        // Put to database
        database.put_message(2, &message_two)?;

        // Get from database and ensure original topic wasn't changed
        let data_wrapper_out_two = database.get_messages("foo.bar.bob", 0)?;
        assert_eq!(data_wrapper_out_two.len(), 1);
        assert_eq!(
            message_one.payload_hash(),
            data_wrapper_out_two[0].payload_hash()
        );

        // Get from database
        let data_wrapper_three = database.get_messages("foo", 0)?;
        assert_eq!(data_wrapper_three.len(), 2);
        assert_eq!(
            message_one.payload_hash(),
            data_wrapper_three[0].payload_hash()
        );
        assert_eq!(
            message_two.payload_hash(),
            data_wrapper_three[1].payload_hash()
        );

        let data_wrapper_four = database.get_messages("", 0)?;
        assert_eq!(data_wrapper_four.len(), 2);
        assert_eq!(
            message_one.payload_hash(),
            data_wrapper_four[0].payload_hash()
        );
        assert_eq!(
            message_two.payload_hash(),
            data_wrapper_four[1].payload_hash()
        );

        let tx3 = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: 1_000_000,
                script: Script::default(),
            }],
            lock_time: 1, // Ensure hash is different
        };
        // Try merging a message
        let message_one_upvote =
            TopicPayload::parse_proto(&cashweb_payload::proto::SignedPayload {
                pubkey: vec![2; 33],
                sig: vec![], // invalid sig
                sig_scheme: SignatureScheme::Ecdsa.into(),
                payload: vec![], // invalid payload
                payload_hash: payload_hash_one.clone(),
                burn_amount: 1_000_000,
                burn_txs: vec![cashweb_payload::proto::BurnTx {
                    tx: tx3.ser().to_vec(),
                    burn_idx: 0,
                }],
            })?;

        database.put_message(4, &message_one_upvote)?;

        let upvoted_wrapper = database.get_messages("foo.bar.bob", 0)?;
        assert_eq!(upvoted_wrapper.len(), 2);
        assert_eq!(
            message_one.payload_hash(),
            upvoted_wrapper[1].payload_hash()
        );
        assert_eq!(
            message_one.payload_hash(),
            upvoted_wrapper[0].payload_hash()
        );
        let merged_message = database.get_message(upvoted_wrapper[1].payload_hash().as_slice())?;
        assert_eq!(merged_message.txs().len(), 2);

        // Destroy database
        Ok(())
    }
}
