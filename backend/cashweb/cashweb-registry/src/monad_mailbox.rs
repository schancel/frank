//! Process-owned configuration for durable Monad direct-message admission.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use rand::RngCore;

use crate::{
    monad_http::{Address, HttpTransport},
    monad_outbox::MonadOutboxReconcileConfig,
};

/// Typed mailbox mode owned by the HTTP server.
#[derive(Debug, Clone)]
pub enum MonadMailboxRuntime {
    /// Admission is not installed and no RPC transport is reachable from the router.
    Disabled,
    /// Admission and the background worker share this validated runtime.
    Enabled(Arc<EnabledMonadMailboxRuntime>),
}

/// Immutable runtime facts shared by admission and reconciliation.
#[derive(Debug)]
pub struct EnabledMonadMailboxRuntime {
    transport: HttpTransport,
    reconcile: Arc<MonadOutboxReconcileConfig>,
    min_value_wei: u128,
    network_tag: Vec<u8>,
    challenges: MailboxChallengeStore,
}

const CHALLENGE_TTL_MS: i64 = 60_000;
const MAX_CHALLENGES_GLOBAL: usize = 1024;
const MAX_CHALLENGES_PER_RECIPIENT: usize = 8;

/// Public facts a recipient signs to authorize one private request.
#[derive(Debug, Clone, Copy)]
pub struct MailboxChallenge {
    /// Runtime epoch; a restart invalidates every outstanding challenge.
    pub epoch: [u8; 32],
    /// Cryptographically random one-time value.
    pub nonce: [u8; 32],
    /// Absolute expiry in Unix milliseconds.
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy)]
struct PendingChallenge {
    recipient: Address,
    expires_at_ms: i64,
}

#[derive(Debug)]
struct MailboxChallengeStore {
    epoch: [u8; 32],
    pending: Mutex<HashMap<[u8; 32], PendingChallenge>>,
}

impl MailboxChallengeStore {
    fn new() -> Self {
        let mut epoch = [0; 32];
        rand::thread_rng().fill_bytes(&mut epoch);
        Self {
            epoch,
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn issue(&self, recipient: Address, now_ms: i64) -> Option<MailboxChallenge> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.retain(|_, challenge| challenge.expires_at_ms >= now_ms);
        if pending.len() >= MAX_CHALLENGES_GLOBAL
            || pending
                .values()
                .filter(|entry| entry.recipient == recipient)
                .count()
                >= MAX_CHALLENGES_PER_RECIPIENT
        {
            return None;
        }
        let mut nonce = [0; 32];
        loop {
            rand::thread_rng().fill_bytes(&mut nonce);
            if !pending.contains_key(&nonce) {
                break;
            }
        }
        let expires_at_ms = now_ms.saturating_add(CHALLENGE_TTL_MS);
        pending.insert(
            nonce,
            PendingChallenge {
                recipient,
                expires_at_ms,
            },
        );
        Some(MailboxChallenge {
            epoch: self.epoch,
            nonce,
            expires_at_ms,
        })
    }

    fn consume(
        &self,
        recipient: Address,
        nonce: [u8; 32],
        expires_at_ms: i64,
        now_ms: i64,
    ) -> bool {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        pending.retain(|_, challenge| challenge.expires_at_ms >= now_ms);
        if pending.get(&nonce).is_some_and(|challenge| {
            challenge.recipient == recipient
                && challenge.expires_at_ms == expires_at_ms
                && expires_at_ms >= now_ms
        }) {
            pending.remove(&nonce);
            true
        } else {
            false
        }
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
        Self::Enabled(Arc::new(EnabledMonadMailboxRuntime {
            transport,
            reconcile,
            min_value_wei,
            network_tag,
            challenges: MailboxChallengeStore::new(),
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

    /// Frozen aggregate minimum for newly admitted requests.
    pub fn min_value_wei(&self) -> u128 {
        self.min_value_wei
    }

    /// Validated network tag for newly admitted envelopes.
    pub fn network_tag(&self) -> &[u8] {
        &self.network_tag
    }

    /// Issue one bounded, short-lived recipient challenge.
    pub fn issue_challenge(&self, recipient: Address, now_ms: i64) -> Option<MailboxChallenge> {
        self.challenges.issue(recipient, now_ms)
    }

    /// Atomically consume a successfully verified one-time challenge.
    pub fn consume_challenge(
        &self,
        recipient: Address,
        epoch: [u8; 32],
        nonce: [u8; 32],
        expires_at_ms: i64,
        now_ms: i64,
    ) -> bool {
        epoch == self.challenges.epoch
            && self
                .challenges
                .consume(recipient, nonce, expires_at_ms, now_ms)
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

    #[test]
    fn challenge_is_single_use_recipient_bound_and_expiring() {
        let runtime = runtime();
        let enabled = runtime.as_enabled().unwrap();
        let recipient = Address([1; 20]);
        let challenge = enabled.issue_challenge(recipient, 1_000).unwrap();
        assert!(!enabled.consume_challenge(
            Address([2; 20]),
            challenge.epoch,
            challenge.nonce,
            challenge.expires_at_ms,
            1_001,
        ));
        assert!(enabled.consume_challenge(
            recipient,
            challenge.epoch,
            challenge.nonce,
            challenge.expires_at_ms,
            1_001,
        ));
        assert!(!enabled.consume_challenge(
            recipient,
            challenge.epoch,
            challenge.nonce,
            challenge.expires_at_ms,
            1_001,
        ));

        let expired = enabled.issue_challenge(recipient, 2_000).unwrap();
        assert!(!enabled.consume_challenge(
            recipient,
            expired.epoch,
            expired.nonce,
            expired.expires_at_ms,
            expired.expires_at_ms + 1,
        ));
    }

    #[test]
    fn runtime_preserves_shared_config_identity_and_challenge_bound() {
        let config = Arc::new(MonadOutboxReconcileConfig::default());
        let runtime = MonadMailboxRuntime::enabled(
            HttpTransport::new("http://127.0.0.1:1".parse().unwrap()),
            Arc::clone(&config),
            1,
            vec![],
        );
        let enabled = runtime.as_enabled().unwrap();
        assert!(Arc::ptr_eq(enabled.reconcile(), &config));
        for _ in 0..MAX_CHALLENGES_PER_RECIPIENT {
            assert!(enabled.issue_challenge(Address([3; 20]), 0).is_some());
        }
        assert!(enabled.issue_challenge(Address([3; 20]), 0).is_none());
    }
}
