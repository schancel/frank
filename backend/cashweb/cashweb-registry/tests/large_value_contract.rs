//! Large-value contracts: local S3/FDB phases and separately admitted GCS negatives.
//!
//! `backend/labs/large-values-acceptance.sh` runs the local S3/FDB phases in separate
//! containers and stops/restarts MinIO between phases. Those phases share state through
//! the cluster and derive their keys, messages, FDB subspace and object prefix from one
//! `FRANK_LAB_RUN_ID`. They require `FRANK_FDB_CLUSTER_FILE`, `FRANK_LAB_S3_ENDPOINT`,
//! `FRANK_LAB_S3_BUCKET`, `FRANK_S3_ACCESS_KEY_ID` and `FRANK_S3_SECRET_ACCESS_KEY`.
//!
//! The ignored GCS negative cases run separately with the explicit API/endpoint/run-prefix
//! guards below; they do not boot FDB or use the MinIO restart script. This target still
//! links the FDB native client. Ordinary configuration tests use fake environment readers
//! and open no stores or services.
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
    large_values::{LargeValueError, LargeValues, ObjectStore, INLINE_LIMIT},
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
    scoped_kv("")
}

// Every additional fixture remains below this run's base, so the existing final
// cleanup clears its FDB rows too. Objects live in this run's disposable bucket.
fn scoped_kv(scope: &str) -> Arc<FoundationDbKvStore> {
    let subspace = format!("frank-large-value-lab:{}:{scope}", run_id());
    Arc::new(FoundationDbKvStore::open(&env("FRANK_FDB_CLUSTER_FILE"), subspace).unwrap())
}

fn s3() -> Arc<S3ObjectStore> {
    scoped_s3("")
}

/// The same fixture configuration is used by live phases and pure input tests.
fn fixture_s3_config(
    read_env: impl Fn(&str) -> Result<String, std::env::VarError>,
    scope: &str,
) -> Result<S3BlobStoreConfig, String> {
    let required = |name: &str| {
        read_env(name).map_err(|_| format!("{name} is required and must be valid Unicode"))
    };
    let optional = |name: &str| match read_env(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid Unicode")),
    };
    let api = match optional("FRANK_LAB_S3_API")? {
        None => cashweb_config::S3Api::S3,
        Some(value) => serde_json::from_value(serde_json::Value::String(value))
            .map_err(|_| "FRANK_LAB_S3_API must be s3 or gcs_xml".to_string())?,
    };
    let run = required("FRANK_LAB_RUN_ID")?;
    let base = match optional("FRANK_LAB_S3_PREFIX")? {
        None => format!("lab-{run}"),
        Some(value) if value.trim_matches('/').is_empty() => {
            return Err("FRANK_LAB_S3_PREFIX must name a nonempty base".to_string());
        }
        Some(value) => value,
    };
    let config = S3BlobStoreConfig {
        api,
        endpoint: required("FRANK_LAB_S3_ENDPOINT")?,
        region: "us-east-1".into(),
        bucket: required("FRANK_LAB_S3_BUCKET")?,
        prefix: format!("{base}/{scope}"),
        auth: match optional("FRANK_LAB_S3_AUTH")?.as_deref() {
            None | Some("hmac") => cashweb_registry::store::blob_store::S3Authentication::Hmac(
                cashweb_config::S3Credentials {
                    access_key_id: required("FRANK_S3_ACCESS_KEY_ID")?,
                    secret_access_key: required("FRANK_S3_SECRET_ACCESS_KEY")?,
                },
            ),
            Some("google_metadata") => {
                if optional("FRANK_S3_ACCESS_KEY_ID")?.is_some()
                    || optional("FRANK_S3_SECRET_ACCESS_KEY")?.is_some()
                    || optional("GCE_METADATA_HOST")?.is_some()
                {
                    return Err(
                        "google_metadata forbids HMAC credentials and metadata host overrides"
                            .into(),
                    );
                }
                cashweb_registry::store::blob_store::S3Authentication::GoogleMetadata
            }
            Some(_) => return Err("FRANK_LAB_S3_AUTH must be hmac or google_metadata".into()),
        },
        force_path_style: true,
    };
    config.validate()?;
    Ok(config)
}

fn scoped_s3(scope: &str) -> Arc<S3ObjectStore> {
    let config = fixture_s3_config(|name| std::env::var(name), scope)
        .expect("invalid large-value fixture configuration");
    Arc::new(S3ObjectStore::new(config).unwrap())
}

// These cases deliberately exercise only the existing HTTP object capability,
// without booting FDB. The integration target still links the FDB native client.
fn gcs_negative_config(
    read_env: impl Fn(&str) -> Result<String, std::env::VarError>,
    scope: &str,
) -> Result<S3BlobStoreConfig, String> {
    let config = fixture_s3_config(&read_env, scope)?;
    let run = read_env("FRANK_LAB_RUN_ID").map_err(|_| "disposable run required")?;
    let prefix = read_env("FRANK_LAB_S3_PREFIX").map_err(|_| "explicit run prefix required")?;
    if !matches!(
        config.auth,
        cashweb_registry::store::blob_store::S3Authentication::Hmac(_)
    ) || config.api != cashweb_config::S3Api::GcsXml
        || config.endpoint != "https://storage.googleapis.com"
        || prefix != format!("contract/{run}")
    {
        return Err("explicit GCS XML endpoint and disposable run prefix required".into());
    }
    Ok(config)
}

fn gcs_negative_fixture(scope: &str) -> (S3BlobStoreConfig, S3ObjectStore) {
    let config = match gcs_negative_config(|name| std::env::var(name), scope) {
        Ok(config) => config,
        Err(_) => panic!("invalid disposable GCS fixture"),
    };
    let objects = match S3ObjectStore::new(config.clone()) {
        Ok(objects) => objects,
        Err(_) => panic!("GCS fixture client unavailable"),
    };
    for key in ["control-before", "attempt", "control-after"] {
        gcs_absent(&objects, key);
    }
    (config, objects)
}

fn gcs_absent(objects: &dyn ObjectStore, key: &str) {
    assert!(
        matches!(objects.get(key), Ok(None)),
        "GCS GET absence unconfirmed"
    );
    assert!(
        matches!(objects.contains(key), Ok(false)),
        "GCS HEAD absence unconfirmed"
    );
}

fn gcs_positive_control(objects: &dyn ObjectStore, key: &str) {
    let bytes = b"\x00GCS control\xff";
    let hash: [u8; 32] = Sha256::digest(bytes).into();
    assert!(
        matches!(objects.put_if_absent(key, bytes, &hash), Ok(true)),
        "GCS control create refused"
    );
    assert!(
        matches!(objects.get(key), Ok(Some(value)) if value.as_slice() == &bytes[..]),
        "GCS control bytes differ"
    );
    assert!(
        matches!(objects.contains(key), Ok(true)),
        "GCS control HEAD refused"
    );
    let replacement = b"different control bytes";
    let replacement_hash: [u8; 32] = Sha256::digest(replacement).into();
    assert!(
        matches!(
            objects.put_if_absent(key, replacement, &replacement_hash),
            Ok(false)
        ),
        "GCS conditional collision admitted"
    );
    assert!(
        matches!(objects.get(key), Ok(Some(value)) if value.as_slice() == &bytes[..]),
        "GCS collision changed bytes"
    );
}

#[test]
#[ignore = "requires explicitly admitted disposable GCS XML fixture"]
fn gcs_xml_wrong_secret_conditional_put_is_refused_without_object() {
    let (mut config, valid) = gcs_negative_fixture("gcs-negative-wrong-secret");
    gcs_positive_control(&valid, "control-before");
    let cashweb_registry::store::blob_store::S3Authentication::Hmac(credentials) = &mut config.auth
    else {
        panic!("HMAC fixture required")
    };
    assert!(
        credentials.secret_access_key.len() == 40 && credentials.secret_access_key.is_ascii(),
        "GCS HMAC secret shape invalid"
    );
    let replacement = if credentials.secret_access_key.starts_with('A') {
        "B"
    } else {
        "A"
    };
    credentials
        .secret_access_key
        .replace_range(..1, replacement);
    let wrong = match S3ObjectStore::new(config) {
        Ok(objects) => objects,
        Err(_) => panic!("negative GCS fixture client unavailable"),
    };
    let bytes = b"\x00wrong-secret attempt\xff";
    let hash: [u8; 32] = Sha256::digest(bytes).into();
    let refused = wrong.put_if_absent("attempt", bytes, &hash).is_err();
    let absent =
        matches!(valid.get("attempt"), Ok(None)) && matches!(valid.contains("attempt"), Ok(false));
    gcs_positive_control(&valid, "control-after");
    for key in ["control-before", "control-after"] {
        assert!(valid.delete(key).is_ok(), "GCS control cleanup refused");
        gcs_absent(&valid, key);
    }
    assert!(refused, "GCS wrong-secret request was not refused");
    assert!(
        absent,
        "GCS wrong-secret request left an object or absence was unconfirmed"
    );
    gcs_absent(&valid, "attempt");
}

#[test]
#[ignore = "requires explicitly admitted disposable GCS XML fixture"]
fn gcs_xml_wrong_payload_hash_conditional_put_is_refused_without_object() {
    let (_, valid) = gcs_negative_fixture("gcs-negative-payload-hash");
    gcs_positive_control(&valid, "control-before");
    let bytes = b"\x00payload-hash attempt\xff";
    let actual_hash: [u8; 32] = Sha256::digest(bytes).into();
    let wrong_hash: [u8; 32] = Sha256::digest(b"different declared payload").into();
    assert!(
        actual_hash != wrong_hash,
        "negative payload hash must differ"
    );
    let refused = valid.put_if_absent("attempt", bytes, &wrong_hash).is_err();
    let absent =
        matches!(valid.get("attempt"), Ok(None)) && matches!(valid.contains("attempt"), Ok(false));
    gcs_positive_control(&valid, "control-after");
    for key in ["control-before", "control-after"] {
        assert!(valid.delete(key).is_ok(), "GCS control cleanup refused");
        gcs_absent(&valid, key);
    }
    assert!(refused, "GCS payload-hash mismatch request was not refused");
    assert!(
        absent,
        "GCS payload-hash mismatch left an object or absence was unconfirmed"
    );
    gcs_absent(&valid, "attempt");
}

/// One relay's view: its own FDB client and its own S3 client.
fn relay(kv: &Arc<FoundationDbKvStore>, objects: &Arc<S3ObjectStore>) -> GroupStore {
    GroupStore::new(kv.clone(), objects.clone())
}

/// Append `envelope` as the HTTP layer does once it has verified the write's payment. This
/// contract is about where ciphertext lives, so the store is handed a payment fact (hash and
/// nonce from the envelope's digest, so a retry of one envelope is the same payment) rather than a
/// transaction checked on a chain; the cluster lab pays for real.
fn put_message(
    store: &GroupStore,
    group_id: &str,
    envelope: GroupMessageEnvelope,
) -> Result<GroupAppendOutcome, GroupError> {
    let digest = envelope.signing_digest()?;
    let payment = GroupWritePaymentFact {
        network: "monad-regtest".into(),
        tx_hash: digest,
        payer: [1; 20],
        payee: [2; 20],
        value_wei: 1,
        nonce: u64::from_be_bytes(digest[..8].try_into().unwrap()),
    };
    store.put_paid_message(group_id, envelope, &payment, 1)
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

/// The actual GroupStore boundary, with fresh real FDB/S3 clients on reopen.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn group_inline_boundary_round_trips_through_fdb_and_s3() {
    with_fdb(|| {
        let (kv, objects) = (scoped_kv("boundary/"), scoped_s3("boundary"));
        let store = relay(&kv, &objects);
        store.put_epoch(&group_id(), initial_epoch()).unwrap();
        for (index, len) in [INLINE_LIMIT - 1, INLINE_LIMIT, INLINE_LIMIT + 1]
            .into_iter()
            .enumerate()
        {
            let label = format!("boundary-{len}");
            let receipt = put_message(&store, &group_id(), message(&label, len)).unwrap();
            assert_eq!(receipt.message.server_seq, index as u64 + 1);
            let references = store.large_values().references(10).unwrap();
            assert_eq!(references.len(), usize::from(len > INLINE_LIMIT));
            if let Some(reference) = references.first() {
                let bytes = content(&label, len);
                assert!(reference.matches(&bytes));
                assert_eq!(
                    objects
                        .get(&store.large_values().object_key(reference))
                        .unwrap(),
                    Some(bytes)
                );
            }
        }
        drop(store);
        drop(objects);
        drop(kv);
        let reopened = relay(&scoped_kv("boundary/"), &scoped_s3("boundary"));
        let messages = reopened.list_messages(&group_id(), 0, 10).unwrap();
        assert_eq!(messages.len(), 3);
        for (row, len) in messages
            .iter()
            .zip([INLINE_LIMIT - 1, INLINE_LIMIT, INLINE_LIMIT + 1])
        {
            assert_eq!(
                hex::decode(&row.ciphertext).unwrap(),
                content(&format!("boundary-{len}"), len)
            );
        }
        assert_eq!(reopened.large_values().references(10).unwrap().len(), 1);
        eprintln!("inline boundary: 65535/65536 inline, 65537 referenced; all reopened byte-exact");
    });
}

/// Conditional S3 claims bind the durable FDB index, not an in-memory client.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn namespace_claims_race_and_survive_reopen() {
    with_fdb(|| {
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|threads| {
            let workers: Vec<_> = (0..2)
                .map(|index| {
                    let barrier = &barrier;
                    threads.spawn(move || {
                        // No fallible operation precedes the barrier: a failed
                        // client open must not leave another worker waiting forever.
                        barrier.wait();
                        let values = LargeValues::new(
                            scoped_kv(&format!("claim-{index}/")),
                            scoped_s3("claims"),
                            b"index/",
                            "shared",
                        );
                        (index, values.claim_namespace())
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|(_, result)| matches!(result, Err(LargeValueError::NamespaceClaimed(_))))
                .count(),
            1
        );
        let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
        scoped_kv("claim-result/")
            .transact(|tx| tx.set(b"winner", &[winner as u8]))
            .unwrap();
        assert_namespace_owners(winner);
        eprintln!("namespace race: one durable winner, one refused; reopened marker unchanged");
    });
}

fn assert_namespace_owners(winner: usize) {
    assert!(winner < 2);
    let objects = scoped_s3("claims");
    let marker = objects.get("shared/claim").unwrap().unwrap();
    assert_eq!(marker.len(), 16);
    for index in 0..2 {
        let kv = scoped_kv(&format!("claim-{index}/"));
        let values = LargeValues::new(kv.clone(), objects.clone(), b"index/", "shared");
        if index == winner {
            values.claim_namespace().unwrap();
            assert_eq!(
                kv.transact(|tx| tx.get(b"index/claim")).unwrap(),
                Some(marker.clone())
            );
        } else {
            assert!(matches!(
                values.claim_namespace(),
                Err(LargeValueError::NamespaceClaimed(_))
            ));
            // A disjoint namespace is independently usable by this index.
            LargeValues::new(kv, objects.clone(), b"other/", "separate")
                .claim_namespace()
                .unwrap();
        }
    }
    assert_eq!(objects.get("shared/claim").unwrap(), Some(marker));
}

#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn namespace_claims_remain_exclusive_after_service_restart() {
    with_fdb(|| {
        let winner = scoped_kv("claim-result/")
            .transact(|tx| tx.get(b"winner"))
            .unwrap()
            .unwrap();
        assert_eq!(winner.len(), 1);
        assert_namespace_owners(usize::from(winner[0]));
    });
}

/// Stop this process after upload and after commit, without sweeping either intent.
#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn stage_orphan_and_ambiguous_committed_reference() {
    with_fdb(|| {
        let (kv, objects) = (scoped_kv("intents/"), scoped_s3("intents"));
        let values = LargeValues::new(kv.clone(), objects.clone(), b"index/", "persisted")
            .with_intent_ttl(Duration::ZERO);
        let orphan = values
            .stage(&content("persisted-orphan", INLINE_LIMIT + 1))
            .unwrap();
        let kept = values
            .stage(&content("persisted-kept", INLINE_LIMIT + 1))
            .unwrap();
        let orphan_key = values.object_key(&orphan.reference);
        kv.transact(|tx| {
            values.commit_reference(tx, &kept, b"test/owner-row")?;
            tx.set(b"test/owner-row", &kept.reference.digest)?;
            tx.set(b"test/orphan-key", orphan_key.as_bytes())?;
            Ok::<_, LargeValueError>(())
        })
        .unwrap();
        // Simulate a writer that lost its response after the transaction committed.
        values.abandon(&kept);
        assert!(objects.contains(&orphan_key).unwrap());
        assert_eq!(values.references(10).unwrap(), vec![kept.reference]);
    });
}

#[test]
#[ignore = "phase of backend/labs/large-values-acceptance.sh"]
fn reopened_intents_are_collected_without_losing_committed_bytes() {
    with_fdb(|| {
        let (kv, objects) = (scoped_kv("intents/"), scoped_s3("intents"));
        let values = LargeValues::new(kv.clone(), objects.clone(), b"index/", "persisted");
        let orphan_key = String::from_utf8(
            kv.transact(|tx| tx.get(b"test/orphan-key"))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let references = values.references(10).unwrap();
        assert_eq!(references.len(), 1);
        assert_eq!(
            kv.transact(|tx| tx.get(b"test/owner-row")).unwrap(),
            Some(references[0].digest.to_vec())
        );
        let report = values.sweep([3; 16]).unwrap();
        assert!(report.held_lease);
        assert_eq!((report.deleted, report.kept_referenced), (1, 1));
        assert!(!objects.contains(&orphan_key).unwrap());
        assert_eq!(
            values.read(&references[0]).unwrap(),
            content("persisted-kept", INLINE_LIMIT + 1)
        );
        assert_eq!(values.sweep([3; 16]).unwrap().deleted, 0);
        assert_eq!(values.references(10).unwrap(), references);
        assert_eq!(
            values.read(&references[0]).unwrap(),
            content("persisted-kept", INLINE_LIMIT + 1)
        );
        eprintln!("reopened GC: one orphan deleted, ambiguous committed upload retained, repeat deletion zero");
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

#[cfg(test)]
mod fixture_config_tests {
    use super::*;
    use cashweb_config::S3Api;
    use std::{collections::HashMap, env::VarError};

    fn inputs() -> HashMap<&'static str, String> {
        HashMap::from([
            ("FRANK_LAB_RUN_ID", "fixture-1".into()),
            ("FRANK_LAB_S3_ENDPOINT", "https://objects.invalid".into()),
            ("FRANK_LAB_S3_BUCKET", "fixture-bucket".into()),
            ("FRANK_S3_ACCESS_KEY_ID", "fixture-access".into()),
            ("FRANK_S3_SECRET_ACCESS_KEY", "fixture-secret".into()),
        ])
    }

    fn config(values: &HashMap<&str, String>, scope: &str) -> Result<S3BlobStoreConfig, String> {
        fixture_s3_config(
            |name| values.get(name).cloned().ok_or(VarError::NotPresent),
            scope,
        )
    }

    #[test]
    fn gcs_negative_config_requires_explicit_endpoint_api_and_run_prefix() {
        let mut values = inputs();
        values.insert("FRANK_LAB_S3_API", "gcs_xml".into());
        values.insert("FRANK_LAB_S3_PREFIX", "contract/fixture-1".into());
        values.insert(
            "FRANK_LAB_S3_ENDPOINT",
            "https://storage.googleapis.com".into(),
        );
        let read = |values: &HashMap<&str, String>| {
            super::gcs_negative_config(
                |name| values.get(name).cloned().ok_or(VarError::NotPresent),
                "gcs-negative-wrong-secret",
            )
        };
        assert_eq!(
            read(&values).unwrap().prefix,
            "contract/fixture-1/gcs-negative-wrong-secret"
        );
        for (name, invalid) in [
            ("FRANK_LAB_S3_API", "s3"),
            ("FRANK_LAB_S3_API", ""),
            ("FRANK_LAB_S3_ENDPOINT", "http://storage.googleapis.com"),
            ("FRANK_LAB_S3_ENDPOINT", "https://objects.invalid"),
            ("FRANK_LAB_S3_ENDPOINT", "https://storage.googleapis.com/"),
            ("FRANK_LAB_S3_PREFIX", "lab-fixture-1"),
            ("FRANK_LAB_S3_PREFIX", "contract/other-run"),
            ("FRANK_LAB_S3_PREFIX", "contract/fixture-1/"),
        ] {
            let mut invalid_values = values.clone();
            invalid_values.insert(name, invalid.into());
            assert!(read(&invalid_values).is_err());
        }
        for name in ["FRANK_LAB_S3_API", "FRANK_LAB_S3_PREFIX"] {
            let mut missing = values.clone();
            missing.remove(name);
            assert!(read(&missing).is_err());
        }
    }

    #[test]
    fn metadata_fixture_is_explicit_and_never_accepts_hmac_or_untrusted_origins() {
        let mut values = inputs();
        values.remove("FRANK_S3_ACCESS_KEY_ID");
        values.remove("FRANK_S3_SECRET_ACCESS_KEY");
        values.insert("FRANK_LAB_S3_API", "gcs_xml".into());
        values.insert("FRANK_LAB_S3_AUTH", "google_metadata".into());
        values.insert(
            "FRANK_LAB_S3_ENDPOINT",
            "https://storage.googleapis.com".into(),
        );
        assert_eq!(
            config(&values, "").unwrap().auth,
            cashweb_registry::store::blob_store::S3Authentication::GoogleMetadata
        );
        for (key, value) in [
            ("FRANK_LAB_S3_AUTH", "adc"),
            ("FRANK_LAB_S3_API", "s3"),
            ("FRANK_LAB_S3_ENDPOINT", "https://example.com"),
            ("FRANK_S3_SECRET_ACCESS_KEY", "ignored"),
            ("FRANK_S3_ACCESS_KEY_ID", "ignored"),
            ("GCE_METADATA_HOST", "ignored"),
        ] {
            let mut bad = values.clone();
            bad.insert(key, value.into());
            assert!(config(&bad, "").is_err());
        }
    }

    #[test]
    fn fixture_config_preserves_complete_s3_defaults() {
        let values = inputs();
        assert_eq!(
            config(&values, "").unwrap(),
            S3BlobStoreConfig {
                api: S3Api::S3,
                endpoint: "https://objects.invalid".into(),
                region: "us-east-1".into(),
                bucket: "fixture-bucket".into(),
                prefix: "lab-fixture-1/".into(),
                auth: cashweb_registry::store::blob_store::S3Authentication::Hmac(
                    cashweb_config::S3Credentials {
                        access_key_id: "fixture-access".into(),
                        secret_access_key: "fixture-secret".into(),
                    }
                ),
                force_path_style: true,
            }
        );
        assert_eq!(
            config(&values, "child").unwrap().prefix,
            "lab-fixture-1/child"
        );
    }

    #[test]
    fn fixture_config_selects_explicit_api() {
        for (value, expected) in [("s3", S3Api::S3), ("gcs_xml", S3Api::GcsXml)] {
            let mut values = inputs();
            values.insert("FRANK_LAB_S3_API", value.into());
            assert_eq!(config(&values, "").unwrap().api, expected);
        }
    }

    #[test]
    fn fixture_config_api_is_not_inferred_from_endpoint() {
        let mut values = inputs();
        values.insert(
            "FRANK_LAB_S3_ENDPOINT",
            "https://storage.googleapis.com".into(),
        );
        assert_eq!(config(&values, "").unwrap().api, S3Api::S3);
    }

    #[test]
    fn fixture_config_rejects_empty_or_unknown_api() {
        for value in ["", "auto", "GcsXml", " gcs_xml "] {
            let mut values = inputs();
            values.insert("FRANK_LAB_S3_API", value.into());
            assert!(config(&values, "").is_err());
        }
    }

    #[test]
    fn fixture_config_composes_explicit_prefix() {
        let mut values = inputs();
        values.insert("FRANK_LAB_S3_API", "gcs_xml".into());
        values.insert("FRANK_LAB_S3_PREFIX", "contract/fixture-1".into());
        assert_eq!(config(&values, "").unwrap().prefix, "contract/fixture-1/");
        assert_eq!(
            config(&values, "child").unwrap().prefix,
            "contract/fixture-1/child"
        );
    }

    #[test]
    fn fixture_config_rejects_invalid_prefix() {
        for value in [
            "",
            "/",
            "///",
            "../outside",
            "contract/../custody",
            "contract//fixture",
        ] {
            let mut values = inputs();
            values.insert("FRANK_LAB_S3_PREFIX", value.into());
            assert!(config(&values, "").is_err());
        }
        assert!(config(&inputs(), "../outside").is_err());
    }

    #[test]
    fn fixture_config_rejects_missing_or_non_unicode_inputs() {
        let required = [
            "FRANK_LAB_RUN_ID",
            "FRANK_LAB_S3_ENDPOINT",
            "FRANK_LAB_S3_BUCKET",
            "FRANK_S3_ACCESS_KEY_ID",
            "FRANK_S3_SECRET_ACCESS_KEY",
        ];
        for name in required {
            let mut values = inputs();
            values.remove(name);
            assert!(config(&values, "").is_err());
        }
        for name in required
            .into_iter()
            .chain(["FRANK_LAB_S3_API", "FRANK_LAB_S3_PREFIX"])
        {
            let values = inputs();
            let result = fixture_s3_config(
                |key| {
                    if key == name {
                        // The fake getter reports the native error without touching process env.
                        Err(VarError::NotUnicode("unreported fixture bytes".into()))
                    } else {
                        values.get(key).cloned().ok_or(VarError::NotPresent)
                    }
                },
                "",
            );
            assert!(result.is_err());
        }
    }
}
