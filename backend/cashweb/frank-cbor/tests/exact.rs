//! Integers and nanosecond timestamps stay exact. No floating conversion.

mod common;

use frank_cbor::{
    cbor_map, decode_canonical, encode_canonical, validate_frame, CborValue, TypedPayload,
    ValidationResult,
};

const NINT_MIN: i128 = -1 - (u64::MAX as i128);

use common::{acct1, bytes_of, directory_attestation_frame, fr, ts, typed_context, NET};

fn round_trip(value: i128) -> i128 {
    let encoded = encode_canonical(&CborValue::Int(value)).expect("encode");
    match decode_canonical(&encoded).expect("decode") {
        CborValue::Int(decoded) => decoded,
        other => panic!("decoded {other:?}"),
    }
}

#[test]
fn integer_boundaries_round_trip_as_integers() {
    let max_u64 = i128::from(u64::MAX);
    let values = [
        0,
        23,
        24,
        255,
        256,
        65_535,
        65_536,
        i128::from(u32::MAX),
        i128::from(u32::MAX) + 1,
        max_u64,
        -1,
        -24,
        -25,
        i128::from(i64::MIN),
        NINT_MIN,
    ];
    for value in values {
        assert_eq!(round_trip(value), value, "{value}");
    }
    // The additional-info boundary bytes themselves stay shortest-form.
    assert_eq!(encode_canonical(&CborValue::Int(23)).unwrap(), vec![0x17]);
    assert_eq!(
        encode_canonical(&CborValue::Int(24)).unwrap(),
        vec![0x18, 24]
    );
    assert_eq!(
        encode_canonical(&CborValue::Int(-25)).unwrap(),
        vec![0x38, 24]
    );
    let mut min_head = vec![0x3b];
    min_head.extend_from_slice(&u64::MAX.to_be_bytes());
    assert_eq!(
        encode_canonical(&CborValue::Int(NINT_MIN)).unwrap(),
        min_head
    );
}

#[test]
fn timestamp_seconds_and_nanoseconds_stay_exact_in_a_typed_frame() {
    for (seconds, nanos) in [(i64::MIN, 999_999_999u32), (i64::MAX, 999_999_999), (0, 0)] {
        let frame = fr(
            3,
            &cbor_map(vec![
                (0, CborValue::Text(NET.to_string())),
                (1, acct1(5)),
                (2, CborValue::Bytes(bytes_of(16, 77))),
                (3, ts(seconds, nanos)),
                (4, CborValue::Array(vec![])),
            ]),
        );
        let result = validate_frame(&frame, &typed_context()).expect("checkpoint");
        let ValidationResult::Parsed(parsed) = result else {
            panic!("not parsed");
        };
        match parsed.typed.as_deref() {
            Some(TypedPayload::MailboxCheckpoint { timestamp, .. }) => {
                assert_eq!(timestamp.seconds, seconds);
                assert_eq!(timestamp.nanoseconds, nanos);
            }
            other => panic!("unexpected projection {other:?}"),
        }
    }
}

#[test]
fn directory_fixture_keeps_max_revision_and_expiry_nanos() {
    let frame = directory_attestation_frame();
    let result = validate_frame(&frame, &typed_context()).expect("attestation");
    let ValidationResult::Parsed(root) = result else {
        panic!("not parsed");
    };
    let Some(TypedPayload::DirectoryAttestation { statement, .. }) = root.typed.as_deref() else {
        panic!("not an attestation");
    };
    let Some(TypedPayload::DirectoryStatement {
        revision, expiry, ..
    }) = statement.typed.as_deref()
    else {
        panic!("statement was not opened");
    };
    assert_eq!(*revision, u64::MAX);
    let expiry = expiry.expect("expiry");
    assert_eq!(expiry.seconds, 1_900_000_000);
    assert_eq!(expiry.nanoseconds, 999_999_999);
}
