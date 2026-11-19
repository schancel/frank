/**
 * Read-only check of the configured HyperSwap V2 deployment against the real Hyperliquid testnet.
 * It spends nothing and signs nothing: every call is `eth_call`, `eth_getCode` or a block read.
 * Run it after changing the `hyperliquid-testnet` entry in `chain/dex-entries.ts`:
 *
 *   set -a; source .env; set +a
 *   node --import tsx packages/wallet/swap/hyperswap-v2.livecheck.ts
 *
 * RPC: `SWAP_LIVECHECK_RPC_URL`, else `HYPERLIQUID_TESTNET_HTTP_RPC_URL`.
 *
 * It proves, for the chain's configured entry:
 *  1. the endpoint is chain 998 and holds the registry's checkpoint block;
 *  2. the router, factory, wrapped native coin, every pair and every token hold code;
 *  3. the adapter's own deployment check passes (router.factory(), router.WETH(),
 *     swapRouter.factoryV2(), swapRouter.WETH9(), each pair is the factory's pair of its
 *     tokens) and each token's decimals are as configured;
 *  4. for several amounts, the adapter's quote is the router's answer and is the Uniswap v2
 *     formula with a 0.3% fee on the pair's reserves; the call the adapter plans, simulated
 *     (`eth_call`) against SwapRouter02 with the quote as its floor, pays exactly the quote, and
 *     reverts when one more unit is demanded.
 */
import { Contract, Interface, JsonRpcProvider, formatUnits, parseUnits } from 'ethers'
import { getChainRegistryEntry } from '../chain/chains-registry'
import {
  getEvmDexDeployment,
  type HyperSwapV2Deployment,
} from '../chain/dex-deployments'
import type { EvmDexWallet } from './evm-dex'
import { HyperSwapV2Dex } from './hyperswap-v2'
import type { SwapExecutionReader } from './swap-execution'

const CHAIN = 'hyperliquid-testnet'

function ok(condition: unknown, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`)
  console.log(`  ok  ${label}`)
}

const refuse = () => {
  throw new Error('The live check never sends a transaction')
}

async function main(): Promise<void> {
  const url =
    process.env.SWAP_LIVECHECK_RPC_URL ??
    process.env.HYPERLIQUID_TESTNET_HTTP_RPC_URL
  if (!url) throw new Error('Set SWAP_LIVECHECK_RPC_URL or HYPERLIQUID_TESTNET_HTTP_RPC_URL')
  const registry = getChainRegistryEntry(CHAIN)!
  const entry = getEvmDexDeployment(CHAIN)
  if (entry?.adapter !== 'hyperswap-v2')
    throw new Error(`No HyperSwap V2 entry on ${CHAIN}`)
  const deployment: HyperSwapV2Deployment = entry
  const provider = new JsonRpcProvider(url, undefined, {
    batchMaxCount: 1,
    staticNetwork: true,
  })

  console.log('network')
  const { chainId } = await provider.getNetwork()
  ok(String(chainId) === String(registry.nativeChainId), `chain id is ${registry.nativeChainId}`)
  for (const probe of registry.identityProbes)
    if (probe.kind === 'block-hash')
      ok(
        (await provider.getBlock(probe.height))?.hash === probe.expected,
        `block ${probe.height} is the registry checkpoint`,
      )
  console.log(`  block ${await provider.getBlockNumber()}`)

  console.log('contracts')
  const addresses: [string, string][] = [
    ['router', deployment.router],
    ['swap router', deployment.swapRouter],
    ['factory', deployment.factory],
    ['wrapped native', deployment.wrappedNative],
    ...deployment.pairs.map((p): [string, string] => [`pair ${p.address}`, p.address]),
    ...deployment.tokens.flatMap((t): [string, string][] =>
      t.address ? [[`token ${t.symbol}`, t.address]] : [],
    ),
  ]
  for (const [name, address] of addresses)
    ok((await provider.getCode(address)).length > 2, `${name} has code`)
  for (const token of deployment.tokens) {
    if (token.address === null) continue
    const decimals = await new Contract(
      token.address,
      ['function decimals() view returns (uint8)'],
      provider,
    ).decimals()
    ok(Number(decimals) === token.decimals, `${token.symbol} has ${token.decimals} decimals`)
  }

  // Reads only: any send is refused before it reaches the wallet (there is no wallet here).
  const wallet: EvmDexWallet = {
    reader: provider as unknown as SwapExecutionReader,
    sendContractCall: refuse,
    getContractCallFunds: refuse,
  }
  const dex = new HyperSwapV2Dex(CHAIN, deployment, wallet)
  await dex.verifyDeployment()
  ok(true, 'both routers, the factory and every pair match the configuration')

  console.log('quotes')
  const swapRouterAbi = new Interface([
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to) payable returns (uint256 amountOut)',
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  ])
  const pairAbi = [
    'function getReserves() view returns (uint112, uint112, uint32)',
  ]
  const native = deployment.tokens.find(t => t.address === null)!
  // The simulated swaps are made as an address the node is told (state override) holds a
  // little of the native coin. Nothing is signed or sent.
  const caller = '0x000000000000000000000000000000000000dEaD'
  const overrides = { [caller]: { balance: '0xde0b6b3a7640000' } }
  for (const token of deployment.tokens) {
    if (token.address === null) continue
    const pair = deployment.pairs.find(
      p => p.token0 === token.address || p.token1 === token.address,
    )!
    const [r0, r1] = await new Contract(pair.address, pairAbi, provider).getReserves()
    const nativeIs0 = pair.token0 === deployment.wrappedNative
    const reserveIn = BigInt(nativeIs0 ? r0 : r1)
    const reserveOut = BigInt(nativeIs0 ? r1 : r0)
    ok(reserveIn > 0n && reserveOut > 0n, `${native.symbol}/${token.symbol} pair has reserves`)
    for (const amount of ['0.001', '0.01', '0.1']) {
      const amountIn = parseUnits(amount, native.decimals)
      const quote = await dex.quote({ tokenIn: native, tokenOut: token, amountIn })
      const inFee = amountIn * 997n
      const formula = (inFee * reserveOut) / (reserveIn * 1000n + inFee)
      ok(
        quote.amountOut === formula,
        `${amount} ${native.symbol} quotes ${formatUnits(quote.amountOut, token.decimals)} ${token.symbol} (v2 formula, 0.3% fee; impact ${quote.priceImpactPpm} ppm)`,
      )
      const plan = await dex.plan({ quote, slippageBps: 0, account: caller })
      const [deadline] = swapRouterAbi.decodeFunctionData('multicall', plan.swap.data)
      const dataFor = (floor: bigint) =>
        swapRouterAbi.encodeFunctionData('multicall', [
          deadline,
          [
            swapRouterAbi.encodeFunctionData('swapExactTokensForTokens', [
              amountIn,
              floor,
              [deployment.wrappedNative, token.address],
              caller,
            ]),
          ],
        ])
      ok(dataFor(plan.minimumAmountOut) === plan.swap.data, 'the planned call is that swap')
      const call = (floor: bigint) => {
        return provider.send('eth_call', [
          {
            from: caller,
            to: plan.swap.to,
            value: '0x' + plan.swap.value.toString(16),
            data: dataFor(floor),
          },
          'latest',
          overrides,
        ]) as Promise<string>
      }
      ok(plan.minimumAmountOut === quote.amountOut, 'a 0 bps plan floors at the quote')
      const [results] = swapRouterAbi.decodeFunctionResult(
        'multicall',
        await call(plan.minimumAmountOut),
      )
      const [paid] = swapRouterAbi.decodeFunctionResult(
        'swapExactTokensForTokens',
        results[0],
      )
      ok(BigInt(paid) === quote.amountOut, `simulated swap pays exactly the quote`)
      let reverted = false
      try {
        await call(quote.amountOut + 1n)
      } catch {
        reverted = true
      }
      ok(reverted, `simulated swap reverts when one more unit is demanded`)
    }
  }
  console.log('HyperSwap V2 live check passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
