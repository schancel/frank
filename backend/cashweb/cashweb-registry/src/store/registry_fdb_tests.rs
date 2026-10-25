//! HA plan step 7 acceptance against a live FoundationDB (`backend/labs/compose.foundationdb-nats.yml`).
//!
//! Two relay processes, each with its own FDB client and its own local disk, serve the real
//! HTTP routes over one registry subspace. The directory is still replica-local (step 8), so
//! every account publishes its entry on both relays before claiming a name.
//!
//! ```sh
//! FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster cargo test -p cashweb-registry \
//!   --features foundationdb --lib -- --ignored --exact \
//!   store::registry_fdb_tests::registry_is_shared_by_two_relays_through_foundationdb --nocapture
//! ```
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Arc,
};

use bitcoinsuite_core::{ecc::Ecc, Hashed, Net, Sha256};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use prost::Message;

use crate::{
    directory_runtime::{DirectoryRuntime, TestClock},
    disabled_chain_adapter::DisabledChainAdapter,
    http::{
        directory::tests::{entry, relay_config},
        server::RegistryServer,
    },
    monad_evm_tx::address_from_uncompressed_pubkey,
    p2p::peers::Peers,
    proto,
    registry::Registry,
    store::{
        db::Db,
        directory_usernames::{claim_text, tests::signed_claim},
        foundationdb_driver::FoundationDbKvStore,
    },
};

const NETWORK: &str = "monad-testnet";
const WORKER_SUBSPACE: &str = "FRANK_REGISTRY_WORKER_SUBSPACE";
const WORKER_DIR: &str = "FRANK_REGISTRY_WORKER_DIR";
const LISTENING: &str = "registry-worker listening ";
/// Names raced between the two relays.
const ROUNDS: u32 = 40;

fn cluster_file() -> String {
    std::env::var("FRANK_FDB_CLUSTER_FILE")
        .expect("FRANK_FDB_CLUSTER_FILE is required; refusing the default cluster")
}

fn shared_db(dir: &std::path::Path, subspace: &str) -> Db {
    let kv = FoundationDbKvStore::open(&cluster_file(), subspace.to_owned()).unwrap();
    let db = Db::open_shared(dir, Arc::new(kv)).unwrap();
    db.check_format().unwrap();
    db
}

/// One relay, started by [`registry_is_shared_by_two_relays_through_foundationdb`]: the real
/// router with the directory, over the shared registry subspace, until stdin closes.
#[test]
#[ignore = "worker process for registry_is_shared_by_two_relays_through_foundationdb"]
fn registry_relay_worker() {
    let (Ok(subspace), Ok(dir)) = (std::env::var(WORKER_SUBSPACE), std::env::var(WORKER_DIR))
    else {
        return;
    };
    // SAFETY: this worker process owns the FDB network. The runtime, and with it every task
    // holding the registry's store, shuts down before the guard stops the network.
    let network = unsafe { foundationdb::boot() };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(serve_until_stdin_closes(
        std::path::PathBuf::from(dir),
        subspace,
    ));
    drop(runtime);
    drop(network);
}

async fn serve_until_stdin_closes(dir: std::path::PathBuf, subspace: String) {
    let registry = Arc::new(Registry::new(
        shared_db(&dir.join("registry"), &subspace),
        Arc::new(DisabledChainAdapter),
        Net::Regtest,
    ));
    let (runtime, ready) = DirectoryRuntime::start_with_clock(
        Arc::clone(&registry),
        relay_config(),
        NETWORK,
        TestClock::at(1700000100).clock(),
    )
    .unwrap();
    ready.await.unwrap().unwrap();
    let event_bus = registry.event_bus().clone();
    let router = RegistryServer {
        registry,
        peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
        pop_gate: Arc::new(None),
        curated_defaults: Arc::new(vec![]),
        monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
        evm_rpc: None,
        bitcoin_proxy: None,
        solana_proxy: None,
        chains: Arc::new(crate::chains::RelayChains::network_only(NETWORK).unwrap()),
        forum: None,
        group_writes: None,
        spa_dir: None,
        event_bus,
    }
    .into_router_with_directory(Some(Arc::new(runtime.clone())));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = axum::Server::from_tcp(listener)
        .unwrap()
        .serve(router.into_make_service());
    println!("{LISTENING}{port}");
    let stdin_closed = tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    });
    tokio::select! {
        result = server => result.unwrap(),
        _ = stdin_closed => {}
    }
    // The directory owner thread holds the registry; join it before the store goes away.
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

struct Relay {
    child: Child,
    origin: String,
}

impl Relay {
    fn start(dir: &std::path::Path, subspace: &str) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "store::registry_fdb_tests::registry_relay_worker",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(WORKER_SUBSPACE, subspace)
            .env(WORKER_DIR, dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        for line in &mut stdout {
            // The harness's unterminated `test name ... ` may precede the tag on the same line.
            if let Some((_, port)) = line.unwrap().split_once(LISTENING) {
                // Keep reading, so the worker's later output never meets a closed pipe.
                std::thread::spawn(move || stdout.for_each(drop));
                return Relay {
                    child,
                    origin: format!("http://127.0.0.1:{}", port.trim()),
                };
            }
        }
        panic!("relay worker exited early: {:?}", child.wait());
    }

    fn stop(mut self) {
        drop(self.child.stdin.take());
        assert!(self.child.wait().unwrap().success());
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn claim(secret: u32, name: &str) -> Vec<u8> {
    let mut key = [0; 32];
    key[28..].copy_from_slice(&secret.to_be_bytes());
    signed_claim(key, &claim_text(NETWORK, name, now_ms()))
}

fn signed_profile(
    seckey_byte: u8,
    timestamp: i64,
    name: &str,
) -> (cashweb_payload::proto::SignedPayload, String) {
    let ecc = EccSecp256k1::default();
    let seckey = ecc.seckey_from_array([seckey_byte; 32]).unwrap();
    let pubkey = ecc.derive_pubkey(&seckey);
    let address = address_from_uncompressed_pubkey(&ecc.serialize_pubkey_uncompressed(&pubkey));
    let payload = proto::MonadProfile {
        timestamp,
        ttl: 0,
        entries: vec![proto::AddressEntry {
            kind: "display_name".into(),
            headers: Default::default(),
            body: name.as_bytes().to_vec(),
        }],
    }
    .encode_to_vec();
    let payload_hash = Sha256::digest(payload.clone().into());
    let signed = cashweb_payload::proto::SignedPayload {
        pubkey: pubkey.as_slice().to_vec(),
        sig: ecc
            .sign(&seckey, payload_hash.byte_array().clone())
            .to_vec(),
        sig_scheme: 1,
        payload,
        payload_hash: payload_hash.as_slice().to_vec(),
        burn_amount: 0,
        burn_txs: vec![],
    };
    (signed, address.to_hex())
}

async fn json(response: reqwest::Response) -> (u16, serde_json::Value) {
    let status = response.status().as_u16();
    let body = response.bytes().await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or_default())
}

async fn profiles(http: &reqwest::Client, url: String) -> Vec<proto::ListMonadProfilesEntry> {
    let response = http.get(url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    proto::ListMonadProfilesResponse::decode(response.bytes().await.unwrap())
        .unwrap()
        .entries
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires an explicitly configured live FoundationDB cluster"]
async fn registry_is_shared_by_two_relays_through_foundationdb() {
    // SAFETY: this test owns the process's FDB network and drops every store before it.
    let network = unsafe { foundationdb::boot() };
    let temp = tempfile::tempdir().unwrap();
    // A fresh subspace per run: nothing else in the lab is read or cleared.
    let subspace = format!("frank-registry-lab:{}:", uuid::Uuid::new_v4());
    let a = Relay::start(&temp.path().join("a"), &subspace);
    let b = Relay::start(&temp.path().join("b"), &subspace);
    let http = reqwest::Client::new();

    // The directory is replica-local until step 8: publish every racing account on both.
    let accounts: Vec<_> = (0..ROUNDS * 2).map(|i| entry(1000 + i, |_| ())).collect();
    for relay in [&a, &b] {
        for account in &accounts {
            let response = http
                .put(format!(
                    "{}/directory/v1/{NETWORK}/{}/head",
                    relay.origin, account.subject
                ))
                .header("content-type", "application/vnd.frank.cbor")
                .body(account.attestation.clone())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
        }
    }

    // Each name is claimed at once by one key on A and another key on B.
    let mut winners = BTreeMap::new();
    for round in 0..ROUNDS {
        let name = format!("race{round:03}");
        let (on_a, on_b) = (1000 + 2 * round, 1001 + 2 * round);
        let put = |origin: &str, secret: u32| {
            http.put(format!("{origin}/directory/user/{name}"))
                .body(claim(secret, &name))
                .send()
        };
        let (from_a, from_b) = tokio::join!(put(&a.origin, on_a), put(&b.origin, on_b));
        let (from_a, from_b) = (json(from_a.unwrap()).await, json(from_b.unwrap()).await);
        let results = [(on_a, &from_a), (on_b, &from_b)];
        let won: Vec<_> = results.iter().filter(|(_, (s, _))| *s == 200).collect();
        assert_eq!(won.len(), 1, "{name}: exactly one winner: {results:?}");
        let (_, (_, lost)) = results.iter().find(|(_, (s, _))| *s != 200).unwrap();
        assert_eq!(lost["error"], "taken", "{name}: {results:?}");
        let (winner, (_, body)) = won[0];
        let subject = body["subject"].as_str().unwrap().to_owned();
        assert_eq!(subject, accounts[(winner - 1000) as usize].subject);
        // Both relays resolve the name, and both addresses, the same way.
        let addresses = format!(
            "{},{}",
            accounts[(on_a - 1000) as usize].address,
            accounts[(on_b - 1000) as usize].address
        );
        for relay in [&a, &b] {
            let (status, held) = json(
                http.get(format!("{}/directory/user/{name}", relay.origin))
                    .send()
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(status, 200);
            assert_eq!(held["subject"], subject.as_str());
            let (status, users) = json(
                http.get(format!(
                    "{}/directory/users?addresses={addresses}",
                    relay.origin
                ))
                .send()
                .await
                .unwrap(),
            )
            .await;
            assert_eq!(status, 200);
            let users = users["users"].as_array().unwrap();
            assert_eq!(users.len(), 1, "{name}: {users:?}");
            assert_eq!(users[0]["username"], name.as_str());
            assert_eq!(users[0]["subject"], subject.as_str());
        }
        winners.insert(name, body["address"].as_str().unwrap().to_owned());
    }
    // The stored rows: one record per name and one reverse row per holder, agreeing exactly.
    let inspect = shared_db(&temp.path().join("inspect"), &subspace);
    let rows = inspect.raw_rows(b"u/").unwrap();
    assert_eq!(rows.len(), 2 * ROUNDS as usize);
    let mut names = BTreeMap::new();
    let mut reverse = BTreeMap::new();
    for (key, value) in rows {
        match key[2] {
            b'n' => {
                let record: serde_json::Value = serde_json::from_slice(&value).unwrap();
                let address = format!("0x{}", record["address"].as_str().unwrap());
                names.insert(String::from_utf8(key[3..].to_vec()).unwrap(), address);
            }
            b'a' => {
                reverse.insert(
                    format!("0x{}", hex::encode(&key[3..])),
                    String::from_utf8(value).unwrap(),
                );
            }
            other => panic!("unexpected username row kind {other}"),
        }
    }
    let lower = |m: &BTreeMap<String, String>| {
        m.iter()
            .map(|(k, v)| (k.to_lowercase(), v.to_lowercase()))
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(lower(&names), lower(&winners));
    let inverted: BTreeMap<_, _> = names.iter().map(|(n, a)| (a.clone(), n.clone())).collect();
    assert_eq!(lower(&reverse), lower(&inverted));

    // A profile replaced on A: B lists and finds only the new record and its index rows.
    let (old, address) = signed_profile(7, 1_000, "OldName");
    let (new, _) = signed_profile(7, 2_000, "NewName");
    for profile in [&old, &new] {
        let response = http
            .put(format!("{}/metadata/monad/{address}", a.origin))
            .body(profile.encode_to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    }
    let listed = profiles(&http, format!("{}/metadata/monad?since=0", b.origin)).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].address, address);
    assert_eq!(listed[0].signed_payload, new.encode_to_vec());
    let search = |prefix: &str| format!("{}/metadata/monad/search?prefix={prefix}", b.origin);
    assert!(profiles(&http, search("old")).await.is_empty());
    assert_eq!(profiles(&http, search("new")).await.len(), 1);
    let fetched = http
        .get(format!("{}/metadata/monad/{address}", b.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(fetched.bytes().await.unwrap(), new.encode_to_vec());
    // The superseded registration replayed to B is refused against A's write.
    let replay = http
        .put(format!("{}/metadata/monad/{address}", b.origin))
        .body(old.encode_to_vec())
        .send()
        .await
        .unwrap();
    assert!(replay.status().is_client_error(), "{}", replay.status());
    let raw = address.trim_start_matches("0x");
    let address_bytes = hex::decode(raw).unwrap();
    let keys = |prefix: &[u8]| -> Vec<Vec<u8>> {
        inspect
            .raw_rows(prefix)
            .unwrap()
            .into_iter()
            .map(|(k, _)| k)
            .collect()
    };
    assert_eq!(
        keys(b"pt/"),
        vec![[b"pt/".as_slice(), &2_000i64.to_be_bytes(), &address_bytes].concat()]
    );
    assert_eq!(
        keys(b"pn/"),
        vec![[b"pn/newname".as_slice(), &address_bytes].concat()]
    );
    assert_eq!(inspect.monad_profiles().count_records().unwrap(), 1);

    a.stop();
    b.stop();
    drop(inspect);
    drop(network);
}
