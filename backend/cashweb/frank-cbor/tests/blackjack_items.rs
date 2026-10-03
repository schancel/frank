//! Active type-18 public-facade proof; no runtime/game/economic authority is inferred.
use frank_cbor::{default_context, parse_frame, ValidationResult};

#[test]
fn frozen_bet_has_active_typed_support() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/proposals/blackjack-items/vectors.json"
    )).unwrap();
    let bytes = hex::decode(corpus["frames"][0]["frameHex"].as_str().unwrap()).unwrap();
    let result = parse_frame(&bytes, &default_context());
    assert!(matches!(result, Ok(ValidationResult::Parsed(ref p)) if p.type_id == 18 && p.typed.is_some()), "missing active type18: {result:?}");
}
