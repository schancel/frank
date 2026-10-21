//! Shared helpers for the Frank-CBOR vector and fixture tests.
#![allow(dead_code)]

use frank_cbor::message_fields::{
    account_ref, container_message_item, direct_message_delivery as dmd, directory_attestation,
    directory_statement as stmt, encrypted_message_content as emc, encryption_suite, journal_fact,
    key_type, mailbox_checkpoint as ckpt, message_content_revision as revision, opaque_section,
    payment_member as pay, recipient_encrypted_payload_v1 as rep1, relay_binding,
    signature_algorithm, signature_entry, text_message_item, timestamp, topic_post as post,
    topic_post_submission as post_sub, topic_vote_submission as vote,
};
use frank_cbor::message_types::{
    TYPE_CONTAINER_MESSAGE_ITEM, TYPE_DIRECTORY_ATTESTATION, TYPE_DIRECTORY_STATEMENT,
    TYPE_DIRECT_MESSAGE_DELIVERY, TYPE_ENCRYPTED_MESSAGE_CONTENT, TYPE_FORUM_OPERATION_STATUS,
    TYPE_FORUM_VIEW, TYPE_MAILBOX_CHECKPOINT, TYPE_MESSAGE_CONTENT_REVISION,
    TYPE_PROOF_UNKNOWN_ITEM, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, TYPE_TEXT_MESSAGE_ITEM,
    TYPE_TOPIC_POST, TYPE_TOPIC_POST_SUBMISSION, TYPE_TOPIC_VOTE_SUBMISSION,
};
use frank_cbor::{
    cbor_map, content_hash, decode_canonical, encode_canonical, encode_frame,
    message_content_digest, payment_commitment, recipient_payload_digest, validate_frame,
    CborValue, EnvelopeFields, FramePayload, Operation, ParsedFrame, PriorStatement,
    SupportedSchema, ValidationContext, ValidationResult, KNOWN_TYPES, MAX_FRAME_BYTES,
};

pub const NET: &str = "frank-test";

pub fn int(n: i128) -> CborValue {
    CborValue::Int(n)
}

pub fn bytes_of(length: usize, seed: u32) -> Vec<u8> {
    (0..length)
        .map(|i| ((seed.wrapping_mul(37) + (i as u32).wrapping_mul(11) + 5) & 0xff) as u8)
        .collect()
}

pub fn acct1(seed: u32) -> CborValue {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, seed));
    account(key_type::SECP256K1, key)
}

/// An account-ref map of `key_type` and `key`.
pub fn account(key_type: u32, key: Vec<u8>) -> CborValue {
    cbor_map(vec![
        (account_ref::KEY_TYPE, int(key_type.into())),
        (account_ref::KEY_BYTES, CborValue::Bytes(key)),
    ])
}

pub fn acct2(seed: u32) -> CborValue {
    let mut key = bytes_of(32, seed);
    key[0] = u8::try_from(seed).expect("acct2 seed fits in one byte");
    account(key_type::ED25519, key)
}

pub fn ts(seconds: i64, nanos: u32) -> CborValue {
    cbor_map(vec![
        (timestamp::SECONDS, int(i128::from(seconds))),
        (timestamp::NANOSECONDS, int(i128::from(nanos))),
    ])
}

/// README T3c worked example (network `monad`): `P'`, `E`, `X` and the DLEQ proof `c || s`. Real
/// curve points and a real proof, so a type-5 frame built from them passes the T3b encoding
/// rules. The fixtures use another network tag, so the proof is not verifiable there; only the
/// encoding is claimed at `typed`.
pub const T3C_STAMP_KEY: &str =
    "03f7fc9b839b4c4c8ff821777ecc410b461d6ca6b36e931ddbfadda8b37a55ae33";
pub const T3C_EPHEMERAL: &str =
    "022f88fd8059bf1bfda332a2ff01f4667efdc1d8526562ecbd6bcac57ace81b6c3";
pub const T3C_SHARED: &str = "02d066aa56e65e5cba4051500237a51ae9fd16c2c3476904d47d667f9fe1fca3e9";
pub const T3C_PROOF: &str = concat!(
    "bf8f2ddfeb72fb808d95507bf325ca2e09ea762fd874aef4422a74b7b82e327d",
    "a6708a4fa9553e426718e3cf8ed714d75546b0458f8a4ef1820c30dce4b0163a"
);

/// A key-type-1 account holding the given hex key.
pub fn stamp_account(key_hex: &str) -> CborValue {
    account(key_type::SECP256K1, hex::decode(key_hex).expect("key hex"))
}

/// A frame around `payload`. Type 4 is written at `schema_version` 2 with `min_reader_version` 2,
/// because its stamp key (field 8) is required from schema 2 (README S10a.1); every other type is
/// version 1.
pub fn fr(type_id: u32, payload: &CborValue) -> Vec<u8> {
    let version = if type_id == TYPE_DIRECTORY_STATEMENT {
        2
    } else {
        1
    };
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: version,
            min_reader_version: version,
        },
        FramePayload::Value(payload),
    )
    .expect("fixture frame")
}

/// A forward-schema frame readable by the version-1 schema while retaining additive fields.
fn fr_additive(type_id: u32, payload: &CborValue) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: 2,
            min_reader_version: 1,
        },
        FramePayload::Value(payload),
    )
    .expect("forward-schema fixture frame")
}

fn text_item(text: &str) -> Vec<u8> {
    fr(
        TYPE_TEXT_MESSAGE_ITEM,
        &cbor_map(vec![(
            text_message_item::TEXT,
            CborValue::Text(text.to_string()),
        )]),
    )
}

fn container_item(children: Vec<Vec<u8>>) -> Vec<u8> {
    let items = children.into_iter().map(CborValue::Bytes).collect();
    fr(
        TYPE_CONTAINER_MESSAGE_ITEM,
        &cbor_map(vec![(
            container_message_item::ITEMS,
            CborValue::Array(items),
        )]),
    )
}

pub fn unknown_item(n: u32) -> Vec<u8> {
    fr(
        TYPE_PROOF_UNKNOWN_ITEM,
        // raw-cbor-key: the proof-only unknown item's payload has no registered schema
        &cbor_map(vec![(0, CborValue::Text(format!("future item {n}")))]),
    )
}

fn nested_items() -> Vec<Vec<u8>> {
    vec![
        text_item("hello from the browser codec"),
        container_item(vec![
            text_item("nested text"),
            unknown_item(1),
            container_item(vec![text_item("two levels down")]),
        ]),
    ]
}

pub fn revision_frame() -> Vec<u8> {
    let items = nested_items().into_iter().map(CborValue::Bytes).collect();
    fr(
        TYPE_MESSAGE_CONTENT_REVISION,
        &cbor_map(vec![
            (revision::NETWORK, CborValue::Text("frank".to_string())),
            (revision::ITEMS, CborValue::Array(items)),
        ]),
    )
}

fn type6_frame(revision: &[u8]) -> Vec<u8> {
    let digest = message_content_digest(revision).expect("t1a");
    fr(
        TYPE_ENCRYPTED_MESSAGE_CONTENT,
        &cbor_map(vec![
            (emc::NETWORK, CborValue::Text(NET.to_string())),
            (emc::MESSAGE_ID, CborValue::Bytes(bytes_of(16, 7))),
            (emc::REVISION_FRAME, CborValue::Bytes(revision.to_vec())),
            (emc::CONTENT_DIGEST, CborValue::Bytes(digest.to_vec())),
            (emc::CONVERSATION_ID, CborValue::Bytes(bytes_of(16, 8))),
        ]),
    )
}

/// The nine fields of the fixture type-5 payload, in key order.
pub fn type5_fields() -> Vec<(u64, CborValue)> {
    let revision = revision_frame();
    let encrypted = type6_frame(&revision);
    vec![
        (rep1::NETWORK, CborValue::Text(NET.to_string())),
        (rep1::SENDER, acct2(9)),
        (rep1::RECIPIENT, acct1(3)),
        (rep1::SUITE, int(encryption_suite::PROOF.into())),
        (rep1::NONCE, CborValue::Bytes(bytes_of(24, 4))),
        (rep1::CIPHERTEXT, CborValue::Bytes(encrypted)),
        (
            rep1::EPHEMERAL_POINT,
            CborValue::Bytes(hex::decode(T3C_EPHEMERAL).unwrap()),
        ),
        (
            rep1::SHARED_POINT,
            CborValue::Bytes(hex::decode(T3C_SHARED).unwrap()),
        ),
        (
            rep1::DLEQ_PROOF,
            CborValue::Bytes(hex::decode(T3C_PROOF).unwrap()),
        ),
    ]
}

pub fn type5_frame() -> Vec<u8> {
    fr(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, &cbor_map(type5_fields()))
}

/// A second canonical encoding of the type-5 fixture whose source map was assembled in reverse
/// order. The encoder must converge on [`type5_frame`].
pub fn type5_frame_reverse_order() -> Vec<u8> {
    let mut fields = type5_fields();
    fields.reverse();
    fr(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, &CborValue::Map(fields))
}

/// A valid canonical one-byte mutation of [`type5_frame`]. Only the final nonce byte changes.
pub fn mutated_type5_frame() -> Vec<u8> {
    let mut fields = type5_fields();
    let (_, CborValue::Bytes(nonce)) = fields
        .iter_mut()
        .find(|(key, _)| *key == rep1::NONCE)
        .expect("nonce field")
    else {
        panic!("nonce is not bytes")
    };
    *nonce.last_mut().expect("non-empty nonce") ^= 1;
    fr(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, &CborValue::Map(fields))
}

fn payment(t3: &[u8], index: u32) -> CborValue {
    let mut value = vec![0u8; 32];
    value[31] = 1 + (index % 200) as u8;
    value[30] = 0x0f;
    cbor_map(vec![
        (pay::CHILD_INDEX, int(i128::from(index))),
        (
            pay::TRANSACTION_ID,
            CborValue::Bytes(bytes_of(32, 100 + index)),
        ),
        (pay::VALUE, CborValue::Bytes(value)),
        (pay::ADDRESS, CborValue::Bytes(bytes_of(20, 50 + index))),
        (
            pay::COMMITMENT,
            CborValue::Bytes(payment_commitment(t3, index).to_vec()),
        ),
    ])
}

/// Fixture 1: type-1 direct message with two stamp payments.
pub fn direct_message_frame() -> Vec<u8> {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    fr(
        TYPE_DIRECT_MESSAGE_DELIVERY,
        &cbor_map(vec![
            (dmd::NETWORK, CborValue::Text(NET.to_string())),
            (dmd::DESTINATION, stamp_account(T3C_STAMP_KEY)),
            (dmd::PAYLOAD_FRAME, CborValue::Bytes(payload_frame)),
            (dmd::PAYLOAD_DIGEST, CborValue::Bytes(t3.to_vec())),
            (
                dmd::PAYMENTS,
                CborValue::Array(vec![payment(&t3, 0), payment(&t3, 1)]),
            ),
        ]),
    )
}

/// Rust-origin direct message with an additive root payload field. Its nested revision also
/// contains an unknown future item two levels down.
pub fn rust_origin_direct_message_frame() -> Vec<u8> {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    fr_additive(
        TYPE_DIRECT_MESSAGE_DELIVERY,
        &cbor_map(vec![
            (dmd::NETWORK, CborValue::Text(NET.to_string())),
            (dmd::DESTINATION, stamp_account(T3C_STAMP_KEY)),
            (dmd::PAYLOAD_FRAME, CborValue::Bytes(payload_frame)),
            (dmd::PAYLOAD_DIGEST, CborValue::Bytes(t3.to_vec())),
            (
                dmd::PAYMENTS,
                CborValue::Array(vec![payment(&t3, 0), payment(&t3, 1)]),
            ),
            // raw-cbor-key: an additive field no reader declares
            (100, CborValue::Text("rust-additive-direct".to_string())),
        ]),
    )
}

/// Fixture 4: a top-level type-9 topic post.
pub fn topic_post_frame() -> Vec<u8> {
    fr(
        TYPE_TOPIC_POST,
        &cbor_map(vec![
            (post::NETWORK, CborValue::Text(NET.to_string())),
            (post::TOPIC, CborValue::Text("frank.demo".to_string())),
            (post::BODY, CborValue::Bytes(bytes_of(64, 21))),
        ]),
    )
}

/// Fixture 5: a type-10 submission wrapping [`topic_post_frame`].
pub fn topic_post_submission_frame() -> Vec<u8> {
    fr(
        TYPE_TOPIC_POST_SUBMISSION,
        &cbor_map(vec![
            (post_sub::NETWORK, CborValue::Text(NET.to_string())),
            (post_sub::POST_FRAME, CborValue::Bytes(topic_post_frame())),
            (post_sub::BURN_TX, CborValue::Bytes(bytes_of(110, 31))),
        ]),
    )
}

/// The T1 content hash of [`topic_post_frame`].
pub fn topic_post_hash() -> Vec<u8> {
    match validate_frame(&topic_post_frame(), &topic_context()).expect("topic post") {
        ValidationResult::Parsed(parsed) => content_hash(&parsed).expect("t1").to_vec(),
        _ => panic!("topic post was not parsed"),
    }
}

/// Fixture 6: a type-11 vote naming [`topic_post_hash`].
pub fn topic_vote_frame() -> Vec<u8> {
    fr(
        TYPE_TOPIC_VOTE_SUBMISSION,
        &cbor_map(vec![
            (vote::NETWORK, CborValue::Text(NET.to_string())),
            (vote::TARGET_HASH, CborValue::Bytes(topic_post_hash())),
            (vote::BURN_TX, CborValue::Bytes(bytes_of(110, 32))),
        ]),
    )
}

fn relay(i: u32) -> CborValue {
    let mut id = bytes_of(16, i);
    id[0] = u8::try_from(i).expect("relay index");
    cbor_map(vec![
        (relay_binding::RELAY_ID, CborValue::Bytes(id)),
        (
            relay_binding::ENDPOINT,
            CborValue::Text(format!("https://relay{i}.example/frank")),
        ),
        (relay_binding::IDENTITY, acct1(20 + i)),
        (relay_binding::EXPIRY, ts(1_800_000_000, 0)),
    ])
}

fn directory_statement_frame() -> Vec<u8> {
    fr(
        TYPE_DIRECTORY_STATEMENT,
        &cbor_map(vec![
            (stmt::NETWORK, CborValue::Text(NET.to_string())),
            (stmt::SUBJECT, acct2(1)),
            (stmt::REVISION, int(i128::from(u64::MAX))),
            (stmt::TIMESTAMP, ts(1_700_000_000, 123_456_789)),
            (stmt::RELAYS, CborValue::Array(vec![relay(1), relay(2)])),
            (stmt::EXPIRY, ts(1_900_000_000, 999_999_999)),
            (stmt::STAMP_KEY, stamp_account(T3C_STAMP_KEY)),
        ]),
    )
}

fn signature(signer: CborValue) -> CborValue {
    cbor_map(vec![
        (
            signature_entry::ALGORITHM,
            int(signature_algorithm::ED25519.into()),
        ),
        (signature_entry::SIGNER, signer),
        (
            signature_entry::SIGNATURE,
            CborValue::Bytes(bytes_of(64, 1)),
        ),
    ])
}

/// Fixture 2: bootstrap type-2 attestation of a `u64::MAX` revision statement.
pub fn directory_attestation_frame() -> Vec<u8> {
    let statement = directory_statement_frame();
    fr(
        TYPE_DIRECTORY_ATTESTATION,
        &cbor_map(vec![
            (
                directory_attestation::STATEMENT_FRAME,
                CborValue::Bytes(statement),
            ),
            (
                directory_attestation::SIGNATURES,
                CborValue::Array(vec![signature(acct2(1))]),
            ),
        ]),
    )
}

/// Rust-origin directory attestation with an additive root payload field.
pub fn rust_origin_directory_attestation_frame() -> Vec<u8> {
    let statement = directory_statement_frame();
    fr_additive(
        TYPE_DIRECTORY_ATTESTATION,
        &cbor_map(vec![
            (
                directory_attestation::STATEMENT_FRAME,
                CborValue::Bytes(statement),
            ),
            (
                directory_attestation::SIGNATURES,
                CborValue::Array(vec![signature(acct2(1))]),
            ),
            // raw-cbor-key: an additive field no reader declares
            (100, CborValue::Text("rust-additive-directory".to_string())),
        ]),
    )
}

fn fact(seconds: i64, nanos: u32, id_seed: u32, payload: Vec<u8>) -> CborValue {
    cbor_map(vec![
        (journal_fact::TIMESTAMP, ts(seconds, nanos)),
        (
            journal_fact::FACT_ID,
            CborValue::Bytes(bytes_of(16, id_seed)),
        ),
        (journal_fact::KIND, int(7)),
        (journal_fact::PAYLOAD, CborValue::Bytes(payload)),
    ])
}

fn section(section_type: u32, schema: u32, value: Vec<u8>) -> CborValue {
    cbor_map(vec![
        (opaque_section::SECTION_TYPE, int(i128::from(section_type))),
        (
            opaque_section::SECTION_SCHEMA_VERSION,
            int(i128::from(schema)),
        ),
        (opaque_section::VALUE, CborValue::Bytes(value)),
    ])
}

/// Fixture 3: type-3 checkpoint with an unknown nested item and an unknown section.
pub fn checkpoint_frame() -> Vec<u8> {
    fr(
        TYPE_MAILBOX_CHECKPOINT,
        &cbor_map(vec![
            (ckpt::NETWORK, CborValue::Text(NET.to_string())),
            (ckpt::OWNER, acct1(5)),
            (ckpt::CHECKPOINT_ID, CborValue::Bytes(bytes_of(16, 77))),
            (ckpt::TIMESTAMP, ts(1_700_000_500, 5)),
            (
                ckpt::FACTS,
                CborValue::Array(vec![
                    fact(1_700_000_100, 0, 1, bytes_of(10, 1)),
                    fact(1_700_000_100, 9, 2, unknown_item(2)),
                ]),
            ),
            (
                ckpt::SECTIONS,
                CborValue::Array(vec![
                    section(1, 1, bytes_of(12, 3)),
                    section(0x7fff_0001, 9, unknown_item(3)),
                ]),
            ),
        ]),
    )
}

/// Rust-origin checkpoint with an additive root payload field. Its facts and sections retain
/// opaque future frames without opening them.
pub fn rust_origin_checkpoint_frame() -> Vec<u8> {
    fr_additive(
        TYPE_MAILBOX_CHECKPOINT,
        &cbor_map(vec![
            (ckpt::NETWORK, CborValue::Text(NET.to_string())),
            (ckpt::OWNER, acct1(5)),
            (ckpt::CHECKPOINT_ID, CborValue::Bytes(bytes_of(16, 77))),
            (ckpt::TIMESTAMP, ts(1_700_000_500, 5)),
            (
                ckpt::FACTS,
                CborValue::Array(vec![
                    fact(1_700_000_100, 0, 1, bytes_of(10, 1)),
                    fact(1_700_000_100, 9, 2, unknown_item(2)),
                ]),
            ),
            (
                ckpt::SECTIONS,
                CborValue::Array(vec![
                    section(1, 1, bytes_of(12, 3)),
                    section(0x7fff_0001, 9, unknown_item(3)),
                ]),
            ),
            // raw-cbor-key: an additive field no reader declares
            (100, CborValue::Text("rust-additive-checkpoint".to_string())),
        ]),
    )
}

/// Topic-event types (README E5), assigned by #136.
pub const TOPIC_TYPES: [u32; 3] = [
    TYPE_TOPIC_POST,
    TYPE_TOPIC_POST_SUBMISSION,
    TYPE_TOPIC_VOTE_SUBMISSION,
];

fn context_for(types: impl Iterator<Item = u32>) -> ValidationContext {
    ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        // Reader version 2 reads type 4 and production type 5 at schema 2.
        reader_version: 2,
        supported_schemas: types
            // Freeze historical readers at type17, preserving the Forum read-type omission.
            .filter(|type_id| {
                *type_id <= TYPE_TEXT_MESSAGE_ITEM
                    && !(TYPE_FORUM_VIEW..=TYPE_FORUM_OPERATION_STATUS).contains(type_id)
            })
            .map(|type_id| SupportedSchema {
                type_id,
                schema_version: if type_id == TYPE_DIRECTORY_STATEMENT
                    || type_id == TYPE_RECIPIENT_ENCRYPTED_PAYLOAD
                {
                    2
                } else {
                    1
                },
            })
            .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::None,
    }
}

/// The reader of the corpus written before #136: every version-1 type except the topic events.
pub fn typed_context() -> ValidationContext {
    context_for(
        KNOWN_TYPES
            .iter()
            .copied()
            .filter(|type_id| !TOPIC_TYPES.contains(type_id)),
    )
}

/// A reader that lists every known type, topic events included.
pub fn topic_context() -> ValidationContext {
    context_for(KNOWN_TYPES.iter().copied())
}

pub fn context_from_json(value: &serde_json::Value) -> ValidationContext {
    let operation = match value["operation"].as_str().expect("operation") {
        "frame" => Operation::Frame,
        "generic" => Operation::Generic,
        "typed" => Operation::Typed,
        "full" => Operation::Full,
        other => panic!("unknown operation {other}"),
    };
    for key in [
        "payment_policy",
        "decrypted_frame_hex",
        "recipient_directory_state",
    ] {
        if let Some(field) = value.get(key) {
            if !field.is_null() {
                panic!("stage 10.1-10.5 inputs ({key}) are outside this codec");
            }
        }
    }
    let supported_schemas = value["supported_schemas"]
        .as_array()
        .expect("supported_schemas")
        .iter()
        .map(|schema| SupportedSchema {
            type_id: u32_field(schema, "type_id"),
            schema_version: u32_field(schema, "schema_version"),
        })
        .collect();
    let prior = match value.get("prior_directory_statement_frame_hex") {
        None | Some(serde_json::Value::Null) => PriorStatement::None,
        Some(serde_json::Value::String(hex_text)) => {
            PriorStatement::Frame(hex::decode(hex_text).expect("prior hex"))
        }
        Some(other) => panic!("bad prior field {other}"),
    };
    ValidationContext {
        operation,
        route_byte_limit: value["route_byte_limit"]
            .as_u64()
            .expect("route_byte_limit"),
        reader_version: u32_field(value, "reader_version"),
        supported_schemas,
        opaque_retention_allowed: value["opaque_retention_allowed"]
            .as_bool()
            .expect("opaque_retention_allowed"),
        prior,
    }
}

fn u32_field(value: &serde_json::Value, key: &str) -> u32 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key}")) as u32
}

/// Canonical re-encode of one complete item. Returns the encoded bytes.
pub fn round_trip_item(bytes: &[u8]) -> Vec<u8> {
    let value = decode_canonical(bytes).expect("canonical item");
    encode_canonical(&value).expect("re-encode")
}

pub fn content_hash_hex(frame: &ParsedFrame) -> String {
    hex::encode(content_hash(frame).expect("content hash"))
}

pub fn repo_path(relative: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}
