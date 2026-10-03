//! Actual RocksDB/process/fault proof. Fixed public fixture scalars and temporary databases only.
use super::*;
use frank_cbor::{
    cbor_map, common_transcript, decode_canonical, directory_signature_digest, encode_frame,
    CborValue, EnvelopeFields, FramePayload,
};
use secp256k1_abc::{Message, Secp256k1, SecretKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{process::Command, sync::Barrier};

type ExactFrames = (Vec<u8>, Vec<u8>);

fn source() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap()
}
fn fixture(id: &str) -> ExactFrames {
    let c = source();
    let r = c["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap();
    (
        hex::decode(r["type4_hex"].as_str().unwrap()).unwrap(),
        hex::decode(r["type2_hex"].as_str().unwrap()).unwrap(),
    )
}
fn candidate(pair: &ExactFrames) -> Candidate<'_> {
    Candidate {
        statement: &pair.0,
        attestation: &pair.1,
    }
}
fn anchor() -> Anchor {
    Anchor {
        network: "monad-testnet".into(),
        subject: AccountRef {
            key_type: 1,
            key_bytes: hex::decode(
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            )
            .unwrap(),
        },
        revision_zero: hex::decode(
            "21729c888b5da6caeaf90dde5eb2c37e9c2da392e609908d75afba75b72f3a3e",
        )
        .unwrap()
        .try_into()
        .unwrap(),
    }
}
fn relay() -> RelayBinding {
    RelayBinding {
        relay_id: (0..16).collect(),
        endpoint: "https://relay.example.invalid".into(),
        identity: AccountRef {
            key_type: 1,
            key_bytes: hex::decode(
                "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
            )
            .unwrap(),
        },
        expiry: Timestamp {
            seconds: 1700007200,
            nanoseconds: 0,
        },
        unknown: vec![],
    }
}
fn context(relay: &RelayBinding) -> Context<'_> {
    Context {
        now: Some(Timestamp {
            seconds: 1700000100,
            nanoseconds: 0,
        }),
        relay: Some(relay),
    }
}
fn enroll(d: &Directory<'_>, ids: &[&str]) -> Current {
    let pairs: Vec<_> = ids.iter().map(|id| fixture(id)).collect();
    d.advance(
        &pairs.iter().map(candidate).collect::<Vec<_>>(),
        context(&relay()),
    )
    .unwrap()
}

#[test]
fn directory_preview_concurrent_successors_fork_and_clock_checks_serialize() {
    let temp = tempdir::TempDir::new("directory-preview-races").unwrap();
    let db = Db::open(temp.path()).unwrap();
    let d = db
        .directory_preview(anchor(), OpenMode::NewEnrollment)
        .unwrap();
    let start = enroll(&d, &["bootstrap"]);
    let sibling = db
        .directory_preview(anchor(), OpenMode::Reopen(start.status.checkpoint))
        .unwrap();
    let barrier = Barrier::new(2);
    let results = std::thread::scope(|s| {
        let a = s.spawn(|| {
            barrier.wait();
            let r = fixture("renew");
            d.advance(&[candidate(&r)], context(&relay()))
        });
        let b = s.spawn(|| {
            barrier.wait();
            let r = fixture("fork-of-renew");
            sibling.advance(&[candidate(&r)], context(&relay()))
        });
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(AdmissionError::Fork)))
            .count(),
        1
    );
    let status = d.status().unwrap().unwrap();
    assert!(status.forked);
    assert_eq!(status.accepted, 2);
    assert_eq!(status.retained, 3);
    let winner = results.iter().find_map(|r| r.as_ref().ok()).unwrap();
    assert_eq!(status.head, Some(winner.evidence.hash));
    assert_eq!(status.current_stamp, Some(winner.stamp_key.clone()));
    assert_eq!(status.previous_stamp, winner.previous_stamp);
    assert_eq!(
        d.current(context(&relay())).unwrap_err(),
        AdmissionError::Fork
    );
    // A pre-fork checkpoint may discover quarantine, but a fork checkpoint cannot be erased.
    let reopened = db
        .directory_preview(anchor(), OpenMode::Reopen(start.status.checkpoint))
        .unwrap();
    assert_eq!(reopened.status().unwrap().unwrap(), status);

    let other = tempdir::TempDir::new("directory-preview-clock-race").unwrap();
    let db = Db::open(other.path()).unwrap();
    let d = db
        .directory_preview(anchor(), OpenMode::NewEnrollment)
        .unwrap();
    enroll(&d, &["bootstrap"]);
    std::thread::scope(|s| {
        for nanos in [1, 2] {
            let d = &d;
            s.spawn(move || {
                let relay = relay();
                let outcome = d.current(Context {
                    now: Some(Timestamp {
                        seconds: 1700000100,
                        nanoseconds: nanos,
                    }),
                    relay: Some(&relay),
                });
                assert!(outcome.is_ok() || matches!(outcome, Err(AdmissionError::Clock)));
            });
        }
    });
    assert_eq!(d.status().unwrap().unwrap().checked_time.nanoseconds, 2);
}

#[test]
fn directory_preview_initial_fork_is_proof_only_and_does_not_grant_a_head() {
    let temp = tempdir::TempDir::new("directory-preview-initial-fork").unwrap();
    let db = Db::open(temp.path()).unwrap();
    let d = db
        .directory_preview(anchor(), OpenMode::NewEnrollment)
        .unwrap();
    let pairs = [
        fixture("bootstrap"),
        fixture("renew"),
        fixture("fork-of-renew"),
    ];
    assert_eq!(
        d.advance(
            &pairs.iter().map(candidate).collect::<Vec<_>>(),
            context(&relay())
        )
        .unwrap_err(),
        AdmissionError::Fork
    );
    let s = d.status().unwrap().unwrap();
    assert_eq!(s.accepted, 0);
    assert_eq!(s.head, None);
    assert_eq!(s.retained, 3);
    assert_eq!(
        d.current(context(&relay())).unwrap_err(),
        AdmissionError::Fork
    );
    assert!(d
        .historical_evidence(anchor().revision_zero)
        .unwrap()
        .is_none());
    assert_eq!(d.conflict_evidence().unwrap().len(), 3);
    assert_eq!(
        db.directory_preview(anchor(), OpenMode::Reopen(s.checkpoint))
            .unwrap()
            .status()
            .unwrap(),
        Some(s)
    );
}

#[test]
fn directory_preview_valid_older_database_requires_external_continuity() {
    let temp = tempdir::TempDir::new("directory-preview-rollback").unwrap();
    let live = temp.path().join("live");
    let old_copy = temp.path().join("old");
    let (older, later) = {
        let db = Db::open(&live).unwrap();
        let d = db
            .directory_preview(anchor(), OpenMode::NewEnrollment)
            .unwrap();
        let older = enroll(&d, &["bootstrap"]);
        rocksdb::checkpoint::Checkpoint::new(db.rocksdb())
            .unwrap()
            .create_checkpoint(&old_copy)
            .unwrap();
        rocksdb::checkpoint::Checkpoint::new(d.db.rocksdb())
            .unwrap()
            .create_checkpoint(old_copy.join(super::super::directory_preview_owner::SIDECAR))
            .unwrap();
        let later = enroll(&d, &["renew", "rotate-stamp"]);
        (older, later)
    };
    let db = Db::open(&old_copy).unwrap();
    // A complete, internally valid old disk is indistinguishable without the later external floor.
    let d = db
        .directory_preview(anchor(), OpenMode::Reopen(older.status.checkpoint))
        .unwrap();
    assert_eq!(d.status().unwrap(), Some(older.status));
    assert_eq!(
        db.directory_preview(anchor(), OpenMode::Reopen(later.status.checkpoint))
            .unwrap_err(),
        AdmissionError::Continuity
    );
    assert!(
        Db::open(&old_copy).is_err(),
        "RocksDB must retain its exclusive process-owner lock"
    );
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::directory_preview::tests::directory_preview_owner_lock_child",
        ])
        .env("FRANK_DIRECTORY_TEST_LOCKED_DB", &old_copy)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "a second process must fail to acquire the active database"
    );
}

#[test]
fn directory_preview_owner_lock_child() {
    if let Ok(path) = std::env::var("FRANK_DIRECTORY_TEST_LOCKED_DB") {
        assert!(
            super::super::directory_preview_owner::Owner::new(path.into())
                .open(OpenMode::NewEnrollment)
                .is_err()
        );
    }
}

#[test]
fn directory_preview_missing_or_corrupt_sidecar_never_recreates_on_reopen() {
    for fault in ["missing", "empty", "file", "current", "missing-cf"] {
        let temp = tempdir::TempDir::new("directory-preview-sidecar-loss").unwrap();
        let root = temp.path().join("registry");
        let sidecar = root.join(super::super::directory_preview_owner::SIDECAR);
        let saved = temp.path().join("preserved-sidecar");
        let prepared = Checkpoint::for_enrollment(
            &anchor(),
            candidate(&fixture("bootstrap")),
            context(&relay()).now.unwrap(),
        )
        .unwrap();
        let accepted = {
            let db = Db::open(&root).unwrap();
            let d = db
                .directory_preview(anchor(), OpenMode::NewEnrollment)
                .unwrap();
            enroll(&d, &["bootstrap", "renew"])
        };
        match fault {
            "missing" | "empty" | "file" => {
                std::fs::rename(&sidecar, &saved).unwrap();
                if fault == "empty" {
                    std::fs::create_dir(&sidecar).unwrap();
                }
                if fault == "file" {
                    std::fs::write(&sidecar, b"not a database").unwrap();
                }
            }
            "current" => {
                std::fs::rename(sidecar.join("CURRENT"), sidecar.join("CURRENT.preserved"))
                    .unwrap();
                std::fs::write(sidecar.join("CURRENT"), b"invalid manifest pointer\n").unwrap();
            }
            "missing-cf" => {
                let names = rocksdb::DB::list_cf(&rocksdb::Options::default(), &sidecar).unwrap();
                let mut raw =
                    rocksdb::DB::open_cf(&rocksdb::Options::default(), &sidecar, names).unwrap();
                rocksdb::checkpoint::Checkpoint::new(&raw)
                    .unwrap()
                    .create_checkpoint(&saved)
                    .unwrap();
                raw.drop_cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1).unwrap();
            }
            _ => unreachable!(),
        }
        // Corrupt preview artifacts do not participate in ordinary legacy startup.
        let db = Db::open(&root).unwrap();
        for checkpoint in [prepared, accepted.status.checkpoint] {
            assert_eq!(
                db.directory_preview(anchor(), OpenMode::Reopen(checkpoint))
                    .unwrap_err(),
                AdmissionError::Unavailable,
                "{fault}"
            );
        }
        if fault == "missing" {
            assert!(!sidecar.exists());
        } else {
            // Existing partial/corrupt storage is not a fresh-enrollment permission either.
            assert_eq!(
                db.directory_preview(anchor(), OpenMode::NewEnrollment)
                    .unwrap_err(),
                AdmissionError::Unavailable,
                "{fault}"
            );
        }
        if fault == "empty" {
            assert_eq!(std::fs::read_dir(&sidecar).unwrap().count(), 0);
        }
        if fault == "file" {
            assert_eq!(std::fs::read(&sidecar).unwrap(), b"not a database");
        }
        if fault == "current" {
            assert_eq!(
                std::fs::read(sidecar.join("CURRENT")).unwrap(),
                b"invalid manifest pointer\n"
            );
        }
        if fault == "missing-cf" {
            assert!(
                !rocksdb::DB::list_cf(&rocksdb::Options::default(), &sidecar)
                    .unwrap()
                    .iter()
                    .any(|name| name == CF_DIRECTORY_PREVIEW_EVIDENCE_V1)
            );
        }
    }
}

#[test]
fn directory_preview_prospective_checkpoint_preserves_digest_time_and_kind_boundaries() {
    let temp = tempdir::TempDir::new("directory-preview-prospective").unwrap();
    let prepared = Checkpoint::for_enrollment(
        &anchor(),
        candidate(&fixture("bootstrap")),
        context(&relay()).now.unwrap(),
    )
    .unwrap();
    let accepted;
    {
        let db = Db::open(temp.path()).unwrap();
        let d = db
            .directory_preview(anchor(), OpenMode::NewEnrollment)
            .unwrap();
        accepted = enroll(&d, &["bootstrap", "renew", "rotate-stamp"]);
    }
    let db = Db::open(temp.path()).unwrap();
    let d = db
        .directory_preview(anchor(), OpenMode::Reopen(prepared))
        .unwrap();
    assert_eq!(d.status().unwrap(), Some(accepted.status));
    let mut wrong_digest = prepared;
    wrong_digest.evidence_digest[0] ^= 1;
    let mut future_floor = prepared;
    future_floor.checked_time.1 += 1;
    for wrong in [wrong_digest, future_floor] {
        assert_eq!(
            db.directory_preview(anchor(), OpenMode::Reopen(wrong))
                .unwrap_err(),
            AdmissionError::Continuity
        );
    }

    // A fork checkpoint asserts retained proof and (possibly empty) past acceptance.
    // Relabeling it is not a way to turn that different fact into an enrollment token.
    let other = tempdir::TempDir::new("directory-preview-prospective-kind").unwrap();
    let db = Db::open(other.path()).unwrap();
    let d = db
        .directory_preview(anchor(), OpenMode::NewEnrollment)
        .unwrap();
    let pairs = [
        fixture("bootstrap"),
        fixture("renew"),
        fixture("fork-of-renew"),
    ];
    assert_eq!(
        d.advance(
            &pairs.iter().map(candidate).collect::<Vec<_>>(),
            context(&relay())
        )
        .unwrap_err(),
        AdmissionError::Fork
    );
    let mut relabeled = d.status().unwrap().unwrap().checkpoint;
    assert_eq!(relabeled.kind, CheckpointKind::CommittedPrefix);
    relabeled.kind = CheckpointKind::ProspectiveEnrollment;
    assert_eq!(
        db.directory_preview(anchor(), OpenMode::Reopen(relabeled))
            .unwrap_err(),
        AdmissionError::Continuity
    );
    assert_eq!(
        db.directory_preview(anchor(), OpenMode::Reopen(prepared))
            .unwrap()
            .current(context(&relay()))
            .unwrap_err(),
        AdmissionError::Fork
    );
}

#[test]
fn directory_preview_initial_fork_corruption_cannot_reopen_with_prospective_token() {
    let temp = tempdir::TempDir::new("directory-preview-initial-fork-corrupt").unwrap();
    let prepared = Checkpoint::for_enrollment(
        &anchor(),
        candidate(&fixture("bootstrap")),
        context(&relay()).now.unwrap(),
    )
    .unwrap();
    {
        let db = Db::open(temp.path()).unwrap();
        let d = db
            .directory_preview(anchor(), OpenMode::NewEnrollment)
            .unwrap();
        let pairs = [
            fixture("bootstrap"),
            fixture("renew"),
            fixture("fork-of-renew"),
        ];
        assert_eq!(
            d.advance(
                &pairs.iter().map(candidate).collect::<Vec<_>>(),
                context(&relay())
            )
            .unwrap_err(),
            AdmissionError::Fork
        );
        let meta = d.header().unwrap().unwrap();
        let state = d.load(Some(&meta)).unwrap().unwrap();
        d.db.rocksdb()
            .delete_cf(
                d.db.cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1).unwrap(),
                d.record_key(2, &state.proof[2]),
            )
            .unwrap();
    }
    let db = Db::open(temp.path()).unwrap();
    assert_eq!(
        db.directory_preview(anchor(), OpenMode::Reopen(prepared))
            .unwrap_err(),
        AdmissionError::Unavailable
    );
    assert!(db
        .directory_preview(anchor(), OpenMode::NewEnrollment)
        .is_err());
}

#[test]
fn directory_preview_corruption_and_partial_loss_fail_closed_without_deleting_other_data() {
    for fault in [
        "marker",
        "head",
        "row",
        "truncated",
        "version",
        "over-budget",
        "charge",
        "pair",
        "orphan",
        "extra",
    ] {
        let temp = tempdir::TempDir::new("directory-preview-corruption").unwrap();
        let path = temp.path().join("db");
        let checkpoint;
        {
            let db = Db::open(&path).unwrap();
            db.rocksdb()
                .put(b"unrelated-sentinel", b"preserved")
                .unwrap();
            let d = db
                .directory_preview(anchor(), OpenMode::NewEnrollment)
                .unwrap();
            checkpoint = enroll(&d, &["bootstrap", "renew", "rotate-stamp"])
                .status
                .checkpoint;
            let db = &d.db; // Fault only the isolated sidecar, never the legacy registry.
            let mut meta = d.header().unwrap().unwrap();
            let state = d.load(Some(&meta)).unwrap().unwrap();
            let cf = db.cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1).unwrap();
            match fault {
                "marker" => db
                    .rocksdb()
                    .delete_cf(db.cf(CF_DIRECTORY_PREVIEW_ENROLLMENT_V1).unwrap(), &d.key)
                    .unwrap(),
                "head" => db
                    .rocksdb()
                    .delete_cf(db.cf(CF_DIRECTORY_PREVIEW_HEAD_V1).unwrap(), &d.key)
                    .unwrap(),
                "row" => db
                    .rocksdb()
                    .delete_cf(cf, d.record_key(1, &state.history.records[1]))
                    .unwrap(),
                "truncated" => db
                    .rocksdb()
                    .put_cf(cf, d.record_key(2, &state.history.records[2]), [0, 1, 2])
                    .unwrap(),
                "version" => {
                    meta.version += 1;
                    db.rocksdb()
                        .put_cf(
                            db.cf(CF_DIRECTORY_PREVIEW_HEAD_V1).unwrap(),
                            &d.key,
                            meta.bytes().unwrap(),
                        )
                        .unwrap();
                }
                "over-budget" => {
                    meta.charged = MAX_CHARGED_BYTES + 1;
                    db.rocksdb()
                        .put_cf(
                            db.cf(CF_DIRECTORY_PREVIEW_HEAD_V1).unwrap(),
                            &d.key,
                            meta.bytes().unwrap(),
                        )
                        .unwrap();
                }
                "charge" => {
                    meta.charged -= 1;
                    db.rocksdb()
                        .put_cf(
                            db.cf(CF_DIRECTORY_PREVIEW_HEAD_V1).unwrap(),
                            &d.key,
                            meta.bytes().unwrap(),
                        )
                        .unwrap();
                }
                "pair" => {
                    meta.previous_stamp = None;
                    db.rocksdb()
                        .put_cf(
                            db.cf(CF_DIRECTORY_PREVIEW_HEAD_V1).unwrap(),
                            &d.key,
                            meta.bytes().unwrap(),
                        )
                        .unwrap();
                }
                "orphan" => {
                    for name in [
                        CF_DIRECTORY_PREVIEW_ENROLLMENT_V1,
                        CF_DIRECTORY_PREVIEW_HEAD_V1,
                    ] {
                        db.rocksdb()
                            .delete_cf(db.cf(name).unwrap(), &d.key)
                            .unwrap();
                    }
                }
                "extra" => db
                    .rocksdb()
                    .put_cf(
                        cf,
                        d.record_key(3, &state.history.records[2]),
                        &state.history.records[2].evidence.attestation,
                    )
                    .unwrap(),
                _ => unreachable!(),
            }
            assert_eq!(
                d.status().unwrap_err(),
                AdmissionError::Unavailable,
                "{fault}"
            );
            assert_eq!(
                d.current(context(&relay())).unwrap_err(),
                AdmissionError::Unavailable
            );
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.directory_preview(anchor(), OpenMode::Reopen(checkpoint))
                .unwrap_err(),
            AdmissionError::Unavailable,
            "{fault}"
        );
        assert!(
            db.directory_preview(anchor(), OpenMode::NewEnrollment)
                .is_err(),
            "{fault}"
        );
        assert_eq!(
            db.rocksdb().get(b"unrelated-sentinel").unwrap().unwrap(),
            b"preserved"
        );
    }
}

fn crash_hook(after: bool) -> Result<()> {
    if (std::env::var("FRANK_DIRECTORY_TEST_PHASE").unwrap() == "after") == after {
        std::process::exit(108);
    }
    Ok(())
}

#[test]
fn directory_preview_crash_child() {
    let Ok(path) = std::env::var("FRANK_DIRECTORY_TEST_DB") else {
        return;
    };
    let checkpoint: Checkpoint =
        serde_json::from_str(&std::env::var("FRANK_DIRECTORY_TEST_CHECKPOINT").unwrap()).unwrap();
    let db = Db::open(path).unwrap();
    let mut d = db
        .directory_preview(anchor(), OpenMode::Reopen(checkpoint))
        .unwrap();
    d.commit_hook = Some(crash_hook);
    let r = fixture("rotate-stamp");
    d.advance(&[candidate(&r)], context(&relay())).unwrap();
    panic!("hook must exit before acknowledgement");
}

#[test]
fn directory_preview_process_death_before_and_after_sync_commit_is_old_or_complete_new() {
    for phase in ["before", "after"] {
        let temp = tempdir::TempDir::new("directory-preview-crash").unwrap();
        let path = temp.path().join("db");
        let old = {
            let db = Db::open(&path).unwrap();
            let d = db
                .directory_preview(anchor(), OpenMode::NewEnrollment)
                .unwrap();
            enroll(&d, &["bootstrap", "renew"])
        };
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::directory_preview::tests::directory_preview_crash_child",
                "--nocapture",
            ])
            .env("FRANK_DIRECTORY_TEST_DB", &path)
            .env("FRANK_DIRECTORY_TEST_PHASE", phase)
            .env(
                "FRANK_DIRECTORY_TEST_CHECKPOINT",
                serde_json::to_string(&old.status.checkpoint).unwrap(),
            )
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(108));
        let db = Db::open(&path).unwrap();
        let d = db
            .directory_preview(anchor(), OpenMode::Reopen(old.status.checkpoint))
            .unwrap();
        let observed = d.current(context(&relay())).unwrap();
        if phase == "before" {
            assert_eq!(observed, old);
        } else {
            assert_eq!(observed.revision, 2);
            assert_eq!(observed.status.accepted, 3);
            assert_eq!(observed.previous_stamp, Some(old.stamp_key));
            let exact = fixture("rotate-stamp");
            assert_eq!(observed.evidence.statement, exact.0);
            assert_eq!(observed.evidence.attestation, exact.1);
            assert_eq!(
                d.advance(&[candidate(&exact)], context(&relay())).unwrap(),
                observed
            );
        }
    }
}

#[test]
fn directory_preview_write_failure_disables_handle_and_reopen_recovers_verified_state() {
    fn before(after: bool) -> Result<()> {
        if !after {
            Err(AdmissionError::Unavailable)
        } else {
            Ok(())
        }
    }
    fn after(after: bool) -> Result<()> {
        if after {
            Err(AdmissionError::Unavailable)
        } else {
            Ok(())
        }
    }
    for (committed, hook) in [(false, before as fn(bool) -> Result<()>), (true, after)] {
        for fork in [false, true] {
            let temp = tempdir::TempDir::new("directory-preview-write-failure").unwrap();
            let db = Db::open(temp.path()).unwrap();
            let mut d = db
                .directory_preview(anchor(), OpenMode::NewEnrollment)
                .unwrap();
            let old = enroll(&d, &["bootstrap", "renew"]);
            d.commit_hook = Some(hook);
            let r = fixture(if fork {
                "fork-of-renew"
            } else {
                "rotate-stamp"
            });
            assert_eq!(
                d.advance(&[candidate(&r)], context(&relay())).unwrap_err(),
                AdmissionError::Unavailable
            );
            assert_eq!(
                d.current(context(&relay())).unwrap_err(),
                AdmissionError::Unavailable
            );
            let reopened = db
                .directory_preview(anchor(), OpenMode::Reopen(old.status.checkpoint))
                .unwrap();
            if committed && fork {
                let status = reopened.status().unwrap().unwrap();
                assert!(status.forked);
                assert_eq!(status.head, old.status.head);
                assert_eq!(status.current_stamp, Some(old.stamp_key));
                assert_eq!(reopened.conflict_evidence().unwrap()[0].attestation, r.1);
                assert_eq!(
                    reopened.current(context(&relay())).unwrap_err(),
                    AdmissionError::Fork
                );
            } else {
                let recovered = reopened.current(context(&relay())).unwrap();
                if committed {
                    assert_eq!(recovered.revision, 2);
                    assert_eq!(recovered.status.accepted, 3);
                    assert_eq!(recovered.previous_stamp, Some(old.stamp_key));
                } else {
                    assert_eq!(recovered, old);
                }
            }
        }
    }
}

fn field(p: &CborValue, key: u64) -> &CborValue {
    let CborValue::Map(m) = p else { panic!("map") };
    &m.iter().find(|(k, _)| *k == key).unwrap().1
}
fn replace(p: &mut CborValue, key: u64, v: CborValue) {
    let CborValue::Map(m) = p else { panic!("map") };
    m.retain(|(k, _)| *k != key);
    m.push((key, v));
    m.sort_by_key(|(k, _)| *k);
}

/// Independent test-only signer for actual bounded histories; no production signing API.
fn chain(count: usize, padding: usize) -> (Anchor, Vec<ExactFrames>) {
    let secp = Secp256k1::new();
    let mut scalar = [0; 32];
    scalar[31] = 1;
    let secret = SecretKey::from_slice(&scalar).unwrap();
    let env = decode_canonical(&fixture("bootstrap").0[9..]).unwrap();
    let CborValue::Bytes(body) = field(&env, 3) else {
        panic!("body")
    };
    let mut payload = decode_canonical(body).unwrap();
    let mut a = anchor();
    let mut pairs = Vec::new();
    let mut previous = None;
    if padding > 0 {
        replace(&mut payload, 100, CborValue::Bytes(vec![42; padding]));
    }
    for revision in 0..count {
        replace(&mut payload, 2, CborValue::Int(revision as i128));
        replace(
            &mut payload,
            13,
            previous.map(CborValue::Bytes).unwrap_or(CborValue::Null),
        );
        let statement = encode_frame(
            EnvelopeFields {
                type_id: 4,
                schema_version: if padding > 0 { 5 } else { 4 },
                min_reader_version: 4,
            },
            FramePayload::Value(&payload),
        )
        .unwrap();
        let hash: [u8; 32] = Sha256::digest(
            common_transcript("frank/content-hash/v1", &a.network, &statement, &[]).unwrap(),
        )
        .into();
        if revision == 0 {
            a.revision_zero = hash;
        }
        previous = Some(hash.to_vec());
        let sig = secp
            .sign(
                &Message::from_slice(&directory_signature_digest(&a.network, &statement).unwrap())
                    .unwrap(),
                &secret,
            )
            .serialize_der()
            .to_vec();
        let envelope = cbor_map(vec![
            (0, CborValue::Bytes(statement.clone())),
            (
                1,
                CborValue::Array(vec![cbor_map(vec![
                    (0, CborValue::Int(1)),
                    (1, field(&payload, 1).clone()),
                    (2, CborValue::Bytes(sig)),
                ])]),
            ),
        ]);
        let wrapper = encode_frame(
            EnvelopeFields {
                type_id: 2,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&envelope),
        )
        .unwrap();
        pairs.push((statement, wrapper));
    }
    (a, pairs)
}

#[test]
fn directory_preview_actual_retention_count_and_byte_caps_are_terminal_and_linear() {
    for (count, padding) in [(MAX_STATEMENTS, 0), (34, 250000)] {
        let (a, pairs) = chain(count, padding);
        let accepted = if padding == 0 { count } else { count - 1 };
        let candidates: Vec<_> = pairs[..accepted].iter().map(candidate).collect();
        let charge: usize = pairs[..accepted]
            .iter()
            .map(|(a, b)| a.len() + b.len())
            .sum();
        assert!(charge <= MAX_CHARGED_BYTES);
        let temp = tempdir::TempDir::new("directory-preview-cap").unwrap();
        let db = Db::open(temp.path()).unwrap();
        let d = db
            .directory_preview(a.clone(), OpenMode::NewEnrollment)
            .unwrap();
        let result = d.advance(&candidates, context(&relay())).unwrap();
        assert_eq!(result.status.accepted, accepted);
        assert_eq!(result.status.charged_bytes, charge);
        let extra = if padding == 0 {
            pairs.last().unwrap()
        } else {
            &pairs[accepted]
        };
        assert_eq!(
            d.advance(&[candidate(extra)], context(&relay()))
                .unwrap_err(),
            AdmissionError::Resource
        );
        let cf = d.db.cf(CF_DIRECTORY_PREVIEW_EVIDENCE_V1).unwrap();
        let rows: Vec<_> =
            d.db.rocksdb()
                .iterator_cf(cf, IteratorMode::Start)
                .map(|r| r.unwrap())
                .collect();
        assert_eq!(rows.len(), accepted);
        assert_eq!(
            rows.iter().map(|(_, v)| v.len()).sum::<usize>(),
            pairs[..accepted].iter().map(|p| p.1.len()).sum::<usize>()
        );
        assert_eq!(
            db.directory_preview(a, OpenMode::Reopen(result.status.checkpoint))
                .unwrap()
                .status()
                .unwrap(),
            Some(result.status)
        );
    }
}

#[test]
fn directory_preview_budget_and_integer_terminal_boundaries() {
    let shared: Value = serde_json::from_str(include_str!(
        "../../../../../docs/protocol/cbor/vectors/directory-admission.json"
    ))
    .unwrap();
    for probe in shared["probes"].as_array().unwrap() {
        let accept = probe["expected"] == "accept";
        let outcome = if probe["operation"] == "counter" {
            policy::counter_follows(
                probe["prior_value"].as_str().unwrap().parse().unwrap(),
                probe["next_value"].as_str().unwrap().parse().unwrap(),
                probe["increment"].as_bool().unwrap(),
            )
        } else {
            let n = |key: &str| probe[key].as_str().unwrap().parse::<usize>().unwrap();
            policy::budget(
                n("stored_count"),
                n("stored_bytes"),
                n("incoming_count"),
                n("incoming_bytes"),
            )
            .is_ok()
        };
        assert_eq!(outcome, accept, "{}", probe["id"]);
    }
    assert!(policy::budget(4095, MAX_CHARGED_BYTES - 10, 1, 10).is_ok());
    assert_eq!(policy::budget(4096, 0, 1, 0), Err(AdmissionError::Resource));
    assert_eq!(
        policy::budget(0, MAX_CHARGED_BYTES, 0, 1),
        Err(AdmissionError::Resource)
    );
    assert_eq!(
        policy::budget(usize::MAX, 0, 1, 0),
        Err(AdmissionError::Resource)
    );
    let a = anchor();
    let mut record = policy::authenticate(&a, &fixture("bootstrap").1).unwrap();
    record.revision = u64::MAX;
    let mut h = History::default();
    h.append(record.clone());
    record.revision = 1;
    record.predecessor = Some(a.revision_zero);
    record.evidence.statement.push(0);
    assert_eq!(h.classify(&a, &record), Err(AdmissionError::Link));
    let mut old = policy::authenticate(&a, &fixture("bootstrap").1).unwrap();
    old.generations[1] = u64::MAX;
    let mut h = History::default();
    h.append(old);
    let mut next = policy::authenticate(&a, &fixture("rotate-stamp").1).unwrap();
    next.revision = 1;
    next.predecessor = Some(a.revision_zero);
    next.generations[1] = 0;
    assert_eq!(h.classify(&a, &next), Err(AdmissionError::Generation));
}
