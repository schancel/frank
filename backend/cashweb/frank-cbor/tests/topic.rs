//! Topic events (types 9, 10, 11): typed projections, R6 limits, the T1/T7 hashes pinned in
//! `topic-commitments.json`, and the guarantee that the corpus written before #136 behaves the
//! same once the new types are listed.

mod common;

use frank_cbor::{
    cbor_map, content_hash, content_hash_network, encode_frame, topic_vote_commitment,
    validate_frame, CborValue, EnvelopeFields, Error, ErrorCategory, FramePayload, ParsedFrame,
    TypedPayload, ValidationResult,
};

use common::{
    bytes_of, context_from_json, fr, int, topic_context, topic_post_frame, topic_post_hash,
    topic_post_submission_frame, topic_vote_frame, NET,
};

fn text(s: &str) -> CborValue {
    CborValue::Text(s.to_string())
}

fn bytes(b: Vec<u8>) -> CborValue {
    CborValue::Bytes(b)
}

fn post_with(body: Vec<u8>) -> Vec<u8> {
    fr(
        9,
        &cbor_map(vec![
            (0, text(NET)),
            (1, text("frank.demo")),
            (3, bytes(body)),
        ]),
    )
}

fn outcome(frame: &[u8]) -> String {
    match validate_frame(frame, &topic_context()) {
        Ok(ValidationResult::Parsed(_)) => "parsed".to_string(),
        Ok(_) => "other".to_string(),
        Err(Error::Codec(error)) => format!("{}@{}", error.category, error.stage),
        Err(other) => panic!("{other}"),
    }
}

fn parsed(frame: &[u8]) -> ParsedFrame {
    match validate_frame(frame, &topic_context()).expect("valid") {
        ValidationResult::Parsed(parsed) => parsed,
        _ => panic!("not parsed"),
    }
}

#[test]
fn projects_a_post_a_submission_and_a_vote() {
    let post = parsed(&topic_post_frame());
    match post.typed.as_deref() {
        Some(TypedPayload::TopicPost {
            topic, parent_hash, ..
        }) => {
            assert_eq!(topic, "frank.demo");
            assert!(parent_hash.is_none());
        }
        other => panic!("{other:?}"),
    }
    let submission = parsed(&topic_post_submission_frame());
    match submission.typed.as_deref() {
        Some(TypedPayload::TopicPostSubmission {
            post_frame,
            burn_tx,
            ..
        }) => {
            assert_eq!(post_frame.frame, topic_post_frame());
            assert_eq!(burn_tx, &bytes_of(110, 31));
        }
        other => panic!("{other:?}"),
    }
    let vote = parsed(&topic_vote_frame());
    match vote.typed.as_deref() {
        Some(TypedPayload::TopicVoteSubmission { target_hash, .. }) => {
            assert_eq!(target_hash, &topic_post_hash());
        }
        other => panic!("{other:?}"),
    }
    for frame in [&post, &submission, &vote] {
        assert_eq!(content_hash_network(frame).unwrap(), NET);
    }
}

#[test]
fn a_reply_carries_its_parent_and_a_null_parent_is_a_schema_error() {
    let parent = topic_post_hash();
    let reply = fr(
        9,
        &cbor_map(vec![
            (0, text(NET)),
            (1, text("frank.demo")),
            (2, bytes(parent.clone())),
            (3, bytes(bytes_of(8, 1))),
        ]),
    );
    match parsed(&reply).typed.as_deref() {
        Some(TypedPayload::TopicPost { parent_hash, .. }) => {
            assert_eq!(parent_hash.as_deref(), Some(parent.as_slice()));
        }
        other => panic!("{other:?}"),
    }
    let null_parent = fr(
        9,
        &cbor_map(vec![
            (0, text(NET)),
            (1, text("frank.demo")),
            (2, CborValue::Null),
            (3, bytes(bytes_of(8, 1))),
        ]),
    );
    assert_eq!(outcome(&null_parent), "schema@8.2");
}

#[test]
fn r6_body_limit_is_resource_at_8_1() {
    assert_eq!(outcome(&post_with(vec![7; 524_288])), "parsed");
    assert_eq!(outcome(&post_with(vec![7; 524_289])), "resource@8.1");
    assert_eq!(outcome(&post_with(Vec::new())), "schema@8.2");
}

fn submission_with(post: Vec<u8>, pad: usize) -> Vec<u8> {
    let mut entries = vec![
        (0, text(NET)),
        (1, bytes(post)),
        (2, bytes(bytes_of(110, 31))),
    ];
    if pad > 0 {
        entries.push((9, bytes(vec![0; pad])));
    }
    fr(10, &cbor_map(entries))
}

#[test]
fn r6_frame_limits_bound_complete_roots() {
    let big = post_with(vec![7; 524_288]);
    assert_eq!(outcome(&submission_with(big.clone(), 0)), "parsed");
    // A type-10 frame over 1 MiB is a resource error before any field is read.
    let padded = submission_with(big.clone(), 1_048_576 - big.len());
    assert!(padded.len() > 1_048_576);
    assert_eq!(outcome(&padded), "resource@8.1");
    // A type-11 frame is bounded at 64 KiB.
    let vote = fr(
        11,
        &cbor_map(vec![
            (0, text(NET)),
            (1, bytes(bytes_of(32, 1))),
            (2, bytes(bytes_of(110, 32))),
            (9, bytes(vec![0; 65_536])),
        ]),
    );
    assert!(vote.len() > 65_536);
    assert_eq!(outcome(&vote), "resource@8.1");
    assert_eq!(outcome(&topic_vote_frame()), "parsed");
}

#[test]
fn a_submission_must_share_its_posts_network() {
    let other = fr(
        10,
        &cbor_map(vec![
            (0, text("other-net")),
            (1, bytes(topic_post_frame())),
            (2, bytes(bytes_of(110, 31))),
        ]),
    );
    assert_eq!(outcome(&other), "semantic@9");
}

#[test]
fn assigned_topic_types_are_not_message_items_but_an_unassigned_sentinel_is_open() {
    let item = |frame: Vec<u8>| {
        fr(
            8,
            &cbor_map(vec![
                (0, text("frank")),
                (1, CborValue::Array(vec![bytes(frame)])),
            ]),
        )
    };
    for frame in [
        topic_post_frame(),
        topic_post_submission_frame(),
        topic_vote_frame(),
    ] {
        assert_eq!(outcome(&item(frame)), "semantic@8.4");
    }
    let unassigned = encode_frame(
        EnvelopeFields {
            type_id: 65535,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&cbor_map(vec![(0, int(1))])),
    )
    .unwrap();
    assert_eq!(outcome(&item(unassigned)), "parsed");
}

#[test]
fn a_reader_without_topic_types_retains_them() {
    let ctx = common::typed_context();
    let mut retaining = ctx;
    retaining.opaque_retention_allowed = true;
    match validate_frame(&topic_post_frame(), &retaining) {
        Ok(ValidationResult::Retained(kept)) => assert_eq!(kept.frame, topic_post_frame()),
        other => panic!("{other:?}"),
    }
    let mut strict = common::typed_context();
    strict.opaque_retention_allowed = false;
    match validate_frame(&topic_post_frame(), &strict) {
        Err(Error::Codec(error)) => assert_eq!(error.category, ErrorCategory::Unsupported),
        other => panic!("{other:?}"),
    }
}

#[test]
fn commitments_match_the_committed_topic_commitments_file() {
    let text_json = include_str!("../../../../docs/protocol/cbor/vectors/topic-commitments.json");
    let doc: serde_json::Value = serde_json::from_str(text_json).unwrap();
    assert_eq!(doc["format"], "frank-cbor-v1-topic-commitments");
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let frame = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        let network = case["network"].as_str().unwrap();
        let p = parsed(&frame);
        assert_eq!(content_hash_network(&p).unwrap(), network, "{id}");
        match p.typed.as_deref().unwrap() {
            TypedPayload::TopicPost { .. } => {
                let want = case["t1_hex"].as_str().unwrap();
                assert_eq!(hex::encode(content_hash(&p).unwrap()), want, "{id}");
            }
            TypedPayload::TopicPostSubmission { post_frame, .. } => {
                let target = content_hash(post_frame).unwrap();
                check_t7(id, case, network, &target);
            }
            TypedPayload::TopicVoteSubmission { target_hash, .. } => {
                let target: [u8; 32] = target_hash.as_slice().try_into().unwrap();
                check_t7(id, case, network, &target);
            }
            other => panic!("{id}: {other:?}"),
        }
    }
}

fn check_t7(id: &str, case: &serde_json::Value, network: &str, target: &[u8; 32]) {
    assert_eq!(
        hex::encode(target),
        case["target_hash_hex"].as_str().unwrap(),
        "{id}"
    );
    let commitment = topic_vote_commitment(network, target).unwrap();
    assert_eq!(
        hex::encode(commitment),
        case["t7_hex"].as_str().unwrap(),
        "{id}"
    );
    // The spelled-out preimage hashes to the same value with an independent SHA-256 call.
    let preimage = hex::decode(case["t7_preimage_hex"].as_str().unwrap()).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        Sha256::digest(&preimage).as_slice(),
        commitment.as_slice(),
        "{id}"
    );
}

#[test]
fn t7_binds_network_and_target_and_needs_a_bounded_network() {
    let target = <[u8; 32]>::try_from(topic_post_hash().as_slice()).unwrap();
    let base = topic_vote_commitment(NET, &target).unwrap();
    assert_ne!(topic_vote_commitment("frank-other", &target).unwrap(), base);
    let mut flipped = target;
    flipped[0] ^= 1;
    assert_ne!(topic_vote_commitment(NET, &flipped).unwrap(), base);
    assert_ne!(
        topic_vote_commitment("ab", &target).unwrap(),
        topic_vote_commitment("a", &target).unwrap()
    );
    assert!(topic_vote_commitment(&"x".repeat(65_536), &target).is_err());
}

#[test]
fn the_pre_topic_corpus_behaves_identically_when_topic_types_are_listed() {
    let text_json = include_str!("../../../../docs/protocol/cbor/vectors/manifest.json");
    let manifest: serde_json::Value = serde_json::from_str(text_json).unwrap();
    let mut pre_topic_context = common::typed_context();
    pre_topic_context
        .supported_schemas
        .iter_mut()
        .find(|schema| schema.type_id == 5)
        .expect("type 5")
        .schema_version = 1; // The frozen corpus predates the production DM schema.
    let mut topic_only_context = topic_context();
    topic_only_context
        .supported_schemas
        .iter_mut()
        .find(|schema| schema.type_id == 5)
        .expect("type 5")
        .schema_version = 1;
    let mut checked = 0;
    for case in manifest["cases"].as_array().unwrap() {
        let before = context_from_json(&case["validation_context"]);
        // Only the default pre-topic reader: a case with its own list (such as one that omits a
        // type on purpose) is about that list, not about the new types.
        if before.supported_schemas != pre_topic_context.supported_schemas
            || case["expectation"] == "retain" && case["id"].as_str().unwrap().starts_with("topic-")
        {
            continue;
        }
        let frame = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        let mut after = before.clone();
        after.supported_schemas = topic_only_context.supported_schemas.clone();
        let run = |ctx: &frank_cbor::ValidationContext| match validate_frame(&frame, ctx) {
            Ok(ValidationResult::Frame(_)) => "frame".to_string(),
            Ok(ValidationResult::Parsed(_)) => "parsed".to_string(),
            Ok(ValidationResult::Retained(_)) => "retained".to_string(),
            Err(Error::Codec(error)) => format!("{}@{}", error.category, error.stage),
            Err(Error::Context(error)) => format!("context: {error}"),
        };
        assert_eq!(run(&before), run(&after), "{}", case["id"]);
        checked += 1;
    }
    assert!(
        checked > 300,
        "only {checked} pre-topic cases were compared"
    );
}

#[test]
fn signed_topic_post_encodes_and_verifies_author() {
    use frank_cbor::{
        encode_signed_forum_post, verify_topic_post_author, AccountRef, ForumEntry, Timestamp,
        TopicPostAuthor, TypedPayload,
    };
    use secp256k1_abc::{Message, Secp256k1, SecretKey};

    let secp = Secp256k1::new();
    let secret_key = SecretKey::from_slice(&[7u8; 32]).unwrap();
    let public_key = secp256k1_abc::PublicKey::from_secret_key(&secp, &secret_key);
    let pubkey_bytes = public_key.serialize();
    let expected_address = frank_cbor::address_from_compressed_pubkey(&pubkey_bytes).unwrap();

    let authored = Timestamp {
        seconds: 1_700_000_000,
        nanoseconds: 0,
    };
    let entries = vec![ForumEntry::Post {
        title: Some("Signed Post Title".into()),
        url: None,
        message: Some("Signed post message content".into()),
        unknown: vec![],
    }];

    let parse_with_default =
        |frame: &[u8]| match frank_cbor::validate_frame(frame, &frank_cbor::default_context())
            .expect("valid")
        {
            ValidationResult::Parsed(parsed) => parsed,
            _ => panic!("not parsed"),
        };

    let unsigned_frame =
        frank_cbor::encode_forum_post("frank", "test.topic", None, &authored, &entries).unwrap();
    let parsed_unsigned = parse_with_default(&unsigned_frame);
    let TypedPayload::TopicPost { body, .. } = *parsed_unsigned.typed.unwrap() else {
        panic!("expected topic post");
    };

    let digest =
        frank_cbor::topic_post_signature_digest("frank", "test.topic", &body, None).unwrap();
    let msg = Message::from_slice(&digest).unwrap();
    let sig = secp.sign(&msg, &secret_key);
    let der_sig = sig.serialize_der().to_vec();

    let author = TopicPostAuthor::Account(AccountRef {
        key_type: 1,
        key_bytes: pubkey_bytes.to_vec(),
    });

    let signed_frame = encode_signed_forum_post(
        "frank",
        "test.topic",
        None,
        &authored,
        &entries,
        Some(&author),
        Some(&der_sig),
    )
    .unwrap();

    let parsed_signed = parse_with_default(&signed_frame);
    let TypedPayload::TopicPost {
        network,
        topic,
        body: parsed_body,
        from,
        signature,
        ..
    } = *parsed_signed.typed.unwrap()
    else {
        panic!("expected topic post");
    };

    assert_eq!(from, Some(author.clone()));
    assert_eq!(signature, Some(der_sig.clone()));

    let verified_addr = verify_topic_post_author(
        &network,
        &topic,
        &parsed_body,
        None,
        &from.unwrap(),
        &signature.unwrap(),
    );
    assert_eq!(verified_addr, Some(expected_address));
}
