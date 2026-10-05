//! Effect-free canonical stamp/context checks. This is not full stage10 validation,
//! plaintext authentication, chain observation, payment acceptance or a delivery receipt.

use crate::directory_admission::{Current, HistoricalEvidence};
use frank_cbor::{
    address_from_compressed_pubkey, default_context, encode_direct_message_crypto_context,
    payment_commitment, recipient_payload_digest, relay_context, validate_frame,
    verify_preview_directory_evidence, AccountRef, DirectMessageCryptoContext, PaymentMember,
    Timestamp, TypedPayload, ValidationResult,
};
use secp256k1_abc::{PublicKey, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};

/// A failure in this deliberately partial verifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalStampError {
    /// Invalid frame/schema/network or scalar encoding.
    #[error("canonical-stamp:encoding")]
    Encoding,
    /// Supplied admitted snapshot/evidence/context do not agree.
    #[error("canonical-stamp:directory-context")]
    DirectoryContext,
    /// Invalid point, DLEQ relation, T3, destination or T4.
    #[error("canonical-stamp:cryptographic")]
    Cryptographic,
}
type Result<T> = std::result::Result<T, CanonicalStampError>;

fn prefix(domain: &str, network: &str) -> Result<Vec<u8>> {
    if network.is_empty()
        || network.len() > 64
        || !network.as_bytes()[0].is_ascii_lowercase() && !network.as_bytes()[0].is_ascii_digit()
        || !network
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    {
        return Err(CanonicalStampError::Encoding);
    }
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(domain.len() as u16).to_be_bytes());
    bytes.extend_from_slice(domain.as_bytes());
    bytes.extend_from_slice(&(network.len() as u16).to_be_bytes());
    bytes.extend_from_slice(network.as_bytes());
    Ok(bytes)
}

fn point(bytes: &[u8]) -> Result<PublicKey> {
    if bytes.len() != 33 || !matches!(bytes[0], 2 | 3) {
        return Err(CanonicalStampError::Encoding);
    }
    PublicKey::from_slice(bytes).map_err(|_| CanonicalStampError::Cryptographic)
}

fn stamp(key: &AccountRef) -> Result<PublicKey> {
    if key.key_type != 1 {
        return Err(CanonicalStampError::Encoding);
    }
    point(&key.key_bytes)
}

/// Independently verifies the frozen Frank T3b transcript (not BIP374).
pub fn verify_canonical_stamp_proof(
    network: &str,
    stamp_key: &AccountRef,
    ephemeral: &[u8],
    shared: &[u8],
    proof: &[u8],
) -> Result<()> {
    let mut transcript = prefix("frank/stamp-dleq/v1", network)?;
    let p = stamp(stamp_key)?;
    let e = point(ephemeral)?;
    let x = point(shared)?;
    if proof.len() != 64 {
        return Err(CanonicalStampError::Encoding);
    }
    SecretKey::from_slice(&proof[..32]).map_err(|_| CanonicalStampError::Encoding)?;
    let response =
        SecretKey::from_slice(&proof[32..]).map_err(|_| CanonicalStampError::Encoding)?;
    let secp = Secp256k1::new();
    let mut one = [0u8; 32];
    one[31] = 1;
    let generator = PublicKey::from_secret_key(
        &secp,
        &SecretKey::from_slice(&one).map_err(|_| CanonicalStampError::Encoding)?,
    );
    let subtract = |mut base: PublicKey, mut other: PublicKey| -> Result<PublicKey> {
        base.mul_assign(&secp, &proof[32..])
            .map_err(|_| CanonicalStampError::Cryptographic)?;
        other
            .mul_assign(&secp, &proof[..32])
            .map_err(|_| CanonicalStampError::Cryptographic)?;
        other.negate_assign(&secp);
        base.combine(&other)
            .map_err(|_| CanonicalStampError::Cryptographic)
    };
    // The response is public; parsing above enforces 1..n-1 without reduction.
    let _ = response;
    let r1 = subtract(generator, e)?;
    let r2 = subtract(p, x)?;
    for q in [generator, p, e, x, r1, r2] {
        transcript.extend_from_slice(&q.serialize());
    }
    if Sha256::digest(&transcript).as_slice() != &proof[..32] {
        return Err(CanonicalStampError::Cryptographic);
    }
    Ok(())
}

/// Public T3a child key/address. No proof or chain observation is implied.
pub fn canonical_stamp_destination(
    network: &str,
    stamp_key: &AccountRef,
    shared: &[u8],
    child_index: u32,
) -> Result<([u8; 33], [u8; 20])> {
    if child_index > 0x7fff_ffff {
        return Err(CanonicalStampError::Encoding);
    }
    let mut transcript = prefix("frank/stamp-child/v1", network)?;
    let mut p = stamp(stamp_key)?;
    point(shared)?;
    transcript.extend_from_slice(shared);
    transcript.extend_from_slice(&child_index.to_be_bytes());
    let tweak = Sha256::digest(&transcript);
    SecretKey::from_slice(&tweak).map_err(|_| CanonicalStampError::Cryptographic)?;
    p.mul_assign(&Secp256k1::new(), &tweak)
        .map_err(|_| CanonicalStampError::Cryptographic)?;
    let encoded = p.serialize();
    let address =
        address_from_compressed_pubkey(&encoded).map_err(|_| CanonicalStampError::Cryptographic)?;
    Ok((encoded, address))
}

#[derive(Debug)]
struct DirectoryTuple {
    subject: AccountRef,
    message: AccountRef,
    stamp: AccountRef,
    generations: [u64; 2],
    revision: u64,
    expiry: Timestamp,
}

fn tuple(evidence: &HistoricalEvidence, network: &str) -> Result<DirectoryTuple> {
    let verified = verify_preview_directory_evidence(&evidence.attestation, network)
        .map_err(|_| CanonicalStampError::DirectoryContext)?;
    if verified.statement_hash != evidence.hash
        || verified.statement_frame().frame != evidence.statement
    {
        return Err(CanonicalStampError::DirectoryContext);
    }
    match verified.statement_frame().typed.as_deref() {
        Some(TypedPayload::DirectoryStatement {
            subject,
            stamp_key: Some(stamp),
            preview: Some(roles),
            revision,
            expiry: Some(expiry),
            ..
        }) => Ok(DirectoryTuple {
            subject: subject.clone(),
            message: roles.message_dh_key.clone(),
            stamp: stamp.clone(),
            generations: [roles.mailbox_key_generation, roles.stamp_key_generation],
            revision: *revision,
            expiry: *expiry,
        }),
        _ => Err(CanonicalStampError::DirectoryContext),
    }
}

fn current_tuple(current: &Current, network: &str) -> Result<DirectoryTuple> {
    let value = tuple(&current.evidence, network)?;
    if value.message != current.message_key
        || value.stamp != current.stamp_key
        || value.generations != current.generations
        || value.revision != current.revision
        || current.status.forked
    {
        return Err(CanonicalStampError::DirectoryContext);
    }
    Ok(value)
}

/// Exact caller-admitted inputs. No decoded HTTP object or signed statement alone is Current.
#[derive(Debug)]
pub struct CanonicalStampCheckInput<'a> {
    /// Exact type1 frame; no ciphertext reconstruction.
    pub delivery: &'a [u8],
    /// Exact allocated deterministic-CBOR context, bounded to 4KiB before work.
    pub context: &'a [u8],
    /// Fresh sender snapshot obtained for this operation from the admission facade.
    pub sender_current: &'a Current,
    /// Fresh recipient snapshot, including persisted previous stamp state.
    pub recipient_current: &'a Current,
    /// Optional exact retained in-flight evidence from historical_evidence, never a new head.
    pub recipient_evidence: Option<&'a HistoricalEvidence>,
}

/// Partial public proof result. Deliberately cannot stand for a verified economic submission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalStampChecks {
    /// T3 commits to the exact accepted type5 bytes.
    pub payload_digest: [u8; 32],
    /// Structurally unique members whose destination and T4 match. Still require chain checks.
    pub payments: Vec<PaymentMember>,
}

/// Pure context/T3/S10a/T3b/T3a/T4 phase for the runtime successor. The caller must
/// enforce complete stage10 ordering and real transaction observations before effects.
/// It neither decrypts nor claims stage10.1–10.3/10.5 succeeded.
pub fn verify_canonical_stamp(input: CanonicalStampCheckInput<'_>) -> Result<CanonicalStampChecks> {
    if input.context.len() > 4096 {
        return Err(CanonicalStampError::Encoding);
    }
    let parsed = validate_frame(input.delivery, &relay_context())
        .map_err(|_| CanonicalStampError::Encoding)?;
    let ValidationResult::Parsed(root) = parsed else {
        return Err(CanonicalStampError::Encoding);
    };
    let Some(TypedPayload::DirectMessage {
        network,
        destination,
        payload_frame,
        payload_digest,
        payments,
        ..
    }) = root.typed.as_deref()
    else {
        return Err(CanonicalStampError::Encoding);
    };
    let Some(TypedPayload::RecipientPayload {
        schema_version: 2,
        network: payload_network,
        sender,
        recipient,
        suite: 1,
        ephemeral_point,
        shared_point,
        dleq_proof,
        ..
    }) = payload_frame.typed.as_deref()
    else {
        return Err(CanonicalStampError::Encoding);
    };
    if payload_frame.schema_version != 2
        || payload_frame.min_reader_version != 2
        || network != payload_network
    {
        return Err(CanonicalStampError::Encoding);
    }
    let sender_tuple = current_tuple(input.sender_current, network)?;
    let recipient_current = current_tuple(input.recipient_current, network)?;
    let evidence = input
        .recipient_evidence
        .unwrap_or(&input.recipient_current.evidence);
    let recipient_tuple = tuple(evidence, network)?;
    let now = input.recipient_current.status.checked_time;
    if sender != &sender_tuple.subject
        || recipient != &recipient_current.subject
        || recipient_tuple.subject != recipient_current.subject
        || recipient_tuple.message != recipient_current.message
        || (
            recipient_tuple.expiry.seconds,
            recipient_tuple.expiry.nanoseconds,
        ) <= (now.seconds, now.nanoseconds)
        || destination != &recipient_tuple.stamp
    {
        return Err(CanonicalStampError::DirectoryContext);
    }
    let expected_context = encode_direct_message_crypto_context(&DirectMessageCryptoContext {
        network,
        sender,
        recipient,
        sender_directory_hash: &input.sender_current.evidence.hash,
        recipient_directory_hash: &evidence.hash,
        sender_message_key: &sender_tuple.message,
        recipient_message_key: &recipient_tuple.message,
        stamp_key: destination,
        ephemeral_point,
        shared_point,
        dleq_proof,
    })
    .map_err(|_| CanonicalStampError::DirectoryContext)?;
    if expected_context != input.context {
        return Err(CanonicalStampError::DirectoryContext);
    }
    let digest = recipient_payload_digest(network, &payload_frame.frame)
        .map_err(|_| CanonicalStampError::Encoding)?;
    if payload_digest.as_slice() != digest {
        return Err(CanonicalStampError::Cryptographic);
    }
    stamp(destination)?;
    if destination != &input.recipient_current.stamp_key
        && Some(destination) != input.recipient_current.previous_stamp.as_ref()
    {
        return Err(CanonicalStampError::DirectoryContext);
    }
    verify_canonical_stamp_proof(
        network,
        destination,
        ephemeral_point,
        shared_point,
        dleq_proof,
    )?;
    for member in payments {
        let (_, address) =
            canonical_stamp_destination(network, destination, shared_point, member.child_index)?;
        if member.address.as_slice() != address
            || member.commitment.as_slice() != payment_commitment(&digest, member.child_index)
        {
            return Err(CanonicalStampError::Cryptographic);
        }
    }
    Ok(CanonicalStampChecks {
        payload_digest: digest,
        payments: payments.clone(),
    })
}

#[cfg(test)]
#[path = "monad_dm_verify_tests.rs"]
mod tests;
