//! Authenticated directory history for one subject. No network access or runtime defaults.
//!
//! The caller supplies the revision-zero anchor: a relay pins the hash of the first valid
//! revision 0 a key publishes for itself, a client pins the first one it sees for an address.
//! A returned current record is a point-in-time result, not a reusable authorization token.
//! See `docs/protocol/directory-preview-admission.md` for the continuity boundary.

pub(crate) mod policy;

pub use crate::store::directory_preview::Directory;
pub use frank_cbor::{AccountRef, RelayBinding, Timestamp};

/// Maximum retained statements, including the bounded proof of a fork.
pub const MAX_STATEMENTS: usize = 4096;
/// Exact type-4 plus stable validating type-2 bytes across retained evidence.
pub const MAX_CHARGED_BYTES: usize = 16_777_216;
/// Both complete frames are independently bounded.
pub const MAX_FRAME_BYTES: usize = 262_144;

/// The pinned start of one subject's chain. Every record must be signed by `subject`; the
/// anchor only fixes which revision 0 the chain grows from, so a later, different revision 0
/// for the same key is refused instead of replacing history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    /// Expected network.
    pub network: String,
    /// Subject and signing authority P (compressed type-1 point).
    pub subject: AccountRef,
    /// Exact revision-zero type-4 T1.
    pub revision_zero: [u8; 32],
}

/// Minimum continuity checkpoint to retain outside this database's rollback domain.
/// Reopen permits authenticated descendants of this exact retained prefix, never rollback.
/// Serialization is local trust configuration, not a protocol/wire allocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    /// Distinguishes a pre-commit expectation from an observed accepted-prefix checkpoint.
    pub kind: CheckpointKind,
    /// Commitment to the unambiguous network/full-subject storage key.
    pub identity: [u8; 32],
    /// Installed revision-zero T1.
    pub anchor: [u8; 32],
    /// Exact accepted head at this checkpoint; absent only for initial fork quarantine.
    pub head: Option<[u8; 32]>,
    /// Number of accepted records in the pinned prefix.
    pub accepted: usize,
    /// Total pinned records, including any fork proof.
    pub retained: usize,
    /// Commitment to every exact stable wrapper in the retained prefix.
    pub evidence_digest: [u8; 32],
    /// Trusted checked-time floor as exact seconds and nanoseconds.
    pub checked_time: (i64, u32),
    /// Previously observed fork quarantine may never disappear.
    pub forked: bool,
}

/// The trust fact an external checkpoint records; prospective input is not past acceptance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CheckpointKind {
    /// Exact installed anchor evidence/time prepared before the first commit. It may reappear
    /// in accepted history or in authenticated initial-fork proof, but must actually be retained.
    ProspectiveEnrollment,
    /// Previously observed durable accepted/proof prefix. Its accepted head may not disappear.
    CommittedPrefix,
}

impl Checkpoint {
    /// Prepare external continuity before the first enrollment commit, so a lost acknowledgement
    /// can be recovered. Requires the exact installed anchor's signed revision-zero record.
    /// This is only an expectation: reopen still requires an existing, complete durable enrollment;
    /// this method grants no current/head authority and cannot bootstrap a missing database.
    pub fn for_enrollment(
        anchor: &Anchor,
        candidate: Candidate<'_>,
        now: Timestamp,
    ) -> Result<Self, AdmissionError> {
        policy::validate_anchor(anchor)?;
        policy::preflight(0, 0, &[candidate])?;
        if policy::statement_bytes(candidate.attestation)? != candidate.statement {
            return Err(AdmissionError::Evidence);
        }
        let record = policy::authenticate(anchor, candidate.attestation)?;
        policy::History::bootstrap(anchor, &record)?;
        let now = policy::clock(Some(now), None)?;
        if policy::nanos(record.issued) > policy::nanos(now) {
            return Err(AdmissionError::Validity);
        }
        Ok(Self {
            kind: CheckpointKind::ProspectiveEnrollment,
            identity: policy::identity(anchor),
            anchor: anchor.revision_zero,
            head: Some(record.evidence.hash),
            accepted: 1,
            retained: 1,
            evidence_digest: policy::evidence_digest(std::iter::once(&record)),
            checked_time: (now.seconds, now.nanoseconds),
            forked: false,
        })
    }
}

/// Caller trust configuration must remember which operation is permitted after deletion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    /// Only for a genuinely new subject; refuses any existing subject records.
    NewEnrollment,
    /// Requires complete retained state containing this exact external prefix and time floor.
    Reopen(Checkpoint),
}

/// Two exact frames, supplied separately so cumulative charging precedes decoding/curve work.
/// Verification checks that the wrapper embeds exactly `statement`; projections are not inputs.
#[derive(Clone, Copy, Debug)]
pub struct Candidate<'a> {
    /// Exact complete type-4 bytes.
    pub statement: &'a [u8],
    /// Exact complete type-2 bytes.
    pub attestation: &'a [u8],
}

/// Fresh trust inputs, explicitly supplied on every advance/current call.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    /// Trusted Unix time with nanosecond precision. Missing/invalid time fails closed.
    pub now: Option<Timestamp>,
    /// Previously authenticated exact relay tuple. No endpoint normalization or ID derivation.
    pub relay: Option<&'a RelayBinding>,
}

/// How the head's relay binding is judged when deciding whether it is current.
#[derive(Clone, Copy, Debug)]
pub enum BindingPolicy<'a> {
    /// The head must name exactly this relay tuple (a client talking to one known relay).
    Exact(Option<&'a RelayBinding>),
    /// The head may name any relay; its own binding must simply be unexpired. This is what a
    /// relay uses for the replicated routing table, where the entry says where the account lives.
    Declared,
}

/// Authentication/storage failures are not directory acceptance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    /// Invalid or missing installed anchor, or another subject.
    #[error("anchor")]
    Anchor,
    /// Codec, network, signature, or exact embedded-frame verification failed.
    #[error("evidence")]
    Evidence,
    /// Missing/invalid/rolled-back clock.
    #[error("clock")]
    Clock,
    /// Future issue time or expired terminal head.
    #[error("validity")]
    Validity,
    /// Terminal relay tuple differs from current authenticated caller configuration.
    #[error("binding")]
    Binding,
    /// Entire presented batch exceeds a frame/cumulative bound.
    #[error("resource")]
    Resource,
    /// Missing contiguous revision or wrong predecessor.
    #[error("link")]
    Link,
    /// A retained older exact statement cannot replace the head.
    #[error("rollback")]
    Rollback,
    /// Schema or issue timestamp regresses.
    #[error("order")]
    Order,
    /// A role generation did not change exactly with its point.
    #[error("generation")]
    Generation,
    /// A changed role reuses any prior role's x coordinate.
    #[error("key-reuse")]
    KeyReuse,
    /// A verified fork is durably quarantined, or was already quarantined.
    #[error("fork")]
    Fork,
    /// New enrollment requested for an already enrolled subject.
    #[error("already-enrolled")]
    AlreadyEnrolled,
    /// No accepted head exists yet.
    #[error("unenrolled")]
    Unenrolled,
    /// Expected external checkpoint does not match retained state.
    #[error("continuity")]
    Continuity,
    /// Missing/corrupt/unknown local format, storage error, or unusable handle.
    #[error("unavailable")]
    Unavailable,
}

/// Exact authenticated historical bytes. This type grants no fresh routing authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalEvidence {
    /// Original bare frame (extracted from the retained wrapper without re-encoding).
    pub statement: Vec<u8>,
    /// Original stable validating wrapper.
    pub attestation: Vec<u8>,
    /// Exact type-4 T1.
    pub hash: [u8; 32],
}

/// Durable state description; no freshness or routing authority is implied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    /// External continuity token after this operation.
    pub checkpoint: Checkpoint,
    /// Accepted head, absent only for a fork discovered during initial enrollment.
    pub head: Option<[u8; 32]>,
    /// Accepted revision, if a head exists.
    pub revision: Option<u64>,
    /// Accepted message/stamp generations, if a head exists.
    pub generations: Option<[u64; 2]>,
    /// Accepted current stamp (without any freshness assertion).
    pub current_stamp: Option<AccountRef>,
    /// Accepted immediately previous stamp (without any freshness assertion).
    pub previous_stamp: Option<AccountRef>,
    /// Accepted-history count; proof-only fork records are counted separately.
    pub accepted: usize,
    /// Total retained records including a fork proof.
    pub retained: usize,
    /// Exact cumulative bare-frame plus stable-wrapper charge.
    pub charged_bytes: usize,
    /// Fresh use is permanently disabled pending external resolution.
    pub forked: bool,
    /// Last successful acceptance/check, or verified-fork observation time.
    pub checked_time: Timestamp,
}

/// Successful durable fresh-head check. Recheck before each new use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Current {
    /// Exact current signed bytes and T1.
    pub evidence: HistoricalEvidence,
    /// Current message-DH key; no retired-M new-use grace.
    pub message_key: AccountRef,
    /// Current stamp key.
    pub stamp_key: AccountRef,
    /// Immediately previous stamp, preserved by renewals and M-only rotations.
    pub previous_stamp: Option<AccountRef>,
    /// The relay this entry says the account lives on.
    pub relay: RelayBinding,
    /// Exact wire revision.
    pub revision: u64,
    /// Exact message/stamp generations (not derivation indices).
    pub generations: [u64; 2],
    /// Durable state/checkpoint accompanying this fresh result.
    pub status: Status,
}
