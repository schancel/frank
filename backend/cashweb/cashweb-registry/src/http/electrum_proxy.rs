//! Electrum protocol forwarding for Bitcoin-family chains (Bitcoin, Bitcoin Cash, Dogecoin).
//!
//! A browser cannot open the TCP or TLS sockets most Electrum servers listen on, so the relay
//! accepts a WebSocket and forwards each JSON-RPC text frame to one configured upstream, which may
//! be `tcp://`, `ssl://`, `ws://` or `wss://`. Chronik stays the indexer for eCash; this is the
//! second indexer backend.
//!
//! Identity: Bitcoin testnet and Bitcoin Cash testnet share a genesis block, so the genesis hash
//! from `server.features` cannot tell them apart. Every upstream connection is therefore asked for
//! the block header at the chain's configured checkpoint height before any client frame is
//! forwarded, and is dropped when the header does not hash to the configured checkpoint. Because
//! the check runs per connection, an upstream that is down never stops the relay from starting.

use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::{
        connect_info::ConnectInfo,
        ws::{Message as ClientWsMessage, WebSocket, WebSocketUpgrade},
        Extension, Path,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::{mpsc, OwnedSemaphorePermit},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message as UpstreamWsMessage},
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

use crate::{
    http::{
        bitcoin_proxy::BitcoinProxyRuntime,
        evm_rpc::{rpc_error, RpcRejection},
        hourly_quota::normalize_quota_ip,
        json_rpc::{parse_without_duplicate_keys, rpc_id_is_bounded, sanitize_response_errors},
        server::RegistryServer,
    },
    monad_http::Address,
};

/// Largest single upstream message forwarded to a client.
const MAX_UPSTREAM_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_SUBSCRIPTIONS: usize = 256;
const HEADER_BYTES: usize = 80;
const IDENTITY_REQUEST_ID: &str = "frank-relay-identity";
const HEADERS_SUBSCRIPTION: &str = "__headers__";

/// Who pays for the requests of one WebSocket session.
#[derive(Clone, Copy, Debug)]
pub(crate) enum ElectrumPayer {
    /// An unauthenticated caller, charged per source address like the public Chronik routes.
    Anonymous(IpAddr),
    /// A caller holding a capability issued to a directory entry.
    Customer(Address),
}

/// One chain's Electrum upstreams and the block that identifies the chain.
#[derive(Clone, Debug)]
pub(crate) struct ElectrumChain {
    pub(crate) id: String,
    pub(crate) urls: Vec<Url>,
    pub(crate) checkpoint_height: u64,
    pub(crate) checkpoint_hash: String,
}

/// The Electrum methods a wallet needs. Everything else is refused.
fn method_cost(method: &str) -> Option<(u32, bool)> {
    let broadcast = method == "blockchain.transaction.broadcast";
    let allowed = matches!(
        method,
        "server.version"
            | "server.ping"
            | "server.banner"
            | "server.features"
            | "blockchain.headers.subscribe"
            | "blockchain.estimatefee"
            | "blockchain.relayfee"
            | "blockchain.block.header"
            | "blockchain.block.headers"
            | "blockchain.scripthash.get_balance"
            | "blockchain.scripthash.get_history"
            | "blockchain.scripthash.get_mempool"
            | "blockchain.scripthash.listunspent"
            | "blockchain.scripthash.subscribe"
            | "blockchain.scripthash.unsubscribe"
            | "blockchain.transaction.get"
            | "blockchain.transaction.broadcast"
            | "blockchain.transaction.get_merkle"
            | "blockchain.transaction.id_from_pos"
    );
    let cost = if broadcast {
        10
    } else if matches!(
        method,
        "blockchain.transaction.get" | "blockchain.block.header" | "blockchain.block.headers"
    ) {
        5
    } else {
        1
    };
    allowed.then_some((cost, broadcast))
}

/// The conventional (big-endian hex) hash of a block header given as hex. Dogecoin merge-mined
/// headers carry extra proof-of-work data after the first 80 bytes; the block hash covers only
/// those 80 bytes on every Bitcoin-family chain.
fn block_hash_from_header_hex(header_hex: &str) -> Option<String> {
    let bytes = hex::decode(header_hex).ok()?;
    let header = bytes.get(..HEADER_BYTES)?;
    let mut hash = Sha256::digest(Sha256::digest(header)).to_vec();
    hash.reverse();
    Some(hex::encode(hash))
}

/// A connected Electrum server, whatever its transport: one JSON text per message.
struct Upstream {
    sink: UpstreamSink,
    messages: mpsc::Receiver<String>,
    reader: tokio::task::JoinHandle<()>,
}

enum UpstreamSink {
    Ws(futures::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, UpstreamWsMessage>),
    Line(Box<dyn AsyncWrite + Send + Unpin>),
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Upstream {
    async fn connect(url: &Url, max_message_bytes: usize) -> Result<Self, ()> {
        let (tx, messages) = mpsc::channel::<String>(32);
        match url.scheme() {
            "ws" | "wss" => {
                let config = WebSocketConfig {
                    max_send_queue: Some(32),
                    max_message_size: Some(max_message_bytes),
                    max_frame_size: Some(max_message_bytes),
                    accept_unmasked_frames: false,
                };
                let (stream, _) = connect_async_with_config(url.as_str(), Some(config))
                    .await
                    .map_err(|_| ())?;
                let (sink, mut read) = stream.split();
                let reader = tokio::spawn(async move {
                    while let Some(Ok(message)) = read.next().await {
                        match message {
                            UpstreamWsMessage::Text(text) => {
                                if tx.send(text).await.is_err() {
                                    break;
                                }
                            }
                            UpstreamWsMessage::Close(_) | UpstreamWsMessage::Binary(_) => break,
                            _ => {}
                        }
                    }
                });
                Ok(Self {
                    sink: UpstreamSink::Ws(sink),
                    messages,
                    reader,
                })
            }
            "tcp" | "ssl" => {
                let host = url.host_str().ok_or(())?.to_string();
                let port = url.port().ok_or(())?;
                let tcp = TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|_| ())?;
                let _ = tcp.set_nodelay(true);
                if url.scheme() == "ssl" {
                    let connector = tokio_native_tls::TlsConnector::from(
                        native_tls::TlsConnector::new().map_err(|_| ())?,
                    );
                    let stream = connector.connect(&host, tcp).await.map_err(|_| ())?;
                    Ok(Self::from_line_stream(
                        stream,
                        tx,
                        messages,
                        max_message_bytes,
                    ))
                } else {
                    Ok(Self::from_line_stream(tcp, tx, messages, max_message_bytes))
                }
            }
            _ => Err(()),
        }
    }

    /// Electrum's native framing: one JSON value per newline-terminated line.
    fn from_line_stream<S>(
        stream: S,
        tx: mpsc::Sender<String>,
        messages: mpsc::Receiver<String>,
        max_message_bytes: usize,
    ) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (read, write) = tokio::io::split(stream);
        let reader = tokio::spawn(async move {
            let mut read = BufReader::new(read);
            let mut line = Vec::new();
            loop {
                line.clear();
                // Bound the line: a server that never sends a newline cannot grow this buffer.
                let mut limited = (&mut read).take(max_message_bytes as u64 + 1);
                match limited.read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if line.last() != Some(&b'\n') {
                    break;
                }
                let Ok(text) = std::str::from_utf8(&line) else {
                    break;
                };
                let text = text.trim();
                if !text.is_empty() && tx.send(text.to_string()).await.is_err() {
                    break;
                }
            }
        });
        Self {
            sink: UpstreamSink::Line(Box::new(write)),
            messages,
            reader,
        }
    }

    async fn send(&mut self, text: String) -> Result<(), ()> {
        match &mut self.sink {
            UpstreamSink::Ws(sink) => sink
                .send(UpstreamWsMessage::Text(text))
                .await
                .map_err(|_| ()),
            UpstreamSink::Line(write) => {
                let mut line = text.into_bytes();
                // A request is a single line; an embedded newline would split it in two.
                if line.contains(&b'\n') {
                    return Err(());
                }
                line.push(b'\n');
                write.write_all(&line).await.map_err(|_| ())?;
                write.flush().await.map_err(|_| ())
            }
        }
    }

    async fn next(&mut self) -> Option<String> {
        self.messages.recv().await
    }

    /// Ask for the checkpoint header and compare its hash with the configured one.
    async fn serves_chain(&mut self, chain: &ElectrumChain) -> bool {
        let request = json!({
            "jsonrpc": "2.0",
            "id": IDENTITY_REQUEST_ID,
            "method": "blockchain.block.header",
            "params": [chain.checkpoint_height],
        });
        if self.send(request.to_string()).await.is_err() {
            return false;
        }
        while let Some(text) = self.next().await {
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                return false;
            };
            if value.get("id").and_then(Value::as_str) != Some(IDENTITY_REQUEST_ID) {
                continue;
            }
            return value
                .get("result")
                .and_then(Value::as_str)
                .and_then(block_hash_from_header_hex)
                .is_some_and(|hash| hash.eq_ignore_ascii_case(&chain.checkpoint_hash));
        }
        false
    }
}

/// Connect to the first upstream that answers and proves it serves `chain`.
async fn connect_verified(
    runtime: &BitcoinProxyRuntime,
    chain: &ElectrumChain,
    timeout: Duration,
    max_message_bytes: usize,
) -> Option<Upstream> {
    let cooldowns = runtime.upstream_cooldowns();
    for url in cooldowns.splay_order(&chain.urls) {
        let attempt = async {
            let mut upstream = Upstream::connect(url, max_message_bytes).await.ok()?;
            match upstream.serves_chain(chain).await {
                true => Some(upstream),
                false => {
                    // The URL may hold credentials; only the chain is named.
                    tracing::warn!(
                        chain = %chain.id,
                        "Electrum upstream did not return the configured checkpoint block"
                    );
                    None
                }
            }
        };
        match tokio::time::timeout(timeout, attempt).await {
            Ok(Some(upstream)) => {
                cooldowns.mark_success(url);
                return Some(upstream);
            }
            _ => cooldowns.mark_failure(url),
        }
    }
    None
}

fn ws_error(id: Value, code: i64, message: &'static str) -> ClientWsMessage {
    ClientWsMessage::Text(
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}).to_string(),
    )
}

fn id_key(id: &Value) -> Option<String> {
    if !rpc_id_is_bounded(id) {
        return None;
    }
    match id {
        Value::String(text) => Some(format!("s{text}")),
        Value::Number(number) => Some(format!("n{number}")),
        _ => None,
    }
}

enum PendingKind {
    Call,
    Subscribe(String),
    Unsubscribe(String),
}

struct Pending {
    kind: PendingKind,
    deadline: tokio::time::Instant,
    _permit: OwnedSemaphorePermit,
}

fn first_param(object: &serde_json::Map<String, Value>) -> &str {
    object
        .get("params")
        .and_then(Value::as_array)
        .and_then(|params| params.first())
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `GET /chain-rpc/:chain/electrum`: a public Electrum WebSocket, charged per source address.
pub(crate) async fn handle_electrum_ws(
    Path(chain_id): Path<String>,
    peer: Option<ConnectInfo<std::net::SocketAddr>>,
    Extension(server): Extension<RegistryServer>,
    ws: WebSocketUpgrade,
) -> Result<Response, RpcRejection> {
    let ip = peer
        .map(|peer| normalize_quota_ip(peer.0.ip()))
        .ok_or_else(|| rpc_error(StatusCode::UNAUTHORIZED, "rpc_source_required"))?;
    let runtime = server
        .bitcoin_proxy
        .clone()
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "rpc_disabled"))?;
    let lifetime = runtime.capability_lifetime();
    upgrade(
        runtime,
        &chain_id,
        ElectrumPayer::Anonymous(ip),
        lifetime,
        ws,
    )
}

/// Upgrade one client WebSocket and forward it to a verified Electrum upstream for `lifetime`.
pub(crate) fn upgrade(
    runtime: Arc<BitcoinProxyRuntime>,
    chain_id: &str,
    payer: ElectrumPayer,
    lifetime: Duration,
    ws: WebSocketUpgrade,
) -> Result<Response, RpcRejection> {
    let chain = runtime
        .electrum_chain(chain_id)
        .ok_or_else(|| rpc_error(StatusCode::NOT_FOUND, "unknown_rpc_chain"))?;
    let (timeout, max_request_bytes, max_response_bytes) = runtime.electrum_limits();
    let max_upstream_bytes = max_response_bytes.min(MAX_UPSTREAM_MESSAGE_BYTES);
    Ok(ws
        .max_message_size(max_request_bytes)
        .max_frame_size(max_request_bytes)
        .on_upgrade(move |socket| async move {
            let deadline = tokio::time::Instant::now() + lifetime;
            let Some(upstream) =
                connect_verified(&runtime, &chain, timeout, max_upstream_bytes).await
            else {
                let mut socket = socket;
                let _ = socket
                    .send(ws_error(
                        Value::Null,
                        -32003,
                        "no Electrum upstream available",
                    ))
                    .await;
                let _ = socket.send(ClientWsMessage::Close(None)).await;
                return;
            };
            forward(socket, upstream, &runtime, payer, timeout, deadline).await;
        })
        .into_response())
}

async fn forward(
    socket: WebSocket,
    mut upstream: Upstream,
    runtime: &BitcoinProxyRuntime,
    payer: ElectrumPayer,
    request_timeout: Duration,
    session_deadline: tokio::time::Instant,
) {
    let (mut client_write, mut client_read) = socket.split();
    let mut subscriptions = HashSet::<String>::new();
    let mut pending = HashMap::<String, Pending>::new();

    macro_rules! reply {
        ($message:expr) => {
            if client_write.send($message).await.is_err() {
                break;
            }
        };
    }

    loop {
        let request_deadline = pending.values().map(|request| request.deadline).min();
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(session_deadline) => break,
            // An upstream that stops answering is abandoned; the client reconnects elsewhere.
            _ = tokio::time::sleep_until(request_deadline.unwrap_or(session_deadline)),
                if request_deadline.is_some() => break,
            client = client_read.next() => {
                let Some(Ok(message)) = client else { break };
                let text = match message {
                    ClientWsMessage::Text(text) => text,
                    ClientWsMessage::Ping(payload) => {
                        reply!(ClientWsMessage::Pong(payload));
                        continue;
                    }
                    ClientWsMessage::Pong(_) => continue,
                    ClientWsMessage::Close(_) => break,
                    ClientWsMessage::Binary(_) => {
                        reply!(ws_error(Value::Null, -32600, "binary requests not supported"));
                        continue;
                    }
                };
                let Ok(value) = parse_without_duplicate_keys(text.as_bytes()) else {
                    reply!(ws_error(Value::Null, -32700, "invalid request"));
                    continue;
                };
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let (Some(object), Some(key)) = (value.as_object(), id_key(&id)) else {
                    reply!(ws_error(Value::Null, -32600, "invalid request"));
                    continue;
                };
                let Some(method) = object.get("method").and_then(Value::as_str) else {
                    reply!(ws_error(id, -32600, "method required"));
                    continue;
                };
                let Some((cost, broadcast)) = method_cost(method) else {
                    reply!(ws_error(id, -32601, "method denied by relay"));
                    continue;
                };
                if pending.len() >= MAX_PENDING_REQUESTS || pending.contains_key(&key) {
                    reply!(ws_error(id, -32005, "pending request limit exceeded"));
                    continue;
                }
                let kind = match method {
                    "blockchain.scripthash.subscribe" | "blockchain.scripthash.unsubscribe" => {
                        let scripthash = first_param(object);
                        if scripthash.len() != 64
                            || !scripthash.bytes().all(|byte| byte.is_ascii_hexdigit())
                        {
                            reply!(ws_error(id, -32602, "invalid scripthash"));
                            continue;
                        }
                        if method.ends_with(".unsubscribe") {
                            PendingKind::Unsubscribe(scripthash.to_ascii_lowercase())
                        } else if subscriptions.len() >= MAX_SUBSCRIPTIONS {
                            reply!(ws_error(id, -32005, "subscription limit exceeded"));
                            continue;
                        } else {
                            PendingKind::Subscribe(scripthash.to_ascii_lowercase())
                        }
                    }
                    "blockchain.headers.subscribe" => {
                        PendingKind::Subscribe(HEADERS_SUBSCRIPTION.to_string())
                    }
                    _ => PendingKind::Call,
                };
                let Some(permit) = runtime.try_request_permit() else {
                    reply!(ws_error(id, -32005, "relay busy"));
                    continue;
                };
                if !runtime.charge_electrum(payer, cost, broadcast) {
                    reply!(ws_error(id, -32005, "hourly quota exceeded"));
                    continue;
                }
                pending.insert(
                    key,
                    Pending {
                        kind,
                        deadline: tokio::time::Instant::now() + request_timeout,
                        _permit: permit,
                    },
                );
                if upstream.send(text).await.is_err() {
                    break;
                }
            }
            message = upstream.next() => {
                let Some(text) = message else { break };
                let Ok(mut value) = parse_without_duplicate_keys(text.as_bytes()) else { break };
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                if id.is_null() {
                    // A notification for something this client subscribed to.
                    let subscribed = match value.get("method").and_then(Value::as_str) {
                        Some("blockchain.headers.subscribe") => {
                            subscriptions.contains(HEADERS_SUBSCRIPTION)
                        }
                        Some("blockchain.scripthash.subscribe") => value
                            .get("params")
                            .and_then(Value::as_array)
                            .and_then(|params| params.first())
                            .and_then(Value::as_str)
                            .is_some_and(|hash| subscriptions.contains(&hash.to_ascii_lowercase())),
                        _ => false,
                    };
                    if subscribed {
                        reply!(ClientWsMessage::Text(text));
                    }
                    continue;
                }
                // A response nobody asked for means the two sides are out of step.
                let Some(request) = id_key(&id).and_then(|key| pending.remove(&key)) else { break };
                if value.get("error").is_none_or(Value::is_null) {
                    match request.kind {
                        PendingKind::Subscribe(name) => {
                            subscriptions.insert(name);
                        }
                        PendingKind::Unsubscribe(name) => {
                            subscriptions.remove(&name);
                        }
                        PendingKind::Call => {}
                    }
                }
                sanitize_response_errors(&mut value);
                reply!(ClientWsMessage::Text(value.to_string()));
            }
        }
    }
    let _ = tokio::time::timeout(
        request_timeout,
        client_write.send(ClientWsMessage::Close(None)),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_first_eighty_header_bytes() {
        // Bitcoin's genesis block header.
        let genesis = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        assert_eq!(
            block_hash_from_header_hex(genesis).as_deref(),
            Some("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f")
        );
        // Merge-mined (Dogecoin AuxPoW) headers carry extra bytes that are not part of the hash.
        let with_auxpow = format!("{genesis}deadbeef");
        assert_eq!(
            block_hash_from_header_hex(&with_auxpow),
            block_hash_from_header_hex(genesis)
        );
        assert_eq!(block_hash_from_header_hex(&genesis[..158]), None);
        assert_eq!(block_hash_from_header_hex("not hex"), None);
    }

    #[test]
    fn allows_wallet_methods_only() {
        assert_eq!(
            method_cost("blockchain.scripthash.listunspent"),
            Some((1, false))
        );
        assert_eq!(
            method_cost("blockchain.transaction.broadcast"),
            Some((10, true))
        );
        assert_eq!(method_cost("blockchain.transaction.get"), Some((5, false)));
        for denied in [
            "server.add_peer",
            "server.peers.subscribe",
            "server.donation_address",
            "blockchain.utxo.get_address",
            "eth_chainId",
            "",
        ] {
            assert_eq!(method_cost(denied), None, "{denied}");
        }
    }

    #[test]
    fn request_ids_are_strings_or_numbers() {
        assert_eq!(id_key(&json!(7)).as_deref(), Some("n7"));
        assert_eq!(id_key(&json!("7")).as_deref(), Some("s7"));
        assert_eq!(id_key(&Value::Null), None);
        assert_eq!(id_key(&json!([1])), None);
    }
}
