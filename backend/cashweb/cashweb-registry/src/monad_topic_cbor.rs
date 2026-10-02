//! Frank-CBOR topic events for the Monad relay (ticket #136): decoding, commitment derivation, and
//! burn verification for a type-10 topic post submission and a type-11 topic vote submission
//! (`docs/protocol/cbor`, README section 6 "Topic events", T7, T8).
//!
//! The topic HTTP write routes use this module before mutating storage. During the bounded
//! protobuf coexistence window, the route stores a protobuf projection plus the exact type-9 frame
//! for posts; see `docs/protocol/cbor/topic-http-coexistence.md`. This module itself does not store
//! anything, and its validation and burn checks run before the route mutates storage:
//!
//! - [`parse_topic_event`] validates a frame with the `frank-cbor` codec (typed stage 9, a 1 MiB
//!   route limit, only types 9, 10, and 11 supported, no protobuf or JSON fallback, F5) and derives
//!   everything the relay must never take from the client: the post identity (the T1 hash of the
//!   embedded type-9 frame) and the T7 burn commitment.
//! - [`check_topic_burn_before_broadcast`] decodes the signed burn transaction and rejects, before
//!   anything is broadcast, one that pays the wrong address, on the wrong chain, with no value,
//!   or whose calldata does not carry exactly the derived commitment under the CBOR version byte.
//! - [`broadcast_and_verify_topic_event`] then broadcasts, confirms on chain with
//!   [`crate::monad_topic_verify::TopicCalldataVersion::Cbor`], and binds the result to the exact
//!   signed transaction: the hash the node returns must be the keccak256 of the bytes that were
//!   decoded and checked.
//!
//! The sender, the vote direction, and the weight are the verified transaction's; the frames carry
//! none of them (T8). Calldata of the protobuf path (version `0x01`) never verifies for a CBOR
//! event, and the reverse, so a burn made for one encoding cannot be replayed into the other.
//!
//! The network identifier is a parameter, not read from the environment. The relay's
//! `FRANK_NETWORK_TAG` values (`"MONT"`, `"MON1"`) are not valid Frank-CBOR network tags (S1
//! requires lowercase); [`crate::network_tag::cbor_network_identifier`] holds the one mapping
//! (`monad-testnet`, `monad-mainnet`), and startup refuses a tag it does not map.

use bitcoinsuite_core::{Hashed, Sha256};
use bitcoinsuite_error::Report;
use frank_cbor::{
    content_hash, topic_vote_commitment, validate_frame, Error, Operation, PriorStatement,
    SupportedSchema, TypedPayload, ValidationContext, ValidationResult,
};
use thiserror::Error;

use crate::{
    monad_evm_tx::{
        decode_signed_transaction, has_no_trailing_bytes, DecodedSignedTransaction, EvmTxError,
    },
    monad_http::{Address, Hash32, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_relay::{broadcast_and_verify_topic_burn, TopicVoteRelayOutcome},
    monad_topic_verify::{
        parse_topic_calldata_versioned, ExpectedTopicBurn, TopicCalldataError,
        TopicCalldataVersion, VoteDirection,
    },
};

/// The Frank-CBOR frame limit for a type-10 post submission (README R6), which is also the route
/// limit passed to the codec: a request larger than this is rejected before any decoding.
pub const MAX_TOPIC_EVENT_FRAME_BYTES: u64 = 1_048_576;

const TYPE_TOPIC_POST: u32 = 9;
const TYPE_TOPIC_POST_SUBMISSION: u32 = 10;
const TYPE_TOPIC_VOTE_SUBMISSION: u32 = 11;

/// A validated type-10 post submission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicPostEvent {
    /// Network identifier carried by the post and submission.
    pub network: String,
    /// The exact submitted type-10 frame.
    pub frame: Vec<u8>,
    /// The exact embedded type-9 frame: what a reader hashes and what must be stored verbatim.
    pub post_frame: Vec<u8>,
    /// The post identity: the T1 content hash of [`Self::post_frame`].
    pub post_hash: [u8; 32],
    /// The topic, exact UTF-8 (not normalized).
    pub topic: String,
    /// The parent post's T1 hash, for a reply.
    pub parent_hash: Option<[u8; 32]>,
    /// The opaque post body.
    pub body: Vec<u8>,
    /// The raw signed burn transaction.
    pub burn_tx: Vec<u8>,
    /// The T7 commitment the burn must carry, derived here from the frame.
    pub commitment: [u8; 32],
}

/// A validated type-11 vote submission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicVoteEvent {
    /// Network identifier carried by the vote submission.
    pub network: String,
    /// The exact submitted type-11 frame.
    pub frame: Vec<u8>,
    /// The T1 hash of the post voted on.
    pub target_hash: [u8; 32],
    /// The raw signed burn transaction.
    pub burn_tx: Vec<u8>,
    /// The T7 commitment the burn must carry, derived here from the frame.
    pub commitment: [u8; 32],
}

/// A validated topic event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopicEvent {
    /// A type-10 post submission.
    Post(TopicPostEvent),
    /// A type-11 vote submission.
    Vote(TopicVoteEvent),
}

impl TopicEvent {
    /// The raw signed burn transaction.
    pub fn burn_tx(&self) -> &[u8] {
        match self {
            TopicEvent::Post(post) => &post.burn_tx,
            TopicEvent::Vote(vote) => &vote.burn_tx,
        }
    }

    /// The T7 commitment the burn must carry.
    pub fn commitment(&self) -> &[u8; 32] {
        match self {
            TopicEvent::Post(post) => &post.commitment,
            TopicEvent::Vote(vote) => &vote.commitment,
        }
    }

    /// The post this event's burn pays for: the new post itself, or the post voted on.
    pub fn target_hash(&self) -> &[u8; 32] {
        match self {
            TopicEvent::Post(post) => &post.post_hash,
            TopicEvent::Vote(vote) => &vote.target_hash,
        }
    }
}

/// Why a frame is not an acceptable topic event.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TopicEventError {
    /// The codec rejected the frame. `category` and `stage` are the cross-language values of
    /// README sections 9 and 10.
    #[error("invalid Frank-CBOR frame: {category} at stage {stage}: {detail}")]
    Codec {
        /// Stable error category (`frame`, `resource`, `schema`, ...).
        category: String,
        /// Section 9 stage label.
        stage: String,
        /// Human-readable detail.
        detail: String,
    },
    /// The frame is valid but is not a type-10 or type-11 event (for example a bare type-9 post,
    /// which carries no burn).
    #[error("expected a type-10 or type-11 topic event, got type {0}")]
    UnexpectedRoot(u32),
    /// The frame's network is not the relay's.
    #[error("topic event is for network {actual:?}, this relay serves {expected:?}")]
    NetworkMismatch {
        /// The relay's Frank-CBOR network tag.
        expected: String,
        /// The frame's network tag.
        actual: String,
    },
    /// Stored authoritative frame does not have the identity used as its storage/target key.
    #[error("topic post frame identity does not match its target hash")]
    IdentityMismatch,
    /// The codec returned a projection this module did not expect. Not reachable for a frame it
    /// accepted; reported rather than panicking on hostile input.
    #[error("internal: {0}")]
    Internal(String),
}

fn topic_context() -> ValidationContext {
    ValidationContext {
        operation: Operation::Typed,
        route_byte_limit: MAX_TOPIC_EVENT_FRAME_BYTES,
        reader_version: 1,
        supported_schemas: [
            TYPE_TOPIC_POST,
            TYPE_TOPIC_POST_SUBMISSION,
            TYPE_TOPIC_VOTE_SUBMISSION,
        ]
        .into_iter()
        .map(|type_id| SupportedSchema {
            type_id,
            schema_version: 1,
        })
        .collect(),
        opaque_retention_allowed: false,
        prior: PriorStatement::None,
    }
}

fn internal(message: &str) -> TopicEventError {
    TopicEventError::Internal(message.to_string())
}

fn array32(bytes: &[u8], what: &str) -> Result<[u8; 32], TopicEventError> {
    bytes
        .try_into()
        .map_err(|_| internal(&format!("{what} is not 32 bytes")))
}

/// Validate `bytes` as a Frank-CBOR type-10 or type-11 topic event for `expected_network` and
/// derive its identity and burn commitment.
///
/// Nothing is stored, nothing is broadcast, and no other encoding is tried when the bytes are not
/// a frame (README F5). The codec's typed validation has already enforced every structural and
/// semantic rule, including that a type-10 frame's network equals its embedded post's (S11).
pub fn parse_topic_event(
    bytes: &[u8],
    expected_network: &str,
) -> Result<TopicEvent, TopicEventError> {
    let parsed = match validate_frame(bytes, &topic_context()) {
        Ok(ValidationResult::Parsed(parsed)) => parsed,
        Ok(_) => return Err(internal("typed validation did not return a parsed frame")),
        Err(Error::Codec(error)) => {
            return Err(TopicEventError::Codec {
                category: error.category.to_string(),
                stage: error.stage.to_string(),
                detail: error.detail,
            })
        }
        Err(Error::Context(error)) => return Err(internal(&error.to_string())),
    };
    let typed = parsed
        .typed
        .as_deref()
        .ok_or_else(|| internal("typed projection missing"))?;
    let check_network = |actual: &str| {
        if actual == expected_network {
            Ok(())
        } else {
            Err(TopicEventError::NetworkMismatch {
                expected: expected_network.to_string(),
                actual: actual.to_string(),
            })
        }
    };
    match typed {
        TypedPayload::TopicPostSubmission {
            network,
            post_frame,
            burn_tx,
            ..
        } => {
            check_network(network)?;
            let Some(TypedPayload::TopicPost {
                topic,
                parent_hash,
                body,
                ..
            }) = post_frame.typed.as_deref()
            else {
                return Err(internal("the embedded frame is not a type-9 post"));
            };
            let post_hash = content_hash(post_frame)
                .map_err(|error| internal(&format!("T1 of the post: {error}")))?;
            let commitment = topic_vote_commitment(network, &post_hash)
                .map_err(|error| internal(&format!("T7: {error}")))?;
            let parent_hash = parent_hash
                .as_deref()
                .map(|parent| array32(parent, "the parent hash"))
                .transpose()?;
            Ok(TopicEvent::Post(TopicPostEvent {
                network: network.clone(),
                frame: bytes.to_vec(),
                post_frame: post_frame.frame.clone(),
                post_hash,
                topic: topic.clone(),
                parent_hash,
                body: body.clone(),
                burn_tx: burn_tx.clone(),
                commitment,
            }))
        }
        TypedPayload::TopicVoteSubmission {
            network,
            target_hash,
            burn_tx,
            ..
        } => {
            check_network(network)?;
            let target_hash = array32(target_hash, "the target hash")?;
            let commitment = topic_vote_commitment(network, &target_hash)
                .map_err(|error| internal(&format!("T7: {error}")))?;
            Ok(TopicEvent::Vote(TopicVoteEvent {
                network: network.clone(),
                frame: bytes.to_vec(),
                target_hash,
                burn_tx: burn_tx.clone(),
                commitment,
            }))
        }
        _ => Err(TopicEventError::UnexpectedRoot(parsed.type_id)),
    }
}

/// Revalidate an authoritative stored type-9 frame before admitting a vote against it.
///
/// This prevents a type-11 event from attaching the CBOR T7 commitment semantics to a legacy
/// protobuf row that happens to share the same 32-byte key.
pub fn validate_topic_post_target(
    bytes: &[u8],
    expected_network: &str,
    expected_hash: &[u8; 32],
) -> Result<(), TopicEventError> {
    let parsed = match validate_frame(bytes, &topic_context()) {
        Ok(ValidationResult::Parsed(parsed)) => parsed,
        Ok(_) => return Err(internal("typed validation did not return a parsed frame")),
        Err(Error::Codec(error)) => {
            return Err(TopicEventError::Codec {
                category: error.category.to_string(),
                stage: error.stage.to_string(),
                detail: error.detail,
            })
        }
        Err(Error::Context(error)) => return Err(internal(&error.to_string())),
    };
    let Some(TypedPayload::TopicPost { network, .. }) = parsed.typed.as_deref() else {
        return Err(TopicEventError::UnexpectedRoot(parsed.type_id));
    };
    if network != expected_network {
        return Err(TopicEventError::NetworkMismatch {
            expected: expected_network.to_string(),
            actual: network.clone(),
        });
    }
    let actual = content_hash(&parsed)
        .map_err(|error| internal(&format!("T1 of the stored post: {error}")))?;
    if &actual != expected_hash {
        return Err(TopicEventError::IdentityMismatch);
    }
    Ok(())
}

/// What the relay requires of the burn transaction's on-chain shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopicBurnPolicy {
    /// The address the burn must be sent to (the configured topic burn address).
    pub burn_address: Address,
    /// The chain the relay verifies against. A transaction signed for another chain, or an
    /// unprotected legacy transaction with no chain identity, is rejected.
    pub expected_chain_id: u64,
}

/// Why a topic burn was rejected. Every variant except [`Self::Infrastructure`] means nothing was
/// stored and, unless it names a broadcast outcome, nothing was broadcast.
#[derive(Debug, Error)]
pub enum TopicBurnError {
    /// The raw transaction did not decode or its signature did not recover a sender.
    #[error("the burn transaction cannot be decoded: {0}")]
    Undecodable(EvmTxError),
    /// Bytes follow the RLP transaction. A node would hash them, so the transaction's hash would
    /// not be the one that was checked.
    #[error("the burn transaction has trailing bytes after its RLP encoding")]
    TrailingBytes,
    /// A type-10 post's own burn must be an up-vote (README T8).
    #[error("a post's own burn must be an up-vote (direction 01)")]
    PostBurnNotUp,
    /// The transaction was signed for another chain.
    #[error("the burn transaction is for chain {actual:?}, expected {expected}")]
    WrongChainId {
        /// The chain the relay verifies against.
        expected: u64,
        /// The chain the transaction commits to.
        actual: Option<u64>,
    },
    /// The transaction is not addressed to the burn address.
    #[error("the burn transaction pays {actual:?}, not the burn address")]
    WrongDestination {
        /// The signed destination (`None` for a contract creation).
        actual: Option<Address>,
    },
    /// The transaction burns nothing. A post is gated by its burn, and a vote's value is its
    /// weight, so a zero-value burn is neither.
    #[error("the burn transaction carries no value")]
    ZeroValue,
    /// The calldata is not a version-2 topic calldata blob.
    #[error("the burn calldata is not CBOR topic calldata: {0}")]
    Calldata(TopicCalldataError),
    /// The calldata commits to something other than this event.
    #[error("the burn calldata commits to another event")]
    WrongCommitment,
    /// The broadcast, confirmation, or on-chain verification did not succeed.
    #[error("the burn was not verified: {0:?}")]
    Rejected(TopicVoteRelayOutcome),
    /// The node returned a transaction hash that is not the hash of the signed bytes that were
    /// checked, so its confirmation would be for a different transaction.
    #[error("the node confirmed {returned} but the checked transaction hashes to {signed}")]
    TxHashMismatch {
        /// The hash of the signed bytes.
        signed: Hash32,
        /// The hash the node reported.
        returned: Hash32,
    },
    /// An RPC, transport, or post-confirmation consistency failure. The HTTP boundary reports
    /// this as outcome-unknown because broadcast may already have consumed the transaction.
    #[error("infrastructure failure: {0}")]
    Infrastructure(Report),
}

/// The pre-broadcast facts of a burn that passed [`check_topic_burn_before_broadcast`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedTopicBurn {
    /// The decoded signed transaction (sender, hash, value, calldata).
    pub decoded: DecodedSignedTransaction,
    /// The direction the calldata declares.
    pub direction: VoteDirection,
}

/// Decode the event's signed burn transaction and check everything that does not need the chain,
/// before anything is broadcast (T8): chain identity, destination, a nonzero value, and calldata
/// that carries exactly the event's T7 commitment under the CBOR version byte.
pub fn check_topic_burn_before_broadcast(
    event: &TopicEvent,
    policy: &TopicBurnPolicy,
) -> Result<CheckedTopicBurn, TopicBurnError> {
    if !has_no_trailing_bytes(event.burn_tx()) {
        // An empty or unsupported first byte falls through to the decoder's precise error.
        decode_signed_transaction(event.burn_tx()).map_err(TopicBurnError::Undecodable)?;
        return Err(TopicBurnError::TrailingBytes);
    }
    let decoded =
        decode_signed_transaction(event.burn_tx()).map_err(TopicBurnError::Undecodable)?;
    if decoded.chain_id != Some(policy.expected_chain_id) {
        return Err(TopicBurnError::WrongChainId {
            expected: policy.expected_chain_id,
            actual: decoded.chain_id,
        });
    }
    if decoded.destination != Some(policy.burn_address) {
        return Err(TopicBurnError::WrongDestination {
            actual: decoded.destination,
        });
    }
    if decoded.value_wei == 0 {
        return Err(TopicBurnError::ZeroValue);
    }
    let (direction, commitment) =
        parse_topic_calldata_versioned(&decoded.input, TopicCalldataVersion::Cbor)
            .map_err(TopicBurnError::Calldata)?;
    if commitment.as_slice() != event.commitment().as_slice() {
        return Err(TopicBurnError::WrongCommitment);
    }
    if matches!(event, TopicEvent::Post(_)) && direction != VoteDirection::Up {
        return Err(TopicBurnError::PostBurnNotUp);
    }
    Ok(CheckedTopicBurn { decoded, direction })
}

/// A burn that was checked, broadcast, confirmed, and verified on chain for one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedTopicBurn {
    /// The sender recovered from the transaction's own signature.
    pub sender: Address,
    /// The hash of the confirmed transaction: also the consumption key of the burn (T8).
    pub tx_hash: Hash32,
    /// The exact value burned, in wei: the vote's weight magnitude.
    pub value_wei: u128,
    /// The vote's direction.
    pub direction: VoteDirection,
    /// Confirmed block number.
    pub block_number: u64,
    /// Transaction position in the confirmed block.
    pub transaction_index: u64,
}

/// Check, broadcast, confirm, and verify the burn of `event`.
///
/// The transaction is decoded and checked first ([`check_topic_burn_before_broadcast`]), so a
/// transaction that cannot verify is never broadcast. The on-chain verification then requires the
/// receipt to succeed, the recipient to be the burn address, and the calldata to carry the T7
/// commitment under the CBOR version byte. Finally the confirmed hash must be the hash of the
/// signed bytes that were checked, and the on-chain value must equal the signed value.
pub async fn broadcast_and_verify_topic_event<T: JsonRpcTransport + Clone>(
    transport: &T,
    event: &TopicEvent,
    policy: &TopicBurnPolicy,
    poll: PollConfig,
) -> Result<VerifiedTopicBurn, TopicBurnError> {
    let checked = check_topic_burn_before_broadcast(event, policy)?;
    let expected = ExpectedTopicBurn {
        commitment: Sha256::new(*event.commitment()),
        burn_address: policy.burn_address,
    };
    let outcome = broadcast_and_verify_topic_burn(
        transport,
        event.burn_tx(),
        &expected,
        TopicCalldataVersion::Cbor,
        Some(checked.decoded.tx_hash),
        poll,
    )
    .await
    .map_err(TopicBurnError::Infrastructure)?;
    match outcome {
        TopicVoteRelayOutcome::Verified {
            tx_hash,
            value_wei,
            direction,
            block_number,
            transaction_index,
        } => {
            if tx_hash != checked.decoded.tx_hash {
                return Err(TopicBurnError::TxHashMismatch {
                    signed: checked.decoded.tx_hash,
                    returned: tx_hash,
                });
            }
            if value_wei != checked.decoded.value_wei || direction != checked.direction {
                return Err(TopicBurnError::Infrastructure(Report::msg(
                    "the chain's value or direction differs from the signed transaction",
                )));
            }
            Ok(VerifiedTopicBurn {
                sender: checked.decoded.sender,
                tx_hash,
                value_wei,
                direction,
                block_number,
                transaction_index,
            })
        }
        TopicVoteRelayOutcome::NodeHashMismatch { signed, returned } => {
            Err(TopicBurnError::TxHashMismatch { signed, returned })
        }
        other => Err(TopicBurnError::Rejected(other)),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use frank_cbor::{cbor_map, encode_frame, CborValue, EnvelopeFields, FramePayload};
    use prost::Message;
    use serde_json::Value;

    use super::*;
    use crate::{
        monad_evm_tx::test_support::{signed_eip1559_tx, signed_unprotected_legacy_tx},
        monad_http::MonadRpcError,
        monad_topic_verify::{TOPIC_COMMITMENT_VERSION_TAG, TOPIC_VOTE_LOKAD_ID},
        proto,
    };

    const NET: &str = "frank-test";
    const CHAIN_ID: u64 = 10_143;
    const BURN: Address = Address([0x44; 20]);

    fn policy() -> TopicBurnPolicy {
        TopicBurnPolicy {
            burn_address: BURN,
            expected_chain_id: CHAIN_ID,
        }
    }

    fn text(s: &str) -> CborValue {
        CborValue::Text(s.to_string())
    }

    fn bytes(b: &[u8]) -> CborValue {
        CborValue::Bytes(b.to_vec())
    }

    fn frame(type_id: u32, payload: &CborValue) -> Vec<u8> {
        encode_frame(
            EnvelopeFields {
                type_id,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(payload),
        )
        .unwrap()
    }

    fn post_frame(net: &str, topic: &str, parent: Option<[u8; 32]>) -> Vec<u8> {
        let mut fields = vec![
            (0, text(net)),
            (1, text(topic)),
            (3, bytes(b"hello, topic")),
        ];
        if let Some(parent) = parent {
            fields.push((2, bytes(&parent)));
        }
        frame(9, &cbor_map(fields))
    }

    fn submission_frame(net: &str, post: &[u8], burn_tx: &[u8]) -> Vec<u8> {
        frame(
            10,
            &cbor_map(vec![(0, text(net)), (1, bytes(post)), (2, bytes(burn_tx))]),
        )
    }

    fn vote_frame(net: &str, target: &[u8; 32], burn_tx: &[u8]) -> Vec<u8> {
        frame(
            11,
            &cbor_map(vec![
                (0, text(net)),
                (1, bytes(target)),
                (2, bytes(burn_tx)),
            ]),
        )
    }

    fn calldata(version: u8, direction: u8, commitment: &[u8]) -> Vec<u8> {
        let mut out = TOPIC_VOTE_LOKAD_ID.to_vec();
        out.push(version);
        out.push(direction);
        out.extend_from_slice(commitment);
        out
    }

    fn secret(byte: u8) -> bitcoinsuite_core::ecc::SecKey {
        EccSecp256k1::default()
            .seckey_from_array([byte; 32])
            .unwrap()
    }

    /// A signed burn for `commitment`, with every property overridable by the caller.
    fn burn(chain_id: u64, to: Address, value: u128, input: &[u8]) -> (Vec<u8>, Address) {
        signed_eip1559_tx(&secret(7), chain_id, 0, to, value, input)
    }

    fn cbor_burn(commitment: &[u8; 32], direction: u8) -> (Vec<u8>, Address) {
        burn(
            CHAIN_ID,
            BURN,
            25_000,
            &calldata(0x02, direction, commitment),
        )
    }

    /// The post a submission carries, and the T1 hash and T7 commitment of it, computed from the
    /// codec: the same values `topic-commitments.json` pins for the fixture frames.
    fn fixture_post_event(burn_tx: &[u8]) -> TopicPostEvent {
        let post = post_frame(NET, "frank.demo", None);
        match parse_topic_event(&submission_frame(NET, &post, burn_tx), NET).unwrap() {
            TopicEvent::Post(post) => post,
            other => panic!("{other:?}"),
        }
    }

    // ---- parse_topic_event ----------------------------------------------------------------

    #[test]
    fn a_post_submission_yields_the_post_identity_and_the_t7_commitment() {
        let event = fixture_post_event(&[1, 2, 3]);
        assert_eq!(event.topic, "frank.demo");
        assert_eq!(event.parent_hash, None);
        assert_eq!(event.body, b"hello, topic");
        assert_eq!(event.burn_tx, [1, 2, 3]);
        assert_eq!(event.post_frame, post_frame(NET, "frank.demo", None));
        assert_eq!(
            event.commitment,
            topic_vote_commitment(NET, &event.post_hash).unwrap()
        );
        // The identity depends on the exact frame: one changed byte is another post and another
        // commitment (T6, T7).
        let other = match parse_topic_event(
            &submission_frame(NET, &post_frame(NET, "frank.demp", None), &[1, 2, 3]),
            NET,
        )
        .unwrap()
        {
            TopicEvent::Post(post) => post,
            other => panic!("{other:?}"),
        };
        assert_ne!(other.post_hash, event.post_hash);
        assert_ne!(other.commitment, event.commitment);
    }

    #[test]
    fn a_reply_carries_its_parent() {
        let parent = [9u8; 32];
        let post = post_frame(NET, "frank.demo", Some(parent));
        match parse_topic_event(&submission_frame(NET, &post, &[1]), NET).unwrap() {
            TopicEvent::Post(post) => assert_eq!(post.parent_hash, Some(parent)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_vote_targets_a_post_hash_and_commits_to_it() {
        let target = [5u8; 32];
        match parse_topic_event(&vote_frame(NET, &target, &[1, 2]), NET).unwrap() {
            TopicEvent::Vote(vote) => {
                assert_eq!(vote.target_hash, target);
                assert_eq!(
                    vote.commitment,
                    topic_vote_commitment(NET, &target).unwrap()
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_posts_own_burn_and_a_later_vote_use_the_same_commitment_function() {
        let event = fixture_post_event(&[1]);
        let vote = parse_topic_event(&vote_frame(NET, &event.post_hash, &[2]), NET).unwrap();
        assert_eq!(vote.commitment(), &event.commitment);
        assert_eq!(vote.target_hash(), &event.post_hash);
    }

    #[test]
    fn a_bare_post_has_no_burn_and_is_not_an_event() {
        let error = parse_topic_event(&post_frame(NET, "t", None), NET).unwrap_err();
        assert_eq!(error, TopicEventError::UnexpectedRoot(9));
    }

    #[test]
    fn stored_vote_target_must_be_the_exact_canonical_post_on_the_same_network() {
        let post = post_frame(NET, "frank.demo", None);
        let event = parse_topic_event(&submission_frame(NET, &post, &[1]), NET).unwrap();
        let hash = event.target_hash();
        validate_topic_post_target(&post, NET, hash).unwrap();

        assert!(matches!(
            validate_topic_post_target(&post, "other-net", hash),
            Err(TopicEventError::NetworkMismatch { .. })
        ));
        let wrong_hash = [0x55; 32];
        assert_eq!(
            validate_topic_post_target(&post, NET, &wrong_hash),
            Err(TopicEventError::IdentityMismatch)
        );
        let mut noncanonical = post;
        noncanonical.push(0);
        assert!(validate_topic_post_target(&noncanonical, NET, hash).is_err());
    }

    #[test]
    fn another_network_is_rejected_even_when_the_frame_is_valid() {
        let post = post_frame("other-net", "t", None);
        let event = submission_frame("other-net", &post, &[1]);
        match parse_topic_event(&event, NET).unwrap_err() {
            TopicEventError::NetworkMismatch { expected, actual } => {
                assert_eq!((expected.as_str(), actual.as_str()), (NET, "other-net"));
            }
            other => panic!("{other:?}"),
        }
        let vote = vote_frame("other-net", &[1; 32], &[1]);
        assert!(matches!(
            parse_topic_event(&vote, NET),
            Err(TopicEventError::NetworkMismatch { .. })
        ));
    }

    #[test]
    fn a_submission_whose_network_differs_from_its_post_is_a_semantic_error() {
        let post = post_frame("other-net", "t", None);
        let error = parse_topic_event(&submission_frame(NET, &post, &[1]), NET).unwrap_err();
        assert!(
            matches!(&error, TopicEventError::Codec { category, stage, .. }
                if category == "semantic" && stage == "9"),
            "{error:?}"
        );
    }

    fn codec_error(bytes: &[u8]) -> (String, String) {
        match parse_topic_event(bytes, NET).unwrap_err() {
            TopicEventError::Codec {
                category, stage, ..
            } => (category, stage),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn protobuf_bytes_are_never_transcoded() {
        let legacy = proto::MonadTopicPost {
            topic: "frank.demo".to_string(),
            parent_post_hash: Vec::new(),
            raw_burn_tx: vec![1, 2, 3],
            encrypted_payload: vec![4, 5, 6],
            payload_hash: vec![7; 32],
        }
        .encode_to_vec();
        assert_eq!(codec_error(&legacy), ("frame".to_string(), "2".to_string()));
    }

    #[test]
    fn json_and_empty_bodies_are_frame_errors() {
        assert_eq!(codec_error(b"{}"), ("frame".to_string(), "2".to_string()));
        assert_eq!(codec_error(b""), ("frame".to_string(), "2".to_string()));
    }

    #[test]
    fn a_frame_over_the_route_limit_is_rejected_before_decoding() {
        let huge = vec![0u8; MAX_TOPIC_EVENT_FRAME_BYTES as usize + 1];
        assert_eq!(
            codec_error(&huge),
            ("resource".to_string(), "1".to_string())
        );
    }

    #[test]
    fn trailing_bytes_and_truncation_are_frame_errors() {
        let good = vote_frame(NET, &[1; 32], &[1]);
        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(codec_error(&trailing).0, "frame");
        assert_eq!(codec_error(&good[..good.len() - 1]).0, "frame");
    }

    #[test]
    fn a_direct_message_or_unknown_type_is_not_a_topic_event() {
        let dm = frame(1, &cbor_map(vec![(0, text(NET))]));
        assert_eq!(codec_error(&dm).0, "unsupported");
        let text_item = frame(17, &cbor_map(vec![(0, text("hi"))]));
        assert_eq!(codec_error(&text_item).0, "unsupported");
    }

    #[test]
    fn a_smuggled_direction_or_weight_field_is_rejected() {
        // The schemas carry no direction, value, or sender (T8); a field that claims one is a
        // schema error rather than an assertion the relay might trust.
        let with_direction = frame(
            11,
            &cbor_map(vec![
                (0, text(NET)),
                (1, bytes(&[1; 32])),
                (2, bytes(&[1])),
                (3, CborValue::Int(1)),
            ]),
        );
        assert_eq!(
            codec_error(&with_direction),
            ("schema".to_string(), "8.2".to_string())
        );
    }

    #[test]
    fn an_embedded_post_that_is_not_type_9_is_rejected() {
        let not_a_post = frame(17, &cbor_map(vec![(0, text("hi"))]));
        let event = submission_frame(NET, &not_a_post, &[1]);
        assert_eq!(
            codec_error(&event),
            ("semantic".to_string(), "8.4".to_string())
        );
    }

    /// Every topic vector of the shared manifest, run through the relay's own entry point, so the
    /// relay cannot drift from the codecs it is specified against.
    #[test]
    fn the_shared_vector_manifest_is_decided_the_same_way() {
        let manifest: Value = serde_json::from_str(include_str!(
            "../../../../docs/protocol/cbor/vectors/manifest.json"
        ))
        .unwrap();
        let mut rejects = 0;
        let mut accepts = 0;
        for case in manifest["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let supports_topics = case["validation_context"]["supported_schemas"]
                .as_array()
                .unwrap()
                .iter()
                .any(|schema| schema["type_id"] == 9);
            if !supports_topics
                || !id.contains("topic-")
                || case["validation_context"]["operation"] != "typed"
            {
                continue;
            }
            let frame = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
            let result = parse_topic_event(&frame, NET);
            match case["expectation"].as_str().unwrap() {
                "reject" => {
                    assert!(result.is_err(), "{id} must be rejected");
                    rejects += 1;
                }
                "accept" if case["type_id"] == 9 => {
                    assert_eq!(
                        result,
                        Err(TopicEventError::UnexpectedRoot(9)),
                        "{id}: a bare post carries no burn"
                    );
                }
                "accept" if case["type_id"] == 10 || case["type_id"] == 11 => {
                    result.unwrap_or_else(|error| panic!("{id}: {error}"));
                    accepts += 1;
                }
                _ => {}
            }
        }
        assert!(rejects >= 30, "only {rejects} topic rejects were checked");
        assert!(accepts >= 5, "only {accepts} topic accepts were checked");
    }

    /// The T7 values pinned in `topic-commitments.json`, which both codecs and the independent
    /// Python check also recompute: the relay derives the same commitment for the same frame.
    #[test]
    fn commitments_match_topic_commitments_json() {
        let doc: Value = serde_json::from_str(include_str!(
            "../../../../docs/protocol/cbor/vectors/topic-commitments.json"
        ))
        .unwrap();
        let mut checked = 0;
        for case in doc["cases"].as_array().unwrap() {
            let Some(want) = case["t7_hex"].as_str() else {
                continue;
            };
            let frame = hex::decode(case["frame_hex"].as_str().unwrap()).unwrap();
            let network = case["network"].as_str().unwrap();
            let event = parse_topic_event(&frame, network)
                .unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
            assert_eq!(hex::encode(event.commitment()), want, "{}", case["id"]);
            assert_eq!(
                hex::encode(event.target_hash()),
                case["target_hash_hex"].as_str().unwrap(),
                "{}",
                case["id"]
            );
            checked += 1;
        }
        assert_eq!(checked, 4);
    }

    // ---- check_topic_burn_before_broadcast ------------------------------------------------

    fn event_with_burn(make: impl Fn(&[u8; 32]) -> Vec<u8>) -> TopicEvent {
        // The commitment does not depend on the burn bytes, so derive it first.
        let commitment = fixture_post_event(&[1]).commitment;
        let post = post_frame(NET, "frank.demo", None);
        parse_topic_event(&submission_frame(NET, &post, &make(&commitment)), NET).unwrap()
    }

    fn check(make: impl Fn(&[u8; 32]) -> Vec<u8>) -> Result<CheckedTopicBurn, TopicBurnError> {
        check_topic_burn_before_broadcast(&event_with_burn(make), &policy())
    }

    #[test]
    fn a_burn_carrying_the_derived_commitment_passes() {
        let (raw, sender) = cbor_burn(&fixture_post_event(&[1]).commitment, 0x01);
        let event = event_with_burn(|_| raw.clone());
        let checked = check_topic_burn_before_broadcast(&event, &policy()).unwrap();
        assert_eq!(checked.decoded.sender, sender);
        assert_eq!(checked.decoded.value_wei, 25_000);
        assert_eq!(checked.direction, VoteDirection::Up);
        // A vote may go either way.
        let target = fixture_post_event(&[1]).post_hash;
        let vote_commitment = topic_vote_commitment(NET, &target).unwrap();
        let (down, _) = cbor_burn(&vote_commitment, 0x00);
        let down = parse_topic_event(&vote_frame(NET, &target, &down), NET).unwrap();
        assert_eq!(
            check_topic_burn_before_broadcast(&down, &policy())
                .unwrap()
                .direction,
            VoteDirection::Down
        );
    }

    #[test]
    fn a_posts_own_burn_must_be_an_up_vote() {
        let commitment = fixture_post_event(&[1]).commitment;
        let (down, _) = cbor_burn(&commitment, 0x00);
        let error =
            check_topic_burn_before_broadcast(&event_with_burn(|_| down.clone()), &policy())
                .unwrap_err();
        assert!(matches!(error, TopicBurnError::PostBurnNotUp), "{error:?}");
    }

    #[test]
    fn trailing_bytes_after_the_transaction_are_rejected_before_broadcast() {
        let commitment = fixture_post_event(&[1]).commitment;
        for make in [
            cbor_burn(&commitment, 1).0,
            // A legacy-encoded transaction too.
            signed_unprotected_legacy_tx(
                &secret(7),
                0,
                BURN,
                25_000,
                &calldata(0x02, 1, &commitment),
            ),
        ] {
            let mut padded = make.clone();
            padded.push(0x00);
            let error =
                check_topic_burn_before_broadcast(&event_with_burn(|_| padded.clone()), &policy())
                    .unwrap_err();
            // The unprotected legacy tx is refused for its chain identity first; the EIP-1559 one
            // is refused for its trailing byte.
            assert!(
                matches!(
                    error,
                    TopicBurnError::TrailingBytes
                        | TopicBurnError::Undecodable(_)
                        | TopicBurnError::WrongChainId { .. }
                ),
                "{error:?}"
            );
            assert!(has_no_trailing_bytes(&make));
            assert!(!has_no_trailing_bytes(&padded));
        }
        // Whatever follows, a transaction is never accepted with bytes after its RLP list. Some
        // suffixes make the item count wrong (`Undecodable`); a truncated item header does not,
        // and only the exact-length check catches it.
        for suffix in [&[1u8, 2, 3][..], &[0x00], &[0xb9], &[0xf8]] {
            let (eip, _) = cbor_burn(&commitment, 1);
            let mut padded = eip;
            padded.extend_from_slice(suffix);
            assert!(!has_no_trailing_bytes(&padded), "{suffix:?}");
            assert!(
                matches!(
                    check_topic_burn_before_broadcast(
                        &event_with_burn(|_| padded.clone()),
                        &policy()
                    ),
                    Err(TopicBurnError::TrailingBytes | TopicBurnError::Undecodable(_))
                ),
                "{suffix:?}"
            );
        }
    }

    #[test]
    fn extra_calldata_bytes_are_rejected() {
        let error = check(|commitment| {
            let mut input = calldata(0x02, 0x01, commitment);
            input.push(0xff);
            burn(CHAIN_ID, BURN, 1, &input).0
        })
        .unwrap_err();
        assert!(
            matches!(
                error,
                TopicBurnError::Calldata(TopicCalldataError::InvalidCommitmentLength { .. })
            ),
            "{error:?}"
        );
    }

    #[test]
    fn protobuf_version_calldata_never_verifies_for_a_cbor_event() {
        let error = check(|commitment| {
            burn(
                CHAIN_ID,
                BURN,
                25_000,
                &calldata(TOPIC_COMMITMENT_VERSION_TAG, 0x01, commitment),
            )
            .0
        })
        .unwrap_err();
        assert!(
            matches!(
                error,
                TopicBurnError::Calldata(TopicCalldataError::InvalidVersion { actual: 0x01 })
            ),
            "{error:?}"
        );
    }

    #[test]
    fn cbor_version_calldata_never_verifies_for_the_protobuf_path() {
        let commitment = [3u8; 32];
        assert!(matches!(
            crate::monad_topic_verify::parse_topic_vote_calldata(&calldata(
                0x02,
                0x01,
                &commitment
            )),
            Err(TopicCalldataError::InvalidVersion { actual: 0x02 })
        ));
    }

    #[test]
    fn a_commitment_for_another_post_network_or_target_is_rejected() {
        let event = fixture_post_event(&[1]);
        let other_post = topic_vote_commitment(
            NET,
            &match parse_topic_event(
                &submission_frame(NET, &post_frame(NET, "other", None), &[1]),
                NET,
            )
            .unwrap()
            {
                TopicEvent::Post(post) => post.post_hash,
                other => panic!("{other:?}"),
            },
        )
        .unwrap();
        let other_network = topic_vote_commitment("other-net", &event.post_hash).unwrap();
        // The legacy commitment: the protobuf payload hash is not the T7 commitment.
        let legacy = Sha256::digest(event.body.clone().into());
        for wrong in [
            other_post,
            other_network,
            <[u8; 32]>::try_from(legacy.as_slice()).unwrap(),
        ] {
            let error = check(|_| cbor_burn(&wrong, 0x01).0).unwrap_err();
            assert!(
                matches!(error, TopicBurnError::WrongCommitment),
                "{error:?}"
            );
        }
    }

    #[test]
    fn the_wrong_chain_destination_or_a_zero_value_is_rejected_before_broadcast() {
        let good = |commitment: &[u8; 32]| calldata(0x02, 0x01, commitment);
        let wrong_chain = check(|c| burn(1, BURN, 1, &good(c)).0).unwrap_err();
        assert!(matches!(
            wrong_chain,
            TopicBurnError::WrongChainId {
                expected: CHAIN_ID,
                actual: Some(1)
            }
        ));
        let wrong_to = check(|c| burn(CHAIN_ID, Address([0x45; 20]), 1, &good(c)).0).unwrap_err();
        assert!(matches!(wrong_to, TopicBurnError::WrongDestination { .. }));
        let zero = check(|c| burn(CHAIN_ID, BURN, 0, &good(c)).0).unwrap_err();
        assert!(matches!(zero, TopicBurnError::ZeroValue));
    }

    #[test]
    fn an_unprotected_legacy_transaction_has_no_chain_identity_and_is_rejected() {
        let error = check(|c| {
            signed_unprotected_legacy_tx(&secret(7), 0, BURN, 25_000, &calldata(0x02, 1, c))
        })
        .unwrap_err();
        assert!(
            matches!(error, TopicBurnError::WrongChainId { actual: None, .. }),
            "{error:?}"
        );
    }

    #[test]
    fn garbage_and_truncated_transactions_are_undecodable() {
        assert!(matches!(
            check(|_| vec![0xde, 0xad]).unwrap_err(),
            TopicBurnError::Undecodable(_)
        ));
        let (mut raw, _) = cbor_burn(&fixture_post_event(&[1]).commitment, 1);
        raw.truncate(raw.len() - 5);
        assert!(matches!(
            check(|_| raw.clone()).unwrap_err(),
            TopicBurnError::Undecodable(_)
        ));
    }

    #[test]
    fn malformed_calldata_is_rejected() {
        let error = check(|_| burn(CHAIN_ID, BURN, 1, b"TPIC").0).unwrap_err();
        assert!(matches!(error, TopicBurnError::Calldata(_)), "{error:?}");
        let error = check(|c| burn(CHAIN_ID, BURN, 1, &calldata(0x02, 0x07, c)).0).unwrap_err();
        assert!(matches!(
            error,
            TopicBurnError::Calldata(TopicCalldataError::InvalidDirection { actual: 7 })
        ));
    }

    // ---- broadcast_and_verify_topic_event -------------------------------------------------

    fn hex_hash(hash: &Hash32) -> String {
        format!("0x{}", hex::encode(hash.0))
    }

    #[derive(Clone, Default)]
    struct MockTransport {
        responses: Arc<Mutex<HashMap<String, Value>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
        }

        fn count(&self, method: &str) -> usize {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.as_str() == method)
                .count()
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
                    reason: "no mock response".to_string(),
                })
        }
    }

    fn fast_poll() -> PollConfig {
        PollConfig {
            interval: Duration::from_millis(1),
            max_attempts: 2,
        }
    }

    /// A transport whose chain agrees with `raw`: the node reports `node_hash`, and confirms a
    /// transaction paying `to` with `value` and `input`.
    fn chain(node_hash: &Hash32, to: &Address, value: u128, input: &[u8]) -> MockTransport {
        let transport = MockTransport::default();
        let to = format!("0x{}", hex::encode(to.0));
        transport.set("eth_sendRawTransaction", Value::String(hex_hash(node_hash)));
        transport.set(
            "eth_getTransactionReceipt",
            serde_json::json!({
                "transactionHash": hex_hash(node_hash),
                "blockHash": format!("0x{}", hex::encode([0x22u8; 32])),
                "blockNumber": "0x2a",
                "transactionIndex": "0x0",
                "from": format!("0x{}", hex::encode([0x33u8; 20])),
                "to": to,
                "contractAddress": null,
                "gasUsed": "0x5208",
                "status": "0x1",
                "logs": [],
            }),
        );
        transport.set(
            "eth_getTransactionByHash",
            serde_json::json!({
                "hash": hex_hash(node_hash),
                "to": to,
                "value": format!("0x{value:x}"),
                "input": format!("0x{}", hex::encode(input)),
                "from": format!("0x{}", hex::encode([0x33u8; 20])),
            }),
        );
        transport
    }

    fn signed_event(direction: u8) -> (TopicEvent, DecodedSignedTransaction) {
        let commitment = fixture_post_event(&[1]).commitment;
        let (raw, _) = cbor_burn(&commitment, direction);
        let decoded = decode_signed_transaction(&raw).unwrap();
        (event_with_burn(|_| raw.clone()), decoded)
    }

    fn signed_vote_event(direction: u8) -> (TopicEvent, DecodedSignedTransaction) {
        let target = fixture_post_event(&[1]).post_hash;
        let commitment = topic_vote_commitment(NET, &target).unwrap();
        let (raw, _) = cbor_burn(&commitment, direction);
        let decoded = decode_signed_transaction(&raw).unwrap();
        (
            parse_topic_event(&vote_frame(NET, &target, &raw), NET).unwrap(),
            decoded,
        )
    }

    #[tokio::test]
    async fn a_checked_burn_is_broadcast_confirmed_and_bound_to_the_signed_bytes() {
        let (event, decoded) = signed_vote_event(0x00);
        let transport = chain(&decoded.tx_hash, &BURN, 25_000, &decoded.input);
        let verified = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap();
        assert_eq!(verified.sender, decoded.sender);
        assert_eq!(verified.tx_hash, decoded.tx_hash);
        assert_eq!(verified.value_wei, 25_000);
        assert_eq!(verified.direction, VoteDirection::Down);
        assert_eq!(transport.count("eth_sendRawTransaction"), 1);
    }

    #[tokio::test]
    async fn a_node_that_confirms_a_different_transaction_is_rejected() {
        let (event, decoded) = signed_event(0x01);
        let other = Hash32([0x99; 32]);
        let transport = chain(&other, &BURN, 25_000, &decoded.input);
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        match error {
            TopicBurnError::TxHashMismatch { signed, returned } => {
                assert_eq!(signed, decoded.tx_hash);
                assert_eq!(returned, other);
            }
            other => panic!("{other:?}"),
        }
        // Reported before any polling: nothing about the wrong transaction is ever fetched.
        assert_eq!(transport.count("eth_getTransactionReceipt"), 0);
    }

    #[tokio::test]
    async fn a_reverted_burn_is_a_rejection_in_the_cbor_path() {
        let (event, decoded) = signed_event(0x01);
        let transport = chain(&decoded.tx_hash, &BURN, 25_000, &decoded.input);
        let mut receipt = transport.responses.lock().unwrap()["eth_getTransactionReceipt"].clone();
        receipt["status"] = Value::String("0x0".to_string());
        transport.set("eth_getTransactionReceipt", receipt);
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        assert!(
            matches!(
                error,
                TopicBurnError::Rejected(TopicVoteRelayOutcome::VerificationFailed {
                    outcome: crate::monad_topic_verify::TopicVoteBurnVerification::TxFailed,
                    ..
                })
            ),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn nothing_is_broadcast_when_the_pre_check_fails() {
        let commitment = fixture_post_event(&[1]).commitment;
        let (raw, _) = burn(CHAIN_ID, BURN, 0, &calldata(0x02, 1, &commitment));
        let event = event_with_burn(|_| raw.clone());
        let transport = MockTransport::default();
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        assert!(matches!(error, TopicBurnError::ZeroValue));
        assert_eq!(transport.count("eth_sendRawTransaction"), 0);
    }

    #[tokio::test]
    async fn on_chain_calldata_of_the_protobuf_version_does_not_verify() {
        let (event, decoded) = signed_event(0x01);
        let commitment = fixture_post_event(&[1]).commitment;
        let legacy = calldata(TOPIC_COMMITMENT_VERSION_TAG, 0x01, &commitment);
        let transport = chain(&decoded.tx_hash, &BURN, 25_000, &legacy);
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        assert!(matches!(error, TopicBurnError::Rejected(_)), "{error:?}");
    }

    #[tokio::test]
    async fn an_on_chain_value_that_differs_from_the_signed_value_is_not_trusted() {
        let (event, decoded) = signed_event(0x01);
        let transport = chain(&decoded.tx_hash, &BURN, 1, &decoded.input);
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        assert!(
            matches!(error, TopicBurnError::Infrastructure(_)),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_reverted_or_unconfirmed_burn_is_a_rejection() {
        let (event, decoded) = signed_event(0x01);
        let transport = chain(&decoded.tx_hash, &BURN, 25_000, &decoded.input);
        transport.set("eth_getTransactionReceipt", Value::Null);
        let error = broadcast_and_verify_topic_event(&transport, &event, &policy(), fast_poll())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            TopicBurnError::Rejected(TopicVoteRelayOutcome::ConfirmationTimedOut { .. })
        ));
    }
}
