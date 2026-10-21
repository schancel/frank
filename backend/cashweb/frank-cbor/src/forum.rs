//! Pure Forum writers, cursor transport and exact request comparisons. No chain or wallet authority.
use crate::cbor::{cbor_map, decode_single_item, encode_canonical, CborValue, Counters};
use crate::error::{CodecError, Error, ErrorCategory, ErrorStage, UsageError};
use crate::frame::{encode_frame, EnvelopeFields, FramePayload};
use crate::limits::MAX_FORUM_CURSOR_BYTES;
use crate::message_fields as mf;
use crate::message_types::{
    TYPE_FORUM_DISCOVERY_PAGE, TYPE_FORUM_OPERATION_STATUS, TYPE_FORUM_TOPIC_PAGE, TYPE_FORUM_VIEW,
    TYPE_TOPIC_POST,
};
use crate::model::{
    ForumCursor, ForumCursorPosition, ForumEntry, ForumOperationStatus, ParsedFrame, Timestamp,
    TopicPostAuthor, TypedPayload, ValidationResult,
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
        (mf::timestamp::SECONDS, CborValue::Int(t.seconds.into())),
        (
            mf::timestamp::NANOSECONDS,
            CborValue::Int(t.nanoseconds.into()),
        ),
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
    encode_signed_forum_post(network, topic, parent_hash, authored, entries, None, None)
}

/// Explicit schema-2 writer with optional signed author identity.
pub fn encode_signed_forum_post(
    network: &str,
    topic: &str,
    parent_hash: Option<&[u8]>,
    authored: &Timestamp,
    entries: &[ForumEntry],
    from: Option<&TopicPostAuthor>,
    signature: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    use mf::forum_post_entry as entry_k;
    use mf::topic_post as post;
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
        let mut fields = vec![(
            entry_k::KIND,
            CborValue::Int(mf::forum_entry_kind::POST.into()),
        )];
        for (key, value) in [
            (entry_k::TITLE, title),
            (entry_k::URL, url),
            (entry_k::MESSAGE, message),
        ] {
            if let Some(value) = value {
                if !value.is_empty() {
                    fields.push((key, CborValue::Text(value.clone())));
                }
            }
        }
        encoded.push(cbor_map(fields));
    }
    let content = encode_canonical(&cbor_map(vec![
        (mf::forum_content::AUTHORED, time(authored)),
        (mf::forum_content::ENTRIES, CborValue::Array(encoded)),
    ]))
    .map_err(usage)?;
    let mut fields = vec![
        (post::NETWORK, CborValue::Text(network.into())),
        (post::TOPIC, CborValue::Text(topic.into())),
        (post::BODY, CborValue::Bytes(content)),
    ];
    if let Some(parent) = parent_hash {
        fields.push((post::PARENT_HASH, CborValue::Bytes(parent.to_vec())));
    }
    if let Some(from) = from {
        let author_val = match from {
            TopicPostAuthor::Account(acc) => cbor_map(vec![
                (
                    mf::account_ref::KEY_TYPE,
                    CborValue::Int(acc.key_type.into()),
                ),
                (
                    mf::account_ref::KEY_BYTES,
                    CborValue::Bytes(acc.key_bytes.clone()),
                ),
            ]),
            TopicPostAuthor::Bytes(b) => CborValue::Bytes(b.clone()),
        };
        fields.push((post::AUTHOR, author_val));
    }
    if let Some(sig) = signature {
        fields.push((post::SIGNATURE, CborValue::Bytes(sig.to_vec())));
    }
    let frame = encode_frame(
        EnvelopeFields {
            type_id: TYPE_TOPIC_POST,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&cbor_map(fields)),
    )
    .map_err(usage)?;
    checked(&frame)?;
    Ok(frame)
}

/// Verifies the cryptographic author signature of a topic post and returns the 20-byte author address.
pub fn verify_topic_post_author(
    network: &str,
    topic: &str,
    body: &[u8],
    parent_hash: Option<&[u8]>,
    from: &TopicPostAuthor,
    signature: &[u8],
) -> Option<[u8; 20]> {
    let digest =
        crate::hash::topic_post_signature_digest(network, topic, body, parent_hash).ok()?;
    match from {
        TopicPostAuthor::Account(acc) => {
            if acc.key_type == mf::key_type::SECP256K1 && acc.key_bytes.len() == 33 {
                if crate::crypto::verify_algorithm_1(&digest, signature, &acc.key_bytes) {
                    return crate::registration::address_from_compressed_pubkey(&acc.key_bytes)
                        .ok();
                }
            }
        }
        TopicPostAuthor::Bytes(b) => {
            if b.len() == 33 {
                if crate::crypto::verify_algorithm_1(&digest, signature, b) {
                    return crate::registration::address_from_compressed_pubkey(b).ok();
                }
            }
        }
    }
    None
}
/// Constructs and validates a complete read frame without asserting its observations are true.
pub fn encode_forum_read_frame(type_id: u32, payload: &CborValue) -> Result<Vec<u8>, Error> {
    if !matches!(
        type_id,
        TYPE_FORUM_VIEW
            | TYPE_FORUM_TOPIC_PAGE
            | TYPE_FORUM_DISCOVERY_PAGE
            | TYPE_FORUM_OPERATION_STATUS
    ) {
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
    use mf::forum_discovery_cursor as discovery;
    use mf::forum_topic_cursor as topic_k;
    // Fields both cursor families share; schema.rs asserts their keys agree.
    let mut fields = vec![
        (topic_k::NETWORK, CborValue::Text(cursor.network.clone())),
        (topic_k::REVISION, CborValue::Int(cursor.revision.into())),
        (topic_k::EPOCH, CborValue::Bytes(cursor.epoch.clone())),
        (
            topic_k::INCARNATION,
            CborValue::Int(cursor.incarnation.into()),
        ),
    ];
    match &cursor.position {
        ForumCursorPosition::Topic {
            topic,
            since,
            timestamp,
            hash,
        } => fields.extend([
            (
                topic_k::FAMILY,
                CborValue::Int(i128::from(TYPE_FORUM_TOPIC_PAGE)),
            ),
            (
                topic_k::LAST,
                cbor_map(vec![
                    (mf::forum_cursor_last::TIMESTAMP, time(timestamp)),
                    (mf::forum_cursor_last::HASH, CborValue::Bytes(hash.clone())),
                ]),
            ),
            (topic_k::TOPIC, CborValue::Text(topic.clone())),
            (topic_k::SINCE, time(since)),
        ]),
        ForumCursorPosition::Discovery { topic } => fields.extend([
            (
                discovery::FAMILY,
                CborValue::Int(i128::from(TYPE_FORUM_DISCOVERY_PAGE)),
            ),
            (discovery::TOPIC, CborValue::Text(topic.clone())),
        ]),
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
