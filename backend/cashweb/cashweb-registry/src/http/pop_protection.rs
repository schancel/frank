//! POP (proof-of-payment) protection for the registry-metadata-put path
//! ([`crate::http::server::handle_put_registry`]).
//!
//! Ticket #24: wires together ticket #22's chain-agnostic bearer-token layer
//! (`cashweb_pop_token`: [`extract_pop_or_query`], [`HmacBearerScheme`], [`TokenIssuer`]) and
//! ticket #23's Monad-backed payment-verification logic (`crate::monad_pop_verify`) via a small
//! `PaymentVerifier` adapter, [`MonadReceiptVerifier`], since `monad_pop_verify` was written
//! before #22's `PaymentVerifier` trait existed and doesn't implement it itself (documented in
//! `monad_pop_verify.rs`'s module docs).
//!
//! ## Request shape for submitting a payment proof (this ticket's own decision)
//!
//! No such shape existed anywhere in this codebase before this ticket, so it had to be decided
//! here. A client that wants a bearer token minted from a Monad payment adds two query
//! parameters to the same metadata-PUT request:
//!
//! - `pop_tx_hash`: the `0x`-prefixed, 32-byte hash of the Monad transaction that paid for
//!   access.
//! - `pop_value_wei`: that transaction's `value`, in wei, as a decimal string.
//!
//! `pop_value_wei` has to be supplied by the client (rather than looked up server-side) because
//! `MonadHttpClient` can only fetch a tx's *receipt* (`status`, `to`), not its `value` --
//! see `monad_pop_verify.rs`'s module docs for the `eth_getTransactionByHash` gap. Once that gap
//! is closed, `pop_value_wei` could be dropped and looked up from `pop_tx_hash` alone; until
//! then, a client must supply both.
//!
//! If the payment verifies, a bearer token is minted (scoped to the target address) and returned
//! in an `X-Pop-Token: POP <token>` response header, and the PUT proceeds immediately (no need to
//! retry). On subsequent requests to the same address, the client can present that token instead
//! of paying again, either as `Authorization: POP <token>` or as an `access_token=POP <token>`
//! query parameter (`cashweb_pop_token::extract_pop_or_query`'s two supported forms).
//!
//! If neither a valid token nor a `(pop_tx_hash, pop_value_wei)` pair is present -- or the
//! supplied proof doesn't verify -- the request is rejected with a `402 Payment Required`
//! response carrying the recipient address and minimum amount, so the client knows what to pay
//! (see [`PopChallenge`] and `crate::http::server`'s `IntoResponse` impl for it).
//!
//! ## Scope binding
//!
//! The minted token is scoped to the target Lotus address (`address.as_str()`'s bytes): a token
//! minted for one address's metadata-put cannot be replayed against another address's. This
//! plays the role the deprecated `cashweb-backends` repo's `pop_protection` gave to a commitment
//! hash derived from the requester's pubkey; we use the target address instead since, unlike that
//! deprecated flow, nothing here inspects the payload's `AuthWrapper`/pubkey (that's out of scope
//! for this ticket -- see the non-goals in ticket #24).

use std::{collections::HashMap, fmt, sync::Arc, sync::OnceLock};

use axum::http::HeaderMap;

use cashweb_pop_token::{extract_pop_or_query, HmacBearerScheme, PaymentVerifier, TokenIssuer};

use crate::monad_http::{
    Address, Hash32, HexTypeError, HttpTransport, JsonRpcTransport, MonadHttpClient, MonadRpcError,
};
use crate::monad_pop_verify::{verify_payment_via_receipt, ExpectedPayment, PopVerification};

/// Query parameter carrying a fallback bearer token (mirrors the deprecated `relayserver`'s
/// convention; see `cashweb_pop_token::extract_pop_or_query`).
const ACCESS_TOKEN_PARAM: &str = "access_token";
/// Query parameter carrying the Monad tx hash of an inline payment proof (this ticket's own
/// convention -- see module docs).
const TX_HASH_PARAM: &str = "pop_tx_hash";
/// Query parameter carrying the Monad tx's value in wei, for an inline payment proof.
const VALUE_WEI_PARAM: &str = "pop_value_wei";

/// Error decoding a `(pop_tx_hash, pop_value_wei)` pair, or verifying it on-chain, when
/// implementing [`PaymentVerifier`] via [`MonadReceiptVerifier`].
#[derive(Debug, thiserror::Error)]
pub enum MonadProofError {
    /// `proof` wasn't the `"<tx_hash_hex>:<value_wei_decimal>"` shape [`MonadReceiptVerifier`]
    /// expects (this crate's own internal encoding of the two query params into the opaque
    /// `proof` bytes `PaymentVerifier` takes; not part of the client-facing wire contract).
    #[error("malformed payment proof")]
    Malformed,
    /// `pop_tx_hash` wasn't a valid `0x`-prefixed 32-byte hash.
    #[error("invalid pop_tx_hash: {0}")]
    BadTxHash(HexTypeError),
    /// `pop_value_wei` wasn't a valid non-negative decimal integer.
    #[error("invalid pop_value_wei")]
    BadValueWei,
    /// The referenced tx exists and was decodable, but didn't satisfy the expected payment
    /// (wrong/no recipient, insufficient amount, not confirmed, or reverted).
    #[error("payment not verified: {0:?}")]
    NotVerified(PopVerification),
    /// Talking to the Monad RPC node failed at the transport/RPC level.
    #[error("Monad RPC error: {0}")]
    Rpc(#[from] MonadRpcError),
}

/// [`PaymentVerifier`] adapter backed by [`crate::monad_pop_verify::verify_payment_via_receipt`].
///
/// `scope` is ignored by this implementation: Monad-side verification here only checks that
/// *some* payment of the expected shape confirmed, not which resource it was "for" -- binding a
/// minted token to a specific `scope` (e.g. an address) is [`HmacBearerScheme`]'s job, applied by
/// [`TokenIssuer`] after this verifier succeeds.
pub struct MonadReceiptVerifier<T: JsonRpcTransport = HttpTransport> {
    client: Arc<MonadHttpClient<T>>,
    expected: ExpectedPayment,
}

impl<T: JsonRpcTransport> fmt::Debug for MonadReceiptVerifier<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MonadReceiptVerifier")
            .field("client", &self.client)
            .field("expected", &self.expected)
            .finish()
    }
}

impl<T: JsonRpcTransport> MonadReceiptVerifier<T> {
    /// Construct a verifier that checks payment proofs against `expected`, using `client` to
    /// fetch tx receipts.
    pub fn new(client: Arc<MonadHttpClient<T>>, expected: ExpectedPayment) -> Self {
        Self { client, expected }
    }

    /// The [`ExpectedPayment`] this verifier checks proofs against.
    pub fn expected(&self) -> ExpectedPayment {
        self.expected
    }
}

/// Encode a `(tx_hash, value_wei)` pair into the opaque `proof` bytes [`MonadReceiptVerifier`]
/// expects. Internal to this module; not part of the client-facing wire contract (see module
/// docs for that).
fn encode_proof(tx_hash_hex: &str, value_wei_decimal: &str) -> Vec<u8> {
    format!("{}:{}", tx_hash_hex, value_wei_decimal).into_bytes()
}

fn decode_proof(proof: &[u8]) -> Result<(Hash32, u128), MonadProofError> {
    let proof_str = std::str::from_utf8(proof).map_err(|_| MonadProofError::Malformed)?;
    let (tx_hash_hex, value_wei_str) = proof_str
        .split_once(':')
        .ok_or(MonadProofError::Malformed)?;
    let tx_hash = Hash32::from_hex(tx_hash_hex).map_err(MonadProofError::BadTxHash)?;
    let value_wei = value_wei_str
        .parse::<u128>()
        .map_err(|_| MonadProofError::BadValueWei)?;
    Ok((tx_hash, value_wei))
}

#[async_trait::async_trait]
impl<T: JsonRpcTransport> PaymentVerifier for MonadReceiptVerifier<T> {
    type Error = MonadProofError;

    async fn verify_payment(&self, _scope: &[u8], proof: &[u8]) -> Result<(), Self::Error> {
        let (tx_hash, value_wei) = decode_proof(proof)?;
        match verify_payment_via_receipt(&self.client, tx_hash, value_wei, &self.expected).await? {
            PopVerification::Verified => Ok(()),
            other => Err(MonadProofError::NotVerified(other)),
        }
    }
}

/// Why a request was challenged for payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeReason {
    /// No bearer token and no payment proof were presented.
    NoTokenOrProof,
    /// A bearer token was presented, but didn't validate for this address's scope.
    InvalidToken,
    /// A payment proof was presented, but didn't verify (see the wrapped verifier error's
    /// `Display` for details, rendered into `detail`).
    InvalidProof,
}

/// A request that must be rejected pending payment: carries what a client needs to construct a
/// valid Monad payment (recipient + minimum amount), analogous to the deprecated
/// `cashweb-backends` repo's `ProtectionError::MissingToken` -> `construct_payment_response`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopChallenge {
    /// Why the request was challenged.
    pub reason: ChallengeReason,
    /// Extra human-readable detail (e.g. the underlying proof-verification error), if any.
    pub detail: Option<String>,
    /// Recipient address the payment must be sent to.
    pub expected: ExpectedPayment,
}

/// Combines a [`TokenIssuer`] with the [`ExpectedPayment`] it gates on, so
/// [`authorize_put`]/callers can both validate/issue tokens *and* describe the expected payment
/// in a [`PopChallenge`] (the latter isn't exposed by [`TokenIssuer`] itself).
#[derive(Debug)]
pub struct PopGate<V: PaymentVerifier> {
    issuer: TokenIssuer<V>,
    expected: ExpectedPayment,
}

impl<V: PaymentVerifier> PopGate<V> {
    /// Construct a [`PopGate`] from an already-built [`TokenIssuer`] and the [`ExpectedPayment`]
    /// its verifier checks proofs against (callers are responsible for keeping these consistent
    /// with each other; this type doesn't enforce it since [`PaymentVerifier`] doesn't expose its
    /// configuration generically).
    pub fn new(issuer: TokenIssuer<V>, expected: ExpectedPayment) -> Self {
        Self { issuer, expected }
    }

    fn challenge(&self, reason: ChallengeReason, detail: Option<String>) -> PopChallenge {
        PopChallenge {
            reason,
            detail,
            expected: self.expected,
        }
    }
}

/// Errors reading required POP-gate configuration from the environment via [`pop_gate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopGateConfigError {
    /// A required env var wasn't set.
    MissingEnv(&'static str),
    /// `MONAD_TESTNET_HTTP_RPC_URL` wasn't a valid URL.
    InvalidRpcUrl(String),
    /// `CASHWEB_POP_PAYMENT_RECIPIENT` wasn't a valid `0x`-prefixed 20-byte address.
    InvalidRecipient(String),
    /// `CASHWEB_POP_MIN_VALUE_WEI` wasn't a valid non-negative decimal integer.
    InvalidMinValueWei(String),
}

impl fmt::Display for PopGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PopGateConfigError::MissingEnv(name) => {
                write!(
                    f,
                    "missing required env var {name} (POP protection is unconfigured)"
                )
            }
            PopGateConfigError::InvalidRpcUrl(msg) => {
                write!(f, "invalid MONAD_TESTNET_HTTP_RPC_URL: {msg}")
            }
            PopGateConfigError::InvalidRecipient(msg) => {
                write!(f, "invalid CASHWEB_POP_PAYMENT_RECIPIENT: {msg}")
            }
            PopGateConfigError::InvalidMinValueWei(msg) => {
                write!(f, "invalid CASHWEB_POP_MIN_VALUE_WEI: {msg}")
            }
        }
    }
}

impl std::error::Error for PopGateConfigError {}

fn required_env(name: &'static str) -> Result<String, PopGateConfigError> {
    std::env::var(name).map_err(|_| PopGateConfigError::MissingEnv(name))
}

impl PopGate<MonadReceiptVerifier<HttpTransport>> {
    /// Build a [`PopGate`] backed by a real Monad HTTPS RPC client, sourcing all configuration
    /// from the environment (following this crate's existing convention of reading
    /// `MONAD_TESTNET_HTTP_RPC_URL` at the call site rather than inside `monad_http`/
    /// `monad_pop_verify` -- see those modules' docs):
    ///
    /// - `MONAD_TESTNET_HTTP_RPC_URL`: Monad JSON-RPC endpoint (same var the live smoke tests
    ///   use).
    /// - `CASHWEB_POP_HMAC_SECRET`: server-side secret for bearer-token HMAC signing. Must be a
    ///   long random string kept only in server config; there is deliberately no insecure
    ///   built-in default -- an unset value fails closed (see [`PopGateConfigError::MissingEnv`])
    ///   rather than silently gating with a guessable key.
    /// - `CASHWEB_POP_PAYMENT_RECIPIENT`: `0x`-prefixed 20-byte Monad address payments must be
    ///   sent to.
    /// - `CASHWEB_POP_MIN_VALUE_WEI`: minimum payment amount, in wei, as a decimal string.
    pub fn from_env() -> Result<Self, PopGateConfigError> {
        let rpc_url = required_env("MONAD_TESTNET_HTTP_RPC_URL")?;
        let rpc_url: url::Url = rpc_url
            .parse()
            .map_err(|err| PopGateConfigError::InvalidRpcUrl(format!("{err}")))?;
        let secret = required_env("CASHWEB_POP_HMAC_SECRET")?;
        let recipient_hex = required_env("CASHWEB_POP_PAYMENT_RECIPIENT")?;
        let recipient = Address::from_hex(&recipient_hex)
            .map_err(|err| PopGateConfigError::InvalidRecipient(format!("{err}")))?;
        let min_value_wei_str = required_env("CASHWEB_POP_MIN_VALUE_WEI")?;
        let min_value_wei = min_value_wei_str
            .parse::<u128>()
            .map_err(|_| PopGateConfigError::InvalidMinValueWei(min_value_wei_str))?;

        let expected = ExpectedPayment {
            recipient,
            min_value_wei,
        };
        let client = Arc::new(MonadHttpClient::new(rpc_url));
        let verifier = MonadReceiptVerifier::new(client, expected);
        let scheme = HmacBearerScheme::new(secret.into_bytes());
        let issuer = TokenIssuer::new(verifier, scheme);
        Ok(PopGate::new(issuer, expected))
    }
}

/// Process-wide, lazily-initialized [`PopGate`] for [`crate::http::server::handle_put_registry`],
/// built from the environment on first use (see [`PopGate::from_env`]).
///
/// A [`OnceLock`] (rather than plumbing config through [`crate::http::server::RegistryServer`])
/// is used deliberately, to avoid changing that struct's fields -- and so avoid having to touch
/// its other construction sites (`cashwebd-exe/src/main.rs`,
/// `cashweb-registry/src/test_instance.rs`), which sit outside this ticket's edit scope.
///
/// If configuration is missing/invalid, every metadata-PUT request fails closed (see
/// `crate::http::server`'s handling of this `Err`) rather than silently skipping POP protection --
/// ticket #1 flagged the previous *zero* gating as the actual bug, so an unconfigured gate must
/// not quietly behave the same way.
pub fn pop_gate(
) -> &'static Result<PopGate<MonadReceiptVerifier<HttpTransport>>, PopGateConfigError> {
    static GATE: OnceLock<
        Result<PopGate<MonadReceiptVerifier<HttpTransport>>, PopGateConfigError>,
    > = OnceLock::new();
    GATE.get_or_init(PopGate::from_env)
}

/// Decide whether a metadata-PUT request for `scope` (the target address's bytes) may proceed.
///
/// - `Ok(None)`: an already-valid bearer token was presented; proceed.
/// - `Ok(Some(token))`: no valid token was presented, but `query` carried a payment proof
///   ([`TX_HASH_PARAM`]/[`VALUE_WEI_PARAM`]) that verified; a fresh token was minted and should be
///   surfaced to the client (e.g. via a response header) so it can be reused; proceed.
/// - `Err(challenge)`: neither a valid token nor a verifying payment proof was presented; reject
///   the request with a `402`-style response built from `challenge`.
pub async fn authorize_put<V: PaymentVerifier>(
    gate: &PopGate<V>,
    scope: &[u8],
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<Option<String>, PopChallenge> {
    let access_token = query.get(ACCESS_TOKEN_PARAM).map(String::as_str);
    if let Some(token) = extract_pop_or_query(headers, access_token) {
        if gate.issuer.validate_token(scope, token).is_ok() {
            return Ok(None);
        }
        return Err(gate.challenge(ChallengeReason::InvalidToken, None));
    }

    match (query.get(TX_HASH_PARAM), query.get(VALUE_WEI_PARAM)) {
        (Some(tx_hash_hex), Some(value_wei_decimal)) => {
            let proof = encode_proof(tx_hash_hex, value_wei_decimal);
            match gate.issuer.issue_token(scope, &proof).await {
                Ok(token) => Ok(Some(token)),
                Err(err) => {
                    Err(gate.challenge(ChallengeReason::InvalidProof, Some(err.to_string())))
                }
            }
        }
        _ => Err(gate.challenge(ChallengeReason::NoTokenOrProof, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::{json, Value};

    fn address(byte: u8) -> Address {
        Address([byte; 20])
    }

    /// Minimal [`JsonRpcTransport`] mock returning a single canned
    /// `eth_getTransactionReceipt`-shaped response, mirroring `monad_pop_verify.rs`'s own test
    /// mock (private to that module, so re-declared here).
    #[derive(Debug)]
    struct MockTransport {
        response: Value,
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, _method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            Ok(self.response.clone())
        }
    }

    fn verified_receipt(recipient: Address) -> Value {
        json!({
            "transactionHash": format!("0x{}", "cc".repeat(32)),
            "blockHash": format!("0x{}", "dd".repeat(32)),
            "blockNumber": "0x2a",
            "from": format!("0x{}", "bb".repeat(20)),
            "to": format!("0x{}", hex::encode(recipient.0)),
            "contractAddress": null,
            "gasUsed": "0x5208",
            "status": "0x1",
            "logs": [],
        })
    }

    fn gate_with_response(
        recipient: Address,
        min_value_wei: u128,
        response: Value,
    ) -> PopGate<MonadReceiptVerifier<MockTransport>> {
        let expected = ExpectedPayment {
            recipient,
            min_value_wei,
        };
        let client = Arc::new(MonadHttpClient::with_transport(MockTransport { response }));
        let verifier = MonadReceiptVerifier::new(client, expected);
        let scheme = HmacBearerScheme::new(b"test-secret".to_vec());
        PopGate::new(TokenIssuer::new(verifier, scheme), expected)
    }

    fn tx_hash_hex() -> String {
        format!("0x{}", "cc".repeat(32))
    }

    #[test]
    fn decode_proof_ok() {
        let proof = encode_proof(&tx_hash_hex(), "1000");
        let (tx_hash, value_wei) = decode_proof(&proof).unwrap();
        assert_eq!(tx_hash, Hash32::from_hex(&tx_hash_hex()).unwrap());
        assert_eq!(value_wei, 1000);
    }

    #[test]
    fn decode_proof_rejects_malformed() {
        assert!(matches!(
            decode_proof(b"no-colon-here"),
            Err(MonadProofError::Malformed)
        ));
        assert!(matches!(
            decode_proof(b"not-hex:1000"),
            Err(MonadProofError::BadTxHash(_))
        ));
        let bad_amount = format!("{}:not-a-number", tx_hash_hex());
        assert!(matches!(
            decode_proof(bad_amount.as_bytes()),
            Err(MonadProofError::BadValueWei)
        ));
    }

    #[tokio::test]
    async fn monad_receipt_verifier_accepts_valid_payment() {
        let recipient = address(0xaa);
        let verifier_client = Arc::new(MonadHttpClient::with_transport(MockTransport {
            response: verified_receipt(recipient),
        }));
        let verifier = MonadReceiptVerifier::new(
            verifier_client,
            ExpectedPayment {
                recipient,
                min_value_wei: 1_000,
            },
        );
        let proof = encode_proof(&tx_hash_hex(), "1000");
        assert!(verifier.verify_payment(b"any-scope", &proof).await.is_ok());
    }

    #[tokio::test]
    async fn monad_receipt_verifier_rejects_insufficient_payment() {
        let recipient = address(0xaa);
        let verifier_client = Arc::new(MonadHttpClient::with_transport(MockTransport {
            response: verified_receipt(recipient),
        }));
        let verifier = MonadReceiptVerifier::new(
            verifier_client,
            ExpectedPayment {
                recipient,
                min_value_wei: 1_000_000,
            },
        );
        let proof = encode_proof(&tx_hash_hex(), "1000");
        let err = verifier
            .verify_payment(b"any-scope", &proof)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            MonadProofError::NotVerified(PopVerification::InsufficientAmount)
        ));
    }

    #[tokio::test]
    async fn authorize_put_rejects_when_no_token_or_proof() {
        let gate = gate_with_response(address(0xaa), 1_000, verified_receipt(address(0xaa)));
        let headers = HeaderMap::new();
        let query = HashMap::new();
        let err = authorize_put(&gate, b"scope", &headers, &query)
            .await
            .unwrap_err();
        assert_eq!(err.reason, ChallengeReason::NoTokenOrProof);
    }

    #[tokio::test]
    async fn authorize_put_rejects_invalid_token() {
        let gate = gate_with_response(address(0xaa), 1_000, verified_receipt(address(0xaa)));
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("POP not-a-real-token"),
        );
        let query = HashMap::new();
        let err = authorize_put(&gate, b"scope", &headers, &query)
            .await
            .unwrap_err();
        assert_eq!(err.reason, ChallengeReason::InvalidToken);
    }

    #[tokio::test]
    async fn authorize_put_mints_and_then_accepts_token_from_valid_proof() {
        let recipient = address(0xaa);
        let gate = gate_with_response(recipient, 1_000, verified_receipt(recipient));
        let scope = b"lotus_some_address";

        // First request: no token yet, but a valid payment proof is supplied via query params.
        let mut query = HashMap::new();
        query.insert(TX_HASH_PARAM.to_string(), tx_hash_hex());
        query.insert(VALUE_WEI_PARAM.to_string(), "1000".to_string());
        let headers = HeaderMap::new();
        let token = authorize_put(&gate, scope, &headers, &query)
            .await
            .expect("valid proof should mint a token")
            .expect("a fresh token should have been minted");

        // Second request: present the minted token instead of paying again.
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            axum::http::HeaderValue::from_str(&format!("POP {token}")).unwrap(),
        );
        let query = HashMap::new();
        let result = authorize_put(&gate, scope, &headers, &query).await;
        assert_eq!(result, Ok(None));

        // A different scope (a different address) must not accept the same token.
        let other_scope = b"lotus_some_other_address";
        let result = authorize_put(&gate, other_scope, &headers, &query).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn authorize_put_rejects_invalid_proof() {
        let recipient = address(0xaa);
        let wrong_recipient = address(0xbb);
        let gate = gate_with_response(recipient, 1_000, verified_receipt(wrong_recipient));

        let mut query = HashMap::new();
        query.insert(TX_HASH_PARAM.to_string(), tx_hash_hex());
        query.insert(VALUE_WEI_PARAM.to_string(), "1000".to_string());
        let headers = HeaderMap::new();
        let err = authorize_put(&gate, b"scope", &headers, &query)
            .await
            .unwrap_err();
        assert_eq!(err.reason, ChallengeReason::InvalidProof);
    }

    #[test]
    fn pop_gate_config_error_missing_env_is_reported() {
        // Sanity check the Display impl actually mentions the missing var name -- useful for
        // whoever deploys this to know what to set.
        let err = PopGateConfigError::MissingEnv("CASHWEB_POP_HMAC_SECRET");
        assert!(err.to_string().contains("CASHWEB_POP_HMAC_SECRET"));
    }
}
