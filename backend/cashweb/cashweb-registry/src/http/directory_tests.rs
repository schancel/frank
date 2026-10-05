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
        "min_revision_interval_s": 0,
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
async fn conflicting_first_entry_and_a_second_renewal_of_the_same_revision_are_refused_first_wins()
{
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
    // Two devices renew the same revision. The first renewal accepted wins; the second is
    // refused and nothing about it is kept, so the account keeps working.
    let renew = vector("renew");
    assert_eq!(put(&routes, SUBJECT, renew.clone()).await.0, StatusCode::OK);
    for _ in 0..2 {
        assert_eq!(
            put(&routes, SUBJECT, vector("fork-of-renew")).await.0,
            StatusCode::CONFLICT
        );
        let current = get(&routes, &head(SUBJECT)).await;
        assert_eq!(current.0, StatusCode::OK);
        assert_eq!(current.2, renew);
    }
    assert_eq!(runtime.listed(NETWORK, SUBJECT).unwrap().1, 2);
    assert!(!runtime.listed(NETWORK, SUBJECT).unwrap().2);
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
    // The endpoint must be written exactly as a browser reports the origin.
    for endpoint in [
        "https://Relay.example.invalid",
        "https://relay.example.invalid:443",
        "https://relay.example.invalid/",
        "http://relay.example.invalid",
    ] {
        let mut config = relay_config();
        config.endpoint = endpoint.into();
        assert!(
            matches!(
                DirectoryRuntime::start(registry(root.path()), config),
                Err(RuntimeError::Trust)
            ),
            "{endpoint}"
        );
    }
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

#[tokio::test]
async fn new_revisions_are_paced_and_capped_per_account() {
    let root = tempfile::tempdir().unwrap();
    let (registry, mut config, clock) = setup(root.path());
    config.min_revision_interval_s = 3600;
    let runtime = start(registry, config.clone(), &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    assert_eq!(
        put(&routes, SUBJECT, vector("bootstrap")).await.0,
        StatusCode::OK
    );
    // A second revision straight away is too soon; re-sending the first is not a new revision.
    assert_eq!(
        put(&routes, SUBJECT, vector("renew")).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        put(&routes, SUBJECT, vector("bootstrap")).await.0,
        StatusCode::OK
    );
    assert_eq!(get(&routes, &head(SUBJECT)).await.2, vector("bootstrap"));
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
    drop(routes);
    drop(runtime);

    let other = tempfile::tempdir().unwrap();
    config.min_revision_interval_s = 0;
    config.max_revisions_per_subject = 2;
    let runtime = start(self::registry(other.path()), config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    for id in ["bootstrap", "renew"] {
        assert_eq!(put(&routes, SUBJECT, vector(id)).await.0, StatusCode::OK);
    }
    assert_eq!(
        put(&routes, SUBJECT, vector("rotate-stamp")).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(get(&routes, &head(SUBJECT)).await.2, vector("renew"));
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn lookups_of_a_maximum_length_chain_stay_well_inside_the_waiter_deadline() {
    use crate::directory_admission::{AccountRef, Anchor, Candidate, OpenMode, Timestamp};
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let length = config.max_revisions_per_subject;
    // One account at the revision cap, written the way the relay stores it.
    let mut chain: Vec<Entry> = Vec::new();
    for revision in 0..length {
        let previous = chain.last().map(|entry| entry.hash.to_vec());
        chain.push(entry(90, |fields| {
            for (key, value) in fields.iter_mut() {
                match *key {
                    2 => *value = CborValue::Int(revision as i128),
                    13 => {
                        *value = previous
                            .clone()
                            .map(CborValue::Bytes)
                            .unwrap_or(CborValue::Null)
                    }
                    _ => (),
                }
            }
        }));
    }
    let subject = hex::decode(&chain[0].subject).unwrap();
    let statements: Vec<Vec<u8>> = chain
        .iter()
        .map(|entry| {
            frank_cbor::verify_preview_directory_evidence(&entry.attestation, NETWORK)
                .unwrap()
                .statement_frame()
                .frame
                .clone()
        })
        .collect();
    {
        let directory = registry
            .directory_preview(
                Anchor {
                    network: NETWORK.into(),
                    subject: AccountRef {
                        key_type: 1,
                        key_bytes: subject.clone(),
                    },
                    revision_zero: chain[0].hash,
                },
                OpenMode::NewEnrollment,
            )
            .unwrap();
        let candidates: Vec<Candidate<'_>> = chain
            .iter()
            .zip(&statements)
            .map(|(entry, statement)| Candidate {
                statement,
                attestation: &entry.attestation,
            })
            .collect();
        let current = directory
            .advance_declared(
                &candidates,
                Some(Timestamp {
                    seconds: 1700000100,
                    nanoseconds: 0,
                }),
            )
            .unwrap();
        let address: [u8; 20] =
            crate::monad_stamp_stealth::recipient_address_from_public_key(&subject)
                .unwrap()
                .0;
        registry
            .directory_subjects()
            .unwrap()
            .put(
                NETWORK,
                &subject,
                Some(&address),
                &crate::store::directory_subjects::SubjectRow {
                    version: 1,
                    anchor: chain[0].hash,
                    checkpoint: current.status.checkpoint,
                    local: true,
                },
            )
            .unwrap();
    }
    let runtime = start(registry, config, &clock).await;
    let routes = router(Arc::new(runtime.clone()));
    let last = chain.last().unwrap();
    // The first lookup after a restart verifies the whole chain once.
    let started = std::time::Instant::now();
    let first = get(&routes, &head(&last.subject)).await;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(first.2, last.attestation);
    assert!(
        started.elapsed() < RESPONSE_BUDGET / 2,
        "first lookup took {:?}",
        started.elapsed()
    );
    // Every later lookup is answered from the verified head: no signature check, no write.
    let started = std::time::Instant::now();
    for _ in 0..200 {
        assert_eq!(
            get(&routes, &by_address(&last.address)).await.2,
            last.attestation
        );
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "200 cached lookups took {:?}",
        started.elapsed()
    );
    // The account is at its cap: one more revision is refused at once.
    let previous = last.hash.to_vec();
    let extra = entry(90, |fields| {
        for (key, value) in fields.iter_mut() {
            match *key {
                2 => *value = CborValue::Int(length as i128),
                13 => *value = CborValue::Bytes(previous.clone()),
                _ => (),
            }
        }
    });
    assert_eq!(
        put(&routes, &extra.subject, extra.attestation).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The expiry still ends the cached answer.
    clock.set(1800000000);
    assert_eq!(
        get(&routes, &head(&last.subject)).await.0,
        StatusCode::CONFLICT
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

/// A relay on a real socket, for tests with more than one relay.
struct Node {
    runtime: DirectoryRuntime,
    url: String,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    _root: tempfile::TempDir,
}
const RELAY_B_ID: &str = "101112131415161718191a1b1c1d1e1f";
const RELAY_B_ENDPOINT: &str = "https://relay-b.example.invalid";
fn relay_b_config() -> DirectoryConf {
    DirectoryConf {
        relay_id: RELAY_B_ID.into(),
        endpoint: RELAY_B_ENDPOINT.into(),
        ..relay_config()
    }
}
/// Make an entry say the account lives on relay B instead of the vectors' relay (A).
fn homed_on_b(fields: &mut Vec<(u64, CborValue)>) {
    for (key, value) in fields.iter_mut() {
        if *key == 4 {
            let CborValue::Array(relays) = value else {
                panic!("relays")
            };
            let CborValue::Map(relay) = &mut relays[0] else {
                panic!("relay")
            };
            for (key, value) in relay.iter_mut() {
                match *key {
                    0 => *value = CborValue::Bytes(hex::decode(RELAY_B_ID).unwrap()),
                    1 => *value = CborValue::Text(RELAY_B_ENDPOINT.into()),
                    _ => (),
                }
            }
        }
    }
}
/// Start relays that are each other's configured peers.
async fn network(configs: Vec<DirectoryConf>, clock: &TestClock) -> Vec<Node> {
    let listeners: Vec<std::net::TcpListener> = configs
        .iter()
        .map(|_| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            listener
        })
        .collect();
    let urls: Vec<String> = listeners
        .iter()
        .map(|listener| format!("http://{}", listener.local_addr().unwrap()))
        .collect();
    let mut nodes = Vec::new();
    for (index, (config, listener)) in configs.into_iter().zip(listeners).enumerate() {
        let root = tempfile::tempdir().unwrap();
        let runtime = start(registry(root.path()), config, clock).await;
        let peers = urls
            .iter()
            .enumerate()
            .filter(|(other, _)| *other != index)
            .map(|(_, url)| url.parse().unwrap())
            .collect();
        runtime.enable_federation(peers, true);
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let routes = router(Arc::new(runtime.clone()));
        let task = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(routes.into_make_service_with_connect_info::<std::net::SocketAddr>())
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        nodes.push(Node {
            runtime,
            url: urls[index].clone(),
            stop,
            task,
            _root: root,
        });
    }
    nodes
}
impl Node {
    async fn put(&self, entry: &Entry) -> u16 {
        reqwest::Client::new()
            .put(format!("{}{}", self.url, head(&entry.subject)))
            .header("content-type", MEDIA)
            .body(entry.attestation.clone())
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }
    async fn get(&self, path: &str) -> (u16, reqwest::header::HeaderMap, Vec<u8>) {
        let response = reqwest::get(format!("{}{path}", self.url)).await.unwrap();
        let (status, headers) = (response.status().as_u16(), response.headers().clone());
        (status, headers, response.bytes().await.unwrap().to_vec())
    }
    /// Publish without the public route's peer check, as if peers were unreachable then.
    async fn publish_unchecked(&self, entry: &Entry) {
        self.runtime
            .submit(
                self.runtime.reserve(NETWORK, &entry.subject).unwrap(),
                Operation::Put(entry.attestation.clone()),
            )
            .wait()
            .await
            .unwrap();
    }
    async fn sync(&self) {
        self.runtime
            .federation()
            .unwrap()
            .clone()
            .sync(&self.runtime)
            .await;
    }
    async fn stop(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        self.runtime.begin_shutdown();
        self.runtime.wait_stopped().await;
    }
}
fn revision(secret: u32, number: u64, previous: [u8; 32], extra: i128) -> Entry {
    entry(secret, |fields| {
        for (key, value) in fields.iter_mut() {
            match *key {
                2 => *value = CborValue::Int(number as i128),
                13 => *value = CborValue::Bytes(previous.to_vec()),
                // A different expiry makes a different signed statement of the same revision.
                6 => {
                    *value = cbor_map(vec![
                        (0, CborValue::Int(1700003600 - extra)),
                        (1, CborValue::Int(0)),
                    ])
                }
                _ => (),
            }
        }
    })
}

#[tokio::test]
async fn a_relay_learns_accounts_from_its_peer_with_their_whole_history() {
    let clock = TestClock::at(1700000100);
    let mut b_config = relay_b_config();
    b_config.max_replicated_subjects = 4;
    b_config.max_subjects = 1;
    let mut nodes = network(vec![relay_config(), b_config], &clock).await;
    let (b, a) = (nodes.pop().unwrap(), nodes.pop().unwrap());
    assert_eq!(
        serde_json::from_slice::<Value>(&a.get("/relay/v1/info").await.2).unwrap()["forwarding"],
        true
    );
    // An account on relay A with two revisions. Relay B has never heard of it.
    let first = entry(100, |_| ());
    let second = revision(100, 1, first.hash, 0);
    assert_eq!(a.put(&first).await, 200);
    assert_eq!(a.put(&second).await, 200);
    assert!(!b.runtime.is_published(NETWORK, &first.subject));
    // Asked for the address, relay B asks its peer before answering, and then holds the
    // account's whole chain, verified record by record: the old revision is there too.
    let found = b.get(&by_address(&first.address)).await;
    assert_eq!(found.0, 200);
    assert_eq!(found.2, second.attestation);
    assert_eq!(found.1["x-frank-directory-subject"], first.subject.as_str());
    let history = format!(
        "/directory/v1/{NETWORK}/{}/statements/{}",
        first.subject,
        hex::encode(first.hash)
    );
    let old = b.get(&history).await;
    assert_eq!(old.0, 200);
    assert_eq!(old.2, first.attestation);
    // An address nobody published is unknown on both.
    let nobody = by_address(&format!("0x{}", "22".repeat(20)));
    assert_eq!(a.get(&nobody).await.0, 404);
    assert_eq!(b.get(&nobody).await.0, 404);
    // A peer cannot make a relay take on an account: an entry naming relay A as home, for a
    // key relay A has never seen, is not accepted by relay A from relay B.
    let claimed = entry(112, |_| ());
    b.publish_unchecked(&claimed).await;
    // Accounts nobody asked about arrive by the periodic comparison, as does a new revision.
    let others: Vec<Entry> = (101..104).map(|secret| entry(secret, |_| ())).collect();
    for other in &others {
        assert_eq!(a.put(other).await, 200);
    }
    let third = revision(100, 2, second.hash, 0);
    assert_eq!(a.put(&third).await, 200);
    b.sync().await;
    assert_eq!(b.get(&head(&first.subject)).await.2, third.attestation);
    // Relay B's budget for copies is four accounts and two are used: one more is not copied.
    let copied = others
        .iter()
        .filter(|other| b.runtime.is_published(NETWORK, &other.subject))
        .count();
    assert_eq!(copied, 2);
    // Copies do not use up relay B's own sign-up budget of one account.
    let local = entry(110, homed_on_b);
    assert_eq!(b.put(&local).await, 200);
    assert_eq!(b.put(&entry(111, homed_on_b)).await, 429);
    a.sync().await;
    assert!(!a.runtime.is_published(NETWORK, &claimed.subject));
    // Relay A does copy relay B's own account.
    assert!(a.runtime.is_published(NETWORK, &local.subject));
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn an_account_restored_on_another_relay_adopts_its_existing_entry() {
    let clock = TestClock::at(1700000100);
    let mut nodes = network(vec![relay_config(), relay_b_config()], &clock).await;
    let (b, a) = (nodes.pop().unwrap(), nodes.pop().unwrap());
    let original = entry(120, |_| ());
    assert_eq!(a.put(&original).await, 200);
    // The same key, restored on a device configured for relay B, would sign a fresh first
    // entry. Relay B asks its peer first, finds the account, and refuses the second one.
    let fresh = revision(120, 0, [0; 32], 7);
    let fresh = entry(120, |fields| {
        homed_on_b(fields);
        for (key, value) in fields.iter_mut() {
            if *key == 6 {
                *value = cbor_map(vec![
                    (0, CborValue::Int(1700003000)),
                    (1, CborValue::Int(0)),
                ]);
            }
        }
        let _ = &fresh;
    });
    assert_ne!(fresh.hash, original.hash);
    assert_eq!(b.put(&fresh).await, 409);
    let adopted = b.get(&head(&original.subject)).await;
    assert_eq!(adopted.0, 200);
    assert_eq!(adopted.2, original.attestation);
    // Moving the account is the next revision of the same chain, published on relay B.
    let moved = entry(120, |fields| {
        homed_on_b(fields);
        for (key, value) in fields.iter_mut() {
            match *key {
                2 => *value = CborValue::Int(1),
                13 => *value = CborValue::Bytes(original.hash.to_vec()),
                _ => (),
            }
        }
    });
    assert_eq!(b.put(&moved).await, 200);
    a.sync().await;
    assert_eq!(a.get(&head(&original.subject)).await.2, moved.attestation);
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn conflicting_chains_on_two_relays_converge_on_one_without_quarantine() {
    let clock = TestClock::at(1700000100);
    let mut nodes = network(vec![relay_config(), relay_b_config()], &clock).await;
    let (b, a) = (nodes.pop().unwrap(), nodes.pop().unwrap());
    // Peers were unreachable when the same key published two different first entries.
    let on_a = entry(130, |_| ());
    let on_b = revision(130, 0, [0; 32], 9);
    let on_b = entry(130, |fields| {
        for (key, value) in fields.iter_mut() {
            if *key == 6 {
                *value = cbor_map(vec![
                    (0, CborValue::Int(1700003111)),
                    (1, CborValue::Int(0)),
                ]);
            }
        }
        let _ = &on_b;
    });
    a.publish_unchecked(&on_a).await;
    b.publish_unchecked(&on_b).await;
    // And two devices renewed another account on different relays at the same moment.
    let shared = entry(131, |_| ());
    a.publish_unchecked(&shared).await;
    b.sync().await;
    let renew_a = revision(131, 1, shared.hash, 1);
    let renew_b = revision(131, 1, shared.hash, 2);
    a.publish_unchecked(&renew_a).await;
    b.publish_unchecked(&renew_b).await;
    for _ in 0..2 {
        a.sync().await;
        b.sync().await;
    }
    // Both relays hold the same chain for each account: the one whose first differing record
    // has the lower hash. Both serve it as current; nothing is quarantined.
    for (subject, candidates) in [
        (&on_a.subject, [&on_a, &on_b]),
        (&shared.subject, [&renew_a, &renew_b]),
    ] {
        let winner = candidates.iter().min_by_key(|entry| entry.hash).unwrap();
        for node in [&a, &b] {
            let current = node.get(&head(subject)).await;
            assert_eq!(current.0, 200);
            assert_eq!(current.2, winner.attestation);
            assert!(!node.runtime.listed(NETWORK, subject).unwrap().2);
        }
    }
    a.stop().await;
    b.stop().await;
}

/// A first entry of the account of `secret` that expires at `expiry` (Unix seconds).
fn first_expiring(secret: u32, expiry: i128) -> Entry {
    entry(secret, |fields| {
        for (key, value) in fields.iter_mut() {
            if *key == 6 {
                *value = cbor_map(vec![(0, CborValue::Int(expiry)), (1, CborValue::Int(0))]);
            }
        }
    })
}

#[tokio::test]
async fn conflicting_chains_prefer_unexpired_then_the_higher_revision() {
    let clock = TestClock::at(1700000100);
    let mut nodes = network(vec![relay_config(), relay_b_config()], &clock).await;
    let (b, a) = (nodes.pop().unwrap(), nodes.pop().unwrap());
    // A renewed chain beats a shorter one whatever the hashes: two devices renewed the same
    // account on different relays, and one of them renewed again.
    let shared = entry(132, |_| ());
    a.publish_unchecked(&shared).await;
    b.sync().await;
    let (x, y) = (revision(132, 1, shared.hash, 1), revision(132, 1, shared.hash, 2));
    // The longer chain is the one whose first differing record has the HIGHER hash, so the old
    // lowest-hash rule would have picked the other.
    let (long, short) = if x.hash > y.hash { (x, y) } else { (y, x) };
    let longer = revision(132, 2, long.hash, 0);
    a.publish_unchecked(&long).await;
    a.publish_unchecked(&longer).await;
    b.publish_unchecked(&short).await;
    // An unexpired chain beats an expired one, even a longer one with a lower hash.
    let stale = first_expiring(133, 1700000200);
    let stale_next = revision(133, 1, stale.hash, 3400);
    let live = first_expiring(133, 1700003000);
    a.publish_unchecked(&stale).await;
    a.publish_unchecked(&stale_next).await;
    b.publish_unchecked(&live).await;
    clock.set(1700000300);
    for _ in 0..2 {
        a.sync().await;
        b.sync().await;
    }
    for node in [&a, &b] {
        let current = node.get(&head(&shared.subject)).await;
        assert_eq!(current.0, 200);
        assert_eq!(current.2, longer.attestation);
        let current = node.get(&head(&live.subject)).await;
        assert_eq!(current.0, 200);
        assert_eq!(current.2, live.attestation);
    }
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_replacement_that_fails_or_stops_half_way_never_loses_the_account() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry.clone(), config.clone(), &clock).await;
    // The account lives on this relay: a peer could never make this relay take it on again.
    let held = entry(140, |_| ());
    let put = |entry: &Entry| {
        let runtime = runtime.clone();
        let bytes = entry.attestation.clone();
        let subject = entry.subject.clone();
        async move {
            runtime
                .submit(runtime.reserve(NETWORK, &subject).unwrap(), Operation::Put(bytes))
                .wait()
                .await
        }
    };
    put(&held).await.unwrap();
    // A conflicting chain that wins (it is longer) arrives from a peer.
    let other = first_expiring(140, 1700003001);
    let other_next = revision(140, 1, other.hash, 1);
    let chain = vec![other.attestation.clone(), other_next.attestation.clone()];
    let routes = router(Arc::new(runtime.clone()));
    // The new chain is refused while being enrolled: the old one is enrolled again.
    runtime.set_replace_fault(REPLACE_FAULT_REFUSE);
    runtime
        .replicate(NETWORK, &held.subject, chain.clone())
        .await
        .unwrap();
    assert_eq!(get(&routes, &head(&held.subject)).await.2, held.attestation);
    // The process stops right after the old chain was cleared.
    runtime.set_replace_fault(REPLACE_FAULT_STOP);
    assert!(runtime
        .replicate(NETWORK, &held.subject, chain.clone())
        .await
        .is_err());
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
    drop(routes);
    drop(runtime);
    let released = Arc::downgrade(&registry);
    drop(registry);
    tokio::time::timeout(Duration::from_secs(5), async {
        while released.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // On the next start the swap is finished before anything is served.
    let reopened = start(self::registry(root.path()), config, &clock).await;
    let routes = router(Arc::new(reopened.clone()));
    let current = get(&routes, &head(&held.subject)).await;
    assert_eq!(current.0, StatusCode::OK);
    assert_eq!(current.2, other_next.attestation);
    let found = get(&routes, &by_address(&held.address)).await;
    assert_eq!(found.2, other_next.attestation);
    reopened.begin_shutdown();
    reopened.wait_stopped().await;
}

/// A stand-in for relay B: says who it is, answers message PUTs from a script, and answers
/// directory reads with a chosen status.
#[derive(Default)]
struct ScriptedPeer {
    answers: std::sync::Mutex<std::collections::VecDeque<(u16, String, u64)>>,
    puts: std::sync::atomic::AtomicUsize,
    directory_status: std::sync::atomic::AtomicU16,
}
async fn scripted_peer(peer: Arc<ScriptedPeer>) -> String {
    use std::sync::atomic::Ordering::SeqCst;
    let info = || async {
        axum::Json(serde_json::json!({"endpoint": RELAY_B_ENDPOINT, "relayId": RELAY_B_ID}))
    };
    let messages = {
        let peer = peer.clone();
        move || {
            let peer = peer.clone();
            async move {
                peer.puts.fetch_add(1, SeqCst);
                let answer = peer.answers.lock().unwrap().pop_front();
                let (status, body, delay) = answer.unwrap_or((503, String::new(), 0));
                tokio::time::sleep(Duration::from_millis(delay)).await;
                (StatusCode::from_u16(status).unwrap(), body)
            }
        }
    };
    let directory = move || {
        let peer = peer.clone();
        async move { StatusCode::from_u16(peer.directory_status.load(SeqCst)).unwrap() }
    };
    let app = axum::Router::new()
        .route("/relay/v1/info", axum::routing::get(info))
        .route("/message/monad/cbor", axum::routing::put(messages))
        .route("/directory/v1/:network/:subject/:leaf", axum::routing::get(directory));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::Server::from_tcp(listener)
            .unwrap()
            .serve(app.into_make_service())
            .await
            .unwrap();
    });
    url
}
fn waiting_forward(recipient: &str, sender: &str) -> crate::store::directory_subjects::ForwardRow {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    crate::store::directory_subjects::ForwardRow {
        recipient: recipient.into(),
        content_type: "multipart/form-data; boundary=x".into(),
        network: NETWORK.into(),
        created_ms: now,
        attempts: 0,
        next_ms: 0,
        done: false,
        status: 0,
        response: String::new(),
        echo: serde_json::json!({"echo": 1}),
        sender: sender.into(),
        pinned: None,
    }
}
fn answer(result: Option<crate::directory_federation::Forwarded>) -> (u16, String) {
    match result {
        Some(crate::directory_federation::Forwarded::Answer(status, body)) => (status, body),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_forward_ends_only_on_the_recipient_relays_final_answer() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry.clone(), config, &clock).await;
    let peer = Arc::new(ScriptedPeer::default());
    runtime.enable_federation(vec![scripted_peer(peer.clone()).await.parse().unwrap()], true);
    let federation = runtime.federation().unwrap().clone();
    // A recipient that lives on relay B, and one that lives here.
    let remote = entry(150, homed_on_b);
    let local = entry(151, |_| ());
    for account in [&remote, &local] {
        runtime
            .submit(
                runtime.reserve(NETWORK, &account.subject).unwrap(),
                Operation::Put(account.attestation.clone()),
            )
            .wait()
            .await
            .unwrap();
    }
    let rows = || registry.directory_subjects().unwrap();
    let write = |identity: [u8; 32], row: &crate::store::directory_subjects::ForwardRow| {
        rows().put_forward(&identity, row, Some(b"exact bytes")).unwrap();
    };
    let retained = serde_json::json!({"version":1,"phase":"retained","identity":{"echo":1}})
        .to_string();
    use std::sync::atomic::Ordering::SeqCst;

    // 1a/1c: relay B took the message (202). Afterwards the forward is more than a day old, but
    // this relay no longer decides: B is asked again, and its transient answers keep the
    // forward waiting.
    write([1; 32], &waiting_forward(&remote.subject, "s1"));
    peer.answers.lock().unwrap().push_back((202, "held by b".into(), 0));
    assert_eq!(
        answer(federation.forward(&runtime, &[1; 32], false).await),
        (202, "held by b".into())
    );
    let mut row = rows().forward(&[1; 32]).unwrap().unwrap();
    assert_eq!(
        row.pinned,
        Some((RELAY_B_ENDPOINT.to_owned(), RELAY_B_ID.to_owned()))
    );
    row.created_ms = 0;
    rows().put_forward(&[1; 32], &row, None).unwrap();
    peer.answers.lock().unwrap().push_back((503, String::new(), 0));
    assert_eq!(
        answer(federation.forward(&runtime, &[1; 32], false).await),
        (202, retained.clone())
    );
    assert!(!rows().forward(&[1; 32]).unwrap().unwrap().done);
    peer.answers.lock().unwrap().push_back((200, "delivered by b".into(), 0));
    assert_eq!(
        answer(federation.forward(&runtime, &[1; 32], false).await),
        (200, "delivered by b".into())
    );
    assert!(rows().forward(&[1; 32]).unwrap().unwrap().done);

    // 1e: a 409 from relay B is not final; the same bytes are tried again.
    write([2; 32], &waiting_forward(&remote.subject, "s1"));
    peer.answers
        .lock()
        .unwrap()
        .push_back((409, "recovery_obligation_is_active".into(), 0));
    assert_eq!(
        answer(federation.forward(&runtime, &[2; 32], false).await),
        (202, retained.clone())
    );
    let row = rows().forward(&[2; 32]).unwrap().unwrap();
    assert!(!row.done && row.pinned.is_none());

    // 1b: two attempts at once. The second does not send again and does not overwrite what
    // the first records; the finished answer is repeated, never turned into "undeliverable"
    // although the bytes are gone.
    write([3; 32], &waiting_forward(&remote.subject, "s1"));
    let before = peer.puts.load(SeqCst);
    peer.answers
        .lock()
        .unwrap()
        .push_back((200, "delivered once".into(), 500));
    let slow = tokio::spawn({
        let (federation, runtime) = (federation.clone(), runtime.clone());
        async move { answer(federation.forward(&runtime, &[3; 32], false).await) }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        answer(federation.forward(&runtime, &[3; 32], true).await),
        (202, retained.clone())
    );
    assert_eq!(slow.await.unwrap(), (200, "delivered once".into()));
    for _ in 0..2 {
        assert_eq!(
            answer(federation.forward(&runtime, &[3; 32], false).await),
            (200, "delivered once".into())
        );
    }
    assert_eq!(peer.puts.load(SeqCst), before + 1);
    assert!(rows().forward_body(&[3; 32]).unwrap().is_none());

    // 1d: a recipient that lives here now, and the message was never handed on: it is
    // delivered here instead (the forward is gone), never left waiting.
    write([4; 32], &waiting_forward(&local.subject, "s1"));
    assert!(matches!(
        federation.forward(&runtime, &[4; 32], true).await,
        Some(crate::directory_federation::Forwarded::Local)
    ));
    assert!(rows().forward(&[4; 32]).unwrap().is_none());

    // 4a: one sender cannot fill the queue; another sender still gets in.
    let body = b"bytes";
    let mut stored = 0;
    for n in 0..crate::directory_federation::MAX_PENDING_PER_SENDER as u8 + 5 {
        let identity = [100 + n; 32];
        match federation
            .admit(&runtime, &identity, &waiting_forward(&remote.subject, "greedy"), body)
            .unwrap()
        {
            crate::directory_federation::Admission::Stored => stored += 1,
            crate::directory_federation::Admission::Full => break,
            crate::directory_federation::Admission::Exists => panic!("exists"),
        }
    }
    assert_eq!(stored, crate::directory_federation::MAX_PENDING_PER_SENDER);
    assert_eq!(
        federation
            .admit(&runtime, &[99; 32], &waiting_forward(&remote.subject, "other"), body)
            .unwrap(),
        crate::directory_federation::Admission::Stored
    );
    assert_eq!(
        federation
            .admit(&runtime, &[99; 32], &waiting_forward(&remote.subject, "other"), body)
            .unwrap(),
        crate::directory_federation::Admission::Exists
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn a_peer_that_cannot_be_asked_is_not_an_unknown_account() {
    use crate::directory_federation::Learned;
    use std::sync::atomic::Ordering::SeqCst;
    let root = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(root.path());
    let runtime = start(registry, config, &clock).await;
    let peer = Arc::new(ScriptedPeer::default());
    runtime.enable_federation(vec![scripted_peer(peer.clone()).await.parse().unwrap()], true);
    let federation = runtime.federation().unwrap().clone();
    let subject = entry(160, |_| ()).subject;
    // The peer is busy: nothing is known, and nothing is remembered as unknown.
    peer.directory_status.store(503, SeqCst);
    assert_eq!(
        federation.learn(&runtime, NETWORK, &subject).await,
        Learned::Unavailable
    );
    // It answers that it does not have the key: that is final (and remembered briefly).
    peer.directory_status.store(404, SeqCst);
    assert_eq!(
        federation.learn(&runtime, NETWORK, &subject).await,
        Learned::Unknown
    );
    peer.directory_status.store(503, SeqCst);
    assert_eq!(
        federation.learn(&runtime, NETWORK, &subject).await,
        Learned::Unknown
    );
    // Addresses alike: a busy peer makes a lookup a retryable 503, never a 404.
    let routes = router(Arc::new(runtime.clone()));
    let address = format!("0x{}", "33".repeat(20));
    assert_eq!(
        get(&routes, &by_address(&address)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    peer.directory_status.store(404, SeqCst);
    assert_eq!(get(&routes, &by_address(&address)).await.0, StatusCode::NOT_FOUND);
    // A peer that is not there at all is not an answer either.
    let gone = tempfile::tempdir().unwrap();
    let (registry, config, clock) = setup(gone.path());
    let lonely = start(registry, config, &clock).await;
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    lonely.enable_federation(vec![url.parse().unwrap()], true);
    assert_eq!(
        lonely
            .federation()
            .unwrap()
            .clone()
            .learn(&lonely, NETWORK, &subject)
            .await,
        Learned::Unavailable
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
    lonely.begin_shutdown();
    lonely.wait_stopped().await;
}
