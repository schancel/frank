//! Pure Forum writers, cursor transport and exact request comparisons. No chain or wallet authority.
use crate::cbor::{cbor_map, decode_single_item, encode_canonical, CborValue, Counters};
use crate::error::{CodecError, Error, ErrorCategory, ErrorStage, UsageError};
use crate::frame::{encode_frame, EnvelopeFields, FramePayload};
use crate::limits::MAX_FORUM_CURSOR_BYTES;
use crate::model::{
    ForumCursor, ForumCursorPosition, ForumEntry, ForumOperationStatus, ParsedFrame, Timestamp,
    TypedPayload, ValidationResult,
};
use crate::schema::parse_forum_cursor;
use crate::validate::{default_context, validate_frame};

fn failure(message: impl Into<String>) -> CodecError {
    CodecError::new(
        ErrorCategory::Semantic,
        ErrorStage::S9,
        message,
        "root/forum-binding",
        None,
    )
}
fn usage(error: UsageError) -> Error {
    failure(error.0).into()
}
fn time(t: &Timestamp) -> CborValue {
    cbor_map(vec![
        (0, CborValue::Int(t.seconds.into())),
        (1, CborValue::Int(t.nanoseconds.into())),
    ])
}
fn checked(frame: &[u8]) -> Result<ParsedFrame, Error> {
    match validate_frame(frame, &default_context())? {
        ValidationResult::Parsed(parsed) => Ok(parsed),
        _ => Err(failure("expected parsed Forum frame").into()),
    }
}
/// Explicit schema-2 writer; entries must be known posts and empty optionals are omitted.
pub fn encode_forum_post(
    network: &str,
    topic: &str,
    parent_hash: Option<&[u8]>,
    authored: &Timestamp,
    entries: &[ForumEntry],
) -> Result<Vec<u8>, Error> {
    let mut encoded = Vec::new();
    for entry in entries {
        let ForumEntry::Post {
            title,
            url,
            message,
            unknown,
        } = entry
        else {
            return Err(failure("writer requires known Forum entries").into());
        };
        if !unknown.is_empty() {
            return Err(failure("schema-2 writer has no extension keys").into());
        }
        let mut fields = vec![(0, CborValue::Int(1))];
        for (key, value) in [(1, title), (2, url), (3, message)] {
            if let Some(value) = value {
                if !value.is_empty() {
                    fields.push((key, CborValue::Text(value.clone())));
                }
            }
        }
        encoded.push(cbor_map(fields));
    }
    let content = encode_canonical(&cbor_map(vec![
        (0, time(authored)),
        (1, CborValue::Array(encoded)),
    ]))
    .map_err(usage)?;
    let mut fields = vec![
        (0, CborValue::Text(network.into())),
        (1, CborValue::Text(topic.into())),
        (3, CborValue::Bytes(content)),
    ];
    if let Some(parent) = parent_hash {
        fields.push((2, CborValue::Bytes(parent.to_vec())));
    }
    let frame = encode_frame(
        EnvelopeFields {
            type_id: 9,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&cbor_map(fields)),
    )
    .map_err(usage)?;
    checked(&frame)?;
    Ok(frame)
}
/// Constructs and validates a complete read frame without asserting its observations are true.
pub fn encode_forum_read_frame(type_id: u32, payload: &CborValue) -> Result<Vec<u8>, Error> {
    if !(12..=15).contains(&type_id) {
        return Err(failure("expected Forum read type").into());
    }
    let frame = encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(payload),
    )
    .map_err(usage)?;
    checked(&frame)?;
    Ok(frame)
}
/// Canonical closed cursor parsing. No snapshot existence, lifetime, or authority is inferred.
pub fn decode_forum_cursor(bytes: &[u8]) -> Result<ForumCursor, CodecError> {
    if bytes.is_empty() || bytes.len() > MAX_FORUM_CURSOR_BYTES {
        return Err(CodecError::new(
            ErrorCategory::Resource,
            ErrorStage::S81,
            "cursor byte limit",
            "cursor",
            None,
        ));
    }
    let value = decode_single_item(bytes, ErrorStage::S7, "cursor", &mut Counters::default(), 0)?;
    parse_forum_cursor(&value, bytes.to_vec(), "cursor")
}
/// Re-encodes explicit cursor fields; use `bytes` for forwarding an existing cursor.
pub fn encode_forum_cursor(cursor: &ForumCursor) -> Result<Vec<u8>, Error> {
    let mut fields = vec![
        (0, CborValue::Text(cursor.network.clone())),
        (2, CborValue::Int(cursor.revision.into())),
        (3, CborValue::Bytes(cursor.epoch.clone())),
        (7, CborValue::Int(cursor.incarnation.into())),
    ];
    match &cursor.position {
        ForumCursorPosition::Topic {
            topic,
            since,
            timestamp,
            hash,
        } => fields.extend([
            (1, CborValue::Int(13)),
            (
                4,
                cbor_map(vec![
                    (0, time(timestamp)),
                    (1, CborValue::Bytes(hash.clone())),
                ]),
            ),
            (5, CborValue::Text(topic.clone())),
            (6, time(since)),
        ]),
        ForumCursorPosition::Discovery { topic } => {
            fields.extend([(1, CborValue::Int(14)), (4, CborValue::Text(topic.clone()))])
        }
    }
    let bytes = encode_canonical(&cbor_map(fields)).map_err(usage)?;
    decode_forum_cursor(&bytes)?;
    Ok(bytes)
}
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// Unique unpadded base64url spelling, with bounds checked before allocation.
pub fn forum_cursor_to_transport(bytes: &[u8]) -> Result<String, CodecError> {
    decode_forum_cursor(bytes)?;
    let mut out = String::new();
    let mut bits = 0;
    let mut value = 0u32;
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(ALPHABET[((value >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (6 - bits)) & 63) as usize] as char);
    }
    Ok(out)
}
/// Rejects alternate alphabets, whitespace, padding and nonzero trailing padding bits.
pub fn forum_cursor_from_transport(text: &str) -> Result<ForumCursor, CodecError> {
    if text.is_empty()
        || text.len() > 2731
        || text.len() % 4 == 1
        || !text.bytes().all(|b| ALPHABET.contains(&b))
    {
        return Err(failure("invalid cursor transport"));
    }
    let length = text.len() * 6 / 8;
    if length > MAX_FORUM_CURSOR_BYTES {
        return Err(failure("cursor decoded size"));
    }
    let mut bytes = Vec::with_capacity(length);
    let mut bits = 0;
    let mut value = 0u32;
    for byte in text.bytes() {
        value = (value << 6)
            | ALPHABET
                .iter()
                .position(|b| *b == byte)
                .expect("checked alphabet") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((value >> bits) & 255) as u8);
        }
    }
    if bits > 0 && value & ((1 << bits) - 1) != 0 {
        return Err(failure("noncanonical cursor padding bits"));
    }
    decode_forum_cursor(&bytes)
}
/// Explicit retained request facts, not transaction-derived evidence.
#[derive(Debug, Clone)]
pub struct ForumOperationExpectation {
    /// Retained request network.
    pub network: String,
    /// Complete original submitted operation bytes.
    pub submitted_frame: Vec<u8>,
    /// Retained target post T1.
    pub target_hash: Vec<u8>,
    /// Expected transaction identity supplied by the caller.
    pub transaction_hash: Vec<u8>,
    /// Expected sender supplied by the caller.
    pub sender: Vec<u8>,
    /// Zero for down, one for up.
    pub direction: u8,
    /// Exact expected value; comparison does not verify admission.
    pub value: u64,
}
/// Binds every echoed request fact; a matched response retains its original evidence classification.
pub fn match_forum_operation(
    frame: &[u8],
    expected: &ForumOperationExpectation,
) -> Result<ForumOperationStatus<ParsedFrame>, Error> {
    let parsed = checked(frame)?;
    let Some(boxed) = parsed.typed else {
        return Err(failure("expected Forum status").into());
    };
    let TypedPayload::ForumOperationStatus(status) = *boxed else {
        return Err(failure("expected Forum status").into());
    };
    if status.network != expected.network
        || status.submitted_frame.frame != expected.submitted_frame
        || status.target_hash != expected.target_hash
        || status.transaction_hash != expected.transaction_hash
        || status.sender != expected.sender
        || status.direction != expected.direction
        || status.value != expected.value
    {
        return Err(failure("operation response differs from retained request").into());
    }
    Ok(status)
}
