//! The forum owner over one shared transaction store: what a client sees through any replica.
use super::*;
use crate::store::forum::tests::{
    distinct_post, facts, observation, optional_observation, proof_reservations, publish, Backend,
    NETWORK,
};
use crate::store::forum::Magnitude;
use crate::store::kv_store::Transact;
use frank_cbor::{TypedPayload, ValidationResult};
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

#[derive(Debug, Clone)]
struct ProofTransport {
    op: Observation,
    entered: std::sync::Arc<tokio::sync::Semaphore>,
    release: std::sync::Arc<tokio::sync::Semaphore>,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    fail: bool,
}

#[async_trait::async_trait]
impl JsonRpcTransport for ProofTransport {
    async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> std::result::Result<serde_json::Value, crate::monad_http::MonadRpcError> {
        use serde_json::json;
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.fail {
            return Err(crate::monad_http::MonadRpcError::InvalidResponse {
                method: method.into(),
                reason: "controlled uncertain response".into(),
            });
        }
        let hash = self.op.checked.decoded.tx_hash.to_hex();
        match method {
            "eth_sendRawTransaction" => {
                assert_eq!(
                    params[0].as_str().unwrap(),
                    format!("0x{}", hex::encode(self.op.event.burn_tx()))
                );
                self.entered.add_permits(1);
                self.release.acquire().await.unwrap().forget();
                Ok(json!(hash))
            }
            "eth_getTransactionReceipt" => Ok(json!({"transactionHash": hash,
                "blockHash": format!("0x{}", hex::encode([0x22;32])),
                "blockNumber":"0x1", "transactionIndex":"0x0",
                "from":self.op.checked.decoded.sender.to_hex(),
                "to":Address([0x44;20]).to_hex(), "contractAddress":null,
                "gasUsed":"0x5208", "status":"0x1", "logs":[]})),
            "eth_getTransactionByHash" => Ok(json!({"hash":hash,
                "from":self.op.checked.decoded.sender.to_hex(),
                "to":Address([0x44;20]).to_hex(), "value":"0x7",
                "input":format!("0x{}",hex::encode(&self.op.checked.decoded.input))})),
            _ => panic!("unexpected RPC {method}"),
        }
    }
}

fn proof_transport(op: Observation, fail: bool) -> ProofTransport {
    ProofTransport {
        op,
        entered: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        release: std::sync::Arc::new(tokio::sync::Semaphore::new(0)),
        calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        fail,
    }
}

fn proof_poll() -> PollConfig {
    PollConfig {
        interval: Duration::from_millis(1),
        max_attempts: 1,
    }
}

fn proof_parsed(frame: &[u8]) -> frank_cbor::ParsedFrame {
    let ValidationResult::Parsed(parsed) =
        frank_cbor::validate_frame(frame, &frank_cbor::default_context()).unwrap()
    else {
        panic!()
    };
    parsed
}

fn revision(backend: &Backend) -> u64 {
    backend
        .kv
        .transact(|tx| Ok::<_, crate::store::kv_store::KvError>(tx.get(b"r")?))
        .unwrap()
        .map_or(0, |raw| u64::from_be_bytes(raw.try_into().unwrap()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_burn_presented_to_two_replicas_gives_one_post() {
    use std::sync::{atomic::Ordering, Arc};
    let backend = Backend::new();
    let replicas = [Arc::new(replica(&backend)), Arc::new(replica(&backend))];
    let op = optional_observation(811);
    let transport = proof_transport(op.clone(), false);
    let mut tasks = Vec::new();
    for owner in &replicas {
        let owner = owner.clone();
        let transport = transport.clone();
        let frame = op.frame().to_vec();
        tasks.push(tokio::spawn(async move {
            owner
                .submit(NETWORK, test_policy(), &frame, &transport, proof_poll())
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), transport.entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    // Both replicas broadcast the same bytes; one admission is reserved.
    assert_eq!(revision(&backend), 1);
    let store = backend.open();
    assert_eq!(store.pending_accounting().unwrap().0, 1);
    assert_eq!(
        proof_reservations(&store, op.event.target_hash()),
        (Magnitude::from_u64(7), Magnitude::default())
    );
    // Another frame for the same transaction conflicts and broadcasts nothing.
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
            .submit(NETWORK, test_policy(), &conflict, &transport, proof_poll())
            .await,
        Err(ForumError::Conflict)
    ));
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    assert_eq!(backend.rows(), before);
    transport.release.add_permits(2);
    let first = tasks.remove(0).await.unwrap().unwrap();
    let second = tasks.remove(0).await.unwrap().unwrap();
    assert_eq!(first, second);
    assert_eq!(revision(&backend), 2);
    assert_eq!(store.pending_accounting().unwrap(), (0, 0));
    let view = replicas[0]
        .view(NETWORK, test_policy(), op.event.target_hash())
        .unwrap()
        .unwrap();
    let TypedPayload::ForumView(view) = parsed(&view).typed.as_deref().unwrap().clone() else {
        panic!()
    };
    assert_eq!(view.aggregate.magnitude, Magnitude::from_u64(7).0);
    assert_eq!(replicas[1].stored_post_count().unwrap(), Some(1));
    // A later repeat to either replica is answered from the store without the chain.
    let calls = transport.calls.load(Ordering::SeqCst);
    for owner in &replicas {
        assert_eq!(
            owner
                .submit(NETWORK, test_policy(), op.frame(), &transport, proof_poll())
                .await
                .unwrap(),
            first
        );
    }
    assert_eq!(transport.calls.load(Ordering::SeqCst), calls);
    assert_eq!(revision(&backend), 2);
}

#[tokio::test]
async fn revision_exhaustion_preserves_pending_obligation_and_never_wraps() {
    use std::sync::atomic::Ordering;
    let backend = Backend::new();
    drop(backend.open());
    backend.set(b"r", &(u64::MAX - 2).to_be_bytes());
    let owner = replica(&backend);
    let op = optional_observation(811);
    let uncertain = proof_transport(op.clone(), true);
    assert!(matches!(
        owner
            .submit(NETWORK, test_policy(), op.frame(), &uncertain, proof_poll())
            .await,
        Err(ForumError::OutcomeUnknown(_))
    ));
    assert_eq!(revision(&backend), u64::MAX - 1);
    let before = backend.rows();
    let extra = optional_observation(812);
    let calls = uncertain.calls.load(Ordering::SeqCst);
    assert!(matches!(
        owner
            .submit(
                NETWORK,
                test_policy(),
                extra.frame(),
                &uncertain,
                proof_poll()
            )
            .await,
        Err(ForumError::Capacity)
    ));
    assert_eq!(uncertain.calls.load(Ordering::SeqCst), calls);
    assert_eq!(backend.rows(), before);
    let confirmed = proof_transport(op.clone(), false);
    confirmed.release.add_permits(1);
    owner
        .submit(NETWORK, test_policy(), op.frame(), &confirmed, proof_poll())
        .await
        .unwrap();
    assert_eq!(revision(&backend), u64::MAX);
    assert!(matches!(
        owner
            .submit(
                NETWORK,
                test_policy(),
                extra.frame(),
                &uncertain,
                proof_poll()
            )
            .await,
        Err(ForumError::Capacity)
    ));
}
