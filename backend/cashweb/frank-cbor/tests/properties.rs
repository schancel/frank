//! Deterministic sweep of truncation, length, order, depth, count, and size.
//! No extra fuzzing dependency: every input below is generated in-process.

use frank_cbor::{
    cbor_map, decode_canonical, encode_canonical, encode_frame, validate_frame, CborValue,
    CodecError, EnvelopeFields, Error, ErrorCategory, FramePayload, MAX_ARRAY_ELEMENTS,
    MAX_BYTE_STRING_BYTES, MAX_CONTAINERS, MAX_DEPTH, MAX_ITEMS, MAX_MAP_ENTRIES,
    MAX_TEXT_STRING_BYTES,
};

fn codec(result: Result<frank_cbor::ValidationResult, Error>) -> CodecError {
    match result {
        Err(Error::Codec(error)) => error,
        other => panic!("expected a codec error, got {other:?}"),
    }
}

fn category_of(bytes: &[u8]) -> ErrorCategory {
    decode_canonical(bytes)
        .expect_err("item should fail")
        .category
}

#[test]
fn truncating_a_canonical_item_is_malformed() {
    let item = encode_canonical(&cbor_map(vec![
        (0, CborValue::Text("hi".to_string())),
        (1, CborValue::Int(1)),
        (2, CborValue::Bytes(vec![1, 2, 3, 4])),
        (
            3,
            CborValue::Array(vec![CborValue::Null, CborValue::Bool(false)]),
        ),
    ]))
    .unwrap();
    assert!(decode_canonical(&item).is_ok());
    for length in 0..item.len() {
        assert_eq!(
            category_of(&item[..length]),
            ErrorCategory::Malformed,
            "prefix of {length} bytes"
        );
    }
}

#[test]
fn corrupting_a_string_length_is_malformed() {
    let item = encode_canonical(&CborValue::Bytes(vec![1, 2, 3])).unwrap();
    assert_eq!(item, vec![0x43, 1, 2, 3]);
    let mut longer = item.clone();
    longer[0] = 0x44;
    assert_eq!(category_of(&longer), ErrorCategory::Malformed);
    let mut shorter = item.clone();
    shorter[0] = 0x42;
    assert_eq!(category_of(&shorter), ErrorCategory::Malformed);
}

#[test]
fn corrupting_the_frame_length_is_a_frame_error() {
    let payload = cbor_map(vec![(0, CborValue::Text("hi".to_string()))]);
    let frame = encode_frame(
        EnvelopeFields {
            type_id: 17,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&payload),
    )
    .unwrap();
    let present = (frame.len() - 9) as u32;
    for declared in [
        0u32,
        present.wrapping_sub(1),
        present.wrapping_add(1),
        u32::MAX,
    ] {
        let mut bad = frame.clone();
        bad[5..9].copy_from_slice(&declared.to_be_bytes());
        let error = codec(validate_frame(&bad, &frank_cbor::default_context()));
        assert_eq!(error.category, ErrorCategory::Frame, "declared {declared}");
    }
}

#[test]
fn map_order_and_duplicates_are_noncanonical() {
    let sorted = encode_canonical(&cbor_map(vec![
        (1, CborValue::Int(0)),
        (0, CborValue::Int(0)),
    ]))
    .unwrap();
    assert_eq!(sorted, vec![0xa2, 0x00, 0x00, 0x01, 0x00]);
    let reversed = vec![0xa2, 0x01, 0x00, 0x00, 0x00];
    assert_eq!(category_of(&reversed), ErrorCategory::Noncanonical);
    let duplicate = vec![0xa2, 0x00, 0x00, 0x00, 0x00];
    assert_eq!(category_of(&duplicate), ErrorCategory::Noncanonical);
}

#[test]
fn depth_count_and_size_limits() {
    assert!(decode_canonical(&nested(MAX_DEPTH as usize)).is_ok());
    assert_eq!(
        category_of(&nested(MAX_DEPTH as usize + 1)),
        ErrorCategory::Resource
    );

    assert!(decode_canonical(&null_array(MAX_ARRAY_ELEMENTS)).is_ok());
    assert_eq!(
        category_of(&[0x99, 0x20, 0x01]),
        ErrorCategory::Resource,
        "8193-element array is resource before its missing elements are read"
    );

    assert!(decode_canonical(&null_map(MAX_MAP_ENTRIES)).is_ok());
    assert_eq!(
        category_of(&[0xb9, 0x01, 0x01]),
        ErrorCategory::Resource,
        "257-entry map is resource before its missing entries are read"
    );

    let over_bytes = (MAX_BYTE_STRING_BYTES as u64) + 1;
    let mut head = vec![0x5b];
    head.extend_from_slice(&over_bytes.to_be_bytes());
    assert_eq!(category_of(&head), ErrorCategory::Resource);

    let over_text = (MAX_TEXT_STRING_BYTES as u64) + 1;
    let mut text = vec![0x7b];
    text.extend_from_slice(&over_text.to_be_bytes());
    assert_eq!(category_of(&text), ErrorCategory::Resource);

    assert_eq!(
        category_of(&containers(MAX_CONTAINERS as usize + 1)),
        ErrorCategory::Resource
    );
    assert!(decode_canonical(&containers(MAX_CONTAINERS as usize)).is_ok());

    assert!(decode_canonical(&items_at(MAX_ITEMS as usize)).is_ok());
    assert_eq!(
        category_of(&items_at(MAX_ITEMS as usize + 1)),
        ErrorCategory::Resource
    );
}

#[test]
fn insertion_order_converges_on_canonical_key_order() {
    let keys: Vec<u64> = (0..48).collect();
    let canonical = encode_canonical(&cbor_map(
        keys.iter()
            .map(|key| (*key, CborValue::Int(i128::from(*key))))
            .collect(),
    ))
    .unwrap();
    let mut order = keys.clone();
    let mut state = 1u64;
    for _ in 0..12 {
        for index in (1..order.len()).rev() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let swap_with = (state as usize) % (index + 1);
            order.swap(index, swap_with);
        }
        let encoded = encode_canonical(&cbor_map(
            order
                .iter()
                .map(|key| (*key, CborValue::Int(i128::from(*key))))
                .collect(),
        ))
        .unwrap();
        assert_eq!(encoded, canonical);
    }
}

fn nested(levels: usize) -> Vec<u8> {
    let mut out = vec![0x81; levels - 1];
    out.push(0x80);
    out
}

fn null_array(count: usize) -> Vec<u8> {
    let mut out = Vec::new();
    // Definite array head, then `count` nulls. Counts above 23 use a 2-byte argument.
    if count < 24 {
        out.push(0x80 | count as u8);
    } else {
        let arg = u16::try_from(count).unwrap();
        out.push(0x99);
        out.extend_from_slice(&arg.to_be_bytes());
    }
    out.extend(std::iter::repeat_n(0xf6, count));
    out
}

fn null_map(count: usize) -> Vec<u8> {
    let mut entries = Vec::with_capacity(count);
    for key in 0..count {
        entries.push((key as u64, CborValue::Null));
    }
    encode_canonical(&cbor_map(entries)).unwrap()
}

/// `count` containers: a root array whose children are empty or wrap one empty array.
fn containers(count: usize) -> Vec<u8> {
    assert!(count >= 2 && count <= MAX_CONTAINERS as usize + 1);
    // 8192 wrapped children would be 1 + 8192 + 8192 = 16385 containers.
    // Drop one grandchild to land on 16384, or keep it to land on 16385.
    let grandchildren = count - 1 - MAX_ARRAY_ELEMENTS;
    let mut out = vec![0x99, 0x20, 0x00];
    for index in 0..MAX_ARRAY_ELEMENTS {
        if index < grandchildren {
            out.extend_from_slice(&[0x81, 0x80]);
        } else {
            out.push(0x80);
        }
    }
    out
}

/// An array of 16 arrays of nulls with exactly `total` items, counting every head.
fn items_at(total: usize) -> Vec<u8> {
    // 1 outer + 16 inners + nulls = total, so nulls = total - 17.
    // Split as 15 arrays of 8192 and one remainder. Both totals used here fit.
    let nulls = total - 17;
    let full = 15;
    let rest = nulls - full * MAX_ARRAY_ELEMENTS;
    assert!(rest <= MAX_ARRAY_ELEMENTS);
    let mut out = vec![0x90];
    for _ in 0..full {
        out.extend_from_slice(&[0x99, 0x20, 0x00]);
        out.extend(std::iter::repeat_n(0xf6, MAX_ARRAY_ELEMENTS));
    }
    let rest_u16 = u16::try_from(rest).unwrap();
    out.push(0x99);
    out.extend_from_slice(&rest_u16.to_be_bytes());
    out.extend(std::iter::repeat_n(0xf6, rest));
    out
}
