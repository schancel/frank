use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

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
}
