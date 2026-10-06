/**
 * Solana On-Chain Escrow Constants and Program Definitions.
 *
 * Defines canonical Program IDs, PDA seeds, discriminators, and account layouts
 * for Frank's Solana equivalents of GenericHTLC and StateChannel.
 */

export const SOLANA_GENERIC_HTLC_PROGRAM_ID = 'HTLC111111111111111111111111111111111111111'
export const SOLANA_STATE_CHANNEL_PROGRAM_ID = 'CHAN111111111111111111111111111111111111111'

export const SOLANA_HTLC_LOCK_SEED = 'generic_htlc'
export const SOLANA_STATE_CHANNEL_SEED = 'state_channel'

export enum SolanaHtlcInstructionTag {
  Lock = 0,
  Withdraw = 1,
  BatchWithdraw = 2,
  BatchDistribute = 3,
  Refund = 4,
}

export enum SolanaStateChannelInstructionTag {
  OpenChannel = 0,
  JoinChannel = 1,
  Checkpoint = 2,
  CloseCooperative = 3,
  CloseAfterChallenge = 4,
  RefundTimeout = 5,
}

export const SOLANA_HTLC_LOCK_STATE_LEN = 148
export const SOLANA_STATE_CHANNEL_STATE_LEN = 139
