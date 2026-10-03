//! Opt-in release assessment through the unchanged public facade; never a latency/SLO gate.
//!
//! Run the ignored test with --release --nocapture --test-threads=1 and set
//! FRANK_DIRECTORY_PERF_DIR to an empty frank-768-fixtures.* temporary directory and
//! FRANK_DIRECTORY_PERF_ARTIFACTS to an owned frank-768-artifacts.* directory. Closed sample
//! databases are archived, extracted and hash-verified before their exact live copies are removed.
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
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Barrier,
    time::Instant,
};

type Frames = (Vec<u8>, Vec<u8>);

fn nanos(duration: std::time::Duration) -> u64 {
    duration
        .as_nanos()
        .try_into()
        .expect("measurement fits u64 nanoseconds")
}

#[test]
fn directory_preview_performance_timing_json_supports_pinned_serializer() {
    let value = json!({"duration_ns": nanos(std::time::Duration::new(1, 234))});
    assert_eq!(value["duration_ns"].as_u64(), Some(1_000_000_234));
    assert_eq!(
        json!(nanos(std::time::Duration::from_nanos(u64::MAX))).as_u64(),
        Some(u64::MAX)
    );
    assert!(std::panic::catch_unwind(|| nanos(std::time::Duration::new(u64::MAX, 0))).is_err());
}

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
    artifacts: PathBuf,
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

    // Only generated, closed per-sample directories are eligible. Archives/manifests and
    // every pre-existing artifact remain intact. Recovery is ordinary `tar -xzf`.
    fn archive(&self, path: &Path) {
        assert_eq!(path.parent(), Some(self.root.as_path()));
        assert_eq!(path.canonicalize().unwrap(), path);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(!name.starts_with('.'));
        let archives = self.artifacts.join("fixtures-archive");
        let archive = archives.join(format!("{name}.tar.gz"));
        let manifest_path = archives.join(format!("{name}.manifest.json"));
        let extracted = self.root.join(format!("verify-{name}"));
        assert!(!archive.exists() && !manifest_path.exists() && !extracted.exists());
        let original = manifest(path);
        assert!(Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&self.root)
            .arg(name)
            .env("COPYFILE_DISABLE", "1")
            .status()
            .unwrap()
            .success());
        fs::create_dir(&extracted).unwrap();
        assert!(Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&extracted)
            .status()
            .unwrap()
            .success());
        assert_eq!(manifest(&extracted.join(name)), original);
        // Ensure no unexpected extraction roots; no symlinks are permitted by manifest().
        assert_eq!(extracted.read_dir().unwrap().count(), 1);
        assert_eq!(manifest(path), original, "fixture changed after close");
        let archive_bytes = fs::metadata(&archive).unwrap().len();
        let archive_hash = hex::encode(Sha256::digest(fs::read(&archive).unwrap()));
        let evidence = json!({"fixture":name, "files":original,
            "archive_sha256":archive_hash, "archive_bytes":archive_bytes,
            "recovery":"tar -xzf <archive> -C <empty-recovery-directory>"});
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest_path)
            .unwrap();
        use std::io::Write;
        file.write_all(serde_json::to_string_pretty(&evidence).unwrap().as_bytes())
            .unwrap();
        file.sync_all().unwrap();
        fs::File::open(&archive).unwrap().sync_all().unwrap();
        // These are the only deletions: exact fresh paths, after byte-for-byte recoverability.
        fs::remove_dir_all(&extracted).unwrap();
        fs::remove_dir_all(path).unwrap();
        println!(
            "{}",
            json!({"event":"fixture_archived", "fixture":name,
            "archive":archive, "manifest":manifest_path, "archive_bytes":archive_bytes,
            "archive_sha256":archive_hash, "verified_extract":true})
        );
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
                "start_ns": nanos(start.duration_since(self.epoch)),
                "end_ns": nanos(end.duration_since(self.epoch)),
                "duration_ns": nanos(end.duration_since(start)),
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

fn manifest(root: &Path) -> Vec<(String, u64, String)> {
    fn visit(root: &Path, path: &Path, files: &mut Vec<(String, u64, String)>) {
        let meta = fs::symlink_metadata(path).unwrap();
        assert!(!meta.file_type().is_symlink(), "no fixture symlinks");
        if meta.is_dir() {
            for entry in path.read_dir().unwrap() {
                visit(root, &entry.unwrap().path(), files);
            }
        } else {
            assert!(meta.is_file(), "regular files only");
            files.push((
                path.strip_prefix(root).unwrap().to_str().unwrap().into(),
                meta.len(),
                hex::encode(Sha256::digest(fs::read(path).unwrap())),
            ));
        }
    }
    let mut files = vec![];
    visit(root, root, &mut files);
    files.sort();
    files
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
            "sample": sample, "warmup": sample == 0, "duration_ns": nanos(total.elapsed())})
        );
        drop(d);
        drop(db);
        b.archive(&path);
    }
}

fn updates(b: &Bench, h: &History) {
    for before in [1, 128, 4095] {
        let samples = if before < 4095 { 5 } else { 3 };
        for sample in 0..=samples {
            let path = b.path(&format!("update-{before}"), sample);
            let db = Db::open(&path).unwrap();
            let d = db
                .directory_preview(h.anchor.clone(), OpenMode::NewEnrollment)
                .unwrap();
            b.advance(&d, h, 0..before, "update.prepare", sample, true);
            b.advance(&d, h, before..before + 1, "short_update", sample, false);
            drop(d);
            drop(db);
            b.archive(&path);
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
            "charged_bytes":h.charge(count), "duration_ns":nanos(total.elapsed())})
        );
        let state = d.status().unwrap().unwrap();
        h.verify(&state, count);
        assert_eq!(state.checkpoint, checkpoint);
        drop(d);
        drop(db);
        b.archive(&path);
    }
}

fn catchup(b: &Bench, h: &History, count: usize, prefix: usize, label: &str) {
    let r = relay();
    for sample in 0..=3 {
        let path = b.path(label, sample);
        let db = Db::open(&path).unwrap();
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
        drop(d);
        drop(db);
        b.archive(&path);
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
        // Complete and archive baseline first: only one live workload DB at a time.
        let isolated_path = b.path(&format!("{label}.isolated"), sample);
        let isolated_db = Db::open(&isolated_path).unwrap();
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
        drop(isolated);
        drop(isolated_db);
        b.archive(&isolated_path);
        let path = b.path(label, sample);
        let db = Db::open(&path).unwrap();
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
        drop(da);
        drop(db_subject);
        drop(db);
        b.archive(&path);
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
        let db = Db::open(&path).unwrap();
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
        drop(d);
        drop(db);
        b.archive(&path);
    }
}

#[test]
#[ignore = "explicit release-only assessment; preserves verified fixture archives and timing JSON"]
fn directory_preview_release_assessment() {
    assert!(
        !cfg!(debug_assertions),
        "measure an optimized release artifact"
    );
    let root = PathBuf::from(
        std::env::var_os("FRANK_DIRECTORY_PERF_DIR").expect("explicit evidence directory"),
    )
    .canonicalize()
    .unwrap();
    let artifacts = PathBuf::from(
        std::env::var_os("FRANK_DIRECTORY_PERF_ARTIFACTS")
            .expect("explicit owned artifact directory"),
    )
    .canonicalize()
    .unwrap();
    let temporary_root = Path::new("/private/tmp").canonicalize().unwrap();
    assert_eq!(root.parent(), Some(temporary_root.as_path()));
    assert_eq!(artifacts.parent(), Some(temporary_root.as_path()));
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("frank-768-fixtures."));
    assert!(artifacts
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("frank-768-artifacts."));
    assert!(
        root.is_dir() && root.read_dir().unwrap().next().is_none(),
        "empty evidence directory required"
    );
    let production_revision = std::env::var("FRANK_DIRECTORY_PERF_PRODUCTION_REVISION")
        .expect("record the actual linked production revision; do not infer it from this driver");
    assert_eq!(production_revision.len(), 40);
    assert!(production_revision.bytes().all(|b| b.is_ascii_hexdigit()));
    let archives = artifacts.join("fixtures-archive");
    if archives.exists() {
        assert!(
            archives.read_dir().unwrap().next().is_none(),
            "preserve any earlier run's archives"
        );
    } else {
        fs::create_dir(&archives).unwrap();
    }
    let b = Bench {
        root,
        artifacts,
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
    assert!(b.root.read_dir().unwrap().next().is_none());
    assert_eq!(
        b.artifacts
            .join("fixtures-archive")
            .read_dir()
            .unwrap()
            .count(),
        74 * 2
    );
    println!(
        "{}",
        json!({"event":"complete", "duration_ns":nanos(b.epoch.elapsed())})
    );
}
