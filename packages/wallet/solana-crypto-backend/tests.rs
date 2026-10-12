use super::*;
use serde_json::Value;

fn decode(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}
fn raw(v: &Value, field: &str) -> [u8; 32] {
    decode(v[field].as_str().unwrap()).try_into().unwrap()
}
fn fixtures() -> Value {
    serde_json::from_str(include_str!("../solana-stealth-vectors/vectors.json")).unwrap()
}
fn descriptor(v: &Value) -> Descriptor {
    let a = v["asset"].as_array().unwrap();
    Descriptor {
        chain_identifier: v["chainIdentifier"].as_str().unwrap().to_owned(),
        asset: if a[0] == 0 {
            Asset::Native
        } else {
            Asset::Spl {
                mint: decode(a[1].as_str().unwrap()).try_into().unwrap(),
                token_program: decode(a[2].as_str().unwrap()).try_into().unwrap(),
            }
        },
        recipient: raw(v, "B"),
        ephemeral: raw(v, "R"),
        operation_id: raw(v, "operationId"),
        member_index: v["memberIndex"].as_u64().unwrap() as u32,
        message_context: raw(v, "messageContext"),
        recipient_amount: v["amount"].as_str().unwrap().parse().unwrap(),
    }
}
fn scope(v: &Value) -> CustodyScope {
    CustodyScope::new(
        [7; 32],
        v["chainIdentifier"].as_str().unwrap().to_owned(),
        Zeroizing::new(raw(v, "seed")),
    )
    .unwrap()
}

#[test]
fn independent_vectors_match_exact_transcript_destination_and_signatures() {
    for v in fixtures()["vectors"].as_array().unwrap() {
        let scope = scope(v);
        let d = descriptor(v);
        assert_eq!(transcript(&d), decode(v["Q"].as_str().unwrap()));
        for s in v["signatures"].as_array().unwrap() {
            let message = decode(s["message"].as_str().unwrap());
            let signed = scope
                .prepare(&d, raw(v, "P"), &message)
                .unwrap()
                .sign()
                .unwrap();
            assert_eq!(signed.account_id, [7; 32]);
            assert_eq!(signed.public_key, raw(v, "P"));
            assert_eq!(
                signed.signature.as_slice(),
                decode(s["signature"].as_str().unwrap())
            );
        }
    }
}

#[test]
fn immutable_message_capture_and_one_shot_signing() {
    let f = fixtures();
    let v = &f["vectors"][0];
    let scope = scope(v);
    let s = &v["signatures"][1];
    let mut message = decode(s["message"].as_str().unwrap());
    let signer = scope
        .prepare(&descriptor(v), raw(v, "P"), &message)
        .unwrap();
    message.fill(0);
    let signed = signer.sign().unwrap(); // Consumes the signer: cannot call a second time.
    assert_eq!(
        signed.signature.as_slice(),
        decode(s["signature"].as_str().unwrap())
    );
}

#[test]
fn revoke_and_drop_invalidate_prepared_signers() {
    let f = fixtures();
    let v = &f["vectors"][0];
    let mut owner = scope(v);
    let signer = owner
        .prepare(&descriptor(v), raw(v, "P"), b"reviewed message")
        .unwrap();
    owner.revoke();
    assert!(matches!(signer.sign(), Err(Error::Revoked)));
    assert!(matches!(
        owner.prepare(&descriptor(v), raw(v, "P"), b""),
        Err(Error::Revoked)
    ));
    let owner = scope(v);
    let signer = owner
        .prepare(&descriptor(v), raw(v, "P"), b"reviewed message")
        .unwrap();
    drop(owner);
    assert!(matches!(signer.sign(), Err(Error::Revoked)));
}

#[test]
fn canonical_chain_binding_rejects_unknown_alias_other_family_and_switched_network() {
    let f = fixtures();
    let v = &f["vectors"][0];
    for chain in ["solana", "SOLD", "monad-testnet", "solana-unknown"] {
        assert!(matches!(
            CustodyScope::new([7; 32], chain.to_owned(), Zeroizing::new(raw(v, "seed"))),
            Err(Error::InvalidChain)
        ));
    }
    let owner = scope(v);
    let mut d = descriptor(v);
    d.chain_identifier = "solana-mainnet".to_owned();
    assert!(matches!(
        owner.prepare(&d, raw(v, "P"), b""),
        Err(Error::InvalidChain)
    ));
}

#[test]
fn recipient_points_and_wrong_seed_fail_closed() {
    let f = fixtures();
    let v = &f["vectors"][0];
    let owner = scope(v);
    for value in f["invalidPoints"].as_object().unwrap().values() {
        if let Ok(encoded_point) = <[u8; 32]>::try_from(decode(value.as_str().unwrap())) {
            let mut d = descriptor(v);
            d.recipient = encoded_point;
            assert!(matches!(
                owner.prepare(&d, raw(v, "P"), b""),
                Err(Error::InvalidPoint)
            ));
            let mut d = descriptor(v);
            d.ephemeral = encoded_point;
            assert!(matches!(
                owner.prepare(&d, raw(v, "P"), b""),
                Err(Error::InvalidPoint)
            ));
        }
    }
    let wrong = CustodyScope::new(
        [7; 32],
        "solana-devnet".to_owned(),
        Zeroizing::new([99; 32]),
    )
    .unwrap();
    assert!(matches!(
        wrong.prepare(&descriptor(v), raw(v, "P"), b""),
        Err(Error::WrongRecipient)
    ));
}

#[test]
fn altered_descriptor_and_claimed_destination_fail_before_signing() {
    let f = fixtures();
    let v = &f["vectors"][0];
    let owner = scope(v);
    for case in 0..6 {
        let mut d = descriptor(v);
        match case {
            0 => d.operation_id[0] ^= 1,
            1 => d.member_index += 1,
            2 => d.message_context[0] ^= 1,
            3 => d.recipient_amount += 1,
            4 => {
                d.asset = Asset::Spl {
                    mint: [17; 32],
                    token_program: [34; 32],
                }
            }
            _ => d.ephemeral = ED25519_BASEPOINT_POINT.compress().to_bytes(),
        }
        // Original fixture already uses r=1: use another valid R for the final case.
        if case == 5 {
            d.ephemeral = (ED25519_BASEPOINT_POINT * Scalar::from(2u64))
                .compress()
                .to_bytes();
        }
        assert!(matches!(
            owner.prepare(&d, raw(v, "P"), b""),
            Err(Error::InvalidDestination)
        ));
    }
    let mut d = descriptor(v);
    d.recipient_amount = 0;
    assert!(matches!(
        owner.prepare(&d, raw(v, "P"), b""),
        Err(Error::InvalidAmount)
    ));
    assert!(matches!(
        owner.prepare(&descriptor(v), [0; 32], b""),
        Err(Error::InvalidDestination)
    ));
    assert!(matches!(
        owner.prepare(&descriptor(v), raw(v, "P"), &[0; 1233]),
        Err(Error::InvalidMessage)
    ));
}
