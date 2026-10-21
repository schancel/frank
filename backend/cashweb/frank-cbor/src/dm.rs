//! Byte-exact deterministic-CBOR context for production direct-message suite 1.

use crate::cbor::{encode_canonical, CborValue};
use crate::error::UsageError;
use crate::limits::ENCRYPTION_SUITE_DM_AUTH_XCHACHA;
use crate::message_fields::{account_ref, dm_crypto_context_v1 as k, key_type};
use crate::message_types::TYPE_RECIPIENT_ENCRYPTED_PAYLOAD;
use crate::model::AccountRef;

/// Canonical suite-1 context domain.
pub const DM_CRYPTO_CONTEXT_DOMAIN: &str = "frank/dm-crypto-context/v1";
/// Production Frank-CBOR DM suite.
pub const DM_CRYPTO_SUITE: u32 = ENCRYPTION_SUITE_DM_AUTH_XCHACHA;
/// Recipient-encrypted-payload type.
pub const DM_CRYPTO_TYPE: u32 = TYPE_RECIPIENT_ENCRYPTED_PAYLOAD;
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
    if secp_only
        && (value.key_type != key_type::SECP256K1
            || value.key_bytes.len() != 33
            || secp256k1_abc::PublicKey::from_slice(&value.key_bytes).is_err())
    {
        return Err(UsageError(format!(
            "{name} must be a compressed secp256k1 account"
        )));
    }
    Ok(CborValue::Map(vec![
        (
            account_ref::KEY_TYPE,
            CborValue::Int(i128::from(value.key_type)),
        ),
        (
            account_ref::KEY_BYTES,
            CborValue::Bytes(value.key_bytes.clone()),
        ),
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
    encode_canonical(&CborValue::Map(vec![
        (k::DOMAIN, CborValue::Text(DM_CRYPTO_CONTEXT_DOMAIN.into())),
        (k::NETWORK, CborValue::Text(input.network.into())),
        (k::SENDER, account(input.sender, "sender", false)?),
        (k::RECIPIENT, account(input.recipient, "recipient", false)?),
        (
            k::SENDER_STATEMENT_HASH,
            exact(input.sender_directory_hash, 32, "sender_directory_hash")?,
        ),
        (
            k::RECIPIENT_STATEMENT_HASH,
            exact(
                input.recipient_directory_hash,
                32,
                "recipient_directory_hash",
            )?,
        ),
        (
            k::SENDER_MESSAGE_KEY,
            account(input.sender_message_key, "sender_message_key", true)?,
        ),
        (
            k::RECIPIENT_MESSAGE_KEY,
            account(input.recipient_message_key, "recipient_message_key", true)?,
        ),
        (
            k::RECIPIENT_STAMP_KEY,
            account(input.stamp_key, "stamp_key", true)?,
        ),
        (
            k::EPHEMERAL_POINT,
            point(input.ephemeral_point, "ephemeral_point")?,
        ),
        (k::SHARED_POINT, point(input.shared_point, "shared_point")?),
        (k::DLEQ_PROOF, proof(input.dleq_proof)?),
        (k::SUITE, CborValue::Int(i128::from(DM_CRYPTO_SUITE))),
        (k::OBJECT_TYPE, CborValue::Int(i128::from(DM_CRYPTO_TYPE))),
        (
            k::SCHEMA_VERSION,
            CborValue::Int(i128::from(DM_CRYPTO_SCHEMA_VERSION)),
        ),
        (
            k::MIN_READER_VERSION,
            CborValue::Int(i128::from(DM_CRYPTO_MIN_READER_VERSION)),
        ),
    ]))
}
