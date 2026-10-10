import { getEvmDexDeployment } from '../chain/dex-deployments'
import { fetchSwapQuote, planSwap, type SwapPlan } from './evm-swap'
import {
  consolidationNeeded,
  estimateSwapCost,
  executeSwap,
  networkFeeShare,
  reconcileSwap,
  UNESTIMATED_APPROVAL_GAS,
  UNESTIMATED_SWAP_GAS,
  SwapRefusedError,
  type SwapExecutionReader,
  type SwapReceipt,
  type SwapTiming,
  type SwapWallet,
} from './swap-execution'
import { findToken, poolId, routesFor } from './uniswap-v4'
import { SwapRecordMismatchError } from './evm-dex'
import { UniswapV4Dex } from './uniswap-v4-dex'
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
  canned.node.pools.set(
    poolId(routesFor(deployment, MON, USDC)[0]!.key).toLowerCase(),
    {
      sqrtPriceX96: 2n ** 96n,
      liquidity: 10n ** 18n,
      lpFee: 500,
      quote: amountIn => amountIn,
    },
  )
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
    sendContractCall: jest.fn(
      async (params: Parameters<SwapWallet['sendContractCall']>[0]) => {
        const handle = {
          operationId: `op-${++sequence}`,
          txHash: `0xhash${sequence}`,
        }
        events.push(`signed ${handle.operationId}`)
        await params.onSigned?.(handle)
        events.push(`broadcast ${handle.operationId}`)
        known.add(handle.txHash)
        return handle
      },
    ),
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
  const setFunds = (next: Partial<typeof funds>) => {
    funds = { ...funds, ...next }
  }
  return { ...canned, reader, receipts, known, wallet, events, plan, setFunds }
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
      totalFeeWei: 600_000n,
    })
    // The gas limit signed is the one estimated for the fee shown: 200,000 plus a fifth.
    expect(s.wallet.sendContractCall).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { raw: plan.swap.to },
        data: plan.swap.data,
        value: 1_000n,
        gasLimit: 230_000n,
      }),
    )
    // Once the receipt is in, the wallet is asked to take the inclusion into its journal and
    // start its note to self: the swap's own operation, nothing new.
    expect(s.wallet.resumeNativeOperation).toHaveBeenCalledWith('op-1')
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
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan,
        account,
        timing,
      }),
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

  it('refuses while an earlier transaction from the account is unresolved and cannot be finished', async () => {
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

  it('first finishes an earlier contract call of the wallet that never landed, then swaps', async () => {
    const s = setup({ funds: { mainBusy: true } })
    const earlier = { operationId: 'op-lost', txHash: '0xlost' }
    const wallet = {
      ...s.wallet,
      getUnresolvedContractCalls: () => [earlier],
      resumeNativeOperation: jest.fn(async (id: string) => {
        s.events.push(`resumed ${id}`)
        s.receipts.set('0xlost', receiptOf({ logs: [] }))
        s.setFunds({ mainBusy: false })
      }),
    }
    s.receipts.set('0xhash1', receiptOf(vectors.swapNativeIn))
    const stages: string[] = []
    const result = await executeSwap({
      reader: s.reader,
      wallet,
      deployment,
      plan: await s.plan('native-in'),
      account,
      timing,
      onProgress: progress => stages.push(progress.stage),
    })
    expect(s.events).toEqual([
      'resumed op-lost',
      'signed op-1',
      'broadcast op-1',
      // After its receipt: the wallet journals the inclusion and starts its note.
      'resumed op-1',
    ])
    expect(stages[0]).toBe('recovering')
    expect(result.status).toBe('confirmed')
  })

  it('re-submits an approval whose broadcast was lost, and goes on once it lands', async () => {
    const s = setup()
    const plan = await s.plan('token-in')
    // The first approval is recorded by the wallet but the node never hears of it.
    s.wallet.sendContractCall.mockRejectedValueOnce(
      Object.assign(new Error('outcome unknown'), {
        transaction: { txHash: '0xapprove1' },
        operation: { operationId: 'op-approve1' },
      }),
    )
    s.wallet.resumeNativeOperation.mockImplementation(async id => {
      s.events.push(`resumed ${id}`)
      s.receipts.set('0xapprove1', receiptOf({ logs: [] }))
    })
    s.receipts.set('0xhash1', receiptOf({ logs: [] }))
    s.receipts.set('0xhash2', receiptOf(vectors.swapTokenIn))
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      timing,
    })
    expect(s.events[0]).toBe('resumed op-approve1')
    // The lost approval once, and the swap's own operation after its receipt.
    expect(s.wallet.resumeNativeOperation.mock.calls.map(([id]) => id)).toEqual(
      ['op-approve1', 'op-2'],
    )
    expect(s.wallet.sendContractCall).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('confirmed')
  })

  it('does not re-submit a transaction the node still holds, or one it could not ask about', async () => {
    const s = setup()
    const plan = await s.plan('native-in')
    await expect(
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan,
        account,
        timing,
      }),
    ).resolves.toMatchObject({ status: 'pending' })
    await expect(
      executeSwap({
        reader: {
          ...s.reader,
          getTransaction: () => Promise.reject(new Error('rate limited')),
        },
        wallet: s.wallet,
        deployment,
        plan,
        account,
        timing,
      }),
    ).resolves.toMatchObject({ status: 'pending' })
    expect(s.wallet.resumeNativeOperation).not.toHaveBeenCalled()
  })

  it('moves funds into the main account only for the confirmed amount, once', async () => {
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 10n ** 18n } })
    const plan = await s.plan('native-in')
    // Needs 1,000 value plus gas; with no estimate yet the gas is the ceiling for one swap.
    const need = await consolidationNeeded({
      reader: s.reader,
      wallet: s.wallet,
      plan,
    })
    expect(need).toEqual({
      moveWei: 1_000n + UNESTIMATED_SWAP_GAS * 100n * 10n ** 9n - 400n,
      possible: true,
    })
    s.receipts.set('0xhash1', receiptOf(vectors.swapNativeIn))
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      consolidateWei: need.moveWei,
      timing,
    })
    expect(s.events).toEqual([
      `funded ${need.moveWei}`,
      'signed op-1',
      'broadcast op-1',
    ])
    expect(s.wallet.fundMainAccount).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('confirmed')
  })

  it('sizes the move from the estimated fee when there is one, and counts approvals', async () => {
    const s = setup({ funds: { mainBalance: 0n, otherBalance: 5n } })
    const swapFee = { gasLimit: 10n, maxFeePerGas: 3n, maximumFeeWei: 30n }
    expect(
      await consolidationNeeded({
        reader: s.reader,
        wallet: s.wallet,
        plan: await s.plan('native-in'),
        swapFee,
      }),
    ).toEqual({ moveWei: 1_030n, possible: false })
    expect(
      await consolidationNeeded({
        reader: s.reader,
        wallet: s.wallet,
        plan: await s.plan('token-in'),
        swapFee,
      }),
    ).toEqual({
      moveWei: (2n * UNESTIMATED_APPROVAL_GAS + 10n) * 3n,
      possible: false,
    })
  })

  it('never moves funds the user did not confirm', async () => {
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 10n ** 18n } })
    s.wallet.sendContractCall.mockRejectedValue(
      new RangeError('Insufficient unreserved native funds'),
    )
    await expect(
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan: await s.plan('native-in'),
        account,
        timing,
      }),
    ).rejects.toThrow(/Insufficient/)
    expect(s.wallet.fundMainAccount).not.toHaveBeenCalled()
  })

  it('refuses a confirmed move the other accounts can no longer cover', async () => {
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 100n } })
    await expect(
      executeSwap({
        reader: s.reader,
        wallet: s.wallet,
        deployment,
        plan: await s.plan('native-in'),
        account,
        consolidateWei: 600n,
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
    const replay = jest.fn(async (_blockTag?: number) => {
      throw callRevert(tooLittleReceived(990n, 900n))
    })
    const result = await executeSwap({
      reader: {
        ...s.reader,
        call: async tx => (tx.from ? replay(tx.blockTag) : s.reader.call(tx)),
      },
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
      totalFeeWei: 600_000n,
    })
    // Asked at the block the swap failed in, not at whatever block is latest by then.
    expect(replay).toHaveBeenCalledWith(1)
  })
})

describe('what the whole swap costs', () => {
  it('prices a native swap as its one transaction, at the limit times the price charged', async () => {
    const s = setup()
    s.node.gasEstimate = 200_000n
    s.node.maxFeePerGas = 202n
    s.node.baseFeePerGas = 100n
    s.node.maxPriorityFeePerGas = 2n
    const cost = await estimateSwapCost({
      reader: s.reader,
      wallet: s.wallet,
      plan: await s.plan('native-in'),
      account,
      gasChargedOn: 'limit',
    })
    // 230,000 gas reserved at 102, not at the 202 cap and not at the gas used.
    expect(cost.transactions).toEqual([{ kind: 'swap', feeWei: 23_460_000n }])
    expect(cost.networkFeeWei).toBe(23_460_000n)
    expect(cost.complete).toBe(true)
    expect(cost.swapFee?.maximumFeeWei).toBe(46_460_000n)
    // Where only the gas used is charged, the margin is not part of the fee.
    const used = await estimateSwapCost({
      reader: s.reader,
      wallet: s.wallet,
      plan: await s.plan('native-in'),
      account,
    })
    expect(used.networkFeeWei).toBe(20_400_000n)
  })

  it('prices each approval, and says the total is incomplete until the swap can be estimated', async () => {
    const s = setup()
    s.node.gasEstimate = 100_000n
    s.node.maxFeePerGas = 10n
    const cost = await estimateSwapCost({
      reader: s.reader,
      wallet: s.wallet,
      plan: await s.plan('token-in'),
      account,
      gasChargedOn: 'limit',
    })
    expect(cost.transactions).toEqual([
      { kind: 'approval', feeWei: 1_150_000n },
      { kind: 'approval', feeWei: 1_150_000n },
      { kind: 'swap', feeWei: undefined },
    ])
    expect(cost.networkFeeWei).toBe(2_300_000n)
    expect(cost.complete).toBe(false)
  })

  it('counts the transfers of a consolidation', async () => {
    const s = setup()
    s.node.gasEstimate = 100_000n
    s.node.maxFeePerGas = 10n
    const cost = await estimateSwapCost({
      reader: s.reader,
      wallet: { estimateLegacyFee: async () => ({ inputCount: 2 }) },
      plan: await s.plan('native-in'),
      account,
      gasChargedOn: 'limit',
      moveWei: 5n,
    })
    expect(cost.transactions).toEqual([
      { kind: 'consolidation', feeWei: 420_000n },
      { kind: 'swap', feeWei: 1_150_000n },
    ])
    expect(cost.complete).toBe(true)
  })

  it('compares the fee with the amount only when both are the native coin', async () => {
    const s = setup()
    const native = (await s.plan('native-in', 1_000n)).quote
    const token = (await s.plan('token-in', 1_000n)).quote
    expect(networkFeeShare({ networkFeeWei: 1_330n, quote: native })).toBe(133)
    expect(networkFeeShare({ networkFeeWei: 50n, quote: native })).toBe(5)
    // Paid in a token, received in the native coin: compared with what is received.
    expect(networkFeeShare({ networkFeeWei: 500n, quote: token })).toBe(50)
    expect(
      networkFeeShare({
        networkFeeWei: 500n,
        quote: { ...token, tokenOut: token.tokenIn },
      }),
    ).toBeUndefined()
  })

  it('reports the fees of every transaction the swap needed, from their receipts', async () => {
    const s = setup({ funds: { mainBalance: 400n, otherBalance: 10n ** 18n } })
    const plan = await s.plan('token-in')
    s.wallet.fundMainAccount.mockImplementation(async () => ({
      totalFeePaid: 21_000n,
    }))
    for (const hash of ['0xhash1', '0xhash2'])
      s.receipts.set(hash, receiptOf({ logs: [] }))
    s.receipts.set('0xhash3', receiptOf(vectors.swapTokenIn))
    const result = await executeSwap({
      reader: s.reader,
      wallet: s.wallet,
      deployment,
      plan,
      account,
      consolidateWei: 5n,
      timing,
    })
    // One transfer, two approvals and the swap: 21,000 + 3 x 600,000.
    expect(result).toMatchObject({
      status: 'confirmed',
      feeWei: 600_000n,
      totalFeeWei: 1_821_000n,
    })
  })
})

describe('the exchange adapter and the wallet it is given', () => {
  it('quotes, plans and sends through the narrow wallet, and hands the record to the contract send of the swap only', async () => {
    const s = setup()
    for (const hash of ['0xhash1', '0xhash2'])
      s.receipts.set(hash, receiptOf({ logs: [] }))
    s.receipts.set('0xhash3', receiptOf(vectors.swapTokenIn))
    const dex = new UniswapV4Dex('monad-testnet', deployment, {
      reader: s.reader,
      ...s.wallet,
    })
    expect(dex.entry.id).toBe('uniswap-v4')
    expect(dex.tokens).toBe(deployment.tokens)
    const quote = await dex.quote({
      tokenIn: USDC,
      tokenOut: MON,
      amountIn: 1_000n,
    })
    const plan = await dex.plan({ quote, slippageBps: 100, account })
    const result = await dex.execute({ plan, account, timing })
    expect(result.status).toBe('confirmed')
    const records = s.wallet.sendContractCall.mock.calls.map(
      ([params]) => (params as { record?: unknown }).record,
    )
    expect(records.slice(0, 2)).toEqual([undefined, undefined])
    expect(records[2]).toEqual({
      kind: 'swap',
      venueId: 'uniswap-v4',
      account,
      assetIn: { symbol: 'USDC', address: USDC.address, decimals: 6 },
      amountIn: '1000',
      assetOut: { symbol: 'MON', address: null, decimals: 18 },
      quotedAmountOut: quote.amountOut.toString(),
      minimumAmountOut: plan.minimumAmountOut.toString(),
      interfaceFeeAmount: '0',
      // What the swap transaction reserves: 230,000 gas at the price charged.
      networkFeeWei: (230_000n * 100n * 10n ** 9n).toString(),
      route: quote.route,
    })
  })

  it('finishes a recorded swap from its stored route and call, and refuses a route that is not its own', async () => {
    const s = setup()
    s.receipts.set('0xhash7', receiptOf(vectors.swapNativeIn))
    const dex = new UniswapV4Dex('monad-testnet', deployment, {
      reader: s.reader,
      ...s.wallet,
    })
    const plan = await s.plan('native-in')
    const stored = {
      transactionId: '0xhash7',
      operationId: 'op-7',
      account,
      // As it comes back from storage: plain JSON.
      route: JSON.parse(JSON.stringify(plan.quote.route)),
      call: { to: plan.swap.to, data: plan.swap.data, value: '1000' },
      timing,
    }
    expect(await dex.reconcile(stored)).toMatchObject({
      status: 'confirmed',
      amountOut: 19_996n,
    })
    expect(() =>
      dex.reconcile({ ...stored, route: { pool: 'other' } }),
    ).toThrow(/does not belong/)
  })
})

describe('reading what a recorded swap did', () => {
  it("reads the receipt of the account's own swap on this exchange, and refuses a record naming another sender or another contract", async () => {
    const s = setup()
    const own = receiptOf(vectors.swapNativeIn)
    const router = deployment.universalRouter
    s.receipts.set('0xmine', { ...own, from: account.toLowerCase(), to: router })
    s.receipts.set('0xtheirs', {
      ...own,
      from: '0x00000000000000000000000000000000000000aa',
      to: router,
    })
    s.receipts.set('0xelsewhere', {
      ...own,
      from: account,
      to: '0x00000000000000000000000000000000000000bb',
    })
    // A receipt that does not say who sent it proves nothing about whose swap it is.
    s.receipts.set('0xsilent', own)
    const dex = new UniswapV4Dex('monad-testnet', deployment, {
      reader: s.reader,
      ...s.wallet,
    })
    const route = (await s.plan('native-in')).quote.route
    expect(
      await dex.observe({ transactionId: '0xmine', account, route }),
    ).toMatchObject({ status: 'confirmed', amountOut: 19_996n })
    for (const transactionId of ['0xtheirs', '0xelsewhere', '0xsilent'])
      await expect(
        dex.observe({ transactionId, account, route }),
      ).rejects.toThrow(SwapRecordMismatchError)
    expect(
      await dex.observe({ transactionId: '0xnone', account, route }),
    ).toMatchObject({ status: 'pending' })
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
