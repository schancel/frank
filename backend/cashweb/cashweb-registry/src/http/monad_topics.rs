//! Canonical Forum HTTP boundary: schema-2 content and exact type-10/11 operations.
//! Normal post/reply/read/list/discovery/vote/status uses CBOR exclusively. Historical
//! ordinary DB records and unsupported wallet obligations remain retained; these routes
//! never decode, translate, settle or replay their predecessor representations.

use std::{fmt, sync::OnceLock};
use axum::{
    body::Bytes,
    extract::{Path, RawQuery},
    http::{header::{ACCEPT, CONTENT_TYPE, VARY}, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Serialize;
use crate::{
    http::server::RegistryServer,
    monad_http::{Address, HttpTransport, JsonRpcTransport},
    monad_stamp_relay::PollConfig,
    monad_topic_cbor::{parse_topic_event, TopicEvent, MAX_TOPIC_EVENT_FRAME_BYTES},
    registry::Registry,
    store::forum::{invalid, ForumError},
};

/// Errors reading required topic-vote gate configuration from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonadTopicGateConfigError {
    /// A required env var wasn't set.
    MissingEnv(&'static str),
    /// `MONAD_TESTNET_HTTP_RPC_URL` wasn't a valid URL.
    InvalidRpcUrl(String),
    /// `MONAD_STAMP_BURN_ADDRESS` wasn't a valid `0x`-prefixed 20-byte address.
    InvalidBurnAddress(String),
}

impl fmt::Display for MonadTopicGateConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MonadTopicGateConfigError::MissingEnv(name) => {
                write!(
                    f,
                    "missing required env var {name} (topic-vote gate is unconfigured)"
                )
            }
            MonadTopicGateConfigError::InvalidRpcUrl(msg) => {
                write!(f, "invalid MONAD_TESTNET_HTTP_RPC_URL: {msg}")
            }
            MonadTopicGateConfigError::InvalidBurnAddress(msg) => {
                write!(f, "invalid MONAD_STAMP_BURN_ADDRESS: {msg}")
            }
        }
    }
}

/// Configuration for the `PUT /message/monad/topics` and `PUT /message/monad/topics/vote` routes,
/// read once from the environment (see module docs).
#[derive(Debug, Clone)]
pub struct MonadTopicGateConfig {
    rpc_url: url::Url,
    burn_address: Address,
}

fn required_env(name: &'static str) -> Result<String, MonadTopicGateConfigError> {
    std::env::var(name).map_err(|_| MonadTopicGateConfigError::MissingEnv(name))
}

impl MonadTopicGateConfig {
    fn from_env() -> Result<Self, MonadTopicGateConfigError> {
        let rpc_url = required_env("MONAD_TESTNET_HTTP_RPC_URL")?;
        let rpc_url: url::Url = rpc_url
            .parse()
            .map_err(|err| MonadTopicGateConfigError::InvalidRpcUrl(format!("{err}")))?;
        let burn_address_hex = required_env("MONAD_STAMP_BURN_ADDRESS")?;
        let burn_address = Address::from_hex(&burn_address_hex)
            .map_err(|err| MonadTopicGateConfigError::InvalidBurnAddress(format!("{err}")))?;
        Ok(MonadTopicGateConfig {
            rpc_url,
            burn_address,
        })
    }
}

/// Process-wide, lazily-initialized gate config, built from the environment on first use.
fn monad_topic_gate() -> &'static Result<MonadTopicGateConfig, MonadTopicGateConfigError> {
    static GATE: OnceLock<Result<MonadTopicGateConfig, MonadTopicGateConfigError>> =
        OnceLock::new();
    GATE.get_or_init(MonadTopicGateConfig::from_env)
}

/// JSON error body for a rejected topic request.
#[derive(Debug, Serialize)]
struct MonadTopicErrorBody {
    error: &'static str,
    detail: String,
}

fn vary_accept(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Accept"));
    response
}

/// Split one HTTP list or parameter list without treating delimiters inside quoted strings as
/// syntax. Reject unbalanced quotes and dangling quoted-pair escapes.
fn split_quoted(value: &str, delimiter: char) -> Option<Vec<&str>> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            quoted = !quoted;
        } else if !quoted && ch == delimiter {
            pieces.push(&value[start..index]);
            start = index + ch.len_utf8();
        }
    }
    if quoted || escaped {
        return None;
    }
    pieces.push(&value[start..]);
    Some(pieces)
}

/// Apply existing quality, specificity and media-parameter rules to the offered CBOR frame.
fn topic_accepts(headers: &HeaderMap, expected: &str) -> bool {
    if !headers.contains_key(ACCEPT) {
        return true;
    }
    let expected = expected.to_ascii_lowercase();
    let Some((expected_type, _)) = expected.split_once('/') else {
        return false;
    };
    let type_wildcard = format!("{expected_type}/*");
    let mut selected: Option<(u8, f32)> = None;

    for value in headers.get_all(ACCEPT).iter() {
        let Ok(value) = value.to_str() else {
            return false;
        };
        let Some(ranges) = split_quoted(value, ',') else {
            return false;
        };
        for range in ranges {
            let Some(mut parts) = split_quoted(range, ';') else {
                return false;
            };
            let media_type = parts.remove(0).trim().to_ascii_lowercase();
            let specificity = if media_type == expected {
                2
            } else if media_type == type_wildcard {
                1
            } else if media_type == "*/*" {
                0
            } else {
                continue;
            };
            let mut quality = 1.0;
            let mut before_quality = true;
            let mut matches_offered_parameters = true;
            for parameter in parts {
                let mut pair = parameter.trim().splitn(2, '=');
                let name = pair.next().unwrap_or_default().trim();
                let value = pair.next().map(str::trim);
                if before_quality && name.eq_ignore_ascii_case("q") {
                    quality = value
                        .and_then(|quality| quality.trim().parse::<f32>().ok())
                        .filter(|quality| quality.is_finite() && (0.0..=1.0).contains(quality))
                        .unwrap_or(0.0);
                    before_quality = false;
                } else if before_quality {
                    // The server offers bare application/cbor. A
                    // media parameter before q constrains the representation and therefore does
                    // not match either offer. Parameters after q are RFC 7231 accept extensions.
                    matches_offered_parameters = false;
                }
            }
            if !matches_offered_parameters {
                continue;
            }
            match selected {
                Some((selected_specificity, selected_quality))
                    if selected_specificity > specificity
                        || (selected_specificity == specificity && selected_quality >= quality) => {
                }
                _ => selected = Some((specificity, quality)),
            }
        }
    }
    selected.is_some_and(|(_, quality)| quality > 0.0)
}

fn forum_bytes(frame: Vec<u8>) -> Response {
    vary_accept(([(CONTENT_TYPE, "application/cbor")], frame).into_response())
}

fn forum_error(error: crate::store::forum::ForumError) -> Response {
    use crate::store::forum::ForumError::*;
    let (status, code) = match &error {
        Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_forum_request"),
        NotFound => (StatusCode::NOT_FOUND, "topic_target_not_found"),
        Conflict => (StatusCode::CONFLICT, "topic_operation_conflict"),
        Capacity => (StatusCode::SERVICE_UNAVAILABLE, "topic_pending_capacity"),
        Expired => (StatusCode::GONE, "forum_cursor_expired"),
        SnapshotCapacity => (StatusCode::SERVICE_UNAVAILABLE, "forum_snapshot_capacity"),
        SnapshotTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "forum_snapshot_too_large"),
        RowTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "forum_row_too_large"),
        OutcomeUnknown(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "topic_burn_outcome_unknown",
        ),
        Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "forum_unavailable"),
    };
    vary_accept(
        (
            status,
            Json(MonadTopicErrorBody {
                error: code,
                detail: error.to_string(),
            }),
        )
            .into_response(),
    )
}


fn request_error(status: StatusCode, code: &'static str, detail: &str) -> Response {
    vary_accept((status, Json(MonadTopicErrorBody { error: code, detail: detail.into() })).into_response())
}

fn write_headers(headers: &HeaderMap, body: &[u8]) -> Option<Response> {
    let bare_cbor = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/cbor"));
    if !bare_cbor {
        return Some(request_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_topic_media", "canonical Forum requires bare application/cbor"));
    }
    if !topic_accepts(headers, "application/cbor") {
        return Some(request_error(StatusCode::NOT_ACCEPTABLE, "topic_not_acceptable", "canonical Forum offers application/cbor"));
    }
    if body.len() as u64 > MAX_TOPIC_EVENT_FRAME_BYTES {
        return Some(request_error(StatusCode::PAYLOAD_TOO_LARGE, "topic_event_too_large", "topic event exceeds the frame limit"));
    }
    None
}

async fn forum_submission<T: JsonRpcTransport + Clone>(
    registry: &Registry, transport: &T, burn: Address, frame: &[u8], post: bool,
) -> Response {
    let event = match parse_topic_event(frame, registry.expected_cbor_network()) {
        Ok(event) => event,
        Err(error) => return forum_error(invalid(error)),
    };
    let policy = crate::forum::policy(registry.expected_monad_chain_id(), burn);
    match &event {
        TopicEvent::Post(value) if post && value.schema_version >= 2 => (),
        TopicEvent::Vote(value) if !post => {
            match registry.forum().contains(registry.expected_cbor_network(), policy, &value.target_hash) {
                Ok(true) => (),
                Ok(false) => return forum_error(ForumError::NotFound),
                Err(error) => return forum_error(error),
            }
        }
        _ => return forum_error(invalid("request does not match the canonical Forum route")),
    }
    match registry.forum().submit(registry.expected_cbor_network(), policy, frame, transport, PollConfig::default()).await {
        Ok(frame) => forum_bytes(frame),
        Err(error) => forum_error(error),
    }
}

async fn put_forum(server: RegistryServer, headers: HeaderMap, body: Bytes, post: bool) -> Response {
    if let Some(response) = write_headers(&headers, &body) { return response; }
    let Ok(config) = monad_topic_gate().as_ref() else { return forum_error(ForumError::Unavailable); };
    let transport = HttpTransport::new(config.rpc_url.clone());
    forum_submission(&server.registry, &transport, config.burn_address, &body, post).await
}

pub async fn handle_put_monad_topic_post(Extension(server): Extension<RegistryServer>, headers: HeaderMap, body: Bytes) -> Response {
    put_forum(server, headers, body, true).await
}

pub async fn handle_put_monad_topic_vote(Extension(server): Extension<RegistryServer>, headers: HeaderMap, body: Bytes) -> Response {
    put_forum(server, headers, body, false).await
}

pub async fn handle_get_monad_topic_post(Path(hash): Path<String>, Extension(server): Extension<RegistryServer>, headers: HeaderMap) -> Response {
    if !topic_accepts(&headers, "application/cbor") {
        return request_error(StatusCode::NOT_ACCEPTABLE, "topic_not_acceptable", "canonical Forum offers application/cbor");
    }
    let hash = match hex::decode(hash).ok().and_then(|v| <[u8;32]>::try_from(v).ok()) {
        Some(hash) => hash,
        None => return forum_error(invalid("target hash must be 32 decoded bytes")),
    };
    let Ok(config) = monad_topic_gate().as_ref() else { return forum_error(ForumError::Unavailable); };
    let policy = crate::forum::policy(server.registry.expected_monad_chain_id(), config.burn_address);
    match server.registry.forum().view(server.registry.expected_cbor_network(), policy, &hash) {
        Ok(Some(frame)) => forum_bytes(frame),
        Ok(None) => forum_error(ForumError::NotFound),
        Err(error) => forum_error(error),
    }
}

/// Status never admits, broadcasts or borrows another operation's observations.
pub async fn handle_forum_status(Extension(server): Extension<RegistryServer>, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(response) = write_headers(&headers, &body) { return response; }
    let Ok(config) = monad_topic_gate().as_ref() else { return forum_error(ForumError::Unavailable); };
    match parse_topic_event(&body, server.registry.expected_cbor_network()) {
        Ok(TopicEvent::Post(post)) if post.schema_version < 2 => return forum_error(invalid("historical Forum operation is unsupported")),
        Err(error) => return forum_error(invalid(error)),
        _ => (),
    }
    let policy = crate::forum::policy(server.registry.expected_monad_chain_id(), config.burn_address);
    match server.registry.forum().status(server.registry.expected_cbor_network(), policy, &body) {
        Ok(frame) => forum_bytes(frame),
        Err(error) => forum_error(error),
    }
}

fn forum_query(
    raw: Option<&str>,
    discovery: bool,
) -> crate::store::forum::Result<(crate::forum::Query, Option<Vec<u8>>)> {
    use crate::store::forum::invalid;
    let mut fields = std::collections::BTreeMap::new();
    // Bound encoded input before URL decoding and cursor allocation.
    if raw.unwrap_or("").len() > 8192 {
        return Err(invalid("query exceeds bound"));
    }
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = forum_query_component(key)?;
        let value = forum_query_component(value)?;
        let allowed = if discovery {
            key == "cursor"
        } else {
            matches!(key.as_str(), "topic" | "since" | "cursor")
        };
        if !allowed || fields.insert(key, value).is_some() {
            return Err(invalid("duplicate or unknown query field"));
        }
    }
    let cursor = fields
        .remove("cursor")
        .map(|value| {
            frank_cbor::forum_cursor_from_transport(&value)
                .map(|cursor| cursor.bytes)
                .map_err(invalid)
        })
        .transpose()?;
    let query = if discovery {
        crate::forum::Query::Discovery
    } else {
        let topic = fields
            .remove("topic")
            .ok_or_else(|| invalid("topic required"))?;
        if topic.is_empty() || topic.len() > 512 {
            return Err(invalid("topic byte bound"));
        }
        let since = fields.remove("since").unwrap_or_else(|| "0".into());
        let digits = since.strip_prefix('-').unwrap_or(&since);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("invalid signed milliseconds"));
        }
        let millis = since.parse::<i64>().map_err(invalid)?;
        crate::forum::Query::Topic {
            topic,
            since: frank_cbor::Timestamp {
                seconds: millis.div_euclid(1000),
                nanoseconds: (millis.rem_euclid(1000) * 1_000_000) as u32,
            },
        }
    };
    Ok((query, cursor))
}

fn forum_query_component(raw: &str) -> crate::store::forum::Result<String> {
    use crate::store::forum::invalid;
    let mut decoded = Vec::with_capacity(raw.len());
    let mut input = raw.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        decoded.push(match byte {
            b'+' => b' ',
            b'%' => {
                let hi = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(|| invalid("malformed query escape"))?;
                let lo = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(|| invalid("malformed query escape"))?;
                ((hi << 4) | lo) as u8
            }
            other => other,
        });
    }
    String::from_utf8(decoded).map_err(invalid)
}


pub async fn handle_list_monad_topic_posts(RawQuery(raw): RawQuery, Extension(server): Extension<RegistryServer>, headers: HeaderMap) -> Response {
    if !topic_accepts(&headers, "application/cbor") {
        return request_error(StatusCode::NOT_ACCEPTABLE, "topic_not_acceptable", "canonical Forum offers application/cbor");
    }
    forum_page(&server.registry, raw.as_deref(), false)
}

pub async fn handle_list_topics(RawQuery(raw): RawQuery, Extension(server): Extension<RegistryServer>, headers: HeaderMap) -> Response {
    if !topic_accepts(&headers, "application/cbor") {
        return request_error(StatusCode::NOT_ACCEPTABLE, "topic_not_acceptable", "canonical Forum offers application/cbor");
    }
    forum_page(&server.registry, raw.as_deref(), true)
}

fn forum_page(registry: &Registry, raw: Option<&str>, discovery: bool) -> Response {
    let (query, cursor) = match forum_query(raw, discovery) {
        Ok(value) => value,
        Err(error) => return forum_error(error),
    };
    let Ok(config) = monad_topic_gate().as_ref() else {
        return forum_error(crate::store::forum::ForumError::Unavailable);
    };
    let policy = crate::forum::policy(registry.expected_monad_chain_id(), config.burn_address);
    match registry.forum().page(
        registry.expected_cbor_network(),
        policy,
        query,
        cursor.as_deref(),
    ) {
        Ok(frame) => forum_bytes(frame),
        Err(error) => forum_error(error),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use bitcoinsuite_core::{Net, Sha256};
    use frank_cbor::{cbor_map, encode_frame, CborValue, EnvelopeFields, FramePayload};
    use serde_json::Value;
    use tempdir::TempDir;

    use super::*;
    use crate::{
        monad_evm_tx::decode_signed_transaction,
        monad_http::MonadRpcError,
        store::db::Db,
    };
    use cashweb_payload::chain_adapter::{ChainAdapter, MempoolAcceptResult, SubmitTxOutcome};

    /// [`ChainAdapter`] stub, mirroring `http::monad_message`'s test support: never touched by
    /// the topic path.
    #[derive(Debug)]
    struct UnusedChainAdapter;

    #[async_trait]
    impl ChainAdapter for UnusedChainAdapter {
        async fn submit_tx(&self, _raw_tx: &[u8]) -> bitcoinsuite_error::Result<SubmitTxOutcome> {
            unimplemented!("not used by the topic path")
        }
        async fn get_tx(
            &self,
            _txid: &bitcoinsuite_core::Sha256d,
        ) -> bitcoinsuite_error::Result<Option<Vec<u8>>> {
            unimplemented!("not used by the topic path")
        }
        async fn test_accept(
            &self,
            _raw_tx: &[u8],
        ) -> bitcoinsuite_error::Result<MempoolAcceptResult> {
            unimplemented!("not used by the topic path")
        }
        async fn subscribe_new_blocks(
            &self,
        ) -> bitcoinsuite_error::Result<tokio::sync::mpsc::Receiver<bitcoinsuite_core::Sha256d>>
        {
            unimplemented!("not used by the topic path")
        }
        fn decode_burn(
            &self,
            _commitment_id: [u8; 4],
            _burn_output_script: &bitcoinsuite_core::Script,
        ) -> bitcoinsuite_error::Result<Sha256> {
            unimplemented!("not used by the topic path")
        }
    }

    fn test_registry() -> (TempDir, Registry) {
        let tempdir = TempDir::new("cashweb-registry--topic-http-route").unwrap();
        let db = Db::open(tempdir.path().join("db.rocksdb")).unwrap();
        let registry = Registry::new(db, Arc::new(UnusedChainAdapter), Net::Regtest);
        (tempdir, registry)
    }

    fn burn_address() -> Address {
        Address([0x44; 20])
    }

    fn hex_hash(byte: u8) -> String {
        format!("0x{}", hex::encode([byte; 32]))
    }

    fn cbor_frame(type_id: u32, payload: CborValue) -> Vec<u8> {
        encode_frame(
            EnvelopeFields {
                type_id,
                schema_version: 1,
                min_reader_version: 1,
            },
            FramePayload::Value(&payload),
        )
        .unwrap()
    }

    fn cbor_submission(post_frame: &[u8], burn_tx: &[u8]) -> Vec<u8> {
        cbor_frame(
            10,
            cbor_map(vec![
                (0, CborValue::Text("monad-testnet".to_string())),
                (1, CborValue::Bytes(post_frame.to_vec())),
                (2, CborValue::Bytes(burn_tx.to_vec())),
            ]),
        )
    }

    #[derive(Clone, Default)]
    struct MockTransport {
        responses: Arc<Mutex<HashMap<String, Value>>>,
        call_count: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl MockTransport {
        fn set(&self, method: &str, response: Value) -> &Self {
            self.responses
                .lock()
                .unwrap()
                .insert(method.to_string(), response);
            self
        }

        fn call_count(&self) -> usize {
            self.call_count.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl fmt::Debug for MockTransport {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("MockTransport").finish()
        }
    }

    #[async_trait]
    impl JsonRpcTransport for MockTransport {
        async fn call(&self, method: &str, _params: Value) -> Result<Value, MonadRpcError> {
            self.call_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if method == "eth_sendRawTransaction" {
                // Defaults to hash 0x11 (matching the receipt/tx fixtures below), but tests that
                // need a *distinct* broadcast tx hash (e.g. to prove multiple votes tally
                // separately rather than colliding on `DbMonadTopicVotes`' tx_hash-keyed dedup) can
                // `set("eth_sendRawTransaction", ...)` to override it.
                return Ok(self
                    .responses
                    .lock()
                    .unwrap()
                    .get(method)
                    .cloned()
                    .unwrap_or_else(|| Value::String(hex_hash(0x11))));
            }
            self.responses
                .lock()
                .unwrap()
                .get(method)
                .cloned()
                .ok_or_else(|| MonadRpcError::InvalidResponse {
                    method: method.to_string(),
                    reason: "no mock response configured".to_string(),
                })
        }
    }

    #[test]
    fn forum_query_rejects_cross_family_unknown_duplicate_and_lossy_time_inputs() {
        assert!(forum_query(Some("topic=%ff"), false).is_err());
        assert!(forum_query(Some("topic=%"), false).is_err());
        assert!(forum_query(Some("topic=x&topic=y"), false).is_err());
        assert!(forum_query(Some("topic=x&since=9007199254740993&extra=1"), false).is_err());
        assert!(forum_query(Some("topic=x"), true).is_err());
        assert!(forum_query(Some("topic=x&since=1.0"), false).is_err());
        let (query, _) = forum_query(Some("topic=x&since=-1"), false).unwrap();
        assert_eq!(
            query,
            crate::forum::Query::Topic {
                topic: "x".into(),
                since: frank_cbor::Timestamp {
                    seconds: -1,
                    nanoseconds: 999_000_000
                }
            }
        );
        let (query, _) = forum_query(Some("topic=x&since=9007199254740993"), false).unwrap();
        assert_eq!(
            query,
            crate::forum::Query::Topic {
                topic: "x".into(),
                since: frank_cbor::Timestamp {
                    seconds: 9_007_199_254_740,
                    nanoseconds: 993_000_000
                }
            }
        );
    }

    #[tokio::test]
    async fn forum_over_ceiling_and_post_down_burn_reject_before_admission_or_rpc() {
        use crate::store::forum::tests::{observation, observation_with_amount};
        let (directory, registry) = test_registry();
        let transport = MockTransport::default();
        let over = observation_with_amount(0, None, false, i64::MAX as u128 + 1);
        let response = forum_submission(&registry, &transport, burn_address(), over.frame(), true)
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(transport.call_count(), 0);
        assert!(!directory.path().join("db.rocksdb.forum-cbor-v1").exists());
        let post = observation(1, None, false);
        let vote = observation(2, Some(*post.event.target_hash()), true);
        let TopicEvent::Post(post) = post.event else {
            panic!()
        };
        let frame = cbor_submission(&post.post_frame, vote.event.burn_tx());
        let response = forum_submission(&registry, &transport, burn_address(), &frame, true)
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(transport.call_count(), 0);
        assert!(!directory.path().join("db.rocksdb.forum-cbor-v1").exists());
    }

    #[tokio::test]
    async fn forum_receipt_sender_mismatch_keeps_pending_exact_operation() {
        use crate::store::forum::tests::observation;
        let (_directory, registry) = test_registry();
        let op = observation(0, None, false);
        let hash = op.checked.decoded.tx_hash.to_hex();
        let transport = MockTransport::default();
        transport.set("eth_sendRawTransaction", Value::String(hash.clone()));
        transport.set("eth_getTransactionReceipt",serde_json::json!({"transactionHash":hash,"blockHash":hex_hash(2),"blockNumber":"0x0","transactionIndex":"0x0","from":Address([9;20]).to_hex(),"to":burn_address().to_hex(),"contractAddress":null,"gasUsed":"0x5208","status":"0x1","logs":[]}));
        transport.set("eth_getTransactionByHash",serde_json::json!({"hash":hash,"from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"value":"0x7","input":format!("0x{}",hex::encode(&op.checked.decoded.input))}));
        let response = forum_submission(&registry, &transport, burn_address(), op.frame(), true)
            .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let policy = crate::forum::policy(10143, burn_address());
        let status = registry
            .forum()
            .status("monad-testnet", policy, op.frame())
            .unwrap();
        let frank_cbor::ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&status, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let frank_cbor::TypedPayload::ForumOperationStatus(status) =
            parsed.typed.as_deref().unwrap()
        else {
            panic!()
        };
        assert_eq!(status.evidence, frank_cbor::ForumOperationEvidence::Pending);
        assert!(!registry
            .forum()
            .contains("monad-testnet", policy, op.event.target_hash())
            .unwrap());
    }

    #[tokio::test]
    async fn forum_retained_vote_missing_post_is_unavailable() {
        const CHILD: &str = "FRANK_FORUM_CORRUPT_REBUILD_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .env(CHILD, "1")
                .args([
                    "--exact",
                    "http::monad_topics::tests::forum_retained_vote_missing_post_is_unavailable",
                    "--nocapture",
                ])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use crate::store::forum::{
            tests::{facts, observation},
            Store,
        };
        use frank_cbor::Timestamp;
        use tower::ServiceExt;
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1/");
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
        let (healthy_directory, healthy_registry) = test_registry();
        let healthy = test_server(healthy_registry).into_router();
        let unknown = observation(3, Some([0xaa; 32]), false);
        for (method, path, bytes) in [
            (
                "GET",
                format!("/message/monad/topics/{}", hex::encode([0xaa; 32])),
                Vec::new(),
            ),
            (
                "PUT",
                "/message/monad/topics/vote".into(),
                unknown.frame().to_vec(),
            ),
        ] {
            let response = healthy
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header(CONTENT_TYPE, "application/cbor")
                        .header(ACCEPT, "application/cbor")
                        .body(axum::body::Body::from(bytes))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "healthy unknown target remains 404 before RPC"
            );
        }
        assert!(
            !Store::path(&healthy_directory.path().join("db.rocksdb"))
                .unwrap()
                .exists(),
            "unknown targets must not create Forum obligations"
        );
        drop(healthy);
        let (directory, registry) = test_registry();
        let legacy = directory.path().join("db.rocksdb");
        let policy = crate::forum::policy(10143, burn_address());
        let post = observation(0, None, false);
        let vote = observation(1, Some(*post.event.target_hash()), true);
        let at = Timestamp {
            seconds: 200,
            nanoseconds: 0,
        };
        let mut store = Store::open(&legacy, "monad-testnet", policy).unwrap();
        for op in [&post, &vote] {
            store.admit(op.clone()).unwrap();
            store
                .confirm(&op.checked.decoded.tx_hash.0, &facts(op, 10, 0), at)
                .unwrap();
        }
        drop(store);
        let mut vote_key = vec![b'e'];
        vote_key.extend(vote.checked.decoded.tx_hash.0);
        let retained;
        {
            let db = rocksdb::DB::open_default(Store::path(&legacy).unwrap()).unwrap();
            retained = db.get(&vote_key).unwrap().unwrap();
            let mut key = vec![b'e'];
            key.extend(post.checked.decoded.tx_hash.0);
            db.delete(key).unwrap();
            db.flush().unwrap();
        }
        let router = test_server(registry).into_router();
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/message/monad/topics/{}",
                        hex::encode(post.event.target_hash())
                    ))
                    .header(ACCEPT, "application/cbor")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = hyper::body::to_bytes(response.into_body()).await.unwrap();
        drop(router);
        let db = rocksdb::DB::open_default(Store::path(&legacy).unwrap()).unwrap();
        assert_eq!(
            db.get(&vote_key).unwrap().unwrap(),
            retained,
            "retained authority must not be rewritten"
        );
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            String::from_utf8_lossy(&body)
        );
        assert!(String::from_utf8_lossy(&body).contains("forum_unavailable"));
    }

    #[tokio::test]
    async fn forum_actual_router_post_vote_read_status_and_restart() {
        // A fresh process isolates the existing process-wide environment gate. No
        // other test sees a changed RPC URL, and no external chain is contacted.
        const CHILD: &str = "FRANK_FORUM_ROUTER_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output=std::process::Command::new(std::env::current_exe().unwrap())
                .env(CHILD,"1").args(["--exact","http::monad_topics::tests::forum_actual_router_post_vote_read_status_and_restart","--nocapture"])
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use crate::store::forum::tests::observation;
        use frank_cbor::{ForumOperationEvidence, TypedPayload, ValidationResult};
        use tower::ServiceExt;
        let post = observation(0, None, false);
        let vote = observation(1, Some(*post.event.target_hash()), true);
        let unknown = observation(2, None, false);
        let ops = Arc::new(vec![post.clone(), vote.clone()]);
        let rpc_ops = ops.clone();
        let rpc=axum::Router::new().route("/",axum::routing::post(move |Json(request):Json<Value>| {
            let ops=rpc_ops.clone(); async move {
                let method=request["method"].as_str().unwrap();
                let hash=if method=="eth_sendRawTransaction" {
                    let raw=hex::decode(request["params"][0].as_str().unwrap().trim_start_matches("0x")).unwrap();
                    decode_signed_transaction(&raw).unwrap().tx_hash.to_hex()
                }else{request["params"][0].as_str().unwrap().to_string()};
                let op=ops.iter().find(|op|op.checked.decoded.tx_hash.to_hex()==hash);
                let result=match (method,op) {
                    ("eth_sendRawTransaction",Some(_))=>Value::String(hash.clone()),
                    ("eth_getTransactionReceipt",Some(op))=>serde_json::json!({"transactionHash":hash,"blockHash":hex_hash(0x22),"blockNumber":"0x1","transactionIndex":"0x0","from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"contractAddress":null,"gasUsed":"0x5208","status":"0x1","logs":[]}),
                    ("eth_getTransactionByHash",Some(op))=>serde_json::json!({"hash":hash,"from":op.checked.decoded.sender.to_hex(),"to":burn_address().to_hex(),"value":"0x7","input":format!("0x{}",hex::encode(&op.checked.decoded.input))}),
                    _=>Value::Null,
                };
                Json(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
            }
        }));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", format!("http://{address}/"));
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
        let task = tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(rpc.into_make_service()),
        );
        let (directory, registry) = test_registry();
        let mut router = test_server(registry).into_router();
        async fn call(router: &axum::Router, method: &str, path: &str, bytes: &[u8]) -> Vec<u8> {
            let response = router
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .header(CONTENT_TYPE, "application/cbor")
                        .header(ACCEPT, "application/cbor")
                        .body(axum::body::Body::from(bytes.to_vec()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = hyper::body::to_bytes(response.into_body())
                .await
                .unwrap()
                .to_vec();
            assert_eq!(
                status,
                StatusCode::OK,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
            let ValidationResult::Parsed(_) =
                frank_cbor::validate_frame(&bytes, &frank_cbor::default_context()).unwrap()
            else {
                panic!()
            };
            bytes
        }
        let submitted = call(&router, "PUT", "/message/monad/topics", post.frame()).await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&submitted, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumOperationStatus(status) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert!(matches!(
            status.evidence,
            ForumOperationEvidence::Confirmed { .. }
        ));
        call(&router, "PUT", "/message/monad/topics/vote", vote.frame()).await;
        let hash = hex::encode(post.event.target_hash());
        call(
            &router,
            "GET",
            &format!("/message/monad/topics/{hash}"),
            &[],
        )
        .await;
        call(
            &router,
            "GET",
            "/message/monad/topics?topic=test.topic&since=0",
            &[],
        )
        .await;
        call(&router, "GET", "/message/monad/topics/discover", &[]).await;
        let response = call(
            &router,
            "POST",
            "/message/monad/topics/status",
            unknown.frame(),
        )
        .await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&response, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumOperationStatus(status) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert_eq!(status.evidence, ForumOperationEvidence::UnknownRequest);
        drop(router);
        let registry = Registry::new(
            Db::open(directory.path().join("db.rocksdb")).unwrap(),
            Arc::new(UnusedChainAdapter),
            Net::Regtest,
        );
        router = test_server(registry).into_router();
        call(
            &router,
            "POST",
            "/message/monad/topics/status",
            post.frame(),
        )
        .await;
        call(&router, "PUT", "/message/monad/topics", post.frame()).await;
        let view = call(
            &router,
            "GET",
            &format!("/message/monad/topics/{hash}"),
            &[],
        )
        .await;
        let ValidationResult::Parsed(parsed) =
            frank_cbor::validate_frame(&view, &frank_cbor::default_context()).unwrap()
        else {
            panic!()
        };
        let TypedPayload::ForumView(view) = parsed.typed.as_deref().unwrap() else {
            panic!()
        };
        assert_eq!(view.aggregate.magnitude, [0; 32]);
        task.abort();
    }

    fn isolated(name: &str, key: &str) -> bool {
        if std::env::var_os(key).is_some() { return false; }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .env(key, "1").args(["--exact", name, "--nocapture"]).output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        true
    }

    fn configure_reads() {
        std::env::set_var("MONAD_TESTNET_HTTP_RPC_URL", "http://127.0.0.1:1/");
        std::env::set_var("MONAD_STAMP_BURN_ADDRESS", burn_address().to_hex());
        std::env::set_var("FRANK_NETWORK_TAG", "MONT");
    }

    #[test]
    fn canonical_media_rejects_predecessors_without_body_sniffing() {
        for declared in [None, Some("application/x-protobuf"), Some("application/x-protobuf; charset=binary"), Some("application/cbor; charset=binary"), Some("application/octet-stream")] {
            let mut headers = HeaderMap::new();
            if let Some(declared) = declared { headers.insert(CONTENT_TYPE, declared.parse().unwrap()); }
            assert_eq!(write_headers(&headers, b"FRNK").unwrap().status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, "application/cbor".parse().unwrap());
        for accept in ["application/x-protobuf", "application/cbor;q=0, */*;q=1", "application/cbor;profile=next"] {
            headers.insert(ACCEPT, accept.parse().unwrap());
            assert_eq!(write_headers(&headers, b"FRNK").unwrap().status(), StatusCode::NOT_ACCEPTABLE);
        }
        headers.insert(ACCEPT, "application/cbor;q=1;ext=next".parse().unwrap());
        assert!(write_headers(&headers, b"FRNK").is_none());
        let body = vec![0; MAX_TOPIC_EVENT_FRAME_BYTES as usize + 1];
        assert_eq!(write_headers(&headers, &body).unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn historical_topic_rows_remain_retained_without_normal_route_reachability() {
        if isolated("http::monad_topics::tests::historical_topic_rows_remain_retained_without_normal_route_reachability", "FRANK_FORUM_RETENTION_ROUTE_CHILD") { return; }
        configure_reads();
        use crate::proto;
        use tower::ServiceExt;
        let (dir, registry) = test_registry();
        let hash = [0xab;32];
        let stored = proto::StoredMonadTopicPost {
            post: Some(proto::MonadTopicPost { topic: "old.topic".into(), parent_post_hash: vec![], raw_burn_tx: vec![1,2,3], encrypted_payload: vec![4,5,6], payload_hash: hash.to_vec() }),
            sender_address: vec![9;20], tx_hash: vec![8;32], timestamp: 500,
            network_tag: vec![], cbor_post_frame: vec![], confirmed_block_number: 0, confirmed_transaction_index: 0,
        };
        registry.put_monad_topic_post(&hash, stored.clone(), &[]).unwrap();
        let router = test_server(registry).into_router();
        for accept in ["application/cbor", "application/x-protobuf"] {
            let response = router.clone().oneshot(axum::http::Request::builder()
                .uri(format!("/message/monad/topics/{}", hex::encode(hash))).header(ACCEPT, accept)
                .body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), if accept == "application/cbor" { StatusCode::NOT_FOUND } else { StatusCode::NOT_ACCEPTABLE });
            assert!(response.headers().get_all(VARY).iter().any(|v|v.as_bytes().eq_ignore_ascii_case(b"accept")));
        }
        for path in ["/message/monad/topics?topic=old.topic", "/message/monad/topics/discover"] {
            let response = router.clone().oneshot(axum::http::Request::builder().uri(path)
                .header(ACCEPT, "application/cbor").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let frame=hyper::body::to_bytes(response.into_body()).await.unwrap();
            let frank_cbor::ValidationResult::Parsed(parsed)=frank_cbor::validate_frame(&frame,&frank_cbor::default_context()).unwrap() else {panic!()};
            match parsed.typed.as_deref().unwrap() {
                frank_cbor::TypedPayload::ForumTopicPage(page)=>assert!(page.rows.is_empty()),
                frank_cbor::TypedPayload::ForumDiscoveryPage(page)=>assert!(page.entries.is_empty()),
                _=>panic!("canonical family required"),
            }
        }
        drop(router);
        let registry=Registry::new(Db::open(dir.path().join("db.rocksdb")).unwrap(),Arc::new(UnusedChainAdapter),Net::Regtest);
        assert_eq!(registry.get_monad_topic_post(&hash).unwrap().unwrap(),stored,"HTTP cutover must not delete predecessor authority");
    }

    #[tokio::test]
    async fn actual_router_restart_returns_410_for_both_old_cursor_families() {
        if isolated("http::monad_topics::tests::actual_router_restart_returns_410_for_both_old_cursor_families", "FRANK_FORUM_CURSOR_HTTP_CHILD") { return; }
        configure_reads();
        use crate::store::forum::{Store, tests::{distinct_post, facts}};
        use frank_cbor::{Timestamp, TypedPayload, ValidationResult};
        use tower::ServiceExt;
        let (dir, registry)=test_registry();
        let legacy=dir.path().join("db.rocksdb");
        let mut store=Store::open(&legacy,"monad-testnet",crate::forum::policy(10143,burn_address())).unwrap();
        for i in 0..129 {
            for op in [distinct_post(i,"test.topic"),distinct_post(1000+i,&format!("topic.{i:03}"))] {
                store.admit(op.clone()).unwrap();
                store.confirm(&op.checked.decoded.tx_hash.0,&facts(&op,i,0),Timestamp{seconds:200,nanoseconds:0}).unwrap();
            }
        }
        drop(store);
        let router=test_server(registry).into_router();
        let paths=["/message/monad/topics?topic=test.topic&since=0","/message/monad/topics/discover"];
        let mut continuations=Vec::new();
        for path in paths {
            let response=router.clone().oneshot(axum::http::Request::builder().uri(path)
                .header(ACCEPT,"application/cbor").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),StatusCode::OK);
            let bytes=hyper::body::to_bytes(response.into_body()).await.unwrap();
            let ValidationResult::Parsed(parsed)=frank_cbor::validate_frame(&bytes,&frank_cbor::default_context()).unwrap() else{panic!()};
            let cursor=match parsed.typed.as_deref().unwrap(){
                TypedPayload::ForumTopicPage(page)=>page.next_cursor.as_ref().unwrap().bytes.clone(),
                TypedPayload::ForumDiscoveryPage(page)=>page.next_cursor.as_ref().unwrap().bytes.clone(),
                _=>panic!(),
            };
            let encoded=frank_cbor::forum_cursor_to_transport(&cursor).unwrap();
            let continuation=format!("{path}{}cursor={encoded}",if path.contains('?'){"&"}else{"?"});
            let response=router.clone().oneshot(axum::http::Request::builder().uri(&continuation)
                .header(ACCEPT,"application/cbor").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),StatusCode::OK,"retained cursor must work before restart");
            continuations.push(continuation);
        }
        drop(router);
        let registry=Registry::new(Db::open(&legacy).unwrap(),Arc::new(UnusedChainAdapter),Net::Regtest);
        let router=test_server(registry).into_router();
        for continuation in continuations {
            let response=router.clone().oneshot(axum::http::Request::builder().uri(continuation)
                .header(ACCEPT,"application/cbor").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),StatusCode::GONE,"actual restarted Owner must reject old retained incarnation at public HTTP");
            let body=hyper::body::to_bytes(response.into_body()).await.unwrap();
            assert!(String::from_utf8_lossy(&body).contains("forum_cursor_expired"));
        }
    }

    fn test_server(registry: Registry) -> RegistryServer {
        use crate::{p2p::peers::Peers, test_instance::placeholder_pop_conf};

        let pop_gate =
            crate::http::pop_protection::PopGate::from_conf_if_enabled(&placeholder_pop_conf());
        RegistryServer {
            registry: Arc::new(registry),
            peers: Arc::new(Peers::new("http://127.0.0.1:1".to_string(), vec![])),
            pop_gate: Arc::new(pop_gate),
            // No curated defaults needed by this route's tests (ticket #49, merged after this
            // helper was originally written).
            curated_defaults: Arc::new(vec![]),
            monad_mailbox: crate::monad_mailbox::MonadMailboxRuntime::Disabled,
            evm_rpc: None,
            bitcoin_proxy: None,
        }
    }

}
