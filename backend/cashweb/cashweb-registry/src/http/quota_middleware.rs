//! Reusable admission after route-owned validation. This layer neither reads request bodies
//! nor trusts an identity/weight supplied in headers. Only a typed internal preparation grants
//! an exemption or charge; a missing preparation is an internal wiring failure, not a bypass.
use super::hourly_quota::{FixedHourQuota, QuotaDenial, QuotaIdentity};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;

pub(crate) struct QuotaPolicy<K> {
    limiter: FixedHourQuota<K>,
    denial: fn(QuotaDenial) -> Response,
}
impl<K> QuotaPolicy<K> {
    pub(crate) fn new(limiter: FixedHourQuota<K>, denial: fn(QuotaDenial) -> Response) -> Self {
        Self { limiter, denial }
    }
}
#[derive(Clone)]
pub(crate) enum PreparedQuota<K> {
    Charge { payer: K, units: u32 },
    Exempt,
}

pub(crate) async fn admit<K: QuotaIdentity + Sync + 'static>(
    mut request: Request<Body>,
    next: Next<Body>,
) -> Response {
    let Some(policy) = request.extensions().get::<Arc<QuotaPolicy<K>>>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Some(prepared) = request.extensions_mut().remove::<PreparedQuota<K>>() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    match prepared {
        PreparedQuota::Exempt => next.run(request).await,
        PreparedQuota::Charge { payer, units } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            match policy.limiter.charge(payer, units, now).await {
                Err(denial) => (policy.denial)(denial),
                Ok(decision) => {
                    let mut response = next.run(request).await;
                    response.extensions_mut().insert(decision);
                    response
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::hourly_quota::{QuotaBackend, QuotaDomain};
    use axum::{body::Bytes, middleware::from_fn, routing::post, Router};
    use std::net::IpAddr;
    use tower::ServiceExt;
    async fn authenticated(mut req: Request<Body>, next: Next<Body>) -> Response {
        if req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            != Some("test-verified")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        req.extensions_mut().insert(PreparedQuota::Charge {
            payer: "192.0.2.1".parse::<IpAddr>().unwrap(),
            units: 2,
        });
        next.run(req).await
    }
    fn router(backend: QuotaBackend) -> axum::Router {
        let policy = Arc::new(QuotaPolicy::new(
            FixedHourQuota::<IpAddr>::with_backend(3, QuotaDomain::EvmCustomer, backend),
            |_| StatusCode::TOO_MANY_REQUESTS.into_response(),
        ));
        Router::new().route(
            "/",
            post(|body: Bytes| async move { body })
                .route_layer(axum::middleware::from_fn(admit::<IpAddr>))
                .route_layer(axum::Extension(policy))
                .route_layer(from_fn(authenticated)),
        )
    }
    #[tokio::test]
    async fn typed_router_policy_preserves_auth_body_and_weight() {
        let router = router(QuotaBackend::local());
        let request = |auth: bool| {
            let mut b = Request::post("/").header("x-quota-exempt", "true");
            if auth {
                b = b.header("authorization", "test-verified");
            }
            b.body(Body::from("exact original body")).unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(request(false))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let accepted = router.clone().oneshot(request(true)).await.unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(
            hyper::body::to_bytes(accepted.into_body()).await.unwrap(),
            "exact original body"
        );
        assert_eq!(
            router.oneshot(request(true)).await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    #[tokio::test]
    async fn outage_admits_valid_requests_without_a_fake_snapshot_but_never_invalid_auth() {
        // A silent owned listener deterministically stalls Redis setup, within the total bound.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("redis://{}/", listener.local_addr().unwrap());
        let conf = cashweb_config::HourlyQuotasConf {
            driver: cashweb_config::HourlyQuotaDriver::Redis,
            key_prefix: Some("test-router/".into()),
            timeout_ms: 20,
            ..Default::default()
        };
        let backend =
            QuotaBackend::configured("monad-regtest", &conf, |_| Some(url.clone())).unwrap();
        let router = router(backend);
        let request = |auth: bool| {
            let mut b = Request::post("/");
            if auth {
                b = b.header("authorization", "test-verified");
            }
            b.body(Body::from("body")).unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(request(false))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = router.clone().oneshot(request(true)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(matches!(
            response
                .extensions()
                .get::<super::super::hourly_quota::QuotaDecision>(),
            Some(super::super::hourly_quota::QuotaDecision::Degraded(_))
        ));
        assert!(!response.headers().contains_key("ratelimit-remaining"));
        assert_eq!(
            router
                .clone()
                .oneshot(request(true))
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "outage does not silently select a local counter"
        );
        assert_eq!(
            router.oneshot(request(false)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
