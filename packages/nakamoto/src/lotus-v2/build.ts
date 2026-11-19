// A fee-aware Lotus v2 transaction builder: given the spends, the payment
// outputs, a change destination, a fee rule and (for rule (c)) the chain
// state, it signs the transaction paying the exact required fee.
//
// One pass suffices. The fee depends only on the transaction's serialized
// shape (its size and, under rule (c), C_tx). An output value is a fixed
// `u64`, and a signature's length is fixed by its mode, so the change amount
// and the signatures never change the shape. The only shape choice is whether
// a change output exists: the builder prices the transaction with it, and if
// what is left after that fee is below DUST_LIMIT (C14c) it prices the
// transaction without it and the remainder goes to the fee.

import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { isLotusV2LegacyCoin } from './legacy.js'
import { lotusV2RequiredFee } from './fee.js'
import type {
  LotusV2FeeBreakdown,
  LotusV2FeeChainState,
  LotusV2FeeRule,
} from './fee.js'
import { signLotusV2Transaction } from './sign.js'
import type { LotusV2SignedTransaction, LotusV2Spend } from './sign.js'
import { LotusV2FormatError, lotusV2MoneyRange } from './transaction.js'
import type { LotusV2Lock, LotusV2Output } from './transaction.js'

/** Where change goes: an output's lock without its value. */
export interface LotusV2ChangeDestination {
  readonly branches: readonly Uint8Array[]
  readonly paths: readonly (readonly number[])[]
}

export class LotusV2InsufficientFundsError extends Error {
  constructor(
    /** Native atoms the outputs and the fee need. */
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super(
      `Lotus v2: the inputs hold ${available} atoms; the outputs and fee need ${required}`,
    )
    this.name = 'LotusV2InsufficientFundsError'
  }
}

export class LotusV2FeeCeilingError extends Error {
  constructor(readonly fee: bigint, readonly ceiling: bigint) {
    super(`Lotus v2: the fee ${fee} exceeds the ceiling of ${ceiling} atoms`)
    this.name = 'LotusV2FeeCeilingError'
  }
}

export interface LotusV2BuiltTransaction {
  readonly signed: LotusV2SignedTransaction
  /** Native inputs minus native outputs: what the transaction pays. */
  readonly fee: bigint
  /** The rule's requirement for the final transaction; `fee >= breakdown.total`. */
  readonly breakdown: LotusV2FeeBreakdown
  /** The change output's index and value; absent when change was below dust. */
  readonly change?: { readonly index: number; readonly value: bigint }
  /** Sub-dust change added to the fee (0 when there is a change output). */
  readonly droppedChange: bigint
}

function nativeValue(coinOrOutput: {
  readonly value: bigint
  readonly tokenId?: Uint8Array
}): bigint {
  return coinOrOutput.tokenId === undefined ? coinOrOutput.value : 0n
}

/**
 * Build and sign a transaction that pays its exact fee under `rule`, with
 * change (if any) appended as the last output. `maxFee` is the caller's
 * ceiling: a fee above it, dropped sub-dust change included, is refused.
 */
export function buildLotusV2Transaction(params: {
  readonly chain: LotusV2ChainDescriptor
  readonly inputs: readonly LotusV2Spend[]
  readonly outputs: readonly LotusV2Output[]
  /** Omit to send every remaining atom to the fee (a sweep pays its fee from the outputs' side instead). */
  readonly change?: LotusV2ChangeDestination
  readonly rule: LotusV2FeeRule
  readonly state?: LotusV2FeeChainState
  readonly maxFee: bigint
  readonly lock?: LotusV2Lock
}): LotusV2BuiltTransaction {
  const { chain, rule, state, lock } = params
  if (typeof params.maxFee !== 'bigint' || !lotusV2MoneyRange(params.maxFee))
    throw new RangeError('maxFee must be an amount in MoneyRange')
  const dust = rule.dustLimit
  for (const output of params.outputs)
    if (!output.burn && output.tokenId === undefined && output.value < dust)
      throw new LotusV2FormatError('native output below DUST_LIMIT')
  const coins = params.inputs.map(spend => spend.coin)
  let available = 0n
  for (const coin of coins)
    available += isLotusV2LegacyCoin(coin) ? coin.value : nativeValue(coin)
  let spent = 0n
  for (const output of params.outputs) spent += nativeValue(output)
  const remainder = available - spent
  if (remainder < 0n) throw new LotusV2InsufficientFundsError(spent, available)

  const sign = (outputs: readonly LotusV2Output[]): LotusV2SignedTransaction =>
    signLotusV2Transaction({
      chain,
      inputs: params.inputs,
      outputs,
      ...(lock ? { lock } : {}),
    })
  const price = (signed: LotusV2SignedTransaction): LotusV2FeeBreakdown =>
    lotusV2RequiredFee({
      chain,
      tx: signed.transaction,
      rule,
      coins,
      ...(state ? { state } : {}),
    })
  const ceiling = (fee: bigint): void => {
    if (fee > params.maxFee)
      throw new LotusV2FeeCeilingError(fee, params.maxFee)
  }

  if (params.change) {
    const changeOutput = (value: bigint): LotusV2Output => ({
      value,
      branches: params.change?.branches ?? [],
      paths: params.change?.paths ?? [],
    })
    const draft = price(sign([...params.outputs, changeOutput(0n)]))
    const value = remainder - draft.total
    if (value >= dust) {
      ceiling(draft.total)
      const signed = sign([...params.outputs, changeOutput(value)])
      const breakdown = price(signed)
      // The shape did not change, so neither did the requirement.
      if (breakdown.total !== draft.total || breakdown.size !== draft.size)
        throw new Error('Lotus v2 builder: the fee moved with the change value')
      return {
        signed,
        fee: draft.total,
        breakdown,
        change: { index: params.outputs.length, value },
        droppedChange: 0n,
      }
    }
  }
  const signed = sign(params.outputs)
  const breakdown = price(signed)
  if (remainder < breakdown.total)
    throw new LotusV2InsufficientFundsError(spent + breakdown.total, available)
  ceiling(remainder)
  return {
    signed,
    fee: remainder,
    breakdown,
    droppedChange: remainder - breakdown.total,
  }
}
