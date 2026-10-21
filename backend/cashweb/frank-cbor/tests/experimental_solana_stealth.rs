//! Experimental cross-language proof only. No helper is installed in the generic parser.
use frank_cbor::message_fields::stealth_asset_transfer;
use frank_cbor::message_types::TYPE_STEALTH_MESSAGE_ITEM;
use frank_cbor::{
    decode_canonical, default_context, encode_canonical, validate_frame, CborValue,
    StealthQuantity, TypedPayload, ValidationResult,
};

fn corpus() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/frank-codec/fixtures/experimental-solana-stealth-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("generated TS corpus")).unwrap()
}

fn context(bytes: &[u8]) -> Result<([u8; 32], u32, [u8; 32]), &'static str> {
    if bytes.len() > 74 {
        return Err("context exceeds bound");
    }
    let CborValue::Array(fields) = decode_canonical(bytes).map_err(|_| "canonical CBOR")? else {
        return Err("array required");
    };
    let [CborValue::Bytes(operation), CborValue::Int(index), CborValue::Bytes(random)] =
        fields.as_slice()
    else {
        return Err("array3 required");
    };
    Ok((
        operation.as_slice().try_into().map_err(|_| "operation32")?,
        (*index).try_into().map_err(|_| "uint32 index")?,
        random.as_slice().try_into().map_err(|_| "context32")?,
    ))
}

#[test]
fn experimental_public_bindings_match_typescript_without_scheme_allocation() {
    for case in corpus()["cases"].as_array().unwrap() {
        let bytes = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        let ValidationResult::Parsed(p) = validate_frame(&bytes, &default_context()).unwrap()
        else {
            panic!("expected parsed structural frame");
        };
        let TypedPayload::StealthPaymentItem(item) = p.typed.as_deref().unwrap() else {
            panic!("expected recipient item");
        };
        assert_eq!(item.entries.len(), 1);
        let e = &item.entries[0];
        let t = &e.transfer;
        assert_eq!(e.scheme, 2); // Still unknown to the generic reader.
        assert_eq!((e.recipient.key_type, t.ephemeral.key_type), (2, 2));
        assert_eq!(
            (e.recipient.key_bytes.len(), t.ephemeral.key_bytes.len()),
            (32, 32)
        );
        assert_eq!((t.destination.len(), t.tx_id.len()), (32, 64));
        assert!((1..=16384).contains(&t.raw_tx.as_ref().unwrap().len()));
        assert!(t.vout.is_none());
        let registry: serde_json::Value =
            serde_json::from_str(include_str!("../../../../docs/protocol/chains/v1.json")).unwrap();
        assert!(registry["chains"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == t.network && c["family"] == "solana"));
        let StealthQuantity::Uint64(amount) = t.value else {
            panic!("uint64 required");
        };
        assert!(amount > 0);
        let asset = if let Some(mint) = &t.token {
            assert_eq!(mint.len(), 32);
            let program = e.token_program.as_ref().unwrap();
            assert_eq!(
                hex::encode(program),
                "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9"
            );
            CborValue::Array(vec![
                CborValue::Int(1),
                CborValue::Bytes(mint.clone()),
                CborValue::Bytes(program.clone()),
            ])
        } else {
            assert!(e.token_program.is_none());
            CborValue::Array(vec![CborValue::Int(0)])
        };
        let context_bytes = e.scheme_context.as_ref().unwrap();
        assert_eq!(
            hex::encode(context_bytes),
            case["context_hex"].as_str().unwrap()
        );
        let (operation, index, random) = context(context_bytes).unwrap();
        assert_eq!(
            encode_canonical(&CborValue::Array(vec![
                CborValue::Bytes(operation.to_vec()),
                CborValue::Int(i128::from(index)),
                CborValue::Bytes(random.to_vec())
            ]))
            .unwrap(),
            *context_bytes
        );
        let q = encode_canonical(&CborValue::Array(vec![
            CborValue::Text("frank:solana-stealth:edwards-add:v1".into()),
            CborValue::Text(t.network.clone()),
            asset,
            CborValue::Bytes(e.recipient.key_bytes.clone()),
            CborValue::Bytes(t.ephemeral.key_bytes.clone()),
            CborValue::Bytes(operation.to_vec()),
            CborValue::Int(i128::from(index)),
            CborValue::Bytes(random.to_vec()),
            CborValue::Int(i128::from(amount)),
        ]))
        .unwrap();
        assert_eq!(hex::encode(q), case["transcript_hex"].as_str().unwrap());
        assert_eq!(encode_canonical(&p.payload).unwrap(), p.payload_bytes);
        if case["id"] == "classic-spl-u64-max-u32-max" {
            assert_eq!(index, u32::MAX);
            assert_eq!(amount, u64::MAX);
        }
    }
}

#[test]
fn malformed_contexts_are_rejected_only_by_experimental_helper() {
    for case in corpus()["invalid_contexts"].as_array().unwrap() {
        let bytes = hex::decode(case["context_hex"].as_str().unwrap()).unwrap();
        assert!(context(&bytes).is_err(), "{}", case["id"]);
    }
    let case = &corpus()["cases"][0];
    let bytes = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
    let ValidationResult::Parsed(mut p) = validate_frame(&bytes, &default_context()).unwrap()
    else {
        panic!("expected parsed");
    };
    let CborValue::Map(payload) = &mut p.payload else {
        panic!("map")
    };
    let CborValue::Array(entries) = &mut payload[0].1 else {
        panic!("array")
    };
    let CborValue::Map(entry) = &mut entries[0] else {
        panic!("map")
    };
    entry
        .iter_mut()
        .find(|(k, _)| *k == stealth_asset_transfer::DERIVATION_CONTEXT)
        .unwrap()
        .1 = CborValue::Bytes(vec![255]);
    let wire = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: TYPE_STEALTH_MESSAGE_ITEM,
            schema_version: 2,
            min_reader_version: 2,
        },
        frank_cbor::FramePayload::Value(&p.payload),
    )
    .unwrap();
    assert!(validate_frame(&wire, &default_context()).is_ok());
}
