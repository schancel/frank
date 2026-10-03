//! Offline independent byte/crypto evidence only; NOT a proposed state-policy implementation.
use frank_cbor::{
    cbor_map, common_transcript, decode_canonical, default_context, directory_signature_digest,
    encode_canonical, encode_frame, validate_frame, verify_algorithm_1, CborValue as V,
    EnvelopeFields, FramePayload, Operation, ValidationResult,
};
use secp256k1_abc as secp256k1;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

fn field(v: &V, key: u64) -> &V {
    match v {
        V::Map(entries) => &entries.iter().find(|(k, _)| *k == key).expect("map key").1,
        _ => panic!("not a map"),
    }
}
fn bytes(v: &V) -> &[u8] {
    match v {
        V::Bytes(b) => b,
        _ => panic!("not bytes"),
    }
}
fn text(v: &V) -> &str {
    match v {
        V::Text(s) => s,
        _ => panic!("not text"),
    }
}
fn integer(v: &V) -> i128 {
    match v {
        V::Int(n) => *n,
        _ => panic!("not integer"),
    }
}
fn array(v: &V) -> &[V] {
    match v {
        V::Array(a) => a,
        _ => panic!("not array"),
    }
}
fn unhex(v: &Value, key: &str) -> Vec<u8> {
    hex::decode(v[key].as_str().unwrap()).unwrap()
}
fn open(frame: &[u8]) -> (V, V) {
    assert_eq!(&frame[..5], b"FRNK\x01");
    assert_eq!(
        u32::from_be_bytes(frame[5..9].try_into().unwrap()) as usize,
        frame.len() - 9
    );
    let env = decode_canonical(&frame[9..]).unwrap();
    let payload = decode_canonical(bytes(field(&env, 3))).unwrap();
    assert_eq!(encode_canonical(&env).unwrap(), &frame[9..]);
    assert_eq!(encode_canonical(&payload).unwrap(), bytes(field(&env, 3)));
    (env, payload)
}
fn key(n: u8) -> V {
    let mut scalar = [0; 32];
    scalar[31] = n;
    let secret = secp256k1::SecretKey::from_slice(&scalar).unwrap();
    let public = secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &secret);
    cbor_map(vec![
        (0, V::Int(1)),
        (1, V::Bytes(public.serialize().to_vec())),
    ])
}
fn time(seconds: i128) -> V {
    cbor_map(vec![(0, V::Int(seconds)), (1, V::Int(0))])
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(
            root.join("docs/protocol/proposals/suite1-directory/vectors.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(corpus["status"], "PROPOSED-NOT-ALLOCATED");
    let records = corpus["records"].as_array().unwrap();
    for r in records {
        let id = r["id"].as_str().unwrap();
        let type4 = unhex(r, "type4_hex");
        let type2 = unhex(r, "type2_hex");
        let (env, statement) = open(&type4);
        let (_, wrapper) = open(&type2);
        assert_eq!(integer(field(&env, 0)), 4, "{id}");
        assert_eq!(
            bytes(field(&wrapper, 0)),
            type4,
            "{id}: wrapper opens exact bytes"
        );
        let network = text(field(&statement, 0));
        let digest = directory_signature_digest(network, &type4).unwrap();
        assert_eq!(hex::encode(digest), r["t2_digest"], "{id}: T2");
        let transcript = common_transcript("frank/content-hash/v1", network, &type4, &[]).unwrap();
        assert_eq!(hex::encode(Sha256::digest(transcript)), r["t1"], "{id}: T1");
        let entries = array(field(&wrapper, 1));
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(integer(field(entry, 0)), 1);
        let verified = verify_algorithm_1(
            &digest,
            bytes(field(entry, 2)),
            bytes(field(field(entry, 1), 1)),
        );
        assert_eq!(
            verified,
            r["signature_valid"].as_bool().unwrap(),
            "{id}: independent signature"
        );
        let mut ctx = default_context();
        ctx.operation = Operation::Full;
        let legacy = match validate_frame(&type2, &ctx) {
            Ok(_) => "accept".to_string(),
            Err(frank_cbor::Error::Codec(e)) => format!("{:?}", e.category).to_lowercase(),
            Err(e) => panic!("{id}: unexpected old-reader error: {e:?}"),
        };
        assert_eq!(legacy, r["old_reader"], "{id}: old-reader parity");
        if integer(field(&env, 2)) >= 4 {
            ctx.opaque_retention_allowed = true;
            match validate_frame(&type4, &ctx).unwrap() {
                ValidationResult::Retained(retained) => assert_eq!(retained.frame, type4),
                _ => panic!("{id}: old reader interpreted required semantics"),
            }
        }
    }
    // Independent construction (no TS builder or decoded projection as input).
    let relay = cbor_map(vec![
        (0, V::Bytes((0..16).collect())),
        (1, V::Text("https://relay.example.invalid".into())),
        (2, key(4)),
        (3, time(1700007200)),
    ]);
    assert_eq!(
        hex::encode(encode_canonical(&relay).unwrap()),
        corpus["synthetic_relay_cbor_hex"]
    );
    let bootstrap = cbor_map(vec![
        (0, V::Text("monad-testnet".into())),
        (1, key(1)),
        (2, V::Int(0)),
        (3, time(1700000000)),
        (4, V::Array(vec![relay])),
        (6, time(1700003600)),
        (8, key(3)),
        (10, key(2)),
        (11, V::Int(0)),
        (12, V::Int(0)),
        (13, V::Null),
    ]);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version: 4,
            min_reader_version: 4,
        },
        FramePayload::Value(&bootstrap),
    )
    .unwrap();
    let r = records.iter().find(|r| r["id"] == "bootstrap").unwrap();
    assert_eq!(frame, unhex(r, "type4_hex"));
    let digest = directory_signature_digest("monad-testnet", &frame).unwrap();
    let mut scalar = [0; 32];
    scalar[31] = 1;
    let secret = secp256k1::SecretKey::from_slice(&scalar).unwrap();
    let message = secp256k1::Message::from_slice(&digest).unwrap();
    let sig = secp256k1::Secp256k1::new().sign(&message, &secret);
    assert!(verify_algorithm_1(
        &digest,
        &sig.serialize_der(),
        bytes(field(&key(1), 1))
    ));
    let wrapper = cbor_map(vec![
        (0, V::Bytes(frame)),
        (
            1,
            V::Array(vec![cbor_map(vec![
                (0, V::Int(1)),
                (1, key(1)),
                (2, V::Bytes(sig.serialize_der().to_vec())),
            ])]),
        ),
    ]);
    let signed = encode_frame(
        EnvelopeFields {
            type_id: 2,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&wrapper),
    )
    .unwrap();
    // Both libraries sign deterministically but use different nonce conventions.
    // Wrapper signatures need not match; the exact type4 commitment must match.
    let rust_origin = serde_json::json!({
        "status": "PROPOSED-NOT-ALLOCATED",
        "type4_hex": r["type4_hex"],
        "t1": r["t1"],
        "t2_digest": r["t2_digest"],
        "type2_hex": hex::encode(&signed),
    });
    let rust_file = Path::new(env!("CARGO_MANIFEST_DIR")).join("rust-origin.json");
    let serialized = serde_json::to_string_pretty(&rust_origin).unwrap() + "\n";
    if std::env::args().any(|arg| arg == "--write") {
        std::fs::write(&rust_file, &serialized).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&rust_file).unwrap(),
        serialized,
        "Rust origin drift"
    );
    open(&signed);
    for f in corpus["frozen_sha256"].as_array().unwrap() {
        let path = f["path"].as_str().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(root.join(path)).unwrap())),
            f["sha256"],
            "{path}"
        );
    }
    println!("proposal Rust: {} exact frame pairs, T1/T2/signatures/old readers; independent bootstrap; 7 frozen files unchanged", records.len());
}
