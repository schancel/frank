import { getAddress } from 'ethers'
import {
  assertInterfaceFee,
  getEvmDexDeployment,
  listEvmDexDeploymentChains,
  listEvmSwapVenues,
  MAX_INTERFACE_FEE_BPS,
  MONAD_TESTNET_DEX,
  NATIVE_CURRENCY,
} from '../chain/dex-deployments'
import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import {
  fetchSwapQuote,
  planSwap,
  quoteIsFresh,
  QUOTE_MAX_AGE_MS,
  readTokenBalances,
  SwapNoLiquidityError,
  SwapNoRouteError,
  swapRevertReasonOf,
  estimateCallFee,
} from './evm-swap'
import {
  approvalSteps,
  classifySwapRevert,
  encodeSwap,
  findToken,
  interfaceFeeAmount,
  minimumOutput,
  outputAtMidPrice,
  PERMIT2_ALLOWANCE_SECONDS,
  permit2Interface,
  poolId,
  priceImpactPpm,
  readSwapOutcome,
  routesFor,
  universalRouterInterface,
} from './uniswap-v4'
import {
  callRevert,
  cannedNode,
  tooLittleReceived,
} from './swap-reader.testutil'
import vectors from './monad-testnet-swap-vectors.json'

const deployment = getEvmDexDeployment('monad-testnet')!
const MON = findToken(deployment, 'MON')!
const USDC = findToken(deployment, 'usdc')!
const CHOMP = findToken(deployment, 'CHOMP')!
const monUsdc = routesFor(deployment, MON, USDC)[0]!
const usdcMon = routesFor(deployment, USDC, MON)[0]!
const account = vectors.account

describe('swap deployments', () => {
  it('are keyed by canonical EVM testnet identifiers and name no default', () => {
    expect(listEvmDexDeploymentChains()).toEqual(['monad-testnet'])
    for (const id of listEvmDexDeploymentChains()) {
      expect(PROTOCOL_CHAINS[id]).toMatchObject({
        family: 'evm',
        network: 'testnet',
      })
    }
    for (const unknown of ['monad', 'evm', 'monad-mainnet', 'toString', ''])
      expect(getEvmDexDeployment(unknown)).toBeUndefined()
  })

  it('lists checksummed addresses, sorted hookless pools, and no AVU', () => {
    for (const address of [
      deployment.poolManager,
      deployment.quoter,
      deployment.stateView,
      deployment.universalRouter,
      deployment.permit2,
    ])
      expect(getAddress(address)).toBe(address)
    for (const pool of deployment.pools) {
      expect(BigInt(pool.currency0) < BigInt(pool.currency1)).toBe(true)
      expect(pool.hooks).toBe(NATIVE_CURRENCY)
    }
    expect(deployment.tokens.map(token => token.symbol)).toEqual([
      'MON',
      'USDC',
      'CHOMP',
    ])
    expect(findToken(deployment, 'AVU')).toBeUndefined()
    expect(deployment.officialUniswapDeployment).toBe(false)
  })
})

describe('routes', () => {
  it('finds the pool in either direction and nothing for a pair with no pool', () => {
    expect(monUsdc.zeroForOne).toBe(true)
    expect(usdcMon.zeroForOne).toBe(false)
    expect(usdcMon.key).toBe(monUsdc.key)
    expect(routesFor(deployment, USDC, CHOMP)).toEqual([])
    expect(routesFor(deployment, MON, MON)).toEqual([])
  })
})

describe('calldata, against transactions the real router executed', () => {
  it('encodes a native-in swap byte for byte', () => {
    const call = encodeSwap({
      deployment,
      route: monUsdc,
      amountIn: 20_000_000_000_000_000n,
      minimumAmountOut: 19_796n,
      deadline: 1791613292,
    })
    expect(call.data).toBe(vectors.swapNativeIn.data)
    expect(call.to).toBe(vectors.swapNativeIn.to)
    expect(call.value.toString()).toBe(vectors.swapNativeIn.value)
  })

  it('encodes a token-in swap byte for byte, with no value', () => {
    const call = encodeSwap({
      deployment,
      route: usdcMon,
      amountIn: 15_000n,
      minimumAmountOut: 14_838_215_892_013_766n,
      deadline: 1791613302,
    })
    expect(call.data).toBe(vectors.swapTokenIn.data)
    expect(call.value).toBe(0n)
  })

  it('encodes both approvals byte for byte, each for the exact amount', () => {
    const [, , , expiration] = permit2Interface.decodeFunctionData(
      'approve',
      vectors.approvePermit2.data,
    )
    const steps = approvalSteps({
      deployment,
      tokenIn: USDC,
      amountIn: 15_000n,
      allowance: {
        tokenToPermit2: 0n,
        permit2ToRouter: { amount: 0n, expiration: 0 },
      },
      now: Number(expiration) - PERMIT2_ALLOWANCE_SECONDS,
    })
    expect(steps.map(step => step.kind)).toEqual([
      'token-approve-permit2',
      'permit2-approve-router',
    ])
    expect(steps[0]!.call).toEqual({
      to: vectors.approveToken.to,
      data: vectors.approveToken.data,
      value: 0n,
    })
    expect(steps[1]!.call).toEqual({
      to: vectors.approvePermit2.to,
      data: vectors.approvePermit2.data,
      value: 0n,
    })
  })

  it('refuses a zero amount, a zero minimum and a bad deadline', () => {
    const base = {
      deployment,
      route: monUsdc,
      amountIn: 1n,
      minimumAmountOut: 1n,
      deadline: 1,
    }
    expect(() => encodeSwap({ ...base, amountIn: 0n })).toThrow(RangeError)
    expect(() => encodeSwap({ ...base, minimumAmountOut: 0n })).toThrow(
      RangeError,
    )
    expect(() => encodeSwap({ ...base, deadline: 0 })).toThrow(RangeError)
  })
})

describe('what a confirmed swap delivered, from its receipt', () => {
  it('reads a token output from the real receipt logs', () => {
    expect(
      readSwapOutcome({
        deployment,
        route: monUsdc,
        account,
        logs: vectors.swapNativeIn.logs,
      }),
    ).toEqual({ amountIn: 20_000_000_000_000_000n, amountOut: 19_996n })
  })

  it('reads a native output from the real receipt logs', () => {
    expect(
      readSwapOutcome({
        deployment,
        route: usdcMon,
        account,
        logs: vectors.swapTokenIn.logs,
      }),
    ).toEqual({ amountIn: 15_000n, amountOut: 14_988_096_860_619_966n })
  })

  it('reports nothing when the receipt is not this pool’s swap', () => {
    expect(
      readSwapOutcome({
        deployment,
        route: routesFor(deployment, MON, CHOMP)[0]!,
        account,
        logs: vectors.swapNativeIn.logs,
      }),
    ).toBeUndefined()
    expect(
      readSwapOutcome({
        deployment,
        route: monUsdc,
        account,
        logs: vectors.approveToken.logs,
      }),
    ).toBeUndefined()
  })
})

describe('slippage and minimum received', () => {
  it('rounds the minimum down and never to zero', () => {
    expect(minimumOutput(19_996n, 100)).toBe(19_796n)
    expect(minimumOutput(19_996n, 0)).toBe(19_996n)
    expect(minimumOutput(10_000n, 50)).toBe(9_950n)
    expect(minimumOutput(1n, 5000)).toBe(1n)
  })

  it('refuses slippage outside 0% to 50% and fractional basis points', () => {
    for (const bad of [-1, 5001, 0.5, Number.NaN])
      expect(() => minimumOutput(1_000n, bad)).toThrow(RangeError)
    expect(() => minimumOutput(0n, 50)).toThrow(RangeError)
  })
})

describe('price impact against the pool mid price', () => {
  // sqrtPriceX96 for a price of exactly 4 currency1 per currency0.
  const sqrtPriceX96 = 2n * 2n ** 96n

  it('prices both directions from sqrtPriceX96', () => {
    expect(outputAtMidPrice(1_000n, sqrtPriceX96, true)).toBe(4_000n)
    expect(outputAtMidPrice(4_000n, sqrtPriceX96, false)).toBe(1_000n)
  })

  it('does not count the pool fee as impact', () => {
    // 0.3% fee: 1,000,000 in, 997,000 after fee, 3,988,000 at mid price.
    expect(
      priceImpactPpm({
        amountIn: 1_000_000n,
        amountOut: 3_988_000n,
        sqrtPriceX96,
        zeroForOne: true,
        lpFeePpm: 3000,
      }),
    ).toBe(0)
  })

  it('reports the shortfall in parts per million and never a negative', () => {
    expect(
      priceImpactPpm({
        amountIn: 1_000_000n,
        amountOut: 3_948_120n,
        sqrtPriceX96,
        zeroForOne: true,
        lpFeePpm: 3000,
      }),
    ).toBe(10_000)
    expect(
      priceImpactPpm({
        amountIn: 1_000_000n,
        amountOut: 4_100_000n,
        sqrtPriceX96,
        zeroForOne: true,
        lpFeePpm: 3000,
      }),
    ).toBe(0)
  })
})

describe('allowance', () => {
  const now = 1_800_000_000
  const steps = (
    tokenToPermit2: bigint,
    amount: bigint,
    expiration: number,
    amountIn = 15_000n,
  ) =>
    approvalSteps({
      deployment,
      tokenIn: USDC,
      amountIn,
      allowance: { tokenToPermit2, permit2ToRouter: { amount, expiration } },
      now,
    }).map(step => step.kind)

  it('asks nothing for the native coin', () => {
    expect(
      approvalSteps({
        deployment,
        tokenIn: MON,
        amountIn: 1n,
        allowance: {
          tokenToPermit2: 0n,
          permit2ToRouter: { amount: 0n, expiration: 0 },
        },
        now,
      }),
    ).toEqual([])
  })

  it('asks only for what is missing', () => {
    expect(steps(15_000n, 15_000n, now + 600)).toEqual([])
    expect(steps(14_999n, 15_000n, now + 600)).toEqual([
      'token-approve-permit2',
    ])
    expect(steps(15_000n, 14_999n, now + 600)).toEqual([
      'permit2-approve-router',
    ])
  })

  it('treats a lapsed or about-to-lapse Permit2 allowance as none', () => {
    expect(steps(15_000n, 15_000n, now - 1)).toEqual(['permit2-approve-router'])
    expect(steps(15_000n, 15_000n, now + 30)).toEqual([
      'permit2-approve-router',
    ])
  })

  it('never approves more than the amount being swapped', () => {
    const [token, permit2] = approvalSteps({
      deployment,
      tokenIn: USDC,
      amountIn: 777n,
      allowance: {
        tokenToPermit2: 0n,
        permit2ToRouter: { amount: 0n, expiration: 0 },
      },
      now,
    })
    expect(BigInt('0x' + token!.call.data.slice(-64))).toBe(777n)
    const decoded = permit2Interface.decodeFunctionData(
      'approve',
      permit2!.call.data,
    )
    expect(decoded[2]).toBe(777n)
    expect(Number(decoded[3])).toBe(now + PERMIT2_ALLOWANCE_SECONDS)
  })
})

describe('reverts in plain terms', () => {
  it('names slippage, deadline and allowance, including inside ExecutionFailed', () => {
    const slippage = tooLittleReceived(10n, 9n)
    expect(classifySwapRevert(slippage)).toBe('slippage')
    expect(
      classifySwapRevert(
        universalRouterInterface.encodeErrorResult('ExecutionFailed', [
          0,
          slippage,
        ]),
      ),
    ).toBe('slippage')
    expect(
      classifySwapRevert(
        universalRouterInterface.encodeErrorResult(
          'TransactionDeadlinePassed',
          [],
        ),
      ),
    ).toBe('deadline')
    expect(
      classifySwapRevert(
        permit2Interface.encodeErrorResult('InsufficientAllowance', [0]),
      ),
    ).toBe('allowance')
    expect(classifySwapRevert('0xdeadbeef')).toBeUndefined()
    expect(classifySwapRevert(undefined)).toBeUndefined()
  })

  it('finds revert data nested in a provider error', () => {
    expect(
      swapRevertReasonOf({
        code: 'CALL_EXCEPTION',
        info: { error: { data: tooLittleReceived(2n, 1n) } },
      }),
    ).toBe('slippage')
    expect(swapRevertReasonOf(new Error('timeout'))).toBeUndefined()
  })
})

describe('quote, at the node seam', () => {
  const pool = {
    sqrtPriceX96: 2n * 2n ** 96n,
    liquidity: 10n ** 18n,
    lpFee: 500,
    quote: (amountIn: bigint) => amountIn * 3n,
  }
  const withPool = () => {
    const canned = cannedNode(deployment)
    canned.node.pools.set(poolId(monUsdc.key).toLowerCase(), pool)
    return canned
  }

  it('returns the quoter’s answer, the pool’s fee and impact, and when it was read', async () => {
    const { reader } = withPool()
    const quote = await fetchSwapQuote(
      reader,
      deployment,
      { tokenIn: MON, tokenOut: USDC, amountIn: 1_000_000n },
      () => 5_000,
    )
    expect(quote.amountOut).toBe(3_000_000n)
    expect(quote.lpFeePpm).toBe(500)
    expect(quote.midPriceAmountOut).toBe(4_000_000n)
    // 999,500 after fee buys 3,998,000 at mid price; the quoter gave 3,000,000.
    expect(quote.priceImpactPpm).toBe(249_624)
    expect(quote.quotedAtMs).toBe(5_000)
    expect(quoteIsFresh(quote, 5_000 + QUOTE_MAX_AGE_MS - 1)).toBe(true)
    expect(quoteIsFresh(quote, 5_000 + QUOTE_MAX_AGE_MS)).toBe(false)
  })

  it('says no route when no pool trades the pair, without asking the node', async () => {
    const { reader, node } = withPool()
    await expect(
      fetchSwapQuote(reader, deployment, {
        tokenIn: USDC,
        tokenOut: CHOMP,
        amountIn: 1n,
      }),
    ).rejects.toBeInstanceOf(SwapNoRouteError)
    expect(node.calls).toEqual([])
  })

  it('says no liquidity when the pool is empty or the quoter reverts', async () => {
    const empty = cannedNode(deployment)
    await expect(
      fetchSwapQuote(empty.reader, deployment, {
        tokenIn: MON,
        tokenOut: USDC,
        amountIn: 1n,
      }),
    ).rejects.toBeInstanceOf(SwapNoLiquidityError)
    const reverting = cannedNode(deployment)
    reverting.node.pools.set(poolId(monUsdc.key).toLowerCase(), {
      ...pool,
      quote: () => {
        throw callRevert()
      },
    })
    await expect(
      fetchSwapQuote(reverting.reader, deployment, {
        tokenIn: MON,
        tokenOut: USDC,
        amountIn: 1n,
      }),
    ).rejects.toBeInstanceOf(SwapNoLiquidityError)
  })

  it('does not call an unreachable node "no liquidity"', async () => {
    const { reader } = withPool()
    const down = new Error('socket hang up')
    await expect(
      fetchSwapQuote(
        { ...reader, call: () => Promise.reject(down) },
        deployment,
        { tokenIn: MON, tokenOut: USDC, amountIn: 1n },
      ),
    ).rejects.toBe(down)
  })

  it('plans a native swap with no approvals and a token swap with exact ones', async () => {
    const { reader, node } = withPool()
    const native = await fetchSwapQuote(reader, deployment, {
      tokenIn: MON,
      tokenOut: USDC,
      amountIn: 1_000n,
    })
    const nativePlan = await planSwap(
      reader,
      deployment,
      { quote: native, slippageBps: 100, account },
      () => 1_700_000_000_000,
    )
    expect(nativePlan.approvals).toEqual([])
    expect(nativePlan.minimumAmountOut).toBe(2_970n)
    expect(nativePlan.deadline).toBe(1_700_000_120)
    expect(nativePlan.swap.value).toBe(1_000n)

    const token = await fetchSwapQuote(reader, deployment, {
      tokenIn: USDC,
      tokenOut: MON,
      amountIn: 1_000n,
    })
    const tokenPlan = await planSwap(reader, deployment, {
      quote: token,
      slippageBps: 100,
      account,
    })
    expect(tokenPlan.approvals).toHaveLength(2)
    expect(tokenPlan.swap.value).toBe(0n)
    node.tokenAllowance = 1_000n
    node.permit2Allowance = {
      amount: 1_000n,
      expiration: Math.floor(Date.now() / 1000) + 600,
    }
    expect(
      (
        await planSwap(reader, deployment, {
          quote: token,
          slippageBps: 100,
          account,
        })
      ).approvals,
    ).toEqual([])
  })

  it('reads balances in the deployment’s token order', async () => {
    const { reader, node } = withPool()
    node.nativeBalance = 7n
    node.tokenBalance.set(USDC.address!.toLowerCase(), 9n)
    expect(await readTokenBalances(reader, deployment, account)).toEqual([
      7n,
      9n,
      0n,
    ])
  })

  it('prices the network fee from the node’s gas estimate and fee cap', async () => {
    const { reader, node } = withPool()
    node.gasEstimate = 200_000n
    node.maxFeePerGas = 5n
    // Charged: the whole limit, at the base fee plus the tip, not at the cap.
    node.baseFeePerGas = 2n
    node.maxPriorityFeePerGas = 1n
    expect(
      await estimateCallFee(
        reader,
        { to: deployment.universalRouter, data: '0x00', value: 0n },
        account,
      ),
    ).toEqual({
      gasLimit: 230_000n,
      maxFeePerGas: 5n,
      maximumFeeWei: 1_150_000n,
      chargedFeeWei: 690_000n,
    })
  })
})

describe('venues', () => {
  it('lists a chain’s venues in order, and nothing for a chain without one', () => {
    expect(
      listEvmSwapVenues('monad-testnet').map(venue => ({
        id: venue.id,
        adapter: venue.adapter,
        enabled: venue.enabled,
        displayName: venue.displayName,
        maintainer: venue.maintainer,
      })),
    ).toEqual([
      {
        id: 'uniswap-v4',
        adapter: 'uniswap-v4',
        enabled: true,
        displayName: 'Uniswap v4',
        maintainer: 'Monad',
      },
    ])
    for (const none of ['monad-mainnet', 'solana-devnet', 'constructor'])
      expect(listEvmSwapVenues(none)).toEqual([])
  })

  it('finds a venue by id, the first by default, and never another in place of a missing one', () => {
    expect(getEvmDexDeployment('monad-testnet', 'uniswap-v4')).toBe(deployment)
    expect(getEvmDexDeployment('monad-testnet')).toBe(deployment)
    expect(getEvmDexDeployment('monad-testnet', 'orca')).toBeUndefined()
  })

  it('is the dex list of the network’s registry row, and of no other row', () => {
    expect(PROTOCOL_CHAINS['monad-testnet']!.dex).toEqual(MONAD_TESTNET_DEX)
    for (const [id, entry] of Object.entries(PROTOCOL_CHAINS))
      if (id !== 'monad-testnet') expect(entry.dex).toBeUndefined()
  })

  it('does not offer a disabled entry: nothing else decides whether a network has a swap', () => {
    jest.isolateModules(() => {
      jest.doMock('../chain/dex-entries', () => {
        const actual = jest.requireActual('../chain/dex-entries')
        return {
          ...actual,
          MONAD_TESTNET_DEX: [
            { ...actual.MONAD_TESTNET_DEX[0], enabled: false },
          ],
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const config = require('../chain/dex-deployments')
      expect(config.listEvmSwapVenues('monad-testnet')).toEqual([])
      expect(config.getEvmDexDeployment('monad-testnet')).toBeUndefined()
      expect(config.listEvmDexDeploymentChains()).toEqual([])
    })
    jest.dontMock('../chain/dex-entries')
  })

  it('charges no interface fee anywhere today', () => {
    for (const chain of listEvmDexDeploymentChains())
      for (const venue of listEvmSwapVenues(chain))
        expect(venue.interfaceFee).toBeUndefined()
  })
})

describe('interface fee', () => {
  const fee = vectors.swapNativeInWithFee
  const withFee = {
    ...deployment,
    interfaceFee: { bps: fee.feeBps, recipient: fee.feeRecipient },
  }

  it('refuses a rate that is not 1 to 100 whole basis points, or a missing recipient', () => {
    const recipient = fee.feeRecipient
    expect(MAX_INTERFACE_FEE_BPS).toBe(100)
    for (const bps of [0, -1, 101, 8.75, Number.NaN])
      expect(() => assertInterfaceFee({ bps, recipient })).toThrow(RangeError)
    for (const bad of ['', '0x1234', NATIVE_CURRENCY])
      expect(() => assertInterfaceFee({ bps: 25, recipient: bad })).toThrow(
        RangeError,
      )
    expect(() => assertInterfaceFee({ bps: 100, recipient })).not.toThrow()
    expect(() =>
      encodeSwap({
        deployment: { ...deployment, interfaceFee: { bps: 500, recipient } },
        route: monUsdc,
        amountIn: 1n,
        minimumAmountOut: 1n,
        deadline: 1,
      }),
    ).toThrow(RangeError)
  })

  it('encodes the fee as its own action, byte for byte as the real router executed it', () => {
    const call = encodeSwap({
      deployment: withFee,
      route: monUsdc,
      amountIn: 10_000_000_000_000_000n,
      minimumAmountOut: 9_899n,
      deadline: 1791616424,
    })
    expect(call.data).toBe(fee.data)
    expect(call.value.toString()).toBe(fee.value)
  })

  it('encodes nothing about a fee when the venue has none', () => {
    const plain = encodeSwap({
      deployment,
      route: monUsdc,
      amountIn: 10_000_000_000_000_000n,
      minimumAmountOut: 9_899n,
      deadline: 1791616424,
    })
    expect(plain.data).not.toBe(fee.data)
    expect(plain.data).not.toContain(fee.feeRecipient.slice(2).toLowerCase())
    // swap, settle, take: three actions, no fourth.
    expect(plain.data).toContain('3060c0f'.padEnd(64, '0'))
    expect(fee.data).toContain('4060c100f'.padEnd(64, '0'))
  })

  it('rounds the fee down, as the router does', () => {
    expect(interfaceFeeAmount(9_998n, 50)).toBe(49n)
    expect(interfaceFeeAmount(199n, 50)).toBe(0n)
    expect(interfaceFeeAmount(10_000n, 100)).toBe(100n)
  })

  it('reads what the account received from the real receipt: the pool’s output less the fee', () => {
    // The pool paid 9,998; 49 went to the fee recipient; the account received 9,949.
    expect(
      readSwapOutcome({
        deployment: withFee,
        route: monUsdc,
        account,
        logs: fee.logs,
      }),
    ).toEqual({ amountIn: 10_000_000_000_000_000n, amountOut: 9_949n })
  })

  it('takes the fee off a native output too, where no transfer log exists', () => {
    expect(
      readSwapOutcome({
        deployment: {
          ...withFee,
          interfaceFee: { ...withFee.interfaceFee, bps: 100 },
        },
        route: usdcMon,
        account,
        logs: vectors.swapTokenIn.logs,
      }),
    ).toEqual({
      amountIn: 15_000n,
      amountOut: 14_988_096_860_619_966n - 149_880_968_606_199n,
    })
  })

  it('shows the fee in the quote, separate from the pool fee, and floors the minimum on the net', async () => {
    const canned = cannedNode(withFee)
    canned.node.pools.set(poolId(monUsdc.key).toLowerCase(), {
      sqrtPriceX96: 2n ** 96n,
      liquidity: 10n ** 18n,
      lpFee: 500,
      quote: () => 10_000n,
    })
    const quote = await fetchSwapQuote(canned.reader, withFee, {
      tokenIn: MON,
      tokenOut: USDC,
      amountIn: 10_000n,
    })
    expect(quote).toMatchObject({
      poolAmountOut: 10_000n,
      interfaceFee: { bps: 50, amount: 50n },
      amountOut: 9_950n,
      lpFeePpm: 500,
    })
    const plan = await planSwap(canned.reader, withFee, {
      quote,
      slippageBps: 100,
      account,
    })
    expect(plan.minimumAmountOut).toBe(9_850n)

    const none = await fetchSwapQuote(canned.reader, deployment, {
      tokenIn: MON,
      tokenOut: USDC,
      amountIn: 10_000n,
    })
    expect(none.interfaceFee).toBeUndefined()
    expect(none.amountOut).toBe(none.poolAmountOut)
  })
})
