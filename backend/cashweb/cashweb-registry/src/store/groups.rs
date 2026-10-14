//! Shared Group Mailbox store (`'G'`, `'G_meta'`) over [`RelayKvStore`] (Issue #70 & #1575).
//!
//! Stores:
//! - `'G_meta' || group_id`: current [`GroupEpochFrame`], updated via atomic Compare-And-Swap (CAS).
//! - `'G_epoch' || group_id || epoch_be`: historical [`GroupEpochFrame`]s by epoch number.
//! - `'G_seq' || group_id`: monotonic `u64` per-group sequence counter.
//! - `'G' || group_id || server_seq_be`: ordered [`StoredGroupMessage`] rows.
//! - `'G_mirror' || group_id`: home-relay subscriber tracking and mirror state for foreign groups.

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
    KvError, MemoryKvStore, RelayKvStore, RocksDbKvStore, SUBSPACE_GROUP_MESSAGES,
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
/// Domain separator for `admin_sig` over an epoch transition frame.
pub const GROUP_EPOCH_ADMIN_SIG_DOMAIN: &[u8] = b"frank-group-epoch-admin-v1";

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

    /// Normalize the frame and populate `epoch_hash`.
    pub fn normalized(mut self) -> Result<Self, GroupError> {
        if self.epoch == 0 && self.prev_epoch_hash.is_empty() {
            self.prev_epoch_hash = "00".repeat(32);
        }
        self.group_id = self.group_id.to_lowercase();
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
        let mut epoch = None;
        let mut prev_epoch_hash = String::new();
        let mut write_pubkey = None;
        let mut read_token_hash = None;
        let mut encrypted_epoch_descriptor = None;
        let mut admin_sig = None;
        let mut epoch_hash = String::new();

        for (k, v) in entries {
            match (k, v) {
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

    /// Fetch the current [`GroupEpochFrame`] for `group_id_hex`, if the group exists locally.
    pub fn get_current_epoch(
        &self,
        group_id_hex: &str,
    ) -> Result<Option<GroupEpochFrame>, GroupError> {
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

        let m_key = meta_key(&group_id);
        let current_raw = self.kv.get(&m_key)?;
        let encoded_new = frame.to_cbor_bytes()?;

        match (frame.epoch, current_raw) {
            (0, None) => {
                if let Err(KvError::CasConflict {
                    current: Some(winner_bytes),
                }) = self.kv.compare_and_swap(&m_key, None, &encoded_new)
                {
                    let current = GroupEpochFrame::from_cbor_bytes(&winner_bytes)?;
                    return Err(GroupError::EpochConflict {
                        current: Box::new(current),
                    });
                }
            }
            (0, Some(existing_bytes)) => {
                let current = GroupEpochFrame::from_cbor_bytes(&existing_bytes)?;
                return Err(GroupError::EpochConflict {
                    current: Box::new(current),
                });
            }
            (_, None) => {
                return Err(GroupError::InvalidInput(
                    "initial group epoch must be 0".into(),
                ));
            }
            (e, Some(existing_bytes)) => {
                let current = GroupEpochFrame::from_cbor_bytes(&existing_bytes)?;
                if current.epoch + 1 != e || frame.prev_epoch_hash != current.epoch_hash {
                    return Err(GroupError::EpochConflict {
                        current: Box::new(current),
                    });
                }
                if let Err(KvError::CasConflict {
                    current: winner_opt,
                }) = self
                    .kv
                    .compare_and_swap(&m_key, Some(&existing_bytes), &encoded_new)
                {
                    let winner = match winner_opt {
                        Some(bytes) => GroupEpochFrame::from_cbor_bytes(&bytes)?,
                        None => current,
                    };
                    return Err(GroupError::EpochConflict {
                        current: Box::new(winner),
                    });
                }
            }
        }

        self.kv
            .put(&epoch_history_key(&group_id, frame.epoch), &encoded_new)?;
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
        let token_bytes = parse_fixed_hex::<32>(read_token_hex, "X-Group-Read-Token")
            .map_err(|_| GroupError::Forbidden("malformed X-Group-Read-Token".into()))?;
        let token_hash_hex = hex::encode(Sha256::digest(token_bytes));
        if token_hash_hex == current.read_token_hash {
            return Ok(current);
        }
        Err(GroupError::Forbidden(
            "invalid or stale X-Group-Read-Token".into(),
        ))
    }

    /// Authenticate an inbound [`GroupMessageEnvelope`] against the group's current epoch
    /// write public key $W_{G,e}$ and append it with a strictly monotonic `server_seq` and
    /// 80-bit [`Versionstamp`].
    pub fn put_message(
        &self,
        path_group_id: &str,
        envelope: GroupMessageEnvelope,
    ) -> Result<StoredGroupMessage, GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        if envelope.group_id.to_lowercase() != path_group_id {
            return Err(GroupError::InvalidInput(
                "envelope.group_id does not match URL path :group_id".into(),
            ));
        }

        let current_epoch = self
            .get_current_epoch(path_group_id)?
            .ok_or_else(|| GroupError::NotFound(path_group_id.to_string()))?;

        // Reject messages targeting a stale or future epoch (e.g. kicked member from prior epoch)
        if envelope.epoch != current_epoch.epoch {
            return Err(GroupError::Forbidden(format!(
                "message epoch {} does not match active group epoch {}",
                envelope.epoch, current_epoch.epoch
            )));
        }

        let write_pubkey = parse_fixed_hex::<33>(&current_epoch.write_pubkey, "write_pubkey")?;
        let sig_bytes = parse_var_hex(&envelope.write_sig, "write_sig", 73)
            .map_err(|_| GroupError::Forbidden("malformed write_sig".into()))?;
        let digest = envelope.signing_digest()?;

        if !verify_secp256k1_sig(&write_pubkey, &digest, &sig_bytes) {
            return Err(GroupError::Forbidden(
                "invalid write_sig for active group epoch write_pubkey".into(),
            ));
        }

        let server_seq = self.allocate_next_seq(&group_id)?;
        let (_, vs) = self
            .kv
            .put_versionstamped(b"G_vs:", &group_id, &server_seq.to_be_bytes())?;
        let server_time_ms = vs.commit_version().max(now_ms());

        let stored = StoredGroupMessage {
            group_id: path_group_id.to_string(),
            server_seq,
            server_time_ms,
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

        let serialized = serde_json::to_vec(&stored)
            .map_err(|e| GroupError::Storage(format!("serialize group message: {e}")))?;
        self.kv.put(&msg_key(&group_id, server_seq), &serialized)?;

        Ok(stored)
    }

    fn allocate_next_seq(&self, group_id: &[u8; 32]) -> Result<u64, GroupError> {
        let s_key = seq_key(group_id);
        loop {
            let current_raw = self.kv.get(&s_key)?;
            let next_seq = match &current_raw {
                Some(bytes) => {
                    let arr: [u8; 8] = bytes
                        .as_slice()
                        .try_into()
                        .map_err(|_| GroupError::Storage("corrupt G_seq value".into()))?;
                    u64::from_be_bytes(arr).saturating_add(1)
                }
                None => 1,
            };
            match self
                .kv
                .compare_and_swap(&s_key, current_raw.as_deref(), &next_seq.to_be_bytes())
            {
                Ok(()) => return Ok(next_seq),
                Err(KvError::CasConflict { .. }) => continue,
                Err(e) => return Err(GroupError::from(e)),
            }
        }
    }

    /// Scan ordered messages for `group_id_hex` strictly after `after_seq`, up to `limit`.
    pub fn list_messages(
        &self,
        group_id_hex: &str,
        after_seq: u64,
        limit: u16,
    ) -> Result<Vec<StoredGroupMessage>, GroupError> {
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

    /// Record a local subscriber's interest in a foreign group hosted on `upstream_relay`,
    /// returning the updated [`GroupMirrorState`] (and automatically promoting `mirrored = true`
    /// once `subscribers.len() >= self.mirror_threshold`).
    pub fn record_foreign_subscriber(
        &self,
        group_id_hex: &str,
        upstream_relay: &str,
        subscriber_tag: &str,
    ) -> Result<GroupMirrorState, GroupError> {
        let group_id = parse_group_id_hex(group_id_hex)?;
        let m_key = mirror_key(&group_id);
        loop {
            let current_raw = self.kv.get(&m_key)?;
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
            if !subscriber_tag.trim().is_empty() {
                state.subscribers.insert(subscriber_tag.trim().to_string());
            }
            if state.subscribers.len() >= self.mirror_threshold {
                state.mirrored = true;
            }
            let encoded =
                serde_json::to_vec(&state).map_err(|e| GroupError::Storage(e.to_string()))?;
            match self
                .kv
                .compare_and_swap(&m_key, current_raw.as_deref(), &encoded)
            {
                Ok(()) => return Ok(state),
                Err(KvError::CasConflict { .. }) => continue,
                Err(e) => return Err(GroupError::from(e)),
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
        if let Some(frame) = epoch_frame {
            let normalized = frame.normalized()?;
            let encoded = normalized.to_cbor_bytes()?;
            self.kv.put(&meta_key(&group_id), &encoded)?;
            self.kv
                .put(&epoch_history_key(&group_id, normalized.epoch), &encoded)?;
        }

        let mut max_seq = 0u64;
        for msg in messages {
            if msg.group_id != group_id_hex {
                continue;
            }
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
            return Ok(store);
        }
        let kv = RocksDbKvStore::open(&self.path)?;
        let _ = self.store.set(GroupStore::with_mirror_threshold(
            Arc::new(kv),
            self.mirror_threshold,
        ));
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

    #[test]
    fn epoch_cas_enforces_monotonicity_and_rejects_concurrent_collision_with_current_frame() {
        let store = GroupStore::new_in_memory();
        let (_, group_pk) = keypair(1);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (_, write_pk_0) = keypair(10);
        let read_token_0 = [0xaa; 32];
        let read_token_hash_0 = hex::encode(Sha256::digest(read_token_0));

        let epoch0 = GroupEpochFrame {
            group_id: group_id.clone(),
            epoch: 0,
            prev_epoch_hash: "00".repeat(32),
            write_pubkey: hex::encode(write_pk_0),
            read_token_hash: read_token_hash_0,
            encrypted_epoch_descriptor: hex::encode(b"epoch-0-descriptor"),
            admin_sig: "11".repeat(64),
            epoch_hash: String::new(),
        };

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
        let epoch1 = GroupEpochFrame {
            group_id: group_id.clone(),
            epoch: 1,
            prev_epoch_hash: committed_0.epoch_hash.clone(),
            write_pubkey: hex::encode(write_pk_1),
            read_token_hash: hex::encode(Sha256::digest([0xbb; 32])),
            encrypted_epoch_descriptor: hex::encode(b"epoch-1-descriptor"),
            admin_sig: "22".repeat(64),
            epoch_hash: String::new(),
        };
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
        let (_, group_pk) = keypair(2);
        let group_id = hex::encode(derive_group_id(&group_pk));

        let (write_sk_0, write_pk_0) = keypair(20);
        let read_token_0 = [0xcc; 32];
        let epoch0 = store
            .put_epoch(
                &group_id,
                GroupEpochFrame {
                    group_id: group_id.clone(),
                    epoch: 0,
                    prev_epoch_hash: "00".repeat(32),
                    write_pubkey: hex::encode(write_pk_0),
                    read_token_hash: hex::encode(Sha256::digest(read_token_0)),
                    encrypted_epoch_descriptor: hex::encode(b"desc0"),
                    admin_sig: "11".repeat(64),
                    epoch_hash: String::new(),
                },
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
        let stored1 = store.put_message(&group_id, msg1).unwrap();
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
                GroupEpochFrame {
                    group_id: group_id.clone(),
                    epoch: 1,
                    prev_epoch_hash: epoch0.epoch_hash,
                    write_pubkey: hex::encode(write_pk_1),
                    read_token_hash: hex::encode(Sha256::digest([0xdd; 32])),
                    encrypted_epoch_descriptor: hex::encode(b"desc1"),
                    admin_sig: "22".repeat(64),
                    epoch_hash: String::new(),
                },
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
        let stored2 = store.put_message(&group_id, msg2).unwrap();
        assert_eq!(stored2.server_seq, 2);

        let all = store.list_messages(&group_id, 0, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].server_seq, 1);
        assert_eq!(all[1].server_seq, 2);
    }
}
