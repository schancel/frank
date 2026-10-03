//! Regression is source-compatible with the first checkpoint (c6d7651): it fails there at reopen.
use cashweb_registry::{directory_admission::*, store::db::Db};
use frank_cbor::{verify_preview_directory_evidence, TypedPayload};
use serde_json::Value;

#[test]
fn directory_preview_initial_fork_reopen_uses_prepared_checkpoint() {
    let source: Value = serde_json::from_str(include_str!(
        "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap();
    let pairs: Vec<_> = ["bootstrap", "renew", "fork-of-renew"]
        .iter()
        .map(|id| {
            let r = source["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == *id)
                .unwrap();
            (
                hex::decode(r["type4_hex"].as_str().unwrap()).unwrap(),
                hex::decode(r["type2_hex"].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let candidates: Vec<_> = pairs
        .iter()
        .map(|(statement, attestation)| Candidate {
            statement,
            attestation,
        })
        .collect();
    let fixture = verify_preview_directory_evidence(&pairs[0].1, "monad-testnet").unwrap();
    let Some(TypedPayload::DirectoryStatement {
        subject, relays, ..
    }) = fixture.statement_frame().typed.as_deref()
    else {
        panic!("fixture")
    };
    let anchor = Anchor {
        network: "monad-testnet".into(),
        subject: subject.clone(),
        revision_zero: fixture.statement_hash,
    };
    let now = Timestamp {
        seconds: 1700000100,
        nanoseconds: 0,
    };
    let context = Context {
        now: Some(now),
        relay: Some(&relays[0]),
    };
    let prepared = Checkpoint::for_enrollment(&anchor, candidates[0], now).unwrap();
    let temp = tempdir::TempDir::new("directory-preview-initial-fork-regression").unwrap();
    let path = temp.path().join("db");
    {
        let db = Db::open(&path).unwrap();
        let d = db
            .directory_preview(anchor.clone(), OpenMode::NewEnrollment)
            .unwrap();
        assert_eq!(
            d.advance(&candidates, context).unwrap_err(),
            AdmissionError::Fork
        );
    }
    let db = Db::open(&path).unwrap();
    let d = db
        .directory_preview(anchor.clone(), OpenMode::Reopen(prepared))
        .expect("prepared exact anchor must recover retained fork after lost acknowledgement");
    let status = d.status().unwrap().unwrap();
    assert!(status.forked);
    assert_eq!(status.accepted, 0);
    assert_eq!(status.head, None);
    assert_eq!(status.retained, 3);
    assert_eq!(d.conflict_evidence().unwrap().len(), 3);
    assert_eq!(d.current(context).unwrap_err(), AdmissionError::Fork);
    assert_eq!(
        db.directory_preview(anchor, OpenMode::NewEnrollment)
            .unwrap_err(),
        AdmissionError::AlreadyEnrolled
    );
}
