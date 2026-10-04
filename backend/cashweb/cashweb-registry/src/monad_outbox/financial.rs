//! Private financial owner for the existing legacy Monad DM path.
//!
//! CPU validation is separate from confirmed durable validation. Neither result changes the
//! request bytes or persisted authority; finalization reconstructs the confirmed view under
//! its existing storage lock. Scheduling, leases and publication remain outside this module.

use std::collections::HashSet;

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::{bail, Result, WrapErr};
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;
use prost::Message;
use sha3::{Digest, Keccak256};

use super::MonadOutboxReconcileConfig;
use crate::{
    monad_evm_tx::{decode_signed_transaction, DecodedSignedTransaction, EvmTxError},
    monad_http::{Address, Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_stealth::{derive_monad_stamp_child_public, StampStealthError},
    monad_stamp_verify::{parse_commitment_calldata, ExpectedStampTransaction},
    proto,
    store::monad_outbox::{
        ConfirmedPrefixRecovery, MonadOutboxLifecycle, MonadOutboxMember, MonadOutboxMemberState,
        MonadOutboxPolicy, MonadOutboxTerminal,
    },
};

const PAYMENT_COMMITMENT_DOMAIN: &[u8] = b"frank:dm-stamp-payment:v1";
pub(crate) const MAX_STAMP_PAYMENTS: usize = 64;

/// CPU-only facts, with no receipt observation or publication authority.
pub(crate) struct ValidatedPaymentInput<'a> {
    _request: &'a proto::MonadStampedMessage,
    _policy: &'a MonadOutboxPolicy,
    _payload_hash: [u8; 32],
    _payments: Vec<DecodedSignedTransaction>,
    _total_value_wei: u128,
}

/// A local immutable view of a completely validated durable confirmed set.
/// Its constructor is private; reopening and finalization must revalidate existing facts.
pub(crate) struct VerifiedSubmission<'a> {
    message: &'a proto::MonadStampedMessage,
    _canonical_message: &'a [u8],
    _payload_hash: &'a [u8],
    _policy: &'a MonadOutboxPolicy,
    _members: &'a [MonadOutboxMember],
    _signed_total_value_wei: u128,
}

impl<'a> VerifiedSubmission<'a> {
    pub(crate) fn message(&self) -> &'a proto::MonadStampedMessage {
        self.message
    }
}

pub(crate) fn verify_submission<'a>(
    message: &'a proto::MonadStampedMessage,
    canonical_message: &'a [u8],
    payload_hash: &'a [u8],
    policy: &'a MonadOutboxPolicy,
    members: &'a [MonadOutboxMember],
    expected_chain_id: u64,
) -> Result<VerifiedSubmission<'a>> {
    let signed_total_value_wei = confirmed_signed_total(
        message,
        canonical_message,
        payload_hash,
        policy,
        members.iter(),
        members.len(),
        expected_chain_id,
    )?;
    Ok(VerifiedSubmission {
        message,
        _canonical_message: canonical_message,
        _payload_hash: payload_hash,
        _policy: policy,
        _members: members,
        _signed_total_value_wei: signed_total_value_wei,
    })
}

#[derive(Debug)]
pub(crate) enum PaymentPreflightError {
    MissingStampPayments,
    TooManyStampPayments { actual: usize, maximum: usize },
    NonCanonicalChildIndex { position: usize, actual: u32 },
    DuplicateChildIndex(u32),
    FundingAccountRecoveryFailed(EvmTxError),
    UnexpectedChainId { expected: u64, actual: Option<u64> },
    DuplicateTransaction(Hash32),
    DuplicateFundingAccount(Address),
    InvalidStealthDestination(StampStealthError),
    InvalidPaymentPreflight { child_index: u32, detail: String },
    TotalValueOverflow,
    FundingAccountIsDestination(Address),
    InsufficientTotalValue { required: u128, actual: u128 },
}

pub(crate) fn validate_payment_set<'a>(
    request: &'a proto::MonadStampedMessage,
    payload_hash: [u8; 32],
    policy: &'a MonadOutboxPolicy,
    expected_chain_id: u64,
) -> std::result::Result<ValidatedPaymentInput<'a>, PaymentPreflightError> {
    if request.stamp_payments.is_empty() {
        return Err(PaymentPreflightError::MissingStampPayments);
    }
    if request.stamp_payments.len() > MAX_STAMP_PAYMENTS {
        return Err(PaymentPreflightError::TooManyStampPayments {
            actual: request.stamp_payments.len(),
            maximum: MAX_STAMP_PAYMENTS,
        });
    }
    let mut child_indices = HashSet::new();
    let mut funding_accounts = HashSet::new();
    let mut transaction_hashes = HashSet::new();
    let mut destination_addresses = HashSet::new();
    let mut total_value_wei = 0u128;
    let mut decoded_payments = Vec::with_capacity(request.stamp_payments.len());
    for (position, payment) in request.stamp_payments.iter().enumerate() {
        if payment.child_index as usize != position {
            return Err(PaymentPreflightError::NonCanonicalChildIndex {
                position,
                actual: payment.child_index,
            });
        }
        if !child_indices.insert(payment.child_index) {
            return Err(PaymentPreflightError::DuplicateChildIndex(
                payment.child_index,
            ));
        }
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .map_err(PaymentPreflightError::FundingAccountRecoveryFailed)?;
        if decoded.chain_id != Some(expected_chain_id) {
            return Err(PaymentPreflightError::UnexpectedChainId {
                expected: expected_chain_id,
                actual: decoded.chain_id,
            });
        }
        if !transaction_hashes.insert(decoded.tx_hash) {
            return Err(PaymentPreflightError::DuplicateTransaction(decoded.tx_hash));
        }
        if !funding_accounts.insert(decoded.sender) {
            return Err(PaymentPreflightError::DuplicateFundingAccount(
                decoded.sender,
            ));
        }
        let destination = derive_monad_stamp_child_public(
            payload_hash,
            &policy.recipient_pubkey,
            payment.child_index,
        )
        .map_err(PaymentPreflightError::InvalidStealthDestination)?;
        let destination_address = Address(destination.address);
        destination_addresses.insert(destination_address);
        let expected_commitment = payment_commitment(&payload_hash, payment.child_index);
        if decoded.destination != Some(destination_address) {
            return Err(PaymentPreflightError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "destination {:?} does not match expected {destination_address}",
                    decoded.destination
                ),
            });
        }
        if decoded.value_wei == 0 {
            return Err(PaymentPreflightError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: "value must be positive".to_string(),
            });
        }
        let actual_commitment =
            parse_commitment_calldata(BROADCAST_MESSAGE_LOKAD_ID, &decoded.input).map_err(
                |err| PaymentPreflightError::InvalidPaymentPreflight {
                    child_index: payment.child_index,
                    detail: err.to_string(),
                },
            )?;
        if actual_commitment != expected_commitment {
            return Err(PaymentPreflightError::InvalidPaymentPreflight {
                child_index: payment.child_index,
                detail: format!(
                    "commitment {actual_commitment} does not match expected {expected_commitment}"
                ),
            });
        }
        total_value_wei = total_value_wei
            .checked_add(decoded.value_wei)
            .ok_or(PaymentPreflightError::TotalValueOverflow)?;
        decoded_payments.push(decoded);
    }
    if let Some(address) = funding_accounts.intersection(&destination_addresses).next() {
        return Err(PaymentPreflightError::FundingAccountIsDestination(*address));
    }
    if total_value_wei < policy.min_value_wei {
        return Err(PaymentPreflightError::InsufficientTotalValue {
            required: policy.min_value_wei,
            actual: total_value_wei,
        });
    }
    Ok(ValidatedPaymentInput {
        _request: request,
        _policy: policy,
        _payload_hash: payload_hash,
        _payments: decoded_payments,
        _total_value_wei: total_value_wei,
    })
}

pub(super) fn validate_persisted_record(
    snapshot: &crate::store::monad_outbox::MonadOutboxSnapshot,
    payload_hash: &[u8],
    expected_chain_id: u64,
) -> Result<()> {
    let record = &snapshot.record;
    let message = &snapshot.message;
    let canonical = record.canonical_message.as_deref().expect("decoded above");
    if message.encode_to_vec() != canonical {
        bail!("persisted canonical request uses a noncanonical protobuf encoding");
    }
    validate_persisted_message(message, payload_hash, expected_chain_id)?;
    let policy = record.policy.as_ref().ok_or_else(|| {
        crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
            "active outbox row has no frozen policy".to_string(),
        )
    })?;
    policy.validate_recipient_authority()?;
    let key: [u8; 32] = payload_hash.try_into().expect("validated payload hash");
    let require_fully_confirmed = record.lifecycle == MonadOutboxLifecycle::FullyConfirmed;
    if snapshot.members.len() != message.stamp_payments.len() {
        bail!("persisted member count differs from canonical owner");
    }
    for (payment, member) in message.stamp_payments.iter().zip(&snapshot.members) {
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .wrap_err("decoding persisted referenced signed payment")?;
        let expected_destination =
            derive_monad_stamp_child_public(key, &policy.recipient_pubkey, payment.child_index)?;
        if decoded.destination != Some(crate::monad_http::Address(expected_destination.address)) {
            bail!("persisted payment destination differs from frozen recipient derivation");
        }
        if decoded.value_wei == 0 {
            bail!("persisted payment has zero signed value");
        }
        match member.state {
            MonadOutboxMemberState::Confirmed { value_wei, .. } => {
                if value_wei != decoded.value_wei {
                    bail!("persisted confirmation value differs from signed transaction value");
                }
            }
            _ if require_fully_confirmed => {
                bail!("fully-confirmed claim contains a non-confirmed member")
            }
            _ => {}
        }
    }
    if require_fully_confirmed {
        validate_fully_confirmed_snapshot(
            message,
            canonical,
            payload_hash,
            policy,
            snapshot.members.iter(),
            snapshot.members.len(),
            expected_chain_id,
        )?;
    }
    Ok(())
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
    recovery.policy.validate_recipient_authority()?;
    if recovery
        .confirmed_prefix
        .len()
        .saturating_add(recovery.remaining_members.len())
        != recovery.message.stamp_payments.len()
    {
        bail!("recovery snapshot member count differs from canonical request");
    }
    let members = recovery
        .confirmed_prefix
        .iter()
        .chain(&recovery.remaining_members);
    if recovery.lifecycle == MonadOutboxLifecycle::FullyConfirmed {
        return validate_fully_confirmed_snapshot(
            &recovery.message,
            &recovery.canonical_message,
            &recovery.payload_hash,
            &recovery.policy,
            members,
            recovery
                .confirmed_prefix
                .len()
                .saturating_add(recovery.remaining_members.len()),
            expected_chain_id,
        );
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

pub(super) fn validate_persisted_message(
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
    if message.stamp_payments.is_empty()
        || message.stamp_payments.len() > crate::store::monad_outbox::MAX_MEMBERS_HARD
    {
        bail!(
            "persisted payment cardinality {} is outside 1..={}",
            message.stamp_payments.len(),
            crate::store::monad_outbox::MAX_MEMBERS_HARD,
        );
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

/// Validate the complete durable authority immediately before atomic inbox publication.
pub(crate) fn validate_fully_confirmed_snapshot<'a, I>(
    message: &proto::MonadStampedMessage,
    canonical_message: &[u8],
    payload_hash: &[u8],
    policy: &crate::store::monad_outbox::MonadOutboxPolicy,
    members: I,
    member_count: usize,
    expected_chain_id: u64,
) -> Result<()>
where
    I: Iterator<Item = &'a crate::store::monad_outbox::MonadOutboxMember>,
{
    confirmed_signed_total(
        message,
        canonical_message,
        payload_hash,
        policy,
        members,
        member_count,
        expected_chain_id,
    )
    .map(|_| ())
}

fn confirmed_signed_total<'a, I>(
    message: &proto::MonadStampedMessage,
    canonical_message: &[u8],
    payload_hash: &[u8],
    policy: &crate::store::monad_outbox::MonadOutboxPolicy,
    members: I,
    member_count: usize,
    expected_chain_id: u64,
) -> Result<u128>
where
    I: Iterator<Item = &'a crate::store::monad_outbox::MonadOutboxMember>,
{
    if message.encode_to_vec() != canonical_message {
        bail!("fully-confirmed canonical request uses a noncanonical protobuf encoding");
    }
    validate_persisted_message(message, payload_hash, expected_chain_id)?;
    policy.validate_recipient_authority()?;
    if member_count != message.stamp_payments.len() {
        bail!("fully-confirmed member count differs from canonical request");
    }
    let key: [u8; 32] = payload_hash.try_into().map_err(|_| {
        crate::store::monad_outbox::DbMonadOutboxError::InvalidPayloadHashLength(payload_hash.len())
    })?;
    let mut total = 0u128;
    for (payment, member) in message.stamp_payments.iter().zip(members) {
        if member.child_index != payment.child_index
            || member.tx_hash != Hash32(Keccak256::digest(&payment.raw_tx).into())
        {
            bail!("fully-confirmed member index/hash reference mismatch");
        }
        let MonadOutboxMemberState::Confirmed { value_wei, .. } = member.state else {
            bail!("fully-confirmed claim contains a non-confirmed member");
        };
        let decoded = decode_signed_transaction(&payment.raw_tx)
            .wrap_err("decoding fully-confirmed signed payment")?;
        let expected_destination =
            derive_monad_stamp_child_public(key, &policy.recipient_pubkey, payment.child_index)?;
        if decoded.destination != Some(crate::monad_http::Address(expected_destination.address)) {
            bail!("fully-confirmed payment destination differs from frozen recipient derivation");
        }
        if decoded.value_wei == 0 || value_wei != decoded.value_wei {
            bail!("fully-confirmed value differs from the positive signed transaction value");
        }
        total = total.checked_add(decoded.value_wei).ok_or_else(|| {
            crate::store::monad_outbox::DbMonadOutboxError::CorruptRecord(
                "fully-confirmed signed value sum overflowed".to_string(),
            )
        })?;
    }
    if total < policy.min_value_wei {
        bail!("fully-confirmed signed value total is below the frozen minimum");
    }
    Ok(total)
}

pub(super) fn expected_payment(
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

pub(crate) fn payment_commitment(payload_hash: &[u8; 32], child_index: u32) -> Sha256 {
    let mut preimage = Vec::with_capacity(PAYMENT_COMMITMENT_DOMAIN.len() + 36);
    preimage.extend_from_slice(PAYMENT_COMMITMENT_DOMAIN);
    preimage.extend_from_slice(payload_hash);
    preimage.extend_from_slice(&child_index.to_be_bytes());
    Sha256::digest(preimage.into())
}

pub(super) enum MemberOutcome {
    Confirmed {
        value_wei: u128,
        block_number: u64,
    },
    /// The node definitively did not accept the send (or a follow-up proved it never landed).
    Pending(String),
    /// Still unresolved, but the node accepted the transaction or an exact-hash lookup shows it.
    /// Only this outcome makes the member recipient-recoverable exposure.
    Submitted(String),
    Terminal(MonadOutboxTerminal, String),
}

pub(super) enum ExactCheck {
    Missing,
    Submitted,
    Confirmed { value_wei: u128, block_number: u64 },
    Invalid(String),
    Infrastructure(String),
}

pub(super) async fn check_exact<T: JsonRpcTransport + Clone>(
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
        Ok(Some(receipt)) => Some(receipt),
        Ok(None) => None,
        Err(err) => return ExactCheck::Infrastructure(err.to_string()),
    };
    if receipt
        .as_ref()
        .map(|receipt| receipt.transaction_hash != tx_hash)
        .unwrap_or(false)
    {
        return ExactCheck::Infrastructure(format!(
            "receipt returned hash {} for requested exact hash {}",
            receipt.as_ref().expect("checked above").transaction_hash,
            tx_hash
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
        Ok(None) if receipt.is_some() => {
            return ExactCheck::Infrastructure(
                "exact receipt exists but transaction lookup returned nothing".to_string(),
            )
        }
        Ok(None) => return ExactCheck::Missing,
        Err(err) => return ExactCheck::Infrastructure(err.to_string()),
    };
    if transaction.from != canonical.sender
        || transaction.to != canonical.destination
        || transaction.value != canonical.value_wei
        || transaction.input != canonical.input
    {
        return ExactCheck::Infrastructure(
            "RPC transaction/receipt body does not match canonical signed transaction".to_string(),
        );
    }
    let Some(receipt) = receipt else {
        return ExactCheck::Submitted;
    };
    if receipt.from != canonical.sender || receipt.to != canonical.destination {
        return ExactCheck::Infrastructure(
            "RPC receipt body does not match canonical signed transaction".to_string(),
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

pub(super) async fn check_exact_bounded<T: JsonRpcTransport + Clone>(
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

pub(super) async fn replay_member<T: JsonRpcTransport + Clone>(
    transport: &T,
    tx_hash: Hash32,
    raw_tx: &[u8],
    canonical: &DecodedSignedTransaction,
    expected: &ExpectedStampTransaction,
    config: &MonadOutboxReconcileConfig,
) -> MemberOutcome {
    let client = MonadHttpClient::with_transport(transport.clone());
    let send = match tokio::time::timeout(config.rpc_timeout, client.send_raw_transaction(raw_tx))
        .await
    {
        Ok(send) => send,
        // The request may have reached the node: ambiguous, so exposure stays recorded.
        Err(_) => return MemberOutcome::Submitted("broadcast RPC deadline elapsed".to_string()),
    };
    let (nonce_too_low, accepted) = match send {
        // The node reported a different hash than the canonical transaction. It nevertheless
        // took a submission for these bytes, so treat the exact transaction as possibly exposed.
        Ok(submitted) if submitted.tx_hash != tx_hash => {
            return MemberOutcome::Submitted(format!(
                "submission RPC returned {} for canonical transaction hash {}",
                submitted.tx_hash, tx_hash
            ))
        }
        Ok(_) => (false, true),
        Err(err) if err.says_tx_already_held() => (false, true),
        Err(MonadRpcError::NonceTooLow { .. }) => (true, false),
        // Only a node-stated (or gateway-refused) rejection proves it was not accepted.
        Err(err) if err.definitively_rejected_send() => {
            return MemberOutcome::Pending(err.to_string())
        }
        // Transport errors, HTTP failures and unparsable responses do not tell us whether the
        // node accepted the transaction: ambiguous.
        Err(err) => return MemberOutcome::Submitted(err.to_string()),
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
        ExactCheck::Infrastructure(detail) if accepted => MemberOutcome::Submitted(detail),
        ExactCheck::Infrastructure(detail) => MemberOutcome::Pending(detail),
        ExactCheck::Submitted => MemberOutcome::Submitted(
            "exact signed transaction remains submitted without a receipt".to_string(),
        ),
        ExactCheck::Missing if nonce_too_low => {
            prove_stale_nonce(transport, tx_hash, canonical, expected, config).await
        }
        ExactCheck::Missing => MemberOutcome::Submitted(
            "exact transaction remains unconfirmed after bounded polling".to_string(),
        ),
    }
}

pub(super) async fn prove_stale_nonce<T: JsonRpcTransport + Clone>(
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
        ExactCheck::Submitted => MemberOutcome::Submitted(
            "exact signed transaction remains submitted without a receipt".to_string(),
        ),
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

#[cfg(test)]
mod tests {
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;

    use super::*;
    use crate::monad_evm_tx::test_support::signed_eip1559_tx;

    fn signed_fixture() -> (
        proto::MonadStampedMessage,
        MonadOutboxPolicy,
        Vec<MonadOutboxMember>,
    ) {
        let encrypted_payload = b"private financial owner fixture".to_vec();
        let payload_hash: [u8; 32] = Sha256::digest(encrypted_payload.clone().into())
            .as_slice()
            .try_into()
            .unwrap();
        let recipient_pubkey = vec![2; 33];
        let policy = MonadOutboxPolicy::new(
            crate::monad_stamp_stealth::recipient_address_from_public_key(&recipient_pubkey)
                .unwrap(),
            recipient_pubkey,
            20,
            b"testnet".to_vec(),
        )
        .unwrap();
        let mut stamp_payments = Vec::new();
        let mut members = Vec::new();
        for child_index in 0..2 {
            let destination = derive_monad_stamp_child_public(
                payload_hash,
                &policy.recipient_pubkey,
                child_index,
            )
            .unwrap();
            let mut input = BROADCAST_MESSAGE_LOKAD_ID.to_vec();
            input.push(crate::monad_stamp_verify::COMMITMENT_VERSION_TAG);
            input.extend_from_slice(payment_commitment(&payload_hash, child_index).as_slice());
            let secret = EccSecp256k1::default()
                .seckey_from_array([child_index as u8 + 1; 32])
                .unwrap();
            let (raw_tx, _) = signed_eip1559_tx(
                &secret,
                41_454,
                child_index as u64,
                Address(destination.address),
                10,
                &input,
            );
            let tx_hash = decode_signed_transaction(&raw_tx).unwrap().tx_hash;
            stamp_payments.push(proto::MonadStampPayment {
                child_index,
                raw_tx,
            });
            members.push(MonadOutboxMember {
                child_index,
                tx_hash,
                state: MonadOutboxMemberState::Confirmed {
                    value_wei: 10,
                    block_number: 42,
                },
                attempts: 1,
                exposed: true,
                lease_generation: 1,
                lease_until_ms: 0,
                next_replay_at_ms: 0,
                updated_at_ms: 0,
                last_error: String::new(),
            });
        }
        (
            proto::MonadStampedMessage {
                encrypted_payload,
                payload_hash: payload_hash.to_vec(),
                stamp_payments,
            },
            policy,
            members,
        )
    }

    #[test]
    fn cpu_preflight_does_not_supply_confirmed_authority() -> Result<()> {
        let (request, policy, mut members) = signed_fixture();
        let payload_hash = request.payload_hash.as_slice().try_into().unwrap();
        let cpu = validate_payment_set(&request, payload_hash, &policy, 41_454).unwrap();
        assert!(std::ptr::eq(cpu._request, &request));
        assert_eq!(cpu._payments.len(), 2);
        assert_eq!(cpu._total_value_wei, 20);
        assert_eq!(cpu._payments[1].nonce, 1);
        assert_eq!(cpu._payments[1].tx_hash, members[1].tx_hash);
        members[1].state = MonadOutboxMemberState::Pending;
        let canonical = request.encode_to_vec();
        let error = verify_submission(
            &request,
            &canonical,
            &request.payload_hash,
            &policy,
            &members,
            41_454,
        )
        .err()
        .expect("CPU validation cannot replace a confirmed member");
        assert!(error.to_string().contains("non-confirmed member"));
        members[1].state = MonadOutboxMemberState::Confirmed {
            value_wei: 10,
            block_number: 42,
        };
        let verified = verify_submission(
            &request,
            &canonical,
            &request.payload_hash,
            &policy,
            &members,
            41_454,
        )?;
        assert!(std::ptr::eq(verified.message(), &request));
        assert!(std::ptr::eq(verified._members, members.as_slice()));
        assert!(std::ptr::eq(verified._policy, &policy));
        assert_eq!(verified._canonical_message, canonical);
        assert_eq!(verified._signed_total_value_wei, 20);
        Ok(())
    }

    #[test]
    fn confirmed_view_rejects_exact_binding_and_frozen_value_mismatches() -> Result<()> {
        let (request, policy, members) = signed_fixture();
        let canonical = request.encode_to_vec();
        let assert_rejected = |request: &proto::MonadStampedMessage,
                               canonical: &[u8],
                               policy: &MonadOutboxPolicy,
                               members: &[MonadOutboxMember],
                               diagnostic: &str| {
            let error = verify_submission(
                request,
                canonical,
                &request.payload_hash,
                policy,
                members,
                41_454,
            )
            .err()
            .expect("altered authority must fail complete validation");
            assert!(error.to_string().contains(diagnostic), "{error}");
        };
        let mut wrong_member = members.clone();
        wrong_member[0].tx_hash = Hash32([0xff; 32]);
        assert_rejected(
            &request,
            &canonical,
            &policy,
            &wrong_member,
            "index/hash reference mismatch",
        );
        wrong_member = members.clone();
        wrong_member[0].child_index = 1;
        assert_rejected(
            &request,
            &canonical,
            &policy,
            &wrong_member,
            "index/hash reference mismatch",
        );
        wrong_member = members.clone();
        wrong_member[0].state = MonadOutboxMemberState::Confirmed {
            value_wei: 11,
            block_number: 42,
        };
        assert_rejected(
            &request,
            &canonical,
            &policy,
            &wrong_member,
            "signed transaction value",
        );
        assert_rejected(&request, &canonical, &policy, &members[..1], "member count");
        let mut wrong_policy = policy.clone();
        wrong_policy.min_value_wei = 21;
        assert_rejected(
            &request,
            &canonical,
            &wrong_policy,
            &members,
            "frozen minimum",
        );
        let mut wrong_request = request.clone();
        wrong_request.encrypted_payload.push(0);
        assert_rejected(
            &wrong_request,
            &canonical,
            &policy,
            &members,
            "noncanonical protobuf encoding",
        );
        let tampered_canonical = wrong_request.encode_to_vec();
        assert_rejected(
            &wrong_request,
            &tampered_canonical,
            &policy,
            &members,
            "SHA256(encrypted_payload)",
        );
        Ok(())
    }

    #[test]
    fn cpu_preflight_retains_index_before_chain_error_precedence() {
        let (mut request, policy, _) = signed_fixture();
        request.stamp_payments[0].child_index = 1;
        let error = validate_payment_set(
            &request,
            request.payload_hash.as_slice().try_into().unwrap(),
            &policy,
            1,
        )
        .err()
        .expect("both malformed index and wrong chain");
        assert!(matches!(
            error,
            PaymentPreflightError::NonCanonicalChildIndex {
                position: 0,
                actual: 1
            }
        ));
        request.stamp_payments[0].child_index = 0;
        let error = validate_payment_set(
            &request,
            request.payload_hash.as_slice().try_into().unwrap(),
            &policy,
            1,
        )
        .err()
        .expect("chain mismatch after canonical index");
        assert!(matches!(
            error,
            PaymentPreflightError::UnexpectedChainId {
                expected: 1,
                actual: Some(41_454)
            }
        ));
    }
}
