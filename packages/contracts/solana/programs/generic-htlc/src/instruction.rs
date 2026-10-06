use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Payout {
    pub recipient: Pubkey,
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum HtlcInstruction {
    /// Locks funds with a cryptographic hashlock, explicit refund address, and expiry duration.
    ///
    /// Accounts expected:
    /// 0. `[signer, writable]` Sender / funder
    /// 1. `[writable]` Lock PDA account
    /// 2. `[]` System program
    Lock {
        lock_id: [u8; 32],
        recipient: Pubkey,
        refund_address: Pubkey,
        hash_lock: [u8; 32],
        amount: u64,
        duration: i64,
    },

    /// Withdraws locked funds to recipient by revealing preimage.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1. `[writable]` Lock PDA account
    /// 2. `[writable]` Recipient account (must match lock.recipient)
    Withdraw {
        preimage: Vec<u8>,
    },

    /// Batch withdraws multiple locks sharing the same preimage.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// Followed by pairs of `(lock_pda, recipient)` for each lock.
    BatchWithdraw {
        preimage: Vec<u8>,
    },

    /// Multi-winner group table pot distribution.
    /// Pools multiple locks and disburses to payouts list; remainder goes to locks[0].refund_address.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1..=N. `[writable]` Lock PDA accounts
    /// (N+1)..=(N+M). `[writable]` Payout recipient accounts
    /// Optional: `[writable]` Primary refund destination for remainder
    BatchDistribute {
        preimage: Vec<u8>,
        payouts: Vec<Payout>,
    },

    /// Refunds expired lock to explicit refund_address.
    ///
    /// Accounts expected:
    /// 0. `[signer]` Caller
    /// 1. `[writable]` Lock PDA account
    /// 2. `[writable]` Refund destination account (must match lock.refund_address)
    /// 3. `[]` Clock sysvar
    Refund,
}
