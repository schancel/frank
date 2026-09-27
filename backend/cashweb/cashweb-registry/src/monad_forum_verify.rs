//! Server-side verification of a Monad forum burn-weighted vote (ticket #30).
//!
//! This is the direction-aware, exact-value counterpart of
//! [`crate::monad_stamp_verify::verify_stamp_burn`]. That module's [`crate::monad_stamp_verify::
//! ExpectedBurn`]/[`crate::monad_stamp_verify::StampBurnVerification`] implement a
//! *minimum-threshold* pass/fail check (Stamp only cares that *enough* was burned; the exact
//! amount is discarded) over a `<lokad_id: 4><version: 1><commitment: 32>` calldata layout with no
//! room for a vote direction. A burn-weighted vote needs both of those things instead: the *exact*
//! burned value (used as the vote's weight) and an up/down **direction**, analogous to the Lotus
//! reference implementation's `POND`-tagged OP_RETURN output carrying an `OP_1`/`OP_0` vote opcode
//! (`app/src/cashweb/registry/index.ts`'s `constructBurnTransaction`/`calculateBurnAmount`).
//!
//! ## Calldata layout (this ticket's documented choice)
//!
//! ```text
//! <lokad_id: 4 bytes = "FRUM"><version: 1 byte><direction: 1 byte><commitment: 32 bytes>
//! ```
//!
//! i.e. [`monad_stamp_verify`](crate::monad_stamp_verify)'s `<lokad_id><version><commitment>`
//! layout with a single extra direction byte spliced in between `version` and `commitment`,
//! rather than a distinct up/down LOKAD ID pair (the ticket's other suggested option). One LOKAD
//! ID keeps a single verification function/route pair for both directions -- the direction is
//! *vote data*, not a routing decision, the same way Lotus's OP_1/OP_0 is a single opcode read
//! out of one `POND`-tagged script rather than two different burn-address conventions.
//!
//! - `lokad_id` is [`FORUM_VOTE_LOKAD_ID`] (`"FRUM"`), distinct from both
//!   [`cashweb_payload::verify::ADDRESS_METADATA_LOKAD_ID`] (`"STMP"`, plain Stamp) and
//!   [`cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID`] (`"POND"`, already used by the
//!   Monad-native plain-broadcast path `http::monad_message` -- ticket #27 -- for a
//!   minimum-threshold, non-directional burn). Reusing either existing ID for this new,
//!   differently-shaped calldata would let an indexer misinterpret one tagged burn as the other;
//!   a fresh LOKAD ID keeps the "one ID, one calldata shape" invariant those two already rely on.
//! - `version` is [`FORUM_COMMITMENT_VERSION_TAG`] (`0x01`), independent of
//!   [`crate::monad_stamp_verify::COMMITMENT_VERSION_TAG`] even though it happens to share the
//!   same numeric value -- it's a distinct constant of a distinct wire format, versioned
//!   separately going forward.
//! - `direction` is [`VoteDirection::UP_BYTE`] (`0x01`) for an up-vote or
//!   [`VoteDirection::DOWN_BYTE`] (`0x00`) for a down-vote, mirroring Lotus's `OP_1`/`OP_0`
//!   convention numerically (1 = up, 0 = down) even though EVM calldata has no opcode concept to
//!   literally reuse (same reasoning [`crate::monad_stamp_verify::COMMITMENT_VERSION_TAG`]'s docs
//!   give for using a plain byte instead of a Script opcode).
//! - `commitment` is `SHA256(target payload_hash)`'s... no -- see below: unlike Stamp's
//!   commitment (which hashes `SHA256(pubkey) || payload_hash)` because it needs to bind a
//!   specific pubkey), a forum vote has no separate pubkey to bind at all (identity is
//!   `ecrecover`-only, same as [`crate::monad_message`](crate::http::monad_message)'s scheme), so
//!   `commitment` is simply the *target* `payload_hash` itself (32 bytes, unhashed further) --
//!   the `payload_hash` of the post being voted on (for a [`crate::proto::MonadForumVote`]) or of
//!   the post being created (for a [`crate::proto::MonadForumPost`]'s own initial vote). This
//!   mirrors [`crate::http::monad_message::process_monad_message`]'s binding (`raw_burn_tx`'s
//!   calldata commits to `payload_hash` directly, not to a further hash of it) rather than
//!   [`crate::monad_stamp_verify::calc_expected_commitment`]'s pubkey-binding preimage, since
//!   there's no pubkey field anywhere in this ticket's proto messages to bind against (see
//!   `proto/forum_message.proto`'s module docs).
//!
//! ## Why this can't just call [`crate::monad_stamp_verify::parse_commitment_calldata`]
//!
//! That function's layout has no direction byte at all -- feeding it forum calldata would either
//! misread the direction byte as the first byte of a (now 33-byte, and therefore rejected as
//! [`crate::monad_stamp_verify::CalldataCommitmentError::InvalidCommitmentLength`]) commitment, or
//! require changing its signature/behavior, which is out of this ticket's edit ownership
//! (`monad_stamp_verify.rs` must keep working unchanged for #16/#19/#27's existing callers, per
//! this ticket's acceptance criteria). [`parse_forum_vote_calldata`] below is therefore a new,
//! parallel decoder for the new layout, structurally mirroring
//! `parse_commitment_calldata`'s checks (same ordering: length, LOKAD ID, version, then the
//! trailing fixed-length field) but not calling it.
//!
//! ## Why this can't just call [`crate::monad_stamp_relay::broadcast_and_verify_stamp`]
//!
//! `broadcast_and_verify_stamp` is hardcoded, by its own signature, to
//! [`crate::monad_stamp_verify::ExpectedBurn`] in and
//! [`crate::monad_stamp_verify::StampBurnVerification`] out -- it calls `verify_stamp_burn`
//! directly, with no seam to substitute a different verification function or a differently-shaped
//! calldata/outcome type. Its outcome type also has nowhere to carry the exact burned value or
//! direction this ticket needs as the vote's weight, even where its checks otherwise overlap
//! (confirmed, succeeded, right recipient). Generalizing it (e.g. making it generic over a verify
//! callback) would mean editing `monad_stamp_relay.rs`, which this ticket's ownership rules
//! forbid. [`crate::monad_forum_relay::broadcast_and_verify_forum_vote`] therefore mirrors its
//! broadcast+poll *shape* byte-for-byte (down to reusing
//! [`crate::monad_stamp_relay::PollConfig`] directly rather than redefining an equivalent type)
//! but calls [`verify_forum_vote_burn`] instead of `verify_stamp_burn`. This is the same kind of
//! "found it's not actually reusable as-is, documented why, extended instead" situation this
//! ticket's own body already calls out for `ExpectedBurn`/`StampBurnVerification` -- it turns out
//! to also apply to the relay wrapper one level up, not just the verification primitive itself.

use bitcoinsuite_core::Sha256;
use bitcoinsuite_error::{bail, Result, WrapErr};
use thiserror::Error;

use crate::monad_http::{Address, Hash32, JsonRpcTransport, MonadHttpClient};

/// LOKAD ID tagging a Monad forum-vote burn's calldata (this ticket's documented choice -- see
/// module docs). Distinct from `"STMP"` ([`cashweb_payload::verify::ADDRESS_METADATA_LOKAD_ID`])
/// and `"POND"` ([`cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID`]).
pub const FORUM_VOTE_LOKAD_ID: [u8; 4] = *b"FRUM";

/// Version tag for the `<lokad_id><version><direction><commitment>` calldata layout this module
/// decodes (see module docs). Independent of
/// [`crate::monad_stamp_verify::COMMITMENT_VERSION_TAG`].
pub const FORUM_COMMITMENT_VERSION_TAG: u8 = 0x01;

/// Fixed length, in bytes, of the `<lokad_id><version><direction>` prefix before the commitment.
const CALLDATA_PREFIX_LEN: usize = 6;
/// Required length, in bytes, of the commitment itself.
const CALLDATA_COMMITMENT_LEN: usize = 32;

/// A forum vote's direction, decoded from calldata's `direction` byte (see module docs). Mirrors
/// the Lotus reference implementation's `OP_1`/`OP_0` vote-opcode convention numerically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoteDirection {
    /// Up-vote: contributes `+value_wei` to a post's tally.
    Up,
    /// Down-vote: contributes `-value_wei` to a post's tally.
    Down,
}

impl VoteDirection {
    /// Calldata byte value for [`VoteDirection::Up`].
    pub const UP_BYTE: u8 = 0x01;
    /// Calldata byte value for [`VoteDirection::Down`].
    pub const DOWN_BYTE: u8 = 0x00;

    /// Decode a direction byte, or [`None`] if it's neither [`Self::UP_BYTE`] nor
    /// [`Self::DOWN_BYTE`].
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            Self::UP_BYTE => Some(VoteDirection::Up),
            Self::DOWN_BYTE => Some(VoteDirection::Down),
            _ => None,
        }
    }

    /// This direction's contribution to a signed vote-weight tally, given the exact burned value:
    /// `+value_wei` for [`VoteDirection::Up`], `-value_wei` for [`VoteDirection::Down`].
    ///
    /// Widens to `i128` (rather than `i64`) purely to safely hold a full `u128` wei value's
    /// magnitude with a sign; see `proto/forum_message.proto`'s docs on why the *stored,
    /// summed* tally is narrowed to `i64` at that later point instead.
    pub fn signed_weight(&self, value_wei: u128) -> i128 {
        match self {
            VoteDirection::Up => value_wei as i128,
            VoteDirection::Down => -(value_wei as i128),
        }
    }
}

/// Errors decoding a forum-vote commitment out of a Monad burn tx's calldata (`input` field).
/// Structurally mirrors [`crate::monad_stamp_verify::CalldataCommitmentError`], adapted to this
/// module's layout (see module docs).
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ForumCalldataError {
    /// Calldata is too short to even contain the fixed `<lokad_id><version><direction>` prefix.
    #[error("Forum vote calldata too short: expected at least {expected} bytes, got {actual}")]
    CalldataTooShort {
        /// Minimum required length ([`CALLDATA_PREFIX_LEN`]).
        expected: usize,
        /// Actual calldata length.
        actual: usize,
    },

    /// The first 4 bytes don't match [`FORUM_VOTE_LOKAD_ID`].
    #[error("Forum vote calldata expected LOKAD ID {expected} but got {actual}")]
    InvalidLokadId {
        /// Expected 4-byte LOKAD ID, hex-encoded.
        expected: String,
        /// Actual 4 bytes found, hex-encoded.
        actual: String,
    },

    /// Byte 4 doesn't match [`FORUM_COMMITMENT_VERSION_TAG`].
    #[error(
        "Forum vote calldata expected version tag {:#04x} but got {actual:#04x}",
        FORUM_COMMITMENT_VERSION_TAG
    )]
    InvalidVersion {
        /// Actual version byte found.
        actual: u8,
    },

    /// Byte 5 isn't a recognized [`VoteDirection`] byte.
    #[error(
        "Forum vote calldata expected direction byte {:#04x} (up) or {:#04x} (down) but got {actual:#04x}",
        VoteDirection::UP_BYTE, VoteDirection::DOWN_BYTE
    )]
    InvalidDirection {
        /// Actual direction byte found.
        actual: u8,
    },

    /// The calldata remaining after the `<lokad_id><version><direction>` prefix isn't exactly
    /// [`CALLDATA_COMMITMENT_LEN`] bytes (too short, or trailing garbage).
    #[error("Forum vote calldata expected a {expected}-byte commitment but got {actual} bytes")]
    InvalidCommitmentLength {
        /// Expected commitment length ([`CALLDATA_COMMITMENT_LEN`]).
        expected: usize,
        /// Actual number of remaining bytes.
        actual: usize,
    },
}

/// Decode and validate a forum-vote direction + commitment out of a Monad tx's calldata.
///
/// Calldata must look like this: `<lokad_id: FORUM_VOTE_LOKAD_ID><version:
/// FORUM_COMMITMENT_VERSION_TAG><direction: VoteDirection byte><commitment: 32 bytes>`. Purely a
/// byte-layout decode -- doesn't require any chain RPC calls, mirroring how
/// [`crate::monad_stamp_verify::parse_commitment_calldata`] operates purely on already-fetched
/// calldata bytes.
pub fn parse_forum_vote_calldata(
    calldata: &[u8],
) -> std::result::Result<(VoteDirection, Sha256), ForumCalldataError> {
    if calldata.len() < CALLDATA_PREFIX_LEN {
        return Err(ForumCalldataError::CalldataTooShort {
            expected: CALLDATA_PREFIX_LEN,
            actual: calldata.len(),
        });
    }

    let lokad_id = &calldata[0..4];
    if lokad_id != FORUM_VOTE_LOKAD_ID {
        return Err(ForumCalldataError::InvalidLokadId {
            expected: hex::encode(FORUM_VOTE_LOKAD_ID),
            actual: hex::encode(lokad_id),
        });
    }

    let version = calldata[4];
    if version != FORUM_COMMITMENT_VERSION_TAG {
        return Err(ForumCalldataError::InvalidVersion { actual: version });
    }

    let direction_byte = calldata[5];
    let direction =
        VoteDirection::from_byte(direction_byte).ok_or(ForumCalldataError::InvalidDirection {
            actual: direction_byte,
        })?;

    let commitment_bytes = &calldata[CALLDATA_PREFIX_LEN..];
    if commitment_bytes.len() != CALLDATA_COMMITMENT_LEN {
        return Err(ForumCalldataError::InvalidCommitmentLength {
            expected: CALLDATA_COMMITMENT_LEN,
            actual: commitment_bytes.len(),
        });
    }

    Ok((direction, Sha256::new(commitment_bytes.try_into().unwrap())))
}

/// What's required of a burn tx for it to count as a valid forum vote. Unlike
/// [`crate::monad_stamp_verify::ExpectedBurn`], there is deliberately no `min_value_wei` -- any
/// nonnegative value burned to `burn_address` with the right recipient/commitment is accepted,
/// and its exact value becomes the vote's weight (see module docs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedForumBurn {
    /// Expected commitment: the target post's `payload_hash` (32 bytes), unhashed further (see
    /// module docs for why this differs from Stamp's pubkey-binding preimage).
    pub commitment: Sha256,
    /// Address the burn tx must be sent to.
    pub burn_address: Address,
}

/// Outcome of verifying a Monad burn tx against an [`ExpectedForumBurn`]. Structurally mirrors
/// [`crate::monad_stamp_verify::StampBurnVerification`], minus
/// `InsufficientValue`/`WrongCommitment`'s Stamp framing: verification here doesn't threshold the
/// value at all, it returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForumVoteBurnVerification {
    /// The burn tx confirmed successfully, was sent to the expected address, and its calldata
    /// commitment matched the expected commitment. `value_wei`/`direction` are this vote's exact
    /// weight, decoded straight from the tx's value and calldata.
    Verified {
        /// Exact value burned, in wei -- this vote's weight magnitude.
        value_wei: u128,
        /// This vote's direction, decoded from calldata.
        direction: VoteDirection,
    },
    /// The node has no receipt for this tx hash (unmined, or unknown to the node).
    TxNotConfirmed,
    /// The tx was mined but reverted (`status` = 0).
    TxFailed,
    /// The tx wasn't sent to the expected burn address.
    WrongRecipient {
        /// The burn address the tx was expected to be sent to.
        expected: Address,
        /// The tx's actual recipient (`None` for a contract-creation tx).
        actual: Option<Address>,
    },
    /// The tx's calldata didn't parse as a well-formed forum-vote calldata blob.
    MalformedCalldata(ForumCalldataError),
    /// The tx's calldata commitment didn't match the expected commitment (e.g. it committed to a
    /// different post's `payload_hash`).
    WrongCommitment {
        /// Expected commitment (target `payload_hash`).
        expected: Sha256,
        /// Actual commitment decoded from the tx's calldata.
        actual: Sha256,
    },
}

/// Verify that `tx_hash` is a valid forum-vote burn against `expected`, returning its exact
/// value + direction as the vote's weight rather than a pass/fail against a minimum.
///
/// Mirrors [`crate::monad_stamp_verify::verify_stamp_burn`]'s flow (fetch receipt, check
/// status/recipient, fetch full tx, decode+check calldata) -- see this module's docs for why it
/// can't call that function directly given the different calldata layout and richer outcome type.
///
/// Returns `Err` only for infrastructure failures (RPC/transport errors, or a node returning an
/// internally-inconsistent response); every verification failure is a distinct `Ok` variant of
/// [`ForumVoteBurnVerification`], never an `Err`.
pub async fn verify_forum_vote_burn<T>(
    transport: &T,
    tx_hash: Hash32,
    expected: &ExpectedForumBurn,
) -> Result<ForumVoteBurnVerification>
where
    T: JsonRpcTransport + Clone,
{
    let client = MonadHttpClient::with_transport(transport.clone());

    let receipt = client
        .get_transaction_receipt(tx_hash)
        .await
        .wrap_err_with(|| format!("fetching Monad tx receipt for {tx_hash}"))?;
    let receipt = match receipt {
        Some(receipt) => receipt,
        None => return Ok(ForumVoteBurnVerification::TxNotConfirmed),
    };

    if receipt.succeeded() != Some(true) {
        return Ok(ForumVoteBurnVerification::TxFailed);
    }

    if receipt.to != Some(expected.burn_address) {
        return Ok(ForumVoteBurnVerification::WrongRecipient {
            expected: expected.burn_address,
            actual: receipt.to,
        });
    }

    let tx = client
        .get_transaction_by_hash(tx_hash)
        .await
        .wrap_err_with(|| format!("fetching Monad tx {tx_hash}"))?;
    let tx = match tx {
        Some(tx) => tx,
        // Same node-inconsistency reasoning as `verify_stamp_burn`: a receipt with no matching
        // transaction record is an infrastructure failure, not a normal verification outcome.
        None => bail!(
            "Monad tx {tx_hash} has a receipt but eth_getTransactionByHash returned nothing \
             (node inconsistency)"
        ),
    };

    let (direction, commitment) = match parse_forum_vote_calldata(&tx.input) {
        Ok(decoded) => decoded,
        Err(err) => return Ok(ForumVoteBurnVerification::MalformedCalldata(err)),
    };

    if commitment != expected.commitment {
        return Ok(ForumVoteBurnVerification::WrongCommitment {
            expected: expected.commitment.clone(),
            actual: commitment,
        });
    }

    Ok(ForumVoteBurnVerification::Verified {
        value_wei: tx.value,
        direction,
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fmt, sync::Mutex};

    use async_trait::async_trait;
    use bitcoinsuite_core::Hashed;
    use serde_json::Value;

    use crate::monad_http::MonadRpcError;

    use super::*;

    fn hex_addr(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 20]))
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    fn commitment_calldata(direction: u8, commitment: &[u8]) -> Vec<u8> {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&FORUM_VOTE_LOKAD_ID);
        calldata.push(FORUM_COMMITMENT_VERSION_TAG);
        calldata.push(direction);
        calldata.extend_from_slice(commitment);
        calldata
    }

    #[test]
    fn parse_forum_vote_calldata_valid_up() {
        let commitment = [7u8; 32];
        let calldata = commitment_calldata(VoteDirection::UP_BYTE, &commitment);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Ok((VoteDirection::Up, Sha256::new(commitment))),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_valid_down() {
        let commitment = [7u8; 32];
        let calldata = commitment_calldata(VoteDirection::DOWN_BYTE, &commitment);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Ok((VoteDirection::Down, Sha256::new(commitment))),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_too_short() {
        assert_eq!(
            parse_forum_vote_calldata(&[0x46, 0x52, 0x55]),
            Err(ForumCalldataError::CalldataTooShort {
                expected: 6,
                actual: 3,
            }),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_wrong_lokad_id() {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(b"POND");
        calldata.push(FORUM_COMMITMENT_VERSION_TAG);
        calldata.push(VoteDirection::UP_BYTE);
        calldata.extend_from_slice(&[1u8; 32]);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Err(ForumCalldataError::InvalidLokadId {
                expected: hex::encode(FORUM_VOTE_LOKAD_ID),
                actual: hex::encode(b"POND"),
            }),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_wrong_version() {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&FORUM_VOTE_LOKAD_ID);
        calldata.push(0x99);
        calldata.push(VoteDirection::UP_BYTE);
        calldata.extend_from_slice(&[1u8; 32]);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Err(ForumCalldataError::InvalidVersion { actual: 0x99 }),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_invalid_direction() {
        let calldata = commitment_calldata(0x02, &[1u8; 32]);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Err(ForumCalldataError::InvalidDirection { actual: 0x02 }),
        );
    }

    #[test]
    fn parse_forum_vote_calldata_wrong_commitment_length() {
        let calldata = commitment_calldata(VoteDirection::UP_BYTE, &[1u8; 10]);
        assert_eq!(
            parse_forum_vote_calldata(&calldata),
            Err(ForumCalldataError::InvalidCommitmentLength {
                expected: 32,
                actual: 10,
            }),
        );
    }

    /// Mock [`JsonRpcTransport`] that returns a canned response per JSON-RPC method -- same shape
    /// as `monad_stamp_verify`'s test mock.
    #[derive(Clone, Default)]
    struct MockTransport {
        responses: std::sync::Arc<Mutex<HashMap<String, Value>>>,
        calls: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
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
            self.calls.lock().unwrap().push(method.to_string());
            self.responses
                .lock()
                .unwrap()
                .get(method)
                .cloned()
                .ok_or_else(|| MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured for this method".to_string(),
                })
        }
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

    fn burn_address() -> Address {
        Address::from_hex(&hex_addr(0x44)).unwrap()
    }

    fn expected_burn(commitment: Sha256) -> ExpectedForumBurn {
        ExpectedForumBurn {
            commitment,
            burn_address: burn_address(),
        }
    }

    fn valid_calldata(direction: u8, commitment: &Sha256) -> String {
        format!(
            "0x{}",
            hex::encode(commitment_calldata(direction, commitment.as_slice()))
        )
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_valid_up_vote() {
        let commitment = Sha256::digest(vec![9, 9, 9].into());
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                12_345,
                &valid_calldata(VoteDirection::UP_BYTE, &commitment),
            ),
        );

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            ForumVoteBurnVerification::Verified {
                value_wei: 12_345,
                direction: VoteDirection::Up,
            },
        );
        assert_eq!(
            transport.calls(),
            vec!["eth_getTransactionReceipt", "eth_getTransactionByHash"],
        );
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_valid_down_vote() {
        let commitment = Sha256::digest(vec![1, 2, 3].into());
        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                500,
                &valid_calldata(VoteDirection::DOWN_BYTE, &commitment),
            ),
        );

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            ForumVoteBurnVerification::Verified {
                value_wei: 500,
                direction: VoteDirection::Down,
            },
        );
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_commitment_mismatch() {
        let expected_commitment = Sha256::new([1u8; 32]);
        let actual_commitment = Sha256::new([2u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                10_000,
                &valid_calldata(VoteDirection::UP_BYTE, &actual_commitment),
            ),
        );

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(expected_commitment.clone()),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            ForumVoteBurnVerification::WrongCommitment {
                expected: expected_commitment,
                actual: actual_commitment,
            },
        );
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_wrong_recipient() {
        let commitment = Sha256::new([3u8; 32]);
        let actual_to = hex_addr(0x99);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&actual_to, "0x1"));
        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            ForumVoteBurnVerification::WrongRecipient {
                expected: burn_address(),
                actual: Some(Address::from_hex(&actual_to).unwrap()),
            },
        );
        assert_eq!(transport.calls(), vec!["eth_getTransactionReceipt"]);
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_tx_failed() {
        let commitment = Sha256::new([5u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x0"));

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert_eq!(outcome, ForumVoteBurnVerification::TxFailed);
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_tx_not_confirmed() {
        let commitment = Sha256::new([6u8; 32]);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", Value::Null);

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert_eq!(outcome, ForumVoteBurnVerification::TxNotConfirmed);
    }

    #[tokio::test]
    async fn verify_forum_vote_burn_malformed_calldata() {
        let commitment = Sha256::new([8u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        // `POND`-tagged calldata (the existing plain-broadcast LOKAD ID), not `FRUM`-tagged forum
        // calldata: proves the two paths' calldata namespaces don't accidentally overlap.
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                10_000,
                "0x504f4e4401000000000000000000000000000000000000000000000000000000000000ff",
            ),
        );

        let outcome = verify_forum_vote_burn(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_burn(commitment),
        )
        .await
        .unwrap();

        assert!(matches!(
            outcome,
            ForumVoteBurnVerification::MalformedCalldata(ForumCalldataError::InvalidLokadId { .. })
        ));
    }

    #[test]
    fn signed_weight_up_is_positive_down_is_negative() {
        assert_eq!(VoteDirection::Up.signed_weight(1_000), 1_000);
        assert_eq!(VoteDirection::Down.signed_weight(1_000), -1_000);
    }
}
