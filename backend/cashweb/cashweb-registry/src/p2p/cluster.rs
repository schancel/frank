//! Signed cluster authority attestations and anti-swarm peering deduplication (Issue #1007).
//!
//! To prevent cluster nodes from accidentally federating with each other over public P2P protocols
//! (intra-cluster self-peering) and to deduplicate connections to foreign clusters so that a relay
//! connects to at most 1–2 nodes of any given remote cluster (anti-swarm).

use std::collections::{HashMap, HashSet};

use bitcoinsuite_core::{
    ecc::{Ecc, PubKey, SecKey},
    ByteArray, Bytes, Hashed, Sha256,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::ErrorMeta;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Domain separator prefix for cluster attestation signing preimage.
pub const CLUSTER_ATTESTATION_DOMAIN_PREFIX: &[u8] = b"FRANK_CLUSTER_ATTESTATION_V1";

/// Default maximum active peer connections allowed to nodes sharing the same cluster authority.
pub const DEFAULT_MAX_PEERS_PER_CLUSTER: usize = 1;

pub(crate) mod serde_bytes_33 {
    use serde::{Deserializer, Serializer};

    pub(crate) fn serialize<S>(bytes: &[u8; 33], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if serializer.is_human_readable() {
            serializer.serialize_str(&hex::encode(bytes))
        } else {
            serializer.serialize_bytes(bytes)
        }
    }

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 33], D::Error>
    where
        D: Deserializer<'de>,
    {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = [u8; 33];

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a 33-byte compressed pubkey (hex string or byte sequence)")
            }

            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                let bytes = hex::decode(v).map_err(E::custom)?;
                bytes
                    .try_into()
                    .map_err(|_| E::custom("expected 33 bytes for compressed pubkey"))
            }

            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                v.try_into()
                    .map_err(|_| E::custom("expected 33 bytes for compressed pubkey"))
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut arr = [0u8; 33];
                for i in 0..33 {
                    arr[i] = seq.next_element()?.ok_or_else(|| {
                        serde::de::Error::custom("expected 33 elements in sequence")
                    })?;
                }
                if seq.next_element::<u8>()?.is_some() {
                    return Err(serde::de::Error::custom("expected exactly 33 elements"));
                }
                Ok(arr)
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

/// Errors verifying cluster attestations or evaluating peering eligibility.
#[derive(Debug, Error, ErrorMeta, PartialEq, Eq, Clone)]
pub enum ClusterError {
    /// Peer belongs to our own cluster (intra-cluster self-peering rejected).
    #[invalid_client_input()]
    #[error("Peer belongs to our own cluster (intra-cluster self-peering rejected)")]
    SelfPeeringRejected,

    /// Peer's cluster already has the maximum permitted active connections (anti-swarm).
    #[invalid_client_input()]
    #[error("Cluster already connected (anti-swarm limit exceeded)")]
    ClusterAlreadyConnected,

    /// Cluster attestation has expired.
    #[invalid_client_input()]
    #[error("Cluster attestation expired at {0}, current time {1}")]
    AttestationExpired(u64, u64),

    /// Cluster attestation signature verification failed.
    #[invalid_client_input()]
    #[error("Cluster authority signature verification failed")]
    InvalidSignature,

    /// Cluster attestation domain mismatch.
    #[invalid_client_input()]
    #[error("Cluster attestation domain mismatch: expected {0}, got {1}")]
    DomainMismatch(String, String),

    /// Cluster descriptor has no public endpoints.
    #[invalid_client_input()]
    #[error("Cluster descriptor has no public endpoints")]
    EmptyEndpoints,

    /// Candidate peer IP is private or loopback, which is rejected in clustered mode.
    #[invalid_client_input()]
    #[error("Candidate peer IP {0} is private or loopback, rejected in clustered mode")]
    PrivateIpRejected(String),

    /// Outbound bundle forwarding job is already claimed by another cluster worker.
    #[invalid_client_input()]
    #[error("Outbound bundle forwarding {0} already claimed by another cluster worker")]
    AlreadyClaimed(String),

    /// Outbound bundle forwarding failed.
    #[invalid_client_input()]
    #[error("Outbound bundle forwarding failed: {0}")]
    ForwardingFailed(String),
}

/// Signed cluster authority attestation proving that a node belongs to a given cluster.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeClusterAttestation {
    /// 33-byte compressed public key of the Domain Authority Key.
    #[serde(with = "serde_bytes_33")]
    pub cluster_authority_pubkey: [u8; 33],
    /// Stable UUID of the cluster.
    pub cluster_id: Uuid,
    /// Human-readable domain name (e.g. "example.com").
    pub domain: String,
    /// 33-byte compressed public key of the specific cluster node.
    #[serde(with = "serde_bytes_33")]
    pub node_pubkey: [u8; 33],
    /// Expiration timestamp in seconds since Unix epoch.
    pub valid_until: u64,
    /// Cryptographic signature of the attestation fields by `cluster_authority_pubkey`.
    pub authority_signature: Vec<u8>,
}

impl NodeClusterAttestation {
    /// Compute the commit digest from components.
    pub fn compute_digest(
        cluster_authority_pubkey: &[u8; 33],
        cluster_id: &Uuid,
        domain: &str,
        node_pubkey: &[u8; 33],
        valid_until: u64,
    ) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(CLUSTER_ATTESTATION_DOMAIN_PREFIX);
        data.extend_from_slice(cluster_authority_pubkey);
        data.extend_from_slice(cluster_id.as_bytes());
        data.extend_from_slice(&(domain.len() as u32).to_be_bytes());
        data.extend_from_slice(domain.as_bytes());
        data.extend_from_slice(node_pubkey);
        data.extend_from_slice(&valid_until.to_be_bytes());
        Sha256::digest(data.into()).byte_array().array()
    }

    /// Compute the SHA-256 digest committed to by the authority signature.
    pub fn digest(&self) -> [u8; 32] {
        Self::compute_digest(
            &self.cluster_authority_pubkey,
            &self.cluster_id,
            &self.domain,
            &self.node_pubkey,
            self.valid_until,
        )
    }

    /// Sign and construct a `NodeClusterAttestation` using the cluster authority private key.
    pub fn sign(
        cluster_authority_seckey: &SecKey,
        cluster_authority_pubkey: [u8; 33],
        cluster_id: Uuid,
        domain: String,
        node_pubkey: [u8; 33],
        valid_until: u64,
    ) -> Self {
        let ecc = EccSecp256k1::default();
        let digest = Self::compute_digest(
            &cluster_authority_pubkey,
            &cluster_id,
            &domain,
            &node_pubkey,
            valid_until,
        );
        let sig = ecc.sign(cluster_authority_seckey, ByteArray::new(digest));
        Self {
            cluster_authority_pubkey,
            cluster_id,
            domain,
            node_pubkey,
            valid_until,
            authority_signature: sig.as_ref().to_vec(),
        }
    }

    /// Verify the signature and expiration against the current timestamp.
    pub fn verify(&self, now_seconds: u64) -> Result<(), ClusterError> {
        if now_seconds > self.valid_until {
            return Err(ClusterError::AttestationExpired(
                self.valid_until,
                now_seconds,
            ));
        }
        let ecc = EccSecp256k1::default();
        let digest = self.digest();
        let pubkey = PubKey::new_unchecked(self.cluster_authority_pubkey);
        let sig_bytes = Bytes::from(self.authority_signature.clone());
        ecc.verify(&pubkey, ByteArray::new(digest), &sig_bytes)
            .map_err(|_| ClusterError::InvalidSignature)
    }
}

/// Returns true if the URL points to a loopback, private, link-local, or unqualified local network address.
pub fn is_private_or_loopback_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let lower = name.to_ascii_lowercase();
            if lower == "localhost"
                || lower.ends_with(".localhost")
                || lower == "local"
                || lower.ends_with(".local")
                || lower == "internal"
                || lower.ends_with(".internal")
            {
                return true;
            }
            !lower.contains('.')
        }
        Some(url::Host::Ipv4(ip)) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
        }
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (ip.segments()[0] & 0xffc0) == 0xfe80 // Link-local fe80::/10
                || ip.to_ipv4_mapped().is_some_and(|ipv4| {
                    ipv4.is_loopback()
                        || ipv4.is_private()
                        || ipv4.is_link_local()
                        || ipv4.is_unspecified()
                        || ipv4.is_broadcast()
                })
        }
        None => true,
    }
}

/// Coordinator enforcing anti-self-peering and foreign cluster anti-swarm deduplication.
#[derive(Debug, Clone)]
pub struct ClusterPeeringCoordinator {
    /// Local cluster's attestation (if running in clustered mode).
    my_attestation: Option<NodeClusterAttestation>,
    /// Local cluster's unified relay descriptor.
    my_descriptor: Option<crate::p2p::descriptor::ClusterRelayDescriptor>,
    /// Cluster UUID.
    cluster_id: Option<Uuid>,
    /// Cluster Domain Authority public key.
    cluster_authority_pubkey: Option<[u8; 33]>,
    /// Known intra-cluster node public keys.
    known_node_pubkeys: HashSet<[u8; 33]>,
    /// Whether clustered mode is active.
    is_clustered: bool,
    /// Maximum permitted active peers connected to the same foreign cluster authority.
    max_peers_per_cluster: usize,
    /// Active foreign cluster peers count indexed by cluster authority public key.
    active_peers_by_cluster: HashMap<[u8; 33], usize>,
}

impl ClusterPeeringCoordinator {
    /// Create a new coordinator with an optional local node attestation and a max peers per cluster limit.
    pub fn new(
        my_attestation: Option<NodeClusterAttestation>,
        max_peers_per_cluster: usize,
    ) -> Self {
        let (cluster_id, cluster_authority_pubkey, known_node_pubkeys, is_clustered) =
            if let Some(att) = &my_attestation {
                let mut set = HashSet::new();
                set.insert(att.node_pubkey);
                (
                    Some(att.cluster_id),
                    Some(att.cluster_authority_pubkey),
                    set,
                    true,
                )
            } else {
                (None, None, HashSet::new(), false)
            };
        Self {
            my_attestation,
            my_descriptor: None,
            cluster_id,
            cluster_authority_pubkey,
            known_node_pubkeys,
            is_clustered,
            max_peers_per_cluster: max_peers_per_cluster.max(1),
            active_peers_by_cluster: HashMap::new(),
        }
    }

    /// Create a clustered coordinator configured with a cluster relay descriptor.
    pub fn new_clustered(
        descriptor: crate::p2p::descriptor::ClusterRelayDescriptor,
        my_attestation: Option<NodeClusterAttestation>,
        max_peers_per_cluster: usize,
    ) -> Self {
        let mut coord = Self::new(my_attestation, max_peers_per_cluster);
        coord = coord.with_descriptor(descriptor);
        coord
    }

    /// Set or update the cluster relay descriptor.
    pub fn with_descriptor(
        mut self,
        descriptor: crate::p2p::descriptor::ClusterRelayDescriptor,
    ) -> Self {
        self.cluster_id = Some(descriptor.cluster_id);
        self.cluster_authority_pubkey = Some(descriptor.authority_pubkey);
        self.is_clustered = true;
        self.my_descriptor = Some(descriptor);
        self
    }

    /// Set explicit cluster identity (cluster UUID and authority pubkey).
    pub fn with_cluster_identity(mut self, cluster_id: Uuid, authority_pubkey: [u8; 33]) -> Self {
        self.cluster_id = Some(cluster_id);
        self.cluster_authority_pubkey = Some(authority_pubkey);
        self.is_clustered = true;
        self
    }

    /// Add a known node public key belonging to this cluster.
    pub fn add_known_node_pubkey(&mut self, node_pubkey: [u8; 33]) {
        self.known_node_pubkeys.insert(node_pubkey);
    }

    /// Set whether clustered mode is active.
    pub fn set_clustered(&mut self, is_clustered: bool) {
        self.is_clustered = is_clustered;
    }

    /// Whether the node is operating in clustered mode.
    pub fn is_clustered(&self) -> bool {
        self.is_clustered
    }

    /// Local cluster's unified relay descriptor.
    pub fn my_descriptor(&self) -> Option<&crate::p2p::descriptor::ClusterRelayDescriptor> {
        self.my_descriptor.as_ref()
    }

    /// Cluster UUID.
    pub fn cluster_id(&self) -> Option<Uuid> {
        self.cluster_id
    }

    /// Cluster Domain Authority public key.
    pub fn cluster_authority_pubkey(&self) -> Option<[u8; 33]> {
        self.cluster_authority_pubkey
    }

    /// Local node's cluster attestation.
    pub fn my_attestation(&self) -> Option<&NodeClusterAttestation> {
        self.my_attestation.as_ref()
    }

    /// Maximum active peers allowed per foreign cluster.
    pub fn max_peers_per_cluster(&self) -> usize {
        self.max_peers_per_cluster
    }

    /// Number of active connections currently open to the given cluster authority.
    pub fn count_peers_for_cluster(&self, cluster_authority_pubkey: &[u8; 33]) -> usize {
        self.active_peers_by_cluster
            .get(cluster_authority_pubkey)
            .copied()
            .unwrap_or(0)
    }

    /// Check whether candidate credentials match this cluster's identity (intra-cluster self-peering).
    pub fn is_self_peering(
        &self,
        candidate_authority: Option<&[u8; 33]>,
        candidate_cluster_id: Option<&Uuid>,
        candidate_node_pubkey: Option<&[u8; 33]>,
    ) -> bool {
        if let Some(auth) = candidate_authority {
            if let Some(my_auth) = &self.cluster_authority_pubkey {
                if auth == my_auth {
                    return true;
                }
            }
        }
        if let Some(cid) = candidate_cluster_id {
            if let Some(my_cid) = &self.cluster_id {
                if cid == my_cid {
                    return true;
                }
            }
        }
        if let Some(npk) = candidate_node_pubkey {
            if self.known_node_pubkeys.contains(npk) {
                return true;
            }
            if let Some(my_att) = &self.my_attestation {
                if *npk == my_att.node_pubkey {
                    return true;
                }
            }
        }
        false
    }

    /// Validate a candidate peer's endpoint URL against private/loopback restrictions in clustered mode.
    pub fn validate_peer_url(&self, url: &url::Url) -> Result<(), ClusterError> {
        if self.is_clustered && is_private_or_loopback_url(url) {
            return Err(ClusterError::PrivateIpRejected(url.to_string()));
        }
        Ok(())
    }

    /// Validate a peer candidate before establishing peering or crawling.
    pub fn validate_peer_candidate(
        &self,
        candidate_url: Option<&url::Url>,
        candidate_authority: Option<&[u8; 33]>,
        candidate_cluster_id: Option<&Uuid>,
        candidate_node_pubkey: Option<&[u8; 33]>,
    ) -> Result<(), ClusterError> {
        if let Some(url) = candidate_url {
            self.validate_peer_url(url)?;
        }
        if self.is_self_peering(
            candidate_authority,
            candidate_cluster_id,
            candidate_node_pubkey,
        ) {
            return Err(ClusterError::SelfPeeringRejected);
        }
        if let Some(auth) = candidate_authority {
            if self.count_peers_for_cluster(auth) >= self.max_peers_per_cluster {
                return Err(ClusterError::ClusterAlreadyConnected);
            }
        }
        Ok(())
    }

    /// Validate inbound federation request headers to reject intra-cluster self-peering.
    pub fn validate_inbound_federation(
        &self,
        headers: &axum::http::HeaderMap,
    ) -> Result<(), ClusterError> {
        let cluster_id = headers
            .get("x-frank-cluster-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| Uuid::parse_str(s).ok());
        let cluster_authority = headers
            .get("x-frank-cluster-authority")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| hex::decode(s).ok())
            .and_then(|b| <[u8; 33]>::try_from(b).ok());
        let node_pubkey = headers
            .get("x-frank-node-pubkey")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| hex::decode(s).ok())
            .and_then(|b| <[u8; 33]>::try_from(b).ok());

        if self.is_self_peering(
            cluster_authority.as_ref(),
            cluster_id.as_ref(),
            node_pubkey.as_ref(),
        ) {
            return Err(ClusterError::SelfPeeringRejected);
        }
        Ok(())
    }

    /// Validate a candidate peer's cluster attestation during handshake.
    ///
    /// Checks:
    /// 1. Expiration and signature validity.
    /// 2. Anti-self-peering: peer must not share our cluster authority pubkey, cluster UUID, or node pubkey.
    /// 3. Anti-swarm: peer's cluster must not already have reached `max_peers_per_cluster`.
    pub fn validate_peer_attestation(
        &self,
        peer_attestation: &NodeClusterAttestation,
        now_seconds: u64,
    ) -> Result<(), ClusterError> {
        // 1. Signature and expiration check
        peer_attestation.verify(now_seconds)?;

        // 2. Intra-cluster self-peering rejection
        if self.is_self_peering(
            Some(&peer_attestation.cluster_authority_pubkey),
            Some(&peer_attestation.cluster_id),
            Some(&peer_attestation.node_pubkey),
        ) {
            return Err(ClusterError::SelfPeeringRejected);
        }

        // 3. Foreign cluster deduplication (anti-swarm)
        let current_count =
            self.count_peers_for_cluster(&peer_attestation.cluster_authority_pubkey);
        if current_count >= self.max_peers_per_cluster {
            return Err(ClusterError::ClusterAlreadyConnected);
        }

        Ok(())
    }

    /// Record a successfully established peer connection to a foreign cluster.
    pub fn record_peer_connected(
        &mut self,
        peer_attestation: &NodeClusterAttestation,
        now_seconds: u64,
    ) -> Result<(), ClusterError> {
        self.validate_peer_attestation(peer_attestation, now_seconds)?;
        *self
            .active_peers_by_cluster
            .entry(peer_attestation.cluster_authority_pubkey)
            .or_insert(0) += 1;
        Ok(())
    }

    /// Record a peer disconnection, decrementing active count for the foreign cluster.
    pub fn record_peer_disconnected(&mut self, cluster_authority_pubkey: &[u8; 33]) {
        if let Some(count) = self
            .active_peers_by_cluster
            .get_mut(cluster_authority_pubkey)
        {
            if *count <= 1 {
                self.active_peers_by_cluster
                    .remove(cluster_authority_pubkey);
            } else {
                *count -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generate_keypair() -> (SecKey, [u8; 33]) {
        let ecc = EccSecp256k1::default();
        let mut rng = rand::thread_rng();
        let mut key_bytes = [0u8; 32];
        use rand::RngCore;
        rng.fill_bytes(&mut key_bytes);
        let seckey = ecc.seckey_from_array(key_bytes).unwrap();
        let pubkey = ecc.derive_pubkey(&seckey);
        (seckey, pubkey.array())
    }

    #[test]
    fn test_cluster_attestation_sign_and_verify() {
        let (auth_sec, auth_pub) = generate_keypair();
        let (_node_sec, node_pub) = generate_keypair();
        let cluster_id = Uuid::new_v4();
        let domain = "relay.example.com".to_string();
        let now = 1700000000;
        let valid_until = now + 3600;

        let attestation = NodeClusterAttestation::sign(
            &auth_sec,
            auth_pub,
            cluster_id,
            domain.clone(),
            node_pub,
            valid_until,
        );

        assert_eq!(attestation.cluster_authority_pubkey, auth_pub);
        assert_eq!(attestation.cluster_id, cluster_id);
        assert_eq!(attestation.domain, domain);
        assert_eq!(attestation.node_pubkey, node_pub);
        assert_eq!(attestation.valid_until, valid_until);

        // Verification succeeds at current time
        assert!(attestation.verify(now).is_ok());
        // Verification succeeds right at expiration
        assert!(attestation.verify(valid_until).is_ok());

        // Verification fails after expiration
        assert_eq!(
            attestation.verify(valid_until + 1),
            Err(ClusterError::AttestationExpired(
                valid_until,
                valid_until + 1
            ))
        );

        // Verification fails if tampered
        let mut tampered = attestation.clone();
        tampered.domain = "attacker.example.com".to_string();
        assert_eq!(tampered.verify(now), Err(ClusterError::InvalidSignature));

        let mut tampered_node = attestation.clone();
        tampered_node.node_pubkey[0] ^= 1;
        assert_eq!(
            tampered_node.verify(now),
            Err(ClusterError::InvalidSignature)
        );
    }

    #[test]
    fn test_anti_self_peering_rejection() {
        let (my_auth_sec, my_auth_pub) = generate_keypair();
        let (_my_node_sec, my_node_pub) = generate_keypair();
        let (_sibling_sec, sibling_node_pub) = generate_keypair();
        let my_cluster_id = Uuid::new_v4();
        let domain = "my-cluster.frank.org".to_string();
        let now = 1700000000;

        let my_attestation = NodeClusterAttestation::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            domain.clone(),
            my_node_pub,
            now + 86400,
        );

        let sibling_attestation = NodeClusterAttestation::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            domain,
            sibling_node_pub,
            now + 86400,
        );

        let coordinator = ClusterPeeringCoordinator::new(Some(my_attestation), 1);

        // Sibling presenting the same cluster authority pubkey is rejected
        assert_eq!(
            coordinator.validate_peer_attestation(&sibling_attestation, now),
            Err(ClusterError::SelfPeeringRejected)
        );
    }

    #[test]
    fn test_foreign_cluster_anti_swarm_deduplication() {
        let (my_auth_sec, my_auth_pub) = generate_keypair();
        let (_my_node_sec, my_node_pub) = generate_keypair();
        let my_cluster_id = Uuid::new_v4();
        let now = 1700000000;

        let my_attestation = NodeClusterAttestation::sign(
            &my_auth_sec,
            my_auth_pub,
            my_cluster_id,
            "local.relay.org".to_string(),
            my_node_pub,
            now + 86400,
        );

        // Foreign cluster B with 3 nodes
        let (b_auth_sec, b_auth_pub) = generate_keypair();
        let b_cluster_id = Uuid::new_v4();
        let (_b1_sec, b1_pub) = generate_keypair();
        let (_b2_sec, b2_pub) = generate_keypair();

        let b1_attestation = NodeClusterAttestation::sign(
            &b_auth_sec,
            b_auth_pub,
            b_cluster_id,
            "remote.cluster-b.org".to_string(),
            b1_pub,
            now + 86400,
        );
        let b2_attestation = NodeClusterAttestation::sign(
            &b_auth_sec,
            b_auth_pub,
            b_cluster_id,
            "remote.cluster-b.org".to_string(),
            b2_pub,
            now + 86400,
        );

        // max_peers_per_cluster = 1
        let mut coordinator = ClusterPeeringCoordinator::new(Some(my_attestation), 1);

        // First node B1 connects successfully
        assert!(coordinator
            .validate_peer_attestation(&b1_attestation, now)
            .is_ok());
        coordinator
            .record_peer_connected(&b1_attestation, now)
            .unwrap();
        assert_eq!(coordinator.count_peers_for_cluster(&b_auth_pub), 1);

        // Second node B2 from the same cluster is rejected with ClusterAlreadyConnected
        assert_eq!(
            coordinator.validate_peer_attestation(&b2_attestation, now),
            Err(ClusterError::ClusterAlreadyConnected)
        );
        assert_eq!(
            coordinator.record_peer_connected(&b2_attestation, now),
            Err(ClusterError::ClusterAlreadyConnected)
        );

        // When B1 disconnects, count drops to 0
        coordinator.record_peer_disconnected(&b_auth_pub);
        assert_eq!(coordinator.count_peers_for_cluster(&b_auth_pub), 0);

        // Now B2 is permitted to connect
        assert!(coordinator
            .validate_peer_attestation(&b2_attestation, now)
            .is_ok());
        coordinator
            .record_peer_connected(&b2_attestation, now)
            .unwrap();
        assert_eq!(coordinator.count_peers_for_cluster(&b_auth_pub), 1);
    }
}
