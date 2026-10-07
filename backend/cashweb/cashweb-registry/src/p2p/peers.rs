//! Module containing [`Peers`].

use std::{cmp::Ordering, time::Duration};

use bitcoinsuite_core::{LotusAddress, Script, ShaRmd160, LOTUS_PREFIX};
use bitcoinsuite_error::Result;
use cashweb_payload::payload::SignedPayload;
use futures::{FutureExt, StreamExt};
use rand::Rng;
use url::Url;

use crate::{
    http::server::{PutMessageRequest, PutMetadataRequest},
    p2p::{peer::Peer, public_store::PublicFederationStore, relay_info::RelayInfo},
    proto,
    registry::RegistryError,
    store::pubkeyhash::PubKeyHash,
};

/// Peers the Cashweb registry is connected to.
#[derive(Debug)]
pub struct Peers {
    client: reqwest::Client,
    own_origin: String,
    public_relay_urls: Vec<Url>,
    /// List of [`Peer`] instances connected to the registry server.
    pub peers: Vec<Peer>,
    /// Optional coordinator enforcing anti-self-peering and foreign cluster anti-swarm deduplication.
    pub cluster_coordinator:
        Option<std::sync::Arc<tokio::sync::Mutex<crate::p2p::cluster::ClusterPeeringCoordinator>>>,
}

impl Peers {
    /// Create [`Peers`] from a fixed list of peers.
    pub fn new(own_origin: String, peers: Vec<Peer>) -> Self {
        Self::new_with_public_relays(own_origin, peers, Vec::new())
    }

    /// Create peers with a separate, explicit client-facing relay allowlist.
    pub fn new_with_public_relays(
        own_origin: String,
        peers: Vec<Peer>,
        public_relay_urls: Vec<Url>,
    ) -> Self {
        Peers {
            client: reqwest::Client::new(),
            own_origin,
            public_relay_urls,
            peers,
            cluster_coordinator: None,
        }
    }

    /// Configure the cluster peering coordinator.
    pub fn set_cluster_coordinator(
        &mut self,
        coordinator: crate::p2p::cluster::ClusterPeeringCoordinator,
    ) {
        self.cluster_coordinator = Some(std::sync::Arc::new(tokio::sync::Mutex::new(coordinator)));
    }

    /// Validate whether a candidate peer attestation is permitted under cluster rules.
    pub async fn validate_peer_cluster(
        &self,
        attestation: &crate::p2p::cluster::NodeClusterAttestation,
        now_seconds: u64,
    ) -> Result<(), crate::p2p::cluster::ClusterError> {
        if let Some(coord) = &self.cluster_coordinator {
            let lock = coord.lock().await;
            lock.validate_peer_attestation(attestation, now_seconds)?;
        }
        Ok(())
    }

    /// Validate candidate peer credentials and endpoint URL.
    pub async fn validate_peer_candidate(
        &self,
        candidate_url: Option<&Url>,
        candidate_authority: Option<&[u8; 33]>,
        candidate_cluster_id: Option<&uuid::Uuid>,
        candidate_node_pubkey: Option<&[u8; 33]>,
    ) -> Result<(), crate::p2p::cluster::ClusterError> {
        if let Some(coord) = &self.cluster_coordinator {
            let lock = coord.lock().await;
            lock.validate_peer_candidate(
                candidate_url,
                candidate_authority,
                candidate_cluster_id,
                candidate_node_pubkey,
            )?;
        }
        Ok(())
    }

    /// Record a peer connected under its cluster attestation.
    pub async fn record_peer_connected(
        &self,
        attestation: &crate::p2p::cluster::NodeClusterAttestation,
        now_seconds: u64,
    ) -> Result<(), crate::p2p::cluster::ClusterError> {
        if let Some(coord) = &self.cluster_coordinator {
            let mut lock = coord.lock().await;
            lock.record_peer_connected(attestation, now_seconds)?;
        }
        Ok(())
    }

    /// Record a peer disconnected, decrementing active count for its cluster authority.
    pub async fn record_peer_disconnected(&self, cluster_authority_pubkey: &[u8; 33]) {
        if let Some(coord) = &self.cluster_coordinator {
            let mut lock = coord.lock().await;
            lock.record_peer_disconnected(cluster_authority_pubkey);
        }
    }

    /// Public relay origins a client may independently try for reads or transaction broadcast.
    pub fn public_origins(&self) -> Vec<String> {
        let mut origins = std::iter::once(self.own_origin.parse::<Url>().ok())
            .chain(self.public_relay_urls.iter().cloned().map(Some))
            .flatten()
            .filter_map(public_http_origin)
            .collect::<Vec<_>>();
        if let Some(coord) = &self.cluster_coordinator {
            if let Ok(lock) = coord.try_lock() {
                if let Some(desc) = lock.my_descriptor() {
                    for ep in &desc.public_endpoints {
                        if let Some(origin) = public_http_origin(ep.clone()) {
                            origins.push(origin);
                        }
                    }
                }
            }
        }
        origins.sort();
        origins.dedup();
        origins
    }

    /// Relay the metadata to all the peers.
    /// It will not forward to peers that (probably) already know the payload,
    /// or across intra-cluster nodes sharing the same cluster authority.
    pub async fn relay_metadata(
        &self,
        relay_info: &RelayInfo,
        request: &PutMetadataRequest,
        signed_metadata: &SignedPayload<proto::AddressMetadata>,
    ) {
        if let Some(coord) = &self.cluster_coordinator {
            let lock = coord.lock().await;
            if relay_info.is_same_cluster(
                lock.cluster_authority_pubkey().as_ref(),
                lock.cluster_id().as_ref(),
            ) {
                // Intra-cluster self-peering suppression: do not re-broadcast over public P2P
                return;
            }
        }
        futures::future::join_all(self.peers.iter().map(|peer| {
            peer.relay_metadata_to(
                relay_info,
                request,
                signed_metadata,
                &self.own_origin,
                &self.client,
            )
        }))
        .await;
    }

    /// Relay the message to all the peers.
    /// It will not forward to peers that (probably) already know the payload,
    /// or across intra-cluster nodes sharing the same cluster authority.
    pub async fn relay_message(&self, relay_info: &RelayInfo, request: &PutMessageRequest) {
        if let Some(coord) = &self.cluster_coordinator {
            let lock = coord.lock().await;
            if relay_info.is_same_cluster(
                lock.cluster_authority_pubkey().as_ref(),
                lock.cluster_id().as_ref(),
            ) {
                // Intra-cluster self-peering suppression: do not re-broadcast over public P2P
                return;
            }
        }
        futures::future::join_all(self.peers.iter().map(|peer| {
            peer.relay_message_to(relay_info, request, &self.own_origin, &self.client)
        }))
        .await;
    }
}

fn public_http_origin(url: Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

#[cfg(test)]
mod public_origin_tests {
    use super::*;

    #[test]
    fn discovery_exposes_only_deduplicated_http_origins() {
        let peers = Peers::new(
            "https://owner:secret@example.test/private?token=hidden#fragment".to_string(),
            vec![Peer::new(
                "https://internal.service.local/sync".parse().unwrap(),
            )],
        );
        let peers = Peers::new_with_public_relays(
            peers.own_origin,
            peers.peers,
            vec![
                "https://other:password@peer.test:8443/internal?key=secret"
                    .parse()
                    .unwrap(),
                "https://example.test/another-path".parse().unwrap(),
                "file:///private/relay".parse().unwrap(),
            ],
        );

        assert_eq!(
            peers.public_origins(),
            vec![
                "https://example.test".to_string(),
                "https://peer.test:8443".to_string(),
            ]
        );
        assert!(!peers
            .public_origins()
            .iter()
            .any(|origin| origin.contains("internal.service.local")));
    }

    #[tokio::test]
    async fn test_peers_cluster_peering_coordination() {
        use crate::p2p::cluster::{
            ClusterError, ClusterPeeringCoordinator, NodeClusterAttestation,
        };
        use bitcoinsuite_core::ecc::Ecc;
        use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
        use rand::RngCore;
        use uuid::Uuid;

        let ecc = EccSecp256k1::default();
        let mut rng = rand::thread_rng();

        let mut gen_key = || {
            let mut b = [0u8; 32];
            rng.fill_bytes(&mut b);
            let sec = ecc.seckey_from_array(b).unwrap();
            let pubk = ecc.derive_pubkey(&sec);
            (sec, pubk.array())
        };

        let (my_auth_sec, my_auth_pub) = gen_key();
        let (_my_node_sec, my_node_pub) = gen_key();
        let my_cluster_id = Uuid::new_v4();
        let now = 1700000000;

        let my_attestation = NodeClusterAttestation::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            "cluster-a.frank.org".to_string(),
            my_node_pub,
            now + 3600,
        );

        let mut peers = Peers::new("https://relay-1.frank.org".to_string(), vec![]);
        peers.set_cluster_coordinator(ClusterPeeringCoordinator::new(Some(my_attestation), 1));

        // Sibling node from same cluster: rejected
        let (_sib_sec, sib_pub) = gen_key();
        let sibling_attestation = NodeClusterAttestation::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            "cluster-a.frank.org".to_string(),
            sib_pub,
            now + 3600,
        );
        assert_eq!(
            peers.validate_peer_cluster(&sibling_attestation, now).await,
            Err(ClusterError::SelfPeeringRejected)
        );

        // Foreign cluster B: node 1 connects
        let (b_auth_sec, b_auth_pub) = gen_key();
        let b_cluster_id = Uuid::new_v4();
        let (_b1_sec, b1_pub) = gen_key();
        let b1_attestation = NodeClusterAttestation::sign(
            &b_auth_sec,
            b_auth_pub,
            b_cluster_id,
            "cluster-b.remote.org".to_string(),
            b1_pub,
            now + 3600,
        );

        assert!(peers
            .validate_peer_cluster(&b1_attestation, now)
            .await
            .is_ok());
        peers
            .record_peer_connected(&b1_attestation, now)
            .await
            .unwrap();

        // Foreign cluster B: node 2 rejected due to anti-swarm limit (max 1)
        let (_b2_sec, b2_pub) = gen_key();
        let b2_attestation = NodeClusterAttestation::sign(
            &b_auth_sec,
            b_auth_pub,
            b_cluster_id,
            "cluster-b.remote.org".to_string(),
            b2_pub,
            now + 3600,
        );
        assert_eq!(
            peers.validate_peer_cluster(&b2_attestation, now).await,
            Err(ClusterError::ClusterAlreadyConnected)
        );

        // Disconnect node 1 -> node 2 can now connect
        peers.record_peer_disconnected(&b_auth_pub).await;
        assert!(peers
            .validate_peer_cluster(&b2_attestation, now)
            .await
            .is_ok());

        // Test validate_peer_candidate anti-self-peering checks
        let loopback_url = "http://127.0.0.1:8080".parse::<Url>().unwrap();
        let private_url = "https://10.0.1.5:8443".parse::<Url>().unwrap();
        let public_url = "https://public.relay-b.org".parse::<Url>().unwrap();

        // In clustered mode, loopback/private candidate URLs are rejected
        assert_eq!(
            peers
                .validate_peer_candidate(
                    Some(&loopback_url),
                    Some(&b_auth_pub),
                    Some(&b_cluster_id),
                    Some(&b2_pub)
                )
                .await,
            Err(ClusterError::PrivateIpRejected(loopback_url.to_string()))
        );
        assert_eq!(
            peers
                .validate_peer_candidate(
                    Some(&private_url),
                    Some(&b_auth_pub),
                    Some(&b_cluster_id),
                    Some(&b2_pub)
                )
                .await,
            Err(ClusterError::PrivateIpRejected(private_url.to_string()))
        );

        // Candidate presenting our own cluster authority: rejected
        assert_eq!(
            peers
                .validate_peer_candidate(
                    Some(&public_url),
                    Some(&my_auth_pub),
                    Some(&b_cluster_id),
                    Some(&b2_pub)
                )
                .await,
            Err(ClusterError::SelfPeeringRejected)
        );

        // Candidate presenting our own cluster ID: rejected
        assert_eq!(
            peers
                .validate_peer_candidate(
                    Some(&public_url),
                    Some(&b_auth_pub),
                    Some(&my_cluster_id),
                    Some(&b2_pub)
                )
                .await,
            Err(ClusterError::SelfPeeringRejected)
        );

        // Candidate presenting our known node pubkey: rejected
        assert_eq!(
            peers
                .validate_peer_candidate(
                    Some(&public_url),
                    Some(&b_auth_pub),
                    Some(&b_cluster_id),
                    Some(&my_node_pub)
                )
                .await,
            Err(ClusterError::SelfPeeringRejected)
        );

        // Valid foreign public candidate: accepted
        assert!(peers
            .validate_peer_candidate(
                Some(&public_url),
                Some(&b_auth_pub),
                Some(&b_cluster_id),
                Some(&b2_pub)
            )
            .await
            .is_ok());

        // Test cluster descriptor exposes public ingress endpoints in public_origins()
        let cluster_endpoints = vec![
            Url::parse("https://cluster-ingress-1.frank.org").unwrap(),
            Url::parse("https://cluster-ingress-2.frank.org").unwrap(),
        ];
        let descriptor = crate::p2p::descriptor::ClusterRelayDescriptor::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            "cluster-a.frank.org".to_string(),
            cluster_endpoints.clone(),
            now + 86400,
        );

        let mut clustered_coord = ClusterPeeringCoordinator::new_clustered(descriptor, None, 1);
        clustered_coord.add_known_node_pubkey(my_node_pub);
        peers.set_cluster_coordinator(clustered_coord);

        let public_origins = peers.public_origins();
        assert!(public_origins.contains(&"https://cluster-ingress-1.frank.org".to_string()));
        assert!(public_origins.contains(&"https://cluster-ingress-2.frank.org".to_string()));

        // Test pick_sample_peers suppresses sibling cluster nodes and private/loopback URLs
        let sibling_peer = Peer::with_cluster_attestation(
            "https://sibling-node.frank.org".parse().unwrap(),
            sibling_attestation,
        );
        let loopback_peer = Peer::new("http://127.0.0.1:8080".parse().unwrap());
        let foreign_peer = Peer::with_cluster_attestation(
            "https://remote-valid.org".parse().unwrap(),
            b1_attestation,
        );

        let mut crawl_peers = Peers::new(
            "https://local.frank.org".to_string(),
            vec![sibling_peer, loopback_peer, foreign_peer],
        );
        crawl_peers.set_cluster_coordinator(ClusterPeeringCoordinator::new_clustered(
            crate::p2p::descriptor::ClusterRelayDescriptor::sign(
                &my_auth_sec,
                my_auth_pub,
                my_cluster_id,
                "cluster-a.frank.org".to_string(),
                vec![Url::parse("https://ingress.frank.org").unwrap()],
                now + 86400,
            ),
            None,
            2,
        ));

        let sampled = crawl_peers.pick_sample_peers(&mut rng, 10);
        // Only the foreign public peer should be sampled; sibling and loopback must be suppressed
        assert_eq!(sampled.len(), 1);
        assert_eq!(sampled[0].url().as_str(), "https://remote-valid.org/");
    }
}

/// Params for how and where to download metadata from peers
#[derive(Debug)]
pub struct InitialMetadataDownloadParams<'a> {
    /// Public-only capability to download records into.
    pub public_store: PublicFederationStore<'a>,
    /// How many peers will be sampled each round when syncing
    pub num_sampled_peers: usize,
    /// When we stop waiting for a peer to respond
    pub timeout_peer: Duration,
    /// How many failed rounds (rounds with no successful results at all)
    /// of querying peers we do before we wait some time
    pub num_failed_for_wait: usize,
    /// How long we wait after N rounds failed
    pub fail_wait_duration: Duration,
}

impl Peers {
    /// Download initial metadata from peers.
    pub async fn initial_metadata_download(
        &self,
        rng: &mut impl Rng,
        params: &InitialMetadataDownloadParams<'_>,
    ) -> Result<()> {
        // Get the last timestamp and address from the registry
        let (mut timestamp, mut address) = params
            .public_store
            .latest_legacy_directory_entry()?
            .unwrap_or_else(|| {
                let zero_pkh_script = Script::p2pkh(&ShaRmd160::new([0; 20]));
                let zero_pkh = LotusAddress::new(
                    LOTUS_PREFIX,
                    params.public_store.legacy_network(),
                    zero_pkh_script,
                );
                (0, zero_pkh)
            });
        // Exit already if there's no peers
        if self.peers.is_empty() {
            println!("No peers to sync from");
            return Ok(());
        }
        // How many rounds all peers failed (timeout/error)
        let mut num_failed_rounds = 0;
        loop {
            // Select a few peers to poll
            let sample_peers = self.pick_sample_peers(rng, params.num_sampled_peers);
            // The function gives us some stats on what happened
            let result = self
                .fetch_sample_peers(params, &sample_peers, &mut timestamp, &mut address)
                .await;
            match result {
                FetchSamplePeersResult::FinishedImd => return Ok(()),
                FetchSamplePeersResult::InProgress {
                    num_timeouts,
                    num_failed_fetches,
                    num_failed_entries,
                    num_outdated_entries,
                    num_successful_entries,
                } => {
                    println!(
                        "Fetched metadata: successes={}, timeouts={}, failed fetches={}, \
                         failed entries={}, outdated entries={}",
                        num_successful_entries,
                        num_timeouts,
                        num_failed_fetches,
                        num_failed_entries,
                        num_outdated_entries,
                    );
                    if num_successful_entries == 0 {
                        num_failed_rounds += 1;
                    } else {
                        num_failed_rounds = 0;
                    }
                    if num_failed_rounds >= params.num_failed_for_wait {
                        println!(
                            "Failed {} times in a row, waiting for {} seconds",
                            num_failed_rounds,
                            params.fail_wait_duration.as_secs_f64(),
                        );
                        num_failed_rounds = 0;
                        tokio::time::sleep(params.fail_wait_duration).await;
                    }
                }
            }
        }
    }

    fn pick_sample_peers(&self, rng: &mut impl Rng, num_sampled_peers: usize) -> Vec<&Peer> {
        let mut available_peers = self.peers.iter().collect::<Vec<_>>();
        if let Some(coord) = &self.cluster_coordinator {
            if let Ok(lock) = coord.try_lock() {
                available_peers.retain(|peer| {
                    if lock.validate_peer_url(peer.url()).is_err() {
                        return false;
                    }
                    if let Ok(state) = peer.state.try_lock() {
                        if let Some(att) = &state.cluster_attestation {
                            if lock.is_self_peering(
                                Some(&att.cluster_authority_pubkey),
                                Some(&att.cluster_id),
                                Some(&att.node_pubkey),
                            ) {
                                return false;
                            }
                        }
                    }
                    true
                });
            }
        }
        let mut sample_peers = Vec::with_capacity(num_sampled_peers);
        for _ in 0..num_sampled_peers {
            if available_peers.is_empty() {
                return sample_peers;
            }
            let idx = rng.gen_range(0..available_peers.len());
            let peer = available_peers.swap_remove(idx);
            sample_peers.push(peer);
        }
        sample_peers
    }
}

enum FetchSamplePeersResult {
    FinishedImd,
    InProgress {
        num_timeouts: usize,
        num_failed_fetches: usize,
        num_failed_entries: usize,
        num_outdated_entries: usize,
        num_successful_entries: usize,
    },
}

impl Peers {
    async fn fetch_sample_peers(
        &self,
        params: &InitialMetadataDownloadParams<'_>,
        sample_peers: &[&Peer],
        last_timestamp: &mut i64,
        last_address: &mut LotusAddress,
    ) -> FetchSamplePeersResult {
        let last_address_clone = last_address.clone();
        let streams = sample_peers.iter().map(|&peer| {
            Box::pin(
                peer.fetch_range_since(*last_timestamp, &last_address_clone, &self.client)
                    .map(move |result| (peer, result))
                    .into_stream(),
            )
        });
        let mut results = futures::stream::select_all(streams);
        let mut num_timeouts = 0;
        let mut num_failed_fetches = 0;
        let mut num_failed_entries = 0;
        let mut num_outdated_entries = 0;
        let mut num_successful_entries = 0;
        let mut is_all_empty = true;
        for _ in sample_peers.iter() {
            let result = tokio::time::timeout(params.timeout_peer, results.next()).await;
            let (peer, result) = match result {
                Ok(result) => result.expect("should always have enough items"),
                Err(elapsed) => {
                    print!(
                        "ERROR: All peers timed out after {} (polled {:?})",
                        elapsed,
                        sample_peers
                            .iter()
                            .map(|peer| peer.url())
                            .collect::<Vec<_>>()
                    );
                    num_timeouts += 1;
                    continue;
                }
            };
            let entries = match result {
                Ok(entries) => entries,
                Err(fetch_err) => {
                    println!("Fetch failed for peer {}: {:?}", peer.url(), fetch_err);
                    num_failed_fetches += 1;
                    continue;
                }
            };
            if !entries.is_empty() {
                println!("Fetched {} entries from {}", entries.len(), peer.url());
            }
            for (address, signed_metadata) in entries {
                if signed_metadata.payload().is_none() {
                    continue;
                }
                let signed_payload = signed_metadata.payload().as_ref().unwrap();
                is_all_empty = false;
                let mut peer_state = peer.state.lock().await;
                match params
                    .public_store
                    .apply_legacy_directory_entry(&address, &signed_metadata)
                    .await
                {
                    Ok(_result) => peer_state.last_error = None,
                    Err(err) => {
                        if let Some(RegistryError::TimestampNotMonotonicallyIncreasing { .. }) =
                            err.downcast_ref::<RegistryError>()
                        {
                            num_outdated_entries += 1;
                        } else {
                            peer_state.last_error = Some(err);
                            num_failed_entries += 1;
                        }
                        continue;
                    }
                }
                match signed_payload.timestamp.cmp(last_timestamp) {
                    Ordering::Less => {}
                    Ordering::Equal => {
                        let last_pkh =
                            PubKeyHash::from_address(last_address, last_address.net()).unwrap();
                        let pkh = PubKeyHash::from_address(&address, address.net()).unwrap();
                        if last_pkh.to_storage_bytes() < pkh.to_storage_bytes() {
                            *last_address = address;
                        }
                    }
                    Ordering::Greater => {
                        *last_timestamp = signed_payload.timestamp;
                        *last_address = address;
                    }
                }
                num_successful_entries += 1;
            }
        }
        if is_all_empty {
            FetchSamplePeersResult::FinishedImd
        } else {
            FetchSamplePeersResult::InProgress {
                num_timeouts,
                num_failed_fetches,
                num_failed_entries,
                num_outdated_entries,
                num_successful_entries,
            }
        }
    }
}
