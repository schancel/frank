//! Tracking and circuit breaker for healthy/cooling upstream RPC endpoints.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use rand::seq::SliceRandom;
use url::Url;

/// Default cooldown period when an upstream returns 429, 5xx, or network failure.
pub(crate) const DEFAULT_UPSTREAM_COOLDOWN: Duration = Duration::from_secs(30);

/// Tracks temporary cooldowns for RPC/indexer upstream endpoints to avoid hammering failing or
/// rate-limited nodes.
#[derive(Clone, Debug)]
pub(crate) struct UpstreamCooldownTracker {
    cooldowns: Arc<Mutex<HashMap<Url, Instant>>>,
    duration: Duration,
}

impl Default for UpstreamCooldownTracker {
    fn default() -> Self {
        Self::new(DEFAULT_UPSTREAM_COOLDOWN)
    }
}

impl UpstreamCooldownTracker {
    pub(crate) fn new(duration: Duration) -> Self {
        Self {
            cooldowns: Arc::new(Mutex::new(HashMap::new())),
            duration,
        }
    }

    /// Mark an upstream as failed / rate-limited, cooling it down for the configured duration.
    pub(crate) fn mark_failure(&self, url: &Url) {
        if let Ok(mut lock) = self.cooldowns.lock() {
            lock.insert(url.clone(), Instant::now() + self.duration);
        }
    }

    /// Mark an upstream as healthy / successful, clearing any active cooldown.
    pub(crate) fn mark_success(&self, url: &Url) {
        if let Ok(mut lock) = self.cooldowns.lock() {
            lock.remove(url);
        }
    }

    /// Select an ordered list of upstreams to attempt.
    /// Healthy upstreams (not currently in cooldown) are randomly splayed first.
    /// If all upstreams are currently in cooldown, all upstreams are randomly splayed.
    /// Any remaining cooling upstreams are appended afterwards as last-resort fallbacks.
    pub(crate) fn splay_order<'a>(&self, upstreams: &'a [Url]) -> Vec<&'a Url> {
        if upstreams.is_empty() {
            return Vec::new();
        }
        if upstreams.len() == 1 {
            return vec![&upstreams[0]];
        }

        let now = Instant::now();
        let mut healthy = Vec::new();
        let mut cooling = Vec::new();

        if let Ok(mut lock) = self.cooldowns.lock() {
            // Prune expired cooldowns
            lock.retain(|_, expiry| *expiry > now);
            for url in upstreams {
                if lock.contains_key(url) {
                    cooling.push(url);
                } else {
                    healthy.push(url);
                }
            }
        } else {
            for url in upstreams {
                healthy.push(url);
            }
        }

        let mut rng = rand::thread_rng();

        if healthy.is_empty() {
            // All upstreams are cooling; shuffle all of them to give each a chance
            let mut all: Vec<&'a Url> = upstreams.iter().collect();
            all.shuffle(&mut rng);
            return all;
        }

        // Random splay among healthy upstreams
        healthy.shuffle(&mut rng);
        // Append cooling upstreams as fallbacks
        cooling.shuffle(&mut rng);
        healthy.extend(cooling);
        healthy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_splay_order_prefers_healthy() {
        let tracker = UpstreamCooldownTracker::new(Duration::from_secs(60));
        let u1 = Url::parse("https://rpc1.example.com").unwrap();
        let u2 = Url::parse("https://rpc2.example.com").unwrap();
        let u3 = Url::parse("https://rpc3.example.com").unwrap();
        let upstreams = vec![u1.clone(), u2.clone(), u3.clone()];

        // Mark u1 in cooldown
        tracker.mark_failure(&u1);

        let order = tracker.splay_order(&upstreams);
        assert_eq!(order.len(), 3);
        // u1 must be at the very end (index 2)
        assert_eq!(order[2], &u1);
        assert!(order[0] == &u2 || order[0] == &u3);
        assert!(order[1] == &u2 || order[1] == &u3);

        // Mark u1 successful, clearing cooldown
        tracker.mark_success(&u1);
        let order2 = tracker.splay_order(&upstreams);
        assert_eq!(order2.len(), 3);
    }

    #[test]
    fn test_splay_order_all_cooling_falls_back() {
        let tracker = UpstreamCooldownTracker::new(Duration::from_secs(60));
        let u1 = Url::parse("https://rpc1.example.com").unwrap();
        let u2 = Url::parse("https://rpc2.example.com").unwrap();
        let upstreams = vec![u1.clone(), u2.clone()];

        tracker.mark_failure(&u1);
        tracker.mark_failure(&u2);

        let order = tracker.splay_order(&upstreams);
        // When all cooling, still returns both
        assert_eq!(order.len(), 2);
    }
}
