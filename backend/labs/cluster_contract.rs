//! HTTP contract of the compose cluster lab (`backend/labs/compose.cluster.yml`): three real
//! relays on one FoundationDB, Core NATS between them. Built in the lab image as an
//! integration test of `cashweb-registry` and run by the `cluster-contract` profile.
//!
//! The fault cases stop and start this Compose project's own containers through the Docker
//! socket (found by the project label of the container running the test), so the tests run
//! one at a time (`--test-threads=1`). Every test uses a fresh group, so reruns against the
//! same volumes do not interfere.
//!
//! Every append pays the relay that takes it, with a real transaction on solonet
//! (`monad-regtest`, see `solonet_payer.rs`): each test funds fresh payers from the faucet
//! first, and a retried append resends the same envelope with the same payment bytes.
//! `FRANK_LAB_SOLONET_RPC_URL` must name solonet's JSON-RPC as the containers reach it.
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

#[path = "../../../labs/solonet_payer.rs"]
mod solonet_payer;
use solonet_payer::{
    commitment_calldata, paid_body, write_policy, Funded, Payer, Solonet, WritePolicy,
};

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

/// The relays' public origin and directory endpoint, as lab-init renders it.
fn lab_relay_endpoint() -> String {
    std::env::var("FRANK_LAB_PUBLIC_ORIGIN").expect("FRANK_LAB_PUBLIC_ORIGIN")
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

    /// The creator's write price record `version` at `price_wei`, signed with the root key.
    fn price(&self, version: u64, price_wei: u128) -> serde_json::Value {
        let digest = cashweb_registry::group_write_payment::group_write_price_digest(
            solonet_payer::SOLONET_NETWORK,
            &derive_group_id(&self.root_pub),
            version,
            price_wei,
        );
        serde_json::json!({
            "group_id": self.id,
            "network": solonet_payer::SOLONET_NETWORK,
            "version": version,
            "price_wei": price_wei.to_string(),
            "admin_sig": sign(&self.root, &digest),
        })
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

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/// One write as a client sends it, and resends unchanged: the envelope and its payment.
#[derive(Clone)]
struct Write {
    envelope: GroupMessageEnvelope,
    payment: serde_json::Value,
    tx_hash: [u8; 32],
}

/// Funded payers for one test and the relays' write policy. All three replicas share one
/// public origin (the proxy's), so one policy holds for every one of them. Dropped at the end
/// of the test, passed or failed, it sweeps the payers' leftovers back to the faucet.
struct Payments {
    policy: WritePolicy,
    payers: Funded,
}

impl Payments {
    /// `count` payers funded on solonet, and the policy read from relay A.
    async fn fund(count: usize) -> Arc<Self> {
        let solonet = Solonet::from_env().await;
        let origin = relays()[0].clone();
        wait_ready(&origin).await;
        let policy = write_policy(&http(), &origin, &"00".repeat(32)).await;
        assert_eq!(policy.network, solonet_payer::SOLONET_NETWORK);
        // lab-init renders the proxy's published origin into every replica's `url`.
        assert!(
            policy.host_origin.starts_with("http://127.0.0.1:"),
            "{policy:?}"
        );
        let payers = solonet.fund(count).await;
        Arc::new(Payments { policy, payers })
    }

    fn solonet(&self) -> &Solonet {
        self.payers.solonet()
    }

    fn payer(&self) -> &Payer {
        self.payers.take()
    }

    /// `envelope`, paid as the policy asks by a payer used for nothing else.
    fn pay(&self, envelope: GroupMessageEnvelope) -> Write {
        self.pay_by(self.payer(), envelope)
    }

    /// `envelope`, paid as the policy asks by `payer` at its nonce 0.
    fn pay_by(&self, payer: &Payer, envelope: GroupMessageEnvelope) -> Write {
        self.pay_under(&self.policy, payer, envelope)
    }

    /// `envelope`, paid as `policy` (a group's own) asks by `payer` at its nonce 0.
    fn pay_under(
        &self,
        policy: &WritePolicy,
        payer: &Payer,
        envelope: GroupMessageEnvelope,
    ) -> Write {
        let (payment, tx_hash) = self.solonet().payment(payer, policy, &envelope);
        Write {
            envelope,
            payment,
            tx_hash,
        }
    }
}

/// Send a creator's write price record to `origin`: the status and the JSON body.
async fn put_price(
    client: &reqwest::Client,
    origin: &str,
    group: &Group,
    record: &serde_json::Value,
) -> (u16, serde_json::Value) {
    let response = client
        .put(format!("{origin}/groups/{}/write-price", group.id))
        .header("content-type", "application/json")
        .body(serde_json::to_vec(record).unwrap())
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap_or_default();
    (status, body)
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
    /// The JSON error body of a refusal.
    error: Option<serde_json::Value>,
    /// The `Retry-After` of the answer in seconds (1 when absent, at most 10).
    retry_after: u64,
}

/// The 503 codes a relay answers before it stores anything when it cannot check a payment yet:
/// the node does not show the payment can land (`group_payment_not_ready`) or cannot be read
/// (`group_payment_check_unavailable`). Not refusals: the protocol has the writer resend the
/// same write (docs/protocol/groups/shared-mailbox-baseline.md), and so does this contract.
const PAYMENT_NOT_CHECKED_YET: [&str; 2] =
    ["group_payment_not_ready", "group_payment_check_unavailable"];
/// How long one write is resent while its relay cannot check the payment yet.
const PAYMENT_CHECK_PATIENCE: Duration = Duration::from_secs(120);

/// `write` sent to `origin` as a client sends it: while the relay answers that it cannot check
/// the payment yet, the same write (same envelope, same signed payment) is sent again after the
/// relay's `Retry-After`. Any other answer, or a transport error, is returned as it is.
async fn append(
    client: &reqwest::Client,
    origin: &str,
    write: &Write,
) -> Result<Appended, reqwest::Error> {
    let started = Instant::now();
    loop {
        let answer = append_once(client, origin, write).await?;
        let code = answer
            .error
            .as_ref()
            .and_then(|error| error["error"].as_str())
            .unwrap_or_default();
        if answer.status != 503
            || !PAYMENT_NOT_CHECKED_YET.contains(&code)
            || started.elapsed() >= PAYMENT_CHECK_PATIENCE
        {
            return Ok(answer);
        }
        println!(
            "{origin}: 503 {code} ({}) for {}; the same write again in {} s",
            answer.error.as_ref().unwrap()["reason"],
            write.envelope.nonce,
            answer.retry_after
        );
        tokio::time::sleep(Duration::from_secs(answer.retry_after)).await;
    }
}

/// `write` sent to `origin` once.
async fn append_once(
    client: &reqwest::Client,
    origin: &str,
    write: &Write,
) -> Result<Appended, reqwest::Error> {
    let response = client
        .put(format!(
            "{origin}/groups/{}/messages",
            write.envelope.group_id
        ))
        .header("content-type", "application/json")
        .body(paid_body(&write.envelope, &write.payment))
        .send()
        .await?;
    let status = response.status().as_u16();
    let disposition = response
        .headers()
        .get("x-group-append-disposition")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(1u64)
        .min(10);
    let bytes = response.bytes().await?;
    let message = (status == 200).then(|| serde_json::from_slice(&bytes).unwrap());
    let error =
        (status != 200).then(|| serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null));
    Ok(Appended {
        status,
        disposition,
        message,
        error,
        retry_after,
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
    payments: &Payments,
) -> bool {
    if next_wakeup(socket, Duration::from_secs(8)).await.is_none() {
        return false;
    }
    let write = payments.pay(group.envelope(group.current(), "wake"));
    let appended = append(client, writer, &write).await.unwrap();
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

/// How long FoundationDB is held down mid-load: long enough that every writer must cross it.
const FDB_OUTAGE: Duration = Duration::from_secs(3);
/// Attempts at least this long that overlap the fault window show the writers felt it. An
/// attempt in flight when FoundationDB stops cannot commit until it is back, at least
/// [`FDB_OUTAGE`] later, so one that neither failed nor took this long did not cross it.
const FELT_LATENCY: Duration = Duration::from_secs(2);
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

/// Three writers, one per relay, each appending `per_writer` distinct paid envelopes. A failed
/// or unanswered append is retried, with the same envelope and payment, on the next relay until one
/// acknowledges it, as a client would. After `fault_after` acknowledgements `fault` runs once.
/// The fault window runs from the start of `fault` until it returns or, with
/// `until_next_ack`, until the first append acknowledged after it returns (the store is back
/// only when a write commits again). Fails, rather than hangs, if the load does not finish
/// within [`LOAD_DEADLINE`].
async fn load_with_fault<F, Fut>(
    group: &Arc<Group>,
    payments: &Arc<Payments>,
    per_writer: usize,
    fault_after: usize,
    until_next_ack: bool,
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
        let (group, payments, relays, acked, retries) = (
            Arc::clone(group),
            Arc::clone(payments),
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
                let write = payments
                    .pay(group.envelope(group.current(), &format!("load {writer}/{index}")));
                let envelope = &write.envelope;
                let mut target = writer;
                loop {
                    assert!(Instant::now() < deadline, "writer {writer} never finished");
                    let attempt = Instant::now();
                    let answer = append_once(&client, &relays[target % 3], &write).await;
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
    if until_next_ack {
        let after = acked.load(Ordering::SeqCst);
        while acked.load(Ordering::SeqCst) == after {
            assert!(
                started.elapsed() < LOAD_DEADLINE,
                "no append was acknowledged after the fault before the deadline"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
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
    let payments = Payments::fund(1).await;
    let group = Group::new();
    create(&client, &a, &group).await;
    let write = payments.pay(group.envelope(group.current(), "hello cluster"));
    let envelope = &write.envelope;
    let appended = append(&client, &b, &write).await.unwrap();
    assert_eq!(appended.status, 200, "{:?}", appended.error);
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
    let payments = Payments::fund(1).await;
    let group = Group::new();
    create(&client, &a, &group).await;
    // Over the 64 KiB inline limit, so the ciphertext lives in MinIO, not in FoundationDB.
    let body: String = (0..1024 * 1024)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();
    let write = payments.pay(group.envelope(group.current(), &body));
    let envelope = &write.envelope;
    let appended = append(&client, &a, &write).await.unwrap();
    assert_eq!(appended.status, 200, "{:?}", appended.error);
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
    let retry = append(&client, &b, &write).await.unwrap();
    assert_eq!(retry.disposition.as_deref(), Some("existing"));
    println!("PASS 1 MiB paid message appended on A, read byte-exact on B and C");
}

/// Appends in flight at once in the concurrent case: 20 per relay.
const IN_FLIGHT: usize = 60;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_appends_on_three_relays_get_gap_free_unique_sequence_numbers() {
    let relays = relays();
    let client = http();
    let payments = Payments::fund(600).await;
    let group = Arc::new(Group::new());
    create(&client, &relays[0], &group).await;
    // Every append makes its relay ask solonet about the payment, and the lab reaches solonet
    // through the Colima port forward, which a burst of 600 connections broke. So at most
    // IN_FLIGHT appends run at once, spread over the three relays.
    let in_flight = Arc::new(tokio::sync::Semaphore::new(IN_FLIGHT));
    let mut tasks = Vec::new();
    for index in 0..200 {
        for (writer, origin) in relays.iter().enumerate() {
            let write = payments.pay(group.envelope(group.current(), &format!("{writer}/{index}")));
            let (origin, client, in_flight) = (origin.clone(), client.clone(), in_flight.clone());
            tasks.push(tokio::spawn(async move {
                let _slot = in_flight.acquire_owned().await.unwrap();
                let answer = append(&client, &origin, &write).await.unwrap();
                (write.envelope.nonce, answer)
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
            println!("refused: {} {:?}", answer.status, answer.error);
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
    println!(
        "PASS 3 x 200 paid appends, {IN_FLIGHT} in flight: sequence numbers 1..=600, unique, \
         gap-free"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_signed_message_sent_to_a_and_b_gives_one_receipt() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let payments = Payments::fund(20).await;
    let group = Group::new();
    create(&client, &a, &group).await;
    for round in 0..20 {
        let write = payments.pay(group.envelope(group.current(), &format!("twice {round}")));
        let (to_a, to_b) = tokio::join!(append(&client, &a, &write), append(&client, &b, &write));
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
    println!("PASS one paid message sent to A and B gives one receipt (20 rounds)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_replica_checks_the_payment_and_a_refusal_consumes_nothing() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let payments = Payments::fund(4).await;
    let group = Group::new();
    create(&client, &a, &group).await;

    // The creator prices the group at three times the relays' minimum, on B; C reports it.
    let minimum = payments.policy.min_price_wei;
    assert_eq!(payments.policy.price_version, 0);
    let (status, body) = put_price(&client, &b, &group, &group.price(1, minimum * 3)).await;
    assert_eq!(status, 200, "{body}");
    let policy = write_policy(&client, &c, &group.id).await;
    assert_eq!((policy.price_wei, policy.price_version), (minimum * 3, 1));
    // Below the minimum, or signed by another key: refused at change time, on any replica.
    let (status, body) = put_price(&client, &c, &group, &group.price(2, minimum - 1)).await;
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["error"], "write_price_below_minimum");
    let mut forged = group.price(2, minimum);
    forged["admin_sig"] = serde_json::Value::String(sign(&key().0, &[7; 32]));
    assert_eq!(put_price(&client, &a, &group, &forged).await.0, 403);
    assert_eq!(
        write_policy(&client, &a, &group.id).await.price_wei,
        minimum * 3
    );

    // A paid append on B at the group's price is accepted, and B hands the payment to solonet
    // after the commit.
    let first = payments.pay_under(
        &policy,
        payments.payer(),
        group.envelope(group.current(), "paid"),
    );
    let accepted = append(&client, &b, &first).await.unwrap();
    assert_eq!(accepted.status, 200, "{:?}", accepted.error);
    assert_eq!(accepted.disposition.as_deref(), Some("appended"));
    payments.solonet().wait_landed(&first.tx_hash).await;
    // Its payment does not fund another write on C (it commits to the first one).
    let replay = Write {
        envelope: group.envelope(group.current(), "replayed payment"),
        ..first.clone()
    };
    let refused = append(&client, &c, &replay).await.unwrap();
    assert_eq!(refused.status, 402);
    assert_eq!(
        refused.error.as_ref().unwrap()["reason"],
        "wrong_commitment"
    );

    // One payer's wrong payments, each refused by the replica that takes it. Refusals consume
    // nothing: the same payer's correct payment is accepted afterwards. Underpaid is below the
    // group's price, though above the relays' minimum.
    let payer = payments.payer();
    let envelope = group.envelope(group.current(), "checked");
    let calldata = commitment_calldata(&policy.network, &policy.host_origin, &envelope);
    let elsewhere = commitment_calldata(&policy.network, "https://other.example", &envelope);
    let chain = solonet_payer::SOLONET_CHAIN_ID;
    let price = policy.price_wei;
    let cases = [
        (
            "wrong_payee",
            policy.network.as_str(),
            chain,
            [0xaa; 20],
            price,
            &calldata,
        ),
        (
            "wrong_chain",
            policy.network.as_str(),
            10143,
            policy.payee,
            price,
            &calldata,
        ),
        (
            "wrong_network",
            "monad-testnet",
            chain,
            policy.payee,
            price,
            &calldata,
        ),
        (
            "underpaid",
            policy.network.as_str(),
            chain,
            policy.payee,
            price - 1,
            &calldata,
        ),
        (
            "wrong_commitment",
            policy.network.as_str(),
            chain,
            policy.payee,
            price,
            &elsewhere,
        ),
    ];
    for (index, (reason, network, chain_id, to, value, data)) in cases.into_iter().enumerate() {
        let (payment, tx_hash) = payments
            .solonet()
            .payment_tx(&payer, network, chain_id, to, value, data);
        let write = Write {
            envelope: envelope.clone(),
            payment,
            tx_hash,
        };
        let origin = [&a, &b, &c][index % 3];
        let refused = append(&client, origin, &write).await.unwrap();
        assert_eq!(
            refused.status, 402,
            "{reason} on {origin}: {:?}",
            refused.error
        );
        let error = refused.error.unwrap();
        assert_eq!(error["error"], "group_payment_invalid", "{error}");
        assert_eq!(error["reason"], reason, "{error}");
    }
    assert!(price - 1 > minimum);
    let checked = payments.pay_under(&policy, payer, envelope);
    let accepted = append(&client, &a, &checked).await.unwrap();
    assert_eq!(accepted.status, 200, "{:?}", accepted.error);
    assert_eq!(
        accepted.message.unwrap().server_seq,
        2,
        "a refusal consumed a sequence"
    );

    // Two payments at one payer nonce for two writes, sent to A and C at once: one funds a
    // write, the other is refused, whichever replica each reaches.
    let payer = payments.payer();
    let one = payments.pay_under(
        &policy,
        payer,
        group.envelope(group.current(), "nonce 0, one"),
    );
    let two = payments.pay_under(
        &policy,
        payer,
        group.envelope(group.current(), "nonce 0, two"),
    );
    let (to_a, to_c) = tokio::join!(append(&client, &a, &one), append(&client, &c, &two));
    let mut statuses = [to_a.unwrap(), to_c.unwrap()];
    statuses.sort_by_key(|answer| answer.status);
    assert_eq!(
        [statuses[0].status, statuses[1].status],
        [200, 402],
        "{:?} {:?}",
        statuses[0].error,
        statuses[1].error
    );
    assert_eq!(statuses[0].message.as_ref().unwrap().server_seq, 3);
    // The loser is `nonce_used`, or `stale_nonce` when the winner's payment was mined before
    // the loser's funding check read the payer's nonce. Either way it consumed no sequence:
    // the log below holds exactly 3 writes.
    let refusal = statuses[1].error.as_ref().unwrap();
    assert!(
        matches!(
            (refusal["error"].as_str(), refusal["reason"].as_str()),
            (Some("group_payment_invalid"), Some("nonce_used"))
                | (Some("group_payment_unfunded"), Some("stale_nonce"))
        ),
        "{refusal}"
    );

    // The creator raises the price on C. A write signed and paid at the old price, sent
    // after the change, is refused on A before anything is stored or broadcast; the same payer
    // pays the new price at the same nonce and is accepted at the next sequence.
    let (status, body) = put_price(&client, &c, &group, &group.price(2, minimum * 5)).await;
    assert_eq!(status, 200, "{body}");
    let raised = write_policy(&client, &b, &group.id).await;
    assert_eq!((raised.price_wei, raised.price_version), (minimum * 5, 2));
    let payer = payments.payer();
    let envelope = group.envelope(group.current(), "signed before the raise");
    let stale = payments.pay_under(&policy, payer, envelope.clone());
    let refused = append(&client, &a, &stale).await.unwrap();
    assert_eq!(refused.status, 402, "{:?}", refused.error);
    assert_eq!(refused.error.as_ref().unwrap()["reason"], "underpaid");
    let repaid = payments.pay_under(&raised, payer, envelope);
    let accepted = append(&client, &a, &repaid).await.unwrap();
    assert_eq!(accepted.status, 200, "{:?}", accepted.error);
    assert_eq!(accepted.message.unwrap().server_seq, 4);
    payments.solonet().wait_landed(&repaid.tx_hash).await;

    let messages = read_from(&client, &b, &group.id, &group.current().token, 0).await;
    assert_gap_free(&messages, &b);
    assert_eq!(messages.len(), 4);
    println!(
        "PASS a write paid at the creator's price landed on solonet; replayed, wrong-payee, \
         wrong-chain, wrong-network, underpaid (below the group's price) and other-relay \
         payments were refused on every replica without consuming a sequence; two payments at \
         one nonce gave one append; a price below the minimum or by another key was refused; \
         after a raise, a write paid at the old price was refused and repaid at the new one"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_epoch_on_b_is_rejected_after_rotation_on_a() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let payments = Payments::fund(3).await;
    let mut group = Group::new();
    create(&client, &a, &group).await;
    let old = group.current().clone();
    let before = payments.pay(group.envelope(&old, "before rotation"));
    assert_eq!(append(&client, &b, &before).await.unwrap().status, 200);

    let rotated = group.next_epoch().frame.clone();
    assert_eq!(put_epoch(&client, &a, &rotated).await, 200);
    // The old epoch's frame cannot be installed again anywhere.
    assert_eq!(put_epoch(&client, &c, &old.frame).await, 409);

    let stale = payments.pay(group.envelope(&old, "after rotation, old key"));
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
    assert_eq!(messages[0].nonce, before.envelope.nonce);
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
    let fresh = payments.pay(group.envelope(group.current(), "new epoch"));
    assert_eq!(append(&client, &b, &fresh).await.unwrap().status, 200);
    println!("PASS a stale epoch on B is rejected after rotation on A");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_subscriber_on_a_wakes_for_appends_on_b() {
    let [a, b, _]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    let payments = Payments::fund(1).await;
    let group = Group::new();
    create(&client, &a, &group).await;
    let mut socket = subscribe(&a, &group).await;
    assert!(
        wakes_for_append_elsewhere(&mut socket, &client, &b, &group, &payments).await,
        "no wakeup on A within 3 s of a commit on B, before A's own 5 s tick"
    );
    println!("PASS a subscriber on A wakes for an append on B over NATS");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn readers_catch_up_with_nothing_lost_after_nats_is_killed() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    let client = http();
    // 20 appends while NATS is down, and the wake checks after it is back (one append each).
    let payments = Payments::fund(40).await;
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
        let write =
            payments.pay(group.envelope(group.current(), &format!("while NATS is down {index}")));
        let answer = append(&client, &b, &write).await.unwrap();
        assert_eq!(answer.status, 200, "appends do not depend on the bus");
        nonces.push(write.envelope.nonce);
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
    while !wakes_for_append_elsewhere(&mut socket, &client, &b, &group, &payments).await {
        assert!(
            Instant::now() < deadline,
            "wakeups never crossed replicas again on the socket open throughout"
        );
    }
    let mut fresh = subscribe(&a, &group).await;
    assert!(
        wakes_for_append_elsewhere(&mut fresh, &client, &b, &group, &payments).await,
        "a new subscriber on A was not woken by B after NATS came back"
    );
    println!("PASS with NATS killed, 20 appends were acknowledged and every reader caught up");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn every_acknowledged_append_survives_a_foundationdb_restart_mid_load() {
    let client = http();
    let payments = Payments::fund(450).await;
    let group = Arc::new(Group::new());
    create(&client, &relays()[0], &group).await;
    let restarted_before = started_at("fdb");
    // Stopped, held down while the load runs, and started again: the writers must cross a
    // real outage, which lasts until the first append commits after the start.
    let outcome = load_with_fault(&group, &payments, 150, 60, true, || async {
        container_action("fdb", "stop?t=0");
        tokio::time::sleep(FDB_OUTAGE).await;
        container_action("fdb", "start");
    })
    .await;
    assert_ne!(
        started_at("fdb"),
        restarted_before,
        "FoundationDB was not restarted"
    );
    assert!(
        outcome.fault_was_felt(),
        "the writers never felt FoundationDB held down for {FDB_OUTAGE:?}: no attempt \
         overlapping the outage failed or took {FELT_LATENCY:?} (slowest {:?}, baseline {:?})",
        outcome.slowest_in_fault,
        outcome.slowest_baseline
    );
    assert_every_acknowledged_append_readable(&group, &outcome.acknowledged).await;
    println!(
        "PASS FoundationDB held down {FDB_OUTAGE:?} mid-load: every acknowledged append is readable"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn every_acknowledged_append_survives_a_relay_killed_mid_load() {
    let client = http();
    let payments = Payments::fund(450).await;
    let group = Arc::new(Group::new());
    create(&client, &relays()[0], &group).await;
    let restarted_before = started_at("relay-b");
    let outcome = load_with_fault(&group, &payments, 150, 60, false, || async {
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

// ---------------------------------------------------------------------------------------------
// Directory (HA step 8): one directory store on FoundationDB, large evidence in MinIO
// ---------------------------------------------------------------------------------------------

/// The lab relay tuple, as in `cluster/relay.toml`'s `[registry.directory]`. Its endpoint is
/// the relays' public origin (`lab_relay_endpoint`), which group-write payments commit to too.
const LAB_RELAY_ID: &str = "000102030405060708090a0b0c0d0e0f";
const LAB_RELAY_IDENTITY: &str =
    "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13";
const LAB_BINDING_EXPIRY_S: i64 = 1_830_297_600;
/// The relays' `[registry] network`: the directory serves only that network.
const DIRECTORY_NETWORK: &str = "monad-regtest";
const DIRECTORY_MEDIA: &str = "application/vnd.frank.cbor";

/// One account's key and the entries it signs.
struct Account {
    secret: SecretKey,
    point: [u8; 33],
}

/// One signed entry: the exact attestation bytes and its statement hash (T1).
#[derive(Clone)]
struct Signed {
    attestation: Vec<u8>,
    hash: [u8; 32],
}

fn cbor_timestamp(seconds: i64, nanoseconds: u32) -> frank_cbor::CborValue {
    frank_cbor::cbor_map(vec![
        (0, frank_cbor::CborValue::Int(seconds.into())),
        (1, frank_cbor::CborValue::Int(nanoseconds.into())),
    ])
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

impl Account {
    fn new() -> Self {
        let (secret, point) = key();
        Self { secret, point }
    }
    fn subject(&self) -> String {
        hex::encode(self.point)
    }
    /// The reviewed bootstrap statement, made this account's: the lab network, its key as
    /// subject, the lab relay tuple, a current validity window, then signed by this key. `nanos` varies the
    /// timestamp so two entries of one revision differ.
    fn sign(&self, revision: u64, predecessor: Option<[u8; 32]>, nanos: u32) -> Signed {
        use frank_cbor::{cbor_map, decode_canonical, encode_frame, CborValue};
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
        ))
        .unwrap();
        let bootstrap = vectors["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["id"] == "bootstrap")
            .unwrap();
        let original = hex::decode(bootstrap["type4_hex"].as_str().unwrap()).unwrap();
        let CborValue::Map(envelope) = decode_canonical(&original[9..]).unwrap() else {
            panic!("envelope")
        };
        let Some((_, CborValue::Bytes(body))) = envelope.iter().find(|(key, _)| *key == 3) else {
            panic!("body")
        };
        let CborValue::Map(mut fields) = decode_canonical(body).unwrap() else {
            panic!("payload")
        };
        let subject = cbor_map(vec![
            (0, CborValue::Int(1)),
            (1, CborValue::Bytes(self.point.to_vec())),
        ]);
        let relay = cbor_map(vec![
            (0, CborValue::Bytes(hex::decode(LAB_RELAY_ID).unwrap())),
            (1, CborValue::Text(lab_relay_endpoint())),
            (
                2,
                cbor_map(vec![
                    (0, CborValue::Int(1)),
                    (
                        1,
                        CborValue::Bytes(hex::decode(LAB_RELAY_IDENTITY).unwrap()),
                    ),
                ]),
            ),
            (3, cbor_timestamp(LAB_BINDING_EXPIRY_S, 0)),
        ]);
        // Issued a little in the past so a replica's clock slightly behind still accepts it.
        let issued = unix_now() - 120 + revision as i64;
        for (key, value) in &mut fields {
            match *key {
                // The vector's network is monad-testnet; the lab relays serve monad-regtest.
                0 => *value = CborValue::Text(DIRECTORY_NETWORK.into()),
                1 => *value = subject.clone(),
                2 => *value = CborValue::Int(revision.into()),
                3 => *value = cbor_timestamp(issued, nanos),
                4 => *value = CborValue::Array(vec![relay.clone()]),
                6 => *value = cbor_timestamp(issued + 7 * 24 * 3600, 0),
                13 => {
                    if let Some(predecessor) = predecessor {
                        *value = CborValue::Bytes(predecessor.to_vec());
                    }
                }
                _ => {}
            }
        }
        let statement = encode_frame(
            frank_cbor::EnvelopeFields {
                type_id: frank_cbor::message_types::TYPE_DIRECTORY_STATEMENT,
                schema_version: 4,
                min_reader_version: 4,
            },
            frank_cbor::FramePayload::Value(&CborValue::Map(fields)),
        )
        .unwrap();
        let hash: [u8; 32] = Sha256::digest(
            frank_cbor::common_transcript(
                "frank/content-hash/v1",
                DIRECTORY_NETWORK,
                &statement,
                &[],
            )
            .unwrap(),
        )
        .into();
        let digest = frank_cbor::directory_signature_digest(DIRECTORY_NETWORK, &statement).unwrap();
        let signature = Secp256k1::new()
            .sign(&Message::from_slice(&digest).unwrap(), &self.secret)
            .serialize_der()
            .to_vec();
        let wrapper = cbor_map(vec![
            (0, CborValue::Bytes(statement)),
            (
                1,
                CborValue::Array(vec![cbor_map(vec![
                    (0, CborValue::Int(1)),
                    (1, subject),
                    (2, CborValue::Bytes(signature)),
                ])]),
            ),
        ]);
        let attestation = encode_frame(
            frank_cbor::EnvelopeFields {
                type_id: frank_cbor::message_types::TYPE_DIRECTORY_ATTESTATION,
                schema_version: 1,
                min_reader_version: 1,
            },
            frank_cbor::FramePayload::Value(&wrapper),
        )
        .unwrap();
        Signed { attestation, hash }
    }
}

fn head_url(origin: &str, subject: &str) -> String {
    format!("{origin}/directory/v1/{DIRECTORY_NETWORK}/{subject}/head")
}

async fn publish(client: &reqwest::Client, origin: &str, subject: &str, entry: &Signed) -> u16 {
    match client
        .put(head_url(origin, subject))
        .header("content-type", DIRECTORY_MEDIA)
        .body(entry.attestation.clone())
        .send()
        .await
    {
        Ok(response) => response.status().as_u16(),
        Err(_) => 0,
    }
}

async fn resolve(client: &reqwest::Client, url: &str) -> (u16, Vec<u8>) {
    let response = client.get(url).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.bytes().await.unwrap().to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn directory_an_entry_published_on_a_resolves_on_b_and_c() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let account = Account::new();
    let first = account.sign(0, None, 0);
    assert_eq!(publish(&client, &a, &account.subject(), &first).await, 200);
    // The account's EVM address: Keccak-256 of the uncompressed point, last 20 bytes.
    let uncompressed = PublicKey::from_slice(&account.point)
        .unwrap()
        .serialize_uncompressed();
    let digest = <sha3::Keccak256 as sha3::Digest>::digest(&uncompressed[1..]);
    let address = format!("0x{}", hex::encode(&digest[12..]));
    for origin in [&b, &c, &proxy()] {
        let by_key = resolve(&client, &head_url(origin, &account.subject())).await;
        assert_eq!(by_key, (200, first.attestation.clone()), "{origin} by key");
        let by_address = resolve(
            &client,
            &format!("{origin}/directory/v1/{DIRECTORY_NETWORK}/address/{address}"),
        )
        .await;
        assert_eq!(
            by_address,
            (200, first.attestation.clone()),
            "{origin} by address"
        );
    }
    // A renewal accepted on C is what A and B serve next.
    let renewal = account.sign(1, Some(first.hash), 0);
    assert_eq!(
        publish(&client, &c, &account.subject(), &renewal).await,
        200
    );
    for origin in [&a, &b] {
        assert_eq!(
            resolve(&client, &head_url(origin, &account.subject())).await,
            (200, renewal.attestation.clone()),
            "{origin}"
        );
    }
    println!("PASS directory: published on A, resolved on B, C and the proxy; renewed on C");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn directory_conflicting_revisions_to_a_and_b_accept_exactly_one_and_never_fork() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let mut first_wins = [0usize; 2];
    for round in 0..20 {
        let account = Account::new();
        let subject = account.subject();
        let first = account.sign(0, None, 0);
        assert_eq!(publish(&client, &a, &subject, &first).await, 200);
        // Two devices renew the same revision at once, one through A and one through B.
        let left = account.sign(1, Some(first.hash), 1);
        let right = account.sign(1, Some(first.hash), 2);
        let (on_a, on_b) = tokio::join!(
            publish(&client, &a, &subject, &left),
            publish(&client, &b, &subject, &right)
        );
        let statuses = [on_a, on_b];
        assert_eq!(
            statuses.iter().filter(|status| **status == 200).count(),
            1,
            "round {round}: {statuses:?}"
        );
        assert_eq!(
            statuses.iter().filter(|status| **status == 409).count(),
            1,
            "round {round}: {statuses:?}"
        );
        let winner = if on_a == 200 { &left } else { &right };
        first_wins[usize::from(on_a != 200)] += 1;
        // Every replica serves the winner, and the subject is not quarantined: the account
        // keeps working (a forked subject answers 409).
        for origin in [&a, &b, &c] {
            assert_eq!(
                resolve(&client, &head_url(origin, &subject)).await,
                (200, winner.attestation.clone()),
                "round {round}: {origin}"
            );
        }
        // The account adopts the winner and renews again, on C.
        let next = account.sign(2, Some(winner.hash), 0);
        assert_eq!(
            publish(&client, &c, &subject, &next).await,
            200,
            "round {round}"
        );
        // The same first entry raced to two replicas enrolls once and both succeed.
        let twin = Account::new();
        let entry = twin.sign(0, None, 0);
        let twin_subject = twin.subject();
        let (on_a, on_b) = tokio::join!(
            publish(&client, &a, &twin_subject, &entry),
            publish(&client, &b, &twin_subject, &entry)
        );
        assert_eq!((on_a, on_b), (200, 200), "round {round}: same first entry");
    }
    println!(
        "PASS directory: 20 rounds of conflicting renewals to A and B, one accepted each \
         (A won {}, B won {}), no fork; identical first entries enrolled once",
        first_wins[0], first_wins[1]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn directory_every_acknowledged_publication_survives_relay_a_killed_mid_load() {
    let origins = Arc::new(relays());
    for origin in origins.iter() {
        wait_ready(origin).await;
    }
    let acked = Arc::new(AtomicUsize::new(0));
    let mut writers = Vec::new();
    for writer in 0..3usize {
        let (origins, acked) = (Arc::clone(&origins), Arc::clone(&acked));
        writers.push(tokio::spawn(async move {
            let client = http();
            let deadline = Instant::now() + Duration::from_secs(300);
            let mut published = Vec::new();
            for _ in 0..40 {
                let account = Account::new();
                // Revision 0 and one renewal, each retried on the next relay until accepted.
                let mut chain = vec![account.sign(0, None, 0)];
                chain.push(account.sign(1, Some(chain[0].hash), 0));
                let mut target = writer;
                for entry in &chain {
                    loop {
                        assert!(Instant::now() < deadline, "writer {writer} never finished");
                        let status =
                            publish(&client, &origins[target % 3], &account.subject(), entry).await;
                        if status == 200 {
                            break;
                        }
                        target += 1;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
                acked.fetch_add(1, Ordering::SeqCst);
                published.push((account.subject(), chain.pop().unwrap()));
            }
            published
        }));
    }
    while acked.load(Ordering::SeqCst) < 20 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    container_action("relay-a", "kill");
    tokio::time::sleep(Duration::from_secs(3)).await;
    container_action("relay-a", "start");
    let mut published = Vec::new();
    for writer in writers {
        published.extend(writer.await.unwrap());
    }
    assert_eq!(published.len(), 120);
    let client = http();
    for origin in origins.iter() {
        wait_ready(origin).await;
        for (subject, head) in &published {
            assert_eq!(
                resolve(&client, &head_url(origin, subject)).await,
                (200, head.attestation.clone()),
                "{origin} {subject}"
            );
        }
    }
    println!(
        "PASS directory: relay-a killed mid-load; all {} acknowledged accounts resolve at \
         their acknowledged head on every relay",
        published.len()
    );
}

// ---------------------------------------------------------------------------------------------
// Forum (HA step 9): one shared store behind every replica
// ---------------------------------------------------------------------------------------------

/// The lab's forum burn address (`[registry.forum]` in `cluster/relay.toml.in`).
const FORUM_BURN_ADDRESS: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xde, 0xad,
];
/// What every contract post or vote burns: 0.000001 MON.
const FORUM_BURN_WEI: u128 = 1_000_000_000_000;

fn forum_frame(type_id: u32, target: frank_cbor::CborValue, burn: Vec<u8>) -> Vec<u8> {
    use frank_cbor::{cbor_map, encode_frame, CborValue, EnvelopeFields, FramePayload};
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&cbor_map(vec![
            (0, CborValue::Text(solonet_payer::SOLONET_NETWORK.into())),
            (1, target),
            // A burn set of one.
            (2, CborValue::Array(vec![CborValue::Bytes(burn)])),
        ])),
    )
    .unwrap()
}

/// A post (`target = None`) or an up-vote of `target`, burned by `payer` at its nonce 0 and
/// committing to the event, exactly as the wallet builds it.
fn forum_event(
    solonet: &Solonet,
    payer: &Payer,
    topic: &str,
    title: &str,
    target: Option<[u8; 32]>,
) -> Vec<u8> {
    use frank_cbor::{message_types, CborValue, ForumEntry, Timestamp};
    let (type_id, item) = match target {
        Some(hash) => (
            message_types::TYPE_TOPIC_VOTE_SUBMISSION,
            CborValue::Bytes(hash.to_vec()),
        ),
        None => {
            let post = frank_cbor::encode_forum_post(
                solonet_payer::SOLONET_NETWORK,
                topic,
                None,
                &Timestamp {
                    seconds: unix_now(),
                    nanoseconds: 0,
                },
                &[ForumEntry::Post {
                    title: Some(title.into()),
                    url: None,
                    message: Some("cluster contract".into()),
                    unknown: vec![],
                }],
            )
            .unwrap();
            (
                message_types::TYPE_TOPIC_POST_SUBMISSION,
                CborValue::Bytes(post),
            )
        }
    };
    let preliminary = cashweb_registry::monad_topic_cbor::parse_topic_event(
        &forum_frame(type_id, item.clone(), vec![1]),
        solonet_payer::SOLONET_NETWORK,
    )
    .unwrap();
    let mut calldata = b"TPIC".to_vec();
    calldata.extend([2, 1]);
    calldata.extend(preliminary.commitment());
    let (payment, _) = solonet.payment_tx(
        payer,
        solonet_payer::SOLONET_NETWORK,
        solonet_payer::SOLONET_CHAIN_ID,
        FORUM_BURN_ADDRESS,
        FORUM_BURN_WEI,
        &calldata,
    );
    let raw = hex::decode(payment["raw_transaction"].as_str().unwrap()).unwrap();
    forum_frame(type_id, item, raw)
}

fn target_of(event: &[u8]) -> [u8; 32] {
    *cashweb_registry::monad_topic_cbor::parse_topic_event(event, solonet_payer::SOLONET_NETWORK)
        .unwrap()
        .target_hash()
}

fn forum_typed(bytes: &[u8]) -> frank_cbor::TypedPayload {
    let frank_cbor::ValidationResult::Parsed(parsed) =
        frank_cbor::validate_frame(bytes, &frank_cbor::default_context()).unwrap()
    else {
        panic!("not a canonical forum frame")
    };
    *parsed.typed.unwrap()
}

/// The answers of a Forum relay that holds the event but has not counted it yet: 200 pending
/// (the node has not accepted every burn: solonet refuses a freshly funded sender for a few
/// blocks, or is overloaded), 422 `topic_burn_refused` (the node refused every burn, for the
/// same reasons) and 503 `forum_unavailable` (it could not settle its own commit). Not
/// refusals of the event: the protocol has the wallet resend the identical bytes
/// (docs/protocol/forum-runtime-storage.md), and so does this contract. A fresh burn is never
/// signed for it.
const FORUM_NOT_COUNTED_YET: [&str; 2] = ["topic_burn_refused", "forum_unavailable"];
/// How long one Forum event is resent until it counts.
const FORUM_OUTCOME_PATIENCE: Duration = Duration::from_secs(300);

/// `PUT /topics` (post) or `/topics/vote`: the status and the body. Until the relay counts the
/// event, the same event bytes are sent again. A counted answer comes without waiting for a block.
async fn forum_put(
    client: &reqwest::Client,
    origin: &str,
    event: &[u8],
    vote: bool,
) -> (u16, Vec<u8>) {
    let started = Instant::now();
    loop {
        let (status, body) = forum_put_once(client, origin, event, vote).await;
        let code = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|error| error["error"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let pending = status == 200
            && matches!(
                forum_typed(&body),
                frank_cbor::TypedPayload::ForumOperationStatus(frank_cbor::ForumOperationStatus {
                    evidence: frank_cbor::ForumOperationEvidence::Pending,
                    ..
                })
            );
        let not_yet = pending
            || (matches!(status, 422 | 503) && FORUM_NOT_COUNTED_YET.contains(&code.as_str()));
        if !not_yet || started.elapsed() >= FORUM_OUTCOME_PATIENCE {
            return (status, body);
        }
        println!(
            "{origin}: {status} {} ({}); the same event again",
            if pending { "pending" } else { &code },
            String::from_utf8_lossy(&body[..body.len().min(200)])
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The relay's evidence for a status answer.
fn forum_evidence(body: &[u8]) -> frank_cbor::ForumOperationEvidence {
    let frank_cbor::TypedPayload::ForumOperationStatus(status) = forum_typed(body) else {
        panic!("not a forum status")
    };
    status.evidence
}

/// A PUT answer is counted: visible or in the tally now, landed or not.
fn assert_counted(body: &[u8], what: &str) {
    assert!(
        matches!(
            forum_evidence(body),
            frank_cbor::ForumOperationEvidence::Counted
                | frank_cbor::ForumOperationEvidence::Confirmed { .. }
        ),
        "{what}: {:?}",
        forum_evidence(body)
    );
}

/// Wait until every relay of `origins` reports `event` confirmed: the background pass saw each
/// of its burns land, so the counted weight is paid and stays.
async fn forum_wait_confirmed(client: &reqwest::Client, origins: &[&String], event: &[u8]) {
    let started = Instant::now();
    for origin in origins {
        loop {
            let response = client
                .post(format!("{origin}/topics/status"))
                .header("content-type", "application/cbor")
                .header("accept", "application/cbor")
                .body(event.to_vec())
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 200, "{origin} status");
            let evidence = forum_evidence(&response.bytes().await.unwrap());
            match evidence {
                frank_cbor::ForumOperationEvidence::Confirmed { .. } => break,
                frank_cbor::ForumOperationEvidence::Counted
                    if started.elapsed() < FORUM_OUTCOME_PATIENCE =>
                {
                    tokio::time::sleep(Duration::from_millis(500)).await
                }
                other => panic!("{origin}: the event did not land: {other:?}"),
            }
        }
    }
}

/// `PUT /topics` (post) or `/topics/vote` once.
async fn forum_put_once(
    client: &reqwest::Client,
    origin: &str,
    event: &[u8],
    vote: bool,
) -> (u16, Vec<u8>) {
    let path = if vote { "/topics/vote" } else { "/topics" };
    let response = client
        .put(format!("{origin}{path}"))
        .header("content-type", "application/cbor")
        .header("accept", "application/cbor")
        .body(event.to_vec())
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.bytes().await.unwrap().to_vec())
}

async fn forum_get(client: &reqwest::Client, url: &str) -> Vec<u8> {
    let response = client
        .get(url)
        .header("accept", "application/cbor")
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.bytes().await.unwrap().to_vec();
    assert_eq!(status, 200, "{url}: {}", String::from_utf8_lossy(&body));
    body
}

/// A topic page from `origin`: its posts (target hash, aggregate magnitude) and next cursor.
async fn forum_page(
    client: &reqwest::Client,
    origin: &str,
    topic: &str,
    cursor: Option<&[u8]>,
) -> (Vec<([u8; 32], [u8; 32])>, Option<Vec<u8>>, u64) {
    let mut url = format!("{origin}/topics?topic={topic}&since=0");
    if let Some(cursor) = cursor {
        url.push_str("&cursor=");
        url.push_str(&frank_cbor::forum_cursor_to_transport(cursor).unwrap());
    }
    let frank_cbor::TypedPayload::ForumTopicPage(page) =
        forum_typed(&forum_get(client, &url).await)
    else {
        panic!("not a topic page")
    };
    let rows = page
        .rows
        .iter()
        .map(|row| {
            let frank_cbor::TypedPayload::ForumView(view) = forum_typed(&row.frame) else {
                panic!("not a view")
            };
            // The post's hash, as a submission of its frame names it.
            let hash = target_of(&forum_frame(
                frank_cbor::message_types::TYPE_TOPIC_POST_SUBMISSION,
                frank_cbor::CborValue::Bytes(view.post_frame.frame.clone()),
                vec![1],
            ));
            (hash, view.aggregate.magnitude)
        })
        .collect();
    (rows, page.next_cursor.map(|c| c.bytes), page.revision)
}

fn wei_magnitude(wei: u128) -> [u8; 32] {
    let mut out = [0; 32];
    out[16..].copy_from_slice(&wei.to_be_bytes());
    out
}

fn fresh_topic(name: &str) -> String {
    format!("lab.{name}.{:08x}", rand::random::<u32>())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forum_a_post_on_a_reads_on_b_and_c_and_a_vote_on_c_counts_everywhere() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let solonet = Solonet::from_env().await;
    let payers = solonet.fund(2).await;
    let topic = fresh_topic("read");
    let post = forum_event(&solonet, payers.take(), &topic, "posted on A", None);
    let target = target_of(&post);
    let started = Instant::now();
    let (status, body) = forum_put(&client, &a, &post, false).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert_counted(&body, "post on A");
    // Counted on acceptance: visible on B, C and the proxy as soon as A answers.
    for origin in [&b, &c, &proxy()] {
        let (rows, _, _) = forum_page(&client, origin, &topic, None).await;
        assert_eq!(
            rows,
            vec![(target, wei_magnitude(FORUM_BURN_WEI))],
            "{origin}"
        );
    }
    println!(
        "forum: post on A visible on B, C and the proxy {:?} after it was sent",
        started.elapsed()
    );
    let vote = forum_event(&solonet, payers.take(), &topic, "", Some(target));
    let (status, body) = forum_put(&client, &c, &vote, true).await;
    assert_eq!(status, 200, "vote on C: {}", String::from_utf8_lossy(&body));
    assert_counted(&body, "vote on C");
    for origin in [&a, &b, &c] {
        let (rows, _, _) = forum_page(&client, origin, &topic, None).await;
        assert_eq!(
            rows,
            vec![(target, wei_magnitude(2 * FORUM_BURN_WEI))],
            "{origin}: the vote counts before its burn lands"
        );
    }
    // The burns land: every replica confirms both, and the counted weight stays.
    forum_wait_confirmed(&client, &[&a, &b, &c], &post).await;
    forum_wait_confirmed(&client, &[&a, &b, &c], &vote).await;
    for origin in [&a, &b, &c] {
        let (rows, _, _) = forum_page(&client, origin, &topic, None).await;
        assert_eq!(
            rows,
            vec![(target, wei_magnitude(2 * FORUM_BURN_WEI))],
            "{origin}"
        );
        let view = forum_get(&client, &format!("{origin}/topics/{}", hex::encode(target))).await;
        let frank_cbor::TypedPayload::ForumView(view) = forum_typed(&view) else {
            panic!()
        };
        assert_eq!(view.aggregate.magnitude, wei_magnitude(2 * FORUM_BURN_WEI));
    }
    // Through the round-robin proxy, every answer is the same.
    let through_proxy = forum_get(
        &client,
        &format!("{}/topics?topic={topic}&since=0", proxy()),
    )
    .await;
    for _ in 0..5 {
        assert_eq!(
            forum_get(
                &client,
                &format!("{}/topics?topic={topic}&since=0", proxy())
            )
            .await,
            through_proxy
        );
    }
    println!(
        "PASS forum: post on A read on B, C and the proxy; vote on C counted on every replica"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn forum_one_burn_sent_to_a_and_b_and_replayed_gives_one_post_counted_once() {
    let [a, b, c]: [String; 3] = relays().try_into().unwrap();
    for origin in [&a, &b, &c] {
        wait_ready(origin).await;
    }
    let client = http();
    let solonet = Solonet::from_env().await;
    let payers = solonet.fund(2).await;
    let topic = fresh_topic("once");
    let post = forum_event(&solonet, payers.take(), &topic, "sent to A and B", None);
    let target = target_of(&post);
    let (to_a, to_b) = tokio::join!(
        forum_put(&client, &a, &post, false),
        forum_put(&client, &b, &post, false)
    );
    assert_eq!(to_a.0, 200, "A: {}", String::from_utf8_lossy(&to_a.1));
    assert_eq!(to_b.0, 200, "B: {}", String::from_utf8_lossy(&to_b.1));
    assert_counted(&to_a.1, "A");
    assert_counted(&to_b.1, "B");
    // Settle the post first, so the background pass changes nothing more under the revision.
    forum_wait_confirmed(&client, &[&a, &b, &c], &post).await;
    let (_, _, revision) = forum_page(&client, &c, &topic, None).await;
    // A replay on C, and on A again, is answered from the store and changes nothing.
    for origin in [&c, &a] {
        let (status, body) = forum_put(&client, origin, &post, false).await;
        assert_eq!(status, 200, "{origin}: {}", String::from_utf8_lossy(&body));
        assert!(matches!(
            forum_evidence(&body),
            frank_cbor::ForumOperationEvidence::Confirmed { .. }
        ));
    }
    let vote = forum_event(&solonet, payers.take(), &topic, "", Some(target));
    let (v_b, v_c) = tokio::join!(
        forum_put(&client, &b, &vote, true),
        forum_put(&client, &c, &vote, true)
    );
    assert_eq!((v_b.0, v_c.0), (200, 200));
    assert_counted(&v_b.1, "vote on B");
    assert_counted(&v_c.1, "vote on C");
    let (status, body) = forum_put(&client, &a, &vote, true).await;
    assert_eq!(status, 200, "a replayed vote on A");
    assert_counted(&body, "a replayed vote on A");
    forum_wait_confirmed(&client, &[&a, &b, &c], &vote).await;
    for origin in [&a, &b, &c] {
        let (rows, _, now) = forum_page(&client, origin, &topic, None).await;
        assert_eq!(
            rows,
            vec![(target, wei_magnitude(2 * FORUM_BURN_WEI))],
            "{origin}"
        );
        // One admission, one counting and one confirmation for the vote since the first read.
        assert_eq!(now, revision + 3, "{origin}");
    }
    let discover = forum_get(&client, &format!("{c}/topics/discover")).await;
    let frank_cbor::TypedPayload::ForumDiscoveryPage(mut page) = forum_typed(&discover) else {
        panic!()
    };
    // Pages through discovery until this topic shows up, with each next page on another replica.
    let relays = [&a, &b, &c];
    let mut hop = 0;
    let entry = loop {
        if let Some(entry) = page.entries.iter().find(|e| e.topic == topic) {
            break entry.clone();
        }
        let cursor = page.next_cursor.expect("the topic is listed").bytes;
        hop += 1;
        let url = format!(
            "{}/topics/discover?cursor={}",
            relays[hop % 3],
            frank_cbor::forum_cursor_to_transport(&cursor).unwrap()
        );
        let frank_cbor::TypedPayload::ForumDiscoveryPage(next) =
            forum_typed(&forum_get(&client, &url).await)
        else {
            panic!()
        };
        page = next;
    };
    assert_eq!(entry.count, 1, "one burn sent to two replicas is one post");
    println!("PASS forum: one burn to A and B, replays on C and A, one post counted once");
}

/// More posts than one page holds, so the second page needs a cursor.
const FORUM_PAGED_POSTS: usize = 130;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn forum_a_cursor_from_a_continues_on_b_and_c() {
    let relays = relays();
    for origin in &relays {
        wait_ready(origin).await;
    }
    let client = http();
    let solonet = Solonet::from_env().await;
    let payers = Arc::new(solonet.fund(FORUM_PAGED_POSTS).await);
    let topic = fresh_topic("paged");
    let in_flight = Arc::new(tokio::sync::Semaphore::new(30));
    let mut tasks = Vec::new();
    for index in 0..FORUM_PAGED_POSTS {
        let event = forum_event(
            &solonet,
            payers.take(),
            &topic,
            &format!("post {index}"),
            None,
        );
        let (client, origin, in_flight) =
            (client.clone(), relays[index % 3].clone(), in_flight.clone());
        tasks.push(tokio::spawn(async move {
            let _slot = in_flight.acquire().await.unwrap();
            let (status, body) = forum_put(&client, &origin, &event, false).await;
            assert_eq!(status, 200, "{origin}: {}", String::from_utf8_lossy(&body));
            assert_counted(&body, &origin);
            target_of(&event)
        }));
    }
    let mut posted = BTreeSet::new();
    for task in tasks {
        posted.insert(task.await.unwrap());
    }
    let (first, cursor, _) = forum_page(&client, &relays[0], &topic, None).await;
    assert_eq!(first.len(), 128);
    let cursor = cursor.expect("a cursor to the second page");
    let mut seconds = Vec::new();
    for origin in &relays[1..] {
        let (second, last, _) = forum_page(&client, origin, &topic, Some(&cursor)).await;
        assert!(last.is_none(), "{origin}");
        seconds.push(second);
    }
    assert_eq!(
        seconds[0], seconds[1],
        "B and C continue A's cursor identically"
    );
    let seen: BTreeSet<[u8; 32]> = first.iter().chain(&seconds[0]).map(|(h, _)| *h).collect();
    assert_eq!(first.len() + seconds[0].len(), FORUM_PAGED_POSTS);
    assert_eq!(seen, posted);
    println!(
        "PASS forum: {FORUM_PAGED_POSTS} posts over three relays; A's cursor continues on B and C"
    );
}
