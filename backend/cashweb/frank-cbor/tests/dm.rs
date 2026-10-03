use frank_cbor::{
    cbor_map, encode_direct_message_crypto_context, encode_frame, AccountRef, CborValue,
    DirectMessageCryptoContext, EnvelopeFields, FramePayload, DM_CRYPTO_CONTEXT_DOMAIN,
};

fn account(value: &serde_json::Value) -> AccountRef {
    AccountRef {
        key_type: value["keyType"].as_u64().expect("keyType") as u32,
        key_bytes: hex::decode(value["keyHex"].as_str().expect("keyHex")).expect("key hex"),
    }
}

fn account_value(value: &AccountRef) -> CborValue {
    cbor_map(vec![
        (0, CborValue::Int(i128::from(value.key_type))),
        (1, CborValue::Bytes(value.key_bytes.clone())),
    ])
}

#[test]
fn dm_context_matches_typescript_vector() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/dm-suite-1.json"
    ))
    .expect("vector JSON");
    let context = &corpus["context"];
    let sender = account(&context["sender"]);
    let recipient = account(&context["recipient"]);
    let sender_message_key = account(&context["senderMessageKey"]);
    let recipient_message_key = account(&context["recipientMessageKey"]);
    let stamp_key = account(&context["stampKey"]);
    let sender_hash = hex::decode(context["senderDirectoryHashHex"].as_str().unwrap()).unwrap();
    let recipient_hash =
        hex::decode(context["recipientDirectoryHashHex"].as_str().unwrap()).unwrap();
    let ephemeral = hex::decode(context["ephemeralPointHex"].as_str().unwrap()).unwrap();
    let shared = hex::decode(context["sharedPointHex"].as_str().unwrap()).unwrap();
    let proof = hex::decode(context["dleqProofHex"].as_str().unwrap()).unwrap();
    let encoded = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network: context["network"].as_str().unwrap(),
        sender: &sender,
        recipient: &recipient,
        sender_directory_hash: &sender_hash,
        recipient_directory_hash: &recipient_hash,
        sender_message_key: &sender_message_key,
        recipient_message_key: &recipient_message_key,
        stamp_key: &stamp_key,
        ephemeral_point: &ephemeral,
        shared_point: &shared,
        dleq_proof: &proof,
    })
    .expect("context");

    assert_eq!(DM_CRYPTO_CONTEXT_DOMAIN, "frank/dm-crypto-context/v1");
    assert_eq!(
        hex::encode(encoded),
        corpus["context"]["encodedHex"]
            .as_str()
            .expect("encodedHex")
    );

    let payload = cbor_map(vec![
        (
            0,
            CborValue::Text(context["network"].as_str().unwrap().into()),
        ),
        (1, account_value(&sender)),
        (2, account_value(&recipient)),
        (3, CborValue::Int(1)),
        (
            4,
            CborValue::Bytes(
                hex::decode(corpus["cryptoBox"]["envelopeHex"].as_str().unwrap()).unwrap(),
            ),
        ),
        (5, CborValue::Bytes(ephemeral)),
        (6, CborValue::Bytes(shared)),
        (7, CborValue::Bytes(proof)),
    ]);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: 5,
            schema_version: 2,
            min_reader_version: 2,
        },
        FramePayload::Value(&payload),
    )
    .expect("type-5 frame");
    assert_eq!(
        hex::encode(frame),
        corpus["type5FrameHex"].as_str().expect("type5FrameHex")
    );
}
