use super::*;
use crate::directory_admission::{Checkpoint, CheckpointKind, Status};
use frank_cbor::{
    decode_canonical, directory_signature_digest, encode_canonical, encode_frame,
    preview_directory_context, CborValue, EnvelopeFields, FramePayload,
};
use secp256k1_abc::Message;

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/dm-runtime.json"
    ))
    .unwrap()
}
fn bytes(v: &serde_json::Value, key: &str) -> Vec<u8> {
    hex::decode(v[key].as_str().unwrap()).unwrap()
}

// Explicit offline fixture, not admission or continuity construction for a runtime caller.
fn fixture_current(v: &serde_json::Value) -> Current {
    let evidence = HistoricalEvidence {
        statement: bytes(v, "statement"),
        attestation: bytes(v, "attestation"),
        hash: bytes(v, "t1").try_into().unwrap(),
    };
    let now = Timestamp {
        seconds: v["checked_time_seconds"].as_i64().unwrap(),
        nanoseconds: 0,
    };
    fixture_current_evidence(evidence, now)
}

fn fixture_current_evidence(evidence: HistoricalEvidence, now: Timestamp) -> Current {
    let value = tuple(&evidence, "monad").unwrap();
    let status = Status {
        checkpoint: Checkpoint {
            kind: CheckpointKind::CommittedPrefix,
            identity: [0; 32],
            anchor: evidence.hash,
            head: Some(evidence.hash),
            accepted: 1,
            retained: 1,
            evidence_digest: [0; 32],
            checked_time: (now.seconds, now.nanoseconds),
            forked: false,
        },
        head: Some(evidence.hash),
        revision: Some(value.revision),
        generations: Some(value.generations),
        current_stamp: Some(value.stamp.clone()),
        previous_stamp: None,
        accepted: 1,
        retained: 1,
        charged_bytes: evidence.statement.len() + evidence.attestation.len(),
        forked: false,
        checked_time: now,
    };
    Current {
        evidence,
        message_key: value.message,
        stamp_key: value.stamp,
        previous_stamp: None,
        relay: frank_cbor::RelayBinding {
            relay_id: vec![],
            endpoint: String::new(),
            identity: value.subject.clone(),
            expiry: now,
            unknown: vec![],
        },
        revision: value.revision,
        generations: value.generations,
        status,
    }
}

fn check(
    delivery: &[u8],
    context: &[u8],
    sender: &Current,
    recipient: &Current,
) -> Result<CanonicalStampChecks> {
    verify_canonical_stamp(CanonicalStampCheckInput {
        delivery,
        context,
        sender_current: sender,
        recipient_current: recipient,
        recipient_evidence: None,
    })
}

#[test]
fn exact_ts_envelope_context_and_stamp_checks_do_not_claim_a_payment() {
    let v = &corpus()["runtime_case"];
    let current = fixture_current(v);
    let delivery = bytes(v, "delivery");
    let context = bytes(v, "context");
    let checks = check(&delivery, &context, &current, &current).unwrap();
    assert_eq!(
        hex::encode(checks.payload_digest),
        v["t3"].as_str().unwrap()
    );
    assert_eq!(checks.payments.len(), 1);
    assert_eq!(
        hex::encode(&checks.payments[0].commitment),
        v["t4"].as_str().unwrap()
    );
    let mut bad_context = context.clone();
    let last = bad_context.len() - 1;
    bad_context[last] ^= 1;
    assert!(check(&delivery, &bad_context, &current, &current).is_err());
    for field in ["message", "stamp", "t1", "fork", "generation", "expiry"] {
        let mut altered = current.clone();
        match field {
            "message" => altered.message_key = altered.stamp_key.clone(),
            "stamp" => altered.stamp_key = altered.message_key.clone(),
            "t1" => altered.evidence.hash[0] ^= 1,
            "fork" => altered.status.forked = true,
            "generation" => altered.generations[0] = 1,
            "expiry" => altered.status.checked_time.seconds = 3000,
            _ => unreachable!(),
        }
        assert!(
            check(&delivery, &context, &current, &altered).is_err(),
            "{field}"
        );
    }
}

fn map_value(value: &mut CborValue, key: u64) -> &mut CborValue {
    let CborValue::Map(entries) = value else {
        panic!("map")
    };
    &mut entries.iter_mut().find(|(k, _)| *k == key).unwrap().1
}

fn test_secret(index: u8) -> SecretKey {
    let mut bytes = [0u8; 32];
    bytes[31] = index;
    SecretKey::from_slice(&bytes).unwrap()
}

fn test_account(index: u8) -> AccountRef {
    AccountRef {
        key_type: 1,
        key_bytes: PublicKey::from_secret_key(&Secp256k1::new(), &test_secret(index))
            .serialize()
            .to_vec(),
    }
}

fn account_value(account: &AccountRef) -> CborValue {
    CborValue::Map(vec![
        (0, CborValue::Int(i128::from(account.key_type))),
        (1, CborValue::Bytes(account.key_bytes.clone())),
    ])
}

fn test_frame(type_id: u32, version: u32, payload: &CborValue) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: version,
            min_reader_version: version,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}

// Independently signed offline records with exact linked predecessors. These snapshots
// stand in for the admission facade, not for its persistence/continuity proof.
fn signed_snapshot(
    template: &Current,
    signer: u8,
    message: AccountRef,
    stamp: AccountRef,
    previous: Option<&Current>,
) -> Current {
    let ValidationResult::Parsed(parsed) =
        validate_frame(&template.evidence.statement, &preview_directory_context()).unwrap()
    else {
        panic!("directory")
    };
    let mut payload = parsed.payload;
    let subject = test_account(signer);
    let (revision, generations) = previous
        .map(|old| {
            (
                old.revision + 1,
                [
                    old.generations[0] + if old.message_key != message { 1 } else { 0 },
                    old.generations[1] + if old.stamp_key != stamp { 1 } else { 0 },
                ],
            )
        })
        .unwrap_or((0, [0, 0]));
    *map_value(&mut payload, 1) = account_value(&subject);
    *map_value(&mut payload, 2) = CborValue::Int(i128::from(revision));
    *map_value(&mut payload, 3) = CborValue::Map(vec![
        (0, CborValue::Int(100 + i128::from(revision))),
        (1, CborValue::Int(0)),
    ]);
    *map_value(&mut payload, 6) =
        CborValue::Map(vec![(0, CborValue::Int(3500)), (1, CborValue::Int(0))]);
    *map_value(&mut payload, 8) = account_value(&stamp);
    *map_value(&mut payload, 10) = account_value(&message);
    *map_value(&mut payload, 11) = CborValue::Int(i128::from(generations[0]));
    *map_value(&mut payload, 12) = CborValue::Int(i128::from(generations[1]));
    *map_value(&mut payload, 13) = previous
        .map(|old| CborValue::Bytes(old.evidence.hash.to_vec()))
        .unwrap_or(CborValue::Null);
    let statement = test_frame(4, 4, &payload);
    let signature = Secp256k1::new()
        .sign(
            &Message::from_slice(&directory_signature_digest("monad", &statement).unwrap())
                .unwrap(),
            &test_secret(signer),
        )
        .serialize_der()
        .to_vec();
    let attestation = test_frame(
        2,
        1,
        &CborValue::Map(vec![
            (0, CborValue::Bytes(statement.clone())),
            (
                1,
                CborValue::Array(vec![CborValue::Map(vec![
                    (0, CborValue::Int(1)),
                    (1, account_value(&subject)),
                    (2, CborValue::Bytes(signature)),
                ])]),
            ),
        ]),
    );
    let verified = verify_preview_directory_evidence(&attestation, "monad").unwrap();
    let mut current = fixture_current_evidence(
        HistoricalEvidence {
            statement,
            attestation,
            hash: verified.statement_hash,
        },
        template.status.checked_time,
    );
    assert_eq!(current.message_key, message);
    assert_eq!(current.stamp_key, stamp);
    assert_eq!(current.generations, generations);
    current.previous_stamp = previous.and_then(|old| {
        if old.stamp_key != stamp {
            Some(old.stamp_key.clone())
        } else {
            old.previous_stamp.clone()
        }
    });
    current.status.previous_stamp = current.previous_stamp.clone();
    current
}

fn directional_fixture(sender: &Current, recipient: &Current) -> (Vec<u8>, Vec<u8>) {
    let v = corpus();
    let ValidationResult::Parsed(original) =
        validate_frame(&bytes(&v["runtime_case"], "delivery"), &default_context()).unwrap()
    else {
        panic!("delivery")
    };
    let Some(TypedPayload::DirectMessage { payload_frame, .. }) = original.typed.as_deref() else {
        panic!("delivery")
    };
    let mut payload = payload_frame.payload.clone();
    let sender_p = test_account(7);
    let recipient_p = test_account(1);
    *map_value(&mut payload, 1) = account_value(&sender_p);
    *map_value(&mut payload, 2) = account_value(&recipient_p);
    // Opaque ciphertext is immaterial to this partial stamp verifier. This constructed
    // frame deliberately makes no claim to be a newly authenticated encryption fixture.
    let payload = test_frame(5, 2, &payload);
    let t3 = recipient_payload_digest("monad", &payload).unwrap();
    let mut delivery = original.payload;
    *map_value(&mut delivery, 2) = CborValue::Bytes(payload);
    *map_value(&mut delivery, 3) = CborValue::Bytes(t3.to_vec());
    let CborValue::Array(members) = map_value(&mut delivery, 4) else {
        panic!("members")
    };
    *map_value(&mut members[0], 4) = CborValue::Bytes(payment_commitment(&t3, 0).to_vec());
    let context = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network: "monad",
        sender: &sender_p,
        recipient: &recipient_p,
        sender_directory_hash: &sender.evidence.hash,
        recipient_directory_hash: &recipient.evidence.hash,
        sender_message_key: &sender.message_key,
        recipient_message_key: &recipient.message_key,
        stamp_key: &recipient.stamp_key,
        ephemeral_point: &bytes(&v, "ephemeral_point"),
        shared_point: &bytes(&v, "shared_point"),
        dleq_proof: &bytes(&v, "proof"),
    })
    .unwrap();
    (test_frame(1, 1, &delivery), context)
}

#[test]
fn distinct_parties_accept_current_and_immediately_previous_but_reject_retired_or_expired_history()
{
    let recipient = fixture_current(&corpus()["runtime_case"]);
    assert_eq!(recipient.message_key, test_account(2));
    let sender = signed_snapshot(&recipient, 7, test_account(8), test_account(9), None);
    let (delivery, context) = directional_fixture(&sender, &recipient);
    assert!(check(&delivery, &context, &sender, &recipient).is_ok());
    let first = signed_snapshot(
        &recipient,
        1,
        recipient.message_key.clone(),
        test_account(10),
        Some(&recipient),
    );
    let second = signed_snapshot(
        &recipient,
        1,
        recipient.message_key.clone(),
        test_account(11),
        Some(&first),
    );
    let rotated_m = signed_snapshot(
        &recipient,
        1,
        test_account(12),
        first.stamp_key.clone(),
        Some(&first),
    );
    assert_eq!(first.previous_stamp.as_ref(), Some(&recipient.stamp_key));
    assert_eq!(second.previous_stamp.as_ref(), Some(&first.stamp_key));
    assert_eq!(
        rotated_m.previous_stamp.as_ref(),
        Some(&recipient.stamp_key)
    );
    let with_history = |head: &Current| {
        let mut sender_at_time = sender.clone();
        sender_at_time.status.checked_time = head.status.checked_time;
        verify_canonical_stamp(CanonicalStampCheckInput {
            delivery: &delivery,
            context: &context,
            sender_current: &sender_at_time,
            recipient_current: head,
            recipient_evidence: Some(&recipient.evidence),
        })
    };
    assert!(
        with_history(&first).is_ok(),
        "one stamp rotation retains grace"
    );
    assert_eq!(
        with_history(&second),
        Err(CanonicalStampError::DirectoryContext),
        "two-old stamp must fail even with unchanged M and unexpired evidence"
    );
    assert_eq!(
        with_history(&rotated_m),
        Err(CanonicalStampError::DirectoryContext),
        "previous-stamp grace grants no retired-M new use"
    );
    let mut expired = first.clone();
    expired.status.checked_time.seconds = 3000;
    assert_eq!(
        with_history(&expired),
        Err(CanonicalStampError::DirectoryContext),
        "historical expiry boundary is closed"
    );
    let mut last_valid = first;
    last_valid.status.checked_time = Timestamp {
        seconds: 2999,
        nanoseconds: 999_999_999,
    };
    assert!(
        with_history(&last_valid).is_ok(),
        "stamp grace has no additional time cutoff before historical expiry"
    );
}

#[test]
fn distinct_sender_and_recipient_p_m_and_t1_are_directionally_bound() {
    let recipient = fixture_current(&corpus()["runtime_case"]);
    let sender = signed_snapshot(&recipient, 7, test_account(8), test_account(9), None);
    assert_ne!(sender.message_key, recipient.message_key);
    assert_ne!(sender.evidence.hash, recipient.evidence.hash);
    let (delivery, context) = directional_fixture(&sender, &recipient);
    assert!(check(&delivery, &context, &sender, &recipient).is_ok());
    for (field, other) in [(2, 3), (3, 2), (6, 7), (7, 6), (4, 5), (5, 4)] {
        let mut substituted = decode_canonical(&context).unwrap();
        let replacement = map_value(&mut substituted, other).clone();
        assert_ne!(&*map_value(&mut substituted, field), &replacement);
        *map_value(&mut substituted, field) = replacement;
        let encoded = encode_canonical(&substituted).unwrap();
        assert_eq!(
            check(&delivery, &encoded, &sender, &recipient),
            Err(CanonicalStampError::DirectoryContext),
            "directional context field {field}"
        );
    }
    assert!(
        check(&delivery, &context, &recipient, &sender).is_err(),
        "admitted snapshots cannot swap principals"
    );
}

#[test]
fn delivery_rejects_wrong_t3_t4_destination_and_duplicate_or_noncontiguous_members() {
    let v = &corpus()["runtime_case"];
    let current = fixture_current(v);
    let context = bytes(v, "context");
    let ValidationResult::Parsed(original) =
        validate_frame(&bytes(v, "delivery"), &default_context()).unwrap()
    else {
        panic!("frame")
    };
    for case in ["t3", "t4", "address", "duplicate", "index"] {
        let mut payload = original.payload.clone();
        if case == "t3" {
            *map_value(&mut payload, 3) = CborValue::Bytes(vec![0; 32]);
        } else {
            let CborValue::Array(members) = map_value(&mut payload, 4) else {
                panic!("members")
            };
            match case {
                "t4" => *map_value(&mut members[0], 4) = CborValue::Bytes(vec![0; 32]),
                "address" => *map_value(&mut members[0], 3) = CborValue::Bytes(vec![0; 20]),
                "duplicate" => members.push(members[0].clone()),
                "index" => *map_value(&mut members[0], 0) = CborValue::Int(1),
                _ => unreachable!(),
            }
        }
        let frame = encode_frame(
            EnvelopeFields {
                type_id: 1,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&payload),
        )
        .unwrap();
        assert!(
            check(&frame, &context, &current, &current).is_err(),
            "{case}"
        );
    }
}

#[test]
fn independent_frozen_t3c_proof_and_destinations() {
    let v = corpus();
    let key = AccountRef {
        key_type: 1,
        key_bytes: bytes(&v, "stamp_key"),
    };
    let network = v["network"].as_str().unwrap();
    verify_canonical_stamp_proof(
        network,
        &key,
        &bytes(&v, "ephemeral_point"),
        &bytes(&v, "shared_point"),
        &bytes(&v, "proof"),
    )
    .unwrap();
    for child in v["destinations"].as_array().unwrap() {
        let (public, address) = canonical_stamp_destination(
            network,
            &key,
            &bytes(&v, "shared_point"),
            child["index"].as_u64().unwrap() as u32,
        )
        .unwrap();
        assert_eq!(hex::encode(address), child["address"].as_str().unwrap());
        if let Some(expected) = child["public_key"].as_str() {
            assert_eq!(hex::encode(public), expected);
        }
    }
}

#[test]
fn independent_shared_hostile_corpus() {
    let v = corpus();
    for name in v["hostile"].as_array().unwrap() {
        let mut network = v["network"].as_str().unwrap();
        let mut key = AccountRef {
            key_type: 1,
            key_bytes: bytes(&v, "stamp_key"),
        };
        let mut e = bytes(&v, "ephemeral_point");
        let mut x = bytes(&v, "shared_point");
        let mut proof = bytes(&v, "proof");
        match name.as_str().unwrap() {
            "wrong-network" => network = "other",
            "wrong-stamp-key" => key.key_bytes = e.clone(),
            "wrong-ephemeral-point" => e = key.key_bytes.clone(),
            "wrong-shared-point" => x = e.clone(),
            "changed-proof" => proof[0] ^= 1,
            "zero-challenge" => proof[..32].fill(0),
            "order-challenge" => proof[..32].copy_from_slice(
                &hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
                    .unwrap(),
            ),
            "zero-response" => proof[32..].fill(0),
            "short-proof" => {
                proof.remove(0);
            }
            "uncompressed-point" => {
                e = vec![0; 65];
                e[0] = 4;
            }
            "invalid-point" => x.fill(0),
            "child-index-overflow" => {
                assert!(canonical_stamp_destination(network, &key, &x, 0x8000_0000).is_err());
                continue;
            }
            other => panic!("missing hostile case {other}"),
        }
        assert!(
            verify_canonical_stamp_proof(network, &key, &e, &x, &proof).is_err(),
            "{name}"
        );
    }
}

#[test]
fn exact_frame_and_index_commitments_are_distinct() {
    let frame = hex::decode("46524e4b0100000001a0").unwrap();
    let digest = recipient_payload_digest("monad", &frame).unwrap();
    assert_ne!(digest, recipient_payload_digest("other", &frame).unwrap());
    let mut changed = frame;
    changed[9] ^= 1;
    assert_ne!(digest, recipient_payload_digest("monad", &changed).unwrap());
    assert_ne!(
        payment_commitment(&digest, 0),
        payment_commitment(&digest, 1)
    );
}
