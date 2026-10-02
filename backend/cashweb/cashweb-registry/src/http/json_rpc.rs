use std::{
    fmt,
    pin::Pin,
    task::{Context, Poll},
};

use axum::{
    body::{boxed, BoxBody, Bytes, HttpBody},
    response::Response,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JsonRpcVersion {
    Legacy,
    V2,
}

struct PermitBody {
    inner: BoxBody,
    _permit: OwnedSemaphorePermit,
}

impl HttpBody for PermitBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_data(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Self::Data, Self::Error>>> {
        Pin::new(&mut self.inner).poll_data(cx)
    }

    fn poll_trailers(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Option<axum::http::HeaderMap>, Self::Error>> {
        Pin::new(&mut self.inner).poll_trailers(cx)
    }
}

/// Keep upstream admission charged until the downstream response body is
/// completely consumed or dropped by the transport.
pub(crate) fn hold_response_permit(response: Response, permit: OwnedSemaphorePermit) -> Response {
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        boxed(PermitBody {
            inner: body,
            _permit: permit,
        }),
    )
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
    use std::sync::Arc;

    use axum::response::IntoResponse;
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

    #[tokio::test]
    async fn response_permit_lives_until_body_is_consumed() {
        let permits = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&permits).try_acquire_owned().unwrap();
        let response = hold_response_permit("ok".into_response(), permit);
        assert!(Arc::clone(&permits).try_acquire_owned().is_err());
        assert_eq!(
            hyper::body::to_bytes(response.into_body()).await.unwrap(),
            "ok"
        );
        assert!(Arc::clone(&permits).try_acquire_owned().is_ok());
    }
}
