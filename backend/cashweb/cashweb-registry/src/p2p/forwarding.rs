//! Clustered outbound bundle forwarding and worker coordination (Issue #998).
//!
//! When a direct message or topic event needs to be forwarded to a remote relay descriptor
//! (Type 25 forwarding envelope), multi-node clusters coordinate so that exactly one node
//! claims and executes the forwarding HTTP POST, avoiding redundant dispatch storms.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use bitcoinsuite_error::Result;
use frank_cbor::{
    encode_forwarding_delivery, AccountRef, ForwardingDeliveryEnvelope, PaymentMember,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use url::Url;

use crate::p2p::{cluster::ClusterError, descriptor::ClusterRelayDescriptor};

/// Kind of payload contained within the outbound forwarding bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BundleKind {
    /// Type 25 direct message forwarding envelope.
    DirectMessage,
    /// Forum / topic event.
    TopicEvent,
}

/// An outbound delivery bundle destined for a remote relay cluster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundBundle {
    /// Unique identifier / commit digest for this bundle.
    pub bundle_id: String,
    /// Kind of forwarding bundle.
    pub kind: BundleKind,
    /// Remote cluster relay descriptor hash.
    pub target_descriptor_hash: [u8; 32],
    /// Remote destination URL (HTTP POST endpoint).
    pub target_endpoint: Url,
    /// Encoded payload bytes (Type 25 frame or topic CBOR frame).
    pub payload: Vec<u8>,
    /// HTTP Content-Type header.
    pub content_type: String,
    /// Timestamp when this bundle was queued (seconds since Unix epoch).
    pub created_at_seconds: u64,
}

/// Outcome of attempting to forward an outbound bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForwardingOutcome {
    /// Successfully claimed and delivered by this worker.
    Delivered {
        /// HTTP status code returned by remote relay.
        status: u16,
        /// Response body bytes returned by remote relay.
        response: Vec<u8>,
    },
    /// Skipped because another cluster node already claimed this bundle.
    SkippedAlreadyClaimed,
}

/// Distributed claim lease coordinator ensuring single-worker execution across the cluster.
#[async_trait::async_trait]
pub trait BundleClaimStore: Send + Sync + std::fmt::Debug {
    /// Attempt to atomically acquire an exclusive lease for the given `bundle_id`.
    /// Returns `true` if this worker won the lease, or `false` if another worker holds it.
    async fn try_claim(
        &self,
        bundle_id: &str,
        worker_id: &str,
        lease_ttl_seconds: u64,
        now_seconds: u64,
    ) -> Result<bool, ClusterError>;

    /// Mark the bundle delivery as successfully completed.
    async fn mark_completed(&self, bundle_id: &str, worker_id: &str) -> Result<(), ClusterError>;

    /// Release a previously acquired claim lease (e.g. on recoverable error).
    async fn release_claim(&self, bundle_id: &str, worker_id: &str) -> Result<(), ClusterError>;

    /// Check if a bundle is currently claimed or already completed.
    async fn is_claimed_or_completed(
        &self,
        bundle_id: &str,
        now_seconds: u64,
    ) -> Result<bool, ClusterError>;
}

/// In-memory implementation of [`BundleClaimStore`] simulating atomic distributed cluster leases.
#[derive(Debug, Default, Clone)]
pub struct MemoryBundleClaimStore {
    state: Arc<Mutex<MemoryClaimState>>,
}

#[derive(Debug, Default)]
struct MemoryClaimState {
    /// Active claims: bundle_id -> (worker_id, expires_at_seconds)
    claims: HashMap<String, (String, u64)>,
    /// Completed bundle IDs.
    completed: HashSet<String>,
}

#[async_trait::async_trait]
impl BundleClaimStore for MemoryBundleClaimStore {
    async fn try_claim(
        &self,
        bundle_id: &str,
        worker_id: &str,
        lease_ttl_seconds: u64,
        now_seconds: u64,
    ) -> Result<bool, ClusterError> {
        let mut lock = self.state.lock().await;
        if lock.completed.contains(bundle_id) {
            return Ok(false);
        }
        if let Some((holder, expires_at)) = lock.claims.get(bundle_id) {
            if now_seconds < *expires_at && holder != worker_id {
                return Ok(false);
            }
        }
        let expires_at = now_seconds.saturating_add(lease_ttl_seconds);
        lock.claims
            .insert(bundle_id.to_string(), (worker_id.to_string(), expires_at));
        Ok(true)
    }

    async fn mark_completed(&self, bundle_id: &str, _worker_id: &str) -> Result<(), ClusterError> {
        let mut lock = self.state.lock().await;
        lock.completed.insert(bundle_id.to_string());
        lock.claims.remove(bundle_id);
        Ok(())
    }

    async fn release_claim(&self, bundle_id: &str, worker_id: &str) -> Result<(), ClusterError> {
        let mut lock = self.state.lock().await;
        if let Some((holder, _)) = lock.claims.get(bundle_id) {
            if holder == worker_id {
                lock.claims.remove(bundle_id);
            }
        }
        Ok(())
    }

    async fn is_claimed_or_completed(
        &self,
        bundle_id: &str,
        now_seconds: u64,
    ) -> Result<bool, ClusterError> {
        let lock = self.state.lock().await;
        if lock.completed.contains(bundle_id) {
            return Ok(true);
        }
        if let Some((_, expires_at)) = lock.claims.get(bundle_id) {
            if now_seconds < *expires_at {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Worker coordinator executing single-worker outbound bundle forwarding.
#[derive(Debug, Clone)]
pub struct ClusteredBundleForwarder<S: BundleClaimStore> {
    worker_id: String,
    claim_store: Arc<S>,
    http_client: reqwest::Client,
    lease_ttl_seconds: u64,
}

impl<S: BundleClaimStore> ClusteredBundleForwarder<S> {
    /// Create a new bundle forwarder for this worker node.
    pub fn new(
        worker_id: String,
        claim_store: Arc<S>,
        http_client: reqwest::Client,
        lease_ttl_seconds: u64,
    ) -> Self {
        Self {
            worker_id,
            claim_store,
            http_client,
            lease_ttl_seconds: lease_ttl_seconds.max(5),
        }
    }

    /// Worker ID of this node.
    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    /// Claim store instance.
    pub fn claim_store(&self) -> &Arc<S> {
        &self.claim_store
    }

    /// Build a Type 25 forwarding envelope outbound bundle targeting a remote relay descriptor.
    pub fn build_type25_bundle(
        bundle_id: String,
        network: String,
        destination: AccountRef,
        payload_frame: Vec<u8>,
        payments: Vec<PaymentMember>,
        target_descriptor: &ClusterRelayDescriptor,
        endpoint_index: usize,
        expires_at: Option<u64>,
        now_seconds: u64,
    ) -> Result<OutboundBundle, String> {
        if target_descriptor.public_endpoints.is_empty() {
            return Err("Target descriptor has no public endpoints".to_string());
        }
        let target_endpoint = target_descriptor
            .public_endpoints
            .get(endpoint_index)
            .cloned()
            .unwrap_or_else(|| target_descriptor.public_endpoints[0].clone());

        let envelope = ForwardingDeliveryEnvelope {
            network,
            destination,
            payload_frame,
            payload_digest: None,
            payments,
            endpoint: Some(target_endpoint.to_string()),
            expires_at,
            unknown: Vec::new(),
        };

        let encoded = encode_forwarding_delivery(&envelope)
            .map_err(|e| format!("Failed to encode Type 25 forwarding delivery envelope: {e}"))?;

        Ok(OutboundBundle {
            bundle_id,
            kind: BundleKind::DirectMessage,
            target_descriptor_hash: target_descriptor.descriptor_hash(),
            target_endpoint,
            payload: encoded,
            content_type: "application/vnd.frank.cbor".to_string(),
            created_at_seconds: now_seconds,
        })
    }

    /// Coordinate bundle forwarding:
    /// 1. Exactly one worker in the cluster claims the lease.
    /// 2. If claimed, executes the outbound HTTP POST to the target endpoint.
    /// 3. Marks completed on success, or releases claim on failure.
    pub async fn forward_bundle(
        &self,
        bundle: &OutboundBundle,
        now_seconds: u64,
    ) -> Result<ForwardingOutcome, ClusterError> {
        // Step 1: Attempt to claim the lease atomically
        let acquired = self
            .claim_store
            .try_claim(
                &bundle.bundle_id,
                &self.worker_id,
                self.lease_ttl_seconds,
                now_seconds,
            )
            .await?;

        if !acquired {
            // Another cluster node already claimed this bundle
            return Ok(ForwardingOutcome::SkippedAlreadyClaimed);
        }

        // Step 2: Execute outbound HTTP POST
        let send_res = self
            .http_client
            .post(bundle.target_endpoint.as_str())
            .header("content-type", &bundle.content_type)
            .body(bundle.payload.clone())
            .send()
            .await;

        match send_res {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| ClusterError::ForwardingFailed(e.without_url().to_string()))?
                    .to_vec();

                if (200..=299).contains(&status) {
                    // Mark completed so no other node re-executes
                    self.claim_store
                        .mark_completed(&bundle.bundle_id, &self.worker_id)
                        .await?;
                    Ok(ForwardingOutcome::Delivered {
                        status,
                        response: bytes,
                    })
                } else {
                    // Release claim so it can be retried if transient
                    let _ = self
                        .claim_store
                        .release_claim(&bundle.bundle_id, &self.worker_id)
                        .await;
                    Err(ClusterError::ForwardingFailed(format!(
                        "Remote relay returned HTTP status {status}"
                    )))
                }
            }
            Err(err) => {
                let _ = self
                    .claim_store
                    .release_claim(&bundle.bundle_id, &self.worker_id)
                    .await;
                // Without the peer's URL: a relay behind a secret path must not appear in logs.
                Err(ClusterError::ForwardingFailed(
                    err.without_url().to_string(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::StatusCode,
        response::IntoResponse,
        routing::{post, Router},
    };
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use frank_cbor::PaymentValue;
    use rand::RngCore;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use uuid::Uuid;

    #[tokio::test]
    async fn test_coordinated_single_worker_bundle_forwarding() {
        let request_counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = Arc::clone(&request_counter);

        // Ephemeral mock HTTP server receiving forwarded Type 25 envelopes
        let app = Router::new().route(
            "/mailbox/delivery",
            post(move |body: Bytes| {
                let counter = Arc::clone(&counter_clone);
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    assert!(!body.is_empty());
                    (StatusCode::OK, "{\"status\":\"accepted\"}").into_response()
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::Server::from_tcp(listener.into_std().unwrap())
                .unwrap()
                .serve(app.into_make_service())
                .await
                .unwrap();
        });

        // Setup shared claim store
        let claim_store = Arc::new(MemoryBundleClaimStore::default());

        // Setup 3 cluster workers
        let client = reqwest::Client::new();
        let worker1 = ClusteredBundleForwarder::new(
            "worker-node-1".to_string(),
            Arc::clone(&claim_store),
            client.clone(),
            30,
        );
        let worker2 = ClusteredBundleForwarder::new(
            "worker-node-2".to_string(),
            Arc::clone(&claim_store),
            client.clone(),
            30,
        );
        let worker3 = ClusteredBundleForwarder::new(
            "worker-node-3".to_string(),
            Arc::clone(&claim_store),
            client.clone(),
            30,
        );

        // Remote cluster descriptor
        let ecc = EccSecp256k1::default();
        let mut rng = rand::thread_rng();
        let mut key_bytes = [0u8; 32];
        rng.fill_bytes(&mut key_bytes);
        let remote_sec = ecc.seckey_from_array(key_bytes).unwrap();
        let remote_pub = ecc.derive_pubkey(&remote_sec).array();
        let remote_cluster_id = Uuid::new_v4();
        let remote_url = format!("http://{server_addr}/mailbox/delivery")
            .parse::<Url>()
            .unwrap();

        let remote_descriptor = ClusterRelayDescriptor::sign(
            &remote_sec,
            remote_pub,
            remote_cluster_id,
            "remote-cluster".to_string(),
            vec![remote_url.clone()],
            1700086400,
        );

        // Build Type 25 bundle
        let destination = AccountRef {
            key_type: 1,
            key_bytes: vec![2u8; 33],
        };
        let payload_frame = vec![0x01; 64]; // dummy inner frame
        let payments = vec![PaymentMember {
            child_index: 0,
            transaction_id: vec![0x11; 32],
            value: PaymentValue::Satoshis(1000),
            address: vec![0x22; 20],
            commitment: vec![0x33; 32],
            vout: Some(0),
            raw_tx: None,
        }];

        let bundle = ClusteredBundleForwarder::<MemoryBundleClaimStore>::build_type25_bundle(
            "bundle-dm-1001".to_string(),
            "lotus".to_string(),
            destination,
            payload_frame,
            payments,
            &remote_descriptor,
            0,
            Some(1700086400),
            1700000000,
        )
        .unwrap();

        assert_eq!(bundle.target_endpoint, remote_url);
        assert_eq!(
            bundle.target_descriptor_hash,
            remote_descriptor.descriptor_hash()
        );

        // Concurrently dispatch from all 3 workers
        let now = 1700000000;
        let (res1, res2, res3) = tokio::join!(
            worker1.forward_bundle(&bundle, now),
            worker2.forward_bundle(&bundle, now),
            worker3.forward_bundle(&bundle, now),
        );

        let outcomes = vec![res1.unwrap(), res2.unwrap(), res3.unwrap()];

        // Exactly ONE worker delivered the bundle
        let delivered_count = outcomes
            .iter()
            .filter(|o| matches!(o, ForwardingOutcome::Delivered { .. }))
            .count();
        let skipped_count = outcomes
            .iter()
            .filter(|o| matches!(o, ForwardingOutcome::SkippedAlreadyClaimed))
            .count();

        assert_eq!(delivered_count, 1, "Exactly one worker must deliver");
        assert_eq!(skipped_count, 2, "Other workers must skip");

        // Remote mock HTTP endpoint was contacted exactly once!
        assert_eq!(
            request_counter.load(Ordering::SeqCst),
            1,
            "Remote server should receive exactly one HTTP POST"
        );

        // Subsequent call by worker 1 or any worker also skips (already completed)
        let later_res = worker1.forward_bundle(&bundle, now + 1).await.unwrap();
        assert_eq!(later_res, ForwardingOutcome::SkippedAlreadyClaimed);
        assert_eq!(request_counter.load(Ordering::SeqCst), 1);
    }
}
