//! The forum owner over one shared transaction store: what a client sees through any replica.
use super::*;
use crate::store::forum::tests::{
    distinct_post, facts, observation, optional_observation, proof_reservations, publish, Backend,
    NETWORK,
};
use crate::store::forum::Magnitude;
use crate::store::kv_store::Transact;
use frank_cbor::{TypedPayload, ValidationResult};
use std::sync::Arc;
use std::time::Duration;

fn test_policy() -> TopicBurnPolicy {
    policy(10143, Address([0x44; 20]))
}

fn replica(backend: &Backend) -> Owner {
    Owner::shared(backend.kv.clone(), backend.objects.clone())
}

fn parsed(frame: &[u8]) -> frank_cbor::ParsedFrame {
    let ValidationResult::Parsed(parsed) =
        frank_cbor::validate_frame(frame, &frank_cbor::default_context()).unwrap()
    else {
        panic!()
    };
    parsed
}

fn topic_query() -> Query {
    Query::Topic {
        topic: "test.topic".into(),
        since: Timestamp {
            seconds: 0,
            nanoseconds: 0,
        },
    }
}

/// The rows of a page and its next cursor.
fn rows_of(frame: &[u8]) -> (Vec<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>) {
    match parsed(frame).typed.as_deref().unwrap() {
        TypedPayload::ForumTopicPage(page) => (
            page.rows.iter().map(|r| r.frame.clone()).collect(),
            page.next_cursor.as_ref().map(|c| c.bytes.clone()),
            page.request_cursor.as_ref().map(|c| c.bytes.clone()),
        ),
        TypedPayload::ForumDiscoveryPage(page) => (
            page.entries
                .iter()
                .map(|e| e.topic.as_bytes().to_vec())
                .collect(),
            page.next_cursor.as_ref().map(|c| c.bytes.clone()),
            page.request_cursor.as_ref().map(|c| c.bytes.clone()),
        ),
        _ => panic!(),
    }
}

#[test]
fn a_cursor_from_one_replica_pages_on_another_and_forged_cursors_are_refused() {
    for discovery in [false, true] {
        let backend = Backend::new();
        let writer = backend.open();
        for nonce in 0..130 {
            let topic = if discovery {
                format!("topic.{nonce:03}")
            } else {
                "test.topic".into()
            };
            publish(
                &writer,
                &distinct_post(nonce, &topic),
                nonce,
                Timestamp {
                    seconds: 200,
                    nanoseconds: 0,
                },
            );
        }
        let query = if discovery {
            Query::Discovery
        } else {
            topic_query()
        };
        let [a, b, c] = [replica(&backend), replica(&backend), replica(&backend)];
        let first = a.page(NETWORK, test_policy(), query.clone(), None).unwrap();
        // Every replica serves the same first page.
        for other in [&b, &c] {
            assert_eq!(
                other
                    .page(NETWORK, test_policy(), query.clone(), None)
                    .unwrap(),
                first
            );
        }
        let (rows, next, echo) = rows_of(&first);
        assert_eq!(rows.len(), 128);
        assert!(echo.is_none());
        let next = next.expect("a second page");
        let mut forged = frank_cbor::decode_forum_cursor(&next).unwrap();
        match &mut forged.position {
            ForumCursorPosition::Topic { hash, .. } => *hash = vec![0xaa; 32],
            ForumCursorPosition::Discovery { topic } => *topic = "unknown.topic".into(),
        }
        let forged = encode_forum_cursor(&forged).unwrap();
        assert!(matches!(
            c.page(NETWORK, test_policy(), query.clone(), Some(&forged)),
            Err(ForumError::Invalid(_))
        ));
        // A's cursor continues on B.
        let second = b
            .page(NETWORK, test_policy(), query.clone(), Some(&next))
            .unwrap();
        let (more, last, echo) = rows_of(&second);
        assert_eq!(more.len(), 2);
        assert!(last.is_none());
        assert_eq!(echo.as_ref(), Some(&next));
        let all: std::collections::BTreeSet<_> = rows.iter().chain(&more).collect();
        assert_eq!(all.len(), 130, "no row repeats across the pages");
    }
}

#[test]
fn exact_terminal_cursor_echo_query_binding_and_epoch() {
    let backend = Backend::new();
    let post = observation(0, None, false);
    publish(
        &backend.open(),
        &post,
        0,
        Timestamp {
            seconds: 200,
            nanoseconds: 0,
        },
    );
    let owner = replica(&backend);
    let cursor = |epoch: Vec<u8>| {
        encode_forum_cursor(&ForumCursor {
            bytes: Vec::new(),
            network: NETWORK.into(),
            revision: 2,
            epoch,
            incarnation: 0,
            position: ForumCursorPosition::Topic {
                topic: "test.topic".into(),
                since: Timestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
                timestamp: Timestamp {
                    seconds: 200,
                    nanoseconds: 0,
                },
                hash: post.event.target_hash().to_vec(),
            },
        })
        .unwrap()
    };
    let current = cursor(epoch(NETWORK, &test_policy()).to_vec());
    let terminal = owner
        .page(NETWORK, test_policy(), topic_query(), Some(&current))
        .unwrap();
    let (rows, next, echo) = rows_of(&terminal);
    assert!(rows.is_empty() && next.is_none());
    assert_eq!(echo, Some(current.clone()));
    assert!(matches!(
        owner.page(NETWORK, test_policy(), Query::Discovery, Some(&current)),
        Err(ForumError::Invalid(_))
    ));
    assert!(matches!(
        owner.page(
            NETWORK,
            test_policy(),
            topic_query(),
            Some(&cursor(vec![2; 16]))
        ),
        Err(ForumError::Expired)
    ));
}

#[test]
fn reads_of_a_store_nothing_wrote_create_nothing() {
    let backend = Backend::new();
    let owner = replica(&backend);
    for query in [topic_query(), Query::Discovery] {
        let (rows, next, _) = rows_of(&owner.page(NETWORK, test_policy(), query, None).unwrap());
        assert!(rows.is_empty() && next.is_none());
    }
    assert!(owner
        .view(NETWORK, test_policy(), &[1; 32])
        .unwrap()
        .is_none());
    assert!(!owner.contains(NETWORK, test_policy(), &[1; 32]).unwrap());
    owner
        .status(NETWORK, test_policy(), observation(0, None, false).frame())
        .unwrap();
    assert_eq!(owner.stored_post_count().unwrap(), None);
    assert!(backend.rows().is_empty());
}

#[test]
fn status_of_another_burn_does_not_borrow_post_confirmation() {
    let backend = Backend::new();
    let confirmed = observation(0, None, false);
    publish(
        &backend.open(),
        &confirmed,
        0,
        Timestamp {
            seconds: 200,
            nanoseconds: 0,
        },
    );
    let other = observation(1, None, false);
    assert_eq!(confirmed.event.target_hash(), other.event.target_hash());
    let owner = replica(&backend);
    let response = owner.status(NETWORK, test_policy(), other.frame()).unwrap();
    let TypedPayload::ForumOperationStatus(status) =
        parsed(&response).typed.as_deref().unwrap().clone()
    else {
        panic!()
    };
    assert_eq!(
        status.evidence,
        frank_cbor::ForumOperationEvidence::UnknownRequest
    );
    let response = owner
        .status(NETWORK, test_policy(), confirmed.frame())
        .unwrap();
    let TypedPayload::ForumOperationStatus(status) =
        parsed(&response).typed.as_deref().unwrap().clone()
    else {
        panic!()
    };
    assert!(matches!(
        status.evidence,
        frank_cbor::ForumOperationEvidence::Confirmed { .. }
    ));
}

/// How the node answers `eth_sendRawTransaction` in these tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Send {
    /// Takes it and returns its hash.
    Accept,
    /// Answers with an error that proves nothing.
    Uncertain,
    /// Definitively refuses it (insufficient funds).
    Refuse,
}

/// What the chain holds for the burns, in these tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chain {
    /// No receipt yet; the sender's nonce unused.
    Unlanded,
    /// No receipt; the sender's nonce already used by another transaction.
    Replaced,
    /// A successful receipt at block 1.
    Landed,
    /// A reverted receipt.
    Reverted,
}

/// A node for one event's burns. The chain itself is out of scope here: these tests check
/// what the relay does with each answer (the real node is in the cluster contract).
#[derive(Debug, Clone)]
struct ProofTransport {
    op: Observation,
    entered: std::sync::Arc<tokio::sync::Semaphore>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
    gated: bool,
    calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    send: std::sync::Arc<std::sync::Mutex<Send>>,
    chain: std::sync::Arc<std::sync::Mutex<Chain>>,
}

impl ProofTransport {
    fn count(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == method)
            .count()
    }
    fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    fn set_send(&self, send: Send) {
        *self.send.lock().unwrap() = send;
    }
    fn set_chain(&self, chain: Chain) {
        *self.chain.lock().unwrap() = chain;
    }
}

#[async_trait::async_trait]
impl JsonRpcTransport for ProofTransport {
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> std::result::Result<serde_json::Value, crate::evm_rpc::EvmRpcError> {
        use serde_json::json;
        self.calls.lock().unwrap().push(method.to_owned());
        let lead = self.op.checked.lead();
        let hash = lead.tx_hash.to_hex();
        let chain = *self.chain.lock().unwrap();
        match method {
            "eth_sendRawTransaction" => {
                assert_eq!(
                    params[0].as_str().unwrap(),
                    format!("0x{}", hex::encode(self.op.event.lead_burn_tx()))
                );
                if self.gated {
                    self.entered.add_permits(1);
                    self.release.acquire().await.unwrap().forget();
                }
                match *self.send.lock().unwrap() {
                    Send::Accept => Ok(json!(hash)),
                    Send::Uncertain => Err(crate::evm_rpc::EvmRpcError::InvalidResponse {
                        method: method.into(),
                        reason: "controlled uncertain response".into(),
                    }),
                    Send::Refuse => Err(crate::evm_rpc::EvmRpcError::InsufficientFunds {
                        method: method.into(),
                        message: "insufficient funds for gas * price + value".into(),
                    }),
                }
            }
            "eth_getTransactionCount" => Ok(json!(if chain == Chain::Unlanded {
                format!("0x{:x}", lead.nonce)
            } else {
                format!("0x{:x}", lead.nonce + 1)
            })),
            "eth_getTransactionReceipt" => match chain {
                Chain::Unlanded | Chain::Replaced => Ok(serde_json::Value::Null),
                Chain::Landed | Chain::Reverted => Ok(json!({"transactionHash": hash,
                    "blockHash": format!("0x{}", hex::encode([0x22;32])),
                    "blockNumber":"0x1", "transactionIndex":"0x0",
                    "from":lead.sender.to_hex(),
                    "to":Address([0x44;20]).to_hex(), "contractAddress":null,
                    "gasUsed":"0x5208",
                    "status": if chain == Chain::Landed { "0x1" } else { "0x0" },
                    "logs":[]})),
            },
            "eth_getTransactionByHash" => Ok(json!({"hash":hash,
                "from":lead.sender.to_hex(),
                "to":Address([0x44;20]).to_hex(), "value":format!("0x{:x}", lead.value_wei),
                "input":format!("0x{}",hex::encode(&lead.input))})),
            _ => panic!("unexpected RPC {method}"),
        }
    }
}

fn node(op: Observation, send: Send, chain: Chain) -> ProofTransport {
    ProofTransport {
        op,
        entered: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        release: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        gated: false,
        calls: Default::default(),
        send: std::sync::Arc::new(std::sync::Mutex::new(send)),
        chain: std::sync::Arc::new(std::sync::Mutex::new(chain)),
    }
}

fn status_of(frame: &[u8]) -> frank_cbor::ForumOperationStatus<frank_cbor::ParsedFrame> {
    let TypedPayload::ForumOperationStatus(status) =
        parsed(frame).typed.as_deref().unwrap().clone()
    else {
        panic!("not a status")
    };
    status
}

fn view_of(
    owner: &Owner,
    hash: &[u8; 32],
) -> Option<frank_cbor::ForumView<frank_cbor::ParsedFrame>> {
    let frame = owner.view(NETWORK, test_policy(), hash).unwrap()?;
    let TypedPayload::ForumView(view) = parsed(&frame).typed.as_deref().unwrap().clone() else {
        panic!("not a view")
    };
    Some(view)
}

fn revision(backend: &Backend) -> u64 {
    backend
        .kv
        .transact(|tx| Ok::<_, crate::store::kv_store::KvError>(tx.get(b"r")?))
        .unwrap()
        .map_or(0, |raw| u64::from_be_bytes(raw.try_into().unwrap()))
}

fn seconds_after(time: Timestamp, seconds: u64) -> Timestamp {
    Timestamp {
        seconds: time.seconds + seconds as i64,
        nanoseconds: time.nanoseconds,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_burn_presented_to_two_replicas_gives_one_post() {
    let backend = Backend::new();
    let replicas = [Arc::new(replica(&backend)), Arc::new(replica(&backend))];
    let op = optional_observation(811);
    let mut transport = node(op.clone(), Send::Accept, Chain::Unlanded);
    transport.gated = true;
    let mut tasks = Vec::new();
    for owner in &replicas {
        let owner = owner.clone();
        let transport = transport.clone();
        let frame = op.frame().to_vec();
        tasks.push(tokio::spawn(async move {
            owner
                .submit(NETWORK, test_policy(), &frame, &transport)
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), transport.entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    // Both replicas hand over the same bytes; one admission is reserved.
    assert_eq!(revision(&backend), 1);
    let store = backend.open();
    assert_eq!(store.pending_accounting().unwrap().0, 1);
    assert_eq!(
        proof_reservations(&store, op.event.target_hash()),
        (Magnitude::from_u64(7), Magnitude::default())
    );
    // Another frame for the same transaction conflicts and hands over nothing.
    let parsed_frame = parsed(op.frame());
    let CborValue::Map(mut fields) = parsed_frame.payload else {
        panic!()
    };
    fields.iter_mut().find(|(k, _)| *k == 99).unwrap().1 = CborValue::Bytes(vec![1, 2, 3]);
    let conflict = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: frank_cbor::message_types::TYPE_TOPIC_POST_SUBMISSION,
            schema_version: 2,
            min_reader_version: 1,
        },
        frank_cbor::FramePayload::Value(&cbor_map(fields)),
    )
    .unwrap();
    let before = backend.rows();
    assert!(matches!(
        replicas[1]
            .submit(NETWORK, test_policy(), &conflict, &transport)
            .await,
        Err(ForumError::Conflict)
    ));
    assert_eq!(transport.total(), 2);
    assert_eq!(backend.rows(), before);
    transport.release.add_permits(2);
    let first = tasks.remove(0).await.unwrap().unwrap();
    let second = tasks.remove(0).await.unwrap().unwrap();
    assert_eq!(first, second);
    assert_eq!(
        status_of(&first).evidence,
        frank_cbor::ForumOperationEvidence::Counted
    );
    // Counted once, with no receipt read and no block waited for.
    assert_eq!(transport.count("eth_getTransactionReceipt"), 0);
    assert_eq!(revision(&backend), 2);
    let view = view_of(&replicas[0], op.event.target_hash()).unwrap();
    assert_eq!(view.aggregate.magnitude, Magnitude::from_u64(7).0);
    assert_eq!((view.block, view.transaction_index), (None, None));
    assert_eq!(replicas[1].stored_post_count().unwrap(), Some(1));
    // A later repeat to either replica is answered from the store without the node.
    let calls = transport.total();
    for owner in &replicas {
        assert_eq!(
            owner
                .submit(NETWORK, test_policy(), op.frame(), &transport)
                .await
                .unwrap(),
            first
        );
    }
    assert_eq!(transport.total(), calls);
    assert_eq!(revision(&backend), 2);
    // The burn lands: the background pass, on either replica, records it once.
    transport.set_chain(Chain::Landed);
    for owner in &replicas {
        owner
            .reconcile(NETWORK, test_policy(), &transport, now())
            .await
            .unwrap();
    }
    assert_eq!(store.pending_accounting().unwrap(), (0, 0));
    assert_eq!(revision(&backend), 3);
    let view = view_of(&replicas[1], op.event.target_hash()).unwrap();
    assert_eq!((view.block, view.transaction_index), (Some(1), Some(0)));
    assert_eq!(view.aggregate.magnitude, Magnitude::from_u64(7).0);
    let status = status_of(
        &replicas[0]
            .status(NETWORK, test_policy(), op.frame())
            .unwrap(),
    );
    assert!(matches!(
        status.evidence,
        frank_cbor::ForumOperationEvidence::Confirmed {
            block: 1,
            transaction_index: 0
        }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_post_accepted_on_one_replica_is_visible_on_the_others_at_once_and_a_vote_counts_everywhere(
) {
    let backend = Backend::new();
    let [a, b, c] = [replica(&backend), replica(&backend), replica(&backend)];
    let post = optional_observation(900);
    let target = *post.event.target_hash();
    let to_node = node(post.clone(), Send::Accept, Chain::Unlanded);
    let started = std::time::Instant::now();
    let answer = a
        .submit(NETWORK, test_policy(), post.frame(), &to_node)
        .await
        .unwrap();
    assert_eq!(
        status_of(&answer).evidence,
        frank_cbor::ForumOperationEvidence::Counted
    );
    for replica in [&b, &c] {
        assert!(replica.contains(NETWORK, test_policy(), &target).unwrap());
        let (rows, _, _) = rows_of(
            &replica
                .page(NETWORK, test_policy(), topic_query(), None)
                .unwrap(),
        );
        assert_eq!(rows.len(), 1);
    }
    let vote = observation(901, Some(target), true);
    let vote_node = node(vote.clone(), Send::Accept, Chain::Unlanded);
    let answer = c
        .submit(NETWORK, test_policy(), vote.frame(), &vote_node)
        .await
        .unwrap();
    assert_eq!(
        status_of(&answer).evidence,
        frank_cbor::ForumOperationEvidence::Counted
    );
    // Prompt: nothing waited on a block.
    assert!(started.elapsed() < Duration::from_secs(2));
    for replica in [&a, &b, &c] {
        let view = view_of(replica, &target).unwrap();
        // 7 up from the post, 7 down from the vote.
        assert_eq!(view.aggregate.magnitude, [0; 32]);
    }
}

#[tokio::test]
async fn a_counted_post_whose_burn_never_lands_is_reconciled_away() {
    let backend = Backend::new();
    let owner = replica(&backend);
    let post = optional_observation(910);
    let target = *post.event.target_hash();
    let to_node = node(post.clone(), Send::Accept, Chain::Unlanded);
    owner
        .submit(NETWORK, test_policy(), post.frame(), &to_node)
        .await
        .unwrap();
    let admitted = backend.open().load(&post.hash()).unwrap().unwrap();
    assert!(view_of(&owner, &target).is_some());
    // Inside the bound: still counted, and its burn is handed to the node again.
    let sends = to_node.count("eth_sendRawTransaction");
    let report = owner
        .reconcile(
            NETWORK,
            test_policy(),
            &to_node,
            seconds_after(admitted.first_seen, 60),
        )
        .await
        .unwrap();
    assert_eq!(report.waiting, 1);
    assert_eq!(to_node.count("eth_sendRawTransaction"), sends + 1);
    assert!(view_of(&owner, &target).is_some());
    // Past the bound with no receipt: dropped, its weight taken back, the post hidden.
    let report = owner
        .reconcile(
            NETWORK,
            test_policy(),
            &to_node,
            seconds_after(admitted.first_seen, LAND_BOUND.as_secs() + 1),
        )
        .await
        .unwrap();
    assert_eq!(report.dropped, 1);
    assert!(view_of(&owner, &target).is_none());
    assert!(!owner.contains(NETWORK, test_policy(), &target).unwrap());
    let (rows, _, _) = rows_of(
        &owner
            .page(NETWORK, test_policy(), topic_query(), None)
            .unwrap(),
    );
    assert!(rows.is_empty());
    let (topics, _, _) = rows_of(
        &owner
            .page(NETWORK, test_policy(), Query::Discovery, None)
            .unwrap(),
    );
    assert!(topics.is_empty());
    assert_eq!(owner.stored_post_count().unwrap(), Some(0));
    let status = status_of(&owner.status(NETWORK, test_policy(), post.frame()).unwrap());
    assert_eq!(status.evidence, frank_cbor::ForumOperationEvidence::Dropped);
    // A replay is answered from the store and hands nothing over.
    let calls = to_node.total();
    let replay = owner
        .submit(NETWORK, test_policy(), post.frame(), &to_node)
        .await
        .unwrap();
    assert_eq!(
        status_of(&replay).evidence,
        frank_cbor::ForumOperationEvidence::Dropped
    );
    assert_eq!(to_node.total(), calls);
    assert_eq!(backend.open().pending_accounting().unwrap(), (0, 0));
}

#[tokio::test]
async fn a_reverted_or_replaced_burn_takes_the_vote_back() {
    for chain in [Chain::Reverted, Chain::Replaced] {
        let backend = Backend::new();
        let owner = replica(&backend);
        let post = observation(0, None, false);
        let target = *post.event.target_hash();
        publish(
            &backend.open(),
            &post,
            1,
            Timestamp {
                seconds: 100,
                nanoseconds: 0,
            },
        );
        let vote = observation(1, Some(target), false);
        let to_node = node(vote.clone(), Send::Accept, Chain::Unlanded);
        owner
            .submit(NETWORK, test_policy(), vote.frame(), &to_node)
            .await
            .unwrap();
        assert_eq!(
            view_of(&owner, &target).unwrap().aggregate.magnitude,
            Magnitude::from_u64(14).0
        );
        to_node.set_chain(chain);
        let first_seen = backend
            .open()
            .load(&vote.hash())
            .unwrap()
            .unwrap()
            .first_seen;
        let report = owner
            .reconcile(
                NETWORK,
                test_policy(),
                &to_node,
                seconds_after(first_seen, 1),
            )
            .await
            .unwrap();
        if chain == Chain::Replaced {
            // A used nonce may be an upstream that has not shown the receipt yet: wait a little.
            assert_eq!(report.waiting, 1, "{chain:?}");
            owner
                .reconcile(
                    NETWORK,
                    test_policy(),
                    &to_node,
                    seconds_after(first_seen, 61),
                )
                .await
                .unwrap();
        } else {
            assert_eq!(report.dropped, 1, "{chain:?}");
        }
        assert_eq!(
            view_of(&owner, &target).unwrap().aggregate.magnitude,
            Magnitude::from_u64(7).0,
            "{chain:?}"
        );
        let status = status_of(&owner.status(NETWORK, test_policy(), vote.frame()).unwrap());
        assert_eq!(status.evidence, frank_cbor::ForumOperationEvidence::Dropped);
    }
}

#[tokio::test]
async fn a_set_the_node_did_not_take_stays_pending_and_counts_when_it_does() {
    let backend = Backend::new();
    let owner = replica(&backend);
    let post = optional_observation(920);
    let target = *post.event.target_hash();
    // No definite answer: pending, answered at once, not an error.
    let to_node = node(post.clone(), Send::Uncertain, Chain::Unlanded);
    let answer = owner
        .submit(NETWORK, test_policy(), post.frame(), &to_node)
        .await
        .unwrap();
    assert_eq!(
        status_of(&answer).evidence,
        frank_cbor::ForumOperationEvidence::Pending
    );
    assert!(view_of(&owner, &target).is_none());
    // A definite refusal of every burn is said, and the event is still kept.
    to_node.set_send(Send::Refuse);
    assert!(matches!(
        owner
            .submit(NETWORK, test_policy(), post.frame(), &to_node)
            .await,
        Err(ForumError::Refused(_))
    ));
    assert_eq!(backend.open().pending_accounting().unwrap().0, 1);
    // The node takes it on the background pass: counted.
    to_node.set_send(Send::Accept);
    let report = owner
        .reconcile(NETWORK, test_policy(), &to_node, now())
        .await
        .unwrap();
    assert_eq!(report.counted, 1);
    assert!(view_of(&owner, &target).is_some());
    // A burn the node gives no answer for but which already landed counts and confirms.
    let landed = optional_observation(921);
    let landed_node = node(landed.clone(), Send::Uncertain, Chain::Landed);
    let answer = owner
        .submit(NETWORK, test_policy(), landed.frame(), &landed_node)
        .await
        .unwrap();
    assert_eq!(
        status_of(&answer).evidence,
        frank_cbor::ForumOperationEvidence::Counted
    );
}

#[tokio::test]
async fn revision_exhaustion_preserves_pending_obligation_and_never_wraps() {
    let backend = Backend::new();
    drop(backend.open());
    // Admission, counting and landing each advance the revision once.
    backend.set(b"r", &(u64::MAX - 3).to_be_bytes());
    let owner = replica(&backend);
    let op = optional_observation(811);
    let uncertain = node(op.clone(), Send::Uncertain, Chain::Unlanded);
    let answer = owner
        .submit(NETWORK, test_policy(), op.frame(), &uncertain)
        .await
        .unwrap();
    assert_eq!(
        status_of(&answer).evidence,
        frank_cbor::ForumOperationEvidence::Pending
    );
    assert_eq!(revision(&backend), u64::MAX - 2);
    let before = backend.rows();
    let extra = optional_observation(812);
    let calls = uncertain.total();
    assert!(matches!(
        owner
            .submit(NETWORK, test_policy(), extra.frame(), &uncertain)
            .await,
        Err(ForumError::Capacity)
    ));
    assert_eq!(uncertain.total(), calls);
    assert_eq!(backend.rows(), before);
    let accepted = node(op.clone(), Send::Accept, Chain::Landed);
    owner
        .submit(NETWORK, test_policy(), op.frame(), &accepted)
        .await
        .unwrap();
    assert_eq!(revision(&backend), u64::MAX - 1);
    owner
        .reconcile(NETWORK, test_policy(), &accepted, now())
        .await
        .unwrap();
    assert_eq!(revision(&backend), u64::MAX);
    assert!(matches!(
        owner
            .submit(NETWORK, test_policy(), extra.frame(), &uncertain)
            .await,
        Err(ForumError::Capacity)
    ));
}
