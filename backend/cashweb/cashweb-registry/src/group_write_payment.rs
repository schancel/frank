//! What a group write's payment must look like before the hosting relay appends the write.
//!
//! Every new write to a group this relay hosts carries one signed raw EVM transaction. It pays
//! the relay's own address at least the group's price, on the relay's network, and
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
//! commitment one payment could fund writes on several relays.
//!
//! The payee is the hosting relay's own address (`[registry.group_writes] payee`). The price is
//! the group's: its creator sets it in a [`GroupWritePrice`] record signed with the group's root
//! key, and may raise or lower it with a record of a higher version. The relay refuses a record
//! below its operator minimum, and prices a group with no record at that minimum.
//!
//! ```text
//! price digest = SHA256( lp("frank/group-write-price/v1") || lp(network) || group_id[32]
//!                        || version_be[8] || price_wei_be[16] )
//! ```
//!
//! Everything here is decided from the request bytes and the policy. Nothing is asked of the
//! chain: as with direct-message stamps, confirmation is not awaited.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    evm_rpc::{Address, Hash32},
    evm_transaction::{decode_signed_transaction, has_no_trailing_bytes},
    store::groups::{derive_group_id, parse_group_id_hex, verify_secp256k1_sig, GroupError},
};

/// Domain separator of the payment commitment.
pub const GROUP_WRITE_COMMITMENT_DOMAIN: &str = "frank/group-write-payment/v1";
/// Four-byte tag at the start of a group-write payment's calldata.
pub const GROUP_WRITE_LOKAD_ID: [u8; 4] = *b"GRPW";
/// Calldata layout version after [`GROUP_WRITE_LOKAD_ID`].
pub const GROUP_WRITE_CALLDATA_VERSION: u8 = 0x01;
/// Exact calldata length: tag, version, commitment.
pub const GROUP_WRITE_CALLDATA_LEN: usize = 4 + 1 + 32;
/// Domain separator of a group's write-price record.
pub const GROUP_WRITE_PRICE_DOMAIN: &str = "frank/group-write-price/v1";
/// Largest raw transaction a write may carry, as for direct-message stamps.
pub const MAX_GROUP_PAYMENT_BYTES: usize = 128 * 1024;

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

/// The hosting relay's public origin in the one spelling the commitment uses.
pub fn canonical_host_origin(origin: &url::Url) -> Option<String> {
    match origin.origin() {
        origin @ url::Origin::Tuple(..) => Some(origin.ascii_serialization()),
        url::Origin::Opaque(_) => None,
    }
}

/// The hosting relay's terms for group writes: its network, origin, own address and minimum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupWritePolicy {
    /// Canonical chain identifier payments are made on (the relay's `registry.network`).
    pub network: String,
    /// Native EVM chain id of `network`, required in the signed transaction.
    pub chain_id: u64,
    /// This relay's public origin, as [`canonical_host_origin`] spells it.
    pub host_origin: String,
    /// The relay's own address: every write pays it.
    pub payee: [u8; 20],
    /// The operator's minimum, in wei: the least price a creator may set, and the price of a
    /// group whose creator has set none. Never zero.
    pub min_price_wei: u128,
}

impl GroupWritePolicy {
    /// What one write to a group pays, given the group's creator price record, if any. A
    /// creator price is never below the minimum when it is set; should the operator raise the
    /// minimum later, the minimum applies.
    pub fn price_wei(&self, creator: Option<&GroupWritePrice>) -> u128 {
        effective_price_wei(creator, self.min_price_wei)
    }
}

/// A group's price: its creator's, never below the operator's minimum; the minimum when the
/// creator has set none.
pub fn effective_price_wei(creator: Option<&GroupWritePrice>, min_price_wei: u128) -> u128 {
    creator.map_or(min_price_wei, |record| record.price_wei.max(min_price_wei))
}

/// A group's write price, set by its creator and signed with the group's root key (whose holders
/// also change its epochs). A record replaces the stored one only with a higher `version`; the
/// same record again is accepted unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupWritePrice {
    /// 64-character lowercase hex group identifier.
    pub group_id: String,
    /// Canonical chain identifier the price is paid on: the hosting relay's network.
    pub network: String,
    /// Counts the creator's prices, from 1.
    pub version: u64,
    /// Price of one write, in wei.
    #[serde(with = "decimal_wei")]
    pub price_wei: u128,
    /// Hex compact low-S secp256k1 signature by the group's root key over
    /// [`group_write_price_digest`].
    pub admin_sig: String,
}

mod decimal_wei {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<u128, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(D::Error::custom("price_wei must be a decimal wei amount"));
        }
        text.parse().map_err(D::Error::custom)
    }
}

/// The digest a group's root key signs to set its write price.
pub fn group_write_price_digest(
    network: &str,
    group_id: &[u8; 32],
    version: u64,
    price_wei: u128,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    length_prefixed(&mut hasher, GROUP_WRITE_PRICE_DOMAIN.as_bytes());
    length_prefixed(&mut hasher, network.as_bytes());
    hasher.update(group_id);
    hasher.update(version.to_be_bytes());
    hasher.update(price_wei.to_be_bytes());
    hasher.finalize().into()
}

impl GroupWritePrice {
    /// The record with its hex fields in their one spelling.
    pub fn normalized(mut self) -> Self {
        self.group_id = self.group_id.to_lowercase();
        self.admin_sig = self
            .admin_sig
            .strip_prefix("0x")
            .unwrap_or(&self.admin_sig)
            .to_lowercase();
        self
    }

    /// Check the record is for `path_group_id` on `network`, at version 1 or more, above zero,
    /// and signed by `group_pubkey`, the group's root key.
    pub fn verify(
        &self,
        path_group_id: &str,
        network: &str,
        group_pubkey: &[u8; 33],
    ) -> Result<(), GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        if self.group_id != path_group_id {
            return Err(GroupError::InvalidInput(
                "write price group_id does not match URL path :group_id".into(),
            ));
        }
        if self.network != network {
            return Err(GroupError::InvalidInput(format!(
                "write price network {:?} is not this relay's {network}",
                self.network
            )));
        }
        if self.version == 0 {
            return Err(GroupError::InvalidInput(
                "write price version starts at 1".into(),
            ));
        }
        if self.price_wei == 0 {
            return Err(GroupError::InvalidInput(
                "write price must be above zero".into(),
            ));
        }
        if derive_group_id(group_pubkey) != group_id {
            return Err(GroupError::Forbidden(
                "group root key does not match group_id".into(),
            ));
        }
        let signature: [u8; 64] = hex::decode(&self.admin_sig)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| GroupError::Forbidden("malformed write price admin_sig".into()))?;
        let digest = group_write_price_digest(network, &group_id, self.version, self.price_wei);
        if !is_low_s(&signature) || !verify_secp256k1_sig(group_pubkey, &digest, &signature) {
            return Err(GroupError::Forbidden(
                "write price is not signed by the group's root key".into(),
            ));
        }
        Ok(())
    }
}

/// Whether a compact signature is in its one low-S spelling, as epoch signatures must be.
fn is_low_s(signature: &[u8; 64]) -> bool {
    secp256k1_abc::Signature::from_compact(signature).is_ok_and(|parsed| {
        let mut normalized = parsed;
        normalized.normalize_s();
        normalized.serialize_compact() == *signature
    })
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
    /// Pays someone other than the relay's address.
    #[error(
        "payment does not pay this relay's address 0x{}",
        hex::encode(expected)
    )]
    WrongPayee {
        /// The payee this write must pay.
        expected: [u8; 20],
    },
    /// Carries less than the group's price.
    #[error(
        "payment 0x{} carries {actual} wei, the group's price is {required} wei",
        hex::encode(tx_hash)
    )]
    Underpaid {
        /// The price.
        required: u128,
        /// The signed value.
        actual: u128,
        /// The payment's transaction hash, which the host records as refused.
        tx_hash: [u8; 32],
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

/// Check `raw_transaction` pays for `target` under `policy`, at least `price_wei` (the group's
/// price, [`GroupWritePolicy::price_wei`]). Pure: no chain or storage access.
pub fn verify_group_write_payment(
    policy: &GroupWritePolicy,
    price_wei: u128,
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
    if signed.input != group_write_calldata(&commitment) {
        return Err(GroupPaymentError::WrongCommitment);
    }
    let payee = policy.payee;
    if signed.destination != Some(Address(payee)) {
        return Err(GroupPaymentError::WrongPayee { expected: payee });
    }
    if signed.value_wei < price_wei {
        return Err(GroupPaymentError::Underpaid {
            required: price_wei,
            actual: signed.value_wei,
            tx_hash: signed.tx_hash.0,
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
