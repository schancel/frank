/**
 * The EVM dex interface: what an exchange on an EVM chain must provide for the wallet to swap on
 * it. One interface per chain family. This one speaks EVM (calldata, allowances, gas limits,
 * receipts); Solana has its own, shaped for Solana, and neither pretends to be the other.
 *
 * An exchange is three things, kept apart:
 *  - a `dex` entry on its network's row in the chain registry (`chain/dex-entries.ts`): facts
 *    only, with `adapter` naming the class below by key and `enabled` saying whether it is
 *    offered;
 *  - one class per exchange protocol implementing `EvmDex` (`UniswapV4Dex` is the first);
 *  - composition, where the wallet is built, mapping the adapter key to the class explicitly
 *    and handing it the wallet. No class is named in configuration and none registers
 *    itself on import.
 *
 * A class is given the wallet typed as a narrow interface (`EvmDexWallet`) and nothing else:
 * reads of its chain, and the wallet's contract send from the main account (journaled before
 * signing, signed bytes kept before broadcast, re-sent as recorded on recovery). The record of
 * a swap is an argument of that send; the wallet keeps it and writes the note to self.
 *
 * To add an EVM exchange: add its entry type and data to `dex-entries.ts` and list it on the
 * network's row; write its class (the quote must come from the chain for the exact amount; a
 * plan must hold every transaction the swap needs, approvals for the exact amount only; the
 * received amount must be read from the receipt, never from the quote); add it to the
 * composition's map; run the live check against that network.
 */

import type { EvmDexToken, SwapVenue } from '../chain/dex-entries'
import type {
  ConsolidationNeed,
  SwapCost,
  SwapExecutionReader,
  SwapProgress,
  SwapResult,
  SwapTiming,
  SwapWallet,
} from './swap-execution'
import type { EncodedCall } from './uniswap-v4'

/** What a quote says, whatever the exchange. `route` is the exchange's own, opaque to callers. */
export interface EvmDexQuote {
  readonly tokenIn: EvmDexToken
  readonly tokenOut: EvmDexToken
  readonly amountIn: bigint
  /** What the account receives: the exchange's answer less any interface fee. */
  readonly amountOut: bigint
  /** What the pool pays out, before any interface fee. */
  readonly poolAmountOut: bigint
  readonly lpFeePpm: number
  readonly priceImpactPpm: number
  readonly interfaceFee?: { bps: number; amount: bigint }
  readonly quotedAtMs: number
  /** Serialisable. Recorded with the swap so it can be finished after a reload. */
  readonly route: unknown
}

/** The ordered transactions of one swap: approvals first, then the swap. */
export interface EvmDexPlan<Q extends EvmDexQuote = EvmDexQuote> {
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

/**
 * The wallet, as an exchange adapter sees it: reads of the adapter's own chain, and "send a
 * legacy transaction to a contract" from the main account. That send takes the call (to, data,
 * value) and a small record of what it is; the wallet selects the funds, signs, keeps the
 * signed transaction and the record, writes the note to self that carries the record,
 * broadcasts, and reports the outcome, the way a native send to a non-Frank address records
 * itself. An adapter never records anything and never sees a relay client.
 */
export interface EvmDexWallet extends SwapWallet {
  /** Reads of the wallet's chain. Cannot sign or submit. */
  readonly reader: SwapExecutionReader
}

/** A swap record names a transaction that the named account did not send to this exchange. */
export class SwapRecordMismatchError extends Error {
  constructor() {
    super('The recorded transaction is not a swap by this account on this exchange')
    this.name = 'SwapRecordMismatchError'
  }
}

export interface EvmDex<
  Q extends EvmDexQuote = EvmDexQuote,
  P extends EvmDexPlan<Q> = EvmDexPlan<Q>,
> {
  /** Its registry entry: id, display name, who maintains it, any interface fee. */
  readonly entry: SwapVenue
  readonly chainIdentifier: string
  /** The tokens it trades. `address: null` is the chain's native coin. */
  readonly tokens: readonly EvmDexToken[]
  /** The chain's answer for exactly this input. Throws `SwapNoRouteError` or
   * `SwapNoLiquidityError` when it cannot be filled; never returns an assumed price. */
  quote(input: {
    tokenIn: EvmDexToken
    tokenOut: EvmDexToken
    amountIn: bigint
  }): Promise<Q>
  /** The transactions for a quote, for one account, with a floor on what it receives. */
  plan(input: { quote: Q; slippageBps: number; account: string }): Promise<P>
  /** What the main account lacks for the plan and the wallet's other accounts must move in. */
  consolidation(input: {
    plan: P
    swapFee?: SwapCost['swapFee']
  }): Promise<ConsolidationNeed>
  /** The network fee of every transaction of the plan, as it will be charged. */
  cost(input: { plan: P; account: string; moveWei?: bigint }): Promise<SwapCost>
  /** Sends the plan through the wallet's contract send, the swap transaction with its record,
   * and reads the outcome (amount received, fees charged) from the receipts. */
  execute(input: {
    plan: P
    account: string
    consolidateWei?: bigint
    onProgress?: (progress: SwapProgress) => void
    timing?: SwapTiming
  }): Promise<SwapResult>
  /** What the chain says a recorded swap did, from its receipt alone. Sends nothing: for a
   * swap another frontend of the account made. Throws `SwapRecordMismatchError` when the
   * transaction was not sent by `account` to this exchange: a record is not believed over
   * the chain about whose swap it is. */
  observe(input: {
    transactionId: string
    account: string
    route: unknown
  }): Promise<SwapResult>
  /** Finishes a recorded swap: what the chain says it did, re-sending its same signed bytes
   * if the chain never saw it. */
  reconcile(input: {
    transactionId: string
    operationId: string
    account: string
    route: unknown
    call: { to: string; data: string; value: string }
    timing?: SwapTiming
  }): Promise<SwapResult>
}
