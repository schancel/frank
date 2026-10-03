//! Actual old-binary proof uses FRANK_DIRECTORY_BASE_OPENER (the separately built pinned helper).
//! Without that artifact CI checks the exact legacy CF/data invariants, not an emulated old binary.
use cashweb_registry::{directory_admission::*, store::db::Db};
use frank_cbor::{verify_preview_directory_evidence, TypedPayload};
use serde_json::Value;
use std::{path::Path, process::Command};

// Exact sorted registry CF inventory registered by reviewed base
// 7b45b3374c102dda10c8c561535c8fd7f7183778 (including RocksDB's default CF).
// This must not be derived from the candidate opener, even when no old binary is supplied.
const REVIEWED_BASE_CFS: &[&str] = &[
    "default",
    "message_payloads",
    "metadata",
    "monad_message_attempts",
    "monad_messages",
    "monad_messages_by_recipient_time",
    "monad_messages_by_time",
    "monad_outbox_active_v1",
    "monad_outbox_history_v2",
    "monad_outbox_members_v1",
    "monad_outbox_meta_v2",
    "monad_outbox_recipient_v1",
    "monad_outbox_v1",
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

fn base_open(path: &Path) -> bool {
    let Ok(helper) = std::env::var("FRANK_DIRECTORY_BASE_OPENER") else {
        return false;
    };
    let result = Command::new(helper)
        .args([
            "--exact",
            "directory_preview_actual_legacy_opener",
            "--nocapture",
        ])
        .env("FRANK_DIRECTORY_LEGACY_DB", path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "actual base opener failed for {}:\n{}\n{}",
        path.display(),
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let stdout = String::from_utf8_lossy(&result.stdout);
    assert!(
        stdout.contains("running 1 test\n")
            && stdout.contains("test directory_preview_actual_legacy_opener ... ok"),
        "wrong/no-op base helper executable: {stdout}"
    );
    true
}
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
    eprintln!("retained rollback fixture: {}", path.display());
    if !base_open(&path) {
        drop(Db::open(&path).unwrap());
    }
    assert_eq!(
        names(&path),
        REVIEWED_BASE_CFS,
        "initial registry must match the reviewed base, not the candidate's own inventory"
    );
    {
        let raw =
            rocksdb::DB::open_cf(&rocksdb::Options::default(), &path, REVIEWED_BASE_CFS).unwrap();
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
    // Call the old executable before the structural assertion: the before proof must fail
    // at the real production opener, not merely predict its behavior from a CF list.
    base_open(&path);
    assert_eq!(
        names(&path),
        REVIEWED_BASE_CFS,
        "preview must not modify the legacy CF set"
    );
    {
        let raw =
            rocksdb::DB::open_cf(&rocksdb::Options::default(), &path, REVIEWED_BASE_CFS).unwrap();
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
fn directory_preview_unused_registry_still_opens_on_reviewed_base() {
    regression(false);
}
#[test]
fn directory_preview_populated_registry_still_opens_on_reviewed_base() {
    regression(true);
}
