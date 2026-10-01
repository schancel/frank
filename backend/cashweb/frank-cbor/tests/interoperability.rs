//! Cross-language exact-byte evidence over the committed TypeScript and Rust fixtures.

mod common;

use std::collections::BTreeMap;

use frank_cbor::{
    content_hash, decode_canonical, encode_canonical, message_content_digest, payment_commitment,
    recipient_payload_digest, validate_frame, Error, ValidationResult,
};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey, Signature};

use common::{
    context_from_json, mutated_type5_frame, repo_path, round_trip_item, type5_frame,
    type5_frame_reverse_order, typed_context, NET,
};

const TYPESCRIPT_IDS: [&str; 3] = [
    "fixture-direct-message-typed",
    "fixture-directory-attestation-typed",
    "fixture-checkpoint-typed",
];
const TYPESCRIPT_RETENTION_IDS: [&str; 3] = [
    "v6-newer-schema-extra-field",
    "fixture-revision8-typed",
    "fixture-checkpoint-typed",
];
const RUST_IDS: [&str; 3] = [
    "rust-fixture-direct-message",
    "rust-fixture-directory-attestation",
    "rust-fixture-checkpoint",
];

fn load(relative: &str) -> serde_json::Value {
    let path = repo_path(relative);
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
    )
    .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn find_case<'a>(manifest: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    manifest["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("missing case {id}"))
}

fn exact_round_trip(case: &serde_json::Value) {
    let id = case["id"].as_str().expect("id");
    let frame = hex::decode(case["frame_hex"].as_str().expect("frame hex")).expect("hex");
    let result = validate_frame(&frame, &context_from_json(&case["validation_context"]))
        .unwrap_or_else(|error| panic!("{id}: {error}"));
    let ValidationResult::Parsed(parsed) = result else {
        panic!("{id}: expected parsed frame")
    };
    assert_eq!(parsed.frame, frame, "{id}: complete frame");
    assert_eq!(round_trip_item(&frame[9..]), frame[9..], "{id}: envelope");
    assert_eq!(
        round_trip_item(&parsed.payload_bytes),
        parsed.payload_bytes,
        "{id}: payload"
    );
    assert_eq!(
        encode_canonical(&parsed.payload).expect("payload encode"),
        parsed.payload_bytes,
        "{id}: decoded payload"
    );
}

#[test]
fn typescript_origin_frames_round_trip_exactly_in_rust() {
    let manifest = load("../../../docs/protocol/cbor/vectors/manifest.json");
    for id in TYPESCRIPT_IDS {
        exact_round_trip(find_case(&manifest, id));
    }
    for id in TYPESCRIPT_RETENTION_IDS {
        exact_round_trip(find_case(&manifest, id));
    }
    let additive = find_case(&manifest, TYPESCRIPT_RETENTION_IDS[0]);
    let frame = hex::decode(additive["frame_hex"].as_str().unwrap()).unwrap();
    let ValidationResult::Parsed(parsed) =
        validate_frame(&frame, &context_from_json(&additive["validation_context"]))
            .expect("TypeScript additive frame")
    else {
        panic!("TypeScript additive frame was not parsed")
    };
    let frank_cbor::CborValue::Map(fields) = parsed.payload else {
        panic!("TypeScript additive payload map")
    };
    assert!(fields.iter().any(|(key, _)| *key == 1));
    for id in &TYPESCRIPT_RETENTION_IDS[1..] {
        assert!(
            find_case(&manifest, id)["frame_hex"]
                .as_str()
                .unwrap()
                .contains("1affff0001"),
            "{id}: nested opaque future frame missing"
        );
    }
}

#[test]
fn rust_origin_frames_and_opaque_data_round_trip_exactly_in_rust() {
    let manifest = load("../../../docs/protocol/cbor/vectors/rust-origin.json");
    for id in RUST_IDS {
        let case = find_case(&manifest, id);
        exact_round_trip(case);
        let frame = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        let ValidationResult::Parsed(parsed) =
            validate_frame(&frame, &context_from_json(&case["validation_context"]))
                .expect("rust-origin frame")
        else {
            panic!("{id}: expected parsed frame")
        };
        let frank_cbor::CborValue::Map(fields) = parsed.payload else {
            panic!("{id}: payload map")
        };
        assert!(
            fields.iter().any(|(key, _)| *key == 100),
            "{id}: additive field was not retained"
        );
    }
    for id in [RUST_IDS[0], RUST_IDS[2]] {
        assert!(
            find_case(&manifest, id)["frame_hex"]
                .as_str()
                .unwrap()
                .contains("1affff0001"),
            "{id}: nested opaque future frame missing"
        );
    }
}

#[test]
fn complete_hostile_manifest_has_exact_category_and_stage_parity() {
    let manifest = load("../../../docs/protocol/cbor/vectors/manifest.json");
    let cases = manifest["cases"].as_array().expect("cases");
    let mut rejects = 0;
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let frame = hex::decode(case["frame_hex"].as_str().expect("frame hex")).expect("hex");
        let ctx = context_from_json(&case["validation_context"]);
        match validate_frame(&frame, &ctx) {
            Ok(ValidationResult::Retained(_)) => assert_eq!(case["expectation"], "retain", "{id}"),
            Ok(_) => assert_eq!(case["expectation"], "accept", "{id}"),
            Err(Error::Codec(error)) => {
                rejects += 1;
                assert_eq!(case["expectation"], "reject", "{id}");
                assert_eq!(case["error_category"], error.category.as_str(), "{id}");
                assert_eq!(case["error_stage"], error.stage.as_str(), "{id}");
            }
            Err(Error::Context(error)) => panic!("{id}: context error: {error}"),
        }
    }
    assert!(
        rejects > 100,
        "hostile corpus unexpectedly shrank: {rejects}"
    );
}

#[test]
fn rust_map_insertion_orders_converge_on_the_complete_frame() {
    assert_eq!(type5_frame_reverse_order(), type5_frame());
}

fn parsed_type5(frame: &[u8]) -> frank_cbor::ParsedFrame {
    let ValidationResult::Parsed(parsed) =
        validate_frame(frame, &typed_context()).expect("valid type-5 fixture")
    else {
        panic!("expected parsed type-5 frame")
    };
    parsed
}

fn crypto_document() -> serde_json::Value {
    let original = type5_frame();
    let mutated = mutated_type5_frame();
    assert_eq!(original.len(), mutated.len());
    let differences: Vec<usize> = original
        .iter()
        .zip(&mutated)
        .enumerate()
        .filter_map(|(index, (a, b))| (a != b).then_some(index))
        .collect();
    assert_eq!(differences.len(), 1, "mutation must change one byte");

    let original_parsed = parsed_type5(&original);
    let mutated_parsed = parsed_type5(&mutated);
    let t1 = content_hash(&original_parsed).expect("T1");
    let mutated_t1 = content_hash(&mutated_parsed).expect("mutated T1");
    let t3 = recipient_payload_digest(NET, &original).expect("T3");
    let mutated_t3 = recipient_payload_digest(NET, &mutated).expect("mutated T3");
    let t4 = payment_commitment(&t3, 0);
    let mutated_t4 = payment_commitment(&mutated_t3, 0);
    assert_ne!(t1, mutated_t1);
    assert_ne!(t3, mutated_t3);
    assert_ne!(t4, mutated_t4);

    let secp = Secp256k1::new();
    let secret = SecretKey::from_slice(&[0x11; 32]).expect("fixed secret");
    let public = PublicKey::from_secret_key(&secp, &secret);
    let message = Message::from_slice(&t1).expect("T1 digest");
    let signature = secp.sign(&message, &secret);
    secp.verify(&message, &signature, &public)
        .expect("fixed signature");
    let mutated_message = Message::from_slice(&mutated_t1).expect("mutated T1 digest");
    assert!(secp.verify(&mutated_message, &signature, &public).is_err());

    let revision = common::revision_frame();
    serde_json::json!({
        "network": NET,
        "frame_hex": hex::encode(&original),
        "mutated_frame_hex": hex::encode(&mutated),
        "mutation_offset": differences[0],
        "t1_hex": hex::encode(t1),
        "mutated_t1_hex": hex::encode(mutated_t1),
        "t1a_frame_hex": hex::encode(&revision),
        "t1a_hex": hex::encode(message_content_digest(&revision).expect("T1a")),
        "t3_hex": hex::encode(t3),
        "mutated_t3_hex": hex::encode(mutated_t3),
        "payment_child_index": 0,
        "t4_hex": hex::encode(t4),
        "mutated_t4_hex": hex::encode(mutated_t4),
        "signature_input": "T1 SHA-256 digest of the complete type-5 frame transcript",
        "signature_public_key_hex": hex::encode(public.serialize()),
        "signature_der_hex": hex::encode(signature.serialize_der()),
    })
}

fn interoperability_document() -> serde_json::Value {
    let manifest = load("../../../docs/protocol/cbor/vectors/manifest.json");
    let cases = manifest["cases"].as_array().expect("cases");
    let mut category_counts = BTreeMap::<String, u64>::new();
    let mut reject_count = 0_u64;
    for case in cases {
        if case["expectation"] == "reject" {
            reject_count += 1;
            *category_counts
                .entry(case["error_category"].as_str().unwrap().to_string())
                .or_default() += 1;
        }
    }
    serde_json::json!({
        "format": "frank-cbor-v1-interoperability",
        "typescript_origin_ids": TYPESCRIPT_IDS,
        "typescript_retention_ids": TYPESCRIPT_RETENTION_IDS,
        "rust_origin_ids": RUST_IDS,
        "hostile_manifest": {
            "case_count": cases.len(),
            "reject_count": reject_count,
            "reject_category_counts": category_counts,
        },
        "crypto": crypto_document(),
    })
}

#[test]
fn fixed_complete_frame_hash_signature_and_payment_fixture_matches_committed_json() {
    let document = interoperability_document();
    let serialized = serde_json::to_string_pretty(&document).unwrap() + "\n";
    let path = repo_path("../../../docs/protocol/cbor/vectors/interoperability.json");
    if std::env::var("FRANK_UPDATE_INTEROPERABILITY_VECTORS")
        .ok()
        .as_deref()
        == Some("1")
    {
        std::fs::write(&path, &serialized).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "read {}: {error}. Regenerate with FRANK_UPDATE_INTEROPERABILITY_VECTORS=1",
            path.display()
        )
    });
    assert_eq!(committed, serialized);
}

#[test]
fn committed_signature_is_fixed_and_verifies_only_the_original_complete_frame() {
    let document = load("../../../docs/protocol/cbor/vectors/interoperability.json");
    let crypto = &document["crypto"];
    let original = hex::decode(crypto["frame_hex"].as_str().unwrap()).unwrap();
    let mutated = hex::decode(crypto["mutated_frame_hex"].as_str().unwrap()).unwrap();
    let original_t1 = content_hash(&parsed_type5(&original)).unwrap();
    let mutated_t1 = content_hash(&parsed_type5(&mutated)).unwrap();
    let public = PublicKey::from_slice(
        &hex::decode(crypto["signature_public_key_hex"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let signature =
        Signature::from_der(&hex::decode(crypto["signature_der_hex"].as_str().unwrap()).unwrap())
            .unwrap();
    let secp = Secp256k1::verification_only();
    assert!(secp
        .verify(
            &Message::from_slice(&original_t1).unwrap(),
            &signature,
            &public
        )
        .is_ok());
    assert!(secp
        .verify(
            &Message::from_slice(&mutated_t1).unwrap(),
            &signature,
            &public
        )
        .is_err());

    assert_eq!(
        decode_canonical(&original[9..]).unwrap(),
        decode_canonical(&encode_canonical(&decode_canonical(&original[9..]).unwrap()).unwrap())
            .unwrap()
    );
}
