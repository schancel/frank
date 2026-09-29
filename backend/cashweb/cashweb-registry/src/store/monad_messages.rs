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
//! ## Time indexes
//!
//! `CF_MONAD_MESSAGES_BY_TIME` is a secondary index, keyed by `timestamp.to_be_bytes() ++
//! payload_hash` (value: the `payload_hash`), maintained alongside the primary
//! `CF_MONAD_MESSAGES` on every [`DbMonadMessages::put`]. It exists so [`DbMonadMessages::
//! list_since`] can range-scan messages in timestamp order -- mirroring `DbTopics`'s `CF_MESSAGES`
//! "topic_digest ++ timestamp" key layout (see `crate::store::topics::DbTopics::get_messages_to`),
//! minus the topic prefix this simpler message shape has no equivalent of.
//!
//! `CF_MONAD_MESSAGES_BY_RECIPIENT_TIME` adds the fixed-width recipient routing address before
//! that suffix. The address is derived from the already-validated envelope when the primary
//! record is written; it is intentionally an index fact rather than a new protobuf field.

use std::fmt::Debug;

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use thiserror::Error;

use crate::{
    monad_http::Address,
    proto,
    store::db::{
        Db, CF, CF_MONAD_MESSAGES, CF_MONAD_MESSAGES_BY_RECIPIENT_TIME, CF_MONAD_MESSAGES_BY_TIME,
        CF_MONAD_MESSAGE_ATTEMPTS,
    },
};

/// Build the `CF_MONAD_MESSAGES_BY_TIME` key for a given `(timestamp, payload_hash)` pair. Kept
/// as a free function so [`DbMonadMessages::put`] and [`DbMonadMessages::list_since`] can't
/// disagree on the encoding.
fn by_time_key(timestamp: i64, payload_hash: &[u8]) -> Vec<u8> {
    [timestamp.to_be_bytes().as_ref(), payload_hash].concat()
}

/// Build the recipient-owned journal key. The fixed-width address prefix makes it safe to stop a
/// forward range scan as soon as the iterator reaches another recipient.
fn by_recipient_time_key(recipient: &Address, timestamp: i64, payload_hash: &[u8]) -> Vec<u8> {
    [
        recipient.0.as_ref(),
        timestamp.to_be_bytes().as_ref(),
        payload_hash,
    ]
    .concat()
}

const MAILBOX_AUTH_EXACT_PREFIX: &[u8] = b"\xffmailbox-auth-used-v1\0";
const MAILBOX_AUTH_EXPIRY_PREFIX: &[u8] = b"\xffmailbox-auth-expiry-v1\0";
const MAILBOX_AUTH_GC_BATCH: usize = 256;

fn mailbox_auth_exact_key(epoch: &[u8; 32], recipient: &Address, nonce: &[u8; 32]) -> Vec<u8> {
    [
        MAILBOX_AUTH_EXACT_PREFIX,
        epoch.as_slice(),
        recipient.0.as_slice(),
        nonce.as_slice(),
    ]
    .concat()
}

fn mailbox_auth_recipient_prefix(epoch: &[u8; 32], recipient: &Address) -> Vec<u8> {
    [
        MAILBOX_AUTH_EXACT_PREFIX,
        epoch.as_slice(),
        recipient.0.as_slice(),
    ]
    .concat()
}

fn mailbox_auth_expiry_key(
    expires_at_ms: i64,
    epoch: &[u8; 32],
    recipient: &Address,
    nonce: &[u8; 32],
) -> Vec<u8> {
    [
        MAILBOX_AUTH_EXPIRY_PREFIX,
        expires_at_ms.to_be_bytes().as_slice(),
        epoch.as_slice(),
        recipient.0.as_slice(),
        nonce.as_slice(),
    ]
    .concat()
}

/// Strict-forward cursor for the recipient journal's composite `(timestamp, payload_hash)` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecipientMessageCursor {
    /// Stored message timestamp.
    pub timestamp: i64,
    /// Deterministic tie-breaker for equal timestamps.
    pub payload_hash: [u8; 32],
}

/// One encoded-size-bounded recipient inbox page.
#[derive(Debug, Clone, PartialEq)]
pub struct RecipientMessagePage {
    /// Complete records; records are never split to satisfy a byte budget.
    pub messages: Vec<proto::StoredMonadMessage>,
    /// Last returned composite key when another record remains.
    pub next_cursor: Option<RecipientMessageCursor>,
    /// Exact protobuf response-body size for `StoredMonadMessages { messages }`.
    pub encoded_bytes: usize,
}

/// Allows access to stored Monad-stamped messages.
pub(crate) struct DbMonadMessages<'a> {
    db: &'a Db,
    cf_monad_messages: &'a CF,
    cf_monad_messages_by_time: &'a CF,
    cf_monad_messages_by_recipient_time: &'a CF,
    cf_monad_message_attempts: &'a CF,
}

/// Relay policy frozen when the first member of an exact payment set may be broadcast. Exact
/// retries use this snapshot even if the recipient later rotates their profile key or the relay
/// raises its configured minimum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadMessageAttemptPolicy {
    /// Recipient public key used to derive every child destination in this payment set.
    pub recipient_pubkey: Vec<u8>,
    /// Aggregate minimum accepted when this set was first validated.
    pub min_value_wei: u128,
    /// Network under which this set was admitted. `None` is reserved for format-v1 attempt
    /// records written before network attribution was frozen in the claim.
    pub network_tag: Option<Vec<u8>>,
}

/// Result of looking up or claiming a payload hash for one exact canonical payment set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadMessageAttemptClaim {
    /// No attempt exists for this payload hash.
    Missing,
    /// No attempt existed; this exact set was persisted.
    New,
    /// The same exact protobuf message was already persisted and may resume under its frozen
    /// policy snapshot.
    ExistingExact(MonadMessageAttemptPolicy),
    /// A different payment set already owns this payload hash.
    Conflict,
}

/// Errors indicating some Monad-message store error.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq)]
pub enum DbMonadMessagesError {
    /// Durable mailbox replay authority has an invalid fixed-width key or value.
    #[critical()]
    #[error("Inconsistent db: malformed mailbox authentication replay record")]
    CorruptMailboxAuthRecord,
    /// Database contains an invalid protobuf `StoredMonadMessage`.
    #[critical()]
    #[error("Inconsistent db: Cannot decode StoredMonadMessage: {0}")]
    CannotDecodeStoredMessage(String),

    /// No message stored for the given `payload_hash`.
    #[invalid_user_input()]
    #[error("No Monad message found for payload hash {0}")]
    NotFound(String),

    /// A private cursor no longer names an exact recipient index row.
    #[invalid_user_input()]
    #[error("Private Monad inbox cursor is stale or belongs to another recipient")]
    StalePrivateCursor,

    /// One complete record cannot fit within the caller's bounded response budget.
    #[invalid_user_input()]
    #[error("Private Monad inbox record requires {required} bytes, page budget is {maximum}")]
    RecordExceedsPageBudget {
        /// Exact encoded response bytes required for this one record.
        required: usize,
        /// Requested bounded response bytes.
        maximum: usize,
    },
}

use self::DbMonadMessagesError::*;

impl<'a> DbMonadMessages<'a> {
    /// Create a new [`DbMonadMessages`] instance.
    pub(crate) fn new(db: &'a Db) -> Self {
        let cf_monad_messages = db.cf(CF_MONAD_MESSAGES).unwrap();
        let cf_monad_messages_by_time = db.cf(CF_MONAD_MESSAGES_BY_TIME).unwrap();
        let cf_monad_messages_by_recipient_time =
            db.cf(CF_MONAD_MESSAGES_BY_RECIPIENT_TIME).unwrap();
        let cf_monad_message_attempts = db.cf(CF_MONAD_MESSAGE_ATTEMPTS).unwrap();
        DbMonadMessages {
            db,
            cf_monad_messages,
            cf_monad_messages_by_time,
            cf_monad_messages_by_recipient_time,
            cf_monad_message_attempts,
        }
    }

    fn encoded_attempt(
        message: &proto::MonadStampedMessage,
        policy: &MonadMessageAttemptPolicy,
    ) -> Vec<u8> {
        let digest = Sha256::digest(message.encode_to_vec().into());
        let mut encoded = Vec::with_capacity(
            51 + policy.recipient_pubkey.len() + policy.network_tag.as_ref().map_or(0, Vec::len),
        );
        // `None` is used only by compatibility tests/decoding and preserves the exact v1 record
        // shape. Every new production admission supplies a tag and writes v2.
        encoded.push(if policy.network_tag.is_some() { 2 } else { 1 });
        encoded.extend_from_slice(digest.as_slice());
        encoded.extend_from_slice(&policy.min_value_wei.to_be_bytes());
        encoded.push(policy.recipient_pubkey.len() as u8);
        encoded.extend_from_slice(&policy.recipient_pubkey);
        if let Some(network_tag) = &policy.network_tag {
            encoded.push(network_tag.len() as u8);
            encoded.extend_from_slice(network_tag);
        }
        encoded
    }

    /// Inspect a durable exact-set claim without creating one.
    pub(crate) fn get_attempt(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<MonadMessageAttemptClaim> {
        let digest = Sha256::digest(message.encode_to_vec().into());
        match self.db.get(self.cf_monad_message_attempts, payload_hash)? {
            None => Ok(MonadMessageAttemptClaim::Missing),
            Some(existing)
                if existing.len() >= 50
                    && matches!(existing[0], 1 | 2)
                    && &existing[1..33] == digest.as_slice() =>
            {
                let min_value_wei = u128::from_be_bytes(
                    existing[33..49]
                        .try_into()
                        .expect("attempt minimum has a fixed width"),
                );
                let pubkey_len = existing[49] as usize;
                let pubkey_end = 50 + pubkey_len;
                if existing.len() < pubkey_end {
                    return Ok(MonadMessageAttemptClaim::Conflict);
                }
                let network_tag = match existing[0] {
                    1 if existing.len() == pubkey_end => None,
                    2 if existing.len() > pubkey_end => {
                        let tag_len = existing[pubkey_end] as usize;
                        if existing.len() != pubkey_end + 1 + tag_len {
                            return Ok(MonadMessageAttemptClaim::Conflict);
                        }
                        Some(existing[pubkey_end + 1..].to_vec())
                    }
                    _ => return Ok(MonadMessageAttemptClaim::Conflict),
                };
                Ok(MonadMessageAttemptClaim::ExistingExact(
                    MonadMessageAttemptPolicy {
                        recipient_pubkey: existing[50..pubkey_end].to_vec(),
                        min_value_wei,
                        network_tag,
                    },
                ))
            }
            Some(_) => Ok(MonadMessageAttemptClaim::Conflict),
        }
    }

    /// Persist the exact raw payment set and its bounded policy snapshot before its first
    /// broadcast. The encrypted payload itself is represented only by the message digest, avoiding
    /// attacker-controlled disk amplification.
    pub(crate) fn claim_attempt(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
        policy: &MonadMessageAttemptPolicy,
    ) -> Result<MonadMessageAttemptClaim> {
        let _guard = self.db.lock_monad_outbox();
        // The canonical outbox/inbox is the sole owner once present. This shares the outbox
        // mutex so a legacy caller cannot create a second digest-only owner during migration.
        if self.db.monad_outbox().get(payload_hash)?.is_some() || self.get(payload_hash)?.is_some()
        {
            return Ok(MonadMessageAttemptClaim::Conflict);
        }
        match self.get_attempt(payload_hash, message)? {
            MonadMessageAttemptClaim::Missing => {
                if policy.recipient_pubkey.len() > u8::MAX as usize
                    || policy
                        .network_tag
                        .as_ref()
                        .is_some_and(|tag| tag.len() > u8::MAX as usize)
                {
                    return Ok(MonadMessageAttemptClaim::Conflict);
                }
                let encoded = Self::encoded_attempt(message, policy);
                let mut batch = rocksdb::WriteBatch::default();
                batch.put_cf(self.cf_monad_message_attempts, payload_hash, encoded);
                self.db.write_batch(batch)?;
                Ok(MonadMessageAttemptClaim::New)
            }
            existing => Ok(existing),
        }
    }

    /// Release a claim after the first transaction was definitively rejected by the RPC before
    /// any member of the set verified. Timeout/accepted ambiguity deliberately does not call this.
    pub(crate) fn delete_attempt(&self, payload_hash: &[u8]) -> Result<()> {
        let _guard = self.db.lock_monad_outbox();
        let mut batch = rocksdb::WriteBatch::default();
        self.append_delete_attempt_to_batch(&mut batch, payload_hash);
        self.db.write_batch(batch)
    }

    pub(crate) fn append_delete_attempt_to_batch(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8],
    ) {
        batch.delete_cf(self.cf_monad_message_attempts, payload_hash);
    }

    /// Atomically consume one recipient-authenticated mailbox challenge.
    ///
    /// Exact unexpired records are durable replay authority and are never evicted. The cap is
    /// scoped only to this recipient and runtime epoch, so unrelated authenticated principals
    /// cannot make the recipient fail closed. Expiry-index cleanup is bounded per call; exact
    /// records remain authoritative even when their cleanup entry has not yet been visited.
    pub(crate) fn consume_mailbox_challenge(
        &self,
        epoch: [u8; 32],
        recipient: Address,
        nonce: [u8; 32],
        expires_at_ms: i64,
        now_ms: i64,
        per_recipient_cap: usize,
    ) -> Result<bool> {
        if expires_at_ms < now_ms || per_recipient_cap == 0 {
            return Ok(false);
        }
        let _guard = self.db.lock_monad_outbox();
        let exact_key = mailbox_auth_exact_key(&epoch, &recipient, &nonce);
        let mut batch = rocksdb::WriteBatch::default();

        if let Some(existing) = self.db.get(self.cf_monad_message_attempts, &exact_key)? {
            let existing_expiry = existing
                .as_ref()
                .try_into()
                .map(i64::from_be_bytes)
                .map_err(|_| DbMonadMessagesError::CorruptMailboxAuthRecord)?;
            if existing_expiry >= now_ms {
                return Ok(false);
            }
            batch.delete_cf(self.cf_monad_message_attempts, &exact_key);
            batch.delete_cf(
                self.cf_monad_message_attempts,
                mailbox_auth_expiry_key(existing_expiry, &epoch, &recipient, &nonce),
            );
        }

        let expiry_prefix = MAILBOX_AUTH_EXPIRY_PREFIX;
        let mut cleaned = 0usize;
        for item in self.db.rocksdb().iterator_cf(
            self.cf_monad_message_attempts,
            IteratorMode::From(expiry_prefix, Direction::Forward),
        ) {
            let (key, _) = item?;
            if !key.starts_with(expiry_prefix) || cleaned == MAILBOX_AUTH_GC_BATCH {
                break;
            }
            let expiry_start = expiry_prefix.len();
            let expiry_end = expiry_start + 8;
            let expiry = key
                .get(expiry_start..expiry_end)
                .and_then(|bytes| bytes.try_into().ok())
                .map(i64::from_be_bytes)
                .ok_or(DbMonadMessagesError::CorruptMailboxAuthRecord)?;
            if expiry >= now_ms {
                break;
            }
            let suffix = key
                .get(expiry_end..)
                .ok_or(DbMonadMessagesError::CorruptMailboxAuthRecord)?;
            if suffix.len() != 32 + 20 + 32 {
                return Err(DbMonadMessagesError::CorruptMailboxAuthRecord.into());
            }
            let stale_exact = [MAILBOX_AUTH_EXACT_PREFIX, suffix].concat();
            batch.delete_cf(self.cf_monad_message_attempts, stale_exact);
            batch.delete_cf(self.cf_monad_message_attempts, key);
            cleaned += 1;
        }

        let recipient_prefix = mailbox_auth_recipient_prefix(&epoch, &recipient);
        let mut active = 0usize;
        for item in self.db.rocksdb().iterator_cf(
            self.cf_monad_message_attempts,
            IteratorMode::From(&recipient_prefix, Direction::Forward),
        ) {
            let (key, value) = item?;
            if !key.starts_with(&recipient_prefix) {
                break;
            }
            let stored_expiry = value
                .as_ref()
                .try_into()
                .map(i64::from_be_bytes)
                .map_err(|_| DbMonadMessagesError::CorruptMailboxAuthRecord)?;
            if stored_expiry < now_ms {
                let stale_nonce: [u8; 32] = key
                    .get(recipient_prefix.len()..)
                    .and_then(|bytes| bytes.try_into().ok())
                    .ok_or(DbMonadMessagesError::CorruptMailboxAuthRecord)?;
                batch.delete_cf(self.cf_monad_message_attempts, key);
                batch.delete_cf(
                    self.cf_monad_message_attempts,
                    mailbox_auth_expiry_key(stored_expiry, &epoch, &recipient, &stale_nonce),
                );
            } else {
                active += 1;
                if active >= per_recipient_cap {
                    self.db.write_batch(batch)?;
                    return Ok(false);
                }
            }
        }

        batch.put_cf(
            self.cf_monad_message_attempts,
            &exact_key,
            expires_at_ms.to_be_bytes(),
        );
        batch.put_cf(
            self.cf_monad_message_attempts,
            mailbox_auth_expiry_key(expires_at_ms, &epoch, &recipient, &nonce),
            [],
        );
        self.db.write_batch(batch)?;
        Ok(true)
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
    pub(crate) fn put(
        &self,
        payload_hash: &[u8],
        recipient: &Address,
        message: &proto::StoredMonadMessage,
    ) -> Result<()> {
        let mut batch = rocksdb::WriteBatch::default();
        self.append_put_to_batch(&mut batch, payload_hash, recipient, message)?;
        self.db.write_batch(batch)?;
        Ok(())
    }

    /// Append inbox storage to a caller-owned atomic batch. The outbox uses this to make the
    /// all-confirmed -> delivered transition indivisible from recipient-visible storage.
    pub(crate) fn append_put_to_batch(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8],
        recipient: &Address,
        message: &proto::StoredMonadMessage,
    ) -> Result<()> {
        if let Some(existing) = self.get(payload_hash)? {
            batch.delete_cf(
                self.cf_monad_messages_by_time,
                by_time_key(existing.timestamp, payload_hash),
            );
            // `payload_hash` commits the routing envelope, so an exact retry cannot change the
            // recipient. The caller supplies the same validated recipient while the stored
            // protobuf deliberately remains unchanged.
            batch.delete_cf(
                self.cf_monad_messages_by_recipient_time,
                by_recipient_time_key(recipient, existing.timestamp, payload_hash),
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
        batch.put_cf(
            self.cf_monad_messages_by_recipient_time,
            by_recipient_time_key(recipient, message.timestamp, payload_hash),
            payload_hash,
        );
        batch.delete_cf(self.cf_monad_message_attempts, payload_hash);
        Ok(())
    }

    /// Retrieve a [`proto::StoredMonadMessage`] by its `payload_hash`. [`None`] if not found.
    pub(crate) fn get(&self, payload_hash: &[u8]) -> Result<Option<proto::StoredMonadMessage>> {
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
    pub(crate) fn get_existing(&self, payload_hash: &[u8]) -> Result<proto::StoredMonadMessage> {
        self.get(payload_hash)?
            .ok_or_else(|| NotFound(hex::encode(payload_hash)).into())
    }

    /// List every [`proto::StoredMonadMessage`] stored with `timestamp >= since` (milliseconds
    /// since the Unix epoch), ordered by `timestamp` ascending (ticket #37). Lets a client
    /// discover newly-stored messages by polling with an advancing cursor, without already
    /// knowing their `payload_hash` out of band -- see this module's docs for why this can't
    /// additionally filter by intended recipient.
    #[cfg(test)]
    pub(crate) fn list_since(&self, since: i64) -> Result<Vec<proto::StoredMonadMessage>> {
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

    /// List one recipient's messages with `timestamp >= since`, ordered by timestamp ascending.
    /// This is the storage boundary for the future authenticated mailbox sync route; the legacy
    /// global list remains available until that route and its client migration land together.
    pub(crate) fn list_for_recipient_since(
        &self,
        recipient: &Address,
        since: i64,
    ) -> Result<Vec<proto::StoredMonadMessage>> {
        let start_key = by_recipient_time_key(recipient, since, &[]);
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_messages_by_recipient_time,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        let mut messages = Vec::new();
        for item in iter {
            let (key, payload_hash) = item?;
            if !key.starts_with(&recipient.0) {
                break;
            }
            messages.push(self.get_existing(&payload_hash)?);
        }
        Ok(messages)
    }

    /// List a strict-forward page from one recipient journal.
    ///
    /// Keys are ordered by `(timestamp, payload_hash)`. A supplied authenticated cursor need not
    /// still exist, but must not precede `since`. At most `limit + 1` index rows and
    /// `limit` primary records are examined. The byte budget is the exact protobuf response size;
    /// a record is either returned whole or rejected as too large.
    pub(crate) fn list_for_recipient_since_capped(
        &self,
        recipient: &Address,
        since: i64,
        cursor: Option<RecipientMessageCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<RecipientMessagePage> {
        if limit == 0 || max_bytes == 0 {
            return Ok(RecipientMessagePage {
                messages: Vec::new(),
                next_cursor: None,
                encoded_bytes: 0,
            });
        }
        let start_key = match cursor {
            Some(cursor) => {
                if cursor.timestamp < since {
                    return Err(StalePrivateCursor.into());
                }
                by_recipient_time_key(recipient, cursor.timestamp, &cursor.payload_hash)
            }
            None => by_recipient_time_key(recipient, since, &[]),
        };
        let iter = self.db.rocksdb().iterator_cf(
            self.cf_monad_messages_by_recipient_time,
            IteratorMode::From(&start_key, Direction::Forward),
        );
        let mut messages = Vec::with_capacity(limit);
        let mut encoded_bytes = 0usize;
        let mut has_more = false;
        for item in iter {
            let (key, payload_hash) = item?;
            if !key.starts_with(&recipient.0) {
                break;
            }
            if cursor.is_some() && key.as_ref() == start_key.as_slice() {
                continue;
            }
            if messages.len() == limit {
                has_more = true;
                break;
            }
            let message = self.get_existing(&payload_hash)?;
            let record_len = message.encoded_len();
            let added = 1 + prost_varint_len(record_len as u64) + record_len;
            if encoded_bytes.saturating_add(added) > max_bytes {
                if messages.is_empty() {
                    return Err(RecordExceedsPageBudget {
                        required: added,
                        maximum: max_bytes,
                    }
                    .into());
                }
                has_more = true;
                break;
            }
            encoded_bytes += added;
            messages.push(message);
        }
        let next_cursor = if has_more {
            messages.last().and_then(|message| {
                let payload_hash: [u8; 32] = message
                    .message
                    .as_ref()?
                    .payload_hash
                    .as_slice()
                    .try_into()
                    .ok()?;
                Some(RecipientMessageCursor {
                    timestamp: message.timestamp,
                    payload_hash,
                })
            })
        } else {
            None
        };
        Ok(RecipientMessagePage {
            messages,
            next_cursor,
            encoded_bytes,
        })
    }

    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        let options = rocksdb::Options::default();
        columns.push(ColumnFamilyDescriptor::new(CF_MONAD_MESSAGES, options));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_MESSAGES_BY_TIME,
            rocksdb::Options::default(),
        ));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_MESSAGES_BY_RECIPIENT_TIME,
            rocksdb::Options::default(),
        ));
        columns.push(ColumnFamilyDescriptor::new(
            CF_MONAD_MESSAGE_ATTEMPTS,
            rocksdb::Options::default(),
        ));
    }
}

fn prost_varint_len(mut value: u64) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
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

    use crate::{
        monad_http::Address,
        proto,
        store::{
            db::Db,
            monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy},
        },
    };

    #[test]
    fn test_claim_attempt_binds_payload_to_exact_payment_set() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-attempt")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let payload_hash = vec![8u8; 32];
        let message = proto::MonadStampedMessage {
            encrypted_payload: vec![4, 5, 6],
            payload_hash: payload_hash.clone(),
            stamp_payments: vec![proto::MonadStampPayment {
                child_index: 0,
                raw_tx: vec![1, 2, 3],
            }],
        };
        let policy = MonadMessageAttemptPolicy {
            recipient_pubkey: vec![2; 33],
            min_value_wei: 42,
            network_tag: Some(b"MONT".to_vec()),
        };
        {
            let db = Db::open(&db_path)?;
            assert_eq!(
                db.monad_messages()
                    .claim_attempt(&payload_hash, &message, &policy)?,
                MonadMessageAttemptClaim::New
            );
        }

        // Reopening the database proves the claim survives a relay restart.
        let db = Db::open(&db_path)?;
        assert_eq!(
            db.monad_messages().get_attempt(&payload_hash, &message)?,
            MonadMessageAttemptClaim::ExistingExact(policy.clone())
        );
        let mut conflicting = message;
        conflicting.stamp_payments[0].raw_tx.push(4);
        assert_eq!(
            db.monad_messages()
                .get_attempt(&payload_hash, &conflicting)?,
            MonadMessageAttemptClaim::Conflict
        );
        db.monad_messages().delete_attempt(&payload_hash)?;
        assert_eq!(
            db.monad_messages()
                .claim_attempt(&payload_hash, &conflicting, &policy)?,
            MonadMessageAttemptClaim::New
        );

        Ok(())
    }

    #[test]
    fn test_db_monad_messages() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-messages")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let db = Db::open(&db_path)?;

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
        let policy = MonadMessageAttemptPolicy {
            recipient_pubkey: vec![2; 33],
            min_value_wei: 123,
            network_tag: Some(b"MONT".to_vec()),
        };
        let recipient = Address([1; 20]);
        assert_eq!(
            db.monad_messages().claim_attempt(
                &payload_hash,
                stored.message.as_ref().unwrap(),
                &policy,
            )?,
            MonadMessageAttemptClaim::New
        );
        db.monad_messages()
            .put(&payload_hash, &recipient, &stored)?;
        assert_eq!(
            db.monad_messages().get(&payload_hash)?,
            Some(stored.clone())
        );
        assert_eq!(db.monad_messages().get_existing(&payload_hash)?, stored);
        assert_eq!(
            db.monad_messages()
                .get_attempt(&payload_hash, stored.message.as_ref().unwrap())?,
            MonadMessageAttemptClaim::Missing,
            "completed attempts must be deleted in the same batch as the stored message"
        );

        drop(db);
        let reopened = Db::open(&db_path)?;
        assert_eq!(
            reopened.monad_messages().get(&payload_hash)?,
            Some(stored.clone()),
            "local Monad mailbox records must survive a server/database restart"
        );
        assert_eq!(
            reopened
                .monad_messages()
                .list_for_recipient_since(&recipient, 0)?,
            vec![stored],
            "the recipient-owned journal index must survive a server/database restart"
        );

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
        let recipient = Address([1; 20]);

        // Insert out of order to prove `list_since` sorts by timestamp, not insertion order.
        store.put(
            &late.message.as_ref().unwrap().payload_hash,
            &recipient,
            &late,
        )?;
        store.put(
            &early.message.as_ref().unwrap().payload_hash,
            &recipient,
            &early,
        )?;
        store.put(
            &middle.message.as_ref().unwrap().payload_hash,
            &recipient,
            &middle,
        )?;

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
        let recipient = Address([1; 20]);

        store.put(&payload_hash, &recipient, &first)?;
        store.put(&payload_hash, &recipient, &retried)?;

        // Only the latest write should show up -- the stale by-time index entry from the first
        // `put` (timestamp 100) must have been cleaned up, not left as an orphaned duplicate.
        assert_eq!(store.list_since(0)?, vec![retried]);

        Ok(())
    }

    #[test]
    fn test_list_for_recipient_isolates_orders_and_respects_cursor() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir =
            tempdir::TempDir::new("cashweb-registry-store--monad-messages-list-for-recipient")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();
        let alice = Address([0x11; 20]);
        let bob = Address([0x22; 20]);

        let alice_early = make_stored(vec![1u8; 32], 100);
        let bob_middle = make_stored(vec![2u8; 32], 150);
        let alice_late = make_stored(vec![3u8; 32], 200);

        store.put(
            &alice_late.message.as_ref().unwrap().payload_hash,
            &alice,
            &alice_late,
        )?;
        store.put(
            &bob_middle.message.as_ref().unwrap().payload_hash,
            &bob,
            &bob_middle,
        )?;
        store.put(
            &alice_early.message.as_ref().unwrap().payload_hash,
            &alice,
            &alice_early,
        )?;

        assert_eq!(
            store.list_for_recipient_since(&alice, 0)?,
            vec![alice_early.clone(), alice_late.clone()]
        );
        assert_eq!(
            store.list_for_recipient_since(&alice, 200)?,
            vec![alice_late]
        );
        assert_eq!(store.list_for_recipient_since(&bob, 0)?, vec![bob_middle]);

        Ok(())
    }

    #[test]
    fn test_recipient_list_after_retry_has_no_stale_entry() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let tempdir =
            tempdir::TempDir::new("cashweb-registry-store--monad-messages-recipient-retry")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();
        let recipient = Address([0x33; 20]);
        let payload_hash = vec![7u8; 32];
        let first = make_stored(payload_hash.clone(), 100);
        let retried = make_stored(payload_hash.clone(), 200);

        store.put(&payload_hash, &recipient, &first)?;
        store.put(&payload_hash, &recipient, &retried)?;

        assert_eq!(
            store.list_for_recipient_since(&recipient, 0)?,
            vec![retried]
        );

        Ok(())
    }

    #[test]
    fn recipient_pages_use_strict_composite_cursor_without_gaps_or_duplicates() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-page-cursor")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();
        let recipient = Address([0x44; 20]);
        let other = Address([0x55; 20]);
        for (hash_byte, timestamp) in [(3, 100), (1, 100), (2, 200)] {
            let stored = make_stored(vec![hash_byte; 32], timestamp);
            store.put(
                &stored.message.as_ref().unwrap().payload_hash,
                &recipient,
                &stored,
            )?;
        }
        let foreign = make_stored(vec![9; 32], 100);
        store.put(
            &foreign.message.as_ref().unwrap().payload_hash,
            &other,
            &foreign,
        )?;

        let mut cursor = None;
        let mut hashes = Vec::new();
        loop {
            let page =
                store.list_for_recipient_since_capped(&recipient, 0, cursor, 1, usize::MAX)?;
            hashes.extend(
                page.messages
                    .iter()
                    .map(|stored| stored.message.as_ref().unwrap().payload_hash[0]),
            );
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(hashes, vec![1, 3, 2]);

        let deleted_position = super::RecipientMessageCursor {
            timestamp: 100,
            payload_hash: [2; 32],
        };
        let continued = store.list_for_recipient_since_capped(
            &recipient,
            0,
            Some(deleted_position),
            1,
            usize::MAX,
        )?;
        assert_eq!(
            continued.messages[0].message.as_ref().unwrap().payload_hash,
            vec![3; 32],
            "a lexicographic cursor remains usable after its row was deleted"
        );
        Ok(())
    }

    #[test]
    fn recipient_page_byte_budget_never_splits_a_large_record() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--monad-page-budget")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_messages();
        let recipient = Address([0x66; 20]);
        let mut stored = make_stored(vec![7; 32], 100);
        stored.message.as_mut().unwrap().encrypted_payload = vec![0xa5; 2 * 1024 * 1024 - 256];
        store.put(
            &stored.message.as_ref().unwrap().payload_hash,
            &recipient,
            &stored,
        )?;

        let full =
            store.list_for_recipient_since_capped(&recipient, 0, None, 1, 2 * 1024 * 1024)?;
        assert_eq!(full.messages, vec![stored]);
        assert!(full.encoded_bytes <= 2 * 1024 * 1024);
        let err = store
            .list_for_recipient_since_capped(&recipient, 0, None, 1, full.encoded_bytes - 1)
            .unwrap_err();
        assert!(matches!(
            err.downcast_ref::<super::DbMonadMessagesError>(),
            Some(super::DbMonadMessagesError::RecordExceedsPageBudget { .. })
        ));
        Ok(())
    }

    #[test]
    fn durable_mailbox_replay_authority_never_evicts_an_unexpired_victim() -> Result<()> {
        let tempdir = tempdir::TempDir::new("cashweb-registry-store--mailbox-replay")?;
        let path = tempdir.path().join("db.rocksdb");
        let epoch = [0x11; 32];
        let victim = Address([0xff; 20]);
        let nonce = [0x22; 32];
        {
            let db = Db::open(&path)?;
            let store = db.monad_messages();
            assert!(store.consume_mailbox_challenge(epoch, victim, nonce, 10_000, 1, 2)?);
            for index in 0..512u64 {
                let mut address = [0u8; 20];
                address[..8].copy_from_slice(&index.to_be_bytes());
                assert!(store.consume_mailbox_challenge(
                    epoch,
                    Address(address),
                    [index as u8; 32],
                    10_000,
                    2,
                    2,
                )?);
            }
            assert!(!store.consume_mailbox_challenge(epoch, victim, nonce, 10_000, 3, 2)?);
            assert!(store.consume_mailbox_challenge(epoch, victim, [0x23; 32], 10_000, 3, 2)?);
            assert!(!store.consume_mailbox_challenge(epoch, victim, [0x24; 32], 10_000, 3, 2)?);
        }
        {
            let db = Db::open(&path)?;
            let store = db.monad_messages();
            assert!(!store.consume_mailbox_challenge(epoch, victim, nonce, 10_000, 4, 2)?);
            assert!(store.consume_mailbox_challenge(epoch, victim, nonce, 20_000, 10_001, 2)?);
        }
        Ok(())
    }
}
