//! Ticket #8, acceptance criterion 1: "Register an identity via a metadata PUT to the registry
//! (no payment needed, POP disabled)."
//!
//! Talks over real HTTP to a running `e2e_demo_server` (see that example's docs and
//! `examples/README.md`), building a real, correctly-signed `cashweb_payload::proto::SignedPayload`
//! the same way `tests/test_http_endpoint.rs`/`tests/pop_live_smoke.rs` do (via this crate's own
//! `test_instance::build_signed_metadata` helper), and `PUT`s it to `/metadata/:addr` with **no**
//! `Authorization`/`pop_tx_hash` payment proof at all -- proving the request succeeds purely
//! because POP is disabled (ticket #35), not because a payment was made.
//!
//! Usage:
//! ```sh
//! cargo run -p cashweb-registry --example e2e_demo_register_identity -- http://127.0.0.1:8098
//! ```

use bitcoinsuite_core::{
    ecc::{Ecc, PubKey},
    Hashed, LotusAddress, Net, OutPoint, Script, Sha256d, ShaRmd160,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use bitcoinsuite_error::Result;
use cashweb_http_utils::protobuf::CONTENT_TYPE_PROTOBUF;
use cashweb_registry::{proto, test_instance::build_signed_metadata};
use prost::Message;
use cashweb_payload::proto::SignedPayload as SignedPayloadProto;
use reqwest::header::{CONTENT_TYPE, ORIGIN};

#[tokio::main]
async fn main() -> Result<()> {
    bitcoinsuite_error::install()?;

    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:8098".to_string());

    // --- Generate a fresh identity keypair (this demo's "new user signing up"). ---
    let ecc = EccSecp256k1::default();
    let seckey = ecc.seckey_from_array([0x42; 32])?; // deterministic, demo-only key
    let pubkey: PubKey = ecc.derive_pubkey(&seckey);
    let pkh = ShaRmd160::digest(pubkey.array().into());
    let address = LotusAddress::new("lotus", Net::Regtest, Script::p2pkh(&pkh));
    println!("Identity address: {address}");

    // --- Build the AddressMetadata payload (a real vCard-less entry list is fine for the demo --
    // the point being proven is "no payment required", not the metadata's content). ---
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let address_metadata = proto::AddressMetadata {
        timestamp,
        ttl: 3600,
        entries: vec![],
    };

    // --- Build the signed burn-commitment payload. No real Lotus UTXO exists (or needs to --
    // see `e2e_demo_server.rs`'s module docs on `DemoChainAdapter`): this outpoint is fabricated,
    // referencing nothing on any real or simulated chain. `SignedPayload::verify` (called by
    // `Registry::put_metadata`) only checks the burn commitment + top-level signature, never the
    // input's spendability -- so a fabricated outpoint is sufficient here. ---
    let mut fake_utxos = vec![(
        OutPoint {
            txid: Sha256d::digest(b"e2e-demo-identity-utxo".to_vec().into()),
            out_idx: 0,
        },
        100_000i64,
    )];
    let redeem_script = Script::p2pkh(&pkh);
    let (signed_metadata, _tx) = build_signed_metadata(
        &seckey,
        pubkey,
        &ecc,
        &mut fake_utxos,
        &redeem_script,
        address_metadata,
    );

    // --- PUT it, with no Authorization/pop_tx_hash query param at all. ---
    let client = reqwest::Client::new();
    let response = client
        .put(format!("{url}/metadata/{address}"))
        .header(CONTENT_TYPE, CONTENT_TYPE_PROTOBUF)
        .header(ORIGIN, "http://e2e-demo.local")
        .body(signed_metadata.encode_to_vec())
        .send()
        .await?;

    let status = response.status();
    println!("PUT /metadata/{address} -> HTTP {status}");
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow_bail(&format!("metadata PUT failed: HTTP {status}: {body}"));
    }
    let body_bytes = response.bytes().await?;
    let put_response = proto::PutSignedPayloadResponse::decode(body_bytes.as_ref())?;
    println!(
        "Registered with no payment (POP disabled). txids: {:?}",
        put_response
            .txid
            .iter()
            .map(hex::encode)
            .collect::<Vec<_>>()
    );

    // --- Read it back to prove it's actually stored. ---
    let get_response = client.get(format!("{url}/metadata/{address}")).send().await?;
    println!("GET /metadata/{address} -> HTTP {}", get_response.status());
    assert!(get_response.status().is_success(), "metadata should now be readable");
    let fetched = SignedPayloadProto::decode(get_response.bytes().await?.as_ref())?;
    assert_eq!(fetched.payload, signed_metadata.payload, "round-tripped metadata should match");
    println!("Identity registration verified end-to-end: no payment was made, POP disabled.");

    Ok(())
}

fn anyhow_bail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}
