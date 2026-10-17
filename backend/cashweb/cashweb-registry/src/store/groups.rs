//! Shared Group Mailbox store (`'G'`, `'G_meta'`) over [`RelayKvStore`] (Issue #70 & #1575).
//!
//! Stores:
//! - `'G_meta' || group_id`: current [`GroupEpochFrame`], updated via atomic Compare-And-Swap (CAS).
//! - `'G_epoch' || group_id || epoch_be`: historical [`GroupEpochFrame`]s by epoch number.
//! - `'G_seq' || group_id`: monotonic `u64` per-group sequence counter.
//! - `'G' || group_id || server_seq_be`: ordered [`StoredGroupMessage`] rows.
//! - `'G_mirror' || group_id`: home-relay subscriber tracking and mirror state for foreign groups.
//! - `'G_accept' || group_id || signed_content_digest`: derived original-receipt locator, atomically
//!   committed with message/sequence/epoch/ownership guards.
//! - `'G_format'`: explicit development baseline; old owned records fail without migration.

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
use secp256k1_abc::{Message as SecpMessage, PublicKey, Secp256k1, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::store::kv_store::{
    KvError, KvTransactionOp, MemoryKvStore, RelayKvStore, RocksDbKvStore, SUBSPACE_GROUP_MESSAGES,
    SUBSPACE_GROUP_META,
};

/// Sibling directory extension for durable RocksDB group mailbox storage.
pub(crate) const GROUP_STORE_EXTENSION: &str = "groups-v1";

/// Default subscriber threshold `n` at which a Home Relay promotes a foreign group from
/// stateless oblivious proxying (`< n` subscribers) to local mirroring (`>= n` subscribers).
pub const DEFAULT_GROUP_MIRROR_THRESHOLD: usize = 2;

/// Domain separator for `group_id = SHA256("frank-group-v1" || P_G)`.
pub const GROUP_ID_DOMAIN: &[u8] = b"frank-group-v1";
/// Domain separator for `epoch_hash`.
pub const GROUP_EPOCH_HASH_DOMAIN: &[u8] = b"frank-group-epoch-v1";
/// Domain separator for outer `write_sig` over `(group_id, epoch, nonce, SHA256(ciphertext))`.
pub const GROUP_MSG_SIG_DOMAIN: &[u8] = b"frank-group-msg-v1";

/// Derive the 32-byte `group_id` from a 33-byte compressed group public key $P_G$:
/// `SHA256("frank-group-v1" || P_G)`.
pub fn derive_group_id(group_pubkey: &[u8; 33]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(GROUP_ID_DOMAIN);
    hasher.update(group_pubkey);
    hasher.finalize().into()
}

/// Parse and validate a 64-character lowercase hex `group_id`.
pub fn parse_group_id_hex(group_id_hex: &str) -> Result<[u8; 32], GroupError> {
    if group_id_hex.len() != 64
        || !group_id_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(GroupError::InvalidInput(
            "group_id must be 64 lowercase hex characters".into(),
        ));
    }
    let bytes = hex::decode(group_id_hex)
        .map_err(|_| GroupError::InvalidInput("invalid group_id hex".into()))?;
    bytes
        .try_into()
        .map_err(|_| GroupError::InvalidInput("group_id must be 32 bytes".into()))
}

fn parse_fixed_hex<const N: usize>(value: &str, field: &str) -> Result<[u8; N], GroupError> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.len() != N * 2 {
        return Err(GroupError::InvalidInput(format!(
            "{field} must be {} hex characters",
            N * 2
        )));
    }
    let decoded = hex::decode(clean)
        .map_err(|_| GroupError::InvalidInput(format!("{field} must be valid hex")))?;
    decoded
        .try_into()
        .map_err(|_| GroupError::InvalidInput(format!("{field} must be {N} bytes")))
}

fn parse_var_hex(value: &str, field: &str, max_bytes: usize) -> Result<Vec<u8>, GroupError> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.len() > max_bytes * 2 || clean.len() % 2 != 0 {
        return Err(GroupError::InvalidInput(format!(
            "{field} hex length out of bounds"
        )));
    }
    hex::decode(clean).map_err(|_| GroupError::InvalidInput(format!("{field} must be valid hex")))
}

/// Verify a secp256k1 ECDSA signature (64-byte compact `r||s` or DER) against a 33-byte
/// compressed public key and a 32-byte digest.
pub fn verify_secp256k1_sig(
    compressed_pubkey: &[u8; 33],
    digest: &[u8; 32],
    sig_bytes: &[u8],
) -> bool {
    let secp = Secp256k1::verification_only();
    let Ok(pubkey) = PublicKey::from_slice(compressed_pubkey) else {
        return false;
    };
    let Ok(msg) = SecpMessage::from_slice(digest) else {
        return false;
    };
    let mut sig = if sig_bytes.len() == 64 {
        let Ok(s) = Signature::from_compact(sig_bytes) else {
            return false;
        };
        s
    } else {
        let Ok(s) = Signature::from_der(sig_bytes) else {
            return false;
        };
        s
    };
    sig.normalize_s();
    secp.verify(&msg, &sig, &pubkey).is_ok()
}

/// Group epoch transition frame stored under `'G_meta'` and `'G_epoch'`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupEpochFrame {
    /// 64-character lowercase hex group identifier (`SHA256("frank-group-v1" || P_G)`).
    pub group_id: String,
    /// Compressed root public key pinned by `group_id`; only its holder may change epochs.
    pub group_pubkey: String,
    /// Monotonically increasing epoch counter (`0` for group creation).
    pub epoch: u64,
    /// 64-character lowercase hex hash of epoch `epoch - 1` (`"00"..` for epoch `0`).
    pub prev_epoch_hash: String,
    /// 66-character hex 33-byte compressed secp256k1 Group Write Public Key ($W_{G,e}$).
    pub write_pubkey: String,
    /// 64-character hex SHA-256 hash of the epoch's Group Read Token ($\text{SHA256}(R_{G,e})$).
    pub read_token_hash: String,
    /// Hex-encoded encrypted epoch descriptor (roster + wrapped epoch key material).
    #[serde(alias = "encrypted_roster")]
    pub encrypted_epoch_descriptor: String,
    /// Hex-encoded secp256k1 signature authorizing the epoch transition.
    #[serde(alias = "authority_sig")]
    pub admin_sig: String,
    /// Deterministic 64-character hex digest of this epoch frame.
    #[serde(default)]
    pub epoch_hash: String,
}

impl GroupEpochFrame {
    /// Validate fields and compute the canonical 32-byte epoch hash.
    pub fn compute_epoch_hash(&self) -> Result<[u8; 32], GroupError> {
        let group_id_bytes = parse_group_id_hex(&self.group_id)?;
        let prev_hash_bytes = if self.epoch == 0 && self.prev_epoch_hash.is_empty() {
            [0u8; 32]
        } else {
            parse_fixed_hex::<32>(&self.prev_epoch_hash, "prev_epoch_hash")?
        };
        if self.epoch == 0 && prev_hash_bytes != [0; 32] {
            return Err(GroupError::InvalidInput(
                "initial epoch prev_epoch_hash must be zero".into(),
            ));
        }
        let write_pk_bytes = parse_fixed_hex::<33>(&self.write_pubkey, "write_pubkey")?;
        // Ensure write_pubkey is a valid compressed secp256k1 point
        PublicKey::from_slice(&write_pk_bytes).map_err(|_| {
            GroupError::InvalidInput("write_pubkey is not a valid secp256k1 public key".into())
        })?;
        let read_token_hash_bytes =
            parse_fixed_hex::<32>(&self.read_token_hash, "read_token_hash")?;
        let descriptor_bytes = parse_var_hex(
            &self.encrypted_epoch_descriptor,
            "encrypted_epoch_descriptor",
            256 * 1024,
        )?;
        let _sig_bytes = parse_var_hex(&self.admin_sig, "admin_sig", 73)?;

        let descriptor_digest: [u8; 32] = Sha256::digest(&descriptor_bytes).into();
        let mut hasher = Sha256::new();
        hasher.update(GROUP_EPOCH_HASH_DOMAIN);
        hasher.update(group_id_bytes);
        hasher.update(self.epoch.to_be_bytes());
        hasher.update(prev_hash_bytes);
        hasher.update(write_pk_bytes);
        hasher.update(read_token_hash_bytes);
        hasher.update(descriptor_digest);
        Ok(hasher.finalize().into())
    }

    /// Verify the root authority independently of any shared epoch write/read secret.
    pub fn verify_authority(&self, path_group_id: &str) -> Result<(), GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        let root = parse_fixed_hex::<33>(&self.group_pubkey, "group_pubkey")?;
        if self.group_id != path_group_id || derive_group_id(&root) != group_id {
            return Err(GroupError::Forbidden(
                "group root key does not match group_id".into(),
            ));
        }
        let signature_bytes = parse_fixed_hex::<64>(&self.admin_sig, "admin_sig")?;
        let mut normalized_signature = Signature::from_compact(&signature_bytes)
            .map_err(|_| GroupError::Forbidden("malformed admin_sig".into()))?;
        normalized_signature.normalize_s();
        if normalized_signature.serialize_compact() != signature_bytes
            || !verify_secp256k1_sig(&root, &self.compute_epoch_hash()?, &signature_bytes)
        {
            return Err(GroupError::Forbidden("invalid root admin_sig".into()));
        }
        Ok(())
    }

    /// Verify possession of the read capability committed by this signed epoch.
    pub fn verify_read_token(&self, token: &str) -> Result<(), GroupError> {
        let bytes = parse_fixed_hex::<32>(token, "X-Group-Read-Token")
            .map_err(|_| GroupError::Forbidden("malformed X-Group-Read-Token".into()))?;
        if hex::encode(Sha256::digest(bytes)) != self.read_token_hash {
            return Err(GroupError::Forbidden(
                "invalid or stale X-Group-Read-Token".into(),
            ));
        }
        Ok(())
    }

    /// Normalize the frame and populate `epoch_hash`.
    pub fn normalized(mut self) -> Result<Self, GroupError> {
        if self.epoch == 0 && self.prev_epoch_hash.is_empty() {
            self.prev_epoch_hash = "00".repeat(32);
        }
        self.group_id = self.group_id.to_lowercase();
        self.group_pubkey = self
            .group_pubkey
            .strip_prefix("0x")
            .unwrap_or(&self.group_pubkey)
            .to_lowercase();
        self.prev_epoch_hash = self
            .prev_epoch_hash
            .strip_prefix("0x")
            .unwrap_or(&self.prev_epoch_hash)
            .to_lowercase();
        self.write_pubkey = self
            .write_pubkey
            .strip_prefix("0x")
            .unwrap_or(&self.write_pubkey)
            .to_lowercase();
        self.read_token_hash = self
            .read_token_hash
            .strip_prefix("0x")
            .unwrap_or(&self.read_token_hash)
            .to_lowercase();
        self.encrypted_epoch_descriptor = self
            .encrypted_epoch_descriptor
            .strip_prefix("0x")
            .unwrap_or(&self.encrypted_epoch_descriptor)
            .to_lowercase();
        self.admin_sig = self
            .admin_sig
            .strip_prefix("0x")
            .unwrap_or(&self.admin_sig)
            .to_lowercase();
        let hash = self.compute_epoch_hash()?;
        self.epoch_hash = hex::encode(hash);
        Ok(self)
    }

    /// Encode to canonical CBOR bytes for storage or wire transport.
    pub fn to_cbor_bytes(&self) -> Result<Vec<u8>, GroupError> {
        let val = cbor_map(vec![
            (0, CborValue::Text(self.group_id.clone())),
            (1, CborValue::Int(self.epoch as i128)),
            (2, CborValue::Text(self.prev_epoch_hash.clone())),
            (3, CborValue::Text(self.write_pubkey.clone())),
            (4, CborValue::Text(self.read_token_hash.clone())),
            (5, CborValue::Text(self.encrypted_epoch_descriptor.clone())),
            (6, CborValue::Text(self.admin_sig.clone())),
            (7, CborValue::Text(self.epoch_hash.clone())),
            (8, CborValue::Text(self.group_pubkey.clone())),
        ]);
        encode_canonical(&val).map_err(|e| GroupError::Storage(e.to_string()))
    }

    /// Decode from canonical CBOR bytes.
    pub fn from_cbor_bytes(bytes: &[u8]) -> Result<Self, GroupError> {
        let val = decode_canonical(bytes).map_err(|e| GroupError::InvalidInput(e.to_string()))?;
        let CborValue::Map(entries) = val else {
            return Err(GroupError::InvalidInput("expected CBOR map".into()));
        };
        let mut group_id = None;
        let mut group_pubkey = None;
        let mut epoch = None;
        let mut prev_epoch_hash = String::new();
        let mut write_pubkey = None;
        let mut read_token_hash = None;
        let mut encrypted_epoch_descriptor = None;
        let mut admin_sig = None;
        let mut epoch_hash = String::new();

        for (k, v) in entries {
            match (k, v) {
                (8, CborValue::Text(s)) => group_pubkey = Some(s),
                (8, CborValue::Bytes(b)) => group_pubkey = Some(hex::encode(b)),
                (0, CborValue::Text(s)) => group_id = Some(s),
                (0, CborValue::Bytes(b)) => group_id = Some(hex::encode(b)),
                (1, CborValue::Int(n)) if n >= 0 => epoch = u64::try_from(n).ok(),
                (2, CborValue::Text(s)) => prev_epoch_hash = s,
                (2, CborValue::Bytes(b)) => prev_epoch_hash = hex::encode(b),
                (3, CborValue::Text(s)) => write_pubkey = Some(s),
                (3, CborValue::Bytes(b)) => write_pubkey = Some(hex::encode(b)),
                (4, CborValue::Text(s)) => read_token_hash = Some(s),
                (4, CborValue::Bytes(b)) => read_token_hash = Some(hex::encode(b)),
                (5, CborValue::Text(s)) => encrypted_epoch_descriptor = Some(s),
                (5, CborValue::Bytes(b)) => encrypted_epoch_descriptor = Some(hex::encode(b)),
                (6, CborValue::Text(s)) => admin_sig = Some(s),
                (6, CborValue::Bytes(b)) => admin_sig = Some(hex::encode(b)),
                (7, CborValue::Text(s)) => epoch_hash = s,
                (7, CborValue::Bytes(b)) => epoch_hash = hex::encode(b),
                _ => {}
            }
        }
        let frame = Self {
            group_pubkey: group_pubkey
                .ok_or_else(|| GroupError::InvalidInput("missing group_pubkey".into()))?,
            group_id: group_id
                .ok_or_else(|| GroupError::InvalidInput("missing group_id".into()))?,
            epoch: epoch.ok_or_else(|| GroupError::InvalidInput("missing epoch".into()))?,
            prev_epoch_hash,
            write_pubkey: write_pubkey
                .ok_or_else(|| GroupError::InvalidInput("missing write_pubkey".into()))?,
            read_token_hash: read_token_hash
                .ok_or_else(|| GroupError::InvalidInput("missing read_token_hash".into()))?,
            encrypted_epoch_descriptor: encrypted_epoch_descriptor.ok_or_else(|| {
                GroupError::InvalidInput("missing encrypted_epoch_descriptor".into())
            })?,
            admin_sig: admin_sig
                .ok_or_else(|| GroupError::InvalidInput("missing admin_sig".into()))?,
            epoch_hash,
        };
        frame.normalized()
    }
}

/// Inbound sealed-sender group message submitted via `PUT /groups/:group_id/messages`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMessageEnvelope {
    /// 64-character lowercase hex `group_id`.
    pub group_id: String,
    /// Epoch index $e$ whose key material encrypts and signs this message.
    pub epoch: u64,
    /// Hex-encoded AEAD nonce (24-byte XChaCha20-Poly1305 nonce).
    pub nonce: String,
    /// Hex-encoded AEAD ciphertext (sealing `senderAddress`, `senderEpochPubKey`, `senderSeq`,
    /// `innerSignature`, and `contentBytes` away from the relay).
    pub ciphertext: String,
    /// Hex-encoded 64-byte secp256k1 signature by the shared epoch write key $w_{G,e}$ over
    /// `SHA256("frank-group-msg-v1" || group_id || epoch_be || nonce || SHA256(ciphertext))`.
    pub write_sig: String,
}

impl GroupMessageEnvelope {
    /// Compute the 32-byte signing digest verified against $W_{G,e}$.
    pub fn signing_digest(&self) -> Result<[u8; 32], GroupError> {
        let group_id_bytes = parse_group_id_hex(&self.group_id)?;
        let nonce_bytes = parse_var_hex(&self.nonce, "nonce", 64)?;
        if nonce_bytes.is_empty() {
            return Err(GroupError::InvalidInput("nonce must not be empty".into()));
        }
        let ciphertext_bytes = parse_var_hex(&self.ciphertext, "ciphertext", 1024 * 1024)?;
        if ciphertext_bytes.is_empty() {
            return Err(GroupError::InvalidInput(
                "ciphertext must not be empty".into(),
            ));
        }
        let ct_hash: [u8; 32] = Sha256::digest(&ciphertext_bytes).into();
        let mut hasher = Sha256::new();
        hasher.update(GROUP_MSG_SIG_DOMAIN);
        hasher.update(group_id_bytes);
        hasher.update(self.epoch.to_be_bytes());
        hasher.update(&nonce_bytes);
        hasher.update(ct_hash);
        Ok(hasher.finalize().into())
    }

    /// Decode from canonical CBOR bytes.
    pub fn from_cbor_bytes(bytes: &[u8]) -> Result<Self, GroupError> {
        let val = decode_canonical(bytes).map_err(|e| GroupError::InvalidInput(e.to_string()))?;
        let CborValue::Map(entries) = val else {
            return Err(GroupError::InvalidInput("expected CBOR map".into()));
        };
        let mut group_id = None;
        let mut epoch = None;
        let mut nonce = None;
        let mut ciphertext = None;
        let mut write_sig = None;
        for (k, v) in entries {
            match (k, v) {
                (0, CborValue::Text(s)) => group_id = Some(s),
                (0, CborValue::Bytes(b)) => group_id = Some(hex::encode(b)),
                (1, CborValue::Int(n)) if n >= 0 => epoch = u64::try_from(n).ok(),
                (2, CborValue::Text(s)) => nonce = Some(s),
                (2, CborValue::Bytes(b)) => nonce = Some(hex::encode(b)),
                (3, CborValue::Text(s)) => ciphertext = Some(s),
                (3, CborValue::Bytes(b)) => ciphertext = Some(hex::encode(b)),
                (4, CborValue::Text(s)) => write_sig = Some(s),
                (4, CborValue::Bytes(b)) => write_sig = Some(hex::encode(b)),
                _ => {}
            }
        }
        Ok(Self {
            group_id: group_id
                .ok_or_else(|| GroupError::InvalidInput("missing group_id".into()))?,
            epoch: epoch.ok_or_else(|| GroupError::InvalidInput("missing epoch".into()))?,
            nonce: nonce.ok_or_else(|| GroupError::InvalidInput("missing nonce".into()))?,
            ciphertext: ciphertext
                .ok_or_else(|| GroupError::InvalidInput("missing ciphertext".into()))?,
            write_sig: write_sig
                .ok_or_else(|| GroupError::InvalidInput("missing write_sig".into()))?,
        })
    }
}

/// Stored group message with relay-assigned `server_seq`, `server_time_ms`, and `versionstamp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredGroupMessage {
    /// 64-character lowercase hex `group_id`.
    pub group_id: String,
    /// Strictly monotonic per-group sequence number (`1, 2, 3, ...`).
    pub server_seq: u64,
    /// Relay delivery timestamp in milliseconds.
    pub server_time_ms: u64,
    /// 20-char hex 80-bit [`Versionstamp`] assigned at commit.
    pub versionstamp: String,
    /// Epoch index $e$ under which this message was authenticated.
    pub epoch: u64,
    /// Hex-encoded AEAD nonce.
    pub nonce: String,
    /// Hex-encoded AEAD ciphertext.
    pub ciphertext: String,
    /// Hex-encoded outer write signature over `(group_id, epoch, nonce, SHA256(ciphertext))`.
    pub write_sig: String,
}

/// Mirroring and subscriber tracking state for a foreign group hosted on an upstream relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMirrorState {
    /// 64-character lowercase hex `group_id`.
    pub group_id: String,
    /// Base URL of the authoritative upstream group relay.
    pub upstream_relay: String,
    /// Blinded local subscriber tags (`X-Group-Subscriber-Tag`) that have subscribed via this Home Relay.
    pub subscribers: BTreeSet<String>,
    /// True once `subscribers.len() >= mirror_threshold`, promoting this Home Relay from
    /// stateless oblivious proxy (`< n`) to a locally mirrored group cache (`>= n`).
    pub mirrored: bool,
    /// Highest `server_seq` synced into local storage from the upstream relay.
    pub last_synced_seq: u64,
}

/// Errors produced by [`GroupStore`] operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GroupError {
    /// Malformed input frame, hex, or parameter.
    #[error("invalid group input: {0}")]
    InvalidInput(String),
    /// Group does not exist on this relay.
    #[error("group not found: {0}")]
    NotFound(String),
    /// Atomic CAS conflict on epoch transition (`409 Conflict`).
    #[error("epoch conflict: current epoch is {}", current.epoch)]
    EpochConflict {
        /// The authoritative current epoch frame stored on the relay.
        current: Box<GroupEpochFrame>,
    },
    /// Caller's `write_sig`, `epoch`, or `X-Group-Read-Token` was rejected (`403 Forbidden`).
    #[error("group access forbidden: {0}")]
    Forbidden(String),
    /// Underlying KV store or upstream proxy failure.
    #[error("group storage error: {0}")]
    Storage(String),
}

impl From<KvError> for GroupError {
    fn from(err: KvError) -> Self {
        GroupError::Storage(err.to_string())
    }
}

fn meta_key(group_id: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_GROUP_META.len() + 1 + 32);
    k.extend_from_slice(SUBSPACE_GROUP_META);
    k.push(b':');
    k.extend_from_slice(group_id);
    k
}

fn epoch_history_key(group_id: &[u8; 32], epoch: u64) -> Vec<u8> {
    let mut k = Vec::with_capacity(b"G_epoch:".len() + 32 + 8);
    k.extend_from_slice(b"G_epoch:");
    k.extend_from_slice(group_id);
    k.extend_from_slice(&epoch.to_be_bytes());
    k
}

fn seq_key(group_id: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(b"G_seq:".len() + 32);
    k.extend_from_slice(b"G_seq:");
    k.extend_from_slice(group_id);
    k
}

fn msg_prefix(group_id: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(SUBSPACE_GROUP_MESSAGES.len() + 1 + 32);
    k.extend_from_slice(SUBSPACE_GROUP_MESSAGES);
    k.push(b':');
    k.extend_from_slice(group_id);
    k
}

fn msg_key(group_id: &[u8; 32], server_seq: u64) -> Vec<u8> {
    let mut k = msg_prefix(group_id);
    k.extend_from_slice(&server_seq.to_be_bytes());
    k
}

fn mirror_key(group_id: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(b"G_mirror:".len() + 32);
    k.extend_from_slice(b"G_mirror:");
    k.extend_from_slice(group_id);
    k
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The authoritative acceptance receipt and whether this operation created it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupAppendOutcome {
    /// Original immutable receipt, including its original sequence and timestamp.
    pub message: StoredGroupMessage,
    /// True only for the transaction that created the receipt.
    pub appended: bool,
}

const GROUP_FORMAT_KEY: &[u8] = b"G_format";
const GROUP_FORMAT: &[u8] = b"group-append-idempotency-v1";
const GROUP_OWNED_PREFIXES: &[&[u8]] = &[
    b"G:",
    b"G_meta:",
    b"G_epoch:",
    b"G_seq:",
    b"G_mirror:",
    b"G_vs:",
    b"G_accept:",
];

fn acceptance_key(group_id: &[u8; 32], digest: &[u8; 32]) -> Vec<u8> {
    [b"G_accept:".as_slice(), group_id, digest].concat()
}

/// Shared Group Mailbox state machine backed by any [`RelayKvStore`].
#[derive(Debug, Clone)]
pub struct GroupStore {
    kv: Arc<dyn RelayKvStore>,
    mirror_threshold: usize,
}

impl GroupStore {
    /// Construct a `GroupStore` over the given [`RelayKvStore`] with default mirror threshold (`2`).
    pub fn new(kv: Arc<dyn RelayKvStore>) -> Self {
        Self {
            kv,
            mirror_threshold: DEFAULT_GROUP_MIRROR_THRESHOLD,
        }
    }

    /// Construct a `GroupStore` with a custom subscriber threshold `n` for auto-mirroring.
    pub fn with_mirror_threshold(kv: Arc<dyn RelayKvStore>, mirror_threshold: usize) -> Self {
        Self {
            kv,
            mirror_threshold: mirror_threshold.max(1),
        }
    }

    /// Construct an in-memory `GroupStore` for tests.
    pub fn new_in_memory() -> Self {
        Self::new(Arc::new(MemoryKvStore::new()))
    }

    /// Borrow the underlying [`RelayKvStore`].
    pub fn kv(&self) -> &Arc<dyn RelayKvStore> {
        &self.kv
    }

    /// Configured subscriber count threshold `n` for promoting a foreign group from proxy to mirror.
    pub fn mirror_threshold(&self) -> usize {
        self.mirror_threshold
    }

    /// Inspect only this owner's namespace. Opening/reading never initializes or resets it.
    fn check_baseline(&self) -> Result<(), GroupError> {
        match self.kv.get(GROUP_FORMAT_KEY)? {
            Some(version) if version == GROUP_FORMAT => Ok(()),
            Some(_) => Err(GroupError::Storage("unsupported group store format; preserve/export group receipts and explicitly reset only disposable dedicated group relay state".into())),
            None => {
                for prefix in GROUP_OWNED_PREFIXES {
                    if !self.kv.scan_prefix_range(prefix, None, 1)?.is_empty() {
                        // Another new-format writer may have initialized and committed since the first read.
                        if self.kv.get(GROUP_FORMAT_KEY)?.as_deref() == Some(GROUP_FORMAT) { return Ok(()); }
                        return Err(GroupError::Storage("group store lacks append-idempotency format marker; old nonempty group state is unsupported; no automatic migration or deletion".into()));
                    }
                }
                Ok(())
            }
        }
    }

    /// Called only after an authorized mutation; marker-only interruption is a valid empty store.
    fn initialize_baseline(&self) -> Result<(), GroupError> {
        self.check_baseline()?;
        match self
            .kv
            .compare_and_swap(GROUP_FORMAT_KEY, None, GROUP_FORMAT)
        {
            Ok(()) => Ok(()),
            Err(KvError::CasConflict {
                current: Some(version),
            }) if version == GROUP_FORMAT => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Fetch the current [`GroupEpochFrame`] for `group_id_hex`, if the group exists locally.
    pub fn get_current_epoch(
        &self,
        group_id_hex: &str,
    ) -> Result<Option<GroupEpochFrame>, GroupError> {
        self.check_baseline()?;
        let group_id = parse_group_id_hex(group_id_hex)?;
        let Some(raw) = self.kv.get(&meta_key(&group_id))? else {
            return Ok(None);
        };
        let frame = GroupEpochFrame::from_cbor_bytes(&raw)?;
        Ok(Some(frame))
    }

    /// Fetch a specific historical [`GroupEpochFrame`] by epoch number.
    pub fn get_epoch(
        &self,
        group_id_hex: &str,
        epoch: u64,
    ) -> Result<Option<GroupEpochFrame>, GroupError> {
        self.check_baseline()?;
        let group_id = parse_group_id_hex(group_id_hex)?;
        let Some(raw) = self.kv.get(&epoch_history_key(&group_id, epoch))? else {
            return Ok(None);
        };
        let frame = GroupEpochFrame::from_cbor_bytes(&raw)?;
        Ok(Some(frame))
    }

    /// Atomically advance or initialize the group's epoch via Compare-And-Swap (`CAS`).
    ///
    /// - Epoch `0`: initializes the group if no epoch exists; otherwise returns `409 Conflict`
    ///   (`GroupError::EpochConflict`) carrying the current epoch frame.
    /// - Epoch `e > 0`: requires `current.epoch == e - 1` and `frame.prev_epoch_hash == current.epoch_hash`;
    ///   otherwise returns `409 Conflict` (`GroupError::EpochConflict`) with `current`.
    pub fn put_epoch(
        &self,
        path_group_id: &str,
        frame: GroupEpochFrame,
    ) -> Result<GroupEpochFrame, GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        let frame = frame.normalized()?;
        if frame.group_id != path_group_id {
            return Err(GroupError::InvalidInput(
                "frame.group_id does not match URL path :group_id".into(),
            ));
        }

        frame.verify_authority(path_group_id)?;
        self.initialize_baseline()?;
        if self.get_mirror_state(path_group_id)?.is_some() {
            return Err(GroupError::Forbidden(
                "foreign groups cannot accept local epoch writes".into(),
            ));
        }
        let m_key = meta_key(&group_id);
        let current_raw = self.kv.get(&m_key)?;
        let encoded_new = frame.to_cbor_bytes()?;

        let expected = match (frame.epoch, current_raw.as_deref()) {
            (0, None) => None,
            (_, Some(existing)) => {
                let current = GroupEpochFrame::from_cbor_bytes(existing)?;
                if frame.epoch == 0
                    || current.epoch.checked_add(1) != Some(frame.epoch)
                    || frame.prev_epoch_hash != current.epoch_hash
                {
                    return Err(GroupError::EpochConflict {
                        current: Box::new(current),
                    });
                }
                Some(existing)
            }
            (_, None) => {
                return Err(GroupError::InvalidInput(
                    "initial group epoch must be 0".into(),
                ))
            }
        };
        let ownership_key = mirror_key(&group_id);
        // CAS followed by delete expresses a read-only absence guard in the existing
        // transaction vocabulary: no ownership row is visible before or after commit.
        let operations = vec![
            KvTransactionOp::CheckAndSet {
                key: ownership_key.clone(),
                expected: None,
                new_value: Vec::new(),
            },
            KvTransactionOp::Delete { key: ownership_key },
            KvTransactionOp::CheckAndSet {
                key: m_key,
                expected: expected.map(<[u8]>::to_vec),
                new_value: encoded_new.clone(),
            },
            KvTransactionOp::Put {
                key: epoch_history_key(&group_id, frame.epoch),
                value: encoded_new,
            },
        ];
        match self.kv.execute_transaction(operations) {
            Ok(_) => {}
            Err(KvError::CasConflict { .. }) => {
                if self.get_mirror_state(path_group_id)?.is_some() {
                    return Err(GroupError::Forbidden(
                        "foreign groups cannot accept local epoch writes".into(),
                    ));
                }
                let current = self.get_current_epoch(path_group_id)?.ok_or_else(|| {
                    GroupError::Storage("epoch transaction conflicted without current epoch".into())
                })?;
                return Err(GroupError::EpochConflict {
                    current: Box::new(current),
                });
            }
            Err(error) => return Err(error.into()),
        }

        Ok(frame)
    }

    /// Verify `X-Group-Read-Token` ($R_{G,e}$ where $\text{SHA256}(R_{G,e}) = \text{read\_token\_hash}$).
    pub fn verify_read_token(
        &self,
        group_id_hex: &str,
        read_token_hex: &str,
    ) -> Result<GroupEpochFrame, GroupError> {
        let current = self
            .get_current_epoch(group_id_hex)?
            .ok_or_else(|| GroupError::NotFound(group_id_hex.to_string()))?;
        current.verify_read_token(read_token_hex)?;
        Ok(current)
    }

    /// Authenticate new content against the active epoch and append exactly once. Accepted
    /// signed content (including equivalent signature encodings) is authenticated against its
    /// historical certificate and returns the original receipt, without a new sequence or wake.
    pub fn put_message(
        &self,
        path_group_id: &str,
        mut envelope: GroupMessageEnvelope,
    ) -> Result<GroupAppendOutcome, GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        if envelope.group_id.to_lowercase() != path_group_id {
            return Err(GroupError::InvalidInput(
                "envelope.group_id does not match URL path :group_id".into(),
            ));
        }

        if self.get_mirror_state(path_group_id)?.is_some() {
            return Err(GroupError::Forbidden(
                "foreign groups cannot accept local message writes".into(),
            ));
        }
        envelope.group_id = path_group_id.to_string();
        envelope.nonce = hex::encode(parse_var_hex(&envelope.nonce, "nonce", 64)?);
        envelope.ciphertext = hex::encode(parse_var_hex(
            &envelope.ciphertext,
            "ciphertext",
            1024 * 1024,
        )?);
        let digest = envelope.signing_digest()?;
        let accept_key = acceptance_key(&group_id, &digest);
        if let Some(message) = self.accepted_message(path_group_id, &envelope, &accept_key)? {
            return Ok(GroupAppendOutcome {
                message,
                appended: false,
            });
        }
        let ownership_key = mirror_key(&group_id);
        let authority_key = meta_key(&group_id);
        let authority_snapshot = self
            .kv
            .get(&authority_key)?
            .ok_or_else(|| GroupError::NotFound(path_group_id.to_string()))?;
        let current_epoch = GroupEpochFrame::from_cbor_bytes(&authority_snapshot)?;

        // Reject messages targeting a stale or future epoch (e.g. kicked member from prior epoch)
        if envelope.epoch != current_epoch.epoch {
            // The first empty lookup may predate an acceptance followed by this rotation.
            // Recheck after observing authority: an old-epoch acceptance cannot commit later.
            if let Some(message) = self.accepted_message(path_group_id, &envelope, &accept_key)? {
                return Ok(GroupAppendOutcome {
                    message,
                    appended: false,
                });
            }
            return Err(GroupError::Forbidden(format!(
                "message epoch {} does not match active group epoch {}",
                envelope.epoch, current_epoch.epoch
            )));
        }

        let write_pubkey = parse_fixed_hex::<33>(&current_epoch.write_pubkey, "write_pubkey")?;
        let sig_bytes = parse_var_hex(&envelope.write_sig, "write_sig", 73)
            .map_err(|_| GroupError::Forbidden("malformed write_sig".into()))?;

        if !verify_secp256k1_sig(&write_pubkey, &digest, &sig_bytes) {
            return Err(GroupError::Forbidden(
                "invalid write_sig for active group epoch write_pubkey".into(),
            ));
        }

        let sequence_key = seq_key(&group_id);
        loop {
            let sequence_snapshot = self.kv.get(&sequence_key)?;
            let server_seq = match &sequence_snapshot {
                Some(bytes) => u64::from_be_bytes(
                    bytes
                        .as_slice()
                        .try_into()
                        .map_err(|_| GroupError::Storage("corrupt G_seq value".into()))?,
                )
                .checked_add(1)
                .ok_or_else(|| GroupError::Storage("group sequence exhausted".into()))?,
                None => 1,
            };
            // Versionstamp allocation is metadata only. An unused stamp after contention does
            // not append a message or advance the authoritative group sequence.
            let (_, vs) =
                self.kv
                    .put_versionstamped(b"G_vs:", &group_id, &server_seq.to_be_bytes())?;
            let stored = StoredGroupMessage {
                group_id: path_group_id.to_string(),
                server_seq,
                server_time_ms: vs.commit_version().max(now_ms()),
                versionstamp: vs.to_hex(),
                epoch: envelope.epoch,
                nonce: envelope
                    .nonce
                    .strip_prefix("0x")
                    .unwrap_or(&envelope.nonce)
                    .to_lowercase(),
                ciphertext: envelope
                    .ciphertext
                    .strip_prefix("0x")
                    .unwrap_or(&envelope.ciphertext)
                    .to_lowercase(),
                write_sig: envelope
                    .write_sig
                    .strip_prefix("0x")
                    .unwrap_or(&envelope.write_sig)
                    .to_lowercase(),
            };
            let serialized = serde_json::to_vec(&stored).map_err(|error| {
                GroupError::Storage(format!("serialize group message: {error}"))
            })?;
            let row_key = msg_key(&group_id, server_seq);
            let next_sequence = server_seq.to_be_bytes();
            // This is the authorization linearization point: epoch rotation and append use
            // the same storage transaction boundary, including across relay instances.
            let operations = vec![
                KvTransactionOp::CheckAndSet {
                    key: accept_key.clone(),
                    expected: None,
                    new_value: server_seq.to_be_bytes().to_vec(),
                },
                KvTransactionOp::CheckAndSet {
                    key: ownership_key.clone(),
                    expected: None,
                    new_value: Vec::new(),
                },
                KvTransactionOp::Delete {
                    key: ownership_key.clone(),
                },
                KvTransactionOp::CheckAndSet {
                    key: authority_key.clone(),
                    expected: Some(authority_snapshot.clone()),
                    new_value: authority_snapshot.clone(),
                },
                KvTransactionOp::CheckAndSet {
                    key: sequence_key.clone(),
                    expected: sequence_snapshot,
                    new_value: next_sequence.to_vec(),
                },
                KvTransactionOp::Put {
                    key: row_key,
                    value: serialized,
                },
            ];
            match self.kv.execute_transaction(operations) {
                Ok(_) => {
                    return Ok(GroupAppendOutcome {
                        message: stored,
                        appended: true,
                    })
                }
                Err(KvError::CasConflict { .. }) => {
                    if let Some(message) =
                        self.accepted_message(path_group_id, &envelope, &accept_key)?
                    {
                        return Ok(GroupAppendOutcome {
                            message,
                            appended: false,
                        });
                    }
                    if self.get_mirror_state(path_group_id)?.is_some() {
                        return Err(GroupError::Forbidden(
                            "group ownership changed before message commit".into(),
                        ));
                    }
                    if self.kv.get(&authority_key)?.as_deref() != Some(&authority_snapshot) {
                        return Err(GroupError::Forbidden(
                            "group epoch changed before message commit".into(),
                        ));
                    }
                    // Another authorized append won this sequence; retry without reusing it.
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn accepted_message(
        &self,
        group_id_hex: &str,
        envelope: &GroupMessageEnvelope,
        accept_key: &[u8],
    ) -> Result<Option<StoredGroupMessage>, GroupError> {
        if self.get_mirror_state(group_id_hex)?.is_some() {
            return Err(GroupError::Forbidden(
                "foreign groups cannot acknowledge local authoritative writes".into(),
            ));
        }
        let Some(locator) = self.kv.get(accept_key)? else {
            return Ok(None);
        };
        let sequence = u64::from_be_bytes(
            locator
                .as_slice()
                .try_into()
                .map_err(|_| GroupError::Storage("corrupt group acceptance locator".into()))?,
        );
        let group_id = parse_group_id_hex(group_id_hex)?;
        let raw = self.kv.get(&msg_key(&group_id, sequence))?.ok_or_else(|| {
            GroupError::Storage("group acceptance index references missing receipt".into())
        })?;
        let stored: StoredGroupMessage = serde_json::from_slice(&raw).map_err(|error| {
            GroupError::Storage(format!("corrupt group acceptance receipt: {error}"))
        })?;
        if stored.group_id != group_id_hex
            || stored.server_seq != sequence
            || stored.epoch != envelope.epoch
            || stored.nonce != envelope.nonce
            || stored.ciphertext != envelope.ciphertext
        {
            return Err(GroupError::Storage(
                "group acceptance index does not match signed content".into(),
            ));
        }
        let cert = self.get_epoch(group_id_hex, stored.epoch)?.ok_or_else(|| {
            GroupError::Storage("accepted message missing historical certificate".into())
        })?;
        cert.verify_authority(group_id_hex)?;
        if cert.epoch != stored.epoch {
            return Err(GroupError::Storage(
                "acceptance history certificate has wrong epoch".into(),
            ));
        }
        let public_key = parse_fixed_hex::<33>(&cert.write_pubkey, "write_pubkey")?;
        let original_signature = parse_var_hex(&stored.write_sig, "stored write_sig", 73)
            .map_err(|_| GroupError::Storage("corrupt original acceptance signature".into()))?;
        if !verify_secp256k1_sig(
            &public_key,
            &envelope.signing_digest()?,
            &original_signature,
        ) {
            return Err(GroupError::Storage(
                "original acceptance signature no longer authenticates receipt".into(),
            ));
        }
        let signature = parse_var_hex(&envelope.write_sig, "write_sig", 73)
            .map_err(|_| GroupError::Forbidden("malformed retry write_sig".into()))?;
        if !verify_secp256k1_sig(&public_key, &envelope.signing_digest()?, &signature) {
            return Err(GroupError::Forbidden(
                "invalid historical retry write_sig".into(),
            ));
        }
        Ok(Some(stored))
    }

    /// Scan ordered messages for `group_id_hex` strictly after `after_seq`, up to `limit`.
    pub fn list_messages(
        &self,
        group_id_hex: &str,
        after_seq: u64,
        limit: u16,
    ) -> Result<Vec<StoredGroupMessage>, GroupError> {
        self.check_baseline()?;
        let group_id = parse_group_id_hex(group_id_hex)?;
        let prefix = msg_prefix(&group_id);
        let after_key = if after_seq > 0 {
            Some(msg_key(&group_id, after_seq))
        } else {
            None
        };
        let bounded_limit = (limit as usize).clamp(1, 500);
        let rows = self
            .kv
            .scan_prefix_range(&prefix, after_key.as_deref(), bounded_limit)?;
        let mut messages = Vec::with_capacity(rows.len());
        for (_, val) in rows {
            let msg: StoredGroupMessage = serde_json::from_slice(&val)
                .map_err(|e| GroupError::Storage(format!("decode stored group message: {e}")))?;
            messages.push(msg);
        }
        Ok(messages)
    }

    /// Admit a foreign subscriber using a root-signed epoch and its matching read capability.
    /// The HTTP boundary first requires a successful read from the selected upstream;
    /// this store also enforces capability, epoch freshness, and immutable upstream ownership.
    /// Returns the updated [`GroupMirrorState`] (automatically promoting `mirrored = true`
    /// once `subscribers.len() >= self.mirror_threshold`).
    pub fn record_foreign_subscriber(
        &self,
        group_id_hex: &str,
        upstream_relay: &str,
        subscriber_tag: &str,
        authenticated_epoch: &GroupEpochFrame,
        read_token: &str,
    ) -> Result<GroupMirrorState, GroupError> {
        authenticated_epoch.verify_authority(group_id_hex)?;
        authenticated_epoch.verify_read_token(read_token)?;
        self.initialize_baseline()?;
        let group_id = parse_group_id_hex(group_id_hex)?;
        let m_key = mirror_key(&group_id);
        loop {
            let current_raw = self.kv.get(&m_key)?;
            let authority_key = meta_key(&group_id);
            let authority_raw = self.kv.get(&authority_key)?;
            if let Some(raw) = &authority_raw {
                if current_raw.is_none() {
                    return Err(GroupError::Forbidden(
                        "local group cannot become a foreign mirror".into(),
                    ));
                }
                let current = GroupEpochFrame::from_cbor_bytes(raw)?;
                if current.epoch > authenticated_epoch.epoch
                    || (current.epoch == authenticated_epoch.epoch
                        && current.epoch_hash
                            != hex::encode(authenticated_epoch.compute_epoch_hash()?))
                {
                    return Err(GroupError::Forbidden(
                        "read capability targets a stale or conflicting group epoch".into(),
                    ));
                }
            }

            let mut state = match &current_raw {
                Some(bytes) => serde_json::from_slice::<GroupMirrorState>(bytes)
                    .map_err(|e| GroupError::Storage(e.to_string()))?,
                None => GroupMirrorState {
                    group_id: group_id_hex.to_string(),
                    upstream_relay: upstream_relay.trim_end_matches('/').to_string(),
                    subscribers: BTreeSet::new(),
                    mirrored: false,
                    last_synced_seq: 0,
                },
            };
            if state.upstream_relay != upstream_relay.trim_end_matches('/') {
                return Err(GroupError::Forbidden(
                    "group upstream does not match established ownership".into(),
                ));
            }
            if !subscriber_tag.trim().is_empty() {
                state.subscribers.insert(subscriber_tag.trim().to_string());
            }
            if state.subscribers.len() >= self.mirror_threshold {
                state.mirrored = true;
            }
            let encoded =
                serde_json::to_vec(&state).map_err(|e| GroupError::Storage(e.to_string()))?;
            let mut operations = vec![KvTransactionOp::CheckAndSet {
                key: m_key.clone(),
                expected: current_raw.clone(),
                new_value: encoded,
            }];
            operations.push(KvTransactionOp::CheckAndSet {
                key: authority_key.clone(),
                expected: authority_raw.clone(),
                new_value: authority_raw.clone().unwrap_or_default(),
            });
            if authority_raw.is_none() {
                operations.push(KvTransactionOp::Delete { key: authority_key });
            }
            match self.kv.execute_transaction(operations) {
                Ok(_) => return Ok(state),
                Err(KvError::CasConflict { .. }) => {
                    if self.get_mirror_state(group_id_hex)?.is_none()
                        && self.get_current_epoch(group_id_hex)?.is_some()
                    {
                        return Err(GroupError::Forbidden(
                            "local group cannot become a foreign mirror".into(),
                        ));
                    }
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// Ingest synced epoch and messages fetched from an upstream foreign relay into this
    /// Home Relay's local mirror store.
    pub fn ingest_mirrored_upstream(
        &self,
        group_id_hex: &str,
        epoch_frame: Option<GroupEpochFrame>,
        messages: &[StoredGroupMessage],
    ) -> Result<u64, GroupError> {
        let group_id = parse_group_id_hex(group_id_hex)?;
        self.check_baseline()?;
        // An empty import has no authenticated material and must remain a read-only no-op.
        if epoch_frame.is_none() && messages.is_empty() {
            return Ok(0);
        }
        // Validate the complete batch before allowing an upstream response to alter local state.
        let epoch_frame = epoch_frame.map(GroupEpochFrame::normalized).transpose()?;
        if let Some(frame) = &epoch_frame {
            frame.verify_authority(group_id_hex)?;
        }
        for message in messages {
            if message.group_id != group_id_hex || message.server_seq == 0 {
                return Err(GroupError::Forbidden(
                    "invalid mirrored message affinity or sequence".into(),
                ));
            }
            let cert = match &epoch_frame {
                Some(frame) if frame.epoch == message.epoch => frame.clone(),
                _ => self
                    .get_epoch(group_id_hex, message.epoch)?
                    .ok_or_else(|| {
                        GroupError::Forbidden("missing mirrored message epoch certificate".into())
                    })?,
            };
            cert.verify_authority(group_id_hex)?;
            let envelope = GroupMessageEnvelope {
                group_id: message.group_id.clone(),
                epoch: message.epoch,
                nonce: message.nonce.clone(),
                ciphertext: message.ciphertext.clone(),
                write_sig: message.write_sig.clone(),
            };
            let signature = parse_var_hex(&message.write_sig, "write_sig", 73)?;
            let key = parse_fixed_hex::<33>(&cert.write_pubkey, "write_pubkey")?;
            if !verify_secp256k1_sig(&key, &envelope.signing_digest()?, &signature) {
                return Err(GroupError::Forbidden(
                    "invalid mirrored message write_sig".into(),
                ));
            }
        }
        self.initialize_baseline()?;
        if let Some(frame) = epoch_frame {
            let encoded = frame.to_cbor_bytes()?;
            // A delayed upstream response must never roll the active authority/read token backwards.
            loop {
                let current_raw = self.kv.get(&meta_key(&group_id))?;
                if let Some(raw) = &current_raw {
                    let current = GroupEpochFrame::from_cbor_bytes(raw)?;
                    if current.epoch >= frame.epoch {
                        if current.epoch == frame.epoch && current.epoch_hash != frame.epoch_hash {
                            return Err(GroupError::EpochConflict {
                                current: Box::new(current),
                            });
                        }
                        break;
                    }
                }
                match self.kv.compare_and_swap(
                    &meta_key(&group_id),
                    current_raw.as_deref(),
                    &encoded,
                ) {
                    Ok(()) => break,
                    Err(KvError::CasConflict { .. }) => continue,
                    Err(error) => return Err(error.into()),
                }
            }
            match self.kv.compare_and_swap(
                &epoch_history_key(&group_id, frame.epoch),
                None,
                &encoded,
            ) {
                Ok(()) => {}
                Err(KvError::CasConflict {
                    current: Some(existing),
                }) if existing == encoded => {}
                Err(error) => return Err(error.into()),
            }
        }

        let mut max_seq = 0u64;
        for msg in messages {
            let serialized =
                serde_json::to_vec(msg).map_err(|e| GroupError::Storage(e.to_string()))?;
            self.kv
                .put(&msg_key(&group_id, msg.server_seq), &serialized)?;
            if msg.server_seq > max_seq {
                max_seq = msg.server_seq;
            }
        }

        if max_seq > 0 {
            let s_key = seq_key(&group_id);
            let current_seq = self
                .kv
                .get(&s_key)?
                .and_then(|b| b.as_slice().try_into().ok().map(u64::from_be_bytes))
                .unwrap_or(0);
            if max_seq > current_seq {
                self.kv.put(&s_key, &max_seq.to_be_bytes())?;
            }

            let m_key = mirror_key(&group_id);
            if let Some(raw) = self.kv.get(&m_key)? {
                if let Ok(mut state) = serde_json::from_slice::<GroupMirrorState>(&raw) {
                    if max_seq > state.last_synced_seq {
                        state.last_synced_seq = max_seq;
                        if let Ok(encoded) = serde_json::to_vec(&state) {
                            let _ = self.kv.put(&m_key, &encoded);
                        }
                    }
                }
            }
        }

        Ok(max_seq)
    }

    /// Read the current [`GroupMirrorState`] for `group_id_hex` if any.
    pub fn get_mirror_state(
        &self,
        group_id_hex: &str,
    ) -> Result<Option<GroupMirrorState>, GroupError> {
        self.check_baseline()?;
        let group_id = parse_group_id_hex(group_id_hex)?;
        let Some(raw) = self.kv.get(&mirror_key(&group_id))? else {
            return Ok(None);
        };
        let state = serde_json::from_slice(&raw).map_err(|e| GroupError::Storage(e.to_string()))?;
        Ok(Some(state))
    }
}

/// Lazy owner of the registry's durable [`GroupStore`], opened on first group request.
#[derive(Debug)]
pub struct Owner {
    path: PathBuf,
    store: OnceLock<GroupStore>,
    mirror_threshold: usize,
}

impl Owner {
    /// Create a lazy group store owner beside `registry_db`.
    pub fn new(registry_db: PathBuf) -> Self {
        Self {
            path: registry_db.with_extension(GROUP_STORE_EXTENSION),
            store: OnceLock::new(),
            mirror_threshold: DEFAULT_GROUP_MIRROR_THRESHOLD,
        }
    }

    /// Access or initialize the [`GroupStore`].
    pub fn get(&self) -> Result<&GroupStore, GroupError> {
        if let Some(store) = self.store.get() {
            store.check_baseline()?;
            return Ok(store);
        }
        let kv = RocksDbKvStore::open(&self.path)?;
        let store = GroupStore::with_mirror_threshold(Arc::new(kv), self.mirror_threshold);
        store.check_baseline()?;
        let _ = self.store.set(store);
        self.store
            .get()
            .ok_or_else(|| GroupError::Storage("failed to initialize GroupStore".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1_abc::SecretKey;

    fn keypair(seed_byte: u8) -> (SecretKey, [u8; 33]) {
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&[seed_byte; 32]).unwrap();
        let pk = PublicKey::from_secret_key(&secp, &sk).serialize();
        (sk, pk)
    }

    fn sign_digest(sk: &SecretKey, digest: &[u8; 32]) -> String {
        let secp = Secp256k1::new();
        let msg = SecpMessage::from_slice(digest).unwrap();
        let sig = secp.sign(&msg, sk);
        hex::encode(sig.serialize_compact())
    }

    fn signed_epoch(sk: &SecretKey, mut frame: GroupEpochFrame) -> GroupEpochFrame {
        frame.admin_sig = sign_digest(sk, &frame.compute_epoch_hash().unwrap());
        frame
    }

    fn root_frame(seed: u8, epoch: u64, previous: &str) -> GroupEpochFrame {
        let (root_sk, root_pk) = keypair(seed);
        let (_, write_pk) = keypair(42);
        signed_epoch(
            &root_sk,
            GroupEpochFrame {
                group_id: hex::encode(derive_group_id(&root_pk)),
                group_pubkey: hex::encode(root_pk),
                epoch,
                prev_epoch_hash: previous.to_string(),
                write_pubkey: hex::encode(write_pk),
                read_token_hash: hex::encode(Sha256::digest([epoch as u8; 32])),
                encrypted_epoch_descriptor: hex::encode(b"encrypted roster"),
                admin_sig: String::new(),
                epoch_hash: String::new(),
            },
        )
    }

    #[derive(Debug)]
    struct FailingCommitKv(Arc<dyn RelayKvStore>);

    impl RelayKvStore for FailingCommitKv {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
            self.0.get(key)
        }
        fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
            if key.starts_with(b"G_epoch:") {
                return Err(KvError::Backend("injected epoch history outage".into()));
            }
            self.0.put(key, value)
        }
        fn delete(&self, key: &[u8]) -> Result<(), KvError> {
            self.0.delete(key)
        }
        fn compare_and_swap(
            &self,
            key: &[u8],
            expected: Option<&[u8]>,
            value: &[u8],
        ) -> Result<(), KvError> {
            self.0.compare_and_swap(key, expected, value)
        }
        fn execute_transaction(
            &self,
            _: Vec<KvTransactionOp>,
        ) -> Result<Option<crate::store::kv_store::Versionstamp>, KvError> {
            Err(KvError::Backend("injected transaction outage".into()))
        }
        fn put_versionstamped(
            &self,
            prefix: &[u8],
            suffix: &[u8],
            value: &[u8],
        ) -> Result<(Vec<u8>, crate::store::kv_store::Versionstamp), KvError> {
            self.0.put_versionstamped(prefix, suffix, value)
        }
        fn scan_prefix_range(
            &self,
            prefix: &[u8],
            cursor: Option<&[u8]>,
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
            self.0.scan_prefix_range(prefix, cursor, limit)
        }
    }

    #[test]
    fn epoch_cas_backend_failures_are_not_reported_as_successful_creation_or_rotation() {
        let kv = Arc::new(MemoryKvStore::new());
        let healthy = GroupStore::new(kv.clone());
        let failing = GroupStore::new(Arc::new(FailingCommitKv(kv)));
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        assert!(matches!(
            failing.put_epoch(&id, initial.clone()),
            Err(GroupError::Storage(_))
        ));
        assert!(healthy.get_current_epoch(&id).unwrap().is_none());
        assert!(healthy.get_epoch(&id, 0).unwrap().is_none());
        let committed = healthy.put_epoch(&id, initial).unwrap();
        let next = root_frame(3, 1, &committed.epoch_hash);
        assert!(matches!(
            failing.put_epoch(&id, next),
            Err(GroupError::Storage(_))
        ));
        assert_eq!(healthy.get_current_epoch(&id).unwrap().unwrap(), committed);
        assert!(healthy.get_epoch(&id, 1).unwrap().is_none());
    }

    #[derive(Debug)]
    struct PausingCommitKv {
        backend: Arc<dyn RelayKvStore>,
        ready: std::sync::Barrier,
        resume: std::sync::Barrier,
        pause: std::sync::atomic::AtomicBool,
        pause_at_lookup: bool,
    }

    impl RelayKvStore for PausingCommitKv {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
            let result = self.backend.get(key);
            if self.pause_at_lookup
                && key.starts_with(b"G_accept:")
                && matches!(&result, Ok(None))
                && self.pause.swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.ready.wait();
                self.resume.wait();
            }
            result
        }
        fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
            self.backend.put(key, value)
        }
        fn delete(&self, key: &[u8]) -> Result<(), KvError> {
            self.backend.delete(key)
        }
        fn compare_and_swap(
            &self,
            key: &[u8],
            expected: Option<&[u8]>,
            value: &[u8],
        ) -> Result<(), KvError> {
            self.backend.compare_and_swap(key, expected, value)
        }
        fn execute_transaction(
            &self,
            ops: Vec<KvTransactionOp>,
        ) -> Result<Option<crate::store::kv_store::Versionstamp>, KvError> {
            self.backend.execute_transaction(ops)
        }
        fn put_versionstamped(
            &self,
            prefix: &[u8],
            suffix: &[u8],
            value: &[u8],
        ) -> Result<(Vec<u8>, crate::store::kv_store::Versionstamp), KvError> {
            if !self.pause_at_lookup && self.pause.swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.ready.wait();
                self.resume.wait();
            }
            self.backend.put_versionstamped(prefix, suffix, value)
        }
        fn scan_prefix_range(
            &self,
            prefix: &[u8],
            cursor: Option<&[u8]>,
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
            self.backend.scan_prefix_range(prefix, cursor, limit)
        }
    }

    fn message_for(id: &str, epoch: u64, nonce: u8, write_sk: &SecretKey) -> GroupMessageEnvelope {
        let mut message = GroupMessageEnvelope {
            group_id: id.to_string(),
            epoch,
            nonce: hex::encode([nonce; 24]),
            ciphertext: hex::encode(b"encrypted payload"),
            write_sig: String::new(),
        };
        message.write_sig = sign_digest(write_sk, &message.signing_digest().unwrap());
        message
    }

    fn verify_rotation_serializes_with_in_flight_appends(backend: Arc<dyn RelayKvStore>) {
        let store = GroupStore::new(backend.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let committed = store.put_epoch(&id, initial).unwrap();
        let paused_kv = Arc::new(PausingCommitKv {
            backend: backend.clone(),
            ready: std::sync::Barrier::new(2),
            resume: std::sync::Barrier::new(2),
            pause: std::sync::atomic::AtomicBool::new(true),
            pause_at_lookup: false,
        });
        let in_flight = GroupStore::new(paused_kv.clone());
        let (old_write_sk, _) = keypair(42);
        let pending = message_for(&id, 0, 1, &old_write_sk);
        let pending_id = id.clone();
        let thread = std::thread::spawn(move || in_flight.put_message(&pending_id, pending));
        // The old writer has already read epoch 0 and passed cryptographic validation.
        paused_kv.ready.wait();
        let (root_sk, _) = keypair(3);
        let (new_write_sk, new_write_pk) = keypair(43);
        let mut next = root_frame(3, 1, &committed.epoch_hash);
        next.write_pubkey = hex::encode(new_write_pk);
        next = signed_epoch(&root_sk, next);
        store.put_epoch(&id, next).unwrap();
        paused_kv.resume.wait();
        assert!(matches!(
            thread.join().unwrap(),
            Err(GroupError::Forbidden(_))
        ));
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
        assert!(backend
            .get(&seq_key(&parse_group_id_hex(&id).unwrap()))
            .unwrap()
            .is_none());
        // Independent relay instances can still append concurrently under the new authority.
        let start = Arc::new(std::sync::Barrier::new(9));
        let mut writers = Vec::new();
        for nonce in 2..10 {
            let replica = GroupStore::new(backend.clone());
            let writer_id = id.clone();
            let message = message_for(&id, 1, nonce, &new_write_sk);
            let writer_start = start.clone();
            writers.push(std::thread::spawn(move || {
                writer_start.wait();
                replica
                    .put_message(&writer_id, message)
                    .unwrap()
                    .message
                    .server_seq
            }));
        }
        start.wait();
        let mut sequences: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=8).collect::<Vec<_>>());
        let messages = store.list_messages(&id, 0, 10).unwrap();
        assert_eq!(messages.len(), 8);
        assert!(messages.iter().all(|message| message.epoch == 1));
    }

    #[test]
    fn memory_rotation_prevents_stale_commit_and_allows_concurrent_authorized_appends() {
        verify_rotation_serializes_with_in_flight_appends(Arc::new(MemoryKvStore::new()));
    }

    #[test]
    fn rocksdb_rotation_prevents_stale_commit_and_persists_atomic_appends() {
        let directory = tempdir::TempDir::new("group-rotation-atomicity").unwrap();
        let path = directory.path().join("groups.rocksdb");
        verify_rotation_serializes_with_in_flight_appends(Arc::new(
            RocksDbKvStore::open(&path).unwrap(),
        ));
        let reopened = GroupStore::new(Arc::new(RocksDbKvStore::open(&path).unwrap()));
        let id = root_frame(3, 0, &"00".repeat(32)).group_id;
        assert_eq!(reopened.get_current_epoch(&id).unwrap().unwrap().epoch, 1);
        assert_eq!(reopened.list_messages(&id, 0, 10).unwrap().len(), 8);
    }

    #[test]
    fn failed_atomic_append_does_not_publish_message_or_consume_sequence() {
        let kv = Arc::new(MemoryKvStore::new());
        let healthy = GroupStore::new(kv.clone());
        let failing = GroupStore::new(Arc::new(FailingCommitKv(kv.clone())));
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        healthy.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        assert!(matches!(
            failing.put_message(&id, message_for(&id, 0, 1, &write_sk)),
            Err(GroupError::Storage(_))
        ));
        assert!(healthy.list_messages(&id, 0, 10).unwrap().is_empty());
        assert!(kv
            .get(&seq_key(&parse_group_id_hex(&id).unwrap()))
            .unwrap()
            .is_none());
        assert_eq!(
            healthy
                .put_message(&id, message_for(&id, 0, 2, &write_sk))
                .unwrap()
                .message
                .server_seq,
            1
        );
    }

    #[test]
    fn epoch_commit_failure_preserves_complete_previous_state_across_reopen() {
        let directory = tempdir::TempDir::new("group-epoch-durability").unwrap();
        let path = directory.path().join("groups.rocksdb");
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        {
            let backend = Arc::new(RocksDbKvStore::open(&path).unwrap());
            let failing = GroupStore::new(Arc::new(FailingCommitKv(backend)));
            assert!(failing.put_epoch(&id, initial.clone()).is_err());
        }
        {
            let backend = Arc::new(RocksDbKvStore::open(&path).unwrap());
            let healthy = GroupStore::new(backend.clone());
            assert!(healthy.get_current_epoch(&id).unwrap().is_none());
            assert!(healthy.get_epoch(&id, 0).unwrap().is_none());
            let committed = healthy.put_epoch(&id, initial).unwrap();
            let failing = GroupStore::new(Arc::new(FailingCommitKv(backend)));
            assert!(failing
                .put_epoch(&id, root_frame(3, 1, &committed.epoch_hash))
                .is_err());
        }
        let reopened = GroupStore::new(Arc::new(RocksDbKvStore::open(&path).unwrap()));
        let current = reopened.get_current_epoch(&id).unwrap().unwrap();
        assert_eq!(current.epoch, 0);
        assert_eq!(reopened.get_epoch(&id, 0).unwrap().unwrap(), current);
        assert!(reopened.get_epoch(&id, 1).unwrap().is_none());
        let next = reopened
            .put_epoch(&id, root_frame(3, 1, &current.epoch_hash))
            .unwrap();
        assert_eq!(reopened.get_epoch(&id, 1).unwrap().unwrap(), next);
    }

    #[test]
    fn mirrors_reject_authoritative_local_message_and_epoch_writes() {
        let store = GroupStore::new_in_memory();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                "member",
                &initial,
                &"00".repeat(32),
            )
            .unwrap();
        store
            .ingest_mirrored_upstream(&id, Some(initial), &[])
            .unwrap();
        let (write_sk, _) = keypair(42);
        assert!(matches!(
            store.put_message(&id, message_for(&id, 0, 1, &write_sk)),
            Err(GroupError::Forbidden(_))
        ));
        let current = store.get_current_epoch(&id).unwrap().unwrap();
        assert!(matches!(
            store.put_epoch(&id, root_frame(3, 1, &current.epoch_hash)),
            Err(GroupError::Forbidden(_))
        ));
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
        assert_eq!(store.get_current_epoch(&id).unwrap().unwrap(), current);
    }

    #[test]
    fn foreign_admission_requires_capability_and_preserves_authoritative_ownership() {
        let store = GroupStore::new_in_memory();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        assert!(store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                "attacker",
                &initial,
                &"01".repeat(32)
            )
            .is_err());
        assert!(store.get_mirror_state(&id).unwrap().is_none());
        store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                "member",
                &initial,
                &"00".repeat(32),
            )
            .unwrap();
        assert!(store
            .record_foreign_subscriber(
                &id,
                "https://attacker.example",
                "attacker",
                &initial,
                &"00".repeat(32)
            )
            .is_err());
        store
            .ingest_mirrored_upstream(&id, Some(initial.clone()), &[])
            .unwrap();
        let old = store.get_current_epoch(&id).unwrap().unwrap();
        let next = root_frame(3, 1, &old.epoch_hash);
        store
            .ingest_mirrored_upstream(&id, Some(next), &[])
            .unwrap();
        assert!(store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                "stale",
                &initial,
                &"00".repeat(32)
            )
            .is_err());
        assert_eq!(
            store
                .get_mirror_state(&id)
                .unwrap()
                .unwrap()
                .subscribers
                .len(),
            1
        );

        let (write_sk, _) = keypair(42);
        assert!(matches!(
            store.put_message(&id, message_for(&id, 0, 1, &write_sk)),
            Err(GroupError::Forbidden(_))
        ));
        let current = store.get_current_epoch(&id).unwrap().unwrap();
        assert!(matches!(
            store.put_epoch(&id, root_frame(3, 1, &current.epoch_hash)),
            Err(GroupError::Forbidden(_))
        ));
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
        assert_eq!(store.get_current_epoch(&id).unwrap().unwrap(), current);
        let local = GroupStore::new_in_memory();
        local.put_epoch(&id, initial.clone()).unwrap();
        assert!(local
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                "member",
                &initial,
                &"00".repeat(32)
            )
            .is_err());
        assert!(local.get_mirror_state(&id).unwrap().is_none());
    }

    #[test]
    fn epoch_authority_rejects_forgery_and_binds_all_mutable_fields() {
        let store = GroupStore::new_in_memory();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let (write_sk, _) = keypair(42);
        let mut forged_creation = initial.clone();
        forged_creation.admin_sig = sign_digest(&write_sk, &initial.compute_epoch_hash().unwrap());
        assert!(matches!(
            store.put_epoch(&id, forged_creation),
            Err(GroupError::Forbidden(_))
        ));
        assert!(store.get_current_epoch(&id).unwrap().is_none());
        let committed = store.put_epoch(&id, initial.clone()).unwrap();
        assert_eq!(
            GroupEpochFrame::from_cbor_bytes(&committed.to_cbor_bytes().unwrap()).unwrap(),
            committed
        );
        let next = root_frame(3, 1, &committed.epoch_hash);
        let (attacker_sk, attacker_pk) = keypair(99);
        for signer in [&write_sk, &attacker_sk] {
            let mut forged = next.clone();
            forged.admin_sig = sign_digest(signer, &forged.compute_epoch_hash().unwrap());
            assert!(matches!(
                store.put_epoch(&id, forged),
                Err(GroupError::Forbidden(_))
            ));
        }
        let mut replaced_root = next.clone();
        replaced_root.group_pubkey = hex::encode(attacker_pk);
        replaced_root.admin_sig = sign_digest(&attacker_sk, &next.compute_epoch_hash().unwrap());
        assert!(matches!(
            store.put_epoch(&id, replaced_root),
            Err(GroupError::Forbidden(_))
        ));
        let mut mutations = vec![next.clone(); 5];
        mutations[0].write_pubkey = hex::encode(attacker_pk);
        mutations[1].read_token_hash = "01".repeat(32);
        mutations[2].encrypted_epoch_descriptor = hex::encode(b"attacker roster");
        mutations[3].prev_epoch_hash = "01".repeat(32);
        mutations[4].epoch = 2;
        for mutated in mutations {
            assert!(matches!(
                store.put_epoch(&id, mutated),
                Err(GroupError::Forbidden(_))
            ));
            assert_eq!(store.get_current_epoch(&id).unwrap().unwrap(), committed);
        }
        // Signature malleability is rejected, rather than normalized into an accepted certificate.
        let mut high_s = next.clone();
        let mut signature = hex::decode(&high_s.admin_sig).unwrap();
        let order = hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
            .unwrap();
        let mut borrow = 0i16;
        for index in (0..32).rev() {
            let difference = order[index] as i16 - signature[32 + index] as i16 - borrow;
            signature[32 + index] = difference.rem_euclid(256) as u8;
            borrow = if difference < 0 { 1 } else { 0 };
        }
        high_s.admin_sig = hex::encode(signature);
        assert!(matches!(
            store.put_epoch(&id, high_s),
            Err(GroupError::Forbidden(_))
        ));
        assert_eq!(store.put_epoch(&id, next).unwrap().epoch, 1);
        let mut malformed_initial = initial;
        malformed_initial.prev_epoch_hash = "01".repeat(32);
        assert!(malformed_initial.compute_epoch_hash().is_err());
    }

    #[test]
    fn mirror_rejects_poisoned_certificates_messages_and_epoch_rollback() {
        let store = GroupStore::new_in_memory();
        let epoch0 = root_frame(4, 0, &"00".repeat(32)).normalized().unwrap();
        let id = epoch0.group_id.clone();
        let mut poisoned = epoch0.clone();
        poisoned.encrypted_epoch_descriptor = hex::encode(b"forged roster");
        assert!(store
            .ingest_mirrored_upstream(&id, Some(poisoned), &[])
            .is_err());
        assert!(store.get_current_epoch(&id).unwrap().is_none());
        let epoch1 = root_frame(4, 1, &epoch0.epoch_hash).normalized().unwrap();
        store
            .ingest_mirrored_upstream(&id, Some(epoch1.clone()), &[])
            .unwrap();
        store
            .ingest_mirrored_upstream(&id, Some(epoch0), &[])
            .unwrap();
        assert_eq!(store.get_current_epoch(&id).unwrap().unwrap(), epoch1);
        let source = GroupStore::new_in_memory();
        let source_epoch = root_frame(4, 0, &"00".repeat(32));
        source.put_epoch(&id, source_epoch).unwrap();
        let (write_sk, _) = keypair(42);
        let mut envelope = GroupMessageEnvelope {
            group_id: id.clone(),
            epoch: 0,
            nonce: "01".repeat(24),
            ciphertext: hex::encode(b"valid ciphertext"),
            write_sig: String::new(),
        };
        envelope.write_sig = sign_digest(&write_sk, &envelope.signing_digest().unwrap());
        let message = source.put_message(&id, envelope).unwrap().message;
        let mut forged = message.clone();
        forged.ciphertext = hex::encode(b"forged ciphertext");
        assert!(store
            .ingest_mirrored_upstream(&id, None, &[message.clone(), forged])
            .is_err());
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
        let wrong_id = root_frame(5, 0, &"00".repeat(32)).group_id;
        assert!(store
            .ingest_mirrored_upstream(&wrong_id, Some(epoch1), &[])
            .is_err());
        store
            .ingest_mirrored_upstream(&id, None, &[message])
            .unwrap();
        assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn epoch_cas_enforces_monotonicity_and_rejects_concurrent_collision_with_current_frame() {
        let store = GroupStore::new_in_memory();
        let (group_sk, group_pk) = keypair(1);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (_, write_pk_0) = keypair(10);
        let read_token_0 = [0xaa; 32];
        let read_token_hash_0 = hex::encode(Sha256::digest(read_token_0));

        let mut epoch0 = GroupEpochFrame {
            group_id: group_id.clone(),
            group_pubkey: hex::encode(group_pk),
            epoch: 0,
            prev_epoch_hash: "00".repeat(32),
            write_pubkey: hex::encode(write_pk_0),
            read_token_hash: read_token_hash_0,
            encrypted_epoch_descriptor: hex::encode(b"epoch-0-descriptor"),
            admin_sig: "11".repeat(64),
            epoch_hash: String::new(),
        };

        epoch0.admin_sig = sign_digest(&group_sk, &epoch0.compute_epoch_hash().unwrap());
        let committed_0 = store.put_epoch(&group_id, epoch0.clone()).unwrap();
        assert_eq!(committed_0.epoch, 0);
        assert_eq!(committed_0.epoch_hash.len(), 64);

        // Competing epoch 0 initialization fails with 409 Conflict carrying committed_0
        let conflict_0 = store.put_epoch(&group_id, epoch0).unwrap_err();
        assert_eq!(
            conflict_0,
            GroupError::EpochConflict {
                current: Box::new(committed_0.clone())
            }
        );

        // Advance to epoch 1 with valid prev_epoch_hash
        let (_, write_pk_1) = keypair(11);
        let mut epoch1 = GroupEpochFrame {
            group_id: group_id.clone(),
            group_pubkey: hex::encode(group_pk),
            epoch: 1,
            prev_epoch_hash: committed_0.epoch_hash.clone(),
            write_pubkey: hex::encode(write_pk_1),
            read_token_hash: hex::encode(Sha256::digest([0xbb; 32])),
            encrypted_epoch_descriptor: hex::encode(b"epoch-1-descriptor"),
            admin_sig: "22".repeat(64),
            epoch_hash: String::new(),
        };
        epoch1.admin_sig = sign_digest(&group_sk, &epoch1.compute_epoch_hash().unwrap());
        let committed_1 = store.put_epoch(&group_id, epoch1.clone()).unwrap();
        assert_eq!(committed_1.epoch, 1);

        // Stale admin trying to submit another epoch 1 fails with 409 Conflict carrying committed_1
        let stale_err = store.put_epoch(&group_id, epoch1).unwrap_err();
        assert_eq!(
            stale_err,
            GroupError::EpochConflict {
                current: Box::new(committed_1)
            }
        );
    }

    #[test]
    fn group_messages_enforce_epoch_write_key_and_reject_kicked_or_outsider_keys() {
        let store = GroupStore::new_in_memory();
        let (group_sk, group_pk) = keypair(2);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (write_sk_0, write_pk_0) = keypair(20);
        let read_token_0 = [0xcc; 32];
        let epoch0 = store
            .put_epoch(
                &group_id,
                signed_epoch(
                    &group_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(group_pk),
                        epoch: 0,
                        prev_epoch_hash: "00".repeat(32),
                        write_pubkey: hex::encode(write_pk_0),
                        read_token_hash: hex::encode(Sha256::digest(read_token_0)),
                        encrypted_epoch_descriptor: hex::encode(b"desc0"),
                        admin_sig: "11".repeat(64),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();

        // Valid epoch 0 message signed by write_sk_0 succeeds
        let mut msg1 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([1u8; 24]),
            ciphertext: hex::encode(b"sealed-ciphertext-1"),
            write_sig: String::new(),
        };
        msg1.write_sig = sign_digest(&write_sk_0, &msg1.signing_digest().unwrap());
        let stored1 = store.put_message(&group_id, msg1).unwrap().message;
        assert_eq!(stored1.server_seq, 1);

        // Outsider signature is rejected with Forbidden
        let (outsider_sk, _) = keypair(99);
        let mut outsider_msg = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([2u8; 24]),
            ciphertext: hex::encode(b"outsider-attempt"),
            write_sig: String::new(),
        };
        outsider_msg.write_sig = sign_digest(&outsider_sk, &outsider_msg.signing_digest().unwrap());
        assert!(matches!(
            store.put_message(&group_id, outsider_msg),
            Err(GroupError::Forbidden(_))
        ));

        // Rotate to epoch 1 (e.g. kicking a member)
        let (write_sk_1, write_pk_1) = keypair(21);
        store
            .put_epoch(
                &group_id,
                signed_epoch(
                    &group_sk,
                    GroupEpochFrame {
                        group_id: group_id.clone(),
                        group_pubkey: hex::encode(group_pk),
                        epoch: 1,
                        prev_epoch_hash: epoch0.epoch_hash,
                        write_pubkey: hex::encode(write_pk_1),
                        read_token_hash: hex::encode(Sha256::digest([0xdd; 32])),
                        encrypted_epoch_descriptor: hex::encode(b"desc1"),
                        admin_sig: "22".repeat(64),
                        epoch_hash: String::new(),
                    },
                ),
            )
            .unwrap();

        // Kicked member trying to post with old epoch 0 key (either claiming epoch 0 or epoch 1) is rejected!
        let mut kicked_epoch0 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 0,
            nonce: hex::encode([3u8; 24]),
            ciphertext: hex::encode(b"kicked-old-epoch"),
            write_sig: String::new(),
        };
        kicked_epoch0.write_sig =
            sign_digest(&write_sk_0, &kicked_epoch0.signing_digest().unwrap());
        assert!(matches!(
            store.put_message(&group_id, kicked_epoch0),
            Err(GroupError::Forbidden(_))
        ));

        let mut kicked_forged_epoch1 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 1,
            nonce: hex::encode([4u8; 24]),
            ciphertext: hex::encode(b"kicked-forged-epoch-1"),
            write_sig: String::new(),
        };
        kicked_forged_epoch1.write_sig =
            sign_digest(&write_sk_0, &kicked_forged_epoch1.signing_digest().unwrap());
        assert!(matches!(
            store.put_message(&group_id, kicked_forged_epoch1),
            Err(GroupError::Forbidden(_))
        ));

        // Active member with epoch 1 key succeeds and gets server_seq = 2
        let mut msg2 = GroupMessageEnvelope {
            group_id: group_id.clone(),
            epoch: 1,
            nonce: hex::encode([5u8; 24]),
            ciphertext: hex::encode(b"sealed-ciphertext-2"),
            write_sig: String::new(),
        };
        msg2.write_sig = sign_digest(&write_sk_1, &msg2.signing_digest().unwrap());
        let stored2 = store.put_message(&group_id, msg2).unwrap().message;
        assert_eq!(stored2.server_seq, 2);

        let all = store.list_messages(&group_id, 0, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].server_seq, 1);
        assert_eq!(all[1].server_seq, 2);
    }
    #[test]
    fn baseline_is_read_only_namespace_scoped_and_initializes_concurrently() {
        let empty = Arc::new(MemoryKvStore::new());
        GroupStore::new(empty.clone())
            .ingest_mirrored_upstream(&"00".repeat(32), None, &[])
            .unwrap();
        assert!(empty.scan_prefix_range(&[], None, 1).unwrap().is_empty());
        let kv = Arc::new(MemoryKvStore::new());
        kv.put(b"unrelated:registry", b"preserved").unwrap();
        let store = GroupStore::new(kv.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        assert!(store
            .get_current_epoch(&initial.group_id)
            .unwrap()
            .is_none());
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        assert_eq!(
            store
                .ingest_mirrored_upstream(&initial.group_id, None, &[])
                .unwrap(),
            0
        );
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        let mut forged = initial.clone();
        forged.admin_sig = "00".repeat(64);
        assert!(store
            .ingest_mirrored_upstream(&initial.group_id, Some(forged.clone()), &[])
            .is_err());
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        assert!(store.put_epoch(&initial.group_id, forged).is_err());
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = [3, 4]
            .into_iter()
            .map(|seed| {
                let replica = GroupStore::new(kv.clone());
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let epoch = root_frame(seed, 0, &"00".repeat(32));
                    barrier.wait();
                    replica.put_epoch(&epoch.group_id.clone(), epoch).unwrap();
                })
            })
            .collect();
        barrier.wait();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(kv.get(GROUP_FORMAT_KEY).unwrap().unwrap(), GROUP_FORMAT);
        assert_eq!(
            kv.get(b"unrelated:registry").unwrap().unwrap(),
            b"preserved"
        );
        let old = Arc::new(MemoryKvStore::new());
        old.put(
            &meta_key(&parse_group_id_hex(&initial.group_id).unwrap()),
            &initial.to_cbor_bytes().unwrap(),
        )
        .unwrap();
        let unsupported = GroupStore::new(old.clone());
        assert!(matches!(
            unsupported.get_current_epoch(&initial.group_id),
            Err(GroupError::Storage(_))
        ));
        assert!(unsupported
            .put_epoch(&initial.group_id, initial.clone())
            .is_err());
        assert!(old.get(GROUP_FORMAT_KEY).unwrap().is_none());
        assert!(old
            .get(&meta_key(&parse_group_id_hex(&initial.group_id).unwrap()))
            .unwrap()
            .is_some());
    }

    #[test]
    fn same_signed_content_race_appends_once_and_signature_encodings_share_receipt() {
        let kv = Arc::new(MemoryKvStore::new());
        let store = GroupStore::new(kv.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let start = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let replica = GroupStore::new(kv.clone());
                let id = id.clone();
                let envelope = envelope.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    replica.put_message(&id, envelope).unwrap()
                })
            })
            .collect();
        start.wait();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.appended).count(), 1);
        assert_eq!(results[0].message, results[1].message);
        let mut variant = envelope.clone();
        let compact = Signature::from_compact(&hex::decode(&variant.write_sig).unwrap()).unwrap();
        variant.write_sig = hex::encode(compact.serialize_der());
        variant.nonce = format!("0x{}", variant.nonce.to_uppercase());
        variant.ciphertext = format!("0x{}", variant.ciphertext.to_uppercase());
        variant.group_id = variant.group_id.to_uppercase();
        let retry = store.put_message(&id, variant).unwrap();
        assert!(!retry.appended);
        assert_eq!(retry.message, results[0].message);
        assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
        let mut invalid = envelope;
        invalid.write_sig = "00".repeat(64);
        assert!(matches!(
            store.put_message(&id, invalid),
            Err(GroupError::Forbidden(_))
        ));
    }

    #[test]
    fn lost_ack_reopen_rotation_and_failed_commit_preserve_exact_acceptance() {
        let directory = tempdir::TempDir::new("group-idempotent-reopen").unwrap();
        let path = directory.path().join("groups.rocksdb");
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let receipt = {
            let kv = Arc::new(RocksDbKvStore::open(&path).unwrap());
            let store = GroupStore::new(kv.clone());
            let initial = store.put_epoch(&id, initial).unwrap();
            let failing = GroupStore::new(Arc::new(FailingCommitKv(kv.clone())));
            assert!(failing.put_message(&id, envelope.clone()).is_err());
            assert!(kv
                .get(&acceptance_key(
                    &parse_group_id_hex(&id).unwrap(),
                    &envelope.signing_digest().unwrap()
                ))
                .unwrap()
                .is_none());
            assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
            let accepted = store.put_message(&id, envelope.clone()).unwrap();
            assert!(accepted.appended);
            let (root, _) = keypair(3);
            let (_, next_public) = keypair(43);
            let mut next = root_frame(3, 1, &initial.epoch_hash);
            next.write_pubkey = hex::encode(next_public);
            store.put_epoch(&id, signed_epoch(&root, next)).unwrap();
            accepted.message
        };
        let store = GroupStore::new(Arc::new(RocksDbKvStore::open(&path).unwrap()));
        let retry = store.put_message(&id, envelope).unwrap();
        assert!(!retry.appended);
        assert_eq!(retry.message, receipt);
        assert!(matches!(
            store.put_message(&id, message_for(&id, 0, 2, &key)),
            Err(GroupError::Forbidden(_))
        ));
        assert_eq!(store.list_messages(&id, 0, 10).unwrap(), vec![receipt]);
    }

    #[test]
    fn same_content_cas_loser_acknowledges_winner_even_when_epoch_rotates() {
        let backend = Arc::new(MemoryKvStore::new());
        let store = GroupStore::new(backend.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let initial = store.put_epoch(&id, initial).unwrap();
        let paused = Arc::new(PausingCommitKv {
            backend,
            ready: std::sync::Barrier::new(2),
            resume: std::sync::Barrier::new(2),
            pause: std::sync::atomic::AtomicBool::new(true),
            pause_at_lookup: false,
        });
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let replica = GroupStore::new(paused.clone());
        let replica_id = id.clone();
        let pending = envelope.clone();
        let thread = std::thread::spawn(move || replica.put_message(&replica_id, pending));
        paused.ready.wait();
        let accepted = store.put_message(&id, envelope).unwrap();
        store
            .put_epoch(&id, root_frame(3, 1, &initial.epoch_hash))
            .unwrap();
        paused.resume.wait();
        let loser = thread.join().unwrap().unwrap();
        assert!(!loser.appended);
        assert_eq!(loser.message, accepted.message);
        assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
    }
    #[test]
    fn corrupt_acceptance_locator_and_original_signature_fail_without_appending() {
        let kv = Arc::new(MemoryKvStore::new());
        let store = GroupStore::new(kv.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let receipt = store.put_message(&id, envelope.clone()).unwrap().message;
        let group_id = parse_group_id_hex(&id).unwrap();
        let index = acceptance_key(&group_id, &envelope.signing_digest().unwrap());
        kv.put(&index, &999u64.to_be_bytes()).unwrap();
        assert!(matches!(
            store.put_message(&id, envelope.clone()),
            Err(GroupError::Storage(_))
        ));
        kv.put(&index, &receipt.server_seq.to_be_bytes()).unwrap();
        let mut corrupt = receipt.clone();
        corrupt.write_sig = "00".repeat(64);
        kv.put(
            &msg_key(&group_id, receipt.server_seq),
            &serde_json::to_vec(&corrupt).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.put_message(&id, envelope),
            Err(GroupError::Storage(_))
        ));
        assert_eq!(
            kv.get(&seq_key(&group_id)).unwrap().unwrap(),
            1u64.to_be_bytes()
        );
    }

    #[test]
    fn lazy_owner_rejects_old_nonempty_group_store_without_initialization_or_deletion() {
        let directory = tempdir::TempDir::new("group-old-readonly").unwrap();
        let registry = directory.path().join("registry");
        let path = registry.with_extension(GROUP_STORE_EXTENSION);
        let initial = root_frame(3, 0, &"00".repeat(32));
        let key = meta_key(&parse_group_id_hex(&initial.group_id).unwrap());
        let raw = initial.to_cbor_bytes().unwrap();
        {
            let kv = RocksDbKvStore::open(&path).unwrap();
            kv.put(&key, &raw).unwrap();
        }
        assert!(Owner::new(registry).get().is_err());
        let kv = RocksDbKvStore::open(&path).unwrap();
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        assert_eq!(kv.get(&key).unwrap().unwrap(), raw);
    }
    #[test]
    fn stale_empty_acceptance_lookup_rechecks_receipt_before_rejecting_rotated_epoch() {
        let backend = Arc::new(MemoryKvStore::new());
        let store = GroupStore::new(backend.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let initial = store.put_epoch(&id, initial).unwrap();
        let paused = Arc::new(PausingCommitKv {
            backend,
            ready: std::sync::Barrier::new(2),
            resume: std::sync::Barrier::new(2),
            pause: std::sync::atomic::AtomicBool::new(true),
            pause_at_lookup: true,
        });
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let replica = GroupStore::new(paused.clone());
        let replica_id = id.clone();
        let pending = envelope.clone();
        let thread = std::thread::spawn(move || replica.put_message(&replica_id, pending));
        // The first receipt lookup has captured None, before reading the current authority.
        paused.ready.wait();
        let accepted = store.put_message(&id, envelope).unwrap();
        let (root, _) = keypair(3);
        let (_, next_write_key) = keypair(43);
        let mut next = root_frame(3, 1, &initial.epoch_hash);
        next.write_pubkey = hex::encode(next_write_key);
        store.put_epoch(&id, signed_epoch(&root, next)).unwrap();
        paused.resume.wait();
        let retry = thread.join().unwrap().unwrap();
        assert!(!retry.appended);
        assert_eq!(retry.message, accepted.message);
        assert_eq!(
            store.list_messages(&id, 0, 10).unwrap(),
            vec![accepted.message]
        );
        // This does not authorize genuinely new content under a retired write key.
        assert!(matches!(
            store.put_message(&id, message_for(&id, 0, 2, &key)),
            Err(GroupError::Forbidden(_))
        ));
    }
}
