//! Tests for Type 25 relay forwarding delivery envelope (#986).

mod common;

use frank_cbor::{
    cbor_map, default_context, encode_forwarding_delivery, forwarding_payload_digest,
    is_forwarding_delivery_frame, payment_commitment, recipient_payload_digest,
    storage_payment_commitment, validate_frame, AccountRef, CborValue, ForwardingDeliveryEnvelope,
    PaymentMember, PaymentValue, TypedPayload, ValidationResult,
    MAX_FORWARDING_DELIVERY_FRAME_BYTES, TYPE_FORWARDING_DELIVERY,
};

const TYPE_DIRECT_MESSAGE: u32 = 1;

use common::{bytes_of, fr, int, stamp_account, type5_frame, NET, T3C_STAMP_KEY};

fn sample_delivery_frame() -> Vec<u8> {
    let payload_frame = type5_frame();
    let t3 = recipient_payload_digest(NET, &payload_frame).expect("t3");
    let payment = cbor_map(vec![
        (0, CborValue::Text(NET.to_string())),
        (1, CborValue::Bytes(bytes_of(32, 10))),
        (2, CborValue::Bytes(vec![0x00; 32])),
        (3, CborValue::Bytes(bytes_of(20, 20))),
        (4, CborValue::Bytes(payment_commitment(&t3, 0).to_vec())),
        (7, int(0)),
    ]);
    fr(
        TYPE_DIRECT_MESSAGE,
        &cbor_map(vec![
            (0, CborValue::Text(NET.to_string())),
            (1, stamp_account(T3C_STAMP_KEY)),
            (2, CborValue::Bytes(payload_frame)),
            (3, CborValue::Bytes(t3.to_vec())),
            (4, CborValue::Array(vec![payment])),
        ]),
    )
}

fn relay_account(seed: u32) -> AccountRef {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, seed));
    AccountRef {
        key_type: 1,
        key_bytes: key,
    }
}

fn stamp(
    child: u32,
    txid: Vec<u8>,
    value: PaymentValue,
    address: Vec<u8>,
    commitment: Vec<u8>,
    vout: Option<u32>,
) -> PaymentMember {
    PaymentMember {
        network: NET.to_string(),
        transaction_id: txid,
        value,
        address,
        commitment: Some(commitment),
        vout,
        raw_tx: None,
        child_index: Some(child),
        stealth: None,
        token: None,
    }
}

fn envelope(
    destination: AccountRef,
    payload_frame: Vec<u8>,
    payload_digest: Option<Vec<u8>>,
    payments: Vec<PaymentMember>,
    endpoint: Option<String>,
    expires_at: Option<u64>,
) -> ForwardingDeliveryEnvelope {
    ForwardingDeliveryEnvelope {
        destination,
        payload_frame,
        payload_digest,
        payments,
        endpoint,
        expires_at,
        unknown: vec![],
    }
}

#[test]
fn test_forwarding_envelope_encode_and_validate() {
    let inner_frame = sample_delivery_frame();
    let dest_relay = relay_account(42);
    let digest = forwarding_payload_digest(&inner_frame).expect("digest");

    let payment = stamp(
        0,
        bytes_of(32, 101),
        PaymentValue::Satoshis(100_000),
        bytes_of(20, 1),
        storage_payment_commitment(&digest, 0).to_vec(),
        Some(0),
    );

    let frame = encode_forwarding_delivery(&envelope(
        dest_relay.clone(),
        inner_frame.clone(),
        Some(digest.to_vec()),
        vec![payment],
        Some("https://relay.frank.org/message/cbor".to_string()),
        Some(1750000000),
    ))
    .expect("encode");
    assert!(frame.len() > inner_frame.len());

    let result = validate_frame(&frame, &default_context()).expect("valid frame");
    if let ValidationResult::Parsed(parsed) = result {
        assert_eq!(parsed.type_id, TYPE_FORWARDING_DELIVERY);
        assert!(is_forwarding_delivery_frame(&parsed));

        if let Some(TypedPayload::ForwardingDelivery {
            destination,
            payload_frame,
            payments,
            endpoint,
            expires_at,
            ..
        }) = parsed.typed.as_deref()
        {
            assert_eq!(destination.key_type, 1);
            assert_eq!(destination.key_bytes, dest_relay.key_bytes);
            assert_eq!(
                endpoint.as_deref(),
                Some("https://relay.frank.org/message/cbor")
            );
            assert_eq!(*expires_at, Some(1750000000));
            assert_eq!(payments.len(), 1);
            assert_eq!(payments[0].network, NET);
            assert_eq!(payments[0].child_index, Some(0));
            assert_eq!(payments[0].value, PaymentValue::Satoshis(100_000));
            assert_eq!(payments[0].vout, Some(0));

            assert_eq!(payload_frame.type_id, TYPE_DIRECT_MESSAGE);
            assert!(matches!(
                payload_frame.typed.as_deref(),
                Some(TypedPayload::DirectMessage { network, .. }) if network == NET
            ));
        } else {
            panic!("expected ForwardingDelivery typed payload");
        }
    } else {
        panic!("expected Parsed validation result");
    }
}

#[test]
fn test_forwarding_envelope_optional_fields_absent() {
    let inner_frame = sample_delivery_frame();
    let payment = stamp(
        0,
        bytes_of(32, 102),
        PaymentValue::Quantity(vec![0x00; 32]),
        bytes_of(20, 2),
        storage_payment_commitment(&forwarding_payload_digest(&inner_frame).expect("digest"), 0)
            .to_vec(),
        None,
    );

    let frame = encode_forwarding_delivery(&envelope(
        relay_account(42),
        inner_frame,
        None,
        vec![payment],
        None,
        None,
    ))
    .expect("encode");
    let result = validate_frame(&frame, &default_context()).expect("valid frame");
    if let ValidationResult::Parsed(parsed) = result {
        if let Some(TypedPayload::ForwardingDelivery {
            endpoint,
            expires_at,
            payments,
            ..
        }) = parsed.typed.as_deref()
        {
            assert!(endpoint.is_none());
            assert!(expires_at.is_none());
            assert_eq!(payments.len(), 1);
            assert_eq!(payments[0].vout, None);
        } else {
            panic!("expected ForwardingDelivery typed payload");
        }
    } else {
        panic!("expected Parsed validation result");
    }
}

#[test]
fn test_forwarding_envelope_multiple_ordered_payments() {
    let inner_frame = sample_delivery_frame();
    let digest = forwarding_payload_digest(&inner_frame).expect("digest");
    let p0 = stamp(
        0,
        bytes_of(32, 201),
        PaymentValue::Satoshis(50_000),
        bytes_of(20, 1),
        storage_payment_commitment(&digest, 0).to_vec(),
        Some(0),
    );
    let p1 = stamp(
        1,
        bytes_of(32, 201),
        PaymentValue::Satoshis(50_000),
        bytes_of(20, 2),
        storage_payment_commitment(&digest, 1).to_vec(),
        Some(1),
    );

    let frame = encode_forwarding_delivery(&envelope(
        relay_account(42),
        inner_frame,
        Some(digest.to_vec()),
        vec![p0, p1],
        None,
        None,
    ))
    .expect("encode");
    let result = validate_frame(&frame, &default_context()).expect("valid frame");
    if let ValidationResult::Parsed(parsed) = result {
        if let Some(TypedPayload::ForwardingDelivery { payments, .. }) = parsed.typed.as_deref() {
            assert_eq!(payments.len(), 2);
            assert_eq!(payments[0].vout, Some(0));
            assert_eq!(payments[1].vout, Some(1));
        } else {
            panic!("expected ForwardingDelivery typed payload");
        }
    } else {
        panic!("expected Parsed validation result");
    }
}

#[test]
fn test_forwarding_envelope_rejects_duplicate_child_index() {
    let inner_frame = sample_delivery_frame();
    let digest = forwarding_payload_digest(&inner_frame).expect("digest");
    let p0 = stamp(
        0,
        vec![1; 32],
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 1),
        storage_payment_commitment(&digest, 0).to_vec(),
        None,
    );
    let p_dup = stamp(
        0,
        vec![2; 32],
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 2),
        storage_payment_commitment(&digest, 0).to_vec(),
        None,
    );
    let frame = encode_forwarding_delivery(&envelope(
        relay_account(42),
        inner_frame,
        Some(digest.to_vec()),
        vec![p0, p_dup],
        None,
        None,
    ))
    .expect("encode");
    let err = validate_frame(&frame, &default_context()).expect_err("should reject");
    assert!(err.to_string().contains("duplicate child index"));
}

#[test]
fn test_forwarding_envelope_rejects_non_contiguous_child_index() {
    let inner_frame = sample_delivery_frame();
    let digest = forwarding_payload_digest(&inner_frame).expect("digest");
    let p0 = stamp(
        0,
        bytes_of(32, 501),
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 1),
        storage_payment_commitment(&digest, 0).to_vec(),
        None,
    );
    let p_gap = stamp(
        2,
        bytes_of(32, 502),
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 2),
        storage_payment_commitment(&digest, 2).to_vec(),
        None,
    );
    let frame = encode_forwarding_delivery(&envelope(
        relay_account(42),
        inner_frame,
        Some(digest.to_vec()),
        vec![p0, p_gap],
        None,
        None,
    ))
    .expect("encode");
    let err = validate_frame(&frame, &default_context()).expect_err("should reject");
    assert!(err.to_string().contains("contiguous"));
}

#[test]
fn test_forwarding_envelope_rejects_duplicate_txid_without_vout() {
    let inner_frame = sample_delivery_frame();
    let digest = forwarding_payload_digest(&inner_frame).expect("digest");
    let shared_txid = bytes_of(32, 601);
    let p0 = stamp(
        0,
        shared_txid.clone(),
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 1),
        storage_payment_commitment(&digest, 0).to_vec(),
        None,
    );
    let p1 = stamp(
        1,
        shared_txid,
        PaymentValue::Satoshis(10_000),
        bytes_of(20, 2),
        storage_payment_commitment(&digest, 1).to_vec(),
        None,
    );
    let frame = encode_forwarding_delivery(&envelope(
        relay_account(42),
        inner_frame,
        Some(digest.to_vec()),
        vec![p0, p1],
        None,
        None,
    ))
    .expect("encode");
    let err = validate_frame(&frame, &default_context()).expect_err("should reject");
    assert!(err.to_string().contains("duplicate transaction id"));
}

#[test]
fn test_forwarding_envelope_frame_limit_constant() {
    assert_eq!(MAX_FORWARDING_DELIVERY_FRAME_BYTES, 33_554_432);
    assert_eq!(MAX_FORWARDING_DELIVERY_FRAME_BYTES, 32 * 1024 * 1024);
}
