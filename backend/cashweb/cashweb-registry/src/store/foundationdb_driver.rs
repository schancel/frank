//! Live FoundationDB 7.3 driver. Host composition must boot the process-wide FDB
//! network and retain its guard until all drivers are dropped. Methods block; async
//! hosts must use blocking workers. Ambiguous commits are surfaced without retry.
//! Multiple stamped mutations are rejected: native FDB stamps are transaction-wide,
//! whereas the current KV contract assigns distinct stamps to batch mutations.
use super::kv_store::{
    encode_set_versionstamped_key_param, resolve_set_versionstamped_key_param, KvError,
    KvTransactionOp, RelayKvStore, Versionstamp,
};
use foundationdb::{
    options::{MutationType, TransactionOption},
    Database, FdbError, KeySelector, RangeOption, Transaction,
};
use futures::{executor::block_on, TryStreamExt};
use std::sync::Arc;

/// Synchronous transaction driver for an explicitly selected live FoundationDB cluster.
pub struct LiveFoundationDbDriver {
    database: Arc<Database>,
}
impl std::fmt::Debug for LiveFoundationDbDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveFoundationDbDriver")
            .finish_non_exhaustive()
    }
}

enum AttemptError {
    Fdb(FdbError),
    Kv(KvError),
}
impl From<FdbError> for AttemptError {
    fn from(e: FdbError) -> Self {
        Self::Fdb(e)
    }
}
fn backend(e: impl std::fmt::Display) -> KvError {
    KvError::Backend(e.to_string())
}
impl LiveFoundationDbDriver {
    /// Open an explicit cluster file after the host boots FoundationDB's network.
    pub fn open(cluster_file: &str) -> Result<Self, KvError> {
        if cluster_file.is_empty() {
            return Err(KvError::InvalidArgument("empty FDB cluster file".into()));
        }
        Ok(Self {
            database: Arc::new(Database::new(Some(cluster_file)).map_err(backend)?),
        })
    }
    fn run<T>(
        &self,
        stamped: bool,
        mut apply: impl FnMut(&Transaction) -> Result<T, AttemptError>,
    ) -> Result<(T, Option<Versionstamp>), KvError> {
        let mut tx = self.database.create_trx().map_err(backend)?;
        tx.set_option(TransactionOption::Timeout(10_000))
            .map_err(backend)?;
        for _ in 0..10 {
            let output = match apply(&tx) {
                Ok(v) => v,
                Err(AttemptError::Kv(e)) => return Err(e),
                Err(AttemptError::Fdb(e)) => {
                    tx = block_on(tx.on_error(e)).map_err(backend)?;
                    continue;
                }
            };
            let stamp = stamped.then(|| tx.get_versionstamp());
            match block_on(tx.commit()) {
                Ok(_committed) => {
                    let stamp = stamp
                        .map(|future| {
                            let bytes = block_on(future).map_err(backend)?;
                            Versionstamp::try_from_slice(bytes.as_ref())
                        })
                        .transpose()?;
                    return Ok((output, stamp));
                }
                Err(e) if e.is_maybe_committed() => {
                    return Err(KvError::Backend(format!(
                        "FoundationDB commit outcome unknown; reconcile before retry: {e}"
                    )))
                }
                Err(e) => tx = block_on(e.on_error()).map_err(backend)?,
            }
        }
        Err(KvError::Backend("FoundationDB retry limit exceeded".into()))
    }
}
impl RelayKvStore for LiveFoundationDbDriver {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.run(false, |tx| {
            Ok(block_on(tx.get(key, false))?.map(|v| v.to_vec()))
        })
        .map(|(v, _)| v)
    }
    fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
        self.execute_transaction(vec![KvTransactionOp::Put {
            key: key.to_vec(),
            value: value.to_vec(),
        }])?;
        Ok(())
    }
    fn delete(&self, key: &[u8]) -> Result<(), KvError> {
        self.execute_transaction(vec![KvTransactionOp::Delete { key: key.to_vec() }])?;
        Ok(())
    }
    fn compare_and_swap(
        &self,
        key: &[u8],
        expected: Option<&[u8]>,
        new_value: &[u8],
    ) -> Result<(), KvError> {
        self.execute_transaction(vec![KvTransactionOp::CheckAndSet {
            key: key.to_vec(),
            expected: expected.map(<[u8]>::to_vec),
            new_value: new_value.to_vec(),
        }])?;
        Ok(())
    }
    fn put_versionstamped(
        &self,
        prefix: &[u8],
        suffix: &[u8],
        value: &[u8],
    ) -> Result<(Vec<u8>, Versionstamp), KvError> {
        let param = encode_set_versionstamped_key_param(prefix, suffix)?;
        let stamp = self
            .execute_transaction(vec![KvTransactionOp::SetVersionstampedKey {
                key_prefix: prefix.to_vec(),
                key_suffix: suffix.to_vec(),
                value: value.to_vec(),
            }])?
            .ok_or_else(|| backend("missing committed FDB stamp"))?;
        Ok((resolve_set_versionstamped_key_param(&param, stamp)?, stamp))
    }
    fn scan_prefix_range(
        &self,
        prefix: &[u8],
        after: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        // System-key space is deliberately excluded from normal user-key scans.
        let mut end = prefix.to_vec();
        match end.iter().rposition(|b| *b != 0xff) {
            Some(i) => {
                end[i] += 1;
                end.truncate(i + 1);
            }
            None => end = vec![0xff],
        }
        let start = match after {
            Some(a) if a >= prefix => {
                let mut s = a.to_vec();
                s.push(0);
                s
            }
            _ => prefix.to_vec(),
        };
        self.scan_range(&start, &end, limit)
    }
    fn scan_range(
        &self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        self.run(false, |tx| {
            let mut range = RangeOption::from((
                KeySelector::first_greater_or_equal(start),
                KeySelector::first_greater_or_equal(end),
            ));
            range.limit = Some(limit.min(i32::MAX as usize));
            let values = block_on(
                tx.get_ranges_keyvalues(range, false)
                    .try_collect::<Vec<_>>(),
            )?;
            Ok(values
                .into_iter()
                .map(|v| (v.key().to_vec(), v.value().to_vec()))
                .collect())
        })
        .map(|(rows, _)| rows)
    }
    fn execute_transaction(
        &self,
        ops: Vec<KvTransactionOp>,
    ) -> Result<Option<Versionstamp>, KvError> {
        let count = ops
            .iter()
            .filter(|op| matches!(op, KvTransactionOp::SetVersionstampedKey { .. }))
            .count();
        if count > 1 {
            return Err(KvError::InvalidArgument("multiple stamped mutations require a separately reviewed transaction-wide stamp contract".into()));
        }
        self.run(count == 1, |tx| {
            // All preconditions refer to the original snapshot, before any mutation.
            for op in &ops {
                if let KvTransactionOp::CheckAndSet { key, expected, .. } = op {
                    let current = block_on(tx.get(key, false))?.map(|v| v.to_vec());
                    if &current != expected {
                        return Err(AttemptError::Kv(KvError::CasConflict { current }));
                    }
                }
            }
            for op in &ops {
                match op {
                    KvTransactionOp::Put { key, value }
                    | KvTransactionOp::CheckAndSet {
                        key,
                        new_value: value,
                        ..
                    } => tx.set(key, value),
                    KvTransactionOp::Delete { key } => tx.clear(key),
                    KvTransactionOp::SetVersionstampedKey {
                        key_prefix,
                        key_suffix,
                        value,
                    } => {
                        let param = encode_set_versionstamped_key_param(key_prefix, key_suffix)
                            .map_err(AttemptError::Kv)?;
                        tx.atomic_op(&param, value, MutationType::SetVersionstampedKey);
                    }
                }
            }
            Ok(())
        })
        .map(|(_, stamp)| stamp)
    }
}

#[cfg(test)]
mod tests {
    use super::super::kv_store::FoundationDbKvStore;
    use super::*;
    use std::sync::Barrier;

    /// Requires native libfdb_c and a real disposable FDB cluster. Not a simulator.
    /// FRANK_FDB_CLUSTER_FILE=/path/fdb.cluster cargo test -p cashweb-registry \
    ///   --features foundationdb live_foundationdb_contract -- --ignored --nocapture
    #[test]
    #[ignore = "requires explicitly configured live FoundationDB cluster"]
    fn live_foundationdb_contract() {
        let cluster_file = std::env::var("FRANK_FDB_CLUSTER_FILE")
            .expect("FRANK_FDB_CLUSTER_FILE is required; refusing the default cluster");
        // SAFETY: this single test owns process-wide initialization and drops all DB
        // handles before the network guard. Do not add a second network-booting test.
        let _network = unsafe { foundationdb::boot() };
        let prefix = format!("frank-driver-contract:{}:", uuid::Uuid::new_v4()).into_bytes();
        let open = || {
            FoundationDbKvStore::new(
                cluster_file.clone(),
                prefix.clone(),
                Arc::new(LiveFoundationDbDriver::open(&cluster_file).unwrap()),
            )
        };
        let store = open();
        assert_eq!(store.get(b"plain").unwrap(), None);
        store.put(b"plain", b"value").unwrap();
        assert_eq!(open().get(b"plain").unwrap(), Some(b"value".to_vec()));
        store.delete(b"plain").unwrap();
        assert_eq!(store.get(b"plain").unwrap(), None);

        // Exercise the production VAPID bootstrap against ten independent clients,
        // not just the lower-level CAS primitive or simulated storage.
        use crate::store::notification_policy::VapidKeyPair;
        let bootstrap_barrier = Arc::new(Barrier::new(10));
        let bootstraps: Vec<_> = (0..10)
            .map(|_| {
                let replica = open();
                let barrier = bootstrap_barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    VapidKeyPair::from_kv_store(&replica).unwrap()
                })
            })
            .collect();
        let pairs: Vec<_> = bootstraps.into_iter().map(|h| h.join().unwrap()).collect();
        for pair in &pairs[1..] {
            assert_eq!(pair.public_key_base64url(), pairs[0].public_key_base64url());
            assert_eq!(pair.private_key_bytes(), pairs[0].private_key_bytes());
        }
        let reopened_pair = VapidKeyPair::from_kv_store(&open()).unwrap();
        assert_eq!(
            reopened_pair.public_key_base64url(),
            pairs[0].public_key_base64url()
        );
        assert_eq!(
            reopened_pair.private_key_bytes(),
            pairs[0].private_key_bytes()
        );

        store.put(b"epoch", b"zero").unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let replicas: Vec<_> = (0..8)
            .map(|i| {
                let replica = open();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    replica.compare_and_swap(b"epoch", Some(b"zero"), &[i])
                })
            })
            .collect();
        let results: Vec<_> = replicas.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(KvError::CasConflict { .. })))
                .count(),
            7
        );

        // A failed precondition must not leak preceding mutations.
        assert!(matches!(
            store.execute_transaction(vec![
                KvTransactionOp::Put {
                    key: b"leaked".to_vec(),
                    value: vec![1]
                },
                KvTransactionOp::CheckAndSet {
                    key: b"epoch".to_vec(),
                    expected: Some(b"zero".to_vec()),
                    new_value: vec![9]
                },
            ]),
            Err(KvError::CasConflict { .. })
        ));
        assert_eq!(store.get(b"leaked").unwrap(), None);

        // Preconditions inspect original state even when the batch first overwrites it.
        store.put(b"precondition", b"original").unwrap();
        store
            .execute_transaction(vec![
                KvTransactionOp::Put {
                    key: b"precondition".to_vec(),
                    value: b"intermediate".to_vec(),
                },
                KvTransactionOp::CheckAndSet {
                    key: b"precondition".to_vec(),
                    expected: Some(b"original".to_vec()),
                    new_value: b"final".to_vec(),
                },
            ])
            .unwrap();
        assert_eq!(store.get(b"precondition").unwrap(), Some(b"final".to_vec()));

        let mut keys = Vec::new();
        let mut previous = None;
        for i in 0..5 {
            let (key, stamp) = store.put_versionstamped(b"messages:", &[i], &[i]).unwrap();
            assert!(previous.map_or(true, |prev| stamp > prev));
            assert_eq!(
                &key[b"messages:".len()..b"messages:".len() + 10],
                stamp.as_bytes()
            );
            assert_eq!(open().get(&key).unwrap(), Some(vec![i]));
            previous = Some(stamp);
            keys.push(key);
        }
        let page = store
            .scan_prefix_range(b"messages:", Some(&keys[1]), 2)
            .unwrap();
        assert_eq!(
            page.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
            keys[2..4]
        );
        assert_eq!(store.scan_range(&keys[1], &keys[4], 10).unwrap().len(), 3);
        assert!(store
            .scan_prefix_range(b"messages:", None, 0)
            .unwrap()
            .is_empty());
        let stamp = store
            .execute_transaction(vec![
                KvTransactionOp::CheckAndSet {
                    key: b"head".to_vec(),
                    expected: None,
                    new_value: b"one".to_vec(),
                },
                KvTransactionOp::SetVersionstampedKey {
                    key_prefix: b"messages:".to_vec(),
                    key_suffix: b"batch".to_vec(),
                    value: b"atomic".to_vec(),
                },
            ])
            .unwrap()
            .unwrap();
        assert!(stamp > previous.unwrap());
        let mut key = b"messages:".to_vec();
        key.extend_from_slice(stamp.as_bytes());
        key.extend_from_slice(b"batch");
        let reopened = open();
        assert_eq!(reopened.get(b"head").unwrap(), Some(b"one".to_vec()));
        assert_eq!(reopened.get(&key).unwrap(), Some(b"atomic".to_vec()));
        let other = FoundationDbKvStore::new(
            cluster_file.clone(),
            format!("frank-driver-contract-other:{}:", uuid::Uuid::new_v4()).into_bytes(),
            Arc::new(LiveFoundationDbDriver::open(&cluster_file).unwrap()),
        );
        assert_eq!(other.get(b"head").unwrap(), None);
        other.put(b"head", b"other-head").unwrap();
        other.put(b"other-only", b"other-value").unwrap();
        assert_eq!(store.get(b"head").unwrap(), Some(b"one".to_vec()));
        let original_rows = store.scan_prefix_range(b"", None, 1000).unwrap();
        assert!(!original_rows
            .iter()
            .any(|(key, value)| key == b"other-only" || value == b"other-head"));
        assert_eq!(other.scan_prefix_range(b"", None, 1000).unwrap().len(), 2);

        let stamped = || KvTransactionOp::SetVersionstampedKey {
            key_prefix: b"unsupported:".to_vec(),
            key_suffix: vec![],
            value: vec![],
        };
        assert!(matches!(
            store.execute_transaction(vec![stamped(), stamped()]),
            Err(KvError::InvalidArgument(_))
        ));
        assert!(store
            .scan_prefix_range(b"unsupported:", None, 10)
            .unwrap()
            .is_empty());
        // Remove only this invocation's random test subspace, never preexisting data.
        for (key, _) in store.scan_prefix_range(b"", None, 1000).unwrap() {
            store.delete(&key).unwrap();
        }
        for (key, _) in other.scan_prefix_range(b"", None, 1000).unwrap() {
            other.delete(&key).unwrap();
        }
        eprintln!("real FDB contract passed: 10 concurrent VAPID bootstraps, 8 CAS replicas, atomic CAS+append, pagination, reopen and subspace isolation");
    }
}
