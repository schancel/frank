//! Shared helpers for the Frank-CBOR vector and fixture tests.
#![allow(dead_code)]

use frank_cbor::{
    cbor_map, content_hash, decode_canonical, encode_canonical, encode_frame,
    message_content_digest, payment_commitment, recipient_payload_digest, CborValue,
    EnvelopeFields, FramePayload, Operation, ParsedFrame, PriorStatement, SupportedSchema,
    ValidationContext, KNOWN_TYPES, MAX_FRAME_BYTES,
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

pub fn fr(type_id: u32, payload: &CborValue) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: 1,
            min_reader_version: 1,
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

fn type5_frame() -> Vec<u8> {
    let revision = revision_frame();
    let encrypted = type6_frame(&revision);
    fr(
        5,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, acct2(9)),
            (2, acct1(3)),
            (3, int(65_535)),
            (4, CborValue::Bytes(bytes_of(24, 4))),
            (5, CborValue::Bytes(encrypted)),
        ]),
    )
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
            (1, acct1(3)),
            (2, CborValue::Bytes(payload_frame)),
            (3, CborValue::Bytes(t3.to_vec())),
            (4, CborValue::Array(vec![payment(&t3, 0), payment(&t3, 1)])),
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

pub fn typed_context() -> ValidationContext {
    ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        reader_version: 1,
        supported_schemas: KNOWN_TYPES
            .iter()
            .copied()
            .map(|type_id| SupportedSchema {
                type_id,
                schema_version: 1,
            })
            .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::None,
    }
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
