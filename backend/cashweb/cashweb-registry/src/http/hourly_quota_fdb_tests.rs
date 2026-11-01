//! Opt-in real-FDB proof. Each worker boots its own FDB client and quota owner. The
//! caller supplies FRANK_FDB_CLUSTER_FILE and a fresh, ledgered
//! FRANK_HOURLY_QUOTA_FDB_RUN_ID explicitly; only that run's UUID subspace is touched.
use super::*;
use crate::store::foundationdb_driver::{FdbNetwork, FoundationDbKvStore};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    thread::JoinHandle,
    time::Duration,
};

const SUBSPACE: &str = "FRANK_HOURLY_QUOTA_FDB_SUBSPACE";
const PROTOCOL: &str = "quota-fdb ";
const DOMAINS: [QuotaDomain; 7] = [
    QuotaDomain::DirectoryEnrollment,
    QuotaDomain::EvmCustomer,
    QuotaDomain::EvmAnonymous,
    QuotaDomain::BitcoinAnonymous,
    QuotaDomain::BitcoinCustomer,
    QuotaDomain::SolanaCustomer,
    QuotaDomain::SolanaAnonymous,
];

fn cluster_file() -> String {
    std::env::var("FRANK_FDB_CLUSTER_FILE").expect("explicit owned FRANK_FDB_CLUSTER_FILE required")
}

#[test]
#[ignore = "worker for three_replicas_share_existing_quota_rules"]
fn worker() {
    let Ok(subspace) = std::env::var(SUBSPACE) else {
        return;
    };
    let _network = unsafe { FdbNetwork::boot().unwrap() };
    let store = Arc::new(FoundationDbKvStore::open(&cluster_file(), subspace).unwrap());
    let backend = QuotaBackend::shared("monad-regtest", store, 64).unwrap();
    backend.probe().unwrap();
    let quotas: Vec<FixedHourQuota<IpAddr>> = DOMAINS
        .iter()
        .map(|domain| FixedHourQuota::with_backend(10, *domain, backend.clone()))
        .collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    println!("\n{PROTOCOL}ready {}", std::process::id());
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts == ["stop"] {
            break;
        }
        assert_eq!(parts.len(), 4);
        let domain: usize = parts[0].parse().unwrap();
        let units: u32 = parts[1].parse().unwrap();
        let now: u64 = parts[2].parse().unwrap();
        let payer: IpAddr = parts[3].parse().unwrap();
        let result = runtime.block_on(quotas[domain].charge(normalize_quota_ip(payer), units, now));
        match result {
            Ok(snapshot) => println!("{PROTOCOL}ok {}", snapshot.remaining),
            Err(error) => println!("{PROTOCOL}denied {error:?}"),
        }
    }
}

struct Worker {
    child: Child,
    input: Option<ChildStdin>,
    responses: mpsc::Receiver<String>,
    reader: Option<JoinHandle<()>>,
}
impl Worker {
    fn start(subspace: &str) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "http::hourly_quota::fdb::worker",
                "--ignored",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBSPACE, subspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (send, responses) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Some(value) = line.strip_prefix(PROTOCOL) {
                    if send.send(value.to_owned()).is_err() {
                        break;
                    }
                }
            }
        });
        let worker = Self {
            child,
            input,
            responses,
            reader: Some(reader),
        };
        assert!(worker.response().starts_with("ready "));
        worker
    }
    fn send(&mut self, domain: usize, units: u32, now: u64, payer: &str) {
        writeln!(
            self.input.as_mut().unwrap(),
            "{domain} {units} {now} {payer}"
        )
        .unwrap();
    }
    fn response(&self) -> String {
        self.responses
            .recv_timeout(Duration::from_secs(20))
            .expect("bounded FDB worker response")
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        // Child is this instance's owned process handle, never a discovered PID/name pattern.
        self.input.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[test]
#[ignore = "requires explicitly configured live FoundationDB; creates only its own UUID subspace"]
fn three_replicas_share_existing_quota_rules() {
    let _network = unsafe { FdbNetwork::boot().unwrap() };
    let run = uuid::Uuid::parse_str(
        &std::env::var("FRANK_HOURLY_QUOTA_FDB_RUN_ID")
            .expect("fresh run UUID must be registered in the workspace ledger before this test"),
    )
    .expect("run ID must be a UUID")
    .to_string();
    let subspace = format!("frank-hourly-quota-test/{run}/");
    let store = Arc::new(FoundationDbKvStore::open(&cluster_file(), subspace.clone()).unwrap());
    assert!(
        store
            .transact(|tx| tx.scan_prefix(b"", None, 1))
            .unwrap()
            .is_empty(),
        "refusing a non-empty test namespace; allocate a fresh registered run UUID"
    );
    println!("owned quota subspace {subspace}");
    let backend = QuotaBackend::shared("monad-regtest", store.clone(), 64).unwrap();
    backend.probe().unwrap();
    store
        .transact(|tx| tx.set(b"test-owner", run.as_bytes()))
        .unwrap();
    let mut replicas: Vec<_> = (0..3).map(|_| Worker::start(&subspace)).collect();
    let mut accepted = 0;
    for replica in &mut replicas {
        replica.send(2, 3, 7200, "192.0.2.1");
    }
    for replica in &replicas {
        assert!(replica.response().starts_with("ok "));
        accepted += 3;
    }
    for replica in &mut replicas {
        replica.send(2, 1, 7200, "192.0.2.1");
    }
    for replica in &replicas {
        let result = replica.response();
        if result.starts_with("ok ") {
            accepted += 1;
        } else {
            assert!(result.starts_with("denied Exhausted"), "{result}");
        }
    }
    assert_eq!(
        accepted, 10,
        "one global allowance, not three replica allowances"
    );
    drop(replicas.remove(0));
    replicas.push(Worker::start(&subspace));
    replicas[2].send(2, 1, 7200, "::ffff:192.0.2.1");
    assert!(replicas[2].response().starts_with("denied Exhausted"));
    // All existing domains are independently shared, including directory, WS and Electrum payers.
    for domain in [0, 1, 3, 4, 5, 6] {
        replicas[0].send(domain, 6, 7200, "2001:db8:1:2::1");
        assert_eq!(replicas[0].response(), "ok 4");
        replicas[1].send(domain, 4, 7200, "2001:db8:1:2::2");
        assert_eq!(replicas[1].response(), "ok 0");
        replicas[2].send(domain, 1, 7200, "2001:db8:1:2::3");
        assert!(replicas[2].response().starts_with("denied Exhausted"));
    }
    replicas[0].send(2, 10, 10800, "192.0.2.1");
    assert_eq!(replicas[0].response(), "ok 0");
    drop(replicas);
    // Never clear an operator namespace or another run's rows.
    store
        .transact(|tx| {
            assert_eq!(tx.get(b"test-owner")?, Some(run.as_bytes().to_vec()));
            Ok::<_, KvError>(())
        })
        .unwrap();
    loop {
        let cleared = store
            .transact(|tx| {
                let rows = tx.scan_prefix(b"", None, 128)?;
                for (key, _) in &rows {
                    tx.clear(key)?;
                }
                Ok::<_, KvError>(rows.len())
            })
            .unwrap();
        if cleared < 128 {
            break;
        }
    }
    assert!(store
        .transact(|tx| tx.scan_prefix(b"", None, 1))
        .unwrap()
        .is_empty());
}
