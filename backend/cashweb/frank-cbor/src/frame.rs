//! FRNK frame header (README section 1).

use crate::cbor::{encode_canonical, CborValue};
use crate::error::UsageError;
use crate::limits::{FRAME_HEADER_BYTES, FRAME_MAGIC, FRAME_VERSION, MAX_BODY_BYTES};

/// Envelope fields written by [`encode_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeFields {
    /// Immutable object-kind identifier.
    pub type_id: u32,
    /// Exact schema revision. Minimum 1.
    pub schema_version: u32,
    /// Oldest semantic reader allowed to interpret the object. Minimum 1.
    pub min_reader_version: u32,
}

/// Payload supplied to [`encode_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePayload<'a> {
    /// A value encoded canonically as the payload item.
    Value(&'a CborValue),
    /// An already-encoded payload item, retained byte for byte.
    Bytes(&'a [u8]),
}

fn usage(detail: impl Into<String>) -> UsageError {
    UsageError(detail.into())
}

/// Wraps already-encoded envelope bytes in the nine-byte FRNK header.
pub fn wrap_frame(body: &[u8], version: u8) -> Result<Vec<u8>, UsageError> {
    if body.len() > MAX_BODY_BYTES {
        return Err(usage("envelope body exceeds MAX_BODY_BYTES"));
    }
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    out.extend_from_slice(&FRAME_MAGIC);
    out.push(version);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

/// Encodes a version-1 frame around a canonical envelope map.
pub fn encode_frame(env: EnvelopeFields, payload: FramePayload<'_>) -> Result<Vec<u8>, UsageError> {
    if env.schema_version < 1 {
        return Err(usage("schema_version must be an integer in 1..4294967295"));
    }
    if env.min_reader_version < 1 {
        return Err(usage(
            "min_reader_version must be an integer in 1..4294967295",
        ));
    }
    if env.min_reader_version > env.schema_version {
        return Err(usage(
            "min_reader_version must not exceed schema_version (E2)",
        ));
    }
    let payload_bytes = match payload {
        FramePayload::Bytes(bytes) => bytes.to_vec(),
        FramePayload::Value(value) => encode_canonical(value)?,
    };
    let body = encode_canonical(&CborValue::Map(vec![
        (0, CborValue::Int(i128::from(env.type_id))),
        (1, CborValue::Int(i128::from(env.schema_version))),
        (2, CborValue::Int(i128::from(env.min_reader_version))),
        (3, CborValue::Bytes(payload_bytes)),
    ]))?;
    wrap_frame(&body, FRAME_VERSION)
}
