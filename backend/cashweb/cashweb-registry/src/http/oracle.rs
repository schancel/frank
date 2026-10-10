//! `GET /oracle/v1/feed`: the relay's price and energy feed (contract:
//! `docs/protocol/oracle/README.md`). Public, the same for everyone, and answered from the
//! relay's own store: a request never causes a request to a provider.
//!
//! - `?latest` (or no query): the current point of every series and the electricity window.
//!   Built after each collector round and served from memory; about 6 kB with the shipped
//!   configuration. `Cache-Control: public, max-age=600`, with an `ETag`.
//! - `?since=<unixSeconds>&until=<unixSeconds>&step=<seconds>`: history for a chart. At most
//!   [`MAX_RANGE_POINTS`] steps per request: a smaller `step` is refused with the smallest one
//!   allowed, so an answer is bounded by the number of series times that. Cacheable for a day
//!   once `until` is in the past.
//!
//! Installed only when `[registry.oracle]` is configured; otherwise the path answers 404, which
//! is how a client learns the relay has no feed.

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{rejection::QueryRejection, Extension, Query},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing, Json, Router,
};

use crate::oracle::{
    feed::{Answer, RangeError, MAX_RANGE_POINTS},
    OracleRuntime,
};

const LATEST_CACHE: &str = "public, max-age=600";
const PAST_RANGE_CACHE: &str = "public, max-age=86400";

fn refusal(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({ "error": "invalid-request", "message": message })),
    )
        .into_response()
}

fn answer(answer: &Answer, cache: &'static str, headers: &HeaderMap) -> Response {
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == answer.etag));
    let caching = [
        (header::CACHE_CONTROL, cache.to_owned()),
        (header::ETAG, answer.etag.clone()),
    ];
    if unchanged {
        return (StatusCode::NOT_MODIFIED, caching).into_response();
    }
    (
        caching,
        [(header::CONTENT_TYPE, "application/json")],
        answer.body.clone(),
    )
        .into_response()
}

fn now_s() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn handle_feed(
    Extension(oracle): Extension<Arc<OracleRuntime>>,
    query: Result<Query<HashMap<String, String>>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let Ok(Query(query)) = query else {
        return refusal("the query could not be read".to_owned());
    };
    let range = ["since", "until", "step"].map(|name| query.get(name));
    if range.iter().all(Option::is_none) {
        return answer(&oracle.feed.latest(), LATEST_CACHE, &headers);
    }
    if query.contains_key("latest") {
        return refusal("ask for latest or for a range, not both".to_owned());
    }
    let numbers = range.map(|value| value.and_then(|value| value.parse::<u64>().ok()));
    let [Some(since), Some(until), Some(step)] = numbers else {
        return refusal(
            "a range needs since, until and step, each a whole number of seconds".to_owned(),
        );
    };
    let now = now_s();
    match oracle.feed.range(since, until, step, now) {
        Ok(Ok(built)) => {
            let cache = if until < now {
                PAST_RANGE_CACHE
            } else {
                LATEST_CACHE
            };
            answer(&built, cache, &headers)
        }
        Ok(Err(error)) => {
            tracing::error!(%error, "oracle: store read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(RangeError::Invalid) => {
            refusal("since must not be after until, and step must be at least 1".to_owned())
        }
        Err(RangeError::StepTooSmall(smallest)) => refusal(format!(
            "at most {MAX_RANGE_POINTS} steps per request: use a step of at least {smallest} \
             seconds for this range, or a shorter range"
        )),
    }
}

/// The feed route over a running oracle.
pub fn router(oracle: Arc<OracleRuntime>) -> Router {
    Router::new()
        .route("/oracle/v1/feed", routing::get(handle_feed))
        .layer(Extension(oracle))
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;
    use crate::oracle::feed::tests::{feed, CONF};

    async fn get(
        router: &Router,
        uri: &str,
        etag: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::get(uri);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();
        let body = hyper::body::to_bytes(body).await.unwrap().to_vec();
        (parts.status, parts.headers, body)
    }

    /// The route as a client meets it: latest by default, cache headers, a 304 for a matching
    /// tag, a range with its own cache lifetime, and plain refusals for requests it will not
    /// answer.
    #[tokio::test]
    async fn the_route_serves_latest_and_ranges_with_cache_headers_and_bounds() {
        let dir = tempdir::TempDir::new("oracle-route").unwrap();
        let feed = Arc::new(feed(&dir, CONF));
        let now = now_s();
        feed.store()
            .write(
                &[],
                &[
                    ("price/btc-mainnet".to_owned(), now - 7200, 100.0),
                    ("price/btc-mainnet".to_owned(), now - 3000, 101.0),
                    ("price/btc-mainnet".to_owned(), now - 600, 102.0),
                ],
            )
            .unwrap();
        feed.rebuild_latest(now);
        let router = router(Arc::new(OracleRuntime { feed }));

        for uri in ["/oracle/v1/feed?latest", "/oracle/v1/feed"] {
            let (status, headers, body) = get(&router, uri, None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600");
            assert_eq!(headers[header::CONTENT_TYPE], "application/json");
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                json["series"]["price/btc-mainnet"]["points"],
                serde_json::json!([[now - 600, 102.0]])
            );
            let etag = headers[header::ETAG].to_str().unwrap();
            let (status, headers, body) = get(&router, uri, Some(etag)).await;
            assert_eq!(status, StatusCode::NOT_MODIFIED);
            assert!(body.is_empty());
            assert_eq!(headers[header::ETAG], etag);
        }

        // A range that ended in the past: floor point, then the last point of each hour.
        let uri = format!(
            "/oracle/v1/feed?since={}&until={}&step=3600",
            now - 4000,
            now - 100
        );
        let (status, headers, body) = get(&router, &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=86400");
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let points = json["series"]["price/btc-mainnet"]["points"]
            .as_array()
            .unwrap();
        assert_eq!(points[0], serde_json::json!([now - 7200, 100.0]));
        assert_eq!(
            points.last().unwrap(),
            &serde_json::json!([now - 600, 102.0])
        );
        // A range reaching the present is cached only as long as a latest answer.
        let uri = format!(
            "/oracle/v1/feed?since={}&until={}&step=600",
            now - 4000,
            now + 60
        );
        assert_eq!(
            get(&router, &uri, None).await.1[header::CACHE_CONTROL],
            "public, max-age=600"
        );

        for (uri, expected) in [
            (
                "/oracle/v1/feed?since=5",
                "a range needs since, until and step",
            ),
            ("/oracle/v1/feed?since=a&until=2&step=1", "a range needs"),
            ("/oracle/v1/feed?latest&since=1&until=2&step=1", "not both"),
            (
                "/oracle/v1/feed?since=9&until=2&step=1",
                "since must not be after until",
            ),
            (
                "/oracle/v1/feed?since=0&until=31536000&step=60",
                "at least 31536 seconds",
            ),
        ] {
            let (status, headers, body) = get(&router, uri, None).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-store");
            let text = String::from_utf8(body).unwrap();
            assert!(text.contains(expected), "{uri}: {text}");
        }
    }
}
