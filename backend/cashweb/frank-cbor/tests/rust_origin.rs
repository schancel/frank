//! Rust encodings of the three proof-fixture families, committed for TypeScript.

mod common;

use frank_cbor::{validate_frame, ValidationResult};

use common::{
    checkpoint_frame, content_hash_hex, direct_message_frame, directory_attestation_frame,
    repo_path, topic_context, topic_post_frame, topic_post_submission_frame, topic_vote_frame,
    typed_context,
};

#[test]
fn rust_fixtures_match_the_typescript_bytes_and_the_committed_file() {
    let manifest_text = include_str!("../../../../docs/protocol/cbor/vectors/manifest.json");
    let manifest: serde_json::Value = serde_json::from_str(manifest_text).unwrap();
    let cases = manifest["cases"].as_array().unwrap();
    let expect_same = |id: &str, frame: &[u8]| {
        let case = cases.iter().find(|case| case["id"] == id).expect(id);
        let want = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
        assert_eq!(frame, want.as_slice(), "{id}");
    };
    let direct = direct_message_frame();
    let directory = directory_attestation_frame();
    let checkpoint = checkpoint_frame();
    expect_same("fixture-direct-message-typed", &direct);
    expect_same("fixture-directory-attestation-typed", &directory);
    expect_same("fixture-checkpoint-typed", &checkpoint);
    let topic = [
        topic_post_frame(),
        topic_post_submission_frame(),
        topic_vote_frame(),
    ];
    expect_same("fixture-topic-post-typed", &topic[0]);
    expect_same("fixture-topic-post-submission-typed", &topic[1]);
    expect_same("fixture-topic-vote-typed", &topic[2]);

    let document = document(&direct, &directory, &checkpoint, &topic);
    let serialized = serde_json::to_string_pretty(&document).unwrap() + "\n";
    let path = repo_path("../../../docs/protocol/cbor/vectors/rust-origin.json");
    if std::env::var("FRANK_UPDATE_RUST_VECTORS").ok().as_deref() == Some("1") {
        std::fs::write(&path, &serialized).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "read {}: {error}. Regenerate with FRANK_UPDATE_RUST_VECTORS=1",
            path.display()
        )
    });
    assert_eq!(committed, serialized);
}

fn document(
    direct: &[u8],
    directory: &[u8],
    checkpoint: &[u8],
    topic: &[Vec<u8>; 3],
) -> serde_json::Value {
    serde_json::json!({
        "format": "frank-cbor-v1-vectors",
        "cases": [
            case(
                "rust-fixture-direct-message",
                "Rust encoding of the direct-message proof fixture (type 1).",
                direct,
                &["S3", "S8", "S9", "T3", "T4"],
            ),
            case(
                "rust-fixture-directory-attestation",
                "Rust encoding of the directory-attestation proof fixture (type 2, bootstrap, u64::MAX revision).",
                directory,
                &["S4", "S10", "T1"],
            ),
            case(
                "rust-fixture-checkpoint",
                "Rust encoding of the mailbox-checkpoint proof fixture (type 3).",
                checkpoint,
                &["S6", "S7"],
            ),
            topic_case(
                "rust-fixture-topic-post",
                "Rust encoding of the type-9 topic post fixture.",
                &topic[0],
                &["S12", "T1"],
            ),
            topic_case(
                "rust-fixture-topic-post-submission",
                "Rust encoding of the type-10 topic post submission fixture.",
                &topic[1],
                &["S8", "S11", "T7"],
            ),
            topic_case(
                "rust-fixture-topic-vote",
                "Rust encoding of the type-11 topic vote fixture.",
                &topic[2],
                &["S12", "T7"],
            ),
        ]
    })
}

fn case(id: &str, description: &str, frame: &[u8], rules: &[&str]) -> serde_json::Value {
    case_in(id, description, frame, rules, typed_context())
}

/// A case validated by a reader that lists the topic-event types.
fn topic_case(id: &str, description: &str, frame: &[u8], rules: &[&str]) -> serde_json::Value {
    case_in(id, description, frame, rules, topic_context())
}

fn case_in(
    id: &str,
    description: &str,
    frame: &[u8],
    rules: &[&str],
    ctx: frank_cbor::ValidationContext,
) -> serde_json::Value {
    let result = validate_frame(frame, &ctx).expect(id);
    let ValidationResult::Parsed(parsed_frame) = &result else {
        panic!("{id} was not parsed");
    };
    let schemas: Vec<serde_json::Value> = ctx
        .supported_schemas
        .iter()
        .map(|schema| {
            serde_json::json!({
                "type_id": schema.type_id,
                "schema_version": schema.schema_version,
            })
        })
        .collect();
    serde_json::json!({
        "id": id,
        "description": description,
        "source": "rust",
        "frame_hex": hex::encode(frame),
        "validation_context": {
            "operation": "typed",
            "route_byte_limit": ctx.route_byte_limit,
            "reader_version": ctx.reader_version,
            "supported_schemas": schemas,
            "opaque_retention_allowed": false,
            "prior_directory_statement_frame_hex": serde_json::Value::Null,
        },
        "expectation": "accept",
        "rules": rules,
        "type_id": parsed_frame.type_id,
        "schema_version": parsed_frame.schema_version,
        "content_hash_hex": content_hash_hex(parsed_frame),
    })
}
