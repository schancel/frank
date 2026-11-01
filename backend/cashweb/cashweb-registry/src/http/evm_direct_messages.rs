//! Exact canonical DM transport. No legacy protobuf projection or implicit admission.
use std::sync::Arc;

use crate::{
    canonical_dm_request::{find, parse_boundary, ExactRequest, RequestError, MAX_REQUEST_BYTES},
    evm_dm_payment::SubmissionEcho,
    evm_dm_payment::{broadcast_payments, precheck_payments, REBROADCAST_INTERVAL},
    evm_mailbox::{CanonicalError, Result},
    evm_rpc::Address,
};
use axum::{
    extract::RawBody,
    http::HeaderMap,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use frank_cbor::{encode_canonical, CborValue};

pub(crate) async fn handle_put(
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
    RawBody(mut body): RawBody,
) -> Result<Response> {
    use hyper::body::HttpBody;
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unavailable)?;
    let network = runtime.network();
    let evm_chain_id = runtime.expected_chain_id();
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
    let repeat = request.clone();
    let (claim, new) =
        if let Some(stored) = on_store(&server, move |owner| owner.find_request(&repeat)).await? {
            if stored.policy.network != network || stored.policy.chain_id != evm_chain_id {
                return Err(CanonicalError::Unavailable);
            }
            (stored, false)
        } else {
            if request.transaction_count() > crate::evm_dm_payment::MAX_STAMP_PAYMENTS {
                return Err(CanonicalError::Invalid);
            }
            let principals = request_principals(&request, network)?;
            // The recipient's own entry says which relay holds its mailbox. When this relay cannot
            // deliver there, say so as a final answer: nothing is stored, no payment is broadcast.
            let Some(recipient_current) =
                deliverable_recipient(owner, network, &principals.recipient).await?
            else {
                return dead_response(&request, network, &principals, "undeliverable");
            };
            // The sender is whoever the message says. The relay does not look the sender up:
            // checking who wrote a message is the job of the recipient's client, which opens it
            // with the key the sender published.
            let historical = match principals.recipient_t1 {
                Some(t1) if recipient_current.evidence.hash != t1 => {
                    Some(history(owner, network, &principals.recipient, t1).await?)
                }
                _ => None,
            };
            // Everything that can refuse the message is decided from its bytes, here and in the
            // store's own checks, before anything is stored or broadcast.
            let input = crate::evm_dm_payment::validate_canonical_payment_set(
                request,
                &recipient_current,
                historical.as_ref(),
                network,
                evm_chain_id,
                runtime.min_value_wei(),
                runtime.payment_floor_wei(),
            )?;
            // A payment the node can never take is refused here, before anything is stored or
            // delivered, so the sender learns it while nothing has happened yet.
            if let Some(dead) = precheck_payments(runtime, input.payments()).await {
                return dead_response(&input.request, network, &principals, dead.reason());
            }
            let admitted = on_store(&server, move |owner| owner.claim(input, now_ms())).await?;
            (admitted.claim, admitted.new)
        };
    // The message is in the recipient's inbox from here on, committed in the store every
    // replica reads. Nothing below can undo that.
    if new {
        announce(&server, &claim).await;
    }
    if let Ok(recipient) = claim.policy.recipient() {
        let policy = on_store(&server, move |owner| {
            owner.get_notification_policy(recipient)
        })
        .await
        .unwrap_or_default();
        let stamp_value_wei = crate::evm_dm_payment::submitted_stamp_value_wei(&claim);
        let stamp_value_avu_micros = headers
            .get("x-cashweb-stamp-avu-micros")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| (stamp_value_wei / 1_000_000_000_000).min(u64::MAX as u128) as u64);
        let wakeup_token_preimage = headers
            .get("x-wakeup-token")
            .or_else(|| headers.get("x-cashweb-wakeup-token"))
            .and_then(|v| v.to_str().ok())
            .map(str::as_bytes);
        if crate::store::notification_policy::should_trigger_wakeup(
            &policy,
            stamp_value_wei,
            stamp_value_avu_micros,
            wakeup_token_preimage,
        ) {
            if let Some(wakeup_event) = owner.record_wakeup(recipient, &policy, claim.delivered_at)
            {
                for subscription in wakeup_event.subscriptions {
                    let vapid = runtime.vapid().clone();
                    tokio::spawn(async move {
                        let _ = crate::store::notification_policy::dispatch_blind_webpush_wakeup(
                            &subscription,
                            &vapid,
                        )
                        .await;
                    });
                }
            }
        }
    }
    // Payments are handed to the node only once the message is known to be stored.
    if owner.may_broadcast_payments(&claim.policy.payload_hash, REBROADCAST_INTERVAL) {
        broadcast_payments(runtime, &claim).await;
    }
    accepted_response(&claim)
}

/// Longest the relay waits on the event bus to announce a delivered message.
const EVENT_BUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// Run a call of the message store on a blocking worker. The store's calls block (on
/// FoundationDB's network thread or on RocksDB), and must not hold up the async runtime.
pub(crate) async fn on_store<T, F>(server: &super::server::RegistryServer, call: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&crate::store::evm_direct_messages::Owner) -> Result<T> + Send + 'static,
{
    let registry = Arc::clone(&server.registry);
    tokio::task::spawn_blocking(move || call(registry.canonical_dm()))
        .await
        .map_err(|_| CanonicalError::Unavailable)?
}

/// Tell every replica's open mailbox sockets that the recipient's and the sender's mailboxes
/// have a new row. The hint names only the mailbox and the payload hash; a reader takes the
/// row from the store, and one that misses the hint (the bus is down, or it was not connected)
/// finds the row from its cursor. A slow event bus must not hold up the payments or the answer.
async fn announce(
    server: &super::server::RegistryServer,
    claim: &crate::store::evm_direct_messages::Claim,
) {
    // A sealed-sender message names no sender, so only the recipient's mailbox has it.
    let Ok(mailboxes) = claim.policy.parties() else {
        return;
    };
    let hash = claim.policy.payload_hash;
    for mailbox in mailboxes {
        let published = tokio::time::timeout(
            EVENT_BUS_TIMEOUT,
            server
                .event_bus
                .publish_message_arrival(&mailbox.to_hex(), &hash),
        )
        .await;
        if !matches!(published, Ok(Ok(()))) {
            tracing::event!(
                tracing::Level::DEBUG,
                payload_hash = %hex::encode(hash),
                "Message stored but not announced on the event bus; readers catch up from their cursor"
            );
        }
    }
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
    owner: &crate::store::evm_direct_messages::Owner,
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
    owner: &crate::store::evm_direct_messages::Owner,
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
    pub(crate) recipient: Vec<u8>,
    pub(crate) sender_t1: Option<[u8; 32]>,
    pub(crate) recipient_t1: Option<[u8; 32]>,
    pub(crate) payload_hash: [u8; 32],
}
/// The recipient's current entry when its mailbox is on this relay. `None` when this relay can
/// never deliver the message: the recipient has no current entry here, or its entry names
/// another relay. A directory that is merely busy is an error the sender may retry.
async fn deliverable_recipient(
    owner: &crate::store::evm_direct_messages::Owner,
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
/// A final answer for a submission this relay will never deliver: the recipient's mailbox is
/// elsewhere, or a payment can never land. Nothing was retained and no payment was broadcast.
fn dead_response(
    request: &ExactRequest,
    network: &str,
    principals: &Principals,
    reason: &str,
) -> Result<Response> {
    let recipient =
        crate::evm_stamp_stealth::recipient_address_from_public_key(&principals.recipient)
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
    if actual != network
        || sender
            .as_ref()
            .is_some_and(|s| s.key_type != frank_cbor::message_fields::key_type::SECP256K1)
        || recipient.key_type != frank_cbor::message_fields::key_type::SECP256K1
    {
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
        use frank_cbor::message_fields::dm_crypto_context_v1 as C;
        // A sealed-sender context has no sender statement hash; the relay records zeroes.
        let sender_t1 = if sender.is_some() {
            Some(hash(C::SENDER_STATEMENT_HASH)?)
        } else {
            if context
                .iter()
                .any(|(key, _)| *key == C::SENDER_STATEMENT_HASH)
            {
                return Err(CanonicalError::Invalid);
            }
            None
        };
        (sender_t1, Some(hash(C::RECIPIENT_STATEMENT_HASH)?))
    } else {
        (None, None)
    };
    Ok(Principals {
        recipient: recipient.key_bytes.clone(),
        sender_t1,
        recipient_t1,
        payload_hash: frank_cbor::recipient_payload_digest(network, &payload_frame.frame)
            .map_err(|_| CanonicalError::Invalid)?,
    })
}
fn accepted_response(claim: &crate::store::evm_direct_messages::Claim) -> Result<Response> {
    let identity = claim.echo()?;
    let timestamp = claim.delivered_at;
    // The client reads this as a JSON number, which is exact only up to 2^53 - 1.
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

impl From<RequestError> for CanonicalError {
    fn from(error: RequestError) -> Self {
        match error {
            RequestError::Invalid => Self::Invalid,
            RequestError::TooLarge => Self::TooLarge,
        }
    }
}
impl IntoResponse for CanonicalError {
    fn into_response(self) -> Response {
        if matches!(self, Self::Capacity) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [(
                    axum::http::header::RETRY_AFTER,
                    (crate::evm_mailbox::CHALLENGE_TTL_MS / 1000).to_string(),
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
        };
        (status, Json(serde_json::json!({"version":1,"error":error}))).into_response()
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
}
#[cfg(test)]
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
    runtime: &crate::evm_mailbox::EnabledEvmMailboxRuntime,
    recipient: Address,
    resource: crate::evm_mailbox::MailboxResource,
    query: &PrivateQuery,
) -> Result<crate::evm_mailbox::MailboxRequestBinding> {
    use crate::evm_mailbox::{MailboxCursorBinding, MailboxRequestBinding, MailboxResource};
    let stream = resource == MailboxResource::MailboxStream;
    let since = query.since.unwrap_or(0);
    if !(0..=9_007_199_254_740_991).contains(&since) || (stream && since != 0) {
        return Err(CanonicalError::Invalid);
    }
    let limit = query.limit.unwrap_or(if stream { 1 } else { 50 });
    let max_bytes = query
        .max_bytes
        .unwrap_or(if stream { 0 } else { MAX_REQUEST_BYTES });
    if limit == 0
        || limit > 100
        || (!stream && (max_bytes == 0 || max_bytes > MAX_REQUEST_BYTES))
        || (stream && (limit != 1 || max_bytes != 0 || query.cursor.is_some()))
    {
        return Err(CanonicalError::Invalid);
    }
    let cursor = query
        .cursor
        .as_ref()
        .map(|token| {
            runtime
                .decode_cursor(recipient, resource, token)
                .map(|position| MailboxCursorBinding {
                    position,
                    token: token.clone(),
                })
                .ok_or(CanonicalError::Unauthorized)
        })
        .transpose()?;
    Ok(MailboxRequestBinding {
        resource,
        recipient,
        since,
        cursor,
        limit,
        max_bytes,
    })
}
/// The caller's key when it is `recipient`'s and has a current entry. `Err` means the directory
/// could not answer right now, which is not a verdict on the caller.
async fn admitted_subject(
    server: &super::server::RegistryServer,
    headers: &HeaderMap,
    recipient: Address,
) -> Result<Option<Vec<u8>>> {
    let Some(runtime) = server.evm_mailbox.as_enabled() else {
        return Ok(None);
    };
    let network = runtime.network();
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
    admitted_point_or_busy(server, network, recipient, point)
        .await
        .map_err(|_| CanonicalError::Unavailable)
}
/// `point` only when it is `recipient`'s key and that key has a published, unexpired,
/// self-consistent entry in the directory. Shared with the chain RPC proxy. "The directory owner
/// could not answer now" (queue full, not ready, or an outcome it cannot report) is an error,
/// distinct from "not admitted".
pub(crate) async fn admitted_point_or_busy(
    server: &super::server::RegistryServer,
    network: &str,
    recipient: Address,
    point: Vec<u8>,
) -> std::result::Result<Option<Vec<u8>>, crate::directory_runtime::RuntimeError> {
    use crate::directory_runtime::{AdmittedSnapshot, RuntimeError, SnapshotOperation};
    if crate::evm_stamp_stealth::recipient_address_from_public_key(&point).ok() != Some(recipient) {
        return Ok(None);
    }
    let Some(directory) = server.registry.canonical_dm().directory() else {
        return Ok(None);
    };
    let reservation = match directory.reserve(network, &hex::encode(&point)) {
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
    Ok(verified_point(network, point, &current))
}
fn verified_point(
    network: &str,
    point: Vec<u8>,
    current: &crate::directory_admission::Current,
) -> Option<Vec<u8>> {
    let verified =
        frank_cbor::verify_preview_directory_evidence(&current.evidence.attestation, network)
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
    binding: &crate::evm_mailbox::MailboxRequestBinding,
) -> Result<()> {
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    // A challenge this relay did not issue for this request fails here, before any key
    // lookup or storage read.
    let (challenge, signature) =
        crate::evm_mailbox::parse_mailbox_authentication(headers, runtime, binding, now_ms())
            .ok_or(CanonicalError::Unauthorized)?;
    let point = admitted_subject(server, headers, binding.recipient).await?;
    // The signature names the relay it was made for: this relay's configured public origin.
    let directory = server
        .registry
        .canonical_dm()
        .directory()
        .ok_or(CanonicalError::Unavailable)?;
    let digest = Sha256::digest(
        crate::evm_mailbox::mailbox_auth_preimage(
            challenge,
            binding,
            runtime.network_tag(),
            &directory.info().binding.endpoint,
        )
        .into(),
    );
    let valid = server
        .registry
        .verify_admitted_evm_recipient_signature(
            binding.recipient,
            point.as_deref(),
            digest.as_slice().try_into().expect("SHA256"),
            &signature,
        )
        .map_err(|_| CanonicalError::Unavailable)?;
    if !valid {
        return Err(CanonicalError::Unauthorized);
    }
    consume(server, binding.recipient, challenge).await
}
/// Use up a challenge whose signature checked out, in the store every replica shares: a
/// challenge issued by one replica is used once, on whichever replica it is presented.
async fn consume(
    server: &super::server::RegistryServer,
    recipient: Address,
    challenge: crate::evm_mailbox::MailboxChallenge,
) -> Result<()> {
    use crate::evm_mailbox::ChallengeConsumption;
    let consumed = on_store(server, move |owner| {
        owner.consume_challenge(
            challenge.epoch,
            recipient,
            challenge.nonce,
            challenge.expires_at_ms,
            now_ms(),
            crate::evm_mailbox::MAX_USED_CHALLENGES_PER_RECIPIENT,
        )
    })
    .await?;
    match consumed {
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
    use crate::evm_mailbox::MailboxResource;
    let recipient = Address::from_hex(&recipient).map_err(|_| CanonicalError::Unauthorized)?;
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    let resource = match query.resource.as_deref() {
        Some("inbox") => MailboxResource::Inbox,
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
        let _ =
            server
                .registry
                .verify_admitted_evm_recipient_signature(recipient, None, [0; 32], &[]);
        return Err(CanonicalError::Unauthorized);
    }
    let challenge = runtime.issue_challenge(&binding, now_ms());
    Ok(Json(serde_json::json!({
        "epoch":hex::encode(challenge.epoch), "nonce":hex::encode(challenge.nonce), "expires_at_ms":challenge.expires_at_ms, "token":hex::encode(challenge.token),
        "signing_domain":crate::evm_mailbox::MAILBOX_AUTH_DOMAIN, "resource":query.resource, "since":binding.since, "cursor":query.cursor, "limit":binding.limit, "max_bytes":binding.max_bytes, "network_tag":hex::encode(runtime.network_tag()),
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
/// One stored message as a part of a mailbox page: the delivery frame and its context.
fn record_bytes(
    claim: &crate::store::evm_direct_messages::Claim,
    outer: &str,
    direction: Option<&str>,
) -> Result<Vec<u8>> {
    let parts = [
        (
            "delivery",
            "application/vnd.frank.cbor",
            claim.request.delivery(),
        ),
        ("context", "application/cbor", claim.request.context()),
    ];
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
    let timestamp = claim.delivered_at;
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
    resource: crate::evm_mailbox::MailboxResource,
) -> Result<Response> {
    use crate::evm_mailbox::{MailboxCursor, MailboxResource};
    if query.resource.is_some() {
        return Err(CanonicalError::Invalid);
    }
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;
    let _cpu = runtime
        .try_acquire_private_read()
        .ok_or(CanonicalError::Unavailable)?;
    let binding = private_binding(runtime, recipient, resource, query)?;
    authenticate(server, headers, &binding).await?;
    type Record = (
        crate::store::evm_direct_messages::Claim,
        Option<crate::store::evm_direct_messages::MailboxDirection>,
    );
    let since = binding.since;
    // The next record strictly after a position. The store starts its scan there.
    let fetch = |after: Option<MailboxCursor>| {
        let after = after.map(|cursor| match cursor {
            MailboxCursor::Inbox {
                timestamp,
                payload_hash,
            }
            | MailboxCursor::Mailbox {
                timestamp,
                payload_hash,
            } => (timestamp, payload_hash),
        });
        on_store(server, move |owner| -> Result<Option<Record>> {
            Ok(match resource {
                MailboxResource::Inbox => owner
                    .inbox(recipient, since, after, 1)?
                    .into_iter()
                    .next()
                    .map(|claim| (claim, None)),
                MailboxResource::Mailbox => owner
                    .mailbox(recipient, since, after, 1)?
                    .into_iter()
                    .next()
                    .map(|(claim, direction)| (claim, Some(direction))),
                MailboxResource::MailboxStream
                | MailboxResource::NotificationPolicyRead
                | MailboxResource::NotificationPolicyWrite => {
                    unreachable!("only the inbox and the mailbox are paged")
                }
            })
        })
    };
    let position = |claim: &crate::store::evm_direct_messages::Claim| match resource {
        MailboxResource::Inbox => MailboxCursor::Inbox {
            timestamp: claim.delivered_at,
            payload_hash: claim.policy.payload_hash,
        },
        _ => MailboxCursor::Mailbox {
            timestamp: claim.delivered_at,
            payload_hash: claim.policy.payload_hash,
        },
    };
    let boundary = fresh_boundary(&[], "frank-page")?;
    let closing = format!("--{boundary}--\r\n").into_bytes();
    if closing.len() > binding.max_bytes {
        return Err(CanonicalError::TooLarge);
    }
    let mut bytes = Vec::new();
    let mut next_cursor = None;
    let mut candidate = fetch(binding.cursor.as_ref().map(|cursor| cursor.position)).await?;
    let mut count = 0;
    while let Some((claim, dir)) = candidate {
        let at = position(&claim);
        // One-record lookahead: a page never allocates limit full request bodies in advance.
        let following = fetch(Some(at)).await?;
        let cursor = following
            .as_ref()
            .map(|_| runtime.encode_cursor(recipient, at));
        let charge = cursor.as_ref().map_or(0, |token| 31 + token.len());
        let record = record_bytes(&claim, &boundary, dir.map(|d| d.as_str()))?;
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
        crate::evm_mailbox::MailboxResource::Inbox,
    )
    .await
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
        crate::evm_mailbox::MailboxResource::Mailbox,
    )
    .await
}

const MAX_NOTIFICATION_POLICY_BYTES: usize = 64 * 1024;

/// Domain of the bytes a mailbox owner signs to read or replace their notification policy.
pub(crate) const NOTIFICATION_POLICY_AUTH_DOMAIN: &str = "frank:notification-policy-auth:v2";
/// Compressed secp256k1 public key (hex) of the mailbox owner signing a policy request.
const NOTIFICATION_POLICY_SUBJECT_HEADER: &str = "x-frank-mailbox-subject";

fn notification_policy_binding(
    address: Address,
    resource: crate::evm_mailbox::MailboxResource,
) -> crate::evm_mailbox::MailboxRequestBinding {
    crate::evm_mailbox::MailboxRequestBinding {
        resource,
        recipient: address,
        since: 0,
        cursor: None,
        limit: 0,
        max_bytes: 0,
    }
}

/// The one signing string a notification-policy request is accepted under: the relay-issued
/// single-use challenge (its epoch and MAC name this relay), the method, the mailbox address,
/// the relay's network tag and SHA-256 of the exact request body (empty for GET).
pub(crate) fn notification_policy_auth_preimage(
    challenge: crate::evm_mailbox::MailboxChallenge,
    method: &str,
    address: Address,
    network_tag: &[u8],
    body: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(256 + network_tag.len());
    bytes.extend_from_slice(NOTIFICATION_POLICY_AUTH_DOMAIN.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&challenge.epoch);
    bytes.extend_from_slice(&challenge.nonce);
    bytes.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    bytes.extend_from_slice(&challenge.token);
    bytes.extend_from_slice(method.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&address.0);
    bytes.extend_from_slice(&(network_tag.len() as u32).to_be_bytes());
    bytes.extend_from_slice(network_tag);
    bytes.extend_from_slice(Sha256::digest(body.to_vec().into()).as_slice());
    bytes
}

/// `401` carrying a fresh challenge for exactly this request; the client signs it and retries.
fn notification_policy_challenge(
    runtime: &crate::evm_mailbox::EnabledEvmMailboxRuntime,
    binding: &crate::evm_mailbox::MailboxRequestBinding,
) -> Response {
    let challenge = runtime.issue_challenge(binding, now_ms());
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "version": 1,
            "error": "mailbox_auth_required",
            "challenge": {
                "epoch": hex::encode(challenge.epoch),
                "nonce": hex::encode(challenge.nonce),
                "expires_at_ms": challenge.expires_at_ms,
                "token": hex::encode(challenge.token),
                "signing_domain": NOTIFICATION_POLICY_AUTH_DOMAIN,
                "network_tag": hex::encode(runtime.network_tag()),
            },
        })),
    )
        .into_response()
}

/// Verify the owner's signature over [`notification_policy_auth_preimage`] and consume the
/// challenge, so the request cannot be replayed. The challenge itself was already checked to be
/// one this relay issued for this method and address and still live.
async fn authenticate_notification_policy(
    server: &super::server::RegistryServer,
    runtime: &crate::evm_mailbox::EnabledEvmMailboxRuntime,
    headers: &HeaderMap,
    binding: &crate::evm_mailbox::MailboxRequestBinding,
    (challenge, signature): (crate::evm_mailbox::MailboxChallenge, Vec<u8>),
    method: &str,
    body: &[u8],
) -> Result<()> {
    let subject = single_header(headers, NOTIFICATION_POLICY_SUBJECT_HEADER)
        .map_err(|_| CanonicalError::Unauthorized)?;
    let mut pubkey = [0u8; 33];
    hex::decode_to_slice(subject, &mut pubkey).map_err(|_| CanonicalError::Unauthorized)?;
    let derived = crate::evm_stamp_stealth::recipient_address_from_public_key(&pubkey)
        .map_err(|_| CanonicalError::Unauthorized)?;
    if derived != binding.recipient {
        return Err(CanonicalError::Unauthorized);
    }
    let pk =
        secp256k1_abc::PublicKey::from_slice(&pubkey).map_err(|_| CanonicalError::Unauthorized)?;
    let mut sig = if signature.len() == 64 {
        secp256k1_abc::Signature::from_compact(&signature)
    } else {
        secp256k1_abc::Signature::from_der(&signature)
    }
    .map_err(|_| CanonicalError::Unauthorized)?;
    sig.normalize_s();
    let digest = Sha256::digest(
        notification_policy_auth_preimage(
            challenge,
            method,
            binding.recipient,
            runtime.network_tag(),
            body,
        )
        .into(),
    );
    let msg = secp256k1_abc::Message::from_slice(digest.as_slice())
        .map_err(|_| CanonicalError::Unauthorized)?;
    if secp256k1_abc::Secp256k1::verification_only()
        .verify(&msg, &sig, &pk)
        .is_err()
    {
        return Err(CanonicalError::Unauthorized);
    }
    consume(server, binding.recipient, challenge).await
}

pub(crate) async fn handle_get_vapid_public_key(
    Extension(server): Extension<super::server::RegistryServer>,
) -> Result<Response> {
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unavailable)?;
    let pubkey = runtime.vapid().public_key_base64url();
    let mut response = (
        StatusCode::OK,
        Json(serde_json::json!({
            "vapid_public_key": pubkey,
        })),
    )
        .into_response();
    if let Ok(header_val) = pubkey.parse() {
        response
            .headers_mut()
            .insert("x-cashweb-vapid-public-key", header_val);
    }
    Ok(response)
}

pub(crate) async fn handle_get_notification_policy(
    axum::extract::Path(address): axum::extract::Path<String>,
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
) -> Result<Response> {
    let address = Address::from_hex(&address).map_err(|_| CanonicalError::Unauthorized)?;
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unavailable)?;
    let binding = notification_policy_binding(
        address,
        crate::evm_mailbox::MailboxResource::NotificationPolicyRead,
    );
    let Some(auth) =
        crate::evm_mailbox::parse_mailbox_authentication(&headers, runtime, &binding, now_ms())
    else {
        return Ok(notification_policy_challenge(runtime, &binding));
    };
    authenticate_notification_policy(&server, runtime, &headers, &binding, auth, "GET", &[])
        .await?;
    let policy = on_store(&server, move |owner| owner.get_notification_policy(address)).await?;
    let mut response = (StatusCode::OK, Json(policy)).into_response();
    if let Ok(header_val) = runtime.vapid().public_key_base64url().parse() {
        response
            .headers_mut()
            .insert("x-cashweb-vapid-public-key", header_val);
    }
    Ok(response)
}

pub(crate) async fn handle_put_notification_policy(
    axum::extract::Path(address): axum::extract::Path<String>,
    Extension(server): Extension<super::server::RegistryServer>,
    headers: HeaderMap,
    RawBody(mut body): RawBody,
) -> Result<Response> {
    use hyper::body::HttpBody;
    let address = Address::from_hex(&address).map_err(|_| CanonicalError::Unauthorized)?;
    let runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unavailable)?;
    let binding = notification_policy_binding(
        address,
        crate::evm_mailbox::MailboxResource::NotificationPolicyWrite,
    );
    // A challenge this relay did not issue for this request is answered before the body is read.
    let Some(auth) =
        crate::evm_mailbox::parse_mailbox_authentication(&headers, runtime, &binding, now_ms())
    else {
        return Ok(notification_policy_challenge(runtime, &binding));
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|_| CanonicalError::Invalid)?;
        if chunk.len() > MAX_NOTIFICATION_POLICY_BYTES.saturating_sub(bytes.len()) {
            return Err(CanonicalError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    authenticate_notification_policy(&server, runtime, &headers, &binding, auth, "PUT", &bytes)
        .await?;
    let mut policy: crate::store::notification_policy::MailboxNotificationPolicy =
        serde_json::from_slice(&bytes).map_err(|_| CanonicalError::Invalid)?;
    if policy
        .min_notification_value_wei
        .trim()
        .parse::<u128>()
        .is_err()
    {
        return Err(CanonicalError::Invalid);
    }
    if policy.updated_at_ms == 0 {
        policy.updated_at_ms = now_ms().max(0) as u64;
    }
    let stored = policy.clone();
    on_store(&server, move |owner| {
        owner.put_notification_policy(address, &stored)
    })
    .await?;
    let mut response = (StatusCode::OK, Json(policy)).into_response();
    if let Ok(header_val) = runtime.vapid().public_key_base64url().parse() {
        response
            .headers_mut()
            .insert("x-cashweb-vapid-public-key", header_val);
    }
    Ok(response)
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
    use crate::evm_mailbox::{MailboxRequestBinding, MailboxResource};

    let address = Address::from_hex(&address).map_err(|_| CanonicalError::Unauthorized)?;
    let _runtime = server
        .evm_mailbox
        .as_enabled()
        .ok_or(CanonicalError::Unauthorized)?;

    let binding = MailboxRequestBinding {
        resource: MailboxResource::MailboxStream,
        recipient: address,
        since: 0,
        cursor: None,
        limit: 1,
        max_bytes: 0,
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

    // The bus is the only source of pushes: a message stored by any replica is announced on it
    // after its commit, and the row is then read from the shared store. Nothing is pushed that
    // the store cannot show.
    let mut event_rx = server
        .event_bus
        .subscribe(&address.to_hex())
        .await
        .map_err(|_| CanonicalError::Unavailable)?;

    Ok(ws.on_upgrade(move |mut socket| async move {
        let mut seen_payloads = std::collections::HashSet::new();
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if socket.send(axum::extract::ws::Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(axum::extract::ws::Message::Close(_))) | None => break,
                        Some(Ok(axum::extract::ws::Message::Ping(data))) => {
                            if socket.send(axum::extract::ws::Message::Pong(data)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(axum::extract::ws::Message::Pong(_))) => {}
                        Some(Ok(axum::extract::ws::Message::Text(ref text))) => {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
                                if val.get("type").and_then(|v| v.as_str()) == Some("ping") {
                                    if socket.send(axum::extract::ws::Message::Text("{\"type\":\"pong\"}".into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                        Some(Err(_)) => break,
                        _ => {}
                    }
                }
                notif = event_rx.recv() => {
                    let Some(notification) = notif else { break };
                    if seen_payloads.contains(&notification.payload_hash) {
                        continue;
                    }
                    let Some(push) = mailbox_push(&server, address, notification.payload_hash).await else {
                        // No such row here, or not this mailbox's: the hint is dropped. The client
                        // catches up from its cursor.
                        continue;
                    };
                    seen_payloads.insert(notification.payload_hash);
                    let json = match serde_json::to_string(&push) {
                        Ok(j) => j,
                        Err(_) => continue,
                    };
                    if socket.send(axum::extract::ws::Message::Text(json)).await.is_err() {
                        break;
                    }
                }
            }
        }
    }))
}

/// The push for a bus hint: the stored row the hint names, from `address`'s side of it. `None`
/// when the store has no such row (or cannot be read now), or the row is not in `address`'s
/// mailbox.
async fn mailbox_push(
    server: &super::server::RegistryServer,
    address: Address,
    payload_hash: [u8; 32],
) -> Option<MailboxWsPush> {
    let claim = on_store(server, move |owner| owner.get(&payload_hash))
        .await
        .ok()??;
    let direction = claim.direction_for(address)?;
    Some(MailboxWsPush {
        direction: direction.as_str(),
        submission_identity: hex::encode(claim.request.submission_identity()),
        payload_hash: hex::encode(payload_hash),
        timestamp_ms: claim.delivered_at,
        delivery: hex::encode(claim.request.delivery()),
        context: hex::encode(claim.request.context()),
    })
}
#[cfg(test)]
#[path = "evm_direct_messages_tests.rs"]
pub(crate) mod tests;
