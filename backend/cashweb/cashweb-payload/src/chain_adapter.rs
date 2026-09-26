//! Module defining the [`ChainAdapter`] boundary: the abstraction between cashweb's
//! chain-agnostic protocol logic and a specific underlying blockchain.
//!
//! Today the only implementation is Lotus (see `cashweb_registry::lotus_adapter::LotusAdapter`,
//! which wraps `bitcoinsuite_bitcoind::rpc_client::BitcoindRpcClient`). The trait exists so a
//! future chain (e.g. Monad) can be supported by adding a new impl of this trait, instead of a
//! rewrite of the protocol-level code (registry, HTTP handlers) that depends on it.
//!
//! No behavior change is intended by introducing this trait: it's a boundary drawn around the
//! Lotus/bitcoind calls that already exist in `cashweb-registry`.

use async_trait::async_trait;
use bitcoinsuite_core::{Script, Sha256, Sha256d};
use bitcoinsuite_error::Result;

/// Outcome of submitting a raw tx to the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitTxOutcome {
    /// The tx was newly broadcast into the mempool/network, with the given txid.
    Broadcast(Sha256d),
    /// The tx could not be (re-)submitted because it was already confirmed in a block by the
    /// time of submission. This is a broadcast race (another submitter/miner got there first),
    /// not a rejection of the tx itself, so callers should treat it like a successful broadcast.
    AlreadyConfirmed,
}

/// Result of testing whether a raw tx would currently be accepted by the network, without
/// actually broadcasting it. `Err(reason)` means the node would reject it, with a
/// human-readable reason.
pub type MempoolAcceptResult = std::result::Result<(), String>;

/// Boundary trait covering every chain-specific operation cashweb's protocol logic needs.
///
/// Implementations own all chain-specific RPC/wire logic (e.g. bitcoind JSON-RPC for Lotus).
/// Code above this trait (registry, payload verification, HTTP handlers) should depend only on
/// `ChainAdapter`, never directly on a chain-specific client.
#[async_trait]
pub trait ChainAdapter: std::fmt::Debug + Send + Sync {
    /// Submit an already-signed raw transaction to the network.
    async fn submit_tx(&self, raw_tx: &[u8]) -> Result<SubmitTxOutcome>;

    /// Fetch a transaction's raw bytes by its id, if the node currently knows about it
    /// (mempool or confirmed). Returns `None` if the node has never seen it.
    async fn get_tx(&self, txid: &Sha256d) -> Result<Option<Vec<u8>>>;

    /// Test whether a raw tx would currently be accepted into the mempool, without
    /// broadcasting it. Used to validate not-yet-broadcast txs before submission.
    async fn test_accept(&self, raw_tx: &[u8]) -> Result<MempoolAcceptResult>;

    /// Subscribe to newly connected blocks, receiving each new tip's block hash as it appears.
    async fn subscribe_new_blocks(&self) -> Result<tokio::sync::mpsc::Receiver<Sha256d>>;

    /// Decode a payment/burn commitment from a burn output script, checking that it carries
    /// the given LOKAD ID and is well-formed. Returns the parsed 32-byte commitment.
    fn decode_burn(&self, commitment_id: [u8; 4], burn_output_script: &Script) -> Result<Sha256>;
}
