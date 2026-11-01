//! Exact canonical direct-message request framing and copy-owned byte ranges.
//!
//! Payment members remain opaque bytes. Parsing enforces shared structural budgets and
//! computes the existing submission identity; it never decodes a chain transaction, performs
//! RPC, or admits/delivers a message.
use std::{ops::Range, sync::Arc};

use bitcoinsuite_core::{Hashed, Sha256};
use frank_cbor::{encode_canonical, CborValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RequestError {
    #[error("invalid canonical request framing")]
    Invalid,
    #[error("canonical request framing exceeds its byte budget")]
    TooLarge,
}
type Result<T> = std::result::Result<T, RequestError>;

/// One direct-message request, and one mailbox page or record (12 MiB): the largest delivery frame
/// (`frank_cbor::MAX_DIRECT_MESSAGE_FRAME_BYTES`, 10 MiB, whose crypto-box envelope is at most
/// 8 MiB + 88) and 2 MiB for its context (at most [`MAX_CONTEXT_BYTES`]), up to 64 raw stamp
/// transactions and the multipart framing. The client's `CANONICAL_DM_MAX_BYTES` is the same.
pub(crate) const MAX_REQUEST_BYTES: usize = 12 * 1024 * 1024;
pub(crate) const MAX_CONTEXT_BYTES: usize = 4096;
pub(crate) const MAX_RAW_TRANSACTION_BYTES: usize = 128 * 1024;

/// One copy-owned original body. Every part/member remains a byte range into this owner.
#[derive(Debug, Clone)]
pub(crate) struct ExactRequest {
    body: Arc<[u8]>,
    content_type: String,
    delivery: Range<usize>,
    context: Range<usize>,
    transactions: Vec<Range<usize>>,
    submission_identity: [u8; 32],
    raw_tx_bytes: Vec<Vec<u8>>,
}
impl ExactRequest {
    pub(crate) fn parse(body: Vec<u8>, content_type: String) -> Result<Self> {
        if body.len() > MAX_REQUEST_BYTES {
            return Err(RequestError::TooLarge);
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
                return Err(RequestError::TooLarge);
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
            let encoded = encode_canonical(&tuple).map_err(|_| RequestError::Invalid)?;
            let submission_identity = Sha256::digest(encoded.into())
                .as_slice()
                .try_into()
                .expect("SHA256");
            Ok(Self {
                body: body.into(),
                content_type,
                delivery: parts[0].clone(),
                context: parts[1].clone(),
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
                transactions: Vec::new(),
                submission_identity,
                raw_tx_bytes,
            })
        } else {
            Err(RequestError::Invalid)
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
    pub(crate) fn submission_identity(&self) -> [u8; 32] {
        self.submission_identity
    }
    #[cfg(test)]
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

pub(crate) fn parse_boundary(content_type: &str, media_type: &str) -> Result<String> {
    let boundary = content_type
        .strip_prefix(media_type)
        .and_then(|tail| tail.strip_prefix("; boundary="))
        .ok_or(RequestError::Invalid)?;
    if boundary.is_empty()
        || boundary.len() > 70
        || !boundary
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(RequestError::Invalid);
    }
    Ok(boundary.into())
}
pub(crate) fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
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
        return Err(RequestError::Invalid);
    }
    let mut position = opening.len();
    let mut parts = Vec::with_capacity(expected.len());
    for (index, (name, media)) in expected.iter().enumerate() {
        let header_end = find(&body[position..], b"\r\n\r\n").ok_or(RequestError::Invalid)?;
        if header_end > 4096 {
            return Err(RequestError::TooLarge);
        }
        let header = std::str::from_utf8(&body[position..position + header_end])
            .map_err(|_| RequestError::Invalid)?;
        let mut headers = header.split("\r\n");
        let disposition_header = headers.next().ok_or(RequestError::Invalid)?;
        let media_header = headers.next().ok_or(RequestError::Invalid)?;
        if headers.next().is_some()
            || disposition_header != format!("Content-Disposition: {disposition}; name=\"{name}\"")
            || media_header != format!("Content-Type: {media}")
        {
            return Err(RequestError::Invalid);
        }
        position += header_end + 4;
        let length = find(&body[position..], &separator).ok_or(RequestError::Invalid)?;
        parts.push(position..position + length);
        position += length + separator.len();
        if index + 1 == expected.len() {
            if body.get(position..) != Some(b"--\r\n".as_slice()) {
                return Err(RequestError::Invalid);
            }
        } else {
            if body.get(position..position + 2) != Some(b"\r\n".as_slice()) {
                return Err(RequestError::Invalid);
            }
            position += 2;
        }
    }
    Ok(parts)
}
fn length(bytes: &[u8], position: &mut usize, major: u8) -> Result<usize> {
    let initial = *bytes.get(*position).ok_or(RequestError::Invalid)?;
    *position += 1;
    if initial >> 5 != major {
        return Err(RequestError::Invalid);
    }
    let additional = initial & 31;
    let (width, minimum) = match additional {
        0..=23 => return Ok(additional as usize),
        24 => (1, 24),
        25 => (2, 256),
        26 => (4, 65536),
        27 => (8, 4294967296),
        _ => return Err(RequestError::Invalid),
    };
    let end = position.checked_add(width).ok_or(RequestError::Invalid)?;
    let encoded = bytes.get(*position..end).ok_or(RequestError::Invalid)?;
    let value = encoded
        .iter()
        .fold(0u64, |value, b| (value << 8) | u64::from(*b));
    *position = end;
    if value < minimum {
        return Err(RequestError::Invalid);
    }
    value.try_into().map_err(|_| RequestError::TooLarge)
}
pub(crate) fn transaction_ranges(bytes: &[u8], offset: usize) -> Result<Vec<Range<usize>>> {
    let mut position = 0;
    let count = length(bytes, &mut position, 4)?;
    if count > 64 {
        return Err(RequestError::TooLarge);
    }
    let mut ranges = Vec::with_capacity(count);
    for _ in 0..count {
        let size = length(bytes, &mut position, 2)?;
        if size == 0 || size > MAX_RAW_TRANSACTION_BYTES {
            return Err(RequestError::TooLarge);
        }
        let end = position.checked_add(size).ok_or(RequestError::TooLarge)?;
        if end > bytes.len() {
            return Err(RequestError::Invalid);
        }
        ranges.push(offset + position..offset + end);
        position = end;
    }
    if position != bytes.len() {
        return Err(RequestError::Invalid);
    }
    Ok(ranges)
}
