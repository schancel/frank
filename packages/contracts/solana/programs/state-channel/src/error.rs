use num_derive::FromPrimitive;
use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Error, Debug, Copy, Clone, PartialEq, Eq, FromPrimitive)]
pub enum StateChannelError {
    #[error("Channel already exists")]
    ChannelAlreadyExists,
    #[error("Channel not found or uninitialized")]
    ChannelNotFound,
    #[error("Channel already settled")]
    ChannelAlreadySettled,
    #[error("Channel expired")]
    ChannelExpired,
    #[error("Challenge window has not expired yet")]
    ChallengeNotExpired,
    #[error("Challenge window is not active")]
    ChallengeNotActive,
    #[error("Sequence number must be strictly greater than current sequence")]
    StaleSequence,
    #[error("Balance sum does not match channel total deposit")]
    InvalidBalanceSum,
    #[error("Invalid Ed25519 signature from participant")]
    InvalidSignature,
    #[error("Lamport transfer failed")]
    TransferFailed,
    #[error("Invalid zero address")]
    InvalidZeroAddress,
    #[error("Caller is not authorized")]
    Unauthorized,
    #[error("Challenge duration must be greater than zero")]
    ZeroDuration,
    #[error("Account mismatch")]
    AccountMismatch,
    #[error("Invalid PDA derivation or seeds")]
    InvalidPda,
}

impl From<StateChannelError> for ProgramError {
    fn from(e: StateChannelError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
