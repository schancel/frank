//! Notification event bus for real-time relay message fan-out (Issue #982 / Track C).
//!
//! Provides an abstraction for pub/sub notification of direct message arrivals across relay
//! cluster nodes, maintaining strict end-to-end encryption and a content-oblivious boundary.
//!
//! - [`RelayEventBus`]: Common trait implemented by both standalone and clustered backends.
//! - [`StandaloneEventBus`]: Default in-process bus backed by `tokio::sync::broadcast` channels.
//! - [`CoreNatsEventBus`]: Clustered bus backed by Ephemeral Core NATS (`async-nats`).
//!
//! ### Content-Oblivious Boundary
//! Event subjects and payloads carry ONLY:
//! 1. Recipient account address hex.
//! 2. 32-byte message payload hash (digest).
//!
//! Message ciphertext is **NEVER** transmitted over the event bus; end-to-end encryption
//! is strictly maintained.

use std::fmt::Debug;

use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// NATS subject prefix for message arrival notifications.
pub const NATS_SUBJECT_PREFIX: &str = "frank.relay.notify.";

/// Errors originating from event bus operations.
#[derive(Debug, Error)]
pub enum EventBusError {
    /// Provided address hex string is not a valid hexadecimal string or is empty.
    #[error("Invalid recipient hex address: {0}")]
    InvalidRecipientHex(String),

    /// NATS subject string is invalid or does not match the expected pattern.
    #[error("Invalid NATS subject: {0}")]
    InvalidSubject(String),

    /// Publishing notification failed.
    #[error("Failed to publish notification: {0}")]
    PublishFailed(String),

    /// Subscribing to notifications failed.
    #[error("Failed to subscribe: {0}")]
    SubscribeFailed(String),

    /// Connecting to the NATS cluster failed.
    #[error("NATS connection error: {0}")]
    ConnectionError(String),

    /// Serialization or deserialization of event payload failed.
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

mod hex_32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S>(bytes: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub(super) fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 32], D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        let vec = hex::decode(&s).map_err(serde::de::Error::custom)?;
        if vec.len() != 32 {
            return Err(serde::de::Error::custom(
                "expected 32 bytes for payload_hash",
            ));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&vec);
        Ok(arr)
    }
}

/// Content-oblivious notification payload indicating a message arrival for a recipient.
///
/// Invariant: Carries ONLY the recipient account address hex and message payload hash.
/// Ciphertext is never transmitted over the bus.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageArrivalNotification {
    /// Recipient account address (normalized lowercase hex, without 0x prefix).
    pub recipient_hex: String,
    /// 32-byte SHA256 digest of the message payload.
    #[serde(with = "hex_32")]
    pub payload_hash: [u8; 32],
}

impl MessageArrivalNotification {
    /// Create a new content-oblivious notification.
    pub fn new(recipient_hex: String, payload_hash: [u8; 32]) -> Self {
        Self {
            recipient_hex,
            payload_hash,
        }
    }

    /// Encode notification to JSON bytes for wire transmission.
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self)
            .expect("JSON serialization cannot fail for MessageArrivalNotification")
    }

    /// Decode notification from wire JSON bytes.
    pub fn decode(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }
}

/// Normalizes and validates an account address hex string.
/// Strips optional leading `0x`, verifies even length and valid ASCII hex characters,
/// and converts to lowercase.
pub fn normalize_address_hex(hex_str: &str) -> Result<String, EventBusError> {
    let clean = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    if clean.is_empty() {
        return Err(EventBusError::InvalidRecipientHex(
            "address is empty".to_string(),
        ));
    }
    if clean.len() % 2 != 0 {
        return Err(EventBusError::InvalidRecipientHex(format!(
            "address hex has odd length: {}",
            clean.len()
        )));
    }
    if !clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(EventBusError::InvalidRecipientHex(format!(
            "address hex contains invalid characters: {clean}"
        )));
    }
    Ok(clean.to_ascii_lowercase())
}

/// Format the Core NATS subject for a recipient address hex.
/// Subject format: `frank.relay.notify.<recipient_account_address_hex>`
pub fn nats_subject_for_recipient(recipient_hex: &str) -> Result<String, EventBusError> {
    let normalized = normalize_address_hex(recipient_hex)?;
    Ok(format!("{}{}", NATS_SUBJECT_PREFIX, normalized))
}

/// Parse and validate a Core NATS subject string, returning the extracted recipient hex.
pub fn parse_nats_subject(subject: &str) -> Result<String, EventBusError> {
    let stripped = subject.strip_prefix(NATS_SUBJECT_PREFIX).ok_or_else(|| {
        EventBusError::InvalidSubject(format!(
            "subject does not start with prefix '{NATS_SUBJECT_PREFIX}': {subject}"
        ))
    })?;
    normalize_address_hex(stripped)
}

/// Abstract receiver for message arrival notifications.
#[derive(Debug)]
pub struct EventReceiver {
    inner: EventReceiverInner,
}

enum EventReceiverInner {
    Broadcast {
        rx: tokio::sync::broadcast::Receiver<MessageArrivalNotification>,
        recipient_hex: String,
    },
    Nats {
        subscriber: async_nats::Subscriber,
    },
    #[allow(dead_code)]
    Mpsc(tokio::sync::mpsc::Receiver<MessageArrivalNotification>),
}

impl std::fmt::Debug for EventReceiverInner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Broadcast { recipient_hex, .. } => f
                .debug_struct("Broadcast")
                .field("recipient_hex", recipient_hex)
                .finish_non_exhaustive(),
            Self::Nats { .. } => f.debug_struct("Nats").finish_non_exhaustive(),
            Self::Mpsc(_) => f.debug_struct("Mpsc").finish_non_exhaustive(),
        }
    }
}

impl EventReceiver {
    /// Create an `EventReceiver` wrapping a `tokio::sync::broadcast::Receiver`.
    pub fn from_broadcast(
        rx: tokio::sync::broadcast::Receiver<MessageArrivalNotification>,
        recipient_hex: String,
    ) -> Self {
        Self {
            inner: EventReceiverInner::Broadcast { rx, recipient_hex },
        }
    }

    /// Create an `EventReceiver` wrapping an `async_nats::Subscriber`.
    pub fn from_nats(subscriber: async_nats::Subscriber) -> Self {
        Self {
            inner: EventReceiverInner::Nats { subscriber },
        }
    }

    /// Create an `EventReceiver` wrapping a `tokio::sync::mpsc::Receiver` (useful for testing).
    pub fn from_mpsc(rx: tokio::sync::mpsc::Receiver<MessageArrivalNotification>) -> Self {
        Self {
            inner: EventReceiverInner::Mpsc(rx),
        }
    }

    /// Asynchronously receive the next message arrival notification for this subscription.
    /// Returns `None` if the subscription has been closed.
    pub async fn recv(&mut self) -> Option<MessageArrivalNotification> {
        match &mut self.inner {
            EventReceiverInner::Broadcast { rx, recipient_hex } => loop {
                match rx.recv().await {
                    Ok(notif) => {
                        if notif.recipient_hex == *recipient_hex {
                            return Some(notif);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                }
            },
            EventReceiverInner::Nats { subscriber } => {
                while let Some(msg) = subscriber.next().await {
                    if let Ok(notif) = MessageArrivalNotification::decode(&msg.payload) {
                        return Some(notif);
                    }
                }
                None
            }
            EventReceiverInner::Mpsc(rx) => rx.recv().await,
        }
    }
}

/// Shared trait defining notification event bus capabilities.
#[async_trait]
pub trait RelayEventBus: Send + Sync + Debug {
    /// Publish a message arrival notification for `recipient_hex` with digest `payload_hash`.
    ///
    /// Invariant: Only recipient hex and payload hash are transmitted; ciphertext is never transmitted.
    async fn publish_message_arrival(
        &self,
        recipient_hex: &str,
        payload_hash: &[u8; 32],
    ) -> Result<(), EventBusError>;

    /// Subscribe to message arrival notifications targeting `recipient_hex`.
    async fn subscribe(&self, recipient_hex: &str) -> Result<EventReceiver, EventBusError>;
}

/// In-process event bus using `tokio::sync::broadcast`.
///
/// This is the zero-dependency default for single-node / standalone operation.
#[derive(Debug, Clone)]
pub struct StandaloneEventBus {
    sender: tokio::sync::broadcast::Sender<MessageArrivalNotification>,
}

impl StandaloneEventBus {
    /// Create a new in-process event bus with default buffer capacity (1024).
    pub fn new() -> Self {
        Self::with_capacity(1024)
    }

    /// Create a new in-process event bus with custom buffer capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(capacity);
        Self { sender }
    }
}

impl Default for StandaloneEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RelayEventBus for StandaloneEventBus {
    async fn publish_message_arrival(
        &self,
        recipient_hex: &str,
        payload_hash: &[u8; 32],
    ) -> Result<(), EventBusError> {
        let normalized = normalize_address_hex(recipient_hex)?;
        let notif = MessageArrivalNotification {
            recipient_hex: normalized,
            payload_hash: *payload_hash,
        };
        // It's normal if there are no active subscribers yet (broadcast send returns Err(SendError))
        let _ = self.sender.send(notif);
        Ok(())
    }

    async fn subscribe(&self, recipient_hex: &str) -> Result<EventReceiver, EventBusError> {
        let normalized = normalize_address_hex(recipient_hex)?;
        let rx = self.sender.subscribe();
        Ok(EventReceiver::from_broadcast(rx, normalized))
    }
}

/// Clustered event bus using Ephemeral Core NATS via `async-nats`.
///
/// Pure in-memory pub/sub on subject: `frank.relay.notify.<recipient_account_address_hex>`.
/// ZERO JetStream streams, persistence, or WAL overhead.
#[derive(Debug, Clone)]
pub struct CoreNatsEventBus {
    client: async_nats::Client,
}

impl CoreNatsEventBus {
    /// Connect to Ephemeral Core NATS at the specified URL.
    pub async fn connect(url: &str) -> Result<Self, EventBusError> {
        let client = async_nats::connect(url)
            .await
            .map_err(|err| EventBusError::ConnectionError(err.to_string()))?;
        Ok(Self { client })
    }

    /// Wrap an existing NATS client.
    pub fn from_client(client: async_nats::Client) -> Self {
        Self { client }
    }

    /// Access the underlying `async_nats::Client`.
    pub fn client(&self) -> &async_nats::Client {
        &self.client
    }
}

#[async_trait]
impl RelayEventBus for CoreNatsEventBus {
    async fn publish_message_arrival(
        &self,
        recipient_hex: &str,
        payload_hash: &[u8; 32],
    ) -> Result<(), EventBusError> {
        let normalized = normalize_address_hex(recipient_hex)?;
        let subject = nats_subject_for_recipient(&normalized)?;
        let notif = MessageArrivalNotification {
            recipient_hex: normalized,
            payload_hash: *payload_hash,
        };
        let payload = notif.encode();
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(|err| EventBusError::PublishFailed(err.to_string()))?;
        Ok(())
    }

    async fn subscribe(&self, recipient_hex: &str) -> Result<EventReceiver, EventBusError> {
        let normalized = normalize_address_hex(recipient_hex)?;
        let subject = nats_subject_for_recipient(&normalized)?;
        let subscriber = self
            .client
            .subscribe(subject)
            .await
            .map_err(|err| EventBusError::SubscribeFailed(err.to_string()))?;
        Ok(EventReceiver::from_nats(subscriber))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_in_process_event_publication_and_reception() {
        let bus = StandaloneEventBus::new();
        let alice_addr = "0x71c0000000000000000000000000000000000b29";
        let bob_addr = "0x82d0000000000000000000000000000000000c30";

        let mut alice_rx = bus.subscribe(alice_addr).await.unwrap();
        let mut bob_rx = bus.subscribe(bob_addr).await.unwrap();

        let hash_1 = [0xabu8; 32];
        let hash_2 = [0xcdu8; 32];

        // Publish to Alice
        bus.publish_message_arrival(alice_addr, &hash_1)
            .await
            .unwrap();

        // Alice receives
        let notif = tokio::time::timeout(std::time::Duration::from_millis(500), alice_rx.recv())
            .await
            .expect("timeout waiting for Alice's notification")
            .expect("notification should not be None");
        assert_eq!(
            notif.recipient_hex,
            "71c0000000000000000000000000000000000b29"
        );
        assert_eq!(notif.payload_hash, hash_1);

        // Bob should NOT have received Alice's notification
        let bob_pending =
            tokio::time::timeout(std::time::Duration::from_millis(50), bob_rx.recv()).await;
        assert!(
            bob_pending.is_err(),
            "Bob should not receive Alice's notification"
        );

        // Publish to Bob
        bus.publish_message_arrival(bob_addr, &hash_2)
            .await
            .unwrap();

        let notif_bob = tokio::time::timeout(std::time::Duration::from_millis(500), bob_rx.recv())
            .await
            .expect("timeout waiting for Bob's notification")
            .expect("notification should not be None");
        assert_eq!(
            notif_bob.recipient_hex,
            "82d0000000000000000000000000000000000c30"
        );
        assert_eq!(notif_bob.payload_hash, hash_2);
    }

    #[test]
    fn test_nats_subject_formatting_and_validation() {
        let valid_hex = "71c0000000000000000000000000000000000b29";
        let with_prefix = format!("0x{valid_hex}");
        let mixed_case = "0x71C0000000000000000000000000000000000B29";

        let expected_subject = format!("frank.relay.notify.{valid_hex}");

        assert_eq!(
            nats_subject_for_recipient(valid_hex).unwrap(),
            expected_subject
        );
        assert_eq!(
            nats_subject_for_recipient(&with_prefix).unwrap(),
            expected_subject
        );
        assert_eq!(
            nats_subject_for_recipient(mixed_case).unwrap(),
            expected_subject
        );

        // Parse subject
        assert_eq!(parse_nats_subject(&expected_subject).unwrap(), valid_hex);

        // Invalid subjects
        assert!(parse_nats_subject("other.prefix.1234").is_err());
        assert!(parse_nats_subject("frank.relay.notify.").is_err());
        assert!(parse_nats_subject("frank.relay.notify.not_hex!").is_err());
        assert!(parse_nats_subject("frank.relay.notify.123").is_err()); // odd length

        // Invalid recipient hex
        assert!(nats_subject_for_recipient("").is_err());
        assert!(nats_subject_for_recipient("0x").is_err());
        assert!(nats_subject_for_recipient("123").is_err()); // odd length
        assert!(nats_subject_for_recipient("xyz123").is_err()); // non hex
    }

    #[test]
    fn test_content_oblivious_payload_encoding_decoding() {
        let recipient_hex = "71c0000000000000000000000000000000000b29".to_string();
        let payload_hash = [42u8; 32];
        let notif = MessageArrivalNotification::new(recipient_hex.clone(), payload_hash);

        let encoded = notif.encode();
        let decoded = MessageArrivalNotification::decode(&encoded).unwrap();

        assert_eq!(notif, decoded);
        assert_eq!(decoded.recipient_hex, recipient_hex);
        assert_eq!(decoded.payload_hash, payload_hash);

        // Invariant verification: Ensure JSON representation contains only recipient_hex and payload_hash
        let json_value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let map = json_value.as_object().unwrap();
        assert_eq!(map.len(), 2, "Payload must contain exactly 2 fields");
        assert!(map.contains_key("recipient_hex"));
        assert!(map.contains_key("payload_hash"));
        assert!(
            !map.contains_key("ciphertext")
                && !map.contains_key("encrypted_payload")
                && !map.contains_key("body"),
            "Ciphertext must NEVER be present in the notification"
        );
    }
}
