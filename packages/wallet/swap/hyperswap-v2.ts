/**
 * HyperSwap V2 (a Uniswap v2-style router, factory and pairs) behind the EVM dex interface: the
 * adapter class for registry entries whose `adapter` is `hyperswap-v2`. It is given its entry
 * and the wallet as a narrow interface; it finds nothing by itself and registers nothing.
 *
 * It swaps the native coin for a configured token through one configured pair. The quote is
 * the V2 router's `getAmountsOut`; the swap is sent to HyperSwap's SwapRouter02 (the published
 * V2 router has no swap function) as `multicall(deadline, [swapExactTokensForTokens(...)])`
 * paying the native coin as the call value, which SwapRouter02 wraps. Any other direction is
 * refused as having no route. Nothing in that call can take a portion of the output for Frank,
 * so an entry of this kind never carries an interface fee (`EVM_DEX_CARRIES_INTERFACE_FEE`).
 *
 * The wallet owns custody, funds, the journal and resubmission; the shared EVM swap execution
 * (`swap-execution.ts`) moves funds into the main account when the user confirmed it, sends the
 * swap through the wallet's recorded contract send, and watches it. This class owns the quote,
 * the calldata, and reading what the receipt says the swap did.
 */
import { Interface, getAddress } from 'ethers'
import { getChainRegistryEntry } from '../chain/chains-registry'
import type {
  EvmDexToken,
  HyperSwapV2Deployment,
  UniswapV2Pair,
} from '../chain/dex-entries'
import type { EvmDex, EvmDexPlan, EvmDexQuote, EvmDexWallet } from './evm-dex'
import { SwapRecordMismatchError } from './evm-dex'
import {
  SWAP_DEADLINE_SECONDS,
  SwapNoLiquidityError,
  SwapNoRouteError,
} from './evm-swap'
import {
  consolidationNeeded,
  estimateSwapCost,
  executeSwap,
  readSwapResult,
  reconcileSwap,
  type SwapOutcomeReader,
} from './swap-execution'
import { minimumOutput, type EncodedCall } from './uniswap-v4'

/** A Uniswap v2 pair's fee: 0.3% of the input, taken by the pair. */
const V2_LP_FEE_PPM = 3000

const routerInterface = new Interface([
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const swapRouterInterface = new Interface([
  'function factoryV2() view returns (address)',
  'function WETH9() view returns (address)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])
const factoryInterface = new Interface([
  'function getPair(address tokenA, address tokenB) view returns (address)',
])
const pairInterface = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
])
const erc20Interface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

const same = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** The route a HyperSwap V2 swap takes: the native coin in, through one pair, the token out. */
export interface HyperSwapV2Route {
  readonly kind: 'hyperswap-v2'
  readonly pair: string
  /** `[wrapped native, token out]`, as the router is given it. */
  readonly path: readonly [string, string]
}

export interface HyperSwapV2Quote extends EvmDexQuote {
  readonly route: HyperSwapV2Route
}
export type HyperSwapV2Plan = EvmDexPlan<HyperSwapV2Quote>

function isRoute(route: unknown): route is HyperSwapV2Route {
  const r = route as Partial<HyperSwapV2Route> | null
  return (
    r?.kind === 'hyperswap-v2' &&
    typeof r.pair === 'string' &&
    Array.isArray(r.path) &&
    r.path.length === 2 &&
    r.path.every(address => typeof address === 'string')
  )
}

type Dex = EvmDex<HyperSwapV2Quote, HyperSwapV2Plan>

export class HyperSwapV2Dex implements Dex {
  /** Set once the router, factory and pairs answered as configured; cleared when they did not. */
  private verified?: Promise<void>

  constructor(
    readonly chainIdentifier: string,
    readonly entry: HyperSwapV2Deployment,
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

  private async read(
    abi: Interface,
    to: string,
    name: string,
    args: unknown[] = [],
  ) {
    const data = await this.wallet.reader.call({
      to,
      data: abi.encodeFunctionData(name, args),
    })
    return abi.decodeFunctionResult(name, data)
  }

  /**
   * The routers, factory and pairs answer as the entry says: router.factory(), router.WETH(),
   * swapRouter.factoryV2() and swapRouter.WETH9() are the configured factory and wrapped native
   * coin, and every pair is the factory's pair of its two tokens. Asked once per adapter; the wallet has already checked the chain itself.
   */
  verifyDeployment(): Promise<void> {
    this.verified ??= this.checkDeployment().catch(error => {
      this.verified = undefined
      throw error
    })
    return this.verified
  }

  private async checkDeployment(): Promise<void> {
    const { router, swapRouter, factory, wrappedNative, pairs } = this.entry
    const [[routerFactory], [weth], [swapFactory], [swapWeth]] =
      await Promise.all([
        this.read(routerInterface, router, 'factory'),
        this.read(routerInterface, router, 'WETH'),
        this.read(swapRouterInterface, swapRouter, 'factoryV2'),
        this.read(swapRouterInterface, swapRouter, 'WETH9'),
      ])
    if (
      !same(routerFactory, factory) ||
      !same(weth, wrappedNative) ||
      !same(swapFactory, factory) ||
      !same(swapWeth, wrappedNative)
    )
      throw new Error('HyperSwap router does not match its configuration')
    for (const pair of pairs) {
      const [[listed], [token0], [token1]] = await Promise.all([
        this.read(factoryInterface, factory, 'getPair', [
          pair.token0,
          pair.token1,
        ]),
        this.read(pairInterface, pair.address, 'token0'),
        this.read(pairInterface, pair.address, 'token1'),
      ])
      if (
        !same(listed, pair.address) ||
        !same(token0, pair.token0) ||
        !same(token1, pair.token1)
      )
        throw new Error('HyperSwap pair does not match its configuration')
    }
  }

  /** The configured pair of the wrapped native coin and `token`, if there is one. */
  private pairFor(token: string): UniswapV2Pair | undefined {
    const wrapped = this.entry.wrappedNative
    return this.entry.pairs.find(
      pair =>
        (same(pair.token0, wrapped) && same(pair.token1, token)) ||
        (same(pair.token1, wrapped) && same(pair.token0, token)),
    )
  }

  private routeFor(tokenIn: EvmDexToken, tokenOut: EvmDexToken) {
    if (tokenIn.address !== null || tokenOut.address === null)
      throw new SwapNoRouteError()
    const listed = (token: EvmDexToken) =>
      this.entry.tokens.some(
        t =>
          t.address === token.address ||
          (t.address !== null &&
            token.address !== null &&
            same(t.address, token.address)),
      )
    if (!listed(tokenIn) || !listed(tokenOut)) throw new SwapNoRouteError()
    const pair = this.pairFor(tokenOut.address)
    if (!pair) throw new SwapNoRouteError()
    const route: HyperSwapV2Route = {
      kind: 'hyperswap-v2',
      pair: pair.address,
      path: [this.entry.wrappedNative, tokenOut.address],
    }
    return { pair, route }
  }

  /** A route of this venue's own configuration; a recorded route is not trusted further. */
  private configuredRoute(route: unknown): HyperSwapV2Route {
    if (!isRoute(route)) throw new SwapRecordMismatchError()
    const pair = this.pairFor(route.path[1])
    if (
      !pair ||
      !same(route.pair, pair.address) ||
      !same(route.path[0], this.entry.wrappedNative)
    )
      throw new SwapRecordMismatchError()
    return route
  }

  async quote(input: Parameters<Dex['quote']>[0]): Promise<HyperSwapV2Quote> {
    const { tokenIn, tokenOut, amountIn } = input
    if (amountIn <= 0n) throw new RangeError('Swap amount must be positive')
    const { pair, route } = this.routeFor(tokenIn, tokenOut)
    await this.verifyDeployment()
    const [[amounts], reserves] = await Promise.all([
      this.read(routerInterface, this.entry.router, 'getAmountsOut', [
        amountIn,
        [...route.path],
      ]),
      this.read(pairInterface, pair.address, 'getReserves'),
    ])
    const nativeIs0 = same(pair.token0, this.entry.wrappedNative)
    const reserveIn = BigInt(nativeIs0 ? reserves[0] : reserves[1])
    const reserveOut = BigInt(nativeIs0 ? reserves[1] : reserves[0])
    if (reserveIn <= 0n || reserveOut <= 0n) throw new SwapNoLiquidityError()
    const out = amounts as readonly bigint[]
    if (out.length !== 2 || BigInt(out[0]!) !== amountIn)
      throw new Error('HyperSwap router answered for another amount')
    const amountOut = BigInt(out[1]!)
    if (amountOut <= 0n) throw new SwapNoLiquidityError()
    // What the input buys at the pair's price before it moves, after the pair's fee.
    const afterFee = (amountIn * BigInt(1_000_000 - V2_LP_FEE_PPM)) / 1_000_000n
    const ideal = (afterFee * reserveOut) / reserveIn
    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      poolAmountOut: amountOut,
      lpFeePpm: V2_LP_FEE_PPM,
      priceImpactPpm:
        ideal > amountOut
          ? Number(((ideal - amountOut) * 1_000_000n) / ideal)
          : 0,
      quotedAtMs: this.now(),
      route,
    }
  }

  async plan(input: Parameters<Dex['plan']>[0]): Promise<HyperSwapV2Plan> {
    const { quote } = input
    const route = this.configuredRoute(quote.route)
    const account = getAddress(input.account)
    const minimumAmountOut = minimumOutput(quote.amountOut, input.slippageBps)
    const deadline = Math.floor(this.now() / 1000) + SWAP_DEADLINE_SECONDS
    return {
      quote,
      slippageBps: input.slippageBps,
      minimumAmountOut,
      deadline,
      approvals: [],
      swap: this.callFor(route, quote.amountIn, minimumAmountOut, account, deadline),
    }
  }

  private callFor(
    route: HyperSwapV2Route,
    amountIn: bigint,
    minimumAmountOut: bigint,
    account: string,
    deadline: number,
  ): EncodedCall {
    const swap = swapRouterInterface.encodeFunctionData(
      'swapExactTokensForTokens',
      [amountIn, minimumAmountOut, [...route.path], account],
    )
    return {
      to: this.entry.swapRouter,
      value: amountIn,
      data: swapRouterInterface.encodeFunctionData('multicall', [
        deadline,
        [swap],
      ]),
    }
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

  /**
   * What the receipt says the swap did: the configured pair's `Swap` event paying `account`,
   * corroborated by the token's transfer from the pair to `account`. Undefined when the logs
   * hold no such swap.
   */
  private outcomeReader(
    route: HyperSwapV2Route,
    account: string,
  ): SwapOutcomeReader {
    const pair = this.pairFor(route.path[1])!
    const nativeIs0 = same(pair.token0, this.entry.wrappedNative)
    const swapTopic = pairInterface.getEvent('Swap')!.topicHash
    const transferTopic = erc20Interface.getEvent('Transfer')!.topicHash
    return logs => {
      let amountIn: bigint | undefined
      let amountOut: bigint | undefined
      for (const log of logs) {
        if (!same(log.address, pair.address) || log.topics[0] !== swapTopic)
          continue
        const event = pairInterface.decodeEventLog('Swap', log.data, [
          ...log.topics,
        ])
        if (!same(event.to, account)) continue
        const paid = BigInt(nativeIs0 ? event.amount0In : event.amount1In)
        const received = BigInt(nativeIs0 ? event.amount1Out : event.amount0Out)
        if (paid <= 0n || received <= 0n) return undefined
        amountIn = (amountIn ?? 0n) + paid
        amountOut = (amountOut ?? 0n) + received
      }
      if (amountIn === undefined || amountOut === undefined) return undefined
      let transferred = 0n
      for (const log of logs) {
        if (
          !same(log.address, route.path[1]) ||
          log.topics[0] !== transferTopic ||
          log.topics.length !== 3
        )
          continue
        const event = erc20Interface.decodeEventLog('Transfer', log.data, [
          ...log.topics,
        ])
        if (same(event.from, pair.address) && same(event.to, account))
          transferred += BigInt(event.value)
      }
      if (transferred !== amountOut) throw new SwapRecordMismatchError()
      return { amountIn, amountOut }
    }
  }

  async execute(input: Parameters<Dex['execute']>[0]) {
    const { plan, account } = input
    const { quote } = plan
    const route = this.configuredRoute(quote.route)
    // The plan's call is exactly what this route, amount, floor and deadline encode.
    const call = this.callFor(
      route,
      quote.amountIn,
      plan.minimumAmountOut,
      getAddress(account),
      plan.deadline,
    )
    if (
      plan.approvals.length > 0 ||
      !same(plan.swap.to, call.to) ||
      plan.swap.data !== call.data ||
      plan.swap.value !== call.value
    )
      throw new Error('Swap plan changed; review a new quote')
    const asset = (token: EvmDexToken) => ({
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
    })
    return executeSwap({
      readOutcome: this.outcomeReader(route, account),
      reader: this.wallet.reader,
      wallet: this.wallet,
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
        interfaceFeeAmount: '0',
        route,
      },
    })
  }

  async observe(input: Parameters<Dex['observe']>[0]) {
    const route = this.configuredRoute(input.route)
    const handle = { operationId: '', txHash: input.transactionId }
    const receipt = await this.wallet.reader.getTransactionReceipt(
      input.transactionId,
    )
    if (!receipt) return { status: 'pending' as const, ...handle }
    if (
      !same(receipt.from, input.account) ||
      !same(receipt.to, this.entry.swapRouter)
    )
      throw new SwapRecordMismatchError()
    return readSwapResult({
      readOutcome: this.outcomeReader(route, input.account),
      reader: this.wallet.reader,
      account: input.account,
      handle,
      receipt,
    })
  }

  async reconcile(input: Parameters<Dex['reconcile']>[0]) {
    const route = this.configuredRoute(input.route)
    const swap = {
      to: input.call.to,
      data: input.call.data,
      value: BigInt(input.call.value),
    }
    if (!same(swap.to, this.entry.swapRouter))
      throw new SwapRecordMismatchError()
    let deadline: number | undefined
    try {
      const [value, calls] = swapRouterInterface.decodeFunctionData(
        'multicall',
        swap.data,
      )
      if (calls.length !== 1) throw new SwapRecordMismatchError()
      swapRouterInterface.decodeFunctionData('swapExactTokensForTokens', calls[0])
      if (BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))
        deadline = Number(value)
    } catch {
      throw new SwapRecordMismatchError()
    }
    return reconcileSwap({
      readOutcome: this.outcomeReader(route, input.account),
      reader: this.wallet.reader,
      wallet: this.wallet,
      account: input.account,
      swap,
      deadline,
      handle: { operationId: input.operationId, txHash: input.transactionId },
      timing: input.timing,
    })
  }
}
