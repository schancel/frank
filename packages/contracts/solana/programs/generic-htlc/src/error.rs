use num_derive::FromPrimitive;
use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Error, Debug, Copy, Clone, PartialEq, Eq, FromPrimitive)]
pub enum HtlcError {
    #[error("Lock already exists")]
    LockAlreadyExists,
    #[error("Lock not found or uninitialized")]
    LockNotFound,
    #[error("Funds already withdrawn")]
    AlreadyWithdrawn,
    #[error("Funds already refunded")]
    AlreadyRefunded,
    #[error("Lock duration expired or zero")]
    LockExpired,
    #[error("Lock timelock has not expired yet")]
    LockNotExpired,
    #[error("Invalid preimage supplied")]
    InvalidPreimage,
    #[error("Invalid zero address")]
    InvalidZeroAddress,
    #[error("Lamport transfer failed")]
    TransferFailed,
    #[error("Amount must be greater than zero")]
    ZeroAmount,
    #[error("Total payouts exceed pool amount")]
    InvalidPayoutSum,
    #[error("Batch cannot be empty")]
    EmptyBatch,
    #[error("Account mismatch")]
    AccountMismatch,
    #[error("Invalid PDA derivation or seeds")]
    InvalidPda,
}

impl From<HtlcError> for ProgramError {
    fn from(e: HtlcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
