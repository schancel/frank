use std::{
    io::Write,
    process::{Command, Stdio},
};

fn check_stdin(config: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_cashwebd-exe"))
        .args(["--check-config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("cashwebd-exe should start");
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
            "[registry.monad_mailbox]\nenabled = false",
            &format!(
                "[registry.monad_mailbox]\nenabled = true\nrpc_url = \"https://rpc.invalid\"\n{extra}"
            ),
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
        "[registry.monad_mailbox]\nenabled = false",
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
        "[registry.monad_mailbox]\nenabled = false",
        "[registry.monad_mailbox]\nenabled = true",
    );
    let output = check_stdin(invalid.as_bytes());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Invalid registry.monad_mailbox configuration"));
}
