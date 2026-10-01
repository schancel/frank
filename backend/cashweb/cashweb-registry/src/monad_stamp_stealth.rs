//! Recipient-controlled one-time EVM destinations for direct-message stamp payments.
//!
//! This is Stamp's original public/private derivation with EVM address encoding. The payload hash
//! tweaks the recipient identity key and is also the root BIP32 chain code. Both sides then derive
//! the non-hardened `m/44/145/payment_index/0` child. A sender or relay can derive the destination
//! from the registered recipient public key, while only the recipient can derive its private key.

use hmac::{Hmac, Mac};
use secp256k1_abc::{All, PublicKey, Secp256k1, SecretKey};
use sha2::Sha512;
use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::monad_http::Address;

const HARDENED_CHILD: u32 = 1 << 31;
const STAMP_PATH_PREFIX: [u32; 2] = [44, 145];

type HmacSha512 = Hmac<Sha512>;

/// Errors raised when a stamp-payment child cannot be derived canonically.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum StampStealthError {
    /// The payload digest is not a valid non-zero secp256k1 scalar.
    #[error("payload hash is not a valid secp256k1 scalar")]
    InvalidPayloadScalar,
    /// The registered recipient public key is malformed.
    #[error("recipient public key is invalid")]
    InvalidRecipientPublicKey,
    /// The recipient private key is malformed.
    #[error("recipient private key is invalid")]
    InvalidRecipientPrivateKey,
    /// Hardened indices cannot be derived from the public key available to the relay.
    #[error("payment index must be a non-hardened uint31")]
    InvalidPaymentIndex,
    /// BIP32 produced an invalid child tweak or the point at infinity.
    #[error("BIP32 child derivation produced an invalid key")]
    InvalidChild,
}

/// A canonical one-time stamp-payment destination.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonadStampChild {
    /// The non-hardened payment index represented by the third path component.
    pub payment_index: u32,
    /// The derived compressed secp256k1 public key.
    pub public_key: [u8; 33],
    /// The final 20 bytes of Keccak256(uncompressed public key without its `0x04` prefix).
    pub address: [u8; 20],
}

/// A recipient's spendable form of a canonical one-time stamp-payment destination.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MonadStampPrivateChild {
    /// Public destination information shared with the watch-only derivation.
    pub destination: MonadStampChild,
    /// The derived private key controlling the destination.
    pub private_key: [u8; 32],
}

fn evm_address(public_key: &PublicKey) -> [u8; 20] {
    let uncompressed = public_key.serialize_uncompressed();
    let digest = Keccak256::digest(&uncompressed[1..]);
    let mut address = [0; 20];
    address.copy_from_slice(&digest[12..]);
    address
}

/// Derive the normalized Monad address that owns a compressed recipient public key.
pub(crate) fn recipient_address_from_public_key(
    recipient_public_key: &[u8],
) -> Result<Address, StampStealthError> {
    if recipient_public_key.len() != 33 {
        return Err(StampStealthError::InvalidRecipientPublicKey);
    }
    let public_key = PublicKey::from_slice(recipient_public_key)
        .map_err(|_| StampStealthError::InvalidRecipientPublicKey)?;
    Ok(Address(evm_address(&public_key)))
}

fn child_tweak(public_key: &PublicKey, chain_code: &[u8; 32], index: u32) -> ([u8; 32], [u8; 32]) {
    let mut mac = HmacSha512::new_from_slice(chain_code).expect("HMAC accepts any key length");
    mac.update(&public_key.serialize());
    mac.update(&index.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let mut tweak = [0; 32];
    let mut child_chain_code = [0; 32];
    tweak.copy_from_slice(&digest[..32]);
    child_chain_code.copy_from_slice(&digest[32..]);
    (tweak, child_chain_code)
}

fn derive_public_step(
    secp: &Secp256k1<All>,
    public_key: &mut PublicKey,
    chain_code: &mut [u8; 32],
    index: u32,
) -> Result<(), StampStealthError> {
    let (tweak, next_chain_code) = child_tweak(public_key, chain_code, index);
    SecretKey::from_slice(&tweak).map_err(|_| StampStealthError::InvalidChild)?;
    public_key
        .add_exp_assign(secp, &tweak)
        .map_err(|_| StampStealthError::InvalidChild)?;
    *chain_code = next_chain_code;
    Ok(())
}

fn derive_private_step(
    secp: &Secp256k1<All>,
    private_key: &mut SecretKey,
    chain_code: &mut [u8; 32],
    index: u32,
) -> Result<(), StampStealthError> {
    let public_key = PublicKey::from_secret_key(secp, private_key);
    let (tweak, next_chain_code) = child_tweak(&public_key, chain_code, index);
    SecretKey::from_slice(&tweak).map_err(|_| StampStealthError::InvalidChild)?;
    private_key
        .add_assign(&tweak)
        .map_err(|_| StampStealthError::InvalidChild)?;
    *chain_code = next_chain_code;
    Ok(())
}

/// Derive a stamp-payment child from a registered recipient public key.
pub fn derive_monad_stamp_child_public(
    payload_hash: [u8; 32],
    recipient_public_key: &[u8],
    payment_index: u32,
) -> Result<MonadStampChild, StampStealthError> {
    if payment_index >= HARDENED_CHILD {
        return Err(StampStealthError::InvalidPaymentIndex);
    }
    SecretKey::from_slice(&payload_hash).map_err(|_| StampStealthError::InvalidPayloadScalar)?;
    let secp = Secp256k1::new();
    let mut public_key = PublicKey::from_slice(recipient_public_key)
        .map_err(|_| StampStealthError::InvalidRecipientPublicKey)?;
    public_key
        .add_exp_assign(&secp, &payload_hash)
        .map_err(|_| StampStealthError::InvalidPayloadScalar)?;
    let mut chain_code = payload_hash;
    for index in [STAMP_PATH_PREFIX[0], STAMP_PATH_PREFIX[1], payment_index, 0] {
        derive_public_step(&secp, &mut public_key, &mut chain_code, index)?;
    }
    Ok(MonadStampChild {
        payment_index,
        public_key: public_key.serialize(),
        address: evm_address(&public_key),
    })
}

/// Derive the private key with which the recipient can spend a stamp-payment child.
pub fn derive_monad_stamp_child_private(
    payload_hash: [u8; 32],
    recipient_private_key: [u8; 32],
    payment_index: u32,
) -> Result<MonadStampPrivateChild, StampStealthError> {
    if payment_index >= HARDENED_CHILD {
        return Err(StampStealthError::InvalidPaymentIndex);
    }
    SecretKey::from_slice(&payload_hash).map_err(|_| StampStealthError::InvalidPayloadScalar)?;
    let secp = Secp256k1::new();
    let mut private_key = SecretKey::from_slice(&recipient_private_key)
        .map_err(|_| StampStealthError::InvalidRecipientPrivateKey)?;
    private_key
        .add_assign(&payload_hash)
        .map_err(|_| StampStealthError::InvalidPayloadScalar)?;
    let mut chain_code = payload_hash;
    for index in [STAMP_PATH_PREFIX[0], STAMP_PATH_PREFIX[1], payment_index, 0] {
        derive_private_step(&secp, &mut private_key, &mut chain_code, index)?;
    }
    let public_key = PublicKey::from_secret_key(&secp, &private_key);
    Ok(MonadStampPrivateChild {
        destination: MonadStampChild {
            payment_index,
            public_key: public_key.serialize(),
            address: evm_address(&public_key),
        },
        private_key: private_key[..]
            .try_into()
            .expect("secret keys are 32 bytes"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECIPIENT_PRIVATE_KEY: [u8; 32] =
        hex_literal::hex!("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const PAYLOAD_HASH: [u8; 32] =
        hex_literal::hex!("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");

    #[test]
    fn public_and_private_derivations_match_typescript_vectors() {
        let secp = Secp256k1::new();
        let recipient_private_key = SecretKey::from_slice(&RECIPIENT_PRIVATE_KEY).unwrap();
        let recipient_public_key =
            PublicKey::from_secret_key(&secp, &recipient_private_key).serialize();
        let vectors = [
            (
                0,
                hex_literal::hex!(
                    "ff9f20d1734c9e6ec79d5157eb51e0c53c4f75f029e80a255b142d31d2d365f3"
                ),
                hex_literal::hex!(
                    "038eb8a3da7c063c49de5db6471a10a969f5ed136dab82c96b082b2d05c3a5ff82"
                ),
                hex_literal::hex!("f565a34f04f2782d2c2cf0e55470f229444504cc"),
            ),
            (
                1,
                hex_literal::hex!(
                    "2f18e095baaa27815848005066151b42dde518a84fe524b324ee307ef1779306"
                ),
                hex_literal::hex!(
                    "0323b73e006a84ec716b1e6144fcece5ca2e52cc5d0880aaf499d9b0f4a9e376f2"
                ),
                hex_literal::hex!("b3cadc6aa46f0228b589646e891c29017a521c48"),
            ),
        ];

        for (payment_index, expected_private, expected_public, expected_address) in vectors {
            let from_public =
                derive_monad_stamp_child_public(PAYLOAD_HASH, &recipient_public_key, payment_index)
                    .unwrap();
            let from_private = derive_monad_stamp_child_private(
                PAYLOAD_HASH,
                RECIPIENT_PRIVATE_KEY,
                payment_index,
            )
            .unwrap();
            assert_eq!(from_public, from_private.destination);
            assert_eq!(from_private.private_key, expected_private);
            assert_eq!(from_public.public_key, expected_public);
            assert_eq!(from_public.address, expected_address);
        }
    }

    #[test]
    fn rejects_invalid_scalars_keys_and_hardened_indices() {
        assert_eq!(
            derive_monad_stamp_child_public([0; 32], &[2; 33], 0),
            Err(StampStealthError::InvalidPayloadScalar),
        );
        assert_eq!(
            derive_monad_stamp_child_public(PAYLOAD_HASH, &[0; 33], 0),
            Err(StampStealthError::InvalidRecipientPublicKey),
        );
        assert_eq!(
            derive_monad_stamp_child_private(PAYLOAD_HASH, [0; 32], 0),
            Err(StampStealthError::InvalidRecipientPrivateKey),
        );
        assert_eq!(
            derive_monad_stamp_child_private(PAYLOAD_HASH, RECIPIENT_PRIVATE_KEY, HARDENED_CHILD),
            Err(StampStealthError::InvalidPaymentIndex),
        );
    }
}
