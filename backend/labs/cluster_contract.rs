//! HTTP contract of the compose cluster lab (`backend/labs/compose.cluster.yml`): three real
//! relays on one FoundationDB, Core NATS between them. Built in the lab image as an
//! integration test of `cashweb-registry` and run by the `cluster-contract` profile.
//!
//! The fault cases stop and start this Compose project's own containers through the Docker
//! socket (found by the project label of the container running the test), so the tests run
//! one at a time (`--test-threads=1`). Every test uses a fresh group, so reruns against the
//! same volumes do not interfere.
//!
//! Paid group writes (HA step 5, PR #1847) add their cases here once `[registry.group_writes]`
//! lands: a paid append accepted and broadcast, a replay on another relay rejected, one
//! payment sent to A and B giving one append, and wrong payee, chain, value or commitment
//! rejected with no sequence consumed, all on solonet (`monad-regtest`). Until then the lab
//! runs the free group policy (`per_message_price_credits = 0`) and nothing here pays.
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use cashweb_registry::store::groups::{
    derive_group_id, GroupEpochFrame, GroupMessageEnvelope, StoredGroupMessage,
};
use futures::{SinkExt, StreamExt};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tokio_tungstenite::{connect_async, tungstenite};

// ---------------------------------------------------------------------------------------------
// Lab access
// ---------------------------------------------------------------------------------------------

fn relays() -> Vec<String> {
    std::env::var("FRANK_CLUSTER_RELAYS")
        .expect("FRANK_CLUSTER_RELAYS: comma-separated relay origins")
        .split(',')
        .map(str::to_owned)
        .collect()
}

fn proxy() -> String {
    std::env::var("FRANK_CLUSTER_PROXY").expect("FRANK_CLUSTER_PROXY")
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
}

/// The Docker Engine API over the mounted socket, through `curl`.
fn docker(method: &str, path: &str) -> (u16, String) {
    let output = Command::new("curl")
        .args([
            "--silent",
            "--unix-socket",
            "/var/run/docker.sock",
            "--request",
            method,
            "--write-out",
            "\n%{http_code}",
            &format!("http://localhost{path}"),
        ])
        .output()
        .expect("curl");
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let (body, status) = text.rsplit_once('\n').unwrap_or(("", "0"));
    (status.trim().parse().unwrap_or(0), body.to_owned())
}

/// The id of this Compose project's container for `service`.
fn container(service: &str) -> String {
    let me = std::fs::read_to_string("/etc/hostname").unwrap();
    let (status, body) = docker("GET", &format!("/containers/{}/json", me.trim()));
    assert_eq!(status, 200, "inspect own container: {body}");
    let own: serde_json::Value = serde_json::from_str(&body).unwrap();
    let project = own["Config"]["Labels"]["com.docker.compose.project"]
        .as_str()
        .expect("the contract runs as a Compose service")
        .to_owned();
    let filters = serde_json::json!({
        "label": [
            format!("com.docker.compose.project={project}"),
            format!("com.docker.compose.service={service}"),
        ]
    });
    let encoded: String =
        url::form_urlencoded::byte_serialize(filters.to_string().as_bytes()).collect();
    let (status, body) = docker(
        "GET",
        &format!("/containers/json?all=true&filters={encoded}"),
    );
    assert_eq!(status, 200, "{body}");
    let list: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap();
    assert_eq!(
        list.len(),
        1,
        "one {service} container in {project}: {body}"
    );
    list[0]["Id"].as_str().unwrap().to_owned()
}

/// When this project's `service` container last started (`State.StartedAt`).
fn started_at(service: &str) -> String {
    let (status, body) = docker("GET", &format!("/containers/{}/json", container(service)));
    assert_eq!(status, 200, "inspect {service}: {body}");
    let state: serde_json::Value = serde_json::from_str(&body).unwrap();
    state["State"]["StartedAt"].as_str().unwrap().to_owned()
}

fn container_action(service: &str, action: &str) {
    let id = container(service);
    let (status, body) = docker("POST", &format!("/containers/{id}/{action}"));
    assert!(
        status == 204 || status == 304,
        "{action} {service}: {status} {body}"
    );
    println!("lab: {action} {service}");
}

async fn wait_ready(origin: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    let client = http();
    loop {
        if let Ok(response) = client.get(format!("{origin}/chains")).send().await {
            if response.status().is_success() {
                return;
            }
        }
        assert!(Instant::now() < deadline, "{origin} not ready");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

fn key() -> (SecretKey, [u8; 33]) {
    let secret = SecretKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
    let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret).serialize();
    (secret, public)
}

fn sign(secret: &SecretKey, digest: &[u8; 32]) -> String {
    let signature = Secp256k1::new().sign(&Message::from_slice(digest).unwrap(), secret);
    hex::encode(signature.serialize_compact())
}

/// One epoch's shared write key and read token, and its root-signed frame.
#[derive(Clone)]
struct Epoch {
    write: SecretKey,
    token: String,
    frame: GroupEpochFrame,
}

struct Group {
    id: String,
    root: SecretKey,
    root_pub: [u8; 33],
    epochs: Vec<Epoch>,
}

impl Group {
    fn new() -> Self {
        let (root, root_pub) = key();
        let mut group = Group {
            id: hex::encode(derive_group_id(&root_pub)),
            root,
            root_pub,
            epochs: Vec::new(),
        };
        group.next_epoch();
        group
    }

    /// Sign the next epoch frame (epoch 0 first) and make it current locally.
    fn next_epoch(&mut self) -> &Epoch {
        let (write, write_pub) = key();
        let token = rand::random::<[u8; 32]>();
        let (number, prev) = match self.epochs.last() {
            Some(last) => (
                last.frame.epoch + 1,
                hex::encode(last.frame.compute_epoch_hash().unwrap()),
            ),
            None => (0, "00".repeat(32)),
        };
        let mut frame = GroupEpochFrame {
            group_id: self.id.clone(),
            group_pubkey: hex::encode(self.root_pub),
            epoch: number,
            prev_epoch_hash: prev,
            write_pubkey: hex::encode(write_pub),
            read_token_hash: hex::encode(Sha256::digest(token)),
            encrypted_epoch_descriptor: hex::encode(format!("cluster lab epoch {number}")),
            admin_sig: String::new(),
            epoch_hash: String::new(),
        };
        frame.admin_sig = sign(&self.root, &frame.compute_epoch_hash().unwrap());
        self.epochs.push(Epoch {
            write,
            token: hex::encode(token),
            frame,
        });
        self.epochs.last().unwrap()
    }

    fn current(&self) -> &Epoch {
        self.epochs.last().unwrap()
    }

    /// A fresh signed envelope for `epoch`.
    fn envelope(&self, epoch: &Epoch, body: &str) -> GroupMessageEnvelope {
        let mut envelope = GroupMessageEnvelope {
            group_id: self.id.clone(),
            epoch: epoch.frame.epoch,
            nonce: hex::encode(rand::random::<[u8; 24]>()),
            ciphertext: hex::encode(body),
            write_sig: String::new(),
        };
        envelope.write_sig = sign(&epoch.write, &envelope.signing_digest().unwrap());
        envelope
    }
}

async fn put_epoch(client: &reqwest::Client, origin: &str, frame: &GroupEpochFrame) -> u16 {
    let response = client
        .put(format!("{origin}/groups/{}/epochs", frame.group_id))
        .header("content-type", "application/json")
        .body(serde_json::to_vec(frame).unwrap())
        .send()
        .await
        .unwrap();
    response.status().as_u16()
}

async fn create(client: &reqwest::Client, origin: &str, group: &Group) {
    let status = put_epoch(client, origin, &group.current().frame).await;
    assert_eq!(status, 200, "create group on {origin}");
}

/// One append answer: status, the `x-group-append-disposition`, and the stored row on success.
struct Appended {
    status: u16,
    disposition: Option<String>,
    message: Option<StoredGroupMessage>,
}

async fn append(
    client: &reqwest::Client,
    origin: &str,
    envelope: &GroupMessageEnvelope,
) -> Result<Appended, reqwest::Error> {
    let response = client
        .put(format!("{origin}/groups/{}/messages", envelope.group_id))
        .header("content-type", "application/json")
        .body(serde_json::to_vec(envelope).unwrap())
        .send()
        .await?;
    let status = response.status().as_u16();
    let disposition = response
        .headers()
        .get("x-group-append-disposition")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await?;
    let message = (status == 200).then(|| serde_json::from_slice(&bytes).unwrap());
    Ok(Appended {
        status,
        disposition,
        message,
    })
}

/// Every message after `after_seq`, read page by page from `origin`.
async fn read_from(
    client: &reqwest::Client,
    origin: &str,
    group: &str,
    token: &str,
    mut after_seq: u64,
) -> Vec<StoredGroupMessage> {
    let mut all = Vec::new();
    loop {
        let response = client
            .get(format!(
                "{origin}/groups/{group}/messages?after_seq={after_seq}&limit=500"
            ))
            .header("x-group-read-token", token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "read from {origin}");
        let page: serde_json::Value =
            serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        let messages: Vec<StoredGroupMessage> =
            serde_json::from_value(page["messages"].clone()).unwrap();
        if messages.is_empty() {
            return all;
        }
        after_seq = page["next_after_seq"].as_u64().unwrap();
        all.extend(messages);
    }
}

/// Assert `messages` hold sequence numbers exactly 1..=n, in order.
fn assert_gap_free(messages: &[StoredGroupMessage], origin: &str) {
    for (index, message) in messages.iter().enumerate() {
        assert_eq!(
            message.server_seq,
            index as u64 + 1,
            "{origin}: gap or reorder at position {index}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Live subscriptions
// ---------------------------------------------------------------------------------------------

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn subscribe(origin: &str, group: &Group) -> Socket {
    let url = format!(
        "{}/groups/{}/live",
        origin.replacen("http://", "ws://", 1),
        group.id
    );
    let (mut socket, _) = connect_async(&url).await.unwrap();
    let auth = serde_json::json!({
        "epoch": group.current().frame.epoch,
        "read_token": group.current().token,
    });
    socket
        .send(tungstenite::Message::Text(auth.to_string()))
        .await
        .unwrap();
    socket
}

/// The next `group-wakeup` within `timeout`; `None` on timeout or a closed socket.
async fn next_wakeup(socket: &mut Socket, timeout: Duration) -> Option<Instant> {
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

/// The relay also sends a wakeup on its own every 5 s (its recovery tick). Wait for one, so the
/// next tick is about 5 s away, then append on `writer`: a wakeup well before that tick can only
/// have come over NATS from the writer's commit.
async fn wakes_for_append_elsewhere(
    socket: &mut Socket,
    client: &reqwest::Client,
    writer: &str,
    group: &Group,
) -> bool {
    if next_wakeup(socket, Duration::from_secs(8)).await.is_none() {
        return false;
    }
    let appended = append(client, writer, &group.envelope(group.current(), "wake"))
        .await
        .unwrap();
    assert_eq!(appended.status, 200);
    let sent = Instant::now();
    match next_wakeup(socket, Duration::from_secs(4)).await {
        Some(woken) => woken.duration_since(sent) < Duration::from_millis(3000),
        None => false,
    }
}

// ---------------------------------------------------------------------------------------------
// Load with faults
// ---------------------------------------------------------------------------------------------

/// What a load run saw: each envelope's acknowledged sequence number by nonce, and how the
/// writers' attempts behaved while the fault was in effect.
struct LoadOutcome {
    acknowledged: BTreeMap<String, u64>,
    /// Failed or unanswered attempts that overlapped the fault window.
    failed_in_fault: usize,
    /// The slowest attempt that overlapped the fault window.
    slowest_in_fault: Duration,
    /// The slowest attempt that ended before the fault, after each writer's warm-up.
    /// Reported only: an early slow attempt must not move what counts as felt.
    slowest_baseline: Duration,
}

/// Attempts at least this long that overlap the fault window show the writers felt it.
const FELT_LATENCY: Duration = Duration::from_secs(1);
/// Each writer's first attempts (connection setup, first transactions) are not baseline.
const WARMUP_ATTEMPTS: usize = 10;

impl LoadOutcome {
    /// The writers felt the fault: an attempt that overlapped the fault window failed, or
    /// took at least [`FELT_LATENCY`].
    fn fault_was_felt(&self) -> bool {
        self.failed_in_fault > 0 || self.slowest_in_fault >= FELT_LATENCY
    }
}

/// The whole load, fault included, must finish within this.
const LOAD_DEADLINE: Duration = Duration::from_secs(300);

/// Three writers, one per relay, each appending `per_writer` distinct envelopes. A failed or
/// unanswered append is retried, with the same envelope, on the next relay until one
/// acknowledges it, as a client would. After `fault_after` acknowledgements `fault` runs once.
/// Fails, rather than hangs, if the load does not finish within [`LOAD_DEADLINE`].
async fn load_with_fault<F, Fut>(
    group: &Arc<Group>,
    per_writer: usize,
    fault_after: usize,
    fault: F,
) -> LoadOutcome
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let started = Instant::now();
    let relays = Arc::new(relays());
    let acked = Arc::new(AtomicUsize::new(0));
    let retries = Arc::new(AtomicUsize::new(0));
    let mut writers = Vec::new();
    for writer in 0..3 {
        let (group, relays, acked, retries) = (
            Arc::clone(group),
            Arc::clone(&relays),
            Arc::clone(&acked),
            Arc::clone(&retries),
        );
        writers.push(tokio::spawn(async move {
            let client = http();
            let mut receipts = Vec::new();
            // (attempt started, its duration, whether it failed)
            let mut attempts = Vec::new();
            let deadline = started + LOAD_DEADLINE;
            for index in 0..per_writer {
                let envelope = group.envelope(group.current(), &format!("load {writer}/{index}"));
                let mut target = writer;
                loop {
                    assert!(Instant::now() < deadline, "writer {writer} never finished");
                    let attempt = Instant::now();
                    let answer = append(&client, &relays[target % 3], &envelope).await;
                    let ok = matches!(&answer, Ok(answer) if answer.status == 200);
                    attempts.push((attempt, attempt.elapsed(), !ok));
                    match answer {
                        Ok(answer) if answer.status == 200 => {
                            let message = answer.message.unwrap();
                            assert_eq!(message.nonce, envelope.nonce);
                            receipts.push((envelope.nonce.clone(), message.server_seq));
                            acked.fetch_add(1, Ordering::SeqCst);
                            break;
                        }
                        _ => {
                            retries.fetch_add(1, Ordering::SeqCst);
                            target += 1;
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            }
            (receipts, attempts)
        }));
    }
    while acked.load(Ordering::SeqCst) < fault_after {
        assert!(
            started.elapsed() < LOAD_DEADLINE,
            "only {} of {fault_after} appends acknowledged before the deadline",
            acked.load(Ordering::SeqCst)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = acked.load(Ordering::SeqCst);
    let fault_start = Instant::now();
    tokio::time::timeout(LOAD_DEADLINE.saturating_sub(started.elapsed()), fault())
        .await
        .expect("the fault did not finish before the deadline");
    let fault_end = Instant::now();
    println!(
        "load: fault injected after {before} acknowledgements; {} when it finished",
        acked.load(Ordering::SeqCst)
    );
    let mut outcome = LoadOutcome {
        acknowledged: BTreeMap::new(),
        failed_in_fault: 0,
        slowest_in_fault: Duration::ZERO,
        slowest_baseline: Duration::ZERO,
    };
    for writer in writers {
        let remaining = LOAD_DEADLINE.saturating_sub(started.elapsed());
        let (receipts, attempts) = tokio::time::timeout(remaining, writer)
            .await
            .expect("a writer did not finish before the deadline")
            .unwrap();
        for (nonce, seq) in receipts {
            assert!(outcome.acknowledged.insert(nonce, seq).is_none());
        }
        for (index, (at, took, failed)) in attempts.into_iter().enumerate() {
            let end = at + took;
            if at < fault_end && end > fault_start {
                outcome.slowest_in_fault = outcome.slowest_in_fault.max(took);
                outcome.failed_in_fault += usize::from(failed);
            } else if end <= fault_start && index >= WARMUP_ATTEMPTS {
                outcome.slowest_baseline = outcome.slowest_baseline.max(took);
            }
        }
    }
    println!(
        "load: {} acknowledged appends, {} failed attempts retried; in the {:?} fault \
         window {} failed and the slowest took {:?} (baseline after warm-up {:?})",
        outcome.acknowledged.len(),
        retries.load(Ordering::SeqCst),
        fault_end - fault_start,
        outcome.failed_in_fault,
        outcome.slowest_in_fault,
        outcome.slowest_baseline,
    );
    outcome
}

/// Every acknowledged append is readable on every relay at its acknowledged sequence number,
/// and the log holds exactly those appends, gap-free.
async fn assert_every_acknowledged_append_readable(
    group: &Group,
    acknowledged: &BTreeMap<String, u64>,
) {
    let client = http();
    for origin in relays() {
        wait_ready(&origin).await;
        let messages = read_from(&client, &origin, &group.id, &group.current().token, 0).await;
        assert_gap_free(&messages, &origin);
        assert_eq!(
            messages.len(),
            acknowledged.len(),
            "{origin}: a retried append was stored twice or an acknowledged one is missing"
        );
        let stored: BTreeMap<_, _> = messages
            .iter()
            .map(|message| (message.nonce.clone(), message.server_seq))
            .collect();
        assert_eq!(&stored, acknowledged, "{origin}");
    }
}

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_on_a_append_on_b_read_on_c() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let group = Group::new();
    create(&client, &a, &group).await;
    let envelope = group.envelope(group.current(), "hello cluster");
    let appended = append(&client, &b, &envelope).await.unwrap();
    assert_eq!(appended.status, 200);
    assert_eq!(appended.disposition.as_deref(), Some("appended"));
    let messages = read_from(&client, &c, &group.id, &group.current().token, 0).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].server_seq, 1);
    assert_eq!(messages[0].nonce, envelope.nonce);
    // Through the round-robin proxy every replica answers with the same state.
    for _ in 0..6 {
        let through_proxy =
            read_from(&client, &proxy(), &group.id, &group.current().token, 0).await;
        assert_eq!(through_proxy, messages);
    }
    println!("PASS create on A, append on B, read on C and through the proxy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_1_mib_message_appended_on_a_reads_back_byte_exact_on_b_and_c() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let group = Group::new();
    create(&client, &a, &group).await;
    // Over the 64 KiB inline limit, so the ciphertext lives in MinIO, not in FoundationDB.
    let body: String = (0..1024 * 1024)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();
    let envelope = group.envelope(group.current(), &body);
    let appended = append(&client, &a, &envelope).await.unwrap();
    assert_eq!(appended.status, 200);
    assert_eq!(appended.disposition.as_deref(), Some("appended"));
    for origin in [&b, &c] {
        let messages = read_from(&client, origin, &group.id, &group.current().token, 0).await;
        assert_eq!(messages.len(), 1, "{origin}");
        assert!(
            messages[0].ciphertext == envelope.ciphertext,
            "{origin}: 1 MiB ciphertext differs"
        );
    }
    // An exact retry on B is answered from the row.
    let retry = append(&client, &b, &envelope).await.unwrap();
    assert_eq!(retry.disposition.as_deref(), Some("existing"));
    println!("PASS 1 MiB message appended on A, read byte-exact on B and C");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_appends_on_three_relays_get_gap_free_unique_sequence_numbers() {
    let relays = relays();
    let client = http();
    let group = Arc::new(Group::new());
    create(&client, &relays[0], &group).await;
    let mut tasks = Vec::new();
    for (writer, origin) in relays.iter().enumerate() {
        for index in 0..200 {
            let (group, origin, client) = (Arc::clone(&group), origin.clone(), client.clone());
            tasks.push(tokio::spawn(async move {
                let envelope = group.envelope(group.current(), &format!("{writer}/{index}"));
                let answer = append(&client, &origin, &envelope).await.unwrap();
                (envelope.nonce, answer)
            }));
        }
    }
    let mut acknowledged = BTreeMap::new();
    let mut failures = BTreeMap::<u16, usize>::new();
    for task in tasks {
        let (nonce, answer) = task.await.unwrap();
        if answer.status == 200 {
            assert_eq!(answer.disposition.as_deref(), Some("appended"));
            acknowledged.insert(nonce, answer.message.unwrap().server_seq);
        } else {
            *failures.entry(answer.status).or_default() += 1;
        }
    }
    assert!(
        failures.is_empty(),
        "appends refused by status: {failures:?}"
    );
    let sequences: BTreeSet<u64> = acknowledged.values().copied().collect();
    assert_eq!(sequences.len(), 600, "sequence numbers are not unique");
    assert_eq!(sequences, (1..=600).collect::<BTreeSet<u64>>());
    assert_every_acknowledged_append_readable(&group, &acknowledged).await;
    println!("PASS 3 x 200 concurrent appends: sequence numbers 1..=600, unique, gap-free");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_signed_message_sent_to_a_and_b_gives_one_receipt() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let group = Group::new();
    create(&client, &a, &group).await;
    for round in 0..20 {
        let envelope = group.envelope(group.current(), &format!("twice {round}"));
        let (to_a, to_b) = tokio::join!(
            append(&client, &a, &envelope),
            append(&client, &b, &envelope)
        );
        let (to_a, to_b) = (to_a.unwrap(), to_b.unwrap());
        assert_eq!((to_a.status, to_b.status), (200, 200));
        let mut dispositions = [to_a.disposition.unwrap(), to_b.disposition.unwrap()];
        dispositions.sort();
        assert_eq!(dispositions, ["appended", "existing"], "round {round}");
        assert_eq!(to_a.message, to_b.message, "round {round}: two receipts");
    }
    let messages = read_from(&client, &c, &group.id, &group.current().token, 0).await;
    assert_eq!(messages.len(), 20);
    assert_gap_free(&messages, &c);
    println!("PASS one signed message sent to A and B gives one receipt (20 rounds)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_epoch_on_b_is_rejected_after_rotation_on_a() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let mut group = Group::new();
    create(&client, &a, &group).await;
    let old = group.current().clone();
    let before = group.envelope(&old, "before rotation");
    assert_eq!(append(&client, &b, &before).await.unwrap().status, 200);

    let rotated = group.next_epoch().frame.clone();
    assert_eq!(put_epoch(&client, &a, &rotated).await, 200);
    // The old epoch's frame cannot be installed again anywhere.
    assert_eq!(put_epoch(&client, &c, &old.frame).await, 409);

    let stale = group.envelope(&old, "after rotation, old key");
    let refused = append(&client, &b, &stale).await.unwrap();
    assert_eq!(refused.status, 403, "a stale-epoch append must be refused");
    // The exact retry of a message accepted before the rotation keeps its receipt.
    let retry = append(&client, &b, &before).await.unwrap();
    assert_eq!(retry.status, 200);
    assert_eq!(retry.disposition.as_deref(), Some("existing"));
    // The old read token no longer reads on B; the new one does, and sees no stale append.
    let old_read = client
        .get(format!("{b}/groups/{}/messages?after_seq=0", group.id))
        .header("x-group-read-token", &old.token)
        .send()
        .await
        .unwrap();
    assert_eq!(old_read.status(), 403);
    let messages = read_from(&client, &b, &group.id, &group.current().token, 0).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].nonce, before.nonce);
    let current: GroupEpochFrame = serde_json::from_slice(
        &client
            .get(format!("{c}/groups/{}/epochs", group.id))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(current.epoch, 1);
    let fresh = group.envelope(group.current(), "new epoch");
    assert_eq!(append(&client, &b, &fresh).await.unwrap().status, 200);
    println!("PASS a stale epoch on B is rejected after rotation on A");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_subscriber_on_a_wakes_for_appends_on_b() {
    let [a, b, _]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let group = Group::new();
    create(&client, &a, &group).await;
    let mut socket = subscribe(&a, &group).await;
    assert!(
        wakes_for_append_elsewhere(&mut socket, &client, &b, &group).await,
        "no wakeup on A within 3 s of a commit on B, before A's own 5 s tick"
    );
    println!("PASS a subscriber on A wakes for an append on B over NATS");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn readers_catch_up_with_nothing_lost_after_nats_is_killed() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let group = Group::new();
    create(&client, &a, &group).await;
    let mut socket = subscribe(&a, &group).await;
    assert!(next_wakeup(&mut socket, Duration::from_secs(8))
        .await
        .is_some());
    let cursor = read_from(&client, &c, &group.id, &group.current().token, 0).await;
    assert!(cursor.is_empty());

    container_action("nats", "kill");
    // A wakeup buffered before the kill must not pass the check below: drain the socket.
    while next_wakeup(&mut socket, Duration::from_millis(200))
        .await
        .is_some()
    {}
    let mut nonces = Vec::new();
    for index in 0..20 {
        let envelope = group.envelope(group.current(), &format!("while NATS is down {index}"));
        let answer = append(&client, &b, &envelope).await.unwrap();
        assert_eq!(answer.status, 200, "appends do not depend on the bus");
        nonces.push(envelope.nonce);
    }

    // While NATS is still down, the existing subscriber on A is still woken (by A's own
    // recovery tick), and readers recover from their cursors, not from the bus.
    assert!(
        next_wakeup(&mut socket, Duration::from_secs(8))
            .await
            .is_some(),
        "the subscriber on A was not woken while NATS was down"
    );
    let caught_up = read_from(&client, &c, &group.id, &group.current().token, 0).await;
    assert_gap_free(&caught_up, &c);
    assert_eq!(
        caught_up
            .iter()
            .map(|m| m.nonce.clone())
            .collect::<Vec<_>>(),
        nonces
    );
    let tail = read_from(&client, &a, &group.id, &group.current().token, 10).await;
    assert_eq!(tail.len(), 10);
    assert_eq!(tail[0].server_seq, 11);

    // Once NATS is back the relays reconnect and wakeups cross replicas again, on the socket
    // that was open throughout and on a new one.
    container_action("nats", "start");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !wakes_for_append_elsewhere(&mut socket, &client, &b, &group).await {
        assert!(
            Instant::now() < deadline,
            "wakeups never crossed replicas again on the socket open throughout"
        );
    }
    let mut fresh = subscribe(&a, &group).await;
    assert!(
        wakes_for_append_elsewhere(&mut fresh, &client, &b, &group).await,
        "a new subscriber on A was not woken by B after NATS came back"
    );
    println!("PASS with NATS killed, 20 appends were acknowledged and every reader caught up");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn every_acknowledged_append_survives_a_foundationdb_restart_mid_load() {
    let client = http();
    let group = Arc::new(Group::new());
    create(&client, &relays()[0], &group).await;
    let restarted_before = started_at("fdb");
    let outcome = load_with_fault(&group, 150, 60, || async {
        container_action("fdb", "restart?t=0");
    })
    .await;
    assert_ne!(
        started_at("fdb"),
        restarted_before,
        "FoundationDB was not restarted"
    );
    assert!(
        outcome.fault_was_felt(),
        "the writers never felt the FoundationDB restart: no attempt overlapping it failed \
         or took {FELT_LATENCY:?} (slowest {:?}, baseline {:?})",
        outcome.slowest_in_fault,
        outcome.slowest_baseline
    );
    assert_every_acknowledged_append_readable(&group, &outcome.acknowledged).await;
    println!("PASS FoundationDB restarted mid-load: every acknowledged append is readable");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn every_acknowledged_append_survives_a_relay_killed_mid_load() {
    let client = http();
    let group = Arc::new(Group::new());
    create(&client, &relays()[0], &group).await;
    let restarted_before = started_at("relay-b");
    let outcome = load_with_fault(&group, 150, 60, || async {
        container_action("relay-b", "kill");
        tokio::time::sleep(Duration::from_secs(3)).await;
        container_action("relay-b", "start");
    })
    .await;
    assert_ne!(
        started_at("relay-b"),
        restarted_before,
        "relay-b was not restarted"
    );
    assert!(
        outcome.failed_in_fault > 0,
        "no append failed while relay-b was down"
    );
    assert_every_acknowledged_append_readable(&group, &outcome.acknowledged).await;
    println!("PASS relay-b killed mid-load: every acknowledged append is readable");
}
