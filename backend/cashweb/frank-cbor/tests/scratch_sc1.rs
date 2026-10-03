//! SC-1 probe: a schema-3 type-4 statement (carrying field 9) through the Rust default context.

use frank_cbor::{
    default_context, validate_frame, ParsedFrame, Projection, TypedPayload, ValidationResult,
};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn scratch_sc1_default_context_schema3_type4_field9() {
    let t4 = hex(include_str!("scratch_t4_schema3.hex").trim());
    let r = validate_frame(&t4, &default_context());
    match r {
        Ok(ValidationResult::Parsed(ParsedFrame {
            type_id,
            schema_version,
            projection,
            typed,
            ..
        })) => {
            println!("RUST default_context root outcome: parsed");
            println!("  type_id {} schema_version {}", type_id, schema_version);
            println!(
                "  projection {:?}",
                match projection {
                    Projection::Exact => "Exact",
                    Projection::NewerSchema => "NewerSchema (V6.3)",
                }
            );
            match *typed.expect("typed") {
                TypedPayload::DirectoryStatement {
                    profile_entries,
                    unknown,
                    ..
                } => {
                    println!("  profile_entries is Some? {:?}", profile_entries.is_some());
                    if let Some(entries) = &profile_entries {
                        println!(
                            "  kinds {:?}",
                            entries.iter().map(|e| e.kind.clone()).collect::<Vec<_>>()
                        );
                    }
                    println!(
                        "  unknown keys {:?}",
                        unknown.iter().map(|(k, _)| k).collect::<Vec<_>>()
                    );
                }
                other => panic!("unexpected typed payload {:?}", other),
            }
        }
        Ok(ValidationResult::Retained(ret)) => {
            println!("RUST default_context root outcome: retained {:?}", ret.reason);
        }
        Ok(ValidationResult::Frame(_)) => println!("RUST frame-only (unexpected)"),
        Err(e) => println!("RUST default_context root outcome: error {:?}", e),
    }
}