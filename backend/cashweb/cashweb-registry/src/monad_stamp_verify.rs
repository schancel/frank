//! Server-side verification of a Stamp transaction on Monad (ticket #16).
//!
//! This is the Monad counterpart to [`cashweb_payload::verify`]'s Lotus commitment-verification
//! logic (`SignedPayload::verify` + `parse_commitment`): given a stamp transaction hash and an
//! expected commitment hash `h_m` (computed the same way as Lotus's `calc_commitment`: SHA256 of
//! `SHA256(pubkey) || payload_hash`), it confirms on-chain that:
//!
//! 1. The tx is confirmed and succeeded (`eth_getTransactionReceipt` status).
//! 2. It was sent to the expected destination (a DM payment child or a topic burn address).
//! 3. Its value meets the required minimum.
//! 4. Its calldata carries a well-formed `<lokad_id><version><commitment>` blob whose commitment
//!    matches `h_m`.
//!
//! ## Scope (ticket #16)
//!
//! This module only implements the verification primitive itself: given a tx hash and the
//! expected commitment/recipient/value, it tells the caller whether the stamp checks out, and if
//! not, why. It is **not** wired into any HTTP handler or message-ingestion path (that's ticket
//! #19), and it doesn't broadcast or construct the transaction (that's ticket #13). It also
//! doesn't implement `cashweb_payload::chain_adapter::ChainAdapter` (ticket #25).
//!
//! ## A note on `calc_commitment` and `parse_commitment`
//!
//! `cashweb_payload::verify::calc_commitment` (the shared preimage math) and
//! `cashweb_payload::verify::parse_commitment` (the Lotus OP_RETURN decoder) are both private to
//! the `verify` module, and this ticket's ownership rules forbid editing `verify.rs` (e.g. to mark
//! `calc_commitment` `pub(crate)`) to expose them to a sibling crate. [`calc_expected_commitment`]
//! below therefore duplicates `calc_commitment`'s preimage math byte-for-byte rather than calling
//! it. **If that math ever changes, this copy must be updated to match by hand** -- ideally a
//! follow-up ticket makes `calc_commitment` `pub` in `cashweb-payload` so this duplication can be
//! removed. [`parse_commitment_calldata`] is the intentional *new* half (calldata instead of a
//! Bitcoin Script), so it isn't a duplicate of anything, just a mirror of `parse_commitment`'s
//! checks adapted to a flat byte layout.
//!
//! ## A note on `MonadHttpClient` and `eth_getTransactionByHash` (resolved by ticket #25)
//!
//! [`crate::monad_http::MonadHttpClient`] (ticket #12) originally only implemented
//! `eth_getTransactionReceipt`, `eth_getLogs`, `eth_blockNumber`, and `eth_sendRawTransaction`.
//! Its [`crate::monad_http::TransactionReceipt`] has no `to`/`value`/`input` fields (a real Monad
//! receipt doesn't carry them -- those live on the transaction itself), so verifying the stamp's
//! value and decoding its commitment out of the calldata needs the full transaction. This module
//! used to make its own minimal `eth_getTransactionByHash` call (via the same public
//! [`crate::monad_http::JsonRpcTransport`] trait `MonadHttpClient` is built on) to work around the
//! gap, since editing `monad_http.rs` was out of scope for ticket #16. Ticket #25 (assembling
//! `MonadAdapter`) added a real
//! [`crate::monad_http::MonadHttpClient::get_transaction_by_hash`] method; this module now calls
//! that instead of duplicating the RPC call.

use bitcoinsuite_core::{ecc::PUBKEY_LENGTH, BytesMut, Hashed, Sha256};
use bitcoinsuite_error::{bail, Result, WrapErr};
use thiserror::Error;

use crate::monad_http::{Address, Hash32, JsonRpcTransport, MonadHttpClient};

/// Fixed length, in bytes, of the `<lokad_id><version>` prefix before the commitment in a stamp
/// tx's calldata.
const CALLDATA_PREFIX_LEN: usize = 5;
/// Required length, in bytes, of the commitment itself.
const CALLDATA_COMMITMENT_LEN: usize = 32;

/// Version tag for the `<lokad_id><version><commitment>` calldata layout this module decodes.
///
/// Analogous to [`cashweb_payload::verify::COMMITMENT_VERSION_OPCODE`], but a plain byte rather
/// than a Bitcoin Script opcode: EVM calldata has no opcode concept, so there's no need to encode
/// this as `OP_1` the way the Lotus OP_RETURN script does.
pub const COMMITMENT_VERSION_TAG: u8 = 0x01;

/// Recompute the same commitment preimage math as (private, un-reachable from here)
/// `cashweb_payload::verify::calc_commitment`: `SHA256(SHA256(pubkey) || payload_hash)`.
///
/// See the module docs for why this duplicates rather than calls the original.
pub fn calc_expected_commitment(pubkey_raw: [u8; PUBKEY_LENGTH], payload_hash: &Sha256) -> Sha256 {
    let pubkey_hash = Sha256::digest(pubkey_raw.into());
    let mut commitment_preimage = BytesMut::new();
    commitment_preimage.put_byte_array(pubkey_hash.byte_array().clone());
    commitment_preimage.put_byte_array(payload_hash.byte_array().clone());
    Sha256::digest(commitment_preimage.freeze())
}

/// Errors decoding a Stamp commitment out of a Monad transaction's calldata (`input` field).
///
/// Mirrors the corresponding checks in `cashweb_payload::verify::parse_commitment` (the Lotus
/// OP_RETURN decoder), adapted to a flat calldata layout: `<lokad_id: 4 bytes><version: 1
/// byte><commitment: 32 bytes>`, with no Bitcoin Script op-count/push-length concepts involved.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CalldataCommitmentError {
    /// Calldata is too short to even contain the fixed `<lokad_id><version>` prefix.
    ///
    /// Mirrors `ValidateSignedPayloadError::BurnOutputTooFewOps` /
    /// `ParsingBurnOutputScriptFailed`.
    #[error("Stamp tx calldata too short: expected at least {expected} bytes, got {actual}")]
    CalldataTooShort {
        /// Minimum required length (`CALLDATA_PREFIX_LEN`).
        expected: usize,
        /// Actual calldata length.
        actual: usize,
    },

    /// The first 4 bytes don't match the expected LOKAD ID.
    ///
    /// Mirrors `ValidateSignedPayloadError::BurnOutputInvalidLokadId`.
    #[error("Stamp tx calldata expected LOKAD ID {expected} but got {actual}")]
    InvalidLokadId {
        /// Expected 4-byte LOKAD ID, hex-encoded.
        expected: String,
        /// Actual 4 bytes found, hex-encoded.
        actual: String,
    },

    /// Byte 4 doesn't match [`COMMITMENT_VERSION_TAG`].
    ///
    /// Mirrors `ValidateSignedPayloadError::BurnOutputInvalidVersion`.
    #[error(
        "Stamp tx calldata expected version tag {:#04x} but got {actual:#04x}",
        COMMITMENT_VERSION_TAG
    )]
    InvalidVersion {
        /// Actual version byte found.
        actual: u8,
    },

    /// The calldata remaining after the `<lokad_id><version>` prefix isn't exactly
    /// [`CALLDATA_COMMITMENT_LEN`] bytes (too short, or trailing garbage).
    ///
    /// Mirrors `ValidateSignedPayloadError::BurnOutputInvalidCommitmentLength`.
    #[error("Stamp tx calldata expected a {expected}-byte commitment but got {actual} bytes")]
    InvalidCommitmentLength {
        /// Expected commitment length ([`CALLDATA_COMMITMENT_LEN`]).
        expected: usize,
        /// Actual number of remaining bytes.
        actual: usize,
    },
}

/// Decode and validate a Stamp commitment out of a Monad tx's calldata.
///
/// Calldata must look like this: `<lokad_id: commitment_id><version:
/// COMMITMENT_VERSION_TAG><commitment: 32 bytes>`. This is the chain-agnostic "decode a
/// stamp transaction" step for Monad -- it operates purely on the already-fetched calldata
/// bytes and doesn't require any chain RPC calls, mirroring how
/// `cashweb_payload::verify::parse_commitment` operates purely on an already-parsed Script.
pub fn parse_commitment_calldata(
    commitment_id: [u8; 4],
    calldata: &[u8],
) -> std::result::Result<Sha256, CalldataCommitmentError> {
    if calldata.len() < CALLDATA_PREFIX_LEN {
        return Err(CalldataCommitmentError::CalldataTooShort {
            expected: CALLDATA_PREFIX_LEN,
            actual: calldata.len(),
        });
    }

    let lokad_id = &calldata[0..4];
    if lokad_id != commitment_id {
        return Err(CalldataCommitmentError::InvalidLokadId {
            expected: hex::encode(commitment_id),
            actual: hex::encode(lokad_id),
        });
    }

    let version = calldata[4];
    if version != COMMITMENT_VERSION_TAG {
        return Err(CalldataCommitmentError::InvalidVersion { actual: version });
    }

    let commitment_bytes = &calldata[CALLDATA_PREFIX_LEN..];
    if commitment_bytes.len() != CALLDATA_COMMITMENT_LEN {
        return Err(CalldataCommitmentError::InvalidCommitmentLength {
            expected: CALLDATA_COMMITMENT_LEN,
            actual: commitment_bytes.len(),
        });
    }

    Ok(Sha256::new(commitment_bytes.try_into().unwrap()))
}

/// What's required of a stamp tx for it to count as a valid Stamp.
///
/// Ticket #57's terminology fix: `destination_address` is deliberately not called
/// `burn_address` -- this struct is shared by both the broadcast path (`monad_topics.rs`, where
/// the value genuinely is burned to a fixed dead address) and the direct-message path
/// (`monad_message.rs`, where it's a real payment to the message's own recipient, never burned).
/// Calling a real payment a "burn" is exactly the conflation that caused #57's bug in the first
/// place -- this struct's field names stay accurate for both callers instead of assuming burn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedStampTransaction {
    /// LOKAD ID the calldata's commitment must be tagged with (e.g.
    /// `cashweb_payload::verify::ADDRESS_METADATA_LOKAD_ID` or `BROADCAST_MESSAGE_LOKAD_ID`).
    pub commitment_id: [u8; 4],
    /// Expected commitment hash `h_m` (from [`calc_expected_commitment`], or equivalently
    /// `cashweb_payload::verify`'s private `calc_commitment`, given the message's pubkey and
    /// payload hash).
    pub commitment: Sha256,
    /// Address the stamp tx's value must be sent to -- a burn address for a broadcast, or a
    /// one-time child destination controlled by the recipient for a direct message.
    pub destination_address: Address,
    /// Minimum value (in wei) the stamp tx must carry.
    pub min_value_wei: u128,
}

/// Outcome of verifying a Monad stamp transaction against an [`ExpectedStampTransaction`]. The
/// neutral name is deliberate: topic stamps burn, while direct-message stamps pay one-time child
/// destinations controlled by the recipient.
///
/// Distinguishes every way the check can fail (mirroring the granularity of
/// `cashweb_payload::verify::ValidateSignedPayloadError` for the Lotus path), rather than
/// collapsing them into a single error, so callers can react differently (e.g. treat
/// `TxNotConfirmed` as "try again later" but `WrongCommitment` as "reject immediately").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampTransactionVerification {
    /// The stamp transaction confirmed successfully, was sent to the expected address, carries at least
    /// the required value, and its calldata commitment matches the expected commitment.
    Verified {
        /// Exact value carried by this independently verified transaction. Direct-message stamp
        /// sets sum these values before applying the message-wide minimum.
        value_wei: u128,
    },
    /// The node has no receipt for this tx hash (unmined, or unknown to the node).
    TxNotConfirmed,
    /// The tx was mined but reverted (`status` = 0).
    TxFailed,
    /// The tx wasn't sent to the expected destination address.
    WrongRecipient {
        /// The address the tx was expected to be sent to (see [`ExpectedStampTransaction::destination_address`]).
        expected: Address,
        /// The tx's actual recipient (`None` for a contract-creation tx).
        actual: Option<Address>,
    },
    /// The tx's value was less than the required minimum.
    InsufficientValue {
        /// Minimum required value, in wei.
        required: u128,
        /// Actual value carried by the tx, in wei.
        actual: u128,
    },
    /// The tx's calldata didn't parse as a well-formed `<lokad_id><version><commitment>` blob.
    MalformedCalldata(CalldataCommitmentError),
    /// The tx's calldata commitment didn't match the expected commitment.
    WrongCommitment {
        /// Expected commitment hash `h_m`.
        expected: Sha256,
        /// Actual commitment decoded from the tx's calldata.
        actual: Sha256,
    },
}

/// Verify that `tx_hash` is a valid Stamp transaction against `expected`.
///
/// Fetches the tx's receipt via [`MonadHttpClient::get_transaction_receipt`] and, if confirmed
/// and successful, the full transaction via [`MonadHttpClient::get_transaction_by_hash`] to check
/// its recipient, value, and calldata commitment.
///
/// Returns `Err` only for infrastructure failures (RPC/transport errors, or a node returning an
/// internally-inconsistent response); every *verification* failure (wrong commitment, wrong
/// recipient, insufficient value, tx not confirmed/failed, malformed calldata) is a distinct `Ok`
/// variant of [`StampTransactionVerification`], never an `Err`.
pub async fn verify_stamp_transaction<T>(
    transport: &T,
    tx_hash: Hash32,
    expected: &ExpectedStampTransaction,
) -> Result<StampTransactionVerification>
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
        None => return Ok(StampTransactionVerification::TxNotConfirmed),
    };

    if receipt.succeeded() != Some(true) {
        return Ok(StampTransactionVerification::TxFailed);
    }

    if receipt.to != Some(expected.destination_address) {
        return Ok(StampTransactionVerification::WrongRecipient {
            expected: expected.destination_address,
            actual: receipt.to,
        });
    }

    let tx = client
        .get_transaction_by_hash(tx_hash)
        .await
        .wrap_err_with(|| format!("fetching Monad tx {tx_hash}"))?;
    let tx = match tx {
        Some(tx) => tx,
        // A node that just returned a receipt for this hash but then has no transaction record
        // for it is internally inconsistent -- not a normal verification failure, so this
        // propagates as an infrastructure error rather than a `StampTransactionVerification` variant.
        None => bail!(
            "Monad tx {tx_hash} has a receipt but eth_getTransactionByHash returned nothing \
             (node inconsistency)"
        ),
    };

    if tx.value < expected.min_value_wei {
        return Ok(StampTransactionVerification::InsufficientValue {
            required: expected.min_value_wei,
            actual: tx.value,
        });
    }

    let commitment = match parse_commitment_calldata(expected.commitment_id, &tx.input) {
        Ok(commitment) => commitment,
        Err(err) => return Ok(StampTransactionVerification::MalformedCalldata(err)),
    };

    if commitment != expected.commitment {
        return Ok(StampTransactionVerification::WrongCommitment {
            expected: expected.commitment.clone(),
            actual: commitment,
        });
    }

    Ok(StampTransactionVerification::Verified {
        value_wei: tx.value,
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fmt, sync::Mutex};

    use async_trait::async_trait;
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use serde_json::Value;

    use crate::monad_http::MonadRpcError;

    use super::*;

    const STMP: [u8; 4] = *b"STMP";

    fn commitment_calldata(lokad_id: [u8; 4], version: u8, commitment: &[u8]) -> Vec<u8> {
        let mut calldata = Vec::new();
        calldata.extend_from_slice(&lokad_id);
        calldata.push(version);
        calldata.extend_from_slice(commitment);
        calldata
    }

    #[test]
    fn parse_commitment_calldata_valid() {
        let commitment = [7u8; 32];
        let calldata = commitment_calldata(STMP, COMMITMENT_VERSION_TAG, &commitment);
        assert_eq!(
            parse_commitment_calldata(STMP, &calldata),
            Ok(Sha256::new(commitment)),
        );
    }

    #[test]
    fn parse_commitment_calldata_too_short() {
        assert_eq!(
            parse_commitment_calldata(STMP, &[0x53, 0x54, 0x4d]),
            Err(CalldataCommitmentError::CalldataTooShort {
                expected: 5,
                actual: 3,
            }),
        );
    }

    #[test]
    fn parse_commitment_calldata_wrong_lokad_id() {
        let calldata = commitment_calldata(*b"POND", COMMITMENT_VERSION_TAG, &[1u8; 32]);
        assert_eq!(
            parse_commitment_calldata(STMP, &calldata),
            Err(CalldataCommitmentError::InvalidLokadId {
                expected: hex::encode(STMP),
                actual: hex::encode(b"POND"),
            }),
        );
    }

    #[test]
    fn parse_commitment_calldata_wrong_version() {
        let calldata = commitment_calldata(STMP, 0x99, &[1u8; 32]);
        assert_eq!(
            parse_commitment_calldata(STMP, &calldata),
            Err(CalldataCommitmentError::InvalidVersion { actual: 0x99 }),
        );
    }

    #[test]
    fn parse_commitment_calldata_wrong_commitment_length() {
        let calldata = commitment_calldata(STMP, COMMITMENT_VERSION_TAG, &[1u8; 10]);
        assert_eq!(
            parse_commitment_calldata(STMP, &calldata),
            Err(CalldataCommitmentError::InvalidCommitmentLength {
                expected: 32,
                actual: 10,
            }),
        );
    }

    #[test]
    fn calc_expected_commitment_matches_lotus_preimage() {
        // Same computation as `cashweb_payload::verify`'s test
        // (`test_verify_signed_payload`), reproduced by hand since `calc_commitment` is private
        // to that module: SHA256(SHA256(pubkey) || payload_hash).
        let pubkey = [0x77; PUBKEY_LENGTH];
        let payload_hash = Sha256::digest(vec![1, 2, 3, 4].into());
        let expected = Sha256::digest(
            [
                Sha256::digest(pubkey.as_slice().into()).as_slice(),
                payload_hash.as_slice(),
            ]
            .concat()
            .into(),
        );
        assert_eq!(calc_expected_commitment(pubkey, &payload_hash), expected);
    }

    /// Mock [`JsonRpcTransport`] that returns a canned response per JSON-RPC method, so
    /// [`verify_stamp_transaction`]'s multi-call flow (receipt, then full tx) can be exercised without a
    /// network call. Shares state across `Clone`s (via `Arc`) so the clone `verify_stamp_transaction`
    /// makes internally for `MonadHttpClient::with_transport` sees the same configured
    /// responses/call log as the original.
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

    fn hex_addr(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 20]))
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
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

    fn destination_address() -> Address {
        Address::from_hex(&hex_addr(0x44)).unwrap()
    }

    fn expected_stamp_transaction(
        commitment: Sha256,
        min_value_wei: u128,
    ) -> ExpectedStampTransaction {
        ExpectedStampTransaction {
            commitment_id: ADDRESS_METADATA_LOKAD_ID_FOR_TESTS,
            commitment,
            destination_address: destination_address(),
            min_value_wei,
        }
    }

    // Redeclared locally (rather than importing `cashweb_payload::verify::ADDRESS_METADATA_LOKAD_ID`)
    // just to keep this test module's dependency footprint minimal; value is identical (`*b"STMP"`).
    const ADDRESS_METADATA_LOKAD_ID_FOR_TESTS: [u8; 4] = *b"STMP";

    fn valid_calldata(commitment: &Sha256) -> String {
        format!(
            "0x{}",
            hex::encode(commitment_calldata(
                ADDRESS_METADATA_LOKAD_ID_FOR_TESTS,
                COMMITMENT_VERSION_TAG,
                commitment.as_slice(),
            ))
        )
    }

    #[tokio::test]
    async fn verify_stamp_transaction_valid() {
        let ecc = EccSecp256k1::default();
        let seckey = ecc.seckey_from_array([0x44; 32]).unwrap();
        let pubkey = ecc.derive_pubkey(&seckey).array();
        let payload_hash = Sha256::digest(vec![9, 9, 9].into());
        let commitment = calc_expected_commitment(pubkey, &payload_hash);

        let to = hex_addr(0x44);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &valid_calldata(&commitment)),
        );

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            StampTransactionVerification::Verified { value_wei: 10_000 }
        );
        assert_eq!(
            transport.calls(),
            vec!["eth_getTransactionReceipt", "eth_getTransactionByHash"],
        );
    }

    #[tokio::test]
    async fn verify_stamp_transaction_commitment_mismatch() {
        let expected_commitment = Sha256::new([1u8; 32]);
        let actual_commitment = Sha256::new([2u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 10_000, &valid_calldata(&actual_commitment)),
        );

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(expected_commitment.clone(), 10_000),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            StampTransactionVerification::WrongCommitment {
                expected: expected_commitment,
                actual: actual_commitment,
            },
        );
    }

    #[tokio::test]
    async fn verify_stamp_transaction_wrong_recipient() {
        let commitment = Sha256::new([3u8; 32]);
        let actual_to = hex_addr(0x99);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&actual_to, "0x1"));
        // No `eth_getTransactionByHash` response configured: verification must short-circuit on
        // the recipient mismatch (from the receipt alone) before ever calling it.
        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            StampTransactionVerification::WrongRecipient {
                expected: destination_address(),
                actual: Some(Address::from_hex(&actual_to).unwrap()),
            },
        );
        assert_eq!(transport.calls(), vec!["eth_getTransactionReceipt"]);
    }

    #[tokio::test]
    async fn verify_stamp_transaction_insufficient_value() {
        let commitment = Sha256::new([4u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        transport.set(
            "eth_getTransactionByHash",
            tx_json(&to, 500, &valid_calldata(&commitment)),
        );

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            StampTransactionVerification::InsufficientValue {
                required: 10_000,
                actual: 500,
            },
        );
    }

    #[tokio::test]
    async fn verify_stamp_transaction_tx_failed() {
        let commitment = Sha256::new([5u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x0"));

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert_eq!(outcome, StampTransactionVerification::TxFailed);
        assert_eq!(transport.calls(), vec!["eth_getTransactionReceipt"]);
    }

    #[tokio::test]
    async fn verify_stamp_transaction_tx_not_confirmed() {
        let commitment = Sha256::new([6u8; 32]);
        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", Value::Null);

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert_eq!(outcome, StampTransactionVerification::TxNotConfirmed);
    }

    #[tokio::test]
    async fn verify_stamp_transaction_malformed_calldata() {
        let commitment = Sha256::new([8u8; 32]);
        let to = hex_addr(0x44);

        let transport = MockTransport::default();
        transport.set("eth_getTransactionReceipt", receipt_json(&to, "0x1"));
        // Real-world-shaped calldata (a 4-byte function selector + a 32-byte word), not a
        // `<lokad_id><version><commitment>` blob: `POND` (0x504f4e44) doesn't match `STMP`.
        transport.set(
            "eth_getTransactionByHash",
            tx_json(
                &to,
                10_000,
                "0x504f4e44000000000000000000000000000000000000000000000000000000000000ff",
            ),
        );

        let outcome = verify_stamp_transaction(
            &transport,
            Hash32::from_hex(&hex_hash(0x11)).unwrap(),
            &expected_stamp_transaction(commitment, 10_000),
        )
        .await
        .unwrap();

        assert!(matches!(
            outcome,
            StampTransactionVerification::MalformedCalldata(
                CalldataCommitmentError::InvalidLokadId { .. }
            )
        ));
    }
}
