//! The account-registration corpus of README section 11 (docs/protocol/cbor/vectors/
//! account-registration.json) and its pure-value vectors, evaluated in both languages with
//! exact category, stage, and content-hash parity, plus the stage-10.6 crypto properties.

mod common;

use frank_cbor::{
    address_from_compressed_pubkey, address_from_uncompressed_pubkey, cbor_map, content_hash,
    decode_canonical, default_context, directory_signature_digest, encode_frame, expiry_timestamp,
    has_low_s, join_ms, keccak256, key_transition_signature_digest, parse_strict_der,
    registration_from_ms, split_timestamp_ms, uncompressed_pubkey_xy, validate_frame,
    verify_algorithm_1, CborValue, EnvelopeFields, Error, ErrorCategory, ErrorStage, FramePayload,
    Operation, ParsedFrame, PriorStatement, Projection, SupportedSchema, TypedPayload,
    ValidationContext, ValidationResult, KNOWN_TYPES, MAX_FRAME_BYTES,
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
    let ids: Vec<_> = cases.iter().map(case_id).collect();
    assert_eq!(
        ids,
        [
            "reg-fixture-testnet-statement-typed",
            "reg-fixture-mainnet-statement-typed",
            "reg-fixture-testnet-update-typed",
            "reg-fixture-v63-profile-retained",
            "reg-alg16-recognized-typed",
            "reg-t4-key-32-bytes",
            "reg-t4-key-uncompressed-65",
            "reg-t2-sig-7-bytes",
            "reg-t2-algorithm-unallocated-99",
            "reg-t2-alg1-keytype3",
            "reg-t4-schema2-carries-profile",
            "reg-t4-schema1-carries-profile",
            "reg-t4-network-uppercase",
            "reg-t4-noncanonical-statement",
            "reg-s10a2-schema-downgrade",
            "reg-t4-headers-unsorted",
            "reg-t4-headers-duplicate",
            "reg-fixture-testnet-full",
            "reg-fixture-testnet-minimal-full",
            "reg-fixture-mainnet-full",
            "reg-fixture-testnet-update-full",
            "reg-crypto-sig-mutation",
            "reg-crypto-wrong-network",
            "reg-crypto-wrong-domain",
            "reg-crypto-malformed-der",
            "reg-crypto-high-s",
            "reg-crypto-subject-not-point",
            "reg-unsupported-alg16-entry",
            "reg-t2a-rust-known-answer-full",
            "reg-m7-transition-precedes-corrupt-outer",
        ]
    );
    let values = registration_values();
    let pinned_ids: Vec<_> = values["manifest_case_ids"]
        .as_array()
        .expect("manifest case ids")
        .iter()
        .map(|id| id.as_str().expect("case id"))
        .collect();
    assert_eq!(ids, pinned_ids);
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

#[test]
fn default_context_types_schema_3_profile_entries() {
    let manifest = registration_manifest();
    let case = manifest["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case_id(case) == "reg-fixture-testnet-statement-typed")
        .expect("schema-3 fixture");
    let result = validate_frame(&case_frame(case), &frank_cbor::default_context())
        .expect("default reader accepts schema 3");
    let ValidationResult::Parsed(ParsedFrame {
        typed: Some(typed), ..
    }) = result
    else {
        panic!("not a typed frame");
    };
    let TypedPayload::DirectoryAttestation { statement, .. } = *typed else {
        panic!("not an attestation");
    };
    assert_eq!(statement.projection, Projection::Exact);
    let Some(statement_typed) = statement.typed else {
        panic!("statement not typed");
    };
    let TypedPayload::DirectoryStatement {
        profile_entries,
        unknown,
        ..
    } = *statement_typed
    else {
        panic!("not a directory statement");
    };
    assert_eq!(profile_entries.expect("profile entries").len(), 2);
    assert!(unknown.is_empty());
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
    assert!(
        join_ms(0, 1_000_000_000).is_err(),
        "nanoseconds must be in the timestamp range"
    );
    assert!(
        join_ms(0, 4_000_000_000).is_err(),
        "large millisecond multiples must not normalize into seconds"
    );
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
fn rust_originated_t2a_known_answer_is_pinned() {
    let values = registration_values();
    let vectors = values["key_transition_authorizations"]
        .as_array()
        .expect("T2a vectors");
    assert_eq!(vectors.len(), 1);
    let vector = &vectors[0];
    assert_eq!(vector["id"], "t2a-rust-secret-2");
    let transition = hex(vector["transition_statement_frame_hex"]
        .as_str()
        .expect("transition frame"));
    let digest =
        key_transition_signature_digest(vector["network"].as_str().expect("network"), &transition)
            .expect("T2a digest");
    assert_eq!(hex::encode(digest), vector["digest_hex"]);
    assert!(verify_algorithm_1(
        &digest,
        &hex(vector["signature_der_hex"].as_str().expect("signature")),
        &hex(vector["signer_public_key_hex"]
            .as_str()
            .expect("signer key")),
    ));
    let manifest = registration_manifest();
    let case = manifest["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case_id(case) == vector["attestation_case_id"])
        .expect("linked attestation case");
    assert_eq!(
        case["validation_context"]["prior_directory_statement_frame_hex"],
        vector["prior_statement_frame_hex"]
    );
    let ValidationResult::Parsed(parsed) = validate_frame(
        &case_frame(case),
        &context_from_json(&case["validation_context"]),
    )
    .expect("linked attestation validates") else {
        panic!("linked attestation was not parsed");
    };
    let Some(typed) = parsed.typed else {
        panic!("linked attestation was not typed");
    };
    let TypedPayload::DirectoryAttestation { statement, .. } = *typed else {
        panic!("linked case was not an attestation");
    };
    let Some(statement_typed) = statement.typed else {
        panic!("linked statement was not typed");
    };
    let TypedPayload::DirectoryStatement {
        network,
        key_transitions: Some(transitions),
        ..
    } = *statement_typed
    else {
        panic!("linked statement had no transitions");
    };
    assert_eq!(network, vector["network"]);
    assert_eq!(transitions.len(), 1);
    let entry = &transitions[0];
    assert_eq!(
        hex::encode(&entry.statement.frame),
        vector["transition_statement_frame_hex"]
    );
    assert_eq!(
        hex::encode(&entry.signer.key_bytes),
        vector["signer_public_key_hex"]
    );
    assert_eq!(hex::encode(&entry.signature), vector["signature_der_hex"]);
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
    assert!(
        parse_strict_der(&hex("3006020100020101")).is_err(),
        "zero r must reject"
    );
    assert!(
        parse_strict_der(&hex("3006020101020100")).is_err(),
        "zero s must reject"
    );
    assert!(
        parse_strict_der(&hex("3006020101020101")).is_ok(),
        "r=1, s=1 is structurally valid DER"
    );
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
        &directory_signature_digest("monad-testnet", &statement_frame).expect("digest"),
        &signature,
        &subject.key_bytes,
    ));
    assert!(!verify_algorithm_1(
        &directory_signature_digest(&network, &statement_frame).expect("digest"),
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
fn transcript_digest_helpers_reject_oversized_networks_without_panicking() {
    let oversized = "a".repeat(65_536);
    assert!(directory_signature_digest(&oversized, &[]).is_err());
    assert!(key_transition_signature_digest(&oversized, &[]).is_err());
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
fn unsupported_algorithm_precedes_any_signature_verification() {
    let manifest = registration_manifest();
    let case = manifest["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case_id(case) == "reg-fixture-testnet-minimal-full")
        .expect("minimal fixture");
    let frame = case_frame(case);
    let CborValue::Map(envelope) = decode_canonical(&frame[9..]).expect("envelope") else {
        panic!("envelope not a map");
    };
    let payload_bytes = envelope
        .iter()
        .find(|(key, _)| *key == 3)
        .and_then(|(_, value)| match value {
            CborValue::Bytes(bytes) => Some(bytes),
            _ => None,
        })
        .expect("payload bytes");
    let CborValue::Map(payload) = decode_canonical(payload_bytes).expect("payload") else {
        panic!("payload not a map");
    };
    let statement = payload
        .iter()
        .find(|(key, _)| *key == 0)
        .map(|(_, value)| value.clone())
        .expect("statement");
    let entries = payload
        .iter()
        .find(|(key, _)| *key == 1)
        .and_then(|(_, value)| match value {
            CborValue::Array(entries) => Some(entries),
            _ => None,
        })
        .expect("signature entries");
    let CborValue::Map(mut corrupted) = entries[0].clone() else {
        panic!("signature entry not a map");
    };
    let signature = corrupted
        .iter_mut()
        .find(|(key, _)| *key == 2)
        .and_then(|(_, value)| match value {
            CborValue::Bytes(bytes) => Some(bytes),
            _ => None,
        })
        .expect("signature bytes");
    *signature.last_mut().expect("non-empty signature") ^= 1;
    let unsupported = cbor_map(vec![
        (0, CborValue::Int(16)),
        (
            1,
            cbor_map(vec![
                (0, CborValue::Int(2)),
                (1, CborValue::Bytes(vec![7; 32])),
            ]),
        ),
        (2, CborValue::Bytes(vec![3; 64])),
    ]);
    let payload = cbor_map(vec![
        (0, statement),
        (
            1,
            CborValue::Array(vec![CborValue::Map(corrupted), unsupported]),
        ),
    ]);
    let mixed = encode_frame(
        EnvelopeFields {
            type_id: 2,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .expect("mixed attestation");
    let error = validate_frame(&mixed, &context_from_json(&case["validation_context"]))
        .expect_err("unsupported algorithm rejects before corrupt signature");
    let Error::Codec(codec) = error else {
        panic!("expected codec error");
    };
    assert_eq!(codec.category, ErrorCategory::Unsupported);
    assert_eq!(codec.stage, ErrorStage::S106);
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
    let digest = key_transition_signature_digest(NET, &transition_statement).expect("digest");
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
    let attestation_digest = directory_signature_digest(NET, &statement).expect("digest");
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
    let bad_digest = directory_signature_digest(NET, &bad_statement).expect("digest");
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

#[test]
fn directory_statement_canonical_username_valid_and_round_trip() {
    let valid_handles = [
        "abc",
        "a_1",
        "z-9",
        "007",
        "alice",
        "bob-smith",
        "charlie_123",
        "abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc", // 32 chars
        "00000000000000000000000000000000", // 32 chars
    ];

    let ctx = default_context();

    for handle in valid_handles {
        let statement = common::fr(
            4,
            &frank_cbor::cbor_map(vec![
                (0, frank_cbor::CborValue::Text("frank-test".to_string())),
                (1, common::acct1(1)),
                (2, frank_cbor::CborValue::Int(1000)),
                (3, common::ts(100, 0)),
                (
                    4,
                    frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                        (0, frank_cbor::CborValue::Bytes(vec![1; 16])),
                        (
                            1,
                            frank_cbor::CborValue::Text("https://relay.example".to_string()),
                        ),
                        (2, common::acct1(1)),
                        (3, common::ts(2000, 0)),
                    ])]),
                ),
                (8, common::acct1(1)),
                (14, frank_cbor::CborValue::Text(handle.to_string())),
            ]),
        );

        let res = validate_frame(&statement, &ctx).expect("valid statement with username");
        let ValidationResult::Parsed(parsed) = res else {
            panic!("expected parsed frame");
        };
        let Some(TypedPayload::DirectoryStatement {
            canonical_username, ..
        }) = parsed.typed.as_deref()
        else {
            panic!("expected directory statement typed payload");
        };
        assert_eq!(canonical_username.as_deref(), Some(handle));
    }
}

#[test]
fn directory_statement_canonical_username_semantic_rejections() {
    let invalid_handles = [
        "-abc",        // starts with hyphen
        "_abc",        // starts with underscore
        "Alice",       // uppercase
        "ALICE",       // uppercase
        "aliCe",       // uppercase
        "alice@frank", // disallowed char
        "alice.smith", // dot not allowed
        "alice smith", // space not allowed
        "alice!123",   // punctuation
    ];

    let ctx = default_context();

    for handle in invalid_handles {
        let statement = common::fr(
            4,
            &frank_cbor::cbor_map(vec![
                (0, frank_cbor::CborValue::Text("frank-test".to_string())),
                (1, common::acct1(1)),
                (2, frank_cbor::CborValue::Int(1000)),
                (3, common::ts(100, 0)),
                (
                    4,
                    frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                        (0, frank_cbor::CborValue::Bytes(vec![1; 16])),
                        (
                            1,
                            frank_cbor::CborValue::Text("https://relay.example".to_string()),
                        ),
                        (2, common::acct1(1)),
                        (3, common::ts(2000, 0)),
                    ])]),
                ),
                (8, common::acct1(1)),
                (14, frank_cbor::CborValue::Text(handle.to_string())),
            ]),
        );

        let err = validate_frame(&statement, &ctx).expect_err("should reject invalid handle");
        match err {
            Error::Codec(codec) => {
                assert_eq!(codec.category, ErrorCategory::Semantic);
                assert_eq!(codec.stage, ErrorStage::S9);
                assert_eq!(codec.location, "root/payload.14");
            }
            other => panic!("expected codec error, got {other:?}"),
        }
    }
}

#[test]
fn directory_statement_canonical_username_schema_rejections() {
    let ctx = default_context();

    // Bounds failures
    let invalid_length_handles = [
        "",                                  // 0 chars
        "a",                                 // 1 char
        "ab",                                // 2 chars
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 33 chars
    ];

    for handle in invalid_length_handles {
        let statement = common::fr(
            4,
            &frank_cbor::cbor_map(vec![
                (0, frank_cbor::CborValue::Text("frank-test".to_string())),
                (1, common::acct1(1)),
                (2, frank_cbor::CborValue::Int(1000)),
                (3, common::ts(100, 0)),
                (
                    4,
                    frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                        (0, frank_cbor::CborValue::Bytes(vec![1; 16])),
                        (
                            1,
                            frank_cbor::CborValue::Text("https://relay.example".to_string()),
                        ),
                        (2, common::acct1(1)),
                        (3, common::ts(2000, 0)),
                    ])]),
                ),
                (8, common::acct1(1)),
                (14, frank_cbor::CborValue::Text(handle.to_string())),
            ]),
        );

        let err =
            validate_frame(&statement, &ctx).expect_err("should reject invalid length handle");
        match err {
            Error::Codec(codec) => {
                assert_eq!(codec.category, ErrorCategory::Schema);
                assert_eq!(codec.stage, ErrorStage::S82);
            }
            other => panic!("expected schema codec error, got {other:?}"),
        }
    }

    // Invalid type (integer or bytes instead of text string)
    for invalid_val in [
        frank_cbor::CborValue::Int(12345),
        frank_cbor::CborValue::Bytes(vec![1, 2, 3]),
    ] {
        let statement = common::fr(
            4,
            &frank_cbor::cbor_map(vec![
                (0, frank_cbor::CborValue::Text("frank-test".to_string())),
                (1, common::acct1(1)),
                (2, frank_cbor::CborValue::Int(1000)),
                (3, common::ts(100, 0)),
                (
                    4,
                    frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                        (0, frank_cbor::CborValue::Bytes(vec![1; 16])),
                        (
                            1,
                            frank_cbor::CborValue::Text("https://relay.example".to_string()),
                        ),
                        (2, common::acct1(1)),
                        (3, common::ts(2000, 0)),
                    ])]),
                ),
                (8, common::acct1(1)),
                (14, invalid_val),
            ]),
        );

        let err =
            validate_frame(&statement, &ctx).expect_err("should reject invalid type for handle");
        match err {
            Error::Codec(codec) => {
                assert_eq!(codec.category, ErrorCategory::Schema);
                assert_eq!(codec.stage, ErrorStage::S82);
            }
            other => panic!("expected schema codec error, got {other:?}"),
        }
    }
}

#[test]
fn directory_statement_canonical_username_signed_attestation() {
    use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};

    let secp = Secp256k1::signing_only();
    let secret = SecretKey::from_slice(&[42u8; 32]).expect("secret");
    let pub_key_bytes = PublicKey::from_secret_key(&secp, &secret).serialize();

    let account = |key: &[u8]| common::stamp_account(&hex::encode(key));
    let statement = common::fr(
        4,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&pub_key_bytes)),
            (2, frank_cbor::CborValue::Int(500)),
            (3, common::ts(100, 0)),
            (
                4,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Bytes(vec![2; 16])),
                    (
                        1,
                        frank_cbor::CborValue::Text("https://relay.example/r".to_string()),
                    ),
                    (2, account(&pub_key_bytes)),
                    (3, common::ts(2000, 0)),
                ])]),
            ),
            (8, account(&pub_key_bytes)),
            (
                14,
                frank_cbor::CborValue::Text("valid_handle_99".to_string()),
            ),
        ]),
    );

    let digest = directory_signature_digest(NET, &statement).expect("digest");
    let signature = secp
        .sign(&Message::from_slice(&digest).expect("32 bytes"), &secret)
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
                    (1, account(&pub_key_bytes)),
                    (2, frank_cbor::CborValue::Bytes(signature.clone())),
                ])]),
            ),
        ]),
    );

    let mut ctx = default_context();
    ctx.operation = Operation::Full;

    let res =
        validate_frame(&attestation, &ctx).expect("signed attestation with username verifies");
    let ValidationResult::Parsed(parsed) = res else {
        panic!("expected parsed");
    };
    let Some(TypedPayload::DirectoryAttestation { statement: st, .. }) = parsed.typed.as_deref()
    else {
        panic!("expected attestation");
    };
    let Some(TypedPayload::DirectoryStatement {
        canonical_username, ..
    }) = st.typed.as_deref()
    else {
        panic!("expected directory statement");
    };
    assert_eq!(canonical_username.as_deref(), Some("valid_handle_99"));

    // Tampering with the statement's username fails signature verification
    let tampered_statement = common::fr(
        4,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Text(NET.to_string())),
            (1, account(&pub_key_bytes)),
            (2, frank_cbor::CborValue::Int(500)),
            (3, common::ts(100, 0)),
            (
                4,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Bytes(vec![2; 16])),
                    (
                        1,
                        frank_cbor::CborValue::Text("https://relay.example/r".to_string()),
                    ),
                    (2, account(&pub_key_bytes)),
                    (3, common::ts(2000, 0)),
                ])]),
            ),
            (8, account(&pub_key_bytes)),
            (
                14,
                frank_cbor::CborValue::Text("tampered_handle".to_string()),
            ),
        ]),
    );

    let tampered_attestation = common::fr(
        2,
        &frank_cbor::cbor_map(vec![
            (0, frank_cbor::CborValue::Bytes(tampered_statement)),
            (
                1,
                frank_cbor::CborValue::Array(vec![frank_cbor::cbor_map(vec![
                    (0, frank_cbor::CborValue::Int(1)),
                    (1, account(&pub_key_bytes)),
                    (2, frank_cbor::CborValue::Bytes(signature)),
                ])]),
            ),
        ]),
    );

    let err = validate_frame(&tampered_attestation, &ctx)
        .expect_err("tampered statement fails signature check");
    match err {
        Error::Codec(codec) => {
            assert_eq!(codec.category, ErrorCategory::Cryptographic);
            assert_eq!(codec.stage, ErrorStage::S106);
        }
        other => panic!("expected cryptographic error, got {other:?}"),
    }
}
