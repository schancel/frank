use ed25519_dalek::{Signature, VerifyingKey};
use solana_program::pubkey::Pubkey;

use crate::error::StateChannelError;

pub fn get_checkpoint_digest(
    channel_id: &[u8; 32],
    seq: u64,
    balances: &[u64; 2],
    program_id: &Pubkey,
) -> [u8; 32] {
    let domain = b"FRANK_SOLANA_STATE_CHANNEL_CHECKPOINT\x00";
    let mut payload = Vec::with_capacity(38 + 32 + 8 + 8 + 8 + 1 + 32);
    payload.extend_from_slice(domain);
    payload.extend_from_slice(channel_id);
    payload.extend_from_slice(&seq.to_le_bytes());
    payload.extend_from_slice(&balances[0].to_le_bytes());
    payload.extend_from_slice(&balances[1].to_le_bytes());
    payload.push(0u8); // is_final = false
    payload.extend_from_slice(program_id.as_ref());
    solana_program::hash::hash(&payload).to_bytes()
}

pub fn get_close_digest(
    channel_id: &[u8; 32],
    seq: u64,
    balances: &[u64; 2],
    payout0: &Pubkey,
    payout1: &Pubkey,
    program_id: &Pubkey,
) -> [u8; 32] {
    let domain = b"FRANK_SOLANA_STATE_CHANNEL_CLOSE_COOPERATIVE\x00";
    let mut payload = Vec::with_capacity(45 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 32);
    payload.extend_from_slice(domain);
    payload.extend_from_slice(channel_id);
    payload.extend_from_slice(&seq.to_le_bytes());
    payload.extend_from_slice(&balances[0].to_le_bytes());
    payload.extend_from_slice(&balances[1].to_le_bytes());
    payload.extend_from_slice(payout0.as_ref());
    payload.extend_from_slice(payout1.as_ref());
    payload.push(1u8); // is_final = true
    payload.extend_from_slice(program_id.as_ref());
    solana_program::hash::hash(&payload).to_bytes()
}

pub fn verify_signature(
    pubkey: &Pubkey,
    digest: &[u8; 32],
    sig: &[u8; 64],
) -> Result<(), StateChannelError> {
    let pubkey_bytes = pubkey.to_bytes();
    let vk = VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|_| StateChannelError::InvalidSignature)?;
    let signature = Signature::from_bytes(sig);
    vk.verify_strict(digest, &signature)
        .map_err(|_| StateChannelError::InvalidSignature)?;
    Ok(())
}
