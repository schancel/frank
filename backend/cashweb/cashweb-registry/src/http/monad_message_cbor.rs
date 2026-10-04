//! Exact canonical DM transport. No legacy protobuf projection or implicit admission.
use std::{ops::Range, sync::Arc};

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use bitcoinsuite_core::{Hashed, Sha256};
use frank_cbor::{encode_canonical, CborValue};
use serde::Serialize;
use sha3::{Digest, Keccak256};

pub(crate) const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_CONTEXT_BYTES: usize = 4096;
pub(crate) const MAX_RAW_TRANSACTION_BYTES: usize = 128 * 1024;

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
    #[error("recovery obligation is active")]
    ActiveObligation,
}
pub(crate) type Result<T> = std::result::Result<T, CanonicalError>;
impl IntoResponse for CanonicalError {
    fn into_response(self) -> Response {
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
            Self::Capacity => (StatusCode::TOO_MANY_REQUESTS, "mailbox_challenge_capacity"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "mailbox_auth_failed"),
            Self::ActiveObligation => (StatusCode::CONFLICT, "recovery_obligation_is_active"),
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
}
impl ExactRequest {
    pub(crate) fn parse(body: Vec<u8>, content_type: String) -> Result<Self> {
        if body.len() > MAX_REQUEST_BYTES {
            return Err(CanonicalError::TooLarge);
        }
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
        })
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
    pub(crate) fn raw_transactions(&self) -> impl Iterator<Item = &[u8]> {
        self.transactions
            .iter()
            .map(|range| &self.body[range.clone()])
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
        self.transactions.len()
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
    if !(1..=64).contains(&count) {
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
