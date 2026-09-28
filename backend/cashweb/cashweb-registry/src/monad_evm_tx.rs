//! Recover the sender of a raw, signed Monad (EVM-style) transaction, Ethereum's `ecrecover`
//! convention, without requiring a separate app-level signature (ticket #27; see PLAN.md
//! constraint 5 and `crate::monad_stamp_verify`'s module docs for why this exists).
//!
//! ## Scope
//!
//! This module only decodes as much of a raw transaction as is needed to reconstruct its signing
//! preimage and pull out its `(v, r, s)` (or `(yParity, r, s)`) signature components -- it doesn't
//! decode `to`/`value`/`input` (those are read back from the chain, post-confirmation, by
//! [`crate::monad_stamp_verify::verify_stamp_transaction`] instead, via
//! [`crate::monad_http::MonadHttpClient::get_transaction_by_hash`]).
//!
//! Two transaction shapes are supported, covering the overwhelming majority of what any modern
//! EVM wallet produces:
//! - **Legacy** (`raw_tx[0] >= 0xc0`, a bare RLP list of 9 items: `[nonce, gasPrice, gasLimit, to,
//!   value, data, v, r, s]`), both pre-[EIP-155] (`v = 27/28`) and post-[EIP-155] (`v = {0,1} + 35
//!   + 2 * chainId`, which folds the chain ID into the signing preimage to prevent cross-chain
//!   replay).
//! - **[EIP-1559]** (`raw_tx[0] == 0x02`, an [EIP-2718] typed transaction: the type byte followed
//!   by an RLP list of 12 items: `[chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
//!   to, value, data, accessList, yParity, r, s]`).
//!
//! [EIP-2930] (type `0x01`) transactions are deliberately **not** supported -- they're rare in
//! practice (wallets default to legacy or EIP-1559) and adding a third preimage-reconstruction
//! branch for a hackathon-scope ticket wasn't judged worth it. [`EvmTxError::UnsupportedTxType`]
//! is returned for any other type byte, so this is a clear rejection rather than a silent
//! misparse.
//!
//! ## Why no new elliptic-curve crate
//!
//! Ethereum's `ecrecover` is exactly the same secp256k1 ECDSA recovery math Lotus/Bitcoin already
//! use -- the only two things that differ are (1) the message digest is Keccak256, not SHA256,
//! and (2) the resulting address is derived from the recovered public key differently (see
//! [`address_from_uncompressed_pubkey`]). Both of those are handled here with plain hashing code;
//! the actual point-recovery step reuses
//! [`bitcoinsuite_ecc_secp256k1::EccSecp256k1::recover_sig`], which already exists in this
//! codebase (used by Lotus's `sign_recoverable`/`recover_sig` round trip) -- so unlike the RLP
//! decoder and the Keccak256 hasher (see `Cargo.toml`'s comments on `rlp`/`sha3`), no `k256` (or
//! similar) dependency was needed just to recover the point itself.
//!
//! [EIP-155]: https://eips.ethereum.org/EIPS/eip-155
//! [EIP-1559]: https://eips.ethereum.org/EIPS/eip-1559
//! [EIP-2718]: https://eips.ethereum.org/EIPS/eip-2718
//! [EIP-2930]: https://eips.ethereum.org/EIPS/eip-2930

use bitcoinsuite_core::ecc::Ecc;
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use rlp::{Rlp, RlpStream};
use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::monad_http::Address;

/// [EIP-2718] transaction-type byte for an EIP-1559 transaction.
const EIP1559_TYPE: u8 = 0x02;

/// Errors recovering a transaction's sender via [`recover_sender`].
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EvmTxError {
    /// `raw_tx` was empty.
    #[error("raw transaction is empty")]
    Empty,
    /// The leading type byte wasn't a recognized legacy (`>= 0xc0`) or EIP-1559 (`0x02`) marker.
    #[error(
        "unsupported transaction type byte {0:#04x}: only legacy and EIP-1559 (0x02) \
         transactions are supported"
    )]
    UnsupportedTxType(u8),
    /// RLP decoding failed outright.
    #[error("failed to RLP-decode transaction: {0}")]
    Rlp(String),
    /// A legacy transaction's top-level RLP list didn't have exactly 9 items.
    #[error("legacy transaction RLP list has {0} items, expected 9")]
    WrongLegacyItemCount(usize),
    /// An EIP-1559 transaction's RLP list (after the type byte) didn't have exactly 12 items.
    #[error("EIP-1559 transaction RLP list has {0} items, expected 12")]
    WrongEip1559ItemCount(usize),
    /// A legacy transaction's `v` value wasn't a recognized pre- or post-EIP-155 encoding.
    #[error("unrecognized legacy transaction `v` value: {0}")]
    InvalidLegacyV(u64),
    /// A decoded `r`/`s` signature component was longer than the 32 bytes it can validly be.
    #[error("signature r/s component too long: r={r_len} bytes, s={s_len} bytes (max 32 each)")]
    SignatureComponentTooLong {
        /// Length of the decoded `r` component, in bytes.
        r_len: usize,
        /// Length of the decoded `s` component, in bytes.
        s_len: usize,
    },
    /// Transaction `to` was neither empty (contract creation) nor a 20-byte EVM address.
    #[error("transaction recipient has {0} bytes, expected 20")]
    InvalidRecipientLength(usize),
    /// Transaction value exceeded the relay's `u128` accounting range.
    #[error("transaction value has {0} bytes, exceeds u128")]
    ValueTooLarge(usize),
    /// `EccSecp256k1::recover_sig` couldn't recover a public key from the given signature/digest
    /// (e.g. a structurally-invalid signature, or a recovery id inconsistent with the actual
    /// signature).
    #[error("ECDSA sender recovery failed: {0}")]
    RecoveryFailed(String),
}

impl From<rlp::DecoderError> for EvmTxError {
    fn from(err: rlp::DecoderError) -> Self {
        EvmTxError::Rlp(err.to_string())
    }
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Ethereum address derivation: the low 20 bytes of `Keccak256` of the recovered public key's
/// uncompressed, un-prefixed `X || Y` coordinates (i.e. dropping the leading `0x04` byte
/// [`bitcoinsuite_ecc_secp256k1::EccSecp256k1::serialize_pubkey_uncompressed`] produces) -- quite
/// unlike Lotus, which hashes the *compressed* pubkey with `SHA256`+`RIPEMD160`
/// ([`bitcoinsuite_core::pubkeyhash`]-style).
///
/// `pub(crate)` (rather than private) since [`crate::monad_profile_verify`] (ticket #45) reuses
/// this exact derivation to check a profile registration's signing pubkey matches its claimed
/// `:addr` -- the same Ethereum address convention, just starting from an explicitly-provided
/// pubkey instead of one recovered via [`recover_sender`]'s `ecrecover`.
pub(crate) fn address_from_uncompressed_pubkey(uncompressed: &[u8; 65]) -> Address {
    let hash = keccak256(&uncompressed[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    Address(addr)
}

/// Left-pad `bytes` (an RLP-decoded big-endian unsigned integer, which RLP always encodes with no
/// leading zero bytes) out to a fixed-size 32-byte array, as required for
/// [`EccSecp256k1::recover_sig`]'s 64-byte compact `r || s` signature input.
fn left_pad_32(bytes: &[u8]) -> Result<[u8; 32], EvmTxError> {
    if bytes.len() > 32 {
        return Err(EvmTxError::SignatureComponentTooLong {
            r_len: bytes.len(),
            s_len: 0,
        });
    }
    let mut padded = [0u8; 32];
    padded[32 - bytes.len()..].copy_from_slice(bytes);
    Ok(padded)
}

/// The pieces [`decode_legacy`]/[`decode_eip1559`] extract: the exact bytes that get Keccak256'd
/// to produce the signing digest, plus the decoded `(recovery_id, r, s)`.
struct SigningMaterial {
    preimage: Vec<u8>,
    recovery_id: i32,
    r: [u8; 32],
    s: [u8; 32],
}

/// Relay-relevant facts decoded directly from a signed raw transaction before broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedSignedTransaction {
    /// Keccak256 hash of the signed raw bytes.
    pub tx_hash: crate::monad_http::Hash32,
    /// ECDSA-recovered disposable funding account.
    pub sender: Address,
    /// Signed `to` field (`None` for contract creation).
    pub destination: Option<Address>,
    /// Signed native value.
    pub value_wei: u128,
    /// Signed calldata bytes.
    pub input: Vec<u8>,
}

fn decode_transaction_fields(
    raw_tx: &[u8],
) -> Result<(Option<Address>, u128, Vec<u8>), EvmTxError> {
    let first_byte = *raw_tx.first().ok_or(EvmTxError::Empty)?;
    let (rlp, to_index, value_index, input_index) = if first_byte == EIP1559_TYPE {
        (Rlp::new(&raw_tx[1..]), 5, 6, 7)
    } else if first_byte >= 0xc0 {
        (Rlp::new(raw_tx), 3, 4, 5)
    } else {
        return Err(EvmTxError::UnsupportedTxType(first_byte));
    };
    let to_bytes = rlp.at(to_index)?.data()?.to_vec();
    let destination = if to_bytes.is_empty() {
        None
    } else {
        let actual = to_bytes.len();
        let bytes: [u8; 20] = to_bytes
            .try_into()
            .map_err(|_| EvmTxError::InvalidRecipientLength(actual))?;
        Some(Address(bytes))
    };
    let value_bytes = rlp.at(value_index)?.data()?;
    if value_bytes.len() > 16 {
        return Err(EvmTxError::ValueTooLarge(value_bytes.len()));
    }
    let value_wei = value_bytes
        .iter()
        .fold(0u128, |value, byte| (value << 8) | u128::from(*byte));
    Ok((
        destination,
        value_wei,
        rlp.at(input_index)?.data()?.to_vec(),
    ))
}

fn decode_r_s(
    rlp: &Rlp<'_>,
    r_index: usize,
    s_index: usize,
) -> Result<([u8; 32], [u8; 32]), EvmTxError> {
    let r_bytes: Vec<u8> = rlp.at(r_index)?.as_val()?;
    let s_bytes: Vec<u8> = rlp.at(s_index)?.as_val()?;
    if r_bytes.len() > 32 || s_bytes.len() > 32 {
        return Err(EvmTxError::SignatureComponentTooLong {
            r_len: r_bytes.len(),
            s_len: s_bytes.len(),
        });
    }
    Ok((left_pad_32(&r_bytes)?, left_pad_32(&s_bytes)?))
}

/// Decode a legacy (pre-[EIP-2718]) transaction: a bare RLP list of 9 items, `[nonce, gasPrice,
/// gasLimit, to, value, data, v, r, s]`.
///
/// [EIP-2718]: https://eips.ethereum.org/EIPS/eip-2718
fn decode_legacy(raw_tx: &[u8]) -> Result<SigningMaterial, EvmTxError> {
    let rlp = Rlp::new(raw_tx);
    let item_count = rlp.item_count()?;
    if item_count != 9 {
        return Err(EvmTxError::WrongLegacyItemCount(item_count));
    }

    let v: u64 = rlp.at(6)?.as_val()?;
    let (r, s) = decode_r_s(&rlp, 7, 8)?;

    // Pre-EIP-155: `v` is 27 or 28, and the preimage is just the first 6 fields.
    // Post-EIP-155 (https://eips.ethereum.org/EIPS/eip-155): `v = {0,1} + 35 + 2 * chainId`, and
    // the preimage additionally folds in `[chainId, 0, 0]` to bind the signature to one chain.
    let (recovery_id, chain_id) = if v == 27 || v == 28 {
        ((v - 27) as i32, None)
    } else if v >= 35 {
        (((v - 35) & 1) as i32, Some((v - 35) >> 1))
    } else {
        return Err(EvmTxError::InvalidLegacyV(v));
    };

    let mut stream = RlpStream::new();
    match chain_id {
        None => {
            stream.begin_list(6);
            for i in 0..6 {
                stream.append_raw(rlp.at(i)?.as_raw(), 1);
            }
        }
        Some(chain_id) => {
            stream.begin_list(9);
            for i in 0..6 {
                stream.append_raw(rlp.at(i)?.as_raw(), 1);
            }
            stream.append(&chain_id);
            // RLP's canonical encoding of the integer 0 is a single `0x80` (empty string), the
            // same as EIP-155 requires for the two placeholder fields.
            stream.append_raw(&[0x80], 1);
            stream.append_raw(&[0x80], 1);
        }
    }

    Ok(SigningMaterial {
        preimage: stream.out().to_vec(),
        recovery_id,
        r,
        s,
    })
}

/// Decode an [EIP-1559] transaction: type byte `0x02` followed by an RLP list of 12 items,
/// `[chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList,
/// yParity, r, s]`.
///
/// `payload` is the transaction *after* the leading `0x02` type byte has already been stripped.
///
/// [EIP-1559]: https://eips.ethereum.org/EIPS/eip-1559
fn decode_eip1559(payload: &[u8]) -> Result<SigningMaterial, EvmTxError> {
    let rlp = Rlp::new(payload);
    let item_count = rlp.item_count()?;
    if item_count != 12 {
        return Err(EvmTxError::WrongEip1559ItemCount(item_count));
    }

    let y_parity: u64 = rlp.at(9)?.as_val()?;
    let (r, s) = decode_r_s(&rlp, 10, 11)?;

    let mut stream = RlpStream::new();
    stream.begin_list(9);
    for i in 0..9 {
        stream.append_raw(rlp.at(i)?.as_raw(), 1);
    }
    let mut preimage = vec![EIP1559_TYPE];
    preimage.extend_from_slice(&stream.out());

    Ok(SigningMaterial {
        preimage,
        recovery_id: y_parity as i32,
        r,
        s,
    })
}

/// Recover the sender address of a raw, signed Monad (EVM-style) transaction.
///
/// This is the Monad equivalent of checking a Lotus `SignedPayload`'s `pubkey`/`sig` fields
/// against its `payload_hash` -- except here there's no separate app-level signature to check at
/// all: `raw_tx`'s own ECDSA signature (over its own RLP-encoded contents) *is* the proof of who
/// sent it, recoverable without the sender ever having published their public key up front (per
/// PLAN.md constraint 5).
pub fn recover_sender(raw_tx: &[u8]) -> Result<Address, EvmTxError> {
    let first_byte = *raw_tx.first().ok_or(EvmTxError::Empty)?;
    let signing_material = if first_byte == EIP1559_TYPE {
        decode_eip1559(&raw_tx[1..])?
    } else if first_byte >= 0xc0 {
        decode_legacy(raw_tx)?
    } else {
        return Err(EvmTxError::UnsupportedTxType(first_byte));
    };

    let digest = keccak256(&signing_material.preimage);
    let mut compact_sig = [0u8; 64];
    compact_sig[..32].copy_from_slice(&signing_material.r);
    compact_sig[32..].copy_from_slice(&signing_material.s);

    let ecc = EccSecp256k1::default();
    let pubkey = ecc
        .recover_sig(&compact_sig, signing_material.recovery_id, digest.into())
        .map_err(|err| EvmTxError::RecoveryFailed(format!("{err:?}")))?;
    let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
    Ok(address_from_uncompressed_pubkey(&uncompressed))
}

/// Decode and authenticate all fields the relay can validate before it broadcasts anything.
pub fn decode_signed_transaction(raw_tx: &[u8]) -> Result<DecodedSignedTransaction, EvmTxError> {
    let sender = recover_sender(raw_tx)?;
    let (destination, value_wei, input) = decode_transaction_fields(raw_tx)?;
    Ok(DecodedSignedTransaction {
        tx_hash: crate::monad_http::Hash32(keccak256(raw_tx)),
        sender,
        destination,
        value_wei,
        input,
    })
}

/// Test-only helpers to construct a validly-signed raw EVM transaction, so tests elsewhere in this
/// crate (this module's own, and `http::monad_message`'s end-to-end tests) can exercise
/// [`recover_sender`] -- and the HTTP route built on top of it -- without a real wallet or a
/// second, independent transaction-construction implementation living outside of tests. Building
/// *client-side* message/transaction construction for real use is explicitly out of scope for this
/// ticket (a future ticket's job); this exists purely to prove the server-side decode path works.
#[cfg(test)]
pub(crate) mod test_support {
    use bitcoinsuite_core::ecc::{Ecc, SecKey};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use rlp::RlpStream;

    use super::{keccak256, Address};

    /// Construct a raw, signed EIP-1559 transaction sending `value_wei` and `calldata` to `to`,
    /// signed by `seckey`. Returns the raw tx bytes and the signer's [`Address`] (so tests can
    /// assert [`super::recover_sender`] recovers exactly this address back out).
    pub(crate) fn signed_eip1559_tx(
        seckey: &SecKey,
        chain_id: u64,
        nonce: u64,
        to: Address,
        value_wei: u128,
        calldata: &[u8],
    ) -> (Vec<u8>, Address) {
        let ecc = EccSecp256k1::default();
        let pubkey = ecc.derive_pubkey(seckey);
        let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
        let sender = super::address_from_uncompressed_pubkey(&uncompressed);

        let mut unsigned = RlpStream::new();
        unsigned.begin_list(9);
        unsigned.append(&chain_id);
        unsigned.append(&nonce);
        unsigned.append(&1_000_000_000u64); // maxPriorityFeePerGas
        unsigned.append(&2_000_000_000u64); // maxFeePerGas
        unsigned.append(&500_000u64); // gasLimit
        unsigned.append(&to.0.as_ref());
        unsigned.append(&value_wei.to_be_bytes().as_ref());
        unsigned.append(&calldata);
        unsigned.begin_list(0); // empty accessList

        let mut preimage = vec![super::EIP1559_TYPE];
        preimage.extend_from_slice(&unsigned.out());
        let digest = keccak256(&preimage);

        let (recovery_id, sig_rs) = ecc.sign_recoverable(seckey, digest.into());

        let mut signed = RlpStream::new();
        signed.begin_list(12);
        signed.append(&chain_id);
        signed.append(&nonce);
        signed.append(&1_000_000_000u64);
        signed.append(&2_000_000_000u64);
        signed.append(&500_000u64);
        signed.append(&to.0.as_ref());
        signed.append(&value_wei.to_be_bytes().as_ref());
        signed.append(&calldata);
        signed.begin_list(0);
        signed.append(&(recovery_id as u64));
        signed.append(&sig_rs[..32].as_ref());
        signed.append(&sig_rs[32..].as_ref());

        let mut raw_tx = vec![super::EIP1559_TYPE];
        raw_tx.extend_from_slice(&signed.out());
        (raw_tx, sender)
    }
}

#[cfg(test)]
mod tests {
    use bitcoinsuite_core::ecc::{Ecc, SecKey};
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;

    use super::*;

    fn seckey(byte: u8) -> SecKey {
        EccSecp256k1::default()
            .seckey_from_array([byte; 32])
            .unwrap()
    }

    #[test]
    fn recovers_sender_of_a_signed_eip1559_tx() {
        let seckey = seckey(0x42);
        let to = Address([0x11; 20]);
        let (raw_tx, expected_sender) =
            test_support::signed_eip1559_tx(&seckey, 41454, 0, to, 10_000, b"hello");

        let recovered = recover_sender(&raw_tx).unwrap();
        assert_eq!(recovered, expected_sender);
        let decoded = decode_signed_transaction(&raw_tx).unwrap();
        assert_eq!(decoded.sender, expected_sender);
        assert_eq!(decoded.destination, Some(to));
        assert_eq!(decoded.value_wei, 10_000);
        assert_eq!(decoded.input, b"hello");
        assert_eq!(decoded.tx_hash.0, keccak256(&raw_tx));
    }

    #[test]
    fn different_signers_recover_different_addresses() {
        let to = Address([0x11; 20]);
        let (raw_tx_a, sender_a) =
            test_support::signed_eip1559_tx(&seckey(0x01), 41454, 0, to, 0, b"");
        let (raw_tx_b, sender_b) =
            test_support::signed_eip1559_tx(&seckey(0x02), 41454, 0, to, 0, b"");

        assert_ne!(sender_a, sender_b);
        assert_eq!(recover_sender(&raw_tx_a).unwrap(), sender_a);
        assert_eq!(recover_sender(&raw_tx_b).unwrap(), sender_b);
    }

    #[test]
    fn tampering_with_the_payload_changes_the_recovered_sender() {
        let seckey = seckey(0x42);
        let to = Address([0x11; 20]);
        let (mut raw_tx, expected_sender) =
            test_support::signed_eip1559_tx(&seckey, 41454, 0, to, 10_000, b"hello");

        // Flip a byte deep in the calldata (well past the RLP header) without touching the
        // signature: the recovered address must no longer match, since the signature commits to
        // the entire preimage. (Doesn't assert a *specific* mismatched address, since a bit flip
        // recovers an arbitrary-looking but still-valid point.)
        let flip_index = raw_tx.len() - 10;
        raw_tx[flip_index] ^= 0xff;

        let recovered = recover_sender(&raw_tx).unwrap();
        assert_ne!(recovered, expected_sender);
    }

    #[test]
    fn empty_raw_tx_is_rejected() {
        assert_eq!(recover_sender(&[]), Err(EvmTxError::Empty));
    }

    #[test]
    fn unsupported_type_byte_is_rejected() {
        // 0x01 (EIP-2930) is a recognized EIP-2718 type byte, but not one this module supports.
        assert_eq!(
            recover_sender(&[0x01, 0xc0]),
            Err(EvmTxError::UnsupportedTxType(0x01)),
        );
    }

    #[test]
    fn malformed_legacy_rlp_is_rejected() {
        // A 3-item list, not the 9 a legacy transaction requires.
        let mut stream = RlpStream::new();
        stream.begin_list(3);
        stream.append(&1u64);
        stream.append(&2u64);
        stream.append(&3u64);
        let raw_tx = stream.out().to_vec();

        assert_eq!(
            recover_sender(&raw_tx),
            Err(EvmTxError::WrongLegacyItemCount(3)),
        );
    }
}
