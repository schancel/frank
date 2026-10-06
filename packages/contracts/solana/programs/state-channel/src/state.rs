use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const CHANNEL_SEED: &[u8] = b"state_channel";

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct ChannelState {
    pub is_initialized: bool,
    pub channel_id: [u8; 32],
    pub participants: [Pubkey; 2],
    pub balances: [u64; 2],
    pub current_seq: u64,
    pub challenge_duration: i64,
    pub challenge_expires_at: i64,
    pub settled: bool,
    pub bump: u8,
}

impl ChannelState {
    pub const LEN: usize = 1 + 32 + (32 * 2) + (8 * 2) + 8 + 8 + 8 + 1 + 1; // 139 bytes
}
