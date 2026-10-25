//! Content-addressed large-value store: values over [`INLINE_LIMIT`] live in an object store
//! (S3 in a cluster), and the owner's row keeps only a [`LargeValueRef`].
//!
//! FoundationDB caps a value at 100 KB, so an owner inlines a value up to 64 KiB and stores a
//! larger one here. Objects are immutable and named by their content, `<namespace>/sha256/<hex>`.
//! The owner never talks to the object store's client: composition passes an
//! [`ObjectStore`] capability, and [`LargeValues`] keeps its index in the owner's own
//! [`RelayKvStore`], so a reference commits in the same transaction as the row that holds it.
//!
//! Index keys, under the owner's `prefix`:
//! - `int:` || digest || token: a writer's upload intent, value = expiry (ms, big-endian).
//! - `ref:` || digest || owner key: one committed reference, value = byte length.
//! - `del:` || digest: the sweeper is deleting this object.
//! - `lease`: holder (16 bytes) || expiry (ms): the one sweeper allowed to decide deletions.
//!
//! Order of a write ([`LargeValues::stage`], then [`LargeValues::commit_reference`]):
//! 1. Commit an intent, unless the object is being deleted (`del:` present).
//! 2. Upload the object. A failure leaves no reference; the owner's commit never happens.
//! 3. In the owner's transaction, consume the intent and write the reference with the row.
//!    If the intent is gone (the sweeper judged the writer dead), the commit fails closed.
//!
//! The sweeper ([`LargeValues::sweep`]) acts only on expired intents. In one transaction it
//! reads every intent and the references for a digest; only with no live intent and no
//! reference does it remove the intents and mark `del:`. Then it deletes the object and clears
//! the mark. Because a writer's reference commit reads its own intent and a writer's intent
//! commit reads `del:`, every interleaving is serialized by the transaction contract: a
//! referenced object is never deleted, and no upload lands while a deletion is in progress.
//! Clocks only decide when a silent writer is presumed dead, never safety.

use std::{
    fmt::Debug,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
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

/// Expired-intent digests considered by one sweep.
const SWEEP_BATCH: usize = 1_024;

/// Failure of an [`ObjectStore`] call. The message never contains credentials.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("object store: {0}")]
pub struct ObjectStoreError(pub String);

/// Immutable object storage passed by composition: S3 in a cluster, a local directory on a
/// single node. Calls block; owners already run on blocking workers.
pub trait ObjectStore: Send + Sync + Debug {
    /// Store `bytes` at `key`. `sha256` is the content's digest, for transport integrity.
    fn put(&self, key: &str, bytes: &[u8], sha256: &[u8; 32]) -> Result<(), ObjectStoreError>;
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
    /// The object is being swept; retry the write.
    #[error("large value is being swept; retry")]
    BeingSwept,
    /// The upload intent was swept before the owner committed; retry the write.
    #[error("large value intent expired before commit; retry")]
    IntentLost,
    /// A referenced object is missing or does not match its digest.
    #[error("corrupt large value: {0}")]
    Corrupt(String),
    /// Transaction contract failure.
    #[error(transparent)]
    Kv(#[from] KvError),
}

/// A committed reference: the object's SHA-256 and byte length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LargeValueRef {
    /// SHA-256 of the value.
    pub digest: [u8; 32],
    /// Byte length of the value.
    pub len: u64,
}

impl LargeValueRef {
    /// The reference for `bytes`.
    pub fn of(bytes: &[u8]) -> Self {
        Self {
            digest: Sha256::digest(bytes).into(),
            len: bytes.len() as u64,
        }
    }
}

/// An uploaded value whose intent still protects it, until the owner commits a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    /// The reference to store in the owner's row.
    pub reference: LargeValueRef,
    intent_key: Vec<u8>,
}

/// What one sweep did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// False when another sweeper holds the lease; nothing was done.
    pub held_lease: bool,
    /// Objects deleted.
    pub deleted: usize,
    /// Digests with expired intents kept because a reference exists.
    pub kept_referenced: usize,
    /// Digests skipped because a live intent still protects them.
    pub kept_in_flight: usize,
}

/// The large-value index of one owner, over that owner's [`RelayKvStore`].
#[derive(Debug, Clone)]
pub struct LargeValues {
    kv: Arc<dyn RelayKvStore>,
    objects: Arc<dyn ObjectStore>,
    prefix: Vec<u8>,
    namespace: String,
    intent_ttl: Duration,
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

impl LargeValues {
    /// An index under `prefix` in `kv`, with objects named `<namespace>/sha256/<hex>`.
    ///
    /// Each index owns its object namespace: a sweeper consults only its own index, so two
    /// indexes must never share a namespace in one bucket.
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
        }
    }

    /// Replace the intent lifetime (tests use zero to make every intent expired at once).
    pub fn with_intent_ttl(mut self, ttl: Duration) -> Self {
        self.intent_ttl = ttl;
        self
    }

    /// The index's key prefix inside the owner's store.
    pub fn prefix(&self) -> &[u8] {
        &self.prefix
    }

    /// The object key for `reference`: `<namespace>/sha256/<hex>`.
    pub fn object_key(&self, reference: &LargeValueRef) -> String {
        format!(
            "{}/sha256/{}",
            self.namespace,
            hex::encode(reference.digest)
        )
    }

    /// The object store, for inspection.
    pub fn objects(&self) -> &Arc<dyn ObjectStore> {
        &self.objects
    }

    fn key(&self, kind: &[u8], parts: &[&[u8]]) -> Vec<u8> {
        let mut key = [self.prefix.as_slice(), kind].concat();
        for part in parts {
            key.extend_from_slice(part);
        }
        key
    }

    fn intent_prefix(&self, digest: &[u8; 32]) -> Vec<u8> {
        self.key(b"int:", &[digest])
    }

    fn ref_prefix(&self, digest: &[u8; 32]) -> Vec<u8> {
        self.key(b"ref:", &[digest])
    }

    fn ref_key(&self, digest: &[u8; 32], owner_key: &[u8]) -> Vec<u8> {
        self.key(b"ref:", &[digest, owner_key])
    }

    fn deleting_key(&self, digest: &[u8; 32]) -> Vec<u8> {
        self.key(b"del:", &[digest])
    }

    fn lease_key(&self) -> Vec<u8> {
        self.key(b"lease", &[])
    }

    /// Commit an intent, then upload `bytes`. The object exists when this returns `Ok`.
    pub fn stage(&self, bytes: &[u8]) -> Result<Staged, LargeValueError> {
        let reference = LargeValueRef::of(bytes);
        let token: [u8; 16] = rand::random();
        let intent_key = [self.intent_prefix(&reference.digest), token.to_vec()].concat();
        let deleting = self.deleting_key(&reference.digest);
        let expiry = now_ms().saturating_add(self.intent_ttl.as_millis() as u64);
        self.kv.transact(|tx| {
            if tx.get(&deleting)?.is_some() {
                return Err(LargeValueError::BeingSwept);
            }
            tx.set(&intent_key, &expiry.to_be_bytes())?;
            Ok(())
        })?;
        let staged = Staged {
            reference,
            intent_key,
        };
        if let Err(error) = self
            .objects
            .put(&self.object_key(&reference), bytes, &reference.digest)
        {
            self.abandon(&staged);
            return Err(error.into());
        }
        Ok(staged)
    }

    /// Inside the owner's transaction (on the same store): consume the intent and record that
    /// `owner_key` references the staged object.
    pub fn commit_reference(
        &self,
        tx: &mut dyn KvTransaction,
        staged: &Staged,
        owner_key: &[u8],
    ) -> Result<(), LargeValueError> {
        if tx.get(&staged.intent_key)?.is_none() {
            return Err(LargeValueError::IntentLost);
        }
        tx.clear(&staged.intent_key)?;
        tx.set(
            &self.ref_key(&staged.reference.digest, owner_key),
            &staged.reference.len.to_be_bytes(),
        )?;
        Ok(())
    }

    /// Inside the owner's transaction: drop `owner_key`'s reference (its row is replaced or
    /// removed). The object becomes collectable only once no reference remains.
    pub fn clear_reference(
        &self,
        tx: &mut dyn KvTransaction,
        reference: &LargeValueRef,
        owner_key: &[u8],
    ) -> Result<(), LargeValueError> {
        let key = self.ref_key(&reference.digest, owner_key);
        if tx.get(&key)?.is_some() {
            tx.clear(&key)?;
            // Make the object visible to the sweeper, which works from expired intents.
            let token = [0u8; 16];
            tx.set(
                &[self.intent_prefix(&reference.digest), token.to_vec()].concat(),
                &0u64.to_be_bytes(),
            )?;
        }
        Ok(())
    }

    /// The owner will not commit `staged` (or its commit failed): leave an expired intent so a
    /// sweep collects the object unless something references it. This re-creates an intent the
    /// sweeper already removed, so an upload that landed after a deletion is still collected.
    /// Best effort; an intent that cannot be expired still expires on its own.
    pub fn abandon(&self, staged: &Staged) {
        let result = self
            .kv
            .transact(|tx| tx.set(&staged.intent_key, &0u64.to_be_bytes()));
        if let Err(error) = result {
            tracing::warn!("could not expire a large-value intent: {error}");
        }
    }

    /// Read a referenced value and check it against its digest and length.
    pub fn read(&self, reference: &LargeValueRef) -> Result<Vec<u8>, LargeValueError> {
        let key = self.object_key(reference);
        let bytes = self.objects.get(&key)?.ok_or_else(|| {
            LargeValueError::Corrupt(format!("referenced object {key} is missing"))
        })?;
        if LargeValueRef::of(&bytes) != *reference {
            return Err(LargeValueError::Corrupt(format!(
                "object {key} does not match its reference"
            )));
        }
        Ok(bytes)
    }

    /// Delete unreferenced objects whose intents expired, as the lease holder `holder`.
    pub fn sweep(&self, holder: [u8; 16]) -> Result<SweepReport, LargeValueError> {
        let mut report = SweepReport::default();
        if !self.renew_lease(&holder)? {
            return Ok(report);
        }
        report.held_lease = true;

        // Finish deletions a previous sweeper started.
        let deleting_prefix = self.key(b"del:", &[]);
        let unfinished = self
            .kv
            .transact(|tx| tx.scan_prefix(&deleting_prefix, None, SWEEP_BATCH))?;
        for (key, _) in unfinished {
            let digest: [u8; 32] = key[deleting_prefix.len()..]
                .try_into()
                .map_err(|_| LargeValueError::Corrupt("bad deletion mark".into()))?;
            self.finish_delete(&holder, &digest)?;
            report.deleted += 1;
        }

        let now = now_ms();
        let intents = self.key(b"int:", &[]);
        let mut expired: Vec<[u8; 32]> = Vec::new();
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
                let digest: [u8; 32] = key
                    .get(intents.len()..intents.len() + 32)
                    .and_then(|d| d.try_into().ok())
                    .ok_or_else(|| LargeValueError::Corrupt("bad intent key".into()))?;
                if read_u64(value, "intent expiry")? <= now && expired.last() != Some(&digest) {
                    expired.push(digest);
                }
            }
        }

        for digest in expired {
            match self.decide(&holder, &digest, now)? {
                Decision::Delete => {
                    self.finish_delete(&holder, &digest)?;
                    report.deleted += 1;
                }
                Decision::Referenced => report.kept_referenced += 1,
                Decision::InFlight => report.kept_in_flight += 1,
                Decision::LeaseLost => break,
            }
        }
        Ok(report)
    }

    /// Take or renew the lease. Returns false when another live holder has it.
    fn renew_lease(&self, holder: &[u8; 16]) -> Result<bool, LargeValueError> {
        let key = self.lease_key();
        self.kv.transact(|tx| self.hold_lease(tx, &key, holder))
    }

    fn hold_lease(
        &self,
        tx: &mut dyn KvTransaction,
        key: &[u8],
        holder: &[u8; 16],
    ) -> Result<bool, LargeValueError> {
        let now = now_ms();
        if let Some(current) = tx.get(key)? {
            if current.len() != 24 {
                return Err(LargeValueError::Corrupt("bad sweep lease".into()));
            }
            if current[..16] != holder[..] && read_u64(&current[16..], "lease expiry")? > now {
                return Ok(false);
            }
        }
        let expiry = now.saturating_add(SWEEP_LEASE_TTL.as_millis() as u64);
        tx.set(key, &[holder.as_slice(), &expiry.to_be_bytes()].concat())?;
        Ok(true)
    }

    /// One transaction: may this digest's object be deleted?
    fn decide(
        &self,
        holder: &[u8; 16],
        digest: &[u8; 32],
        now: u64,
    ) -> Result<Decision, LargeValueError> {
        let lease = self.lease_key();
        let intents = self.intent_prefix(digest);
        let refs = self.ref_prefix(digest);
        let deleting = self.deleting_key(digest);
        self.kv.transact(|tx| {
            if !self.hold_lease(tx, &lease, holder)? {
                return Ok(Decision::LeaseLost);
            }
            let mut live = false;
            let mut stale = Vec::new();
            let mut after: Option<Vec<u8>> = None;
            loop {
                let page = tx.scan_prefix(&intents, after.as_deref(), 256)?;
                let Some((last, _)) = page.last() else {
                    break;
                };
                after = Some(last.clone());
                for (key, value) in page {
                    if read_u64(&value, "intent expiry")? > now {
                        live = true;
                    } else {
                        stale.push(key);
                    }
                }
            }
            for key in &stale {
                tx.clear(key)?;
            }
            if live {
                return Ok(Decision::InFlight);
            }
            if !tx.scan_prefix(&refs, None, 1)?.is_empty() {
                return Ok(Decision::Referenced);
            }
            tx.set(&deleting, &[])?;
            Ok(Decision::Delete)
        })
    }

    /// Delete the marked object, then clear the mark.
    fn finish_delete(&self, holder: &[u8; 16], digest: &[u8; 32]) -> Result<(), LargeValueError> {
        let reference = LargeValueRef {
            digest: *digest,
            len: 0,
        };
        self.objects.delete(&self.object_key(&reference))?;
        let lease = self.lease_key();
        let deleting = self.deleting_key(digest);
        self.kv.transact(|tx| {
            self.hold_lease(tx, &lease, holder)?;
            tx.clear(&deleting)?;
            Ok(())
        })
    }
}

enum Decision {
    Delete,
    Referenced,
    InFlight,
    LeaseLost,
}

/// Object keys are `<namespace>/sha256/<hex>`: lowercase ASCII, digits, `-`, `_` and `/`.
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

    const HOLDER: [u8; 16] = [1; 16];

    #[test]
    fn staged_value_reads_back_and_rejects_a_tampered_object() {
        let (values, kv) = index(DEFAULT_INTENT_TTL);
        let bytes = vec![9u8; INLINE_LIMIT + 1];
        let staged = values.stage(&bytes).unwrap();
        reference(&values, &kv, &staged, b"row");
        assert_eq!(values.read(&staged.reference).unwrap(), bytes);
        let key = values.object_key(&staged.reference);
        assert!(key.starts_with("test/sha256/"));
        values.objects().put(&key, b"tampered", &[0; 32]).unwrap();
        assert!(matches!(
            values.read(&staged.reference),
            Err(LargeValueError::Corrupt(_))
        ));
    }

    #[test]
    fn sweep_deletes_an_orphan_and_never_a_referenced_object() {
        let (values, kv) = index(Duration::ZERO);
        let orphan = values.stage(b"orphan: uploaded, never committed").unwrap();
        let kept = values.stage(b"referenced").unwrap();
        reference(&values, &kv, &kept, b"row");
        // A second reference to the same content, and an expired intent for it.
        let again = values.stage(b"referenced").unwrap();
        reference(&values, &kv, &again, b"row-2");
        values.stage(b"referenced").unwrap();

        let report = values.sweep(HOLDER).unwrap();
        assert!(report.held_lease);
        assert_eq!(report.deleted, 1);
        assert_eq!(report.kept_referenced, 1);
        let objects = values.objects();
        assert!(!objects
            .contains(&values.object_key(&orphan.reference))
            .unwrap());
        assert_eq!(values.read(&kept.reference).unwrap(), b"referenced");
        // Nothing is left to do, and the referenced object survives repeated sweeps.
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 0);
        assert_eq!(values.read(&kept.reference).unwrap(), b"referenced");
        let leftovers = kv
            .transact(|tx| tx.scan_prefix(b"T_lv:int:", None, 10))
            .unwrap();
        assert!(leftovers.is_empty());
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
        assert!(kv
            .transact(|tx| tx.scan_prefix(b"T_lv:ref:", None, 10))
            .unwrap()
            .is_empty());
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
    fn writes_wait_for_an_unfinished_deletion_and_a_second_sweeper_is_excluded() {
        let (values, kv) = index(Duration::ZERO);
        let staged = values.stage(b"marked").unwrap();
        values.abandon(&staged);
        // A sweeper that marked the object and stopped before deleting it.
        let digest = staged.reference.digest;
        kv.transact(|tx| {
            for (key, _) in tx.scan_prefix(b"T_lv:int:", None, 10)? {
                tx.clear(&key)?;
            }
            tx.set(&values.deleting_key(&digest), &[])
        })
        .unwrap();
        assert_eq!(values.stage(b"marked"), Err(LargeValueError::BeingSwept));
        assert_eq!(values.sweep(HOLDER).unwrap().deleted, 1);
        assert!(values.stage(b"marked").is_ok());
        assert!(!values.sweep([2; 16]).unwrap().held_lease);
    }

    #[test]
    fn concurrent_writers_and_sweeper_never_lose_a_referenced_object() {
        let (values, kv, root) = index_with_root(Duration::ZERO);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sweeper = {
            let values = values.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut deleted = 0;
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    deleted += values.sweep(HOLDER).unwrap().deleted;
                }
                deleted
            })
        };
        let writers: Vec<_> = (0..4u8)
            .map(|writer| {
                let values = values.clone();
                let kv = kv.clone();
                std::thread::spawn(move || {
                    let mut committed = Vec::new();
                    for round in 0..50u8 {
                        // Every intent is already expired, so the sweeper races each commit.
                        let bytes = vec![round % 5; 1000];
                        let Ok(staged) = values.stage(&bytes) else {
                            continue;
                        };
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
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let deleted = sweeper.join().unwrap();
        values.sweep(HOLDER).unwrap();
        assert!(!committed.is_empty());
        for reference in &committed {
            assert!(
                values.read(reference).is_ok(),
                "a referenced object was deleted"
            );
        }
        // Every unreferenced upload, including one that landed after its deletion, is gone.
        let mut remaining: Vec<String> = std::fs::read_dir(root.join("test/sha256"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| !name.starts_with('.'))
            .collect();
        remaining.sort();
        let mut expected: Vec<String> = committed.iter().map(|r| hex::encode(r.digest)).collect();
        expected.sort();
        expected.dedup();
        assert_eq!(remaining, expected);
        eprintln!(
            "{} committed references survived {deleted} concurrent deletions",
            committed.len()
        );
    }
}
