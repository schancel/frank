//! One bounded native owner for explicit directory trust generations and external continuity.
use crate::{directory_admission::*, registry::Registry};
use cashweb_config::{DirectoryConf, DirectoryPrincipalConf};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex, OnceLock, RwLock,
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
    /// Subject is not installed or exact accepted history is absent.
    NotFound,
    /// Malformed route or frame, without fallback parsing.
    Invalid,
    /// Missing, stale or inconsistent installed trust, continuity or quarantined history.
    Trust,
    /// Existing frame/history capacity exceeded.
    Resource,
}
impl From<AdmissionError> for RuntimeError {
    fn from(e: AdmissionError) -> Self {
        match e {
            AdmissionError::Resource => Self::Resource,
            AdmissionError::Evidence => Self::Invalid,
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

#[derive(Debug, Default)]
struct Published {
    generation: u64,
    keys: HashSet<Key>,
}
struct Shared {
    closed: AtomicBool,
    ready: AtomicBool,
    control: AtomicBool,
    published: RwLock<Published>,
    stopped: watch::Sender<bool>,
}
struct Owner {
    shared: Arc<Shared>,
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
    generation: u64,
    deadline: Instant,
    phase: Arc<AtomicU8>,
    reply: oneshot::Sender<Result<Evidence>>,
    work: Work,
}
enum Work {
    Request(Operation),
    Snapshot(SnapshotOperation, oneshot::Sender<Result<AdmittedSnapshot>>),
    Reload(DirectoryConf),
}
/// Reserved pending capacity, acquired before request-body buffering.
pub struct Reservation {
    permit: mpsc::OwnedPermit<Job>,
    key: Key,
    generation: u64,
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
    config: DirectoryPrincipalConf,
    anchor: Anchor,
    relay: RelayBinding,
    directory: Directory<'a>,
    checkpoint: Option<Checkpoint>,
    unavailable: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Continuity {
    version: u32,
    installed: DirectoryPrincipalConf,
    checkpoint: Checkpoint,
}
fn identity(mut c: DirectoryPrincipalConf) -> DirectoryPrincipalConf {
    c.mode = "enrolled".into();
    c
}
fn bounded_file(path: &Path, max: u64) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(|_| RuntimeError::Trust)?;
    if !meta.is_file() || meta.len() > max {
        return Err(RuntimeError::Trust);
    }
    let mut file = File::open(path).map_err(|_| RuntimeError::Trust)?;
    let opened = file.metadata().map_err(|_| RuntimeError::Trust)?;
    if !opened.is_file() {
        return Err(RuntimeError::Trust);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() {
            return Err(RuntimeError::Trust);
        }
    }
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take(max + 1)
        .read_to_end(&mut data)
        .map_err(|_| RuntimeError::Trust)?;
    if data.len() as u64 > max {
        return Err(RuntimeError::Trust);
    }
    Ok(data)
}
/// Read only an explicitly supplied trusted nanosecond clock. No wall-clock fallback.
pub fn trusted_time(path: &Path) -> Result<Timestamp> {
    let bytes = bounded_file(path, 32)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| RuntimeError::Trust)?
        .trim_end_matches('\n');
    nanos(text)
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
/// Cheap exact route grammar; it never manufactures installed authority.
pub fn valid_key(network: &str, subject: &str) -> bool {
    !network.is_empty()
        && network.len() <= 64
        && network.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'-' | b'_' | b'.'))
        })
        && subject.len() == 66
        && (subject.starts_with("02") || subject.starts_with("03"))
        && exact(subject, 33).is_ok()
}
fn canonical_target(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(RuntimeError::Trust);
    }
    if path.exists() {
        let meta = fs::symlink_metadata(path).map_err(|_| RuntimeError::Trust)?;
        if meta.file_type().is_symlink() {
            return Err(RuntimeError::Trust);
        }
        fs::canonicalize(path).map_err(|_| RuntimeError::Trust)
    } else {
        Ok(fs::canonicalize(path.parent().ok_or(RuntimeError::Trust)?)
            .map_err(|_| RuntimeError::Trust)?
            .join(path.file_name().ok_or(RuntimeError::Trust)?))
    }
}
fn check_floor(c: &DirectoryPrincipalConf, expected: Checkpoint) -> Result<()> {
    let existing: Continuity = serde_json::from_slice(&bounded_file(&c.continuity_file, 8192)?)
        .map_err(|_| RuntimeError::Trust)?;
    if existing.version != 1
        || existing.installed != identity(c.clone())
        || existing.checkpoint != expected
    {
        return Err(RuntimeError::Trust);
    }
    Ok(())
}
fn save(
    c: &DirectoryPrincipalConf,
    checkpoint: Checkpoint,
    prior: Option<Checkpoint>,
) -> Result<()> {
    if let Some(expected) = prior {
        check_floor(c, expected)?;
    }
    let first = prior.is_none();
    let data = serde_json::to_vec(&Continuity {
        version: 1,
        installed: identity(c.clone()),
        checkpoint,
    })
    .map_err(|_| RuntimeError::OutcomeUnknown)?;
    if data.len() > 8192 {
        return Err(RuntimeError::OutcomeUnknown);
    }
    let parent = c.continuity_file.parent().ok_or(RuntimeError::Trust)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| RuntimeError::OutcomeUnknown)?;
    temp.write_all(&data)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| RuntimeError::OutcomeUnknown)?;
    if first {
        temp.persist_noclobber(&c.continuity_file)
            .map_err(|_| RuntimeError::OutcomeUnknown)?;
    } else {
        temp.persist(&c.continuity_file)
            .map_err(|_| RuntimeError::OutcomeUnknown)?;
    }
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| RuntimeError::OutcomeUnknown)
}
fn stage<'a>(
    registry: &'a Registry,
    db_root: &Path,
    config: &DirectoryConf,
) -> Result<BTreeMap<Key, Principal<'a>>> {
    if config.principals.is_empty()
        || config.principals.len() > 1024
        || !config.clock_file.is_absolute()
    {
        return Err(RuntimeError::Resource);
    }
    let now = trusted_time(&config.clock_file)?;
    let db = fs::canonicalize(db_root).map_err(|_| RuntimeError::Trust)?;
    let sidecar = db.join("directory-preview-v1.rocksdb");
    let mut principals = BTreeMap::new();
    let mut paths = HashSet::new();
    for c in &config.principals {
        if !valid_key(&c.network, &c.subject) || exact(&c.manifest_identity, 32).is_err() {
            return Err(RuntimeError::Trust);
        }
        let continuity = canonical_target(&c.continuity_file)?;
        let bundle = fs::canonicalize(&c.bundle_root).map_err(|_| RuntimeError::Trust)?;
        if continuity.starts_with(&db)
            || continuity.starts_with(&sidecar)
            || continuity.starts_with(&bundle)
            || db.starts_with(&bundle)
            || !paths.insert(continuity)
        {
            return Err(RuntimeError::Trust);
        }
        let point = exact(&c.relay_identity, 33)?;
        if !matches!(point[0], 2 | 3) || secp256k1_abc::PublicKey::from_slice(&point).is_err() {
            return Err(RuntimeError::Trust);
        }
        let endpoint = url::Url::parse(&c.endpoint).map_err(|_| RuntimeError::Trust)?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err(RuntimeError::Trust);
        }
        let expiry = nanos(&c.binding_expiry_ns)?;
        if (expiry.seconds, expiry.nanoseconds) <= (now.seconds, now.nanoseconds) {
            return Err(RuntimeError::Trust);
        }
        let anchor = Anchor {
            network: c.network.clone(),
            subject: AccountRef {
                key_type: 1,
                key_bytes: exact(&c.subject, 33)?,
            },
            revision_zero: exact(&c.revision_zero, 32)?.try_into().unwrap(),
        };
        let relay = RelayBinding {
            relay_id: exact(&c.relay_id, 16)?,
            endpoint: c.endpoint.clone(),
            identity: AccountRef {
                key_type: 1,
                key_bytes: point,
            },
            expiry,
            unknown: vec![],
        };
        let checkpoint = match c.mode.as_str() {
            "new" if matches!(fs::symlink_metadata(&c.continuity_file), Err(ref error) if error.kind() == std::io::ErrorKind::NotFound) => {
                None
            }
            "reopen" => {
                let record: Continuity =
                    serde_json::from_slice(&bounded_file(&c.continuity_file, 8192)?)
                        .map_err(|_| RuntimeError::Trust)?;
                if record.version != 1 || record.installed != identity(c.clone()) {
                    return Err(RuntimeError::Trust);
                }
                Some(record.checkpoint)
            }
            _ => return Err(RuntimeError::Trust),
        };
        let directory = registry.directory_preview(
            anchor.clone(),
            checkpoint
                .map(OpenMode::Reopen)
                .unwrap_or(OpenMode::NewEnrollment),
        )?;
        if checkpoint.is_some() {
            // Validate staged authority without a durable freshness commit. A later
            // invalid principal must leave the previous generation's native clock and
            // external floor intact. A served operation performs its own fresh commit.
            directory.check_current(Context {
                now: Some(now),
                relay: Some(&relay),
            })?;
        }
        let key = (c.network.clone(), c.subject.clone());
        if principals
            .insert(
                key,
                Principal {
                    config: c.clone(),
                    anchor,
                    relay,
                    directory,
                    checkpoint,
                    unavailable: false,
                },
            )
            .is_some()
        {
            return Err(RuntimeError::Trust);
        }
    }
    Ok(principals)
}
fn execute(p: &mut Principal<'_>, op: Operation, now: Timestamp, clock: &Path) -> Result<Evidence> {
    execute_snapshot(p, op, now, clock).map(AdmittedSnapshot::into_evidence)
}

fn execute_snapshot(
    p: &mut Principal<'_>,
    op: Operation,
    now: Timestamp,
    clock: &Path,
) -> Result<AdmittedSnapshot> {
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
    if p.unavailable {
        return Err(RuntimeError::Trust);
    }
    if let Some(expected) = p.checkpoint {
        if check_floor(&p.config, expected).is_err() {
            p.unavailable = true;
            return Err(RuntimeError::Trust);
        }
    }
    if let Operation::Historical(hash) = op {
        return p
            .directory
            .historical_evidence(hash)?
            .map(AdmittedSnapshot::Historical)
            .ok_or(RuntimeError::NotFound);
    }
    let context = Context {
        now: Some(now),
        relay: Some(&p.relay),
    };
    let result = match op {
        Operation::Current => p.directory.current(context),
        Operation::Put(bytes) => {
            if bytes.len() > MAX_FRAME_BYTES {
                return Err(RuntimeError::Resource);
            }
            let verified = frank_cbor::verify_preview_directory_evidence(&bytes, &p.anchor.network)
                .map_err(|_| RuntimeError::Invalid)?;
            if verified.statement_frame().schema_version != 4 {
                return Err(RuntimeError::Invalid);
            }
            let statement = &verified.statement_frame().frame;
            let candidate = Candidate {
                statement,
                attestation: &bytes,
            };
            if let Some(existing) = p
                .directory
                .historical_evidence(verified.statement_hash)
                .or_else(|e| {
                    if e == AdmissionError::Unenrolled {
                        Ok(None)
                    } else {
                        Err(e)
                    }
                })?
            {
                if existing.statement != *statement || existing.attestation != bytes {
                    return Err(RuntimeError::Invalid);
                }
                p.directory.current(context)
            } else {
                if p.checkpoint.is_none() {
                    let prospective = Checkpoint::for_enrollment(&p.anchor, candidate, now)?;
                    if save(&p.config, prospective, None).is_err() {
                        p.unavailable = true;
                        return Err(RuntimeError::OutcomeUnknown);
                    }
                    p.checkpoint = Some(prospective);
                }
                p.directory.advance(&[candidate], context)
            }
        }
        Operation::Historical(_) => unreachable!(),
        #[cfg(test)]
        Operation::Barrier { .. } => unreachable!(),
    };
    match result {
        Ok(current) => {
            if save(&p.config, current.status.checkpoint, p.checkpoint).is_err() {
                p.unavailable = true;
                return Err(RuntimeError::OutcomeUnknown);
            }
            p.checkpoint = Some(current.status.checkpoint);
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
            let finished = trusted_time(clock)?;
            let tuple = |t: Timestamp| (t.seconds, t.nanoseconds);
            if tuple(finished) < tuple(current.status.checked_time)
                || tuple(finished) >= tuple(*expiry)
                || tuple(finished) >= tuple(p.relay.expiry)
            {
                return Err(RuntimeError::Trust);
            }
            Ok(AdmittedSnapshot::Current(current))
        }
        Err(error) => {
            if error == AdmissionError::Fork {
                if let Some(status) = p.directory.status()? {
                    if save(&p.config, status.checkpoint, p.checkpoint).is_err() {
                        p.unavailable = true;
                        return Err(RuntimeError::OutcomeUnknown);
                    }
                    p.checkpoint = Some(status.checkpoint);
                }
            }
            if error == AdmissionError::Unavailable {
                p.unavailable = true;
            }
            Err(error.into())
        }
    }
}
impl DirectoryRuntime {
    /// Start exactly one native owner per registry. Startup/reopen runs on that owner.
    pub fn start(
        registry: Arc<Registry>,
        db_root: PathBuf,
        config: DirectoryConf,
    ) -> Result<(Self, oneshot::Receiver<Result<()>>)> {
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
            control: AtomicBool::new(false),
            published: RwLock::new(Published::default()),
            stopped,
        });
        let worker_shared = shared.clone();
        let join = thread::Builder::new()
            .name("directory-owner".into())
            .spawn(move || {
                let _claim = claim;
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut principals = match stage(&registry, &db_root, &config) {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = ready_send.send(Err(e));
                            return;
                        }
                    };
                    if worker_shared.closed.load(Ordering::Acquire) {
                        let _ = ready_send.send(Err(RuntimeError::NotStarted));
                        return;
                    }
                    let mut clock = config.clock_file.clone();
                    {
                        let mut published = worker_shared.published.write().unwrap();
                        published.generation = 1;
                        published.keys = principals.keys().cloned().collect();
                    }
                    worker_shared.ready.store(true, Ordering::Release);
                    let _ = ready_send.send(Ok(()));
                    while let Some(job) = receiver.blocking_recv() {
                        if worker_shared.closed.load(Ordering::Acquire) {
                            receiver.close();
                        }
                        let stale =
                            job.generation != worker_shared.published.read().unwrap().generation;
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
                            if matches!(job.work, Work::Reload(_)) {
                                worker_shared.control.store(false, Ordering::Release);
                            }
                            let _ = job.reply.send(Err(RuntimeError::NotStarted));
                            continue;
                        }
                        let is_control = matches!(job.work, Work::Reload(_));
                        let result = if stale {
                            Err(RuntimeError::Trust)
                        } else {
                            match job.work {
                                Work::Request(op) => trusted_time(&clock).and_then(|now| {
                                    principals
                                        .get_mut(&job.key)
                                        .ok_or(RuntimeError::NotFound)
                                        .and_then(|p| execute(p, op, now, &clock))
                                }),
                                Work::Snapshot(operation, reply) => {
                                    let operation = match operation {
                                        SnapshotOperation::Current => Operation::Current,
                                        SnapshotOperation::Historical(hash) => {
                                            Operation::Historical(hash)
                                        }
                                    };
                                    let snapshot = trusted_time(&clock).and_then(|now| {
                                        principals
                                            .get_mut(&job.key)
                                            .ok_or(RuntimeError::NotFound)
                                            .and_then(|p| {
                                                execute_snapshot(p, operation, now, &clock)
                                            })
                                    });
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
                                Work::Reload(config) => {
                                    let result = (if config.principals.iter().any(|c| {
                                        c.mode == "new"
                                            && principals.contains_key(&(
                                                c.network.clone(),
                                                c.subject.clone(),
                                            ))
                                    }) {
                                        Err(RuntimeError::Trust)
                                    } else {
                                        stage(&registry, &db_root, &config)
                                    })
                                    .map(|staged| {
                                        principals = staged;
                                        clock = config.clock_file;
                                        let mut published =
                                            worker_shared.published.write().unwrap();
                                        published.generation += 1;
                                        published.keys = principals.keys().cloned().collect();
                                        Evidence {
                                            attestation: vec![],
                                            historical: false,
                                        }
                                    });
                                    worker_shared.control.store(false, Ordering::Release);
                                    result
                                }
                            }
                        };
                        if is_control {
                            worker_shared.control.store(false, Ordering::Release);
                        }
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
                    sender: Mutex::new(Some(sender)),
                    join: Mutex::new(Some(join)),
                }),
            },
            ready,
        ))
    }
    /// Reserve pending capacity after cheap route/media/allowlist checks, before body collection.
    pub fn reserve(&self, network: &str, subject: &str) -> Result<Reservation> {
        if !valid_key(network, subject) {
            return Err(RuntimeError::Invalid);
        }
        if self.owner.shared.closed.load(Ordering::Acquire)
            || !self.owner.shared.ready.load(Ordering::Acquire)
        {
            return Err(RuntimeError::NotStarted);
        }
        let published = self.owner.shared.published.read().unwrap();
        let key = (network.into(), subject.into());
        if !published.keys.contains(&key) {
            return Err(RuntimeError::NotFound);
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
            key,
            generation: published.generation,
            deadline: Instant::now() + RESPONSE_BUDGET,
        })
    }
    /// Submit through previously reserved finite capacity; never creates a waiting producer.
    pub fn submit(&self, reservation: Reservation, op: Operation) -> Submission {
        self.send(reservation, Work::Request(op))
    }
    /// Obtain a real domain snapshot using the same finite owner and reservation generation.
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
            generation: reservation.generation,
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
    /// One staged reload at a time, sharing the native owner and pending capacity.
    pub fn reload(&self, config: DirectoryConf) -> Result<Submission> {
        if self
            .owner
            .shared
            .control
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(RuntimeError::Busy);
        }
        let result = (|| {
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
            let generation = self.owner.shared.published.read().unwrap().generation;
            Ok(self.send(
                Reservation {
                    permit,
                    key: (String::new(), String::new()),
                    generation,
                    deadline: Instant::now() + RESPONSE_BUDGET,
                },
                Work::Reload(config),
            ))
        })();
        if result.is_err() {
            self.owner.shared.control.store(false, Ordering::Release);
        }
        result
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::directory::tests::{record, setup};
    #[tokio::test]
    async fn finite_queue_cancel_races_started_owner_clock_and_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let (registry, config) = setup(root.path());
        let (runtime, ready) =
            DirectoryRuntime::start(registry.clone(), root.path().join("db"), config.clone())
                .unwrap();
        ready.await.unwrap().unwrap();
        assert!(matches!(
            DirectoryRuntime::start(registry, root.path().join("db"), config.clone()),
            Err(RuntimeError::Busy)
        ));
        let c = &config.principals[0];
        let bytes = hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap();
        runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Put(bytes),
            )
            .wait()
            .await
            .unwrap();
        let (entered, started) = oneshot::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let mut running = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
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
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Current,
            ));
        }
        assert!(matches!(
            runtime.reserve(&c.network, &c.subject),
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
            runtime.reserve(&c.network, &c.subject),
            Err(RuntimeError::Busy)
        )); // bounded tombstone
        std::fs::write(&config.clock_file, "1700000200000000000\n").unwrap();
        release.send(()).unwrap();
        for queued in pending {
            let recovered = queued.wait().await.unwrap();
            assert_eq!(
                hex::encode(recovered.attestation),
                record("renew")["type2_hex"].as_str().unwrap()
            );
        }
        let continuity: Continuity =
            serde_json::from_slice(&bounded_file(&c.continuity_file, 8192).unwrap()).unwrap();
        assert_eq!(continuity.checkpoint.checked_time, (1700000200, 0));
        // Cancellation wins before dequeue: no facade call and no later new operation starts.
        let (entered, started) = oneshot::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let running = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
            Operation::Barrier {
                entered,
                release: barrier,
                next: Box::new(Operation::Current),
            },
        );
        started.await.unwrap();
        let mut cancelled = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
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
}

#[cfg(test)]
mod reload_tests {
    use super::*;
    use crate::http::directory::tests::{record, setup};
    #[tokio::test]
    async fn failed_reload_with_independent_future_clock_preserves_durable_old_generation() {
        let root = tempfile::tempdir().unwrap();
        let (registry, config) = setup(root.path());
        let c = config.principals[0].clone();
        let (runtime, ready) =
            DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
        ready.await.unwrap().unwrap();
        let original = hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap();
        runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Put(original.clone()),
            )
            .wait()
            .await
            .unwrap();
        let before = fs::read(&c.continuity_file).unwrap();
        let mut next = config.clone();
        next.clock_file = root.path().join("independent-future-clock");
        fs::write(&next.clock_file, "1700000120000000000\n").unwrap();
        next.principals[0].mode = "reopen".into();
        let mut later_invalid = next.principals[0].clone();
        later_invalid.continuity_file = root.path().join("other-continuity");
        later_invalid.mode = "invalid".into();
        next.principals.push(later_invalid);
        assert!(matches!(
            runtime.reload(next).unwrap().wait().await,
            Err(RuntimeError::Trust)
        ));
        assert_eq!(fs::read(&c.continuity_file).unwrap(), before);
        // The rejected bundle cannot persist its independent future clock into the old owner.
        let current = runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Current,
            )
            .wait()
            .await;
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
        assert_eq!(current.unwrap().attestation, original);
        let floor: Continuity =
            serde_json::from_slice(&fs::read(&c.continuity_file).unwrap()).unwrap();
        assert_eq!(floor.checkpoint.checked_time, (1700000100, 0));
    }
    #[tokio::test]
    async fn reload_rejects_old_queued_generation_and_preserves_previous_generation_on_failure() {
        let root = tempfile::tempdir().unwrap();
        let (registry, mut config) = setup(root.path());
        let (runtime, ready) =
            DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
        ready.await.unwrap().unwrap();
        let c = config.principals[0].clone();
        runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Put(
                    hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap(),
                ),
            )
            .wait()
            .await
            .unwrap();
        config.principals[0].mode = "reopen".into();
        let (entered, started) = oneshot::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let running = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
            Operation::Barrier {
                entered,
                release: barrier,
                next: Box::new(Operation::Current),
            },
        );
        started.await.unwrap();
        let reload = runtime.reload(config.clone()).unwrap();
        assert!(matches!(
            runtime.reload(config.clone()),
            Err(RuntimeError::Busy)
        ));
        let stale = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
            Operation::Current,
        );
        release.send(()).unwrap();
        running.wait().await.unwrap();
        reload.wait().await.unwrap();
        assert!(matches!(stale.wait().await, Err(RuntimeError::Trust)));
        let previous_floor = fs::read(&c.continuity_file).unwrap();
        fs::write(&config.clock_file, "1700000120000000000\n").unwrap();
        let mut failed_bundle = config.clone();
        let mut invalid = failed_bundle.principals[0].clone();
        invalid.continuity_file = root.path().join("other-continuity");
        invalid.mode = "invalid".into();
        failed_bundle.principals.push(invalid);
        assert!(matches!(
            runtime.reload(failed_bundle).unwrap().wait().await,
            Err(RuntimeError::Trust)
        ));
        assert_eq!(fs::read(&c.continuity_file).unwrap(), previous_floor);
        // The unchanged published generation still advances its external floor normally.
        runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Current,
            )
            .wait()
            .await
            .unwrap();
        let mut reset = config.clone();
        reset.principals[0].mode = "new".into();
        assert!(matches!(
            runtime.reload(reset).unwrap().wait().await,
            Err(RuntimeError::Trust)
        ));
        config.principals[0].revision_zero = "00".repeat(32);
        assert!(matches!(
            runtime.reload(config).unwrap().wait().await,
            Err(RuntimeError::Trust)
        ));
        runtime
            .submit(
                runtime.reserve(&c.network, &c.subject).unwrap(),
                Operation::Current,
            )
            .wait()
            .await
            .unwrap();
        // A vanished external floor must not be recreated from native state, even on a read.
        std::fs::remove_file(&c.continuity_file).unwrap();
        assert!(matches!(
            runtime
                .submit(
                    runtime.reserve(&c.network, &c.subject).unwrap(),
                    Operation::Current
                )
                .wait()
                .await,
            Err(RuntimeError::Trust)
        ));
        assert!(!c.continuity_file.exists());
        assert!(matches!(
            runtime
                .submit(
                    runtime.reserve(&c.network, &c.subject).unwrap(),
                    Operation::Current
                )
                .wait()
                .await,
            Err(RuntimeError::Trust)
        ));
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;
    use crate::http::directory::tests::{record, setup};
    use frank_cbor::{
        cbor_map, decode_canonical, encode_frame, CborValue, EnvelopeFields, FramePayload,
    };
    use secp256k1_abc::{Message, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    fn field(value: &CborValue, key: u64) -> &CborValue {
        let CborValue::Map(values) = value else {
            panic!("map")
        };
        &values.iter().find(|(k, _)| *k == key).unwrap().1
    }
    struct AtCap {
        _root: tempfile::TempDir,
        runtime: DirectoryRuntime,
        principal: DirectoryPrincipalConf,
        frames: Vec<(Vec<u8>, Vec<u8>)>,
        head: [u8; 32],
    }
    async fn at_cap() -> AtCap {
        let root = tempfile::tempdir().unwrap();
        let (registry, mut config) = setup(root.path());
        let original = hex::decode(record("bootstrap")["type4_hex"].as_str().unwrap()).unwrap();
        let envelope = decode_canonical(&original[9..]).unwrap();
        let CborValue::Bytes(body) = field(&envelope, 3) else {
            panic!("body")
        };
        let mut payload = decode_canonical(body).unwrap();
        let subject = field(&payload, 1).clone();
        let secp = Secp256k1::new();
        let mut scalar = [0; 32];
        scalar[31] = 1;
        let secret = SecretKey::from_slice(&scalar).unwrap();
        let mut frames = Vec::new();
        let mut previous = None;
        for revision in 0..MAX_STATEMENTS {
            let CborValue::Map(fields) = &mut payload else {
                panic!("map")
            };
            for (key, value) in fields {
                if *key == 2 {
                    *value = CborValue::Int(revision as i128);
                }
                if *key == 13 {
                    *value = previous
                        .clone()
                        .map(CborValue::Bytes)
                        .unwrap_or(CborValue::Null);
                }
            }
            let statement = encode_frame(
                EnvelopeFields {
                    type_id: 4,
                    schema_version: 4,
                    min_reader_version: 4,
                },
                FramePayload::Value(&payload),
            )
            .unwrap();
            let hash: [u8; 32] = Sha256::digest(
                frank_cbor::common_transcript(
                    "frank/content-hash/v1",
                    "monad-testnet",
                    &statement,
                    &[],
                )
                .unwrap(),
            )
            .into();
            if revision == 0 {
                config.principals[0].revision_zero = hex::encode(hash);
            }
            previous = Some(hash.to_vec());
            let signature = secp
                .sign(
                    &Message::from_slice(
                        &frank_cbor::directory_signature_digest("monad-testnet", &statement)
                            .unwrap(),
                    )
                    .unwrap(),
                    &secret,
                )
                .serialize_der()
                .to_vec();
            let wrapper = cbor_map(vec![
                (0, CborValue::Bytes(statement.clone())),
                (
                    1,
                    CborValue::Array(vec![cbor_map(vec![
                        (0, CborValue::Int(1)),
                        (1, subject.clone()),
                        (2, CborValue::Bytes(signature)),
                    ])]),
                ),
            ]);
            let attestation = encode_frame(
                EnvelopeFields {
                    type_id: 2,
                    schema_version: 1,
                    min_reader_version: 1,
                },
                FramePayload::Value(&wrapper),
            )
            .unwrap();
            frames.push((statement, attestation));
        }
        let c = &config.principals[0];
        let anchor = Anchor {
            network: c.network.clone(),
            subject: AccountRef {
                key_type: 1,
                key_bytes: hex::decode(&c.subject).unwrap(),
            },
            revision_zero: hex::decode(&c.revision_zero).unwrap().try_into().unwrap(),
        };
        let now = trusted_time(&config.clock_file).unwrap();
        let relay = RelayBinding {
            relay_id: hex::decode(&c.relay_id).unwrap(),
            endpoint: c.endpoint.clone(),
            identity: AccountRef {
                key_type: 1,
                key_bytes: hex::decode(&c.relay_identity).unwrap(),
            },
            expiry: nanos(&c.binding_expiry_ns).unwrap(),
            unknown: vec![],
        };
        let candidates: Vec<_> = frames
            .iter()
            .map(|(statement, attestation)| Candidate {
                statement,
                attestation,
            })
            .collect();
        let expected = Checkpoint::for_enrollment(&anchor, candidates[0], now).unwrap();
        save(c, expected, None).unwrap();
        let directory = registry
            .directory_preview(anchor, OpenMode::NewEnrollment)
            .unwrap();
        let current = directory
            .advance(
                &candidates,
                Context {
                    now: Some(now),
                    relay: Some(&relay),
                },
            )
            .unwrap();
        assert_eq!(current.status.accepted, MAX_STATEMENTS);
        save(c, current.status.checkpoint, Some(expected)).unwrap();
        drop(directory);
        config.principals[0].mode = "reopen".into();
        let c = config.principals[0].clone();
        let (runtime, ready) =
            DirectoryRuntime::start(registry, root.path().join("db"), config).unwrap();
        ready.await.unwrap().unwrap();
        AtCap {
            _root: root,
            runtime,
            principal: c,
            frames,
            head: previous.unwrap().try_into().unwrap(),
        }
    }
    #[tokio::test]
    #[ignore = "4096-record terminal algorithm proof; requires the exclusive heavy lease"]
    async fn exact_duplicate_at_cap_returns_actual_head_without_readvancing() {
        let AtCap {
            _root,
            runtime,
            principal: c,
            frames,
            head,
        } = at_cap().await;
        let mut submission = runtime.submit(
            runtime.reserve(&c.network, &c.subject).unwrap(),
            Operation::Put(frames[0].1.clone()),
        );
        // This is an algorithm/cap conformance proof, not a response-latency SLO.
        // Observe the exact native terminal result even when a debug full-chain scan
        // exceeds the production waiter's 60s budget. Scheduler tests separately pin
        // the actual outcome-unknown response and continued owner/checkpoint lifetime.
        let evidence = (&mut submission.receiver).await.unwrap().unwrap();
        assert_eq!(evidence.attestation, frames.last().unwrap().1);
        let floor: Continuity =
            serde_json::from_slice(&bounded_file(&c.continuity_file, 8192).unwrap()).unwrap();
        assert_eq!(floor.checkpoint.accepted, MAX_STATEMENTS);
        assert_eq!(floor.checkpoint.head, Some(head));
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
    #[tokio::test]
    #[ignore = "mandatory real HTTP4096 cap proof with the production60s waiter; run release under exclusive lease"]
    async fn actual_http_exact_duplicate_at_cap_completes_with_production_waiter() {
        let AtCap {
            _root,
            runtime,
            principal: c,
            frames,
            head,
        } = at_cap().await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel::<()>();
        let server = axum::Server::from_tcp(listener)
            .unwrap()
            .http1_header_read_timeout(Duration::from_secs(70))
            .serve(crate::http::directory::router(Arc::new(runtime.clone())).into_make_service())
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            });
        let server = tokio::spawn(server);
        let result = async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(70))
                .build()
                .unwrap();
            let base = format!("http://{address}/directory/v1/{}/{}", c.network, c.subject);
            let mut results = Vec::new();
            for (method, path, body) in [
                (
                    reqwest::Method::PUT,
                    "/head".to_owned(),
                    Some(frames[0].1.clone()),
                ),
                (
                    reqwest::Method::GET,
                    format!("/statements/{}", c.revision_zero),
                    None,
                ),
                (reqwest::Method::GET, "/head".to_owned(), None),
            ] {
                let mut request = client
                    .request(method, format!("{base}{path}"))
                    .header("content-type", "application/vnd.frank.cbor");
                if let Some(body) = body {
                    request = request.body(body);
                }
                let response = request.send().await?;
                let status = response.status();
                let headers = response.headers().clone();
                let body = response.bytes().await?;
                results.push((status, headers, body));
            }
            Ok::<_, reqwest::Error>(results)
        }
        .await;
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
        let results = result.unwrap();
        for ((status, headers, bytes), (kind, exact)) in results.iter().zip([
            ("fresh-current", &frames.last().unwrap().1),
            ("historical", &frames[0].1),
            ("fresh-current", &frames.last().unwrap().1),
        ]) {
            assert_eq!(*status, reqwest::StatusCode::OK);
            assert_eq!(headers["content-type"], "application/vnd.frank.cbor");
            assert_eq!(headers["x-frank-directory-evidence"], kind);
            assert_eq!(bytes.as_ref(), exact);
        }
        let floor: Continuity =
            serde_json::from_slice(&bounded_file(&c.continuity_file, 8192).unwrap()).unwrap();
        assert_eq!(floor.checkpoint.accepted, MAX_STATEMENTS);
        assert_eq!(floor.checkpoint.retained, MAX_STATEMENTS);
        assert_eq!(floor.checkpoint.head, Some(head));
        assert!(!floor.checkpoint.forked);
    }
}
