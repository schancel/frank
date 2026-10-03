//! Byte-exact deterministic-CBOR context for production direct-message suite 1.

use crate::cbor::{encode_canonical, CborValue};
use crate::error::UsageError;
use crate::model::AccountRef;

/// Canonical suite-1 context domain.
pub const DM_CRYPTO_CONTEXT_DOMAIN: &str = "frank/dm-crypto-context/v1";
/// Production Frank-CBOR DM suite.
pub const DM_CRYPTO_SUITE: u32 = 1;
/// Recipient-encrypted-payload type.
pub const DM_CRYPTO_TYPE: u32 = 5;
/// Production payload schema and minimum reader version.
pub const DM_CRYPTO_SCHEMA_VERSION: u32 = 2;
/// Production payload minimum reader version.
pub const DM_CRYPTO_MIN_READER_VERSION: u32 = 2;

/// Inputs authenticated by the suite-1 crypto-box envelope.
#[derive(Debug)]
pub struct DirectMessageCryptoContext<'a> {
    /// Canonical network tag.
    pub network: &'a str,
    /// Outer routing sender identity.
    pub sender: &'a AccountRef,
    /// Outer routing recipient identity.
    pub recipient: &'a AccountRef,
    /// T1 hash of the exact opened sender directory statement.
    pub sender_directory_hash: &'a [u8],
    /// T1 hash of the exact opened recipient directory statement.
    pub recipient_directory_hash: &'a [u8],
    /// Sender message-DH account reference.
    pub sender_message_key: &'a AccountRef,
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
    if secp_only && (value.key_type != 1 || value.key_bytes.len() != 33) {
        return Err(UsageError(format!(
            "{name} must be a compressed secp256k1 account"
        )));
    }
    Ok(CborValue::Map(vec![
        (0, CborValue::Int(i128::from(value.key_type))),
        (1, CborValue::Bytes(value.key_bytes.clone())),
    ]))
}

/// Encodes the exact context passed to both crypto-box seal and open.
pub fn encode_direct_message_crypto_context(
    input: &DirectMessageCryptoContext<'_>,
) -> Result<Vec<u8>, UsageError> {
    if input.network.is_empty() {
        return Err(UsageError("network must be a non-empty string".into()));
    }
    encode_canonical(&CborValue::Map(vec![
        (0, CborValue::Text(DM_CRYPTO_CONTEXT_DOMAIN.into())),
        (1, CborValue::Text(input.network.into())),
        (2, account(input.sender, "sender", false)?),
        (3, account(input.recipient, "recipient", false)?),
        (
            4,
            exact(input.sender_directory_hash, 32, "sender_directory_hash")?,
        ),
        (
            5,
            exact(
                input.recipient_directory_hash,
                32,
                "recipient_directory_hash",
            )?,
        ),
        (
            6,
            account(input.sender_message_key, "sender_message_key", true)?,
        ),
        (
            7,
            account(input.recipient_message_key, "recipient_message_key", true)?,
        ),
        (8, account(input.stamp_key, "stamp_key", true)?),
        (9, exact(input.ephemeral_point, 33, "ephemeral_point")?),
        (10, exact(input.shared_point, 33, "shared_point")?),
        (11, exact(input.dleq_proof, 64, "dleq_proof")?),
        (12, CborValue::Int(i128::from(DM_CRYPTO_SUITE))),
        (13, CborValue::Int(i128::from(DM_CRYPTO_TYPE))),
        (14, CborValue::Int(i128::from(DM_CRYPTO_SCHEMA_VERSION))),
        (15, CborValue::Int(i128::from(DM_CRYPTO_MIN_READER_VERSION))),
    ]))
}
