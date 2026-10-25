//! Subject rows, indexes, counters and forwards in the directory store.
use super::*;
use crate::directory_admission::{CheckpointKind, Status, Timestamp};
use crate::store::{
    db::Db,
    directory_store::{DirectoryBackend, Owner, ROCKSDB_STORE},
    kv_store::RocksDbKvStore,
    large_values::LocalFsObjectStore,
};
use bitcoinsuite_error::Result;

const NETWORK: &str = "monad-testnet";

fn checkpoint(accepted: usize, checked: i64) -> Checkpoint {
    Checkpoint {
        kind: CheckpointKind::CommittedPrefix,
        identity: [2; 32],
        anchor: [1; 32],
        head: Some([3; 32]),
        accepted,
        retained: accepted,
        evidence_digest: [4; 32],
        checked_time: (checked, 0),
        forked: false,
    }
}
fn status(checkpoint: Checkpoint) -> Status {
    Status {
        checkpoint,
        head: checkpoint.head,
        revision: Some(0),
        generations: Some([0, 0]),
        current_stamp: None,
        previous_stamp: None,
        accepted: checkpoint.accepted,
        retained: checkpoint.retained,
        charged_bytes: 1,
        forked: false,
        checked_time: Timestamp {
            seconds: checkpoint.checked_time.0,
            nanoseconds: 0,
        },
    }
}
fn subject_row(checkpoint: Checkpoint, local: bool) -> SubjectRow {
    SubjectRow {
        version: 1,
        anchor: [1; 32],
        checkpoint,
        local,
    }
}
fn enrollment(address: [u8; 20], accepted_ms: u64, local: bool, budget: u64) -> Enrollment {
    Enrollment {
        address,
        accepted_ms,
        anchor: [1; 32],
        local,
        budget,
    }
}
/// Run the recorder in its own transaction, as a commit would.
fn commit(
    rows: &DbDirectorySubjects,
    network: &str,
    subject: &[u8],
    enrollment: Option<&Enrollment>,
    first: bool,
    checkpoint: Checkpoint,
) -> std::result::Result<(), RecordError> {
    let status = status(checkpoint);
    rows.store.kv().transact(|tx| {
        record(
            enrollment,
            network,
            subject,
            tx,
            &Commit {
                first,
                status: &status,
            },
        )
    })
}
fn forward_row() -> ForwardRow {
    ForwardRow {
        endpoint: "https://example.test/".into(),
        content_type: "application/cbor".into(),
        sender: "subject".into(),
        network: NETWORK.into(),
        created_ms: 1,
        attempts: 0,
        next_ms: 2,
        done: false,
        status: 0,
        response: String::new(),
        echo: serde_json::json!({"identity": "retained"}),
        claim: None,
    }
}
fn shared() -> (Arc<RocksDbKvStore>, Arc<LocalFsObjectStore>) {
    (
        Arc::new(RocksDbKvStore::open_temporary().unwrap()),
        Arc::new(LocalFsObjectStore::temporary()),
    )
}
/// One replica's view of a store every replica shares.
fn replica(kv: &Arc<RocksDbKvStore>, objects: &Arc<LocalFsObjectStore>) -> DbDirectorySubjects {
    let owner = Owner::new(
        DirectoryBackend::Shared(kv.clone()),
        objects.clone() as Arc<dyn crate::store::large_values::ObjectStore>,
    );
    DbDirectorySubjects::new(owner.open(true).unwrap())
}
fn raw(rows: &DbDirectorySubjects, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    rows.store
        .kv()
        .transact(|tx| tx.scan_prefix(prefix, None, 1000))
        .unwrap()
}
// The persisted layout, spelled independently of the production key helpers.
fn persisted(table: &[u8], network: &str, tail: &[u8]) -> Vec<u8> {
    let mut bytes = table.to_vec();
    bytes.push(u8::try_from(network.len()).unwrap());
    bytes.extend_from_slice(network.as_bytes());
    bytes.extend_from_slice(tail);
    bytes
}
fn persisted_position(ms: u64, address: &[u8; 20]) -> [u8; 28] {
    let mut bytes = [0; 28];
    bytes[..8].copy_from_slice(&ms.to_be_bytes());
    bytes[8..].copy_from_slice(address);
    bytes
}

#[test]
fn the_store_is_lazy_and_concurrent_first_access_shares_one_handle() -> Result<()> {
    let dir = tempdir::TempDir::new("subjects-owner-concurrent")?;
    let path = dir.path().join("registry");
    let db = Db::open(&path)?;
    assert!(!path.join(ROCKSDB_STORE).exists());
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let (db, barrier) = (&db, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    let rows = db.directory_subjects().unwrap();
                    commit(
                        &rows,
                        NETWORK,
                        &[i; 33],
                        Some(&enrollment([i; 20], i.into(), true, 100)),
                        true,
                        checkpoint(1, 1),
                    )
                    .unwrap();
                    Arc::as_ptr(&rows.store) as usize
                })
            })
            .collect();
        let handles: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(handles.iter().all(|h| *h == handles[0]));
    });
    assert_eq!(db.directory_subjects()?.counts()?, (8, 0));
    drop(db);
    assert_eq!(Db::open(&path)?.directory_subjects()?.counts()?, (8, 0));
    Ok(())
}

#[cfg(unix)]
#[test]
fn the_registry_path_is_resolved_on_first_access_and_a_failed_open_is_retried() -> Result<()> {
    let dir = tempdir::TempDir::new("subjects-owner-path")?;
    let actual = dir.path().join("actual-registry");
    std::fs::create_dir(&actual)?;
    let link = dir.path().join("registry-link");
    std::os::unix::fs::symlink(&actual, &link)?;
    let mut db = Db::open(&link)?;
    db.set_directory_backend(
        DirectoryBackend::RocksDbInside(link.clone()),
        Arc::new(LocalFsObjectStore::temporary()),
    );
    std::fs::remove_file(&link)?;
    assert!(db.directory_subjects().is_err());
    assert!(!actual.join(ROCKSDB_STORE).exists());
    std::os::unix::fs::symlink(&actual, &link)?;
    assert_eq!(db.directory_subjects()?.counts()?, (0, 0));
    assert!(actual.join(ROCKSDB_STORE).is_dir());
    Ok(())
}

#[test]
fn a_failed_open_retries_without_resetting_existing_data() -> Result<()> {
    let dir = tempdir::TempDir::new("subjects-owner-retry")?;
    let path = dir.path().join("registry");
    let store = path.join(ROCKSDB_STORE);
    {
        let db = Db::open(&path)?;
        let rows = db.directory_subjects()?;
        commit(
            &rows,
            NETWORK,
            &[5; 33],
            Some(&enrollment([6; 20], 9, true, 10)),
            true,
            checkpoint(1, 1),
        )
        .unwrap();
    }
    let db = Db::open(&path)?;
    let retained = path.join("retained-store");
    std::fs::rename(&store, &retained)?;
    std::fs::write(&store, b"obstruction")?;
    assert!(db.directory_subjects().is_err());
    assert!(db.directory_subjects().is_err());
    assert_eq!(std::fs::read(&store)?, b"obstruction");
    std::fs::remove_file(&store)?;
    // An empty directory is an interrupted creation or a loss: never created into.
    std::fs::create_dir(&store)?;
    assert!(db.directory_subjects().is_err());
    assert_eq!(std::fs::read_dir(&store)?.count(), 0);
    std::fs::remove_dir(&store)?;
    std::fs::rename(&retained, &store)?;
    let rows = db.directory_subjects()?;
    assert_eq!(
        rows.get(NETWORK, &[5; 33])?,
        Some(subject_row(checkpoint(1, 1), true))
    );
    assert_eq!(
        rows.subject_for_address(NETWORK, &[6; 20])?,
        Some(vec![5; 33])
    );
    Ok(())
}

#[test]
fn earlier_directory_sidecars_stop_startup_with_the_reset_path() -> Result<()> {
    for sidecar in crate::store::directory_store::OLD_SIDECARS {
        let dir = tempdir::TempDir::new("subjects-old-sidecar")?;
        let path = dir.path().join("registry");
        drop(Db::open(&path)?);
        std::fs::create_dir(path.join(sidecar))?;
        let error = format!("{:?}", Db::open(&path).unwrap_err());
        assert!(error.contains("earlier directory stores"), "{error}");
        assert!(error.contains(sidecar), "{error}");
        assert!(
            path.join(sidecar).is_dir(),
            "nothing is deleted for the operator"
        );
    }
    Ok(())
}

#[test]
fn enrollment_writes_row_indexes_and_counter_in_the_commit_and_isolates_networks() -> Result<()> {
    let dir = tempdir::TempDir::new("subjects-network-pages")?;
    let path = dir.path().join("registry");
    let networks = ["monad-testnet", "solana-devnet", "btc-testnet"];
    {
        let db = Db::open(&path)?;
        let rows = db.directory_subjects()?;
        for (i, network) in networks.iter().enumerate() {
            let local = i == 0;
            commit(
                &rows,
                network,
                &[2; 33],
                Some(&enrollment([2; 20], 256, local, 10)),
                true,
                checkpoint(1, 1),
            )
            .unwrap();
            assert_eq!(
                rows.get(network, &[2; 33])?,
                Some(subject_row(checkpoint(1, 1), local))
            );
            assert_eq!(
                rows.subject_for_address(network, &[2; 20])?,
                Some(vec![2; 33])
            );
        }
        for (subject, address, ms) in [(3u8, 1u8, 256u64), (1, 3, 255)] {
            commit(
                &rows,
                networks[0],
                &[subject; 33],
                Some(&enrollment([address; 20], ms, true, 10)),
                true,
                checkpoint(1, 1),
            )
            .unwrap();
        }
        // A continuity update changes neither index, position nor counter.
        commit(&rows, networks[0], &[2; 33], None, false, checkpoint(2, 2)).unwrap();
        assert_eq!(rows.counts()?, (3, 2));
        assert_eq!(
            rows.list(networks[0], None, 1)?,
            vec![(vec![1; 33], subject_row(checkpoint(1, 1), true))]
        );
        assert_eq!(
            rows.list(networks[0], Some(&[1; 33]), 1)?,
            vec![(vec![2; 33], subject_row(checkpoint(2, 2), true))]
        );
        assert_eq!(
            rows.list(networks[0], Some(&[2; 33]), 10)?,
            vec![(vec![3; 33], subject_row(checkpoint(1, 1), true))]
        );
        assert!(rows.list(networks[0], Some(&[3; 33]), 10)?.is_empty());
        let first = persisted_position(255, &[3; 20]);
        let second = persisted_position(256, &[1; 20]);
        let third = persisted_position(256, &[2; 20]);
        assert_eq!(
            rows.first_accepted(networks[0], &[0; 28], 2)?,
            vec![(first, 255, [3; 20]), (second, 256, [1; 20])]
        );
        assert_eq!(
            rows.first_accepted(networks[0], &second, 1)?,
            vec![(third, 256, [2; 20])]
        );
        assert!(rows.first_accepted(networks[0], &third, 10)?.is_empty());
        assert!(rows.first_accepted(networks[0], &[0; 28], 0)?.is_empty());
    }
    let db = Db::open(&path)?;
    let rows = db.directory_subjects()?;
    assert_eq!(rows.counts()?, (3, 2));
    for network in &networks[1..] {
        assert_eq!(
            rows.subject_for_address(network, &[2; 20])?,
            Some(vec![2; 33])
        );
        assert_eq!(rows.list(network, None, 10)?.len(), 1);
        assert_eq!(
            rows.first_accepted(network, &[0; 28], 10)?,
            vec![(persisted_position(256, &[2; 20]), 256, [2; 20])]
        );
    }
    Ok(())
}

#[test]
fn a_later_checked_time_alone_does_not_rewrite_the_row() {
    let (kv, objects) = shared();
    let rows = replica(&kv, &objects);
    commit(
        &rows,
        NETWORK,
        &[2; 33],
        Some(&enrollment([2; 20], 1, true, 10)),
        true,
        checkpoint(1, 1),
    )
    .unwrap();
    commit(&rows, NETWORK, &[2; 33], None, false, checkpoint(1, 99)).unwrap();
    assert_eq!(
        rows.get(NETWORK, &[2; 33]).unwrap().unwrap().checkpoint,
        checkpoint(1, 1)
    );
    // A later commit of a subject whose row is missing is refused, not silently re-created.
    assert!(matches!(
        commit(&rows, NETWORK, &[9; 33], None, false, checkpoint(1, 1)),
        Err(RecordError::Refused(AdmissionError::Unavailable))
    ));
    // And a first commit without an enrollment publishes nothing.
    assert!(matches!(
        commit(&rows, NETWORK, &[9; 33], None, true, checkpoint(1, 1)),
        Err(RecordError::Refused(AdmissionError::Unavailable))
    ));
    assert!(rows.get(NETWORK, &[9; 33]).unwrap().is_none());
}

#[test]
fn the_subject_caps_hold_exactly_across_replicas_enrolling_at_once() {
    let (kv, objects) = shared();
    let replicas: Vec<_> = (0..4).map(|_| replica(&kv, &objects)).collect();
    let barrier = std::sync::Barrier::new(32);
    let accepted: usize = std::thread::scope(|scope| {
        (0..32u8)
            .map(|i| {
                let (rows, barrier) = (&replicas[usize::from(i) % 4], &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    // Half are local accounts with a budget of 5, half copies with a budget of 3.
                    let local = i % 2 == 0;
                    let budget = if local { 5 } else { 3 };
                    match commit(
                        rows,
                        NETWORK,
                        &[i; 33],
                        Some(&enrollment([i; 20], u64::from(i) + 1, local, budget)),
                        true,
                        checkpoint(1, 1),
                    ) {
                        Ok(()) => 1,
                        Err(RecordError::Refused(AdmissionError::Resource)) => 0,
                        Err(other) => panic!("{other:?}"),
                    }
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum()
    });
    assert_eq!(accepted, 8);
    assert_eq!(replicas[3].counts().unwrap(), (5, 3));
    assert_eq!(replicas[0].list(NETWORK, None, 100).unwrap().len(), 8);
    // A refused enrollment left no row, address or position behind.
    assert_eq!(
        replicas[1]
            .first_accepted(NETWORK, &[0; 28], 100)
            .unwrap()
            .len(),
        8
    );
    assert_eq!(raw(&replicas[2], ADDRESSES).len(), 8);
}

#[test]
fn the_persisted_layout_is_pinned_and_forward_bodies_live_inline_or_in_objects() -> Result<()> {
    let dir = tempdir::TempDir::new("subjects-frozen-layout")?;
    let path = dir.path().join("registry");
    let identity = [9; 32];
    let mut forward = forward_row();
    let array = |n: u8| vec![n.to_string(); 32].join(",");
    let subject_bytes = format!(
        "{{\"version\":1,\"anchor\":[{a}],\"checkpoint\":{{\"kind\":\"CommittedPrefix\",\"identity\":[{i}],\"anchor\":[{a}],\"head\":[{h}],\"accepted\":1,\"retained\":1,\"evidence_digest\":[{e}],\"checked_time\":[1,0],\"forked\":false}},\"local\":true}}",
        a = array(1), i = array(2), h = array(3), e = array(4),
    ).into_bytes();
    let forward_bytes = br#"{"endpoint":"https://example.test/","content_type":"application/cbor","sender":"subject","network":"monad-testnet","created_ms":1,"attempts":1,"next_ms":123,"done":false,"status":0,"response":"","echo":{"identity":"retained"},"claim":null}"#.to_vec();
    let db = Db::open(&path)?;
    let rows = db.directory_subjects()?;
    commit(
        &rows,
        NETWORK,
        &[5; 33],
        Some(&enrollment([6; 20], 0x0102, true, 10)),
        true,
        checkpoint(1, 1),
    )
    .unwrap();
    rows.put_forward(&identity, &forward, Some(b"\x00exact\xffrequest"))?;
    forward.attempts = 1;
    forward.next_ms = 123;
    rows.put_forward(&identity, &forward, None)?;
    assert_eq!(
        raw(&rows, b"s/r/"),
        vec![(persisted(b"s/r/", NETWORK, &[5; 33]), subject_bytes)]
    );
    assert_eq!(
        raw(&rows, b"s/a/"),
        vec![(persisted(b"s/a/", NETWORK, &[6; 20]), vec![5; 33])]
    );
    assert_eq!(
        raw(&rows, b"s/f/"),
        vec![(
            persisted(b"s/f/", NETWORK, &persisted_position(0x0102, &[6; 20])),
            vec![]
        )]
    );
    assert_eq!(
        raw(&rows, b"s/n/"),
        vec![(b"s/n/local".to_vec(), 1u64.to_le_bytes().to_vec())]
    );
    assert_eq!(
        raw(&rows, b"f/r/"),
        vec![([&b"f/r/"[..], &identity].concat(), forward_bytes)]
    );
    // Tag 0: the exact bytes inline.
    assert_eq!(
        raw(&rows, b"f/b/"),
        vec![(
            [&b"f/b/"[..], &identity].concat(),
            b"\x00\x00exact\xffrequest".to_vec()
        )]
    );
    // A body over the inline limit is an object; the row holds tag 1, digest and length.
    let large = vec![7u8; INLINE_LIMIT + 1];
    let other = [8; 32];
    rows.put_forward(&other, &forward_row(), Some(&large))?;
    let stored = raw(&rows, &[&b"f/b/"[..], &other].concat());
    let digest: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(&large).into();
    // Tag 1, the SHA-256, the big-endian length, then the 16-byte upload id of this upload.
    assert_eq!(stored[0].1.len(), 1 + 32 + 8 + 16);
    assert_eq!(
        stored[0].1[..41],
        [&[1u8][..], &digest, &(large.len() as u64).to_be_bytes()].concat()[..]
    );
    let upload: [u8; 16] = stored[0].1[41..].try_into().unwrap();
    let object = rows
        .store
        .large()
        .object_key(&crate::store::large_values::LargeValueRef {
            digest,
            len: large.len() as u64,
            upload,
        });
    assert_eq!(
        object,
        format!(
            "directory/sha256/{}/{}",
            hex::encode(digest),
            hex::encode(upload)
        )
    );
    assert_eq!(
        rows.store.large().objects().get(&object).unwrap(),
        Some(large.clone())
    );
    assert_eq!(rows.forward_body(&other)?, Some(large));
    // A final answer drops the body and its reference, so the object becomes collectable.
    let mut done = forward_row();
    done.done = true;
    done.status = 200;
    rows.put_forward(&other, &done, None)?;
    assert_eq!(rows.forward_body(&other)?, None);
    let report = rows.store.sweep_large_values([1; 16]).unwrap();
    assert_eq!(report.deleted, 1);
    drop(rows);
    drop(db);

    let db = Db::open(&path)?;
    let rows = db.directory_subjects()?;
    assert_eq!(rows.forward(&identity)?, Some(forward.clone()));
    assert_eq!(
        rows.forward_body(&identity)?,
        Some(b"\x00exact\xffrequest".to_vec())
    );
    forward.done = true;
    forward.status = 202;
    forward.response = "accepted".into();
    rows.put_forward(&identity, &forward, Some(b"must not survive completion"))?;
    assert_eq!(rows.forward_body(&identity)?, None);
    assert!(raw(&rows, b"f/b/").is_empty());
    rows.delete_forward(&identity)?;
    rows.delete_forward(&other)?;
    assert!(rows.forwards()?.is_empty());
    Ok(())
}

#[test]
fn invalid_rows_keep_the_filter_stop_and_error_behaviour() {
    let (kv, objects) = shared();
    let rows = replica(&kv, &objects);
    commit(
        &rows,
        NETWORK,
        &[2; 33],
        Some(&enrollment([2; 20], 1, true, 10)),
        true,
        checkpoint(1, 1),
    )
    .unwrap();
    let put = |key: Vec<u8>, value: &[u8]| {
        rows.store.kv().transact(|tx| tx.set(&key, value)).unwrap();
    };
    // An address index value that is not a point is not a subject.
    put(persisted(b"s/a/", NETWORK, &[1; 20]), &[1; 32]);
    // A malformed subject key sorts before the valid row and stops this network's scan.
    put(persisted(b"s/r/", NETWORK, &[1; 32]), b"not json");
    // Forward iteration skips invalid identity lengths without decoding their value.
    put([&b"f/r/"[..], &[1; 31]].concat(), b"not json");
    assert_eq!(rows.subject_for_address(NETWORK, &[1; 20]).unwrap(), None);
    assert!(rows.list(NETWORK, None, 10).unwrap().is_empty());
    assert!(rows.forwards().unwrap().is_empty());
    assert!(rows.get(NETWORK, &[1; 32]).is_err());
    put([&b"f/r/"[..], &[2; 32]].concat(), b"not json");
    assert!(rows.forward(&[2; 32]).is_err());
    assert!(rows.forwards().is_err());
    assert!(rows.claim_forward(&[2; 32], &[1; 16], 1000).is_err());
}

#[test]
fn a_forward_is_claimed_by_one_replica_and_taken_over_once_its_claim_expires() {
    let (kv, objects) = shared();
    let (a, b) = (replica(&kv, &objects), replica(&kv, &objects));
    let identity = [4; 32];
    assert_eq!(
        a.claim_forward(&identity, &[0xa; 16], 60_000).unwrap(),
        ForwardClaimed::Missing
    );
    a.put_forward(&identity, &forward_row(), Some(b"request"))
        .unwrap();
    let ForwardClaimed::Claimed(mut attempt) =
        a.claim_forward(&identity, &[0xa; 16], 60_000).unwrap()
    else {
        panic!("first claim");
    };
    // B sees A's live claim and must not send.
    assert!(matches!(
        b.claim_forward(&identity, &[0xb; 16], 60_000).unwrap(),
        ForwardClaimed::Held(_)
    ));
    // Only the claimer records the outcome.
    attempt.attempts = 1;
    assert!(!b.finish_forward(&identity, &[0xb; 16], &attempt).unwrap());
    assert_eq!(b.forward(&identity).unwrap().unwrap().attempts, 0);
    assert!(a.finish_forward(&identity, &[0xa; 16], &attempt).unwrap());
    let stored = b.forward(&identity).unwrap().unwrap();
    assert_eq!((stored.attempts, stored.claim), (1, None));
    // A claim that expires (its holder died) is taken over, and the dead holder's late write
    // is refused.
    assert!(matches!(
        a.claim_forward(&identity, &[0xa; 16], 0).unwrap(),
        ForwardClaimed::Claimed(_)
    ));
    let ForwardClaimed::Claimed(mut takeover) =
        b.claim_forward(&identity, &[0xb; 16], 60_000).unwrap()
    else {
        panic!("takeover");
    };
    assert!(!a.finish_forward(&identity, &[0xa; 16], &attempt).unwrap());
    takeover.done = true;
    takeover.status = 200;
    takeover.response = "delivered".into();
    assert!(b.finish_forward(&identity, &[0xb; 16], &takeover).unwrap());
    assert_eq!(a.forward_body(&identity).unwrap(), None);
    // Once done, every replica repeats the answer and nobody sends again.
    for (rows, holder) in [(&a, [0xa; 16]), (&b, [0xb; 16])] {
        let ForwardClaimed::Done(row) = rows.claim_forward(&identity, &holder, 60_000).unwrap()
        else {
            panic!("done");
        };
        assert_eq!((row.status, row.response.as_str()), (200, "delivered"));
    }
}

#[test]
fn concurrent_claims_of_one_forward_have_exactly_one_winner() {
    let (kv, objects) = shared();
    let replicas: Vec<_> = (0..8).map(|_| replica(&kv, &objects)).collect();
    let identity = [6; 32];
    replicas[0]
        .put_forward(&identity, &forward_row(), Some(b"request"))
        .unwrap();
    let barrier = std::sync::Barrier::new(8);
    let winners: usize = std::thread::scope(|scope| {
        replicas
            .iter()
            .enumerate()
            .map(|(i, rows)| {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    let holder = [i as u8 + 1; 16];
                    usize::from(matches!(
                        rows.claim_forward(&identity, &holder, 60_000).unwrap(),
                        ForwardClaimed::Claimed(_)
                    ))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum()
    });
    assert_eq!(winners, 1);
}

#[test]
fn the_typed_facade_has_no_native_storage_access() {
    let source = include_str!("directory_subjects.rs");
    let facade = source
        .split("#[path = \"directory_subjects_tests.rs\"]")
        .next()
        .unwrap();
    for native in [
        "rocksdb::",
        "WriteBatch",
        "IteratorMode",
        "ColumnFamily",
        "cf_handle(",
    ] {
        assert!(
            !facade.contains(native),
            "native persistence escaped the transaction contract: {native}"
        );
    }
    let db = include_str!("db.rs");
    assert!(db.contains("directory: super::directory_store::Owner"));
    assert!(!db.contains("directory_preview_owner"));
}
