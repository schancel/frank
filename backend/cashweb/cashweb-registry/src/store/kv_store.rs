//! Transactional Key-Value store abstraction (`RelayKvStore`) and 80-bit `Versionstamp`
//! ordering primitive (Issue #1575).
//!
//! Decouples Inbox (`'I'`), Group Mailboxes (`'G'`), Group Epoch Metadata (`'G_meta'`),
//! and cluster-wide relay metadata (`'M_vapid_privkey'`) from raw single-node `rocksdb::DB`
//! calls so the relay can run against:
//! - [`RocksDbKvStore`]: embedded single-node RocksDB backend with persisted monotonic
//!   versionstamp state (`M_kv_versionstamp_seq`).
//! - [`MemoryKvStore`]: deterministic in-memory `BTreeMap` backend for fast tests.
//! - [`FoundationDbKvStore`]: subspace-prefixed FoundationDB cluster adapter supporting
//!   FoundationDB `SET_VERSIONSTAMPED_KEY` 14-byte trailer semantics, conflict-range
//!   serializable transactions (`execute_transaction`), and multi-replica CAS via
//!   [`FdbTransactionDriver`] / [`SimulatedFdbCluster`].

use std::{
    collections::BTreeMap,
    fmt::Debug,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rocksdb::{Direction, IteratorMode, Options, ReadOptions, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Subspace prefix for direct-message inboxes (`'I'`).
pub const SUBSPACE_INBOX: &[u8] = b"I";
/// Subspace prefix for shared group message mailboxes (`'G'`).
pub const SUBSPACE_GROUP_MESSAGES: &[u8] = b"G";
/// Subspace prefix for group epoch metadata heads (`'G_meta'`).
pub const SUBSPACE_GROUP_META: &[u8] = b"G_meta";

/// Persisted monotonic versionstamp sequence key in [`RocksDbKvStore`].
pub const ROCKSDB_VERSIONSTAMP_SEQ_KEY: &[u8] = b"M_kv_versionstamp_seq";
/// Internal key used by [`RocksDbKvStore`] to persist the full 10-byte last [`Versionstamp`].
const META_LAST_VERSIONSTAMP_KEY: &[u8] = b"\x00__frank_last_versionstamp__";

/// FoundationDB-compatible 80-bit (`[u8; 10]`) strictly monotonic versionstamp:
/// - Bytes `0..8`: big-endian `u64` commit version (timestamp or monotonic sequence).
/// - Bytes `8..10`: big-endian `u16` batch index within that commit version.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Versionstamp(pub [u8; 10]);

impl Versionstamp {
    /// Construct a 10-byte `Versionstamp` from a 64-bit commit version and 16-bit batch index.
    pub const fn new(commit_version: u64, batch_order: u16) -> Self {
        let cv = commit_version.to_be_bytes();
        let bo = batch_order.to_be_bytes();
        Self([
            cv[0], cv[1], cv[2], cv[3], cv[4], cv[5], cv[6], cv[7], bo[0], bo[1],
        ])
    }

    /// Wrap raw 10-byte big-endian versionstamp bytes.
    pub const fn from_bytes(bytes: [u8; 10]) -> Self {
        Self(bytes)
    }

    /// Parse a 10-byte slice into a [`Versionstamp`].
    pub fn try_from_slice(slice: &[u8]) -> Result<Self, KvError> {
        let bytes: [u8; 10] = slice.try_into().map_err(|_| {
            KvError::InvalidArgument(format!(
                "versionstamp must be exactly 10 bytes, got {}",
                slice.len()
            ))
        })?;
        Ok(Self(bytes))
    }

    /// Borrow the underlying 10-byte array.
    pub const fn as_bytes(&self) -> &[u8; 10] {
        &self.0
    }

    /// Extract the 64-bit commit version (`u64`).
    pub fn commit_version(&self) -> u64 {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&self.0[0..8]);
        u64::from_be_bytes(buf)
    }

    /// Extract the 16-bit batch order (`u16`).
    pub fn batch_order(&self) -> u16 {
        let mut buf = [0u8; 2];
        buf.copy_from_slice(&self.0[8..10]);
        u16::from_be_bytes(buf)
    }

    /// Encode as 20 lowercase hex characters.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from 20 hex characters.
    pub fn from_hex(hex_str: &str) -> Result<Self, KvError> {
        let decoded = hex::decode(hex_str)
            .map_err(|e| KvError::InvalidArgument(format!("invalid versionstamp hex: {e}")))?;
        Self::try_from_slice(&decoded)
    }

    /// Allocate the next strictly monotonic [`Versionstamp`] given the previous versionstamp
    /// and a candidate wall-clock timestamp `now_ms`.
    pub fn next_monotonic(last: Option<Self>, now_ms: u64, batch_order: u16) -> Self {
        let candidate = Self::new(now_ms, batch_order);
        match last {
            None => candidate,
            Some(prev) if candidate > prev => candidate,
            Some(prev) => {
                let prev_cv = prev.commit_version();
                let prev_bo = prev.batch_order();
                if prev_bo < u16::MAX {
                    Self::new(prev_cv, prev_bo + 1)
                } else {
                    Self::new(prev_cv.saturating_add(1), 0)
                }
            }
        }
    }
}

/// Errors returned by [`RelayKvStore`] operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KvError {
    /// Atomic Compare-And-Swap failed because the stored value did not match `expected`.
    #[error("compare_and_swap conflict")]
    CasConflict {
        /// The current value stored under the key at the time of the failed CAS.
        current: Option<Vec<u8>>,
    },
    /// Invalid key, range, or argument.
    #[error("invalid kv argument: {0}")]
    InvalidArgument(String),
    /// Underlying storage engine error.
    #[error("kv backend error: {0}")]
    Backend(String),
}

/// Atomic operation inside [`RelayKvStore::execute_transaction`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KvTransactionOp {
    /// Unconditional write of `value` at `key`.
    Put {
        /// Target key bytes.
        key: Vec<u8>,
        /// Value bytes to write.
        value: Vec<u8>,
    },
    /// Delete `key`.
    Delete {
        /// Target key bytes to delete.
        key: Vec<u8>,
    },
    /// Compare-and-swap precondition and write within the transaction.
    CheckAndSet {
        /// Target key bytes.
        key: Vec<u8>,
        /// Expected current value (`None` if key must be absent).
        expected: Option<Vec<u8>>,
        /// New value bytes to store when `expected` matches.
        new_value: Vec<u8>,
    },
    /// Write `value` at `key_prefix || versionstamp || key_suffix` using the transaction's
    /// assigned commit version and batch order.
    SetVersionstampedKey {
        /// Prefix bytes preceding the 10-byte [`Versionstamp`].
        key_prefix: Vec<u8>,
        /// Suffix bytes following the 10-byte [`Versionstamp`].
        key_suffix: Vec<u8>,
        /// Value bytes to store at the versionstamped key.
        value: Vec<u8>,
    },
}

/// Storage abstraction decoupling relay state machines from single-node RocksDB.
pub trait RelayKvStore: Send + Sync + Debug {
    /// Point lookup by key.
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError>;

    /// Unconditional write of `value` at `key`.
    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError>;

    /// Delete `key` if present.
    fn delete(&self, key: &[u8]) -> Result<(), KvError>;

    /// Atomic Compare-And-Swap (CAS):
    /// - If `expected` is `None`, succeeds iff `key` does not currently exist.
    /// - If `expected` is `Some(bytes)`, succeeds iff `key` currently holds `bytes`.
    /// Otherwise returns `Err(KvError::CasConflict { current })` without mutating state.
    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError>;

    /// Allocates a strictly monotonic 80-bit [`Versionstamp`] and writes `value` at
    /// `key_prefix || versionstamp.as_bytes() || key_suffix` atomically.
    /// Returns `(full_key, versionstamp)`.
    fn put_versionstamped(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError>;

    /// Forward lexicographical range scan of keys starting with `prefix`.
    /// If `after_key` is `Some(cursor)`, only keys strictly greater than `cursor` (`key > cursor`)
    /// are returned. At most `limit` key-value pairs are returned.
    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after_key: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError>;

    /// Half-open forward lexicographical range scan `[start_inclusive, end_exclusive)`.
    fn scan_range(
        &self,
        start_inclusive: &[u8],
        end_exclusive: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 || start_inclusive >= end_exclusive {
            return Ok(Vec::new());
        }
        let rows = self.scan_prefix_range(&[], None, usize::MAX)?;
        Ok(rows
            .into_iter()
            .filter(|(k, _)| k.as_slice() >= start_inclusive && k.as_slice() < end_exclusive)
            .take(limit)
            .collect())
    }

    /// Execute a multi-operation batch atomically under serializable isolation.
    /// Returns the last [`Versionstamp`] generated by any [`KvTransactionOp::SetVersionstampedKey`]
    /// in `ops`, or `None` if no versionstamped key was written.
    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError>;
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Default)]
struct MemoryState {
    map: BTreeMap<Vec<u8>, Vec<u8>>,
    last_vs: Option<Versionstamp>,
}

impl MemoryState {
    fn apply_transaction(
        &mut self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        // 1. Validate all CheckAndSet preconditions before mutating state
        for op in &ops {
            if let KvTransactionOp::CheckAndSet { key, expected, .. } = op {
                let current = self.map.get(key).map(|v| v.as_slice());
                if current != expected.as_deref() {
                    return Err(KvError::CasConflict {
                        current: current.map(|b| b.to_vec()),
                    });
                }
            }
        }

        // 2. Apply mutations atomically
        let base_ms = current_time_ms();
        let mut batch_order = 0u16;
        let mut last_assigned_vs = None;

        for op in ops {
            match op {
                KvTransactionOp::Put { key, value } => {
                    self.map.insert(key, value);
                }
                KvTransactionOp::Delete { key } => {
                    self.map.remove(&key);
                }
                KvTransactionOp::CheckAndSet { key, new_value, .. } => {
                    self.map.insert(key, new_value);
                }
                KvTransactionOp::SetVersionstampedKey {
                    key_prefix,
                    key_suffix,
                    value,
                } => {
                    let vs = Versionstamp::next_monotonic(self.last_vs, base_ms, batch_order);
                    batch_order = batch_order.saturating_add(1);
                    self.last_vs = Some(vs);
                    last_assigned_vs = Some(vs);

                    let param = encode_set_versionstamped_key_param(&key_prefix, &key_suffix)?;
                    let full_key = resolve_set_versionstamped_key_param(&param, vs)?;
                    self.map.insert(full_key, value);
                }
            }
        }

        Ok(last_assigned_vs)
    }
}

/// Deterministic in-memory implementation of [`RelayKvStore`].
#[derive(Debug, Default)]
pub struct MemoryKvStore {
    state: Mutex<MemoryState>,
}

impl MemoryKvStore {
    /// Create a new empty in-memory KV store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl RelayKvStore for MemoryKvStore {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        let guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        Ok(guard.map.get(key).cloned())
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        guard.map.insert(key.to_vec(), value.to_vec());
        Ok(())
    }

    fn delete(&self, key: &[u8]) -> Result<(), KvError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        guard.map.remove(key);
        Ok(())
    }

    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        let current = guard.map.get(key).map(|v| v.as_slice());
        if current != expected {
            return Err(KvError::CasConflict {
                current: current.map(|b| b.to_vec()),
            });
        }
        guard.map.insert(key.to_vec(), new_value.to_vec());
        Ok(())
    }

    fn put_versionstamped(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        let vs = Versionstamp::next_monotonic(guard.last_vs, current_time_ms(), 0);
        guard.last_vs = Some(vs);
        let param = encode_set_versionstamped_key_param(key_prefix, key_suffix)?;
        let full_key = resolve_set_versionstamped_key_param(&param, vs)?;
        guard.map.insert(full_key.clone(), value.to_vec());
        Ok((full_key, vs))
    }

    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after_key: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        let start = match after_key {
            Some(after) if after >= prefix => after.to_vec(),
            _ => prefix.to_vec(),
        };
        let mut out = Vec::new();
        for (k, v) in guard.map.range(start..) {
            if !k.starts_with(prefix) {
                break;
            }
            if let Some(after) = after_key {
                if k.as_slice() <= after {
                    continue;
                }
            }
            out.push((k.clone(), v.clone()));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    fn scan_range(
        &self,
        start_inclusive: &[u8],
        end_exclusive: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 || start_inclusive >= end_exclusive {
            return Ok(Vec::new());
        }
        let guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        let mut out = Vec::new();
        for (k, v) in guard
            .map
            .range(start_inclusive.to_vec()..end_exclusive.to_vec())
        {
            out.push((k.clone(), v.clone()));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| KvError::Backend("lock poisoned".into()))?;
        guard.apply_transaction(ops)
    }
}

/// RocksDB-backed implementation of [`RelayKvStore`].
pub struct RocksDbKvStore {
    db: Arc<rocksdb::DB>,
    write_lock: Mutex<()>,
}

impl Debug for RocksDbKvStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RocksDbKvStore {{ path: {:?} }}", self.db.path())
    }
}

impl RocksDbKvStore {
    /// Open or create a RocksDB key-value store at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, KvError> {
        let mut options = Options::default();
        options.create_if_missing(true);
        let db = rocksdb::DB::open(&options, path.as_ref())
            .map_err(|e| KvError::Backend(e.to_string()))?;
        Ok(Self::new(Arc::new(db)))
    }

    /// Wrap an existing `Arc<rocksdb::DB>` handle as a [`RocksDbKvStore`].
    pub fn new(db: Arc<rocksdb::DB>) -> Self {
        Self {
            db,
            write_lock: Mutex::new(()),
        }
    }

    /// Borrow the underlying `rocksdb::DB` reference.
    pub fn db(&self) -> &rocksdb::DB {
        &self.db
    }

    fn write_synced(&self, batch: WriteBatch) -> Result<(), KvError> {
        let mut opts = WriteOptions::default();
        opts.set_sync(true);
        self.db
            .write_opt(batch, &opts)
            .map_err(|e| KvError::Backend(e.to_string()))
    }

    fn load_last_versionstamp(&self) -> Result<Option<Versionstamp>, KvError> {
        let from_meta = match self
            .db
            .get(META_LAST_VERSIONSTAMP_KEY)
            .map_err(|e| KvError::Backend(e.to_string()))?
        {
            Some(bytes) => Some(Versionstamp::try_from_slice(&bytes)?),
            None => None,
        };
        let from_seq = match self
            .db
            .get(ROCKSDB_VERSIONSTAMP_SEQ_KEY)
            .map_err(|e| KvError::Backend(e.to_string()))?
        {
            Some(bytes) if bytes.len() == 8 => {
                let mut arr = [0u8; 8];
                arr.copy_from_slice(&bytes);
                Some(Versionstamp::new(u64::from_be_bytes(arr), 0))
            }
            Some(bytes) if bytes.len() == 10 => Some(Versionstamp::try_from_slice(&bytes)?),
            _ => None,
        };
        Ok(match (from_meta, from_seq) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        })
    }
}

fn is_reserved_rocksdb_key(key: &[u8]) -> bool {
    key == META_LAST_VERSIONSTAMP_KEY || key == ROCKSDB_VERSIONSTAMP_SEQ_KEY
}

fn prefix_upper_bound(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut upper = prefix.to_vec();
    let last = upper.iter().rposition(|b| *b != u8::MAX)?;
    upper[last] += 1;
    upper.truncate(last + 1);
    Some(upper)
}

impl RelayKvStore for RocksDbKvStore {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        if is_reserved_rocksdb_key(key) {
            return Err(KvError::InvalidArgument("reserved internal key".into()));
        }
        self.db
            .get(key)
            .map_err(|e| KvError::Backend(e.to_string()))
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        if is_reserved_rocksdb_key(key) {
            return Err(KvError::InvalidArgument("reserved internal key".into()));
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| KvError::Backend("write_lock poisoned".into()))?;
        let mut batch = WriteBatch::default();
        batch.put(key, value);
        self.write_synced(batch)
    }

    fn delete(&self, key: &[u8]) -> Result<(), KvError> {
        if is_reserved_rocksdb_key(key) {
            return Err(KvError::InvalidArgument("reserved internal key".into()));
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| KvError::Backend("write_lock poisoned".into()))?;
        let mut batch = WriteBatch::default();
        batch.delete(key);
        self.write_synced(batch)
    }

    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError> {
        if is_reserved_rocksdb_key(key) {
            return Err(KvError::InvalidArgument("reserved internal key".into()));
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| KvError::Backend("write_lock poisoned".into()))?;
        let current = self
            .db
            .get(key)
            .map_err(|e| KvError::Backend(e.to_string()))?;
        if current.as_deref() != expected {
            return Err(KvError::CasConflict { current });
        }
        let mut batch = WriteBatch::default();
        batch.put(key, new_value);
        self.write_synced(batch)
    }

    fn put_versionstamped(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| KvError::Backend("write_lock poisoned".into()))?;
        let prev_vs = self.load_last_versionstamp()?;
        let vs = Versionstamp::next_monotonic(prev_vs, current_time_ms(), 0);
        let param = encode_set_versionstamped_key_param(key_prefix, key_suffix)?;
        let full_key = resolve_set_versionstamped_key_param(&param, vs)?;
        if is_reserved_rocksdb_key(&full_key) {
            return Err(KvError::InvalidArgument("reserved internal key".into()));
        }
        let mut batch = WriteBatch::default();
        batch.put(META_LAST_VERSIONSTAMP_KEY, vs.as_bytes());
        batch.put(
            ROCKSDB_VERSIONSTAMP_SEQ_KEY,
            vs.commit_version().to_be_bytes(),
        );
        batch.put(&full_key, value);
        self.write_synced(batch)?;
        Ok((full_key, vs))
    }

    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after_key: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut read_opts = ReadOptions::default();
        if let Some(upper) = prefix_upper_bound(prefix) {
            read_opts.set_iterate_upper_bound(upper);
        }
        let seek_target = match after_key {
            Some(after) if after >= prefix => after,
            _ => prefix,
        };
        let iter = self.db.iterator_opt(
            IteratorMode::From(seek_target, Direction::Forward),
            read_opts,
        );
        let mut out = Vec::new();
        for item in iter {
            let (k, v) = item.map_err(|e| KvError::Backend(e.to_string()))?;
            if is_reserved_rocksdb_key(&k) {
                continue;
            }
            if !k.starts_with(prefix) {
                break;
            }
            if let Some(after) = after_key {
                if k.as_ref() <= after {
                    continue;
                }
            }
            out.push((k.into_vec(), v.into_vec()));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    fn scan_range(
        &self,
        start_inclusive: &[u8],
        end_exclusive: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 || start_inclusive >= end_exclusive {
            return Ok(Vec::new());
        }
        let mut read_opts = ReadOptions::default();
        read_opts.set_iterate_upper_bound(end_exclusive.to_vec());
        let iter = self.db.iterator_opt(
            IteratorMode::From(start_inclusive, Direction::Forward),
            read_opts,
        );
        let mut out = Vec::new();
        for item in iter {
            let (k, v) = item.map_err(|e| KvError::Backend(e.to_string()))?;
            if is_reserved_rocksdb_key(&k) {
                continue;
            }
            if k.as_ref() >= end_exclusive {
                break;
            }
            out.push((k.into_vec(), v.into_vec()));
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| KvError::Backend("write_lock poisoned".into()))?;

        // Track staged modifications inside the transaction so multiple ops on the same key compose cleanly
        let mut staged: BTreeMap<Vec<u8>, Option<Vec<u8>>> = BTreeMap::new();
        for op in &ops {
            if let KvTransactionOp::CheckAndSet { key, expected, .. } = op {
                if is_reserved_rocksdb_key(key) {
                    return Err(KvError::InvalidArgument("reserved internal key".into()));
                }
                let current = if let Some(staged_val) = staged.get(key) {
                    staged_val.clone()
                } else {
                    self.db
                        .get(key)
                        .map_err(|e| KvError::Backend(e.to_string()))?
                };
                if current.as_deref() != expected.as_deref() {
                    return Err(KvError::CasConflict { current });
                }
            }
        }

        let mut last_vs = self.load_last_versionstamp()?;
        let base_ms = current_time_ms();
        let mut batch_order = 0u16;
        let mut last_assigned_vs = None;
        let mut batch = WriteBatch::default();

        for op in ops {
            match op {
                KvTransactionOp::Put { key, value } => {
                    if is_reserved_rocksdb_key(&key) {
                        return Err(KvError::InvalidArgument("reserved internal key".into()));
                    }
                    batch.put(&key, &value);
                    staged.insert(key, Some(value));
                }
                KvTransactionOp::Delete { key } => {
                    if is_reserved_rocksdb_key(&key) {
                        return Err(KvError::InvalidArgument("reserved internal key".into()));
                    }
                    batch.delete(&key);
                    staged.insert(key, None);
                }
                KvTransactionOp::CheckAndSet { key, new_value, .. } => {
                    batch.put(&key, &new_value);
                    staged.insert(key, Some(new_value));
                }
                KvTransactionOp::SetVersionstampedKey {
                    key_prefix,
                    key_suffix,
                    value,
                } => {
                    let vs = Versionstamp::next_monotonic(last_vs, base_ms, batch_order);
                    batch_order = batch_order.saturating_add(1);
                    last_vs = Some(vs);
                    last_assigned_vs = Some(vs);

                    let param = encode_set_versionstamped_key_param(&key_prefix, &key_suffix)?;
                    let full_key = resolve_set_versionstamped_key_param(&param, vs)?;
                    if is_reserved_rocksdb_key(&full_key) {
                        return Err(KvError::InvalidArgument("reserved internal key".into()));
                    }
                    batch.put(&full_key, &value);
                    staged.insert(full_key, Some(value));
                }
            }
        }

        if let Some(vs) = last_assigned_vs {
            batch.put(META_LAST_VERSIONSTAMP_KEY, vs.as_bytes());
            batch.put(
                ROCKSDB_VERSIONSTAMP_SEQ_KEY,
                vs.commit_version().to_be_bytes(),
            );
        }

        self.write_synced(batch)?;
        Ok(last_assigned_vs)
    }
}

/// Encode a FoundationDB `SET_VERSIONSTAMPED_KEY` mutation parameter buffer (FDB API version >= 520).
///
/// Layout: `key_prefix || [0x00; 10] (incomplete versionstamp placeholder) || key_suffix || (offset as u32).to_le_bytes()`
/// where `offset` is the 0-based byte index where the 10-byte [`Versionstamp`] will be stamped at commit time.
pub fn encode_set_versionstamped_key_param(
    key_prefix: &[u8],
    key_suffix: &[u8],
) -> Result<Vec<u8>, KvError> {
    let offset = u32::try_from(key_prefix.len())
        .map_err(|_| KvError::InvalidArgument("FDB key_prefix exceeds u32::MAX".into()))?;
    let mut param = Vec::with_capacity(key_prefix.len() + 10 + key_suffix.len() + 4);
    param.extend_from_slice(key_prefix);
    param.extend_from_slice(&[0u8; 10]);
    param.extend_from_slice(key_suffix);
    param.extend_from_slice(&offset.to_le_bytes());
    Ok(param)
}

/// Resolve a FoundationDB `SET_VERSIONSTAMPED_KEY` parameter buffer by stamping `versionstamp`
/// at the 4-byte little-endian offset trailer and stripping the 4-byte trailer.
pub fn resolve_set_versionstamped_key_param(
    param: &[u8],
    versionstamp: Versionstamp,
) -> Result<Vec<u8>, KvError> {
    if param.len() < 14 {
        return Err(KvError::InvalidArgument(format!(
            "FDB SET_VERSIONSTAMPED_KEY buffer must be at least 14 bytes, got {}",
            param.len()
        )));
    }
    let key_len = param.len() - 4;
    let mut offset_bytes = [0u8; 4];
    offset_bytes.copy_from_slice(&param[key_len..]);
    let offset = u32::from_le_bytes(offset_bytes) as usize;
    if offset + 10 > key_len {
        return Err(KvError::InvalidArgument(format!(
            "FDB SET_VERSIONSTAMPED_KEY offset {offset} + 10 exceeds key length {key_len}"
        )));
    }
    let mut resolved = param[..key_len].to_vec();
    resolved[offset..offset + 10].copy_from_slice(versionstamp.as_bytes());
    Ok(resolved)
}

/// Pluggable FoundationDB cluster transaction driver trait.
///
/// Allows [`FoundationDbKvStore`] to run against either a deterministic multi-replica
/// [`SimulatedFdbCluster`] (for macOS/Linux CI without native `libfdb_c`) or a live FDB C API driver.
pub trait FdbTransactionDriver: RelayKvStore {}

impl<T: RelayKvStore + ?Sized> FdbTransactionDriver for T {}

/// Shared serializable FoundationDB cluster simulator supporting concurrent multi-replica
/// [`FoundationDbKvStore`] instances, strict 80-bit commit versionstamps, and conflict-range CAS.
#[derive(Debug, Default)]
pub struct SimulatedFdbCluster {
    inner: MemoryKvStore,
}

impl SimulatedFdbCluster {
    /// Create a new shared FoundationDB cluster simulator.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: MemoryKvStore::new(),
        })
    }
}

impl RelayKvStore for SimulatedFdbCluster {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.inner.get(key)
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        self.inner.put(key, value)
    }

    fn delete(&self, key: &[u8]) -> Result<(), KvError> {
        self.inner.delete(key)
    }

    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError> {
        self.inner.compare_and_swap(key, expected, new_value)
    }

    fn put_versionstamped(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        self.inner.put_versionstamped(key_prefix, key_suffix, value)
    }

    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after_key: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        self.inner.scan_prefix_range(prefix, after_key, limit)
    }

    fn scan_range(
        &self,
        start_inclusive: &[u8],
        end_exclusive: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        self.inner.scan_range(start_inclusive, end_exclusive, limit)
    }

    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        self.inner.execute_transaction(ops)
    }
}

/// FoundationDB subspace adapter implementing [`RelayKvStore`].
///
/// Maps all logical keys (`'I'`, `'G'`, `'G_meta'`, `'M_vapid_privkey'`) into a tenant/cluster
/// subspace prefix (`subspace_prefix || key`) and delegates transactional CAS,
/// `SET_VERSIONSTAMPED_KEY`, and forward range reads to the configured cluster engine.
#[derive(Debug, Clone)]
pub struct FoundationDbKvStore {
    cluster_file: PathBuf,
    subspace_prefix: Vec<u8>,
    backend: Arc<dyn RelayKvStore>,
}

impl FoundationDbKvStore {
    /// Create a FoundationDB subspace store bound to `cluster_file` and `subspace_prefix`.
    pub fn new(
        cluster_file: impl Into<PathBuf>,
        subspace_prefix: impl Into<Vec<u8>>,
        backend: Arc<dyn RelayKvStore>,
    ) -> Self {
        Self {
            cluster_file: cluster_file.into(),
            subspace_prefix: subspace_prefix.into(),
            backend,
        }
    }

    /// Connect a FoundationDB subspace store to a shared [`SimulatedFdbCluster`].
    pub fn connect_simulated(
        cluster_file: impl Into<PathBuf>,
        subspace_prefix: impl Into<Vec<u8>>,
        cluster: Arc<SimulatedFdbCluster>,
    ) -> Self {
        Self::new(cluster_file, subspace_prefix, cluster)
    }

    /// Path to the `fdb.cluster` configuration file.
    pub fn cluster_file(&self) -> &Path {
        &self.cluster_file
    }

    /// Configured FDB tuple subspace prefix.
    pub fn subspace_prefix(&self) -> &[u8] {
        &self.subspace_prefix
    }

    /// Encode a logical key into the configured FDB subspace (`subspace_prefix || key`).
    pub fn scoped_key(&self, key: &[u8]) -> Vec<u8> {
        let mut full = Vec::with_capacity(self.subspace_prefix.len() + key.len());
        full.extend_from_slice(&self.subspace_prefix);
        full.extend_from_slice(key);
        full
    }

    /// Build the raw FoundationDB `SET_VERSIONSTAMPED_KEY` mutation parameter for a logical
    /// `key_prefix` and `key_suffix` inside this store's subspace.
    pub fn encode_versionstamped_key_param(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
    ) -> Result<Vec<u8>, KvError> {
        let scoped_prefix = self.scoped_key(key_prefix);
        encode_set_versionstamped_key_param(&scoped_prefix, key_suffix)
    }

    fn strip_subspace(&self, key: &[u8]) -> Result<Vec<u8>, KvError> {
        key.strip_prefix(self.subspace_prefix.as_slice())
            .map(|s| s.to_vec())
            .ok_or_else(|| KvError::Backend("corrupted FDB subspace prefix".into()))
    }
}

impl RelayKvStore for FoundationDbKvStore {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.backend.get(&self.scoped_key(key))
    }

    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        self.backend.put(&self.scoped_key(key), value)
    }

    fn delete(&self, key: &[u8]) -> Result<(), KvError> {
        self.backend.delete(&self.scoped_key(key))
    }

    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError> {
        self.backend
            .compare_and_swap(&self.scoped_key(key), expected, new_value)
    }

    fn put_versionstamped(
        &self,
        key_prefix: &[u8],
        key_suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        let scoped_prefix = self.scoped_key(key_prefix);
        let (full_scoped_key, vs) =
            self.backend
                .put_versionstamped(&scoped_prefix, key_suffix, value)?;
        let logical_key = self.strip_subspace(&full_scoped_key)?;
        Ok((logical_key, vs))
    }

    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after_key: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        let scoped_prefix = self.scoped_key(prefix);
        let scoped_after = after_key.map(|k| self.scoped_key(k));
        let rows =
            self.backend
                .scan_prefix_range(&scoped_prefix, scoped_after.as_deref(), limit)?;
        let mut out = Vec::with_capacity(rows.len());
        for (k, v) in rows {
            out.push((self.strip_subspace(&k)?, v));
        }
        Ok(out)
    }

    fn scan_range(
        &self,
        start_inclusive: &[u8],
        end_exclusive: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        let scoped_start = self.scoped_key(start_inclusive);
        let scoped_end = self.scoped_key(end_exclusive);
        let rows = self.backend.scan_range(&scoped_start, &scoped_end, limit)?;
        let mut out = Vec::with_capacity(rows.len());
        for (k, v) in rows {
            out.push((self.strip_subspace(&k)?, v));
        }
        Ok(out)
    }

    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        let scoped_ops = ops
            .into_iter()
            .map(|op| match op {
                KvTransactionOp::Put { key, value } => KvTransactionOp::Put {
                    key: self.scoped_key(&key),
                    value,
                },
                KvTransactionOp::Delete { key } => KvTransactionOp::Delete {
                    key: self.scoped_key(&key),
                },
                KvTransactionOp::CheckAndSet {
                    key,
                    expected,
                    new_value,
                } => KvTransactionOp::CheckAndSet {
                    key: self.scoped_key(&key),
                    expected,
                    new_value,
                },
                KvTransactionOp::SetVersionstampedKey {
                    key_prefix,
                    key_suffix,
                    value,
                } => KvTransactionOp::SetVersionstampedKey {
                    key_prefix: self.scoped_key(&key_prefix),
                    key_suffix,
                    value,
                },
            })
            .collect();
        self.backend.execute_transaction(scoped_ops)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn verify_kv_contract(store: &dyn RelayKvStore) {
        // 1. Basic get / put / delete
        assert_eq!(store.get(b"I:alice:1").unwrap(), None);
        store.put(b"I:alice:1", b"msg1").unwrap();
        assert_eq!(store.get(b"I:alice:1").unwrap(), Some(b"msg1".to_vec()));
        store.delete(b"I:alice:1").unwrap();
        assert_eq!(store.get(b"I:alice:1").unwrap(), None);

        // 2. Atomic Compare-And-Swap (CAS) for group epochs & usernames
        let meta_key = b"G_meta:group_01";
        store.compare_and_swap(meta_key, None, b"epoch_0").unwrap();
        let err = store
            .compare_and_swap(meta_key, None, b"epoch_0_competing")
            .unwrap_err();
        assert_eq!(
            err,
            KvError::CasConflict {
                current: Some(b"epoch_0".to_vec())
            }
        );
        store
            .compare_and_swap(meta_key, Some(b"epoch_0"), b"epoch_1")
            .unwrap();
        let stale_err = store
            .compare_and_swap(meta_key, Some(b"epoch_0"), b"epoch_2")
            .unwrap_err();
        assert_eq!(
            stale_err,
            KvError::CasConflict {
                current: Some(b"epoch_1".to_vec())
            }
        );

        // 3. Strictly monotonic 80-bit Versionstamps + scan_prefix_range + scan_range
        let mut stamps = Vec::new();
        let mut keys = Vec::new();
        for i in 0..5u8 {
            let suffix = [i; 4];
            let payload = vec![b'v', i];
            let (full_key, vs) = store
                .put_versionstamped(b"G:grpA:", &suffix, &payload)
                .unwrap();
            if let Some(prev) = stamps.last() {
                assert!(vs > *prev, "versionstamp must be strictly monotonic");
            }
            stamps.push(vs);
            keys.push(full_key);
        }

        let all = store.scan_prefix_range(b"G:grpA:", None, 10).unwrap();
        assert_eq!(all.len(), 5);
        for i in 0..5 {
            assert_eq!(all[i].0, keys[i]);
            assert_eq!(all[i].1, vec![b'v', i as u8]);
        }

        // Half-open range scan [keys[1], keys[4])
        let slice = store.scan_range(&keys[1], &keys[4], 10).unwrap();
        assert_eq!(slice.len(), 3);
        assert_eq!(slice[0].0, keys[1]);
        assert_eq!(slice[2].0, keys[3]);

        // Paginated scan with `after_key` and `limit`
        let page1 = store.scan_prefix_range(b"G:grpA:", None, 2).unwrap();
        assert_eq!(page1.len(), 2);
        let page2 = store
            .scan_prefix_range(b"G:grpA:", Some(&page1[1].0), 2)
            .unwrap();
        assert_eq!(page2.len(), 2);
        assert_eq!(page2[0].0, keys[2]);
        assert_eq!(page2[1].0, keys[3]);
        let page3 = store
            .scan_prefix_range(b"G:grpA:", Some(&page2[1].0), 2)
            .unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(page3[0].0, keys[4]);

        // 4. Atomic multi-op transaction (`execute_transaction`)
        let tx_vs = store
            .execute_transaction(vec![
                KvTransactionOp::CheckAndSet {
                    key: meta_key.to_vec(),
                    expected: Some(b"epoch_1".to_vec()),
                    new_value: b"epoch_2".to_vec(),
                },
                KvTransactionOp::SetVersionstampedKey {
                    key_prefix: b"G:grpA:".to_vec(),
                    key_suffix: b":commit".to_vec(),
                    value: b"epoch_2_commit_envelope".to_vec(),
                },
            ])
            .unwrap()
            .expect("SetVersionstampedKey returns assigned Versionstamp");
        assert!(tx_vs > *stamps.last().unwrap());
        assert_eq!(store.get(meta_key).unwrap(), Some(b"epoch_2".to_vec()));
    }

    #[test]
    fn memory_kv_store_satisfies_contract() {
        let store = MemoryKvStore::new();
        verify_kv_contract(&store);
    }

    #[test]
    fn rocksdb_kv_store_satisfies_contract_and_persists_versionstamp_monotonicity() {
        let dir = tempdir::TempDir::new("relay-kv-rocksdb").unwrap();
        let path = dir.path().join("kv.rocksdb");
        let last_vs_before_reopen = {
            let store = RocksDbKvStore::open(&path).unwrap();
            verify_kv_contract(&store);
            // Simulate a future clock jump by persisting a high commit version in M_kv_versionstamp_seq
            let future_cv = current_time_ms() + 1_000_000;
            store
                .db()
                .put(ROCKSDB_VERSIONSTAMP_SEQ_KEY, future_cv.to_be_bytes())
                .unwrap();
            let (_, vs) = store
                .put_versionstamped(b"G:reopen:", b"s", b"val")
                .unwrap();
            assert!(vs.commit_version() >= future_cv);
            vs
        };
        let reopened = RocksDbKvStore::open(&path).unwrap();
        let (_, vs_after) = reopened
            .put_versionstamped(b"G:reopen:", b"s2", b"val2")
            .unwrap();
        assert!(
            vs_after > last_vs_before_reopen,
            "reopened RocksDbKvStore must never issue a backwards Versionstamp"
        );
    }

    #[test]
    fn foundationdb_set_versionstamped_key_trailer_encoding() {
        let cluster = SimulatedFdbCluster::new();
        let fdb = FoundationDbKvStore::connect_simulated(
            "/etc/foundationdb/fdb.cluster",
            b"frank_prod:",
            cluster,
        );
        let param = fdb
            .encode_versionstamped_key_param(b"G:group42:", b":msghash")
            .unwrap();
        let expected_offset = (b"frank_prod:".len() + b"G:group42:".len()) as u32;
        assert_eq!(
            &param[param.len() - 4..],
            &expected_offset.to_le_bytes(),
            "FDB SET_VERSIONSTAMPED_KEY trailer must encode 4-byte LE versionstamp offset"
        );
        let vs = Versionstamp::new(0x0102_0304_0506_0708, 0x0009);
        let resolved = resolve_set_versionstamped_key_param(&param, vs).unwrap();
        assert_eq!(
            &resolved[expected_offset as usize..expected_offset as usize + 10],
            vs.as_bytes()
        );
        assert!(resolved.starts_with(b"frank_prod:G:group42:"));
        assert!(resolved.ends_with(b":msghash"));
    }

    #[test]
    fn foundationdb_kv_store_subspace_isolation_and_multi_replica_cas() {
        let cluster = SimulatedFdbCluster::new();
        let fdb_a = FoundationDbKvStore::connect_simulated(
            "/etc/foundationdb/fdb.cluster",
            b"tenant_a:",
            cluster.clone(),
        );
        let fdb_b = FoundationDbKvStore::connect_simulated(
            "/etc/foundationdb/fdb.cluster",
            b"tenant_b:",
            cluster.clone(),
        );

        verify_kv_contract(&fdb_a);
        assert_eq!(
            fdb_b.scan_prefix_range(b"G:grpA:", None, 10).unwrap().len(),
            0
        );
        verify_kv_contract(&fdb_b);

        // Spawn 10 concurrent stateless relay replicas sharing the same FDB cluster & subspace
        // racing to advance group epoch 0 -> 1 via compare_and_swap.
        fdb_a.put(b"G_meta:shared_group", b"epoch_0").unwrap();
        let mut handles = Vec::new();
        for replica_id in 0..10u8 {
            let replica_store = FoundationDbKvStore::connect_simulated(
                "/etc/foundationdb/fdb.cluster",
                b"tenant_a:",
                cluster.clone(),
            );
            handles.push(thread::spawn(move || {
                let candidate = format!("epoch_1_from_replica_{replica_id}");
                replica_store.compare_and_swap(
                    b"G_meta:shared_group",
                    Some(b"epoch_0"),
                    candidate.as_bytes(),
                )
            }));
        }

        let mut successes = 0;
        let mut conflicts = 0;
        for h in handles {
            match h.join().unwrap() {
                Ok(()) => successes += 1,
                Err(KvError::CasConflict { current }) => {
                    assert!(current.is_some());
                    conflicts += 1;
                }
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }
        assert_eq!(
            successes, 1,
            "exactly 1 of 10 concurrent FDB replicas must win the epoch CAS"
        );
        assert_eq!(conflicts, 9);
    }
}
