//! What a direct message's payments must look like before the relay stores it.
//!
//! Structural validation runs before durable acceptance. The configured EVM runtime supplies
//! the verified node for prechecks and post-acceptance broadcasts. Delivery orchestration and
//! durable payment uniqueness remain with the HTTP/store owners.

use crate::canonical_dm_request::ExactRequest;
use bitcoinsuite_core::{Hashed, Sha256};
use serde::Serialize;
use sha3::{Digest, Keccak256};
use std::collections::HashSet;

use crate::{
    evm_rpc::{Address, Hash32},
    evm_transaction::{decode_signed_transaction, DecodedSignedTransaction},
};

/// Most payments one message may carry.
pub(crate) const MAX_STAMP_PAYMENTS: usize = 64;

/// A request that has passed every check, ready to be stored. Only this module makes one.
pub(crate) struct CanonicalPaymentInput {
    pub(crate) request: crate::canonical_dm_request::ExactRequest,
    pub(crate) policy: crate::store::evm_direct_messages::FrozenCanonicalPolicy,
    payments: Vec<DecodedSignedTransaction>,
}

impl CanonicalPaymentInput {
    /// The hash of each signed payment, which the store records so a payment pays for one
    /// message only.
    pub(crate) fn payment_hashes(&self) -> impl Iterator<Item = Hash32> + '_ {
        self.payments.iter().map(|payment| payment.tx_hash)
    }

    /// The signed payments as decoded, in the order the message lists them.
    pub(crate) fn payments(&self) -> &[DecodedSignedTransaction] {
        &self.payments
    }
}

#[cfg(test)]
impl CanonicalPaymentInput {
    /// Test seam for storing many messages quickly: skips the directory lookups, which were
    /// already made for `policy`. Every check that reads only the request bytes still runs.
    pub(crate) fn without_directory(
        request: crate::canonical_dm_request::ExactRequest,
        policy: crate::store::evm_direct_messages::FrozenCanonicalPolicy,
    ) -> crate::evm_mailbox::Result<Self> {
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
    request: crate::canonical_dm_request::ExactRequest,
    recipient: &crate::directory_admission::Current,
    recipient_evidence: Option<&crate::directory_admission::HistoricalEvidence>,
    network: &str,
    chain_id: u64,
    minimum: u128,
    payment_floor: u128,
) -> crate::evm_mailbox::Result<CanonicalPaymentInput> {
    use crate::{
        evm_mailbox::CanonicalError as Error, store::evm_direct_messages::FrozenCanonicalPolicy,
    };
    use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
    let checks = crate::evm_dm_verify::verify_canonical_stamp(
        crate::evm_dm_verify::CanonicalStampCheckInput {
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
        sender_p: sender_p
            .as_ref()
            .map(|s| s.key_bytes.clone())
            .unwrap_or_default(),
        recipient_p: recipient_p.key_bytes.clone(),
        sender_m: checks
            .sender_message_key
            .as_ref()
            .map(|m| m.key_bytes.clone())
            .unwrap_or_default(),
        recipient_m: recipient.message_key.key_bytes.clone(),
        stamp: destination.key_bytes.clone(),
        sender_t1: checks.sender_directory_hash.unwrap_or([0; 32]),
        recipient_t1: recipient_evidence.unwrap_or(&recipient.evidence).hash,
        payload_hash: checks.payload_digest,
    };
    // Both parties' mailboxes are keyed by the address of their key, so a key that is not a
    // point on the curve is a malformed message, refused here rather than failing in the store.
    if (!policy.sender_p.is_empty() && policy.sender().is_err()) || policy.recipient().is_err() {
        return Err(Error::Invalid);
    }
    let payments = canonical_signed_set(&request, &policy)?;
    // Each payment is a coin its recipient must move again: none may be below the network's
    // payment floor (`payment_floor_multiple` x one transfer at the minimum gas price,
    // `cashweb_config::protocol_payment_floor_wei`), so a received stamp is always worth ten
    // moves of it. Decided from the bytes, before anything is stored or broadcast.
    if payments
        .iter()
        .any(|payment| payment.value_wei < payment_floor)
    {
        return Err(Error::Invalid);
    }
    Ok(CanonicalPaymentInput {
        request,
        policy,
        payments,
    })
}

/// Every check of a message's payments that needs only the request bytes and the policy:
/// frame, context, proof, and each signed transaction against its listed member.
fn canonical_signed_set(
    request: &crate::canonical_dm_request::ExactRequest,
    policy: &crate::store::evm_direct_messages::FrozenCanonicalPolicy,
) -> crate::evm_mailbox::Result<Vec<DecodedSignedTransaction>> {
    use crate::evm_mailbox::CanonicalError as Error;
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
    let sealed_sender = policy.sender_p.is_empty();
    let expected_sender = (!sealed_sender).then(|| account(&policy.sender_p));
    if network != &policy.network
        || inner_network != network
        || payload_frame.schema_version != 2
        || payload_frame.min_reader_version != 2
        || sender != &expected_sender
        || (sealed_sender && (!policy.sender_m.is_empty() || policy.sender_t1 != [0; 32]))
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
    let sender_m = (!sealed_sender).then(|| account(&policy.sender_m));
    let recipient_m = account(&policy.recipient_m);
    let context = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network,
        sender: sender.as_ref(),
        recipient,
        sender_directory_hash: (!sealed_sender).then_some(policy.sender_t1.as_slice()),
        recipient_directory_hash: &policy.recipient_t1,
        sender_message_key: sender_m.as_ref(),
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
    crate::evm_dm_verify::verify_canonical_stamp_proof(
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
        let child_index = member.child_index.ok_or(Error::Invalid)?;
        // The relay verifies a stamp only on its policy chain: the member must settle on the
        // delivery network, which admission bound to `policy.network` and `policy.chain_id`.
        if member.stealth.is_some() || member.network != policy.network {
            return Err(Error::Invalid);
        }
        let (_, address) = crate::evm_dm_verify::canonical_stamp_destination(
            &policy.network,
            destination,
            shared_point,
            child_index,
        )
        .map_err(|_| Error::Invalid)?;
        let commitment = payment_commitment(&policy.payload_hash, child_index);
        let member_value_wei = match &member.value {
            frank_cbor::PaymentValue::Quantity(b) => {
                if b.len() != 32 || b[..16].iter().any(|byte| *byte != 0) {
                    return Err(Error::Invalid);
                }
                u128::from_be_bytes(b[16..].try_into().map_err(|_| Error::Invalid)?)
            }
            frank_cbor::PaymentValue::Satoshis(s) => *s as u128,
        };
        if child_index as usize != position
            || signed.chain_id != Some(policy.chain_id)
            || member.transaction_id.as_slice() != signed.tx_hash.0
            || !hashes.insert(signed.tx_hash)
            || !funding.insert(signed.sender)
            || member_value_wei != signed.value_wei
            || signed.value_wei == 0
            || signed.destination != Some(Address(address))
            || member.address.as_slice() != address
            || member.commitment.as_deref() != Some(commitment.as_slice())
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

/// A message's payments are handed to the node at most once in this long. A repeat of the
/// same message inside it is answered `delivered` without sending them again. That includes a
/// repeat sent because the first broadcast failed: the window starts at the attempt, not at
/// a success.
pub(crate) const REBROADCAST_INTERVAL: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(300)
} else {
    std::time::Duration::from_secs(5)
};

/// Longest the relay waits on the node for one payment before answering the sender anyway.
const BROADCAST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Hand every payment of a delivered message to the node once, all at the same time. The
/// results are logged and nothing else: a payment the node refused, or one that could not be
/// sent in time, is simply not sent. A resend of the same message sends them again, once
/// [`REBROADCAST_INTERVAL`] has passed. The interval starts when the payments are handed over,
/// whether or not the node took them, so a failed broadcast is not retried inside it either.
///
/// Returns what was logged for each payment: the outcome of one that went out, or the reason
/// one did not.
pub(crate) async fn broadcast_payments(
    runtime: &crate::evm_mailbox::EnabledEvmMailboxRuntime,
    claim: &crate::store::evm_direct_messages::Claim,
) -> Vec<std::result::Result<&'static str, String>> {
    let Some(transport) = runtime.transport() else {
        tracing::event!(
            tracing::Level::WARN,
            payload_hash = %hex::encode(claim.policy.payload_hash),
            "Payments were not handed to the node: no upstream of the relay network has proved \
             its identity yet. A resend of the message hands them over again"
        );
        return claim
            .request
            .raw_transactions()
            .map(|_| Err("no verified node".to_owned()))
            .collect();
    };
    let client = crate::evm_rpc::EvmHttpClient::with_transport(transport);
    let wait = runtime.config().rpc_timeout.min(BROADCAST_TIMEOUT);
    let payload_hash = hex::encode(claim.policy.payload_hash);
    let sends = claim.request.raw_transactions().map(|raw| {
        let (client, payload_hash) = (&client, &payload_hash);
        let tx_hash = hex::encode(Keccak256::digest(raw));
        async move {
            let result = match tokio::time::timeout(wait, client.send_raw_transaction(raw)).await {
                Ok(Ok(_)) => Ok("accepted"),
                Ok(Err(error)) if error.says_tx_already_held() => Ok("already held"),
                Ok(Err(error)) if error.definitively_rejected_send() => {
                    Err(format!("refused by the node: {error}"))
                }
                Ok(Err(error)) => Err(format!("could not be sent: {error}")),
                Err(_) => Err("no answer from the node in time".to_owned()),
            };
            match &result {
                Ok(outcome) => tracing::event!(
                    tracing::Level::DEBUG,
                    payload_hash = %payload_hash,
                    tx_hash = %tx_hash,
                    outcome,
                    "Direct-message payment broadcast"
                ),
                Err(reason) => tracing::event!(
                    tracing::Level::WARN,
                    payload_hash = %payload_hash,
                    tx_hash = %tx_hash,
                    reason = %reason,
                    "Direct-message payment not broadcast; the message is delivered"
                ),
            }
            result
        }
    });
    futures::future::join_all(sends).await
}

/// Why a message's payments can never land, as the sender's client names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeadPayment {
    /// A payment's nonce is already used by a different transaction.
    StaleNonce,
    /// A sender's balance cannot cover its payments' value and most gas cost.
    InsufficientTotal,
}
impl DeadPayment {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::StaleNonce => "stale_nonce",
            Self::InsufficientTotal => "insufficient_total",
        }
    }
}

/// What the node says about one paying account.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SenderState {
    /// The account's next nonce as `eth_getTransactionCount(pending)` reports it. On Monad
    /// that is the nonce after the last included transaction: mempool transactions are not
    /// counted.
    pub(crate) pending_nonce: u64,
    /// The account's balance at `latest`.
    pub(crate) balance_wei: u128,
}

/// Ask the node whether a new message's payments can still land, before anything is stored.
/// `Some` only when the node says one cannot. `None` when they can, when there are none, and
/// when the node could not be asked in time: the message is then delivered as if there had
/// been no check, and the broadcast after it finds out.
///
/// Reads are made together: one pending nonce and one balance per paying account, then a
/// lookup by hash only for a payment whose nonce is already used. The whole check waits on
/// the node no longer than one broadcast does.
pub(crate) async fn precheck_payments(
    runtime: &crate::evm_mailbox::EnabledEvmMailboxRuntime,
    payments: &[crate::evm_transaction::DecodedSignedTransaction],
) -> Option<DeadPayment> {
    if payments.is_empty() {
        return None;
    }
    let wait = runtime.config().rpc_timeout.min(BROADCAST_TIMEOUT);
    let outcome = match runtime.transport() {
        None => Err("no verified node".to_owned()),
        Some(transport) => {
            let client = crate::evm_rpc::EvmHttpClient::with_transport(transport);
            match tokio::time::timeout(wait, ask_node(&client, payments)).await {
                Ok(outcome) => outcome,
                Err(_) => Err("no answer from the node in time".to_owned()),
            }
        }
    };
    match outcome {
        Ok(dead) => dead,
        Err(reason) => {
            tracing::event!(
                tracing::Level::WARN,
                reason = %reason,
                "Direct-message payment check skipped; the message is delivered"
            );
            None
        }
    }
}

/// The reads behind [`precheck_payments`]. `Err` when any read failed.
pub(crate) async fn ask_node<T: crate::evm_rpc::JsonRpcTransport>(
    client: &crate::evm_rpc::EvmHttpClient<T>,
    payments: &[crate::evm_transaction::DecodedSignedTransaction],
) -> std::result::Result<Option<DeadPayment>, String> {
    use crate::evm_rpc::BlockTag;
    use std::collections::{HashMap, HashSet};
    let senders: HashSet<Address> = payments.iter().map(|payment| payment.sender).collect();
    let reads = senders.iter().map(|&sender| async move {
        let (nonce, balance) = futures::future::join(
            client.get_transaction_count(sender, BlockTag::Pending),
            client.get_balance(sender, BlockTag::Latest),
        )
        .await;
        Ok::<_, crate::evm_rpc::EvmRpcError>((
            sender,
            SenderState {
                pending_nonce: nonce?,
                balance_wei: balance?,
            },
        ))
    });
    let states: HashMap<Address, SenderState> = futures::future::try_join_all(reads)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect();
    // A used nonce may be this very payment, already sent by the client or by an earlier
    // submission of this message. Only the node's own record of the hash tells. On Monad
    // `eth_getTransactionByHash` returns included transactions only, which matches a pending
    // nonce that counts included transactions only.
    let used = payments
        .iter()
        .filter(|payment| payment.nonce < states[&payment.sender].pending_nonce);
    let lookups = used.map(|payment| async move {
        client
            .get_transaction_by_hash(payment.tx_hash)
            .await
            .map(|found| found.map(|_| payment.tx_hash))
    });
    let known: HashSet<_> = futures::future::try_join_all(lookups)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .flatten()
        .collect();
    Ok(judge_payments(payments, &states, &known))
}

/// Whether a message's payments can still land, given what the node said. A message any of
/// whose payments the node already holds is delivered as before: it is a retry, and that
/// payment's cost is already out of the balance.
///
/// The balance check assumes a sender signs only from funds already in its `latest`
/// balance: no nonce stacking (a second transaction from an account whose earlier one is not
/// yet included), and no spending of unconfirmed incoming funds or change. Both the current
/// wallet and the coin list hold to this. If either is ever added, this check must move to a
/// pending balance or be softened, or it will refuse payments that would land. On Monad the
/// `pending` tag behaves as `latest` (docs.monad.xyz/reference/rpc-differences), so asking for
/// `pending` would not help there.
pub(crate) fn judge_payments(
    payments: &[crate::evm_transaction::DecodedSignedTransaction],
    states: &std::collections::HashMap<Address, SenderState>,
    known: &std::collections::HashSet<crate::evm_rpc::Hash32>,
) -> Option<DeadPayment> {
    if payments
        .iter()
        .any(|payment| known.contains(&payment.tx_hash))
    {
        return None;
    }
    if payments
        .iter()
        .any(|payment| payment.nonce < states[&payment.sender].pending_nonce)
    {
        return Some(DeadPayment::StaleNonce);
    }
    let mut owed = std::collections::HashMap::<Address, u128>::new();
    for payment in payments {
        let total = owed.entry(payment.sender).or_default();
        *total = total
            .saturating_add(payment.value_wei)
            .saturating_add(payment.max_gas_cost_wei);
    }
    owed.iter()
        .any(|(sender, total)| *total > states[sender].balance_wei)
        .then_some(DeadPayment::InsufficientTotal)
}

/// Total decoded EVM payment value used by the existing wakeup policy. This is not payment
/// settlement evidence and does not alter the durable admitted policy or recipient amount.
pub(crate) fn submitted_stamp_value_wei(claim: &crate::store::evm_direct_messages::Claim) -> u128 {
    claim
        .request
        .raw_transactions()
        .filter_map(|raw| decode_signed_transaction(raw).ok())
        .fold(0u128, |acc, tx| acc.saturating_add(tx.value_wei))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct SubmissionEcho {
    pub(crate) submission_identity: String,
    pub(crate) payload_hash: String,
    pub(crate) network: String,
    pub(crate) recipient: String,
    pub(crate) sender_t1: String,
    pub(crate) recipient_t1: String,
    pub(crate) delivery_sha256: String,
    pub(crate) context_sha256: String,
    pub(crate) transaction_hashes: Vec<String>,
}
impl SubmissionEcho {
    pub(crate) fn new(
        request: &ExactRequest,
        network: &str,
        recipient: crate::evm_rpc::Address,
        payload_hash: &[u8; 32],
        sender_t1: &[u8; 32],
        recipient_t1: &[u8; 32],
    ) -> Self {
        Self {
            submission_identity: hex::encode(request.submission_identity()),
            payload_hash: hex::encode(payload_hash),
            network: network.into(),
            recipient: recipient.to_hex(),
            sender_t1: hex::encode(sender_t1),
            recipient_t1: hex::encode(recipient_t1),
            delivery_sha256: hex::encode(
                Sha256::digest(request.delivery().to_vec().into()).as_slice(),
            ),
            context_sha256: hex::encode(
                Sha256::digest(request.context().to_vec().into()).as_slice(),
            ),
            transaction_hashes: request
                .raw_transactions()
                .map(|raw| format!("0x{}", hex::encode(Keccak256::digest(raw))))
                .collect(),
        }
    }
}
