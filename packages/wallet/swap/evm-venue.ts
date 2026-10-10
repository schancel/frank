/**
 * The EVM swap venue interface: what a venue on an EVM chain must provide for the wallet to
 * swap on it. One interface per chain family. This one speaks EVM (calldata, allowances, gas
 * limits, receipts); a Solana venue has its own, shaped for Solana, and neither pretends to be
 * the other.
 *
 * To add an EVM venue:
 *  1. list it in `chain/dex-deployments.ts` under its canonical chain identifier, with addresses
 *     confirmed on chain, and run the live check against that network;
 *  2. implement `EvmSwapVenue` for its protocol: `quote` must come from the chain for the exact
 *     amount; `plan` must return every transaction the swap needs, approvals for the exact
 *     amount only; `observe` must read the received amount from the receipt, never the quote;
 *  3. return it from `evmSwapVenue` for that protocol.
 * Execution is not the venue's: every transaction a plan returns is sent by `executeSwap`
 * through the wallet's recorded contract-call path, the same for every venue.
 */

import {
  getEvmDexDeployment,
  type EvmDexToken,
  type SwapVenue,
} from '../chain/dex-deployments'
import {
  fetchSwapQuote,
  planSwap,
  type SwapChainReader,
  type SwapPlan,
  type SwapQuote,
} from './evm-swap'
import {
  consolidationNeeded,
  estimateSwapCost,
  executeSwap,
  reconcileSwap,
  type ConsolidationNeed,
  type SwapCost,
  type SwapExecutionReader,
  type SwapProgress,
  type SwapResult,
  type SwapTiming,
  type SwapWallet,
} from './swap-execution'
import type { EncodedCall, PoolRoute } from './uniswap-v4'

/** What a quote says, whatever the venue. `route` is the venue's own and opaque to callers. */
export interface EvmVenueQuote {
  readonly tokenIn: EvmDexToken
  readonly tokenOut: EvmDexToken
  readonly amountIn: bigint
  /** What the account receives: the venue's answer less any interface fee. */
  readonly amountOut: bigint
  /** What the pool pays out, before any interface fee. */
  readonly poolAmountOut: bigint
  readonly lpFeePpm: number
  readonly priceImpactPpm: number
  readonly interfaceFee?: { bps: number; amount: bigint }
  readonly quotedAtMs: number
  /** Serialisable. Stored with a pending swap so `reconcile` can finish it after a reload. */
  readonly route: unknown
}

/** The ordered transactions of one swap: approvals first, then the swap. */
export interface EvmVenuePlan<Q extends EvmVenueQuote = EvmVenueQuote> {
  readonly quote: Q
  readonly slippageBps: number
  readonly minimumAmountOut: bigint
  /** Unix seconds after which the swap transaction is refused on chain. */
  readonly deadline: number
  readonly approvals: readonly {
    readonly kind: string
    readonly call: EncodedCall
  }[]
  readonly swap: EncodedCall
}

export interface EvmSwapVenue<
  Q extends EvmVenueQuote = EvmVenueQuote,
  P extends EvmVenuePlan<Q> = EvmVenuePlan<Q>,
> {
  /** Its configuration entry: id, display name, who maintains it, any interface fee. */
  readonly venue: SwapVenue
  /** The tokens it trades. `address: null` is the chain's native coin. */
  readonly tokens: readonly EvmDexToken[]
  /** The chain's answer for exactly this input. Throws `SwapNoRouteError` or
   * `SwapNoLiquidityError` when it cannot be filled; never returns an assumed price. */
  quote(
    reader: SwapChainReader,
    input: { tokenIn: EvmDexToken; tokenOut: EvmDexToken; amountIn: bigint },
  ): Promise<Q>
  /** The transactions for a quote, for one account, with a floor on what it receives. */
  plan(
    reader: SwapChainReader,
    input: { quote: Q; slippageBps: number; account: string },
  ): Promise<P>
  /** What the main account lacks for the plan and the wallet's other accounts must move in. */
  consolidation(input: {
    reader: SwapChainReader
    wallet: Pick<SwapWallet, 'getContractCallFunds'>
    plan: P
    swapFee?: SwapCost['swapFee']
  }): Promise<ConsolidationNeed>
  /** The network fee of every transaction of the plan, as it will be charged. */
  cost(input: {
    reader: SwapChainReader
    wallet: Pick<SwapWallet, 'estimateLegacyFee'>
    plan: P
    account: string
    moveWei?: bigint
  }): Promise<SwapCost>
  /** Sends the plan through the wallet's recorded contract-call path and observes the result:
   * the received amount and the fees charged come from the receipts. */
  execute(input: {
    reader: SwapExecutionReader
    wallet: SwapWallet
    plan: P
    account: string
    consolidateWei?: bigint
    onProgress?: (progress: SwapProgress) => void
    onSigned?: (signed: {
      operationId: string
      txHash: string
    }) => Promise<void>
    timing?: SwapTiming
  }): Promise<SwapResult>
  /** Finishes a swap recorded as submitted, from its stored `route` and call. */
  reconcile(input: {
    reader: SwapExecutionReader
    wallet: Pick<
      SwapWallet,
      'resumeNativeOperation' | 'reobserveNativeOperations'
    >
    route: unknown
    account: string
    swap: EncodedCall
    handle: { operationId: string; txHash: string }
    timing?: SwapTiming
  }): Promise<SwapResult>
}

function isPoolRoute(route: unknown): route is PoolRoute {
  const r = route as {
    key?: Record<string, unknown>
    zeroForOne?: unknown
  } | null
  return (
    typeof r?.zeroForOne === 'boolean' &&
    typeof r.key?.currency0 === 'string' &&
    typeof r.key.currency1 === 'string' &&
    typeof r.key.fee === 'number' &&
    typeof r.key.tickSpacing === 'number' &&
    typeof r.key.hooks === 'string'
  )
}

/** Uniswap v4 behind the venue interface: the first EVM venue. */
export function uniswapV4Venue(
  deployment: NonNullable<ReturnType<typeof getEvmDexDeployment>>,
): EvmSwapVenue<SwapQuote, SwapPlan> {
  return {
    venue: deployment,
    tokens: deployment.tokens,
    quote: (reader, input) => fetchSwapQuote(reader, deployment, input),
    plan: (reader, input) => planSwap(reader, deployment, input),
    consolidation: input => consolidationNeeded(input),
    cost: input => estimateSwapCost(input),
    execute: input => executeSwap({ ...input, deployment }),
    reconcile: input => {
      if (!isPoolRoute(input.route))
        throw new Error('The stored swap does not belong to this venue')
      return reconcileSwap({ ...input, route: input.route, deployment })
    },
  }
}

/**
 * The venue with this id on this chain, or the chain's first when no id is given. Undefined
 * when the chain has no such venue: nothing is substituted.
 */
export function evmSwapVenue(
  chainIdentifier: string,
  venueId?: string,
): EvmSwapVenue<SwapQuote, SwapPlan> | undefined {
  const deployment = getEvmDexDeployment(chainIdentifier, venueId)
  if (!deployment) return undefined
  // One protocol today. A second is a second case here.
  return deployment.protocol === 'uniswap-v4'
    ? uniswapV4Venue(deployment)
    : undefined
}
