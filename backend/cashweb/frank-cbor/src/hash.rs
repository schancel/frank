//! Pure transcripts T1, T1a, T3, T4, and T7 (README section 8). No signature is verified.

use sha2::{Digest, Sha256};

use crate::error::UsageError;
use crate::model::{ParsedFrame, TypedPayload};

fn usage(detail: impl Into<String>) -> UsageError {
    UsageError(detail.into())
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn u16_be(n: usize) -> Result<[u8; 2], UsageError> {
    let n = u16::try_from(n).map_err(|_| usage("transcript field longer than 65535 bytes"))?;
    Ok(n.to_be_bytes())
}

fn u32_be(n: usize) -> Result<[u8; 4], UsageError> {
    let n = u32::try_from(n).map_err(|_| usage("transcript frame longer than 2^32-1 bytes"))?;
    Ok(n.to_be_bytes())
}

fn ascii_literal(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// `u16be(len(domain)) || ascii(domain) || u16be(len(network)) || utf8(network)
/// || u32be(len(frame)) || frame || context`.
pub fn common_transcript(
    domain: &str,
    network: &str,
    frame: &[u8],
    context: &[u8],
) -> Result<Vec<u8>, UsageError> {
    if !ascii_literal(domain) {
        return Err(usage("transcript domain must be ASCII"));
    }
    let mut out = Vec::new();
    out.extend_from_slice(&u16_be(domain.len())?);
    out.extend_from_slice(domain.as_bytes());
    out.extend_from_slice(&u16_be(network.len())?);
    out.extend_from_slice(network.as_bytes());
    out.extend_from_slice(&u32_be(frame.len())?);
    out.extend_from_slice(frame);
    out.extend_from_slice(context);
    Ok(out)
}

fn network_field(typed: &TypedPayload) -> Option<&str> {
    match typed {
        TypedPayload::DirectMessage { network, .. }
        | TypedPayload::MailboxCheckpoint { network, .. }
        | TypedPayload::DirectoryStatement { network, .. }
        | TypedPayload::RecipientPayload { network, .. }
        | TypedPayload::TopicPost { network, .. }
        | TypedPayload::TopicPostSubmission { network, .. }
        | TypedPayload::TopicVoteSubmission { network, .. }
        | TypedPayload::EncryptedContent { network, .. }
        | TypedPayload::KeyTransitionStatement { network, .. } => Some(network),
        _ => None,
    }
}

/// T1's network source. Unknown types have no content hash.
pub fn content_hash_network(frame: &ParsedFrame) -> Result<String, UsageError> {
    match frame.type_id {
        8 | 16 | 17 => Ok("frank".to_string()),
        2 => {
            let typed = frame
                .typed
                .as_deref()
                .ok_or_else(|| usage("T1 for a type-2 frame needs the stage 8 typed projection"))?;
            match typed {
                TypedPayload::DirectoryAttestation { statement, .. } => {
                    match statement.typed.as_deref() {
                        Some(TypedPayload::DirectoryStatement { network, .. }) => {
                            Ok(network.clone())
                        }
                        _ => Err(usage(
                            "T1 for a type-2 frame needs the stage 8 typed projection",
                        )),
                    }
                }
                _ => Err(usage(
                    "T1 for a type-2 frame needs the stage 8 typed projection",
                )),
            }
        }
        1 | 3 | 4 | 5 | 6 | 7 | 9 | 10 | 11 => {
            let typed = frame.typed.as_deref().ok_or_else(|| {
                usage(format!(
                    "T1 for a type-{} frame needs the stage 8 typed projection",
                    frame.type_id
                ))
            })?;
            network_field(typed).map(str::to_string).ok_or_else(|| {
                usage(format!(
                    "T1 for a type-{} frame needs the stage 8 typed projection",
                    frame.type_id
                ))
            })
        }
        _ => Err(usage(
            "content hashes are undefined for an unknown type (T1)",
        )),
    }
}

/// T1: SHA-256 of the common transcript with domain `frank/content-hash/v1`.
pub fn content_hash(frame: &ParsedFrame) -> Result<[u8; 32], UsageError> {
    let network = content_hash_network(frame)?;
    let transcript = common_transcript("frank/content-hash/v1", &network, &frame.frame, &[])?;
    Ok(sha256(&transcript))
}

/// T1a digest of a complete type-8 frame. The network tag is the literal `frank`.
pub fn message_content_digest(type8_frame: &[u8]) -> Result<[u8; 32], UsageError> {
    let transcript = common_transcript("frank/message-content/v1", "frank", type8_frame, &[])?;
    Ok(sha256(&transcript))
}

/// T3 recipient-payload digest of a complete type-5 frame.
pub fn recipient_payload_digest(network: &str, type5_frame: &[u8]) -> Result<[u8; 32], UsageError> {
    let transcript = common_transcript("frank/recipient-payload/v1", network, type5_frame, &[])?;
    Ok(sha256(&transcript))
}

/// T4: `SHA256("frank:dm-stamp-payment:v1" || t3_digest || u32be(child_index))`.
pub fn payment_commitment(t3_digest: &[u8], child_index: u32) -> [u8; 32] {
    let mut buf = Vec::with_capacity(24 + t3_digest.len() + 4);
    buf.extend_from_slice(b"frank:dm-stamp-payment:v1");
    buf.extend_from_slice(t3_digest);
    buf.extend_from_slice(&child_index.to_be_bytes());
    sha256(&buf)
}

/// T7: `SHA256("frank:topic-vote:v1" || u16be(len(network)) || utf8(network) || target_hash)`.
///
/// `target_hash` is the T1 hash of the type-9 frame the burn pays for: a type-11
/// frame's field 1, or the content hash of the frame opened by a type 10.
pub fn topic_vote_commitment(
    network: &str,
    target_hash: &[u8; 32],
) -> Result<[u8; 32], UsageError> {
    let mut buf = Vec::with_capacity(19 + 2 + network.len() + 32);
    buf.extend_from_slice(b"frank:topic-vote:v1");
    buf.extend_from_slice(&u16_be(network.len())?);
    buf.extend_from_slice(network.as_bytes());
    buf.extend_from_slice(target_hash);
    Ok(sha256(&buf))
}
