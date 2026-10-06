/**
 * Solana Game Escrow & DKSAP Stealth Payouts.
 *
 * Client instruction builders, PDA resolvers, cryptographic digest generators,
 * and stealth account indexing for Frank's Solana StateChannel and GenericHTLC programs.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha256'
import { ed25519 } from '@noble/curves/ed25519'
import { fromHex, toHex } from '@frank/codec'

import {
  deriveSolanaStealthAddress,
  deriveSolanaStealthKeypair,
  type SolanaStealthAccountRecord,
  type SolanaStealthDestination,
  type SolanaStealthKeyringStore,
} from './solana-stealth'

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

export interface SolanaTablePayout {
  recipient: PublicKey | string
  amountLamports: bigint | number
}

export interface SolanaChannelSettlementParams {
  channelId: Uint8Array | string
  seq: bigint | number
  balances: [bigint, bigint]
  payout0: PublicKey | string
  payout1: PublicKey | string
  programId?: PublicKey | string
}

export interface SolanaChannelCheckpointParams {
  channelId: Uint8Array | string
  seq: bigint | number
  balances: [bigint, bigint]
  programId?: PublicKey | string
}

export interface SolanaHtlcLockParams {
  lockId: Uint8Array | string
  sender: PublicKey | string
  recipient: PublicKey | string
  refundAddress?: PublicKey | string
  hashLock: Uint8Array | string
  amountLamports: bigint | number
  durationSeconds: bigint | number
  lockPda?: PublicKey
  programId?: PublicKey | string
}

export interface SolanaHtlcWithdrawParams {
  caller: PublicKey | string
  lockId: Uint8Array | string
  recipient: PublicKey | string
  preimage: Uint8Array | string
  lockPda?: PublicKey
  programId?: PublicKey | string
}

export interface SolanaHtlcBatchDistributeParams {
  caller: PublicKey | string
  lockIds: (Uint8Array | string)[]
  payouts: SolanaTablePayout[]
  preimage: Uint8Array | string
  primaryRefundAddress?: PublicKey | string
  lockPdas?: PublicKey[]
  programId?: PublicKey | string
}

export interface SolanaHtlcRefundParams {
  caller: PublicKey | string
  lockId: Uint8Array | string
  refundAddress: PublicKey | string
  lockPda?: PublicKey
  programId?: PublicKey | string
}

export interface RegisterSolanaEscrowStealthPayoutParams {
  keyringStore: SolanaStealthKeyringStore
  recipientSpendSeed: Uint8Array | string
  ephemeralPubKey: Uint8Array | string
  expectedStealthAddress?: string
  amountLamports: bigint
  txHash?: string
  networkTag?: string
  timestampMs?: number
}

// --- Helpers ---

export function toPubkey(val: PublicKey | string): PublicKey {
  return typeof val === 'string' ? new PublicKey(val) : val
}

export function to32Bytes(val: Uint8Array | string): Uint8Array {
  if (typeof val === 'string') {
    const hex = val.startsWith('0x') ? val.slice(2) : val
    if (hex.length === 64) {
      return fromHex(hex)
    }
    try {
      return new PublicKey(val).toBytes()
    } catch {
      const bytes = new TextEncoder().encode(val)
      if (bytes.length === 32) return bytes
      return sha256(bytes)
    }
  }
  if (val.length === 32) return val
  throw new Error(`Expected 32 bytes, got ${val.length}`)
}

export function toBytes(val: Uint8Array | string): Uint8Array {
  if (typeof val === 'string') {
    return val.startsWith('0x') ? fromHex(val.slice(2)) : new TextEncoder().encode(val)
  }
  return val
}

// --- PDA Resolvers ---

export async function findSolanaLockPda(
  lockId: Uint8Array | string,
  programId: PublicKey | string = SOLANA_GENERIC_HTLC_PROGRAM_ID,
): Promise<[PublicKey, number]> {
  const prog = toPubkey(programId)
  const idBytes = to32Bytes(lockId)
  return PublicKey.findProgramAddress(
    [new TextEncoder().encode(SOLANA_HTLC_LOCK_SEED), idBytes],
    prog,
  )
}

export async function findSolanaChannelPda(
  channelId: Uint8Array | string,
  programId: PublicKey | string = SOLANA_STATE_CHANNEL_PROGRAM_ID,
): Promise<[PublicKey, number]> {
  const prog = toPubkey(programId)
  const idBytes = to32Bytes(channelId)
  return PublicKey.findProgramAddress(
    [new TextEncoder().encode(SOLANA_STATE_CHANNEL_SEED), idBytes],
    prog,
  )
}

// --- Digest Computation ---

const CHECKPOINT_DOMAIN = new TextEncoder().encode('FRANK_SOLANA_STATE_CHANNEL_CHECKPOINT\x00')
const CLOSE_DOMAIN = new TextEncoder().encode('FRANK_SOLANA_STATE_CHANNEL_CLOSE_COOPERATIVE\x00')

export function buildSolanaCheckpointDigest(
  params: SolanaChannelCheckpointParams,
): Uint8Array {
  const programId = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const channelId = to32Bytes(params.channelId)

  // payload: domain (38) + channel_id (32) + seq (8) + bal0 (8) + bal1 (8) + is_final (1) + program_id (32)
  const payload = new Uint8Array(38 + 32 + 8 + 8 + 8 + 1 + 32)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

  payload.set(CHECKPOINT_DOMAIN, 0)
  payload.set(channelId, 38)
  view.setBigUint64(70, BigInt(params.seq), true)
  view.setBigUint64(78, BigInt(params.balances[0]), true)
  view.setBigUint64(86, BigInt(params.balances[1]), true)
  payload[94] = 0 // is_final = false
  payload.set(programId.toBytes(), 95)

  return sha256(payload)
}

export function buildSolanaCloseDigest(
  params: SolanaChannelSettlementParams,
): Uint8Array {
  const programId = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const channelId = to32Bytes(params.channelId)
  const p0 = toPubkey(params.payout0)
  const p1 = toPubkey(params.payout1)

  // payload: domain (45) + channel_id (32) + seq (8) + bal0 (8) + bal1 (8) + p0 (32) + p1 (32) + is_final (1) + program_id (32)
  const payload = new Uint8Array(45 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 32)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)

  payload.set(CLOSE_DOMAIN, 0)
  payload.set(channelId, 45)
  view.setBigUint64(77, BigInt(params.seq), true)
  view.setBigUint64(85, BigInt(params.balances[0]), true)
  view.setBigUint64(93, BigInt(params.balances[1]), true)
  payload.set(p0.toBytes(), 101)
  payload.set(p1.toBytes(), 133)
  payload[165] = 1 // is_final = true
  payload.set(programId.toBytes(), 166)

  return sha256(payload)
}

export function signSolanaDigest(
  digest: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array {
  const privKey = secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey
  return ed25519.sign(digest, privKey)
}

// --- Instruction Builders ---

export async function buildSolanaOpenChannelInstruction(params: {
  partyA: PublicKey | string
  peer: PublicKey | string
  channelId: Uint8Array | string
  depositA: bigint | number
  challengeDuration: bigint | number
  channelPda?: PublicKey
  programId?: PublicKey | string
}): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const partyA = toPubkey(params.partyA)
  const peer = toPubkey(params.peer)
  const channelPda = params.channelPda ?? (await findSolanaChannelPda(params.channelId, prog))[0]

  // Data: [tag: 0 (1b), channel_id (32b), peer (32b), deposit_a (8b), duration (8b)] = 81b
  const data = new Uint8Array(1 + 32 + 32 + 8 + 8)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaStateChannelInstructionTag.OpenChannel
  data.set(to32Bytes(params.channelId), 1)
  data.set(peer.toBytes(), 33)
  view.setBigUint64(65, BigInt(params.depositA), true)
  view.setBigInt64(73, BigInt(params.challengeDuration), true)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: partyA, isSigner: true, isWritable: true },
      { pubkey: channelPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaJoinChannelInstruction(params: {
  partyB: PublicKey | string
  channelId: Uint8Array | string
  depositB: bigint | number
  channelPda?: PublicKey
  programId?: PublicKey | string
}): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const partyB = toPubkey(params.partyB)
  const channelPda = params.channelPda ?? (await findSolanaChannelPda(params.channelId, prog))[0]

  // Data: [tag: 1 (1b), deposit_b (8b)] = 9b
  const data = new Uint8Array(1 + 8)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaStateChannelInstructionTag.JoinChannel
  view.setBigUint64(1, BigInt(params.depositB), true)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: partyB, isSigner: true, isWritable: true },
      { pubkey: channelPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaCheckpointInstruction(params: {
  caller: PublicKey | string
  channelId: Uint8Array | string
  seq: bigint | number
  balances: [bigint, bigint]
  sig0: Uint8Array
  sig1: Uint8Array
  channelPda?: PublicKey
  programId?: PublicKey | string
}): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const caller = toPubkey(params.caller)
  const channelPda = params.channelPda ?? (await findSolanaChannelPda(params.channelId, prog))[0]

  // Data: [tag: 2 (1b), seq (8b), bal0 (8b), bal1 (8b), sig0 (64b), sig1 (64b)] = 153b
  const data = new Uint8Array(1 + 8 + 8 + 8 + 64 + 64)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaStateChannelInstructionTag.Checkpoint
  view.setBigUint64(1, BigInt(params.seq), true)
  view.setBigUint64(9, BigInt(params.balances[0]), true)
  view.setBigUint64(17, BigInt(params.balances[1]), true)
  data.set(params.sig0, 25)
  data.set(params.sig1, 89)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: channelPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaCloseCooperativeInstruction(params: {
  caller: PublicKey | string
  channelId: Uint8Array | string
  seq: bigint | number
  balances: [bigint, bigint]
  payout0: PublicKey | string
  payout1: PublicKey | string
  sig0: Uint8Array
  sig1: Uint8Array
  channelPda?: PublicKey
  programId?: PublicKey | string
}): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const caller = toPubkey(params.caller)
  const p0 = toPubkey(params.payout0)
  const p1 = toPubkey(params.payout1)
  const channelPda = params.channelPda ?? (await findSolanaChannelPda(params.channelId, prog))[0]

  // Data: [tag: 3 (1b), seq (8b), bal0 (8b), bal1 (8b), p0 (32b), p1 (32b), sig0 (64b), sig1 (64b)] = 217b
  const data = new Uint8Array(1 + 8 + 8 + 8 + 32 + 32 + 64 + 64)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaStateChannelInstructionTag.CloseCooperative
  view.setBigUint64(1, BigInt(params.seq), true)
  view.setBigUint64(9, BigInt(params.balances[0]), true)
  view.setBigUint64(17, BigInt(params.balances[1]), true)
  data.set(p0.toBytes(), 25)
  data.set(p1.toBytes(), 57)
  data.set(params.sig0, 89)
  data.set(params.sig1, 153)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: channelPda, isSigner: false, isWritable: true },
      { pubkey: p0, isSigner: false, isWritable: true },
      { pubkey: p1, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaRefundTimeoutInstruction(params: {
  partyA: PublicKey | string
  channelId: Uint8Array | string
  channelPda?: PublicKey
  programId?: PublicKey | string
}): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_STATE_CHANNEL_PROGRAM_ID)
  const partyA = toPubkey(params.partyA)
  const channelPda = params.channelPda ?? (await findSolanaChannelPda(params.channelId, prog))[0]

  const data = new Uint8Array([SolanaStateChannelInstructionTag.RefundTimeout])

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: partyA, isSigner: true, isWritable: true },
      { pubkey: channelPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

// --- GenericHTLC Instruction Builders ---

export async function buildSolanaHtlcLockInstruction(
  params: SolanaHtlcLockParams,
): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_GENERIC_HTLC_PROGRAM_ID)
  const sender = toPubkey(params.sender)
  const recipient = toPubkey(params.recipient)
  const refund = toPubkey(params.refundAddress ?? sender)
  const lockPda = params.lockPda ?? (await findSolanaLockPda(params.lockId, prog))[0]

  // Data: [tag: 0 (1b), lock_id (32b), recipient (32b), refund (32b), hash_lock (32b), amount (8b), duration (8b)] = 145b
  const data = new Uint8Array(1 + 32 + 32 + 32 + 32 + 8 + 8)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaHtlcInstructionTag.Lock
  data.set(to32Bytes(params.lockId), 1)
  data.set(recipient.toBytes(), 33)
  data.set(refund.toBytes(), 65)
  data.set(to32Bytes(params.hashLock), 97)
  view.setBigUint64(129, BigInt(params.amountLamports), true)
  view.setBigInt64(137, BigInt(params.durationSeconds), true)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: lockPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaHtlcWithdrawInstruction(
  params: SolanaHtlcWithdrawParams,
): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_GENERIC_HTLC_PROGRAM_ID)
  const caller = toPubkey(params.caller)
  const recipient = toPubkey(params.recipient)
  const lockPda = params.lockPda ?? (await findSolanaLockPda(params.lockId, prog))[0]
  const preimageBytes = toBytes(params.preimage)

  // Data: [tag: 1 (1b), preimage_len (4b LE), preimage_bytes (N)]
  const data = new Uint8Array(1 + 4 + preimageBytes.length)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaHtlcInstructionTag.Withdraw
  view.setUint32(1, preimageBytes.length, true)
  data.set(preimageBytes, 5)

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: lockPda, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

export async function buildSolanaHtlcBatchDistributeInstruction(
  params: SolanaHtlcBatchDistributeParams,
): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_GENERIC_HTLC_PROGRAM_ID)
  const caller = toPubkey(params.caller)
  const preimageBytes = toBytes(params.preimage)

  const lockPdas: PublicKey[] = []
  if (params.lockPdas && params.lockPdas.length === params.lockIds.length) {
    lockPdas.push(...params.lockPdas)
  } else {
    for (const id of params.lockIds) {
      lockPdas.push((await findSolanaLockPda(id, prog))[0])
    }
  }

  const payoutPubkeys = params.payouts.map((p) => toPubkey(p.recipient))

  // Data:
  // [tag: 3 (1b)]
  // [preimage_len (4b LE), preimage_bytes (N)]
  // [payouts_count (4b LE)]
  // For each payout: [recipient (32b), amount (8b)] = 40b
  const payoutsLen = params.payouts.length
  const dataLen = 1 + 4 + preimageBytes.length + 4 + payoutsLen * 40
  const data = new Uint8Array(dataLen)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  data[0] = SolanaHtlcInstructionTag.BatchDistribute
  let offset = 1
  view.setUint32(offset, preimageBytes.length, true)
  offset += 4
  data.set(preimageBytes, offset)
  offset += preimageBytes.length

  view.setUint32(offset, payoutsLen, true)
  offset += 4

  for (const p of params.payouts) {
    const pub = toPubkey(p.recipient)
    data.set(pub.toBytes(), offset)
    offset += 32
    view.setBigUint64(offset, BigInt(p.amountLamports), true)
    offset += 8
  }

  const keys = [
    { pubkey: caller, isSigner: true, isWritable: false },
    ...lockPdas.map((pda) => ({ pubkey: pda, isSigner: false, isWritable: true })),
    ...payoutPubkeys.map((pub) => ({ pubkey: pub, isSigner: false, isWritable: true })),
  ]

  if (params.primaryRefundAddress) {
    keys.push({
      pubkey: toPubkey(params.primaryRefundAddress),
      isSigner: false,
      isWritable: true,
    })
  }

  return new TransactionInstruction({
    programId: prog,
    keys,
    data: Buffer.from(data),
  })
}

export async function buildSolanaHtlcRefundInstruction(
  params: SolanaHtlcRefundParams,
): Promise<TransactionInstruction> {
  const prog = toPubkey(params.programId ?? SOLANA_GENERIC_HTLC_PROGRAM_ID)
  const caller = toPubkey(params.caller)
  const refundDest = toPubkey(params.refundAddress)
  const lockPda = params.lockPda ?? (await findSolanaLockPda(params.lockId, prog))[0]

  const data = new Uint8Array([SolanaHtlcInstructionTag.Refund])

  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: lockPda, isSigner: false, isWritable: true },
      { pubkey: refundDest, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  })
}

// --- DKSAP Stealth Payout Registration ---

export async function registerSolanaEscrowStealthPayout(
  params: RegisterSolanaEscrowStealthPayoutParams,
): Promise<SolanaStealthAccountRecord> {
  const { keyringStore, recipientSpendSeed, ephemeralPubKey, amountLamports } = params

  const seedBytes = toBytes(recipientSpendSeed)
  const derived = await deriveSolanaStealthKeypair({
    recipientSpendSeed: seedBytes,
    ephemeralPubKey,
  })

  if (
    params.expectedStealthAddress &&
    derived.stealthAddress !== params.expectedStealthAddress
  ) {
    throw new Error(
      `Derived stealth address (${derived.stealthAddress}) does not match expected (${params.expectedStealthAddress})`,
    )
  }

  const record: SolanaStealthAccountRecord = {
    address: derived.stealthAddress,
    keypair: derived.stealthKeypair,
    seed: derived.stealthSeed,
    ephemeralPubKey:
      typeof ephemeralPubKey === 'string' ? ephemeralPubKey : toHex(ephemeralPubKey),
    networkTag: params.networkTag ?? 'SOLD',
    discoveredAtMs: params.timestampMs ?? Date.now(),
    initialAmountLamports: amountLamports,
    txHash: params.txHash,
  }

  await keyringStore.put(record)
  return record
}
