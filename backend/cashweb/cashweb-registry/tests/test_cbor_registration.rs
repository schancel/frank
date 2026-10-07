//! Deterministic production-boundary regression tests for deterministic-CBOR account registration
//! and dual-format coexistence (issue #605, #133).
//!
//! Covers:
//! 1. Successful create -> persist -> restart -> read -> verify -> lookup
//! 2. TypeScript/Rust byte identity for the actual production record (shared vector)
//! 3. Wrong-network and altered-signature rejection (fail closed)
//! 4. Duplicate/replay and non-monotonic revision rejection
//! 5. Unsupported algorithm handling (fails closed)
//! 6. Legacy-record coexistence without rewriting or transcoding
//! 7. Maximum integer/timestamp boundaries
//! 8. Rollback / failed-write behavior with no partial durable state

use std::sync::Arc;

use bitcoinsuite_core::{
    ecc::{Ecc, SecKey},
    ByteArray, Hashed, Net, Sha256,
};
use bitcoinsuite_ecc_secp256k1::EccSecp256k1;
use cashweb_payload::payload::SignatureScheme;
use cashweb_registry::{
    http::{pop_protection::PopGate, server::RegistryServer},
    monad_http::Address,
    p2p::peers::Peers,
    proto,
    registry::Registry,
    store::db::Db,
    test_instance::placeholder_pop_conf,
};
use frank_cbor::{
    address_from_compressed_pubkey, address_from_uncompressed_pubkey, cbor_map,
    directory_signature_digest, encode_frame, expiry_timestamp, split_timestamp_ms, CborValue,
    EnvelopeFields, FramePayload,
};
use hyper::{header::CONTENT_TYPE, Body, Request, StatusCode};
use pretty_assertions::assert_eq;
use prost::Message;
use tower::ServiceExt;

const CONTENT_TYPE_CBOR: &str = "application/cbor";

#[derive(Debug)]
struct NeverCalledChainAdapter;

#[async_trait::async_trait]
impl cashweb_payload::chain_adapter::ChainAdapter for NeverCalledChainAdapter {
    async fn submit_tx(
        &self,
        _raw_tx: &[u8],
    ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::SubmitTxOutcome> {
        Ok(cashweb_payload::chain_adapter::SubmitTxOutcome::AlreadyConfirmed)
    }
    async fn get_tx(
        &self,
        _txid: &bitcoinsuite_core::Sha256d,
    ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    async fn test_accept(
        &self,
        _raw_tx: &[u8],
    ) -> bitcoinsuite_error::Result<cashweb_payload::chain_adapter::MempoolAcceptResult> {
        Ok(Ok(()))
    }
    async fn subscribe_new_blocks(
        &self,
    ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>> {
        let (_sender, receiver) = tokio::sync::mpsc::channel(1);
        Ok(receiver)
    }
    fn decode_burn(
        &self,
        _commitment_id: [u8; 4],
        _burn_output_script: &bitcoinsuite_core::Script,
    ) -> bitcoinsuite_error::Result<bitcoinsuite_core::Sha256> {
        unimplemented!("Monad profile registration never touches ChainAdapter")
    }
}

fn open_registry(path: &std::path::Path, net: Net) -> Registry {
    let db = Db::open(path.join("db.rocksdb")).unwrap();
    Registry::new(db, Arc::new(NeverCalledChainAdapter), net)
}

fn make_server(registry: Registry) -> RegistryServer {
    let pop_gate = PopGate::from_conf_if_enabled(&placeholder_pop_conf());
    let event_bus = registry.event_bus().clone();
    RegistryServer {
        registry: Arc::new(registry),
        peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
        pop_gate: Arc::new(pop_gate),
        curated_defaults: Arc::new(vec![]),
        monad_mailbox: cashweb_registry::monad_mailbox::MonadMailboxRuntime::Disabled,
        evm_rpc: None,
        bitcoin_proxy: None,
        solana_proxy: None,
        spa_dir: None,
        event_bus,
    }
}

fn seckey(byte: u8) -> SecKey {
    EccSecp256k1::default()
        .seckey_from_array([byte; 32])
        .unwrap()
}

fn build_cbor_attestation(
    seckey: &SecKey,
    network: &str,
    revision: u64,
    timestamp_ms: i64,
    ttl_ms: i64,
    display_name: Option<&str>,
    bio: Option<&str>,
    algorithm: u32,
) -> (Vec<u8>, Address, Vec<u8>) {
    let ecc = EccSecp256k1::default();
    let pubkey = ecc.derive_pubkey(seckey);
    let pubkey_bytes = pubkey.as_slice().to_vec();
    let addr_bytes = address_from_compressed_pubkey(&pubkey_bytes).unwrap();
    let address = Address(addr_bytes);

    let ts = split_timestamp_ms(timestamp_ms as i128).unwrap();
    let exp = expiry_timestamp(timestamp_ms, ttl_ms).unwrap();

    let relay = cbor_map(vec![
        (0, CborValue::Bytes(vec![1; 16])),
        (
            1,
            CborValue::Text("https://relay1.frank.example/monad-testnet".to_string()),
        ),
        (
            2,
            cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Bytes(pubkey_bytes.clone())),
            ]),
        ),
        (
            3,
            cbor_map(vec![
                (0, CborValue::Int(2_000_000_000)),
                (1, CborValue::Int(0)),
            ]),
        ),
    ]);

    let mut profile_entries = Vec::new();
    if let Some(name) = display_name {
        profile_entries.push(cbor_map(vec![
            (0, CborValue::Text("display_name".to_string())),
            (1, CborValue::Array(vec![])),
            (2, CborValue::Bytes(name.as_bytes().to_vec())),
        ]));
    }
    if let Some(bio_text) = bio {
        profile_entries.push(cbor_map(vec![
            (0, CborValue::Text("bio".to_string())),
            (1, CborValue::Array(vec![])),
            (2, CborValue::Bytes(bio_text.as_bytes().to_vec())),
        ]));
    }

    let mut statement_entries = vec![
        (0, CborValue::Text(network.to_string())),
        (
            1,
            cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Bytes(pubkey_bytes.clone())),
            ]),
        ),
        (2, CborValue::Int(revision as i128)),
        (
            3,
            cbor_map(vec![
                (0, CborValue::Int(ts.seconds.into())),
                (1, CborValue::Int(ts.nanoseconds as i128)),
            ]),
        ),
        (4, CborValue::Array(vec![relay])),
        (
            6,
            cbor_map(vec![
                (0, CborValue::Int(exp.seconds.into())),
                (1, CborValue::Int(exp.nanoseconds as i128)),
            ]),
        ),
        (
            8,
            cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Bytes(pubkey_bytes.clone())),
            ]),
        ),
    ];
    if !profile_entries.is_empty() {
        statement_entries.push((9, CborValue::Array(profile_entries)));
    }

    let statement_frame = encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version: 3,
            min_reader_version: 2,
        },
        FramePayload::Value(&cbor_map(statement_entries)),
    )
    .unwrap();

    let digest = directory_signature_digest(network, &statement_frame).unwrap();
    let sig = ecc.sign(seckey, ByteArray::new(digest));

    let sig_entry = cbor_map(vec![
        (0, CborValue::Int(algorithm as i128)),
        (
            1,
            cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, CborValue::Bytes(pubkey_bytes.clone())),
            ]),
        ),
        (2, CborValue::Bytes(sig.to_vec())),
    ]);

    let attestation_frame = encode_frame(
        EnvelopeFields {
            type_id: 2,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&cbor_map(vec![
            (0, CborValue::Bytes(statement_frame)),
            (1, CborValue::Array(vec![sig_entry])),
        ])),
    )
    .unwrap();

    (attestation_frame, address, pubkey_bytes)
}

fn build_legacy_signed_payload(
    seckey: &SecKey,
    timestamp: i64,
    display_name: Option<&str>,
) -> (Vec<u8>, Address, Vec<u8>) {
    let ecc = EccSecp256k1::default();
    let pubkey = ecc.derive_pubkey(seckey);
    let uncompressed = ecc.serialize_pubkey_uncompressed(&pubkey);
    let mut uncompressed_arr = [0u8; 65];
    uncompressed_arr.copy_from_slice(&uncompressed);
    let addr_bytes = address_from_uncompressed_pubkey(&uncompressed_arr).unwrap();
    let address = Address(addr_bytes);

    let mut entries = Vec::new();
    if let Some(name) = display_name {
        entries.push(proto::AddressEntry {
            kind: "display_name".to_string(),
            headers: Default::default(),
            body: name.as_bytes().to_vec(),
        });
    }

    let profile = proto::MonadProfile {
        timestamp,
        ttl: 1000 * 60 * 60 * 24 * 365,
        entries,
    };
    let payload = profile.encode_to_vec();
    let payload_hash = Sha256::digest(payload.clone().into());
    let sig = ecc.sign(seckey, payload_hash.byte_array().clone());

    let signed = cashweb_payload::proto::SignedPayload {
        pubkey: pubkey.as_slice().to_vec(),
        sig: sig.to_vec(),
        sig_scheme: SignatureScheme::Ecdsa.into(),
        payload,
        payload_hash: payload_hash.as_slice().to_vec(),
        burn_amount: 0,
        burn_txs: vec![],
    };
    (signed.encode_to_vec(), address, pubkey.as_slice().to_vec())
}

#[tokio::test]
async fn test_create_persist_restart_read_verify_lookup() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--cbor-roundtrip").unwrap();
    let key = seckey(10);
    let (cbor_bytes, address, _pubkey) = build_cbor_attestation(
        &key,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("Alice"),
        Some("Decentralized pioneer"),
        1,
    );

    // 1. Initial PUT via router
    {
        let registry = open_registry(tempdir.path(), Net::Regtest);
        let server = make_server(registry);
        let router = server.into_router();

        let req = Request::builder()
            .method("PUT")
            .uri(format!("/metadata/{}", address.to_hex()))
            .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
            .header("Origin", "http://frank.local")
            .body(Body::from(cbor_bytes.clone()))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // 2. Simulate complete restart: reopen database from disk
    {
        let registry = open_registry(tempdir.path(), Net::Regtest);
        let server = make_server(registry);
        let router = server.into_router();

        // 3. GET /metadata/:addr returns exact CBOR bytes and application/cbor
        let req = Request::builder()
            .method("GET")
            .uri(format!("/metadata/{}", address.to_hex()))
            .body(Body::empty())
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(CONTENT_TYPE).unwrap().to_str().unwrap(),
            CONTENT_TYPE_CBOR
        );
        let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
        assert_eq!(body.to_vec(), cbor_bytes);

        // 4. Discovery via /metadata/monad?since=0 includes exact CBOR bytes
        let req = Request::builder()
            .method("GET")
            .uri("/metadata/monad?since=0")
            .body(Body::empty())
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
        let list = proto::ListMonadProfilesResponse::decode(body).unwrap();
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].address, address.to_hex());
        assert_eq!(list.entries[0].signed_payload, cbor_bytes);

        // 5. Prefix search by display_name
        let req = Request::builder()
            .method("GET")
            .uri("/metadata/monad/search?prefix=ali")
            .body(Body::empty())
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
        let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
        assert_eq!(search.entries.len(), 1);
        assert_eq!(search.entries[0].address, address.to_hex());
        assert_eq!(search.entries[0].signed_payload, cbor_bytes);

        // 6. Canonical network-agnostic routes: /profiles/search and /profiles
        let req = Request::builder()
            .method("GET")
            .uri("/profiles/search?prefix=ali")
            .body(Body::empty())
            .unwrap();

        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
        let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
        assert_eq!(search.entries.len(), 1);
        assert_eq!(search.entries[0].address, address.to_hex());

        let req = Request::builder()
            .method("GET")
            .uri("/profiles?since=0")
            .body(Body::empty())
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
        let list = proto::ListMonadProfilesResponse::decode(body).unwrap();
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].address, address.to_hex());
    }
}

#[tokio::test]
async fn test_typescript_rust_byte_identity_for_actual_production_record() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--cbor-ts-identity").unwrap();
    let manifest_text =
        include_str!("../../../../docs/protocol/cbor/vectors/account-registration.json");
    let manifest: serde_json::Value = serde_json::from_str(manifest_text).unwrap();
    let case = manifest["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"].as_str() == Some("reg-fixture-testnet-statement-typed"))
        .unwrap();

    let frame_hex = case["frame_hex"].as_str().unwrap();
    let frame_bytes = hex::decode(frame_hex).unwrap();

    let pubkey_bytes =
        hex::decode("03a15a52deb82549bc2326d42219400f41190ace7bf040fa8721017f2c10512b65").unwrap();
    let addr_bytes = address_from_compressed_pubkey(&pubkey_bytes).unwrap();
    let address = Address(addr_bytes);

    // Register on Net::Regtest (which maps to monad-testnet)
    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(frame_bytes.clone()))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify GET returns exact byte identity
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", address.to_hex()))
        .body(Body::empty())
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    assert_eq!(body.to_vec(), frame_bytes);

    // Search by name "alice" finds this profile
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad/search?prefix=alice")
        .body(Body::empty())
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(search.entries.len(), 1);
    assert_eq!(search.entries[0].address, address.to_hex());
    assert_eq!(search.entries[0].signed_payload, frame_bytes);
}

#[tokio::test]
async fn test_wrong_network_and_altered_signature_rejection() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--cbor-rejections").unwrap();
    let key = seckey(11);

    // 1. Wrong network: statement has "monad-mainnet", server is Net::Regtest ("monad-testnet")
    let (wrong_net_bytes, address, _) = build_cbor_attestation(
        &key,
        "monad-mainnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("NetFail"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(wrong_net_bytes))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 2. Altered signature: valid statement, but signature corrupted
    let (mut bad_sig_bytes, address2, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("SigFail"),
        None,
        1,
    );
    let len = bad_sig_bytes.len();
    bad_sig_bytes[len - 2] ^= 0xff; // corrupt signature

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address2.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(bad_sig_bytes))
        .unwrap();

    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_duplicate_replay_and_non_monotonic_revision_rejection() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--cbor-monotonic").unwrap();
    let key = seckey(12);

    let (cbor_rev1, address, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        10,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("MonoUser"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    // 1. Initial PUT accepted
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_rev1.clone()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 2. Exact duplicate/replay rejected
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_rev1.clone()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 3. Lower revision (revision 9 < 10) rejected
    let (cbor_rev_lower, _, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        9,
        1_700_000_001_000,
        1000 * 60 * 60 * 24 * 365,
        Some("MonoUser"),
        None,
        1,
    );
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_rev_lower))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 4. Higher revision (revision 11 > 10) accepted
    let (cbor_rev_higher, _, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        11,
        1_700_000_002_000,
        1000 * 60 * 60 * 24 * 365,
        Some("MonoUserUpdated"),
        None,
        1,
    );
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_rev_higher.clone()))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_unsupported_algorithm_handling() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--cbor-unsupported-alg").unwrap();
    let key = seckey(13);

    // Algorithm 99 is unallocated; algorithm 2 is allocated but not verifiable in this slice
    for alg in [2, 99] {
        let (cbor_bytes, address, _) = build_cbor_attestation(
            &key,
            "monad-testnet",
            1,
            1_700_000_000_000,
            1000 * 60 * 60 * 24 * 365,
            Some("AlgTest"),
            None,
            alg,
        );

        let registry = open_registry(tempdir.path(), Net::Regtest);
        let server = make_server(registry);
        let router = server.into_router();

        let req = Request::builder()
            .method("PUT")
            .uri(format!("/metadata/{}", address.to_hex()))
            .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
            .header("Origin", "http://frank.local")
            .body(Body::from(cbor_bytes))
            .unwrap();

        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn test_legacy_record_coexistence_without_rewriting() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--coexistence").unwrap();
    let key_legacy = seckey(14);
    let key_cbor = seckey(15);

    let (legacy_bytes, legacy_addr, _) =
        build_legacy_signed_payload(&key_legacy, 100, Some("LegacyUser"));
    let (cbor_bytes, cbor_addr, _) = build_cbor_attestation(
        &key_cbor,
        "monad-testnet",
        200,
        200,
        1000 * 60 * 60 * 24 * 365,
        Some("CborUser"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    // 1. Register legacy protobuf
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", legacy_addr.to_hex()))
        .header(CONTENT_TYPE, "application/x-protobuf")
        .header("Origin", "http://frank.local")
        .body(Body::from(legacy_bytes.clone()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 2. Register CBOR
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", cbor_addr.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_bytes.clone()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 3. GET legacy returns exact protobuf bytes and application/x-protobuf
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", legacy_addr.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get(CONTENT_TYPE).unwrap().to_str().unwrap(),
        "application/x-protobuf"
    );
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    assert_eq!(body.to_vec(), legacy_bytes);

    // 4. GET CBOR returns exact CBOR bytes and application/cbor
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", cbor_addr.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get(CONTENT_TYPE).unwrap().to_str().unwrap(),
        CONTENT_TYPE_CBOR
    );
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    assert_eq!(body.to_vec(), cbor_bytes);

    // 5. Listing /metadata/monad?since=0 contains BOTH records with exact stored bytes
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad?since=0")
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let list = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].address, legacy_addr.to_hex());
    assert_eq!(list.entries[0].signed_payload, legacy_bytes);
    assert_eq!(list.entries[1].address, cbor_addr.to_hex());
    assert_eq!(list.entries[1].signed_payload, cbor_bytes);

    // 6. Overwrite legacy profile with CBOR profile atomically cleans up old name
    let (cbor_over_legacy, _, _) = build_cbor_attestation(
        &key_legacy,
        "monad-testnet",
        300,
        300,
        1000 * 60 * 60 * 24 * 365,
        Some("UpdatedUser"),
        None,
        1,
    );
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", legacy_addr.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_over_legacy.clone()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Old name "legacyuser" is no longer found in search
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad/search?prefix=legacy")
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(search.entries.len(), 0);

    // New name "updateduser" is found
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad/search?prefix=updated")
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(search.entries.len(), 1);
    assert_eq!(search.entries[0].address, legacy_addr.to_hex());
    assert_eq!(search.entries[0].signed_payload, cbor_over_legacy);
}

#[tokio::test]
async fn test_rollback_on_failed_write_leaves_no_partial_state() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--rollback").unwrap();
    let key = seckey(16);

    // Invalid signature
    let (mut bad_cbor, address, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("GhostUser"),
        None,
        1,
    );
    let len = bad_cbor.len();
    bad_cbor[len - 1] ^= 0xff;

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(bad_cbor))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 1. GET returns 404
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", address.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // 2. Listing is empty
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad?since=0")
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let list = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(list.entries.len(), 0);

    // 3. Search is empty
    let req = Request::builder()
        .method("GET")
        .uri("/metadata/monad/search?prefix=ghost")
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    let search = proto::ListMonadProfilesResponse::decode(body).unwrap();
    assert_eq!(search.entries.len(), 0);
}

#[tokio::test]
async fn test_max_integer_and_timestamp_boundaries() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--boundaries").unwrap();
    let key = seckey(17);

    // 1. Extreme valid boundaries: u64::MAX revision, large timestamp
    let (cbor_bytes, address, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        u64::MAX,
        1_000_000_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("MaxUser"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_bytes.clone()))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", address.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = hyper::body::to_bytes(resp.into_body()).await.unwrap();
    assert_eq!(body.to_vec(), cbor_bytes);
}

#[tokio::test]
async fn test_address_mismatch_rejection() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--mismatch").unwrap();
    let key_a = seckey(21);
    let key_b = seckey(22);

    let (cbor_bytes_a, address_a, _) = build_cbor_attestation(
        &key_a,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("Alice"),
        None,
        1,
    );
    let (_, address_b, _) = build_cbor_attestation(
        &key_b,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("Bob"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    // PUT attestation for Address A to Address B route
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address_b.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(cbor_bytes_a.clone()))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // Verify Address B was never created
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", address_b.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // Verify Address A was never created either
    let req = Request::builder()
        .method("GET")
        .uri(format!("/metadata/{}", address_a.to_hex()))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_oversized_payload_rejection_sec1() {
    let tempdir = tempdir::TempDir::new("cashweb-registry--oversized").unwrap();
    let key = seckey(23);
    let (_, address, _) = build_cbor_attestation(
        &key,
        "monad-testnet",
        1,
        1_700_000_000_000,
        1000 * 60 * 60 * 24 * 365,
        Some("Oversized"),
        None,
        1,
    );

    let registry = open_registry(tempdir.path(), Net::Regtest);
    let server = make_server(registry);
    let router = server.into_router();

    // Send payload of 1_048_577 bytes (1 byte over the 1 MiB limit)
    let oversized = vec![0u8; 1_048_577];
    let req = Request::builder()
        .method("PUT")
        .uri(format!("/metadata/{}", address.to_hex()))
        .header(CONTENT_TYPE, CONTENT_TYPE_CBOR)
        .header("Origin", "http://frank.local")
        .body(Body::from(oversized))
        .unwrap();

    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
