//! Relay-to-relay behaviour of the open directory: copying entries and forwarding messages.
//!
//! Relays share no secret. Everything one relay hands another is something the receiver can
//! and does verify itself: a directory entry is signed by the account's own key, and a forwarded
//! message is the sender's exact sealed request, which the recipient's relay admits exactly as if
//! the sender had submitted it there (entries, stamp, payments on chain, replay protection).
//!
//! Entries: whole chains are copied, never only heads. A relay tells its peers when a key's
//! chain changed, and each relay periodically compares its list of keys with every peer's. A
//! relay asked for a key or address it does not hold asks its peers before answering "unknown".
//! Conflicting chains are never resolved by timestamp: the ordinary fork rule quarantines them.
//!
//! Messages: a submission for a recipient whose entry names another relay is checked, written
//! durably, and re-sent to that relay until it gives a final answer. Re-sending the same bytes is
//! idempotent on the receiving relay, so the recipient gets one message however often either
//! relay restarts.
use crate::{
    directory_runtime::{DirectoryRuntime, Operation, RuntimeError},
    store::directory_subjects::ForwardRow,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

/// Marks a request made by a relay on its own behalf; the receiver then answers from what it
/// holds and does not ask its own peers in turn.
pub(crate) const REPLICA_HEADER: &str = "x-frank-directory-replica";
/// Marks a message passed on by the sender's relay. A relay receiving it never forwards again.
pub(crate) const FORWARDED_HEADER: &str = "x-frank-forwarded";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CHAIN_BYTES: usize = crate::directory_admission::MAX_CHARGED_BYTES + 1024 * 1024;
const NEGATIVE_TTL: Duration = Duration::from_secs(3);
const LIST_PAGE: usize = 256;
/// Forwards waiting for the recipient's relay. More are refused as "busy, retry".
pub(crate) const MAX_PENDING_FORWARDS: usize = 1024;
/// A forward the recipient's relay never accepted is given up after this long.
const FORWARD_LIFETIME_MS: i64 = 24 * 3600 * 1000;
const MAX_BACKOFF_MS: i64 = 300_000;

/// Peers and outgoing HTTP of one relay.
#[derive(Debug)]
pub struct Federation {
    peers: Vec<Url>,
    forwarding: bool,
    client: reqwest::Client,
    /// What each configured peer says it is: (endpoint as written in entries, relay id in hex),
    /// to the configured URL it is reached at. Nothing else is ever contacted.
    endpoints: Mutex<HashMap<(String, String), Url>>,
    lookups: tokio::sync::Semaphore,
    /// Keys and addresses peers recently did not know.
    unknown: Mutex<HashMap<String, Instant>>,
    announcements: Arc<tokio::sync::Semaphore>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
fn join(base: &Url, path: &str) -> String {
    format!("{}{path}", base.as_str().trim_end_matches('/'))
}
impl Federation {
    /// `peers` are the base URLs of the relays this one copies entries with.
    pub fn new(peers: Vec<Url>, forwarding: bool) -> Self {
        Self {
            peers,
            forwarding,
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
            endpoints: Mutex::new(HashMap::new()),
            unknown: Mutex::new(HashMap::new()),
            announcements: Arc::new(tokio::sync::Semaphore::new(8)),
            lookups: tokio::sync::Semaphore::new(8),
        }
    }
    /// Whether this relay accepts messages for recipients on other relays.
    pub fn forwarding(&self) -> bool {
        self.forwarding
    }
    fn recently_unknown(&self, key: &str) -> bool {
        let mut unknown = self.unknown.lock().unwrap();
        if unknown.len() > 10_000 {
            unknown.clear();
        }
        unknown
            .get(key)
            .is_some_and(|at| at.elapsed() < NEGATIVE_TTL)
    }
    fn remember_unknown(&self, key: String) {
        self.unknown.lock().unwrap().insert(key, Instant::now());
    }
    async fn fetch(&self, url: String) -> Option<reqwest::Response> {
        self.client
            .get(url)
            .header(REPLICA_HEADER, "1")
            .send()
            .await
            .ok()
    }
    async fn body(response: reqwest::Response, limit: usize) -> Option<Vec<u8>> {
        use futures::StreamExt;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.ok()?;
            if bytes.len() + chunk.len() > limit {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        Some(bytes)
    }
    /// Copy `subject`'s whole chain from one peer and verify it into this relay's directory.
    async fn pull(&self, runtime: &DirectoryRuntime, peer: &Url, network: &str, subject: &str) {
        let url = join(peer, &format!("/directory/v1/{network}/{subject}/chain"));
        let Some(response) = self.fetch(url).await else {
            return;
        };
        if response.status() != reqwest::StatusCode::OK {
            return;
        }
        let Some(chain) = Self::body(response, MAX_CHAIN_BYTES).await else {
            return;
        };
        let _ = runtime.replicate(network, subject, records(&chain)).await;
    }
    /// Ask peers for a key this relay does not hold. True when it is held afterwards.
    pub(crate) async fn learn(
        &self,
        runtime: &DirectoryRuntime,
        network: &str,
        subject: &str,
    ) -> bool {
        if runtime.is_published(network, subject) {
            return true;
        }
        let key = format!("s:{network}:{subject}");
        if self.peers.is_empty() || self.recently_unknown(&key) {
            return false;
        }
        // At most a few peer lookups at a time; the rest are answered from what is held.
        let Ok(_lookup) = self.lookups.try_acquire() else {
            return false;
        };
        for peer in &self.peers {
            self.pull(runtime, peer, network, subject).await;
            if runtime.is_published(network, subject) {
                return true;
            }
        }
        self.remember_unknown(key);
        false
    }
    /// Ask peers which key has `address`, and copy that key's chain. The key returned was
    /// checked against the address; its entry is still verified by the directory itself.
    pub(crate) async fn learn_address(
        &self,
        runtime: &DirectoryRuntime,
        network: &str,
        address: crate::monad_http::Address,
    ) -> Option<String> {
        let key = format!("a:{network}:{}", address.to_hex());
        if self.peers.is_empty() || self.recently_unknown(&key) {
            return None;
        }
        // At most a few peer lookups at a time; the rest are answered from what is held.
        let Ok(_lookup) = self.lookups.try_acquire() else {
            return None;
        };
        for peer in &self.peers {
            let url = join(
                peer,
                &format!("/directory/v1/{network}/address/{}", address.to_hex()),
            );
            let Some(response) = self.fetch(url).await else {
                continue;
            };
            let Some(subject) = response
                .headers()
                .get("x-frank-directory-subject")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
            else {
                continue;
            };
            let matches = hex::decode(&subject).ok().is_some_and(|point| {
                crate::monad_stamp_stealth::recipient_address_from_public_key(&point).ok()
                    == Some(address)
            });
            if !matches || !crate::directory_runtime::valid_key(network, &subject) {
                continue;
            }
            self.pull(runtime, peer, network, &subject).await;
            if runtime.is_published(network, &subject) {
                return Some(subject);
            }
        }
        self.remember_unknown(key);
        None
    }
    /// Tell every peer that `subject`'s chain changed here. Peers then copy it from their own
    /// configured peers, so an announcement carries no content anyone has to trust.
    pub(crate) fn announce(self: &Arc<Self>, network: &str, subject: &str) {
        for peer in &self.peers {
            let Ok(permit) = self.announcements.clone().try_acquire_owned() else {
                return;
            };
            let url = join(peer, &format!("/directory/v1/{network}/{subject}/announce"));
            let client = self.client.clone();
            tokio::spawn(async move {
                let _ = client.post(url).header(REPLICA_HEADER, "1").send().await;
                drop(permit);
            });
        }
    }
    /// A peer said `subject` changed: copy it from the configured peers.
    pub(crate) async fn announced(&self, runtime: &DirectoryRuntime, network: &str, subject: &str) {
        for peer in &self.peers {
            self.pull(runtime, peer, network, subject).await;
        }
    }
    /// One round of comparing every peer's list of keys with this relay's and copying what
    /// differs. Also learns which configured URL serves which relay endpoint.
    pub async fn sync(self: &Arc<Self>, runtime: &DirectoryRuntime) {
        let network = runtime.info().network.clone();
        self.refresh_peers().await;
        for peer in &self.peers {
            let mut after: Option<String> = None;
            // Bounded by the peer's own subject budget; one page is one small request.
            for _ in 0..100_000 {
                let mut url = join(
                    peer,
                    &format!("/directory/v1/{network}/subjects?limit={LIST_PAGE}"),
                );
                if let Some(after) = &after {
                    url.push_str(&format!("&after={after}"));
                }
                let Some(response) = self.fetch(url).await else {
                    break;
                };
                if response.status() != reqwest::StatusCode::OK {
                    break;
                }
                let Some(page) = Self::body(response, 1024 * 1024)
                    .await
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                else {
                    break;
                };
                let listed = page["subjects"].as_array().cloned().unwrap_or_default();
                for item in &listed {
                    let Some(subject) = item["subject"].as_str() else {
                        continue;
                    };
                    if !crate::directory_runtime::valid_key(&network, subject) {
                        continue;
                    }
                    let theirs = (
                        item["head"].as_str().map(str::to_owned),
                        item["retained"].as_u64().unwrap_or(0),
                        item["forked"].as_bool().unwrap_or(false),
                    );
                    let ours = runtime.listed(&network, subject);
                    if ours.as_ref() == Some(&theirs) {
                        continue;
                    }
                    // Copy the peer's chain; the directory extends, keeps or replaces its own
                    // under the fixed rule. If the two still differ this relay holds something
                    // the peer lacks, so the peer is told to copy from here.
                    self.pull(runtime, peer, &network, subject).await;
                    if runtime.listed(&network, subject).as_ref() != Some(&theirs) {
                        self.announce(&network, subject);
                    }
                }
                after = page["next"].as_str().map(str::to_owned);
                if after.is_none() || listed.is_empty() {
                    break;
                }
            }
        }
    }
    /// The configured peer that is the relay named by `relay`, if any. The endpoint in an
    /// entry is text an account chose; it is only ever used to pick among configured peers.
    pub(crate) fn peer_for(&self, relay: &frank_cbor::RelayBinding) -> Option<Url> {
        self.endpoints
            .lock()
            .unwrap()
            .get(&(relay.endpoint.clone(), hex::encode(&relay.relay_id)))
            .cloned()
    }
    /// Ask each configured peer which relay it is. Needed before anything can be forwarded.
    pub(crate) async fn refresh_peers(&self) {
        for peer in &self.peers {
            let Some(response) = self.fetch(join(peer, "/relay/v1/info")).await else {
                continue;
            };
            let info = Self::body(response, 16 * 1024)
                .await
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            if let Some((endpoint, id)) = info
                .as_ref()
                .and_then(|info| Some((info["endpoint"].as_str()?, info["relayId"].as_str()?)))
            {
                self.endpoints
                    .lock()
                    .unwrap()
                    .insert((endpoint.to_owned(), id.to_owned()), peer.clone());
            }
        }
    }
    /// Whether every configured peer has said which relay it is. Until then "no peer is that
    /// relay" is not yet known and must not be reported as final.
    pub(crate) fn peers_known(&self) -> bool {
        let endpoints = self.endpoints.lock().unwrap();
        self.peers
            .iter()
            .all(|peer| endpoints.values().any(|known| known == peer))
    }
    /// Try once to hand a retained message to the relay its recipient lives on now. Returns
    /// what the sender should be told: that relay's own answer, or "retained".
    pub(crate) async fn forward(
        self: &Arc<Self>,
        runtime: &DirectoryRuntime,
        identity: &[u8; 32],
    ) -> Option<(u16, String)> {
        use crate::directory_runtime::{AdmittedSnapshot, SnapshotOperation};
        let registry = runtime.registry().clone();
        let save = |row: &ForwardRow| {
            registry
                .directory_subjects()
                .and_then(|rows| rows.put_forward(identity, row, None))
                .ok()
        };
        let mut row = registry
            .directory_subjects()
            .ok()?
            .forward(identity)
            .ok()??;
        if row.done {
            return Some((row.status, row.response));
        }
        let retained =
            serde_json::json!({"version":1,"phase":"retained","identity":row.echo}).to_string();
        let now = now_ms();
        // Where the recipient lives is read again on every attempt, so a recipient that moved
        // relay after the message was accepted is followed to its new home.
        let home = match runtime.reserve(&row.network, &row.recipient) {
            Ok(slot) => match runtime
                .submit_snapshot(slot, SnapshotOperation::Current)
                .wait()
                .await
            {
                Ok(AdmittedSnapshot::Current(current)) => Ok(Some(current.relay)),
                Err(RuntimeError::NotFound | RuntimeError::Expired | RuntimeError::Forked) => {
                    Ok(None)
                }
                _ => Err(()),
            },
            Err(_) => Err(()),
        };
        let mut target = None;
        let mut permanent = now.saturating_sub(row.created_ms) >= FORWARD_LIFETIME_MS;
        match &home {
            Ok(Some(relay)) => {
                target = self.peer_for(relay);
                if target.is_none() && !runtime.info().is_local(relay) {
                    if !self.peers_known() {
                        self.refresh_peers().await;
                        target = self.peer_for(relay);
                    }
                    permanent |= target.is_none() && self.peers_known();
                }
            }
            Ok(None) => permanent = true,
            Err(()) => (),
        }
        let body = registry
            .directory_subjects()
            .ok()?
            .forward_body(identity)
            .ok()?;
        if permanent || body.is_none() {
            row.done = true;
            row.status = 200;
            row.response = serde_json::json!({"version":1,"phase":"dead","identity":row.echo,
                "reason":"undeliverable"})
            .to_string();
            save(&row)?;
            return Some((row.status, row.response));
        }
        let answer = match (target, body) {
            (Some(target), Some(body)) => {
                match self
                    .client
                    .put(join(&target, "/message/monad/cbor"))
                    .header("content-type", &row.content_type)
                    // The receiving relay delivers or refuses; it never forwards again.
                    .header(FORWARDED_HEADER, "1")
                    .body(body)
                    .send()
                    .await
                {
                    Ok(response) => {
                        let status = response.status().as_u16();
                        Self::body(response, 64 * 1024)
                            .await
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                            .map(|text| (status, text))
                    }
                    Err(_) => None,
                }
            }
            _ => None,
        };
        row.attempts = row.attempts.saturating_add(1);
        row.next_ms = now + (1000i64 << row.attempts.min(9)).min(MAX_BACKOFF_MS);
        let reply = match answer {
            // A final answer from the recipient's relay: delivered, dead, or a request it will
            // never accept. It is remembered and repeated; the bytes are no longer needed.
            Some((status @ (200 | 400 | 409 | 413), text)) => {
                row.done = true;
                row.status = status;
                row.response = text.clone();
                (status, text)
            }
            // Held by the recipient's relay but not delivered yet: keep asking.
            Some((202, text)) => {
                row.status = 202;
                (202, text)
            }
            Some((status, _)) => {
                row.status = status;
                (202, retained)
            }
            None => {
                row.status = 0;
                (202, retained)
            }
        };
        save(&row)?;
        Some(reply)
    }
    /// Retry every forward that is due and drop finished ones after a day.
    pub async fn retry_forwards(self: &Arc<Self>, runtime: &DirectoryRuntime) {
        let registry = runtime.registry().clone();
        let Ok(forwards) = registry
            .directory_subjects()
            .and_then(|rows| rows.forwards())
        else {
            return;
        };
        let now = now_ms();
        for (identity, row) in forwards {
            if row.done {
                if now.saturating_sub(row.created_ms) > 2 * FORWARD_LIFETIME_MS {
                    if let Ok(rows) = registry.directory_subjects() {
                        let _ = rows.delete_forward(&identity);
                    }
                }
            } else if row.next_ms <= now {
                self.forward(runtime, &identity).await;
            }
        }
    }
    /// One round of everything this relay does on a timer.
    pub async fn tick(self: &Arc<Self>, runtime: &DirectoryRuntime) {
        self.sync(runtime).await;
        if self.forwarding {
            self.retry_forwards(runtime).await;
        }
    }
    /// Run [`Self::tick`] on the configured interval until the directory shuts down.
    pub fn spawn(runtime: DirectoryRuntime) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while !runtime.is_closed() {
                if let Some(federation) = runtime.federation().cloned() {
                    federation.tick(&runtime).await;
                }
                tokio::time::sleep(runtime.sync_interval()).await;
            }
        })
    }
}

/// The byte strings of a canonical CBOR array; anything else is no records at all.
fn records(chain: &[u8]) -> Vec<Vec<u8>> {
    match frank_cbor::decode_canonical(chain) {
        Ok(frank_cbor::CborValue::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                frank_cbor::CborValue::Bytes(bytes) => Some(bytes),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}
