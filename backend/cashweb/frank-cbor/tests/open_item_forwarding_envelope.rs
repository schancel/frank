//! S8: a relay refuses a type-25 forwarding envelope placed inside a message's open item field.
//! (A client instead keeps it as an uninterpreted unknown item; that is tested in the TypeScript
//! codec and wallet.)

mod common;

use frank_cbor::message_fields::{
    forwarding_delivery_envelope as envelope_k, message_content_revision as revision,
    text_message_item as text_k,
};
use frank_cbor::message_types::{
    TYPE_FORWARDING_DELIVERY_ENVELOPE, TYPE_MESSAGE_CONTENT_REVISION, TYPE_TEXT_MESSAGE_ITEM,
};
use frank_cbor::{cbor_map, validate_frame, CborValue, Error, ValidationResult};

use common::{fr, typed_context, NET};

fn text(s: &str) -> CborValue {
    CborValue::Text(s.to_string())
}

fn outcome(frame: &[u8]) -> String {
    match validate_frame(frame, &typed_context()) {
        Ok(ValidationResult::Parsed(_)) => "parsed".to_string(),
        Ok(_) => "other".to_string(),
        Err(Error::Codec(error)) => format!("{}@{}", error.category, error.stage),
        Err(other) => panic!("{other}"),
    }
}

fn revision_with(items: Vec<Vec<u8>>) -> Vec<u8> {
    fr(
        TYPE_MESSAGE_CONTENT_REVISION,
        &cbor_map(vec![
            (revision::NETWORK, text("frank")),
            (
                revision::ITEMS,
                CborValue::Array(items.into_iter().map(CborValue::Bytes).collect()),
            ),
        ]),
    )
}

fn text_item(body: &str) -> Vec<u8> {
    fr(
        TYPE_TEXT_MESSAGE_ITEM,
        &cbor_map(vec![(text_k::TEXT, text(body))]),
    )
}

#[test]
fn a_relay_refuses_a_forwarding_envelope_as_a_message_item() {
    let envelope = fr(
        TYPE_FORWARDING_DELIVERY_ENVELOPE,
        &cbor_map(vec![(envelope_k::NETWORK, text(NET))]),
    );
    assert_eq!(
        outcome(&revision_with(vec![
            text_item("before"),
            text_item("after")
        ])),
        "parsed"
    );
    assert_eq!(
        outcome(&revision_with(vec![
            text_item("before"),
            envelope,
            text_item("after"),
        ])),
        "semantic@8.4"
    );
}
