//! Process-owned configuration and authorization state for durable Monad direct messages.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    monad_http::{Address, HttpTransport},
    monad_outbox::{MonadOutboxPermitPool, MonadOutboxReconcileConfig},
};

type HmacSha256 = Hmac<Sha256>;

const CHALLENGE_TTL_MS: i64 = 60_000;
const MAX_REPLAY_RECIPIENTS: usize = 256;
const MAX_USED_CHALLENGES_PER_RECIPIENT: usize = 8;
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
}

impl MailboxResource {
    fn tag(self) -> u8 {
        match self {
            Self::Inbox => 1,
            Self::Recovery => 2,
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

/// Canonical future request facts authenticated by both server MAC and recipient signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MailboxRequestBinding {
    pub(crate) resource: MailboxResource,
    pub(crate) recipient: Address,
    pub(crate) since: i64,
    pub(crate) cursor: Option<MailboxCursor>,
    pub(crate) limit: usize,
    pub(crate) max_bytes: usize,
}

impl MailboxRequestBinding {
    pub(crate) fn append_canonical(&self, bytes: &mut Vec<u8>) {
        bytes.extend_from_slice(b"GET\0/message/monad/");
        bytes.extend_from_slice(match self.resource {
            MailboxResource::Inbox => b"inbox/",
            MailboxResource::Recovery => b"recovery/",
        });
        bytes.push(self.resource.tag());
        bytes.extend_from_slice(&self.recipient.0);
        bytes.extend_from_slice(&self.since.to_be_bytes());
        match self.cursor {
            Some(cursor) => {
                bytes.push(1);
                cursor.append_position(bytes);
            }
            None => bytes.push(0),
        }
        bytes.extend_from_slice(&(self.limit as u64).to_be_bytes());
        bytes.extend_from_slice(&(self.max_bytes as u64).to_be_bytes());
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

#[derive(Debug, Clone, Copy)]
struct UsedChallenge {
    expires_at_ms: i64,
}

#[derive(Debug, Default)]
struct RecipientReplayState {
    nonces: HashMap<[u8; 32], UsedChallenge>,
    last_used: u64,
}

#[derive(Debug, Default)]
struct ReplayState {
    recipients: HashMap<Address, RecipientReplayState>,
    sequence: u64,
}

#[derive(Debug)]
struct MailboxAuthState {
    epoch: [u8; 32],
    secret: [u8; 32],
    // Anonymous issuance is stateless. Successful uses occupy at most 256 recipient buckets with
    // eight nonces each. Expired buckets are collected first; a new authenticated principal
    // evicts the least-recently-used bucket rather than being rejected by unrelated principals.
    used: Mutex<ReplayState>,
}

impl MailboxAuthState {
    fn new() -> Self {
        let mut epoch = [0; 32];
        let mut secret = [0; 32];
        rand::thread_rng().fill_bytes(&mut epoch);
        rand::thread_rng().fill_bytes(&mut secret);
        Self {
            epoch,
            secret,
            used: Mutex::new(ReplayState::default()),
        }
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

    fn mark_used_after_recipient_auth(
        &self,
        recipient: Address,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        if challenge.epoch != self.epoch || challenge.expires_at_ms < now_ms {
            return false;
        }
        let mut replay = self
            .used
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        replay.recipients.retain(|_, state| {
            state
                .nonces
                .retain(|_, entry| entry.expires_at_ms >= now_ms);
            !state.nonces.is_empty()
        });
        replay.sequence = replay.sequence.wrapping_add(1);
        let sequence = replay.sequence;
        if let Some(state) = replay.recipients.get_mut(&recipient) {
            if state.nonces.contains_key(&challenge.nonce)
                || state.nonces.len() >= MAX_USED_CHALLENGES_PER_RECIPIENT
            {
                return false;
            }
            state.last_used = sequence;
            state.nonces.insert(
                challenge.nonce,
                UsedChallenge {
                    expires_at_ms: challenge.expires_at_ms,
                },
            );
            return true;
        }
        if replay.recipients.len() >= MAX_REPLAY_RECIPIENTS {
            if let Some(oldest) = replay
                .recipients
                .iter()
                .min_by_key(|(_, state)| state.last_used)
                .map(|(recipient, _)| *recipient)
            {
                replay.recipients.remove(&oldest);
            }
        }
        if replay.recipients.len() >= MAX_REPLAY_RECIPIENTS {
            return false;
        }
        replay.recipients.insert(
            recipient,
            RecipientReplayState {
                nonces: HashMap::from([(
                    challenge.nonce,
                    UsedChallenge {
                        expires_at_ms: challenge.expires_at_ms,
                    },
                )]),
                last_used: sequence,
            },
        );
        true
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

    /// Record one nonce only after its registered recipient signature was accepted.
    pub(crate) fn mark_challenge_used(
        &self,
        recipient: Address,
        challenge: MailboxChallenge,
        now_ms: i64,
    ) -> bool {
        self.auth
            .mark_used_after_recipient_auth(recipient, challenge, now_ms)
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
        assert!(enabled.mark_challenge_used(recipient, challenge, 1_001));
        assert!(!enabled.mark_challenge_used(recipient, challenge, 1_001));

        let expired = enabled.issue_challenge(&request, 2_000);
        assert!(!enabled.verify_challenge(&request, expired, expired.expires_at_ms + 1));
    }

    #[test]
    fn anonymous_challenge_flood_reserves_no_replay_capacity() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let recipient = Address([3; 20]);
        let request = binding(recipient);
        for _ in 0..(MAX_REPLAY_RECIPIENTS * MAX_USED_CHALLENGES_PER_RECIPIENT * 2) {
            let challenge = enabled.issue_challenge(&request, 0);
            assert!(enabled.verify_challenge(&request, challenge, 0));
        }
        assert!(enabled
            .auth
            .used
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .recipients
            .is_empty());

        for _ in 0..MAX_USED_CHALLENGES_PER_RECIPIENT {
            let challenge = enabled.issue_challenge(&request, 0);
            assert!(enabled.mark_challenge_used(recipient, challenge, 0));
        }
        let over = enabled.issue_challenge(&request, 0);
        assert!(!enabled.mark_challenge_used(recipient, over, 0));
    }

    #[test]
    fn authenticated_replay_state_is_bounded_without_cross_recipient_rejection() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let victim = Address([0xff; 20]);
        let victim_challenge = enabled.issue_challenge(&binding(victim), 0);
        assert!(enabled.mark_challenge_used(victim, victim_challenge, 0));
        for recipient_index in 0..128 {
            let mut address = [0u8; 20];
            address[..8].copy_from_slice(&(recipient_index as u64).to_be_bytes());
            let recipient = Address(address);
            let request = binding(recipient);
            let challenge = enabled.issue_challenge(&request, 0);
            assert!(enabled.mark_challenge_used(recipient, challenge, 0));
        }
        assert!(!enabled.mark_challenge_used(victim, victim_challenge, 0));
        for recipient_index in 128..(MAX_REPLAY_RECIPIENTS + 64) {
            let mut address = [0u8; 20];
            address[..8].copy_from_slice(&(recipient_index as u64).to_be_bytes());
            let recipient = Address(address);
            let challenge = enabled.issue_challenge(&binding(recipient), 0);
            assert!(enabled.mark_challenge_used(recipient, challenge, 0));
        }
        assert!(
            enabled
                .auth
                .used
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .recipients
                .len()
                <= MAX_REPLAY_RECIPIENTS
        );
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
}
