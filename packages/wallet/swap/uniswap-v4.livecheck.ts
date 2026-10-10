/**
 * Read-only check of the configured swap deployment against the real network. It spends nothing
 * and signs nothing. Run it after changing `chain/dex-deployments.ts`:
 *
 *   set -a; source .env; set +a
 *   node --import tsx packages/wallet/swap/uniswap-v4.livecheck.ts [chainIdentifier] [fromAddress]
 *
 * RPC: `MONAD_TESTNET_HTTP_RPC_URL` (or `SWAP_LIVECHECK_RPC_URL`). `fromAddress` is any account
 * holding the native coin; it is only named as the caller of simulated (`eth_call`) swaps.
 *
 * It proves, for the chain's deployment:
 *  1. every contract address holds code and the StateView, Quoter and Universal Router all point
 *     at the configured PoolManager; Permit2 answers; each token's decimals match the chain;
 *  2. every configured pool is initialised and has liquidity;
 *  3. for several amounts, the quote this module returns is exactly what the pool pays: a
 *     simulated swap through the real router succeeds with the quote as its minimum output and
 *     reverts with "too little received" when one more unit is demanded.
 */
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import {
  estimateCallFee,
  fetchSwapQuote,
  swapRevertReasonOf,
} from './evm-swap'
import {
  encodeSwap,
  findToken,
  poolId,
  stateViewInterface,
} from './uniswap-v4'

function ok(condition: unknown, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`)
  console.log(`  ok  ${label}`)
}

async function main(): Promise<void> {
  const chainIdentifier = process.argv[2] ?? 'monad-testnet'
  const from = process.argv[3]
  const url =
    process.env.SWAP_LIVECHECK_RPC_URL ?? process.env.MONAD_TESTNET_HTTP_RPC_URL
  if (!url) throw new Error('Set MONAD_TESTNET_HTTP_RPC_URL')
  const deployment = getEvmDexDeployment(chainIdentifier)
  if (!deployment) throw new Error(`No swap deployment for ${chainIdentifier}`)
  const provider = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 })
  console.log(
    `chain ${(await provider.getNetwork()).chainId} block ${await provider.getBlockNumber()}`,
  )

  console.log('contracts')
  for (const name of [
    'poolManager',
    'quoter',
    'stateView',
    'universalRouter',
    'permit2',
  ] as const)
    ok((await provider.getCode(deployment[name])) !== '0x', `${name} has code`)
  const pointsAt = async (address: string) =>
    String(
      await new Contract(
        address,
        ['function poolManager() view returns (address)'],
        provider,
      ).poolManager(),
    ).toLowerCase()
  for (const name of ['quoter', 'stateView', 'universalRouter'] as const)
    ok(
      (await pointsAt(deployment[name])) ===
        deployment.poolManager.toLowerCase(),
      `${name}.poolManager() is the configured PoolManager`,
    )
  ok(
    /^0x[0-9a-f]{64}$/.test(
      await new Contract(
        deployment.permit2,
        ['function DOMAIN_SEPARATOR() view returns (bytes32)'],
        provider,
      ).DOMAIN_SEPARATOR(),
    ),
    'permit2 answers DOMAIN_SEPARATOR()',
  )
  for (const token of deployment.tokens) {
    if (token.address === null) continue
    const erc20 = new Contract(
      token.address,
      [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ],
      provider,
    )
    ok(
      Number(await erc20.decimals()) === token.decimals,
      `${token.symbol} decimals = ${token.decimals} (chain symbol ${await erc20.symbol()})`,
    )
  }

  console.log('pools')
  const stateView = new Contract(
    deployment.stateView,
    stateViewInterface,
    provider,
  )
  for (const key of deployment.pools) {
    const id = poolId(key)
    const slot0 = await stateView.getSlot0(id)
    const liquidity = await stateView.getLiquidity(id)
    ok(
      slot0.sqrtPriceX96 > 0n && liquidity > 0n,
      `pool ${id.slice(0, 10)} initialised, liquidity ${liquidity}, lpFee ${slot0.lpFee}`,
    )
    ok(Number(slot0.lpFee) === key.fee, 'pool fee matches its key')
  }

  console.log('quotes against the pool')
  const native = deployment.tokens.find(token => token.address === null)!
  for (const out of deployment.tokens.filter(token => token.address !== null)) {
    const target = findToken(deployment, out.symbol)!
    // Small on purpose: testnet pools are thin, and a pool that cannot fill an amount is a
    // truthful answer, not a broken deployment.
    for (const display of ['0.001', '0.02', '0.1']) {
      const amountIn = parseUnits(display, native.decimals)
      const quote = await fetchSwapQuote(provider, deployment, {
        tokenIn: native,
        tokenOut: target,
        amountIn,
      })
      console.log(
        `  ${display} ${native.symbol} -> ${formatUnits(
          quote.amountOut,
          target.decimals,
        )} ${target.symbol}  (mid ${formatUnits(
          quote.midPriceAmountOut,
          target.decimals,
        )}, fee ${quote.lpFeePpm / 10_000}%, impact ${
          quote.priceImpactPpm / 10_000
        }%)`,
      )
      if (!from) continue
      const deadline = Math.floor(Date.now() / 1000) + 600
      const exact = encodeSwap({
        deployment,
        route: quote.route,
        amountIn,
        minimumAmountOut: quote.amountOut,
        deadline,
      })
      const fee = await estimateCallFee(provider, exact, from)
      ok(
        fee.gasLimit > 0n,
        `simulated swap pays at least the quote (gas limit ${fee.gasLimit})`,
      )
      const greedy = encodeSwap({
        deployment,
        route: quote.route,
        amountIn,
        minimumAmountOut: quote.amountOut + 1n,
        deadline,
      })
      let reason: string | undefined
      try {
        await provider.call({ ...greedy, from })
      } catch (error) {
        reason = swapRevertReasonOf(error)
      }
      ok(
        reason === 'slippage',
        'simulated swap pays no more than the quote (one unit more reverts as too little received)',
      )
    }
  }
  if (!from)
    console.log('  (no fromAddress given: swaps were not simulated, only quoted)')
  console.log('live check passed')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
