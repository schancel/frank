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

/// Subspace prefix for signed directory entries (`'D'`).
pub const SUBSPACE_DIRECTORY: &[u8] = b"D";
/// Subspace prefix for globally unique username claims (`'U'`, Issue #981).
pub const SUBSPACE_USERNAMES: &[u8] = b"U";
/// Subspace prefix for reverse address-to-username index (`'U_addr'`, Issue #981).
pub const SUBSPACE_USERNAME_BY_ADDR: &[u8] = b"U_addr";
/// Subspace prefix for multi-chain stamp/burn payment deduplication (`'P'`).
pub const SUBSPACE_PAYMENT_DEDUP: &[u8] = b"P";
/// Subspace prefix for direct-message inboxes (`'I'`).
pub const SUBSPACE_INBOX: &[u8] = b"I";
/// Subspace prefix for recipient message payload digest index (`'M'`).
pub const SUBSPACE_MSG_DIGEST: &[u8] = b"M";
/// Subspace prefix for shared group message mailboxes (`'G'`).
pub const SUBSPACE_GROUP_MESSAGES: &[u8] = b"G";
/// Subspace prefix for group epoch metadata heads (`'G_meta'`).
pub const SUBSPACE_GROUP_META: &[u8] = b"G_meta";
/// Subspace prefix for monotonic multi-device sync journal events (`'J'`).
pub const SUBSPACE_SYNC_JOURNAL: &[u8] = b"J";

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

// ============================================================================
// Canonical Tuple Subspace Codecs & Atomic Multi-Key Domain Workflows (#1575)
// ============================================================================

/// Encode a Directory (`'D'`) key: `b"D:" || address_20_bytes`.
pub fn encode_directory_key(address: &[u8; 20]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_DIRECTORY.len() + 1 + 20);
    k.extend_from_slice(SUBSPACE_DIRECTORY);
    k.push(b':');
    k.extend_from_slice(address);
    k
}

/// Decode a Directory (`'D'`) key back into a 20-byte address.
pub fn decode_directory_key(key: &[u8]) -> Result<[u8; 20], KvError> {
    let rest = key
        .strip_prefix(b"D:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'D:' subspace prefix".into()))?;
    rest.try_into()
        .map_err(|_| KvError::InvalidArgument("directory key address must be 20 bytes".into()))
}

/// Encode a Username (`'U'`) key: `b"U:" || normalized_handle_utf8`.
pub fn encode_username_key(normalized_handle: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_USERNAMES.len() + 1 + normalized_handle.len());
    k.extend_from_slice(SUBSPACE_USERNAMES);
    k.push(b':');
    k.extend_from_slice(normalized_handle.as_bytes());
    k
}

/// Decode a Username (`'U'`) key back into its normalized handle string.
pub fn decode_username_key(key: &[u8]) -> Result<String, KvError> {
    let rest = key
        .strip_prefix(b"U:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'U:' subspace prefix".into()))?;
    String::from_utf8(rest.to_vec())
        .map_err(|e| KvError::InvalidArgument(format!("invalid UTF-8 in username key: {e}")))
}

/// Encode a reverse address-to-username (`'U_addr'`) key: `b"U_addr:" || address_20_bytes`.
pub fn encode_username_addr_key(address: &[u8; 20]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_USERNAME_BY_ADDR.len() + 1 + 20);
    k.extend_from_slice(SUBSPACE_USERNAME_BY_ADDR);
    k.push(b':');
    k.extend_from_slice(address);
    k
}

/// Decode a reverse address-to-username (`'U_addr'`) key into a 20-byte address.
pub fn decode_username_addr_key(key: &[u8]) -> Result<[u8; 20], KvError> {
    let rest = key
        .strip_prefix(b"U_addr:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'U_addr:' subspace prefix".into()))?;
    rest.try_into()
        .map_err(|_| KvError::InvalidArgument("username addr key must be 20 bytes".into()))
}

/// Encode a Payment Deduplication (`'P'`) key: `b"P:" || chain_id_be8 || b":" || tx_hash_32`.
pub fn encode_payment_dedup_key(chain_id: u64, tx_hash: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_PAYMENT_DEDUP.len() + 1 + 8 + 1 + 32);
    k.extend_from_slice(SUBSPACE_PAYMENT_DEDUP);
    k.push(b':');
    k.extend_from_slice(&chain_id.to_be_bytes());
    k.push(b':');
    k.extend_from_slice(tx_hash);
    k
}

/// Decode a Payment Deduplication (`'P'`) key into `(chain_id, tx_hash)`.
pub fn decode_payment_dedup_key(key: &[u8]) -> Result<(u64, [u8; 32]), KvError> {
    let rest = key
        .strip_prefix(b"P:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'P:' subspace prefix".into()))?;
    if rest.len() != 8 + 1 + 32 || rest[8] != b':' {
        return Err(KvError::InvalidArgument("malformed 'P:' payment key".into()));
    }
    let mut chain_bytes = [0u8; 8];
    chain_bytes.copy_from_slice(&rest[0..8]);
    let mut tx_hash = [0u8; 32];
    tx_hash.copy_from_slice(&rest[9..41]);
    Ok((u64::from_be_bytes(chain_bytes), tx_hash))
}

/// Encode a recipient Inbox (`'I'`) prefix: `b"I:" || recipient_20 || b":"`.
pub fn encode_inbox_prefix(recipient: &[u8; 20]) -> Vec<u8> {
    let mut p = Vec::with_capacity(SUBSPACE_INBOX.len() + 1 + 20 + 1);
    p.extend_from_slice(SUBSPACE_INBOX);
    p.push(b':');
    p.extend_from_slice(recipient);
    p.push(b':');
    p
}

/// Encode a full recipient Inbox (`'I'`) key: `b"I:" || recipient_20 || b":" || versionstamp_10 || payload_digest_32`.
pub fn encode_inbox_key(
    recipient: &[u8; 20],
    versionstamp: Versionstamp,
    payload_digest: &[u8; 32],
) -> Vec<u8> {
    let mut k = encode_inbox_prefix(recipient);
    k.extend_from_slice(versionstamp.as_bytes());
    k.extend_from_slice(payload_digest);
    k
}

/// Decode a full recipient Inbox (`'I'`) key into `(recipient_address, versionstamp, payload_digest)`.
pub fn decode_inbox_key(key: &[u8]) -> Result<([u8; 20], Versionstamp, [u8; 32]), KvError> {
    let rest = key
        .strip_prefix(b"I:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'I:' subspace prefix".into()))?;
    if rest.len() != 20 + 1 + 10 + 32 || rest[20] != b':' {
        return Err(KvError::InvalidArgument("malformed 'I:' inbox key".into()));
    }
    let mut recipient = [0u8; 20];
    recipient.copy_from_slice(&rest[0..20]);
    let vs = Versionstamp::try_from_slice(&rest[21..31])?;
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&rest[31..63]);
    Ok((recipient, vs, digest))
}

/// Encode a Message Digest Index (`'M'`) key: `b"M:" || recipient_20 || b":" || payload_digest_32`.
pub fn encode_msg_digest_key(recipient: &[u8; 20], payload_digest: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_MSG_DIGEST.len() + 1 + 20 + 1 + 32);
    k.extend_from_slice(SUBSPACE_MSG_DIGEST);
    k.push(b':');
    k.extend_from_slice(recipient);
    k.push(b':');
    k.extend_from_slice(payload_digest);
    k
}

/// Decode a Message Digest Index (`'M'`) key into `(recipient_address, payload_digest)`.
pub fn decode_msg_digest_key(key: &[u8]) -> Result<([u8; 20], [u8; 32]), KvError> {
    let rest = key
        .strip_prefix(b"M:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'M:' subspace prefix".into()))?;
    if rest.len() != 20 + 1 + 32 || rest[20] != b':' {
        return Err(KvError::InvalidArgument("malformed 'M:' digest key".into()));
    }
    let mut recipient = [0u8; 20];
    recipient.copy_from_slice(&rest[0..20]);
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&rest[21..53]);
    Ok((recipient, digest))
}

/// Encode a Group Epoch Metadata (`'G_meta'`) key: `b"G_meta:" || group_id_32`.
pub fn encode_group_meta_key(group_id: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_GROUP_META.len() + 1 + 32);
    k.extend_from_slice(SUBSPACE_GROUP_META);
    k.push(b':');
    k.extend_from_slice(group_id);
    k
}

/// Decode a Group Epoch Metadata (`'G_meta'`) key into `group_id`.
pub fn decode_group_meta_key(key: &[u8]) -> Result<[u8; 32], KvError> {
    let rest = key
        .strip_prefix(b"G_meta:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'G_meta:' subspace prefix".into()))?;
    rest.try_into()
        .map_err(|_| KvError::InvalidArgument("group_id must be 32 bytes".into()))
}

/// Encode a Group Messages (`'G'`) prefix: `b"G:" || group_id_32 || b":"`.
pub fn encode_group_message_prefix(group_id: &[u8; 32]) -> Vec<u8> {
    let mut p = Vec::with_capacity(SUBSPACE_GROUP_MESSAGES.len() + 1 + 32 + 1);
    p.extend_from_slice(SUBSPACE_GROUP_MESSAGES);
    p.push(b':');
    p.extend_from_slice(group_id);
    p.push(b':');
    p
}

/// Decode a Group Message (`'G'`) key into `(group_id, versionstamp, msg_hash)`.
pub fn decode_group_message_key(key: &[u8]) -> Result<([u8; 32], Versionstamp, [u8; 32]), KvError> {
    let rest = key
        .strip_prefix(b"G:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'G:' subspace prefix".into()))?;
    if rest.len() != 32 + 1 + 10 + 32 || rest[32] != b':' {
        return Err(KvError::InvalidArgument(
            "malformed 'G:' group message key".into(),
        ));
    }
    let mut group_id = [0u8; 32];
    group_id.copy_from_slice(&rest[0..32]);
    let vs = Versionstamp::try_from_slice(&rest[33..43])?;
    let mut msg_hash = [0u8; 32];
    msg_hash.copy_from_slice(&rest[43..75]);
    Ok((group_id, vs, msg_hash))
}

/// Encode a Sync Journal (`'J'`) prefix: `b"J:" || recipient_20 || b":"`.
pub fn encode_sync_journal_prefix(recipient: &[u8; 20]) -> Vec<u8> {
    let mut p = Vec::with_capacity(SUBSPACE_SYNC_JOURNAL.len() + 1 + 20 + 1);
    p.extend_from_slice(SUBSPACE_SYNC_JOURNAL);
    p.push(b':');
    p.extend_from_slice(recipient);
    p.push(b':');
    p
}

/// Encode a Sync Journal (`'J'`) key: `b"J:" || recipient_20 || b":" || versionstamp_10`.
pub fn encode_sync_journal_key(recipient: &[u8; 20], versionstamp: Versionstamp) -> Vec<u8> {
    let mut k = encode_sync_journal_prefix(recipient);
    k.extend_from_slice(versionstamp.as_bytes());
    k
}

/// Decode a Sync Journal (`'J'`) key into `(recipient_address, versionstamp)`.
pub fn decode_sync_journal_key(key: &[u8]) -> Result<([u8; 20], Versionstamp), KvError> {
    let rest = key
        .strip_prefix(b"J:")
        .ok_or_else(|| KvError::InvalidArgument("missing 'J:' subspace prefix".into()))?;
    if rest.len() != 20 + 1 + 10 || rest[20] != b':' {
        return Err(KvError::InvalidArgument(
            "malformed 'J:' sync journal key".into(),
        ));
    }
    let mut recipient = [0u8; 20];
    recipient.copy_from_slice(&rest[0..20]);
    let vs = Versionstamp::try_from_slice(&rest[21..31])?;
    Ok((recipient, vs))
}

/// Signed directory record stored in the `'D'` subspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvDirectoryRecord {
    /// 20-byte account address.
    pub address: [u8; 20],
    /// Strictly increasing directory revision number.
    pub revision: u64,
    /// Raw signed CBOR directory statement bytes.
    pub statement_cbor: Vec<u8>,
    ///Unix timestamp (ms) when stored.
    pub updated_at_ms: u64,
}

/// Atomically store `record` in `'D'` iff `record.revision > current.revision` (or no entry exists).
pub fn put_directory_entry_cas(
    store: &dyn RelayKvStore,
    record: &KvDirectoryRecord,
) -> Result<(), KvError> {
    let key = encode_directory_key(&record.address);
    let current_raw = store.get(&key)?;
    if let Some(ref bytes) = current_raw {
        let current: KvDirectoryRecord = serde_json::from_slice(bytes)
            .map_err(|e| KvError::Backend(format!("corrupt directory record: {e}")))?;
        if record.revision <= current.revision {
            return Err(KvError::CasConflict {
                current: current_raw,
            });
        }
    }
    let new_bytes = serde_json::to_vec(record)
        .map_err(|e| KvError::Backend(format!("serialize directory record: {e}")))?;
    store.compare_and_swap(&key, current_raw.as_deref(), &new_bytes)
}

/// Load a signed directory record from `'D'`.
pub fn get_directory_entry(
    store: &dyn RelayKvStore,
    address: &[u8; 20],
) -> Result<Option<KvDirectoryRecord>, KvError> {
    let key = encode_directory_key(address);
    let Some(bytes) = store.get(&key)? else {
        return Ok(None);
    };
    let rec = serde_json::from_slice(&bytes)
        .map_err(|e| KvError::Backend(format!("corrupt directory record: {e}")))?;
    Ok(Some(rec))
}

/// Username claim record stored in `'U'` (`b"U:<normalized_handle>"`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvUsernameRecord {
    /// Canonical lowercase handle (`^[a-z0-9][a-z0-9_-]{2,31}$`).
    pub normalized_handle: String,
    /// 20-byte owner address.
    pub owner_address: [u8; 20],
    /// 33-byte compressed secp256k1 owner public key (hex-encoded for serde).
    pub owner_pubkey_hex: String,
    /// Monotonic claim revision.
    pub revision: u64,
    /// Timestamp (ms) when claimed.
    pub claimed_at_ms: u64,
    /// If `Some(until_ms)`, this handle was released via username rotation and is in its
    /// cooling tombstone period until `now_ms >= until_ms`.
    pub released_until_ms: Option<u64>,
    /// Signature bytes over the username claim statement.
    pub statement_sig: Vec<u8>,
}

/// Parameters for an atomic username claim in `'U'` + `'U_addr'`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KvUsernameClaimRequest {
    /// Requested handle (will be normalized and validated).
    pub handle: String,
    /// 20-byte owner address.
    pub owner_address: [u8; 20],
    /// 33-byte compressed secp256k1 owner public key.
    pub owner_pubkey: [u8; 33],
    /// Claim revision (must be strictly greater than any previous revision by the same owner,
    /// or equal for idempotent replay).
    pub revision: u64,
    /// Current wall-clock timestamp (ms).
    pub now_ms: u64,
    /// Cooling period (ms) applied to the old handle when rotating usernames.
    pub cooling_ttl_ms: u64,
    /// Signed statement signature bytes.
    pub statement_sig: Vec<u8>,
}

/// Normalize and validate a username handle (`^[a-z0-9][a-z0-9_-]{2,31}$`).
pub fn normalize_username_handle(handle: &str) -> Result<String, KvError> {
    let trimmed = handle.trim().trim_start_matches('@').to_ascii_lowercase();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 || bytes.len() > 32 {
        return Err(KvError::InvalidArgument(
            "username handle must be 3..=32 characters".into(),
        ));
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return Err(KvError::InvalidArgument(
            "username handle must start with [a-z0-9]".into(),
        ));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
    {
        return Err(KvError::InvalidArgument(
            "username handle may only contain [a-z0-9_-]".into(),
        ));
    }
    Ok(trimmed)
}

/// Atomically claim or rotate a username in `'U'` and `'U_addr'` inside a single serializable
/// [`RelayKvStore::execute_transaction`] (`#981` & `#1575` §3.2):
/// - First-claim-wins across all cluster replicas.
/// - Same-holder repeat with the same revision is idempotent.
/// - Same-holder rotation to a new handle atomically releases the old handle into a cooling
///   tombstone (`released_until_ms = Some(now_ms + cooling_ttl_ms)`).
/// - Stale claims (`revision < current_revision`) are rejected with `KvError::CasConflict`.
pub fn claim_username_kv(
    store: &dyn RelayKvStore,
    req: &KvUsernameClaimRequest,
) -> Result<KvUsernameRecord, KvError> {
    let normalized = normalize_username_handle(&req.handle)?;
    let u_key = encode_username_key(&normalized);
    let addr_key = encode_username_addr_key(&req.owner_address);

    let cur_u_raw = store.get(&u_key)?;
    let cur_addr_raw = store.get(&addr_key)?;

    if let Some(ref raw) = cur_u_raw {
        let cur: KvUsernameRecord = serde_json::from_slice(raw)
            .map_err(|e| KvError::Backend(format!("corrupt username record: {e}")))?;
        let is_expired_tombstone = cur
            .released_until_ms
            .is_some_and(|until_ms| req.now_ms >= until_ms);

        if !is_expired_tombstone {
            if cur.owner_address != req.owner_address {
                // Active owner or still inside cooling tombstone window
                return Err(KvError::CasConflict {
                    current: cur_u_raw,
                });
            }
            // Owned by the same address
            if cur.released_until_ms.is_none() {
                if req.revision < cur.revision {
                    return Err(KvError::CasConflict {
                        current: cur_u_raw,
                    });
                }
                if req.revision == cur.revision {
                    return Ok(cur);
                }
            }
        }
    }

    let mut ops = Vec::with_capacity(3);

    // Check if the caller currently holds a different active handle and needs atomic rotation
    if let Some(ref prev_handle_bytes) = cur_addr_raw {
        let prev_handle = String::from_utf8(prev_handle_bytes.clone())
            .map_err(|e| KvError::Backend(format!("corrupt U_addr handle: {e}")))?;
        if prev_handle != normalized {
            let old_u_key = encode_username_key(&prev_handle);
            let old_u_raw = store.get(&old_u_key)?;
            if let Some(ref old_bytes) = old_u_raw {
                let mut old_rec: KvUsernameRecord = serde_json::from_slice(old_bytes)
                    .map_err(|e| KvError::Backend(format!("corrupt old username record: {e}")))?;
                if old_rec.owner_address == req.owner_address && old_rec.released_until_ms.is_none()
                {
                    if req.revision <= old_rec.revision {
                        return Err(KvError::CasConflict {
                            current: old_u_raw,
                        });
                    }
                    old_rec.released_until_ms =
                        Some(req.now_ms.saturating_add(req.cooling_ttl_ms));
                    let tombstoned_bytes = serde_json::to_vec(&old_rec)
                        .map_err(|e| KvError::Backend(format!("serialize old username: {e}")))?;
                    ops.push(KvTransactionOp::CheckAndSet {
                        key: old_u_key,
                        expected: old_u_raw,
                        new_value: tombstoned_bytes,
                    });
                }
            }
        }
    }

    let new_record = KvUsernameRecord {
        normalized_handle: normalized.clone(),
        owner_address: req.owner_address,
        owner_pubkey_hex: hex::encode(req.owner_pubkey),
        revision: req.revision,
        claimed_at_ms: req.now_ms,
        released_until_ms: None,
        statement_sig: req.statement_sig.clone(),
    };
    let new_u_bytes = serde_json::to_vec(&new_record)
        .map_err(|e| KvError::Backend(format!("serialize username record: {e}")))?;

    ops.push(KvTransactionOp::CheckAndSet {
        key: u_key,
        expected: cur_u_raw,
        new_value: new_u_bytes,
    });
    ops.push(KvTransactionOp::CheckAndSet {
        key: addr_key,
        expected: cur_addr_raw,
        new_value: normalized.into_bytes(),
    });

    store.execute_transaction(ops)?;
    Ok(new_record)
}

/// Look up an active username record by handle in `'U'` (returns `None` if absent or tombstoned).
pub fn get_username_kv(
    store: &dyn RelayKvStore,
    handle: &str,
    _now_ms: u64,
) -> Result<Option<KvUsernameRecord>, KvError> {
    let normalized = normalize_username_handle(handle)?;
    let u_key = encode_username_key(&normalized);
    let Some(bytes) = store.get(&u_key)? else {
        return Ok(None);
    };
    let rec: KvUsernameRecord = serde_json::from_slice(&bytes)
        .map_err(|e| KvError::Backend(format!("corrupt username record: {e}")))?;
    if rec.released_until_ms.is_some() {
        return Ok(None);
    }
    Ok(Some(rec))
}

/// Look up the active username record for a 20-byte account address via `'U_addr'` -> `'U'`.
pub fn get_username_by_address_kv(
    store: &dyn RelayKvStore,
    address: &[u8; 20],
    now_ms: u64,
) -> Result<Option<KvUsernameRecord>, KvError> {
    let addr_key = encode_username_addr_key(address);
    let Some(handle_bytes) = store.get(&addr_key)? else {
        return Ok(None);
    };
    let handle = String::from_utf8(handle_bytes)
        .map_err(|e| KvError::Backend(format!("corrupt U_addr value: {e}")))?;
    let Some(rec) = get_username_kv(store, &handle, now_ms)? else {
        return Ok(None);
    };
    if &rec.owner_address != address {
        return Ok(None);
    }
    Ok(Some(rec))
}

/// Prefix range scan over `'U'` returning active username claims matching `prefix`.
pub fn search_usernames_kv(
    store: &dyn RelayKvStore,
    prefix: &str,
    _now_ms: u64,
    limit: usize,
) -> Result<Vec<KvUsernameRecord>, KvError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let normalized_prefix = prefix.trim().trim_start_matches('@').to_ascii_lowercase();
    let key_prefix = encode_username_key(&normalized_prefix);
    let rows = store.scan_prefix_range(&key_prefix, None, limit.saturating_mul(2).max(16))?;
    let mut out = Vec::new();
    for (_k, v) in rows {
        let rec: KvUsernameRecord = serde_json::from_slice(&v)
            .map_err(|e| KvError::Backend(format!("corrupt username record: {e}")))?;
        if rec.released_until_ms.is_none() {
            out.push(rec);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// Multi-chain stamp/burn payment reference (`chain_id`, `tx_hash`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvPaymentReference {
    /// Canonical numeric chain ID (e.g. `10143` for Monad Testnet).
    pub chain_id: u64,
    /// 32-byte transaction hash or outpoint digest.
    pub tx_hash: [u8; 32],
}

/// Persisted payment deduplication record stored in `'P'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvPaymentClaimRecord {
    /// Canonical numeric chain ID.
    pub chain_id: u64,
    /// 32-byte transaction hash or outpoint digest.
    pub tx_hash: [u8; 32],
    /// 20-byte recipient address.
    pub recipient_address: [u8; 20],
    /// 32-byte message payload digest that consumed this stamp payment.
    pub payload_digest: [u8; 32],
    /// Unix timestamp (ms) when claimed.
    pub claimed_at_ms: u64,
}

/// Persisted message digest pointer stored in `'M'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvDigestIndexRecord {
    /// 20-byte recipient address.
    pub recipient_address: [u8; 20],
    /// 32-byte payload digest.
    pub payload_digest: [u8; 32],
    /// Assigned 80-bit [`Versionstamp`] in `'I'` (filled on commit).
    pub versionstamp: Option<Versionstamp>,
    /// Whether this message has been tombstoned.
    pub tombstoned: bool,
}

/// Stored direct-message inbox record in `'I'`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvInboxMessageEntry {
    /// 20-byte recipient address.
    pub recipient_address: [u8; 20],
    /// 32-byte SHA-256 payload digest.
    pub payload_digest: [u8; 32],
    /// Assigned 80-bit [`Versionstamp`] delivery cursor.
    pub versionstamp: Versionstamp,
    /// Timestamp (ms) when admitted.
    pub received_at_ms: u64,
    /// Expiration timestamp (ms).
    pub expires_at_ms: u64,
    /// Inline envelope bytes (or header metadata when offloaded to `BlobStore`).
    pub envelope_bytes: Vec<u8>,
    /// Optional content-addressed `BlobStore` reference for payloads `> 64 KiB`.
    pub blob_ref: Option<String>,
    /// Whether this message was tombstoned.
    pub tombstoned: bool,
}

/// Event payload stored in the `'J'` multi-device sync journal subspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum KvJournalEventKind {
    /// A new message was delivered to `'I'` at `versionstamp`.
    Delivered {
        /// 32-byte message payload digest.
        payload_digest: [u8; 32],
        /// Committed inbox versionstamp.
        versionstamp: Versionstamp,
    },
    /// An existing message at `target_versionstamp` was tombstoned/deleted.
    Tombstoned {
        /// 32-byte message payload digest.
        payload_digest: [u8; 32],
        /// Original inbox versionstamp that was tombstoned.
        target_versionstamp: Versionstamp,
    },
    /// Encrypted multi-device state checkpoint committed.
    StateCheckpoint {
        /// 32-byte state checkpoint digest.
        checkpoint_digest: [u8; 32],
    },
}

/// Sync journal entry stored in `'J'` (`b"J:<recipient>:<versionstamp>"`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvJournalEntry {
    /// 20-byte recipient address.
    pub recipient_address: [u8; 20],
    /// Monotonic 80-bit [`Versionstamp`] of this journal event.
    pub versionstamp: Versionstamp,
    /// Event timestamp (ms).
    pub timestamp_ms: u64,
    /// Journal event kind.
    pub event: KvJournalEventKind,
}

/// Atomically admit a direct message across `'P'` (payment dedup), `'M'` (digest index),
/// `'I'` (versionstamped inbox stream), and `'J'` (sync journal) (`#1575` §3.1):
/// - If `('M', recipient, payload_digest)` already exists, returns the existing [`Versionstamp`]
///   idempotently without re-charging or duplicating the inbox entry.
/// - If any payment in `payments` was already claimed in `'P'` for a *different* `payload_digest`,
///   returns `Err(KvError::CasConflict)` (`409 Conflict` double-spend rejection).
/// - Otherwise commits `'P'`, `'M'`, and `'I'` (via `SetVersionstampedKey`) in a single atomic
///   transaction, records the assigned `Versionstamp` in `'M'` and `'J'`, and returns the
///   10-byte `Versionstamp` cursor.
pub fn admit_inbox_message_tx(
    store: &dyn RelayKvStore,
    recipient_address: [u8; 20],
    payload_digest: [u8; 32],
    payments: &[KvPaymentReference],
    envelope_bytes: Vec<u8>,
    blob_ref: Option<String>,
    now_ms: u64,
    expires_at_ms: u64,
) -> Result<Versionstamp, KvError> {
    let m_key = encode_msg_digest_key(&recipient_address, &payload_digest);

    // 1. Fast-path idempotent check in 'M'
    if let Some(existing_m_bytes) = store.get(&m_key)? {
        let existing_m: KvDigestIndexRecord = serde_json::from_slice(&existing_m_bytes)
            .map_err(|e| KvError::Backend(format!("corrupt M digest record: {e}")))?;
        if let Some(vs) = existing_m.versionstamp {
            return Ok(vs);
        }
    }

    // 2. Check all payment references in 'P'
    let mut ops = Vec::with_capacity(payments.len() + 2);
    for payment in payments {
        let p_key = encode_payment_dedup_key(payment.chain_id, &payment.tx_hash);
        if let Some(existing_p_bytes) = store.get(&p_key)? {
            let claim: KvPaymentClaimRecord = serde_json::from_slice(&existing_p_bytes)
                .map_err(|e| KvError::Backend(format!("corrupt P claim record: {e}")))?;
            if claim.payload_digest != payload_digest
                || claim.recipient_address != recipient_address
            {
                return Err(KvError::CasConflict {
                    current: Some(existing_p_bytes),
                });
            }
        } else {
            let claim = KvPaymentClaimRecord {
                chain_id: payment.chain_id,
                tx_hash: payment.tx_hash,
                recipient_address,
                payload_digest,
                claimed_at_ms: now_ms,
            };
            let claim_bytes = serde_json::to_vec(&claim)
                .map_err(|e| KvError::Backend(format!("serialize P claim: {e}")))?;
            ops.push(KvTransactionOp::CheckAndSet {
                key: p_key,
                expected: None,
                new_value: claim_bytes,
            });
        }
    }

    // 3. Stage 'M' guard (expected: None) + 'I' SetVersionstampedKey in one atomic transaction
    let initial_m = KvDigestIndexRecord {
        recipient_address,
        payload_digest,
        versionstamp: None,
        tombstoned: false,
    };
    let initial_m_bytes = serde_json::to_vec(&initial_m)
        .map_err(|e| KvError::Backend(format!("serialize M record: {e}")))?;
    ops.push(KvTransactionOp::CheckAndSet {
        key: m_key.clone(),
        expected: None,
        new_value: initial_m_bytes,
    });

    let placeholder_entry = KvInboxMessageEntry {
        recipient_address,
        payload_digest,
        versionstamp: Versionstamp::new(0, 0),
        received_at_ms: now_ms,
        expires_at_ms,
        envelope_bytes,
        blob_ref,
        tombstoned: false,
    };
    let entry_bytes = serde_json::to_vec(&placeholder_entry)
        .map_err(|e| KvError::Backend(format!("serialize I entry: {e}")))?;
    let inbox_prefix = encode_inbox_prefix(&recipient_address);
    ops.push(KvTransactionOp::SetVersionstampedKey {
        key_prefix: inbox_prefix,
        key_suffix: payload_digest.to_vec(),
        value: entry_bytes,
    });

    let vs = match store.execute_transaction(ops) {
        Ok(Some(vs)) => vs,
        Ok(None) => return Err(KvError::Backend("missing versionstamp from inbox tx".into())),
        Err(KvError::CasConflict { current }) => {
            // Check if a concurrent replica just committed the exact same message digest in 'M'
            if let Some(existing_m_bytes) = store.get(&m_key)? {
                let existing_m: KvDigestIndexRecord = serde_json::from_slice(&existing_m_bytes)
                    .map_err(|e| KvError::Backend(format!("corrupt M digest record: {e}")))?;
                if existing_m.payload_digest == payload_digest {
                    if let Some(vs) = existing_m.versionstamp {
                        return Ok(vs);
                    }
                    // Scan 'I' to locate the committed versionstamp for this digest
                    let rows = store.scan_prefix_range(
                        &encode_inbox_prefix(&recipient_address),
                        None,
                        1024,
                    )?;
                    for (k, _) in rows {
                        let (_, row_vs, row_digest) = decode_inbox_key(&k)?;
                        if row_digest == payload_digest {
                            return Ok(row_vs);
                        }
                    }
                }
            }
            return Err(KvError::CasConflict { current });
        }
        Err(e) => return Err(e),
    };

    // 4. Finalize the resolved Versionstamp in 'M' and append the 'J' sync journal event
    let finalized_m = KvDigestIndexRecord {
        recipient_address,
        payload_digest,
        versionstamp: Some(vs),
        tombstoned: false,
    };
    let finalized_m_bytes = serde_json::to_vec(&finalized_m)
        .map_err(|e| KvError::Backend(format!("serialize finalized M record: {e}")))?;
    let journal_entry = KvJournalEntry {
        recipient_address,
        versionstamp: vs,
        timestamp_ms: now_ms,
        event: KvJournalEventKind::Delivered {
            payload_digest,
            versionstamp: vs,
        },
    };
    let journal_bytes = serde_json::to_vec(&journal_entry)
        .map_err(|e| KvError::Backend(format!("serialize J entry: {e}")))?;
    store.execute_transaction(vec![
        KvTransactionOp::Put {
            key: m_key,
            value: finalized_m_bytes,
        },
        KvTransactionOp::Put {
            key: encode_sync_journal_key(&recipient_address, vs),
            value: journal_bytes,
        },
    ])?;

    Ok(vs)
}

/// Paginate a recipient's inbox (`'I'`) in strictly ascending [`Versionstamp`] order.
/// When `after_cursor` is `Some(vs)`, only messages with `versionstamp > vs` are returned.
pub fn scan_inbox_since_cursor(
    store: &dyn RelayKvStore,
    recipient_address: &[u8; 20],
    after_cursor: Option<Versionstamp>,
    limit: usize,
) -> Result<Vec<KvInboxMessageEntry>, KvError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let prefix = encode_inbox_prefix(recipient_address);
    let after_key = after_cursor.map(|vs| {
        // Construct the highest possible key for `vs` (`prefix || vs || [0xff; 32]`)
        // so `scan_prefix_range` starts strictly at the next versionstamp.
        encode_inbox_key(recipient_address, vs, &[0xff; 32])
    });
    let rows = store.scan_prefix_range(&prefix, after_key.as_deref(), limit)?;
    let mut entries = Vec::with_capacity(rows.len());
    for (k, v) in rows {
        let (_addr, key_vs, _digest) = decode_inbox_key(&k)?;
        let mut entry: KvInboxMessageEntry = serde_json::from_slice(&v)
            .map_err(|e| KvError::Backend(format!("corrupt I inbox entry: {e}")))?;
        entry.versionstamp = key_vs;
        entries.push(entry);
    }
    Ok(entries)
}

/// Atomically tombstone/delete a message by `(recipient_address, payload_digest)` across
/// `'M'`, `'I'`, and `'J'` (recording a [`KvJournalEventKind::Tombstoned`] event in `'J'`).
pub fn tombstone_inbox_message_tx(
    store: &dyn RelayKvStore,
    recipient_address: [u8; 20],
    payload_digest: [u8; 32],
    now_ms: u64,
) -> Result<Option<Versionstamp>, KvError> {
    let m_key = encode_msg_digest_key(&recipient_address, &payload_digest);
    let Some(m_bytes) = store.get(&m_key)? else {
        return Ok(None);
    };
    let mut m_rec: KvDigestIndexRecord = serde_json::from_slice(&m_bytes)
        .map_err(|e| KvError::Backend(format!("corrupt M record: {e}")))?;
    let Some(target_vs) = m_rec.versionstamp else {
        return Ok(None);
    };
    if m_rec.tombstoned {
        return Ok(Some(target_vs));
    }
    m_rec.tombstoned = true;
    let updated_m_bytes = serde_json::to_vec(&m_rec)
        .map_err(|e| KvError::Backend(format!("serialize M record: {e}")))?;

    let i_key = encode_inbox_key(&recipient_address, target_vs, &payload_digest);
    let j_prefix = encode_sync_journal_prefix(&recipient_address);
    let journal_placeholder = KvJournalEntry {
        recipient_address,
        versionstamp: target_vs,
        timestamp_ms: now_ms,
        event: KvJournalEventKind::Tombstoned {
            payload_digest,
            target_versionstamp: target_vs,
        },
    };
    let j_bytes = serde_json::to_vec(&journal_placeholder)
        .map_err(|e| KvError::Backend(format!("serialize J tombstone: {e}")))?;

    let journal_vs = store
        .execute_transaction(vec![
            KvTransactionOp::CheckAndSet {
                key: m_key,
                expected: Some(m_bytes),
                new_value: updated_m_bytes,
            },
            KvTransactionOp::Delete { key: i_key },
            KvTransactionOp::SetVersionstampedKey {
                key_prefix: j_prefix,
                key_suffix: Vec::new(),
                value: j_bytes,
            },
        ])?
        .ok_or_else(|| KvError::Backend("missing versionstamp for journal tombstone".into()))?;

    Ok(Some(journal_vs))
}

/// Paginate a recipient's multi-device sync journal (`'J'`) strictly after `after_cursor`.
pub fn scan_sync_journal_since_cursor(
    store: &dyn RelayKvStore,
    recipient_address: &[u8; 20],
    after_cursor: Option<Versionstamp>,
    limit: usize,
) -> Result<Vec<KvJournalEntry>, KvError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let prefix = encode_sync_journal_prefix(recipient_address);
    let after_key = after_cursor.map(|vs| encode_sync_journal_key(recipient_address, vs));
    let rows = store.scan_prefix_range(&prefix, after_key.as_deref(), limit)?;
    let mut out = Vec::with_capacity(rows.len());
    for (k, v) in rows {
        let (_addr, key_vs) = decode_sync_journal_key(&k)?;
        let mut entry: KvJournalEntry = serde_json::from_slice(&v)
            .map_err(|e| KvError::Backend(format!("corrupt J entry: {e}")))?;
        entry.versionstamp = key_vs;
        out.push(entry);
    }
    Ok(out)
}

/// Group mailbox epoch and credit metadata stored in `'G_meta'` (`#70` & `#1575` §3.3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvGroupMeta {
    /// 32-byte group identifier.
    pub group_id: [u8; 32],
    /// Monotonic group epoch (`0` on creation, incremented by `1` on each rotation).
    pub epoch: u64,
    /// 32-byte commitment hash of the group membership/state for this epoch.
    pub state_commit_hash: [u8; 32],
    /// 32-byte Ed25519 group write public key for the current epoch.
    pub write_pub_key: [u8; 32],
    /// Remaining prepaid message delivery credits for this group mailbox.
    pub credit_balance: u64,
    /// Timestamp (ms) of the last epoch rotation or credit update.
    pub updated_at_ms: u64,
}

/// Group message record stored in `'G'` (`b"G:<group_id>:<versionstamp><msg_hash>"`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvGroupMessageEntry {
    /// 32-byte group identifier.
    pub group_id: [u8; 32],
    /// Group epoch under which the message was posted.
    pub epoch: u64,
    /// Assigned 80-bit [`Versionstamp`] in `'G'`.
    pub versionstamp: Versionstamp,
    /// 32-byte message hash.
    pub msg_hash: [u8; 32],
    /// Encrypted group message payload bytes.
    pub envelope_bytes: Vec<u8>,
    /// Timestamp (ms) when posted.
    pub posted_at_ms: u64,
}

/// Atomically initialize (`epoch == 0`) or rotate (`new_epoch == cur_epoch + 1`) a group's
/// epoch metadata in `'G_meta'` via Compare-And-Swap (`#70` & `#1575` §3.3).
pub fn rotate_group_epoch_tx(
    store: &dyn RelayKvStore,
    next_meta: &KvGroupMeta,
) -> Result<(), KvError> {
    let meta_key = encode_group_meta_key(&next_meta.group_id);
    let cur_raw = store.get(&meta_key)?;
    match cur_raw {
        None => {
            if next_meta.epoch != 0 {
                return Err(KvError::CasConflict { current: None });
            }
            let new_bytes = serde_json::to_vec(next_meta)
                .map_err(|e| KvError::Backend(format!("serialize G_meta: {e}")))?;
            store.compare_and_swap(&meta_key, None, &new_bytes)
        }
        Some(ref bytes) => {
            let cur: KvGroupMeta = serde_json::from_slice(bytes)
                .map_err(|e| KvError::Backend(format!("corrupt G_meta: {e}")))?;
            if next_meta.epoch != cur.epoch.saturating_add(1) {
                return Err(KvError::CasConflict { current: cur_raw });
            }
            let new_bytes = serde_json::to_vec(next_meta)
                .map_err(|e| KvError::Backend(format!("serialize G_meta: {e}")))?;
            store.compare_and_swap(&meta_key, Some(bytes), &new_bytes)
        }
    }
}

/// Atomically verify group `epoch`, `write_pub_key`, and `credit_balance > 0`, decrement
/// `credit_balance` by 1 in `'G_meta'`, and append the message to `'G'` with a
/// cluster-monotonic [`Versionstamp`] in a single serializable transaction (`#70` & `#1575` §3.3).
/// Returns `(assigned_versionstamp, remaining_credit_balance)`.
pub fn post_group_message_tx(
    store: &dyn RelayKvStore,
    group_id: [u8; 32],
    expected_epoch: u64,
    write_pub_key: [u8; 32],
    msg_hash: [u8; 32],
    envelope_bytes: Vec<u8>,
    now_ms: u64,
) -> Result<(Versionstamp, u64), KvError> {
    let meta_key = encode_group_meta_key(&group_id);
    let Some(cur_meta_bytes) = store.get(&meta_key)? else {
        return Err(KvError::InvalidArgument("group metadata not found".into()));
    };
    let mut meta: KvGroupMeta = serde_json::from_slice(&cur_meta_bytes)
        .map_err(|e| KvError::Backend(format!("corrupt G_meta: {e}")))?;

    if meta.epoch != expected_epoch || meta.write_pub_key != write_pub_key || meta.credit_balance == 0
    {
        return Err(KvError::CasConflict {
            current: Some(cur_meta_bytes),
        });
    }

    meta.credit_balance -= 1;
    meta.updated_at_ms = now_ms;
    let remaining_credits = meta.credit_balance;
    let updated_meta_bytes = serde_json::to_vec(&meta)
        .map_err(|e| KvError::Backend(format!("serialize updated G_meta: {e}")))?;

    let msg_entry = KvGroupMessageEntry {
        group_id,
        epoch: expected_epoch,
        versionstamp: Versionstamp::new(0, 0),
        msg_hash,
        envelope_bytes,
        posted_at_ms: now_ms,
    };
    let msg_bytes = serde_json::to_vec(&msg_entry)
        .map_err(|e| KvError::Backend(format!("serialize G message: {e}")))?;

    let g_prefix = encode_group_message_prefix(&group_id);
    let vs = store
        .execute_transaction(vec![
            KvTransactionOp::CheckAndSet {
                key: meta_key,
                expected: Some(cur_meta_bytes),
                new_value: updated_meta_bytes,
            },
            KvTransactionOp::SetVersionstampedKey {
                key_prefix: g_prefix,
                key_suffix: msg_hash.to_vec(),
                value: msg_bytes,
            },
        ])?
        .ok_or_else(|| KvError::Backend("missing versionstamp from group post tx".into()))?;

    Ok((vs, remaining_credits))
}

/// Paginate a group's message stream (`'G'`) in strictly ascending [`Versionstamp`] order.
pub fn scan_group_messages_since_cursor(
    store: &dyn RelayKvStore,
    group_id: &[u8; 32],
    after_cursor: Option<Versionstamp>,
    limit: usize,
) -> Result<Vec<KvGroupMessageEntry>, KvError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let prefix = encode_group_message_prefix(group_id);
    let after_key = after_cursor.map(|vs| {
        let mut k = prefix.clone();
        k.extend_from_slice(vs.as_bytes());
        k.extend_from_slice(&[0xff; 32]);
        k
    });
    let rows = store.scan_prefix_range(&prefix, after_key.as_deref(), limit)?;
    let mut out = Vec::with_capacity(rows.len());
    for (k, v) in rows {
        let (_gid, key_vs, _hash) = decode_group_message_key(&k)?;
        let mut entry: KvGroupMessageEntry = serde_json::from_slice(&v)
            .map_err(|e| KvError::Backend(format!("corrupt G message entry: {e}")))?;
        entry.versionstamp = key_vs;
        out.push(entry);
    }
    Ok(out)
}

/// Key-value pair in a portable [`KvSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvSnapshotPair {
    /// Raw logical key bytes (excluding any backend subspace prefix).
    pub key: Vec<u8>,
    /// Raw value bytes.
    pub value: Vec<u8>,
}

/// Deterministic portable snapshot of a [`RelayKvStore`] for RocksDB-to-FoundationDB migration
/// and backup/restore (`#1575` §5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KvSnapshot {
    /// Timestamp (ms) when the snapshot was exported.
    pub exported_at_ms: u64,
    /// Canonical lexicographically ordered key-value pairs across all subspaces.
    pub pairs: Vec<KvSnapshotPair>,
}

/// Export all logical key-value pairs from `source` in canonical lexicographical order.
pub fn export_kv_snapshot(
    source: &dyn RelayKvStore,
    page_size: usize,
) -> Result<KvSnapshot, KvError> {
    let step = page_size.max(1);
    let mut pairs = Vec::new();
    let mut cursor: Option<Vec<u8>> = None;
    loop {
        let batch = source.scan_prefix_range(b"", cursor.as_deref(), step)?;
        if batch.is_empty() {
            break;
        }
        cursor = batch.last().map(|(k, _)| k.clone());
        let fetched = batch.len();
        for (key, value) in batch {
            pairs.push(KvSnapshotPair { key, value });
        }
        if fetched < step {
            break;
        }
    }
    Ok(KvSnapshot {
        exported_at_ms: current_time_ms(),
        pairs,
    })
}

/// Import a [`KvSnapshot`] into `target` in transactional chunks, preserving all keys and
/// 80-bit [`Versionstamp`] ordering. Returns the total number of imported keys.
pub fn import_kv_snapshot(
    target: &dyn RelayKvStore,
    snapshot: &KvSnapshot,
    chunk_size: usize,
) -> Result<usize, KvError> {
    let step = chunk_size.max(1);
    let mut imported = 0usize;
    for chunk in snapshot.pairs.chunks(step) {
        let ops = chunk
            .iter()
            .map(|pair| KvTransactionOp::Put {
                key: pair.key.clone(),
                value: pair.value.clone(),
            })
            .collect();
        target.execute_transaction(ops)?;
        imported += chunk.len();
    }
    Ok(imported)
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

    /// Full #1575 domain workflow conformance suite executed identically against
    /// `MemoryKvStore`, `RocksDbKvStore`, and `FoundationDbKvStore`.
    fn verify_domain_workflows(store: &dyn RelayKvStore) {
        let alice = [0x11u8; 20];
        let bob = [0x22u8; 20];
        let alice_pk = [0x02u8; 33];
        let bob_pk = [0x03u8; 33];

        // 1. Directory ('D') atomic revision CAS
        let dir_v1 = KvDirectoryRecord {
            address: alice,
            revision: 1,
            statement_cbor: b"cbor-v1".to_vec(),
            updated_at_ms: 1_000,
        };
        put_directory_entry_cas(store, &dir_v1).unwrap();
        assert_eq!(get_directory_entry(store, &alice).unwrap(), Some(dir_v1.clone()));
        // Stale or equal revision must fail with CasConflict
        assert!(matches!(
            put_directory_entry_cas(store, &dir_v1),
            Err(KvError::CasConflict { .. })
        ));
        let dir_v2 = KvDirectoryRecord {
            address: alice,
            revision: 2,
            statement_cbor: b"cbor-v2".to_vec(),
            updated_at_ms: 2_000,
        };
        put_directory_entry_cas(store, &dir_v2).unwrap();
        assert_eq!(get_directory_entry(store, &alice).unwrap(), Some(dir_v2));

        // 2. Username ('U' + 'U_addr') first-claim-wins, idempotent repeat, rotation + cooling TTL
        let claim_alice = KvUsernameClaimRequest {
            handle: "@Alice_01".into(),
            owner_address: alice,
            owner_pubkey: alice_pk,
            revision: 1,
            now_ms: 10_000,
            cooling_ttl_ms: 60_000,
            statement_sig: vec![1, 2, 3],
        };
        let rec1 = claim_username_kv(store, &claim_alice).unwrap();
        assert_eq!(rec1.normalized_handle, "alice_01");
        // Same-holder repeat with same revision is idempotent
        let rec1_repeat = claim_username_kv(store, &claim_alice).unwrap();
        assert_eq!(rec1, rec1_repeat);
        // Competing claim by Bob for "alice_01" fails with CasConflict
        let claim_bob_conflict = KvUsernameClaimRequest {
            handle: "alice_01".into(),
            owner_address: bob,
            owner_pubkey: bob_pk,
            revision: 1,
            now_ms: 10_500,
            cooling_ttl_ms: 60_000,
            statement_sig: vec![4, 5, 6],
        };
        assert!(matches!(
            claim_username_kv(store, &claim_bob_conflict),
            Err(KvError::CasConflict { .. })
        ));

        // Alice rotates handle from "alice_01" -> "alice_new" at t=20_000 with cooling_ttl=60_000
        let rotate_alice = KvUsernameClaimRequest {
            handle: "alice_new".into(),
            owner_address: alice,
            owner_pubkey: alice_pk,
            revision: 2,
            now_ms: 20_000,
            cooling_ttl_ms: 60_000,
            statement_sig: vec![7, 8, 9],
        };
        claim_username_kv(store, &rotate_alice).unwrap();
        assert_eq!(get_username_kv(store, "alice_01", 25_000).unwrap(), None);
        assert_eq!(
            get_username_by_address_kv(store, &alice, 25_000)
                .unwrap()
                .unwrap()
                .normalized_handle,
            "alice_new"
        );
        let search_hits = search_usernames_kv(store, "alice", 25_000, 10).unwrap();
        assert_eq!(search_hits.len(), 1);
        assert_eq!(search_hits[0].normalized_handle, "alice_new");

        // Bob tries to claim "alice_01" during cooling window (t=50_000 < 80_000) -> rejected!
        let bob_early = KvUsernameClaimRequest {
            now_ms: 50_000,
            ..claim_bob_conflict.clone()
        };
        assert!(matches!(
            claim_username_kv(store, &bob_early),
            Err(KvError::CasConflict { .. })
        ));
        // Bob claims "alice_01" after cooling TTL expires (t=80_001 >= 80_000) -> succeeds!
        let bob_after_cooling = KvUsernameClaimRequest {
            now_ms: 80_001,
            ..claim_bob_conflict
        };
        let bob_rec = claim_username_kv(store, &bob_after_cooling).unwrap();
        assert_eq!(bob_rec.owner_address, bob);

        // 3. Atomic Inbox Admission ('I' + 'M' + 'P' + 'J'), payment double-spend rejection,
        //    cursor pagination, and tombstone sync journal
        let payment_1 = KvPaymentReference {
            chain_id: 10143,
            tx_hash: [0xAA; 32],
        };
        let msg_digest_1 = [0x01; 32];
        let vs1 = admit_inbox_message_tx(
            store,
            alice,
            msg_digest_1,
            &[payment_1],
            b"cipher-1".to_vec(),
            None,
            100_000,
            200_000,
        )
        .unwrap();

        // Idempotent retry of the exact same message + payment returns the same Versionstamp
        let vs1_retry = admit_inbox_message_tx(
            store,
            alice,
            msg_digest_1,
            &[payment_1],
            b"cipher-1".to_vec(),
            None,
            100_005,
            200_000,
        )
        .unwrap();
        assert_eq!(vs1, vs1_retry);

        // Double-spend attempt: reusing `payment_1` for a DIFFERENT message digest must fail with CasConflict!
        let msg_digest_double_spend = [0x99; 32];
        assert!(matches!(
            admit_inbox_message_tx(
                store,
                alice,
                msg_digest_double_spend,
                &[payment_1],
                b"attack".to_vec(),
                None,
                100_010,
                200_000,
            ),
            Err(KvError::CasConflict { .. })
        ));

        // Admit two more messages for Alice and paginate with `scan_inbox_since_cursor`
        let vs2 = admit_inbox_message_tx(
            store,
            alice,
            [0x02; 32],
            &[KvPaymentReference {
                chain_id: 10143,
                tx_hash: [0xBB; 32],
            }],
            b"cipher-2".to_vec(),
            Some("sha256:blob2".into()),
            100_020,
            200_000,
        )
        .unwrap();
        let vs3 = admit_inbox_message_tx(
            store,
            alice,
            [0x03; 32],
            &[KvPaymentReference {
                chain_id: 10143,
                tx_hash: [0xCC; 32],
            }],
            b"cipher-3".to_vec(),
            None,
            100_030,
            200_000,
        )
        .unwrap();
        assert!(vs1 < vs2 && vs2 < vs3);

        let page_a = scan_inbox_since_cursor(store, &alice, None, 2).unwrap();
        assert_eq!(page_a.len(), 2);
        assert_eq!(page_a[0].versionstamp, vs1);
        assert_eq!(page_a[1].versionstamp, vs2);
        assert_eq!(page_a[1].blob_ref.as_deref(), Some("sha256:blob2"));

        let page_b = scan_inbox_since_cursor(store, &alice, Some(vs2), 2).unwrap();
        assert_eq!(page_b.len(), 1);
        assert_eq!(page_b[0].versionstamp, vs3);

        // Tombstone message 2 and verify 'I' deletion + 'J' sync journal event
        let tomb_vs = tombstone_inbox_message_tx(store, alice, [0x02; 32], 100_040)
            .unwrap()
            .unwrap();
        assert!(tomb_vs > vs3);
        let remaining_inbox = scan_inbox_since_cursor(store, &alice, None, 10).unwrap();
        assert_eq!(remaining_inbox.len(), 2);
        assert_eq!(remaining_inbox[0].versionstamp, vs1);
        assert_eq!(remaining_inbox[1].versionstamp, vs3);

        let journal = scan_sync_journal_since_cursor(store, &alice, Some(vs2), 10).unwrap();
        assert_eq!(journal.len(), 2); // Delivered(msg3) + Tombstoned(msg2)
        assert!(matches!(
            journal[1].event,
            KvJournalEventKind::Tombstoned {
                target_versionstamp,
                ..
            } if target_versionstamp == vs2
        ));

        // 4. Group Mailbox ('G' + 'G_meta') epoch CAS (#70) and atomic credit deduction
        let group_id = [0x77; 32];
        let write_key_e0 = [0xA0; 32];
        let write_key_e1 = [0xA1; 32];

        // Non-zero initial epoch must fail
        let bad_init = KvGroupMeta {
            group_id,
            epoch: 1,
            state_commit_hash: [0x10; 32],
            write_pub_key: write_key_e0,
            credit_balance: 2,
            updated_at_ms: 50_000,
        };
        assert!(matches!(
            rotate_group_epoch_tx(store, &bad_init),
            Err(KvError::CasConflict { .. })
        ));

        let meta_e0 = KvGroupMeta {
            epoch: 0,
            ..bad_init
        };
        rotate_group_epoch_tx(store, &meta_e0).unwrap();

        // Rotate epoch 0 -> 1 with 2 credits
        let meta_e1 = KvGroupMeta {
            group_id,
            epoch: 1,
            state_commit_hash: [0x20; 32],
            write_pub_key: write_key_e1,
            credit_balance: 2,
            updated_at_ms: 51_000,
        };
        rotate_group_epoch_tx(store, &meta_e1).unwrap();

        // Posting with stale epoch (0) fails with CasConflict
        assert!(matches!(
            post_group_message_tx(
                store,
                group_id,
                0,
                write_key_e0,
                [0xE1; 32],
                b"stale-epoch".to_vec(),
                52_000,
            ),
            Err(KvError::CasConflict { .. })
        ));

        // Post 2 valid messages in epoch 1 -> credits decremented 2 -> 1 -> 0
        let (g_vs1, rem1) = post_group_message_tx(
            store,
            group_id,
            1,
            write_key_e1,
            [0xE1; 32],
            b"group-msg-1".to_vec(),
            52_001,
        )
        .unwrap();
        assert_eq!(rem1, 1);

        let (g_vs2, rem2) = post_group_message_tx(
            store,
            group_id,
            1,
            write_key_e1,
            [0xE2; 32],
            b"group-msg-2".to_vec(),
            52_002,
        )
        .unwrap();
        assert_eq!(rem2, 0);
        assert!(g_vs2 > g_vs1);

        // 3rd post when credit_balance == 0 must fail atomically with CasConflict!
        assert!(matches!(
            post_group_message_tx(
                store,
                group_id,
                1,
                write_key_e1,
                [0xE3; 32],
                b"no-credits-left".to_vec(),
                52_003,
            ),
            Err(KvError::CasConflict { .. })
        ));

        let g_msgs = scan_group_messages_since_cursor(store, &group_id, None, 10).unwrap();
        assert_eq!(g_msgs.len(), 2);
        assert_eq!(g_msgs[0].versionstamp, g_vs1);
        assert_eq!(g_msgs[1].versionstamp, g_vs2);
    }

    #[test]
    fn memory_kv_store_satisfies_contract() {
        let store = MemoryKvStore::new();
        verify_kv_contract(&store);
        verify_domain_workflows(&store);
    }

    #[test]
    fn rocksdb_kv_store_satisfies_contract_and_persists_versionstamp_monotonicity() {
        let dir = tempdir::TempDir::new("relay-kv-rocksdb").unwrap();
        let path = dir.path().join("kv.rocksdb");
        let last_vs_before_reopen = {
            let store = RocksDbKvStore::open(&path).unwrap();
            verify_kv_contract(&store);
            verify_domain_workflows(&store);
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
        verify_domain_workflows(&fdb_a);
        assert_eq!(
            fdb_b.scan_prefix_range(b"G:grpA:", None, 10).unwrap().len(),
            0
        );
        verify_kv_contract(&fdb_b);
        verify_domain_workflows(&fdb_b);

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

    #[test]
    fn multi_replica_concurrent_username_claims_and_inbox_appends_and_snapshot_migration() {
        let cluster = SimulatedFdbCluster::new();
        let recipient = [0x55u8; 20];

        // 1. 10 replicas racing to claim the same username "@satoshi" for 10 distinct addresses
        let mut claim_threads = Vec::new();
        for i in 0..10u8 {
            let replica = FoundationDbKvStore::connect_simulated(
                "/etc/foundationdb/fdb.cluster",
                b"prod_cluster:",
                cluster.clone(),
            );
            claim_threads.push(thread::spawn(move || {
                let req = KvUsernameClaimRequest {
                    handle: "satoshi".into(),
                    owner_address: [i + 1; 20],
                    owner_pubkey: [i + 2; 33],
                    revision: 1,
                    now_ms: 1_000,
                    cooling_ttl_ms: 60_000,
                    statement_sig: vec![i],
                };
                claim_username_kv(&replica, &req)
            }));
        }
        let mut claim_wins = 0;
        let mut claim_conflicts = 0;
        for t in claim_threads {
            match t.join().unwrap() {
                Ok(_) => claim_wins += 1,
                Err(KvError::CasConflict { .. }) => claim_conflicts += 1,
                Err(e) => panic!("unexpected username claim error: {e:?}"),
            }
        }
        assert_eq!(claim_wins, 1);
        assert_eq!(claim_conflicts, 9);

        // 2. 8 replicas concurrently appending 5 messages each (40 messages total) to `recipient`
        let mut append_threads = Vec::new();
        for r in 0..8u8 {
            let replica = FoundationDbKvStore::connect_simulated(
                "/etc/foundationdb/fdb.cluster",
                b"prod_cluster:",
                cluster.clone(),
            );
            append_threads.push(thread::spawn(move || {
                let mut stamps = Vec::new();
                for seq in 0..5u8 {
                    let mut digest = [0u8; 32];
                    digest[0] = r;
                    digest[1] = seq;
                    let mut tx_hash = [0u8; 32];
                    tx_hash[0] = r;
                    tx_hash[1] = seq;
                    let vs = admit_inbox_message_tx(
                        &replica,
                        recipient,
                        digest,
                        &[KvPaymentReference {
                            chain_id: 10143,
                            tx_hash,
                        }],
                        vec![r, seq],
                        None,
                        2_000,
                        9_000,
                    )
                    .unwrap();
                    stamps.push(vs);
                }
                stamps
            }));
        }
        for t in append_threads {
            t.join().unwrap();
        }

        let reader = FoundationDbKvStore::connect_simulated(
            "/etc/foundationdb/fdb.cluster",
            b"prod_cluster:",
            cluster.clone(),
        );
        let all_msgs = scan_inbox_since_cursor(&reader, &recipient, None, 100).unwrap();
        assert_eq!(all_msgs.len(), 40);
        for pair in all_msgs.windows(2) {
            assert!(
                pair[0].versionstamp < pair[1].versionstamp,
                "concurrent multi-replica inbox versionstamps must be strictly ordered"
            );
        }

        // 3. Export snapshot from RocksDbKvStore -> Import into FoundationDbKvStore and verify
        let dir = tempdir::TempDir::new("rocksdb-to-fdb-migration").unwrap();
        let rocks = RocksDbKvStore::open(dir.path().join("src.rocksdb")).unwrap();
        for (k, v) in reader.scan_prefix_range(b"", None, 1000).unwrap() {
            rocks.put(&k, &v).unwrap();
        }
        let snapshot = export_kv_snapshot(&rocks, 16).unwrap();
        assert!(!snapshot.pairs.is_empty());

        let migrated_cluster = SimulatedFdbCluster::new();
        let migrated_fdb = FoundationDbKvStore::connect_simulated(
            "/etc/foundationdb/fdb.cluster",
            b"migrated_subspace:",
            migrated_cluster,
        );
        let imported_count = import_kv_snapshot(&migrated_fdb, &snapshot, 10).unwrap();
        assert_eq!(imported_count, snapshot.pairs.len());

        let migrated_msgs = scan_inbox_since_cursor(&migrated_fdb, &recipient, None, 100).unwrap();
        assert_eq!(migrated_msgs, all_msgs);
        let migrated_satoshi = get_username_kv(&migrated_fdb, "satoshi", 1_500)
            .unwrap()
            .unwrap();
        assert_eq!(migrated_satoshi.normalized_handle, "satoshi");
    }
}
