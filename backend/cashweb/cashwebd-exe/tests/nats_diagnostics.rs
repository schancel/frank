//! Capture the real startup logs and exit diagnostic without an external NATS service.
use std::{
    io::Write,
    net::TcpListener,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn nats_startup_diagnostics_do_not_expose_endpoint_credentials() {
    // Reserve a local port and close it so connection attempts fail without an external service.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    for (url, invalid_endpoint) in [
        (
            format!("nats://synthetic-user:synthetic-password@127.0.0.1:{port}"),
            false,
        ),
        (format!("nats://synthetic-token@127.0.0.1:{port}"), false),
        (
            format!("nats://synthetic-user:synthetic%2Dpassword@127.0.0.1:{port}"),
            false,
        ),
        (
            "nats://synthetic-user:synthetic-password@[invalid".to_owned(),
            true,
        ),
    ] {
        let dir = tempdir::TempDir::new("nats-diagnostics").unwrap();
        let config = format!(
            r#"
host = "127.0.0.1:0"
url = "http://127.0.0.1:8098"
[registry]
db_path = "{}"
network = "monad-testnet"
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
[registry.cluster.nats]
enabled = true
url = "{url}"
"#,
            dir.path().join("registry.rocksdb").display()
        );
        let log_path = dir.path().join("startup.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"))
            .arg("-")
            .env_remove("MONAD_TESTNET_HTTP_RPC_URL")
            .stdin(Stdio::piped())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(config.as_bytes())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("NATS startup did not fail within the test deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(!status.success());
        let diagnostic = std::fs::read_to_string(log_path).unwrap();
        if !invalid_endpoint {
            assert!(
                diagnostic.contains("Connecting to Clustered Core NATS notification bus"),
                "{diagnostic}"
            );
            assert!(diagnostic.contains("Failed to connect to Ephemeral Core NATS"));
        } else {
            assert!(diagnostic.contains("Invalid registry.cluster configuration"));
            assert!(diagnostic.contains("requires a valid nats:// or tls:// URL"));
            assert!(!dir.path().join("registry.rocksdb").exists());
            assert!(!dir.path().join("registry.session-secret").exists());
        }
        assert!(!diagnostic.contains("synthetic"), "NATS credential leaked");
        assert!(!diagnostic.contains(&url), "NATS endpoint leaked");
    }
}
