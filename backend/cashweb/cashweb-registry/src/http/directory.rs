//! Exact CBOR directory routes. Capacity is reserved before request-body collection.
use crate::directory_runtime::{DirectoryRuntime, Evidence, Operation, RuntimeError};
use axum::{
    body::HttpBody,
    extract::{Extension, Path, RawBody},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing, Router,
};
use std::{sync::Arc, time::Duration};
const MEDIA: &str = "application/vnd.frank.cbor";
pub(crate) fn error(e: RuntimeError) -> Response {
    let (status, text) = match e {
        RuntimeError::Busy => (StatusCode::TOO_MANY_REQUESTS, "busy/not-started"),
        RuntimeError::NotStarted => (StatusCode::SERVICE_UNAVAILABLE, "unavailable/not-started"),
        RuntimeError::OutcomeUnknown => (
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable/outcome-unknown",
        ),
        RuntimeError::NotFound => (StatusCode::NOT_FOUND, "not-found"),
        RuntimeError::Invalid => (StatusCode::BAD_REQUEST, "invalid"),
        RuntimeError::Trust => (StatusCode::CONFLICT, "trust/continuity"),
        RuntimeError::Resource => (StatusCode::TOO_MANY_REQUESTS, "capacity"),
    };
    (
        status,
        [
            (header::CONTENT_TYPE, "text/plain"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::HeaderName::from_static("x-frank-directory-disposition"),
                match e {
                    RuntimeError::Busy | RuntimeError::NotStarted => "not-started",
                    RuntimeError::OutcomeUnknown => "outcome-unknown",
                    _ => "rejected",
                },
            ),
        ],
        text,
    )
        .into_response()
}
fn evidence(result: std::result::Result<Evidence, RuntimeError>) -> Response {
    match result {
        Err(e) => error(e),
        Ok(e) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, MEDIA),
                (header::CACHE_CONTROL, "no-store"),
                (
                    header::HeaderName::from_static("x-frank-directory-evidence"),
                    if e.historical {
                        "historical"
                    } else {
                        "fresh-current"
                    },
                ),
            ],
            e.attestation,
        )
            .into_response(),
    }
}
async fn current(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    Path((network, subject)): Path<(String, String)>,
) -> Response {
    match runtime.reserve(&network, &subject) {
        Err(e) => error(e),
        Ok(slot) => evidence(runtime.submit(slot, Operation::Current).wait().await),
    }
}
async fn historical(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    Path((network, subject, t1)): Path<(String, String, String)>,
) -> Response {
    if t1.len() != 64
        || !t1
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return error(RuntimeError::Invalid);
    }
    let hash = hex::decode(t1).unwrap().try_into().unwrap();
    match runtime.reserve(&network, &subject) {
        Err(e) => error(e),
        Ok(slot) => evidence(
            runtime
                .submit(slot, Operation::Historical(hash))
                .wait()
                .await,
        ),
    }
}
async fn put(
    Extension(runtime): Extension<Arc<DirectoryRuntime>>,
    Path((network, subject)): Path<(String, String)>,
    headers: HeaderMap,
    RawBody(mut body): RawBody,
) -> Response {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some(MEDIA)
    {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "media").into_response();
    }
    let slot = match runtime.reserve(&network, &subject) {
        Ok(s) => s,
        Err(e) => return error(e),
    };
    let collect = async {
        let mut bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|_| RuntimeError::Invalid)?;
            if bytes.len() + chunk.len() > crate::directory_admission::MAX_FRAME_BYTES {
                return Err(RuntimeError::Resource);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    match tokio::time::timeout(Duration::from_secs(5), collect).await {
        Err(_) => error(RuntimeError::NotStarted),
        Ok(Err(e)) => error(e),
        Ok(Ok(bytes)) => evidence(runtime.submit(slot, Operation::Put(bytes)).wait().await),
    }
}
/// Mount only when an explicit operator runtime exists; no implicit enrollment surface.
pub fn router(runtime: Arc<DirectoryRuntime>) -> Router {
    Router::new()
        .route(
            "/directory/v1/:network/:subject/head",
            routing::get(current).put(put),
        )
        .route(
            "/directory/v1/:network/:subject/statements/:t1",
            routing::get(historical),
        )
        .layer(Extension(runtime))
}
#[cfg(test)]
#[path = "directory_tests.rs"]
pub(crate) mod tests;
