/**
 * `signet swap quote` and `signet swap build` print what the chain answered and nothing else.
 * The node is stubbed at the JSON-RPC seam here; the same quote path against the real network is
 * `packages/wallet/swap/uniswap-v4.livecheck.ts`.
 */
import { getEvmDexDeployment } from '@frank/wallet/chain/dex-deployments'
import { cannedNode, callRevert } from '@frank/wallet/swap/swap-reader.testutil'
import {
  findToken,
  poolId,
  routesFor,
  universalRouterInterface,
} from '@frank/wallet/swap/uniswap-v4'

import { createProgram } from '../src/cli'
import {
  swapBuildCommand,
  swapNetwork,
  swapQuoteCommand,
} from '../src/commands/swap'

const deployment = getEvmDexDeployment('monad-testnet')!
const MON = findToken(deployment, 'MON')!
const USDC = findToken(deployment, 'USDC')!
const account = '0xEF98E274fFD1Ac3b86ed0C1353e53522e7d00F98'

describe('signet swap', () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance
  let canned: ReturnType<typeof cannedNode>
  const printed = () =>
    logSpy.mock.calls.map(call => String(call[0])).join('\n')
  const json = () => JSON.parse(String(logSpy.mock.calls[0]![0]))

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    canned = cannedNode(deployment)
    // 1 MON = 1.0005 USDC at mid price; the quoter answers 0.019996 USDC for 0.02 MON.
    canned.node.pools.set(
      poolId(routesFor(deployment, MON, USDC)[0]!.key).toLowerCase(),
      {
        sqrtPriceX96: 79248805082736432488342n,
        liquidity: 95902508421861n,
        lpFee: 500,
        quote: (amountIn, zeroForOne) =>
          (zeroForOne ? amountIn / 10n ** 12n : amountIn * 10n ** 12n) - 4n,
      },
    )
    jest.spyOn(swapNetwork, 'open').mockImplementation(async options => {
      if (options.chain && options.chain !== 'monad-testnet')
        throw new Error(`No swap is available on ${options.chain}`)
      return {
        chainIdentifier: 'monad-testnet',
        deployment,
        reader: canned.reader,
      }
    })
  })
  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = 0
  })

  it('prints the quoter’s answer, the pool fee and the impact against the pool price', async () => {
    await swapQuoteCommand('mon', 'usdc', '0.02', { json: true })
    expect(json()).toEqual({
      chain: 'monad-testnet',
      exchange: 'Uniswap v4',
      venue: 'uniswap-v4',
      officialUniswapDeployment: false,
      maintainer: 'Monad',
      from: 'MON',
      to: 'USDC',
      amountIn: '0.02',
      amountOut: '0.019996',
      minimumAmountOut: '0.019896',
      slippageBps: 50,
      poolFee: '0.0500%',
      priceImpact: '0.0200%',
      interfaceFee: 'none',
    })
  })

  it('says in words that there is no interface fee and who maintains the deployment', async () => {
    await swapQuoteCommand('MON', 'USDC', '0.02', { slippage: '100' })
    const text = printed()
    expect(text).toContain('Receive:          0.019996 USDC')
    expect(text).toContain('Minimum received: 0.019796 USDC (slippage 1%)')
    expect(text).toContain('Interface fee:    none')
    expect(text).toContain('maintained by Monad')
    expect(text).not.toMatch(/8\.75|bps partner/i)
  })

  it('prints no quote when the pool cannot fill the amount', async () => {
    canned.node.pools.forEach(pool => {
      pool.quote = () => {
        throw callRevert()
      }
    })
    await swapQuoteCommand('MON', 'USDC', '5', {})
    expect(logSpy).not.toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0]![0])).toContain(
      'The pool cannot fill this amount',
    )
  })

  it('prints no quote when the node cannot be reached', async () => {
    canned.reader.call = () => Promise.reject(new Error('connect ECONNREFUSED'))
    await swapQuoteCommand('MON', 'USDC', '0.02', {})
    expect(logSpy).not.toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0]![0])).toContain('ECONNREFUSED')
  })

  it('refuses AVU and any other asset the deployment does not trade', async () => {
    for (const asset of ['AVU', 'USDT', 'ETH']) {
      logSpy.mockClear()
      errorSpy.mockClear()
      await swapQuoteCommand('MON', asset, '1', {})
      expect(logSpy).not.toHaveBeenCalled()
      expect(String(errorSpy.mock.calls[0]![0])).toContain(
        'monad-testnet swaps: MON, USDC, CHOMP',
      )
    }
  })

  it('refuses a chain with no swap deployment instead of picking a default', async () => {
    await swapQuoteCommand('SOL', 'USDC', '1', { chain: 'solana-devnet' })
    expect(logSpy).not.toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0]![0])).toContain(
      'No swap is available on solana-devnet',
    )
  })

  it('builds the unsigned native swap with the node’s gas estimate and a short deadline', async () => {
    const before = Math.floor(Date.now() / 1000)
    await swapBuildCommand('MON', 'USDC', '0.02', { account, json: true })
    const built = json()
    expect(built.approvals).toEqual([])
    expect(built.swap.to).toBe(deployment.universalRouter)
    expect(built.swap.value).toBe('20000000000000000')
    expect(built.gasLimit).toBe('230000')
    expect(built.deadline).toBeGreaterThanOrEqual(before + 120)
    expect(built.deadline).toBeLessThanOrEqual(before + 125)
    const [, , deadline] = universalRouterInterface.decodeFunctionData(
      'execute',
      built.swap.data,
    )
    expect(Number(deadline)).toBe(built.deadline)
  })

  it('lists exact-amount approvals for a token swap and does not guess its gas', async () => {
    await swapBuildCommand('USDC', 'MON', '0.015', { account, json: true })
    const built = json()
    expect(built.approvals.map((step: { kind: string }) => step.kind)).toEqual([
      'token-approve-permit2',
      'permit2-approve-router',
    ])
    expect(built.swap.value).toBe('0')
    expect(built.gasLimit).toBeNull()
  })

  it('dispatches quote and build from the program, and no longer lists plugins', async () => {
    const program = createProgram()
    program.exitOverride()
    await program.parseAsync([
      'node',
      'signet',
      'swap',
      'quote',
      'MON',
      'USDC',
      '0.02',
    ])
    expect(printed()).toContain('Receive:          0.019996 USDC')
    logSpy.mockClear()
    await program.parseAsync([
      'node',
      'signet',
      'swap',
      'build',
      'MON',
      'USDC',
      '0.02',
      '--account',
      account,
    ])
    expect(printed()).toContain(`Unsigned swap for ${account}`)
    const swap = program.commands.find(command => command.name() === 'swap')!
    expect(swap.commands.map(command => command.name()).sort()).toEqual([
      'build',
      'quote',
    ])
  })
})
