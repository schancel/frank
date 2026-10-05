//! Durable exact-byte outbox for Monad direct-message payments.
//!
//! The outbox owns one canonical protobuf encoding of the request. Member rows deliberately do
//! not copy `raw_tx`; they reference a canonical child by `(payload_hash, child_index)` and pin
//! its deterministic transaction hash. This is the recovery boundary used after a crash.

use std::{fmt::Debug, time::Duration};

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{ErrorMeta, Result, WrapErr};
use prost::Message;
use rand::{rngs::OsRng, RngCore};
use rocksdb::{ColumnFamilyDescriptor, Direction, IteratorMode};
use serde::Deserialize;
use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::{
    monad_evm_tx::decode_signed_transaction,
    monad_http::{Address, Hash32},
    proto,
    store::db::{
        Db, CF, CF_MONAD_MESSAGES, CF_MONAD_MESSAGES_BY_RECIPIENT_TIME, CF_MONAD_MESSAGE_ATTEMPTS,
        CF_MONAD_OUTBOX_ACTIVE_V1, CF_MONAD_OUTBOX_HISTORY_V2, CF_MONAD_OUTBOX_MEMBERS_V1,
        CF_MONAD_OUTBOX_META_V2, CF_MONAD_OUTBOX_RECIPIENT_V1, CF_MONAD_OUTBOX_V1,
    },
};

const RECORD_VERSION_V1: u8 = 1;
const RECORD_VERSION_V2: u8 = 2;
const RECORD_VERSION: u8 = 3;
const MEMBER_RECORD_VERSION: u8 = 4;
const PAYLOAD_HASH_LEN: usize = 32;
const MEMBER_KEY_LEN: usize = PAYLOAD_HASH_LEN + 4;
const RECIPIENT_KEY_LEN: usize = 20 + PAYLOAD_HASH_LEN;
const MAX_HISTORY_RECORDS_HARD: usize = 4096;
// At the hard 2 MiB canonical cap, one migration chunk retains at most ~32 MiB of row values.
const MIGRATION_BATCH_SIZE: usize = 16;
const MAX_CANONICAL_BYTES_HARD: usize = 2 * 1024 * 1024;
// This is also the fixed HTTP wire cardinality. Supported predecessor writers could lower their
// configured admission limit, but could never create more than 64 canonical payment fields.
pub(crate) const MAX_MEMBERS_HARD: usize = 64;
const MAX_LAST_ERROR_BYTES_HARD: usize = 4096;
const MAX_NETWORK_TAG_BYTES_HARD: usize = 64;
const MAX_RECIPIENT_PUBKEY_BYTES_HARD: usize = 65;
const RECOVERY_QUOTA_MIGRATION_KEY: &[u8] = b"outbox-recovery-quota-v5";
const RECOVERY_QUOTA_CURSOR_KEY: &[u8] = b"outbox-recovery-quota-v5-cursor";
const RECOVERY_QUOTA_CURSOR_STATE_KEY: &[u8] = b"outbox-recovery-quota-v5-cursor-state";
const RECOVERY_QUOTA_GLOBAL_KEY: &[u8] = b"outbox-recovery-quota-v5-global";
const RECOVERY_QUOTA_RECIPIENT_PREFIX: &[u8] = b"outbox-recovery-quota-v5-recipient:";
const RECOVERY_QUOTA_RECORD_PREFIX: &[u8] = b"outbox-recovery-quota-v5-record:";
const RECOVERY_QUOTA_OWNER_PREFIX: &[u8] = b"outbox-recovery-quota-v5-owner:";
const RECOVERY_OBLIGATION_ID_PREFIX: &[u8] = b"outbox-recovery-obligation-v1-record:";
const RECOVERY_OBLIGATION_MIGRATION_KEY: &[u8] = b"outbox-recovery-obligation-v1";
const RECOVERY_OBLIGATION_CURSOR_KEY: &[u8] = b"outbox-recovery-obligation-v1-cursor";
const RECOVERY_OBLIGATION_CURSOR_STATE_KEY: &[u8] = b"outbox-recovery-obligation-v1-cursor-state";
const CHAIN_BINDING_KEY: &[u8] = b"outbox-chain-id-v1";
const CHAIN_BINDING_PENDING_KEY: &[u8] = b"outbox-chain-id-v1-pending";
const CHAIN_BINDING_CURSOR_KEY: &[u8] = b"outbox-chain-id-v1-cursor";
const CHAIN_SCAN_OUTBOX: u8 = 1;
const CHAIN_SCAN_INBOX: u8 = 2;
const STARTUP_LEASE_CURSOR_KEY: &[u8] = b"outbox-startup-lease-v1-cursor";
// V1/V2 rows predate frozen retry policy. These fixed compatibility defaults match the policy
// shipped with those formats; reopening them never consults mutable process configuration.
const LEGACY_MAX_CLAIM_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const LEGACY_MAX_MEMBER_ATTEMPTS: u32 = 32;
const LEGACY_RETRY_BACKOFF_BASE: Duration = Duration::from_secs(1);
const LEGACY_RETRY_BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);

#[cfg(test)]
thread_local! {
    static MIGRATION_FAIL_AFTER_BATCH_BEFORE_GC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    static RECONCILIATION_SNAPSHOT_WORK: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
    static QUOTA_ADMISSION_META_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static QUOTA_ADMISSION_CORPUS_DECODES: std::cell::Cell<(bool, usize)> = const { std::cell::Cell::new((false, 0)) };
    static OUTBOX_CANONICAL_WRITE_WORK: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
pub(crate) fn reset_reconciliation_snapshot_work_counts() {
    RECONCILIATION_SNAPSHOT_WORK.set((0, 0));
}

#[cfg(test)]
pub(crate) fn reconciliation_snapshot_work_counts() -> (usize, usize) {
    RECONCILIATION_SNAPSHOT_WORK.get()
}

static LEGACY_CHAIN_QUARANTINED: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Number of stored payments skipped by chain binding because they carry no usable chain ID.
/// Process-lifetime counter for operators and tests.
pub(crate) fn legacy_chain_quarantined_total() -> u64 {
    LEGACY_CHAIN_QUARANTINED.load(std::sync::atomic::Ordering::Relaxed)
}

fn note_legacy_chain_quarantine(payload_hash: &[u8], child_index: u32, reason: &str) {
    LEGACY_CHAIN_QUARANTINED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    tracing::event!(
        tracing::Level::WARN,
        payload_hash = %hex::encode(payload_hash),
        child_index,
        reason,
        "Quarantined stored Monad payment without a usable chain ID during chain binding"
    );
}

#[cfg(test)]
fn reset_outbox_canonical_write_work() {
    OUTBOX_CANONICAL_WRITE_WORK.set((0, 0));
}

#[cfg(test)]
fn outbox_canonical_write_work() -> (usize, usize) {
    OUTBOX_CANONICAL_WRITE_WORK.get()
}

#[cfg(test)]
fn reset_quota_admission_meta_reads() {
    QUOTA_ADMISSION_META_READS.set(0);
}

#[cfg(test)]
fn quota_admission_meta_reads() -> usize {
    QUOTA_ADMISSION_META_READS.get()
}

#[cfg(test)]
fn begin_quota_admission_corpus_meter() {
    QUOTA_ADMISSION_CORPUS_DECODES.set((true, 0));
}

#[cfg(test)]
fn finish_quota_admission_corpus_meter() -> usize {
    let (_, decodes) = QUOTA_ADMISSION_CORPUS_DECODES.get();
    QUOTA_ADMISSION_CORPUS_DECODES.set((false, decodes));
    decodes
}

#[cfg(test)]
fn note_reconciliation_snapshot_decode() {
    let (records, members) = RECONCILIATION_SNAPSHOT_WORK.get();
    RECONCILIATION_SNAPSHOT_WORK.set((records.saturating_add(1), members));
}

#[cfg(not(test))]
fn note_reconciliation_snapshot_decode() {}

#[cfg(test)]
fn note_reconciliation_snapshot_member_decode() {
    let (records, members) = RECONCILIATION_SNAPSHOT_WORK.get();
    RECONCILIATION_SNAPSHOT_WORK.set((records, members.saturating_add(1)));
}

#[cfg(not(test))]
fn note_reconciliation_snapshot_member_decode() {}

#[cfg(test)]
thread_local! {
    static RECOVERY_PAGE_WORK: std::cell::Cell<(usize, usize, usize, usize)> =
        const { std::cell::Cell::new((0, 0, 0, 0)) };
}

#[cfg(test)]
pub(crate) fn reset_recovery_page_work_counts() {
    RECOVERY_PAGE_WORK.set((0, 0, 0, 0));
}

#[cfg(test)]
pub(crate) fn recovery_page_work_counts() -> (usize, usize, usize, usize) {
    RECOVERY_PAGE_WORK.get()
}

#[cfg(test)]
fn note_recovery_page_read(bytes: usize) {
    let (reads, read_bytes, decodes, decoded_bytes) = RECOVERY_PAGE_WORK.get();
    RECOVERY_PAGE_WORK.set((
        reads.saturating_add(1),
        read_bytes.saturating_add(bytes),
        decodes,
        decoded_bytes,
    ));
}

#[cfg(not(test))]
fn note_recovery_page_read(_bytes: usize) {}

#[cfg(test)]
fn note_recovery_page_decode(bytes: usize) {
    let (reads, read_bytes, decodes, decoded_bytes) = RECOVERY_PAGE_WORK.get();
    RECOVERY_PAGE_WORK.set((
        reads,
        read_bytes,
        decodes.saturating_add(1),
        decoded_bytes.saturating_add(bytes),
    ));
}

#[cfg(not(test))]
fn note_recovery_page_decode(_bytes: usize) {}

#[cfg(test)]
fn migration_failpoint_after_batch_before_gc() -> bool {
    MIGRATION_FAIL_AFTER_BATCH_BEFORE_GC.replace(false)
}

#[cfg(test)]
fn arm_migration_failpoint_after_batch_before_gc() {
    MIGRATION_FAIL_AFTER_BATCH_BEFORE_GC.set(true);
}

/// Resource bounds applied before an outbox batch can amplify an untrusted request on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxLimits {
    /// Maximum canonical protobuf bytes stored in a claim.
    pub max_canonical_bytes: usize,
    /// Maximum canonical payment children.
    pub max_members: usize,
    /// Maximum nonterminal claims retained at once.
    pub max_active_claims: usize,
    /// Maximum recipient-recovery reservations across all recipients.
    pub max_recovery_records: usize,
    /// Maximum encoded bytes reserved by all recipient-recovery claims.
    pub max_recovery_bytes: usize,
    /// Maximum recovery reservations owned by one recipient.
    pub max_recovery_records_per_recipient: usize,
    /// Maximum encoded recovery bytes reserved by one recipient.
    pub max_recovery_bytes_per_recipient: usize,
    /// Maximum age before another replay attempt is refused and retained as terminal.
    pub max_claim_age: Duration,
    /// Maximum age of a claim that has no confirmed child. Payments normally confirm within
    /// seconds, so an unconfirmed claim must not hold its recovery reservation for the full
    /// `max_claim_age`. Applied on top of the frozen `expires_at_ms` (never extends it).
    pub max_unconfirmed_claim_age: Duration,
    /// Maximum age, measured from its terminal transition, of a retained recovery obligation
    /// whose only evidence is unconfirmed exposure (no child was ever confirmed). Obligations
    /// with a confirmed child are never aged out; only recipient acknowledgement retires them.
    pub max_unconfirmed_recovery_age: Duration,
    /// Maximum claims per recipient that own a reservation but have no confirmed child. Kept well
    /// below `max_recovery_records_per_recipient` so unfunded or never-mined signed payments
    /// cannot exhaust a recipient's whole recovery quota.
    pub max_unconfirmed_claims_per_recipient: usize,
    /// Maximum persisted attempts for one member.
    pub max_member_attempts: u32,
    /// Frozen base delay between replay attempts for a newly claimed member.
    pub retry_backoff_base: Duration,
    /// Frozen maximum delay between replay attempts for a newly claimed member.
    pub max_retry_backoff: Duration,
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
            max_recovery_records: 1024,
            max_recovery_bytes: 2 * 1024 * 1024 * 1024,
            max_recovery_records_per_recipient: 128,
            max_recovery_bytes_per_recipient: 256 * 1024 * 1024,
            max_claim_age: Duration::from_secs(7 * 24 * 60 * 60),
            max_unconfirmed_claim_age: Duration::from_secs(6 * 60 * 60),
            max_unconfirmed_recovery_age: Duration::from_secs(24 * 60 * 60),
            max_unconfirmed_claims_per_recipient: 32,
            max_member_attempts: 32,
            retry_backoff_base: Duration::from_secs(1),
            max_retry_backoff: Duration::from_secs(5 * 60),
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

impl MonadOutboxLimits {
    /// Reject writer settings that could create rows the hard-bounded decoder cannot reopen.
    pub fn validate(&self) -> Result<()> {
        validate_limits(self)
    }
}

/// Validation and routing facts frozen with a new canonical outbox claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxPolicy {
    /// Validated mailbox owner.
    pub(crate) recipient: Address,
    /// Recipient key used to derive every child destination.
    pub(crate) recipient_pubkey: Vec<u8>,
    /// Aggregate minimum accepted at admission time.
    pub(crate) min_value_wei: u128,
    /// Validated relay network tag.
    pub(crate) network_tag: Vec<u8>,
}

impl MonadOutboxPolicy {
    /// Construct policy only when its routing address is owned by the supplied compressed key.
    pub(crate) fn new(
        recipient: Address,
        recipient_pubkey: Vec<u8>,
        min_value_wei: u128,
        network_tag: Vec<u8>,
    ) -> Result<Self> {
        let policy = Self {
            recipient,
            recipient_pubkey,
            min_value_wei,
            network_tag,
        };
        policy.validate_recipient_authority()?;
        Ok(policy)
    }

    /// Revalidate the durable routing authority before recovery or publication.
    pub(crate) fn validate_recipient_authority(&self) -> Result<()> {
        let derived =
            crate::monad_stamp_stealth::recipient_address_from_public_key(&self.recipient_pubkey)
                .map_err(|_| InvalidRecipientPublicKey)?;
        if derived != self.recipient {
            return Err(RecipientPublicKeyMismatch {
                claimed: self.recipient,
                derived,
            }
            .into());
        }
        Ok(())
    }
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
    /// Frozen absolute expiry. Later process configuration cannot shorten an accepted claim.
    pub expires_at_ms: i64,
    /// Frozen member-attempt ceiling.
    pub max_member_attempts: u32,
    /// Frozen exponential backoff base in milliseconds.
    pub retry_backoff_base_ms: u64,
    /// Frozen exponential backoff ceiling in milliseconds.
    pub max_retry_backoff_ms: u64,
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
    /// The exact signed transaction may have reached the chain or a node's submission pool.
    /// Once true this evidence is monotonic and remains recipient-recoverable until acknowledgement.
    pub exposed: bool,
    /// Monotonic durable lease generation. Completion must present this exact token.
    pub lease_generation: u64,
    /// Unix millisecond deadline after which another reconciler may acquire a new generation.
    pub lease_until_ms: i64,
    /// Frozen-policy-derived earliest time another replay attempt may start.
    pub next_replay_at_ms: i64,
    /// Last transition time in Unix milliseconds.
    pub updated_at_ms: i64,
    /// Bounded diagnostic text.
    pub last_error: String,
}

/// How a pending-member completion changes the durable exposure flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExposureUpdate {
    /// Leave the flag as it is (ambiguous lookups, nothing learned about acceptance).
    Keep,
    /// The node accepted or shows the exact transaction.
    Set,
    /// The node definitively rejected this attempt's send and it was not exposed before.
    ClearRejected,
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
    /// A configured active-claim or reserved-recovery bound was reached before writing anything.
    AtCapacity,
    /// Capacity prevented migration, but the exact legacy row still durably owns these bytes.
    AtCapacityExactLegacy,
}

/// Coherent durable ownership classification for one candidate canonical request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MonadMessageOwnership {
    Missing,
    DeliveredExact(proto::StoredMonadMessage),
    OutboxExact(MonadOutboxRecord),
    LegacyExact(crate::store::monad_messages::MonadMessageAttemptPolicy),
    Conflict,
}

/// Result of a recipient-authenticated recovery acknowledgement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MonadRecoveryAck {
    Acknowledged,
    Absent,
    Active,
    WrongRecipient,
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
    /// Durable generation identity used to compare-and-delete an acknowledged obligation.
    pub obligation_id: [u8; 32],
    /// Exact canonical request reconstructed from the one outbox copy.
    pub message: proto::MonadStampedMessage,
    /// Confirmed members from child zero up to the first non-confirmed child.
    pub confirmed_prefix: Vec<MonadOutboxMember>,
    /// Aggregate state, including a terminal losing-transaction outcome when applicable.
    pub lifecycle: MonadOutboxLifecycle,
    /// Exact canonical bytes used to decode `message`, retained for in-memory integrity checks.
    pub(crate) canonical_message: Vec<u8>,
    /// Frozen recipient/economic policy used by in-memory recovery validation.
    pub(crate) policy: MonadOutboxPolicy,
    /// Members after the contiguous confirmed prefix, loaded once for full validation.
    pub(crate) remaining_members: Vec<MonadOutboxMember>,
}

/// One immutable, index/hash-validated view used throughout a reconciliation pass.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MonadOutboxSnapshot {
    pub(crate) record: MonadOutboxRecord,
    pub(crate) message: proto::MonadStampedMessage,
    pub(crate) members: Vec<MonadOutboxMember>,
}

/// Progress of one bounded database-wide chain-authority validation page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChainBindingProgress {
    Complete,
    More,
}

/// Work applied by one bounded startup lease-supersession page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StartupLeasePage {
    pub(crate) complete: bool,
    pub(crate) claims: usize,
    pub(crate) bytes: usize,
}

/// One scan-bounded page of recipient recovery facts in payload-hash order.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmedPrefixRecoveryPage {
    /// Eligible complete recovery records found within this scan window.
    pub recoveries: Vec<ConfirmedPrefixRecovery>,
    /// Last scanned payload hash when more recipient-index work remains.
    pub next_cursor: Option<[u8; 32]>,
    /// Recipient-index rows examined, bounded by the caller's scan limit.
    pub scanned: usize,
    /// Aggregate canonical protobuf bytes materialized for returned records.
    pub canonical_bytes: usize,
    /// Encoded outbox/member bytes physically fetched, including filtered rows and at most one
    /// bounded lookahead value that exceeded the requested work budget.
    pub inspected_bytes: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RecoveryQuotaUsage {
    records: u64,
    bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryFacts {
    None,
    Obligation,
}

#[derive(Deserialize)]
struct StoredEnvelopeRecipient {
    to: String,
}

impl RecoveryQuotaUsage {
    fn checked_add(self, bytes: u64) -> Result<Self> {
        Ok(Self {
            records: self.records.checked_add(1).ok_or_else(|| {
                CorruptRecord("recovery quota record counter overflowed".to_string())
            })?,
            bytes: self.bytes.checked_add(bytes).ok_or_else(|| {
                CorruptRecord("recovery quota byte counter overflowed".to_string())
            })?,
        })
    }

    fn checked_sub(self, bytes: u64) -> Result<Self> {
        Ok(Self {
            records: self.records.checked_sub(1).ok_or_else(|| {
                CorruptRecord("recovery quota record counter underflowed".to_string())
            })?,
            bytes: self.bytes.checked_sub(bytes).ok_or_else(|| {
                CorruptRecord("recovery quota byte counter underflowed".to_string())
            })?,
        })
    }
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
    /// The frozen compressed recipient key is not a valid secp256k1 public key.
    #[invalid_user_input()]
    #[error("Monad outbox recipient public key is invalid")]
    InvalidRecipientPublicKey,
    /// The frozen routing address is not owned by the frozen compressed recipient key.
    #[invalid_user_input()]
    #[error("Monad outbox recipient {claimed:?} differs from public-key address {derived:?}")]
    RecipientPublicKeyMismatch {
        /// Address supplied by the routing envelope.
        claimed: Address,
        /// Canonical Monad address derived from the compressed key.
        derived: Address,
    },
    /// A configured writer bound exceeds the corresponding durable decoder cap.
    #[invalid_user_input()]
    #[error("Monad outbox configured {field} limit {actual} exceeds codec cap {maximum}")]
    ConfiguredLimitExceedsCodec {
        /// Limit name.
        field: &'static str,
        /// Configured value.
        actual: usize,
        /// Hard decoder cap.
        maximum: usize,
    },
    /// A requested child is outside the canonical request.
    #[invalid_user_input()]
    #[error("Monad outbox child {0} does not exist")]
    MemberNotFound(u32),
    /// One complete recovery record cannot fit within the caller's bounded materialization.
    #[invalid_user_input()]
    #[error("Private Monad recovery record requires {required} bytes, page budget is {maximum}")]
    RecoveryRecordExceedsPageBudget {
        /// Canonical request bytes needed for the first record.
        required: usize,
        /// Requested bounded canonical byte budget.
        maximum: usize,
    },
    /// Database-owned encoding is malformed or internally inconsistent.
    #[critical()]
    #[error("Inconsistent Monad outbox database record: {0}")]
    CorruptRecord(String),
}

use self::DbMonadOutboxError::*;

/// Access to canonical outbox, child state, active claims, and recipient recovery index.
pub(crate) struct DbMonadOutbox<'a> {
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
    pub(crate) fn new(db: &'a Db) -> Self {
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

    fn append_outbox_put(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8],
        encoded: &[u8],
    ) {
        #[cfg(test)]
        {
            let (writes, bytes) = OUTBOX_CANONICAL_WRITE_WORK.get();
            OUTBOX_CANONICAL_WRITE_WORK.set((
                writes.saturating_add(1),
                bytes.saturating_add(encoded.len()),
            ));
        }
        batch.put_cf(self.cf_outbox, payload_hash, encoded);
    }

    fn migration_complete(
        &self,
        marker_key: &[u8],
        cursor_key: &[u8],
        cursor_state_key: &[u8],
        name: &str,
    ) -> Result<bool> {
        let Some(marker) = self.db.get(self.cf_meta, marker_key)? else {
            return Ok(false);
        };
        if !marker.is_empty()
            || self.db.get(self.cf_meta, cursor_key)?.is_some()
            || self.db.get(self.cf_meta, cursor_state_key)?.is_some()
        {
            return Err(CorruptRecord(format!(
                "{name} completion marker has incoherent migration state"
            ))
            .into());
        }
        Ok(true)
    }

    fn validated_outbox_migration_cursor(
        &self,
        cursor_key: &[u8],
        cursor_state_key: &[u8],
        name: &str,
    ) -> Result<Option<[u8; 32]>> {
        let cursor = self.db.get(self.cf_meta, cursor_key)?;
        let state = self.db.get(self.cf_meta, cursor_state_key)?;
        let (cursor, state) = match (cursor, state) {
            (Some(cursor), Some(state)) => (cursor, state),
            (None, None) => return Ok(None),
            _ => {
                return Err(CorruptRecord(format!(
                    "{name} cursor has no matching resumable state"
                ))
                .into());
            }
        };
        let cursor = checked_payload_hash(&cursor)
            .map_err(|_| CorruptRecord(format!("{name} cursor has invalid fixed-width shape")))?;
        if self.db.get(self.cf_outbox, cursor)?.is_none() {
            return Err(CorruptRecord(format!(
                "{name} cursor does not reference the next extant outbox row"
            ))
            .into());
        }
        if state.as_ref() != migration_cursor_state(name, &cursor) {
            return Err(CorruptRecord(format!(
                "{name} cursor differs from its atomic resumable state"
            ))
            .into());
        }
        Ok(Some(cursor))
    }

    /// Return one migration page and the still-unprocessed lookahead key. Persisting that key as
    /// the cursor makes progress independently verifiable: it is always an extant source row and
    /// is processed inclusively after restart.
    fn outbox_migration_page(
        &self,
        cursor: Option<[u8; 32]>,
    ) -> Result<(Vec<(Vec<u8>, Vec<u8>)>, Option<[u8; 32]>)> {
        let mode = cursor
            .as_ref()
            .map(|key| IteratorMode::From(key, Direction::Forward))
            .unwrap_or(IteratorMode::Start);
        let mut rows = Vec::with_capacity(MIGRATION_BATCH_SIZE + 1);
        for item in self.db.rocksdb().iterator_cf(self.cf_outbox, mode) {
            let (key, value) = item?;
            rows.push((key.to_vec(), value.to_vec()));
            if rows.len() == MIGRATION_BATCH_SIZE + 1 {
                break;
            }
        }
        let next_cursor = if rows.len() > MIGRATION_BATCH_SIZE {
            let (key, _) = rows.pop().expect("lookahead row exists");
            Some(checked_payload_hash(&key)?)
        } else {
            None
        };
        Ok((rows, next_cursor))
    }

    /// Upgrade legacy delivered ownership/cursors and index bounded legacy terminal history.
    /// Progress is committed with each bounded chunk, so a crash resumes after the last key
    /// without accumulating the whole outbox in memory.
    pub(crate) fn migrate_legacy_delivered_ownership(
        &self,
        limits: &MonadOutboxLimits,
    ) -> Result<()> {
        const MIGRATION_KEY: &[u8] = b"outbox-lifecycle-v3";
        const CURSOR_KEY: &[u8] = b"outbox-lifecycle-v3-cursor";
        const CURSOR_STATE_KEY: &[u8] = b"outbox-lifecycle-v3-cursor-state";
        if self.migration_complete(
            MIGRATION_KEY,
            CURSOR_KEY,
            CURSOR_STATE_KEY,
            "v3 outbox migration",
        )? {
            self.migrate_terminal_recovery_classification(limits)?;
            self.gc_history(unix_now_ms(), limits)?;
            return self.migrate_recovery_quota_accounting();
        }
        loop {
            let cursor = self.validated_outbox_migration_cursor(
                CURSOR_KEY,
                CURSOR_STATE_KEY,
                "v3 outbox migration",
            )?;
            let (rows, next_cursor) = self.outbox_migration_page(cursor)?;

            let _guard = self.db.lock_monad_outbox();
            let mut batch = rocksdb::WriteBatch::default();
            for (key, value) in &rows {
                let payload_hash = checked_payload_hash(key)?;
                let mut record = decode_record(value)?;
                if record.lifecycle == MonadOutboxLifecycle::Delivered
                    && record.canonical_message.is_some()
                {
                    let message = Self::canonical_message(&record)?;
                    let policy = active_policy(&record)?.clone();
                    let mut stored =
                        self.db
                            .monad_messages()
                            .get(&payload_hash)?
                            .ok_or_else(|| {
                                CorruptRecord("legacy delivered row has no inbox owner".to_string())
                            })?;
                    if stored.message.as_ref() != Some(&message) {
                        return Err(CorruptRecord(
                            "legacy delivered row differs from its inbox owner".to_string(),
                        )
                        .into());
                    }
                    if stored.timestamp != record.updated_at_ms {
                        stored.timestamp = record.updated_at_ms;
                        self.db.monad_messages().append_put_to_batch(
                            &mut batch,
                            &payload_hash,
                            &policy.recipient,
                            &stored,
                        )?;
                    }
                    record.canonical_message = None;
                    record.policy = None;
                    record.last_error.clear();
                    let encoded = encode_record(&record);
                    self.append_outbox_put(&mut batch, &payload_hash, &encoded);
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
                } else if matches!(record.lifecycle, MonadOutboxLifecycle::Terminal(_)) {
                    let has_evidence =
                        self.has_recovery_evidence_locked(&payload_hash, &record, None)?;
                    if has_evidence {
                        let policy = active_policy(&record)?;
                        batch.put_cf(
                            self.cf_recipient,
                            recipient_key(&policy.recipient, &payload_hash),
                            [],
                        );
                    } else {
                        if let Some(policy) = record.policy.as_ref() {
                            batch.delete_cf(
                                self.cf_recipient,
                                recipient_key(&policy.recipient, &payload_hash),
                            );
                        }
                        batch.put_cf(
                            self.cf_history,
                            history_key(record.updated_at_ms, &payload_hash),
                            self.retained_claim_bytes_locked(&payload_hash, &record, value.len())?
                                .to_be_bytes(),
                        );
                    }
                }
            }
            if let Some(next_cursor) = next_cursor {
                batch.put_cf(self.cf_meta, CURSOR_KEY, next_cursor);
                batch.put_cf(
                    self.cf_meta,
                    CURSOR_STATE_KEY,
                    migration_cursor_state("v3 outbox migration", &next_cursor),
                );
            } else {
                batch.put_cf(self.cf_meta, MIGRATION_KEY, []);
                batch.delete_cf(self.cf_meta, CURSOR_KEY);
                batch.delete_cf(self.cf_meta, CURSOR_STATE_KEY);
            }
            self.db.write_batch(batch)?;
            #[cfg(test)]
            if migration_failpoint_after_batch_before_gc() {
                return Err(CorruptRecord(
                    "test failpoint after migration history batch before GC".to_string(),
                )
                .into());
            }
            drop(_guard);
            self.gc_history(unix_now_ms(), limits)?;
            if next_cursor.is_none() {
                break;
            }
        }
        self.migrate_terminal_recovery_classification(limits)?;
        self.gc_history(unix_now_ms(), limits)?;
        self.migrate_recovery_quota_accounting()
    }

    fn migrate_terminal_recovery_classification(&self, limits: &MonadOutboxLimits) -> Result<()> {
        const MIGRATION_KEY: &[u8] = b"outbox-terminal-recovery-v4";
        const CURSOR_KEY: &[u8] = b"outbox-terminal-recovery-v4-cursor";
        const CURSOR_STATE_KEY: &[u8] = b"outbox-terminal-recovery-v4-cursor-state";
        if self.migration_complete(
            MIGRATION_KEY,
            CURSOR_KEY,
            CURSOR_STATE_KEY,
            "v4 outbox migration",
        )? {
            return Ok(());
        }
        loop {
            let cursor = self.validated_outbox_migration_cursor(
                CURSOR_KEY,
                CURSOR_STATE_KEY,
                "v4 outbox migration",
            )?;
            let (rows, next_cursor) = self.outbox_migration_page(cursor)?;

            let _guard = self.db.lock_monad_outbox();
            let mut batch = rocksdb::WriteBatch::default();
            for (key, encoded_record) in &rows {
                let payload_hash = checked_payload_hash(key)?;
                let record = decode_record(encoded_record)?;
                if matches!(record.lifecycle, MonadOutboxLifecycle::Terminal(_)) {
                    let has_evidence =
                        self.has_recovery_evidence_locked(&payload_hash, &record, None)?;
                    if has_evidence {
                        let policy = active_policy(&record)?;
                        batch.put_cf(
                            self.cf_recipient,
                            recipient_key(&policy.recipient, &payload_hash),
                            [],
                        );
                    } else {
                        if let Some(policy) = record.policy.as_ref() {
                            batch.delete_cf(
                                self.cf_recipient,
                                recipient_key(&policy.recipient, &payload_hash),
                            );
                        }
                        batch.put_cf(
                            self.cf_history,
                            history_key(record.updated_at_ms, &payload_hash),
                            self.retained_claim_bytes_locked(
                                &payload_hash,
                                &record,
                                encoded_record.len(),
                            )?
                            .to_be_bytes(),
                        );
                    }
                }
            }
            if let Some(next_cursor) = next_cursor {
                batch.put_cf(self.cf_meta, CURSOR_KEY, next_cursor);
                batch.put_cf(
                    self.cf_meta,
                    CURSOR_STATE_KEY,
                    migration_cursor_state("v4 outbox migration", &next_cursor),
                );
            } else {
                batch.put_cf(self.cf_meta, MIGRATION_KEY, []);
                batch.delete_cf(self.cf_meta, CURSOR_KEY);
                batch.delete_cf(self.cf_meta, CURSOR_STATE_KEY);
            }
            self.db.write_batch(batch)?;
            drop(_guard);
            self.gc_history(unix_now_ms(), limits)?;
            if next_cursor.is_none() {
                return Ok(());
            }
        }
    }

    /// Build durable recovery-reservation totals from pre-v5 rows in bounded, resumable pages.
    /// The page cursor and its counter increments share one write batch, so a crash can neither
    /// double-count nor skip a row when the database is reopened.
    fn migrate_recovery_quota_accounting(&self) -> Result<()> {
        if self.migration_complete(
            RECOVERY_QUOTA_MIGRATION_KEY,
            RECOVERY_QUOTA_CURSOR_KEY,
            RECOVERY_QUOTA_CURSOR_STATE_KEY,
            "v5 recovery quota migration",
        )? {
            self.read_required_quota_usage_locked(
                RECOVERY_QUOTA_GLOBAL_KEY,
                "global recovery quota counter",
            )?;
            return self.migrate_recovery_obligation_ids();
        }
        loop {
            let cursor = self.validated_outbox_migration_cursor(
                RECOVERY_QUOTA_CURSOR_KEY,
                RECOVERY_QUOTA_CURSOR_STATE_KEY,
                "v5 recovery quota migration",
            )?;
            let global_exists = self
                .db
                .get(self.cf_meta, RECOVERY_QUOTA_GLOBAL_KEY)?
                .is_some();
            if cursor.is_some() != global_exists {
                return Err(CorruptRecord(
                    "v5 recovery quota migration cursor/counter state is incoherent".to_string(),
                )
                .into());
            }
            let (rows, next_cursor) = self.outbox_migration_page(cursor)?;
            let _guard = self.db.lock_monad_outbox();
            let mut global = if cursor.is_some() {
                self.read_required_quota_usage_locked(
                    RECOVERY_QUOTA_GLOBAL_KEY,
                    "global recovery quota counter",
                )?
            } else {
                RecoveryQuotaUsage::default()
            };
            let mut recipients = Vec::<(Address, RecoveryQuotaUsage)>::new();
            let mut reservations = Vec::<([u8; 32], Address, u64)>::new();
            for (key, encoded_record) in &rows {
                let payload_hash = checked_payload_hash(key)?;
                let record = decode_record(encoded_record)?;
                let Some(policy) = record.policy.as_ref() else {
                    if record.canonical_message.is_none()
                        && record.lifecycle == MonadOutboxLifecycle::Delivered
                    {
                        continue;
                    }
                    return Err(CorruptRecord(
                        "owned canonical row has no frozen policy".to_string(),
                    )
                    .into());
                };
                if record.canonical_message.is_none() {
                    return Err(CorruptRecord(
                        "owned outbox policy has no canonical message".to_string(),
                    )
                    .into());
                }
                let retained = match record.lifecycle {
                    MonadOutboxLifecycle::Delivered => {
                        return Err(CorruptRecord(
                            "delivered canonical owner was not compacted".to_string(),
                        )
                        .into())
                    }
                    MonadOutboxLifecycle::Terminal(_)
                        if self.recovery_facts_locked(&payload_hash, &record)?
                            == RecoveryFacts::None =>
                    {
                        continue
                    }
                    _ => self.recovery_reserved_claim_bytes_locked(&payload_hash, &record)?,
                };
                global = global.checked_add(retained)?;
                reservations.push((payload_hash, policy.recipient, retained));
                let recipient_position = recipients
                    .iter()
                    .position(|(recipient, _)| *recipient == policy.recipient);
                let recipient_position = match recipient_position {
                    Some(position) => position,
                    None => {
                        recipients.push((
                            policy.recipient,
                            self.read_recipient_quota_usage_for_reserve_locked(&policy.recipient)?,
                        ));
                        recipients.len() - 1
                    }
                };
                let usage = &mut recipients[recipient_position].1;
                *usage = usage.checked_add(retained)?;
            }
            let mut batch = rocksdb::WriteBatch::default();
            batch.put_cf(
                self.cf_meta,
                RECOVERY_QUOTA_GLOBAL_KEY,
                encode_quota_usage(global),
            );
            for (recipient, usage) in recipients {
                batch.put_cf(
                    self.cf_meta,
                    recovery_quota_recipient_key(&recipient),
                    encode_quota_usage(usage),
                );
            }
            for (payload_hash, recipient, retained) in reservations {
                batch.put_cf(
                    self.cf_meta,
                    recovery_quota_record_key(&payload_hash),
                    retained.to_be_bytes(),
                );
                batch.put_cf(
                    self.cf_meta,
                    recovery_quota_owner_key(&recipient, &payload_hash),
                    [],
                );
            }
            if let Some(next_cursor) = next_cursor {
                batch.put_cf(self.cf_meta, RECOVERY_QUOTA_CURSOR_KEY, next_cursor);
                batch.put_cf(
                    self.cf_meta,
                    RECOVERY_QUOTA_CURSOR_STATE_KEY,
                    migration_cursor_state("v5 recovery quota migration", &next_cursor),
                );
            } else {
                batch.put_cf(self.cf_meta, RECOVERY_QUOTA_MIGRATION_KEY, []);
                batch.delete_cf(self.cf_meta, RECOVERY_QUOTA_CURSOR_KEY);
                batch.delete_cf(self.cf_meta, RECOVERY_QUOTA_CURSOR_STATE_KEY);
            }
            self.db.write_batch(batch)?;
            if next_cursor.is_none() {
                // The chained migration takes the same non-reentrant lock.
                drop(_guard);
                return self.migrate_recovery_obligation_ids();
            }
        }
    }

    /// Backfill a durable acknowledgement generation for preexisting quota-owned claims.
    /// The deterministic legacy value is written once; every newly admitted claim receives fresh
    /// randomness, so an unused signed acknowledgement can never cross a delete/re-admit ABA.
    fn migrate_recovery_obligation_ids(&self) -> Result<()> {
        if self.migration_complete(
            RECOVERY_OBLIGATION_MIGRATION_KEY,
            RECOVERY_OBLIGATION_CURSOR_KEY,
            RECOVERY_OBLIGATION_CURSOR_STATE_KEY,
            "recovery obligation identity migration",
        )? {
            return Ok(());
        }
        loop {
            let cursor = self.validated_outbox_migration_cursor(
                RECOVERY_OBLIGATION_CURSOR_KEY,
                RECOVERY_OBLIGATION_CURSOR_STATE_KEY,
                "recovery obligation identity migration",
            )?;
            let (rows, next_cursor) = self.outbox_migration_page(cursor)?;
            let _guard = self.db.lock_monad_outbox();
            let mut batch = rocksdb::WriteBatch::default();
            for (key, encoded_record) in &rows {
                let payload_hash = checked_payload_hash(key)?;
                let record = decode_record(encoded_record)?;
                if self
                    .db
                    .get(self.cf_meta, recovery_quota_record_key(&payload_hash))?
                    .is_none()
                {
                    continue;
                }
                if self.has_recovery_evidence_locked(&payload_hash, &record, None)? {
                    let policy = active_policy(&record)?;
                    batch.put_cf(
                        self.cf_recipient,
                        recipient_key(&policy.recipient, &payload_hash),
                        [],
                    );
                }
                let obligation_key = recovery_obligation_id_key(&payload_hash);
                if let Some(existing) = self.db.get(self.cf_meta, &obligation_key)? {
                    checked_payload_hash(&existing).map_err(|_| {
                        CorruptRecord(
                            "recovery obligation identity has invalid fixed-width shape"
                                .to_string(),
                        )
                    })?;
                    continue;
                }
                let canonical = record.canonical_message.as_deref().ok_or_else(|| {
                    CorruptRecord(
                        "quota-owned outbox row has no canonical recovery bytes".to_string(),
                    )
                })?;
                let mut preimage = Vec::with_capacity(64 + canonical.len());
                preimage.extend_from_slice(b"frank:legacy-recovery-obligation:v1");
                preimage.extend_from_slice(&payload_hash);
                preimage.extend_from_slice(&record.created_at_ms.to_be_bytes());
                preimage.extend_from_slice(canonical);
                let id = Sha256::digest(preimage.into());
                batch.put_cf(self.cf_meta, obligation_key, id.as_slice());
            }
            if let Some(next_cursor) = next_cursor {
                batch.put_cf(self.cf_meta, RECOVERY_OBLIGATION_CURSOR_KEY, next_cursor);
                batch.put_cf(
                    self.cf_meta,
                    RECOVERY_OBLIGATION_CURSOR_STATE_KEY,
                    migration_cursor_state("recovery obligation identity migration", &next_cursor),
                );
            } else {
                batch.put_cf(self.cf_meta, RECOVERY_OBLIGATION_MIGRATION_KEY, []);
                batch.delete_cf(self.cf_meta, RECOVERY_OBLIGATION_CURSOR_KEY);
                batch.delete_cf(self.cf_meta, RECOVERY_OBLIGATION_CURSOR_STATE_KEY);
            }
            self.db.write_batch(batch)?;
            if next_cursor.is_none() {
                return Ok(());
            }
        }
    }

    /// Classify inbox, outbox (including compact Delivered), and legacy ownership under the one
    /// outbox serialization lock so callers never infer absence from torn cross-CF reads.
    pub(crate) fn classify_ownership(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<MonadMessageOwnership> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let canonical = message.encode_to_vec();
        let _guard = self.db.lock_monad_outbox();
        let inbox = self.db.monad_messages().get(&payload_hash)?;
        let outbox = self.get(&payload_hash)?;
        let legacy = self
            .db
            .monad_messages()
            .get_attempt(&payload_hash, message)?;
        let legacy_conflicts = matches!(
            legacy,
            crate::store::monad_messages::MonadMessageAttemptClaim::Conflict
        );
        if let Some(stored) = inbox {
            if stored.message.as_ref() != Some(message) || legacy_conflicts {
                return Ok(MonadMessageOwnership::Conflict);
            }
            if let Some(record) = outbox {
                match record.canonical_message.as_deref() {
                    Some(owned) if owned != canonical => {
                        return Ok(MonadMessageOwnership::Conflict)
                    }
                    None if record.lifecycle != MonadOutboxLifecycle::Delivered => {
                        return Err(CorruptRecord(
                            "canonical-less outbox owner is not delivered".to_string(),
                        )
                        .into())
                    }
                    _ => {}
                }
            }
            return Ok(MonadMessageOwnership::DeliveredExact(stored));
        }
        if let Some(record) = outbox {
            let Some(owned) = record.canonical_message.as_deref() else {
                return Err(
                    CorruptRecord("compact delivered owner has no inbox row".to_string()).into(),
                );
            };
            return Ok(if owned == canonical && !legacy_conflicts {
                MonadMessageOwnership::OutboxExact(record)
            } else {
                MonadMessageOwnership::Conflict
            });
        }
        Ok(match legacy {
            crate::store::monad_messages::MonadMessageAttemptClaim::ExistingExact(policy) => {
                MonadMessageOwnership::LegacyExact(policy)
            }
            crate::store::monad_messages::MonadMessageAttemptClaim::Conflict => {
                MonadMessageOwnership::Conflict
            }
            crate::store::monad_messages::MonadMessageAttemptClaim::Missing => {
                MonadMessageOwnership::Missing
            }
            crate::store::monad_messages::MonadMessageAttemptClaim::New => unreachable!(),
        })
    }

    /// Create the canonical row and all child references atomically, or classify an exact retry.
    pub(crate) fn claim(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
        policy: &MonadOutboxPolicy,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxClaim> {
        self.claim_with_external_usage(
            payload_hash,
            message,
            policy,
            now_ms,
            limits,
            Ok(crate::monad_outbox::financial::AdmissionUsage::default()),
        )
    }

    /// Production admission holds the private shared gate while taking the external
    /// snapshot, then releases that store lock before entering this original lock.
    pub(crate) fn claim_with_external_usage(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
        policy: &MonadOutboxPolicy,
        now_ms: i64,
        limits: &MonadOutboxLimits,
        external: Result<crate::monad_outbox::financial::AdmissionUsage>,
    ) -> Result<MonadOutboxClaim> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let canonical_message = message.encode_to_vec();
        validate_limits(limits)?;
        policy.validate_recipient_authority()?;
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
                    expires_at_ms: stored.timestamp,
                    max_member_attempts: 0,
                    retry_backoff_base_ms: 0,
                    max_retry_backoff_ms: 0,
                    lifecycle: MonadOutboxLifecycle::Delivered,
                    reconciliation_attempts: 0,
                    last_error: String::new(),
                })
            } else {
                MonadOutboxClaim::Conflict
            });
        }
        let (policy, adopted_legacy) = match self
            .db
            .monad_messages()
            .get_attempt(&payload_hash, message)?
        {
            crate::store::monad_messages::MonadMessageAttemptClaim::Missing => {
                (policy.clone(), false)
            }
            crate::store::monad_messages::MonadMessageAttemptClaim::ExistingExact(legacy) => (
                MonadOutboxPolicy::new(
                    policy.recipient,
                    legacy.recipient_pubkey,
                    legacy.min_value_wei,
                    legacy
                        .network_tag
                        .unwrap_or_else(|| policy.network_tag.clone()),
                )?,
                true,
            ),
            crate::store::monad_messages::MonadMessageAttemptClaim::Conflict
            | crate::store::monad_messages::MonadMessageAttemptClaim::New => {
                return Ok(MonadOutboxClaim::Conflict)
            }
        };
        // The predecessor already durably admitted this exact set. A later operator decrease is
        // admission policy for new sets, while the stable codec bound still limits adoption.
        validate_claim(
            &payload_hash,
            message,
            &canonical_message,
            &policy,
            limits,
            adopted_legacy,
        )?;
        let external = external?;
        if (self.active_count_up_to(limits.max_active_claims)? as u64)
            .checked_add(external.active)
            .is_none_or(|n| n >= limits.max_active_claims as u64)
        {
            return Ok(if adopted_legacy {
                MonadOutboxClaim::AtCapacityExactLegacy
            } else {
                MonadOutboxClaim::AtCapacity
            });
        }

        let record = MonadOutboxRecord {
            canonical_message: Some(canonical_message),
            policy: Some(policy.clone()),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(duration_ms_i64(limits.max_claim_age)),
            max_member_attempts: limits.max_member_attempts,
            retry_backoff_base_ms: duration_ms_u64(limits.retry_backoff_base),
            max_retry_backoff_ms: duration_ms_u64(limits.max_retry_backoff),
            lifecycle: MonadOutboxLifecycle::Pending,
            reconciliation_attempts: 0,
            last_error: String::new(),
        };
        let encoded_record = encode_record(&record);
        let members = message
            .stamp_payments
            .iter()
            .map(|payment| {
                let member = MonadOutboxMember {
                    child_index: payment.child_index,
                    tx_hash: Hash32(Keccak256::digest(&payment.raw_tx).into()),
                    state: MonadOutboxMemberState::Pending,
                    attempts: 0,
                    exposed: false,
                    lease_generation: 0,
                    lease_until_ms: 0,
                    next_replay_at_ms: now_ms,
                    updated_at_ms: now_ms,
                    last_error: String::new(),
                };
                (payment.child_index, encode_member(&member))
            })
            .collect::<Vec<_>>();
        let reservation_bytes = encoded_record
            .len()
            .saturating_add(
                members
                    .iter()
                    .map(|(_, encoded)| encoded.len())
                    .sum::<usize>(),
            )
            .saturating_add(
                members
                    .len()
                    .saturating_add(1)
                    .saturating_mul(MAX_LAST_ERROR_BYTES_HARD),
            );
        if !self.recovery_reservation_available_locked(
            &policy.recipient,
            reservation_bytes,
            limits,
            &external,
        )? || self
            .read_unconfirmed_count_locked(&policy.recipient)?
            .checked_add(external.unconfirmed)
            .is_none_or(|n| n >= limits.max_unconfirmed_claims_per_recipient as u64)
        {
            return Ok(if adopted_legacy {
                MonadOutboxClaim::AtCapacityExactLegacy
            } else {
                MonadOutboxClaim::AtCapacity
            });
        }
        let mut batch = rocksdb::WriteBatch::default();
        self.append_quota_reserve_locked(
            &mut batch,
            &payload_hash,
            &policy.recipient,
            reservation_bytes as u64,
        )?;
        self.append_unconfirmed_mark_locked(&mut batch, &payload_hash, &policy.recipient)?;
        self.append_outbox_put(&mut batch, &payload_hash, &encoded_record);
        batch.put_cf(self.cf_active, payload_hash, now_ms.to_be_bytes());
        for (child_index, encoded_member) in members {
            batch.put_cf(
                self.cf_members,
                member_key(&payload_hash, child_index),
                encoded_member,
            );
        }
        if adopted_legacy {
            self.db
                .monad_messages()
                .append_delete_attempt_to_batch(&mut batch, &payload_hash);
        }
        self.db.write_batch(batch)?;
        Ok(MonadOutboxClaim::New)
    }

    /// Read a canonical record by payload hash.
    pub(crate) fn get(&self, payload_hash: &[u8]) -> Result<Option<MonadOutboxRecord>> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        self.db
            .get(self.cf_outbox, payload_hash)?
            .map(|bytes| decode_record(&bytes))
            .transpose()
    }

    #[cfg(test)]
    pub(crate) fn replace_canonical_for_test(
        &self,
        payload_hash: &[u8],
        message: &proto::MonadStampedMessage,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("test outbox row is missing".to_string()))?;
        record.canonical_message = Some(message.encode_to_vec());
        self.db
            .put(self.cf_outbox, &payload_hash, encode_record(&record))
    }

    #[cfg(test)]
    pub(crate) fn replace_lifecycle_for_test(
        &self,
        payload_hash: &[u8],
        lifecycle: MonadOutboxLifecycle,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("test outbox row is missing".to_string()))?;
        record.lifecycle = lifecycle;
        self.db
            .put(self.cf_outbox, &payload_hash, encode_record(&record))
    }

    #[cfg(test)]
    pub(crate) fn replace_minimum_for_test(
        &self,
        payload_hash: &[u8],
        min_value_wei: u128,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("test outbox row is missing".to_string()))?;
        active_policy(&record)?;
        record.policy.as_mut().expect("checked above").min_value_wei = min_value_wei;
        self.db
            .put(self.cf_outbox, &payload_hash, encode_record(&record))
    }

    #[cfg(test)]
    pub(crate) fn replace_recipient_for_test(
        &self,
        payload_hash: &[u8],
        recipient: Address,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("test outbox row is missing".to_string()))?;
        active_policy(&record)?;
        record.policy.as_mut().expect("checked above").recipient = recipient;
        self.db
            .put(self.cf_outbox, &payload_hash, encode_record(&record))
    }

    /// Decode the canonical request owned by an outbox record.
    pub(crate) fn canonical_message(
        record: &MonadOutboxRecord,
    ) -> Result<proto::MonadStampedMessage> {
        let canonical = record.canonical_message.as_deref().ok_or_else(|| {
            CorruptRecord("compact outbox tombstone has no canonical message".to_string())
        })?;
        proto::MonadStampedMessage::decode(canonical)
            .wrap_err_with(|| CorruptRecord("canonical message protobuf cannot decode".to_string()))
    }

    /// Read and integrity-check one child reference against the canonical request.
    pub(crate) fn get_member(
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

    #[cfg(test)]
    /// Return canonical raw bytes only after the member's index/hash reference verifies.
    pub(crate) fn referenced_raw_tx(
        &self,
        payload_hash: &[u8],
        child_index: u32,
    ) -> Result<(MonadOutboxRecord, MonadOutboxMember, Vec<u8>)> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
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

    /// Load and validate the canonical owner and every member exactly once under one snapshot
    /// lock. Later lease acquisition remains the fresh authority for each asynchronous action.
    pub(crate) fn reconciliation_snapshot(
        &self,
        payload_hash: &[u8],
    ) -> Result<Option<MonadOutboxSnapshot>> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let Some(record) = self.get(&payload_hash)? else {
            return Ok(None);
        };
        if record.lifecycle == MonadOutboxLifecycle::Delivered {
            return Ok(Some(MonadOutboxSnapshot {
                record,
                message: proto::MonadStampedMessage::default(),
                members: Vec::new(),
            }));
        }
        note_reconciliation_snapshot_decode();
        let message = Self::canonical_message(&record)?;
        let mut members = Vec::with_capacity(message.stamp_payments.len());
        for (position, payment) in message.stamp_payments.iter().enumerate() {
            if payment.child_index as usize != position {
                return Err(CorruptRecord(format!(
                    "canonical child at position {position} has index {}",
                    payment.child_index
                ))
                .into());
            }
            let member = self
                .get_member(&payload_hash, payment.child_index)?
                .ok_or_else(|| {
                    CorruptRecord(format!("missing child row {}", payment.child_index))
                })?;
            note_reconciliation_snapshot_member_decode();
            let actual_hash = Hash32(Keccak256::digest(&payment.raw_tx).into());
            if member.child_index != payment.child_index || member.tx_hash != actual_hash {
                return Err(CorruptRecord(format!(
                    "child {} index/hash reference mismatch",
                    payment.child_index
                ))
                .into());
            }
            members.push(member);
        }
        Ok(Some(MonadOutboxSnapshot {
            record,
            message,
            members,
        }))
    }

    #[cfg(test)]
    /// Enumerate at most `limit` nonterminal claims. The active index prevents a full DB scan.
    pub(crate) fn list_active(&self, limit: usize) -> Result<Vec<[u8; 32]>> {
        self.list_active_after(None, limit)
    }

    /// Enumerate one strictly-forward page of nonterminal claims. Pagination is independent of
    /// the current admission ceiling so lowering that ceiling cannot strand older durable work.
    pub(crate) fn list_active_after(
        &self,
        after: Option<[u8; 32]>,
        limit: usize,
    ) -> Result<Vec<[u8; 32]>> {
        let mut active = Vec::new();
        let mode = after
            .as_ref()
            .map(|key| IteratorMode::From(key, Direction::Forward))
            .unwrap_or(IteratorMode::Start);
        for item in self.db.rocksdb().iterator_cf(self.cf_active, mode) {
            let (key, _) = item?;
            let payload_hash = checked_payload_hash(&key)?;
            if after == Some(payload_hash) {
                continue;
            }
            active.push(payload_hash);
            if active.len() == limit {
                break;
            }
        }
        Ok(active)
    }

    /// Validate one bounded page of every durable canonical owner before startup is allowed to
    /// mutate claims. A persisted pending chain ID prevents a restart with another configuration
    /// from resuming a partially validated cursor under different authority.
    pub(crate) fn bind_chain_page(
        &self,
        expected_chain_id: u64,
        max_rows: usize,
        max_bytes: usize,
    ) -> Result<ChainBindingProgress> {
        let _guard = self.db.lock_monad_outbox();
        if let Some(encoded) = self.db.get(self.cf_meta, CHAIN_BINDING_KEY)? {
            let actual = decode_u64_meta(&encoded, "chain binding")?;
            if actual != expected_chain_id {
                return Err(CorruptRecord(format!(
                    "Monad outbox is bound to chain {actual}, configured chain is {expected_chain_id}"
                ))
                .into());
            }
            return Ok(ChainBindingProgress::Complete);
        }
        if let Some(encoded) = self.db.get(self.cf_meta, CHAIN_BINDING_PENDING_KEY)? {
            let pending = decode_u64_meta(&encoded, "pending chain binding")?;
            if pending != expected_chain_id {
                return Err(CorruptRecord(format!(
                    "Monad outbox chain migration is bound to chain {pending}, configured chain is {expected_chain_id}"
                ))
                .into());
            }
        }

        let cursor = self.db.get(self.cf_meta, CHAIN_BINDING_CURSOR_KEY)?;
        let (phase, after) = match cursor.as_deref() {
            None => (CHAIN_SCAN_OUTBOX, None),
            Some([phase, rest @ ..])
                if (*phase == CHAIN_SCAN_OUTBOX || *phase == CHAIN_SCAN_INBOX)
                    && (rest.is_empty() || rest.len() == PAYLOAD_HASH_LEN) =>
            {
                (*phase, (!rest.is_empty()).then_some(rest))
            }
            Some(_) => {
                return Err(CorruptRecord(
                    "Monad outbox chain migration cursor is malformed".to_string(),
                )
                .into())
            }
        };
        let mode = after
            .map(|key| IteratorMode::From(key, Direction::Forward))
            .unwrap_or(IteratorMode::Start);
        let mut rows = Vec::<(Vec<u8>, proto::MonadStampedMessage)>::new();
        let mut inspected_bytes = 0usize;
        let row_limit = max_rows.max(1);
        let byte_limit = max_bytes.max(1);
        let cf = if phase == CHAIN_SCAN_OUTBOX {
            self.cf_outbox
        } else {
            self.db.cf(CF_MONAD_MESSAGES)?
        };
        for item in self.db.rocksdb().iterator_cf(cf, mode) {
            let (key, value) = item?;
            if after == Some(key.as_ref()) {
                continue;
            }
            let payload_hash = checked_payload_hash(&key)?;
            let (message, row_bytes) = if phase == CHAIN_SCAN_OUTBOX {
                let record = decode_record(&value)?;
                if record.canonical_message.is_some() {
                    (Self::canonical_message(&record)?, value.len())
                } else {
                    if record.lifecycle != MonadOutboxLifecycle::Delivered {
                        return Err(CorruptRecord(
                            "canonical-less outbox owner is not delivered".to_string(),
                        )
                        .into());
                    }
                    let stored = self
                        .db
                        .monad_messages()
                        .get(&payload_hash)?
                        .ok_or_else(|| {
                            CorruptRecord("compact delivered row has no inbox owner".to_string())
                        })?;
                    let stored_len = stored.encoded_len();
                    let message = stored.message.ok_or_else(|| {
                        CorruptRecord("delivered inbox owner has no canonical message".to_string())
                    })?;
                    (message, value.len().saturating_add(stored_len))
                }
            } else {
                let stored =
                    proto::StoredMonadMessage::decode(value.as_ref()).wrap_err_with(|| {
                        CorruptRecord("delivered inbox owner cannot decode".to_string())
                    })?;
                let message = stored.message.ok_or_else(|| {
                    CorruptRecord("delivered inbox owner has no canonical message".to_string())
                })?;
                (message, value.len())
            };
            if message.payload_hash.as_slice() != payload_hash {
                return Err(CorruptRecord(
                    "durable canonical owner differs from its payload-hash key".to_string(),
                )
                .into());
            }
            let next_bytes = inspected_bytes.saturating_add(row_bytes);
            if !rows.is_empty() && (rows.len() == row_limit || next_bytes > byte_limit) {
                break;
            }
            inspected_bytes = next_bytes;
            rows.push((key.to_vec(), message));
            if rows.len() == row_limit {
                break;
            }
        }
        if rows.is_empty() {
            if phase == CHAIN_SCAN_OUTBOX {
                let mut batch = rocksdb::WriteBatch::default();
                batch.put_cf(self.cf_meta, CHAIN_BINDING_CURSOR_KEY, [CHAIN_SCAN_INBOX]);
                self.db.write_batch(batch)?;
                return Ok(ChainBindingProgress::More);
            }
            if self
                .db
                .get(self.cf_meta, CHAIN_BINDING_PENDING_KEY)?
                .is_none()
                && self
                    .db
                    .rocksdb()
                    .iterator_cf(self.db.cf(CF_MONAD_MESSAGE_ATTEMPTS)?, IteratorMode::Start)
                    .next()
                    .transpose()?
                    .is_some()
            {
                // Digest-only predecessor attempts contain no canonical signed bytes from which
                // a chain can be derived. Leave the database unbound until exact adoption (which
                // validates the candidate chain before mutation) materializes an outbox owner.
                let mut batch = rocksdb::WriteBatch::default();
                batch.delete_cf(self.cf_meta, CHAIN_BINDING_CURSOR_KEY);
                self.db.write_batch(batch)?;
                return Ok(ChainBindingProgress::Complete);
            }
            let quarantined = legacy_chain_quarantined_total();
            if quarantined > 0 {
                tracing::event!(
                    tracing::Level::WARN,
                    quarantined,
                    "Monad chain binding completed with stored payments lacking a usable chain ID"
                );
            }
            let mut batch = rocksdb::WriteBatch::default();
            batch.put_cf(
                self.cf_meta,
                CHAIN_BINDING_KEY,
                expected_chain_id.to_be_bytes(),
            );
            batch.delete_cf(self.cf_meta, CHAIN_BINDING_PENDING_KEY);
            batch.delete_cf(self.cf_meta, CHAIN_BINDING_CURSOR_KEY);
            self.db.write_batch(batch)?;
            return Ok(ChainBindingProgress::Complete);
        }

        for (key, message) in &rows {
            for payment in &message.stamp_payments {
                // Rows written before chain binding existed may hold payments with no usable
                // chain identity (pre-EIP-155 signatures, or bytes this decoder no longer
                // accepts). They carry no evidence about which chain the database serves, so they
                // are quarantined (skipped, logged, counted) instead of failing the whole open.
                // A payment that *does* name a different chain is real evidence of a wrong
                // runtime configuration and remains fatal.
                let chain_id = match decode_signed_transaction(&payment.raw_tx) {
                    Ok(decoded) => decoded.chain_id,
                    Err(err) => {
                        note_legacy_chain_quarantine(key, payment.child_index, &err.to_string());
                        continue;
                    }
                };
                match chain_id {
                    Some(actual) if actual == expected_chain_id => {}
                    Some(actual) => {
                        return Err(CorruptRecord(format!(
                            "durable payment chain ID {actual} differs from configured {expected_chain_id}"
                        ))
                        .into())
                    }
                    None => note_legacy_chain_quarantine(
                        key,
                        payment.child_index,
                        "payment has no chain ID",
                    ),
                }
            }
        }
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(
            self.cf_meta,
            CHAIN_BINDING_PENDING_KEY,
            expected_chain_id.to_be_bytes(),
        );
        batch.put_cf(
            self.cf_meta,
            CHAIN_BINDING_CURSOR_KEY,
            [phase]
                .into_iter()
                .chain(rows.last().expect("page is nonempty").0.iter().copied())
                .collect::<Vec<_>>(),
        );
        self.db.write_batch(batch)?;
        Ok(ChainBindingProgress::More)
    }

    /// Supersede leases left by a prior process before startup readiness reconciliation.
    ///
    /// RocksDB's exclusive process lock establishes that no prior writer is still live. Clearing
    /// only the lease deadline lets the next acquire increment the durable generation, so a stale
    /// completion can never satisfy the new owner token.
    pub(crate) fn supersede_startup_leases_page(
        &self,
        now_ms: i64,
        max_claims: usize,
        max_bytes: usize,
    ) -> Result<StartupLeasePage> {
        let _guard = self.db.lock_monad_outbox();
        let cursor = self.db.get(self.cf_meta, STARTUP_LEASE_CURSOR_KEY)?;
        let mode = cursor
            .as_deref()
            .map(|key| IteratorMode::From(key, Direction::Forward))
            .unwrap_or(IteratorMode::Start);
        let mut staged = Vec::new();
        let mut inspected_bytes = 0usize;
        let claim_limit = max_claims.max(1);
        let byte_limit = max_bytes.max(1);
        for item in self.db.rocksdb().iterator_cf(self.cf_active, mode) {
            let (key, _) = item?;
            if cursor.as_deref() == Some(key.as_ref()) {
                continue;
            }
            let payload_hash = checked_payload_hash(&key)?;
            let record = self.get(&payload_hash)?.ok_or_else(|| {
                CorruptRecord("active lease references missing outbox".to_string())
            })?;
            let encoded_record_len = encode_record(&record).len();
            let mut member_updates = Vec::new();
            let mut claim_bytes = encoded_record_len;
            if matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
                let message = Self::canonical_message(&record)?;
                for payment in message.stamp_payments {
                    let mut member = self
                        .get_member(&payload_hash, payment.child_index)?
                        .ok_or_else(|| {
                            CorruptRecord("active lease member is missing".to_string())
                        })?;
                    let encoded_before = encode_member(&member);
                    claim_bytes = claim_bytes.saturating_add(encoded_before.len());
                    if matches!(member.state, MonadOutboxMemberState::Pending)
                        && member.lease_until_ms > 0
                    {
                        member.lease_until_ms = 0;
                        member.updated_at_ms = now_ms;
                        member_updates.push((payment.child_index, encode_member(&member)));
                    }
                }
            }
            if !staged.is_empty()
                && (staged.len() == claim_limit
                    || inspected_bytes.saturating_add(claim_bytes) > byte_limit)
            {
                break;
            }
            inspected_bytes = inspected_bytes.saturating_add(claim_bytes);
            staged.push((payload_hash, record, member_updates));
            if staged.len() == claim_limit {
                break;
            }
        }
        if staged.is_empty() {
            let mut batch = rocksdb::WriteBatch::default();
            batch.delete_cf(self.cf_meta, STARTUP_LEASE_CURSOR_KEY);
            self.db.write_batch(batch)?;
            return Ok(StartupLeasePage {
                complete: true,
                claims: 0,
                bytes: 0,
            });
        }
        let mut batch = rocksdb::WriteBatch::default();
        for (payload_hash, _record, member_updates) in &staged {
            for (child_index, encoded) in member_updates {
                batch.put_cf(
                    self.cf_members,
                    member_key(payload_hash, *child_index),
                    encoded,
                );
            }
        }
        batch.put_cf(
            self.cf_meta,
            STARTUP_LEASE_CURSOR_KEY,
            staged.last().expect("page is nonempty").0,
        );
        self.db.write_batch(batch)?;
        Ok(StartupLeasePage {
            complete: false,
            claims: staged.len(),
            bytes: inspected_bytes,
        })
    }

    /// Atomically acquire the generation that owns one exact lookup and any resulting replay.
    /// No replay attempt/age budget is charged until [`Self::begin_replay_attempt`].
    pub(crate) fn acquire_reconcile_lease(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxLeaseAcquire> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let record = self
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
        let mut batch = rocksdb::WriteBatch::default();
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
    pub(crate) fn begin_replay_attempt(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxReplayStart> {
        validate_limits(limits)?;
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
        if now_ms < member.next_replay_at_ms {
            return Ok(MonadOutboxReplayStart::Stale);
        }
        let terminal = if now_ms > claim_expiry_ms(&record, child_index > 0, limits) {
            Some((MonadOutboxTerminal::Expired, "claim age limit exceeded"))
        } else if member.attempts >= record.max_member_attempts {
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
        // The attempt is charged durably before the send so a crash cannot grant free replays.
        // The same batch marks the member as possibly exposed (and writes the recipient index):
        // once the send starts, a timeout, transport error, lost response, crash or cancellation
        // leaves it unknown whether the node accepted the transaction, and a later mine must stay
        // recoverable. Only a DEFINITIVE node rejection clears the marker again
        // (`complete_rejected_member`), so unfunded payments still never pin recovery quota.
        member.attempts += 1;
        member.exposed = true;
        member.updated_at_ms = now_ms;
        member.last_error.clear();
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        if child_index == 0 {
            batch.put_cf(
                self.cf_recipient,
                recipient_key(&active_policy(&record)?.recipient, &payload_hash),
                [],
            );
        }
        self.db.write_batch(batch)?;
        Ok(MonadOutboxReplayStart::Started(member))
    }

    /// Release a scan lease without changing retry timing (used when backoff still applies).
    pub(crate) fn release_reconcile_lease(
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
    pub(crate) fn confirm_observed_member(
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
    pub(crate) fn complete_confirmed_member(
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
        let record = self
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
        for prior_index in 0..child_index {
            let prior = self
                .get_member(&payload_hash, prior_index)?
                .ok_or(MemberNotFound(prior_index))?;
            if !matches!(prior.state, MonadOutboxMemberState::Confirmed { .. }) {
                return Ok(MonadOutboxTransition::Stale);
            }
        }
        member.state = MonadOutboxMemberState::Confirmed {
            value_wei,
            block_number,
        };
        member.lease_until_ms = 0;
        member.updated_at_ms = now_ms;
        member.last_error.clear();
        let mut batch = rocksdb::WriteBatch::default();
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
        if child_index == 0 {
            self.append_unconfirmed_clear_locked(
                &mut batch,
                &payload_hash,
                &active_policy(&record)?.recipient,
            )?;
        }
        self.db.write_batch(batch)?;
        Ok(MonadOutboxTransition::Applied)
    }

    /// Complete a replay with a bounded transient error if its generation still owns Pending.
    pub(crate) fn complete_pending_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        self.complete_pending_member_inner(
            payload_hash,
            child_index,
            lease,
            detail,
            now_ms,
            limits,
            ExposureUpdate::Keep,
        )
    }

    /// Complete a replay whose send the node DEFINITIVELY rejected (it states it did not accept
    /// the transaction). Clears the in-flight exposure marker set by `begin_replay_attempt`
    /// unless the member was already exposed before this attempt (`was_exposed`).
    pub(crate) fn complete_rejected_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        was_exposed: bool,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        self.complete_pending_member_inner(
            payload_hash,
            child_index,
            lease,
            detail,
            now_ms,
            limits,
            if was_exposed {
                ExposureUpdate::Keep
            } else {
                ExposureUpdate::ClearRejected
            },
        )
    }

    /// Persist an exact transaction-body observation without requiring a receipt. This is
    /// monotonic evidence that the signed bytes may already be economically exposed.
    pub(crate) fn complete_submitted_member(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        self.complete_pending_member_inner(
            payload_hash,
            child_index,
            lease,
            detail,
            now_ms,
            limits,
            ExposureUpdate::Set,
        )
    }

    fn complete_pending_member_inner(
        &self,
        payload_hash: &[u8],
        child_index: u32,
        lease: MonadOutboxLease,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
        exposure: ExposureUpdate,
    ) -> Result<MonadOutboxTransition> {
        validate_limits(limits)?;
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let record = self
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
        match exposure {
            ExposureUpdate::Keep => {}
            ExposureUpdate::Set => member.exposed = true,
            ExposureUpdate::ClearRejected => member.exposed = false,
        }
        // The exact lookup already ran without confirming this child, so claim age may be applied
        // here too. Otherwise a member that stays visible-but-unmined or behind an ambiguous RPC
        // never reaches `begin_replay_attempt` and would remain Pending forever.
        if now_ms > claim_expiry_ms(&record, child_index > 0, limits) {
            let mut record = record;
            self.write_terminal_locked(
                &payload_hash,
                &mut record,
                &mut member,
                MonadOutboxTerminal::Expired,
                "claim age limit exceeded",
                now_ms,
                limits,
            )?;
            drop(_guard);
            self.gc_history(now_ms, limits)?;
            return Ok(MonadOutboxTransition::Applied);
        }
        member.last_error = detail;
        member.updated_at_ms = now_ms;
        member.lease_until_ms = 0;
        member.next_replay_at_ms = now_ms.saturating_add(retry_backoff_ms(
            member.attempts,
            record.retry_backoff_base_ms,
            record.max_retry_backoff_ms,
        ));
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(
            self.cf_members,
            member_key(&payload_hash, child_index),
            encode_member(&member),
        );
        if child_index == 0 {
            let key = recipient_key(&active_policy(&record)?.recipient, &payload_hash);
            if member.exposed {
                batch.put_cf(self.cf_recipient, key, []);
            } else {
                batch.delete_cf(self.cf_recipient, key);
            }
        }
        self.db.write_batch(batch)?;
        Ok(MonadOutboxTransition::Applied)
    }

    /// Persist a permanent exact-chain observation while Pending, without a replay token.
    #[cfg(test)]
    pub(crate) fn terminal_observed_member(
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
    pub(crate) fn complete_terminal_member(
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
        validate_limits(limits)?;
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
    pub(crate) fn terminal_claim(
        &self,
        payload_hash: &[u8],
        terminal: MonadOutboxTerminal,
        detail: &str,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<MonadOutboxTransition> {
        validate_limits(limits)?;
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let mut record = self
            .get(&payload_hash)?
            .ok_or_else(|| CorruptRecord("terminal claim has no outbox row".to_string()))?;
        if !matches!(
            record.lifecycle,
            MonadOutboxLifecycle::Pending | MonadOutboxLifecycle::FullyConfirmed
        ) {
            return Ok(MonadOutboxTransition::Stale);
        }
        record.lifecycle = MonadOutboxLifecycle::Terminal(terminal);
        record.updated_at_ms = now_ms;
        record.last_error = bounded_text(detail, limits.max_last_error_bytes);
        let mut batch = rocksdb::WriteBatch::default();
        let encoded = encode_record(&record);
        self.append_outbox_put(&mut batch, &payload_hash, &encoded);
        batch.delete_cf(self.cf_active, payload_hash);
        if self.recovery_facts_locked(&payload_hash, &record)? == RecoveryFacts::None {
            if let Some(policy) = record.policy.as_ref() {
                self.append_quota_release_locked(&mut batch, &payload_hash, &policy.recipient)?;
                batch.delete_cf(
                    self.cf_recipient,
                    recipient_key(&policy.recipient, &payload_hash),
                );
            }
            batch.put_cf(
                self.cf_history,
                history_key(now_ms, &payload_hash),
                self.retained_claim_bytes_locked(&payload_hash, &record, encoded.len())?
                    .to_be_bytes(),
            );
        }
        self.db.write_batch(batch)?;
        drop(_guard);
        self.gc_history(now_ms, limits)?;
        Ok(MonadOutboxTransition::Applied)
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
        let encoded_member = encode_member(member);
        let mut batch = rocksdb::WriteBatch::default();
        self.append_outbox_put(&mut batch, payload_hash, &encoded);
        batch.put_cf(
            self.cf_members,
            member_key(payload_hash, member.child_index),
            &encoded_member,
        );
        batch.delete_cf(self.cf_active, payload_hash);
        // Evidence is judged against the member being staged: it has not been written yet, and
        // exposure learned in this same transition must be retained atomically with it.
        if self.has_recovery_evidence_locked(payload_hash, record, Some(member))? {
            batch.put_cf(
                self.cf_recipient,
                recipient_key(&active_policy(record)?.recipient, payload_hash),
                [],
            );
        } else {
            if let Some(policy) = record.policy.as_ref() {
                self.append_quota_release_locked(&mut batch, payload_hash, &policy.recipient)?;
                batch.delete_cf(
                    self.cf_recipient,
                    recipient_key(&policy.recipient, payload_hash),
                );
            }
            batch.put_cf(
                self.cf_history,
                history_key(now_ms, payload_hash),
                self.retained_claim_bytes_with_member_locked(
                    payload_hash,
                    record,
                    encoded.len(),
                    member.child_index,
                    encoded_member.len(),
                )?
                .to_be_bytes(),
            );
        }
        self.db.write_batch(batch)?;
        Ok(member.clone())
    }

    /// Mark all-confirmed after checking every member and the frozen aggregate minimum.
    pub(crate) fn mark_fully_confirmed(&self, payload_hash: &[u8], now_ms: i64) -> Result<bool> {
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
            let encoded = encode_record(&record);
            self.append_outbox_put(&mut batch, &payload_hash, &encoded);
            batch.delete_cf(self.cf_active, payload_hash);
            self.db.write_batch(batch)?;
            return Ok(false);
        }
        record.lifecycle = MonadOutboxLifecycle::FullyConfirmed;
        record.updated_at_ms = now_ms;
        let mut batch = rocksdb::WriteBatch::default();
        let encoded = encode_record(&record);
        self.append_outbox_put(&mut batch, &payload_hash, &encoded);
        self.db.write_batch(batch)?;
        Ok(true)
    }

    /// Atomically store the recipient inbox row and mark the outbox delivered.
    pub(crate) fn finalize_delivery(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
        expected_chain_id: u64,
        limits: &MonadOutboxLimits,
    ) -> Result<proto::StoredMonadMessage> {
        self.finalize_delivery_inner(payload_hash, now_ms, Some(expected_chain_id), limits)
    }

    #[cfg(test)]
    fn finalize_delivery_unchecked_for_test(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<proto::StoredMonadMessage> {
        self.finalize_delivery_inner(payload_hash, now_ms, None, limits)
    }

    fn finalize_delivery_inner(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
        expected_chain_id: Option<u64>,
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
                self.append_outbox_put(&mut batch, &payload_hash, &encoded);
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
        if let Some(stored) = self.db.monad_messages().get(&payload_hash)? {
            if record.canonical_message.is_some() {
                let message = Self::canonical_message(&record)?;
                let policy = active_policy(&record)?.clone();
                record.canonical_message = None;
                record.policy = None;
                record.last_error.clear();
                record.lifecycle = MonadOutboxLifecycle::Delivered;
                let encoded = encode_record(&record);
                let mut batch = rocksdb::WriteBatch::default();
                if self
                    .db
                    .get(self.cf_meta, recovery_quota_record_key(&payload_hash))?
                    .is_some()
                {
                    self.append_quota_release_locked(&mut batch, &payload_hash, &policy.recipient)?;
                }
                self.append_outbox_put(&mut batch, &payload_hash, &encoded);
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
                    history_key(now_ms, &payload_hash),
                    (encoded.len() as u64).to_be_bytes(),
                );
                self.db.write_batch(batch)?;
            }
            drop(_guard);
            self.gc_history(now_ms, limits)?;
            return Ok(stored);
        }

        let message = Self::canonical_message(&record)?;
        let policy = active_policy(&record)?.clone();
        let publication_message = if record.lifecycle == MonadOutboxLifecycle::FullyConfirmed {
            let mut members = Vec::with_capacity(message.stamp_payments.len());
            for payment in &message.stamp_payments {
                let member = self
                    .get_member(&payload_hash, payment.child_index)?
                    .ok_or_else(|| CorruptRecord("fully-confirmed child row missing".to_string()))?;
                members.push(member);
            }
            let verified = if let Some(expected_chain_id) = expected_chain_id {
                Some(crate::monad_outbox::financial::verify_submission(
                    &message,
                    record.canonical_message.as_deref().expect("decoded above"),
                    &payload_hash,
                    &policy,
                    &members,
                    expected_chain_id,
                )?)
            } else {
                None
            };
            verified.map_or(&message, |view| view.message()).clone()
        } else {
            message.clone()
        };
        let child_indices = publication_message
            .stamp_payments
            .iter()
            .map(|payment| payment.child_index)
            .collect::<Vec<_>>();
        let stored = proto::StoredMonadMessage {
            message: Some(publication_message),
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
        if self
            .db
            .get(self.cf_meta, recovery_quota_record_key(&payload_hash))?
            .is_some()
        {
            self.append_quota_release_locked(&mut batch, &payload_hash, &policy.recipient)?;
        }
        self.db.monad_messages().append_put_to_batch(
            &mut batch,
            &payload_hash,
            &policy.recipient,
            &stored,
        )?;
        self.append_outbox_put(&mut batch, &payload_hash, &encoded_tombstone);
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

    /// Read one recipient inbox page while treating both the journal index and primary protobuf
    /// as untrusted durable facts. Every returned row is cross-checked before it can cross the
    /// authenticated HTTP boundary.
    pub(crate) fn validated_inbox_page(
        &self,
        recipient: &Address,
        since: i64,
        cursor: Option<crate::store::monad_messages::RecipientMessageCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<crate::store::monad_messages::RecipientMessagePage> {
        use crate::store::monad_messages::{
            DbMonadMessagesError, RecipientMessageCursor, RecipientMessagePage,
        };

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
                    return Err(DbMonadMessagesError::StalePrivateCursor.into());
                }
                inbox_recipient_key(recipient, cursor.timestamp, &cursor.payload_hash)
            }
            None => inbox_recipient_key(recipient, since, &[]),
        };
        let cf_index = self.db.cf(CF_MONAD_MESSAGES_BY_RECIPIENT_TIME)?;
        let cf_primary = self.db.cf(CF_MONAD_MESSAGES)?;
        let mut messages = Vec::with_capacity(limit);
        let mut encoded_bytes = 0usize;
        let mut last_cursor = None;
        let mut has_more = false;
        for item in self
            .db
            .rocksdb()
            .iterator_cf(cf_index, IteratorMode::From(&start_key, Direction::Forward))
        {
            let (key, value) = item?;
            if !key.starts_with(&recipient.0) {
                break;
            }
            if cursor.is_some() && key.as_ref() == start_key.as_slice() {
                continue;
            }
            let (timestamp, payload_hash) =
                validate_inbox_recipient_index(recipient, &key, &value)?;
            if timestamp < since {
                return Err(CorruptRecord(
                    "recipient inbox index precedes its requested lower bound".to_string(),
                )
                .into());
            }
            if messages.len() == limit {
                has_more = true;
                break;
            }
            let encoded = self.db.get(cf_primary, payload_hash)?.ok_or_else(|| {
                CorruptRecord("recipient inbox index references missing primary row".to_string())
            })?;
            let stored =
                proto::StoredMonadMessage::decode(encoded.as_ref()).wrap_err_with(|| {
                    CorruptRecord("recipient inbox primary protobuf cannot decode".to_string())
                })?;
            if stored.timestamp != timestamp {
                return Err(CorruptRecord(
                    "recipient inbox index timestamp differs from its primary row".to_string(),
                )
                .into());
            }
            let message = stored.message.as_ref().ok_or_else(|| {
                CorruptRecord("recipient inbox primary has no canonical message".to_string())
            })?;
            let inner_hash = checked_payload_hash(&message.payload_hash).map_err(|_| {
                CorruptRecord("recipient inbox primary has malformed payload hash".to_string())
            })?;
            if inner_hash != payload_hash
                || Sha256::digest(message.encrypted_payload.clone().into()).as_slice()
                    != payload_hash
            {
                return Err(CorruptRecord(
                    "recipient inbox primary payload ownership is inconsistent".to_string(),
                )
                .into());
            }
            let envelope: StoredEnvelopeRecipient =
                serde_json::from_slice(&message.encrypted_payload).map_err(|_| {
                    CorruptRecord("recipient inbox envelope cannot decode".to_string())
                })?;
            let routed_recipient = Address::from_hex(&envelope.to).map_err(|_| {
                CorruptRecord("recipient inbox envelope has invalid routing owner".to_string())
            })?;
            if routed_recipient != *recipient {
                return Err(CorruptRecord(
                    "recipient inbox index points at another recipient's primary row".to_string(),
                )
                .into());
            }
            let record_len = stored.encoded_len();
            let added = 1 + protobuf_varint_len(record_len as u64) + record_len;
            if encoded_bytes.saturating_add(added) > max_bytes {
                if messages.is_empty() {
                    return Err(DbMonadMessagesError::RecordExceedsPageBudget {
                        required: added,
                        maximum: max_bytes,
                    }
                    .into());
                }
                has_more = true;
                break;
            }
            encoded_bytes += added;
            messages.push(stored);
            last_cursor = Some(RecipientMessageCursor {
                timestamp,
                payload_hash,
            });
        }
        Ok(RecipientMessagePage {
            messages,
            next_cursor: has_more.then_some(last_cursor).flatten(),
            encoded_bytes,
        })
    }

    /// List retained confirmed prefixes for one already-validated recipient.
    pub(crate) fn confirmed_prefixes_for_recipient(
        &self,
        recipient: &Address,
        limit: usize,
    ) -> Result<Vec<ConfirmedPrefixRecovery>> {
        Ok(self
            .confirmed_prefixes_for_recipient_page(
                recipient,
                None,
                limit,
                usize::MAX,
                usize::MAX,
                usize::MAX,
            )?
            .recoveries)
    }

    /// Atomically retire one exact terminal recovery obligation after recipient authentication.
    pub(crate) fn acknowledge_terminal_recovery(
        &self,
        recipient: &Address,
        payload_hash: &[u8],
        obligation_id: &[u8],
    ) -> Result<MonadRecoveryAck> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let obligation_id = checked_payload_hash(obligation_id)?;
        let _guard = self.db.lock_monad_outbox();
        let Some(record) = self.get(&payload_hash)? else {
            return Ok(MonadRecoveryAck::Absent);
        };
        // Recipient ownership is decided before anything else, so another recipient can never
        // distinguish an active, terminal, or absent claim by probing a payload hash.
        match record.policy.as_ref() {
            Some(policy) if policy.recipient != *recipient => {
                return Ok(MonadRecoveryAck::WrongRecipient)
            }
            None => return Ok(MonadRecoveryAck::Absent),
            Some(_) => {}
        }
        if matches!(
            record.lifecycle,
            MonadOutboxLifecycle::Pending | MonadOutboxLifecycle::FullyConfirmed
        ) {
            return Ok(MonadRecoveryAck::Active);
        }
        if record.lifecycle == MonadOutboxLifecycle::Delivered {
            return Ok(MonadRecoveryAck::Absent);
        }
        if self.recovery_obligation_id_locked(&payload_hash)? != obligation_id {
            return Ok(MonadRecoveryAck::Absent);
        }
        let policy = active_policy(&record)?.clone();
        match self.recovery_facts_locked(&payload_hash, &record)? {
            RecoveryFacts::None => return Ok(MonadRecoveryAck::Absent),
            RecoveryFacts::Obligation if policy.recipient != *recipient => {
                return Ok(MonadRecoveryAck::WrongRecipient)
            }
            RecoveryFacts::Obligation => {}
        }
        let message = Self::canonical_message(&record)?;
        let mut batch = rocksdb::WriteBatch::default();
        self.append_quota_release_locked(&mut batch, &payload_hash, recipient)?;
        batch.delete_cf(self.cf_outbox, payload_hash);
        batch.delete_cf(self.cf_active, payload_hash);
        batch.delete_cf(self.cf_recipient, recipient_key(recipient, &payload_hash));
        batch.delete_cf(
            self.cf_history,
            history_key(record.updated_at_ms, &payload_hash),
        );
        for payment in message.stamp_payments {
            batch.delete_cf(
                self.cf_members,
                member_key(&payload_hash, payment.child_index),
            );
        }
        self.db.write_batch(batch)?;
        Ok(MonadRecoveryAck::Acknowledged)
    }

    /// Scan one strict-forward, work-bounded recovery page ordered by payload hash.
    ///
    /// A supplied authenticated cursor is a lexicographic position and need not still exist. The
    /// scan may advance over rows with no confirmed prefix; `next_cursor` therefore names the last
    /// scanned row, not necessarily the last returned row.
    pub(crate) fn confirmed_prefixes_for_recipient_page(
        &self,
        recipient: &Address,
        cursor: Option<[u8; 32]>,
        limit: usize,
        scan_limit: usize,
        max_canonical_bytes: usize,
        max_inspected_bytes: usize,
    ) -> Result<ConfirmedPrefixRecoveryPage> {
        if limit == 0 {
            return Ok(ConfirmedPrefixRecoveryPage {
                recoveries: Vec::new(),
                next_cursor: None,
                scanned: 0,
                canonical_bytes: 0,
                inspected_bytes: 0,
            });
        }
        let _guard = self.db.lock_monad_outbox();
        let prefix = recipient.0;
        let start_key = match cursor {
            Some(payload_hash) => recipient_key(recipient, &payload_hash).to_vec(),
            None => prefix.to_vec(),
        };
        let mut recoveries: Vec<ConfirmedPrefixRecovery> = Vec::new();
        let mut scanned = 0usize;
        let mut canonical_bytes = 0usize;
        let mut inspected_bytes = 0usize;
        let mut last_scanned = cursor;
        let mut has_more = false;
        'rows: for item in self.db.rocksdb().iterator_cf(
            self.cf_recipient,
            IteratorMode::From(&start_key, Direction::Forward),
        ) {
            let (key, _) = item?;
            if key.len() != RECIPIENT_KEY_LEN || !key.starts_with(&prefix) {
                break;
            }
            if cursor.is_some() && key.as_ref() == start_key.as_slice() {
                continue;
            }
            if scanned == scan_limit || recoveries.len() == limit {
                has_more = true;
                break;
            }
            let payload_hash = checked_payload_hash(&key[20..])?;
            let previous_cursor = last_scanned;
            let row_work_start = inspected_bytes;
            let encoded_record = self.db.get(self.cf_outbox, payload_hash)?.ok_or_else(|| {
                CorruptRecord("recipient index references missing outbox".to_string())
            })?;
            note_recovery_page_read(encoded_record.len());
            inspected_bytes = inspected_bytes.saturating_add(encoded_record.len());
            if inspected_bytes > max_inspected_bytes {
                if row_work_start == 0 && recoveries.is_empty() {
                    return Err(RecoveryRecordExceedsPageBudget {
                        required: inspected_bytes,
                        maximum: max_inspected_bytes,
                    }
                    .into());
                }
                has_more = true;
                break;
            }
            scanned += 1;
            last_scanned = Some(payload_hash);
            note_recovery_page_decode(encoded_record.len());
            let record = decode_record(&encoded_record)?;
            if matches!(record.lifecycle, MonadOutboxLifecycle::Delivered) {
                continue;
            }
            if record.policy.as_ref().map(|policy| policy.recipient) != Some(*recipient) {
                return Err(CorruptRecord(
                    "recipient recovery index differs from frozen policy".to_string(),
                )
                .into());
            }
            let message = Self::canonical_message(&record)?;
            let mut confirmed_prefix = Vec::new();
            let mut remaining_members = Vec::new();
            let mut prefix_open = true;
            for payment in &message.stamp_payments {
                let encoded_member = self
                    .db
                    .get(
                        self.cf_members,
                        member_key(&payload_hash, payment.child_index),
                    )?
                    .ok_or_else(|| CorruptRecord("recovery member missing".to_string()))?;
                note_recovery_page_read(encoded_member.len());
                inspected_bytes = inspected_bytes.saturating_add(encoded_member.len());
                if inspected_bytes > max_inspected_bytes {
                    if row_work_start == 0 && recoveries.is_empty() {
                        return Err(RecoveryRecordExceedsPageBudget {
                            required: inspected_bytes,
                            maximum: max_inspected_bytes,
                        }
                        .into());
                    }
                    has_more = true;
                    last_scanned = previous_cursor;
                    break 'rows;
                }
                note_recovery_page_decode(encoded_member.len());
                let member = decode_member(payment.child_index, &encoded_member)?;
                if prefix_open && matches!(member.state, MonadOutboxMemberState::Confirmed { .. }) {
                    confirmed_prefix.push(member);
                } else {
                    prefix_open = false;
                    remaining_members.push(member);
                }
            }
            let terminal_exposure = matches!(record.lifecycle, MonadOutboxLifecycle::Terminal(_))
                && remaining_members
                    .first()
                    .map(|member| member.child_index == 0 && member.exposed)
                    .unwrap_or(false);
            if !confirmed_prefix.is_empty() || terminal_exposure {
                let message_bytes = message.encoded_len();
                if canonical_bytes.saturating_add(message_bytes) > max_canonical_bytes {
                    if recoveries.is_empty() {
                        return Err(RecoveryRecordExceedsPageBudget {
                            required: message_bytes,
                            maximum: max_canonical_bytes,
                        }
                        .into());
                    }
                    has_more = true;
                    // This record was inspected but not returned; continue from the previous
                    // returned record so a subsequent larger-budget page cannot omit it.
                    last_scanned = recoveries.last().map(|recovery| recovery.payload_hash);
                    break;
                }
                canonical_bytes += message_bytes;
                let canonical_message = record.canonical_message.ok_or_else(|| {
                    CorruptRecord("recovery row has no canonical owner".to_string())
                })?;
                let policy = record.policy.ok_or_else(|| {
                    CorruptRecord("recovery row has no frozen policy".to_string())
                })?;
                recoveries.push(ConfirmedPrefixRecovery {
                    payload_hash,
                    obligation_id: self.recovery_obligation_id_locked(&payload_hash)?,
                    message,
                    confirmed_prefix,
                    lifecycle: record.lifecycle,
                    canonical_message,
                    policy,
                    remaining_members,
                });
            }
        }
        Ok(ConfirmedPrefixRecoveryPage {
            recoveries,
            next_cursor: has_more.then_some(last_scanned).flatten(),
            scanned,
            canonical_bytes,
            inspected_bytes,
        })
    }

    /// Read durable usage for the other namespace's production admission gate.
    /// This lock is released before that namespace takes its storage lock.
    pub(crate) fn admission_usage(
        &self,
        recipient: Address,
        limits: &MonadOutboxLimits,
    ) -> Result<crate::monad_outbox::financial::AdmissionUsage> {
        validate_limits(limits)?;
        let _guard = self.db.lock_monad_outbox();
        if !self.migration_complete(
            RECOVERY_QUOTA_MIGRATION_KEY,
            RECOVERY_QUOTA_CURSOR_KEY,
            RECOVERY_QUOTA_CURSOR_STATE_KEY,
            "v5 recovery quota migration",
        )? {
            return Err(CorruptRecord(
                "recovery quota accounting migration is incomplete".to_owned(),
            )
            .into());
        }
        let global = self.read_required_quota_usage_locked(
            RECOVERY_QUOTA_GLOBAL_KEY,
            "global recovery quota counter",
        )?;
        let recipient_usage = self.read_recipient_quota_usage_for_reserve_locked(&recipient)?;
        Ok(crate::monad_outbox::financial::AdmissionUsage {
            active: self.active_count_up_to(limits.max_active_claims)? as u64,
            global_records: global.records,
            global_bytes: global.bytes,
            recipient_records: recipient_usage.records,
            recipient_bytes: recipient_usage.bytes,
            unconfirmed: self.read_unconfirmed_count_locked(&recipient)?,
        })
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

    fn recovery_reservation_available_locked(
        &self,
        recipient: &Address,
        new_bytes: usize,
        limits: &MonadOutboxLimits,
        external: &crate::monad_outbox::financial::AdmissionUsage,
    ) -> Result<bool> {
        #[cfg(test)]
        QUOTA_ADMISSION_META_READS.set(QUOTA_ADMISSION_META_READS.get().saturating_add(1));
        if !self.migration_complete(
            RECOVERY_QUOTA_MIGRATION_KEY,
            RECOVERY_QUOTA_CURSOR_KEY,
            RECOVERY_QUOTA_CURSOR_STATE_KEY,
            "v5 recovery quota migration",
        )? {
            return Err(CorruptRecord(
                "recovery quota accounting migration is incomplete".to_string(),
            )
            .into());
        }
        let global = self
            .read_required_quota_usage_locked(
                RECOVERY_QUOTA_GLOBAL_KEY,
                "global recovery quota counter",
            )?
            .checked_add(new_bytes as u64)?;
        let recipient_usage = self
            .read_recipient_quota_usage_for_reserve_locked(recipient)?
            .checked_add(new_bytes as u64)?;
        Ok(global
            .records
            .checked_add(external.global_records)
            .is_some_and(|n| n <= limits.max_recovery_records as u64)
            && global
                .bytes
                .checked_add(external.global_bytes)
                .is_some_and(|n| n <= limits.max_recovery_bytes as u64)
            && recipient_usage
                .records
                .checked_add(external.recipient_records)
                .is_some_and(|n| n <= limits.max_recovery_records_per_recipient as u64)
            && recipient_usage
                .bytes
                .checked_add(external.recipient_bytes)
                .is_some_and(|n| n <= limits.max_recovery_bytes_per_recipient as u64))
    }

    /// Unconfirmed-claim counter for one recipient (O(1): one metadata read).
    ///
    /// Counts claims that own a recovery reservation but whose child zero is not confirmed. A
    /// per-claim marker makes every increment and decrement idempotent, so the counter cannot
    /// drift when a claim leaves the set through confirmation, terminalization, acknowledgement,
    /// or age-out. Claims created before this accounting existed have no marker and are simply
    /// not counted.
    fn read_unconfirmed_count_locked(&self, recipient: &Address) -> Result<u64> {
        #[cfg(test)]
        QUOTA_ADMISSION_META_READS.set(QUOTA_ADMISSION_META_READS.get().saturating_add(1));
        match self
            .db
            .get(self.cf_meta, unconfirmed_recipient_key(recipient))?
        {
            Some(encoded) => decode_u64_meta(&encoded, "unconfirmed claim counter"),
            None => Ok(0),
        }
    }

    fn append_unconfirmed_mark_locked(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8; 32],
        recipient: &Address,
    ) -> Result<()> {
        let count = self.read_unconfirmed_count_locked(recipient)?;
        batch.put_cf(
            self.cf_meta,
            unconfirmed_recipient_key(recipient),
            count.saturating_add(1).to_be_bytes(),
        );
        batch.put_cf(self.cf_meta, unconfirmed_owner_key(payload_hash), []);
        Ok(())
    }

    /// Remove a claim from the unconfirmed set if (and only if) it is currently marked.
    fn append_unconfirmed_clear_locked(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8; 32],
        recipient: &Address,
    ) -> Result<()> {
        if self
            .db
            .get(self.cf_meta, unconfirmed_owner_key(payload_hash))?
            .is_none()
        {
            return Ok(());
        }
        let count = self.read_unconfirmed_count_locked(recipient)?;
        if count <= 1 {
            batch.delete_cf(self.cf_meta, unconfirmed_recipient_key(recipient));
        } else {
            batch.put_cf(
                self.cf_meta,
                unconfirmed_recipient_key(recipient),
                (count - 1).to_be_bytes(),
            );
        }
        batch.delete_cf(self.cf_meta, unconfirmed_owner_key(payload_hash));
        Ok(())
    }

    fn read_required_quota_usage_locked(
        &self,
        key: &[u8],
        name: &str,
    ) -> Result<RecoveryQuotaUsage> {
        #[cfg(test)]
        QUOTA_ADMISSION_META_READS.set(QUOTA_ADMISSION_META_READS.get().saturating_add(1));
        let encoded = self
            .db
            .get(self.cf_meta, key)?
            .ok_or_else(|| CorruptRecord(format!("{name} is missing")))?;
        decode_quota_usage(&encoded)
    }

    fn recipient_has_live_reservation_locked(&self, recipient: &Address) -> Result<bool> {
        let prefix = recovery_quota_owner_recipient_prefix(recipient);
        let mut rows = self.db.rocksdb().iterator_cf(
            self.cf_meta,
            IteratorMode::From(&prefix, Direction::Forward),
        );
        let Some(item) = rows.next() else {
            return Ok(false);
        };
        let (key, value) = item?;
        if !key.starts_with(&prefix) {
            return Ok(false);
        }
        if key.len() != prefix.len() + PAYLOAD_HASH_LEN || !value.is_empty() {
            return Err(CorruptRecord(
                "recipient recovery quota owner index is malformed".to_string(),
            )
            .into());
        }
        Ok(true)
    }

    fn read_recipient_quota_usage_for_reserve_locked(
        &self,
        recipient: &Address,
    ) -> Result<RecoveryQuotaUsage> {
        #[cfg(test)]
        QUOTA_ADMISSION_META_READS.set(QUOTA_ADMISSION_META_READS.get().saturating_add(1));
        let encoded = self
            .db
            .get(self.cf_meta, recovery_quota_recipient_key(recipient))?;
        let has_owner = self.recipient_has_live_reservation_locked(recipient)?;
        match encoded {
            Some(encoded) => {
                let usage = decode_quota_usage(&encoded)?;
                if (usage.records == 0) == has_owner {
                    return Err(CorruptRecord(
                        "recipient recovery quota counter disagrees with its live owner index"
                            .to_string(),
                    )
                    .into());
                }
                Ok(usage)
            }
            None if has_owner => Err(CorruptRecord(
                "recipient recovery quota counter is missing for a live owner".to_string(),
            )
            .into()),
            None => Ok(RecoveryQuotaUsage::default()),
        }
    }

    fn append_quota_reserve_locked(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8; 32],
        recipient: &Address,
        bytes: u64,
    ) -> Result<()> {
        let global = self
            .read_required_quota_usage_locked(
                RECOVERY_QUOTA_GLOBAL_KEY,
                "global recovery quota counter",
            )?
            .checked_add(bytes)?;
        let recipient_usage = self
            .read_recipient_quota_usage_for_reserve_locked(recipient)?
            .checked_add(bytes)?;
        if self
            .db
            .get(self.cf_meta, recovery_quota_record_key(payload_hash))?
            .is_some()
            || self
                .db
                .get(
                    self.cf_meta,
                    recovery_quota_owner_key(recipient, payload_hash),
                )?
                .is_some()
            || self
                .db
                .get(self.cf_meta, recovery_obligation_id_key(payload_hash))?
                .is_some()
        {
            return Err(CorruptRecord(
                "new recovery claim already has quota reservation metadata".to_string(),
            )
            .into());
        }
        batch.put_cf(
            self.cf_meta,
            RECOVERY_QUOTA_GLOBAL_KEY,
            encode_quota_usage(global),
        );
        batch.put_cf(
            self.cf_meta,
            recovery_quota_recipient_key(recipient),
            encode_quota_usage(recipient_usage),
        );
        batch.put_cf(
            self.cf_meta,
            recovery_quota_record_key(payload_hash),
            bytes.to_be_bytes(),
        );
        batch.put_cf(
            self.cf_meta,
            recovery_quota_owner_key(recipient, payload_hash),
            [],
        );
        let mut obligation_id = [0; 32];
        OsRng.fill_bytes(&mut obligation_id);
        batch.put_cf(
            self.cf_meta,
            recovery_obligation_id_key(payload_hash),
            obligation_id,
        );
        Ok(())
    }

    fn append_quota_release_locked(
        &self,
        batch: &mut rocksdb::WriteBatch,
        payload_hash: &[u8; 32],
        recipient: &Address,
    ) -> Result<()> {
        let encoded = self
            .db
            .get(self.cf_meta, recovery_quota_record_key(payload_hash))?
            .ok_or_else(|| {
                CorruptRecord("recovery quota record reservation is missing".to_string())
            })?;
        let bytes = decode_u64_meta(&encoded, "recovery quota record reservation")?;
        let global = self
            .read_required_quota_usage_locked(
                RECOVERY_QUOTA_GLOBAL_KEY,
                "global recovery quota counter",
            )?
            .checked_sub(bytes)?;
        let owner_key = recovery_quota_owner_key(recipient, payload_hash);
        let owner = self
            .db
            .get(self.cf_meta, &owner_key)?
            .ok_or_else(|| CorruptRecord("recovery quota owner index is missing".to_string()))?;
        if !owner.is_empty() {
            return Err(
                CorruptRecord("recovery quota owner index value is malformed".to_string()).into(),
            );
        }
        let recipient_usage = self
            .read_required_quota_usage_locked(
                &recovery_quota_recipient_key(recipient),
                "recipient recovery quota counter",
            )?
            .checked_sub(bytes)?;
        batch.put_cf(
            self.cf_meta,
            RECOVERY_QUOTA_GLOBAL_KEY,
            encode_quota_usage(global),
        );
        if recipient_usage == RecoveryQuotaUsage::default() {
            batch.delete_cf(self.cf_meta, recovery_quota_recipient_key(recipient));
        } else {
            batch.put_cf(
                self.cf_meta,
                recovery_quota_recipient_key(recipient),
                encode_quota_usage(recipient_usage),
            );
        }
        batch.delete_cf(self.cf_meta, recovery_quota_record_key(payload_hash));
        batch.delete_cf(self.cf_meta, owner_key);
        batch.delete_cf(self.cf_meta, recovery_obligation_id_key(payload_hash));
        self.append_unconfirmed_clear_locked(batch, payload_hash, recipient)?;
        Ok(())
    }

    fn recovery_obligation_id_locked(&self, payload_hash: &[u8; 32]) -> Result<[u8; 32]> {
        let encoded = self
            .db
            .get(self.cf_meta, recovery_obligation_id_key(payload_hash))?
            .ok_or_else(|| CorruptRecord("recovery obligation identity is missing".to_string()))?;
        checked_payload_hash(&encoded).map_err(|_| {
            CorruptRecord("recovery obligation identity has invalid fixed-width shape".to_string())
                .into()
        })
    }

    fn recovery_reserved_claim_bytes_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
    ) -> Result<u64> {
        // Legacy v1/v2 rows are shorter than the normalized v3 encoding produced by their next
        // transition. Reserve from the decoded v3 shape so reopening an old row cannot admit
        // bytes that a later lease/error write grows beyond the configured ceiling.
        let mut total = encode_record(record)
            .len()
            .saturating_sub(record.last_error.len())
            .saturating_add(MAX_LAST_ERROR_BYTES_HARD) as u64;
        let message = Self::canonical_message(record)?;
        for payment in message.stamp_payments {
            let member = self
                .get_member(payload_hash, payment.child_index)?
                .ok_or_else(|| {
                    CorruptRecord(format!(
                        "recovery reservation child {} is missing",
                        payment.child_index
                    ))
                })?;
            let encoded_len = encode_member(&member).len();
            total = total.saturating_add(
                encoded_len
                    .saturating_sub(member.last_error.len())
                    .saturating_add(MAX_LAST_ERROR_BYTES_HARD) as u64,
            );
        }
        Ok(total)
    }

    fn recovery_facts_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
    ) -> Result<RecoveryFacts> {
        let Some(policy) = record.policy.as_ref() else {
            return if record.canonical_message.is_none()
                && record.lifecycle == MonadOutboxLifecycle::Delivered
            {
                Ok(RecoveryFacts::None)
            } else {
                Err(CorruptRecord("owned outbox row has no frozen policy".to_string()).into())
            };
        };
        if !self.has_recovery_evidence_locked(payload_hash, record, None)? {
            return Ok(RecoveryFacts::None);
        }
        if self
            .db
            .get(
                self.cf_recipient,
                recipient_key(&policy.recipient, payload_hash),
            )?
            .is_none()
        {
            return Err(CorruptRecord(
                "recoverable child zero has no recipient recovery index".to_string(),
            )
            .into());
        }
        Ok(RecoveryFacts::Obligation)
    }

    fn has_recovery_evidence_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
        staged_member: Option<&MonadOutboxMember>,
    ) -> Result<bool> {
        let message = Self::canonical_message(record)?;
        let first = message.stamp_payments.first().ok_or_else(|| {
            CorruptRecord("owned canonical request has no child zero".to_string())
        })?;
        if first.child_index != 0 {
            return Err(CorruptRecord("canonical child zero index is missing".to_string()).into());
        }
        let first_member = match staged_member.filter(|member| member.child_index == 0) {
            Some(staged) => staged.clone(),
            None => self.get_member(payload_hash, 0)?.ok_or_else(|| {
                CorruptRecord("canonical child zero member row is missing".to_string())
            })?,
        };
        Ok(
            matches!(first_member.state, MonadOutboxMemberState::Confirmed { .. })
                || first_member.exposed,
        )
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

    fn retained_claim_bytes_with_member_locked(
        &self,
        payload_hash: &[u8; 32],
        record: &MonadOutboxRecord,
        encoded_record_len: usize,
        staged_child_index: u32,
        staged_member_len: usize,
    ) -> Result<u64> {
        let mut total = encoded_record_len as u64;
        if let Ok(message) = Self::canonical_message(record) {
            for payment in message.stamp_payments {
                let len = if payment.child_index == staged_child_index {
                    staged_member_len
                } else {
                    self.get_member(payload_hash, payment.child_index)?
                        .map(|member| encode_member(&member).len())
                        .unwrap_or_default()
                };
                total = total.saturating_add(len as u64);
            }
        }
        Ok(total)
    }

    /// Retire terminal recovery obligations whose only evidence is unconfirmed exposure once they
    /// are older than `max_unconfirmed_recovery_age`, releasing their recovery reservation.
    ///
    /// A claim that ever had a confirmed child is never touched: real value moved and only the
    /// recipient's acknowledgement may retire it. Work is bounded per page; pages are resumed
    /// from the returned recipient-index position.
    pub(crate) fn expire_unconfirmed_recovery_page(
        &self,
        after: Option<Vec<u8>>,
        max_rows: usize,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<(Option<Vec<u8>>, usize)> {
        let max_age_ms = duration_ms_i64(limits.max_unconfirmed_recovery_age);
        let _guard = self.db.lock_monad_outbox();
        let mode = after
            .as_deref()
            .map(|key| IteratorMode::From(key, Direction::Forward))
            .unwrap_or(IteratorMode::Start);
        let mut batch = rocksdb::WriteBatch::default();
        let mut expired = 0usize;
        let mut scanned = 0usize;
        let mut last = None;
        let mut exhausted = true;
        for item in self.db.rocksdb().iterator_cf(self.cf_recipient, mode) {
            let (key, _) = item?;
            if after.as_deref() == Some(key.as_ref()) {
                continue;
            }
            if scanned == max_rows.max(1) {
                exhausted = false;
                break;
            }
            scanned += 1;
            last = Some(key.to_vec());
            if key.len() != RECIPIENT_KEY_LEN {
                return Err(
                    CorruptRecord("recipient recovery index is malformed".to_string()).into(),
                );
            }
            let payload_hash = checked_payload_hash(&key[20..])?;
            let Some(record) = self.get(&payload_hash)? else {
                return Err(
                    CorruptRecord("recipient index references missing outbox".to_string()).into(),
                );
            };
            if !matches!(record.lifecycle, MonadOutboxLifecycle::Terminal(_))
                || now_ms.saturating_sub(record.updated_at_ms) <= max_age_ms
            {
                continue;
            }
            let Some(policy) = record.policy.as_ref() else {
                continue;
            };
            let first = self.get_member(&payload_hash, 0)?.ok_or_else(|| {
                CorruptRecord("canonical child zero member row is missing".to_string())
            })?;
            if matches!(first.state, MonadOutboxMemberState::Confirmed { .. }) {
                continue;
            }
            let message = Self::canonical_message(&record)?;
            self.append_quota_release_locked(&mut batch, &payload_hash, &policy.recipient)?;
            batch.delete_cf(self.cf_outbox, payload_hash);
            batch.delete_cf(self.cf_active, payload_hash);
            batch.delete_cf(self.cf_recipient, key.as_ref());
            batch.delete_cf(
                self.cf_history,
                history_key(record.updated_at_ms, &payload_hash),
            );
            for payment in message.stamp_payments {
                batch.delete_cf(
                    self.cf_members,
                    member_key(&payload_hash, payment.child_index),
                );
            }
            expired += 1;
            // Quota counters are read-modify-write inside `append_quota_release_locked`; commit
            // each retirement so a later row in this page observes the decremented counters.
            self.db.write_batch(std::mem::take(&mut batch))?;
        }
        Ok((if exhausted { None } else { last }, expired))
    }

    /// Retire every aged unconfirmed-exposure obligation, one bounded page at a time.
    pub(crate) fn expire_unconfirmed_recovery(
        &self,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> Result<usize> {
        let mut cursor = None;
        let mut total = 0usize;
        loop {
            let (next, expired) =
                self.expire_unconfirmed_recovery_page(cursor, 256, now_ms, limits)?;
            total += expired;
            match next {
                Some(next) => cursor = Some(next),
                None => return Ok(total),
            }
        }
    }

    /// After a claim's reconciliation was cancelled by the per-claim deadline, push the next
    /// replay time out by the frozen backoff so a stalled transport cannot be retried at scan
    /// cadence. Only ever moves `next_replay_at_ms` forward; the durable lease is untouched.
    pub(crate) fn backoff_after_cancelled_reconcile(
        &self,
        payload_hash: &[u8],
        now_ms: i64,
    ) -> Result<()> {
        let payload_hash = checked_payload_hash(payload_hash)?;
        let _guard = self.db.lock_monad_outbox();
        let Some(record) = self.get(&payload_hash)? else {
            return Ok(());
        };
        if !matches!(record.lifecycle, MonadOutboxLifecycle::Pending) {
            return Ok(());
        }
        let message = Self::canonical_message(&record)?;
        for payment in message.stamp_payments {
            let Some(mut member) = self.get_member(&payload_hash, payment.child_index)? else {
                continue;
            };
            if !matches!(member.state, MonadOutboxMemberState::Pending) {
                continue;
            }
            // Only the child being processed can have a charged attempt; earlier children are
            // confirmed and later ones are untouched.
            if member.attempts == 0 {
                break;
            }
            let earliest = now_ms.saturating_add(retry_backoff_ms(
                member.attempts,
                record.retry_backoff_base_ms,
                record.max_retry_backoff_ms,
            ));
            if earliest > member.next_replay_at_ms {
                member.next_replay_at_ms = earliest;
                member.updated_at_ms = now_ms;
                let mut batch = rocksdb::WriteBatch::default();
                batch.put_cf(
                    self.cf_members,
                    member_key(&payload_hash, payment.child_index),
                    encode_member(&member),
                );
                self.db.write_batch(batch)?;
            }
            break;
        }
        Ok(())
    }

    /// Enforce bounded delivered/non-recoverable-terminal history. Recipient recovery rows are
    /// never indexed here and are defensively skipped if an inconsistent index is encountered.
    pub(crate) fn gc_history(&self, now_ms: i64, limits: &MonadOutboxLimits) -> Result<()> {
        let _guard = self.db.lock_monad_outbox();
        let max_records = limits.max_history_records.min(MAX_HISTORY_RECORDS_HARD);
        let max_age_ms = i64::try_from(limits.max_history_age.as_millis()).unwrap_or(i64::MAX);
        loop {
            let mut retained_count = 0usize;
            let mut retained_bytes = 0u64;
            for item in self
                .db
                .rocksdb()
                .iterator_cf(self.cf_history, IteratorMode::Start)
            {
                let (_, value) = item?;
                let bytes = value
                    .as_ref()
                    .try_into()
                    .map(u64::from_be_bytes)
                    .map_err(|_| CorruptRecord("history byte count is malformed".to_string()))?;
                retained_count = retained_count.saturating_add(1);
                retained_bytes = retained_bytes.saturating_add(bytes);
            }

            let mut changed = 0usize;
            let mut batch = rocksdb::WriteBatch::default();
            for item in self
                .db
                .rocksdb()
                .iterator_cf(self.cf_history, IteratorMode::Start)
            {
                let (key, value) = item?;
                let (timestamp, payload_hash) = decode_history_key(&key)?;
                let bytes = value
                    .as_ref()
                    .try_into()
                    .map(u64::from_be_bytes)
                    .map_err(|_| CorruptRecord("history byte count is malformed".to_string()))?;
                let age_expired = now_ms.saturating_sub(timestamp) > max_age_ms;
                let over_count = retained_count > max_records;
                let over_bytes = retained_bytes > limits.max_history_bytes as u64;
                if !age_expired && !over_count && !over_bytes {
                    break;
                }
                let record = self.get(&payload_hash)?;
                if let Some(record) = record {
                    if self.recovery_facts_locked(&payload_hash, &record)? == RecoveryFacts::None {
                        if let Some(policy) = record.policy.as_ref() {
                            batch.delete_cf(
                                self.cf_recipient,
                                recipient_key(&policy.recipient, &payload_hash),
                            );
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
                }
                batch.delete_cf(self.cf_history, key);
                retained_count = retained_count.saturating_sub(1);
                retained_bytes = retained_bytes.saturating_sub(bytes);
                changed += 1;
                if changed == MAX_HISTORY_RECORDS_HARD {
                    break;
                }
            }
            if changed == 0 {
                return Ok(());
            }
            self.db.write_batch(batch)?;
        }
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

fn migration_cursor_state(name: &str, cursor: &[u8; 32]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(48 + name.len());
    preimage.extend_from_slice(b"frank:outbox-migration-cursor:v1");
    preimage.extend_from_slice(&(name.len() as u32).to_be_bytes());
    preimage.extend_from_slice(name.as_bytes());
    preimage.extend_from_slice(cursor);
    Sha256::digest(preimage.into())
        .as_slice()
        .try_into()
        .expect("SHA256 is 32 bytes")
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

/// Effective claim expiry. A claim with no confirmed child is additionally bounded by the shorter
/// unconfirmed age so it cannot hold recovery quota for the whole frozen claim lifetime. The
/// frozen `expires_at_ms` is never extended.
fn claim_expiry_ms(
    record: &MonadOutboxRecord,
    any_child_confirmed: bool,
    limits: &MonadOutboxLimits,
) -> i64 {
    if any_child_confirmed {
        record.expires_at_ms
    } else {
        record.expires_at_ms.min(
            record
                .created_at_ms
                .saturating_add(duration_ms_i64(limits.max_unconfirmed_claim_age)),
        )
    }
}

fn duration_ms_u64(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn duration_ms_i64(duration: Duration) -> i64 {
    duration.as_millis().try_into().unwrap_or(i64::MAX)
}

fn retry_backoff_ms(attempts: u32, base_ms: u64, max_ms: u64) -> i64 {
    let multiplier = 1u128 << attempts.saturating_sub(1).min(31);
    (u128::from(base_ms)
        .saturating_mul(multiplier)
        .min(u128::from(max_ms)))
    .try_into()
    .unwrap_or(i64::MAX)
}

fn validate_limits(limits: &MonadOutboxLimits) -> Result<()> {
    for (field, actual, maximum) in [
        (
            "canonical bytes",
            limits.max_canonical_bytes,
            MAX_CANONICAL_BYTES_HARD,
        ),
        ("members", limits.max_members, MAX_MEMBERS_HARD),
        (
            "last-error bytes",
            limits.max_last_error_bytes,
            MAX_LAST_ERROR_BYTES_HARD,
        ),
        (
            "network-tag bytes",
            limits.max_network_tag_bytes,
            MAX_NETWORK_TAG_BYTES_HARD,
        ),
        (
            "recipient-public-key bytes",
            limits.max_recipient_pubkey_bytes,
            MAX_RECIPIENT_PUBKEY_BYTES_HARD,
        ),
    ] {
        if actual > maximum {
            return Err(ConfiguredLimitExceedsCodec {
                field,
                actual,
                maximum,
            }
            .into());
        }
    }
    Ok(())
}

fn validate_claim(
    payload_hash: &[u8; 32],
    message: &proto::MonadStampedMessage,
    canonical: &[u8],
    policy: &MonadOutboxPolicy,
    limits: &MonadOutboxLimits,
    adopted_legacy: bool,
) -> Result<()> {
    policy.validate_recipient_authority()?;
    let (canonical_limit, member_limit, network_tag_limit, recipient_pubkey_limit) =
        if adopted_legacy {
            (
                MAX_CANONICAL_BYTES_HARD,
                MAX_MEMBERS_HARD,
                MAX_NETWORK_TAG_BYTES_HARD,
                MAX_RECIPIENT_PUBKEY_BYTES_HARD,
            )
        } else {
            (
                limits.max_canonical_bytes,
                limits.max_members,
                limits.max_network_tag_bytes,
                limits.max_recipient_pubkey_bytes,
            )
        };
    if canonical.len() > canonical_limit {
        return Err(CanonicalTooLarge {
            actual: canonical.len(),
            maximum: canonical_limit,
        }
        .into());
    }
    if message.stamp_payments.is_empty() || message.stamp_payments.len() > member_limit {
        return Err(InvalidMemberCount {
            actual: message.stamp_payments.len(),
            maximum: member_limit,
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
            recipient_pubkey_limit,
        ),
        ("network tag", policy.network_tag.len(), network_tag_limit),
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

fn inbox_recipient_key(recipient: &Address, timestamp: i64, payload_hash: &[u8]) -> Vec<u8> {
    [
        recipient.0.as_slice(),
        timestamp.to_be_bytes().as_slice(),
        payload_hash,
    ]
    .concat()
}

fn validate_inbox_recipient_index(
    recipient: &Address,
    key: &[u8],
    value: &[u8],
) -> Result<(i64, [u8; 32])> {
    const KEY_LEN: usize = 20 + 8 + 32;
    if key.len() != KEY_LEN || value.len() != PAYLOAD_HASH_LEN || key[..20] != recipient.0 {
        return Err(CorruptRecord("recipient inbox index row is malformed".to_string()).into());
    }
    let payload_hash = checked_payload_hash(value)?;
    if key[28..] != payload_hash {
        return Err(CorruptRecord(
            "recipient inbox index suffix differs from its primary pointer".to_string(),
        )
        .into());
    }
    let timestamp = i64::from_be_bytes(key[20..28].try_into().expect("length checked"));
    Ok((timestamp, payload_hash))
}

fn protobuf_varint_len(mut value: u64) -> usize {
    let mut len = 1;
    while value >= 0x80 {
        value >>= 7;
        len += 1;
    }
    len
}

fn recovery_quota_recipient_key(recipient: &Address) -> Vec<u8> {
    let mut key = Vec::with_capacity(RECOVERY_QUOTA_RECIPIENT_PREFIX.len() + recipient.0.len());
    key.extend_from_slice(RECOVERY_QUOTA_RECIPIENT_PREFIX);
    key.extend_from_slice(&recipient.0);
    key
}

fn recovery_quota_record_key(payload_hash: &[u8; 32]) -> Vec<u8> {
    let mut key = Vec::with_capacity(RECOVERY_QUOTA_RECORD_PREFIX.len() + payload_hash.len());
    key.extend_from_slice(RECOVERY_QUOTA_RECORD_PREFIX);
    key.extend_from_slice(payload_hash);
    key
}

fn recovery_quota_owner_recipient_prefix(recipient: &Address) -> Vec<u8> {
    let mut key = Vec::with_capacity(RECOVERY_QUOTA_OWNER_PREFIX.len() + recipient.0.len());
    key.extend_from_slice(RECOVERY_QUOTA_OWNER_PREFIX);
    key.extend_from_slice(&recipient.0);
    key
}

fn recovery_quota_owner_key(recipient: &Address, payload_hash: &[u8; 32]) -> Vec<u8> {
    let mut key = recovery_quota_owner_recipient_prefix(recipient);
    key.extend_from_slice(payload_hash);
    key
}

const UNCONFIRMED_RECIPIENT_PREFIX: &[u8] = b"outbox-unconfirmed-v1-recipient:";
const UNCONFIRMED_OWNER_PREFIX: &[u8] = b"outbox-unconfirmed-v1-owner:";

fn unconfirmed_recipient_key(recipient: &Address) -> Vec<u8> {
    let mut key = UNCONFIRMED_RECIPIENT_PREFIX.to_vec();
    key.extend_from_slice(&recipient.0);
    key
}

fn unconfirmed_owner_key(payload_hash: &[u8; 32]) -> Vec<u8> {
    let mut key = UNCONFIRMED_OWNER_PREFIX.to_vec();
    key.extend_from_slice(payload_hash);
    key
}

fn recovery_obligation_id_key(payload_hash: &[u8; 32]) -> Vec<u8> {
    let mut key = Vec::with_capacity(RECOVERY_OBLIGATION_ID_PREFIX.len() + payload_hash.len());
    key.extend_from_slice(RECOVERY_OBLIGATION_ID_PREFIX);
    key.extend_from_slice(payload_hash);
    key
}

fn encode_quota_usage(usage: RecoveryQuotaUsage) -> [u8; 16] {
    let mut encoded = [0; 16];
    encoded[..8].copy_from_slice(&usage.records.to_be_bytes());
    encoded[8..].copy_from_slice(&usage.bytes.to_be_bytes());
    encoded
}

fn decode_quota_usage(encoded: &[u8]) -> Result<RecoveryQuotaUsage> {
    if encoded.len() != 16 {
        return Err(CorruptRecord("recovery quota counter is malformed".to_string()).into());
    }
    Ok(RecoveryQuotaUsage {
        records: u64::from_be_bytes(encoded[..8].try_into().expect("length checked")),
        bytes: u64::from_be_bytes(encoded[8..].try_into().expect("length checked")),
    })
}

fn decode_u64_meta(encoded: &[u8], name: &str) -> Result<u64> {
    let encoded: [u8; 8] = encoded
        .try_into()
        .map_err(|_| CorruptRecord(format!("{name} metadata is malformed")))?;
    Ok(u64::from_be_bytes(encoded))
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
    bytes.extend_from_slice(&record.expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(&record.max_member_attempts.to_be_bytes());
    bytes.extend_from_slice(&record.retry_backoff_base_ms.to_be_bytes());
    bytes.extend_from_slice(&record.max_retry_backoff_ms.to_be_bytes());
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
    #[cfg(test)]
    QUOTA_ADMISSION_CORPUS_DECODES.set({
        let (enabled, decodes) = QUOTA_ADMISSION_CORPUS_DECODES.get();
        (enabled, decodes.saturating_add(if enabled { 1 } else { 0 }))
    });
    let mut cursor = Cursor::new(bytes);
    let version = cursor.u8()?;
    if version == RECORD_VERSION_V1 {
        return decode_record_v1(cursor);
    }
    if version != RECORD_VERSION_V2 && version != RECORD_VERSION {
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
    let (expires_at_ms, max_member_attempts, retry_backoff_base_ms, max_retry_backoff_ms) =
        if version == RECORD_VERSION {
            (cursor.i64()?, cursor.u32()?, cursor.u64()?, cursor.u64()?)
        } else {
            (
                created_at_ms.saturating_add(duration_ms_i64(LEGACY_MAX_CLAIM_AGE)),
                LEGACY_MAX_MEMBER_ATTEMPTS,
                duration_ms_u64(LEGACY_RETRY_BACKOFF_BASE),
                duration_ms_u64(LEGACY_RETRY_BACKOFF_MAX),
            )
        };
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
        expires_at_ms,
        max_member_attempts,
        retry_backoff_base_ms,
        max_retry_backoff_ms,
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
        expires_at_ms: created_at_ms.saturating_add(duration_ms_i64(LEGACY_MAX_CLAIM_AGE)),
        max_member_attempts: LEGACY_MAX_MEMBER_ATTEMPTS,
        retry_backoff_base_ms: duration_ms_u64(LEGACY_RETRY_BACKOFF_BASE),
        max_retry_backoff_ms: duration_ms_u64(LEGACY_RETRY_BACKOFF_MAX),
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
    bytes.extend_from_slice(&[MEMBER_RECORD_VERSION, state, terminal]);
    bytes.extend_from_slice(&member.tx_hash.0);
    bytes.extend_from_slice(&member.attempts.to_be_bytes());
    bytes.push(u8::from(member.exposed));
    bytes.extend_from_slice(&member.updated_at_ms.to_be_bytes());
    bytes.extend_from_slice(&value.to_be_bytes());
    bytes.extend_from_slice(&block.to_be_bytes());
    bytes.extend_from_slice(&member.lease_generation.to_be_bytes());
    bytes.extend_from_slice(&member.lease_until_ms.to_be_bytes());
    bytes.extend_from_slice(&member.next_replay_at_ms.to_be_bytes());
    put_bytes(&mut bytes, member.last_error.as_bytes());
    bytes
}

fn decode_member(child_index: u32, bytes: &[u8]) -> Result<MonadOutboxMember> {
    let mut cursor = Cursor::new(bytes);
    let version = cursor.u8()?;
    if version != RECORD_VERSION_V1
        && version != RECORD_VERSION_V2
        && version != RECORD_VERSION
        && version != MEMBER_RECORD_VERSION
    {
        return Err(CorruptRecord(format!("unsupported member record version {version}")).into());
    }
    let state_tag = cursor.u8()?;
    let terminal_tag = cursor.u8()?;
    let tx_hash = Hash32(cursor.array()?);
    let attempts = cursor.u32()?;
    let exposed = if version == MEMBER_RECORD_VERSION {
        match cursor.u8()? {
            0 => false,
            1 => true,
            _ => {
                return Err(
                    CorruptRecord("member exposure flag has invalid encoding".to_string()).into(),
                )
            }
        }
    } else {
        // Older rows charged attempts immediately before submission. Treating any charged
        // attempt as possibly exposed is the only crash-safe interpretation during upgrade.
        attempts > 0
    };
    let updated_at_ms = cursor.i64()?;
    let value_wei = cursor.u128()?;
    let block_number = cursor.u64()?;
    let (lease_generation, lease_until_ms, next_replay_at_ms) =
        if version == RECORD_VERSION || version == MEMBER_RECORD_VERSION {
            (cursor.u64()?, cursor.i64()?, cursor.i64()?)
        } else if version == RECORD_VERSION_V2 {
            (cursor.u64()?, cursor.i64()?, updated_at_ms)
        } else {
            (0, 0, updated_at_ms)
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
        exposed,
        lease_generation,
        lease_until_ms,
        next_replay_at_ms,
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
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use pretty_assertions::assert_eq;

    #[test]
    fn external_capacity_is_checked_for_new_reservations_and_predecessor_adoption() -> Result<()> {
        use crate::monad_outbox::financial::AdmissionUsage;
        use crate::store::monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy};
        let limits = MonadOutboxLimits::default();
        let cases = [
            AdmissionUsage {
                active: limits.max_active_claims as u64,
                ..Default::default()
            },
            AdmissionUsage {
                global_records: limits.max_recovery_records as u64,
                ..Default::default()
            },
            AdmissionUsage {
                global_bytes: limits.max_recovery_bytes as u64,
                ..Default::default()
            },
            AdmissionUsage {
                recipient_records: limits.max_recovery_records_per_recipient as u64,
                ..Default::default()
            },
            AdmissionUsage {
                recipient_bytes: limits.max_recovery_bytes_per_recipient as u64,
                ..Default::default()
            },
            AdmissionUsage {
                unconfirmed: limits.max_unconfirmed_claims_per_recipient as u64,
                ..Default::default()
            },
        ];
        for external in cases {
            let temp = tempdir::TempDir::new("external-financial-capacity")?;
            let db = Db::open(temp.path().join("db"))?;
            let request = message(&[b"unchanged original raw bytes"]);
            let store = db.monad_outbox();
            assert_eq!(
                store.claim_with_external_usage(
                    &request.payload_hash,
                    &request,
                    &policy(),
                    1,
                    &limits,
                    Ok(external)
                )?,
                MonadOutboxClaim::AtCapacity
            );
            assert!(store.get(&request.payload_hash)?.is_none());
            let predecessor = MonadMessageAttemptPolicy {
                recipient_pubkey: policy().recipient_pubkey,
                min_value_wei: 77,
                network_tag: Some(b"legacy-net".to_vec()),
            };
            assert_eq!(
                db.monad_messages()
                    .claim_attempt(&request.payload_hash, &request, &predecessor)?,
                MonadMessageAttemptClaim::New
            );
            assert_eq!(
                store.claim_with_external_usage(
                    &request.payload_hash,
                    &request,
                    &policy(),
                    2,
                    &limits,
                    Ok(external)
                )?,
                MonadOutboxClaim::AtCapacityExactLegacy
            );
            assert!(store.get(&request.payload_hash)?.is_none());
            assert_eq!(
                db.monad_messages()
                    .get_attempt(&request.payload_hash, &request)?,
                MonadMessageAttemptClaim::ExistingExact(predecessor)
            );
        }
        Ok(())
    }

    #[test]
    fn retained_exact_and_conflict_precede_external_snapshot_failure() -> Result<()> {
        let temp = tempdir::TempDir::new("external-financial-exact")?;
        let db = Db::open(temp.path().join("db"))?;
        let request = message(&[b"retained original raw bytes"]);
        let limits = MonadOutboxLimits::default();
        let store = db.monad_outbox();
        assert_eq!(
            store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?,
            MonadOutboxClaim::New
        );
        let failed_snapshot = || Err(CorruptRecord("external usage unavailable".to_owned()).into());
        assert!(matches!(
            store.claim_with_external_usage(
                &request.payload_hash,
                &request,
                &policy(),
                2,
                &limits,
                failed_snapshot()
            )?,
            MonadOutboxClaim::ExistingExact(_)
        ));
        let mut changed = request.clone();
        changed.stamp_payments[0].raw_tx.push(1);
        assert_eq!(
            store.claim_with_external_usage(
                &request.payload_hash,
                &changed,
                &policy(),
                2,
                &limits,
                failed_snapshot()
            )?,
            MonadOutboxClaim::Conflict
        );
        Ok(())
    }

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
        let recipient_pubkey = vec![2; 33];
        policy_for_public_key(recipient_pubkey)
    }

    fn policy_for_public_key(recipient_pubkey: Vec<u8>) -> MonadOutboxPolicy {
        MonadOutboxPolicy::new(
            crate::monad_stamp_stealth::recipient_address_from_public_key(&recipient_pubkey)
                .unwrap(),
            recipient_pubkey,
            10,
            b"testnet".to_vec(),
        )
        .unwrap()
    }

    fn policy_for_secret(byte: u8) -> MonadOutboxPolicy {
        let secp = secp256k1_abc::Secp256k1::new();
        let secret = secp256k1_abc::SecretKey::from_slice(&[byte; 32]).unwrap();
        policy_for_public_key(
            secp256k1_abc::PublicKey::from_secret_key(&secp, &secret)
                .serialize()
                .to_vec(),
        )
    }

    fn put_legacy_active_record(
        db: &Db,
        request: &proto::MonadStampedMessage,
        policy: &MonadOutboxPolicy,
        version: u8,
        member_attempts: u32,
    ) -> Result<[u8; 32]> {
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let diagnostic = "x".repeat(MAX_LAST_ERROR_BYTES_HARD);
        let mut record = if version == RECORD_VERSION_V1 {
            let mut record = vec![RECORD_VERSION_V1, 0, 0];
            record.extend_from_slice(&100i64.to_be_bytes());
            record.extend_from_slice(&101i64.to_be_bytes());
            record.extend_from_slice(&3u32.to_be_bytes());
            record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
            record.extend_from_slice(&policy.recipient.0);
            put_bytes(&mut record, &policy.recipient_pubkey);
            put_bytes(&mut record, &policy.network_tag);
            put_bytes(&mut record, diagnostic.as_bytes());
            put_bytes(&mut record, &request.encode_to_vec());
            record
        } else {
            let mut record = vec![RECORD_VERSION_V2, 0, 0, 0];
            record.extend_from_slice(&100i64.to_be_bytes());
            record.extend_from_slice(&101i64.to_be_bytes());
            record.extend_from_slice(&3u32.to_be_bytes());
            put_bytes(&mut record, diagnostic.as_bytes());
            record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
            record.extend_from_slice(&policy.recipient.0);
            put_bytes(&mut record, &policy.recipient_pubkey);
            put_bytes(&mut record, &policy.network_tag);
            put_bytes(&mut record, &request.encode_to_vec());
            record
        };
        db.put(
            db.monad_outbox().cf_outbox,
            payload_hash,
            std::mem::take(&mut record),
        )?;

        for payment in &request.stamp_payments {
            let mut member = vec![version, 0, 0];
            member.extend_from_slice(&Hash32(Keccak256::digest(&payment.raw_tx).into()).0);
            // Zero attempts: never submitted, so terminalization leaves no recovery obligation.
            // A nonzero count models a predecessor that started (and may have completed) a send:
            // legacy rows carry no exposure flag, so decoding must treat that as possibly exposed.
            member.extend_from_slice(&member_attempts.to_be_bytes());
            member.extend_from_slice(&101i64.to_be_bytes());
            member.extend_from_slice(&0u128.to_be_bytes());
            member.extend_from_slice(&0u64.to_be_bytes());
            if version == RECORD_VERSION_V2 {
                member.extend_from_slice(&4u64.to_be_bytes());
                member.extend_from_slice(&0i64.to_be_bytes());
            }
            put_bytes(&mut member, diagnostic.as_bytes());
            db.put(
                db.monad_outbox().cf_members,
                member_key(&payload_hash, payment.child_index),
                member,
            )?;
        }
        db.put(
            db.monad_outbox().cf_active,
            payload_hash,
            100i64.to_be_bytes(),
        )?;
        db.put(
            db.monad_outbox().cf_recipient,
            recipient_key(&policy.recipient, &payload_hash),
            [],
        )?;
        db.rocksdb()
            .delete_cf(db.monad_outbox().cf_meta, RECOVERY_QUOTA_MIGRATION_KEY)?;
        db.rocksdb()
            .delete_cf(db.monad_outbox().cf_meta, RECOVERY_QUOTA_CURSOR_KEY)?;
        db.rocksdb()
            .delete_cf(db.monad_outbox().cf_meta, RECOVERY_QUOTA_GLOBAL_KEY)?;
        db.rocksdb()
            .delete_cf(db.monad_outbox().cf_meta, RECOVERY_OBLIGATION_MIGRATION_KEY)?;
        db.rocksdb()
            .delete_cf(db.monad_outbox().cf_meta, RECOVERY_OBLIGATION_CURSOR_KEY)?;
        db.rocksdb().delete_cf(
            db.monad_outbox().cf_meta,
            recovery_quota_recipient_key(&policy.recipient),
        )?;
        Ok(payload_hash)
    }

    fn put_legacy_v1_delivered_record(
        db: &Db,
        request: &proto::MonadStampedMessage,
    ) -> Result<[u8; 32]> {
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let policy = policy();
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
        db.rocksdb()
            .delete_cf(store.cf_meta, b"outbox-lifecycle-v3")?;
        db.rocksdb()
            .delete_cf(store.cf_meta, b"outbox-lifecycle-v3-cursor")?;
        Ok(payload_hash)
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
    fn exact_legacy_attempt_is_atomically_adopted_and_mismatch_is_preserved() -> Result<()> {
        use crate::store::monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy};

        let tempdir = tempdir::TempDir::new("monad-outbox-adopt")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let request = message(&[b"legacy exact raw zero", b"legacy exact raw one"]);
        let mut lowered_limits = MonadOutboxLimits::default();
        lowered_limits.max_members = 1;
        let legacy = MonadMessageAttemptPolicy {
            recipient_pubkey: policy().recipient_pubkey,
            min_value_wei: 77,
            network_tag: Some(b"legacy-net".to_vec()),
        };
        assert_eq!(
            db.monad_messages()
                .claim_attempt(&request.payload_hash, &request, &legacy)?,
            MonadMessageAttemptClaim::New
        );
        assert_eq!(
            db.monad_outbox().claim(
                &request.payload_hash,
                &request,
                &policy(),
                100,
                &lowered_limits,
            )?,
            MonadOutboxClaim::New
        );
        let adopted = db.monad_outbox().get(&request.payload_hash)?.unwrap();
        let adopted_policy = adopted.policy.unwrap();
        assert_eq!(adopted_policy.recipient, policy().recipient);
        assert_eq!(
            adopted_policy.recipient_pubkey,
            legacy.recipient_pubkey.clone()
        );
        assert_eq!(adopted_policy.min_value_wei, legacy.min_value_wei);
        assert_eq!(
            adopted_policy.network_tag,
            legacy.network_tag.clone().unwrap()
        );
        assert_eq!(
            db.monad_messages()
                .get_attempt(&request.payload_hash, &request)?,
            MonadMessageAttemptClaim::Missing
        );

        let conflicting_owner = message_with_seed(b"second payload", &[b"owner raw"]);
        db.monad_messages().claim_attempt(
            &conflicting_owner.payload_hash,
            &conflicting_owner,
            &legacy,
        )?;
        let mut mismatch = conflicting_owner.clone();
        mismatch.stamp_payments[0].raw_tx.push(1);
        assert_eq!(
            db.monad_outbox().claim(
                &mismatch.payload_hash,
                &mismatch,
                &policy(),
                100,
                &MonadOutboxLimits::default(),
            )?,
            MonadOutboxClaim::Conflict
        );
        assert_eq!(
            db.monad_messages()
                .get_attempt(&conflicting_owner.payload_hash, &conflicting_owner)?,
            MonadMessageAttemptClaim::ExistingExact(legacy)
        );

        let oversized_raw_txs = vec![b"oversized legacy raw".as_slice(); MAX_MEMBERS_HARD + 1];
        let oversized = message_with_seed(b"oversized legacy", &oversized_raw_txs);
        let oversized_policy = MonadMessageAttemptPolicy {
            recipient_pubkey: policy().recipient_pubkey,
            min_value_wei: 77,
            network_tag: Some(b"legacy-net".to_vec()),
        };
        assert_eq!(
            db.monad_messages().claim_attempt(
                &oversized.payload_hash,
                &oversized,
                &oversized_policy,
            )?,
            MonadMessageAttemptClaim::New
        );
        let error = db
            .monad_outbox()
            .claim(
                &oversized.payload_hash,
                &oversized,
                &policy(),
                101,
                &lowered_limits,
            )
            .expect_err("legacy adoption must still enforce the stable hard member cap");
        assert!(format!("{error:#}").contains(&format!("1..={MAX_MEMBERS_HARD}")));
        assert_eq!(
            db.monad_messages()
                .get_attempt(&oversized.payload_hash, &oversized)?,
            MonadMessageAttemptClaim::ExistingExact(oversized_policy)
        );
        Ok(())
    }

    #[test]
    fn exact_legacy_adoption_uses_hard_shape_caps_not_lowered_admission_caps() -> Result<()> {
        use crate::store::monad_messages::{MonadMessageAttemptClaim, MonadMessageAttemptPolicy};

        for shape in ["canonical", "members", "network_tag", "recipient_pubkey"] {
            let tempdir = tempdir::TempDir::new("monad-outbox-legacy-shape")?;
            let db = Db::open(tempdir.path().join("db.rocksdb"))?;
            let request = message(&[b"legacy shape zero", b"legacy shape one"]);
            let frozen = policy();
            let legacy = MonadMessageAttemptPolicy {
                recipient_pubkey: frozen.recipient_pubkey.clone(),
                min_value_wei: frozen.min_value_wei,
                network_tag: Some(frozen.network_tag.clone()),
            };
            assert_eq!(
                db.monad_messages()
                    .claim_attempt(&request.payload_hash, &request, &legacy)?,
                MonadMessageAttemptClaim::New
            );
            let mut lowered = MonadOutboxLimits::default();
            match shape {
                "canonical" => lowered.max_canonical_bytes = 1,
                "members" => lowered.max_members = 1,
                "network_tag" => lowered.max_network_tag_bytes = 1,
                "recipient_pubkey" => lowered.max_recipient_pubkey_bytes = 32,
                _ => unreachable!(),
            }
            assert_eq!(
                db.monad_outbox()
                    .claim(&request.payload_hash, &request, &frozen, 1, &lowered,)?,
                MonadOutboxClaim::New,
                "legacy {shape} must be interpreted under stable hard codec ceilings"
            );
        }
        Ok(())
    }

    #[test]
    fn recovery_reservation_quota_rejects_only_new_overflow_claims() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recovery-quota")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let first = message_with_seed(b"quota-first", &[b"raw-first"]);
        let second = message_with_seed(b"quota-second", &[b"raw-second"]);
        let third = message_with_seed(b"quota-third", &[b"raw-third"]);
        let mut limits = MonadOutboxLimits::default();
        limits.max_recovery_records = 2;
        limits.max_recovery_records_per_recipient = 1;
        assert_eq!(
            store.claim(&first.payload_hash, &first, &policy(), 1, &limits)?,
            MonadOutboxClaim::New
        );
        assert_eq!(
            store.claim(&second.payload_hash, &second, &policy(), 2, &limits)?,
            MonadOutboxClaim::AtCapacity
        );
        let other_policy = policy_for_secret(0x33);
        assert_eq!(
            store.claim(&third.payload_hash, &third, &other_policy, 3, &limits)?,
            MonadOutboxClaim::New
        );
        let fourth = message_with_seed(b"quota-fourth", &[b"raw-fourth"]);
        let fourth_policy = policy_for_secret(0x36);
        assert_eq!(
            store.claim(&fourth.payload_hash, &fourth, &fourth_policy, 4, &limits)?,
            MonadOutboxClaim::AtCapacity,
            "global record count must reject even when the recipient-specific count is free"
        );
        assert!(matches!(
            store.claim(&first.payload_hash, &first, &policy(), 4, &limits)?,
            MonadOutboxClaim::ExistingExact(_)
        ));
        // C0: quota/backpressure does not evict the existing exact obligation;
        // an altered duplicate remains a conflict after the store is reopened.
        drop(db);
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        assert!(matches!(
            store.claim(&first.payload_hash, &first, &policy(), 5, &limits)?,
            MonadOutboxClaim::ExistingExact(_)
        ));
        let mut changed = first.clone();
        changed.stamp_payments[0].raw_tx.push(0xff);
        assert_eq!(
            store.claim(&first.payload_hash, &changed, &policy(), 5, &limits)?,
            MonadOutboxClaim::Conflict
        );
        assert!(matches!(
            store.claim(&first.payload_hash, &first, &policy(), 5, &limits)?,
            MonadOutboxClaim::ExistingExact(_)
        ));
        assert_eq!(
            store.claim(&second.payload_hash, &second, &policy(), 5, &limits)?,
            MonadOutboxClaim::AtCapacity
        );
        Ok(())
    }

    #[test]
    fn quota_admission_reads_constant_metadata_independent_of_corpus_size() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-quota-o1")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_active_claims = 256;
        limits.max_recovery_records = 256;
        limits.max_recovery_records_per_recipient = 256;
        limits.max_unconfirmed_claims_per_recipient = 256;
        for seed in 0..64u8 {
            let request = message_with_seed(&[seed], &[b"quota corpus"]);
            assert_eq!(
                store.claim(
                    &request.payload_hash,
                    &request,
                    &policy(),
                    seed as i64,
                    &limits
                )?,
                MonadOutboxClaim::New
            );
        }
        reset_quota_admission_meta_reads();
        begin_quota_admission_corpus_meter();
        let candidate = message_with_seed(b"quota candidate", &[b"quota candidate raw"]);
        assert_eq!(
            store.claim(&candidate.payload_hash, &candidate, &policy(), 100, &limits)?,
            MonadOutboxClaim::New
        );
        // Global counter, recipient counter + owner probe, and the O(1) per-recipient
        // unconfirmed-claim counter (read for the cap check and for the increment); none of
        // them scales with the corpus.
        assert_eq!(quota_admission_meta_reads(), 7);
        assert_eq!(
            finish_quota_admission_corpus_meter(),
            0,
            "quota admission must not decode the existing outbox corpus"
        );
        Ok(())
    }

    #[test]
    fn recovery_byte_quota_reserves_max_diagnostic_growth_and_survives_reopen() -> Result<()> {
        let request = message_with_seed(b"quota-growth-a", &[b"raw-zero", b"raw-one"]);
        let reservation = {
            let tempdir = tempdir::TempDir::new("monad-outbox-quota-measure")?;
            let db = Db::open(tempdir.path().join("db.rocksdb"))?;
            let store = db.monad_outbox();
            store.claim(
                &request.payload_hash,
                &request,
                &policy(),
                1,
                &MonadOutboxLimits::default(),
            )?;
            let hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
            let record = store.get(&hash)?.unwrap();
            let actual =
                store.retained_claim_bytes_locked(&hash, &record, encode_record(&record).len())?;
            let reserved = store.recovery_reserved_claim_bytes_locked(&hash, &record)?;
            assert_eq!(
                reserved,
                actual + 3 * MAX_LAST_ERROR_BYTES_HARD as u64,
                "record plus two members reserve their complete diagnostic growth"
            );
            reserved as usize
        };

        let second = message_with_seed(b"quota-growth-b", &[b"raw-zero", b"raw-one"]);
        let third = message_with_seed(b"quota-growth-c", &[b"raw-zero", b"raw-one"]);
        let tempdir = tempdir::TempDir::new("monad-outbox-global-quota-growth")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_recovery_bytes = reservation * 2;
        limits.max_recovery_bytes_per_recipient = usize::MAX;
        let other = policy_for_secret(0x34);
        assert_eq!(
            store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?,
            MonadOutboxClaim::New
        );
        assert_eq!(
            store.claim(&second.payload_hash, &second, &other, 2, &limits)?,
            MonadOutboxClaim::New,
            "the exact global byte boundary is admissible"
        );
        let other = policy_for_secret(0x35);
        assert_eq!(
            store.claim(&third.payload_hash, &third, &other, 3, &limits)?,
            MonadOutboxClaim::AtCapacity,
            "one byte-reserved claim beyond the global boundary is rejected"
        );

        let tempdir = tempdir::TempDir::new("monad-outbox-recipient-quota-growth")?;
        let path = tempdir.path().join("db.rocksdb");
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            let mut limits = MonadOutboxLimits::default();
            limits.max_last_error_bytes = MAX_LAST_ERROR_BYTES_HARD;
            limits.max_recovery_bytes = usize::MAX;
            limits.max_recovery_bytes_per_recipient = reservation * 2;
            assert_eq!(
                store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?,
                MonadOutboxClaim::New
            );
            assert_eq!(
                store.claim(&second.payload_hash, &second, &policy(), 2, &limits)?,
                MonadOutboxClaim::New,
                "the exact per-recipient byte boundary is admissible"
            );
            assert_eq!(
                store.claim(&third.payload_hash, &third, &policy(), 3, &limits)?,
                MonadOutboxClaim::AtCapacity
            );

            let lease = match store.acquire_reconcile_lease(&request.payload_hash, 0, 4, &limits)? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected quota fixture lease, got {other:?}"),
            };
            let detail = "x".repeat(MAX_LAST_ERROR_BYTES_HARD * 2);
            let aggregate_before = db
                .get(store.cf_outbox, &request.payload_hash)?
                .expect("claimed aggregate row");
            assert_eq!(
                store.complete_pending_member(
                    &request.payload_hash,
                    0,
                    lease,
                    &detail,
                    5,
                    &limits,
                )?,
                MonadOutboxTransition::Applied
            );
            // Member completion never rewrites the aggregate row: its bytes are identical, so an
            // oversized child diagnostic cannot grow it past its reservation.
            assert_eq!(
                db.get(store.cf_outbox, &request.payload_hash)?
                    .expect("aggregate row")
                    .as_ref(),
                aggregate_before.as_ref()
            );
            // Only the child row carries the diagnostic, hard-bounded at MAX_LAST_ERROR_BYTES_HARD.
            assert_eq!(
                store
                    .get_member(&request.payload_hash, 0)?
                    .unwrap()
                    .last_error
                    .len(),
                MAX_LAST_ERROR_BYTES_HARD
            );
            store.confirm_observed_member(&request.payload_hash, 0, 10, 7, 6)?;
            assert_eq!(
                store.terminal_observed_member(
                    &request.payload_hash,
                    1,
                    MonadOutboxTerminal::StaleNonce,
                    &detail,
                    7,
                    &limits,
                )?,
                MonadOutboxTransition::Applied
            );
            assert_eq!(
                store.get(&request.payload_hash)?.unwrap().last_error.len(),
                MAX_LAST_ERROR_BYTES_HARD
            );
            assert_eq!(
                store
                    .get_member(&request.payload_hash, 1)?
                    .unwrap()
                    .last_error
                    .len(),
                MAX_LAST_ERROR_BYTES_HARD
            );
            let hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
            let mut record = store.get(&hash)?.unwrap();
            record.last_error = "x".repeat(MAX_LAST_ERROR_BYTES_HARD);
            let fully_grown = request.stamp_payments.iter().try_fold(
                encode_record(&record).len(),
                |total, payment| -> Result<usize> {
                    let mut member = store
                        .get_member(&hash, payment.child_index)?
                        .expect("quota fixture member must exist");
                    member.last_error = "x".repeat(MAX_LAST_ERROR_BYTES_HARD);
                    Ok(total.saturating_add(encode_member(&member).len()))
                },
            )?;
            assert_eq!(
                fully_grown, reservation,
                "the admission reservation is the exact fully-grown encoded footprint"
            );
            let mut lowered = limits.clone();
            lowered.max_recovery_bytes = 0;
            lowered.max_recovery_bytes_per_recipient = 0;
            assert_eq!(
                store.claim(&third.payload_hash, &third, &policy(), 8, &lowered)?,
                MonadOutboxClaim::AtCapacity
            );
            assert_eq!(
                store
                    .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
                    .len(),
                1,
                "quota lowering never hides an existing recovery obligation"
            );
        }
        let db = Db::open(&path)?;
        let store = db.monad_outbox();
        let hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let record = store.get(&hash)?.unwrap();
        assert_eq!(
            store.recovery_reserved_claim_bytes_locked(&hash, &record)? as usize,
            reservation
        );
        assert_eq!(
            store
                .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
                .len(),
            1,
            "reopen preserves accounting and readability"
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
    fn unacknowledged_terminal_recovery_survives_gc_and_reopen_until_recipient_ack() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recipient-ack")?;
        let path = tempdir.path().join("db.rocksdb");
        let request = message_with_seed(b"ack retained", &[b"ack zero", b"ack one"]);
        let limits = MonadOutboxLimits::default();
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
            store.confirm_observed_member(&request.payload_hash, 0, 10, 7, 2)?;
            store.terminal_observed_member(
                &request.payload_hash,
                1,
                MonadOutboxTerminal::StaleNonce,
                "terminal",
                3,
                &limits,
            )?;
            let mut gc = limits.clone();
            gc.max_history_records = 0;
            gc.max_history_bytes = 0;
            gc.max_history_age = Duration::ZERO;
            store.gc_history(i64::MAX, &gc)?;
            assert!(store.get(&request.payload_hash)?.is_some());
        }
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            let recoveries = store.confirmed_prefixes_for_recipient(&policy().recipient, 1)?;
            assert_eq!(recoveries.len(), 1);
            let obligation_id = recoveries[0].obligation_id;
            assert_eq!(
                store.acknowledge_terminal_recovery(
                    &policy_for_secret(0x41).recipient,
                    &request.payload_hash,
                    &obligation_id,
                )?,
                MonadRecoveryAck::WrongRecipient
            );
            assert_eq!(
                store.acknowledge_terminal_recovery(
                    &policy().recipient,
                    &request.payload_hash,
                    &obligation_id,
                )?,
                MonadRecoveryAck::Acknowledged
            );
            assert_eq!(
                store.acknowledge_terminal_recovery(
                    &policy().recipient,
                    &request.payload_hash,
                    &obligation_id,
                )?,
                MonadRecoveryAck::Absent
            );
        }
        let db = Db::open(&path)?;
        assert!(db.monad_outbox().get(&request.payload_hash)?.is_none());
        Ok(())
    }

    #[test]
    fn chain_binding_includes_delivered_inbox_after_outbox_tombstone_gc() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-inbox-chain-binding")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let ecc = EccSecp256k1::default();
        let signer = ecc.seckey_from_array([0x51; 32]).unwrap();
        let (raw_tx, _) = crate::monad_evm_tx::test_support::signed_eip1559_tx(
            &signer,
            41_454,
            0,
            Address([0x61; 20]),
            10,
            b"chain binding",
        );
        let request = message_with_seed(b"delivered inbox chain", &[&raw_tx]);
        let mut limits = MonadOutboxLimits::default();
        store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
        store.confirm_observed_member(&request.payload_hash, 0, 10, 7, 2)?;
        assert!(store.mark_fully_confirmed(&request.payload_hash, 3)?);
        store.finalize_delivery_unchecked_for_test(&request.payload_hash, 4, &limits)?;
        limits.max_history_records = 0;
        limits.max_history_bytes = 0;
        limits.max_history_age = Duration::ZERO;
        store.gc_history(i64::MAX, &limits)?;
        assert!(store.get(&request.payload_hash)?.is_none());
        assert!(db.monad_messages().get(&request.payload_hash)?.is_some());

        assert_eq!(
            store.bind_chain_page(41_455, 1, usize::MAX)?,
            ChainBindingProgress::More
        );
        assert!(store.bind_chain_page(41_455, 1, usize::MAX).is_err());
        while store.bind_chain_page(41_454, 1, usize::MAX)? == ChainBindingProgress::More {}
        assert!(store.bind_chain_page(41_455, 1, usize::MAX).is_err());
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
    fn startup_lease_supersession_is_bounded_resumable_and_strict_forward() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-startup-pages")?;
        let path = tempdir.path().join("db.rocksdb");
        let limits = MonadOutboxLimits::default();
        let mut hashes = Vec::new();
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            for seed in 0..5u8 {
                let request = message_with_seed(&[0xd0, seed], &[b"startup lease"]);
                store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
                let hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
                hashes.push(hash);
                assert!(matches!(
                    store.acquire_reconcile_lease(&hash, 0, 2, &limits)?,
                    MonadOutboxLeaseAcquire::Acquired { .. }
                ));
            }
            let page = store.supersede_startup_leases_page(3, 2, usize::MAX)?;
            assert_eq!(page.claims, 2);
            assert!(!page.complete);
        }
        let db = Db::open(&path)?;
        let store = db.monad_outbox();
        let mut maximum_claims = 0;
        loop {
            let page = store.supersede_startup_leases_page(4, 2, 1024 * 1024)?;
            maximum_claims = maximum_claims.max(page.claims);
            if page.complete {
                break;
            }
            assert!(page.claims == 1 || page.bytes <= 1024 * 1024);
        }
        assert!(maximum_claims <= 2);
        for hash in hashes {
            assert_eq!(store.get_member(&hash, 0)?.unwrap().lease_until_ms, 0);
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
            let delivered = store.finalize_delivery_unchecked_for_test(
                &payload_hash,
                300,
                &MonadOutboxLimits::default(),
            )?;
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
                    .finalize_delivery_unchecked_for_test(
                        &payload_hash,
                        400,
                        &MonadOutboxLimits::default(),
                    )?
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
                    timestamp: 100,
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
                exposed: false,
                lease_generation: 0,
                lease_until_ms: 0,
                next_replay_at_ms: 200,
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
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-lifecycle-v3")?;
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-lifecycle-v3-cursor")?;
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
        let migrated = db.monad_messages().get(&payload_hash)?.unwrap();
        assert_eq!(migrated.timestamp, 300);
        assert_eq!(
            db.monad_messages()
                .list_for_recipient_since(&policy().recipient, 200)?,
            vec![migrated]
        );
        Ok(())
    }

    #[test]
    fn delivered_v1_migration_rejects_missing_inbox_owner() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v1-delivered-missing")?;
        let path = tempdir.path().join("db.rocksdb");
        let request = message_with_seed(b"legacy missing inbox", &[b"legacy raw"]);
        {
            let db = Db::open(&path)?;
            put_legacy_v1_delivered_record(&db, &request)?;
        }
        let error = Db::open(&path).expect_err("missing inbox owner must fail migration");
        assert!(format!("{error:#}").contains("no inbox owner"));
        Ok(())
    }

    #[test]
    fn delivered_v1_migration_rejects_mismatched_inbox_owner() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v1-delivered-mismatch")?;
        let path = tempdir.path().join("db.rocksdb");
        let request = message_with_seed(b"legacy expected inbox", &[b"legacy raw"]);
        let mismatched = message_with_seed(b"different inbox message", &[b"legacy raw"]);
        {
            let db = Db::open(&path)?;
            let payload_hash = put_legacy_v1_delivered_record(&db, &request)?;
            db.monad_messages().put(
                &payload_hash,
                &policy().recipient,
                &proto::StoredMonadMessage {
                    message: Some(mismatched),
                    timestamp: 300,
                    network_tag: policy().network_tag,
                },
            )?;
        }
        let error = Db::open(&path).expect_err("mismatched inbox owner must fail migration");
        assert!(format!("{error:#}").contains("differs from its inbox owner"));
        Ok(())
    }

    #[test]
    fn migration_indexes_v1_terminal_gc_without_erasing_confirmed_prefix() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v1-terminal")?;
        let path = tempdir.path().join("db.rocksdb");
        let now = unix_now_ms();
        let no_prefix = message_with_seed(b"v1 terminal no prefix", &[b"raw-no-prefix"]);
        let with_prefix = message_with_seed(
            b"v1 terminal prefix",
            &[b"raw-prefix-zero", b"raw-prefix-one"],
        );
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            for (request, confirmed_prefix) in [(&no_prefix, false), (&with_prefix, true)] {
                let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
                let policy = policy();
                let mut record = vec![
                    RECORD_VERSION_V1,
                    3,
                    terminal_tag(MonadOutboxTerminal::StaleNonce),
                ];
                record.extend_from_slice(&(now - 10).to_be_bytes());
                record.extend_from_slice(&now.to_be_bytes());
                record.extend_from_slice(&1u32.to_be_bytes());
                record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
                record.extend_from_slice(&policy.recipient.0);
                put_bytes(&mut record, &policy.recipient_pubkey);
                put_bytes(&mut record, &policy.network_tag);
                put_bytes(&mut record, b"legacy terminal");
                put_bytes(&mut record, &request.encode_to_vec());
                db.put(store.cf_outbox, payload_hash, record)?;
                for payment in &request.stamp_payments {
                    let member = MonadOutboxMember {
                        child_index: payment.child_index,
                        tx_hash: Hash32(Keccak256::digest(&payment.raw_tx).into()),
                        state: if confirmed_prefix && payment.child_index == 0 {
                            MonadOutboxMemberState::Confirmed {
                                value_wei: 10,
                                block_number: 1,
                            }
                        } else {
                            MonadOutboxMemberState::Terminal(MonadOutboxTerminal::StaleNonce)
                        },
                        attempts: 1,
                        exposed: false,
                        lease_generation: 0,
                        lease_until_ms: 0,
                        next_replay_at_ms: now,
                        updated_at_ms: now,
                        last_error: String::new(),
                    };
                    db.put(
                        store.cf_members,
                        member_key(&payload_hash, payment.child_index),
                        encode_member(&member),
                    )?;
                }
                if confirmed_prefix {
                    db.put(
                        store.cf_recipient,
                        recipient_key(&policy.recipient, &payload_hash),
                        [],
                    )?;
                }
            }
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-lifecycle-v3")?;
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-lifecycle-v3-cursor")?;
            // A genuinely pre-v5 database has neither quota nor obligation-identity state.
            for key in [
                RECOVERY_QUOTA_MIGRATION_KEY,
                RECOVERY_QUOTA_CURSOR_KEY,
                RECOVERY_QUOTA_GLOBAL_KEY,
                RECOVERY_OBLIGATION_MIGRATION_KEY,
                RECOVERY_OBLIGATION_CURSOR_KEY,
            ] {
                db.rocksdb().delete_cf(store.cf_meta, key)?;
            }
        }
        let db = Db::open(&path)?;
        let store = db.monad_outbox();
        let no_prefix_hash: [u8; 32] = no_prefix.payload_hash.as_slice().try_into().unwrap();
        assert!(db
            .rocksdb()
            .iterator_cf(store.cf_history, IteratorMode::Start)
            .any(|item| decode_history_key(&item.unwrap().0).unwrap().1 == no_prefix_hash));
        let mut zero = MonadOutboxLimits::default();
        zero.max_history_records = 0;
        zero.max_history_bytes = 0;
        zero.max_history_age = Duration::from_secs(u64::MAX);
        store.gc_history(now, &zero)?;
        assert!(store.get(&no_prefix_hash)?.is_none());
        let recoveries = store.confirmed_prefixes_for_recipient(&policy().recipient, 10)?;
        assert_eq!(recoveries.len(), 1);
        assert_eq!(
            recoveries[0].payload_hash.as_slice(),
            with_prefix.payload_hash
        );
        assert_eq!(recoveries[0].confirmed_prefix.len(), 1);
        Ok(())
    }

    #[test]
    fn migration_and_gc_fail_closed_on_missing_primary_recovery_facts() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-corrupt-recovery-facts")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let limits = MonadOutboxLimits::default();

        let missing_index = message_with_seed(b"missing index", &[b"zero", b"one"]);
        store.claim(
            &missing_index.payload_hash,
            &missing_index,
            &policy(),
            1,
            &limits,
        )?;
        store.confirm_observed_member(&missing_index.payload_hash, 0, 10, 7, 2)?;
        store.terminal_observed_member(
            &missing_index.payload_hash,
            1,
            MonadOutboxTerminal::StaleNonce,
            "terminal",
            3,
            &limits,
        )?;
        let missing_index_hash: [u8; 32] =
            missing_index.payload_hash.as_slice().try_into().unwrap();
        let before_record = db
            .get(store.cf_outbox, missing_index_hash)?
            .unwrap()
            .to_vec();
        let before_member = db
            .get(store.cf_members, member_key(&missing_index_hash, 0))?
            .unwrap()
            .to_vec();
        db.rocksdb().delete_cf(
            store.cf_recipient,
            recipient_key(&policy().recipient, &missing_index_hash),
        )?;
        db.put(
            store.cf_history,
            history_key(3, &missing_index_hash),
            1u64.to_be_bytes(),
        )?;
        let mut strict_gc = limits.clone();
        strict_gc.max_history_records = 0;
        assert!(store.gc_history(4, &strict_gc).is_err());
        assert_eq!(
            db.get(store.cf_outbox, missing_index_hash)?
                .unwrap()
                .as_ref(),
            before_record
        );
        assert_eq!(
            db.get(store.cf_members, member_key(&missing_index_hash, 0))?
                .unwrap()
                .as_ref(),
            before_member
        );

        let missing_member = message_with_seed(b"missing member", &[b"only"]);
        store.claim(
            &missing_member.payload_hash,
            &missing_member,
            &policy(),
            5,
            &limits,
        )?;
        let missing_member_hash: [u8; 32] =
            missing_member.payload_hash.as_slice().try_into().unwrap();
        let mut terminal = store.get(&missing_member_hash)?.unwrap();
        terminal.lifecycle = MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::StaleNonce);
        terminal.updated_at_ms = 6;
        let encoded_terminal = encode_record(&terminal);
        db.put(store.cf_outbox, missing_member_hash, &encoded_terminal)?;
        db.rocksdb()
            .delete_cf(store.cf_members, member_key(&missing_member_hash, 0))?;
        db.rocksdb()
            .delete_cf(store.cf_meta, b"outbox-terminal-recovery-v4")?;
        assert!(store
            .migrate_terminal_recovery_classification(&limits)
            .is_err());
        assert_eq!(
            db.get(store.cf_outbox, missing_member_hash)?
                .unwrap()
                .as_ref(),
            encoded_terminal
        );
        assert!(db
            .get(store.cf_members, member_key(&missing_member_hash, 0))?
            .is_none());
        Ok(())
    }

    #[test]
    fn v4_migration_reclassifies_deployed_no_prefix_terminal_state() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v4-deployed-upgrade")?;
        let path = tempdir.path().join("db.rocksdb");
        let no_prefix = message_with_seed(b"v4 stale no prefix", &[b"no-prefix-raw"]);
        let with_prefix =
            message_with_seed(b"v4 retained prefix", &[b"prefix-zero", b"prefix-one"]);
        let preexisting_history = message_with_seed(b"v4 preexisting history", &[b"history-raw"]);
        let limits = MonadOutboxLimits::default();
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            store.claim(
                &preexisting_history.payload_hash,
                &preexisting_history,
                &policy(),
                80,
                &limits,
            )?;
            store.confirm_observed_member(&preexisting_history.payload_hash, 0, 10, 7, 81)?;
            assert!(store.mark_fully_confirmed(&preexisting_history.payload_hash, 82)?);
            store.finalize_delivery_unchecked_for_test(
                &preexisting_history.payload_hash,
                83,
                &limits,
            )?;
            store.claim(&no_prefix.payload_hash, &no_prefix, &policy(), 100, &limits)?;
            store.terminal_observed_member(
                &no_prefix.payload_hash,
                0,
                MonadOutboxTerminal::StaleNonce,
                "deployed terminal",
                102,
                &limits,
            )?;
            let no_prefix_hash: [u8; 32] = no_prefix.payload_hash.as_slice().try_into().unwrap();
            db.put(
                store.cf_recipient,
                recipient_key(&policy().recipient, &no_prefix_hash),
                [],
            )?;

            store.claim(
                &with_prefix.payload_hash,
                &with_prefix,
                &policy(),
                110,
                &limits,
            )?;
            store.confirm_observed_member(&with_prefix.payload_hash, 0, 10, 7, 111)?;
            store.terminal_observed_member(
                &with_prefix.payload_hash,
                1,
                MonadOutboxTerminal::StaleNonce,
                "retained recovery obligation",
                112,
                &limits,
            )?;
            db.rocksdb()
                .delete_cf(store.cf_history, history_key(102, &no_prefix_hash))?;
            assert!(db.get(store.cf_meta, b"outbox-lifecycle-v3")?.is_some());
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-terminal-recovery-v4")?;
            db.rocksdb()
                .delete_cf(store.cf_meta, b"outbox-terminal-recovery-v4-cursor")?;
            assert!(db
                .get(store.cf_meta, b"outbox-terminal-recovery-v4")?
                .is_none());
            assert_eq!(
                db.rocksdb()
                    .iterator_cf(store.cf_history, IteratorMode::Start)
                    .count(),
                1,
                "the deployed v3 fixture retains real history before the v4 migration"
            );
            let preexisting_history_hash: [u8; 32] = preexisting_history
                .payload_hash
                .as_slice()
                .try_into()
                .unwrap();
            assert!(db
                .get(store.cf_history, history_key(83, &preexisting_history_hash))?
                .is_some());
            assert!(store.get(&no_prefix_hash)?.is_some());
            assert!(db
                .get(
                    store.cf_recipient,
                    recipient_key(&policy().recipient, &no_prefix_hash),
                )?
                .is_some());
        }

        let mut migration_limits = limits;
        migration_limits.max_history_age = Duration::from_secs(u64::MAX);
        let db = Db::open_with_monad_outbox_limits(&path, &migration_limits)?;
        let store = db.monad_outbox();
        assert!(db
            .get(store.cf_meta, b"outbox-terminal-recovery-v4")?
            .is_some());
        let no_prefix_hash: [u8; 32] = no_prefix.payload_hash.as_slice().try_into().unwrap();
        assert!(store.get(&no_prefix_hash)?.is_some());
        assert!(db
            .get(
                store.cf_recipient,
                recipient_key(&policy().recipient, &no_prefix_hash),
            )?
            .is_none());
        let preexisting_history_hash: [u8; 32] = preexisting_history
            .payload_hash
            .as_slice()
            .try_into()
            .unwrap();
        assert!(db
            .get(store.cf_history, history_key(83, &preexisting_history_hash),)?
            .is_some());
        assert_eq!(
            db.rocksdb()
                .iterator_cf(store.cf_history, IteratorMode::Start)
                .count(),
            2,
            "v4 adds the deployed no-prefix terminal row without replacing retained history"
        );
        let recoveries = store.confirmed_prefixes_for_recipient(&policy().recipient, 10)?;
        assert_eq!(recoveries.len(), 1);
        assert_eq!(
            recoveries[0].payload_hash.as_slice(),
            with_prefix.payload_hash
        );
        assert_eq!(recoveries[0].confirmed_prefix.len(), 1);
        let quota_candidate = message_with_seed(b"v4 quota candidate", &[b"candidate-raw"]);
        let quota_overflow = message_with_seed(b"v4 quota overflow", &[b"overflow-raw"]);
        let mut recovery_limits = migration_limits.clone();
        recovery_limits.max_recovery_records = 2;
        recovery_limits.max_recovery_records_per_recipient = 2;
        assert_eq!(
            store.claim(
                &quota_candidate.payload_hash,
                &quota_candidate,
                &policy(),
                120,
                &recovery_limits,
            )?,
            MonadOutboxClaim::New,
            "migrated nonrecoverable history must not consume recovery quota"
        );
        assert_eq!(
            store.claim(
                &quota_overflow.payload_hash,
                &quota_overflow,
                &policy(),
                121,
                &recovery_limits,
            )?,
            MonadOutboxClaim::AtCapacity,
            "the independent recovery quota still applies to active obligations"
        );
        let mut zero_history = migration_limits;
        zero_history.max_history_records = 0;
        zero_history.max_history_bytes = 0;
        store.gc_history(1_000, &zero_history)?;
        assert!(store.get(&no_prefix_hash)?.is_none());
        assert_eq!(
            db.rocksdb()
                .iterator_cf(store.cf_history, IteratorMode::Start)
                .count(),
            0,
            "configured zero-history GC removes the migrated terminal row"
        );
        assert_eq!(
            store
                .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
                .len(),
            1,
            "history GC cannot remove the confirmed-prefix obligation"
        );
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
            store.finalize_delivery_unchecked_for_test(
                &request.payload_hash,
                300 + index as i64,
                &limits,
            )?;
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
            store.finalize_delivery_unchecked_for_test(&delivered.payload_hash, 130, &limits)?;
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
        assert!(store
            .confirmed_prefixes_for_recipient(&policy().recipient, 0)?
            .is_empty());
        Ok(())
    }

    #[test]
    fn recovery_pages_are_strict_forward_scan_and_byte_bounded() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recovery-pages")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let limits = MonadOutboxLimits::default();
        let store = db.monad_outbox();
        let mut requests = (0..3u8)
            .map(|index| {
                let seed = vec![0x40 + index; 16];
                let raw0 = vec![0x80 + index; 24];
                let raw1 = vec![0xc0 + index; 24];
                message_with_seed(&seed, &[&raw0, &raw1])
            })
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| left.payload_hash.cmp(&right.payload_hash));
        for request in &requests {
            store.claim(&request.payload_hash, request, &policy(), 100, &limits)?;
            store.confirm_observed_member(&request.payload_hash, 0, 10, 1, 110)?;
        }

        let mut cursor = None;
        let mut recovered = Vec::new();
        loop {
            let page = store.confirmed_prefixes_for_recipient_page(
                &policy().recipient,
                cursor,
                1,
                1,
                usize::MAX,
                usize::MAX,
            )?;
            assert!(page.scanned <= 1);
            recovered.extend(page.recoveries.iter().map(|item| item.payload_hash));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            recovered,
            requests
                .iter()
                .map(|request| request.payload_hash.as_slice().try_into().unwrap())
                .collect::<Vec<[u8; 32]>>()
        );

        let required = requests[0].encoded_len();
        let err = store
            .confirmed_prefixes_for_recipient_page(
                &policy().recipient,
                None,
                1,
                1,
                required - 1,
                usize::MAX,
            )
            .unwrap_err();
        assert!(matches!(
            err.downcast_ref::<DbMonadOutboxError>(),
            Some(DbMonadOutboxError::RecoveryRecordExceedsPageBudget { .. })
        ));
        store.confirm_observed_member(&requests[0].payload_hash, 1, 10, 2, 120)?;
        assert!(store.mark_fully_confirmed(&requests[0].payload_hash, 130)?);
        store.finalize_delivery_unchecked_for_test(&requests[0].payload_hash, 140, &limits)?;
        let after_deleted = store.confirmed_prefixes_for_recipient_page(
            &policy().recipient,
            Some(recovered[0]),
            1,
            1,
            usize::MAX,
            usize::MAX,
        )?;
        assert_eq!(after_deleted.recoveries[0].payload_hash, recovered[1]);
        Ok(())
    }

    #[test]
    fn recovery_budget_charges_record_and_member_lookahead_without_skipping_row() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recovery-lookahead")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let limits = MonadOutboxLimits::default();
        let first = message_with_seed(b"lookahead-small", &[b"small-member"]);
        let second = (0u32..)
            .map(|suffix| {
                message_with_seed(
                    &suffix.to_be_bytes(),
                    &[b"large-zero", b"large-one", b"large-two"],
                )
            })
            .find(|candidate| candidate.payload_hash > first.payload_hash)
            .expect("a lexicographically later recovery fixture must exist");
        let requests = vec![first, second];
        for request in &requests {
            store.claim(&request.payload_hash, request, &policy(), 1, &limits)?;
            store.confirm_observed_member(&request.payload_hash, 0, 10, 7, 2)?;
        }
        let first_hash: [u8; 32] = requests[0].payload_hash.as_slice().try_into().unwrap();
        let second_hash: [u8; 32] = requests[1].payload_hash.as_slice().try_into().unwrap();
        let encoded_len = |cf: &CF, key: Vec<u8>| -> Result<usize> {
            Ok(db
                .get(cf, key)?
                .expect("recovery lookahead fixture row must exist")
                .len())
        };
        let first_record = encoded_len(store.cf_outbox, first_hash.to_vec())?;
        let first_member = encoded_len(store.cf_members, member_key(&first_hash, 0).to_vec())?;
        let first_work = first_record + first_member;
        let second_record = encoded_len(store.cf_outbox, second_hash.to_vec())?;
        let second_member0 = encoded_len(store.cf_members, member_key(&second_hash, 0).to_vec())?;
        let second_member1 = encoded_len(store.cf_members, member_key(&second_hash, 1).to_vec())?;

        reset_recovery_page_work_counts();
        let record_overflow = store.confirmed_prefixes_for_recipient_page(
            &policy().recipient,
            None,
            2,
            2,
            usize::MAX,
            first_work + second_record - 1,
        )?;
        assert_eq!(record_overflow.recoveries.len(), 1);
        assert_eq!(record_overflow.next_cursor, Some(first_hash));
        assert_eq!(record_overflow.inspected_bytes, first_work + second_record);
        assert_eq!(
            recovery_page_work_counts(),
            (3, first_work + second_record, 2, first_work),
            "the overflowing second record is charged as read but not decoded"
        );

        reset_recovery_page_work_counts();
        let member_overflow = store.confirmed_prefixes_for_recipient_page(
            &policy().recipient,
            None,
            2,
            2,
            usize::MAX,
            first_work + second_record + second_member0 + second_member1 - 1,
        )?;
        let charged = first_work + second_record + second_member0 + second_member1;
        assert_eq!(member_overflow.recoveries.len(), 1);
        assert_eq!(member_overflow.next_cursor, Some(first_hash));
        assert_eq!(member_overflow.inspected_bytes, charged);
        assert_eq!(
            recovery_page_work_counts(),
            (5, charged, 4, charged - second_member1),
            "the overflowing later member is charged as read but not decoded"
        );
        let resumed = store.confirmed_prefixes_for_recipient_page(
            &policy().recipient,
            member_overflow.next_cursor,
            1,
            1,
            usize::MAX,
            usize::MAX,
        )?;
        assert_eq!(resumed.recoveries.len(), 1);
        assert_eq!(resumed.recoveries[0].payload_hash, second_hash);
        Ok(())
    }

    #[test]
    fn recovery_scan_meters_filtered_rows_and_advances_to_later_obligation() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-recovery-meter")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let limits = MonadOutboxLimits::default();
        let mut requests = vec![
            message_with_seed(b"meter-a", &[b"raw-a"]),
            message_with_seed(b"meter-b", &[b"raw-b"]),
            message_with_seed(b"meter-c", &[b"raw-c"]),
        ];
        requests.sort_by(|left, right| left.payload_hash.cmp(&right.payload_hash));
        for request in &requests {
            store.claim(&request.payload_hash, request, &policy(), 1, &limits)?;
        }
        for request in &requests[..2] {
            db.put(
                store.cf_recipient,
                recipient_key(
                    &policy().recipient,
                    request.payload_hash.as_slice().try_into().unwrap(),
                ),
                [],
            )?;
        }
        store.confirm_observed_member(&requests[2].payload_hash, 0, 10, 7, 2)?;

        let mut cursor = None;
        for expected in 0..2 {
            let page = store.confirmed_prefixes_for_recipient_page(
                &policy().recipient,
                cursor,
                1,
                1,
                limits.max_canonical_bytes,
                limits.max_canonical_bytes,
            )?;
            assert!(page.recoveries.is_empty());
            assert_eq!(page.scanned, 1);
            assert!(page.inspected_bytes > 0);
            cursor = page.next_cursor;
            assert_eq!(
                cursor,
                Some(
                    requests[expected]
                        .payload_hash
                        .as_slice()
                        .try_into()
                        .unwrap()
                )
            );
        }
        let page = store.confirmed_prefixes_for_recipient_page(
            &policy().recipient,
            cursor,
            1,
            1,
            limits.max_canonical_bytes,
            limits.max_canonical_bytes,
        )?;
        assert_eq!(page.recoveries.len(), 1);
        assert_eq!(
            page.recoveries[0].payload_hash,
            requests[2].payload_hash.as_slice()
        );
        assert!(page.inspected_bytes > page.canonical_bytes);
        Ok(())
    }

    #[test]
    fn active_claim_and_error_bounds_fail_closed() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-bounds")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let mut limits = MonadOutboxLimits::default();
        limits.max_active_claims = 1;
        limits.max_last_error_bytes = 5;
        limits.max_member_attempts = 1;
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        let first = message(&[b"raw zero"]);
        let mut too_small = limits.clone();
        too_small.max_canonical_bytes = 1;
        assert!(db
            .monad_outbox()
            .claim(&first.payload_hash, &first, &policy(), 100, &too_small)
            .is_err());
        let mut over_codec_cap = limits.clone();
        over_codec_cap.max_last_error_bytes = MAX_LAST_ERROR_BYTES_HARD + 1;
        assert!(matches!(
            db.monad_outbox()
                .claim(&first.payload_hash, &first, &policy(), 100, &over_codec_cap),
            Err(_)
        ));
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

        let mut expired_limits = limits.clone();
        expired_limits.max_claim_age = Duration::ZERO;
        assert_eq!(
            db.monad_outbox().claim(
                &second.payload_hash,
                &second,
                &policy(),
                100,
                &expired_limits,
            )?,
            MonadOutboxClaim::New
        );
        let expired_lease = match db.monad_outbox().acquire_reconcile_lease(
            &second.payload_hash,
            0,
            101,
            &expired_limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        let expired = db.monad_outbox().begin_replay_attempt(
            &second.payload_hash,
            0,
            expired_lease,
            101,
            &expired_limits,
        )?;
        assert_eq!(
            expired,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
        );
        Ok(())
    }

    #[test]
    fn retry_expiry_and_attempt_policy_is_frozen_at_claim_and_reopen() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-frozen-policy")?;
        let path = tempdir.path().join("db.rocksdb");
        let request = message(&[b"frozen policy raw"]);
        let mut accepted = MonadOutboxLimits::default();
        accepted.max_claim_age = Duration::from_millis(100);
        accepted.max_member_attempts = 2;
        accepted.retry_backoff_base = Duration::from_millis(7);
        accepted.max_retry_backoff = Duration::from_millis(9);
        {
            let db = Db::open(&path)?;
            db.monad_outbox()
                .claim(&request.payload_hash, &request, &policy(), 100, &accepted)?;
        }
        let db = Db::open(&path)?;
        let store = db.monad_outbox();
        let record = store.get(&request.payload_hash)?.unwrap();
        assert_eq!(record.expires_at_ms, 200);
        assert_eq!(record.max_member_attempts, 2);
        assert_eq!(record.retry_backoff_base_ms, 7);
        assert_eq!(record.max_retry_backoff_ms, 9);
        let mut changed = accepted.clone();
        changed.max_claim_age = Duration::ZERO;
        changed.max_member_attempts = 0;
        changed.retry_backoff_base = Duration::from_secs(60);
        let lease = match store.acquire_reconcile_lease(&request.payload_hash, 0, 150, &changed)? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        assert!(matches!(
            store.begin_replay_attempt(&request.payload_hash, 0, lease, 150, &changed)?,
            MonadOutboxReplayStart::Started(_)
        ));
        store.complete_pending_member(&request.payload_hash, 0, lease, "retry", 150, &changed)?;
        assert_eq!(
            store
                .get_member(&request.payload_hash, 0)?
                .unwrap()
                .next_replay_at_ms,
            157
        );
        Ok(())
    }

    #[test]
    fn history_gc_converges_past_one_chunk_and_honors_bytes_and_age() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-history-converges")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let tombstone = MonadOutboxRecord {
            canonical_message: None,
            policy: None,
            created_at_ms: 0,
            updated_at_ms: 0,
            expires_at_ms: 0,
            max_member_attempts: 0,
            retry_backoff_base_ms: 0,
            max_retry_backoff_ms: 0,
            lifecycle: MonadOutboxLifecycle::Delivered,
            reconciliation_attempts: 0,
            last_error: String::new(),
        };
        let encoded = encode_record(&tombstone);
        let mut batch = rocksdb::WriteBatch::default();
        for index in 0..(MAX_HISTORY_RECORDS_HARD + 17) {
            let hash: [u8; 32] = Sha256::digest(index.to_be_bytes().as_slice().into())
                .as_slice()
                .try_into()
                .unwrap();
            batch.put_cf(store.cf_outbox, hash, &encoded);
            batch.put_cf(
                store.cf_history,
                history_key(index as i64, &hash),
                (encoded.len() as u64).to_be_bytes(),
            );
        }
        db.write_batch(batch)?;
        let mut limits = MonadOutboxLimits::default();
        limits.max_history_records = 0;
        limits.max_history_bytes = usize::MAX;
        limits.max_history_age = Duration::from_secs(u64::MAX);
        store.gc_history(10_000, &limits)?;
        assert_eq!(
            db.rocksdb()
                .iterator_cf(store.cf_history, IteratorMode::Start)
                .count(),
            0
        );

        for (timestamp, bytes, now_ms, max_bytes, max_age) in [
            (20_000i64, 10u64, 20_000i64, 0usize, Duration::from_secs(60)),
            (1i64, 10u64, 2i64, usize::MAX, Duration::ZERO),
        ] {
            let hash: [u8; 32] = Sha256::digest(timestamp.to_be_bytes().as_slice().into())
                .as_slice()
                .try_into()
                .unwrap();
            db.put(
                store.cf_history,
                history_key(timestamp, &hash),
                bytes.to_be_bytes(),
            )?;
            limits.max_history_records = MAX_HISTORY_RECORDS_HARD;
            limits.max_history_bytes = max_bytes;
            limits.max_history_age = max_age;
            store.gc_history(now_ms, &limits)?;
            assert!(db
                .get(store.cf_history, history_key(timestamp, &hash))?
                .is_none());
        }
        Ok(())
    }

    #[test]
    fn reopen_runs_gc_after_crash_between_history_batch_and_gc() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-history-reopen")?;
        let path = tempdir.path().join("db.rocksdb");
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            let now = unix_now_ms();
            let terminal_message = message(&[b"migration terminal"]);
            let terminal = MonadOutboxRecord {
                canonical_message: Some(terminal_message.encode_to_vec()),
                policy: Some(policy()),
                created_at_ms: now,
                updated_at_ms: now,
                expires_at_ms: now,
                max_member_attempts: 1,
                retry_backoff_base_ms: 0,
                max_retry_backoff_ms: 0,
                lifecycle: MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::StaleNonce),
                reconciliation_attempts: 1,
                last_error: String::new(),
            };
            let terminal_hash: [u8; 32] = [0xfe; 32];
            db.put(store.cf_outbox, terminal_hash, encode_record(&terminal))?;
            db.put(
                store.cf_members,
                member_key(&terminal_hash, 0),
                encode_member(&MonadOutboxMember {
                    child_index: 0,
                    tx_hash: Hash32(
                        Keccak256::digest(&terminal_message.stamp_payments[0].raw_tx).into(),
                    ),
                    state: MonadOutboxMemberState::Pending,
                    attempts: 0,
                    exposed: false,
                    lease_generation: 0,
                    lease_until_ms: 0,
                    next_replay_at_ms: 0,
                    updated_at_ms: now,
                    last_error: String::new(),
                }),
            )?;
            let mut batch = rocksdb::WriteBatch::default();
            for index in 0..=MAX_HISTORY_RECORDS_HARD {
                let hash: [u8; 32] = Sha256::digest(index.to_be_bytes().as_slice().into())
                    .as_slice()
                    .try_into()
                    .unwrap();
                batch.put_cf(
                    store.cf_history,
                    history_key(index as i64, &hash),
                    1u64.to_be_bytes(),
                );
            }
            batch.delete_cf(store.cf_meta, b"outbox-lifecycle-v3");
            batch.delete_cf(store.cf_meta, b"outbox-lifecycle-v3-cursor");
            db.write_batch(batch)?;
        }

        arm_migration_failpoint_after_batch_before_gc();
        assert!(
            Db::open(&path).is_err(),
            "failpoint must simulate the crash window"
        );

        let db = Db::open(&path)?;
        let history_count = db
            .rocksdb()
            .iterator_cf(db.monad_outbox().cf_history, IteratorMode::Start)
            .count();
        assert!(history_count <= MAX_HISTORY_RECORDS_HARD);
        Ok(())
    }

    #[test]
    fn config_aware_reopen_preserves_permissive_history_and_applies_stricter_policy() -> Result<()>
    {
        let tempdir = tempdir::TempDir::new("monad-outbox-configured-reopen")?;
        let path = tempdir.path().join("db.rocksdb");
        let old = unix_now_ms().saturating_sub(31 * 24 * 60 * 60 * 1000);
        let payload_hash = [0xd1; 32];
        let record = MonadOutboxRecord {
            canonical_message: None,
            policy: None,
            created_at_ms: old,
            updated_at_ms: old,
            expires_at_ms: old,
            max_member_attempts: 0,
            retry_backoff_base_ms: 0,
            max_retry_backoff_ms: 0,
            lifecycle: MonadOutboxLifecycle::Delivered,
            reconciliation_attempts: 0,
            last_error: String::new(),
        };
        let encoded = encode_record(&record);
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            db.put(store.cf_outbox, payload_hash, &encoded)?;
            db.put(
                store.cf_history,
                history_key(old, &payload_hash),
                (encoded.len() as u64).to_be_bytes(),
            )?;
        }
        let mut permissive = MonadOutboxLimits::default();
        permissive.max_history_age = Duration::from_secs(365 * 24 * 60 * 60);
        let db = Db::open_with_monad_outbox_limits(&path, &permissive)?;
        assert!(db.monad_outbox().get(&payload_hash)?.is_some());
        drop(db);

        let mut strict = permissive;
        strict.max_history_records = 0;
        let db = Db::open_with_monad_outbox_limits(&path, &strict)?;
        assert!(db.monad_outbox().get(&payload_hash)?.is_none());
        Ok(())
    }

    #[test]
    fn crash_resumed_migration_reuses_supplied_retention_limits() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-configured-crash")?;
        let path = tempdir.path().join("db.rocksdb");
        let old = unix_now_ms().saturating_sub(31 * 24 * 60 * 60 * 1000);
        let request = message_with_seed(b"configured crash", &[b"migration raw"]);
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            let terminal = MonadOutboxRecord {
                canonical_message: Some(request.encode_to_vec()),
                policy: Some(policy()),
                created_at_ms: old,
                updated_at_ms: old,
                expires_at_ms: old,
                max_member_attempts: 1,
                retry_backoff_base_ms: 0,
                max_retry_backoff_ms: 0,
                lifecycle: MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::StaleNonce),
                reconciliation_attempts: 1,
                last_error: String::new(),
            };
            let mut batch = rocksdb::WriteBatch::default();
            batch.put_cf(store.cf_outbox, payload_hash, encode_record(&terminal));
            batch.put_cf(
                store.cf_members,
                member_key(&payload_hash, 0),
                encode_member(&MonadOutboxMember {
                    child_index: 0,
                    tx_hash: Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into()),
                    state: MonadOutboxMemberState::Pending,
                    attempts: 0,
                    exposed: false,
                    lease_generation: 0,
                    lease_until_ms: 0,
                    next_replay_at_ms: 0,
                    updated_at_ms: old,
                    last_error: String::new(),
                }),
            );
            batch.delete_cf(store.cf_meta, b"outbox-lifecycle-v3");
            batch.delete_cf(store.cf_meta, b"outbox-lifecycle-v3-cursor");
            db.write_batch(batch)?;
        }
        let mut permissive = MonadOutboxLimits::default();
        permissive.max_history_age = Duration::from_secs(365 * 24 * 60 * 60);
        arm_migration_failpoint_after_batch_before_gc();
        assert!(Db::open_with_monad_outbox_limits(&path, &permissive).is_err());

        let db = Db::open_with_monad_outbox_limits(&path, &permissive)?;
        assert!(db.monad_outbox().get(&payload_hash)?.is_some());
        Ok(())
    }

    #[test]
    fn terminal_history_accounts_for_staged_member_bytes() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-history-bytes")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let request = message(&[b"terminal byte accounting"]);
        let limits = MonadOutboxLimits::default();
        store.claim(&request.payload_hash, &request, &policy(), 100, &limits)?;
        let lease = match store.acquire_reconcile_lease(&request.payload_hash, 0, 101, &limits)? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        };
        store.complete_terminal_member(
            &request.payload_hash,
            0,
            lease,
            MonadOutboxTerminal::StaleNonce,
            "terminal",
            102,
            &limits,
        )?;
        let hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let record = store.get(&hash)?.unwrap();
        let member = store.get_member(&hash, 0)?.unwrap();
        let retained = db.get(store.cf_history, history_key(102, &hash))?.unwrap();
        assert_eq!(
            u64::from_be_bytes(retained.as_ref().try_into().unwrap()),
            (encode_record(&record).len() + encode_member(&member).len()) as u64
        );
        Ok(())
    }

    #[test]
    fn atomic_publication_rejects_arbitrary_non_evm_canonical_bytes() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-finalize-authority")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let request = message(&[b"not a signed EVM transaction"]);
        let limits = MonadOutboxLimits::default();
        store.claim(&request.payload_hash, &request, &policy(), 100, &limits)?;
        store.confirm_observed_member(&request.payload_hash, 0, 10, 1, 200)?;
        assert!(store.mark_fully_confirmed(&request.payload_hash, 250)?);

        let error = store
            .finalize_delivery(&request.payload_hash, 300, 41_454, &limits)
            .expect_err("the atomic publication boundary must revalidate signed EVM bytes");
        assert!(format!("{error:#}").contains("signed payment"));
        assert!(db.monad_messages().get(&request.payload_hash)?.is_none());
        assert_eq!(
            store.get(&request.payload_hash)?.unwrap().lifecycle,
            MonadOutboxLifecycle::FullyConfirmed
        );
        Ok(())
    }

    #[test]
    fn delivery_race_returns_monotonic_terminal_cas_and_consistent_recovery() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-finalize-race")?;
        let db = std::sync::Arc::new(Db::open(tempdir.path().join("db.rocksdb"))?);
        let request = message(&[b"finalize race raw"]);
        let hash = request.payload_hash.clone();
        let limits = MonadOutboxLimits::default();
        db.monad_outbox()
            .claim(&hash, &request, &policy(), 100, &limits)?;
        db.monad_outbox()
            .confirm_observed_member(&hash, 0, 10, 1, 200)?;
        assert!(db.monad_outbox().mark_fully_confirmed(&hash, 250)?);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let finalize = {
            let db = std::sync::Arc::clone(&db);
            let barrier = std::sync::Arc::clone(&barrier);
            let hash = hash.clone();
            let limits = limits.clone();
            std::thread::spawn(move || {
                barrier.wait();
                db.monad_outbox()
                    .finalize_delivery_unchecked_for_test(&hash, 300, &limits)
            })
        };
        let recover = {
            let db = std::sync::Arc::clone(&db);
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                db.monad_outbox()
                    .confirmed_prefixes_for_recipient(&policy().recipient, 1)
            })
        };
        barrier.wait();
        assert_eq!(finalize.join().unwrap()?.timestamp, 300);
        let recovery = recover.join().unwrap()?;
        assert!(recovery.len() <= 1);
        assert_eq!(
            db.monad_outbox().terminal_claim(
                &hash,
                MonadOutboxTerminal::CorruptReference,
                "late aggregate terminalization",
                301,
                &limits,
            )?,
            MonadOutboxTransition::Stale
        );
        assert_eq!(
            db.monad_outbox().get(&hash)?.unwrap().lifecycle,
            MonadOutboxLifecycle::Delivered
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
    fn legacy_active_quota_reserves_normalized_v3_growth_at_exact_boundaries() -> Result<()> {
        for version in [RECORD_VERSION_V1, RECORD_VERSION_V2] {
            for per_recipient in [false, true] {
                let tempdir = tempdir::TempDir::new("monad-outbox-legacy-active-quota")?;
                let path = tempdir.path().join("db.rocksdb");
                let legacy =
                    message_with_seed(&[version, per_recipient as u8, 0], &[b"legacy-active-raw"]);
                let candidate =
                    message_with_seed(&[version, per_recipient as u8, 1], &[b"new-active-raw"]);
                {
                    let db = Db::open(&path)?;
                    put_legacy_active_record(&db, &legacy, &policy(), version, 0)?;
                }
                let db = Db::open(&path)?;
                let store = db.monad_outbox();
                let legacy_hash: [u8; 32] = legacy.payload_hash.as_slice().try_into().unwrap();
                let stored_len = db
                    .get(store.cf_outbox, legacy_hash)?
                    .expect("legacy quota fixture row must exist")
                    .len();
                let legacy_record = store.get(&legacy_hash)?.unwrap();
                let normalized_len = encode_record(&legacy_record).len();
                assert_eq!(
                    normalized_len - stored_len,
                    if version == RECORD_VERSION_V1 { 29 } else { 28 },
                    "legacy retry-policy fields must be included in reserved v3 growth"
                );
                let legacy_reserved = store
                    .recovery_reserved_claim_bytes_locked(&legacy_hash, &legacy_record)?
                    as usize;

                let measure_dir = tempdir::TempDir::new("monad-outbox-new-reservation")?;
                let measure_db = Db::open(measure_dir.path().join("db.rocksdb"))?;
                let measure_store = measure_db.monad_outbox();
                measure_store.claim(
                    &candidate.payload_hash,
                    &candidate,
                    &policy(),
                    102,
                    &MonadOutboxLimits::default(),
                )?;
                let candidate_hash: [u8; 32] =
                    candidate.payload_hash.as_slice().try_into().unwrap();
                let candidate_record = measure_store.get(&candidate_hash)?.unwrap();
                let candidate_reserved = measure_store
                    .recovery_reserved_claim_bytes_locked(&candidate_hash, &candidate_record)?
                    as usize;

                let exact = legacy_reserved + candidate_reserved;
                let mut limits = MonadOutboxLimits::default();
                if per_recipient {
                    limits.max_recovery_bytes = usize::MAX;
                    limits.max_recovery_bytes_per_recipient = exact - 1;
                } else {
                    limits.max_recovery_bytes = exact - 1;
                    limits.max_recovery_bytes_per_recipient = usize::MAX;
                }
                assert_eq!(
                    store.claim(&candidate.payload_hash, &candidate, &policy(), 102, &limits)?,
                    MonadOutboxClaim::AtCapacity,
                    "one byte below the normalized exact boundary must reject"
                );
                if per_recipient {
                    limits.max_recovery_bytes_per_recipient = exact;
                } else {
                    limits.max_recovery_bytes = exact;
                }
                assert_eq!(
                    store.claim(&candidate.payload_hash, &candidate, &policy(), 102, &limits)?,
                    MonadOutboxClaim::New,
                    "the normalized exact boundary must admit"
                );

                let lease = match store.acquire_reconcile_lease(&legacy_hash, 0, 103, &limits)? {
                    MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                    other => panic!("expected legacy quota fixture lease, got {other:?}"),
                };
                let detail = "y".repeat(MAX_LAST_ERROR_BYTES_HARD);
                assert_eq!(
                    store.complete_pending_member(&legacy_hash, 0, lease, &detail, 104, &limits,)?,
                    MonadOutboxTransition::Applied
                );
                let transitioned = store.get(&legacy_hash)?.unwrap();
                assert_eq!(
                    store.recovery_reserved_claim_bytes_locked(&legacy_hash, &transitioned)?
                        as usize,
                    legacy_reserved,
                    "lease/error normalization must stay inside the reopening reservation"
                );

                let lease = match store.acquire_reconcile_lease(&legacy_hash, 0, 10_000, &limits)? {
                    MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                    other => panic!("expected reopened legacy terminal lease, got {other:?}"),
                };
                assert_eq!(
                    store.complete_terminal_member(
                        &legacy_hash,
                        0,
                        lease,
                        MonadOutboxTerminal::StaleNonce,
                        &detail,
                        10_001,
                        &limits,
                    )?,
                    MonadOutboxTransition::Applied
                );
                assert!(db
                    .get(
                        store.cf_recipient,
                        recipient_key(&policy().recipient, &legacy_hash),
                    )?
                    .is_none());

                // A terminal row with no confirmed prefix belongs only to bounded history. It
                // must not consume either recovery ceiling after a legacy v1/v2 reopen.
                let next =
                    message_with_seed(&[version, per_recipient as u8, 2], &[b"new-active-raw"]);
                let overflow =
                    message_with_seed(&[version, per_recipient as u8, 3], &[b"new-active-raw"]);
                if per_recipient {
                    limits.max_recovery_records_per_recipient = 2;
                    limits.max_recovery_bytes_per_recipient = candidate_reserved * 2;
                } else {
                    limits.max_recovery_records = 2;
                    limits.max_recovery_bytes = candidate_reserved * 2;
                }
                assert_eq!(
                    store.claim(&next.payload_hash, &next, &policy(), 10_002, &limits)?,
                    MonadOutboxClaim::New,
                    "a no-prefix terminal must not reduce the exact recovery boundary"
                );
                assert_eq!(
                    store.claim(
                        &overflow.payload_hash,
                        &overflow,
                        &policy(),
                        10_003,
                        &limits,
                    )?,
                    MonadOutboxClaim::AtCapacity,
                    "the independent recovery boundary still rejects one additional obligation"
                );
            }
        }
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

    #[test]
    fn version_two_rows_decode_with_fixed_legacy_retry_policy() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-v2-compat")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let request = message(&[b"v2 canonical raw"]);
        let payload_hash: [u8; 32] = request.payload_hash.as_slice().try_into().unwrap();
        let policy = policy();
        let mut record = vec![RECORD_VERSION_V2, 0, 0, 0];
        record.extend_from_slice(&100i64.to_be_bytes());
        record.extend_from_slice(&101i64.to_be_bytes());
        record.extend_from_slice(&3u32.to_be_bytes());
        put_bytes(&mut record, b"v2 diagnostic");
        record.extend_from_slice(&policy.min_value_wei.to_be_bytes());
        record.extend_from_slice(&policy.recipient.0);
        put_bytes(&mut record, &policy.recipient_pubkey);
        put_bytes(&mut record, &policy.network_tag);
        put_bytes(&mut record, &request.encode_to_vec());
        db.put(db.monad_outbox().cf_outbox, payload_hash, record)?;

        let tx_hash = Hash32(Keccak256::digest(b"v2 canonical raw").into());
        let mut member = vec![RECORD_VERSION_V2, 0, 0];
        member.extend_from_slice(&tx_hash.0);
        member.extend_from_slice(&2u32.to_be_bytes());
        member.extend_from_slice(&101i64.to_be_bytes());
        member.extend_from_slice(&0u128.to_be_bytes());
        member.extend_from_slice(&0u64.to_be_bytes());
        member.extend_from_slice(&4u64.to_be_bytes());
        member.extend_from_slice(&150i64.to_be_bytes());
        put_bytes(&mut member, b"v2 pending");
        db.put(
            db.monad_outbox().cf_members,
            member_key(&payload_hash, 0),
            member,
        )?;

        let decoded = db.monad_outbox().get(&payload_hash)?.unwrap();
        assert_eq!(
            decoded.expires_at_ms,
            100 + duration_ms_i64(LEGACY_MAX_CLAIM_AGE)
        );
        assert_eq!(decoded.max_member_attempts, LEGACY_MAX_MEMBER_ATTEMPTS);
        assert_eq!(
            decoded.retry_backoff_base_ms,
            duration_ms_u64(LEGACY_RETRY_BACKOFF_BASE)
        );
        let decoded_member = db.monad_outbox().get_member(&payload_hash, 0)?.unwrap();
        assert_eq!(decoded_member.lease_generation, 4);
        assert_eq!(decoded_member.next_replay_at_ms, 101);
        Ok(())
    }

    #[test]
    fn quota_metadata_fails_closed_but_new_recipients_and_zero_cleanup_remain_o1() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-quota-corruption")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let limits = MonadOutboxLimits::default();
        let first = message_with_seed(b"quota owner", &[b"first"]);
        let second = message_with_seed(b"quota blocked", &[b"second"]);
        store.claim(&first.payload_hash, &first, &policy(), 1, &limits)?;
        db.rocksdb()
            .delete_cf(store.cf_meta, RECOVERY_QUOTA_GLOBAL_KEY)?;
        assert!(store
            .claim(&second.payload_hash, &second, &policy(), 2, &limits)
            .is_err());
        assert!(store.get(&second.payload_hash)?.is_none());
        let second_hash: [u8; 32] = second.payload_hash.as_slice().try_into().unwrap();
        assert!(db
            .get(store.cf_meta, recovery_quota_record_key(&second_hash))?
            .is_none());

        let tempdir = tempdir::TempDir::new("monad-outbox-recipient-quota-corruption")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let first_policy = policy();
        let other_policy = policy_for_secret(0x42);
        store.claim(&first.payload_hash, &first, &first_policy, 1, &limits)?;
        db.rocksdb().delete_cf(
            store.cf_meta,
            recovery_quota_recipient_key(&first_policy.recipient),
        )?;
        assert!(store
            .claim(&second.payload_hash, &second, &first_policy, 2, &limits)
            .is_err());
        let other = message_with_seed(b"genuinely new recipient", &[b"other"]);
        assert_eq!(
            store.claim(&other.payload_hash, &other, &other_policy, 3, &limits)?,
            MonadOutboxClaim::New
        );

        let tempdir = tempdir::TempDir::new("monad-outbox-zero-recipient-cleanup")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        store.claim(&first.payload_hash, &first, &first_policy, 1, &limits)?;
        store.terminal_observed_member(
            &first.payload_hash,
            0,
            MonadOutboxTerminal::BroadcastRejected,
            "never submitted",
            2,
            &limits,
        )?;
        let first_hash: [u8; 32] = first.payload_hash.as_slice().try_into().unwrap();
        assert!(db
            .get(
                store.cf_meta,
                recovery_quota_recipient_key(&first_policy.recipient),
            )?
            .is_none());
        assert!(db
            .get(
                store.cf_meta,
                recovery_quota_owner_key(&first_policy.recipient, &first_hash),
            )?
            .is_none());
        assert!(db
            .get(store.cf_meta, recovery_obligation_id_key(&first_hash))?
            .is_none());
        assert_eq!(
            store.claim(&second.payload_hash, &second, &first_policy, 3, &limits)?,
            MonadOutboxClaim::New
        );
        Ok(())
    }

    #[test]
    fn migration_cursors_require_atomic_coherent_state_before_any_mutation() -> Result<()> {
        for generation in [3u8, 4, 5] {
            let tempdir = tempdir::TempDir::new(&format!("monad-outbox-v{generation}-cursor"))?;
            let db = Db::open(tempdir.path().join("db.rocksdb"))?;
            let store = db.monad_outbox();
            let limits = MonadOutboxLimits::default();
            let first = message_with_seed(&[generation, 1], &[b"first"]);
            let second = message_with_seed(&[generation, 2], &[b"second"]);
            store.claim(&first.payload_hash, &first, &policy(), 1, &limits)?;
            store.claim(&second.payload_hash, &second, &policy(), 2, &limits)?;
            let high: [u8; 32] = first
                .payload_hash
                .as_slice()
                .max(second.payload_hash.as_slice())
                .try_into()
                .unwrap();
            let (marker, cursor, state) = match generation {
                3 => (
                    b"outbox-lifecycle-v3".as_slice(),
                    b"outbox-lifecycle-v3-cursor".as_slice(),
                    b"outbox-lifecycle-v3-cursor-state".as_slice(),
                ),
                4 => (
                    b"outbox-terminal-recovery-v4".as_slice(),
                    b"outbox-terminal-recovery-v4-cursor".as_slice(),
                    b"outbox-terminal-recovery-v4-cursor-state".as_slice(),
                ),
                _ => (
                    RECOVERY_QUOTA_MIGRATION_KEY,
                    RECOVERY_QUOTA_CURSOR_KEY,
                    RECOVERY_QUOTA_CURSOR_STATE_KEY,
                ),
            };
            db.rocksdb().delete_cf(store.cf_meta, marker)?;
            db.rocksdb().put_cf(store.cf_meta, cursor, high)?;
            db.rocksdb().delete_cf(store.cf_meta, state)?;
            let first_before = db.get(store.cf_outbox, &first.payload_hash)?.unwrap();
            let result = match generation {
                3 => store.migrate_legacy_delivered_ownership(&limits),
                4 => store.migrate_terminal_recovery_classification(&limits),
                _ => store.migrate_recovery_quota_accounting(),
            };
            assert!(result.is_err());
            assert_eq!(
                db.get(store.cf_outbox, &first.payload_hash)?
                    .unwrap()
                    .as_ref(),
                first_before.as_ref()
            );
            assert!(db.get(store.cf_meta, marker)?.is_none());
        }
        Ok(())
    }

    #[test]
    fn recipient_inbox_reader_rejects_cross_owner_and_semantic_truncation() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-inbox-corruption")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let recipient_a = policy().recipient;
        let recipient_b = policy_for_secret(0x42).recipient;
        let envelope_b = format!(r#"{{"to":"{}"}}"#, recipient_b.to_hex()).into_bytes();
        let hash_b: [u8; 32] = Sha256::digest(envelope_b.clone().into())
            .as_slice()
            .try_into()
            .unwrap();
        let stored_b = proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                encrypted_payload: envelope_b,
                payload_hash: hash_b.to_vec(),
                stamp_payments: vec![],
            }),
            timestamp: 10,
            network_tag: vec![],
        };
        db.monad_messages().put(&hash_b, &recipient_b, &stored_b)?;
        db.put(
            db.cf(CF_MONAD_MESSAGES_BY_RECIPIENT_TIME)?,
            inbox_recipient_key(&recipient_a, 10, &hash_b),
            hash_b,
        )?;
        assert!(store
            .validated_inbox_page(&recipient_a, 0, None, 1, usize::MAX)
            .is_err());

        let corrupt_hash = [0x01; 32];
        db.put(
            db.cf(CF_MONAD_MESSAGES)?,
            corrupt_hash,
            proto::StoredMonadMessage {
                message: None,
                timestamp: 1,
                network_tag: vec![],
            }
            .encode_to_vec(),
        )?;
        db.put(
            db.cf(CF_MONAD_MESSAGES_BY_RECIPIENT_TIME)?,
            inbox_recipient_key(&recipient_a, 1, &corrupt_hash),
            corrupt_hash,
        )?;
        assert!(store
            .validated_inbox_page(&recipient_a, 0, None, 1, usize::MAX)
            .is_err());
        Ok(())
    }

    #[test]
    fn member_leases_and_confirmations_do_not_rewrite_large_canonical_rows() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-write-amplification")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let raws = (0..MAX_MEMBERS_HARD)
            .map(|index| vec![index as u8; 30_000])
            .collect::<Vec<_>>();
        let raw_refs = raws.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let request = message(&raw_refs);
        let limits = MonadOutboxLimits::default();
        store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
        reset_outbox_canonical_write_work();
        for child_index in 0..MAX_MEMBERS_HARD as u32 {
            let lease = match store.acquire_reconcile_lease(
                &request.payload_hash,
                child_index,
                2 + i64::from(child_index),
                &limits,
            )? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected lease, got {other:?}"),
            };
            assert_eq!(
                store.complete_confirmed_member(
                    &request.payload_hash,
                    child_index,
                    lease,
                    1,
                    7,
                    100 + i64::from(child_index),
                )?,
                MonadOutboxTransition::Applied
            );
        }
        assert_eq!(outbox_canonical_write_work(), (0, 0));
        Ok(())
    }

    #[test]
    fn acknowledgement_generation_blocks_aba_and_exposed_zero_prefix_survives_gc() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-ack-generation")?;
        let path = tempdir.path().join("db.rocksdb");
        let mut limits = MonadOutboxLimits::default();
        limits.max_member_attempts = 1;
        let first = message_with_seed(b"same payload", &[b"first payment", b"first tail"]);
        let second = message_with_seed(b"same payload", &[b"second payment", b"second tail"]);
        let recipient = policy().recipient;
        let stale_id;
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            store.claim(&first.payload_hash, &first, &policy(), 1, &limits)?;
            store.confirm_observed_member(&first.payload_hash, 0, 1, 7, 2)?;
            store.terminal_observed_member(
                &first.payload_hash,
                1,
                MonadOutboxTerminal::StaleNonce,
                "first terminal",
                3,
                &limits,
            )?;
            stale_id = store.confirmed_prefixes_for_recipient(&recipient, 1)?[0].obligation_id;
            assert_eq!(
                store.acknowledge_terminal_recovery(&recipient, &first.payload_hash, &stale_id,)?,
                MonadRecoveryAck::Acknowledged
            );
            store.claim(&second.payload_hash, &second, &policy(), 4, &limits)?;
            store.confirm_observed_member(&second.payload_hash, 0, 1, 8, 5)?;
            store.terminal_observed_member(
                &second.payload_hash,
                1,
                MonadOutboxTerminal::StaleNonce,
                "second terminal",
                6,
                &limits,
            )?;
            let current_id =
                store.confirmed_prefixes_for_recipient(&recipient, 1)?[0].obligation_id;
            assert_ne!(current_id, stale_id);
            assert_eq!(
                store.acknowledge_terminal_recovery(&recipient, &second.payload_hash, &stale_id,)?,
                MonadRecoveryAck::Absent
            );
            assert!(store.get(&second.payload_hash)?.is_some());
        }

        let exposed = message_with_seed(b"exposed no prefix", &[b"possibly submitted"]);
        {
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            store.claim(&exposed.payload_hash, &exposed, &policy(), 10, &limits)?;
            let first_lease =
                match store.acquire_reconcile_lease(&exposed.payload_hash, 0, 11, &limits)? {
                    MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                    other => panic!("expected lease, got {other:?}"),
                };
            store.begin_replay_attempt(&exposed.payload_hash, 0, first_lease, 12, &limits)?;
            store.complete_submitted_member(
                &exposed.payload_hash,
                0,
                first_lease,
                "accepted without receipt",
                13,
                &limits,
            )?;
            let second_lease = match store.acquire_reconcile_lease(
                &exposed.payload_hash,
                0,
                i64::MAX - 1,
                &limits,
            )? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected second lease, got {other:?}"),
            };
            assert!(matches!(
                store.begin_replay_attempt(
                    &exposed.payload_hash,
                    0,
                    second_lease,
                    i64::MAX - 1,
                    &limits,
                )?,
                MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
                    | MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::AttemptsExhausted)
            ));
            let recovery = store.confirmed_prefixes_for_recipient(&recipient, 10)?;
            assert!(recovery.iter().any(|entry| {
                entry.payload_hash.as_slice() == exposed.payload_hash
                    && entry.confirmed_prefix.is_empty()
            }));
            let mut gc = limits.clone();
            gc.max_history_records = 0;
            gc.max_history_bytes = 0;
            gc.max_history_age = Duration::ZERO;
            store.gc_history(i64::MAX, &gc)?;
            assert!(store.get(&exposed.payload_hash)?.is_some());
        }
        let db = Db::open(&path)?;
        assert!(db.monad_outbox().get(&exposed.payload_hash)?.is_some());
        assert!(db
            .monad_outbox()
            .confirmed_prefixes_for_recipient(&recipient, 10)?
            .iter()
            .any(|entry| entry.payload_hash.as_slice() == exposed.payload_hash));
        Ok(())
    }

    #[test]
    fn confirmations_are_prefix_closed_across_stale_lease_generations() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-prefix-closed")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.member_lease = Duration::from_millis(1);
        let request = message(&[b"zero", b"one"]);
        store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
        let old = match store.acquire_reconcile_lease(&request.payload_hash, 0, 2, &limits)? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected old lease, got {other:?}"),
        };
        let fresh = match store.acquire_reconcile_lease(&request.payload_hash, 0, 4, &limits)? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected fresh lease, got {other:?}"),
        };
        assert_eq!(
            store.complete_confirmed_member(&request.payload_hash, 0, old, 1, 7, 5)?,
            MonadOutboxTransition::Stale
        );
        let child_one = match store.acquire_reconcile_lease(&request.payload_hash, 1, 5, &limits)? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected child-one lease, got {other:?}"),
        };
        assert_eq!(
            store.complete_confirmed_member(&request.payload_hash, 1, child_one, 1, 7, 6)?,
            MonadOutboxTransition::Stale
        );
        assert_eq!(
            store.complete_confirmed_member(&request.payload_hash, 0, fresh, 1, 7, 7)?,
            MonadOutboxTransition::Applied
        );
        assert_eq!(
            store.complete_confirmed_member(&request.payload_hash, 0, old, 1, 7, 8)?,
            MonadOutboxTransition::Stale
        );
        assert!(matches!(
            store.get_member(&request.payload_hash, 0)?.unwrap().state,
            MonadOutboxMemberState::Confirmed { .. }
        ));
        Ok(())
    }
    fn lease_at(
        store: &DbMonadOutbox<'_>,
        payload_hash: &[u8],
        child_index: u32,
        now_ms: i64,
        limits: &MonadOutboxLimits,
    ) -> MonadOutboxLease {
        match store
            .acquire_reconcile_lease(payload_hash, child_index, now_ms, limits)
            .unwrap()
        {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected lease, got {other:?}"),
        }
    }

    fn one_slot_limits() -> MonadOutboxLimits {
        let mut limits = MonadOutboxLimits::default();
        limits.max_recovery_records = 1;
        limits.max_recovery_records_per_recipient = 1;
        limits.max_member_attempts = 1;
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        limits
    }

    #[test]
    fn replay_attempt_before_send_is_not_recoverable_exposure() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-attempt-not-exposure")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let limits = one_slot_limits();
        let recipient = policy().recipient;
        let unfunded = message_with_seed(b"unfunded", &[b"signed but unfunded"]);
        store.claim(&unfunded.payload_hash, &unfunded, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &unfunded.payload_hash, 0, 2, &limits);
        assert!(matches!(
            store.begin_replay_attempt(&unfunded.payload_hash, 0, lease, 3, &limits)?,
            MonadOutboxReplayStart::Started(member) if member.exposed && member.attempts == 1
        ));
        // The send is definitively rejected (unfunded): the in-flight marker is cleared again.
        store.complete_rejected_member(
            &unfunded.payload_hash,
            0,
            lease,
            false,
            "insufficient funds",
            4,
            &limits,
        )?;
        let member = store.get_member(&unfunded.payload_hash, 0)?.unwrap();
        assert!(!member.exposed);
        assert!(store
            .confirmed_prefixes_for_recipient(&recipient, 10)?
            .is_empty());

        // The attempt budget is spent: the terminal claim must release its reserved quota
        // instead of becoming a retained recipient obligation.
        let lease = lease_at(&store, &unfunded.payload_hash, 0, 5, &limits);
        assert_eq!(
            store.begin_replay_attempt(&unfunded.payload_hash, 0, lease, 6, &limits)?,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::AttemptsExhausted)
        );
        assert!(store
            .confirmed_prefixes_for_recipient(&recipient, 10)?
            .is_empty());
        let next = message_with_seed(b"next claim", &[b"raw"]);
        assert_eq!(
            store.claim(&next.payload_hash, &next, &policy(), 7, &limits)?,
            MonadOutboxClaim::New,
            "the exhausted unfunded claim must not still hold the only recovery slot"
        );
        Ok(())
    }

    #[test]
    fn expired_unexposed_claim_releases_quota_but_exposed_claim_is_retained() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-expired-quota")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = one_slot_limits();
        limits.max_member_attempts = 32;
        limits.max_claim_age = Duration::from_millis(10);
        let recipient = policy().recipient;

        let unexposed = message_with_seed(b"expired unexposed", &[b"raw"]);
        store.claim(&unexposed.payload_hash, &unexposed, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &unexposed.payload_hash, 0, 2, &limits);
        assert_eq!(
            store.begin_replay_attempt(&unexposed.payload_hash, 0, lease, 100, &limits)?,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
        );
        assert!(store
            .confirmed_prefixes_for_recipient(&recipient, 10)?
            .is_empty());

        let exposed = message_with_seed(b"expired exposed", &[b"raw"]);
        assert_eq!(
            store.claim(&exposed.payload_hash, &exposed, &policy(), 200, &limits)?,
            MonadOutboxClaim::New
        );
        let lease = lease_at(&store, &exposed.payload_hash, 0, 201, &limits);
        store.complete_submitted_member(
            &exposed.payload_hash,
            0,
            lease,
            "visible",
            202,
            &limits,
        )?;
        let lease = lease_at(&store, &exposed.payload_hash, 0, 203, &limits);
        assert_eq!(
            store.begin_replay_attempt(&exposed.payload_hash, 0, lease, 400, &limits)?,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
        );
        assert_eq!(
            store
                .confirmed_prefixes_for_recipient(&recipient, 10)?
                .len(),
            1
        );
        Ok(())
    }

    #[test]
    fn exposure_is_in_flight_marked_and_cleared_only_by_definitive_rejection() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-exposure-flag")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        let request = message(&[b"zero"]);
        store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &request.payload_hash, 0, 2, &limits);
        store.begin_replay_attempt(&request.payload_hash, 0, lease, 3, &limits)?;
        // In flight: acceptance is unknown, so exposure is already recorded.
        assert!(store.get_member(&request.payload_hash, 0)?.unwrap().exposed);
        // An ambiguous completion (no definitive rejection) keeps it.
        store.complete_pending_member(&request.payload_hash, 0, lease, "lost", 4, &limits)?;
        assert!(store.get_member(&request.payload_hash, 0)?.unwrap().exposed);
        // A definitive rejection clears it - unless it was exposed before this attempt.
        let lease = lease_at(&store, &request.payload_hash, 0, 4, &limits);
        store.complete_rejected_member(&request.payload_hash, 0, lease, true, "x", 4, &limits)?;
        assert!(store.get_member(&request.payload_hash, 0)?.unwrap().exposed);
        store.complete_rejected_member(&request.payload_hash, 0, lease, false, "x", 4, &limits)?;
        assert!(!store.get_member(&request.payload_hash, 0)?.unwrap().exposed);
        assert!(store
            .db
            .get(
                store.cf_recipient,
                recipient_key(
                    &policy().recipient,
                    &checked_payload_hash(&request.payload_hash)?
                )
            )?
            .is_none());
        let lease = lease_at(&store, &request.payload_hash, 0, 5, &limits);
        store.complete_submitted_member(&request.payload_hash, 0, lease, "accepted", 6, &limits)?;
        let member = store.get_member(&request.payload_hash, 0)?.unwrap();
        assert!(member.exposed);
        assert_eq!(
            member.attempts, 1,
            "member-level attempt count is preserved"
        );
        // Exposure creates the recipient recovery index entry (listing waits for a terminal or
        // confirmed prefix).
        assert!(store
            .db
            .get(
                store.cf_recipient,
                recipient_key(
                    &policy().recipient,
                    &checked_payload_hash(&request.payload_hash)?
                )
            )?
            .is_some());
        Ok(())
    }

    /// An attempt whose outcome is unknown (crash, timeout, cancellation: no completion ever
    /// runs) must stay recoverable when the claim later expires or exhausts, because the node may
    /// have accepted the transaction and it can still be mined.
    #[test]
    fn unresolved_send_attempt_is_retained_at_expiry_and_exhaustion() -> Result<()> {
        for exhaust in [false, true] {
            let tempdir = tempdir::TempDir::new("monad-outbox-ambiguous-send")?;
            let db = Db::open(tempdir.path().join("db.rocksdb"))?;
            let store = db.monad_outbox();
            let mut limits = one_slot_limits();
            limits.max_unconfirmed_claim_age = if exhaust {
                Duration::from_secs(1_000_000)
            } else {
                Duration::from_millis(1_000)
            };
            limits.max_member_attempts = if exhaust { 1 } else { 32 };
            let request = message_with_seed(&[exhaust as u8], &[b"raw"]);
            store.claim(&request.payload_hash, &request, &policy(), 1, &limits)?;
            let lease = lease_at(&store, &request.payload_hash, 0, 2, &limits);
            store.begin_replay_attempt(&request.payload_hash, 0, lease, 3, &limits)?;
            // No completion: the process died (or the future was dropped) mid-send.
            let lease = lease_at(&store, &request.payload_hash, 0, 200_000, &limits);
            let expected = if exhaust {
                MonadOutboxTerminal::AttemptsExhausted
            } else {
                MonadOutboxTerminal::Expired
            };
            assert_eq!(
                store.begin_replay_attempt(&request.payload_hash, 0, lease, 200_001, &limits)?,
                MonadOutboxReplayStart::Terminal(expected)
            );
            assert_eq!(
                store
                    .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
                    .len(),
                1,
                "exhaust={exhaust}: an unresolved send stays recoverable"
            );
        }
        Ok(())
    }

    #[test]
    fn unconfirmed_exposure_obligation_ages_out_but_confirmed_prefix_never_does() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-unconfirmed-ttl")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_recovery_records = 2;
        limits.max_recovery_records_per_recipient = 2;
        limits.max_unconfirmed_recovery_age = Duration::from_millis(1_000);
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        let recipient = policy().recipient;

        // Never-mined exposure: accepted by a node, terminal, never confirmed.
        let stuck = message_with_seed(b"stuck exposure", &[b"raw"]);
        store.claim(&stuck.payload_hash, &stuck, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &stuck.payload_hash, 0, 2, &limits);
        store.complete_submitted_member(&stuck.payload_hash, 0, lease, "queued", 3, &limits)?;
        let lease = lease_at(&store, &stuck.payload_hash, 0, 4, &limits);
        store.complete_terminal_member(
            &stuck.payload_hash,
            0,
            lease,
            MonadOutboxTerminal::AttemptsExhausted,
            "exhausted",
            10,
            &limits,
        )?;

        // Real value moved: child zero confirmed, a later child lost.
        let paid = message_with_seed(b"paid prefix", &[b"raw zero", b"raw one"]);
        store.claim(&paid.payload_hash, &paid, &policy(), 11, &limits)?;
        store.confirm_observed_member(&paid.payload_hash, 0, 5, 9, 12)?;
        store.terminal_observed_member(
            &paid.payload_hash,
            1,
            MonadOutboxTerminal::StaleNonce,
            "lost",
            13,
            &limits,
        )?;
        assert_eq!(
            store
                .confirmed_prefixes_for_recipient(&recipient, 10)?
                .len(),
            2
        );
        let blocked = message_with_seed(b"blocked", &[b"raw"]);
        assert_eq!(
            store.claim(&blocked.payload_hash, &blocked, &policy(), 14, &limits)?,
            MonadOutboxClaim::AtCapacity
        );

        // Before the TTL nothing is retired.
        assert_eq!(store.expire_unconfirmed_recovery(1_000, &limits)?, 0);
        assert_eq!(
            store
                .confirmed_prefixes_for_recipient(&recipient, 10)?
                .len(),
            2
        );
        // After it, only the never-confirmed exposure is retired and its slot is reusable.
        assert_eq!(store.expire_unconfirmed_recovery(1_011, &limits)?, 1);
        assert!(store.get(&stuck.payload_hash)?.is_none());
        let remaining = store.confirmed_prefixes_for_recipient(&recipient, 10)?;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].payload_hash.as_slice(), paid.payload_hash);
        assert_eq!(
            store.claim(&blocked.payload_hash, &blocked, &policy(), 1_012, &limits)?,
            MonadOutboxClaim::New
        );
        // Far in the future the confirmed prefix is still owed to its recipient.
        assert_eq!(store.expire_unconfirmed_recovery(i64::MAX / 2, &limits)?, 0);
        assert!(store.get(&paid.payload_hash)?.is_some());
        Ok(())
    }

    #[test]
    fn unconfirmed_claims_per_recipient_are_capped_below_recovery_quota() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-unconfirmed-cap")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_unconfirmed_claims_per_recipient = 2;
        assert!(
            limits.max_unconfirmed_claims_per_recipient < limits.max_recovery_records_per_recipient
        );
        let first = message_with_seed(b"cap first", &[b"raw"]);
        let second = message_with_seed(b"cap second", &[b"raw"]);
        let third = message_with_seed(b"cap third", &[b"raw"]);
        assert_eq!(
            store.claim(&first.payload_hash, &first, &policy(), 1, &limits)?,
            MonadOutboxClaim::New
        );
        assert_eq!(
            store.claim(&second.payload_hash, &second, &policy(), 2, &limits)?,
            MonadOutboxClaim::New
        );
        assert_eq!(
            store.claim(&third.payload_hash, &third, &policy(), 3, &limits)?,
            MonadOutboxClaim::AtCapacity
        );
        // Another recipient is unaffected.
        let other = message_with_seed(b"cap other", &[b"raw"]);
        assert_eq!(
            store.claim(
                &other.payload_hash,
                &other,
                &policy_for_secret(0x33),
                3,
                &limits
            )?,
            MonadOutboxClaim::New
        );
        // Confirming child zero moves a claim out of the unconfirmed set.
        store.confirm_observed_member(&first.payload_hash, 0, 5, 9, 4)?;
        assert_eq!(
            store.claim(&third.payload_hash, &third, &policy(), 5, &limits)?,
            MonadOutboxClaim::New
        );
        // Terminalizing an unexposed claim releases its unconfirmed slot exactly once.
        let lease = lease_at(&store, &second.payload_hash, 0, 6, &limits);
        store.complete_terminal_member(
            &second.payload_hash,
            0,
            lease,
            MonadOutboxTerminal::VerificationFailed,
            "bad",
            7,
            &limits,
        )?;
        let fourth = message_with_seed(b"cap fourth", &[b"raw"]);
        assert_eq!(
            store.claim(&fourth.payload_hash, &fourth, &policy(), 8, &limits)?,
            MonadOutboxClaim::New
        );
        let fifth = message_with_seed(b"cap fifth", &[b"raw"]);
        assert_eq!(
            store.claim(&fifth.payload_hash, &fifth, &policy(), 9, &limits)?,
            MonadOutboxClaim::AtCapacity
        );
        Ok(())
    }

    #[test]
    fn unconfirmed_claim_age_is_shorter_than_frozen_claim_age_until_a_child_confirms() -> Result<()>
    {
        let tempdir = tempdir::TempDir::new("monad-outbox-unconfirmed-age")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_unconfirmed_claim_age = Duration::from_millis(100);
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        assert!(limits.max_unconfirmed_claim_age < limits.max_claim_age);

        let stuck = message_with_seed(b"age stuck", &[b"raw"]);
        store.claim(&stuck.payload_hash, &stuck, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &stuck.payload_hash, 0, 2, &limits);
        assert_eq!(
            store.begin_replay_attempt(&stuck.payload_hash, 0, lease, 500, &limits)?,
            MonadOutboxReplayStart::Terminal(MonadOutboxTerminal::Expired)
        );

        let paying = message_with_seed(b"age paying", &[b"zero", b"one"]);
        store.claim(&paying.payload_hash, &paying, &policy(), 1, &limits)?;
        store.confirm_observed_member(&paying.payload_hash, 0, 5, 9, 2)?;
        let lease = lease_at(&store, &paying.payload_hash, 1, 3, &limits);
        assert!(matches!(
            store.begin_replay_attempt(&paying.payload_hash, 1, lease, 500, &limits)?,
            MonadOutboxReplayStart::Started(_)
        ));
        Ok(())
    }

    #[test]
    fn claim_age_terminalizes_submitted_and_ambiguous_members() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-age-all-paths")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.max_claim_age = Duration::from_millis(10);
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;

        let submitted = message_with_seed(b"age submitted", &[b"raw"]);
        store.claim(&submitted.payload_hash, &submitted, &policy(), 1, &limits)?;
        let lease = lease_at(&store, &submitted.payload_hash, 0, 2, &limits);
        assert_eq!(
            store.complete_submitted_member(
                &submitted.payload_hash,
                0,
                lease,
                "visible",
                500,
                &limits
            )?,
            MonadOutboxTransition::Applied
        );
        assert_eq!(
            store.get(&submitted.payload_hash)?.unwrap().lifecycle,
            MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::Expired)
        );
        assert!(
            store
                .get_member(&submitted.payload_hash, 0)?
                .unwrap()
                .exposed
        );
        // Exposure learned in the very transition that expires the claim is retained atomically:
        // the obligation is recipient-visible and still owns its recovery reservation.
        assert!(store
            .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
            .iter()
            .any(|recovery| recovery.payload_hash.as_slice() == submitted.payload_hash));

        let ambiguous = message_with_seed(b"age ambiguous", &[b"raw"]);
        store.claim(
            &ambiguous.payload_hash,
            &ambiguous,
            &policy(),
            1_000,
            &limits,
        )?;
        let lease = lease_at(&store, &ambiguous.payload_hash, 0, 1_001, &limits);
        assert_eq!(
            store.complete_pending_member(
                &ambiguous.payload_hash,
                0,
                lease,
                "rpc down",
                1_500,
                &limits
            )?,
            MonadOutboxTransition::Applied
        );
        assert_eq!(
            store.get(&ambiguous.payload_hash)?.unwrap().lifecycle,
            MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::Expired)
        );
        // No attempt was ever sent, so no exposure and nothing retained.
        assert!(
            !store
                .get_member(&ambiguous.payload_hash, 0)?
                .unwrap()
                .exposed
        );
        assert!(store
            .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
            .iter()
            .all(|recovery| recovery.payload_hash.as_slice() != ambiguous.payload_hash));
        Ok(())
    }

    #[test]
    fn cancelled_reconcile_advances_replay_backoff_monotonically() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-cancel-backoff")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        let mut limits = MonadOutboxLimits::default();
        limits.retry_backoff_base = Duration::from_secs(10);
        limits.max_retry_backoff = Duration::from_secs(600);
        let request = message(&[b"zero"]);
        store.claim(&request.payload_hash, &request, &policy(), 1_000, &limits)?;
        let lease = lease_at(&store, &request.payload_hash, 0, 1_001, &limits);
        store.begin_replay_attempt(&request.payload_hash, 0, lease, 1_002, &limits)?;
        let before = store.get_member(&request.payload_hash, 0)?.unwrap();
        store.backoff_after_cancelled_reconcile(&request.payload_hash, 5_000)?;
        let after = store.get_member(&request.payload_hash, 0)?.unwrap();
        assert!(after.next_replay_at_ms >= 5_000 + 10_000);
        assert!(after.next_replay_at_ms > before.next_replay_at_ms);
        assert_eq!(after.attempts, 1);
        // Never moves backward on a later, earlier-timestamped cancellation.
        store.backoff_after_cancelled_reconcile(&request.payload_hash, 1_000)?;
        assert_eq!(
            store
                .get_member(&request.payload_hash, 0)?
                .unwrap()
                .next_replay_at_ms,
            after.next_replay_at_ms
        );
        Ok(())
    }

    fn put_stored_message(db: &Db, key: [u8; 32], raw_txs: Vec<Vec<u8>>) -> Result<()> {
        let message = proto::MonadStampedMessage {
            encrypted_payload: b"legacy row".to_vec(),
            payload_hash: key.to_vec(),
            stamp_payments: raw_txs
                .into_iter()
                .enumerate()
                .map(|(index, raw_tx)| proto::MonadStampPayment {
                    child_index: index as u32,
                    raw_tx,
                })
                .collect(),
        };
        let stored = proto::StoredMonadMessage {
            message: Some(message),
            timestamp: 1,
            network_tag: b"testnet".to_vec(),
        };
        db.put(
            db.cf(crate::store::db::CF_MONAD_MESSAGES)?,
            key,
            stored.encode_to_vec(),
        )
    }

    fn bind_to_completion(store: &DbMonadOutbox<'_>, chain_id: u64) -> Result<()> {
        while store.bind_chain_page(chain_id, 16, 1 << 20)? == ChainBindingProgress::More {}
        Ok(())
    }

    #[test]
    fn chain_binding_quarantines_legacy_rows_without_a_usable_chain_id() -> Result<()> {
        use crate::monad_evm_tx::test_support::{signed_eip1559_tx, signed_unprotected_legacy_tx};
        let tempdir = tempdir::TempDir::new("monad-outbox-chain-quarantine")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([7; 32]).unwrap();
        let to = crate::monad_http::Address([9; 20]);
        let legacy = signed_unprotected_legacy_tx(&seckey, 0, to, 1, b"legacy");
        let (good, _) = signed_eip1559_tx(&seckey, 41_454, 1, to, 1, b"good");
        put_stored_message(&db, [1; 32], vec![legacy])?;
        put_stored_message(&db, [2; 32], vec![b"not a transaction".to_vec()])?;
        put_stored_message(&db, [3; 32], vec![good])?;

        let before = legacy_chain_quarantined_total();
        bind_to_completion(&db.monad_outbox(), 41_454)?;
        assert!(
            legacy_chain_quarantined_total() >= before + 2,
            "both the chain-less and the undecodable legacy payment are counted"
        );
        // The binding is durable and still enforced for later opens.
        assert!(bind_to_completion(&db.monad_outbox(), 1).is_err());
        Ok(())
    }

    #[test]
    fn chain_binding_still_rejects_a_payment_naming_another_chain() -> Result<()> {
        use crate::monad_evm_tx::test_support::signed_eip1559_tx;
        let tempdir = tempdir::TempDir::new("monad-outbox-chain-mismatch")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([8; 32]).unwrap();
        let (foreign, _) = signed_eip1559_tx(
            &seckey,
            1,
            0,
            crate::monad_http::Address([9; 20]),
            1,
            b"other chain",
        );
        put_stored_message(&db, [4; 32], vec![foreign])?;
        let err = bind_to_completion(&db.monad_outbox(), 41_454).unwrap_err();
        assert!(err.to_string().contains("differs from configured"), "{err}");
        Ok(())
    }
    #[test]
    fn production_default_limits_are_pinned() {
        let limits = MonadOutboxLimits::default();
        assert_eq!(limits.max_unconfirmed_claims_per_recipient, 32);
        assert_eq!(limits.max_recovery_records_per_recipient, 128);
        assert_eq!(
            limits.max_unconfirmed_claim_age,
            Duration::from_secs(6 * 3600)
        );
        assert_eq!(
            limits.max_unconfirmed_recovery_age,
            Duration::from_secs(24 * 3600)
        );
    }

    #[test]
    fn legacy_attempted_member_is_exposed_and_retained_until_it_ages_out() -> Result<()> {
        for version in [RECORD_VERSION_V1, RECORD_VERSION_V2] {
            let tempdir = tempdir::TempDir::new("monad-outbox-legacy-attempted")?;
            let path = tempdir.path().join("db.rocksdb");
            let legacy = message_with_seed(&[version, 0xa7], &[b"legacy-attempted-raw"]);
            {
                let db = Db::open(&path)?;
                // Two persisted attempts: the predecessor may have submitted these bytes.
                put_legacy_active_record(&db, &legacy, &policy(), version, 2)?;
            }
            let db = Db::open(&path)?;
            let store = db.monad_outbox();
            let hash: [u8; 32] = legacy.payload_hash.as_slice().try_into().unwrap();
            let member = store.get_member(&hash, 0)?.unwrap();
            assert_eq!(member.attempts, 2);
            assert!(
                member.exposed,
                "a legacy member with persisted attempts is treated as possibly exposed"
            );

            let mut limits = MonadOutboxLimits::default();
            limits.max_recovery_records = 1;
            limits.max_recovery_records_per_recipient = 1;
            limits.max_unconfirmed_recovery_age = Duration::from_millis(1_000);
            let lease = lease_at(&store, &hash, 0, 10_000, &limits);
            assert_eq!(
                store.complete_terminal_member(
                    &hash,
                    0,
                    lease,
                    MonadOutboxTerminal::StaleNonce,
                    "lost",
                    10_001,
                    &limits,
                )?,
                MonadOutboxTransition::Applied
            );
            // Unlike the zero-attempt fixture, this terminal keeps its recovery obligation.
            assert!(db
                .get(
                    store.cf_recipient,
                    recipient_key(&policy().recipient, &hash)
                )?
                .is_some());
            assert_eq!(
                store
                    .confirmed_prefixes_for_recipient(&policy().recipient, 10)?
                    .len(),
                1
            );
            let next = message_with_seed(&[version, 0xa8], &[b"next"]);
            assert_eq!(
                store.claim(&next.payload_hash, &next, &policy(), 10_002, &limits)?,
                MonadOutboxClaim::AtCapacity,
                "the retained legacy obligation still owns the only recovery slot"
            );
            // The exposure-only obligation is bounded: it ages out and frees the slot.
            assert_eq!(
                store.expire_unconfirmed_recovery(10_001 + 1_001, &limits)?,
                1
            );
            assert!(store.get(&hash)?.is_none());
            assert_eq!(
                store.claim(&next.payload_hash, &next, &policy(), 12_000, &limits)?,
                MonadOutboxClaim::New
            );
        }
        Ok(())
    }

    fn put_inbox_message(db: &Db, recipient: Address, seed: &[u8], timestamp: i64) -> [u8; 32] {
        let envelope = format!(
            r#"{{"to":"{}","seed":"{}"}}"#,
            recipient.to_hex(),
            hex::encode(seed)
        )
        .into_bytes();
        let hash: [u8; 32] = Sha256::digest(envelope.clone().into())
            .as_slice()
            .try_into()
            .unwrap();
        let stored = proto::StoredMonadMessage {
            message: Some(proto::MonadStampedMessage {
                encrypted_payload: envelope,
                payload_hash: hash.to_vec(),
                stamp_payments: vec![],
            }),
            timestamp,
            network_tag: vec![],
        };
        db.monad_messages().put(&hash, &recipient, &stored).unwrap();
        hash
    }

    #[test]
    fn inbox_page_stops_at_the_recipient_prefix_boundary_for_the_lower_sorted_recipient(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-inbox-prefix-boundary")?;
        let db = Db::open(tempdir.path().join("db.rocksdb"))?;
        let store = db.monad_outbox();
        // Recipient keys sort by address, so `lower` is followed in the index by `higher`'s rows.
        let lower = Address([0x01; 20]);
        let higher = Address([0x02; 20]);
        let lower_hashes = [
            put_inbox_message(&db, lower, b"lower-a", 10),
            put_inbox_message(&db, lower, b"lower-b", 20),
        ];
        let higher_hash = put_inbox_message(&db, higher, b"higher-a", 15);

        for limit in [2usize, 3, 10] {
            let page = store.validated_inbox_page(&lower, 0, None, limit, usize::MAX)?;
            let returned = page
                .messages
                .iter()
                .map(|stored| stored.message.as_ref().unwrap().payload_hash.clone())
                .collect::<Vec<_>>();
            assert_eq!(
                returned,
                lower_hashes
                    .iter()
                    .map(|hash| hash.to_vec())
                    .collect::<Vec<_>>(),
                "limit {limit}: only the queried recipient's rows are returned"
            );
            assert!(
                page.next_cursor.is_none(),
                "limit {limit}: the adjacent recipient's row is not `more`"
            );
        }
        let page = store.validated_inbox_page(&higher, 0, None, 10, usize::MAX)?;
        assert_eq!(page.messages.len(), 1);
        assert_eq!(
            page.messages[0].message.as_ref().unwrap().payload_hash,
            higher_hash.to_vec()
        );
        Ok(())
    }
}
