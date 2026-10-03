use super::*;
use crate::directory_admission::{Checkpoint, CheckpointKind, Status};
use frank_cbor::{encode_frame, CborValue, EnvelopeFields, FramePayload};

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
    let value = tuple(&evidence, "monad").unwrap();
    let now = Timestamp {
        seconds: v["checked_time_seconds"].as_i64().unwrap(),
        nanoseconds: 0,
    };
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
        revision: Some(0),
        generations: Some([0, 0]),
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
        revision: 0,
        generations: [0, 0],
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
