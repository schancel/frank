use super::*;
use crate::monad_http::Address;

fn policy() -> TopicBurnPolicy {
    TopicBurnPolicy {
        expected_chain_id: 10143,
        burn_address: Address([0x44; 20]),
    }
}

pub(crate) fn observation(nonce: u64, target: Option<[u8; 32]>, down: bool) -> Observation {
    observation_with_amount(nonce, target, down, 7)
}

pub(crate) fn observation_with_amount(
    nonce: u64,
    target: Option<[u8; 32]>,
    down: bool,
    amount: u128,
) -> Observation {
    observation_fields(nonce, target, down, amount, "test.topic", "title")
}

pub(crate) fn distinct_post(nonce: u64, topic: &str) -> Observation {
    observation_fields(nonce, None, false, 7, topic, &format!("post-{nonce}"))
}

pub(crate) fn sized_post(nonce: u64, topic: &str, title_len: usize) -> Observation {
    assert!((16..=262_144).contains(&title_len));
    let mut title = format!("{nonce:016x}");
    title.push_str(&"x".repeat(title_len - title.len()));
    observation_fields(nonce, None, false, 7, topic, &title)
}

fn observation_fields(
    nonce: u64,
    target: Option<[u8; 32]>,
    down: bool,
    amount: u128,
    topic: &str,
    title: &str,
) -> Observation {
    observation_of(&event_frame(
        &[(3, nonce, amount)],
        target,
        down,
        topic,
        title,
    ))
}

/// A post (no `target`) or a vote on `target` paid by a burn set: one signed burn per
/// `(key byte, nonce, amount)`, lead first, each with real commitments.
pub(crate) fn event_frame(
    burns: &[(u8, u64, u128)],
    target: Option<[u8; 32]>,
    down: bool,
    topic: &str,
    title: &str,
) -> Vec<u8> {
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use frank_cbor::{encode_forum_post, encode_frame, EnvelopeFields, ForumEntry, FramePayload};
    let post = encode_forum_post(
        "monad-testnet",
        topic,
        None,
        &Timestamp {
            seconds: 1,
            nanoseconds: 0,
        },
        &[ForumEntry::Post {
            title: Some(title.into()),
            url: None,
            message: Some("body".into()),
            unknown: vec![],
        }],
    )
    .unwrap();
    let make = |raws: Vec<Vec<u8>>| {
        let (kind, item) = match target {
            Some(hash) => (
                frank_cbor::message_types::TYPE_TOPIC_VOTE_SUBMISSION,
                CborValue::Bytes(hash.to_vec()),
            ),
            None => (
                frank_cbor::message_types::TYPE_TOPIC_POST_SUBMISSION,
                CborValue::Bytes(post.clone()),
            ),
        };
        encode_frame(
            EnvelopeFields {
                type_id: kind,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&cbor_map(vec![
                (0, CborValue::Text("monad-testnet".into())),
                (1, item),
                (
                    2,
                    CborValue::Array(raws.into_iter().map(CborValue::Bytes).collect()),
                ),
            ])),
        )
        .unwrap()
    };
    let preliminary = parse_topic_event(&make(vec![vec![1]]), "monad-testnet").unwrap();
    let mut calldata = b"TPIC".to_vec();
    calldata.extend([2, if down { 0 } else { 1 }]);
    calldata.extend(preliminary.commitment());
    let raws = burns
        .iter()
        .map(|&(key, nonce, amount)| {
            let secret = EccSecp256k1::default()
                .seckey_from_array([key; 32])
                .unwrap();
            crate::monad_evm_tx::test_support::signed_eip1559_tx(
                &secret,
                10143,
                nonce,
                policy().burn_address,
                amount,
                &calldata,
            )
            .0
        })
        .collect();
    make(raws)
}

/// The admitted-request form of a valid `frame`.
pub(crate) fn observation_of(frame: &[u8]) -> Observation {
    let event = parse_topic_event(frame, "monad-testnet").unwrap();
    let checked = check_topic_burn_before_broadcast(&event, &policy()).unwrap();
    Observation {
        event,
        checked,
        first_seen: Timestamp {
            seconds: 100,
            nanoseconds: 1,
        },
        confirmed: None,
    }
}

/// The chain facts of every burn of `op`'s set, the lead at `block`/`index` and each later
/// burn one position after the previous.
pub(crate) fn facts(op: &Observation, block: u64, index: u64) -> Vec<VerifiedTopicBurn> {
    op.checked
        .members
        .iter()
        .enumerate()
        .map(|(i, member)| VerifiedTopicBurn {
            sender: member.sender,
            tx_hash: member.tx_hash,
            value_wei: member.value_wei,
            direction: op.checked.direction,
            block_number: block,
            transaction_index: index.saturating_add(i as u64),
        })
        .collect()
}

/// A compatible newer-schema post and event, with real commitments and a signed burn.
pub(crate) fn optional_observation(nonce: u64) -> Observation {
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use frank_cbor::{encode_frame, EnvelopeFields, FramePayload, ValidationResult};
    let base = observation(nonce, None, false);
    let TopicEvent::Post(base_post) = &base.event else {
        panic!()
    };
    let ValidationResult::Parsed(parsed) =
        frank_cbor::validate_frame(&base_post.post_frame, &frank_cbor::default_context()).unwrap()
    else {
        panic!()
    };
    let CborValue::Map(mut fields) = parsed.payload else {
        panic!()
    };
    fields.push((99, CborValue::Bytes(vec![0, 0xff, 0x81, 0x42])));
    let post = encode_frame(
        EnvelopeFields {
            type_id: frank_cbor::message_types::TYPE_TOPIC_POST,
            schema_version: 3,
            min_reader_version: 2,
        },
        FramePayload::Value(&cbor_map(fields)),
    )
    .unwrap();
    let make = |raw| {
        encode_frame(
            EnvelopeFields {
                type_id: frank_cbor::message_types::TYPE_TOPIC_POST_SUBMISSION,
                schema_version: 2,
                min_reader_version: 1,
            },
            FramePayload::Value(&cbor_map(vec![
                (0, CborValue::Text("monad-testnet".into())),
                (1, CborValue::Bytes(post.clone())),
                (2, CborValue::Array(vec![CborValue::Bytes(raw)])),
                (99, CborValue::Bytes(vec![0xfe, 0, 0x7f])),
            ])),
        )
        .unwrap()
    };
    let preliminary = parse_topic_event(&make(vec![1]), "monad-testnet").unwrap();
    let mut calldata = b"TPIC".to_vec();
    calldata.extend([2, 1]);
    calldata.extend(preliminary.commitment());
    let secret = EccSecp256k1::default().seckey_from_array([3; 32]).unwrap();
    let (raw, _) = crate::monad_evm_tx::test_support::signed_eip1559_tx(
        &secret,
        10143,
        nonce,
        policy().burn_address,
        7,
        &calldata,
    );
    let event = parse_topic_event(&make(raw), "monad-testnet").unwrap();
    let checked = check_topic_burn_before_broadcast(&event, &policy()).unwrap();
    Observation {
        event,
        checked,
        first_seen: base.first_seen,
        confirmed: None,
    }
}

use crate::store::kv_store::{KvError, KvTransaction, Outcome, RocksDbKvStore};
use crate::store::large_values::LocalFsObjectStore;

pub(crate) const NETWORK: &str = "monad-testnet";

/// A real RocksDB transaction store and a local object store, shared by every [`Store`] opened
/// on them (two replicas of one cluster, as far as the forum can tell).
pub(crate) struct Backend {
    pub(crate) kv: Arc<dyn RelayKvStore>,
    pub(crate) objects: Arc<dyn ObjectStore>,
}

impl Backend {
    pub(crate) fn new() -> Self {
        Self {
            kv: Arc::new(RocksDbKvStore::open_temporary().unwrap()),
            objects: Arc::new(LocalFsObjectStore::temporary()),
        }
    }
    pub(crate) fn wrapped(kv: Arc<dyn RelayKvStore>) -> Self {
        Self {
            kv,
            objects: Arc::new(LocalFsObjectStore::temporary()),
        }
    }
    pub(crate) fn open(&self) -> Store {
        Store::open(
            self.kv.clone(),
            self.objects.clone(),
            NETWORK,
            policy(),
            true,
            "reset",
        )
        .unwrap()
        .unwrap()
    }
    /// Every key and value of the store.
    pub(crate) fn rows(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        self.kv
            .transact(|tx| tx.get_range(b"", &[0xff], usize::MAX))
            .unwrap()
    }
    pub(crate) fn set(&self, key: &[u8], value: &[u8]) {
        self.kv.transact(|tx| tx.set(key, value)).unwrap();
    }
}

fn at(seconds: i64) -> Timestamp {
    Timestamp {
        seconds,
        nanoseconds: 0,
    }
}

fn post_of(store: &Store, hash: &[u8; 32]) -> Option<Post> {
    store.read(|tx| Store::post(tx, hash)).unwrap()
}

fn topics(store: &Store) -> Vec<(String, u64, Timestamp)> {
    store
        .read(|tx| {
            let rows = tx.scan_prefix(Store::discovery_prefix(), None, usize::MAX)?;
            rows.into_iter()
                .map(|(k, v)| {
                    let (count, last) = Store::decode_discovery_entry(&v)?;
                    Ok((
                        String::from_utf8(k[DISCOVERY.len()..].to_vec()).unwrap(),
                        count,
                        last,
                    ))
                })
                .collect()
        })
        .unwrap()
}

pub(crate) fn publish(store: &Store, op: &Observation, block: u64, when: Timestamp) {
    let admitted = store.admit(op.clone()).unwrap();
    store
        .confirm(&admitted, &facts(op, block, 0), when)
        .unwrap();
}

#[test]
fn exact_pending_survives_reopen_and_publication_is_once_only() {
    let backend = Backend::new();
    let original = observation(0, None, false);
    let hash = original.hash();
    let target = *original.event.target_hash();
    let store = backend.open();
    store.admit(original.clone()).unwrap();
    assert_eq!(store.pending_accounting().unwrap().0, 1);
    drop(store);
    let store = backend.open();
    let retained = store
        .read(|tx| Store::retained(tx, &original))
        .unwrap()
        .unwrap();
    assert!(retained.confirmed.is_none());
    assert!(post_of(&store, &target).unwrap().visible.is_none());
    assert_eq!(store.stored_post_count().unwrap(), 0);
    store
        .confirm(&original, &facts(&original, 10, 0), at(200))
        .unwrap();
    // A second confirmation, later, changes nothing.
    store
        .confirm(&original, &facts(&original, 10, 0), at(300))
        .unwrap();
    assert_eq!(store.pending_accounting().unwrap(), (0, 0));
    assert_eq!(store.stored_post_count().unwrap(), 1);
    let post = post_of(&store, &target).unwrap();
    assert_eq!(post.visible, Some(at(200)));
    assert_eq!(post.author, Some(hash));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(7));
    // A second burn of the same post, earlier on chain, becomes its author; visibility stays.
    let second = observation(1, None, false);
    publish(&store, &second, 0, at(50));
    let post = post_of(&store, &target).unwrap();
    assert_eq!(post.visible, Some(at(200)));
    assert_eq!(post.author, Some(second.hash()));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(14));
    let vote = observation(2, Some(target), true);
    store.admit(vote.clone()).unwrap();
    store
        .confirm(&vote, &facts(&vote, u64::MAX, u64::MAX), at(200))
        .unwrap();
    drop(store);
    let store = backend.open();
    let post = post_of(&store, &target).unwrap();
    assert_eq!(post.author, Some(second.hash()));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(7));
    assert_eq!(topics(&store), vec![("test.topic".into(), 1, at(200))]);
    assert_eq!(store.stored_post_count().unwrap(), 1);
    // Revision: three admissions and three first confirmations.
    assert_eq!(store.read(|tx| Store::revision(tx)).unwrap(), 6);
}

#[test]
fn exact_retry_at_capacity_and_conflicting_wrapper_preserve_authority() {
    let backend = Backend::new();
    let original = observation(0, None, false);
    let store = backend.open();
    store.admit(original.clone()).unwrap();
    let (_, bytes) = store.pending_accounting().unwrap();
    store
        .kv
        .transact(|tx| Store::put_pending(tx, MAX_PENDING_COUNT, bytes))
        .unwrap();
    assert!(store.admit(original.clone()).is_ok());
    assert!(matches!(
        store.admit(observation(1, None, false)),
        Err(ForumError::Capacity)
    ));
    let TopicEvent::Post(post) = &original.event else {
        panic!()
    };
    let changed = frank_cbor::encode_frame(
        frank_cbor::EnvelopeFields {
            type_id: frank_cbor::message_types::TYPE_TOPIC_POST_SUBMISSION,
            schema_version: 2,
            min_reader_version: 1,
        },
        frank_cbor::FramePayload::Value(&cbor_map(vec![
            (0, CborValue::Text("monad-testnet".into())),
            (1, CborValue::Bytes(post.post_frame.clone())),
            (
                2,
                CborValue::Array(
                    post.burn_txs
                        .iter()
                        .cloned()
                        .map(CborValue::Bytes)
                        .collect(),
                ),
            ),
            (99, CborValue::Bytes(vec![42])),
        ])),
    )
    .unwrap();
    let mut conflict = original.clone();
    conflict.event = parse_topic_event(&changed, "monad-testnet").unwrap();
    let before = backend.rows();
    assert!(matches!(store.admit(conflict), Err(ForumError::Conflict)));
    assert_eq!(backend.rows(), before);
}

#[test]
fn aggregate_keeps_wide_values_and_cancellation_without_host_narrowing() {
    let amount = Magnitude::from_u64(i64::MAX as u64);
    let twice = Aggregate::default()
        .add(false, amount)
        .unwrap()
        .add(false, amount)
        .unwrap();
    assert_eq!(&twice.magnitude.0[24..], &(u64::MAX - 1).to_be_bytes());
    let zero = twice.add(true, amount).unwrap().add(true, amount).unwrap();
    assert_eq!(zero, Aggregate::default());
    let max = Magnitude([0xff; 32]);
    assert!(max.add(Magnitude::from_u64(1)).is_err());
    assert_eq!(
        Aggregate {
            negative: true,
            magnitude: max
        }
        .add(false, max)
        .unwrap(),
        Aggregate::default()
    );
}

#[test]
fn a_store_of_another_format_or_policy_is_refused_and_never_rewritten() {
    let open = |backend: &Backend, policy: TopicBurnPolicy, create: bool| {
        Store::open(
            backend.kv.clone(),
            backend.objects.clone(),
            NETWORK,
            policy,
            create,
            "reset",
        )
    };
    let backend = Backend::new();
    assert!(open(&backend, policy(), false).unwrap().is_none());
    assert!(backend.rows().is_empty(), "a read never creates the store");
    drop(backend.open());
    let different = TopicBurnPolicy {
        burn_address: Address([0x55; 20]),
        ..policy()
    };
    let before = backend.rows();
    assert!(matches!(
        open(&backend, different, true),
        Err(ForumError::Unavailable)
    ));
    assert_eq!(backend.rows(), before);
    assert!(open(&backend, policy(), false).unwrap().is_some());
    // Keys without this format's marker, or another marker, are never adopted.
    let other = Backend::new();
    other.set(b"e/x", b"old");
    assert!(matches!(
        open(&other, policy(), true),
        Err(ForumError::Unavailable)
    ));
    let other = Backend::new();
    other.set(FORMAT_KEY, b"frank-forum-kv-v0");
    assert!(matches!(
        open(&other, policy(), true),
        Err(ForumError::Unavailable)
    ));
    assert_eq!(
        other.rows(),
        vec![(FORMAT_KEY.to_vec(), b"frank-forum-kv-v0".to_vec())]
    );
}

#[test]
fn corrupt_authority_fails_closed_without_reset() {
    let backend = Backend::new();
    let store = backend.open();
    let op = observation(0, None, false);
    publish(&store, &op, 1, at(200));
    let state_key = key(STATES, &op.hash());
    backend.set(&state_key, &[0xa0]);
    assert!(matches!(
        store.read(|tx| Store::retained(tx, &op)),
        Err(ForumError::Unavailable)
    ));
    assert!(matches!(
        store.admit(op.clone()),
        Err(ForumError::Unavailable)
    ));
    let row = store
        .read(|tx| Store::stored_row(tx, op.event.target_hash()))
        .unwrap()
        .unwrap();
    assert!(matches!(
        store.resolve_row(row),
        Err(ForumError::Unavailable)
    ));
    assert!(backend.rows().contains(&(state_key.clone(), vec![0xa0])));
}

#[test]
fn closed_private_maps_reject_extra_fields_and_bad_timestamps() {
    assert!(timestamp(&cbor_map(vec![
        (0, CborValue::Int(0)),
        (1, CborValue::Int(1_000_000_000))
    ]))
    .is_err());
    assert!(timestamp(&cbor_map(vec![
        (0, CborValue::Int(0)),
        (1, CborValue::Int(0)),
        (2, CborValue::Int(0))
    ]))
    .is_err());
    assert_eq!(
        time_key(
            timestamp(&time_value(Timestamp {
                seconds: -1,
                nanoseconds: 999_000_000
            }))
            .unwrap()
        ),
        (-1, 999_000_000)
    );
}

#[test]
fn actual_pending_limit_is_shared_and_permits_only_exact_retry() {
    let backend = Backend::new();
    let store = backend.open();
    let first = observation(0, None, false);
    for nonce in 0..MAX_PENDING_COUNT {
        store.admit(observation(nonce, None, false)).unwrap();
    }
    let (count, charge) = store.pending_accounting().unwrap();
    assert_eq!(count, MAX_PENDING_COUNT);
    assert!(charge > 0 && charge <= MAX_PENDING_BYTES);
    // Another replica sees the same limit.
    let other = backend.open();
    assert!(matches!(
        other.admit(observation(MAX_PENDING_COUNT, None, false)),
        Err(ForumError::Capacity)
    ));
    other.admit(first.clone()).unwrap();
    assert_eq!(other.pending_accounting().unwrap(), (count, charge));
    other
        .confirm(&first, &facts(&first, 1, 0), at(200))
        .unwrap();
    assert_eq!(store.pending_accounting().unwrap().0, MAX_PENDING_COUNT - 1);
    store
        .admit(observation(MAX_PENDING_COUNT, None, false))
        .unwrap();
    assert_eq!(other.pending_accounting().unwrap().0, MAX_PENDING_COUNT);
}

#[test]
fn actual_pending_byte_ceiling_is_durable_and_preserves_exact_retry() {
    let backend = Backend::new();
    let store = backend.open();
    let title = "x".repeat(262_000);
    let first = observation_fields(0, None, false, 7, "test.topic", &title);
    let mut refused = None;
    for nonce in 0..MAX_PENDING_COUNT {
        let op = observation_fields(nonce, None, false, 7, "test.topic", &title);
        match store.admit(op.clone()) {
            Ok(_) => (),
            Err(ForumError::Capacity) => {
                refused = Some(op);
                break;
            }
            Err(error) => panic!("unexpected admission failure: {error}"),
        }
    }
    let refused = refused.expect("byte ceiling must precede record ceiling");
    let (count, bytes) = store.pending_accounting().unwrap();
    assert!(count > 0 && count < MAX_PENDING_COUNT);
    assert!(bytes <= MAX_PENDING_BYTES);
    assert!(bytes + refused.charge() > MAX_PENDING_BYTES);
    assert!(store
        .read(|tx| Store::operation(tx, &refused.hash()))
        .unwrap()
        .is_none());
    store.admit(first.clone()).unwrap();
    assert_eq!(store.pending_accounting().unwrap(), (count, bytes));
    drop(store);
    let store = backend.open();
    assert_eq!(store.pending_accounting().unwrap(), (count, bytes));
    assert!(matches!(store.admit(refused), Err(ForumError::Capacity)));
    assert_eq!(store.pending_accounting().unwrap(), (count, bytes));
}

#[test]
fn same_direction_headroom_never_assumes_opposite_pending_cancellation() {
    let op = observation(0, None, false);
    let post = Post {
        topic: "test.topic".into(),
        author: None,
        visible: None,
        aggregate: Aggregate {
            negative: false,
            magnitude: Magnitude([0xff; 32]).sub(Magnitude::from_u64(7)).unwrap(),
        },
        reserved_up: Magnitude::default(),
        reserved_down: Magnitude::default(),
    };
    let post = Store::reserve(&op, post).unwrap();
    assert_eq!(post.reserved_up, Magnitude::from_u64(7));
    let down = observation(1, Some(*op.event.target_hash()), true);
    let post = Store::reserve(&down, post).unwrap();
    assert_eq!(post.reserved_down, Magnitude::from_u64(7));
    // One more up would overflow in a permitted receipt ordering, even with a
    // currently pending opposite burn. Neither reservation can cancel the other.
    assert!(Store::reserve(
        &observation_with_amount(2, Some(*op.event.target_hash()), false, 1),
        post
    )
    .is_err());
}

#[test]
fn one_burn_admitted_and_confirmed_concurrently_by_two_replicas_counts_once() {
    for round in 0..10u64 {
        let backend = Backend::new();
        let replicas = [backend.open(), backend.open()];
        let post = observation(round, None, false);
        publish(&replicas[0], &post, 1, at(100));
        let vote = observation(100 + round, Some(*post.event.target_hash()), false);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for replica in &replicas {
                let (vote, barrier) = (vote.clone(), &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    let admitted = replica.admit(vote.clone()).unwrap();
                    barrier.wait();
                    replica
                        .confirm(&admitted, &facts(&vote, 2, 0), at(200))
                        .unwrap();
                });
            }
        });
        let post = post_of(&replicas[1], post.event.target_hash()).unwrap();
        assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(14), "{round}");
        assert_eq!(post.reserved_up, Magnitude::default());
        assert_eq!(replicas[1].pending_accounting().unwrap(), (0, 0));
        // Post: admit + confirm; vote: admit + confirm. Once each.
        assert_eq!(replicas[0].read(|tx| Store::revision(tx)).unwrap(), 4);
    }
}

/// The real RocksDB driver, with the answer of chosen commits lost: the commit is applied
/// (`Some(true)`) or abandoned (`Some(false)`), and either way the caller is told the outcome is
/// unknown, as FoundationDB may.
#[derive(Debug)]
pub(crate) struct LostAnswers {
    pub(crate) inner: RocksDbKvStore,
    pub(crate) plan: std::sync::Mutex<std::collections::VecDeque<Option<bool>>>,
}

impl RelayKvStore for LostAnswers {
    fn run_transaction(
        &self,
        body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
    ) -> std::result::Result<Outcome, KvError> {
        let next = self.plan.lock().unwrap().pop_front().flatten();
        match next {
            None => self.inner.run_transaction(body),
            Some(committed) => {
                self.inner.run_transaction(&mut |tx| {
                    let outcome = body(tx);
                    if committed {
                        outcome
                    } else {
                        Outcome::Abort
                    }
                })?;
                Err(KvError::CommitUnknownResult("answer lost".into()))
            }
        }
    }
}

#[test]
fn an_unknown_commit_outcome_is_settled_and_counts_the_burn_once() {
    for committed in [true, false] {
        let lost = Arc::new(LostAnswers {
            inner: RocksDbKvStore::open_temporary().unwrap(),
            plan: Default::default(),
        });
        let backend = Backend::wrapped(lost.clone());
        let store = backend.open();
        let op = observation(0, None, false);
        // The admission's answer is lost; then its confirmation's.
        lost.plan.lock().unwrap().push_back(Some(committed));
        let admitted = store.admit(op.clone()).unwrap();
        assert!(admitted.confirmed.is_none());
        assert_eq!(store.pending_accounting().unwrap().0, 1, "{committed}");
        lost.plan.lock().unwrap().push_back(Some(committed));
        let confirmed = store.confirm(&op, &facts(&op, 3, 0), at(200)).unwrap();
        assert!(confirmed.confirmed.is_some());
        assert_eq!(store.pending_accounting().unwrap(), (0, 0));
        let post = post_of(&store, op.event.target_hash()).unwrap();
        assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(7));
        assert_eq!(store.stored_post_count().unwrap(), 1);
        assert_eq!(store.read(|tx| Store::revision(tx)).unwrap(), 2);
    }
}

#[test]
fn a_frame_over_the_inline_limit_is_an_object_read_back_by_another_replica() {
    let backend = Backend::new();
    let a = backend.open();
    let op = sized_post(0, "big.topic", 200_000);
    assert!(op.frame().len() > INLINE_LIMIT);
    publish(&a, &op, 1, at(200));
    let raw = backend
        .rows()
        .into_iter()
        .find(|(k, _)| k == &key(FRAMES, &op.hash()))
        .unwrap()
        .1;
    assert!(matches!(Stored::decode(&raw), Some(Stored::Large(_))));
    assert_eq!(a.large.references(10).unwrap().len(), 1);
    // A repeat neither uploads again nor changes a reference.
    a.admit(op.clone()).unwrap();
    assert_eq!(a.large.references(10).unwrap().len(), 1);
    let b = backend.open();
    let row = b
        .read(|tx| Store::stored_row(tx, op.event.target_hash()))
        .unwrap()
        .unwrap();
    let row = b.resolve_row(row).unwrap();
    assert_eq!(row.author.frame(), op.frame());
    // The sweep keeps the referenced object.
    let report = b.sweep_large_values([1; 16]).unwrap();
    assert_eq!(report.deleted, 0);
}

pub(crate) fn proof_reservations(store: &Store, hash: &[u8; 32]) -> (Magnitude, Magnitude) {
    let post = post_of(store, hash).unwrap();
    (post.reserved_up, post.reserved_down)
}

/// The single-node store a registry at `registry_db` opens, opened directly (the registry must
/// not hold it at the same time).
pub(crate) fn open_beside(registry_db: &std::path::Path) -> (Arc<dyn RelayKvStore>, Store) {
    let mut name = registry_db.as_os_str().to_owned();
    name.push(STORE_SUFFIX);
    let kv: Arc<dyn RelayKvStore> =
        Arc::new(RocksDbKvStore::open(std::path::PathBuf::from(name)).unwrap());
    let objects: Arc<dyn ObjectStore> = Arc::new(LocalFsObjectStore::new(
        crate::registry::Registry::local_large_values_path(registry_db),
    ));
    let store = Store::open(kv.clone(), objects, NETWORK, policy(), true, "reset")
        .unwrap()
        .unwrap();
    (kv, store)
}

pub(crate) fn state_key(hash: &[u8; 32]) -> Vec<u8> {
    key(STATES, hash)
}

#[test]
fn a_burn_set_counts_once_and_each_burn_pays_for_one_event() {
    let backend = Backend::new();
    let store = backend.open();
    let post = observation(0, None, false);
    let target = *post.event.target_hash();
    publish(&store, &post, 1, at(100));
    // A vote paid by three burns from two accounts, one stacking a nonce.
    let vote = observation_of(&event_frame(
        &[(4, 0, 10), (5, 0, 20), (4, 1, 30)],
        Some(target),
        false,
        "test.topic",
        "title",
    ));
    assert_eq!(vote.checked.value_wei, 60);
    store.admit(vote.clone()).unwrap();
    assert_eq!(
        post_of(&store, &target).unwrap().reserved_up,
        Magnitude::from_u64(60)
    );
    // A set confirmed only in part stays pending: nothing is counted and nothing is refused.
    // Included out of order: the lead at (2, 7), the second burn at (3, 1), the third at (2, 9).
    let mut all = facts(&vote, 2, 0);
    for (fact, (block, index)) in all.iter_mut().zip([(2, 7), (3, 1), (2, 9)]) {
        fact.block_number = block;
        fact.transaction_index = index;
    }
    assert!(matches!(
        store.confirm(&vote, &all[..1], at(200)),
        Err(ForumError::Unavailable)
    ));
    let retained = store
        .read(|tx| Store::retained(tx, &vote))
        .unwrap()
        .unwrap();
    assert!(retained.confirmed.is_none());
    assert_eq!(
        post_of(&store, &target).unwrap().aggregate.magnitude,
        Magnitude::from_u64(7)
    );
    // Every burn confirmed: the set's total is counted once, at the set's inclusion watermark
    // (the latest burn's position, not the lead's or the last listed).
    let confirmed = store.confirm(&vote, &all, at(300)).unwrap();
    assert_eq!(
        confirmed.confirmed.map(|(block, index, _)| (block, index)),
        Some((3, 1))
    );
    store.confirm(&vote, &all, at(400)).unwrap();
    assert_eq!(
        store.admit(vote.clone()).unwrap().confirmed,
        confirmed.confirmed
    );
    let counted = post_of(&store, &target).unwrap();
    assert_eq!(counted.aggregate.magnitude, Magnitude::from_u64(67));
    assert_eq!(counted.reserved_up, Magnitude::default());
    assert_eq!(store.pending_accounting().unwrap(), (0, 0));
    // A burn of that set inside another event's set, as lead or as a later member, pays for
    // nothing more: refused before anything is broadcast.
    for reuse in [
        event_frame(
            &[(6, 0, 1), (5, 0, 20)],
            Some(target),
            false,
            "test.topic",
            "title",
        ),
        event_frame(
            &[(5, 0, 20), (6, 0, 1)],
            Some(target),
            false,
            "test.topic",
            "title",
        ),
        event_frame(&[(4, 0, 10)], Some(target), false, "test.topic", "title"),
    ] {
        assert!(matches!(
            store.admit(observation_of(&reuse)),
            Err(ForumError::Conflict)
        ));
    }
    assert_eq!(
        post_of(&store, &target).unwrap().aggregate.magnitude,
        Magnitude::from_u64(67)
    );
    assert_eq!(store.pending_accounting().unwrap(), (0, 0));
}
