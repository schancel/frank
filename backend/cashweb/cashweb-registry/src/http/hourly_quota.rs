//! Fixed-hour quota admission. Standalone relays retain process-local counters; cluster
//! composition supplies one shared transaction store. A failed shared charge never falls back.
//!
//! Shared keys under the host-selected `hourly-quotas-v1/` subspace:
//! `format`; `q/` + UTC hour (u64 BE) + canonical relay-network length/name + domain byte +
//! `n` (distinct payer count) or `u` + encoded payer (usage). Values are u32 BE. Domains retain
//! the existing family-wide sharing, not a new allowance per target chain or transport.
//! A bucket has authority only for its hour. Cleanup clears at most 128 rows per call and
//! retains the previous hour for ordinary clock skew; it never clears the current bucket.
use crate::store::kv_store::{KvError, RelayKvStore, Transact};
use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv6Addr},
    sync::{Arc, Mutex},
};

const MAX_QUOTA_KEYS: usize = 100_000;
const FORMAT: &[u8] = b"frank-hourly-quotas-v1";
const ROWS: &[u8] = b"q/";
const SWEEP_PAGE: usize = 128;

/// Quota storage selected by host composition. No shared-store error selects Local.
#[derive(Debug, Clone)]
pub struct QuotaBackend {
    shared: Option<SharedQuota>,
}

#[derive(Debug, Clone)]
struct SharedQuota {
    chain_identifier: String,
    store: Arc<dyn RelayKvStore>,
    workers: Arc<tokio::sync::Semaphore>,
    worker_capacity: usize,
}

impl QuotaBackend {
    /// Explicit existing standalone behavior; never selected as shared-store error recovery.
    pub fn local() -> Self {
        Self { shared: None }
    }

    /// Select shared storage only for a canonical, protocol-registered network.
    pub fn shared(
        chain_identifier: &str,
        store: Arc<dyn RelayKvStore>,
        max_blocking: usize,
    ) -> Result<Self, KvError> {
        if max_blocking == 0 {
            return Err(KvError::InvalidArgument(
                "zero quota worker capacity".into(),
            ));
        }
        if cashweb_config::protocol_chain(chain_identifier).is_none() {
            return Err(KvError::InvalidArgument(
                "unknown canonical quota network".into(),
            ));
        }
        Ok(Self {
            shared: Some(SharedQuota {
                chain_identifier: chain_identifier.to_owned(),
                store,
                workers: Arc::new(tokio::sync::Semaphore::new(max_blocking)),
                worker_capacity: max_blocking,
            }),
        })
    }

    /// Probe or initialize only the quota namespace, on a blocking worker during startup.
    pub fn probe(&self) -> Result<(), KvError> {
        if let Some(shared) = &self.shared {
            let store = &shared.store;
            store.transact(|tx| match tx.get(b"format")? {
                Some(value) if value == FORMAT => Ok(()),
                Some(_) => Err(KvError::Backend(
                    "unsupported hourly quota format; reset only the hourly-quotas-v1 subspace"
                        .into(),
                )),
                None if !tx.scan_prefix(b"", None, 1)?.is_empty() => Err(KvError::Backend(
                    "unmarked hourly quota store; reset only the hourly-quotas-v1 subspace".into(),
                )),
                None => tx.set(b"format", FORMAT),
            })?;
        }
        Ok(())
    }

    /// Stop new shared work and wait for every already-submitted blocking transaction.
    /// Host composition calls this before dropping the process-wide FDB network.
    pub async fn close_and_drain(&self) {
        if let Some(shared) = &self.shared {
            shared.workers.close();
            while shared.workers.available_permits() != shared.worker_capacity {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }
    }

    /// One bounded, idempotent cleanup page. An error changes no admission decision.
    pub async fn sweep_expired(&self, now_seconds: u64) -> Result<usize, KvError> {
        let Some(shared) = &self.shared else {
            return Ok(0);
        };
        let permit = shared
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| KvError::Backend("hourly quota worker capacity unavailable".into()))?;
        let store = shared.store.clone();
        let cutoff = [ROWS, &(now_seconds / 3600).saturating_sub(1).to_be_bytes()].concat();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            store.transact(|tx| {
                let rows = tx.get_range(ROWS, &cutoff, SWEEP_PAGE)?;
                for (key, _) in &rows {
                    tx.clear(key)?;
                }
                Ok(rows.len())
            })
        })
        .await
        .map_err(|_| KvError::Backend("hourly quota cleanup worker failed".into()))?
    }
}

#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub(crate) enum QuotaDomain {
    DirectoryEnrollment = 0,
    EvmCustomer = 1,
    EvmAnonymous = 2,
    BitcoinAnonymous = 3,
    BitcoinCustomer = 4,
    SolanaCustomer = 5,
    SolanaAnonymous = 6,
}

pub(crate) trait QuotaIdentity: Eq + Hash + Clone + Send {
    fn quota_bytes(&self) -> Vec<u8>;
}
impl QuotaIdentity for IpAddr {
    fn quota_bytes(&self) -> Vec<u8> {
        match self {
            IpAddr::V4(ip) => [vec![4], ip.octets().to_vec()].concat(),
            IpAddr::V6(ip) => [vec![6], ip.octets().to_vec()].concat(),
        }
    }
}
impl QuotaIdentity for crate::evm_rpc::Address {
    fn quota_bytes(&self) -> Vec<u8> {
        self.0.to_vec()
    }
}
#[cfg(test)]
impl QuotaIdentity for &'static str {
    fn quota_bytes(&self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct QuotaSnapshot {
    pub(crate) limit: u32,
    pub(crate) remaining: u32,
    pub(crate) reset_unix_seconds: u64,
}
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum QuotaDenial {
    Exhausted { reset_unix_seconds: u64 },
    Disabled,
    RequestTooLarge,
    Capacity,
    Unavailable,
}
#[derive(Debug, Clone, Copy)]
struct Usage {
    units: u32,
}

/// A burstable UTC-hour allowance. Shared counters are charged on blocking workers, before
/// any externally visible operation. An unknown commit is a denial, never permission to send.
#[derive(Debug)]
pub(crate) struct FixedHourQuota<K> {
    limit: u32,
    domain: QuotaDomain,
    backend: QuotaBackend,
    state: Mutex<QuotaState<K>>,
}
#[derive(Debug)]
struct QuotaState<K> {
    hour: Option<u64>,
    usage: HashMap<K, Usage>,
}

impl<K: QuotaIdentity> FixedHourQuota<K> {
    #[cfg(test)]
    pub(crate) fn new(limit: u32) -> Self {
        Self::with_backend(limit, QuotaDomain::EvmCustomer, QuotaBackend::local())
    }
    pub(crate) fn with_backend(limit: u32, domain: QuotaDomain, backend: QuotaBackend) -> Self {
        Self {
            limit,
            domain,
            backend,
            state: Mutex::new(QuotaState {
                hour: None,
                usage: HashMap::new(),
            }),
        }
    }
    pub(crate) async fn charge(
        &self,
        key: K,
        units: u32,
        now_seconds: u64,
    ) -> Result<QuotaSnapshot, QuotaDenial> {
        if self.limit == 0 {
            return Err(QuotaDenial::Disabled);
        }
        if units > self.limit {
            return Err(QuotaDenial::RequestTooLarge);
        }
        let hour = {
            let mut state = self.state.lock().map_err(|_| QuotaDenial::Unavailable)?;
            let hour = now_seconds / 3600;
            if state.hour.map_or(true, |active| hour > active) {
                state.hour = Some(hour);
                state.usage.clear();
            }
            let active = state.hour.expect("initialized above");
            if self.backend.shared.is_none() {
                if state.usage.len() >= MAX_QUOTA_KEYS && !state.usage.contains_key(&key) {
                    return Err(QuotaDenial::Capacity);
                }
                let entry = state.usage.entry(key).or_insert(Usage { units: 0 });
                let next = entry
                    .units
                    .checked_add(units)
                    .ok_or(QuotaDenial::Unavailable)?;
                if next > self.limit {
                    return Err(QuotaDenial::Exhausted {
                        reset_unix_seconds: (active + 1) * 3600,
                    });
                }
                entry.units = next;
                return Ok(QuotaSnapshot {
                    limit: self.limit,
                    remaining: self.limit - next,
                    reset_unix_seconds: (active + 1) * 3600,
                });
            }
            active // Preserve the existing per-handle clock rollback behavior; no shared clock policy.
        };
        let shared = self.backend.shared.as_ref().expect("shared branch above");
        let chain_identifier = &shared.chain_identifier;
        let store = &shared.store;
        let mut prefix = [ROWS, &hour.to_be_bytes()].concat();
        prefix.extend_from_slice(&(chain_identifier.len() as u16).to_be_bytes());
        prefix.extend_from_slice(chain_identifier.as_bytes());
        prefix.push(self.domain as u8);
        let count_key = [&prefix[..], b"n"].concat();
        let usage_key = [&prefix[..], b"u", &key.quota_bytes()].concat();
        let permit = shared
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| QuotaDenial::Unavailable)?;
        let store = store.clone();
        let limit = self.limit;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            store.transact(|tx| {
                let decode = |bytes: Vec<u8>| -> Result<u32, KvError> {
                    bytes
                        .try_into()
                        .map(u32::from_be_bytes)
                        .map_err(|_| KvError::Backend("corrupt hourly quota counter".into()))
                };
                let current = tx.get(&usage_key)?.map(decode).transpose()?;
                let count = if current.is_none() {
                    let count = tx.get(&count_key)?.map(decode).transpose()?.unwrap_or(0);
                    if count >= MAX_QUOTA_KEYS as u32 {
                        return Ok(Err(QuotaDenial::Capacity));
                    }
                    Some(count)
                } else {
                    None
                };
                let next = match current.unwrap_or(0).checked_add(units) {
                    Some(next) => next,
                    None => return Ok(Err(QuotaDenial::Unavailable)),
                };
                if next > limit {
                    return Ok(Err(QuotaDenial::Exhausted {
                        reset_unix_seconds: (hour + 1) * 3600,
                    }));
                }
                tx.set(&usage_key, &next.to_be_bytes())?;
                if let Some(count) = count {
                    tx.set(&count_key, &(count + 1).to_be_bytes())?;
                }
                Ok(Ok(QuotaSnapshot {
                    limit,
                    remaining: limit - next,
                    reset_unix_seconds: (hour + 1) * 3600,
                }))
            })
        })
        .await
        .map_err(|_| QuotaDenial::Unavailable)?
        .map_err(|_: KvError| QuotaDenial::Unavailable)?
    }
}

pub(crate) fn normalize_quota_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(ip) => IpAddr::V4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => IpAddr::V4(ip),
            None => IpAddr::V6(Ipv6Addr::from(u128::from(ip) & (!0u128 << 64))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn permits_bursts_and_resets_only_at_the_hour_boundary() {
        let quota = FixedHourQuota::new(5);
        assert_eq!(quota.charge("a", 5, 3599).await.unwrap().remaining, 0);
        assert_eq!(
            quota.charge("a", 1, 3599).await,
            Err(QuotaDenial::Exhausted {
                reset_unix_seconds: 3600
            })
        );
        assert_eq!(quota.charge("a", 1, 3600).await.unwrap().remaining, 4);
        assert_eq!(
            quota.charge("a", 6, 3600).await,
            Err(QuotaDenial::RequestTooLarge)
        );
        assert_eq!(
            FixedHourQuota::new(0).charge("a", 1, 3600).await,
            Err(QuotaDenial::Disabled)
        );

        let quota = FixedHourQuota::new(1);
        assert_eq!(quota.charge("a", 1, 3600).await.unwrap().remaining, 0);
        assert_eq!(quota.charge("b", 1, 3599).await.unwrap().remaining, 0);
        assert_eq!(
            quota.charge("a", 1, 3600).await,
            Err(QuotaDenial::Exhausted {
                reset_unix_seconds: 7200
            })
        );
    }

    #[test]
    fn quota_ip_preserves_ipv4_and_groups_native_ipv6_by_prefix() {
        assert_eq!(
            normalize_quota_ip("::ffff:192.0.2.1".parse().unwrap()),
            "192.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalize_quota_ip("::ffff:192.0.2.2".parse().unwrap()),
            "192.0.2.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalize_quota_ip("2001:db8:1:2::1234".parse().unwrap()),
            "2001:db8:1:2::".parse::<IpAddr>().unwrap()
        );
    }
    fn shared_store() -> (tempfile::TempDir, Arc<dyn RelayKvStore>, QuotaBackend) {
        let directory = tempfile::tempdir().unwrap();
        let store: Arc<dyn RelayKvStore> = Arc::new(
            crate::store::kv_store::RocksDbKvStore::open(directory.path().join("quota")).unwrap(),
        );
        let backend = QuotaBackend::shared("monad-regtest", store.clone(), 64).unwrap();
        backend.probe().unwrap();
        (directory, store, backend)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_weighted_charge_is_atomic_and_survives_handle_restart() {
        let (_directory, store, backend) = shared_store();
        // Negative control: the prior replica-local ownership permits three independent budgets.
        let local: Vec<_> = (0..3).map(|_| FixedHourQuota::new(7)).collect();
        let mut local_accepted = 0;
        for index in 0..24 {
            if local[index % 3].charge("customer", 2, 7200).await.is_ok() {
                local_accepted += 1;
            }
        }
        assert_eq!(local_accepted, 9);
        let replicas: Vec<_> = (0..3)
            .map(|_| {
                Arc::new(FixedHourQuota::with_backend(
                    7,
                    QuotaDomain::EvmCustomer,
                    backend.clone(),
                ))
            })
            .collect();
        let mut workers = Vec::new();
        for index in 0..24 {
            let quota = replicas[index % 3].clone();
            workers.push(tokio::spawn(async move {
                quota.charge("customer", 2, 7200).await
            }));
        }
        let mut accepted = 0;
        for worker in workers {
            match worker.await.unwrap() {
                Ok(_) => accepted += 1,
                Err(QuotaDenial::Exhausted {
                    reset_unix_seconds: 10800,
                }) => {}
                result => panic!("unexpected quota outcome: {result:?}"),
            }
        }
        assert_eq!(
            accepted, 3,
            "three replicas share seven units, not seven each"
        );
        let restarted = FixedHourQuota::with_backend(7, QuotaDomain::EvmCustomer, backend.clone());
        assert_eq!(
            restarted
                .charge("customer", 1, 7200)
                .await
                .unwrap()
                .remaining,
            0
        );
        assert!(matches!(
            replicas[0].charge("customer", 1, 7200).await,
            Err(QuotaDenial::Exhausted { .. })
        ));
        assert_eq!(
            restarted
                .charge("another", 7, 7200)
                .await
                .unwrap()
                .remaining,
            0
        );
        for replica in &replicas {
            assert!(
                replica.state.lock().unwrap().usage.is_empty(),
                "shared counters have no local usage mirror"
            );
        }
        for domain in [
            QuotaDomain::DirectoryEnrollment,
            QuotaDomain::EvmAnonymous,
            QuotaDomain::BitcoinAnonymous,
            QuotaDomain::BitcoinCustomer,
            QuotaDomain::SolanaCustomer,
            QuotaDomain::SolanaAnonymous,
        ] {
            assert!(
                FixedHourQuota::with_backend(7, domain, backend.clone())
                    .charge("customer", 7, 7200)
                    .await
                    .is_ok(),
                "domains retain separate allowances"
            );
        }
        for network in ["solana-devnet", "xec-regtest", "btc-regtest"] {
            let other = QuotaBackend::shared(network, store.clone(), 64).unwrap();
            assert!(
                FixedHourQuota::with_backend(7, QuotaDomain::EvmCustomer, other)
                    .charge("customer", 7, 7200)
                    .await
                    .is_ok()
            );
        }
        assert!(QuotaBackend::shared("evm", store, 64).is_err());
        assert_eq!(
            restarted
                .charge("customer", 7, 10800)
                .await
                .unwrap()
                .remaining,
            0
        );
    }

    #[derive(Debug)]
    struct PausedTransaction {
        store: Arc<dyn RelayKvStore>,
        first: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        released: Mutex<bool>,
        release: std::sync::Condvar,
    }

    impl RelayKvStore for PausedTransaction {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(
                &mut dyn crate::store::kv_store::KvTransaction,
            ) -> crate::store::kv_store::Outcome,
        ) -> Result<crate::store::kv_store::Outcome, KvError> {
            if self.first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                self.entered.notify_one();
                let (_guard, timeout) = self
                    .release
                    .wait_timeout_while(
                        self.released.lock().unwrap(),
                        std::time::Duration::from_secs(5),
                        |released| !*released,
                    )
                    .unwrap();
                if timeout.timed_out() {
                    return Err(KvError::Backend(
                        "test transaction release timed out".into(),
                    ));
                }
            }
            self.store.run_transaction(body)
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_charge_keeps_worker_bound_until_transaction_finishes() {
        let (_directory, store, _) = shared_store();
        let paused = Arc::new(PausedTransaction {
            store: store.clone(),
            first: std::sync::atomic::AtomicBool::new(true),
            entered: tokio::sync::Notify::new(),
            released: Mutex::new(false),
            release: std::sync::Condvar::new(),
        });
        let backend = QuotaBackend::shared("monad-regtest", paused.clone(), 1).unwrap();
        let quota = Arc::new(FixedHourQuota::with_backend(
            2,
            QuotaDomain::EvmCustomer,
            backend.clone(),
        ));
        let caller = tokio::spawn({
            let quota = quota.clone();
            async move { quota.charge("payer", 1, 3600).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), paused.entered.notified())
            .await
            .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        // Another quota owner and GC share the same bound, despite caller cancellation.
        let other = FixedHourQuota::with_backend(2, QuotaDomain::SolanaCustomer, backend.clone());
        assert_eq!(
            other.charge("payer", 1, 3600).await,
            Err(QuotaDenial::Unavailable)
        );
        assert!(backend.sweep_expired(7200).await.is_err());
        let drain = tokio::spawn({
            let backend = backend.clone();
            async move { backend.close_and_drain().await }
        });
        tokio::task::yield_now().await;
        assert!(
            !drain.is_finished(),
            "shutdown must retain the blocking transaction"
        );
        *paused.released.lock().unwrap() = true;
        paused.release.notify_all();
        tokio::time::timeout(std::time::Duration::from_secs(2), drain)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            backend.shared.as_ref().unwrap().workers.available_permits(),
            1
        );
        assert_eq!(
            quota.charge("payer", 1, 3600).await,
            Err(QuotaDenial::Unavailable)
        );
        // The cancelled caller's transaction still completed exactly once.
        let reopened = QuotaBackend::shared("monad-regtest", store, 1).unwrap();
        let reopened = FixedHourQuota::with_backend(2, QuotaDomain::EvmCustomer, reopened);
        assert_eq!(
            reopened.charge("payer", 1, 3600).await.unwrap().remaining,
            0
        );
    }

    #[derive(Debug)]
    struct FailOnce {
        store: Arc<dyn RelayKvStore>,
        fail: std::sync::atomic::AtomicBool,
    }
    impl RelayKvStore for FailOnce {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(
                &mut dyn crate::store::kv_store::KvTransaction,
            ) -> crate::store::kv_store::Outcome,
        ) -> Result<crate::store::kv_store::Outcome, KvError> {
            if self.fail.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err(KvError::Backend("synthetic transaction failure".into()));
            }
            self.store.run_transaction(body)
        }
    }

    #[tokio::test]
    async fn cleanup_failure_returns_shared_worker_permit() {
        let (_directory, store, _) = shared_store();
        let backend = QuotaBackend::shared(
            "monad-regtest",
            Arc::new(FailOnce {
                store,
                fail: std::sync::atomic::AtomicBool::new(true),
            }),
            1,
        )
        .unwrap();
        assert!(backend.sweep_expired(7200).await.is_err());
        let quota = FixedHourQuota::with_backend(1, QuotaDomain::EvmCustomer, backend.clone());
        assert!(quota.charge("payer", 1, 3600).await.is_ok());
        assert_eq!(backend.sweep_expired(7200).await.unwrap(), 0);
        assert_eq!(
            backend.shared.as_ref().unwrap().workers.available_permits(),
            1
        );
    }

    #[derive(Debug)]
    struct CommitUnknown(Arc<dyn RelayKvStore>);
    impl RelayKvStore for CommitUnknown {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(
                &mut dyn crate::store::kv_store::KvTransaction,
            ) -> crate::store::kv_store::Outcome,
        ) -> Result<crate::store::kv_store::Outcome, KvError> {
            self.0.run_transaction(body)?;
            Err(KvError::CommitUnknownResult(
                "synthetic unknown result".into(),
            ))
        }
    }

    #[tokio::test]
    async fn unknown_commit_denies_without_fallback_or_double_charge() {
        let (_directory, store, backend) = shared_store();
        let uncertain =
            QuotaBackend::shared("monad-regtest", Arc::new(CommitUnknown(store)), 64).unwrap();
        let quota = FixedHourQuota::with_backend(1, QuotaDomain::EvmCustomer, uncertain);
        assert_eq!(
            quota.charge("payer", 1, 3600).await,
            Err(QuotaDenial::Unavailable)
        );
        assert!(quota.state.lock().unwrap().usage.is_empty());
        let reopened = FixedHourQuota::with_backend(1, QuotaDomain::EvmCustomer, backend);
        assert_eq!(
            reopened.charge("payer", 1, 3600).await,
            Err(QuotaDenial::Exhausted {
                reset_unix_seconds: 7200
            })
        );
    }

    #[tokio::test]
    async fn expired_cleanup_is_paged_and_keeps_current_and_previous_hours() {
        let (_directory, store, backend) = shared_store();
        let quota = FixedHourQuota::with_backend(1000, QuotaDomain::EvmAnonymous, backend.clone());
        for index in 0..130u32 {
            let ip = IpAddr::V4(std::net::Ipv4Addr::from(index));
            assert!(quota.charge(ip, 1, 0).await.is_ok());
        }
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        quota.charge(ip, 1, 3600).await.unwrap();
        quota.charge(ip, 1, 7200).await.unwrap();
        assert_eq!(backend.sweep_expired(7200).await.unwrap(), 128);
        assert_eq!(backend.sweep_expired(7200).await.unwrap(), 3);
        assert_eq!(backend.sweep_expired(7200).await.unwrap(), 0);
        let rows = store.transact(|tx| tx.scan_prefix(ROWS, None, 16)).unwrap();
        assert_eq!(rows.len(), 4);
        assert!(rows
            .iter()
            .all(|(key, _)| u64::from_be_bytes(key[2..10].try_into().unwrap()) >= 1));
        assert!(quota.state.lock().unwrap().usage.is_empty());
    }
    #[tokio::test]
    async fn shared_capacity_rejects_only_new_payers_and_formats_fail_closed() {
        let (_directory, store, backend) = shared_store();
        let quota = FixedHourQuota::with_backend(4, QuotaDomain::EvmAnonymous, backend.clone());
        let known: IpAddr = "192.0.2.1".parse().unwrap();
        quota.charge(known, 1, 3600).await.unwrap();
        // Fill the documented distinct-payer metadata, without allocating100000 process entries.
        let mut prefix = [ROWS, &1u64.to_be_bytes()].concat();
        prefix.extend_from_slice(&("monad-regtest".len() as u16).to_be_bytes());
        prefix.extend_from_slice(b"monad-regtest");
        prefix.push(QuotaDomain::EvmAnonymous as u8);
        let count = [&prefix[..], b"n"].concat();
        store
            .transact(|tx| tx.set(&count, &(MAX_QUOTA_KEYS as u32).to_be_bytes()))
            .unwrap();
        assert_eq!(
            quota.charge("192.0.2.2".parse().unwrap(), 1, 3600).await,
            Err(QuotaDenial::Capacity)
        );
        assert_eq!(quota.charge(known, 1, 3600).await.unwrap().remaining, 2);
        assert!(quota
            .charge("192.0.2.2".parse().unwrap(), 1, 7200)
            .await
            .is_ok());
        store
            .transact(|tx| tx.set(b"format", b"other-format"))
            .unwrap();
        assert!(backend.probe().is_err());
    }
}

#[cfg(all(test, feature = "foundationdb"))]
#[path = "hourly_quota_fdb_tests.rs"]
mod fdb;
