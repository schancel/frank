//! One bounded native owner for the open directory.
//!
//! Any key may publish its own signed entry. The first valid revision 0 a key publishes for
//! itself pins that key's chain; later revisions must extend it. There is no per-account
//! configuration: continuity lives in the relay's own database, one row per subject.
use crate::{directory_admission::*, registry::Registry, store::directory_subjects::SubjectRow};
use cashweb_config::DirectoryConf;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch};

/// Operational response budget, including body collection and queue time.
pub const RESPONSE_BUDGET: Duration = Duration::from_secs(60);
const QUEUED: u8 = 0;
const STARTED: u8 = 1;
const TERMINAL: u8 = 2;
const CANCELLED: u8 = 3;
type Key = (String, String);
type Result<T> = std::result::Result<T, RuntimeError>;
/// Static route-local errors; raw storage/configuration material is never returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    /// Finite pending capacity is full; operation never entered the owner.
    Busy,
    /// Proven queued cancellation, expiry or unavailable readiness.
    NotStarted,
    /// Started operation or checkpoint completion cannot be inferred from the response.
    OutcomeUnknown,
    /// Subject has not published or exact accepted history is absent.
    NotFound,
    /// Malformed route or frame, without fallback parsing.
    Invalid,
    /// Expired, conflicting, out-of-order or quarantined history.
    Trust,
    /// Frame, history or relay-wide subject capacity exceeded.
    Resource,
    /// The entry, or the relay binding inside it, has expired or is not yet valid.
    Expired,
    /// The subject's history holds two conflicting signed branches.
    Forked,
}
impl From<AdmissionError> for RuntimeError {
    fn from(e: AdmissionError) -> Self {
        match e {
            AdmissionError::Resource => Self::Resource,
            AdmissionError::Evidence => Self::Invalid,
            AdmissionError::Validity | AdmissionError::Binding => Self::Expired,
            AdmissionError::Fork => Self::Forked,
            _ => Self::Trust,
        }
    }
}
/// Exact route operation. Historical results carry no current authority.
#[derive(Debug)]
pub enum Operation {
    /// Submit one immutable exact stable attestation.
    Put(Vec<u8>),
    /// Recheck the retained head using freshly supplied trust and clock.
    Current,
    /// Retrieve exact accepted history without granting current authority.
    Historical([u8; 32]),
    /// Every retained record as one canonical CBOR array of byte strings, for another relay.
    Chain,
    /// Test-only gate for observing started ownership without blocking Tokio.
    #[cfg(test)]
    Barrier {
        /// Signal when the native owner starts the operation.
        entered: oneshot::Sender<()>,
        /// Release the native owner from the test gate.
        release: std::sync::mpsc::Receiver<()>,
        /// Actual operation performed after release.
        next: Box<Operation>,
    },
}
/// Exact stable type-2 bytes returned by the public admission facade.
#[derive(Debug)]
pub struct Evidence {
    /// Original stable validating wrapper, never reencoded.
    pub attestation: Vec<u8>,
    /// Explicit historical classification; false remains a point-in-time fresh check.
    pub historical: bool,
}
/// Typed operation for native consumers which require genuine admitted domain snapshots.
#[derive(Debug)]
pub enum SnapshotOperation {
    /// Recheck current trust and trusted time through the existing owner.
    Current,
    /// Retrieve one exact retained record without current authority.
    Historical([u8; 32]),
}

/// Copy-owned admission results; never reconstructed from HTTP evidence bytes.
#[derive(Debug)]
pub enum AdmittedSnapshot {
    /// The actual result of the public fresh Directory::current operation.
    Current(Current),
    /// Exact public accepted history, explicitly without fresh-head authority.
    Historical(HistoricalEvidence),
}
impl AdmittedSnapshot {
    fn into_evidence(self) -> Evidence {
        match self {
            Self::Current(current) => Evidence {
                attestation: current.evidence.attestation,
                historical: false,
            },
            Self::Historical(evidence) => Evidence {
                attestation: evidence.attestation,
                historical: true,
            },
        }
    }
}

/// Typed response guard using the original queued/started/deadline lifetime.
#[derive(Debug)]
pub struct SnapshotSubmission {
    submission: Submission,
    receiver: oneshot::Receiver<Result<AdmittedSnapshot>>,
}
impl SnapshotSubmission {
    /// Preserve queued cancellation and started-uncertainty semantics of Submission.
    pub async fn wait(self) -> Result<AdmittedSnapshot> {
        self.submission.wait().await?;
        self.receiver
            .await
            .map_err(|_| RuntimeError::OutcomeUnknown)?
    }
}

/// Largest directory entry a relay accepts. An ordinary entry is under 600 bytes.
pub const MAX_ENTRY_BYTES: usize = 8 * 1024;
/// Open subject handles kept in memory; least recently used is closed first.
const MAX_OPEN_HANDLES: usize = if cfg!(test) { 8 } else { 256 };

/// Source of "now". Production uses the system clock.
pub type Clock = Arc<dyn Fn() -> Option<Timestamp> + Send + Sync>;
/// Wall-clock Unix time with nanosecond precision.
pub fn system_clock() -> Clock {
    Arc::new(|| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        Some(Timestamp {
            seconds: i64::try_from(now.as_secs()).ok()?,
            nanoseconds: now.subsec_nanos(),
        })
    })
}

/// The one relay-wide tuple a client embeds in its own entry to say "this account lives here".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayInfo {
    /// Protocol network this relay serves entries for.
    pub network: String,
    /// Exact relay binding: id, endpoint, key and expiry.
    pub binding: RelayBinding,
}
impl RelayInfo {
    fn from_config(config: &DirectoryConf) -> Result<Self> {
        if config.validate().is_err() || !valid_network(&config.network) {
            return Err(RuntimeError::Trust);
        }
        let point = exact(&config.relay_identity, 33)?;
        if !matches!(point[0], 2 | 3) || secp256k1_abc::PublicKey::from_slice(&point).is_err() {
            return Err(RuntimeError::Trust);
        }
        let endpoint = url::Url::parse(&config.endpoint).map_err(|_| RuntimeError::Trust)?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
            || config.endpoint.ends_with('/')
        {
            return Err(RuntimeError::Trust);
        }
        Ok(Self {
            network: config.network.clone(),
            binding: RelayBinding {
                relay_id: exact(&config.relay_id, 16)?,
                endpoint: config.endpoint.clone(),
                identity: AccountRef {
                    key_type: 1,
                    key_bytes: point,
                },
                expiry: nanos(&config.binding_expiry_ns)?,
                unknown: vec![],
            },
        })
    }
    /// Binding expiry as decimal Unix nanoseconds.
    pub fn binding_expiry_ns(&self) -> String {
        (self.binding.expiry.seconds as i128 * 1_000_000_000
            + self.binding.expiry.nanoseconds as i128)
            .to_string()
    }
    /// Whether an entry's relay binding names this relay (expiry is not compared).
    pub fn is_local(&self, relay: &RelayBinding) -> bool {
        relay.endpoint == self.binding.endpoint && relay.relay_id == self.binding.relay_id
    }
}
struct Shared {
    closed: AtomicBool,
    ready: AtomicBool,
    subjects: AtomicU64,
    replicated: AtomicU64,
    stopped: watch::Sender<bool>,
}
struct Owner {
    shared: Arc<Shared>,
    info: RelayInfo,
    enrollments_per_source_per_hour: u32,
    sync_interval: Duration,
    trusted_proxies: Vec<std::net::IpAddr>,
    federation: OnceLock<Arc<crate::directory_federation::Federation>>,
    registry: Arc<Registry>,
    sender: Mutex<Option<mpsc::Sender<Job>>>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        self.shared.ready.store(false, Ordering::Release);
        self.sender.get_mut().unwrap().take();
    }
}
/// Cloneable request handle; clones share the same single worker and queue.
#[derive(Clone)]
pub struct DirectoryRuntime {
    owner: Arc<Owner>,
}
impl std::fmt::Debug for DirectoryRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DirectoryRuntime")
    }
}
struct Job {
    key: Key,
    deadline: Instant,
    phase: Arc<AtomicU8>,
    reply: oneshot::Sender<Result<Evidence>>,
    work: Work,
}
enum Work {
    Request(Operation),
    Snapshot(SnapshotOperation, oneshot::Sender<Result<AdmittedSnapshot>>),
}
/// Reserved pending capacity, acquired before request-body buffering.
pub struct Reservation {
    permit: mpsc::OwnedPermit<Job>,
    key: Key,
    deadline: Instant,
}
/// Response lifetime guard. Dropping it cancels only a still-queued operation.
pub struct Submission {
    receiver: oneshot::Receiver<Result<Evidence>>,
    phase: Arc<AtomicU8>,
    deadline: Instant,
}
impl std::fmt::Debug for Reservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DirectoryReservation")
    }
}
impl std::fmt::Debug for Submission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DirectorySubmission")
    }
}
impl Drop for Submission {
    fn drop(&mut self) {
        let _ = self
            .phase
            .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
    }
}
impl Submission {
    /// A started deadline/disconnect is uncertain and never relinquishes native ownership.
    pub async fn wait(mut self) -> Result<Evidence> {
        match tokio::time::timeout_at(self.deadline.into(), &mut self.receiver).await {
            Ok(Ok(value)) => value,
            _ => {
                if self
                    .phase
                    .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                    || self.phase.load(Ordering::Acquire) == CANCELLED
                {
                    Err(RuntimeError::NotStarted)
                } else {
                    Err(RuntimeError::OutcomeUnknown)
                }
            }
        }
    }
}
struct Principal<'a> {
    anchor: Anchor,
    directory: Directory<'a>,
    /// Last continuity row written for this subject.
    row: SubjectRow,
    unavailable: bool,
    used: u64,
    /// The verified current entry and when it stops being current. Lookups are answered from
    /// this without touching storage or checking a signature until the entry changes or expires.
    cached: Option<(Current, Timestamp)>,
    /// When this relay last accepted a new revision of this account.
    revised: Option<Instant>,
}
fn nanos(text: &str) -> Result<Timestamp> {
    if text.is_empty()
        || text.len() > 28
        || !text.bytes().all(|b| b.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return Err(RuntimeError::Trust);
    }
    let n: u128 = text.parse().map_err(|_| RuntimeError::Trust)?;
    Ok(Timestamp {
        seconds: (n / 1_000_000_000)
            .try_into()
            .map_err(|_| RuntimeError::Trust)?,
        nanoseconds: (n % 1_000_000_000) as u32,
    })
}
fn exact(text: &str, n: usize) -> Result<Vec<u8>> {
    if text.len() != n * 2
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(RuntimeError::Trust);
    }
    hex::decode(text).map_err(|_| RuntimeError::Trust)
}
fn valid_network(network: &str) -> bool {
    !network.is_empty()
        && network.len() <= 64
        && network.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'-' | b'_' | b'.'))
        })
}
/// Cheap exact route grammar; it grants nothing by itself.
pub fn valid_key(network: &str, subject: &str) -> bool {
    valid_network(network)
        && subject.len() == 66
        && (subject.starts_with("02") || subject.starts_with("03"))
        && exact(subject, 33).is_ok()
}
fn tuple(t: Timestamp) -> (i64, u32) {
    (t.seconds, t.nanoseconds)
}
/// Everything the single worker thread owns.
struct Worker<'a> {
    registry: &'a Registry,
    info: RelayInfo,
    max_subjects: u64,
    max_replicated_subjects: u64,
    max_revisions: usize,
    min_revision_interval: Duration,
    clock: Clock,
    last: Timestamp,
    handles: HashMap<Key, Principal<'a>>,
    tick: u64,
    shared: Arc<Shared>,
}
impl<'a> Worker<'a> {
    /// System time, never earlier than a time this worker already used.
    fn now(&mut self) -> Result<Timestamp> {
        let now = (self.clock)().ok_or(RuntimeError::Trust)?;
        if tuple(now) > tuple(self.last) {
            self.last = now;
        }
        Ok(self.last)
    }
    fn rows(&self) -> Result<crate::store::directory_subjects::DbDirectorySubjects<'a>> {
        self.registry
            .directory_subjects()
            .map_err(|_| RuntimeError::NotStarted)
    }
    /// Reopen a published subject from its continuity row. `None` means it never published.
    fn open(&mut self, key: &Key) -> Result<Option<Principal<'a>>> {
        let subject = exact(&key.1, 33)?;
        let Some(row) = self
            .rows()?
            .get(&key.0, &subject)
            .map_err(|_| RuntimeError::NotStarted)?
        else {
            return Ok(None);
        };
        let address = crate::monad_stamp_stealth::recipient_address_from_public_key(&subject)
            .map_err(|_| RuntimeError::Invalid)?
            .0;
        let anchor = Anchor {
            network: key.0.clone(),
            subject: AccountRef {
                key_type: 1,
                key_bytes: subject.clone(),
            },
            revision_zero: row.anchor,
        };
        if row.version != 1 || row.checkpoint.anchor != row.anchor {
            return Err(RuntimeError::Trust);
        }
        match self
            .registry
            .directory_preview(anchor.clone(), OpenMode::Reopen(row.checkpoint))
        {
            Ok(directory) => Ok(Some(Principal {
                anchor,
                directory,
                row,
                unavailable: false,
                used: 0,
                cached: None,
                revised: None,
            })),
            Err(_) if row.checkpoint.kind == CheckpointKind::ProspectiveEnrollment => {
                // The process stopped between writing the row and accepting the first entry.
                // Nothing was ever served for this key, so it is simply unpublished again.
                match self
                    .registry
                    .directory_preview(anchor, OpenMode::NewEnrollment)
                {
                    Ok(_) => {
                        self.rows()?
                            .delete(&key.0, &subject, &address)
                            .map_err(|_| RuntimeError::NotStarted)?;
                        Ok(None)
                    }
                    Err(_) => Err(RuntimeError::Trust),
                }
            }
            Err(error) => Err(error.into()),
        }
    }
    fn evict(&mut self) {
        while self.handles.len() >= MAX_OPEN_HANDLES {
            let Some(oldest) = self
                .handles
                .iter()
                .min_by_key(|(_, p)| p.used)
                .map(|(key, _)| key.clone())
            else {
                return;
            };
            self.handles.remove(&oldest);
        }
    }
    /// First entry of a key this relay has not seen: it must be that key's own revision 0.
    fn enroll(&mut self, key: &Key, bytes: Vec<u8>, now: Timestamp) -> Result<AdmittedSnapshot> {
        if bytes.len() > MAX_ENTRY_BYTES {
            return Err(RuntimeError::Resource);
        }
        let subject = exact(&key.1, 33)?;
        let verified = frank_cbor::verify_preview_directory_evidence(&bytes, &key.0)
            .map_err(|_| RuntimeError::Invalid)?;
        if verified.statement_frame().schema_version != 4 {
            return Err(RuntimeError::Invalid);
        }
        let Some(frank_cbor::TypedPayload::DirectoryStatement {
            subject: signer,
            revision,
            relays,
            ..
        }) = verified.statement_frame().typed.as_deref()
        else {
            return Err(RuntimeError::Invalid);
        };
        // The codec verified the signature against `signer`; it must be the key in the path.
        if signer.key_type != 1 || signer.key_bytes != subject {
            return Err(RuntimeError::Invalid);
        }
        if *revision != 0 {
            return Err(RuntimeError::Trust);
        }
        // Accounts that live here and copies of accounts that live elsewhere have separate
        // budgets, so entries arriving from peers cannot block sign-ups on this relay.
        let local = relays
            .first()
            .is_some_and(|relay| self.info.is_local(relay));
        let (counter, budget) = if local {
            (&self.shared.subjects, self.max_subjects)
        } else {
            (&self.shared.replicated, self.max_replicated_subjects)
        };
        if counter.load(Ordering::Acquire) >= budget {
            return Err(RuntimeError::Resource);
        }
        let anchor = Anchor {
            network: key.0.clone(),
            subject: signer.clone(),
            revision_zero: verified.statement_hash,
        };
        let statement = verified.statement_frame().frame.clone();
        let candidate = Candidate {
            statement: &statement,
            attestation: &bytes,
        };
        let prospective = Checkpoint::for_enrollment(&anchor, candidate, now)?;
        let address = crate::monad_stamp_stealth::recipient_address_from_public_key(&subject)
            .map_err(|_| RuntimeError::Invalid)?
            .0;
        let mut row = SubjectRow {
            version: 1,
            anchor: anchor.revision_zero,
            checkpoint: prospective,
            local,
        };
        let rows = self.rows()?;
        rows.put(&key.0, &subject, Some(&address), &row)
            .map_err(|_| RuntimeError::OutcomeUnknown)?;
        let forget = |rows: &crate::store::directory_subjects::DbDirectorySubjects<'_>| {
            rows.delete(&key.0, &subject, &address)
                .map_err(|_| RuntimeError::OutcomeUnknown)
        };
        let directory = match self
            .registry
            .directory_preview(anchor.clone(), OpenMode::NewEnrollment)
        {
            Ok(directory) => directory,
            Err(error) => {
                forget(&rows)?;
                return Err(error.into());
            }
        };
        let result = directory.advance_declared(&[candidate], Some(now));
        let enrolled = match &result {
            Ok(_) => true,
            Err(_) => !matches!(directory.status(), Ok(None)),
        };
        if !enrolled {
            forget(&rows)?;
            return Err(result.unwrap_err().into());
        }
        if let Ok(Some(status)) = directory.status() {
            row.checkpoint = status.checkpoint;
            rows.put(&key.0, &subject, None, &row)
                .map_err(|_| RuntimeError::OutcomeUnknown)?;
        }
        if local {
            self.shared.subjects.fetch_add(1, Ordering::AcqRel);
        } else {
            self.shared.replicated.fetch_add(1, Ordering::AcqRel);
        }
        self.evict();
        self.tick += 1;
        self.handles.insert(
            key.clone(),
            Principal {
                anchor,
                directory,
                row,
                unavailable: false,
                used: self.tick,
                cached: None,
                revised: Some(Instant::now()),
            },
        );
        let (current, until) = self.finish(result?)?;
        if let Some(p) = self.handles.get_mut(key) {
            p.cached = Some((current.clone(), until));
        }
        Ok(AdmittedSnapshot::Current(current))
    }
    /// The entry and its relay binding must still be unexpired when the answer leaves.
    fn finish(&mut self, current: Current) -> Result<(Current, Timestamp)> {
        let parsed = frank_cbor::validate_frame(
            &current.evidence.statement,
            &frank_cbor::preview_directory_context(),
        )
        .map_err(|_| RuntimeError::Trust)?;
        let frank_cbor::ValidationResult::Parsed(parsed) = parsed else {
            return Err(RuntimeError::Trust);
        };
        if parsed.schema_version != 4 {
            return Err(RuntimeError::Trust);
        }
        let Some(frank_cbor::TypedPayload::DirectoryStatement {
            expiry: Some(expiry),
            ..
        }) = parsed.typed.as_deref()
        else {
            return Err(RuntimeError::Trust);
        };
        let finished = self.now()?;
        if tuple(finished) < tuple(current.status.checked_time)
            || tuple(finished) >= tuple(*expiry)
            || tuple(finished) >= tuple(current.relay.expiry)
        {
            return Err(RuntimeError::Expired);
        }
        let until = if tuple(*expiry) < tuple(current.relay.expiry) {
            *expiry
        } else {
            current.relay.expiry
        };
        Ok((current, until))
    }
    fn execute(&mut self, key: &Key, op: Operation) -> Result<AdmittedSnapshot> {
        #[cfg(test)]
        let op = match op {
            Operation::Barrier {
                entered,
                release,
                next,
            } => {
                let _ = entered.send(());
                release.recv().map_err(|_| RuntimeError::OutcomeUnknown)?;
                *next
            }
            other => other,
        };
        if key.0 != self.info.network {
            return Err(RuntimeError::NotFound);
        }
        let now = self.now()?;
        if !self.handles.contains_key(key) {
            match self.open(key)? {
                Some(principal) => {
                    self.evict();
                    self.handles.insert(key.clone(), principal);
                }
                None => {
                    return match op {
                        Operation::Put(bytes) => self.enroll(key, bytes, now),
                        _ => Err(RuntimeError::NotFound),
                    }
                }
            }
        }
        self.tick += 1;
        let tick = self.tick;
        let rows = self.rows()?;
        let p = self.handles.get_mut(key).ok_or(RuntimeError::NotFound)?;
        p.used = tick;
        if p.unavailable {
            return Err(RuntimeError::Trust);
        }
        if let Operation::Historical(hash) = op {
            return p
                .directory
                .historical_evidence(hash)?
                .map(AdmittedSnapshot::Historical)
                .ok_or(RuntimeError::NotFound);
        }
        if matches!(op, Operation::Chain) {
            let records = p
                .directory
                .retained()?
                .into_iter()
                .map(|record| frank_cbor::CborValue::Bytes(record.attestation))
                .collect();
            let chain = frank_cbor::encode_canonical(&frank_cbor::CborValue::Array(records))
                .map_err(|_| RuntimeError::Resource)?;
            return Ok(AdmittedSnapshot::Historical(HistoricalEvidence {
                statement: vec![],
                attestation: chain,
                hash: [0; 32],
            }));
        }
        // Persist a changed head, length or quarantine. A later checked time alone is not
        // rewritten: an older floor still reopens the same history.
        let remember = |p: &mut Principal<'_>, checkpoint: Checkpoint| -> Result<()> {
            let mut same_but_time = checkpoint;
            same_but_time.checked_time = p.row.checkpoint.checked_time;
            if same_but_time == p.row.checkpoint {
                return Ok(());
            }
            let row = SubjectRow {
                version: 1,
                anchor: p.row.anchor,
                checkpoint,
                local: p.row.local,
            };
            if rows
                .put(&p.anchor.network, &p.anchor.subject.key_bytes, None, &row)
                .is_err()
            {
                p.unavailable = true;
                return Err(RuntimeError::OutcomeUnknown);
            }
            p.row = row;
            Ok(())
        };
        let (max_revisions, min_interval) = (self.max_revisions, self.min_revision_interval);
        let result = match op {
            Operation::Current => {
                if let Some((current, until)) = &p.cached {
                    if tuple(now) < tuple(*until) {
                        return Ok(AdmittedSnapshot::Current(current.clone()));
                    }
                }
                p.directory.current_declared(Some(now))
            }
            Operation::Put(bytes) => {
                if bytes.len() > MAX_ENTRY_BYTES {
                    return Err(RuntimeError::Resource);
                }
                let verified =
                    frank_cbor::verify_preview_directory_evidence(&bytes, &p.anchor.network)
                        .map_err(|_| RuntimeError::Invalid)?;
                if verified.statement_frame().schema_version != 4 {
                    return Err(RuntimeError::Invalid);
                }
                let statement = &verified.statement_frame().frame;
                let candidate = Candidate {
                    statement,
                    attestation: &bytes,
                };
                if let Some(existing) = p.directory.historical_evidence(verified.statement_hash)? {
                    if existing.statement != *statement || existing.attestation != bytes {
                        return Err(RuntimeError::Invalid);
                    }
                    p.directory.current_declared(Some(now))
                } else {
                    // A new revision. Publishing is free, so its count and pace are bounded.
                    if p.row.checkpoint.retained >= max_revisions
                        || p.revised.is_some_and(|at| at.elapsed() < min_interval)
                    {
                        return Err(RuntimeError::Resource);
                    }
                    p.cached = None;
                    let advanced = p.directory.advance_declared(&[candidate], Some(now));
                    if advanced.is_ok() {
                        p.revised = Some(Instant::now());
                    }
                    advanced
                }
            }
            Operation::Historical(_) | Operation::Chain => unreachable!(),
            #[cfg(test)]
            Operation::Barrier { .. } => unreachable!(),
        };
        match result {
            Ok(current) => {
                remember(p, current.status.checkpoint)?;
                let (current, until) = self.finish(current)?;
                if let Some(p) = self.handles.get_mut(key) {
                    p.cached = Some((current.clone(), until));
                }
                Ok(AdmittedSnapshot::Current(current))
            }
            Err(error) => {
                if error == AdmissionError::Fork {
                    if let Some(status) = p.directory.status()? {
                        remember(p, status.checkpoint)?;
                    }
                }
                if error == AdmissionError::Unavailable {
                    p.unavailable = true;
                }
                Err(error.into())
            }
        }
    }
}
impl DirectoryRuntime {
    /// Start exactly one native owner per registry, on the system clock.
    pub fn start(
        registry: Arc<Registry>,
        config: DirectoryConf,
    ) -> Result<(Self, oneshot::Receiver<Result<()>>)> {
        Self::start_with_clock(registry, config, system_clock())
    }
    /// As [`Self::start`] with an explicit time source.
    pub fn start_with_clock(
        registry: Arc<Registry>,
        config: DirectoryConf,
        clock: Clock,
    ) -> Result<(Self, oneshot::Receiver<Result<()>>)> {
        let info = RelayInfo::from_config(&config)?;
        let enrollments_per_source_per_hour = config.enrollments_per_source_per_hour;
        let config_sync_interval_s = config.sync_interval_s;
        let trusted_proxies = config.trusted_proxies.clone();
        static OWNERS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
        let address = Arc::as_ptr(&registry) as usize;
        if !OWNERS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(address)
        {
            return Err(RuntimeError::Busy);
        }
        struct Claim(usize);
        impl Drop for Claim {
            fn drop(&mut self) {
                OWNERS.get().unwrap().lock().unwrap().remove(&self.0);
            }
        }
        let claim = Claim(address);
        let (sender, mut receiver) = mpsc::channel::<Job>(8);
        let (ready_send, ready) = oneshot::channel();
        let (stopped, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            subjects: AtomicU64::new(0),
            replicated: AtomicU64::new(0),
            stopped,
        });
        let worker_shared = shared.clone();
        let worker_registry = registry.clone();
        let worker_info = info.clone();
        let join = thread::Builder::new()
            .name("directory-owner".into())
            .spawn(move || {
                let _claim = claim;
                let registry = worker_registry;
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let started =
                        clock().filter(|now| tuple(*now) < tuple(worker_info.binding.expiry));
                    let count = registry.directory_subjects().and_then(|rows| rows.count());
                    let (Some(started), Ok(count)) = (started, count) else {
                        let _ = ready_send.send(Err(RuntimeError::Trust));
                        return;
                    };
                    if worker_shared.closed.load(Ordering::Acquire) {
                        let _ = ready_send.send(Err(RuntimeError::NotStarted));
                        return;
                    }
                    worker_shared.subjects.store(count.0, Ordering::Release);
                    worker_shared.replicated.store(count.1, Ordering::Release);
                    let mut worker = Worker {
                        registry: &registry,
                        info: worker_info,
                        max_subjects: config.max_subjects,
                        max_replicated_subjects: config.max_replicated_subjects,
                        max_revisions: config.max_revisions_per_subject,
                        min_revision_interval: Duration::from_secs(config.min_revision_interval_s),
                        clock,
                        last: started,
                        handles: HashMap::new(),
                        tick: 0,
                        shared: worker_shared.clone(),
                    };
                    worker_shared.ready.store(true, Ordering::Release);
                    let _ = ready_send.send(Ok(()));
                    while let Some(job) = receiver.blocking_recv() {
                        if worker_shared.closed.load(Ordering::Acquire) {
                            receiver.close();
                        }
                        if worker_shared.closed.load(Ordering::Acquire)
                            || job.reply.is_closed()
                            || Instant::now() >= job.deadline
                            || job
                                .phase
                                .compare_exchange(
                                    QUEUED,
                                    STARTED,
                                    Ordering::AcqRel,
                                    Ordering::Acquire,
                                )
                                .is_err()
                        {
                            let _ = job.phase.compare_exchange(
                                QUEUED,
                                CANCELLED,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            );
                            let _ = job.reply.send(Err(RuntimeError::NotStarted));
                            continue;
                        }
                        let result = match job.work {
                            Work::Request(op) => worker
                                .execute(&job.key, op)
                                .map(AdmittedSnapshot::into_evidence),
                            Work::Snapshot(operation, reply) => {
                                let operation = match operation {
                                    SnapshotOperation::Current => Operation::Current,
                                    SnapshotOperation::Historical(hash) => {
                                        Operation::Historical(hash)
                                    }
                                };
                                let snapshot = worker.execute(&job.key, operation);
                                let completion = snapshot
                                    .as_ref()
                                    .map(|_| Evidence {
                                        attestation: vec![],
                                        historical: false,
                                    })
                                    .map_err(|error| *error);
                                let _ = reply.send(snapshot);
                                completion
                            }
                        };
                        job.phase.store(TERMINAL, Ordering::Release);
                        let _ = job.reply.send(result);
                    }
                }));
                worker_shared.ready.store(false, Ordering::Release);
                worker_shared.closed.store(true, Ordering::Release);
                worker_shared.stopped.send_replace(true);
            })
            .map_err(|_| RuntimeError::NotStarted)?;
        Ok((
            Self {
                owner: Arc::new(Owner {
                    shared,
                    info,
                    enrollments_per_source_per_hour,
                    sync_interval: Duration::from_secs(config_sync_interval_s.max(1)),
                    trusted_proxies,
                    federation: OnceLock::new(),
                    registry,
                    sender: Mutex::new(Some(sender)),
                    join: Mutex::new(Some(join)),
                }),
            },
            ready,
        ))
    }
    /// Private composition identity check; it grants no Directory authority or snapshot.
    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
    }
    /// The relay-wide tuple accounts embed in their entries.
    pub fn info(&self) -> &RelayInfo {
        &self.owner.info
    }
    /// Turn on talking to other relays: copying entries with `peers` and, when `forwarding`,
    /// passing messages on to the relay a recipient's entry names. Once per runtime.
    pub fn enable_federation(&self, peers: Vec<url::Url>, forwarding: bool) {
        let _ = self
            .owner
            .federation
            .set(Arc::new(crate::directory_federation::Federation::new(
                peers, forwarding,
            )));
    }
    /// Present once [`Self::enable_federation`] was called.
    pub fn federation(&self) -> Option<&Arc<crate::directory_federation::Federation>> {
        self.owner.federation.get()
    }
    /// Pause between rounds of comparing entries with peers and retrying forwards.
    pub fn sync_interval(&self) -> Duration {
        self.owner.sync_interval
    }
    /// Reverse proxies allowed to report the client address.
    pub fn trusted_proxies(&self) -> &[std::net::IpAddr] {
        &self.owner.trusted_proxies
    }
    /// Whether shutdown has begun.
    pub fn is_closed(&self) -> bool {
        self.owner.shared.closed.load(Ordering::Acquire)
    }
    pub(crate) fn registry(&self) -> &Arc<Registry> {
        &self.owner.registry
    }
    /// First-time publications one source may make per clock hour.
    pub fn enrollments_per_source_per_hour(&self) -> u32 {
        self.owner.enrollments_per_source_per_hour
    }
    /// Whether this key already has a continuity row here. A cheap read, not an admission.
    pub fn is_published(&self, network: &str, subject: &str) -> bool {
        let Ok(subject) = exact(subject, 33) else {
            return false;
        };
        self.owner
            .registry
            .directory_subjects()
            .and_then(|rows| rows.get(network, &subject))
            .is_ok_and(|row| row.is_some())
    }
    /// What this relay would list for `subject`: head hash, retained record count, quarantine.
    pub fn listed(&self, network: &str, subject: &str) -> Option<(Option<String>, u64, bool)> {
        let subject = exact(subject, 33).ok()?;
        let row = self
            .owner
            .registry
            .directory_subjects()
            .and_then(|rows| rows.get(network, &subject))
            .ok()??;
        Some((
            row.checkpoint.head.map(hex::encode),
            row.checkpoint.retained as u64,
            row.checkpoint.forked,
        ))
    }
    /// One page of the keys this relay holds, in key order after `after`, for a peer to compare.
    pub fn list(
        &self,
        network: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Option<Vec<(String, Option<String>, u64, bool)>> {
        let after = match after {
            Some(after) => Some(exact(after, 33).ok()?),
            None => None,
        };
        let rows = self
            .owner
            .registry
            .directory_subjects()
            .and_then(|rows| rows.list(network, after.as_deref(), limit))
            .ok()?;
        Some(
            rows.into_iter()
                .map(|(subject, row)| {
                    (
                        hex::encode(subject),
                        row.checkpoint.head.map(hex::encode),
                        row.checkpoint.retained as u64,
                        row.checkpoint.forked,
                    )
                })
                .collect(),
        )
    }
    /// The published key whose address is `address`, as lowercase hex. Callers must still ask
    /// for its current entry; the index alone proves nothing.
    pub fn subject_for_address(&self, network: &str, address: &[u8; 20]) -> Option<String> {
        self.owner
            .registry
            .directory_subjects()
            .and_then(|rows| rows.subject_for_address(network, address))
            .ok()
            .flatten()
            .map(hex::encode)
    }
    /// Reserve pending capacity after cheap route/media checks, before body collection.
    pub fn reserve(&self, network: &str, subject: &str) -> Result<Reservation> {
        if !valid_key(network, subject) {
            return Err(RuntimeError::Invalid);
        }
        if self.owner.shared.closed.load(Ordering::Acquire)
            || !self.owner.shared.ready.load(Ordering::Acquire)
        {
            return Err(RuntimeError::NotStarted);
        }
        let sender = self
            .owner
            .sender
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(RuntimeError::NotStarted)?
            .clone();
        let permit = sender.try_reserve_owned().map_err(|_| RuntimeError::Busy)?;
        Ok(Reservation {
            permit,
            key: (network.into(), subject.into()),
            deadline: Instant::now() + RESPONSE_BUDGET,
        })
    }
    /// Submit through previously reserved finite capacity; never creates a waiting producer.
    pub fn submit(&self, reservation: Reservation, op: Operation) -> Submission {
        self.send(reservation, Work::Request(op))
    }
    /// Obtain a real domain snapshot using the same finite owner.
    pub fn submit_snapshot(
        &self,
        reservation: Reservation,
        operation: SnapshotOperation,
    ) -> SnapshotSubmission {
        let (reply, receiver) = oneshot::channel();
        SnapshotSubmission {
            submission: self.send(reservation, Work::Snapshot(operation, reply)),
            receiver,
        }
    }
    fn send(&self, reservation: Reservation, work: Work) -> Submission {
        let (reply, receiver) = oneshot::channel();
        let phase = Arc::new(AtomicU8::new(QUEUED));
        reservation.permit.send(Job {
            key: reservation.key,
            deadline: reservation.deadline,
            phase: phase.clone(),
            reply,
            work,
        });
        Submission {
            receiver,
            phase,
            deadline: reservation.deadline,
        }
    }
    /// Stop acceptance and let the started operation retain ownership through terminal persistence.
    pub fn begin_shutdown(&self) {
        self.owner.shared.closed.store(true, Ordering::Release);
        self.owner.shared.ready.store(false, Ordering::Release);
        self.owner.sender.lock().unwrap().take();
    }
    /// Wait asynchronously for native completion; join only after the completion notification.
    pub async fn wait_stopped(&self) {
        let mut stopped = self.owner.shared.stopped.subscribe();
        while !*stopped.borrow() {
            if stopped.changed().await.is_err() {
                break;
            }
        }
        if let Some(join) = self.owner.join.lock().unwrap().take() {
            let _ = join.join();
        }
    }
}

/// A settable time source for tests whose signed fixtures carry fixed timestamps.
#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct TestClock(Arc<Mutex<Timestamp>>);
#[cfg(test)]
impl TestClock {
    pub(crate) fn at(seconds: i64) -> Self {
        Self(Arc::new(Mutex::new(Timestamp {
            seconds,
            nanoseconds: 0,
        })))
    }
    pub(crate) fn set(&self, seconds: i64) {
        *self.0.lock().unwrap() = Timestamp {
            seconds,
            nanoseconds: 0,
        };
    }
    pub(crate) fn clock(&self) -> Clock {
        let time = self.0.clone();
        Arc::new(move || Some(*time.lock().unwrap()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::directory::tests::{record, setup, SUBJECT};
    #[tokio::test]
    async fn finite_queue_cancel_races_started_owner_clock_and_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let (registry, config, clock) = setup(root.path());
        let (runtime, ready) =
            DirectoryRuntime::start_with_clock(registry.clone(), config.clone(), clock.clock())
                .unwrap();
        ready.await.unwrap().unwrap();
        assert!(matches!(
            DirectoryRuntime::start_with_clock(registry.clone(), config.clone(), clock.clock()),
            Err(RuntimeError::Busy)
        ));
        let network = config.network.as_str();
        let bytes = hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap();
        runtime
            .submit(
                runtime.reserve(network, SUBJECT).unwrap(),
                Operation::Put(bytes),
            )
            .wait()
            .await
            .unwrap();
        let (entered, started) = oneshot::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let mut running = runtime.submit(
            runtime.reserve(network, SUBJECT).unwrap(),
            Operation::Barrier {
                entered,
                release: barrier,
                next: Box::new(Operation::Put(
                    hex::decode(record("renew")["type2_hex"].as_str().unwrap()).unwrap(),
                )),
            },
        );
        started.await.unwrap();
        let mut pending = Vec::new();
        for _ in 0..8 {
            pending.push(runtime.submit(
                runtime.reserve(network, SUBJECT).unwrap(),
                Operation::Current,
            ));
        }
        assert!(matches!(
            runtime.reserve(network, SUBJECT),
            Err(RuntimeError::Busy)
        ));
        // The native thread is blocked; the event loop still advances and the active wait times out.
        running.deadline = Instant::now() + Duration::from_millis(5);
        let unknown = running.wait().await.unwrap_err();
        assert_eq!(unknown, RuntimeError::OutcomeUnknown);
        let response = crate::http::directory::error(unknown);
        assert_eq!(response.status().as_u16(), 503);
        assert_eq!(
            response.headers()["x-frank-directory-disposition"],
            "outcome-unknown"
        );
        let cancelled = pending.remove(0);
        drop(cancelled);
        assert!(matches!(
            runtime.reserve(network, SUBJECT),
            Err(RuntimeError::Busy)
        )); // bounded tombstone
        clock.set(1700000200);
        release.send(()).unwrap();
        for queued in pending {
            let recovered = queued.wait().await.unwrap();
            assert_eq!(
                hex::encode(recovered.attestation),
                record("renew")["type2_hex"].as_str().unwrap()
            );
        }
        // The accepted renewal is in the relay's own continuity row.
        let row = registry
            .directory_subjects()
            .unwrap()
            .get(network, &hex::decode(SUBJECT).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(row.checkpoint.accepted, 2);
        assert_eq!(
            hex::encode(row.checkpoint.head.unwrap()),
            record("renew")["t1"].as_str().unwrap()
        );
        // Cancellation wins before dequeue: no facade call and no later new operation starts.
        let (entered, started) = oneshot::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let running = runtime.submit(
            runtime.reserve(network, SUBJECT).unwrap(),
            Operation::Barrier {
                entered,
                release: barrier,
                next: Box::new(Operation::Current),
            },
        );
        started.await.unwrap();
        let mut cancelled = runtime.submit(
            runtime.reserve(network, SUBJECT).unwrap(),
            Operation::Put(vec![0]),
        );
        cancelled.deadline = Instant::now();
        assert!(matches!(
            cancelled.wait().await,
            Err(RuntimeError::NotStarted)
        ));
        runtime.begin_shutdown();
        assert!(
            tokio::time::timeout(Duration::from_millis(5), runtime.wait_stopped())
                .await
                .is_err()
        );
        drop(running);
        release.send(()).unwrap();
        runtime.wait_stopped().await;
        // Completion is retained even if wait_stopped subscribes after the worker exited.
        runtime.wait_stopped().await;
    }
    #[tokio::test]
    async fn more_subjects_than_open_handles_are_all_still_served() {
        let root = tempfile::tempdir().unwrap();
        let (registry, config, clock) = setup(root.path());
        let (runtime, ready) =
            DirectoryRuntime::start_with_clock(registry, config.clone(), clock.clock()).unwrap();
        ready.await.unwrap().unwrap();
        let mut published = Vec::new();
        for secret in 0..(MAX_OPEN_HANDLES as u32 + 8) {
            let entry = crate::http::directory::tests::entry(1000 + secret, |_| ());
            runtime
                .submit(
                    runtime.reserve(&config.network, &entry.subject).unwrap(),
                    Operation::Put(entry.attestation.clone()),
                )
                .wait()
                .await
                .unwrap();
            published.push(entry);
        }
        // The first subjects were closed to make room and reopen from their continuity rows.
        for entry in [&published[0], published.last().unwrap()] {
            let current = runtime
                .submit(
                    runtime.reserve(&config.network, &entry.subject).unwrap(),
                    Operation::Current,
                )
                .wait()
                .await
                .unwrap();
            assert_eq!(current.attestation, entry.attestation);
        }
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
}
