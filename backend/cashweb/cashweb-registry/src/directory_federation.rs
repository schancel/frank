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

const MEDIA: &str = "application/vnd.frank.cbor";
/// Marks a request made by a relay on its own behalf; the receiver then answers from what it
/// holds and does not ask its own peers in turn.
pub(crate) const REPLICA_HEADER: &str = "x-frank-directory-replica";
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
    /// Relay endpoint (as written in entries) of each configured peer, to its configured URL.
    endpoints: Mutex<HashMap<String, Url>>,
    /// Keys and addresses peers recently did not know.
    unknown: Mutex<HashMap<String, Instant>>,
    announcements: Arc<tokio::sync::Semaphore>,
    coordinator: Option<Arc<tokio::sync::Mutex<crate::p2p::cluster::ClusterPeeringCoordinator>>>,
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
/// An endpoint from a signed entry that is not a configured peer is contacted only when it is a
/// public HTTPS origin: never this machine or a private network.
fn public_endpoint(endpoint: &str) -> Option<Url> {
    let url = Url::parse(endpoint).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.host()? {
        url::Host::Domain(name) => (!name.eq_ignore_ascii_case("localhost")
            && !name.ends_with(".localhost")
            && name.contains('.'))
        .then_some(url),
        url::Host::Ipv4(ip) => (!ip.is_loopback()
            && !ip.is_private()
            && !ip.is_link_local()
            && !ip.is_unspecified()
            && !ip.is_broadcast())
        .then_some(url),
        url::Host::Ipv6(ip) => (!ip.is_loopback()
            && !ip.is_unspecified()
            && (ip.segments()[0] & 0xfe00) != 0xfc00
            && (ip.segments()[0] & 0xffc0) != 0xfe80
            && ip.to_ipv4_mapped().is_none())
        .then_some(url),
    }
}

impl Federation {
    /// `peers` are the base URLs of the relays this one copies entries with.
    pub fn new(peers: Vec<Url>, forwarding: bool) -> Self {
        Self::new_with_coordinator(peers, forwarding, None)
    }

    /// Construct `Federation` with an optional cluster peering coordinator.
    pub fn new_with_coordinator(
        peers: Vec<Url>,
        forwarding: bool,
        coordinator: Option<
            Arc<tokio::sync::Mutex<crate::p2p::cluster::ClusterPeeringCoordinator>>,
        >,
    ) -> Self {
        let filtered_peers = if let Some(coord) = &coordinator {
            if let Ok(lock) = coord.try_lock() {
                if lock.is_clustered() {
                    peers
                        .into_iter()
                        .filter(|p| !crate::p2p::cluster::is_private_or_loopback_url(p))
                        .collect()
                } else {
                    peers
                }
            } else {
                peers
            }
        } else {
            peers
        };

        Self {
            peers: filtered_peers,
            forwarding,
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .unwrap_or_default(),
            endpoints: Mutex::new(HashMap::new()),
            unknown: Mutex::new(HashMap::new()),
            announcements: Arc::new(tokio::sync::Semaphore::new(8)),
            coordinator,
        }
    }

    /// Set the cluster coordinator.
    pub fn set_cluster_coordinator(
        &mut self,
        coordinator: Arc<tokio::sync::Mutex<crate::p2p::cluster::ClusterPeeringCoordinator>>,
    ) {
        if let Ok(lock) = coordinator.try_lock() {
            if lock.is_clustered() {
                self.peers
                    .retain(|p| !crate::p2p::cluster::is_private_or_loopback_url(p));
            }
        }
        self.coordinator = Some(coordinator);
    }

    /// Optional cluster coordinator.
    pub fn cluster_coordinator(
        &self,
    ) -> Option<&Arc<tokio::sync::Mutex<crate::p2p::cluster::ClusterPeeringCoordinator>>> {
        self.coordinator.as_ref()
    }

    /// Check whether an inbound federation request violates anti-self-peering rules.
    pub async fn check_inbound_federation(
        &self,
        headers: &axum::http::HeaderMap,
    ) -> Result<(), crate::p2p::cluster::ClusterError> {
        if let Some(coord) = &self.coordinator {
            let lock = coord.lock().await;
            lock.validate_inbound_federation(headers)?;
        }
        Ok(())
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
    /// Offer one signed record to this relay's own directory. Every record is verified there.
    async fn admit(runtime: &DirectoryRuntime, network: &str, subject: &str, record: Vec<u8>) {
        for _ in 0..50 {
            match runtime.reserve(network, subject) {
                Ok(slot) => {
                    let _ = runtime.submit(slot, Operation::Put(record)).wait().await;
                    return;
                }
                Err(RuntimeError::Busy) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(_) => return,
            }
        }
    }
    /// This relay's own retained records for `subject`, oldest first.
    async fn own_chain(runtime: &DirectoryRuntime, network: &str, subject: &str) -> Vec<Vec<u8>> {
        let Ok(slot) = runtime.reserve(network, subject) else {
            return vec![];
        };
        match runtime.submit(slot, Operation::Chain).wait().await {
            Ok(evidence) => records(&evidence.attestation),
            Err(_) => vec![],
        }
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
        for record in records(&chain) {
            Self::admit(runtime, network, subject, record).await;
        }
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
        for peer in &self.peers {
            if let Some(coord) = &self.coordinator {
                let lock = coord.lock().await;
                if lock.validate_peer_url(peer).is_err() {
                    continue;
                }
            }
            if let Some(response) = self.fetch(join(peer, "/relay/v1/info")).await {
                let info = Self::body(response, 16 * 1024)
                    .await
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                if let Some(info) = &info {
                    if let Some(coord) = &self.coordinator {
                        let lock = coord.lock().await;
                        let peer_cluster_id = info["clusterId"]
                            .as_str()
                            .and_then(|s| uuid::Uuid::parse_str(s).ok());
                        let peer_authority = info["clusterAuthorityPubkey"]
                            .as_str()
                            .and_then(|s| hex::decode(s).ok())
                            .and_then(|b| <[u8; 33]>::try_from(b).ok());
                        let peer_node_key = info["relayKey"]
                            .as_str()
                            .and_then(|s| hex::decode(s).ok())
                            .and_then(|b| <[u8; 33]>::try_from(b).ok());

                        if lock.is_self_peering(
                            peer_authority.as_ref(),
                            peer_cluster_id.as_ref(),
                            peer_node_key.as_ref(),
                        ) {
                            // Intra-cluster self-peering suppression: do not peer or sync with siblings
                            continue;
                        }
                    }
                    if let Some(endpoint) = info["endpoint"].as_str() {
                        self.endpoints
                            .lock()
                            .unwrap()
                            .insert(endpoint.to_owned(), peer.clone());
                    }
                }
            }
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
                    let behind = ours
                        .as_ref()
                        .is_none_or(|ours| theirs.1 > ours.1 || (theirs.2 && !ours.2));
                    if behind {
                        self.pull(runtime, peer, &network, subject).await;
                    } else {
                        // This relay holds more of the chain (or a fork proof) than the peer.
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
    fn target(&self, endpoint: &str) -> Option<Url> {
        if let Some(peer) = self.endpoints.lock().unwrap().get(endpoint) {
            return Some(peer.clone());
        }
        public_endpoint(endpoint)
    }
    /// Try once to hand a retained message to the recipient's relay. Returns what the sender
    /// should be told now: the recipient relay's own answer, or "retained".
    pub(crate) async fn forward(
        self: &Arc<Self>,
        runtime: &DirectoryRuntime,
        identity: &[u8; 32],
    ) -> Option<(u16, String)> {
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
        let give_up = |row: &mut ForwardRow| {
            row.done = true;
            row.status = 200;
            row.response = serde_json::json!({"version":1,"phase":"dead","identity":row.echo,
                "reason":"undeliverable"})
            .to_string();
        };
        let now = now_ms();
        let target = self.target(&row.endpoint);
        let body = registry
            .directory_subjects()
            .ok()?
            .forward_body(identity)
            .ok()?;
        let (Some(target), Some(body), true) = (
            target,
            body,
            now.saturating_sub(row.created_ms) < FORWARD_LIFETIME_MS,
        ) else {
            give_up(&mut row);
            save(&row)?;
            return Some((row.status, row.response));
        };
        // The recipient's relay must know the sender's entry to verify the message. Offer it
        // the sender's signed chain; it verifies every record like any other publication.
        if row.attempts == 0 || row.status == 503 {
            for record in Self::own_chain(runtime, &row.network, &row.sender).await {
                let _ = self
                    .client
                    .put(join(
                        &target,
                        &format!("/directory/v1/{}/{}/head", row.network, row.sender),
                    ))
                    .header("content-type", MEDIA)
                    .header(REPLICA_HEADER, "1")
                    .body(record)
                    .send()
                    .await;
            }
        }
        let answer = match self
            .client
            .put(join(&target, "/message/monad/cbor"))
            .header("content-type", &row.content_type)
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_public_https_origins_are_contacted_without_being_a_configured_peer() {
        for refused in [
            "http://relay.example.org",
            "https://localhost",
            "https://127.0.0.1:8443",
            "https://10.1.2.3",
            "https://192.168.0.4",
            "https://169.254.169.254",
            "https://[::1]",
            "https://[fd00::1]",
            "https://user:pass@relay.example.org",
            "https://intranet",
        ] {
            assert!(public_endpoint(refused).is_none(), "{refused}");
        }
        assert!(public_endpoint("https://relay.example.org").is_some());
        assert!(public_endpoint("https://203.0.113.9:8443").is_some());
    }

    #[tokio::test]
    async fn test_federation_anti_self_peering_and_private_ip_isolation() {
        use crate::p2p::cluster::{ClusterError, ClusterPeeringCoordinator};
        use crate::p2p::descriptor::ClusterRelayDescriptor;
        use axum::http::{HeaderMap, HeaderValue};
        use bitcoinsuite_core::ecc::Ecc;
        use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
        use rand::RngCore;
        use uuid::Uuid;

        let ecc = EccSecp256k1::default();
        let mut rng = rand::thread_rng();
        let mut key_bytes = [0u8; 32];
        rng.fill_bytes(&mut key_bytes);
        let auth_sec = ecc.seckey_from_array(key_bytes).unwrap();
        let auth_pub = ecc.derive_pubkey(&auth_sec).array();
        let cluster_id = Uuid::new_v4();

        let descriptor = ClusterRelayDescriptor::sign(
            &auth_sec,
            auth_pub,
            cluster_id,
            "my-cluster.org".to_string(),
            vec![Url::parse("https://my-relay.org").unwrap()],
            1700086400,
        );

        let coordinator = Arc::new(tokio::sync::Mutex::new(
            ClusterPeeringCoordinator::new_clustered(descriptor, None, 1),
        ));

        // Clustered federation filters out private and loopback configured peers
        let input_peers = vec![
            Url::parse("https://127.0.0.1:8443").unwrap(),
            Url::parse("http://localhost:8080").unwrap(),
            Url::parse("https://10.1.2.3").unwrap(),
            Url::parse("https://peer.example.org").unwrap(),
        ];

        let federation =
            Federation::new_with_coordinator(input_peers, false, Some(coordinator.clone()));

        assert_eq!(federation.peers.len(), 1);
        assert_eq!(federation.peers[0].as_str(), "https://peer.example.org/");

        // Inbound federation self-peering rejection
        let mut self_headers = HeaderMap::new();
        self_headers.insert(
            "x-frank-cluster-id",
            HeaderValue::from_str(&cluster_id.to_string()).unwrap(),
        );
        self_headers.insert(
            "x-frank-cluster-authority",
            HeaderValue::from_str(&hex::encode(auth_pub)).unwrap(),
        );

        assert_eq!(
            federation.check_inbound_federation(&self_headers).await,
            Err(ClusterError::SelfPeeringRejected)
        );

        // Inbound federation from foreign cluster
        let foreign_cluster_id = Uuid::new_v4();
        let foreign_auth_pub = [0x05; 33];
        let mut foreign_headers = HeaderMap::new();
        foreign_headers.insert(
            "x-frank-cluster-id",
            HeaderValue::from_str(&foreign_cluster_id.to_string()).unwrap(),
        );
        foreign_headers.insert(
            "x-frank-cluster-authority",
            HeaderValue::from_str(&hex::encode(foreign_auth_pub)).unwrap(),
        );

        assert!(federation
            .check_inbound_federation(&foreign_headers)
            .await
            .is_ok());
    }
}
