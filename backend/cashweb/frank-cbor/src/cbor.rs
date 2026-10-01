//! Restricted deterministic CBOR (README section 3).
//!
//! The encoder sorts map keys numerically, which is bytewise order for shortest
//! unsigned keys (C1, C11). The decoder is the section 9 two-pass validator:
//! pass A is syntax and resources; pass B is canonicality and profile class,
//! and it runs only after pass A accepts the whole item.

use crate::error::{CborPass, CodecError, ErrorCategory, ErrorStage, UsageError};
use crate::limits::{
    MAX_ARRAY_ELEMENTS, MAX_BYTE_STRING_BYTES, MAX_CONTAINERS, MAX_DEPTH, MAX_ITEMS,
    MAX_MAP_ENTRIES, MAX_TEXT_STRING_BYTES, NINT_MIN, U64_MAX,
};

/// One restricted-profile value. Every integer is exact: no binary float.
///
/// `Int` is in `-2^64..=2^64-1`. `Map` entries are unsigned keys. A successful
/// decode stores them in ascending key order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CborValue {
    /// Exact integer. Not an `f64`.
    Int(i128),
    /// `false` or `true`.
    Bool(bool),
    /// CBOR `null`.
    Null,
    /// Well-formed UTF-8 text.
    Text(String),
    /// Definite byte string. Leading zeros are significant.
    Bytes(Vec<u8>),
    /// Definite array.
    Array(Vec<CborValue>),
    /// Map of unsigned keys. Encode sorts; insertion order is not significant.
    Map(Vec<(u64, CborValue)>),
}

/// R1 counters shared by an envelope, its payload, and every opened child.
#[derive(Debug, Default)]
pub(crate) struct Counters {
    pub containers: u32,
    pub items: u32,
}

struct Site {
    stage: ErrorStage,
    location: String,
}

fn err(
    site: &Site,
    pass: CborPass,
    category: ErrorCategory,
    detail: impl Into<String>,
) -> CodecError {
    CodecError::new(
        category,
        site.stage,
        detail,
        site.location.clone(),
        Some(pass),
    )
}

fn usage(detail: impl Into<String>) -> UsageError {
    UsageError(detail.into())
}

// ---------------------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------------------

fn encode_head(major: u8, arg: u64) -> Vec<u8> {
    let m = major << 5;
    if arg < 24 {
        vec![m | arg as u8]
    } else if arg < 0x100 {
        vec![m | 24, arg as u8]
    } else if arg < 0x1_0000 {
        vec![m | 25, (arg >> 8) as u8, arg as u8]
    } else if arg < 0x1_0000_0000 {
        vec![
            m | 26,
            (arg >> 24) as u8,
            (arg >> 16) as u8,
            (arg >> 8) as u8,
            arg as u8,
        ]
    } else {
        let mut out = vec![m | 27];
        out.extend_from_slice(&arg.to_be_bytes());
        out
    }
}

fn encode_into(value: &CborValue, out: &mut Vec<u8>, depth: usize) -> Result<(), UsageError> {
    if depth > 256 {
        return Err(usage("value is nested too deeply to encode"));
    }
    match value {
        CborValue::Int(n) => {
            if *n >= 0 {
                if *n > U64_MAX {
                    return Err(usage("integer above 2^64-1"));
                }
                out.extend(encode_head(0, *n as u64));
            } else {
                if *n < NINT_MIN {
                    return Err(usage("integer below -2^64"));
                }
                let arg = (-1 - *n) as u64;
                out.extend(encode_head(1, arg));
            }
        }
        CborValue::Bool(v) => out.push(if *v { 0xf5 } else { 0xf4 }),
        CborValue::Null => out.push(0xf6),
        CborValue::Text(s) => {
            let b = s.as_bytes();
            out.extend(encode_head(3, b.len() as u64));
            out.extend_from_slice(b);
        }
        CborValue::Bytes(b) => {
            out.extend(encode_head(2, b.len() as u64));
            out.extend_from_slice(b);
        }
        CborValue::Array(items) => {
            out.extend(encode_head(4, items.len() as u64));
            for item in items {
                encode_into(item, out, depth + 1)?;
            }
        }
        CborValue::Map(entries) => {
            let mut ordered: Vec<(u64, &CborValue)> =
                entries.iter().map(|(k, v)| (*k, v)).collect();
            ordered.sort_by_key(|(k, _)| *k);
            for pair in ordered.windows(2) {
                if pair[0].0 == pair[1].0 {
                    return Err(usage(format!("duplicate map key {} (C4)", pair[0].0)));
                }
            }
            out.extend(encode_head(5, ordered.len() as u64));
            for (k, v) in ordered {
                out.extend(encode_head(0, k));
                encode_into(v, out, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// Encodes one value as canonical restricted CBOR. Map insertion order is ignored.
pub fn encode_canonical(value: &CborValue) -> Result<Vec<u8>, UsageError> {
    let mut out = Vec::new();
    encode_into(value, &mut out, 0)?;
    Ok(out)
}

/// Builds a map value. Pair order does not affect [`encode_canonical`].
pub fn cbor_map(entries: Vec<(u64, CborValue)>) -> CborValue {
    CborValue::Map(entries)
}

// ---------------------------------------------------------------------------------------------
// Head reader
// ---------------------------------------------------------------------------------------------

struct Head {
    major: u8,
    ai: u8,
    arg: u64,
    indefinite: bool,
    size: usize,
}

fn read_head(bytes: &[u8], off: usize, site: &Site, pass: CborPass) -> Result<Head, CodecError> {
    if off >= bytes.len() {
        return Err(err(
            site,
            pass,
            ErrorCategory::Malformed,
            "truncated: missing item head",
        ));
    }
    let ib = bytes[off];
    let major = ib >> 5;
    let ai = ib & 0x1f;
    if ai < 24 {
        return Ok(Head {
            major,
            ai,
            arg: u64::from(ai),
            indefinite: false,
            size: 1,
        });
    }
    if (28..=30).contains(&ai) {
        return Err(err(
            site,
            pass,
            ErrorCategory::Malformed,
            format!("reserved additional information {ai}"),
        ));
    }
    if ai == 31 {
        if major == 0 || major == 1 || major == 6 {
            return Err(err(
                site,
                pass,
                ErrorCategory::Malformed,
                "indefinite length on an integer or tag",
            ));
        }
        return Ok(Head {
            major,
            ai,
            arg: 0,
            indefinite: true,
            size: 1,
        });
    }
    let n = match ai {
        24 => 1,
        25 => 2,
        26 => 4,
        _ => 8,
    };
    let end = off.checked_add(1 + n).ok_or_else(|| {
        err(
            site,
            pass,
            ErrorCategory::Malformed,
            "truncated: incomplete argument",
        )
    })?;
    if end > bytes.len() {
        return Err(err(
            site,
            pass,
            ErrorCategory::Malformed,
            "truncated: incomplete argument",
        ));
    }
    let mut arg = 0u64;
    for byte in &bytes[off + 1..end] {
        arg = (arg << 8) | u64::from(*byte);
    }
    Ok(Head {
        major,
        ai,
        arg,
        indefinite: false,
        size: 1 + n,
    })
}

fn is_minimal(head: &Head) -> bool {
    match head.ai {
        0..=23 => true,
        24 => head.arg >= 24,
        25 => head.arg >= 0x100,
        26 => head.arg >= 0x1_0000,
        27 => head.arg >= 0x1_0000_0000,
        _ => true,
    }
}

// ---------------------------------------------------------------------------------------------
// Pass A
// ---------------------------------------------------------------------------------------------

struct Scan<'a> {
    bytes: &'a [u8],
    counters: &'a mut Counters,
    site: &'a Site,
}

fn charge_item(scan: &mut Scan<'_>) -> Result<(), CodecError> {
    scan.counters.items = scan.counters.items.saturating_add(1);
    if scan.counters.items > MAX_ITEMS {
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Resource,
            format!("more than {MAX_ITEMS} items"),
        ));
    }
    Ok(())
}

fn enter_container(scan: &mut Scan<'_>, depth: u32) -> Result<u32, CodecError> {
    scan.counters.containers = scan.counters.containers.saturating_add(1);
    if scan.counters.containers > MAX_CONTAINERS {
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Resource,
            format!("more than {MAX_CONTAINERS} containers"),
        ));
    }
    let next = depth.saturating_add(1);
    if next > MAX_DEPTH {
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Resource,
            format!("nesting deeper than {MAX_DEPTH}"),
        ));
    }
    Ok(next)
}

fn scan_item(scan: &mut Scan<'_>, start: usize, depth: u32) -> Result<usize, CodecError> {
    let mut off = start;
    loop {
        let head = read_head(scan.bytes, off, scan.site, CborPass::A)?;
        if head.major == 7 && head.indefinite {
            return Err(err(
                scan.site,
                CborPass::A,
                ErrorCategory::Malformed,
                "stray break code",
            ));
        }
        charge_item(scan)?;
        off += head.size;
        match head.major {
            0 | 1 => return Ok(off),
            2 | 3 => {
                if head.indefinite {
                    return scan_indefinite_string(scan, off, head.major);
                }
                return scan_string(scan, off, head.arg, head.major);
            }
            4 => {
                let nested = enter_container(scan, depth)?;
                if head.indefinite {
                    let mut count = 0usize;
                    loop {
                        if off >= scan.bytes.len() {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Malformed,
                                "truncated indefinite array",
                            ));
                        }
                        if scan.bytes[off] == 0xff {
                            return Ok(off + 1);
                        }
                        count += 1;
                        if count > MAX_ARRAY_ELEMENTS {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Resource,
                                format!("array has more than {MAX_ARRAY_ELEMENTS} elements"),
                            ));
                        }
                        off = scan_item(scan, off, nested)?;
                    }
                }
                if head.arg > MAX_ARRAY_ELEMENTS as u64 {
                    return Err(err(
                        scan.site,
                        CborPass::A,
                        ErrorCategory::Resource,
                        format!("array declares more than {MAX_ARRAY_ELEMENTS} elements"),
                    ));
                }
                let n = head.arg as usize;
                for _ in 0..n {
                    off = scan_item(scan, off, nested)?;
                }
                return Ok(off);
            }
            5 => {
                let nested = enter_container(scan, depth)?;
                if head.indefinite {
                    let mut count = 0usize;
                    loop {
                        if off >= scan.bytes.len() {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Malformed,
                                "truncated indefinite map",
                            ));
                        }
                        if scan.bytes[off] == 0xff {
                            return Ok(off + 1);
                        }
                        count += 1;
                        if count > MAX_MAP_ENTRIES {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Resource,
                                format!("map has more than {MAX_MAP_ENTRIES} entries"),
                            ));
                        }
                        off = scan_item(scan, off, nested)?;
                        if off >= scan.bytes.len() {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Malformed,
                                "truncated map value",
                            ));
                        }
                        if scan.bytes[off] == 0xff {
                            return Err(err(
                                scan.site,
                                CborPass::A,
                                ErrorCategory::Malformed,
                                "break inside a map entry",
                            ));
                        }
                        off = scan_item(scan, off, nested)?;
                    }
                }
                if head.arg > MAX_MAP_ENTRIES as u64 {
                    return Err(err(
                        scan.site,
                        CborPass::A,
                        ErrorCategory::Resource,
                        format!("map declares more than {MAX_MAP_ENTRIES} entries"),
                    ));
                }
                let n = head.arg as usize;
                for _ in 0..n {
                    off = scan_item(scan, off, nested)?;
                    off = scan_item(scan, off, nested)?;
                }
                return Ok(off);
            }
            // A tag head is one item (R1). Pass A does not judge the tag class.
            6 => continue,
            _ => {
                if head.ai == 24 && head.arg < 32 {
                    return Err(err(
                        scan.site,
                        CborPass::A,
                        ErrorCategory::Malformed,
                        "two-byte simple value below 32",
                    ));
                }
                return Ok(off);
            }
        }
    }
}

fn scan_string(scan: &mut Scan<'_>, off: usize, arg: u64, major: u8) -> Result<usize, CodecError> {
    let limit = if major == 2 {
        MAX_BYTE_STRING_BYTES
    } else {
        MAX_TEXT_STRING_BYTES
    };
    // Declared length is judged when the head is read, before the content (pass A).
    if arg > limit as u64 {
        let kind = if major == 2 { "byte" } else { "text" };
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Resource,
            format!("{kind} string longer than {limit}"),
        ));
    }
    let n = arg as usize;
    let end = off.checked_add(n).ok_or_else(|| {
        err(
            scan.site,
            CborPass::A,
            ErrorCategory::Malformed,
            "truncated string content",
        )
    })?;
    if end > scan.bytes.len() {
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Malformed,
            "truncated string content",
        ));
    }
    if major == 3 && std::str::from_utf8(&scan.bytes[off..end]).is_err() {
        return Err(err(
            scan.site,
            CborPass::A,
            ErrorCategory::Malformed,
            "invalid UTF-8",
        ));
    }
    Ok(end)
}

fn scan_indefinite_string(
    scan: &mut Scan<'_>,
    start: usize,
    major: u8,
) -> Result<usize, CodecError> {
    let limit = if major == 2 {
        MAX_BYTE_STRING_BYTES
    } else {
        MAX_TEXT_STRING_BYTES
    } as u64;
    let mut off = start;
    let mut total = 0u64;
    loop {
        if off >= scan.bytes.len() {
            return Err(err(
                scan.site,
                CborPass::A,
                ErrorCategory::Malformed,
                "truncated indefinite string",
            ));
        }
        if scan.bytes[off] == 0xff {
            return Ok(off + 1);
        }
        let head = read_head(scan.bytes, off, scan.site, CborPass::A)?;
        if head.major != major || head.indefinite {
            return Err(err(
                scan.site,
                CborPass::A,
                ErrorCategory::Malformed,
                "indefinite string chunk is not a definite string",
            ));
        }
        off += head.size;
        if head.arg > limit.saturating_sub(total) {
            return Err(err(
                scan.site,
                CborPass::A,
                ErrorCategory::Resource,
                "indefinite string exceeds the string limit",
            ));
        }
        total += head.arg;
        off = scan_string(scan, off, head.arg, major)?;
    }
}

// ---------------------------------------------------------------------------------------------
// Pass B
// ---------------------------------------------------------------------------------------------

fn check_canonical_head(head: &Head, site: &Site) -> Result<(), CodecError> {
    if head.indefinite {
        return Err(err(
            site,
            CborPass::B,
            ErrorCategory::Noncanonical,
            "indefinite-length item (C3)",
        ));
    }
    if !is_minimal(head) {
        return Err(err(
            site,
            CborPass::B,
            ErrorCategory::Noncanonical,
            "non-minimal argument (C2)",
        ));
    }
    Ok(())
}

fn decode_item(bytes: &[u8], start: usize, site: &Site) -> Result<(CborValue, usize), CodecError> {
    let head = read_head(bytes, start, site, CborPass::B)?;
    // Non-minimal and indefinite encodings are reported before a forbidden class.
    // Tag numbers and float widths are not examined (C2, C5).
    if head.major != 6 && head.major != 7 {
        check_canonical_head(&head, site)?;
    }
    let mut off = start + head.size;
    match head.major {
        0 => Ok((CborValue::Int(i128::from(head.arg)), off)),
        1 => Ok((CborValue::Int(-1 - i128::from(head.arg)), off)),
        2 => {
            let n = head.arg as usize;
            let end = off + n;
            Ok((CborValue::Bytes(bytes[off..end].to_vec()), end))
        }
        3 => {
            let n = head.arg as usize;
            let end = off + n;
            let text = std::str::from_utf8(&bytes[off..end])
                .map_err(|_| err(site, CborPass::B, ErrorCategory::Malformed, "invalid UTF-8"))?;
            Ok((CborValue::Text(text.to_string()), end))
        }
        4 => {
            let n = head.arg as usize;
            let mut items = Vec::with_capacity(n);
            for _ in 0..n {
                let (value, next) = decode_item(bytes, off, site)?;
                items.push(value);
                off = next;
            }
            Ok((CborValue::Array(items), off))
        }
        5 => {
            let n = head.arg as usize;
            let mut map = Vec::with_capacity(n);
            let mut prev: Option<u64> = None;
            for _ in 0..n {
                let key_head = read_head(bytes, off, site, CborPass::B)?;
                if key_head.major != 0 {
                    if key_head.major != 6 && key_head.major != 7 {
                        check_canonical_head(&key_head, site)?;
                    }
                    return Err(err(
                        site,
                        CborPass::B,
                        ErrorCategory::Schema,
                        "map key is not an unsigned integer (C1a)",
                    ));
                }
                check_canonical_head(&key_head, site)?;
                let key = key_head.arg;
                if let Some(previous) = prev {
                    if key <= previous {
                        let detail = if key == previous {
                            format!("duplicate map key {key} (C4)")
                        } else {
                            format!("map key {key} out of order (C4)")
                        };
                        return Err(err(site, CborPass::B, ErrorCategory::Noncanonical, detail));
                    }
                }
                prev = Some(key);
                let (value, next) = decode_item(bytes, off + key_head.size, site)?;
                map.push((key, value));
                off = next;
            }
            Ok((CborValue::Map(map), off))
        }
        6 => Err(err(
            site,
            CborPass::B,
            ErrorCategory::Schema,
            "tags are forbidden (C5)",
        )),
        _ => {
            if head.ai == 20 {
                return Ok((CborValue::Bool(false), off));
            }
            if head.ai == 21 {
                return Ok((CborValue::Bool(true), off));
            }
            if head.ai == 22 {
                return Ok((CborValue::Null, off));
            }
            Err(err(
                site,
                CborPass::B,
                ErrorCategory::Schema,
                "float or forbidden simple value (C5)",
            ))
        }
    }
}

pub(crate) fn decode_single_item(
    bytes: &[u8],
    stage: ErrorStage,
    location: &str,
    counters: &mut Counters,
    base_depth: u32,
) -> Result<CborValue, CodecError> {
    let site = Site {
        stage,
        location: location.to_string(),
    };
    let end = {
        let mut scan = Scan {
            bytes,
            counters,
            site: &site,
        };
        scan_item(&mut scan, 0, base_depth)?
    };
    if end != bytes.len() {
        return Err(err(
            &site,
            CborPass::A,
            ErrorCategory::Malformed,
            "extra data after the single CBOR item (C9)",
        ));
    }
    Ok(decode_item(bytes, 0, &site)?.0)
}

/// Decodes exactly one canonical restricted-CBOR item occupying all of `bytes`.
pub fn decode_canonical(bytes: &[u8]) -> Result<CborValue, CodecError> {
    decode_single_item(bytes, ErrorStage::Cbor, "item", &mut Counters::default(), 0)
}

/// True when `bytes` is exactly one valid canonical restricted-CBOR item.
pub fn is_valid_canonical(bytes: &[u8]) -> bool {
    decode_canonical(bytes).is_ok()
}
