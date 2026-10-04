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
//! Conflicting chains are never resolved by timestamp and never quarantined: every relay
//! applies one total rule (an unexpired chain beats an expired one, then the higher latest
//! revision wins, then the lower hash at the first difference), so all relays converge.
//!
//! Messages: a submission for a recipient whose entry names another relay is checked, written
//! durably, and re-sent to that relay until it gives a final answer. Re-sending the same bytes is
//! idempotent on the receiving relay, so the recipient gets one message however often either
//! relay restarts.
use crate::{
    directory_runtime::{DirectoryRuntime, RuntimeError},
    store::directory_subjects::ForwardRow,
};
use std::{
    collections::{HashMap, HashSet},
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
/// Forwards waiting for the recipient's relay, in total. More are refused as "busy, retry".
pub(crate) const MAX_PENDING_FORWARDS: usize = 1024;
/// Forwards waiting from one sender, so one account cannot take the whole queue.
pub(crate) const MAX_PENDING_PER_SENDER: usize = 32;
/// Forwards waiting for one recipient.
pub(crate) const MAX_PENDING_PER_RECIPIENT: usize = 128;
/// A forward that no relay ever took is given up after this long.
const FORWARD_LIFETIME_MS: i64 = 24 * 3600 * 1000;
const MAX_BACKOFF_MS: i64 = 300_000;
/// Forwards retried at once by the timer.
const RETRY_CONCURRENCY: usize = 8;
/// Shortest pause between two rounds of asking every peer which relay it is.
const REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// What asking the peers about a key found out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Learned {
    /// This relay holds the key's chain now.
    Held,
    /// Every peer answered and none has it.
    Unknown,
    /// Some peer could not be asked (down, slow, busy) or this relay is busy: nothing is known.
    Unavailable,
}

/// What one attempt at passing a retained message on came to.
#[derive(Debug)]
pub(crate) enum Forwarded {
    /// Tell the sender this.
    Answer(u16, String),
    /// The recipient lives on this relay now and the message was never handed to another relay:
    /// the forward is gone and the message is to be delivered here.
    Local,
}

/// Outcome of writing down a new forward.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Stored,
    /// The same bytes were already written down.
    Exists,
    /// Too many forwards wait already, in total, from this sender or for this recipient.
    Full,
}

#[derive(Debug, Default)]
struct Pending {
    loaded: bool,
    /// Forwards not yet finished: identity to (sender, recipient).
    rows: HashMap<[u8; 32], (String, String)>,
}

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
    /// Forwards with an attempt under way. One attempt per message at a time.
    in_flight: Mutex<HashSet<[u8; 32]>>,
    pending: Mutex<Pending>,
    refreshed: Mutex<Option<Instant>>,
}

/// Held while one attempt at a forward runs.
struct Attempt<'a> {
    set: &'a Mutex<HashSet<[u8; 32]>>,
    identity: [u8; 32],
}
impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.identity);
    }
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
fn retained(row: &ForwardRow) -> String {
    serde_json::json!({"version":1,"phase":"retained","identity":row.echo}).to_string()
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
            in_flight: Mutex::new(HashSet::new()),
            pending: Mutex::new(Pending::default()),
            refreshed: Mutex::new(None),
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
    async fn pull(
        &self,
        runtime: &DirectoryRuntime,
        peer: &Url,
        network: &str,
        subject: &str,
    ) -> Learned {
        let url = join(peer, &format!("/directory/v1/{network}/{subject}/chain"));
        let Some(response) = self.fetch(url).await else {
            return Learned::Unavailable;
        };
        match response.status() {
            reqwest::StatusCode::OK => (),
            reqwest::StatusCode::NOT_FOUND => return Learned::Unknown,
            _ => return Learned::Unavailable,
        }
        let Some(chain) = Self::body(response, MAX_CHAIN_BYTES).await else {
            return Learned::Unavailable;
        };
        match runtime.replicate(network, subject, records(&chain)).await {
            // Copied, kept, or a copy this relay never takes (forged, broken, expired, or an
            // account that must publish here itself): what is held now is the answer.
            Ok(())
            | Err(
                RuntimeError::Invalid
                | RuntimeError::Trust
                | RuntimeError::NotFound
                | RuntimeError::Forked
                | RuntimeError::Expired,
            ) => (),
            // Busy, full or a storage fault here: nothing is known.
            Err(_) => return Learned::Unavailable,
        }
        if runtime.is_published(network, subject) {
            Learned::Held
        } else {
            Learned::Unknown
        }
    }
    /// Ask peers for a key this relay does not hold.
    pub(crate) async fn learn(
        &self,
        runtime: &DirectoryRuntime,
        network: &str,
        subject: &str,
    ) -> Learned {
        if runtime.is_published(network, subject) {
            return Learned::Held;
        }
        let key = format!("s:{network}:{subject}");
        if self.peers.is_empty() || self.recently_unknown(&key) {
            return Learned::Unknown;
        }
        // At most a few peer lookups at a time; past that the answer is "busy", never "unknown".
        let Ok(_lookup) = self.lookups.try_acquire() else {
            return Learned::Unavailable;
        };
        let mut outcome = Learned::Unknown;
        for peer in &self.peers {
            match self.pull(runtime, peer, network, subject).await {
                Learned::Held => return Learned::Held,
                Learned::Unavailable => outcome = Learned::Unavailable,
                Learned::Unknown => (),
            }
        }
        if outcome == Learned::Unknown {
            self.remember_unknown(key);
        }
        outcome
    }
    /// Ask peers which key has `address`, and copy that key's chain. `Ok(None)`: every peer
    /// answered and none knows it. `Err(())`: some peer could not be asked, or this relay is
    /// busy. The key returned was checked against the address; its entry is still verified by
    /// the directory itself.
    pub(crate) async fn learn_address(
        &self,
        runtime: &DirectoryRuntime,
        network: &str,
        address: crate::monad_http::Address,
    ) -> Result<Option<String>, ()> {
        let key = format!("a:{network}:{}", address.to_hex());
        if self.peers.is_empty() || self.recently_unknown(&key) {
            return Ok(None);
        }
        let Ok(_lookup) = self.lookups.try_acquire() else {
            return Err(());
        };
        let mut unavailable = false;
        for peer in &self.peers {
            let url = join(
                peer,
                &format!("/directory/v1/{network}/address/{}", address.to_hex()),
            );
            let Some(response) = self.fetch(url).await else {
                unavailable = true;
                continue;
            };
            match response.status() {
                reqwest::StatusCode::OK => (),
                reqwest::StatusCode::NOT_FOUND => continue,
                _ => {
                    unavailable = true;
                    continue;
                }
            }
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
            match self.pull(runtime, peer, network, &subject).await {
                Learned::Held => return Ok(Some(subject)),
                Learned::Unavailable => unavailable = true,
                Learned::Unknown => (),
            }
        }
        if unavailable {
            return Err(());
        }
        self.remember_unknown(key);
        Ok(None)
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
        self.peer_named(&relay.endpoint, &hex::encode(&relay.relay_id))
    }
    fn peer_named(&self, endpoint: &str, relay_id: &str) -> Option<Url> {
        self.endpoints
            .lock()
            .unwrap()
            .get(&(endpoint.to_owned(), relay_id.to_owned()))
            .cloned()
    }
    /// Ask every configured peer, at once, which relay it is. Needed before anything can be
    /// forwarded. At most one round per second.
    pub(crate) async fn refresh_peers(&self) {
        {
            let mut last = self.refreshed.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < REFRESH_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        let answers = futures::future::join_all(self.peers.iter().map(|peer| async move {
            let response = self.fetch(join(peer, "/relay/v1/info")).await?;
            let info = Self::body(response, 16 * 1024)
                .await
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())?;
            Some((
                (
                    info["endpoint"].as_str()?.to_owned(),
                    info["relayId"].as_str()?.to_owned(),
                ),
                peer.clone(),
            ))
        }))
        .await;
        let mut endpoints = self.endpoints.lock().unwrap();
        for (name, peer) in answers.into_iter().flatten() {
            endpoints.insert(name, peer);
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
    /// Write down a new forward with its exact bytes, unless too many already wait in total,
    /// from this sender or for this recipient. One writer at a time, so two submissions of the
    /// same bytes cannot both write.
    pub(crate) fn admit(
        &self,
        runtime: &DirectoryRuntime,
        identity: &[u8; 32],
        row: &ForwardRow,
        body: &[u8],
    ) -> Result<Admission, ()> {
        let rows = runtime.registry().directory_subjects().map_err(|_| ())?;
        let mut pending = self.pending.lock().unwrap();
        if !pending.loaded {
            for (identity, stored) in rows.forwards().map_err(|_| ())? {
                if !stored.done {
                    pending
                        .rows
                        .insert(identity, (stored.sender, stored.recipient));
                }
            }
            pending.loaded = true;
        }
        if rows.forward(identity).map_err(|_| ())?.is_some() {
            return Ok(Admission::Exists);
        }
        let from_sender = pending
            .rows
            .values()
            .filter(|(sender, _)| *sender == row.sender)
            .count();
        let for_recipient = pending
            .rows
            .values()
            .filter(|(_, recipient)| *recipient == row.recipient)
            .count();
        if pending.rows.len() >= MAX_PENDING_FORWARDS
            || from_sender >= MAX_PENDING_PER_SENDER
            || for_recipient >= MAX_PENDING_PER_RECIPIENT
        {
            return Ok(Admission::Full);
        }
        rows.put_forward(identity, row, Some(body)).map_err(|_| ())?;
        pending
            .rows
            .insert(*identity, (row.sender.clone(), row.recipient.clone()));
        Ok(Admission::Stored)
    }
    /// A forward is finished (or gone): it no longer counts against any limit.
    fn settle(&self, identity: &[u8; 32]) {
        self.pending.lock().unwrap().rows.remove(identity);
    }
    /// Where the recipient of a forward lives now, from its current entry here. `Ok(None)`:
    /// it has no current entry. `Err(())`: the directory could not answer.
    async fn home(
        &self,
        runtime: &DirectoryRuntime,
        row: &ForwardRow,
    ) -> Result<Option<frank_cbor::RelayBinding>, ()> {
        use crate::directory_runtime::{AdmittedSnapshot, SnapshotOperation};
        let slot = runtime.reserve(&row.network, &row.recipient).map_err(|_| ())?;
        match runtime
            .submit_snapshot(slot, SnapshotOperation::Current)
            .wait()
            .await
        {
            Ok(AdmittedSnapshot::Current(current)) => Ok(Some(current.relay)),
            Err(RuntimeError::NotFound | RuntimeError::Expired | RuntimeError::Forked) => Ok(None),
            _ => Err(()),
        }
    }
    /// Try once to hand a retained message to the relay its recipient lives on. Only one
    /// attempt per message runs at a time; a concurrent caller is told what is known so far.
    ///
    /// Until some relay may have taken the message, the recipient's home is read again on each
    /// attempt (it may have moved), and this relay may end the forward itself as
    /// `undeliverable`: nothing was broadcast. Once a relay answered "retained" or "delivered",
    /// or a request reached it without an answer, the forward is pinned to that relay and only
    /// that relay's final answer ends it. With `local_ok`, a recipient that moved onto this
    /// relay before anything was handed on gets [`Forwarded::Local`].
    pub(crate) async fn forward(
        self: &Arc<Self>,
        runtime: &DirectoryRuntime,
        identity: &[u8; 32],
        local_ok: bool,
    ) -> Option<Forwarded> {
        let registry = runtime.registry().clone();
        // The store handle is not held across a wait: it is taken again for each read or write.
        let load = || registry.directory_subjects().ok()?.forward(identity).ok()?;
        if !self.in_flight.lock().unwrap().insert(*identity) {
            let row = load()?;
            return Some(if row.done {
                Forwarded::Answer(row.status, row.response)
            } else {
                Forwarded::Answer(202, retained(&row))
            });
        }
        let _attempt = Attempt {
            set: &self.in_flight,
            identity: *identity,
        };
        let mut row = load()?;
        if row.done {
            return Some(Forwarded::Answer(row.status, row.response));
        }
        // Never turns a finished forward back into a waiting one.
        let save = |row: &ForwardRow| -> Option<()> {
            let rows = registry.directory_subjects().ok()?;
            if rows.forward(identity).ok()?.is_some_and(|stored| stored.done) {
                return Some(());
            }
            rows.put_forward(identity, row, None).ok()?;
            if row.done {
                self.settle(identity);
            }
            Some(())
        };
        let now = now_ms();
        let mut permanent = false;
        let mut target: Option<(Url, (String, String))> = None;
        if let Some(pin) = row.pinned.clone() {
            let mut url = self.peer_named(&pin.0, &pin.1);
            if url.is_none() {
                self.refresh_peers().await;
                url = self.peer_named(&pin.0, &pin.1);
            }
            target = url.map(|url| (url, pin));
        } else {
            match self.home(runtime, &row).await {
                Ok(Some(relay)) if runtime.info().is_local(&relay) => {
                    if local_ok {
                        registry
                            .directory_subjects()
                            .ok()?
                            .delete_forward(identity)
                            .ok()?;
                        self.settle(identity);
                        return Some(Forwarded::Local);
                    }
                }
                Ok(Some(relay)) => {
                    let pin = (relay.endpoint.clone(), hex::encode(&relay.relay_id));
                    let mut url = self.peer_named(&pin.0, &pin.1);
                    if url.is_none() && !self.peers_known() {
                        self.refresh_peers().await;
                        url = self.peer_named(&pin.0, &pin.1);
                    }
                    permanent = url.is_none() && self.peers_known();
                    target = url.map(|url| (url, pin));
                }
                Ok(None) => permanent = true,
                Err(()) => (),
            }
            permanent |= now.saturating_sub(row.created_ms) >= FORWARD_LIFETIME_MS;
        }
        if permanent {
            // No relay ever took it, so no payment was broadcast: a final "undeliverable".
            row.done = true;
            row.status = 200;
            row.response = serde_json::json!({"version":1,"phase":"dead","identity":row.echo,
                "reason":"undeliverable"})
            .to_string();
            save(&row)?;
            return Some(Forwarded::Answer(row.status, row.response));
        }
        row.attempts = row.attempts.saturating_add(1);
        row.next_ms = now + (1000i64 << row.attempts.min(9)).min(MAX_BACKOFF_MS);
        let body = registry
            .directory_subjects()
            .ok()?
            .forward_body(identity)
            .ok()?;
        let (Some((url, pin)), Some(body)) = (target, body) else {
            // No relay to try right now, or the bytes are missing: not a final answer.
            save(&row)?;
            return Some(Forwarded::Answer(202, retained(&row)));
        };
        let sent = self
            .client
            .put(join(&url, "/message/monad/cbor"))
            .header("content-type", &row.content_type)
            // The receiving relay delivers or refuses; it never forwards again.
            .header(FORWARDED_HEADER, "1")
            .body(body)
            .send()
            .await;
        let answer = match sent {
            Ok(response) => {
                let status = response.status().as_u16();
                let text = Self::body(response, 64 * 1024)
                    .await
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                Ok((status, text))
            }
            // A connection that was never made cannot have delivered anything.
            Err(error) => Err(error.is_connect()),
        };
        let reply = match answer {
            // A final answer from the recipient's relay: delivered or dead, or bytes it will
            // never accept. It is remembered and repeated; the bytes are no longer needed.
            Ok((status @ (200 | 400 | 413), Some(text))) => {
                row.done = true;
                row.status = status;
                row.response = text.clone();
                (status, text)
            }
            // Held by the recipient's relay but not delivered yet: from now on only that relay
            // decides.
            Ok((202, Some(text))) => {
                row.pinned = Some(pin);
                row.status = 202;
                (202, text)
            }
            // An answer that may mean it was taken, but could not be read; or a request that
            // reached the relay and got no answer at all. Either way that relay may hold it.
            Ok((200 | 202 | 400 | 413, None)) | Err(false) => {
                row.pinned = Some(pin);
                row.status = 0;
                (202, retained(&row))
            }
            // Any other answer is that relay not taking the message, for now: try again later.
            Ok((status, _)) => {
                row.status = status;
                (202, retained(&row))
            }
            Err(true) => {
                row.status = 0;
                (202, retained(&row))
            }
        };
        save(&row)?;
        Some(Forwarded::Answer(reply.0, reply.1))
    }
    /// Retry every forward that is due, a few at a time, and drop finished ones after a day.
    pub async fn retry_forwards(self: &Arc<Self>, runtime: &DirectoryRuntime) {
        use futures::StreamExt;
        let registry = runtime.registry().clone();
        let Ok(forwards) = registry
            .directory_subjects()
            .and_then(|rows| rows.forwards())
        else {
            return;
        };
        let now = now_ms();
        let mut due = Vec::new();
        for (identity, row) in forwards {
            if row.done {
                if now.saturating_sub(row.created_ms) > 2 * FORWARD_LIFETIME_MS {
                    if let Ok(rows) = registry.directory_subjects() {
                        let _ = rows.delete_forward(&identity);
                    }
                }
            } else if row.next_ms <= now {
                due.push(identity);
            }
        }
        futures::stream::iter(due)
            .for_each_concurrent(RETRY_CONCURRENCY, |identity| async move {
                let _ = self.forward(runtime, &identity, false).await;
            })
            .await;
    }
    /// One round of everything this relay does on a timer. Copying entries and retrying
    /// forwards run side by side, so a peer that is down slows neither down for the other.
    pub async fn tick(self: &Arc<Self>, runtime: &DirectoryRuntime) {
        tokio::join!(self.sync(runtime), async {
            if self.forwarding {
                self.retry_forwards(runtime).await;
            }
        });
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
