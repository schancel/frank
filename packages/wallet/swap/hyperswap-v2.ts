/** Disabled HyperSwap V2 testnet native -> test PURR adapter. No registration side effects.
 * Deployment: https://docs.hyperswap.exchange/docs/amm/contracts/testnet/v2/
 * Tokens: https://docs.hyperswap.exchange/docs/amm/contracts/testnet/
 * Wallet owns custody, reservations, signed-byte persistence, and resubmission. This module
 * owns quote/calldata/receipt interpretation only. It never creates an exchange account.
 */
import { Interface, getAddress } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import type { EvmDex, EvmDexPlan, EvmDexQuote, EvmDexWallet } from './evm-dex'
import { SwapRecordMismatchError } from './evm-dex'
import { estimateCallFee, quoteIsFresh, SwapNoRouteError } from './evm-swap'
import { settle, DEFAULT_SWAP_TIMING, type SwapExecutionReader, type SwapWallet, type SwapResult, type SwapProgress, type SwapTiming, type ConsolidationNeed, type SwapCost } from './swap-execution'
import type { EvmDexToken } from '../chain/dex-entries'

export const HYPERSWAP_V2_TESTNET = Object.freeze({
  id: 'hyperswap-v2', adapter: 'hyperswap-v2', enabled: false,
  chainIdentifier: 'hyperliquid-testnet', displayName: 'HyperSwap V2',
  maintainer: 'HyperSwap',
  router: '0x85aA63EB2ab9BaAA74eAd7e7f82A571d74901853',
  factory: '0xA028411927E2015A363014881a4404C636218fb1',
  wrappedNative: '0xADcb2f358Eae6492F61A5F87eb8893d09391d160',
  pair: '0xddA44A39AaA3e2dcc8aFd78ca70b0718877188b5',
  tokenIn: Object.freeze({ symbol: 'tHYPE', name: 'Hyperliquid testnet HYPE', decimals: 18, address: null }),
  tokenOut: Object.freeze({ symbol: 'PURR', name: 'HyperSwap test PURR', decimals: 18,
    address: '0xC003D79B8a489703b1753711E3ae9fFDFC8d1a82', testToken: true }),
})
const d = HYPERSWAP_V2_TESTNET
const router = new Interface([
  'function factory() view returns(address)', 'function WETH() view returns(address)',
  'function getAmountsOut(uint256,address[]) view returns(uint256[])',
  'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])',
])
const factory = new Interface(['function getPair(address,address) view returns(address)'])
const pair = new Interface([
  'function token0() view returns(address)', 'function token1() view returns(address)',
  'function getReserves() view returns(uint112,uint112,uint32)',
  'event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)',
])
const token = new Interface([
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
const positive = (v: bigint) => { if (v <= 0n || v >= 1n << 256n) throw new RangeError('Invalid swap amount') }

export interface HyperSwapRoute {
  readonly kind: 'hyperswap-v2-native-purr'
  readonly amountIn: string
  readonly minimumAmountOut: string
  readonly account: string
  readonly deadline: number
}
export interface HyperSwapPlan extends EvmDexPlan {
  readonly account: string
  readonly route: HyperSwapRoute
}

/** No fallback chain, token, router, or pair is accepted. */
export class HyperSwapV2Testnet implements EvmDex<EvmDexQuote, HyperSwapPlan> {
  readonly entry = d
  readonly chainIdentifier = d.chainIdentifier
  readonly tokens = [d.tokenIn, d.tokenOut]
  
  constructor(private readonly wallet: EvmDexWallet, private readonly now: () => number = Date.now) {}

  private get reader() { return this.wallet.reader }

  private async read(abi: Interface, address: string, name: string, args: unknown[] = [], blockTag?: number) {
    const result = await this.reader.call({ to: address, data: abi.encodeFunctionData(name, args), ...(blockTag === undefined ? {} : { blockTag }) })
    return abi.decodeFunctionResult(name, result)
  }
  
  async verifyDeployment(): Promise<void> {
    const protocol = PROTOCOL_CHAINS[d.chainIdentifier]
    if (protocol.nativeChainId === undefined || (await this.reader.getNetwork()).chainId.toString() !== protocol.nativeChainId.toString())
      throw new Error('HyperSwap requires Hyperliquid testnet')
    for (const probe of protocol.identityProbes) {
      if (probe.kind === 'block-hash' && !same((await this.reader.getBlock(probe.height))?.hash, probe.expected))
        throw new Error('Hyperliquid testnet checkpoint mismatch')
    }
    const [f, w, p, t0, t1, decimals, ...codes] = await Promise.all([
      this.read(router, d.router, 'factory'), this.read(router, d.router, 'WETH'),
      this.read(factory, d.factory, 'getPair', [d.wrappedNative, d.tokenOut.address]),
      this.read(pair, d.pair, 'token0'), this.read(pair, d.pair, 'token1'),
      this.read(token, d.tokenOut.address, 'decimals'),
      ...[d.router, d.factory, d.wrappedNative, d.pair, d.tokenOut.address].map(a => this.reader.getCode(a)),
    ])
    if (!same(f[0], d.factory) || !same(w[0], d.wrappedNative) || !same(p[0], d.pair) ||
      !same(t0[0], d.wrappedNative) || !same(t1[0], d.tokenOut.address) || decimals[0] !== 18n ||
      codes.some(code => typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code)))
      throw new Error('HyperSwap deployment mismatch')
  }
  
  async quote(input: { tokenIn: EvmDexToken; tokenOut: EvmDexToken; amountIn: bigint }): Promise<EvmDexQuote> {
    const amountIn = input.amountIn
    positive(amountIn)
    await this.verifyDeployment()
    const [amounts, reserves] = await Promise.all([
      this.read(router, d.router, 'getAmountsOut', [amountIn, [d.wrappedNative, d.tokenOut.address]]),
      this.read(pair, d.pair, 'getReserves'),
    ])
    if (amounts[0].length !== 2 || amounts[0][0] !== amountIn || amounts[0][1] <= 0n || reserves[0] <= 0n || reserves[1] <= 0n)
      throw new SwapNoRouteError('HyperSwap cannot fill this amount')
    const amountOut = amounts[0][1] as bigint
    const mid = amountIn * reserves[1] / reserves[0]
    return { tokenIn: d.tokenIn, tokenOut: d.tokenOut, amountIn, amountOut,
      poolAmountOut: amountOut, lpFeePpm: 3000,
      priceImpactPpm: mid > amountOut ? Number((mid - amountOut) * 1_000_000n / mid) : 0,
      quotedAtMs: this.now(), route: { kind: 'hyperswap-v2-native-purr' } }
  }
  
  async plan(input: { quote: EvmDexQuote; slippageBps: number; account: string }): Promise<HyperSwapPlan> {
    const quote = await this.quote(input.quote)
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 500)
      throw new RangeError('Slippage must be between 0 and 500 basis points')
    const account = getAddress(input.account)
    const minimumAmountOut = quote.amountOut * BigInt(10_000 - input.slippageBps) / 10_000n
    positive(minimumAmountOut)
    const deadline = Math.floor(this.now() / 1000) + 120
    const route: HyperSwapRoute = { kind: 'hyperswap-v2-native-purr', amountIn: quote.amountIn.toString(),
      minimumAmountOut: minimumAmountOut.toString(), account, deadline }
    return { account, quote, route, minimumAmountOut, slippageBps: input.slippageBps, deadline,
      approvals: [], swap: this.callFor(route) }
  }
  
  private callFor(route: HyperSwapRoute) {
    this.validateRoute(route)
    return { to: d.router, value: BigInt(route.amountIn), data: router.encodeFunctionData('swapExactETHForTokens', [
      route.minimumAmountOut, [d.wrappedNative, d.tokenOut.address], route.account, route.deadline,
    ]) }
  }
  
  private validateRoute(route: unknown): asserts route is HyperSwapRoute {
    const r = route as HyperSwapRoute
    if (r?.kind !== 'hyperswap-v2-native-purr' || !/^\d+$/.test(r.amountIn) || !/^\d+$/.test(r.minimumAmountOut) ||
      !Number.isSafeInteger(r.deadline) || r.deadline <= 0) throw new SwapRecordMismatchError()
    getAddress(r.account); positive(BigInt(r.amountIn)); positive(BigInt(r.minimumAmountOut))
  }
  
  async consolidation(input: { plan: HyperSwapPlan; swapFee?: SwapCost['swapFee'] }): Promise<ConsolidationNeed> {
    return { moveWei: 0n, possible: true } // Native swaps with sufficient funds need no move
  }

  async cost(input: { plan: HyperSwapPlan; account: string; moveWei?: bigint }): Promise<SwapCost> {
    const fee = await estimateCallFee(this.reader, input.plan.swap, input.account).catch(() => undefined)
    return {
      transactions: [{ kind: 'swap', feeWei: fee?.chargedFeeWei }],
      networkFeeWei: fee?.chargedFeeWei ?? 0n,
      complete: fee !== undefined,
      swapFee: fee
    }
  }

  async execute(input: {
    plan: HyperSwapPlan
    account: string
    consolidateWei?: bigint
    onProgress?: (progress: SwapProgress) => void
    timing?: SwapTiming
  }): Promise<SwapResult> {
    await this.verifyDeployment()
    const { plan, account, onProgress } = input
    const call = this.callFor(plan.route)
    if (!quoteIsFresh(plan.quote, this.now()) || plan.deadline !== plan.route.deadline ||
      plan.deadline <= Math.floor(this.now() / 1000) || plan.deadline > Math.floor(this.now() / 1000) + 120 ||
      plan.minimumAmountOut !== BigInt(plan.route.minimumAmountOut) || plan.quote.amountIn !== call.value ||
      !same(account, plan.route.account) || plan.approvals.length ||
      !same(plan.swap.to, call.to) || plan.swap.data !== call.data || plan.swap.value !== call.value)
      throw new Error('Swap plan changed or expired; review a new quote')
    if (!Number.isInteger(plan.slippageBps) || plan.slippageBps < 0 || plan.slippageBps > 500 ||
      plan.minimumAmountOut !== plan.quote.amountOut * BigInt(10_000 - plan.slippageBps) / 10_000n)
      throw new Error('Invalid minimum received')
    const funds = await this.wallet.getContractCallFunds()
    if (!same(funds.mainAddress, account) || funds.mainBusy || this.wallet.getUnresolvedContractCalls?.().length)
      throw new Error('Swap account is changed or busy; reconcile its original operation')
    const fee = await estimateCallFee(this.reader, call, account)
    if (call.value + fee.maximumFeeWei > funds.mainBalance) // NOTE: The user's wallet may have less funds than moveWei.
      throw new Error('Swap exceeds available funds or the authorized maximum debit')
    
    onProgress?.({ stage: 'submitting' })
    let handle: { operationId: string, txHash: string }
    try {
      handle = await this.wallet.sendContractCall({ to: { raw: call.to }, data: call.data, value: call.value, gasLimit: fee.gasLimit,
        record: { kind: 'swap', venueId: d.id, account: account,
          assetIn: d.tokenIn, amountIn: call.value.toString(), assetOut: d.tokenOut,
          quotedAmountOut: plan.quote.amountOut.toString(), minimumAmountOut: plan.minimumAmountOut.toString(),
          interfaceFeeAmount: '0', route: plan.route, networkFeeWei: fee.chargedFeeWei.toString() } })
    } catch (error) {
      const pending = error as { operation?: { operationId?: string }; transaction?: { txHash?: string } }
      if (!pending.operation?.operationId || !pending.transaction?.txHash) throw error
      handle = { operationId: pending.operation.operationId, txHash: pending.transaction.txHash }
    }
    
    onProgress?.({ stage: 'submitted', txHash: handle.txHash })
    const timing = input.timing ?? DEFAULT_SWAP_TIMING
    const receipt = await settle(this.reader, this.wallet, handle, timing)
    
    if (receipt) {
      try { await this.wallet.resumeNativeOperation?.(handle.operationId) } catch {}
    } else {
      await this.wallet.reobserveNativeOperations?.()
    }
    
    return this.observe({ transactionId: handle.txHash, account, route: plan.route })
  }

  async reconcile(input: {
    transactionId: string
    operationId: string
    account: string
    route: unknown
    call: { to: string; data: string; value: string }
    timing?: SwapTiming
  }): Promise<SwapResult> {
    this.validateRoute(input.route)
    const timing = input.timing ?? DEFAULT_SWAP_TIMING
    await settle(this.reader, this.wallet, { txHash: input.transactionId, operationId: input.operationId }, { ...timing, inclusionTimeoutMs: 0 })
    await this.wallet.reobserveNativeOperations?.()
    return this.observe({ transactionId: input.transactionId, account: input.account, route: input.route })
  }

  private validateTransaction(tx: NonNullable<Awaited<ReturnType<SwapExecutionReader['getTransaction']>>>, route: HyperSwapRoute) {
    const call = this.callFor(route)
    const typedTx = tx as { chainId: bigint; from: string; to: string | null; data: string; value: bigint }
    if (typedTx.chainId !== 998n || !same(typedTx.from, route.account) || !same(typedTx.to, call.to) || typedTx.data !== call.data || typedTx.value !== call.value)
      throw new SwapRecordMismatchError()
  }

  async observe(input: { transactionId: string; account: string; route: unknown }): Promise<SwapResult> {
    const handle = { txHash: input.transactionId, operationId: '' } // operationId is not required for output if missing
    try { await this.verifyDeployment() } catch { return { status: 'pending', ...handle } }
    this.validateRoute(input.route)
    const receipt = await this.reader.getTransactionReceipt(input.transactionId)
    if (!receipt) return { status: 'pending', ...handle }
    const tx = await this.reader.getTransaction(input.transactionId)
    if (!tx || !same(receipt.from, input.account) || !same(receipt.to, d.router)) throw new SwapRecordMismatchError()
    this.validateTransaction(tx, input.route)
    const feeWei = receipt.gasUsed * receipt.gasPrice
    if (receipt.status === 0) return { status: 'reverted', ...handle, feeWei, totalFeeWei: feeWei }
    if (receipt.status !== 1) return { status: 'pending', ...handle }
    let output = 0n, swapCount = 0
    for (const log of receipt.logs) {
      if (same(log.address, d.pair)) {
        let event
        try { event = pair.parseLog(log) } catch { continue }
        if (event?.name === 'Swap') {
          if (!same(event.args.sender, d.router) || !same(event.args.to, input.account) ||
            event.args.amount0In !== BigInt(input.route.amountIn) || event.args.amount1In !== 0n || event.args.amount0Out !== 0n)
            throw new SwapRecordMismatchError()
          output = event.args.amount1Out; swapCount++
        }
      }
    }
    let received = 0n
    for (const log of receipt.logs) {
      if (!same(log.address, d.tokenOut.address)) continue
      let event
      try { event = token.parseLog(log) } catch { continue }
      if (event?.name === 'Transfer' && same(event.args.from, d.pair) && same(event.args.to, input.account)) received += event.args.value
    }
    if (swapCount !== 1 || output < BigInt(input.route.minimumAmountOut) || received !== output) throw new SwapRecordMismatchError()
    const [balance] = await this.read(token, d.tokenOut.address, 'balanceOf', [input.account], receipt.blockNumber)
    if (balance < received) throw new Error('Recipient balance does not corroborate the swap receipt')
    await this.wallet.reobserveNativeOperations?.()
    return { status: 'confirmed', ...handle, amountIn: BigInt(input.route.amountIn), amountOut: received, feeWei, totalFeeWei: feeWei }
  }
}
