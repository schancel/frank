//! Ticket #35: HTTP-level tests proving `PopConf::enabled` produces two genuinely distinct
//! outcomes for `handle_put_registry` -- the whole point of this ticket is that these must never
//! collapse into each other:
//!
//! - `enabled: false` -- POP gating is skipped entirely; the endpoint succeeds with no bearer
//!   token and no payment proof at all (fail-*open*, by deliberate operator intent, e.g. the
//!   hackathon demo).
//! - `enabled: true` with an otherwise-invalid `PopConf` -- unchanged from before this ticket:
//!   every gated request fails *closed* with a `500`, never silently falls through to "disabled".
//!
//! Needs a lotusd-compatible binary via `BITCOINSUITE_BIN_DIR`, the same pre-existing requirement
//! as `tests/test_http_endpoint.rs`/`tests/test_p2p.rs` (see issue #1) -- `RegistryTestInstance`
//! spins up a regtest node to serve the rest of `handle_put_registry` (burn-tx validation), which
//! has nothing to do with POP. Unlike `tests/pop_live_smoke.rs`, neither test here needs any Monad
//! network access: the disabled path never builds a gate at all, and the misconfigured path fails
//! to parse before any RPC call would be made -- so these aren't `#[ignore]`d.

use std::ffi::OsString;

use bitcoinsuite_bitcoind::instance::{BitcoindChain, BitcoindConf};
use bitcoinsuite_core::{ecc::Ecc, Hashed, LotusAddress, Net, Network, Script, ShaRmd160};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::Result;
use bitcoinsuite_test_utils::bin_folder;
use bitcoinsuite_test_utils_blockchain::setup_bitcoind_coins;
use cashweb_config::PopConf;
use cashweb_http_utils::protobuf::CONTENT_TYPE_PROTOBUF;
use cashweb_registry::{
    proto,
    test_instance::{build_signed_metadata, placeholder_pop_conf, RegistryTestInstance},
};
use prost::Message;
use reqwest::{
    header::{CONTENT_TYPE, ORIGIN},
    StatusCode,
};

/// Spin up a [`RegistryTestInstance`] with `pop_conf`, and build a validly-signed metadata-PUT
/// request body/address (same recipe as `tests/test_http_endpoint.rs`/`tests/pop_live_smoke.rs`).
/// Returns the still-running instance (must stay alive for the caller's request), the server URL,
/// the target address, and the encoded request body.
async fn setup_and_build_request(
    pop_conf: PopConf,
) -> Result<(RegistryTestInstance, String, LotusAddress, Vec<u8>)> {
    let tempdir = tempdir::TempDir::new("cashweb-registry--pop-toggle")?;
    let bitcoind_conf = BitcoindConf::from_chain_regtest(
        bin_folder(),
        BitcoindChain::XPI,
        vec![OsString::from("-txindex")],
    )?;
    let mut instance =
        RegistryTestInstance::setup_with_pop_conf(tempdir.path(), bitcoind_conf, vec![], pop_conf)
            .await?;
    instance.wait_for_ready().await?;
    let url = instance.url.clone();

    let anyone_script = Script::from_slice(&[0x51]);
    let anyone_address = LotusAddress::new(
        "lotus",
        Net::Regtest,
        Script::p2sh(&ShaRmd160::digest(anyone_script.bytecode().clone())),
    );
    let mut utxos = setup_bitcoind_coins(
        instance.bitcoind.cli(),
        Network::XPI,
        1,
        anyone_address.as_str(),
        &anyone_address.script().hex(),
    )?;

    let ecc = EccSecp256k1::default();
    let seckey = ecc.seckey_from_array([7; 32])?;
    let pubkey = ecc.derive_pubkey(&seckey);
    let pkh = ShaRmd160::digest(pubkey.array().into());
    let address = LotusAddress::new("lotus", Net::Regtest, Script::p2pkh(&pkh));

    let (signed_metadata, _tx) = build_signed_metadata(
        &seckey,
        pubkey,
        &ecc,
        &mut utxos,
        &anyone_script,
        proto::AddressMetadata {
            timestamp: 1234,
            ttl: 10,
            entries: vec![],
        },
    );

    Ok((instance, url, address, signed_metadata.encode_to_vec()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pop_disabled_allows_put_with_no_token_or_proof() -> Result<()> {
    let _ = bitcoinsuite_error::install();

    // `enabled: false`, with the rest of the conf deliberately nonsense (bad recipient, bad
    // min-value) -- proves the disabled path never even attempts to build a gate from the rest of
    // `PopConf`, let alone enforce it.
    let mut pop_conf = placeholder_pop_conf();
    pop_conf.enabled = false;
    pop_conf.payment_recipient = "not-an-address".to_string();
    pop_conf.min_value_wei = "not-a-number".to_string();

    let (_instance, url, address, body) = setup_and_build_request(pop_conf).await?;

    let response = reqwest::Client::new()
        .put(format!("{}/metadata/{}", url, address))
        .body(body)
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://localhost")
        // Deliberately: no Authorization header, no pop_tx_hash/access_token query param.
        .send()
        .await
        .expect("PUT failed at the transport level");

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "POP disabled should let the request through with no token/proof at all"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pop_misconfigured_still_fails_closed_when_enabled() -> Result<()> {
    let _ = bitcoinsuite_error::install();

    // `enabled: true`, but `payment_recipient` doesn't parse -- must still fail closed with a
    // `500`, and must never be silently treated as equivalent to "disabled" just because the
    // request also carries no token/proof.
    let mut pop_conf = placeholder_pop_conf();
    pop_conf.enabled = true;
    pop_conf.payment_recipient = "not-an-address".to_string();

    let (_instance, url, address, body) = setup_and_build_request(pop_conf).await?;

    let response = reqwest::Client::new()
        .put(format!("{}/metadata/{}", url, address))
        .body(body)
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://localhost")
        .send()
        .await
        .expect("PUT failed at the transport level");

    assert_eq!(
        response.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "misconfigured-but-enabled POP must fail closed, not silently pass through"
    );
    Ok(())
}
