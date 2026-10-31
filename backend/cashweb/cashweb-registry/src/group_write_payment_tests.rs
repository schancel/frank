//! Pure verifier checks on real signed transaction bytes. The fixed transaction vector was
//! produced independently with ethers v6 (`Transaction`, `Wallet`), the library the TypeScript
//! writer uses, and the price digest vector with Python's `hashlib`, so these tests also pin
//! cross-language agreement.

use bitcoinsuite_core::ecc::{Ecc, SecKey};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;

use super::*;
use crate::evm_transaction::test_support::{signed_eip1559_tx, signed_unprotected_legacy_tx};

/// The burn address `0x…dEaD`, which the labs configure as their payee.
const BURN_ADDRESS: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xde, 0xad,
];
/// The price the fixed vectors pay: 10^12 wei.
const PRICE: u128 = 1_000_000_000_000;
const MONAD_TESTNET_CHAIN_ID: u64 = 10143;
const HOST: &str = "https://relay.example";

/// The ethers-signed EIP-1559 payment for [`target`] burning 10^12 wei on monad-testnet.
const ETHERS_BURN_TX: &str = "02f89782279f07847735940085174876e80082ea6094000000000000000000000000000000000000dead85e8d4a51000a54752505701ee77f57679731ff0f06f5ff5dfc59c3a5401b3491c763822bfe2ffa15334f190c001a05627eaa26d6623bb689fa47b88ce5b2166cda57cdb37a1581bb250b0310f98afa06b8f6715431f88d8d1e4bcd8719860892caee568e0391a1f5153c359b62d8d0f";

fn target() -> GroupWriteTarget {
    GroupWriteTarget {
        group_id: [0x11; 32],
        epoch: 3,
        signing_digest: [0x22; 32],
    }
}

fn policy(payee: [u8; 20]) -> GroupWritePolicy {
    GroupWritePolicy {
        network: "monad-testnet".into(),
        chain_id: MONAD_TESTNET_CHAIN_ID,
        host_origin: HOST.into(),
        payee,
        min_price_wei: PRICE,
    }
}

fn seckey(byte: u8) -> SecKey {
    EccSecp256k1::default()
        .seckey_from_array([byte; 32])
        .unwrap()
}

fn calldata_for(target: &GroupWriteTarget, host: &str) -> Vec<u8> {
    group_write_calldata(&group_write_commitment("monad-testnet", host, target)).to_vec()
}

fn pay(chain_id: u64, to: [u8; 20], value: u128, calldata: &[u8]) -> Vec<u8> {
    signed_eip1559_tx(&seckey(0x42), chain_id, 7, Address(to), value, calldata).0
}

fn address(hex_address: &str) -> [u8; 20] {
    hex::decode(hex_address.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

#[test]
fn commitment_and_calldata_match_the_independent_vectors() {
    let commitment = group_write_commitment("monad-testnet", HOST, &target());
    assert_eq!(
        hex::encode(commitment),
        "ee77f57679731ff0f06f5ff5dfc59c3a5401b3491c763822bfe2ffa15334f190"
    );
    let calldata = group_write_calldata(&commitment);
    assert_eq!(&calldata[..5], b"GRPW\x01");
    assert_eq!(&calldata[5..], &commitment);
}

#[test]
fn the_ethers_signed_burn_verifies_and_reports_its_payer() {
    let raw = hex::decode(ETHERS_BURN_TX).unwrap();
    let verified = verify_group_write_payment(
        &policy(BURN_ADDRESS),
        PRICE,
        &target(),
        "monad-testnet",
        &raw,
    )
    .unwrap();
    assert_eq!(
        hex::encode(verified.tx_hash.0),
        "73a0370f174174203111e226e9a4816d585f95a79da037d7615d07b6aac7df8f"
    );
    assert_eq!(
        verified.sender,
        Address(address("17c5185167401ed00cf5f5b2fc97d9bbfdb7d025"))
    );
    assert_eq!(verified.payee, BURN_ADDRESS);
    assert_eq!(verified.value_wei, 1_000_000_000_000);
    assert_eq!(verified.raw_transaction, raw);
}

#[test]
fn only_the_relay_address_is_paid_at_or_over_the_group_price() {
    let operator = address("00000000000000000000000000000000000000aa");
    let calldata = calldata_for(&target(), HOST);
    let policy = policy(operator);
    for price in [PRICE, PRICE * 5] {
        let raw = pay(MONAD_TESTNET_CHAIN_ID, operator, price, &calldata);
        assert!(
            verify_group_write_payment(&policy, price, &target(), "monad-testnet", &raw).is_ok()
        );
        // Over the price is fine: the price is a floor.
        let raw = pay(MONAD_TESTNET_CHAIN_ID, operator, price + 1, &calldata);
        assert!(
            verify_group_write_payment(&policy, price, &target(), "monad-testnet", &raw).is_ok()
        );
        let raw = pay(MONAD_TESTNET_CHAIN_ID, BURN_ADDRESS, price, &calldata);
        assert_eq!(
            verify_group_write_payment(&policy, price, &target(), "monad-testnet", &raw),
            Err(GroupPaymentError::WrongPayee { expected: operator })
        );
    }
    // A group priced above the minimum refuses a payment of the minimum.
    let raw = pay(MONAD_TESTNET_CHAIN_ID, operator, PRICE, &calldata);
    assert_eq!(
        verify_group_write_payment(&policy, PRICE * 5, &target(), "monad-testnet", &raw),
        Err(GroupPaymentError::Underpaid {
            required: PRICE * 5,
            actual: PRICE,
            tx_hash: tx_hash_of(&raw),
        })
    );
}

#[test]
fn underpaid_wrong_chain_and_wrong_network_are_refused() {
    let policy = policy(BURN_ADDRESS);
    let calldata = calldata_for(&target(), HOST);
    let raw = pay(MONAD_TESTNET_CHAIN_ID, BURN_ADDRESS, PRICE - 1, &calldata);
    let refused = verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &raw);
    assert_eq!(
        refused,
        Err(GroupPaymentError::Underpaid {
            required: PRICE,
            actual: PRICE - 1,
            tx_hash: tx_hash_of(&raw),
        })
    );
    assert_eq!(refused.unwrap_err().reason(), "underpaid");

    // Signed for Ethereum Sepolia's native id: the same bytes would replay there, not here.
    let raw = pay(11_155_111, BURN_ADDRESS, PRICE, &calldata);
    assert_eq!(
        verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &raw),
        Err(GroupPaymentError::WrongChain {
            expected: MONAD_TESTNET_CHAIN_ID,
            actual: Some(11_155_111)
        })
    );
    // An unprotected legacy transaction names no chain and could replay on any.
    let legacy =
        signed_unprotected_legacy_tx(&seckey(0x42), 0, Address(BURN_ADDRESS), PRICE, &calldata);
    assert_eq!(
        verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &legacy),
        Err(GroupPaymentError::WrongChain {
            expected: MONAD_TESTNET_CHAIN_ID,
            actual: None
        })
    );

    let raw = pay(MONAD_TESTNET_CHAIN_ID, BURN_ADDRESS, PRICE, &calldata);
    for network in ["monad-mainnet", "evm", "10143", "Monad-Testnet", ""] {
        assert!(matches!(
            verify_group_write_payment(&policy, PRICE, &target(), network, &raw),
            Err(GroupPaymentError::WrongNetwork { .. })
        ));
    }
}

#[test]
fn a_payment_funds_only_the_write_and_relay_it_commits_to() {
    let policy = policy(BURN_ADDRESS);
    let raw = pay(
        MONAD_TESTNET_CHAIN_ID,
        BURN_ADDRESS,
        PRICE,
        &calldata_for(&target(), HOST),
    );
    let mut other_group = target();
    other_group.group_id[0] ^= 1;
    let mut other_epoch = target();
    other_epoch.epoch += 1;
    let mut other_write = target();
    other_write.signing_digest[31] ^= 1;
    for target in [other_group, other_epoch, other_write] {
        assert_eq!(
            verify_group_write_payment(&policy, PRICE, &target, "monad-testnet", &raw),
            Err(GroupPaymentError::WrongCommitment)
        );
    }
    // The same burn presented to another relay commits to the wrong host.
    let mut other_relay = policy.clone();
    other_relay.host_origin = "https://other.example".into();
    assert_eq!(
        verify_group_write_payment(&other_relay, PRICE, &target(), "monad-testnet", &raw),
        Err(GroupPaymentError::WrongCommitment)
    );

    // Calldata must be exactly the commitment: no other tag, version, or extra bytes.
    let good = calldata_for(&target(), HOST);
    let mut wrong_tag = good.clone();
    wrong_tag[0] = b'X';
    let mut wrong_version = good.clone();
    wrong_version[4] = 2;
    let mut trailing = good.clone();
    trailing.push(0);
    for calldata in [
        wrong_tag,
        wrong_version,
        trailing,
        good[..36].to_vec(),
        Vec::new(),
    ] {
        let raw = pay(MONAD_TESTNET_CHAIN_ID, BURN_ADDRESS, PRICE, &calldata);
        assert_eq!(
            verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &raw),
            Err(GroupPaymentError::WrongCommitment)
        );
    }
}

#[test]
fn malformed_bytes_are_refused() {
    let policy = policy(BURN_ADDRESS);
    let raw = hex::decode(ETHERS_BURN_TX).unwrap();
    let mut trailing = raw.clone();
    trailing.push(0);
    for bytes in [
        Vec::new(),
        vec![0x01],
        trailing,
        raw[..raw.len() - 1].to_vec(),
    ] {
        assert_eq!(
            verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &bytes),
            Err(GroupPaymentError::Malformed),
            "{}",
            hex::encode(&bytes)
        );
    }
    let oversized = vec![0xc0; MAX_GROUP_PAYMENT_BYTES + 1];
    assert_eq!(
        verify_group_write_payment(&policy, PRICE, &target(), "monad-testnet", &oversized),
        Err(GroupPaymentError::Malformed)
    );
}

/// A price record signed by the root key `[root; 32]`.
fn price_record(root: u8, network: &str, version: u64, price_wei: u128) -> GroupWritePrice {
    let group_id = crate::store::groups::derive_group_id(&root_pubkey(root));
    let digest = group_write_price_digest(network, &group_id, version, price_wei);
    let secp = secp256k1_abc::Secp256k1::new();
    let secret = secp256k1_abc::SecretKey::from_slice(&[root; 32]).unwrap();
    let signature = secp.sign(
        &secp256k1_abc::Message::from_slice(&digest).unwrap(),
        &secret,
    );
    GroupWritePrice {
        group_id: hex::encode(group_id),
        network: network.into(),
        version,
        price_wei,
        admin_sig: hex::encode(signature.serialize_compact()),
    }
}

fn root_pubkey(root: u8) -> [u8; 33] {
    let secp = secp256k1_abc::Secp256k1::new();
    let secret = secp256k1_abc::SecretKey::from_slice(&[root; 32]).unwrap();
    secp256k1_abc::PublicKey::from_secret_key(&secp, &secret).serialize()
}

#[test]
fn the_price_digest_matches_the_independent_vector() {
    assert_eq!(
        hex::encode(group_write_price_digest(
            "monad-testnet",
            &[0x11; 32],
            2,
            5_000_000_000_000_000
        )),
        "065e08125716f2a2fd1909ec95209a43cf738b259a76d967f591c8827c1ab757"
    );
}

#[test]
fn a_price_record_verifies_only_for_its_group_network_and_root_key() {
    let pubkey = root_pubkey(7);
    let record = price_record(7, "monad-testnet", 1, PRICE * 3);
    let id = record.group_id.clone();
    assert_eq!(record.verify(&id, "monad-testnet", &pubkey), Ok(()));
    // The JSON a creator sends: the price is decimal wei text.
    let json = serde_json::to_value(&record).unwrap();
    assert_eq!(json["price_wei"], "3000000000000");
    assert_eq!(
        serde_json::from_value::<GroupWritePrice>(json).unwrap(),
        record
    );
    for bad in [r#""-1""#, r#""1e3""#, r#""""#, "1000"] {
        let mut json = serde_json::to_value(&record).unwrap();
        json["price_wei"] = serde_json::from_str(bad).unwrap();
        assert!(
            serde_json::from_value::<GroupWritePrice>(json).is_err(),
            "{bad}"
        );
    }

    // Another network, another group, version 0, a zero price: refused as input.
    assert!(matches!(
        record.verify(&id, "monad-mainnet", &pubkey),
        Err(GroupError::InvalidInput(_))
    ));
    assert!(matches!(
        record.verify(&"22".repeat(32), "monad-testnet", &pubkey),
        Err(GroupError::InvalidInput(_))
    ));
    for record in [
        price_record(7, "monad-testnet", 0, PRICE),
        price_record(7, "monad-testnet", 1, 0),
    ] {
        assert!(matches!(
            record.verify(&id, "monad-testnet", &pubkey),
            Err(GroupError::InvalidInput(_))
        ));
    }
    // Signed by another key, or a changed price under the old signature: refused.
    let other = price_record(8, "monad-testnet", 1, PRICE * 3);
    let forged = GroupWritePrice {
        group_id: id.clone(),
        ..other
    };
    assert!(matches!(
        forged.verify(&id, "monad-testnet", &pubkey),
        Err(GroupError::Forbidden(_))
    ));
    let changed = GroupWritePrice {
        price_wei: PRICE,
        ..record.clone()
    };
    assert!(matches!(
        changed.verify(&id, "monad-testnet", &pubkey),
        Err(GroupError::Forbidden(_))
    ));
    // The same signature in its high-S spelling is refused, as for epoch frames.
    let mut high_s =
        secp256k1_abc::Signature::from_compact(&hex::decode(&record.admin_sig).unwrap())
            .unwrap()
            .serialize_compact();
    let order =
        hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").unwrap();
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let value = order[index] as i16 - high_s[32 + index] as i16 - borrow;
        borrow = i16::from(value < 0);
        high_s[32 + index] = value.rem_euclid(256) as u8;
    }
    let high_s = GroupWritePrice {
        admin_sig: hex::encode(high_s),
        ..record.clone()
    };
    assert!(matches!(
        high_s.verify(&id, "monad-testnet", &pubkey),
        Err(GroupError::Forbidden(_))
    ));
}

#[test]
fn a_group_is_priced_by_its_creator_never_below_the_minimum() {
    let policy = policy(BURN_ADDRESS);
    assert_eq!(policy.price_wei(None), PRICE);
    let above = price_record(7, "monad-testnet", 1, PRICE * 4);
    assert_eq!(policy.price_wei(Some(&above)), PRICE * 4);
    // A record set before the operator raised its minimum pays the minimum.
    let below = price_record(7, "monad-testnet", 2, PRICE / 2);
    assert_eq!(policy.price_wei(Some(&below)), PRICE);
}

#[test]
fn host_origins_have_one_spelling() {
    for (configured, canonical) in [
        ("https://relay.example", "https://relay.example"),
        ("https://relay.example/", "https://relay.example"),
        ("https://Relay.Example:443/", "https://relay.example"),
        ("http://127.0.0.1:8098/", "http://127.0.0.1:8098"),
    ] {
        assert_eq!(
            canonical_host_origin(&configured.parse().unwrap()).as_deref(),
            Some(canonical),
            "{configured}"
        );
    }
}

/// The keccak hash of signed raw transaction bytes: its transaction hash.
fn tx_hash_of(raw: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(raw).into()
}
