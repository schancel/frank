//! Type 25 has no network tag. Each payment member carries its own.

mod common;

use frank_cbor::{
    decode_canonical, default_context, encode_forwarding_delivery, encode_frame,
    forwarding_payload_digest, validate_frame, AccountRef, CborValue, EnvelopeFields, Error,
    ErrorCategory, ErrorStage, ForwardingDeliveryEnvelope, FramePayload, PaymentMember,
    PaymentValue, StealthMetadata, TypedPayload, ValidationResult,
};

use common::{bytes_of, direct_message_frame, NET};

fn relay() -> AccountRef {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, 42));
    AccountRef {
        key_type: 1,
        key_bytes: key,
    }
}

fn ephemeral() -> AccountRef {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, 7));
    AccountRef {
        key_type: 1,
        key_bytes: key,
    }
}

/// A type-10 frame whose only payload field is its network tag. Enough for the digest.
fn type1(network: &str) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: 10,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&CborValue::Map(vec![(0, CborValue::Text(network.into()))])),
    )
    .expect("type-10 frame")
}

fn stamp(network: &str, tx_seed: u32, addr_seed: u32) -> PaymentMember {
    PaymentMember {
        network: network.into(),
        transaction_id: bytes_of(32, tx_seed),
        value: PaymentValue::Satoshis(1),
        address: bytes_of(20, addr_seed),
        commitment: Some(vec![0x11; 32]),
        vout: None,
        raw_tx: None,
        child_index: Some(0),
        stealth: None,
        token: None,
    }
}

fn stealth(network: &str, tx_seed: u32, addr_seed: u32) -> PaymentMember {
    PaymentMember {
        network: network.into(),
        transaction_id: bytes_of(32, tx_seed),
        value: PaymentValue::Satoshis(1),
        address: bytes_of(20, addr_seed),
        commitment: None,
        vout: None,
        raw_tx: None,
        child_index: None,
        stealth: Some(StealthMetadata {
            ephemeral: ephemeral(),
            view_tag: None,
        }),
        token: None,
    }
}

fn encode_type25(inner: &[u8], payments: Vec<PaymentMember>) -> Vec<u8> {
    encode_forwarding_delivery(&ForwardingDeliveryEnvelope {
        destination: relay(),
        payload_frame: inner.to_vec(),
        payload_digest: None,
        payments,
        endpoint: None,
        expires_at: None,
        unknown: vec![],
    })
    .expect("type 13")
}

fn insert_key0(frame: &[u8]) -> Vec<u8> {
    let CborValue::Map(envelope) = decode_canonical(&frame[9..]).expect("envelope") else {
        panic!("envelope map");
    };
    let Some(CborValue::Bytes(payload)) = envelope.iter().find(|(k, _)| *k == 3).map(|(_, v)| v)
    else {
        panic!("payload");
    };
    let CborValue::Map(mut fields) = decode_canonical(payload).expect("payload map") else {
        panic!("payload map");
    };
    fields.push((0, CborValue::Text(NET.into())));
    fields.sort_by_key(|(key, _)| *key);
    encode_frame(
        EnvelopeFields {
            type_id: 13,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&CborValue::Map(fields)),
    )
    .expect("re-encode")
}

#[test]
fn type25_key_0_is_a_schema_error() {
    let inner = direct_message_frame();
    let frame = encode_type25(&inner, vec![stamp(NET, 1, 1)]);
    validate_frame(&frame, &default_context()).expect("key 0 absent");
    let rejected = insert_key0(&frame);
    match validate_frame(&rejected, &default_context()) {
        Err(Error::Codec(err)) => {
            assert_eq!(err.category, ErrorCategory::Schema);
            assert_eq!(err.stage, ErrorStage::S82);
            assert!(err.detail.contains("undeclared key 0"), "{}", err.detail);
        }
        other => panic!("expected a schema error, got {other:?}"),
    }
}

#[test]
fn mixed_stamp_and_stealth_on_two_networks_validates() {
    let inner = direct_message_frame();
    let frame = encode_type25(
        &inner,
        vec![stamp("frank-test", 1, 1), stealth("lotus", 2, 2)],
    );
    let ValidationResult::Parsed(parsed) =
        validate_frame(&frame, &default_context()).expect("mixed list")
    else {
        panic!("parsed");
    };
    let Some(TypedPayload::ForwardingDelivery { payments, .. }) = parsed.typed.as_deref() else {
        panic!("type 25");
    };
    assert_eq!(payments[0].network, "frank-test");
    assert_eq!(payments[0].child_index, Some(0));
    assert!(payments[0].stealth.is_none());
    assert_eq!(payments[1].network, "lotus");
    assert!(payments[1].child_index.is_none());
    assert!(payments[1].stealth.is_some());
}

#[test]
fn forwarding_digest_reads_the_inner_type1_network() {
    let frank = type1("frank-test");
    let lotus = type1("lotus-test");
    let frank_digest = forwarding_payload_digest(&frank).expect("frank");
    let lotus_digest = forwarding_payload_digest(&lotus).expect("lotus");
    assert_ne!(frank_digest, lotus_digest);
    let frame = encode_type25(&frank, vec![stamp("lotus", 3, 3)]);
    let CborValue::Map(envelope) = decode_canonical(&frame[9..]).unwrap() else {
        panic!("map");
    };
    let Some(CborValue::Bytes(payload)) = envelope.iter().find(|(k, _)| *k == 3).map(|(_, v)| v)
    else {
        panic!("payload");
    };
    let CborValue::Map(fields) = decode_canonical(payload).unwrap() else {
        panic!("payload map");
    };
    assert!(fields.iter().all(|(key, _)| *key != 0));
    let Some(CborValue::Bytes(digest)) = fields.iter().find(|(k, _)| *k == 3).map(|(_, v)| v)
    else {
        panic!("digest");
    };
    assert_eq!(digest.as_slice(), frank_digest.as_slice());
    assert_ne!(digest.as_slice(), lotus_digest.as_slice());
}
