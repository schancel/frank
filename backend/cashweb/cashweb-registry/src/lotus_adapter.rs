//! [`LotusAdapter`]: the Lotus (bitcoind) implementation of
//! [`cashweb_payload::chain_adapter::ChainAdapter`].
//!
//! This module is a pure extraction: every RPC call here was already made against
//! `bitcoind: BitcoindRpcClient` directly inside [`crate::registry::Registry`] before this
//! boundary existed. No behavior change is intended.

use std::time::Duration;

use async_trait::async_trait;
use bitcoinsuite_bitcoind::{rpc_client::BitcoindRpcClient, BitcoindError};
use bitcoinsuite_core::{Hashed, Script, Sha256, Sha256d};
use bitcoinsuite_error::Result;
use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};
use tokio::sync::mpsc;

/// Prefix of the bitcoind error message returned by `getrawtransaction` when the node has never
/// seen the given txid (mempool or confirmed).
const TX_NOT_FOUND_MESSAGE_PREFIX: &str = "No such mempool or blockchain transaction.";

/// JSON-RPC error code bitcoind returns from `sendrawtransaction` when the tx is already
/// confirmed in a block (a broadcast race, not an invalid tx).
const ALREADY_IN_BLOCKCHAIN_CODE: i32 = -27;

/// How often [`LotusAdapter::subscribe_new_blocks`] polls bitcoind for a new tip, since Lotus'
/// bitcoind doesn't expose a push-based subscription to this crate today (see `PLAN.md`'s note
/// about the ZMQ/NNG block-tip watcher being out of scope for this milestone).
const NEW_BLOCK_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// [`ChainAdapter`] implementation backed by a Lotus `bitcoind` JSON-RPC client.
#[derive(Debug, Clone)]
pub struct LotusAdapter {
    bitcoind: BitcoindRpcClient,
}

impl LotusAdapter {
    /// Wrap a [`BitcoindRpcClient`] as a [`ChainAdapter`].
    pub fn new(bitcoind: BitcoindRpcClient) -> Self {
        LotusAdapter { bitcoind }
    }
}

#[async_trait]
impl ChainAdapter for LotusAdapter {
    async fn submit_tx(&self, raw_tx: &[u8]) -> Result<SubmitTxOutcome> {
        let broadcast_result = self
            .bitcoind
            .cmd_text("sendrawtransaction", &[hex::encode(raw_tx).into()])
            .await;
        match broadcast_result {
            Ok(txid_hex) => Ok(SubmitTxOutcome::Broadcast(Sha256d::from_hex_be(&txid_hex)?)),
            Err(err) => {
                let err = err.downcast::<BitcoindError>()?;
                match err {
                    BitcoindError::JsonRpcCode {
                        code: ALREADY_IN_BLOCKCHAIN_CODE,
                        ..
                    } => Ok(SubmitTxOutcome::AlreadyConfirmed),
                    err => Err(err.into()),
                }
            }
        }
    }

    async fn get_tx(&self, txid: &Sha256d) -> Result<Option<Vec<u8>>> {
        match self
            .bitcoind
            .cmd_text("getrawtransaction", &[txid.to_string().into()])
            .await
        {
            Ok(tx_hex) => Ok(Some(hex::decode(tx_hex)?)),
            Err(err) => {
                let err = err.downcast::<BitcoindError>()?;
                match err {
                    BitcoindError::JsonRpcCode { code: -5, message }
                        if message.starts_with(TX_NOT_FOUND_MESSAGE_PREFIX) =>
                    {
                        Ok(None)
                    }
                    err => Err(err.into()),
                }
            }
        }
    }

    async fn test_accept(&self, raw_tx: &[u8]) -> Result<MempoolAcceptResult> {
        self.bitcoind.test_mempool_accept(raw_tx).await
    }

    async fn subscribe_new_blocks(&self) -> Result<mpsc::Receiver<Sha256d>> {
        let (sender, receiver) = mpsc::channel(16);
        let bitcoind = self.bitcoind.clone();
        tokio::spawn(async move {
            let mut last_tip: Option<Sha256d> = None;
            loop {
                if let Ok(hash_text) = bitcoind.cmd_text("getbestblockhash", &[]).await {
                    if let Ok(tip) = Sha256d::from_hex_be(&hash_text) {
                        if last_tip.as_ref() != Some(&tip) {
                            last_tip = Some(tip.clone());
                            if sender.send(tip).await.is_err() {
                                // Receiver dropped; stop polling.
                                break;
                            }
                        }
                    }
                }
                tokio::time::sleep(NEW_BLOCK_POLL_INTERVAL).await;
            }
        });
        Ok(receiver)
    }

    fn decode_burn(&self, commitment_id: [u8; 4], burn_output_script: &Script) -> Result<Sha256> {
        cashweb_payload::verify::parse_commitment(commitment_id, burn_output_script)
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use bitcoinsuite_bitcoind::instance::{BitcoindChain, BitcoindConf, BitcoindInstance};
    use bitcoinsuite_core::{
        ecc::Ecc, BitcoinCode, Hashed, LotusAddress, Net, Network, P2PKHSignatory, Script,
        SequenceNo, ShaRmd160, SigHashType, SignData, SignField, TxBuilder, TxBuilderInput,
        TxInput, TxOutput, UnhashedTx,
    };
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use bitcoinsuite_error::Result;
    use bitcoinsuite_test_utils::bin_folder;
    use bitcoinsuite_test_utils_blockchain::setup_bitcoind_coins;
    use cashweb_payload::{
        chain_adapter::{ChainAdapter, SubmitTxOutcome},
        verify::{build_commitment_script, ADDRESS_METADATA_LOKAD_ID},
    };
    use tokio::time::{timeout, Duration};

    use super::LotusAdapter;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    // Needs a real `lotusd` binary under `BITCOINSUITE_BIN_DIR` -- unavailable in CI and most
    // dev environments: the upstream download bucket (storage.googleapis.com/lotus-project) is
    // permanently gone (see `ensure-bitcoind.sh`'s comment), and Lotus support is intentionally
    // dormant for this hackathon port (PLAN.md constraint 2 -- the `ChainAdapter` boundary is
    // kept so Lotus support can come back later, not exercised now). Run manually with
    // `cargo test -- --ignored` against a real lotusd if/when that work resumes.
    #[ignore = "requires a real lotusd binary; see comment above"]
    async fn test_lotus_adapter() -> Result<()> {
        let _ = bitcoinsuite_error::install();
        let conf = BitcoindConf::from_chain_regtest(
            bin_folder(),
            BitcoindChain::XPI,
            vec![OsString::from("-txindex")],
        )?;
        let mut instance = BitcoindInstance::setup(conf)?;
        instance.wait_for_ready()?;
        let bitcoind = instance.rpc_client();
        let adapter = LotusAdapter::new(bitcoind.clone());

        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([7; 32])?;
        let pubkey = ecc.derive_pubkey(&seckey);
        let address = LotusAddress::new(
            "lotus",
            Net::Regtest,
            Script::p2pkh(&ShaRmd160::digest(pubkey.array().into())),
        );
        let mut utxos = setup_bitcoind_coins(
            instance.cli(),
            Network::XPI,
            10,
            address.as_str(),
            &address.script().hex(),
        )?;

        // Build a valid burn tx.
        let payload_hash = bitcoinsuite_core::Sha256::digest([1, 2, 3].as_slice().into());
        let commitment_script =
            build_commitment_script(ADDRESS_METADATA_LOKAD_ID, pubkey.array(), &payload_hash);
        let (outpoint, value) = utxos.pop().unwrap();
        let burn_amount = value - 10_000;
        let tx = UnhashedTx {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput {
                value: burn_amount,
                script: commitment_script.clone(),
            }],
            lock_time: 0,
        };
        let mut tx_builder = TxBuilder::from_tx(tx);
        tx_builder.inputs.push(TxBuilderInput::new(
            TxInput {
                prev_out: outpoint,
                script: Script::default(),
                sequence: SequenceNo::finalized(),
                sign_data: Some(SignData::new(vec![
                    SignField::OutputScript(address.script().clone()),
                    SignField::Value(value),
                ])),
            },
            Box::new(P2PKHSignatory {
                seckey: seckey.clone(),
                pubkey,
                sig_hash_type: SigHashType::ALL_BIP143,
            }),
        ));
        let tx = tx_builder.sign(&ecc, 1000, 546)?;
        let raw_tx = tx.ser().to_vec();
        let txid = bitcoinsuite_core::lotus_txid(&tx);

        // get_tx: unknown before broadcast.
        assert_eq!(adapter.get_tx(&txid).await?, None);

        // test_accept: valid tx should be accepted.
        assert_eq!(adapter.test_accept(&raw_tx).await?, Ok(()));

        // subscribe_new_blocks: should observe a new tip after generating a block.
        let mut new_blocks = adapter.subscribe_new_blocks().await?;

        // submit_tx: should broadcast and return the same txid we computed locally.
        let outcome = adapter.submit_tx(&raw_tx).await?;
        assert_eq!(outcome, SubmitTxOutcome::Broadcast(txid.clone()));

        // get_tx: now known, and its raw bytes match what we submitted.
        let fetched = adapter.get_tx(&txid).await?;
        assert_eq!(fetched, Some(raw_tx.clone()));

        // Mine the tx into a block and confirm subscribe_new_blocks reports the new tip.
        bitcoind
            .cmd_text("generatetoaddress", &[1i32.into(), address.as_str().into()])
            .await?;
        let observed_tip = timeout(Duration::from_secs(10), new_blocks.recv())
            .await
            .expect("timed out waiting for new block notification")
            .expect("new block channel closed unexpectedly");
        let best_hash = bitcoind.cmd_text("getbestblockhash", &[]).await?;
        assert_eq!(observed_tip.to_string(), best_hash);

        // submit_tx: re-submitting the now-confirmed tx should report AlreadyConfirmed.
        let outcome = adapter.submit_tx(&raw_tx).await?;
        assert_eq!(outcome, SubmitTxOutcome::AlreadyConfirmed);

        // decode_burn: recovers the exact commitment we embedded.
        let expected_commitment = cashweb_payload::verify::parse_commitment(
            ADDRESS_METADATA_LOKAD_ID,
            &commitment_script,
        )?;
        let decoded = adapter.decode_burn(ADDRESS_METADATA_LOKAD_ID, &commitment_script)?;
        assert_eq!(decoded, expected_commitment);

        instance.cleanup()?;
        Ok(())
    }
}
