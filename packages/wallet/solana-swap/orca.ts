/**
 * Orca Whirlpools: read a pool from chain and build its `swap_v2` instruction.
 *
 * Account layout and instruction follow the deployed program
 * (https://github.com/orca-so/whirlpools, programs/whirlpool, `state/whirlpool.rs` and
 * `instructions/v2/swap.rs`). Nothing here computes an exchange rate: the expected output of a
 * swap is obtained by simulating this instruction on the cluster (see swap.ts).
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js'

import type { AccountData } from './spl'

const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
)
// First 8 bytes of sha256("account:Whirlpool") and sha256("global:swap_v2").
const WHIRLPOOL_DISCRIMINATOR = [0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09]
const SWAP_V2_DISCRIMINATOR = [0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]
const WHIRLPOOL_ACCOUNT_SIZE = 653
const TICKS_PER_ARRAY = 88
const MIN_TICK_INDEX = -443636
const MAX_TICK_INDEX = 443636
/** Pool fee rates are in hundredths of a basis point. */
const FEE_RATE_DENOMINATOR = 1_000_000n

export interface Whirlpool {
  readonly address: PublicKey
  readonly tickSpacing: number
  /** Trade fee in hundredths of a basis point (2000 = 0.2%). */
  readonly feeRate: number
  readonly liquidity: bigint
  /** Square root of the price of token A in token B, as a Q64.64 fixed-point number. */
  readonly sqrtPrice: bigint
  readonly tickCurrentIndex: number
  readonly tokenMintA: PublicKey
  readonly tokenVaultA: PublicKey
  readonly tokenMintB: PublicKey
  readonly tokenVaultB: PublicKey
}

function readUint(data: Uint8Array, offset: number, bytes: number): bigint {
  let value = 0n
  for (let i = bytes - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i])
  }
  return value
}

function writeUint(
  target: Uint8Array,
  offset: number,
  bytes: number,
  value: bigint,
) {
  for (let i = 0; i < bytes; i++) {
    target[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn)
  }
}

/** Decodes a pool account, refusing anything the configured program does not own. */
export function decodeWhirlpool(
  address: PublicKey,
  programId: PublicKey,
  account: AccountData | null,
): Whirlpool {
  if (!account) {
    throw new Error(`Pool ${address.toBase58()} does not exist on this network`)
  }
  if (
    !account.owner.equals(programId) ||
    account.data.length < WHIRLPOOL_ACCOUNT_SIZE ||
    WHIRLPOOL_DISCRIMINATOR.some((byte, i) => account.data[i] !== byte)
  ) {
    throw new Error(`${address.toBase58()} is not an Orca Whirlpool`)
  }
  const data = account.data
  return {
    address,
    tickSpacing: Number(readUint(data, 41, 2)),
    feeRate: Number(readUint(data, 45, 2)),
    liquidity: readUint(data, 49, 16),
    sqrtPrice: readUint(data, 65, 16),
    tickCurrentIndex: Number(BigInt.asIntN(32, readUint(data, 81, 4))),
    tokenMintA: new PublicKey(data.slice(101, 133)),
    tokenVaultA: new PublicKey(data.slice(133, 165)),
    tokenMintB: new PublicKey(data.slice(181, 213)),
    tokenVaultB: new PublicKey(data.slice(213, 245)),
  }
}

/** The pool's trade fee on an input amount, rounded up as the program does. */
export function whirlpoolTradeFee(
  pool: Whirlpool,
  inputAmount: bigint,
): bigint {
  const fee = inputAmount * BigInt(pool.feeRate)
  return (fee + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR
}

/**
 * What the input would buy at the pool's current price after the trade fee, with no price
 * movement. Used only to express price impact against the simulated output.
 */
export function whirlpoolOutputAtSpotPrice(
  pool: Whirlpool,
  inputAmount: bigint,
  aToB: boolean,
): bigint {
  const net = inputAmount - whirlpoolTradeFee(pool, inputAmount)
  const priceX128 = pool.sqrtPrice * pool.sqrtPrice
  return aToB ? (net * priceX128) >> 128n : (net << 128n) / priceX128
}

/** Start indexes of the three tick arrays a swap may cross, in the direction of the swap. */
export function swapTickArrayStartIndexes(
  pool: Pick<Whirlpool, 'tickCurrentIndex' | 'tickSpacing'>,
  aToB: boolean,
): number[] {
  const ticksInArray = TICKS_PER_ARRAY * pool.tickSpacing
  const startOf = (tick: number) =>
    Math.floor(tick / ticksInArray) * ticksInArray
  const minStart = startOf(MIN_TICK_INDEX)
  const maxStart = startOf(MAX_TICK_INDEX)
  // A swap that raises the price starts from the array holding the next tick up.
  const first = startOf(
    aToB ? pool.tickCurrentIndex : pool.tickCurrentIndex + pool.tickSpacing,
  )
  return [0, 1, 2].map(i =>
    Math.min(
      maxStart,
      Math.max(minStart, first + (aToB ? -i : i) * ticksInArray),
    ),
  )
}

async function findPda(
  programId: PublicKey,
  seeds: Uint8Array[],
): Promise<PublicKey> {
  const [address] = await PublicKey.findProgramAddress(seeds, programId)
  return address
}

/** Builds `swap_v2` for an exact input amount with a minimum acceptable output. */
export async function buildWhirlpoolSwapInstruction(params: {
  programId: PublicKey
  pool: Whirlpool
  owner: PublicKey
  ownerTokenAccountA: PublicKey
  ownerTokenAccountB: PublicKey
  tokenProgramA: PublicKey
  tokenProgramB: PublicKey
  aToB: boolean
  inputAmount: bigint
  minOutputAmount: bigint
}): Promise<TransactionInstruction> {
  const { programId, pool } = params
  const text = new TextEncoder()
  const poolSeed = pool.address.toBytes()
  const tickArrays = await Promise.all(
    swapTickArrayStartIndexes(pool, params.aToB).map(start =>
      findPda(programId, [
        text.encode('tick_array'),
        poolSeed,
        text.encode(start.toString()),
      ]),
    ),
  )
  const oracle = await findPda(programId, [text.encode('oracle'), poolSeed])

  const data = new Uint8Array(43)
  data.set(SWAP_V2_DISCRIMINATOR, 0)
  writeUint(data, 8, 8, params.inputAmount)
  writeUint(data, 16, 8, params.minOutputAmount)
  // bytes 24..40: sqrt price limit, zero = none (the minimum output bounds the trade instead)
  data[40] = 1 // the amount is the input amount
  data[41] = params.aToB ? 1 : 0
  data[42] = 0 // no remaining-accounts info

  const readonly = (pubkey: PublicKey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  })
  const writable = (pubkey: PublicKey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  })
  return new TransactionInstruction({
    programId,
    keys: [
      readonly(params.tokenProgramA),
      readonly(params.tokenProgramB),
      readonly(MEMO_PROGRAM_ID),
      { pubkey: params.owner, isSigner: true, isWritable: false },
      writable(pool.address),
      readonly(pool.tokenMintA),
      readonly(pool.tokenMintB),
      writable(params.ownerTokenAccountA),
      writable(pool.tokenVaultA),
      writable(params.ownerTokenAccountB),
      writable(pool.tokenVaultB),
      ...tickArrays.map(writable),
      writable(oracle),
    ],
    data,
  })
}
