/**
 * Uniswap v4 behind the EVM dex interface: the adapter class for registry entries whose
 * `adapter` is `uniswap-v4`. It is given its entry and the wallet as a narrow interface; it
 * finds nothing by itself.
 */
import { getChainRegistryEntry } from '../chain/chains-registry'
import type { UniswapV4Deployment } from '../chain/dex-entries'
import { SwapRecordMismatchError } from './evm-dex'
import type { EvmDex, EvmDexWallet } from './evm-dex'
import {
  fetchSwapQuote,
  planSwap,
  type SwapPlan,
  type SwapQuote,
} from './evm-swap'
import {
  consolidationNeeded,
  estimateSwapCost,
  executeSwap,
  readSwapResult,
  reconcileSwap,
} from './swap-execution'
import type { PoolRoute } from './uniswap-v4'

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

type Dex = EvmDex<SwapQuote, SwapPlan>

export class UniswapV4Dex implements Dex {
  constructor(
    readonly chainIdentifier: string,
    readonly entry: UniswapV4Deployment,
    private readonly wallet: EvmDexWallet,
    private readonly now: () => number = Date.now,
  ) {}

  get tokens() {
    return this.entry.tokens
  }

  /** How this network charges gas: a fact on its registry row, never assumed here. */
  private get gasChargedOn() {
    return getChainRegistryEntry(this.chainIdentifier)?.gasChargedOn ?? 'used'
  }

  quote(input: Parameters<Dex['quote']>[0]) {
    return fetchSwapQuote(this.wallet.reader, this.entry, input, this.now)
  }

  plan(input: Parameters<Dex['plan']>[0]) {
    return planSwap(this.wallet.reader, this.entry, input, this.now)
  }

  consolidation(input: Parameters<Dex['consolidation']>[0]) {
    return consolidationNeeded({
      reader: this.wallet.reader,
      wallet: this.wallet,
      ...input,
    })
  }

  cost(input: Parameters<Dex['cost']>[0]) {
    return estimateSwapCost({
      reader: this.wallet.reader,
      wallet: this.wallet,
      gasChargedOn: this.gasChargedOn,
      ...input,
    })
  }

  execute(input: Parameters<Dex['execute']>[0]) {
    const { plan, account } = input
    const { quote } = plan
    const asset = (token: SwapQuote['tokenIn']) => ({
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
    })
    return executeSwap({
      reader: this.wallet.reader,
      wallet: this.wallet,
      deployment: this.entry,
      plan,
      account,
      consolidateWei: input.consolidateWei,
      onProgress: input.onProgress,
      timing: input.timing,
      gasChargedOn: this.gasChargedOn,
      // What the swap is, handed to the wallet with the swap transaction. The wallet records
      // it and writes the note to self; this class does neither.
      record: {
        kind: 'swap',
        venueId: this.entry.id,
        account,
        assetIn: asset(quote.tokenIn),
        amountIn: quote.amountIn.toString(),
        assetOut: asset(quote.tokenOut),
        quotedAmountOut: quote.amountOut.toString(),
        minimumAmountOut: plan.minimumAmountOut.toString(),
        interfaceFeeAmount: (quote.interfaceFee?.amount ?? 0n).toString(),
        route: quote.route,
      },
    })
  }

  async observe(input: Parameters<Dex['observe']>[0]) {
    if (!isPoolRoute(input.route))
      throw new Error('The recorded swap does not belong to this exchange')
    const handle = { operationId: '', txHash: input.transactionId }
    const receipt = await this.wallet.reader.getTransactionReceipt(
      input.transactionId,
    )
    if (!receipt) return { status: 'pending' as const, ...handle }
    const same = (a: string | null | undefined, b: string) =>
      typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
    if (
      !same(receipt.from, input.account) ||
      !same(receipt.to, this.entry.universalRouter)
    )
      throw new SwapRecordMismatchError()
    return readSwapResult({
      reader: this.wallet.reader,
      deployment: this.entry,
      route: input.route,
      account: input.account,
      handle,
      receipt,
    })
  }

  reconcile(input: Parameters<Dex['reconcile']>[0]) {
    if (!isPoolRoute(input.route))
      throw new Error('The recorded swap does not belong to this exchange')
    return reconcileSwap({
      reader: this.wallet.reader,
      wallet: this.wallet,
      deployment: this.entry,
      route: input.route,
      account: input.account,
      swap: {
        to: input.call.to,
        data: input.call.data,
        value: BigInt(input.call.value),
      },
      handle: { operationId: input.operationId, txHash: input.transactionId },
      timing: input.timing,
    })
  }
}
