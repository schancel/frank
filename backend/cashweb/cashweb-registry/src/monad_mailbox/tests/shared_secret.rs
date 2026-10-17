use super::*;
use crate::store::kv_store::{
    FoundationDbKvStore, KvTransactionOp, MemoryKvStore, RocksDbKvStore, Versionstamp,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Barrier,
};

// Keep this literal independent of the implementation: it is a durable metadata allocation.
const KEY: &[u8] = b"M_relay_session_secret_v1";

enum Fault {
    None,
    ReadError,
    CasError,
    CommittedCasError,
    ConflictValue(Vec<u8>),
    MissingConflict,
}

/// Forces both initial reads to observe absence, or injects one precise bootstrap failure.
/// Its Debug implementation never prints the backing store or secret-bearing values.
struct BootstrapProbe {
    store: Arc<dyn RelayKvStore>,
    barrier: Option<Barrier>,
    fault: Fault,
    reads: AtomicUsize,
    swaps: AtomicUsize,
    wins: AtomicUsize,
}

impl BootstrapProbe {
    fn new(store: Arc<dyn RelayKvStore>) -> Self {
        Self {
            store,
            barrier: None,
            fault: Fault::None,
            reads: AtomicUsize::new(0),
            swaps: AtomicUsize::new(0),
            wins: AtomicUsize::new(0),
        }
    }
}

impl fmt::Debug for BootstrapProbe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BootstrapProbe(<redacted>)")
    }
}

impl RelayKvStore for BootstrapProbe {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        assert_eq!(key, KEY);
        let read = self.reads.fetch_add(1, Ordering::SeqCst);
        if self.barrier.is_some() {
            assert!(read < 2, "concurrent bootstrap unexpectedly retried a read");
        }
        if matches!(self.fault, Fault::ReadError) {
            return Err(KvError::Backend("injected read failure".into()));
        }
        let observed = self.store.get(key)?;
        if let Some(barrier) = &self.barrier {
            barrier.wait();
        }
        Ok(observed)
    }

    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        value: &[u8],
    ) -> Result<(), KvError> {
        assert_eq!(key, KEY);
        assert!(expected.is_none());
        assert_eq!(value.len(), 32);
        self.swaps.fetch_add(1, Ordering::SeqCst);
        match &self.fault {
            Fault::CasError => return Err(KvError::Backend("injected CAS failure".into())),
            Fault::MissingConflict => return Err(KvError::CasConflict { current: None }),
            Fault::ConflictValue(value) => self.store.put(key, value)?,
            _ => {}
        }
        self.store.compare_and_swap(key, expected, value)?;
        self.wins.fetch_add(1, Ordering::SeqCst);
        if matches!(self.fault, Fault::CommittedCasError) {
            return Err(KvError::Backend("injected uncertain CAS outcome".into()));
        }
        Ok(())
    }

    fn put(&self, _: &[u8], _: &[u8]) -> Result<(), KvError> {
        panic!("bootstrap must not unconditionally overwrite a secret")
    }
    fn delete(&self, _: &[u8]) -> Result<(), KvError> {
        panic!("bootstrap must not delete a secret")
    }
    fn put_versionstamped(
        &self,
        _: &[u8],
        _: &[u8],
        _: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        panic!("bootstrap must not allocate versionstamped secrets")
    }
    fn scan_prefix_range(
        &self,
        _: &[u8],
        _: Option<&[u8]>,
        _: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        panic!("bootstrap must not scan unrelated state")
    }
    fn execute_transaction(
        &self,
        _: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        panic!("bootstrap uses exactly the absent-key CAS")
    }
}

fn assert_mutual_mailbox_authorization(left: &SessionSecret, right: &SessionSecret) {
    for purpose in ["mailbox", "evm-rpc"] {
        // Do not print secret-derived material if convergence fails.
        assert!(left.derive(purpose) == right.derive(purpose));
    }
    assert!(left.derive("mailbox") != left.derive("evm-rpc"));
    let left = runtime_with(left, MailboxConfig::default());
    let right = runtime_with(right, MailboxConfig::default());
    let (left, right) = (left.as_enabled().unwrap(), right.as_enabled().unwrap());
    let recipient = Address([3; 20]);
    let request = binding(recipient);
    for (issuer, verifier) in [(left, right), (right, left)] {
        let challenge = issuer.issue_challenge(&request, 1_000);
        assert!(verifier.verify_challenge(&request, challenge, 1_000));
        let position = MailboxCursor::Inbox {
            timestamp: 7,
            payload_hash: [9; 32],
        };
        let cursor = issuer.encode_cursor(recipient, position);
        assert_eq!(
            verifier.decode_cursor(recipient, MailboxResource::Inbox, &cursor),
            Some(position)
        );
    }
}

fn assert_concurrent_bootstrap(store: Arc<dyn RelayKvStore>) {
    let mut probe = BootstrapProbe::new(store.clone());
    probe.barrier = Some(Barrier::new(2));
    let (left, right) = std::thread::scope(|scope| {
        let left = scope.spawn(|| SessionSecret::from_kv_store(&probe).unwrap());
        let right = scope.spawn(|| SessionSecret::from_kv_store(&probe).unwrap());
        (left.join().unwrap(), right.join().unwrap())
    });
    assert_eq!(probe.reads.load(Ordering::SeqCst), 2);
    assert_eq!(probe.swaps.load(Ordering::SeqCst), 2);
    assert_eq!(probe.wins.load(Ordering::SeqCst), 1);
    assert_eq!(store.get(KEY).unwrap().unwrap().len(), 32);
    assert_mutual_mailbox_authorization(&left, &right);
    assert_eq!(format!("{left:?}"), "SessionSecret(<redacted>)");
}

#[test]
fn concurrent_memory_initializers_share_one_winner_and_mailbox_authentication() {
    assert_concurrent_bootstrap(Arc::new(MemoryKvStore::new()));
}

#[test]
fn concurrent_rocks_initializers_share_one_winner_and_reopen_without_rotation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("relay-kv.rocksdb");
    let before = {
        // RocksDB supplies one local backend handle; this is not a cross-process Rocks CAS claim.
        let store = Arc::new(RocksDbKvStore::open(&path).unwrap());
        assert_concurrent_bootstrap(store.clone());
        SessionSecret::from_kv_store(store.as_ref()).unwrap()
    };
    let reopened = RocksDbKvStore::open(&path).unwrap();
    let after = SessionSecret::from_kv_store(&reopened).unwrap();
    assert_mutual_mailbox_authorization(&before, &after);
    assert!(!directory.path().join("relay.session-secret").exists());
}

#[test]
fn injected_subspace_separates_relay_sessions_and_other_metadata() {
    // The existing subspace wrapper is backed by memory here, not a live FDB cluster.
    let backing = Arc::new(MemoryKvStore::new());
    let first = FoundationDbKvStore::new("unused.cluster", b"relay-a/".to_vec(), backing.clone());
    let replica = FoundationDbKvStore::new("unused.cluster", b"relay-a/".to_vec(), backing.clone());
    let other = FoundationDbKvStore::new("unused.cluster", b"relay-b/".to_vec(), backing.clone());
    first.put(b"M_vapid_privkey", &[17; 32]).unwrap();
    let left = SessionSecret::from_kv_store(&first).unwrap();
    let right = SessionSecret::from_kv_store(&replica).unwrap();
    let stranger = SessionSecret::from_kv_store(&other).unwrap();
    assert_mutual_mailbox_authorization(&left, &right);
    assert!(left.derive("mailbox") != stranger.derive("mailbox"));
    assert!(first.get(b"M_vapid_privkey").unwrap() == Some(vec![17; 32]));
    assert_eq!(
        backing
            .scan_prefix_range(b"relay-", None, 10)
            .unwrap()
            .len(),
        3
    );
    let left = runtime_with(&left, MailboxConfig::default());
    let stranger = runtime_with(&stranger, MailboxConfig::default());
    let request = binding(Address([3; 20]));
    let challenge = left.as_enabled().unwrap().issue_challenge(&request, 1_000);
    assert!(!stranger
        .as_enabled()
        .unwrap()
        .verify_challenge(&request, challenge, 1_000));
    let position = MailboxCursor::Inbox {
        timestamp: 7,
        payload_hash: [9; 32],
    };
    let cursor = left
        .as_enabled()
        .unwrap()
        .encode_cursor(request.recipient, position);
    assert!(stranger
        .as_enabled()
        .unwrap()
        .decode_cursor(request.recipient, MailboxResource::Inbox, &cursor)
        .is_none());
}

#[test]
fn corrupt_existing_shared_secret_is_never_replaced_in_memory_or_rocks() {
    let directory = tempfile::tempdir().unwrap();
    let stores: [Arc<dyn RelayKvStore>; 2] = [
        Arc::new(MemoryKvStore::new()),
        Arc::new(RocksDbKvStore::open(directory.path().join("relay-kv")).unwrap()),
    ];
    for store in stores {
        for length in [0, 1, 31, 33, 64] {
            let corrupt = vec![0xa5; length];
            store.put(KEY, &corrupt).unwrap();
            let probe = BootstrapProbe::new(store.clone());
            assert!(matches!(
                SessionSecret::from_kv_store(&probe),
                Err(KvError::Backend(_))
            ));
            assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
            assert_eq!(probe.swaps.load(Ordering::SeqCst), 0);
            assert!(store.get(KEY).unwrap() == Some(corrupt));
        }
    }
}

#[test]
fn corrupt_or_missing_cas_winner_fails_without_retry_or_rewrite() {
    for fault in [
        Fault::ConflictValue(vec![]),
        Fault::ConflictValue(vec![0xa5; 33]),
        Fault::MissingConflict,
    ] {
        let store = Arc::new(MemoryKvStore::new());
        let mut probe = BootstrapProbe::new(store.clone());
        probe.fault = fault;
        assert!(SessionSecret::from_kv_store(&probe).is_err());
        assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
        assert_eq!(probe.swaps.load(Ordering::SeqCst), 1);
        assert_eq!(probe.wins.load(Ordering::SeqCst), 0);
        match &probe.fault {
            Fault::ConflictValue(corrupt) => {
                assert!(store.get(KEY).unwrap().as_ref() == Some(corrupt))
            }
            Fault::MissingConflict => assert!(store.get(KEY).unwrap().is_none()),
            _ => unreachable!(),
        }
    }
}

#[test]
fn read_and_definite_cas_errors_propagate_without_fallback() {
    for (fault, error, swaps) in [
        (Fault::ReadError, "injected read failure", 0),
        (Fault::CasError, "injected CAS failure", 1),
    ] {
        let store = Arc::new(MemoryKvStore::new());
        let mut probe = BootstrapProbe::new(store.clone());
        probe.fault = fault;
        assert_eq!(
            SessionSecret::from_kv_store(&probe).err(),
            Some(KvError::Backend(error.into()))
        );
        assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
        assert_eq!(probe.swaps.load(Ordering::SeqCst), swaps);
        assert!(store.get(KEY).unwrap().is_none());
    }
}

#[test]
fn uncertain_committed_cas_propagates_and_a_later_open_uses_the_original_winner() {
    let store = Arc::new(MemoryKvStore::new());
    let mut probe = BootstrapProbe::new(store.clone());
    probe.fault = Fault::CommittedCasError;
    assert_eq!(
        SessionSecret::from_kv_store(&probe).err(),
        Some(KvError::Backend("injected uncertain CAS outcome".into()))
    );
    assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
    assert_eq!(probe.swaps.load(Ordering::SeqCst), 1);
    assert_eq!(probe.wins.load(Ordering::SeqCst), 1);
    let committed = store.get(KEY).unwrap().unwrap();
    // This explicit later initialization may read the winner; the uncertain call itself failed.
    let reopened = SessionSecret::from_kv_store(&probe).unwrap();
    assert_eq!(probe.reads.load(Ordering::SeqCst), 2);
    assert_eq!(probe.swaps.load(Ordering::SeqCst), 1);
    assert!(store.get(KEY).unwrap() == Some(committed.clone()));
    let winner = SessionSecret(committed.as_slice().try_into().unwrap());
    assert_mutual_mailbox_authorization(&winner, &reopened);
}
