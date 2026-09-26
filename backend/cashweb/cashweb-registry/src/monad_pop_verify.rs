//! Monad-backed POP (proof-of-payment) verification: checks that a Monad transaction paid at
//! least a given amount to a given address and confirmed successfully.
//!
//! ## Scope (ticket #23)
//!
//! Replaces the role the deprecated (Lotus-only) `ChainCommitmentScheme` used to play for POP:
//! instead of checking an `OP_RETURN` commitment in a BCH tx, this checks a Monad tx *receipt*'s
//! status and `to`/`value` fields via [`crate::monad_http::MonadHttpClient`]
//! (`eth_getTransactionReceipt`), per ticket #4/PLAN.md constraint 4 and this ticket's acceptance
//! criteria.
//!
//! ## Sibling ticket #22 (bearer-token layer) status at the time this was written
//!
//! Ticket #22, which is expected to define the `PaymentVerifier`-shaped trait this module should
//! eventually implement, is being worked in a separate worktree
//! (`frank-worktrees/22-pop-token-layer`) in parallel. That worktree was checked (read-only) as
//! part of this ticket and, at the time this module was written, had **no commits beyond `main`
//! and a clean working tree** — i.e. no trait/module exists there yet to target.
//!
//! Per the ticket's fallback instructions for this case, this module is therefore written as a
//! standalone, dependency-free function ([`verify_payment`]) with an obvious, self-describing
//! signature (on-chain facts + expected payment in, a typed [`PopVerification`] result out), so
//! it's trivial to wire into whatever trait #22 introduces once both branches merge. No trait is
//! guessed at or invented here.
//!
//! ## `MonadHttpClient` gap: no way to fetch a tx's `value` (resolved by ticket #25)
//!
//! `eth_getTransactionReceipt` (what [`crate::monad_http::MonadHttpClient::get_transaction_receipt`]
//! wraps) reports a transaction's `status` and `to`, but **not** its `value` — `value` lives on
//! the transaction itself (`eth_getTransactionByHash`), not on its receipt. `MonadHttpClient`
//! (ticket #12) didn't originally expose a method to fetch it, so [`verify_payment`] was written
//! to take an already-assembled [`TxPaymentFacts`] (status + `to` + `value_wei`) and
//! [`verify_payment_via_receipt`] required the caller to supply `value_wei` out of band.
//!
//! Ticket #25 (assembling `MonadAdapter`) added
//! [`crate::monad_http::MonadHttpClient::get_transaction_by_hash`] (the same gap ticket #16's
//! `monad_stamp_verify` independently hit and worked around). [`verify_payment_via_receipt`] now
//! calls it directly to fetch `value_wei` itself, so callers no longer need to source it
//! separately. [`verify_payment`]/[`TxPaymentFacts`] are unchanged: they stay fully
//! unit-testable without a network call, regardless of where the facts come from.

use crate::monad_http::{Address, Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError};

/// The recipient address and minimum amount (in wei) a POP payment is expected to satisfy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedPayment {
    /// Address the payment must have been sent to.
    pub recipient: Address,
    /// Minimum amount, in wei, the payment must be for (an exact-match payment also satisfies
    /// this: `value_wei >= min_value_wei`).
    pub min_value_wei: u128,
}

/// The subset of on-chain facts about a Monad transaction needed to verify a POP payment:
/// receipt status, the tx's `to` address, and the tx's `value` (in wei).
///
/// [`verify_payment_via_receipt`] assembles this from
/// [`MonadHttpClient::get_transaction_receipt`] (`status`, `to`) plus
/// [`MonadHttpClient::get_transaction_by_hash`] (`value`) — see the module docs for why the
/// receipt alone can't provide `value`. [`verify_payment`] itself is pure and doesn't care how its
/// caller assembled these facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TxPaymentFacts {
    /// The receipt's post-Byzantium status code (`Some(1)` = success, `Some(0)` = reverted), or
    /// `None` if no receipt exists yet (tx unmined or unknown to the node).
    pub status: Option<u64>,
    /// The tx's `to` address, or `None` for a contract-creation tx (never a valid POP payment
    /// recipient) or when no receipt exists yet.
    pub to: Option<Address>,
    /// The tx's value, in wei.
    pub value_wei: u128,
}

/// Outcome of verifying a POP payment's on-chain facts against an [`ExpectedPayment`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopVerification {
    /// The tx confirmed successfully, paid at least the expected amount to the expected
    /// recipient. POP payment accepted.
    Verified,
    /// No receipt exists for this tx yet (unmined, or the node doesn't know about it).
    NotConfirmed,
    /// The tx was mined but reverted (receipt status `0x0`).
    TxFailed,
    /// The tx confirmed successfully, but its `to` doesn't match the expected recipient (or it
    /// was a contract-creation tx with no `to` at all).
    WrongRecipient,
    /// The tx confirmed successfully and paid the expected recipient, but for less than the
    /// expected minimum amount.
    InsufficientAmount,
}

/// Verify a POP payment's on-chain facts against the expected recipient/amount.
///
/// Pure and synchronous: no network access. Order of checks matches the ticket's acceptance
/// criteria: confirmation/status first, then recipient, then amount.
pub fn verify_payment(facts: &TxPaymentFacts, expected: &ExpectedPayment) -> PopVerification {
    match facts.status {
        None => return PopVerification::NotConfirmed,
        Some(status) if status != 1 => return PopVerification::TxFailed,
        _ => {}
    }

    match facts.to {
        Some(to) if to == expected.recipient => {}
        _ => return PopVerification::WrongRecipient,
    }

    if facts.value_wei < expected.min_value_wei {
        return PopVerification::InsufficientAmount;
    }

    PopVerification::Verified
}

/// Async convenience wrapper around [`verify_payment`]: fetches the tx's receipt (for
/// `status`/`to`) via `MonadHttpClient::get_transaction_receipt` and, once that shows a confirmed,
/// successful payment to the expected recipient, the full transaction (for `value`) via
/// `MonadHttpClient::get_transaction_by_hash`, then verifies.
///
/// Fetching the full transaction is deferred until after the recipient check to avoid an
/// unnecessary RPC round-trip when the tx is unconfirmed, failed, or already known to be
/// misdirected from the receipt alone.
///
/// Returns `Err` only for transport/RPC-level failures talking to the node; a missing receipt or
/// a failed/mismatched payment is a normal `Ok(PopVerification::...)`, not an error.
pub async fn verify_payment_via_receipt<T: JsonRpcTransport>(
    client: &MonadHttpClient<T>,
    tx_hash: Hash32,
    expected: &ExpectedPayment,
) -> Result<PopVerification, MonadRpcError> {
    let receipt = client.get_transaction_receipt(tx_hash).await?;
    let receipt = match receipt {
        None => return Ok(PopVerification::NotConfirmed),
        Some(receipt) => receipt,
    };
    if receipt.status != Some(1) {
        return Ok(PopVerification::TxFailed);
    }
    if receipt.to != Some(expected.recipient) {
        return Ok(PopVerification::WrongRecipient);
    }

    let value_wei = client
        .get_transaction_by_hash(tx_hash)
        .await?
        .map(|tx| tx.value)
        .unwrap_or(0);
    let facts = TxPaymentFacts {
        status: receipt.status,
        to: receipt.to,
        value_wei,
    };
    Ok(verify_payment(&facts, expected))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use serde_json::{json, Value};

    use super::*;

    fn address(byte: u8) -> Address {
        Address([byte; 20])
    }

    fn expected(recipient: Address, min_value_wei: u128) -> ExpectedPayment {
        ExpectedPayment {
            recipient,
            min_value_wei,
        }
    }

    #[test]
    fn valid_payment_is_verified() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: Some(1),
            to: Some(recipient),
            value_wei: 1_000,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::Verified
        );
    }

    #[test]
    fn exceeding_minimum_amount_is_verified() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: Some(1),
            to: Some(recipient),
            value_wei: 5_000,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::Verified
        );
    }

    #[test]
    fn missing_receipt_is_not_confirmed() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: None,
            to: None,
            value_wei: 0,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::NotConfirmed
        );
    }

    #[test]
    fn reverted_tx_fails() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: Some(0),
            to: Some(recipient),
            value_wei: 1_000,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::TxFailed
        );
    }

    #[test]
    fn wrong_recipient_is_rejected() {
        let recipient = address(0xaa);
        let wrong_recipient = address(0xbb);
        let facts = TxPaymentFacts {
            status: Some(1),
            to: Some(wrong_recipient),
            value_wei: 1_000,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::WrongRecipient
        );
    }

    #[test]
    fn contract_creation_tx_has_no_recipient() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: Some(1),
            to: None,
            value_wei: 1_000,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::WrongRecipient
        );
    }

    #[test]
    fn insufficient_amount_is_rejected() {
        let recipient = address(0xaa);
        let facts = TxPaymentFacts {
            status: Some(1),
            to: Some(recipient),
            value_wei: 999,
        };
        assert_eq!(
            verify_payment(&facts, &expected(recipient, 1_000)),
            PopVerification::InsufficientAmount
        );
    }

    /// Mock [`JsonRpcTransport`], local to this module's tests (the one in `monad_http.rs` is
    /// private to that module), returning a canned response per JSON-RPC method so
    /// [`verify_payment_via_receipt`]'s multi-call flow (receipt, then full tx) can be exercised
    /// without a network call.
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

    #[tokio::test]
    async fn verify_payment_via_receipt_end_to_end_success() {
        let recipient_hex = format!("0x{}", "aa".repeat(20));
        let from_hex = format!("0x{}", "bb".repeat(20));
        let tx_hash_hex = format!("0x{}", "cc".repeat(32));
        let block_hash_hex = format!("0x{}", "dd".repeat(32));

        let transport = MockTransport::new([
            (
                "eth_getTransactionReceipt",
                json!({
                    "transactionHash": tx_hash_hex,
                    "blockHash": block_hash_hex,
                    "blockNumber": "0x2a",
                    "from": from_hex,
                    "to": recipient_hex,
                    "contractAddress": null,
                    "gasUsed": "0x5208",
                    "status": "0x1",
                    "logs": [],
                }),
            ),
            (
                "eth_getTransactionByHash",
                json!({
                    "hash": tx_hash_hex,
                    "from": from_hex,
                    "to": recipient_hex,
                    "value": "0x3e8",
                    "input": "0x",
                }),
            ),
        ]);
        let client = MonadHttpClient::with_transport(transport);
        let recipient = Address::from_hex(&recipient_hex).unwrap();
        let tx_hash = Hash32::from_hex(&tx_hash_hex).unwrap();

        let result = verify_payment_via_receipt(&client, tx_hash, &expected(recipient, 1_000))
            .await
            .unwrap();
        assert_eq!(result, PopVerification::Verified);
    }

    #[tokio::test]
    async fn verify_payment_via_receipt_handles_missing_receipt() {
        let transport = MockTransport::new([("eth_getTransactionReceipt", Value::Null)]);
        let client = MonadHttpClient::with_transport(transport);
        let recipient = address(0xaa);
        let tx_hash = Hash32::from_hex(&format!("0x{}", "ee".repeat(32))).unwrap();

        let result = verify_payment_via_receipt(&client, tx_hash, &expected(recipient, 1_000))
            .await
            .unwrap();
        assert_eq!(result, PopVerification::NotConfirmed);
    }

    #[tokio::test]
    async fn verify_payment_via_receipt_stops_at_wrong_recipient_without_fetching_tx() {
        let actual_to = format!("0x{}", "99".repeat(20));
        let from_hex = format!("0x{}", "bb".repeat(20));
        let tx_hash_hex = format!("0x{}", "cc".repeat(32));
        let block_hash_hex = format!("0x{}", "dd".repeat(32));

        // No `eth_getTransactionByHash` response configured: verification must short-circuit on
        // the recipient mismatch (from the receipt alone) before ever calling it.
        let transport = MockTransport::new([(
            "eth_getTransactionReceipt",
            json!({
                "transactionHash": tx_hash_hex,
                "blockHash": block_hash_hex,
                "blockNumber": "0x2a",
                "from": from_hex,
                "to": actual_to,
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        )]);
        let client = MonadHttpClient::with_transport(transport);
        let recipient = address(0xaa);
        let tx_hash = Hash32::from_hex(&tx_hash_hex).unwrap();

        let result = verify_payment_via_receipt(&client, tx_hash, &expected(recipient, 1_000))
            .await
            .unwrap();
        assert_eq!(result, PopVerification::WrongRecipient);
    }
}
