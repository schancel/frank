import { Keypair, PublicKey } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

import {
  SOLANA_GENERIC_HTLC_PROGRAM_ID,
  SOLANA_STATE_CHANNEL_PROGRAM_ID,
  SolanaHtlcInstructionTag,
  SolanaStateChannelInstructionTag,
  buildSolanaCheckpointDigest,
  buildSolanaCloseCooperativeInstruction,
  buildSolanaCloseDigest,
  buildSolanaHtlcBatchDistributeInstruction,
  buildSolanaHtlcLockInstruction,
  buildSolanaHtlcRefundInstruction,
  buildSolanaHtlcWithdrawInstruction,
  buildSolanaJoinChannelInstruction,
  buildSolanaOpenChannelInstruction,
  buildSolanaRefundTimeoutInstruction,
  findSolanaChannelPda,
  findSolanaLockPda,
  registerSolanaEscrowStealthPayout,
  signSolanaDigest,
} from './solana-game-escrow'
import {
  deriveSolanaStealthAddress,
  MemorySolanaStealthKeyringStore,
} from './solana-stealth'

describe('Solana Game Escrow & DKSAP Stealth Payouts', () => {
  let aliceKeypair: Keypair
  let bobKeypair: Keypair
  let alicePubkey: PublicKey
  let bobPubkey: PublicKey

  beforeAll(async () => {
    aliceKeypair = await Keypair.fromSeed(new Uint8Array(32).fill(1))
    bobKeypair = await Keypair.fromSeed(new Uint8Array(32).fill(2))
    alicePubkey = aliceKeypair.publicKey
    bobPubkey = bobKeypair.publicKey
  })

  it('derives deterministic PDAs for GenericHTLC locks and StateChannel channels', async () => {
    const lockId = '0x' + '11'.repeat(32)
    const channelId = '0x' + '22'.repeat(32)

    const [lockPda, lockBump] = await findSolanaLockPda(lockId)
    const [channelPda, channelBump] = await findSolanaChannelPda(channelId)

    expect(lockPda).toBeInstanceOf(PublicKey)
    expect(lockBump).toBeGreaterThanOrEqual(0)
    expect(lockBump).toBeLessThanOrEqual(255)

    expect(channelPda).toBeInstanceOf(PublicKey)
    expect(channelBump).toBeGreaterThanOrEqual(0)
    expect(channelBump).toBeLessThanOrEqual(255)

    // Re-deriving with same parameters returns exact same PDA
    const [lockPda2] = await findSolanaLockPda(lockId)
    expect(lockPda2.toBase58()).toBe(lockPda.toBase58())
  })

  it('builds and verifies StateChannel checkpoint and close digests with Ed25519 co-signatures', async () => {
    const channelId = '0x' + '33'.repeat(32)
    const seq = 7n
    const balances: [bigint, bigint] = [1_400_000n, 600_000n]

    // 1. Checkpoint digest
    const checkpointDigest = buildSolanaCheckpointDigest({
      channelId,
      seq,
      balances,
    })
    expect(checkpointDigest.length).toBe(32)

    const sig0 = signSolanaDigest(checkpointDigest, aliceKeypair.secretKey)
    const sig1 = signSolanaDigest(checkpointDigest, bobKeypair.secretKey)

    expect(sig0.length).toBe(64)
    expect(sig1.length).toBe(64)

    // Verify signatures
    expect(ed25519.verify(sig0, checkpointDigest, alicePubkey.toBytes())).toBe(true)
    expect(ed25519.verify(sig1, checkpointDigest, bobPubkey.toBytes())).toBe(true)

    // Corrupted digest fails verification
    const corrupted = new Uint8Array(checkpointDigest)
    corrupted[0] ^= 0xff
    expect(ed25519.verify(sig0, corrupted, alicePubkey.toBytes())).toBe(false)

    // 2. Close cooperative digest with stealth payout
    const stealthWinner = (await Keypair.fromSeed(new Uint8Array(32).fill(3))).publicKey
    const closeDigest = buildSolanaCloseDigest({
      channelId,
      seq: 10n,
      balances: [1_800_000n, 200_000n],
      payout0: stealthWinner,
      payout1: bobPubkey,
    })
    expect(closeDigest.length).toBe(32)

    const closeSig0 = signSolanaDigest(closeDigest, aliceKeypair.secretKey)
    const closeSig1 = signSolanaDigest(closeDigest, bobKeypair.secretKey)

    expect(ed25519.verify(closeSig0, closeDigest, alicePubkey.toBytes())).toBe(true)
    expect(ed25519.verify(closeSig1, closeDigest, bobPubkey.toBytes())).toBe(true)
  })

  it('builds valid StateChannel instructions with exact binary wire formats', async () => {
    const channelId = '0x' + '44'.repeat(32)
    const [channelPda] = await findSolanaChannelPda(channelId)

    // OpenChannel
    const openIx = await buildSolanaOpenChannelInstruction({
      partyA: alicePubkey,
      peer: bobPubkey,
      channelId,
      depositA: 1_000_000n,
      challengeDuration: 3600n,
    })
    expect(openIx.programId.toBase58()).toBe(SOLANA_STATE_CHANNEL_PROGRAM_ID)
    expect(openIx.keys[0].pubkey.toBase58()).toBe(alicePubkey.toBase58())
    expect(openIx.keys[0].isSigner).toBe(true)
    expect(openIx.keys[1].pubkey.toBase58()).toBe(channelPda.toBase58())
    expect(openIx.data[0]).toBe(SolanaStateChannelInstructionTag.OpenChannel)

    // JoinChannel
    const joinIx = await buildSolanaJoinChannelInstruction({
      partyB: bobPubkey,
      channelId,
      depositB: 1_000_000n,
    })
    expect(joinIx.keys[0].pubkey.toBase58()).toBe(bobPubkey.toBase58())
    expect(joinIx.data[0]).toBe(SolanaStateChannelInstructionTag.JoinChannel)

    // CloseCooperative
    const payout0 = (await Keypair.fromSeed(new Uint8Array(32).fill(4))).publicKey
    const payout1 = bobPubkey
    const sig0 = new Uint8Array(64).fill(1)
    const sig1 = new Uint8Array(64).fill(2)

    const closeIx = await buildSolanaCloseCooperativeInstruction({
      caller: alicePubkey,
      channelId,
      seq: 5n,
      balances: [1_500_000n, 500_000n],
      payout0,
      payout1,
      sig0,
      sig1,
    })
    expect(closeIx.data[0]).toBe(SolanaStateChannelInstructionTag.CloseCooperative)
    expect(closeIx.keys[2].pubkey.toBase58()).toBe(payout0.toBase58())
    expect(closeIx.keys[3].pubkey.toBase58()).toBe(payout1.toBase58())

    // RefundTimeout
    const refundIx = await buildSolanaRefundTimeoutInstruction({
      partyA: alicePubkey,
      channelId,
    })
    expect(refundIx.data[0]).toBe(SolanaStateChannelInstructionTag.RefundTimeout)
  })

  it('builds valid GenericHTLC instructions including explicit refund address and batch distributions', async () => {
    const lockId = '0x' + '55'.repeat(32)
    const [lockPda] = await findSolanaLockPda(lockId)
    const refundAddress = (await Keypair.fromSeed(new Uint8Array(32).fill(5))).publicKey
    const hashLock = sha256(new TextEncoder().encode('game-preimage-secret'))

    // Lock with explicit refund address
    const lockIx = await buildSolanaHtlcLockInstruction({
      lockId,
      sender: alicePubkey,
      recipient: bobPubkey,
      refundAddress,
      hashLock,
      amountLamports: 2_000_000n,
      durationSeconds: 7200n,
    })
    expect(lockIx.programId.toBase58()).toBe(SOLANA_GENERIC_HTLC_PROGRAM_ID)
    expect(lockIx.keys[0].pubkey.toBase58()).toBe(alicePubkey.toBase58())
    expect(lockIx.keys[1].pubkey.toBase58()).toBe(lockPda.toBase58())
    expect(lockIx.data[0]).toBe(SolanaHtlcInstructionTag.Lock)

    // Withdraw
    const withdrawIx = await buildSolanaHtlcWithdrawInstruction({
      caller: bobPubkey,
      lockId,
      recipient: bobPubkey,
      preimage: 'game-preimage-secret',
    })
    expect(withdrawIx.data[0]).toBe(SolanaHtlcInstructionTag.Withdraw)
    expect(withdrawIx.keys[1].pubkey.toBase58()).toBe(lockPda.toBase58())
    expect(withdrawIx.keys[2].pubkey.toBase58()).toBe(bobPubkey.toBase58())

    // Multi-winner BatchDistribute (Poker / Liar's Dice table pot)
    const lockId2 = '0x' + '66'.repeat(32)
    const winner1 = (await Keypair.fromSeed(new Uint8Array(32).fill(6))).publicKey
    const winner2 = (await Keypair.fromSeed(new Uint8Array(32).fill(7))).publicKey

    const distributeIx = await buildSolanaHtlcBatchDistributeInstruction({
      caller: alicePubkey,
      lockIds: [lockId, lockId2],
      payouts: [
        { recipient: winner1, amountLamports: 1_400_000n },
        { recipient: winner2, amountLamports: 500_000n },
      ],
      preimage: 'game-preimage-secret',
      primaryRefundAddress: refundAddress,
    })
    expect(distributeIx.data[0]).toBe(SolanaHtlcInstructionTag.BatchDistribute)
    expect(distributeIx.keys.length).toBe(6) // caller + 2 locks + 2 winners + 1 primary refund

    // Refund
    const refundIx = await buildSolanaHtlcRefundInstruction({
      caller: alicePubkey,
      lockId,
      refundAddress,
    })
    expect(refundIx.data[0]).toBe(SolanaHtlcInstructionTag.Refund)
    expect(refundIx.keys[2].pubkey.toBase58()).toBe(refundAddress.toBase58())
  })

  it('indexes game escrow stealth payouts into recipient keyring for immediate spendability', async () => {
    const keyringStore = new MemorySolanaStealthKeyringStore()
    const recipientSeed = new Uint8Array(32).fill(42)
    const recipientKeypair = await Keypair.fromSeed(recipientSeed)

    // Derive stealth address for recipient
    const stealthDest = await deriveSolanaStealthAddress({
      recipientSpendPubKey: recipientKeypair.publicKey,
    })

    const payoutLamports = 1_750_000n

    // Register incoming settlement
    const record = await registerSolanaEscrowStealthPayout({
      keyringStore,
      recipientSpendSeed: recipientSeed,
      ephemeralPubKey: stealthDest.ephemeralPubKey,
      expectedStealthAddress: stealthDest.stealthAddress,
      amountLamports: payoutLamports,
      networkTag: 'SOLD',
      txHash: '5xTestTxSig12345',
    })

    expect(record.address).toBe(stealthDest.stealthAddress)
    expect(record.keypair.publicKey.toBase58()).toBe(stealthDest.stealthAddress)
    expect(record.initialAmountLamports).toBe(payoutLamports)

    // Keyring store has the indexed account
    const stored = keyringStore.get(stealthDest.stealthAddress)
    expect(stored).toBeDefined()
    expect(stored?.address).toBe(stealthDest.stealthAddress)
  })
})
