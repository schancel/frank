//! The directory's one transactional store: preview evidence, subject continuity, the address
//! and first-accepted indexes, subject counters, forwards and their bodies, and leases.
//!
//! Every replica of a cluster opens the same store (FoundationDB under
//! `<fdb_subspace_prefix>directory-v1/`); a single-node relay opens a RocksDB store inside its
//! registry path ([`ROCKSDB_STORE`]). Both run behind the [`RelayKvStore`] transaction contract,
//! so a subject's evidence, its continuity row and its indexes change in one transaction.
//! Values over [`INLINE_LIMIT`](crate::store::large_values::INLINE_LIMIT) (evidence frames and
//! forward bodies) are content-addressed objects in the [`ObjectStore`] composition passes in,
//! named `directory/sha256/<hex>`, with their references committed in the same transaction.
//!
//! Keys (inside the store; FoundationDB adds the subspace prefix):
//! - `format`: [`FORMAT`]. A store holding anything else stops with the reset path.
//! - `p/m/` K, `p/h/` K, `p/e/` K slot revision T1: preview marker, head metadata, evidence.
//! - `s/r/` K: the subject's continuity row. `s/a/` and `s/f/`: address index and the
//!   first-accepted listing. `s/n/local`, `s/n/replicated`: subject counters (atomic adds).
//! - `f/r/` identity, `f/b/` identity: forward state and its exact request body.
//! - `l/` name: a lease (holder 16 bytes, expiry ms big-endian).
//! - `lv/`: this store's large-value index.
//!
//! K is the subject key: one length byte, the network, the 33-byte compressed point.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::store::{
    kv_store::{KvError, KvTransaction, RelayKvStore, RocksDbKvStore, Transact},
    large_values::{LargeValueRef, LargeValues, ObjectStore, SweepReport},
};

/// Format marker key and value of this store.
pub(crate) const FORMAT_KEY: &[u8] = b"format";
pub(crate) const FORMAT: &[u8] = b"frank-directory-kv-v1";
/// The single-node store, inside the canonical registry path.
pub const ROCKSDB_STORE: &str = "directory-kv-v1.rocksdb";
/// Sidecars an earlier development build kept inside the registry path. This build has no
/// reader for them; startup refuses while they exist and names them.
pub(crate) const OLD_SIDECARS: [&str; 2] = [
    "directory-preview-v1.rocksdb",
    "directory-subjects-v1.rocksdb",
];
/// The directory's namespace in the shared object store.
pub const OBJECT_NAMESPACE: &str = "directory";
const LARGE_VALUE_PREFIX: &[u8] = b"lv/";
const LEASE_PREFIX: &[u8] = b"l/";

/// Where the directory keeps its state, chosen by daemon composition.
#[derive(Debug, Clone)]
pub enum DirectoryBackend {
    /// This replica's RocksDB store [`ROCKSDB_STORE`] inside this registry path. The path is
    /// resolved on first use.
    RocksDbInside(PathBuf),
    /// A transaction store shared by every replica (FoundationDB), opened by composition.
    Shared(Arc<dyn RelayKvStore>),
}

/// Why the store could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StoreError {
    /// A single-node store that does not exist yet, opened without permission to create it.
    Missing,
    /// Unreadable, corrupt or partial storage. Nothing is repaired or reset.
    Unavailable(String),
    /// Written by another format. The text is the development reset path.
    OldFormat(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("the directory store does not exist yet"),
            Self::Unavailable(reason) => write!(f, "the directory store is unavailable: {reason}"),
            Self::OldFormat(reset) => f.write_str(reset),
        }
    }
}

impl std::error::Error for StoreError {}

/// The open store: its transactions and its large-value index.
#[derive(Debug)]
pub struct DirectoryStore {
    kv: Arc<dyn RelayKvStore>,
    large: LargeValues,
}

/// A value that may live in the object store: inline bytes or a reference.
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
            ]
            .concat(),
        }
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        match bytes.split_first()? {
            (&Self::INLINE, rest) => Some(Self::Inline(rest.to_vec())),
            (&Self::LARGE, rest) if rest.len() == 40 => Some(Self::Large(LargeValueRef {
                digest: rest[..32].try_into().ok()?,
                len: u64::from_be_bytes(rest[32..].try_into().ok()?),
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

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

impl DirectoryStore {
    fn new(kv: Arc<dyn RelayKvStore>, objects: Arc<dyn ObjectStore>) -> Self {
        let large = LargeValues::new(kv.clone(), objects, LARGE_VALUE_PREFIX, OBJECT_NAMESPACE);
        Self { kv, large }
    }

    /// The transaction store.
    pub(crate) fn kv(&self) -> &dyn RelayKvStore {
        self.kv.as_ref()
    }

    /// The large-value index (evidence frames and forward bodies over the inline limit).
    pub(crate) fn large(&self) -> &LargeValues {
        &self.large
    }

    /// Resolve a stored value, reading and checking a referenced object outside any transaction.
    pub(crate) fn resolve(&self, stored: Stored) -> Result<Vec<u8>, String> {
        match stored {
            Stored::Inline(bytes) => Ok(bytes),
            Stored::Large(reference) => self.large.read(&reference).map_err(|e| e.to_string()),
        }
    }

    /// Take or renew the lease `name` for `holder` until `ttl_ms` from now. False while another
    /// holder's lease is unexpired. Each call is one transaction, so two holders never both win.
    pub(crate) fn hold_lease(
        &self,
        name: &[u8],
        holder: &[u8; 16],
        ttl_ms: u64,
    ) -> Result<bool, KvError> {
        let key = [LEASE_PREFIX, name].concat();
        self.kv.transact(|tx| {
            let now = now_ms();
            if let Some(current) = tx.get(&key)? {
                let expiry = current
                    .get(16..24)
                    .and_then(|bytes| bytes.try_into().ok())
                    .map(u64::from_be_bytes)
                    .ok_or_else(|| KvError::Backend("corrupt directory lease".into()))?;
                if current[..16] != holder[..] && expiry > now {
                    return Ok(false);
                }
            }
            tx.set(
                &key,
                &[&holder[..], &now.saturating_add(ttl_ms).to_be_bytes()].concat(),
            )?;
            Ok(true)
        })
    }

    /// Delete unreferenced directory objects as sweep lease holder `holder`.
    pub fn sweep_large_values(&self, holder: [u8; 16]) -> Result<SweepReport, String> {
        self.large.sweep(holder).map_err(|error| error.to_string())
    }

    fn check_format(&self, create: bool, reset: &str) -> Result<(), StoreError> {
        let unavailable = |error: KvError| StoreError::Unavailable(error.to_string());
        self.kv
            .transact(|tx: &mut dyn KvTransaction| match tx.get(FORMAT_KEY)? {
                Some(format) if format == FORMAT => Ok(Ok(())),
                Some(_) => Ok(Err(StoreError::OldFormat(reset.to_owned()))),
                None if !tx.scan_prefix(b"", None, 1)?.is_empty() => {
                    Ok(Err(StoreError::OldFormat(reset.to_owned())))
                }
                None if create => {
                    tx.set(FORMAT_KEY, FORMAT)?;
                    Ok(Ok(()))
                }
                None => Ok(Err(StoreError::Missing)),
            })
            .map_err(unavailable)?
    }
}

/// Lazy owner of the [`DirectoryStore`]. Ordinary registry startup never opens it.
pub(crate) struct Owner {
    backend: DirectoryBackend,
    objects: Arc<dyn ObjectStore>,
    opened: Mutex<Option<Arc<DirectoryStore>>>,
}

impl std::fmt::Debug for Owner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectoryOwner")
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

impl Owner {
    pub(crate) fn new(backend: DirectoryBackend, objects: Arc<dyn ObjectStore>) -> Self {
        Self {
            backend,
            objects,
            opened: Mutex::new(None),
        }
    }

    /// Open the store once. Without `create`, a single-node store that does not exist, or a
    /// store with no format marker, is [`StoreError::Missing`] and nothing is written. An
    /// existing path that is not a complete RocksDB store is never repaired. Concurrent first
    /// opens wait for one another and share one handle; a failed open is retried next time.
    pub(crate) fn open(&self, create: bool) -> Result<Arc<DirectoryStore>, StoreError> {
        let mut opened = self
            .opened
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(store) = opened.as_ref() {
            return Ok(Arc::clone(store));
        }
        let (kv, reset): (Arc<dyn RelayKvStore>, String) = match &self.backend {
            DirectoryBackend::RocksDbInside(registry) => {
                let path = &std::fs::canonicalize(registry)
                    .map_err(|error| StoreError::Unavailable(error.to_string()))?
                    .join(ROCKSDB_STORE);
                let reset = format!(
                    "The directory store at {} was written by an earlier development build and \
                     this build has no reader for it. Development reset: stop the relay and delete \
                     {}. It holds public directory entries and forward state only: no keys and no \
                     funds. Accounts publish their entries again.",
                    path.display(),
                    path.display()
                );
                let exists = match std::fs::symlink_metadata(path) {
                    Ok(meta) if meta.file_type().is_dir() => true,
                    Ok(_) => {
                        return Err(StoreError::Unavailable(
                            "the store path is not a directory".into(),
                        ))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(error) => return Err(StoreError::Unavailable(error.to_string())),
                };
                if !exists && !create {
                    return Err(StoreError::Missing);
                }
                // Never create inside an existing directory: an empty one is an interrupted
                // creation or a loss, preserved for investigation. RocksDB writes its lock and
                // log files before it finds a store missing, so look first.
                if exists && !path.join("CURRENT").is_file() {
                    return Err(StoreError::Unavailable(
                        "the store directory holds no RocksDB store".into(),
                    ));
                }
                let kv = if exists {
                    RocksDbKvStore::open_existing(path)
                } else {
                    std::fs::create_dir(path)
                        .map_err(|error| StoreError::Unavailable(error.to_string()))?;
                    RocksDbKvStore::open(path)
                }
                .map_err(|error| StoreError::Unavailable(error.to_string()))?;
                (Arc::new(kv), reset)
            }
            DirectoryBackend::Shared(kv) => (
                Arc::clone(kv),
                "The shared directory store holds a format this build has no reader for. \
                 Development reset: stop every relay of the cluster and clear the FoundationDB \
                 keys under <fdb_subspace_prefix>directory-v1/. They hold public directory \
                 entries and forward state only: no keys and no funds."
                    .to_owned(),
            ),
        };
        let store = Arc::new(DirectoryStore::new(kv, Arc::clone(&self.objects)));
        store.check_format(create, &reset)?;
        *opened = Some(Arc::clone(&store));
        Ok(store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::large_values::LocalFsObjectStore;

    #[test]
    fn stored_values_round_trip_and_reject_unknown_tags() {
        let inline = Stored::Inline(b"exact".to_vec());
        assert_eq!(Stored::decode(&inline.encode()), Some(inline));
        let large = Stored::Large(LargeValueRef::of(&[7; 70_000]));
        assert_eq!(Stored::decode(&large.encode()), Some(large.clone()));
        assert_eq!(large.len(), 70_000);
        assert_eq!(Stored::decode(&[2, 1, 2]), None);
        assert_eq!(Stored::decode(&[1, 0]), None);
        assert_eq!(Stored::decode(&[]), None);
    }

    #[test]
    fn a_lease_has_one_holder_until_it_expires() {
        let owner = Owner::new(
            DirectoryBackend::Shared(Arc::new(RocksDbKvStore::open_temporary().unwrap())),
            Arc::new(LocalFsObjectStore::temporary()),
        );
        let store = owner.open(true).unwrap();
        assert!(store.hold_lease(b"sync", &[1; 16], 60_000).unwrap());
        assert!(!store.hold_lease(b"sync", &[2; 16], 60_000).unwrap());
        assert!(store.hold_lease(b"sync", &[1; 16], 0).unwrap());
        // Renewed with no time left: expired, so another holder takes it.
        assert!(store.hold_lease(b"sync", &[2; 16], 60_000).unwrap());
        assert!(!store.hold_lease(b"sync", &[1; 16], 60_000).unwrap());
        assert!(store.hold_lease(b"other", &[1; 16], 60_000).unwrap());
    }

    #[test]
    fn a_store_without_its_format_or_with_another_is_never_adopted() {
        let kv = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::temporary());
        let owner = Owner::new(DirectoryBackend::Shared(kv.clone()), objects.clone());
        assert_eq!(owner.open(false).unwrap_err(), StoreError::Missing);
        owner.open(true).unwrap();
        let other = Arc::new(RocksDbKvStore::open_temporary().unwrap());
        other.transact(|tx| tx.set(b"p/h/x", b"{}")).unwrap();
        let owner = Owner::new(DirectoryBackend::Shared(other.clone()), objects.clone());
        assert!(matches!(owner.open(true), Err(StoreError::OldFormat(_))));
        other.transact(|tx| tx.set(FORMAT_KEY, b"v0")).unwrap();
        let owner = Owner::new(DirectoryBackend::Shared(other), objects);
        let error = owner.open(true).unwrap_err();
        assert!(error.to_string().contains("directory-v1/"), "{error}");
    }

    #[test]
    fn a_single_node_store_is_created_only_when_asked_and_never_inside_an_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join(ROCKSDB_STORE);
        let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::temporary());
        let inside = DirectoryBackend::RocksDbInside(dir.path().to_path_buf());
        let owner = Owner::new(inside.clone(), objects.clone());
        assert_eq!(owner.open(false).unwrap_err(), StoreError::Missing);
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(owner.open(true), Err(StoreError::Unavailable(_))));
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"not a database").unwrap();
        assert!(matches!(owner.open(true), Err(StoreError::Unavailable(_))));
        assert_eq!(std::fs::read(&path).unwrap(), b"not a database");
        std::fs::remove_file(&path).unwrap();
        let first = owner.open(true).unwrap();
        assert!(Arc::ptr_eq(&first, &owner.open(false).unwrap()));
        drop((first, owner));
        let reopened = Owner::new(inside, objects);
        reopened.open(false).unwrap();
    }
}
