//! The account-registration corpus of README section 11 (docs/protocol/cbor/vectors/
//! account-registration.json) and its pure-value vectors, evaluated in both languages with
//! exact category, stage, and content-hash parity, plus the stage-10.6 crypto properties.

mod common;

use frank_cbor::{
    address_from_compressed_pubkey, address_from_uncompressed_pubkey, content_hash,
    directory_signature_digest, expiry_timestamp, has_low_s, join_ms, keccak256,
    key_transition_signature_digest, parse_strict_der, registration_from_ms, split_timestamp_ms,
    uncompressed_pubkey_xy, validate_frame, verify_algorithm_1, Error, ErrorCategory, ErrorStage,
    Operation, ParsedFrame, PriorStatement, SupportedSchema, ValidationContext, ValidationResult,
    KNOWN_TYPES, MAX_FRAME_BYTES,
};

use common::NET;

fn hex(s: &str) -> Vec<u8> {
    hex::decode(s).expect("hex")
}

fn registration_manifest() -> serde_json::Value {
    let text = include_str!("../../../../docs/protocol/cbor/vectors/account-registration.json");
    serde_json::from_str(text).expect("registration json")
}

fn registration_values() -> serde_json::Value {
    let text =
        include_str!("../../../../docs/protocol/cbor/vectors/account-registration-values.json");
    serde_json::from_str(text).expect("registration values json")
}

fn context_from_json(value: &serde_json::Value) -> ValidationContext {
    let operation = match value["operation"].as_str().expect("operation") {
        "typed" => Operation::Typed,
        "full" => Operation::Full,
        other => panic!("unexpected operation {other}"),
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
    ValidationContext {
        operation,
        route_byte_limit: value["route_byte_limit"].as_u64().expect("route"),
        reader_version: value["reader_version"].as_u64().expect("reader") as u32,
        supported_schemas: value["supported_schemas"]
            .as_array()
            .expect("supported_schemas")
            .iter()
            .map(|s| SupportedSchema {
                type_id: s["type_id"].as_u64().expect("type_id") as u32,
                schema_version: s["schema_version"].as_u64().expect("schema") as u32,
            })
            .collect(),
        opaque_retention_allowed: value["opaque_retention_allowed"]
            .as_bool()
            .expect("retention"),
        prior: match value.get("prior_directory_statement_frame_hex") {
            None | Some(serde_json::Value::Null) => PriorStatement::None,
            Some(text) => PriorStatement::Frame(hex(text.as_str().expect("prior hex"))),
        },
    }
}

fn case_frame(case: &serde_json::Value) -> Vec<u8> {
    hex(case["frame_hex"].as_str().expect("frame_hex"))
}

fn case_id(case: &serde_json::Value) -> &str {
    case["id"].as_str().expect("id")
}

#[test]
fn every_registration_case_matches_its_recorded_outcome() {
    let manifest = registration_manifest();
    assert_eq!(manifest["format"], "frank-cbor-v1-vectors");
    let cases = manifest["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 28, "the corpus has 28 cases");
    let mut failures = Vec::new();
    for case in cases {
        let id = case_id(case);
        let frame = case_frame(case);
        let ctx = context_from_json(&case["validation_context"]);
        let expectation = case["expectation"].as_str().expect("expectation");
        let observed = match validate_frame(&frame, &ctx) {
            Ok(ValidationResult::Parsed(parsed)) => {
                if let Some(want) = case["content_hash_hex"].as_str() {
                    let got = hex::encode(content_hash(&parsed).expect("content hash"));
                    if got != want {
                        failures.push(format!("{id}: content hash {got} != {want}"));
                    }
                }
                if parsed.frame != frame {
                    failures.push(format!("{id}: parsed frame bytes differ"));
                }
                Outcome::Accept
            }
            Ok(_) => {
                failures.push(format!("{id}: unexpected result kind"));
                continue;
            }
            Err(Error::Codec(error)) => Outcome::Reject(error.category, error.stage),
            Err(Error::Context(error)) => {
                failures.push(format!("{id}: context error: {error}"));
                continue;
            }
        };
        match (&observed, expectation) {
            (Outcome::Accept, "accept") => {}
            (Outcome::Reject(category, stage), "reject") => {
                let want = format!(
                    "{}@{}",
                    case["error_category"].as_str().expect("error_category"),
                    case["error_stage"].as_str().expect("error_stage")
                );
                let got = format!("{}@{}", category.as_str(), stage.as_str());
                if got != want {
                    failures.push(format!("{id}: got {got}, expected {want}"));
                }
            }
            (other, want) => {
                failures.push(format!(
                    "{id}: got {}, expected {want}",
                    match other {
                        Outcome::Accept => "accept".to_string(),
                        Outcome::Reject(category, stage) => {
                            format!("reject {}@{}", category.as_str(), stage.as_str())
                        }
                    }
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// One observed outcome of a corpus case.
enum Outcome {
    Accept,
    Reject(ErrorCategory, ErrorStage),
}

#[test]
fn m2_maps_milliseconds_losslessly() {
    let values = registration_values();
    for v in values["timestamp_mappings"].as_array().expect("mappings") {
        let ms = v["timestamp_ms"]
            .as_str()
            .expect("ms")
            .parse::<i64>()
            .expect("i64");
        let (revision, timestamp) = registration_from_ms(ms).expect("encodable");
        assert_eq!(
            revision.to_string(),
            v["revision"].as_str().expect("revision")
        );
        assert_eq!(
            timestamp.seconds.to_string(),
            v["seconds"].as_str().expect("seconds")
        );
        assert_eq!(
            timestamp.nanoseconds.to_string(),
            v["nanoseconds"].as_str().expect("nanos")
        );
        assert_eq!(
            join_ms(timestamp.seconds, timestamp.nanoseconds).expect("join") as i64,
            ms
        );
    }
    for v in values["timestamp_unencodable"].as_array().expect("unenc") {
        let ms = v["timestamp_ms"]
            .as_str()
            .expect("ms")
            .parse::<i64>()
            .expect("i64");
        assert!(
            registration_from_ms(ms).is_err(),
            "negative ms must fail closed"
        );
    }
}

#[test]
fn m3_expires_with_floor_semantics() {
    let values = registration_values();
    for v in values["expiry_mappings"].as_array().expect("mappings") {
        let ms = v["timestamp_ms"]
            .as_str()
            .expect("ms")
            .parse::<i64>()
            .expect("i64");
        let ttl = v["ttl_ms"]
            .as_str()
            .expect("ttl")
            .parse::<i64>()
            .expect("i64");
        let expiry = expiry_timestamp(ms, ttl).expect("expiry");
        assert_eq!(
            expiry.seconds.to_string(),
            v["expiry_seconds"].as_str().expect("seconds")
        );
        assert_eq!(
            expiry.nanoseconds.to_string(),
            v["expiry_nanoseconds"].as_str().expect("nanos")
        );
    }
    let negative = split_timestamp_ms(-1500).expect("negative totals are encodable");
    assert_eq!(negative.seconds, -2);
    assert_eq!(negative.nanoseconds, 500_000_000);
    assert!(join_ms(0, 1).is_err(), "nanoseconds must be a ms multiple");
}

#[test]
fn m6_derives_every_address() {
    let values = registration_values();
    for v in values["address_derivations"]
        .as_array()
        .expect("derivations")
    {
        let compressed = hex(v["compressed_pubkey_hex"].as_str().expect("key"));
        let xy = uncompressed_pubkey_xy(&compressed).expect("uncompressed");
        assert_eq!(
            hex::encode(xy),
            v["uncompressed_x_y_hex"].as_str().expect("xy"),
            "uncompressed X||Y of {}",
            v["label"].as_str().expect("label")
        );
        let address = address_from_compressed_pubkey(&compressed).expect("address");
        assert_eq!(
            hex::encode(address),
            v["address_hex"].as_str().expect("address"),
            "address of {}",
            v["label"].as_str().expect("label")
        );
        let mut with_prefix = vec![0x04];
        with_prefix.extend_from_slice(&xy);
        assert_eq!(
            hex::encode(address_from_uncompressed_pubkey(&with_prefix).expect("address")),
            v["address_hex"].as_str().expect("address")
        );
    }
}

#[test]
fn keccak256_matches_the_reference_hash() {
    assert_eq!(
        hex::encode(keccak256(b"")),
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
}

#[test]
fn strict_der_rejects_malformed_and_high_s() {
    let values = registration_values();
    let cases = registration_manifest()["cases"]
        .as_array()
        .expect("cases")
        .clone();
    let find = |id: &str| {
        cases
            .iter()
            .find(|c| c["id"].as_str() == Some(id))
            .expect("case")
            .clone()
    };
    // The malformed-DER and high-S records fail at 10.6 with cryptographic; the raw signature
    // bytes live in the type-2 entry, so parse them directly from the frame.
    let entry_signature = |frame: &[u8]| -> Vec<u8> {
        let parsed = validate_frame(
            frame,
            &ValidationContext {
                operation: Operation::Typed,
                route_byte_limit: MAX_FRAME_BYTES as u64,
                reader_version: 2,
                supported_schemas: KNOWN_TYPES
                    .iter()
                    .map(|t| SupportedSchema {
                        type_id: *t,
                        schema_version: if *t == 4 { 3 } else { 1 },
                    })
                    .collect(),
                opaque_retention_allowed: false,
                prior: PriorStatement::None,
            },
        )
        .expect("typed parse");
        match parsed {
            ValidationResult::Parsed(ParsedFrame {
                typed: Some(typed), ..
            }) => match *typed {
                frank_cbor::TypedPayload::DirectoryAttestation { signatures, .. } => {
                    signatures[0].signature.clone()
                }
                _ => panic!("not an attestation"),
            },
            _ => panic!("not parsed"),
        }
    };
    let malformed = entry_signature(&case_frame(&find("reg-crypto-malformed-der")));
    assert!(
        parse_strict_der(&malformed).is_err(),
        "strict DER must reject"
    );
    let high_s = entry_signature(&case_frame(&find("reg-crypto-high-s")));
    let (_, s) = parse_strict_der(&high_s).expect("well-formed DER with high S");
    assert!(!has_low_s(&s), "s above n/2 must be flagged");
    void(&values);
}

fn void<T>(_: &T) {}

#[test]
fn wrong_network_signature_verifies_only_over_the_ambient_network() {
    // T5: the wrong-network record's signature was made over the monad-testnet transcript of
    // the same statement. An unbound verifier with an ambient testnet network would accept it;
    // the bound digest (field 0, monad-mainnet) rejects it.
    let cases = registration_manifest()["cases"]
        .as_array()
        .expect("cases")
        .clone();
    let case = cases
        .iter()
        .find(|c| c["id"].as_str() == Some("reg-crypto-wrong-network"))
        .expect("case")
        .clone();
    let frame = case_frame(&case);
    let typed_ctx = ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        reader_version: 2,
        supported_schemas: KNOWN_TYPES
            .iter()
            .map(|t| SupportedSchema {
                type_id: *t,
                schema_version: if *t == 4 { 3 } else { 1 },
            })
            .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::None,
    };
    let statement_frame = match validate_frame(&frame, &typed_ctx).expect("typed accepts") {
        ValidationResult::Parsed(ParsedFrame {
            typed: Some(typed), ..
        }) => match *typed {
            frank_cbor::TypedPayload::DirectoryAttestation { statement, .. } => statement.frame,
            _ => panic!("not an attestation"),
        },
        _ => panic!("not parsed"),
    };
    let parsed = validate_frame(&statement_frame, &typed_ctx).expect("statement");
    let network = match &parsed {
        ValidationResult::Parsed(ParsedFrame {
            typed: Some(typed), ..
        }) => match &**typed {
            frank_cbor::TypedPayload::DirectoryStatement { network, .. } => network.clone(),
            _ => panic!("not a statement"),
        },
        _ => panic!("not parsed"),
    };
    assert_eq!(network, "monad-mainnet");
    let (subject, signature) = match validate_frame(&frame, &typed_ctx).expect("typed") {
        ValidationResult::Parsed(ParsedFrame {
            typed: Some(typed), ..
        }) => match *typed {
            frank_cbor::TypedPayload::DirectoryAttestation { signatures, .. } => (
                signatures[0].signer.clone(),
                signatures[0].signature.clone(),
            ),
            _ => panic!("not an attestation"),
        },
        _ => panic!("not parsed"),
    };
    assert!(verify_algorithm_1(
        &directory_signature_digest("monad-testnet", &statement_frame),
        &signature,
        &subject.key_bytes,
    ));
    assert!(!verify_algorithm_1(
        &directory_signature_digest(&network, &statement_frame),
        &signature,
        &subject.key_bytes,
    ));
    // The full operation rejects it at 10.6.
    let error = validate_frame(&frame, &context_from_json(&case["validation_context"]))
        .expect_err("full rejects");
    match error {
        Error::Codec(codec) => {
            assert_eq!(codec.category, ErrorCategory::Cryptographic);
            assert_eq!(codec.stage, ErrorStage::S106);
        }
        other => panic!("expected a codec error, got {other:?}"),
    }
}

#[test]
fn full_type1_root_is_a_context_error() {
    let frame = common::direct_message_frame();
    let error = validate_frame(
        &frame,
        &ValidationContext {
            operation: Operation::Full,
            ..common::typed_context()
        },
    )
    .expect_err("type-1 full is outside the slice");
    assert!(matches!(error, Error::Context(_)));
}

#[test]
fn a_full_type2_transition_authorization_verifies() {
    // Built with real keys via the secp256k1-abc test surface: secret 1 is the subject,
    // secret 2 the prior authority signing the type-7 frame. The corpus has no transition
    // case, so the T2a path is pinned here.
    use secp256k1_abc::{PublicKey, Secp256k1, SecretKey};

    let secp = Secp256k1::signing_only();
    let subject_secret = SecretKey::from_slice(&[1u8; 32]).expect("secret");
    let prior_secret = SecretKey::from_slice(&[2u8; 32]).expect("secret");
    let subject_key = PublicKey::from_secret_key(&secp, &subject_secret).serialize();
    let prior_key = PublicKey::from_secret_key(&secp, &prior_secret).serialize();
    let account = |key: &[u8]| common::stamp_account(&hex::encode(key));
    let relay = |id: u8, key: &[u8]| {
        frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Bytes(vec![id; 16])),
            (
                1,
                frank_cbor::CborValue::Text("https://relay.example/r".to_string()),
            ),
            (2, account(key)),
            (3, common::ts(1_800_000_000, 0)),
        ])
    };
    let prior_statement = common::fr(
        4,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&prior_key)),
            (2, frank_cbor::CborValue::Int(9)),
            (3, common::ts(1_700_000_000, 0)),
            (4, frank_cbor::CborValue::Array(vec![relay(1, &prior_key)])),
            (8, account(&subject_key)),
        ]),
    );
    let transition_statement = common::fr(
        7,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&prior_key)),
            (2, account(&prior_key)),
            (3, frank_cbor::CborValue::Int(10)),
            (4, account(&subject_key)),
        ]),
    );
    let digest = key_transition_signature_digest(NET, &transition_statement);
    let transition_signature = Secp256k1::signing_only()
        .sign(
            &secp256k1_abc::Message::from_slice(&digest).expect("32 bytes"),
            &prior_secret,
        )
        .serialize_der()
        .to_vec();
    let statement = common::fr(
        4,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&subject_key)),
            (2, frank_cbor::CborValue::Int(10)),
            (3, common::ts(1_700_000_100, 0)),
            (
                4,
                frank_cbor::CborValue::Array(vec![relay(2, &subject_key)]),
            ),
            (
                5,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (
                        0,
                        frank_cbor::CborValue::Bytes(transition_statement.clone()),
                    ),
                    (1, frank_cbor::CborValue::Int(1)),
                    (2, account(&prior_key)),
                    (
                        3,
                        frank_cbor::CborValue::Bytes(transition_signature.clone()),
                    ),
                ])]),
            ),
            (8, account(&subject_key)),
        ]),
    );
    let attestation_digest = directory_signature_digest(NET, &statement);
    let attestation_signature = Secp256k1::signing_only()
        .sign(
            &secp256k1_abc::Message::from_slice(&attestation_digest).expect("32 bytes"),
            &subject_secret,
        )
        .serialize_der()
        .to_vec();
    let attestation = common::fr(
        2,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Bytes(statement)),
            (
                1,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Int(1)),
                    (1, account(&subject_key)),
                    (2, frank_cbor::CborValue::Bytes(attestation_signature)),
                ])]),
            ),
        ]),
    );
    let ctx = ValidationContext {
        operation: Operation::Full,
        route_byte_limit: MAX_FRAME_BYTES as u64,
        reader_version: 2,
        supported_schemas: KNOWN_TYPES
            .iter()
            .map(|t| SupportedSchema {
                type_id: *t,
                schema_version: if *t == 4 { 3 } else { 1 },
            })
            .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::Frame(prior_statement),
    };
    assert!(validate_frame(&attestation, &ctx).is_ok());
    // Corrupt the transition signature: the record rejects at 10.6.
    let mut corrupted = transition_signature.clone();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0x01;
    let bad_statement = common::fr(
        4,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&subject_key)),
            (2, frank_cbor::CborValue::Int(10)),
            (3, common::ts(1_700_000_100, 0)),
            (
                4,
                frank_cbor::CborValue::Array(vec![relay(2, &subject_key)]),
            ),
            (
                5,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Bytes(transition_statement)),
                    (1, frank_cbor::CborValue::Int(1)),
                    (2, account(&prior_key)),
                    (3, frank_cbor::CborValue::Bytes(corrupted)),
                ])]),
            ),
            (8, account(&subject_key)),
        ]),
    );
    let bad_digest = directory_signature_digest(NET, &bad_statement);
    let bad_signature = Secp256k1::signing_only()
        .sign(
            &secp256k1_abc::Message::from_slice(&bad_digest).expect("32 bytes"),
            &subject_secret,
        )
        .serialize_der()
        .to_vec();
    let bad_attestation = common::fr(
        2,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Bytes(bad_statement)),
            (
                1,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Int(1)),
                    (1, account(&subject_key)),
                    (2, frank_cbor::CborValue::Bytes(bad_signature)),
                ])]),
            ),
        ]),
    );
    let error = validate_frame(&bad_attestation, &ctx).expect_err("corrupted transition");
    match error {
        Error::Codec(codec) => {
            assert_eq!(codec.category, ErrorCategory::Cryptographic);
            assert_eq!(codec.stage, ErrorStage::S106);
        }
        other => panic!("expected a codec error, got {other:?}"),
    }
}
