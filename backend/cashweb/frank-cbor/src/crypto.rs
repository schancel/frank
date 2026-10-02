//! Stage-10.6 primitives: strict-DER parsing, the low-S rule, and secp256k1 ECDSA
//! verification over a 32-byte digest (S2a, M5; README section 9, stage 10.6).

use secp256k1_abc::{Message, PublicKey, Secp256k1, Signature};

use crate::error::UsageError;

/// Group order `n` of secp256k1, big-endian.
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

fn usage(detail: impl Into<String>) -> UsageError {
    UsageError(detail.into())
}

/// A DER `INTEGER` content: minimal, non-negative, at most 32 significant bytes, and in
/// `1..n-1`. Returns its 32-byte big-endian value.
fn scalar_be(bytes: &[u8]) -> Result<[u8; 32], UsageError> {
    if bytes.is_empty() || bytes.len() > 33 {
        return Err(usage("DER integer length out of range"));
    }
    if bytes[0] & 0x80 != 0 {
        return Err(usage("negative DER integer"));
    }
    if bytes.len() > 1 && bytes[0] == 0 && bytes[1] & 0x80 == 0 {
        return Err(usage("non-minimal DER integer"));
    }
    let mut out = [0u8; 32];
    if bytes.len() == 33 {
        if bytes[0] != 0 {
            return Err(usage("scalar outside 1..n-1"));
        }
        out.copy_from_slice(&bytes[1..]);
    } else {
        out[32 - bytes.len()..].copy_from_slice(bytes);
    }
    if out.as_slice() >= SECP256K1_ORDER.as_slice() {
        return Err(usage("scalar outside 1..n-1"));
    }
    Ok(out)
}

/// The length of one DER element starting at `i`: `(length, offset after the length bytes)`.
fn der_length(der: &[u8], i: usize) -> Result<(usize, usize), UsageError> {
    let first = *der.get(i).ok_or_else(|| usage("truncated DER"))?;
    if first < 0x80 {
        return Ok((usize::from(first), i + 1));
    }
    if first == 0x80 || first > 0x82 {
        return Err(usage("unsupported DER length encoding"));
    }
    let n = usize::from(first - 0x80);
    if i + 1 + n > der.len() {
        return Err(usage("truncated DER length"));
    }
    let mut v = 0usize;
    for b in &der[i + 1..i + 1 + n] {
        v = (v << 8) | usize::from(*b);
    }
    if v < 0x80 {
        return Err(usage("non-minimal DER length"));
    }
    Ok((v, i + 1 + n))
}

/// Strict DER (S2a): `SEQUENCE {r INTEGER, s INTEGER}`, fully consumed, minimal encodings, and
/// both scalars in `1..n-1`. Returns the 32-byte big-endian `(r, s)`.
pub fn parse_strict_der(der: &[u8]) -> Result<([u8; 32], [u8; 32]), UsageError> {
    if der.len() < 8 || der.len() > 72 {
        return Err(usage("DER length outside 8..72"));
    }
    if der[0] != 0x30 {
        return Err(usage("missing SEQUENCE"));
    }
    let (seq_len, after) = der_length(der, 1)?;
    if after + seq_len != der.len() {
        return Err(usage("SEQUENCE length mismatch"));
    }
    if der.get(after) != Some(&0x02) {
        return Err(usage("r is not an INTEGER"));
    }
    let (r_len, r_offset) = der_length(der, after + 1)?;
    if r_offset + r_len > der.len() {
        return Err(usage("truncated r"));
    }
    let r = scalar_be(&der[r_offset..r_offset + r_len])?;
    let s_marker = r_offset + r_len;
    if der.get(s_marker) != Some(&0x02) {
        return Err(usage("s is not an INTEGER"));
    }
    let (s_len, s_offset) = der_length(der, s_marker + 1)?;
    if s_offset + s_len != der.len() {
        return Err(usage("trailing bytes after s"));
    }
    let s = scalar_be(&der[s_offset..s_offset + s_len])?;
    Ok((r, s))
}

/// Low-S (S2a): `s <= n/2`, so every signature has exactly one S-value.
pub fn has_low_s(s: &[u8; 32]) -> bool {
    let mut half = [0u8; 32];
    half[0] = SECP256K1_ORDER[0] >> 1;
    for i in 1..32 {
        half[i] = (SECP256K1_ORDER[i] >> 1) | ((SECP256K1_ORDER[i - 1] & 1) << 7);
    }
    s <= &half
}

/// Verifies one algorithm-1 entry: strict-DER parse, low-S, then ECDSA over the digest with the
/// 33-byte compressed SEC1 signer key. Returns `false` when any step fails; never panics.
pub fn verify_algorithm_1(digest: &[u8; 32], der: &[u8], signer_key: &[u8]) -> bool {
    let (r, s) = match parse_strict_der(der) {
        Ok(pair) => pair,
        Err(_) => return false,
    };
    if !has_low_s(&s) {
        return false;
    }
    let mut compact = [0u8; 64];
    compact[..32].copy_from_slice(&r);
    compact[32..].copy_from_slice(&s);
    let Ok(message) = Message::from_slice(digest) else {
        return false;
    };
    let Ok(signature) = Signature::from_compact(&compact) else {
        return false;
    };
    let Ok(public) = PublicKey::from_slice(signer_key) else {
        return false;
    };
    Secp256k1::verification_only()
        .verify(&message, &signature, &public)
        .is_ok()
}
