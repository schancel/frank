// Lotus v2 fees: what a transaction must pay, from the spec (Lotus repository
// docs/lotus-v2/consensus.md C14a, C14b, C16, C24, C25 and
// decisions/resources-and-parameters.md P05 "Minimum byte fees", "Parabolic
// transaction and block cost curves", "The subsidy index" and "Relay and
// wallet fee policy").
//
// Two rules, picked by configuration:
// - `byte-floor`: what lotusd v0.34.1 (ea95b1631f2c) enforces today, per
//   transaction: fee >= max(ByteFee(size), 2 * DUST_LIMIT * token outputs),
//   unindexed (src/lotus_v2/monetary.cpp OrdinaryFeeFloor; mempool
//   `bad-txns-fee-floor`).
// - `indexed-cu-share`, rule (c): C14b's byte fee indexed by sqrt(I) of the
//   lagged index, and the transaction's cu share of the block burn floor R
//   (linear part indexed by the next block's own index, plus its share of Q).
//   Only the byte floor and the token burn are validity rules; the cu share is
//   what a miner needs to include the transaction without burning subsidy.
//
// Every amount is a bigint number of atoms. Chain state (E, the indices) is
// supplied by the caller: no RPC returns it yet.

import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { LOTUS_V2_APPROVED_COST_SCHEDULE, lotusV2StaticCost } from './cost.js'
import type {
  LotusV2CostSchedule,
  LotusV2PendingCostItem,
  LotusV2StaticCost,
} from './cost.js'
import type { LotusV2Coin } from './legacy.js'
import { encodeLotusV2Transaction } from './transaction.js'
import type { LotusV2Transaction } from './transaction.js'

/** C14b `MIN_FEE_PER_KB`: atoms per 1,000 bytes. */
export const LOTUS_V2_MIN_FEE_PER_KB = 1000n
/** C14a/C14c `DUST_LIMIT`, atoms; frozen consensus minimum. */
export const LOTUS_V2_DUST_LIMIT = 546n

/**
 * A subsidy index `I = S * W_g / (T_g * W)`: `subsidy` is a block's `S = B + T`
 * and `work` its parent's per-block work. Both are in the parent's
 * `MonetaryState`.
 */
export interface LotusV2FeeIndex {
  readonly subsidy: bigint
  readonly work: bigint
}

/** The genesis tail anchors `T_g` (atoms) and `W_g` that calibrate the index. */
export interface LotusV2IndexAnchors {
  readonly genesisTail: bigint
  readonly genesisWork: bigint
}

/** The rule lotusd v0.34.1 enforces: the unindexed byte floor and the token burn. */
export interface LotusV2ByteFloorRule {
  readonly kind: 'byte-floor'
  readonly minFeePerKb: bigint
  readonly dustLimit: bigint
}

/** Rule (c): the indexed byte floor and the cu share of the block burn floor. */
export interface LotusV2IndexedCuShareRule {
  readonly kind: 'indexed-cu-share'
  readonly minFeePerKb: bigint
  readonly dustLimit: bigint
  readonly anchors: LotusV2IndexAnchors
  readonly schedule: LotusV2CostSchedule
  /**
   * Added to the cu share (not the byte floor), in basis points, for drift of
   * E between estimate and inclusion. 200 = 2%.
   */
  readonly marginBasisPoints: bigint
}

export type LotusV2FeeRule = LotusV2ByteFloorRule | LotusV2IndexedCuShareRule

/** Regtest lotusd v0.34.1: 1,000 atoms/kB and 546 atoms dust (network_profile.h). */
export const LOTUS_V2_REGTEST_NODE_FEE_RULE: LotusV2ByteFloorRule =
  Object.freeze({
    kind: 'byte-floor' as const,
    minFeePerKb: LOTUS_V2_MIN_FEE_PER_KB,
    dustLimit: LOTUS_V2_DUST_LIMIT,
  })

/**
 * Rule (c) with the approved schedule and the launch anchors (C16: T_g =
 * 378 XPI, W_g for target bits 0x1a280830, "still recommended"). No node
 * enforces it yet; a network that does states its own anchors.
 */
export const LOTUS_V2_SPEC_FEE_RULE: LotusV2IndexedCuShareRule = Object.freeze({
  kind: 'indexed-cu-share' as const,
  minFeePerKb: LOTUS_V2_MIN_FEE_PER_KB,
  dustLimit: LOTUS_V2_DUST_LIMIT,
  anchors: Object.freeze({
    genesisTail: 378_000_000n,
    genesisWork: 1_800_000_641_450_944n,
  }),
  schedule: LOTUS_V2_APPROVED_COST_SCHEDULE,
  marginBasisPoints: 200n,
})

/** Chain state rule (c) needs. The caller reads it from the tip until an RPC returns it. */
export interface LotusV2FeeChainState {
  /** `ema_block_cost` E of the tip's `MonetaryState`, cu. */
  readonly ema: bigint
  /** C14b index of block `a = max(1, h - COINBASE_MATURITY)` for the block `h` the tx targets. */
  readonly byteFeeIndex: LotusV2FeeIndex
  /** The target block's own index `I_n`, which prices the cu share; defaults to `byteFeeIndex`. */
  readonly cuIndex?: LotusV2FeeIndex
  /** Expected cost of the rest of the block, cu, for the share of Q; defaults to 0. */
  readonly blockCostCu?: bigint
}

export class LotusV2FeeError extends Error {
  constructor(readonly reason: string) {
    super(`Lotus v2 fee: ${reason}`)
    this.name = 'LotusV2FeeError'
  }
}

function nonnegative(value: bigint, what: string): bigint {
  if (typeof value !== 'bigint' || value < 0n)
    throw new LotusV2FeeError(`${what} must be a nonnegative bigint`)
  return value
}

function positive(value: bigint, what: string): bigint {
  if (nonnegative(value, what) === 0n)
    throw new LotusV2FeeError(`${what} must be positive`)
  return value
}

/** Floor integer square root. */
export function lotusV2Isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative value')
  if (n < 2n) return n
  let x = BigInt(Math.floor(Math.sqrt(Number(n))))
  while (x * x > n) x -= 1n
  while ((x + 1n) * (x + 1n) <= n) x += 1n
  return x
}

function ceilSqrt(n: bigint): bigint {
  const r = lotusV2Isqrt(n)
  return r * r < n ? r + 1n : r
}

/** P05 `ByteFee(b) = ceil(MIN_FEE_PER_KB * b / 1000)`. */
export function lotusV2ByteFee(
  size: number | bigint,
  minFeePerKb: bigint = LOTUS_V2_MIN_FEE_PER_KB,
): bigint {
  const b = nonnegative(BigInt(size), 'byte count')
  return (nonnegative(minFeePerKb, 'MIN_FEE_PER_KB') * b + 999n) / 1000n
}

/** `floor(floor(v^2 * S * W_g / W) / T_g) = floor(v^2 * I)`, the P05 radicand. */
function indexRadicand(
  v: bigint,
  index: LotusV2FeeIndex,
  anchors: LotusV2IndexAnchors,
): bigint {
  nonnegative(index.subsidy, 'index subsidy')
  positive(index.work, 'index work')
  positive(anchors.genesisTail, 'T_g')
  positive(anchors.genesisWork, 'W_g')
  return (
    (v * v * index.subsidy * anchors.genesisWork) /
    index.work /
    anchors.genesisTail
  )
}

/** C14b `IndexedByteFee`: the ceiling square root of `floor(ByteFee(b)^2 * I)`. */
export function lotusV2IndexedByteFee(
  size: number | bigint,
  index: LotusV2FeeIndex,
  anchors: LotusV2IndexAnchors,
  minFeePerKb: bigint = LOTUS_V2_MIN_FEE_PER_KB,
): bigint {
  return ceilSqrt(
    indexRadicand(lotusV2ByteFee(size, minFeePerKb), index, anchors),
  )
}

/** C14a: `2 * DUST_LIMIT` per token-bearing output created, burned in full. */
export function lotusV2TokenOutputBurn(
  tokenOutputs: number,
  dustLimit: bigint = LOTUS_V2_DUST_LIMIT,
): bigint {
  if (!Number.isInteger(tokenOutputs) || tokenOutputs < 0)
    throw new LotusV2FeeError('token output count')
  return 2n * nonnegative(dustLimit, 'DUST_LIMIT') * BigInt(tokenOutputs)
}

/**
 * P05 concentration term `Q = max(C^2 >> S_quad, floor(S * e^2 / E_min^2))`,
 * `e = max(0, C - E_min)`, `S` the block subsidy. `up` rounds both divisions up.
 */
export function lotusV2Concentration(
  cost: bigint,
  subsidy: bigint,
  schedule: LotusV2CostSchedule,
  up = false,
): bigint {
  const div = (a: bigint, b: bigint): bigint => (up ? (a + b - 1n) / b : a / b)
  const excess = cost > schedule.emaMin ? cost - schedule.emaMin : 0n
  const fixed = div(cost * cost, 1n << schedule.quadShift)
  const counted = div(
    subsidy * excess * excess,
    schedule.emaMin * schedule.emaMin,
  )
  return fixed > counted ? fixed : counted
}

/** A transaction's share of the block burn floor, atoms (fee terms, so twice the burn). */
export interface LotusV2CuShare {
  /** `2 * ceil(ceil((C_tx * M) / 2^S_linear) * sqrt(I_n))`. */
  readonly linear: bigint
  /** `2 * (Q_up(base + C_tx) - Q_floor(base))`. */
  readonly concentration: bigint
}

/**
 * The cu share (P05 "Relay and wallet fee policy", lotus-86 ruling
 * 2026-11-19): C16 burns half of the non-token fee, so the fee carries twice
 * the transaction's part of R. Rounded up throughout.
 */
export function lotusV2CuShare(
  transactionCost: bigint,
  state: LotusV2FeeChainState,
  anchors: LotusV2IndexAnchors,
  schedule: LotusV2CostSchedule = LOTUS_V2_APPROVED_COST_SCHEDULE,
): LotusV2CuShare {
  nonnegative(transactionCost, 'C_tx')
  const ema = nonnegative(state.ema, 'E')
  const index = state.cuIndex ?? state.byteFeeIndex
  const m = ema > schedule.emaMin ? ema : schedule.emaMin
  const unit = 1n << schedule.linearShift
  const linear = (transactionCost * m + unit - 1n) / unit
  const indexed = ceilSqrt(indexRadicand(linear, index, anchors))
  const base = nonnegative(state.blockCostCu ?? 0n, 'block cost')
  const q =
    lotusV2Concentration(
      base + transactionCost,
      index.subsidy,
      schedule,
      true,
    ) - lotusV2Concentration(base, index.subsidy, schedule, false)
  return { linear: 2n * indexed, concentration: 2n * q }
}

export interface LotusV2FeeBreakdown {
  readonly rule: LotusV2FeeRule['kind']
  /** Complete serialized size, bytes. */
  readonly size: number
  readonly tokenOutputs: number
  /** C14b floor under the rule: unindexed (`byte-floor`) or indexed (rule (c)). */
  readonly byteFloor: bigint
  /** C14a. */
  readonly tokenBurn: bigint
  /** `max(byteFloor, tokenBurn)`: the per-transaction validity rule. */
  readonly consensusFloor: bigint
  /** Rule (c) only; zero under `byte-floor`. */
  readonly cuShare: bigint
  readonly qShare: bigint
  /** The margin added to the cu share. */
  readonly margin: bigint
  /** What to pay: `max(consensusFloor, tokenBurn + cuShare + qShare + margin)`. */
  readonly total: bigint
  /** Rule (c) only. */
  readonly cost?: LotusV2StaticCost
  /** Spec items the result depends on that are not final. */
  readonly pending: readonly LotusV2PendingCostItem[]
}

function tokenOutputCount(tx: LotusV2Transaction): number {
  return tx.outputs.filter(o => o.tokenId !== undefined).length
}

/**
 * The fee `tx` must pay under `rule`. `coins[i]` is the output input `i`
 * spends (rule (c) needs it for C_tx); `state` is required by rule (c).
 */
export function lotusV2RequiredFee(params: {
  readonly chain: LotusV2ChainDescriptor
  readonly tx: LotusV2Transaction
  readonly rule: LotusV2FeeRule
  readonly coins?: readonly (LotusV2Coin | undefined)[]
  readonly state?: LotusV2FeeChainState
}): LotusV2FeeBreakdown {
  const { chain, tx, rule } = params
  const tokenOutputs = tokenOutputCount(tx)
  const tokenBurn = lotusV2TokenOutputBurn(tokenOutputs, rule.dustLimit)
  if (rule.kind === 'byte-floor') {
    const size = encodeLotusV2Transaction(chain, tx).length
    const byteFloor = lotusV2ByteFee(size, rule.minFeePerKb)
    const consensusFloor = byteFloor > tokenBurn ? byteFloor : tokenBurn
    return {
      rule: rule.kind,
      size,
      tokenOutputs,
      byteFloor,
      tokenBurn,
      consensusFloor,
      cuShare: 0n,
      qShare: 0n,
      margin: 0n,
      total: consensusFloor,
      pending: [],
    }
  }
  if (rule.kind !== 'indexed-cu-share')
    throw new LotusV2FeeError(
      `unknown fee rule ${String((rule as { kind: unknown }).kind)}`,
    )
  const state = params.state
  if (state === undefined)
    throw new LotusV2FeeError(
      'rule (c) needs the chain state (E and the subsidy index)',
    )
  const cost = lotusV2StaticCost(chain, tx, params.coins ?? [], rule.schedule)
  const byteFloor = lotusV2IndexedByteFee(
    cost.size,
    state.byteFeeIndex,
    rule.anchors,
    rule.minFeePerKb,
  )
  const consensusFloor = byteFloor > tokenBurn ? byteFloor : tokenBurn
  const share = lotusV2CuShare(
    cost.transactionCost,
    state,
    rule.anchors,
    rule.schedule,
  )
  const shares = share.linear + share.concentration
  const bps = nonnegative(rule.marginBasisPoints, 'margin')
  const margin = (shares * bps + 9999n) / 10000n
  const priced = tokenBurn + shares + margin
  return {
    rule: rule.kind,
    size: cost.size,
    tokenOutputs,
    byteFloor,
    tokenBurn,
    consensusFloor,
    cuShare: share.linear,
    qShare: share.concentration,
    margin,
    total: priced > consensusFloor ? priced : consensusFloor,
    cost,
    pending: cost.pending,
  }
}
