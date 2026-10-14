//! Ephemeral wakeups only. Ordered HTTP reads and authenticated receipts own progress.
use super::*;
use crate::events::RelayEventBus;
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    RawQuery,
};
use std::{sync::Arc, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscription {
    epoch: u64,
    read_token: String,
    upstream_relay: Option<String>,
    subscriber_tag: Option<String>,
}

pub(super) async fn handle_live(
    Path(group_id): Path<String>,
    RawQuery(query): RawQuery,
    Extension(server): Extension<RegistryServer>,
    ws: WebSocketUpgrade,
) -> Response {
    match registry_group_store(&server).await {
        Ok(store) => upgrade(store, server.event_bus().clone(), group_id, query, ws),
        Err(error) => group_error_response(error),
    }
}

pub(super) async fn handle_live_store(
    Path(group_id): Path<String>,
    RawQuery(query): RawQuery,
    Extension(store): Extension<GroupStore>,
    Extension(bus): Extension<Arc<dyn RelayEventBus>>,
    ws: WebSocketUpgrade,
) -> Response {
    upgrade(store, bus, group_id, query, ws)
}

fn upgrade(
    store: GroupStore,
    bus: Arc<dyn RelayEventBus>,
    group_id: String,
    query: Option<String>,
    ws: WebSocketUpgrade,
) -> Response {
    // No credentials in URLs, even if a client accidentally tries query authentication.
    if query.is_some() || parse_group_id_hex(&group_id).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    ws.max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| run(socket, store, bus, group_id))
}

async fn authorized(store: GroupStore, group_id: &str, headers: &HeaderMap, epoch: u64) -> bool {
    // Reuse the authenticated read boundary, including foreign affinity, certificate validation,
    // public destination pinning and deadlines. Never mint a second authorization/cache owner.
    let response = get_group_messages_impl(
        store,
        group_id.to_owned(),
        GroupMessagesQuery {
            after_seq: Some(u64::MAX),
            limit: Some(1),
        },
        headers.clone(),
    )
    .await;
    if !response.status().is_success() {
        return false;
    }
    match hyper::body::to_bytes(response.into_body()).await {
        Ok(bytes) => serde_json::from_slice::<GroupMessagesResponse>(&bytes)
            .map(|body| body.group_id == group_id && body.epoch == epoch)
            .unwrap_or(false),
        Err(_) => false,
    }
}

async fn run(
    mut socket: WebSocket,
    store: GroupStore,
    bus: Arc<dyn RelayEventBus>,
    group_id: String,
) {
    let auth = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<Subscription>(&text) {
            Ok(auth) => auth,
            Err(_) => return,
        },
        _ => return,
    };
    let mut headers = HeaderMap::new();
    for (name, value) in [
        (HEADER_GROUP_READ_TOKEN, Some(auth.read_token)),
        (HEADER_GROUP_UPSTREAM_RELAY, auth.upstream_relay),
        (HEADER_GROUP_SUBSCRIBER_TAG, auth.subscriber_tag),
    ] {
        if let Some(value) = value {
            let Ok(value) = HeaderValue::from_str(&value) else {
                return;
            };
            headers.insert(header::HeaderName::from_static(name), value);
        }
    }
    // A promoted mirror is still foreign. Omission must not turn its stale cached epoch into
    // local read authority after upstream removal/rotation.
    match store.get_mirror_state(&group_id) {
        Ok(Some(state)) if !headers.contains_key(HEADER_GROUP_UPSTREAM_RELAY) => {
            let Ok(value) = HeaderValue::from_str(&state.upstream_relay) else {
                return;
            };
            headers.insert(
                header::HeaderName::from_static(HEADER_GROUP_UPSTREAM_RELAY),
                value,
            );
        }
        Err(_) => return,
        _ => {}
    }
    // Subscribe before authorization so an append racing the initial read cannot be missed.
    let mut events =
        match tokio::time::timeout(Duration::from_secs(2), bus.subscribe_group(&group_id)).await {
            Ok(Ok(events)) => events,
            _ => return,
        };
    let mut recovery = tokio::time::interval(Duration::from_secs(5));
    recovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let lifetime = tokio::time::sleep(Duration::from_secs(15 * 60));
    tokio::pin!(lifetime);
    loop {
        tokio::select! {
            _ = &mut lifetime => break,
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Ping(bytes))) => {
                    if !matches!(tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Pong(bytes))).await, Ok(Ok(()))) { break; }
                    continue;
                }
                _ => break,
            },
            event = events.recv() => { if event.is_none() { break; } },
            _ = recovery.tick() => {},
        }
        let valid = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(20), authorized(store.clone(), &group_id, &headers, auth.epoch)) => matches!(result, Ok(true)),
            _ = socket.recv() => false,
            _ = &mut lifetime => false,
        };
        if !valid {
            break;
        }
        // Payloads are hints, never sequence/cursor authority. Bounded writes evict slow clients.
        if !matches!(
            tokio::time::timeout(
                Duration::from_secs(5),
                socket.send(Message::Text("{\"type\":\"group-wakeup\"}".into()))
            )
            .await,
            Ok(Ok(()))
        ) {
            break;
        }
        // Coalesce event storms; recovery ticks independently repair dropped/lagged notifications.
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite};

    #[tokio::test]
    async fn url_credentials_are_refused_and_unauthenticated_sockets_are_closed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(
                    router_with_store(GroupStore::new_in_memory(
                        cashweb_config::GroupAppendPolicy {
                            per_message_price_credits: 0,
                        },
                    ))
                    .into_make_service(),
                )
                .await
                .unwrap();
        });
        let url = format!("ws://{address}/groups/{}/live", "11".repeat(32));
        let error = connect_async(format!("{url}?read_token=forbidden"))
            .await
            .unwrap_err();
        assert!(
            matches!(error, tungstenite::Error::Http(response) if response.status() == StatusCode::BAD_REQUEST)
        );
        // A socket that never supplies a first-frame capability is closed, not kept open.
        let (mut socket, _) = connect_async(&url).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(7), socket.next()).await;
        assert!(result.is_ok());
        // A malformed or unauthorized first frame closes the socket without a wakeup.
        for frame in [
            "{}",
            &format!("{{\"epoch\":0,\"read_token\":\"{}\"}}", "00".repeat(32)),
        ] {
            let (mut socket, _) = connect_async(&url).await.unwrap();
            socket
                .send(tungstenite::Message::Text(frame.to_string()))
                .await
                .unwrap();
            let next = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap();
            assert!(!matches!(next, Some(Ok(tungstenite::Message::Text(_)))));
        }
        server.abort();
    }
}
