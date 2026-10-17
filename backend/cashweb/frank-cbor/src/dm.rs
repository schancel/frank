//! Byte-exact deterministic-CBOR context for production direct-message suite 1.

use crate::cbor::{encode_canonical, CborValue};
use crate::error::UsageError;
use crate::model::AccountRef;

/// Canonical suite-1 context domain.
pub const DM_CRYPTO_CONTEXT_DOMAIN: &str = "frank/dm-crypto-context/v1";
/// Production Frank-CBOR DM suite.
pub const DM_CRYPTO_SUITE: u32 = 1;
/// Recipient-encrypted-payload type.
pub const DM_CRYPTO_TYPE: u32 = 11;
/// Production payload schema and minimum reader version.
pub const DM_CRYPTO_SCHEMA_VERSION: u32 = 2;
/// Production payload minimum reader version.
pub const DM_CRYPTO_MIN_READER_VERSION: u32 = 2;

/// Inputs authenticated by the suite-1 crypto-box envelope.
#[derive(Debug)]
pub struct DirectMessageCryptoContext<'a> {
    /// Canonical network tag.
    pub network: &'a str,
    /// Outer routing sender identity (absent when sealed-sender is used).
    pub sender: Option<&'a AccountRef>,
    /// Outer routing recipient identity.
    pub recipient: &'a AccountRef,
    /// T1 hash of the exact opened sender directory statement (absent when sealed-sender is used).
    pub sender_directory_hash: Option<&'a [u8]>,
    /// T1 hash of the exact opened recipient directory statement.
    pub recipient_directory_hash: &'a [u8],
    /// Sender message-DH account reference (absent when sealed-sender is used).
    pub sender_message_key: Option<&'a AccountRef>,
    /// Recipient message-DH account reference.
    pub recipient_message_key: &'a AccountRef,
    /// Recipient stamp-key account reference.
    pub stamp_key: &'a AccountRef,
    /// Fresh stamp point `E`.
    pub ephemeral_point: &'a [u8],
    /// Shared stamp point `X`.
    pub shared_point: &'a [u8],
    /// DLEQ proof `c || s`.
    pub dleq_proof: &'a [u8],
}

fn exact(bytes: &[u8], length: usize, name: &str) -> Result<CborValue, UsageError> {
    if bytes.len() != length {
        return Err(UsageError(format!(
            "{name} must contain exactly {length} bytes"
        )));
    }
    Ok(CborValue::Bytes(bytes.to_vec()))
}

fn account(value: &AccountRef, name: &str, secp_only: bool) -> Result<CborValue, UsageError> {
    if secp_only
        && (value.key_type != 1
            || value.key_bytes.len() != 33
            || secp256k1_abc::PublicKey::from_slice(&value.key_bytes).is_err())
    {
        return Err(UsageError(format!(
            "{name} must be a compressed secp256k1 account"
        )));
    }
    Ok(CborValue::Map(vec![
        (0, CborValue::Int(i128::from(value.key_type))),
        (1, CborValue::Bytes(value.key_bytes.clone())),
    ]))
}

fn point(bytes: &[u8], name: &str) -> Result<CborValue, UsageError> {
    if bytes.len() != 33 || secp256k1_abc::PublicKey::from_slice(bytes).is_err() {
        return Err(UsageError(format!(
            "{name} must be a compressed secp256k1 point"
        )));
    }
    Ok(CborValue::Bytes(bytes.to_vec()))
}

const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

fn proof(bytes: &[u8]) -> Result<CborValue, UsageError> {
    if bytes.len() != 64
        || bytes.chunks_exact(32).any(|scalar| {
            scalar.iter().all(|byte| *byte == 0) || scalar >= SECP256K1_ORDER.as_slice()
        })
    {
        return Err(UsageError(
            "dleq_proof must contain two scalars in 1..n-1".into(),
        ));
    }
    Ok(CborValue::Bytes(bytes.to_vec()))
}

/// Encodes the exact context passed to both crypto-box seal and open.
pub fn encode_direct_message_crypto_context(
    input: &DirectMessageCryptoContext<'_>,
) -> Result<Vec<u8>, UsageError> {
    if input.network.is_empty() {
        return Err(UsageError("network must be a non-empty string".into()));
    }
    if input.sender.is_some() != input.sender_directory_hash.is_some()
        || input.sender.is_some() != input.sender_message_key.is_some()
    {
        return Err(UsageError(
            "sender, sender_directory_hash, and sender_message_key must be all present or all absent".into(),
        ));
    }
    let mut entries = Vec::with_capacity(16);
    entries.push((0, CborValue::Text(DM_CRYPTO_CONTEXT_DOMAIN.into())));
    entries.push((1, CborValue::Text(input.network.into())));
    if let Some(sender) = input.sender {
        entries.push((2, account(sender, "sender", false)?));
    }
    entries.push((3, account(input.recipient, "recipient", false)?));
    if let Some(sender_directory_hash) = input.sender_directory_hash {
        entries.push((
            4,
            exact(sender_directory_hash, 32, "sender_directory_hash")?,
        ));
    }
    entries.push((
        5,
        exact(
            input.recipient_directory_hash,
            32,
            "recipient_directory_hash",
        )?,
    ));
    if let Some(sender_message_key) = input.sender_message_key {
        entries.push((6, account(sender_message_key, "sender_message_key", true)?));
    }
    entries.push((
        7,
        account(input.recipient_message_key, "recipient_message_key", true)?,
    ));
    entries.push((8, account(input.stamp_key, "stamp_key", true)?));
    entries.push((9, point(input.ephemeral_point, "ephemeral_point")?));
    entries.push((10, point(input.shared_point, "shared_point")?));
    entries.push((11, proof(input.dleq_proof)?));
    entries.push((12, CborValue::Int(i128::from(DM_CRYPTO_SUITE))));
    entries.push((13, CborValue::Int(i128::from(DM_CRYPTO_TYPE))));
    entries.push((14, CborValue::Int(i128::from(DM_CRYPTO_SCHEMA_VERSION))));
    entries.push((15, CborValue::Int(i128::from(DM_CRYPTO_MIN_READER_VERSION))));
    encode_canonical(&CborValue::Map(entries))
}
