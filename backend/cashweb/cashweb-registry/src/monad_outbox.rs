//! Reconciliation for the durable Monad direct-message payment outbox.
//!
//! Recovery always checks the deterministic exact transaction hash before considering a replay.
//! Each child transition is persisted before the next child is examined, so a restart preserves
//! an already-confirmed prefix without ever treating a competing nonce winner as confirmed.

use std::{sync::Arc, time::Duration};

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{bail, Result, WrapErr};
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use futures::{stream, StreamExt};

use crate::{
    monad_evm_tx::decode_signed_transaction,
    monad_http::{Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_stealth::derive_monad_stamp_child_public,
    monad_stamp_verify::{parse_commitment_calldata, ExpectedStampTransaction},
    proto,
    registry::Registry,
    store::monad_outbox::{
        MonadOutboxLeaseAcquire, MonadOutboxLifecycle, MonadOutboxLimits, MonadOutboxMemberState,
        MonadOutboxReplayStart, MonadOutboxTerminal, MonadOutboxTransition,
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
    /// Maximum claims reconciled concurrently.
    pub max_concurrency: usize,
    /// Delay between bounded scans after startup.
    pub scan_interval: Duration,
    /// Deadline for one transport operation (including exact verification's bounded RPC group).
    pub rpc_timeout: Duration,
    /// Deadline for one claim so a stalled transport cannot starve later active claims.
    pub claim_timeout: Duration,
    /// Maximum graceful worker shutdown wait before the owned task is aborted.
    pub shutdown_grace: Duration,
    /// Whole initial recovery scan deadline; expiry fails startup before readiness.
    pub initial_recovery_timeout: Duration,
}

impl Default for MonadOutboxReconcileConfig {
    fn default() -> Self {
        Self {
            limits: MonadOutboxLimits::default(),
            poll_interval: Duration::from_millis(500),
            receipt_poll_attempts: 20,
            max_concurrency: 8,
            scan_interval: Duration::from_secs(30),
            rpc_timeout: Duration::from_secs(10),
            claim_timeout: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(5),
            initial_recovery_timeout: Duration::from_secs(2 * 60),
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
    config.limits.validate()?;
    match tokio::time::timeout(
        config.claim_timeout,
        reconcile_monad_outbox_inner(transport, registry, payload_hash, config),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => bail!("Monad outbox claim reconciliation deadline elapsed"),
    }
}

async fn reconcile_monad_outbox_inner<T>(
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
                registry.finalize_monad_outbox(payload_hash, now_ms(), &config.limits)?,
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
                    let transition = registry.terminal_monad_outbox_claim(
                        payload_hash,
                        MonadOutboxTerminal::CorruptReference,
                        &err.to_string(),
                        now_ms(),
                        &config.limits,
                    )?;
                    return if transition == MonadOutboxTransition::Applied {
                        Ok(MonadOutboxReconcileOutcome::Terminal(
                            MonadOutboxTerminal::CorruptReference,
                        ))
                    } else {
                        current_outcome(registry, payload_hash, config)
                    };
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
        let expected = match expected_payment(&record, payment.child_index, payload_hash) {
            Ok(expected) => expected,
            Err(err) => {
                let transition = registry.terminal_monad_outbox_claim(
                    payload_hash,
                    MonadOutboxTerminal::CorruptReference,
                    &err.to_string(),
                    now_ms(),
                    &config.limits,
                )?;
                return if transition == MonadOutboxTransition::Applied {
                    Ok(MonadOutboxReconcileOutcome::Terminal(
                        MonadOutboxTerminal::CorruptReference,
                    ))
                } else {
                    current_outcome(registry, payload_hash, config)
                };
            }
        };

        let lease = match registry.acquire_monad_outbox_reconcile_lease(
            payload_hash,
            payment.child_index,
            now_ms(),
            &config.limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            MonadOutboxLeaseAcquire::Busy => return Ok(MonadOutboxReconcileOutcome::Pending),
            MonadOutboxLeaseAcquire::NotPending(MonadOutboxMemberState::Confirmed { .. }) => {
                continue
            }
            MonadOutboxLeaseAcquire::NotPending(MonadOutboxMemberState::Terminal(terminal))
            | MonadOutboxLeaseAcquire::Terminal(terminal) => {
                return Ok(MonadOutboxReconcileOutcome::Terminal(terminal))
            }
            MonadOutboxLeaseAcquire::NotPending(MonadOutboxMemberState::Pending) => {
                return current_outcome(registry, payload_hash, config)
            }
        };

        match check_exact_bounded(transport, member.tx_hash, &expected, config).await {
            ExactCheck::Confirmed {
                value_wei,
                block_number,
            } => {
                let transition = registry.complete_confirmed_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    value_wei,
                    block_number,
                    now_ms(),
                )?;
                if transition == MonadOutboxTransition::Stale {
                    match current_outcome(registry, payload_hash, config)? {
                        MonadOutboxReconcileOutcome::Pending => continue,
                        outcome => return Ok(outcome),
                    }
                }
                continue;
            }
            ExactCheck::Invalid(detail) => {
                let transition = registry.complete_terminal_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    MonadOutboxTerminal::VerificationFailed,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return if transition == MonadOutboxTransition::Applied {
                    Ok(MonadOutboxReconcileOutcome::Terminal(
                        MonadOutboxTerminal::VerificationFailed,
                    ))
                } else {
                    current_outcome(registry, payload_hash, config)
                };
            }
            ExactCheck::Infrastructure(detail) => {
                tracing::event!(
                    tracing::Level::WARN,
                    payload_hash = %hex::encode(payload_hash),
                    child_index = payment.child_index,
                    error = %detail,
                    "Exact Monad transaction lookup remains ambiguous"
                );
                registry.complete_pending_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return Ok(MonadOutboxReconcileOutcome::Pending);
            }
            ExactCheck::Missing => {}
        }

        if now_ms() < member.next_replay_at_ms {
            registry.release_monad_outbox_reconcile_lease(
                payload_hash,
                payment.child_index,
                lease,
            )?;
            return Ok(MonadOutboxReconcileOutcome::Pending);
        }
        match registry.begin_monad_outbox_replay_attempt(
            payload_hash,
            payment.child_index,
            lease,
            now_ms(),
            &config.limits,
        )? {
            MonadOutboxReplayStart::Started(_) => {}
            MonadOutboxReplayStart::Stale => {
                return current_outcome(registry, payload_hash, config)
            }
            MonadOutboxReplayStart::Terminal(terminal) => {
                return Ok(MonadOutboxReconcileOutcome::Terminal(terminal))
            }
        }

        match replay_member(transport, member.tx_hash, &raw_tx, &expected, config).await {
            MemberOutcome::Confirmed {
                value_wei,
                block_number,
            } => {
                let transition = registry.complete_confirmed_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    value_wei,
                    block_number,
                    now_ms(),
                )?;
                if transition == MonadOutboxTransition::Stale {
                    match current_outcome(registry, payload_hash, config)? {
                        MonadOutboxReconcileOutcome::Pending => continue,
                        outcome => return Ok(outcome),
                    }
                }
            }
            MemberOutcome::Pending(detail) => {
                registry.complete_pending_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return Ok(MonadOutboxReconcileOutcome::Pending);
            }
            MemberOutcome::Terminal(terminal, detail) => {
                let transition = registry.complete_terminal_monad_outbox_member(
                    payload_hash,
                    payment.child_index,
                    lease,
                    terminal,
                    &detail,
                    now_ms(),
                    &config.limits,
                )?;
                return if transition == MonadOutboxTransition::Applied {
                    Ok(MonadOutboxReconcileOutcome::Terminal(terminal))
                } else {
                    current_outcome(registry, payload_hash, config)
                };
            }
        }
    }

    if !registry.mark_monad_outbox_fully_confirmed(payload_hash, now_ms())? {
        return current_outcome(registry, payload_hash, config);
    }
    Ok(MonadOutboxReconcileOutcome::Delivered(
        registry.finalize_monad_outbox(payload_hash, now_ms(), &config.limits)?,
    ))
}

fn current_outcome(
    registry: &Registry,
    payload_hash: &[u8],
    config: &MonadOutboxReconcileConfig,
) -> Result<MonadOutboxReconcileOutcome> {
    Ok(match registry.monad_outbox_record(payload_hash)? {
        None => MonadOutboxReconcileOutcome::Missing,
        Some(record) => match record.lifecycle {
            MonadOutboxLifecycle::Delivered => MonadOutboxReconcileOutcome::Delivered(
                registry.finalize_monad_outbox(payload_hash, now_ms(), &config.limits)?,
            ),
            MonadOutboxLifecycle::Terminal(terminal) => {
                MonadOutboxReconcileOutcome::Terminal(terminal)
            }
            MonadOutboxLifecycle::FullyConfirmed => MonadOutboxReconcileOutcome::Delivered(
                registry.finalize_monad_outbox(payload_hash, now_ms(), &config.limits)?,
            ),
            MonadOutboxLifecycle::Pending => MonadOutboxReconcileOutcome::Pending,
        },
    })
}

fn expected_payment(
    record: &crate::store::monad_outbox::MonadOutboxRecord,
    child_index: u32,
    payload_hash: &[u8],
) -> Result<ExpectedStampTransaction> {
    let payload_hash: [u8; 32] = payload_hash.try_into().map_err(|_| {
        crate::store::monad_outbox::DbMonadOutboxError::InvalidPayloadHashLength(payload_hash.len())
    })?;
    let policy = record.policy.as_ref().ok_or_else(|| {
        crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
            "active reconciliation record has no frozen policy".to_string(),
        )
    })?;
    let derived =
        derive_monad_stamp_child_public(payload_hash, &policy.recipient_pubkey, child_index)
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
        return ExactCheck::Infrastructure(format!(
            "receipt returned hash {} for requested exact hash {}",
            receipt.transaction_hash, tx_hash
        ));
    }
    let transaction = match client.get_transaction_by_hash(tx_hash).await {
        Ok(Some(transaction)) if transaction.hash == tx_hash => transaction,
        Ok(Some(transaction)) => {
            return ExactCheck::Infrastructure(format!(
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
    };
    if receipt.from != transaction.from || receipt.to != transaction.to {
        return ExactCheck::Infrastructure(
            "receipt and transaction RPC responses disagree on routing identity".to_string(),
        );
    }
    if receipt.succeeded() != Some(true) {
        return ExactCheck::Invalid("exact transaction reverted".to_string());
    }
    if receipt.to != Some(expected.destination_address) {
        return ExactCheck::Invalid(format!(
            "exact transaction has wrong recipient: expected {}, got {:?}",
            expected.destination_address, receipt.to
        ));
    }
    if transaction.value < expected.min_value_wei {
        return ExactCheck::Invalid(format!(
            "exact transaction value {} is below minimum {}",
            transaction.value, expected.min_value_wei
        ));
    }
    let commitment = match parse_commitment_calldata(expected.commitment_id, &transaction.input) {
        Ok(commitment) => commitment,
        Err(err) => return ExactCheck::Invalid(err.to_string()),
    };
    if commitment != expected.commitment {
        return ExactCheck::Invalid(format!(
            "exact transaction commitment {} does not match {}",
            commitment, expected.commitment
        ));
    }
    ExactCheck::Confirmed {
        value_wei: transaction.value,
        block_number: receipt.block_number,
    }
}

async fn check_exact_bounded<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> ExactCheck {
    match tokio::time::timeout(
        config.rpc_timeout,
        check_exact(transport, tx_hash, expected),
    )
    .await
    {
        Ok(check) => check,
        Err(_) => ExactCheck::Infrastructure("exact transaction RPC deadline elapsed".to_string()),
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
        let check = check_exact_bounded(transport, tx_hash, expected, config).await;
        if !matches!(check, ExactCheck::Missing) || attempt + 1 == attempts {
            return check;
        }
        tokio::time::sleep(config.poll_interval).await;
    }
    ExactCheck::Missing
}

async fn replay_member<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    raw_tx: &[u8],
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> MemberOutcome {
    let client = MonadHttpClient::with_transport(transport.clone());
    let send =
        match tokio::time::timeout(config.rpc_timeout, client.send_raw_transaction(raw_tx)).await {
            Ok(send) => send,
            Err(_) => return MemberOutcome::Pending("broadcast RPC deadline elapsed".to_string()),
        };
    let nonce_too_low = match send {
        Ok(submitted) if submitted.tx_hash != tx_hash => {
            return MemberOutcome::Pending(format!(
                "submission RPC returned {} for canonical transaction hash {}",
                submitted.tx_hash, tx_hash
            ))
        }
        Ok(_) | Err(MonadRpcError::AlreadyKnown { .. }) => false,
        Err(MonadRpcError::NonceTooLow { .. }) => true,
        Err(err @ MonadRpcError::ReplacementUnderpriced { .. }) => {
            return MemberOutcome::Pending(err.to_string())
        }
        Err(err @ MonadRpcError::InsufficientFunds { .. }) => {
            return MemberOutcome::Pending(err.to_string())
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
        ExactCheck::Missing if nonce_too_low => {
            prove_stale_nonce(transport, tx_hash, raw_tx, expected, config).await
        }
        ExactCheck::Missing => MemberOutcome::Pending(
            "exact transaction remains unconfirmed after bounded polling".to_string(),
        ),
    }
}

async fn prove_stale_nonce<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    raw_tx: &[u8],
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> MemberOutcome {
    let decoded = match decode_signed_transaction(raw_tx) {
        Ok(decoded) => decoded,
        Err(err) => {
            return MemberOutcome::Terminal(
                MonadOutboxTerminal::CorruptReference,
                format!("canonical transaction cannot be decoded: {err}"),
            )
        }
    };
    let nonce_result = tokio::time::timeout(
        config.rpc_timeout,
        transport.call(
            "eth_getTransactionCount",
            serde_json::json!([decoded.sender.to_hex(), "latest"]),
        ),
    )
    .await;
    let confirmed_nonce = match nonce_result {
        Err(_) => return MemberOutcome::Pending("account nonce RPC deadline elapsed".to_string()),
        Ok(Err(err)) => return MemberOutcome::Pending(err.to_string()),
        Ok(Ok(value)) => match value.as_str().and_then(parse_hex_u64) {
            Some(nonce) => nonce,
            None => {
                return MemberOutcome::Pending(format!(
                    "account nonce RPC returned invalid quantity {value}"
                ))
            }
        },
    };
    if confirmed_nonce <= decoded.nonce {
        return MemberOutcome::Pending(format!(
            "nonce-too-low response is not confirmed: account nonce {confirmed_nonce}, canonical nonce {}",
            decoded.nonce
        ));
    }

    match check_exact_bounded(transport, tx_hash, expected, config).await {
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
        ExactCheck::Missing => MemberOutcome::Terminal(
            MonadOutboxTerminal::StaleNonce,
            format!(
                "confirmed account nonce {confirmed_nonce} advanced past canonical nonce {}, and final exact lookup was missing",
                decoded.nonce
            ),
        ),
    }
}

fn parse_hex_u64(value: &str) -> Option<u64> {
    value.strip_prefix("0x").and_then(|digits| {
        u64::from_str_radix(if digits.is_empty() { "0" } else { digits }, 16).ok()
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

/// Long-lived startup worker with explicit shutdown ownership.
#[derive(Debug)]
pub struct MonadOutboxWorker {
    shutdown: tokio::sync::watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
    shutdown_grace: Duration,
}

impl MonadOutboxWorker {
    /// Stop future scans and await the owned task.
    pub async fn shutdown(mut self) {
        let _ = self.shutdown.send(true);
        if tokio::time::timeout(self.shutdown_grace, &mut self.join)
            .await
            .is_err()
        {
            self.join.abort();
            let _ = (&mut self.join).await;
        }
    }
}

impl Drop for MonadOutboxWorker {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.join.abort();
    }
}

/// Start an immediate bounded scan followed by bounded periodic reconciliation.
pub async fn start_monad_outbox_worker<T>(
    transport: T,
    registry: Arc<Registry>,
    config: MonadOutboxReconcileConfig,
) -> Result<MonadOutboxWorker>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    config.limits.validate()?;
    // Readiness is intentionally after this bounded initial scan. Each exact RPC, claim, active
    // cardinality, and concurrency dimension has a finite configured ceiling.
    tokio::time::timeout(
        config.initial_recovery_timeout,
        reconcile_active(&transport, &registry, &config, true),
    )
    .await
    .wrap_err("Monad outbox initial recovery deadline elapsed")??;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown_grace = config.shutdown_grace;
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(config.scan_interval) => {}
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
            }
            let scan = reconcile_active(&transport, &registry, &config, false);
            tokio::select! {
                result = scan => {
                    if let Err(err) = result {
                        tracing::event!(
                            tracing::Level::ERROR,
                            error = %err,
                            "Monad outbox reconciliation scan failed"
                        );
                    }
                }
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });
    Ok(MonadOutboxWorker {
        shutdown: shutdown_tx,
        join,
        shutdown_grace,
    })
}

async fn reconcile_active<T>(
    transport: &T,
    registry: &Arc<Registry>,
    config: &MonadOutboxReconcileConfig,
    fail_on_claim_error: bool,
) -> Result<()>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    let active = registry.list_active_monad_outboxes(config.limits.max_active_claims)?;
    let concurrency = config.max_concurrency.max(1);
    let mut reconciliations = stream::iter(active)
        .map(|payload_hash| async move {
            let result = reconcile_monad_outbox(transport, registry, &payload_hash, config).await;
            (payload_hash, result)
        })
        .buffer_unordered(concurrency);
    while let Some((payload_hash, result)) = reconciliations.next().await {
        if let Err(err) = result {
            if fail_on_claim_error {
                return Err(err).wrap_err_with(|| {
                    format!(
                        "initial Monad outbox reconciliation failed for {}",
                        hex::encode(payload_hash)
                    )
                });
            } else {
                tracing::event!(
                    tracing::Level::ERROR,
                    payload_hash = %hex::encode(payload_hash),
                    error = %err,
                    "Monad outbox claim reconciliation failed"
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use async_trait::async_trait;
    use bitcoinsuite_core::{ecc::Ecc, Net};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use serde_json::{json, Value};
    use sha3::{Digest, Keccak256};

    use super::*;
    use crate::{
        disabled_chain_adapter::DisabledChainAdapter,
        monad_evm_tx::test_support::signed_eip1559_tx,
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
        ReplacementUnderpriced,
        InsufficientFunds,
    }

    #[derive(Debug, Clone)]
    struct TxSpec {
        raw_tx: Vec<u8>,
        destination: Address,
        value_wei: u128,
        input: Vec<u8>,
        sender: Address,
        account_nonce: u64,
        confirmed: bool,
        send: SendBehavior,
        receipt_error: bool,
        hang_receipt: bool,
        receipt_hash_override: Option<Hash32>,
        transaction_hash_override: Option<Hash32>,
        submission_hash_override: Option<Hash32>,
        receipt_hash_after_first: Option<Hash32>,
        transaction_hash_after_first: Option<Hash32>,
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

        fn set_confirmed(&self, hash: Hash32, confirmed: bool) {
            self.specs.lock().unwrap().get_mut(&hash).unwrap().confirmed = confirmed;
        }

        fn set_send(&self, hash: Hash32, send: SendBehavior) {
            self.specs.lock().unwrap().get_mut(&hash).unwrap().send = send;
        }

        fn set_receipt_error(&self, hash: Hash32, receipt_error: bool) {
            self.specs
                .lock()
                .unwrap()
                .get_mut(&hash)
                .unwrap()
                .receipt_error = receipt_error;
        }

        fn set_hang_receipt(&self, hash: Hash32, hang_receipt: bool) {
            self.specs
                .lock()
                .unwrap()
                .get_mut(&hash)
                .unwrap()
                .hang_receipt = hang_receipt;
        }

        fn set_account_nonce(&self, hash: Hash32, account_nonce: u64) {
            self.specs
                .lock()
                .unwrap()
                .get_mut(&hash)
                .unwrap()
                .account_nonce = account_nonce;
        }

        fn set_hash_overrides(
            &self,
            hash: Hash32,
            receipt: Option<Hash32>,
            transaction: Option<Hash32>,
            submission: Option<Hash32>,
        ) {
            let mut specs = self.specs.lock().unwrap();
            let spec = specs.get_mut(&hash).unwrap();
            spec.receipt_hash_override = receipt;
            spec.transaction_hash_override = transaction;
            spec.submission_hash_override = submission;
        }
    }

    #[async_trait]
    impl JsonRpcTransport for FakeTransport {
        async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
            let method_call_count = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(method.to_string());
                calls
                    .iter()
                    .filter(|called| called.as_str() == method)
                    .count()
            };
            let requested_hash =
                || Hash32::from_hex(params[0].as_str().expect("hash param")).expect("valid hash");
            match method {
                "eth_getTransactionReceipt" => {
                    let hash = requested_hash();
                    let spec = self
                        .specs
                        .lock()
                        .unwrap()
                        .get(&hash)
                        .expect("known hash")
                        .clone();
                    if spec.hang_receipt {
                        futures::future::pending::<()>().await;
                    }
                    if spec.receipt_error {
                        return Err(MonadRpcError::Rpc {
                            method: method.to_string(),
                            code: -2,
                            message: "receipt unavailable".to_string(),
                            data: None,
                        });
                    }
                    if !spec.confirmed {
                        return Ok(Value::Null);
                    }
                    Ok(json!({
                        "transactionHash": spec.receipt_hash_override
                            .or((method_call_count > 1).then_some(spec.receipt_hash_after_first).flatten())
                            .unwrap_or(hash).to_hex(),
                        "blockHash": Hash32([0x22; 32]).to_hex(),
                        "blockNumber": "0x2a",
                        "from": spec.sender.to_hex(),
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
                        "hash": spec.transaction_hash_override
                            .or((method_call_count > 1).then_some(spec.transaction_hash_after_first).flatten())
                            .unwrap_or(hash).to_hex(),
                        "to": spec.destination.to_hex(),
                        "value": format!("0x{:x}", spec.value_wei),
                        "input": format!("0x{}", hex::encode(&spec.input)),
                        "from": spec.sender.to_hex(),
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
                            if spec.submission_hash_override.is_none() {
                                spec.confirmed = true;
                            }
                            Ok(Value::String(
                                spec.submission_hash_override.unwrap_or(hash).to_hex(),
                            ))
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
                        SendBehavior::ReplacementUnderpriced => {
                            Err(MonadRpcError::ReplacementUnderpriced {
                                method: method.to_string(),
                                message: "replacement transaction underpriced".to_string(),
                            })
                        }
                        SendBehavior::InsufficientFunds => Err(MonadRpcError::InsufficientFunds {
                            method: method.to_string(),
                            message: "insufficient funds".to_string(),
                        }),
                    }
                }
                "eth_getTransactionCount" => {
                    let sender = Address::from_hex(params[0].as_str().unwrap()).unwrap();
                    let specs = self.specs.lock().unwrap();
                    let nonce = specs
                        .values()
                        .find(|spec| spec.sender == sender)
                        .expect("known sender")
                        .account_nonce;
                    Ok(Value::String(format!("0x{nonce:x}")))
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
        fixture_with_seed(b"durable crash fixture", behaviors, confirmed)
    }

    fn fixture_with_seed(
        seed: &[u8],
        behaviors: &[SendBehavior],
        confirmed: &[bool],
    ) -> (proto::MonadStampedMessage, MonadOutboxPolicy, FakeTransport) {
        let encrypted_payload = seed.to_vec();
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
            let ecc = EccSecp256k1::default();
            let seckey = ecc
                .seckey_from_array([(index as u8).saturating_add(1); 32])
                .unwrap();
            let nonce = 0;
            let (raw_tx, sender) =
                signed_eip1559_tx(&seckey, 10_143, nonce, Address(child.address), 10, &input);
            transport.insert(TxSpec {
                raw_tx: raw_tx.clone(),
                destination: Address(child.address),
                value_wei: 10,
                input,
                sender,
                account_nonce: 1,
                confirmed: confirmed[index],
                send: behavior,
                receipt_error: false,
                hang_receipt: false,
                receipt_hash_override: None,
                transaction_hash_override: None,
                submission_hash_override: None,
                receipt_hash_after_first: None,
                transaction_hash_after_first: None,
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
        let mut limits = MonadOutboxLimits::default();
        limits.retry_backoff_base = Duration::ZERO;
        limits.max_retry_backoff = Duration::ZERO;
        MonadOutboxReconcileConfig {
            limits,
            poll_interval: Duration::from_millis(1),
            receipt_poll_attempts: 1,
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
    async fn nonce_too_low_requires_confirmed_advancement_and_delayed_exact_receipt_wins(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-nonce-proof")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::NonceTooLow], &[false]);
        let tx_hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        transport.set_account_nonce(tx_hash, 0);
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Pending
        );
        assert_eq!(
            registry
                .monad_outbox_member(&request.payload_hash, 0)?
                .unwrap()
                .state,
            MonadOutboxMemberState::Pending
        );
        transport.set_confirmed(tx_hash, true);
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn one_fetched_exact_pair_prevents_second_fetch_identity_swap() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-exact-pair")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let tx_hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        {
            let mut specs = transport.specs.lock().unwrap();
            let spec = specs.get_mut(&tx_hash).unwrap();
            spec.receipt_hash_after_first = Some(Hash32([0xa1; 32]));
            spec.transaction_hash_after_first = Some(Hash32([0xb2; 32]));
        }
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        for method in ["eth_getTransactionReceipt", "eth_getTransactionByHash"] {
            assert_eq!(
                transport
                    .calls()
                    .iter()
                    .filter(|called| called.as_str() == method)
                    .count(),
                1,
                "verification must use one fetched receipt/transaction pair"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn reversible_provider_failures_remain_pending_and_later_deliver() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-provider-failures")?;
        let config = fast_config();
        for (seed, receipt_wrong, transaction_wrong, submission_wrong, behavior, confirmed) in [
            (
                b"wrong-receipt".as_slice(),
                true,
                false,
                false,
                SendBehavior::Accept,
                true,
            ),
            (
                b"wrong-transaction".as_slice(),
                false,
                true,
                false,
                SendBehavior::Accept,
                true,
            ),
            (
                b"wrong-submission".as_slice(),
                false,
                false,
                true,
                SendBehavior::Accept,
                false,
            ),
            (
                b"later-funded".as_slice(),
                false,
                false,
                false,
                SendBehavior::InsufficientFunds,
                false,
            ),
        ] {
            let registry = registry(&tempdir.path().join(hex::encode(seed)));
            let (request, policy, transport) = fixture_with_seed(seed, &[behavior], &[confirmed]);
            let tx_hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
            let wrong = Hash32([0xcc; 32]);
            transport.set_hash_overrides(
                tx_hash,
                receipt_wrong.then_some(wrong),
                transaction_wrong.then_some(wrong),
                submission_wrong.then_some(wrong),
            );
            registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
            assert_eq!(
                reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config)
                    .await?,
                MonadOutboxReconcileOutcome::Pending
            );
            assert_eq!(
                registry
                    .monad_outbox_member(&request.payload_hash, 0)?
                    .unwrap()
                    .state,
                MonadOutboxMemberState::Pending
            );
            transport.set_hash_overrides(tx_hash, None, None, None);
            transport.set_send(tx_hash, SendBehavior::Accept);
            assert!(matches!(
                reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config)
                    .await?,
                MonadOutboxReconcileOutcome::Delivered(_)
            ));
        }
        Ok(())
    }

    #[tokio::test]
    async fn dual_reconcilers_share_one_durable_replay_generation() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-dual")?;
        let active_registry = Arc::new(registry(&tempdir.path().join("db.rocksdb")));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[false]);
        active_registry.claim_monad_outbox(
            &request,
            &policy,
            now_ms(),
            &MonadOutboxLimits::default(),
        )?;
        let payload_hash = request.payload_hash.clone();
        let config = fast_config();
        let gate = Arc::new(tokio::sync::Barrier::new(3));
        let first = {
            let registry = Arc::clone(&active_registry);
            let transport = transport.clone();
            let payload_hash = payload_hash.clone();
            let config = config.clone();
            let gate = Arc::clone(&gate);
            tokio::spawn(async move {
                gate.wait().await;
                reconcile_monad_outbox(&transport, &registry, &payload_hash, &config).await
            })
        };
        let second = {
            let registry = Arc::clone(&active_registry);
            let transport = transport.clone();
            let payload_hash = payload_hash.clone();
            let config = config.clone();
            let gate = Arc::clone(&gate);
            tokio::spawn(async move {
                gate.wait().await;
                reconcile_monad_outbox(&transport, &registry, &payload_hash, &config).await
            })
        };
        gate.wait().await;
        let _ = first.await.unwrap()?;
        let _ = second.await.unwrap()?;
        assert_eq!(
            transport
                .calls()
                .iter()
                .filter(|method| method.as_str() == "eth_sendRawTransaction")
                .count(),
            1
        );
        assert_eq!(
            active_registry
                .monad_outbox_record(&payload_hash)?
                .unwrap()
                .reconciliation_attempts,
            1
        );
        assert!(active_registry.get_monad_message(&payload_hash)?.is_some());
        Ok(())
    }

    #[tokio::test]
    async fn exact_lookup_precedes_expiry_attempt_budget_and_ambiguity_stays_pending() -> Result<()>
    {
        let tempdir = tempdir::TempDir::new("monad-outbox-order")?;
        let confirmed_registry = registry(&tempdir.path().join("confirmed.rocksdb"));
        let (confirmed, policy, transport) =
            fixture_with_seed(b"already confirmed", &[SendBehavior::Accept], &[true]);
        let mut config = fast_config();
        config.limits.max_member_attempts = 0;
        config.limits.max_claim_age = Duration::ZERO;
        confirmed_registry.claim_monad_outbox(
            &confirmed,
            &policy,
            now_ms().saturating_sub(100),
            &config.limits,
        )?;
        assert!(matches!(
            reconcile_monad_outbox(
                &transport,
                &confirmed_registry,
                &confirmed.payload_hash,
                &config,
            )
            .await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));

        let ambiguous_registry = registry(&tempdir.path().join("ambiguous.rocksdb"));
        let (ambiguous, policy, transport) =
            fixture_with_seed(b"ambiguous", &[SendBehavior::Accept], &[false]);
        let hash = Hash32(Keccak256::digest(&ambiguous.stamp_payments[0].raw_tx).into());
        transport.set_receipt_error(hash, true);
        ambiguous_registry.claim_monad_outbox(
            &ambiguous,
            &policy,
            now_ms().saturating_sub(100),
            &config.limits,
        )?;
        assert_eq!(
            reconcile_monad_outbox(
                &transport,
                &ambiguous_registry,
                &ambiguous.payload_hash,
                &config,
            )
            .await?,
            MonadOutboxReconcileOutcome::Pending
        );
        let member = ambiguous_registry
            .monad_outbox_member(&ambiguous.payload_hash, 0)?
            .unwrap();
        assert_eq!(member.attempts, 0);
        assert_eq!(member.state, MonadOutboxMemberState::Pending);
        Ok(())
    }

    #[tokio::test]
    async fn last_attempt_and_expiry_between_scans_still_deliver_exact_hash() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-last-attempt")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::RpcFailure], &[false]);
        let hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        let mut config = fast_config();
        config.limits.max_member_attempts = 1;
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Pending
        );
        transport.set_confirmed(hash, true);
        config.limits.max_claim_age = Duration::ZERO;
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn replacement_underpriced_is_retryable_and_later_delivery_wins() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-replacement")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) =
            fixture(&[SendBehavior::ReplacementUnderpriced], &[false]);
        let hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Pending
        );
        assert_eq!(
            registry
                .monad_outbox_member(&request.payload_hash, 0)?
                .unwrap()
                .state,
            MonadOutboxMemberState::Pending
        );
        transport.set_send(hash, SendBehavior::Accept);
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn initial_recovery_finishes_before_worker_return_for_pending_and_fully_confirmed(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-readiness")?;
        let pending_path = tempdir.path().join("pending.rocksdb");
        let (pending, policy, pending_transport) =
            fixture_with_seed(b"startup pending", &[SendBehavior::RpcFailure], &[false]);
        {
            let registry = registry(&pending_path);
            registry.claim_monad_outbox(
                &pending,
                &policy,
                now_ms(),
                &MonadOutboxLimits::default(),
            )?;
        }
        let pending_registry = Arc::new(registry(&pending_path));
        let pending_worker = start_monad_outbox_worker(
            pending_transport,
            Arc::clone(&pending_registry),
            fast_config(),
        )
        .await?;
        assert_eq!(
            pending_registry
                .monad_outbox_member(&pending.payload_hash, 0)?
                .unwrap()
                .attempts,
            1
        );
        pending_worker.shutdown().await;

        let confirmed_path = tempdir.path().join("confirmed.rocksdb");
        let (confirmed, policy, confirmed_transport) =
            fixture_with_seed(b"startup confirmed", &[SendBehavior::Accept], &[false]);
        {
            let registry = registry(&confirmed_path);
            registry.claim_monad_outbox(
                &confirmed,
                &policy,
                now_ms(),
                &MonadOutboxLimits::default(),
            )?;
            let lease = match registry.acquire_monad_outbox_reconcile_lease(
                &confirmed.payload_hash,
                0,
                now_ms(),
                &MonadOutboxLimits::default(),
            )? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected startup fixture lease, got {other:?}"),
            };
            registry.complete_confirmed_monad_outbox_member(
                &confirmed.payload_hash,
                0,
                lease,
                10,
                7,
                now_ms(),
            )?;
            assert!(registry.mark_monad_outbox_fully_confirmed(&confirmed.payload_hash, now_ms(),)?);
        }
        let confirmed_registry = Arc::new(registry(&confirmed_path));
        let confirmed_worker = start_monad_outbox_worker(
            confirmed_transport,
            Arc::clone(&confirmed_registry),
            fast_config(),
        )
        .await?;
        assert!(confirmed_registry
            .get_monad_message(&confirmed.payload_hash)?
            .is_some());
        confirmed_worker.shutdown().await;
        Ok(())
    }

    #[tokio::test]
    async fn initial_recovery_propagates_per_claim_corruption_before_readiness() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-readiness-corrupt")?;
        let path = tempdir.path().join("db.rocksdb");
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[false]);
        let config = fast_config();
        {
            let registry = registry(&path);
            registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        }
        {
            let db = Db::open(&path)?;
            db.put(
                db.cf(crate::store::db::CF_MONAD_OUTBOX_V1)?,
                &request.payload_hash,
                b"corrupt",
            )?;
        }
        let registry = Arc::new(registry(&path));
        let err = start_monad_outbox_worker(transport, registry, config)
            .await
            .expect_err("corrupt active claim must prevent readiness");
        assert!(err
            .to_string()
            .contains("initial Monad outbox reconciliation failed"));
        Ok(())
    }

    #[tokio::test]
    async fn active_scan_deadlines_prevent_starvation_and_shutdown_is_bounded() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-shutdown")?;
        let active_registry = Arc::new(registry(&tempdir.path().join("db.rocksdb")));
        let (hanging, hanging_policy, hanging_transport) =
            fixture_with_seed(b"hanging", &[SendBehavior::Accept], &[false]);
        let hanging_hash = Hash32(Keccak256::digest(&hanging.stamp_payments[0].raw_tx).into());
        hanging_transport.set_hang_receipt(hanging_hash, true);
        active_registry.claim_monad_outbox(
            &hanging,
            &hanging_policy,
            now_ms(),
            &MonadOutboxLimits::default(),
        )?;
        let (ready, ready_policy, ready_transport) =
            fixture_with_seed(b"ready", &[SendBehavior::Accept], &[true]);
        // Use one transport containing both deterministic transaction specs.
        let ready_hash = Hash32(Keccak256::digest(&ready.stamp_payments[0].raw_tx).into());
        let ready_spec = ready_transport
            .specs
            .lock()
            .unwrap()
            .get(&ready_hash)
            .unwrap()
            .clone();
        hanging_transport.insert(ready_spec);
        active_registry.claim_monad_outbox(
            &ready,
            &ready_policy,
            now_ms(),
            &MonadOutboxLimits::default(),
        )?;
        let mut config = fast_config();
        config.max_concurrency = 1;
        config.rpc_timeout = Duration::from_millis(5);
        config.claim_timeout = Duration::from_millis(20);
        reconcile_active(&hanging_transport, &active_registry, &config, false).await?;
        assert!(active_registry
            .get_monad_message(&ready.payload_hash)?
            .is_some());

        // Start with no active work, then introduce a never-returning claim during the periodic
        // scan so shutdown must cancel an active transport future rather than wait for it.
        let shutdown_registry = Arc::new(registry(&tempdir.path().join("shutdown.rocksdb")));
        let mut shutdown_config = fast_config();
        shutdown_config.scan_interval = Duration::from_millis(1);
        shutdown_config.rpc_timeout = Duration::from_secs(60);
        shutdown_config.claim_timeout = Duration::from_secs(60);
        shutdown_config.shutdown_grace = Duration::from_millis(10);
        let worker = start_monad_outbox_worker(
            hanging_transport.clone(),
            Arc::clone(&shutdown_registry),
            shutdown_config,
        )
        .await?;
        shutdown_registry.claim_monad_outbox(
            &hanging,
            &hanging_policy,
            now_ms(),
            &MonadOutboxLimits::default(),
        )?;
        tokio::time::sleep(Duration::from_millis(10)).await;
        tokio::time::timeout(Duration::from_millis(100), worker.shutdown())
            .await
            .expect("shutdown must be bounded");
        Ok(())
    }

    #[tokio::test]
    async fn owned_startup_worker_enumerates_and_delivers_active_claim() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-worker")?;
        let path = tempdir.path().join("db.rocksdb");
        let registry = Arc::new(registry(&path));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        registry.claim_monad_outbox(&request, &policy, now_ms(), &MonadOutboxLimits::default())?;
        let worker =
            start_monad_outbox_worker(transport, Arc::clone(&registry), fast_config()).await?;
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
