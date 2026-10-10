//! Exact canonical DM transport. No legacy protobuf projection or implicit admission.
use std::{ops::Range, sync::Arc};

use crate::monad_http::Address;
use axum::{
    extract::RawBody,
    http::HeaderMap,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use frank_cbor::{encode_canonical, CborValue};
use serde::Serialize;
use sha3::{Digest, Keccak256};

pub(crate) const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_CONTEXT_BYTES: usize = 4096;
pub(crate) const MAX_RAW_TRANSACTION_BYTES: usize = 128 * 1024;

pub(crate) async fn handle_put(
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
    RawBody(mut body): RawBody,
) -> Result<Response> {
    use hyper::body::HttpBody;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unavailable)?;
    let descriptor = crate::network_tag::monad_network(runtime.network_tag())
        .ok_or(CanonicalError::Unavailable)?;
    if descriptor.evm_chain_id != runtime.expected_chain_id() {
        return Err(CanonicalError::Unavailable);
    }
    let content_type = single_header(&headers, "content-type")?.to_owned();
    if content_type.starts_with("multipart/form-data") {
        parse_boundary(&content_type, "multipart/form-data")?;
    } else if !content_type.starts_with("application/vnd.frank.cbor")
        && !content_type.starts_with("application/cbor")
        && !content_type.starts_with("application/octet-stream")
    {
        return Err(CanonicalError::Invalid);
    }
    if let Some(length) = headers.get("content-length") {
        let length = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or(CanonicalError::Invalid)?;
        if length > MAX_REQUEST_BYTES {
            return Err(CanonicalError::TooLarge);
        }
    }
    let bytes = tokio::time::timeout(crate::directory_runtime::RESPONSE_BUDGET, async {
        let mut bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|_| CanonicalError::Invalid)?;
            if chunk.len() > MAX_REQUEST_BYTES.saturating_sub(bytes.len()) {
                return Err(CanonicalError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| CanonicalError::Unavailable)??;
    let request = ExactRequest::parse(bytes, content_type)?;
    let owner = server.registry.canonical_dm();
    // An exact repeat of a stored message is answered from the store, whatever the directory
    // or the admission policy says today.
    let claim = if let Some(stored) = owner.find_request(&request)? {
        if stored.policy.network != descriptor.cbor_identifier
            || stored.policy.chain_id != descriptor.evm_chain_id
        {
            return Err(CanonicalError::Unavailable);
        }
        stored
    } else {
        if request.transaction_count() > runtime.reconcile().limits.max_members {
            return Err(CanonicalError::Invalid);
        }
        let principals = request_principals(&request, descriptor.cbor_identifier)?;
        // The recipient's own entry says which relay holds its mailbox. When this relay cannot
        // deliver there, say so as a final answer: nothing is stored, no payment is broadcast.
        let Some(recipient_current) =
            deliverable_recipient(owner, descriptor.cbor_identifier, &principals.recipient).await?
        else {
            return undeliverable_response(
                &request,
                descriptor.cbor_identifier,
                &principals,
                "undeliverable",
            );
        };
        // A sender whose own entry is missing or expired can republish and send a new message;
        // this one can never be verified.
        let Some(sender_current) =
            sender_entry(owner, descriptor.cbor_identifier, &principals.sender).await?
        else {
            return undeliverable_response(
                &request,
                descriptor.cbor_identifier,
                &principals,
                "sender_unpublished",
            );
        };
        let Principals {
            recipient,
            recipient_t1,
            ..
        } = principals;
        let historical = match recipient_t1 {
            Some(t1) if recipient_current.evidence.hash != t1 => {
                Some(history(owner, descriptor.cbor_identifier, &recipient, t1).await?)
            }
            _ => None,
        };
        // Everything that can refuse the message is decided from its bytes, here and in the
        // store's own checks, before anything is stored or broadcast.
        let input = crate::monad_outbox::financial::validate_canonical_payment_set(
            request,
            &sender_current,
            &recipient_current,
            historical.as_ref(),
            descriptor.cbor_identifier,
            descriptor.evm_chain_id,
            runtime.min_value_wei(),
        )?;
        owner.claim(input, now_ms())?
    };
    let claim = if matches!(
        claim.phase,
        crate::store::monad_dm_cbor::Phase::Delivered(_)
    ) {
        claim
    } else {
        owner.finalize(&claim.policy.payload_hash, now_ms())?
    };
    // The message is in the recipient's inbox from here on. Nothing below can undo that.
    if let Ok(recipient) = claim.policy.recipient() {
        // The notification is a courtesy to connected readers. A slow event bus must not
        // hold up the payments or the answer.
        let _ = tokio::time::timeout(
            EVENT_BUS_TIMEOUT,
            server
                .event_bus
                .publish_message_arrival(&recipient.to_hex(), &claim.policy.payload_hash),
        )
        .await;
    }
    if owner.may_broadcast_payments(&claim.policy.payload_hash, REBROADCAST_INTERVAL) {
        broadcast_payments(runtime, &claim).await;
    }
    accepted_response(&claim)
}

/// Longest the relay waits on the event bus to announce a delivered message.
const EVENT_BUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// A message's payments are handed to the node at most once in this long. A repeat of the
/// same message inside it is answered `delivered` without sending them again.
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
/// [`REBROADCAST_INTERVAL`] has passed.
///
/// Returns what was logged for each payment: the outcome of one that went out, or the reason
/// one did not.
async fn broadcast_payments(
    runtime: &crate::monad_mailbox::EnabledMonadMailboxRuntime,
    claim: &crate::store::monad_dm_cbor::Claim,
) -> Vec<std::result::Result<&'static str, String>> {
    let client = crate::monad_http::MonadHttpClient::with_transport(runtime.transport().clone());
    let wait = runtime.reconcile().rpc_timeout.min(BROADCAST_TIMEOUT);
    let payload_hash = hex::encode(claim.policy.payload_hash);
    let sends = claim
        .request
        .raw_transactions()
        .zip(&claim.members)
        .map(|(raw, member)| {
            let (client, payload_hash) = (&client, &payload_hash);
            async move {
                let result =
                    match tokio::time::timeout(wait, client.send_raw_transaction(raw)).await {
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
                        tx_hash = %member.tx_hash.to_hex(),
                        outcome,
                        "Direct-message payment broadcast"
                    ),
                    Err(reason) => tracing::event!(
                        tracing::Level::WARN,
                        payload_hash = %payload_hash,
                        tx_hash = %member.tx_hash.to_hex(),
                        reason = %reason,
                        "Direct-message payment not broadcast; the message is delivered"
                    ),
                }
                result
            }
        });
    futures::future::join_all(sends).await
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .ok_or(CanonicalError::Invalid)?;
    if values.next().is_some() {
        return Err(CanonicalError::Invalid);
    }
    Ok(value)
}
#[cfg(test)]
async fn current(
    owner: &crate::store::monad_dm_cbor::Owner,
    network: &str,
    subject: &[u8],
) -> Result<crate::directory_admission::Current> {
    use crate::directory_runtime::{AdmittedSnapshot, SnapshotOperation};
    let directory = owner.directory().ok_or(CanonicalError::Unavailable)?;
    let reservation = directory
        .reserve(network, &hex::encode(subject))
        .map_err(|_| CanonicalError::Unavailable)?;
    match directory
        .submit_snapshot(reservation, SnapshotOperation::Current)
        .wait()
        .await
        .map_err(|_| CanonicalError::Unavailable)?
    {
        AdmittedSnapshot::Current(current) => Ok(current),
        _ => Err(CanonicalError::Unavailable),
    }
}
async fn history(
    owner: &crate::store::monad_dm_cbor::Owner,
    network: &str,
    subject: &[u8],
    hash: [u8; 32],
) -> Result<crate::directory_admission::HistoricalEvidence> {
    use crate::directory_runtime::{AdmittedSnapshot, SnapshotOperation};
    let directory = owner.directory().ok_or(CanonicalError::Unavailable)?;
    let reservation = directory
        .reserve(network, &hex::encode(subject))
        .map_err(|_| CanonicalError::Unavailable)?;
    match directory
        .submit_snapshot(reservation, SnapshotOperation::Historical(hash))
        .wait()
        .await
        .map_err(|_| CanonicalError::Predecessor)?
    {
        AdmittedSnapshot::Historical(history) => Ok(history),
        _ => Err(CanonicalError::Unavailable),
    }
}
/// What a submission says about itself, read from its own bytes before any directory lookup.
pub(crate) struct Principals {
    pub(crate) sender: Vec<u8>,
    pub(crate) recipient: Vec<u8>,
    pub(crate) sender_t1: Option<[u8; 32]>,
    pub(crate) recipient_t1: Option<[u8; 32]>,
    pub(crate) payload_hash: [u8; 32],
}
/// The recipient's current entry when its mailbox is on this relay. `None` when this relay can
/// never deliver the message: the recipient has no current entry here, or its entry names
/// another relay. A directory that is merely busy is an error the sender may retry.
async fn deliverable_recipient(
    owner: &crate::store::monad_dm_cbor::Owner,
    network: &str,
    subject: &[u8],
) -> Result<Option<crate::directory_admission::Current>> {
    use crate::directory_runtime::{AdmittedSnapshot, RuntimeError, SnapshotOperation};
    let directory = owner.directory().ok_or(CanonicalError::Unavailable)?;
    let reservation = directory
        .reserve(network, &hex::encode(subject))
        .map_err(|_| CanonicalError::Unavailable)?;
    match directory
        .submit_snapshot(reservation, SnapshotOperation::Current)
        .wait()
        .await
    {
        Ok(AdmittedSnapshot::Current(current)) => {
            Ok(Some(current).filter(|current| directory.info().is_local(&current.relay)))
        }
        Ok(_) => Err(CanonicalError::Unavailable),
        Err(RuntimeError::Busy | RuntimeError::NotStarted | RuntimeError::OutcomeUnknown) => {
            Err(CanonicalError::Unavailable)
        }
        // Permanent for this request: never published here, expired, or quarantined.
        Err(RuntimeError::NotFound | RuntimeError::Expired | RuntimeError::Forked) => Ok(None),
        // Anything else is this relay's own trouble (clock, storage); the sender may retry.
        Err(_) => Err(CanonicalError::Unavailable),
    }
}
/// The sender's current entry, or `None` when it has none here: never published, expired or
/// quarantined. That is final for this request; a relay fault is an error the sender may retry.
async fn sender_entry(
    owner: &crate::store::monad_dm_cbor::Owner,
    network: &str,
    subject: &[u8],
) -> Result<Option<crate::directory_admission::Current>> {
    use crate::directory_runtime::{AdmittedSnapshot, RuntimeError, SnapshotOperation};
    let directory = owner.directory().ok_or(CanonicalError::Unavailable)?;
    let reservation = directory
        .reserve(network, &hex::encode(subject))
        .map_err(|_| CanonicalError::Unavailable)?;
    match directory
        .submit_snapshot(reservation, SnapshotOperation::Current)
        .wait()
        .await
    {
        Ok(AdmittedSnapshot::Current(current)) => Ok(Some(current)),
        Err(RuntimeError::NotFound | RuntimeError::Expired | RuntimeError::Forked) => Ok(None),
        _ => Err(CanonicalError::Unavailable),
    }
}
/// A final answer for a submission this relay will never deliver, in the shape of the other
/// dead answers. Nothing was retained and no payment was broadcast.
fn undeliverable_response(
    request: &ExactRequest,
    network: &str,
    principals: &Principals,
    reason: &str,
) -> Result<Response> {
    let recipient =
        crate::monad_stamp_stealth::recipient_address_from_public_key(&principals.recipient)
            .map_err(|_| CanonicalError::Invalid)?;
    let sender_t1 = principals.sender_t1.unwrap_or([0; 32]);
    let recipient_t1 = principals.recipient_t1.unwrap_or([0; 32]);
    let identity = SubmissionEcho::new(
        request,
        network,
        recipient,
        &principals.payload_hash,
        &sender_t1,
        &recipient_t1,
    );
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({"version":1,"phase":"dead","identity":identity,"reason":reason})),
    )
        .into_response())
}
fn request_principals(request: &ExactRequest, network: &str) -> Result<Principals> {
    use frank_cbor::{TypedPayload, ValidationResult};
    let ValidationResult::Parsed(frame) =
        frank_cbor::validate_frame(request.delivery(), &frank_cbor::relay_context())
            .map_err(|_| CanonicalError::Invalid)?
    else {
        return Err(CanonicalError::Invalid);
    };
    let Some(TypedPayload::DirectMessage {
        network: actual,
        payload_frame,
        ..
    }) = frame.typed.as_deref()
    else {
        return Err(CanonicalError::Invalid);
    };
    let Some(TypedPayload::RecipientPayload {
        sender, recipient, ..
    }) = payload_frame.typed.as_deref()
    else {
        return Err(CanonicalError::Invalid);
    };
    if actual != network || sender.key_type != 1 || recipient.key_type != 1 {
        return Err(CanonicalError::Invalid);
    }
    let (sender_t1, recipient_t1) = if !request.context().is_empty() {
        let CborValue::Map(context) =
            frank_cbor::decode_canonical(request.context()).map_err(|_| CanonicalError::Invalid)?
        else {
            return Err(CanonicalError::Invalid);
        };
        let hash = |wanted: u64| -> Result<[u8; 32]> {
            context
                .iter()
                .find_map(|(key, value)| match value {
                    CborValue::Bytes(hash) if *key == wanted => hash.as_slice().try_into().ok(),
                    _ => None,
                })
                .ok_or(CanonicalError::Invalid)
        };
        (Some(hash(4)?), Some(hash(5)?))
    } else {
        (None, None)
    };
    Ok(Principals {
        sender: sender.key_bytes.clone(),
        recipient: recipient.key_bytes.clone(),
        sender_t1,
        recipient_t1,
        payload_hash: frank_cbor::recipient_payload_digest(network, &payload_frame.frame)
            .map_err(|_| CanonicalError::Invalid)?,
    })
}
fn terminal_reason(reason: crate::store::monad_outbox::MonadOutboxTerminal) -> &'static str {
    use crate::store::monad_outbox::MonadOutboxTerminal::*;
    match reason {
        StaleNonce => "stale_nonce",
        VerificationFailed => "verification_failed",
        BroadcastRejected => "broadcast_rejected",
        CorruptReference => "corrupt_reference",
        InsufficientTotal => "insufficient_total",
        Expired => "expired",
        AttemptsExhausted => "attempts_exhausted",
    }
}
fn accepted_response(claim: &crate::store::monad_dm_cbor::Claim) -> Result<Response> {
    use crate::store::monad_dm_cbor::Phase;
    let identity = claim.echo()?;
    // A stored message is a delivered message; the handler never answers for anything else.
    let Phase::Delivered(timestamp) = claim.phase else {
        return Err(CanonicalError::Unavailable);
    };
    if !(0..=9_007_199_254_740_991).contains(&timestamp) {
        return Err(CanonicalError::Unavailable);
    }
    let (status, body) = (
        StatusCode::OK,
        serde_json::json!({"version":1,"phase":"delivered","identity":identity,"mailbox_committed_at_ms":timestamp}),
    );
    if serde_json::to_vec(&body)
        .map_err(|_| CanonicalError::Unavailable)?
        .len()
        > 16 * 1024
    {
        return Err(CanonicalError::Unavailable);
    }
    Ok((status, Json(body)).into_response())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CanonicalError {
    #[error("invalid canonical submission")]
    Invalid,
    #[error("canonical request or record exceeds its byte budget")]
    TooLarge,
    #[error("canonical directory predecessor missing")]
    Predecessor,
    #[error("canonical exact submission conflict")]
    Conflict,
    #[error("canonical mailbox unavailable")]
    Unavailable,
    #[error("canonical capacity exhausted")]
    Capacity,
    #[error("mailbox authentication failed")]
    Unauthorized,
    #[allow(dead_code)]
    #[error("recovery obligation is active")]
    ActiveObligation,
    #[error("recovery endpoint has been retired")]
    Retired,
}
pub(crate) type Result<T> = std::result::Result<T, CanonicalError>;
impl IntoResponse for CanonicalError {
    fn into_response(self) -> Response {
        if matches!(self, Self::Capacity) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(
                    axum::http::header::RETRY_AFTER,
                    (crate::monad_mailbox::CHALLENGE_TTL_MS / 1000).to_string(),
                )],
                Json(serde_json::json!({"version":1,"error":"mailbox_challenge_capacity"})),
            )
                .into_response();
        }
        let (status, error) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalid_canonical_submission"),
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "mailbox_record_exceeds_page_budget",
            ),
            Self::Predecessor => (
                StatusCode::CONFLICT,
                "canonical_directory_predecessor_missing",
            ),
            Self::Conflict => (StatusCode::CONFLICT, "canonical_submission_conflict"),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "canonical_mailbox_unavailable",
            ),
            Self::Capacity => unreachable!(),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "mailbox_auth_failed"),
            Self::ActiveObligation => (StatusCode::CONFLICT, "recovery_obligation_is_active"),
            Self::Retired => (StatusCode::GONE, "recovery_endpoint_retired"),
        };
        (status, Json(serde_json::json!({"version":1,"error":error}))).into_response()
    }
}

/// One copy-owned original body. Every part/member remains a byte range into this owner.
#[derive(Debug, Clone)]
pub(crate) struct ExactRequest {
    body: Arc<[u8]>,
    content_type: String,
    delivery: Range<usize>,
    context: Range<usize>,
    transactions: Vec<Range<usize>>,
    transactions_part: Range<usize>,
    submission_identity: [u8; 32],
    raw_tx_bytes: Vec<Vec<u8>>,
}
impl ExactRequest {
    pub(crate) fn parse(body: Vec<u8>, content_type: String) -> Result<Self> {
        if body.len() > MAX_REQUEST_BYTES {
            return Err(CanonicalError::TooLarge);
        }
        if content_type.starts_with("multipart/form-data") {
            let boundary = parse_boundary(&content_type, "multipart/form-data")?;
            let parts = parse_parts(
                &body,
                &boundary,
                "form-data",
                &[
                    ("delivery", "application/vnd.frank.cbor"),
                    ("context", "application/cbor"),
                    ("transactions", "application/cbor"),
                ],
            )?;
            if parts[0].is_empty() || parts[1].is_empty() || parts[1].len() > MAX_CONTEXT_BYTES {
                return Err(CanonicalError::TooLarge);
            }
            let transactions = transaction_ranges(&body[parts[2].clone()], parts[2].start)?;
            let tuple = CborValue::Array(vec![
                CborValue::Bytes(body[parts[0].clone()].to_vec()),
                CborValue::Bytes(body[parts[1].clone()].to_vec()),
                CborValue::Array(
                    transactions
                        .iter()
                        .map(|r| CborValue::Bytes(body[r.clone()].to_vec()))
                        .collect(),
                ),
            ]);
            let encoded = encode_canonical(&tuple).map_err(|_| CanonicalError::Invalid)?;
            let submission_identity = Sha256::digest(encoded.into())
                .as_slice()
                .try_into()
                .expect("SHA256");
            Ok(Self {
                body: body.into(),
                content_type,
                delivery: parts[0].clone(),
                context: parts[1].clone(),
                transactions_part: parts[2].clone(),
                transactions,
                submission_identity,
                raw_tx_bytes: Vec::new(),
            })
        } else if content_type.starts_with("application/vnd.frank.cbor")
            || content_type.starts_with("application/cbor")
            || content_type.starts_with("application/octet-stream")
        {
            use frank_cbor::{relay_context, validate_frame, TypedPayload, ValidationResult};
            let mut raw_tx_bytes = Vec::new();
            if let Ok(ValidationResult::Parsed(frame)) = validate_frame(&body, &relay_context()) {
                if let Some(TypedPayload::DirectMessage { payments, .. }) = frame.typed.as_deref() {
                    for payment in payments {
                        if let Some(raw) = payment.raw_transaction() {
                            raw_tx_bytes.push(raw.to_vec());
                        }
                    }
                }
            }
            let submission_identity = Sha256::digest((&body[..]).into())
                .as_slice()
                .try_into()
                .expect("SHA256");
            let len = body.len();
            Ok(Self {
                body: body.into(),
                content_type,
                delivery: 0..len,
                context: 0..0,
                transactions_part: 0..0,
                transactions: Vec::new(),
                submission_identity,
                raw_tx_bytes,
            })
        } else {
            Err(CanonicalError::Invalid)
        }
    }
    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }
    pub(crate) fn content_type(&self) -> &str {
        &self.content_type
    }
    pub(crate) fn delivery(&self) -> &[u8] {
        &self.body[self.delivery.clone()]
    }
    pub(crate) fn context(&self) -> &[u8] {
        &self.body[self.context.clone()]
    }
    pub(crate) fn raw_transactions(&self) -> Box<dyn Iterator<Item = &[u8]> + Send + '_> {
        if !self.raw_tx_bytes.is_empty() {
            Box::new(self.raw_tx_bytes.iter().map(|v| v.as_slice()))
        } else {
            Box::new(
                self.transactions
                    .iter()
                    .map(|range| &self.body[range.clone()]),
            )
        }
    }
    pub(crate) fn transactions_part(&self) -> &[u8] {
        &self.body[self.transactions_part.clone()]
    }
    pub(crate) fn submission_identity(&self) -> [u8; 32] {
        self.submission_identity
    }
    pub(crate) fn exact_equal(&self, other: &Self) -> bool {
        self.content_type == other.content_type
            && self.body == other.body
            && self.delivery() == other.delivery()
            && self.context() == other.context()
            && self.raw_transactions().eq(other.raw_transactions())
    }
    pub(crate) fn transaction_count(&self) -> usize {
        if !self.raw_tx_bytes.is_empty() {
            self.raw_tx_bytes.len()
        } else {
            self.transactions.len()
        }
    }
}

fn parse_boundary(content_type: &str, media_type: &str) -> Result<String> {
    let boundary = content_type
        .strip_prefix(media_type)
        .and_then(|tail| tail.strip_prefix("; boundary="))
        .ok_or(CanonicalError::Invalid)?;
    if boundary.is_empty()
        || boundary.len() > 70
        || !boundary
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(CanonicalError::Invalid);
    }
    Ok(boundary.into())
}
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|bytes| bytes == needle)
}
fn parse_parts(
    body: &[u8],
    boundary: &str,
    disposition: &str,
    expected: &[(&str, &str)],
) -> Result<Vec<Range<usize>>> {
    let opening = format!("--{boundary}\r\n").into_bytes();
    let separator = format!("\r\n--{boundary}").into_bytes();
    if !body.starts_with(&opening) {
        return Err(CanonicalError::Invalid);
    }
    let mut position = opening.len();
    let mut parts = Vec::with_capacity(expected.len());
    for (index, (name, media)) in expected.iter().enumerate() {
        let header_end = find(&body[position..], b"\r\n\r\n").ok_or(CanonicalError::Invalid)?;
        if header_end > 4096 {
            return Err(CanonicalError::TooLarge);
        }
        let header = std::str::from_utf8(&body[position..position + header_end])
            .map_err(|_| CanonicalError::Invalid)?;
        let mut headers = header.split("\r\n");
        let disposition_header = headers.next().ok_or(CanonicalError::Invalid)?;
        let media_header = headers.next().ok_or(CanonicalError::Invalid)?;
        if headers.next().is_some()
            || disposition_header != format!("Content-Disposition: {disposition}; name=\"{name}\"")
            || media_header != format!("Content-Type: {media}")
        {
            return Err(CanonicalError::Invalid);
        }
        position += header_end + 4;
        let length = find(&body[position..], &separator).ok_or(CanonicalError::Invalid)?;
        parts.push(position..position + length);
        position += length + separator.len();
        if index + 1 == expected.len() {
            if body.get(position..) != Some(b"--\r\n".as_slice()) {
                return Err(CanonicalError::Invalid);
            }
        } else {
            if body.get(position..position + 2) != Some(b"\r\n".as_slice()) {
                return Err(CanonicalError::Invalid);
            }
            position += 2;
        }
    }
    Ok(parts)
}
fn length(bytes: &[u8], position: &mut usize, major: u8) -> Result<usize> {
    let initial = *bytes.get(*position).ok_or(CanonicalError::Invalid)?;
    *position += 1;
    if initial >> 5 != major {
        return Err(CanonicalError::Invalid);
    }
    let additional = initial & 31;
    let (width, minimum) = match additional {
        0..=23 => return Ok(additional as usize),
        24 => (1, 24),
        25 => (2, 256),
        26 => (4, 65536),
        27 => (8, 4294967296),
        _ => return Err(CanonicalError::Invalid),
    };
    let end = position.checked_add(width).ok_or(CanonicalError::Invalid)?;
    let encoded = bytes.get(*position..end).ok_or(CanonicalError::Invalid)?;
    let value = encoded
        .iter()
        .fold(0u64, |value, b| (value << 8) | u64::from(*b));
    *position = end;
    if value < minimum {
        return Err(CanonicalError::Invalid);
    }
    value.try_into().map_err(|_| CanonicalError::TooLarge)
}
fn transaction_ranges(bytes: &[u8], offset: usize) -> Result<Vec<Range<usize>>> {
    let mut position = 0;
    let count = length(bytes, &mut position, 4)?;
    if count > 64 {
        return Err(CanonicalError::TooLarge);
    }
    let mut ranges = Vec::with_capacity(count);
    for _ in 0..count {
        let size = length(bytes, &mut position, 2)?;
        if size == 0 || size > MAX_RAW_TRANSACTION_BYTES {
            return Err(CanonicalError::TooLarge);
        }
        let end = position.checked_add(size).ok_or(CanonicalError::TooLarge)?;
        if end > bytes.len() {
            return Err(CanonicalError::Invalid);
        }
        ranges.push(offset + position..offset + end);
        position = end;
    }
    if position != bytes.len() {
        return Err(CanonicalError::Invalid);
    }
    Ok(ranges)
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
        recipient: crate::monad_http::Address,
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PrivateQuery {
    resource: Option<String>,
    since: Option<i64>,
    cursor: Option<String>,
    limit: Option<usize>,
    max_bytes: Option<usize>,
    recovery_payload_hash: Option<String>,
    recovery_obligation_id: Option<String>,
}
fn hash_hex(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CanonicalError::Invalid);
    }
    let mut hash = [0; 32];
    hex::decode_to_slice(value, &mut hash).map_err(|_| CanonicalError::Invalid)?;
    Ok(hash)
}
fn private_binding(
    runtime: &crate::monad_mailbox::EnabledMonadMailboxRuntime,
    recipient: Address,
    resource: crate::monad_mailbox::MailboxResource,
    query: &PrivateQuery,
) -> Result<crate::monad_mailbox::MailboxRequestBinding> {
    use crate::monad_mailbox::{
        MailboxCursorBinding, MailboxNamespace, MailboxRequestBinding, MailboxResource,
    };
    let since = query.since.unwrap_or(0);
    if !(0..=9_007_199_254_740_991).contains(&since)
        || (resource != MailboxResource::Inbox
            && resource != MailboxResource::Mailbox
            && since != 0)
    {
        return Err(CanonicalError::Invalid);
    }
    let ack = resource == MailboxResource::RecoveryAck;
    let limit = query.limit.unwrap_or(match resource {
        MailboxResource::Inbox | MailboxResource::Mailbox => 50,
        MailboxResource::Recovery => 20,
        MailboxResource::RecoveryAck => 1,
        MailboxResource::MailboxStream => 1,
    });
    let max_bytes =
        query
            .max_bytes
            .unwrap_or(if ack || resource == MailboxResource::MailboxStream {
                0
            } else {
                MAX_REQUEST_BYTES
            });
    if limit == 0
        || limit > 100
        || (ack && (limit != 1 || max_bytes != 0 || query.cursor.is_some()))
        || (!ack
            && resource != MailboxResource::MailboxStream
            && (max_bytes == 0
                || max_bytes > MAX_REQUEST_BYTES
                || query.recovery_payload_hash.is_some()
                || query.recovery_obligation_id.is_some()))
        || (resource == MailboxResource::MailboxStream
            && (limit != 1
                || max_bytes != 0
                || query.cursor.is_some()
                || query.recovery_payload_hash.is_some()
                || query.recovery_obligation_id.is_some()))
    {
        return Err(CanonicalError::Invalid);
    }
    let cursor = query
        .cursor
        .as_ref()
        .map(|token| {
            runtime
                .decode_namespace_cursor(MailboxNamespace::Canonical, recipient, resource, token)
                .map(|position| MailboxCursorBinding {
                    position,
                    token: token.clone(),
                })
                .ok_or(CanonicalError::Unauthorized)
        })
        .transpose()?;
    let recovery_payload_hash = query
        .recovery_payload_hash
        .as_deref()
        .map(hash_hex)
        .transpose()?;
    let recovery_obligation_id = query
        .recovery_obligation_id
        .as_deref()
        .map(hash_hex)
        .transpose()?;
    if ack && (recovery_payload_hash.is_none() || recovery_obligation_id.is_none()) {
        return Err(CanonicalError::Invalid);
    }
    Ok(MailboxRequestBinding {
        resource,
        recipient,
        since,
        cursor,
        limit,
        max_bytes,
        recovery_payload_hash,
        recovery_obligation_id,
    })
}
/// The caller's key when it is `recipient`'s and has a current entry. `Err` means the directory
/// could not answer right now, which is not a verdict on the caller.
async fn admitted_subject(
    server: &super::server::RegistryServer,
    headers: &HeaderMap,
    recipient: Address,
) -> Result<Option<Vec<u8>>> {
    let Some(runtime) = server.monad_mailbox.as_enabled() else {
        return Ok(None);
    };
    let Some(descriptor) = crate::network_tag::monad_network(runtime.network_tag()) else {
        return Ok(None);
    };
    if descriptor.evm_chain_id != runtime.expected_chain_id() {
        return Ok(None);
    }
    let Ok(point) = single_header(headers, "x-frank-mailbox-subject") else {
        return Ok(None);
    };
    if point.len() != 66
        || !(point.starts_with("02") || point.starts_with("03"))
        || !point
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(None);
    }
    let Ok(point) = hex::decode(point) else {
        return Ok(None);
    };
    admitted_point_or_busy(server, descriptor, recipient, point)
        .await
        .map_err(|_| CanonicalError::Unavailable)
}
/// `point` only when it is `recipient`'s key and that key has a published, unexpired,
/// self-consistent entry in the directory. Shared with the chain RPC proxy. "The directory owner
/// could not answer now" (queue full, not ready, or an outcome it cannot report) is an error,
/// distinct from "not admitted".
pub(crate) async fn admitted_point_or_busy(
    server: &super::server::RegistryServer,
    descriptor: &crate::network_tag::MonadNetworkDescriptor,
    recipient: Address,
    point: Vec<u8>,
) -> std::result::Result<Option<Vec<u8>>, crate::directory_runtime::RuntimeError> {
    use crate::directory_runtime::{AdmittedSnapshot, RuntimeError, SnapshotOperation};
    if crate::monad_stamp_stealth::recipient_address_from_public_key(&point).ok() != Some(recipient)
    {
        return Ok(None);
    }
    let Some(directory) = server.registry.canonical_dm().directory() else {
        return Ok(None);
    };
    let reservation = match directory.reserve(descriptor.cbor_identifier, &hex::encode(&point)) {
        Ok(reservation) => reservation,
        Err(error @ (RuntimeError::Busy | RuntimeError::NotStarted)) => return Err(error),
        Err(_) => return Ok(None),
    };
    let current = match directory
        .submit_snapshot(reservation, SnapshotOperation::Current)
        .wait()
        .await
    {
        Ok(AdmittedSnapshot::Current(current)) => current,
        Ok(_) => return Ok(None),
        Err(
            error @ (RuntimeError::Busy | RuntimeError::NotStarted | RuntimeError::OutcomeUnknown),
        ) => return Err(error),
        Err(_) => return Ok(None),
    };
    Ok(verified_point(descriptor, point, &current))
}
fn verified_point(
    descriptor: &crate::network_tag::MonadNetworkDescriptor,
    point: Vec<u8>,
    current: &crate::directory_admission::Current,
) -> Option<Vec<u8>> {
    let verified = frank_cbor::verify_preview_directory_evidence(
        &current.evidence.attestation,
        descriptor.cbor_identifier,
    )
    .ok()?;
    if verified.statement_hash != current.evidence.hash
        || verified.statement_frame().frame != current.evidence.statement
    {
        return None;
    }
    let Some(frank_cbor::TypedPayload::DirectoryStatement { subject, .. }) =
        verified.statement_frame().typed.as_deref()
    else {
        return None;
    };
    if subject.key_type != 1 || subject.key_bytes != point {
        return None;
    }
    Some(point)
}
async fn authenticate(
    server: &super::server::RegistryServer,
    headers: &HeaderMap,
    binding: &crate::monad_mailbox::MailboxRequestBinding,
) -> Result<()> {
    use crate::{monad_mailbox::MailboxNamespace, store::monad_messages::ChallengeConsumption};
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    // Wrong epoch/MAC fails in the original shared parser before key lookup or storage reads.
    let parsed = super::monad_message::parse_private_authentication_for_runtime(
        headers,
        runtime,
        binding,
        MailboxNamespace::Canonical,
    )
    .map_err(|_| CanonicalError::Unauthorized)?;
    let point = admitted_subject(server, headers, binding.recipient).await?;
    let digest = Sha256::digest(
        super::monad_message::mailbox_auth_preimage(
            parsed.challenge,
            binding,
            runtime.network_tag(),
        )
        .into(),
    );
    let valid = server
        .registry
        .verify_admitted_monad_recipient_signature(
            binding.recipient,
            point.as_deref(),
            digest.as_slice().try_into().expect("SHA256"),
            &parsed.signature,
        )
        .map_err(|_| CanonicalError::Unavailable)?;
    if !valid {
        return Err(CanonicalError::Unauthorized);
    }
    match server.registry.canonical_dm().consume_challenge(
        parsed.challenge.epoch,
        binding.recipient,
        parsed.challenge.nonce,
        parsed.challenge.expires_at_ms,
        now_ms(),
        crate::monad_mailbox::MAX_USED_CHALLENGES_PER_RECIPIENT,
    )? {
        ChallengeConsumption::Consumed => Ok(()),
        ChallengeConsumption::Rejected => Err(CanonicalError::Unauthorized),
        ChallengeConsumption::AtCapacity => Err(CanonicalError::Capacity),
    }
}
pub(crate) async fn handle_challenge(
    axum::extract::Path(recipient): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<PrivateQuery>,
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
) -> Result<Response> {
    use crate::monad_mailbox::{MailboxNamespace, MailboxResource};
    let recipient = Address::from_hex(&recipient).map_err(|_| CanonicalError::Unauthorized)?;
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    let resource = match query.resource.as_deref() {
        Some("inbox") => MailboxResource::Inbox,
        Some("recovery") | Some("recovery_ack") => return Err(CanonicalError::Retired),
        Some("mailbox") => MailboxResource::Mailbox,
        Some("mailbox_ws") | Some("mailbox_stream") | Some("mailbox-ws") => {
            MailboxResource::MailboxStream
        }
        _ => return Err(CanonicalError::Invalid),
    };
    let binding = private_binding(runtime, recipient, resource, &query)?;
    if admitted_subject(&server, &headers, recipient)
        .await?
        .is_none()
    {
        // Preserve the existing strict ECC unknown-key primitive; never reveal a profile lookup.
        let _ = server.registry.verify_admitted_monad_recipient_signature(
            recipient,
            None,
            [0; 32],
            &[],
        );
        return Err(CanonicalError::Unauthorized);
    }
    let challenge =
        runtime.issue_namespace_challenge(MailboxNamespace::Canonical, &binding, now_ms());
    Ok(Json(serde_json::json!({
        "epoch":hex::encode(challenge.epoch), "nonce":hex::encode(challenge.nonce), "expires_at_ms":challenge.expires_at_ms, "token":hex::encode(challenge.token),
        "signing_domain":super::monad_message::MAILBOX_AUTH_DOMAIN, "resource":query.resource, "since":binding.since, "cursor":query.cursor, "limit":binding.limit, "max_bytes":binding.max_bytes, "network_tag":hex::encode(runtime.network_tag()),
        "recovery_payload_hash":binding.recovery_payload_hash.map(hex::encode), "recovery_obligation_id":binding.recovery_obligation_id.map(hex::encode)
    })).into_response())
}

fn fresh_boundary(parts: &[&[u8]], prefix: &str) -> Result<String> {
    use rand::RngCore;
    for _ in 0..8 {
        let mut nonce = [0; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        let boundary = format!("{prefix}-{}", hex::encode(nonce));
        let separator = format!("\r\n--{boundary}");
        if parts
            .iter()
            .all(|part| find(part, separator.as_bytes()).is_none())
        {
            return Ok(boundary);
        }
    }
    Err(CanonicalError::Unavailable)
}
fn record_bytes(
    claim: &crate::store::monad_dm_cbor::Claim,
    outer: &str,
    recovery: bool,
    direction: Option<&str>,
) -> Result<Vec<u8>> {
    use crate::{store::monad_dm_cbor::Phase, store::monad_outbox::MonadOutboxMemberState};
    let lifecycle = match claim.phase {
        Phase::Pending => "pending".into(),
        Phase::FullyConfirmed => "fully_confirmed".into(),
        Phase::Delivered(_) => "delivered".into(),
        Phase::Terminal(reason) => format!("terminal:{}", terminal_reason(reason)),
    };
    let metadata = serde_json::to_vec(&serde_json::json!({"version":1, "submission_identity":hex::encode(claim.request.submission_identity()), "payload_hash":hex::encode(claim.policy.payload_hash), "obligation_id":hex::encode(claim.obligation_id), "confirmed_children":claim.members.iter().filter(|member| matches!(member.state, MonadOutboxMemberState::Confirmed { .. })).map(|member| member.child_index).collect::<Vec<_>>(), "lifecycle":lifecycle})).map_err(|_| CanonicalError::Unavailable)?;
    if metadata.len() > 16 * 1024 {
        return Err(CanonicalError::Unavailable);
    }
    let mut parts = vec![
        (
            "delivery",
            "application/vnd.frank.cbor",
            claim.request.delivery(),
        ),
        ("context", "application/cbor", claim.request.context()),
    ];
    if recovery {
        parts.push((
            "transactions",
            "application/cbor",
            claim.request.transactions_part(),
        ));
        parts.push(("recovery", "application/json", &metadata));
    }
    let boundary = fresh_boundary(
        &parts.iter().map(|(_, _, bytes)| *bytes).collect::<Vec<_>>(),
        "frank-record",
    )?;
    // Outer delimiter must not be representable inside any untrusted exact member bytes.
    let separator = format!("\r\n--{outer}");
    if parts
        .iter()
        .any(|(_, _, bytes)| find(bytes, separator.as_bytes()).is_some())
    {
        return Err(CanonicalError::Unavailable);
    }
    let timestamp = match claim.phase {
        Phase::Delivered(timestamp) => timestamp,
        _ => claim.updated,
    };
    if !(0..=9_007_199_254_740_991).contains(&timestamp) {
        return Err(CanonicalError::Unavailable);
    }
    let direction_header = match direction {
        Some(dir) => format!("X-Frank-Mailbox-Direction: {dir}\r\n"),
        None => String::new(),
    };
    let headers = format!("--{outer}\r\nContent-Disposition: inline; name=\"record\"\r\nContent-Type: multipart/mixed; boundary={boundary}\r\nX-Frank-Submission-Identity: {}\r\nX-Frank-Mailbox-Timestamp-Ms: {timestamp}\r\n{direction_header}\r\n", hex::encode(claim.request.submission_identity()));
    let mut length = headers.len();
    let mut inner_headers = Vec::new();
    for (name, media, bytes) in &parts {
        let header = format!("--{boundary}\r\nContent-Disposition: inline; name=\"{name}\"\r\nContent-Type: {media}\r\n\r\n");
        length = length
            .checked_add(header.len())
            .and_then(|n| n.checked_add(bytes.len()))
            .and_then(|n| n.checked_add(2))
            .ok_or(CanonicalError::TooLarge)?;
        inner_headers.push(header);
    }
    let closing = format!("--{boundary}--\r\n\r\n");
    length = length
        .checked_add(closing.len())
        .ok_or(CanonicalError::TooLarge)?;
    if length > MAX_REQUEST_BYTES {
        return Err(CanonicalError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(length);
    bytes.extend_from_slice(headers.as_bytes());
    for ((_, _, part), header) in parts.iter().zip(inner_headers) {
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(part);
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(closing.as_bytes());
    Ok(bytes)
}
async fn page(
    server: &super::server::RegistryServer,
    headers: &HeaderMap,
    recipient: Address,
    query: &PrivateQuery,
    resource: crate::monad_mailbox::MailboxResource,
) -> Result<Response> {
    use crate::monad_mailbox::{MailboxCursor, MailboxNamespace, MailboxResource};
    if query.resource.is_some() {
        return Err(CanonicalError::Invalid);
    }
    let runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    let _cpu = runtime
        .try_acquire_private_read()
        .ok_or(CanonicalError::Unavailable)?;
    let binding = private_binding(runtime, recipient, resource, query)?;
    authenticate(server, headers, &binding).await?;
    let owner = server.registry.canonical_dm();
    let recovery = resource == MailboxResource::Recovery;
    let fetch = |after: Option<MailboxCursor>| -> Result<
        Option<(
            crate::store::monad_dm_cbor::Claim,
            Option<crate::store::monad_dm_cbor::MailboxDirection>,
        )>,
    > {
        match resource {
            MailboxResource::Recovery => {
                let records = owner.recovery(
                    recipient,
                    after.map(|cursor| match cursor {
                        MailboxCursor::Recovery { payload_hash } => payload_hash,
                        _ => unreachable!("validated cursor resource"),
                    }),
                    1,
                )?;
                Ok(records.into_iter().next().map(|claim| (claim, None)))
            }
            MailboxResource::Inbox => {
                let records = owner.inbox(
                    recipient,
                    binding.since,
                    after.map(|cursor| match cursor {
                        MailboxCursor::Inbox {
                            timestamp,
                            payload_hash,
                        } => (timestamp, payload_hash),
                        _ => unreachable!("validated cursor resource"),
                    }),
                    1,
                )?;
                Ok(records.into_iter().next().map(|claim| (claim, None)))
            }
            MailboxResource::Mailbox => {
                let records = owner.mailbox(
                    recipient,
                    binding.since,
                    after.map(|cursor| match cursor {
                        MailboxCursor::Mailbox {
                            timestamp,
                            payload_hash,
                        } => (timestamp, payload_hash),
                        _ => unreachable!("validated cursor resource"),
                    }),
                    1,
                )?;
                Ok(records
                    .into_iter()
                    .next()
                    .map(|(claim, dir)| (claim, Some(dir))))
            }
            MailboxResource::RecoveryAck | MailboxResource::MailboxStream => unreachable!(),
        }
    };
    let position = |claim: &crate::store::monad_dm_cbor::Claim| -> Result<MailboxCursor> {
        match resource {
            MailboxResource::Recovery => Ok(MailboxCursor::Recovery {
                payload_hash: claim.policy.payload_hash,
            }),
            MailboxResource::Inbox => {
                if let crate::store::monad_dm_cbor::Phase::Delivered(timestamp) = claim.phase {
                    Ok(MailboxCursor::Inbox {
                        timestamp,
                        payload_hash: claim.policy.payload_hash,
                    })
                } else {
                    Err(CanonicalError::Unavailable)
                }
            }
            MailboxResource::Mailbox => {
                if let crate::store::monad_dm_cbor::Phase::Delivered(timestamp) = claim.phase {
                    Ok(MailboxCursor::Mailbox {
                        timestamp,
                        payload_hash: claim.policy.payload_hash,
                    })
                } else {
                    Err(CanonicalError::Unavailable)
                }
            }
            MailboxResource::RecoveryAck | MailboxResource::MailboxStream => unreachable!(),
        }
    };
    let boundary = fresh_boundary(&[], "frank-page")?;
    let closing = format!("--{boundary}--\r\n").into_bytes();
    if closing.len() > binding.max_bytes {
        return Err(CanonicalError::TooLarge);
    }
    let mut bytes = Vec::new();
    let mut next_cursor = None;
    let mut candidate = fetch(binding.cursor.as_ref().map(|cursor| cursor.position))?;
    let mut count = 0;
    while let Some((claim, dir)) = candidate {
        let at = position(&claim)?;
        // One-record lookahead: a page never allocates limit full request bodies in advance.
        let following = fetch(Some(at))?;
        let cursor = following
            .as_ref()
            .map(|_| runtime.encode_namespace_cursor(MailboxNamespace::Canonical, recipient, at));
        let charge = cursor.as_ref().map_or(0, |token| 31 + token.len());
        let record = record_bytes(&claim, &boundary, recovery, dir.map(|d| d.as_str()))?;
        if bytes
            .len()
            .checked_add(record.len())
            .and_then(|n| n.checked_add(closing.len()))
            .and_then(|n| n.checked_add(charge))
            .ok_or(CanonicalError::TooLarge)?
            > binding.max_bytes
        {
            if count == 0 {
                return Err(CanonicalError::TooLarge);
            }
            break;
        }
        bytes.extend_from_slice(&record);
        next_cursor = cursor;
        count += 1;
        if count == binding.limit {
            break;
        }
        candidate = following;
    }
    bytes.extend_from_slice(&closing);
    let mut response = (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            format!("multipart/mixed; boundary={boundary}"),
        )],
        bytes,
    )
        .into_response();
    if let Some(cursor) = next_cursor {
        response.headers_mut().insert(
            "x-frank-mailbox-next-cursor",
            cursor.parse().map_err(|_| CanonicalError::Unavailable)?,
        );
    }
    Ok(response)
}
pub(crate) async fn handle_inbox(
    axum::extract::Path(recipient): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<PrivateQuery>,
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
) -> Result<Response> {
    page(
        &server,
        &headers,
        Address::from_hex(&recipient).map_err(|_| CanonicalError::Unauthorized)?,
        &query,
        crate::monad_mailbox::MailboxResource::Inbox,
    )
    .await
}
pub(crate) async fn handle_recovery(
    axum::extract::Path(_recipient): axum::extract::Path<String>,
) -> Result<Response> {
    Err(CanonicalError::Retired)
}
pub(crate) async fn handle_mailbox(
    axum::extract::Path(address): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<PrivateQuery>,
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
) -> Result<Response> {
    page(
        &server,
        &headers,
        Address::from_hex(&address).map_err(|_| CanonicalError::Unauthorized)?,
        &query,
        crate::monad_mailbox::MailboxResource::Mailbox,
    )
    .await
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct PrivateWsQuery {
    #[serde(default)]
    pub(crate) epoch: Option<String>,
    #[serde(default)]
    pub(crate) nonce: Option<String>,
    #[serde(default)]
    pub(crate) token: Option<String>,
    #[serde(default)]
    pub(crate) expires_at_ms: Option<String>,
    #[serde(default)]
    pub(crate) signature: Option<String>,
    #[serde(default)]
    pub(crate) subject: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct MailboxWsPush {
    pub(crate) direction: &'static str,
    pub(crate) submission_identity: String,
    pub(crate) payload_hash: String,
    pub(crate) timestamp_ms: i64,
    pub(crate) delivery: String,
    pub(crate) context: String,
}

pub(crate) async fn handle_mailbox_ws(
    axum::extract::Path(address): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<PrivateWsQuery>,
    mut headers: HeaderMap,
    Extension(server): Extension<super::server::RegistryServer>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response> {
    use crate::monad_mailbox::{MailboxRequestBinding, MailboxResource};

    let address = Address::from_hex(&address).map_err(|_| CanonicalError::Unauthorized)?;
    let _runtime = server
        .monad_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;

    let binding = MailboxRequestBinding {
        resource: MailboxResource::MailboxStream,
        recipient: address,
        since: 0,
        cursor: None,
        limit: 1,
        max_bytes: 0,
        recovery_payload_hash: None,
        recovery_obligation_id: None,
    };

    if let Some(epoch) = query.epoch {
        headers.insert(
            "x-frank-mailbox-epoch",
            epoch.parse().map_err(|_| CanonicalError::Unauthorized)?,
        );
    }
    if let Some(nonce) = query.nonce {
        headers.insert(
            "x-frank-mailbox-nonce",
            nonce.parse().map_err(|_| CanonicalError::Unauthorized)?,
        );
    }
    if let Some(token) = query.token {
        headers.insert(
            "x-frank-mailbox-token",
            token.parse().map_err(|_| CanonicalError::Unauthorized)?,
        );
    }
    if let Some(expires_at_ms) = query.expires_at_ms {
        headers.insert(
            "x-frank-mailbox-expires-at-ms",
            expires_at_ms
                .parse()
                .map_err(|_| CanonicalError::Unauthorized)?,
        );
    }
    if let Some(signature) = query.signature {
        headers.insert(
            "x-frank-mailbox-signature",
            signature
                .parse()
                .map_err(|_| CanonicalError::Unauthorized)?,
        );
    }
    if let Some(subject) = query.subject {
        headers.insert(
            "x-frank-mailbox-subject",
            subject.parse().map_err(|_| CanonicalError::Unauthorized)?,
        );
    }

    authenticate(&server, &headers, &binding).await?;

    let mut rx = server.registry.canonical_dm().subscribe_finalized();
    let mut event_rx = server
        .event_bus
        .subscribe(&address.to_hex())
        .await
        .map_err(|_| CanonicalError::Unavailable)?;

    Ok(ws.on_upgrade(move |mut socket| async move {
        let mut seen_payloads = std::collections::HashSet::new();
        loop {
            tokio::select! {
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(axum::extract::ws::Message::Close(_))) | None => break,
                        Some(Ok(axum::extract::ws::Message::Ping(data))) => {
                            if socket.send(axum::extract::ws::Message::Pong(data)).await.is_err() {
                                break;
                            }
                        }
                        Some(Err(_)) => break,
                        _ => {}
                    }
                }
                notif = event_rx.recv() => {
                    match notif {
                        Some(notification) => {
                            if seen_payloads.contains(&notification.payload_hash) {
                                continue;
                            }
                            seen_payloads.insert(notification.payload_hash);
                            let (sub_id, ts, delivery, context) = if let Ok(Some(claim)) = server.registry.canonical_dm().get(&notification.payload_hash) {
                                (
                                    hex::encode(claim.request.submission_identity()),
                                    claim.updated,
                                    hex::encode(claim.request.delivery()),
                                    hex::encode(claim.request.context()),
                                )
                            } else {
                                (
                                    String::new(),
                                    now_ms(),
                                    String::new(),
                                    String::new(),
                                )
                            };
                            let push = MailboxWsPush {
                                direction: "in",
                                submission_identity: sub_id,
                                payload_hash: hex::encode(notification.payload_hash),
                                timestamp_ms: ts,
                                delivery,
                                context,
                            };
                            let json = match serde_json::to_string(&push) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                res = rx.recv() => {
                    match res {
                        Ok(envelope) => {
                            if envelope.recipient == address {
                                if seen_payloads.contains(&envelope.payload_hash) {
                                    continue;
                                }
                                seen_payloads.insert(envelope.payload_hash);
                                let push = MailboxWsPush {
                                    direction: "in",
                                    submission_identity: hex::encode(envelope.submission_identity),
                                    payload_hash: hex::encode(envelope.payload_hash),
                                    timestamp_ms: envelope.timestamp,
                                    delivery: hex::encode(&envelope.delivery),
                                    context: hex::encode(&envelope.context),
                                };
                                let json = match serde_json::to_string(&push) {
                                    Ok(j) => j,
                                    Err(_) => continue,
                                };
                                if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
                                    break;
                                }
                            } else if envelope.sender == address {
                                let push = MailboxWsPush {
                                    direction: "out",
                                    submission_identity: hex::encode(envelope.submission_identity),
                                    payload_hash: hex::encode(envelope.payload_hash),
                                    timestamp_ms: envelope.timestamp,
                                    delivery: hex::encode(&envelope.delivery),
                                    context: hex::encode(&envelope.context),
                                };
                                let json = match serde_json::to_string(&push) {
                                    Ok(j) => j,
                                    Err(_) => continue,
                                };
                                if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
            }
        }
    }))
}
pub(crate) async fn handle_ack(
    axum::extract::Path((_recipient, _hash, _obligation)): axum::extract::Path<(
        String,
        String,
        String,
    )>,
) -> Result<Response> {
    Err(CanonicalError::Retired)
}

#[cfg(test)]
#[path = "monad_message_cbor_tests.rs"]
pub(crate) mod tests;
