use frank_cbor::{
    encode_direct_message_crypto_context, AccountRef, DirectMessageCryptoContext,
    DM_CRYPTO_CONTEXT_DOMAIN,
};

fn bytes(length: usize, value: u8) -> Vec<u8> {
    vec![value; length]
}

fn point(prefix: u8, value: u8) -> Vec<u8> {
    let mut out = vec![prefix];
    out.extend(bytes(32, value));
    out
}

#[test]
fn dm_context_matches_typescript_vector() {
    let sender = AccountRef {
        key_type: 1,
        key_bytes: point(2, 0x11),
    };
    let recipient = AccountRef {
        key_type: 2,
        key_bytes: bytes(32, 0x22),
    };
    let sender_message_key = AccountRef {
        key_type: 1,
        key_bytes: point(2, 0x33),
    };
    let recipient_message_key = AccountRef {
        key_type: 1,
        key_bytes: point(3, 0x44),
    };
    let stamp_key = AccountRef {
        key_type: 1,
        key_bytes: point(2, 0x55),
    };
    let sender_hash = bytes(32, 0xaa);
    let recipient_hash = bytes(32, 0xbb);
    let ephemeral = point(3, 0x66);
    let shared = point(2, 0x77);
    let proof = bytes(64, 0x88);
    let encoded = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network: "monad-testnet",
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
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/dm-suite-1.json"
    ))
    .expect("vector JSON");
    assert_eq!(
        hex::encode(encoded),
        corpus["context"]["encodedHex"]
            .as_str()
            .expect("encodedHex")
    );
}
