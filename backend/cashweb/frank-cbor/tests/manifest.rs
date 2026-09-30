//! Every committed TypeScript vector, checked for category and byte identity.

mod common;

use frank_cbor::{
    decode_canonical, encode_canonical, validate_frame, wrap_frame, Error, ErrorCategory,
    ValidationResult,
};

use common::{content_hash_hex, context_from_json, round_trip_item};

#[test]
fn manifest_matches_the_typescript_corpus() {
    let text = include_str!("../../../../docs/protocol/cbor/vectors/manifest.json");
    let manifest: serde_json::Value = serde_json::from_str(text).expect("manifest json");
    assert_eq!(manifest["format"], "frank-cbor-v1-vectors");
    let cases = manifest["cases"].as_array().expect("cases");
    assert!(cases.len() > 200, "corpus shrunk to {}", cases.len());

    let mut failures = Vec::new();
    for case in cases {
        if let Some(problem) = check_case(case) {
            if failures.len() < 12 {
                failures.push(problem);
            } else {
                failures.push("...".to_string());
                break;
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} case failures (showing up to 12):\n{}",
        cases.len(),
        failures.join("\n")
    );
}

fn check_case(case: &serde_json::Value) -> Option<String> {
    let id = case["id"].as_str().unwrap_or("?");
    let frame = match hex::decode(case["frame_hex"].as_str().unwrap_or("")) {
        Ok(bytes) => bytes,
        Err(error) => return Some(format!("{id}: frame hex: {error}")),
    };
    let ctx = context_from_json(&case["validation_context"]);
    let expectation = case["expectation"].as_str().unwrap_or("");
    match validate_frame(&frame, &ctx) {
        Ok(result) => match expectation {
            "accept" => accept_problem(id, case, &frame, &ctx.operation, &result),
            "retain" => retain_problem(id, case, &frame, &result),
            "reject" => Some(format!("{id}: accepted, expected reject")),
            other => Some(format!("{id}: unknown expectation {other}")),
        },
        Err(Error::Codec(error)) => {
            if expectation != "reject" {
                return Some(format!(
                    "{id}: {} stage {} ({}), expected {expectation}",
                    error.category, error.stage, error.detail
                ));
            }
            let got = error.category.as_str();
            let want = case["error_category"].as_str().unwrap_or("");
            if got != want {
                return Some(format!(
                    "{id}: category {got} stage {} ({}), expected {want}",
                    error.stage, error.detail
                ));
            }
            // README section 10: a runner that reports stages SHOULD compare `error_stage`.
            if let Some(want_stage) = case["error_stage"].as_str() {
                if error.stage.as_str() != want_stage {
                    return Some(format!(
                        "{id}: category {got} ok, stage {} ({}), expected stage {want_stage}",
                        error.stage, error.detail
                    ));
                }
            }
            None
        }
        Err(Error::Context(error)) => Some(format!("{id}: context error: {error}")),
    }
}

fn accept_problem(
    id: &str,
    case: &serde_json::Value,
    frame: &[u8],
    operation: &frank_cbor::Operation,
    result: &ValidationResult,
) -> Option<String> {
    match (operation, result) {
        (frank_cbor::Operation::Frame, ValidationResult::Frame(only)) => {
            if only.frame != frame {
                return Some(format!("{id}: frame-only result dropped the input bytes"));
            }
            match wrap_frame(&frame[9..], frame[4]) {
                Ok(wrapped) if wrapped == frame => None,
                Ok(_) => Some(format!("{id}: wrap_frame did not reproduce the frame")),
                Err(error) => Some(format!("{id}: wrap_frame: {error}")),
            }
        }
        (_, ValidationResult::Parsed(parsed)) => {
            if parsed.frame != frame {
                return Some(format!("{id}: parsed result dropped the input bytes"));
            }
            if frame.len() < 9 {
                return Some(format!("{id}: accepted frame shorter than the header"));
            }
            let body = &frame[9..];
            if round_trip_item(body) != body {
                return Some(format!(
                    "{id}: envelope body did not re-encode byte-identically"
                ));
            }
            if round_trip_item(&parsed.payload_bytes) != parsed.payload_bytes {
                return Some(format!("{id}: payload did not re-encode byte-identically"));
            }
            // Unknown retained fields survive only when the generic value round-trips.
            if encode_canonical(&parsed.payload).ok().as_deref()
                != Some(parsed.payload_bytes.as_slice())
            {
                return Some(format!(
                    "{id}: decoded payload does not re-encode to the original"
                ));
            }
            if decode_canonical(&parsed.payload_bytes).ok().as_ref() != Some(&parsed.payload) {
                return Some(format!("{id}: payload value differs from a fresh decode"));
            }
            if let Some(type_id) = case.get("type_id").and_then(|v| v.as_u64()) {
                if u64::from(parsed.type_id) != type_id {
                    return Some(format!("{id}: type_id {} != {type_id}", parsed.type_id));
                }
            }
            if let Some(schema) = case.get("schema_version").and_then(|v| v.as_u64()) {
                if u64::from(parsed.schema_version) != schema {
                    return Some(format!(
                        "{id}: schema_version {} != {schema}",
                        parsed.schema_version
                    ));
                }
            }
            if let Some(want) = case.get("content_hash_hex").and_then(|v| v.as_str()) {
                let got = content_hash_hex(parsed);
                if got != want {
                    return Some(format!("{id}: content hash {got} != {want}"));
                }
            }
            None
        }
        _ => Some(format!("{id}: accept produced the wrong result kind")),
    }
}

fn retain_problem(
    id: &str,
    case: &serde_json::Value,
    frame: &[u8],
    result: &ValidationResult,
) -> Option<String> {
    let ValidationResult::Retained(retained) = result else {
        return Some(format!("{id}: expected retention"));
    };
    if retained.frame != frame {
        return Some(format!("{id}: retained bytes differ from the input"));
    }
    if let Some(want) = case.get("retained_frame_hex").and_then(|v| v.as_str()) {
        if want != case["frame_hex"].as_str().unwrap_or("") {
            return Some(format!("{id}: retained_frame_hex differs from frame_hex"));
        }
    }
    let _ = ErrorCategory::Frame;
    None
}
