//! Active public-facade conformance: shared exact bytes and independent hostile boundary checks.
use frank_cbor::*;
use serde_json::Value;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/forum-content-read.json"
    ))
    .unwrap()
}
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
fn hex_text(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn recipe(v: &Value) -> CborValue {
    if v.is_null() {
        return CborValue::Null;
    }
    if let Some(v) = v.as_bool() {
        return CborValue::Bool(v);
    }
    if let Some(v) = v.as_str() {
        return CborValue::Text(v.into());
    }
    if let Some(v) = v.as_array() {
        return CborValue::Array(v.iter().map(recipe).collect());
    }
    if let Some(v) = v.get("int") {
        return CborValue::Int(v.as_str().unwrap().parse().unwrap());
    }
    if let Some(v) = v.get("hex") {
        return CborValue::Bytes(hex(v.as_str().unwrap()));
    }
    cbor_map(
        v["map"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| (pair[0].as_u64().unwrap(), recipe(&pair[1])))
            .collect(),
    )
}
fn fixture(id: &str) -> Value {
    corpus()["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == id)
        .unwrap()
        .clone()
}
fn raw(id: &str) -> Vec<u8> {
    hex(fixture(id)["hex"].as_str().unwrap())
}
fn payload(id: &str) -> CborValue {
    recipe(&fixture(id)["payload"])
}
fn set(v: &mut CborValue, key: u64, value: CborValue) {
    let CborValue::Map(m) = v else { panic!("map") };
    if let Some((_, old)) = m.iter_mut().find(|(k, _)| *k == key) {
        *old = value
    } else {
        m.push((key, value));
        m.sort_by_key(|(k, _)| *k);
    }
}
fn frame(type_id: u32, value: &CborValue, schema: u32, min: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(value),
    )
    .unwrap()
}
fn parsed(bytes: &[u8]) -> ParsedFrame {
    match validate_frame(bytes, &default_context()).unwrap() {
        ValidationResult::Parsed(p) => p,
        _ => panic!("not parsed"),
    }
}
fn outcome(bytes: &[u8]) -> String {
    match validate_frame(bytes, &default_context()) {
        Ok(ValidationResult::Parsed(_)) => "parsed".into(),
        Ok(_) => "retained".into(),
        Err(Error::Codec(e)) => format!("{}@{}", e.category, e.stage),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn shared_active_bytes_hashes_rejections_and_retention() {
    let doc = corpus();
    for f in doc["frames"].as_array().unwrap() {
        let id = f["id"].as_str().unwrap();
        let bytes = hex(f["hex"].as_str().unwrap());
        let written = frame(
            f["type"].as_u64().unwrap() as u32,
            &recipe(&f["payload"]),
            f["schema"].as_u64().unwrap() as u32,
            f["min"].as_u64().unwrap() as u32,
        );
        assert_eq!(bytes, written, "encode {id}");
        let mut ctx = default_context();
        if let Some(version) = f["context"]["readerVersion"].as_u64() {
            ctx.reader_version = version as u32;
        }
        if let Some(version) = f["context"]["topicSchema"].as_u64() {
            ctx.supported_schemas
                .iter_mut()
                .find(|s| s.type_id == 9)
                .unwrap()
                .schema_version = version as u32;
        }
        ctx.opaque_retention_allowed = f["context"]["retention"].as_bool().unwrap_or(false);
        let result = validate_frame(&bytes, &ctx);
        if !f["valid"].as_bool().unwrap() {
            let Err(Error::Codec(error)) = result else {
                panic!("accepted negative {id}")
            };
            if let Some(expected) = f["error"].as_str() {
                assert_eq!(
                    format!("{}@{}", error.category, error.stage),
                    expected,
                    "{id}"
                );
            }
            continue;
        }
        if f["retained"].as_bool().unwrap_or(false) {
            let ValidationResult::Retained(r) = result.unwrap() else {
                panic!("not retained {id}")
            };
            assert_eq!(r.frame, bytes);
            continue;
        }
        let ValidationResult::Parsed(p) = result.unwrap_or_else(|e| panic!("{id}: {e}")) else {
            panic!("not parsed {id}")
        };
        assert_eq!(p.frame, bytes, "retained original bytes {id}");
        if let Some(expected) = f["t1"].as_str() {
            assert_eq!(hex_text(&content_hash(&p).unwrap()), expected, "T1 {id}");
        }
        if let Some(expected) = f["t7"].as_str() {
            assert_eq!(
                hex_text(
                    &topic_vote_commitment("monad-testnet", &content_hash(&p).unwrap()).unwrap()
                ),
                expected,
                "T7 {id}"
            );
        }
        if f["type"] == 9 {
            match p.typed.as_deref().unwrap() {
                TypedPayload::TopicPost { content, .. } => assert_eq!(
                    matches!(content, ForumPostContent::Opaque),
                    f["schema"] == 1
                ),
                _ => panic!("post projection"),
            }
        }
    }
}

#[test]
fn independent_encode_origins_and_cursor_transport() {
    let rust = encode_forum_post(
        "monad-testnet",
        "Forum/é",
        None,
        &Timestamp {
            seconds: -1,
            nanoseconds: 1,
        },
        &[ForumEntry::Post {
            title: None,
            url: None,
            message: Some("Rust origin λ".into()),
            unknown: vec![],
        }],
    )
    .unwrap();
    assert_eq!(rust, raw("rust-origin"));
    let ts = encode_forum_post(
        "monad-testnet",
        "Forum/é",
        None,
        &Timestamp {
            seconds: 1700000000,
            nanoseconds: 999999999,
        },
        &[ForumEntry::Post {
            title: Some("Title".into()),
            url: Some("https://example.invalid/é?q=é".into()),
            message: Some("Body 😀 é é".into()),
            unknown: vec![],
        }],
    )
    .unwrap();
    assert_eq!(ts, raw("typescript-origin"));
    for f in corpus()["cursors"].as_array().unwrap() {
        let bytes = hex(f["hex"].as_str().unwrap());
        let cursor = decode_forum_cursor(&bytes).unwrap();
        assert_eq!(encode_forum_cursor(&cursor).unwrap(), bytes);
        let transport = forum_cursor_to_transport(&bytes).unwrap();
        assert_eq!(forum_cursor_from_transport(&transport).unwrap(), cursor);
        for invalid in [
            format!("{transport}="),
            format!(" {transport}"),
            "A".into(),
            "*".into(),
            "A".repeat(2732),
        ] {
            assert!(forum_cursor_from_transport(&invalid).is_err());
        }
        for network in ["UPPER", "é", "", "-net", &"n".repeat(65)] {
            let mut v = decode_canonical(&bytes).unwrap();
            set(&mut v, 0, CborValue::Text(network.into()));
            assert!(decode_forum_cursor(&encode_canonical(&v).unwrap()).is_err());
        }
    }
}

#[test]
fn status_matching_does_not_promote_request_echoes_to_observations() {
    for id in [
        "confirmed-a",
        "unknown-b-same-post",
        "pending-a",
        "rejected-b",
    ] {
        let p = parsed(&raw(id));
        let Some(TypedPayload::ForumOperationStatus(status)) = p.typed.as_deref() else {
            panic!("status")
        };
        let expected = ForumOperationExpectation {
            network: status.network.clone(),
            submitted_frame: status.submitted_frame.frame.clone(),
            target_hash: status.target_hash.clone(),
            transaction_hash: status.transaction_hash.clone(),
            sender: status.sender.clone(),
            direction: status.direction,
            value: status.value,
        };
        assert_eq!(
            match_forum_operation(&raw(id), &expected).unwrap().evidence,
            status.evidence
        );
        assert_eq!(
            matches!(
                status.evidence,
                ForumOperationEvidence::UnknownRequest | ForumOperationEvidence::RejectedRequest
            ),
            id == "unknown-b-same-post" || id == "rejected-b"
        );
        let mut changed = expected.clone();
        changed.value += 1;
        assert!(match_forum_operation(&raw(id), &changed).is_err());
        let mut changed = expected.clone();
        changed.sender[0] ^= 1;
        assert!(match_forum_operation(&raw(id), &changed).is_err());
        let mut changed = expected.clone();
        changed.transaction_hash[0] ^= 1;
        assert!(match_forum_operation(&raw(id), &changed).is_err());
        let mut changed = expected.clone();
        changed.submitted_frame[0] ^= 1;
        assert!(match_forum_operation(&raw(id), &changed).is_err());
        let mut changed = expected.clone();
        changed.direction ^= 1;
        assert!(match_forum_operation(&raw(id), &changed).is_err());
    }
}

fn structured(extra: CborValue, index: u8) -> Vec<u8> {
    let content = cbor_map(vec![
        (
            0,
            cbor_map(vec![
                (0, CborValue::Int(1700000000)),
                (1, CborValue::Int(999999999)),
            ]),
        ),
        (
            1,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Int(1)),
                (3, CborValue::Text("body".into())),
            ])]),
        ),
        (8, extra),
    ]);
    let mut p = payload("typescript-origin");
    set(
        &mut p,
        3,
        CborValue::Bytes(encode_canonical(&content).unwrap()),
    );
    set(&mut p, 2, CborValue::Bytes(vec![index; 32]));
    frame(9, &p, 3, 2)
}
fn view(post: Vec<u8>) -> Vec<u8> {
    let mut v = payload("view-large-aggregate");
    set(&mut v, 1, CborValue::Bytes(post));
    frame(12, &v, 1, 1)
}
fn page(rows: Vec<Vec<u8>>) -> Vec<u8> {
    let mut p = payload("equal-time-page");
    set(
        &mut p,
        4,
        CborValue::Array(rows.into_iter().map(CborValue::Bytes).collect()),
    );
    frame(13, &p, 1, 1)
}

#[test]
fn required_frames_and_content_share_depth_container_and_item_budgets() {
    let mut demonstrated = false;
    for depth in 20..34 {
        let mut v = CborValue::Int(0);
        for _ in 0..depth {
            v = CborValue::Array(vec![v]);
        }
        let post = structured(v, 0);
        if outcome(&post) == "parsed" && outcome(&page(vec![view(post)])) == "resource@8.4" {
            demonstrated = true;
            break;
        }
    }
    assert!(demonstrated);
    for containers in [true, false] {
        let extra = if containers {
            CborValue::Array(vec![CborValue::Array(vec![]); 8190])
        } else {
            CborValue::Array(vec![CborValue::Array(vec![CborValue::Int(0); 8190]); 8])
        };
        let views: Vec<_> = (0..3)
            .map(|i| {
                let post = structured(extra.clone(), i);
                assert_eq!(outcome(&post), "parsed");
                let view = view(post);
                assert_eq!(outcome(&view), "parsed");
                view
            })
            .collect();
        assert_eq!(outcome(&page(views)), "resource@8.4");
    }
}

#[test]
fn complete_encoded_response_limits_are_inclusive_and_rows_are_not_skipped() {
    for (type_id, id, limit) in [
        (12, "view-large-aggregate", 2097152usize),
        (13, "equal-time-page", 4194304),
    ] {
        let mut p = payload(id);
        set(&mut p, 99, CborValue::Bytes(vec![]));
        let overhead = frame(type_id, &p, 2, 1).len();
        set(&mut p, 99, CborValue::Bytes(vec![0; limit - overhead - 6]));
        let bytes = frame(type_id, &p, 2, 1);
        assert_eq!(bytes.len(), limit);
        assert_eq!(outcome(&bytes), "parsed");
        set(&mut p, 99, CborValue::Bytes(vec![0; limit - overhead - 5]));
        assert_eq!(outcome(&frame(type_id, &p, 2, 1)), "resource@8.1");
    }
    assert_eq!(outcome(&page(vec![raw("view-rust"); 129])), "resource@8.1");
}

#[test]
fn content_and_cursor_boundaries_are_inclusive() {
    let post = |content: &CborValue| {
        let mut p = payload("typescript-origin");
        set(
            &mut p,
            3,
            CborValue::Bytes(encode_canonical(content).unwrap()),
        );
        frame(9, &p, 3, 2)
    };
    let entry = cbor_map(vec![
        (0, CborValue::Int(1)),
        (3, CborValue::Text("x".into())),
    ]);
    let mut content = cbor_map(vec![
        (
            0,
            cbor_map(vec![(0, CborValue::Int(0)), (1, CborValue::Int(0))]),
        ),
        (1, CborValue::Array(vec![entry.clone(); 64])),
    ]);
    assert_eq!(outcome(&post(&content)), "parsed");
    set(&mut content, 1, CborValue::Array(vec![entry; 65]));
    assert_eq!(outcome(&post(&content)), "resource@8.1");
    for size in [262144, 262145] {
        set(
            &mut content,
            1,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Int(1)),
                (3, CborValue::Text("x".repeat(size))),
            ])]),
        );
        assert_eq!(
            outcome(&post(&content)),
            if size == 262144 {
                "parsed"
            } else {
                "resource@8.4"
            }
        );
    }
    set(
        &mut content,
        1,
        CborValue::Array(vec![cbor_map(vec![(0, CborValue::Int(1))])]),
    );
    set(&mut content, 8, CborValue::Bytes(vec![]));
    let overhead = encode_canonical(&content).unwrap().len();
    for size in [524288, 524289] {
        set(
            &mut content,
            8,
            CborValue::Bytes(vec![0; size - overhead - 4]),
        );
        assert_eq!(encode_canonical(&content).unwrap().len(), size);
        assert_eq!(
            outcome(&post(&content)),
            if size == 524288 {
                "parsed"
            } else {
                "resource@8.1"
            }
        );
    }
    for size in [2048, 2049] {
        let error = decode_forum_cursor(&vec![0; size]).unwrap_err();
        assert_eq!(error.category == ErrorCategory::Resource, size == 2049);
    }
    assert!(!forum_cursor_from_transport(&"A".repeat(2731))
        .unwrap_err()
        .to_string()
        .contains("invalid cursor transport"));
    assert!(forum_cursor_from_transport(&"A".repeat(2732))
        .unwrap_err()
        .to_string()
        .contains("invalid cursor transport"));
    let mut rows: Vec<_> = (0..128)
        .map(|i| view(structured(CborValue::Int(0), i)))
        .collect();
    rows.sort_by_key(|row| {
        let p = parsed(row);
        let Some(TypedPayload::ForumView(v)) = p.typed.as_deref() else {
            panic!("view")
        };
        content_hash(&v.post_frame).unwrap()
    });
    assert_eq!(outcome(&page(rows)), "parsed");
}
