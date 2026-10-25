//! The `RelayKvStore` transaction contract, run against both real drivers.
//!
//! RocksDB runs in every `cargo test`. FoundationDB needs a live disposable cluster (see
//! `backend/labs/README.md`); its contract test spawns two worker processes of this binary,
//! each booting its own FDB client, so the conflict rounds cross process boundaries:
//!
//! ```sh
//! FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
//!   --features foundationdb --test kv_transaction_contract -- --ignored --exact \
//!   foundationdb_transaction_contract --nocapture
//! ```
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc, Barrier,
    },
    time::Duration,
};

use cashweb_registry::store::kv_store::{
    KvError, RelayKvStore, RocksDbKvStore, Transact, MAX_TRANSACTION_BYTES,
    MAX_TRANSACTION_DURATION, MAX_VALUE_BYTES,
};

const ROUNDS: u64 = 1_000;
const COUNTER: &[u8] = b"contract/counter";

fn read_u64(store: &dyn RelayKvStore, key: &[u8]) -> Option<u64> {
    store
        .transact(|tx| tx.get(key))
        .unwrap()
        .map(|bytes| u64::from_be_bytes(bytes.try_into().unwrap()))
}

/// A contender in the conflict rounds, reached over a line protocol.
trait Peer {
    fn send(&mut self, line: &str);
    fn recv(&mut self) -> String;
}

/// One contender: for each round, read the counter, wait until the coordinator has seen both
/// contenders' first successful read, then increment only if the counter still equals the round number. Without
/// conflict detection both would increment; with it, the loser's re-run sees the winner's write.
fn contend(
    store: &dyn RelayKvStore,
    recv: &mut dyn FnMut() -> String,
    send: &mut dyn FnMut(String),
) {
    loop {
        let line = recv();
        let Some(round) = line.strip_prefix("round ") else {
            assert_eq!(line, "quit");
            return;
        };
        let round: u64 = round.parse().unwrap();
        let mut attempts = 0u32;
        // The attempt whose read was announced; only re-runs after it count as conflicts.
        let mut announced: Option<u32> = None;
        let won = store
            .transact(|tx| {
                attempts += 1;
                let current = tx
                    .get(COUNTER)?
                    .map_or(0, |b| u64::from_be_bytes(b.try_into().unwrap()));
                // Announce the first attempt whose read succeeded. A driver may re-run the
                // closure before that (FDB retries a read that failed with a retryable error).
                if announced.is_none() {
                    announced = Some(attempts);
                    if attempts > 1 {
                        eprintln!("round {round}: read succeeded on attempt {attempts}");
                    }
                    send("read".into());
                    assert_eq!(recv(), "go");
                }
                if current != round {
                    return Ok::<_, KvError>(false);
                }
                tx.set(COUNTER, &(current + 1).to_be_bytes())?;
                Ok(true)
            })
            .unwrap();
        let attempts_since_read = attempts - announced.unwrap() + 1;
        send(format!("done {} {attempts_since_read}", u8::from(won)));
    }
}

/// Drive `ROUNDS` rounds; each must have exactly one winner, and the loser must have re-run.
fn exactly_one_winner_per_round<P: Peer>(reader: &dyn RelayKvStore, peers: &mut [P; 2]) {
    let mut wins = 0u64;
    for round in 0..ROUNDS {
        for peer in peers.iter_mut() {
            peer.send(&format!("round {round}"));
        }
        for peer in peers.iter_mut() {
            assert_eq!(peer.recv(), "read");
        }
        for peer in peers.iter_mut() {
            peer.send("go");
        }
        let results: Vec<(bool, u32)> = peers
            .iter_mut()
            .map(|peer| {
                let line = peer.recv();
                let mut fields = line.strip_prefix("done ").unwrap().split(' ');
                let won = fields.next().unwrap() == "1";
                (won, fields.next().unwrap().parse().unwrap())
            })
            .collect();
        let winners = results.iter().filter(|(won, _)| *won).count();
        assert_eq!(winners, 1, "round {round}: {results:?}");
        let (_, loser_attempts) = results.iter().find(|(won, _)| !won).unwrap();
        assert!(
            *loser_attempts >= 2,
            "round {round}: the loser read the same value and must have conflicted"
        );
        wins += 1;
    }
    for peer in peers.iter_mut() {
        peer.send("quit");
    }
    assert_eq!(read_u64(reader, COUNTER), Some(wins));
    assert_eq!(wins, ROUNDS);
}

/// `a` reads a range, `b` commits into it (or outside it), then `a` commits a write elsewhere.
fn range_read_conflicts_with_insert(a: &dyn RelayKvStore, b: &dyn RelayKvStore) {
    let attempts = |inserted: &'static [u8]| {
        let count = AtomicU32::new(0);
        let rows = a
            .transact(|tx| {
                let attempt = count.fetch_add(1, Ordering::SeqCst) + 1;
                let rows = tx.get_range(b"range/a", b"range/m", 100)?;
                if attempt == 1 {
                    b.transact(|other| other.set(inserted, b"concurrent"))?;
                }
                tx.set(b"range/z-summary", &(rows.len() as u64).to_be_bytes())?;
                Ok::<_, KvError>(rows.len())
            })
            .unwrap();
        (count.load(Ordering::SeqCst), rows)
    };
    // An insert outside the range read does not conflict.
    assert_eq!(attempts(b"range/q-outside"), (1, 0));
    // An insert inside it does: the re-run sees the new row.
    assert_eq!(attempts(b"range/c-inside"), (2, 1));
    // A limited read conflicts only over the part it actually read.
    a.transact(|tx| tx.set(b"range/b", b"first")).unwrap();
    let count = AtomicU32::new(0);
    a.transact(|tx| {
        let attempt = count.fetch_add(1, Ordering::SeqCst) + 1;
        let rows = tx.get_range(b"range/a", b"range/m", 1)?;
        assert_eq!(rows[0].0, b"range/b");
        if attempt == 1 {
            b.transact(|other| other.set(b"range/d-after-limit", b"x"))?;
        }
        tx.set(b"range/z-summary", b"limited")
    })
    .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

fn limits_return_typed_errors(store: &dyn RelayKvStore) {
    store
        .transact(|tx| tx.set(b"limits/max", &vec![1; MAX_VALUE_BYTES]))
        .unwrap();
    assert_eq!(
        store.transact(|tx| tx.set(b"limits/value", &vec![1; MAX_VALUE_BYTES + 1])),
        Err(KvError::ValueTooLarge {
            len: MAX_VALUE_BYTES + 1,
            limit: MAX_VALUE_BYTES
        })
    );
    let chunk = vec![2; MAX_VALUE_BYTES - 100];
    let result = store.transact(|tx| {
        for index in 0..=(MAX_TRANSACTION_BYTES / chunk.len()) as u32 {
            tx.set(
                &[b"limits/tx/".as_slice(), &index.to_be_bytes()].concat(),
                &chunk,
            )?;
        }
        Ok::<_, KvError>(())
    });
    assert_eq!(
        result,
        Err(KvError::TransactionTooLarge {
            limit: MAX_TRANSACTION_BYTES
        })
    );
    let timed_out = store.transact(|tx| {
        tx.set(b"limits/slow", b"never committed")?;
        std::thread::sleep(MAX_TRANSACTION_DURATION + Duration::from_millis(200));
        tx.get(b"limits/max")
    });
    assert_eq!(timed_out, Err(KvError::TransactionTimedOut));
    let leftovers = store
        .transact(|tx| tx.scan_prefix(b"limits/", None, 10))
        .unwrap();
    assert_eq!(
        leftovers
            .iter()
            .map(|(k, _)| k.as_slice())
            .collect::<Vec<_>>(),
        vec![b"limits/max".as_slice()],
        "failed transactions must not commit any write"
    );
}

/// Concurrent atomic adds from two clients commute without being lost.
fn atomic_adds_commute(a: Arc<dyn RelayKvStore>, b: Arc<dyn RelayKvStore>) {
    let start = Arc::new(Barrier::new(2));
    let threads: Vec<_> = [a.clone(), b]
        .into_iter()
        .map(|store| {
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                for _ in 0..50 {
                    store.transact(|tx| tx.atomic_add(b"adds/n", 1)).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let total = a.transact(|tx| tx.get(b"adds/n")).unwrap().unwrap();
    assert_eq!(total, 100u64.to_le_bytes());
    let doubled = a
        .transact(|tx| {
            tx.atomic_add(b"adds/n", 100)?;
            tx.get(b"adds/n")
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        doubled,
        200u64.to_le_bytes(),
        "a read sees the transaction's own add"
    );
}

struct ThreadPeer {
    to: mpsc::Sender<String>,
    from: mpsc::Receiver<String>,
}

impl Peer for ThreadPeer {
    fn send(&mut self, line: &str) {
        self.to.send(line.into()).unwrap();
    }
    fn recv(&mut self) -> String {
        self.from.recv_timeout(Duration::from_secs(60)).unwrap()
    }
}

/// RocksDB has one owning process, so the two contenders are threads sharing it.
fn thread_peer(store: Arc<RocksDbKvStore>) -> (ThreadPeer, std::thread::JoinHandle<()>) {
    let (to_worker, worker_in) = mpsc::channel::<String>();
    let (worker_out, from_worker) = mpsc::channel::<String>();
    let handle = std::thread::spawn(move || {
        contend(
            store.as_ref(),
            &mut || worker_in.recv().unwrap(),
            &mut |line| worker_out.send(line).unwrap(),
        )
    });
    (
        ThreadPeer {
            to: to_worker,
            from: from_worker,
        },
        handle,
    )
}

#[test]
fn rocksdb_transaction_contract() {
    let store = Arc::new(RocksDbKvStore::open_temporary().unwrap());
    let (first, first_thread) = thread_peer(store.clone());
    let (second, second_thread) = thread_peer(store.clone());
    exactly_one_winner_per_round(store.as_ref(), &mut [first, second]);
    first_thread.join().unwrap();
    second_thread.join().unwrap();
    range_read_conflicts_with_insert(store.as_ref(), store.as_ref());
    limits_return_typed_errors(store.as_ref());
    atomic_adds_commute(store.clone(), store);
}

#[cfg(feature = "foundationdb")]
mod live_fdb {
    use super::*;
    use cashweb_registry::store::foundationdb_driver::FoundationDbKvStore;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

    const WORKER_SUBSPACE: &str = "FRANK_KV_CONTRACT_WORKER_SUBSPACE";
    const PROTOCOL: &str = "kv-contract ";

    fn cluster_file() -> String {
        std::env::var("FRANK_FDB_CLUSTER_FILE")
            .expect("FRANK_FDB_CLUSTER_FILE is required; refusing the default cluster")
    }

    struct ProcessPeer {
        child: Child,
        stdin: ChildStdin,
        stdout: std::io::Lines<BufReader<ChildStdout>>,
    }

    impl Peer for ProcessPeer {
        fn send(&mut self, line: &str) {
            writeln!(self.stdin, "{line}").unwrap();
            self.stdin.flush().unwrap();
        }
        fn recv(&mut self) -> String {
            // The test harness prints on stdout too, and its unterminated `test name ... `
            // can precede the first protocol line, so the tag is matched anywhere in a line.
            for line in &mut self.stdout {
                let line = line.unwrap();
                if let Some((_, message)) = line.split_once(PROTOCOL) {
                    return message.to_string();
                }
            }
            panic!("worker exited early: {:?}", self.child.try_wait());
        }
    }

    fn process_peer(subspace: &str) -> ProcessPeer {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "live_fdb::contention_worker",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(WORKER_SUBSPACE, subspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        ProcessPeer {
            child,
            stdin,
            stdout,
        }
    }

    /// One contender process, started by `foundationdb_transaction_contract`.
    #[test]
    #[ignore = "worker process for foundationdb_transaction_contract"]
    fn contention_worker() {
        let Ok(subspace) = std::env::var(WORKER_SUBSPACE) else {
            return;
        };
        // SAFETY: this worker process owns the FDB network; the store drops before the guard.
        let _network = unsafe { foundationdb::boot() };
        let store = FoundationDbKvStore::open(&cluster_file(), subspace).unwrap();
        let mut stdin = std::io::stdin().lock().lines();
        contend(
            &store,
            &mut || stdin.next().unwrap().unwrap(),
            &mut |line| println!("{PROTOCOL}{line}"),
        );
    }

    #[test]
    #[ignore = "requires an explicitly configured live FoundationDB cluster"]
    fn foundationdb_transaction_contract() {
        let cluster_file = cluster_file();
        // SAFETY: this test owns the process's FDB network and drops every store before it.
        let _network = unsafe { foundationdb::boot() };
        let subspace = format!("frank-kv-contract:{}:", uuid::Uuid::new_v4());
        let open = || -> Arc<dyn RelayKvStore> {
            Arc::new(FoundationDbKvStore::open(&cluster_file, subspace.clone()).unwrap())
        };
        let (a, b) = (open(), open());

        let mut peers = [process_peer(&subspace), process_peer(&subspace)];
        exactly_one_winner_per_round(a.as_ref(), &mut peers);
        for peer in &mut peers {
            assert!(peer.child.wait().unwrap().success());
        }
        range_read_conflicts_with_insert(a.as_ref(), b.as_ref());
        limits_return_typed_errors(a.as_ref());
        atomic_adds_commute(a.clone(), b.clone());

        // Another subspace on the same cluster sees none of these keys.
        let other = FoundationDbKvStore::open(
            &cluster_file,
            format!("frank-kv-contract-other:{}:", uuid::Uuid::new_v4()),
        )
        .unwrap();
        assert_eq!(other.transact(|tx| tx.get(COUNTER)).unwrap(), None);
        assert!(other
            .transact(|tx| tx.scan_prefix(b"", None, 1))
            .unwrap()
            .is_empty());

        // Remove only this run's random subspace.
        a.transact(|tx| {
            for (key, _) in tx.scan_prefix(b"", None, 10_000)? {
                tx.clear(&key)?;
            }
            Ok::<_, KvError>(())
        })
        .unwrap();
        eprintln!(
            "real FDB contract passed: {ROUNDS} cross-process conflict rounds, range conflict, \
             typed limits, commuting adds, subspace isolation"
        );
    }
}
