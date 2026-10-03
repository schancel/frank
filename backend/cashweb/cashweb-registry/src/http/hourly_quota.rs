//! In-memory fixed-hour quotas for bursty public APIs.

use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv6Addr},
    sync::Mutex,
};

const MAX_QUOTA_KEYS: usize = 100_000;

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

/// A fixed UTC-hour quota. Callers may spend the whole allowance at once; there is no pacing.
#[derive(Debug)]
pub(crate) struct FixedHourQuota<K> {
    limit: u32,
    state: Mutex<QuotaState<K>>,
}

#[derive(Debug)]
struct QuotaState<K> {
    hour: Option<u64>,
    usage: HashMap<K, Usage>,
}

impl<K: Eq + Hash + Clone> FixedHourQuota<K> {
    pub(crate) fn new(limit: u32) -> Self {
        Self {
            limit,
            state: Mutex::new(QuotaState {
                hour: None,
                usage: HashMap::new(),
            }),
        }
    }

    pub(crate) fn charge(
        &self,
        key: K,
        units: u32,
        now_seconds: u64,
    ) -> Result<QuotaSnapshot, QuotaDenial> {
        if self.limit == 0 {
            return Err(QuotaDenial::Disabled);
        }
        if units > self.limit {
            return Err(QuotaDenial::RequestTooLarge);
        }
        let hour = now_seconds / 3600;
        let mut state = self.state.lock().map_err(|_| QuotaDenial::Unavailable)?;
        if match state.hour {
            Some(active) => hour > active,
            None => true,
        } {
            state.hour = Some(hour);
            state.usage.clear();
        }
        let active_hour = state.hour.expect("quota hour initialized above");
        let reset_unix_seconds = (active_hour + 1) * 3600;
        if state.usage.len() >= MAX_QUOTA_KEYS && !state.usage.contains_key(&key) {
            return Err(QuotaDenial::Capacity);
        }
        let entry = state.usage.entry(key).or_insert(Usage { units: 0 });
        let next = entry
            .units
            .checked_add(units)
            .ok_or(QuotaDenial::Unavailable)?;
        if next > self.limit {
            return Err(QuotaDenial::Exhausted { reset_unix_seconds });
        }
        entry.units = next;
        Ok(QuotaSnapshot {
            limit: self.limit,
            remaining: self.limit - next,
            reset_unix_seconds,
        })
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
mod tests {
    use super::*;

    #[test]
    fn permits_bursts_and_resets_only_at_the_hour_boundary() {
        let quota = FixedHourQuota::new(5);
        assert_eq!(quota.charge("a", 5, 3599).unwrap().remaining, 0);
        assert_eq!(
            quota.charge("a", 1, 3599),
            Err(QuotaDenial::Exhausted {
                reset_unix_seconds: 3600
            })
        );
        assert_eq!(quota.charge("a", 1, 3600).unwrap().remaining, 4);
        assert_eq!(
            quota.charge("a", 6, 3600),
            Err(QuotaDenial::RequestTooLarge)
        );
        assert_eq!(
            FixedHourQuota::new(0).charge("a", 1, 3600),
            Err(QuotaDenial::Disabled)
        );

        let quota = FixedHourQuota::new(1);
        assert_eq!(quota.charge("a", 1, 3600).unwrap().remaining, 0);
        assert_eq!(quota.charge("b", 1, 3599).unwrap().remaining, 0);
        assert_eq!(
            quota.charge("a", 1, 3600),
            Err(QuotaDenial::Exhausted {
                reset_unix_seconds: 7200
            })
        );
    }

    #[test]
    fn quota_ip_preserves_ipv4_and_groups_native_ipv6_by_prefix() {
        assert_eq!(
            normalize_quota_ip("::ffff:192.0.2.1".parse().unwrap()),
            "192.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalize_quota_ip("::ffff:192.0.2.2".parse().unwrap()),
            "192.0.2.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalize_quota_ip("2001:db8:1:2::1234".parse().unwrap()),
            "2001:db8:1:2::".parse::<IpAddr>().unwrap()
        );
    }
}
