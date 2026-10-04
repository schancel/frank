//! Independent Rust-origin values and production public-boundary regressions.
use frank_cbor::*;
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};

fn parsed(bytes: &[u8]) -> ParsedFrame {
    match validate_frame(bytes, &default_context()).unwrap() {
        ValidationResult::Parsed(p) => p,
        _ => panic!("typed"),
    }
}
fn reference() -> LotusReference {
    LotusReference {
        origin: 0,
        hash: [0x31; 32],
    }
}
fn key() -> (SecretKey, AccountRef) {
    let sk = SecretKey::from_slice(&[0x11; 32]).unwrap();
    let pk = PublicKey::from_secret_key(&Secp256k1::new(), &sk)
        .serialize()
        .to_vec();
    (
        sk,
        AccountRef {
            key_type: 1,
            key_bytes: pk,
        },
    )
}
fn text_entry() -> LotusEntry {
    LotusEntry {
        kind: "post".into(),
        headers: vec![("a".into(), "first".into()), ("z".into(), "last".into())],
        data: encode_lotus_public(&LotusPayload::Text {
            title: Some("".into()),
            url: None,
            message: Some("Lotus 🌸".into()),
        })
        .unwrap(),
        post: None,
    }
}
fn values() -> Vec<LotusPayload> {
    let (_, author) = key();
    vec![
        LotusPayload::Metadata {
            network: "xpi-mainnet".into(),
            timestamp: i64::MIN,
            ttl: i64::MAX,
            entries: vec![text_entry()],
        },
        LotusPayload::Post {
            network: "xpi-regtest".into(),
            topic: "é.１２.alpha-2".into(),
            timestamp: 42,
            entries: vec![
                text_entry(),
                LotusEntry {
                    kind: "future".into(),
                    headers: vec![],
                    data: vec![0, 255],
                    post: None,
                },
            ],
            parent: Some(reference()),
        },
        LotusPayload::Offering {
            network: "xpi-mainnet".into(),
            target: reference(),
            direction: 0,
        },
        LotusPayload::Offering {
            network: "xpi-regtest".into(),
            target: LotusReference {
                origin: 1,
                hash: [0x32; 32],
            },
            direction: 1,
        },
        LotusPayload::Text {
            title: Some("".into()),
            url: Some("".into()),
            message: None,
        },
        LotusPayload::HistoricalManifest {
            network: "xpi-mainnet".into(),
            digest: [0x41; 32],
            author: author.clone(),
            kind: 0,
            observed: 0,
            ttl: Some(-7),
            parent: None,
            total_burn: u64::MAX,
            component_count: 2,
            authored: Some(i64::MIN),
            target: None,
        },
        LotusPayload::HistoricalManifest {
            network: "xpi-mainnet".into(),
            digest: [0x42; 32],
            author: author.clone(),
            kind: 1,
            observed: 1,
            ttl: None,
            parent: Some(reference()),
            total_burn: 3,
            component_count: 1,
            authored: Some(2),
            target: None,
        },
        LotusPayload::HistoricalManifest {
            network: "xpi-regtest".into(),
            digest: [0x43; 32],
            author,
            kind: 2,
            observed: 2,
            ttl: None,
            parent: None,
            total_burn: 4,
            component_count: 0,
            authored: None,
            target: Some(reference()),
        },
        LotusPayload::Inventory {
            network: "xpi-regtest".into(),
            collection: 0,
            epoch: [0x51; 16],
            incarnation: u64::MAX,
            ceiling: u64::MAX,
            rows: vec![LotusDescriptor {
                type_id: 36,
                index: [0x52; 32],
                sequence: u64::MAX,
                time: i64::MIN,
                target: Some(reference()),
            }],
            next: Some(vec![1, 2]),
            echo: Some(vec![3]),
        },
        LotusPayload::Summary {
            network: "xpi-mainnet".into(),
            target: reference(),
            revision: u64::MAX,
            physical: u64::MAX,
            support: u64::MAX - 1,
            oppose: 1,
        },
        LotusPayload::Result {
            network: "xpi-mainnet".into(),
            request: [0x61; 32],
            phase: 0,
            txids: vec![],
            sequence: None,
            reason: None,
        },
        LotusPayload::Result {
            network: "xpi-mainnet".into(),
            request: [0x62; 32],
            phase: 1,
            txids: vec![[0x63; 32]],
            sequence: Some(u64::MAX),
            reason: None,
        },
        LotusPayload::Result {
            network: "xpi-mainnet".into(),
            request: [0x64; 32],
            phase: 2,
            txids: vec![[0x63; 32]],
            sequence: None,
            reason: Some("rejected".into()),
        },
        LotusPayload::Result {
            network: "xpi-mainnet".into(),
            request: [0x65; 32],
            phase: 3,
            txids: vec![],
            sequence: None,
            reason: None,
        },
        LotusPayload::Peers {
            network: "xpi-mainnet".into(),
            origins: vec!["https://a.example".into(), "https://b.example:8443".into()],
        },
        LotusPayload::Error {
            network: "xpi-regtest".into(),
            code: "capacity".into(),
            request: Some([0x71; 32]),
            retryable: true,
        },
        LotusPayload::HistoricalChunk {
            network: "xpi-regtest".into(),
            digest: [0x72; 32],
            ordinal: u64::MAX,
            path: [4, 9, 0, 0],
            encoding: 1,
            total: u64::MAX,
            offset: u64::MAX - 2,
            chunk: vec![0, 255],
        },
        LotusPayload::HistoricalChunk {
            network: "xpi-mainnet".into(),
            digest: [0x73; 32],
            ordinal: 0,
            path: [7, 0, 0, 0],
            encoding: 0,
            total: 4,
            offset: 0,
            chunk: "🌸".as_bytes().to_vec(),
        },
    ]
}
#[test]
fn independently_encode_all_family_shapes_and_preserve_original_frames() {
    for v in values() {
        let b = encode_lotus_public(&v).unwrap();
        let p = parsed(&b);
        assert_eq!(p.type_id, v.type_id());
        let projection = project_lotus_public(&p).unwrap();
        assert_eq!(projection.frame, b);
        assert_eq!(encode_lotus_public(&projection.payload).unwrap(), b);
        if matches!(p.type_id, 32..=34) {
            assert_eq!(lotus_body_hash(&p).unwrap(), content_hash(&p).unwrap());
            assert_ne!(
                lotus_body_hash(&p).unwrap(),
                lotus_signature_digest(&p).unwrap()
            );
        }
    }
}
#[test]
fn new_common_digest_algorithm1_and_explicit_algorithm3_unsupported() {
    let (sk, signer) = key();
    let body = encode_lotus_public(&values().remove(0)).unwrap();
    let p = parsed(&body);
    let digest = lotus_signature_digest(&p).unwrap();
    let signature = Secp256k1::new()
        .sign(&Message::from_slice(&digest).unwrap(), &sk)
        .serialize_der()
        .to_vec();
    let mut submission = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame: body,
        body: None,
        signature: SignatureEntry {
            algorithm: 1,
            signer,
            signature,
        },
        burns: vec![
            LotusBurn {
                raw: vec![1, 2],
                output_index: 0,
            },
            LotusBurn {
                raw: vec![1, 2],
                output_index: 1,
            },
        ],
        claimed_burn: Some(0),
    };
    let bytes = encode_lotus_public(&submission).unwrap();
    let root = parsed(&bytes);
    assert_eq!(
        verify_lotus_submission(&root).unwrap(),
        LotusVerification::Verified
    );
    let mut ctx = default_context();
    ctx.operation = Operation::Full;
    assert!(matches!(
        validate_frame(&bytes, &ctx),
        Err(Error::Context(_))
    ));
    if let LotusPayload::Submission { signature, .. } = &mut submission {
        signature.algorithm = 3;
        signature.signature = vec![0x81; 64];
    }
    let bytes = encode_lotus_public(&submission).unwrap();
    assert_eq!(
        verify_lotus_submission(&parsed(&bytes)).unwrap(),
        LotusVerification::Unsupported
    );
    assert!(matches!(
        validate_frame(&bytes, &ctx),
        Err(Error::Context(_))
    ));
}
#[test]
fn closed_maps_required_children_and_network_rows() {
    assert_eq!(
        lotus_network_descriptor("xpi", "mainnet").unwrap(),
        "xpi-mainnet"
    );
    assert_eq!(
        lotus_network_descriptor("xpi", "regtest").unwrap(),
        "xpi-regtest"
    );
    for family in ["bch", "xec", "xrg"] {
        assert!(lotus_network_descriptor(family, "mainnet").is_err());
    }
    assert!(lotus_network_descriptor("xpi", "testnet").is_err());
    let original = parsed(&encode_lotus_public(&values().remove(2)).unwrap());
    let mut payload = original.payload.clone();
    if let CborValue::Map(m) = &mut payload {
        m.push((9, CborValue::Null));
    }
    let future = encode_frame(
        EnvelopeFields {
            type_id: 34,
            schema_version: 2,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .unwrap();
    assert!(validate_frame(&future, &default_context()).is_err());
    let wrong = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame: encode_lotus_public(&LotusPayload::Text {
            title: Some("x".into()),
            url: None,
            message: None,
        })
        .unwrap(),
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: vec![],
        claimed_burn: None,
    };
    assert!(encode_lotus_public(&wrong).is_err());
    let wrong_network = LotusPayload::Submission {
        network: "xpi-regtest".into(),
        body_frame: original.frame,
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: vec![],
        claimed_burn: None,
    };
    assert!(encode_lotus_public(&wrong_network).is_err());
}
#[test]
fn bounds_and_conditional_relay_statements() {
    let bad = LotusPayload::Summary {
        network: "xpi-mainnet".into(),
        target: reference(),
        revision: 0,
        physical: 0,
        support: u64::MAX,
        oppose: 1,
    };
    assert!(encode_lotus_public(&bad).is_err());
    let mut peers = LotusPayload::Peers {
        network: "xpi-mainnet".into(),
        origins: vec!["https://b.example".into(), "https://a.example".into()],
    };
    assert!(encode_lotus_public(&peers).is_err());
    if let LotusPayload::Peers { origins, .. } = &mut peers {
        *origins = vec!["https://a.example/path".into()];
    }
    assert!(encode_lotus_public(&peers).is_err());
    let mut chunk = values().pop().unwrap();
    if let LotusPayload::HistoricalChunk { offset, total, .. } = &mut chunk {
        *total = u64::MAX;
        *offset = u64::MAX;
    }
    assert!(encode_lotus_public(&chunk).is_err());
    let mut result = values().remove(10);
    if let LotusPayload::Result { sequence, .. } = &mut result {
        *sequence = Some(1);
    }
    assert!(encode_lotus_public(&result).is_err());
    let empty = LotusPayload::Text {
        title: None,
        url: None,
        message: None,
    };
    assert!(encode_lotus_public(&empty).is_err());
    let large = LotusPayload::Text {
        title: Some("x".repeat(262144)),
        url: None,
        message: None,
    };
    assert!(encode_lotus_public(&large).is_err());
}
#[test]
fn consumes_independent_cross_language_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/lotus-public.json"
    ))
    .unwrap();
    assert_eq!(
        corpus["packet_sha256"],
        "36dbe76f13d815f0fe31a82dd3fb8aaa9149a4326fb855f44005e50009af8732"
    );
    let signer = AccountRef {
        key_type: 1,
        key_bytes: hex::decode(corpus["author_key_hex"].as_str().unwrap()).unwrap(),
    };
    let positive = corpus["positive"].as_array().unwrap();
    assert!(positive.len() >= 19);
    for v in positive {
        let id = v["id"].as_str().unwrap();
        let bytes = hex::decode(v["frame_hex"].as_str().unwrap()).unwrap();
        let p = parsed(&bytes);
        assert_eq!(p.type_id as u64, v["type_id"].as_u64().unwrap(), "{id}");
        let projection = project_lotus_public(&p).unwrap();
        assert_eq!(projection.frame, bytes, "{id}");
        assert_eq!(
            encode_lotus_public(&projection.payload).unwrap(),
            bytes,
            "{id}"
        );
        if let Some(h) = v["body_hash_hex"].as_str() {
            let body_hash = lotus_body_hash(&p).unwrap();
            assert_eq!(hex::encode(body_hash), h, "{id}");
            assert_eq!(
                hex::encode(lotus_signature_digest(&p).unwrap()),
                v["signature_digest_hex"].as_str().unwrap(),
                "{id}"
            );
            assert_eq!(
                hex::encode(lotus_burn_commitment(&signer, &body_hash).unwrap()),
                v["burn_commitment_hex"].as_str().unwrap(),
                "{id}"
            );
            let script = lotus_burn_script(&p, &signer).unwrap();
            assert_eq!(
                &script[8..],
                body_hash_commitment(&signer, &body_hash).as_slice()
            );
        }
        if let Some(h) = v["request_index_hex"].as_str() {
            assert_eq!(hex::encode(lotus_request_index(&p).unwrap()), h, "{id}");
        }
        let mut extended = p.payload.clone();
        if let CborValue::Map(m) = &mut extended {
            m.push((99, CborValue::Null));
        }
        let future = encode_frame(
            EnvelopeFields {
                type_id: p.type_id,
                schema_version: 2,
                min_reader_version: 1,
            },
            FramePayload::Value(&extended),
        )
        .unwrap();
        assert!(
            matches!(
                validate_frame(&future, &default_context()),
                Err(Error::Codec(CodecError {
                    category: ErrorCategory::Schema,
                    stage: ErrorStage::S82,
                    ..
                }))
            ),
            "{id}"
        );
    }
    let negative = corpus["negative"].as_array().unwrap();
    assert!(negative.len() >= 8);
    for v in negative {
        let bytes = hex::decode(v["frame_hex"].as_str().unwrap()).unwrap();
        let Err(Error::Codec(e)) = validate_frame(&bytes, &default_context()) else {
            panic!("negative {}", v["id"])
        };
        assert_eq!(
            e.category.as_str(),
            v["error"]["category"].as_str().unwrap(),
            "{}",
            v["id"]
        );
        assert_eq!(
            e.stage.as_str(),
            v["error"]["stage"].as_str().unwrap(),
            "{}",
            v["id"]
        );
    }
}
fn body_hash_commitment(signer: &AccountRef, hash: &[u8; 32]) -> [u8; 32] {
    lotus_burn_commitment(signer, hash).unwrap()
}
/// Emits Rust-origin bytes for independent TS consumption; run explicitly with nocapture.
#[test]
fn rust_origin_fixture_export() {
    let signer = AccountRef {
        key_type: 1,
        key_bytes: hex::decode(
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        )
        .unwrap(),
    };
    let mut cases = values();
    let body = encode_lotus_public(&cases[0]).unwrap();
    let digest = lotus_signature_digest(&parsed(&body)).unwrap();
    let mut secret = [0; 32];
    secret[31] = 1;
    let sk = SecretKey::from_slice(&secret).unwrap();
    let signature = Secp256k1::new()
        .sign(&Message::from_slice(&digest).unwrap(), &sk)
        .serialize_der()
        .to_vec();
    cases.push(LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame: body,
        body: None,
        signature: SignatureEntry {
            algorithm: 1,
            signer: signer.clone(),
            signature,
        },
        burns: vec![],
        claimed_burn: None,
    });
    for (i, p) in cases.iter().enumerate() {
        let bytes = encode_lotus_public(p).unwrap();
        let parsed = parsed(&bytes);
        let mut row = serde_json::json!({"id":format!("rust-{i}"),"origin":"rust","type_id":p.type_id(),"frame_hex":hex::encode(bytes)});
        if matches!(p.type_id(), 32..=34) {
            row["body_hash_hex"] = hex::encode(lotus_body_hash(&parsed).unwrap()).into();
            row["signature_digest_hex"] =
                hex::encode(lotus_signature_digest(&parsed).unwrap()).into();
            row["burn_commitment_hex"] = hex::encode(
                lotus_burn_commitment(&signer, &lotus_body_hash(&parsed).unwrap()).unwrap(),
            )
            .into();
        }
        if p.type_id() == 36 {
            row["signature_evidence"] = "verified-algorithm1".into();
            row["request_index_hex"] = hex::encode(lotus_request_index(&parsed).unwrap()).into();
        }
        println!("LOTUS_RUST_VECTOR {}", row);
    }
}

#[test]
fn nested_caps_and_field_counts_fail_at_resource_boundary() {
    let huge_text = encode_frame(
        EnvelopeFields {
            type_id: 35,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&cbor_map(vec![(0, CborValue::Text("x".repeat(262130)))])),
    )
    .unwrap();
    assert!(huge_text.len() > 262144);
    let post = LotusPayload::Post {
        network: "xpi-mainnet".into(),
        topic: "lotus".into(),
        timestamp: 0,
        entries: vec![LotusEntry {
            kind: "post".into(),
            headers: vec![],
            data: huge_text,
            post: None,
        }],
        parent: None,
    };
    assert!(matches!(
        encode_lotus_public(&post),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Resource,
            stage: ErrorStage::S81,
            ..
        }))
    ));
    let too_many = LotusPayload::Metadata {
        network: "xpi-mainnet".into(),
        timestamp: 0,
        ttl: 0,
        entries: (0..65)
            .map(|_| LotusEntry {
                kind: "future".into(),
                headers: vec![],
                data: vec![],
                post: None,
            })
            .collect(),
    };
    assert!(matches!(
        encode_lotus_public(&too_many),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Resource,
            stage: ErrorStage::S81,
            ..
        }))
    ));
    let metadata_payload = cbor_map(vec![
        (0, CborValue::Text("xpi-mainnet".into())),
        (1, CborValue::Int(0)),
        (2, CborValue::Int(0)),
        (
            3,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Text("future".into())),
                (1, CborValue::Array(vec![])),
                (2, CborValue::Bytes(vec![0; 262144])),
            ])]),
        ),
    ]);
    let huge_metadata = encode_frame(
        EnvelopeFields {
            type_id: 32,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&metadata_payload),
    )
    .unwrap();
    let root = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame: huge_metadata,
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: vec![],
        claimed_burn: None,
    };
    assert!(matches!(
        encode_lotus_public(&root),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Resource,
            stage: ErrorStage::S81,
            ..
        }))
    ));
}
#[test]
fn maximum_submission_is_retrievable_as_its_complete_exact_frame() {
    let body_frame = encode_lotus_public(&values().remove(2)).unwrap();
    let mut p = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame,
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: (0..8)
            .map(|i| LotusBurn {
                raw: vec![i as u8; if i == 7 { 1048064 } else { 1048576 }],
                output_index: i,
            })
            .collect(),
        claimed_burn: None,
    };
    let provisional = encode_lotus_public(&p).unwrap();
    let delta = MAX_FRAME_BYTES - provisional.len();
    if let LotusPayload::Submission { burns, .. } = &mut p {
        let n = burns[7].raw.len() + delta;
        assert!(n <= 1048576);
        burns[7].raw.resize(n, 7);
    }
    let frame = encode_lotus_public(&p).unwrap();
    assert_eq!(frame.len(), 8388617);
    let root = parsed(&frame);
    assert_eq!(project_lotus_public(&root).unwrap().frame, frame);
    assert_eq!(lotus_request_index(&root).unwrap(), sha2_digest(&frame));
}
fn sha2_digest(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}
#[test]
fn assigned_lotus_types_never_enter_dm_item_slots_and_old_reader_retains_only_allowed_positions() {
    let bytes = encode_lotus_public(&values().remove(2)).unwrap();
    let payload = cbor_map(vec![(
        0,
        CborValue::Array(vec![CborValue::Bytes(bytes.clone())]),
    )]);
    let container = encode_frame(
        EnvelopeFields {
            type_id: 16,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .unwrap();
    assert!(matches!(
        validate_frame(&container, &default_context()),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Semantic,
            stage: ErrorStage::S84,
            ..
        }))
    ));
    let mut old = default_context();
    old.supported_schemas.retain(|s| s.type_id < 32);
    old.opaque_retention_allowed = true;
    let ValidationResult::Retained(retained) = validate_frame(&bytes, &old).unwrap() else {
        panic!("old root retention")
    };
    assert_eq!(retained.frame, bytes);
    assert!(validate_frame(&container, &old).is_err());
    let future = encode_frame(
        EnvelopeFields {
            type_id: 34,
            schema_version: 3,
            min_reader_version: 3,
        },
        FramePayload::Value(&parsed(&bytes).payload),
    )
    .unwrap();
    let body = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame: future,
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: vec![],
        claimed_burn: None,
    };
    assert!(matches!(
        encode_lotus_public(&body),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Unsupported,
            ..
        }))
    ));
}
#[test]
fn signature_evidence_binds_entire_body_domain_network_and_author() {
    let (sk, signer) = key();
    let body = encode_lotus_public(&values().remove(2)).unwrap();
    let parsed_body = parsed(&body);
    let digest = lotus_signature_digest(&parsed_body).unwrap();
    let sign = |digest: [u8; 32]| {
        Secp256k1::new()
            .sign(&Message::from_slice(&digest).unwrap(), &sk)
            .serialize_der()
            .to_vec()
    };
    let submission = |signature: Vec<u8>,
                      author: AccountRef,
                      body_frame: Vec<u8>,
                      network: &str| LotusPayload::Submission {
        network: network.into(),
        body_frame,
        body: None,
        signature: SignatureEntry {
            algorithm: 1,
            signer: author,
            signature,
        },
        burns: vec![],
        claimed_burn: None,
    };
    let good = sign(digest);
    let verify = |p: LotusPayload| {
        verify_lotus_submission(&parsed(&encode_lotus_public(&p).unwrap())).unwrap()
    };
    let wrong_domain = sha2_digest(
        &common_transcript("frank/content-hash/v1", "xpi-mainnet", &body, &[]).unwrap(),
    );
    assert_eq!(
        verify(submission(
            sign(wrong_domain),
            signer.clone(),
            body.clone(),
            "xpi-mainnet"
        )),
        LotusVerification::Invalid
    );
    let wrong_network = sha2_digest(
        &common_transcript("frank/lotus-public-signature/v1", "xpi-regtest", &body, &[]).unwrap(),
    );
    assert_eq!(
        verify(submission(
            sign(wrong_network),
            signer.clone(),
            body.clone(),
            "xpi-mainnet"
        )),
        LotusVerification::Invalid
    );
    let another = SecretKey::from_slice(&[0x22; 32]).unwrap();
    let other = AccountRef {
        key_type: 1,
        key_bytes: PublicKey::from_secret_key(&Secp256k1::new(), &another)
            .serialize()
            .to_vec(),
    };
    assert_eq!(
        verify(submission(good.clone(), other, body, "xpi-mainnet")),
        LotusVerification::Invalid
    );
    let changed = encode_lotus_public(&LotusPayload::Offering {
        network: "xpi-mainnet".into(),
        target: reference(),
        direction: 1,
    })
    .unwrap();
    assert_eq!(
        verify(submission(good, signer, changed, "xpi-mainnet")),
        LotusVerification::Invalid
    );
}
#[test]
fn required_child_retains_actual_container_depth_budget() {
    // At a fresh root this malformed text has schema failure, but in a submission
    // graph its nested CBOR crosses MAX_DEPTH before schema interpretation.
    let mut deep = CborValue::Text("x".into());
    for _ in 0..25 {
        deep = CborValue::Array(vec![deep]);
    }
    let child = encode_frame(
        EnvelopeFields {
            type_id: 35,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&cbor_map(vec![(0, deep)])),
    )
    .unwrap();
    assert!(matches!(
        validate_frame(&child, &default_context()),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Schema,
            ..
        }))
    ));
    let metadata = cbor_map(vec![
        (0, CborValue::Text("xpi-mainnet".into())),
        (1, CborValue::Int(0)),
        (2, CborValue::Int(0)),
        (
            3,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Text("post".into())),
                (1, CborValue::Array(vec![])),
                (2, CborValue::Bytes(child)),
            ])]),
        ),
    ]);
    let body_frame = encode_frame(
        EnvelopeFields {
            type_id: 32,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&metadata),
    )
    .unwrap();
    let submission = LotusPayload::Submission {
        network: "xpi-mainnet".into(),
        body_frame,
        body: None,
        signature: SignatureEntry {
            algorithm: 3,
            signer: key().1,
            signature: vec![0; 64],
        },
        burns: vec![],
        claimed_burn: None,
    };
    assert!(matches!(
        encode_lotus_public(&submission),
        Err(Error::Codec(CodecError {
            category: ErrorCategory::Resource,
            ..
        }))
    ));
}
#[test]
fn portable_peer_origin_corpus_matches_native_canonical_spelling() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/lotus-public.json"
    ))
    .unwrap();
    let rows = corpus["origin_cases"].as_array().unwrap();
    assert!(rows.len() >= 34);
    for row in rows {
        let bytes = hex::decode(row["frame_hex"].as_str().unwrap()).unwrap();
        let outcome = validate_frame(&bytes, &default_context());
        if row["accept"].as_bool().unwrap() {
            let ValidationResult::Parsed(frame) = outcome.unwrap() else {
                panic!("{}", row["id"])
            };
            let projection = project_lotus_public(&frame).unwrap();
            let LotusPayload::Peers { origins, .. } = projection.payload else {
                panic!("{}", row["id"])
            };
            assert_eq!(
                origins,
                vec![row["origin"].as_str().unwrap().to_string()],
                "{}",
                row["id"]
            );
            assert_eq!(projection.frame, bytes, "{}", row["id"]);
        } else {
            let Err(Error::Codec(error)) = outcome else {
                panic!("{}", row["id"])
            };
            assert_eq!(
                error.category.as_str(),
                row["error"]["category"].as_str().unwrap(),
                "{}",
                row["id"]
            );
            assert_eq!(
                error.stage.as_str(),
                row["error"]["stage"].as_str().unwrap(),
                "{}",
                row["id"]
            );
        }
    }
}
