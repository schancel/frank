use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use serde_json::Value;
use tower::ServiceExt;

use crate::{
    directory_runtime::DirectoryRuntime,
    http::directory::tests::{entry, setup, Entry},
    store::directory_usernames::{claim_text, tests::signed_claim},
};

const NETWORK: &str = "monad-testnet";

/// A relay with the directory and username routes, as the server mounts them.
async fn relay(root: &std::path::Path) -> (DirectoryRuntime, Router) {
    relay_reserving(root, &[]).await
}

/// As [`relay`], with `reserved_usernames` set to the given (name, key hex) pairs.
async fn relay_reserving(
    root: &std::path::Path,
    reserved: &[(&str, &str)],
) -> (DirectoryRuntime, Router) {
    let (registry, mut config, clock) = setup(root);
    config.reserved_usernames = reserved
        .iter()
        .map(|(name, key)| (name.to_string(), key.to_string()))
        .collect();
    let (runtime, ready) =
        DirectoryRuntime::start_with_clock(registry, config, clock.clock()).unwrap();
    ready.await.unwrap().unwrap();
    let shared = Arc::new(runtime.clone());
    let routes = super::router(Arc::clone(&shared)).merge(crate::http::directory::router(shared));
    (runtime, routes)
}

async fn send(routes: &Router, method: &str, path: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let response = routes
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_LENGTH, body.len())
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The account whose secret scalar is `secret`, with its directory entry published.
async fn published(routes: &Router, secret: u32) -> Entry {
    let account = entry(secret, |_| ());
    let response = routes
        .clone()
        .oneshot(
            Request::put(format!("/directory/v1/{NETWORK}/{}/head", account.subject))
                .header(header::CONTENT_TYPE, "application/vnd.frank.cbor")
                .body(Body::from(account.attestation.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    account
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// A claim for `name` signed by the account whose secret scalar is `secret`.
fn claim(secret: u32, name: &str, issued_ms: u64) -> Vec<u8> {
    let mut key = [0; 32];
    key[28..].copy_from_slice(&secret.to_be_bytes());
    signed_claim(key, &claim_text(NETWORK, name, issued_ms))
}

async fn put(routes: &Router, name: &str, body: Vec<u8>) -> (StatusCode, Value) {
    send(routes, "PUT", &format!("/directory/user/{name}"), body).await
}

async fn get(routes: &Router, path: &str) -> (StatusCode, Value) {
    send(routes, "GET", path, vec![]).await
}

fn names(body: &Value) -> Vec<&str> {
    body["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|user| user["username"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn a_name_is_claimed_once_looked_up_and_found_by_prefix() {
    let root = tempfile::tempdir().unwrap();
    let (runtime, routes) = relay(root.path()).await;
    let alice = published(&routes, 42).await;
    let bob = published(&routes, 43).await;
    let t = now_ms();

    assert_eq!(
        get(&routes, "/directory/user/alice").await.0,
        StatusCode::NOT_FOUND
    );

    // Claimed through a mixed-case path: the relay normalises it.
    let (status, body) = put(&routes, "Alice", claim(42, "alice", t)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["username"], "alice");
    assert_eq!(body["address"], alice.address.to_lowercase());
    assert_eq!(body["account_address"], alice.address.to_lowercase());
    assert_eq!(body["subject"], alice.subject);
    assert_eq!(body["status"], "active");

    // Another key cannot take it.
    let (status, body) = put(&routes, "alice", claim(43, "alice", t + 1)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "taken");

    // The holder claiming again changes nothing.
    let (status, again) = put(&routes, "alice", claim(42, "alice", t + 2)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["issued_ms"], t);

    // Lookup, with `@` and upper case accepted, returns the holder and the signed claim.
    let (status, found) = get(&routes, "/directory/user/@ALICE").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found["address"], alice.address.to_lowercase());
    assert_eq!(found["subject"], alice.subject);
    assert_eq!(
        found["claim"],
        hex::encode(claim(42, "alice", t)),
        "the stored record is the first signed claim"
    );
    // The address it resolves to has a directory entry here, so it can be messaged.
    let entry = routes
        .clone()
        .oneshot(
            Request::get(format!(
                "/directory/v1/{NETWORK}/address/{}",
                found["address"].as_str().unwrap()
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(entry.status(), StatusCode::OK);

    assert_eq!(
        put(&routes, "bobby", claim(43, "bobby", t)).await.0,
        StatusCode::OK
    );
    let (status, body) = get(&routes, "/directory/users?prefix=al").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(names(&body), ["alice"]);
    assert_eq!(body["users"][0]["address"], alice.address.to_lowercase());
    let (_, body) = get(&routes, "/directory/users?prefix=%40B&limit=5").await;
    assert_eq!(names(&body), ["bobby"]);
    let (_, body) = get(&routes, "/directory/users?prefix=zz").await;
    assert_eq!(names(&body), Vec::<&str>::new());

    // Names of given addresses; an address with no name is simply absent.
    let (status, body) = get(
        &routes,
        &format!(
            "/directory/users?addresses={},0x{},{}",
            bob.address,
            "11".repeat(20),
            alice.address
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(names(&body), ["bobby", "alice"]);

    for bad in [
        "/directory/users",
        "/directory/users?prefix=a&addresses=0x00",
        "/directory/users?prefix=a&limit=0",
        "/directory/users?prefix=a&limit=101",
        "/directory/users?addresses=nope",
        "/directory/users?other=1",
    ] {
        assert_eq!(get(&routes, bad).await.0, StatusCode::BAD_REQUEST, "{bad}");
    }
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn a_holder_can_change_its_name_and_the_old_one_is_released() {
    let root = tempfile::tempdir().unwrap();
    let (runtime, routes) = relay(root.path()).await;
    let alice = published(&routes, 42).await;
    published(&routes, 43).await;
    let t = now_ms();
    assert_eq!(
        put(&routes, "alice", claim(42, "alice", t)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        put(&routes, "alice2", claim(42, "alice2", t + 1)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        get(&routes, "/directory/user/alice").await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&routes, "/directory/user/alice2").await.1["address"],
        alice.address.to_lowercase()
    );
    // Replaying the old claim does not move the account back.
    let (status, body) = put(&routes, "alice", claim(42, "alice", t)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "stale-claim");
    // The released name is free for another key.
    assert_eq!(
        put(&routes, "alice", claim(43, "alice", t + 2)).await.0,
        StatusCode::OK
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn bad_claims_are_refused_and_claim_nothing() {
    let root = tempfile::tempdir().unwrap();
    let (runtime, routes) = relay(root.path()).await;
    let alice = published(&routes, 42).await;
    let t = now_ms();

    // Signed by key 43 while naming key 42 as the signer.
    let mut forged = <cashweb_payload::proto::SignedPayload as prost::Message>::decode(
        claim(43, "alice", t).as_slice(),
    )
    .unwrap();
    forged.pubkey = hex::decode(&alice.subject).unwrap();
    let (status, body) = put(&routes, "alice", prost::Message::encode_to_vec(&forged)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid-claim");

    // A key with no directory entry here cannot hold a name: it could not be messaged.
    let (status, body) = put(&routes, "ghost", claim(77, "ghost", t)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "not-published");

    let invalid = |status: StatusCode, body: &Value, code: &str| {
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"], code);
    };
    // A valid claim sent to another name's path, an invalid name, another network, the far
    // future, no body, junk and an oversized body.
    let (status, body) = put(&routes, "carol", claim(42, "alice", t)).await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = put(&routes, "al", claim(42, "al", t)).await;
    invalid(status, &body, "invalid-username");
    let (status, body) = put(&routes, "al.ice", claim(42, "alice", t)).await;
    invalid(status, &body, "invalid-username");
    let mut key = [0; 32];
    key[31] = 42;
    let (status, body) = put(
        &routes,
        "alice",
        signed_claim(key, &claim_text("monad-mainnet", "alice", t)),
    )
    .await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = put(&routes, "alice", claim(42, "alice", t + 3_600_000)).await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = put(&routes, "alice", vec![]).await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = put(&routes, "alice", vec![7; 64]).await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = put(&routes, "alice", vec![7; 2048]).await;
    invalid(status, &body, "invalid-claim");
    let (status, body) = get(&routes, "/directory/user/a").await;
    invalid(status, &body, "invalid-username");

    assert_eq!(
        get(&routes, "/directory/user/alice").await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        names(&get(&routes, "/directory/users?prefix=").await.1),
        Vec::<&str>::new()
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn a_reserved_name_goes_only_to_the_key_it_is_reserved_for() {
    let root = tempfile::tempdir().unwrap();
    let bot = entry(42, |_| ());
    // Reserved under a spelling the relay normalises.
    let (runtime, routes) = relay_reserving(root.path(), &[("@Qwen", &bot.subject)]).await;
    published(&routes, 42).await;
    published(&routes, 43).await;
    let t = now_ms();

    // Before the bot has ever started, a squatter is told the name is taken.
    let (status, body) = put(&routes, "qwen", claim(43, "qwen", t)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "taken");
    assert_eq!(
        get(&routes, "/directory/user/qwen").await.0,
        StatusCode::NOT_FOUND
    );
    // Names that are not reserved are unaffected.
    assert_eq!(
        put(&routes, "qwen2", claim(43, "qwen2", t)).await.0,
        StatusCode::OK
    );

    // The reserved key claims it.
    let (status, body) = put(&routes, "QWEN", claim(42, "qwen", t)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["subject"], bot.subject);
    assert_eq!(
        get(&routes, "/directory/user/qwen").await.1["address"],
        bot.address.to_lowercase()
    );
    assert_eq!(
        put(&routes, "qwen", claim(43, "qwen", t + 5)).await.1["error"],
        "taken"
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn reserving_a_name_someone_already_took_hides_it_and_gives_it_to_the_reserved_key() {
    let root = tempfile::tempdir().unwrap();
    let bot = entry(42, |_| ());
    let squatter = entry(43, |_| ());
    let t = now_ms();
    // First run: nothing reserved, the squatter takes the name.
    {
        let (runtime, routes) = relay(root.path()).await;
        published(&routes, 42).await;
        published(&routes, 43).await;
        assert_eq!(
            put(&routes, "faucet", claim(43, "faucet", t)).await.0,
            StatusCode::OK
        );
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
    }
    // The operator reserves it and restarts on the same database.
    let (runtime, routes) = relay_reserving(root.path(), &[("faucet", &bot.subject)]).await;
    assert_eq!(
        get(&routes, "/directory/user/faucet").await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        names(&get(&routes, "/directory/users?prefix=fau").await.1),
        Vec::<&str>::new()
    );
    assert_eq!(
        names(
            &get(
                &routes,
                &format!("/directory/users?addresses={}", squatter.address)
            )
            .await
            .1
        ),
        Vec::<&str>::new()
    );
    assert_eq!(
        put(&routes, "faucet", claim(42, "faucet", t + 1)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        get(&routes, "/directory/user/faucet").await.1["subject"],
        bot.subject
    );
    // The squatter holds nothing now and can claim another name.
    assert_eq!(
        names(
            &get(
                &routes,
                &format!("/directory/users?addresses={}", squatter.address)
            )
            .await
            .1
        ),
        Vec::<&str>::new()
    );
    assert_eq!(
        put(&routes, "other", claim(43, "other", t + 2)).await.0,
        StatusCode::OK
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

#[tokio::test]
async fn a_bad_reserved_names_table_stops_the_relay_from_starting() {
    let key = entry(42, |_| ()).subject;
    for reserved in [
        vec![("ab", key.as_str())],
        vec![("qwen", "nothex")],
        vec![("qwen", "04aa")],
        vec![("Qwen", key.as_str()), ("qwen", key.as_str())],
    ] {
        let root = tempfile::tempdir().unwrap();
        let (registry, mut config, clock) = setup(root.path());
        config.reserved_usernames = reserved
            .iter()
            .map(|(name, key)| (name.to_string(), key.to_string()))
            .collect();
        assert!(
            DirectoryRuntime::start_with_clock(registry, config, clock.clock()).is_err(),
            "{reserved:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_keys_racing_for_one_name_have_exactly_one_winner() {
    let root = tempfile::tempdir().unwrap();
    let (runtime, routes) = relay(root.path()).await;
    let keys: Vec<u32> = (50..58).collect();
    for key in &keys {
        published(&routes, *key).await;
    }
    let t = now_ms();
    for round in 0..5 {
        let name = format!("race{round}");
        let attempts = keys.iter().map(|key| {
            let body = claim(*key, &name, t);
            let request = Request::put(format!("/directory/user/{name}"))
                .header(header::CONTENT_LENGTH, body.len())
                .body(Body::from(body))
                .unwrap();
            let service = routes.clone();
            tokio::spawn(async move {
                let response = service.oneshot(request).await.unwrap();
                let status = response.status();
                let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
                (
                    status,
                    serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
                )
            })
        });
        let mut won = 0;
        for attempt in attempts.collect::<Vec<_>>() {
            let (status, body) = attempt.await.unwrap();
            match status {
                StatusCode::OK => won += 1,
                StatusCode::CONFLICT => assert!(
                    body["error"] == "taken" || body["error"] == "stale-claim",
                    "{body}"
                ),
                other => panic!("unexpected {other}: {body}"),
            }
        }
        assert_eq!(won, 1, "round {round}");
    }
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}
