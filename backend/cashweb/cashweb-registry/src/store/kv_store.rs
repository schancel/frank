//! Interactive transaction contract for relay owners, with two real drivers.
//!
//! An owner states one transaction as a closure: `store.transact(|tx| { ... })`. Inside it,
//! [`KvTransaction`] reads (each read adds a read-conflict range), writes, clears and adds.
//! The driver commits when the closure returns `Ok`, discards every write when it returns
//! `Err`, and re-runs the closure when a concurrent commit conflicted with its reads.
//!
//! - [`RocksDbKvStore`]: one embedded RocksDB opened by one process (RocksDB's own `LOCK`).
//!   Reads come from a RocksDB snapshot; an in-process resolver checks the read set against
//!   the keys committed since that snapshot, which detects point and range (phantom) conflicts.
//!   (RocksDB's `OptimisticTransactionDB` validates only point keys, so it would miss an
//!   insert into a range that was read.)
//! - `FoundationDbKvStore` (`foundationdb` feature, `foundationdb_driver.rs`): a live FDB
//!   cluster, with every key inside one subspace prefix.
//!
//! Both drivers enforce FoundationDB's limits, so code that passes on RocksDB fits FDB:
//! [`MAX_KEY_BYTES`], [`MAX_VALUE_BYTES`], [`MAX_TRANSACTION_BYTES`] and
//! [`MAX_TRANSACTION_DURATION`] per attempt.
//!
//! Retries are bounded by [`MAX_ATTEMPTS`]. A commit whose outcome is unknown is returned as
//! [`KvError::CommitUnknownResult`] and never retried here: the caller must read its own
//! accept keys to learn whether the transaction landed before it reports or repeats an effect.
//! The closure may run more than once, so it must have no effects outside `tx`.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Debug,
    ops::Bound,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use rocksdb::{Direction, IteratorMode, Options, ReadOptions, WriteBatch, WriteOptions};
use thiserror::Error;

/// FoundationDB's key size limit.
pub const MAX_KEY_BYTES: usize = 10_000;
/// FoundationDB's value size limit.
pub const MAX_VALUE_BYTES: usize = 100_000;
/// FoundationDB's default transaction size limit (mutations plus conflict ranges).
pub const MAX_TRANSACTION_BYTES: usize = 10_000_000;
/// FoundationDB's transaction lifetime (MVCC window), applied to each attempt.
pub const MAX_TRANSACTION_DURATION: Duration = Duration::from_secs(5);
/// Attempts before a repeatedly conflicting transaction gives up.
pub const MAX_ATTEMPTS: u32 = 50;

/// Errors from the transaction contract.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KvError {
    /// A key is longer than [`MAX_KEY_BYTES`] (including any driver subspace prefix).
    #[error("key of {len} bytes exceeds the {limit}-byte limit")]
    KeyTooLarge {
        /// Key length in bytes.
        len: usize,
        /// The limit.
        limit: usize,
    },
    /// A value is longer than [`MAX_VALUE_BYTES`].
    #[error("value of {len} bytes exceeds the {limit}-byte limit")]
    ValueTooLarge {
        /// Value length in bytes.
        len: usize,
        /// The limit.
        limit: usize,
    },
    /// The transaction's writes and conflict ranges exceed [`MAX_TRANSACTION_BYTES`].
    #[error("transaction exceeds the {limit}-byte limit")]
    TransactionTooLarge {
        /// The limit.
        limit: usize,
    },
    /// An attempt ran longer than [`MAX_TRANSACTION_DURATION`]. Nothing was committed.
    #[error("transaction exceeded {}s", MAX_TRANSACTION_DURATION.as_secs())]
    TransactionTimedOut,
    /// Every attempt conflicted with a concurrent commit. Nothing was committed.
    #[error("transaction conflicted on all {attempts} attempts")]
    ConflictRetriesExhausted {
        /// Attempts made.
        attempts: u32,
    },
    /// The commit may or may not have been applied. Not retried: reconcile by reading.
    #[error("commit outcome unknown; reconcile before retrying: {0}")]
    CommitUnknownResult(String),
    /// This attempt hit a transient error and will be re-run by `transact`; propagate it.
    #[error("transient transaction error; the attempt will be retried")]
    Retry,
    /// Invalid argument to a driver constructor.
    #[error("invalid kv argument: {0}")]
    InvalidArgument(String),
    /// Underlying storage engine error. Nothing was committed.
    #[error("kv backend error: {0}")]
    Backend(String),
}

/// Operations available inside one transaction attempt.
pub trait KvTransaction {
    /// Read `key`, adding it to the read-conflict set.
    fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError>;

    /// Read up to `limit` rows in `[start, end)` in key order. The range actually read
    /// (to `end`, or to just past the last row when `limit` was reached) becomes a read-conflict
    /// range: a concurrent commit inserting, changing or clearing a key in it conflicts.
    fn get_range(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError>;

    /// Write `value` at `key`.
    fn set(&mut self, key: &[u8], value: &[u8]) -> Result<(), KvError>;

    /// Remove `key`.
    fn clear(&mut self, key: &[u8]) -> Result<(), KvError>;

    /// FoundationDB `ADD`: add `delta` to the little-endian integer at `key` (absent is 0;
    /// the result is 8 bytes, wrapping). Adds no read conflict, so concurrent adds commute.
    fn atomic_add(&mut self, key: &[u8], delta: i64) -> Result<(), KvError>;

    /// Rows under `prefix`, strictly after `after` when given, up to `limit`.
    fn scan_prefix(
        &mut self,
        prefix: &[u8],
        after: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        let end = prefix_end(prefix);
        let start = match after {
            Some(after) if after >= prefix => key_after(after),
            _ => prefix.to_vec(),
        };
        if start >= end {
            return Ok(Vec::new());
        }
        self.get_range(&start, &end, limit)
    }
}

/// Whether the closure asked to commit or to discard the attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Commit the attempt's writes.
    Commit,
    /// Discard the attempt's writes and stop.
    Abort,
}

/// A transactional store. Drivers implement [`RelayKvStore::run_transaction`]; owners call
/// [`Transact::transact`].
pub trait RelayKvStore: Send + Sync + Debug {
    /// Run `body` until it commits, aborts, or fails. The driver re-runs `body` after a conflict
    /// or after a [`KvError::Retry`] reported by one of its operations, up to [`MAX_ATTEMPTS`].
    fn run_transaction(
        &self,
        body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
    ) -> Result<Outcome, KvError>;
}

/// The owner-facing entry point, for every [`RelayKvStore`] including `dyn RelayKvStore`.
pub trait Transact {
    /// Run `body` as one serializable transaction. `Ok` commits; `Err` discards the attempt's
    /// writes and is returned unchanged. Store failures arrive as `E::from(KvError)`.
    fn transact<T, E, F>(&self, body: F) -> Result<T, E>
    where
        E: From<KvError>,
        F: FnMut(&mut dyn KvTransaction) -> Result<T, E>;
}

impl<S: RelayKvStore + ?Sized> Transact for S {
    fn transact<T, E, F>(&self, mut body: F) -> Result<T, E>
    where
        E: From<KvError>,
        F: FnMut(&mut dyn KvTransaction) -> Result<T, E>,
    {
        let mut result = None;
        self.run_transaction(&mut |tx| {
            let attempt = body(tx);
            let outcome = if attempt.is_ok() {
                Outcome::Commit
            } else {
                Outcome::Abort
            };
            result = Some(attempt);
            outcome
        })?;
        result.expect("a finished transaction ran its body")
    }
}

/// The first key after every key starting with `prefix` (FDB `strinc`); `[0xff]` when the
/// prefix is all `0xff` (or empty), so ranges stay in the normal key space.
pub fn prefix_end(prefix: &[u8]) -> Vec<u8> {
    match prefix.iter().rposition(|byte| *byte != 0xff) {
        Some(index) => {
            let mut end = prefix[..=index].to_vec();
            end[index] += 1;
            end
        }
        None => vec![0xff],
    }
}

/// The smallest key greater than `key`.
pub fn key_after(key: &[u8]) -> Vec<u8> {
    let mut next = Vec::with_capacity(key.len() + 1);
    next.extend_from_slice(key);
    next.push(0);
    next
}

/// FDB `ADD` on an existing value: little-endian, zero-extended or truncated to 8 bytes.
pub(crate) fn add_le(existing: Option<&[u8]>, delta: i64) -> [u8; 8] {
    let mut current = [0u8; 8];
    if let Some(existing) = existing {
        let len = existing.len().min(8);
        current[..len].copy_from_slice(&existing[..len]);
    }
    u64::from_le_bytes(current)
        .wrapping_add(delta as u64)
        .to_le_bytes()
}

/// Per-attempt accounting of FoundationDB's limits, shared by both drivers.
#[derive(Debug)]
pub(crate) struct Limits {
    started: Instant,
    bytes: usize,
}

impl Limits {
    pub(crate) fn start() -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
        }
    }

    pub(crate) fn timed_out(&self) -> bool {
        self.started.elapsed() >= MAX_TRANSACTION_DURATION
    }

    pub(crate) fn check_time(&self) -> Result<(), KvError> {
        if self.timed_out() {
            return Err(KvError::TransactionTimedOut);
        }
        Ok(())
    }

    pub(crate) fn key(&self, len: usize) -> Result<(), KvError> {
        if len > MAX_KEY_BYTES {
            return Err(KvError::KeyTooLarge {
                len,
                limit: MAX_KEY_BYTES,
            });
        }
        Ok(())
    }

    pub(crate) fn value(&self, len: usize) -> Result<(), KvError> {
        if len > MAX_VALUE_BYTES {
            return Err(KvError::ValueTooLarge {
                len,
                limit: MAX_VALUE_BYTES,
            });
        }
        Ok(())
    }

    /// Count `bytes` of mutation or conflict range toward the transaction size.
    pub(crate) fn charge(&mut self, bytes: usize) -> Result<(), KvError> {
        self.check_time()?;
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > MAX_TRANSACTION_BYTES {
            return Err(KvError::TransactionTooLarge {
                limit: MAX_TRANSACTION_BYTES,
            });
        }
        Ok(())
    }
}

fn backend(error: impl std::fmt::Display) -> KvError {
    KvError::Backend(error.to_string())
}

/// Committed write sets newer than the oldest open snapshot, and the open snapshots.
#[derive(Debug, Default)]
struct Resolver {
    version: u64,
    recent: VecDeque<(u64, Vec<Vec<u8>>)>,
    open: BTreeMap<u64, usize>,
}

impl Resolver {
    fn prune(&mut self) {
        // A write committed at version `v` matters only to snapshots taken before `v`.
        match self.open.keys().next().copied() {
            Some(oldest) => {
                while self.recent.front().is_some_and(|(v, _)| *v <= oldest) {
                    self.recent.pop_front();
                }
            }
            None => self.recent.clear(),
        }
    }
}

/// RocksDB driver: one process owns the database directory.
pub struct RocksDbKvStore {
    // Field order: the database closes before a temporary directory is removed.
    db: rocksdb::DB,
    resolver: Mutex<Resolver>,
    _temporary: Option<tempfile::TempDir>,
}

impl Debug for RocksDbKvStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RocksDbKvStore {{ path: {:?} }}", self.db.path())
    }
}

impl RocksDbKvStore {
    /// Open or create the database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, KvError> {
        let mut options = Options::default();
        options.create_if_missing(true);
        Ok(Self {
            db: rocksdb::DB::open(&options, path.as_ref()).map_err(backend)?,
            resolver: Mutex::default(),
            _temporary: None,
        })
    }

    /// Open a fresh database in a temporary directory that is removed with the store.
    pub fn open_temporary() -> Result<Self, KvError> {
        let directory = tempfile::tempdir().map_err(backend)?;
        let mut store = Self::open(directory.path())?;
        store._temporary = Some(directory);
        Ok(store)
    }

    fn resolver(&self) -> MutexGuard<'_, Resolver> {
        // Every resolver update is completed before the guard is released. A commit records its
        // writes before the synced write, so a panic or error there leaves a safe superset.
        self.resolver.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn begin(&self) -> RocksTransaction<'_> {
        let mut resolver = self.resolver();
        // The snapshot and its version are taken together under the commit lock.
        let snapshot = self.db.snapshot();
        let read_version = resolver.version;
        *resolver.open.entry(read_version).or_default() += 1;
        drop(resolver);
        RocksTransaction {
            store: self,
            snapshot,
            read_version,
            writes: BTreeMap::new(),
            point_reads: BTreeSet::new(),
            range_reads: Vec::new(),
            limits: Limits::start(),
        }
    }
}

#[derive(Debug, Clone)]
enum Write {
    Set(Vec<u8>),
    Clear,
    Add(i64),
}

struct RocksTransaction<'a> {
    store: &'a RocksDbKvStore,
    snapshot: rocksdb::Snapshot<'a>,
    read_version: u64,
    writes: BTreeMap<Vec<u8>, Write>,
    point_reads: BTreeSet<Vec<u8>>,
    range_reads: Vec<(Vec<u8>, Vec<u8>)>,
    limits: Limits,
}

impl Drop for RocksTransaction<'_> {
    fn drop(&mut self) {
        let mut resolver = self.store.resolver();
        if let Some(count) = resolver.open.get_mut(&self.read_version) {
            *count -= 1;
            if *count == 0 {
                resolver.open.remove(&self.read_version);
            }
        }
        resolver.prune();
    }
}

enum CommitError {
    Conflict,
    Failed(KvError),
}

impl RocksTransaction<'_> {
    fn read_stored(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.snapshot.get(key).map_err(backend)
    }

    fn conflicts_with(&self, key: &[u8]) -> bool {
        self.point_reads.contains(key)
            || self
                .range_reads
                .iter()
                .any(|(start, end)| start.as_slice() <= key && key < end.as_slice())
    }

    fn commit(&self) -> Result<(), CommitError> {
        self.limits.check_time().map_err(CommitError::Failed)?;
        if self.writes.is_empty() {
            return Ok(());
        }
        let mut resolver = self.store.resolver();
        for (version, keys) in &resolver.recent {
            if *version > self.read_version && keys.iter().any(|key| self.conflicts_with(key)) {
                return Err(CommitError::Conflict);
            }
        }
        let mut batch = WriteBatch::default();
        for (key, write) in &self.writes {
            match write {
                Write::Set(value) => batch.put(key, value),
                Write::Clear => batch.delete(key),
                // Applied to the latest committed value under the commit lock, as FDB applies
                // atomic operations at commit: concurrent adds never conflict.
                Write::Add(delta) => {
                    let latest = self
                        .store
                        .db
                        .get(key)
                        .map_err(|e| CommitError::Failed(backend(e)))?;
                    batch.put(key, add_le(latest.as_deref(), *delta))
                }
            }
        }
        // Record the writes before attempting them: if the write fails or panics, the history
        // holds a superset of what committed, which only causes extra conflicts.
        resolver.version += 1;
        let version = resolver.version;
        let keys = self.writes.keys().cloned().collect();
        resolver.recent.push_back((version, keys));
        resolver.prune();
        let mut options = WriteOptions::default();
        options.set_sync(true);
        // A failed synced write may still have reached the WAL, so its outcome is unknown.
        self.store
            .db
            .write_opt(batch, &options)
            .map_err(|e| CommitError::Failed(KvError::CommitUnknownResult(e.to_string())))?;
        Ok(())
    }
}

impl KvTransaction for RocksTransaction<'_> {
    fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.limits.key(key.len())?;
        match self.writes.get(key).cloned() {
            Some(Write::Set(value)) => {
                self.limits.check_time()?;
                Ok(Some(value))
            }
            Some(Write::Clear) => {
                self.limits.check_time()?;
                Ok(None)
            }
            Some(Write::Add(delta)) => {
                self.limits.charge(key.len())?;
                let value = add_le(self.read_stored(key)?.as_deref(), delta).to_vec();
                self.point_reads.insert(key.to_vec());
                self.writes.insert(key.to_vec(), Write::Set(value.clone()));
                Ok(Some(value))
            }
            None => {
                self.limits.charge(key.len())?;
                let value = self.read_stored(key)?;
                self.point_reads.insert(key.to_vec());
                Ok(value)
            }
        }
    }

    fn get_range(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        self.limits.key(start.len())?;
        self.limits.key(end.len())?;
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        self.limits.charge(start.len() + end.len())?;
        let mut options = ReadOptions::default();
        options.set_iterate_upper_bound(end.to_vec());
        let mut stored = self
            .snapshot
            .iterator_opt(IteratorMode::From(start, Direction::Forward), options)
            .peekable();
        let mut local = self
            .writes
            .range::<[u8], _>((Bound::Included(start), Bound::Excluded(end)))
            .peekable();
        let mut rows = Vec::new();
        let mut resolved_adds = Vec::new();
        while rows.len() < limit {
            let stored_key = match stored.peek() {
                Some(Ok((key, _))) => Some(key.to_vec()),
                Some(Err(error)) => return Err(backend(error)),
                None => None,
            };
            let take_local = match (&stored_key, local.peek()) {
                (None, None) => break,
                (Some(_), None) => false,
                (None, Some(_)) => true,
                (Some(stored_key), Some((local_key, _))) => *local_key <= stored_key,
            };
            if !take_local {
                let (key, value) = stored.next().expect("peeked").map_err(backend)?;
                rows.push((key.to_vec(), value.to_vec()));
                continue;
            }
            let (key, write) = local.next().expect("peeked");
            // A local write shadows the stored row with the same key.
            let shadowed = if stored_key.as_ref() == Some(key) {
                Some(stored.next().expect("peeked").map_err(backend)?.1.to_vec())
            } else {
                None
            };
            match write {
                Write::Set(value) => rows.push((key.clone(), value.clone())),
                Write::Clear => {}
                Write::Add(delta) => {
                    let value = add_le(shadowed.as_deref(), *delta).to_vec();
                    resolved_adds.push((key.clone(), value.clone()));
                    rows.push((key.clone(), value));
                }
            }
        }
        drop(local);
        // Like FDB, reading a pending add resolves it against the snapshot (under the
        // range's read conflict), so later reads in this attempt see the same value.
        for (key, value) in resolved_adds {
            self.writes.insert(key, Write::Set(value));
        }
        let read_end = match rows.last() {
            Some((last, _)) if rows.len() == limit => key_after(last),
            _ => end.to_vec(),
        };
        self.range_reads.push((start.to_vec(), read_end));
        Ok(rows)
    }

    fn set(&mut self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        self.limits.key(key.len())?;
        self.limits.value(value.len())?;
        self.limits.charge(key.len() + value.len())?;
        self.writes.insert(key.to_vec(), Write::Set(value.to_vec()));
        Ok(())
    }

    fn clear(&mut self, key: &[u8]) -> Result<(), KvError> {
        self.limits.key(key.len())?;
        self.limits.charge(key.len())?;
        self.writes.insert(key.to_vec(), Write::Clear);
        Ok(())
    }

    fn atomic_add(&mut self, key: &[u8], delta: i64) -> Result<(), KvError> {
        self.limits.key(key.len())?;
        self.limits.charge(key.len() + 8)?;
        let next = match self.writes.get(key) {
            Some(Write::Set(value)) => Write::Set(add_le(Some(value), delta).to_vec()),
            Some(Write::Clear) => Write::Set(add_le(None, delta).to_vec()),
            Some(Write::Add(previous)) => Write::Add(previous.wrapping_add(delta)),
            None => Write::Add(delta),
        };
        self.writes.insert(key.to_vec(), next);
        Ok(())
    }
}

impl RelayKvStore for RocksDbKvStore {
    fn run_transaction(
        &self,
        body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
    ) -> Result<Outcome, KvError> {
        for _ in 0..MAX_ATTEMPTS {
            let mut tx = self.begin();
            if body(&mut tx) == Outcome::Abort {
                return Ok(Outcome::Abort);
            }
            match tx.commit() {
                Ok(()) => return Ok(Outcome::Commit),
                Err(CommitError::Conflict) => std::thread::yield_now(),
                Err(CommitError::Failed(error)) => return Err(error),
            }
        }
        Err(KvError::ConflictRetriesExhausted {
            attempts: MAX_ATTEMPTS,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_follows_foundationdb_little_endian_semantics() {
        assert_eq!(add_le(None, 5), 5u64.to_le_bytes());
        assert_eq!(add_le(Some(&[1]), 1), 2u64.to_le_bytes());
        assert_eq!(add_le(Some(&[0xff; 10]), 1), [0; 8]);
        assert_eq!(add_le(Some(&3u64.to_le_bytes()), -1), 2u64.to_le_bytes());
    }

    #[test]
    fn prefix_end_and_key_after_bound_ranges() {
        assert_eq!(prefix_end(b"ab"), b"ac");
        assert_eq!(prefix_end(&[1, 0xff]), vec![2]);
        assert_eq!(prefix_end(&[]), vec![0xff]);
        assert_eq!(key_after(b"a"), b"a\0");
    }

    #[test]
    fn reads_see_own_writes_merged_in_key_order() {
        let store = RocksDbKvStore::open_temporary().unwrap();
        store
            .transact(|tx| {
                tx.set(b"k1", b"stored")?;
                tx.set(b"k3", b"stored")?;
                tx.set(b"k4", b"stored")?;
                tx.set(b"n", &1u64.to_le_bytes())
            })
            .unwrap();
        let rows = store
            .transact(|tx| {
                tx.set(b"k2", b"local")?;
                tx.clear(b"k3")?;
                tx.set(b"k4", b"replaced")?;
                tx.atomic_add(b"k5", 7)?;
                tx.atomic_add(b"n", 2)?;
                assert_eq!(tx.get(b"n")?, Some(3u64.to_le_bytes().to_vec()));
                tx.scan_prefix(b"k", None, 10)
            })
            .unwrap();
        let rows: Vec<_> = rows
            .iter()
            .map(|(k, v)| (k.as_slice(), v.as_slice()))
            .collect();
        assert_eq!(
            rows,
            vec![
                (b"k1".as_slice(), b"stored".as_slice()),
                (b"k2", b"local"),
                (b"k4", b"replaced"),
                (b"k5", &7u64.to_le_bytes()),
            ]
        );
        let after = store
            .transact(|tx| tx.scan_prefix(b"k", Some(b"k2"), 1))
            .unwrap();
        assert_eq!(after, vec![(b"k4".to_vec(), b"replaced".to_vec())]);
    }

    #[test]
    fn an_aborted_attempt_writes_nothing() {
        let store = RocksDbKvStore::open_temporary().unwrap();
        let result: Result<(), KvError> = store.transact(|tx| {
            tx.set(b"k", b"v")?;
            Err(KvError::Backend("caller refused".into()))
        });
        assert_eq!(result, Err(KvError::Backend("caller refused".into())));
        assert_eq!(store.transact(|tx| tx.get(b"k")).unwrap(), None);
    }
}
