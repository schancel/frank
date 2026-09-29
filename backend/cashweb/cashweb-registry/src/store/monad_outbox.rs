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
        Db, CF, CF_MONAD_OUTBOX_ACTIVE_V1, CF_MONAD_OUTBOX_HISTORY_V2, CF_MONAD_OUTBOX_MEMBERS_V1,
        CF_MONAD_OUTBOX_META_V2, CF_MONAD_OUTBOX_RECIPIENT_V1, CF_MONAD_OUTBOX_V1,
    },
};

const RECORD_VERSION_V1: u8 = 1;
const RECORD_VERSION: u8 = 2;
const PAYLOAD_HASH_LEN: usize = 32;
const MEMBER_KEY_LEN: usize = PAYLOAD_HASH_LEN + 4;
const RECIPIENT_KEY_LEN: usize = 20 + PAYLOAD_HASH_LEN;
const MAX_HISTORY_RECORDS_HARD: usize = 4096;

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
    /// Lease duration after which a crashed reconciliation attempt may be superseded.
    pub member_lease: Duration,
    /// Maximum compact-delivered and non-recoverable-terminal history rows, capped internally at
    /// 4096 so one GC pass is always bounded.
    pub max_history_records: usize,
    /// Maximum encoded bytes retained by bounded outbox history rows and their member rows.
    pub max_history_bytes: usize,
    /// Maximum age of bounded history. Confirmed-prefix recovery facts are exempt.
    pub max_history_age: Duration,
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
            member_lease: Duration::from_secs(2 * 60),
            max_history_records: 4096,
            max_history_bytes: 16 * 1024 * 1024,
            max_history_age: Duration::from_secs(30 * 24 * 60 * 60),
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
    pub canonical_message: Option<Vec<u8>>,
    /// Frozen policy and routing facts.
    pub policy: Option<MonadOutboxPolicy>,
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
    /// Monotonic durable lease generation. Completion must present this exact token.
    pub lease_generation: u64,
    /// Unix millisecond deadline after which another reconciler may acquire a new generation.
    pub lease_until_ms: i64,
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

/// Opaque durable generation authorizing one replay completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonadOutboxLease {
    generation: u64,
}

/// Result of atomically acquiring the replay right for a still-missing exact transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadOutboxLeaseAcquire {
    /// This caller exclusively owns one persisted attempt generation.
    Acquired {
        /// Token required by every completion path.
        lease: MonadOutboxLease,
        /// Updated member, including attempt count and lease deadline.
        member: MonadOutboxMember,
    },
    /// Another non-expired generation owns the attempt.
    Busy,
    /// The member changed monotonically while the caller was checking the chain.
    NotPending(MonadOutboxMemberState),
    /// Exact absence was established, then a replay budget bound terminalized the member.
    Terminal(MonadOutboxTerminal),
}

/// Result of charging a replay budget to the current scan lease after exact absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadOutboxReplayStart {
    /// The attempt counter was durably incremented under this generation.
    Started(MonadOutboxMember),
    /// A newer generation or monotonic state won.
    Stale,
    /// Exact absence was established and a replay bound became terminal.
    Terminal(MonadOutboxTerminal),
}

/// Whether a conditional monotonic transition was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonadOutboxTransition {
    /// Pending state and, when required, the durable lease generation matched.
    Applied,
    /// A newer generation or terminal/confirmed state won; no bytes were changed.
    Stale,
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
    cf_history: &'a CF,
    cf_meta: &'a CF,
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
            cf_history: db.cf(CF_MONAD_OUTBOX_HISTORY_V2).unwrap(),
            cf_meta: db.cf(CF_MONAD_OUTBOX_META_V2).unwrap(),
        }
    }

    /// Register additive versioned column families. Existing databases reopen with them created.
    pub(crate) fn add_cfs(columns: &mut Vec<ColumnFamilyDescriptor>) {
        for name in [
            CF_MONAD_OUTBOX_V1,
            CF_MONAD_OUTBOX_MEMBERS_V1,
            CF_MONAD_OUTBOX_ACTIVE_V1,
            CF_MONAD_OUTBOX_RECIPIENT_V1,
            CF_MONAD_OUTBOX_HISTORY_V2,
            CF_MONAD_OUTBOX_META_V2,
        ] {
            columns.push(ColumnFamilyDescriptor::new(
                name,
                rocksdb::Options::default(),
            ));
        }
    }

    /// Upgrade frozen-version delivered rows by removing their duplicate canonical outbox copy.
    /// The inbox already owns those bytes atomically in v1; reopening completes the ownership
    /// transfer before the database is returned to callers.
    pub(crate) fn migrate_legacy_delivered_ownership(&self) -> Result<()> {
        const MIGRATION_KEY: &[u8] = b"delivered-owner-v2";
        if self.db.get(self.cf_meta, MIGRATION_KEY)?.is_some() {
            return Ok(());
        }
        let mut payloads = Vec::new();
        for item in self
            .db
            .rocksdb()
            .iterator_cf(self.cf_outbox, IteratorMode::Start)
        {
            let (key, value) = item?;
            let record = decode_record(&value)?;
            if record.lifecycle == MonadOutboxLifecycle::Delivered
                && record.canonical_message.is_some()
            {
                payloads.push(checked_payload_hash(&key)?);
            }
        }
        for (index, payload_hash) in payloads.into_iter().enumerate() {
            let _guard = self.db.lock_monad_outbox();
            let mut record = self
                .get(&payload_hash)?
                .ok_or_else(|| CorruptRecord("legacy delivered row disappeared".to_string()))?;
            if record.lifecycle != MonadOutboxLifecycle::Delivered
                || record.canonical_message.is_none()
            {
                continue;
            }
            self.db
                .monad_messages()
                .get(&payload_hash)?
                .ok_or_else(|| {
                    CorruptRecord("legacy delivered row has no inbox owner".to_string())
                })?;
            let message = Self::canonical_message(&record)?;
            let policy = active_policy(&record)?.clone();
            record.canonical_message = None;
            record.policy = None;
            record.last_error.clear();
            let encoded = encode_record(&record);
            let mut batch = rocksdb::WriteBatch::default();
            batch.put_cf(self.cf_outbox, payload_hash, &encoded);
            batch.delete_cf(self.cf_active, payload_hash);
            batch.delete_cf(
                self.cf_recipient,
                recipient_key(&policy.recipient, &payload_hash),
            );
            for payment in message.stamp_payments {
                batch.delete_cf(
                    self.cf_members,
                    member_key(&payload_hash, payment.child_index),
                );
            }
            batch.put_cf(
                self.cf_history,
                history_key(record.updated_at_ms, &payload_hash),
                (encoded.len() as u64).to_be_bytes(),
            );
            self.db.write_batch(batch)?;
            drop(_guard);
            if (index + 1) % MAX_HISTORY_RECORDS_HARD == 0 {
                self.gc_history(unix_now_ms(), &MonadOutboxLimits::default())?;
            }
        }
        self.gc_history(unix_now_ms(), &MonadOutboxLimits::default())?;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_meta, MIGRATION_KEY, []);
        self.db.write_batch(batch)
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
            let exact = match existing.canonical_message.as_deref() {
                Some(existing_bytes) => existing_bytes == canonical_message,
                None => self
                    .db
                    .monad_messages()
                    .get(&payload_hash)?
                    .and_then(|stored| stored.message)
                    .map(|message| message.encode_to_vec() == canonical_message)
                    .unwrap_or(false),
            };
            return Ok(if exact {
                MonadOutboxClaim::ExistingExact(existing)
            } else {
                MonadOutboxClaim::Conflict
            });
        }
        // A delivered inbox remains the exact-byte owner even after bounded tombstone GC.
        if let Some(stored) = self.db.monad_messages().get(&payload_hash)? {
            let exact = stored
                .message
                .as_ref()
                .map(|stored| stored.encode_to_vec() == canonical_message)
                .unwrap_or(false);
            return Ok(if exact {
                MonadOutboxClaim::ExistingExact(MonadOutboxRecord {
                    canonical_message: None,
                    policy: None,
                    created_at_ms: stored.timestamp,
                    updated_at_ms: stored.timestamp,
                    lifecycle: MonadOutboxLifecycle::Delivered,
                    reconciliation_attempts: 0,
                    last_error: String::new(),
                })
            } else {
                MonadOutboxClaim::Conflict
            });
        }
        if self.active_count_up_to(limits.max_active_claims)? >= limits.max_active_claims {
            return Ok(MonadOutboxClaim::AtCapacity);
        }

        let record = MonadOutboxRecord {
            canonical_message: Some(canonical_message),
            policy: Some(policy.clone()),
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
                lease_generation: 0,
                lease_until_ms: 0,
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
        let canonical = record.canonical_message.as_deref().ok_or_else(|| {
            CorruptRecord("compact outbox tombstone has no canonical message".to_string())
        })?;
        proto::MonadStampedMessage::decode(canonical)
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

    /// Atomically acquire the generation that owns one exact lookup and any resulting replay.
    /// No replay attempt/age budget is charged until [`Self::begin_replay_attempt`].
    pub fn acquire_reconcile_lease(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxLeaseAcquire> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("active claim has no outbox row".to_string()))?;
        match record.lifecycle {
            MonadOutboxLifecycle::Delivered | MonadOutboxLifecycle::FullyConfirmed => {
                return Ok(MonadOutboxLeaseAcquire::NotPending(
                    MonadOutboxMemberState::Confirmed {
                        value_wei: 0,
                        block_number: 0,
                    },
                ))
            }
            MonadOutboxLifecycle::Terminal(terminal) => {
                return Ok(MonadOutboxLeaseAcquire::NotPending(
                    MonadOutboxMemberState::Terminal(terminal),
                ))
            }
            MonadOutboxLifecycle::Pending => {}
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending) {
            return Ok(MonadOutboxLeaseAcquire::NotPending(member.state));
        }
        if member.lease_until_ms > now_ms {
            return Ok(MonadOutboxLeaseAcquire::Busy);
        }
        member.lease_generation = member.lease_generation.saturating_add(1).max(1);
        let lease_ms = i64::try_from(limits.member_lease.as_millis()).unwrap_or(i64::MAX);
        member.lease_until_ms = now_ms.saturating_add(lease_ms.max(1));
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        self.db.write_batch(batch)?;
        Ok(MonadOutboxLeaseAcquire::Acquired {
            lease: MonadOutboxLease {
                generation: member.lease_generation,
            },
            member,
        })
    }

    /// Charge one replay attempt to an exact-missing scan lease. This is the only path that
    /// applies claim age and attempt terminalization.
    pub fn begin_replay_attempt(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxReplayStart> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("active claim has no outbox row".to_string()))?;
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(MonadOutboxReplayStart::Stale);
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending)
            || member.lease_generation != lease.generation
        {
            return Ok(MonadOutboxReplayStart::Stale);
        }
        let age_ms = now_ms.saturating_sub(record.created_at_ms);
        let max_age_ms = i64::try_from(limits.max_claim_age.as_millis()).unwrap_or(i64::MAX);
        let terminal = if age_ms > max_age_ms {
            Some((MonadOutboxTerminal::Expired, "claim age limit exceeded"))
        } else if member.attempts >= limits.max_member_attempts {
            Some((
                MonadOutboxTerminal::AttemptsExhausted,
                "member attempt limit exceeded",
            ))
        } else {
            None
        };
        if let Some((terminal, detail)) = terminal {
            self.write_terminal_locked(
                &payload_hash,
                &mut record,
                &mut member,
                terminal,
                detail,
                now_ms,
                limits,
            )?;
            drop(_guard);
            self.gc_history(now_ms, limits)?;
            return Ok(MonadOutboxReplayStart::Terminal(terminal));
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
        Ok(MonadOutboxReplayStart::Started(member))
    }

    /// Release a scan lease without changing retry timing (used when backoff still applies).
    pub fn release_reconcile_lease(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
    ) -> Result<MonadOutboxTransition> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("leased claim has no outbox row".to_string()))?;
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(MonadOutboxTransition::Stale);
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending)
            || member.lease_generation != lease.generation
        {
            return Ok(MonadOutboxTransition::Stale);
        }
        member.lease_until_ms = 0;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        self.db.write_batch(batch)?;
        Ok(MonadOutboxTransition::Applied)
    }

    /// Persist an exact receipt observation. This may win over an in-flight replay lease, but it
    /// never resurrects terminal state or overwrites a prior confirmation.
    #[cfg(test)]
    pub fn confirm_observed_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        value_wei: u128,
        block_number: u64,
        now_ms: i64,
    ) -> Result<MonadOutboxTransition> {
        self.confirm_member_if_current(
            payload_hash,
            child_index,
            None,
            value_wei,
            block_number,
            now_ms,
        )
    }

    /// Complete one replay as confirmed only if its exact durable generation still owns Pending.
    pub fn complete_confirmed_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        value_wei: u128,
        block_number: u64,
        now_ms: i64,
    ) -> Result<MonadOutboxTransition> {
        self.confirm_member_if_current(
            payload_hash,
            child_index,
            Some(lease),
            value_wei,
            block_number,
            now_ms,
        )
    }

    fn confirm_member_if_current(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: Option<MonadOutboxLease>,
        value_wei: u128,
        block_number: u64,
        now_ms: i64,
    ) -> Result<MonadOutboxTransition> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("confirmed child has no outbox row".to_string()))?;
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(MonadOutboxTransition::Stale);
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending)
            || lease
                .map(|lease| lease.generation != member.lease_generation)
                .unwrap_or(false)
        {
            return Ok(MonadOutboxTransition::Stale);
        }
        member.state = MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        };
        member.lease_until_ms = 0;
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
            recipient_key(&active_policy(&record)?.recipient, &payload_hash),
            [],
        );
        self.db.write_batch(batch)?;
        Ok(MonadOutboxTransition::Applied)
    }

    /// Complete a replay with a bounded transient error if its generation still owns Pending.
    pub fn complete_pending_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("pending child has no outbox row".to_string()))?;
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(MonadOutboxTransition::Stale);
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending)
            || member.lease_generation != lease.generation
        {
            return Ok(MonadOutboxTransition::Stale);
        }
        let detail = bounded_text(detail, limits.max_last_error_bytes);
        member.last_error = detail.clone();
        member.updated_at_ms = now_ms;
        member.lease_until_ms = 0;
        record.last_error = detail;
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, encode_record(&record));
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        self.db.write_batch(batch)?;
        Ok(MonadOutboxTransition::Applied)
    }

    /// Persist a permanent exact-chain observation while Pending, without a replay token.
    #[cfg(test)]
    pub fn terminal_observed_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        self.terminal_member_if_current(
            payload_hash,
            child_index,
            None,
            terminal,
            detail,
            now_ms,
            limits,
        )
    }

    /// Complete one replay as terminal only if its durable generation still owns Pending.
    pub fn complete_terminal_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        self.terminal_member_if_current(
            payload_hash,
            child_index,
            Some(lease),
            terminal,
            detail,
            now_ms,
            limits,
        )
    }

    fn terminal_member_if_current(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: Option<MonadOutboxLease>,
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("terminal child has no outbox row".to_string()))?;
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(MonadOutboxTransition::Stale);
        }
        let mut member = self
            .get_member(&payload_hash, child_index)?
            .ok_or(MemberNotFound(child_index))?;
        if !matches!(member.state, MonadOutboxMemberState::Pending)
            || lease
                .map(|lease| lease.generation != member.lease_generation)
                .unwrap_or(false)
        {
            return Ok(MonadOutboxTransition::Stale);
        }
        self.write_terminal_locked(
            &payload_hash,
            &mut record,
            &mut member,
            terminal,
            detail,
            now_ms,
            limits,
        )?;
        drop(_guard);
        self.gc_history(now_ms, limits)?;
        Ok(MonadOutboxTransition::Applied)
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
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(());
        }
        record.lifecycle = MonadOutboxLifecycle::Terminal(terminal);
        record.updated_at_ms = now_ms;
        record.last_error = bounded_text(detail, limits.max_last_error_bytes);
        let mut batch = rocksdb::WriteBatch::default();
        let encoded = encode_record(&record);
        batch.put_cf(self.cf_outbox, payload_hash, &encoded);
        batch.delete_cf(self.cf_active, payload_hash);
        if !self.has_recovery_facts_locked(&payload_hash, &record)? {
            batch.put_cf(
                self.cf_history,
                history_key(now_ms, &payload_hash),
                self.retained_claim_bytes_locked(&payload_hash, &record, encoded.len())?
                    .to_be_bytes(),
            );
        }
        self.db.write_batch(batch)?;
        drop(_guard);
        self.gc_history(now_ms, limits)
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
        member.lease_until_ms = 0;
        member.updated_at_ms = now_ms;
        member.last_error = detail.clone();
        record.lifecycle = MonadOutboxLifecycle::Terminal(terminal);
        record.updated_at_ms = now_ms;
        record.last_error = detail;
        let encoded = encode_record(record);
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(self.cf_outbox, payload_hash, &encoded);
        batch.put_cf(
            self.cf_members,
            member_key(payload_hash, member.child_index),
            encode_member(member),
        );
        batch.delete_cf(self.cf_active, payload_hash);
        if !self.has_recovery_facts_locked(payload_hash, record)? {
            batch.put_cf(
                self.cf_history,
                history_key(now_ms, payload_hash),
                self.retained_claim_bytes_locked(payload_hash, record, encoded.len())?
                    .to_be_bytes(),
            );
        }
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
        match record.lifecycle {
            MonadOutboxLifecycle::FullyConfirmed | MonadOutboxLifecycle::Delivered => {
                return Ok(true)
            }
            MonadOutboxLifecycle::Terminal(_) => return Ok(false),
            MonadOutboxLifecycle::Pending => {}
        }
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
        if total < active_policy(&record)?.min_value_wei {
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
        limits: &MonadOutboxLimits,
    ) -> Result<proto::StoredMonadMessage> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("delivery has no outbox row".to_string()))?;
        if record.lifecycle == MonadOutboxLifecycle::Delivered {
            let stored = self.db.monad_messages().get_existing(&payload_hash)?;
            if record.canonical_message.is_some() {
                let message = Self::canonical_message(&record)?;
                let policy = active_policy(&record)?.clone();
                record.canonical_message = None;
                record.policy = None;
                record.last_error.clear();
                let encoded = encode_record(&record);
                let mut batch = rocksdb::WriteBatch::default();
                batch.put_cf(self.cf_outbox, payload_hash, &encoded);
                batch.delete_cf(self.cf_active, payload_hash);
                batch.delete_cf(
                    self.cf_recipient,
                    recipient_key(&policy.recipient, &payload_hash),
                );
                for payment in message.stamp_payments {
                    batch.delete_cf(
                        self.cf_members,
                        member_key(&payload_hash, payment.child_index),
                    );
                }
                batch.put_cf(
                    self.cf_history,
                    history_key(record.updated_at_ms, &payload_hash),
                    (encoded.len() as u64).to_be_bytes(),
                );
                self.db.write_batch(batch)?;
            }
            drop(_guard);
            self.gc_history(now_ms, limits)?;
            return Ok(stored);
        }
        if record.lifecycle != MonadOutboxLifecycle::FullyConfirmed {
            return Err(
                CorruptRecord("delivery attempted before full confirmation".to_string()).into(),
            );
        }
        let message = Self::canonical_message(&record)?;
        let policy = active_policy(&record)?.clone();
        let child_indices = message
            .stamp_payments
            .iter()
            .map(|payment| payment.child_index)
            .collect::<Vec<_>>();
        let stored = proto::StoredMonadMessage {
            message: Some(message),
            timestamp: now_ms,
            network_tag: policy.network_tag,
        };
        record.lifecycle = MonadOutboxLifecycle::Delivered;
        record.updated_at_ms = now_ms;
        record.canonical_message = None;
        record.policy = None;
        record.last_error.clear();
        let encoded_tombstone = encode_record(&record);
        let mut batch = rocksdb::WriteBatch::default();
        self.db.monad_messages().append_put_to_batch(
            &mut batch,
            &payload_hash,
            &policy.recipient,
            &stored,
        )?;
        batch.put_cf(self.cf_outbox, payload_hash, &encoded_tombstone);
        batch.delete_cf(self.cf_active, payload_hash);
        batch.delete_cf(
            self.cf_recipient,
            recipient_key(&policy.recipient, &payload_hash),
        );
        for child_index in child_indices {
            batch.delete_cf(self.cf_members, member_key(&payload_hash, child_index));
        }
        batch.put_cf(
            self.cf_history,
            history_key(now_ms, &payload_hash),
            (encoded_tombstone.len() as u64).to_be_bytes(),
        );
        self.db.write_batch(batch)?;
        drop(_guard);
        self.gc_history(now_ms, limits)?;
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
        {
            let (key, _) = item?;
            if key.len() != RECIPIENT_KEY_LEN || !key.starts_with(&prefix) {
                break;
            }
            let payload_hash = checked_payload_hash(&key[20..])?;
            let record = self.get(&payload_hash)?.ok_or_else(|| {
                CorruptRecord("recipient index references missing outbox".to_string())
            })?;
            if matches!(record.lifecycle, MonadOutboxLifecycle::Delivered) {
                continue;
            }
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
                if recoveries.len() == limit {
                    break;
                }
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

    fn has_recovery_facts_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
    ) -> Result<bool> {
        let Some(policy) = record.policy.as_ref() else {
            return Ok(false);
        };
        Ok(self
            .db
            .get(
                self.cf_recipient,
                recipient_key(&policy.recipient, payload_hash),
            )?
            .is_some())
    }

    fn retained_claim_bytes_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
        encoded_record_len: usize,
    ) -> Result<u64> {
        let mut total = encoded_record_len as u64;
        if let Ok(message) = Self::canonical_message(record) {
            for payment in message.stamp_payments {
                if let Some(member) = self.get_member(payload_hash, payment.child_index)? {
                    total = total.saturating_add(encode_member(&member).len() as u64);
                }
            }
        }
        Ok(total)
    }

    /// Enforce bounded delivered/non-recoverable-terminal history. Recipient recovery rows are
    /// never indexed here and are defensively skipped if an inconsistent index is encountered.
    pub fn gc_history(&self, now_ms: i64, limits: &MonadOutboxLimits) -> Result<()> {
        let _guard = self.db.lock_monad_outbox();
        let max_records = limits.max_history_records.min(MAX_HISTORY_RECORDS_HARD);
        let scan_limit = MAX_HISTORY_RECORDS_HARD.saturating_add(1);
        let mut entries = Vec::new();
        for item in self
            .db
            .rocksdb()
            .iterator_cf(self.cf_history, IteratorMode::Start)
            .take(scan_limit)
        {
            let (key, value) = item?;
            let (timestamp, payload_hash) = decode_history_key(&key)?;
            let bytes = value
                .as_ref()
                .try_into()
                .map(u64::from_be_bytes)
                .map_err(|_| CorruptRecord("history byte count is malformed".to_string()))?;
            entries.push((key.to_vec(), timestamp, payload_hash, bytes));
        }
        let max_age_ms = i64::try_from(limits.max_history_age.as_millis()).unwrap_or(i64::MAX);
        let mut retained_count = entries.len();
        let mut retained_bytes = entries
            .iter()
            .fold(0u64, |sum, entry| sum.saturating_add(entry.3));
        let mut batch = rocksdb::WriteBatch::default();
        for (key, timestamp, payload_hash, bytes) in entries {
            let age_expired = now_ms.saturating_sub(timestamp) > max_age_ms;
            let over_count = retained_count > max_records;
            let over_bytes = retained_bytes > limits.max_history_bytes as u64;
            if !age_expired && !over_count && !over_bytes {
                continue;
            }
            let record = self.get(&payload_hash)?;
            if let Some(record) = record {
                if self.has_recovery_facts_locked(&payload_hash, &record)? {
                    batch.delete_cf(self.cf_history, key);
                    continue;
                }
                if let Ok(message) = Self::canonical_message(&record) {
                    for payment in message.stamp_payments {
                        batch.delete_cf(
                            self.cf_members,
                            member_key(&payload_hash, payment.child_index),
                        );
                    }
                }
                batch.delete_cf(self.cf_outbox, payload_hash);
            }
            batch.delete_cf(self.cf_history, key);
            retained_count = retained_count.saturating_sub(1);
            retained_bytes = retained_bytes.saturating_sub(bytes);
        }
        self.db.write_batch(batch)
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

fn unix_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn active_policy(record: &MonadOutboxRecord) -> Result<&MonadOutboxPolicy> {
    record.policy.as_ref().ok_or_else(|| {
        CorruptRecord("compact outbox tombstone has no active policy".to_string()).into()
    })
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

fn history_key(timestamp: i64, payload_hash: &[u8; 32]) -> [u8; 40] {
    let mut key = [0u8; 40];
    key[..8].copy_from_slice(&((timestamp as u64) ^ (1u64 << 63)).to_be_bytes());
    key[8..].copy_from_slice(payload_hash);
    key
}

fn decode_history_key(key: &[u8]) -> Result<(i64, [u8; 32])> {
    if key.len() != 40 {
        return Err(CorruptRecord("history key has invalid length".to_string()).into());
    }
    let ordered = u64::from_be_bytes(key[..8].try_into().expect("length checked"));
    Ok((
        (ordered ^ (1u64 << 63)) as i64,
        checked_payload_hash(&key[8..])?,
    ))
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
    let kind = match (&record.canonical_message, &record.policy) {
        (Some(_), Some(_)) => 0,
        (None, None) => 1,
        _ => panic!("outbox canonical message and policy ownership must move together"),
    };
    let canonical_len = record
        .canonical_message
        .as_ref()
        .map(Vec::len)
        .unwrap_or_default();
    let mut bytes = Vec::with_capacity(canonical_len + 128);
    bytes.extend_from_slice(&[RECORD_VERSION, lifecycle, terminal, kind]);
    bytes.extend_from_slice(&record.created_at_ms.to_be_bytes());
    bytes.extend_from_slice(&record.updated_at_ms.to_be_bytes());
    bytes.extend_from_slice(&record.reconciliation_attempts.to_be_bytes());
    put_bytes(&mut bytes, record.last_error.as_bytes());
    if let (Some(policy), Some(canonical_message)) = (&record.policy, &record.canonical_message) {
        bytes.extend_from_slice(&policy.min_value_wei.to_be_bytes());
        bytes.extend_from_slice(&policy.recipient.0);
        put_bytes(&mut bytes, &policy.recipient_pubkey);
        put_bytes(&mut bytes, &policy.network_tag);
        put_bytes(&mut bytes, canonical_message);
    }
    bytes
}

fn decode_record(bytes: &[u8]) -> Result<MonadOutboxRecord> {
    let mut cursor = Cursor::new(bytes);
    let version = cursor.u8()?;
    if version == RECORD_VERSION_V1 {
        return decode_record_v1(cursor);
    }
    if version != RECORD_VERSION {
        return Err(CorruptRecord(format!("unsupported outbox record version {version}")).into());
    }
    let lifecycle_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let kind = cursor.u8()?;
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
    let last_error = cursor.string(4096)?;
    let (policy, canonical_message) = match kind {
        0 => {
            let min_value_wei = cursor.u128()?;
            let recipient = Address(cursor.array()?);
            let recipient_pubkey = cursor.bytes(65)?;
            let network_tag = cursor.bytes(64)?;
            let canonical_message = cursor.bytes(2 * 1024 * 1024)?;
            (
                Some(MonadOutboxPolicy {
                    recipient,
                    recipient_pubkey,
                    min_value_wei,
                    network_tag,
                }),
                Some(canonical_message),
            )
        }
        1 if lifecycle == MonadOutboxLifecycle::Delivered => (None, None),
        1 => {
            return Err(CorruptRecord(
                "only delivered records may omit canonical ownership".to_string(),
            )
            .into())
        }
        _ => return Err(CorruptRecord(format!("unknown outbox record kind {kind}")).into()),
    };
    cursor.finish()?;
    Ok(MonadOutboxRecord {
        canonical_message,
        policy,
        created_at_ms,
        updated_at_ms,
        lifecycle,
        reconciliation_attempts,
        last_error,
    })
}

fn decode_record_v1(mut cursor: Cursor<'_>) -> Result<MonadOutboxRecord> {
    let lifecycle_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let lifecycle = match lifecycle_tag {
        0 => MonadOutboxLifecycle::Pending,
        1 => MonadOutboxLifecycle::FullyConfirmed,
        2 => MonadOutboxLifecycle::Delivered,
        3 => MonadOutboxLifecycle::Terminal(decode_terminal(terminal_tag)?),
        _ => return Err(CorruptRecord("unknown v1 outbox lifecycle".to_string()).into()),
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
        canonical_message: Some(canonical_message),
        policy: Some(MonadOutboxPolicy {
            recipient,
            recipient_pubkey,
            min_value_wei,
            network_tag,
        }),
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
    bytes.extend_from_slice(&member.lease_generation.to_be_bytes());
    bytes.extend_from_slice(&member.lease_until_ms.to_be_bytes());
    put_bytes(&mut bytes, member.last_error.as_bytes());
    bytes
}

fn decode_member(child_index: u32, bytes: &[u8]) -> Result<MonadOutboxMember> {
    let mut cursor = Cursor::new(bytes);
    let version = cursor.u8()?;
    if version != RECORD_VERSION_V1 && version != RECORD_VERSION {
        return Err(CorruptRecord(format!("unsupported member record version {version}")).into());
    }
    let state_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let tx_hash = Hash32(cursor.array()?);
    let attempts = cursor.u32()?;
    let updated_at_ms = cursor.i64()?;
    let value_wei = cursor.u128()?;
    let block_number = cursor.u64()?;
    let (lease_generation, lease_until_ms) = if version == RECORD_VERSION {
        (cursor.u64()?, cursor.i64()?)
    } else {
        (0, 0)
    };
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
        lease_generation,
        lease_until_ms,
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
        message_with_seed(b"canonical encrypted payload", raw_txs)
    }

    fn message_with_seed(seed: &[u8], raw_txs: &[&[u8]]) -> proto::MonadStampedMessage {
        let encrypted_payload = seed.to_vec();
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

    fn raw_occurrences(db: &Db, needle: &[u8]) -> usize {
        [
            CF_MONAD_OUTBOX_V1,
            CF_MONAD_OUTBOX_MEMBERS_V1,
            crate::store::db::CF_MONAD_MESSAGES,
        ]
        .into_iter()
        .map(|name| {
            db.rocksdb()
                .iterator_cf(db.cf(name).unwrap(), IteratorMode::Start)
                .map(|item| {
                    let (_, value) = item.unwrap();
                    value
                        .windows(needle.len())
                        .filter(|window| *window == needle)
                        .count()
                })
                .sum::<usize>()
        })
        .sum()
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
            Some(canonical)
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
            store.confirm_observed_member(&payload_hash, 0, 7, 42, 110)?;
            store.terminal_observed_member(
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
    fn lease_generations_make_both_completion_orders_monotonic() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-generations")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let mut limits = MonadOutboxLimits::default();
        limits.member_lease = Duration::ZERO;

        for (seed, confirm_wins) in [
            (b"confirm-wins".as_slice(), true),
            (b"terminal-wins", false),
        ] {
            let request = message_with_seed(seed, &[b"generation raw"]);
            let store = db.monad_outbox();
            store.claim(&request.payload_hash, &request, &policy(), 100, &limits)?;
            let old = match store.acquire_reconcile_lease(&request.payload_hash, 0, 100, &limits)? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected first lease, got {other:?}"),
            };
            let new = match store.acquire_reconcile_lease(&request.payload_hash, 0, 102, &limits)? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected superseding lease, got {other:?}"),
            };
            if confirm_wins {
                assert_eq!(
                    store.complete_confirmed_member(&request.payload_hash, 0, new, 10, 9, 103)?,
                    MonadOutboxTransition::Applied
                );
                assert_eq!(
                    store.complete_terminal_member(
                        &request.payload_hash,
                        0,
                        old,
                        MonadOutboxTerminal::StaleNonce,
                        "old completion",
                        104,
                        &limits,
                    )?,
                    MonadOutboxTransition::Stale
                );
                assert!(matches!(
                    store.get_member(&request.payload_hash, 0)?.unwrap().state,
                    MonadOutboxMemberState::Confirmed { .. }
                ));
            } else {
                assert_eq!(
                    store.complete_terminal_member(
                        &request.payload_hash,
                        0,
                        new,
                        MonadOutboxTerminal::StaleNonce,
                        "new completion",
                        103,
                        &limits,
                    )?,
                    MonadOutboxTransition::Applied
                );
                assert_eq!(
                    store.complete_confirmed_member(&request.payload_hash, 0, old, 10, 9, 104)?,
                    MonadOutboxTransition::Stale
                );
                assert_eq!(
                    store.get_member(&request.payload_hash, 0)?.unwrap().state,
                    MonadOutboxMemberState::Terminal(MonadOutboxTerminal::StaleNonce)
                );
            }
        }
        Ok(())
    }

    #[test]
    fn delivery_transfers_single_raw_owner_uses_delivery_cursor_and_survives_reopen() -> Result<()>
    {
        let tempdir = tempdir::TempDir::new("monad-outbox-owner")?;
        let path = tempdir.path().join("db.rocksdb");
        let raw = b"unique canonical raw transaction owner bytes";
        let request = message_with_seed(b"owner payload", &[raw]);
        let payload_hash = request.payload_hash.clone();
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            store.claim(
                &payload_hash,
                &request,
                &policy(),
                100,
                &MonadOutboxLimits::default(),
            )?;
            assert_eq!(raw_occurrences(&db, raw), 1);
            assert!(db
                .monad_messages()
                .list_for_recipient_since(&policy().recipient, 200)?
                .is_empty());
            store.confirm_observed_member(&payload_hash, 0, 10, 7, 250)?;
            assert!(store.mark_fully_confirmed(&payload_hash, 260)?);
            let delivered =
                store.finalize_delivery(&payload_hash, 300, &MonadOutboxLimits::default())?;
            assert_eq!(delivered.timestamp, 300);
            assert_eq!(raw_occurrences(&db, raw), 1);
            assert!(store
                .get(&payload_hash)?
                .unwrap()
                .canonical_message
                .is_none());
            assert!(store.get_member(&payload_hash, 0)?.is_none());
            assert_eq!(
                db.monad_messages()
                    .list_for_recipient_since(&policy().recipient, 200)?,
                vec![delivered.clone()]
            );
            assert_eq!(
                store
                    .finalize_delivery(&payload_hash, 400, &MonadOutboxLimits::default())?
                    .timestamp,
                300
            );
        }
        let db = Db::open(&path)?;
        assert_eq!(raw_occurrences(&db, raw), 1);
        assert_eq!(
            db.monad_messages().get(&payload_hash)?.unwrap().timestamp,
            300
        );
        Ok(())
    }

    #[test]
    fn reopen_migrates_v1_delivered_duplicate_to_one_inbox_owner() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v1-delivered")?;
        let path = tempdir.path().join("db.rocksdb");
        let raw = b"legacy delivered canonical raw owner";
        let request = message_with_seed(b"legacy delivered", &[raw]);
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        {
            let db = Db::open(&path)?;
            let policy = policy();
            db.monad_messages().put(
                &payload_hash,
                &policy.recipient,
                &proto::StoredMonadMessage {
                    message: Some(request.clone()),
                    timestamp: 300,
                    network_tag: policy.network_tag.clone(),
                },
            )?;
            let mut record = vec![RECORD_VERSION_V1, 2, 0];
            record.extend_from_slice(&100i64.to_be_bytes());
            record.extend_from_slice(&300i64.to_be_bytes());
            record.extend_from_slice(&1u32.to_be_bytes());
            record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
            record.extend_from_slice(&policy.recipient.0);
            put_bytes(&mut record, &policy.recipient_pubkey);
            put_bytes(&mut record, &policy.network_tag);
            put_bytes(&mut record, b"");
            put_bytes(&mut record, &request.encode_to_vec());
            let store = db.monad_outbox();
            db.put(store.cf_outbox, payload_hash, record)?;
            let member = MonadOutboxMember {
                child_index: 0,
                tx_hash: Hash32(Keccak256::digest(raw).into()),
                state: MonadOutboxMemberState::Confirmed {
                    value_wei: 10,
                    block_number: 1,
                },
                attempts: 1,
                lease_generation: 0,
                lease_until_ms: 0,
                updated_at_ms: 200,
                last_error: String::new(),
            };
            db.put(
                store.cf_members,
                member_key(&payload_hash, 0),
                encode_member(&member),
            )?;
            db.put(
                store.cf_recipient,
                recipient_key(&policy.recipient, &payload_hash),
                [],
            )?;
            db.rocksdb()
                .delete_cf(store.cf_meta, b"delivered-owner-v2")?;
            assert_eq!(raw_occurrences(&db, raw), 2);
        }
        let db = Db::open(&path)?;
        let store = db.monad_outbox();
        assert_eq!(raw_occurrences(&db, raw), 1);
        assert!(store
            .get(&payload_hash)?
            .map(|record| record.canonical_message.is_none())
            .unwrap_or(true));
        assert!(store.get_member(&payload_hash, 0)?.is_none());
        assert!(db
            .get(
                store.cf_recipient,
                recipient_key(&policy().recipient, &payload_hash),
            )?
            .is_none());
        Ok(())
    }

    #[test]
    fn tiny_history_bounds_gc_tombstones_but_inbox_keeps_exact_binding() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-history")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let mut limits = MonadOutboxLimits::default();
        limits.max_history_records = 1;
        limits.max_history_bytes = 1024;
        let mut requests = Vec::new();
        for index in 0..3u8 {
            let seed = vec![index; 8];
            let raw = vec![0xa0 + index; 24];
            let request = message_with_seed(&seed, &[&raw]);
            let store = db.monad_outbox();
            store.claim(&request.payload_hash, &request, &policy(), 100, &limits)?;
            store.confirm_observed_member(&request.payload_hash, 0, 10, 1, 200)?;
            assert!(store.mark_fully_confirmed(&request.payload_hash, 250)?);
            store.finalize_delivery(&request.payload_hash, 300 + index as i64, &limits)?;
            requests.push(request);
        }
        assert!(
            db.rocksdb()
                .iterator_cf(db.cf(CF_MONAD_OUTBOX_HISTORY_V2)?, IteratorMode::Start)
                .count()
                <= 1
        );
        for request in requests {
            assert!(matches!(
                db.monad_outbox().claim(
                    &request.payload_hash,
                    &request,
                    &policy(),
                    500,
                    &limits,
                )?,
                MonadOutboxClaim::ExistingExact(_)
            ));
        }
        Ok(())
    }

    #[test]
    fn delivered_recovery_rows_are_removed_and_do_not_consume_limit() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recovery-index")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let limits = MonadOutboxLimits::default();
        let mut requests = (0..10u8)
            .map(|index| {
                let seed = vec![0x20 + index; 12];
                let raw0 = vec![0x80 + index; 12];
                let raw1 = vec![0xc0 + index; 12];
                message_with_seed(&seed, &[&raw0, &raw1])
            })
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| left.payload_hash.cmp(&right.payload_hash));
        let partial = requests.pop().unwrap();
        let store = db.monad_outbox();
        for delivered in requests.iter().take(4) {
            store.claim(&delivered.payload_hash, delivered, &policy(), 100, &limits)?;
            store.confirm_observed_member(&delivered.payload_hash, 0, 10, 1, 110)?;
            store.confirm_observed_member(&delivered.payload_hash, 1, 10, 1, 111)?;
            assert!(store.mark_fully_confirmed(&delivered.payload_hash, 120)?);
            store.finalize_delivery(&delivered.payload_hash, 130, &limits)?;
            assert!(db
                .get(
                    store.cf_recipient,
                    recipient_key(
                        &policy().recipient,
                        delivered.payload_hash.as_slice().try_into().unwrap(),
                    ),
                )?
                .is_none());
            // Simulate stale version-1 index debris to exercise the defensive query filter.
            db.put(
                store.cf_recipient,
                recipient_key(
                    &policy().recipient,
                    delivered.payload_hash.as_slice().try_into().unwrap(),
                ),
                [],
            )?;
        }
        store.claim(&partial.payload_hash, &partial, &policy(), 200, &limits)?;
        store.confirm_observed_member(&partial.payload_hash, 0, 10, 2, 210)?;
        let recovered = store.confirmed_prefixes_for_recipient(&policy().recipient, 1)?;
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].payload_hash.as_slice(), partial.payload_hash);
        assert_eq!(recovered[0].confirmed_prefix.len(), 1);
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
        let first_lease =
            match db
                .monad_outbox()
                .acquire_reconcile_lease(&first.payload_hash, 0, 101, &limits)?
            {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected lease, got {other:?}"),
            };
        assert!(matches!(
            db.monad_outbox().begin_replay_attempt(
                &first.payload_hash,
                0,
                first_lease,
                101,
                &limits,
            )?,
            MonadOutboxReplayStart::Started(_)
        ));
        db.monad_outbox().complete_pending_member(
            &first.payload_hash,
            0,
            first_lease,
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
        let exhausted_lease =
            match db
                .monad_outbox()
                .acquire_reconcile_lease(&first.payload_hash, 0, 103, &limits)?
            {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected lease, got {other:?}"),
            };
        let exhausted = db.monad_outbox().begin_replay_attempt(
            &first.payload_hash,
            0,
            exhausted_lease,
            103,
            &limits,
        )?;
        assert_eq!(
            exhausted,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::AttemptsExhausted)
        );

        limits.max_claim_age = Duration::ZERO;
        assert_eq!(
            db.monad_outbox()
                .claim(&second.payload_hash, &second, &policy(), 100, &limits)?,
            MonadOutboxClaim::New
        );
        let expired_lease = match db.monad_outbox().acquire_reconcile_lease(
            &second.payload_hash,
            0,
            101,
            &limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        let expired = db.monad_outbox().begin_replay_attempt(
            &second.payload_hash,
            0,
            expired_lease,
            101,
            &limits,
        )?;
        assert_eq!(
            expired,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
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

    #[test]
    fn version_one_rows_decode_with_unleased_active_ownership() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v1-migration")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let request = message(&[b"v1 canonical raw"]);
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let canonical = request.encode_to_vec();
        let policy = policy();
        let mut record = vec![RECORD_VERSION_V1, 0, 0];
        record.extend_from_slice(&100i64.to_be_bytes());
        record.extend_from_slice(&101i64.to_be_bytes());
        record.extend_from_slice(&3u32.to_be_bytes());
        record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
        record.extend_from_slice(&policy.recipient.0);
        put_bytes(&mut record, &policy.recipient_pubkey);
        put_bytes(&mut record, &policy.network_tag);
        put_bytes(&mut record, b"old diagnostic");
        put_bytes(&mut record, &canonical);
        db.put(db.monad_outbox().cf_outbox, payload_hash, record)?;

        let tx_hash = Hash32(Keccak256::digest(b"v1 canonical raw").into());
        let mut member = vec![RECORD_VERSION_V1, 0, 0];
        member.extend_from_slice(&tx_hash.0);
        member.extend_from_slice(&2u32.to_be_bytes());
        member.extend_from_slice(&101i64.to_be_bytes());
        member.extend_from_slice(&0u128.to_be_bytes());
        member.extend_from_slice(&0u64.to_be_bytes());
        put_bytes(&mut member, b"v1 pending");
        db.put(
            db.monad_outbox().cf_members,
            member_key(&payload_hash, 0),
            member,
        )?;

        let decoded = db.monad_outbox().get(&payload_hash)?.unwrap();
        assert_eq!(decoded.canonical_message, Some(canonical));
        assert_eq!(decoded.policy, Some(policy));
        let decoded_member = db.monad_outbox().get_member(&payload_hash, 0)?.unwrap();
        assert_eq!(decoded_member.lease_generation, 0);
        assert_eq!(decoded_member.lease_until_ms, 0);
        Ok(())
    }
}
