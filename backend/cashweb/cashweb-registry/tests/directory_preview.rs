//! Public-facade conformance, exact retained bytes and real close/reopen. No private store access.
use cashweb_registry::{directory_admission::*, store::db::Db};
use frank_cbor::{decode_canonical, CborValue};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn source() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap()
}
fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/protocol/cbor/vectors/directory-admission.json"
    ))
    .unwrap()
}
fn record<'a>(source: &'a Value, id: &str) -> &'a Value {
    source["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
}
fn bytes(r: &Value, k: &str) -> Vec<u8> {
    hex::decode(r[k].as_str().unwrap()).unwrap()
}
fn hash(v: &Value) -> [u8; 32] {
    hex::decode(v.as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}
fn anchor(c: &Value, t1: [u8; 32]) -> Anchor {
    Anchor {
        network: c["network"].as_str().unwrap().into(),
        subject: AccountRef {
            key_type: 1,
            key_bytes: bytes(c, "subject"),
        },
        revision_zero: t1,
    }
}
fn get(v: &CborValue, k: u64) -> &CborValue {
    let CborValue::Map(m) = v else { panic!("map") };
    &m.iter().find(|(key, _)| *key == k).unwrap().1
}
fn integer(v: &CborValue) -> i128 {
    let CborValue::Int(n) = v else { panic!("int") };
    *n
}
fn raw(v: &CborValue) -> Vec<u8> {
    let CborValue::Bytes(b) = v else {
        panic!("bytes")
    };
    b.clone()
}
fn time(v: &CborValue) -> Timestamp {
    Timestamp {
        seconds: integer(get(v, 0)) as i64,
        nanoseconds: integer(get(v, 1)) as u32,
    }
}
fn relay(v: &Value) -> Option<RelayBinding> {
    if v.is_null() {
        return None;
    }
    let p = decode_canonical(&hex::decode(v.as_str().unwrap()).unwrap()).unwrap();
    let CborValue::Text(endpoint) = get(&p, 1) else {
        panic!("text")
    };
    Some(RelayBinding {
        relay_id: raw(get(&p, 0)),
        endpoint: endpoint.clone(),
        identity: AccountRef {
            key_type: integer(get(get(&p, 2), 0)) as u32,
            key_bytes: raw(get(get(&p, 2), 1)),
        },
        expiry: time(get(&p, 3)),
        unknown: vec![],
    })
}
fn now(v: &Value) -> Option<Timestamp> {
    v.as_str().map(|s| Timestamp {
        seconds: s.parse().unwrap(),
        nanoseconds: 0,
    })
}
fn frames(source: &Value, ids: &Value) -> Vec<(Vec<u8>, Vec<u8>)> {
    ids.as_array()
        .unwrap()
        .iter()
        .map(|id| {
            let r = record(source, id.as_str().unwrap());
            (bytes(r, "type4_hex"), bytes(r, "type2_hex"))
        })
        .collect()
}
fn candidates(frames: &[(Vec<u8>, Vec<u8>)]) -> Vec<Candidate<'_>> {
    frames
        .iter()
        .map(|(statement, attestation)| Candidate {
            statement,
            attestation,
        })
        .collect()
}
fn compare_state(directory: &Directory<'_>, source: &Value, e: &Value) {
    let status = directory.status().unwrap();
    if !e["enrolled"].as_bool().unwrap() {
        assert!(status.is_none());
        return;
    }
    let s = status.unwrap();
    assert_eq!(s.accepted as u64, e["accepted"]);
    assert_eq!(s.retained as u64, e["retained"]);
    assert_eq!(s.charged_bytes as u64, e["charged_bytes"]);
    assert_eq!(s.forked, e["forked"]);
    assert_eq!(
        s.head.map(hex::encode),
        e["head_hash"].as_str().map(str::to_owned)
    );
    assert_eq!(
        s.revision.map(|n| n.to_string()),
        e["revision"].as_str().map(str::to_owned)
    );
    assert_eq!(
        s.generations.map(|g| g.map(|n| n.to_string()).to_vec()),
        e["generations"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
    );
    assert_eq!(
        s.current_stamp.map(|k| hex::encode(k.key_bytes)),
        e["current_stamp"].as_str().map(str::to_owned)
    );
    assert_eq!(
        s.previous_stamp.map(|k| hex::encode(k.key_bytes)),
        e["previous_stamp"].as_str().map(str::to_owned)
    );
    assert_eq!(s.checked_time.seconds.to_string(), e["checked_time"][0]);
    assert_eq!(s.checked_time.nanoseconds.to_string(), e["checked_time"][1]);
    for id in e["history"].as_array().unwrap() {
        let r = record(source, id.as_str().unwrap());
        let evidence = directory
            .historical_evidence(hash(&r["t1"]))
            .unwrap()
            .unwrap();
        assert_eq!(evidence.statement, bytes(r, "type4_hex"));
        assert_eq!(evidence.attestation, bytes(r, "type2_hex"));
        assert_eq!(evidence.hash, hash(&r["t1"]));
    }
    let proof = directory.conflict_evidence().unwrap();
    assert_eq!(proof.len(), e["proof"].as_array().unwrap().len());
    for (p, id) in proof.iter().zip(e["proof"].as_array().unwrap()) {
        let r = record(source, id.as_str().unwrap());
        assert_eq!(p.statement, bytes(r, "type4_hex"));
        assert_eq!(p.attestation, bytes(r, "type2_hex"));
    }
}

#[test]
fn directory_preview_shared_policy_corpus_through_public_durable_facade() {
    let source = source();
    let c = corpus();
    assert_eq!(
        hex::encode(Sha256::digest(include_bytes!(
            "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
        ))),
        c["source"]["sha256"]
    );
    for case in c["cases"].as_array().unwrap() {
        let temp = tempdir::TempDir::new("directory-preview-corpus").unwrap();
        let path = temp.path().join("registry");
        let a = anchor(
            &c,
            if case["anchor"].is_null() {
                [0; 32]
            } else {
                hash(&case["anchor"])
            },
        );
        let seed_relay = relay(&source["synthetic_relay_cbor_hex"]).unwrap();
        let expected_checkpoint;
        {
            let db = Db::open(&path).unwrap();
            let d = db
                .directory_preview(a.clone(), OpenMode::NewEnrollment)
                .unwrap();
            let history = frames(&source, &case["history"]);
            if !history.is_empty() {
                d.advance(
                    &candidates(&history),
                    Context {
                        now: now(&case["initial_clock"]),
                        relay: Some(&seed_relay),
                    },
                )
                .unwrap();
            }
            let batch = frames(&source, &case["candidates"]);
            let trusted = relay(&case["relay"]);
            let result = d.advance(
                &candidates(&batch),
                Context {
                    now: now(&case["clock"]),
                    relay: trusted.as_ref(),
                },
            );
            let category = result
                .as_ref()
                .map(|_| "accept".to_owned())
                .unwrap_or_else(|e| e.to_string());
            assert_eq!(category, case["result"], "{}: {result:?}", case["id"]);
            compare_state(&d, &source, &case["expected"]);
            if let Ok(current) = result {
                let expected = &case["expected"];
                assert_eq!(
                    hex::encode(current.message_key.key_bytes),
                    expected["message_key"]
                );
                assert_eq!(
                    current.evidence.statement,
                    bytes(
                        record(&source, expected["head"].as_str().unwrap()),
                        "type4_hex"
                    )
                );
            }
            expected_checkpoint = d.status().unwrap().map(|s| s.checkpoint);
        }
        let db = Db::open(&path).unwrap();
        if let Some(checkpoint) = expected_checkpoint {
            let d = db
                .directory_preview(a.clone(), OpenMode::Reopen(checkpoint))
                .unwrap();
            compare_state(&d, &source, &case["expected"]);
            assert_eq!(
                db.directory_preview(a, OpenMode::NewEnrollment)
                    .unwrap_err(),
                AdmissionError::AlreadyEnrolled
            );
        } else {
            assert_eq!(
                db.directory_preview(
                    a,
                    OpenMode::Reopen(Checkpoint {
                        identity: [0; 32],
                        anchor: [0; 32],
                        head: None,
                        accepted: 0,
                        retained: 0,
                        evidence_digest: [0; 32],
                        checked_time: (0, 0),
                        forked: false,
                    })
                )
                .unwrap_err(),
                AdmissionError::Unavailable
            );
        }
    }
}

#[test]
fn directory_preview_external_prefix_allows_lost_ack_descendants_not_rollback_or_missing_state() {
    let c = corpus();
    let source = source();
    let r = record(&source, "bootstrap");
    let a = anchor(&c, hash(&r["t1"]));
    let initial = frames(&source, &serde_json::json!(["bootstrap"]));
    let later = frames(&source, &serde_json::json!(["renew", "rotate-stamp"]));
    let now = Timestamp {
        seconds: 1700000100,
        nanoseconds: 17,
    };
    let trusted = relay(&source["synthetic_relay_cbor_hex"]).unwrap();
    let context = Context {
        now: Some(now),
        relay: Some(&trusted),
    };
    let prepared = Checkpoint::for_enrollment(&a, candidates(&initial)[0], now).unwrap();
    let temp = tempdir::TempDir::new("directory-preview-continuity").unwrap();
    let path = temp.path().join("db");
    let accepted;
    {
        let db = Db::open(&path).unwrap();
        assert_eq!(
            db.directory_preview(a.clone(), OpenMode::Reopen(prepared))
                .unwrap_err(),
            AdmissionError::Unavailable
        );
        let d = db
            .directory_preview(a.clone(), OpenMode::NewEnrollment)
            .unwrap();
        accepted = d
            .advance(&candidates(&initial), context)
            .unwrap()
            .status
            .checkpoint;
        assert_eq!(prepared, accepted);
        d.advance(&candidates(&later), context).unwrap(); // Lost acknowledgement, caller still pins initial.
    }
    let db = Db::open(&path).unwrap();
    let d = db
        .directory_preview(a.clone(), OpenMode::Reopen(accepted))
        .unwrap();
    let before = d.current(context).unwrap();
    assert_eq!(before.revision, 2);
    // Retry the last exact head (a whole already-applied old batch is a rollback, not a retry).
    let retry = d.advance(&candidates(&later)[1..], context).unwrap();
    assert_eq!(retry, before);
    for mut wrong in [accepted; 4].into_iter().enumerate() {
        match wrong.0 {
            0 => wrong.1.identity[0] ^= 1,
            1 => wrong.1.evidence_digest[0] ^= 1,
            2 => wrong.1.head = Some([0; 32]),
            _ => wrong.1.checked_time = (now.seconds, now.nanoseconds + 1),
        }
        assert_eq!(
            db.directory_preview(a.clone(), OpenMode::Reopen(wrong.1))
                .unwrap_err(),
            AdmissionError::Continuity
        );
    }
    let fresh = Db::open(temp.path().join("missing")).unwrap();
    assert_eq!(
        fresh
            .directory_preview(a, OpenMode::Reopen(accepted))
            .unwrap_err(),
        AdmissionError::Unavailable
    );
}

#[test]
fn directory_preview_preflight_pair_mismatch_and_nanosecond_boundary() {
    let c = corpus();
    let source = source();
    let r = record(&source, "bootstrap");
    let temp = tempdir::TempDir::new("directory-preview-preflight").unwrap();
    let db = Db::open(temp.path()).unwrap();
    let d = db
        .directory_preview(anchor(&c, hash(&r["t1"])), OpenMode::NewEnrollment)
        .unwrap();
    let relay = relay(&source["synthetic_relay_cbor_hex"]).unwrap();
    let t = Timestamp {
        seconds: 1700000100,
        nanoseconds: 0,
    };
    let context = Context {
        now: Some(t),
        relay: Some(&relay),
    };
    let wrapper = bytes(r, "type2_hex");
    let statement = bytes(r, "type4_hex");
    let bad = Candidate {
        statement: &[],
        attestation: &wrapper,
    };
    assert_eq!(
        d.advance(&vec![bad; MAX_STATEMENTS + 1], context)
            .unwrap_err(),
        AdmissionError::Resource
    );
    assert_eq!(
        d.advance(&[bad], context).unwrap_err(),
        AdmissionError::Evidence
    );
    assert!(d.status().unwrap().is_none());
    let before = d
        .advance(
            &[Candidate {
                statement: &statement,
                attestation: &wrapper,
            }],
            context,
        )
        .unwrap();
    let just_before = Timestamp {
        seconds: 1700003599,
        nanoseconds: 999999999,
    };
    let later = d
        .current(Context {
            now: Some(just_before),
            relay: Some(&relay),
        })
        .unwrap();
    assert_ne!(before.status.checkpoint, later.status.checkpoint);
    assert_eq!(d.current(context).unwrap_err(), AdmissionError::Clock);
    assert_eq!(
        d.current(Context {
            now: Some(Timestamp {
                seconds: 1700003600,
                nanoseconds: 0
            }),
            relay: Some(&relay)
        })
        .unwrap_err(),
        AdmissionError::Validity
    );
    assert_eq!(d.status().unwrap().unwrap(), later.status);
}
