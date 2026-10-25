//! Pure verifier checks on real signed transaction bytes. The fixed vectors were produced
//! independently with ethers v6 (`HDNodeWallet.fromExtendedKey`, `Transaction`, `Wallet`), the
//! library the TypeScript writer uses, so these tests also pin cross-language agreement.

use bitcoinsuite_core::ecc::{Ecc, SecKey};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;

use super::*;
use crate::monad_evm_tx::test_support::{signed_eip1559_tx, signed_unprotected_legacy_tx};

/// BIP32 test vector 1, master public key.
const XPUB: &str = "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
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

fn policy(payee: GroupWritePayee) -> GroupWritePolicy {
    GroupWritePolicy {
        network: "monad-testnet".into(),
        chain_id: MONAD_TESTNET_CHAIN_ID,
        host_origin: HOST.into(),
        price_wei: 1_000_000_000_000,
        payee,
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
fn commitment_calldata_and_xpub_children_match_the_independent_vectors() {
    let commitment = group_write_commitment("monad-testnet", HOST, &target());
    assert_eq!(
        hex::encode(commitment),
        "ee77f57679731ff0f06f5ff5dfc59c3a5401b3491c763822bfe2ffa15334f190"
    );
    let calldata = group_write_calldata(&commitment);
    assert_eq!(&calldata[..5], b"GRPW\x01");
    assert_eq!(&calldata[5..], &commitment);
    assert_eq!(xpub_payee_index(&commitment), 1_853_355_382);

    let xpub = ExtendedPublicKey::parse(XPUB).unwrap();
    for (index, expected) in [
        (0, "4b7115ad9623a528f1845eaf85d166de1e869bfb"),
        (1, "eb5a8ae75e395ef05c96839a3fb088b2f65e7662"),
        (0x7fff_ffff, "4e515434b67eab43ca645b490c27dec06fc0e31f"),
        (1_853_355_382, "b028a08facaae7f24adb103cc38b8ba433d629b4"),
    ] {
        assert_eq!(
            hex::encode(xpub.payee_address(index).unwrap()),
            expected,
            "0/{index}"
        );
    }
    assert_eq!(xpub.payee_address(HARDENED_CHILD), None);
}

#[test]
fn the_ethers_signed_burn_verifies_and_reports_its_payer() {
    let raw = hex::decode(ETHERS_BURN_TX).unwrap();
    let verified = verify_group_write_payment(
        &policy(GroupWritePayee::Burn),
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
fn each_payee_kind_accepts_exactly_its_address() {
    let operator = address("00000000000000000000000000000000000000aa");
    let xpub_child = address("b028a08facaae7f24adb103cc38b8ba433d629b4");
    let calldata = calldata_for(&target(), HOST);
    for (payee, to) in [
        (GroupWritePayee::Burn, BURN_ADDRESS),
        (GroupWritePayee::Address(operator), operator),
        (
            GroupWritePayee::Xpub(ExtendedPublicKey::parse(XPUB).unwrap()),
            xpub_child,
        ),
    ] {
        let policy = policy(payee);
        let raw = pay(MONAD_TESTNET_CHAIN_ID, to, policy.price_wei, &calldata);
        assert!(verify_group_write_payment(&policy, &target(), "monad-testnet", &raw).is_ok());
        // Over the price is fine: the price is a floor.
        let raw = pay(MONAD_TESTNET_CHAIN_ID, to, policy.price_wei + 1, &calldata);
        assert!(verify_group_write_payment(&policy, &target(), "monad-testnet", &raw).is_ok());
        for wrong in [BURN_ADDRESS, operator, xpub_child] {
            if wrong == to {
                continue;
            }
            let raw = pay(MONAD_TESTNET_CHAIN_ID, wrong, policy.price_wei, &calldata);
            assert_eq!(
                verify_group_write_payment(&policy, &target(), "monad-testnet", &raw),
                Err(GroupPaymentError::WrongPayee { expected: to })
            );
        }
    }
}

#[test]
fn underpaid_wrong_chain_and_wrong_network_are_refused() {
    let policy = policy(GroupWritePayee::Burn);
    let calldata = calldata_for(&target(), HOST);
    let raw = pay(
        MONAD_TESTNET_CHAIN_ID,
        BURN_ADDRESS,
        policy.price_wei - 1,
        &calldata,
    );
    let refused = verify_group_write_payment(&policy, &target(), "monad-testnet", &raw);
    assert_eq!(
        refused,
        Err(GroupPaymentError::Underpaid {
            required: policy.price_wei,
            actual: policy.price_wei - 1
        })
    );
    assert_eq!(refused.unwrap_err().reason(), "underpaid");

    // Signed for Ethereum Sepolia's native id: the same bytes would replay there, not here.
    let raw = pay(11_155_111, BURN_ADDRESS, policy.price_wei, &calldata);
    assert_eq!(
        verify_group_write_payment(&policy, &target(), "monad-testnet", &raw),
        Err(GroupPaymentError::WrongChain {
            expected: MONAD_TESTNET_CHAIN_ID,
            actual: Some(11_155_111)
        })
    );
    // An unprotected legacy transaction names no chain and could replay on any.
    let legacy = signed_unprotected_legacy_tx(
        &seckey(0x42),
        0,
        Address(BURN_ADDRESS),
        policy.price_wei,
        &calldata,
    );
    assert_eq!(
        verify_group_write_payment(&policy, &target(), "monad-testnet", &legacy),
        Err(GroupPaymentError::WrongChain {
            expected: MONAD_TESTNET_CHAIN_ID,
            actual: None
        })
    );

    let raw = pay(
        MONAD_TESTNET_CHAIN_ID,
        BURN_ADDRESS,
        policy.price_wei,
        &calldata,
    );
    for network in ["monad-mainnet", "evm", "10143", "Monad-Testnet", ""] {
        assert!(matches!(
            verify_group_write_payment(&policy, &target(), network, &raw),
            Err(GroupPaymentError::WrongNetwork { .. })
        ));
    }
}

#[test]
fn a_payment_funds_only_the_write_and_relay_it_commits_to() {
    let policy = policy(GroupWritePayee::Burn);
    let raw = pay(
        MONAD_TESTNET_CHAIN_ID,
        BURN_ADDRESS,
        policy.price_wei,
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
            verify_group_write_payment(&policy, &target, "monad-testnet", &raw),
            Err(GroupPaymentError::WrongCommitment)
        );
    }
    // The same burn presented to another relay commits to the wrong host.
    let mut other_relay = policy.clone();
    other_relay.host_origin = "https://other.example".into();
    assert_eq!(
        verify_group_write_payment(&other_relay, &target(), "monad-testnet", &raw),
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
        let raw = pay(
            MONAD_TESTNET_CHAIN_ID,
            BURN_ADDRESS,
            policy.price_wei,
            &calldata,
        );
        assert_eq!(
            verify_group_write_payment(&policy, &target(), "monad-testnet", &raw),
            Err(GroupPaymentError::WrongCommitment)
        );
    }
}

#[test]
fn malformed_bytes_are_refused() {
    let policy = policy(GroupWritePayee::Burn);
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
            verify_group_write_payment(&policy, &target(), "monad-testnet", &bytes),
            Err(GroupPaymentError::Malformed),
            "{}",
            hex::encode(&bytes)
        );
    }
    let oversized = vec![0xc0; MAX_GROUP_PAYMENT_BYTES + 1];
    assert_eq!(
        verify_group_write_payment(&policy, &target(), "monad-testnet", &oversized),
        Err(GroupPaymentError::Malformed)
    );
}

#[test]
fn payees_parse_from_operator_configuration() {
    use cashweb_config::GroupWritePayeeConf as C;
    assert_eq!(
        GroupWritePayee::from_conf(&C::Burn),
        Ok(GroupWritePayee::Burn)
    );
    assert_eq!(
        GroupWritePayee::from_conf(&C::Address(
            "0x00000000000000000000000000000000000000AA".into()
        )),
        Ok(GroupWritePayee::Address(address(
            "00000000000000000000000000000000000000aa"
        )))
    );
    for bad in [
        "",
        "0x",
        "00000000000000000000000000000000000000aa00",
        "0xzz00000000000000000000000000000000000000",
    ] {
        assert_eq!(
            GroupWritePayee::from_conf(&C::Address(bad.into())),
            Err(GroupPayeeError::InvalidAddress),
            "{bad}"
        );
    }
    assert!(matches!(
        GroupWritePayee::from_conf(&C::Xpub(XPUB.into())),
        Ok(GroupWritePayee::Xpub(_))
    ));
    // A private key, a bad checksum, and plain garbage are not payees.
    let xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    let mut bad_checksum = XPUB.to_owned();
    bad_checksum.pop();
    bad_checksum.push('9');
    for bad in [xprv, bad_checksum.as_str(), "xpub", "not base58 0OIl"] {
        assert_eq!(
            GroupWritePayee::from_conf(&C::Xpub(bad.into())),
            Err(GroupPayeeError::InvalidXpub),
            "{bad}"
        );
    }
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
