//! Private, low-cardinality Prometheus metrics served on a separately bound listener.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use axum::{http::header, response::IntoResponse, routing, Router};

use crate::registry::Registry;

const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const PROFILE_COUNT_NAME: &str = "frank_registry_stored_public_profile_records";
const TOPIC_POST_COUNT_NAME: &str = "frank_registry_stored_topic_posts";
const REGISTRY_BYTES_NAME: &str = "frank_registry_rocksdb_estimated_live_data_bytes";
const DIRECT_MESSAGE_BYTES_NAME: &str = "frank_direct_messages_rocksdb_estimated_live_data_bytes";
const DIRECT_MESSAGES_TOTAL_NAME: &str = "frank_canonical_messages_stored_total";

#[derive(Debug, Default)]
struct Snapshot {
    profile_count: AtomicU64,
    profile_count_available: AtomicBool,
    topic_post_count: AtomicU64,
    topic_post_count_available: AtomicBool,
    registry_bytes: AtomicU64,
    registry_bytes_available: AtomicBool,
    direct_message_bytes: AtomicU64,
    direct_message_bytes_available: AtomicBool,
}

impl Snapshot {
    fn refresh(&self, registry: &Registry) {
        self.update(
            PROFILE_COUNT_NAME,
            registry
                .stored_public_profile_record_count()
                .map_err(|e| e.to_string()),
            &self.profile_count,
            &self.profile_count_available,
        );
        self.update(
            TOPIC_POST_COUNT_NAME,
            registry
                .stored_topic_post_count()
                .map_err(|e| e.to_string()),
            &self.topic_post_count,
            &self.topic_post_count_available,
        );
        self.update(
            REGISTRY_BYTES_NAME,
            registry
                .registry_estimated_live_data_size_bytes()
                .map_err(|e| e.to_string()),
            &self.registry_bytes,
            &self.registry_bytes_available,
        );
        self.update(
            DIRECT_MESSAGE_BYTES_NAME,
            registry
                .direct_messages_estimated_live_data_size_bytes()
                .map(|bytes| bytes.unwrap_or(0))
                .map_err(|e| e.to_string()),
            &self.direct_message_bytes,
            &self.direct_message_bytes_available,
        );
    }

    fn update(
        &self,
        name: &str,
        result: std::result::Result<u64, String>,
        value: &AtomicU64,
        available: &AtomicBool,
    ) {
        match result {
            Ok(current) => {
                value.store(current, Ordering::Relaxed);
                available.store(true, Ordering::Relaxed);
            }
            Err(error) => {
                available.store(false, Ordering::Relaxed);
                tracing::warn!(metric = name, error = %error, "Unable to refresh relay metric");
            }
        }
    }

    fn render(&self, registry: &Registry) -> String {
        let mut output = String::new();
        append_gauge(
            &mut output,
            PROFILE_COUNT_NAME,
            "Current address-keyed public profile rows stored by this relay.",
            &self.profile_count,
            &self.profile_count_available,
        );
        append_gauge(
            &mut output,
            TOPIC_POST_COUNT_NAME,
            "Current indexed topic posts stored by this relay, including legacy and CBOR posts.",
            &self.topic_post_count,
            &self.topic_post_count_available,
        );
        append_gauge(
            &mut output,
            REGISTRY_BYTES_NAME,
            "Approximate live key/value bytes in the registry RocksDB; excludes filesystem overhead.",
            &self.registry_bytes,
            &self.registry_bytes_available,
        );
        append_gauge(
            &mut output,
            DIRECT_MESSAGE_BYTES_NAME,
            "Approximate live key/value bytes in the canonical direct-message RocksDB; excludes filesystem overhead.",
            &self.direct_message_bytes,
            &self.direct_message_bytes_available,
        );
        output.push_str(&format!(
            "# HELP {DIRECT_MESSAGES_TOTAL_NAME} Newly stored canonical direct messages since this relay process started; retries are excluded.\n# TYPE {DIRECT_MESSAGES_TOTAL_NAME} counter\n{DIRECT_MESSAGES_TOTAL_NAME} {}\n",
            registry.canonical_messages_stored_total()
        ));
        output
    }
}

fn append_gauge(
    output: &mut String,
    name: &str,
    help: &str,
    value: &AtomicU64,
    available: &AtomicBool,
) {
    output.push_str(&format!("# HELP {name} {help}\n# TYPE {name} gauge\n"));
    if available.load(Ordering::Relaxed) {
        output.push_str(&format!("{name} {}\n", value.load(Ordering::Relaxed)));
    }
}

/// Build the isolated metrics router and refresh durable aggregate values in the background.
/// The router exports no address, key, IP, message, transaction, or other user-derived labels.
pub fn router(registry: Arc<Registry>) -> Router {
    let snapshot = Arc::new(Snapshot::default());
    snapshot.refresh(&registry);

    let refresh_snapshot = Arc::clone(&snapshot);
    let refresh_registry = Arc::clone(&registry);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(REFRESH_INTERVAL);
        interval.tick().await;
        loop {
            interval.tick().await;
            refresh_snapshot.refresh(&refresh_registry);
        }
    });

    Router::new().route(
        "/metrics",
        routing::get(move || {
            let snapshot = Arc::clone(&snapshot);
            let registry = Arc::clone(&registry);
            async move {
                (
                    [(
                        header::CONTENT_TYPE,
                        "text/plain; version=0.0.4; charset=utf-8",
                    )],
                    snapshot.render(&registry),
                )
                    .into_response()
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::{append_gauge, Snapshot, DIRECT_MESSAGES_TOTAL_NAME, PROFILE_COUNT_NAME};
    use std::sync::atomic::{AtomicBool, AtomicU64};

    #[test]
    fn unavailable_count_is_not_reported_as_zero() {
        let snapshot = Snapshot::default();
        snapshot.update(
            PROFILE_COUNT_NAME,
            Err("profile store read failed".to_string()),
            &snapshot.profile_count,
            &snapshot.profile_count_available,
        );
        let mut output = String::new();
        append_gauge(
            &mut output,
            PROFILE_COUNT_NAME,
            "profile rows",
            &snapshot.profile_count,
            &snapshot.profile_count_available,
        );
        assert!(output.contains(&format!("# TYPE {PROFILE_COUNT_NAME} gauge")));
        assert!(!output.contains(&format!("{PROFILE_COUNT_NAME} 0")));
    }

    #[test]
    fn renders_aggregate_gauge_and_counter_without_labels() {
        let value = AtomicU64::new(17);
        let available = AtomicBool::new(true);
        let mut output = String::new();
        append_gauge(
            &mut output,
            PROFILE_COUNT_NAME,
            "profile rows",
            &value,
            &available,
        );
        output.push_str(&format!(
            "# TYPE {DIRECT_MESSAGES_TOTAL_NAME} counter\n{DIRECT_MESSAGES_TOTAL_NAME} 3\n"
        ));
        let samples = output
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<Vec<_>>();
        assert_eq!(
            samples,
            [
                format!("{PROFILE_COUNT_NAME} 17"),
                format!("{DIRECT_MESSAGES_TOTAL_NAME} 3")
            ]
        );
        assert!(samples.iter().all(|line| !line.contains('{')));
    }
}
