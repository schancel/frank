use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum StateChannelInstruction {
    /// Opens a 2-party symmetric state channel.
    ///
    /// Accounts expected:
    /// 0. `[signer, writable]` PartyA (participant 0)
    /// 1. `[writable]` Channel PDA account
    /// 2. `[]` System program
    OpenChannel {
        channel_id: [u8; 32],
        peer: Pubkey,
        deposit_a: u64,
        challenge_duration: i64,
    },

    /// Counterparty joins and deposits initial balance.
    ///
    /// Accounts expected:
    /// 0. `[signer, writable]` PartyB (participant 1)
    /// 1. `[writable]` Channel PDA account
    /// 2. `[]` System program
    JoinChannel {
        deposit_b: u64,
    },

    /// On-chain monotonic sequence checkpoint with challenge timer.
    /// Requires dual Ed25519 co-signatures over checkpoint digest.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1. `[writable]` Channel PDA account
    /// 2. `[]` Clock sysvar
    Checkpoint {
        seq: u64,
        balances: [u64; 2],
        sig0: [u8; 64],
        sig1: [u8; 64],
    },

    /// Cooperative settlement bypassing challenge delay.
    /// Supports direct payout routing to fresh DKSAP stealth addresses.
    /// Requires dual Ed25519 co-signatures over close digest.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1. `[writable]` Channel PDA account
    /// 2. `[writable]` Payout destination for participant 0 (or partyA)
    /// 3. `[writable]` Payout destination for participant 1 (or partyB)
    CloseCooperative {
        seq: u64,
        balances: [u64; 2],
        payout0: Pubkey,
        payout1: Pubkey,
        sig0: [u8; 64],
        sig1: [u8; 64],
    },

    /// Unilateral closure after challenge window expires without a higher sequence submitted.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1. `[writable]` Channel PDA account
    /// 2. `[writable]` Participant 0 account
    /// 3. `[writable]` Participant 1 account
    /// 4. `[]` Clock sysvar
    CloseAfterChallenge,

    /// Unilateral initial refund if partyB never joined.
    ///
    /// Accounts expected:
    /// 0. `[signer, writable]` PartyA
    /// 1. `[writable]` Channel PDA account
    RefundTimeout,
}
