//! Per-mailbox notification policy and blind WebPush wakeup evaluation (#384, #1574).
//!
//! Enforces an economic interruption filter at the relay while preserving the #1367
//! zero-value message storage invariant and #384 content-free blind push privacy:
//! - Messages below the recipient's notification threshold are still stored in `'I'`
//!   (the recipient's inbox), just without firing a push wakeup.
//! - Trusted contacts presenting a valid pre-shared `wakeup_token_preimage` whose
//!   `SHA256` digest is registered in `contact_wakeup_tokens` bypass the stamp threshold
//!   when `allow_contact_bypass` is enabled.
//! - Wakeup payloads are strictly content-free (`{"type":"sync","v":1}`).

use bitcoinsuite_core::{Hashed, Sha256};
use serde::{Deserialize, Serialize};

use crate::monad_http::Address;

/// Domain prefix used for domain-separated contact wakeup token blinding (`#1574`).
pub const WAKEUP_TOKEN_DOMAIN: &[u8] = b"frank-wakeup-v1";

fn default_zero_wei() -> String {
    "0".to_string()
}

fn default_true() -> bool {
    true
}

fn default_coalesce_window_seconds() -> u32 {
    15
}

mod hex_vec_32 {
    use serde::{
        de::{Error as DeError, SeqAccess, Visitor},
        ser::SerializeSeq,
        Deserializer, Serializer,
    };

    pub(super) fn serialize<S>(tokens: &[[u8; 32]], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut seq = serializer.serialize_seq(Some(tokens.len()))?;
        for token in tokens {
            seq.serialize_element(&hex::encode(token))?;
        }
        seq.end()
    }

    pub(super) fn deserialize<'de, D>(deserializer: D) -> Result<Vec<[u8; 32]>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum TokenRepr {
            Hex(String),
            Bytes(Vec<u8>),
        }

        struct TokensVisitor;

        impl<'de> Visitor<'de> for TokensVisitor {
            type Value = Vec<[u8; 32]>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a sequence of 32-byte hex strings or byte arrays")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut out = Vec::new();
                while let Some(elem) = seq.next_element::<TokenRepr>()? {
                    let bytes = match elem {
                        TokenRepr::Hex(s) => {
                            let clean = s.strip_prefix("0x").unwrap_or(&s);
                            hex::decode(clean).map_err(DeError::custom)?
                        }
                        TokenRepr::Bytes(b) => b,
                    };
                    if bytes.len() != 32 {
                        return Err(DeError::custom("wakeup token hash must be 32 bytes"));
                    }
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    out.push(arr);
                }
                Ok(out)
            }
        }

        deserializer.deserialize_seq(TokensVisitor)
    }
}

/// WebPush RFC 8291 subscription credentials for content-free blind wakeup delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlindPushSubscription {
    /// Push service endpoint URL.
    pub endpoint: String,
    /// Client P-256 ECDH public key (base64url).
    pub p256dh: String,
    /// Client 16-byte authentication secret (base64url).
    pub auth: String,
}

/// Per-mailbox notification policy stored on the home relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxNotificationPolicy {
    /// Minimum stamp value in wei (decimal string) required for a non-contact message to fire a wakeup.
    #[serde(default = "default_zero_wei")]
    pub min_notification_value_wei: String,
    /// Minimum stamp value in micro-AVU (`1_000_000 = 1.00 AVU`) required to fire a wakeup.
    #[serde(default)]
    pub min_notification_avu_micros: u64,
    /// Whether messages carrying a valid contact wakeup token bypass the stamp threshold.
    #[serde(default = "default_true")]
    pub allow_contact_bypass: bool,
    /// Blinded 32-byte tokens (`SHA256(token_preimage)`) for authorized contacts.
    #[serde(default, with = "hex_vec_32", alias = "allowed_wakeup_token_hashes")]
    pub contact_wakeup_tokens: Vec<[u8; 32]>,
    /// Registered WebPush subscriptions for this mailbox.
    #[serde(default)]
    pub push_subscriptions: Vec<BlindPushSubscription>,
    /// Coalescing window in seconds (at most 1 blind push per recipient per window).
    #[serde(default = "default_coalesce_window_seconds")]
    pub coalesce_window_seconds: u32,
    /// Client or relay timestamp in milliseconds when the policy was last updated.
    #[serde(default)]
    pub updated_at_ms: u64,
}

impl Default for MailboxNotificationPolicy {
    fn default() -> Self {
        Self {
            min_notification_value_wei: default_zero_wei(),
            min_notification_avu_micros: 0,
            allow_contact_bypass: true,
            contact_wakeup_tokens: Vec::new(),
            push_subscriptions: Vec::new(),
            coalesce_window_seconds: default_coalesce_window_seconds(),
            updated_at_ms: 0,
        }
    }
}

/// Content-free blind push payload (`{"type":"sync"}`) sent to WebPush / APNs / FCM.
///
/// Invariant (#384, #1574): Never carries sender address, stamp amount, subject, or message body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlindWakeupPayload {
    /// Always `"sync"`.
    #[serde(rename = "type")]
    pub kind: String,
}

impl Default for BlindWakeupPayload {
    fn default() -> Self {
        Self {
            kind: "sync".to_string(),
        }
    }
}

/// Event emitted by the relay when an incoming message satisfies the recipient's notification policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlindWakeupEvent {
    /// Recipient mailbox address.
    pub recipient: Address,
    /// Content-free blind push payload (`{"type":"sync"}`).
    pub payload: BlindWakeupPayload,
    /// Push subscriptions registered by the recipient at the time of wakeup.
    pub subscriptions: Vec<BlindPushSubscription>,
    /// Delivery timestamp in milliseconds when the wakeup fired.
    pub triggered_at_ms: i64,
}

/// Compute `SHA256(token_preimage)` for blinding a contact wakeup token.
pub fn blind_wakeup_token(token_preimage: &[u8]) -> [u8; 32] {
    Sha256::digest(token_preimage.into())
        .as_slice()
        .try_into()
        .expect("SHA256 is 32 bytes")
}

/// Compute domain-separated `SHA256("frank-wakeup-v1" || token_preimage)`.
pub fn blind_wakeup_token_domain_separated(token_preimage: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(WAKEUP_TOKEN_DOMAIN.len() + token_preimage.len());
    buf.extend_from_slice(WAKEUP_TOKEN_DOMAIN);
    buf.extend_from_slice(token_preimage);
    Sha256::digest(buf.into())
        .as_slice()
        .try_into()
        .expect("SHA256 is 32 bytes")
}

fn matches_contact_wakeup_token(allowed: &[[u8; 32]], preimage: &[u8]) -> bool {
    if preimage.is_empty() || allowed.is_empty() {
        return false;
    }
    let direct = blind_wakeup_token(preimage);
    let domain = blind_wakeup_token_domain_separated(preimage);
    if allowed.iter().any(|t| *t == direct || *t == domain) {
        return true;
    }
    // Also support hex-encoded preimage strings passed in HTTP headers (`X-Wakeup-Token`).
    if let Ok(as_str) = std::str::from_utf8(preimage) {
        let trimmed = as_str.trim();
        let clean = trimmed.strip_prefix("0x").unwrap_or(trimmed);
        if clean.len() == 64 {
            if let Ok(decoded) = hex::decode(clean) {
                let decoded_direct = blind_wakeup_token(&decoded);
                let decoded_domain = blind_wakeup_token_domain_separated(&decoded);
                if allowed
                    .iter()
                    .any(|t| *t == decoded_direct || *t == decoded_domain)
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Evaluate whether an incoming message should trigger a blind push wakeup (`#384`, `#1574`).
///
/// - If `policy.allow_contact_bypass` is true and `wakeup_token_preimage` hashes to a member of
///   `policy.contact_wakeup_tokens`, returns `true` even for a 0-value stamp.
/// - Otherwise, checks whether `stamp_value_wei` / `stamp_value_avu_micros` meets the policy's
///   minimum threshold (`min_notification_value_wei` / `min_notification_avu_micros`).
/// - When both minimum thresholds are `0`, any positive stamp (`stamp_value_wei > 0` or
///   `stamp_value_avu_micros > 0`) triggers a wakeup, while unpaid 0-value stranger messages
///   do not trigger a wakeup.
pub fn should_trigger_wakeup(
    policy: &MailboxNotificationPolicy,
    stamp_value_wei: u128,
    stamp_value_avu_micros: u64,
    wakeup_token_preimage: Option<&[u8]>,
) -> bool {
    if policy.allow_contact_bypass {
        if let Some(preimage) = wakeup_token_preimage {
            if matches_contact_wakeup_token(&policy.contact_wakeup_tokens, preimage) {
                return true;
            }
        }
    }

    let min_wei = policy
        .min_notification_value_wei
        .trim()
        .parse::<u128>()
        .unwrap_or(0);
    let min_avu = policy.min_notification_avu_micros;

    if min_wei == 0 && min_avu == 0 {
        return stamp_value_wei > 0 || stamp_value_avu_micros > 0;
    }

    if min_wei > 0 && min_avu == 0 {
        return stamp_value_wei >= min_wei;
    }

    if min_avu > 0 && min_wei == 0 {
        return stamp_value_avu_micros >= min_avu;
    }

    // Both min_wei > 0 and min_avu > 0 are configured:
    // If the caller provided both metrics (> 0), require at least one threshold to be met without
    // violating the other; if only one metric was supplied by the caller, evaluate against that metric.
    if stamp_value_wei > 0 && stamp_value_avu_micros == 0 {
        return stamp_value_wei >= min_wei;
    }
    if stamp_value_avu_micros > 0 && stamp_value_wei == 0 {
        return stamp_value_avu_micros >= min_avu;
    }
    stamp_value_wei >= min_wei && stamp_value_avu_micros >= min_avu
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpaid_or_under_threshold_stranger_messages_do_not_trigger_wakeup() {
        let default_policy = MailboxNotificationPolicy::default();
        assert!(!should_trigger_wakeup(&default_policy, 0, 0, None));
        assert!(should_trigger_wakeup(&default_policy, 1, 0, None));
        assert!(should_trigger_wakeup(&default_policy, 0, 1, None));

        let threshold_policy = MailboxNotificationPolicy {
            min_notification_value_wei: "10000000000000000".to_string(),
            min_notification_avu_micros: 500_000,
            ..Default::default()
        };
        assert!(!should_trigger_wakeup(
            &threshold_policy,
            5_000_000_000_000_000,
            250_000,
            None
        ));
        assert!(should_trigger_wakeup(
            &threshold_policy,
            10_000_000_000_000_000,
            500_000,
            None
        ));
    }

    #[test]
    fn contact_wakeup_token_bypasses_zero_stamp_when_allowed() {
        let preimage = b"trusted-contact-secret-preimage-32";
        let blinded = blind_wakeup_token(preimage);
        let mut policy = MailboxNotificationPolicy {
            min_notification_value_wei: "1000000000000000000".to_string(),
            min_notification_avu_micros: 1_000_000,
            allow_contact_bypass: true,
            contact_wakeup_tokens: vec![blinded],
            ..Default::default()
        };

        assert!(should_trigger_wakeup(&policy, 0, 0, Some(preimage)));
        assert!(!should_trigger_wakeup(
            &policy,
            0,
            0,
            Some(b"wrong-preimage")
        ));

        policy.allow_contact_bypass = false;
        assert!(!should_trigger_wakeup(&policy, 0, 0, Some(preimage)));
    }
}
