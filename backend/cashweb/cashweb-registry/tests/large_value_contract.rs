//! Group ciphertext over 64 KiB in a real S3 (MinIO), referenced from a real FoundationDB.
//!
//! Every test here is a phase of `backend/labs/large-values-acceptance.sh`, which runs each one
//! in its own container (relay A and relay B are separate processes and machines) and stops
//! and restarts MinIO between phases. The phases share state only through the cluster: the
//! script passes one `FRANK_LAB_RUN_ID`, from which the group keys, the messages, the FDB
//! subspace and the bucket prefix are derived.
//!
//! Required environment: `FRANK_FDB_CLUSTER_FILE`, `FRANK_LAB_RUN_ID`, `FRANK_LAB_S3_ENDPOINT`,
//! `FRANK_LAB_S3_BUCKET`, `FRANK_S3_ACCESS_KEY_ID`, `FRANK_S3_SECRET_ACCESS_KEY`.
#![cfg(feature = "foundationdb")]

use std::{sync::Arc, time::Duration};

use cashweb_registry::store::{
    blob_store::S3BlobStoreConfig,
    foundationdb_driver::FoundationDbKvStore,
    groups::{
        derive_group_id, GroupAppendOutcome, GroupEpochFrame, GroupError, GroupMessageEnvelope,
        GroupStore, GroupWritePaymentFact,
    },
    kv_store::{KvError, RelayKvStore, Transact},
    large_values::{LargeValueError, ObjectStore, INLINE_LIMIT},
    s3_objects::S3ObjectStore,
};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};

const MIB: usize = 1024 * 1024;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn run_id() -> String {
    env("FRANK_LAB_RUN_ID")
}

fn derived(label: &str) -> [u8; 32] {
    Sha256::digest(format!("frank-large-value-lab:{}:{label}", run_id())).into()
}

fn keypair(label: &str) -> (SecretKey, [u8; 33]) {
    let secret = SecretKey::from_slice(&derived(label)).unwrap();
    let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret).serialize();
    (secret, public)
}

fn sign(secret: &SecretKey, digest: &[u8; 32]) -> String {
    let signature = Secp256k1::new().sign(&Message::from_slice(digest).unwrap(), secret);
    hex::encode(signature.serialize_compact())
}

/// Deterministic, incompressible-looking bytes for `label`.
fn content(label: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut block = derived(label);
    while out.len() < len {
        out.extend_from_slice(&block);
        block = Sha256::digest(block).into();
    }
    out.truncate(len);
    out
}

fn open_kv() -> Arc<FoundationDbKvStore> {
    let subspace = format!("frank-large-value-lab:{}:", run_id());
    Arc::new(FoundationDbKvStore::open(&env("FRANK_FDB_CLUSTER_FILE"), subspace).unwrap())
}

fn s3() -> Arc<S3ObjectStore> {
    Arc::new(
        S3ObjectStore::new(S3BlobStoreConfig {
            endpoint: env("FRANK_LAB_S3_ENDPOINT"),
            region: "us-east-1".into(),
            bucket: env("FRANK_LAB_S3_BUCKET"),
            prefix: format!("lab-{}", run_id()),
            access_key_id: env("FRANK_S3_ACCESS_KEY_ID"),
            secret_access_key: env("FRANK_S3_SECRET_ACCESS_KEY"),
            force_path_style: true,
        })
        .unwrap(),
    )
}

/// One relay's view: its own FDB client and its own S3 client.
fn relay(kv: &Arc<FoundationDbKvStore>, objects: &Arc<S3ObjectStore>) -> GroupStore {
    GroupStore::new(kv.clone(), objects.clone())
}

/// Append `envelope` as the HTTP layer does once it has verified the write's payment. This
/// contract is about where ciphertext lives, so the store is handed a payment fact (keyed by
/// the envelope's digest, so a retry of one envelope is the same payment) rather than a
/// transaction checked on a chain; the cluster lab pays for real.
fn put_message(
    store: &GroupStore,
    group_id: &str,
    envelope: GroupMessageEnvelope,
) -> Result<GroupAppendOutcome, GroupError> {
    let payment = GroupWritePaymentFact {
        network: "monad-regtest".into(),
        tx_hash: envelope.signing_digest()?,
        payer: [1; 20],
        payee: [2; 20],
        value_wei: 1,
    };
    store.put_paid_message(group_id, envelope, &payment)
}

fn group_id() -> String {
    hex::encode(derive_group_id(&keypair("root").1))
}

fn initial_epoch() -> GroupEpochFrame {
    let (root, root_public) = keypair("root");
    let mut frame = GroupEpochFrame {
        group_id: group_id(),
        group_pubkey: hex::encode(root_public),
        epoch: 0,
        prev_epoch_hash: "00".repeat(32),
        write_pubkey: hex::encode(keypair("write").1),
        read_token_hash: hex::encode(Sha256::digest(derived("read"))),
        encrypted_epoch_descriptor: hex::encode(b"lab roster"),
        admin_sig: String::new(),
        epoch_hash: String::new(),
    };
    frame.admin_sig = sign(&root, &frame.compute_epoch_hash().unwrap());
    frame
}

fn message(label: &str, len: usize) -> GroupMessageEnvelope {
    let mut envelope = GroupMessageEnvelope {
        group_id: group_id(),
        epoch: 0,
        nonce: hex::encode(&derived(label)[..24]),
        ciphertext: hex::encode(content(label, len)),
        write_sig: String::new(),
    };
    envelope.write_sig = sign(&keypair("write").0, &envelope.signing_digest().unwrap());
    envelope
}

fn sequence(kv: &FoundationDbKvStore) -> Option<u64> {
    let key = [b"G_seq:".as_slice(), &derive_group_id(&keypair("root").1)].concat();
    kv.transact(|tx| tx.get(&key))
        .unwrap()
        .map(|bytes| u64::from_be_bytes(bytes.try_into().unwrap()))
}

/// The object key of the committed reference to `bytes`.
fn referenced_key(store: &GroupStore, bytes: &[u8]) -> String {
    let values = store.large_values();
    let reference = values
        .references(10_000)
        .unwrap()
        .into_iter()
        .find(|reference| reference.matches(bytes))
        .expect("a committed reference to the content");
    values.object_key(&reference)
}

/// Run `body` with this process's FDB network booted.
fn with_fdb(body: impl FnOnce()) {
    // SAFETY: each phase is its own process; it owns the FDB network and drops every store
    // inside `body`, before the guard.
    let _network = unsafe { foundationdb::boot() };
    body();
}

/// Phase 1, on relay A: create the group, append a 1 MiB message and a small one.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn relay_a_appends_a_1_mib_message() {
    with_fdb(|| {
        let (kv, objects) = (open_kv(), s3());
        let store = relay(&kv, &objects);
        store.put_epoch(&group_id(), initial_epoch()).unwrap();
        let large = put_message(&store, &group_id(), message("large", MIB)).unwrap();
        assert!(large.appended);
        assert_eq!(large.message.server_seq, 1);
        let small = put_message(&store, &group_id(), message("small", 64)).unwrap();
        assert_eq!(small.message.server_seq, 2);
        assert!(objects
            .contains(&referenced_key(&store, &content("large", MIB)))
            .unwrap());
        eprintln!(
            "relay A appended a {MIB}-byte message as seq 1 in group {}",
            group_id()
        );
    });
}

/// Phase 2, on relay B: read the 1 MiB message back byte-exact.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn relay_b_reads_the_1_mib_message_byte_exact() {
    with_fdb(|| {
        let (kv, objects) = (open_kv(), s3());
        let messages = relay(&kv, &objects)
            .list_messages(&group_id(), 0, 10)
            .unwrap();
        assert_eq!(messages.len(), 2);
        let bytes = hex::decode(&messages[0].ciphertext).unwrap();
        assert_eq!(bytes.len(), MIB);
        assert!(bytes == content("large", MIB), "1 MiB ciphertext differs");
        assert_eq!(messages[0].write_sig, message("large", MIB).write_sig);
        assert_eq!(
            hex::decode(&messages[1].ciphertext).unwrap(),
            content("small", 64)
        );
        eprintln!("relay B read the {MIB}-byte message back byte-exact");
    });
}

/// Phase 3, with MinIO stopped: a large append fails closed and consumes no sequence; reads
/// that need no object still work.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn with_minio_stopped_a_large_append_fails_closed() {
    with_fdb(|| {
        let (kv, objects) = (open_kv(), s3());
        let store = relay(&kv, &objects);
        assert_eq!(sequence(&kv), Some(2));
        let result = put_message(
            &store,
            &group_id(),
            message("during-outage", 2 * INLINE_LIMIT),
        );
        assert!(
            matches!(
                &result,
                Err(GroupError::LargeValue(LargeValueError::Unavailable(_)))
            ),
            "{result:?}"
        );
        assert_eq!(
            sequence(&kv),
            Some(2),
            "a failed append consumed a sequence"
        );
        let after_large = store.list_messages(&group_id(), 1, 10).unwrap();
        assert_eq!(after_large.len(), 1);
        // A read that needs the stopped object store fails rather than returning a gap.
        assert!(matches!(
            store.list_messages(&group_id(), 0, 10),
            Err(GroupError::LargeValue(LargeValueError::Unavailable(_)))
        ));
        eprintln!("with MinIO stopped the append failed closed; sequence still 2");
    });
}

/// Phase 4, MinIO restarted: the same append now lands as the next sequence, read from a
/// fresh process.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn after_minio_restarts_the_append_lands_as_the_next_sequence() {
    with_fdb(|| {
        let (kv, objects) = (open_kv(), s3());
        let store = relay(&kv, &objects);
        let envelope = message("during-outage", 2 * INLINE_LIMIT);
        let receipt = put_message(&store, &group_id(), envelope.clone()).unwrap();
        assert!(receipt.appended);
        assert_eq!(receipt.message.server_seq, 3);
        let read = relay(&open_kv(), &s3())
            .list_messages(&group_id(), 2, 10)
            .unwrap();
        assert_eq!(read[0].ciphertext, envelope.ciphertext);
        eprintln!("after MinIO restarted the append landed as seq 3");
    });
}

/// Phase 5: an orphan is swept and a referenced object never is, including while two writer
/// threads race two sweeper threads (no lease exclusion) in this one process, with every
/// intent already expired.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn an_orphan_is_swept_and_a_referenced_object_never_is() {
    with_fdb(|| {
        let (kv, objects) = (open_kv(), s3());
        // Zero intent lifetime: the sweeper treats every unreferenced upload as dead at once.
        let store = relay(&kv, &objects).with_large_value_intent_ttl(Duration::ZERO);
        let orphan = store
            .large_values()
            .stage(&content("orphan", 3 * INLINE_LIMIT))
            .unwrap();
        let orphan_key = store.large_values().object_key(&orphan.reference);
        assert!(objects.contains(&orphan_key).unwrap());
        // A writer of already-referenced content that died before committing: its own upload.
        let twin = store.large_values().stage(&content("large", MIB)).unwrap();
        let twin_key = store.large_values().object_key(&twin.reference);
        let large_key = referenced_key(&store, &content("large", MIB));
        assert_ne!(twin_key, large_key);

        let report = store.sweep_large_values([1; 16]).unwrap();
        assert!(report.held_lease);
        // Deleted: the orphan and the unreferenced twin upload. Kept: the referenced 1 MiB
        // object. (Phase 3's append left no intent: with MinIO stopped its process could not
        // check the namespace claim, so it stopped before committing one.)
        assert_eq!(
            (report.deleted, report.kept_referenced),
            (2, 0),
            "{report:?}"
        );
        assert!(!objects.contains(&orphan_key).unwrap());
        assert!(!objects.contains(&twin_key).unwrap());
        assert!(objects.contains(&large_key).unwrap());

        // Two writer threads race two sweeper threads (two holders, no lease exclusion), all in
        // this one process, each with its own FDB-backed store handle and its own S3 client.
        let stop = std::sync::atomic::AtomicBool::new(false);
        let (appended, failed, deleted) = std::thread::scope(|scope| {
            // On any panic below, stop the sweeper so the scope can join every thread before
            // this phase drops the FDB network guard.
            let _stop_on_drop = StopOnDrop(&stop);
            let sweepers: Vec<_> = [[1; 16], [2; 16]]
                .into_iter()
                .map(|holder| {
                    let store = relay(&kv, &s3())
                        .with_large_value_intent_ttl(Duration::ZERO)
                        .with_large_value_lease_ttl(Duration::ZERO);
                    let stop = &stop;
                    scope.spawn(move || {
                        let mut deleted = 0;
                        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                            deleted += store.sweep_large_values(holder).unwrap().deleted;
                        }
                        deleted
                    })
                })
                .collect();
            let writers: Vec<_> = ["a", "b"]
                .into_iter()
                .map(|writer_name| {
                    let store = relay(&kv, &s3()).with_large_value_intent_ttl(Duration::ZERO);
                    scope.spawn(move || {
                        let mut appended = Vec::new();
                        let mut failed = 0;
                        for index in 0..15 {
                            // Equal contents across writers and rounds, each its own upload.
                            let mut shared =
                                message(&format!("race-{writer_name}-{index}"), INLINE_LIMIT + 1);
                            shared.ciphertext = hex::encode(content(
                                &format!("race-{}", index % 4),
                                INLINE_LIMIT + 1,
                            ));
                            shared.write_sig =
                                sign(&keypair("write").0, &shared.signing_digest().unwrap());
                            match put_message(&store, &group_id(), shared.clone()) {
                                Ok(receipt) => appended.push((receipt.message.server_seq, shared)),
                                Err(GroupError::LargeValue(_) | GroupError::Storage(_)) => {
                                    failed += 1
                                }
                                Err(error) => panic!("{error}"),
                            }
                        }
                        (appended, failed)
                    })
                })
                .collect();
            let mut appended = Vec::new();
            let mut failed = 0;
            for writer in writers {
                let (mine, lost) = writer.join().unwrap();
                appended.extend(mine);
                failed += lost;
            }
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            let deleted: usize = sweepers.into_iter().map(|s| s.join().unwrap()).sum();
            (appended, failed, deleted)
        });
        store.sweep_large_values([1; 16]).unwrap();
        assert!(!appended.is_empty());
        let reader = relay(&kv, &s3());
        for (seq, envelope) in &appended {
            let read = reader.list_messages(&group_id(), seq - 1, 1).unwrap();
            assert_eq!(
                read[0].ciphertext, envelope.ciphertext,
                "seq {seq} lost its object"
            );
        }
        assert_eq!(
            reader.list_messages(&group_id(), 0, 500).unwrap().len(),
            3 + appended.len()
        );
        eprintln!(
            "orphan swept, referenced object kept; {} racing appends committed and readable, \
             {failed} failed closed, {deleted} objects deleted concurrently",
            appended.len()
        );
    });
}

/// Sets the flag when dropped, including while unwinding from a panic.
struct StopOnDrop<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Last phase: remove this run's FDB subspace.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn cleanup_removes_this_runs_subspace() {
    with_fdb(|| {
        let kv: Arc<dyn RelayKvStore> = open_kv();
        loop {
            let cleared = kv
                .transact(|tx| {
                    let rows = tx.scan_prefix(b"", None, 50)?;
                    for (key, _) in &rows {
                        tx.clear(key)?;
                    }
                    Ok::<_, KvError>(rows.len())
                })
                .unwrap();
            if cleared == 0 {
                break;
            }
        }
    });
}
