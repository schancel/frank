/**
 * HyperSwap V2 behind the EVM dex interface, against canned node answers at the JSON-RPC seam
 * (no chain is simulated). That the configured contracts are live and quote is shown against
 * the real network by `hyperswap-v2.livecheck.ts`.
 */
import { Interface, getAddress } from 'ethers'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import {
  getEvmDexDeployment,
  listEnabledEvmDexEntries,
  listEvmDexDeploymentChains,
  listEvmSwapVenues,
  type HyperSwapV2Deployment,
} from '../chain/dex-deployments'
import { HYPERLIQUID_TESTNET_DEX } from '../chain/dex-entries'
import { SwapRecordMismatchError, type EvmDexWallet } from './evm-dex'
import { SwapNoRouteError } from './evm-swap'
import { HyperSwapV2Dex, type HyperSwapV2Route } from './hyperswap-v2'
import type {
  SwapExecutionReader,
  SwapReceipt,
  SwapTiming,
  SwapWallet,
} from './swap-execution'

const CHAIN = 'hyperliquid-testnet'
const entry = getEvmDexDeployment(CHAIN) as HyperSwapV2Deployment
const [THYPE, PURR] = entry.tokens as [
  (typeof entry.tokens)[number],
  (typeof entry.tokens)[number],
]
const pair = entry.pairs[0]!
const account = getAddress('0x1111111111111111111111111111111111111111')
const stranger = getAddress('0x2222222222222222222222222222222222222222')
const NOW_MS = 1_800_000_000_000
const timing: SwapTiming = {
  inclusionTimeoutMs: 3,
  pollMs: 1,
  sleep: async () => undefined,
}

const router = new Interface([
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const swapRouter = new Interface([
  'function factoryV2() view returns (address)',
  'function WETH9() view returns (address)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])
/** The one swap a planned call carries: its deadline and the inner swap's arguments. */
const decodeSwap = (data: string) => {
  const [deadline, calls] = swapRouter.decodeFunctionData('multicall', data)
  expect(calls).toHaveLength(1)
  const [amountIn, min, path, to] = swapRouter.decodeFunctionData(
    'swapExactTokensForTokens',
    calls[0],
  )
  return {
    deadline: Number(deadline),
    amountIn: BigInt(amountIn),
    min: BigInt(min),
    path: [...path],
    to,
  }
}
const factory = new Interface([
  'function getPair(address tokenA, address tokenB) view returns (address)',
])
const pairAbi = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
])
const erc20 = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Canned answers for the router, factory and pair; `overrides` changes one of them. */
function setup(
  overrides: {
    weth?: string
    swapFactory?: string
    listedPair?: string
    amountOut?: (amountIn: bigint) => bigint
    funds?: Partial<Awaited<ReturnType<SwapWallet['getContractCallFunds']>>>
    latestTimestamp?: number
  } = {},
) {
  const calls: string[] = []
  const receipts = new Map<string, SwapReceipt>()
  const known = new Set<string>()
  const reserves = [10n ** 22n, 2n * 10n ** 25n] as const // 1 tHYPE ~ 2000 PURR
  const amountOut =
    overrides.amountOut ??
    ((amountIn: bigint) => {
      const inFee = amountIn * 997n
      return (inFee * reserves[1]) / (reserves[0] * 1000n + inFee)
    })
  const reader: SwapExecutionReader = {
    async call(tx) {
      const selector = tx.data.slice(0, 10)
      calls.push(`${tx.to.toLowerCase()}:${selector}`)
      const fn = (abi: Interface, name: string) =>
        selector === abi.getFunction(name)!.selector
      if (same(tx.to, entry.router)) {
        if (fn(router, 'factory'))
          return router.encodeFunctionResult('factory', [entry.factory])
        if (fn(router, 'WETH'))
          return router.encodeFunctionResult('WETH', [
            overrides.weth ?? entry.wrappedNative,
          ])
        if (fn(router, 'getAmountsOut')) {
          const [amountIn] = router.decodeFunctionData('getAmountsOut', tx.data)
          return router.encodeFunctionResult('getAmountsOut', [
            [amountIn, amountOut(BigInt(amountIn))],
          ])
        }
      }
      if (same(tx.to, entry.swapRouter)) {
        if (fn(swapRouter, 'factoryV2'))
          return swapRouter.encodeFunctionResult('factoryV2', [
            overrides.swapFactory ?? entry.factory,
          ])
        if (fn(swapRouter, 'WETH9'))
          return swapRouter.encodeFunctionResult('WETH9', [entry.wrappedNative])
      }
      if (same(tx.to, entry.factory))
        return factory.encodeFunctionResult('getPair', [
          overrides.listedPair ?? pair.address,
        ])
      if (same(tx.to, pair.address)) {
        if (fn(pairAbi, 'token0'))
          return pairAbi.encodeFunctionResult('token0', [pair.token0])
        if (fn(pairAbi, 'token1'))
          return pairAbi.encodeFunctionResult('token1', [pair.token1])
        if (fn(pairAbi, 'getReserves'))
          return pairAbi.encodeFunctionResult('getReserves', [
            reserves[0],
            reserves[1],
            0,
          ])
      }
      throw new Error(`unexpected call to ${tx.to} ${selector}`)
    },
    estimateGas: async () => 150_000n,
    getBalance: async () => 0n,
    getFeeData: async () => ({ maxFeePerGas: 10n ** 9n, gasPrice: null }),
    getBlock: async () => ({
      baseFeePerGas: 10n ** 8n,
      timestamp: overrides.latestTimestamp ?? NOW_MS / 1000,
    }),
    getTransactionReceipt: async hash => receipts.get(hash) ?? null,
    getTransaction: async hash => (known.has(hash) ? {} : null),
  }
  let funds = {
    mainAddress: account.toLowerCase(),
    mainBalance: 10n ** 18n,
    otherBalance: 0n,
    mainBusy: false,
    ...overrides.funds,
  }
  let sequence = 0
  const wallet = {
    reader,
    sendContractCall: jest.fn(
      async (params: Parameters<SwapWallet['sendContractCall']>[0]) => {
        const handle = {
          operationId: `op-${++sequence}`,
          txHash: `0xhash${sequence}`,
        }
        await params.onSigned?.(handle)
        known.add(handle.txHash)
        return handle
      },
    ),
    getContractCallFunds: jest.fn(async () => funds),
    fundMainAccount: jest.fn(async ({ value }: { value: bigint }) => {
      funds = {
        ...funds,
        mainBalance: funds.mainBalance + value,
        otherBalance: funds.otherBalance - value,
      }
    }),
    estimateLegacyFee: jest.fn(async () => ({ inputCount: 2 })),
    resumeNativeOperation: jest.fn(async (_id: string) => undefined),
    reobserveNativeOperations: jest.fn(async () => undefined),
    cancelContractCall: jest.fn(async (_id: string) => ({
      state: 'cancelling' as const,
      cancelTxHash: '0xcancel',
    })),
  }
  const dex = new HyperSwapV2Dex(
    CHAIN,
    entry,
    wallet as unknown as EvmDexWallet,
    () => NOW_MS,
  )
  return { dex, reader, wallet, receipts, known, calls, amountOut }
}

/** The logs a successful native-in swap of `amountIn` for `amountOut` to `to` leaves. */
function swapLogs(amountIn: bigint, amountOut: bigint, to = account) {
  const swap = pairAbi.encodeEventLog('Swap', [
    entry.swapRouter,
    amountIn,
    0n,
    0n,
    amountOut,
    to,
  ])
  const transfer = erc20.encodeEventLog('Transfer', [pair.address, to, amountOut])
  return [
    { address: PURR.address!, ...transfer },
    { address: pair.address, ...swap },
  ]
}
const receiptOf = (
  logs: SwapReceipt['logs'],
  status = 1,
  from = account,
): SwapReceipt => ({
  from,
  to: entry.swapRouter,
  status,
  blockNumber: 7,
  gasUsed: 120_000n,
  gasPrice: 2n * 10n ** 8n,
  logs,
})

describe('configuration', () => {
  it('is the dex list of the hyperliquid-testnet registry row', () => {
    expect(PROTOCOL_CHAINS[CHAIN]!.dex).toEqual(HYPERLIQUID_TESTNET_DEX)
    expect(listEvmSwapVenues(CHAIN).map(venue => venue.id)).toEqual([
      'hyperswap-v2',
    ])
    expect(entry.adapter).toBe('hyperswap-v2')
    expect(entry.tokens.map(token => token.symbol)).toEqual(['tHYPE', 'PURR'])
    for (const address of [
      entry.router,
      entry.swapRouter,
      entry.factory,
      entry.wrappedNative,
      pair.address,
      pair.token0,
      pair.token1,
    ])
      expect(getAddress(address)).toBe(address)
    expect(listEvmDexDeploymentChains()).toEqual(
      expect.arrayContaining(['monad-testnet', CHAIN]),
    )
    // Its token is a configured asset of the network, as every enabled venue's tokens are.
    expect(
      listEnabledEvmDexEntries(CHAIN).flatMap(venue =>
        venue.tokens.map(token => token.address),
      ),
    ).toEqual([null, PURR.address])
  })

  it('is not offered while an interface fee is configured: its router cannot take one', () => {
    const saved = { ...process.env }
    try {
      process.env.EVM_SWAP_INTERFACE_FEE_RECIPIENT =
        '0x3333333333333333333333333333333333333333'
      process.env.SWAP_INTERFACE_FEE_BPS = '25'
      expect(listEvmSwapVenues(CHAIN)).toEqual([])
      expect(getEvmDexDeployment(CHAIN)).toBeUndefined()
      // The fee changes what is offered, not which tokens the network has.
      expect(listEnabledEvmDexEntries(CHAIN)).toHaveLength(1)
      // Uniswap v4 carries the fee and is still offered, with it.
      expect(listEvmSwapVenues('monad-testnet')[0]?.interfaceFee).toEqual({
        bps: 25,
        recipient: '0x3333333333333333333333333333333333333333',
      })
    } finally {
      process.env = saved
    }
  })

  it('refuses at load an entry of this kind that names an interface fee', () => {
    jest.isolateModules(() => {
      jest.doMock('../chain/dex-entries', () => {
        const actual = jest.requireActual('../chain/dex-entries')
        return {
          ...actual,
          HYPERLIQUID_TESTNET_DEX: [
            {
              ...actual.HYPERLIQUID_TESTNET_DEX[0],
              interfaceFee: { bps: 10, recipient: stranger },
            },
          ],
        }
      })
      expect(() => require('../chain/dex-deployments')).toThrow(
        'hyperswap-v2 cannot carry an interface fee',
      )
    })
    jest.dontMock('../chain/dex-entries')
  })
})

describe('quote', () => {
  it('is the router’s answer for exactly this amount, with the pair’s fee and the price impact', async () => {
    const s = setup()
    const amountIn = 10n ** 16n
    const quote = await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn })
    expect(quote.amountIn).toBe(amountIn)
    expect(quote.amountOut).toBe(s.amountOut(amountIn))
    expect(quote.poolAmountOut).toBe(quote.amountOut)
    expect(quote.interfaceFee).toBeUndefined()
    expect(quote.lpFeePpm).toBe(3000)
    // 0.01 of 10,000 in the pool moves the price by about one part in a million.
    expect(quote.priceImpactPpm).toBeLessThan(5)
    expect(quote.quotedAtMs).toBe(NOW_MS)
    expect(quote.route).toEqual({
      kind: 'hyperswap-v2',
      pair: pair.address,
      path: [entry.wrappedNative, PURR.address],
    })
  })

  it('checks the router, factory and pair once, and refuses a deployment that does not match', async () => {
    const s = setup()
    await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 1000n })
    await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 2000n })
    const factoryCalls = s.calls.filter(c => c.startsWith(entry.factory.toLowerCase()))
    expect(factoryCalls).toHaveLength(1)

    for (const bad of [
      { weth: stranger },
      { swapFactory: stranger },
      { listedPair: stranger },
    ]) {
      const t = setup(bad)
      await expect(
        t.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 1000n }),
      ).rejects.toThrow(/does not match its configuration/)
    }
  })

  it('has no route for any other direction or token', async () => {
    const s = setup()
    const other = { ...PURR, address: stranger, symbol: 'X' }
    for (const [tokenIn, tokenOut] of [
      [PURR, THYPE],
      [THYPE, THYPE],
      [THYPE, other],
    ] as const)
      await expect(
        s.dex.quote({ tokenIn, tokenOut, amountIn: 1000n }),
      ).rejects.toBeInstanceOf(SwapNoRouteError)
    await expect(
      s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 0n }),
    ).rejects.toThrow(RangeError)
  })
})

describe('plan and execute', () => {
  it('plans one SwapRouter02 swap through the pair paying the account, with the slippage floor and deadline', async () => {
    const s = setup()
    const quote = await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 10n ** 16n })
    const plan = await s.dex.plan({ quote, slippageBps: 100, account })
    expect(plan.approvals).toEqual([])
    expect(plan.minimumAmountOut).toBe((quote.amountOut * 9900n) / 10000n)
    expect(plan.deadline).toBe(NOW_MS / 1000 + 120)
    // The published V2 router only quotes; the swap goes to SwapRouter02, paid as call value.
    expect(plan.swap.to).toBe(entry.swapRouter)
    expect(plan.swap.value).toBe(10n ** 16n)
    expect(decodeSwap(plan.swap.data)).toEqual({
      deadline: plan.deadline,
      amountIn: 10n ** 16n,
      min: plan.minimumAmountOut,
      path: [entry.wrappedNative, PURR.address],
      to: account,
    })
  })

  it('moves the confirmed amount in first, sends the swap with its record and deadline, and reports the receipt', async () => {
    const s = setup({ funds: { mainBalance: 0n, otherBalance: 10n ** 18n } })
    const amountIn = 10n ** 16n
    const quote = await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn })
    const plan = await s.dex.plan({ quote, slippageBps: 50, account })
    const need = await s.dex.consolidation({ plan })
    expect(need.possible).toBe(true)
    expect(need.moveWei).toBeGreaterThan(amountIn)
    const cost = await s.dex.cost({ plan, account, moveWei: need.moveWei })
    expect(cost.transactions.map(t => t.kind)).toEqual(['consolidation', 'swap'])
    expect(cost.complete).toBe(true)

    const received = quote.amountOut - 5n
    s.receipts.set('0xhash1', receiptOf(swapLogs(amountIn, received)))
    const result = await s.dex.execute({
      plan,
      account,
      consolidateWei: need.moveWei,
      timing,
    })
    expect(s.wallet.fundMainAccount).toHaveBeenCalledWith({ value: need.moveWei })
    expect(result).toMatchObject({
      status: 'confirmed',
      txHash: '0xhash1',
      amountIn,
      amountOut: received,
    })
    const sent = s.wallet.sendContractCall.mock.calls[0]![0]
    expect(sent).toMatchObject({
      to: { raw: entry.swapRouter },
      data: plan.swap.data,
      value: amountIn,
      deadline: plan.deadline,
      record: {
        kind: 'swap',
        venueId: 'hyperswap-v2',
        account,
        // The record's assets carry symbol, address and decimals only (the journal's shape).
        assetIn: { symbol: 'tHYPE', address: null, decimals: 18 },
        assetOut: { symbol: 'PURR', address: PURR.address, decimals: 18 },
        amountIn: amountIn.toString(),
        quotedAmountOut: quote.amountOut.toString(),
        minimumAmountOut: plan.minimumAmountOut.toString(),
        interfaceFeeAmount: '0',
        route: quote.route,
      },
    })
    expect(Object.keys(sent.record!.assetIn).sort()).toEqual([
      'address',
      'decimals',
      'symbol',
    ])
    expect(s.wallet.resumeNativeOperation).toHaveBeenCalledWith('op-1')
  })

  it('refuses a plan whose call is not what its route encodes', async () => {
    const s = setup()
    const quote = await s.dex.quote({ tokenIn: THYPE, tokenOut: PURR, amountIn: 1000n })
    const plan = await s.dex.plan({ quote, slippageBps: 50, account })
    await expect(
      s.dex.execute({ plan: { ...plan, minimumAmountOut: 1n }, account, timing }),
    ).rejects.toThrow('Swap plan changed')
    await expect(
      s.dex.execute({
        plan: { ...plan, quote: { ...quote, route: { ...quote.route, pair: stranger } } },
        account,
        timing,
      }),
    ).rejects.toBeInstanceOf(SwapRecordMismatchError)
    expect(s.wallet.sendContractCall).not.toHaveBeenCalled()
  })
})

describe('observe and reconcile', () => {
  const route: HyperSwapV2Route = {
    kind: 'hyperswap-v2',
    pair: pair.address,
    path: [entry.wrappedNative, PURR.address!],
  }
  const call = (deadline: number) => ({
    to: entry.swapRouter,
    value: '1000',
    data: swapRouter.encodeFunctionData('multicall', [
      deadline,
      [
        swapRouter.encodeFunctionData('swapExactTokensForTokens', [
          1000n,
          1n,
          [...route.path],
          account,
        ]),
      ],
    ]),
  })

  it('reads what the receipt says, and disowns a transaction that is not this account’s swap', async () => {
    const s = setup()
    expect(
      await s.dex.observe({ transactionId: '0xnone', account, route }),
    ).toMatchObject({ status: 'pending' })
    s.receipts.set('0xmine', receiptOf(swapLogs(1000n, 1900n)))
    expect(
      await s.dex.observe({ transactionId: '0xmine', account, route }),
    ).toMatchObject({ status: 'confirmed', amountIn: 1000n, amountOut: 1900n })
    s.receipts.set('0xreverted', receiptOf([], 0))
    expect(
      await s.dex.observe({ transactionId: '0xreverted', account, route }),
    ).toMatchObject({ status: 'reverted', feeWei: 120_000n * 2n * 10n ** 8n })
    s.receipts.set('0xtheirs', receiptOf(swapLogs(1000n, 1900n), 1, stranger))
    await expect(
      s.dex.observe({ transactionId: '0xtheirs', account, route }),
    ).rejects.toBeInstanceOf(SwapRecordMismatchError)
    // A swap event whose token transfer does not match is not believed.
    const logs = swapLogs(1000n, 1900n)
    s.receipts.set(
      '0xshort',
      receiptOf([
        {
          address: PURR.address!,
          ...erc20.encodeEventLog('Transfer', [pair.address, account, 1n]),
        },
        logs[1]!,
      ]),
    )
    await expect(
      s.dex.observe({ transactionId: '0xshort', account, route }),
    ).rejects.toBeInstanceOf(SwapRecordMismatchError)
    await expect(
      s.dex.observe({
        transactionId: '0xmine',
        account,
        route: { ...route, pair: stranger },
      }),
    ).rejects.toBeInstanceOf(SwapRecordMismatchError)
  })

  it('re-sends the same recorded operation when the chain never saw it', async () => {
    const s = setup()
    s.wallet.resumeNativeOperation.mockImplementation(async () => {
      s.receipts.set('0xhash7', receiptOf(swapLogs(1000n, 1900n)))
    })
    const result = await s.dex.reconcile({
      transactionId: '0xhash7',
      operationId: 'op-7',
      account,
      route,
      call: call(NOW_MS / 1000 + 60),
      timing,
    })
    expect(s.wallet.resumeNativeOperation).toHaveBeenCalledWith('op-7')
    expect(s.wallet.cancelContractCall).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'confirmed', amountOut: 1900n })
  })

  it('cancels, not re-sends, a swap the chain is past the deadline of', async () => {
    const s = setup({ latestTimestamp: NOW_MS / 1000 + 600 })
    s.receipts.set('0xcancel', receiptOf([]))
    const result = await s.dex.reconcile({
      transactionId: '0xhash8',
      operationId: 'op-8',
      account,
      route,
      call: call(NOW_MS / 1000 + 60),
      timing,
    })
    expect(s.wallet.cancelContractCall).toHaveBeenCalledWith('op-8')
    expect(s.wallet.resumeNativeOperation).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'cancelled', cancelTxHash: '0xcancel' })
  })

  it('refuses a recorded call that is not a swap on this router', async () => {
    const s = setup()
    for (const bad of [
      { ...call(1), to: stranger },
      { ...call(1), to: entry.router },
      { ...call(1), data: '0x1234' },
    ])
      await expect(
        s.dex.reconcile({
          transactionId: '0xhash9',
          operationId: 'op-9',
          account,
          route,
          call: bad,
          timing,
        }),
      ).rejects.toBeInstanceOf(SwapRecordMismatchError)
  })
})
