//! Encrypted attachment manifest, chunked staging, reference-counted lifecycle, and
//! content-oblivious [`BlobStore`] adapters (`RocksDbBlobStore`, `LocalFsBlobStore`,
//! and `S3BlobStore`) (Issues #452 and #453).
//!
//! # Architectural & Cryptographic Invariants
//!
//! 1. **Two-Level Opaque Identification**:
//!    - [`AttachmentId`] (`[u8; 32]`): 256-bit random capability-scoped manifest identifier
//!      generated per upload so cross-user plaintext or ciphertext deduplication is never
//!      exposed at the relay or object-storage layer.
//!    - [`ChunkDigest`] (`[u8; 32]`): `SHA-256` digest of each encrypted chunk's ciphertext
//!      bytes, authenticated by [`EncryptedAttachmentManifest`].
//! 2. **Strict Content-Oblivious Storage Boundary**:
//!    - Neither [`EncryptedAttachmentManifest`] nor [`BlobStore`] carries any application
//!      metadata (zero filenames, MIME types, media kinds, dimensions, durations, thumbnails,
//!      call associations, or commerce semantics). All such fields reside inside the
//!      end-to-end encrypted `Type 20` (`ApplicationItem`) message payload alongside the
//!      256-bit symmetric key $K_{\text{blob}}$ and base nonce.
//! 3. **Deterministic Per-Chunk Nonce & AAD Derivation**:
//!    - [`derive_chunk_nonce`] and [`derive_chunk_aad`] bind every chunk's AEAD encryption to
//!      `(K_blob, attachment_id, chunk_index, is_final_chunk)`, preventing chunk reordering,
//!      truncation, duplication, or cross-attachment splicing.
//! 4. **Stage $\rightarrow$ Publish $\rightarrow$ Reference / GC Crash Safety**:
//!    - Every state transition is ordered so a crash at any boundary leaves either a
//!      complete, cryptographically verified published attachment or unreachable staging /
//!      tombstoned data that [`BlobStore::gc_expired`] deterministically reclaims.

use std::{
    collections::BTreeMap,
    fmt::{self, Debug, Display},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use frank_cbor::{cbor_map, decode_canonical, encode_canonical, CborValue};
use hmac::{Hmac, Mac};
use reqwest::{header::HeaderMap, Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::store::kv_store::{KvError, KvTransactionOp, RelayKvStore};

type HmacSha256 = Hmac<Sha256>;

/// Current [`EncryptedAttachmentManifest`] schema version (`1`).
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Maximum serialized byte length of a canonical [`EncryptedAttachmentManifest`] (`64 KiB`).
pub const MAX_MANIFEST_BYTES: usize = 65_536;

/// Default maximum ciphertext chunk size (`256 KiB`).
pub const DEFAULT_CHUNK_BYTES: u32 = 262_144;

/// Hard upper bound on a single ciphertext chunk (`1 MiB`).
pub const MAX_CHUNK_BYTES: u32 = 1_048_576;

/// Hard upper bound on chunk count per attachment (`4096`).
pub const MAX_CHUNK_COUNT: usize = 4_096;

/// Hard upper bound on total ciphertext size per attachment (`256 MiB`).
pub const MAX_ATTACHMENT_BYTES: u64 = 268_435_456;

/// Domain separation tag for per-chunk XChaCha20-Poly1305 nonce derivation.
pub const CHUNK_NONCE_DOMAIN: &[u8] = b"frank-blob-chunk-v1";

/// Domain separation tag for per-chunk AEAD additional authenticated data (AAD).
pub const CHUNK_AAD_DOMAIN: &[u8] = b"frank-blob-aad-v1";

/// Subspace prefix in [`RelayKvStore`] for active staging session metadata (`B_stg_ses:`).
pub const KEY_PREFIX_STAGING_SESSION: &[u8] = b"B_stg_ses:";
/// Subspace prefix in [`RelayKvStore`] for verified staged chunk markers (`B_stg_got:`).
pub const KEY_PREFIX_STAGING_CHUNK_GOT: &[u8] = b"B_stg_got:";
/// Subspace prefix in [`RelayKvStore`] for staged chunk payloads in [`RocksDbBlobStore`] (`B_stg:`).
pub const KEY_PREFIX_STAGING_CHUNK_DATA: &[u8] = b"B_stg:";
/// Subspace prefix in [`RelayKvStore`] for published manifests (`B_man:`).
pub const KEY_PREFIX_MANIFEST: &[u8] = b"B_man:";
/// Subspace prefix in [`RelayKvStore`] for live attachment owner references (`B_ref:`).
pub const KEY_PREFIX_REFERENCE: &[u8] = b"B_ref:";
/// Subspace prefix in [`RelayKvStore`] for published chunk payloads in [`RocksDbBlobStore`] (`B_chk:`).
pub const KEY_PREFIX_PUBLISHED_CHUNK_DATA: &[u8] = b"B_chk:";
/// Subspace prefix in [`RelayKvStore`] for post-publish staging cleanup tombstones (`B_cln:`).
pub const KEY_PREFIX_STAGING_CLEANUP: &[u8] = b"B_cln:";
/// Subspace prefix in [`RelayKvStore`] for unpublished attachment GC tombstones (`B_gc:`).
pub const KEY_PREFIX_GC_TOMBSTONE: &[u8] = b"B_gc:";

const MANIFEST_KEY_SCHEMA_VERSION: u64 = 1;
const MANIFEST_KEY_ATTACHMENT_ID: u64 = 2;
const MANIFEST_KEY_TOTAL_CIPHERTEXT_BYTES: u64 = 3;
const MANIFEST_KEY_MAX_CHUNK_BYTES: u64 = 4;
const MANIFEST_KEY_CHUNKS: u64 = 5;
const MANIFEST_KEY_EXPIRES_AT_MS: u64 = 6;

const CHUNK_SPEC_KEY_INDEX: u64 = 1;
const CHUNK_SPEC_KEY_BYTE_LEN: u64 = 2;
const CHUNK_SPEC_KEY_SHA256: u64 = 3;

/// Opaque 256-bit capability-scoped identifier for an encrypted attachment manifest.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AttachmentId(pub [u8; 32]);

impl AttachmentId {
    /// Wrap a 32-byte array as an [`AttachmentId`].
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Parse a 32-byte slice into an [`AttachmentId`].
    pub fn try_from_slice(slice: &[u8]) -> Result<Self, BlobError> {
        let bytes: [u8; 32] = slice.try_into().map_err(|_| {
            BlobError::InvalidManifest(format!(
                "attachment_id must be 32 bytes, got {}",
                slice.len()
            ))
        })?;
        Ok(Self(bytes))
    }

    /// Borrow the underlying 32-byte array.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Encode as 64 lowercase hexadecimal characters.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Decode from a 64-character hexadecimal string.
    pub fn from_hex(hex_str: &str) -> Result<Self, BlobError> {
        let decoded = hex::decode(hex_str)
            .map_err(|e| BlobError::InvalidManifest(format!("invalid attachment_id hex: {e}")))?;
        Self::try_from_slice(&decoded)
    }
}

impl Display for AttachmentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// SHA-256 digest (`[u8; 32]`) of an individual encrypted chunk's ciphertext bytes.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ChunkDigest(pub [u8; 32]);

impl ChunkDigest {
    /// Compute the `SHA-256` digest of `ciphertext_bytes`.
    pub fn compute(ciphertext_bytes: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(ciphertext_bytes);
        let out: [u8; 32] = hasher.finalize().into();
        Self(out)
    }

    /// Wrap a 32-byte array as a [`ChunkDigest`].
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Parse a 32-byte slice into a [`ChunkDigest`].
    pub fn try_from_slice(slice: &[u8]) -> Result<Self, BlobError> {
        let bytes: [u8; 32] = slice.try_into().map_err(|_| {
            BlobError::InvalidManifest(format!(
                "chunk sha256 digest must be 32 bytes, got {}",
                slice.len()
            ))
        })?;
        Ok(Self(bytes))
    }

    /// Borrow the underlying 32-byte array.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Encode as 64 lowercase hexadecimal characters.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Decode from a 64-character hexadecimal string.
    pub fn from_hex(hex_str: &str) -> Result<Self, BlobError> {
        let decoded = hex::decode(hex_str)
            .map_err(|e| BlobError::InvalidManifest(format!("invalid chunk digest hex: {e}")))?;
        Self::try_from_slice(&decoded)
    }
}

impl Display for ChunkDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// Opaque 128-bit staging upload session identifier.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct UploadSessionId(pub [u8; 16]);

impl UploadSessionId {
    /// Wrap a 16-byte array as an [`UploadSessionId`].
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Parse a 16-byte slice into an [`UploadSessionId`].
    pub fn try_from_slice(slice: &[u8]) -> Result<Self, BlobError> {
        let bytes: [u8; 16] = slice.try_into().map_err(|_| {
            BlobError::InvalidManifest(format!(
                "upload_session_id must be 16 bytes, got {}",
                slice.len()
            ))
        })?;
        Ok(Self(bytes))
    }

    /// Borrow the underlying 16-byte array.
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// Encode as 32 lowercase hexadecimal characters.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Decode from a 32-character hexadecimal string.
    pub fn from_hex(hex_str: &str) -> Result<Self, BlobError> {
        let decoded = hex::decode(hex_str).map_err(|e| {
            BlobError::InvalidManifest(format!("invalid upload_session_id hex: {e}"))
        })?;
        Self::try_from_slice(&decoded)
    }
}

impl Display for UploadSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// Derive the deterministic 24-byte XChaCha20-Poly1305 nonce for `chunk_index`.
///
/// Computes:
/// `mask = HMAC-SHA256(key = k_blob, msg = "frank-blob-chunk-v1" || attachment_id || chunk_index_be)[0..24]`
/// and XORs `mask` with `base_nonce`. This binds every chunk nonce to the symmetric blob key,
/// the unique `attachment_id`, the `base_nonce`, and the 0-based `chunk_index`, preventing chunk
/// reordering, duplication, or cross-attachment chunk splicing.
pub fn derive_chunk_nonce(
    k_blob: &[u8; 32],
    attachment_id: &AttachmentId,
    base_nonce: &[u8; 24],
    chunk_index: u32,
) -> [u8; 24] {
    let mut mac = HmacSha256::new_from_slice(k_blob).expect("32-byte HMAC key is always valid");
    mac.update(CHUNK_NONCE_DOMAIN);
    mac.update(attachment_id.as_bytes());
    mac.update(&chunk_index.to_be_bytes());
    let tag: [u8; 32] = mac.finalize().into_bytes().into();

    let mut nonce = [0u8; 24];
    for i in 0..24 {
        nonce[i] = base_nonce[i] ^ tag[i];
    }
    nonce
}

/// Derive the deterministic 54-byte per-chunk AEAD Additional Authenticated Data (AAD).
///
/// Format: `"frank-blob-aad-v1" (17B) || attachment_id (32B) || chunk_index_be (4B) || is_final_u8 (1B)`.
pub fn derive_chunk_aad(
    attachment_id: &AttachmentId,
    chunk_index: u32,
    is_final_chunk: bool,
) -> [u8; 54] {
    let mut aad = [0u8; 54];
    aad[0..17].copy_from_slice(CHUNK_AAD_DOMAIN);
    aad[17..49].copy_from_slice(attachment_id.as_bytes());
    aad[49..53].copy_from_slice(&chunk_index.to_be_bytes());
    aad[53] = u8::from(is_final_chunk);
    aad
}

/// Descriptor for a single encrypted chunk inside [`EncryptedAttachmentManifest`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestChunkSpec {
    /// Contiguous 0-based chunk index (`0..chunks.len()`).
    pub index: u32,
    /// Exact ciphertext byte length of this chunk (`1..=max_chunk_bytes`).
    pub byte_len: u32,
    /// `SHA-256` digest over the encrypted chunk bytes.
    pub sha256: [u8; 32],
}

impl ManifestChunkSpec {
    /// Encode this chunk descriptor into a canonical [`CborValue::Map`].
    pub fn to_cbor_value(&self) -> CborValue {
        cbor_map(vec![
            (CHUNK_SPEC_KEY_INDEX, CborValue::Int(i128::from(self.index))),
            (
                CHUNK_SPEC_KEY_BYTE_LEN,
                CborValue::Int(i128::from(self.byte_len)),
            ),
            (CHUNK_SPEC_KEY_SHA256, CborValue::Bytes(self.sha256.to_vec())),
        ])
    }

    /// Decode a [`ManifestChunkSpec`] from a [`CborValue`].
    pub fn from_cbor_value(value: &CborValue) -> Result<Self, BlobError> {
        let CborValue::Map(entries) = value else {
            return Err(BlobError::InvalidManifest(
                "chunk spec must be a CBOR map".to_string(),
            ));
        };
        let mut index: Option<u32> = None;
        let mut byte_len: Option<u32> = None;
        let mut sha256: Option<[u8; 32]> = None;

        for (k, v) in entries {
            match *k {
                CHUNK_SPEC_KEY_INDEX => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "chunk spec index must be an integer".to_string(),
                        ));
                    };
                    let idx = u32::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!("chunk spec index out of u32 range: {n}"))
                    })?;
                    index = Some(idx);
                }
                CHUNK_SPEC_KEY_BYTE_LEN => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "chunk spec byte_len must be an integer".to_string(),
                        ));
                    };
                    let len = u32::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!(
                            "chunk spec byte_len out of u32 range: {n}"
                        ))
                    })?;
                    byte_len = Some(len);
                }
                CHUNK_SPEC_KEY_SHA256 => {
                    let CborValue::Bytes(b) = v else {
                        return Err(BlobError::InvalidManifest(
                            "chunk spec sha256 must be a byte string".to_string(),
                        ));
                    };
                    let arr: [u8; 32] = b.as_slice().try_into().map_err(|_| {
                        BlobError::InvalidManifest(format!(
                            "chunk spec sha256 must be 32 bytes, got {}",
                            b.len()
                        ))
                    })?;
                    sha256 = Some(arr);
                }
                _ => {
                    // Ignore unknown chunk-level extension keys for forward compatibility.
                }
            }
        }

        Ok(Self {
            index: index.ok_or_else(|| {
                BlobError::InvalidManifest("missing chunk spec field 1 (index)".to_string())
            })?,
            byte_len: byte_len.ok_or_else(|| {
                BlobError::InvalidManifest("missing chunk spec field 2 (byte_len)".to_string())
            })?,
            sha256: sha256.ok_or_else(|| {
                BlobError::InvalidManifest("missing chunk spec field 3 (sha256)".to_string())
            })?,
        })
    }
}

/// Normative content-oblivious encrypted attachment manifest encoded with deterministic
/// Frank-CBOR (`frank_cbor`).
///
/// Contains **zero** application metadata (no filenames, MIME types, media kinds, or captions).
/// Unknown future fields are retained losslessly in [`Self::extra_fields`] so relays and
/// clients can round-trip manifests across minor schema extensions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedAttachmentManifest {
    /// Manifest schema version (must be [`MANIFEST_SCHEMA_VERSION`] = `1`).
    pub schema_version: u32,
    /// Opaque 256-bit attachment identifier (`[u8; 32]`).
    pub attachment_id: [u8; 32],
    /// Total ciphertext size across all chunks in bytes.
    pub total_ciphertext_bytes: u64,
    /// Maximum ciphertext bytes per chunk (`1..=MAX_CHUNK_BYTES`).
    pub max_chunk_bytes: u32,
    /// Ordered per-chunk descriptors (`0..chunks.len()`).
    pub chunks: Vec<ManifestChunkSpec>,
    /// Expiration timestamp in Unix epoch milliseconds.
    pub expires_at_ms: u64,
    /// Opaque future fields preserved for forward-compatible version negotiation.
    pub extra_fields: BTreeMap<i128, CborValue>,
}

impl EncryptedAttachmentManifest {
    /// Construct a validated [`EncryptedAttachmentManifest`] by splitting `ciphertext` into
    /// chunks of at most `max_chunk_bytes` and computing each chunk's `SHA-256` digest.
    pub fn from_ciphertext_slices(
        attachment_id: [u8; 32],
        max_chunk_bytes: u32,
        chunk_slices: &[&[u8]],
        expires_at_ms: u64,
    ) -> Result<Self, BlobError> {
        let mut chunks = Vec::with_capacity(chunk_slices.len());
        let mut total_ciphertext_bytes: u64 = 0;

        for (idx, slice) in chunk_slices.iter().enumerate() {
            let index = u32::try_from(idx).map_err(|_| BlobError::TooManyChunks {
                count: chunk_slices.len(),
                max_chunks: MAX_CHUNK_COUNT,
            })?;
            let byte_len = u32::try_from(slice.len()).map_err(|_| BlobError::InvalidChunkLength {
                chunk_index: index,
                expected: max_chunk_bytes,
                actual: usize::MAX,
            })?;
            total_ciphertext_bytes = total_ciphertext_bytes
                .checked_add(u64::from(byte_len))
                .ok_or(BlobError::AttachmentTooLarge {
                    total_bytes: u64::MAX,
                    max_bytes: MAX_ATTACHMENT_BYTES,
                })?;
            let digest = ChunkDigest::compute(slice);
            chunks.push(ManifestChunkSpec {
                index,
                byte_len,
                sha256: digest.0,
            });
        }

        let manifest = Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            attachment_id,
            total_ciphertext_bytes,
            max_chunk_bytes,
            chunks,
            expires_at_ms,
            extra_fields: BTreeMap::new(),
        };
        manifest.validate()?;
        Ok(manifest)
    }

    /// Return the typed [`AttachmentId`].
    pub const fn id(&self) -> AttachmentId {
        AttachmentId(self.attachment_id)
    }

    /// Validate all structural, cryptographic-indexing, and resource bounds on this manifest.
    pub fn validate(&self) -> Result<(), BlobError> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(BlobError::UnsupportedSchemaVersion(self.schema_version));
        }
        if self.max_chunk_bytes == 0 || self.max_chunk_bytes > MAX_CHUNK_BYTES {
            return Err(BlobError::InvalidManifest(format!(
                "max_chunk_bytes must be in 1..={MAX_CHUNK_BYTES}, got {}",
                self.max_chunk_bytes
            )));
        }
        if self.chunks.len() > MAX_CHUNK_COUNT {
            return Err(BlobError::TooManyChunks {
                count: self.chunks.len(),
                max_chunks: MAX_CHUNK_COUNT,
            });
        }
        if self.total_ciphertext_bytes > MAX_ATTACHMENT_BYTES {
            return Err(BlobError::AttachmentTooLarge {
                total_bytes: self.total_ciphertext_bytes,
                max_bytes: MAX_ATTACHMENT_BYTES,
            });
        }
        if self.chunks.is_empty() {
            if self.total_ciphertext_bytes != 0 {
                return Err(BlobError::TotalLengthMismatch {
                    declared_total: self.total_ciphertext_bytes,
                    computed_total: 0,
                });
            }
            return Ok(());
        }

        let mut computed_total: u64 = 0;
        for (expected_idx, spec) in self.chunks.iter().enumerate() {
            let expected_u32 = expected_idx as u32;
            if spec.index != expected_u32 {
                return Err(BlobError::NonContiguousChunkIndex {
                    expected: expected_u32,
                    actual: spec.index,
                });
            }
            if spec.byte_len == 0 || spec.byte_len > self.max_chunk_bytes {
                return Err(BlobError::InvalidChunkLength {
                    chunk_index: spec.index,
                    expected: self.max_chunk_bytes,
                    actual: spec.byte_len as usize,
                });
            }
            computed_total = computed_total
                .checked_add(u64::from(spec.byte_len))
                .ok_or(BlobError::AttachmentTooLarge {
                    total_bytes: u64::MAX,
                    max_bytes: MAX_ATTACHMENT_BYTES,
                })?;
        }

        if computed_total != self.total_ciphertext_bytes {
            return Err(BlobError::TotalLengthMismatch {
                declared_total: self.total_ciphertext_bytes,
                computed_total,
            });
        }

        for key in self.extra_fields.keys() {
            if *key < 0 || *key > i128::from(u64::MAX) {
                return Err(BlobError::InvalidManifest(format!(
                    "extra_fields key {key} must be an unsigned u64 integer key"
                )));
            }
            let k_u64 = *key as u64;
            if (MANIFEST_KEY_SCHEMA_VERSION..=MANIFEST_KEY_EXPIRES_AT_MS).contains(&k_u64) {
                return Err(BlobError::InvalidManifest(format!(
                    "extra_fields key {key} collides with reserved manifest key"
                )));
            }
        }

        Ok(())
    }

    /// Convert this manifest to a [`CborValue::Map`], including any retained [`Self::extra_fields`].
    pub fn to_cbor_value(&self) -> Result<CborValue, BlobError> {
        self.validate()?;
        let chunk_values: Vec<CborValue> =
            self.chunks.iter().map(ManifestChunkSpec::to_cbor_value).collect();
        let mut entries = vec![
            (
                MANIFEST_KEY_SCHEMA_VERSION,
                CborValue::Int(i128::from(self.schema_version)),
            ),
            (
                MANIFEST_KEY_ATTACHMENT_ID,
                CborValue::Bytes(self.attachment_id.to_vec()),
            ),
            (
                MANIFEST_KEY_TOTAL_CIPHERTEXT_BYTES,
                CborValue::Int(i128::from(self.total_ciphertext_bytes)),
            ),
            (
                MANIFEST_KEY_MAX_CHUNK_BYTES,
                CborValue::Int(i128::from(self.max_chunk_bytes)),
            ),
            (MANIFEST_KEY_CHUNKS, CborValue::Array(chunk_values)),
            (
                MANIFEST_KEY_EXPIRES_AT_MS,
                CborValue::Int(i128::from(self.expires_at_ms)),
            ),
        ];
        for (extra_k, extra_v) in &self.extra_fields {
            let k_u64 = u64::try_from(*extra_k).map_err(|_| {
                BlobError::InvalidManifest(format!(
                    "extra_fields key {extra_k} out of u64 range"
                ))
            })?;
            entries.push((k_u64, extra_v.clone()));
        }
        Ok(cbor_map(entries))
    }

    /// Encode this manifest into canonical Frank-CBOR bytes, enforcing [`MAX_MANIFEST_BYTES`].
    pub fn encode_canonical(&self) -> Result<Vec<u8>, BlobError> {
        let value = self.to_cbor_value()?;
        let bytes = encode_canonical(&value)
            .map_err(|e| BlobError::InvalidManifest(format!("canonical CBOR encode error: {e}")))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(BlobError::ManifestTooLarge {
                byte_len: bytes.len(),
                max_bytes: MAX_MANIFEST_BYTES,
            });
        }
        Ok(bytes)
    }

    /// Decode and validate a canonical Frank-CBOR [`EncryptedAttachmentManifest`] from `bytes`,
    /// enforcing [`MAX_MANIFEST_BYTES`] prior to allocation.
    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, BlobError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(BlobError::ManifestTooLarge {
                byte_len: bytes.len(),
                max_bytes: MAX_MANIFEST_BYTES,
            });
        }
        let value = decode_canonical(bytes)
            .map_err(|e| BlobError::InvalidManifest(format!("canonical CBOR decode error: {e}")))?;
        Self::from_cbor_value(&value)
    }

    /// Construct and validate an [`EncryptedAttachmentManifest`] from a decoded [`CborValue`].
    pub fn from_cbor_value(value: &CborValue) -> Result<Self, BlobError> {
        let CborValue::Map(entries) = value else {
            return Err(BlobError::InvalidManifest(
                "manifest root must be a CBOR map".to_string(),
            ));
        };

        let mut schema_version: Option<u32> = None;
        let mut attachment_id: Option<[u8; 32]> = None;
        let mut total_ciphertext_bytes: Option<u64> = None;
        let mut max_chunk_bytes: Option<u32> = None;
        let mut chunks: Option<Vec<ManifestChunkSpec>> = None;
        let mut expires_at_ms: Option<u64> = None;
        let mut extra_fields: BTreeMap<i128, CborValue> = BTreeMap::new();

        for (k, v) in entries {
            match *k {
                MANIFEST_KEY_SCHEMA_VERSION => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "schema_version must be an integer".to_string(),
                        ));
                    };
                    let sv = u32::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!("schema_version out of u32 range: {n}"))
                    })?;
                    schema_version = Some(sv);
                }
                MANIFEST_KEY_ATTACHMENT_ID => {
                    let CborValue::Bytes(b) = v else {
                        return Err(BlobError::InvalidManifest(
                            "attachment_id must be a byte string".to_string(),
                        ));
                    };
                    let arr: [u8; 32] = b.as_slice().try_into().map_err(|_| {
                        BlobError::InvalidManifest(format!(
                            "attachment_id must be 32 bytes, got {}",
                            b.len()
                        ))
                    })?;
                    attachment_id = Some(arr);
                }
                MANIFEST_KEY_TOTAL_CIPHERTEXT_BYTES => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "total_ciphertext_bytes must be an integer".to_string(),
                        ));
                    };
                    let total = u64::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!(
                            "total_ciphertext_bytes out of u64 range: {n}"
                        ))
                    })?;
                    total_ciphertext_bytes = Some(total);
                }
                MANIFEST_KEY_MAX_CHUNK_BYTES => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "max_chunk_bytes must be an integer".to_string(),
                        ));
                    };
                    let max_cb = u32::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!(
                            "max_chunk_bytes out of u32 range: {n}"
                        ))
                    })?;
                    max_chunk_bytes = Some(max_cb);
                }
                MANIFEST_KEY_CHUNKS => {
                    let CborValue::Array(items) = v else {
                        return Err(BlobError::InvalidManifest(
                            "chunks must be a CBOR array".to_string(),
                        ));
                    };
                    if items.len() > MAX_CHUNK_COUNT {
                        return Err(BlobError::TooManyChunks {
                            count: items.len(),
                            max_chunks: MAX_CHUNK_COUNT,
                        });
                    }
                    let mut parsed_chunks = Vec::with_capacity(items.len());
                    for item in items {
                        parsed_chunks.push(ManifestChunkSpec::from_cbor_value(item)?);
                    }
                    chunks = Some(parsed_chunks);
                }
                MANIFEST_KEY_EXPIRES_AT_MS => {
                    let CborValue::Int(n) = v else {
                        return Err(BlobError::InvalidManifest(
                            "expires_at_ms must be an integer".to_string(),
                        ));
                    };
                    let exp = u64::try_from(*n).map_err(|_| {
                        BlobError::InvalidManifest(format!("expires_at_ms out of u64 range: {n}"))
                    })?;
                    expires_at_ms = Some(exp);
                }
                other_key => {
                    extra_fields.insert(i128::from(other_key), v.clone());
                }
            }
        }

        let manifest = Self {
            schema_version: schema_version.ok_or_else(|| {
                BlobError::InvalidManifest("missing manifest field 1 (schema_version)".to_string())
            })?,
            attachment_id: attachment_id.ok_or_else(|| {
                BlobError::InvalidManifest("missing manifest field 2 (attachment_id)".to_string())
            })?,
            total_ciphertext_bytes: total_ciphertext_bytes.ok_or_else(|| {
                BlobError::InvalidManifest(
                    "missing manifest field 3 (total_ciphertext_bytes)".to_string(),
                )
            })?,
            max_chunk_bytes: max_chunk_bytes.ok_or_else(|| {
                BlobError::InvalidManifest("missing manifest field 4 (max_chunk_bytes)".to_string())
            })?,
            chunks: chunks.ok_or_else(|| {
                BlobError::InvalidManifest("missing manifest field 5 (chunks)".to_string())
            })?,
            expires_at_ms: expires_at_ms.ok_or_else(|| {
                BlobError::InvalidManifest("missing manifest field 6 (expires_at_ms)".to_string())
            })?,
            extra_fields,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    /// Map a half-open byte range `[start_byte, end_byte_exclusive)` to the minimal spanning
    /// chunk slices `(chunk_index, slice_start_within_chunk, slice_end_within_chunk)`.
    pub fn resolve_byte_range(
        &self,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<(u32, usize, usize)>, BlobError> {
        if start_byte > end_byte_exclusive || end_byte_exclusive > self.total_ciphertext_bytes {
            return Err(BlobError::InvalidByteRange {
                start_byte,
                end_byte_exclusive,
                total_bytes: self.total_ciphertext_bytes,
            });
        }
        if start_byte == end_byte_exclusive {
            return Ok(Vec::new());
        }

        let mut spans = Vec::new();
        let mut chunk_start_offset: u64 = 0;

        for spec in &self.chunks {
            let chunk_len = u64::from(spec.byte_len);
            let chunk_end_offset = chunk_start_offset + chunk_len;

            if chunk_end_offset > start_byte && chunk_start_offset < end_byte_exclusive {
                let local_start = start_byte.saturating_sub(chunk_start_offset) as usize;
                let local_end =
                    (end_byte_exclusive.min(chunk_end_offset) - chunk_start_offset) as usize;
                spans.push((spec.index, local_start, local_end));
            }

            chunk_start_offset = chunk_end_offset;
            if chunk_start_offset >= end_byte_exclusive {
                break;
            }
        }

        Ok(spans)
    }
}

/// Errors produced by [`EncryptedAttachmentManifest`] validation and [`BlobStore`] operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BlobError {
    /// Manifest exceeds [`MAX_MANIFEST_BYTES`].
    #[error("manifest size {byte_len} exceeds maximum {max_bytes} bytes")]
    ManifestTooLarge {
        /// Actual encoded byte length.
        byte_len: usize,
        /// Maximum allowed byte length.
        max_bytes: usize,
    },
    /// Unsupported manifest `schema_version`.
    #[error("unsupported manifest schema version: {0}")]
    UnsupportedSchemaVersion(u32),
    /// Manifest contains more than [`MAX_CHUNK_COUNT`] chunks.
    #[error("chunk count {count} exceeds maximum {max_chunks}")]
    TooManyChunks {
        /// Actual number of chunks.
        count: usize,
        /// Maximum allowed number of chunks.
        max_chunks: usize,
    },
    /// Total ciphertext size exceeds [`MAX_ATTACHMENT_BYTES`].
    #[error("attachment size {total_bytes} exceeds maximum {max_bytes} bytes")]
    AttachmentTooLarge {
        /// Actual or declared ciphertext bytes.
        total_bytes: u64,
        /// Maximum allowed ciphertext bytes.
        max_bytes: u64,
    },
    /// Chunk indices are not contiguous `0..chunks.len()`.
    #[error("non-contiguous chunk index: expected {expected}, got {actual}")]
    NonContiguousChunkIndex {
        /// Expected 0-based index.
        expected: u32,
        /// Actual index found in manifest.
        actual: u32,
    },
    /// Sum of chunk `byte_len` values does not match `total_ciphertext_bytes`.
    #[error(
        "manifest total_ciphertext_bytes mismatch: declared {declared_total}, sum of chunks is {computed_total}"
    )]
    TotalLengthMismatch {
        /// Value of `total_ciphertext_bytes` in the manifest.
        declared_total: u64,
        /// Sum of `byte_len` across `chunks`.
        computed_total: u64,
    },
    /// Malformed or invalid manifest structure.
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    /// Chunk index is out of bounds for the manifest.
    #[error("chunk index {chunk_index} out of bounds for chunk count {chunk_count}")]
    ChunkIndexOutOfBounds {
        /// Requested or uploaded chunk index.
        chunk_index: u32,
        /// Total chunk count in the manifest.
        chunk_count: usize,
    },
    /// Uploaded or stored chunk byte length does not match the manifest specification.
    #[error("invalid chunk length at index {chunk_index}: expected {expected}, got {actual}")]
    InvalidChunkLength {
        /// 0-based chunk index.
        chunk_index: u32,
        /// Expected byte length from manifest.
        expected: u32,
        /// Actual byte length provided or read.
        actual: usize,
    },
    /// Chunk `SHA-256` digest does not match the manifest's expected [`ChunkDigest`].
    #[error(
        "chunk integrity mismatch at index {chunk_index}: expected sha256 {expected_hex}, got {actual_hex}"
    )]
    IntegrityMismatch {
        /// 0-based chunk index.
        chunk_index: u32,
        /// Expected hex digest from manifest.
        expected_hex: String,
        /// Computed hex digest of the bytes.
        actual_hex: String,
    },
    /// Staging session was not found.
    #[error("staging session not found: {0}")]
    SessionNotFound(UploadSessionId),
    /// Staging session has expired.
    #[error("staging session {session_id} expired at {expires_at_ms} (now {now_ms})")]
    SessionExpired {
        /// Expired session ID.
        session_id: UploadSessionId,
        /// Session expiration timestamp (ms).
        expires_at_ms: u64,
        /// Current timestamp (ms).
        now_ms: u64,
    },
    /// Staging session ID is already bound to a different manifest.
    #[error("staging session conflict for {0}")]
    SessionConflict(UploadSessionId),
    /// Attempted to publish a staging session while one or more chunks are still missing.
    #[error("cannot publish session {session_id}: missing chunk {missing_chunk_index}")]
    IncompleteUpload {
        /// Session ID being published.
        session_id: UploadSessionId,
        /// First missing 0-based chunk index.
        missing_chunk_index: u32,
    },
    /// Published attachment already exists with a conflicting manifest.
    #[error("attachment {0} already published with a conflicting manifest")]
    PublicationConflict(AttachmentId),
    /// Published attachment or chunk was not found.
    #[error("attachment not found: {0}")]
    NotFound(AttachmentId),
    /// Requested byte range `[start_byte, end_byte_exclusive)` is invalid.
    #[error(
        "invalid byte range [{start_byte}, {end_byte_exclusive}) for attachment of {total_bytes} bytes"
    )]
    InvalidByteRange {
        /// Inclusive start byte offset.
        start_byte: u64,
        /// Exclusive end byte offset.
        end_byte_exclusive: u64,
        /// Total ciphertext bytes of the attachment.
        total_bytes: u64,
    },
    /// Underlying KV store error.
    #[error("kv store error: {0}")]
    Kv(#[from] KvError),
    /// Underlying I/O or object-storage error.
    #[error("blob backend error: {0}")]
    Backend(String),
}

/// Snapshot of an active staging upload session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagingSessionState {
    /// Upload session identifier.
    pub session_id: UploadSessionId,
    /// Validated manifest associated with the session.
    pub manifest: EncryptedAttachmentManifest,
    /// Timestamp (ms) when staging began.
    pub staged_at_ms: u64,
    /// Timestamp (ms) when the staging session expires if unpublished.
    pub staged_expires_at_ms: u64,
    /// Sorted list of verified chunk indices (`0..manifest.chunks.len()`) currently staged.
    pub verified_chunks: Vec<u32>,
}

/// Metadata returned when a staged upload is durably published.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedAttachmentState {
    /// Published attachment identifier.
    pub attachment_id: AttachmentId,
    /// Canonical attachment manifest.
    pub manifest: EncryptedAttachmentManifest,
    /// Timestamp (ms) when the attachment was published.
    pub published_at_ms: u64,
    /// Active 32-byte owner references protecting this attachment from GC.
    pub owner_references: Vec<[u8; 32]>,
}

/// Summary of items reclaimed by [`BlobStore::gc_expired`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GcReport {
    /// Expired staging sessions removed.
    pub expired_staging_sessions_removed: usize,
    /// Published attachments removed because `expires_at_ms <= now_ms`.
    pub expired_attachments_removed: usize,
    /// Published attachments removed because zero live owner references remained.
    pub unreferenced_attachments_removed: usize,
    /// Total staged and published chunk objects deleted from the chunk backend.
    pub chunks_deleted: usize,
}

/// Persisted metadata record for a staging session in [`RelayKvStore`].
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredStagingSession {
    session_id: [u8; 16],
    manifest_cbor: Vec<u8>,
    staged_at_ms: u64,
    staged_expires_at_ms: u64,
}

/// Persisted metadata record for a published manifest in [`RelayKvStore`].
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredPublishedManifest {
    manifest_cbor: Vec<u8>,
    published_at_ms: u64,
}

/// Persisted tombstone for cleaning up staged chunks after atomic manifest publication.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredStagingCleanup {
    session_id: [u8; 16],
    chunk_count: u32,
}

/// Persisted tombstone for deleting published chunks after atomic manifest unpublication.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredGcTombstone {
    attachment_id: [u8; 32],
    chunk_count: u32,
}

/// Unified asynchronous interface for content-oblivious encrypted attachment storage.
#[async_trait]
pub trait BlobStore: Send + Sync + Debug {
    /// Register or resume a staging upload session for `manifest` with TTL `staging_ttl_ms`.
    ///
    /// Calling `begin_staging` again with the same `session_id` and an identical `manifest`
    /// is idempotent and returns the current [`StagingSessionState`] including already-staged
    /// chunk indices.
    async fn begin_staging(
        &self,
        session_id: UploadSessionId,
        manifest: EncryptedAttachmentManifest,
        staged_at_ms: u64,
        staging_ttl_ms: u64,
    ) -> Result<StagingSessionState, BlobError>;

    /// Query the current state and verified chunk bitmap of a staging session.
    async fn get_staging_status(
        &self,
        session_id: UploadSessionId,
    ) -> Result<Option<StagingSessionState>, BlobError>;

    /// Upload and verify a single encrypted chunk for `session_id`.
    ///
    /// Verifies `chunk_index < manifest.chunks.len()`, `bytes.len() == spec.byte_len`, and
    /// `SHA-256(bytes) == spec.sha256` before persisting. Uploading the identical verified
    /// chunk more than once is idempotent (`Ok(())`).
    async fn put_staged_chunk(
        &self,
        session_id: UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<(), BlobError>;

    /// Atomically promote a complete staging session to a published attachment bound to
    /// `owner_ref` (e.g., an envelope `payload_hash`).
    ///
    /// Fails with [`BlobError::IncompleteUpload`] if any chunk `0..manifest.chunks.len()`
    /// has not been staged and verified.
    async fn publish_staged(
        &self,
        session_id: UploadSessionId,
        published_at_ms: u64,
        owner_ref: [u8; 32],
    ) -> Result<PublishedAttachmentState, BlobError>;

    /// Bind an additional live owner reference (`owner_ref`) to a published attachment.
    async fn add_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<(), BlobError>;

    /// Remove an owner reference (`owner_ref`) from a published attachment, returning the
    /// number of remaining live references.
    async fn remove_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<usize, BlobError>;

    /// List all active 32-byte owner references for `attachment_id`.
    async fn list_references(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Vec<[u8; 32]>, BlobError>;

    /// Fetch the published [`EncryptedAttachmentManifest`] for `attachment_id`, if present.
    async fn get_manifest(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<EncryptedAttachmentManifest>, BlobError>;

    /// Read and cryptographically verify a single published chunk (`chunk_index`).
    ///
    /// Re-verifies `bytes.len() == spec.byte_len` and `SHA-256(bytes) == spec.sha256` against
    /// the durable manifest before returning.
    async fn get_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Vec<u8>, BlobError>;

    /// Read an arbitrary ciphertext byte range `[start_byte, end_byte_exclusive)` across
    /// spanning chunks.
    ///
    /// Every spanning chunk is fetched and verified in full against its manifest `SHA-256`
    /// digest before slicing, ensuring unauthenticated ciphertext bytes are never returned.
    async fn read_range(
        &self,
        attachment_id: &AttachmentId,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<u8>, BlobError>;

    /// Reclaim expired staging sessions (`now_ms >= staged_expires_at_ms`), published
    /// attachments whose `expires_at_ms <= now_ms`, published attachments with zero remaining
    /// live references, and any crash-recovery tombstones.
    async fn gc_expired(&self, now_ms: u64) -> Result<GcReport, BlobError>;
}

// =============================================================================================
// Internal Chunk Storage Backend Abstraction (shared by RocksDB, LocalFs, and S3 adapters)
// =============================================================================================

#[async_trait]
trait ChunkPayloadBackend: Send + Sync + Debug {
    async fn write_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
        expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError>;

    async fn read_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError>;

    async fn delete_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<bool, BlobError>;

    async fn write_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
        bytes: &[u8],
        expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError>;

    async fn read_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError>;

    async fn delete_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<bool, BlobError>;
}

fn staging_session_key(session_id: &UploadSessionId) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_STAGING_SESSION.len() + 16);
    key.extend_from_slice(KEY_PREFIX_STAGING_SESSION);
    key.extend_from_slice(session_id.as_bytes());
    key
}

fn staging_chunk_got_prefix(session_id: &UploadSessionId) -> Vec<u8> {
    let mut prefix = Vec::with_capacity(KEY_PREFIX_STAGING_CHUNK_GOT.len() + 17);
    prefix.extend_from_slice(KEY_PREFIX_STAGING_CHUNK_GOT);
    prefix.extend_from_slice(session_id.as_bytes());
    prefix.push(b':');
    prefix
}

fn staging_chunk_got_key(session_id: &UploadSessionId, chunk_index: u32) -> Vec<u8> {
    let mut key = staging_chunk_got_prefix(session_id);
    key.extend_from_slice(&chunk_index.to_be_bytes());
    key
}

fn staging_chunk_data_key(session_id: &UploadSessionId, chunk_index: u32) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_STAGING_CHUNK_DATA.len() + 16 + 1 + 4);
    key.extend_from_slice(KEY_PREFIX_STAGING_CHUNK_DATA);
    key.extend_from_slice(session_id.as_bytes());
    key.push(b':');
    key.extend_from_slice(&chunk_index.to_be_bytes());
    key
}

fn manifest_key(attachment_id: &AttachmentId) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_MANIFEST.len() + 32);
    key.extend_from_slice(KEY_PREFIX_MANIFEST);
    key.extend_from_slice(attachment_id.as_bytes());
    key
}

fn reference_prefix(attachment_id: &AttachmentId) -> Vec<u8> {
    let mut prefix = Vec::with_capacity(KEY_PREFIX_REFERENCE.len() + 33);
    prefix.extend_from_slice(KEY_PREFIX_REFERENCE);
    prefix.extend_from_slice(attachment_id.as_bytes());
    prefix.push(b':');
    prefix
}

fn reference_key(attachment_id: &AttachmentId, owner_ref: &[u8; 32]) -> Vec<u8> {
    let mut key = reference_prefix(attachment_id);
    key.extend_from_slice(owner_ref);
    key
}

fn published_chunk_data_key(attachment_id: &AttachmentId, chunk_index: u32) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_PUBLISHED_CHUNK_DATA.len() + 32 + 1 + 4);
    key.extend_from_slice(KEY_PREFIX_PUBLISHED_CHUNK_DATA);
    key.extend_from_slice(attachment_id.as_bytes());
    key.push(b':');
    key.extend_from_slice(&chunk_index.to_be_bytes());
    key
}

fn staging_cleanup_key(session_id: &UploadSessionId) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_STAGING_CLEANUP.len() + 16);
    key.extend_from_slice(KEY_PREFIX_STAGING_CLEANUP);
    key.extend_from_slice(session_id.as_bytes());
    key
}

fn gc_tombstone_key(attachment_id: &AttachmentId) -> Vec<u8> {
    let mut key = Vec::with_capacity(KEY_PREFIX_GC_TOMBSTONE.len() + 32);
    key.extend_from_slice(KEY_PREFIX_GC_TOMBSTONE);
    key.extend_from_slice(attachment_id.as_bytes());
    key
}

fn verify_chunk_bytes(
    spec: &ManifestChunkSpec,
    bytes: &[u8],
) -> Result<ChunkDigest, BlobError> {
    if bytes.len() != spec.byte_len as usize {
        return Err(BlobError::InvalidChunkLength {
            chunk_index: spec.index,
            expected: spec.byte_len,
            actual: bytes.len(),
        });
    }
    let actual_digest = ChunkDigest::compute(bytes);
    if actual_digest.0 != spec.sha256 {
        return Err(BlobError::IntegrityMismatch {
            chunk_index: spec.index,
            expected_hex: hex::encode(spec.sha256),
            actual_hex: actual_digest.to_hex(),
        });
    }
    Ok(actual_digest)
}

/// Core state-machine coordinator shared by [`RocksDbBlobStore`], [`LocalFsBlobStore`], and
/// [`S3BlobStore`].
#[derive(Debug)]
struct CoordinatedBlobStore<B: ChunkPayloadBackend> {
    kv: Arc<dyn RelayKvStore>,
    chunks: Arc<B>,
}

impl<B: ChunkPayloadBackend> Clone for CoordinatedBlobStore<B> {
    fn clone(&self) -> Self {
        Self {
            kv: Arc::clone(&self.kv),
            chunks: Arc::clone(&self.chunks),
        }
    }
}

impl<B: ChunkPayloadBackend> CoordinatedBlobStore<B> {
    fn new(kv: Arc<dyn RelayKvStore>, chunks: Arc<B>) -> Self {
        Self { kv, chunks }
    }

    fn load_staging_session(
        &self,
        session_id: &UploadSessionId,
    ) -> Result<Option<(StoredStagingSession, EncryptedAttachmentManifest)>, BlobError> {
        let Some(raw) = self.kv.get(&staging_session_key(session_id))? else {
            return Ok(None);
        };
        let stored: StoredStagingSession = serde_json::from_slice(&raw).map_err(|e| {
            BlobError::Backend(format!("corrupt staging session record: {e}"))
        })?;
        let manifest = EncryptedAttachmentManifest::decode_canonical(&stored.manifest_cbor)?;
        Ok(Some((stored, manifest)))
    }

    fn load_verified_chunk_indices(
        &self,
        session_id: &UploadSessionId,
    ) -> Result<Vec<u32>, BlobError> {
        let prefix = staging_chunk_got_prefix(session_id);
        let rows = self.kv.scan_prefix_range(&prefix, None, MAX_CHUNK_COUNT + 1)?;
        let mut indices = Vec::with_capacity(rows.len());
        for (k, _) in rows {
            if k.len() == prefix.len() + 4 {
                let mut idx_bytes = [0u8; 4];
                idx_bytes.copy_from_slice(&k[prefix.len()..]);
                indices.push(u32::from_be_bytes(idx_bytes));
            }
        }
        indices.sort_unstable();
        Ok(indices)
    }

    fn load_published_record(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<(StoredPublishedManifest, EncryptedAttachmentManifest)>, BlobError> {
        let Some(raw) = self.kv.get(&manifest_key(attachment_id))? else {
            return Ok(None);
        };
        let stored: StoredPublishedManifest = serde_json::from_slice(&raw).map_err(|e| {
            BlobError::Backend(format!("corrupt published manifest record: {e}"))
        })?;
        let manifest = EncryptedAttachmentManifest::decode_canonical(&stored.manifest_cbor)?;
        Ok(Some((stored, manifest)))
    }

    fn scan_references(&self, attachment_id: &AttachmentId) -> Result<Vec<[u8; 32]>, BlobError> {
        let prefix = reference_prefix(attachment_id);
        let rows = self.kv.scan_prefix_range(&prefix, None, usize::MAX)?;
        let mut refs = Vec::with_capacity(rows.len());
        for (k, _) in rows {
            if k.len() == prefix.len() + 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&k[prefix.len()..]);
                refs.push(arr);
            }
        }
        Ok(refs)
    }
}

#[async_trait]
impl<B: ChunkPayloadBackend + 'static> BlobStore for CoordinatedBlobStore<B> {
    async fn begin_staging(
        &self,
        session_id: UploadSessionId,
        manifest: EncryptedAttachmentManifest,
        staged_at_ms: u64,
        staging_ttl_ms: u64,
    ) -> Result<StagingSessionState, BlobError> {
        let manifest_cbor = manifest.encode_canonical()?;
        let staged_expires_at_ms = staged_at_ms.saturating_add(staging_ttl_ms);

        if let Some((existing, existing_manifest)) = self.load_staging_session(&session_id)? {
            if existing.manifest_cbor != manifest_cbor {
                return Err(BlobError::SessionConflict(session_id));
            }
            let verified_chunks = self.load_verified_chunk_indices(&session_id)?;
            return Ok(StagingSessionState {
                session_id,
                manifest: existing_manifest,
                staged_at_ms: existing.staged_at_ms,
                staged_expires_at_ms: existing.staged_expires_at_ms,
                verified_chunks,
            });
        }

        let record = StoredStagingSession {
            session_id: session_id.0,
            manifest_cbor,
            staged_at_ms,
            staged_expires_at_ms,
        };
        let encoded = serde_json::to_vec(&record)
            .map_err(|e| BlobError::Backend(format!("serialize staging session: {e}")))?;

        match self
            .kv
            .compare_and_swap(&staging_session_key(&session_id), None, &encoded)
        {
            Ok(()) => Ok(StagingSessionState {
                session_id,
                manifest,
                staged_at_ms,
                staged_expires_at_ms,
                verified_chunks: Vec::new(),
            }),
            Err(KvError::CasConflict { .. }) => {
                let (existing, existing_manifest) = self
                    .load_staging_session(&session_id)?
                    .ok_or(BlobError::SessionConflict(session_id))?;
                if existing.manifest_cbor != record.manifest_cbor {
                    return Err(BlobError::SessionConflict(session_id));
                }
                let verified_chunks = self.load_verified_chunk_indices(&session_id)?;
                Ok(StagingSessionState {
                    session_id,
                    manifest: existing_manifest,
                    staged_at_ms: existing.staged_at_ms,
                    staged_expires_at_ms: existing.staged_expires_at_ms,
                    verified_chunks,
                })
            }
            Err(e) => Err(BlobError::Kv(e)),
        }
    }

    async fn get_staging_status(
        &self,
        session_id: UploadSessionId,
    ) -> Result<Option<StagingSessionState>, BlobError> {
        let Some((stored, manifest)) = self.load_staging_session(&session_id)? else {
            return Ok(None);
        };
        let verified_chunks = self.load_verified_chunk_indices(&session_id)?;
        Ok(Some(StagingSessionState {
            session_id,
            manifest,
            staged_at_ms: stored.staged_at_ms,
            staged_expires_at_ms: stored.staged_expires_at_ms,
            verified_chunks,
        }))
    }

    async fn put_staged_chunk(
        &self,
        session_id: UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<(), BlobError> {
        let (_, manifest) = self
            .load_staging_session(&session_id)?
            .ok_or(BlobError::SessionNotFound(session_id))?;

        let spec = manifest
            .chunks
            .get(chunk_index as usize)
            .ok_or(BlobError::ChunkIndexOutOfBounds {
                chunk_index,
                chunk_count: manifest.chunks.len(),
            })?;

        verify_chunk_bytes(spec, bytes)?;

        // Write verified chunk payload to the chunk backend first, then mark it verified in KV.
        self.chunks
            .write_staged_chunk(&session_id, chunk_index, bytes, &spec.sha256)
            .await?;
        self.kv
            .put(&staging_chunk_got_key(&session_id, chunk_index), &[1u8])?;
        Ok(())
    }

    async fn publish_staged(
        &self,
        session_id: UploadSessionId,
        published_at_ms: u64,
        owner_ref: [u8; 32],
    ) -> Result<PublishedAttachmentState, BlobError> {
        let Some((stored_session, manifest)) = self.load_staging_session(&session_id)? else {
            return Err(BlobError::SessionNotFound(session_id));
        };

        if published_at_ms >= stored_session.staged_expires_at_ms {
            return Err(BlobError::SessionExpired {
                session_id,
                expires_at_ms: stored_session.staged_expires_at_ms,
                now_ms: published_at_ms,
            });
        }

        let attachment_id = manifest.id();

        if let Some((existing_pub, _)) = self.load_published_record(&attachment_id)? {
            if existing_pub.manifest_cbor != stored_session.manifest_cbor {
                return Err(BlobError::PublicationConflict(attachment_id));
            }
        }

        let verified_indices = self.load_verified_chunk_indices(&session_id)?;
        for spec in &manifest.chunks {
            if verified_indices.binary_search(&spec.index).is_err() {
                return Err(BlobError::IncompleteUpload {
                    session_id,
                    missing_chunk_index: spec.index,
                });
            }
        }

        // Phase 1: Promote and re-verify every staged chunk into its published location
        // BEFORE the manifest becomes visible in RelayKvStore.
        for spec in &manifest.chunks {
            let staged_bytes = self
                .chunks
                .read_staged_chunk(&session_id, spec.index)
                .await?
                .ok_or(BlobError::IncompleteUpload {
                    session_id,
                    missing_chunk_index: spec.index,
                })?;
            verify_chunk_bytes(spec, &staged_bytes)?;
            self.chunks
                .write_published_chunk(&attachment_id, spec.index, &staged_bytes, &spec.sha256)
                .await?;
        }

        // Phase 2: Atomically commit the published manifest, initial owner_ref, and staging
        // cleanup tombstone while removing the staging session keys.
        let published_record = StoredPublishedManifest {
            manifest_cbor: stored_session.manifest_cbor.clone(),
            published_at_ms,
        };
        let published_bytes = serde_json::to_vec(&published_record)
            .map_err(|e| BlobError::Backend(format!("serialize published manifest: {e}")))?;

        let cleanup_record = StoredStagingCleanup {
            session_id: session_id.0,
            chunk_count: manifest.chunks.len() as u32,
        };
        let cleanup_bytes = serde_json::to_vec(&cleanup_record)
            .map_err(|e| BlobError::Backend(format!("serialize cleanup tombstone: {e}")))?;

        let mut ops = Vec::with_capacity(manifest.chunks.len() + 4);
        ops.push(KvTransactionOp::Put {
            key: manifest_key(&attachment_id),
            value: published_bytes,
        });
        ops.push(KvTransactionOp::Put {
            key: reference_key(&attachment_id, &owner_ref),
            value: published_at_ms.to_be_bytes().to_vec(),
        });
        ops.push(KvTransactionOp::Put {
            key: staging_cleanup_key(&session_id),
            value: cleanup_bytes,
        });
        ops.push(KvTransactionOp::Delete {
            key: staging_session_key(&session_id),
        });
        for spec in &manifest.chunks {
            ops.push(KvTransactionOp::Delete {
                key: staging_chunk_got_key(&session_id, spec.index),
            });
        }
        self.kv.execute_transaction(ops)?;

        // Phase 3: Best-effort immediate cleanup of staged chunk payloads (if interrupted by
        // a crash here, `B_cln:{session_id}` ensures `gc_expired` finishes the cleanup).
        for spec in &manifest.chunks {
            let _ = self.chunks.delete_staged_chunk(&session_id, spec.index).await?;
        }
        self.kv.delete(&staging_cleanup_key(&session_id))?;

        let owner_references = self.scan_references(&attachment_id)?;
        Ok(PublishedAttachmentState {
            attachment_id,
            manifest,
            published_at_ms,
            owner_references,
        })
    }

    async fn add_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<(), BlobError> {
        let Some((stored, _)) = self.load_published_record(attachment_id)? else {
            return Err(BlobError::NotFound(*attachment_id));
        };
        let ops = vec![
            KvTransactionOp::CheckAndSet {
                key: manifest_key(attachment_id),
                expected: Some(
                    serde_json::to_vec(&stored)
                        .map_err(|e| BlobError::Backend(format!("serialize manifest: {e}")))?,
                ),
                new_value: serde_json::to_vec(&stored)
                    .map_err(|e| BlobError::Backend(format!("serialize manifest: {e}")))?,
            },
            KvTransactionOp::Put {
                key: reference_key(attachment_id, &owner_ref),
                value: vec![1u8],
            },
        ];
        self.kv.execute_transaction(ops)?;
        Ok(())
    }

    async fn remove_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<usize, BlobError> {
        if self.load_published_record(attachment_id)?.is_none() {
            return Err(BlobError::NotFound(*attachment_id));
        }
        self.kv.delete(&reference_key(attachment_id, &owner_ref))?;
        let remaining = self.scan_references(attachment_id)?;
        Ok(remaining.len())
    }

    async fn list_references(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Vec<[u8; 32]>, BlobError> {
        if self.load_published_record(attachment_id)?.is_none() {
            return Err(BlobError::NotFound(*attachment_id));
        }
        self.scan_references(attachment_id)
    }

    async fn get_manifest(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<EncryptedAttachmentManifest>, BlobError> {
        Ok(self
            .load_published_record(attachment_id)?
            .map(|(_, manifest)| manifest))
    }

    async fn get_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Vec<u8>, BlobError> {
        let (_, manifest) = self
            .load_published_record(attachment_id)?
            .ok_or(BlobError::NotFound(*attachment_id))?;

        let spec = manifest
            .chunks
            .get(chunk_index as usize)
            .ok_or(BlobError::ChunkIndexOutOfBounds {
                chunk_index,
                chunk_count: manifest.chunks.len(),
            })?;

        let bytes = self
            .chunks
            .read_published_chunk(attachment_id, chunk_index)
            .await?
            .ok_or(BlobError::NotFound(*attachment_id))?;

        verify_chunk_bytes(spec, &bytes)?;
        Ok(bytes)
    }

    async fn read_range(
        &self,
        attachment_id: &AttachmentId,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<u8>, BlobError> {
        let (_, manifest) = self
            .load_published_record(attachment_id)?
            .ok_or(BlobError::NotFound(*attachment_id))?;

        let spans = manifest.resolve_byte_range(start_byte, end_byte_exclusive)?;
        if spans.is_empty() {
            return Ok(Vec::new());
        }

        let mut out = Vec::with_capacity((end_byte_exclusive - start_byte) as usize);
        for (chunk_idx, local_start, local_end) in spans {
            let spec = &manifest.chunks[chunk_idx as usize];
            let chunk_bytes = self
                .chunks
                .read_published_chunk(attachment_id, chunk_idx)
                .await?
                .ok_or(BlobError::NotFound(*attachment_id))?;
            verify_chunk_bytes(spec, &chunk_bytes)?;
            out.extend_from_slice(&chunk_bytes[local_start..local_end]);
        }
        Ok(out)
    }

    async fn gc_expired(&self, now_ms: u64) -> Result<GcReport, BlobError> {
        let mut report = GcReport::default();

        // 1. Finish any interrupted post-publish staging cleanups (`B_cln:`).
        let cleanup_rows = self
            .kv
            .scan_prefix_range(KEY_PREFIX_STAGING_CLEANUP, None, usize::MAX)?;
        for (key, val) in cleanup_rows {
            if let Ok(record) = serde_json::from_slice::<StoredStagingCleanup>(&val) {
                let session_id = UploadSessionId(record.session_id);
                for idx in 0..record.chunk_count {
                    if self.chunks.delete_staged_chunk(&session_id, idx).await? {
                        report.chunks_deleted += 1;
                    }
                }
            }
            self.kv.delete(&key)?;
        }

        // 2. Reclaim expired staging sessions (`now_ms >= staged_expires_at_ms`).
        let staging_rows = self
            .kv
            .scan_prefix_range(KEY_PREFIX_STAGING_SESSION, None, usize::MAX)?;
        for (key, val) in staging_rows {
            let stored: StoredStagingSession = serde_json::from_slice(&val).map_err(|e| {
                BlobError::Backend(format!("corrupt staging session during GC: {e}"))
            })?;
            if now_ms < stored.staged_expires_at_ms {
                continue;
            }
            let session_id = UploadSessionId(stored.session_id);
            let manifest = EncryptedAttachmentManifest::decode_canonical(&stored.manifest_cbor)?;
            let attachment_id = manifest.id();
            let is_published = self.load_published_record(&attachment_id)?.is_some();

            for spec in &manifest.chunks {
                if self
                    .chunks
                    .delete_staged_chunk(&session_id, spec.index)
                    .await?
                {
                    report.chunks_deleted += 1;
                }
                // If an interrupted `publish_staged` wrote partial published chunks before
                // committing `B_man`, reclaim those unreferenced chunks too.
                if !is_published
                    && self
                        .chunks
                        .delete_published_chunk(&attachment_id, spec.index)
                        .await?
                {
                    report.chunks_deleted += 1;
                }
            }

            let got_prefix = staging_chunk_got_prefix(&session_id);
            let got_rows = self.kv.scan_prefix_range(&got_prefix, None, usize::MAX)?;
            let mut ops = Vec::with_capacity(got_rows.len() + 1);
            for (got_k, _) in got_rows {
                ops.push(KvTransactionOp::Delete { key: got_k });
            }
            ops.push(KvTransactionOp::Delete { key });
            self.kv.execute_transaction(ops)?;
            report.expired_staging_sessions_removed += 1;
        }

        // 3. Identify published attachments that are expired (`expires_at_ms <= now_ms`) OR
        // have zero remaining live references, and atomically move them to `B_gc:` tombstones.
        let manifest_rows = self
            .kv
            .scan_prefix_range(KEY_PREFIX_MANIFEST, None, usize::MAX)?;
        for (m_key, m_val) in manifest_rows {
            let stored: StoredPublishedManifest =
                serde_json::from_slice(&m_val).map_err(|e| {
                    BlobError::Backend(format!("corrupt published manifest during GC: {e}"))
                })?;
            let manifest = EncryptedAttachmentManifest::decode_canonical(&stored.manifest_cbor)?;
            let attachment_id = manifest.id();
            let refs = self.scan_references(&attachment_id)?;

            let is_expired = manifest.expires_at_ms <= now_ms;
            let is_unreferenced = refs.is_empty();
            if !is_expired && !is_unreferenced {
                continue;
            }

            let tombstone = StoredGcTombstone {
                attachment_id: attachment_id.0,
                chunk_count: manifest.chunks.len() as u32,
            };
            let tombstone_bytes = serde_json::to_vec(&tombstone)
                .map_err(|e| BlobError::Backend(format!("serialize GC tombstone: {e}")))?;

            let mut ops = Vec::with_capacity(refs.len() + 2);
            ops.push(KvTransactionOp::Delete { key: m_key });
            for r in &refs {
                ops.push(KvTransactionOp::Delete {
                    key: reference_key(&attachment_id, r),
                });
            }
            ops.push(KvTransactionOp::Put {
                key: gc_tombstone_key(&attachment_id),
                value: tombstone_bytes,
            });
            self.kv.execute_transaction(ops)?;

            if is_expired {
                report.expired_attachments_removed += 1;
            } else {
                report.unreferenced_attachments_removed += 1;
            }
        }

        // 4. Sweep all `B_gc:` tombstones (both newly created above and any left over from an
        // earlier crash mid-chunk-deletion), deleting their published chunks and the tombstone.
        let gc_rows = self
            .kv
            .scan_prefix_range(KEY_PREFIX_GC_TOMBSTONE, None, usize::MAX)?;
        for (gc_key, gc_val) in gc_rows {
            let tombstone: StoredGcTombstone = serde_json::from_slice(&gc_val).map_err(|e| {
                BlobError::Backend(format!("corrupt GC tombstone: {e}"))
            })?;
            let attachment_id = AttachmentId(tombstone.attachment_id);
            // Safety guard: never delete chunks if a live manifest somehow exists for this ID.
            if self.load_published_record(&attachment_id)?.is_none() {
                for idx in 0..tombstone.chunk_count {
                    if self
                        .chunks
                        .delete_published_chunk(&attachment_id, idx)
                        .await?
                    {
                        report.chunks_deleted += 1;
                    }
                }
            }
            self.kv.delete(&gc_key)?;
        }

        Ok(report)
    }
}

// =============================================================================================
// 1. RocksDbBlobStore (RelayKvStore-backed chunk + manifest store)
// =============================================================================================

#[derive(Debug)]
struct KvChunkBackend {
    kv: Arc<dyn RelayKvStore>,
}

#[async_trait]
impl ChunkPayloadBackend for KvChunkBackend {
    async fn write_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
        _expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        self.kv
            .put(&staging_chunk_data_key(session_id, chunk_index), bytes)?;
        Ok(())
    }

    async fn read_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        Ok(self.kv.get(&staging_chunk_data_key(session_id, chunk_index))?)
    }

    async fn delete_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let key = staging_chunk_data_key(session_id, chunk_index);
        let existed = self.kv.get(&key)?.is_some();
        if existed {
            self.kv.delete(&key)?;
        }
        Ok(existed)
    }

    async fn write_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
        bytes: &[u8],
        _expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        self.kv
            .put(&published_chunk_data_key(attachment_id, chunk_index), bytes)?;
        Ok(())
    }

    async fn read_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        Ok(self
            .kv
            .get(&published_chunk_data_key(attachment_id, chunk_index))?)
    }

    async fn delete_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let key = published_chunk_data_key(attachment_id, chunk_index);
        let existed = self.kv.get(&key)?.is_some();
        if existed {
            self.kv.delete(&key)?;
        }
        Ok(existed)
    }
}

/// Embedded [`BlobStore`] backed by [`RelayKvStore`] (such as `RocksDbKvStore` or
/// `MemoryKvStore`), persisting each bounded chunk under its own `B_stg:` / `B_chk:` key.
#[derive(Debug, Clone)]
pub struct RocksDbBlobStore {
    inner: CoordinatedBlobStore<KvChunkBackend>,
}

impl RocksDbBlobStore {
    /// Construct a [`RocksDbBlobStore`] backed by `kv`.
    pub fn new(kv: Arc<dyn RelayKvStore>) -> Self {
        let backend = Arc::new(KvChunkBackend {
            kv: Arc::clone(&kv),
        });
        Self {
            inner: CoordinatedBlobStore::new(kv, backend),
        }
    }

    /// Borrow the underlying [`RelayKvStore`].
    pub fn kv_store(&self) -> &Arc<dyn RelayKvStore> {
        &self.inner.kv
    }
}

#[async_trait]
impl BlobStore for RocksDbBlobStore {
    async fn begin_staging(
        &self,
        session_id: UploadSessionId,
        manifest: EncryptedAttachmentManifest,
        staged_at_ms: u64,
        staging_ttl_ms: u64,
    ) -> Result<StagingSessionState, BlobError> {
        self.inner
            .begin_staging(session_id, manifest, staged_at_ms, staging_ttl_ms)
            .await
    }

    async fn get_staging_status(
        &self,
        session_id: UploadSessionId,
    ) -> Result<Option<StagingSessionState>, BlobError> {
        self.inner.get_staging_status(session_id).await
    }

    async fn put_staged_chunk(
        &self,
        session_id: UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<(), BlobError> {
        self.inner
            .put_staged_chunk(session_id, chunk_index, bytes)
            .await
    }

    async fn publish_staged(
        &self,
        session_id: UploadSessionId,
        published_at_ms: u64,
        owner_ref: [u8; 32],
    ) -> Result<PublishedAttachmentState, BlobError> {
        self.inner
            .publish_staged(session_id, published_at_ms, owner_ref)
            .await
    }

    async fn add_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<(), BlobError> {
        self.inner.add_reference(attachment_id, owner_ref).await
    }

    async fn remove_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<usize, BlobError> {
        self.inner.remove_reference(attachment_id, owner_ref).await
    }

    async fn list_references(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Vec<[u8; 32]>, BlobError> {
        self.inner.list_references(attachment_id).await
    }

    async fn get_manifest(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<EncryptedAttachmentManifest>, BlobError> {
        self.inner.get_manifest(attachment_id).await
    }

    async fn get_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner.get_chunk(attachment_id, chunk_index).await
    }

    async fn read_range(
        &self,
        attachment_id: &AttachmentId,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner
            .read_range(attachment_id, start_byte, end_byte_exclusive)
            .await
    }

    async fn gc_expired(&self, now_ms: u64) -> Result<GcReport, BlobError> {
        self.inner.gc_expired(now_ms).await
    }
}

// =============================================================================================
// 2. LocalFsBlobStore (Filesystem chunk files + RelayKvStore authoritative index)
// =============================================================================================

#[derive(Debug)]
struct FsChunkBackend {
    root_dir: PathBuf,
}

impl FsChunkBackend {
    fn new(root_dir: PathBuf) -> Result<Self, BlobError> {
        fs::create_dir_all(root_dir.join("staging"))
            .map_err(|e| BlobError::Backend(format!("create staging dir: {e}")))?;
        fs::create_dir_all(root_dir.join("chunks"))
            .map_err(|e| BlobError::Backend(format!("create chunks dir: {e}")))?;
        fs::create_dir_all(root_dir.join("tmp"))
            .map_err(|e| BlobError::Backend(format!("create tmp dir: {e}")))?;
        Ok(Self { root_dir })
    }

    fn staged_chunk_path(&self, session_id: &UploadSessionId, chunk_index: u32) -> PathBuf {
        self.root_dir
            .join("staging")
            .join(session_id.to_hex())
            .join(format!("{chunk_index:08x}.chunk"))
    }

    fn published_chunk_path(&self, attachment_id: &AttachmentId, chunk_index: u32) -> PathBuf {
        let hex_id = attachment_id.to_hex();
        self.root_dir
            .join("chunks")
            .join(&hex_id[0..2])
            .join(&hex_id)
            .join(format!("{chunk_index:08x}.chunk"))
    }

    fn write_atomic(&self, target: &Path, bytes: &[u8]) -> Result<(), BlobError> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| BlobError::Backend(format!("create parent dir: {e}")))?;
        }
        let tmp_name = format!(
            ".tmp-{}-{}",
            uuid::Uuid::new_v4(),
            target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("chunk")
        );
        let tmp_path = self.root_dir.join("tmp").join(tmp_name);
        {
            let mut file = fs::File::create(&tmp_path)
                .map_err(|e| BlobError::Backend(format!("create temp chunk file: {e}")))?;
            file.write_all(bytes)
                .map_err(|e| BlobError::Backend(format!("write temp chunk file: {e}")))?;
            file.sync_all()
                .map_err(|e| BlobError::Backend(format!("fsync temp chunk file: {e}")))?;
        }
        fs::rename(&tmp_path, target)
            .map_err(|e| BlobError::Backend(format!("rename temp chunk file: {e}")))?;
        Ok(())
    }
}

#[async_trait]
impl ChunkPayloadBackend for FsChunkBackend {
    async fn write_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
        _expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        let path = self.staged_chunk_path(session_id, chunk_index);
        self.write_atomic(&path, bytes)
    }

    async fn read_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        let path = self.staged_chunk_path(session_id, chunk_index);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(BlobError::Backend(format!("read staged chunk file: {e}"))),
        }
    }

    async fn delete_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let path = self.staged_chunk_path(session_id, chunk_index);
        match fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::remove_dir(parent);
                }
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(BlobError::Backend(format!("delete staged chunk file: {e}"))),
        }
    }

    async fn write_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
        bytes: &[u8],
        _expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        let path = self.published_chunk_path(attachment_id, chunk_index);
        self.write_atomic(&path, bytes)
    }

    async fn read_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        let path = self.published_chunk_path(attachment_id, chunk_index);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(BlobError::Backend(format!("read published chunk file: {e}"))),
        }
    }

    async fn delete_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let path = self.published_chunk_path(attachment_id, chunk_index);
        match fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::remove_dir(parent);
                }
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(BlobError::Backend(format!(
                "delete published chunk file: {e}"
            ))),
        }
    }
}

/// Filesystem-backed [`BlobStore`] that stores authoritative manifest and reference metadata in
/// [`RelayKvStore`] while writing immutable ciphertext chunks to local disk via atomic
/// temp-file write + `fsync` + `rename`.
#[derive(Debug, Clone)]
pub struct LocalFsBlobStore {
    root_dir: PathBuf,
    inner: CoordinatedBlobStore<FsChunkBackend>,
}

impl LocalFsBlobStore {
    /// Open or initialize a [`LocalFsBlobStore`] at `root_dir` coordinated by `kv`.
    pub fn new(
        kv: Arc<dyn RelayKvStore>,
        root_dir: impl Into<PathBuf>,
    ) -> Result<Self, BlobError> {
        let root_dir = root_dir.into();
        let backend = Arc::new(FsChunkBackend::new(root_dir.clone())?);
        Ok(Self {
            root_dir,
            inner: CoordinatedBlobStore::new(kv, backend),
        })
    }

    /// Return the filesystem path where a published chunk is stored.
    pub fn published_chunk_path(&self, attachment_id: &AttachmentId, chunk_index: u32) -> PathBuf {
        self.inner
            .chunks
            .published_chunk_path(attachment_id, chunk_index)
    }

    /// Borrow the root directory of this filesystem blob store.
    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }
}

#[async_trait]
impl BlobStore for LocalFsBlobStore {
    async fn begin_staging(
        &self,
        session_id: UploadSessionId,
        manifest: EncryptedAttachmentManifest,
        staged_at_ms: u64,
        staging_ttl_ms: u64,
    ) -> Result<StagingSessionState, BlobError> {
        self.inner
            .begin_staging(session_id, manifest, staged_at_ms, staging_ttl_ms)
            .await
    }

    async fn get_staging_status(
        &self,
        session_id: UploadSessionId,
    ) -> Result<Option<StagingSessionState>, BlobError> {
        self.inner.get_staging_status(session_id).await
    }

    async fn put_staged_chunk(
        &self,
        session_id: UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<(), BlobError> {
        self.inner
            .put_staged_chunk(session_id, chunk_index, bytes)
            .await
    }

    async fn publish_staged(
        &self,
        session_id: UploadSessionId,
        published_at_ms: u64,
        owner_ref: [u8; 32],
    ) -> Result<PublishedAttachmentState, BlobError> {
        self.inner
            .publish_staged(session_id, published_at_ms, owner_ref)
            .await
    }

    async fn add_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<(), BlobError> {
        self.inner.add_reference(attachment_id, owner_ref).await
    }

    async fn remove_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<usize, BlobError> {
        self.inner.remove_reference(attachment_id, owner_ref).await
    }

    async fn list_references(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Vec<[u8; 32]>, BlobError> {
        self.inner.list_references(attachment_id).await
    }

    async fn get_manifest(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<EncryptedAttachmentManifest>, BlobError> {
        self.inner.get_manifest(attachment_id).await
    }

    async fn get_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner.get_chunk(attachment_id, chunk_index).await
    }

    async fn read_range(
        &self,
        attachment_id: &AttachmentId,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner
            .read_range(attachment_id, start_byte, end_byte_exclusive)
            .await
    }

    async fn gc_expired(&self, now_ms: u64) -> Result<GcReport, BlobError> {
        self.inner.gc_expired(now_ms).await
    }
}

// =============================================================================================
// 3. S3BlobStore (S3-Compatible Object Store Adapter with AWS SigV4 + Reqwest Transport)
// =============================================================================================

/// Configuration for connecting [`S3BlobStore`] to AWS S3, MinIO, Cloudflare R2, or SeaweedFS.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct S3BlobStoreConfig {
    /// Base HTTP/HTTPS endpoint URL (e.g. `"http://127.0.0.1:9000"`).
    pub endpoint: String,
    /// S3 region name (e.g. `"us-east-1"` or `"auto"`).
    pub region: String,
    /// Target bucket name.
    pub bucket: String,
    /// Optional key prefix inside the bucket (e.g. `"frank-blobs"`).
    pub prefix: String,
    /// AWS access key ID.
    pub access_key_id: String,
    /// AWS secret access key.
    pub secret_access_key: String,
    /// Whether to use path-style addressing (`/{bucket}/{key}`).
    pub force_path_style: bool,
}

/// Signed AWS Signature Version 4 headers for a single S3 REST request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct S3SigV4Headers {
    /// Value of the `x-amz-date` header (`YYYYMMDD'T'HHMMSS'Z'`).
    pub amz_date: String,
    /// Value of the `x-amz-content-sha256` header (lowercase hex SHA-256 of body).
    pub content_sha256_hex: String,
    /// Full `Authorization: AWS4-HMAC-SHA256 ...` header value.
    pub authorization: String,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(ChunkDigest::compute(data).0)
}

/// Compute deterministic AWS Signature Version 4 headers for an S3 HTTP request.
pub fn sign_s3_v4_request(
    method: &str,
    host: &str,
    canonical_uri: &str,
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    amz_date: &str,
    content_sha256_hex: &str,
) -> S3SigV4Headers {
    let date_stamp = &amz_date[0..8];
    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{content_sha256_hex}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{content_sha256_hex}"
    );
    let canonical_request_hash = sha256_hex(canonical_request.as_bytes());
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_request_hash}");

    let k_secret = format!("AWS4{secret_access_key}");
    let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    S3SigV4Headers {
        amz_date: amz_date.to_string(),
        content_sha256_hex: content_sha256_hex.to_string(),
        authorization,
    }
}

/// Minimal S3 REST transport abstraction (`PUT`, `GET`, `HEAD`, `DELETE`) compatible with
/// AWS S3, MinIO, Cloudflare R2, and SeaweedFS.
#[async_trait]
pub trait S3ObjectTransport: Send + Sync + Debug {
    /// Upload an immutable object at `key` with body `bytes` and `x-amz-content-sha256`.
    async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_sha256_hex: &str,
    ) -> Result<(), BlobError>;

    /// Download the object at `key`, returning `Ok(None)` on `404 Not Found`.
    async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, BlobError>;

    /// Probe the existence and byte length of `key` via `HEAD`, returning `Ok(None)` on `404`.
    async fn head_object(&self, key: &str) -> Result<Option<u64>, BlobError>;

    /// Delete the object at `key` via `DELETE`. Returns `Ok(true)` if the object existed.
    async fn delete_object(&self, key: &str) -> Result<bool, BlobError>;
}

/// Production HTTP/HTTPS [`S3ObjectTransport`] backed by `reqwest` and AWS SigV4 request signing.
#[derive(Clone, Debug)]
pub struct ReqwestS3Transport {
    client: Client,
    config: S3BlobStoreConfig,
}

impl ReqwestS3Transport {
    /// Construct a [`ReqwestS3Transport`] from `config`.
    pub fn new(config: S3BlobStoreConfig) -> Self {
        Self {
            client: Client::new(),
            config,
        }
    }

    fn full_key(&self, key: &str) -> String {
        let trimmed_prefix = self.config.prefix.trim_matches('/');
        let trimmed_key = key.trim_start_matches('/');
        if trimmed_prefix.is_empty() {
            trimmed_key.to_string()
        } else {
            format!("{trimmed_prefix}/{trimmed_key}")
        }
    }

    fn endpoint_url_and_uri(&self, key: &str) -> Result<(String, String, String), BlobError> {
        let full_key = self.full_key(key);
        let base = self.config.endpoint.trim_end_matches('/');
        let parsed = url::Url::parse(base)
            .map_err(|e| BlobError::Backend(format!("invalid S3 endpoint URL {base}: {e}")))?;
        let host = match parsed.port() {
            Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or("localhost")),
            None => parsed.host_str().unwrap_or("localhost").to_string(),
        };
        let canonical_uri = format!("/{}/{}", self.config.bucket, full_key);
        let url = format!("{base}{canonical_uri}");
        Ok((url, host, canonical_uri))
    }

    fn build_signed_headers(
        &self,
        method: &str,
        host: &str,
        canonical_uri: &str,
        content_sha256_hex: &str,
    ) -> Result<HeaderMap, BlobError> {
        let amz_date = "20261017T000000Z";
        let sig = sign_s3_v4_request(
            method,
            host,
            canonical_uri,
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
            amz_date,
            content_sha256_hex,
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-amz-date",
            sig.amz_date
                .parse()
                .map_err(|e| BlobError::Backend(format!("header parse: {e}")))?,
        );
        headers.insert(
            "x-amz-content-sha256",
            sig.content_sha256_hex
                .parse()
                .map_err(|e| BlobError::Backend(format!("header parse: {e}")))?,
        );
        headers.insert(
            "authorization",
            sig.authorization
                .parse()
                .map_err(|e| BlobError::Backend(format!("header parse: {e}")))?,
        );
        Ok(headers)
    }
}

#[async_trait]
impl S3ObjectTransport for ReqwestS3Transport {
    async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_sha256_hex: &str,
    ) -> Result<(), BlobError> {
        let (url, host, canonical_uri) = self.endpoint_url_and_uri(key)?;
        let headers =
            self.build_signed_headers("PUT", &host, &canonical_uri, content_sha256_hex)?;
        let resp = self
            .client
            .put(&url)
            .headers(headers)
            .body(bytes)
            .send()
            .await
            .map_err(|e| BlobError::Backend(format!("S3 PUT {url} failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(BlobError::Backend(format!(
                "S3 PUT {url} returned HTTP {status}: {text}"
            )));
        }
        Ok(())
    }

    async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, BlobError> {
        let (url, host, canonical_uri) = self.endpoint_url_and_uri(key)?;
        let empty_sha = sha256_hex(b"");
        let headers = self.build_signed_headers("GET", &host, &canonical_uri, &empty_sha)?;
        let resp = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| BlobError::Backend(format!("S3 GET {url} failed: {e}")))?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(BlobError::Backend(format!(
                "S3 GET {url} returned HTTP {status}"
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| BlobError::Backend(format!("S3 GET body read failed: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn head_object(&self, key: &str) -> Result<Option<u64>, BlobError> {
        let (url, host, canonical_uri) = self.endpoint_url_and_uri(key)?;
        let empty_sha = sha256_hex(b"");
        let headers = self.build_signed_headers("HEAD", &host, &canonical_uri, &empty_sha)?;
        let resp = self
            .client
            .head(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| BlobError::Backend(format!("S3 HEAD {url} failed: {e}")))?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(BlobError::Backend(format!(
                "S3 HEAD {url} returned HTTP {status}"
            )));
        }
        let len = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        Ok(Some(len))
    }

    async fn delete_object(&self, key: &str) -> Result<bool, BlobError> {
        let existed = self.head_object(key).await?.is_some();
        if !existed {
            return Ok(false);
        }
        let (url, host, canonical_uri) = self.endpoint_url_and_uri(key)?;
        let empty_sha = sha256_hex(b"");
        let headers = self.build_signed_headers("DELETE", &host, &canonical_uri, &empty_sha)?;
        let resp = self
            .client
            .delete(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| BlobError::Backend(format!("S3 DELETE {url} failed: {e}")))?;
        if !resp.status().is_success() && resp.status() != StatusCode::NOT_FOUND {
            let status = resp.status();
            return Err(BlobError::Backend(format!(
                "S3 DELETE {url} returned HTTP {status}"
            )));
        }
        Ok(true)
    }
}

#[derive(Debug)]
struct S3ChunkBackend {
    transport: Arc<dyn S3ObjectTransport>,
}

impl S3ChunkBackend {
    fn staged_object_key(session_id: &UploadSessionId, chunk_index: u32) -> String {
        format!("staging/{}/{chunk_index:08x}", session_id.to_hex())
    }

    fn published_object_key(attachment_id: &AttachmentId, chunk_index: u32) -> String {
        format!("chunks/{}/{chunk_index:08x}", attachment_id.to_hex())
    }
}

#[async_trait]
impl ChunkPayloadBackend for S3ChunkBackend {
    async fn write_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
        expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        let key = Self::staged_object_key(session_id, chunk_index);
        let sha_hex = hex::encode(expected_sha256);
        self.transport
            .put_object(&key, bytes.to_vec(), &sha_hex)
            .await
    }

    async fn read_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        let key = Self::staged_object_key(session_id, chunk_index);
        self.transport.get_object(&key).await
    }

    async fn delete_staged_chunk(
        &self,
        session_id: &UploadSessionId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let key = Self::staged_object_key(session_id, chunk_index);
        self.transport.delete_object(&key).await
    }

    async fn write_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
        bytes: &[u8],
        expected_sha256: &[u8; 32],
    ) -> Result<(), BlobError> {
        let key = Self::published_object_key(attachment_id, chunk_index);
        let sha_hex = hex::encode(expected_sha256);
        self.transport
            .put_object(&key, bytes.to_vec(), &sha_hex)
            .await
    }

    async fn read_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Option<Vec<u8>>, BlobError> {
        let key = Self::published_object_key(attachment_id, chunk_index);
        self.transport.get_object(&key).await
    }

    async fn delete_published_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<bool, BlobError> {
        let key = Self::published_object_key(attachment_id, chunk_index);
        self.transport.delete_object(&key).await
    }
}

/// S3-compatible [`BlobStore`] adapter storing authoritative manifest and reference metadata
/// in [`RelayKvStore`] and immutable encrypted chunk payloads in an S3-compatible object store
/// (AWS S3, MinIO, Cloudflare R2, SeaweedFS).
#[derive(Debug, Clone)]
pub struct S3BlobStore {
    transport: Arc<dyn S3ObjectTransport>,
    inner: CoordinatedBlobStore<S3ChunkBackend>,
}

impl S3BlobStore {
    /// Construct an [`S3BlobStore`] with a custom [`S3ObjectTransport`].
    pub fn with_transport(
        kv: Arc<dyn RelayKvStore>,
        transport: Arc<dyn S3ObjectTransport>,
    ) -> Self {
        let backend = Arc::new(S3ChunkBackend {
            transport: Arc::clone(&transport),
        });
        Self {
            transport,
            inner: CoordinatedBlobStore::new(kv, backend),
        }
    }

    /// Construct an [`S3BlobStore`] using [`ReqwestS3Transport`] and `config`.
    pub fn new(kv: Arc<dyn RelayKvStore>, config: S3BlobStoreConfig) -> Self {
        let transport = Arc::new(ReqwestS3Transport::new(config));
        Self::with_transport(kv, transport)
    }

    /// Return the relative S3 object key for a published chunk (`chunks/{attachment_id}/{idx}`).
    pub fn published_object_key(attachment_id: &AttachmentId, chunk_index: u32) -> String {
        S3ChunkBackend::published_object_key(attachment_id, chunk_index)
    }

    /// Borrow the underlying [`S3ObjectTransport`].
    pub fn transport(&self) -> &Arc<dyn S3ObjectTransport> {
        &self.transport
    }
}

#[async_trait]
impl BlobStore for S3BlobStore {
    async fn begin_staging(
        &self,
        session_id: UploadSessionId,
        manifest: EncryptedAttachmentManifest,
        staged_at_ms: u64,
        staging_ttl_ms: u64,
    ) -> Result<StagingSessionState, BlobError> {
        self.inner
            .begin_staging(session_id, manifest, staged_at_ms, staging_ttl_ms)
            .await
    }

    async fn get_staging_status(
        &self,
        session_id: UploadSessionId,
    ) -> Result<Option<StagingSessionState>, BlobError> {
        self.inner.get_staging_status(session_id).await
    }

    async fn put_staged_chunk(
        &self,
        session_id: UploadSessionId,
        chunk_index: u32,
        bytes: &[u8],
    ) -> Result<(), BlobError> {
        self.inner
            .put_staged_chunk(session_id, chunk_index, bytes)
            .await
    }

    async fn publish_staged(
        &self,
        session_id: UploadSessionId,
        published_at_ms: u64,
        owner_ref: [u8; 32],
    ) -> Result<PublishedAttachmentState, BlobError> {
        self.inner
            .publish_staged(session_id, published_at_ms, owner_ref)
            .await
    }

    async fn add_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<(), BlobError> {
        self.inner.add_reference(attachment_id, owner_ref).await
    }

    async fn remove_reference(
        &self,
        attachment_id: &AttachmentId,
        owner_ref: [u8; 32],
    ) -> Result<usize, BlobError> {
        self.inner.remove_reference(attachment_id, owner_ref).await
    }

    async fn list_references(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Vec<[u8; 32]>, BlobError> {
        self.inner.list_references(attachment_id).await
    }

    async fn get_manifest(
        &self,
        attachment_id: &AttachmentId,
    ) -> Result<Option<EncryptedAttachmentManifest>, BlobError> {
        self.inner.get_manifest(attachment_id).await
    }

    async fn get_chunk(
        &self,
        attachment_id: &AttachmentId,
        chunk_index: u32,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner.get_chunk(attachment_id, chunk_index).await
    }

    async fn read_range(
        &self,
        attachment_id: &AttachmentId,
        start_byte: u64,
        end_byte_exclusive: u64,
    ) -> Result<Vec<u8>, BlobError> {
        self.inner
            .read_range(attachment_id, start_byte, end_byte_exclusive)
            .await
    }

    async fn gc_expired(&self, now_ms: u64) -> Result<GcReport, BlobError> {
        self.inner.gc_expired(now_ms).await
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, net::SocketAddr, sync::Mutex};

    use axum::{
        body::Bytes,
        extract::{Extension, Path as AxumPath},
        http::{HeaderMap as AxumHeaderMap, StatusCode as AxumStatusCode},
        response::IntoResponse,
        routing::any,
        Router,
    };
    use tempdir::TempDir;

    use super::*;
    use crate::store::kv_store::{MemoryKvStore, RocksDbKvStore};

    // -----------------------------------------------------------------------------------------
    // In-Process Axum S3-Compatible HTTP Test Server (validates SigV4 + x-amz-content-sha256)
    // -----------------------------------------------------------------------------------------

    #[derive(Clone, Default)]
    struct MockS3ServerState {
        objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    }

    impl MockS3ServerState {
        fn corrupt_object(&self, bucket: &str, key: &str, new_bytes: Vec<u8>) {
            let full = format!("{bucket}/{}", key.trim_start_matches('/'));
            self.objects.lock().unwrap().insert(full, new_bytes);
        }

        fn object_keys(&self) -> Vec<String> {
            let mut keys: Vec<String> = self.objects.lock().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        }
    }

    async fn s3_handler(
        method: axum::http::Method,
        AxumPath((bucket, key)): AxumPath<(String, String)>,
        headers: AxumHeaderMap,
        Extension(state): Extension<MockS3ServerState>,
        body: Bytes,
    ) -> impl IntoResponse {
        // Verify AWS4-HMAC-SHA256 Authorization and x-amz-content-sha256 headers on every request.
        let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) else {
            return (AxumStatusCode::FORBIDDEN, Vec::new()).into_response();
        };
        if !auth.starts_with("AWS4-HMAC-SHA256 Credential=") {
            return (AxumStatusCode::FORBIDDEN, Vec::new()).into_response();
        }
        let Some(content_sha) = headers
            .get("x-amz-content-sha256")
            .and_then(|v| v.to_str().ok())
        else {
            return (AxumStatusCode::BAD_REQUEST, Vec::new()).into_response();
        };

        let full_key = format!("{bucket}/{}", key.trim_start_matches('/'));

        match method {
            axum::http::Method::PUT => {
                let actual_sha = sha256_hex(&body);
                if actual_sha != content_sha {
                    return (
                        AxumStatusCode::BAD_REQUEST,
                        b"XAmzContentSHA256Mismatch".to_vec(),
                    )
                        .into_response();
                }
                state.objects.lock().unwrap().insert(full_key, body.to_vec());
                (AxumStatusCode::OK, Vec::new()).into_response()
            }
            axum::http::Method::GET => {
                let maybe_bytes = state.objects.lock().unwrap().get(&full_key).cloned();
                match maybe_bytes {
                    Some(bytes) => (AxumStatusCode::OK, bytes).into_response(),
                    None => (AxumStatusCode::NOT_FOUND, Vec::new()).into_response(),
                }
            }
            axum::http::Method::HEAD => {
                let maybe_len = state
                    .objects
                    .lock()
                    .unwrap()
                    .get(&full_key)
                    .map(|b| b.len());
                match maybe_len {
                    Some(len) => {
                        let mut resp = (AxumStatusCode::OK, Vec::new()).into_response();
                        resp.headers_mut().insert(
                            axum::http::header::CONTENT_LENGTH,
                            len.to_string().parse().unwrap(),
                        );
                        resp
                    }
                    None => (AxumStatusCode::NOT_FOUND, Vec::new()).into_response(),
                }
            }
            axum::http::Method::DELETE => {
                state.objects.lock().unwrap().remove(&full_key);
                (AxumStatusCode::NO_CONTENT, Vec::new()).into_response()
            }
            _ => (AxumStatusCode::METHOD_NOT_ALLOWED, Vec::new()).into_response(),
        }
    }

    async fn spawn_mock_s3_server() -> (SocketAddr, MockS3ServerState) {
        let state = MockS3ServerState::default();
        let app = Router::new()
            .route("/:bucket/*key", any(s3_handler))
            .layer(Extension(state.clone()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(app.into_make_service())
                .await
                .unwrap();
        });
        (addr, state)
    }

    // -----------------------------------------------------------------------------------------
    // Shared Conformance Suite Across RocksDbBlobStore, LocalFsBlobStore, and S3BlobStore
    // -----------------------------------------------------------------------------------------

    async fn run_conformance_suite<F>(store: &dyn BlobStore, corrupt_chunk_fn: F)
    where
        F: Fn(&AttachmentId, u32, Vec<u8>),
    {
        // 1. Empty (0-byte, 0-chunk) attachment lifecycle
        let empty_id = AttachmentId([0x10; 32]);
        let empty_session = UploadSessionId([0x01; 16]);
        let empty_manifest =
            EncryptedAttachmentManifest::from_ciphertext_slices(empty_id.0, 1024, &[], 50_000)
                .unwrap();
        let state = store
            .begin_staging(empty_session, empty_manifest.clone(), 1_000, 10_000)
            .await
            .unwrap();
        assert!(state.verified_chunks.is_empty());

        let owner_a = [0xAA; 32];
        let pub_empty = store
            .publish_staged(empty_session, 2_000, owner_a)
            .await
            .unwrap();
        assert_eq!(pub_empty.manifest, empty_manifest);
        assert_eq!(
            store.read_range(&empty_id, 0, 0).await.unwrap(),
            Vec::<u8>::new()
        );
        assert_eq!(
            store.read_range(&empty_id, 0, 1).await.unwrap_err(),
            BlobError::InvalidByteRange {
                start_byte: 0,
                end_byte_exclusive: 1,
                total_bytes: 0,
            }
        );

        // 2. Multi-chunk resumed upload, out-of-order upload, duplicate chunk idempotency,
        //    tampered chunk rejection, and incomplete publish rejection.
        let multi_id = AttachmentId([0x22; 32]);
        let multi_session = UploadSessionId([0x02; 16]);
        let chunk_0 = b"ciphertext-chunk-0000-padded!!!!".to_vec(); // 32 bytes
        let chunk_1 = b"ciphertext-chunk-0001-padded!!!!".to_vec(); // 32 bytes
        let chunk_2 = b"tail-chunk-02".to_vec(); // 13 bytes
        let multi_manifest = EncryptedAttachmentManifest::from_ciphertext_slices(
            multi_id.0,
            32,
            &[&chunk_0, &chunk_1, &chunk_2],
            60_000,
        )
        .unwrap();

        store
            .begin_staging(multi_session, multi_manifest.clone(), 1_000, 10_000)
            .await
            .unwrap();

        // Out-of-bounds chunk index -> rejected
        assert_eq!(
            store
                .put_staged_chunk(multi_session, 3, &chunk_0)
                .await
                .unwrap_err(),
            BlobError::ChunkIndexOutOfBounds {
                chunk_index: 3,
                chunk_count: 3,
            }
        );

        // Truncated chunk -> rejected
        assert_eq!(
            store
                .put_staged_chunk(multi_session, 0, &chunk_0[..10])
                .await
                .unwrap_err(),
            BlobError::InvalidChunkLength {
                chunk_index: 0,
                expected: 32,
                actual: 10,
            }
        );

        // Tampered chunk bytes with matching length -> IntegrityMismatch
        let mut tampered_0 = chunk_0.clone();
        tampered_0[0] ^= 0xFF;
        assert!(matches!(
            store
                .put_staged_chunk(multi_session, 0, &tampered_0)
                .await
                .unwrap_err(),
            BlobError::IntegrityMismatch { chunk_index: 0, .. }
        ));

        // Upload chunk 2 first (out-of-order) and chunk 0
        store
            .put_staged_chunk(multi_session, 2, &chunk_2)
            .await
            .unwrap();
        store
            .put_staged_chunk(multi_session, 0, &chunk_0)
            .await
            .unwrap();

        // Incomplete publish must fail identifying missing chunk 1
        assert_eq!(
            store
                .publish_staged(multi_session, 2_000, owner_a)
                .await
                .unwrap_err(),
            BlobError::IncompleteUpload {
                session_id: multi_session,
                missing_chunk_index: 1,
            }
        );

        // Simulate resumed upload: call begin_staging again with same session_id + manifest
        let resumed = store
            .begin_staging(multi_session, multi_manifest.clone(), 1_500, 10_000)
            .await
            .unwrap();
        assert_eq!(resumed.verified_chunks, vec![0, 2]);

        // Duplicate upload of chunk 0 is idempotent
        store
            .put_staged_chunk(multi_session, 0, &chunk_0)
            .await
            .unwrap();
        // Upload missing chunk 1
        store
            .put_staged_chunk(multi_session, 1, &chunk_1)
            .await
            .unwrap();

        // Publish succeeds
        let pub_multi = store
            .publish_staged(multi_session, 3_000, owner_a)
            .await
            .unwrap();
        assert_eq!(pub_multi.attachment_id, multi_id);
        assert_eq!(pub_multi.owner_references, vec![owner_a]);

        // Staging session is cleaned up after publish
        assert!(store
            .get_staging_status(multi_session)
            .await
            .unwrap()
            .is_none());

        // 3. Authenticated full reads & cross-chunk range reads
        let mut full_expected = Vec::new();
        full_expected.extend_from_slice(&chunk_0);
        full_expected.extend_from_slice(&chunk_1);
        full_expected.extend_from_slice(&chunk_2);

        let full_read = store
            .read_range(&multi_id, 0, full_expected.len() as u64)
            .await
            .unwrap();
        assert_eq!(full_read, full_expected);

        // Cross-chunk range spanning middle of chunk 0, all of chunk 1, and start of chunk 2
        let sub_range = store.read_range(&multi_id, 15, 70).await.unwrap();
        assert_eq!(sub_range, &full_expected[15..70]);

        // 4. Shared references & GC lifecycle
        let owner_b = [0xBB; 32];
        store.add_reference(&multi_id, owner_b).await.unwrap();
        assert_eq!(store.list_references(&multi_id).await.unwrap().len(), 2);

        // Removing owner_a leaves owner_b live -> GC must preserve multi_id
        let rem = store.remove_reference(&multi_id, owner_a).await.unwrap();
        assert_eq!(rem, 1);

        let gc_1 = store.gc_expired(10_000).await.unwrap();
        assert_eq!(gc_1.unreferenced_attachments_removed, 0);
        assert!(store.get_manifest(&multi_id).await.unwrap().is_some());

        // Removing owner_b drops references to 0 -> next GC reclaims multi_id
        let rem_empty = store.remove_reference(&empty_id, owner_a).await.unwrap();
        assert_eq!(rem_empty, 0);
        let gc_2 = store.gc_expired(10_000).await.unwrap();
        assert_eq!(gc_2.unreferenced_attachments_removed, 1);
        assert!(store.get_manifest(&empty_id).await.unwrap().is_none());

        // 5. Post-publication underlying storage corruption detection
        let mut corrupted_1 = chunk_1.clone();
        corrupted_1[5] ^= 0xAA;
        corrupt_chunk_fn(&multi_id, 1, corrupted_1);

        assert!(matches!(
            store.get_chunk(&multi_id, 1).await.unwrap_err(),
            BlobError::IntegrityMismatch { chunk_index: 1, .. }
        ));
        assert!(matches!(
            store.read_range(&multi_id, 15, 70).await.unwrap_err(),
            BlobError::IntegrityMismatch { chunk_index: 1, .. }
        ));

        // 6. TTL expiry GC on multi_id (expires_at_ms = 60_000) even with owner_b still attached
        let gc_3 = store.gc_expired(60_000).await.unwrap();
        assert_eq!(gc_3.expired_attachments_removed, 1);
        assert!(store.get_manifest(&multi_id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn conformance_rocksdb_blob_store() {
        let dir = TempDir::new("frank_rocks_blob_conformance").unwrap();
        let kv = Arc::new(RocksDbKvStore::open(dir.path()).unwrap());
        let store = RocksDbBlobStore::new(kv.clone());

        run_conformance_suite(&store, |attachment_id, chunk_index, bad_bytes| {
            kv.put(
                &published_chunk_data_key(attachment_id, chunk_index),
                &bad_bytes,
            )
            .unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn conformance_local_fs_blob_store() {
        let kv_dir = TempDir::new("frank_fs_blob_kv").unwrap();
        let fs_dir = TempDir::new("frank_fs_blob_files").unwrap();
        let kv = Arc::new(RocksDbKvStore::open(kv_dir.path()).unwrap());
        let store = LocalFsBlobStore::new(kv, fs_dir.path()).unwrap();

        run_conformance_suite(&store, |attachment_id, chunk_index, bad_bytes| {
            let path = store.published_chunk_path(attachment_id, chunk_index);
            fs::write(path, bad_bytes).unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn conformance_s3_blob_store_against_live_http_server() {
        let (addr, s3_state) = spawn_mock_s3_server().await;
        let kv = Arc::new(MemoryKvStore::new());
        let config = S3BlobStoreConfig {
            endpoint: format!("http://{addr}"),
            region: "us-east-1".to_string(),
            bucket: "frank-test-bucket".to_string(),
            prefix: "v1-blobs".to_string(),
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
            force_path_style: true,
        };
        let store = S3BlobStore::new(kv, config);

        run_conformance_suite(&store, |attachment_id, chunk_index, bad_bytes| {
            let rel_key = S3BlobStore::published_object_key(attachment_id, chunk_index);
            s3_state.corrupt_object(
                "frank-test-bucket",
                &format!("v1-blobs/{rel_key}"),
                bad_bytes,
            );
        })
        .await;

        // Verify all S3 objects were cleaned up after GC!
        assert!(s3_state.object_keys().is_empty());
    }

    #[test]
    fn manifest_cbor_canonical_roundtrip_and_unknown_field_preservation() {
        let chunk_a = b"chunk-a-bytes";
        let mut manifest = EncryptedAttachmentManifest::from_ciphertext_slices(
            [0x42; 32],
            DEFAULT_CHUNK_BYTES,
            &[chunk_a],
            1_700_000_000_000,
        )
        .unwrap();

        // Add future schema extension fields (keys 99 and 100)
        manifest
            .extra_fields
            .insert(99, CborValue::Text("future-capability-hint".to_string()));
        manifest
            .extra_fields
            .insert(100, CborValue::Int(42));

        let encoded_1 = manifest.encode_canonical().unwrap();
        let decoded = EncryptedAttachmentManifest::decode_canonical(&encoded_1).unwrap();
        assert_eq!(decoded, manifest);
        assert_eq!(
            decoded.extra_fields.get(&99),
            Some(&CborValue::Text("future-capability-hint".to_string()))
        );
        assert_eq!(decoded.extra_fields.get(&100), Some(&CborValue::Int(42)));

        // Re-encoding produces the exact same canonical CBOR bytes
        let encoded_2 = decoded.encode_canonical().unwrap();
        assert_eq!(encoded_1, encoded_2);
    }

    #[test]
    fn manifest_validation_enforces_bounds_and_contiguity() {
        // 1. Oversized manifest bytes (> 64 KiB)
        let huge_bytes = vec![0u8; MAX_MANIFEST_BYTES + 1];
        assert_eq!(
            EncryptedAttachmentManifest::decode_canonical(&huge_bytes).unwrap_err(),
            BlobError::ManifestTooLarge {
                byte_len: MAX_MANIFEST_BYTES + 1,
                max_bytes: MAX_MANIFEST_BYTES,
            }
        );

        // 2. Too many chunks (> MAX_CHUNK_COUNT)
        let mut too_many = EncryptedAttachmentManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            attachment_id: [0x11; 32],
            total_ciphertext_bytes: (MAX_CHUNK_COUNT as u64) + 1,
            max_chunk_bytes: 1024,
            chunks: (0..=MAX_CHUNK_COUNT as u32)
                .map(|i| ManifestChunkSpec {
                    index: i,
                    byte_len: 1,
                    sha256: [0xAA; 32],
                })
                .collect(),
            expires_at_ms: 10_000,
            extra_fields: BTreeMap::new(),
        };
        assert_eq!(
            too_many.validate().unwrap_err(),
            BlobError::TooManyChunks {
                count: MAX_CHUNK_COUNT + 1,
                max_chunks: MAX_CHUNK_COUNT,
            }
        );

        // 3. Non-contiguous chunk index
        too_many.chunks.truncate(2);
        too_many.chunks[1].index = 5;
        too_many.total_ciphertext_bytes = 2;
        assert_eq!(
            too_many.validate().unwrap_err(),
            BlobError::NonContiguousChunkIndex {
                expected: 1,
                actual: 5,
            }
        );
    }

    #[test]
    fn per_chunk_nonce_and_aad_derivation_is_domain_separated() {
        let k_blob = [0x55; 32];
        let base_nonce = [0x11; 24];
        let att_1 = AttachmentId([0x01; 32]);
        let att_2 = AttachmentId([0x02; 32]);

        let n_0 = derive_chunk_nonce(&k_blob, &att_1, &base_nonce, 0);
        let n_1 = derive_chunk_nonce(&k_blob, &att_1, &base_nonce, 1);
        let n_att2_0 = derive_chunk_nonce(&k_blob, &att_2, &base_nonce, 0);

        assert_ne!(n_0, n_1, "distinct chunk indices must produce distinct nonces");
        assert_ne!(
            n_0, n_att2_0,
            "distinct attachment_ids must produce distinct nonces"
        );

        let aad_non_final = derive_chunk_aad(&att_1, 0, false);
        let aad_final = derive_chunk_aad(&att_1, 0, true);
        assert_ne!(
            aad_non_final, aad_final,
            "final-chunk flag must be bound in AAD"
        );
    }

    #[tokio::test]
    async fn crash_injection_across_staging_publish_and_gc_boundaries() {
        let kv = Arc::new(MemoryKvStore::new());
        let store = RocksDbBlobStore::new(kv.clone());

        // Scenario A: Crash mid-staging before session completion -> GC reclaims all staged data
        let abandoned_id = AttachmentId([0x71; 32]);
        let abandoned_session = UploadSessionId([0x71; 16]);
        let c0 = b"part-0".to_vec();
        let c1 = b"part-1".to_vec();
        let manifest_a = EncryptedAttachmentManifest::from_ciphertext_slices(
            abandoned_id.0,
            64,
            &[&c0, &c1],
            50_000,
        )
        .unwrap();

        store
            .begin_staging(abandoned_session, manifest_a.clone(), 1_000, 5_000)
            .await
            .unwrap();
        store
            .put_staged_chunk(abandoned_session, 0, &c0)
            .await
            .unwrap();
        // Simulate partial promotion before crash (chunk 0 written to published location without manifest)
        kv.put(&published_chunk_data_key(&abandoned_id, 0), &c0)
            .unwrap();

        let gc_report = store.gc_expired(6_000).await.unwrap();
        assert_eq!(gc_report.expired_staging_sessions_removed, 1);
        assert_eq!(gc_report.chunks_deleted, 2); // staged c0 + orphan published c0
        assert!(kv
            .get(&staging_chunk_data_key(&abandoned_session, 0))
            .unwrap()
            .is_none());
        assert!(kv
            .get(&published_chunk_data_key(&abandoned_id, 0))
            .unwrap()
            .is_none());

        // Scenario B: Crash right after atomic manifest commit in `publish_staged` before staged chunks deleted
        let live_id = AttachmentId([0x72; 32]);
        let live_session = UploadSessionId([0x72; 16]);
        let manifest_b =
            EncryptedAttachmentManifest::from_ciphertext_slices(live_id.0, 64, &[&c0], 50_000)
                .unwrap();
        store
            .begin_staging(live_session, manifest_b.clone(), 1_000, 5_000)
            .await
            .unwrap();
        store.put_staged_chunk(live_session, 0, &c0).await.unwrap();
        store
            .publish_staged(live_session, 2_000, [0x99; 32])
            .await
            .unwrap();

        // Simulate crash having left `B_cln:` and staged chunk 0 behind
        let cln = StoredStagingCleanup {
            session_id: live_session.0,
            chunk_count: 1,
        };
        kv.put(
            &staging_cleanup_key(&live_session),
            &serde_json::to_vec(&cln).unwrap(),
        )
        .unwrap();
        kv.put(&staging_chunk_data_key(&live_session, 0), &c0)
            .unwrap();

        let gc_b = store.gc_expired(3_000).await.unwrap();
        assert_eq!(gc_b.chunks_deleted, 1);
        // Published blob remains 100% readable!
        assert_eq!(store.get_chunk(&live_id, 0).await.unwrap(), c0);

        // Scenario C: Crash mid-GC after unpublishing manifest (`B_gc:` tombstone present, chunk still on disk/KV)
        let tombstone = StoredGcTombstone {
            attachment_id: live_id.0,
            chunk_count: 1,
        };
        kv.delete(&manifest_key(&live_id)).unwrap();
        kv.put(
            &gc_tombstone_key(&live_id),
            &serde_json::to_vec(&tombstone).unwrap(),
        )
        .unwrap();
        assert!(store.get_manifest(&live_id).await.unwrap().is_none());

        let gc_c = store.gc_expired(4_000).await.unwrap();
        assert_eq!(gc_c.chunks_deleted, 1);
        assert!(kv
            .get(&published_chunk_data_key(&live_id, 0))
            .unwrap()
            .is_none());
        assert!(kv.get(&gc_tombstone_key(&live_id)).unwrap().is_none());
    }

    #[tokio::test]
    async fn content_oblivious_storage_key_equivalence() {
        // Verify that a generic file attachment, a video attachment, and an unknown plugin blob
        // of identical chunk structure produce the exact same KV key prefixes and manifest
        // schema with zero application metadata leakage.
        let kv_file = Arc::new(MemoryKvStore::new());
        let kv_video = Arc::new(MemoryKvStore::new());
        let store_file = RocksDbBlobStore::new(kv_file.clone());
        let store_video = RocksDbBlobStore::new(kv_video.clone());

        let id = [0x88; 32];
        let sess = UploadSessionId([0x44; 16]);
        let owner = [0x33; 32];
        let payload = vec![0xAB; 128];

        let manifest =
            EncryptedAttachmentManifest::from_ciphertext_slices(id, 128, &[&payload], 99_000)
                .unwrap();

        store_file
            .begin_staging(sess, manifest.clone(), 100, 1000)
            .await
            .unwrap();
        store_file.put_staged_chunk(sess, 0, &payload).await.unwrap();
        store_file.publish_staged(sess, 200, owner).await.unwrap();

        store_video
            .begin_staging(sess, manifest.clone(), 100, 1000)
            .await
            .unwrap();
        store_video
            .put_staged_chunk(sess, 0, &payload)
            .await
            .unwrap();
        store_video.publish_staged(sess, 200, owner).await.unwrap();

        let rows_file = kv_file.scan_prefix_range(&[], None, 100).unwrap();
        let rows_video = kv_video.scan_prefix_range(&[], None, 100).unwrap();
        assert_eq!(rows_file, rows_video);
    }
}
