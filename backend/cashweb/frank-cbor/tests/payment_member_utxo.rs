//! Tests for UTXO payment-member extensions (vout and satoshis uint64)
//! and co-located Type 1 recipient identity P and DLEQ proof (#987).

mod common;

use frank_cbor::{
    cbor_map, payment_commitment, recipient_payload_digest, validate_frame, CborValue,
    Error, PaymentValue, TypedPayload, ValidationResult,
};

use common::{
    acct1, acct2, bytes_of, fr, int, stamp_account, type5_frame, typed_context, NET,
    T3C_PROOF, T3C_STAMP_KEY,
};

fn utxo_payment(
    t3: &[u8],
    index: u32,
    txid: Vec<u8>,
    value: CborValue,
    vout: Option<u32>,
) -> CborValue {
    let mut entries = vec![
        (0, int(i128::from(index))),
        (1, CborValue::Bytes(txid)),
        (2, value),
        (3, CborValue::Bytes(bytes_of(20, 50 + index))),
        (4, CborValue::Bytes(payment_commitment(t3, index).to_vec())),
    ];
    if let Some(v) = vout {
        entries.push((5, int(i128::from(v))));
    }
    cbor_map(entries)
}

fn build_delivery_with_payments(
    payments: Vec<CborValue>,
    colocated_recipient: Option<CborValue>,
    colocated_dleq: Option<CborValue>,
) -> Vec<u8> {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let mut entries = vec![
        (0, CborValue::Text(NET.to_string())),
        (1, stamp_account(T3C_STAMP_KEY)),
        (2, CborValue::Bytes(payload_frame)),
        (3, CborValue::Bytes(t3.to_vec())),
        (4, CborValue::Array(payments)),
    ];
    if let Some(rec) = colocated_recipient {
        entries.push((5, rec));
    }
    if let Some(dleq) = colocated_dleq {
        entries.push((6, dleq));
    }
    fr(1, &cbor_map(entries))
}

#[test]
fn test_payment_member_parses_vout_and_satoshis() {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let p0 = utxo_payment(
        &t3,
        0,
        bytes_of(32, 1),
        int(50_000), // satoshis uint
        Some(0),     // vout: 0
    );
    let p1 = utxo_payment(
        &t3,
        1,
        bytes_of(32, 2),
        CborValue::Bytes(vec![0x00; 32]), // 32-byte EVM quantity
        Some(4294967295),                 // vout: max u32
    );

    let frame = build_delivery_with_payments(vec![p0, p1], None, None);
    let result = validate_frame(&frame, &typed_context()).expect("valid frame");
    if let ValidationResult::Parsed(parsed) = result {
        if let Some(TypedPayload::DirectMessage { payments, .. }) = parsed.typed.as_deref() {
            assert_eq!(payments.len(), 2);
            assert_eq!(payments[0].vout, Some(0));
            assert_eq!(payments[0].value, PaymentValue::Satoshis(50_000));
            assert_eq!(payments[1].vout, Some(4294967295));
            assert_eq!(payments[1].value, PaymentValue::Quantity(vec![0x00; 32]));
        } else {
            panic!("expected DirectMessage typed payload");
        }
    } else {
        panic!("expected Parsed validation result");
    }
}

#[test]
fn test_payment_member_rejects_negative_satoshis() {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let p_bad = utxo_payment(
        &t3,
        0,
        bytes_of(32, 1),
        int(-1), // negative int
        Some(0),
    );

    let frame = build_delivery_with_payments(vec![p_bad], None, None);
    assert!(validate_frame(&frame, &typed_context()).is_err());
}

#[test]
fn test_allows_same_txid_with_different_vout() {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let shared_txid = bytes_of(32, 42);
    let p0 = utxo_payment(&t3, 0, shared_txid.clone(), int(10_000), Some(0));
    let p1 = utxo_payment(&t3, 1, shared_txid, int(20_000), Some(1));

    let frame = build_delivery_with_payments(vec![p0, p1], None, None);
    let result = validate_frame(&frame, &typed_context()).expect("valid delivery with distinct vouts");
    if let ValidationResult::Parsed(parsed) = result {
        if let Some(TypedPayload::DirectMessage { payments, .. }) = parsed.typed.as_deref() {
            assert_eq!(payments.len(), 2);
            assert_eq!(payments[0].vout, Some(0));
            assert_eq!(payments[1].vout, Some(1));
        } else {
            panic!("expected DirectMessage typed payload");
        }
    }
}

#[test]
fn test_rejects_duplicate_txid_and_vout() {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let shared_txid = bytes_of(32, 42);
    let p0 = utxo_payment(&t3, 0, shared_txid.clone(), int(10_000), Some(0));
    let p1 = utxo_payment(&t3, 1, shared_txid, int(20_000), Some(0)); // duplicate vout!

    let frame = build_delivery_with_payments(vec![p0, p1], None, None);
    match validate_frame(&frame, &typed_context()) {
        Err(Error::Codec(e)) => {
            assert_eq!(format!("{:?}", e.category), "Semantic");
        }
        other => panic!("expected semantic error for duplicate (txid, vout), got {:?}", other),
    }
}

#[test]
fn test_co_located_recipient_and_dleq() {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let p0 = utxo_payment(&t3, 0, bytes_of(32, 1), int(10_000), Some(0));
    let p1 = utxo_payment(&t3, 1, bytes_of(32, 2), int(20_000), Some(1));

    let rec = acct1(3);
    let proof = CborValue::Bytes(hex::decode(T3C_PROOF).unwrap());

    // Both present: passes and projects
    let frame_both = build_delivery_with_payments(
        vec![p0.clone(), p1.clone()],
        Some(rec.clone()),
        Some(proof.clone()),
    );
    let result = validate_frame(&frame_both, &typed_context()).expect("valid co-located fields");
    if let ValidationResult::Parsed(parsed) = result {
        if let Some(TypedPayload::DirectMessage { recipient, dleq_proof, .. }) = parsed.typed.as_deref() {
            assert!(recipient.is_some());
            assert_eq!(recipient.as_ref().unwrap().key_type, 1);
            assert!(dleq_proof.is_some());
            assert_eq!(dleq_proof.as_ref().unwrap().len(), 64);
        } else {
            panic!("expected DirectMessage typed payload");
        }
    }

    // Only recipient present: fails semantic
    let frame_only_rec = build_delivery_with_payments(
        vec![p0.clone(), p1.clone()],
        Some(rec.clone()),
        None,
    );
    assert!(validate_frame(&frame_only_rec, &typed_context()).is_err());

    // Only proof present: fails semantic
    let frame_only_proof = build_delivery_with_payments(
        vec![p0.clone(), p1.clone()],
        None,
        Some(proof),
    );
    assert!(validate_frame(&frame_only_proof, &typed_context()).is_err());

    // Recipient with key_type != 1: fails schema/semantic
    let bad_rec = acct2(3); // key_type 2
    let proof2 = CborValue::Bytes(hex::decode(T3C_PROOF).unwrap());
    let frame_bad_rec = build_delivery_with_payments(
        vec![p0, p1],
        Some(bad_rec),
        Some(proof2),
    );
    assert!(validate_frame(&frame_bad_rec, &typed_context()).is_err());
}
