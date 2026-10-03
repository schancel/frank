//! Opt-in release assessment through the unchanged public facade; never a latency/SLO gate.
//!
//! Run the ignored test with --release --nocapture --test-threads=1 and set
//! FRANK_DIRECTORY_PERF_DIR to an empty evidence directory. Databases are preserved there.
//! JSON lines distinguish preparation, warm-up and measured calls. Timing is caller-observed:
//! no internal mutex acquisition/queue length, OS-cache eviction or cold-disk claim is made.
use cashweb_registry::{directory_admission::*, store::db::Db};
use frank_cbor::{
    cbor_map, common_transcript, decode_canonical, directory_signature_digest, encode_frame,
    CborValue, EnvelopeFields, FramePayload,
};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Barrier, time::Instant};

type Frames = (Vec<u8>, Vec<u8>);

fn field(value: &CborValue, key: u64) -> &CborValue {
    let CborValue::Map(fields) = value else {
        panic!("map")
    };
    &fields.iter().find(|(k, _)| *k == key).unwrap().1
}

fn replace(value: &mut CborValue, key: u64, replacement: CborValue) {
    let CborValue::Map(fields) = value else {
        panic!("map")
    };
    fields.retain(|(k, _)| *k != key);
    fields.push((key, replacement));
    fields.sort_by_key(|(k, _)| *k);
}

struct History {
    anchor: Anchor,
    frames: Vec<Frames>,
}

impl History {
    /// Public fixture scalars only. Parameter 5 gives the competing subject a distinct P;
    /// unchanged fixture M/S and authenticated relay are valid for either subject.
    fn signed(count: usize, padding: usize, scalar: u8) -> Self {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../docs/protocol/proposals/suite1-directory/vectors.json"
        ))
        .unwrap();
        let record = fixture["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "bootstrap")
            .unwrap();
        let seed = hex::decode(record["type4_hex"].as_str().unwrap()).unwrap();
        let env = decode_canonical(&seed[9..]).unwrap();
        let CborValue::Bytes(body) = field(&env, 3) else {
            panic!("body")
        };
        let mut payload = decode_canonical(body).unwrap();
        let secp = Secp256k1::new();
        let mut bytes = [0; 32];
        bytes[31] = scalar;
        let secret = SecretKey::from_slice(&bytes).unwrap();
        let point = PublicKey::from_secret_key(&secp, &secret)
            .serialize()
            .to_vec();
        replace(
            &mut payload,
            1,
            cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Bytes(point.clone())),
            ]),
        );
        if padding > 0 {
            replace(&mut payload, 100, CborValue::Bytes(vec![42; padding]));
        }
        let mut anchor = Anchor {
            network: "monad-testnet".into(),
            subject: AccountRef {
                key_type: 1,
                key_bytes: point,
            },
            revision_zero: [0; 32],
        };
        let mut frames = Vec::with_capacity(count);
        let mut previous = None;
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
                common_transcript("frank/content-hash/v1", &anchor.network, &statement, &[])
                    .unwrap(),
            )
            .into();
            if revision == 0 {
                anchor.revision_zero = hash;
            }
            previous = Some(hash.to_vec());
            let signature = secp
                .sign(
                    &Message::from_slice(
                        &directory_signature_digest(&anchor.network, &statement).unwrap(),
                    )
                    .unwrap(),
                    &secret,
                )
                .serialize_der()
                .to_vec();
            let wrapper = encode_frame(
                EnvelopeFields {
                    type_id: 2,
                    schema_version: 1,
                    min_reader_version: 1,
                },
                FramePayload::Value(&cbor_map(vec![
                    (0, CborValue::Bytes(statement.clone())),
                    (
                        1,
                        CborValue::Array(vec![cbor_map(vec![
                            (0, CborValue::Int(1)),
                            (1, field(&payload, 1).clone()),
                            (2, CborValue::Bytes(signature)),
                        ])]),
                    ),
                ])),
            )
            .unwrap();
            assert!(statement.len() <= MAX_FRAME_BYTES && wrapper.len() <= MAX_FRAME_BYTES);
            frames.push((statement, wrapper));
        }
        Self { anchor, frames }
    }

    fn candidates(&self, start: usize, end: usize) -> Vec<Candidate<'_>> {
        self.frames[start..end]
            .iter()
            .map(|(statement, attestation)| Candidate {
                statement,
                attestation,
            })
            .collect()
    }

    fn charge(&self, n: usize) -> usize {
        self.frames[..n]
            .iter()
            .map(|(s, a)| s.len() + a.len())
            .sum()
    }

    fn verify(&self, status: &Status, n: usize) {
        assert_eq!(status.accepted, n);
        assert_eq!(status.retained, n);
        assert_eq!(status.charged_bytes, self.charge(n));
        assert_eq!(status.revision, Some((n - 1) as u64));
        assert!(!status.forked);
        let hash: [u8; 32] = Sha256::digest(
            common_transcript(
                "frank/content-hash/v1",
                &self.anchor.network,
                &self.frames[n - 1].0,
                &[],
            )
            .unwrap(),
        )
        .into();
        assert_eq!(status.head, Some(hash));
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

fn context(relay: &RelayBinding, nanos: u32) -> Context<'_> {
    Context {
        now: Some(Timestamp {
            seconds: 1700000100,
            nanoseconds: nanos,
        }),
        relay: Some(relay),
    }
}

struct Bench {
    root: PathBuf,
    epoch: Instant,
}

impl Bench {
    fn path(&self, name: &str, sample: usize) -> PathBuf {
        let path = self.root.join(format!("{name}-{sample}"));
        assert!(
            !path.exists(),
            "evidence path already exists: {}",
            path.display()
        );
        path
    }

    fn measure<T>(
        &self,
        name: &str,
        sample: usize,
        rows: usize,
        charge: usize,
        preparation: bool,
        call: impl FnOnce() -> T,
    ) -> T {
        let start = Instant::now();
        let result = call();
        let end = Instant::now();
        println!(
            "{}",
            json!({
                "event": "timing", "operation": name, "sample": sample,
                "phase": if preparation { "preparation" } else if sample == 0 { "warmup" } else { "measured" },
                "retained_records": rows, "charged_bytes": charge,
                "start_ns": start.duration_since(self.epoch).as_nanos(),
                "end_ns": end.duration_since(self.epoch).as_nanos(),
                "duration_ns": end.duration_since(start).as_nanos(),
                "metric": "caller_observed_call_not_internal_mutex_wait"
            })
        );
        result
    }

    fn advance(
        &self,
        d: &Directory<'_>,
        history: &History,
        range: std::ops::Range<usize>,
        name: &str,
        sample: usize,
        preparation: bool,
    ) -> Current {
        let candidates = history.candidates(range.start, range.end);
        let relay = relay();
        let result = self
            .measure(
                name,
                sample,
                range.end,
                history.charge(range.end),
                preparation,
                || d.advance(&candidates, context(&relay, 0)),
            )
            .unwrap();
        history.verify(&result.status, range.end);
        result
    }
}

fn enrollments(b: &Bench, h: &History) {
    for sample in 0..=5 {
        let path = b.path("enroll", sample);
        let total = Instant::now();
        let db = b
            .measure("enroll.registry_open", sample, 0, 0, false, || {
                Db::open(&path)
            })
            .unwrap();
        let d = b
            .measure("enroll.sidecar_open", sample, 0, 0, false, || {
                db.directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
            })
            .unwrap();
        b.advance(&d, h, 0..1, "enroll.advance", sample, false);
        println!(
            "{}",
            json!({"event":"combined", "operation":"enroll.total_with_driver_bookkeeping",
            "sample": sample, "warmup": sample == 0, "duration_ns": total.elapsed().as_nanos()})
        );
    }
}

fn updates(b: &Bench, h: &History) {
    for before in [1, 128, 4095] {
        let samples = if before < 4095 { 5 } else { 3 };
        for sample in 0..=samples {
            let db = Db::open(b.path(&format!("update-{before}"), sample)).unwrap();
            let d = db
                .directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
                .unwrap();
            b.advance(&d, h, 0..before, "update.prepare", sample, true);
            b.advance(&d, h, before..before + 1, "short_update", sample, false);
        }
    }
}

fn current_and_reopen(b: &Bench, h: &History, count: usize, label: &str) {
    let samples = if count <= 128 && h.charge(count) < 1_000_000 {
        5
    } else {
        3
    };
    let r = relay();
    for sample in 0..=samples {
        let path = b.path(&format!("read-{label}"), sample);
        let checkpoint = {
            let db = Db::open(&path).unwrap();
            let d = db
                .directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
                .unwrap();
            b.advance(&d, h, 0..count, "read.prepare", sample, true);
            for (name, clock) in [
                ("current.same_clock", 0),
                ("current.advance_clock", 1),
                ("current.repeat_clock", 1),
            ] {
                let current = b
                    .measure(name, sample, count, h.charge(count), false, || {
                        d.current(context(&r, clock))
                    })
                    .unwrap();
                h.verify(&current.status, count);
                assert_eq!(current.status.checked_time.nanoseconds, clock);
            }
            d.status().unwrap().unwrap().checkpoint
        };
        // Every handle is dropped; OS page-cache state is deliberately uncontrolled.
        let total = Instant::now();
        let db = b
            .measure(
                "reopen.registry_open",
                sample,
                count,
                h.charge(count),
                false,
                || Db::open(&path),
            )
            .unwrap();
        let d = b
            .measure(
                "reopen.authenticated_directory",
                sample,
                count,
                h.charge(count),
                false,
                || db.directory_preview(h.anchor.clone(), OpenMode::Reopen(checkpoint)),
            )
            .unwrap();
        println!(
            "{}",
            json!({"event":"combined", "operation":"reopen.total_with_driver_bookkeeping",
            "sample":sample, "warmup":sample == 0, "retained_records":count,
            "charged_bytes":h.charge(count), "duration_ns":total.elapsed().as_nanos()})
        );
        let state = d.status().unwrap().unwrap();
        h.verify(&state, count);
        assert_eq!(state.checkpoint, checkpoint);
    }
}

fn catchup(b: &Bench, h: &History, count: usize, prefix: usize, label: &str) {
    let r = relay();
    for sample in 0..=3 {
        let db = Db::open(b.path(label, sample)).unwrap();
        let d = db
            .directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
            .unwrap();
        if prefix > 0 {
            b.advance(&d, h, 0..prefix, "catchup.prepare", sample, true);
        }
        let result = b.advance(&d, h, prefix..count, label, sample, false);
        let extra = h.candidates(count, count + 1);
        let failure = b
            .measure(
                &format!("{label}.over_limit"),
                sample,
                count,
                h.charge(count),
                false,
                || d.advance(&extra, context(&r, 0)),
            )
            .unwrap_err();
        assert_eq!(failure, AdmissionError::Resource);
        assert_eq!(d.status().unwrap().unwrap(), result.status);
    }
}

fn competing_subjects(b: &Bench, a: &History, other: &History, catch_up: bool) {
    let label = if catch_up {
        "competing.catchup_update"
    } else {
        "competing.current_current"
    };
    let r = relay();
    for sample in 0..=3 {
        let db = Db::open(b.path(label, sample)).unwrap();
        let da = db
            .directory_preview(a.anchor.clone(), OpenMode::NewEnrollment)
            .unwrap();
        let db_subject = db
            .directory_preview(other.anchor.clone(), OpenMode::NewEnrollment)
            .unwrap();
        b.advance(
            &da,
            a,
            0..if catch_up { 1 } else { MAX_STATEMENTS },
            "competing.prepare_a",
            sample,
            true,
        );
        b.advance(
            &db_subject,
            other,
            0..1,
            "competing.prepare_b",
            sample,
            true,
        );
        // Isolated B baseline uses a separate fresh DB with the same initial state.
        let isolated_db = Db::open(b.path(&format!("{label}.isolated"), sample)).unwrap();
        let isolated = isolated_db
            .directory_preview(other.anchor.clone(), OpenMode::NewEnrollment)
            .unwrap();
        b.advance(
            &isolated,
            other,
            0..1,
            "competing.prepare_isolated",
            sample,
            true,
        );
        let small = other.candidates(1, 2);
        let baseline = b
            .measure(
                &format!("{label}.b_isolated"),
                sample,
                if catch_up { 2 } else { 1 },
                other.charge(if catch_up { 2 } else { 1 }),
                false,
                || {
                    if catch_up {
                        isolated.advance(&small, context(&r, 0))
                    } else {
                        isolated.current(context(&r, 1))
                    }
                },
            )
            .unwrap();
        other.verify(&baseline.status, if catch_up { 2 } else { 1 });
        let large = a.candidates(1, MAX_STATEMENTS);
        let barrier = Barrier::new(2);
        // Alternate spawn order, not an assertion about unobservable mutex acquisition order.
        let large_call = || {
            barrier.wait();
            b.measure(
                &format!("{label}.a_contended"),
                sample,
                MAX_STATEMENTS,
                a.charge(MAX_STATEMENTS),
                false,
                || {
                    if catch_up {
                        da.advance(&large, context(&r, 0))
                    } else {
                        da.current(context(&r, 1))
                    }
                },
            )
            .unwrap()
        };
        let small_call = || {
            barrier.wait();
            b.measure(
                &format!("{label}.b_contended"),
                sample,
                if catch_up { 2 } else { 1 },
                other.charge(if catch_up { 2 } else { 1 }),
                false,
                || {
                    if catch_up {
                        db_subject.advance(&small, context(&r, 0))
                    } else {
                        db_subject.current(context(&r, 1))
                    }
                },
            )
            .unwrap()
        };
        let (ra, rb) = std::thread::scope(|scope| {
            if sample % 2 == 0 {
                let ta = scope.spawn(large_call);
                let tb = scope.spawn(small_call);
                (ta.join().unwrap(), tb.join().unwrap())
            } else {
                let tb = scope.spawn(small_call);
                let ta = scope.spawn(large_call);
                (ta.join().unwrap(), tb.join().unwrap())
            }
        });
        a.verify(&ra.status, MAX_STATEMENTS);
        other.verify(&rb.status, if catch_up { 2 } else { 1 });
        assert_ne!(ra.status.checkpoint.identity, rb.status.checkpoint.identity);
    }
}

fn competing_clocks(b: &Bench, h: &History) {
    let r = relay();
    for sample in 0..=3 {
        let path = b.path("competing.clocks", sample);
        let checkpoint = {
            let db = Db::open(&path).unwrap();
            let d = db
                .directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
                .unwrap();
            let initial = b.advance(&d, h, 0..128, "clocks.prepare", sample, true);
            let sibling = db
                .directory_preview(
                    h.anchor.clone(),
                    OpenMode::Reopen(initial.status.checkpoint),
                )
                .unwrap();
            let barrier = Barrier::new(2);
            std::thread::scope(|scope| {
                let low = scope.spawn(|| {
                    barrier.wait();
                    b.measure(
                        "competing.clock_low",
                        sample,
                        128,
                        h.charge(128),
                        false,
                        || d.current(context(&r, 1)),
                    )
                });
                let high = scope.spawn(|| {
                    barrier.wait();
                    b.measure(
                        "competing.clock_high",
                        sample,
                        128,
                        h.charge(128),
                        false,
                        || sibling.current(context(&r, 2)),
                    )
                });
                let low = low.join().unwrap();
                let high = high.join().unwrap().unwrap();
                assert!(low.is_ok() || low == Err(AdmissionError::Clock));
                h.verify(&high.status, 128);
                println!(
                    "{}",
                    json!({"event":"clock_outcome", "sample":sample,
                    "low": if low.is_ok() { "accept" } else { "clock" }, "high":"accept"})
                );
            });
            let status = d.status().unwrap().unwrap();
            assert_eq!(status.checked_time.nanoseconds, 2);
            status.checkpoint
        };
        let db = Db::open(path).unwrap();
        let d = db
            .directory_preview(h.anchor.clone(), OpenMode::Reopen(checkpoint))
            .unwrap();
        assert_eq!(
            d.current(context(&r, 1)).unwrap_err(),
            AdmissionError::Clock
        );
        let current = d.current(context(&r, 2)).unwrap();
        h.verify(&current.status, 128);
        assert_eq!(current.status.checkpoint, checkpoint);
    }
}

#[test]
#[ignore = "explicit release-only assessment; preserves databases and emits timing JSON"]
fn directory_preview_release_assessment() {
    assert!(
        !cfg!(debug_assertions),
        "measure an optimized release artifact"
    );
    let root = PathBuf::from(
        std::env::var_os("FRANK_DIRECTORY_PERF_DIR").expect("explicit evidence directory"),
    );
    assert!(
        root.is_dir() && root.read_dir().unwrap().next().is_none(),
        "empty evidence directory required"
    );
    let production_revision = std::env::var("FRANK_DIRECTORY_PERF_PRODUCTION_REVISION")
        .expect("record the actual linked production revision; do not infer it from this driver");
    assert_eq!(production_revision.len(), 40);
    assert!(production_revision.bytes().all(|b| b.is_ascii_hexdigit()));
    let b = Bench {
        root,
        epoch: Instant::now(),
    };
    let h = b.measure("fixture.sign_record_cap", 0, 0, 0, true, || {
        History::signed(MAX_STATEMENTS + 1, 0, 1)
    });
    let padded = b.measure("fixture.sign_byte_cap", 0, 0, 0, true, || {
        History::signed(34, 250_000, 1)
    });
    let other = b.measure("fixture.sign_second_subject", 0, 0, 0, true, || {
        History::signed(2, 0, 5)
    });
    assert!(h.charge(MAX_STATEMENTS) <= MAX_CHARGED_BYTES);
    assert!(padded.charge(33) <= MAX_CHARGED_BYTES && padded.charge(34) > MAX_CHARGED_BYTES);
    println!(
        "{}",
        json!({"event":"configuration", "record_cap":MAX_STATEMENTS,
        "byte_cap":MAX_CHARGED_BYTES, "near_byte_cap_records":33,
        "near_byte_cap_charge":padded.charge(33), "near_byte_cap_headroom":MAX_CHARGED_BYTES-padded.charge(33),
        "max_benchmark_workers":2, "internal_lock_timing":false, "os_cache":"uncontrolled",
        "fixture_root":b.root, "production_revision":production_revision})
    );
    enrollments(&b, &h);
    updates(&b, &h);
    for count in [1, 128, MAX_STATEMENTS] {
        current_and_reopen(&b, &h, count, &count.to_string());
    }
    current_and_reopen(&b, &padded, 33, "near-byte-cap");
    catchup(&b, &h, MAX_STATEMENTS, 0, "catchup.record_cap_fresh");
    catchup(&b, &h, MAX_STATEMENTS, 1, "catchup.record_cap_prefix");
    catchup(&b, &padded, 33, 0, "catchup.near_byte_cap");
    competing_subjects(&b, &h, &other, false);
    competing_subjects(&b, &h, &other, true);
    competing_clocks(&b, &h);
    println!(
        "{}",
        json!({"event":"complete", "duration_ns":b.epoch.elapsed().as_nanos()})
    );
}
