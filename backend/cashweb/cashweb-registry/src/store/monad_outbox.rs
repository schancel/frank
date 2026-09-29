//! Durable exact-byte outbox for Monad direct-message payments.
//!
//! The outbox owns one canonical protobuf encoding of the request. Member rows deliberately do
//! not copy `raw_tx`; they reference a canonical child by `(payload_hash, child_index)` and pin
//! its deterministic transaction hash. This is the recovery boundary used after a crash.

use std::{fmt::Debug, time::Duration};

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rocksdb::{ColumnFamilyDescriptor, IteratorMode};
use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::{
    monad_http::{Address, Hash32},
    proto,
    store::db::{
        Db, CF, CF_MONAD_OUTBOX_ACTIVE_V1, CF_MONAD_OUTBOX_MEMBERS_V1,
        CF_MONAD_OUTBOX_RECIPIENT_V1, CF_MONAD_OUTBOX_V1,
    },
};

const RECORD_VERSION: u8 = 1;
const PAYLOAD_HASH_LEN: usize = 32;
const MEMBER_KEY_LEN: usize = PAYLOAD_HASH_LEN + 4;
const RECIPIENT_KEY_LEN: usize = 20 + PAYLOAD_HASH_LEN;

/// Resource bounds applied before an outbox batch can amplify an untrusted request on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxLimits {
    /// Maximum canonical protobuf bytes stored in a claim.
    pub max_canonical_bytes: usize,
    /// Maximum canonical payment children.
    pub max_members: usize,
    /// Maximum nonterminal claims retained at once.
    pub max_active_claims: usize,
    /// Maximum age before another replay attempt is refused and retained as terminal.
    pub max_claim_age: Duration,
    /// Maximum persisted attempts for one member.
    pub max_member_attempts: u32,
    /// Maximum UTF-8 bytes retained from an infrastructure or terminal error.
    pub max_last_error_bytes: usize,
    /// Maximum frozen network-tag bytes.
    pub max_network_tag_bytes: usize,
    /// Maximum frozen recipient public-key bytes.
    pub max_recipient_pubkey_bytes: usize,
}

impl Default for MonadOutboxLimits {
    fn default() -> Self {
        Self {
            max_canonical_bytes: 2 * 1024 * 1024,
            max_members: 64,
            max_active_claims: 1024,
            max_claim_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_member_attempts: 32,
            max_last_error_bytes: 512,
            max_network_tag_bytes: 64,
            max_recipient_pubkey_bytes: 65,
        }
    }
}

/// Validation and routing facts frozen with a new canonical outbox claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxPolicy {
    /// Validated mailbox owner.
    pub recipient: Address,
    /// Recipient key used to derive every child destination.
    pub recipient_pubkey: Vec<u8>,
    /// Aggregate minimum accepted at admission time.
    pub min_value_wei: u128,
    /// Validated relay network tag.
    pub network_tag: Vec<u8>,
}

/// Aggregate durable lifecycle of one canonical request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonadOutboxLifecycle {
    /// At least one child still needs unambiguous reconciliation.
    Pending,
    /// Every child is confirmed; inbox finalization is the only remaining step.
    FullyConfirmed,
    /// Inbox storage completed atomically with this transition.
    Delivered,
    /// Delivery cannot complete, while confirmed-prefix recovery remains retained.
    Terminal(MonadOutboxTerminal),
}

/// Terminal outcomes which must never be counted as confirmed or replayed forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonadOutboxTerminal {
    /// The funding nonce was consumed by a different transaction.
    StaleNonce,
    /// A confirmed exact transaction permanently failed stamp verification.
    VerificationFailed,
    /// The RPC definitively rejected the exact transaction.
    BroadcastRejected,
    /// The canonical outbox/member reference failed its hash or index integrity check.
    CorruptReference,
    /// The frozen aggregate minimum was not met by all confirmed members.
    InsufficientTotal,
    /// The bounded claim lifetime elapsed.
    Expired,
    /// The bounded per-member attempt budget was consumed.
    AttemptsExhausted,
}

/// Canonical record stored once per payload hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxRecord {
    /// Exact canonical protobuf bytes supplied at admission.
    pub canonical_message: Vec<u8>,
    /// Frozen policy and routing facts.
    pub policy: MonadOutboxPolicy,
    /// Creation time in Unix milliseconds.
    pub created_at_ms: i64,
    /// Last durable transition time in Unix milliseconds.
    pub updated_at_ms: i64,
    /// Aggregate lifecycle.
    pub lifecycle: MonadOutboxLifecycle,
    /// Number of persisted member-attempt starts.
    pub reconciliation_attempts: u32,
    /// Bounded diagnostic text, never required for correctness.
    pub last_error: String,
}

/// Per-child durable state. Raw signed transaction bytes never appear here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadOutboxMemberState {
    /// Exact hash is neither confirmed nor permanently rejected.
    Pending,
    /// Exact hash confirmed and verified; only recovery-relevant receipt facts are retained.
    Confirmed {
        /// Confirmed transfer value.
        value_wei: u128,
        /// Block containing the exact transaction receipt.
        block_number: u64,
    },
    /// This child permanently prevents full delivery.
    Terminal(MonadOutboxTerminal),
}

/// Child reference keyed by payload hash and canonical index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxMember {
    /// Canonical payment-list index encoded in the row key.
    pub child_index: u32,
    /// Keccak256 of the canonical child's raw signed transaction.
    pub tx_hash: Hash32,
    /// Bounded lifecycle state.
    pub state: MonadOutboxMemberState,
    /// Persisted attempt count.
    pub attempts: u32,
    /// Last transition time in Unix milliseconds.
    pub updated_at_ms: i64,
    /// Bounded diagnostic text.
    pub last_error: String,
}

/// Result of atomically claiming a canonical request and all child references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadOutboxClaim {
    /// The outbox and every member reference were created in one batch.
    New,
    /// Byte-for-byte canonical retry of an existing claim.
    ExistingExact(MonadOutboxRecord),
    /// This payload hash is already bound to different canonical bytes.
    Conflict,
    /// The configured active-claim bound was reached before writing anything.
    AtCapacity,
}

/// Recipient-private view of an incomplete claim's contiguous confirmed prefix.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmedPrefixRecovery {
    /// Payload hash identifying the request.
    pub payload_hash: [u8; 32],
    /// Exact canonical request reconstructed from the one outbox copy.
    pub message: proto::MonadStampedMessage,
    /// Confirmed members from child zero up to the first non-confirmed child.
    pub confirmed_prefix: Vec<MonadOutboxMember>,
    /// Aggregate state, including a terminal losing-transaction outcome when applicable.
    pub lifecycle: MonadOutboxLifecycle,
}

/// Durable outbox failures.
#[derive(Debug, Error, ErrorMeta)]
pub enum DbMonadOutboxError {
    /// Payload hashes are fixed-width keys.
    #[invalid_user_input()]
    #[error("Monad outbox payload hash must be 32 bytes, got {0}")]
    InvalidPayloadHashLength(usize),
    /// Canonical request exceeds its pre-disk bound.
    #[invalid_user_input()]
    #[error("Monad outbox canonical request has {actual} bytes, maximum is {maximum}")]
    CanonicalTooLarge {
        /// Encoded request bytes.
        actual: usize,
        /// Configured byte ceiling.
        maximum: usize,
    },
    /// Payment cardinality is invalid.
    #[invalid_user_input()]
    #[error("Monad outbox has {actual} members, allowed range is 1..={maximum}")]
    InvalidMemberCount {
        /// Supplied child count.
        actual: usize,
        /// Configured child ceiling.
        maximum: usize,
    },
    /// A child index does not match canonical wire order.
    #[invalid_user_input()]
    #[error("Monad outbox child at position {position} has index {actual}")]
    NonCanonicalChildIndex {
        /// Canonical list position.
        position: usize,
        /// Supplied child index.
        actual: u32,
    },
    /// Embedded payload hash does not match the row key or encrypted body.
    #[invalid_user_input()]
    #[error("Monad outbox request payload hash is inconsistent")]
    PayloadHashMismatch,
    /// Frozen policy field exceeds its bound.
    #[invalid_user_input()]
    #[error("Monad outbox {field} has {actual} bytes, maximum is {maximum}")]
    PolicyFieldTooLarge {
        /// Frozen field name.
        field: &'static str,
        /// Supplied byte length.
        actual: usize,
        /// Configured byte ceiling.
        maximum: usize,
    },
    /// A requested child is outside the canonical request.
    #[invalid_user_input()]
    #[error("Monad outbox child {0} does not exist")]
    MemberNotFound(u32),
    /// Database-owned encoding is malformed or internally inconsistent.
    #[critical()]
    #[error("Inconsistent Monad outbox database record: {0}")]
    CorruptRecord(String),
}

use self::DbMonadOutboxError::*;

/// Access to canonical outbox, child state, active claims, and recipient recovery index.
pub struct DbMonadOutbox<'a> {
    db: &'a Db,
    cf_outbox: &'a CF,
    cf_members: &'a CF,
    cf_active: &'a CF,
    cf_recipient: &'a CF,
}

impl<'a> DbMonadOutbox<'a> {
    /// Construct the focused outbox facade.
    pub fn new(db: &'a Db) -> Self {
        Self {
            db,
            cf_outbox: db.cf(CF_MONAD_OUTBOX_V1).unwrap(),
            cf_members: db.cf(CF_MONAD_OUTBOX_MEMBERS_V1).unwrap(),
            cf_active: db.cf(CF_MONAD_OUTBOX_ACTIVE_V1).unwrap(),
            cf_recipient: db.cf(CF_MONAD_OUTBOX_RECIPIENT_V1).unwrap(),
        }
    }

    /// Register additive versioned column families. Existing databases reopen with them created.
    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        for name in [
            CF_MONAD_OUTBOX_V1,
            CF_MONAD_OUTBOX_MEMBERS_V1,
            CF_MONAD_OUTBOX_ACTIVE_V1,
            CF_MONAD_OUTBOX_RECIPIENT_V1,
        ] {
            columns.push(ColumnFamilyDescriptor::new(
                name,
                rocksdb::Options::default(),
            ));
        }
    }

    /// Create the canonical row and all child references atomically, or classify an exact retry.
    pub fn claim(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
        policy: &MonadOutboxPolicy,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxClaim> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let canonical_message = message.encode_to_vec();
        validate_claim(&payload_hash, message, &canonical_message, policy, limits)?;

        let _guard = self.db.lock_monad_outbox();
        if let Some(existing) = self.get(&payload_hash)? {
            return Ok(if existing.canonical_message == canonical_message {
                MonadOutboxClaim::ExistingExact(existing)
            } else {
                MonadOutboxClaim::Conflict
            });
        }
        if self.active_count_up_to(limits.max_active_claims)? >= limits.max_active_claims {
            return Ok(MonadOutboxClaim::AtCapacity);
        }

        let record = MonadOutboxRecord {
            canonical_message,
            policy: policy.clone(),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            lifecycle: MonadOutboxLifecycle::Pending,
            reconciliation_attempts: 0,
            last_error: String::new(),
        };
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(self.cf_active, payload_hash, now_ms.to_be_bytes());
        for payment in &message.stamp_payments {
            let tx_hash = Hash32(Keccak256::digest(&payment.raw_tx).into());
            let member = MonadOutboxMember {
                child_index: payment.child_index,
                tx_hash,
                state: MonadOutboxMemberState::Pending,
                attempts: 0,
                updated_at_ms: now_ms,
                last_error: String::new(),
            };
            batch.put_cf(
                self.cf_members,
                member_key(&payload_hash, payment.child_index),
                encode_member(&member),
            );
        }
        self.db.write_batch(batch)?;
        Ok(MonadOutboxClaim::New)
    }

    /// Read a canonical record by payload hash.
    pub fn get(&self, payload_hash: &[u8]) -> Result<Option<MonadOutboxRecord>> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        self.db
            .get(self.cf_outbox, payload_hash)?
            .map(|bytes| decode_record(&bytes))
            .transpose()
    }

    /// Decode the canonical request owned by an outbox record.
    pub fn canonical_message(record: &MonadOutboxRecord) -> Result<proto::MonadStampedMessage> {
        proto::MonadStampedMessage::decode(record.canonical_message.as_slice())
            .wrap_err_with(|| CorruptRecord("canonical message protobuf cannot decode".to_string()))
    }

    /// Read and integrity-check one child reference against the canonical request.
    pub fn get_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
    ) -> Result<Option<MonadOutboxMember>> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        self.db
            .get(self.cf_members, member_key(&payload_hash, child_index))?
            .map(|bytes| decode_member(child_index, &bytes))
            .transpose()
    }

    /// Return canonical raw bytes only after the member's index/hash reference verifies.
    pub fn referenced_raw_tx(
        &self,
        payload_hash: &[u8],
        child_index: u32,
    ) -> Result<(MonadOutboxRecord, MonadOutboxMember, Vec<u8>)> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("member references missing outbox".to_string()))?;
        let message = Self::canonical_message(&record)?;
        let payment = message
            .stamp_payments
            .get(child_index as usize)
            .ok_or(MemberNotFound(child_index))?;
        let member = self
            .get_member(&payload_hash, child_index)?
            .ok_or_else(|| CorruptRecord(format!("missing child row {child_index}")))?;
        let actual_hash = Hash32(Keccak256::digest(&payment.raw_tx).into());
        if payment.child_index != child_index || member.tx_hash != actual_hash {
            return Err(CorruptRecord(format!(
                "child {child_index} index/hash reference mismatch"
            ))
            .into());
        }
        Ok((record, member, payment.raw_tx.clone()))
    }

    /// Enumerate at most `limit` nonterminal claims. The active index prevents a full DB scan.
    pub fn list_active(&self, limit: usize) -> Result<Vec<[u8; 32]>> {
        let mut active = Vec::new();
        for item in self
            .db
            .rocksdb()
            .iterator_cf(self.cf_active, IteratorMode::Start)
            .take(limit)
        {
            let (key, _) = item?;
            active.push(checked_payload_hash(&key)?);
        }
        Ok(active)
    }

    /// Persist an attempt before external RPC work. Exhausted/expired claims become terminal.
    pub fn begin_attempt(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxMember> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("active claim has no outbox row".to_string()))?;
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending) {
            return Ok(member);
        }
        let age_ms = now_ms.saturating_sub(record.created_at_ms);
        let max_age_ms = i64::try_from(limits.max_claim_age.as_millis()).unwrap_or(i64::MAX);
        if age_ms > max_age_ms {
            return self.write_terminal_locked(
                &payload_hash,
                &mut record,
                &mut member,
                MonadOutboxTerminal::Expired,
                "claim age limit exceeded",
                now_ms,
                limits,
            );
        }
        if member.attempts >= limits.max_member_attempts {
            return self.write_terminal_locked(
                &payload_hash,
                &mut record,
                &mut member,
                MonadOutboxTerminal::AttemptsExhausted,
                "member attempt limit exceeded",
                now_ms,
                limits,
            );
        }
        member.attempts += 1;
        member.updated_at_ms = now_ms;
        member.last_error.clear();
        record.reconciliation_attempts = record.reconciliation_attempts.saturating_add(1);
        record.updated_at_ms = now_ms;
        record.last_error.clear();
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        self.db.write_batch(batch)?;
        Ok(member)
    }

    /// Persist a verified receipt before the reconciler advances to the next child.
    pub fn confirm_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        value_wei: u128,
        block_number: u64,
        now_ms: i64,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("confirmed child has no outbox row".to_string()))?;
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        member.state = MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        };
        member.updated_at_ms = now_ms;
        member.last_error.clear();
        record.updated_at_ms = now_ms;
        record.last_error.clear();
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        batch.put_cf(
            self.cf_recipient,
            recipient_key(&record.policy.recipient, &payload_hash),
            [],
        );
        self.db.write_batch(batch)
    }

    /// Retain a bounded transient error without changing the member into a false terminal state.
    pub fn record_pending_error(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("pending child has no outbox row".to_string()))?;
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        let detail = bounded_text(detail, limits.max_last_error_bytes);
        member.last_error = detail.clone();
        member.updated_at_ms = now_ms;
        record.last_error = detail;
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        self.db.write_batch(batch)
    }

    /// Persist an explicit permanent child outcome and remove it from active reconciliation.
    pub fn terminal_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("terminal child has no outbox row".to_string()))?;
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        self.write_terminal_locked(
            &payload_hash,
            &mut record,
            &mut member,
            terminal,
            detail,
            now_ms,
            limits,
        )?;
        Ok(())
    }

    /// Terminalize an aggregate claim whose child reference cannot safely be decoded.
    pub fn terminal_claim(
        &self,
        payload_hash: &[u8],
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("terminal claim has no outbox row".to_string()))?;
        record.lifecycle = MonadOutboxLifecycle::Terminal(terminal);
        record.updated_at_ms = now_ms;
        record.last_error = bounded_text(detail, limits.max_last_error_bytes);
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.delete_cf(self.cf_active, payload_hash);
        self.db.write_batch(batch)
    }

    fn write_terminal_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &mut MonadOutboxRecord,
        member: &mut MonadOutboxMember,
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxMember> {
        let detail = bounded_text(detail, limits.max_last_error_bytes);
        member.state = MonadOutboxMemberState::Terminal(terminal);
        member.updated_at_ms = now_ms;
        member.last_error = detail.clone();
        record.lifecycle = MonadOutboxLifecycle::Terminal(terminal);
        record.updated_at_ms = now_ms;
        record.last_error = detail;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(record));
        batch.put_cf(
            self.cf_members,
            member_key(payload_hash, member.child_index),
            encode_member(member),
        );
        batch.delete_cf(self.cf_active, payload_hash);
        self.db.write_batch(batch)?;
        Ok(member.clone())
    }

    /// Mark all-confirmed after checking every member and the frozen aggregate minimum.
    pub fn mark_fully_confirmed(&self, payload_hash: &[u8], now_ms: i64) -> Result<bool> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("claim has no outbox row".to_string()))?;
        let message = Self::canonical_message(&record)?;
        let mut total = 0u128;
        for payment in &message.stamp_payments {
            let member = self
                .get_member(&payload_hash, payment.child_index)?
                .ok_or_else(|| CorruptRecord("canonical child row missing".to_string()))?;
            match member.state {
                MonadOutboxMemberState::Confirmed { value_wei, .. } => {
                    total = total.checked_add(value_wei).ok_or_else(|| {
                        CorruptRecord("confirmed value sum overflowed".to_string())
                    })?;
                }
                _ => return Ok(false),
            }
        }
        if total < record.policy.min_value_wei {
            record.lifecycle =
                MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::InsufficientTotal);
            record.last_error = "confirmed total below frozen minimum".to_string();
            record.updated_at_ms = now_ms;
            let mut batch = rocksdb::WriteBatch::default();
            batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
            batch.delete_cf(self.cf_active, payload_hash);
            self.db.write_batch(batch)?;
            return Ok(false);
        }
        record.lifecycle = MonadOutboxLifecycle::FullyConfirmed;
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        self.db.write_batch(batch)?;
        Ok(true)
    }

    /// Atomically store the recipient inbox row and mark the outbox delivered.
    pub fn finalize_delivery(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
    ) -> Result<proto::StoredMonadMessage> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("delivery has no outbox row".to_string()))?;
        if record.lifecycle != MonadOutboxLifecycle::FullyConfirmed
            && record.lifecycle != MonadOutboxLifecycle::Delivered
        {
            return Err(
                CorruptRecord("delivery attempted before full confirmation".to_string()).into(),
            );
        }
        let message = Self::canonical_message(&record)?;
        let stored = proto::StoredMonadMessage {
            message: Some(message),
            timestamp: record.created_at_ms,
            network_tag: record.policy.network_tag.clone(),
        };
        if record.lifecycle == MonadOutboxLifecycle::Delivered {
            return Ok(stored);
        }
        record.lifecycle = MonadOutboxLifecycle::Delivered;
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        self.db.monad_messages().append_put_to_batch(
            &mut batch,
            &payload_hash,
            &record.policy.recipient,
            &stored,
        )?;
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.delete_cf(self.cf_active, payload_hash);
        self.db.write_batch(batch)?;
        Ok(stored)
    }

    /// List retained confirmed prefixes for one already-validated recipient.
    pub fn confirmed_prefixes_for_recipient(
        &self,
        recipient: &Address,
        limit: usize,
    ) -> Result<Vec<ConfirmedPrefixRecovery>> {
        let prefix = recipient.0;
        let mut recoveries = Vec::new();
        for item in self
            .db
            .rocksdb()
            .prefix_iterator_cf(self.cf_recipient, prefix)
            .take(limit)
        {
            let (key, _) = item?;
            if key.len() != RECIPIENT_KEY_LEN || !key.starts_with(&prefix) {
                break;
            }
            let payload_hash = checked_payload_hash(&key[20..])?;
            let record = self.get(&payload_hash)?.ok_or_else(|| {
                CorruptRecord("recipient index references missing outbox".to_string())
            })?;
            let message = Self::canonical_message(&record)?;
            let mut confirmed_prefix = Vec::new();
            for payment in &message.stamp_payments {
                let member = self
                    .get_member(&payload_hash, payment.child_index)?
                    .ok_or_else(|| CorruptRecord("recovery member missing".to_string()))?;
                if matches!(member.state, MonadOutboxMemberState::Confirmed { .. }) {
                    confirmed_prefix.push(member);
                } else {
                    break;
                }
            }
            if !confirmed_prefix.is_empty() {
                recoveries.push(ConfirmedPrefixRecovery {
                    payload_hash,
                    message,
                    confirmed_prefix,
                    lifecycle: record.lifecycle,
                });
            }
        }
        Ok(recoveries)
    }

    fn active_count_up_to(&self, limit: usize) -> Result<usize> {
        let mut count = 0;
        for item in self
            .db
            .rocksdb()
            .iterator_cf(self.cf_active, IteratorMode::Start)
            .take(limit.saturating_add(1))
        {
            item?;
            count += 1;
        }
        Ok(count)
    }
}

impl Debug for DbMonadOutbox<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbMonadOutbox").finish_non_exhaustive()
    }
}

fn checked_payload_hash(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| InvalidPayloadHashLength(bytes.len()).into())
}

fn validate_claim(
    payload_hash: &[u8; 32],
    message: &proto::MonadStampedMessage,
    canonical: &[u8],
    policy: &MonadOutboxPolicy,
    limits: &MonadOutboxLimits,
) -> Result<()> {
    if canonical.len() > limits.max_canonical_bytes {
        return Err(CanonicalTooLarge {
            actual: canonical.len(),
            maximum: limits.max_canonical_bytes,
        }
        .into());
    }
    if message.stamp_payments.is_empty() || message.stamp_payments.len() > limits.max_members {
        return Err(InvalidMemberCount {
            actual: message.stamp_payments.len(),
            maximum: limits.max_members,
        }
        .into());
    }
    let actual_hash = Sha256::digest(message.encrypted_payload.clone().into());
    if message.payload_hash.as_slice() != payload_hash || actual_hash.as_slice() != payload_hash {
        return Err(PayloadHashMismatch.into());
    }
    for (position, payment) in message.stamp_payments.iter().enumerate() {
        if payment.child_index as usize != position {
            return Err(NonCanonicalChildIndex {
                position,
                actual: payment.child_index,
            }
            .into());
        }
    }
    for (field, actual, maximum) in [
        (
            "recipient public key",
            policy.recipient_pubkey.len(),
            limits.max_recipient_pubkey_bytes,
        ),
        (
            "network tag",
            policy.network_tag.len(),
            limits.max_network_tag_bytes,
        ),
    ] {
        if actual > maximum {
            return Err(PolicyFieldTooLarge {
                field,
                actual,
                maximum,
            }
            .into());
        }
    }
    Ok(())
}

fn member_key(payload_hash: &[u8; 32], child_index: u32) -> [u8; MEMBER_KEY_LEN] {
    let mut key = [0u8; MEMBER_KEY_LEN];
    key[..32].copy_from_slice(payload_hash);
    key[32..].copy_from_slice(&child_index.to_be_bytes());
    key
}

fn recipient_key(recipient: &Address, payload_hash: &[u8; 32]) -> [u8; RECIPIENT_KEY_LEN] {
    let mut key = [0u8; RECIPIENT_KEY_LEN];
    key[..20].copy_from_slice(&recipient.0);
    key[20..].copy_from_slice(payload_hash);
    key
}

fn bounded_text(detail: &str, max_bytes: usize) -> String {
    if detail.len() <= max_bytes {
        return detail.to_string();
    }
    let mut end = max_bytes;
    while !detail.is_char_boundary(end) {
        end -= 1;
    }
    detail[..end].to_string()
}

fn lifecycle_tag(lifecycle: MonadOutboxLifecycle) -> (u8, u8) {
    match lifecycle {
        MonadOutboxLifecycle::Pending => (0, 0),
        MonadOutboxLifecycle::FullyConfirmed => (1, 0),
        MonadOutboxLifecycle::Delivered => (2, 0),
        MonadOutboxLifecycle::Terminal(reason) => (3, terminal_tag(reason)),
    }
}

fn terminal_tag(reason: MonadOutboxTerminal) -> u8 {
    match reason {
        MonadOutboxTerminal::StaleNonce => 0,
        MonadOutboxTerminal::VerificationFailed => 1,
        MonadOutboxTerminal::BroadcastRejected => 2,
        MonadOutboxTerminal::CorruptReference => 3,
        MonadOutboxTerminal::InsufficientTotal => 4,
        MonadOutboxTerminal::Expired => 5,
        MonadOutboxTerminal::AttemptsExhausted => 6,
    }
}

fn decode_terminal(tag: u8) -> Result<MonadOutboxTerminal> {
    Ok(match tag {
        0 => MonadOutboxTerminal::StaleNonce,
        1 => MonadOutboxTerminal::VerificationFailed,
        2 => MonadOutboxTerminal::BroadcastRejected,
        3 => MonadOutboxTerminal::CorruptReference,
        4 => MonadOutboxTerminal::InsufficientTotal,
        5 => MonadOutboxTerminal::Expired,
        6 => MonadOutboxTerminal::AttemptsExhausted,
        _ => return Err(CorruptRecord(format!("unknown terminal tag {tag}")).into()),
    })
}

fn encode_record(record: &MonadOutboxRecord) -> Vec<u8> {
    let (lifecycle, terminal) = lifecycle_tag(record.lifecycle);
    let mut bytes = Vec::with_capacity(record.canonical_message.len() + 128);
    bytes.extend_from_slice(&[RECORD_VERSION, lifecycle, terminal]);
    bytes.extend_from_slice(&record.created_at_ms.to_be_bytes());
    bytes.extend_from_slice(&record.updated_at_ms.to_be_bytes());
    bytes.extend_from_slice(&record.reconciliation_attempts.to_be_bytes());
    bytes.extend_from_slice(&record.policy.min_value_wei.to_be_bytes());
    bytes.extend_from_slice(&record.policy.recipient.0);
    put_bytes(&mut bytes, &record.policy.recipient_pubkey);
    put_bytes(&mut bytes, &record.policy.network_tag);
    put_bytes(&mut bytes, record.last_error.as_bytes());
    put_bytes(&mut bytes, &record.canonical_message);
    bytes
}

fn decode_record(bytes: &[u8]) -> Result<MonadOutboxRecord> {
    let mut cursor = Cursor::new(bytes);
    if cursor.u8()? != RECORD_VERSION {
        return Err(CorruptRecord("unsupported outbox record version".to_string()).into());
    }
    let lifecycle_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let lifecycle = match lifecycle_tag {
        0 => MonadOutboxLifecycle::Pending,
        1 => MonadOutboxLifecycle::FullyConfirmed,
        2 => MonadOutboxLifecycle::Delivered,
        3 => MonadOutboxLifecycle::Terminal(decode_terminal(terminal_tag)?),
        _ => return Err(CorruptRecord("unknown outbox lifecycle".to_string()).into()),
    };
    let created_at_ms = cursor.i64()?;
    let updated_at_ms = cursor.i64()?;
    let reconciliation_attempts = cursor.u32()?;
    let min_value_wei = cursor.u128()?;
    let recipient = Address(cursor.array()?);
    let recipient_pubkey = cursor.bytes(65)?;
    let network_tag = cursor.bytes(64)?;
    let last_error = cursor.string(4096)?;
    let canonical_message = cursor.bytes(2 * 1024 * 1024)?;
    cursor.finish()?;
    Ok(MonadOutboxRecord {
        canonical_message,
        policy: MonadOutboxPolicy {
            recipient,
            recipient_pubkey,
            min_value_wei,
            network_tag,
        },
        created_at_ms,
        updated_at_ms,
        lifecycle,
        reconciliation_attempts,
        last_error,
    })
}

fn encode_member(member: &MonadOutboxMember) -> Vec<u8> {
    let (state, terminal, value, block) = match member.state {
        MonadOutboxMemberState::Pending => (0, 0, 0, 0),
        MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        } => (1, 0, value_wei, block_number),
        MonadOutboxMemberState::Terminal(reason) => (2, terminal_tag(reason), 0, 0),
    };
    let mut bytes = Vec::with_capacity(80 + member.last_error.len());
    bytes.extend_from_slice(&[RECORD_VERSION, state, terminal]);
    bytes.extend_from_slice(&member.tx_hash.0);
    bytes.extend_from_slice(&member.attempts.to_be_bytes());
    bytes.extend_from_slice(&member.updated_at_ms.to_be_bytes());
    bytes.extend_from_slice(&value.to_be_bytes());
    bytes.extend_from_slice(&block.to_be_bytes());
    put_bytes(&mut bytes, member.last_error.as_bytes());
    bytes
}

fn decode_member(child_index: u32, bytes: &[u8]) -> Result<MonadOutboxMember> {
    let mut cursor = Cursor::new(bytes);
    if cursor.u8()? != RECORD_VERSION {
        return Err(CorruptRecord("unsupported member record version".to_string()).into());
    }
    let state_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let tx_hash = Hash32(cursor.array()?);
    let attempts = cursor.u32()?;
    let updated_at_ms = cursor.i64()?;
    let value_wei = cursor.u128()?;
    let block_number = cursor.u64()?;
    let last_error = cursor.string(4096)?;
    cursor.finish()?;
    let state = match state_tag {
        0 => MonadOutboxMemberState::Pending,
        1 => MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        },
        2 => MonadOutboxMemberState::Terminal(decode_terminal(terminal_tag)?),
        _ => return Err(CorruptRecord("unknown member state".to_string()).into()),
    };
    Ok(MonadOutboxMember {
        child_index,
        tx_hash,
        state,
        attempts,
        updated_at_ms,
        last_error,
    })
}

fn put_bytes(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    target.extend_from_slice(bytes);
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(len)
            .ok_or_else(|| CorruptRecord("record length overflow".to_string()))?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| CorruptRecord("truncated record".to_string()))?;
        self.position = end;
        Ok(value)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("slice length was checked"))
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.array()?))
    }

    fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_be_bytes(self.array()?))
    }

    fn bytes(&mut self, maximum: usize) -> Result<Vec<u8>> {
        let len = self.u32()? as usize;
        if len > maximum {
            return Err(
                CorruptRecord(format!("length {len} exceeds decoding bound {maximum}")).into(),
            );
        }
        Ok(self.take(len)?.to_vec())
    }

    fn string(&mut self, maximum: usize) -> Result<String> {
        String::from_utf8(self.bytes(maximum)?)
            .map_err(|_| CorruptRecord("diagnostic text is not UTF-8".to_string()).into())
    }

    fn finish(self) -> Result<()> {
        if self.position != self.bytes.len() {
            return Err(CorruptRecord("trailing record bytes".to_string()).into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn message(raw_txs: &[&[u8]]) -> proto::MonadStampedMessage {
        let encrypted_payload = b"canonical encrypted payload".to_vec();
        let payload_hash = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        proto::MonadStampedMessage {
            encrypted_payload,
            payload_hash,
            stamp_payments: raw_txs
                .iter()
                .enumerate()
                .map(|(index, raw_tx)| proto::MonadStampPayment {
                    child_index: index as u32,
                    raw_tx: raw_tx.to_vec(),
                })
                .collect(),
        }
    }

    fn policy() -> MonadOutboxPolicy {
        MonadOutboxPolicy {
            recipient: Address([0x44; 20]),
            recipient_pubkey: vec![2; 33],
            min_value_wei: 10,
            network_tag: b"testnet".to_vec(),
        }
    }

    #[test]
    fn exact_bytes_survive_reopen_and_members_do_not_copy_raw_transactions() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-exact")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let request = message(&[b"first raw transaction", b"second raw transaction"]);
        let payload_hash = request.payload_hash.clone();
        let canonical = request.encode_to_vec();
        {
            let db = Db::open(&db_path)?;
            assert_eq!(
                db.monad_outbox().claim(
                    &payload_hash,
                    &request,
                    &policy(),
                    100,
                    &MonadOutboxLimits::default(),
                )?,
                MonadOutboxClaim::New
            );
        }
        let db = Db::open(&db_path)?;
        let store = db.monad_outbox();
        assert_eq!(
            store.get(&payload_hash)?.unwrap().canonical_message,
            canonical
        );
        let (_, member, raw) = store.referenced_raw_tx(&payload_hash, 1)?;
        assert_eq!(raw, b"second raw transaction");
        let encoded_member = encode_member(&member);
        assert!(!encoded_member
            .windows(raw.len())
            .any(|window| window == raw.as_slice()));

        let mut conflict = request.clone();
        conflict.stamp_payments[0].raw_tx.push(0xff);
        assert_eq!(
            store.claim(
                &payload_hash,
                &conflict,
                &policy(),
                101,
                &MonadOutboxLimits::default(),
            )?,
            MonadOutboxClaim::Conflict
        );
        Ok(())
    }

    #[test]
    fn confirmed_prefix_and_terminal_survive_reopen() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-prefix")?;
        let db_path = tempdir.path().join("db.rocksdb");
        let request = message(&[b"raw zero", b"raw one"]);
        let payload_hash = request.payload_hash.clone();
        {
            let db = Db::open(&db_path)?;
            let store = db.monad_outbox();
            store.claim(
                &payload_hash,
                &request,
                &policy(),
                100,
                &MonadOutboxLimits::default(),
            )?;
            store.confirm_member(&payload_hash, 0, 7, 42, 110)?;
            store.terminal_member(
                &payload_hash,
                1,
                MonadOutboxTerminal::StaleNonce,
                "competing transaction consumed nonce",
                120,
                &MonadOutboxLimits::default(),
            )?;
        }
        let db = Db::open(&db_path)?;
        let recoveries = db
            .monad_outbox()
            .confirmed_prefixes_for_recipient(&policy().recipient, 10)?;
        assert_eq!(recoveries.len(), 1);
        assert_eq!(recoveries[0].confirmed_prefix.len(), 1);
        assert_eq!(
            recoveries[0].lifecycle,
            MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::StaleNonce)
        );
        assert!(db.monad_outbox().list_active(10)?.is_empty());
        Ok(())
    }

    #[test]
    fn active_claim_and_error_bounds_fail_closed() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-bounds")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let mut limits = MonadOutboxLimits::default();
        limits.max_active_claims = 1;
        limits.max_last_error_bytes = 5;
        let first = message(&[b"raw zero"]);
        let mut too_small = limits.clone();
        too_small.max_canonical_bytes = 1;
        assert!(db
            .monad_outbox()
            .claim(&first.payload_hash, &first, &policy(), 100, &too_small)
            .is_err());
        assert_eq!(
            db.monad_outbox()
                .claim(&first.payload_hash, &first, &policy(), 100, &limits,)?,
            MonadOutboxClaim::New
        );
        let mut second = message(&[b"raw one"]);
        second.encrypted_payload.push(1);
        second.payload_hash = Sha256::digest(second.encrypted_payload.clone().into())
            .as_slice()
            .to_vec();
        assert_eq!(
            db.monad_outbox()
                .claim(&second.payload_hash, &second, &policy(), 100, &limits,)?,
            MonadOutboxClaim::AtCapacity
        );
        db.monad_outbox().record_pending_error(
            &first.payload_hash,
            0,
            "123456789",
            101,
            &limits,
        )?;
        assert_eq!(
            db.monad_outbox()
                .get_member(&first.payload_hash, 0)?
                .unwrap()
                .last_error,
            "12345"
        );
        limits.max_member_attempts = 1;
        db.monad_outbox()
            .begin_attempt(&first.payload_hash, 0, 102, &limits)?;
        let exhausted = db
            .monad_outbox()
            .begin_attempt(&first.payload_hash, 0, 103, &limits)?;
        assert_eq!(
            exhausted.state,
            MonadOutboxMemberState::Terminal(MonadOutboxTerminal::AttemptsExhausted)
        );

        limits.max_claim_age = Duration::ZERO;
        assert_eq!(
            db.monad_outbox()
                .claim(&second.payload_hash, &second, &policy(), 100, &limits)?,
            MonadOutboxClaim::New
        );
        let expired = db
            .monad_outbox()
            .begin_attempt(&second.payload_hash, 0, 101, &limits)?;
        assert_eq!(
            expired.state,
            MonadOutboxMemberState::Terminal(MonadOutboxTerminal::Expired)
        );
        Ok(())
    }

    #[test]
    fn member_reference_hash_mismatch_is_rejected() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-reference")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let request = message(&[b"canonical raw"]);
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let store = db.monad_outbox();
        store.claim(
            &payload_hash,
            &request,
            &policy(),
            100,
            &MonadOutboxLimits::default(),
        )?;
        let mut member = store.get_member(&payload_hash, 0)?.unwrap();
        member.tx_hash = Hash32([0xff; 32]);
        db.put(
            store.cf_members,
            member_key(&payload_hash, 0),
            encode_member(&member),
        )?;
        assert!(store.referenced_raw_tx(&payload_hash, 0).is_err());
        Ok(())
    }
}
