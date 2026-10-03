use super::*;
use crate::monad_http::Address;

fn policy() -> TopicBurnPolicy {
    TopicBurnPolicy {
        expected_chain_id: 10143,
        burn_address: Address([0x44; 20]),
    }
}

pub(crate) fn observation(nonce: u64, target: Option<[u8; 32]>, down: bool) -> Observation {
    observation_with_amount(nonce,target,down,7)
}

pub(crate) fn observation_with_amount(nonce: u64, target: Option<[u8;32]>, down: bool, amount:u128) -> Observation {
    use bitcoinsuite_core::ecc::Ecc;
    use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
    use frank_cbor::{encode_forum_post, encode_frame, EnvelopeFields, ForumEntry, FramePayload};
    let post = encode_forum_post(
        "monad-testnet",
        "test.topic",
        None,
        &Timestamp {
            seconds: 1,
            nanoseconds: 0,
        },
        &[ForumEntry::Post {
            title: Some("title".into()),
            url: None,
            message: Some("body".into()),
            unknown: vec![],
        }],
    )
    .unwrap();
    let make = |raw: Vec<u8>| {
        let (kind, item) = match target {
            Some(hash) => (11, CborValue::Bytes(hash.to_vec())),
            None => (10, CborValue::Bytes(post.clone())),
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
                (2, CborValue::Bytes(raw)),
            ])),
        )
        .unwrap()
    };
    let preliminary = parse_topic_event(&make(vec![1]), "monad-testnet").unwrap();
    let mut calldata = b"TPIC".to_vec();
    calldata.extend([2, if down { 0 } else { 1 }]);
    calldata.extend(preliminary.commitment());
    let secret = EccSecp256k1::default().seckey_from_array([3; 32]).unwrap();
    let (raw, _) = crate::monad_evm_tx::test_support::signed_eip1559_tx(
        &secret,
        10143,
        nonce,
        policy().burn_address,
        amount,
        &calldata,
    );
    let event = parse_topic_event(&make(raw), "monad-testnet").unwrap();
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

pub(crate) fn facts(op: &Observation, block: u64, index: u64) -> VerifiedTopicBurn {
    VerifiedTopicBurn {
        sender: op.checked.decoded.sender,
        tx_hash: op.checked.decoded.tx_hash,
        value_wei: op.checked.decoded.value_wei,
        direction: op.checked.direction,
        block_number: block,
        transaction_index: index,
    }
}

#[test]
fn exact_pending_survives_restart_and_publication_is_once_only() {
    let root = tempdir::TempDir::new("forum-restart").unwrap();
    let legacy = root.path().join("db.rocksdb");
    let original = observation(0, None, false);
    let hash = original.checked.decoded.tx_hash.0;
    let target = *original.event.target_hash();
    let mut store = Store::open(&legacy, "monad-testnet", policy()).unwrap();
    store.admit(original.clone()).unwrap();
    assert_eq!(store.pending_count, 1);
    drop(store);
    let mut store = Store::open(&legacy, "monad-testnet", policy()).unwrap();
    assert_eq!(
        store.operation(&hash).unwrap().unwrap().frame(),
        original.frame()
    );
    assert!(store.post(&target).unwrap().unwrap().visible.is_none());
    let at = Timestamp {
        seconds: 200,
        nanoseconds: 3,
    };
    store.confirm(&hash, &facts(&original, 10, 0), at).unwrap();
    store
        .confirm(
            &hash,
            &facts(&original, 10, 0),
            Timestamp {
                seconds: 300,
                nanoseconds: 0,
            },
        )
        .unwrap();
    assert_eq!(store.pending_count, 0);
    assert_eq!(store.pending_bytes, 0);
    let post = store.post(&target).unwrap().unwrap();
    assert_eq!(post.visible, Some(at));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(7));
    let second = observation(1, None, false);
    let second_hash = second.checked.decoded.tx_hash.0;
    store.admit(second.clone()).unwrap();
    store
        .confirm(
            &second_hash,
            &facts(&second, 0, 0),
            Timestamp {
                seconds: 50,
                nanoseconds: 0,
            },
        )
        .unwrap();
    let post = store.post(&target).unwrap().unwrap();
    assert_eq!(post.visible, Some(at));
    assert_eq!(post.author, Some(second_hash));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(14));
    let vote = observation(2, Some(target), true);
    store.admit(vote.clone()).unwrap();
    store
        .confirm(
            &vote.checked.decoded.tx_hash.0,
            &facts(&vote, u64::MAX, u64::MAX),
            at,
        )
        .unwrap();
    drop(store);
    let store = Store::open(&legacy, "monad-testnet", policy()).unwrap();
    let post = store.post(&target).unwrap().unwrap();
    assert_eq!(post.visible, Some(at));
    assert_eq!(post.author, Some(second_hash));
    assert_eq!(post.aggregate.magnitude, Magnitude::from_u64(7));
    let mut topics = vec![];
    store
        .visit_topics(|topic, count, last| {
            topics.push((topic, count, last));
            Ok(())
        })
        .unwrap();
    assert_eq!(topics, vec![("test.topic".into(), 1, at)]);
}

#[test]
fn exact_retry_at_capacity_and_conflicting_wrapper_preserve_authority() {
    let root = tempdir::TempDir::new("forum-capacity").unwrap();
    let legacy = root.path().join("db.rocksdb");
    let original = observation(0, None, false);
    let mut store = Store::open(&legacy, "monad-testnet", policy()).unwrap();
    store.admit(original.clone()).unwrap();
    store.pending_count = 4096;
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
            type_id: 10,
            schema_version: 2,
            min_reader_version: 1,
        },
        frank_cbor::FramePayload::Value(&cbor_map(vec![
            (0, CborValue::Text("monad-testnet".into())),
            (1, CborValue::Bytes(post.post_frame.clone())),
            (2, CborValue::Bytes(post.burn_tx.clone())),
            (99, CborValue::Bytes(vec![42])),
        ])),
    )
    .unwrap();
    let mut conflict = original.clone();
    conflict.event = parse_topic_event(&changed, "monad-testnet").unwrap();
    assert!(matches!(store.admit(conflict), Err(ForumError::Conflict)));
    assert_eq!(
        store
            .operation(&original.checked.decoded.tx_hash.0)
            .unwrap()
            .unwrap()
            .frame(),
        original.frame()
    );
}

#[test]
fn crash_boundaries_reopen_only_durable_authority_without_partial_publication() {
    for after in [false,true] {
        let root=tempdir::TempDir::new("forum-admission-crash").unwrap();
        let legacy=root.path().join("db.rocksdb");
        let op=observation(0,None,false); let hash=op.checked.decoded.tx_hash.0;
        let mut store=Store::open(&legacy,"monad-testnet",policy()).unwrap();
        store.fail_write.set(if after {2}else{1});
        assert!(store.admit(op.clone()).is_err()); drop(store);
        let mut store=Store::open(&legacy,"monad-testnet",policy()).unwrap();
        assert_eq!(store.operation(&hash).unwrap().is_some(),after);
        store.admit(op.clone()).unwrap();
        store.fail_write.set(if after {2}else{1});
        assert!(store.confirm(&hash,&facts(&op,1,0),Timestamp {seconds:200,nanoseconds:0}).is_err()); drop(store);
        let mut store=Store::open(&legacy,"monad-testnet",policy()).unwrap();
        assert_eq!(store.operation(&hash).unwrap().unwrap().confirmed.is_some(),after);
        assert_eq!(store.post(op.event.target_hash()).unwrap().unwrap().visible.is_some(),after);
        store.confirm(&hash,&facts(&op,1,0),Timestamp {seconds:200,nanoseconds:0}).unwrap();
        assert_eq!(store.post(op.event.target_hash()).unwrap().unwrap().aggregate.magnitude,Magnitude::from_u64(7));
    }
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
fn sidecar_is_sibling_and_policy_changes_never_rewrite_it() {
    let root = tempdir::TempDir::new("forum-private-store").unwrap();
    let legacy = root.path().join("db.rocksdb");
    let db = crate::store::db::Db::open(&legacy).unwrap();
    let path = Store::path(&legacy).unwrap();
    assert_eq!(path, root.path().join("db.rocksdb.forum-cbor-v1"));
    assert!(!path.exists());
    let before = rocksdb::DB::list_cf(&Options::default(), &legacy).unwrap();
    drop(db);
    drop(Store::open(&legacy, "monad-testnet", policy()).unwrap());
    let different = TopicBurnPolicy {
        burn_address: Address([0x55; 20]),
        ..policy()
    };
    assert!(Store::open(&legacy, "monad-testnet", different).is_err());
    drop(Store::open(&legacy, "monad-testnet", policy()).unwrap());
    // A useful local inventory assertion; the actual predecessor executable gate
    // remains separate and is not substituted by this candidate opener.
    drop(crate::store::db::Db::open(&legacy).unwrap());
    assert_eq!(
        before,
        rocksdb::DB::list_cf(&Options::default(), &legacy).unwrap()
    );
}

#[test]
fn corrupt_authority_fails_closed_without_reset() {
    let root = tempdir::TempDir::new("forum-corrupt-authority").unwrap();
    let legacy = root.path().join("db.rocksdb");
    let store = Store::open(&legacy, "monad-testnet", policy()).unwrap();
    let mut batch = WriteBatch::default();
    batch.put(key(b'e', &[3; 32]), [0xa0]);
    store.write(batch).unwrap();
    drop(store);
    assert!(Store::open(&legacy, "monad-testnet", policy()).is_err());
    let db = rocksdb::DB::open_default(Store::path(&legacy).unwrap()).unwrap();
    assert_eq!(db.get(key(b'e', &[3; 32])).unwrap().unwrap(), vec![0xa0]);
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
