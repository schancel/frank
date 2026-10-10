//! The real daemon with `[registry.oracle]`, started as a process and asked over HTTP.

use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// A relay with no mailbox, no proxies and the oracle: one price provider and one electricity
/// source, both on a closed local port, so anything the collector sends fails at once and is
/// logged.
fn config(port: u16, db_path: &Path, collect: bool) -> String {
    format!(
        r#"
host = "127.0.0.1:{port}"
url = "http://127.0.0.1:{port}"

[registry]
db_path = "{db}"
net = "mainnet"
peers = []

[registry.monad_mailbox]
enabled = false

[registry.pop]
enabled = false
monad_rpc_url = "http://unused.invalid"
hmac_secret = "unused-because-pop-is-disabled"
payment_recipient = "0x0000000000000000000000000000000000000000"
min_value_wei = "0"

[registry.oracle]
collect = {collect}

[[registry.oracle.price_providers]]
id = "closed"
adapter = "kraken"
api_url = "http://127.0.0.1:1/ticker"
symbols = {{ btc-mainnet = "XXBTZUSD" }}

[[registry.oracle.electricity]]
region = "de-lu"
label = "Germany-Luxembourg"
attribution = "test"
adapter = "energy-charts"
api_url = "http://127.0.0.1:1/price"
zone = "DE-LU"
fx_url = "http://127.0.0.1:1/fx"
"#,
        db = db_path.display()
    )
}

struct Daemon {
    child: Child,
    port: u16,
    log: std::path::PathBuf,
}

impl Daemon {
    fn start(dir: &Path, collect: bool) -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .expect("a free port")
            .port();
        let conf = dir.join("relay.toml");
        std::fs::write(&conf, config(port, &dir.join("registry.rocksdb"), collect)).unwrap();
        let log = dir.join("relay.log");
        let out = std::fs::File::create(&log).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"))
            .arg(&conf)
            .env_remove("FRANK_NETWORK_TAG")
            .env_remove("MONAD_TESTNET_HTTP_RPC_URL")
            .stdin(Stdio::null())
            .stdout(out.try_clone().unwrap())
            .stderr(out)
            .spawn()
            .expect("cashwebd-exe starts");
        let mut daemon = Daemon { child, port, log };
        let deadline = Instant::now() + Duration::from_secs(30);
        while daemon.get("/chains").is_none() {
            if let Some(status) = daemon.child.try_wait().unwrap() {
                panic!("the relay exited ({status}): {}", daemon.log());
            }
            assert!(Instant::now() < deadline, "not listening: {}", daemon.log());
            std::thread::sleep(Duration::from_millis(100));
        }
        daemon
    }

    /// `(status, body)` of a GET, or `None` when nothing is listening yet.
    fn get(&self, path: &str) -> Option<(u16, String)> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .ok()?;
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .ok()?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).ok()?;
        let answer = String::from_utf8_lossy(&answer).into_owned();
        let status = answer.split(' ').nth(1)?.parse().ok()?;
        let body = answer.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        Some((status, body.to_owned()))
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Something in the way where the oracle store belongs (here a plain file) costs the feed and
/// nothing else: the relay starts, serves its other routes, says in its log that it runs
/// without the feed, and answers 404 at the feed path.
#[test]
fn an_unusable_oracle_store_does_not_stop_the_relay() {
    let dir = tempdir::TempDir::new("cashwebd-oracle-store").unwrap();
    std::fs::write(dir.path().join("registry.oracle-v1"), b"not a database").unwrap();
    let daemon = Daemon::start(dir.path(), false);
    assert_eq!(daemon.get("/chains").map(|(status, _)| status), Some(200));
    assert_eq!(daemon.get("/peers").map(|(status, _)| status), Some(200));
    assert_eq!(
        daemon
            .get("/oracle/v1/feed?latest")
            .map(|(status, _)| status),
        Some(404)
    );
    let log = daemon.log();
    assert!(log.contains("WITHOUT the price and energy feed"), "{log}");
    assert!(log.contains("registry.oracle-v1"), "{log}");
}

/// `collect = false`, as a test or development relay runs: no provider is ever contacted (a
/// contact would fail against the closed port and be logged), and the feed is served from the
/// bundled seed. With collection on, the same configuration does try, which shows the log
/// would have told.
#[test]
fn with_collection_off_no_provider_is_asked_and_the_seed_is_served() {
    let dir = tempdir::TempDir::new("cashwebd-oracle-off").unwrap();
    let daemon = Daemon::start(dir.path(), false);
    std::thread::sleep(Duration::from_secs(2));
    let (status, body) = daemon.get("/oracle/v1/feed?latest").expect("an answer");
    assert_eq!(status, 200);
    for series in [
        "price/btc-mainnet",
        "difficulty/xec-mainnet",
        "efficiency/scrypt",
        "electricity/aggregate",
    ] {
        assert!(body.contains(series), "{series} missing from {body}");
    }
    assert!(body.contains("\"basket\""));
    let log = daemon.log();
    assert!(log.contains("collection is off"), "{log}");
    assert!(!log.contains("provider gave no usable answer"), "{log}");
    assert!(!log.contains("round finished"), "{log}");
    drop(daemon);

    let dir = tempdir::TempDir::new("cashwebd-oracle-on").unwrap();
    let daemon = Daemon::start(dir.path(), true);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !daemon.log().contains("round finished") {
        assert!(Instant::now() < deadline, "no round: {}", daemon.log());
        std::thread::sleep(Duration::from_millis(100));
    }
    let log = daemon.log();
    assert!(log.contains("provider gave no usable answer"), "{log}");
    assert!(log.contains("Unreachable"), "{log}");
    // Its providers are unreachable and the relay still answers, from the seed.
    assert_eq!(
        daemon
            .get("/oracle/v1/feed?latest")
            .map(|(status, _)| status),
        Some(200)
    );
}
