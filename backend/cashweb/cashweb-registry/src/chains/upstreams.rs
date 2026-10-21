//! Configured upstream endpoints of one chain capability, each with its own identity verdict.

use std::{
    fmt,
    sync::atomic::{AtomicBool, Ordering},
};

use url::Url;

/// One configured upstream endpoint. It carries traffic only once it has answered the chain's
/// identity probes; until then it is probed again in the background.
pub(crate) struct Upstream {
    url: Url,
    verified: AtomicBool,
}

impl Upstream {
    /// The endpoint. It may embed a provider secret: never log or display it.
    pub(crate) fn url(&self) -> &Url {
        &self.url
    }

    pub(crate) fn is_verified(&self) -> bool {
        self.verified.load(Ordering::Acquire)
    }

    pub(crate) fn mark_verified(&self) {
        self.verified.store(true, Ordering::Release);
    }
}

/// The upstreams configured for one capability (JSON-RPC, Chronik) of one chain, in
/// configuration order. Only the verified ones are handed out for traffic.
#[derive(Default)]
pub struct UpstreamSet {
    upstreams: Vec<Upstream>,
}

impl UpstreamSet {
    pub(crate) fn new(urls: Vec<Url>) -> Self {
        Self {
            upstreams: urls
                .into_iter()
                .map(|url| Upstream {
                    url,
                    verified: AtomicBool::new(false),
                })
                .collect(),
        }
    }

    /// Whether any upstream is configured for this capability.
    pub fn is_configured(&self) -> bool {
        !self.upstreams.is_empty()
    }

    /// Whether at least one upstream has proved its identity, so the capability can be served.
    pub fn has_verified(&self) -> bool {
        self.upstreams.iter().any(Upstream::is_verified)
    }

    /// Whether every configured upstream has proved its identity.
    pub fn all_verified(&self) -> bool {
        self.upstreams.iter().all(Upstream::is_verified)
    }

    /// The upstreams that may carry traffic now, in configuration order.
    pub fn verified_urls(&self) -> Vec<Url> {
        self.upstreams
            .iter()
            .filter(|upstream| upstream.is_verified())
            .map(|upstream| upstream.url.clone())
            .collect()
    }

    /// The upstreams still to be probed.
    pub(crate) fn pending(&self) -> impl Iterator<Item = &Upstream> {
        self.upstreams
            .iter()
            .filter(|upstream| !upstream.is_verified())
    }

    /// Mark every upstream verified without probing it. For tests that stand up a local
    /// endpoint and are not about identity.
    #[cfg(test)]
    pub(crate) fn assume_verified(&self) {
        self.upstreams.iter().for_each(Upstream::mark_verified);
    }
}

impl fmt::Debug for UpstreamSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Provider URLs may embed API keys: report only counts.
        f.debug_struct("UpstreamSet")
            .field("configured", &self.upstreams.len())
            .field(
                "verified",
                &self.upstreams.iter().filter(|u| u.is_verified()).count(),
            )
            .finish()
    }
}

/// Parse the upstream URLs named by `env_names`: each variable may hold several, separated by
/// commas or whitespace. Unset or blank variables contribute nothing; a token that is not a
/// hosted URL with one of `schemes` names its variable in the error. Duplicates are dropped.
pub(crate) fn resolve_urls<'a>(
    env_names: impl IntoIterator<Item = &'a str>,
    schemes: &[&str],
    env: &impl Fn(&str) -> Option<String>,
) -> Result<Vec<Url>, String> {
    let mut urls = Vec::new();
    for env_name in env_names {
        let Some(raw) = env(env_name).filter(|raw| !raw.trim().is_empty()) else {
            continue;
        };
        for token in raw
            .split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            let url = token
                .parse::<Url>()
                .ok()
                .filter(|url| schemes.contains(&url.scheme()) && url.host_str().is_some())
                .ok_or_else(|| env_name.to_string())?;
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_upstreams_are_handed_out() {
        let urls: Vec<Url> = ["http://a.example/k1", "http://b.example/k2"]
            .iter()
            .map(|url| url.parse().unwrap())
            .collect();
        let set = UpstreamSet::new(urls.clone());
        assert!(set.is_configured());
        assert!(!set.has_verified());
        assert!(set.verified_urls().is_empty());
        set.pending().nth(1).unwrap().mark_verified();
        assert!(set.has_verified());
        assert!(!set.all_verified());
        assert_eq!(set.verified_urls(), vec![urls[1].clone()]);
        assert_eq!(set.pending().count(), 1);
        let rendered = format!("{set:?}");
        assert!(!rendered.contains("k1") && !rendered.contains("k2"));
    }

    #[test]
    fn resolve_urls_names_the_variable_of_a_bad_token() {
        let env = |name: &str| match name {
            "GOOD" => Some("http://a.example, http://b.example\nhttp://a.example".to_string()),
            "BLANK" => Some("  ".to_string()),
            "BAD" => Some("http://ok.example,tcp://wrong.example".to_string()),
            _ => None,
        };
        assert_eq!(
            resolve_urls(["GOOD", "BLANK", "UNSET"], &["http", "https"], &env)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            resolve_urls(["BAD"], &["http", "https"], &env),
            Err("BAD".to_string())
        );
    }
}
