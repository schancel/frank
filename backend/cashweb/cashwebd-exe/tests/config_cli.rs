use std::{
    io::Write,
    process::{Command, Stdio},
};

fn check_stdin(config: &[u8]) -> std::process::Output {
    check_stdin_with_env(
        config,
        &[
            ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
            ("FRANK_NETWORK_TAG", "MONT"),
        ],
    )
}

/// Runs `--check-config -` with a clean environment plus exactly `vars`, so the result never
/// depends on the developer's own `.env`/shell.
fn check_stdin_with_env(config: &[u8], vars: &[(&str, &str)]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"));
    command
        .args(["--check-config", "-"])
        .env_remove("MONAD_TESTNET_HTTP_RPC_URL")
        .env_remove("FRANK_NETWORK_TAG")
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
fn shipped_configurations_are_enabled_and_need_the_rpc_url_and_network_tag() {
    for (name, config) in [
        ("local", &include_bytes!("../../cashwebd.local.toml")[..]),
        (
            "docker",
            &include_bytes!("../../../docker/cashwebd.toml")[..],
        ),
    ] {
        let text = std::str::from_utf8(config).unwrap();
        assert!(
            text.contains("[registry.monad_mailbox]\nenabled = true\n"),
            "{name}"
        );
        assert!(text.contains("expected_chain_id = 10143"), "{name}");
        assert!(
            !text.lines().any(|line| line.starts_with("rpc_url")),
            "{name}: no hard-coded endpoint"
        );

        let missing_url = check_stdin_with_env(config, &[("FRANK_NETWORK_TAG", "MONT")]);
        assert!(!missing_url.status.success(), "{name}");
        assert!(
            String::from_utf8_lossy(&missing_url.stderr).contains("MONAD_TESTNET_HTTP_RPC_URL"),
            "{name}: {}",
            String::from_utf8_lossy(&missing_url.stderr)
        );
        let blank_tag = check_stdin_with_env(
            config,
            &[
                ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                ("FRANK_NETWORK_TAG", " "),
            ],
        );
        assert!(!blank_tag.status.success(), "{name}: blank tag accepted");
        assert!(
            String::from_utf8_lossy(&blank_tag.stderr).contains("FRANK_NETWORK_TAG"),
            "{name}"
        );
        let unknown_tag = check_stdin_with_env(
            config,
            &[
                ("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1"),
                ("FRANK_NETWORK_TAG", "MONX"),
            ],
        );
        assert!(
            !unknown_tag.status.success(),
            "{name}: unmapped tag accepted"
        );
        assert!(
            String::from_utf8_lossy(&unknown_tag.stderr).contains("no Frank-CBOR network"),
            "{name}"
        );
        let missing_tag = check_stdin_with_env(
            config,
            &[("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1")],
        );
        assert!(!missing_tag.status.success(), "{name}");
        assert!(
            String::from_utf8_lossy(&missing_tag.stderr).contains("FRANK_NETWORK_TAG"),
            "{name}"
        );
    }
}

#[test]
fn check_config_cli_rejects_an_enabled_mailbox_missing_minimum_or_chain_id() {
    for (case, extra) in [
        ("no minimum", "expected_chain_id = 143"),
        ("no chain ID", "min_value_wei = \"1\""),
        (
            "non-decimal minimum",
            "min_value_wei = \"1e12\"\nexpected_chain_id = 143",
        ),
    ] {
        let invalid = include_str!("../../cashwebd.local.toml").replace(
            "[registry.monad_mailbox]\nenabled = true\nmin_value_wei = \"1000000000000\"\nexpected_chain_id = 10143",
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
fn check_config_cli_accepts_an_enabled_monad_mailbox_without_starting_it() {
    let enabled = include_str!("../../cashwebd.local.toml").replace(
        "[registry.monad_mailbox]\nenabled = true\nmin_value_wei = \"1000000000000\"\nexpected_chain_id = 10143",
        "[registry.monad_mailbox]\nenabled = true\nrpc_url = \"https://rpc.invalid\"\nmin_value_wei = \"1\"\nexpected_chain_id = 143",
    );
    let output = check_stdin(enabled.as_bytes());
    assert!(
        output.status.success(),
        "checker failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn check_config_cli_rejects_invalid_mailbox_configuration() {
    let invalid = include_str!("../../cashwebd.local.toml").replace(
        "[registry.monad_mailbox]\nenabled = true\nmin_value_wei = \"1000000000000\"\nexpected_chain_id = 10143",
        "[registry.monad_mailbox]\nenabled = true",
    );
    let output = check_stdin(invalid.as_bytes());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Invalid registry.monad_mailbox configuration"));
}
