/**
 * dApp Swap and Plugin Commands for Signet CLI (Tickets #1154, #1155).
 *
 * Provides:
 * - signet swap plugins: List registered dApp plugins (Uniswap Universal Router, Jupiter Aggregator, Prediction Escrow)
 * - signet swap quote: Fetch swap quote with exact 8.75 bps (0.0875%) protocol fee breakdown
 * - signet swap build: Construct swap transaction settling into a recoverable HD change address (m/44'/60'/0'/1/i or m/44'/501'/0'/1'/i')
 */

import { formatUnits, parseUnits } from 'ethers'
import {
  createStandardPluginRegistry,
  DEFAULT_PROTOCOL_FEE_BPS,
  type DAppPlugin,
  type DAppQuoteResponse,
  KNOWN_EVM_TOKENS,
  KNOWN_SOLANA_TOKENS,
  UniswapDAppPlugin,
} from '@frank/wallet/plugins'
import { EvmChangeKeyring } from '@frank/wallet/secp256k1-hd-keyring'
import {
  SolanaChangeKeyring,
  SolanaHdKeyring,
} from '@frank/wallet/ed25519-hd-keyring'

import { loadIdentity, resolveDataDir } from '../config'
import { outputError, outputResult } from '../util'

export interface SwapPluginsOptions {
  json?: boolean
}

export interface SwapQuoteOptions {
  plugin?: string
  feeBps?: string | number
  slippageBps?: string | number
  json?: boolean
}

export interface SwapBuildOptions {
  plugin?: string
  destination?: string
  changeIndex?: string | number
  feeBps?: string | number
  slippageBps?: string | number
  dataDir?: string
  password?: string
  json?: boolean
}

function resolveTokenDecimals(
  tokenSymbol: string,
  chainType: 'evm' | 'solana',
): number {
  const upper = tokenSymbol.toUpperCase()
  if (chainType === 'solana') {
    if (KNOWN_SOLANA_TOKENS[upper]) return KNOWN_SOLANA_TOKENS[upper].decimals
    return 6
  } else {
    if (KNOWN_EVM_TOKENS[upper]) return KNOWN_EVM_TOKENS[upper].decimals
    return 18
  }
}

function selectPluginForTokens(
  fromAsset: string,
  toAsset: string,
  requestedPluginId?: string,
): DAppPlugin {
  const registry = createStandardPluginRegistry()
  if (requestedPluginId) {
    return registry.require(requestedPluginId)
  }

  const solanaSymbols = new Set(['SOL', 'WSOL', 'JUP'])
  const fromUpper = fromAsset.toUpperCase()
  const toUpper = toAsset.toUpperCase()

  if (solanaSymbols.has(fromUpper) || solanaSymbols.has(toUpper)) {
    return registry.require('jupiter-aggregator')
  }

  return registry.require('uniswap-universal-router')
}

/**
 * Lists available dApp plugins in the plugin registry.
 */
export async function swapPluginsCommand(
  options: SwapPluginsOptions = {},
): Promise<void> {
  try {
    const registry = createStandardPluginRegistry()
    const plugins = registry.list()

    const result = {
      count: plugins.length,
      plugins: plugins.map(p => p.getMetadata()),
    }

    outputResult(
      result,
      () => {
        console.log(`Registered dApp Plugins (${plugins.length}):`)
        console.log(
          '-------------------------------------------------------------------------------------------------',
        )
        console.log(
          `${'ID'.padEnd(28)} ${'NAME'.padEnd(28)} ${'CHAIN'.padEnd(
            10,
          )} ${'DESCRIPTION'}`,
        )
        console.log(
          '-------------------------------------------------------------------------------------------------',
        )
        for (const meta of result.plugins) {
          console.log(
            `${meta.id.padEnd(28)} ${meta.name.padEnd(
              28,
            )} ${meta.chainType.padEnd(10)} ${meta.description}`,
          )
        }
        console.log(
          '-------------------------------------------------------------------------------------------------',
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

/**
 * Queries a swap quote with protocol fee and minimum output breakdown.
 */
export async function swapQuoteCommand(
  fromAsset: string,
  toAsset: string,
  amountStr: string,
  options: SwapQuoteOptions = {},
): Promise<void> {
  try {
    const plugin = selectPluginForTokens(fromAsset, toAsset, options.plugin)
    const chainType = plugin.chainType === 'solana' ? 'solana' : 'evm'
    const inDecimals = resolveTokenDecimals(fromAsset, chainType)
    const outDecimals = resolveTokenDecimals(toAsset, chainType)

    const inputAmount = parseUnits(amountStr.trim(), inDecimals)
    const feeBps = options.feeBps
      ? Number(options.feeBps)
      : DEFAULT_PROTOCOL_FEE_BPS
    const slippageBps = options.slippageBps ? Number(options.slippageBps) : 50

    const quote: DAppQuoteResponse = await plugin.getQuote({
      inputToken: fromAsset.toUpperCase(),
      outputToken: toAsset.toUpperCase(),
      inputAmount,
      feeBps,
      slippageBps,
    })

    const netInput = quote.inputAmount - quote.feeAmount
    const feePercentStr = (feeBps / 100).toFixed(4) // e.g. 0.0875%

    const result = {
      pluginId: plugin.id,
      chainType: plugin.chainType,
      inputToken: quote.inputToken,
      outputToken: quote.outputToken,
      inputAmount: quote.inputAmount.toString(),
      inputAmountFormatted: `${formatUnits(quote.inputAmount, inDecimals)} ${
        quote.inputToken
      }`,
      feeAmount: quote.feeAmount.toString(),
      feeAmountFormatted: `${formatUnits(quote.feeAmount, inDecimals)} ${
        quote.inputToken
      }`,
      feeBps: quote.feeBps,
      feePercentage: `${feePercentStr}%`,
      feeRecipient: quote.feeRecipient,
      netInputAmount: netInput.toString(),
      netInputAmountFormatted: `${formatUnits(netInput, inDecimals)} ${
        quote.inputToken
      }`,
      expectedOutputAmount: quote.expectedOutputAmount.toString(),
      expectedOutputFormatted: `${formatUnits(
        quote.expectedOutputAmount,
        outDecimals,
      )} ${quote.outputToken}`,
      minOutputAmount: quote.minOutputAmount.toString(),
      minOutputFormatted: `${formatUnits(quote.minOutputAmount, outDecimals)} ${
        quote.outputToken
      }`,
      slippageBps,
      priceImpact: quote.priceImpact,
      estimatedGas:
        quote.estimatedGas !== undefined
          ? quote.estimatedGas.toString()
          : undefined,
    }

    outputResult(
      result,
      () => {
        console.log(`Swap Quote via ${plugin.name}:`)
        console.log(
          `  Input:                ${result.inputAmountFormatted} (${result.inputAmount} base units)`,
        )
        console.log(
          `  Protocol Fee (8.75 bps): -${result.feeAmountFormatted} (${
            result.feePercentage
          } to ${result.feeRecipient ?? 'default'})`,
        )
        console.log(
          `  Net Swapped Amount:    ${result.netInputAmountFormatted}`,
        )
        console.log(
          `  Expected Output:      ~${result.expectedOutputFormatted}`,
        )
        console.log(
          `  Guaranteed Minimum:    ${result.minOutputFormatted} (with ${slippageBps} bps slippage)`,
        )
        if (quote.priceImpact !== undefined) {
          console.log(
            `  Price Impact:          ${(quote.priceImpact * 100).toFixed(2)}%`,
          )
        }
        if (result.estimatedGas) {
          console.log(
            `  Estimated Gas / CUs:   ${
              result.estimatedGas
            } (${plugin.chainType.toUpperCase()})`,
          )
        }
        console.log(
          "\nRun 'signet swap build' to construct the transaction settling to your HD change address.",
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}

/**
 * Builds the swap transaction with outputs routing directly into a recoverable HD change address.
 */
export async function swapBuildCommand(
  fromAsset: string,
  toAsset: string,
  amountStr: string,
  options: SwapBuildOptions = {},
): Promise<void> {
  try {
    const dataDir = resolveDataDir(options.dataDir)
    const { identity, mnemonic } = await loadIdentity(
      dataDir,
      undefined,
      options.password,
    )

    const plugin = selectPluginForTokens(fromAsset, toAsset, options.plugin)
    const chainType = plugin.chainType === 'solana' ? 'solana' : 'evm'
    const inDecimals = resolveTokenDecimals(fromAsset, chainType)
    const outDecimals = resolveTokenDecimals(toAsset, chainType)

    const inputAmount = parseUnits(amountStr.trim(), inDecimals)
    const feeBps = options.feeBps
      ? Number(options.feeBps)
      : DEFAULT_PROTOCOL_FEE_BPS
    const slippageBps = options.slippageBps ? Number(options.slippageBps) : 50

    const quote = await plugin.getQuote({
      inputToken: fromAsset.toUpperCase(),
      outputToken: toAsset.toUpperCase(),
      inputAmount,
      feeBps,
      slippageBps,
    })

    const changeIndex = options.changeIndex ? Number(options.changeIndex) : 0

    // Derive HD change address settlement destination
    let userAddress = identity.displayAddress
    let destinationAddress: string
    let derivationPath: string

    if (chainType === 'solana') {
      const solanaSpendKeyring = await SolanaHdKeyring.fromMnemonic(mnemonic)
      const solanaSpendAccount = await solanaSpendKeyring.deriveSubAccount(0)
      userAddress = solanaSpendAccount.address

      if (options.destination) {
        destinationAddress = options.destination.trim()
        derivationPath = 'custom-destination'
      } else {
        const changeKeyring = await SolanaChangeKeyring.fromMnemonic(mnemonic)
        const changeAccount = await changeKeyring.deriveChangeAccount(
          changeIndex,
        )
        destinationAddress = changeAccount.address
        derivationPath = changeAccount.path
      }
    } else {
      if (options.destination) {
        destinationAddress = options.destination.trim()
        derivationPath = 'custom-destination'
      } else {
        const changeKeyring = EvmChangeKeyring.fromMnemonic(mnemonic)
        const changeAccount = changeKeyring.deriveChangeAccount(changeIndex)
        destinationAddress = changeAccount.address
        derivationPath = changeKeyring.subAccountPath(changeAccount.index)
      }
    }

    const preparedTx = await plugin.buildTransaction({
      quote,
      destinationAddress,
      userAddress,
    })

    // If Uniswap EVM, decode calldata to verify settlement address matches
    let decodedRecipient: string | undefined
    if (plugin instanceof UniswapDAppPlugin && preparedTx.data) {
      const decoded = plugin.decodeExecuteCalldata(preparedTx.data)
      decodedRecipient = decoded.swapRecipient
      if (
        decodedRecipient?.toLowerCase() !== destinationAddress.toLowerCase()
      ) {
        throw new Error(
          `Security invariant failure: swapRecipient (${decodedRecipient}) does not match destinationChangeAddress (${destinationAddress})!`,
        )
      }
    }

    const result = {
      pluginId: plugin.id,
      chainType: plugin.chainType,
      userAddress: identity.displayAddress,
      destinationChangeAddress: destinationAddress,
      derivationPath,
      swap: {
        from: quote.inputToken,
        to: quote.outputToken,
        inputAmount: quote.inputAmount.toString(),
        inputFormatted: `${formatUnits(quote.inputAmount, inDecimals)} ${
          quote.inputToken
        }`,
        feeAmount: quote.feeAmount.toString(),
        feeFormatted: `${formatUnits(quote.feeAmount, inDecimals)} ${
          quote.inputToken
        }`,
        minOutputAmount: quote.minOutputAmount.toString(),
        minOutputFormatted: `${formatUnits(
          quote.minOutputAmount,
          outDecimals,
        )} ${quote.outputToken}`,
      },
      transaction: {
        to: preparedTx.to,
        recipient: preparedTx.recipient,
        value: preparedTx.value?.toString(),
        data: preparedTx.data,
        instructionCount: preparedTx.instructions?.length,
        chainId: preparedTx.chainId,
        verifiedRecipientInCalldata: decodedRecipient,
      },
    }

    outputResult(
      result,
      () => {
        console.log(`Swap Transaction Prepared via ${plugin.name}:`)
        console.log(
          `  Settlement Destination: ${result.destinationChangeAddress}`,
        )
        console.log(`  HD Derivation Path:     ${result.derivationPath}`)
        console.log(
          `  Swap Route:             ${result.swap.inputFormatted} -> min ${result.swap.minOutputFormatted}`,
        )
        console.log(
          `  Convenience Fee:        ${result.swap.feeFormatted} (8.75 bps)`,
        )
        if (preparedTx.to) {
          console.log(`  Target Router Address:  ${preparedTx.to}`)
        }
        if (preparedTx.value && preparedTx.value > 0n) {
          console.log(
            `  Native Value Sent:      ${preparedTx.value.toString()} wei`,
          )
        }
        if (preparedTx.data) {
          console.log(
            `  Calldata:               ${preparedTx.data.slice(0, 66)}... (${
              preparedTx.data.length
            } hex chars)`,
          )
        }
        if (preparedTx.instructions) {
          console.log(
            `  Instructions:           ${preparedTx.instructions.length} Solana instruction(s) generated`,
          )
        }
        console.log(
          `\nOutput funds will settle into recoverable HD change address ${result.destinationChangeAddress}.`,
        )
      },
      options.json,
    )
  } catch (err) {
    outputError(err, options.json)
  }
}
