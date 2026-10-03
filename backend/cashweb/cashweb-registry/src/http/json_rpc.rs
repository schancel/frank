use std::{
    collections::HashSet,
    fmt,
    fs::File,
    io::{BufRead, BufReader},
    ops::Range,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll, Waker},
};

use axum::{
    body::{boxed, Body, BoxBody, Bytes, HttpBody},
    response::Response,
};
use futures::stream;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use tempfile::TempPath;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::OwnedSemaphorePermit,
    time::Duration,
};

const MAX_ENVELOPE_KEY_BYTES: usize = 128;
const MAX_RPC_ID_BYTES: usize = 256;
const MAX_ENVELOPE_FIELDS: usize = 32;
const MAX_JSON_DEPTH: usize = 128;

#[derive(Debug, thiserror::Error)]
pub(crate) enum StreamInspectError {
    #[error("invalid JSON-RPC response")]
    Invalid,
    #[error("JSON-RPC response contains an oversized envelope token")]
    TokenTooLarge,
    #[error("failed to read JSON-RPC response spool")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Default)]
pub(crate) struct InspectedResponse {
    /// Byte ranges containing non-null provider-controlled `error` values.
    pub(crate) error_rewrites: Vec<ErrorRewrite>,
}

#[derive(Debug)]
pub(crate) struct ErrorRewrite {
    range: Range<u64>,
    replacement: Bytes,
}

pub(crate) struct ResponseSpool {
    path: TempPath,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum SpoolError {
    #[error("upstream response exceeded its decoded-byte limit")]
    TooLarge,
    #[error("upstream response stalled")]
    Timeout,
    #[error("upstream response I/O failed")]
    Io,
}

struct SpoolStreamState {
    file: tokio::fs::File,
    _path: TempPath,
    rewrites: std::vec::IntoIter<ErrorRewrite>,
    next_rewrite: Option<ErrorRewrite>,
    position: u64,
}

struct CancelInspection {
    cancelled: Arc<AtomicBool>,
    armed: bool,
}

impl Drop for CancelInspection {
    fn drop(&mut self) {
        if self.armed {
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JsonRpcVersion {
    Legacy,
    V2,
}

#[derive(Debug)]
pub(crate) struct RequestCorrelation {
    pub(crate) ids: Vec<Value>,
    pub(crate) is_batch: bool,
}

struct PermitBody {
    state: Arc<Mutex<PermitBodyState>>,
}

struct PermitBodyState {
    inner: Option<BoxBody>,
    permit: Option<OwnedSemaphorePermit>,
    waker: Option<Waker>,
}

impl Drop for PermitBody {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.inner.take();
        state.permit.take();
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    }
}

impl HttpBody for PermitBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_data(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Self::Data, Self::Error>>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(inner) = state.inner.as_mut() else {
            return Poll::Ready(None);
        };
        let result = Pin::new(inner).poll_data(cx);
        match &result {
            Poll::Pending => state.waker = Some(cx.waker().clone()),
            // Keep the body alive through `poll_trailers`; dropping it here would silently
            // discard legitimate upstream trailers. Consumers that do not poll trailers still
            // release everything when they drop the body (or when the delivery timer expires).
            Poll::Ready(None) => {
                state.waker.take();
            }
            Poll::Ready(Some(_)) => {}
        }
        result
    }

    fn poll_trailers(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Option<axum::http::HeaderMap>, Self::Error>> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let Some(inner) = state.inner.as_mut() else {
            return Poll::Ready(Ok(None));
        };
        let result = Pin::new(inner).poll_trailers(cx);
        match &result {
            Poll::Pending => state.waker = Some(cx.waker().clone()),
            Poll::Ready(_) => {
                state.inner.take();
                state.permit.take();
                state.waker.take();
            }
        }
        result
    }
}

/// Keep upstream admission charged until the downstream response body is
/// completely consumed or dropped by the transport, subject to a hard total
/// delivery lifetime that also drops any owned response spool.
pub(crate) fn hold_response_permit(
    response: Response,
    permit: OwnedSemaphorePermit,
    delivery_timeout: Duration,
) -> Response {
    let (parts, body) = response.into_parts();
    let state = Arc::new(Mutex::new(PermitBodyState {
        inner: Some(body),
        permit: Some(permit),
        waker: None,
    }));
    let expiry_state = Arc::clone(&state);
    tokio::spawn(async move {
        tokio::time::sleep(delivery_timeout).await;
        let mut state = expiry_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.inner.take();
        state.permit.take();
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    });
    Response::from_parts(parts, boxed(PermitBody { state }))
}

/// Decode and spool an upstream response under a strict byte ceiling.
///
/// Reqwest applies configured content decoding before yielding chunks, so the
/// limit applies to the representation inspected and delivered to the client.
pub(crate) async fn spool_response(
    mut response: reqwest::Response,
    max_bytes: usize,
    idle_timeout: Duration,
) -> Result<ResponseSpool, SpoolError> {
    let named = tempfile::NamedTempFile::new().map_err(|_| SpoolError::Io)?;
    let (file, path) = named.into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let mut len = 0u64;
    loop {
        let chunk = tokio::time::timeout(idle_timeout, response.chunk())
            .await
            .map_err(|_| SpoolError::Timeout)?
            .map_err(|_| SpoolError::Io)?;
        let Some(chunk) = chunk else {
            break;
        };
        len = len
            .checked_add(chunk.len() as u64)
            .ok_or(SpoolError::TooLarge)?;
        if len > max_bytes as u64 {
            return Err(SpoolError::TooLarge);
        }
        file.write_all(&chunk).await.map_err(|_| SpoolError::Io)?;
    }
    file.flush().await.map_err(|_| SpoolError::Io)?;
    drop(file);
    Ok(ResponseSpool { path })
}

impl ResponseSpool {
    pub(crate) async fn inspect(
        &self,
        version: JsonRpcVersion,
        correlation: RequestCorrelation,
    ) -> Result<InspectedResponse, StreamInspectError> {
        let path = self.path.to_path_buf();
        let cancelled = Arc::new(AtomicBool::new(false));
        let task_cancelled = Arc::clone(&cancelled);
        let mut cancel_on_drop = CancelInspection {
            cancelled,
            armed: true,
        };
        let result = tokio::task::spawn_blocking(move || {
            inspect_spooled_response_with_cancel(&path, version, &correlation, Some(task_cancelled))
        })
        .await
        .map_err(|_| StreamInspectError::Invalid)?;
        cancel_on_drop.armed = false;
        result
    }

    pub(crate) async fn into_body(
        self,
        error_rewrites: Vec<ErrorRewrite>,
    ) -> Result<Body, std::io::Error> {
        let file = tokio::fs::File::open(&self.path).await?;
        let state = SpoolStreamState {
            file,
            _path: self.path,
            rewrites: error_rewrites.into_iter(),
            next_rewrite: None,
            position: 0,
        };
        let stream = stream::try_unfold(state, |mut state| async move {
            if state.next_rewrite.is_none() {
                state.next_rewrite = state.rewrites.next();
            }
            if state
                .next_rewrite
                .as_ref()
                .is_some_and(|rewrite| state.position == rewrite.range.start)
            {
                if let Some(rewrite) = state.next_rewrite.take() {
                    let end = rewrite.range.end;
                    state.file.seek(std::io::SeekFrom::Start(end)).await?;
                    state.position = end;
                    return Ok(Some((rewrite.replacement, state)));
                }
            }
            let remaining = state
                .next_rewrite
                .as_ref()
                .map(|rewrite| rewrite.range.start.saturating_sub(state.position))
                .unwrap_or(64 * 1024);
            if remaining == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "overlapping JSON-RPC rewrite ranges",
                ));
            }
            let mut buffer = vec![0u8; usize::try_from(remaining.min(64 * 1024)).unwrap()];
            let read = state.file.read(&mut buffer).await?;
            if read == 0 {
                return Ok(None);
            }
            buffer.truncate(read);
            state.position += read as u64;
            Ok(Some((Bytes::from(buffer), state)))
        });
        Ok(Body::wrap_stream(stream))
    }
}

pub(crate) fn request_correlation(bytes: &[u8]) -> Result<RequestCorrelation, ()> {
    let value = parse_without_duplicate_keys(bytes).map_err(|_| ())?;
    let is_batch = value.is_array();
    let requests = match &value {
        Value::Array(requests) if !requests.is_empty() => requests.as_slice(),
        Value::Array(_) => return Err(()),
        request => std::slice::from_ref(request),
    };
    let mut ids = Vec::with_capacity(requests.len());
    for request in requests {
        let id = request
            .as_object()
            .and_then(|request| request.get("id"))
            .filter(|id| id.is_string() || id.is_number() || id.is_null())
            .ok_or(())?;
        if !rpc_id_is_bounded(id) {
            return Err(());
        }
        if ids.contains(id) {
            return Err(());
        }
        ids.push(id.clone());
    }
    Ok(RequestCorrelation { ids, is_batch })
}

pub(crate) fn rpc_id_is_bounded(id: &Value) -> bool {
    serde_json::to_vec(id).is_ok_and(|encoded| encoded.len() <= MAX_RPC_ID_BYTES)
}

/// Parse JSON while rejecting duplicate object members at every nesting level.
///
/// The proxy forwards the original bytes after policy validation. Rejecting
/// duplicates prevents the proxy and an upstream implementation from resolving
/// a security-relevant member, such as `method`, differently.
pub(crate) fn parse_without_duplicate_keys(bytes: &[u8]) -> serde_json::Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = UniqueValue::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    Ok(value)
}

/// Replace provider-controlled JSON-RPC error details with a stable envelope.
///
/// Success results and envelope keys are deliberately untouched: they are
/// protocol data and may legitimately contain short substrings that also occur
/// in an upstream credential.
pub(crate) fn sanitize_response_errors(value: &mut Value) {
    match value {
        Value::Array(responses) => {
            for response in responses {
                sanitize_response_error(response);
            }
        }
        response => sanitize_response_error(response),
    }
}

/// Check the response envelope shape without interpreting opaque result data.
pub(crate) fn is_response_envelope(value: &Value, version: JsonRpcVersion) -> bool {
    match value {
        Value::Array(responses) => {
            !responses.is_empty()
                && responses
                    .iter()
                    .all(|response| is_single_response_envelope(response, version))
        }
        response => is_single_response_envelope(response, version),
    }
}

/// Validate JSON-RPC 2.0 response shape and exact request-ID correlation.
pub(crate) fn response_matches_request(request: &[u8], response: &Value) -> bool {
    let Ok(request) = parse_without_duplicate_keys(request) else {
        return false;
    };
    let requests = match &request {
        Value::Array(requests) if !requests.is_empty() => requests.as_slice(),
        Value::Array(_) => return false,
        request => std::slice::from_ref(request),
    };
    let responses = match response {
        Value::Array(responses) if requests.len() > 1 && !responses.is_empty() => {
            responses.as_slice()
        }
        Value::Array(_) => return false,
        response if requests.len() == 1 => std::slice::from_ref(response),
        _ => return false,
    };
    if requests.len() != responses.len() {
        return false;
    }

    let mut expected = Vec::with_capacity(requests.len());
    for request in requests {
        let Some(id) = request.as_object().and_then(|request| request.get("id")) else {
            return false;
        };
        if expected.contains(id) {
            return false;
        }
        expected.push(id.clone());
    }
    for response in responses {
        if !is_single_response_envelope(response, JsonRpcVersion::V2) {
            return false;
        }
        let id = &response["id"];
        let Some(index) = expected.iter().position(|expected| expected == id) else {
            return false;
        };
        expected.swap_remove(index);
    }
    expected.is_empty()
}

fn is_single_response_envelope(value: &Value, version: JsonRpcVersion) -> bool {
    let Some(response) = value.as_object() else {
        return false;
    };
    if !response.contains_key("id") {
        return false;
    }
    let has_result = response.contains_key("result");
    let has_error = response.contains_key("error");
    if response
        .keys()
        .any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "result" | "error"))
    {
        return false;
    }
    match version {
        JsonRpcVersion::Legacy => {
            matches!(
                response.get("jsonrpc").and_then(Value::as_str),
                None | Some("1.0")
            ) && has_result
                && has_error
        }
        JsonRpcVersion::V2 => {
            response.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
                && (has_result ^ has_error)
        }
    }
}

fn sanitize_response_error(value: &mut Value) {
    let Some(response) = value.as_object_mut() else {
        return;
    };
    let Some(error) = response.get("error") else {
        return;
    };
    if error.is_null() {
        return;
    }

    let code = error
        .as_object()
        .and_then(|error| error.get("code"))
        .filter(|code| code.is_number())
        .cloned();
    let mut sanitized = Map::new();
    if let Some(code) = code {
        sanitized.insert("code".to_string(), code);
    }
    sanitized.insert(
        "message".to_string(),
        Value::String("upstream RPC error".to_string()),
    );
    response.insert("error".to_string(), Value::Object(sanitized));
}

/// Inspect a spooled JSON-RPC response without retaining opaque result values.
///
/// The scanner validates UTF-8, JSON structure, bounded envelope fields, and
/// exact request-ID correlation. It records only the byte ranges that must be
/// replaced to prevent provider-controlled error details reaching clients.
pub(crate) fn inspect_spooled_response(
    path: &Path,
    version: JsonRpcVersion,
    correlation: &RequestCorrelation,
) -> Result<InspectedResponse, StreamInspectError> {
    inspect_spooled_response_with_cancel(path, version, correlation, None)
}

fn inspect_spooled_response_with_cancel(
    path: &Path,
    version: JsonRpcVersion,
    correlation: &RequestCorrelation,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<InspectedResponse, StreamInspectError> {
    if correlation.ids.is_empty() {
        return Err(StreamInspectError::Invalid);
    }
    validate_spool_utf8(path, cancelled.as_deref())?;
    let file = File::open(path)?;
    let mut parser = ResponseParser {
        lexer: Lexer::new(BufReader::with_capacity(64 * 1024, file), cancelled),
        version,
        expected_ids: correlation.ids.clone(),
        is_batch: correlation.is_batch,
        error_rewrites: Vec::new(),
    };
    parser.parse()?;
    Ok(InspectedResponse {
        error_rewrites: parser.error_rewrites,
    })
}

fn validate_spool_utf8(
    path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(), StreamInspectError> {
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let mut pending = Vec::with_capacity(64 * 1024 + 3);
    loop {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Relaxed)) {
            return Err(StreamInspectError::Invalid);
        }
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            break;
        }
        pending.extend_from_slice(buffer);
        let consumed = buffer.len();
        reader.consume(consumed);
        match std::str::from_utf8(&pending) {
            Ok(_) => pending.clear(),
            Err(error) if error.error_len().is_none() => {
                let valid = error.valid_up_to();
                if pending.len().saturating_sub(valid) > 3 {
                    return Err(StreamInspectError::Invalid);
                }
                pending.drain(..valid);
            }
            Err(_) => return Err(StreamInspectError::Invalid),
        }
    }
    if pending.is_empty() {
        Ok(())
    } else {
        Err(StreamInspectError::Invalid)
    }
}

struct ResponseParser<R> {
    lexer: Lexer<R>,
    version: JsonRpcVersion,
    expected_ids: Vec<Value>,
    is_batch: bool,
    error_rewrites: Vec<ErrorRewrite>,
}

impl<R: BufRead> ResponseParser<R> {
    fn parse(&mut self) -> Result<(), StreamInspectError> {
        let expected_count = self.expected_ids.len();
        let first = self.lexer.next_token(false)?;
        match first.kind {
            TokenKind::LeftBrace if !self.is_batch => {
                let id = self.parse_response_object()?;
                self.consume_id(id)?;
            }
            TokenKind::LeftBracket if self.is_batch => {
                let mut count = 0usize;
                if self.lexer.peek_non_whitespace()? == Some(b']') {
                    return Err(StreamInspectError::Invalid);
                }
                loop {
                    self.lexer.expect_punctuation(TokenKind::LeftBrace)?;
                    let id = self.parse_response_object()?;
                    self.consume_id(id)?;
                    count += 1;
                    match self.lexer.next_token(false)?.kind {
                        TokenKind::Comma => continue,
                        TokenKind::RightBracket => break,
                        _ => return Err(StreamInspectError::Invalid),
                    }
                }
                if count != expected_count {
                    return Err(StreamInspectError::Invalid);
                }
            }
            _ => return Err(StreamInspectError::Invalid),
        }
        if !self.expected_ids.is_empty() || !self.lexer.is_eof()? {
            return Err(StreamInspectError::Invalid);
        }
        Ok(())
    }

    fn consume_id(&mut self, id: Value) -> Result<(), StreamInspectError> {
        let Some(index) = self
            .expected_ids
            .iter()
            .position(|expected| *expected == id)
        else {
            return Err(StreamInspectError::Invalid);
        };
        self.expected_ids.swap_remove(index);
        Ok(())
    }

    fn parse_response_object(&mut self) -> Result<Value, StreamInspectError> {
        let mut fields = HashSet::new();
        let mut id = None;
        let mut has_result = false;
        let mut has_error = false;
        let mut version = None;
        if self.lexer.peek_non_whitespace()? == Some(b'}') {
            self.lexer.expect_punctuation(TokenKind::RightBrace)?;
            return Err(StreamInspectError::Invalid);
        }
        loop {
            let key = self.lexer.next_token(true)?;
            let TokenKind::String(Some(key)) = key.kind else {
                return Err(StreamInspectError::Invalid);
            };
            if key.len() > MAX_ENVELOPE_KEY_BYTES
                || fields.len() >= MAX_ENVELOPE_FIELDS
                || !fields.insert(key.clone())
            {
                return Err(StreamInspectError::Invalid);
            }
            self.lexer.expect_punctuation(TokenKind::Colon)?;
            match key.as_str() {
                "jsonrpc" => {
                    let token = self.lexer.next_token(true)?;
                    let TokenKind::String(Some(value)) = token.kind else {
                        return Err(StreamInspectError::Invalid);
                    };
                    version = Some(value);
                }
                "id" => {
                    let token = self.lexer.next_token(true)?;
                    if token.end.saturating_sub(token.start) > MAX_RPC_ID_BYTES as u64 {
                        return Err(StreamInspectError::TokenTooLarge);
                    }
                    id = Some(token.rpc_id()?);
                }
                "result" => {
                    has_result = true;
                    let token = self.lexer.next_token(false)?;
                    self.lexer.skip_value(token, 0)?;
                }
                "error" => {
                    has_error = true;
                    let token = self.lexer.next_token(false)?;
                    let start = token.start;
                    let is_null = matches!(&token.kind, TokenKind::Null);
                    let code = self.lexer.parse_error_code(token, 0)?;
                    if !is_null {
                        let code = code.unwrap_or(-32000);
                        self.error_rewrites.push(ErrorRewrite {
                            range: start..self.lexer.offset,
                            replacement: Bytes::from(format!(
                                "{{\"code\":{code},\"message\":\"upstream RPC error\"}}"
                            )),
                        });
                    }
                }
                _ => return Err(StreamInspectError::Invalid),
            }
            match self.lexer.next_token(false)?.kind {
                TokenKind::Comma => continue,
                TokenKind::RightBrace => break,
                _ => return Err(StreamInspectError::Invalid),
            }
        }
        let id = id.ok_or(StreamInspectError::Invalid)?;
        match self.version {
            JsonRpcVersion::Legacy => {
                if !matches!(version.as_deref(), None | Some("1.0")) || !has_result || !has_error {
                    return Err(StreamInspectError::Invalid);
                }
            }
            JsonRpcVersion::V2 => {
                if version.as_deref() != Some("2.0") || !(has_result ^ has_error) {
                    return Err(StreamInspectError::Invalid);
                }
            }
        }
        Ok(id)
    }
}

#[derive(Debug, Eq, PartialEq)]
enum TokenKind {
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    Colon,
    Comma,
    String(Option<String>),
    Number(Option<String>),
    True,
    False,
    Null,
}

struct Token {
    kind: TokenKind,
    start: u64,
    end: u64,
}

impl Token {
    fn rpc_id(self) -> Result<Value, StreamInspectError> {
        let raw = match self.kind {
            TokenKind::String(Some(value)) => {
                serde_json::to_string(&value).map_err(|_| StreamInspectError::Invalid)?
            }
            TokenKind::Number(Some(value)) => value,
            TokenKind::Null => return Ok(Value::Null),
            _ => return Err(StreamInspectError::Invalid),
        };
        serde_json::from_str(&raw).map_err(|_| StreamInspectError::Invalid)
    }
}

struct Lexer<R> {
    reader: R,
    offset: u64,
    cancelled: Option<Arc<AtomicBool>>,
    next_cancel_check: u64,
}

impl<R: BufRead> Lexer<R> {
    fn new(reader: R, cancelled: Option<Arc<AtomicBool>>) -> Self {
        Self {
            reader,
            offset: 0,
            cancelled,
            next_cancel_check: 0,
        }
    }

    fn read_byte(&mut self) -> Result<Option<u8>, StreamInspectError> {
        if self.offset >= self.next_cancel_check {
            if self
                .cancelled
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::Relaxed))
            {
                return Err(StreamInspectError::Invalid);
            }
            self.next_cancel_check = self.offset.saturating_add(64 * 1024);
        }
        let buffer = self.reader.fill_buf()?;
        let byte = buffer.first().copied();
        if byte.is_some() {
            self.reader.consume(1);
            self.offset += 1;
        }
        Ok(byte)
    }

    fn peek_byte(&mut self) -> Result<Option<u8>, StreamInspectError> {
        Ok(self.reader.fill_buf()?.first().copied())
    }

    fn peek_non_whitespace(&mut self) -> Result<Option<u8>, StreamInspectError> {
        while matches!(self.peek_byte()?, Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.read_byte()?;
        }
        self.peek_byte()
    }

    fn is_eof(&mut self) -> Result<bool, StreamInspectError> {
        Ok(self.peek_non_whitespace()?.is_none())
    }

    fn next_token(&mut self, capture: bool) -> Result<Token, StreamInspectError> {
        let Some(first) = self.peek_non_whitespace()? else {
            return Err(StreamInspectError::Invalid);
        };
        let start = self.offset;
        self.read_byte()?;
        let kind = match first {
            b'{' => TokenKind::LeftBrace,
            b'}' => TokenKind::RightBrace,
            b'[' => TokenKind::LeftBracket,
            b']' => TokenKind::RightBracket,
            b':' => TokenKind::Colon,
            b',' => TokenKind::Comma,
            b'"' => TokenKind::String(self.read_string(capture)?),
            b'-' | b'0'..=b'9' => TokenKind::Number(self.read_number(first, capture)?),
            b't' => {
                self.expect_bytes(b"rue")?;
                TokenKind::True
            }
            b'f' => {
                self.expect_bytes(b"alse")?;
                TokenKind::False
            }
            b'n' => {
                self.expect_bytes(b"ull")?;
                TokenKind::Null
            }
            _ => return Err(StreamInspectError::Invalid),
        };
        Ok(Token {
            kind,
            start,
            end: self.offset,
        })
    }

    fn expect_punctuation(&mut self, expected: TokenKind) -> Result<(), StreamInspectError> {
        if self.next_token(false)?.kind == expected {
            Ok(())
        } else {
            Err(StreamInspectError::Invalid)
        }
    }

    fn expect_bytes(&mut self, expected: &[u8]) -> Result<(), StreamInspectError> {
        for expected in expected {
            if self.read_byte()? != Some(*expected) {
                return Err(StreamInspectError::Invalid);
            }
        }
        Ok(())
    }

    fn read_string(&mut self, capture: bool) -> Result<Option<String>, StreamInspectError> {
        let mut raw = capture.then(|| vec![b'"']);
        loop {
            let byte = self.read_byte()?.ok_or(StreamInspectError::Invalid)?;
            if let Some(raw) = &mut raw {
                if raw.len() >= MAX_RPC_ID_BYTES.max(MAX_ENVELOPE_KEY_BYTES) + 2 {
                    return Err(StreamInspectError::TokenTooLarge);
                }
                raw.push(byte);
            }
            match byte {
                b'"' => break,
                0x00..=0x1f => return Err(StreamInspectError::Invalid),
                b'\\' => {
                    let escaped = self.read_byte()?.ok_or(StreamInspectError::Invalid)?;
                    if let Some(raw) = &mut raw {
                        raw.push(escaped);
                    }
                    match escaped {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                        b'u' => {
                            for _ in 0..4 {
                                let hex = self.read_byte()?.ok_or(StreamInspectError::Invalid)?;
                                if !hex.is_ascii_hexdigit() {
                                    return Err(StreamInspectError::Invalid);
                                }
                                if let Some(raw) = &mut raw {
                                    raw.push(hex);
                                }
                            }
                        }
                        _ => return Err(StreamInspectError::Invalid),
                    }
                }
                _ => {}
            }
        }
        raw.map(|raw| serde_json::from_slice(&raw).map_err(|_| StreamInspectError::Invalid))
            .transpose()
    }

    fn read_number(
        &mut self,
        first: u8,
        capture: bool,
    ) -> Result<Option<String>, StreamInspectError> {
        let mut raw = capture.then(|| vec![first]);
        let first_digit = if first == b'-' {
            let digit = self.read_byte()?.ok_or(StreamInspectError::Invalid)?;
            if !digit.is_ascii_digit() {
                return Err(StreamInspectError::Invalid);
            }
            if let Some(raw) = &mut raw {
                raw.push(digit);
            }
            digit
        } else {
            first
        };
        if first_digit == b'0' {
            if matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                return Err(StreamInspectError::Invalid);
            }
        } else {
            while matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                self.push_number_byte(&mut raw)?;
            }
        }
        if self.peek_byte()? == Some(b'.') {
            self.push_number_byte(&mut raw)?;
            if !matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                return Err(StreamInspectError::Invalid);
            }
            while matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                self.push_number_byte(&mut raw)?;
            }
        }
        if matches!(self.peek_byte()?, Some(b'e' | b'E')) {
            self.push_number_byte(&mut raw)?;
            if matches!(self.peek_byte()?, Some(b'+' | b'-')) {
                self.push_number_byte(&mut raw)?;
            }
            if !matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                return Err(StreamInspectError::Invalid);
            }
            while matches!(self.peek_byte()?, Some(b'0'..=b'9')) {
                self.push_number_byte(&mut raw)?;
            }
        }
        raw.map(|raw| String::from_utf8(raw).map_err(|_| StreamInspectError::Invalid))
            .transpose()
    }

    fn push_number_byte(&mut self, raw: &mut Option<Vec<u8>>) -> Result<(), StreamInspectError> {
        let byte = self.read_byte()?.ok_or(StreamInspectError::Invalid)?;
        if let Some(raw) = raw {
            if raw.len() >= MAX_RPC_ID_BYTES {
                return Err(StreamInspectError::TokenTooLarge);
            }
            raw.push(byte);
        }
        Ok(())
    }

    fn parse_error_code(
        &mut self,
        token: Token,
        depth: usize,
    ) -> Result<Option<i64>, StreamInspectError> {
        if !matches!(&token.kind, TokenKind::LeftBrace) {
            self.skip_value(token, depth)?;
            return Ok(None);
        }
        if self.peek_non_whitespace()? == Some(b'}') {
            self.expect_punctuation(TokenKind::RightBrace)?;
            return Ok(None);
        }
        let mut fields = HashSet::new();
        let mut code = None;
        loop {
            let key = self.next_token(true)?;
            let TokenKind::String(Some(key)) = key.kind else {
                return Err(StreamInspectError::Invalid);
            };
            if key.len() > MAX_ENVELOPE_KEY_BYTES
                || fields.len() >= MAX_ENVELOPE_FIELDS
                || !fields.insert(key.clone())
            {
                return Err(StreamInspectError::Invalid);
            }
            self.expect_punctuation(TokenKind::Colon)?;
            if key == "code" {
                let value = self.next_token(true)?;
                code = match &value.kind {
                    TokenKind::Number(Some(raw)) => raw.parse::<i64>().ok(),
                    _ => None,
                };
                self.skip_value(value, depth + 1)?;
            } else {
                let value = self.next_token(false)?;
                self.skip_value(value, depth + 1)?;
            }
            match self.next_token(false)?.kind {
                TokenKind::Comma => continue,
                TokenKind::RightBrace => break,
                _ => return Err(StreamInspectError::Invalid),
            }
        }
        Ok(code)
    }

    fn skip_value(&mut self, token: Token, depth: usize) -> Result<(), StreamInspectError> {
        if depth >= MAX_JSON_DEPTH {
            return Err(StreamInspectError::Invalid);
        }
        match token.kind {
            TokenKind::LeftBrace => {
                if self.peek_non_whitespace()? == Some(b'}') {
                    self.expect_punctuation(TokenKind::RightBrace)?;
                    return Ok(());
                }
                loop {
                    if !matches!(self.next_token(false)?.kind, TokenKind::String(_)) {
                        return Err(StreamInspectError::Invalid);
                    }
                    self.expect_punctuation(TokenKind::Colon)?;
                    let value = self.next_token(false)?;
                    self.skip_value(value, depth + 1)?;
                    match self.next_token(false)?.kind {
                        TokenKind::Comma => continue,
                        TokenKind::RightBrace => break,
                        _ => return Err(StreamInspectError::Invalid),
                    }
                }
            }
            TokenKind::LeftBracket => {
                if self.peek_non_whitespace()? == Some(b']') {
                    self.expect_punctuation(TokenKind::RightBracket)?;
                    return Ok(());
                }
                loop {
                    let value = self.next_token(false)?;
                    self.skip_value(value, depth + 1)?;
                    match self.next_token(false)?.kind {
                        TokenKind::Comma => continue,
                        TokenKind::RightBracket => break,
                        _ => return Err(StreamInspectError::Invalid),
                    }
                }
            }
            TokenKind::String(_)
            | TokenKind::Number(_)
            | TokenKind::True
            | TokenKind::False
            | TokenKind::Null => {}
            _ => return Err(StreamInspectError::Invalid),
        }
        Ok(())
    }
}

struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueValueVisitor)
    }
}

struct UniqueValueVisitor;

impl<'de> Visitor<'de> for UniqueValueVisitor {
    type Value = UniqueValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object members")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(Number::from(value))))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Number(Number::from(value))))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .map(UniqueValue)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }

    fn visit_seq<A>(self, mut values: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut out = Vec::new();
        while let Some(value) = values.next_element::<UniqueValue>()? {
            out.push(value.0);
        }
        Ok(UniqueValue(Value::Array(out)))
    }

    fn visit_map<A>(self, mut values: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut out = Map::new();
        while let Some(key) = values.next_key::<String>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom(format_args!(
                    "duplicate JSON object member: {key}"
                )));
            }
            let value = values.next_value::<UniqueValue>()?;
            out.insert(key, value.0);
        }
        Ok(UniqueValue(Value::Object(out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, sync::Arc};

    use axum::response::IntoResponse;
    use serde_json::json;
    use tokio::sync::Semaphore;

    #[test]
    fn rejects_duplicate_members_at_any_depth() {
        assert!(parse_without_duplicate_keys(br#"{"method":"safe","method":"unsafe"}"#).is_err());
        assert!(parse_without_duplicate_keys(br#"{"params":[{"x":1,"x":2}]}"#).is_err());
    }

    #[test]
    fn preserves_ordinary_json_values() {
        let bytes = br#"{"jsonrpc":"2.0","id":7,"params":[null,true,-2,1.5]}"#;
        assert_eq!(
            parse_without_duplicate_keys(bytes).unwrap(),
            serde_json::from_slice::<Value>(bytes).unwrap()
        );
    }

    #[test]
    fn sanitizes_errors_without_touching_success_data() {
        let mut success = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "1",
            "result": "0x1",
        });
        let original = success.clone();
        sanitize_response_errors(&mut success);
        assert_eq!(success, original);

        let mut error = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "error": {
                "code": -32000,
                "message": "provider secret",
                "data": {"credential": "secret"},
            },
        });
        sanitize_response_errors(&mut error);
        assert_eq!(error["id"], 7);
        assert_eq!(error["error"]["code"], -32000);
        assert_eq!(error["error"]["message"], "upstream RPC error");
        assert!(error["error"].get("data").is_none());
        assert!(!error.to_string().contains("secret"));
    }

    #[test]
    fn validates_single_and_batch_response_envelopes() {
        assert!(is_response_envelope(
            &serde_json::json!({"result": 1, "error": null, "id": 7}),
            JsonRpcVersion::Legacy,
        ));
        assert!(is_response_envelope(
            &serde_json::json!([{
                "jsonrpc": "2.0",
                "error": {"code": -1, "message": "rejected"},
                "id": "a",
            }]),
            JsonRpcVersion::V2,
        ));
        assert!(!is_response_envelope(
            &serde_json::json!({"result": 1, "error": null, "id": 7}),
            JsonRpcVersion::V2,
        ));
        assert!(!is_response_envelope(
            &serde_json::json!({"jsonrpc": "2.0", "result": 1, "error": null, "id": 7}),
            JsonRpcVersion::V2,
        ));
        assert!(!is_response_envelope(&Value::Null, JsonRpcVersion::Legacy,));
        assert!(!is_response_envelope(
            &serde_json::json!({}),
            JsonRpcVersion::Legacy,
        ));
        assert!(!is_response_envelope(
            &serde_json::json!([]),
            JsonRpcVersion::Legacy,
        ));
    }

    #[test]
    fn correlates_reordered_responses_and_rejects_missing_or_duplicate_ids() {
        let request =
            br#"[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]"#;
        assert!(response_matches_request(
            request,
            &serde_json::json!([
                {"jsonrpc":"2.0","id":2,"result":true},
                {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"no"}},
            ]),
        ));
        assert!(!response_matches_request(
            request,
            &serde_json::json!([{"jsonrpc":"2.0","id":1,"result":true}]),
        ));
        assert!(!response_matches_request(
            request,
            &serde_json::json!([
                {"jsonrpc":"2.0","id":1,"result":true},
                {"jsonrpc":"2.0","id":1,"result":false},
            ]),
        ));
    }

    fn inspect(bytes: &[u8], ids: &[Value]) -> Result<InspectedResponse, StreamInspectError> {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        inspect_spooled_response(
            file.path(),
            JsonRpcVersion::V2,
            &RequestCorrelation {
                ids: ids.to_vec(),
                is_batch: ids.len() > 1,
            },
        )
    }

    #[test]
    fn streaming_inspector_preserves_singleton_batch_shape() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(br#"[{"jsonrpc":"2.0","id":1,"result":true}]"#)
            .unwrap();
        let correlation = RequestCorrelation {
            ids: vec![json!(1)],
            is_batch: true,
        };
        assert!(inspect_spooled_response(file.path(), JsonRpcVersion::V2, &correlation).is_ok());

        let mut object = tempfile::NamedTempFile::new().unwrap();
        object
            .write_all(br#"{"jsonrpc":"2.0","id":1,"result":true}"#)
            .unwrap();
        assert!(inspect_spooled_response(object.path(), JsonRpcVersion::V2, &correlation).is_err());
    }

    #[test]
    fn streaming_inspector_skips_large_results_and_locates_only_error_values() {
        assert!(inspect(
            br#"{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"secret"}}"#,
            &[json!(2)]
        )
        .is_ok());
        assert!(inspect(br#"{"jsonrpc":"2.0","id":1,"result":"small"}"#, &[json!(1)]).is_ok());
        let large = "x".repeat(2 * 1024 * 1024);
        let response = format!(
            r#"[{{"jsonrpc":"2.0","id":2,"error":{{"code":-1,"message":"secret"}}}},{{"jsonrpc":"2.0","id":1,"result":"{large}"}}]"#
        );
        let inspected = inspect(response.as_bytes(), &[json!(1), json!(2)]).unwrap();
        assert_eq!(inspected.error_rewrites.len(), 1);
        assert_eq!(
            &response.as_bytes()[inspected.error_rewrites[0].range.start as usize
                ..inspected.error_rewrites[0].range.end as usize],
            br#"{"code":-1,"message":"secret"}"#
        );
    }

    #[test]
    fn streaming_inspector_rejects_envelope_ambiguity_and_bad_correlation() {
        assert!(inspect(
            br#"{"jsonrpc":"2.0","id":1,"id":2,"result":true}"#,
            &[json!(1)]
        )
        .is_err());
        assert!(inspect(
            br#"[{"jsonrpc":"2.0","id":1,"result":true},{"jsonrpc":"2.0","id":1,"result":true}]"#,
            &[json!(1), json!(2)]
        )
        .is_err());
        assert!(inspect(
            br#"{"jsonrpc":"2.0","id":1,"result":true} trailing"#,
            &[json!(1)]
        )
        .is_err());
        let oversized_id = format!(
            r#"{{"jsonrpc":"2.0","id":"{}","result":true}}"#,
            "i".repeat(MAX_RPC_ID_BYTES + 1)
        );
        assert!(inspect(oversized_id.as_bytes(), &[json!("unused")]).is_err());
        assert!(inspect(
            br#"{"jsonrpc":"2.0","id":1,"result":true,"debug":"provider-secret"}"#,
            &[json!(1)]
        )
        .is_err());
        let oversized_request = format!(
            r#"{{"jsonrpc":"2.0","id":"{}","method":"eth_chainId","params":[]}}"#,
            "i".repeat(MAX_RPC_ID_BYTES + 1)
        );
        assert!(request_correlation(oversized_request.as_bytes()).is_err());
        let deeply_nested = format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":{}}}"#,
            "[".repeat(MAX_JSON_DEPTH + 1) + &"]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert!(inspect(deeply_nested.as_bytes(), &[json!(1)]).is_err());
    }

    #[test]
    fn streaming_inspector_handles_envelope_tokens_fragmented_at_buffer_boundaries() {
        let mut response = vec![b' '; 64 * 1024 - 4];
        response.extend_from_slice(br#"{"jsonrpc":"2.0","id":"fragmented-id","result":[1,2,3]}"#);
        assert!(inspect(&response, &[json!("fragmented-id")]).is_ok());
    }

    #[test]
    fn streaming_inspector_honors_cooperative_cancellation() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(br#"{"jsonrpc":"2.0","id":1,"result":true}"#)
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(true));
        assert!(inspect_spooled_response_with_cancel(
            file.path(),
            JsonRpcVersion::V2,
            &RequestCorrelation {
                ids: vec![json!(1)],
                is_batch: false,
            },
            Some(cancelled),
        )
        .is_err());
    }

    #[tokio::test]
    async fn spool_stream_rewrites_only_error_values_and_unlinks_on_drop() {
        let bytes = br#"[{"jsonrpc":"2.0","id":1,"result":"secret stays in success"},{"jsonrpc":"2.0","id":2,"error":{"code":-7,"message":"provider secret","data":"leak"}}]"#;
        let mut named = tempfile::NamedTempFile::new().unwrap();
        named.write_all(bytes).unwrap();
        let path_buf = named.path().to_path_buf();
        let (_file, path) = named.into_parts();
        let spool = ResponseSpool { path };
        let inspected = spool
            .inspect(
                JsonRpcVersion::V2,
                RequestCorrelation {
                    ids: vec![json!(1), json!(2)],
                    is_batch: true,
                },
            )
            .await
            .unwrap();
        let body = spool.into_body(inspected.error_rewrites).await.unwrap();
        let rewritten = hyper::body::to_bytes(body).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&rewritten).unwrap(),
            json!([
                {"jsonrpc":"2.0","id":1,"result":"secret stays in success"},
                {"jsonrpc":"2.0","id":2,"error":{
                    "code":-7,
                    "message":"upstream RPC error"
                }}
            ])
        );
        assert!(!path_buf.exists());

        let named = tempfile::NamedTempFile::new().unwrap();
        let path_buf = named.path().to_path_buf();
        let (_file, path) = named.into_parts();
        let body = ResponseSpool { path }.into_body(Vec::new()).await.unwrap();
        drop(body);
        assert!(!path_buf.exists());
    }

    #[tokio::test]
    async fn response_permit_lives_until_body_is_consumed() {
        let permits = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&permits).try_acquire_owned().unwrap();
        let response = hold_response_permit("ok".into_response(), permit, Duration::from_secs(10));
        assert!(Arc::clone(&permits).try_acquire_owned().is_err());
        assert_eq!(
            hyper::body::to_bytes(response.into_body()).await.unwrap(),
            "ok"
        );
        assert!(Arc::clone(&permits).try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn response_delivery_guard_preserves_trailers() {
        let permits = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&permits).try_acquire_owned().unwrap();
        let (mut sender, body) = Body::channel();
        tokio::spawn(async move {
            sender.send_data(Bytes::from_static(b"ok")).await.unwrap();
            let mut trailers = axum::http::HeaderMap::new();
            trailers.insert("x-upstream-proof", "present".parse().unwrap());
            sender.send_trailers(trailers).await.unwrap();
        });
        let response =
            hold_response_permit(Response::new(boxed(body)), permit, Duration::from_secs(10));
        let mut guarded = response.into_body();
        assert_eq!(guarded.data().await.unwrap().unwrap(), "ok");
        assert!(guarded.data().await.is_none());
        assert!(Arc::clone(&permits).try_acquire_owned().is_err());
        let trailers = guarded.trailers().await.unwrap().unwrap();
        assert_eq!(trailers["x-upstream-proof"], "present");
        assert!(Arc::clone(&permits).try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn response_delivery_deadline_releases_permit_and_spool_without_polling() {
        let permits = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&permits).try_acquire_owned().unwrap();
        let named = tempfile::NamedTempFile::new().unwrap();
        let path_buf = named.path().to_path_buf();
        let (_file, path) = named.into_parts();
        let body = ResponseSpool { path }.into_body(Vec::new()).await.unwrap();
        let response = hold_response_permit(
            Response::new(boxed(body)),
            permit,
            Duration::from_millis(10),
        );
        assert!(path_buf.exists());
        assert!(Arc::clone(&permits).try_acquire_owned().is_err());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!path_buf.exists());
        assert!(Arc::clone(&permits).try_acquire_owned().is_ok());
        drop(response);
    }
}
