//! Test-only clients for the four typed matched-restore phases. No backup implementation.
use std::sync::Arc;

use super::{
    blob_store::S3BlobStoreConfig,
    foundationdb_driver::FoundationDbKvStore,
    kv_store::{KvError, KvTransaction, Outcome, RelayKvStore},
    large_values::{ObjectStore, ObjectStoreError},
    s3_objects::S3ObjectStore,
};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

pub(super) fn run(body: impl FnOnce()) {
    // SAFETY: one exact phase per process; every owner is dropped inside body.
    let _network = unsafe { foundationdb::boot() };
    body();
}

pub(super) fn open(suffix: &str, read_only: bool) -> (Arc<dyn RelayKvStore>, Arc<dyn ObjectStore>) {
    assert!(["directory-v1", "groups-v1", "forum-v1", "messages-v4"].contains(&suffix));
    let run = env("FRANK_LAB_RUN_ID");
    assert!(run.len() == 36 && run.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    let kv = Arc::new(
        FoundationDbKvStore::open(
            &env("FRANK_FDB_CLUSTER_FILE"),
            format!("frank-large-value-lab:{run}:{suffix}/"),
        )
        .unwrap(),
    );
    let objects = Arc::new(
        S3ObjectStore::new(S3BlobStoreConfig {
            api: cashweb_config::S3Api::S3,
            endpoint: env("FRANK_LAB_S3_ENDPOINT"),
            region: "us-east-1".into(),
            bucket: env("FRANK_LAB_S3_BUCKET"),
            prefix: format!("lab-{run}/typed-owners"),
            auth: crate::store::blob_store::S3Authentication::Hmac(cashweb_config::S3Credentials {
                access_key_id: env("FRANK_S3_ACCESS_KEY_ID"),
                secret_access_key: env("FRANK_S3_SECRET_ACCESS_KEY"),
            }),
            force_path_style: true,
        })
        .unwrap(),
    );
    if read_only {
        (Arc::new(ReadOnlyKv(kv)), Arc::new(ReadOnlyObjects(objects)))
    } else {
        (kv, objects)
    }
}

#[derive(Debug)]
struct ReadOnlyKv(Arc<dyn RelayKvStore>);

impl RelayKvStore for ReadOnlyKv {
    fn run_transaction(
        &self,
        body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
    ) -> Result<Outcome, KvError> {
        self.0.run_transaction(&mut |tx| body(&mut ReadOnlyTx(tx)))
    }
}

struct ReadOnlyTx<'a>(&'a mut dyn KvTransaction);

impl KvTransaction for ReadOnlyTx<'_> {
    fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
        self.0.get(key)
    }
    fn get_range(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        self.0.get_range(start, end, limit)
    }
    fn get_range_reverse(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
        self.0.get_range_reverse(start, end, limit)
    }
    fn set(&mut self, _key: &[u8], _value: &[u8]) -> Result<(), KvError> {
        panic!("restored read-only phase attempted set")
    }
    fn clear(&mut self, _key: &[u8]) -> Result<(), KvError> {
        panic!("restored read-only phase attempted clear")
    }
    fn atomic_add(&mut self, _key: &[u8], _delta: i64) -> Result<(), KvError> {
        panic!("restored read-only phase attempted atomic add")
    }
}

#[derive(Debug)]
struct ReadOnlyObjects(Arc<dyn ObjectStore>);

impl ObjectStore for ReadOnlyObjects {
    fn put(&self, _key: &str, _bytes: &[u8], _sha256: &[u8; 32]) -> Result<(), ObjectStoreError> {
        panic!("restored read-only phase attempted object put")
    }
    fn put_if_absent(
        &self,
        _key: &str,
        _bytes: &[u8],
        _sha256: &[u8; 32],
    ) -> Result<bool, ObjectStoreError> {
        panic!("restored read-only phase attempted object claim")
    }
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, ObjectStoreError> {
        self.0.get(key)
    }
    fn delete(&self, _key: &str) -> Result<(), ObjectStoreError> {
        panic!("restored read-only phase attempted object delete")
    }
    fn contains(&self, key: &str) -> Result<bool, ObjectStoreError> {
        self.0.contains(key)
    }
}

#[test]
fn read_only_guards_refuse_every_mutation_before_the_driver() {
    use super::{kv_store::RocksDbKvStore, large_values::LocalFsObjectStore};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    for (operation, expected) in [
        "restored read-only phase attempted set",
        "restored read-only phase attempted clear",
        "restored read-only phase attempted atomic add",
    ]
    .iter()
    .enumerate()
    {
        let kv = ReadOnlyKv(Arc::new(RocksDbKvStore::open_temporary().unwrap()));
        let failure = catch_unwind(AssertUnwindSafe(|| {
            kv.run_transaction(&mut |tx| {
                match operation {
                    0 => tx.set(b"key", b"value").unwrap(),
                    1 => tx.clear(b"key").unwrap(),
                    _ => tx.atomic_add(b"key", 1).unwrap(),
                }
                Outcome::Commit
            })
            .unwrap();
        }))
        .expect_err("read-only KV mutation was admitted");
        assert_eq!(failure.downcast_ref::<&str>(), Some(expected));
    }
    let objects = ReadOnlyObjects(Arc::new(LocalFsObjectStore::temporary()));
    for (operation, expected) in [
        "restored read-only phase attempted object put",
        "restored read-only phase attempted object claim",
        "restored read-only phase attempted object delete",
    ]
    .iter()
    .enumerate()
    {
        let failure = catch_unwind(AssertUnwindSafe(|| match operation {
            0 => objects.put("key", b"value", &[0; 32]).unwrap(),
            1 => {
                objects.put_if_absent("key", b"value", &[0; 32]).unwrap();
            }
            _ => objects.delete("key").unwrap(),
        }))
        .expect_err("read-only object mutation was admitted");
        assert_eq!(failure.downcast_ref::<&str>(), Some(expected));
    }
    assert_eq!(objects.get("key").unwrap(), None);
}
