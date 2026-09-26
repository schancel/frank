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
//! ## `MonadHttpClient` gap: no way to fetch a tx's `value`
//!
//! `eth_getTransactionReceipt` (what [`crate::monad_http::MonadHttpClient::get_transaction_receipt`]
//! wraps) reports a transaction's `status` and `to`, but **not** its `value` — `value` lives on
//! the transaction itself (`eth_getTransactionByHash`), not on its receipt. `MonadHttpClient`
//! (ticket #12) doesn't currently expose a `get_transaction` (or similar) method to fetch it.
//!
//! This module does not add that method itself (out of scope / not this ticket's file to touch).
//! Instead:
//! - The core logic, [`verify_payment`], takes an already-assembled [`TxPaymentFacts`] (status +
//!   `to` + `value_wei`), so it's fully unit-testable today regardless of where `value_wei` came
//!   from.
//! - [`verify_payment_via_receipt`] is a thin async convenience that calls
//!   `MonadHttpClient::get_transaction_receipt` for `status`/`to`, but still requires the caller
//!   to supply `value_wei` out of band (e.g. once a `get_transaction` method lands on
//!   `MonadHttpClient`, or from another source) since the receipt alone can't provide it.
//!
//! Per the ticket, this gap is reported plainly in the handoff; ticket #16 (Stamp verification)
//! may independently hit the same gap and want the same `MonadHttpClient::get_transaction`
//! addition — that's expected and fine.

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
/// Callers assemble this from [`MonadHttpClient::get_transaction_receipt`] (`status`, `to`) plus
/// a `value_wei` sourced separately — see the module docs for why the receipt alone can't
/// provide `value`.
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
/// `status`/`to`) via `MonadHttpClient::get_transaction_receipt`, combines it with a
/// caller-supplied `value_wei` (see module docs for why this can't be fetched here), and
/// verifies.
///
/// Returns `Err` only for transport/RPC-level failures talking to the node; a missing receipt or
/// a failed/mismatched payment is a normal `Ok(PopVerification::...)`, not an error.
pub async fn verify_payment_via_receipt<T: JsonRpcTransport>(
    client: &MonadHttpClient<T>,
    tx_hash: Hash32,
    value_wei: u128,
    expected: &ExpectedPayment,
) -> Result<PopVerification, MonadRpcError> {
    let receipt = client.get_transaction_receipt(tx_hash).await?;
    let facts = match receipt {
        None => TxPaymentFacts {
            status: None,
            to: None,
            value_wei,
        },
        Some(receipt) => TxPaymentFacts {
            status: receipt.status,
            to: receipt.to,
            value_wei,
        },
    };
    Ok(verify_payment(&facts, expected))
}

#[cfg(test)]
mod tests {
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

    /// Minimal [`JsonRpcTransport`] mock, local to this module's tests (the one in
    /// `monad_http.rs` is private to that module), returning a single canned
    /// `eth_getTransactionReceipt`-shaped response.
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

    #[tokio::test]
    async fn verify_payment_via_receipt_end_to_end_success() {
        let recipient_hex = format!("0x{}", "aa".repeat(20));
        let from_hex = format!("0x{}", "bb".repeat(20));
        let tx_hash_hex = format!("0x{}", "cc".repeat(32));
        let block_hash_hex = format!("0x{}", "dd".repeat(32));

        let transport = MockTransport {
            response: json!({
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
        };
        let client = MonadHttpClient::with_transport(transport);
        let recipient = Address::from_hex(&recipient_hex).unwrap();
        let tx_hash = Hash32::from_hex(&tx_hash_hex).unwrap();

        let result = verify_payment_via_receipt(&client, tx_hash, 1_000, &expected(recipient, 1_000))
            .await
            .unwrap();
        assert_eq!(result, PopVerification::Verified);
    }

    #[tokio::test]
    async fn verify_payment_via_receipt_handles_missing_receipt() {
        let transport = MockTransport {
            response: Value::Null,
        };
        let client = MonadHttpClient::with_transport(transport);
        let recipient = address(0xaa);
        let tx_hash = Hash32::from_hex(&format!("0x{}", "ee".repeat(32))).unwrap();

        let result = verify_payment_via_receipt(&client, tx_hash, 1_000, &expected(recipient, 1_000))
            .await
            .unwrap();
        assert_eq!(result, PopVerification::NotConfirmed);
    }
}
