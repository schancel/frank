//! Relay-side broadcast-and-verify wiring for a Monad Stamp burn (ticket #19).
//!
//! Per the parent design (`PLAN.md` M4 / ticket #6's acceptance criterion), Stamp differs from
//! POP in that the **relay itself broadcasts** the sender's pre-signed raw burn tx (rather than
//! requiring the client to have already landed it on-chain), matching the existing Lotus-path
//! pattern (`Registry::validate_burn_tx` calling `ChainAdapter::submit_tx`/`test_accept`). This
//! module is the Monad counterpart of that broadcast step, built on top of:
//! - [`crate::monad_http::MonadHttpClient::send_raw_transaction`] (ticket #12) to broadcast, and
//! - [`crate::monad_stamp_verify::verify_stamp_burn`] (ticket #16) to confirm + verify the burn
//!   once mined.
//!
//! [`broadcast_and_verify_stamp`] wires those two together with a poll loop (Monad confirmation
//! isn't instantaneous) and produces a [`StampRelayOutcome`] that distinguishes *why* a stamp was
//! rejected -- a broadcast-time RPC failure (e.g. a nonce conflict) is a different outcome than a
//! verification failure, per this ticket's acceptance criteria, so callers (and the nonce-race
//! subtask) can branch on which happened instead of getting a single generic error.
//!
//! ## Scope and a load-bearing open question this ticket found (read before wiring this in)
//!
//! This module only implements the broadcast+poll+verify primitive. It deliberately does **not**
//! touch `http/server.rs`'s `handle_put_message` / `PutMessageRequest`, nor
//! `registry.rs`'s `Registry::put_message`, nor `cashweb-payload`'s `SignedPayload`/`verify.rs`.
//! Reason: wiring this into the live `PUT /message` path requires deciding *how an incoming
//! request selects the Monad path over the existing Lotus path*, and that decision turns out to
//! need a wire-format change this ticket's ownership rules say not to guess at:
//!
//! - `cashweb_payload::proto::SignedPayload.burn_txs` is a `repeated BurnTx { tx: bytes, burn_idx:
//!   uint32 }`, and `SignedPayload::parse_proto` (`cashweb-payload/src/payload.rs`)
//!   unconditionally deserializes every `burn_tx.tx` as a Lotus `UnhashedTx`
//!   (`UnhashedTx::deser`), then `SignedPayload::verify` (`cashweb-payload/src/verify.rs`)
//!   unconditionally parses `burn_output.script` as a Bitcoin `OP_RETURN` script. Neither concept
//!   (a Lotus `Tx`, an output index into it, a `Script`) exists for a Monad tx (an RLP-encoded EVM
//!   tx with calldata, no outputs) -- an incoming raw Monad tx cannot be carried through
//!   `burn_txs` today, and there is no existing field/flag anywhere in the wire format (proto,
//!   HTTP headers via `RelayInfo`, or the route table) that says "verify this one against Monad
//!   instead of Lotus."
//! - Making Monad stamps work over the wire therefore requires *someone* to decide new
//!   protocol shape -- e.g. a new `oneof`/message alongside `burn_txs` carrying a raw EVM tx, or a
//!   dedicated `PUT /message/monad` route with its own request shape -- and that decision also
//!   touches `cashweb-payload::payload.rs`/`verify.rs`, which are out of this ticket's edit
//!   ownership (ticket #16's module docs record the same "ownership rules forbid editing
//!   verify.rs" constraint).
//! - Per this ticket's explicit instructions ("if it's ambiguous how to select Lotus vs Monad
//!   path for a given incoming message, stop and document the ambiguity... rather than guessing
//!   at new wire-format decisions"), this module stops here: it hands the next
//!   ticket/decision-maker a fully-implemented, fully-tested broadcast+verify primitive ready to
//!   be called the moment a request shape exists to feed it (`raw_tx: &[u8]` +
//!   `monad_stamp_verify::ExpectedBurn`), rather than inventing that request shape itself.
//!
//! Whoever picks up that wire-format decision should gate `Registry`-equivalent message storage
//! on `StampRelayOutcome::Verified` exactly the way `Registry::put_message`'s Lotus path gates on
//! `validate_burn_txs` succeeding -- every other [`StampRelayOutcome`] variant is a rejection, not
//! a silent store, matching parent ticket #6's acceptance criterion.

use std::time::Duration;

use bitcoinsuite_error::{Result, WrapErr};

use crate::{
    monad_http::{Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_verify::{verify_stamp_burn, ExpectedBurn, StampBurnVerification},
};

/// How [`broadcast_and_verify_stamp`] polls for the broadcast tx's confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PollConfig {
    /// Delay between successive `eth_getTransactionReceipt` polls.
    pub interval: Duration,
    /// Maximum number of verification attempts (the first attempt counts as one) before giving
    /// up and reporting [`StampRelayOutcome::ConfirmationTimedOut`].
    pub max_attempts: u32,
}

impl Default for PollConfig {
    /// 20 attempts, 500ms apart (~10s total) -- generous enough for Monad's block time without
    /// hanging a request indefinitely on a tx that never confirms.
    fn default() -> Self {
        PollConfig {
            interval: Duration::from_millis(500),
            max_attempts: 20,
        }
    }
}

/// Outcome of [`broadcast_and_verify_stamp`], distinguishing every way a Monad stamp can fail to
/// result in a storable message, so callers never have to collapse a broadcast-time RPC failure
/// (e.g. a nonce conflict, relevant to the nonce-race subtask) and a verification failure into the
/// same generic error.
///
/// Doesn't derive `Clone`/`PartialEq`/`Eq`: [`StampRelayOutcome::BroadcastFailed`] wraps
/// [`MonadRpcError`], which itself wraps a `reqwest::Error` that implements neither (tests below
/// compare via `matches!`/field access instead).
#[derive(Debug)]
pub enum StampRelayOutcome {
    /// Broadcast succeeded, the tx confirmed, and it verified as a valid stamp burn. The caller
    /// may store the associated message.
    Verified {
        /// Hash of the broadcast (and now-confirmed) transaction.
        tx_hash: Hash32,
    },
    /// `eth_sendRawTransaction` itself failed (e.g. `MonadRpcError::NonceTooLow`,
    /// `InsufficientFunds`, `ReplacementUnderpriced`). Distinguishable from
    /// [`StampRelayOutcome::VerificationFailed`] so the nonce-race subtask can assert on it
    /// specifically rather than it being swallowed into a generic verification failure.
    BroadcastFailed(MonadRpcError),
    /// The tx broadcast without error, but never confirmed within the configured polling budget.
    /// Treated as a rejection, not stored, same as any other non-`Verified` outcome.
    ConfirmationTimedOut {
        /// Hash of the broadcast (still-unconfirmed) transaction.
        tx_hash: Hash32,
    },
    /// The tx confirmed, but [`verify_stamp_burn`] didn't return `Verified` (wrong recipient,
    /// insufficient value, wrong/malformed commitment, or the tx itself reverted).
    VerificationFailed {
        /// Hash of the confirmed transaction that failed verification.
        tx_hash: Hash32,
        /// Why verification failed.
        outcome: StampBurnVerification,
    },
}

impl StampRelayOutcome {
    /// Whether this outcome means the associated message may be stored. Only
    /// [`StampRelayOutcome::Verified`] counts -- every other variant is a rejection.
    pub fn is_verified(&self) -> bool {
        matches!(self, StampRelayOutcome::Verified { .. })
    }
}

/// Broadcast `raw_tx` via `eth_sendRawTransaction`, then poll for its confirmation and verify it
/// against `expected`, per this ticket's acceptance criteria:
///
/// 1. The relay broadcasts the sender's raw tx itself (never requires the client to have already
///    landed it on-chain).
/// 2. After broadcast, it polls for the receipt and runs [`verify_stamp_burn`] against it.
/// 3. Only [`StampRelayOutcome::Verified`] should lead to storing the associated message; every
///    other outcome (including a timeout) is a rejection.
/// 4. A broadcast-time RPC failure is reported as [`StampRelayOutcome::BroadcastFailed`], never
///    collapsed into a verification failure.
///
/// Returns `Err` only for infrastructure failures from `verify_stamp_burn` itself (see its docs);
/// every expected rejection reason is a distinct `Ok(StampRelayOutcome)` variant.
pub async fn broadcast_and_verify_stamp<T>(
    transport: &T,
    raw_tx: &[u8],
    expected: &ExpectedBurn,
    poll: PollConfig,
) -> Result<StampRelayOutcome>
where
    T: JsonRpcTransport + Clone,
{
    let client = MonadHttpClient::with_transport(transport.clone());

    let tx_hash = match client.send_raw_transaction(raw_tx).await {
        Ok(submitted) => submitted.tx_hash,
        Err(err) => return Ok(StampRelayOutcome::BroadcastFailed(err)),
    };

    let max_attempts = poll.max_attempts.max(1);
    for attempt in 0..max_attempts {
        let outcome = verify_stamp_burn(transport, tx_hash, expected)
            .await
            .wrap_err_with(|| format!("verifying Monad stamp burn {tx_hash} after broadcast"))?;

        match outcome {
            StampBurnVerification::TxNotConfirmed => {
                if attempt + 1 < max_attempts {
                    tokio::time::sleep(poll.interval).await;
                    continue;
                }
                return Ok(StampRelayOutcome::ConfirmationTimedOut { tx_hash });
            }
            StampBurnVerification::Verified => {
                return Ok(StampRelayOutcome::Verified { tx_hash });
            }
            other => return Ok(StampRelayOutcome::VerificationFailed { tx_hash, outcome: other }),
        }
    }
    // Unreachable given `max_attempts >= 1` (the loop above always returns on its last
    // iteration), but keeps the function total instead of relying on that invariant silently.
    Ok(StampRelayOutcome::ConfirmationTimedOut { tx_hash })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::{ecc::PUBKEY_LENGTH, Hashed, Sha256};
    use serde_json::Value;

    use super::*;
    use crate::monad_http::Address;

    const STMP: [u8; 4] = *b"STMP";
    const COMMITMENT_VERSION_TAG: u8 = 0x01;

    fn hex_addr(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 20]))
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    fn commitment_calldata(commitment: &Sha256) -> String {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&STMP);
        calldata.push(COMMITMENT_VERSION_TAG);
        calldata.extend_from_slice(commitment.as_slice());
        format!("0x{}", hex::encode(calldata))
    }

    fn receipt_json(to: &str, status: &str) -> Value {
        serde_json::json!({
            "transactionHash": hex_hash(0x11),
            "blockHash": hex_hash(0x22),
            "blockNumber": "0x2a",
            "from": hex_addr(0x33),
            "to": to,
            "contractAddress": null,
            "gasUsed": "0x5208",
            "status": status,
            "logs": [],
        })
    }

    fn tx_json(to: &str, value_wei: u128, input_hex: &str) -> Value {
        serde_json::json!({
            "hash": hex_hash(0x11),
            "to": to,
            "value": format!("0x{:x}", value_wei),
            "input": input_hex,
            "from": hex_addr(0x33),
        })
    }

    fn expected_burn(commitment: Sha256) -> ExpectedBurn {
        ExpectedBurn {
            commitment_id: STMP,
            commitment,
            burn_address: Address::from_hex(&hex_addr(0x44)).unwrap(),
            min_value_wei: 10_000,
        }
    }

    fn fast_poll() -> PollConfig {
        PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 5,
        }
    }

    /// Mock [`JsonRpcTransport`] whose response per-method can change across calls (needed to
    /// simulate "unconfirmed, then confirmed on a later poll"), and which can be configured to
    /// fail `eth_sendRawTransaction` outright to simulate a broadcast-time RPC error.
    #[derive(Clone, Default)]
    struct MockTransport {
        /// Canned responses per method, popped from the front on each call (the last one repeats
        /// once exhausted) so a method's response can change across successive polls.
        responses: Arc<Mutex<HashMap<String, Vec<Value>>>>,
        send_raw_transaction_error: Arc<Mutex<Option<String>>>,
        call_counts: Arc<Mutex<HashMap<String, usize>>>,
        receipt_poll_count: Arc<AtomicUsize>,
    }

    impl MockTransport {
        fn set_sequence(&self, method: &str, responses: Vec<Value>) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), responses);
            self
        }

        fn set(&self, method: &str, response: Value) -> &Self {
            self.set_sequence(method, vec![response])
        }

        fn fail_send_raw_transaction(&self, message: &str) -> &Self {
            *self.send_raw_transaction_error.lock().unwrap() = Some(message.to_string());
            self
        }

        fn call_count(&self, method: &str) -> usize {
            *self.call_counts.lock().unwrap().get(method).unwrap_or(&0)
        }
    }

    impl fmt::Debug for MockTransport {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("MockTransport").finish()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            *self
                .call_counts
                .lock()
                .unwrap()
                .entry(method.to_string())
                .or_insert(0) += 1;

            if method == "eth_sendRawTransaction" {
                if let Some(message) = self.send_raw_transaction_error.lock().unwrap().clone() {
                    return Err(MonadRpcError::NonceTooLow {
                        method: method.to_string(),
                        message,
                    });
                }
                return Ok(Value::String(hex_hash(0x11)));
            }

            if method == "eth_getTransactionReceipt" {
                let idx = self.receipt_poll_count.fetch_add(1, Ordering::SeqCst);
                let responses = self.responses.lock().unwrap();
                let seq = responses.get(method).cloned().unwrap_or_default();
                if seq.is_empty() {
                    return Err(MonadRpcError::InvalidResponse {
                        method: method.to_string(),
                        reason: "no mock response configured".to_string(),
                    });
                }
                let response = seq.get(idx).cloned().unwrap_or_else(|| seq.last().unwrap().clone());
                return Ok(response);
            }

            self.responses
                .lock()
                .unwrap()
                .get(method)
                .and_then(|seq| seq.first().cloned())
                .ok_or_else(|| MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured for this method".to_string(),
                })
        }
    }

    fn make_commitment() -> Sha256 {
        Sha256::digest(vec![9, 9, 9].into())
    }

    #[tokio::test]
    async fn verified_on_first_poll() {
        let commitment = make_commitment();
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment)),
        );

        let outcome = broadcast_and_verify_stamp(
            &transport,
            &[0xde, 0xad, 0xbe, 0xef],
            &expected_burn(commitment),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(outcome.is_verified());
        match outcome {
            StampRelayOutcome::Verified { tx_hash } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_sendRawTransaction"), 1);
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 1);
    }

    #[tokio::test]
    async fn verified_after_polling_past_unconfirmed() {
        let commitment = make_commitment();
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        // Not confirmed for the first two polls, then confirmed on the third.
        transport.set_sequence(
            "eth_getTransactionReceipt",
            vec![Value::Null, Value::Null, receipt_json(&to, "0x1")],
        );
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&commitment)),
        );

        let outcome = broadcast_and_verify_stamp(
            &transport,
            &[1, 2, 3],
            &expected_burn(commitment),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(outcome.is_verified());
        match outcome {
            StampRelayOutcome::Verified { tx_hash } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 3);
    }

    #[tokio::test]
    async fn broadcast_failure_is_distinguishable_from_verification_failure() {
        let transport = MockTransport::default();
        transport.fail_send_raw_transaction("nonce too low: next nonce 5, tx nonce 3");

        let outcome = broadcast_and_verify_stamp(
            &transport,
            &[1, 2, 3],
            &expected_burn(make_commitment()),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(matches!(
            outcome,
            StampRelayOutcome::BroadcastFailed(MonadRpcError::NonceTooLow { .. })
        ));
        assert!(!outcome.is_verified());
        // Never even attempts to poll for a receipt once broadcast itself failed.
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 0);
    }

    #[tokio::test]
    async fn verification_failure_is_rejected_not_stored() {
        let expected_commitment = Sha256::new([1u8; 32]);
        let actual_commitment = Sha256::new([2u8; 32]);
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &commitment_calldata(&actual_commitment)),
        );

        let outcome = broadcast_and_verify_stamp(
            &transport,
            &[1, 2, 3],
            &expected_burn(expected_commitment.clone()),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(!outcome.is_verified());
        match outcome {
            StampRelayOutcome::VerificationFailed { tx_hash, outcome } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
                assert_eq!(
                    outcome,
                    StampBurnVerification::WrongCommitment {
                        expected: expected_commitment,
                        actual: actual_commitment,
                    }
                );
            }
            other => panic!("expected VerificationFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn confirmation_timeout_is_rejected_not_stored() {
        let transport = MockTransport::default();
        // Never confirms.
        transport.set("eth_getTransactionReceipt", Value::Null);

        let poll = PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 3,
        };
        let outcome = broadcast_and_verify_stamp(
            &transport,
            &[1, 2, 3],
            &expected_burn(make_commitment()),
            poll,
        )
        .await
        .unwrap();

        assert!(!outcome.is_verified());
        match outcome {
            StampRelayOutcome::ConfirmationTimedOut { tx_hash } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
            }
            other => panic!("expected ConfirmationTimedOut, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 3);
    }

    /// Sanity check that [`PUBKEY_LENGTH`] is still imported/used (keeps the import from going
    /// stale if the other tests above are trimmed later); also documents that
    /// [`crate::monad_stamp_verify::calc_expected_commitment`] is the intended way callers should
    /// compute a real `ExpectedBurn.commitment` (this module doesn't recompute it itself).
    #[test]
    fn pubkey_length_sanity() {
        assert_eq!(PUBKEY_LENGTH, 33);
    }
}
