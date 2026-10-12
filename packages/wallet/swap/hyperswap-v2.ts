/** Disabled HyperSwap V2 testnet native -> test PURR adapter. No registration side effects.
 * Deployment: https://docs.hyperswap.exchange/docs/amm/contracts/testnet/v2/
 * Tokens: https://docs.hyperswap.exchange/docs/amm/contracts/testnet/
 * Wallet owns custody, reservations, signed-byte persistence, and resubmission. This module
 * owns quote/calldata/receipt interpretation only. It never creates an exchange account.
 */
import { Interface, getAddress } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import type { EvmDexPlan, EvmDexQuote } from './evm-dex'
import { SwapRecordMismatchError } from './evm-dex'
import { estimateCallFee, quoteIsFresh, SwapNoRouteError } from './evm-swap'
import type { SwapExecutionReader, SwapWallet, SwapResult } from './swap-execution'

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
export interface HyperSwapReader extends Omit<SwapExecutionReader, 'getBlock' | 'getTransaction'> {
  getNetwork(): Promise<{ chainId: bigint }>
  getBlock(tag: number | 'latest'): Promise<{ hash: string | null; baseFeePerGas: bigint | null } | null>
  getCode(address: string): Promise<string>
  getTransaction(hash: string): Promise<{ from: string; to: string | null; data: string; value: bigint; chainId: bigint } | null>
}
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
export interface HyperSwapHandle { readonly operationId: string; readonly txHash: string }

/** No fallback chain, token, router, or pair is accepted. */
export class HyperSwapV2Testnet {
  readonly entry = d
  constructor(private readonly reader: HyperSwapReader,
    private readonly wallet: SwapWallet, private readonly now: () => number = Date.now) {}

  private async read(abi: Interface, address: string, name: string, args: unknown[] = [], blockTag?: number) {
    const result = await this.reader.call({ to: address, data: abi.encodeFunctionData(name, args), ...(blockTag === undefined ? {} : { blockTag }) })
    return abi.decodeFunctionResult(name, result)
  }
  async verifyDeployment(): Promise<void> {
    const protocol = PROTOCOL_CHAINS[d.chainIdentifier]
    if ((await this.reader.getNetwork()).chainId.toString() !== protocol.nativeChainId.toString())
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
      codes.some(code => typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code)))
      throw new Error('HyperSwap deployment mismatch')
  }
  async quote(amountIn: bigint): Promise<EvmDexQuote> {
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
  /** Re-quotes rather than trusting caller-supplied amounts or route. Max slippage 5%; 120s expiry. */
  async plan(input: { amountIn: bigint; account: string; slippageBps: number }): Promise<HyperSwapPlan> {
    const quote = await this.quote(input.amountIn)
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
  private validateRoute(route: HyperSwapRoute) {
    if (route.kind !== 'hyperswap-v2-native-purr' || !/^\d+$/.test(route.amountIn) || !/^\d+$/.test(route.minimumAmountOut) ||
      !Number.isSafeInteger(route.deadline) || route.deadline <= 0) throw new SwapRecordMismatchError()
    getAddress(route.account); positive(BigInt(route.amountIn)); positive(BigInt(route.minimumAmountOut))
  }
  /** One native call only. No implicit consolidation/approval. A submitted handle must be reconciled. */
  async execute(plan: HyperSwapPlan, maximumDebitWei: bigint): Promise<SwapResult> {
    await this.verifyDeployment()
    const call = this.callFor(plan.route)
    if (!quoteIsFresh(plan.quote, this.now()) || plan.deadline !== plan.route.deadline ||
      plan.deadline <= Math.floor(this.now() / 1000) || plan.deadline > Math.floor(this.now() / 1000) + 120 ||
      plan.minimumAmountOut !== BigInt(plan.route.minimumAmountOut) || plan.quote.amountIn !== call.value ||
      !same(plan.account, plan.route.account) || plan.approvals.length ||
      !same(plan.swap.to, call.to) || plan.swap.data !== call.data || plan.swap.value !== call.value)
      throw new Error('Swap plan changed or expired; review a new quote')
    if (!Number.isInteger(plan.slippageBps) || plan.slippageBps < 0 || plan.slippageBps > 500 ||
      plan.minimumAmountOut !== plan.quote.amountOut * BigInt(10_000 - plan.slippageBps) / 10_000n)
      throw new Error('Invalid minimum received')
    const funds = await this.wallet.getContractCallFunds()
    if (!same(funds.mainAddress, plan.account) || funds.mainBusy || this.wallet.getUnresolvedContractCalls?.().length)
      throw new Error('Swap account is changed or busy; reconcile its original operation')
    const fee = await estimateCallFee(this.reader, call, plan.account)
    if (call.value + fee.maximumFeeWei > maximumDebitWei || funds.mainBalance < call.value + fee.maximumFeeWei)
      throw new Error('Swap exceeds available funds or the authorized maximum debit')
    let handle: HyperSwapHandle
    try {
      handle = await this.wallet.sendContractCall({ to: { raw: call.to }, data: call.data, value: call.value, gasLimit: fee.gasLimit,
        record: { kind: 'swap', venueId: d.id, account: plan.account,
          assetIn: d.tokenIn, amountIn: call.value.toString(), assetOut: d.tokenOut,
          quotedAmountOut: plan.quote.amountOut.toString(), minimumAmountOut: plan.minimumAmountOut.toString(),
          interfaceFeeAmount: '0', route: plan.route, networkFeeWei: fee.chargedFeeWei.toString() } })
    } catch (error) {
      const pending = error as { operation?: { operationId?: string }; transaction?: { txHash?: string } }
      if (!pending.operation?.operationId || !pending.transaction?.txHash) throw error
      handle = { operationId: pending.operation.operationId, txHash: pending.transaction.txHash }
    }
    return this.observe(handle, plan.route)
  }
  /** Does not sign, select funds, or create an operation. Only the durable owner replays bytes. */
  async reconcile(handle: HyperSwapHandle, route: HyperSwapRoute): Promise<SwapResult> {
    await this.verifyDeployment(); this.validateRoute(route)
    const tx = await this.reader.getTransaction(handle.txHash)
    if (tx) this.validateTransaction(tx, route)
    else {
      if (!this.wallet.resumeNativeOperation) return { status: 'pending', ...handle }
      await this.wallet.resumeNativeOperation(handle.operationId)
    }
    return this.observe(handle, route)
  }
  private validateTransaction(tx: NonNullable<Awaited<ReturnType<HyperSwapReader['getTransaction']>>>, route: HyperSwapRoute) {
    const call = this.callFor(route)
    if (tx.chainId !== 998n || !same(tx.from, route.account) || !same(tx.to, call.to) || tx.data !== call.data || tx.value !== call.value)
      throw new SwapRecordMismatchError()
  }
  async observe(handle: HyperSwapHandle, route: HyperSwapRoute): Promise<SwapResult> {
    await this.verifyDeployment(); this.validateRoute(route)
    const receipt = await this.reader.getTransactionReceipt(handle.txHash)
    if (!receipt) return { status: 'pending', ...handle }
    const tx = await this.reader.getTransaction(handle.txHash)
    if (!tx || !same(receipt.from, route.account) || !same(receipt.to, d.router)) throw new SwapRecordMismatchError()
    this.validateTransaction(tx, route)
    const feeWei = receipt.gasUsed * receipt.gasPrice
    if (receipt.status === 0) return { status: 'reverted', ...handle, feeWei, totalFeeWei: feeWei }
    if (receipt.status !== 1) return { status: 'pending', ...handle }
    let output = 0n, swapCount = 0
    for (const log of receipt.logs) {
      if (same(log.address, d.pair)) {
        let event
        try { event = pair.parseLog(log) } catch { continue }
        if (event?.name === 'Swap') {
          if (!same(event.args.sender, d.router) || !same(event.args.to, route.account) ||
            event.args.amount0In !== BigInt(route.amountIn) || event.args.amount1In !== 0n || event.args.amount0Out !== 0n)
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
      if (event?.name === 'Transfer' && same(event.args.from, d.pair) && same(event.args.to, route.account)) received += event.args.value
    }
    if (swapCount !== 1 || output < BigInt(route.minimumAmountOut) || received !== output) throw new SwapRecordMismatchError()
    const [balance] = await this.read(token, d.tokenOut.address, 'balanceOf', [route.account], receipt.blockNumber)
    if (balance < received) throw new Error('Recipient balance does not corroborate the swap receipt')
    await this.wallet.reobserveNativeOperations?.()
    return { status: 'confirmed', ...handle, amountIn: BigInt(route.amountIn), amountOut: received, feeWei, totalFeeWei: feeWei }
  }
}
