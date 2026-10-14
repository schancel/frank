//! Opt-in real Core NATS proof. No container lifecycle or relay deployment changes.
//! Set `FRANK_GROUP_TEST_NATS_URL` to an existing disposable NATS endpoint, then run:
//! `cargo test -p cashweb-registry real_nats_group_replica_wakeup_and_durable_reconnect --lib -- --ignored --nocapture`
use super::*;
use crate::events::{CoreNatsEventBus, RelayEventBus};
use crate::store::groups::derive_group_id;
use futures::{SinkExt, StreamExt};
use secp256k1_abc::{PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

async fn replica(
    store: GroupStore,
    bus: Arc<dyn RelayEventBus>,
) -> (String, tokio::task::JoinHandle<()>) {
    // Same production handlers as router_with_store, with distinct configured Core NATS clients.
    let router = Router::new()
        .route(
            "/groups/:group_id/live",
            routing::get(live::handle_live_store),
        )
        .route(
            "/groups/:group_id/epochs",
            routing::put(handle_put_group_epoch_store).get(handle_get_group_epoch_store),
        )
        .route(
            "/groups/:group_id/messages",
            routing::put(handle_put_group_message_store).get(handle_get_group_messages_store),
        )
        .layer(Extension(store))
        .layer(Extension(bus));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::Server::from_tcp(listener)
            .unwrap()
            .serve(router.into_make_service())
            .await
            .unwrap();
    });
    (origin, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Requires an existing real Core NATS server via FRANK_GROUP_TEST_NATS_URL"]
async fn real_nats_group_replica_wakeup_and_durable_reconnect() {
    let nats_url = std::env::var("FRANK_GROUP_TEST_NATS_URL")
        .expect("set FRANK_GROUP_TEST_NATS_URL to an existing disposable NATS server");
    let publisher = Arc::new(CoreNatsEventBus::connect(&nats_url).await.unwrap());
    let subscriber = Arc::new(CoreNatsEventBus::connect(&nats_url).await.unwrap());
    // Synthetic shared KV authority models two replicas of the same relay, not two independent journals.
    let store = GroupStore::new_in_memory(cashweb_config::GroupAppendPolicy {
        per_message_price_credits: 0,
    });
    let (producer, producer_task) = replica(store.clone(), publisher.clone()).await;
    let (consumer, consumer_task) = replica(store, subscriber.clone()).await;
    let root = SecretKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
    let root_pub = PublicKey::from_secret_key(&Secp256k1::new(), &root).serialize();
    let group_id = hex::encode(derive_group_id(&root_pub));
    let write = SecretKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
    let write_pub = PublicKey::from_secret_key(&Secp256k1::new(), &write).serialize();
    let token = rand::random::<[u8; 32]>();
    let token_hex = hex::encode(token);
    let epoch = tests::signed_epoch(
        &root,
        GroupEpochFrame {
            group_id: group_id.clone(),
            group_pubkey: hex::encode(root_pub),
            epoch: 0,
            prev_epoch_hash: "00".repeat(32),
            write_pubkey: hex::encode(write_pub),
            read_token_hash: hex::encode(Sha256::digest(token)),
            encrypted_epoch_descriptor: hex::encode(b"synthetic NATS-only fixture"),
            admin_sig: String::new(),
            epoch_hash: String::new(),
        },
    );
    let http = reqwest::Client::new();
    http.put(format!("{producer}/groups/{group_id}/epochs"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&epoch).unwrap())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let ws_url = format!(
        "{}/groups/{group_id}/live",
        consumer.replace("http://", "ws://")
    );
    let auth = serde_json::json!({"epoch": 0, "read_token": token_hex}).to_string();
    let (mut socket, _) = connect_async(&ws_url).await.unwrap();
    socket.send(Message::Text(auth.clone())).await.unwrap();
    let initial = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(initial.into_text().unwrap(), "{\"type\":\"group-wakeup\"}");
    subscriber.client().flush().await.unwrap();
    // Neither direct notification subjects nor other groups may wake this subscription.
    publisher
        .publish_message_arrival(&group_id, &[1; 32])
        .await
        .unwrap();
    publisher
        .publish_group_wakeup(&hex::encode(rand::random::<[u8; 32]>()))
        .await
        .unwrap();
    publisher.client().flush().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(350), socket.next())
            .await
            .is_err()
    );
    let seal = |nonce: u8| {
        let mut message = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([nonce; 24]),
            ciphertext: hex::encode([nonce; 32]),
            write_sig: String::new(),
        };
        message.write_sig = tests::sign_digest(&write, &message.signing_digest().unwrap());
        message
    };
    let append = |message: GroupMessageEnvelope| {
        let url = format!("{producer}/groups/{group_id}/messages");
        let http = http.clone();
        async move {
            let bytes = http
                .put(url)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&message).unwrap())
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .bytes()
                .await
                .unwrap();
            serde_json::from_slice::<StoredGroupMessage>(&bytes).unwrap()
        }
    };
    let first = append(seal(1)).await;
    publisher.client().flush().await.unwrap();
    // Recovery is five seconds away: this must be the other replica's real Core NATS event.
    let wake = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(wake.into_text().unwrap(), "{\"type\":\"group-wakeup\"}");
    let page = http
        .get(format!("{consumer}/groups/{group_id}/messages?after_seq=0"))
        .header(HEADER_GROUP_READ_TOKEN, &token_hex)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let page: GroupMessagesResponse = serde_json::from_slice(&page).unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0], first);
    socket.close(None).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let second = append(seal(2)).await;
    publisher.client().flush().await.unwrap();
    // The ephemeral hint was published with no browser subscription. Startup must recover from
    // the durable receipt's original sequence, without republishing or inventing a second cursor.
    let (mut reconnected, _) = connect_async(&ws_url).await.unwrap();
    reconnected.send(Message::Text(auth)).await.unwrap();
    let wake = tokio::time::timeout(Duration::from_secs(2), reconnected.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(wake.into_text().unwrap(), "{\"type\":\"group-wakeup\"}");
    let page = http
        .get(format!(
            "{consumer}/groups/{group_id}/messages?after_seq={}",
            first.server_seq
        ))
        .header(HEADER_GROUP_READ_TOKEN, &token_hex)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let page: GroupMessagesResponse = serde_json::from_slice(&page).unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0], second);
    reconnected.close(None).await.unwrap();
    producer_task.abort();
    consumer_task.abort();
}
