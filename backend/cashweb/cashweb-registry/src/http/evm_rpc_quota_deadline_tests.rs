//! Real-socket regressions for quota work admitted before a session/pending deadline.
use super::super::hourly_quota::tests::{paused_backend, websocket_pair};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq)]
enum Boundary {
    Session,
    OlderPending,
    LocalPositive,
}

async fn quota_wait(notification: bool, boundary: Boundary) {
    let (_directory, paused, shared) = paused_backend();
    let local = boundary == Boundary::LocalPositive;
    let backend = if local { QuotaBackend::local() } else { shared };
    let quota = Arc::new(FixedHourQuota::with_backend(
        100,
        QuotaDomain::EvmCustomer,
        backend.clone(),
    ));
    let (relay_client, mut client) = websocket_pair().await;
    let (node, relay_upstream) = websocket_pair().await;
    let (node_write, mut node_read) = node.split();
    let node_write = Arc::new(tokio::sync::Mutex::new(node_write));
    let forwarded = Arc::new(AtomicUsize::new(0));
    let (seen, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let node_task = tokio::spawn({
        let write = node_write.clone();
        let forwarded = forwarded.clone();
        async move {
            while let Some(Ok(ClientWsMessage::Text(text))) = node_read.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                let id = value["id"].as_u64().unwrap();
                if id == 3 {
                    forwarded.fetch_add(1, Ordering::SeqCst);
                }
                let _ = seen.send(id);
                if id == 2 {
                    continue;
                } // Older request stays pending.
                let result = if id == 1 { json!("sub") } else { json!("0x1") };
                if write
                    .lock()
                    .await
                    .send(ClientWsMessage::Text(
                        json!({"jsonrpc":"2.0","id":id,"result":result}).to_string(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    });
    let request_timeout = Duration::from_secs(1);
    let session_deadline = tokio::time::Instant::now()
        + if boundary == Boundary::Session {
            request_timeout
        } else {
            Duration::from_secs(10)
        };
    let proxy = tokio::spawn(proxy_ws_connection(
        relay_client,
        relay_upstream,
        Arc::new(EvmChainAdapter::assume_verified(
            "monad-testnet",
            vec!["http://127.0.0.1:1".parse().unwrap()],
        )),
        Address([1; 20]),
        quota,
        Arc::new(Semaphore::new(8)),
        request_timeout,
        session_deadline,
    ));
    // Live positive control before pausing storage: a valid request traverses both real sockets.
    client
        .send(UpstreamWsMessage::Text(
            json!({"jsonrpc":"2.0","id":0,"method":"eth_blockNumber","params":[]}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(requests.recv().await, Some(0));
    assert!(client.next().await.unwrap().unwrap().is_text());
    if notification {
        client
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]})
                    .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(requests.recv().await, Some(1));
        assert!(client.next().await.unwrap().unwrap().is_text());
    }
    let deadline = if boundary == Boundary::OlderPending {
        client
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(requests.recv().await, Some(2));
        tokio::time::Instant::now() + request_timeout
    } else {
        session_deadline
    };
    let delivered = Arc::new(AtomicUsize::new(0));
    let delivered_notice = Arc::new(tokio::sync::Notify::new());
    let (mut client_write, mut client_read) = client.split();
    let client_task = tokio::spawn({
        let delivered = delivered.clone();
        let notice = delivered_notice.clone();
        async move {
            while let Some(Ok(UpstreamWsMessage::Text(text))) = client_read.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["method"] == "eth_subscription" || value["id"] == 3 {
                    delivered.fetch_add(1, Ordering::SeqCst);
                    notice.notify_one();
                }
            }
        }
    });
    if !local {
        paused.pause_next();
    }
    if notification {
        node_write.lock().await.send(ClientWsMessage::Text(json!({"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"sub","result":{}}}).to_string())).await.unwrap();
    } else {
        client_write
            .send(UpstreamWsMessage::Text(
                json!({"jsonrpc":"2.0","id":3,"method":"eth_blockNumber","params":[]}).to_string(),
            ))
            .await
            .unwrap();
    }
    if local {
        tokio::time::timeout(Duration::from_secs(2), delivered_notice.notified())
            .await
            .unwrap();
        let _ = client_write.send(UpstreamWsMessage::Close(None)).await;
    } else {
        paused.wait_entered().await;
        tokio::time::sleep_until(deadline + Duration::from_millis(20)).await;
    }
    let completed_while_paused = proxy.is_finished();
    paused.resume(); // A committed/uncertain charge is never refunded for expiry.
    tokio::time::timeout(Duration::from_secs(2), proxy)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), node_task)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), client_task)
        .await
        .unwrap()
        .unwrap();
    backend.close_and_drain().await;
    let forwarded = forwarded.load(Ordering::SeqCst);
    let delivered = delivered.load(Ordering::SeqCst);
    println!("notification={notification} local={local} forwarded={forwarded} delivered={delivered} completed_while_paused={completed_while_paused}");
    if local {
        assert_eq!(delivered, 1);
        assert_eq!(forwarded, usize::from(!notification));
    } else {
        assert_eq!(
            forwarded, 0,
            "expired quota wait must not forward another request"
        );
        assert_eq!(
            delivered, 0,
            "expired quota wait must not deliver another payload"
        );
        assert!(
            completed_while_paused,
            "deadline must close without waiting for storage"
        );
    }
}

#[tokio::test]
async fn shared_quota_ws_request_session_deadline() {
    quota_wait(false, Boundary::Session).await;
}
#[tokio::test]
async fn shared_quota_ws_request_older_pending_deadline() {
    quota_wait(false, Boundary::OlderPending).await;
}
#[tokio::test]
async fn shared_quota_ws_notification_session_deadline() {
    quota_wait(true, Boundary::Session).await;
}
#[tokio::test]
async fn shared_quota_ws_notification_older_pending_deadline() {
    quota_wait(true, Boundary::OlderPending).await;
}
#[tokio::test]
async fn shared_quota_ws_request_local_positive() {
    quota_wait(false, Boundary::LocalPositive).await;
}
#[tokio::test]
async fn shared_quota_ws_notification_local_positive() {
    quota_wait(true, Boundary::LocalPositive).await;
}

#[tokio::test]
async fn shared_quota_ws_elapsed_send_never_touches_ready_socket() {
    let (mut server, mut client) = websocket_pair().await;
    assert!(
        !bounded_ws_send(
            &mut server,
            ClientWsMessage::Text("expired".into()),
            tokio::time::Instant::now() - Duration::from_millis(1)
        )
        .await
    );
    drop(server);
    assert!(!matches!(
        client.next().await,
        Some(Ok(UpstreamWsMessage::Text(_)))
    ));
}
