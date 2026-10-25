//! The real daemon in cluster mode against a live FoundationDB and Core NATS (the
//! `backend/labs/compose.foundationdb-nats.yml` lab). Two relay processes with separate local
//! disks share the group store; a third start on a fresh disk still reads it.
//!
//! ```sh
//! FRANK_FDB_CLUSTER_FILE=/cluster/fdb.cluster FRANK_LAB_NATS_URL=nats://nats:4222 \
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
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};

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
    /// Start one replica of `cluster` with its own local disk under `dir`.
    fn start(dir: &Path, shared: &Path, cluster: &str, subspace: &str) -> Self {
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
groups = {{ per_message_price_credits = 0 }}
db_path = "{db}"
network = "monad-testnet"
net = "mainnet"
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

    fn kill(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the FoundationDB + NATS lab: FRANK_FDB_CLUSTER_FILE and FRANK_LAB_NATS_URL"]
async fn cluster_mode_daemons_share_groups_through_foundationdb() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("provisioned");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join("session-secret"), rand::random::<[u8; 32]>()).unwrap();
    std::fs::write(
        shared.join("vapid-private-key"),
        hex::encode(rand::random::<[u8; 32]>()),
    )
    .unwrap();
    // A fresh cluster name and subspace per run: nothing else in the lab is read or cleared.
    let run = hex::encode(rand::random::<[u8; 6]>());
    let cluster = format!("daemon-{run}");
    let subspace = format!("frank-daemon-test/{run}/");

    let a = Relay::start(&temp.path().join("a"), &shared, &cluster, &subspace);
    let b = Relay::start(&temp.path().join("b"), &shared, &cluster, &subspace);
    for relay in [&a, &b] {
        let log = relay.log();
        assert!(
            log.contains("FoundationDB group store is readable"),
            "{log}"
        );
        assert!(log.contains(&format!("subjects frank.{cluster}.")), "{log}");
        // The preview names every still replica-local owner; groups are not among them.
        assert!(
            log.contains("Replica-local owner: registry database"),
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
    let appended = http
        .put(format!("{}/groups/{group_id}/messages", b.origin))
        .json(&envelope)
        .send()
        .await
        .unwrap();
    assert_eq!(appended.status(), 200, "{}", appended.text().await.unwrap());

    // A third replica on an empty disk reads the same message: the state is in FoundationDB.
    a.kill();
    let c = Relay::start(&temp.path().join("c"), &shared, &cluster, &subspace);
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
    b.kill();
    c.kill();
}
