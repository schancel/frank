//! [`MonadHttpClient`]: a thin JSON-RPC-over-HTTPS client for Monad (an EVM-compatible chain),
//! talking to an Alchemy-hosted RPC endpoint.
//!
//! ## Scope (ticket #12)
//!
//! This module implements the plain HTTPS request/response JSON-RPC methods needed to submit a
//! transaction and read back chain state:
//! - `eth_sendRawTransaction` ([`MonadHttpClient::send_raw_transaction`])
//! - `eth_getTransactionReceipt` ([`MonadHttpClient::get_transaction_receipt`])
//! - `eth_getLogs` ([`MonadHttpClient::get_logs`])
//! - `eth_getTransactionByHash` ([`MonadHttpClient::get_transaction_by_hash`])
//! - `eth_getRawTransactionByHash` ([`MonadHttpClient::get_raw_transaction_by_hash`])
//!
//! plus a small `eth_blockNumber` helper ([`MonadHttpClient::block_number`]) used to bound
//! `eth_getLogs` block ranges (both in the live smoke test and for general callers).
//!
//! ## `eth_getTransactionByHash` (ticket #25)
//!
//! Originally out of scope here (see the note below), this was added once ticket #25 (assembling
//! `MonadAdapter`) hit the same gap two other in-flight tickets (#16's `monad_stamp_verify.rs` and
//! #23's `monad_pop_verify.rs`) had already independently worked around with their own private
//! `JsonRpcTransport`-based calls: `TransactionReceipt` doesn't carry `to`/`value`/`input` (those
//! live on the transaction itself), so verifying a burn/payment's value and calldata needs the
//! full transaction. Both call sites now consume [`MonadHttpClient::get_transaction_by_hash`]
//! instead of duplicating the call.
//!
//! **This is deliberately *not* a [`cashweb_payload::chain_adapter::ChainAdapter`]
//! implementation.** Ticket #15 (the `eth_subscribe("newHeads")` WS path) is being implemented
//! in parallel against the same eventual `MonadAdapter`, owning `monad_ws.rs`. To avoid both
//! tickets editing the same file, this module only exposes a standalone
//! [`MonadHttpClient`] struct with plain async methods; assembling this together with the WS
//! client into a single `impl ChainAdapter for MonadAdapter` is out of scope here (tracked under
//! the parent ticket #2).
//!
//! The endpoint URL (including any Alchemy API key embedded in its path) is passed in by the
//! caller (e.g. read from the `MONAD_TESTNET_HTTP_RPC_URL` env var) — this module never reads
//! env/config itself and never hardcodes an endpoint or key.

use std::{
    fmt,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

/// A 32-byte hash (transaction hash, block hash, or log topic), hex-encoded with a `0x` prefix
/// on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Hash32(pub [u8; 32]);

/// A 20-byte address, hex-encoded with a `0x` prefix on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address(pub [u8; 20]);

/// Error parsing a [`Hash32`] or [`Address`] from a hex string.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HexTypeError {
    /// The string didn't start with `0x`, or wasn't valid hex.
    #[error("expected a 0x-prefixed hex string, got {0:?}")]
    InvalidHex(String),
    /// The string was valid hex, but not the expected byte length.
    #[error("expected {expected} bytes, got {actual}")]
    WrongLength {
        /// Expected number of bytes.
        expected: usize,
        /// Actual number of bytes found.
        actual: usize,
    },
}

fn encode_0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn parse_fixed_hex<const N: usize>(s: &str) -> Result<[u8; N], HexTypeError> {
    let stripped = s
        .strip_prefix("0x")
        .ok_or_else(|| HexTypeError::InvalidHex(s.to_string()))?;
    let bytes = hex::decode(stripped).map_err(|_| HexTypeError::InvalidHex(s.to_string()))?;
    let actual = bytes.len();
    bytes.try_into().map_err(|_| HexTypeError::WrongLength {
        expected: N,
        actual,
    })
}

macro_rules! impl_hex_type {
    ($ty:ident, $len:expr) => {
        impl $ty {
            /// Parse from a `0x`-prefixed hex string.
            pub fn from_hex(s: &str) -> Result<Self, HexTypeError> {
                Ok($ty(parse_fixed_hex::<$len>(s)?))
            }

            /// Encode as a `0x`-prefixed hex string.
            pub fn to_hex(&self) -> String {
                encode_0x(&self.0)
            }
        }

        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.to_hex())
            }
        }

        impl fmt::Debug for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($ty), self.to_hex())
            }
        }

        impl std::str::FromStr for $ty {
            type Err = HexTypeError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                $ty::from_hex(s)
            }
        }

        impl Serialize for $ty {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                serializer.serialize_str(&self.to_hex())
            }
        }

        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                $ty::from_hex(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

impl_hex_type!(Hash32, 32);
impl_hex_type!(Address, 20);

/// Helpers for (de)serializing `0x`-prefixed hex quantities (integers), as used for e.g.
/// `blockNumber`, `gasUsed`, and `status` in JSON-RPC responses.
mod hex_quantity {
    use serde::{Deserialize, Deserializer};

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        parse(&s).map_err(serde::de::Error::custom)
    }

    pub(crate) mod option {
        use serde::{Deserialize, Deserializer};

        pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
        where
            D: Deserializer<'de>,
        {
            let opt = Option::<String>::deserialize(deserializer)?;
            opt.as_deref()
                .map(super::parse)
                .transpose()
                .map_err(serde::de::Error::custom)
        }
    }

    fn parse(s: &str) -> Result<u64, String> {
        super::parse_hex_quantity(s)
    }
}

fn parse_hex_quantity(s: &str) -> Result<u64, String> {
    let stripped = s
        .strip_prefix("0x")
        .ok_or_else(|| format!("expected a 0x-prefixed hex quantity, got {:?}", s))?;
    u64::from_str_radix(stripped, 16).map_err(|err| err.to_string())
}

/// A tag or explicit number for the `fromBlock`/`toBlock` params of `eth_getLogs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockTag {
    /// An explicit block number.
    Number(u64),
    /// The most recent block.
    Latest,
    /// The genesis block.
    Earliest,
    /// The pending block (not yet mined).
    Pending,
}

impl BlockTag {
    fn to_param(self) -> Value {
        match self {
            BlockTag::Number(n) => Value::String(format!("0x{:x}", n)),
            BlockTag::Latest => Value::String("latest".to_string()),
            BlockTag::Earliest => Value::String("earliest".to_string()),
            BlockTag::Pending => Value::String("pending".to_string()),
        }
    }
}

/// Filter parameters for `eth_getLogs`.
#[derive(Debug, Clone, Default)]
pub struct GetLogsFilter {
    /// Start of the block range (inclusive). `None` lets the node pick its default (`latest`).
    pub from_block: Option<BlockTag>,
    /// End of the block range (inclusive). `None` lets the node pick its default (`latest`).
    pub to_block: Option<BlockTag>,
    /// Only return logs emitted by this contract address, if given.
    pub address: Option<Address>,
    /// Topic filters, in order (`topics[0]` is typically the event signature hash). Each entry
    /// may itself be `None` (meaning "any value in this position").
    pub topics: Vec<Option<Hash32>>,
}

impl GetLogsFilter {
    fn to_params(&self) -> Value {
        let mut obj = serde_json::Map::new();
        if let Some(from_block) = self.from_block {
            obj.insert("fromBlock".to_string(), from_block.to_param());
        }
        if let Some(to_block) = self.to_block {
            obj.insert("toBlock".to_string(), to_block.to_param());
        }
        if let Some(address) = self.address {
            obj.insert("address".to_string(), Value::String(address.to_hex()));
        }
        if !self.topics.is_empty() {
            let topics: Vec<Value> = self
                .topics
                .iter()
                .map(|topic| match topic {
                    Some(hash) => Value::String(hash.to_hex()),
                    None => Value::Null,
                })
                .collect();
            obj.insert("topics".to_string(), Value::Array(topics));
        }
        Value::Array(vec![Value::Object(obj)])
    }
}

/// A single log entry, as returned by `eth_getLogs` or embedded in a [`TransactionReceipt`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    /// Address of the contract that emitted this log.
    pub address: Address,
    /// Indexed event topics.
    pub topics: Vec<Hash32>,
    /// Non-indexed event data.
    pub data: String,
    /// Block number this log was included in, if known (`None` for a pending log).
    #[serde(default, with = "hex_quantity::option")]
    pub block_number: Option<u64>,
    /// Hash of the transaction this log belongs to.
    pub transaction_hash: Hash32,
    /// Index of this log within the block, if known.
    #[serde(default, with = "hex_quantity::option")]
    pub log_index: Option<u64>,
    /// Whether this log was removed due to a chain reorg.
    #[serde(default)]
    pub removed: bool,
}

/// A transaction receipt, as returned by `eth_getTransactionReceipt`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionReceipt {
    /// Hash of the transaction this receipt is for.
    pub transaction_hash: Hash32,
    /// Hash of the block this transaction was included in.
    pub block_hash: Hash32,
    /// Number of the block this transaction was included in.
    #[serde(with = "hex_quantity")]
    pub block_number: u64,
    /// Address that sent this transaction.
    pub from: Address,
    /// Address this transaction was sent to (`None` for a contract-creation transaction).
    #[serde(default)]
    pub to: Option<Address>,
    /// Address of the contract created by this transaction, if it created one.
    #[serde(default)]
    pub contract_address: Option<Address>,
    /// Total gas used by this transaction.
    #[serde(with = "hex_quantity")]
    pub gas_used: u64,
    /// `0x1` (success) or `0x0` (reverted) post-Byzantium status code.
    #[serde(default, with = "hex_quantity::option")]
    pub status: Option<u64>,
    /// Logs emitted by this transaction.
    #[serde(default)]
    pub logs: Vec<Log>,
}

impl TransactionReceipt {
    /// Whether the transaction succeeded, per its `status` code. `None` if the node didn't
    /// report a status (only possible pre-Byzantium; not expected on Monad).
    pub fn succeeded(&self) -> Option<bool> {
        self.status.map(|status| status == 1)
    }
}

/// Helpers for (de)serializing a `0x`-prefixed hex quantity too large for `u64` (e.g. a
/// transaction's `value`, denominated in wei, which can exceed `u64::MAX`), parsed as `u128`.
mod hex_quantity_u128 {
    use serde::{Deserialize, Deserializer};

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<u128, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let stripped = s.strip_prefix("0x").ok_or_else(|| {
            serde::de::Error::custom(format!("expected a 0x-prefixed hex quantity, got {:?}", s))
        })?;
        let digits = if stripped.is_empty() { "0" } else { stripped };
        u128::from_str_radix(digits, 16).map_err(serde::de::Error::custom)
    }
}

/// Helper for deserializing a `0x`-prefixed hex byte blob (e.g. a transaction's `input` calldata)
/// into raw bytes.
mod hex_bytes {
    use serde::{Deserialize, Deserializer};

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let stripped = s.strip_prefix("0x").ok_or_else(|| {
            serde::de::Error::custom(format!("expected 0x-prefixed hex data, got {:?}", s))
        })?;
        hex::decode(stripped).map_err(serde::de::Error::custom)
    }
}

/// A transaction, as returned by `eth_getTransactionByHash`. Unlike [`TransactionReceipt`], this
/// carries the transaction's `value` and `input` (calldata) fields, which live on the transaction
/// itself rather than its receipt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    /// Hash of this transaction.
    pub hash: Hash32,
    /// Address that sent this transaction.
    pub from: Address,
    /// Recipient address (`None` for a contract-creation transaction).
    #[serde(default)]
    pub to: Option<Address>,
    /// Value transferred, in wei (parsed as `u128`: can exceed `u64::MAX`).
    #[serde(deserialize_with = "hex_quantity_u128::deserialize")]
    pub value: u128,
    /// Raw calldata (the `input` field).
    #[serde(deserialize_with = "hex_bytes::deserialize")]
    pub input: Vec<u8>,
}

/// Errors from a Monad JSON-RPC call, distinguishing transport-level failures from RPC-level
/// errors returned by the node, and further classifying the RPC-level errors we expect
/// downstream callers (M3/M4) to need to branch on.
#[derive(Debug, Error)]
pub enum MonadRpcError {
    /// The HTTP request itself failed (connection error, timeout, TLS error, etc).
    #[error("transport error calling {method}: {source}")]
    Transport {
        /// JSON-RPC method being called.
        method: String,
        /// Underlying transport error.
        #[source]
        source: reqwest::Error,
    },

    /// The node returned a non-2xx HTTP status.
    #[error("HTTP {status} calling {method}: {body}")]
    HttpStatus {
        /// JSON-RPC method being called.
        method: String,
        /// HTTP status code returned.
        status: u16,
        /// Response body (for diagnostics).
        body: String,
    },

    /// The response body wasn't valid JSON-RPC (malformed JSON, missing both `result` and
    /// `error`), or `result` wasn't shaped the way this method expects.
    #[error("invalid JSON-RPC response for {method}: {reason}")]
    InvalidResponse {
        /// JSON-RPC method being called.
        method: String,
        /// Human-readable reason the response was rejected.
        reason: String,
    },

    /// The submitted tx's nonce was lower than the account's current nonce (already used).
    #[error("nonce too low calling {method}: {message}")]
    NonceTooLow {
        /// JSON-RPC method being called.
        method: String,
        /// Raw message from the node.
        message: String,
    },

    /// The sending account doesn't have enough balance to cover `value + gas * gasPrice`.
    #[error("insufficient funds calling {method}: {message}")]
    InsufficientFunds {
        /// JSON-RPC method being called.
        method: String,
        /// Raw message from the node.
        message: String,
    },

    /// A transaction with the same nonce is already pending and this one doesn't bump the gas
    /// price enough to replace it.
    #[error("replacement transaction underpriced calling {method}: {message}")]
    ReplacementUnderpriced {
        /// JSON-RPC method being called.
        method: String,
        /// Raw message from the node.
        message: String,
    },

    /// The node already has this exact transaction (e.g. a duplicate submission).
    #[error("transaction already known calling {method}: {message}")]
    AlreadyKnown {
        /// JSON-RPC method being called.
        method: String,
        /// Raw message from the node.
        message: String,
    },

    /// Any other RPC-level error the node returned, not classified into a more specific variant
    /// above.
    #[error("RPC error {code} calling {method}: {message} (data: {data:?})")]
    Rpc {
        /// JSON-RPC method being called.
        method: String,
        /// JSON-RPC error code.
        code: i64,
        /// Raw message from the node.
        message: String,
        /// Optional structured error data from the node.
        data: Option<Value>,
    },
}

impl MonadRpcError {
    fn transport(method: &str, source: reqwest::Error) -> Self {
        MonadRpcError::Transport {
            method: method.to_string(),
            source,
        }
    }
}

/// Classify a raw JSON-RPC error object into a [`MonadRpcError`], recognizing well-known
/// EVM-node error message patterns (these providers, including Alchemy, don't expose stable
/// error *codes* for these cases, only conventional message text, so classification is
/// message-pattern based).
fn classify_rpc_error(method: &str, error: JsonRpcErrorBody) -> MonadRpcError {
    let method = method.to_string();
    let lower = error.message.to_lowercase();
    if lower.contains("nonce too low") {
        MonadRpcError::NonceTooLow {
            method,
            message: error.message,
        }
    } else if lower.contains("insufficient funds") {
        MonadRpcError::InsufficientFunds {
            method,
            message: error.message,
        }
    } else if lower.contains("replacement transaction underpriced") {
        MonadRpcError::ReplacementUnderpriced {
            method,
            message: error.message,
        }
    } else if lower.contains("already known") {
        MonadRpcError::AlreadyKnown {
            method,
            message: error.message,
        }
    } else {
        MonadRpcError::Rpc {
            method,
            code: error.code,
            message: error.message,
            data: error.data,
        }
    }
}

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: Value,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<JsonRpcErrorBody>,
}

#[derive(Deserialize, Debug, Clone)]
struct JsonRpcErrorBody {
    code: i64,
    message: String,
    #[serde(default)]
    data: Option<Value>,
}

/// Transport abstraction for a single JSON-RPC call, so [`MonadHttpClient`]'s request-shaping
/// logic (method name, params encoding) can be unit-tested against a mock without a real network
/// call. [`HttpTransport`] is the real implementation, POSTing to an HTTPS endpoint.
#[async_trait]
pub trait JsonRpcTransport: fmt::Debug + Send + Sync {
    /// Perform a single JSON-RPC call, returning the decoded `result` value on success, or a
    /// classified [`MonadRpcError`] on transport/HTTP/RPC failure.
    async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError>;
}

/// Real [`JsonRpcTransport`], POSTing JSON-RPC requests to an HTTPS endpoint via `reqwest`.
#[derive(Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
    rpc_url: url::Url,
    next_id: Arc<AtomicU64>,
}

impl HttpTransport {
    /// Wrap an RPC endpoint URL (e.g. an Alchemy Monad testnet URL with the API key embedded in
    /// its path) as a [`HttpTransport`]. The caller is responsible for sourcing the URL (e.g.
    /// from the `MONAD_TESTNET_HTTP_RPC_URL` env var) — this never reads env/config itself.
    pub fn new(rpc_url: url::Url) -> Self {
        HttpTransport {
            client: reqwest::Client::new(),
            rpc_url,
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl fmt::Debug for HttpTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Deliberately don't print the full URL: Alchemy embeds the API key in the URL path.
        f.debug_struct("HttpTransport")
            .field(
                "rpc_url_origin",
                &format!(
                    "{}://{}",
                    self.rpc_url.scheme(),
                    self.rpc_url.host_str().unwrap_or("<unknown-host>")
                ),
            )
            .finish()
    }
}

#[async_trait]
impl JsonRpcTransport for HttpTransport {
    async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        // Serialize/send manually (rather than reqwest's `.json()` convenience, which needs the
        // `json` feature) to avoid adding another feature-flag dependency for this one call
        // site.
        let body =
            serde_json::to_vec(&request).map_err(|source| MonadRpcError::InvalidResponse {
                method: method.to_string(),
                reason: source.to_string(),
            })?;
        let response = self
            .client
            .post(self.rpc_url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|source| MonadRpcError::transport(method, source))?;

        let status = response.status();
        let body_bytes = response
            .bytes()
            .await
            .map_err(|source| MonadRpcError::transport(method, source))?;

        if !status.is_success() {
            return Err(MonadRpcError::HttpStatus {
                method: method.to_string(),
                status: status.as_u16(),
                body: String::from_utf8_lossy(&body_bytes).into_owned(),
            });
        }

        let parsed: JsonRpcResponse = serde_json::from_slice(&body_bytes).map_err(|source| {
            MonadRpcError::InvalidResponse {
                method: method.to_string(),
                reason: source.to_string(),
            }
        })?;

        if let Some(error) = parsed.error {
            return Err(classify_rpc_error(method, error));
        }
        Ok(parsed.result)
    }
}

/// Outcome of [`MonadHttpClient::send_raw_transaction`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubmittedTx {
    /// Hash of the newly-submitted transaction, as returned by `eth_sendRawTransaction`.
    pub tx_hash: Hash32,
}

/// Thin JSON-RPC-over-HTTPS client for Monad, generic over its [`JsonRpcTransport`] so tests can
/// substitute a mock transport. Use [`MonadHttpClient::new`] for the real HTTPS client.
#[derive(Debug, Clone)]
pub struct MonadHttpClient<T: JsonRpcTransport = HttpTransport> {
    transport: T,
}

impl MonadHttpClient<HttpTransport> {
    /// Construct a client talking to a real HTTPS JSON-RPC endpoint (e.g. Alchemy's Monad
    /// testnet URL). The caller sources `rpc_url` from env/config; never hardcode it.
    pub fn new(rpc_url: url::Url) -> Self {
        MonadHttpClient {
            transport: HttpTransport::new(rpc_url),
        }
    }
}

impl<T: JsonRpcTransport> MonadHttpClient<T> {
    /// Construct a client around an arbitrary [`JsonRpcTransport`] (e.g. a mock, for testing
    /// request-shaping logic without a network call).
    pub fn with_transport(transport: T) -> Self {
        MonadHttpClient { transport }
    }

    /// Submit an already-signed raw transaction via `eth_sendRawTransaction`.
    ///
    /// `raw_tx` is the RLP-encoded signed transaction bytes; this method hex-encodes it with a
    /// `0x` prefix as the sole JSON-RPC param, per the Ethereum JSON-RPC spec.
    pub async fn send_raw_transaction(&self, raw_tx: &[u8]) -> Result<SubmittedTx, MonadRpcError> {
        let params = json!([encode_0x(raw_tx)]);
        let result = self
            .transport
            .call("eth_sendRawTransaction", params)
            .await?;
        let tx_hash_hex = result
            .as_str()
            .ok_or_else(|| MonadRpcError::InvalidResponse {
                method: "eth_sendRawTransaction".to_string(),
                reason: format!("expected a hex string tx hash, got {}", result),
            })?;
        let tx_hash =
            Hash32::from_hex(tx_hash_hex).map_err(|err| MonadRpcError::InvalidResponse {
                method: "eth_sendRawTransaction".to_string(),
                reason: err.to_string(),
            })?;
        Ok(SubmittedTx { tx_hash })
    }

    /// Fetch a transaction's receipt by hash via `eth_getTransactionReceipt`. Returns `None` if
    /// the node doesn't have a receipt for this hash yet (unmined, or unknown).
    pub async fn get_transaction_receipt(
        &self,
        tx_hash: Hash32,
    ) -> Result<Option<TransactionReceipt>, MonadRpcError> {
        let params = json!([tx_hash.to_hex()]);
        let result = self
            .transport
            .call("eth_getTransactionReceipt", params)
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        let receipt: TransactionReceipt =
            serde_json::from_value(result).map_err(|source| MonadRpcError::InvalidResponse {
                method: "eth_getTransactionReceipt".to_string(),
                reason: source.to_string(),
            })?;
        Ok(Some(receipt))
    }

    /// Fetch a transaction by hash via `eth_getTransactionByHash`. Returns `None` if the node
    /// doesn't know about this tx hash.
    ///
    /// Unlike [`get_transaction_receipt`](Self::get_transaction_receipt), this returns the
    /// transaction's `value` and `input` (calldata) -- needed by callers that must inspect a
    /// burn/payment tx's value or calldata (e.g. `monad_stamp_verify`, `monad_pop_verify`), which
    /// a receipt alone doesn't carry.
    pub async fn get_transaction_by_hash(
        &self,
        tx_hash: Hash32,
    ) -> Result<Option<Transaction>, MonadRpcError> {
        let params = json!([tx_hash.to_hex()]);
        let result = self
            .transport
            .call("eth_getTransactionByHash", params)
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        let tx: Transaction =
            serde_json::from_value(result).map_err(|source| MonadRpcError::InvalidResponse {
                method: "eth_getTransactionByHash".to_string(),
                reason: source.to_string(),
            })?;
        Ok(Some(tx))
    }

    /// Fetch a transaction's raw RLP-encoded bytes by hash via `eth_getRawTransactionByHash`.
    /// Returns `None` if the node doesn't know about this tx hash.
    ///
    /// This is the only way to recover a Monad transaction's *raw* signed bytes: the decoded
    /// fields from [`get_transaction_by_hash`](Self::get_transaction_by_hash) aren't sufficient to
    /// reconstruct them (that would require re-deriving the exact RLP encoding for the tx's type
    /// -- legacy/EIP-2930/EIP-1559 -- including its signature). `eth_getRawTransactionByHash`
    /// originates in geth's `eth` namespace and is proxied by every major EVM RPC provider this
    /// codebase targets, including Alchemy.
    pub async fn get_raw_transaction_by_hash(
        &self,
        tx_hash: Hash32,
    ) -> Result<Option<Vec<u8>>, MonadRpcError> {
        let params = json!([tx_hash.to_hex()]);
        let result = self
            .transport
            .call("eth_getRawTransactionByHash", params)
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        let hex_str = result
            .as_str()
            .ok_or_else(|| MonadRpcError::InvalidResponse {
                method: "eth_getRawTransactionByHash".to_string(),
                reason: format!("expected a hex string, got {}", result),
            })?;
        let stripped = hex_str
            .strip_prefix("0x")
            .ok_or_else(|| MonadRpcError::InvalidResponse {
                method: "eth_getRawTransactionByHash".to_string(),
                reason: format!("expected 0x-prefixed hex, got {:?}", hex_str),
            })?;
        let bytes = hex::decode(stripped).map_err(|source| MonadRpcError::InvalidResponse {
            method: "eth_getRawTransactionByHash".to_string(),
            reason: source.to_string(),
        })?;
        Ok(Some(bytes))
    }

    /// Fetch logs matching the given filter via `eth_getLogs`.
    pub async fn get_logs(&self, filter: &GetLogsFilter) -> Result<Vec<Log>, MonadRpcError> {
        let params = filter.to_params();
        let result = self.transport.call("eth_getLogs", params).await?;
        let logs: Vec<Log> =
            serde_json::from_value(result).map_err(|source| MonadRpcError::InvalidResponse {
                method: "eth_getLogs".to_string(),
                reason: source.to_string(),
            })?;
        Ok(logs)
    }

    /// Fetch the current chain tip's block number via `eth_blockNumber`. Not part of the
    /// ticket's required trio, but a cheap, obviously-correct helper needed to bound
    /// `eth_getLogs` block ranges (used by the live smoke test, and useful to any caller of
    /// `get_logs`).
    pub async fn block_number(&self) -> Result<u64, MonadRpcError> {
        let result = self.transport.call("eth_blockNumber", json!([])).await?;
        let hex_str = result
            .as_str()
            .ok_or_else(|| MonadRpcError::InvalidResponse {
                method: "eth_blockNumber".to_string(),
                reason: format!("expected a hex string block number, got {}", result),
            })?;
        parse_hex_quantity(hex_str).map_err(|reason| MonadRpcError::InvalidResponse {
            method: "eth_blockNumber".to_string(),
            reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    /// Mock [`JsonRpcTransport`] that records every call made to it and returns a
    /// caller-provided canned response, so [`MonadHttpClient`]'s request-shaping logic (method
    /// name, params encoding) can be tested without a network call.
    #[derive(Debug, Default)]
    struct MockTransport {
        calls: Mutex<Vec<(String, Value)>>,
        response: Mutex<Option<Result<Value, String>>>,
    }

    impl MockTransport {
        fn with_response(response: Value) -> Self {
            MockTransport {
                calls: Mutex::new(Vec::new()),
                response: Mutex::new(Some(Ok(response))),
            }
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, params: Value) -> Result<Value, MonadRpcError> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            match self.response.lock().unwrap().clone() {
                Some(Ok(value)) => Ok(value),
                // Route through the same `classify_rpc_error` the real `HttpTransport` uses, so
                // these tests actually exercise the message-pattern classification logic (not
                // just a hardcoded mock outcome).
                Some(Err(message)) => Err(classify_rpc_error(
                    method,
                    JsonRpcErrorBody {
                        code: -32000,
                        message,
                        data: None,
                    },
                )),
                None => panic!("MockTransport has no response configured"),
            }
        }
    }

    #[tokio::test]
    async fn send_raw_transaction_shapes_request_correctly() {
        let expected_hash = format!("0x{}", "11".repeat(32));
        let transport = MockTransport::with_response(json!(expected_hash));
        let client = MonadHttpClient::with_transport(transport);

        let raw_tx = vec![0xde, 0xad, 0xbe, 0xef];
        let submitted = client.send_raw_transaction(&raw_tx).await.unwrap();

        assert_eq!(submitted.tx_hash.to_hex(), expected_hash);

        let calls = client.transport.calls();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(method, "eth_sendRawTransaction");
        // Correct JSON-RPC method name and params encoding: a single-element array containing
        // the 0x-prefixed hex encoding of the raw tx bytes.
        assert_eq!(params, &json!(["0xdeadbeef"]));
    }

    #[tokio::test]
    async fn send_raw_transaction_classifies_nonce_too_low() {
        let transport = MockTransport {
            calls: Mutex::new(Vec::new()),
            response: Mutex::new(Some(Err(
                "nonce too low: next nonce 5, tx nonce 3".to_string()
            ))),
        };
        let client = MonadHttpClient::with_transport(transport);

        let err = client.send_raw_transaction(&[1, 2, 3]).await.unwrap_err();
        assert!(matches!(err, MonadRpcError::NonceTooLow { .. }));
    }

    #[tokio::test]
    async fn send_raw_transaction_classifies_insufficient_funds() {
        let transport = MockTransport {
            calls: Mutex::new(Vec::new()),
            response: Mutex::new(Some(Err(
                "insufficient funds for gas * price + value".to_string()
            ))),
        };
        let client = MonadHttpClient::with_transport(transport);

        let err = client.send_raw_transaction(&[1, 2, 3]).await.unwrap_err();
        assert!(matches!(err, MonadRpcError::InsufficientFunds { .. }));
    }

    #[tokio::test]
    async fn get_transaction_receipt_shapes_request_and_handles_missing() {
        let transport = MockTransport::with_response(Value::Null);
        let client = MonadHttpClient::with_transport(transport);

        let tx_hash = Hash32::from_hex(&format!("0x{}", "22".repeat(32))).unwrap();
        let receipt = client.get_transaction_receipt(tx_hash).await.unwrap();
        assert!(receipt.is_none());

        let calls = client.transport.calls();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(method, "eth_getTransactionReceipt");
        assert_eq!(params, &json!([tx_hash.to_hex()]));
    }

    #[tokio::test]
    async fn get_transaction_receipt_parses_success_status() {
        let tx_hash = format!("0x{}", "33".repeat(32));
        let block_hash = format!("0x{}", "44".repeat(32));
        let from = format!("0x{}", "55".repeat(20));
        let to = format!("0x{}", "66".repeat(20));
        let response = json!({
            "transactionHash": tx_hash,
            "blockHash": block_hash,
            "blockNumber": "0x2a",
            "from": from,
            "to": to,
            "contractAddress": null,
            "gasUsed": "0x5208",
            "status": "0x1",
            "logs": [],
        });
        let transport = MockTransport::with_response(response);
        let client = MonadHttpClient::with_transport(transport);

        let receipt = client
            .get_transaction_receipt(Hash32::from_hex(&tx_hash).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(receipt.block_number, 42);
        assert_eq!(receipt.gas_used, 0x5208);
        assert_eq!(receipt.succeeded(), Some(true));
        assert_eq!(receipt.to.unwrap().to_hex(), to);
    }

    #[tokio::test]
    async fn get_transaction_by_hash_shapes_request_and_handles_missing() {
        let transport = MockTransport::with_response(Value::Null);
        let client = MonadHttpClient::with_transport(transport);

        let tx_hash = Hash32::from_hex(&format!("0x{}", "22".repeat(32))).unwrap();
        let tx = client.get_transaction_by_hash(tx_hash).await.unwrap();
        assert!(tx.is_none());

        let calls = client.transport.calls();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(method, "eth_getTransactionByHash");
        assert_eq!(params, &json!([tx_hash.to_hex()]));
    }

    #[tokio::test]
    async fn get_transaction_by_hash_parses_value_and_input() {
        let tx_hash = format!("0x{}", "33".repeat(32));
        let from = format!("0x{}", "55".repeat(20));
        let to = format!("0x{}", "66".repeat(20));
        // A `value` larger than `u64::MAX`, to exercise the `u128` parsing path.
        let response = json!({
            "hash": tx_hash,
            "from": from,
            "to": to,
            "value": "0x10000000000000000",
            "input": "0xdeadbeef",
        });
        let transport = MockTransport::with_response(response);
        let client = MonadHttpClient::with_transport(transport);

        let tx = client
            .get_transaction_by_hash(Hash32::from_hex(&tx_hash).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tx.value, 1u128 << 64);
        assert_eq!(tx.input, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(tx.to.unwrap().to_hex(), to);
    }

    #[tokio::test]
    async fn get_raw_transaction_by_hash_shapes_request_and_handles_missing() {
        let transport = MockTransport::with_response(Value::Null);
        let client = MonadHttpClient::with_transport(transport);

        let tx_hash = Hash32::from_hex(&format!("0x{}", "44".repeat(32))).unwrap();
        let raw = client.get_raw_transaction_by_hash(tx_hash).await.unwrap();
        assert!(raw.is_none());

        let calls = client.transport.calls();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(method, "eth_getRawTransactionByHash");
        assert_eq!(params, &json!([tx_hash.to_hex()]));
    }

    #[tokio::test]
    async fn get_raw_transaction_by_hash_decodes_hex() {
        let transport = MockTransport::with_response(json!("0xdeadbeef"));
        let client = MonadHttpClient::with_transport(transport);

        let tx_hash = Hash32::from_hex(&format!("0x{}", "55".repeat(32))).unwrap();
        let raw = client
            .get_raw_transaction_by_hash(tx_hash)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(raw, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[tokio::test]
    async fn get_logs_shapes_filter_params_correctly() {
        let transport = MockTransport::with_response(json!([]));
        let client = MonadHttpClient::with_transport(transport);

        let address = Address::from_hex(&format!("0x{}", "77".repeat(20))).unwrap();
        let topic = Hash32::from_hex(&format!("0x{}", "88".repeat(32))).unwrap();
        let filter = GetLogsFilter {
            from_block: Some(BlockTag::Number(100)),
            to_block: Some(BlockTag::Latest),
            address: Some(address),
            topics: vec![Some(topic), None],
        };
        client.get_logs(&filter).await.unwrap();

        let calls = client.transport.calls();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(method, "eth_getLogs");
        assert_eq!(
            params,
            &json!([{
                "fromBlock": "0x64",
                "toBlock": "latest",
                "address": address.to_hex(),
                "topics": [topic.to_hex(), null],
            }])
        );
    }

    #[tokio::test]
    async fn get_logs_parses_response() {
        let address = format!("0x{}", "99".repeat(20));
        let topic = format!("0x{}", "aa".repeat(32));
        let tx_hash = format!("0x{}", "bb".repeat(32));
        let response = json!([{
            "address": address,
            "topics": [topic],
            "data": "0x",
            "blockNumber": "0x10",
            "transactionHash": tx_hash,
            "logIndex": "0x0",
            "removed": false,
        }]);
        let transport = MockTransport::with_response(response);
        let client = MonadHttpClient::with_transport(transport);

        let logs = client.get_logs(&GetLogsFilter::default()).await.unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].address.to_hex(), address);
        assert_eq!(logs[0].block_number, Some(16));
        assert_eq!(logs[0].transaction_hash.to_hex(), tx_hash);
    }

    #[tokio::test]
    async fn block_number_parses_hex_response() {
        let transport = MockTransport::with_response(json!("0x2a"));
        let client = MonadHttpClient::with_transport(transport);
        assert_eq!(client.block_number().await.unwrap(), 42);
    }

    #[test]
    fn hash32_round_trips_hex() {
        let hex = format!("0x{}", "ab".repeat(32));
        let hash = Hash32::from_hex(&hex).unwrap();
        assert_eq!(hash.to_hex(), hex);
    }

    #[test]
    fn hash32_rejects_wrong_length() {
        let err = Hash32::from_hex("0xabcd").unwrap_err();
        assert!(matches!(err, HexTypeError::WrongLength { .. }));
    }

    #[test]
    fn hash32_rejects_missing_prefix() {
        let err = Hash32::from_hex("abcd").unwrap_err();
        assert!(matches!(err, HexTypeError::InvalidHex(_)));
    }
}
