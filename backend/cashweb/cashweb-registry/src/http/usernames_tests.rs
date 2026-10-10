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
    let (registry, config, clock) = setup(root);
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
