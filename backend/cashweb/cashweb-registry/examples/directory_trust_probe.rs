//! Disposable demo consumer of the public admission facade. One absolute JSON scenario path
//! is the only argument. The operator supplies the independently checked public #758 snapshot,
//! installed trust, explicit clock, dedicated database, and external continuity file.
//! This example neither provisions trust nor reads provisioning files. No runtime defaults.
use std::{
    fmt,
    fs::{self, File},
    io::{self, Read, Write},
    marker::PhantomData,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use cashweb_registry::{directory_admission::*, store::db::Db};
use native_tls::{Certificate, TlsConnector};
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_CONFIG: usize = MAX_CHARGED_BYTES * 2 + 1_048_576;
const MAX_CONTINUITY: usize = 65_536;
const MAX_HEADERS: usize = 16_384;
const MAX_BODY: usize = 600_000;
const TRANSPORT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
enum Error {
    Input(&'static str),
    Admission(AdmissionError),
}
type Result<T> = std::result::Result<T, Error>;
impl From<AdmissionError> for Error {
    fn from(error: AdmissionError) -> Self {
        Self::Admission(error)
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    key_type: u32,
    point: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustInputs {
    network: String,
    subject: String,
    #[serde(rename = "rev0T1")]
    revision_zero: String,
    relay_id: String,
    relay_identity: Identity,
    endpoint: String,
    binding_expiry_ns: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TlsInputs {
    ca_pem: String,
    leaf_sha256: String,
    leaf_spki_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    kind: String,
    run_dir: PathBuf,
    manifest_identity: String,
    trust_inputs: TrustInputs,
    witness_hex: Option<String>,
    tls: TlsInputs,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    New,
    Reopen,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario<'a> {
    bundle: Bundle,
    manifest_identity: String,
    installed: TrustInputs,
    now_ns: String,
    location: PathBuf,
    continuity_file: PathBuf,
    mode: Mode,
    #[serde(borrow)]
    candidates: Candidates<'a>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedCandidate<'a> {
    statement: &'a str,
    attestation: &'a str,
}

struct Candidates<'a>(Vec<EncodedCandidate<'a>>);

// Borrow hex directly from the bounded JSON buffer. Count and charge every presented frame
// before allocating decoded bytes or handing any prefix to admission. Escaped hex is rejected.
impl<'de: 'a, 'a> Deserialize<'de> for Candidates<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor<'a>(PhantomData<&'a ()>);
        impl<'de: 'a, 'a> de::Visitor<'de> for Visitor<'a> {
            type Value = Candidates<'a>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a bounded array of exact lowercase hex frames")
            }
            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                let mut charged = 0usize;
                while let Some(value) = seq.next_element::<EncodedCandidate<'a>>()? {
                    if values.len() == MAX_STATEMENTS {
                        return Err(de::Error::custom("candidate count bound"));
                    }
                    for frame in [value.statement, value.attestation] {
                        if !canonical_hex(frame, MAX_FRAME_BYTES) {
                            return Err(de::Error::custom("candidate frame bound or encoding"));
                        }
                        charged = charged
                            .checked_add(frame.len() / 2)
                            .filter(|n| *n <= MAX_CHARGED_BYTES)
                            .ok_or_else(|| de::Error::custom("candidate cumulative bound"))?;
                    }
                    values.push(value);
                }
                Ok(Candidates(values))
            }
        }
        deserializer.deserialize_seq(Visitor(PhantomData))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Continuity {
    version: u32,
    manifest_identity: String,
    installed: TrustInputs,
    // Consumed before first admission, including when only a prospective checkpoint survives.
    // A durable record never grants permission to retry new enrollment.
    enrollment_intent: String,
    checkpoint: Checkpoint,
}

fn canonical_hex(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes * 2
        && value.len() % 2 == 0
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn bytes(value: &str, size: usize) -> Result<Vec<u8>> {
    if !canonical_hex(value, size) || value.len() != size * 2 {
        return Err(Error::Input("input"));
    }
    hex::decode(value).map_err(|_| Error::Input("input"))
}

fn timestamp(value: &str) -> Result<Timestamp> {
    if value.is_empty()
        || value.len() > 29
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Input("clock"));
    }
    let ns: u128 = value.parse().map_err(|_| Error::Input("clock"))?;
    Ok(Timestamp {
        seconds: (ns / 1_000_000_000)
            .try_into()
            .map_err(|_| Error::Input("clock"))?,
        nanoseconds: (ns % 1_000_000_000) as u32,
    })
}

fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    // Refuse special files before open (a FIFO could otherwise wait indefinitely).
    let metadata = fs::metadata(path).map_err(|_| Error::Input("unavailable"))?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(Error::Input("resource"));
    }
    let mut file = File::open(path).map_err(|_| Error::Input("unavailable"))?;
    let metadata = file.metadata().map_err(|_| Error::Input("unavailable"))?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return Err(Error::Input("resource"));
    }
    let mut data = Vec::new();
    Read::by_ref(&mut file)
        .take((max + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| Error::Input("unavailable"))?;
    if data.len() > max {
        return Err(Error::Input("resource"));
    }
    Ok(data)
}

fn absolute(path: &Path) -> bool {
    path.is_absolute()
        && path.file_name().is_some()
        && !path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
}

// Resolve existing parents before comparing rollback domains; reject symlinks at the leaf.
// The operator places continuity outside the dedicated registry directory and its sidecar.
fn resolve_path(path: &Path) -> Result<PathBuf> {
    if !absolute(path) {
        return Err(Error::Input("path"));
    }
    let parent = path.parent().ok_or(Error::Input("path"))?;
    let resolved = fs::canonicalize(parent)
        .map_err(|_| Error::Input("path"))?
        .join(path.file_name().ok_or(Error::Input("path"))?);
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(Error::Input("path")),
        Ok(_) => Ok(resolved),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(resolved),
        Err(_) => Err(Error::Input("path")),
    }
}

fn trust_context(trust: &TrustInputs, now: Timestamp) -> Result<(Anchor, RelayBinding, u16)> {
    if trust.network.is_empty()
        || trust.network.len() > 64
        || !trust.network.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b"._-".contains(&b))
        })
        || trust.relay_identity.key_type != 1
    {
        return Err(Error::Input("trust"));
    }
    let subject = bytes(&trust.subject, 33)?;
    let identity = bytes(&trust.relay_identity.point, 33)?;
    if !matches!(subject[0], 2 | 3) || !matches!(identity[0], 2 | 3) {
        return Err(Error::Input("trust"));
    }
    let expiry = timestamp(&trust.binding_expiry_ns)?;
    if (expiry.seconds, expiry.nanoseconds) <= (now.seconds, now.nanoseconds) {
        return Err(Error::Input("binding"));
    }
    let port = trust
        .endpoint
        .strip_prefix("https://127.0.0.1:")
        .ok_or(Error::Input("endpoint"))?;
    if port.is_empty()
        || port.len() > 5
        || port.starts_with('0')
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Input("endpoint"));
    }
    let port = port.parse::<u16>().map_err(|_| Error::Input("endpoint"))?;
    Ok((
        Anchor {
            network: trust.network.clone(),
            subject: AccountRef {
                key_type: 1,
                key_bytes: subject,
            },
            revision_zero: bytes(&trust.revision_zero, 32)?
                .try_into()
                .map_err(|_| Error::Input("trust"))?,
        },
        RelayBinding {
            relay_id: bytes(&trust.relay_id, 16)?,
            endpoint: trust.endpoint.clone(),
            identity: AccountRef {
                key_type: 1,
                key_bytes: identity,
            },
            expiry,
            unknown: vec![],
        },
        port,
    ))
}

// A fixed operation deadline also bounds trickled TLS/HTTP bytes, not just each read.
struct DeadlineStream {
    stream: TcpStream,
    deadline: Instant,
}
impl DeadlineStream {
    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "fixture deadline"))
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(buffer)
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.flush()
    }
}

fn response_body(response: &[u8]) -> Result<&[u8]> {
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .filter(|n| n + 4 <= MAX_HEADERS)
        .ok_or(Error::Input("http"))?;
    let header = std::str::from_utf8(&response[..split]).map_err(|_| Error::Input("http"))?;
    let mut lines = header.split("\r\n");
    if lines.next() != Some("HTTP/1.1 200 OK") {
        return Err(Error::Input("http"));
    }
    let mut length = None;
    let mut content_type = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(Error::Input("http"))?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(Error::Input("http"));
        }
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "location" | "transfer-encoding" | "content-encoding" => {
                return Err(Error::Input("http"))
            }
            "content-length" => {
                if length.is_some()
                    || value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(Error::Input("http"));
                }
                length = Some(value.parse::<usize>().map_err(|_| Error::Input("http"))?);
            }
            "content-type" => {
                if content_type || value != "application/json" {
                    return Err(Error::Input("http"));
                }
                content_type = true;
            }
            _ => (),
        }
    }
    let body = &response[split + 4..];
    if !content_type || length != Some(body.len()) || body.len() > MAX_BODY {
        return Err(Error::Input("http"));
    }
    Ok(body)
}

fn check_tls(bundle: &Bundle, port: u16) -> Result<()> {
    if bundle.tls.ca_pem.is_empty() || bundle.tls.ca_pem.len() > 16_384 {
        return Err(Error::Input("tls"));
    }
    let expected_leaf = bytes(&bundle.tls.leaf_sha256, 32)?;
    if bundle.tls.leaf_spki_sha256.len() != 44 {
        return Err(Error::Input("tls"));
    }
    let spki = base64::decode(&bundle.tls.leaf_spki_sha256).map_err(|_| Error::Input("tls"))?;
    if spki.len() != 32 || base64::encode(&spki) != bundle.tls.leaf_spki_sha256 {
        return Err(Error::Input("tls"));
    }
    let ca =
        Certificate::from_pem(bundle.tls.ca_pem.as_bytes()).map_err(|_| Error::Input("tls"))?;
    let connector = TlsConnector::builder()
        .disable_built_in_roots(true)
        .add_root_certificate(ca)
        .build()
        .map_err(|_| Error::Input("tls"))?;
    let deadline = Instant::now() + TRANSPORT_TIMEOUT;
    let socket = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        TRANSPORT_TIMEOUT,
    )
    .map_err(|_| Error::Input("tls"))?;
    // Defaults preserve hostname and certificate expiry checks. No environment trust bypass.
    let mut stream = connector
        .connect(
            "127.0.0.1",
            DeadlineStream {
                stream: socket,
                deadline,
            },
        )
        .map_err(|_| Error::Input("tls"))?;
    let leaf = stream
        .peer_certificate()
        .map_err(|_| Error::Input("tls"))?
        .ok_or(Error::Input("tls"))?
        .to_der()
        .map_err(|_| Error::Input("tls"))?;
    if Sha256::digest(&leaf).as_slice() != expected_leaf.as_slice() {
        return Err(Error::Input("tls-pin"));
    }
    // Exact leaf DER also fixes its SPKI. The supplied SPKI is used by the browser harness;
    // this Rust connection pins the stronger exact certificate before sending any request.
    let host = if port == 443 {
        "127.0.0.1".into()
    } else {
        format!("127.0.0.1:{port}")
    };
    write!(stream, "GET /fixture/evidence HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n")
        .map_err(|_| Error::Input("http"))?;
    stream.flush().map_err(|_| Error::Input("http"))?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).map_err(|_| Error::Input("http"))?;
        if n == 0 {
            break;
        }
        if response.len() + n > MAX_HEADERS + MAX_BODY {
            return Err(Error::Input("resource"));
        }
        response.extend_from_slice(&chunk[..n]);
        if !response.windows(4).any(|w| w == b"\r\n\r\n") && response.len() >= MAX_HEADERS {
            return Err(Error::Input("resource"));
        }
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Announcement<'a> {
        kind: &'static str,
        trust_inputs: &'a TrustInputs,
        witness_hex: &'a Option<String>,
    }
    let expected = serde_json::to_vec(&Announcement {
        kind: "synthetic-directory-evidence",
        trust_inputs: &bundle.trust_inputs,
        witness_hex: &bundle.witness_hex,
    })
    .map_err(|_| Error::Input("input"))?;
    if response_body(&response)? != expected {
        return Err(Error::Input("transport-evidence"));
    }
    Ok(())
}

fn save_continuity(path: &Path, record: &Continuity, initial: bool) -> Result<()> {
    let parent = path.parent().ok_or(Error::Input("continuity-save"))?;
    let data = serde_json::to_vec(record).map_err(|_| Error::Input("continuity-save"))?;
    if data.len() > MAX_CONTINUITY {
        return Err(Error::Input("continuity-save"));
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::Input("continuity-save"))?;
    temporary
        .write_all(&data)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| Error::Input("continuity-save"))?;
    if initial {
        temporary.persist_noclobber(path)
    } else {
        temporary.persist(path)
    }
    .map_err(|_| Error::Input("continuity-save"))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::Input("continuity-save"))?;
    Ok(())
}

fn summary(current: &Current) -> Value {
    let checkpoint = &current.status.checkpoint;
    json!({
        "kind": "current",
        "head": hex::encode(current.evidence.hash),
        "statement": hex::encode(&current.evidence.statement),
        "attestation": hex::encode(&current.evidence.attestation),
        "message": hex::encode(&current.message_key.key_bytes),
        "stamp": hex::encode(&current.stamp_key.key_bytes),
        "previous": current.previous_stamp.as_ref().map(|p| hex::encode(&p.key_bytes)),
        "revision": current.revision.to_string(),
        "generations": current.generations.map(|n| n.to_string()),
        "accepted": current.status.accepted,
        "retained": current.status.retained,
        "charged": current.status.charged_bytes,
        "checkpoint": {
            "kind": checkpoint.kind,
            "identity": hex::encode(checkpoint.identity),
            "anchor": hex::encode(checkpoint.anchor),
            "head": checkpoint.head.map(hex::encode),
            "accepted": checkpoint.accepted,
            "retained": checkpoint.retained,
            "evidenceDigest": hex::encode(checkpoint.evidence_digest),
            "checkedTime": {"seconds": checkpoint.checked_time.0.to_string(), "nanoseconds": checkpoint.checked_time.1},
            "forked": checkpoint.forked,
        },
    })
}

fn run() -> Result<Value> {
    let mut args = std::env::args_os().skip(1);
    let input = PathBuf::from(args.next().ok_or(Error::Input("arguments"))?);
    if args.next().is_some() || !absolute(&input) {
        return Err(Error::Input("arguments"));
    }
    let data = read_bounded(&input, MAX_CONFIG)?;
    let scenario: Scenario<'_> =
        serde_json::from_slice(&data).map_err(|_| Error::Input("input"))?;
    let Scenario {
        bundle,
        manifest_identity,
        installed,
        now_ns,
        location,
        continuity_file,
        mode,
        candidates,
    } = scenario;
    if bundle.kind != "synthetic-directory-trust-inputs"
        || !absolute(&bundle.run_dir)
        || bundle.manifest_identity != manifest_identity
        || bundle.trust_inputs != installed
    {
        return Err(Error::Input("trust"));
    }
    bytes(&manifest_identity, 32)?;
    if let Some(witness) = &bundle.witness_hex {
        if !canonical_hex(witness, MAX_FRAME_BYTES) {
            return Err(Error::Input("resource"));
        }
    }
    let now = timestamp(&now_ns)?;
    let (anchor, relay, port) = trust_context(&installed, now)?;
    let location = resolve_path(&location)?;
    let continuity_file = resolve_path(&continuity_file)?;
    if continuity_file.starts_with(&location) || location.starts_with(&continuity_file) {
        return Err(Error::Input("path"));
    }
    let mut continuity = match mode {
        Mode::New => {
            if fs::symlink_metadata(&location).is_ok()
                || fs::symlink_metadata(&continuity_file).is_ok()
            {
                return Err(Error::Input("already-enrolled"));
            }
            None
        }
        Mode::Reopen => {
            if !location.is_dir() || !location.join("CURRENT").is_file() {
                return Err(Error::Input("unavailable"));
            }
            let record: Continuity =
                serde_json::from_slice(&read_bounded(&continuity_file, MAX_CONTINUITY)?)
                    .map_err(|_| Error::Input("continuity"))?;
            if record.version != 1
                || record.manifest_identity != manifest_identity
                || record.installed != installed
                || record.enrollment_intent != "enrolled"
            {
                return Err(Error::Input("continuity"));
            }
            Some(record)
        }
    };
    // TLS precedes using the authenticated tuple for any directory operation. Snapshot kind
    // and successful transport grant no admission; only the facade below can yield Current.
    check_tls(&bundle, port)?;
    let frames: Vec<_> = candidates
        .0
        .iter()
        .map(|candidate| {
            Ok((
                hex::decode(candidate.statement).map_err(|_| Error::Input("input"))?,
                hex::decode(candidate.attestation).map_err(|_| Error::Input("input"))?,
            ))
        })
        .collect::<Result<_>>()?;
    let candidates: Vec<_> = frames
        .iter()
        .map(|(statement, attestation)| Candidate {
            statement,
            attestation,
        })
        .collect();
    let open_mode = match mode {
        Mode::New => {
            let candidate = *candidates.first().ok_or(Error::Input("witness"))?;
            if bundle.witness_hex.as_deref() != Some(hex::encode(candidate.attestation).as_str()) {
                return Err(Error::Input("witness"));
            }
            let checkpoint = Checkpoint::for_enrollment(&anchor, candidate, now)?;
            let record = Continuity {
                version: 1,
                manifest_identity,
                installed,
                enrollment_intent: "enrolled".into(),
                checkpoint,
            };
            save_continuity(&continuity_file, &record, true)?;
            continuity = Some(record);
            // Reserve a new dedicated path: Db::open itself otherwise permits existing stores.
            fs::create_dir(&location).map_err(|_| Error::Input("unavailable"))?;
            OpenMode::NewEnrollment
        }
        Mode::Reopen => OpenMode::Reopen(
            continuity
                .as_ref()
                .ok_or(Error::Input("continuity"))?
                .checkpoint,
        ),
    };
    let db = Db::open(&location).map_err(|_| Error::Input("unavailable"))?;
    let directory = db.directory_preview(anchor, open_mode)?;
    let context = Context {
        now: Some(now),
        relay: Some(&relay),
    };
    let result = if candidates.is_empty() {
        directory.current(context)
    } else {
        directory.advance(&candidates, context)
    };
    let record = continuity.as_mut().ok_or(Error::Input("continuity"))?;
    let output = match result {
        Ok(current) => {
            record.checkpoint = current.status.checkpoint;
            save_continuity(&continuity_file, record, false)?;
            Ok(summary(&current))
        }
        Err(error) => {
            if error == AdmissionError::Fork {
                if let Some(status) = directory.status()? {
                    record.checkpoint = status.checkpoint;
                    save_continuity(&continuity_file, record, false)?;
                }
            }
            Err(Error::Admission(error))
        }
    };
    drop(directory);
    drop(db);
    output
}

fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            let code = match error {
                Error::Input(code) => code.to_owned(),
                Error::Admission(error) => error.to_string(),
            };
            // Static input codes or the public facade's fixed enum text; never paths or secrets.
            eprintln!("{}", json!({"kind": "error", "code": code}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_clock_has_no_precision_loss_or_signed_seconds_overflow() {
        let timestamp = timestamp("9223372036854775807999999999").unwrap();
        assert_eq!(timestamp.seconds, i64::MAX);
        assert_eq!(timestamp.nanoseconds, 999_999_999);
        for invalid in ["", "01", "-1", "1.0", "9223372036854775808000000000"] {
            assert!(super::timestamp(invalid).is_err());
        }
    }

    #[test]
    fn whole_candidate_batch_is_bounded_before_hex_decoding() {
        let candidate = r#"{"statement":"00","attestation":"00"}"#;
        let exact = format!("[{}]", vec![candidate; MAX_STATEMENTS].join(","));
        assert_eq!(
            serde_json::from_str::<Candidates<'_>>(&exact)
                .unwrap()
                .0
                .len(),
            MAX_STATEMENTS
        );
        let excess = format!("[{},{}]", &exact[1..exact.len() - 1], candidate);
        assert!(serde_json::from_str::<Candidates<'_>>(&excess).is_err());
        let frame = "00".repeat(MAX_FRAME_BYTES + 1);
        let oversized = format!(r#"[{{"statement":"{frame}","attestation":"00"}}]"#);
        assert!(serde_json::from_str::<Candidates<'_>>(&oversized).is_err());
        let frame = "00".repeat(MAX_FRAME_BYTES);
        let pair = format!(r#"{{"statement":"{frame}","attestation":"{frame}"}}"#);
        let excess = format!(
            "[{}]",
            vec![pair; MAX_CHARGED_BYTES / (MAX_FRAME_BYTES * 2) + 1].join(",")
        );
        assert!(serde_json::from_str::<Candidates<'_>>(&excess).is_err());
    }

    #[test]
    fn candidate_frames_are_canonical_borrowed_hex() {
        for invalid in [
            r#"[{"statement":"0A","attestation":"00"}]"#,
            r#"[{"statement":"0","attestation":"00"}]"#,
            r#"[{"statement":"\u0030\u0030","attestation":"00"}]"#,
        ] {
            assert!(serde_json::from_str::<Candidates<'_>>(invalid).is_err());
        }
    }

    #[test]
    fn http_rejects_redirects_ambiguous_framing_and_partial_bodies() {
        let valid =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(response_body(valid).unwrap(), b"{}");
        for invalid in [
            "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nLocation: /fixture/evidence\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}",
        ] {
            assert!(response_body(invalid.as_bytes()).is_err());
        }
    }
}
