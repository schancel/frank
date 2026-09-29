//! Process-owned configuration and authorization state for durable Monad direct messages.

use std::{fmt, sync::Arc};

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    monad_http::{Address, HttpTransport},
    monad_outbox::{MonadOutboxPermitPool, MonadOutboxReconcileConfig},
};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const CHALLENGE_TTL_MS: i64 = 60_000;
pub(crate) const MAX_USED_CHALLENGES_PER_RECIPIENT: usize = 8;
const CHALLENGE_MAC_DOMAIN: &[u8] = b"frank:mailbox-challenge-mac:v1\0";
const CURSOR_MAC_DOMAIN: &[u8] = b"frank:mailbox-cursor-mac:v1\0";
const CURSOR_VERSION: u8 = 1;

/// Typed mailbox mode owned by the HTTP server.
#[derive(Debug, Clone)]
pub enum MonadMailboxRuntime {
    /// Admission is not installed and no RPC transport is reachable from the router.
    Disabled,
    /// Admission, private reads, and the background worker share this validated runtime.
    Enabled(Arc<EnabledMonadMailboxRuntime>),
}

/// Private resource selected by an authenticated mailbox request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailboxResource {
    /// Delivered recipient inbox ordered by `(timestamp, payload_hash)`.
    Inbox,
    /// Incomplete confirmed-prefix recovery ordered by `payload_hash`.
    Recovery,
    /// Recipient acknowledgement of one exact terminal recovery obligation.
    RecoveryAck,
}

impl MailboxResource {
    fn tag(self) -> u8 {
        match self {
            Self::Inbox => 1,
            Self::Recovery => 2,
            Self::RecoveryAck => 3,
        }
    }
}

/// Typed strict-forward position carried by an authenticated private request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailboxCursor {
    /// Composite recipient-inbox ordering key.
    Inbox {
        /// Stored message time.
        timestamp: i64,
        /// Tie-breaker within one timestamp.
        payload_hash: [u8; 32],
    },
    /// Recipient recovery-index ordering key.
    Recovery {
        /// Exact outbox payload hash.
        payload_hash: [u8; 32],
    },
}

impl MailboxCursor {
    pub(crate) fn resource(self) -> MailboxResource {
        match self {
            Self::Inbox { .. } => MailboxResource::Inbox,
            Self::Recovery { .. } => MailboxResource::Recovery,
        }
    }

    fn append_position(self, bytes: &mut Vec<u8>) {
        match self {
            Self::Inbox {
                timestamp,
                payload_hash,
            } => {
                bytes.extend_from_slice(&timestamp.to_be_bytes());
                bytes.extend_from_slice(&payload_hash);
            }
            Self::Recovery { payload_hash } => bytes.extend_from_slice(&payload_hash),
        }
    }
}

/// One opaque cursor token paired with the decoded position used only by the server-side scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MailboxCursorBinding {
    pub(crate) position: MailboxCursor,
    pub(crate) token: String,
}

/// Canonical future request facts authenticated by both server MAC and recipient signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MailboxRequestBinding {
    pub(crate) resource: MailboxResource,
    pub(crate) recipient: Address,
    pub(crate) since: i64,
    pub(crate) cursor: Option<MailboxCursorBinding>,
    pub(crate) limit: usize,
    pub(crate) max_bytes: usize,
    /// Exact terminal recovery payload being acknowledged, absent on read requests.
    pub(crate) recovery_payload_hash: Option<[u8; 32]>,
    /// Exact durable obligation generation being acknowledged, absent on read requests.
    pub(crate) recovery_obligation_id: Option<[u8; 32]>,
}

impl MailboxRequestBinding {
    pub(crate) fn append_canonical(&self, bytes: &mut Vec<u8>) {
        let (method, path): (&[u8], &[u8]) = match self.resource {
            MailboxResource::Inbox => (b"GET", b"inbox/"),
            MailboxResource::Recovery => (b"GET", b"recovery/"),
            MailboxResource::RecoveryAck => (b"POST", b"recovery-ack/"),
        };
        bytes.extend_from_slice(method);
        bytes.extend_from_slice(b"\0/message/monad/");
        bytes.extend_from_slice(path);
        bytes.push(self.resource.tag());
        bytes.extend_from_slice(&self.recipient.0);
        bytes.extend_from_slice(&self.since.to_be_bytes());
        match self.cursor.as_ref() {
            Some(cursor) => {
                debug_assert_eq!(cursor.position.resource(), self.resource);
                bytes.push(1);
                bytes.extend_from_slice(&(cursor.token.len() as u32).to_be_bytes());
                bytes.extend_from_slice(cursor.token.as_bytes());
            }
            None => bytes.push(0),
        }
        bytes.extend_from_slice(&(self.limit as u64).to_be_bytes());
        bytes.extend_from_slice(&(self.max_bytes as u64).to_be_bytes());
        if self.resource == MailboxResource::RecoveryAck {
            bytes.extend_from_slice(
                &self
                    .recovery_payload_hash
                    .expect("recovery acknowledgement binding requires a payload hash"),
            );
            bytes.extend_from_slice(
                &self
                    .recovery_obligation_id
                    .expect("recovery acknowledgement binding requires an obligation ID"),
            );
        }
    }
}

/// Immutable runtime facts shared by admission, reads, and reconciliation.
#[derive(Debug)]
pub struct EnabledMonadMailboxRuntime {
    transport: HttpTransport,
    reconcile: Arc<MonadOutboxReconcileConfig>,
    outbox_permits: MonadOutboxPermitPool,
    private_read_permits: Arc<Semaphore>,
    min_value_wei: u128,
    network_tag: Vec<u8>,
    auth: MailboxAuthState,
}

/// Public facts a recipient signs to authorize one private request.
#[derive(Debug, Clone, Copy)]
pub struct MailboxChallenge {
    /// Runtime epoch; a restart invalidates every outstanding challenge and cursor.
    pub epoch: [u8; 32],
    /// Cryptographically random one-time value.
    pub nonce: [u8; 32],
    /// Absolute expiry in Unix milliseconds.
    pub expires_at_ms: i64,
    /// Server MAC over the epoch, nonce, expiry, and complete normalized future request.
    pub token: [u8; 32],
}

struct MailboxAuthState {
    epoch: [u8; 32],
    secret: [u8; 32],
}

impl fmt::Debug for MailboxAuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailboxAuthState")
            .field("epoch", &self.epoch)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl MailboxAuthState {
    fn new() -> Self {
        let mut epoch = [0; 32];
        let mut secret = [0; 32];
        rand::thread_rng().fill_bytes(&mut epoch);
        rand::thread_rng().fill_bytes(&mut secret);
        Self { epoch, secret }
    }

    fn challenge_preimage(
        &self,
        binding: &MailboxRequestBinding,
        nonce: [u8; 32],
        expires_at_ms: i64,
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(160);
        bytes.extend_from_slice(CHALLENGE_MAC_DOMAIN);
        bytes.extend_from_slice(&self.epoch);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&expires_at_ms.to_be_bytes());
        binding.append_canonical(&mut bytes);
        bytes
    }

    fn mac(&self, preimage: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts 32-byte key");
        mac.update(preimage);
        mac.finalize().into_bytes().into()
    }

    fn issue(&self, binding: &MailboxRequestBinding, now_ms: i64) -> MailboxChallenge {
        let mut nonce = [0; 32];
        rand::thread_rng().fill_bytes(&mut nonce);
        let expires_at_ms = now_ms.saturating_add(CHALLENGE_TTL_MS);
        let token = self.mac(&self.challenge_preimage(binding, nonce, expires_at_ms));
        MailboxChallenge {
            epoch: self.epoch,
            nonce,
            expires_at_ms,
            token,
        }
    }

    fn verify(
        &self,
        binding: &MailboxRequestBinding,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        if challenge.epoch != self.epoch || challenge.expires_at_ms < now_ms {
            return false;
        }
        let Ok(mut mac) = HmacSha256::new_from_slice(&self.secret) else {
            return false;
        };
        mac.update(&self.challenge_preimage(binding, challenge.nonce, challenge.expires_at_ms));
        mac.verify_slice(&challenge.token).is_ok()
    }

    fn encode_cursor(&self, recipient: Address, cursor: MailboxCursor) -> String {
        let mut bytes = Vec::with_capacity(94);
        bytes.push(CURSOR_VERSION);
        bytes.push(cursor.resource().tag());
        bytes.extend_from_slice(&recipient.0);
        cursor.append_position(&mut bytes);
        let mut preimage = Vec::with_capacity(CURSOR_MAC_DOMAIN.len() + bytes.len());
        preimage.extend_from_slice(CURSOR_MAC_DOMAIN);
        preimage.extend_from_slice(&bytes);
        bytes.extend_from_slice(&self.mac(&preimage));
        hex::encode(bytes)
    }

    fn decode_cursor(
        &self,
        recipient: Address,
        resource: MailboxResource,
        encoded: &str,
    ) -> Option<MailboxCursor> {
        let position_len = match resource {
            MailboxResource::Inbox => 8 + 32,
            MailboxResource::Recovery => 32,
            MailboxResource::RecoveryAck => return None,
        };
        let unsigned_len = 2 + 20 + position_len;
        let decoded_len = unsigned_len + 32;
        if encoded.len() != decoded_len * 2 {
            return None;
        }
        // The longest cursor is the inbox form: version/resource + recipient + timestamp/hash
        // position + MAC. Validate encoded length before touching a decoder so attacker-sized
        // query strings never drive proportional heap allocation.
        let mut decoded = [0u8; 94];
        hex::decode_to_slice(encoded, &mut decoded[..decoded_len]).ok()?;
        let bytes = &decoded[..decoded_len];
        if bytes[0] != CURSOR_VERSION || bytes[1] != resource.tag() || bytes[2..22] != recipient.0 {
            return None;
        }
        let mut preimage = Vec::with_capacity(CURSOR_MAC_DOMAIN.len() + unsigned_len);
        preimage.extend_from_slice(CURSOR_MAC_DOMAIN);
        preimage.extend_from_slice(&bytes[..unsigned_len]);
        let mut mac = HmacSha256::new_from_slice(&self.secret).ok()?;
        mac.update(&preimage);
        mac.verify_slice(&bytes[unsigned_len..]).ok()?;
        let payload_hash = bytes[unsigned_len - 32..unsigned_len].try_into().ok()?;
        Some(match resource {
            MailboxResource::Inbox => MailboxCursor::Inbox {
                timestamp: i64::from_be_bytes(bytes[22..30].try_into().ok()?),
                payload_hash,
            },
            MailboxResource::Recovery => MailboxCursor::Recovery { payload_hash },
            MailboxResource::RecoveryAck => return None,
        })
    }
}

impl MonadMailboxRuntime {
    /// Construct one enabled runtime after configuration validation.
    pub fn enabled(
        transport: HttpTransport,
        reconcile: Arc<MonadOutboxReconcileConfig>,
        min_value_wei: u128,
        network_tag: Vec<u8>,
    ) -> Self {
        let max_concurrency = reconcile.max_concurrency.max(1);
        Self::Enabled(Arc::new(EnabledMonadMailboxRuntime {
            transport,
            reconcile,
            outbox_permits: MonadOutboxPermitPool::new(max_concurrency),
            private_read_permits: Arc::new(Semaphore::new(max_concurrency)),
            min_value_wei,
            network_tag,
            auth: MailboxAuthState::new(),
        }))
    }

    #[cfg(test)]
    pub(crate) fn enabled_with_auth_secret_for_test(
        transport: HttpTransport,
        reconcile: Arc<MonadOutboxReconcileConfig>,
        min_value_wei: u128,
        network_tag: Vec<u8>,
        secret: [u8; 32],
    ) -> Self {
        let max_concurrency = reconcile.max_concurrency.max(1);
        Self::Enabled(Arc::new(EnabledMonadMailboxRuntime {
            transport,
            reconcile,
            outbox_permits: MonadOutboxPermitPool::new(max_concurrency),
            private_read_permits: Arc::new(Semaphore::new(max_concurrency)),
            min_value_wei,
            network_tag,
            auth: MailboxAuthState {
                epoch: [0x51; 32],
                secret,
            },
        }))
    }

    /// Return the enabled runtime, if admission is configured.
    pub fn as_enabled(&self) -> Option<&EnabledMonadMailboxRuntime> {
        match self {
            Self::Disabled => None,
            Self::Enabled(runtime) => Some(runtime),
        }
    }
}

impl EnabledMonadMailboxRuntime {
    /// Shared RPC transport used by the worker and request admission.
    pub fn transport(&self) -> &HttpTransport {
        &self.transport
    }

    /// Shared durable reconciliation policy used by DB open, worker, and admission.
    pub fn reconcile(&self) -> &Arc<MonadOutboxReconcileConfig> {
        &self.reconcile
    }

    /// Process-owned permits shared by HTTP and background reconciliation.
    pub fn outbox_permits(&self) -> &MonadOutboxPermitPool {
        &self.outbox_permits
    }

    /// Frozen aggregate minimum for newly admitted requests.
    pub fn min_value_wei(&self) -> u128 {
        self.min_value_wei
    }

    /// Validated network tag for newly admitted envelopes.
    pub fn network_tag(&self) -> &[u8] {
        &self.network_tag
    }

    /// Required EVM chain identity shared by admission and recovery.
    pub fn expected_chain_id(&self) -> u64 {
        self.reconcile.expected_chain_id
    }

    /// Issue a stateless short-lived challenge bound to the complete future request.
    pub(crate) fn issue_challenge(
        &self,
        binding: &MailboxRequestBinding,
        now_ms: i64,
    ) -> MailboxChallenge {
        self.auth.issue(binding, now_ms)
    }

    /// Verify the server-authenticated challenge before expensive recipient authentication.
    pub(crate) fn verify_challenge(
        &self,
        binding: &MailboxRequestBinding,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        self.auth.verify(binding, challenge, now_ms)
    }

    /// Encode a process-authenticated strict-forward private cursor.
    pub(crate) fn encode_cursor(&self, recipient: Address, cursor: MailboxCursor) -> String {
        self.auth.encode_cursor(recipient, cursor)
    }

    /// Decode a cursor only for its bound runtime, resource, and recipient.
    pub(crate) fn decode_cursor(
        &self,
        recipient: Address,
        resource: MailboxResource,
        encoded: &str,
    ) -> Option<MailboxCursor> {
        self.auth.decode_cursor(recipient, resource, encoded)
    }

    /// Reserve one shared private-read slot without queueing unbounded requests.
    pub(crate) fn try_acquire_private_read(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.private_read_permits)
            .try_acquire_owned()
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> MonadMailboxRuntime {
        MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
        )
    }

    fn binding(recipient: Address) -> MailboxRequestBinding {
        MailboxRequestBinding {
            resource: MailboxResource::Inbox,
            recipient,
            since: 7,
            cursor: None,
            limit: 10,
            max_bytes: 1024,
            recovery_payload_hash: None,
            recovery_obligation_id: None,
        }
    }

    #[test]
    fn stateless_challenge_is_request_bound_single_use_and_expiring() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let recipient = Address([1; 20]);
        let request = binding(recipient);
        let challenge = enabled.issue_challenge(&request, 1_000);
        assert!(enabled.verify_challenge(&request, challenge, 1_001));
        assert!(!enabled.verify_challenge(&binding(Address([2; 20])), challenge, 1_001));

        let expired = enabled.issue_challenge(&request, 2_000);
        assert!(!enabled.verify_challenge(&request, expired, expired.expires_at_ms + 1));
    }

    #[test]
    fn anonymous_challenge_flood_reserves_no_replay_capacity() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let recipient = Address([3; 20]);
        let request = binding(recipient);
        for _ in 0..4096 {
            let challenge = enabled.issue_challenge(&request, 0);
            assert!(enabled.verify_challenge(&request, challenge, 0));
        }
    }

    #[test]
    fn debug_redacts_mailbox_hmac_secret() {
        let secret = [0xa5; 32];
        let runtime = MonadMailboxRuntime::enabled_with_auth_secret_for_test(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(MonadOutboxReconcileConfig::default()),
            1,
            b"MONT".to_vec(),
            secret,
        );
        let formatted = format!("{runtime:?}");
        assert!(formatted.contains("<redacted>"));
        assert!(!formatted.contains(&format!("{secret:?}")));
        assert!(!formatted.contains(&hex::encode(secret)));
    }

    #[test]
    fn private_reads_share_the_configured_nonqueueing_permit_cap() {
        let mut config = MonadOutboxReconcileConfig::default();
        config.max_concurrency = 2;
        let runtime = MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::new(config),
            1,
            b"MONT".to_vec(),
        );
        let enabled = runtime.as_enabled().unwrap();
        let first = enabled.try_acquire_private_read().unwrap();
        let second = enabled.try_acquire_private_read().unwrap();
        assert!(enabled.try_acquire_private_read().is_none());
        drop(first);
        assert!(enabled.try_acquire_private_read().is_some());
        drop(second);
    }

    #[test]
    fn runtime_preserves_shared_config_identity_and_cursor_binding() {
        let config = Arc::new(MonadOutboxReconcileConfig::default());
        let runtime = MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::clone(&config),
            1,
            vec![],
        );
        let enabled = runtime.as_enabled().unwrap();
        assert!(Arc::ptr_eq(enabled.reconcile(), &config));
        let cursor = MailboxCursor::Inbox {
            timestamp: 9,
            payload_hash: [7; 32],
        };
        let encoded = enabled.encode_cursor(Address([4; 20]), cursor);
        assert_eq!(
            enabled.decode_cursor(Address([4; 20]), MailboxResource::Inbox, &encoded),
            Some(cursor)
        );
        assert_eq!(
            enabled.decode_cursor(Address([5; 20]), MailboxResource::Inbox, &encoded),
            None
        );
        assert_eq!(
            enabled.decode_cursor(Address([4; 20]), MailboxResource::Recovery, &encoded),
            None
        );
        assert_eq!(
            enabled.decode_cursor(Address([4; 20]), MailboxResource::Inbox, "not-hex"),
            None
        );
        assert_eq!(
            enabled.decode_cursor(Address([4; 20]), MailboxResource::Inbox, &"aa".repeat(4096),),
            None
        );
    }
    #[test]
    fn cursor_mac_rejects_tampered_position_forged_mac_and_other_runtime() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let recipient = Address([4; 20]);
        for (resource, cursor) in [
            (
                MailboxResource::Inbox,
                MailboxCursor::Inbox {
                    timestamp: 9,
                    payload_hash: [7; 32],
                },
            ),
            (
                MailboxResource::Recovery,
                MailboxCursor::Recovery {
                    payload_hash: [8; 32],
                },
            ),
        ] {
            let encoded = enabled.encode_cursor(recipient, cursor);
            assert_eq!(
                enabled.decode_cursor(recipient, resource, &encoded),
                Some(cursor)
            );
            let bytes = hex::decode(&encoded).unwrap();
            // Every single-byte change is rejected: header, recipient, position, and MAC alike.
            for index in 0..bytes.len() {
                let mut forged = bytes.clone();
                forged[index] ^= 0x01;
                assert_eq!(
                    enabled.decode_cursor(recipient, resource, &hex::encode(forged)),
                    None,
                    "{resource:?}: byte {index} of the cursor is not covered by its MAC"
                );
            }
            // A structurally perfect cursor whose MAC was computed with another key.
            let other_runtime = MonadMailboxRuntime::enabled_with_auth_secret_for_test(
                HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
                Arc::new(MonadOutboxReconcileConfig::default()),
                1,
                b"MONT".to_vec(),
                [0x99; 32],
            );
            let foreign = other_runtime
                .as_enabled()
                .unwrap()
                .encode_cursor(recipient, cursor);
            assert_eq!(enabled.decode_cursor(recipient, resource, &foreign), None);
            // A zeroed MAC over an otherwise valid position.
            let mut unsigned = bytes.clone();
            let mac_start = unsigned.len() - 32;
            unsigned[mac_start..].fill(0);
            assert_eq!(
                enabled.decode_cursor(recipient, resource, &hex::encode(unsigned)),
                None
            );
        }
    }
}
