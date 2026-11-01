//! The Rust reader preserves generic plugin frames; application MIME interpretation belongs to clients.
mod common;
use frank_cbor::{validate_frame, ValidationResult};
#[test]
fn binary_mime_plugin_corpus_is_retained_byte_exactly() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/blob-message-item.json"
    ))
    .unwrap();
    let mut context = common::typed_context();
    context.opaque_retention_allowed = true;
    for item in corpus["frames"].as_array().unwrap() {
        let bytes = hex::decode(item["frameHex"].as_str().unwrap()).unwrap();
        match validate_frame(&bytes, &context).unwrap() {
            ValidationResult::Retained(frame) => assert_eq!(frame.frame, bytes, "{}", item["id"]),
            other => panic!("generic plugin application content must remain opaque: {other:?}"),
        }
    }
}
