/**
 * Hyperliquid L1 Orderbook Router DAppPlugin.
 *
 * Implements EVM / L1 execution for Hyperliquid (HYPE and CLOB pairs)
 * with partner fee sharing (default: 8.75 bps / 0.0875%).
 */

import type {
  DAppBuildTxRequest,
  DAppPlugin,
  DAppPluginMetadata,
  DAppPreparedTransaction,
  DAppQuoteRequest,
  DAppQuoteResponse,
} from './types'
import { DEFAULT_PROTOCOL_FEE_BPS } from './types'

export class HyperliquidDAppPlugin implements DAppPlugin {
  readonly id = 'hyperliquid-l1'
  readonly name = 'Hyperliquid L1 Orderbook Router'
  readonly chainType = 'evm' as const

  constructor(
    readonly defaultFeeBps: number = DEFAULT_PROTOCOL_FEE_BPS,
    readonly defaultFeeRecipient: string = '0xFeE000000000000000000000000000000000DaFe',
  ) {}

  getMetadata(): DAppPluginMetadata {
    return {
      id: this.id,
      name: this.name,
      version: '1.0.0',
      description:
        'Hyperliquid L1 native CLOB orderbook execution & spot router',
      chainType: this.chainType,
      icon: 'https://hyperliquid.xyz/favicon.ico',
    }
  }

  async getQuote(params: DAppQuoteRequest): Promise<DAppQuoteResponse> {
    const inAmountBigInt = BigInt(params.inputAmount)
    if (inAmountBigInt <= 0n) {
      throw new RangeError('Input amount must be greater than zero')
    }

    const feeBpsVal = params.feeBps ?? this.defaultFeeBps
    const feeAmount =
      (inAmountBigInt * BigInt(Math.floor(feeBpsVal * 100))) / 1_000_000n
    const netAmount = inAmountBigInt - feeAmount

    return {
      pluginId: this.id,
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      inputAmount: inAmountBigInt,
      expectedOutputAmount: netAmount,
      minOutputAmount: netAmount,
      feeAmount,
      feeBps: feeBpsVal,
      feeRecipient: params.feeRecipient ?? this.defaultFeeRecipient,
      route: {
        type: 'clob-orderbook',
        router: this.name,
      },
    }
  }

  async buildTransaction(
    params: DAppBuildTxRequest,
  ): Promise<DAppPreparedTransaction> {
    return {
      pluginId: this.id,
      chainType: this.chainType,
      recipient: params.destinationAddress ?? params.userAddress,
      metadata: {
        swapType: 'hyperliquid-clob',
        router: this.name,
        inputToken: params.quote.inputToken,
        outputToken: params.quote.outputToken,
      },
    }
  }
}
