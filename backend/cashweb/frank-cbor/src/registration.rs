//! Pure-value mapping of README section 11 (M2, M3, M6): lossless milliseconds, TTL expiry,
//! and the Keccak-256 canonical address. Nothing here touches a frame; the claimed-address
//! comparison is a consumer check that stays out of the codec (M6).

use secp256k1_abc::PublicKey;

use crate::cbor::CborValue;
use crate::error::UsageError;
use crate::frame::{encode_frame, EnvelopeFields, FramePayload};
use crate::keccak::keccak256;
use crate::model::{AccountRef, ProfileEntry, RelayBinding, Timestamp};

const MS: i128 = 1000;
const NANOS_PER_MS: i128 = 1_000_000;

fn usage(detail: impl Into<String>) -> UsageError {
    UsageError(detail.into())
}

/// Splits a total millisecond value into a `timestamp` (M2): `seconds = ms div 1000` rounds
/// toward negative infinity (`div_euclid`) and `nanoseconds` is the non-negative remainder
/// (`rem_euclid`), always a multiple of 1,000,000. Negative totals are encodable timestamps (M3).
pub fn split_timestamp_ms(total_ms: i128) -> Result<Timestamp, UsageError> {
    let seconds = total_ms.div_euclid(MS);
    let nanoseconds = total_ms.rem_euclid(MS) * NANOS_PER_MS;
    let Ok(seconds) = i64::try_from(seconds) else {
        return Err(usage("total milliseconds outside the timestamp range"));
    };
    let Ok(nanoseconds) = u32::try_from(nanoseconds) else {
        return Err(usage("total milliseconds outside the timestamp range"));
    };
    Ok(Timestamp {
        seconds,
        nanoseconds,
    })
}

/// Inverse of [`split_timestamp_ms`]: `ms = seconds * 1000 + nanoseconds div 1000000`.
pub fn join_ms(seconds: i64, nanoseconds: u32) -> Result<i128, UsageError> {
    let nanos = i128::from(nanoseconds);
    if nanos > 999_999_999 || nanos % NANOS_PER_MS != 0 {
        return Err(usage(
            "nanoseconds is outside the timestamp range or not a millisecond multiple: no ms value produced it (M2)",
        ));
    }
    Ok(i128::from(seconds) * MS + nanos / NANOS_PER_MS)
}

/// The registration mapping of M2: `ms` becomes the revision (its exact value, unsigned) and
/// the timestamp. A negative `ms` has no unsigned revision, so the record is unencodable and
/// this fails closed.
pub fn registration_from_ms(ms: i64) -> Result<(u64, Timestamp), UsageError> {
    if ms < 0 {
        return Err(usage(
            "a negative millisecond value has no unsigned revision: unencodable (M2)",
        ));
    }
    Ok((
        u64::try_from(ms).expect("non-negative ms"),
        split_timestamp_ms(i128::from(ms))?,
    ))
}

/// M3: field 6 is `split_ms(ms + ttl)` in a width that cannot overflow (`i128`).
pub fn expiry_timestamp(ms: i64, ttl_ms: i64) -> Result<Timestamp, UsageError> {
    split_timestamp_ms(i128::from(ms) + i128::from(ttl_ms))
}

/// The 65-byte uncompressed SEC1 encoding `04 || X || Y` of a 33-byte compressed key.
pub fn uncompressed_pubkey(compressed: &[u8]) -> Result<[u8; 65], UsageError> {
    if compressed.len() != 33 || (compressed[0] != 0x02 && compressed[0] != 0x03) {
        return Err(usage("expected a 33-byte compressed SEC1 public key"));
    }
    let public =
        PublicKey::from_slice(compressed).map_err(|_| usage("not a valid secp256k1 point"))?;
    Ok(public.serialize_uncompressed())
}

/// The 64-byte `X || Y` Keccak input of M6.
pub fn uncompressed_pubkey_xy(compressed: &[u8]) -> Result<[u8; 64], UsageError> {
    let mut xy = [0u8; 64];
    xy.copy_from_slice(&uncompressed_pubkey(compressed)?[1..]);
    Ok(xy)
}

/// M6: the canonical address is the low 20 bytes of Keccak256 of the 64-byte `X || Y`.
pub fn address_from_uncompressed_pubkey(uncompressed: &[u8]) -> Result<[u8; 20], UsageError> {
    let xy: &[u8] = if uncompressed.len() == 65 && uncompressed[0] == 0x04 {
        &uncompressed[1..]
    } else {
        uncompressed
    };
    if xy.len() != 64 {
        return Err(usage("expected the 64-byte uncompressed X || Y public key"));
    }
    let digest = keccak256(xy);
    let mut address = [0u8; 20];
    address.copy_from_slice(&digest[12..]);
    Ok(address)
}

/// M6 applied to a compressed key: derive the canonical 20-byte address directly.
pub fn address_from_compressed_pubkey(compressed: &[u8]) -> Result<[u8; 20], UsageError> {
    let xy = uncompressed_pubkey_xy(compressed)?;
    address_from_uncompressed_pubkey(&xy)
}

/// Canonical username regex pattern: `^[a-z0-9][a-z0-9_-]{2,31}$`
pub const CANONICAL_USERNAME_PATTERN: &str = "^[a-z0-9][a-z0-9_-]{2,31}$";

/// Validates whether a handle conforms to the canonical username specification (ticket #972):
/// - Length between 3 and 32 characters
/// - Lowercase ASCII alphanumeric with hyphen or underscore
/// - Starts with an alphanumeric character
pub fn is_valid_canonical_username(handle: &str) -> bool {
    let bytes = handle.as_bytes();
    if bytes.len() < 3 || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Parameters for encoding a directory statement (Type 4).
#[derive(Debug, Clone)]
pub struct DirectoryStatementParams<'a> {
    /// Field 0: network tag.
    pub network: &'a str,
    /// Field 1: directory subject public key.
    pub subject: &'a AccountRef,
    /// Field 2: monotonic revision.
    pub revision: u64,
    /// Field 3: authored timestamp.
    pub timestamp: &'a Timestamp,
    /// Field 4: relay bindings.
    pub relays: &'a [RelayBinding],
    /// Field 6: optional expiry timestamp.
    pub expiry: Option<&'a Timestamp>,
    /// Field 7: optional offline recovery authorities.
    pub recovery: Option<&'a [AccountRef]>,
    /// Field 8: optional stamp key.
    pub stamp_key: Option<&'a AccountRef>,
    /// Field 9: optional profile entries.
    pub profile_entries: Option<&'a [ProfileEntry]>,
    /// Field 14: optional canonical username handle.
    pub canonical_username: Option<&'a str>,
}

fn encode_account(acc: &AccountRef) -> CborValue {
    CborValue::Map(vec![
        (0, CborValue::Int(i128::from(acc.key_type))),
        (1, CborValue::Bytes(acc.key_bytes.clone())),
    ])
}

fn encode_timestamp(ts: &Timestamp) -> CborValue {
    CborValue::Map(vec![
        (0, CborValue::Int(i128::from(ts.seconds))),
        (1, CborValue::Int(i128::from(ts.nanoseconds))),
    ])
}

/// Encodes a canonical Type 4 directory statement CBOR payload map.
pub fn encode_directory_statement_payload(
    params: &DirectoryStatementParams<'_>,
) -> Result<CborValue, UsageError> {
    if params.network.is_empty() || params.network.len() > 64 {
        return Err(usage("network must be 1..64 characters"));
    }
    if params.relays.is_empty() {
        return Err(usage("relays must contain at least 1 relay binding"));
    }
    if let Some(username) = params.canonical_username {
        if !is_valid_canonical_username(username) {
            return Err(usage(
                "canonical username must match ^[a-z0-9][a-z0-9_-]{2,31}$",
            ));
        }
    }

    let encoded_relays = params
        .relays
        .iter()
        .map(|r| {
            CborValue::Map(vec![
                (0, CborValue::Bytes(r.relay_id.clone())),
                (1, CborValue::Text(r.endpoint.clone())),
                (2, encode_account(&r.identity)),
                (3, encode_timestamp(&r.expiry)),
            ])
        })
        .collect();

    let mut entries = vec![
        (0, CborValue::Text(params.network.to_string())),
        (1, encode_account(params.subject)),
        (2, CborValue::Int(i128::from(params.revision))),
        (3, encode_timestamp(params.timestamp)),
        (4, CborValue::Array(encoded_relays)),
    ];

    if let Some(exp) = params.expiry {
        entries.push((6, encode_timestamp(exp)));
    }

    if let Some(recovery) = params.recovery {
        if !recovery.is_empty() {
            entries.push((
                7,
                CborValue::Array(recovery.iter().map(encode_account).collect()),
            ));
        }
    }

    if let Some(stamp) = params.stamp_key {
        entries.push((8, encode_account(stamp)));
    }

    if let Some(profiles) = params.profile_entries {
        if !profiles.is_empty() {
            let encoded_profiles = profiles
                .iter()
                .map(|p| {
                    let encoded_headers = p
                        .headers
                        .iter()
                        .map(|h| {
                            CborValue::Map(vec![
                                (0, CborValue::Text(h.name.clone())),
                                (1, CborValue::Text(h.value.clone())),
                            ])
                        })
                        .collect();
                    CborValue::Map(vec![
                        (0, CborValue::Text(p.kind.clone())),
                        (1, CborValue::Array(encoded_headers)),
                        (2, CborValue::Bytes(p.body.clone())),
                    ])
                })
                .collect();
            entries.push((9, CborValue::Array(encoded_profiles)));
        }
    }

    if let Some(username) = params.canonical_username {
        entries.push((14, CborValue::Text(username.to_string())));
    }

    entries.sort_by_key(|(k, _)| *k);

    Ok(CborValue::Map(entries))
}

/// Encodes a complete Type 4 directory statement frame.
pub fn encode_directory_statement(
    schema_version: u32,
    min_reader_version: u32,
    params: &DirectoryStatementParams<'_>,
) -> Result<Vec<u8>, UsageError> {
    let payload = encode_directory_statement_payload(params)?;
    encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version,
            min_reader_version,
        },
        FramePayload::Value(&payload),
    )
}
