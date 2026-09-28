//! Module containing [`Protobuf`] [`axum`] extractor, allowing convenient en/-decoding of Protobuf
//! request/response bodies.

use async_trait::async_trait;
use axum::{
    extract::{FromRequest, RequestParts},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use bitcoinsuite_error::ErrorMeta;
use hyper::{body::HttpBody, header::CONTENT_TYPE, Body};
use prost::Message;
use thiserror::Error;

use crate::{error::HttpUtilError, validation::check_content_type};

/// Newtype around a Protobuf [`Message`], allows [`axum`] to en-/decode this Protobuf message.
#[derive(Debug)]
pub struct Protobuf<P: Message + Default>(pub P);

/// HTTP "Content-Type" for protobuf payloads.
pub const CONTENT_TYPE_PROTOBUF: &str = "application/x-protobuf";

/// Split transaction sets need more than a legacy 64 KiB ceiling, but request buffering must stay
/// bounded before protobuf decoding. Two MiB is ample for the protocol's 64-payment maximum.
pub const MAX_PROTOBUF_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Error indicating that [`FromRequest`] for a Protobuf message failed.
#[derive(Debug, Error, ErrorMeta)]
pub enum CashwebProtobufError {
    /// Cannot convert request body to bytes.
    #[invalid_client_input()]
    #[error("Invalid body: {0}")]
    InvalidBody(String),

    /// Body doesn't encode expected Protobuf.
    #[invalid_client_input()]
    #[error("Bad protobuf: {0}")]
    BadProtobuf(String),
}

use self::CashwebProtobufError::*;

#[async_trait]
impl<P: Message + Default> FromRequest<Body> for Protobuf<P> {
    type Rejection = HttpUtilError;

    async fn from_request(req: &mut RequestParts<Body>) -> Result<Self, Self::Rejection> {
        let headers = req.headers();
        check_content_type(headers, CONTENT_TYPE_PROTOBUF)?;
        let mut body = req.take_body().expect("Body taken");
        let mut body_bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|err| InvalidBody(err.to_string()))?;
            if body_bytes.len().saturating_add(chunk.len()) > MAX_PROTOBUF_BODY_BYTES {
                return Err(InvalidBody(format!(
                    "protobuf body exceeds {MAX_PROTOBUF_BODY_BYTES} bytes"
                ))
                .into());
            }
            body_bytes.extend_from_slice(&chunk);
        }
        let proto = P::decode(body_bytes.as_slice()).map_err(|err| BadProtobuf(err.to_string()))?;
        Ok(Protobuf(proto))
    }
}

impl<P: Message + Default> IntoResponse for Protobuf<P> {
    fn into_response(self) -> Response {
        let mut response = Response::builder()
            .body(axum::body::boxed(Body::from(self.0.encode_to_vec())))
            .unwrap();
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static(CONTENT_TYPE_PROTOBUF),
        );
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        extract::{FromRequest, RequestParts},
        http::Request,
    };
    use hyper::Body;
    use prost::Message;

    use super::{Protobuf, CONTENT_TYPE_PROTOBUF, MAX_PROTOBUF_BODY_BYTES};

    #[derive(Clone, PartialEq, Message)]
    struct TestMessage {
        #[prost(bytes = "vec", tag = "1")]
        data: Vec<u8>,
    }

    #[tokio::test]
    async fn accepts_a_valid_body_below_the_limit() {
        let encoded = TestMessage {
            data: vec![0x42; 1024],
        }
        .encode_to_vec();
        let request = Request::builder()
            .header("content-type", CONTENT_TYPE_PROTOBUF)
            .body(Body::from(encoded))
            .unwrap();
        let mut parts = RequestParts::new(request);

        let Protobuf(decoded) = Protobuf::<TestMessage>::from_request(&mut parts)
            .await
            .expect("valid protobuf under the request cap");
        assert_eq!(decoded.data, vec![0x42; 1024]);
    }

    #[tokio::test]
    async fn rejects_a_body_above_the_limit_before_decoding() {
        let request = Request::builder()
            .header("content-type", CONTENT_TYPE_PROTOBUF)
            .body(Body::from(vec![0; MAX_PROTOBUF_BODY_BYTES + 1]))
            .unwrap();
        let mut parts = RequestParts::new(request);

        let result = Protobuf::<TestMessage>::from_request(&mut parts).await;
        assert!(result.is_err());
    }
}
