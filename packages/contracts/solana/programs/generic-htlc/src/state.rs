use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const LOCK_SEED: &[u8] = b"generic_htlc";

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct LockState {
    pub is_initialized: bool,
    pub lock_id: [u8; 32],
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub refund_address: Pubkey,
    pub hash_lock: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
    pub withdrawn: bool,
    pub refunded: bool,
    pub bump: u8,
}

impl LockState {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 1; // 148 bytes
}
