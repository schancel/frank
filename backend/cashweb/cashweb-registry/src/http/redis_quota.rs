//! Ephemeral shared allowance. A Redis failure is an observable, bounded fail-open decision.
use super::hourly_quota::{QuotaDecision, QuotaDenial, QuotaDomain, QuotaSnapshot};
use redis::{aio::MultiplexedConnection, AsyncConnectionConfig};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

// Validate arguments, existing data and command permissions before either write. Redis 7+
// ACL checks prevent a restricted user from incrementing usage then refusing EXPIREAT.
const CHARGE: &str = r#"
local units, limit, expiry, cap = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local function integer(n, max) return n and n >= 0 and n <= max and n == math.floor(n) end
if not integer(units, 4294967295) or not integer(limit, 4294967295) or limit == 0 or units > limit
 or not integer(expiry, 9007199254740991) or expiry == 0 or not integer(cap, 100000) or cap == 0
 then return {-3, 0} end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local current = 0
if raw then current = tonumber(raw) end
if not integer(current, 4294967295) then return {-3, 0} end
if not raw and redis.call('HLEN', KEYS[1]) >= cap then return {-2, 0} end
local next = current + units
if next > limit then return {-1, 0} end
if not redis.acl_check_cmd('HSET', KEYS[1], ARGV[1], next)
 or not redis.acl_check_cmd('EXPIREAT', KEYS[1], expiry) then return {-3, 0} end
redis.call('HSET', KEYS[1], ARGV[1], next)
redis.call('EXPIREAT', KEYS[1], expiry)
return {0, limit - next}
"#;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum RedisFailure {
    Busy,
    Cooldown,
    Timeout,
    Transport,
    Authentication,
    Command,
    Protocol,
}
impl RedisFailure {
    fn label(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Cooldown => "cooldown",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::Authentication => "authentication",
            Self::Command => "command",
            Self::Protocol => "protocol",
        }
    }
    fn classify(error: &redis::RedisError) -> Self {
        if error.kind() == redis::ErrorKind::AuthenticationFailed {
            Self::Authentication
        } else if error.is_io_error() {
            Self::Transport
        } else {
            Self::Command
        }
    }
}
struct ConnectionState {
    connection: Option<MultiplexedConnection>,
    generation: u64,
    retry_at: Instant,
}
pub(super) struct RedisQuota {
    client: redis::Client,
    prefix: String,
    network: String,
    timeout: Duration,
    max_in_flight: usize,
    permits: Arc<Semaphore>,
    state: Mutex<ConnectionState>,
    connector: tokio::sync::Mutex<()>,
    next_warning: Mutex<Instant>,
}
impl std::fmt::Debug for RedisQuota {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // redis::Client's Debug may include credentials; never delegate to it.
        f.debug_struct("RedisQuota")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}
impl RedisQuota {
    pub(super) fn new(
        network: &str,
        url: &str,
        prefix: String,
        timeout_ms: u64,
        max_in_flight: usize,
    ) -> Result<Self, &'static str> {
        if cashweb_config::protocol_chain(network).is_none() {
            return Err("unknown canonical quota network");
        }
        let parsed = url::Url::parse(url).map_err(|_| "invalid Redis quota URL")?;
        if parsed.scheme() != "redis" || parsed.host_str().is_none() || parsed.port() == Some(0) {
            return Err("Redis quotas require a valid redis:// URL");
        }
        let client = redis::Client::open(url).map_err(|_| "invalid Redis quota URL")?;
        Ok(Self {
            client,
            prefix,
            network: network.into(),
            timeout: Duration::from_millis(timeout_ms),
            max_in_flight,
            permits: Arc::new(Semaphore::new(max_in_flight)),
            state: Mutex::new(ConnectionState {
                connection: None,
                generation: 0,
                retry_at: Instant::now(),
            }),
            connector: tokio::sync::Mutex::new(()),
            next_warning: Mutex::new(Instant::now()),
        })
    }
    fn degraded(&self, reason: RedisFailure) -> QuotaDecision {
        // One fixed-field warning per backend per 30 seconds, including saturation/cooldown.
        // No URL, payer, key, request body, capability or Redis error text is retained/logged.
        if let Ok(mut next) = self.next_warning.lock() {
            if Instant::now() >= *next {
                *next = Instant::now() + Duration::from_secs(30);
                tracing::warn!(target:"frank::quota", chainIdentifier=self.network.as_str(), error_class=reason.label(), decision="fail_open", "Hourly Redis allowance unavailable");
            }
        }
        QuotaDecision::Degraded(reason)
    }
    fn cached(&self) -> Result<Option<(MultiplexedConnection, u64)>, RedisFailure> {
        let state = self.state.lock().map_err(|_| RedisFailure::Protocol)?;
        if let Some(connection) = &state.connection {
            return Ok(Some((connection.clone(), state.generation)));
        }
        if Instant::now() < state.retry_at {
            return Err(RedisFailure::Cooldown);
        }
        Ok(None)
    }
    fn retire(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if generation == 0 || state.generation == generation {
                state.connection = None;
                // All old workers have expired before a replacement can be created. This
                // also drops their last driver handles and its unanswered-command backlog.
                state.retry_at = Instant::now() + self.timeout.max(Duration::from_secs(1));
            }
        }
    }
    async fn connection(&self) -> Result<(MultiplexedConnection, u64), RedisFailure> {
        if let Some(connection) = self.cached()? {
            return Ok(connection);
        }
        let _connecting = self.connector.lock().await;
        if let Some(connection) = self.cached()? {
            return Ok(connection);
        }
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.timeout))
            .set_response_timeout(Some(self.timeout))
            .set_pipeline_buffer_size(self.max_in_flight)
            .set_concurrency_limit(self.max_in_flight);
        let connection = match self
            .client
            .get_multiplexed_async_connection_with_config(&config)
            .await
        {
            Ok(connection) => connection,
            Err(error) => {
                self.retire(0);
                return Err(RedisFailure::classify(&error));
            }
        };
        let mut state = self.state.lock().map_err(|_| RedisFailure::Protocol)?;
        state.generation = state.generation.wrapping_add(1);
        state.connection = Some(connection.clone());
        Ok((connection, state.generation))
    }
    pub(super) async fn charge(
        self: &Arc<Self>,
        domain: QuotaDomain,
        payer: Vec<u8>,
        units: u32,
        limit: u32,
        hour: u64,
    ) -> Result<QuotaDecision, QuotaDenial> {
        let deadline = tokio::time::Instant::now() + self.timeout;
        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            return Ok(self.degraded(RedisFailure::Busy));
        };
        let backend = self.clone();
        // Admission bounds the task count BEFORE spawning. Caller/WS cancellation detaches
        // only its wait; this worker retains both permit and deadline through real completion.
        let worker = tokio::spawn(async move {
            let _permit = permit;
            backend
                .execute(domain, payer, units, limit, hour, deadline)
                .await
        });
        match worker.await {
            Ok(result) => result,
            Err(_) => {
                self.retire(0);
                Ok(self.degraded(RedisFailure::Protocol))
            }
        }
    }
    async fn execute(
        &self,
        domain: QuotaDomain,
        payer: Vec<u8>,
        units: u32,
        limit: u32,
        hour: u64,
        deadline: tokio::time::Instant,
    ) -> Result<QuotaDecision, QuotaDenial> {
        let mut generation = 0;
        let operation = async {
            if tokio::time::Instant::now() >= deadline {
                return Err(RedisFailure::Timeout);
            }
            let (mut connection, active) = self.connection().await?;
            generation = active;
            let expiry = hour
                .checked_add(2)
                .and_then(|h| h.checked_mul(3600))
                .ok_or(RedisFailure::Protocol)?;
            let key = format!(
                "{}v1:{}:{}:{}",
                self.prefix, self.network, domain as u8, hour
            );
            redis::cmd("EVAL")
                .arg(CHARGE)
                .arg(1)
                .arg(key)
                .arg(hex::encode(payer))
                .arg(units)
                .arg(limit)
                .arg(expiry)
                .arg(100_000)
                .query_async::<(i64, i64)>(&mut connection)
                .await
                .map_err(|e| RedisFailure::classify(&e))
        };
        let mut result = match tokio::time::timeout_at(deadline, operation).await {
            Ok(result) => result,
            Err(_) => Err(RedisFailure::Timeout),
        };
        if tokio::time::Instant::now() >= deadline {
            result = Err(RedisFailure::Timeout);
        }
        match result {
            Ok((0, remaining)) if remaining >= 0 && remaining <= i64::from(limit) => {
                Ok(QuotaDecision::Enforced(QuotaSnapshot {
                    limit,
                    remaining: remaining as u32,
                    reset_unix_seconds: (hour + 1) * 3600,
                }))
            }
            Ok((-1, _)) => Err(QuotaDenial::Exhausted {
                reset_unix_seconds: (hour + 1) * 3600,
            }),
            Ok((-2, _)) => Err(QuotaDenial::Capacity),
            Ok(_) => Ok(self.degraded(RedisFailure::Protocol)),
            Err(reason) => {
                if !matches!(reason, RedisFailure::Busy | RedisFailure::Cooldown) {
                    self.retire(generation);
                }
                Ok(self.degraded(reason))
            }
        }
    }
}

#[cfg(test)]
#[path = "redis_quota_tests.rs"]
mod tests;
