//! Module containing [`Protobuf`] [`axum`] extractor, allowing convenient en/-decoding of Protobuf
//! request/response bodies.

use async_trait::async_trait;
use axum::{
    extract::{FromRequest, RequestParts},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use bitcoinsuite_error::ErrorMeta;
use hyper::{body::to_bytes, body::HttpBody, header::CONTENT_TYPE, Body};
use prost::Message;
use thiserror::Error;

use crate::{error::HttpUtilError, validation::check_content_type};

/// Newtype around a Protobuf [`Message`], allows [`axum`] to en-/decode this Protobuf message.
#[derive(Debug)]
pub struct Protobuf<P: Message + Default>(pub P);

/// HTTP "Content-Type" for protobuf payloads.
pub const CONTENT_TYPE_PROTOBUF: &str = "application/x-protobuf";

/// A content-type-checked request body bounded before protocol decoding. This lets high-risk
/// routes set an explicit limit without silently changing every legacy protobuf endpoint.
#[derive(Debug)]
pub struct BoundedProtobufBody<const MAX_BYTES: usize>(pub Vec<u8>);

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
        let body = req.take_body().expect("Body taken");
        let body_bytes = to_bytes(body)
            .await
            .map_err(|err| InvalidBody(err.to_string()))?;
        let proto = P::decode(body_bytes).map_err(|err| BadProtobuf(err.to_string()))?;
        Ok(Protobuf(proto))
    }
}

#[async_trait]
impl<const MAX_BYTES: usize> FromRequest<Body> for BoundedProtobufBody<MAX_BYTES> {
    type Rejection = HttpUtilError;

    async fn from_request(req: &mut RequestParts<Body>) -> Result<Self, Self::Rejection> {
        check_content_type(req.headers(), CONTENT_TYPE_PROTOBUF)?;
        let mut body = req.take_body().expect("Body taken");
        let mut body_bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|err| InvalidBody(err.to_string()))?;
            if body_bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err(InvalidBody(format!("protobuf body exceeds {MAX_BYTES} bytes")).into());
            }
            body_bytes.extend_from_slice(&chunk);
        }
        Ok(BoundedProtobufBody(body_bytes))
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

    use super::{BoundedProtobufBody, Protobuf, CONTENT_TYPE_PROTOBUF};

    const TEST_LIMIT: usize = 2048;

    #[derive(Clone, PartialEq, Message)]
    struct TestMessage {
        #[prost(bytes = "vec", tag = "1")]
        data: Vec<u8>,
    }

    #[tokio::test]
    async fn accepts_a_body_at_the_exact_limit() {
        let encoded = vec![0x42; TEST_LIMIT];
        let request = Request::builder()
            .header("content-type", CONTENT_TYPE_PROTOBUF)
            .body(Body::from(encoded.clone()))
            .unwrap();
        let mut parts = RequestParts::new(request);

        let BoundedProtobufBody(decoded) =
            BoundedProtobufBody::<TEST_LIMIT>::from_request(&mut parts)
                .await
                .expect("body at request cap");
        assert_eq!(decoded, encoded);
    }

    #[tokio::test]
    async fn legacy_protobuf_extractor_still_decodes_without_the_route_cap() {
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
    async fn rejects_a_multichunk_body_when_the_total_crosses_the_limit() {
        let (mut sender, body) = Body::channel();
        tokio::spawn(async move {
            sender.send_data(vec![0; TEST_LIMIT].into()).await.unwrap();
            sender.send_data(vec![0].into()).await.unwrap();
        });
        let request = Request::builder()
            .header("content-type", CONTENT_TYPE_PROTOBUF)
            .body(body)
            .unwrap();
        let mut parts = RequestParts::new(request);

        let result = BoundedProtobufBody::<TEST_LIMIT>::from_request(&mut parts).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_a_body_above_the_limit_before_decoding() {
        let request = Request::builder()
            .header("content-type", CONTENT_TYPE_PROTOBUF)
            .body(Body::from(vec![0; TEST_LIMIT + 1]))
            .unwrap();
        let mut parts = RequestParts::new(request);

        let result = BoundedProtobufBody::<TEST_LIMIT>::from_request(&mut parts).await;
        assert!(result.is_err());
    }
}
