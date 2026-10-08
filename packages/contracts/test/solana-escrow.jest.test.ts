import {
  SOLANA_GENERIC_HTLC_PROGRAM_ID,
  SOLANA_HTLC_LOCK_SEED,
  SOLANA_HTLC_LOCK_STATE_LEN,
  SOLANA_STATE_CHANNEL_PROGRAM_ID,
  SOLANA_STATE_CHANNEL_SEED,
  SOLANA_STATE_CHANNEL_STATE_LEN,
  SolanaHtlcInstructionTag,
  SolanaStateChannelInstructionTag,
} from '../index'

describe('Solana Escrow Contracts & Constants', () => {
  it('exports canonical Solana program IDs and PDA seeds', () => {
    expect(SOLANA_GENERIC_HTLC_PROGRAM_ID).toBe(
      'HTLC111111111111111111111111111111111111111',
    )
    expect(SOLANA_STATE_CHANNEL_PROGRAM_ID).toBe(
      'CHAN111111111111111111111111111111111111111',
    )
    expect(SOLANA_HTLC_LOCK_SEED).toBe('generic_htlc')
    expect(SOLANA_STATE_CHANNEL_SEED).toBe('state_channel')
  })

  it('exports expected instruction discriminators matching Rust programs', () => {
    expect(SolanaHtlcInstructionTag.Lock).toBe(0)
    expect(SolanaHtlcInstructionTag.Withdraw).toBe(1)
    expect(SolanaHtlcInstructionTag.BatchWithdraw).toBe(2)
    expect(SolanaHtlcInstructionTag.BatchDistribute).toBe(3)
    expect(SolanaHtlcInstructionTag.Refund).toBe(4)

    expect(SolanaStateChannelInstructionTag.OpenChannel).toBe(0)
    expect(SolanaStateChannelInstructionTag.JoinChannel).toBe(1)
    expect(SolanaStateChannelInstructionTag.Checkpoint).toBe(2)
    expect(SolanaStateChannelInstructionTag.CloseCooperative).toBe(3)
    expect(SolanaStateChannelInstructionTag.CloseAfterChallenge).toBe(4)
    expect(SolanaStateChannelInstructionTag.RefundTimeout).toBe(5)
  })

  it('exports state buffer lengths matching Borsh serialized structs in on-chain programs', () => {
    expect(SOLANA_HTLC_LOCK_STATE_LEN).toBe(148)
    expect(SOLANA_STATE_CHANNEL_STATE_LEN).toBe(139)
  })
})
