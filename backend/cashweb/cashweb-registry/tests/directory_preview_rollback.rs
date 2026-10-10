//! The directory keeps its records in its own store beside the registry database. Using it
//! must add no table to the registry database and leave what is already there untouched.
//!
//! This used to be proved against a database opened by an older binary. There is no older
//! format to go back to any more (a database from an earlier build is refused at startup), so
//! what remains is the invariant itself, against the registry's own table list.
use cashweb_registry::{directory_admission::*, store::db::Db};
use frank_cbor::{verify_preview_directory_evidence, TypedPayload};
use serde_json::Value;
use std::path::Path;

// The registry database's tables, sorted (including RocksDB's default one). Written out here,
// not read back from the opener under test.
const REGISTRY_CFS: &[&str] = &[
    "default",
    "directory_usernames",
    "message_payloads",
    "metadata",
    "monad_profiles",
    "monad_profiles_by_name",
    "monad_profiles_by_time",
    "monad_topic_discovery",
    "monad_topic_posts",
    "monad_topic_posts_by_topic",
    "monad_topic_votes",
    "pkh_by_time",
    "topic_burn_txs",
    "topic_messages",
];

fn names(path: &Path) -> Vec<String> {
    let mut names = rocksdb::DB::list_cf(&rocksdb::Options::default(), path).unwrap();
    names.sort();
    names
}
fn regression(populated: bool) {
    let label = if populated { "populated" } else { "unused" };
    let temp = tempdir::TempDir::new("directory-preview-rollback").unwrap();
    let path = match std::env::var("FRANK_DIRECTORY_ROLLBACK_EVIDENCE") {
        Ok(root) => Path::new(&root).join(label),
        Err(_) => temp.path().join(label),
    };
    eprintln!("retained fixture: {}", path.display());
    drop(Db::open(&path).unwrap());
    assert_eq!(
        names(&path),
        REGISTRY_CFS,
        "a fresh registry holds exactly its own tables"
    );
    {
        let raw = rocksdb::DB::open_cf(&rocksdb::Options::default(), &path, REGISTRY_CFS).unwrap();
        let mut sync = rocksdb::WriteOptions::default();
        sync.set_sync(true);
        raw.put_opt(b"legacy-sentinel", b"exact-preexisting-legacy-bytes", &sync)
            .unwrap();
    }
    let source: Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap();
    let record = source["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "bootstrap")
        .unwrap();
    let statement = hex::decode(record["type4_hex"].as_str().unwrap()).unwrap();
    let attestation = hex::decode(record["type2_hex"].as_str().unwrap()).unwrap();
    let fixture = verify_preview_directory_evidence(&attestation, "monad-testnet").unwrap();
    let Some(TypedPayload::DirectoryStatement {
        subject, relays, ..
    }) = fixture.statement_frame().typed.as_deref()
    else {
        panic!("fixture");
    };
    let anchor = Anchor {
        network: "monad-testnet".into(),
        subject: subject.clone(),
        revision_zero: fixture.statement_hash,
    };
    let context = Context {
        now: Some(Timestamp {
            seconds: 1700000100,
            nanoseconds: 0,
        }),
        relay: Some(&relays[0]),
    };
    let accepted = {
        let db = Db::open(&path).unwrap();
        if populated {
            Some(
                db.directory_preview(anchor.clone(), OpenMode::NewEnrollment)
                    .unwrap()
                    .advance(
                        &[Candidate {
                            statement: &statement,
                            attestation: &attestation,
                        }],
                        context,
                    )
                    .unwrap(),
            )
        } else {
            None
        }
    };
    assert_eq!(
        names(&path),
        REGISTRY_CFS,
        "using the directory must add no table to the registry database"
    );
    {
        let raw = rocksdb::DB::open_cf(&rocksdb::Options::default(), &path, REGISTRY_CFS).unwrap();
        assert_eq!(
            raw.get(b"legacy-sentinel").unwrap().unwrap(),
            b"exact-preexisting-legacy-bytes"
        );
    }
    if let Some(accepted) = accepted {
        let db = Db::open(&path).unwrap();
        let d = db
            .directory_preview(anchor, OpenMode::Reopen(accepted.status.checkpoint))
            .unwrap();
        assert_eq!(d.current(context).unwrap(), accepted);
        let exact = d
            .historical_evidence(fixture.statement_hash)
            .unwrap()
            .unwrap();
        assert_eq!(exact.statement, statement);
        assert_eq!(exact.attestation, attestation);
    } else {
        assert!(
            !path.join("directory-preview-v1.rocksdb").exists(),
            "ordinary startup must not create preview storage"
        );
    }
}

#[test]
fn an_unused_directory_adds_nothing_to_the_registry_database() {
    regression(false);
}
#[test]
fn a_used_directory_adds_no_table_and_changes_no_existing_value() {
    regression(true);
}
