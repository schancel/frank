// Several replicas of one relay over one shared directory store: each replica has its own
// registry database, directory runtime and clock, and all of them share the directory's
// transaction store and object store, as replicas on FoundationDB and S3 do. The store here is
// the RocksDB driver of the same transaction contract; the FoundationDB driver is exercised by
// `store/directory_subjects_fdb_tests.rs` (in the FDB lab) and the cluster lab.
use super::*;
use crate::store::{
    directory_store::DirectoryBackend,
    kv_store::RocksDbKvStore,
    large_values::{LocalFsObjectStore, ObjectStore},
};

struct Replicas {
    kv: Arc<RocksDbKvStore>,
    objects: Arc<dyn ObjectStore>,
    _root: tempfile::TempDir,
}

impl Replicas {
    fn new() -> Self {
        Self {
            kv: Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            objects: Arc::new(LocalFsObjectStore::temporary()),
            _root: tempfile::tempdir().unwrap(),
        }
    }
    /// Start one replica named `name` on its own clock.
    async fn start(&self, name: &str, clock: &TestClock) -> (DirectoryRuntime, Router) {
        let path = self._root.path().join(name);
        let registry = Arc::new(Registry::new_with_event_bus(
            Db::open(&path).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
            Arc::new(crate::events::StandaloneEventBus::new()),
            crate::registry::RegistryBackends {
                directory: DirectoryBackend::Shared(self.kv.clone()),
                groups: crate::store::groups::GroupBackend::rocksdb_beside(&path),
                objects: self.objects.clone(),
                group_policy: cashweb_config::GroupAppendPolicy {
                    per_message_price_credits: 0,
                },
                messages: None,
            },
        ));
        let runtime = start(registry, relay_config(), clock).await;
        let routes = router(Arc::new(runtime.clone()));
        (runtime, routes)
    }
}

async fn stop(runtimes: &[&DirectoryRuntime]) {
    for runtime in runtimes {
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
}

#[tokio::test]
async fn an_entry_published_on_one_replica_resolves_on_the_others() {
    let replicas = Replicas::new();
    let clock = TestClock::at(1700000100);
    let (a, routes_a) = replicas.start("a", &clock).await;
    let (b, routes_b) = replicas.start("b", &clock).await;
    let (c, routes_c) = replicas.start("c", &clock).await;
    let account = entry(42, |_| ());
    assert_eq!(
        put(&routes_a, &account.subject, account.attestation.clone())
            .await
            .0,
        StatusCode::OK
    );
    for routes in [&routes_b, &routes_c] {
        let by_key = get(routes, &head(&account.subject)).await;
        assert_eq!(by_key.0, StatusCode::OK);
        assert_eq!(by_key.2, account.attestation);
        let found = get(routes, &by_address(&account.address)).await;
        assert_eq!(found.0, StatusCode::OK);
        assert_eq!(found.2, account.attestation);
        assert_eq!(
            found.1["x-frank-directory-subject"],
            account.subject.as_str()
        );
        let listed = get(routes, &format!("/directory/v1/{NETWORK}/accounts")).await;
        assert_eq!(listed.0, StatusCode::OK);
        let listed: Value = serde_json::from_slice(&listed.2).unwrap();
        assert_eq!(
            listed["accounts"][0]["address"].as_str().unwrap(),
            account.address.to_lowercase()
        );
        assert_eq!(listed["accounts"].as_array().unwrap().len(), 1);
    }
    // A renewal accepted on B is what A and C serve next, though A opened the subject first.
    let renewed = entry(42, |fields| {
        for (key, value) in fields.iter_mut() {
            if *key == 2 {
                *value = CborValue::Int(1);
            }
            if *key == 13 {
                *value = CborValue::Bytes(account.hash.to_vec());
            }
        }
    });
    let accepted = put(&routes_b, &account.subject, renewed.attestation.clone()).await;
    assert_eq!(accepted.0, StatusCode::OK, "{:?}", accepted.1);
    for routes in [&routes_a, &routes_c] {
        assert_eq!(
            get(routes, &head(&account.subject)).await.2,
            renewed.attestation
        );
    }
    assert_eq!(c.listed(NETWORK, &account.subject).await.unwrap().1, 2);
    // A key nobody published is unknown everywhere.
    let unknown = entry(77, |_| ());
    for routes in [&routes_a, &routes_b, &routes_c] {
        assert_eq!(
            get(routes, &head(&unknown.subject)).await.0,
            StatusCode::NOT_FOUND
        );
    }
    stop(&[&a, &b, &c]).await;
}

#[tokio::test]
async fn conflicting_revisions_raced_to_two_replicas_accept_exactly_one_and_never_fork() {
    for round in 0..10 {
        let replicas = Replicas::new();
        let clock = TestClock::at(1700000100);
        let (a, routes_a) = replicas.start("a", &clock).await;
        let (b, routes_b) = replicas.start("b", &clock).await;
        assert_eq!(
            put(&routes_a, SUBJECT, vector("bootstrap")).await.0,
            StatusCode::OK
        );
        // Two devices renew the same revision at once, each through a different replica.
        let (left, right) = tokio::join!(
            put(&routes_a, SUBJECT, vector("renew")),
            put(&routes_b, SUBJECT, vector("fork-of-renew")),
        );
        let statuses = [left.0, right.0];
        assert_eq!(
            statuses.iter().filter(|s| **s == StatusCode::OK).count(),
            1,
            "round {round}: {statuses:?}"
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|s| **s == StatusCode::CONFLICT)
                .count(),
            1,
            "round {round}: {statuses:?}"
        );
        let winner = if left.0 == StatusCode::OK {
            vector("renew")
        } else {
            vector("fork-of-renew")
        };
        for (runtime, routes) in [(&a, &routes_a), (&b, &routes_b)] {
            let current = get(routes, &head(SUBJECT)).await;
            assert_eq!(current.0, StatusCode::OK, "round {round}");
            assert_eq!(current.2, winner, "round {round}");
            // Two retained records, not forked: the loser left nothing behind.
            let (_, retained, forked) = runtime.listed(NETWORK, SUBJECT).await.unwrap();
            assert_eq!((retained, forked), (2, false), "round {round}");
        }
        stop(&[&a, &b]).await;
    }
}

#[tokio::test]
async fn one_first_entry_raced_to_two_replicas_enrolls_once_and_a_conflicting_one_loses() {
    for round in 0..10 {
        let replicas = Replicas::new();
        let clock = TestClock::at(1700000100);
        let (a, routes_a) = replicas.start("a", &clock).await;
        let (b, routes_b) = replicas.start("b", &clock).await;
        // The same first entry through both replicas: both succeed, it is counted once.
        let (left, right) = tokio::join!(
            put(&routes_a, SUBJECT, vector("bootstrap")),
            put(&routes_b, SUBJECT, vector("bootstrap")),
        );
        assert_eq!(
            (left.0, right.0),
            (StatusCode::OK, StatusCode::OK),
            "round {round}"
        );
        let counts = a.registry().directory_subjects().unwrap().counts().unwrap();
        assert_eq!(counts, (1, 0), "round {round}");
        stop(&[&a, &b]).await;

        // Two different first entries of one key: the first accepted wins everywhere.
        let replicas = Replicas::new();
        let (a, routes_a) = replicas.start("a", &clock).await;
        let (b, routes_b) = replicas.start("b", &clock).await;
        let (left, right) = tokio::join!(
            put(&routes_a, SUBJECT, vector("bootstrap")),
            put(&routes_b, SUBJECT, vector("wrong-relay")),
        );
        let statuses = [left.0, right.0];
        assert_eq!(
            statuses.iter().filter(|s| **s == StatusCode::OK).count(),
            1,
            "round {round}: {statuses:?}"
        );
        assert!(
            statuses.contains(&StatusCode::CONFLICT),
            "round {round}: {statuses:?}"
        );
        let winner = if left.0 == StatusCode::OK {
            vector("bootstrap")
        } else {
            vector("wrong-relay")
        };
        for routes in [&routes_a, &routes_b] {
            assert_eq!(get(routes, &head(SUBJECT)).await.2, winner, "round {round}");
        }
        let counts = b.registry().directory_subjects().unwrap().counts().unwrap();
        assert_eq!(counts, (1, 0), "round {round}");
        stop(&[&a, &b]).await;
    }
}

#[tokio::test]
async fn a_replica_whose_clock_is_behind_still_serves_subjects_another_replica_checked() {
    let replicas = Replicas::new();
    let ahead = TestClock::at(1700000105);
    let behind = TestClock::at(1700000100);
    let (a, routes_a) = replicas.start("a", &ahead).await;
    let (b, routes_b) = replicas.start("b", &behind).await;
    assert_eq!(
        put(&routes_a, SUBJECT, vector("bootstrap")).await.0,
        StatusCode::OK
    );
    // A checked the head at its later time; B, five seconds behind, still answers.
    let read = get(&routes_b, &head(SUBJECT)).await;
    assert_eq!(read.0, StatusCode::OK);
    assert_eq!(read.2, vector("bootstrap"));
    assert_eq!(
        put(&routes_b, SUBJECT, vector("renew")).await.0,
        StatusCode::OK
    );
    assert_eq!(get(&routes_a, &head(SUBJECT)).await.2, vector("renew"));
    stop(&[&a, &b]).await;
}

#[tokio::test]
async fn the_relay_wide_subject_cap_holds_across_replicas() {
    let replicas = Replicas::new();
    let clock = TestClock::at(1700000100);
    let mut config = relay_config();
    config.max_subjects = 3;
    let path = |name: &str| replicas._root.path().join(name);
    let mut routes = Vec::new();
    let mut runtimes = Vec::new();
    for name in ["a", "b", "c"] {
        let registry = Arc::new(Registry::new_with_event_bus(
            Db::open(path(name)).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
            Arc::new(crate::events::StandaloneEventBus::new()),
            crate::registry::RegistryBackends {
                directory: DirectoryBackend::Shared(replicas.kv.clone()),
                groups: crate::store::groups::GroupBackend::rocksdb_beside(&path(name)),
                objects: replicas.objects.clone(),
                group_policy: cashweb_config::GroupAppendPolicy {
                    per_message_price_credits: 0,
                },
                messages: None,
            },
        ));
        let runtime = start(registry, config.clone(), &clock).await;
        routes.push(router(Arc::new(runtime.clone())));
        runtimes.push(runtime);
    }
    // Nine first publications at once over three replicas, against a cap of three.
    let accounts: Vec<_> = (0..9u32).map(|i| entry(100 + i, |_| ())).collect();
    let results = futures::future::join_all(accounts.iter().enumerate().map(|(i, account)| {
        let routes = routes[i % 3].clone();
        async move {
            put(&routes, &account.subject, account.attestation.clone())
                .await
                .0
        }
    }))
    .await;
    assert_eq!(
        results.iter().filter(|s| **s == StatusCode::OK).count(),
        3,
        "{results:?}"
    );
    assert_eq!(
        results
            .iter()
            .filter(|s| **s == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        6,
        "{results:?}"
    );
    let counts = runtimes[0]
        .registry()
        .directory_subjects()
        .unwrap()
        .counts()
        .unwrap();
    assert_eq!(counts, (3, 0));
    for runtime in &runtimes {
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
}
