//! Local Compose component contract: real Core NATS and the selected durable backend.
//! This is not an HTTP/payment admission test or a shared-Rocks multi-replica test.
use std::time::Duration;

use cashweb_registry::{
    events::{CoreNatsEventBus, RelayEventBus},
    store::kv_store::{KvError, RelayKvStore, Transact},
};

#[cfg(not(feature = "foundationdb"))]
fn open_store(path: &std::path::Path, _recipient: &str) -> Box<dyn RelayKvStore> {
    Box::new(cashweb_registry::store::kv_store::RocksDbKvStore::open(path).unwrap())
}

#[cfg(feature = "foundationdb")]
fn open_store(_path: &std::path::Path, recipient: &str) -> Box<dyn RelayKvStore> {
    use cashweb_registry::store::foundationdb_driver::FoundationDbKvStore;
    let file = std::env::var("FRANK_FDB_CLUSTER_FILE").expect("explicit FDB cluster required");
    Box::new(FoundationDbKvStore::open(&file, format!("frank-nats-lab:{recipient}:")).unwrap())
}

// async-nats flush only flushes the socket writer; a server reply is needed
// to order operations across the publisher and subscriber connections.
async fn server_barrier(bus: &CoreNatsEventBus, recipient: &str) {
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        bus.client()
            .request(format!("lab.barrier.{recipient}"), Vec::new().into()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.kind().to_string(), "no responders");
}

#[tokio::test]
async fn real_nats_notification_and_durable_offline_catch_up() {
    // SAFETY: this integration-test process has exactly one FDB-network owner;
    // every store handle below is dropped before this guard.
    #[cfg(feature = "foundationdb")]
    let _network = unsafe { foundationdb::boot() };
    let url = std::env::var("FRANK_LAB_NATS_URL").expect("FRANK_LAB_NATS_URL required");
    let writer_bus = CoreNatsEventBus::connect(&url, "nats-lab").await.unwrap();
    let reader_bus = CoreNatsEventBus::connect(&url, "nats-lab").await.unwrap();
    // Fresh synthetic recipient; no account keys or existing inboxes.
    let recipient = hex::encode(rand::random::<[u8; 20]>());
    let mut events = reader_bus.subscribe(&recipient).await.unwrap();
    server_barrier(&reader_bus, &recipient).await;
    let directory = tempfile::tempdir().unwrap();
    let prefix = format!("I/lab/{recipient}/").into_bytes();
    let counter = format!("N/lab/{recipient}").into_bytes();
    let db = open_store(directory.path(), &recipient);
    // Each append takes the next per-recipient sequence number in the same transaction.
    let append = |payload: &[u8]| {
        db.transact(|tx| {
            let next = match tx.get(&counter)? {
                Some(bytes) => u64::from_be_bytes(bytes.try_into().unwrap()) + 1,
                None => 1,
            };
            tx.set(&counter, &next.to_be_bytes())?;
            tx.set(&[prefix.as_slice(), &next.to_be_bytes()].concat(), payload)
        })
        .unwrap()
    };
    append(b"first synthetic encrypted envelope");
    writer_bus
        .publish_message_arrival(&recipient, &[1; 32])
        .await
        .unwrap();
    server_barrier(&writer_bus, &recipient).await;
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.recipient_hex, recipient);
    assert_eq!(event.payload_hash, [1; 32]);
    let first_page = db.transact(|tx| tx.scan_prefix(&prefix, None, 1)).unwrap();
    assert_eq!(first_page.len(), 1);
    let cursor = first_page[0].0.clone();

    // A disconnected subscriber misses the wakeup; durable data remains the authority.
    drop(events);
    server_barrier(&reader_bus, &recipient).await;
    append(b"second synthetic encrypted envelope");
    writer_bus
        .publish_message_arrival(&recipient, &[2; 32])
        .await
        .unwrap();
    server_barrier(&writer_bus, &recipient).await;
    let mut reconnected = reader_bus.subscribe(&recipient).await.unwrap();
    server_barrier(&reader_bus, &recipient).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), reconnected.recv())
            .await
            .is_err(),
        "Core NATS must not be mistaken for a replay log"
    );
    drop(db);
    let reopened = open_store(directory.path(), &recipient);
    let catch_up = reopened
        .transact(|tx| tx.scan_prefix(&prefix, Some(&cursor), 10))
        .unwrap();
    assert_eq!(catch_up.len(), 1);
    assert_eq!(catch_up[0].1, b"second synthetic encrypted envelope");
    // Only keys inside this test's random recipient/subspace are removed.
    reopened
        .transact(|tx| {
            for (key, _) in tx.scan_prefix(&prefix, None, usize::MAX)? {
                tx.clear(&key)?;
            }
            tx.clear(&counter)?;
            Ok::<_, KvError>(())
        })
        .unwrap();
    println!("PASS: real Core NATS delivery; durable cursor catch-up after disconnect/reopen");
}
