//! Forward claims and subject counters on a real FoundationDB, across processes.
//!
//! Needs a live disposable cluster (`backend/labs/README.md`, FoundationDB lab). The parent
//! test starts worker processes of this test binary, each booting its own FDB client, and
//! kills one with SIGKILL:
//!
//! ```sh
//! FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
//!   --features foundationdb --lib -- --ignored --exact --nocapture \
//!   store::directory_subjects::fdb::forward_claims_and_counters_across_processes
//! ```
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use super::*;
use crate::directory_admission::{CheckpointKind, Status, Timestamp};
use crate::store::{
    directory_store::{DirectoryBackend, Owner},
    foundationdb_driver::{FdbNetwork, FoundationDbKvStore},
    kv_store::RelayKvStore,
    large_values::LocalFsObjectStore,
};

const SUBSPACE: &str = "FRANK_DIRECTORY_FDB_SUBSPACE";
const PROTOCOL: &str = "directory-fdb ";
const IDENTITY: [u8; 32] = [7; 32];
/// Counts sends attempted for the forward: a worker adds one just before it would send.
const SENT: &[u8] = b"test/sent";
const NETWORK: &str = "monad-testnet";

fn cluster_file() -> String {
    std::env::var("FRANK_FDB_CLUSTER_FILE")
        .expect("FRANK_FDB_CLUSTER_FILE is required; refusing the default cluster")
}

fn open(subspace: &str) -> (Arc<FoundationDbKvStore>, DbDirectorySubjects) {
    let kv = Arc::new(FoundationDbKvStore::open(&cluster_file(), subspace.to_owned()).unwrap());
    // Forward bodies here are small and inline; no object is written.
    let owner = Owner::new(
        DirectoryBackend::Shared(kv.clone()),
        Arc::new(LocalFsObjectStore::temporary()),
    );
    (kv, DbDirectorySubjects::new(owner.open(true).unwrap()))
}

fn sent(kv: &FoundationDbKvStore) -> u64 {
    kv.transact(|tx| tx.get(SENT))
        .unwrap()
        .map_or(0, |bytes| u64::from_le_bytes(bytes.try_into().unwrap()))
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: std::io::Lines<BufReader<ChildStdout>>,
}

impl Worker {
    fn start(subspace: &str, role: &str) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "store::directory_subjects::fdb::worker",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(SUBSPACE, subspace)
            .env("FRANK_DIRECTORY_FDB_ROLE", role)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            stdin,
            stdout,
        }
    }
    fn send(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
    }
    fn recv(&mut self) -> String {
        for line in &mut self.stdout {
            let line = line.unwrap();
            if let Some((_, message)) = line.split_once(PROTOCOL) {
                return message.to_owned();
            }
        }
        panic!("worker exited early: {:?}", self.child.try_wait());
    }
}

fn status() -> Status {
    let checkpoint = Checkpoint {
        kind: CheckpointKind::CommittedPrefix,
        identity: [2; 32],
        anchor: [1; 32],
        head: Some([3; 32]),
        accepted: 1,
        retained: 1,
        evidence_digest: [4; 32],
        checked_time: (1, 0),
        forked: false,
    };
    Status {
        checkpoint,
        head: checkpoint.head,
        revision: Some(0),
        generations: Some([0, 0]),
        current_stamp: None,
        previous_stamp: None,
        accepted: 1,
        retained: 1,
        charged_bytes: 1,
        forked: false,
        checked_time: Timestamp {
            seconds: 1,
            nanoseconds: 0,
        },
    }
}

/// Enroll subject `n` against a relay-wide cap, in one transaction, as a first commit does.
fn enroll(rows: &DbDirectorySubjects, n: u32, cap: u64) -> bool {
    let status = status();
    let mut subject = [2u8; 33];
    subject[29..].copy_from_slice(&n.to_be_bytes());
    let mut address = [0u8; 20];
    address[16..].copy_from_slice(&n.to_be_bytes());
    let enrollment = Enrollment {
        address,
        accepted_ms: u64::from(n) + 1,
        anchor: [1; 32],
        local: true,
        budget: cap,
    };
    match rows.store.kv().transact(|tx| {
        record(
            Some(&enrollment),
            NETWORK,
            &subject,
            tx,
            &Commit {
                first: true,
                status: &status,
            },
        )
    }) {
        Ok(()) => true,
        Err(RecordError::Refused(AdmissionError::Resource)) => false,
        Err(other) => panic!("{other:?}"),
    }
}

/// One worker process, started by the parent test below.
#[test]
#[ignore = "worker process for forward_claims_and_counters_across_processes"]
fn worker() {
    let Ok(subspace) = std::env::var(SUBSPACE) else {
        return;
    };
    // SAFETY: this worker owns the FDB network; every store is dropped before the guard.
    let network = unsafe { FdbNetwork::boot() };
    {
        let (kv, rows) = open(&subspace);
        let holder: [u8; 16] = rand::random();
        let mut stdin = std::io::stdin().lock().lines();
        let say = |line: &str| println!("{PROTOCOL}{line}");
        match std::env::var("FRANK_DIRECTORY_FDB_ROLE").unwrap().as_str() {
            // Claim the forward, report it, then wait to be killed before sending anything.
            "claim-and-die" => {
                let claimed = rows.claim_forward(&IDENTITY, &holder, 4_000).unwrap();
                assert!(matches!(claimed, ForwardClaimed::Claimed(_)), "{claimed:?}");
                say("claimed");
                let _ = stdin.next();
                unreachable!("killed before this line");
            }
            // Retry until the forward can be claimed, "send" once, record the final answer.
            "deliver" => {
                let deadline = Instant::now() + Duration::from_secs(30);
                let mut held = 0;
                let mut row = loop {
                    assert!(Instant::now() < deadline, "never claimed");
                    match rows.claim_forward(&IDENTITY, &holder, 60_000).unwrap() {
                        ForwardClaimed::Claimed(row) => break row,
                        ForwardClaimed::Held(_) => held += 1,
                        other => panic!("{other:?}"),
                    }
                    std::thread::sleep(Duration::from_millis(100));
                };
                kv.transact(|tx| tx.atomic_add(SENT, 1)).unwrap();
                row.done = true;
                row.status = 200;
                row.response = "delivered".into();
                assert!(rows.finish_forward(&IDENTITY, &holder, &row).unwrap());
                say(&format!("delivered after {held} held answers"));
            }
            // Race other processes for a fresh claim; report whether this one won.
            "race" => {
                assert_eq!(stdin.next().unwrap().unwrap(), "go");
                let claimed = rows.claim_forward(&[9; 32], &holder, 60_000).unwrap();
                say(if matches!(claimed, ForwardClaimed::Claimed(_)) {
                    "won"
                } else {
                    "lost"
                });
            }
            // Enroll subjects first..first+count against the cap; report how many succeeded.
            "enroll" => {
                let line = stdin.next().unwrap().unwrap();
                let numbers: Vec<u32> = line.split(' ').map(|n| n.parse().unwrap()).collect();
                let (first, count, cap) = (numbers[0], numbers[1], numbers[2]);
                let accepted = (first..first + count)
                    .filter(|n| enroll(&rows, *n, u64::from(cap)))
                    .count();
                say(&format!("enrolled {accepted}"));
            }
            role => panic!("unknown role {role}"),
        }
    }
    drop(network);
}

#[test]
#[ignore = "requires an explicitly configured live FoundationDB cluster"]
fn forward_claims_and_counters_across_processes() {
    // SAFETY: this test owns the process's FDB network and drops every store before it.
    let network = unsafe { FdbNetwork::boot() };
    let subspace = format!("frank-directory-fdb:{}:", uuid::Uuid::new_v4());
    {
        let (kv, rows) = open(&subspace);
        let row = ForwardRow {
            endpoint: "https://relay.example.invalid".into(),
            content_type: "application/vnd.frank.cbor".into(),
            sender: "subject".into(),
            network: NETWORK.into(),
            created_ms: 1,
            attempts: 0,
            next_ms: 0,
            done: false,
            status: 0,
            response: String::new(),
            echo: serde_json::json!({}),
            claim: None,
        };
        rows.put_forward(&IDENTITY, &row, Some(b"exact request"))
            .unwrap();

        // Replica A claims the forward and is killed mid-attempt, before it sends.
        let mut a = Worker::start(&subspace, "claim-and-die");
        assert_eq!(a.recv(), "claimed");
        a.child.kill().unwrap();
        let killed = a.child.wait().unwrap();
        assert!(!killed.success(), "SIGKILL: {killed:?}");
        // Replica B is refused while A's claim lives, then takes the forward over and
        // delivers it.
        let mut b = Worker::start(&subspace, "deliver");
        let delivered = b.recv();
        assert!(delivered.starts_with("delivered after "), "{delivered}");
        let held: u32 = delivered
            .trim_start_matches("delivered after ")
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(held > 0, "B must have waited for A's claim to expire");
        assert!(b.child.wait().unwrap().success());
        let stored = rows.forward(&IDENTITY).unwrap().unwrap();
        assert!(stored.done && stored.claim.is_none());
        assert_eq!(stored.response, "delivered");
        assert_eq!(rows.forward_body(&IDENTITY).unwrap(), None);
        assert_eq!(sent(&kv), 1, "the interrupted forward is sent exactly once");
        // Any replica asked again repeats the answer and sends nothing.
        assert!(matches!(
            rows.claim_forward(&IDENTITY, &[0xc; 16], 60_000).unwrap(),
            ForwardClaimed::Done(_)
        ));
        eprintln!("forward: A claimed and was SIGKILLed; B waited {held} rounds, sent once");

        // Four processes race to claim one new forward: exactly one wins.
        rows.put_forward(&[9; 32], &row, Some(b"another request"))
            .unwrap();
        let mut racers: Vec<_> = (0..4).map(|_| Worker::start(&subspace, "race")).collect();
        for racer in &mut racers {
            racer.send("go");
        }
        let winners = racers
            .iter_mut()
            .map(|racer| racer.recv())
            .filter(|answer| answer == "won")
            .count();
        for racer in &mut racers {
            assert!(racer.child.wait().unwrap().success());
        }
        assert_eq!(winners, 1);

        // Three processes enroll 20 subjects each against a cap of 25: exactly 25 succeed.
        let mut enrollers: Vec<_> = (0..3).map(|_| Worker::start(&subspace, "enroll")).collect();
        for (i, enroller) in enrollers.iter_mut().enumerate() {
            enroller.send(&format!("{} 20 25", i * 20));
        }
        let accepted: usize = enrollers
            .iter_mut()
            .map(|enroller| {
                enroller
                    .recv()
                    .trim_start_matches("enrolled ")
                    .parse::<usize>()
                    .unwrap()
            })
            .sum();
        for enroller in &mut enrollers {
            assert!(enroller.child.wait().unwrap().success());
        }
        assert_eq!(accepted, 25);
        assert_eq!(rows.counts().unwrap(), (25, 0));
        assert_eq!(rows.list(NETWORK, None, 100).unwrap().len(), 25);
        eprintln!("claims: 1 of 4 racing processes won; counters: 25 of 60 enrolled at cap 25");

        // Remove only this run's random subspace.
        let kv: Arc<dyn RelayKvStore> = kv;
        loop {
            let keys = kv.transact(|tx| tx.scan_prefix(b"", None, 1_000)).unwrap();
            if keys.is_empty() {
                break;
            }
            kv.transact(|tx| {
                for (key, _) in &keys {
                    tx.clear(key)?;
                }
                Ok::<_, crate::store::kv_store::KvError>(())
            })
            .unwrap();
        }
    }
    drop(network);
}
