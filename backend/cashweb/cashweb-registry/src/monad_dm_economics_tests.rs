//! C0 pins the existing financial owner; no canonical transport is activated.
use std::sync::Arc;

use bitcoinsuite_core::{ecc::Ecc, Hashed, Net, Sha256};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::Result;
use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;

use crate::{
    disabled_chain_adapter::DisabledChainAdapter,
    monad_evm_tx::{decode_signed_transaction, test_support::signed_eip1559_tx},
    monad_http::Address,
    monad_stamp_stealth::{derive_monad_stamp_child_public, recipient_address_from_public_key},
    monad_stamp_verify::COMMITMENT_VERSION_TAG,
    proto,
    registry::Registry,
    store::{
        db::Db,
        monad_outbox::{MonadOutboxClaim, MonadOutboxLimits, MonadOutboxPolicy},
    },
};

#[test]
fn c0_signed_exact_set_is_one_reopened_owner_and_is_not_mailbox_delivery() -> Result<()> {
    let temp = tempdir::TempDir::new("c0-financial-owner")?;
    let path = temp.path().join("db");
    let encrypted_payload = b"opaque legacy economic obligation".to_vec();
    let hash: [u8; 32] = Sha256::digest(encrypted_payload.clone().into())
        .as_slice()
        .try_into()
        .unwrap();
    let recipient_pubkey = vec![2; 33];
    let policy = MonadOutboxPolicy::new(
        recipient_address_from_public_key(&recipient_pubkey).unwrap(),
        recipient_pubkey.clone(),
        10,
        b"testnet".to_vec(),
    )?;
    let ecc = EccSecp256k1::default();
    let payments = (0..2)
        .map(|index| {
            let key = ecc.seckey_from_array([index as u8 + 1; 32]).unwrap();
            let child = derive_monad_stamp_child_public(hash, &recipient_pubkey, index).unwrap();
            let mut preimage = b"frank:dm-stamp-payment:v1".to_vec();
            preimage.extend_from_slice(&hash);
            preimage.extend_from_slice(&index.to_be_bytes());
            let commitment = Sha256::digest(preimage.into());
            let mut input = Vec::from(BROADCAST_MESSAGE_LOKAD_ID);
            input.push(COMMITMENT_VERSION_TAG);
            input.extend_from_slice(commitment.as_slice());
            let (raw_tx, _) = signed_eip1559_tx(
                &key,
                41_454,
                index as u64,
                Address(child.address),
                5,
                &input,
            );
            let decoded = decode_signed_transaction(&raw_tx).unwrap();
            assert_eq!(decoded.value_wei, 5);
            assert_eq!(decoded.nonce, index as u64);
            assert_eq!(decoded.input, input);
            proto::MonadStampPayment {
                child_index: index,
                raw_tx,
            }
        })
        .collect();
    let request = proto::MonadStampedMessage {
        encrypted_payload,
        payload_hash: hash.to_vec(),
        stamp_payments: payments,
    };
    let limits = MonadOutboxLimits::default();
    {
        let registry = Registry::new(
            Db::open(&path)?,
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        );
        assert_eq!(
            registry.claim_monad_outbox(&request, &policy, 1, &limits)?,
            MonadOutboxClaim::New
        );
        assert!(registry.get_monad_message(&hash)?.is_none());
    }
    let registry = Registry::new(
        Db::open(&path)?,
        Arc::new(DisabledChainAdapter),
        Net::Regtest,
    );
    assert!(matches!(
        registry.claim_monad_outbox(&request, &policy, 2, &limits)?,
        MonadOutboxClaim::ExistingExact(_)
    ));
    let mut reordered = request.clone();
    reordered.stamp_payments.reverse();
    assert_eq!(
        registry.claim_monad_outbox(&reordered, &policy, 2, &limits)?,
        MonadOutboxClaim::Conflict
    );
    let snapshot = registry
        .monad_outbox_reconciliation_snapshot(&hash)?
        .unwrap();
    assert_eq!(snapshot.message, request);
    assert_eq!(snapshot.members.len(), 2);
    assert!(registry.get_monad_message(&hash)?.is_none());
    Ok(())
}
