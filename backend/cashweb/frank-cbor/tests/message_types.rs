//! The generated type identifiers agree with `docs/protocol/message-types/v1.json`.
//! Regenerate with `yarn message-types:generate`; `yarn message-types:check` is the full gate.

use std::collections::BTreeSet;

use frank_cbor::message_types::*;
use serde_json::Value;

fn registry() -> Vec<Value> {
    let doc: Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/message-types/v1.json"
    ))
    .unwrap();
    doc["types"].as_array().unwrap().clone()
}

fn id_of(key: &str) -> u32 {
    let entry = registry()
        .into_iter()
        .find(|t| t["key"] == key)
        .unwrap_or_else(|| panic!("{key} is not registered"));
    u32::try_from(entry["id"].as_u64().unwrap()).unwrap()
}

#[test]
fn registry_allocates_every_id_once() {
    let ids: Vec<u64> = registry().iter().map(|t| t["id"].as_u64().unwrap()).collect();
    assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), ids.len());
}

#[test]
fn generated_constants_match_the_registry() {
    let generated = [
        ("direct-message-delivery", TYPE_DIRECT_MESSAGE_DELIVERY),
        ("directory-attestation", TYPE_DIRECTORY_ATTESTATION),
        ("mailbox-checkpoint", TYPE_MAILBOX_CHECKPOINT),
        ("directory-statement", TYPE_DIRECTORY_STATEMENT),
        ("recipient-encrypted-payload", TYPE_RECIPIENT_ENCRYPTED_PAYLOAD),
        ("encrypted-message-content", TYPE_ENCRYPTED_MESSAGE_CONTENT),
        ("key-transition-statement", TYPE_KEY_TRANSITION_STATEMENT),
        ("message-content-revision", TYPE_MESSAGE_CONTENT_REVISION),
        ("topic-post", TYPE_TOPIC_POST),
        ("topic-post-submission", TYPE_TOPIC_POST_SUBMISSION),
        ("topic-vote-submission", TYPE_TOPIC_VOTE_SUBMISSION),
        ("forum-view", TYPE_FORUM_VIEW),
        ("forum-topic-page", TYPE_FORUM_TOPIC_PAGE),
        ("forum-discovery-page", TYPE_FORUM_DISCOVERY_PAGE),
        ("forum-operation-status", TYPE_FORUM_OPERATION_STATUS),
        ("container-message-item", TYPE_CONTAINER_MESSAGE_ITEM),
        ("text-message-item", TYPE_TEXT_MESSAGE_ITEM),
        ("blackjack-message-item", TYPE_BLACKJACK_MESSAGE_ITEM),
        ("stealth-message-item", TYPE_STEALTH_MESSAGE_ITEM),
        ("channel-update", TYPE_CHANNEL_UPDATE),
        ("forwarding-delivery-envelope", TYPE_FORWARDING_DELIVERY_ENVELOPE),
        ("email-message-item", TYPE_EMAIL_MESSAGE_ITEM),
        ("plugin-message-item", TYPE_PLUGIN_MESSAGE_ITEM),
        ("proof-unknown-item", TYPE_PROOF_UNKNOWN_ITEM),
    ];
    assert_eq!(generated.len(), registry().len());
    for (key, id) in generated {
        assert_eq!(id, id_of(key), "{key}");
    }
    let forbidden: BTreeSet<u32> = registry()
        .iter()
        .filter(|t| t["open_item_field"] == false)
        .map(|t| u32::try_from(t["id"].as_u64().unwrap()).unwrap())
        .collect();
    assert_eq!(
        OPEN_ITEM_FIELD_FORBIDDEN_TYPES.iter().copied().collect::<BTreeSet<_>>(),
        forbidden
    );
}
