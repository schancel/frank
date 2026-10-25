//! What a group write's payment must look like before the hosting relay appends the write.
//!
//! Every new write to a group this relay hosts carries one signed raw EVM transaction. It pays
//! the operator's configured payee at least the configured price, on the relay's network, and
//! its calldata commits to this relay, the group, the epoch and the write's signing digest:
//!
//! ```text
//! commitment = SHA256( lp("frank/group-write-payment/v1") || lp(network) || lp(host_origin)
//!                      || group_id[32] || epoch_be[8] || signing_digest[32] )
//! calldata   = "GRPW" || 0x01 || commitment                       (37 bytes)
//! lp(x)      = u16_be(len(x)) || x
//! ```
//!
//! `network` is the canonical chain identifier (`docs/protocol/chains/v1.json`); `host_origin`
//! is the hosting relay's public origin as `URL.origin` / [`url::Origin::ascii_serialization`]
//! write it (`https://relay.example`, no trailing slash, default port omitted). Without the
//! commitment one burn could fund writes on several relays.
//!
//! The payee is one of:
//! - `burn`: [`BURN_ADDRESS`]. Funds nobody, so operators opt into it.
//! - one fixed address;
//! - an operator xpub. The address is the non-hardened child `xpub/0/i` with
//!   `i = u32_be(commitment[0..4]) & 0x7fff_ffff` (PROPOSED rule, still open for the owner), so
//!   writer and relay compute the same address without a round trip.
//!
//! Everything here is decided from the request bytes and the policy. Nothing is asked of the
//! chain: as with direct-message stamps, confirmation is not awaited.

use secp256k1_abc::{PublicKey, Secp256k1};
use sha2::{Digest, Sha256};

use crate::{
    monad_evm_tx::{decode_signed_transaction, has_no_trailing_bytes},
    monad_http::{Address, Hash32},
};

/// Domain separator of the payment commitment.
pub const GROUP_WRITE_COMMITMENT_DOMAIN: &str = "frank/group-write-payment/v1";
/// Four-byte tag at the start of a group-write payment's calldata.
pub const GROUP_WRITE_LOKAD_ID: [u8; 4] = *b"GRPW";
/// Calldata layout version after [`GROUP_WRITE_LOKAD_ID`].
pub const GROUP_WRITE_CALLDATA_VERSION: u8 = 0x01;
/// Exact calldata length: tag, version, commitment.
pub const GROUP_WRITE_CALLDATA_LEN: usize = 4 + 1 + 32;
/// The burn payee: the conventional `0x…dEaD` address, as the forum uses.
pub const BURN_ADDRESS: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xde, 0xad,
];
/// Largest raw transaction a write may carry, as for direct-message stamps.
pub const MAX_GROUP_PAYMENT_BYTES: usize = 128 * 1024;

const HARDENED_CHILD: u32 = 1 << 31;
/// BIP32 version bytes of a mainnet (`xpub`) and testnet (`tpub`) extended public key.
const XPUB_VERSIONS: [[u8; 4]; 2] = [[0x04, 0x88, 0xb2, 0x1e], [0x04, 0x35, 0x87, 0xcf]];

fn length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u16).to_be_bytes());
    hasher.update(bytes);
}

/// The write this payment pays for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupWriteTarget {
    /// 32-byte group identifier.
    pub group_id: [u8; 32],
    /// Epoch whose write key signed the envelope.
    pub epoch: u64,
    /// The envelope's signing digest (`GroupMessageEnvelope::signing_digest`).
    pub signing_digest: [u8; 32],
}

/// The commitment a payment's calldata carries. `network` and `host_origin` are at most
/// `u16::MAX` bytes; the relay's own values always are.
pub fn group_write_commitment(
    network: &str,
    host_origin: &str,
    target: &GroupWriteTarget,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    length_prefixed(&mut hasher, GROUP_WRITE_COMMITMENT_DOMAIN.as_bytes());
    length_prefixed(&mut hasher, network.as_bytes());
    length_prefixed(&mut hasher, host_origin.as_bytes());
    hasher.update(target.group_id);
    hasher.update(target.epoch.to_be_bytes());
    hasher.update(target.signing_digest);
    hasher.finalize().into()
}

/// The exact calldata of a payment carrying `commitment`.
pub fn group_write_calldata(commitment: &[u8; 32]) -> [u8; GROUP_WRITE_CALLDATA_LEN] {
    let mut calldata = [0u8; GROUP_WRITE_CALLDATA_LEN];
    calldata[..4].copy_from_slice(&GROUP_WRITE_LOKAD_ID);
    calldata[4] = GROUP_WRITE_CALLDATA_VERSION;
    calldata[5..].copy_from_slice(commitment);
    calldata
}

/// The xpub child index a payment with `commitment` pays (PROPOSED rule).
pub fn xpub_payee_index(commitment: &[u8; 32]) -> u32 {
    u32::from_be_bytes([commitment[0], commitment[1], commitment[2], commitment[3]])
        & (HARDENED_CHILD - 1)
}

/// The hosting relay's public origin in the one spelling the commitment uses.
pub fn canonical_host_origin(origin: &url::Url) -> Option<String> {
    match origin.origin() {
        origin @ url::Origin::Tuple(..) => Some(origin.ascii_serialization()),
        url::Origin::Opaque(_) => None,
    }
}

/// Why an operator payee could not be used.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GroupPayeeError {
    /// Not a `0x`-prefixed 20-byte hex address.
    #[error("group write payee address must be 0x followed by 40 hex characters")]
    InvalidAddress,
    /// Not a base58check BIP32 extended public key (`xpub`/`tpub`).
    #[error("group write payee xpub is not a valid BIP32 extended public key")]
    InvalidXpub,
}

/// A BIP32 extended public key: watch-only, so only non-hardened children are derivable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtendedPublicKey {
    public_key: PublicKey,
    chain_code: [u8; 32],
}

impl ExtendedPublicKey {
    /// Parse a base58check `xpub…`/`tpub…` string.
    pub fn parse(encoded: &str) -> Result<Self, GroupPayeeError> {
        let bytes = bs58::decode(encoded.trim())
            .into_vec()
            .map_err(|_| GroupPayeeError::InvalidXpub)?;
        if bytes.len() != 82 {
            return Err(GroupPayeeError::InvalidXpub);
        }
        let (payload, checksum) = bytes.split_at(78);
        let check = Sha256::digest(Sha256::digest(payload));
        if checksum != &check[..4] || !XPUB_VERSIONS.iter().any(|v| payload[..4] == *v) {
            return Err(GroupPayeeError::InvalidXpub);
        }
        let mut chain_code = [0u8; 32];
        chain_code.copy_from_slice(&payload[13..45]);
        if !matches!(payload[45], 2 | 3) {
            return Err(GroupPayeeError::InvalidXpub);
        }
        let public_key =
            PublicKey::from_slice(&payload[45..78]).map_err(|_| GroupPayeeError::InvalidXpub)?;
        Ok(Self {
            public_key,
            chain_code,
        })
    }

    /// EVM address of the non-hardened child `0/index`. `None` for a hardened index, or the
    /// rare index whose BIP32 tweak is invalid (no address is payable there).
    pub fn payee_address(&self, index: u32) -> Option<[u8; 20]> {
        if index >= HARDENED_CHILD {
            return None;
        }
        let secp = Secp256k1::new();
        let mut public_key = self.public_key;
        let mut chain_code = self.chain_code;
        for step in [0, index] {
            crate::monad_stamp_stealth::derive_public_step(
                &secp,
                &mut public_key,
                &mut chain_code,
                step,
            )
            .ok()?;
        }
        Some(crate::monad_stamp_stealth::evm_address(&public_key))
    }
}

/// Who a group write pays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupWritePayee {
    /// [`BURN_ADDRESS`].
    Burn,
    /// One fixed operator address.
    Address([u8; 20]),
    /// A per-write child of an operator xpub (see the module docs).
    Xpub(ExtendedPublicKey),
}

impl GroupWritePayee {
    /// Resolve the operator's configured payee.
    pub fn from_conf(conf: &cashweb_config::GroupWritePayeeConf) -> Result<Self, GroupPayeeError> {
        use cashweb_config::GroupWritePayeeConf as C;
        Ok(match conf {
            C::Burn => Self::Burn,
            C::Address(address) => Self::Address(
                Address::from_hex(address)
                    .ok()
                    .filter(|_| address.len() == 42 && address.starts_with("0x"))
                    .ok_or(GroupPayeeError::InvalidAddress)?
                    .0,
            ),
            C::Xpub(xpub) => Self::Xpub(ExtendedPublicKey::parse(xpub)?),
        })
    }

    /// The address a payment carrying `commitment` must pay.
    pub fn address_for(&self, commitment: &[u8; 32]) -> Option<[u8; 20]> {
        match self {
            Self::Burn => Some(BURN_ADDRESS),
            Self::Address(address) => Some(*address),
            Self::Xpub(xpub) => xpub.payee_address(xpub_payee_index(commitment)),
        }
    }
}

/// The hosting relay's group-write price and payee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupWritePolicy {
    /// Canonical chain identifier payments are made on (the relay's `registry.network`).
    pub network: String,
    /// Native EVM chain id of `network`, required in the signed transaction.
    pub chain_id: u64,
    /// This relay's public origin, as [`canonical_host_origin`] spells it.
    pub host_origin: String,
    /// Least value, in wei, one write pays. Never zero.
    pub price_wei: u128,
    /// Who is paid.
    pub payee: GroupWritePayee,
}

/// Why a write's payment was refused. Each is final for those bytes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GroupPaymentError {
    /// The payment names another network than the relay's.
    #[error("payment network {actual:?} is not this relay's {expected}")]
    WrongNetwork {
        /// The relay's canonical network.
        expected: String,
        /// The network the payment names.
        actual: String,
    },
    /// Not one signed legacy or EIP-1559 transaction, or trailing bytes after it.
    #[error("payment is not one signed EVM transaction")]
    Malformed,
    /// Signed for another (or no) native chain id.
    #[error("payment is signed for chain id {actual:?}, not {expected}")]
    WrongChain {
        /// The network's native chain id.
        expected: u64,
        /// The signed chain id (`None`: an unprotected legacy transaction).
        actual: Option<u64>,
    },
    /// Pays someone other than the configured payee.
    #[error("payment does not pay this relay's payee {}", hex::encode(expected))]
    WrongPayee {
        /// The payee this write must pay.
        expected: [u8; 20],
    },
    /// Carries less than the price.
    #[error("payment carries {actual} wei, the price is {required} wei")]
    Underpaid {
        /// The price.
        required: u128,
        /// The signed value.
        actual: u128,
    },
    /// The calldata is not exactly the commitment to this relay, group, epoch and write.
    #[error("payment calldata does not commit to this write on this relay")]
    WrongCommitment,
}

impl GroupPaymentError {
    /// Stable machine-readable reason, as the relay answers it.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::WrongNetwork { .. } => "wrong_network",
            Self::Malformed => "malformed",
            Self::WrongChain { .. } => "wrong_chain",
            Self::WrongPayee { .. } => "wrong_payee",
            Self::Underpaid { .. } => "underpaid",
            Self::WrongCommitment => "wrong_commitment",
        }
    }
}

/// A payment that passed every static check for one write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGroupPayment {
    /// Keccak256 of the signed bytes; the payment's dedup key.
    pub tx_hash: Hash32,
    /// Recovered paying account.
    pub sender: Address,
    /// Address paid.
    pub payee: [u8; 20],
    /// Value paid, in wei.
    pub value_wei: u128,
    /// The signed nonce of the paying account.
    pub nonce: u64,
    /// Most the payer can be charged for gas.
    pub max_gas_cost_wei: u128,
    /// The signed bytes, to broadcast after the write commits.
    pub raw_transaction: Vec<u8>,
}

/// Check `raw_transaction` pays for `target` under `policy`. Pure: no chain or storage access.
pub fn verify_group_write_payment(
    policy: &GroupWritePolicy,
    target: &GroupWriteTarget,
    network: &str,
    raw_transaction: &[u8],
) -> Result<VerifiedGroupPayment, GroupPaymentError> {
    if network != policy.network {
        return Err(GroupPaymentError::WrongNetwork {
            expected: policy.network.clone(),
            actual: network.to_owned(),
        });
    }
    if raw_transaction.len() > MAX_GROUP_PAYMENT_BYTES || !has_no_trailing_bytes(raw_transaction) {
        return Err(GroupPaymentError::Malformed);
    }
    let signed =
        decode_signed_transaction(raw_transaction).map_err(|_| GroupPaymentError::Malformed)?;
    if signed.chain_id != Some(policy.chain_id) {
        return Err(GroupPaymentError::WrongChain {
            expected: policy.chain_id,
            actual: signed.chain_id,
        });
    }
    let commitment = group_write_commitment(&policy.network, &policy.host_origin, target);
    // The commitment chooses an xpub payee, so a wrong commitment usually shows as a wrong
    // payee too. Check the calldata first so the reason names the real mistake.
    if signed.input != group_write_calldata(&commitment) {
        return Err(GroupPaymentError::WrongCommitment);
    }
    let payee = policy
        .payee
        .address_for(&commitment)
        // An invalid xpub child cannot be paid by anyone; the writer must change the write.
        .ok_or(GroupPaymentError::WrongCommitment)?;
    if signed.destination != Some(Address(payee)) {
        return Err(GroupPaymentError::WrongPayee { expected: payee });
    }
    if signed.value_wei < policy.price_wei {
        return Err(GroupPaymentError::Underpaid {
            required: policy.price_wei,
            actual: signed.value_wei,
        });
    }
    Ok(VerifiedGroupPayment {
        tx_hash: signed.tx_hash,
        sender: signed.sender,
        payee,
        value_wei: signed.value_wei,
        nonce: signed.nonce,
        max_gas_cost_wei: signed.max_gas_cost_wei,
        raw_transaction: raw_transaction.to_vec(),
    })
}

#[cfg(test)]
#[path = "group_write_payment_tests.rs"]
mod tests;
