/**
 * `signet swap quote` and `signet swap build`.
 *
 * Both ask the chain. The quote is the swap deployment's quoter contract answering for the exact
 * amount, the gas figure is `eth_estimateGas` on the built transaction, and nothing is printed
 * when the node cannot be reached. Neither command signs or sends anything; the app's swap view
 * executes swaps through the wallet. There is no interface fee.
 */

import { JsonRpcProvider, formatUnits, getAddress, parseUnits } from 'ethers'
import {
  getEvmDexDeployment,
  listEvmDexDeploymentChains,
  type UniswapV4Deployment,
} from '@frank/wallet/chain/dex-deployments'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import {
  estimateCallFee,
  fetchSwapQuote,
  planSwap,
  type SwapChainReader,
} from '@frank/wallet/swap/evm-swap'
import { findToken, minimumOutput } from '@frank/wallet/swap/uniswap-v4'

import { outputError, outputResult } from '../util'

export interface SwapQuoteOptions {
  chain?: string
  rpcUrl?: string
  slippage?: string | number
  /** `build` only: the account that would send the swap. */
  account?: string
  json?: boolean
}

const DEFAULT_CHAIN = 'monad-testnet'
const DEFAULT_SLIPPAGE_BPS = 50

interface SwapTarget {
  chainIdentifier: string
  deployment: UniswapV4Deployment
  reader: SwapChainReader
}

/** Tests replace this to answer the node calls; production always builds a JSON-RPC provider. */
export const swapNetwork = {
  async open(options: SwapQuoteOptions): Promise<SwapTarget> {
    const chainIdentifier = options.chain ?? DEFAULT_CHAIN
    const entry = PROTOCOL_CHAINS[chainIdentifier]
    const deployment = getEvmDexDeployment(chainIdentifier)
    if (!entry || !deployment)
      throw new Error(
        `No swap is available on ${chainIdentifier}. Available: ${listEvmDexDeploymentChains().join(
          ', ',
        )}`,
      )
    const url =
      options.rpcUrl ??
      (chainIdentifier === 'monad-testnet'
        ? process.env.MONAD_TESTNET_HTTP_RPC_URL
        : undefined)
    if (!url)
      throw new Error(
        'A swap quote is read from the chain: pass --rpc-url (or set MONAD_TESTNET_HTTP_RPC_URL)',
      )
    const provider = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 })
    const { chainId } = await provider.getNetwork()
    if (chainId.toString() !== String(entry.nativeChainId))
      throw new Error(
        `The RPC endpoint is chain ${chainId}, not ${chainIdentifier}`,
      )
    return { chainIdentifier, deployment, reader: provider }
  },
}

function slippageOf(options: SwapQuoteOptions): number {
  const bps =
    options.slippage === undefined
      ? DEFAULT_SLIPPAGE_BPS
      : Number(options.slippage)
  if (!Number.isInteger(bps)) throw new Error('--slippage is whole basis points')
  return bps
}

async function quoteFor(
  target: SwapTarget,
  fromAsset: string,
  toAsset: string,
  amount: string,
) {
  const tokenIn = findToken(target.deployment, fromAsset)
  const tokenOut = findToken(target.deployment, toAsset)
  if (!tokenIn || !tokenOut)
    throw new Error(
      `Unknown asset. ${target.chainIdentifier} swaps: ${target.deployment.tokens
        .map(token => token.symbol)
        .join(', ')}`,
    )
  const quote = await fetchSwapQuote(target.reader, target.deployment, {
    tokenIn,
    tokenOut,
    amountIn: parseUnits(amount.trim(), tokenIn.decimals),
  })
  return { tokenIn, tokenOut, quote }
}

const percent = (ppm: number) => `${(ppm / 10_000).toFixed(4)}%`

export async function swapQuoteCommand(
  fromAsset: string,
  toAsset: string,
  amount: string,
  options: SwapQuoteOptions = {},
): Promise<void> {
  try {
    const target = await swapNetwork.open(options)
    const { tokenIn, tokenOut, quote } = await quoteFor(
      target,
      fromAsset,
      toAsset,
      amount,
    )
    const slippageBps = slippageOf(options)
    const minimumAmountOut = minimumOutput(quote.amountOut, slippageBps)
    const result = {
      chain: target.chainIdentifier,
      exchange: 'Uniswap v4',
      officialUniswapDeployment: target.deployment.officialUniswapDeployment,
      maintainer: target.deployment.maintainer,
      from: tokenIn.symbol,
      to: tokenOut.symbol,
      amountIn: formatUnits(quote.amountIn, tokenIn.decimals),
      amountOut: formatUnits(quote.amountOut, tokenOut.decimals),
      minimumAmountOut: formatUnits(minimumAmountOut, tokenOut.decimals),
      slippageBps,
      poolFee: percent(quote.lpFeePpm),
      priceImpact: percent(quote.priceImpactPpm),
      interfaceFee: 'none',
    }
    outputResult(
      result,
      () => {
        console.log(
          `Quote from the Uniswap v4 quoter on ${result.chain} (deployment maintained by ${result.maintainer}):`,
        )
        console.log(`  Pay:              ${result.amountIn} ${result.from}`)
        console.log(`  Receive:          ${result.amountOut} ${result.to}`)
        console.log(
          `  Minimum received: ${result.minimumAmountOut} ${result.to} (slippage ${
            result.slippageBps / 100
          }%)`,
        )
        console.log(`  Pool fee:         ${result.poolFee}`)
        console.log(`  Price impact:     ${result.priceImpact}`)
        console.log('  Interface fee:    none')
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

/** Prints the unsigned transactions a swap from `--account` needs. Signs and sends nothing. */
export async function swapBuildCommand(
  fromAsset: string,
  toAsset: string,
  amount: string,
  options: SwapQuoteOptions = {},
): Promise<void> {
  try {
    if (!options.account)
      throw new Error('--account <address> is required: the account that swaps')
    const account = getAddress(options.account)
    const target = await swapNetwork.open(options)
    const { tokenIn, tokenOut, quote } = await quoteFor(
      target,
      fromAsset,
      toAsset,
      amount,
    )
    const plan = await planSwap(target.reader, target.deployment, {
      quote,
      slippageBps: slippageOf(options),
      account,
    })
    // An unapproved token swap cannot be gas-estimated yet; that is said, not guessed.
    const fee =
      plan.approvals.length === 0
        ? await estimateCallFee(target.reader, plan.swap, account)
        : undefined
    const result = {
      chain: target.chainIdentifier,
      account,
      from: tokenIn.symbol,
      to: tokenOut.symbol,
      amountIn: formatUnits(quote.amountIn, tokenIn.decimals),
      quotedAmountOut: formatUnits(quote.amountOut, tokenOut.decimals),
      minimumAmountOut: formatUnits(plan.minimumAmountOut, tokenOut.decimals),
      deadline: plan.deadline,
      approvals: plan.approvals.map(step => ({
        kind: step.kind,
        to: step.call.to,
        data: step.call.data,
      })),
      swap: {
        to: plan.swap.to,
        value: plan.swap.value.toString(),
        data: plan.swap.data,
      },
      gasLimit: fee?.gasLimit.toString() ?? null,
      maximumNetworkFeeWei: fee?.maximumFeeWei.toString() ?? null,
    }
    outputResult(
      result,
      () => {
        console.log(`Unsigned swap for ${account} on ${result.chain}:`)
        console.log(`  Pay:              ${result.amountIn} ${result.from}`)
        console.log(
          `  Minimum received: ${result.minimumAmountOut} ${result.to} (quoted ${result.quotedAmountOut})`,
        )
        console.log(`  Deadline:         ${result.deadline} (unix seconds)`)
        for (const approval of result.approvals)
          console.log(`  Approval first:   ${approval.kind} -> ${approval.to}`)
        console.log(`  To:               ${result.swap.to}`)
        console.log(`  Value (wei):      ${result.swap.value}`)
        console.log(`  Data:             ${result.swap.data}`)
        console.log(
          result.gasLimit
            ? `  Gas limit:        ${result.gasLimit} (max fee ${result.maximumNetworkFeeWei} wei)`
            : '  Gas limit:        not estimated until the approvals above confirm',
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}
