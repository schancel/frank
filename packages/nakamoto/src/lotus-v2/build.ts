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
//
// Pricing therefore needs no signature: `lotusV2PriceShape` prices inputs and
// outputs by kind from placeholder witnesses of the exact lengths, which is
// what coin selection uses to price a candidate set under rule (c). The
// builder prices the same way, signs once, and checks the signed transaction
// prices identically. Signing verifies every signature before bytes return.

import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { lotusV2RequiredFee } from './fee.js'
import type {
  LotusV2FeeBreakdown,
  LotusV2FeeChainState,
  LotusV2FeeRule,
} from './fee.js'
import { lotusV2BranchLeaf, lotusV2BranchProofRoot } from './hash.js'
import { isLotusV2LegacyCoin } from './legacy.js'
import type { LotusV2Coin, LotusV2LegacyCoin } from './legacy.js'
import { lotusV2SignatureOperand, signLotusV2Transaction } from './sign.js'
import type {
  LotusV2SignedTransaction,
  LotusV2SigningMode,
  LotusV2Spend,
} from './sign.js'
import { lotusV2KeyhashTemplate } from './template.js'
import type { LotusV2SignatureTemplate } from './template.js'
import {
  LOTUS_V2_NO_LOCK,
  LOTUS_V2_SEQUENCE_FINAL,
  LotusV2FormatError,
  lotusV2MoneyRange,
} from './transaction.js'
import type {
  LotusV2Input,
  LotusV2Lock,
  LotusV2Output,
  LotusV2Transaction,
} from './transaction.js'

/**
 * An input as pricing sees it: what it spends and how, without a signer.
 * `keyhash` is a type-1 address coin (Frank's wallet coins), native or
 * token-bearing; `template` any one-branch template spend of a known coin
 * (an HTLC branch, a public-key program); `legacy-p2pkh` a legacy coin through
 * the bridge. Mint inputs are not priced here.
 */
export type LotusV2InputShape =
  | {
      readonly kind: 'keyhash'
      readonly mode?: LotusV2SigningMode
      readonly token?: boolean
    }
  | {
      readonly kind: 'template'
      readonly coin: LotusV2Output
      readonly template: LotusV2SignatureTemplate
      readonly siblings?: readonly Uint8Array[]
      readonly mode?: LotusV2SigningMode
    }
  | {
      readonly kind: 'legacy-p2pkh'
      readonly coin: LotusV2LegacyCoin
      readonly mode?: LotusV2SigningMode
    }

/** An output as pricing sees it: a type-1 address output, or an exact output. */
export type LotusV2OutputShape =
  | { readonly kind: 'keyhash'; readonly token?: boolean }
  | { readonly kind: 'output'; readonly output: LotusV2Output }

/** A placeholder of the right length: pricing checks neither keys nor token ids. */
const PLACEHOLDER = new Uint8Array(32).fill(0x01)

function keyhashLock(
  chain: LotusV2ChainDescriptor,
  token: boolean | undefined,
): { template: LotusV2SignatureTemplate; output: LotusV2Output } {
  const template = lotusV2KeyhashTemplate(PLACEHOLDER)
  const output: LotusV2Output = {
    value: 0n,
    branches: [lotusV2BranchLeaf(chain, template.script)],
    paths: [[0]],
    ...(token ? { tokenId: PLACEHOLDER } : {}),
  }
  return { template, output }
}

interface PricedInput {
  readonly coin: LotusV2Coin
  readonly template?: LotusV2SignatureTemplate
  readonly siblings?: readonly Uint8Array[]
  readonly mode?: LotusV2SigningMode
  readonly prevTxid?: Uint8Array
  readonly prevIndex?: number
  readonly sequence?: number
  /** Legacy only: the 33-byte key the witness reveals. */
  readonly publicKey?: Uint8Array
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The transaction as signing lays it out, with zero signatures of the same lengths. */
function placeholderTransaction(
  chain: LotusV2ChainDescriptor,
  inputs: readonly PricedInput[],
  outputs: readonly LotusV2Output[],
  lock: LotusV2Lock | undefined,
): LotusV2Transaction {
  const spends: LotusV2Input[] = inputs.map((input, index) => {
    const operand = lotusV2SignatureOperand(new Uint8Array(64), input.mode ?? 0)
    const common = {
      kind: 'spend' as const,
      prevTxid: input.prevTxid ?? new Uint8Array(32),
      // Distinct placeholder outpoints; an outpoint is fixed-width.
      prevIndex: input.prevIndex ?? index,
      sequence: input.sequence ?? LOTUS_V2_SEQUENCE_FINAL,
    }
    const coin = input.coin
    if (isLotusV2LegacyCoin(coin))
      return {
        ...common,
        pathIndex: 0,
        witnesses: [
          {
            script: new Uint8Array(0),
            siblings: [],
            arguments: [operand, input.publicKey ?? new Uint8Array(33)],
          },
        ],
      }
    const template = input.template
    if (template === undefined)
      throw new LotusV2FormatError('a V2 coin is priced with its template')
    const siblings = input.siblings ?? []
    const root = lotusV2BranchProofRoot(
      chain,
      lotusV2BranchLeaf(chain, template.script),
      siblings,
    )
    const pathIndex = coin.paths.findIndex(
      path =>
        path.length === 1 &&
        equal(coin.branches[path[0] as number] as Uint8Array, root),
    )
    if (pathIndex < 0)
      throw new LotusV2FormatError(
        'the template is not a one-branch path of the coin',
      )
    return {
      ...common,
      pathIndex,
      witnesses: [
        {
          script: template.script,
          siblings,
          arguments: template.arguments(operand),
        },
      ],
    }
  })
  return { lock: lock ?? LOTUS_V2_NO_LOCK, inputs: spends, outputs }
}

function priceInputs(
  params: {
    readonly chain: LotusV2ChainDescriptor
    readonly rule: LotusV2FeeRule
    readonly state?: LotusV2FeeChainState
    readonly lock?: LotusV2Lock
  },
  inputs: readonly PricedInput[],
  outputs: readonly LotusV2Output[],
): LotusV2FeeBreakdown {
  return lotusV2RequiredFee({
    chain: params.chain,
    tx: placeholderTransaction(params.chain, inputs, outputs, params.lock),
    rule: params.rule,
    coins: inputs.map(input => input.coin),
    ...(params.state ? { state: params.state } : {}),
  })
}

/**
 * The fee a transaction of this shape requires under `rule`, without signing:
 * its exact size and, under rule (c), its exact C_tx. Values do not matter
 * (an amount is a fixed `u64`), nor do outpoints. A change output is one more
 * output in `outputs`.
 */
export function lotusV2PriceShape(params: {
  readonly chain: LotusV2ChainDescriptor
  readonly inputs: readonly LotusV2InputShape[]
  readonly outputs: readonly LotusV2OutputShape[]
  readonly rule: LotusV2FeeRule
  readonly state?: LotusV2FeeChainState
  readonly lock?: LotusV2Lock
}): LotusV2FeeBreakdown {
  const { chain } = params
  const inputs = params.inputs.map((shape): PricedInput => {
    switch (shape.kind) {
      case 'keyhash': {
        const { template, output } = keyhashLock(chain, shape.token)
        return { coin: output, template, mode: shape.mode ?? 0 }
      }
      case 'template':
      case 'legacy-p2pkh':
        return shape
      default:
        throw new LotusV2FormatError(
          `unknown input shape ${String((shape as { kind: unknown }).kind)}`,
        )
    }
  })
  const outputs = params.outputs.map((shape): LotusV2Output => {
    switch (shape.kind) {
      case 'keyhash':
        return keyhashLock(chain, shape.token).output
      case 'output':
        return shape.output
      default:
        throw new LotusV2FormatError(
          `unknown output shape ${String((shape as { kind: unknown }).kind)}`,
        )
    }
  })
  return priceInputs(params, inputs, outputs)
}

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

  const estimate = (outputs: readonly LotusV2Output[]): LotusV2FeeBreakdown =>
    priceInputs(params, params.inputs, outputs)
  // Sign once the shape is chosen; the signed transaction must price exactly
  // as its placeholder did (the shape is fixed, so anything else is a bug).
  const sign = (
    outputs: readonly LotusV2Output[],
    expected: LotusV2FeeBreakdown,
  ): { signed: LotusV2SignedTransaction; breakdown: LotusV2FeeBreakdown } => {
    const signed = signLotusV2Transaction({
      chain,
      inputs: params.inputs,
      outputs,
      ...(lock ? { lock } : {}),
    })
    const breakdown = lotusV2RequiredFee({
      chain,
      tx: signed.transaction,
      rule,
      coins,
      ...(state ? { state } : {}),
    })
    if (breakdown.total !== expected.total || breakdown.size !== expected.size)
      throw new Error('Lotus v2 builder: the signed fee differs from its shape')
    return { signed, breakdown }
  }
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
    const withChange = estimate([...params.outputs, changeOutput(0n)])
    const value = remainder - withChange.total
    if (value >= dust) {
      ceiling(withChange.total)
      const { signed, breakdown } = sign(
        [...params.outputs, changeOutput(value)],
        withChange,
      )
      return {
        signed,
        fee: withChange.total,
        breakdown,
        change: { index: params.outputs.length, value },
        droppedChange: 0n,
      }
    }
  }
  const withoutChange = estimate(params.outputs)
  if (remainder < withoutChange.total)
    throw new LotusV2InsufficientFundsError(
      spent + withoutChange.total,
      available,
    )
  ceiling(remainder)
  const { signed, breakdown } = sign(params.outputs, withoutChange)
  return {
    signed,
    fee: remainder,
    breakdown,
    droppedChange: remainder - breakdown.total,
  }
}
