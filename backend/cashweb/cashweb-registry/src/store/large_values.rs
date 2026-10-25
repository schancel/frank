//! Large-value store: values over [`INLINE_LIMIT`] live in an object store (S3 in a cluster),
//! and the owner's row keeps only a [`LargeValueRef`].
//!
//! FoundationDB caps a value at 100 KB, so an owner inlines a value up to 64 KiB and stores a
//! larger one here. Every upload gets its own immutable object,
//! `<namespace>/sha256/<hex>/<upload>`, where `upload` is the upload intent's random id. The
//! address is content-verified (a read checks the SHA-256 and length) and upload-unique: two
//! uploads never share a key, even for equal content, so deleting one upload's object can never
//! remove another's. Equal content is not deduplicated.
//!
//! The owner never talks to the object store's client: composition passes an [`ObjectStore`]
//! capability, and [`LargeValues`] keeps its index in the owner's own [`RelayKvStore`], so a
//! reference commits in the same transaction as the row that holds it.
//!
//! Index keys, under the owner's `prefix`:
//! - `int:` || upload: an upload intent, value = digest (32) || expiry (ms, big-endian, 8) ||
//!   state (1: `0` live, `1` doomed: the sweeper decided to delete it).
//! - `ref:` || upload: the one committed reference to that upload, value = digest || length.
//! - `lease`: holder (16 bytes) || expiry (ms). It only keeps two replicas from doing the same
//!   sweep work; safety never depends on it.
//! - `claim`: this index's id, also written to the object `<namespace>/claim` with a
//!   conditional PUT. An index refuses a namespace whose claim names another index, so two
//!   indexes never sweep each other's objects.
//!
//! Order of a write ([`LargeValues::stage`], then [`LargeValues::commit_reference`]):
//! 1. Commit a live intent with a fresh upload id.
//! 2. Upload the object at its upload-unique key. A failure leaves no reference.
//! 3. In the owner's transaction, consume the intent and write the reference with the row. If
//!    the intent is gone or doomed (the sweeper judged the writer dead), the commit fails
//!    closed with [`LargeValueError::IntentLost`] and the writer retries with a new upload.
//!
//! The sweeper ([`LargeValues::sweep`]) acts only on expired intents. For each, one transaction
//! re-reads the intent and its reference: with a reference it drops the intent and keeps the
//! object; otherwise it marks the intent doomed. Then it deletes that one key and, if the
//! intent is still the doomed one, removes it. Deciding and committing serialize on the intent
//! key, so a committed reference's object is never deleted, whatever the clocks say and however
//! many replicas sweep at once. A clock skew or a writer pause longer than the intent TTL only
//! makes that writer's commit fail (retryable). A writer whose upload lands after its object
//! was deleted re-creates an expired intent when it abandons, so the object is still
//! collected; a writer that crashes at exactly that point leaks one object, which only a sweep
//! that lists the bucket would find.

use std::{
    fmt::Debug,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::store::kv_store::{KvError, KvTransaction, RelayKvStore, Transact};

/// Largest value an owner stores inline in its row; larger values go to the object store.
pub const INLINE_LIMIT: usize = 64 * 1024;

/// How long an upload intent protects an object that is not yet referenced.
pub const DEFAULT_INTENT_TTL: Duration = Duration::from_secs(10 * 60);

/// How long a sweeper's lease lasts without renewal.
pub const SWEEP_LEASE_TTL: Duration = Duration::from_secs(60);

/// Upper bound on one object store request, connect included.
pub const MAX_OBJECT_REQUEST: Duration = Duration::from_secs(20);

/// Expired intents considered by one sweep.
const SWEEP_BATCH: usize = 1_024;

const LIVE: u8 = 0;
const DOOMED: u8 = 1;

/// Failure of an [`ObjectStore`] call. The message never contains credentials.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("object store: {0}")]
pub struct ObjectStoreError(pub String);

/// Immutable object storage passed by composition: S3 in a cluster, a local directory on a
/// single node. Calls block; owners already run on blocking workers.
pub trait ObjectStore: Send + Sync + Debug {
    /// Store `bytes` at `key`. `sha256` is the content's digest, for transport integrity.
    fn put(&self, key: &str, bytes: &[u8], sha256: &[u8; 32]) -> Result<(), ObjectStoreError>;
    /// Store `bytes` at `key` only if no object exists there (S3 `If-None-Match: *`). Returns
    /// false, writing nothing, when one does.
    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        sha256: &[u8; 32],
    ) -> Result<bool, ObjectStoreError>;
    /// The object at `key`, or `None` when absent.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, ObjectStoreError>;
    /// Remove `key`. Removing an absent object succeeds.
    fn delete(&self, key: &str) -> Result<(), ObjectStoreError>;
    /// Whether an object exists at `key`.
    fn contains(&self, key: &str) -> Result<bool, ObjectStoreError>;
}

/// Errors from [`LargeValues`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LargeValueError {
    /// The object store failed; nothing was referenced.
    #[error("large value store unavailable: {0}")]
    Unavailable(#[from] ObjectStoreError),
    /// The upload intent was swept before the owner committed; retry the write.
    #[error("large value intent expired before commit; retry")]
    IntentLost,
    /// The object namespace is claimed by another index.
    #[error(
        "object namespace {0} is claimed by another large-value index; if this relay's store \
         was reset for development, delete the object <bucket prefix>/{0}/claim"
    )]
    NamespaceClaimed(String),
    /// A referenced object is missing or does not match its digest.
    #[error("corrupt large value: {0}")]
    Corrupt(String),
    /// Transaction contract failure.
    #[error(transparent)]
    Kv(#[from] KvError),
}

/// A committed reference: the upload holding the value, and the value's SHA-256 and length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LargeValueRef {
    /// SHA-256 of the value.
    pub digest: [u8; 32],
    /// Byte length of the value.
    pub len: u64,
    /// The upload's id; part of the object key.
    pub upload: [u8; 16],
}

impl LargeValueRef {
    /// Whether `bytes` is the referenced value.
    pub fn matches(&self, bytes: &[u8]) -> bool {
        bytes.len() as u64 == self.len && Sha256::digest(bytes).as_slice() == self.digest
    }
}

/// An uploaded value whose intent still protects it, until the owner commits a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    /// The reference to store in the owner's row.
    pub reference: LargeValueRef,
}

/// A value an owner keeps in its row: inline bytes (tag 0), or a reference to an object (tag 1,
/// then the digest, length and upload id). Owners store a value over [`INLINE_LIMIT`] as a
/// reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Stored {
    Inline(Vec<u8>),
    Large(LargeValueRef),
}

impl Stored {
    const INLINE: u8 = 0;
    const LARGE: u8 = 1;

    pub(crate) fn encode(&self) -> Vec<u8> {
        match self {
            Self::Inline(bytes) => [&[Self::INLINE][..], bytes].concat(),
            Self::Large(reference) => [
                &[Self::LARGE][..],
                &reference.digest,
                &reference.len.to_be_bytes(),
                &reference.upload,
            ]
            .concat(),
        }
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        match bytes.split_first()? {
            (&Self::INLINE, rest) => Some(Self::Inline(rest.to_vec())),
            (&Self::LARGE, rest) if rest.len() == 56 => Some(Self::Large(LargeValueRef {
                digest: rest[..32].try_into().ok()?,
                len: u64::from_be_bytes(rest[32..40].try_into().ok()?),
                upload: rest[40..].try_into().ok()?,
            })),
            _ => None,
        }
    }

    /// Length of the value itself, before any object is read.
    pub(crate) fn len(&self) -> u64 {
        match self {
            Self::Inline(bytes) => bytes.len() as u64,
            Self::Large(reference) => reference.len,
        }
    }
}

/// What one sweep did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// False when another sweeper holds the lease; nothing was done.
    pub held_lease: bool,
    /// Objects deleted.
    pub deleted: usize,
    /// Expired intents dropped because their upload is referenced.
    pub kept_referenced: usize,
}

/// The large-value index of one owner, over that owner's [`RelayKvStore`].
#[derive(Debug, Clone)]
pub struct LargeValues {
    kv: Arc<dyn RelayKvStore>,
    objects: Arc<dyn ObjectStore>,
    prefix: Vec<u8>,
    namespace: String,
    intent_ttl: Duration,
    lease_ttl: Duration,
    claimed: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_u64(bytes: &[u8], what: &str) -> Result<u64, LargeValueError> {
    let bytes: [u8; 8] = bytes
        .get(..8)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| LargeValueError::Corrupt(format!("{what} is not 8 bytes")))?;
    Ok(u64::from_be_bytes(bytes))
}

/// A decoded intent value.
struct Intent {
    digest: [u8; 32],
    expiry: u64,
    state: u8,
}

impl Intent {
    fn encode(digest: &[u8; 32], expiry: u64, state: u8) -> Vec<u8> {
        [digest.as_slice(), &expiry.to_be_bytes(), &[state]].concat()
    }

    fn decode(value: &[u8]) -> Result<Self, LargeValueError> {
        if value.len() != 41 || value[40] > DOOMED {
            return Err(LargeValueError::Corrupt("bad upload intent".into()));
        }
        Ok(Self {
            digest: value[..32].try_into().expect("32 bytes"),
            expiry: read_u64(&value[32..40], "intent expiry")?,
            state: value[40],
        })
    }
}

impl LargeValues {
    /// An index under `prefix` in `kv`, with objects named `<namespace>/sha256/<hex>/<upload>`.
    ///
    /// Each index owns its object namespace: a sweeper consults only its own index. The first
    /// write or sweep claims the namespace and refuses one another index has claimed.
    pub fn new(
        kv: Arc<dyn RelayKvStore>,
        objects: Arc<dyn ObjectStore>,
        prefix: &[u8],
        namespace: &str,
    ) -> Self {
        Self {
            kv,
            objects,
            prefix: prefix.to_vec(),
            namespace: namespace.trim_matches('/').to_string(),
            intent_ttl: DEFAULT_INTENT_TTL,
            lease_ttl: SWEEP_LEASE_TTL,
            claimed: Arc::default(),
        }
    }

    /// Replace the intent lifetime (tests use zero to make every intent expired at once).
    pub fn with_intent_ttl(mut self, ttl: Duration) -> Self {
        self.intent_ttl = ttl;
        self
    }

    /// Replace the lease length (tests use zero to let every sweeper work).
    pub fn with_lease_ttl(mut self, ttl: Duration) -> Self {
        self.lease_ttl = ttl;
        self
    }

    /// The index's key prefix inside the owner's store.
    pub fn prefix(&self) -> &[u8] {
        &self.prefix
    }

    /// The object key for `reference`: `<namespace>/sha256/<hex>/<upload>`.
    pub fn object_key(&self, reference: &LargeValueRef) -> String {
        self.upload_key(&reference.digest, &reference.upload)
    }

    fn upload_key(&self, digest: &[u8; 32], upload: &[u8; 16]) -> String {
        format!(
            "{}/sha256/{}/{}",
            self.namespace,
            hex::encode(digest),
            hex::encode(upload)
        )
    }

    /// The object store, for inspection.
    pub fn objects(&self) -> &Arc<dyn ObjectStore> {
        &self.objects
    }

    fn key(&self, kind: &[u8], upload: &[u8]) -> Vec<u8> {
        [self.prefix.as_slice(), kind, upload].concat()
    }

    fn intent_key(&self, upload: &[u8; 16]) -> Vec<u8> {
        self.key(b"int:", upload)
    }

    fn ref_key(&self, upload: &[u8; 16]) -> Vec<u8> {
        self.key(b"ref:", upload)
    }

    fn lease_key(&self) -> Vec<u8> {
        self.key(b"lease", &[])
    }

    /// Committed references, up to `limit` (inspection and tests).
    pub fn references(&self, limit: usize) -> Result<Vec<LargeValueRef>, LargeValueError> {
        let prefix = self.key(b"ref:", &[]);
        let rows = self
            .kv
            .transact(|tx| tx.scan_prefix(&prefix, None, limit))?;
        rows.into_iter()
            .map(|(key, value)| {
                let upload: [u8; 16] = key[prefix.len()..]
                    .try_into()
                    .map_err(|_| LargeValueError::Corrupt("bad reference key".into()))?;
                if value.len() != 40 {
                    return Err(LargeValueError::Corrupt("bad reference".into()));
                }
                Ok(LargeValueRef {
                    digest: value[..32].try_into().expect("32 bytes"),
                    len: read_u64(&value[32..], "reference length")?,
                    upload,
                })
            })
            .collect()
    }

    /// Claim the object namespace for this index, or refuse one another index claimed. The
    /// claim object is written with a conditional PUT, so of two indexes racing on an empty
    /// namespace exactly one wins. The result is cached once it succeeds.
    pub fn claim_namespace(&self) -> Result<(), LargeValueError> {
        if self.claimed.load(Ordering::SeqCst) {
            return Ok(());
        }
        let claim_key = self.key(b"claim", &[]);
        let id = self.kv.transact(|tx| {
            if let Some(id) = tx.get(&claim_key)? {
                return Ok::<_, LargeValueError>(id);
            }
            let id: [u8; 16] = rand::random();
            tx.set(&claim_key, &id)?;
            Ok(id.to_vec())
        })?;
        let object = format!("{}/claim", self.namespace);
        let digest: [u8; 32] = Sha256::digest(&id).into();
        if !self.objects.put_if_absent(&object, &id, &digest)?
            && self.objects.get(&object)?.as_deref() != Some(id.as_slice())
        {
            return Err(LargeValueError::NamespaceClaimed(self.namespace.clone()));
        }
        self.claimed.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Commit an intent, then upload `bytes`. The object exists when this returns `Ok`.
    pub fn stage(&self, bytes: &[u8]) -> Result<Staged, LargeValueError> {
        self.claim_namespace()?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        let reference = LargeValueRef {
            digest,
            len: bytes.len() as u64,
            upload: rand::random(),
        };
        let intent_key = self.intent_key(&reference.upload);
        let expiry = now_ms().saturating_add(self.intent_ttl.as_millis() as u64);
        let intent = Intent::encode(&digest, expiry, LIVE);
        self.kv.transact(|tx| tx.set(&intent_key, &intent))?;
        let staged = Staged { reference };
        if let Err(error) = self
            .objects
            .put(&self.object_key(&reference), bytes, &digest)
        {
            self.abandon(&staged);
            return Err(error.into());
        }
        Ok(staged)
    }

    /// Inside the owner's transaction (on the same store): consume the intent and record the
    /// reference. `owner_key` is the row that holds it.
    pub fn commit_reference(
        &self,
        tx: &mut dyn KvTransaction,
        staged: &Staged,
        _owner_key: &[u8],
    ) -> Result<(), LargeValueError> {
        let reference = &staged.reference;
        let intent_key = self.intent_key(&reference.upload);
        match tx.get(&intent_key)? {
            Some(value) if Intent::decode(&value)?.state == LIVE => {}
            _ => return Err(LargeValueError::IntentLost),
        }
        tx.clear(&intent_key)?;
        tx.set(
            &self.ref_key(&reference.upload),
            &[reference.digest.as_slice(), &reference.len.to_be_bytes()].concat(),
        )?;
        Ok(())
    }

    /// Inside the owner's transaction: drop the reference of a row that is replaced or
    /// removed, and leave an expired intent so the sweep deletes its object.
    pub fn clear_reference(
        &self,
        tx: &mut dyn KvTransaction,
        reference: &LargeValueRef,
        _owner_key: &[u8],
    ) -> Result<(), LargeValueError> {
        let key = self.ref_key(&reference.upload);
        if tx.get(&key)?.is_some() {
            tx.clear(&key)?;
            tx.set(
                &self.intent_key(&reference.upload),
                &Intent::encode(&reference.digest, 0, LIVE),
            )?;
        }
        Ok(())
    }

    /// The owner will not commit `staged` (or its commit failed): leave an expired intent so a
    /// sweep collects the object unless something references it. This re-creates an intent the
    /// sweeper already removed, so an upload that landed after its deletion is still collected.
    /// Best effort; an intent that cannot be expired still expires on its own.
    pub fn abandon(&self, staged: &Staged) {
        let reference = &staged.reference;
        let (key, value) = (
            self.intent_key(&reference.upload),
            Intent::encode(&reference.digest, 0, LIVE),
        );
        if let Err(error) = self.kv.transact(|tx| tx.set(&key, &value)) {
            tracing::warn!("could not expire a large-value intent: {error}");
        }
    }

    /// Read a referenced value and check it against its digest and length.
    pub fn read(&self, reference: &LargeValueRef) -> Result<Vec<u8>, LargeValueError> {
        let key = self.object_key(reference);
        let bytes = self.objects.get(&key)?.ok_or_else(|| {
            LargeValueError::Corrupt(format!("referenced object {key} is missing"))
        })?;
        if !reference.matches(&bytes) {
            return Err(LargeValueError::Corrupt(format!(
                "object {key} does not match its reference"
            )));
        }
        Ok(bytes)
    }

    /// Delete unreferenced uploads whose intents expired. `holder` takes the lease, which only
    /// keeps replicas from repeating each other's work.
    pub fn sweep(&self, holder: [u8; 16]) -> Result<SweepReport, LargeValueError> {
        let mut report = SweepReport::default();
        if !self.renew_lease(&holder)? {
            return Ok(report);
        }
        self.claim_namespace()?;
        report.held_lease = true;

        let now = now_ms();
        let intents = self.key(b"int:", &[]);
        let mut expired: Vec<[u8; 16]> = Vec::new();
        let mut after: Option<Vec<u8>> = None;
        while expired.len() < SWEEP_BATCH {
            let page = self
                .kv
                .transact(|tx| tx.scan_prefix(&intents, after.as_deref(), 256))?;
            let Some((last, _)) = page.last() else {
                break;
            };
            after = Some(last.clone());
            for (key, value) in &page {
                let upload: [u8; 16] = key[intents.len()..]
                    .try_into()
                    .map_err(|_| LargeValueError::Corrupt("bad intent key".into()))?;
                let intent = Intent::decode(value)?;
                if intent.state == DOOMED || intent.expiry <= now {
                    expired.push(upload);
                }
            }
        }

        for upload in expired {
            match self.decide(&upload, now)? {
                Decision::Delete(digest) => {
                    self.delete_upload(&digest, &upload)?;
                    report.deleted += 1;
                }
                Decision::Referenced => report.kept_referenced += 1,
                Decision::Skip => {}
            }
        }
        Ok(report)
    }

    /// Take or renew the lease. Returns false when another live holder has it.
    fn renew_lease(&self, holder: &[u8; 16]) -> Result<bool, LargeValueError> {
        let key = self.lease_key();
        self.kv.transact(|tx| {
            let now = now_ms();
            if let Some(current) = tx.get(&key)? {
                if current.len() != 24 {
                    return Err(LargeValueError::Corrupt("bad sweep lease".into()));
                }
                if current[..16] != holder[..] && read_u64(&current[16..], "lease expiry")? > now {
                    return Ok(false);
                }
            }
            let expiry = now.saturating_add(self.lease_ttl.as_millis() as u64);
            tx.set(&key, &[holder.as_slice(), &expiry.to_be_bytes()].concat())?;
            Ok(true)
        })
    }

    /// One transaction: doom an expired, unreferenced intent, or drop one whose upload is
    /// referenced.
    fn decide(&self, upload: &[u8; 16], now: u64) -> Result<Decision, LargeValueError> {
        let (intent_key, ref_key) = (self.intent_key(upload), self.ref_key(upload));
        self.kv.transact(|tx| {
            let Some(value) = tx.get(&intent_key)? else {
                return Ok(Decision::Skip);
            };
            let intent = Intent::decode(&value)?;
            if intent.state == LIVE && intent.expiry > now {
                return Ok(Decision::Skip);
            }
            if tx.get(&ref_key)?.is_some() {
                tx.clear(&intent_key)?;
                return Ok(Decision::Referenced);
            }
            if intent.state == LIVE {
                tx.set(&intent_key, &Intent::encode(&intent.digest, 0, DOOMED))?;
            }
            Ok::<_, LargeValueError>(Decision::Delete(intent.digest))
        })
    }

    /// Delete a doomed upload's object, then its intent if no abandon re-created it meanwhile.
    fn delete_upload(&self, digest: &[u8; 32], upload: &[u8; 16]) -> Result<(), LargeValueError> {
        self.objects.delete(&self.upload_key(digest, upload))?;
        let (key, doomed) = (self.intent_key(upload), Intent::encode(digest, 0, DOOMED));
        self.kv.transact(|tx| {
            if tx.get(&key)?.as_deref() == Some(doomed.as_slice()) {
                tx.clear(&key)?;
            }
            Ok::<_, LargeValueError>(())
        })
    }
}

enum Decision {
    Delete([u8; 32]),
    Referenced,
    Skip,
}

/// Object keys are `<namespace>/sha256/<hex>/<upload>` or `<namespace>/claim`: lowercase ASCII, digits, `-`, `_` and `/`.
pub(crate) fn check_object_key(key: &str) -> Result<(), ObjectStoreError> {
    let valid = !key.is_empty()
        && !key.starts_with('/')
        && key
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_/".contains(&b));
    if valid {
        Ok(())
    } else {
        Err(ObjectStoreError(format!("invalid object key {key:?}")))
    }
}

/// Objects as files under one directory: the single-node driver. A relay that shares its
/// transaction store with other replicas must use S3 instead.
#[derive(Debug)]
pub struct LocalFsObjectStore {
    root: PathBuf,
    _temporary: Option<tempfile::TempDir>,
}

impl LocalFsObjectStore {
    /// Objects under `root`, created on the first write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            _temporary: None,
        }
    }

    /// Objects in a temporary directory removed on drop. For tests and fixtures.
    ///
    /// # Panics
    /// If the temporary directory cannot be created.
    pub fn temporary() -> Self {
        let dir = tempfile::tempdir().expect("create temporary object directory");
        Self {
            root: dir.path().to_path_buf(),
            _temporary: Some(dir),
        }
    }

    /// The root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, key: &str) -> Result<PathBuf, ObjectStoreError> {
        check_object_key(key)?;
        Ok(self.root.join(key))
    }
}

fn io_error(what: &str, error: std::io::Error) -> ObjectStoreError {
    ObjectStoreError(format!("{what}: {error}"))
}

impl ObjectStore for LocalFsObjectStore {
    fn put(&self, key: &str, bytes: &[u8], _sha256: &[u8; 32]) -> Result<(), ObjectStoreError> {
        let path = self.path(key)?;
        let parent = path.parent().expect("object path has a parent");
        fs::create_dir_all(parent).map_err(|e| io_error("create object directory", e))?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| io_error("create object file", e))?;
        file.write_all(bytes)
            .and_then(|()| file.as_file().sync_all())
            .map_err(|e| io_error("write object", e))?;
        file.persist(&path)
            .map_err(|e| io_error("publish object", e.error))?;
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        _sha256: &[u8; 32],
    ) -> Result<bool, ObjectStoreError> {
        let path = self.path(key)?;
        let parent = path.parent().expect("object path has a parent");
        fs::create_dir_all(parent).map_err(|e| io_error("create object directory", e))?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| io_error("create object file", e))?;
        file.write_all(bytes)
            .and_then(|()| file.as_file().sync_all())
            .map_err(|e| io_error("write object", e))?;
        match file.persist_noclobber(&path) {
            Ok(_) => Ok(true),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(io_error("publish object", error.error)),
        }
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, ObjectStoreError> {
        match fs::read(self.path(key)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_error("read object", error)),
        }
    }

    fn delete(&self, key: &str) -> Result<(), ObjectStoreError> {
        match fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error("delete object", error)),
        }
    }

    fn contains(&self, key: &str) -> Result<bool, ObjectStoreError> {
        Ok(self.path(key)?.is_file())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::kv_store::RocksDbKvStore;

    fn index_with_root(ttl: Duration) -> (LargeValues, Arc<RocksDbKvStore>, PathBuf) {
        let kv = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let objects = Arc::new(LocalFsObjectStore::temporary());
        let root = objects.root().to_path_buf();
        (
            LargeValues::new(kv.clone(), objects, b"T_lv:", "test").with_intent_ttl(ttl),
            kv,
            root,
        )
    }

    fn index(ttl: Duration) -> (LargeValues, Arc<RocksDbKvStore>) {
        let (values, kv, _) = index_with_root(ttl);
        (values, kv)
    }

    fn reference(values: &LargeValues, kv: &RocksDbKvStore, staged: &Staged, owner: &[u8]) {
        kv.transact(|tx| values.commit_reference(tx, staged, owner))
            .unwrap();
    }

    /// Every upload object under `root/test/sha256`, as `<hex>/<upload>`.
    fn uploads(root: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let Ok(digests) = std::fs::read_dir(root.join("test/sha256")) else {
            return found;
        };
        for digest in digests {
            let digest = digest.unwrap();
            for upload in std::fs::read_dir(digest.path()).unwrap() {
                let name = upload.unwrap().file_name().into_string().unwrap();
                if !name.starts_with('.') {
                    found.push(format!(
                        "{}/{name}",
                        digest.file_name().into_string().unwrap()
                    ));
                }
            }
        }
        found.sort();
        found
    }

    fn key_of(reference: &LargeValueRef) -> String {
        format!(
            "{}/{}",
            hex::encode(reference.digest),
            hex::encode(reference.upload)
        )
    }

    const HOLDER: [u8; 16] = [1; 16];

    #[test]
    fn staged_value_reads_back_and_rejects_a_tampered_object() {
        let (values, kv) = index(DEFAULT_INTENT_TTL);
        let bytes = vec![9u8; INLINE_LIMIT + 1];
        let staged = values.stage(&bytes).unwrap();
        reference(&values, &kv, &staged, b"row");
        assert_eq!(values.read(&staged.reference).unwrap(), bytes);
        let key = values.object_key(&staged.reference);
        assert!(key.starts_with(&format!(
            "test/sha256/{}/",
            hex::encode(staged.reference.digest)
        )));
        values.objects().put(&key, b"tampered", &[0; 32]).unwrap();
        assert!(matches!(
            values.read(&staged.reference),
            Err(LargeValueError::Corrupt(_))
        ));
    }

    #[test]
    fn equal_content_gets_a_separate_object_per_upload() {
        let (values, kv, root) = index_with_root(Duration::ZERO);
        let first = values.stage(b"same").unwrap();
        let second = values.stage(b"same").unwrap();
        assert_ne!(
            values.object_key(&first.reference),
            values.object_key(&second.reference)
        );
        reference(&values, &kv, &second, b"row");
        // The unreferenced twin is deleted; the referenced one is untouched.
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        assert_eq!(uploads(&root), vec![key_of(&second.reference)]);
        assert_eq!(values.read(&second.reference).unwrap(), b"same");
    }

    #[test]
    fn sweep_deletes_an_orphan_and_never_a_referenced_object() {
        let (values, kv, root) = index_with_root(Duration::ZERO);
        let orphan = values.stage(b"orphan: uploaded, never committed").unwrap();
        let kept = values.stage(b"referenced").unwrap();
        reference(&values, &kv, &kept, b"row");
        // A writer whose commit landed but who saw an error and abandoned anyway.
        let uncertain = values.stage(b"committed, then abandoned").unwrap();
        reference(&values, &kv, &uncertain, b"row-2");
        values.abandon(&uncertain);

        let report = values.sweep(HOLDER).unwrap();
        assert!(report.held_lease);
        assert_eq!((report.deleted, report.kept_referenced), (1, 1));
        assert!(!values
            .objects()
            .contains(&values.object_key(&orphan.reference))
            .unwrap());
        assert_eq!(values.read(&kept.reference).unwrap(), b"referenced");
        assert_eq!(
            values.read(&uncertain.reference).unwrap(),
            b"committed, then abandoned"
        );
        // Nothing is left to do, and the referenced objects survive repeated sweeps.
        assert_eq!(
            values.sweep(HOLDER).unwrap(),
            SweepReport {
                held_lease: true,
                ..SweepReport::default()
            }
        );
        assert_eq!(uploads(&root).len(), 2);
        assert!(kv
            .transact(|tx| tx.scan_prefix(b"T_lv:int:", None, 10))
            .unwrap()
            .is_empty());
        let mut referenced = values.references(10).unwrap();
        referenced.sort_by_key(|r| r.upload);
        let mut expected = vec![kept.reference, uncertain.reference];
        expected.sort_by_key(|r| r.upload);
        assert_eq!(referenced, expected);
    }

    #[test]
    fn a_cleared_reference_is_collected() {
        let (values, kv, root) = index_with_root(DEFAULT_INTENT_TTL);
        let staged = values.stage(b"replaced row").unwrap();
        reference(&values, &kv, &staged, b"row");
        kv.transact(|tx| values.clear_reference(tx, &staged.reference, b"row"))
            .unwrap();
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        assert!(uploads(&root).is_empty());
    }

    #[test]
    fn a_commit_after_its_intent_was_swept_fails_closed() {
        let (values, kv) = index(Duration::ZERO);
        let staged = values.stage(b"slow writer").unwrap();
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        assert_eq!(
            kv.transact(|tx| values.commit_reference(tx, &staged, b"row")),
            Err(LargeValueError::IntentLost)
        );
        assert!(values.references(10).unwrap().is_empty());
    }

    #[test]
    fn a_doomed_intent_refuses_its_commit_and_an_interrupted_delete_is_finished() {
        let (values, kv, root) = index_with_root(Duration::ZERO);
        let staged = values.stage(b"doomed").unwrap();
        // A sweeper that doomed the upload and died before its DELETE.
        assert!(matches!(
            values.decide(&staged.reference.upload, now_ms()).unwrap(),
            Decision::Delete(_)
        ));
        assert_eq!(
            kv.transact(|tx| values.commit_reference(tx, &staged, b"row")),
            Err(LargeValueError::IntentLost)
        );
        // Another sweeper finishes the deletion.
        assert_eq!(values.sweep([2; 16]).unwrap().deleted, 1);
        assert!(uploads(&root).is_empty());
        // A retry of the same content is a new upload and commits.
        let retry = values.stage(b"doomed").unwrap();
        reference(&values, &kv, &retry, b"row");
        assert_eq!(values.read(&retry.reference).unwrap(), b"doomed");
    }

    #[test]
    fn an_upload_that_lands_after_its_deletion_is_still_collected() {
        let (values, _kv, root) = index_with_root(Duration::ZERO);
        let bytes = b"late upload";
        let staged = values.stage(bytes).unwrap();
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        // The writer's PUT reaches the store late, after the sweeper deleted the key ...
        let key = values.object_key(&staged.reference);
        values
            .objects()
            .put(&key, bytes, &staged.reference.digest)
            .unwrap();
        // ... its commit fails, and it abandons.
        values.abandon(&staged);
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        assert!(uploads(&root).is_empty());
    }

    #[test]
    fn live_intents_protect_unreferenced_objects() {
        let (values, _kv) = index(DEFAULT_INTENT_TTL);
        let staged = values.stage(b"in flight").unwrap();
        let report = values.sweep(HOLDER).unwrap();
        assert_eq!(report.deleted, 0);
        assert!(values
            .objects()
            .contains(&values.object_key(&staged.reference))
            .unwrap());
        // Abandoning makes it collectable at once.
        values.abandon(&staged);
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
    }

    #[test]
    fn a_second_sweeper_waits_for_the_lease() {
        let (values, _kv) = index(Duration::ZERO);
        assert!(values.sweep(HOLDER).unwrap().held_lease);
        assert!(!values.sweep([2; 16]).unwrap().held_lease);
    }

    /// Writers and sweepers race with every intent already expired; `sweepers` replicas, each
    /// its own index handle, sweep with no lease exclusion at all.
    fn race(sweepers: usize) {
        let kv = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let local = Arc::new(LocalFsObjectStore::temporary());
        let root = local.root().to_path_buf();
        let objects: Arc<dyn ObjectStore> = local;
        let open = || {
            LargeValues::new(kv.clone(), objects.clone(), b"T_lv:", "test")
                .with_intent_ttl(Duration::ZERO)
                .with_lease_ttl(Duration::ZERO)
        };
        let stop = AtomicBool::new(false);
        let (committed, deleted) = std::thread::scope(|scope| {
            let sweepers: Vec<_> = (0..sweepers)
                .map(|n| {
                    let (values, stop) = (open(), &stop);
                    scope.spawn(move || {
                        let mut deleted = 0;
                        while !stop.load(Ordering::SeqCst) {
                            deleted += values.sweep([n as u8 + 1; 16]).unwrap().deleted;
                        }
                        deleted
                    })
                })
                .collect();
            let writers: Vec<_> = (0..4u8)
                .map(|writer| {
                    let (values, kv) = (open(), kv.clone());
                    scope.spawn(move || {
                        let mut committed = Vec::new();
                        for round in 0..50u8 {
                            // Equal content across writers and rounds.
                            let staged = values.stage(&vec![round % 5; 1000]).unwrap();
                            let owner = [writer, round];
                            match kv.transact(|tx| values.commit_reference(tx, &staged, &owner)) {
                                Ok(()) => committed.push(staged.reference),
                                Err(LargeValueError::IntentLost) => values.abandon(&staged),
                                Err(error) => panic!("{error}"),
                            }
                        }
                        committed
                    })
                })
                .collect();
            let committed: Vec<LargeValueRef> = writers
                .into_iter()
                .flat_map(|writer| writer.join().unwrap())
                .collect();
            stop.store(true, Ordering::SeqCst);
            let deleted: usize = sweepers.into_iter().map(|s| s.join().unwrap()).sum();
            (committed, deleted)
        });
        let values = open();
        values.sweep(HOLDER).unwrap();
        assert!(!committed.is_empty());
        for reference in &committed {
            assert!(
                values.read(reference).is_ok(),
                "a referenced object was deleted"
            );
        }
        // Every unreferenced upload, including one that landed after its deletion, is gone,
        // and nothing is left blocking a later write of the same content.
        let mut expected: Vec<String> = committed.iter().map(key_of).collect();
        expected.sort();
        assert_eq!(uploads(&root), expected);
        let again = values.stage(&[0; 1000]).unwrap();
        assert_eq!(values.read(&again.reference).unwrap(), vec![0; 1000]);
        eprintln!(
            "{sweepers} sweepers: {} committed references survived {deleted} deletions",
            committed.len()
        );
    }

    #[test]
    fn concurrent_writers_and_sweeper_never_lose_a_referenced_object() {
        race(1);
    }

    #[test]
    fn several_replicas_sweeping_at_once_never_lose_a_referenced_object() {
        race(3);
    }

    /// Two replicas sweeping in turn, each its own handle: every orphan is collected and a
    /// later write of the same content is never blocked.
    #[test]
    fn alternating_sweepers_make_progress() {
        let kv = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let local = Arc::new(LocalFsObjectStore::temporary());
        let root = local.root().to_path_buf();
        let objects: Arc<dyn ObjectStore> = local;
        let open = || {
            LargeValues::new(kv.clone(), objects.clone(), b"T_lv:", "test")
                .with_intent_ttl(Duration::ZERO)
                .with_lease_ttl(Duration::ZERO)
        };
        let (a, b, writer) = (open(), open(), open());
        let mut kept = Vec::new();
        for round in 0..20u8 {
            writer.stage(b"orphan").unwrap();
            let staged = writer.stage(b"orphan").unwrap();
            if round % 2 == 0 {
                reference(&writer, &kv, &staged, &[round]);
                kept.push(staged.reference);
            }
            let sweeper = if round % 2 == 0 { &a } else { &b };
            let report = sweeper.sweep([round % 2 + 1; 16]).unwrap();
            assert!(report.held_lease);
            assert_eq!(report.deleted, if round % 2 == 0 { 1 } else { 2 });
        }
        let mut expected: Vec<String> = kept.iter().map(key_of).collect();
        expected.sort();
        assert_eq!(uploads(&root), expected);
        for reference in &kept {
            assert_eq!(writer.read(reference).unwrap(), b"orphan");
        }
    }

    #[test]
    fn an_index_refuses_a_namespace_another_index_claimed() {
        let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::temporary());
        let open = |kv: &Arc<RocksDbKvStore>, namespace: &str| {
            LargeValues::new(kv.clone(), objects.clone(), b"T_lv:", namespace)
        };
        let (first_kv, second_kv) = (
            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
        );
        assert!(open(&first_kv, "groups").stage(b"mine").is_ok());
        // Another relay's index (its own store) in the same bucket namespace.
        let other = open(&second_kv, "groups");
        let refused = other.stage(b"theirs").unwrap_err();
        assert_eq!(refused, LargeValueError::NamespaceClaimed("groups".into()));
        assert!(refused
            .to_string()
            .contains("delete the object <bucket prefix>/groups/claim"));
        assert!(matches!(
            other.sweep(HOLDER),
            Err(LargeValueError::NamespaceClaimed(_))
        ));
        // The same index, reopened, and another namespace are fine.
        assert!(open(&first_kv, "groups").stage(b"again").is_ok());
        assert!(open(&second_kv, "groups-b").stage(b"theirs").is_ok());
    }

    #[test]
    fn of_two_indexes_racing_on_an_empty_namespace_exactly_one_claims_it() {
        for _ in 0..20 {
            let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::temporary());
            let results: Vec<_> = std::thread::scope(|scope| {
                let racers: Vec<_> = (0..4)
                    .map(|_| {
                        let values = LargeValues::new(
                            Arc::new(RocksDbKvStore::open_temporary().unwrap()),
                            objects.clone(),
                            b"T_lv:",
                            "groups",
                        );
                        scope.spawn(move || values.claim_namespace())
                    })
                    .collect();
                racers.into_iter().map(|r| r.join().unwrap()).collect()
            });
            assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
            assert!(results
                .iter()
                .all(|r| matches!(r, Ok(()) | Err(LargeValueError::NamespaceClaimed(_)))));
        }
    }
}
