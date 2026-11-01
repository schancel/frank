//! Real Electrum WebSocket forwarding while a shared quota transaction is paused.
use super::super::hourly_quota::{
    tests::{paused_backend, websocket_pair},
    QuotaBackend,
};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq)]
enum Boundary {
    Session,
    OlderPending,
    LocalPositive,
}

async fn quota_wait(boundary: Boundary) {
    let (_directory, paused, shared) = paused_backend();
    let local = boundary == Boundary::LocalPositive;
    let backend = if local { QuotaBackend::local() } else { shared };
    let conf = cashweb_config::BitcoinProxyConf {
        enabled: true,
        chains: vec![cashweb_config::BitcoinProxyChainConf {
            id: "xec-regtest".into(),
            rpc_upstream_env: None,
            rpc_upstream_envs: vec![],
            chronik_upstream_env: Some("UNUSED_TEST_ENDPOINT".into()),
            chronik_upstream_envs: vec![],
            electrum_upstream_env: None,
            electrum_upstream_envs: vec![],
            checkpoint_height: 42,
            checkpoint_hash: "00".repeat(32),
        }],
        ..Default::default()
    };
    let runtime = BitcoinProxyRuntime::new(
        &conf,
        Arc::new(crate::chains::RelayChains::for_test("monad-testnet")),
        &crate::evm_mailbox::SessionSecret::random(),
        backend.clone(),
    )
    .unwrap()
    .unwrap();
    let (relay_client, mut client) = websocket_pair().await;
    let (mut node, relay_upstream) = websocket_pair().await;
    let (sink, mut read) = relay_upstream.split();
    let (send, messages) = mpsc::channel(32);
    let reader = tokio::spawn(async move {
        while let Some(Ok(UpstreamWsMessage::Text(text))) = read.next().await {
            if send.send(text).await.is_err() {
                break;
            }
        }
    });
    let upstream = Upstream {
        sink: UpstreamSink::Ws(sink),
        messages,
        reader,
    };
    let forwarded = Arc::new(AtomicUsize::new(0));
    let (seen, mut requests) = mpsc::unbounded_channel();
    let node_task = tokio::spawn({
        let forwarded = forwarded.clone();
        async move {
            while let Some(Ok(ClientWsMessage::Text(text))) = node.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                let id = value["id"].as_u64().unwrap();
                if id == 3 {
                    forwarded.fetch_add(1, Ordering::SeqCst);
                }
                let _ = seen.send(id);
                if id == 2 {
                    continue;
                }
                if node
                    .send(ClientWsMessage::Text(
                        json!({"jsonrpc":"2.0","id":id,"result":[]}).to_string(),
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
    let proxy = tokio::spawn(async move {
        forward(
            relay_client,
            upstream,
            &runtime,
            ElectrumPayer::Anonymous("192.0.2.1".parse().unwrap()),
            request_timeout,
            session_deadline,
        )
        .await;
    });
    let request = |id| {
        UpstreamWsMessage::Text(json!({"jsonrpc":"2.0","id":id,"method":"blockchain.scripthash.listunspent","params":["00".repeat(32)]}).to_string())
    };
    // Positive control traverses the same real sockets before storage is paused.
    client.send(request(0)).await.unwrap();
    assert_eq!(requests.recv().await, Some(0));
    assert!(client.next().await.unwrap().unwrap().is_text());
    let deadline = if boundary == Boundary::OlderPending {
        client.send(request(2)).await.unwrap();
        assert_eq!(requests.recv().await, Some(2));
        tokio::time::Instant::now() + request_timeout
    } else {
        session_deadline
    };
    if !local {
        paused.pause_next();
    }
    client.send(request(3)).await.unwrap();
    if local {
        assert_eq!(requests.recv().await, Some(3));
        assert!(client.next().await.unwrap().unwrap().is_text());
        let _ = client.send(UpstreamWsMessage::Close(None)).await;
    } else {
        paused.wait_entered().await;
        tokio::time::sleep_until(deadline + Duration::from_millis(20)).await;
    }
    let completed_while_paused = proxy.is_finished();
    paused.resume();
    tokio::time::timeout(Duration::from_secs(2), proxy)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), node_task)
        .await
        .unwrap()
        .unwrap();
    backend.close_and_drain().await;
    let forwarded = forwarded.load(Ordering::SeqCst);
    println!("electrum local={local} forwarded={forwarded} completed_while_paused={completed_while_paused}");
    assert_eq!(
        forwarded,
        usize::from(local),
        "expired quota wait cannot forward another Electrum request"
    );
    if !local {
        assert!(
            completed_while_paused,
            "deadline must close before storage finishes"
        );
    }
}

#[tokio::test]
async fn shared_quota_electrum_session_deadline() {
    quota_wait(Boundary::Session).await;
}
#[tokio::test]
async fn shared_quota_electrum_older_pending_deadline() {
    quota_wait(Boundary::OlderPending).await;
}
#[tokio::test]
async fn shared_quota_electrum_local_positive() {
    quota_wait(Boundary::LocalPositive).await;
}
