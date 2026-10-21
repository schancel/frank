//! Stages 8.1 (type limits), 8.2 (CDDL), and 8.3 (allocated identifiers).

use crate::cbor::CborValue;
use crate::error::{CodecError, ErrorCategory, ErrorStage};
use crate::limits::{
    ENCRYPTION_SUITE_DM_AUTH_XCHACHA, ENCRYPTION_SUITE_PROOF, MAX_CIPHERTEXT_BYTES,
    MAX_DIRECTORY_ATTESTATION_FRAME_BYTES, MAX_DIRECT_MESSAGE_FRAME_BYTES,
    MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES, MAX_FORWARDING_DELIVERY_FRAME_BYTES, MAX_FRAME_BYTES,
    MAX_JOURNAL_FACTS, MAX_MESSAGE_ITEMS_PER_ARRAY, MAX_OPAQUE_SECTIONS, MAX_PAYMENT_MEMBERS,
    MAX_RELAY_BINDINGS, MAX_SIGNATURES, MAX_TEXT_STRING_BYTES, MAX_TOPIC_BODY_BYTES,
    MAX_TOPIC_FRAME_BYTES, MAX_TOPIC_VOTE_FRAME_BYTES,
};
use crate::limits::{
    MAX_FORUM_CURSOR_BYTES, MAX_FORUM_ENTRIES, MAX_FORUM_PAGE_BYTES, MAX_FORUM_ROWS,
    MAX_FORUM_VIEW_BYTES,
};
use crate::message_fields as mf;
use crate::message_fields::{account_type, bot_role, key_type, MapShape};
use crate::message_types::{
    TYPE_BLACKJACK_MESSAGE_ITEM, TYPE_ENCRYPTED_MESSAGE_CONTENT, TYPE_KEY_TRANSITION_STATEMENT,
    TYPE_STEALTH_MESSAGE_ITEM, TYPE_TEXT_MESSAGE_ITEM,
};
use crate::message_types::{
    TYPE_CONTAINER_MESSAGE_ITEM, TYPE_DIRECTORY_ATTESTATION, TYPE_DIRECTORY_STATEMENT,
    TYPE_DIRECT_MESSAGE_DELIVERY, TYPE_FORWARDING_DELIVERY_ENVELOPE, TYPE_MAILBOX_CHECKPOINT,
    TYPE_MESSAGE_CONTENT_REVISION, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, TYPE_TOPIC_POST,
    TYPE_TOPIC_POST_SUBMISSION, TYPE_TOPIC_VOTE_SUBMISSION,
};
use crate::message_types::{
    TYPE_FORUM_DISCOVERY_PAGE, TYPE_FORUM_OPERATION_STATUS, TYPE_FORUM_TOPIC_PAGE, TYPE_FORUM_VIEW,
};
use crate::model::{
    AccountRef, BlackjackAction, BlackjackFields, BlackjackHandAction, BlackjackHandFields,
    BlackjackHandMessageItem, BlackjackHandV3Action, BlackjackHandV3Fields,
    BlackjackHandV3MessageItem, BlackjackHandV3Move, BlackjackMessageItem, BlackjackOutcome,
    NativeStealthItem, PaymentValue, PreviewDirectoryRoles, StealthPaymentEntry,
    StealthPaymentItem, StealthQuantity, StealthTransfer, Timestamp, TopicPostAuthor,
};
use crate::model::{
    ForumAggregate, ForumContent, ForumCursor, ForumCursorPosition, ForumDiscoveryEntry,
    ForumDiscoveryPage, ForumEntry, ForumOperationEvidence, ForumOperationStatus, ForumTopicPage,
    ForumView,
};

/// The schema versions a type-4 parse needs: the envelope's (kept for S10a.2) and the effective
/// one, the envelope's or the reader's highest supported when the frame is newer (V6.3).
#[derive(Clone, Copy)]
pub(crate) struct SchemaVersions {
    pub envelope: u32,
    pub effective: u32,
    /// The envelope's min reader version; a type-18 hand shape is read only when it is >= 2.
    pub min_reader: u32,
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

fn conversation_name(v: Option<&CborValue>, path: &str) -> Result<String, CodecError> {
    let s = tstr(v, path, 1, 512)?;
    if s.trim().is_empty() {
        return Err(bad(path, "conversation name cannot be whitespace-only"));
    }
    if s.chars().any(|c| {
        let u = c as u32;
        (u <= 0x1f) || (0x7f..=0x9f).contains(&u) || u == 0x2028 || u == 0x2029
    }) {
        return Err(bad(
            path,
            "conversation name contains forbidden control character",
        ));
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

/// Error path of field `key` inside the map at `path` (README error locations).
pub(crate) fn at(path: &str, key: u64) -> String {
    format!("{path}.{key}")
}

/// Error path of element `i` of the array in field `key` of the map at `path`.
pub(crate) fn at_index(path: &str, key: u64, i: usize) -> String {
    format!("{}[{i}]", at(path, key))
}

/// Read a map through its registered shape (`docs/protocol/message-types/fields/`).
pub(crate) fn shaped<'a>(
    v: Option<&'a CborValue>,
    path: &str,
    shape: &MapShape,
    allow_unknown: bool,
) -> Result<MapFields<'a>, CodecError> {
    fields(
        v,
        path,
        shape.required,
        shape.optional,
        shape.open,
        allow_unknown,
    )
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
        key_type::SECP256K1 => Some(33),
        key_type::ED25519 | key_type::SECP256K1_X_ONLY => Some(32),
        _ => None,
    }
}

fn account(v: Option<&CborValue>, path: &str) -> Result<AccountRef, CodecError> {
    use mf::account_ref as k;
    let map = shaped(v, path, &k::SHAPE, false)?;
    let key_type = u32_in(map.get(k::KEY_TYPE), &at(path, k::KEY_TYPE), 0, 65_535)?;
    let key_bytes = bstr(map.get(k::KEY_BYTES), &at(path, k::KEY_BYTES), 1, 128)?;
    if let Some(expected) = key_length(key_type) {
        if key_bytes.len() != expected {
            return Err(bad(
                &at(path, k::KEY_BYTES),
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
    if preview && key.key_type != key_type::SECP256K1 {
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
    use mf::timestamp as k;
    let map = shaped(v, path, &k::SHAPE, false)?;
    let seconds = match map.get(k::SECONDS) {
        Some(CborValue::Int(n)) if *n >= i128::from(i64::MIN) && *n <= i128::from(i64::MAX) => {
            *n as i64
        }
        _ => return Err(bad(&at(path, k::SECONDS), "seconds must be an i64")),
    };
    let nanoseconds = u32_in(
        map.get(k::NANOSECONDS),
        &at(path, k::NANOSECONDS),
        0,
        999_999_999,
    )?;
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
    if type_id == TYPE_BLACKJACK_MESSAGE_ITEM {
        return frame_length <= crate::limits::MAX_BLACKJACK_FRAME_BYTES;
    }
    if type_id == TYPE_DIRECTORY_STATEMENT && schema_version >= 4 {
        return frame_length <= MAX_DIRECTORY_ATTESTATION_FRAME_BYTES;
    }
    if type_id == TYPE_DIRECT_MESSAGE_DELIVERY {
        return frame_length <= MAX_DIRECT_MESSAGE_FRAME_BYTES;
    }
    if type_id == TYPE_FORWARDING_DELIVERY_ENVELOPE {
        return frame_length <= MAX_FORWARDING_DELIVERY_FRAME_BYTES;
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
    if type_id == TYPE_FORUM_VIEW || type_id == TYPE_FORUM_OPERATION_STATUS {
        return frame_length <= MAX_FORUM_VIEW_BYTES;
    }
    if type_id == TYPE_FORUM_TOPIC_PAGE || type_id == TYPE_FORUM_DISCOVERY_PAGE {
        return frame_length <= MAX_FORUM_PAGE_BYTES;
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
        TYPE_DIRECT_MESSAGE_DELIVERY | TYPE_FORWARDING_DELIVERY_ENVELOPE => {
            // Both types carry their payment members in field 4.
            const _: () = assert!(
                mf::direct_message_delivery::PAYMENTS == mf::forwarding_delivery_envelope::PAYMENTS
            );
            if too_many(
                map_field(payload, mf::direct_message_delivery::PAYMENTS),
                MAX_PAYMENT_MEMBERS,
            ) {
                return Err(over("payment members"));
            }
        }
        TYPE_DIRECTORY_ATTESTATION => {
            if too_many(
                map_field(payload, mf::directory_attestation::SIGNATURES),
                MAX_SIGNATURES,
            ) {
                return Err(over("signatures"));
            }
        }
        TYPE_MAILBOX_CHECKPOINT => {
            if too_many(
                map_field(payload, mf::mailbox_checkpoint::FACTS),
                MAX_JOURNAL_FACTS,
            ) {
                return Err(over("journal facts"));
            }
            if too_many(
                map_field(payload, mf::mailbox_checkpoint::SECTIONS),
                MAX_OPAQUE_SECTIONS,
            ) {
                return Err(over("opaque sections"));
            }
        }
        TYPE_DIRECTORY_STATEMENT => {
            if too_many(
                map_field(payload, mf::directory_statement::RELAYS),
                MAX_RELAY_BINDINGS,
            ) {
                return Err(over("relay bindings"));
            }
        }
        TYPE_RECIPIENT_ENCRYPTED_PAYLOAD => {
            if schema_version >= 2 {
                if let Some(CborValue::Bytes(bytes)) = map_field(
                    payload,
                    mf::recipient_encrypted_payload_v2::CRYPTO_BOX_ENVELOPE,
                ) {
                    if bytes.len() > MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES {
                        return Err(over("crypto-box envelope"));
                    }
                }
            } else if let Some(CborValue::Bytes(bytes)) =
                map_field(payload, mf::recipient_encrypted_payload_v1::CIPHERTEXT)
            {
                if bytes.len() > MAX_CIPHERTEXT_BYTES {
                    return Err(over("ciphertext"));
                }
            }
        }
        TYPE_TOPIC_POST => {
            if let Some(CborValue::Bytes(bytes)) = map_field(payload, mf::topic_post::BODY) {
                if bytes.len() > MAX_TOPIC_BODY_BYTES {
                    return Err(over("topic body"));
                }
            }
        }
        TYPE_FORUM_TOPIC_PAGE | TYPE_FORUM_DISCOVERY_PAGE => {
            let (rows, cursors) = if type_id == TYPE_FORUM_TOPIC_PAGE {
                use mf::forum_topic_page as k;
                (k::ROWS, [k::NEXT_CURSOR, k::REQUEST_CURSOR])
            } else {
                use mf::forum_discovery_page as k;
                (k::ENTRIES, [k::NEXT_CURSOR, k::REQUEST_CURSOR])
            };
            if too_many(map_field(payload, rows), MAX_FORUM_ROWS) {
                return Err(over("Forum rows"));
            }
            for key in cursors {
                if let Some(CborValue::Bytes(bytes)) = map_field(payload, key) {
                    if bytes.len() > MAX_FORUM_CURSOR_BYTES {
                        return Err(over("Forum cursor"));
                    }
                }
            }
        }
        TYPE_MESSAGE_CONTENT_REVISION => {
            if too_many(
                map_field(payload, mf::message_content_revision::ITEMS),
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            ) {
                return Err(over("message items"));
            }
        }
        TYPE_CONTAINER_MESSAGE_ITEM => {
            if too_many(
                map_field(payload, mf::container_message_item::ITEMS),
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            ) {
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
    pub value: PaymentValue,
    pub address: Vec<u8>,
    pub commitment: Vec<u8>,
    pub vout: Option<u32>,
    pub raw_tx: Option<Vec<u8>>,
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
    ForwardingDelivery {
        network: String,
        destination: AccountRef,
        payload_frame: Vec<u8>,
        payload_digest: Vec<u8>,
        payments: Vec<PaymentDraft>,
        endpoint: Option<String>,
        expires_at: Option<u64>,
        unknown: Vec<(u64, CborValue)>,
    },
    DirectMessage {
        network: String,
        destination: AccountRef,
        payload_frame: Vec<u8>,
        payload_digest: Vec<u8>,
        payments: Vec<PaymentDraft>,
        recipient: Option<AccountRef>,
        dleq_proof: Option<Vec<u8>>,
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
        canonical_username: Option<String>,
        account_type: Option<crate::model::AccountType>,
        bot_role: Option<crate::model::BotRole>,
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
        conversation_id: Option<Vec<u8>>,
        conversation_name: Option<String>,
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
        from: Option<TopicPostAuthor>,
        signature: Option<Vec<u8>>,
        structured: bool,
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
    ForumView(ForumView<Vec<u8>>),
    ForumTopicPage(ForumTopicPage<Vec<u8>, Vec<u8>>),
    ForumDiscoveryPage(ForumDiscoveryPage<Vec<u8>>),
    ForumOperationStatus(ForumOperationStatus<Vec<u8>>),
    Revision {
        items: Vec<Vec<u8>>,
        unknown: Vec<(u64, CborValue)>,
    },
    Container {
        items: Vec<Vec<u8>>,
        unknown: Vec<(u64, CborValue)>,
    },
    Blackjack(BlackjackMessageItem),
    BlackjackHand(BlackjackHandMessageItem),
    BlackjackHandV3(BlackjackHandV3MessageItem),
    NativeStealth(NativeStealthItem),
    StealthPayment(StealthPaymentItem),
    Text {
        text: String,
        unknown: Vec<(u64, CborValue)>,
    },
}

fn payment_member(v: &CborValue, path: &str) -> Result<PaymentDraft, CodecError> {
    use mf::payment_member as k;
    let map = shaped(Some(v), path, &k::SHAPE, false)?;
    let val_item = map
        .get(k::VALUE)
        .ok_or_else(|| bad(&at(path, k::VALUE), "missing value"))?;
    let value = match val_item {
        CborValue::Bytes(b) => {
            if b.len() != 32 {
                return Err(bad(&at(path, k::VALUE), "expected 32 bytes"));
            }
            PaymentValue::Quantity(b.clone())
        }
        CborValue::Int(n) => {
            if *n < 0 || *n > u64::MAX as i128 {
                return Err(bad(&at(path, k::VALUE), "expected satoshis in 0..u64::MAX"));
            }
            PaymentValue::Satoshis(*n as u64)
        }
        _ => {
            return Err(bad(
                &at(path, k::VALUE),
                "expected a 32-byte string or an unsigned integer",
            ))
        }
    };
    let vout = if map.has(k::VOUT) {
        Some(u32_in(map.get(k::VOUT), &at(path, k::VOUT), 0, u32::MAX)?)
    } else {
        None
    };
    let raw_tx = if map.has(k::RAW_TX) {
        Some(bstr(map.get(k::RAW_TX), &at(path, k::RAW_TX), 1, 16384)?)
    } else {
        None
    };
    Ok(PaymentDraft {
        child_index: u32_in(
            map.get(k::CHILD_INDEX),
            &at(path, k::CHILD_INDEX),
            0,
            2_147_483_647,
        )?,
        transaction_id: bstr(
            map.get(k::TRANSACTION_ID),
            &at(path, k::TRANSACTION_ID),
            1,
            128,
        )?,
        value,
        address: bstr(map.get(k::ADDRESS), &at(path, k::ADDRESS), 1, 128)?,
        commitment: bstr(map.get(k::COMMITMENT), &at(path, k::COMMITMENT), 32, 32)?,
        vout,
        raw_tx,
    })
}

fn signature_entry(v: &CborValue, path: &str) -> Result<SignatureDraft, CodecError> {
    use mf::signature_entry as k;
    let map = shaped(Some(v), path, &k::SHAPE, false)?;
    Ok(SignatureDraft {
        algorithm: u32_in(map.get(k::ALGORITHM), &at(path, k::ALGORITHM), 0, 65_535)?,
        signer: account(map.get(k::SIGNER), &at(path, k::SIGNER))?,
        signature: bstr(map.get(k::SIGNATURE), &at(path, k::SIGNATURE), 1, 512)?,
    })
}

fn relay_binding(
    v: &CborValue,
    path: &str,
    allow: bool,
    preview: bool,
) -> Result<RelayDraft, CodecError> {
    use mf::relay_binding as k;
    let map = shaped(Some(v), path, &k::SHAPE, allow)?;
    Ok(RelayDraft {
        relay_id: bstr(map.get(k::RELAY_ID), &at(path, k::RELAY_ID), 16, 64)?,
        endpoint: endpoint(map.get(k::ENDPOINT), &at(path, k::ENDPOINT))?,
        identity: directory_account(map.get(k::IDENTITY), &at(path, k::IDENTITY), preview)?,
        expiry: timestamp(map.get(k::EXPIRY), &at(path, k::EXPIRY))?,
        unknown: map.unknown,
    })
}

fn key_transition(v: &CborValue, path: &str, allow: bool) -> Result<TransitionDraft, CodecError> {
    use mf::key_transition as k;
    let map = shaped(Some(v), path, &k::SHAPE, allow)?;
    Ok(TransitionDraft {
        statement_frame: framed(map.get(k::STATEMENT_FRAME), &at(path, k::STATEMENT_FRAME))?,
        algorithm: u32_in(map.get(k::ALGORITHM), &at(path, k::ALGORITHM), 0, 65_535)?,
        signer: account(map.get(k::SIGNER), &at(path, k::SIGNER))?,
        signature: bstr(map.get(k::SIGNATURE), &at(path, k::SIGNATURE), 1, 512)?,
        unknown: map.unknown,
    })
}

fn journal_fact(v: &CborValue, path: &str, allow: bool) -> Result<FactDraft, CodecError> {
    use mf::journal_fact as k;
    let map = shaped(Some(v), path, &k::SHAPE, allow)?;
    Ok(FactDraft {
        timestamp: timestamp(map.get(k::TIMESTAMP), &at(path, k::TIMESTAMP))?,
        fact_id: bstr(map.get(k::FACT_ID), &at(path, k::FACT_ID), 16, 16)?,
        kind: u32_in(map.get(k::KIND), &at(path, k::KIND), 0, 65_535)?,
        payload: bstr(map.get(k::PAYLOAD), &at(path, k::PAYLOAD), 0, 8_388_608)?,
        unknown: map.unknown,
    })
}

fn opaque_section(v: &CborValue, path: &str) -> Result<SectionDraft, CodecError> {
    use mf::opaque_section as k;
    let map = shaped(Some(v), path, &k::SHAPE, false)?;
    Ok(SectionDraft {
        section_type: u32_in(
            map.get(k::SECTION_TYPE),
            &at(path, k::SECTION_TYPE),
            0,
            u32::MAX,
        )?,
        section_schema_version: u32_in(
            map.get(k::SECTION_SCHEMA_VERSION),
            &at(path, k::SECTION_SCHEMA_VERSION),
            1,
            u32::MAX,
        )?,
        value: bstr(map.get(k::VALUE), &at(path, k::VALUE), 0, 8_388_608)?,
    })
}

/// One profile-entry header (M4): the protobuf name/value set, C11-sorted by name.
fn profile_header(v: &CborValue, path: &str, allow: bool) -> Result<HeaderDraft, CodecError> {
    use mf::profile_header as k;
    let map = shaped(Some(v), path, &k::SHAPE, allow)?;
    Ok(HeaderDraft {
        name: tstr(
            map.get(k::NAME),
            &at(path, k::NAME),
            0,
            MAX_TEXT_STRING_BYTES,
        )?,
        value: tstr(
            map.get(k::VALUE),
            &at(path, k::VALUE),
            0,
            MAX_TEXT_STRING_BYTES,
        )?,
        unknown: map.unknown,
    })
}

/// One migrated AddressEntry (M4). Authored array order is preserved, never resorted.
fn profile_entry(v: &CborValue, path: &str, allow: bool) -> Result<ProfileEntryDraft, CodecError> {
    use mf::profile_entry as k;
    let map = shaped(Some(v), path, &k::SHAPE, allow)?;
    let headers = as_list(map.get(k::HEADERS), &at(path, k::HEADERS), 0, 64)?;
    let mut parsed_headers = Vec::with_capacity(headers.len());
    for (i, header) in headers.iter().enumerate() {
        parsed_headers.push(profile_header(
            header,
            &format!("{}[{i}]", at(path, k::HEADERS)),
            allow,
        )?);
    }
    Ok(ProfileEntryDraft {
        kind: tstr(
            map.get(k::KIND),
            &at(path, k::KIND),
            0,
            MAX_TEXT_STRING_BYTES,
        )?,
        headers: parsed_headers,
        body: bstr(map.get(k::BODY), &at(path, k::BODY), 0, 8_388_608)?,
        unknown: map.unknown,
    })
}

/// Stage 8.2. Framed fields stay raw bytes until stage 8.4.
pub(crate) fn parse_forum_content(
    value: &CborValue,
    allow: bool,
    path: &str,
) -> Result<ForumContent, CodecError> {
    use mf::forum_content as k;
    use mf::forum_post_entry as post;
    if too_many(map_field(value, k::ENTRIES), MAX_FORUM_ENTRIES) {
        return Err(fail(
            ErrorCategory::Resource,
            ErrorStage::S81,
            path,
            "Forum content exceeds 64 entries",
        ));
    }
    let m = shaped(Some(value), path, &k::SHAPE, allow)?;
    let mut entries = Vec::new();
    for (i, entry) in as_list(m.get(k::ENTRIES), path, 1, MAX_FORUM_ENTRIES)?
        .iter()
        .enumerate()
    {
        let p = format!("{}[{i}]", at(path, k::ENTRIES));
        let kind = u64_in(map_field(entry, mf::forum_entry::KIND), &p, 0, u64::MAX)?;
        if kind != u64::from(mf::forum_entry_kind::POST) {
            if !allow {
                return Err(bad(&p, "unallocated Forum entry kind"));
            }
            let CborValue::Map(fields) = entry else {
                return Err(bad(&p, "expected entry map"));
            };
            entries.push(ForumEntry::Unsupported {
                kind,
                fields: fields.clone(),
            });
        } else {
            let e = shaped(Some(entry), &p, &post::SHAPE, allow)?;
            let text = |key| {
                if e.has(key) {
                    tstr(e.get(key), &at(&p, key), 0, MAX_TEXT_STRING_BYTES).map(Some)
                } else {
                    Ok(None)
                }
            };
            entries.push(ForumEntry::Post {
                title: text(post::TITLE)?,
                url: text(post::URL)?,
                message: text(post::MESSAGE)?,
                unknown: e.unknown,
            });
        }
    }
    Ok(ForumContent {
        authored: timestamp(m.get(k::AUTHORED), path)?,
        entries,
        unknown: m.unknown,
    })
}

fn forum_aggregate(value: Option<&CborValue>, path: &str) -> Result<ForumAggregate, CodecError> {
    use mf::forum_aggregate as k;
    let m = shaped(value, path, &k::SHAPE, false)?;
    let Some(CborValue::Bool(negative)) = m.get(k::NEGATIVE) else {
        return Err(bad(path, "expected boolean sign"));
    };
    let magnitude: [u8; 32] = bstr(m.get(k::MAGNITUDE), path, 32, 32)?
        .try_into()
        .expect("checked length");
    if *negative && magnitude.iter().all(|b| *b == 0) {
        return Err(bad(path, "negative zero"));
    }
    Ok(ForumAggregate {
        negative: *negative,
        magnitude,
    })
}

pub(crate) fn parse_forum_cursor(
    value: &CborValue,
    bytes: Vec<u8>,
    path: &str,
) -> Result<ForumCursor, CodecError> {
    use mf::forum_discovery_cursor as discovery;
    use mf::forum_topic_cursor as topic;
    // The fields both cursor families share have one key in each.
    const _: () = assert!(
        topic::NETWORK == discovery::NETWORK
            && topic::FAMILY == discovery::FAMILY
            && topic::REVISION == discovery::REVISION
            && topic::EPOCH == discovery::EPOCH
            && topic::INCARNATION == discovery::INCARNATION
    );
    let family = u32_in(
        map_field(value, topic::FAMILY),
        path,
        TYPE_FORUM_TOPIC_PAGE,
        TYPE_FORUM_DISCOVERY_PAGE,
    )?;
    let shape = if family == TYPE_FORUM_TOPIC_PAGE {
        &topic::SHAPE
    } else {
        &discovery::SHAPE
    };
    let m = shaped(Some(value), path, shape, false)?;
    let position = if family == TYPE_FORUM_TOPIC_PAGE {
        use mf::forum_cursor_last as last_k;
        let last = shaped(m.get(topic::LAST), path, &last_k::SHAPE, false)?;
        ForumCursorPosition::Topic {
            topic: tstr(m.get(topic::TOPIC), path, 1, 512)?,
            since: timestamp(m.get(topic::SINCE), path)?,
            timestamp: timestamp(last.get(last_k::TIMESTAMP), path)?,
            hash: bstr(last.get(last_k::HASH), path, 32, 32)?,
        }
    } else {
        ForumCursorPosition::Discovery {
            topic: tstr(m.get(discovery::TOPIC), path, 1, 512)?,
        }
    };
    Ok(ForumCursor {
        bytes,
        network: network_tag(m.get(topic::NETWORK), path)?,
        revision: u64_in(m.get(topic::REVISION), path, 0, u64::MAX)?,
        epoch: bstr(m.get(topic::EPOCH), path, 16, 16)?,
        incarnation: u64_in(m.get(topic::INCARNATION), path, 0, u64::MAX)?,
        position,
    })
}

fn parse_forum_read(
    type_id: u32,
    value: &CborValue,
    allow: bool,
    path: &str,
) -> Result<Draft, CodecError> {
    match type_id {
        TYPE_FORUM_VIEW => {
            use mf::forum_single_view as k;
            let m = shaped(Some(value), path, &k::SHAPE, allow)?;
            Ok(Draft::ForumView(ForumView {
                network: network_tag(m.get(k::NETWORK), path)?,
                post_frame: framed(m.get(k::POST_FRAME), path)?,
                author: bstr(m.get(k::AUTHOR), path, 20, 20)?,
                author_burn_tx: bstr(m.get(k::AUTHOR_BURN_TX), path, 1, 16384)?,
                transaction_hash: bstr(m.get(k::TRANSACTION_HASH), path, 32, 32)?,
                first_visible: timestamp(m.get(k::FIRST_VISIBLE), path)?,
                block: u64_in(m.get(k::BLOCK), path, 0, u64::MAX)?,
                transaction_index: u64_in(m.get(k::TRANSACTION_INDEX), path, 0, u64::MAX)?,
                aggregate: forum_aggregate(m.get(k::AGGREGATE), path)?,
                revision: u64_in(m.get(k::REVISION), path, 0, u64::MAX)?,
                epoch: bstr(m.get(k::EPOCH), path, 16, 16)?,
                unknown: m.unknown,
            }))
        }
        TYPE_FORUM_TOPIC_PAGE => {
            use mf::forum_topic_page as k;
            let m = shaped(Some(value), path, &k::SHAPE, allow)?;
            let rows = as_list(m.get(k::ROWS), path, 0, MAX_FORUM_ROWS)?
                .iter()
                .map(|v| framed(Some(v), path))
                .collect::<Result<Vec<_>, _>>()?;
            let cursor = |key| {
                if m.has(key) {
                    bstr(m.get(key), path, 1, MAX_FORUM_CURSOR_BYTES).map(Some)
                } else {
                    Ok(None)
                }
            };
            Ok(Draft::ForumTopicPage(ForumTopicPage {
                network: network_tag(m.get(k::NETWORK), path)?,
                topic: tstr(m.get(k::TOPIC), path, 1, 512)?,
                since: timestamp(m.get(k::SINCE), path)?,
                revision: u64_in(m.get(k::REVISION), path, 0, u64::MAX)?,
                rows,
                next_cursor: cursor(k::NEXT_CURSOR)?,
                request_cursor: cursor(k::REQUEST_CURSOR)?,
                epoch: bstr(m.get(k::EPOCH), path, 16, 16)?,
                unknown: m.unknown,
            }))
        }
        TYPE_FORUM_DISCOVERY_PAGE => {
            use mf::forum_discovery_entry as entry;
            use mf::forum_discovery_page as k;
            let m = shaped(Some(value), path, &k::SHAPE, allow)?;
            let entries = as_list(m.get(k::ENTRIES), path, 0, MAX_FORUM_ROWS)?
                .iter()
                .map(|v| {
                    let e = shaped(Some(v), path, &entry::SHAPE, allow)?;
                    Ok(ForumDiscoveryEntry {
                        topic: tstr(e.get(entry::TOPIC), path, 1, 512)?,
                        count: u64_in(e.get(entry::COUNT), path, 0, u64::MAX)?,
                        last_activity: timestamp(e.get(entry::LAST_ACTIVITY), path)?,
                        unknown: e.unknown,
                    })
                })
                .collect::<Result<Vec<_>, CodecError>>()?;
            let cursor = |key| {
                if m.has(key) {
                    bstr(m.get(key), path, 1, MAX_FORUM_CURSOR_BYTES).map(Some)
                } else {
                    Ok(None)
                }
            };
            Ok(Draft::ForumDiscoveryPage(ForumDiscoveryPage {
                network: network_tag(m.get(k::NETWORK), path)?,
                revision: u64_in(m.get(k::REVISION), path, 0, u64::MAX)?,
                entries,
                next_cursor: cursor(k::NEXT_CURSOR)?,
                request_cursor: cursor(k::REQUEST_CURSOR)?,
                epoch: bstr(m.get(k::EPOCH), path, 16, 16)?,
                unknown: m.unknown,
            }))
        }
        TYPE_FORUM_OPERATION_STATUS => {
            use mf::forum_operation_state as state_k;
            use mf::forum_operation_status as k;
            use mf::forum_vote_direction as direction;
            let m = shaped(Some(value), path, &k::SHAPE, allow)?;
            let state = u32_in(m.get(k::STATE), path, 0, state_k::REJECTED)?;
            let confirmed = state == state_k::CONFIRMED;
            if m.has(k::BLOCK) != confirmed || m.has(k::TRANSACTION_INDEX) != confirmed {
                return Err(bad(path, "confirmation position iff confirmed"));
            }
            let value = u64_in(m.get(k::VALUE), path, 0, u64::MAX)?;
            if (state == state_k::PENDING || confirmed) && (value == 0 || value > i64::MAX as u64) {
                return Err(bad(path, "observed burn outside 1..i64::MAX"));
            }
            let evidence = match state {
                state_k::UNKNOWN => ForumOperationEvidence::UnknownRequest,
                state_k::PENDING => ForumOperationEvidence::Pending,
                state_k::CONFIRMED => ForumOperationEvidence::Confirmed {
                    block: u64_in(m.get(k::BLOCK), path, 0, u64::MAX)?,
                    transaction_index: u64_in(m.get(k::TRANSACTION_INDEX), path, 0, u64::MAX)?,
                },
                _ => ForumOperationEvidence::RejectedRequest,
            };
            Ok(Draft::ForumOperationStatus(ForumOperationStatus {
                network: network_tag(m.get(k::NETWORK), path)?,
                submitted_frame: framed(m.get(k::SUBMITTED_FRAME), path)?,
                target_hash: bstr(m.get(k::TARGET_HASH), path, 32, 32)?,
                transaction_hash: bstr(m.get(k::TRANSACTION_HASH), path, 32, 32)?,
                sender: bstr(m.get(k::SENDER), path, 20, 20)?,
                direction: u32_in(m.get(k::DIRECTION), path, direction::DOWN, direction::UP)? as u8,
                value,
                evidence,
                revision: u64_in(m.get(k::REVISION), path, 0, u64::MAX)?,
                epoch: bstr(m.get(k::EPOCH), path, 16, 16)?,
                unknown: m.unknown,
            }))
        }
        _ => unreachable!("Forum read type"),
    }
}

pub(crate) fn parse_draft(
    type_id: u32,
    payload: &CborValue,
    allow: bool,
    schema: SchemaVersions,
) -> Result<Draft, CodecError> {
    let path = "root/payload";
    if (TYPE_FORUM_VIEW..=TYPE_FORUM_OPERATION_STATUS).contains(&type_id) {
        return parse_forum_read(type_id, payload, allow, path);
    }
    match type_id {
        TYPE_FORWARDING_DELIVERY_ENVELOPE => {
            use mf::forwarding_delivery_envelope as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            let payments = as_list(
                map.get(k::PAYMENTS),
                &at(path, k::PAYMENTS),
                1,
                MAX_PAYMENT_MEMBERS,
            )?;
            let mut parsed = Vec::with_capacity(payments.len());
            for (i, item) in payments.iter().enumerate() {
                parsed.push(payment_member(
                    item,
                    &format!("{}[{i}]", at(path, k::PAYMENTS)),
                )?);
            }
            let endpoint = if map.has(k::ENDPOINT) {
                Some(tstr(map.get(k::ENDPOINT), &at(path, k::ENDPOINT), 1, 256)?)
            } else {
                None
            };
            let expires_at = if map.has(k::EXPIRES_AT) {
                Some(u64_in(
                    map.get(k::EXPIRES_AT),
                    &at(path, k::EXPIRES_AT),
                    0,
                    u32::MAX as u64,
                )?)
            } else {
                None
            };
            Ok(Draft::ForwardingDelivery {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                destination: account(map.get(k::DESTINATION), &at(path, k::DESTINATION))?,
                payload_frame: framed(map.get(k::PAYLOAD_FRAME), &at(path, k::PAYLOAD_FRAME))?,
                payload_digest: bstr(
                    map.get(k::PAYLOAD_DIGEST),
                    &at(path, k::PAYLOAD_DIGEST),
                    32,
                    32,
                )?,
                payments: parsed,
                endpoint,
                expires_at,
                unknown: map.unknown,
            })
        }
        TYPE_DIRECT_MESSAGE_DELIVERY => {
            use mf::direct_message_delivery as k;
            let shape = if schema.effective >= 2 {
                &k::V2_SHAPE
            } else {
                &k::V1_SHAPE
            };
            let map = shaped(Some(payload), path, shape, allow)?;
            let payments = match map.get(k::PAYMENTS) {
                Some(value) => as_list(
                    Some(value),
                    &at(path, k::PAYMENTS),
                    if schema.effective >= 2 { 0 } else { 1 },
                    MAX_PAYMENT_MEMBERS,
                )?,
                None => &[],
            };
            let mut parsed = Vec::with_capacity(payments.len());
            for (i, item) in payments.iter().enumerate() {
                parsed.push(payment_member(
                    item,
                    &format!("{}[{i}]", at(path, k::PAYMENTS)),
                )?);
            }
            let recipient = if map.has(k::RECIPIENT) {
                let rec = account(map.get(k::RECIPIENT), &at(path, k::RECIPIENT))?;
                if rec.key_type != key_type::SECP256K1 {
                    return Err(bad(&at(path, k::RECIPIENT), "recipient key type must be 1"));
                }
                Some(rec)
            } else {
                None
            };
            let dleq_proof = if map.has(k::DLEQ_PROOF) {
                Some(proof(map.get(k::DLEQ_PROOF), &at(path, k::DLEQ_PROOF))?)
            } else {
                None
            };
            Ok(Draft::DirectMessage {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                destination: account(map.get(k::DESTINATION), &at(path, k::DESTINATION))?,
                payload_frame: framed(map.get(k::PAYLOAD_FRAME), &at(path, k::PAYLOAD_FRAME))?,
                payload_digest: bstr(
                    map.get(k::PAYLOAD_DIGEST),
                    &at(path, k::PAYLOAD_DIGEST),
                    32,
                    32,
                )?,
                payments: parsed,
                recipient,
                dleq_proof,
                unknown: map.unknown,
            })
        }
        TYPE_DIRECTORY_ATTESTATION => {
            use mf::directory_attestation as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            let sigs = as_list(
                map.get(k::SIGNATURES),
                &at(path, k::SIGNATURES),
                1,
                MAX_SIGNATURES,
            )?;
            let mut parsed = Vec::with_capacity(sigs.len());
            for (i, item) in sigs.iter().enumerate() {
                parsed.push(signature_entry(
                    item,
                    &format!("{}[{i}]", at(path, k::SIGNATURES)),
                )?);
            }
            Ok(Draft::DirectoryAttestation {
                statement_frame: framed(
                    map.get(k::STATEMENT_FRAME),
                    &at(path, k::STATEMENT_FRAME),
                )?,
                signatures: parsed,
                unknown: map.unknown,
            })
        }
        TYPE_MAILBOX_CHECKPOINT => {
            use mf::mailbox_checkpoint as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            let facts = as_list(map.get(k::FACTS), &at(path, k::FACTS), 0, MAX_JOURNAL_FACTS)?;
            let mut parsed_facts = Vec::with_capacity(facts.len());
            for (i, item) in facts.iter().enumerate() {
                parsed_facts.push(journal_fact(
                    item,
                    &format!("{}[{i}]", at(path, k::FACTS)),
                    allow,
                )?);
            }
            let sections = if map.has(k::SECTIONS) {
                let items = as_list(
                    map.get(k::SECTIONS),
                    &at(path, k::SECTIONS),
                    0,
                    MAX_OPAQUE_SECTIONS,
                )?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(opaque_section(
                        item,
                        &format!("{}[{i}]", at(path, k::SECTIONS)),
                    )?);
                }
                Some(parsed)
            } else {
                None
            };
            Ok(Draft::Checkpoint {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                owner: account(map.get(k::OWNER), &at(path, k::OWNER))?,
                checkpoint_id: bstr(
                    map.get(k::CHECKPOINT_ID),
                    &at(path, k::CHECKPOINT_ID),
                    16,
                    16,
                )?,
                timestamp: timestamp(map.get(k::TIMESTAMP), &at(path, k::TIMESTAMP))?,
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
            use mf::directory_statement as k;
            let preview = schema.effective >= 4;
            // Schema 1 also reads the schema-2 optional fields (14-16), which its CDDL rule omits.
            let v1 = mf::MapShape {
                optional: k::V2_SHAPE.optional,
                ..k::V1_SHAPE
            };
            let shape = match schema.effective {
                0 | 1 => &v1,
                2 => &k::V2_SHAPE,
                3 => &k::V3_SHAPE,
                _ => &k::V4_SHAPE,
            };
            let map = shaped(Some(payload), path, shape, allow)?;
            if preview
                && [
                    k::KEY_TRANSITIONS,
                    k::RECOVERY_AUTHORITIES,
                    k::PROFILE_ENTRIES,
                ]
                .iter()
                .any(|key| map.has(*key))
            {
                return Err(bad(
                    path,
                    "transitions, recovery and profiles are unsupported in directory preview",
                ));
            }
            let relays = as_list(
                map.get(k::RELAYS),
                &at(path, k::RELAYS),
                1,
                if preview { 1 } else { MAX_RELAY_BINDINGS },
            )?;
            let mut parsed_relays = Vec::with_capacity(relays.len());
            for (i, item) in relays.iter().enumerate() {
                parsed_relays.push(relay_binding(
                    item,
                    &format!("{}[{i}]", at(path, k::RELAYS)),
                    allow,
                    preview,
                )?);
            }
            let key_transitions = if map.has(k::KEY_TRANSITIONS) {
                let items = as_list(
                    map.get(k::KEY_TRANSITIONS),
                    &at(path, k::KEY_TRANSITIONS),
                    1,
                    16,
                )?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(key_transition(
                        item,
                        &format!("{}[{i}]", at(path, k::KEY_TRANSITIONS)),
                        allow,
                    )?);
                }
                Some(parsed)
            } else {
                None
            };
            let expiry = if map.has(k::EXPIRY) {
                Some(timestamp(map.get(k::EXPIRY), &at(path, k::EXPIRY))?)
            } else {
                None
            };
            let recovery = if map.has(k::RECOVERY_AUTHORITIES) {
                let items = as_list(
                    map.get(k::RECOVERY_AUTHORITIES),
                    &at(path, k::RECOVERY_AUTHORITIES),
                    1,
                    8,
                )?;
                let mut parsed = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    parsed.push(account(
                        Some(item),
                        &format!("{}[{i}]", at(path, k::RECOVERY_AUTHORITIES)),
                    )?);
                }
                Some(parsed)
            } else {
                None
            };
            Ok(Draft::Statement {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                subject: directory_account(map.get(k::SUBJECT), &at(path, k::SUBJECT), preview)?,
                revision: u64_in(map.get(k::REVISION), &at(path, k::REVISION), 0, u64::MAX)?,
                timestamp: timestamp(map.get(k::TIMESTAMP), &at(path, k::TIMESTAMP))?,
                relays: parsed_relays,
                key_transitions,
                expiry,
                recovery,
                schema_version: schema.envelope,
                preview: if preview {
                    Some(PreviewDirectoryRoles {
                        message_dh_key: directory_account(
                            map.get(k::MESSAGE_DH_KEY),
                            &at(path, k::MESSAGE_DH_KEY),
                            true,
                        )?,
                        mailbox_key_generation: u64_in(
                            map.get(k::MAILBOX_KEY_GENERATION),
                            &at(path, k::MAILBOX_KEY_GENERATION),
                            0,
                            u64::MAX,
                        )?,
                        stamp_key_generation: u64_in(
                            map.get(k::STAMP_KEY_GENERATION),
                            &at(path, k::STAMP_KEY_GENERATION),
                            0,
                            u64::MAX,
                        )?,
                        predecessor: if matches!(
                            map.get(k::PREDECESSOR_HASH),
                            Some(CborValue::Null)
                        ) {
                            None
                        } else {
                            Some(bstr(
                                map.get(k::PREDECESSOR_HASH),
                                &at(path, k::PREDECESSOR_HASH),
                                32,
                                32,
                            )?)
                        },
                    })
                } else {
                    None
                },
                stamp_key: if map.has(k::STAMP_KEY) {
                    Some(directory_account(
                        map.get(k::STAMP_KEY),
                        &at(path, k::STAMP_KEY),
                        preview,
                    )?)
                } else {
                    None
                },
                profile_entries: if map.has(k::PROFILE_ENTRIES) && schema.effective >= 3 {
                    let items = as_list(
                        map.get(k::PROFILE_ENTRIES),
                        &at(path, k::PROFILE_ENTRIES),
                        1,
                        64,
                    )?;
                    let mut parsed = Vec::with_capacity(items.len());
                    for (i, item) in items.iter().enumerate() {
                        parsed.push(profile_entry(
                            item,
                            &format!("{}[{i}]", at(path, k::PROFILE_ENTRIES)),
                            allow,
                        )?);
                    }
                    Some(parsed)
                } else {
                    None
                },
                canonical_username: if map.has(k::USERNAME) {
                    Some(tstr(map.get(k::USERNAME), &at(path, k::USERNAME), 3, 32)?)
                } else {
                    None
                },
                account_type: if map.has(k::ACCOUNT_TYPE) {
                    let v = u64_in(
                        map.get(k::ACCOUNT_TYPE),
                        &at(path, k::ACCOUNT_TYPE),
                        0,
                        u64::from(account_type::ORGANIZATION),
                    )?;
                    Some(crate::model::AccountType::from_u64(v).expect("validated 0..=3"))
                } else {
                    None
                },
                bot_role: if map.has(k::BOT_ROLE) {
                    let v = u64_in(
                        map.get(k::BOT_ROLE),
                        &at(path, k::BOT_ROLE),
                        0,
                        u64::from(bot_role::ANNOUNCER),
                    )?;
                    Some(crate::model::BotRole::from_u64(v).expect("validated 0..=7"))
                } else {
                    None
                },
                unknown: map.unknown,
            })
        }
        TYPE_RECIPIENT_ENCRYPTED_PAYLOAD => {
            if schema.effective >= 2 {
                use mf::recipient_encrypted_payload_v2 as k;
                let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
                Ok(Draft::Recipient {
                    schema_version: 2,
                    network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                    sender: account(map.get(k::SENDER), &at(path, k::SENDER))?,
                    recipient: account(map.get(k::RECIPIENT), &at(path, k::RECIPIENT))?,
                    suite: u32_in(map.get(k::SUITE), &at(path, k::SUITE), 0, 65_535)?,
                    nonce: None,
                    ciphertext: None,
                    crypto_box_envelope: Some(bstr(
                        map.get(k::CRYPTO_BOX_ENVELOPE),
                        &at(path, k::CRYPTO_BOX_ENVELOPE),
                        1,
                        MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
                    )?),
                    ephemeral_point: point(
                        map.get(k::EPHEMERAL_POINT),
                        &at(path, k::EPHEMERAL_POINT),
                    )?,
                    shared_point: point(map.get(k::SHARED_POINT), &at(path, k::SHARED_POINT))?,
                    dleq_proof: proof(map.get(k::DLEQ_PROOF), &at(path, k::DLEQ_PROOF))?,
                    unknown: map.unknown,
                })
            } else {
                use mf::recipient_encrypted_payload_v1 as k;
                let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
                Ok(Draft::Recipient {
                    schema_version: 1,
                    network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                    sender: account(map.get(k::SENDER), &at(path, k::SENDER))?,
                    recipient: account(map.get(k::RECIPIENT), &at(path, k::RECIPIENT))?,
                    suite: u32_in(map.get(k::SUITE), &at(path, k::SUITE), 0, 65_535)?,
                    nonce: Some(bstr(map.get(k::NONCE), &at(path, k::NONCE), 1, 64)?),
                    ciphertext: Some(bstr(
                        map.get(k::CIPHERTEXT),
                        &at(path, k::CIPHERTEXT),
                        1,
                        MAX_CIPHERTEXT_BYTES,
                    )?),
                    crypto_box_envelope: None,
                    ephemeral_point: point(
                        map.get(k::EPHEMERAL_POINT),
                        &at(path, k::EPHEMERAL_POINT),
                    )?,
                    shared_point: point(map.get(k::SHARED_POINT), &at(path, k::SHARED_POINT))?,
                    dleq_proof: proof(map.get(k::DLEQ_PROOF), &at(path, k::DLEQ_PROOF))?,
                    unknown: map.unknown,
                })
            }
        }
        TYPE_ENCRYPTED_MESSAGE_CONTENT => {
            // Field 4 is optional on the wire: writers should send it, readers accept absence.
            use mf::encrypted_message_content as k;
            // This reader does not declare field 6 (token transfer); it is retained as unknown.
            let map = fields(
                Some(payload),
                path,
                k::SHAPE.required,
                &[k::CONVERSATION_ID, k::CONVERSATION_NAME],
                k::SHAPE.open,
                allow,
            )?;
            let conversation_id = if map.has(k::CONVERSATION_ID) {
                Some(bstr(
                    map.get(k::CONVERSATION_ID),
                    &at(path, k::CONVERSATION_ID),
                    16,
                    16,
                )?)
            } else {
                None
            };
            let conversation_name = if map.has(k::CONVERSATION_NAME) {
                Some(conversation_name(
                    map.get(k::CONVERSATION_NAME),
                    &at(path, k::CONVERSATION_NAME),
                )?)
            } else {
                None
            };
            Ok(Draft::Encrypted {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                message_id: bstr(map.get(k::MESSAGE_ID), &at(path, k::MESSAGE_ID), 16, 16)?,
                revision_frame: framed(map.get(k::REVISION_FRAME), &at(path, k::REVISION_FRAME))?,
                content_digest: bstr(
                    map.get(k::CONTENT_DIGEST),
                    &at(path, k::CONTENT_DIGEST),
                    32,
                    32,
                )?,
                conversation_id,
                conversation_name,
                unknown: map.unknown,
            })
        }
        TYPE_KEY_TRANSITION_STATEMENT => {
            use mf::key_transition_statement as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            Ok(Draft::TransitionStatement {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                subject: account(map.get(k::SUBJECT), &at(path, k::SUBJECT))?,
                prior_authority: account(
                    map.get(k::PRIOR_AUTHORITY),
                    &at(path, k::PRIOR_AUTHORITY),
                )?,
                revision: u64_in(map.get(k::REVISION), &at(path, k::REVISION), 1, u64::MAX)?,
                new_key: account(map.get(k::NEW_KEY), &at(path, k::NEW_KEY))?,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_POST => {
            use mf::topic_post as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            let parent_hash = if map.has(k::PARENT_HASH) {
                Some(bstr(
                    map.get(k::PARENT_HASH),
                    &at(path, k::PARENT_HASH),
                    32,
                    32,
                )?)
            } else {
                None
            };
            let from = if map.has(k::AUTHOR) {
                let val = map.get(k::AUTHOR);
                if matches!(val, Some(CborValue::Map(_))) {
                    Some(TopicPostAuthor::Account(account(
                        val,
                        &at(path, k::AUTHOR),
                    )?))
                } else {
                    Some(TopicPostAuthor::Bytes(bstr(
                        val,
                        &at(path, k::AUTHOR),
                        20,
                        33,
                    )?))
                }
            } else {
                None
            };
            let signature = if map.has(k::SIGNATURE) {
                Some(bstr(
                    map.get(k::SIGNATURE),
                    &at(path, k::SIGNATURE),
                    1,
                    512,
                )?)
            } else {
                None
            };
            Ok(Draft::TopicPost {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                topic: tstr(map.get(k::TOPIC), &at(path, k::TOPIC), 1, 512)?,
                parent_hash,
                body: bstr(
                    map.get(k::BODY),
                    &at(path, k::BODY),
                    1,
                    MAX_TOPIC_BODY_BYTES,
                )?,
                from,
                signature,
                structured: schema.effective >= 2,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_POST_SUBMISSION => {
            use mf::topic_post_submission as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            Ok(Draft::TopicPostSubmission {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                post_frame: framed(map.get(k::POST_FRAME), &at(path, k::POST_FRAME))?,
                burn_tx: bstr(map.get(k::BURN_TX), &at(path, k::BURN_TX), 1, 16_384)?,
                unknown: map.unknown,
            })
        }
        TYPE_TOPIC_VOTE_SUBMISSION => {
            use mf::topic_vote_submission as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            Ok(Draft::TopicVoteSubmission {
                network: network_tag(map.get(k::NETWORK), &at(path, k::NETWORK))?,
                target_hash: bstr(map.get(k::TARGET_HASH), &at(path, k::TARGET_HASH), 32, 32)?,
                burn_tx: bstr(map.get(k::BURN_TX), &at(path, k::BURN_TX), 1, 16_384)?,
                unknown: map.unknown,
            })
        }
        TYPE_MESSAGE_CONTENT_REVISION => {
            use mf::message_content_revision as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            if map.get(k::NETWORK) != Some(&CborValue::Text("frank".to_string())) {
                return Err(bad(
                    &at(path, k::NETWORK),
                    "the type-8 domain must be the text \"frank\"",
                ));
            }
            let items = as_list(
                map.get(k::ITEMS),
                &at(path, k::ITEMS),
                1,
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            )?;
            let mut parsed = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                parsed.push(framed(Some(item), &format!("{}[{i}]", at(path, k::ITEMS)))?);
            }
            Ok(Draft::Revision {
                items: parsed,
                unknown: map.unknown,
            })
        }
        TYPE_CONTAINER_MESSAGE_ITEM => {
            use mf::container_message_item as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            let items = as_list(
                map.get(k::ITEMS),
                &at(path, k::ITEMS),
                1,
                MAX_MESSAGE_ITEMS_PER_ARRAY,
            )?;
            let mut parsed = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                parsed.push(framed(Some(item), &format!("{}[{i}]", at(path, k::ITEMS)))?);
            }
            Ok(Draft::Container {
                items: parsed,
                unknown: map.unknown,
            })
        }
        // Schema 2 adds the ten hand shapes to the schema-1 shapes. Their action codes (16..25)
        // are disjoint from schema 1's (0..6), so the code alone says which closed map applies.
        // A hand shape is read only from a frame that requires reader 2; anywhere else its action
        // code is simply out of range for the schema-1 shapes.
        // Schema 3 adds the hand shapes with entropy from both sides, codes 32..41, read only by
        // a reader that supports schema 3.
        TYPE_BLACKJACK_MESSAGE_ITEM
            if schema.effective >= 3
                && schema.min_reader >= 2
                && blackjack_action_code_at_least(payload, 32) =>
        {
            Ok(Draft::BlackjackHandV3(blackjack_hand_v3_payload(
                payload, path,
            )?))
        }
        TYPE_BLACKJACK_MESSAGE_ITEM
            if schema.effective >= 2
                && schema.min_reader >= 2
                && is_blackjack_hand_action_code(payload) =>
        {
            Ok(Draft::BlackjackHand(blackjack_hand_payload(payload, path)?))
        }
        TYPE_BLACKJACK_MESSAGE_ITEM => Ok(Draft::Blackjack(blackjack_payload(payload, path)?)),
        TYPE_STEALTH_MESSAGE_ITEM => parse_stealth(payload, allow, schema.effective, path),
        TYPE_TEXT_MESSAGE_ITEM => {
            use mf::text_message_item as k;
            let map = shaped(Some(payload), path, &k::SHAPE, allow)?;
            Ok(Draft::Text {
                text: tstr(map.get(k::TEXT), &at(path, k::TEXT), 0, 262_144)?,
                unknown: map.unknown,
            })
        }
        _ => unreachable!("parse_draft called for a type with no schema"),
    }
}

fn check_key_type(account: &AccountRef, path: &str) -> Result<(), CodecError> {
    if !matches!(
        account.key_type,
        key_type::SECP256K1 | key_type::ED25519 | key_type::SECP256K1_X_ONLY
    ) {
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
    use mf::signature_algorithm as alg;
    let (key_type, ok) = match algorithm {
        alg::SECP256K1_ECDSA_DER => (key_type::SECP256K1, (8..=72).contains(&signature.len())),
        alg::BIP340_SCHNORR => (key_type::SECP256K1_X_ONLY, signature.len() == 64),
        alg::BCH_SCHNORR => (key_type::SECP256K1, signature.len() == 64),
        alg::ED25519 => (key_type::ED25519, signature.len() == 64),
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
        Draft::ForwardingDelivery { destination, .. } => {
            check_key_type(
                destination,
                &at(path, mf::forwarding_delivery_envelope::DESTINATION),
            )?;
            Ok(())
        }
        Draft::DirectMessage {
            destination,
            recipient,
            ..
        } => {
            use mf::direct_message_delivery as k;
            check_key_type(destination, &at(path, k::DESTINATION))?;
            if let Some(r) = recipient {
                check_key_type(r, &at(path, k::RECIPIENT))?;
            }
            Ok(())
        }
        Draft::DirectoryAttestation { signatures, .. } => {
            for (i, sig) in signatures.iter().enumerate() {
                let entry = at_index(path, mf::directory_attestation::SIGNATURES, i);
                check_key_type(&sig.signer, &at(&entry, mf::signature_entry::SIGNER))?;
                check_signature_shape(sig.algorithm, &sig.signer, &sig.signature, &entry)?;
            }
            Ok(())
        }
        Draft::Checkpoint { owner, .. } => {
            check_key_type(owner, &at(path, mf::mailbox_checkpoint::OWNER))
        }
        Draft::Statement {
            subject,
            relays,
            key_transitions,
            recovery,
            stamp_key,
            preview,
            ..
        } => {
            use mf::directory_statement as k;
            check_key_type(subject, &at(path, k::SUBJECT))?;
            for (i, relay) in relays.iter().enumerate() {
                let binding = at_index(path, k::RELAYS, i);
                check_key_type(&relay.identity, &at(&binding, mf::relay_binding::IDENTITY))?;
            }
            if let Some(key) = stamp_key {
                check_key_type(key, &at(path, k::STAMP_KEY))?;
            }
            if let Some(roles) = preview {
                check_key_type(&roles.message_dh_key, &at(path, k::MESSAGE_DH_KEY))?;
            }
            if let Some(transitions) = key_transitions {
                for (i, transition) in transitions.iter().enumerate() {
                    let entry = at_index(path, k::KEY_TRANSITIONS, i);
                    check_key_type(&transition.signer, &at(&entry, mf::key_transition::SIGNER))?;
                    check_signature_shape(
                        transition.algorithm,
                        &transition.signer,
                        &transition.signature,
                        &entry,
                    )?;
                }
            }
            if let Some(authorities) = recovery {
                for (i, authority) in authorities.iter().enumerate() {
                    check_key_type(authority, &at_index(path, k::RECOVERY_AUTHORITIES, i))?;
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
            // Both type-5 schemas share fields 1-3.
            use mf::recipient_encrypted_payload_v2 as k;
            const _: () = assert!(
                k::SENDER == mf::recipient_encrypted_payload_v1::SENDER
                    && k::RECIPIENT == mf::recipient_encrypted_payload_v1::RECIPIENT
                    && k::SUITE == mf::recipient_encrypted_payload_v1::SUITE
            );
            check_key_type(sender, &at(path, k::SENDER))?;
            check_key_type(recipient, &at(path, k::RECIPIENT))?;
            if (*schema_version == 1 && *suite != ENCRYPTION_SUITE_PROOF)
                || (*schema_version == 2 && *suite != ENCRYPTION_SUITE_DM_AUTH_XCHACHA)
            {
                return Err(unsupported(
                    &at(path, k::SUITE),
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
            use mf::key_transition_statement as k;
            check_key_type(subject, &at(path, k::SUBJECT))?;
            check_key_type(prior_authority, &at(path, k::PRIOR_AUTHORITY))?;
            check_key_type(new_key, &at(path, k::NEW_KEY))?;
            Ok(())
        }
        Draft::NativeStealth(item) => check_key_type(
            &item.ephemeral,
            &at(path, mf::stealth_message_item::EPHEMERAL_PUB_KEY),
        ),
        Draft::StealthPayment(item) => {
            use mf::stealth_asset_transfer as k;
            for (i, entry) in item.entries.iter().enumerate() {
                let at_entry = at_index(path, mf::stealth_asset_message_item::TRANSFERS, i);
                check_key_type(&entry.recipient, &at(&at_entry, k::RECIPIENT_SPEND_KEY))?;
                let metadata = at(
                    &at(&at_entry, k::TRANSFER),
                    mf::payment_transfer::STEALTH_METADATA,
                );
                check_key_type(
                    &entry.transfer.ephemeral,
                    &at(&metadata, mf::stealth_metadata::EPHEMERAL_PUB_KEY),
                )?;
            }
            Ok(())
        }
        Draft::Encrypted { .. }
        | Draft::TopicPost { .. }
        | Draft::TopicPostSubmission { .. }
        | Draft::TopicVoteSubmission { .. }
        | Draft::ForumView(_)
        | Draft::ForumTopicPage(_)
        | Draft::ForumDiscoveryPage(_)
        | Draft::ForumOperationStatus(_)
        | Draft::Revision { .. }
        | Draft::Container { .. }
        | Draft::Text { .. }
        | Draft::Blackjack(_)
        | Draft::BlackjackHand(_)
        | Draft::BlackjackHandV3(_) => Ok(()),
    }
}

fn blackjack_payload(payload: &CborValue, path: &str) -> Result<BlackjackMessageItem, CodecError> {
    let CborValue::Map(entries) = payload else {
        return Err(bad(path, "blackjack payload must be a map"));
    };
    let get = |key| entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    let action = u32_in(get(1), path, 0, 6)?;
    let (required, optional): (&[u64], &[u64]) = match action {
        0 => (&[0, 1, 2], &[]),
        1 => (&[0, 1, 4, 5, 6], &[]),
        2 => (&[0, 1], &[5]),
        3 => (&[0, 1], &[]),
        4 => {
            if get(3).is_some() == get(5).is_some() {
                return Err(bad(
                    path,
                    "double requires exactly one request/response form",
                ));
            }
            if get(3).is_some() {
                (&[0, 1, 3], &[])
            } else {
                (&[0, 1, 5], &[])
            }
        }
        5 => (&[0, 1, 7, 8, 9], &[]),
        _ => (&[0, 1, 10, 11], &[12, 13]),
    };
    let m = fields(Some(payload), path, required, optional, false, false)?;
    let game_id = tstr(m.get(0), path, 1, 128)?;
    let hand = |key, min, max| -> Result<Vec<u32>, CodecError> {
        as_list(m.get(key), path, min, max)?
            .iter()
            .map(|v| u32_in(Some(v), path, 0, 51))
            .collect()
    };
    let hash = |key| bstr(m.get(key), path, 32, 32);
    let action = match action {
        0 => BlackjackAction::Bet {
            wager_tx_hash: hash(2)?,
        },
        1 => BlackjackAction::Deal {
            server_seed_hash: hash(4)?,
            player_cards: hand(5, 2, 2)?,
            dealer_up_card: u32_in(m.get(6), path, 0, 51)?,
        },
        2 if m.has(5) => BlackjackAction::HitResponse {
            player_cards: hand(5, 3, 52)?,
        },
        2 => BlackjackAction::HitRequest,
        3 => BlackjackAction::Stand,
        4 if m.has(3) => BlackjackAction::DoubleRequest {
            double_wager_tx_hash: hash(3)?,
        },
        4 => BlackjackAction::DoubleResponse {
            player_cards: hand(5, 3, 3)?,
        },
        5 => {
            let seed = tstr(m.get(8), path, 64, 64)?;
            if !seed
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(bad(path, "seed must be 64 lowercase ASCII hex characters"));
            }
            let outcome = match u32_in(m.get(9), path, 0, 3)? {
                0 => BlackjackOutcome::PlayerWin,
                1 => BlackjackOutcome::DealerWin,
                2 => BlackjackOutcome::Push,
                _ => BlackjackOutcome::PlayerBlackjack,
            };
            BlackjackAction::Reveal {
                dealer_cards: hand(7, 2, 52)?,
                server_seed: seed,
                outcome,
            }
        }
        _ => {
            let rules = if m.has(13) {
                let text = tstr(m.get(13), path, 0, 1200)?;
                if text.encode_utf16().count() > 400 {
                    return Err(bad(path, "rules exceed 400 UTF-16 units"));
                }
                Some(text)
            } else {
                None
            };
            BlackjackAction::Welcome {
                min_wager_wei: hash(10)?,
                max_wager_wei: hash(11)?,
                fee_hint_wei: if m.has(12) { Some(hash(12)?) } else { None },
                rules,
            }
        }
    };
    Ok(BlackjackFields { game_id, action })
}

/// True when the payload is a map whose action (key 1) is an integer of at least 16.
fn is_blackjack_hand_action_code(payload: &CborValue) -> bool {
    blackjack_action_code_at_least(payload, 16)
}

/// True when the payload is a map whose action (key 1) is an integer of at least `min`.
fn blackjack_action_code_at_least(payload: &CborValue, min: i128) -> bool {
    let CborValue::Map(entries) = payload else {
        return false;
    };
    matches!(
        entries.iter().find(|(k, _)| *k == 1),
        Some((_, CborValue::Int(code))) if *code >= min
    )
}

/// Closed schema-2 shapes: one peer-to-peer hand. No shape carries an amount of money.
fn blackjack_hand_payload(
    payload: &CborValue,
    path: &str,
) -> Result<BlackjackHandMessageItem, CodecError> {
    let CborValue::Map(entries) = payload else {
        return Err(bad(path, "blackjack payload must be a map"));
    };
    let get = |key| entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    // Codes 16..25: disjoint from schema 1's 0..6, so no reader can take one for the other.
    let action = u32_in(get(1), path, 16, 25)?;
    let required: &[u64] = match action {
        16 if u32_in(get(2), path, 0, 1)? == 0 => &[0, 1, 2, 3, 4],
        16 => &[0, 1, 2, 3],
        17 => &[0, 1, 3, 4],
        19 => &[0, 1, 5, 6],
        23 => &[0, 1, 5],
        24 => &[0, 1, 7, 8, 9],
        25 => &[0, 1, 10],
        _ => &[0, 1],
    };
    let m = fields(Some(payload), path, required, &[], false, false)?;
    // Fixed form, so a game id is always safe to use as a key: 32 lowercase hex characters.
    let game_path = format!("{path}.0");
    let game_id = tstr(m.get(0), &game_path, 32, 32)?;
    if game_id.len() != 32
        || !game_id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(bad(
            &game_path,
            "game id must be 32 lowercase ASCII hex characters",
        ));
    }
    let hand = |key, min, max| -> Result<Vec<u32>, CodecError> {
        as_list(m.get(key), path, min, max)?
            .iter()
            .map(|v| u32_in(Some(v), path, 0, 51))
            .collect()
    };
    let hash = |key| bstr(m.get(key), path, 32, 32);
    let action = match action {
        16 if m.has(4) => BlackjackHandAction::ChallengeDealer {
            max_bet_wei: hash(3)?,
            commitment: hash(4)?,
        },
        16 => BlackjackHandAction::ChallengePlayer {
            max_bet_wei: hash(3)?,
        },
        17 => BlackjackHandAction::Accept {
            max_bet_wei: hash(3)?,
            commitment: hash(4)?,
        },
        18 => BlackjackHandAction::Bet,
        19 => BlackjackHandAction::Deal {
            player_cards: hand(5, 2, 2)?,
            dealer_up_card: u32_in(m.get(6), path, 0, 51)?,
        },
        20 => BlackjackHandAction::Hit,
        21 => BlackjackHandAction::Stand,
        22 => BlackjackHandAction::Double,
        23 => BlackjackHandAction::Card {
            player_cards: hand(5, 3, 52)?,
        },
        24 => {
            let seed = tstr(m.get(8), path, 64, 64)?;
            if !seed
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(bad(path, "seed must be 64 lowercase ASCII hex characters"));
            }
            let dealer_cards = hand(7, 2, 52)?;
            let outcome = match u32_in(m.get(9), path, 0, 3)? {
                0 => BlackjackOutcome::PlayerWin,
                1 => BlackjackOutcome::DealerWin,
                2 => BlackjackOutcome::Push,
                _ => BlackjackOutcome::PlayerBlackjack,
            };
            BlackjackHandAction::Reveal {
                dealer_cards,
                seed,
                outcome,
            }
        }
        _ => BlackjackHandAction::Refund {
            reference: hash(10)?,
        },
    };
    Ok(BlackjackHandFields { game_id, action })
}

/// Closed schema-3 shapes: a hand whose cards come from both sides' entropy. No shape states a
/// card, an outcome or an amount of money.
fn blackjack_hand_v3_payload(
    payload: &CborValue,
    path: &str,
) -> Result<BlackjackHandV3MessageItem, CodecError> {
    let CborValue::Map(entries) = payload else {
        return Err(bad(path, "blackjack payload must be a map"));
    };
    let get = |key| entries.iter().find(|(k, _)| *k == key).map(|(_, v)| v);
    // Codes 32..41: disjoint from schema 1's 0..6 and schema 2's 16..25.
    let action = u32_in(get(1), &format!("{path}.1"), 32, 41)?;
    let required: &[u64] = match action {
        32 if u32_in(get(2), &format!("{path}.2"), 0, 1)? == 0 => &[0, 1, 11, 2, 3, 4],
        32 => &[0, 1, 11, 2, 3],
        33 => &[0, 1, 11, 3, 4, 12],
        34 => &[0, 1, 11, 4, 12],
        41 => &[0, 1, 11, 10, 12],
        _ => &[0, 1, 11, 12, 13],
    };
    let m = fields(Some(payload), path, required, &[], false, false)?;
    // Fixed form, so a game id is always safe to use as a key: 32 lowercase hex characters.
    let game_path = format!("{path}.0");
    let game_id = tstr(m.get(0), &game_path, 32, 32)?;
    if game_id.len() != 32
        || !game_id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(bad(
            &game_path,
            "game id must be 32 lowercase ASCII hex characters",
        ));
    }
    // A challenge is message 0 of its hand; every other message follows one.
    let (seq_min, seq_max) = if action == 32 { (0, 0) } else { (1, 255) };
    let seq = u32_in(m.get(11), &format!("{path}.11"), seq_min, seq_max)?;
    let hash = |key: u64| bstr(m.get(key), &format!("{path}.{key}"), 32, 32);
    let action = match action {
        32 if m.has(4) => BlackjackHandV3Action::ChallengeDealer {
            max_bet_wei: hash(3)?,
            commitment: hash(4)?,
        },
        32 => BlackjackHandV3Action::ChallengePlayer {
            max_bet_wei: hash(3)?,
        },
        33 => BlackjackHandV3Action::Accept {
            max_bet_wei: hash(3)?,
            commitment: hash(4)?,
            prev: hash(12)?,
        },
        34 => BlackjackHandV3Action::Bet {
            commitment: hash(4)?,
            prev: hash(12)?,
        },
        41 => BlackjackHandV3Action::Refund {
            reference: hash(10)?,
            prev: hash(12)?,
        },
        code => BlackjackHandV3Action::Move {
            kind: match code {
                35 => BlackjackHandV3Move::Deal,
                36 => BlackjackHandV3Move::Hit,
                37 => BlackjackHandV3Move::Stand,
                38 => BlackjackHandV3Move::Double,
                39 => BlackjackHandV3Move::Card,
                _ => BlackjackHandV3Move::Reveal,
            },
            link: hash(13)?,
            prev: hash(12)?,
        },
    };
    Ok(BlackjackHandV3Fields {
        game_id,
        seq,
        action,
    })
}

fn parse_stealth(
    payload: &CborValue,
    allow: bool,
    version: u32,
    path: &str,
) -> Result<Draft, CodecError> {
    if version < 2 {
        use mf::stealth_message_item as k;
        let m = shaped(Some(payload), path, &k::SHAPE, allow)?;
        return Ok(Draft::NativeStealth(NativeStealthItem {
            network: tstr(m.get(k::NETWORK_TAG), path, 1, 64)?,
            ephemeral: account(m.get(k::EPHEMERAL_PUB_KEY), path)?,
            transactions: as_list(m.get(k::TRANSACTIONS), path, 1, 16)?
                .iter()
                .map(|v| bstr(Some(v), path, 1, 16384))
                .collect::<Result<_, _>>()?,
            amount: u64_in(m.get(k::AMOUNT), path, 0, u64::MAX)?,
            memo: if m.has(k::MEMO) {
                Some(tstr(m.get(k::MEMO), path, 0, 1024)?)
            } else {
                None
            },
            unknown: m.unknown,
        }));
    }
    use mf::stealth_asset_message_item as k;
    let m = shaped(Some(payload), path, &k::SHAPE, allow)?;
    let entries = as_list(m.get(k::TRANSFERS), path, 1, 16)?
        .iter()
        .enumerate()
        .map(|(i, v)| stealth_entry(v, &at_index(path, k::TRANSFERS, i)))
        .collect::<Result<_, _>>()?;
    Ok(Draft::StealthPayment(StealthPaymentItem {
        entries,
        memo: if m.has(k::MEMO) {
            Some(tstr(m.get(k::MEMO), path, 0, 1024)?)
        } else {
            None
        },
        unknown: m.unknown,
    }))
}

fn stealth_entry(v: &CborValue, path: &str) -> Result<StealthPaymentEntry, CodecError> {
    use mf::payment_transfer as pt;
    use mf::stealth_asset_transfer as k;
    use mf::stealth_derivation_scheme as scheme_k;
    use mf::stealth_metadata as meta;
    let m = shaped(Some(v), path, &k::SHAPE, false)?;
    // A recipient payment requires the transfer's stealth metadata (field 6), which the
    // payment-transfer shape leaves optional.
    let t = fields(
        m.get(k::TRANSFER),
        path,
        &[
            pt::NETWORK_TAG,
            pt::TX_ID,
            pt::DESTINATION,
            pt::VALUE,
            pt::STEALTH_METADATA,
        ],
        &[pt::VOUT, pt::TOKEN, pt::COMMITMENT, pt::RAW_TX],
        pt::SHAPE.open,
        false,
    )?;
    let metadata = shaped(t.get(pt::STEALTH_METADATA), path, &meta::SHAPE, false)?;
    let ephemeral = account(metadata.get(meta::EPHEMERAL_PUB_KEY), path)?;
    let recipient = account(m.get(k::RECIPIENT_SPEND_KEY), path)?;
    if ephemeral.key_type != recipient.key_type {
        return Err(bad(path, "recipient and ephemeral key types differ"));
    }
    let value = match t.get(pt::VALUE) {
        Some(CborValue::Bytes(b)) if b.len() == 32 && b.iter().any(|v| *v != 0) => {
            StealthQuantity::Quantity256(b.as_slice().try_into().expect("validated length"))
        }
        Some(CborValue::Int(n)) if *n > 0 && *n <= u64::MAX as i128 => {
            StealthQuantity::Uint64(*n as u64)
        }
        _ => {
            return Err(bad(
                path,
                "transfer value must be a positive uint64 or 32-byte quantity",
            ))
        }
    };
    let view_tag = if metadata.has(meta::VIEW_TAG) {
        match metadata.get(meta::VIEW_TAG) {
            Some(CborValue::Int(n)) if *n >= 0 && *n <= 65535 => {}
            Some(CborValue::Bytes(b)) if !b.is_empty() && b.len() <= 32 => {}
            _ => return Err(bad(path, "invalid view tag")),
        }
        metadata.get(meta::VIEW_TAG).cloned()
    } else {
        None
    };
    let scheme = u32_in(m.get(k::DERIVATION_SCHEME), path, 1, u32::MAX)?;
    if m.has(k::TOKEN_PROGRAM) && !t.has(pt::TOKEN) {
        return Err(bad(path, "token program requires token"));
    }
    if scheme == scheme_k::SECP256K1_ECDH_ADD_V1
        && (recipient.key_type != key_type::SECP256K1
            || m.has(k::TOKEN_PROGRAM)
            || m.has(k::DERIVATION_CONTEXT))
    {
        return Err(bad(
            path,
            "scheme 1 requires secp256k1 keys and no program/context",
        ));
    }
    Ok(StealthPaymentEntry {
        transfer: StealthTransfer {
            network: tstr(t.get(pt::NETWORK_TAG), path, 1, 64)?,
            tx_id: bstr(t.get(pt::TX_ID), path, 1, 128)?,
            vout: if t.has(pt::VOUT) {
                Some(u32_in(t.get(pt::VOUT), path, 0, u32::MAX)?)
            } else {
                None
            },
            destination: bstr(t.get(pt::DESTINATION), path, 1, 128)?,
            value,
            token: if t.has(pt::TOKEN) {
                Some(bstr(t.get(pt::TOKEN), path, 1, 128)?)
            } else {
                None
            },
            ephemeral,
            view_tag,
            commitment: if t.has(pt::COMMITMENT) {
                Some(bstr(t.get(pt::COMMITMENT), path, 32, 32)?)
            } else {
                None
            },
            raw_tx: if t.has(pt::RAW_TX) {
                Some(bstr(t.get(pt::RAW_TX), path, 1, 16384)?)
            } else {
                None
            },
        },
        scheme,
        recipient,
        token_program: if m.has(k::TOKEN_PROGRAM) {
            Some(bstr(m.get(k::TOKEN_PROGRAM), path, 32, 32)?)
        } else {
            None
        },
        scheme_context: if m.has(k::DERIVATION_CONTEXT) {
            Some(bstr(m.get(k::DERIVATION_CONTEXT), path, 1, 1024)?)
        } else {
            None
        },
    })
}
