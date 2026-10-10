//! What a direct message's payments must look like before the relay stores it.
//!
//! Everything here is decided from the request bytes and the recipient's directory entry.
//! Nothing is asked of the chain: the relay never learns whether a payment confirmed.

use std::collections::HashSet;

use crate::{
    monad_evm_tx::{decode_signed_transaction, DecodedSignedTransaction},
    monad_http::{Address, Hash32},
};

/// Most payments one message may carry.
pub(crate) const MAX_STAMP_PAYMENTS: usize = 64;

/// A request that has passed every check, ready to be stored. Only this module makes one.
pub(crate) struct CanonicalPaymentInput {
    pub(crate) request: crate::http::monad_message_cbor::ExactRequest,
    pub(crate) policy: crate::store::monad_dm_cbor::FrozenCanonicalPolicy,
    payments: Vec<DecodedSignedTransaction>,
}

impl CanonicalPaymentInput {
    /// The hash of each signed payment, which the store records so a payment pays for one
    /// message only.
    pub(crate) fn payment_hashes(&self) -> impl Iterator<Item = Hash32> + '_ {
        self.payments.iter().map(|payment| payment.tx_hash)
    }
}

#[cfg(test)]
impl CanonicalPaymentInput {
    /// Test seam for storing many messages quickly: skips the directory lookups, which were
    /// already made for `policy`. Every check that reads only the request bytes still runs.
    pub(crate) fn without_directory(
        request: crate::http::monad_message_cbor::ExactRequest,
        policy: crate::store::monad_dm_cbor::FrozenCanonicalPolicy,
    ) -> crate::http::monad_message_cbor::Result<Self> {
        let payments = canonical_signed_set(&request, &policy)?;
        Ok(Self {
            request,
            policy,
            payments,
        })
    }
}

/// New admission consumes a genuine facade snapshot of the recipient, never a decoded
/// statement as Current. The sender is whoever the request says: the relay neither looks the
/// sender up nor checks what the context states about the sender's directory entry.
pub(crate) fn validate_canonical_payment_set(
    request: crate::http::monad_message_cbor::ExactRequest,
    recipient: &crate::directory_admission::Current,
    recipient_evidence: Option<&crate::directory_admission::HistoricalEvidence>,
    network: &str,
    chain_id: u64,
    minimum: u128,
) -> crate::http::monad_message_cbor::Result<CanonicalPaymentInput> {
    use crate::{
        http::monad_message_cbor::CanonicalError as Error,
        store::monad_dm_cbor::FrozenCanonicalPolicy,
    };
    use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
    let checks = crate::monad_dm_verify::verify_canonical_stamp(
        crate::monad_dm_verify::CanonicalStampCheckInput {
            delivery: request.delivery(),
            context: request.context(),
            recipient_current: recipient,
            recipient_evidence,
        },
    )
    .map_err(|_| Error::Invalid)?;
    let ValidationResult::Parsed(frame) =
        validate_frame(request.delivery(), &relay_context()).map_err(|_| Error::Invalid)?
    else {
        return Err(Error::Invalid);
    };
    let Some(TypedPayload::DirectMessage {
        network: frame_network,
        destination,
        payload_frame,
        ..
    }) = frame.typed.as_deref()
    else {
        return Err(Error::Invalid);
    };
    let Some(TypedPayload::RecipientPayload {
        sender: sender_p,
        recipient: recipient_p,
        ..
    }) = payload_frame.typed.as_deref()
    else {
        return Err(Error::Invalid);
    };
    if frame_network != network {
        return Err(Error::Invalid);
    }
    let policy = FrozenCanonicalPolicy {
        network: network.to_owned(),
        chain_id,
        minimum,
        sender_p: sender_p.key_bytes.clone(),
        recipient_p: recipient_p.key_bytes.clone(),
        sender_m: checks.sender_message_key.key_bytes.clone(),
        recipient_m: recipient.message_key.key_bytes.clone(),
        stamp: destination.key_bytes.clone(),
        sender_t1: checks.sender_directory_hash,
        recipient_t1: recipient_evidence.unwrap_or(&recipient.evidence).hash,
        payload_hash: checks.payload_digest,
    };
    // Both parties' mailboxes are keyed by the address of their key, so a key that is not a
    // point on the curve is a malformed message, refused here rather than failing in the store.
    if policy.sender().is_err() || policy.recipient().is_err() {
        return Err(Error::Invalid);
    }
    let payments = canonical_signed_set(&request, &policy)?;
    Ok(CanonicalPaymentInput {
        request,
        policy,
        payments,
    })
}

/// Every check of a message's payments that needs only the request bytes and the policy:
/// frame, context, proof, and each signed transaction against its listed member.
fn canonical_signed_set(
    request: &crate::http::monad_message_cbor::ExactRequest,
    policy: &crate::store::monad_dm_cbor::FrozenCanonicalPolicy,
) -> crate::http::monad_message_cbor::Result<Vec<DecodedSignedTransaction>> {
    use crate::http::monad_message_cbor::CanonicalError as Error;
    use frank_cbor::{
        encode_direct_message_crypto_context, payment_commitment, recipient_payload_digest,
        relay_context, validate_frame, AccountRef, DirectMessageCryptoContext, TypedPayload,
        ValidationResult,
    };
    let ValidationResult::Parsed(frame) =
        validate_frame(request.delivery(), &relay_context()).map_err(|_| Error::Invalid)?
    else {
        return Err(Error::Invalid);
    };
    let Some(TypedPayload::DirectMessage {
        network,
        destination,
        payload_frame,
        payload_digest,
        payments,
        ..
    }) = frame.typed.as_deref()
    else {
        return Err(Error::Invalid);
    };
    let Some(TypedPayload::RecipientPayload {
        schema_version: 2,
        network: inner_network,
        sender,
        recipient,
        suite: 1,
        ephemeral_point,
        shared_point,
        dleq_proof,
        ..
    }) = payload_frame.typed.as_deref()
    else {
        return Err(Error::Invalid);
    };
    let account = |bytes: &[u8]| AccountRef {
        key_type: 1,
        key_bytes: bytes.to_vec(),
    };
    if network != &policy.network
        || inner_network != network
        || payload_frame.schema_version != 2
        || payload_frame.min_reader_version != 2
        || sender != &account(&policy.sender_p)
        || recipient != &account(&policy.recipient_p)
        || destination != &account(&policy.stamp)
        || recipient_payload_digest(network, &payload_frame.frame).map_err(|_| Error::Invalid)?
            != policy.payload_hash
        || payload_digest.as_slice() != policy.payload_hash
        || payments.len() > MAX_STAMP_PAYMENTS
        || payments.len() != request.transaction_count()
    {
        return Err(Error::Invalid);
    }
    let sender_m = account(&policy.sender_m);
    let recipient_m = account(&policy.recipient_m);
    let context = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network,
        sender,
        recipient,
        sender_directory_hash: &policy.sender_t1,
        recipient_directory_hash: &policy.recipient_t1,
        sender_message_key: &sender_m,
        recipient_message_key: &recipient_m,
        stamp_key: destination,
        ephemeral_point,
        shared_point,
        dleq_proof,
    })
    .map_err(|_| Error::Invalid)?;
    if !request.context().is_empty() && context != request.context() {
        return Err(Error::Invalid);
    }
    crate::monad_dm_verify::verify_canonical_stamp_proof(
        network,
        destination,
        ephemeral_point,
        shared_point,
        dleq_proof,
    )
    .map_err(|_| Error::Invalid)?;
    let mut hashes = HashSet::new();
    let mut funding = HashSet::new();
    let mut destinations = HashSet::new();
    let mut decoded = Vec::with_capacity(payments.len());
    let mut total = 0u128;
    for (position, (member, raw)) in payments.iter().zip(request.raw_transactions()).enumerate() {
        let signed = decode_signed_transaction(raw).map_err(|_| Error::Invalid)?;
        let (_, address) = crate::monad_dm_verify::canonical_stamp_destination(
            network,
            destination,
            shared_point,
            member.child_index,
        )
        .map_err(|_| Error::Invalid)?;
        let commitment = payment_commitment(&policy.payload_hash, member.child_index);
        let member_value_wei = match &member.value {
            frank_cbor::PaymentValue::Quantity(b) => {
                if b.len() != 32 || b[..16].iter().any(|byte| *byte != 0) {
                    return Err(Error::Invalid);
                }
                u128::from_be_bytes(b[16..].try_into().map_err(|_| Error::Invalid)?)
            }
            frank_cbor::PaymentValue::Satoshis(s) => *s as u128,
        };
        if member.child_index as usize != position
            || signed.chain_id != Some(policy.chain_id)
            || member.transaction_id.as_slice() != signed.tx_hash.0
            || !hashes.insert(signed.tx_hash)
            || !funding.insert(signed.sender)
            || member_value_wei != signed.value_wei
            || signed.value_wei == 0
            || signed.destination != Some(Address(address))
            || member.address.as_slice() != address
            || member.commitment.as_slice() != commitment
            // A direct-message stamp is a plain value transfer. Any calldata, including the
            // retired `POND` commitment, would make the payment identifiable on chain.
            || !signed.input.is_empty()
        {
            return Err(Error::Invalid);
        }
        destinations.insert(Address(address));
        total = total.checked_add(signed.value_wei).ok_or(Error::Invalid)?;
        decoded.push(signed);
    }
    if (!payments.is_empty() && total < policy.minimum)
        || funding.iter().any(|address| destinations.contains(address))
    {
        return Err(Error::Invalid);
    }
    Ok(decoded)
}
