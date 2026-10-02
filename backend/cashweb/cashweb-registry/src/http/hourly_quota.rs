//! In-memory fixed-hour quotas for bursty public APIs.

use std::{collections::HashMap, hash::Hash, sync::Mutex};

const MAX_QUOTA_KEYS: usize = 100_000;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct QuotaSnapshot {
    pub(crate) limit: u32,
    pub(crate) remaining: u32,
    pub(crate) reset_unix_seconds: u64,
}

#[derive(Debug, Clone, Copy)]
struct Usage {
    hour: u64,
    units: u32,
}

/// A fixed UTC-hour quota. Callers may spend the whole allowance at once; there is no pacing.
#[derive(Debug)]
pub(crate) struct FixedHourQuota<K> {
    limit: u32,
    usage: Mutex<HashMap<K, Usage>>,
}

impl<K: Eq + Hash + Clone> FixedHourQuota<K> {
    pub(crate) fn new(limit: u32) -> Self {
        Self {
            limit,
            usage: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn charge(&self, key: K, units: u32, now_seconds: u64) -> Option<QuotaSnapshot> {
        if self.limit == 0 || units > self.limit {
            return None;
        }
        let hour = now_seconds / 3600;
        let mut usage = self.usage.lock().ok()?;
        if usage.len() >= MAX_QUOTA_KEYS && !usage.contains_key(&key) {
            usage.retain(|_, value| value.hour == hour);
            if usage.len() >= MAX_QUOTA_KEYS {
                return None;
            }
        }
        let entry = usage.entry(key).or_insert(Usage { hour, units: 0 });
        if entry.hour != hour {
            *entry = Usage { hour, units: 0 };
        }
        let next = entry.units.checked_add(units)?;
        if next > self.limit {
            return None;
        }
        entry.units = next;
        Some(QuotaSnapshot {
            limit: self.limit,
            remaining: self.limit - next,
            reset_unix_seconds: (hour + 1) * 3600,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_bursts_and_resets_only_at_the_hour_boundary() {
        let quota = FixedHourQuota::new(5);
        assert_eq!(quota.charge("a", 5, 3599).unwrap().remaining, 0);
        assert!(quota.charge("a", 1, 3599).is_none());
        assert_eq!(quota.charge("a", 1, 3600).unwrap().remaining, 4);
    }
}
