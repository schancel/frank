//! Shared Group Mailbox store (`'G'`, `'G_meta'`) over the [`RelayKvStore`] transaction
//! contract (Issue #70 & #1575).
//!
//! Stores:
//! - `'G_meta' || group_id`: current [`GroupEpochFrame`], replaced in one transaction.
//! - `'G_epoch' || group_id || epoch_be`: historical [`GroupEpochFrame`]s by epoch number.
//! - `'G_seq' || group_id`: monotonic `u64` per-group sequence counter.
//! - `'G' || group_id || server_seq_be`: ordered message rows (binary CBOR). A ciphertext up to
//!   [`INLINE_LIMIT`] (64 KiB) is inline; a larger one is a [`LargeValueRef`] to its own
//!   upload in the object store (`groups/sha256/<hex>/<upload>`, content-verified on read),
//!   committed with the row.
//! - `'G_lv:'`: this owner's [`LargeValues`] index (upload intents, references, sweep lease).
//! - `'G_mirror' || group_id`: home-relay subscriber tracking and mirror state for foreign groups.
//! - `'G_accept' || group_id || signed_content_digest`: derived original-receipt locator, atomically
//!   committed with message/sequence/epoch/ownership guards.
//! - `'G_pay:' || tx_hash`: the [`GroupPaymentRecord`] of the payment that funded one accepted
//!   write, committed in that write's acceptance transaction. One payment funds one write.
//! - `'G_part:' || key || part_be32`: interim, for epoch frames and mirror state only (an epoch
//!   descriptor may be 256 KiB; the subscriber set is unbounded). A value longer than the store's
//!   value limit (or starting with `0x00`) is stored at `key` as `0x00 || part_count_be32` and
//!   split across these parts in the same transaction. Message rows never use it.
//! - `'G_format'`: explicit development baseline; old owned records fail without migration.

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use frank_cbor::message_fields::{group_epoch_frame, group_message_envelope};
use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
use secp256k1_abc::{Message as SecpMessage, PublicKey, Secp256k1, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::store::kv_store::{
    KvError, KvTransaction, RelayKvStore, RocksDbKvStore, Transact, MAX_VALUE_BYTES,
};
use crate::store::large_values::{
    LargeValueError, LargeValueRef, LargeValues, LocalFsObjectStore, ObjectStore, Staged,
    SweepReport, INLINE_LIMIT,
};

const SUBSPACE_GROUP_MESSAGES: &[u8] = b"G";
const SUBSPACE_GROUP_META: &[u8] = b"G_meta";

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
        use group_epoch_frame as F;
        let val = cbor_map(vec![
            (F::GROUP_ID, CborValue::Text(self.group_id.clone())),
            (F::EPOCH, CborValue::Int(self.epoch as i128)),
            (
                F::PREV_EPOCH_HASH,
                CborValue::Text(self.prev_epoch_hash.clone()),
            ),
            (F::WRITE_PUBKEY, CborValue::Text(self.write_pubkey.clone())),
            (
                F::READ_TOKEN_HASH,
                CborValue::Text(self.read_token_hash.clone()),
            ),
            (
                F::ENCRYPTED_EPOCH_DESCRIPTOR,
                CborValue::Text(self.encrypted_epoch_descriptor.clone()),
            ),
            (F::ADMIN_SIG, CborValue::Text(self.admin_sig.clone())),
            (F::EPOCH_HASH, CborValue::Text(self.epoch_hash.clone())),
            (F::GROUP_PUBKEY, CborValue::Text(self.group_pubkey.clone())),
        ]);
        encode_canonical(&val).map_err(|e| GroupError::Storage(e.to_string()))
    }

    /// Decode from canonical CBOR bytes.
    pub fn from_cbor_bytes(bytes: &[u8]) -> Result<Self, GroupError> {
        use group_epoch_frame as F;
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
                (F::GROUP_PUBKEY, CborValue::Text(s)) => group_pubkey = Some(s),
                (F::GROUP_PUBKEY, CborValue::Bytes(b)) => group_pubkey = Some(hex::encode(b)),
                (F::GROUP_ID, CborValue::Text(s)) => group_id = Some(s),
                (F::GROUP_ID, CborValue::Bytes(b)) => group_id = Some(hex::encode(b)),
                (F::EPOCH, CborValue::Int(n)) if n >= 0 => epoch = u64::try_from(n).ok(),
                (F::PREV_EPOCH_HASH, CborValue::Text(s)) => prev_epoch_hash = s,
                (F::PREV_EPOCH_HASH, CborValue::Bytes(b)) => prev_epoch_hash = hex::encode(b),
                (F::WRITE_PUBKEY, CborValue::Text(s)) => write_pubkey = Some(s),
                (F::WRITE_PUBKEY, CborValue::Bytes(b)) => write_pubkey = Some(hex::encode(b)),
                (F::READ_TOKEN_HASH, CborValue::Text(s)) => read_token_hash = Some(s),
                (F::READ_TOKEN_HASH, CborValue::Bytes(b)) => read_token_hash = Some(hex::encode(b)),
                (F::ENCRYPTED_EPOCH_DESCRIPTOR, CborValue::Text(s)) => {
                    encrypted_epoch_descriptor = Some(s)
                }
                (F::ENCRYPTED_EPOCH_DESCRIPTOR, CborValue::Bytes(b)) => {
                    encrypted_epoch_descriptor = Some(hex::encode(b))
                }
                (F::ADMIN_SIG, CborValue::Text(s)) => admin_sig = Some(s),
                (F::ADMIN_SIG, CborValue::Bytes(b)) => admin_sig = Some(hex::encode(b)),
                (F::EPOCH_HASH, CborValue::Text(s)) => epoch_hash = s,
                (F::EPOCH_HASH, CborValue::Bytes(b)) => epoch_hash = hex::encode(b),
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
        use group_message_envelope as F;
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
                (F::GROUP_ID, CborValue::Text(s)) => group_id = Some(s),
                (F::GROUP_ID, CborValue::Bytes(b)) => group_id = Some(hex::encode(b)),
                (F::EPOCH, CborValue::Int(n)) if n >= 0 => epoch = u64::try_from(n).ok(),
                (F::NONCE, CborValue::Text(s)) => nonce = Some(s),
                (F::NONCE, CborValue::Bytes(b)) => nonce = Some(hex::encode(b)),
                (F::CIPHERTEXT, CborValue::Text(s)) => ciphertext = Some(s),
                (F::CIPHERTEXT, CborValue::Bytes(b)) => ciphertext = Some(hex::encode(b)),
                (F::WRITE_SIG, CborValue::Text(s)) => write_sig = Some(s),
                (F::WRITE_SIG, CborValue::Bytes(b)) => write_sig = Some(hex::encode(b)),
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

/// Stored group message with relay-assigned `server_seq` and `server_time_ms`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredGroupMessage {
    /// 64-character lowercase hex `group_id`.
    pub group_id: String,
    /// Strictly monotonic per-group sequence number (`1, 2, 3, ...`).
    pub server_seq: u64,
    /// Relay delivery timestamp in milliseconds.
    pub server_time_ms: u64,
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
    /// The payment already funded another accepted write.
    #[error("group write payment already funded another write")]
    PaymentAlreadyUsed,
    /// Underlying KV store failure.
    #[error("group storage error: {0}")]
    Storage(String),
    /// The upstream relay could not be reached or answered unreadably (`502`).
    #[error("upstream relay error: {0}")]
    Upstream(String),
    /// The upstream relay did not answer in time (`504`).
    #[error("upstream relay timeout: {0}")]
    UpstreamTimeout(String),
    /// The large-value (object) store failed or refused. The detail can name the endpoint,
    /// bucket and object key, so the HTTP layer logs it and answers generically.
    #[error("group large-value store: {0}")]
    LargeValue(LargeValueError),
    /// The store could not say whether the write committed. It may have: the caller retries
    /// the same request. A repeated append is answered `existing`; a repeated epoch frame that
    /// did commit gets 409, and the client re-reads the latest epoch to confirm it.
    #[error("group_commit_unknown: {0}")]
    CommitUnknown(String),
    /// The transaction ran out of time before committing; nothing was written. Retryable.
    #[error("group_storage_timeout")]
    StorageTimedOut,
}

impl From<KvError> for GroupError {
    fn from(err: KvError) -> Self {
        match err {
            KvError::CommitUnknownResult(detail) => GroupError::CommitUnknown(detail),
            KvError::TransactionTimedOut => GroupError::StorageTimedOut,
            other => GroupError::Storage(other.to_string()),
        }
    }
}

impl From<LargeValueError> for GroupError {
    fn from(err: LargeValueError) -> Self {
        match err {
            LargeValueError::Kv(kv) => GroupError::Storage(kv.to_string()),
            other => GroupError::LargeValue(other),
        }
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

/// The payment that funds one new write, as the hosting relay verified it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupWritePaymentFact {
    /// Canonical chain identifier the payment is on.
    pub network: String,
    /// Keccak256 of the signed transaction: the payment's dedup key.
    pub tx_hash: [u8; 32],
    /// The paying account.
    pub payer: [u8; 20],
    /// The address paid.
    pub payee: [u8; 20],
    /// Value paid, in wei.
    pub value_wei: u128,
}

/// `'G_pay:' || tx_hash`: which accepted write a payment funded, written in that write's
/// acceptance transaction. It is also the operator's record of what each write paid whom.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupPaymentRecord {
    /// Canonical chain identifier the payment is on.
    pub network: String,
    /// Hex transaction hash.
    pub tx_hash: String,
    /// `0x`-prefixed paying account.
    pub payer: String,
    /// `0x`-prefixed address paid.
    pub payee: String,
    /// Value paid, decimal wei.
    pub value_wei: String,
    /// The group of the write it funded.
    pub group_id: String,
    /// The sequence of the write it funded.
    pub server_seq: u64,
}

fn payment_key(tx_hash: &[u8; 32]) -> Vec<u8> {
    [GROUP_PAYMENT_PREFIX, tx_hash.as_slice()].concat()
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
const GROUP_FORMAT: &[u8] = b"group-binary-rows-v1";
const GROUP_PART_PREFIX: &[u8] = b"G_part:";
const GROUP_PAYMENT_PREFIX: &[u8] = b"G_pay:";
const GROUP_LARGE_VALUE_PREFIX: &[u8] = b"G_lv:";
/// Object namespace of group ciphertexts in the shared bucket.
pub const GROUP_OBJECT_NAMESPACE: &str = "groups";
const GROUP_OWNED_PREFIXES: &[&[u8]] = &[
    b"G:",
    b"G_meta:",
    b"G_epoch:",
    b"G_seq:",
    b"G_mirror:",
    b"G_vs:",
    b"G_accept:",
    GROUP_PAYMENT_PREFIX,
    GROUP_PART_PREFIX,
    GROUP_LARGE_VALUE_PREFIX,
];

/// A stored message's ciphertext: inline, or a reference to the object store.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StoredCiphertext {
    Inline(Vec<u8>),
    Large(LargeValueRef),
}

impl StoredCiphertext {
    fn matches(&self, ciphertext: &[u8]) -> bool {
        match self {
            Self::Inline(bytes) => bytes == ciphertext,
            Self::Large(reference) => reference.matches(ciphertext),
        }
    }
}

/// One persisted message row. `group_id` is in the key.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MessageRow {
    server_seq: u64,
    server_time_ms: u64,
    epoch: u64,
    nonce: Vec<u8>,
    write_sig: Vec<u8>,
    ciphertext: StoredCiphertext,
}

const ROW_SERVER_SEQ: u64 = 1;
const ROW_SERVER_TIME_MS: u64 = 2;
const ROW_EPOCH: u64 = 3;
const ROW_NONCE: u64 = 4;
const ROW_WRITE_SIG: u64 = 5;
const ROW_CIPHERTEXT: u64 = 6;
const ROW_CIPHERTEXT_SHA256: u64 = 7;
const ROW_CIPHERTEXT_LEN: u64 = 8;
const ROW_CIPHERTEXT_UPLOAD: u64 = 9;

impl MessageRow {
    fn from_message(
        message: &StoredGroupMessage,
        ciphertext: StoredCiphertext,
    ) -> Result<Self, GroupError> {
        Ok(Self {
            server_seq: message.server_seq,
            server_time_ms: message.server_time_ms,
            epoch: message.epoch,
            nonce: parse_var_hex(&message.nonce, "nonce", 64)?,
            write_sig: parse_var_hex(&message.write_sig, "write_sig", 73)?,
            ciphertext,
        })
    }

    fn encode(&self) -> Result<Vec<u8>, GroupError> {
        let mut fields = vec![
            (ROW_SERVER_SEQ, CborValue::Int(self.server_seq.into())),
            (
                ROW_SERVER_TIME_MS,
                CborValue::Int(self.server_time_ms.into()),
            ),
            (ROW_EPOCH, CborValue::Int(self.epoch.into())),
            (ROW_NONCE, CborValue::Bytes(self.nonce.clone())),
            (ROW_WRITE_SIG, CborValue::Bytes(self.write_sig.clone())),
        ];
        match &self.ciphertext {
            StoredCiphertext::Inline(bytes) => {
                fields.push((ROW_CIPHERTEXT, CborValue::Bytes(bytes.clone())));
            }
            StoredCiphertext::Large(reference) => {
                fields.push((
                    ROW_CIPHERTEXT_SHA256,
                    CborValue::Bytes(reference.digest.to_vec()),
                ));
                fields.push((ROW_CIPHERTEXT_LEN, CborValue::Int(reference.len.into())));
                fields.push((
                    ROW_CIPHERTEXT_UPLOAD,
                    CborValue::Bytes(reference.upload.to_vec()),
                ));
            }
        }
        encode_canonical(&cbor_map(fields)).map_err(|e| GroupError::Storage(e.to_string()))
    }

    fn decode(bytes: &[u8]) -> Result<Self, GroupError> {
        let corrupt =
            |what: &str| GroupError::Storage(format!("corrupt group message row: {what}"));
        let CborValue::Map(entries) =
            decode_canonical(bytes).map_err(|e| corrupt(&e.to_string()))?
        else {
            return Err(corrupt("not a map"));
        };
        let (mut seq, mut time, mut epoch, mut nonce, mut sig) = (None, None, None, None, None);
        let (mut inline, mut digest, mut len, mut upload) = (None, None, None, None);
        let int = |value: CborValue| match value {
            CborValue::Int(n) => u64::try_from(n).map_err(|_| corrupt("integer out of range")),
            _ => Err(corrupt("expected an integer")),
        };
        for (key, value) in entries {
            match (key, value) {
                (ROW_SERVER_SEQ, v) => seq = Some(int(v)?),
                (ROW_SERVER_TIME_MS, v) => time = Some(int(v)?),
                (ROW_EPOCH, v) => epoch = Some(int(v)?),
                (ROW_NONCE, CborValue::Bytes(b)) => nonce = Some(b),
                (ROW_WRITE_SIG, CborValue::Bytes(b)) => sig = Some(b),
                (ROW_CIPHERTEXT, CborValue::Bytes(b)) => inline = Some(b),
                (ROW_CIPHERTEXT_SHA256, CborValue::Bytes(b)) => {
                    digest = Some(<[u8; 32]>::try_from(b).map_err(|_| corrupt("digest length"))?)
                }
                (ROW_CIPHERTEXT_LEN, v) => len = Some(int(v)?),
                (ROW_CIPHERTEXT_UPLOAD, CborValue::Bytes(b)) => {
                    upload = Some(<[u8; 16]>::try_from(b).map_err(|_| corrupt("upload id length"))?)
                }
                _ => return Err(corrupt("unexpected field")),
            }
        }
        let ciphertext = match (inline, digest, len, upload) {
            (Some(bytes), None, None, None) => StoredCiphertext::Inline(bytes),
            (None, Some(digest), Some(len), Some(upload)) => {
                StoredCiphertext::Large(LargeValueRef {
                    digest,
                    len,
                    upload,
                })
            }
            _ => return Err(corrupt("ciphertext")),
        };
        Ok(Self {
            server_seq: seq.ok_or_else(|| corrupt("server_seq"))?,
            server_time_ms: time.ok_or_else(|| corrupt("server_time_ms"))?,
            epoch: epoch.ok_or_else(|| corrupt("epoch"))?,
            nonce: nonce.ok_or_else(|| corrupt("nonce"))?,
            write_sig: sig.ok_or_else(|| corrupt("write_sig"))?,
            ciphertext,
        })
    }

    fn into_message(self, group_id_hex: &str, ciphertext: &[u8]) -> StoredGroupMessage {
        StoredGroupMessage {
            group_id: group_id_hex.to_string(),
            server_seq: self.server_seq,
            server_time_ms: self.server_time_ms,
            epoch: self.epoch,
            nonce: hex::encode(&self.nonce),
            ciphertext: hex::encode(ciphertext),
            write_sig: hex::encode(&self.write_sig),
        }
    }
}

fn acceptance_key(group_id: &[u8; 32], digest: &[u8; 32]) -> Vec<u8> {
    [b"G_accept:".as_slice(), group_id, digest].concat()
}

fn part_prefix(key: &[u8]) -> Vec<u8> {
    [GROUP_PART_PREFIX, key].concat()
}

/// The part count when `stored` is a split-value header.
fn split_header(stored: &[u8]) -> Result<Option<u32>, GroupError> {
    match stored.first() {
        Some(0) => {
            let count: [u8; 4] = stored[1..]
                .try_into()
                .map_err(|_| GroupError::Storage("corrupt split group value header".into()))?;
            Ok(Some(u32::from_be_bytes(count)))
        }
        _ => Ok(None),
    }
}

/// Read a value written by [`put_value`], reassembling its parts.
fn get_value(tx: &mut dyn KvTransaction, key: &[u8]) -> Result<Option<Vec<u8>>, GroupError> {
    let Some(stored) = tx.get(key)? else {
        return Ok(None);
    };
    let Some(count) = split_header(&stored)? else {
        return Ok(Some(stored));
    };
    let prefix = part_prefix(key);
    let parts = tx.scan_prefix(&prefix, None, count as usize + 1)?;
    if parts.len() != count as usize
        || parts
            .iter()
            .enumerate()
            .any(|(index, (k, _))| k[prefix.len()..] != (index as u32).to_be_bytes())
    {
        return Err(GroupError::Storage("incomplete split group value".into()));
    }
    Ok(Some(parts.into_iter().flat_map(|(_, part)| part).collect()))
}

/// Write `value` at `key`, splitting it into parts when it exceeds the value limit, and
/// remove the parts of any value it replaces.
fn put_value(tx: &mut dyn KvTransaction, key: &[u8], value: &[u8]) -> Result<(), GroupError> {
    let prefix = part_prefix(key);
    if let Some(previous) = tx.get(key)? {
        if let Some(count) = split_header(&previous)? {
            for index in 0..count {
                tx.clear(&[prefix.as_slice(), &index.to_be_bytes()].concat())?;
            }
        }
    }
    if value.len() <= MAX_VALUE_BYTES && value.first() != Some(&0) {
        tx.set(key, value)?;
        return Ok(());
    }
    let parts: Vec<&[u8]> = value.chunks(MAX_VALUE_BYTES).collect();
    let count = u32::try_from(parts.len())
        .map_err(|_| GroupError::InvalidInput("group value too large".into()))?;
    tx.set(key, &[[0u8].as_slice(), &count.to_be_bytes()].concat())?;
    for (index, part) in (0u32..).zip(parts) {
        tx.set(&[prefix.as_slice(), &index.to_be_bytes()].concat(), part)?;
    }
    Ok(())
}

/// Inspect only this owner's namespace. Reading never initializes or resets it.
fn check_baseline(tx: &mut dyn KvTransaction) -> Result<(), GroupError> {
    match tx.get(GROUP_FORMAT_KEY)? {
        Some(version) if version == GROUP_FORMAT => Ok(()),
        Some(_) => Err(GroupError::Storage("unsupported group store format; preserve/export group receipts and explicitly reset only disposable dedicated group relay state: the group store and the groups/ prefix of the large-value object store, whose namespace claim names it".into())),
        None => {
            for prefix in GROUP_OWNED_PREFIXES {
                if !tx.scan_prefix(prefix, None, 1)?.is_empty() {
                    return Err(GroupError::Storage("group store lacks append-idempotency format marker; old nonempty group state is unsupported; no automatic migration or deletion".into()));
                }
            }
            Ok(())
        }
    }
}

fn get_mirror_state(
    tx: &mut dyn KvTransaction,
    group_id: &[u8; 32],
) -> Result<Option<GroupMirrorState>, GroupError> {
    let Some(raw) = get_value(tx, &mirror_key(group_id))? else {
        return Ok(None);
    };
    let state = serde_json::from_slice(&raw).map_err(|e| GroupError::Storage(e.to_string()))?;
    Ok(Some(state))
}

fn parse_sequence(bytes: &[u8], what: &str) -> Result<u64, GroupError> {
    Ok(u64::from_be_bytes(bytes.try_into().map_err(|_| {
        GroupError::Storage(format!("corrupt {what}"))
    })?))
}

/// Shared Group Mailbox state machine backed by any [`RelayKvStore`].
#[derive(Debug, Clone)]
pub struct GroupStore {
    kv: Arc<dyn RelayKvStore>,
    large_values: LargeValues,
    mirror_threshold: usize,
}

/// Write a message row at `key`, committing `staged`'s reference with it and dropping the
/// reference of any row it replaces.
fn write_message_row(
    tx: &mut dyn KvTransaction,
    large_values: &LargeValues,
    key: &[u8],
    row: &MessageRow,
    staged: Option<&Staged>,
) -> Result<(), GroupError> {
    if let Some(previous) = tx.get(key)? {
        if let StoredCiphertext::Large(reference) = MessageRow::decode(&previous)?.ciphertext {
            large_values.clear_reference(tx, &reference, key)?;
        }
    }
    if let Some(staged) = staged {
        large_values.commit_reference(tx, staged, key)?;
    }
    tx.set(key, &row.encode()?)?;
    Ok(())
}

impl GroupStore {
    /// Construct a `GroupStore` over the given [`RelayKvStore`] with default mirror threshold
    /// (`2`). Ciphertexts over [`INLINE_LIMIT`] are stored in `objects`.
    pub fn new(kv: Arc<dyn RelayKvStore>, objects: Arc<dyn ObjectStore>) -> Self {
        Self::with_mirror_threshold(kv, objects, DEFAULT_GROUP_MIRROR_THRESHOLD)
    }

    /// Construct a `GroupStore` with a custom subscriber threshold `n` for auto-mirroring.
    pub fn with_mirror_threshold(
        kv: Arc<dyn RelayKvStore>,
        objects: Arc<dyn ObjectStore>,
        mirror_threshold: usize,
    ) -> Self {
        let large_values = LargeValues::new(
            kv.clone(),
            objects,
            GROUP_LARGE_VALUE_PREFIX,
            GROUP_OBJECT_NAMESPACE,
        );
        Self {
            kv,
            large_values,
            mirror_threshold: mirror_threshold.max(1),
        }
    }

    /// Replace how long an unreferenced upload is protected from the sweep.
    pub fn with_large_value_intent_ttl(mut self, ttl: std::time::Duration) -> Self {
        self.large_values = self.large_values.with_intent_ttl(ttl);
        self
    }

    /// Replace the large-value sweep lease length. Zero lets every replica sweep at once.
    pub fn with_large_value_lease_ttl(mut self, ttl: std::time::Duration) -> Self {
        self.large_values = self.large_values.with_lease_ttl(ttl);
        self
    }

    /// This store's large-value index.
    pub fn large_values(&self) -> &LargeValues {
        &self.large_values
    }

    /// Delete unreferenced group ciphertext objects, as lease holder `holder`. A store without
    /// its format marker has no group state and is left untouched.
    pub fn sweep_large_values(&self, holder: [u8; 16]) -> Result<SweepReport, GroupError> {
        let initialized = self.kv.transact(|tx| {
            check_baseline(tx)?;
            Ok::<_, GroupError>(tx.get(GROUP_FORMAT_KEY)?.is_some())
        })?;
        if !initialized {
            return Ok(SweepReport::default());
        }
        Ok(self.large_values.sweep(holder)?)
    }

    /// Stage `ciphertext` in the object store when it is too large to inline.
    fn stage_ciphertext(&self, ciphertext: &[u8]) -> Result<Option<Staged>, GroupError> {
        if ciphertext.len() <= INLINE_LIMIT {
            return Ok(None);
        }
        Ok(Some(self.large_values.stage(ciphertext)?))
    }

    fn stored_ciphertext(ciphertext: &[u8], staged: Option<&Staged>) -> StoredCiphertext {
        match staged {
            Some(staged) => StoredCiphertext::Large(staged.reference),
            None => StoredCiphertext::Inline(ciphertext.to_vec()),
        }
    }

    /// Materialize a row, fetching a large ciphertext from the object store.
    fn row_message(
        &self,
        group_id_hex: &str,
        row: MessageRow,
    ) -> Result<StoredGroupMessage, GroupError> {
        let ciphertext = match &row.ciphertext {
            StoredCiphertext::Inline(bytes) => bytes.clone(),
            StoredCiphertext::Large(reference) => self.large_values.read(reference)?,
        };
        Ok(row.into_message(group_id_hex, &ciphertext))
    }

    /// A `GroupStore` over a RocksDB database in a temporary directory, removed when the last
    /// clone is dropped. For tests and local fixtures.
    ///
    /// # Panics
    /// If the temporary database cannot be created.
    pub fn new_temporary() -> Self {
        let kv = RocksDbKvStore::open_temporary().expect("open temporary group store");
        Self::new(Arc::new(kv), Arc::new(LocalFsObjectStore::temporary()))
    }

    /// Configured subscriber count threshold `n` for promoting a foreign group from proxy to mirror.
    pub fn mirror_threshold(&self) -> usize {
        self.mirror_threshold
    }

    /// Run one read-only transaction after checking the store's baseline.
    fn read<T>(
        &self,
        mut body: impl FnMut(&mut dyn KvTransaction) -> Result<T, GroupError>,
    ) -> Result<T, GroupError> {
        self.kv.transact(|tx| {
            check_baseline(tx)?;
            body(tx)
        })
    }

    fn check_baseline(&self) -> Result<(), GroupError> {
        self.read(|_| Ok(()))
    }

    /// Called only after an authorized mutation; marker-only interruption is a valid empty store.
    fn initialize_baseline(&self) -> Result<(), GroupError> {
        self.kv.transact(|tx| {
            check_baseline(tx)?;
            if tx.get(GROUP_FORMAT_KEY)?.is_none() {
                tx.set(GROUP_FORMAT_KEY, GROUP_FORMAT)?;
            }
            Ok(())
        })
    }

    /// Fetch the current [`GroupEpochFrame`] for `group_id_hex`, if the group exists locally.
    pub fn get_current_epoch(
        &self,
        group_id_hex: &str,
    ) -> Result<Option<GroupEpochFrame>, GroupError> {
        let group_id = parse_group_id_hex(group_id_hex)?;
        self.read(|tx| get_value(tx, &meta_key(&group_id)))?
            .map(|raw| GroupEpochFrame::from_cbor_bytes(&raw))
            .transpose()
    }

    /// Fetch a specific historical [`GroupEpochFrame`] by epoch number.
    pub fn get_epoch(
        &self,
        group_id_hex: &str,
        epoch: u64,
    ) -> Result<Option<GroupEpochFrame>, GroupError> {
        let group_id = parse_group_id_hex(group_id_hex)?;
        self.read(|tx| get_value(tx, &epoch_history_key(&group_id, epoch)))?
            .map(|raw| GroupEpochFrame::from_cbor_bytes(&raw))
            .transpose()
    }

    /// Atomically advance or initialize the group's epoch.
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
        let encoded_new = frame.to_cbor_bytes()?;
        let m_key = meta_key(&group_id);
        self.kv.transact(|tx| {
            if get_mirror_state(tx, &group_id)?.is_some() {
                return Err(GroupError::Forbidden(
                    "foreign groups cannot accept local epoch writes".into(),
                ));
            }
            match (frame.epoch, get_value(tx, &m_key)?) {
                (0, None) => {}
                (_, Some(existing)) => {
                    let current = GroupEpochFrame::from_cbor_bytes(&existing)?;
                    if frame.epoch == 0
                        || current.epoch.checked_add(1) != Some(frame.epoch)
                        || frame.prev_epoch_hash != current.epoch_hash
                    {
                        return Err(GroupError::EpochConflict {
                            current: Box::new(current),
                        });
                    }
                }
                (_, None) => {
                    return Err(GroupError::InvalidInput(
                        "initial group epoch must be 0".into(),
                    ))
                }
            }
            put_value(tx, &m_key, &encoded_new)?;
            put_value(tx, &epoch_history_key(&group_id, frame.epoch), &encoded_new)
        })?;
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

    /// The original receipt of `envelope` if this relay already accepted it (including under
    /// an equivalent signature encoding), authenticated against its historical certificate.
    /// The host answers a retry from this before it looks at the retry's payment, so a retry
    /// gets its receipt whatever the current price or payee.
    pub fn accepted_receipt(
        &self,
        path_group_id: &str,
        envelope: GroupMessageEnvelope,
    ) -> Result<Option<StoredGroupMessage>, GroupError> {
        let (group_id, envelope, digest) = self.local_write(path_group_id, envelope)?;
        self.accepted_message(
            path_group_id,
            &envelope,
            &acceptance_key(&group_id, &digest),
        )
    }

    /// Normalize a write to a group hosted here.
    fn local_write(
        &self,
        path_group_id: &str,
        mut envelope: GroupMessageEnvelope,
    ) -> Result<([u8; 32], GroupMessageEnvelope, [u8; 32]), GroupError> {
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
        Ok((group_id, envelope, digest))
    }

    /// Authenticate new content against the active epoch and append exactly once, recording
    /// `payment` as the payment that funded it in the same transaction. Accepted signed content
    /// (including equivalent signature encodings) is authenticated against its historical
    /// certificate and returns the original receipt, without a new sequence, wake or payment
    /// record. A payment that already funded another write is refused before anything is
    /// written.
    pub fn put_paid_message(
        &self,
        path_group_id: &str,
        envelope: GroupMessageEnvelope,
        payment: &GroupWritePaymentFact,
    ) -> Result<GroupAppendOutcome, GroupError> {
        let (group_id, envelope, digest) = self.local_write(path_group_id, envelope)?;
        let accept_key = acceptance_key(&group_id, &digest);
        if let Some(message) = self.accepted_message(path_group_id, &envelope, &accept_key)? {
            return Ok(GroupAppendOutcome {
                message,
                appended: false,
            });
        }
        let authority_key = meta_key(&group_id);
        let authority_snapshot = self
            .read(|tx| get_value(tx, &authority_key))?
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

        // The object is written before the commit that references it. If the object store is
        // unavailable the append fails here, before any sequence is allocated.
        let ciphertext = hex::decode(&envelope.ciphertext)
            .map_err(|_| GroupError::InvalidInput("ciphertext must be valid hex".into()))?;
        let staged = self.stage_ciphertext(&ciphertext)?;
        let result = self.append_staged(
            path_group_id,
            &envelope,
            &accept_key,
            &authority_snapshot,
            &ciphertext,
            staged.as_ref(),
            payment,
        );
        if let Some(staged) = &staged {
            if !matches!(&result, Ok(outcome) if outcome.appended) {
                self.large_values.abandon(staged);
            }
        }
        result
    }

    /// The append loop of [`Self::put_paid_message`], after authentication and staging.
    #[allow(clippy::too_many_arguments)]
    fn append_staged(
        &self,
        path_group_id: &str,
        envelope: &GroupMessageEnvelope,
        accept_key: &[u8],
        authority_snapshot: &[u8],
        ciphertext: &[u8],
        staged: Option<&Staged>,
        payment: &GroupWritePaymentFact,
    ) -> Result<GroupAppendOutcome, GroupError> {
        let group_id = parse_group_id_hex(path_group_id)?;
        let ownership_key = mirror_key(&group_id);
        let authority_key = meta_key(&group_id);
        let sequence_key = seq_key(&group_id);
        let pay_key = payment_key(&payment.tx_hash);
        let strip = |value: &str| value.strip_prefix("0x").unwrap_or(value).to_lowercase();
        loop {
            // This is the authorization linearization point: epoch rotation and append read
            // and write in one storage transaction, including across relay instances.
            let committed = self.kv.transact(|tx| {
                if tx.get(accept_key)?.is_some()
                    || tx.get(&ownership_key)?.is_some()
                    || get_value(tx, &authority_key)?.as_deref() != Some(authority_snapshot)
                {
                    return Ok::<_, GroupError>(None);
                }
                // Read in this transaction, so two writes racing on one payment conflict and
                // the re-run of the loser finds the winner's record.
                if tx.get(&pay_key)?.is_some() {
                    return Err(GroupError::PaymentAlreadyUsed);
                }
                let server_seq = match tx.get(&sequence_key)? {
                    Some(bytes) => parse_sequence(&bytes, "G_seq value")?
                        .checked_add(1)
                        .ok_or_else(|| GroupError::Storage("group sequence exhausted".into()))?,
                    None => 1,
                };
                let stored = StoredGroupMessage {
                    group_id: path_group_id.to_string(),
                    server_seq,
                    server_time_ms: now_ms(),
                    epoch: envelope.epoch,
                    nonce: strip(&envelope.nonce),
                    ciphertext: strip(&envelope.ciphertext),
                    write_sig: strip(&envelope.write_sig),
                };
                let row =
                    MessageRow::from_message(&stored, Self::stored_ciphertext(ciphertext, staged))?;
                let record = GroupPaymentRecord {
                    network: payment.network.clone(),
                    tx_hash: hex::encode(payment.tx_hash),
                    payer: format!("0x{}", hex::encode(payment.payer)),
                    payee: format!("0x{}", hex::encode(payment.payee)),
                    value_wei: payment.value_wei.to_string(),
                    group_id: path_group_id.to_string(),
                    server_seq,
                };
                let record = serde_json::to_vec(&record).map_err(|error| {
                    GroupError::Storage(format!("serialize group payment record: {error}"))
                })?;
                tx.set(accept_key, &server_seq.to_be_bytes())?;
                tx.set(&sequence_key, &server_seq.to_be_bytes())?;
                tx.set(&pay_key, &record)?;
                write_message_row(
                    tx,
                    &self.large_values,
                    &msg_key(&group_id, server_seq),
                    &row,
                    staged,
                )?;
                Ok(Some(stored))
            })?;
            if let Some(message) = committed {
                return Ok(GroupAppendOutcome {
                    message,
                    appended: true,
                });
            }
            if let Some(message) = self.accepted_message(path_group_id, envelope, accept_key)? {
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
            if self.read(|tx| get_value(tx, &authority_key))?.as_deref() != Some(authority_snapshot)
            {
                return Err(GroupError::Forbidden(
                    "group epoch changed before message commit".into(),
                ));
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
        let group_id = parse_group_id_hex(group_id_hex)?;
        let Some((sequence, raw)) = self.read(|tx| {
            let Some(locator) = tx.get(accept_key)? else {
                return Ok(None);
            };
            let sequence = parse_sequence(&locator, "group acceptance locator")?;
            let raw = tx.get(&msg_key(&group_id, sequence))?.ok_or_else(|| {
                GroupError::Storage("group acceptance index references missing receipt".into())
            })?;
            Ok(Some((sequence, raw)))
        })?
        else {
            return Ok(None);
        };
        let row = MessageRow::decode(&raw)?;
        let ciphertext = hex::decode(&envelope.ciphertext)
            .map_err(|_| GroupError::InvalidInput("ciphertext must be valid hex".into()))?;
        // The digest proves the content; a retry needs no object store read.
        if row.server_seq != sequence
            || row.epoch != envelope.epoch
            || hex::encode(&row.nonce) != envelope.nonce
            || !row.ciphertext.matches(&ciphertext)
        {
            return Err(GroupError::Storage(
                "group acceptance index does not match signed content".into(),
            ));
        }
        let stored = row.into_message(group_id_hex, &ciphertext);
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

    /// The record of the accepted write `tx_hash` paid for, if any.
    pub fn payment_record(
        &self,
        tx_hash: &[u8; 32],
    ) -> Result<Option<GroupPaymentRecord>, GroupError> {
        let key = payment_key(tx_hash);
        let Some(raw) = self.read(|tx| tx.get(&key).map_err(GroupError::from))? else {
            return Ok(None);
        };
        serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|error| GroupError::Storage(format!("corrupt group payment record: {error}")))
    }

    /// Append `envelope` with a payment derived from its digest. Tests of the store's
    /// sequencing and authority, which do not concern payments.
    #[cfg(test)]
    pub(crate) fn put_message(
        &self,
        path_group_id: &str,
        envelope: GroupMessageEnvelope,
    ) -> Result<GroupAppendOutcome, GroupError> {
        let payment = GroupWritePaymentFact {
            network: "monad-testnet".into(),
            tx_hash: self.local_write(path_group_id, envelope.clone())?.2,
            payer: [1; 20],
            payee: [2; 20],
            value_wei: 1,
        };
        self.put_paid_message(path_group_id, envelope, &payment)
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
        let after_key = (after_seq > 0).then(|| msg_key(&group_id, after_seq));
        let bounded_limit = (limit as usize).clamp(1, 500);
        let rows = self.read(|tx| {
            tx.scan_prefix(&prefix, after_key.as_deref(), bounded_limit)?
                .into_iter()
                .map(|(_, value)| MessageRow::decode(&value))
                .collect::<Result<Vec<_>, _>>()
        })?;
        // Large ciphertexts are fetched after the read transaction, never inside it.
        rows.into_iter()
            .map(|row| self.row_message(group_id_hex, row))
            .collect()
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
        subscriber_tag: Option<&str>,
        authenticated_epoch: &GroupEpochFrame,
        read_token: &str,
    ) -> Result<GroupMirrorState, GroupError> {
        authenticated_epoch.verify_authority(group_id_hex)?;
        authenticated_epoch.verify_read_token(read_token)?;
        self.initialize_baseline()?;
        // A subscriber without a blinded tag is counted by a hash of its capability; the
        // read token itself is never stored.
        let subscriber_tag = match subscriber_tag.map(str::trim).filter(|t| !t.is_empty()) {
            Some(tag) => tag.to_string(),
            None => hex::encode(Sha256::digest(
                [
                    b"frank-group-read-subscriber-v1:".as_slice(),
                    read_token.trim().to_ascii_lowercase().as_bytes(),
                ]
                .concat(),
            )),
        };
        let group_id = parse_group_id_hex(group_id_hex)?;
        let authenticated_hash = hex::encode(authenticated_epoch.compute_epoch_hash()?);
        self.kv.transact(|tx| {
            let current = get_mirror_state(tx, &group_id)?;
            if let Some(raw) = get_value(tx, &meta_key(&group_id))? {
                if current.is_none() {
                    return Err(GroupError::Forbidden(
                        "local group cannot become a foreign mirror".into(),
                    ));
                }
                let local = GroupEpochFrame::from_cbor_bytes(&raw)?;
                if local.epoch > authenticated_epoch.epoch
                    || (local.epoch == authenticated_epoch.epoch
                        && local.epoch_hash != authenticated_hash)
                {
                    return Err(GroupError::Forbidden(
                        "read capability targets a stale or conflicting group epoch".into(),
                    ));
                }
            }

            let mut state = current.unwrap_or_else(|| GroupMirrorState {
                group_id: group_id_hex.to_string(),
                upstream_relay: upstream_relay.trim_end_matches('/').to_string(),
                subscribers: BTreeSet::new(),
                mirrored: false,
                last_synced_seq: 0,
            });
            if state.upstream_relay != upstream_relay.trim_end_matches('/') {
                return Err(GroupError::Forbidden(
                    "group upstream does not match established ownership".into(),
                ));
            }
            state.subscribers.insert(subscriber_tag.clone());
            if state.subscribers.len() >= self.mirror_threshold {
                state.mirrored = true;
            }
            let encoded =
                serde_json::to_vec(&state).map_err(|e| GroupError::Storage(e.to_string()))?;
            put_value(tx, &mirror_key(&group_id), &encoded)?;
            Ok(state)
        })
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
            self.kv.transact(|tx| {
                // A delayed upstream response must never roll the active authority/read token backwards.
                let current = get_value(tx, &meta_key(&group_id))?
                    .map(|raw| GroupEpochFrame::from_cbor_bytes(&raw))
                    .transpose()?;
                match current {
                    Some(current)
                        if current.epoch == frame.epoch
                            && current.epoch_hash != frame.epoch_hash =>
                    {
                        return Err(GroupError::EpochConflict {
                            current: Box::new(current),
                        })
                    }
                    Some(current) if current.epoch >= frame.epoch => {}
                    _ => put_value(tx, &meta_key(&group_id), &encoded)?,
                }
                let history_key = epoch_history_key(&group_id, frame.epoch);
                match get_value(tx, &history_key)? {
                    None => put_value(tx, &history_key, &encoded),
                    Some(existing) if existing == encoded => Ok(()),
                    Some(_) => Err(GroupError::Storage(
                        "conflicting historical group epoch certificate".into(),
                    )),
                }
            })?;
        }

        let mut max_seq = 0u64;
        for msg in messages {
            let ciphertext = parse_var_hex(&msg.ciphertext, "ciphertext", 1024 * 1024)?;
            let staged = self.stage_ciphertext(&ciphertext)?;
            let row = MessageRow::from_message(
                msg,
                Self::stored_ciphertext(&ciphertext, staged.as_ref()),
            )?;
            let key = msg_key(&group_id, msg.server_seq);
            let written = self.kv.transact(|tx| {
                write_message_row(tx, &self.large_values, &key, &row, staged.as_ref())
            });
            if let (Err(_), Some(staged)) = (&written, &staged) {
                self.large_values.abandon(staged);
            }
            written?;
            max_seq = max_seq.max(msg.server_seq);
        }

        if max_seq > 0 {
            self.kv.transact(|tx| {
                let s_key = seq_key(&group_id);
                let current_seq = tx
                    .get(&s_key)?
                    .and_then(|b| b.as_slice().try_into().ok().map(u64::from_be_bytes))
                    .unwrap_or(0);
                if max_seq > current_seq {
                    tx.set(&s_key, &max_seq.to_be_bytes())?;
                }
                let m_key = mirror_key(&group_id);
                let state = get_value(tx, &m_key)?
                    .and_then(|raw| serde_json::from_slice::<GroupMirrorState>(&raw).ok());
                if let Some(mut state) = state {
                    if max_seq > state.last_synced_seq {
                        state.last_synced_seq = max_seq;
                        let encoded = serde_json::to_vec(&state)
                            .map_err(|e| GroupError::Storage(e.to_string()))?;
                        put_value(tx, &m_key, &encoded)?;
                    }
                }
                Ok::<_, GroupError>(())
            })?;
        }

        Ok(max_seq)
    }

    /// Read the current [`GroupMirrorState`] for `group_id_hex` if any.
    pub fn get_mirror_state(
        &self,
        group_id_hex: &str,
    ) -> Result<Option<GroupMirrorState>, GroupError> {
        let group_id = parse_group_id_hex(group_id_hex)?;
        self.read(|tx| get_mirror_state(tx, &group_id))
    }
}

/// Where the registry's groups keep their state, chosen by daemon composition.
#[derive(Debug, Clone)]
pub enum GroupBackend {
    /// This replica's RocksDB beside the registry database, opened on the first group request.
    RocksDbBeside(PathBuf),
    /// A transaction store shared by every replica (FoundationDB), opened by composition.
    Shared(Arc<dyn RelayKvStore>),
}

impl GroupBackend {
    /// The RocksDB group store beside `registry_db` (`<db>.groups-v1`).
    pub fn rocksdb_beside(registry_db: &std::path::Path) -> Self {
        Self::RocksDbBeside(registry_db.with_extension(GROUP_STORE_EXTENSION))
    }
}

/// Lazy owner of the registry's durable [`GroupStore`], opened on first group request.
///
/// Opening is serialized by the mutex: concurrent first requests wait for the one open rather
/// than each opening the RocksDB directory, which would fail on its `LOCK` for all but one.
/// Opening and every store call block, so async callers reach this through `spawn_blocking`.
#[derive(Debug)]
pub struct Owner {
    backend: GroupBackend,
    objects: Arc<dyn ObjectStore>,
    store: Mutex<Option<GroupStore>>,
    mirror_threshold: usize,
}

impl Owner {
    /// Create a lazy group store owner over `backend`, storing large ciphertexts in `objects`.
    pub fn new(backend: GroupBackend, objects: Arc<dyn ObjectStore>) -> Self {
        Self {
            backend,
            objects,
            store: Mutex::new(None),
            mirror_threshold: DEFAULT_GROUP_MIRROR_THRESHOLD,
        }
    }

    /// The store if a request has already opened it. The sweep uses this so it never opens
    /// (or creates) the group database itself.
    pub fn opened(&self) -> Option<GroupStore> {
        self.store.lock().ok()?.clone()
    }

    /// Access or initialize the [`GroupStore`].
    ///
    /// The lock covers only opening the backend. Every store read checks the namespace
    /// baseline in its own transaction, so the cached store is not re-checked here and no
    /// group request waits on another request's storage round trip.
    pub fn get(&self) -> Result<GroupStore, GroupError> {
        let opened = {
            let mut store = self
                .store
                .lock()
                .map_err(|_| GroupError::Storage("group store owner poisoned".into()))?;
            if let Some(store) = store.as_ref() {
                return Ok(store.clone());
            }
            let kv: Arc<dyn RelayKvStore> = match &self.backend {
                GroupBackend::RocksDbBeside(path) => Arc::new(RocksDbKvStore::open(path)?),
                GroupBackend::Shared(kv) => Arc::clone(kv),
            };
            let opened =
                GroupStore::with_mirror_threshold(kv, self.objects.clone(), self.mirror_threshold);
            *store = Some(opened.clone());
            opened
        };
        // Fail the first request on an unsupported namespace, outside the lock.
        opened.check_baseline()?;
        Ok(opened)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::kv_store::Outcome;
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

    /// Single-operation transactions for test setup and inspection.
    trait Direct {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError>;
        fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError>;
        fn scan_prefix_range(
            &self,
            prefix: &[u8],
            after: Option<&[u8]>,
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError>;
    }

    impl<S: RelayKvStore + ?Sized> Direct for S {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
            self.transact(|tx| tx.get(key))
        }
        fn put(&self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
            self.transact(|tx| tx.set(key, value))
        }
        fn scan_prefix_range(
            &self,
            prefix: &[u8],
            after: Option<&[u8]>,
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
            self.transact(|tx| tx.scan_prefix(prefix, after, limit))
        }
    }

    fn temporary() -> Arc<RocksDbKvStore> {
        Arc::new(RocksDbKvStore::open_temporary().unwrap())
    }

    /// One object directory shared by this process's tests. Objects are content-addressed, so
    /// sharing is safe; tests that sweep use their own directory.
    fn test_objects() -> Arc<dyn ObjectStore> {
        static SHARED: std::sync::OnceLock<Arc<LocalFsObjectStore>> = std::sync::OnceLock::new();
        SHARED
            .get_or_init(|| Arc::new(LocalFsObjectStore::temporary()))
            .clone()
    }

    /// Delegates to a real store; `on_get` and `on_write` observe each operation first.
    struct ObservedTransaction<'a> {
        inner: &'a mut dyn KvTransaction,
        on_get: &'a dyn Fn(&[u8], &Option<Vec<u8>>),
        on_write: &'a mut dyn FnMut(),
    }

    impl KvTransaction for ObservedTransaction<'_> {
        fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>, KvError> {
            let value = self.inner.get(key)?;
            (self.on_get)(key, &value);
            Ok(value)
        }
        fn get_range(
            &mut self,
            start: &[u8],
            end: &[u8],
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
            self.inner.get_range(start, end, limit)
        }
        fn get_range_reverse(
            &mut self,
            start: &[u8],
            end: &[u8],
            limit: usize,
        ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, KvError> {
            self.inner.get_range_reverse(start, end, limit)
        }
        fn set(&mut self, key: &[u8], value: &[u8]) -> Result<(), KvError> {
            (self.on_write)();
            self.inner.set(key, value)
        }
        fn clear(&mut self, key: &[u8]) -> Result<(), KvError> {
            (self.on_write)();
            self.inner.clear(key)
        }
        fn atomic_add(&mut self, key: &[u8], delta: i64) -> Result<(), KvError> {
            (self.on_write)();
            self.inner.atomic_add(key, delta)
        }
    }

    /// A real store whose every mutating commit fails; read-only transactions succeed.
    #[derive(Debug)]
    struct FailingCommitKv(Arc<dyn RelayKvStore>);

    impl RelayKvStore for FailingCommitKv {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
        ) -> Result<Outcome, KvError> {
            let mut wrote = false;
            let outcome = self.0.run_transaction(&mut |tx| {
                wrote = false;
                let outcome = body(&mut ObservedTransaction {
                    inner: tx,
                    on_get: &|_, _| {},
                    on_write: &mut || wrote = true,
                });
                // Discard the writes in place of a failed commit.
                if wrote {
                    Outcome::Abort
                } else {
                    outcome
                }
            })?;
            if wrote && outcome == Outcome::Abort {
                return Err(KvError::Backend("injected transaction outage".into()));
            }
            Ok(outcome)
        }
    }

    #[test]
    fn epoch_cas_backend_failures_are_not_reported_as_successful_creation_or_rotation() {
        let kv = temporary();
        let healthy = GroupStore::new(kv.clone(), test_objects());
        let failing = GroupStore::new(Arc::new(FailingCommitKv(kv)), test_objects());
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

    /// A real store that pauses once: on the first empty `G_accept:` lookup when
    /// `pause_at_lookup`, otherwise on the first write of a transaction (before its commit).
    #[derive(Debug)]
    struct PausingCommitKv {
        backend: Arc<dyn RelayKvStore>,
        ready: std::sync::Barrier,
        resume: std::sync::Barrier,
        pause: std::sync::atomic::AtomicBool,
        pause_at_lookup: bool,
    }

    impl PausingCommitKv {
        fn pause_once(&self) {
            if self.pause.swap(false, std::sync::atomic::Ordering::SeqCst) {
                self.ready.wait();
                self.resume.wait();
            }
        }
    }

    impl RelayKvStore for PausingCommitKv {
        fn run_transaction(
            &self,
            body: &mut dyn FnMut(&mut dyn KvTransaction) -> Outcome,
        ) -> Result<Outcome, KvError> {
            self.backend.run_transaction(&mut |tx| {
                body(&mut ObservedTransaction {
                    inner: tx,
                    on_get: &|key, value| {
                        if self.pause_at_lookup && key.starts_with(b"G_accept:") && value.is_none()
                        {
                            self.pause_once();
                        }
                    },
                    on_write: &mut || {
                        if !self.pause_at_lookup {
                            self.pause_once();
                        }
                    },
                })
            })
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

    #[test]
    fn one_payment_funds_one_write_and_is_recorded_with_it() {
        let kv = temporary();
        let store = GroupStore::new(kv.clone(), test_objects());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        let payment = GroupWritePaymentFact {
            network: "monad-testnet".into(),
            tx_hash: [9; 32],
            payer: [1; 20],
            payee: [2; 20],
            value_wei: 1_000,
        };
        let first = store
            .put_paid_message(&id, message_for(&id, 0, 1, &write_sk), &payment)
            .unwrap();
        assert!(first.appended);
        assert_eq!(
            store.payment_record(&[9; 32]).unwrap(),
            Some(GroupPaymentRecord {
                network: "monad-testnet".into(),
                tx_hash: hex::encode([9u8; 32]),
                payer: format!("0x{}", hex::encode([1u8; 20])),
                payee: format!("0x{}", hex::encode([2u8; 20])),
                value_wei: "1000".into(),
                group_id: id.clone(),
                server_seq: first.message.server_seq,
            })
        );
        // The same write again is its receipt, whatever payment comes with it.
        let other_payment = GroupWritePaymentFact {
            tx_hash: [8; 32],
            ..payment.clone()
        };
        let retry = store
            .put_paid_message(&id, message_for(&id, 0, 1, &write_sk), &other_payment)
            .unwrap();
        assert_eq!((retry.appended, retry.message), (false, first.message));
        assert_eq!(store.payment_record(&[8; 32]).unwrap(), None);
        // Another write cannot reuse the payment, and nothing of it is stored.
        let before = kv.scan_prefix_range(&[], None, 100).unwrap();
        assert_eq!(
            store.put_paid_message(&id, message_for(&id, 0, 2, &write_sk), &payment),
            Err(GroupError::PaymentAlreadyUsed)
        );
        assert_eq!(kv.scan_prefix_range(&[], None, 100).unwrap(), before);
    }

    #[test]
    fn two_writes_racing_on_one_payment_give_one_append() {
        for _ in 0..20 {
            let kv = temporary();
            let objects = test_objects();
            let initial = root_frame(3, 0, &"00".repeat(32));
            let id = initial.group_id.clone();
            GroupStore::new(kv.clone(), objects.clone())
                .put_epoch(&id, initial)
                .unwrap();
            let (write_sk, _) = keypair(42);
            let payment = GroupWritePaymentFact {
                network: "monad-testnet".into(),
                tx_hash: [9; 32],
                payer: [1; 20],
                payee: [2; 20],
                value_wei: 1_000,
            };
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let results: Vec<_> = (1..=2u8)
                .map(|nonce| {
                    // Two replicas: separate stores over the one database.
                    let store = GroupStore::new(kv.clone(), objects.clone());
                    let (id, payment, barrier) = (id.clone(), payment.clone(), barrier.clone());
                    let message = message_for(&id, 0, nonce, &write_sk);
                    std::thread::spawn(move || {
                        barrier.wait();
                        store.put_paid_message(&id, message, &payment)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect();
            let appended = results
                .iter()
                .filter(|result| matches!(result, Ok(outcome) if outcome.appended))
                .count();
            let refused = results
                .iter()
                .filter(|result| **result == Err(GroupError::PaymentAlreadyUsed))
                .count();
            assert_eq!((appended, refused), (1, 1), "{results:?}");
            let store = GroupStore::new(kv, objects);
            assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
            assert_eq!(
                store.payment_record(&[9; 32]).unwrap().unwrap().server_seq,
                1
            );
        }
    }

    #[test]
    fn values_over_the_store_limit_split_and_replacements_leave_no_stale_parts() {
        let kv = temporary();
        let store = GroupStore::new(kv.clone(), test_objects());
        let (root_sk, _) = keypair(3);
        let mut initial = root_frame(3, 0, &"00".repeat(32));
        initial.encrypted_epoch_descriptor = hex::encode(vec![7u8; 120 * 1024]);
        let initial = signed_epoch(&root_sk, initial);
        let id = initial.group_id.clone();
        let committed = store.put_epoch(&id, initial).unwrap();
        assert_eq!(store.get_current_epoch(&id).unwrap().unwrap(), committed);
        assert_eq!(store.get_epoch(&id, 0).unwrap().unwrap(), committed);
        let group_id = parse_group_id_hex(&id).unwrap();
        let meta_parts = part_prefix(&meta_key(&group_id));
        assert!(kv.scan_prefix_range(&meta_parts, None, 10).unwrap().len() > 1);

        store
            .put_epoch(&id, root_frame(3, 1, &committed.epoch_hash))
            .unwrap();
        assert!(kv
            .scan_prefix_range(&meta_parts, None, 10)
            .unwrap()
            .is_empty());
        assert_eq!(store.get_epoch(&id, 0).unwrap().unwrap(), committed);
        assert_eq!(store.get_current_epoch(&id).unwrap().unwrap().epoch, 1);
    }

    #[test]
    fn group_writes_accept_varied_sizes_and_retry_survives_reopen_rotation() {
        let path = std::env::temp_dir().join(format!(
            "frank-group-price-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let initial = root_frame(3, 0, &"00".repeat(32)).normalized().unwrap();
        let id = initial.group_id.clone();
        let (write_sk, _) = keypair(42);
        let original = message_for(&id, 0, 1, &write_sk);
        let receipt;
        {
            let store = GroupStore::new(
                Arc::new(RocksDbKvStore::open(&path).unwrap()),
                test_objects(),
            );
            store.put_epoch(&id, initial.clone()).unwrap();
            receipt = store.put_message(&id, original.clone()).unwrap().message;
            let mut large = message_for(&id, 0, 2, &write_sk);
            large.ciphertext = "ab".repeat(1024 * 1024);
            large.write_sig = sign_digest(&write_sk, &large.signing_digest().unwrap());
            assert!(store.put_message(&id, large.clone()).unwrap().appended);
            large.ciphertext.push_str("ab");
            assert!(matches!(
                store.put_message(&id, large),
                Err(GroupError::InvalidInput(_))
            ));
        }
        {
            let store = GroupStore::new(
                Arc::new(RocksDbKvStore::open(&path).unwrap()),
                test_objects(),
            );
            let retry = store.put_message(&id, original.clone()).unwrap();
            assert!(!retry.appended);
            assert_eq!(retry.message, receipt);
            store
                .put_epoch(&id, root_frame(3, 1, &initial.epoch_hash))
                .unwrap();
            assert_eq!(
                store.put_message(&id, original.clone()).unwrap().message,
                receipt
            );
            assert!(matches!(
                store.put_message(&id, message_for(&id, 0, 3, &write_sk)),
                Err(GroupError::Forbidden(_))
            ));
            assert!(
                store
                    .put_message(&id, message_for(&id, 1, 4, &write_sk))
                    .unwrap()
                    .appended
            );
            let mut invalid_retry = original;
            invalid_retry.write_sig = "00".repeat(64);
            assert!(matches!(
                store.put_message(&id, invalid_retry),
                Err(GroupError::Forbidden(_))
            ));
            assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 3);
        }
        std::fs::remove_dir_all(path).unwrap();
    }

    fn verify_rotation_serializes_with_in_flight_appends(backend: Arc<dyn RelayKvStore>) {
        let store = GroupStore::new(backend.clone(), test_objects());
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
        let in_flight = GroupStore::new(paused_kv.clone(), test_objects());
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
            let replica = GroupStore::new(backend.clone(), test_objects());
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
    fn rotation_prevents_stale_commit_and_allows_concurrent_authorized_appends() {
        verify_rotation_serializes_with_in_flight_appends(temporary());
    }

    #[test]
    fn rocksdb_rotation_prevents_stale_commit_and_persists_atomic_appends() {
        let directory = tempdir::TempDir::new("group-rotation-atomicity").unwrap();
        let path = directory.path().join("groups.rocksdb");
        verify_rotation_serializes_with_in_flight_appends(Arc::new(
            RocksDbKvStore::open(&path).unwrap(),
        ));
        let reopened = GroupStore::new(
            Arc::new(RocksDbKvStore::open(&path).unwrap()),
            test_objects(),
        );
        let id = root_frame(3, 0, &"00".repeat(32)).group_id;
        assert_eq!(reopened.get_current_epoch(&id).unwrap().unwrap().epoch, 1);
        assert_eq!(reopened.list_messages(&id, 0, 10).unwrap().len(), 8);
    }

    #[test]
    fn append_writes_only_the_sequence_and_message_rows() {
        let kv = temporary();
        let store = GroupStore::new(kv.clone(), test_objects());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        store
            .put_message(&id, message_for(&id, 0, 1, &write_sk))
            .unwrap();
        assert!(kv.scan_prefix_range(b"G_vs:", None, 10).unwrap().is_empty());
        assert_eq!(store.list_messages(&id, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn foreign_subscriber_without_a_tag_is_counted_by_a_hash_never_the_read_token() {
        let store = GroupStore::new_temporary();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        let read_token = "00".repeat(32);
        let state = store
            .record_foreign_subscriber(&id, "https://relay.example", None, &initial, &read_token)
            .unwrap();
        assert_eq!(state.subscribers.len(), 1);
        let stored = serde_json::to_string(&store.get_mirror_state(&id).unwrap()).unwrap();
        assert!(!stored.contains(&read_token));
        // The same capability without a tag is the same subscriber.
        let again = store
            .record_foreign_subscriber(&id, "https://relay.example", None, &initial, &read_token)
            .unwrap();
        assert_eq!(again.subscribers, state.subscribers);
    }

    #[test]
    fn concurrent_first_requests_share_one_store_open() {
        let dir = tempdir::TempDir::new("group-owner").unwrap();
        let owner = Arc::new(Owner::new(
            GroupBackend::rocksdb_beside(&dir.path().join("registry.db")),
            test_objects(),
        ));
        let start = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let owner = owner.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    owner.get().map(|_| ())
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let store = owner.get().unwrap();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        assert!(owner
            .get()
            .unwrap()
            .get_current_epoch(&id)
            .unwrap()
            .is_some());
    }

    #[test]
    fn failed_atomic_append_does_not_publish_message_or_consume_sequence() {
        let kv = temporary();
        let healthy = GroupStore::new(kv.clone(), test_objects());
        let failing = GroupStore::new(Arc::new(FailingCommitKv(kv.clone())), test_objects());
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
            let failing = GroupStore::new(Arc::new(FailingCommitKv(backend)), test_objects());
            assert!(failing.put_epoch(&id, initial.clone()).is_err());
        }
        {
            let backend = Arc::new(RocksDbKvStore::open(&path).unwrap());
            let healthy = GroupStore::new(backend.clone(), test_objects());
            assert!(healthy.get_current_epoch(&id).unwrap().is_none());
            assert!(healthy.get_epoch(&id, 0).unwrap().is_none());
            let committed = healthy.put_epoch(&id, initial).unwrap();
            let failing = GroupStore::new(Arc::new(FailingCommitKv(backend)), test_objects());
            assert!(failing
                .put_epoch(&id, root_frame(3, 1, &committed.epoch_hash))
                .is_err());
        }
        let reopened = GroupStore::new(
            Arc::new(RocksDbKvStore::open(&path).unwrap()),
            test_objects(),
        );
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
        let store = GroupStore::new_temporary();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                Some("member"),
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
        let store = GroupStore::new_temporary();
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        assert!(store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                Some("attacker"),
                &initial,
                &"01".repeat(32)
            )
            .is_err());
        assert!(store.get_mirror_state(&id).unwrap().is_none());
        store
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                Some("member"),
                &initial,
                &"00".repeat(32),
            )
            .unwrap();
        assert!(store
            .record_foreign_subscriber(
                &id,
                "https://attacker.example",
                Some("attacker"),
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
                Some("stale"),
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
        let local = GroupStore::new_temporary();
        local.put_epoch(&id, initial.clone()).unwrap();
        assert!(local
            .record_foreign_subscriber(
                &id,
                "https://relay.example",
                Some("member"),
                &initial,
                &"00".repeat(32)
            )
            .is_err());
        assert!(local.get_mirror_state(&id).unwrap().is_none());
    }

    #[test]
    fn epoch_authority_rejects_forgery_and_binds_all_mutable_fields() {
        let store = GroupStore::new_temporary();
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
        let store = GroupStore::new_temporary();
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
        let source = GroupStore::new_temporary();
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
        let store = GroupStore::new_temporary();
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
        let store = GroupStore::new_temporary();
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
        let empty = temporary();
        GroupStore::new(empty.clone(), test_objects())
            .ingest_mirrored_upstream(&"00".repeat(32), None, &[])
            .unwrap();
        assert!(empty.scan_prefix_range(&[], None, 1).unwrap().is_empty());
        let kv = temporary();
        kv.put(b"unrelated:registry", b"preserved").unwrap();
        let store = GroupStore::new(kv.clone(), test_objects());
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
                let replica = GroupStore::new(kv.clone(), test_objects());
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
        let old = temporary();
        old.put(
            &meta_key(&parse_group_id_hex(&initial.group_id).unwrap()),
            &initial.to_cbor_bytes().unwrap(),
        )
        .unwrap();
        let unsupported = GroupStore::new(old.clone(), test_objects());
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
        let kv = temporary();
        let store = GroupStore::new(kv.clone(), test_objects());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (key, _) = keypair(42);
        let envelope = message_for(&id, 0, 1, &key);
        let start = Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let replica = GroupStore::new(kv.clone(), test_objects());
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
            let store = GroupStore::new(kv.clone(), test_objects());
            let initial = store.put_epoch(&id, initial).unwrap();
            let failing = GroupStore::new(Arc::new(FailingCommitKv(kv.clone())), test_objects());
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
        let store = GroupStore::new(
            Arc::new(RocksDbKvStore::open(&path).unwrap()),
            test_objects(),
        );
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
        let backend = temporary();
        let store = GroupStore::new(backend.clone(), test_objects());
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
        let replica = GroupStore::new(paused.clone(), test_objects());
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
        let kv = temporary();
        let store = GroupStore::new(kv.clone(), test_objects());
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
        // A well-formed row whose original signature no longer authenticates the content.
        let row = MessageRow::from_message(
            &corrupt,
            StoredCiphertext::Inline(hex::decode(&corrupt.ciphertext).unwrap()),
        )
        .unwrap();
        kv.put(
            &msg_key(&group_id, receipt.server_seq),
            &row.encode().unwrap(),
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
        assert!(
            Owner::new(GroupBackend::rocksdb_beside(&registry), test_objects())
                .get()
                .is_err()
        );
        let kv = RocksDbKvStore::open(&path).unwrap();
        assert!(kv.get(GROUP_FORMAT_KEY).unwrap().is_none());
        assert_eq!(kv.get(&key).unwrap().unwrap(), raw);
    }
    #[test]
    fn stale_empty_acceptance_lookup_rechecks_receipt_before_rejecting_rotated_epoch() {
        let backend = temporary();
        let store = GroupStore::new(backend.clone(), test_objects());
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
        let replica = GroupStore::new(paused.clone(), test_objects());
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

    fn large_message(
        id: &str,
        nonce: u8,
        len: usize,
        write_sk: &SecretKey,
    ) -> GroupMessageEnvelope {
        let mut message = message_for(id, 0, nonce, write_sk);
        message.ciphertext = hex::encode(
            (0..len)
                .map(|i| (i * 31 + nonce as usize) as u8)
                .collect::<Vec<_>>(),
        );
        message.write_sig = sign_digest(write_sk, &message.signing_digest().unwrap());
        message
    }

    /// Upload objects under `groups/sha256/<hex>/<upload>`.
    fn object_count(root: &std::path::Path) -> usize {
        let visible =
            |entry: &std::fs::DirEntry| !entry.file_name().to_string_lossy().starts_with('.');
        let Ok(digests) = std::fs::read_dir(root.join("groups/sha256")) else {
            return 0;
        };
        digests
            .map(|entry| entry.unwrap())
            .filter(visible)
            .map(|digest| {
                std::fs::read_dir(digest.path())
                    .unwrap()
                    .map(|entry| entry.unwrap())
                    .filter(visible)
                    .count()
            })
            .sum()
    }

    #[test]
    fn large_ciphertext_is_stored_by_reference_and_inline_up_to_64_kib() {
        let kv = temporary();
        let objects = Arc::new(LocalFsObjectStore::temporary());
        let store = GroupStore::new(kv.clone(), objects.clone());
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        let inline = large_message(&id, 1, INLINE_LIMIT, &write_sk);
        let large = large_message(&id, 2, 1024 * 1024, &write_sk);
        store.put_message(&id, inline.clone()).unwrap();
        let receipt = store.put_message(&id, large.clone()).unwrap();
        assert!(receipt.appended);
        assert_eq!(receipt.message.ciphertext, large.ciphertext);

        // Only the 1 MiB ciphertext left the row; both rows fit FoundationDB's value limit.
        assert_eq!(object_count(objects.root()), 1);
        let group_id = parse_group_id_hex(&id).unwrap();
        let rows = kv
            .scan_prefix_range(&msg_prefix(&group_id), None, 10)
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].1.len() > INLINE_LIMIT && rows[0].1.len() < MAX_VALUE_BYTES);
        assert!(rows[1].1.len() < 200);
        assert!(kv
            .scan_prefix_range(GROUP_PART_PREFIX, None, 10)
            .unwrap()
            .is_empty());

        let listed = store.list_messages(&id, 0, 10).unwrap();
        assert_eq!(listed[0].ciphertext, inline.ciphertext);
        assert_eq!(listed[1], receipt.message);

        // A retry is answered from the digest in the row, without reading the object.
        let references = store.large_values().references(10).unwrap();
        assert_eq!(references.len(), 1);
        assert!(references[0].matches(&hex::decode(&large.ciphertext).unwrap()));
        objects
            .delete(&store.large_values().object_key(&references[0]))
            .unwrap();
        let retry = store.put_message(&id, large).unwrap();
        assert!(!retry.appended);
        assert_eq!(retry.message, receipt.message);
        // A missing referenced object fails the read closed rather than returning a gap.
        assert!(matches!(
            store.list_messages(&id, 0, 10),
            Err(GroupError::LargeValue(LargeValueError::Corrupt(_)))
        ));
    }

    /// A real directory store whose writes and reads fail while `down` is set.
    #[derive(Debug)]
    struct OutageObjects {
        inner: LocalFsObjectStore,
        down: std::sync::atomic::AtomicBool,
    }

    impl OutageObjects {
        fn check(&self) -> Result<(), crate::store::large_values::ObjectStoreError> {
            if self.down.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(crate::store::large_values::ObjectStoreError(
                    "connection refused".into(),
                ));
            }
            Ok(())
        }
    }

    impl ObjectStore for OutageObjects {
        fn put(
            &self,
            key: &str,
            bytes: &[u8],
            sha256: &[u8; 32],
        ) -> Result<(), crate::store::large_values::ObjectStoreError> {
            self.check()?;
            self.inner.put(key, bytes, sha256)
        }
        fn put_if_absent(
            &self,
            key: &str,
            bytes: &[u8],
            sha256: &[u8; 32],
        ) -> Result<bool, crate::store::large_values::ObjectStoreError> {
            self.check()?;
            self.inner.put_if_absent(key, bytes, sha256)
        }
        fn get(
            &self,
            key: &str,
        ) -> Result<Option<Vec<u8>>, crate::store::large_values::ObjectStoreError> {
            self.check()?;
            self.inner.get(key)
        }
        fn delete(&self, key: &str) -> Result<(), crate::store::large_values::ObjectStoreError> {
            self.check()?;
            self.inner.delete(key)
        }
        fn contains(
            &self,
            key: &str,
        ) -> Result<bool, crate::store::large_values::ObjectStoreError> {
            self.check()?;
            self.inner.contains(key)
        }
    }

    #[test]
    fn object_store_outage_fails_a_large_append_closed_without_consuming_a_sequence() {
        let kv = temporary();
        let objects = Arc::new(OutageObjects {
            inner: LocalFsObjectStore::temporary(),
            down: std::sync::atomic::AtomicBool::new(true),
        });
        let store = GroupStore::new(kv.clone(), objects.clone())
            .with_large_value_intent_ttl(std::time::Duration::ZERO);
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        let large = large_message(&id, 1, INLINE_LIMIT + 1, &write_sk);
        assert!(matches!(
            store.put_message(&id, large.clone()),
            Err(GroupError::LargeValue(LargeValueError::Unavailable(_)))
        ));
        let group_id = parse_group_id_hex(&id).unwrap();
        assert!(kv.get(&seq_key(&group_id)).unwrap().is_none());
        assert!(store.list_messages(&id, 0, 10).unwrap().is_empty());
        // Small messages do not depend on the object store.
        assert_eq!(
            store
                .put_message(&id, message_for(&id, 0, 2, &write_sk))
                .unwrap()
                .message
                .server_seq,
            1
        );
        objects
            .down
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let receipt = store.put_message(&id, large.clone()).unwrap();
        assert_eq!(receipt.message.server_seq, 2);
        assert_eq!(
            store.list_messages(&id, 1, 10).unwrap()[0].ciphertext,
            large.ciphertext
        );
        // The referenced object survives a sweep even though every intent has expired.
        assert!(store.sweep_large_values([7; 16]).unwrap().held_lease);
        assert_eq!(
            store.list_messages(&id, 1, 10).unwrap()[0].ciphertext,
            large.ciphertext
        );
    }

    #[test]
    fn an_upload_that_fails_after_its_intent_committed_is_abandoned_and_swept() {
        let kv = temporary();
        let objects = Arc::new(OutageObjects {
            inner: LocalFsObjectStore::temporary(),
            down: std::sync::atomic::AtomicBool::new(false),
        });
        let store = GroupStore::new(kv.clone(), objects.clone())
            .with_large_value_intent_ttl(std::time::Duration::ZERO);
        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        // The namespace is claimed while the store is up; the outage starts after that, so
        // the append commits its intent and then fails the upload.
        store.large_values().claim_namespace().unwrap();
        objects
            .down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let (write_sk, _) = keypair(42);
        let large = large_message(&id, 1, INLINE_LIMIT + 1, &write_sk);
        assert!(matches!(
            store.put_message(&id, large.clone()),
            Err(GroupError::LargeValue(LargeValueError::Unavailable(_)))
        ));
        let group_id = parse_group_id_hex(&id).unwrap();
        assert!(kv.get(&seq_key(&group_id)).unwrap().is_none());
        let intents = [GROUP_LARGE_VALUE_PREFIX, b"int:".as_slice()].concat();
        assert_eq!(kv.scan_prefix_range(&intents, None, 10).unwrap().len(), 1);
        assert!(store.large_values().references(10).unwrap().is_empty());

        objects
            .down
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // The abandoned intent is expired: the sweep removes it (and any object that landed).
        assert_eq!(store.sweep_large_values([7; 16]).unwrap().deleted, 1);
        assert!(kv.scan_prefix_range(&intents, None, 10).unwrap().is_empty());
        assert_eq!(store.put_message(&id, large).unwrap().message.server_seq, 1);
        assert_eq!(object_count(objects.inner.root()), 1);
    }

    #[test]
    fn sweep_collects_an_abandoned_upload_and_never_a_referenced_ciphertext() {
        let kv = temporary();
        let objects = Arc::new(LocalFsObjectStore::temporary());
        let store = GroupStore::new(kv.clone(), objects.clone())
            .with_large_value_intent_ttl(std::time::Duration::ZERO);
        // A store with no group state is left untouched, not initialized.
        assert_eq!(
            store.sweep_large_values([7; 16]).unwrap(),
            SweepReport::default()
        );
        assert!(kv.scan_prefix_range(b"", None, 1).unwrap().is_empty());

        let initial = root_frame(3, 0, &"00".repeat(32));
        let id = initial.group_id.clone();
        store.put_epoch(&id, initial).unwrap();
        let (write_sk, _) = keypair(42);
        let kept = large_message(&id, 1, 200 * 1024, &write_sk);
        store.put_message(&id, kept.clone()).unwrap();
        // A writer that uploaded and then died before its commit.
        let orphan = store.large_values().stage(&vec![5u8; 100 * 1024]).unwrap();
        // A second writer of the referenced content that died before its commit: its own
        // upload, deleted without touching the referenced one.
        store
            .large_values()
            .stage(&hex::decode(&kept.ciphertext).unwrap())
            .unwrap();
        assert_eq!(object_count(objects.root()), 3);

        let report = store.sweep_large_values([7; 16]).unwrap();
        assert_eq!((report.deleted, report.kept_referenced), (2, 0));
        assert!(!objects
            .contains(&store.large_values().object_key(&orphan.reference))
            .unwrap());
        assert_eq!(object_count(objects.root()), 1);
        assert_eq!(
            store.list_messages(&id, 0, 10).unwrap()[0].ciphertext,
            kept.ciphertext
        );
        // A retried append is answered from the row before anything is uploaded.
        assert!(!store.put_message(&id, kept.clone()).unwrap().appended);
        assert_eq!(object_count(objects.root()), 1);
        // Another replica's sweeper cannot take the lease while it is held.
        assert!(!store.sweep_large_values([8; 16]).unwrap().held_lease);
    }

    #[test]
    fn mirrored_large_messages_are_stored_by_reference() {
        let upstream = GroupStore::new_temporary();
        let objects = Arc::new(LocalFsObjectStore::temporary());
        let home = GroupStore::new(temporary(), objects.clone());
        let initial = root_frame(3, 0, &"00".repeat(32)).normalized().unwrap();
        let id = initial.group_id.clone();
        upstream.put_epoch(&id, initial.clone()).unwrap();
        let (write_sk, _) = keypair(42);
        upstream
            .put_message(&id, large_message(&id, 1, 300 * 1024, &write_sk))
            .unwrap();
        let synced = upstream.list_messages(&id, 0, 10).unwrap();
        assert_eq!(
            home.ingest_mirrored_upstream(&id, Some(initial.clone()), &synced)
                .unwrap(),
            1
        );
        // Re-ingesting the same batch replaces the row with a new upload; the replaced
        // upload's reference is dropped and the sweep collects it, leaving one object.
        assert_eq!(
            home.ingest_mirrored_upstream(&id, Some(initial), &synced)
                .unwrap(),
            1
        );
        assert_eq!(home.large_values().references(10).unwrap().len(), 1);
        assert_eq!(object_count(objects.root()), 2);
        assert_eq!(home.sweep_large_values([7; 16]).unwrap().deleted, 1);
        assert_eq!(object_count(objects.root()), 1);
        assert_eq!(home.list_messages(&id, 0, 10).unwrap(), synced);
    }
}
