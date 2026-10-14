use std::{
    io::Write,
    process::{Command, Stdio},
};

/// Every upstream variable the shipped configurations name for an enabled proxy row.
const FULL_ENV: &[(&str, &str)] = &[
    ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
    ("XEC_TESTNET_CHRONIK_URL", "http://127.0.0.1:2"),
    ("BTC_TESTNET_ELECTRUM_URL", "tcp://127.0.0.1:3"),
    ("BCH_TESTNET_ELECTRUM_URL", "tcp://127.0.0.1:4"),
    ("SOLANA_DEVNET_HTTP_RPC_URL", "http://127.0.0.1:5"),
];

fn check_stdin(config: &[u8]) -> std::process::Output {
    check_stdin_with_env(config, FULL_ENV)
}

/// `FULL_ENV` without `name`.
fn env_without(name: &str) -> Vec<(&'static str, &'static str)> {
    FULL_ENV
        .iter()
        .copied()
        .filter(|(key, _)| *key != name)
        .collect()
}

/// Runs `--check-config -` with a clean environment plus exactly `vars`, so the result never
/// depends on the developer's own `.env`/shell.
fn check_stdin_with_env(config: &[u8], vars: &[(&str, &str)]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"));
    command
        .args(["--check-config", "-"])
        .env_clear()
        .envs(vars.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("cashwebd-exe should start");
    child
        .stdin
        .take()
        .expect("stdin pipe should exist")
        .write_all(config)
        .expect("configuration should reach stdin");
    child.wait_with_output().expect("checker should exit")
}

#[test]
fn check_config_cli_accepts_the_checked_in_local_configuration() {
    let output = check_stdin(include_bytes!("../../cashwebd.local.toml"));
    assert!(
        output.status.success(),
        "checker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn check_config_cli_accepts_the_checked_in_docker_configuration() {
    let output = check_stdin(include_bytes!("../../../docker/cashwebd.toml"));
    assert!(
        output.status.success(),
        "checker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn shipped_configurations_name_their_network_and_need_its_rpc_url() {
    for (name, config) in [
        ("local", &include_bytes!("../../cashwebd.local.toml")[..]),
        (
            "docker",
            &include_bytes!("../../../docker/cashwebd.toml")[..],
        ),
    ] {
        let text = std::str::from_utf8(config).unwrap();
        assert!(text.contains("network = \"monad-testnet\"\n"), "{name}");
        assert!(
            text.contains("[registry.monad_mailbox]\nenabled = true\n"),
            "{name}"
        );
        assert!(text.contains("[registry.forum]\nburn_address = "), "{name}");
        assert!(
            !text.lines().any(|line| line.starts_with("rpc_url")),
            "{name}: no hard-coded endpoint"
        );

        let missing_url =
            check_stdin_with_env(config, &env_without("MONAD_TESTNET_HTTP_RPC_URL"));
        assert!(!missing_url.status.success(), "{name}");
        assert!(
            String::from_utf8_lossy(&missing_url.stderr).contains("MONAD_TESTNET_HTTP_RPC_URL"),
            "{name}: {}",
            String::from_utf8_lossy(&missing_url.stderr)
        );
        let missing_network = check_stdin(text.replace("network = \"monad-testnet\"\n", "").as_bytes());
        assert!(!missing_network.status.success(), "{name}: no network accepted");
        assert!(
            String::from_utf8_lossy(&missing_network.stderr).contains("network"),
            "{name}"
        );
    }
}

#[test]
fn check_config_cli_rejects_an_enabled_mailbox_without_a_decimal_minimum() {
    for (case, extra) in [("no minimum", ""), ("non-decimal minimum", "min_value_wei = \"1e12\"\n")] {
        let invalid = include_str!("../../cashwebd.local.toml").replace(
            "[registry.monad_mailbox]\nenabled = true\nmin_value_wei = \"1000000000000\"\n",
            &format!("[registry.monad_mailbox]\nenabled = true\n{extra}"),
        );
        let output = check_stdin(invalid.as_bytes());
        assert!(!output.status.success(), "{case}: unexpectedly accepted");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("Invalid registry.monad_mailbox configuration"),
            "{case}"
        );
    }
}

#[test]
fn check_config_cli_accepts_a_relay_on_monad_mainnet_without_starting_it() {
    let mainnet = include_str!("../../cashwebd.local.toml")
        .replace("network = \"monad-testnet\"", "network = \"monad-mainnet\"")
        .replace("id = \"monad-testnet\"", "id = \"monad-mainnet\"")
        .replace("expected_chain_id = 10143", "expected_chain_id = 143")
        .replace(
            "0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9",
            "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9",
        );
    let output = check_stdin(mainnet.as_bytes());
    assert!(
        output.status.success(),
        "checker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn check_config_cli_rejects_a_network_the_relay_does_not_proxy() {
    // The mailbox and the forum verify payments through the network's own evm_rpc row; a relay
    // on monad-mainnet that only proxies monad-testnet cannot.
    let crossed = include_str!("../../cashwebd.local.toml")
        .replace("network = \"monad-testnet\"", "network = \"monad-mainnet\"");
    let output = check_stdin(crossed.as_bytes());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("monad-mainnet"));
}

#[test]
fn unsupported_storage_fails_before_creating_database_or_session_state() {
    for driver in ["foundationdb", "kvrocks", "resp", "rockdsb"] {
        let temp = tempdir::TempDir::new("unsupported-relay-storage").unwrap();
        let state = temp.path().join("must-not-exist");
        let db = state.join("registry.rocksdb");
        let config = format!(
            "{}\n[registry.cluster]\ndriver = {driver:?}\n",
            include_str!("../../cashwebd.local.toml")
                .replace("data/registry.rocksdb", db.to_str().unwrap())
                .replace(
                    "[registry.monad_mailbox]\nenabled = true",
                    "[registry.monad_mailbox]\nenabled = false",
                )
                .replace(
                    "[registry.evm_rpc]\nenabled = true",
                    "[registry.evm_rpc]\nenabled = false",
                )
        );
        let path = temp.path().join("relay.toml");
        std::fs::write(&path, config).unwrap();
        // Test real startup and the DB-opening preflight, not just --check-config.
        for args in [
            vec!["--check-db".as_ref(), path.as_os_str()],
            vec![path.as_os_str()],
        ] {
            let output = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"))
                .args(args)
                .env_remove("MONAD_TESTNET_HTTP_RPC_URL")
                .output()
                .unwrap();
            assert!(
                !output.status.success(),
                "{driver} accepted unsupported driver; created_state={}",
                state.exists()
            );
            let error = String::from_utf8_lossy(&output.stderr);
            assert!(
                error.contains("only rocksdb is implemented"),
                "{driver}: {error}"
            );
            assert!(!state.exists(), "{driver} created state before rejection");
        }
    }
}

#[test]
fn group_price_configuration_is_explicit_and_checked_before_database_effects() {
    let base = include_str!("../../cashwebd.local.toml");
    let path =
        std::env::temp_dir().join(format!("frank-missing-group-policy-{}", std::process::id()));
    assert!(!path.exists());
    for price in ["-1", "0.5", "18446744073709551616", "\"free\""] {
        let invalid = base.replace(
            "per_message_price_credits = 0",
            &format!("per_message_price_credits = {price}"),
        );
        assert!(!check_stdin(invalid.as_bytes()).status.success(), "{price}");
    }
    for removed in [
        "[registry.groups]\nper_message_price_credits = 0\n",
        "per_message_price_credits = 0\n",
    ] {
        let invalid = base.replace(removed, "").replace(
            "data/registry.rocksdb",
            &format!("{}/registry.rocksdb", path.display()),
        );
        let mut child = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"))
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(invalid.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("missing field"));
        assert!(
            !path.exists(),
            "invalid config created database/session directory"
        );
    }
    let positive = base.replace(
        "per_message_price_credits = 0",
        "per_message_price_credits = 7",
    );
    assert!(check_stdin(positive.as_bytes()).status.success());
}
