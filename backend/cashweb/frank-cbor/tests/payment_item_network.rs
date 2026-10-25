//! Type 13 has no network tag. Each payment member carries its own.

mod common;

use frank_cbor::{
    decode_canonical, default_context, encode_forwarding_delivery, encode_frame,
    forwarding_payload_digest, validate_frame, AccountRef, CborValue, EnvelopeFields, Error,
    ErrorCategory, ErrorStage, ForwardingDeliveryEnvelope, FramePayload, PaymentMember,
    PaymentValue, StealthMetadata, TypedPayload, ValidationResult,
};

use frank_cbor::message_fields::{
    direct_message_delivery as delivery_k, forwarding_delivery_envelope as envelope_k,
    frank_envelope, key_type, payment_member as pay,
};
use frank_cbor::message_types::{TYPE_DIRECT_MESSAGE_DELIVERY, TYPE_FORWARDING_DELIVERY_ENVELOPE};

use common::{bytes_of, direct_message_frame, NET};

fn relay() -> AccountRef {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, 42));
    AccountRef {
        key_type: key_type::SECP256K1,
        key_bytes: key,
    }
}

fn ephemeral() -> AccountRef {
    let mut key = vec![0x02];
    key.extend(bytes_of(32, 7));
    AccountRef {
        key_type: key_type::SECP256K1,
        key_bytes: key,
    }
}

/// A type-10 frame whose only payload field is its network tag. Enough for the digest.
fn delivery_on(network: &str) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id: TYPE_DIRECT_MESSAGE_DELIVERY,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&CborValue::Map(vec![(
            delivery_k::NETWORK,
            CborValue::Text(network.into()),
        )])),
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

fn encode_forwarding(inner: &[u8], payments: Vec<PaymentMember>) -> Vec<u8> {
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
    let Some(CborValue::Bytes(payload)) = envelope
        .iter()
        .find(|(k, _)| *k == frank_envelope::PAYLOAD)
        .map(|(_, v)| v)
    else {
        panic!("payload");
    };
    let CborValue::Map(mut fields) = decode_canonical(payload).expect("payload map") else {
        panic!("payload map");
    };
    // raw-cbor-key: the retired envelope network tag
    fields.push((0, CborValue::Text(NET.into())));
    fields.sort_by_key(|(key, _)| *key);
    encode_frame(
        EnvelopeFields {
            type_id: TYPE_FORWARDING_DELIVERY_ENVELOPE,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&CborValue::Map(fields)),
    )
    .expect("re-encode")
}

#[test]
fn type13_key_0_is_a_schema_error() {
    let inner = direct_message_frame();
    let frame = encode_forwarding(&inner, vec![stamp(NET, 1, 1)]);
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
    let frame = encode_forwarding(&inner, vec![stamp(NET, 1, 1), stealth("xpi-testnet", 2, 2)]);
    let ValidationResult::Parsed(parsed) =
        validate_frame(&frame, &default_context()).expect("mixed list")
    else {
        panic!("parsed");
    };
    let Some(TypedPayload::ForwardingDelivery { payments, .. }) = parsed.typed.as_deref() else {
        panic!("type 13");
    };
    assert_eq!(payments[0].network, NET);
    assert_eq!(payments[0].child_index, Some(0));
    assert!(payments[0].stealth.is_none());
    assert_eq!(payments[1].network, "xpi-testnet");
    assert!(payments[1].child_index.is_none());
    assert!(payments[1].stealth.is_some());
}

#[test]
fn forwarding_digest_reads_the_inner_type10_network() {
    let frank = delivery_on("frank-test");
    let lotus = delivery_on("lotus-test");
    let frank_digest = forwarding_payload_digest(&frank).expect("frank");
    let lotus_digest = forwarding_payload_digest(&lotus).expect("lotus");
    assert_ne!(frank_digest, lotus_digest);
    let frame = encode_forwarding(&frank, vec![stamp("frank-test", 3, 3)]);
    let CborValue::Map(envelope) = decode_canonical(&frame[9..]).unwrap() else {
        panic!("map");
    };
    let Some(CborValue::Bytes(payload)) = envelope
        .iter()
        .find(|(k, _)| *k == frank_envelope::PAYLOAD)
        .map(|(_, v)| v)
    else {
        panic!("payload");
    };
    let CborValue::Map(fields) = decode_canonical(payload).unwrap() else {
        panic!("payload map");
    };
    assert!(fields.iter().all(|(key, _)| *key != 0));
    let Some(CborValue::Bytes(digest)) = fields
        .iter()
        .find(|(k, _)| *k == envelope_k::PAYLOAD_DIGEST)
        .map(|(_, v)| v)
    else {
        panic!("digest");
    };
    assert_eq!(digest.as_slice(), frank_digest.as_slice());
    assert_ne!(digest.as_slice(), lotus_digest.as_slice());
}

fn map_field(map: &[(u64, CborValue)], key: u64) -> &CborValue {
    &map.iter().find(|(k, _)| *k == key).expect("field").1
}

/// Re-encodes `frame` with payment member `index` (in the list at `payments_key`) relabelled to
/// `network`; nothing else changes.
fn relabel_payment(frame: &[u8], payments_key: u64, index: usize, network: &str) -> Vec<u8> {
    let CborValue::Map(envelope) = decode_canonical(&frame[9..]).expect("envelope") else {
        panic!("envelope map");
    };
    let int = |key| match map_field(&envelope, key) {
        CborValue::Int(n) => *n as u32,
        other => panic!("{other:?}"),
    };
    let CborValue::Bytes(payload) = map_field(&envelope, frank_envelope::PAYLOAD) else {
        panic!("payload");
    };
    let CborValue::Map(mut fields) = decode_canonical(payload).expect("payload map") else {
        panic!("payload map");
    };
    let (_, CborValue::Array(members)) = fields
        .iter_mut()
        .find(|(k, _)| *k == payments_key)
        .expect("payments")
    else {
        panic!("payments array");
    };
    let CborValue::Map(member) = &mut members[index] else {
        panic!("member map");
    };
    member
        .iter_mut()
        .find(|(k, _)| *k == pay::NETWORK)
        .expect("network")
        .1 = CborValue::Text(network.into());
    encode_frame(
        EnvelopeFields {
            type_id: int(frank_envelope::TYPE_ID),
            schema_version: int(frank_envelope::SCHEMA_VERSION),
            min_reader_version: int(frank_envelope::MIN_READER_VERSION),
        },
        FramePayload::Value(&CborValue::Map(fields)),
    )
    .expect("re-encode")
}

fn expect_semantic(frame: &[u8], detail: &str) {
    match validate_frame(frame, &default_context()) {
        Err(Error::Codec(err)) => {
            assert_eq!(err.category, ErrorCategory::Semantic, "{}", err.detail);
            assert!(err.detail.contains(detail), "{}", err.detail);
        }
        other => panic!("expected a semantic error, got {other:?}"),
    }
}

#[test]
fn type10_stamp_on_another_network_is_rejected() {
    let frame = direct_message_frame();
    validate_frame(&frame, &default_context()).expect("stamps on the delivery network");
    // The reviewer's case: the same stamp relabelled to a chain other than the delivery network.
    for network in ["lotus", "xpi-mainnet", "zz-not-a-chain"] {
        expect_semantic(
            &relabel_payment(&frame, delivery_k::PAYMENTS, 0, network),
            "stamp payment network differs from the delivery network (S3)",
        );
    }
}

#[test]
fn type13_stamp_on_another_network_is_rejected() {
    let inner = direct_message_frame();
    let err = encode_forwarding_delivery(&ForwardingDeliveryEnvelope {
        destination: relay(),
        payload_frame: inner.clone(),
        payload_digest: None,
        payments: vec![stamp("xpi-mainnet", 1, 1)],
        endpoint: None,
        expires_at: None,
        unknown: vec![],
    })
    .expect_err("encoder refuses a stamp off the delivery network");
    assert!(
        format!("{err:?}").contains("differs from the delivery network"),
        "{err:?}"
    );
    let frame = encode_forwarding(&inner, vec![stamp(NET, 1, 1)]);
    expect_semantic(
        &relabel_payment(&frame, envelope_k::PAYMENTS, 0, "xpi-mainnet"),
        "stamp payment network differs from the delivery network (S3)",
    );
}

#[test]
fn stealth_payment_on_an_unregistered_network_is_rejected() {
    let inner = direct_message_frame();
    let frame = encode_forwarding(&inner, vec![stamp(NET, 1, 1), stealth("xpi-testnet", 2, 2)]);
    for network in ["lotus", "monad", "zz-not-a-chain"] {
        let err = encode_forwarding_delivery(&ForwardingDeliveryEnvelope {
            destination: relay(),
            payload_frame: inner.clone(),
            payload_digest: None,
            payments: vec![stamp(NET, 1, 1), stealth(network, 2, 2)],
            endpoint: None,
            expires_at: None,
            unknown: vec![],
        })
        .expect_err("encoder refuses an unregistered network");
        assert!(
            format!("{err:?}").contains("not a chain identifier"),
            "{err:?}"
        );
        match validate_frame(
            &relabel_payment(&frame, envelope_k::PAYMENTS, 1, network),
            &default_context(),
        ) {
            Err(Error::Codec(err)) => {
                assert_eq!(err.category, ErrorCategory::Schema);
                assert!(
                    err.detail.contains("not a chain identifier"),
                    "{}",
                    err.detail
                );
            }
            other => panic!("expected a schema error, got {other:?}"),
        }
    }
}
