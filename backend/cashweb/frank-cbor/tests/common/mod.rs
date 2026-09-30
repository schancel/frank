//! Shared helpers for the Frank-CBOR vector and fixture tests.
#![allow(dead_code)]

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
    cbor_map(vec![(0, int(1)), (1, CborValue::Bytes(key))])
}

pub fn acct2(seed: u32) -> CborValue {
    let mut key = bytes_of(32, seed);
    key[0] = u8::try_from(seed).expect("acct2 seed fits in one byte");
    cbor_map(vec![(0, int(2)), (1, CborValue::Bytes(key))])
}

pub fn ts(seconds: i64, nanos: u32) -> CborValue {
    cbor_map(vec![
        (0, int(i128::from(seconds))),
        (1, int(i128::from(nanos))),
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
    cbor_map(vec![
        (0, int(1)),
        (1, CborValue::Bytes(hex::decode(key_hex).expect("key hex"))),
    ])
}

/// A frame around `payload`. Type 4 is written at `schema_version` 2 with `min_reader_version` 2,
/// because its stamp key (field 8) is required from schema 2 (README S10a.1); every other type is
/// version 1.
pub fn fr(type_id: u32, payload: &CborValue) -> Vec<u8> {
    let version = if type_id == 4 { 2 } else { 1 };
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

fn text_item(text: &str) -> Vec<u8> {
    fr(17, &cbor_map(vec![(0, CborValue::Text(text.to_string()))]))
}

fn container_item(children: Vec<Vec<u8>>) -> Vec<u8> {
    let items = children.into_iter().map(CborValue::Bytes).collect();
    fr(16, &cbor_map(vec![(0, CborValue::Array(items))]))
}

fn unknown_item(n: u32) -> Vec<u8> {
    fr(
        0xffff_0001,
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

fn revision_frame() -> Vec<u8> {
    let items = nested_items().into_iter().map(CborValue::Bytes).collect();
    fr(
        8,
        &cbor_map(vec![
            (0, CborValue::Text("frank".to_string())),
            (1, CborValue::Array(items)),
        ]),
    )
}

fn type6_frame(revision: &[u8]) -> Vec<u8> {
    let digest = message_content_digest(revision).expect("t1a");
    fr(
        6,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, CborValue::Bytes(bytes_of(16, 7))),
            (2, CborValue::Bytes(revision.to_vec())),
            (3, CborValue::Bytes(digest.to_vec())),
        ]),
    )
}

/// The nine fields of the fixture type-5 payload, in key order.
pub fn type5_fields() -> Vec<(u64, CborValue)> {
    let revision = revision_frame();
    let encrypted = type6_frame(&revision);
    vec![
        (0, CborValue::Text(NET.to_string())),
        (1, acct2(9)),
        (2, acct1(3)),
        (3, int(65_535)),
        (4, CborValue::Bytes(bytes_of(24, 4))),
        (5, CborValue::Bytes(encrypted)),
        (6, CborValue::Bytes(hex::decode(T3C_EPHEMERAL).unwrap())),
        (7, CborValue::Bytes(hex::decode(T3C_SHARED).unwrap())),
        (8, CborValue::Bytes(hex::decode(T3C_PROOF).unwrap())),
    ]
}

fn type5_frame() -> Vec<u8> {
    fr(5, &cbor_map(type5_fields()))
}

fn payment(t3: &[u8], index: u32) -> CborValue {
    let mut value = vec![0u8; 32];
    value[31] = 1 + (index % 200) as u8;
    value[30] = 0x0f;
    cbor_map(vec![
        (0, int(i128::from(index))),
        (1, CborValue::Bytes(bytes_of(32, 100 + index))),
        (2, CborValue::Bytes(value)),
        (3, CborValue::Bytes(bytes_of(20, 50 + index))),
        (4, CborValue::Bytes(payment_commitment(t3, index).to_vec())),
    ])
}

/// Fixture 1: type-1 direct message with two stamp payments.
pub fn direct_message_frame() -> Vec<u8> {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    fr(
        1,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, stamp_account(T3C_STAMP_KEY)),
            (2, CborValue::Bytes(payload_frame)),
            (3, CborValue::Bytes(t3.to_vec())),
            (4, CborValue::Array(vec![payment(&t3, 0), payment(&t3, 1)])),
        ]),
    )
}

/// Fixture 4: a top-level type-9 topic post.
pub fn topic_post_frame() -> Vec<u8> {
    fr(
        9,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, CborValue::Text("frank.demo".to_string())),
            (3, CborValue::Bytes(bytes_of(64, 21))),
        ]),
    )
}

/// Fixture 5: a type-10 submission wrapping [`topic_post_frame`].
pub fn topic_post_submission_frame() -> Vec<u8> {
    fr(
        10,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, CborValue::Bytes(topic_post_frame())),
            (2, CborValue::Bytes(bytes_of(110, 31))),
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
        11,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, CborValue::Bytes(topic_post_hash())),
            (2, CborValue::Bytes(bytes_of(110, 32))),
        ]),
    )
}

fn relay(i: u32) -> CborValue {
    let mut id = bytes_of(16, i);
    id[0] = u8::try_from(i).expect("relay index");
    cbor_map(vec![
        (0, CborValue::Bytes(id)),
        (
            1,
            CborValue::Text(format!("https://relay{i}.example/frank")),
        ),
        (2, acct1(20 + i)),
        (3, ts(1_800_000_000, 0)),
    ])
}

fn directory_statement_frame() -> Vec<u8> {
    fr(
        4,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, acct2(1)),
            (2, int(i128::from(u64::MAX))),
            (3, ts(1_700_000_000, 123_456_789)),
            (4, CborValue::Array(vec![relay(1), relay(2)])),
            (6, ts(1_900_000_000, 999_999_999)),
            (8, stamp_account(T3C_STAMP_KEY)),
        ]),
    )
}

fn signature(signer: CborValue) -> CborValue {
    cbor_map(vec![
        (0, int(16)),
        (1, signer),
        (2, CborValue::Bytes(bytes_of(64, 1))),
    ])
}

/// Fixture 2: bootstrap type-2 attestation of a `u64::MAX` revision statement.
pub fn directory_attestation_frame() -> Vec<u8> {
    let statement = directory_statement_frame();
    fr(
        2,
        &cbor_map(vec![
            (0, CborValue::Bytes(statement)),
            (1, CborValue::Array(vec![signature(acct2(1))])),
        ]),
    )
}

fn fact(seconds: i64, nanos: u32, id_seed: u32, payload: Vec<u8>) -> CborValue {
    cbor_map(vec![
        (0, ts(seconds, nanos)),
        (1, CborValue::Bytes(bytes_of(16, id_seed))),
        (2, int(7)),
        (3, CborValue::Bytes(payload)),
    ])
}

fn section(section_type: u32, schema: u32, value: Vec<u8>) -> CborValue {
    cbor_map(vec![
        (0, int(i128::from(section_type))),
        (1, int(i128::from(schema))),
        (2, CborValue::Bytes(value)),
    ])
}

/// Fixture 3: type-3 checkpoint with an unknown nested item and an unknown section.
pub fn checkpoint_frame() -> Vec<u8> {
    fr(
        3,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, acct1(5)),
            (2, CborValue::Bytes(bytes_of(16, 77))),
            (3, ts(1_700_000_500, 5)),
            (
                4,
                CborValue::Array(vec![
                    fact(1_700_000_100, 0, 1, bytes_of(10, 1)),
                    fact(1_700_000_100, 9, 2, unknown_item(2)),
                ]),
            ),
            (
                5,
                CborValue::Array(vec![
                    section(1, 1, bytes_of(12, 3)),
                    section(0x7fff_0001, 9, unknown_item(3)),
                ]),
            ),
        ]),
    )
}

/// Topic-event types (README E5, types 9 through 11), assigned by #136.
pub const TOPIC_TYPES: [u32; 3] = [9, 10, 11];

fn context_for(types: impl Iterator<Item = u32>) -> ValidationContext {
    ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        // Reader version 2 reads type 4 at schema 2 (the stamp key); every other type is at 1.
        reader_version: 2,
        supported_schemas: types
            .map(|type_id| SupportedSchema {
                type_id,
                schema_version: if type_id == 4 { 2 } else { 1 },
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
        "full" => panic!("stage 10 (`full`) is outside this codec"),
        other => panic!("unknown operation {other}"),
    };
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
