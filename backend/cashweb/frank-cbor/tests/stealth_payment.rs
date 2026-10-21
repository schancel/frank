//! Type-19 exact quantities, scheme boundaries and old-reader rejection.
mod common;
use common::{acct1, acct2, fr, int};
use frank_cbor::message_fields::{
    account_ref, container_message_item, payment_transfer as xfer,
    stealth_asset_message_item as item, stealth_asset_transfer as entry_k,
    stealth_derivation_scheme as scheme_k, stealth_message_item, stealth_metadata,
};
use frank_cbor::message_types::{TYPE_CONTAINER_MESSAGE_ITEM, TYPE_STEALTH_MESSAGE_ITEM};
use frank_cbor::{
    cbor_map, default_context, encode_frame, validate_frame, CborValue, EnvelopeFields,
    FramePayload, Projection, StealthQuantity, TypedPayload, ValidationResult,
};

fn set(v: &mut CborValue, key: u64, value: Option<CborValue>) {
    let CborValue::Map(m) = v else { panic!("map") };
    m.retain(|(k, _)| *k != key);
    if let Some(v) = value {
        m.push((key, v));
        m.sort_by_key(|(k, _)| *k);
    }
}
fn transfer() -> CborValue {
    cbor_map(vec![
        (xfer::NETWORK_TAG, CborValue::Text("monad-testnet".into())),
        (xfer::TX_ID, CborValue::Bytes(vec![7; 32])),
        (xfer::DESTINATION, CborValue::Bytes(vec![8; 20])),
        (xfer::VALUE, CborValue::Bytes(vec![255; 32])),
        (xfer::TOKEN, CborValue::Bytes(vec![9; 20])),
        (
            xfer::STEALTH_METADATA,
            cbor_map(vec![
                (stealth_metadata::EPHEMERAL_PUB_KEY, acct1(1)),
                (stealth_metadata::VIEW_TAG, int(65535)),
            ]),
        ),
        (xfer::RAW_TX, CborValue::Bytes(vec![10; 100])),
    ])
}
fn entry() -> CborValue {
    cbor_map(vec![
        (entry_k::TRANSFER, transfer()),
        (
            entry_k::DERIVATION_SCHEME,
            int(scheme_k::SECP256K1_ECDH_ADD_V1.into()),
        ),
        (entry_k::RECIPIENT_SPEND_KEY, acct1(2)),
    ])
}
fn payload(entries: Vec<CborValue>) -> CborValue {
    cbor_map(vec![
        (item::TRANSFERS, CborValue::Array(entries)),
        (item::MEMO, CborValue::Text("memo".into())),
    ])
}
fn frame(payload: &CborValue, schema: u32, min: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: TYPE_STEALTH_MESSAGE_ITEM,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}
fn check(p: &CborValue) -> bool {
    validate_frame(&frame(p, 2, 2), &default_context()).is_ok()
}
fn projected(p: &CborValue) -> frank_cbor::ParsedFrame {
    let ValidationResult::Parsed(p) = validate_frame(&frame(p, 2, 2), &default_context()).unwrap()
    else {
        panic!("parsed")
    };
    p
}
#[test]
fn exact_token_quantity_and_native_uint64_round_trip() {
    let mut native = entry();
    let mut t = transfer();
    set(&mut t, xfer::VALUE, Some(int(u64::MAX as i128)));
    set(&mut t, xfer::TOKEN, None);
    set(&mut native, entry_k::TRANSFER, Some(t));
    let parsed = projected(&payload(vec![entry(), native]));
    assert_eq!(parsed.projection, Projection::Exact);
    let TypedPayload::StealthPaymentItem(p) = parsed.typed.as_deref().unwrap() else {
        panic!("type19")
    };
    assert_eq!(
        p.entries[0].transfer.value,
        StealthQuantity::Quantity256([255; 32])
    );
    assert_eq!(
        p.entries[1].transfer.value,
        StealthQuantity::Uint64(u64::MAX)
    );
    assert_eq!(p.entries[0].transfer.token, Some(vec![9; 20]));
    assert_eq!(p.entries[1].transfer.token, None);
}
#[test]
fn schema1_recovery_remains_exact() {
    let p = cbor_map(vec![
        (
            stealth_message_item::NETWORK_TAG,
            CborValue::Text("monad-testnet".into()),
        ),
        (stealth_message_item::EPHEMERAL_PUB_KEY, acct1(1)),
        (
            stealth_message_item::TRANSACTIONS,
            CborValue::Array(vec![CborValue::Bytes(vec![1; 100])]),
        ),
        (stealth_message_item::AMOUNT, int(u64::MAX as i128)),
    ]);
    let ValidationResult::Parsed(p) =
        validate_frame(&fr(TYPE_STEALTH_MESSAGE_ITEM, &p), &default_context()).unwrap()
    else {
        panic!("parsed")
    };
    let TypedPayload::NativeStealthItem(p) = p.typed.as_deref().unwrap() else {
        panic!("native")
    };
    assert_eq!(p.amount, u64::MAX);
}
#[test]
fn old_schema_context_cannot_project_new_shape() {
    let bytes = frame(&payload(vec![entry()]), 2, 2);
    let mut old = default_context();
    old.supported_schemas
        .iter_mut()
        .find(|s| s.type_id == TYPE_STEALTH_MESSAGE_ITEM)
        .unwrap()
        .schema_version = 1;
    assert!(validate_frame(&bytes, &old).is_err());
    assert!(validate_frame(&frame(&payload(vec![entry()]), 2, 1), &default_context()).is_err());
    assert!(validate_frame(&frame(&payload(vec![entry()]), 3, 1), &default_context()).is_err());
}
#[test]
fn unknown_schemes_preserve_data_without_allocating_solana() {
    // raw-cbor-key: schemes the reader must treat as unallocated, including Solana's id
    for scheme in [2, u32::MAX] {
        let mut e = entry();
        set(
            &mut e,
            entry_k::DERIVATION_SCHEME,
            Some(int(scheme as i128)),
        );
        set(&mut e, entry_k::RECIPIENT_SPEND_KEY, Some(acct2(2)));
        let mut t = transfer();
        set(
            &mut t,
            xfer::STEALTH_METADATA,
            Some(cbor_map(vec![
                (stealth_metadata::EPHEMERAL_PUB_KEY, acct2(1)),
                (stealth_metadata::VIEW_TAG, CborValue::Bytes(vec![12; 32])),
            ])),
        );
        set(&mut e, entry_k::TRANSFER, Some(t));
        set(
            &mut e,
            entry_k::TOKEN_PROGRAM,
            Some(CborValue::Bytes(vec![13; 32])),
        );
        set(
            &mut e,
            entry_k::DERIVATION_CONTEXT,
            Some(CborValue::Bytes(vec![14; 1024])),
        );
        let parsed = projected(&payload(vec![e]));
        let TypedPayload::StealthPaymentItem(p) = parsed.typed.as_deref().unwrap() else {
            panic!("type19")
        };
        assert_eq!(p.entries[0].scheme, scheme);
        assert_eq!(p.entries[0].scheme_context, Some(vec![14; 1024]));
    }
}
#[test]
fn rejects_unsafe_or_ambiguous_entries() {
    let mut bad = Vec::new();
    let mut zero_scheme = entry();
    // raw-cbor-key: scheme 0 is deliberately unallocated
    set(&mut zero_scheme, entry_k::DERIVATION_SCHEME, Some(int(0)));
    bad.push(zero_scheme);
    for value in [
        int(0),
        int(-1),
        CborValue::Bytes(vec![0; 32]),
        CborValue::Bytes(vec![1; 31]),
    ] {
        let mut e = entry();
        let mut t = transfer();
        set(&mut t, xfer::VALUE, Some(value));
        set(&mut e, entry_k::TRANSFER, Some(t));
        bad.push(e);
    }
    for field in [xfer::STEALTH_METADATA] {
        let mut e = entry();
        let mut t = transfer();
        set(&mut t, field, None);
        set(&mut e, entry_k::TRANSFER, Some(t));
        bad.push(e);
    }
    let mut mismatch = entry();
    set(&mut mismatch, entry_k::RECIPIENT_SPEND_KEY, Some(acct2(1)));
    bad.push(mismatch);
    for field in [entry_k::TOKEN_PROGRAM, entry_k::DERIVATION_CONTEXT] {
        let mut e = entry();
        set(&mut e, field, Some(CborValue::Bytes(vec![1; 32])));
        bad.push(e);
    }
    let mut no_token = entry();
    // raw-cbor-key: scheme 99 is deliberately unallocated
    set(&mut no_token, entry_k::DERIVATION_SCHEME, Some(int(99)));
    set(
        &mut no_token,
        entry_k::TOKEN_PROGRAM,
        Some(CborValue::Bytes(vec![1; 32])),
    );
    let mut t = transfer();
    set(&mut t, xfer::TOKEN, None);
    set(&mut no_token, entry_k::TRANSFER, Some(t));
    bad.push(no_token);
    let mut extra = entry();
    // raw-cbor-key: undeclared entry field
    set(&mut extra, 5, Some(CborValue::Bytes(vec![1; 20])));
    bad.push(extra);
    let mut nested_extra = entry();
    let mut t = transfer();
    // raw-cbor-key: undeclared transfer field
    set(&mut t, 9, Some(int(1)));
    set(&mut nested_extra, entry_k::TRANSFER, Some(t));
    bad.push(nested_extra);
    for (i, e) in bad.into_iter().enumerate() {
        assert!(!check(&payload(vec![e])), "accepted invalid case {i}");
    }
}
#[test]
fn bounded_arrays_text_and_context() {
    assert!(!check(&payload(vec![])));
    assert!(check(&payload(vec![entry(); 16])));
    assert!(!check(&payload(vec![entry(); 17])));
    let mut p = payload(vec![entry()]);
    set(&mut p, item::MEMO, Some(CborValue::Text("x".repeat(1024))));
    assert!(check(&p));
    set(&mut p, item::MEMO, Some(CborValue::Text("x".repeat(1025))));
    assert!(!check(&p));
    for (field, length) in [
        (entry_k::TOKEN_PROGRAM, 31),
        (entry_k::TOKEN_PROGRAM, 33),
        (entry_k::DERIVATION_CONTEXT, 0),
        (entry_k::DERIVATION_CONTEXT, 1025),
    ] {
        let mut e = entry();
        // raw-cbor-key: scheme 99 is deliberately unallocated
        set(&mut e, entry_k::DERIVATION_SCHEME, Some(int(99)));
        set(&mut e, field, Some(CborValue::Bytes(vec![1; length])));
        assert!(!check(&payload(vec![e])));
    }
}

#[test]
fn nested_known_stealth_malformed_payload_is_rejected_not_retained() {
    let child = frame(&payload(vec![entry()]), 2, 2);
    let container = fr(
        TYPE_CONTAINER_MESSAGE_ITEM,
        &cbor_map(vec![(
            container_message_item::ITEMS,
            CborValue::Array(vec![CborValue::Bytes(child)]),
        )]),
    );
    let ValidationResult::Parsed(p) = validate_frame(&container, &default_context()).unwrap()
    else {
        panic!("container")
    };
    let TypedPayload::ContainerItem { items, .. } = p.typed.as_deref().unwrap() else {
        panic!("container")
    };
    assert!(
        matches!(&items[0], frank_cbor::ChildFrame::Parsed(p) if matches!(p.typed.as_deref(), Some(TypedPayload::StealthPaymentItem(_))))
    );
    let malformed = frame(&payload(vec![]), 2, 2);
    let container = fr(
        TYPE_CONTAINER_MESSAGE_ITEM,
        &cbor_map(vec![(
            container_message_item::ITEMS,
            CborValue::Array(vec![CborValue::Bytes(malformed)]),
        )]),
    );
    assert!(validate_frame(&container, &default_context()).is_err());
}

#[test]
fn compatible_future_outer_fields_remain_data() {
    let mut p = payload(vec![entry()]);
    // raw-cbor-key: compatible future outer field
    set(&mut p, 9, Some(CborValue::Bytes(vec![42; 3])));
    assert!(!check(&p));
    let ValidationResult::Parsed(p) = validate_frame(&frame(&p, 3, 2), &default_context()).unwrap()
    else {
        panic!("parsed")
    };
    assert_eq!(p.projection, Projection::NewerSchema);
    let TypedPayload::StealthPaymentItem(p) = p.typed.as_deref().unwrap() else {
        panic!("type19")
    };
    // raw-cbor-key: compatible future outer field
    assert_eq!(p.unknown, vec![(9, CborValue::Bytes(vec![42; 3]))]);
}

#[test]
fn unallocated_key_types_fail_allocated_stage() {
    let unknown_key = cbor_map(vec![
        // raw-cbor-key: key type 500 is deliberately unallocated
        (account_ref::KEY_TYPE, int(500)),
        (account_ref::KEY_BYTES, CborValue::Bytes(vec![1; 32])),
    ]);
    let mut e = entry();
    // raw-cbor-key: scheme 99 is deliberately unallocated
    set(&mut e, entry_k::DERIVATION_SCHEME, Some(int(99)));
    set(
        &mut e,
        entry_k::RECIPIENT_SPEND_KEY,
        Some(unknown_key.clone()),
    );
    let mut t = transfer();
    set(
        &mut t,
        xfer::STEALTH_METADATA,
        Some(cbor_map(vec![(
            stealth_metadata::EPHEMERAL_PUB_KEY,
            unknown_key,
        )])),
    );
    set(&mut e, entry_k::TRANSFER, Some(t));
    match validate_frame(&frame(&payload(vec![e]), 2, 2), &default_context()) {
        Err(frank_cbor::Error::Codec(e)) => {
            assert_eq!(e.category, frank_cbor::ErrorCategory::Unsupported);
            assert_eq!(e.stage, frank_cbor::ErrorStage::S83);
        }
        result => panic!("expected allocated-key rejection, got {result:?}"),
    }
}

#[test]
fn shared_typescript_stealth_assets_vectors_agree() {
    // Generated and owned by packages/frank-codec fixtures/stealth-assets.ts. This test
    // intentionally requires that wire predecessor's corpus in the integration candidate.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/protocol/cbor/vectors/stealth-assets.json");
    let source = std::fs::read_to_string(path).expect("shared TypeScript stealth-assets corpus");
    let corpus: serde_json::Value = serde_json::from_str(&source).expect("shared corpus JSON");
    let cases = corpus["cases"].as_array().expect("shared cases");
    assert_eq!(cases.len(), 8);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let bytes = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        match case["expectation"].as_str().unwrap() {
            "accepted" => {
                let ValidationResult::Parsed(p) = validate_frame(&bytes, &default_context())
                    .unwrap_or_else(|e| panic!("{id}: {e:?}"))
                else {
                    panic!("{id}: expected parsed")
                };
                assert_eq!(
                    p.schema_version,
                    case["schema_version"].as_u64().unwrap() as u32,
                    "{id}"
                );
                assert_eq!(
                    frank_cbor::encode_canonical(&p.payload).unwrap(),
                    p.payload_bytes,
                    "{id}: byte identity"
                );
                if p.schema_version == 2 {
                    assert!(
                        matches!(
                            p.typed.as_deref(),
                            Some(TypedPayload::StealthPaymentItem(_))
                        ),
                        "{id}"
                    );
                    let mut old = default_context();
                    old.supported_schemas
                        .iter_mut()
                        .find(|s| s.type_id == TYPE_STEALTH_MESSAGE_ITEM)
                        .unwrap()
                        .schema_version = 1;
                    assert!(
                        validate_frame(&bytes, &old).is_err(),
                        "{id}: old schema projection accepted"
                    );
                } else {
                    assert!(
                        matches!(p.typed.as_deref(), Some(TypedPayload::NativeStealthItem(_))),
                        "{id}"
                    );
                }
            }
            "rejected" => match validate_frame(&bytes, &default_context()) {
                Err(frank_cbor::Error::Codec(e)) => {
                    assert_eq!(
                        e.category.as_str(),
                        case["error_category"].as_str().unwrap(),
                        "{id}"
                    );
                    assert_eq!(
                        e.stage.as_str(),
                        case["error_stage"].as_str().unwrap(),
                        "{id}"
                    );
                }
                result => panic!("{id}: expected rejection, got {result:?}"),
            },
            other => panic!("{id}: unknown expectation {other}"),
        }
    }
}

fn shared_native_uint64_frame() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/protocol/cbor/vectors/stealth-assets.json");
    let source = std::fs::read_to_string(path).expect("shared TypeScript stealth-assets corpus");
    let corpus: serde_json::Value = serde_json::from_str(&source).expect("shared corpus JSON");
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "native-uint64-max")
        .unwrap();
    hex::decode(case["frame_hex"].as_str().unwrap()).unwrap()
}

fn old_stealth_schema_context() -> frank_cbor::ValidationContext {
    let mut ctx = default_context();
    // A high semantic reader version must not imply per-type schema support.
    ctx.reader_version = 4;
    ctx.supported_schemas
        .iter_mut()
        .find(|s| s.type_id == TYPE_STEALTH_MESSAGE_ITEM)
        .unwrap()
        .schema_version = 1;
    ctx
}

#[test]
fn old_stealth_schema_retains_root_when_opaque_retention_is_allowed() {
    let bytes = shared_native_uint64_frame();
    let mut ctx = old_stealth_schema_context();
    ctx.opaque_retention_allowed = true;
    let ValidationResult::Retained(retained) = validate_frame(&bytes, &ctx).unwrap() else {
        panic!("expected opaque root")
    };
    assert_eq!(
        retained.reason,
        frank_cbor::RetentionReason::UnsupportedMinReader
    );
    assert_eq!(retained.frame, bytes);
    assert_eq!(retained.type_id, Some(TYPE_STEALTH_MESSAGE_ITEM));
    assert_eq!(retained.schema_version, Some(2));
    assert_eq!(retained.min_reader_version, Some(2));
    ctx.opaque_retention_allowed = false;
    match validate_frame(&bytes, &ctx) {
        Err(frank_cbor::Error::Codec(e)) => {
            assert_eq!(e.category, frank_cbor::ErrorCategory::Unsupported);
            assert_eq!(e.stage, frank_cbor::ErrorStage::S7);
        }
        result => panic!("expected unsupported root, got {result:?}"),
    }
}

#[test]
fn old_stealth_schema_retains_open_child_without_rejecting_parent() {
    let bytes = shared_native_uint64_frame();
    let container = fr(
        TYPE_CONTAINER_MESSAGE_ITEM,
        &cbor_map(vec![(
            container_message_item::ITEMS,
            CborValue::Array(vec![CborValue::Bytes(bytes.clone())]),
        )]),
    );
    let ctx = old_stealth_schema_context();
    assert!(!ctx.opaque_retention_allowed);
    let ValidationResult::Parsed(parsed) = validate_frame(&container, &ctx).unwrap() else {
        panic!("expected parsed container")
    };
    assert_eq!(parsed.type_id, TYPE_CONTAINER_MESSAGE_ITEM);
    let TypedPayload::ContainerItem { items, .. } = parsed.typed.as_deref().unwrap() else {
        panic!("expected container projection")
    };
    assert_eq!(items.len(), 1);
    let frank_cbor::ChildFrame::Retained(retained) = &items[0] else {
        panic!("expected retained open child")
    };
    assert_eq!(
        retained.reason,
        frank_cbor::RetentionReason::UnsupportedMinReader
    );
    assert_eq!(retained.frame, bytes);
    assert_eq!(retained.type_id, Some(TYPE_STEALTH_MESSAGE_ITEM));
    assert_eq!(retained.schema_version, Some(2));
    assert_eq!(retained.min_reader_version, Some(2));
}
