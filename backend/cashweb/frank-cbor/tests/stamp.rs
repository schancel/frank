//! The stamp fields of #198 at the typed level: type-5 schema-1 fields 6 through 8 and schema-2
//! fields 5 through 7 (README T3a, T3b encoding rules), the type-4 stamp key (S10a.1), and the
//! same-subject schema order (S10a.2).
//! The manifest carries the vectors; these tests pin the boundaries and the typed projection.

mod common;

use frank_cbor::{
    cbor_map, encode_frame, validate_frame, CborValue, EnvelopeFields, Error, ErrorCategory,
    FramePayload, PriorStatement, TypedPayload, ValidationResult,
};

use common::{
    acct1, acct2, bytes_of, fr, int, stamp_account, ts, type5_fields, typed_context, NET,
    T3C_EPHEMERAL, T3C_PROOF, T3C_SHARED, T3C_STAMP_KEY,
};

const N: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

fn hex_bytes(text: &str) -> CborValue {
    CborValue::Bytes(hex::decode(text).unwrap())
}

fn type5_with(key: u64, value: Option<CborValue>) -> Vec<u8> {
    let mut fields: Vec<(u64, CborValue)> = type5_fields()
        .into_iter()
        .filter(|(k, _)| *k != key)
        .collect();
    if let Some(value) = value {
        fields.push((key, value));
        fields.sort_by_key(|(k, _)| *k);
    }
    fr(5, &cbor_map(fields))
}

fn outcome(frame: &[u8]) -> String {
    match validate_frame(frame, &typed_context()) {
        Ok(ValidationResult::Parsed(_)) => "parsed".to_string(),
        Ok(_) => "other".to_string(),
        Err(Error::Codec(e)) => format!("{:?}@{:?}", e.category, e.stage),
        Err(e) => panic!("{e}"),
    }
}

fn production_type5(suite: u32) -> Vec<u8> {
    let payload = cbor_map(vec![
        (0, CborValue::Text(NET.to_string())),
        (1, acct1(9)),
        (2, acct1(3)),
        (3, int(i128::from(suite))),
        (4, CborValue::Bytes(vec![0xa0])),
        (5, hex_bytes(T3C_EPHEMERAL)),
        (6, hex_bytes(T3C_SHARED)),
        (7, hex_bytes(T3C_PROOF)),
    ]);
    encode_frame(
        EnvelopeFields {
            type_id: 5,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .expect("schema-2 type 5")
}

fn point(prefix: u8, x_hex: &str) -> CborValue {
    let mut bytes = vec![prefix];
    bytes.extend(hex::decode(x_hex).unwrap());
    CborValue::Bytes(bytes)
}

const P_PLUS_1: &str = "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30";
const ONE: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const FIVE: &str = "0000000000000000000000000000000000000000000000000000000000000005";

#[test]
fn point_encoding_boundaries() {
    assert_eq!(outcome(&type5_with(6, Some(point(2, ONE)))), "parsed");
    for (name, value) in [
        ("x = p + 1", point(2, P_PLUS_1)),
        ("off curve", point(2, FIVE)),
        ("prefix 04", point(4, ONE)),
        ("prefix 05", point(5, ONE)),
        ("prefix 00", point(0, ONE)),
        ("all zero", CborValue::Bytes(vec![0; 33])),
        (
            "short",
            CborValue::Bytes(hex::decode(&T3C_EPHEMERAL[2..]).unwrap()),
        ),
    ] {
        for key in [6, 7] {
            assert_eq!(
                outcome(&type5_with(key, Some(value.clone()))),
                "Schema@S82",
                "field {key}, {name}"
            );
        }
    }
}

#[test]
fn proof_scalars_are_bounded_independently() {
    let n_minus_1 = format!("{}40", &N[..62]);
    let good_c = &T3C_PROOF[..64];
    let good_s = &T3C_PROOF[64..];
    let proof = |c: &str, s: &str| Some(hex_bytes(&format!("{c}{s}")));
    assert_eq!(
        outcome(&type5_with(8, proof(&n_minus_1, &n_minus_1))),
        "parsed"
    );
    for (name, c, s) in [
        ("c = 0", ONE.replace('1', "0"), good_s.to_string()),
        ("c = n", N.to_string(), good_s.to_string()),
        ("s = 0", good_c.to_string(), ONE.replace('1', "0")),
        ("s = n", good_c.to_string(), N.to_string()),
    ] {
        assert_eq!(
            outcome(&type5_with(8, proof(&c, &s))),
            "Schema@S82",
            "{name}"
        );
    }
    for key in [6, 7, 8] {
        assert_eq!(
            outcome(&type5_with(key, None)),
            "Schema@S82",
            "missing {key}"
        );
    }
}

#[test]
fn typed_projection_carries_the_stamp_fields() {
    let frame = type5_with(6, Some(hex_bytes(T3C_EPHEMERAL)));
    let Ok(ValidationResult::Parsed(parsed)) = validate_frame(&frame, &typed_context()) else {
        panic!("type 5 did not parse");
    };
    match parsed.typed.as_deref() {
        Some(TypedPayload::RecipientPayload {
            ephemeral_point,
            shared_point,
            dleq_proof,
            ..
        }) => {
            assert_eq!(hex::encode(ephemeral_point), T3C_EPHEMERAL);
            assert_eq!(hex::encode(shared_point), T3C_SHARED);
            assert_eq!(hex::encode(dleq_proof), T3C_PROOF);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn production_suite_one_is_typed_only_in_schema_two() {
    let frame = production_type5(1);
    let Ok(ValidationResult::Parsed(parsed)) = validate_frame(&frame, &typed_context()) else {
        panic!("type 5 did not parse");
    };
    match parsed.typed.as_deref() {
        Some(TypedPayload::RecipientPayload {
            schema_version: 2,
            crypto_box_envelope: Some(envelope),
            ..
        }) => assert_eq!(envelope, &[0xa0]),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(outcome(&production_type5(65_535)), "Unsupported@S83");

    let payload = cbor_map(vec![
        (0, CborValue::Text(NET.to_string())),
        (1, acct1(9)),
        (2, acct1(3)),
        (3, int(1)),
        (4, CborValue::Bytes(vec![0xa0])),
        (5, hex_bytes(T3C_EPHEMERAL)),
        (6, hex_bytes(T3C_SHARED)),
        (7, hex_bytes(T3C_PROOF)),
        (8, CborValue::Bytes(vec![1])),
    ]);
    let future = encode_frame(
        EnvelopeFields {
            type_id: 5,
            schema_version: 3,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .unwrap();
    assert_eq!(outcome(&future), "Unsupported@S7");
}

fn statement(schema: u32, subject: CborValue, revision: u64, key: Option<CborValue>) -> Vec<u8> {
    let mut fields = vec![
        (0, CborValue::Text(NET.to_string())),
        (1, subject),
        (2, int(i128::from(revision))),
        (3, ts(1_700_000_000, 0)),
        (
            4,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Bytes(bytes_of(16, 1))),
                (
                    1,
                    CborValue::Text("https://relay.example/frank".to_string()),
                ),
                (2, acct1(21)),
                (3, ts(1_800_000_000, 0)),
            ])]),
        ),
    ];
    if let Some(key) = key {
        fields.push((8, key));
    }
    encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version: schema,
            min_reader_version: schema,
        },
        FramePayload::Value(&cbor_map(fields)),
    )
    .unwrap()
}

fn attestation(statement: Vec<u8>, signer: CborValue) -> Vec<u8> {
    fr(
        2,
        &cbor_map(vec![
            (0, CborValue::Bytes(statement)),
            (
                1,
                CborValue::Array(vec![cbor_map(vec![
                    (0, int(16)),
                    (1, signer),
                    (2, CborValue::Bytes(bytes_of(64, 1))),
                ])]),
            ),
        ]),
    )
}

fn update_outcome(prior: Vec<u8>, next: Vec<u8>) -> String {
    let mut ctx = typed_context();
    ctx.prior = PriorStatement::Frame(prior);
    match validate_frame(&next, &ctx) {
        Ok(ValidationResult::Parsed(_)) => "parsed".to_string(),
        Ok(_) => "other".to_string(),
        Err(Error::Codec(e)) => format!("{:?}@{:?}", e.category, e.stage),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn a_same_subject_statement_cannot_lower_its_schema() {
    let key = || Some(stamp_account(T3C_STAMP_KEY));
    let prior = statement(2, acct2(1), 5, key());
    // Schema 1 after schema 2, same subject: S10a.2.
    assert_eq!(
        update_outcome(
            prior.clone(),
            attestation(statement(1, acct2(1), 6, None), acct2(1))
        ),
        format!(
            "{:?}@{:?}",
            ErrorCategory::Semantic,
            frank_cbor::ErrorStage::S9
        )
    );
    // Schema 2 after schema 2 and schema 2 after schema 1 are fine.
    assert_eq!(
        update_outcome(
            prior,
            attestation(statement(2, acct2(1), 6, key()), acct2(1))
        ),
        "parsed"
    );
    assert_eq!(
        update_outcome(
            statement(1, acct2(1), 5, None),
            attestation(statement(2, acct2(1), 6, key()), acct2(1))
        ),
        "parsed"
    );
}

#[test]
fn stamp_key_shape() {
    let good = statement(2, acct2(1), 5, Some(stamp_account(T3C_STAMP_KEY)));
    assert_eq!(outcome(&good), "parsed");
    // Missing in schema 2, present in schema 1.
    assert_eq!(outcome(&statement(2, acct2(1), 5, None)), "Schema@S82");
    assert_eq!(
        outcome(&statement(
            1,
            acct2(1),
            5,
            Some(stamp_account(T3C_STAMP_KEY))
        )),
        "Schema@S82"
    );
    // Key type 2 is allocated but is not a stamp key.
    let ed = cbor_map(vec![(0, int(2)), (1, CborValue::Bytes(bytes_of(32, 5)))]);
    assert_eq!(outcome(&statement(2, acct2(1), 5, Some(ed))), "Semantic@S9");
}
