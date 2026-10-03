//! Stages 8.1 (type limits), 8.2 (CDDL), and 8.3 (allocated identifiers).

use crate::cbor::CborValue;
use crate::error::{CodecError, ErrorCategory, ErrorStage};
use crate::limits::{
    ENCRYPTION_SUITE_DM_AUTH_XCHACHA, ENCRYPTION_SUITE_PROOF, MAX_CIPHERTEXT_BYTES,
    MAX_DIRECTORY_ATTESTATION_FRAME_BYTES, MAX_DIRECT_MESSAGE_FRAME_BYTES,
    MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES, MAX_FRAME_BYTES, MAX_JOURNAL_FACTS,
    MAX_MESSAGE_ITEMS_PER_ARRAY, MAX_OPAQUE_SECTIONS, MAX_PAYMENT_MEMBERS, MAX_RELAY_BINDINGS,
    MAX_SIGNATURES, MAX_TEXT_STRING_BYTES, MAX_TOPIC_BODY_BYTES, MAX_TOPIC_FRAME_BYTES,
    MAX_TOPIC_VOTE_FRAME_BYTES, TYPE_CONTAINER_ITEM, TYPE_DIRECTORY_ATTESTATION,
    TYPE_DIRECTORY_STATEMENT, TYPE_DIRECT_MESSAGE, TYPE_MAILBOX_CHECKPOINT, TYPE_MESSAGE_REVISION,
    TYPE_RECIPIENT_PAYLOAD, TYPE_TOPIC_POST, TYPE_TOPIC_POST_SUBMISSION,
    TYPE_TOPIC_VOTE_SUBMISSION,
};
use crate::model::{AccountRef, PreviewDirectoryRoles, Timestamp};

/// The schema versions a type-4 parse needs: the envelope's (kept for S10a.2) and the effective
/// one, the envelope's or the reader's highest supported when the frame is newer (V6.3).
#[derive(Clone, Copy)]
pub(crate) struct SchemaVersions {
    pub envelope: u32,
    pub effective: u32,
}

pub(crate) struct MapFields<'a> {
    entries: &'a [(u64, CborValue)],
    pub unknown: Vec<(u64, CborValue)>,
}

impl<'a> MapFields<'a> {
    fn get(&self, key: u64) -> Option<&'a CborValue> {
        self.entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    fn has(&self, key: u64) -> bool {
        self.get(key).is_some()
    }
}

fn fail(
    category: ErrorCategory,
    stage: ErrorStage,
    path: &str,
    message: impl Into<String>,
) -> CodecError {
    CodecError::new(category, stage, message, path, None)
}

fn bad(path: &str, message: impl Into<String>) -> CodecError {
    fail(ErrorCategory::Schema, ErrorStage::S82, path, message)
}

fn unsupported(path: &str, message: impl Into<String>) -> CodecError {
    fail(ErrorCategory::Unsupported, ErrorStage::S83, path, message)
}

fn uint_range(v: Option<&CborValue>, path: &str, min: i128, max: i128) -> Result<i128, CodecError> {
    match v {
        Some(CborValue::Int(n)) if *n >= min && *n <= max => Ok(*n),
        Some(CborValue::Int(_)) => Err(bad(path, format!("integer outside {min}..{max}"))),
        _ => Err(bad(path, "expected an unsigned integer")),
    }
}

fn u32_in(v: Option<&CborValue>, path: &str, min: u32, max: u32) -> Result<u32, CodecError> {
    let n = uint_range(v, path, i128::from(min), i128::from(max))?;
    Ok(n as u32)
}

fn u64_in(v: Option<&CborValue>, path: &str, min: u64, max: u64) -> Result<u64, CodecError> {
    let n = uint_range(v, path, i128::from(min), max as i128)?;
    Ok(n as u64)
}

fn bstr(v: Option<&CborValue>, path: &str, min: usize, max: usize) -> Result<Vec<u8>, CodecError> {
    match v {
        Some(CborValue::Bytes(b)) if b.len() >= min && b.len() <= max => Ok(b.clone()),
        Some(CborValue::Bytes(_)) => {
            Err(bad(path, format!("byte string size outside {min}..{max}")))
        }
        _ => Err(bad(path, "expected a byte string")),
    }
}

fn text_size(s: &str, path: &str, min: usize, max: usize) -> Result<String, CodecError> {
    if s.len() < min || s.len() > max {
        return Err(bad(path, format!("text size outside {min}..{max}")));
    }
    Ok(s.to_string())
}

fn tstr(v: Option<&CborValue>, path: &str, min: usize, max: usize) -> Result<String, CodecError> {
    match v {
        Some(CborValue::Text(s)) => text_size(s, path, min, max),
        _ => Err(bad(path, "expected a text string")),
    }
}

fn is_network_tag(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn network_tag(v: Option<&CborValue>, path: &str) -> Result<String, CodecError> {
    let s = tstr(v, path, 1, 64)?;
    if !is_network_tag(&s) {
        return Err(bad(path, "network tag does not match S1"));
    }
    Ok(s)
}

fn is_scheme_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-')
}

fn is_endpoint_byte(c: u8) -> bool {
    (0x21..=0x7e).contains(&c)
        && !matches!(
            c,
            b'"' | b'<' | b'>' | b'\\' | b'^' | b'`' | b'{' | b'|' | b'}'
        )
}

fn is_endpoint(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() && is_scheme_char(bytes[i]) {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b':' {
        return false;
    }
    bytes[i + 1..].iter().copied().all(is_endpoint_byte)
}

fn endpoint(v: Option<&CborValue>, path: &str) -> Result<String, CodecError> {
    let s = tstr(v, path, 1, 2048)?;
    if !is_endpoint(&s) {
        return Err(bad(path, "endpoint violates S4"));
    }
    Ok(s)
}

fn as_list<'a>(
    v: Option<&'a CborValue>,
    path: &str,
    min: usize,
    max: usize,
) -> Result<&'a [CborValue], CodecError> {
    match v {
        Some(CborValue::Array(a)) if a.len() >= min && a.len() <= max => Ok(a),
        Some(CborValue::Array(_)) => Err(bad(path, format!("array size outside {min}..{max}"))),
        _ => Err(bad(path, "expected an array")),
    }
}

fn declared(key: u64, required: &[u64], optional: &[u64]) -> bool {
    required.contains(&key) || optional.contains(&key)
}

fn fields<'a>(
    v: Option<&'a CborValue>,
    path: &str,
    required: &[u64],
    optional: &[u64],
    open: bool,
    allow_unknown: bool,
) -> Result<MapFields<'a>, CodecError> {
    let entries = match v {
        Some(CborValue::Map(entries)) => entries.as_slice(),
        _ => return Err(bad(path, "expected a map")),
    };
    for key in required {
        if !entries.iter().any(|(k, _)| k == key) {
            return Err(bad(path, format!("missing required key {key}")));
        }
    }
    let mut unknown = Vec::new();
    for (key, value) in entries {
        if declared(*key, required, optional) {
            continue;
        }
        if open && allow_unknown {
            unknown.push((*key, value.clone()));
        } else {
            return Err(bad(path, format!("undeclared key {key} (C12)")));
        }
    }
    Ok(MapFields { entries, unknown })
}

fn key_length(key_type: u32) -> Option<usize> {
    match key_type {
        1 => Some(33),
        2 | 3 => Some(32),
        _ => None,
    }
}

fn account(v: Option<&CborValue>, path: &str) -> Result<AccountRef, CodecError> {
    let map = fields(v, path, &[0, 1], &[], false, false)?;
    let key_type = u32_in(map.get(0), &format!("{path}.0"), 0, 65_535)?;
    let key_bytes = bstr(map.get(1), &format!("{path}.1"), 1, 128)?;
    if let Some(expected) = key_length(key_type) {
        if key_bytes.len() != expected {
            return Err(bad(
                &format!("{path}.1"),
                format!("key type {key_type} requires {expected} key bytes (S2)"),
            ));
        }
    }
    Ok(AccountRef {
        key_type,
        key_bytes,
    })
}

fn directory_account(
    v: Option<&CborValue>,
    path: &str,
    preview: bool,
) -> Result<AccountRef, CodecError> {
    let key = account(v, path)?;
    if preview && key.key_type != 1 {
        return Err(bad(path, "directory preview key type must be 1"));
    }
    Ok(key)
}

/// A type-5 stamp point (T3b encoding rules): 33 compressed bytes on the curve. The parser
/// rejects a prefix other than 02 or 03, an x at or above the field prime, an off-curve x, and
/// the all-zero value (the point at infinity has no compressed encoding).
fn point(v: Option<&CborValue>, path: &str) -> Result<Vec<u8>, CodecError> {
    let bytes = bstr(v, path, 33, 33)?;
    if !matches!(bytes[0], 0x02 | 0x03) || secp256k1_abc::PublicKey::from_slice(&bytes).is_err() {
        return Err(bad(path, "not a valid compressed secp256k1 point (T3b)"));
    }
    Ok(bytes)
}

/// Group order `n` of secp256k1, big-endian.
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// The type-5 DLEQ proof `c || s` (T3b encoding rules): 64 bytes, both scalars in `1..n-1`.
fn proof(v: Option<&CborValue>, path: &str) -> Result<Vec<u8>, CodecError> {
    let bytes = bstr(v, path, 64, 64)?;
    for half in bytes.chunks(32) {
        // Equal-length big-endian byte strings compare like the integers they encode.
        if half.iter().all(|b| *b == 0) || half >= SECP256K1_ORDER.as_slice() {
            return Err(bad(path, "proof scalar outside 1..n-1 (T3b)"));
        }
    }
    Ok(bytes)
}

fn timestamp(v: Option<&CborValue>, path: &str) -> Result<Timestamp, CodecError> {
    let map = fields(v, path, &[0, 1], &[], false, false)?;
    let seconds = match map.get(0) {
        Some(CborValue::Int(n)) if *n >= i128::from(i64::MIN) && *n <= i128::from(i64::MAX) => {
            *n as i64
        }
        _ => return Err(bad(&format!("{path}.0"), "seconds must be an i64")),
    };
    let nanoseconds = u32_in(map.get(1), &format!("{path}.1"), 0, 999_999_999)?;
    Ok(Timestamp {
        seconds,
        nanoseconds,
    })
}

/// Root frame length limits of R2 and R3. Only a root frame is charged by the caller.
pub(crate) fn check_root_frame_limit(
    type_id: u32,
    frame_length: usize,
    schema_version: u32,
) -> bool {
    if type_id == TYPE_DIRECTORY_STATEMENT && schema_version >= 4 {
        return frame_length <= MAX_DIRECTORY_ATTESTATION_FRAME_BYTES;
    }
    if type_id == TYPE_DIRECT_MESSAGE {
        return frame_length <= MAX_DIRECT_MESSAGE_FRAME_BYTES;
    }
    if type_id == TYPE_DIRECTORY_ATTESTATION {
        return frame_length <= MAX_DIRECTORY_ATTESTATION_FRAME_BYTES;
    }
    if type_id == TYPE_TOPIC_POST || type_id == TYPE_TOPIC_POST_SUBMISSION {
        return frame_length <= MAX_TOPIC_FRAME_BYTES;
    }
    if type_id == TYPE_TOPIC_VOTE_SUBMISSION {
        return frame_length <= MAX_TOPIC_VOTE_FRAME_BYTES;
    }
    frame_length <= MAX_FRAME_BYTES
}

fn too_many(v: Option<&CborValue>, limit: usize) -> bool {
    matches!(v, Some(CborValue::Array(items)) if items.len() > limit)
}

fn map_field(payload: &CborValue, key: u64) -> Option<&CborValue> {
    match payload {
        CborValue::Map(entries) => entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// R2-R4 counts read from the decoded fields, before typed conversion.
pub(crate) fn check_type_limits(
    type_id: u32,
    payload: &CborValue,
    schema_version: u32,
) -> Result<(), CodecError> {
    if !matches!(payload, CborValue::Map(_)) {
        return Ok(());
    }
    let over = |what: &str| {
        fail(
            ErrorCategory::Resource,
            ErrorStage::S81,
            "root/payload",
            format!("{what} exceeds its limit (R2-R4)"),
        )
    };
    match type_id {
        TYPE_DIRECT_MESSAGE => {
            if too_many(map_field(payload, 4), MAX_PAYMENT_MEMBERS) {
                return Err(over("payment members"));
            }
        }
        TYPE_DIRECTORY_ATTESTATION => {
            if too_many(map_field(payload, 1), MAX_SIGNATURES) {
                return Err(over("signatures"));
            }
        }
        TYPE_MAILBOX_CHECKPOINT => {
            if too_many(map_field(payload, 4), MAX_JOURNAL_FACTS) {
                return Err(over("journal facts"));
            }
            if too_many(map_field(payload, 5), MAX_OPAQUE_SECTIONS) {
                return Err(over("opaque sections"));
            }
        }
        TYPE_DIRECTORY_STATEMENT => {
            if too_many(map_field(payload, 4), MAX_RELAY_BINDINGS) {
                return Err(over("relay bindings"));
            }
        }
        TYPE_RECIPIENT_PAYLOAD => {
            if schema_version >= 2 {
                if let Some(CborValue::Bytes(bytes)) = map_field(payload, 4) {
                    if bytes.len() > MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES {
                        return Err(over("crypto-box envelope"));
                    }
                }
            } else if let Some(CborValue::Bytes(bytes)) = map_field(payload, 5) {
                if bytes.len() > MAX_CIPHERTEXT_BYTES {
                    return Err(over("ciphertext"));
                }
            }
        }
        TYPE_TOPIC_POST => {
            if let Some(CborValue::Bytes(bytes)) = map_field(payload, 3) {
                if bytes.len() > MAX_TOPIC_BODY_BYTES {
                    return Err(over("topic body"));
                }
            }
        }
        TYPE_MESSAGE_REVISION => {
            if too_many(map_field(payload, 1), MAX_MESSAGE_ITEMS_PER_ARRAY) {
                return Err(over("message items"));
            }
        }
        TYPE_CONTAINER_ITEM => {
            if too_many(map_field(payload, 0), MAX_MESSAGE_ITEMS_PER_ARRAY) {
                return Err(over("message items"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn framed(v: Option<&CborValue>, path: &str) -> Result<Vec<u8>, CodecError> {
    bstr(v, path, 9, MAX_FRAME_BYTES)
}

pub(crate) struct PaymentDraft {
    pub child_index: u32,
    pub transaction_id: Vec<u8>,
    pub value: Vec<u8>,
    pub address: Vec<u8>,
    pub commitment: Vec<u8>,
}

pub(crate) struct SignatureDraft {
    pub algorithm: u32,
    pub signer: AccountRef,
    pub signature: Vec<u8>,
}

pub(crate) struct RelayDraft {
    pub relay_id: Vec<u8>,
    pub endpoint: String,
    pub identity: AccountRef,
    pub expiry: Timestamp,
    pub unknown: Vec<(u64, CborValue)>,
}

pub(crate) struct TransitionDraft {
    pub statement_frame: Vec<u8>,
    pub algorithm: u32,
    pub signer: AccountRef,
    pub signature: Vec<u8>,
    pub unknown: Vec<(u64, CborValue)>,
}

pub(crate) struct FactDraft {
    pub timestamp: Timestamp,
    pub fact_id: Vec<u8>,
    pub kind: u32,
    pub payload: Vec<u8>,
    pub unknown: Vec<(u64, CborValue)>,
}

pub(crate) struct SectionDraft {
    pub section_type: u32,
    pub section_schema_version: u32,
    pub value: Vec<u8>,
}

pub(crate) struct HeaderDraft {
    pub name: String,
    pub value: String,
    pub unknown: Vec<(u64, CborValue)>,
}

pub(crate) struct ProfileEntryDraft {
    pub kind: String,
    pub headers: Vec<HeaderDraft>,
    pub body: Vec<u8>,
    pub unknown: Vec<(u64, CborValue)>,
}

pub(crate) enum Draft {
    DirectMessage {
        network: String,
        destination: AccountRef,
        payload_frame: Vec<u8>,
        payload_digest: Vec<u8>,
        payments: Vec<PaymentDraft>,
        unknown: Vec<(u64, CborValue)>,
    },
    DirectoryAttestation {
        statement_frame: Vec<u8>,
        signatures: Vec<SignatureDraft>,
        unknown: Vec<(u64, CborValue)>,
    },
    Checkpoint {
        network: String,
        owner: AccountRef,
        checkpoint_id: Vec<u8>,
        timestamp: Timestamp,
        facts: Vec<FactDraft>,
        sections: Option<Vec<SectionDraft>>,
        unknown: Vec<(u64, CborValue)>,
    },
    Statement {
        network: String,
        subject: AccountRef,
        revision: u64,
        timestamp: Timestamp,
        relays: Vec<RelayDraft>,
        key_transitions: Option<Vec<TransitionDraft>>,
        expiry: Option<Timestamp>,
        recovery: Option<Vec<AccountRef>>,
        schema_version: u32,
        stamp_key: Option<AccountRef>,
        profile_entries: Option<Vec<ProfileEntryDraft>>,
        preview: Option<PreviewDirectoryRoles>,
        unknown: Vec<(u64, CborValue)>,
    },
    Recipient {
        schema_version: u32,
        network: String,
        sender: AccountRef,
        recipient: AccountRef,
        suite: u32,
        nonce: Option<Vec<u8>>,
        ciphertext: Option<Vec<u8>>,
        crypto_box_envelope: Option<Vec<u8>>,
        ephemeral_point: Vec<u8>,
        shared_point: Vec<u8>,
        dleq_proof: Vec<u8>,
        unknown: Vec<(u64, CborValue)>,
    },
    Encrypted {
        network: String,
        message_id: Vec<u8>,
        revision_frame: Vec<u8>,
        content_digest: Vec<u8>,
        unknown: Vec<(u64, CborValue)>,
    },
    TransitionStatement {
        network: String,
        subject: AccountRef,
        prior_authority: AccountRef,
        revision: u64,
        new_key: AccountRef,
        unknown: Vec<(u64, CborValue)>,
    },
    TopicPost {
        network: String,
        topic: String,
        parent_hash: Option<Vec<u8>>,
        body: Vec<u8>,
        unknown: Vec<(u64, CborValue)>,
    },
    TopicPostSubmission {
        network: String,
        post_frame: Vec<u8>,
        burn_tx: Vec<u8>,
        unknown: Vec<(u64, CborValue)>,
    },
    TopicVoteSubmission {
        network: String,
        target_hash: Vec<u8>,
        burn_tx: Vec<u8>,
        unknown: Vec<(u64, CborValue)>,
    },
    Revision {
        items: Vec<Vec<u8>>,
        unknown: Vec<(u64, CborValue)>,
    },
    Container {
        items: Vec<Vec<u8>>,
        unknown: Vec<(u64, CborValue)>,
    },
    Text {
        text: String,
        unknown: Vec<(u64, CborValue)>,
    },
}

fn payment_member(v: &CborValue, path: &str) -> Result<PaymentDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2, 3, 4], &[], false, false)?;
    Ok(PaymentDraft {
        child_index: u32_in(map.get(0), &format!("{path}.0"), 0, 2_147_483_647)?,
        transaction_id: bstr(map.get(1), &format!("{path}.1"), 1, 128)?,
        value: bstr(map.get(2), &format!("{path}.2"), 32, 32)?,
        address: bstr(map.get(3), &format!("{path}.3"), 1, 128)?,
        commitment: bstr(map.get(4), &format!("{path}.4"), 32, 32)?,
    })
}

fn signature_entry(v: &CborValue, path: &str) -> Result<SignatureDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2], &[], false, false)?;
    Ok(SignatureDraft {
        algorithm: u32_in(map.get(0), &format!("{path}.0"), 0, 65_535)?,
        signer: account(map.get(1), &format!("{path}.1"))?,
        signature: bstr(map.get(2), &format!("{path}.2"), 1, 512)?,
    })
}

fn relay_binding(
    v: &CborValue,
    path: &str,
    allow: bool,
    preview: bool,
) -> Result<RelayDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2, 3], &[], true, allow)?;
    Ok(RelayDraft {
        relay_id: bstr(map.get(0), &format!("{path}.0"), 16, 64)?,
        endpoint: endpoint(map.get(1), &format!("{path}.1"))?,
        identity: directory_account(map.get(2), &format!("{path}.2"), preview)?,
        expiry: timestamp(map.get(3), &format!("{path}.3"))?,
        unknown: map.unknown,
    })
}

fn key_transition(v: &CborValue, path: &str, allow: bool) -> Result<TransitionDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2, 3], &[], true, allow)?;
    Ok(TransitionDraft {
        statement_frame: framed(map.get(0), &format!("{path}.0"))?,
        algorithm: u32_in(map.get(1), &format!("{path}.1"), 0, 65_535)?,
        signer: account(map.get(2), &format!("{path}.2"))?,
        signature: bstr(map.get(3), &format!("{path}.3"), 1, 512)?,
        unknown: map.unknown,
    })
}

fn journal_fact(v: &CborValue, path: &str, allow: bool) -> Result<FactDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2, 3], &[], true, allow)?;
    Ok(FactDraft {
        timestamp: timestamp(map.get(0), &format!("{path}.0"))?,
        fact_id: bstr(map.get(1), &format!("{path}.1"), 16, 16)?,
        kind: u32_in(map.get(2), &format!("{path}.2"), 0, 65_535)?,
        payload: bstr(map.get(3), &format!("{path}.3"), 0, 8_388_608)?,
        unknown: map.unknown,
    })
}

fn opaque_section(v: &CborValue, path: &str) -> Result<SectionDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2], &[], false, false)?;
    Ok(SectionDraft {
        section_type: u32_in(map.get(0), &format!("{path}.0"), 0, u32::MAX)?,
        section_schema_version: u32_in(map.get(1), &format!("{path}.1"), 1, u32::MAX)?,
        value: bstr(map.get(2), &format!("{path}.2"), 0, 8_388_608)?,
    })
}

/// One profile-entry header (M4): the protobuf name/value set, C11-sorted by name.
fn profile_header(v: &CborValue, path: &str, allow: bool) -> Result<HeaderDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1], &[], true, allow)?;
    Ok(HeaderDraft {
        name: tstr(map.get(0), &format!("{path}.0"), 0, MAX_TEXT_STRING_BYTES)?,
        value: tstr(map.get(1), &format!("{path}.1"), 0, MAX_TEXT_STRING_BYTES)?,
        unknown: map.unknown,
    })
}

/// One migrated AddressEntry (M4). Authored array order is preserved, never resorted.
fn profile_entry(v: &CborValue, path: &str, allow: bool) -> Result<ProfileEntryDraft, CodecError> {
    let map = fields(Some(v), path, &[0, 1, 2], &[], true, allow)?;
    let headers = as_list(map.get(1), &format!("{path}.1"), 0, 64)?;
    let mut parsed_headers = Vec::with_capacity(headers.len());
    for (i, header) in headers.iter().enumerate() {
        parsed_headers.push(profile_header(header, &format!("{path}.1[{i}]"), allow)?);
    }
    Ok(ProfileEntryDraft {
        kind: tstr(map.get(0), &format!("{path}.0"), 0, MAX_TEXT_STRING_BYTES)?,
        headers: parsed_headers,
        body: bstr(map.get(2), &format!("{path}.2"), 0, 8_388_608)?,
        unknown: map.unknown,
    })
}

/// Stage 8.2. Framed fields stay raw bytes until stage 8.4.
pub(crate) fn parse_draft(
    type_id: u32,
    payload: &CborValue,
    allow: bool,
    schema: SchemaVersions,
) -> Result<Draft, CodecError> {
    let path = "root/payload";
    match type_id {
        TYPE_DIRECT_MESSAGE => {
            let map = fields(Some(payload), path, &[0, 1, 2, 3, 4], &[], true, allow)?;
            let payments = as_list(map.get(4), &format!("{path}.4"), 1, MAX_PAYMENT_MEMBERS)?;
            let mut parsed = Vec::with_capacity(payments.len());
            for (i, item) in payments.iter().enumerate() {
                parsed.push(payment_member(item, &format!("{path}.4[{i}]"))?);
            }
            Ok(Draft::DirectMessage {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                destination: account(map.get(1), &format!("{path}.1"))?,
                payload_frame: framed(map.get(2), &format!("{path}.2"))?,
                payload_digest: bstr(map.get(3), &format!("{path}.3"), 32, 32)?,
                payments: parsed,
                unknown: map.unknown,
            })
        }
        TYPE_DIRECTORY_ATTESTATION => {
            let map = fields(Some(payload), path, &[0, 1], &[], true, allow)?;
            let sigs = as_list(map.get(1), &format!("{path}.1"), 1, MAX_SIGNATURES)?;
            let mut parsed = Vec::with_capacity(sigs.len());
            for (i, item) in sigs.iter().enumerate() {
                parsed.push(signature_entry(item, &format!("{path}.1[{i}]"))?);
            }
            Ok(Draft::DirectoryAttestation {
                statement_frame: framed(map.get(0), &format!("{path}.0"))?,
                signatures: parsed,
                unknown: map.unknown,
            })
        }
        TYPE_MAILBOX_CHECKPOINT => {
            let map = fields(Some(payload), path, &[0, 1, 2, 3, 4], &[5], true, allow)?;
            let facts = as_list(map.get(4), &format!("{path}.4"), 0, MAX_JOURNAL_FACTS)?;
            let mut parsed_facts = Vec::with_capacity(facts.len());
            for (i, item) in facts.iter().enumerate() {
                parsed_facts.push(journal_fact(item, &format!("{path}.4[{i}]"), allow)?);
            }
            let sections = if map.has(5) {
                let items = as_list(map.get(5), &format!("{path}.5"), 0, MAX_OPAQUE_SECTIONS)?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(opaque_section(item, &format!("{path}.5[{i}]"))?);
                }
                Some(parsed)
            } else {
                None
            };
            Ok(Draft::Checkpoint {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                owner: account(map.get(1), &format!("{path}.1"))?,
                checkpoint_id: bstr(map.get(2), &format!("{path}.2"), 16, 16)?,
                timestamp: timestamp(map.get(3), &format!("{path}.3"))?,
                facts: parsed_facts,
                sections,
                unknown: map.unknown,
            })
        }
        TYPE_DIRECTORY_STATEMENT => {
            // Fields 5-7 are optional at every schema; field 8 (the stamp key) is required from
            // schema 2 and undefined in schema 1, where C12 makes it a schema error (S10a.1);
            // field 9 (the profile entries, M4) is optional from schema 3, where a schema-2
            // reader reads the statement through V6.3 and retains it. `effective` is the exact
            // version, or the reader's highest supported schema when the frame is newer (V6.3).
            let optional: &[u64] = if schema.effective >= 3 {
                &[5, 6, 7, 9]
            } else {
                &[5, 6, 7]
            };
            let preview = schema.effective >= 4;
            let optional = if preview { &[][..] } else { optional };
            let required: &[u64] = if preview {
                &[0, 1, 2, 3, 4, 6, 8, 10, 11, 12, 13]
            } else if schema.effective >= 2 {
                &[0, 1, 2, 3, 4, 8]
            } else {
                &[0, 1, 2, 3, 4]
            };
            let map = fields(Some(payload), path, required, optional, true, allow)?;
            if preview && [5, 7, 9].iter().any(|k| map.has(*k)) {
                return Err(bad(
                    path,
                    "transitions, recovery and profiles are unsupported in directory preview",
                ));
            }
            let relays = as_list(
                map.get(4),
                &format!("{path}.4"),
                1,
                if preview { 1 } else { MAX_RELAY_BINDINGS },
            )?;
            let mut parsed_relays = Vec::with_capacity(relays.len());
            for (i, item) in relays.iter().enumerate() {
                parsed_relays.push(relay_binding(
                    item,
                    &format!("{path}.4[{i}]"),
                    allow,
                    preview,
                )?);
            }
            let key_transitions = if map.has(5) {
                let items = as_list(map.get(5), &format!("{path}.5"), 1, 16)?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(key_transition(item, &format!("{path}.5[{i}]"), allow)?);
                }
                Some(parsed)
            } else {
                None
            };
            let expiry = if map.has(6) {
                Some(timestamp(map.get(6), &format!("{path}.6"))?)
            } else {
                None
            };
            let recovery = if map.has(7) {
                let items = as_list(map.get(7), &format!("{path}.7"), 1, 8)?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(account(Some(item), &format!("{path}.7[{i}]"))?);
                }
                Some(parsed)
            } else {
                None
            };
            Ok(Draft::Statement {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                subject: directory_account(map.get(1), &format!("{path}.1"), preview)?,
                revision: u64_in(map.get(2), &format!("{path}.2"), 0, u64::MAX)?,
                timestamp: timestamp(map.get(3), &format!("{path}.3"))?,
                relays: parsed_relays,
                key_transitions,
                expiry,
                recovery,
                schema_version: schema.envelope,
                preview: if preview {
                    Some(PreviewDirectoryRoles {
                        message_dh_key: directory_account(
                            map.get(10),
                            &format!("{path}.10"),
                            true,
                        )?,
                        mailbox_key_generation: u64_in(
                            map.get(11),
                            &format!("{path}.11"),
                            0,
                            u64::MAX,
                        )?,
                        stamp_key_generation: u64_in(
                            map.get(12),
                            &format!("{path}.12"),
                            0,
                            u64::MAX,
                        )?,
                        predecessor: if matches!(map.get(13), Some(CborValue::Null)) {
                            None
                        } else {
                            Some(bstr(map.get(13), &format!("{path}.13"), 32, 32)?)
                        },
                    })
                } else {
                    None
                },
                stamp_key: if map.has(8) {
                    Some(directory_account(
                        map.get(8),
                        &format!("{path}.8"),
                        preview,
                    )?)
                } else {
                    None
                },
                profile_entries: if map.has(9) && schema.effective >= 3 {
                    let items = as_list(map.get(9), &format!("{path}.9"), 1, 64)?;
                    let mut parsed = Vec::with_capacity(items.len());
                    for (i, item) in items.iter().enumerate() {
                        parsed.push(profile_entry(item, &format!("{path}.9[{i}]"), allow)?);
                    }
                    Some(parsed)
                } else {
                    None
                },
                unknown: map.unknown,
            })
        }
        TYPE_RECIPIENT_PAYLOAD => {
            if schema.effective >= 2 {
                let map = fields(
                    Some(payload),
                    path,
                    &[0, 1, 2, 3, 4, 5, 6, 7],
                    &[],
                    true,
                    allow,
                )?;
                Ok(Draft::Recipient {
                    schema_version: 2,
                    network: network_tag(map.get(0), &format!("{path}.0"))?,
                    sender: account(map.get(1), &format!("{path}.1"))?,
                    recipient: account(map.get(2), &format!("{path}.2"))?,
                    suite: u32_in(map.get(3), &format!("{path}.3"), 0, 65_535)?,
                    nonce: None,
                    ciphertext: None,
                    crypto_box_envelope: Some(bstr(
                        map.get(4),
                        &format!("{path}.4"),
                        1,
                        MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
                    )?),
                    ephemeral_point: point(map.get(5), &format!("{path}.5"))?,
                    shared_point: point(map.get(6), &format!("{path}.6"))?,
                    dleq_proof: proof(map.get(7), &format!("{path}.7"))?,
                    unknown: map.unknown,
                })
            } else {
                let map = fields(
                    Some(payload),
                    path,
                    &[0, 1, 2, 3, 4, 5, 6, 7, 8],
                    &[],
                    true,
                    allow,
                )?;
                Ok(Draft::Recipient {
                    schema_version: 1,
                    network: network_tag(map.get(0), &format!("{path}.0"))?,
                    sender: account(map.get(1), &format!("{path}.1"))?,
                    recipient: account(map.get(2), &format!("{path}.2"))?,
                    suite: u32_in(map.get(3), &format!("{path}.3"), 0, 65_535)?,
                    nonce: Some(bstr(map.get(4), &format!("{path}.4"), 1, 64)?),
                    ciphertext: Some(bstr(
                        map.get(5),
                        &format!("{path}.5"),
                        1,
                        MAX_CIPHERTEXT_BYTES,
                    )?),
                    crypto_box_envelope: None,
                    ephemeral_point: point(map.get(6), &format!("{path}.6"))?,
                    shared_point: point(map.get(7), &format!("{path}.7"))?,
                    dleq_proof: proof(map.get(8), &format!("{path}.8"))?,
                    unknown: map.unknown,
                })
            }
        }
        crate::limits::TYPE_ENCRYPTED_CONTENT => {
            let map = fields(Some(payload), path, &[0, 1, 2, 3], &[], true, allow)?;
            Ok(Draft::Encrypted {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                message_id: bstr(map.get(1), &format!("{path}.1"), 16, 16)?,
                revision_frame: framed(map.get(2), &format!("{path}.2"))?,
                content_digest: bstr(map.get(3), &format!("{path}.3"), 32, 32)?,
                unknown: map.unknown,
            })
        }
        crate::limits::TYPE_KEY_TRANSITION_STATEMENT => {
            let map = fields(Some(payload), path, &[0, 1, 2, 3, 4], &[], true, allow)?;
            Ok(Draft::TransitionStatement {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                subject: account(map.get(1), &format!("{path}.1"))?,
                prior_authority: account(map.get(2), &format!("{path}.2"))?,
                revision: u64_in(map.get(3), &format!("{path}.3"), 1, u64::MAX)?,
                new_key: account(map.get(4), &format!("{path}.4"))?,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_POST => {
            let map = fields(Some(payload), path, &[0, 1, 3], &[2], true, allow)?;
            let parent_hash = if map.has(2) {
                Some(bstr(map.get(2), &format!("{path}.2"), 32, 32)?)
            } else {
                None
            };
            Ok(Draft::TopicPost {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                topic: tstr(map.get(1), &format!("{path}.1"), 1, 512)?,
                parent_hash,
                body: bstr(map.get(3), &format!("{path}.3"), 1, MAX_TOPIC_BODY_BYTES)?,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_POST_SUBMISSION => {
            let map = fields(Some(payload), path, &[0, 1, 2], &[], true, allow)?;
            Ok(Draft::TopicPostSubmission {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                post_frame: framed(map.get(1), &format!("{path}.1"))?,
                burn_tx: bstr(map.get(2), &format!("{path}.2"), 1, 16_384)?,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_VOTE_SUBMISSION => {
            let map = fields(Some(payload), path, &[0, 1, 2], &[], true, allow)?;
            Ok(Draft::TopicVoteSubmission {
                network: network_tag(map.get(0), &format!("{path}.0"))?,
                target_hash: bstr(map.get(1), &format!("{path}.1"), 32, 32)?,
                burn_tx: bstr(map.get(2), &format!("{path}.2"), 1, 16_384)?,
                unknown: map.unknown,
            })
        }
        TYPE_MESSAGE_REVISION => {
            let map = fields(Some(payload), path, &[0, 1], &[], true, allow)?;
            if map.get(0) != Some(&CborValue::Text("frank".to_string())) {
                return Err(bad(
                    &format!("{path}.0"),
                    "the type-8 domain must be the text \"frank\"",
                ));
            }
            let items = as_list(
                map.get(1),
                &format!("{path}.1"),
                1,
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            )?;
            let mut parsed = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                parsed.push(framed(Some(item), &format!("{path}.1[{i}]"))?);
            }
            Ok(Draft::Revision {
                items: parsed,
                unknown: map.unknown,
            })
        }
        TYPE_CONTAINER_ITEM => {
            let map = fields(Some(payload), path, &[0], &[], true, allow)?;
            let items = as_list(
                map.get(0),
                &format!("{path}.0"),
                1,
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            )?;
            let mut parsed = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                parsed.push(framed(Some(item), &format!("{path}.0[{i}]"))?);
            }
            Ok(Draft::Container {
                items: parsed,
                unknown: map.unknown,
            })
        }
        crate::limits::TYPE_TEXT_ITEM => {
            let map = fields(Some(payload), path, &[0], &[], true, allow)?;
            Ok(Draft::Text {
                text: tstr(map.get(0), &format!("{path}.0"), 0, 262_144)?,
                unknown: map.unknown,
            })
        }
        _ => unreachable!("parse_draft called for a type with no schema"),
    }
}

fn check_key_type(account: &AccountRef, path: &str) -> Result<(), CodecError> {
    if !matches!(account.key_type, 1..=3) {
        return Err(unsupported(
            path,
            format!("unallocated key type {} (S2)", account.key_type),
        ));
    }
    Ok(())
}

fn check_signature_shape(
    algorithm: u32,
    signer: &AccountRef,
    signature: &[u8],
    path: &str,
) -> Result<(), CodecError> {
    let (key_type, ok) = match algorithm {
        1 => (1, (8..=72).contains(&signature.len())),
        2 => (3, signature.len() == 64),
        3 => (1, signature.len() == 64),
        16 => (2, signature.len() == 64),
        _ => {
            return Err(unsupported(
                path,
                format!("unallocated signature algorithm {algorithm} (S2a)"),
            ))
        }
    };
    if signer.key_type != key_type || !ok {
        return Err(unsupported(
            path,
            "algorithm/key-type/length combination is not allocated (S2b)",
        ));
    }
    Ok(())
}

/// Stage 8.3. Uses only the draft, before children are opened.
pub(crate) fn check_allocated(draft: &Draft) -> Result<(), CodecError> {
    let path = "root/payload";
    match draft {
        Draft::DirectMessage { destination, .. } => {
            check_key_type(destination, &format!("{path}.1"))
        }
        Draft::DirectoryAttestation { signatures, .. } => {
            for (i, sig) in signatures.iter().enumerate() {
                check_key_type(&sig.signer, &format!("{path}.1[{i}].1"))?;
                check_signature_shape(
                    sig.algorithm,
                    &sig.signer,
                    &sig.signature,
                    &format!("{path}.1[{i}]"),
                )?;
            }
            Ok(())
        }
        Draft::Checkpoint { owner, .. } => check_key_type(owner, &format!("{path}.1")),
        Draft::Statement {
            subject,
            relays,
            key_transitions,
            recovery,
            stamp_key,
            preview,
            ..
        } => {
            check_key_type(subject, &format!("{path}.1"))?;
            for (i, relay) in relays.iter().enumerate() {
                check_key_type(&relay.identity, &format!("{path}.4[{i}].2"))?;
            }
            if let Some(key) = stamp_key {
                check_key_type(key, &format!("{path}.8"))?;
            }
            if let Some(roles) = preview {
                check_key_type(&roles.message_dh_key, &format!("{path}.10"))?;
            }
            if let Some(transitions) = key_transitions {
                for (i, transition) in transitions.iter().enumerate() {
                    check_key_type(&transition.signer, &format!("{path}.5[{i}].2"))?;
                    check_signature_shape(
                        transition.algorithm,
                        &transition.signer,
                        &transition.signature,
                        &format!("{path}.5[{i}]"),
                    )?;
                }
            }
            if let Some(authorities) = recovery {
                for (i, authority) in authorities.iter().enumerate() {
                    check_key_type(authority, &format!("{path}.7[{i}]"))?;
                }
            }
            Ok(())
        }
        Draft::Recipient {
            sender,
            recipient,
            suite,
            schema_version,
            ..
        } => {
            check_key_type(sender, &format!("{path}.1"))?;
            check_key_type(recipient, &format!("{path}.2"))?;
            if (*schema_version == 1 && *suite != ENCRYPTION_SUITE_PROOF)
                || (*schema_version == 2 && *suite != ENCRYPTION_SUITE_DM_AUTH_XCHACHA)
            {
                return Err(unsupported(
                    &format!("{path}.3"),
                    format!("encryption suite {suite} is unallocated (S2c)"),
                ));
            }
            Ok(())
        }
        Draft::TransitionStatement {
            subject,
            prior_authority,
            new_key,
            ..
        } => {
            check_key_type(subject, &format!("{path}.1"))?;
            check_key_type(prior_authority, &format!("{path}.2"))?;
            check_key_type(new_key, &format!("{path}.4"))?;
            Ok(())
        }
        Draft::Encrypted { .. }
        | Draft::TopicPost { .. }
        | Draft::TopicPostSubmission { .. }
        | Draft::TopicVoteSubmission { .. }
        | Draft::Revision { .. }
        | Draft::Container { .. }
        | Draft::Text { .. } => Ok(()),
    }
}
