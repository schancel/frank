use frank_cbor::message_fields::{
    account_ref, encryption_suite, key_type, recipient_encrypted_payload_v2 as rep2,
};
use frank_cbor::message_types::TYPE_RECIPIENT_ENCRYPTED_PAYLOAD;
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
        (
            account_ref::KEY_TYPE,
            CborValue::Int(i128::from(value.key_type)),
        ),
        (
            account_ref::KEY_BYTES,
            CborValue::Bytes(value.key_bytes.clone()),
        ),
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
    let encode_with = |message_key: &AccountRef, ephemeral_point: &[u8]| {
        encode_direct_message_crypto_context(&DirectMessageCryptoContext {
            network: context["network"].as_str().unwrap(),
            sender: &sender,
            recipient: &recipient,
            sender_directory_hash: &sender_hash,
            recipient_directory_hash: &recipient_hash,
            sender_message_key: message_key,
            recipient_message_key: &recipient_message_key,
            stamp_key: &stamp_key,
            ephemeral_point,
            shared_point: &shared,
            dleq_proof: &proof,
        })
    };
    let encoded = encode_with(&sender_message_key, &ephemeral).expect("context");

    assert_eq!(DM_CRYPTO_CONTEXT_DOMAIN, "frank/dm-crypto-context/v1");
    assert_eq!(
        hex::encode(encoded),
        corpus["context"]["encodedHex"]
            .as_str()
            .expect("encodedHex")
    );

    let uncompressed = hex::decode(concat!(
        "04",
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
    ))
    .unwrap();
    let uncompressed_account = AccountRef {
        key_type: key_type::SECP256K1,
        key_bytes: uncompressed.clone(),
    };
    assert!(encode_with(&uncompressed_account, &ephemeral).is_err());
    assert!(encode_with(&sender_message_key, &uncompressed).is_err());

    let payload = cbor_map(vec![
        (
            rep2::NETWORK,
            CborValue::Text(context["network"].as_str().unwrap().into()),
        ),
        (rep2::SENDER, account_value(&sender)),
        (rep2::RECIPIENT, account_value(&recipient)),
        (
            rep2::SUITE,
            CborValue::Int(encryption_suite::DM_AUTH_XCHACHA.into()),
        ),
        (
            rep2::CRYPTO_BOX_ENVELOPE,
            CborValue::Bytes(
                hex::decode(corpus["cryptoBox"]["envelopeHex"].as_str().unwrap()).unwrap(),
            ),
        ),
        (rep2::EPHEMERAL_POINT, CborValue::Bytes(ephemeral)),
        (rep2::SHARED_POINT, CborValue::Bytes(shared)),
        (rep2::DLEQ_PROOF, CborValue::Bytes(proof)),
    ]);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
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
