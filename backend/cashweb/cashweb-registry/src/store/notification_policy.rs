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

// ============================================================================
// Pure-Rust P-256 (secp256r1 / prime256v1) & RFC 8292 VAPID ES256 Signer
// ============================================================================

const P256_P: [u64; 4] = [
    0xFFFF_FFFF_FFFF_FFFF,
    0x0000_0000_FFFF_FFFF,
    0x0000_0000_0000_0000,
    0xFFFF_FFFF_0000_0001,
];

const P256_N: [u64; 4] = [
    0xF3B9_CAC2_FC63_2551,
    0xBCE6_FAAD_A717_9E84,
    0xFFFF_FFFF_FFFF_FFFF,
    0xFFFF_FFFF_0000_0000,
];

const P256_A: [u64; 4] = [
    0xFFFF_FFFF_FFFF_FFFC,
    0x0000_0000_FFFF_FFFF,
    0x0000_0000_0000_0000,
    0xFFFF_FFFF_0000_0001,
];

const P256_GX: [u64; 4] = [
    0xF4A1_3945_D898_C296,
    0x7703_7D81_2DEB_33A0,
    0xF8BC_E6E5_63A4_40F2,
    0x6B17_D1F2_E12C_4247,
];

const P256_GY: [u64; 4] = [
    0xCBB6_4068_37BF_51F5,
    0x2BCE_3357_6B31_5ECE,
    0x8EE7_EB4A_7C0F_9E16,
    0x4FE3_42E2_FE1A_7F9B,
];

fn u256_from_be_bytes(bytes: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_be_bytes(bytes[24..32].try_into().unwrap()),
        u64::from_be_bytes(bytes[16..24].try_into().unwrap()),
        u64::from_be_bytes(bytes[8..16].try_into().unwrap()),
        u64::from_be_bytes(bytes[0..8].try_into().unwrap()),
    ]
}

fn u256_to_be_bytes(limbs: &[u64; 4]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&limbs[3].to_be_bytes());
    out[8..16].copy_from_slice(&limbs[2].to_be_bytes());
    out[16..24].copy_from_slice(&limbs[1].to_be_bytes());
    out[24..32].copy_from_slice(&limbs[0].to_be_bytes());
    out
}

fn u256_is_zero(a: &[u64; 4]) -> bool {
    a[0] == 0 && a[1] == 0 && a[2] == 0 && a[3] == 0
}

fn u256_cmp(a: &[u64; 4], b: &[u64; 4]) -> std::cmp::Ordering {
    for i in (0..4).rev() {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

fn u256_add_raw(a: &[u64; 4], b: &[u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut carry = false;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(u64::from(carry));
        out[i] = s2;
        carry = c1 || c2;
    }
    (out, carry)
}

fn u256_sub_raw(a: &[u64; 4], b: &[u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut borrow = false;
    for i in 0..4 {
        let (d1, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d1.overflowing_sub(u64::from(borrow));
        out[i] = d2;
        borrow = b1 || b2;
    }
    (out, borrow)
}

fn u256_mod(a: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let mut val = *a;
    while u256_cmp(&val, m) != std::cmp::Ordering::Less {
        val = u256_sub_raw(&val, m).0;
    }
    val
}

fn u256_mod_add(a: &[u64; 4], b: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let (sum, carry) = u256_add_raw(a, b);
    if carry || u256_cmp(&sum, m) != std::cmp::Ordering::Less {
        u256_sub_raw(&sum, m).0
    } else {
        sum
    }
}

fn u256_mod_sub(a: &[u64; 4], b: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let (diff, borrow) = u256_sub_raw(a, b);
    if borrow {
        u256_add_raw(&diff, m).0
    } else {
        diff
    }
}

fn u256_mod_mul(a: &[u64; 4], b: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let a_red = u256_mod(a, m);
    let mut acc = [0u64; 4];
    for i in (0..256).rev() {
        acc = u256_mod_add(&acc, &acc, m);
        if ((b[i / 64] >> (i % 64)) & 1) == 1 {
            acc = u256_mod_add(&acc, &a_red, m);
        }
    }
    acc
}

fn u256_mod_pow(base: &[u64; 4], exp: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let mut result = [1u64, 0, 0, 0];
    let mut b = u256_mod(base, m);
    for i in 0..256 {
        if ((exp[i / 64] >> (i % 64)) & 1) == 1 {
            result = u256_mod_mul(&result, &b, m);
        }
        b = u256_mod_mul(&b, &b, m);
    }
    result
}

fn u256_mod_inv(a: &[u64; 4], m: &[u64; 4]) -> [u64; 4] {
    let exp = u256_sub_raw(m, &[2, 0, 0, 0]).0;
    u256_mod_pow(a, &exp, m)
}

type P256Point = Option<([u64; 4], [u64; 4])>;

fn p256_point_double(pt: P256Point) -> P256Point {
    let (x, y) = pt?;
    if u256_is_zero(&y) {
        return None;
    }
    let x2 = u256_mod_mul(&x, &x, &P256_P);
    let three_x2 = u256_mod_add(&u256_mod_add(&x2, &x2, &P256_P), &x2, &P256_P);
    let num = u256_mod_add(&three_x2, &P256_A, &P256_P);
    let two_y = u256_mod_add(&y, &y, &P256_P);
    let denom_inv = u256_mod_inv(&two_y, &P256_P);
    let lambda = u256_mod_mul(&num, &denom_inv, &P256_P);

    let lambda2 = u256_mod_mul(&lambda, &lambda, &P256_P);
    let two_x = u256_mod_add(&x, &x, &P256_P);
    let x3 = u256_mod_sub(&lambda2, &two_x, &P256_P);
    let dx = u256_mod_sub(&x, &x3, &P256_P);
    let y3 = u256_mod_sub(&u256_mod_mul(&lambda, &dx, &P256_P), &y, &P256_P);
    Some((x3, y3))
}

fn p256_point_add(p1: P256Point, p2: P256Point) -> P256Point {
    match (p1, p2) {
        (None, other) | (other, None) => other,
        (Some((x1, y1)), Some((x2, y2))) => {
            if x1 == x2 {
                if y1 == y2 {
                    return p256_point_double(Some((x1, y1)));
                }
                return None;
            }
            let num = u256_mod_sub(&y2, &y1, &P256_P);
            let denom = u256_mod_sub(&x2, &x1, &P256_P);
            let denom_inv = u256_mod_inv(&denom, &P256_P);
            let lambda = u256_mod_mul(&num, &denom_inv, &P256_P);

            let lambda2 = u256_mod_mul(&lambda, &lambda, &P256_P);
            let x3 = u256_mod_sub(&u256_mod_sub(&lambda2, &x1, &P256_P), &x2, &P256_P);
            let dx = u256_mod_sub(&x1, &x3, &P256_P);
            let y3 = u256_mod_sub(&u256_mod_mul(&lambda, &dx, &P256_P), &y1, &P256_P);
            Some((x3, y3))
        }
    }
}

fn p256_scalar_mul(scalar: &[u64; 4], base: ([u64; 4], [u64; 4])) -> P256Point {
    let mut acc: P256Point = None;
    for i in (0..256).rev() {
        acc = p256_point_double(acc);
        if ((scalar[i / 64] >> (i % 64)) & 1) == 1 {
            acc = p256_point_add(acc, Some(base));
        }
    }
    acc
}

fn normalize_p256_scalar(seed_or_scalar: &[u8; 32]) -> [u8; 32] {
    let mut d = u256_from_be_bytes(seed_or_scalar);
    d = u256_mod(&d, &P256_N);
    if u256_is_zero(&d) {
        d = [1, 0, 0, 0];
    }
    u256_to_be_bytes(&d)
}

/// Sign a 32-byte SHA-256 digest with P-256 ECDSA (`ES256`), returning the 64-byte `R || S` JWS signature.
pub fn sign_p256_ecdsa(private_key_be: &[u8; 32], digest: &[u8; 32]) -> [u8; 64] {
    let d_bytes = normalize_p256_scalar(private_key_be);
    let d = u256_from_be_bytes(&d_bytes);
    let z = u256_mod(&u256_from_be_bytes(digest), &P256_N);

    for counter in 0u32..1000 {
        let mut nonce_preimage = Vec::with_capacity(96);
        nonce_preimage.extend_from_slice(b"frank-vapid-p256-k-v1:");
        nonce_preimage.extend_from_slice(&d_bytes);
        nonce_preimage.extend_from_slice(digest);
        nonce_preimage.extend_from_slice(&counter.to_be_bytes());
        let k_hash: [u8; 32] = Sha256::digest(nonce_preimage.into())
            .as_slice()
            .try_into()
            .expect("SHA256 is 32 bytes");
        let k = u256_mod(&u256_from_be_bytes(&k_hash), &P256_N);
        if u256_is_zero(&k) {
            continue;
        }
        let Some((rx, _)) = p256_scalar_mul(&k, (P256_GX, P256_GY)) else {
            continue;
        };
        let r = u256_mod(&rx, &P256_N);
        if u256_is_zero(&r) {
            continue;
        }
        let k_inv = u256_mod_inv(&k, &P256_N);
        let rd = u256_mod_mul(&r, &d, &P256_N);
        let z_plus_rd = u256_mod_add(&z, &rd, &P256_N);
        let s = u256_mod_mul(&k_inv, &z_plus_rd, &P256_N);
        if u256_is_zero(&s) {
            continue;
        }
        let mut sig = [0u8; 64];
        sig[0..32].copy_from_slice(&u256_to_be_bytes(&r));
        sig[32..64].copy_from_slice(&u256_to_be_bytes(&s));
        return sig;
    }
    panic!("P-256 ECDSA nonce derivation failed")
}

/// Verify a 64-byte `R || S` P-256 ECDSA (`ES256`) signature against a 65-byte uncompressed public key.
pub fn verify_p256_ecdsa(
    pubkey_uncompressed: &[u8; 65],
    digest: &[u8; 32],
    sig_r_s: &[u8; 64],
) -> bool {
    if pubkey_uncompressed[0] != 0x04 {
        return false;
    }
    let qx = u256_from_be_bytes(pubkey_uncompressed[1..33].try_into().unwrap());
    let qy = u256_from_be_bytes(pubkey_uncompressed[33..65].try_into().unwrap());
    let r = u256_from_be_bytes(sig_r_s[0..32].try_into().unwrap());
    let s = u256_from_be_bytes(sig_r_s[32..64].try_into().unwrap());
    if u256_is_zero(&r)
        || u256_cmp(&r, &P256_N) != std::cmp::Ordering::Less
        || u256_is_zero(&s)
        || u256_cmp(&s, &P256_N) != std::cmp::Ordering::Less
    {
        return false;
    }
    let z = u256_mod(&u256_from_be_bytes(digest), &P256_N);
    let w = u256_mod_inv(&s, &P256_N);
    let u1 = u256_mod_mul(&z, &w, &P256_N);
    let u2 = u256_mod_mul(&r, &w, &P256_N);
    let p1 = p256_scalar_mul(&u1, (P256_GX, P256_GY));
    let p2 = p256_scalar_mul(&u2, (qx, qy));
    let Some((rx, _)) = p256_point_add(p1, p2) else {
        return false;
    };
    u256_mod(&rx, &P256_N) == r
}

/// Storage key for the cluster-wide 32-byte P-256 VAPID private scalar in [`crate::store::kv_store::RelayKvStore`].
pub const VAPID_PRIVATE_KEY_STORAGE_KEY: &[u8] = b"M_vapid_privkey";

/// Alias for [`VapidKeyPair`] when used as the cluster-wide WebPush VAPID signer/dispatcher.
pub type VapidDispatcher = VapidKeyPair;

/// Relay P-256 VAPID keypair for signing RFC 8292 WebPush JWT headers.
///
/// Cluster-safe and persistent:
/// - In multi-node relay deployments, set `FRANK_VAPID_PRIVATE_KEY` (32-byte hex or base64url)
///   from a shared secret or use [`VapidKeyPair::from_kv_store_or_env`] against a shared
///   [`crate::store::kv_store::RelayKvStore`] so every relay pod advertises the same
///   `vapid_public_key` and can push to subscriptions registered on any pod.
/// - In single-node deployments without `FRANK_VAPID_PRIVATE_KEY`, the 32-byte private key is
///   generated once and persisted in RocksDB under `M_vapid_privkey` so subscriptions survive
///   process restarts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VapidKeyPair {
    private_key: [u8; 32],
    public_key_uncompressed: [u8; 65],
    public_key_base64url: String,
}

impl VapidKeyPair {
    /// Construct a `VapidKeyPair` from a 32-byte private scalar.
    pub fn from_private_key_bytes(raw_key: &[u8; 32]) -> Self {
        let private_key = normalize_p256_scalar(raw_key);
        let d = u256_from_be_bytes(&private_key);
        let (qx, qy) = p256_scalar_mul(&d, (P256_GX, P256_GY)).expect("non-zero scalar on P-256");
        let mut public_key_uncompressed = [0u8; 65];
        public_key_uncompressed[0] = 0x04;
        public_key_uncompressed[1..33].copy_from_slice(&u256_to_be_bytes(&qx));
        public_key_uncompressed[33..65].copy_from_slice(&u256_to_be_bytes(&qy));
        let public_key_base64url =
            base64::encode_config(public_key_uncompressed, base64::URL_SAFE_NO_PAD);
        Self {
            private_key,
            public_key_uncompressed,
            public_key_base64url,
        }
    }

    /// Parse a 32-byte VAPID private key from hex or base64url string.
    pub fn from_private_key_str(encoded: &str) -> Result<Self, String> {
        let trimmed = encoded.trim();
        let clean = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        if clean.len() == 64 {
            if let Ok(bytes) = hex::decode(clean) {
                let arr: [u8; 32] = bytes.try_into().map_err(|_| "invalid length")?;
                return Ok(Self::from_private_key_bytes(&arr));
            }
        }
        if let Ok(bytes) = base64::decode_config(trimmed, base64::URL_SAFE_NO_PAD)
            .or_else(|_| base64::decode(trimmed))
        {
            if bytes.len() == 32 {
                let arr: [u8; 32] = bytes.try_into().map_err(|_| "invalid length")?;
                return Ok(Self::from_private_key_bytes(&arr));
            }
        }
        Err("VAPID private key must be 32 bytes in hex or base64url".to_string())
    }

    /// Load or atomically bootstrap the cluster's shared VAPID keypair from:
    /// 1. `FRANK_VAPID_PRIVATE_KEY` environment variable (if set and non-empty), or
    /// 2. [`crate::store::kv_store::RelayKvStore`] under `b"M_vapid_privkey"` using atomic
    ///    `compare_and_swap(b"M_vapid_privkey", None, candidate)` so multiple stateless
    ///    relay replicas booting simultaneously converge on the single winning keypair.
    pub fn from_kv_store_or_env(
        kv: &dyn crate::store::kv_store::RelayKvStore,
    ) -> Result<Self, crate::store::kv_store::KvError> {
        if let Ok(raw_env) = std::env::var("FRANK_VAPID_PRIVATE_KEY") {
            let trimmed = raw_env.trim();
            if !trimmed.is_empty() {
                if let Ok(kp) = Self::from_private_key_str(trimmed) {
                    return Ok(kp);
                }
            }
        }
        Self::from_kv_store(kv)
    }

    /// Load or atomically bootstrap the cluster's shared VAPID keypair from `kv` under
    /// `b"M_vapid_privkey"` using serializable `compare_and_swap`.
    pub fn from_kv_store(
        kv: &dyn crate::store::kv_store::RelayKvStore,
    ) -> Result<Self, crate::store::kv_store::KvError> {
        if let Some(existing) = kv.get(VAPID_PRIVATE_KEY_STORAGE_KEY)? {
            if let Ok(bytes) = <[u8; 32]>::try_from(existing.as_slice()) {
                return Ok(Self::from_private_key_bytes(&bytes));
            }
        }
        let candidate = Self::generate();
        match kv.compare_and_swap(
            VAPID_PRIVATE_KEY_STORAGE_KEY,
            None,
            candidate.private_key_bytes(),
        ) {
            Ok(()) => Ok(candidate),
            Err(crate::store::kv_store::KvError::CasConflict {
                current: Some(existing),
            }) => {
                let bytes = <[u8; 32]>::try_from(existing.as_slice()).map_err(|_| {
                    crate::store::kv_store::KvError::Backend(
                        "corrupted M_vapid_privkey length in KV store".into(),
                    )
                })?;
                Ok(Self::from_private_key_bytes(&bytes))
            }
            Err(other) => Err(other),
        }
    }

    /// Generate a fresh random P-256 VAPID keypair.
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        Self::from_private_key_bytes(&seed)
    }

    /// Deterministic fallback keypair when neither env var nor RocksDB is used.
    pub fn deterministic_fallback() -> Self {
        let seed: [u8; 32] = Sha256::digest(b"frank-relay-vapid-default-seed-v1".as_slice().into())
            .as_slice()
            .try_into()
            .expect("SHA256 is 32 bytes");
        Self::from_private_key_bytes(&seed)
    }

    /// Raw 32-byte private key scalar for persistence in RocksDB.
    pub fn private_key_bytes(&self) -> &[u8; 32] {
        &self.private_key
    }

    /// 65-byte uncompressed P-256 public key (`0x04 || X || Y`).
    pub fn public_key_uncompressed(&self) -> &[u8; 65] {
        &self.public_key_uncompressed
    }

    /// Base64url-encoded (no padding) 65-byte uncompressed P-256 public key for `applicationServerKey`.
    pub fn public_key_base64url(&self) -> &str {
        &self.public_key_base64url
    }

    /// Sign an RFC 8292 `ES256` VAPID JWT for a push subscription endpoint URL.
    pub fn sign_vapid_jwt(
        &self,
        endpoint: &str,
        exp_unix_sec: u64,
        subject: &str,
    ) -> Result<String, String> {
        let parsed = url::Url::parse(endpoint).map_err(|e| format!("invalid endpoint URL: {e}"))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "endpoint URL missing host".to_string())?;
        let aud = match parsed.port() {
            Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
            None => format!("{}://{}", parsed.scheme(), host),
        };
        let header_json = r#"{"typ":"JWT","alg":"ES256"}"#;
        let claims_json = serde_json::json!({
            "aud": aud,
            "exp": exp_unix_sec,
            "sub": subject,
        })
        .to_string();
        let header_b64 = base64::encode_config(header_json.as_bytes(), base64::URL_SAFE_NO_PAD);
        let claims_b64 = base64::encode_config(claims_json.as_bytes(), base64::URL_SAFE_NO_PAD);
        let signing_input = format!("{header_b64}.{claims_b64}");
        let digest: [u8; 32] = Sha256::digest(signing_input.as_bytes().to_vec().into())
            .as_slice()
            .try_into()
            .expect("SHA256 is 32 bytes");
        let sig_bytes = sign_p256_ecdsa(&self.private_key, &digest);
        let sig_b64 = base64::encode_config(sig_bytes, base64::URL_SAFE_NO_PAD);
        Ok(format!("{signing_input}.{sig_b64}"))
    }

    /// Build the RFC 8292 `Authorization: vapid t=<jwt>, k=<pubkey>` header value.
    pub fn build_vapid_authorization_header(
        &self,
        endpoint: &str,
        exp_unix_sec: u64,
        subject: &str,
    ) -> Result<String, String> {
        let jwt = self.sign_vapid_jwt(endpoint, exp_unix_sec, subject)?;
        Ok(format!("vapid t={jwt}, k={}", self.public_key_base64url))
    }
}

/// Dispatch an RFC 8030 + RFC 8292 content-free WebPush wakeup (`Content-Length: 0`, `TTL: 86400`,
/// `Urgency: high`, `Authorization: vapid t=..., k=...`) to a registered push subscription endpoint.
pub async fn dispatch_blind_webpush_wakeup(
    subscription: &BlindPushSubscription,
    vapid: &VapidKeyPair,
) -> Result<u16, String> {
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1_700_000_000);
    let exp_sec = now_sec.saturating_add(12 * 3600);
    let subject = std::env::var("FRANK_VAPID_SUBJECT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "mailto:postmaster@signet.mx".to_string());
    let auth_header =
        vapid.build_vapid_authorization_header(&subscription.endpoint, exp_sec, &subject)?;
    let crypto_key = format!("p256ecdsa={}", vapid.public_key_base64url());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("failed to build reqwest client: {e}"))?;

    let response = client
        .post(&subscription.endpoint)
        .header("Authorization", auth_header)
        .header("Crypto-Key", crypto_key)
        .header("TTL", "86400")
        .header("Urgency", "high")
        .header("Content-Length", "0")
        .body(Vec::<u8>::new())
        .send()
        .await
        .map_err(|e| format!("WebPush POST failed: {e}"))?;

    Ok(response.status().as_u16())
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

    #[test]
    fn p256_vapid_keypair_signs_verifiable_es256_jwt_and_roundtrips_cluster_secret() {
        let secret_hex = "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721";
        let kp1 = VapidKeyPair::from_private_key_str(secret_hex).unwrap();
        let kp2 = VapidKeyPair::from_private_key_bytes(kp1.private_key_bytes());
        assert_eq!(kp1.public_key_base64url(), kp2.public_key_base64url());
        assert_eq!(kp1.public_key_uncompressed().len(), 65);
        assert_eq!(kp1.public_key_uncompressed()[0], 0x04);

        // RFC 6979 P-256 test vector public key check for secret c9afa9d8...
        let expected_qx = "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6";
        let expected_qy = "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299";
        assert_eq!(
            hex::encode(&kp1.public_key_uncompressed()[1..33]),
            expected_qx
        );
        assert_eq!(
            hex::encode(&kp1.public_key_uncompressed()[33..65]),
            expected_qy
        );

        let jwt = kp1
            .sign_vapid_jwt(
                "https://fcm.googleapis.com/fcm/send/abc123",
                1_700_043_200,
                "mailto:postmaster@signet.mx",
            )
            .unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let digest: [u8; 32] = Sha256::digest(signing_input.into_bytes().into())
            .as_slice()
            .try_into()
            .unwrap();
        let sig_bytes: [u8; 64] = base64::decode_config(parts[2], base64::URL_SAFE_NO_PAD)
            .unwrap()
            .try_into()
            .unwrap();
        assert!(verify_p256_ecdsa(
            kp1.public_key_uncompressed(),
            &digest,
            &sig_bytes
        ));
    }

    #[test]
    fn multi_replica_vapid_bootstrap_converges_via_shared_kv_cas() {
        use crate::store::kv_store::{FoundationDbKvStore, SimulatedFdbCluster};
        use std::thread;

        let cluster = SimulatedFdbCluster::new();
        let mut handles = Vec::new();
        for _ in 0..10 {
            let replica_kv = FoundationDbKvStore::connect_simulated(
                "/etc/foundationdb/fdb.cluster",
                b"frank_cluster:",
                cluster.clone(),
            );
            handles.push(thread::spawn(move || {
                VapidKeyPair::from_kv_store(&replica_kv).unwrap()
            }));
        }

        let results: Vec<VapidKeyPair> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.len(), 10);
        let first = &results[0];
        for kp in &results[1..] {
            assert_eq!(
                kp.public_key_base64url(),
                first.public_key_base64url(),
                "all 10 concurrent relay replicas must converge on the single CAS-winning VAPID keypair"
            );
            assert_eq!(kp.private_key_bytes(), first.private_key_bytes());
        }
    }
}
