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
use prost::Message;
use sha3::{Digest, Keccak256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    monad_evm_tx::{decode_signed_transaction, DecodedSignedTransaction},
    monad_http::{Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_stealth::derive_monad_stamp_child_public,
    monad_stamp_verify::{parse_commitment_calldata, ExpectedStampTransaction},
    proto,
    registry::Registry,
    store::monad_outbox::{
        ConfirmedPrefixRecovery, MonadOutboxLeaseAcquire, MonadOutboxLifecycle, MonadOutboxLimits,
        MonadOutboxMemberState, MonadOutboxReplayStart, MonadOutboxTerminal, MonadOutboxTransition,
    },
};

const PAYMENT_COMMITMENT_DOMAIN: &[u8] = b"frank:dm-stamp-payment:v1";

/// Bounded startup/background reconciliation settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonadOutboxReconcileConfig {
    /// EVM chain identity required by admission and rechecked during recovery.
    pub expected_chain_id: u64,
    /// Durable storage bounds, including claim age/attempt budgets.
    pub limits: MonadOutboxLimits,
    /// Poll delay after an accepted or ambiguous replay.
    pub poll_interval: Duration,
    /// Exact-receipt polls within one persisted attempt.
    pub receipt_poll_attempts: u32,
    /// Maximum claims reconciled concurrently.
    pub max_concurrency: usize,
    /// Maximum active claims loaded in one page. This is deliberately independent from the
    /// admission ceiling because an existing database can contain more claims than a later
    /// process configuration permits admitting.
    pub active_scan_page_size: usize,
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
            expected_chain_id: 41_454,
            limits: MonadOutboxLimits::default(),
            poll_interval: Duration::from_millis(500),
            receipt_poll_attempts: 20,
            max_concurrency: 8,
            active_scan_page_size: 128,
            scan_interval: Duration::from_secs(30),
            rpc_timeout: Duration::from_secs(10),
            claim_timeout: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(5),
            initial_recovery_timeout: Duration::from_secs(2 * 60),
        }
    }
}

impl MonadOutboxReconcileConfig {
    /// Validate lifecycle bounds before database open or network readiness.
    pub fn validate(&self) -> Result<()> {
        self.limits.validate()
    }
}

/// One process-owned permit pool shared by every direct and background reconciliation flow.
#[derive(Debug, Clone)]
pub struct MonadOutboxPermitPool {
    permits: Arc<Semaphore>,
}

impl MonadOutboxPermitPool {
    /// Bound combined reconciliation work to the configured process-wide concurrency.
    pub fn new(max_concurrency: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_concurrency.max(1))),
        }
    }

    async fn acquire(&self) -> OwnedSemaphorePermit {
        Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .expect("process-owned reconciliation semaphore is never closed")
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.permits.available_permits()
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

/// Test convenience wrapper; production callers must supply the process-owned shared pool.
#[cfg(test)]
pub async fn reconcile_monad_outbox<T>(
    transport: &T,
    registry: &Registry,
    payload_hash: &[u8],
    config: &MonadOutboxReconcileConfig,
) -> Result<MonadOutboxReconcileOutcome>
where
    T: JsonRpcTransport + Clone,
{
    let permits = MonadOutboxPermitPool::new(config.max_concurrency);
    reconcile_monad_outbox_with_permits(transport, registry, payload_hash, config, &permits).await
}

/// Reconcile one claim under the process-owned direct/background concurrency bound.
pub async fn reconcile_monad_outbox_with_permits<T>(
    transport: &T,
    registry: &Registry,
    payload_hash: &[u8],
    config: &MonadOutboxReconcileConfig,
    permits: &MonadOutboxPermitPool,
) -> Result<MonadOutboxReconcileOutcome>
where
    T: JsonRpcTransport + Clone,
{
    config.validate()?;
    match tokio::time::timeout(config.claim_timeout, async {
        let _permit = permits.acquire().await;
        reconcile_monad_outbox_inner(transport, registry, payload_hash, config).await
    })
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
        MonadOutboxLifecycle::Delivered => {
            let stored = registry.get_monad_message(payload_hash)?.ok_or_else(|| {
                crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
                    "delivered outbox row has no inbox owner".to_string(),
                )
            })?;
            let message = stored.message.as_ref().ok_or_else(|| {
                crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
                    "delivered inbox row has no canonical message".to_string(),
                )
            })?;
            validate_persisted_message(message, payload_hash, config.expected_chain_id)?;
            return Ok(MonadOutboxReconcileOutcome::Delivered(stored));
        }
        MonadOutboxLifecycle::FullyConfirmed => {
            if let Err(err) =
                validate_persisted_record(registry, &record, payload_hash, config.expected_chain_id)
            {
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
            return Ok(MonadOutboxReconcileOutcome::Delivered(
                registry.finalize_monad_outbox(payload_hash, now_ms(), &config.limits)?,
            ));
        }
        MonadOutboxLifecycle::Terminal(terminal) => {
            return Ok(MonadOutboxReconcileOutcome::Terminal(terminal));
        }
        MonadOutboxLifecycle::Pending => {}
    }

    let message = match validate_persisted_record(
        registry,
        &record,
        payload_hash,
        config.expected_chain_id,
    ) {
        Ok(message) => message,
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
        let canonical = match decode_signed_transaction(&raw_tx) {
            Ok(canonical) if canonical.tx_hash == member.tx_hash => canonical,
            Ok(canonical) => {
                let detail = format!(
                    "canonical transaction decodes to hash {} instead of referenced hash {}",
                    canonical.tx_hash, member.tx_hash
                );
                let transition = registry.terminal_monad_outbox_claim(
                    payload_hash,
                    MonadOutboxTerminal::CorruptReference,
                    &detail,
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
            Err(err) => {
                let transition = registry.terminal_monad_outbox_claim(
                    payload_hash,
                    MonadOutboxTerminal::CorruptReference,
                    &format!("canonical transaction cannot be decoded: {err}"),
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

        match check_exact_bounded(transport, member.tx_hash, &canonical, &expected, config).await {
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

        match replay_member(
            transport,
            member.tx_hash,
            &raw_tx,
            &canonical,
            &expected,
            config,
        )
        .await
        {
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

fn validate_persisted_record(
    registry: &Registry,
    record: &crate::store::monad_outbox::MonadOutboxRecord,
    payload_hash: &[u8],
    expected_chain_id: u64,
) -> Result<proto::MonadStampedMessage> {
    let message = crate::store::monad_outbox::DbMonadOutbox::canonical_message(record)?;
    let canonical = record.canonical_message.as_deref().expect("decoded above");
    if message.encode_to_vec() != canonical {
        bail!("persisted canonical request uses a noncanonical protobuf encoding");
    }
    validate_persisted_message(&message, payload_hash, expected_chain_id)?;
    let policy = record.policy.as_ref().ok_or_else(|| {
        crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
            "active outbox row has no frozen policy".to_string(),
        )
    })?;
    let key: [u8; 32] = payload_hash.try_into().expect("validated payload hash");
    for payment in &message.stamp_payments {
        let (loaded_record, member, raw_tx) =
            registry.monad_outbox_referenced_raw_tx(payload_hash, payment.child_index)?;
        if loaded_record.canonical_message != record.canonical_message
            || loaded_record.policy != record.policy
            || raw_tx != payment.raw_tx
        {
            bail!("persisted member references a different canonical owner");
        }
        let decoded = decode_signed_transaction(&raw_tx)
            .wrap_err("decoding persisted referenced signed payment")?;
        let expected_destination =
            derive_monad_stamp_child_public(key, &policy.recipient_pubkey, payment.child_index)?;
        if decoded.destination != Some(crate::monad_http::Address(expected_destination.address)) {
            bail!("persisted payment destination differs from frozen recipient derivation");
        }
        if decoded.value_wei == 0 {
            bail!("persisted payment has zero signed value");
        }
        if let MonadOutboxMemberState::Confirmed { value_wei, .. } = member.state {
            if value_wei != decoded.value_wei {
                bail!("persisted confirmation value differs from signed transaction value");
            }
        }
    }
    Ok(message)
}

/// Validate one already-metered private recovery snapshot without any further database reads.
pub(crate) fn validate_monad_recovery_record(
    recovery: &ConfirmedPrefixRecovery,
    expected_chain_id: u64,
) -> Result<()> {
    if recovery.message.encode_to_vec() != recovery.canonical_message {
        bail!("recovery canonical request uses a noncanonical protobuf encoding");
    }
    validate_persisted_message(&recovery.message, &recovery.payload_hash, expected_chain_id)?;
    if recovery
        .confirmed_prefix
        .len()
        .saturating_add(recovery.remaining_members.len())
        != recovery.message.stamp_payments.len()
    {
        bail!("recovery snapshot member count differs from canonical request");
    }
    for (payment, member) in recovery.message.stamp_payments.iter().zip(
        recovery
            .confirmed_prefix
            .iter()
            .chain(&recovery.remaining_members),
    ) {
        if member.child_index != payment.child_index
            || member.tx_hash != Hash32(Keccak256::digest(&payment.raw_tx).into())
        {
            bail!("recovery member index/hash reference mismatch");
        }
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .wrap_err("decoding recovery signed payment")?;
        let expected_destination = derive_monad_stamp_child_public(
            recovery.payload_hash,
            &recovery.policy.recipient_pubkey,
            payment.child_index,
        )?;
        if decoded.destination != Some(crate::monad_http::Address(expected_destination.address)) {
            bail!("recovery payment destination differs from frozen recipient derivation");
        }
        if decoded.value_wei == 0 {
            bail!("recovery payment has zero signed value");
        }
        if let MonadOutboxMemberState::Confirmed { value_wei, .. } = member.state {
            if value_wei != decoded.value_wei {
                bail!("recovery confirmation value differs from signed transaction value");
            }
        }
    }
    Ok(())
}

fn validate_persisted_message(
    message: &proto::MonadStampedMessage,
    payload_hash: &[u8],
    expected_chain_id: u64,
) -> Result<()> {
    let key: [u8; 32] = payload_hash.try_into().map_err(|_| {
        crate::store::monad_outbox::DbMonadOutboxError::InvalidPayloadHashLength(payload_hash.len())
    })?;
    if message.payload_hash.as_slice() != key {
        bail!("persisted row key differs from embedded payload hash");
    }
    let actual = Sha256::digest(message.encrypted_payload.clone().into());
    if actual.as_slice() != key {
        bail!("persisted payload hash differs from SHA256(encrypted_payload)");
    }
    for (position, payment) in message.stamp_payments.iter().enumerate() {
        if payment.child_index as usize != position {
            bail!(
                "persisted child index {} is noncanonical",
                payment.child_index
            );
        }
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .wrap_err("decoding persisted signed payment")?;
        if decoded.chain_id != Some(expected_chain_id) {
            bail!(
                "persisted payment chain ID {:?} differs from expected {}",
                decoded.chain_id,
                expected_chain_id
            );
        }
        let commitment = parse_commitment_calldata(BROADCAST_MESSAGE_LOKAD_ID, &decoded.input)
            .wrap_err("decoding persisted payment commitment")?;
        let expected = payment_commitment(&key, payment.child_index);
        if commitment != expected {
            bail!("persisted payment commitment differs from canonical payload hash");
        }
    }
    Ok(())
}

fn current_outcome(
    registry: &Registry,
    payload_hash: &[u8],
    config: &MonadOutboxReconcileConfig,
) -> Result<MonadOutboxReconcileOutcome> {
    Ok(match registry.monad_outbox_record(payload_hash)? {
        None => MonadOutboxReconcileOutcome::Missing,
        Some(record) => match record.lifecycle {
            MonadOutboxLifecycle::Delivered => {
                let stored = registry.get_monad_message(payload_hash)?.ok_or_else(|| {
                    crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
                        "delivered outbox row has no inbox owner".to_string(),
                    )
                })?;
                let message = stored.message.as_ref().ok_or_else(|| {
                    crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
                        "delivered inbox row has no canonical message".to_string(),
                    )
                })?;
                validate_persisted_message(message, payload_hash, config.expected_chain_id)?;
                MonadOutboxReconcileOutcome::Delivered(stored)
            }
            MonadOutboxLifecycle::Terminal(terminal) => {
                MonadOutboxReconcileOutcome::Terminal(terminal)
            }
            MonadOutboxLifecycle::FullyConfirmed => {
                if let Err(err) = validate_persisted_record(
                    registry,
                    &record,
                    payload_hash,
                    config.expected_chain_id,
                ) {
                    let transition = registry.terminal_monad_outbox_claim(
                        payload_hash,
                        MonadOutboxTerminal::CorruptReference,
                        &err.to_string(),
                        now_ms(),
                        &config.limits,
                    )?;
                    if transition == MonadOutboxTransition::Applied {
                        MonadOutboxReconcileOutcome::Terminal(MonadOutboxTerminal::CorruptReference)
                    } else {
                        return current_outcome(registry, payload_hash, config);
                    }
                } else {
                    MonadOutboxReconcileOutcome::Delivered(registry.finalize_monad_outbox(
                        payload_hash,
                        now_ms(),
                        &config.limits,
                    )?)
                }
            }
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
    canonical: &DecodedSignedTransaction,
    expected: &ExpectedStampTransaction,
) -> ExactCheck {
    if canonical.destination != Some(expected.destination_address)
        || canonical.value_wei < expected.min_value_wei
    {
        return ExactCheck::Invalid(
            "canonical signed transaction violates the frozen payment policy".to_string(),
        );
    }
    let commitment = match parse_commitment_calldata(expected.commitment_id, &canonical.input) {
        Ok(commitment) => commitment,
        Err(err) => return ExactCheck::Invalid(err.to_string()),
    };
    if commitment != expected.commitment {
        return ExactCheck::Invalid(format!(
            "canonical signed transaction commitment {} does not match {}",
            commitment, expected.commitment
        ));
    }
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
    if receipt.from != canonical.sender
        || receipt.to != canonical.destination
        || transaction.from != canonical.sender
        || transaction.to != canonical.destination
        || transaction.value != canonical.value_wei
        || transaction.input != canonical.input
    {
        return ExactCheck::Infrastructure(
            "RPC transaction/receipt body does not match canonical signed transaction".to_string(),
        );
    }
    match receipt.status {
        Some(1) => {}
        Some(0) => return ExactCheck::Invalid("exact transaction reverted".to_string()),
        status => {
            return ExactCheck::Infrastructure(format!(
                "exact receipt returned missing or unknown status {status:?}"
            ))
        }
    }
    ExactCheck::Confirmed {
        value_wei: canonical.value_wei,
        block_number: receipt.block_number,
    }
}

async fn check_exact_bounded<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    canonical: &DecodedSignedTransaction,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> ExactCheck {
    match tokio::time::timeout(
        config.rpc_timeout,
        check_exact(transport, tx_hash, canonical, expected),
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
    canonical: &DecodedSignedTransaction,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> ExactCheck {
    let attempts = config.receipt_poll_attempts.max(1);
    for attempt in 0..attempts {
        let check = check_exact_bounded(transport, tx_hash, canonical, expected, config).await;
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
    canonical: &DecodedSignedTransaction,
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

    match poll_exact(transport, tx_hash, canonical, expected, config).await {
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
            prove_stale_nonce(transport, tx_hash, canonical, expected, config).await
        }
        ExactCheck::Missing => MemberOutcome::Pending(
            "exact transaction remains unconfirmed after bounded polling".to_string(),
        ),
    }
}

async fn prove_stale_nonce<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    decoded: &DecodedSignedTransaction,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> MemberOutcome {
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

    match check_exact_bounded(transport, tx_hash, decoded, expected, config).await {
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
        ExactCheck::Missing => MemberOutcome::Pending(format!(
            "confirmed account nonce {confirmed_nonce} advanced past canonical nonce {}, but no competing transaction identity was proven",
            decoded.nonce
        )),
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

/// Test convenience wrapper which constructs its own worker-only permit pool.
#[cfg(test)]
pub async fn start_monad_outbox_worker<T>(
    transport: T,
    registry: Arc<Registry>,
    config: MonadOutboxReconcileConfig,
) -> Result<MonadOutboxWorker>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    let permits = MonadOutboxPermitPool::new(config.max_concurrency);
    start_monad_outbox_worker_shared(transport, registry, Arc::new(config), permits).await
}

/// Start the worker with the same immutable config identity owned by HTTP admission.
pub async fn start_monad_outbox_worker_shared<T>(
    transport: T,
    registry: Arc<Registry>,
    config: Arc<MonadOutboxReconcileConfig>,
    permits: MonadOutboxPermitPool,
) -> Result<MonadOutboxWorker>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    config.validate()?;
    registry.gc_monad_outbox_history(now_ms(), &config.limits)?;
    registry
        .supersede_monad_outbox_startup_leases(now_ms())
        .wrap_err("initial Monad outbox reconciliation failed during stale-lease supersession")?;
    // Readiness is intentionally after this bounded initial scan. Each exact RPC, claim, active
    // cardinality, and concurrency dimension has a finite configured ceiling.
    tokio::time::timeout(
        config.initial_recovery_timeout,
        reconcile_active(&transport, &registry, &config, &permits, true),
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
            let scan = reconcile_active(&transport, &registry, &config, &permits, false);
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
    permits: &MonadOutboxPermitPool,
    fail_on_claim_error: bool,
) -> Result<()>
where
    T: JsonRpcTransport + Clone + Send + Sync + 'static,
{
    registry.gc_monad_outbox_history(now_ms(), &config.limits)?;
    let page_size = config.active_scan_page_size.max(1);
    let concurrency = config.max_concurrency.max(1).min(page_size);
    let mut after = None;
    loop {
        let active = registry.list_active_monad_outboxes_after(after, page_size)?;
        if active.is_empty() {
            return Ok(());
        }
        after = active.last().copied();
        let mut reconciliations = stream::iter(active)
            .map(|payload_hash| async move {
                let result = reconcile_monad_outbox_with_permits(
                    transport,
                    registry,
                    &payload_hash,
                    config,
                    permits,
                )
                .await;
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
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex,
        },
    };

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
            monad_outbox::{
                recovery_page_work_counts, reset_recovery_page_work_counts, MonadOutboxClaim,
                MonadOutboxPolicy,
            },
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
        receipt_sender: Address,
        receipt_destination: Option<Address>,
        receipt_status: Option<u64>,
        transaction_sender: Address,
        transaction_destination: Option<Address>,
        transaction_value_wei: u128,
        transaction_input: Vec<u8>,
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
                        "from": spec.receipt_sender.to_hex(),
                        "to": spec.receipt_destination.map(|address| address.to_hex()),
                        "contractAddress": null,
                        "gasUsed": "0x5208",
                        "status": spec.receipt_status.map(|status| format!("0x{status:x}")),
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
                        "to": spec.transaction_destination.map(|address| address.to_hex()),
                        "value": format!("0x{:x}", spec.transaction_value_wei),
                        "input": format!("0x{}", hex::encode(&spec.transaction_input)),
                        "from": spec.transaction_sender.to_hex(),
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

    #[derive(Clone, Debug)]
    struct ConcurrencyTransport {
        inner: FakeTransport,
        block_next: Arc<AtomicBool>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
    }

    struct ActiveCallGuard(Arc<AtomicUsize>);

    impl Drop for ActiveCallGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl JsonRpcTransport for ConcurrencyTransport {
        async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            let _guard = ActiveCallGuard(Arc::clone(&self.active));
            if self.block_next.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.inner.call(method, params).await
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
                signed_eip1559_tx(&seckey, 41_454, nonce, Address(child.address), 10, &input);
            transport.insert(TxSpec {
                raw_tx: raw_tx.clone(),
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
                receipt_sender: sender,
                receipt_destination: Some(Address(child.address)),
                receipt_status: Some(1),
                transaction_sender: sender,
                transaction_destination: Some(Address(child.address)),
                transaction_value_wei: 10,
                transaction_input: input.clone(),
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
    async fn nonce_advancement_without_competing_identity_remains_pending_then_delivers(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-nonce-hidden")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::NonceTooLow], &[false]);
        let tx_hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &MonadOutboxLimits::default())?;
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
    async fn rpc_body_mismatches_and_missing_status_remain_pending() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-rpc-body")?;
        let config = fast_config();
        for case in 0..8u8 {
            let seed = format!("rpc-body-{case}");
            let registry = registry(&tempdir.path().join(&seed));
            let (request, policy, transport) =
                fixture_with_seed(seed.as_bytes(), &[SendBehavior::Accept], &[true]);
            let raw_tx = &request.stamp_payments[0].raw_tx;
            let canonical = decode_signed_transaction(raw_tx)?;
            {
                let mut specs = transport.specs.lock().unwrap();
                let spec = specs.get_mut(&canonical.tx_hash).unwrap();
                match case {
                    0 => spec.receipt_sender = Address([0xa0; 20]),
                    1 => spec.receipt_destination = Some(Address([0xa1; 20])),
                    2 => spec.transaction_sender = Address([0xa2; 20]),
                    3 => spec.transaction_destination = Some(Address([0xa3; 20])),
                    4 => spec.transaction_value_wei = canonical.value_wei + 1,
                    5 => spec.transaction_input.push(0xff),
                    6 => spec.receipt_status = None,
                    7 => spec.receipt_status = Some(2),
                    _ => unreachable!(),
                }
            }
            registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
            assert_eq!(
                reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config)
                    .await?,
                MonadOutboxReconcileOutcome::Pending,
                "RPC body mismatch case {case} must remain retryable"
            );
            assert_eq!(
                registry
                    .monad_outbox_member(&request.payload_hash, 0)?
                    .unwrap()
                    .state,
                MonadOutboxMemberState::Pending
            );
            {
                let mut specs = transport.specs.lock().unwrap();
                let spec = specs.get_mut(&canonical.tx_hash).unwrap();
                spec.receipt_sender = canonical.sender;
                spec.receipt_destination = canonical.destination;
                spec.receipt_status = Some(1);
                spec.transaction_sender = canonical.sender;
                spec.transaction_destination = canonical.destination;
                spec.transaction_value_wei = canonical.value_wei;
                spec.transaction_input = canonical.input.clone();
            }
            assert!(matches!(
                reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config)
                    .await?,
                MonadOutboxReconcileOutcome::Delivered(_)
            ));
        }
        Ok(())
    }

    #[tokio::test]
    async fn explicit_reverted_receipt_is_terminal_verification_failure() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-reverted")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let tx_hash = Hash32(Keccak256::digest(&request.stamp_payments[0].raw_tx).into());
        transport
            .specs
            .lock()
            .unwrap()
            .get_mut(&tx_hash)
            .unwrap()
            .receipt_status = Some(0);
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Terminal(MonadOutboxTerminal::VerificationFailed)
        );
        assert_eq!(
            registry
                .monad_outbox_member(&request.payload_hash, 0)?
                .unwrap()
                .state,
            MonadOutboxMemberState::Terminal(MonadOutboxTerminal::VerificationFailed)
        );
        Ok(())
    }

    #[tokio::test]
    async fn contradictory_reverted_receipt_body_stays_pending_then_delivers() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-contradictory-revert")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let canonical = decode_signed_transaction(&request.stamp_payments[0].raw_tx)?;
        {
            let mut specs = transport.specs.lock().unwrap();
            let spec = specs.get_mut(&canonical.tx_hash).unwrap();
            spec.receipt_status = Some(0);
            spec.transaction_value_wei = canonical.value_wei + 1;
        }
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
        {
            let mut specs = transport.specs.lock().unwrap();
            let spec = specs.get_mut(&canonical.tx_hash).unwrap();
            spec.receipt_status = Some(1);
            spec.transaction_value_wei = canonical.value_wei;
        }
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn confirmed_member_persists_signed_canonical_value() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-canonical-value")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(
            &[SendBehavior::Accept, SendBehavior::RpcFailure],
            &[true, false],
        );
        let canonical = decode_signed_transaction(&request.stamp_payments[0].raw_tx)?;
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
            MonadOutboxMemberState::Confirmed {
                value_wei: canonical.value_wei,
                block_number: 42,
            }
        );
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
    async fn startup_supersedes_prior_process_lease_before_readiness() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-startup-stale-lease")?;
        let path = tempdir.path().join("db.rocksdb");
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let config = fast_config();
        {
            let registry = registry(&path);
            registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
            match registry.acquire_monad_outbox_reconcile_lease(
                &request.payload_hash,
                0,
                now_ms(),
                &config.limits,
            )? {
                MonadOutboxLeaseAcquire::Acquired { .. } => {}
                other => panic!("expected stale startup lease, got {other:?}"),
            }
        };
        let registry = Arc::new(registry(&path));
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), config).await?;
        assert!(registry.get_monad_message(&request.payload_hash)?.is_some());
        assert!(registry
            .monad_outbox_member(&request.payload_hash, 0)?
            .is_none());
        worker.shutdown().await;
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
    async fn persisted_payload_hash_corruption_is_terminal_before_rpc_or_publication() -> Result<()>
    {
        let tempdir = tempdir::TempDir::new("monad-outbox-payload-corruption")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let config = fast_config();
        assert!(matches!(
            registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?,
            MonadOutboxClaim::New
        ));
        let mut corrupted = request.clone();
        corrupted.encrypted_payload.push(0xff);
        registry.replace_monad_outbox_canonical_for_test(&request.payload_hash, &corrupted)?;

        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Terminal(MonadOutboxTerminal::CorruptReference)
        );
        assert!(transport.calls().is_empty());
        assert!(registry.get_monad_message(&request.payload_hash)?.is_none());
        assert!(matches!(
            registry
                .monad_outbox_record(&request.payload_hash)?
                .unwrap()
                .lifecycle,
            MonadOutboxLifecycle::Terminal(MonadOutboxTerminal::CorruptReference)
        ));
        Ok(())
    }

    #[tokio::test]
    async fn confirmed_member_value_is_revalidated_from_exact_signed_bytes_before_finalize(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-confirmed-value-corruption")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        let lease = match registry.acquire_monad_outbox_reconcile_lease(
            &request.payload_hash,
            0,
            now_ms(),
            &config.limits,
        )? {
            MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
            other => panic!("expected corruption fixture lease, got {other:?}"),
        };
        registry.complete_confirmed_monad_outbox_member(
            &request.payload_hash,
            0,
            lease,
            11,
            7,
            now_ms(),
        )?;
        assert!(registry.mark_monad_outbox_fully_confirmed(&request.payload_hash, now_ms())?);
        assert_eq!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Terminal(MonadOutboxTerminal::CorruptReference)
        );
        assert!(transport.calls().is_empty());
        assert!(registry.get_monad_message(&request.payload_hash)?.is_none());
        Ok(())
    }

    #[test]
    fn recovery_page_validates_large_short_prefix_with_one_metered_read_and_decode_per_row(
    ) -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-large-recovery-page")?;
        let registry = registry(&tempdir.path().join("db.rocksdb"));
        let seed = vec![0x42; 1_800_000];
        let behaviors = vec![SendBehavior::RpcFailure; 64];
        let confirmed = vec![false; 64];
        let (request, policy, _) = fixture_with_seed(&seed, &behaviors, &confirmed);
        assert!(request.encoded_len() > 1_700_000);
        assert!(request.encoded_len() < 2 * 1024 * 1024);
        let limits = MonadOutboxLimits::default();
        assert!(matches!(
            registry.claim_monad_outbox(&request, &policy, 1, &limits)?,
            MonadOutboxClaim::New
        ));
        registry.complete_confirmed_monad_outbox_member(
            &request.payload_hash,
            0,
            match registry.acquire_monad_outbox_reconcile_lease(
                &request.payload_hash,
                0,
                2,
                &limits,
            )? {
                MonadOutboxLeaseAcquire::Acquired { lease, .. } => lease,
                other => panic!("expected large recovery fixture lease, got {other:?}"),
            },
            10,
            7,
            3,
        )?;

        let measured = registry.confirmed_monad_outbox_prefixes_page(
            policy.recipient,
            None,
            1,
            1,
            usize::MAX,
        )?;
        assert_eq!(measured.recoveries.len(), 1);
        assert_eq!(measured.recoveries[0].confirmed_prefix.len(), 1);
        let exact_budget = measured.inspected_bytes;

        reset_recovery_page_work_counts();
        let page = registry.confirmed_monad_outbox_prefixes_page(
            policy.recipient,
            None,
            1,
            1,
            exact_budget,
        )?;
        assert_eq!(page.recoveries.len(), 1);
        assert!(page.canonical_bytes <= exact_budget);
        assert_eq!(page.inspected_bytes, exact_budget);
        assert_eq!(recovery_page_work_counts(), (65, 65, exact_budget));
        validate_monad_recovery_record(&page.recoveries[0], 41_454)?;
        assert_eq!(
            recovery_page_work_counts(),
            (65, 65, exact_budget),
            "in-memory economic validation performs no second DB read or decode"
        );

        let error = registry
            .confirmed_monad_outbox_prefixes_page(policy.recipient, None, 1, 1, exact_budget - 1)
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<crate::store::monad_outbox::DbMonadOutboxError>(),
            Some(
                crate::store::monad_outbox::DbMonadOutboxError::RecoveryRecordExceedsPageBudget { .. }
            )
        ));
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
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        reconcile_active(
            &hanging_transport,
            &active_registry,
            &config,
            &permits,
            false,
        )
        .await?;
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
    async fn paginated_active_scan_is_fair_after_admission_limit_is_lowered() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-scan-fairness")?;
        let path = tempdir.path().join("db.rocksdb");
        let (first_request, first_policy, first_transport) =
            fixture_with_seed(b"fairness-a", &[SendBehavior::Accept], &[true]);
        let (second_request, second_policy, second_transport) =
            fixture_with_seed(b"fairness-b", &[SendBehavior::Accept], &[true]);
        let transport = FakeTransport::default();
        transport.specs.lock().unwrap().extend(
            first_transport
                .specs
                .lock()
                .unwrap()
                .iter()
                .map(|(hash, spec)| (*hash, spec.clone())),
        );
        transport.specs.lock().unwrap().extend(
            second_transport
                .specs
                .lock()
                .unwrap()
                .iter()
                .map(|(hash, spec)| (*hash, spec.clone())),
        );
        let mut claims = vec![
            (first_request, first_policy),
            (second_request, second_policy),
        ];
        claims.sort_by(|left, right| left.0.payload_hash.cmp(&right.0.payload_hash));
        let first_hash = Hash32(Keccak256::digest(&claims[0].0.stamp_payments[0].raw_tx).into());
        transport.set_receipt_error(first_hash, true);
        {
            let registry = registry(&path);
            let mut admission = MonadOutboxLimits::default();
            admission.max_active_claims = 2;
            for (request, policy) in &claims {
                assert_eq!(
                    registry.claim_monad_outbox(request, policy, now_ms(), &admission)?,
                    MonadOutboxClaim::New
                );
            }
        }

        let registry = Arc::new(registry(&path));
        let mut config = fast_config();
        config.limits.max_active_claims = 1;
        config.active_scan_page_size = 1;
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), config).await?;
        assert_eq!(
            registry
                .monad_outbox_member(&claims[0].0.payload_hash, 0)?
                .unwrap()
                .state,
            MonadOutboxMemberState::Pending
        );
        assert!(registry
            .get_monad_message(&claims[1].0.payload_hash)?
            .is_some());
        worker.shutdown().await;
        Ok(())
    }

    #[tokio::test]
    async fn zero_scan_page_size_still_processes_existing_obligations() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-scan-zero")?;
        let path = tempdir.path().join("db.rocksdb");
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        {
            let registry = registry(&path);
            registry.claim_monad_outbox(
                &request,
                &policy,
                now_ms(),
                &MonadOutboxLimits::default(),
            )?;
        }
        let registry = Arc::new(registry(&path));
        let mut config = fast_config();
        config.limits.max_active_claims = 0;
        config.active_scan_page_size = 0;
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), config).await?;
        assert!(registry.get_monad_message(&request.payload_hash)?.is_some());
        worker.shutdown().await;
        Ok(())
    }

    #[tokio::test]
    async fn idle_worker_expires_aged_history_without_new_claims() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-idle-gc")?;
        let path = tempdir.path().join("db.rocksdb");
        let registry = Arc::new(registry(&path));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let mut config = fast_config();
        config.limits.max_history_age = Duration::from_millis(20);
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        assert!(registry
            .monad_outbox_record(&request.payload_hash)?
            .is_some());
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), config).await?;
        for _ in 0..100 {
            if registry
                .monad_outbox_record(&request.payload_hash)?
                .is_none()
            {
                worker.shutdown().await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        worker.shutdown().await;
        panic!("idle periodic GC did not expire aged history")
    }

    #[tokio::test]
    async fn configured_history_gc_completes_before_worker_readiness() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-readiness-gc")?;
        let path = tempdir.path().join("db.rocksdb");
        let registry = Arc::new(registry(&path));
        let (request, policy, transport) = fixture(&[SendBehavior::Accept], &[true]);
        let mut config = fast_config();
        registry.claim_monad_outbox(&request, &policy, now_ms(), &config.limits)?;
        assert!(matches!(
            reconcile_monad_outbox(&transport, &registry, &request.payload_hash, &config).await?,
            MonadOutboxReconcileOutcome::Delivered(_)
        ));
        assert!(registry
            .monad_outbox_record(&request.payload_hash)?
            .is_some());
        config.limits.max_history_records = 0;
        let worker = start_monad_outbox_worker(transport, Arc::clone(&registry), config).await?;
        assert!(registry
            .monad_outbox_record(&request.payload_hash)?
            .is_none());
        worker.shutdown().await;
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

    #[tokio::test]
    async fn http_and_background_worker_share_one_process_rpc_permit_pool() -> Result<()> {
        let tempdir = tempdir::TempDir::new("monad-outbox-shared-permits")?;
        let registry = Arc::new(registry(&tempdir.path().join("db.rocksdb")));
        let (first, first_policy, first_transport) =
            fixture_with_seed(b"shared-permit-worker", &[SendBehavior::Accept], &[true]);
        let (second, second_policy, second_transport) =
            fixture_with_seed(b"shared-permit-http", &[SendBehavior::Accept], &[true]);
        first_transport.specs.lock().unwrap().extend(
            second_transport
                .specs
                .lock()
                .unwrap()
                .iter()
                .map(|(hash, spec)| (*hash, spec.clone())),
        );
        let transport = ConcurrencyTransport {
            inner: first_transport,
            block_next: Arc::new(AtomicBool::new(false)),
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
        };
        let mut config = fast_config();
        config.max_concurrency = 1;
        config.scan_interval = Duration::from_millis(1);
        let config = Arc::new(config);
        let permits = MonadOutboxPermitPool::new(config.max_concurrency);
        let worker = start_monad_outbox_worker_shared(
            transport.clone(),
            Arc::clone(&registry),
            Arc::clone(&config),
            permits.clone(),
        )
        .await?;

        registry.claim_monad_outbox(&first, &first_policy, now_ms(), &config.limits)?;
        registry.claim_monad_outbox(&second, &second_policy, now_ms(), &config.limits)?;
        transport.block_next.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(1), transport.entered.notified())
            .await
            .expect("background reconciliation entered its first RPC");
        assert_eq!(permits.available_permits(), 0);

        let direct = tokio::spawn({
            let transport = transport.clone();
            let registry = Arc::clone(&registry);
            let config = Arc::clone(&config);
            let permits = permits.clone();
            let payload_hash = second.payload_hash.clone();
            async move {
                reconcile_monad_outbox_with_permits(
                    &transport,
                    &registry,
                    &payload_hash,
                    &config,
                    &permits,
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(transport.max_active.load(Ordering::SeqCst), 1);
        transport.release.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(2), direct)
            .await
            .expect("direct reconciliation finishes after the shared permit is released")??;
        worker.shutdown().await;
        assert_eq!(
            transport.max_active.load(Ordering::SeqCst),
            1,
            "HTTP and worker RPC activity must never exceed the one process permit"
        );
        Ok(())
    }
}
