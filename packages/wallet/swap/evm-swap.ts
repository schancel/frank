/**
 * Reads a swap needs from the chain: balances, allowances, a quote, a gas estimate. Every number
 * returned here came from a node; nothing is assumed, cached or defaulted.
 */

import { getAddress } from 'ethers'
import type { EvmDexToken, UniswapV4Deployment } from '../chain/dex-deployments'
import {
  approvalSteps,
  classifySwapRevert,
  currencyOf,
  decodeQuoteResult,
  encodeQuoteCall,
  encodeSwap,
  erc20Interface,
  interfaceFeeAmount,
  minimumOutput,
  outputAtMidPrice,
  permit2Interface,
  poolId,
  priceImpactPpm,
  routesFor,
  stateViewInterface,
  type AllowanceState,
  type ApprovalStep,
  type EncodedCall,
  type PoolRoute,
  type SwapRevertReason,
} from './uniswap-v4'

/** The node calls a swap makes. An ethers `Provider` satisfies it. */
export interface SwapChainReader {
  call(tx: {
    to: string
    data: string
    from?: string
    value?: bigint
    /** Evaluate at this block instead of the latest. */
    blockTag?: number
  }): Promise<string>
  estimateGas(tx: {
    to: string
    data: string
    value: bigint
    from: string
  }): Promise<bigint>
  getBalance(address: string): Promise<bigint>
  getFeeData(): Promise<{
    maxFeePerGas: bigint | null
    gasPrice: bigint | null
    maxPriorityFeePerGas?: bigint | null
  }>
  /** The latest block's base fee, for what a transaction will actually be charged. */
  getBlock?(tag: 'latest'): Promise<{ baseFeePerGas: bigint | null } | null>
}

export class SwapNoRouteError extends Error {
  constructor(message = 'No pool trades this pair') {
    super(message)
    this.name = 'SwapNoRouteError'
  }
}
export class SwapNoLiquidityError extends Error {
  constructor(message = 'The pool cannot fill this amount') {
    super(message)
    this.name = 'SwapNoLiquidityError'
  }
}

export interface SwapQuote {
  readonly tokenIn: EvmDexToken
  readonly tokenOut: EvmDexToken
  readonly amountIn: bigint
  /** What the caller receives: the quoter's answer less any interface fee. */
  readonly amountOut: bigint
  /** The quoter contract's answer for exactly `amountIn`, before any interface fee. */
  readonly poolAmountOut: bigint
  /** Frank's fee on this swap, in the output token. Absent when the venue has none. */
  readonly interfaceFee?: { bps: number; amount: bigint }
  readonly route: PoolRoute
  /** The pool's LP fee as read from its state, in parts per million of the input. */
  readonly lpFeePpm: number
  /** What `amountIn` would buy at the pool's mid price before any fee, for showing the rate. */
  readonly midPriceAmountOut: bigint
  readonly priceImpactPpm: number
  /** When the quote was read, in milliseconds. Callers re-quote once it is a few seconds old. */
  readonly quotedAtMs: number
}

/** A quote older than this is fetched again before the user may confirm it. */
export const QUOTE_MAX_AGE_MS = 8_000

export function quoteIsFresh(
  quote: { readonly quotedAtMs: number },
  nowMs: number,
): boolean {
  return (
    nowMs - quote.quotedAtMs >= 0 && nowMs - quote.quotedAtMs < QUOTE_MAX_AGE_MS
  )
}

/** The account's balance of one token, in base units: one node request. */
export async function readTokenBalance(
  reader: SwapChainReader,
  token: EvmDexToken,
  account: string,
): Promise<bigint> {
  const owner = getAddress(account)
  return token.address === null
    ? reader.getBalance(owner)
    : BigInt(
        await reader.call({
          to: getAddress(token.address),
          data: erc20Interface.encodeFunctionData('balanceOf', [owner]),
        }),
      )
}

/** The account's balance of each configured token, in base units, in the deployment's order. */
export async function readTokenBalances(
  reader: SwapChainReader,
  deployment: UniswapV4Deployment,
  account: string,
): Promise<bigint[]> {
  return Promise.all(
    deployment.tokens.map(token => readTokenBalance(reader, token, account)),
  )
}

/**
 * Asks the quoter contract what exactly `amountIn` buys now, on every pool that trades the pair,
 * and returns the best. The price impact is the quote against that pool's own mid price.
 */
export async function fetchSwapQuote(
  reader: SwapChainReader,
  deployment: UniswapV4Deployment,
  params: { tokenIn: EvmDexToken; tokenOut: EvmDexToken; amountIn: bigint },
  now: () => number = Date.now,
): Promise<SwapQuote> {
  const routes = routesFor(deployment, params.tokenIn, params.tokenOut)
  if (routes.length === 0) throw new SwapNoRouteError()
  let best: SwapQuote | undefined
  let unreachable: unknown
  for (const route of routes) {
    const id = poolId(route.key)
    let slot0: string, liquidity: string
    try {
      ;[slot0, liquidity] = await Promise.all([
        reader.call({
          to: deployment.stateView,
          data: stateViewInterface.encodeFunctionData('getSlot0', [id]),
        }),
        reader.call({
          to: deployment.stateView,
          data: stateViewInterface.encodeFunctionData('getLiquidity', [id]),
        }),
      ])
    } catch (error) {
      unreachable = error
      continue
    }
    const [sqrtPriceX96, , , lpFee] = stateViewInterface.decodeFunctionResult(
      'getSlot0',
      slot0,
    )
    if (BigInt(sqrtPriceX96) === 0n || BigInt(liquidity) === 0n) continue
    let amountOut: bigint
    try {
      amountOut = decodeQuoteResult(
        await reader.call({
          to: deployment.quoter,
          data: encodeQuoteCall(route, params.amountIn),
        }),
      ).amountOut
    } catch (error) {
      // The quoter reverts when the pool cannot fill the amount. A node that did not answer at
      // all is a different thing and must not read as "no liquidity".
      if (isCallRevert(error)) continue
      unreachable = error
      continue
    }
    if (amountOut <= 0n) continue
    const lpFeePpm = Number(lpFee)
    const fee = deployment.interfaceFee
    const feeAmount = fee ? interfaceFeeAmount(amountOut, fee.bps) : 0n
    if (amountOut - feeAmount <= 0n) continue
    const quote: SwapQuote = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      amountOut: amountOut - feeAmount,
      poolAmountOut: amountOut,
      ...(fee ? { interfaceFee: { bps: fee.bps, amount: feeAmount } } : {}),
      route,
      lpFeePpm,
      midPriceAmountOut: outputAtMidPrice(
        params.amountIn,
        BigInt(sqrtPriceX96),
        route.zeroForOne,
      ),
      priceImpactPpm: priceImpactPpm({
        amountIn: params.amountIn,
        amountOut,
        sqrtPriceX96: BigInt(sqrtPriceX96),
        zeroForOne: route.zeroForOne,
        lpFeePpm,
      }),
      quotedAtMs: now(),
    }
    if (!best || quote.amountOut > best.amountOut) best = quote
  }
  if (best) return best
  if (unreachable !== undefined) throw unreachable
  throw new SwapNoLiquidityError()
}

function isCallRevert(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'CALL_EXCEPTION' || code === 'BAD_DATA'
}

export async function readAllowance(
  reader: SwapChainReader,
  deployment: UniswapV4Deployment,
  token: EvmDexToken,
  account: string,
): Promise<AllowanceState | undefined> {
  if (token.address === null) return undefined
  const owner = getAddress(account)
  const address = getAddress(token.address)
  const [toPermit2, toRouter] = await Promise.all([
    reader.call({
      to: address,
      data: erc20Interface.encodeFunctionData('allowance', [
        owner,
        deployment.permit2,
      ]),
    }),
    reader.call({
      to: deployment.permit2,
      data: permit2Interface.encodeFunctionData('allowance', [
        owner,
        address,
        deployment.universalRouter,
      ]),
    }),
  ])
  const [amount, expiration] = permit2Interface.decodeFunctionResult(
    'allowance',
    toRouter,
  )
  return {
    tokenToPermit2: BigInt(toPermit2),
    permit2ToRouter: {
      amount: BigInt(amount),
      expiration: Number(expiration),
    },
  }
}

/** How long a built swap stays valid on chain, in seconds. */
export const SWAP_DEADLINE_SECONDS = 120

export interface SwapPlan {
  readonly quote: SwapQuote
  readonly slippageBps: number
  readonly minimumAmountOut: bigint
  readonly deadline: number
  /** Approvals still needed before the swap, in order. Empty for the native coin. */
  readonly approvals: readonly ApprovalStep[]
  readonly swap: EncodedCall
}

/** Builds the transactions for a quote: any exact-amount approvals, then the swap itself. */
export async function planSwap(
  reader: SwapChainReader,
  deployment: UniswapV4Deployment,
  params: { quote: SwapQuote; slippageBps: number; account: string },
  now: () => number = Date.now,
): Promise<SwapPlan> {
  const { quote } = params
  const nowSeconds = Math.floor(now() / 1000)
  const minimumAmountOut = minimumOutput(quote.amountOut, params.slippageBps)
  const allowance = await readAllowance(
    reader,
    deployment,
    quote.tokenIn,
    params.account,
  )
  const deadline = nowSeconds + SWAP_DEADLINE_SECONDS
  return {
    quote,
    slippageBps: params.slippageBps,
    minimumAmountOut,
    deadline,
    approvals: allowance
      ? approvalSteps({
          deployment,
          tokenIn: quote.tokenIn,
          amountIn: quote.amountIn,
          allowance,
          now: nowSeconds,
        })
      : [],
    swap: encodeSwap({
      deployment,
      route: quote.route,
      amountIn: quote.amountIn,
      minimumAmountOut,
      deadline,
    }),
  }
}

export interface NetworkFeeEstimate {
  /** `eth_estimateGas` for the call from the account, plus `GAS_MARGIN_PERCENT`. */
  readonly gasLimit: bigint
  readonly maxFeePerGas: bigint
  /** The most the call can cost: gas limit times the fee cap. The account must hold this. */
  readonly maximumFeeWei: bigint
  /**
   * What the network will charge at the current base fee plus tip: for the gas the call is
   * estimated to use, or, on a network that charges the whole limit a transaction reserves
   * (`gasChargedOn: 'limit'` on its registry row), for the limit. This is what leaves the
   * account, and what the form shows.
   */
  readonly chargedFeeWei: bigint
}

/** Which gas a network's fee is charged on; a fact of the network, read from its registry row. */
export type GasChargedOn = 'used' | 'limit'

/**
 * Headroom added to the node's gas estimate. It exists because the pool can move between the
 * estimate and inclusion, and a swap that runs out of gas costs its fee and swaps nothing. It is
 * kept small because on a network that charges the gas limit every unit of it is paid for.
 */
export const GAS_MARGIN_PERCENT = 15n

/** Gas price a transaction is charged now: base fee plus tip, never above the cap. */
export async function chargedGasPrice(
  reader: SwapChainReader,
  fees?: Awaited<ReturnType<SwapChainReader['getFeeData']>>,
): Promise<{ maxFeePerGas: bigint; chargedPerGas: bigint }> {
  const [data, block] = await Promise.all([
    fees ?? reader.getFeeData(),
    reader.getBlock ? reader.getBlock('latest').catch(() => null) : null,
  ])
  const maxFeePerGas = data.maxFeePerGas ?? data.gasPrice
  if (maxFeePerGas == null) throw new Error('Network fee quote unavailable')
  const base = block?.baseFeePerGas
  if (base == null) return { maxFeePerGas, chargedPerGas: maxFeePerGas }
  const charged = base + (data.maxPriorityFeePerGas ?? 0n)
  return {
    maxFeePerGas,
    chargedPerGas: charged < maxFeePerGas ? charged : maxFeePerGas,
  }
}

/** `eth_estimateGas` on the built call. Throws the node's revert when the call would fail. */
export async function estimateCallFee(
  reader: SwapChainReader,
  call: EncodedCall,
  account: string,
  gasChargedOn: GasChargedOn = 'used',
): Promise<NetworkFeeEstimate> {
  const [estimate, price] = await Promise.all([
    reader.estimateGas({
      to: call.to,
      data: call.data,
      value: call.value,
      from: getAddress(account),
    }),
    chargedGasPrice(reader),
  ])
  const gasLimit = (estimate * (100n + GAS_MARGIN_PERCENT)) / 100n
  return {
    gasLimit,
    maxFeePerGas: price.maxFeePerGas,
    maximumFeeWei: gasLimit * price.maxFeePerGas,
    chargedFeeWei:
      (gasChargedOn === 'limit' ? gasLimit : estimate) * price.chargedPerGas,
  }
}

/** Revert data carried by an ethers call or gas-estimate error, when the node returned any. */
export function revertDataOf(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data))
      return data
    current =
      (current as { error?: unknown }).error ??
      (current as { info?: { error?: unknown } }).info?.error ??
      (current as { cause?: unknown }).cause
  }
  return undefined
}

export function swapRevertReasonOf(
  error: unknown,
): SwapRevertReason | undefined {
  return classifySwapRevert(revertDataOf(error))
}

export { currencyOf }
