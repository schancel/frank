use super::*;
use crate::{
    directory_runtime::*, disabled_chain_adapter::DisabledChainAdapter, registry::Registry,
    store::db::Db,
};
use axum::body::Body;
use bitcoinsuite_core::Net;
use cashweb_config::DirectoryConf;
use frank_cbor::{
    cbor_map, decode_canonical, encode_frame, CborValue, EnvelopeFields, FramePayload,
};
use secp256k1_abc::{Message, PublicKey, Secp256k1, SecretKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

/// Key of the reviewed vectors' account (secret scalar 1).
pub(crate) const SUBJECT: &str =
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const NETWORK: &str = "monad-testnet";

fn source() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap()
}
pub(crate) fn record(id: &str) -> Value {
    source()["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
        .clone()
}
fn vector(id: &str) -> Vec<u8> {
    hex::decode(record(id)["type2_hex"].as_str().unwrap()).unwrap()
}
/// The whole relay configuration: its own tuple. No account appears in it.
pub(crate) fn relay_config() -> DirectoryConf {
    serde_json::from_value(serde_json::json!({
        "network": NETWORK,
        "relay_id": "000102030405060708090a0b0c0d0e0f",
        "relay_identity": "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
        "endpoint": "https://relay.example.invalid",
        "binding_expiry_ns": "1700007200000000000",
    }))
    .unwrap()
}
fn registry(root: &std::path::Path) -> Arc<Registry> {
    Arc::new(Registry::new(
        Db::open(root.join("db")).unwrap(),
        Arc::new(DisabledChainAdapter),
        Net::Regtest,
    ))
}
/// The vectors are signed for 2023, so tests run the relay on a clock set to their time.
pub(crate) fn setup(root: &std::path::Path) -> (Arc<Registry>, DirectoryConf, TestClock) {
    (registry(root), relay_config(), TestClock::at(1700000100))
}
async fn start(
    registry: Arc<Registry>,
    config: DirectoryConf,
    clock: &TestClock,
) -> DirectoryRuntime {
    let (runtime, ready) =
        DirectoryRuntime::start_with_clock(registry, config, clock.clock()).unwrap();
    ready.await.unwrap().unwrap();
    runtime
}
/// One self-signed entry of an account whose key is derived from `secret`.
pub(crate) struct Entry {
    pub(crate) subject: String,
    pub(crate) address: String,
    pub(crate) attestation: Vec<u8>,
    pub(crate) hash: [u8; 32],
}
/// Build and sign an entry exactly as an account would: the reviewed bootstrap statement with
/// this account's key as subject, optionally edited, signed by that same key.
pub(crate) fn entry(secret: u32, edit: impl Fn(&mut Vec<(u64, CborValue)>)) -> Entry {
    signed(secret, secret, edit)
}
/// As [`entry`], but signed by `signer` while naming the key of `secret` as subject.
fn signed(secret: u32, signer: u32, edit: impl Fn(&mut Vec<(u64, CborValue)>)) -> Entry {
    let scalar = |n: u32| {
        let mut bytes = [0; 32];
        bytes[28..].copy_from_slice(&n.to_be_bytes());
        SecretKey::from_slice(&bytes).unwrap()
    };
    let secp = Secp256k1::new();
    let point = PublicKey::from_secret_key(&secp, &scalar(secret)).serialize();
    let original = hex::decode(record("bootstrap")["type4_hex"].as_str().unwrap()).unwrap();
    let CborValue::Map(envelope) = decode_canonical(&original[9..]).unwrap() else {
        panic!("envelope")
    };
    let Some((_, CborValue::Bytes(body))) = envelope.iter().find(|(key, _)| *key == 3) else {
        panic!("body")
    };
    let CborValue::Map(mut fields) = decode_canonical(body).unwrap() else {
        panic!("payload")
    };
    let subject = cbor_map(vec![
        (0, CborValue::Int(1)),
        (1, CborValue::Bytes(point.to_vec())),
    ]);
    for (key, value) in &mut fields {
        if *key == 1 {
            *value = subject.clone();
        }
    }
    edit(&mut fields);
    let statement = encode_frame(
        EnvelopeFields {
            type_id: 4,
            schema_version: 4,
            min_reader_version: 4,
        },
        FramePayload::Value(&CborValue::Map(fields)),
    )
    .unwrap();
    let hash: [u8; 32] = Sha256::digest(
        frank_cbor::common_transcript("frank/content-hash/v1", NETWORK, &statement, &[]).unwrap(),
    )
    .into();
    let signature = secp
        .sign(
            &Message::from_slice(
                &frank_cbor::directory_signature_digest(NETWORK, &statement).unwrap(),
            )
            .unwrap(),
            &scalar(signer),
        )
        .serialize_der()
        .to_vec();
    let wrapper = cbor_map(vec![
        (0, CborValue::Bytes(statement)),
        (
            1,
            CborValue::Array(vec![cbor_map(vec![
                (0, CborValue::Int(1)),
                (1, subject),
                (2, CborValue::Bytes(signature)),
            ])]),
        ),
    ]);
    let attestation = encode_frame(
        EnvelopeFields {
            type_id: 2,
            schema_version: 1,
            min_reader_version: 1,
        },
        FramePayload::Value(&wrapper),
    )
    .unwrap();
    Entry {
        subject: hex::encode(point),
        address: crate::monad_stamp_stealth::recipient_address_from_public_key(&point)
            .unwrap()
            .to_hex(),
        attestation,
        hash,
    }
}
fn head(subject: &str) -> String {
    format!("/directory/v1/{NETWORK}/{subject}/head")
}
fn by_address(address: &str) -> String {
    format!("/directory/v1/{NETWORK}/address/{address}")
}
async fn request(
    router: Router,
    method: &str,
    path: &str,
    bytes: Vec<u8>,
    media: &str,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    request_from(router, method, path, bytes, media, None).await
}
async fn request_from(
    router: Router,
    method: &str,
    path: &str,
    bytes: Vec<u8>,
    media: &str,
    forwarded_for: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, media);
    if let Some(source) = forwarded_for {
        builder = builder.header("x-forwarded-for", source);
    }
    let response = router
        .oneshot(builder.body(Body::from(bytes)).unwrap())
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = hyper::body::to_bytes(response.into_body())
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}
async fn put(routes: &Router, subject: &str, bytes: Vec<u8>) -> (StatusCode, HeaderMap, Vec<u8>) {
    request(routes.clone(), "PUT", &head(subject), bytes, MEDIA).await
}
async fn get(routes: &Router, path: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    request(routes.clone(), "GET", path, vec![], MEDIA).await
}

#[tokio::test]
async fn unseen_account_publishes_itself_and_is_found_by_key_and_by_address() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    // Nothing in the relay configuration names this account; it is simply unknown so far.
    let account = entry(42, |_| ());
    assert_eq!(
        get(&routes, &head(&account.subject)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&routes, &by_address(&account.address)).await.0,
        StatusCode::NOT_FOUND
    );

    let published = put(&routes, &account.subject, account.attestation.clone()).await;
    assert_eq!(published.0, StatusCode::OK);
    assert_eq!(published.2, account.attestation);
    assert_eq!(published.1["x-frank-directory-evidence"], "fresh-current");

    let by_key = get(&routes, &head(&account.subject)).await;
    assert_eq!(by_key.0, StatusCode::OK);
    assert_eq!(by_key.2, account.attestation);
    let found = get(&routes, &by_address(&account.address)).await;
    assert_eq!(found.0, StatusCode::OK);
    assert_eq!(found.2, account.attestation);
    assert_eq!(
        found.1["x-frank-directory-subject"],
        account.subject.as_str()
    );
    assert_eq!(found.1["x-frank-directory-evidence"], "fresh-current");
    assert_eq!(found.1[header::CONTENT_TYPE], MEDIA);
    // A second, unrelated account on the same relay.
    let other = entry(43, |_| ());
    assert_eq!(
        put(&routes, &other.subject, other.attestation.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        get(&routes, &by_address(&other.address)).await.2,
        other.attestation
    );
    assert_eq!(
        get(&routes, &by_address(&account.address)).await.2,
        account.attestation
    );
    // Malformed and unknown addresses.
    assert_eq!(
        get(&routes, &by_address("0x1234")).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&routes, &by_address(&format!("0x{}", "11".repeat(20))))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // An entry for another network is not this relay's to hold.
    assert_eq!(
        request(
            routes.clone(),
            "PUT",
            &format!("/directory/v1/other-network/{}/head", account.subject),
            account.attestation.clone(),
            MEDIA
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn relay_info_is_the_single_configured_tuple() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let info = get(&routes, "/relay/v1/info").await;
    assert_eq!(info.0, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&info.2).unwrap(),
        serde_json::json!({
            "network": "monad-testnet",
            "relayId": "000102030405060708090a0b0c0d0e0f",
            "endpoint": "https://relay.example.invalid",
            "relayKey": "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
            "bindingExpiry": "1700007200000000000",
            "forwarding": false,
        })
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn exact_http_admission_duplicate_history_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry.clone(), config.clone(), &clock).await;
    let path = head(SUBJECT);
    let routes = router(Arc::new(runtime.clone()));
    let original = vector("bootstrap");
    let result = put(&routes, SUBJECT, original.clone()).await;
    assert_eq!(result.0, StatusCode::OK);
    assert_eq!(result.2, original);
    assert_eq!(result.1["x-frank-directory-evidence"], "fresh-current");
    let renew = vector("renew");
    assert_eq!(put(&routes, SUBJECT, renew.clone()).await.0, StatusCode::OK);
    let duplicate = put(&routes, SUBJECT, original.clone()).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert_eq!(duplicate.2, renew);
    let history = path.trim_end_matches("head").to_owned()
        + "statements/"
        + record("bootstrap")["t1"].as_str().unwrap();
    let result = get(&routes, &history).await;
    assert_eq!(result.2, original);
    assert_eq!(result.1["x-frank-directory-evidence"], "historical");
    assert_eq!(
        request(
            routes.clone(),
            "PUT",
            &path,
            original.clone(),
            "application/json"
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let address = crate::monad_stamp_stealth::recipient_address_from_public_key(
        &hex::decode(SUBJECT).unwrap(),
    )
    .unwrap()
    .to_hex();
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
    drop(routes);
    drop(runtime);
    // A full process restart: the old registry and database handle are gone.
    let released = Arc::downgrade(&registry);
    drop(registry);
    tokio::time::timeout(Duration::from_secs(5), async {
        while released.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let reopened = start(self::registry(root.path()), config, &clock).await;
    let routes = router(Arc::new(reopened.clone()));
    assert_eq!(get(&routes, &path).await.2, renew);
    let found = get(&routes, &by_address(&address)).await;
    assert_eq!(found.2, renew);
    assert_eq!(found.1["x-frank-directory-subject"], SUBJECT);
    assert_eq!(get(&routes, &history).await.2, original);
    // The pinned first entry survived too: a different revision 0 is still refused.
    assert_eq!(
        put(&routes, SUBJECT, vector("wrong-relay")).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(get(&routes, &path).await.2, renew);
    reopened.begin_shutdown();
    reopened.wait_stopped().await;
}

#[tokio::test]
async fn forged_entries_are_refused_and_publish_nothing() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let victim = entry(50, |_| ());
    let attacker = entry(51, |_| ());
    // The attacker's own valid entry, offered under the victim's key.
    assert_eq!(
        put(&routes, &victim.subject, attacker.attestation.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // An entry naming the victim but signed with the attacker's key.
    let forged = signed(50, 51, |_| ());
    assert_eq!(forged.subject, victim.subject);
    assert_eq!(
        put(&routes, &victim.subject, forged.attestation.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // The reviewed corpus's broken and foreign signatures over the reviewed account.
    for id in ["bad-signature", "wrong-signer"] {
        assert_eq!(
            put(&routes, SUBJECT, vector(id)).await.0,
            StatusCode::BAD_REQUEST,
            "{id}"
        );
    }
    for unpublished in [&victim.subject, SUBJECT] {
        assert_eq!(
            get(&routes, &head(unpublished)).await.0,
            StatusCode::NOT_FOUND
        );
        assert!(!runtime.is_published(NETWORK, unpublished));
    }
    assert_eq!(
        get(&routes, &by_address(&victim.address)).await.0,
        StatusCode::NOT_FOUND
    );
    // A first entry that is not revision 0 cannot start a chain.
    let later = entry(52, |fields| {
        for (key, value) in fields.iter_mut() {
            match *key {
                2 => *value = CborValue::Int(1),
                13 => *value = CborValue::Bytes(vec![7; 32]),
                _ => (),
            }
        }
    });
    assert_eq!(
        put(&routes, &later.subject, later.attestation).await.0,
        StatusCode::CONFLICT
    );
    // Once the victim has published, a forgery still cannot replace or extend its chain.
    assert_eq!(
        put(&routes, &victim.subject, victim.attestation.clone())
            .await
            .0,
        StatusCode::OK
    );
    for bytes in [forged.attestation, attacker.attestation] {
        assert_ne!(put(&routes, &victim.subject, bytes).await.0, StatusCode::OK);
    }
    assert_eq!(
        get(&routes, &head(&victim.subject)).await.2,
        victim.attestation
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn conflicting_first_entry_is_refused_and_a_forked_chain_is_quarantined() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let original = vector("bootstrap");
    assert_eq!(
        put(&routes, SUBJECT, original.clone()).await.0,
        StatusCode::OK
    );
    // The same key signs a second, different revision 0 (it names another relay key).
    let conflicting = put(&routes, SUBJECT, vector("wrong-relay")).await;
    assert_eq!(conflicting.0, StatusCode::CONFLICT);
    assert_eq!(conflicting.1["x-frank-directory-disposition"], "rejected");
    assert_eq!(get(&routes, &head(SUBJECT)).await.2, original);
    // Two different signed successors of one revision: the chain is quarantined, not resolved
    // by picking the newer timestamp.
    let renew = vector("renew");
    assert_eq!(put(&routes, SUBJECT, renew).await.0, StatusCode::OK);
    assert_eq!(
        put(&routes, SUBJECT, vector("fork-of-renew")).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(get(&routes, &head(SUBJECT)).await.0, StatusCode::CONFLICT);
    let history = head(SUBJECT).trim_end_matches("head").to_owned()
        + "statements/"
        + record("bootstrap")["t1"].as_str().unwrap();
    assert_eq!(get(&routes, &history).await.2, original);
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn publishing_is_limited_per_source_and_by_a_relay_wide_cap() {
    let root = tempfile::tempdir().unwrap();
    let (registry, mut config, clock) = setup(root.path());
    config.enrollments_per_source_per_hour = 2;
    config.max_subjects = 4;
    // The test client connects from loopback and stands in for a listed reverse proxy.
    config.trusted_proxies = vec!["127.0.0.1".parse().unwrap()];
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let accounts: Vec<Entry> = (60..66).map(|secret| entry(secret, |_| ())).collect();
    let publish = |index: usize, source: &'static str| {
        let (routes, account) = (routes.clone(), &accounts[index]);
        async move {
            request_from(
                routes,
                "PUT",
                &head(&account.subject),
                account.attestation.clone(),
                MEDIA,
                Some(source),
            )
            .await
        }
    };
    // Forgeries and garbage are refused without using up the source's allowance.
    let forged = signed(60, 99, |_| ());
    for _ in 0..5 {
        for bytes in [forged.attestation.clone(), vec![1, 2, 3]] {
            let refused = request_from(
                routes.clone(),
                "PUT",
                &head(&accounts[0].subject),
                bytes,
                MEDIA,
                Some("203.0.113.7"),
            )
            .await;
            assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        }
    }
    assert_eq!(publish(0, "203.0.113.7").await.0, StatusCode::OK);
    assert_eq!(publish(1, "203.0.113.7").await.0, StatusCode::OK);
    let limited = publish(2, "203.0.113.7").await;
    assert_eq!(limited.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.1["x-frank-directory-disposition"], "rejected");
    assert!(!runtime.is_published(NETWORK, &accounts[2].subject));
    // Re-publishing an existing account is not a first publication and is not charged.
    assert_eq!(publish(0, "203.0.113.7").await.0, StatusCode::OK);
    // Another source is unaffected, until the relay-wide cap of four subjects is reached.
    assert_eq!(publish(2, "198.51.100.9").await.0, StatusCode::OK);
    assert_eq!(publish(3, "198.51.100.9").await.0, StatusCode::OK);
    assert_eq!(
        publish(4, "192.0.2.33").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(!runtime.is_published(NETWORK, &accounts[4].subject));
    assert_eq!(
        get(&routes, &head(&accounts[3].subject)).await.0,
        StatusCode::OK
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn slow_uploads_hold_no_queue_slot_and_bodies_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let path = head(SUBJECT);
    let routes = router(Arc::new(runtime.clone()));
    assert_eq!(
        put(&routes, SUBJECT, vector("bootstrap")).await.0,
        StatusCode::OK
    );
    // Far more stalled uploads than the directory has queue slots, all for a published key.
    let mut stalled = Vec::new();
    for _ in 0..32 {
        let (sender, body) = Body::channel();
        let routes = routes.clone();
        let path = path.clone();
        stalled.push((
            sender,
            tokio::spawn(async move {
                routes
                    .oneshot(
                        axum::http::Request::builder()
                            .method("PUT")
                            .uri(&path)
                            .header(header::CONTENT_TYPE, MEDIA)
                            .body(body)
                            .unwrap(),
                    )
                    .await
                    .unwrap()
                    .status()
            }),
        ));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Lookups and another account's publication are served while those uploads hang.
    assert_eq!(get(&routes, &path).await.0, StatusCode::OK);
    let other = entry(71, |_| ());
    assert_eq!(
        put(&routes, &other.subject, other.attestation).await.0,
        StatusCode::OK
    );
    // A stalled upload ends by itself and was never started.
    let (sender, task) = stalled.remove(0);
    assert_eq!(task.await.unwrap(), StatusCode::SERVICE_UNAVAILABLE);
    drop(sender);
    for (sender, task) in stalled {
        drop(sender);
        task.abort();
    }
    // An entry larger than any real one is refused while being read.
    let oversized = request(
        routes.clone(),
        "PUT",
        &path,
        vec![0; MAX_ENTRY_BYTES + 1],
        MEDIA,
    )
    .await;
    assert_eq!(oversized.0, StatusCode::TOO_MANY_REQUESTS);
    // When every queue slot is genuinely taken, a complete request is told to retry.
    let mut held = Vec::new();
    for _ in 0..8 {
        held.push(runtime.reserve(NETWORK, SUBJECT).unwrap());
    }
    let busy = put(&routes, SUBJECT, vector("bootstrap")).await;
    assert_eq!(busy.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(busy.1["x-frank-directory-disposition"], "not-started");
    drop(held);
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn old_operator_configuration_is_refused_with_a_plain_reason() {
    let old: DirectoryConf = serde_json::from_value(serde_json::json!({
        "clock_file": "/var/lib/frank/clock",
        "principals": [{
            "network": NETWORK, "subject": SUBJECT, "revision_zero": "00", "manifest_identity": "00",
            "relay_id": "00", "relay_identity": "00", "endpoint": "https://relay.example.invalid",
            "binding_expiry_ns": "1", "continuity_file": "/x", "bundle_root": "/y", "mode": "new",
        }],
    }))
    .unwrap();
    let reason = old.validate().unwrap_err().to_string();
    assert!(
        reason.contains("principals") && reason.contains("removed"),
        "{reason}"
    );
    let root = tempfile::tempdir().unwrap();
    assert!(matches!(
        DirectoryRuntime::start(registry(root.path()), old),
        Err(RuntimeError::Trust)
    ));
    let mut incomplete = relay_config();
    incomplete.endpoint.clear();
    assert_eq!(
        incomplete.validate().unwrap_err().to_string(),
        "registry.directory.endpoint is required"
    );
    // A relay tuple that has already expired cannot start on the real clock.
    let (expired, ready) = DirectoryRuntime::start(registry(root.path()), relay_config()).unwrap();
    assert_eq!(ready.await.unwrap(), Err(RuntimeError::Trust));
    expired.wait_stopped().await;
}

#[tokio::test]
async fn real_http_socket_exact_bytes_and_expired_current_never_promote_history() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::Server::from_tcp(listener)
        .unwrap()
        .serve(
            router(Arc::new(runtime.clone()))
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        });
    let server = tokio::spawn(server);
    let path = format!("http://{address}{}", head(SUBJECT));
    let client = reqwest::Client::new();
    let original = vector("bootstrap");
    let put = client
        .put(&path)
        .header("content-type", MEDIA)
        .body(original.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status().as_u16(), 200);
    assert_eq!(put.bytes().await.unwrap().as_ref(), original);
    let get = client.get(&path).send().await.unwrap();
    assert_eq!(get.headers()["x-frank-directory-evidence"], "fresh-current");
    assert_eq!(get.bytes().await.unwrap().as_ref(), original);
    // An account that tries to publish an entry which has already expired stays unpublished.
    let stale = entry(70, |_| ());
    clock.set(1800000000);
    let refused = client
        .put(format!("http://{address}{}", head(&stale.subject)))
        .header("content-type", MEDIA)
        .body(stale.attestation)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 409);
    assert!(!runtime.is_published(NETWORK, &stale.subject));
    // The published entry has expired too: it is no longer served as current, by key or address.
    assert_eq!(
        client.get(&path).send().await.unwrap().status().as_u16(),
        409
    );
    let by_address = format!(
        "http://{address}{}",
        by_address(
            &crate::monad_stamp_stealth::recipient_address_from_public_key(
                &hex::decode(SUBJECT).unwrap()
            )
            .unwrap()
            .to_hex()
        )
    );
    let expired = client.get(by_address).send().await.unwrap();
    assert_eq!(expired.status().as_u16(), 409);
    assert!(expired.headers().get("x-frank-directory-subject").is_none());
    let history = path.trim_end_matches("head").to_owned()
        + "statements/"
        + record("bootstrap")["t1"].as_str().unwrap();
    let history = client.get(history).send().await.unwrap();
    assert_eq!(history.status().as_u16(), 200);
    assert_eq!(
        history.headers()["x-frank-directory-evidence"],
        "historical"
    );
    assert_eq!(history.bytes().await.unwrap().as_ref(), original);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

// This child uses actual reviewed provisioning/TLS material, public TS admission and the new
// client against a real Rust socket. All scalars and funds are disposable public fixtures.
const NODE_STAGE_A: &str = r#"
const path=require('node:path'),fs=require('node:fs'),net=require('node:net'),https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const [repo,root,mode,backend]=process.argv.slice(2);const load=p=>require(path.join(repo,p));
const codec=load('packages/frank-codec/src/index.ts'),{SigningKey}=require(require.resolve('ethers',{paths:[repo]}));
const provision=load('packages/bot/demo/directory-trust/provision.ts');
async function main(){
 if(mode==='prepare'){
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const source=JSON.parse(fs.readFileSync(path.join(repo,'docs/protocol/proposals/suite1-directory/vectors.json')));const record=source.records.find(r=>r.id==='bootstrap');
  const payload=new Map(codec.validateFrame(codec.fromHex(record.type4_hex),codec.previewDirectoryContext()).payload);
  const subject=codec.toHex(payload.get(1n).get(1n)),endpoint='https://127.0.0.1:'+port;
  const trust={network:'monad-testnet',subject,rev0T1:'00'.repeat(32),relayId:'000102030405060708090a0b0c0d0e0f',relayIdentity:{keyType:1,point:subject},endpoint,bindingExpiryNs:1700007200000000000n};
  payload.set(4n,[new Map([[0n,codec.fromHex(trust.relayId)],[1n,endpoint],[2n,new Map([[0n,1n],[1n,codec.fromHex(subject)]])],[3n,new Map([[0n,1700007200n],[1n,0n]])]])]);
  const statement=codec.encodeFrame({typeId:4,schemaVersion:4,minReaderVersion:4},payload);const signature=new SigningKey('0x'+'1'.padStart(64,'0')).sign('0x'+codec.toHex(codec.directorySignatureDigest(trust.network,statement)));
  const integer=h=>{let b=Buffer.from(h.slice(2),'hex');while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};const pair=Buffer.concat([integer(signature.r),integer(signature.s)]),der=Buffer.concat([Buffer.from([48,pair.length]),pair]);
  const attestation=codec.encodeFrame({typeId:2,schemaVersion:1,minReaderVersion:1},new Map([[0n,statement],[1n,[new Map([[0n,1n],[1n,payload.get(1n)],[2n,der]])]]]));
  trust.rev0T1=codec.toHex(codec.contentHash(codec.validateFrame(statement,codec.previewDirectoryContext())));
  const bundle=provision.initBundle({mode:'synthetic-demo',runDir:path.join(root,'directory-trust-stagea'),trustInputs:trust,nowNs:1700000100000000000n,witnessHex:codec.toHex(attestation)});
  fs.writeFileSync(path.join(root,'clock'),'1700000100000000000\n');fs.writeFileSync(path.join(root,'bundle.json'),JSON.stringify({...bundle,trustInputs:provision.trustJSON(trust)}));
  fs.writeFileSync(path.join(root,'native.json'),JSON.stringify({clock_file:path.join(root,'clock'),principals:[{network:trust.network,subject,revision_zero:trust.rev0T1,manifest_identity:bundle.manifestIdentity,relay_id:trust.relayId,relay_identity:subject,endpoint,binding_expiry_ns:String(trust.bindingExpiryNs),continuity_file:path.join(root,'native-continuity'),bundle_root:bundle.runDir,mode:'new'}]}));return;
 }
 const raw=JSON.parse(fs.readFileSync(path.join(root,'bundle.json'))),trust=provision.parseTrust(raw.trustInputs),bundle=provision.reopenBundle(raw,1700000100000000000n);
 const {startDirectoryRouteTransport}=load('packages/bot/demo/demo.ts');let browser,session,driver,browserScript,front,store,agent;
 try {
 if(process.env.DIRECTORY_ADMISSION_CHROMIUM){
  const file=path.join(repo,'packages/bot/demo/directory-trust/check-admission-browser.cjs'),Module=require('node:module');driver=new Module(file,module);driver.filename=file;driver.paths=Module._nodeModulePaths(path.dirname(file));const source=fs.readFileSync(file,'utf8');driver._compile(source.slice(0,source.lastIndexOf('main().catch(error => {'))+'module.exports={launch,stop,page};',file);driver=driver.exports;
  const {startFixture,checkNode}=load('packages/bot/demo/directory-trust/https-fixture.ts');const fixture=await startFixture(bundle,1700000100000000000n);
  try{await checkNode(bundle,1700000100000000000n);browser=await driver.launch(process.env.DIRECTORY_ADMISSION_CHROMIUM,path.join(root,'stagea-chrome'),bundle.tls.leafSpkiSha256);
   const build=await require(require.resolve('esbuild',{paths:[repo]})).build({stdin:{contents:`export {openBrowserDirectoryStore} from '@frank/directory-admission/browser'; export {createDirectoryClient} from './packages/cashweb/relay/directory-client.ts'; export {admissionAnchor,admissionContext,continuityJSON,parseContinuity} from './packages/bot/demo/directory-trust/browser-admission.ts';`,loader:'ts',resolveDir:repo},bundle:true,write:false,platform:'browser',format:'iife',globalName:'StageA',metafile:true,alias:{'@frank/codec':path.join(repo,'packages/frank-codec/src/index.ts'),'@frank/directory-admission/browser':path.join(repo,'packages/directory-admission/src/browser.ts')}});
   if(Object.keys(build.metafile.inputs).some(p=>/node_modules\/(level|leveldown)|src\/node\.ts/.test(p)))throw Error('browser dependency');browserScript=build.outputFiles[0].text;
  }catch(e){await driver.stop(browser);throw e;}finally{await fixture.stop();}
 }
 front=await startDirectoryRouteTransport({bundle,nowNs:1700000100000000000n,backendUrl:backend});
 // The front returns a static plaintext404 for the old proof page. This establishes the same controlled
 // origin without borrowing or weakening the probe page's deliberately evidence-only CSP.
 if(browser)session=await driver.page(browser,bundle,browserScript,path.join(root,'browser-continuity'));
 const {openNodeDirectoryStore}=load('packages/directory-admission/src/node.ts');const {admissionAnchor,admissionContext,continuityJSON,parseContinuity}=load('packages/bot/demo/directory-trust/browser-admission.ts');const installation={manifestIdentity:bundle.manifestIdentity,trustInputs:trust,witnessHex:bundle.witnessHex};
 const continuityFile=path.join(root,'client-continuity');store=await openNodeDirectoryStore({location:path.join(root,'client-db'),anchor:admissionAnchor(trust),mode:mode==='reopen'?{kind:'reopen',checkpoint:parseContinuity(fs.readFileSync(continuityFile,'utf8'),installation)}:{kind:'new'}});
 agent=new https.Agent({ca:bundle.tls.caPem,rejectUnauthorized:true,keepAlive:false,maxCachedSessions:0});
 const fetcher=(url,init)=>new Promise((resolve,reject)=>{const req=https.request(url,{agent,method:init.method,headers:init.headers,checkServerIdentity:(host,peer)=>{const e=tls.checkServerIdentity(host,peer);if(e)return e;const cert=new crypto.X509Certificate(peer.raw);if(provision.sha256(cert.raw)!==bundle.tls.leafSha256||provision.spki(cert)!==bundle.tls.leafSpkiSha256)return Error('pin');}},res=>{const iterator=res[Symbol.asyncIterator]();resolve({status:res.statusCode,url,headers:{get:n=>res.headers[n]??null},body:{getReader:()=>({read:()=>iterator.next(),cancel:async()=>{res.destroy();}})}});});req.on('error',reject);init.signal.addEventListener('abort',()=>req.destroy(Error('deadline')),{once:true});req.end(init.body);});
 const {createDirectoryClient}=load('packages/cashweb/relay/directory-client.ts');const client=createDirectoryClient({network:trust.network,subject:trust.subject,endpoint:trust.endpoint,store,context:()=>admissionContext(trust,1700000100000000000n),fetch:fetcher,saveCheckpoint:async cp=>{const data=continuityJSON(installation,cp);const fd=fs.openSync(continuityFile,'w',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}});
 const current=mode==='reopen'?await client.current():await client.put(await client.preparePut(codec.fromHex(bundle.witnessHex)));if(current.t1!==trust.rev0T1)throw Error('T1');const historical=await client.historical(current.t1);if(codec.toHex(historical.frame)!==bundle.witnessHex||historical.kind!=='historical')throw Error('bytes');
  if(browser){const external=mode==='reopen'?fs.readFileSync(path.join(root,'browser-continuity'),'utf8'):null;const result=await browser.cdp.evaluate(session,`await (async()=>{const trust=${JSON.stringify(provision.trustJSON(trust))};trust.bindingExpiryNs=BigInt(trust.bindingExpiryNs);const installation={manifestIdentity:${JSON.stringify(bundle.manifestIdentity)},trustInputs:trust,witnessHex:${JSON.stringify(bundle.witnessHex)}};const store=await StageA.openBrowserDirectoryStore({name:'stage-a-http',anchor:StageA.admissionAnchor(trust),mode:${external?`{kind:'reopen',checkpoint:StageA.parseContinuity(${JSON.stringify(external)},installation)}`:`{kind:'new'}`}});try{const api=StageA.createDirectoryClient({network:trust.network,subject:trust.subject,endpoint:trust.endpoint,store,context:()=>StageA.admissionContext(trust,1700000100000000000n),fetch:(url,init)=>fetch(url,init),saveCheckpoint:cp=>saveRecord(StageA.continuityJSON(installation,cp))});const head=await api.current();const old=await api.historical(head.t1);if(head.t1!==trust.rev0T1||old.kind!=='historical')throw Error('browser authority');return head.t1;}finally{await store.close();}})()`);if(result!==trust.rev0T1)throw Error('browser T1 '+JSON.stringify({result,expected:trust.rev0T1}));console.log('exact HTTPS Rust/Chromium '+mode+' accepted');}
  console.log('exact HTTPS Rust/Node '+mode+' accepted');}
 finally{await store?.close();agent?.destroy();await front?.stop();if(browser)await driver.stop(browser);}
}
main().catch(e=>{console.error(e);process.exitCode=1});
"#;

#[tokio::test]
async fn authenticated_https_rust_and_node_client_close_reopen_exact_bytes() {
    use tokio::process::Command;
    let root = tempfile::tempdir().unwrap();
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let script = root.path().join("stagea.cjs");
    std::fs::write(&script, NODE_STAGE_A).unwrap();
    let run = |mode: &str, backend: &str| {
        let mut command = Command::new("node");
        command
            .arg("--import")
            .arg(repo.join("node_modules/tsx/dist/loader.mjs"))
            .arg(&script)
            .arg(repo)
            .arg(root.path())
            .arg(mode)
            .arg(backend)
            .env("TSX_TSCONFIG_PATH", repo.join("packages/bot/tsconfig.json"));
        command
    };
    let prepared = run("prepare", "").output().await.unwrap();
    assert!(
        prepared.status.success(),
        "{}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    // The account in this proof names its own relay tuple; the relay is configured with the same.
    let native: Value =
        serde_json::from_slice(&std::fs::read(root.path().join("native.json")).unwrap()).unwrap();
    let principal = &native["principals"][0];
    let text = |key: &str| principal[key].as_str().unwrap().to_owned();
    let config = DirectoryConf {
        network: text("network"),
        relay_id: text("relay_id"),
        relay_identity: text("relay_identity"),
        endpoint: text("endpoint"),
        binding_expiry_ns: text("binding_expiry_ns"),
        ..relay_config()
    };
    let clock = TestClock::at(1700000100);
    for mode in ["new", "reopen"] {
        let registry = Arc::new(Registry::new(
            Db::open(root.path().join("db")).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        ));
        let (runtime, ready) =
            DirectoryRuntime::start_with_clock(registry, config.clone(), clock.clock()).unwrap();
        ready.await.unwrap().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = axum::Server::from_tcp(listener)
            .unwrap()
            .serve(router(Arc::new(runtime.clone())).into_make_service())
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            });
        let server = tokio::spawn(server);
        let checked = run(mode, &format!("http://{address}"))
            .output()
            .await
            .unwrap();
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
        drop(runtime);
        assert!(
            checked.status.success(),
            "{}",
            String::from_utf8_lossy(&checked.stderr)
        );
        let output = String::from_utf8_lossy(&checked.stdout);
        assert!(output.contains(&format!("exact HTTPS Rust/Node {mode} accepted")));
        if std::env::var_os("DIRECTORY_ADMISSION_CHROMIUM").is_some() {
            assert!(output.contains(&format!("exact HTTPS Rust/Chromium {mode} accepted")));
        }
    }
}

#[tokio::test]
async fn forwarded_for_is_ignored_unless_the_connection_is_from_a_listed_proxy() {
    let root = tempfile::tempdir().unwrap();
    let (registry, mut config, clock) = setup(root.path());
    config.enrollments_per_source_per_hour = 1;
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let accounts: Vec<Entry> = (80..83).map(|secret| entry(secret, |_| ())).collect();
    // No proxy is listed, so a different claimed client address each time changes nothing:
    // all three come from the one connecting address.
    let mut statuses = Vec::new();
    for (account, claimed) in accounts
        .iter()
        .zip(["203.0.113.1", "203.0.113.2", "203.0.113.3"])
    {
        statuses.push(
            request_from(
                routes.clone(),
                "PUT",
                &head(&account.subject),
                account.attestation.clone(),
                MEDIA,
                Some(claimed),
            )
            .await
            .0,
        );
    }
    assert_eq!(
        statuses,
        [
            StatusCode::OK,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}
