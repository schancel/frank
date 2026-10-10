/**
 * Canned node answers for unit tests of swap code, at the JSON-RPC seam. It is not a chain: it
 * holds no state and executes nothing. Each test says what the node returns for each read.
 * Anything that claims to show a swap working uses the real network (`*.livecheck.ts`).
 */
import type { UniswapV4Deployment } from '../chain/dex-deployments'
import type { SwapChainReader } from './evm-swap'
import {
  erc20Interface,
  permit2Interface,
  poolId,
  quoterInterface,
  stateViewInterface,
  universalRouterInterface,
} from './uniswap-v4'

export interface CannedPool {
  sqrtPriceX96: bigint
  liquidity: bigint
  lpFee: number
  /** The quoter's answer for an input amount; throw to make the quoter revert. */
  quote: (amountIn: bigint, zeroForOne: boolean) => bigint
}

export interface CannedNode {
  pools: Map<string, CannedPool>
  nativeBalance: bigint
  tokenBalance: Map<string, bigint>
  tokenAllowance: bigint
  permit2Allowance: { amount: bigint; expiration: number }
  gasEstimate: bigint | Error
  maxFeePerGas: bigint
  /** The latest block's base fee and the tip; unset means the node gives neither. */
  baseFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  calls: { to: string; selector: string }[]
}

export function callRevert(data?: string): Error {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data,
  })
}

export function tooLittleReceived(minimum: bigint, received: bigint): string {
  return universalRouterInterface.encodeErrorResult('V4TooLittleReceived', [
    minimum,
    received,
  ])
}

export function cannedNode(
  deployment: UniswapV4Deployment,
  overrides: Partial<CannedNode> = {},
): { node: CannedNode; reader: SwapChainReader } {
  const node: CannedNode = {
    pools: new Map(),
    nativeBalance: 10n ** 18n,
    tokenBalance: new Map(),
    tokenAllowance: 0n,
    permit2Allowance: { amount: 0n, expiration: 0 },
    gasEstimate: 200_000n,
    maxFeePerGas: 100n * 10n ** 9n,
    calls: [],
    ...overrides,
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const reader: SwapChainReader = {
    async call(tx) {
      const selector = tx.data.slice(0, 10)
      node.calls.push({ to: tx.to, selector })
      if (same(tx.to, deployment.stateView)) {
        const slot0 = stateViewInterface.getFunction('getSlot0')!
        const fn = selector === slot0.selector ? 'getSlot0' : 'getLiquidity'
        const [id] = stateViewInterface.decodeFunctionData(fn, tx.data)
        const pool = node.pools.get(String(id).toLowerCase())
        return fn === 'getSlot0'
          ? stateViewInterface.encodeFunctionResult(fn, [
              pool?.sqrtPriceX96 ?? 0n,
              0,
              0,
              pool?.lpFee ?? 0,
            ])
          : stateViewInterface.encodeFunctionResult(fn, [pool?.liquidity ?? 0n])
      }
      if (same(tx.to, deployment.quoter)) {
        const [params] = quoterInterface.decodeFunctionData(
          'quoteExactInputSingle',
          tx.data,
        )
        const key = {
          currency0: params.poolKey.currency0,
          currency1: params.poolKey.currency1,
          fee: Number(params.poolKey.fee),
          tickSpacing: Number(params.poolKey.tickSpacing),
          hooks: params.poolKey.hooks,
        }
        const pool = node.pools.get(poolId(key).toLowerCase())
        if (!pool) throw callRevert()
        return quoterInterface.encodeFunctionResult('quoteExactInputSingle', [
          pool.quote(BigInt(params.exactAmount), params.zeroForOne),
          50_000n,
        ])
      }
      if (same(tx.to, deployment.permit2))
        return permit2Interface.encodeFunctionResult('allowance', [
          node.permit2Allowance.amount,
          node.permit2Allowance.expiration,
          0,
        ])
      if (selector === erc20Interface.getFunction('balanceOf')!.selector)
        return erc20Interface.encodeFunctionResult('balanceOf', [
          node.tokenBalance.get(tx.to.toLowerCase()) ?? 0n,
        ])
      if (selector === erc20Interface.getFunction('allowance')!.selector)
        return erc20Interface.encodeFunctionResult('allowance', [
          node.tokenAllowance,
        ])
      throw new Error(`unexpected call to ${tx.to}`)
    },
    async estimateGas() {
      if (node.gasEstimate instanceof Error) throw node.gasEstimate
      return node.gasEstimate
    },
    async getBalance() {
      return node.nativeBalance
    },
    async getFeeData() {
      return {
        maxFeePerGas: node.maxFeePerGas,
        gasPrice: null,
        maxPriorityFeePerGas: node.maxPriorityFeePerGas ?? null,
      }
    },
    async getBlock() {
      return { baseFeePerGas: node.baseFeePerGas ?? null }
    },
  }
  return { node, reader }
}
