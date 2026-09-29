//! Reconciliation for the durable Monad direct-message payment outbox.
//!
//! Recovery always checks the deterministic exact transaction hash before considering a replay.
//! Each child transition is persisted before the next child is examined, so a restart preserves
//! an already-confirmed prefix without ever treating a competing nonce winner as confirmed.

use std::{sync::Arc, time::Duration};

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{Result, WrapErr};
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use futures::{stream, StreamExt};

use crate::{
    monad_http::{Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_stealth::derive_monad_stamp_child_public,
    monad_stamp_verify::{
        verify_stamp_transaction, ExpectedStampTransaction, StampTransactionVerification,
    },
    proto,
    registry::Registry,
    store::monad_outbox::{
        MonadOutboxLifecycle, MonadOutboxLimits, MonadOutboxMemberState, MonadOutboxTerminal,
    },
};

const PAYMENT_COMMITMENT_DOMAIN: &[u8] = b"frank:dm-stamp-payment:v1";

/// Bounded startup/background reconciliation settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxReconcileConfig {
    /// Durable storage bounds, including claim age/attempt budgets.
    pub limits: MonadOutboxLimits,
    /// Poll delay after an accepted or ambiguous replay.
    pub poll_interval: Duration,
    /// Exact-receipt polls within one persisted attempt.
    pub receipt_poll_attempts: u32,
    /// Exponential delay base between persisted attempts for one member.
    pub retry_backoff_base: Duration,
    /// Ceiling for exponential member retry backoff.
    pub max_retry_backoff: Duration,
    /// Maximum claims reconciled concurrently.
    pub max_concurrency: usize,
    /// Delay between bounded scans after startup.
    pub scan_interval: Duration,
}

impl Default for MonadOutboxReconcileConfig {
    fn default() -> Self {
        Self {
            limits: MonadOutboxLimits::default(),
            poll_interval: Duration::from_millis(500),
            receipt_poll_attempts: 20,
            retry_backoff_base: Duration::from_secs(1),
            max_retry_backoff: Duration::from_secs(5 * 60),
            max_concurrency: 8,
            scan_interval: Duration::from_secs(30),
        }
    }
}

/// Observable outcome of reconciling one payload hash.
#[derive(Debug, Clone, PartialEq)]
pub enum MonadOutboxReconcileOutcome {
    /// Recipient inbox storage is durable.
    Delivered(proto::StoredMonadMessage),
    /// The exact child remains ambiguous and may be retried within its persisted budget.
    Pending,
    /// A permanent outcome was persisted without erasing confirmed-prefix recovery facts.
    Terminal(MonadOutboxTerminal),
    /// No outbox row exists for this payload hash.
    Missing,
}

/// Reconcile one durable claim. Safe to call from HTTP admission or the startup worker.
pub async fn reconcile_monad_outbox<T>(
    transport: &T,
    registry: &Registry,
    payload_hash: &[u8],
    config: &MonadOutboxReconcileConfig,
) -> Result<MonadOutboxReconcileOutcome>
where
    T: JsonRpcTransport + Clone,
{
    let mut record = match registry.monad_outbox_record(payload_hash)? {
        Some(record) => record,
        None => return Ok(MonadOutboxReconcileOutcome::Missing),
    };
    match record.lifecycle {
        MonadOutboxLifecycle::Delivered | MonadOutboxLifecycle::FullyConfirmed => {
            return Ok(MonadOutboxReconcileOutcome::Delivered(
                registry.finalize_monad_outbox(payload_hash, now_ms())?,
            ));
        }
        MonadOutboxLifecycle::Terminal(terminal) => {
            return Ok(MonadOutboxReconcileOutcome::Terminal(terminal));
        }
        MonadOutboxLifecycle::Pending => {}
    }

    let message = crate::store::monad_outbox::DbMonadOutbox::canonical_message(&record)?;
    for payment in &message.stamp_payments {
        let (loaded_record, member, raw_tx) =
            match registry.monad_outbox_referenced_raw_tx(payload_hash, payment.child_index) {
                Ok(referenced) => referenced,
                Err(err) => {
                    registry.terminal_monad_outbox_claim(
                        payload_hash,
                        MonadOutboxTerminal::CorruptReference,
                        &err.to_string(),
                        now_ms(),
                        &config.limits,
                    )?;
                    return Ok(MonadOutboxReconcileOutcome::Terminal(
                        MonadOutboxTerminal::CorruptReference,
                    ));
                }
            };
        record = loaded_record;
        match member.state {
            MonadOutboxMemberState::Confirmed { .. } => continue,
            MonadOutboxMemberState::Terminal(terminal) => {
                return Ok(MonadOutboxReconcileOutcome::Terminal(terminal));
            }
            MonadOutboxMemberState::Pending => {}
        }
        if member.attempts > 0
            && now_ms().saturating_sub(member.updated_at_ms)
                < retry_backoff_ms(member.attempts, config)
        {
            return Ok(MonadOutboxReconcileOutcome::Pending);
        }

        let started = registry.begin_monad_outbox_attempt(
            payload_hash,
            payment.child_index,
            now_ms(),
            &config.limits,
        )?;
        if let MonadOutboxMemberState::Terminal(terminal) = started.state {
            return Ok(MonadOutboxReconcileOutcome::Terminal(terminal));
        }

        let expected = match expected_payment(&record, payment.child_index, payload_hash) {
            Ok(expected) => expected,
            Err(err) => {
                registry.terminal_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    MonadOutboxTerminal::CorruptReference,
                    &err.to_string(),
                    now_ms(),
                    &config.limits,
                )?;
                return Ok(MonadOutboxReconcileOutcome::Terminal(
                    MonadOutboxTerminal::CorruptReference,
                ));
            }
        };

        match reconcile_member(transport, member.tx_hash, &raw_tx, &expected, config).await {
            MemberOutcome::Confirmed {
                value_wei,
                block_number,
            } => registry.confirm_monad_outbox_member(
                payload_hash,
                payment.child_index,
                value_wei,
                block_number,
                now_ms(),
            )?,
            MemberOutcome::Pending(detail) => {
                registry.record_monad_outbox_pending_error(
                    payload_hash,
                    payment.child_index,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return Ok(MonadOutboxReconcileOutcome::Pending);
            }
            MemberOutcome::Terminal(terminal, detail) => {
                registry.terminal_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    terminal,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return Ok(MonadOutboxReconcileOutcome::Terminal(terminal));
            }
        }
    }

    if !registry.mark_monad_outbox_fully_confirmed(payload_hash, now_ms())? {
        let lifecycle = registry
            .monad_outbox_record(payload_hash)?
            .map(|record| record.lifecycle);
        return Ok(match lifecycle {
            Some(MonadOutboxLifecycle::Terminal(terminal)) => {
                MonadOutboxReconcileOutcome::Terminal(terminal)
            }
            _ => MonadOutboxReconcileOutcome::Pending,
        });
    }
    Ok(MonadOutboxReconcileOutcome::Delivered(
        registry.finalize_monad_outbox(payload_hash, now_ms())?,
    ))
}

fn expected_payment(
    record: &crate::store::monad_outbox::MonadOutboxRecord,
    child_index: u32,
    payload_hash: &[u8],
) -> Result<ExpectedStampTransaction> {
    let payload_hash: [u8; 32] = payload_hash.try_into().map_err(|_| {
        crate::store::monad_outbox::DbMonadOutboxError::InvalidPayloadHashLength(payload_hash.len())
    })?;
    let derived =
        derive_monad_stamp_child_public(payload_hash, &record.policy.recipient_pubkey, child_index)
            .wrap_err("deriving frozen recipient child")?;
    Ok(ExpectedStampTransaction {
        commitment_id: BROADCAST_MESSAGE_LOKAD_ID,
        commitment: payment_commitment(&payload_hash, child_index),
        destination_address: crate::monad_http::Address(derived.address),
        min_value_wei: 1,
    })
}

fn payment_commitment(payload_hash: &[u8; 32], child_index: u32) -> Sha256 {
    let mut preimage = Vec::with_capacity(PAYMENT_COMMITMENT_DOMAIN.len() + 36);
    preimage.extend_from_slice(PAYMENT_COMMITMENT_DOMAIN);
    preimage.extend_from_slice(payload_hash);
    preimage.extend_from_slice(&child_index.to_be_bytes());
    Sha256::digest(preimage.into())
}

enum MemberOutcome {
    Confirmed { value_wei: u128, block_number: u64 },
    Pending(String),
    Terminal(MonadOutboxTerminal, String),
}

enum ExactCheck {
    Missing,
    Confirmed { value_wei: u128, block_number: u64 },
    Invalid(String),
    Infrastructure(String),
}

async fn check_exact<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    expected: &ExpectedStampTransaction,
) -> ExactCheck {
    let client = MonadHttpClient::with_transport(transport.clone());
    let receipt = match client.get_transaction_receipt(tx_hash).await {
        Ok(Some(receipt)) => receipt,
        Ok(None) => return ExactCheck::Missing,
        Err(err) => return ExactCheck::Infrastructure(err.to_string()),
    };
    if receipt.transaction_hash != tx_hash {
        return ExactCheck::Invalid(format!(
            "receipt returned hash {} for requested exact hash {}",
            receipt.transaction_hash, tx_hash
        ));
    }
    match client.get_transaction_by_hash(tx_hash).await {
        Ok(Some(transaction)) if transaction.hash == tx_hash => {}
        Ok(Some(transaction)) => {
            return ExactCheck::Invalid(format!(
                "transaction lookup returned hash {} for requested exact hash {}",
                transaction.hash, tx_hash
            ))
        }
        Ok(None) => {
            return ExactCheck::Infrastructure(
                "exact receipt exists but transaction lookup returned nothing".to_string(),
            )
        }
        Err(err) => return ExactCheck::Infrastructure(err.to_string()),
    }
    match verify_stamp_transaction(transport, tx_hash, expected).await {
        Ok(StampTransactionVerification::Verified { value_wei }) => ExactCheck::Confirmed {
            value_wei,
            block_number: receipt.block_number,
        },
        Ok(StampTransactionVerification::TxNotConfirmed) => {
            ExactCheck::Infrastructure("exact receipt disappeared during verification".to_string())
        }
        Ok(other) => {
            ExactCheck::Invalid(format!("exact transaction failed verification: {other:?}"))
        }
        Err(err) => ExactCheck::Infrastructure(err.to_string()),
    }
}

async fn poll_exact<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> ExactCheck {
    let attempts = config.receipt_poll_attempts.max(1);
    for attempt in 0..attempts {
        let check = check_exact(transport, tx_hash, expected).await;
        if !matches!(check, ExactCheck::Missing) || attempt + 1 == attempts {
            return check;
        }
        tokio::time::sleep(config.poll_interval).await;
    }
    ExactCheck::Missing
}

async fn reconcile_member<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    raw_tx: &[u8],
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> MemberOutcome {
    match check_exact(transport, tx_hash, expected).await {
        ExactCheck::Confirmed {
            value_wei,
            block_number,
        } => {
            return MemberOutcome::Confirmed {
                value_wei,
                block_number,
            }
        }
        ExactCheck::Invalid(detail) => {
            return MemberOutcome::Terminal(MonadOutboxTerminal::VerificationFailed, detail)
        }
        ExactCheck::Infrastructure(detail) => return MemberOutcome::Pending(detail),
        ExactCheck::Missing => {}
    }

    let client = MonadHttpClient::with_transport(transport.clone());
    let stale_if_missing = match client.send_raw_transaction(raw_tx).await {
        Ok(submitted) if submitted.tx_hash != tx_hash => {
            return MemberOutcome::Terminal(
                MonadOutboxTerminal::CorruptReference,
                format!(
                    "RPC returned {} for canonical transaction hash {}",
                    submitted.tx_hash, tx_hash
                ),
            )
        }
        Ok(_) | Err(MonadRpcError::AlreadyKnown { .. }) => false,
        Err(MonadRpcError::NonceTooLow { .. })
        | Err(MonadRpcError::ReplacementUnderpriced { .. }) => true,
        Err(err @ MonadRpcError::InsufficientFunds { .. }) => {
            return MemberOutcome::Terminal(MonadOutboxTerminal::BroadcastRejected, err.to_string())
        }
        Err(err) => return MemberOutcome::Pending(err.to_string()),
    };

    match poll_exact(transport, tx_hash, expected, config).await {
        ExactCheck::Confirmed {
            value_wei,
            block_number,
        } => MemberOutcome::Confirmed {
            value_wei,
            block_number,
        },
        ExactCheck::Invalid(detail) => {
            MemberOutcome::Terminal(MonadOutboxTerminal::VerificationFailed, detail)
        }
        ExactCheck::Infrastructure(detail) => MemberOutcome::Pending(detail),
        ExactCheck::Missing if stale_if_missing => MemberOutcome::Terminal(
            MonadOutboxTerminal::StaleNonce,
            "funding nonce was consumed but the exact transaction hash has no receipt".to_string(),
        ),
        ExactCheck::Missing => MemberOutcome::Pending(
            "exact transaction remains unconfirmed after bounded polling".to_string(),
        ),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn retry_backoff_ms(attempts: u32, config: &MonadOutboxReconcileConfig) -> i64 {
    let exponent = attempts.saturating_sub(1).min(31);
    let multiplier = 1u128 << exponent;
    config
        .retry_backoff_base
        .as_millis()
        .saturating_mul(multiplier)
        .min(config.max_retry_backoff.as_millis())
        .try_into()
        .unwrap_or(i64::MAX)
}

/// Long-lived startup worker with explicit shutdown ownership.
#[derive(Debug)]
pub struct MonadOutboxWorker {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl MonadOutboxWorker {
    /// Stop future scans and await the owned task.
    pub async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = (&mut self.join).await;
    }
}

impl Drop for MonadOutboxWorker {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join.abort();
    }
}

/// Start an immediate bounded scan followed by bounded periodic reconciliation.
pub fn start_monad_outbox_worker<T>(
    transport: T,
    registry: Arc<Registry>,
    config: MonadOutboxReconcileConfig,
) -> MonadOutboxWorker
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    let join = tokio::spawn(async move {
        loop {
            if let Err(err) = reconcile_active(&transport, &registry, &config).await {
                tracing::event!(
                    tracing::Level::ERROR,
                    error = %err,
                    "Monad outbox reconciliation scan failed"
                );
            }
            tokio::select! {
                _ = tokio::time::sleep(config.scan_interval) => {}
                _ = &mut shutdown_rx => break,
            }
        }
    });
    MonadOutboxWorker {
        shutdown: Some(shutdown_tx),
        join,
    }
}

async fn reconcile_active<T>(
    transport: &T,
    registry: &Arc<Registry>,
    config: &MonadOutboxReconcileConfig,
) -> Result<()>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    let active = registry.list_active_monad_outboxes(config.limits.max_active_claims)?;
    let concurrency = config.max_concurrency.max(1);
    stream::iter(active)
        .for_each_concurrent(concurrency, |payload_hash| async move {
            if let Err(err) =
                reconcile_monad_outbox(transport, registry, &payload_hash, config).await
            {
                tracing::event!(
                    tracing::Level::ERROR,
                    payload_hash = %hex::encode(payload_hash),
                    error = %err,
                    "Monad outbox claim reconciliation failed"
                );
            }
        })
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use async_trait::async_trait;
    use bitcoinsuite_core::Net;
    use serde_json::{json, Value};
    use sha3::{Digest, Keccak256};

    use super::*;
    use crate::{
        disabled_chain_adapter::DisabledChainAdapter,
        monad_http::Address,
        store::{
            db::Db,
            monad_outbox::{MonadOutboxClaim, MonadOutboxPolicy},
        },
    };

    #[derive(Debug, Clone, Copy)]
    enum SendBehavior {
        Accept,
        RpcFailure,
        NonceTooLow,
    }

    #[derive(Debug, Clone)]
    struct TxSpec {
        raw_tx: Vec<u8>,
        destination: Address,
        value_wei: u128,
        input: Vec<u8>,
        confirmed: bool,
        send: SendBehavior,
    }

    #[derive(Debug, Clone, Default)]
    struct FakeTransport {
        specs: Arc<Mutex<HashMap<Hash32, TxSpec>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl FakeTransport {
        fn insert(&self, spec: TxSpec) -> Hash32 {
            let hash = Hash32(Keccak256::digest(&spec.raw_tx).into());
            self.specs.lock().unwrap().insert(hash, spec);
            hash
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for FakeTransport {
        async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            let requested_hash =
                || Hash32::from_hex(params[0].as_str().expect("hash param")).expect("valid hash");
            match method {
                "eth_getTransactionReceipt" => {
                    let hash = requested_hash();
                    let specs = self.specs.lock().unwrap();
                    let spec = specs.get(&hash).expect("known hash");
                    if !spec.confirmed {
                        return Ok(Value::Null);
                    }
                    Ok(json!({
                        "transactionHash": hash.to_hex(),
                        "blockHash": Hash32([0x22; 32]).to_hex(),
                        "blockNumber": "0x2a",
                        "from": Address([0x33; 20]).to_hex(),
                        "to": spec.destination.to_hex(),
                        "contractAddress": null,
                        "gasUsed": "0x5208",
                        "status": "0x1",
                        "logs": [],
                    }))
                }
                "eth_getTransactionByHash" => {
                    let hash = requested_hash();
                    let specs = self.specs.lock().unwrap();
                    let spec = specs.get(&hash).expect("known hash");
                    Ok(json!({
                        "hash": hash.to_hex(),
                        "to": spec.destination.to_hex(),
                        "value": format!("0x{:x}", spec.value_wei),
                        "input": format!("0x{}", hex::encode(&spec.input)),
                        "from": Address([0x33; 20]).to_hex(),
                    }))
                }
                "eth_sendRawTransaction" => {
                    let raw = hex::decode(params[0].as_str().unwrap().strip_prefix("0x").unwrap())
                        .unwrap();
                    let hash = Hash32(Keccak256::digest(&raw).into());
                    let mut specs = self.specs.lock().unwrap();
                    let spec = specs.get_mut(&hash).expect("known raw tx");
                    match spec.send {
                        SendBehavior::Accept => {
                            spec.confirmed = true;
                            Ok(Value::String(hash.to_hex()))
                        }
                        SendBehavior::RpcFailure => Err(MonadRpcError::Rpc {
                            method: method.to_string(),
                            code: -1,
                            message: "temporary failure".to_string(),
                            data: None,
                        }),
                        SendBehavior::NonceTooLow => Err(MonadRpcError::NonceTooLow {
                            method: method.to_string(),
                            message: "nonce too low".to_string(),
                        }),
                    }
                }
                _ => panic!("unexpected method {method}"),
            }
        }
    }

    fn registry(path: &std::path::Path) -> Registry {
        Registry::new(
            Db::open(path).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        )
    }

    fn fixture(
        behaviors: &[SendBehavior],
        confirmed: &[bool],
    ) -> (proto::MonadStampedMessage, MonadOutboxPolicy, FakeTransport) {
        let encrypted_payload = b"durable crash fixture".to_vec();
        let payload_hash: [u8; 32] = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .try_into()
            .unwrap();
        let recipient_pubkey = vec![2; 33];
        let transport = FakeTransport::default();
        let mut payments = Vec::new();
        for (index, behavior) in behaviors.iter().copied().enumerate() {
            let child =
                derive_monad_stamp_child_public(payload_hash, &recipient_pubkey, index as u32)
                    .unwrap();
            let commitment = payment_commitment(&payload_hash, index as u32);
            let mut input = Vec::from(BROADCAST_MESSAGE_LOKAD_ID);
            input.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
            input.extend_from_slice(commitment.as_slice());
            let raw_tx = format!("raw-child-{index}").into_bytes();
            transport.insert(TxSpec {
                raw_tx: raw_tx.clone(),
                destination: Address(child.address),
                value_wei: 10,
                input,
                confirmed: confirmed[index],
                send: behavior,
            });
            payments.push(proto::MonadStampPayment {
                child_index: index as u32,
                raw_tx,
            });
        }
        (
            proto::MonadStampedMessage {
                encrypted_payload,
                payload_hash: payload_hash.to_vec(),
                stamp_payments: payments,
            },
            MonadOutboxPolicy {
                recipient: Address([0x44; 20]),
                recipient_pubkey,
                min_value_wei: (behaviors.len() as u128) * 10,
                network_tag: b"testnet".to_vec(),
            },
            transport,
        )
    }

    fn fast_config() -> MonadOutboxReconcileConfig {
        MonadOutboxReconcileConfig {
            poll_interval: Duration::from_millis(1),
            receipt_poll_attempts: 1,
            retry_backoff_base: Duration::ZERO,
            max_retry_backoff: Duration::ZERO,
            scan_interval: Duration::from_millis(5),
            ..MonadOutboxReconcileConfig::default()
        }
    }

    #[tokio::test]
    async fn partial_prefix_survives_crash_and_startup_resume_delivers() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-crash")?;
        let path = tempdir.path().join("db.rocksdb");
        let (request, policy, first_transport) = fixture(
            &[SendBehavior::Accept, SendBehavior::RpcFailure],
            &[true, false],
        );
        let payload_hash = request.payload_hash.clone();
        {
            let registry = registry(&path);
            assert_eq!(
                registry.claim_monad_outbox(
                    &request,
                    &policy,
                    now_ms(),
                    &MonadOutboxLimits::default(),
                )?,
                MonadOutboxClaim::New
            );
            assert_eq!(
                reconcile_monad_outbox(&first_transport, &registry, &payload_hash, &fast_config())
                    .await?,
                MonadOutboxReconcileOutcome::Pending
            );
            assert!(matches!(
                registry
                    .monad_outbox_member(&payload_hash, 0)?
                    .unwrap()
                    .state,
                MonadOutboxMemberState::Confirmed { .. }
            ));
        }

        let registry = registry(&path);
        let (_, _, resumed_transport) = fixture(
            &[SendBehavior::Accept, SendBehavior::Accept],
            &[false, true],
        );
        let outcome =
            reconcile_monad_outbox(&resumed_transport, &registry, &payload_hash, &fast_config())
                .await?;
        assert!(matches!(outcome, MonadOutboxReconcileOutcome::Delivered(_)));
        assert_eq!(
            resumed_transport
                .calls()
                .iter()
                .filter(|method| method.as_str() == "eth_sendRawTransaction")
                .count(),
            0,
            "resume must query the exact second hash and must not replay the confirmed prefix"
        );
        assert!(registry.get_monad_message(&payload_hash)?.is_some());
        Ok(())
    }

    #[tokio::test]
    async fn stale_nonce_is_terminal_and_not_confirmed() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-stale")?;
        let path = tempdir.path().join("db.rocksdb");
        let registry = registry(&path);
        let (request, policy, transport) = fixture(
            &[SendBehavior::Accept, SendBehavior::NonceTooLow],
            &[true, false],
        );
        registry.claim_monad_outbox(&request, &policy, now_ms(), &MonadOutboxLimits::default())?;
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &fast_config(),)
                .await?,
            MonadOutboxReconcileOutcome::Terminal(MonadOutboxTerminal::StaleNonce)
        );
        assert!(matches!(
            registry
                .monad_outbox_member(&request.payload_hash, 1)?
                .unwrap()
                .state,
            MonadOutboxMemberState::Terminal(MonadOutboxTerminal::StaleNonce)
        ));
        let recoveries = registry.confirmed_monad_outbox_prefixes(policy.recipient, 10)?;
        assert_eq!(recoveries.len(), 1);
        assert_eq!(recoveries[0].confirmed_prefix.len(), 1);
        assert!(registry.get_monad_message(&request.payload_hash)?.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn owned_startup_worker_enumerates_and_delivers_active_claim() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-worker")?;
        let path = tempdir.path().join("db.rocksdb");
        let registry = Arc::new(registry(&path));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        registry.claim_monad_outbox(&request, &policy, now_ms(), &MonadOutboxLimits::default())?;
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), fast_config());
        for _ in 0..50 {
            if registry.get_monad_message(&request.payload_hash)?.is_some() {
                worker.shutdown().await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        worker.shutdown().await;
        panic!("startup worker did not deliver the active claim")
    }
}
