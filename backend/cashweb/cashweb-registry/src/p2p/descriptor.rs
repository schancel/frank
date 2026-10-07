//! Cluster Relay Descriptors for inter-cluster federation (Issue #998).
//!
//! When running in clustered mode, nodes advertise a unified `ClusterRelayDescriptor`
//! representing the cluster authority, identity, and public ingress endpoints to external relays.
//! Nodes also use the descriptor to prevent intra-cluster self-peering.

use bitcoinsuite_core::{
    ecc::{Ecc, PubKey, SecKey},
    ByteArray, Bytes, Hashed, Sha256,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::p2p::cluster::{serde_bytes_33, ClusterError};

/// Domain prefix for cluster relay descriptor signing preimage.
pub const CLUSTER_DESCRIPTOR_DOMAIN_PREFIX: &[u8] = b"FRANK_CLUSTER_RELAY_DESCRIPTOR_V1";

/// Unified descriptor representing a relay cluster to external relays and clients.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterRelayDescriptor {
    /// 33-byte compressed public key of the Cluster Domain Authority.
    #[serde(with = "serde_bytes_33")]
    pub authority_pubkey: [u8; 33],
    /// Stable UUID of the cluster.
    pub cluster_id: Uuid,
    /// Human-readable cluster name (e.g. "frank-prod-us").
    pub cluster_name: String,
    /// Public ingress endpoints exposed to external relays/clients.
    pub public_endpoints: Vec<Url>,
    /// Expiration timestamp in seconds since Unix epoch.
    pub valid_until: u64,
    /// Cryptographic signature of the descriptor fields by `authority_pubkey`.
    pub authority_signature: Vec<u8>,
}

impl ClusterRelayDescriptor {
    /// Compute the commit digest from components.
    pub fn compute_digest(
        authority_pubkey: &[u8; 33],
        cluster_id: &Uuid,
        cluster_name: &str,
        public_endpoints: &[Url],
        valid_until: u64,
    ) -> [u8; 32] {
        let mut data = Vec::new();
        data.extend_from_slice(CLUSTER_DESCRIPTOR_DOMAIN_PREFIX);
        data.extend_from_slice(authority_pubkey);
        data.extend_from_slice(cluster_id.as_bytes());
        data.extend_from_slice(&(cluster_name.len() as u32).to_be_bytes());
        data.extend_from_slice(cluster_name.as_bytes());
        data.extend_from_slice(&(public_endpoints.len() as u32).to_be_bytes());
        for endpoint in public_endpoints {
            let s = endpoint.as_str();
            data.extend_from_slice(&(s.len() as u32).to_be_bytes());
            data.extend_from_slice(s.as_bytes());
        }
        data.extend_from_slice(&valid_until.to_be_bytes());
        Sha256::digest(data.into()).byte_array().array()
    }

    /// Compute the SHA-256 digest committed to by the authority signature.
    pub fn digest(&self) -> [u8; 32] {
        Self::compute_digest(
            &self.authority_pubkey,
            &self.cluster_id,
            &self.cluster_name,
            &self.public_endpoints,
            self.valid_until,
        )
    }

    /// Hash of the descriptor for binding to directory statements (`relay_descriptor_hash`).
    pub fn descriptor_hash(&self) -> [u8; 32] {
        self.digest()
    }

    /// Sign and construct a `ClusterRelayDescriptor` using the authority private key.
    pub fn sign(
        authority_seckey: &SecKey,
        authority_pubkey: [u8; 33],
        cluster_id: Uuid,
        cluster_name: String,
        public_endpoints: Vec<Url>,
        valid_until: u64,
    ) -> Self {
        let ecc = EccSecp256k1::default();
        let digest = Self::compute_digest(
            &authority_pubkey,
            &cluster_id,
            &cluster_name,
            &public_endpoints,
            valid_until,
        );
        let sig = ecc.sign(authority_seckey, ByteArray::new(digest));
        Self {
            authority_pubkey,
            cluster_id,
            cluster_name,
            public_endpoints,
            valid_until,
            authority_signature: sig.as_ref().to_vec(),
        }
    }

    /// Verify signature, expiration, and endpoint validity against the current timestamp.
    pub fn verify(&self, now_seconds: u64) -> Result<(), ClusterError> {
        if now_seconds > self.valid_until {
            return Err(ClusterError::AttestationExpired(
                self.valid_until,
                now_seconds,
            ));
        }
        if self.public_endpoints.is_empty() {
            return Err(ClusterError::EmptyEndpoints);
        }
        let ecc = EccSecp256k1::default();
        let digest = self.digest();
        let pubkey = PubKey::new_unchecked(self.authority_pubkey);
        let sig_bytes = Bytes::from(self.authority_signature.clone());
        ecc.verify(&pubkey, ByteArray::new(digest), &sig_bytes)
            .map_err(|_| ClusterError::InvalidSignature)
    }

    /// Check if a candidate peer belongs to this same cluster (intra-cluster self-peering).
    pub fn is_self_peering(
        &self,
        candidate_authority: Option<&[u8; 33]>,
        candidate_cluster_id: Option<&Uuid>,
    ) -> bool {
        if let Some(auth) = candidate_authority {
            if *auth == self.authority_pubkey {
                return true;
            }
        }
        if let Some(cid) = candidate_cluster_id {
            if *cid == self.cluster_id {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use rand::RngCore;

    fn generate_keypair() -> (SecKey, [u8; 33]) {
        let ecc = EccSecp256k1::default();
        let mut rng = rand::thread_rng();
        let mut key_bytes = [0u8; 32];
        rng.fill_bytes(&mut key_bytes);
        let seckey = ecc.seckey_from_array(key_bytes).unwrap();
        let pubkey = ecc.derive_pubkey(&seckey);
        (seckey, pubkey.array())
    }

    #[test]
    fn test_descriptor_generation_and_validation() {
        let (auth_sec, auth_pub) = generate_keypair();
        let cluster_id = Uuid::new_v4();
        let cluster_name = "frank-prod-us".to_string();
        let endpoints = vec![
            Url::parse("https://relay-1.frank.org").unwrap(),
            Url::parse("https://relay-2.frank.org").unwrap(),
        ];
        let now = 1700000000;
        let valid_until = now + 86400;

        let descriptor = ClusterRelayDescriptor::sign(
            &auth_sec,
            auth_pub,
            cluster_id,
            cluster_name.clone(),
            endpoints.clone(),
            valid_until,
        );

        assert_eq!(descriptor.authority_pubkey, auth_pub);
        assert_eq!(descriptor.cluster_id, cluster_id);
        assert_eq!(descriptor.cluster_name, cluster_name);
        assert_eq!(descriptor.public_endpoints, endpoints);
        assert_eq!(descriptor.valid_until, valid_until);
        assert!(!descriptor.authority_signature.is_empty());

        // Verification succeeds at current time
        assert!(descriptor.verify(now).is_ok());
        // Verification succeeds at expiration boundary
        assert!(descriptor.verify(valid_until).is_ok());

        // Verification fails after expiration
        assert_eq!(
            descriptor.verify(valid_until + 1),
            Err(ClusterError::AttestationExpired(
                valid_until,
                valid_until + 1
            ))
        );

        // Verification fails on empty endpoints
        let mut empty_endpoints_desc = descriptor.clone();
        empty_endpoints_desc.public_endpoints.clear();
        assert_eq!(
            empty_endpoints_desc.verify(now),
            Err(ClusterError::EmptyEndpoints)
        );

        // Verification fails if tampered
        let mut tampered = descriptor.clone();
        tampered.cluster_name = "tampered-cluster".to_string();
        assert_eq!(tampered.verify(now), Err(ClusterError::InvalidSignature));

        let mut tampered_auth = descriptor.clone();
        tampered_auth.authority_pubkey[0] ^= 1;
        assert_eq!(
            tampered_auth.verify(now),
            Err(ClusterError::InvalidSignature)
        );

        // Self-peering checks
        assert!(descriptor.is_self_peering(Some(&auth_pub), None));
        assert!(descriptor.is_self_peering(None, Some(&cluster_id)));
        assert!(descriptor.is_self_peering(Some(&auth_pub), Some(&cluster_id)));

        let (_other_sec, other_pub) = generate_keypair();
        let other_cluster_id = Uuid::new_v4();
        assert!(!descriptor.is_self_peering(Some(&other_pub), Some(&other_cluster_id)));
    }
}
