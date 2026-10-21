//! The stamp fields of #198 at the typed level: type-11 schema-1 fields 6 through 8 and schema-2
//! fields 5 through 7 (README T3a, T3b encoding rules), the type-1 stamp key (S10a.1), and the
//! same-subject schema order (S10a.2).
//! The manifest carries the vectors; these tests pin the boundaries and the typed projection.

mod common;

use frank_cbor::message_fields::{
    account_ref, directory_attestation as att, directory_statement as stmt, encryption_suite,
    key_type, recipient_encrypted_payload_v1 as rep1, recipient_encrypted_payload_v2 as rep2,
    relay_binding, signature_algorithm, signature_entry,
};
use frank_cbor::message_types::{
    TYPE_DIRECTORY_ATTESTATION, TYPE_DIRECTORY_STATEMENT, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
};
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
    fr(TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, &cbor_map(fields))
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
        (rep2::NETWORK, CborValue::Text(NET.to_string())),
        (rep2::SENDER, acct1(9)),
        (rep2::RECIPIENT, acct1(3)),
        (rep2::SUITE, int(i128::from(suite))),
        (rep2::CRYPTO_BOX_ENVELOPE, CborValue::Bytes(vec![0xa0])),
        (rep2::EPHEMERAL_POINT, hex_bytes(T3C_EPHEMERAL)),
        (rep2::SHARED_POINT, hex_bytes(T3C_SHARED)),
        (rep2::DLEQ_PROOF, hex_bytes(T3C_PROOF)),
    ]);
    encode_frame(
        EnvelopeFields {
            type_id: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .expect("schema-2 type 11")
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
    assert_eq!(
        outcome(&type5_with(rep1::EPHEMERAL_POINT, Some(point(2, ONE)))),
        "parsed"
    );
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
        for key in [rep1::EPHEMERAL_POINT, rep1::SHARED_POINT] {
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
        outcome(&type5_with(rep1::DLEQ_PROOF, proof(&n_minus_1, &n_minus_1))),
        "parsed"
    );
    for (name, c, s) in [
        ("c = 0", ONE.replace('1', "0"), good_s.to_string()),
        ("c = n", N.to_string(), good_s.to_string()),
        ("s = 0", good_c.to_string(), ONE.replace('1', "0")),
        ("s = n", good_c.to_string(), N.to_string()),
    ] {
        assert_eq!(
            outcome(&type5_with(rep1::DLEQ_PROOF, proof(&c, &s))),
            "Schema@S82",
            "{name}"
        );
    }
    for key in [rep1::EPHEMERAL_POINT, rep1::SHARED_POINT, rep1::DLEQ_PROOF] {
        assert_eq!(
            outcome(&type5_with(key, None)),
            "Schema@S82",
            "missing {key}"
        );
    }
}

#[test]
fn typed_projection_carries_the_stamp_fields() {
    let frame = type5_with(rep1::EPHEMERAL_POINT, Some(hex_bytes(T3C_EPHEMERAL)));
    let Ok(ValidationResult::Parsed(parsed)) = validate_frame(&frame, &typed_context()) else {
        panic!("type 11 did not parse");
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
        panic!("type 11 did not parse");
    };
    match parsed.typed.as_deref() {
        Some(TypedPayload::RecipientPayload {
            schema_version: 2,
            crypto_box_envelope: Some(envelope),
            ..
        }) => assert_eq!(envelope, &[0xa0]),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(
        outcome(&production_type5(encryption_suite::PROOF)),
        "Unsupported@S83"
    );

    let payload = cbor_map(vec![
        (rep2::NETWORK, CborValue::Text(NET.to_string())),
        (rep2::SENDER, acct1(9)),
        (rep2::RECIPIENT, acct1(3)),
        (rep2::SUITE, int(encryption_suite::DM_AUTH_XCHACHA.into())),
        (rep2::CRYPTO_BOX_ENVELOPE, CborValue::Bytes(vec![0xa0])),
        (rep2::EPHEMERAL_POINT, hex_bytes(T3C_EPHEMERAL)),
        (rep2::SHARED_POINT, hex_bytes(T3C_SHARED)),
        (rep2::DLEQ_PROOF, hex_bytes(T3C_PROOF)),
        (8, CborValue::Bytes(vec![1])), // raw-cbor-key: a field schema 2 does not declare
    ]);
    let wrong_min_reader = encode_frame(
        EnvelopeFields {
            type_id: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
            schema_version: 2,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .unwrap();
    assert_eq!(outcome(&wrong_min_reader), "Unsupported@S7");
    let future = encode_frame(
        EnvelopeFields {
            type_id: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
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
        (stmt::NETWORK, CborValue::Text(NET.to_string())),
        (stmt::SUBJECT, subject),
        (stmt::REVISION, int(i128::from(revision))),
        (stmt::TIMESTAMP, ts(1_700_000_000, 0)),
        (
            stmt::RELAYS,
            CborValue::Array(vec![cbor_map(vec![
                (relay_binding::RELAY_ID, CborValue::Bytes(bytes_of(16, 1))),
                (
                    relay_binding::ENDPOINT,
                    CborValue::Text("https://relay.example/frank".to_string()),
                ),
                (relay_binding::IDENTITY, acct1(21)),
                (relay_binding::EXPIRY, ts(1_800_000_000, 0)),
            ])]),
        ),
    ];
    if let Some(key) = key {
        fields.push((stmt::STAMP_KEY, key));
    }
    encode_frame(
        EnvelopeFields {
            type_id: TYPE_DIRECTORY_STATEMENT,
            schema_version: schema,
            min_reader_version: schema,
        },
        FramePayload::Value(&cbor_map(fields)),
    )
    .unwrap()
}

fn attestation(statement: Vec<u8>, signer: CborValue) -> Vec<u8> {
    fr(
        TYPE_DIRECTORY_ATTESTATION,
        &cbor_map(vec![
            (att::STATEMENT_FRAME, CborValue::Bytes(statement)),
            (
                att::SIGNATURES,
                CborValue::Array(vec![cbor_map(vec![
                    (
                        signature_entry::ALGORITHM,
                        int(signature_algorithm::ED25519.into()),
                    ),
                    (signature_entry::SIGNER, signer),
                    (
                        signature_entry::SIGNATURE,
                        CborValue::Bytes(bytes_of(64, 1)),
                    ),
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
    let ed = cbor_map(vec![
        (account_ref::KEY_TYPE, int(key_type::ED25519.into())),
        (account_ref::KEY_BYTES, CborValue::Bytes(bytes_of(32, 5))),
    ]);
    assert_eq!(outcome(&statement(2, acct2(1), 5, Some(ed))), "Semantic@S9");
}
