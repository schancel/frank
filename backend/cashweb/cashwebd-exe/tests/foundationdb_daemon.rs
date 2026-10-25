//! The real daemon in cluster mode against a live FoundationDB and Core NATS (the
//! `backend/labs/compose.foundationdb-nats.yml` lab). Two relay processes with separate local
//! disks share the group store; a third start on a fresh disk still reads it. The append pays
//! its relay on solonet (`monad-regtest`), so the relays and the test reach it at
//! `FRANK_LAB_SOLONET_RPC_URL`.
//!
//! ```sh
//! FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster FRANK_LAB_NATS_URL=nats://nats:4222 \
//!   FRANK_LAB_SOLONET_RPC_URL=http://host.docker.internal:48080 \
//!   cargo test -p cashwebd-exe --features foundationdb --test foundationdb_daemon -- --ignored
//! ```
#![cfg(feature = "foundationdb")]

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use cashweb_registry::store::groups::{derive_group_id, GroupEpochFrame, GroupMessageEnvelope};
use futures::{SinkExt, StreamExt};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tokio_tungstenite::{connect_async, tungstenite};

#[path = "../../../labs/solonet_payer.rs"]
mod solonet_payer;
use solonet_payer::{paid_body, write_policy, Solonet};

/// The daemon under test: the binary Cargo built, or `FRANK_CASHWEBD_EXE` when the test
/// executable was copied out of its build tree (the lab image does this).
fn daemon_exe() -> PathBuf {
    std::env::var_os("FRANK_CASHWEBD_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_cashwebd-exe")))
}

struct Relay {
    child: Child,
    origin: String,
    log: PathBuf,
}

impl Relay {
    /// Start one replica of `cluster` with its own local disk under `dir`, on solonet at
    /// `rpc` whose block 1 is `checkpoint`.
    fn start(
        dir: &Path,
        shared: &Path,
        cluster: &str,
        subspace: &str,
        (rpc, checkpoint): (&str, &str),
    ) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .unwrap()
            .port();
        let fdb = std::env::var("FRANK_FDB_CLUSTER_FILE").expect("FRANK_FDB_CLUSTER_FILE");
        let nats = std::env::var("FRANK_LAB_NATS_URL").expect("FRANK_LAB_NATS_URL");
        let config = format!(
            r#"
host = "127.0.0.1:{port}"
url = "http://127.0.0.1:{port}"

[registry]
db_path = "{db}"
network = "monad-regtest"
net = "regtest"
peers = []
session_secret_file = "{shared}/session-secret"
vapid_private_key_file = "{shared}/vapid-private-key"

[registry.cluster]
enabled = true
driver = "foundationdb"
fdb_cluster_file = "{fdb}"
fdb_subspace_prefix = "{subspace}"
cluster_name = "{cluster}"
preview_replica_local_owners = true

[registry.cluster.nats]
enabled = true
url = "{nats}"

[registry.group_writes]
price_wei = "1000000000000"
payee = "burn"

[registry.evm_rpc]
enabled = true
capability_ttl_ms = 3600000
anonymous_units_per_hour = 1000000

[[registry.evm_rpc.chains]]
id = "monad-regtest"
expected_chain_id = 20143
upstream_env = "MONAD_REGTEST_HTTP_RPC_URL"
checkpoint_block_number = 1
checkpoint_block_hash = "{checkpoint}"
max_get_logs_range = 10

[registry.monad_mailbox]
enabled = false

[registry.pop]
enabled = false
monad_rpc_url = "http://unused.invalid"
hmac_secret = "unused-because-pop-is-disabled"
payment_recipient = "0x0000000000000000000000000000000000000000"
min_value_wei = "0"
"#,
            db = dir.join("registry.rocksdb").display(),
            shared = shared.display(),
        );
        let conf = dir.join("relay.toml");
        std::fs::write(&conf, config).unwrap();
        let log = dir.join("relay.log");
        let out = std::fs::File::create(&log).unwrap();
        let child = Command::new(daemon_exe())
            .arg(&conf)
            .env_remove("MONAD_TESTNET_HTTP_RPC_URL")
            .env("MONAD_REGTEST_HTTP_RPC_URL", rpc)
            .stdin(Stdio::null())
            .stdout(out.try_clone().unwrap())
            .stderr(out)
            .spawn()
            .unwrap();
        let mut relay = Relay {
            child,
            origin: format!("http://127.0.0.1:{port}"),
            log,
        };
        relay.wait_listening();
        relay
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn wait_listening(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if self.log().contains("Listening on 127.0.0.1") {
                return;
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("relay exited with {status}: {}", self.log());
            }
            assert!(
                Instant::now() < deadline,
                "relay never listened: {}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn kill(self) {
        drop(self);
    }
}

/// A relay never outlives its test, including one that panics.
impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Write a provisioned file readable by its owner only, as the relay requires.
fn write_provisioned(path: &Path, contents: impl AsRef<[u8]>) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// The relay's own wakeup interval for every live subscriber (its recovery tick).
const RECOVERY_TICK: Duration = Duration::from_secs(5);
/// Scheduling slack allowed for that tick.
const TICK_MARGIN: Duration = Duration::from_millis(500);

/// The next `group-wakeup` on `socket` within `timeout`.
async fn next_wakeup<S>(socket: &mut S, timeout: Duration) -> Option<Instant>
where
    S: futures::Stream<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::time::timeout_at(deadline, socket.next()).await {
            Ok(Some(Ok(tungstenite::Message::Text(text)))) if text.contains("group-wakeup") => {
                return Some(Instant::now())
            }
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

fn key(seed: [u8; 32]) -> (SecretKey, [u8; 33]) {
    let secret = SecretKey::from_slice(&seed).unwrap();
    let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret).serialize();
    (secret, public)
}

fn sign(secret: &SecretKey, digest: &[u8; 32]) -> String {
    let signature = Secp256k1::new().sign(&Message::from_slice(digest).unwrap(), secret);
    hex::encode(signature.serialize_compact())
}

/// A protobuf profile registration signed by a fresh key, and the `0x` address it is for.
fn signed_profile(timestamp: i64, name: &str) -> (Vec<u8>, String) {
    use bitcoinsuite_core::{ecc::Ecc, Hashed, Sha256};
    use prost::Message;
    let ecc = bitcoinsuite_ecc_secp256k1::EccSecp256k1::default();
    let seckey = ecc.seckey_from_array(PROFILE_KEY).unwrap();
    let pubkey = ecc.derive_pubkey(&seckey);
    let address = frank_cbor::address_from_compressed_pubkey(pubkey.as_slice()).unwrap();
    let payload = cashweb_registry::proto::MonadProfile {
        timestamp,
        ttl: 0,
        entries: vec![cashweb_registry::proto::AddressEntry {
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
    (
        signed.encode_to_vec(),
        format!("0x{}", hex::encode(address)),
    )
}

const PROFILE_KEY: [u8; 32] = [0x5a; 32];

/// `(address, stored bytes)` of a profile listing or search.
async fn list_profiles(http: &reqwest::Client, url: String) -> Vec<(String, Vec<u8>)> {
    use prost::Message;
    let response = http.get(url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    cashweb_registry::proto::ListMonadProfilesResponse::decode(response.bytes().await.unwrap())
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| (entry.address, entry.signed_payload))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the FoundationDB + NATS lab and solonet: FRANK_FDB_CLUSTER_FILE, \
            FRANK_LAB_NATS_URL and FRANK_LAB_SOLONET_RPC_URL"]
async fn cluster_mode_daemons_share_groups_through_foundationdb() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("provisioned");
    std::fs::create_dir_all(&shared).unwrap();
    write_provisioned(&shared.join("session-secret"), rand::random::<[u8; 32]>());
    // Any random 32 bytes below the P-256 order; the top byte keeps it well below n.
    let mut vapid = rand::random::<[u8; 32]>();
    vapid[0] = 0x7f;
    write_provisioned(&shared.join("vapid-private-key"), hex::encode(vapid));
    // A fresh cluster name and subspace per run: nothing else in the lab is read or cleared.
    let run = hex::encode(rand::random::<[u8; 6]>());
    let cluster = format!("daemon-{run}");
    let subspace = format!("frank-daemon-test/{run}/");
    let solonet = Solonet::from_env().await;
    let checkpoint = solonet.block_hash(1).await;
    let chain = (solonet.rpc_url(), checkpoint.as_str());
    // Swept back to the faucet when dropped, at the end of the test or while it unwinds.
    let funded = solonet.fund(1).await;
    let payer = funded.take();

    let a = Relay::start(&temp.path().join("a"), &shared, &cluster, &subspace, chain);
    let b = Relay::start(&temp.path().join("b"), &shared, &cluster, &subspace, chain);
    for relay in [&a, &b] {
        let log = relay.log();
        assert!(
            log.contains("FoundationDB group store is readable"),
            "{log}"
        );
        assert!(log.contains(&format!("subjects frank.{cluster}.")), "{log}");
        assert!(
            log.contains("FoundationDB registry store is readable"),
            "{log}"
        );
        // The preview names every still replica-local owner; the registry database and groups
        // are not among them.
        assert!(
            !log.contains("Replica-local owner: registry database"),
            "{log}"
        );
        assert!(!log.contains("Replica-local owner: groups"), "{log}");
        // Provisioned files are read, never generated beside the database.
        assert!(!relay
            .log
            .parent()
            .unwrap()
            .join("registry.session-secret")
            .exists());
    }

    let (root, root_pub) = key(rand::random());
    let (write, write_pub) = key(rand::random());
    let token = rand::random::<[u8; 32]>();
    let group_id = hex::encode(derive_group_id(&root_pub));
    let mut epoch = GroupEpochFrame {
        group_id: group_id.clone(),
        group_pubkey: hex::encode(root_pub),
        epoch: 0,
        prev_epoch_hash: "00".repeat(32),
        write_pubkey: hex::encode(write_pub),
        read_token_hash: hex::encode(Sha256::digest(token)),
        encrypted_epoch_descriptor: hex::encode(b"daemon test descriptor"),
        admin_sig: String::new(),
        epoch_hash: String::new(),
    };
    epoch.admin_sig = sign(&root, &epoch.compute_epoch_hash().unwrap());
    let http = reqwest::Client::new();
    let created = http
        .put(format!("{}/groups/{group_id}/epochs", a.origin))
        .json(&epoch)
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200, "{}", created.text().await.unwrap());

    // A subscriber on replica A is woken over NATS by B's append. The relay also wakes every
    // subscriber on its own every 5 s, so wait for one of those first: a wakeup well inside the
    // next 5 s after the append can only have come from B's commit.
    let live = format!(
        "ws://{}/groups/{group_id}/live",
        a.origin.trim_start_matches("http://")
    );
    let (mut socket, _) = connect_async(&live).await.unwrap();
    socket
        .send(tungstenite::Message::Text(
            serde_json::json!({ "epoch": 0, "read_token": hex::encode(token) }).to_string(),
        ))
        .await
        .unwrap();
    let tick = next_wakeup(&mut socket, Duration::from_secs(8))
        .await
        .unwrap_or_else(|| panic!("no recovery-tick wakeup on A: {}", a.log()));
    // A's next tick is about RECOVERY_TICK after the one just seen. Only a wakeup that lands
    // clearly before it can have come from B's commit.
    let next_tick = tick + RECOVERY_TICK;

    // Replica B reads the group A created and appends to it.
    let read = http
        .get(format!("{}/groups/{group_id}/epochs", b.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), 200);
    assert_eq!(read.json::<GroupEpochFrame>().await.unwrap().epoch, 0);
    let mut envelope = GroupMessageEnvelope {
        group_id: group_id.clone(),
        epoch: 0,
        nonce: hex::encode(rand::random::<[u8; 24]>()),
        ciphertext: hex::encode(b"sealed by the daemon test"),
        write_sig: String::new(),
    };
    envelope.write_sig = sign(&write, &envelope.signing_digest().unwrap());
    // Paid as B asks: B's own origin, so the payment funds this write on B only.
    let policy = write_policy(&http, &b.origin, &group_id).await;
    let (payment, tx_hash) = solonet.payment(payer, &policy, &envelope);
    let appended = http
        .put(format!("{}/groups/{group_id}/messages", b.origin))
        .header("content-type", "application/json")
        .body(paid_body(&envelope, &payment))
        .send()
        .await
        .unwrap();
    assert_eq!(appended.status(), 200, "{}", appended.text().await.unwrap());
    let sent = Instant::now();
    let window_end = next_tick - TICK_MARGIN;
    assert!(
        sent + Duration::from_millis(500) < window_end,
        "the append was sent {:?} after A's tick, too late to tell NATS from the next tick",
        sent - tick
    );
    let woken = next_wakeup(&mut socket, window_end - Instant::now())
        .await
        .unwrap_or_else(|| {
            panic!(
                "A's subscriber was not woken by B's append before A's next tick \
                 (append sent {:?} after the tick)",
                sent - tick
            )
        });
    println!(
        "A woken {:?} after B's append, {:?} after A's own tick",
        woken - sent,
        woken - tick
    );
    drop(socket);
    // B handed the payment to solonet after the commit.
    solonet.wait_landed(&tx_hash).await;

    // The registry is shared too: a profile replaced on A is the only record B lists or finds.
    let (old, address) = signed_profile(1_000, "OldName");
    let (new, _) = signed_profile(2_000, "NewName");
    for profile in [&old, &new] {
        let response = http
            .put(format!("{}/metadata/monad/{address}", a.origin))
            .body(profile.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    }
    let listed = list_profiles(&http, format!("{}/metadata/monad?since=0", b.origin)).await;
    assert_eq!(listed, vec![(address.clone(), new.clone())]);
    let found = |prefix: &str| format!("{}/metadata/monad/search?prefix={prefix}", b.origin);
    assert_eq!(list_profiles(&http, found("old")).await, vec![]);
    assert_eq!(list_profiles(&http, found("new")).await.len(), 1);

    // A third replica on an empty disk reads the same message: the state is in FoundationDB.
    a.kill();
    let c = Relay::start(&temp.path().join("c"), &shared, &cluster, &subspace, chain);
    let page: serde_json::Value = http
        .get(format!(
            "{}/groups/{group_id}/messages?after_seq=0",
            c.origin
        ))
        .header("x-group-read-token", hex::encode(token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "{page}");
    assert_eq!(messages[0]["server_seq"], 1);
    assert_eq!(messages[0]["nonce"], envelope.nonce);
    // ... and the profile, with A gone.
    let fetched = http
        .get(format!("{}/metadata/monad/{address}", c.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(fetched.bytes().await.unwrap().to_vec(), new);
    b.kill();
    c.kill();
}
