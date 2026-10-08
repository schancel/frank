/**
 * Tempo Settlement Engine DAppPlugin.
 *
 * Implements EVM settlement for Tempo (TIP-20 path USD and stable token swaps)
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

export class TempoDAppPlugin implements DAppPlugin {
  readonly id = 'tempo-router'
  readonly name = 'Tempo Settlement Engine'
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
        'Tempo Settlement Engine for high-throughput sub-second stable settlements',
      chainType: this.chainType,
      icon: 'https://tempo.xyz/favicon.ico',
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
        type: 'tempo-engine',
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
        swapType: 'tempo-settlement',
        router: this.name,
        inputToken: params.quote.inputToken,
        outputToken: params.quote.outputToken,
      },
    }
  }
}
