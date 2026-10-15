//! Private, low-cardinality Prometheus metrics served on a separately bound listener.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use axum::{http::header, response::IntoResponse, routing, Router};

use crate::registry::Registry;

const PROFILE_COUNT_REFRESH: Duration = Duration::from_secs(300);
const PROFILE_COUNT_NAME: &str = "frank_registry_stored_public_profile_records";

#[derive(Debug, Default)]
struct Snapshot {
    profile_count: AtomicU64,
    profile_count_available: AtomicBool,
}

impl Snapshot {
    fn refresh(&self, registry: &Registry) {
        match registry.stored_public_profile_record_count() {
            Ok(count) => {
                self.profile_count.store(count, Ordering::Relaxed);
                self.profile_count_available.store(true, Ordering::Relaxed);
            }
            Err(error) => {
                self.profile_count_available.store(false, Ordering::Relaxed);
                tracing::warn!(error = %error, "Unable to refresh stored public profile count metric");
            }
        }
    }

    fn render(&self) -> String {
        let mut output = format!(
            "# HELP {PROFILE_COUNT_NAME} Current address-keyed public profile rows stored by this relay.\n# TYPE {PROFILE_COUNT_NAME} gauge\n"
        );
        if self.profile_count_available.load(Ordering::Relaxed) {
            output.push_str(&format!(
                "{PROFILE_COUNT_NAME} {}\n",
                self.profile_count.load(Ordering::Relaxed)
            ));
        }
        output
    }
}

/// Build the isolated metrics router and refresh durable aggregate counts in the background.
/// The router exports no address, key, IP, message, transaction, or other user-derived labels.
pub fn router(registry: Arc<Registry>) -> Router {
    let snapshot = Arc::new(Snapshot::default());
    snapshot.refresh(&registry);

    let refresh_snapshot = Arc::clone(&snapshot);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PROFILE_COUNT_REFRESH);
        interval.tick().await;
        loop {
            interval.tick().await;
            refresh_snapshot.refresh(&registry);
        }
    });

    Router::new().route(
        "/metrics",
        routing::get(move || {
            let snapshot = Arc::clone(&snapshot);
            async move {
                (
                    [(
                        header::CONTENT_TYPE,
                        "text/plain; version=0.0.4; charset=utf-8",
                    )],
                    snapshot.render(),
                )
                    .into_response()
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::{Snapshot, PROFILE_COUNT_NAME};
    use std::sync::atomic::Ordering;

    #[test]
    fn unavailable_count_is_not_reported_as_zero() {
        let snapshot = Snapshot::default();
        let output = snapshot.render();
        assert!(output.contains("# TYPE frank_registry_stored_public_profile_records gauge"));
        assert!(!output.contains("frank_registry_stored_public_profile_records 0"));
    }

    #[test]
    fn renders_only_the_aggregate_without_labels() {
        let snapshot = Snapshot::default();
        snapshot.profile_count.store(17, Ordering::Relaxed);
        snapshot
            .profile_count_available
            .store(true, Ordering::Relaxed);
        let output = snapshot.render();
        assert!(output.contains(&format!("{PROFILE_COUNT_NAME} 17")));
        let sample_lines = output
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>();
        assert_eq!(sample_lines, [format!("{PROFILE_COUNT_NAME} 17")]);
        assert!(!sample_lines[0].contains('{'));
    }
}
