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
//! here. A client that wants a bearer token minted from a Monad payment adds one query parameter
//! to the same metadata-PUT request:
//!
//! - `pop_tx_hash`: the `0x`-prefixed, 32-byte hash of the Monad transaction that paid for
//!   access.
//!
//! (An earlier revision of this module also required a client-supplied `pop_value_wei`, because
//! `MonadHttpClient` could only fetch a tx's *receipt* -- not its `value` -- at the time this was
//! written; see `monad_pop_verify.rs`'s module docs. Ticket #25 closed that gap by adding
//! `get_transaction_by_hash`, so `verify_payment_via_receipt` now looks `value` up on-chain itself
//! instead of trusting a client-asserted figure -- strictly stronger, since the old shape only
//! ever checked the number the client *claimed*, not the number the chain actually recorded. The
//! query parameter was dropped accordingly.)
//!
//! If the payment verifies, a bearer token is minted (scoped to the target address) and returned
//! in an `X-Pop-Token: POP <token>` response header, and the PUT proceeds immediately (no need to
//! retry). On subsequent requests to the same address, the client can present that token instead
//! of paying again, either as `Authorization: POP <token>` or as an `access_token=POP <token>`
//! query parameter (`cashweb_pop_token::extract_pop_or_query`'s two supported forms).
//!
//! If neither a valid token nor a `pop_tx_hash` is present -- or the referenced payment doesn't
//! verify -- the request is rejected with a `402 Payment Required` response carrying the
//! recipient address and minimum amount, so the client knows what to pay (see [`PopChallenge`]
//! and `crate::http::server`'s `IntoResponse` impl for it).
//!
//! ## Scope binding
//!
//! The minted token is scoped to the target Lotus address (`address.as_str()`'s bytes): a token
//! minted for one address's metadata-put cannot be replayed against another address's. This
//! plays the role the deprecated `cashweb-backends` repo's `pop_protection` gave to a commitment
//! hash derived from the requester's pubkey; we use the target address instead since, unlike that
//! deprecated flow, nothing here inspects the payload's `AuthWrapper`/pubkey (that's out of scope
//! for this ticket -- see the non-goals in ticket #24).
//!
//! ## Configuration (ticket #4)
//!
//! [`PopGate::from_conf`] builds a [`PopGate`] from a [`cashweb_config::PopConf`] -- real
//! config-file wiring via this crate's normal `cashweb-config` mechanism. This replaces ticket
//! #24's `PopGate::from_env`/process-wide `OnceLock` (`pop_gate()`), which read raw env vars
//! lazily on first request specifically to avoid touching
//! [`crate::http::server::RegistryServer`]'s fields/construction sites -- explicitly flagged
//! there as a follow-up. [`crate::http::server::RegistryServer`] now holds a
//! `pop_gate: Arc<Result<PopGate<...>, PopGateConfigError>>` field built once at construction time
//! (`cashwebd-exe/src/main.rs` for production, `cashweb_registry::test_instance` for tests) from
//! its `cashweb_config::CashwebdConf`/`RegistryConf::pop`, rather than being read lazily per
//! request. A `Result` (rather than requiring construction to fail outright) is kept so an
//! invalid/inconsistent `PopConf` still fails closed per-request (`500`, see
//! `crate::http::server::PutRegistryError::PopUnavailable`) instead of panicking at startup or
//! silently disabling POP protection -- the same fail-closed principle ticket #24 established,
//! just checked once at construction instead of on every request.

use std::{collections::HashMap, fmt, sync::Arc};

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

/// Error decoding a `pop_tx_hash`, or verifying it on-chain, when implementing [`PaymentVerifier`]
/// via [`MonadReceiptVerifier`].
#[derive(Debug, thiserror::Error)]
pub enum MonadProofError {
    /// `pop_tx_hash` wasn't a valid `0x`-prefixed 32-byte hash.
    #[error("invalid pop_tx_hash: {0}")]
    BadTxHash(HexTypeError),
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

/// Encode a tx hash into the opaque `proof` bytes [`MonadReceiptVerifier`] expects. Internal to
/// this module; not part of the client-facing wire contract (see module docs for that).
fn encode_proof(tx_hash_hex: &str) -> Vec<u8> {
    tx_hash_hex.as_bytes().to_vec()
}

fn decode_proof(proof: &[u8]) -> Result<Hash32, MonadProofError> {
    let tx_hash_hex = std::str::from_utf8(proof).map_err(|_| {
        MonadProofError::BadTxHash(HexTypeError::InvalidHex(
            "pop_tx_hash was not valid UTF-8".to_string(),
        ))
    })?;
    Hash32::from_hex(tx_hash_hex).map_err(MonadProofError::BadTxHash)
}

#[async_trait::async_trait]
impl<T: JsonRpcTransport> PaymentVerifier for MonadReceiptVerifier<T> {
    type Error = MonadProofError;

    async fn verify_payment(&self, _scope: &[u8], proof: &[u8]) -> Result<(), Self::Error> {
        let tx_hash = decode_proof(proof)?;
        match verify_payment_via_receipt(&self.client, tx_hash, &self.expected).await? {
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

/// Errors building a [`PopGate`] from a [`cashweb_config::PopConf`] via [`PopGate::from_conf`].
///
/// Ticket #4: this used to be [`PopGateConfigError`]'s `MissingEnv`/`InvalidRpcUrl`-flavored
/// sibling for reading raw env vars (see ticket #24's `PopGate::from_env`, now removed). Real
/// config-file wiring via `cashweb-config` moves "is a field present and URL-shaped" enforcement
/// to config-parse time (a [`cashweb_config::PopConf`] simply fails to deserialize, with a clear
/// "missing/invalid field" error, before a [`PopGate`] is ever built) -- so only the two checks
/// that need domain-specific parsing beyond what `serde`/`toml` can express on their own
/// (`payment_recipient`, `min_value_wei`) remain here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopGateConfigError {
    /// `PopConf::payment_recipient` wasn't a valid `0x`-prefixed 20-byte address.
    InvalidRecipient(String),
    /// `PopConf::min_value_wei` wasn't a valid non-negative decimal integer.
    InvalidMinValueWei(String),
}

impl fmt::Display for PopGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PopGateConfigError::InvalidRecipient(msg) => {
                write!(f, "invalid PopConf::payment_recipient: {msg}")
            }
            PopGateConfigError::InvalidMinValueWei(msg) => {
                write!(f, "invalid PopConf::min_value_wei: {msg}")
            }
        }
    }
}

impl std::error::Error for PopGateConfigError {}

impl PopGate<MonadReceiptVerifier<HttpTransport>> {
    /// Build a [`PopGate`] backed by a real Monad HTTPS RPC client, sourcing all configuration
    /// from a [`cashweb_config::PopConf`] (ticket #4's real config-file wiring, replacing ticket
    /// #24's raw-env-var `PopGate::from_env`/process-wide `OnceLock`).
    ///
    /// Callers own threading `conf` through from wherever they parsed it (a `cashweb-config` TOML
    /// file for `cashwebd-exe`, or a value built directly for tests, e.g.
    /// `cashweb_registry::test_instance::RegistryTestInstance`) into
    /// [`crate::http::server::RegistryServer`]'s construction; this function itself doesn't read
    /// any environment variables or files.
    pub fn from_conf(conf: &cashweb_config::PopConf) -> Result<Self, PopGateConfigError> {
        let recipient = Address::from_hex(&conf.payment_recipient)
            .map_err(|err| PopGateConfigError::InvalidRecipient(format!("{err}")))?;
        let min_value_wei = conf
            .min_value_wei
            .parse::<u128>()
            .map_err(|_| PopGateConfigError::InvalidMinValueWei(conf.min_value_wei.clone()))?;

        let expected = ExpectedPayment {
            recipient,
            min_value_wei,
        };
        let client = Arc::new(MonadHttpClient::new(conf.monad_rpc_url.clone()));
        let verifier = MonadReceiptVerifier::new(client, expected);
        let scheme = HmacBearerScheme::new(conf.hmac_secret.clone().into_bytes());
        let issuer = TokenIssuer::new(verifier, scheme);
        Ok(PopGate::new(issuer, expected))
    }

    /// Ticket #35: [`Self::from_conf`], but honoring [`cashweb_config::PopConf::enabled`] first.
    ///
    /// Returns `None` when `conf.enabled` is `false` -- POP is intentionally, explicitly turned
    /// off (e.g. the hackathon demo default), and callers (`cashwebd-exe/src/main.rs`,
    /// `crate::test_instance`) should skip building a gate at all rather than building one that's
    /// merely ignored. This is a genuinely different outcome from `Some(Err(_))`, which means POP
    /// *is* meant to be enforced but this config doesn't parse into a valid gate -- that case must
    /// keep failing every gated request closed with a `500`
    /// (`crate::http::server::PutRegistryError::PopUnavailable`), never silently pass through.
    /// Collapsing "disabled" and "misconfigured" into the same value is exactly what this ticket
    /// exists to avoid, hence the `Option<Result<..>>` shape rather than, say, treating a
    /// config error as equivalent to disabled.
    pub fn from_conf_if_enabled(
        conf: &cashweb_config::PopConf,
    ) -> Option<Result<Self, PopGateConfigError>> {
        conf.enabled.then(|| Self::from_conf(conf))
    }
}

/// Decide whether a metadata-PUT request for `scope` (the target address's bytes) may proceed.
///
/// - `Ok(None)`: an already-valid bearer token was presented; proceed.
/// - `Ok(Some(token))`: no valid token was presented, but `query` carried a payment proof
///   ([`TX_HASH_PARAM`]) that verified; a fresh token was minted and should be surfaced to the
///   client (e.g. via a response header) so it can be reused; proceed.
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

    match query.get(TX_HASH_PARAM) {
        Some(tx_hash_hex) => {
            let proof = encode_proof(tx_hash_hex);
            match gate.issuer.issue_token(scope, &proof).await {
                Ok(token) => Ok(Some(token)),
                Err(err) => {
                    Err(gate.challenge(ChallengeReason::InvalidProof, Some(err.to_string())))
                }
            }
        }
        None => Err(gate.challenge(ChallengeReason::NoTokenOrProof, None)),
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

    /// [`JsonRpcTransport`] mock returning a canned response per JSON-RPC method, mirroring
    /// `monad_pop_verify.rs`'s own test mock (private to that module, so re-declared here) --
    /// needed because `verify_payment_via_receipt` now makes two calls (receipt, then full tx).
    #[derive(Debug, Default)]
    struct MockTransport {
        responses: HashMap<String, Value>,
    }

    impl MockTransport {
        fn new(responses: impl IntoIterator<Item = (&'static str, Value)>) -> Self {
            MockTransport {
                responses: responses
                    .into_iter()
                    .map(|(method, response)| (method.to_string(), response))
                    .collect(),
            }
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            self.responses
                .get(method)
                .cloned()
                .ok_or_else(|| MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured for this method".to_string(),
                })
        }
    }

    fn verified_receipt(recipient: Address) -> Value {
        json!({
            "transactionHash": tx_hash_hex(),
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

    fn verified_transaction(recipient: Address, value_hex: &str) -> Value {
        json!({
            "hash": tx_hash_hex(),
            "from": format!("0x{}", "bb".repeat(20)),
            "to": format!("0x{}", hex::encode(recipient.0)),
            "value": value_hex,
            "input": "0x",
        })
    }

    /// A gate whose mock transport answers both `eth_getTransactionReceipt` (`receipt`) and
    /// `eth_getTransactionByHash` (`tx`) for the one `tx_hash_hex()` this whole test module uses.
    fn gate_with_responses(
        recipient: Address,
        min_value_wei: u128,
        receipt: Value,
        tx: Value,
    ) -> PopGate<MonadReceiptVerifier<MockTransport>> {
        let expected = ExpectedPayment {
            recipient,
            min_value_wei,
        };
        let transport = MockTransport::new([
            ("eth_getTransactionReceipt", receipt),
            ("eth_getTransactionByHash", tx),
        ]);
        let client = Arc::new(MonadHttpClient::with_transport(transport));
        let verifier = MonadReceiptVerifier::new(client, expected);
        let scheme = HmacBearerScheme::new(b"test-secret".to_vec());
        PopGate::new(TokenIssuer::new(verifier, scheme), expected)
    }

    fn tx_hash_hex() -> String {
        format!("0x{}", "cc".repeat(32))
    }

    #[test]
    fn decode_proof_ok() {
        let proof = encode_proof(&tx_hash_hex());
        let tx_hash = decode_proof(&proof).unwrap();
        assert_eq!(tx_hash, Hash32::from_hex(&tx_hash_hex()).unwrap());
    }

    #[test]
    fn decode_proof_rejects_malformed() {
        assert!(matches!(
            decode_proof(b"not-hex"),
            Err(MonadProofError::BadTxHash(_))
        ));
    }

    #[tokio::test]
    async fn monad_receipt_verifier_accepts_valid_payment() {
        let recipient = address(0xaa);
        let transport = MockTransport::new([
            ("eth_getTransactionReceipt", verified_receipt(recipient)),
            (
                "eth_getTransactionByHash",
                verified_transaction(recipient, "0x3e8"),
            ),
        ]);
        let verifier_client = Arc::new(MonadHttpClient::with_transport(transport));
        let verifier = MonadReceiptVerifier::new(
            verifier_client,
            ExpectedPayment {
                recipient,
                min_value_wei: 1_000,
            },
        );
        let proof = encode_proof(&tx_hash_hex());
        assert!(verifier.verify_payment(b"any-scope", &proof).await.is_ok());
    }

    #[tokio::test]
    async fn monad_receipt_verifier_rejects_insufficient_payment() {
        let recipient = address(0xaa);
        let transport = MockTransport::new([
            ("eth_getTransactionReceipt", verified_receipt(recipient)),
            (
                "eth_getTransactionByHash",
                verified_transaction(recipient, "0x3e8"),
            ),
        ]);
        let verifier_client = Arc::new(MonadHttpClient::with_transport(transport));
        let verifier = MonadReceiptVerifier::new(
            verifier_client,
            ExpectedPayment {
                recipient,
                min_value_wei: 1_000_000,
            },
        );
        let proof = encode_proof(&tx_hash_hex());
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
        let recipient = address(0xaa);
        let gate = gate_with_responses(
            recipient,
            1_000,
            verified_receipt(recipient),
            verified_transaction(recipient, "0x3e8"),
        );
        let headers = HeaderMap::new();
        let query = HashMap::new();
        let err = authorize_put(&gate, b"scope", &headers, &query)
            .await
            .unwrap_err();
        assert_eq!(err.reason, ChallengeReason::NoTokenOrProof);
    }

    #[tokio::test]
    async fn authorize_put_rejects_invalid_token() {
        let recipient = address(0xaa);
        let gate = gate_with_responses(
            recipient,
            1_000,
            verified_receipt(recipient),
            verified_transaction(recipient, "0x3e8"),
        );
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
        let gate = gate_with_responses(
            recipient,
            1_000,
            verified_receipt(recipient),
            verified_transaction(recipient, "0x3e8"),
        );
        let scope = b"lotus_some_address";

        // First request: no token yet, but a valid payment proof is supplied via query params.
        let mut query = HashMap::new();
        query.insert(TX_HASH_PARAM.to_string(), tx_hash_hex());
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
        let gate = gate_with_responses(
            recipient,
            1_000,
            verified_receipt(wrong_recipient),
            verified_transaction(wrong_recipient, "0x3e8"),
        );

        let mut query = HashMap::new();
        query.insert(TX_HASH_PARAM.to_string(), tx_hash_hex());
        let headers = HeaderMap::new();
        let err = authorize_put(&gate, b"scope", &headers, &query)
            .await
            .unwrap_err();
        assert_eq!(err.reason, ChallengeReason::InvalidProof);
    }

    #[test]
    fn pop_gate_config_error_invalid_recipient_is_reported() {
        // Sanity check the Display impl actually mentions the invalid value -- useful for
        // whoever deploys this to know what's wrong.
        let err = PopGateConfigError::InvalidRecipient("not-an-address".to_string());
        assert!(err.to_string().contains("not-an-address"));
    }

    fn valid_pop_conf() -> cashweb_config::PopConf {
        cashweb_config::PopConf {
            enabled: true,
            monad_rpc_url: "https://example.invalid".parse().unwrap(),
            hmac_secret: "test-secret".to_string(),
            payment_recipient: format!("0x{}", "aa".repeat(20)),
            min_value_wei: "1000".to_string(),
        }
    }

    #[test]
    fn pop_gate_from_conf_accepts_valid_conf() {
        assert!(PopGate::from_conf(&valid_pop_conf()).is_ok());
    }

    #[test]
    fn pop_gate_from_conf_rejects_invalid_recipient() {
        let mut conf = valid_pop_conf();
        conf.payment_recipient = "not-an-address".to_string();
        assert!(matches!(
            PopGate::from_conf(&conf),
            Err(PopGateConfigError::InvalidRecipient(_))
        ));
    }

    #[test]
    fn pop_gate_from_conf_rejects_invalid_min_value_wei() {
        let mut conf = valid_pop_conf();
        conf.min_value_wei = "not-a-number".to_string();
        assert!(matches!(
            PopGate::from_conf(&conf),
            Err(PopGateConfigError::InvalidMinValueWei(_))
        ));
    }

    // --- Ticket #35: `enabled` toggle ---

    #[test]
    fn from_conf_if_enabled_returns_none_when_disabled_even_if_otherwise_invalid() {
        // The key property this ticket asks for: "disabled" must not collapse into
        // "misconfigured", or vice versa. A conf that's *both* disabled *and* would fail to parse
        // into a gate (bad recipient) must still come back `None` (fail-open, by intent) rather
        // than `Some(Err(_))` (fail-closed) -- disabled short-circuits before the parsing that
        // would otherwise produce the error.
        let mut conf = valid_pop_conf();
        conf.enabled = false;
        conf.payment_recipient = "not-an-address".to_string();
        assert!(PopGate::from_conf_if_enabled(&conf).is_none());
    }

    #[test]
    fn from_conf_if_enabled_returns_some_ok_when_enabled_and_valid() {
        let conf = valid_pop_conf();
        assert!(matches!(
            PopGate::from_conf_if_enabled(&conf),
            Some(Ok(_))
        ));
    }

    #[test]
    fn from_conf_if_enabled_returns_some_err_when_enabled_and_invalid() {
        // The other half of the same property: enabling POP with an invalid conf must still fail
        // closed (`Some(Err(_))`), never be silently treated as disabled (`None`).
        let mut conf = valid_pop_conf();
        conf.min_value_wei = "not-a-number".to_string();
        assert!(matches!(
            PopGate::from_conf_if_enabled(&conf),
            Some(Err(PopGateConfigError::InvalidMinValueWei(_)))
        ));
    }
}
