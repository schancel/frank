//! Shared codec outcomes, exact reviewed bytes and the non-admission boundary.
mod common;
use frank_cbor::{
    content_hash, decode_canonical, default_context, encode_canonical, encode_frame,
    preview_directory_context, validate_frame, verify_preview_directory_evidence, CborValue,
    EnvelopeFields, Error, FramePayload, Operation, ParsedFrame, PriorStatement, TypedPayload,
    ValidationResult,
};
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(common::repo_path(
            "../../../docs/protocol/cbor/vectors/directory-preview.json",
        ))
        .unwrap(),
    )
    .unwrap()
}
fn record<'a>(c: &'a Value, id: &str) -> &'a Value {
    c["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
}
fn bytes(r: &Value, field: &str) -> Vec<u8> {
    hex::decode(r[field].as_str().unwrap()).unwrap()
}
fn parse(bytes: &[u8]) -> ParsedFrame {
    let ValidationResult::Parsed(p) = validate_frame(bytes, &preview_directory_context()).unwrap()
    else {
        panic!("not parsed")
    };
    p
}
fn payload() -> CborValue {
    parse(&bytes(record(&corpus(), "bootstrap"), "type4_hex")).payload
}
fn statement(p: &CborValue, schema: u32, floor: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version: schema,
            min_reader_version: floor,
        },
        FramePayload::Value(p),
    )
    .unwrap()
}
fn set(p: &mut CborValue, key: u64, value: CborValue) {
    let CborValue::Map(entries) = p else {
        panic!("map")
    };
    entries.retain(|(k, _)| *k != key);
    entries.push((key, value));
    entries.sort_by_key(|(k, _)| *k);
}

#[test]
fn reviewed_corpus_has_identical_cross_language_signed_evidence_outcomes() {
    let c = corpus();
    for r in c["records"].as_array().unwrap() {
        let result = verify_preview_directory_evidence(&bytes(r, "type2_hex"), "monad-testnet");
        let id = r["id"].as_str().unwrap();
        if r["expected"]["category"] == "accept" {
            let e = result.unwrap_or_else(|err| panic!("{id}: {err}"));
            assert_eq!(e.statement_frame().frame, bytes(r, "type4_hex"), "{id}");
            assert_eq!(e.attestation_frame.frame, bytes(r, "type2_hex"), "{id}");
            assert_eq!(hex::encode(e.statement_hash), r["t1"], "{id}");
            assert_eq!(hex::encode(e.signature_digest), r["t2_digest"], "{id}");
            assert_eq!(
                encode_canonical(&e.statement_frame().payload).unwrap(),
                e.statement_frame().payload_bytes
            );
            assert_eq!(
                encode_canonical(&decode_canonical(&e.attestation_frame.frame[9..]).unwrap())
                    .unwrap(),
                e.attestation_frame.frame[9..]
            );
        } else {
            let Error::Codec(err) = result.expect_err(id) else {
                panic!("{id}: expected codec error")
            };
            assert_eq!(err.category.to_string(), r["expected"]["category"], "{id}");
            assert_eq!(err.stage.to_string(), r["expected"]["stage"], "{id}");
        }
        let mut ctx = default_context();
        ctx.operation = Operation::Full;
        let old = validate_frame(&bytes(r, "type2_hex"), &ctx);
        if r["old_reader"] == "accept" {
            assert!(old.is_ok(), "{id}: {old:?}");
        } else {
            let Error::Codec(err) = old.expect_err(id) else {
                panic!("codec")
            };
            assert_eq!(err.category.to_string(), r["old_reader"], "{id}");
        }
    }
}

#[test]
fn old_readers_and_full_admission_fail_closed() {
    let c = corpus();
    let r = record(&c, "bootstrap");
    assert_eq!(default_context().reader_version, 2);
    assert_eq!(
        default_context()
            .supported_schemas
            .iter()
            .find(|s| s.type_id == 4)
            .unwrap()
            .schema_version,
        3
    );
    for field in ["type4_hex", "type2_hex"] {
        for reader in [1, 2, 3] {
            let mut ctx = default_context();
            ctx.reader_version = reader;
            let Error::Codec(err) = validate_frame(&bytes(r, field), &ctx).unwrap_err() else {
                panic!("codec")
            };
            assert_eq!(err.category.to_string(), "unsupported");
            assert_eq!(err.stage.to_string(), "7");
        }
        let mut ctx = preview_directory_context();
        ctx.operation = Operation::Full;
        assert!(matches!(
            validate_frame(&bytes(r, field), &ctx),
            Err(Error::Context(_))
        ));
    }
    let mut ctx = preview_directory_context();
    ctx.prior = PriorStatement::Frame(bytes(r, "type4_hex"));
    assert!(matches!(
        validate_frame(&bytes(record(&c, "renew"), "type2_hex"), &ctx),
        Err(Error::Context(_))
    ));
    assert!(matches!(
        verify_preview_directory_evidence(&bytes(r, "type2_hex"), ""),
        Err(Error::Context(_))
    ));
}

#[test]
fn role_fields_uint64_and_optional_bytes_are_preserved_without_lifecycle_claims() {
    let c = corpus();
    let e = verify_preview_directory_evidence(
        &bytes(record(&c, "revision-max"), "type2_hex"),
        "monad-testnet",
    )
    .unwrap();
    let Some(TypedPayload::DirectoryStatement {
        revision,
        preview: Some(roles),
        ..
    }) = e.statement_frame().typed.as_deref()
    else {
        panic!("roles")
    };
    assert_eq!(*revision, u64::MAX);
    assert_eq!(roles.predecessor.as_ref().unwrap().len(), 32);
    let e = verify_preview_directory_evidence(
        &bytes(record(&c, "optional-future"), "type2_hex"),
        "monad-testnet",
    )
    .unwrap();
    let Some(TypedPayload::DirectoryStatement { unknown, .. }) =
        e.statement_frame().typed.as_deref()
    else {
        panic!("statement")
    };
    assert!(unknown.iter().any(|(k, _)| *k == 100));
    assert_eq!(content_hash(e.statement_frame()).unwrap(), e.statement_hash);
    for id in [
        "expired",
        "future-issue",
        "wrong-relay",
        "wrong-predecessor",
        "changed-key-same-generation",
    ] {
        assert!(
            verify_preview_directory_evidence(&bytes(record(&c, id), "type2_hex"), "monad-testnet")
                .is_ok(),
            "{id}"
        );
    }
}

#[test]
fn required_fields_old_schema_smuggling_and_future_unsupported_semantics_reject() {
    for key in [0, 1, 2, 3, 4, 6, 8, 10, 11, 12, 13] {
        let CborValue::Map(mut entries) = payload() else {
            panic!("map")
        };
        entries.retain(|(k, _)| *k != key);
        assert!(validate_frame(
            &statement(&CborValue::Map(entries), 4, 4),
            &preview_directory_context()
        )
        .is_err());
    }
    for schema in [2, 3] {
        assert!(validate_frame(
            &statement(&payload(), schema, 2),
            &preview_directory_context()
        )
        .is_err());
    }
    for key in [5, 7, 9] {
        let mut p = payload();
        set(&mut p, key, CborValue::Array(vec![]));
        assert!(validate_frame(&statement(&p, 5, 4), &preview_directory_context()).is_err());
    }
    for hex in ["a200000000", "a1180000", "a100"] {
        let raw = hex::decode(hex).unwrap();
        let f = encode_frame(
            EnvelopeFields {
                type_id: 4,
                schema_version: 4,
                min_reader_version: 4,
            },
            FramePayload::Bytes(&raw),
        )
        .unwrap();
        assert!(validate_frame(&f, &preview_directory_context()).is_err());
    }
}

#[test]
fn preview_frame_boundary_does_not_tighten_legacy_projection() {
    let mut p = payload();
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_144]));
    let excess = statement(&p, 5, 4).len() - 262_144;
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_144 - excess]));
    let exact = statement(&p, 5, 4);
    assert_eq!(exact.len(), 262_144);
    assert!(validate_frame(&exact, &preview_directory_context()).is_ok());
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_145 - excess]));
    let Error::Codec(err) =
        validate_frame(&statement(&p, 5, 4), &preview_directory_context()).unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.category.to_string(), "resource");
    assert_eq!(err.stage.to_string(), "8.1");
    assert!(validate_frame(&statement(&p, 5, 2), &default_context()).is_ok());
    let Error::Codec(err) =
        verify_preview_directory_evidence(&vec![0; 262_145], "monad-testnet").unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.stage.to_string(), "1");
}

#[test]
fn rust_independently_constructs_and_signs_the_reviewed_bootstrap() {
    use frank_cbor::{cbor_map, directory_signature_digest};
    use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
    let secp = Secp256k1::new();
    let secret = |n: u8| {
        let mut b = [0; 32];
        b[31] = n;
        SecretKey::from_slice(&b).unwrap()
    };
    let key = |n| {
        cbor_map(vec![
            (0, CborValue::Int(1)),
            (
                1,
                CborValue::Bytes(
                    PublicKey::from_secret_key(&secp, &secret(n))
                        .serialize()
                        .to_vec(),
                ),
            ),
        ])
    };
    let time = |s| cbor_map(vec![(0, CborValue::Int(s)), (1, CborValue::Int(0))]);
    let relay = cbor_map(vec![
        (0, CborValue::Bytes((0..16).collect())),
        (1, CborValue::Text("https://relay.example.invalid".into())),
        (2, key(4)),
        (3, time(1_700_007_200)),
    ]);
    let p = cbor_map(vec![
        (0, CborValue::Text("monad-testnet".into())),
        (1, key(1)),
        (2, CborValue::Int(0)),
        (3, time(1_700_000_000)),
        (4, CborValue::Array(vec![relay])),
        (6, time(1_700_003_600)),
        (8, key(3)),
        (10, key(2)),
        (11, CborValue::Int(0)),
        (12, CborValue::Int(0)),
        (13, CborValue::Null),
    ]);
    let type4 = statement(&p, 4, 4);
    let digest = directory_signature_digest("monad-testnet", &type4).unwrap();
    let signature = secp
        .sign(&Message::from_slice(&digest).unwrap(), &secret(1))
        .serialize_der()
        .to_vec();
    let wrapper = cbor_map(vec![
        (0, CborValue::Bytes(type4.clone())),
        (
            1,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, key(1)),
                (2, CborValue::Bytes(signature)),
            ])]),
        ),
    ]);
    let type2 = encode_frame(
        EnvelopeFields {
            type_id: 2,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&wrapper),
    )
    .unwrap();
    let c = corpus();
    let r = record(&c, "rust-origin-bootstrap");
    assert_eq!(type4, bytes(r, "type4_hex"));
    assert_eq!(type2, bytes(r, "type2_hex"));
    assert_eq!(
        verify_preview_directory_evidence(&type2, "monad-testnet")
            .unwrap()
            .statement_hash,
        content_hash(&parse(&type4)).unwrap()
    );
}

#[test]
fn unchanged_wrapper_limit_and_cross_schema_signature_replay_reject() {
    let c = corpus();
    let wrap = |child| {
        let mut p = parse(&bytes(record(&c, "bootstrap"), "type2_hex")).payload;
        set(&mut p, 0, CborValue::Bytes(child));
        encode_frame(
            EnvelopeFields {
                type_id: 2,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&p),
        )
        .unwrap()
    };
    let Error::Codec(err) =
        verify_preview_directory_evidence(&wrap(statement(&payload(), 5, 4)), "monad-testnet")
            .unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.category.to_string(), "cryptographic");
    assert_eq!(err.stage.to_string(), "10.6");
    let mut p = payload();
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_144]));
    let overhead = wrap(statement(&p, 5, 4)).len() - 262_144;
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_144 - overhead]));
    let exact = wrap(statement(&p, 5, 4));
    assert_eq!(exact.len(), 262_144);
    assert!(validate_frame(&exact, &preview_directory_context()).is_ok());
    let Error::Codec(err) = verify_preview_directory_evidence(&exact, "monad-testnet").unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.stage.to_string(), "10.6");
    set(&mut p, 100, CborValue::Bytes(vec![0; 262_145 - overhead]));
    let Error::Codec(err) =
        validate_frame(&wrap(statement(&p, 5, 4)), &preview_directory_context()).unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.category.to_string(), "resource");
    assert_eq!(err.stage.to_string(), "8.1");
}

#[test]
fn uint64_generations_and_nanosecond_window_are_exact() {
    let mut p = payload();
    for key in [2, 11, 12] {
        set(&mut p, key, CborValue::Int(i128::from(u64::MAX)));
    }
    set(&mut p, 13, CborValue::Bytes(vec![0; 32]));
    let result = parse(&statement(&p, 4, 4));
    let Some(TypedPayload::DirectoryStatement {
        preview: Some(roles),
        ..
    }) = result.typed.as_deref()
    else {
        panic!("roles")
    };
    assert_eq!(roles.mailbox_key_generation, u64::MAX);
    assert_eq!(roles.stamp_key_generation, u64::MAX);
    set(
        &mut p,
        6,
        frank_cbor::cbor_map(vec![
            (0, CborValue::Int(1_700_003_600)),
            (1, CborValue::Int(1)),
        ]),
    );
    let Error::Codec(err) =
        validate_frame(&statement(&p, 4, 4), &preview_directory_context()).unwrap_err()
    else {
        panic!("codec")
    };
    assert_eq!(err.category.to_string(), "semantic");
    assert_eq!(err.stage.to_string(), "9");
}
