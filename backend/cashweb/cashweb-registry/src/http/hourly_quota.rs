//! Hourly allowance owner. Local standalone behavior is explicit; Redis shared allowances
//! degrade open on backend failures without changing durable business or request authentication.
use super::redis_quota::{RedisFailure, RedisQuota};
use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv6Addr},
    sync::{Arc, Mutex},
};
const MAX_QUOTA_KEYS: usize = 100_000;
#[derive(Debug, Clone)]
/// Explicit host selection of local counters or ephemeral shared Redis admission.
pub struct QuotaBackend {
    kind: Backend,
}
#[derive(Debug, Clone)]
enum Backend {
    Local,
    Redis(Arc<RedisQuota>),
    #[cfg(test)]
    Paused(Arc<tests::PausedTransaction>),
}
impl QuotaBackend {
    /// Preserve the existing standalone process-local allowance.
    pub fn local() -> Self {
        Self {
            kind: Backend::Local,
        }
    }
    /// Validate operator configuration without connecting to Redis. Backend outages are
    /// handled per request; malformed configuration never selects another backend.
    pub fn configured(
        network: &str,
        conf: &cashweb_config::HourlyQuotasConf,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, &'static str> {
        conf.validate()?;
        match conf.driver {
            cashweb_config::HourlyQuotaDriver::Local => Ok(Self::local()),
            cashweb_config::HourlyQuotaDriver::Redis => {
                let url = env(&conf.redis_url_env).ok_or("missing Redis quota URL environment")?;
                let redis = RedisQuota::new(
                    network,
                    &url,
                    conf.key_prefix.clone().expect("validated"),
                    conf.timeout_ms,
                    conf.max_in_flight,
                )?;
                Ok(Self {
                    kind: Backend::Redis(Arc::new(redis)),
                })
            }
        }
    }
}
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub(crate) enum QuotaDomain {
    DirectoryEnrollment = 0,
    EvmCustomer = 1,
    EvmAnonymous = 2,
    BitcoinAnonymous = 3,
    BitcoinCustomer = 4,
    SolanaCustomer = 5,
    SolanaAnonymous = 6,
}

pub(crate) trait QuotaIdentity: Eq + Hash + Clone + Send {
    fn quota_bytes(&self) -> Vec<u8>;
}
impl QuotaIdentity for IpAddr {
    fn quota_bytes(&self) -> Vec<u8> {
        match self {
            IpAddr::V4(ip) => [vec![4], ip.octets().to_vec()].concat(),
            IpAddr::V6(ip) => [vec![6], ip.octets().to_vec()].concat(),
        }
    }
}
impl QuotaIdentity for crate::evm_rpc::Address {
    fn quota_bytes(&self) -> Vec<u8> {
        self.0.to_vec()
    }
}
#[cfg(test)]
impl QuotaIdentity for &'static str {
    fn quota_bytes(&self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct QuotaSnapshot {
    pub(crate) limit: u32,
    pub(crate) remaining: u32,
    pub(crate) reset_unix_seconds: u64,
}
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum QuotaDenial {
    Exhausted { reset_unix_seconds: u64 },
    Disabled,
    RequestTooLarge,
    Capacity,
    Unavailable,
}
#[derive(Debug, Clone, Copy)]
struct Usage {
    units: u32,
}

/// Degraded admission deliberately has no measured limit/remaining snapshot.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum QuotaDecision {
    Enforced(QuotaSnapshot),
    Degraded(RedisFailure),
}
impl QuotaDecision {
    #[cfg(test)]
    pub(crate) fn snapshot(self) -> Option<QuotaSnapshot> {
        match self {
            Self::Enforced(s) => Some(s),
            Self::Degraded(_) => None,
        }
    }
}
#[derive(Debug)]
pub(crate) struct FixedHourQuota<K> {
    limit: u32,
    domain: QuotaDomain,
    backend: QuotaBackend,
    state: Mutex<QuotaState<K>>,
}
#[derive(Debug)]
struct QuotaState<K> {
    hour: Option<u64>,
    usage: HashMap<K, Usage>,
}
impl<K: QuotaIdentity> FixedHourQuota<K> {
    #[cfg(test)]
    pub(crate) fn new(limit: u32) -> Self {
        Self::with_backend(limit, QuotaDomain::EvmCustomer, QuotaBackend::local())
    }
    pub(crate) fn with_backend(limit: u32, domain: QuotaDomain, backend: QuotaBackend) -> Self {
        Self {
            limit,
            domain,
            backend,
            state: Mutex::new(QuotaState {
                hour: None,
                usage: HashMap::new(),
            }),
        }
    }
    pub(crate) async fn charge(
        &self,
        key: K,
        units: u32,
        now_seconds: u64,
    ) -> Result<QuotaDecision, QuotaDenial> {
        if self.limit == 0 {
            return Err(QuotaDenial::Disabled);
        }
        if units > self.limit {
            return Err(QuotaDenial::RequestTooLarge);
        }
        let active = {
            let mut state = self.state.lock().map_err(|_| QuotaDenial::Unavailable)?;
            let hour = now_seconds / 3600;
            if state.hour.map_or(true, |active| hour > active) {
                state.hour = Some(hour);
                state.usage.clear();
            }
            let active = state.hour.expect("initialized above");
            if matches!(self.backend.kind, Backend::Local) {
                if state.usage.len() >= MAX_QUOTA_KEYS && !state.usage.contains_key(&key) {
                    return Err(QuotaDenial::Capacity);
                }
                let entry = state.usage.entry(key).or_insert(Usage { units: 0 });
                let next = entry
                    .units
                    .checked_add(units)
                    .ok_or(QuotaDenial::Unavailable)?;
                if next > self.limit {
                    return Err(QuotaDenial::Exhausted {
                        reset_unix_seconds: (active + 1) * 3600,
                    });
                }
                entry.units = next;
                return Ok(QuotaDecision::Enforced(QuotaSnapshot {
                    limit: self.limit,
                    remaining: self.limit - next,
                    reset_unix_seconds: (active + 1) * 3600,
                }));
            }
            active
        };
        match &self.backend.kind {
            Backend::Local => unreachable!(),
            Backend::Redis(redis) => {
                redis
                    .charge(self.domain, key.quota_bytes(), units, self.limit, active)
                    .await
            }
            #[cfg(test)]
            Backend::Paused(paused) => {
                paused.wait().await;
                Ok(QuotaDecision::Enforced(QuotaSnapshot {
                    limit: self.limit,
                    remaining: self.limit - units,
                    reset_unix_seconds: (active + 1) * 3600,
                }))
            }
        }
    }
}
pub(crate) fn normalize_quota_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(ip) => IpAddr::V4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => IpAddr::V4(ip),
            None => IpAddr::V6(Ipv6Addr::from(u128::from(ip) & (!0u128 << 64))),
        },
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn redis_backend(network: &str) -> QuotaBackend {
        let url = std::env::var("FRANK_QUOTA_TEST_REDIS_URL")
            .expect("explicit approved Redis test URL required");
        let conf = cashweb_config::HourlyQuotasConf {
            driver: cashweb_config::HourlyQuotaDriver::Redis,
            key_prefix: Some(format!("frank-quota-test/{}/", uuid::Uuid::new_v4())),
            ..Default::default()
        };
        QuotaBackend::configured(network, &conf, |_| Some(url.clone())).unwrap()
    }

    #[derive(Debug)]
    pub(crate) struct PausedTransaction {
        pause: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        released: tokio::sync::Notify,
    }
    impl PausedTransaction {
        pub(crate) fn pause_next(&self) {
            self.pause.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) async fn wait_entered(&self) {
            tokio::time::timeout(std::time::Duration::from_secs(2), self.entered.notified())
                .await
                .unwrap();
        }
        pub(crate) fn resume(&self) {
            self.released.notify_one();
        }
        pub(super) async fn wait(&self) {
            if self.pause.swap(false, std::sync::atomic::Ordering::SeqCst) {
                self.entered.notify_one();
                self.released.notified().await;
            }
        }
    }
    pub(crate) fn paused_backend() -> (tempfile::TempDir, Arc<PausedTransaction>, QuotaBackend) {
        let pause = Arc::new(PausedTransaction {
            pause: std::sync::atomic::AtomicBool::new(false),
            entered: tokio::sync::Notify::new(),
            released: tokio::sync::Notify::new(),
        });
        (
            tempfile::tempdir().unwrap(),
            pause.clone(),
            QuotaBackend {
                kind: Backend::Paused(pause),
            },
        )
    }
    /// Real loopback sockets; the upgraded Axum half is handed to the production proxy loop.
    pub(crate) async fn websocket_pair() -> (
        axum::extract::ws::WebSocket,
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) {
        use axum::{extract::ws::WebSocketUpgrade, routing::get, Router};
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let router = Router::new().route(
            "/",
            get(move |ws: WebSocketUpgrade| {
                let sender = sender.lock().unwrap().take().unwrap();
                async move {
                    ws.on_upgrade(move |socket| async move {
                        let _ = sender.send(socket);
                    })
                }
            }),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service()),
        );
        let (client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let socket = receiver.await.unwrap();
        server.abort();
        let _ = server.await;
        (socket, client)
    }
    #[tokio::test]
    async fn local_limits_and_clock_semantics_remain() {
        let q = FixedHourQuota::new(4);
        assert_eq!(
            q.charge("a", 3, 10)
                .await
                .unwrap()
                .snapshot()
                .unwrap()
                .remaining,
            1
        );
        assert!(matches!(
            q.charge("a", 2, 3599).await,
            Err(QuotaDenial::Exhausted { .. })
        ));
        assert_eq!(
            q.charge("a", 1, 3600)
                .await
                .unwrap()
                .snapshot()
                .unwrap()
                .remaining,
            3
        );
        assert_eq!(
            q.charge("a", 1, 5)
                .await
                .unwrap()
                .snapshot()
                .unwrap()
                .remaining,
            2
        );
        assert_eq!(
            q.charge("a", 5, 3600).await,
            Err(QuotaDenial::RequestTooLarge)
        );
        assert_eq!(
            FixedHourQuota::new(0).charge("a", 1, 0).await,
            Err(QuotaDenial::Disabled)
        );
    }
    #[test]
    fn source_ip_identity_is_unchanged() {
        assert_eq!(
            normalize_quota_ip("::ffff:192.0.2.1".parse().unwrap()),
            "192.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalize_quota_ip("2001:db8:1:2::1234".parse().unwrap()),
            "2001:db8:1:2::".parse::<IpAddr>().unwrap()
        );
    }
    #[test]
    fn malformed_static_redis_config_is_not_an_outage_or_a_default_network() {
        let conf = cashweb_config::HourlyQuotasConf {
            driver: cashweb_config::HourlyQuotaDriver::Redis,
            key_prefix: Some("tests/".into()),
            ..Default::default()
        };
        assert!(QuotaBackend::configured("monad-regtest", &conf, |_| None).is_err());
        assert!(QuotaBackend::configured("monad-regtest", &conf, |_| Some(
            "http://wrong.invalid".into()
        ))
        .is_err());
        assert!(
            QuotaBackend::configured("evm", &conf, |_| Some("redis://127.0.0.1:1".into())).is_err()
        );
        assert!(
            QuotaBackend::configured("monad-regtest", &conf, |_| Some(
                "redis://127.0.0.1:1".into()
            ))
            .is_ok(),
            "valid unavailable endpoint must not block startup"
        );
    }
}
