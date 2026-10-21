//! Structural-only synthetic fixtures; no authentication, payment, or full-stage-10 claim.
mod common;

use common::{acct1, bytes_of, fr, int, unknown_item, NET, T3C_EPHEMERAL, T3C_PROOF, T3C_SHARED};
use frank_cbor::message_fields::{
    container_message_item, direct_message_delivery as dmd, encrypted_message_content as emc,
    encryption_suite, message_content_revision as revision, recipient_encrypted_payload_v2 as rep2,
    text_message_item,
};
use frank_cbor::message_types::{
    TYPE_CONTAINER_MESSAGE_ITEM, TYPE_DIRECT_MESSAGE_DELIVERY, TYPE_ENCRYPTED_MESSAGE_CONTENT,
    TYPE_MESSAGE_CONTENT_REVISION, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD, TYPE_TEXT_MESSAGE_ITEM,
};
use frank_cbor::{
    begin_direct_message_validation, cbor_map, default_context, encode_frame, parse_frame,
    CborValue, ChildFrame, DirectMessageValidatedContent, EnvelopeFields, Error, FramePayload,
    Operation, ParsedFrame, TypedPayload, ValidationResult, MAX_FRAME_BYTES,
};

fn frame(kind: u32, payload: &CborValue, schema: u32, min: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: kind,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}
fn encrypted_with(suite: i128, schema: u32, min: u32) -> Vec<u8> {
    frame(
        TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
        &cbor_map(vec![
            (rep2::NETWORK, CborValue::Text(NET.into())),
            (rep2::SENDER, acct1(9)),
            (rep2::RECIPIENT, acct1(3)),
            (rep2::SUITE, int(suite)),
            (rep2::CRYPTO_BOX_ENVELOPE, CborValue::Bytes(vec![0xa0])),
            (
                rep2::EPHEMERAL_POINT,
                CborValue::Bytes(hex::decode(T3C_EPHEMERAL).unwrap()),
            ),
            (
                rep2::SHARED_POINT,
                CborValue::Bytes(hex::decode(T3C_SHARED).unwrap()),
            ),
            (
                rep2::DLEQ_PROOF,
                CborValue::Bytes(hex::decode(T3C_PROOF).unwrap()),
            ),
        ]),
        schema,
        min,
    )
}
fn encrypted() -> Vec<u8> {
    encrypted_with(encryption_suite::DM_AUTH_XCHACHA.into(), 2, 2)
}
fn parsed(bytes: &[u8]) -> ParsedFrame {
    match parse_frame(bytes, &default_context()).unwrap() {
        ValidationResult::Parsed(parsed) => parsed,
        _ => panic!("not parsed"),
    }
}
fn root(extra: Option<CborValue>) -> Vec<u8> {
    let CborValue::Map(mut fields) = parsed(&common::direct_message_frame()).payload else {
        panic!("map")
    };
    fields
        .iter_mut()
        .find(|(key, _)| *key == dmd::PAYLOAD_FRAME)
        .unwrap()
        .1 = CborValue::Bytes(encrypted());
    let schema = if extra.is_some() { 2 } else { 1 };
    if let Some(extra) = extra {
        fields.push((99, extra)); // raw-cbor-key: an additive field no reader declares
    }
    frame(TYPE_DIRECT_MESSAGE_DELIVERY, &cbor_map(fields), schema, 1)
}
fn content_items(extra: Option<CborValue>, items: Vec<Vec<u8>>) -> Vec<u8> {
    let revision = fr(
        TYPE_MESSAGE_CONTENT_REVISION,
        &cbor_map(vec![
            (revision::NETWORK, CborValue::Text("frank".into())),
            (
                revision::ITEMS,
                CborValue::Array(items.into_iter().map(CborValue::Bytes).collect()),
            ),
        ]),
    );
    let mut fields = vec![
        (emc::NETWORK, CborValue::Text(NET.into())),
        (emc::MESSAGE_ID, CborValue::Bytes(bytes_of(16, 7))),
        (emc::REVISION_FRAME, CborValue::Bytes(revision)),
        (emc::CONTENT_DIGEST, CborValue::Bytes(bytes_of(32, 8))),
        (emc::CONVERSATION_ID, CborValue::Bytes(bytes_of(16, 8))),
    ];
    let schema = if extra.is_some() { 2 } else { 1 };
    if let Some(extra) = extra {
        fields.push((99, extra)); // raw-cbor-key: an additive field no reader declares
    }
    frame(TYPE_ENCRYPTED_MESSAGE_CONTENT, &cbor_map(fields), schema, 1)
}
fn content(extra: Option<CborValue>) -> Vec<u8> {
    content_items(extra, vec![unknown_item(1)])
}
fn grouped(n: usize, containers: bool) -> CborValue {
    CborValue::Array(
        (0..n)
            .step_by(4096)
            .map(|offset| {
                CborValue::Array(
                    (0..4096.min(n - offset))
                        .map(|_| {
                            if containers {
                                CborValue::Array(vec![])
                            } else {
                                int(0)
                            }
                        })
                        .collect(),
                )
            })
            .collect(),
    )
}
fn nested(n: usize) -> CborValue {
    (0..n).fold(int(0), |value, _| CborValue::Array(vec![value]))
}
fn finish(root: &[u8], content: &[u8]) -> Result<DirectMessageValidatedContent, Error> {
    begin_direct_message_validation(root, &default_context())?
        .complete_authenticated_content(content)
}
fn outcome<T>(result: Result<T, Error>) -> String {
    match result {
        Ok(_) => "parsed".into(),
        Err(Error::Context(_)) => "context".into(),
        Err(Error::Codec(error)) => format!("{}@{}", error.category, error.stage),
    }
}

#[test]
fn unchanged_production_vector_still_requires_type6_plaintext() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/dm-suite-1.json"
    ))
    .unwrap();
    let bytes = hex::decode(vector["type5FrameHex"].as_str().unwrap()).unwrap();
    let session = begin_direct_message_validation(&bytes, &default_context()).unwrap();
    assert_eq!(*session.payload(), parsed(&bytes));
    // The frozen cipher test's plaintext is just "frank", not a content frame.
    let plain = hex::decode(vector["cryptoBox"]["plaintextHex"].as_str().unwrap()).unwrap();
    assert_eq!(
        outcome(session.complete_authenticated_content(&plain)),
        "frame@2"
    );
}

#[test]
fn ordinary_equivalence_and_opaque_items() {
    for r in [root(None), encrypted()] {
        let c = content(None);
        let completed = finish(&r, &c).unwrap();
        assert_eq!(completed.root, parsed(&r));
        assert_eq!(completed.content, parsed(&c));
        let Some(TypedPayload::EncryptedContent { revision_frame, .. }) =
            completed.content.typed.as_deref()
        else {
            panic!("content")
        };
        let Some(TypedPayload::MessageRevision { items, .. }) = revision_frame.typed.as_deref()
        else {
            panic!("revision")
        };
        assert!(matches!(&items[0], ChildFrame::Retained(_)));
    }
    let mut ctx = default_context();
    ctx.operation = Operation::Full;
    assert_eq!(outcome(parse_frame(&root(None), &ctx)), "context");
}

#[test]
fn typed_only_and_production_payload_only() {
    for operation in [Operation::Frame, Operation::Generic, Operation::Full] {
        let mut ctx = default_context();
        ctx.operation = operation;
        assert_eq!(
            outcome(begin_direct_message_validation(&encrypted(), &ctx)),
            "context"
        );
        assert_eq!(outcome(parse_frame(&encrypted(), &ctx)), "parsed");
    }
    for other in [content(None), common::type5_frame()] {
        assert_eq!(
            outcome(begin_direct_message_validation(&other, &default_context())),
            "context"
        );
    }
    for bad in [
        encrypted_with(encryption_suite::PROOF.into(), 2, 2),
        encrypted_with(encryption_suite::DM_AUTH_XCHACHA.into(), 3, 2),
        encrypted_with(encryption_suite::DM_AUTH_XCHACHA.into(), 2, 1),
    ] {
        let expected = outcome(parse_frame(&bad, &default_context()));
        assert_ne!(expected, "parsed");
        assert_eq!(
            outcome(begin_direct_message_validation(&bad, &default_context())),
            expected
        );
    }
}

#[test]
fn required_content_and_first_error_order() {
    let raw = |kind| {
        encode_frame(
            EnvelopeFields {
                type_id: kind,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Bytes(&[0xff]),
        )
        .unwrap()
    };
    for (bad, expected) in [
        (unknown_item(1), "semantic@8.4"),
        (raw(TYPE_TEXT_MESSAGE_ITEM), "semantic@8.4"),
        (raw(TYPE_ENCRYPTED_MESSAGE_CONTENT), "malformed@7"),
        (
            frame(TYPE_ENCRYPTED_MESSAGE_CONTENT, &cbor_map(vec![]), 3, 3),
            "unsupported@7",
        ),
        (
            fr(TYPE_ENCRYPTED_MESSAGE_CONTENT, &cbor_map(vec![])),
            "schema@8.2",
        ),
        (vec![0], "frame@2"),
    ] {
        assert_eq!(outcome(finish(&root(None), &bad)), expected);
    }
    let mut unsupported = content(None);
    unsupported[4] = 2;
    assert_eq!(outcome(finish(&root(None), &unsupported)), "unsupported@3");
    assert_eq!(
        outcome(begin_direct_message_validation(&[0], &default_context())),
        "frame@2"
    );
}

#[test]
fn owned_context_root_payload_and_consuming_abort() {
    let mut input = root(None);
    let original = input.clone();
    let mut ctx = default_context();
    let session = begin_direct_message_validation(&input, &ctx).unwrap();
    input.fill(0);
    ctx.reader_version = 0;
    ctx.supported_schemas.clear();
    let mut copy = session.payload().clone();
    copy.frame.fill(0);
    copy.payload_bytes.fill(0);
    copy.payload = CborValue::Null;
    assert_eq!(*session.payload(), parsed(&encrypted()));
    assert_eq!(
        session
            .complete_authenticated_content(&content(None))
            .unwrap()
            .root
            .frame,
        original
    );
    begin_direct_message_validation(&root(None), &default_context())
        .unwrap()
        .abort();
    // Reuse after success, failure, or abort is impossible by ownership; public compile-fail
    // examples additionally exercise consumed completion and consumed abort.
    assert!(
        begin_direct_message_validation(&root(None), &default_context())
            .unwrap()
            .complete_authenticated_content(&unknown_item(1))
            .is_err()
    );
}

#[test]
fn plaintext_bound_is_not_route_bound() {
    let r = encrypted();
    let c = content(Some(CborValue::Text("x".repeat(r.len() * 2))));
    let mut ctx = default_context();
    ctx.route_byte_limit = r.len() as u64;
    assert!(c.len() > r.len());
    assert_eq!(
        outcome(
            begin_direct_message_validation(&r, &ctx)
                .unwrap()
                .complete_authenticated_content(&c)
        ),
        "parsed"
    );
    assert_eq!(
        outcome(finish(&r, &vec![0; MAX_FRAME_BYTES + 1])),
        "resource@1"
    );
    ctx.route_byte_limit -= 1;
    assert_eq!(
        outcome(begin_direct_message_validation(&r, &ctx)),
        "resource@1"
    );
}

#[test]
fn aggregate_counters_across_encryption_exact_ceiling_and_one_over() {
    // Identical counts to TS: root 10 containers/80 items; content 7 containers/45 items.
    for (containers, root_count, at) in [(true, 8000, 8360), (false, 60000, 70908)] {
        let r = root(Some(grouped(root_count, containers)));
        assert_eq!(outcome(parse_frame(&r, &default_context())), "parsed");
        for n in [at, at + 1] {
            let c = content(Some(grouped(n, containers)));
            assert_eq!(outcome(parse_frame(&c, &default_context())), "parsed");
            assert_eq!(
                outcome(finish(&r, &c)),
                if n == at { "parsed" } else { "resource@7" }
            );
        }
    }
}

#[test]
fn actual_type5_position_sets_depth_boundary() {
    for (r, at) in [(root(None), 26), (encrypted(), 28)] {
        for n in [at, at + 1] {
            let c = content(Some(nested(n)));
            assert_eq!(outcome(parse_frame(&c, &default_context())), "parsed");
            assert_eq!(
                outcome(finish(&r, &c)),
                if n == at { "parsed" } else { "resource@7" }
            );
        }
    }
    let c = content(Some(nested(28)));
    assert_eq!(outcome(finish(&encrypted(), &c)), "parsed");
    assert_eq!(outcome(finish(&root(None), &c)), "resource@7");
}

fn container(items: Vec<Vec<u8>>) -> Vec<u8> {
    fr(
        TYPE_CONTAINER_MESSAGE_ITEM,
        &cbor_map(vec![(
            container_message_item::ITEMS,
            CborValue::Array(items.into_iter().map(CborValue::Bytes).collect()),
        )]),
    )
}

#[test]
fn recursive_item_depth_and_256_item_budget() {
    let mut item = fr(
        TYPE_TEXT_MESSAGE_ITEM,
        &cbor_map(vec![(
            text_message_item::TEXT,
            CborValue::Text("hello".into()),
        )]),
    );
    for _ in 0..7 {
        item = container(vec![item]);
    }
    assert_eq!(
        outcome(finish(
            &root(None),
            &content_items(None, vec![item.clone()])
        )),
        "parsed"
    );
    item = container(vec![item]);
    let too_deep = content_items(None, vec![item]);
    assert_eq!(
        outcome(parse_frame(&too_deep, &default_context())),
        "parsed"
    );
    assert_eq!(outcome(finish(&root(None), &too_deep)), "resource@7");
    let group = container(vec![unknown_item(1); 127]);
    assert_eq!(
        outcome(finish(
            &root(None),
            &content_items(None, vec![group.clone(), group.clone()])
        )),
        "parsed"
    );
    assert_eq!(
        outcome(finish(
            &root(None),
            &content_items(None, vec![group.clone(), group, unknown_item(1)])
        )),
        "resource@8.4"
    );
}
