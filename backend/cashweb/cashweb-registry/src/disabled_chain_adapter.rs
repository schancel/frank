//! Fail-closed chain adapter used when an operator deliberately runs a Monad-only server.

use async_trait::async_trait;
use bitcoinsuite_core::{Script, Sha256, Sha256d};
use bitcoinsuite_error::{bail, Result};
use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};
use tokio::sync::mpsc;

/// Rejects every Lotus-chain operation while leaving chain-independent Monad routes available.
#[derive(Debug, Default)]
pub struct DisabledChainAdapter;

fn lotus_disabled<T>() -> Result<T> {
    bail!("Lotus support is disabled: configure [bitcoin_rpc] to enable legacy Lotus routes")
}

#[async_trait]
impl ChainAdapter for DisabledChainAdapter {
    async fn submit_tx(&self, _raw_tx: &[u8]) -> Result<SubmitTxOutcome> {
        lotus_disabled()
    }

    async fn get_tx(&self, _txid: &Sha256d) -> Result<Option<Vec<u8>>> {
        lotus_disabled()
    }

    async fn test_accept(&self, _raw_tx: &[u8]) -> Result<MempoolAcceptResult> {
        lotus_disabled()
    }

    async fn subscribe_new_blocks(&self) -> Result<mpsc::Receiver<Sha256d>> {
        lotus_disabled()
    }

    fn decode_burn(&self, _commitment_id: [u8; 4], _burn_output_script: &Script) -> Result<Sha256> {
        lotus_disabled()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_legacy_chain_operations() {
        let adapter = DisabledChainAdapter;
        let error = adapter.submit_tx(&[1, 2, 3]).await.unwrap_err();
        assert!(error.to_string().contains("Lotus support is disabled"));
    }
}
