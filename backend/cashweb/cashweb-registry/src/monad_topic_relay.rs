//! Relay-side broadcast-and-verify wiring for a Monad topic-vote burn (ticket #30).
//!
//! Direction-aware, exact-value counterpart of
//! [`crate::monad_stamp_relay::broadcast_and_verify_stamp`]: broadcasts a vote's raw burn tx
//! itself (the relay never requires the client to have already landed it on-chain, same
//! convention as Stamp), polls for its confirmation, and verifies it via
//! [`crate::monad_topic_verify::verify_topic_vote_burn`] instead of `verify_stamp_burn`.
//!
//! See [`crate::monad_topic_verify`]'s module docs ("Why this can't just call
//! `broadcast_and_verify_stamp`") for why this is a new, sibling function rather than a call into
//! the existing one: `broadcast_and_verify_stamp` is concretely typed to
//! [`crate::monad_stamp_verify::ExpectedBurn`]/[`crate::monad_stamp_verify::StampBurnVerification`]
//! with no seam to substitute this ticket's different calldata layout or its richer
//! value+direction outcome, and generalizing it would mean editing `monad_stamp_relay.rs`, out of
//! this ticket's edit ownership. This module reuses [`PollConfig`] directly (re-exported from
//! `monad_stamp_relay` rather than redefined) and mirrors `broadcast_and_verify_stamp`'s
//! broadcast+poll loop structure exactly, byte-for-byte, just calling a different verify function.

use bitcoinsuite_error::{Result, WrapErr};

use crate::{
    monad_http::{Hash32, JsonRpcTransport, MonadHttpClient, MonadRpcError},
    monad_stamp_relay::PollConfig,
    monad_topic_verify::{
        verify_topic_vote_burn, ExpectedTopicBurn, TopicVoteBurnVerification, VoteDirection,
    },
};

/// Outcome of [`broadcast_and_verify_topic_vote`]. Structurally mirrors
/// [`crate::monad_stamp_relay::StampRelayOutcome`], with [`TopicVoteRelayOutcome::Verified`]
/// additionally carrying the vote's exact weight (value + direction) rather than just a tx hash.
///
/// Doesn't derive `Clone`/`PartialEq`/`Eq`, for the same reason `StampRelayOutcome` doesn't:
/// [`TopicVoteRelayOutcome::BroadcastFailed`] wraps [`MonadRpcError`], which wraps a
/// non-`Clone`/`PartialEq` `reqwest::Error`.
#[derive(Debug)]
pub enum TopicVoteRelayOutcome {
    /// Broadcast succeeded, the tx confirmed, and it verified as a valid topic-vote burn. The
    /// caller may record this vote with the given weight.
    Verified {
        /// Hash of the broadcast (and now-confirmed) transaction.
        tx_hash: Hash32,
        /// Exact value burned, in wei.
        value_wei: u128,
        /// This vote's direction.
        direction: VoteDirection,
    },
    /// `eth_sendRawTransaction` itself failed.
    BroadcastFailed(MonadRpcError),
    /// The tx broadcast without error, but never confirmed within the configured polling budget.
    ConfirmationTimedOut {
        /// Hash of the broadcast (still-unconfirmed) transaction.
        tx_hash: Hash32,
    },
    /// The tx confirmed, but [`verify_topic_vote_burn`] didn't return `Verified` (wrong
    /// recipient, wrong/malformed commitment, or the tx itself reverted).
    VerificationFailed {
        /// Hash of the confirmed transaction that failed verification.
        tx_hash: Hash32,
        /// Why verification failed.
        outcome: TopicVoteBurnVerification,
    },
}

impl TopicVoteRelayOutcome {
    /// Whether this outcome means the vote may be recorded. Only
    /// [`TopicVoteRelayOutcome::Verified`] counts -- every other variant is a rejection.
    pub fn is_verified(&self) -> bool {
        matches!(self, TopicVoteRelayOutcome::Verified { .. })
    }
}

/// Broadcast `raw_tx` via `eth_sendRawTransaction`, then poll for its confirmation and verify it
/// against `expected`, mirroring
/// [`crate::monad_stamp_relay::broadcast_and_verify_stamp`]'s loop exactly (see this module's
/// docs for why that function itself can't be called here).
///
/// Returns `Err` only for infrastructure failures from [`verify_topic_vote_burn`] itself; every
/// expected rejection reason is a distinct `Ok(TopicVoteRelayOutcome)` variant.
pub async fn broadcast_and_verify_topic_vote<T>(
    transport: &T,
    raw_tx: &[u8],
    expected: &ExpectedTopicBurn,
    poll: PollConfig,
) -> Result<TopicVoteRelayOutcome>
where
    T: JsonRpcTransport + Clone,
{
    let client = MonadHttpClient::with_transport(transport.clone());

    let tx_hash = match client.send_raw_transaction(raw_tx).await {
        Ok(submitted) => submitted.tx_hash,
        Err(err) => return Ok(TopicVoteRelayOutcome::BroadcastFailed(err)),
    };

    let max_attempts = poll.max_attempts.max(1);
    for attempt in 0..max_attempts {
        let outcome = verify_topic_vote_burn(transport, tx_hash, expected)
            .await
            .wrap_err_with(|| {
                format!("verifying Monad topic-vote burn {tx_hash} after broadcast")
            })?;

        match outcome {
            TopicVoteBurnVerification::TxNotConfirmed => {
                if attempt + 1 < max_attempts {
                    tokio::time::sleep(poll.interval).await;
                    continue;
                }
                return Ok(TopicVoteRelayOutcome::ConfirmationTimedOut { tx_hash });
            }
            TopicVoteBurnVerification::Verified {
                value_wei,
                direction,
            } => {
                return Ok(TopicVoteRelayOutcome::Verified {
                    tx_hash,
                    value_wei,
                    direction,
                });
            }
            other => {
                return Ok(TopicVoteRelayOutcome::VerificationFailed {
                    tx_hash,
                    outcome: other,
                })
            }
        }
    }
    // Unreachable given `max_attempts >= 1` (the loop above always returns on its last
    // iteration), but keeps the function total instead of relying on that invariant silently.
    Ok(TopicVoteRelayOutcome::ConfirmationTimedOut { tx_hash })
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
        time::Duration,
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::{Hashed, Sha256};
    use serde_json::Value;

    use super::*;
    use crate::{monad_http::Address, monad_topic_verify::TOPIC_VOTE_LOKAD_ID};

    fn hex_addr(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 20]))
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    fn commitment_calldata(direction: u8, commitment: &Sha256) -> String {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&TOPIC_VOTE_LOKAD_ID);
        calldata.push(crate::monad_topic_verify::TOPIC_COMMITMENT_VERSION_TAG);
        calldata.push(direction);
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

    fn expected_burn(commitment: Sha256) -> ExpectedTopicBurn {
        ExpectedTopicBurn {
            commitment,
            burn_address: Address::from_hex(&hex_addr(0x44)).unwrap(),
        }
    }

    fn fast_poll() -> PollConfig {
        PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 5,
        }
    }

    #[derive(Clone, Default)]
    struct MockTransport {
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
                let response = seq
                    .get(idx)
                    .cloned()
                    .unwrap_or_else(|| seq.last().unwrap().clone());
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
    async fn up_vote_verified_on_first_poll() {
        let commitment = make_commitment();
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                42_000,
                &commitment_calldata(VoteDirection::UP_BYTE, &commitment),
            ),
        );

        let outcome = broadcast_and_verify_topic_vote(
            &transport,
            &[0xde, 0xad, 0xbe, 0xef],
            &expected_burn(commitment),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(outcome.is_verified());
        match outcome {
            TopicVoteRelayOutcome::Verified {
                tx_hash,
                value_wei,
                direction,
            } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
                assert_eq!(value_wei, 42_000);
                assert_eq!(direction, VoteDirection::Up);
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_sendRawTransaction"), 1);
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 1);
    }

    #[tokio::test]
    async fn down_vote_verified_after_polling_past_unconfirmed() {
        let commitment = make_commitment();
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set_sequence(
            "eth_getTransactionReceipt",
            vec![Value::Null, Value::Null, receipt_json(&to, "0x1")],
        );
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                1_000,
                &commitment_calldata(VoteDirection::DOWN_BYTE, &commitment),
            ),
        );

        let outcome = broadcast_and_verify_topic_vote(
            &transport,
            &[1, 2, 3],
            &expected_burn(commitment),
            fast_poll(),
        )
        .await
        .unwrap();

        match outcome {
            TopicVoteRelayOutcome::Verified {
                value_wei,
                direction,
                ..
            } => {
                assert_eq!(value_wei, 1_000);
                assert_eq!(direction, VoteDirection::Down);
            }
            other => panic!("expected Verified, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 3);
    }

    #[tokio::test]
    async fn broadcast_failure_is_distinguishable_from_verification_failure() {
        let transport = MockTransport::default();
        transport.fail_send_raw_transaction("nonce too low: next nonce 5, tx nonce 3");

        let outcome = broadcast_and_verify_topic_vote(
            &transport,
            &[1, 2, 3],
            &expected_burn(make_commitment()),
            fast_poll(),
        )
        .await
        .unwrap();

        assert!(matches!(
            outcome,
            TopicVoteRelayOutcome::BroadcastFailed(MonadRpcError::NonceTooLow { .. })
        ));
        assert!(!outcome.is_verified());
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 0);
    }

    #[tokio::test]
    async fn confirmation_timeout_is_rejected() {
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", Value::Null);

        let poll = PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 3,
        };
        let outcome = broadcast_and_verify_topic_vote(
            &transport,
            &[1, 2, 3],
            &expected_burn(make_commitment()),
            poll,
        )
        .await
        .unwrap();

        assert!(!outcome.is_verified());
        match outcome {
            TopicVoteRelayOutcome::ConfirmationTimedOut { tx_hash } => {
                assert_eq!(tx_hash, Hash32::from_hex(&hex_hash(0x11)).unwrap());
            }
            other => panic!("expected ConfirmationTimedOut, got {other:?}"),
        }
        assert_eq!(transport.call_count("eth_getTransactionReceipt"), 3);
    }
}
