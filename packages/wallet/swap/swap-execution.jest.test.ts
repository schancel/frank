import { getEvmDexDeployment } from '../chain/dex-deployments'
import { fetchSwapQuote, planSwap, type SwapPlan } from './evm-swap'
import {
  executeSwap,
  reconcileSwap,
  SwapRefusedError,
  type SwapExecutionReader,
  type SwapReceipt,
  type SwapTiming,
  type SwapWallet,
} from './swap-execution'
import { findToken, poolId, routesFor } from './uniswap-v4'
import {
  callRevert,
  cannedNode,
  tooLittleReceived,
} from './swap-reader.testutil'
import vectors from './monad-testnet-swap-vectors.json'

const deployment = getEvmDexDeployment('monad-testnet')!
const MON = findToken(deployment, 'MON')!
const USDC = findToken(deployment, 'USDC')!
const account = vectors.account
const timing: SwapTiming = {
  inclusionTimeoutMs: 3,
  pollMs: 1,
  sleep: async () => undefined,
}
const receiptOf = (
  vector: { logs: { address: string; topics: string[]; data: string }[] },
  status = 1,
): SwapReceipt => ({
  status,
  blockNumber: 1,
  gasUsed: 200_000n,
  gasPrice: 3n,
  logs: vector.logs,
})

function setup(
  options: {
    funds?: Partial<Awaited<ReturnType<SwapWallet['getContractCallFunds']>>>
  } = {},
) {
  const canned = cannedNode(deployment)
  canned.node.pools.set(poolId(routesFor(deployment, MON, USDC)[0]!.key).toLowerCase(), {
    sqrtPriceX96: 2n ** 96n,
    liquidity: 10n ** 18n,
    lpFee: 500,
    quote: amountIn => amountIn,
  })
  const receipts = new Map<string, SwapReceipt>()
  const known = new Set<string>()
  const reader: SwapExecutionReader = {
    ...canned.reader,
    getTransactionReceipt: async hash => receipts.get(hash) ?? null,
    getTransaction: async hash => (known.has(hash) ? {} : null),
  }
  const events: string[] = []
  let sequence = 0
  let funds = {
    mainAddress: account.toLowerCase(),
    mainBalance: 10n ** 18n,
    otherBalance: 0n,
    mainBusy: false,
    ...options.funds,
  }
  const wallet = {
    sendContractCall: jest.fn(async (params: Parameters<SwapWallet['sendContractCall']>[0]) => {
      const handle = {
        operationId: `op-${++sequence}`,
        txHash: `0xhash${sequence}`,
      }
      events.push(`signed ${handle.operationId}`)
      await params.onSigned?.(handle)
      events.push(`broadcast ${handle.operationId}`)
      known.add(handle.txHash)
      return handle
    }),
    getContractCallFunds: jest.fn(async () => funds),
    fundMainAccount: jest.fn(async ({ value }: { value: bigint }) => {
      events.push(`funded ${value}`)
      funds = {
        ...funds,
        mainBalance: funds.mainBalance + value,
        otherBalance: funds.otherBalance - value,
      }
    }),
    resumeNativeOperation: jest.fn(async (_operationId: string) => undefined),
    reobserveNativeOperations: jest.fn(async () => undefined),
  }
  const plan = async (
    direction: 'native-in' | 'token-in',
    amountIn = 1_000n,
  ): Promise<SwapPlan> =>
    planSwap(canned.reader, deployment, {
      quote: await fetchSwapQuote(canned.reader, deployment, {
        tokenIn: direction === 'native-in' ? MON : USDC,
        tokenOut: direction === 'native-in' ? USDC : MON,
        amountIn,
      }),
      slippageBps: 100,
      account,
    })
  return { ...canned, reader, receipts, known, wallet, events, plan }
}

describe('executing a swap', () => {
  it('records the swap before it is broadcast and reports what the receipt says, not the quote', async () => {
    const s = setup()
    const plan = await s.plan('native-in')
    s.receipts.set('0xhash1', receiptOf(vectors.swapNativeIn))
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      timing,
      onSigned: async signed => {
        s.events.push(`recorded ${signed.operationId}`)
      },
    })
    expect(s.events).toEqual(['signed op-1', 'recorded op-1', 'broadcast op-1'])
    expect(plan.quote.amountOut).toBe(1_000n)
    expect(result).toEqual({
      status: 'confirmed',
      operationId: 'op-1',
      txHash: '0xhash1',
      amountIn: 20_000_000_000_000_000n,
      amountOut: 19_996n,
      feeWei: 600_000n,
    })
    // The gas limit signed is the one estimated for the fee shown: 200,000 plus a fifth.
    expect(s.wallet.sendContractCall).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { raw: plan.swap.to },
        data: plan.swap.data,
        value: 1_000n,
        gasLimit: 240_000n,
      }),
    )
    expect(s.wallet.reobserveNativeOperations).toHaveBeenCalled()
  })

  it('sends exact approvals first, each confirmed before the next transaction', async () => {
    const s = setup()
    const plan = await s.plan('token-in')
    for (const hash of ['0xhash1', '0xhash2'])
      s.receipts.set(hash, receiptOf({ logs: [] }))
    s.receipts.set('0xhash3', receiptOf(vectors.swapTokenIn))
    const stages: string[] = []
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      timing,
      onProgress: progress =>
        stages.push(
          progress.stage === 'approving'
            ? `approving ${progress.step}/${progress.of}`
            : progress.stage,
        ),
    })
    expect(s.wallet.sendContractCall.mock.calls.map(([p]) => p.data)).toEqual([
      plan.approvals[0]!.call.data,
      plan.approvals[1]!.call.data,
      plan.swap.data,
    ])
    expect([...new Set(stages)]).toEqual([
      'approving 1/2',
      'approving 2/2',
      'signing',
      'submitted',
    ])
    expect(result).toMatchObject({
      status: 'confirmed',
      amountOut: 14_988_096_860_619_966n,
    })
  })

  it('stops when an approval fails and never sends the swap', async () => {
    const s = setup()
    const plan = await s.plan('token-in')
    s.receipts.set('0xhash1', receiptOf({ logs: [] }, 0))
    await expect(
      executeSwap({ reader: s.reader, wallet: s.wallet, deployment, plan, account, timing }),
    ).rejects.toMatchObject({ reason: 'approval-failed' })
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
  })

  it('refuses before signing when the price has moved beyond the slippage', async () => {
    const s = setup()
    const plan = await s.plan('native-in')
    s.node.gasEstimate = callRevert(tooLittleReceived(990n, 900n))
    const refusal = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      timing,
    }).catch(error => error)
    expect(refusal).toBeInstanceOf(SwapRefusedError)
    expect(refusal.reason).toBe('slippage')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })

  it('refuses while an earlier transaction from the account is unresolved', async () => {
    const s = setup({ funds: { mainBusy: true } })
    await expect(
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan: await s.plan('native-in'),
        account,
        timing,
      }),
    ).rejects.toMatchObject({ reason: 'account-busy' })
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })

  it('moves a shortfall into the main account first, by the wallet’s consolidation', async () => {
    // Needs 1,000 value + 240,000 gas * 100 gwei.
    const fee = 240_000n * 100n * 10n ** 9n
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 10n ** 18n } })
    s.receipts.set('0xhash1', receiptOf(vectors.swapNativeIn))
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan: await s.plan('native-in'),
      account,
      timing,
    })
    expect(s.events).toEqual([
      'funded 600',
      `funded ${fee}`,
      'signed op-1',
      'broadcast op-1',
    ])
    expect(result.status).toBe('confirmed')
  })

  it('says the native coin is short when no other account can cover it', async () => {
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 100n } })
    await expect(
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan: await s.plan('native-in'),
        account,
        timing,
      }),
    ).rejects.toMatchObject({ reason: 'insufficient-native' })
    expect(s.wallet.fundMainAccount).not.toHaveBeenCalled()
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })

  it('treats a submission of unknown outcome as submitted, and a missing receipt as pending', async () => {
    const s = setup()
    s.wallet.sendContractCall.mockRejectedValueOnce(
      Object.assign(new Error('outcome unknown'), {
        transaction: { txHash: '0xlost' },
        operation: { operationId: 'op-lost' },
      }),
    )
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan: await s.plan('native-in'),
      account,
      timing,
    })
    expect(result).toEqual({
      status: 'pending',
      operationId: 'op-lost',
      txHash: '0xlost',
    })
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(1)
  })

  it('reports a reverted swap with its cause and its cost, and no received amount', async () => {
    const s = setup()
    const plan = await s.plan('native-in')
    s.receipts.set('0xhash1', receiptOf({ logs: [] }, 0))
    const replay = jest.fn(async () => {
      throw callRevert(tooLittleReceived(990n, 900n))
    })
    const result = await executeSwap({
      reader: { ...s.reader, call: async tx => (tx.from ? replay() : s.reader.call(tx)) },
      wallet: s.wallet,
      deployment,
      plan,
      account,
      timing,
    })
    expect(result).toEqual({
      status: 'reverted',
      operationId: 'op-1',
      txHash: '0xhash1',
      reason: 'slippage',
      feeWei: 600_000n,
    })
  })
})

describe('reconciling a swap recorded as submitted', () => {
  const handle = { operationId: 'op-7', txHash: '0xhash7' }
  const args = async (s: ReturnType<typeof setup>) => {
    const plan = await s.plan('native-in')
    return {
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      route: plan.quote.route,
      account,
      swap: plan.swap,
      handle,
      timing,
    }
  }

  it('finishes from the receipt when the chain has it', async () => {
    const s = setup()
    s.receipts.set('0xhash7', receiptOf(vectors.swapNativeIn))
    expect(await reconcileSwap(await args(s))).toMatchObject({
      status: 'confirmed',
      amountOut: 19_996n,
    })
    expect(s.wallet.resumeNativeOperation).not.toHaveBeenCalled()
  })

  it('leaves a transaction the node still holds alone', async () => {
    const s = setup()
    s.known.add('0xhash7')
    expect(await reconcileSwap(await args(s))).toEqual({
      status: 'pending',
      ...handle,
    })
    expect(s.wallet.resumeNativeOperation).not.toHaveBeenCalled()
  })

  it('re-submits the same recorded operation when the chain never saw it, never a new one', async () => {
    const s = setup()
    s.wallet.resumeNativeOperation.mockImplementation(async () => {
      s.receipts.set('0xhash7', receiptOf(vectors.swapNativeIn))
    })
    expect(await reconcileSwap(await args(s))).toMatchObject({
      status: 'confirmed',
      ...handle,
    })
    expect(s.wallet.resumeNativeOperation).toHaveBeenCalledWith('op-7')
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })
})
