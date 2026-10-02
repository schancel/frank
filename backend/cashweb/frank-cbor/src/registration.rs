//! Pure-value mapping of README section 11 (M2, M3, M6): lossless milliseconds, TTL expiry,
//! and the Keccak-256 canonical address. Nothing here touches a frame; the claimed-address
//! comparison is a consumer check that stays out of the codec (M6).

use secp256k1_abc::PublicKey;

use crate::error::UsageError;
use crate::keccak::keccak256;
use crate::model::Timestamp;

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
