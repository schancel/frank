//! R2 at its boundary: the largest direct message (an 8 MiB + 88-byte crypto-box envelope, with
//! 64 payment members) is admitted; one byte more is `resource` at 8.1. Every other type keeps
//! the 8 MiB + 9-byte frame limit it had before the direct-message limit was raised.
mod common;

use common::{
    acct1, bytes_of, fr, int, payment, section, ts, NET, T3C_EPHEMERAL, T3C_PROOF, T3C_SHARED,
    T3C_STAMP_KEY,
};
use frank_cbor::message_fields::{
    direct_message_delivery as dmd, encryption_suite, mailbox_checkpoint as ckpt,
    recipient_encrypted_payload_v2 as rep2,
};
use frank_cbor::message_types::{
    TYPE_DIRECT_MESSAGE_DELIVERY, TYPE_MAILBOX_CHECKPOINT, TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
};
use frank_cbor::{
    cbor_map, default_context, encode_frame, recipient_payload_digest, relay_context,
    validate_frame, CborValue, EnvelopeFields, Error, FramePayload, PriorStatement,
    MAX_DIRECT_MESSAGE_FRAME_BYTES, MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES, MAX_GENERAL_FRAME_BYTES,
};

fn outcome(bytes: &[u8], ctx: &frank_cbor::ValidationContext) -> String {
    match validate_frame(bytes, ctx) {
        Ok(frank_cbor::ValidationResult::Parsed(_)) => "parsed".into(),
        Ok(_) => "other".into(),
        Err(Error::Context(_)) => "context".into(),
        Err(Error::Codec(error)) => format!("{}@{}", error.category, error.stage),
    }
}

fn frame(type_id: u32, payload: &CborValue, schema: u32, min: u32) -> Vec<u8> {
    encode_frame(
        EnvelopeFields {
            type_id,
            schema_version: schema,
            min_reader_version: min,
        },
        FramePayload::Value(payload),
    )
    .unwrap()
}

/// A type-11 schema-2 payload whose crypto-box envelope is `envelope` bytes.
fn payload(envelope: usize) -> Vec<u8> {
    frame(
        TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
        &cbor_map(vec![
            (rep2::NETWORK, CborValue::Text(NET.into())),
            (rep2::SENDER, acct1(9)),
            (rep2::RECIPIENT, acct1(3)),
            (rep2::SUITE, int(encryption_suite::DM_AUTH_XCHACHA.into())),
            (
                rep2::CRYPTO_BOX_ENVELOPE,
                CborValue::Bytes(vec![0x5a; envelope]),
            ),
            (
                rep2::EPHEMERAL_POINT,
                CborValue::Bytes(hex::decode(T3C_EPHEMERAL).unwrap()),
            ),
            (
                rep2::SHARED_POINT,
                CborValue::Bytes(hex::decode(T3C_SHARED).unwrap()),
            ),
            (
                rep2::DLEQ_PROOF,
                CborValue::Bytes(hex::decode(T3C_PROOF).unwrap()),
            ),
        ]),
        2,
        2,
    )
}

/// The type-10 delivery of that payload with 64 payment members.
fn delivery(envelope: usize) -> Vec<u8> {
    let payload_frame = payload(envelope);
    let t3 = recipient_payload_digest(NET, &payload_frame).unwrap();
    frame(
        TYPE_DIRECT_MESSAGE_DELIVERY,
        &cbor_map(vec![
            (dmd::NETWORK, CborValue::Text(NET.into())),
            (dmd::DESTINATION, common::stamp_account(T3C_STAMP_KEY)),
            (dmd::PAYLOAD_FRAME, CborValue::Bytes(payload_frame)),
            (dmd::PAYLOAD_DIGEST, CborValue::Bytes(t3.to_vec())),
            (
                dmd::PAYMENTS,
                CborValue::Array((0..64).map(|index| payment(&t3, index)).collect()),
            ),
        ]),
        2,
        1,
    )
}

#[test]
fn the_crypto_box_envelope_is_bounded_at_8_mib_plus_88_bytes() {
    assert_eq!(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES, 8_388_696);
    let ctx = default_context();
    let largest = payload(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES);
    // The largest payload is more than a frame of any other type may be.
    assert!(largest.len() > MAX_GENERAL_FRAME_BYTES);
    assert_eq!(outcome(&largest, &ctx), "parsed");
    assert_eq!(
        outcome(&payload(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES + 1), &ctx),
        "resource@8.1"
    );
}

#[test]
fn a_relay_admits_the_largest_delivery_with_64_payments_and_not_one_byte_more() {
    let ctx = relay_context();
    let largest = delivery(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES);
    assert!(largest.len() > 8 * 1024 * 1024);
    assert!(largest.len() <= MAX_DIRECT_MESSAGE_FRAME_BYTES);
    assert_eq!(outcome(&largest, &ctx), "parsed");
    assert_eq!(
        outcome(&delivery(MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES + 1), &ctx),
        "resource@8.1"
    );
}

#[test]
fn a_type_10_frame_is_bounded_at_10_mib() {
    assert_eq!(MAX_DIRECT_MESSAGE_FRAME_BYTES, 10_485_760);
    // A newer type-10 root (schema 3) projected through schema 2, padded by an additive field.
    let padded = |pad: usize| {
        let payload_frame = payload(1);
        let t3 = recipient_payload_digest(NET, &payload_frame).unwrap();
        frame(
            TYPE_DIRECT_MESSAGE_DELIVERY,
            &cbor_map(vec![
                (dmd::NETWORK, CborValue::Text(NET.into())),
                (dmd::DESTINATION, common::stamp_account(T3C_STAMP_KEY)),
                (dmd::PAYLOAD_FRAME, CborValue::Bytes(payload_frame)),
                (dmd::PAYLOAD_DIGEST, CborValue::Bytes(t3.to_vec())),
                (dmd::PAYMENTS, CborValue::Array(vec![payment(&t3, 0)])),
                // raw-cbor-key: an additive padding field no reader declares
                (99, CborValue::Bytes(vec![0; pad])),
            ]),
            3,
            1,
        )
    };
    let mut pad = 10_480_000;
    pad += MAX_DIRECT_MESSAGE_FRAME_BYTES - padded(pad).len();
    let ctx = relay_context();
    assert_eq!(padded(pad).len(), MAX_DIRECT_MESSAGE_FRAME_BYTES);
    assert_eq!(outcome(&padded(pad), &ctx), "parsed");
    assert_eq!(padded(pad + 1).len(), MAX_DIRECT_MESSAGE_FRAME_BYTES + 1);
    assert_eq!(outcome(&padded(pad + 1), &ctx), "resource@8.1");
}

#[test]
fn every_other_type_keeps_the_8_mib_frame_limit() {
    assert_eq!(MAX_GENERAL_FRAME_BYTES, 8_388_617);
    let checkpoint = |pad: usize| {
        fr(
            TYPE_MAILBOX_CHECKPOINT,
            &cbor_map(vec![
                (ckpt::NETWORK, CborValue::Text(NET.to_string())),
                (ckpt::OWNER, acct1(5)),
                (ckpt::CHECKPOINT_ID, CborValue::Bytes(bytes_of(16, 77))),
                (ckpt::TIMESTAMP, ts(1_700_000_500, 5)),
                (ckpt::FACTS, CborValue::Array(vec![])),
                (
                    ckpt::SECTIONS,
                    CborValue::Array(vec![section(1, 1, vec![0; pad])]),
                ),
            ]),
        )
    };
    let mut ctx = default_context();
    ctx.prior = PriorStatement::None;
    let mut pad = 8_380_000;
    pad += MAX_GENERAL_FRAME_BYTES - checkpoint(pad).len();
    assert_eq!(checkpoint(pad).len(), MAX_GENERAL_FRAME_BYTES);
    assert_eq!(outcome(&checkpoint(pad), &ctx), "parsed");
    assert_eq!(checkpoint(pad + 1).len(), MAX_GENERAL_FRAME_BYTES + 1);
    assert_eq!(outcome(&checkpoint(pad + 1), &ctx), "resource@8.1");
}
