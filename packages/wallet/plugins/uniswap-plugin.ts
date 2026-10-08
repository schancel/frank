/**
 * Uniswap Universal Router DAppPlugin (Ticket #1154).
 *
 * Implements EVM DEX Swapping via Uniswap Universal Router with partner fee sharing
 * (default: 8.75 bps / 0.0875%) and direct settlement into an HD change address
 * (BIP-44 path m/44'/60'/0'/1/i).
 */

import {
  AbiCoder,
  getBytes,
  hexlify,
  Interface,
  zeroPadValue,
  concat,
  getAddress,
} from 'ethers'
import type {
  DAppBuildTxRequest,
  DAppPlugin,
  DAppPluginMetadata,
  DAppPreparedTransaction,
  DAppQuoteRequest,
  DAppQuoteResponse,
} from './types'
import { DEFAULT_PROTOCOL_FEE_BPS } from './types'

export const DEFAULT_UNISWAP_ROUTER_ADDRESS =
  '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'

export const DEFAULT_UNISWAP_FEE_RECIPIENT =
  '0xFeE000000000000000000000000000000000DaFe'

export const UNIVERSAL_ROUTER_COMMANDS = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_PERMIT: 0x02,
  SWEEP: 0x04,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
} as const

export const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  'function execute(bytes calldata commands, bytes[] calldata inputs) external payable',
]

export const universalRouterInterface = new Interface(UNIVERSAL_ROUTER_ABI)

export interface TokenConfig {
  readonly symbol: string
  readonly address: string
  readonly decimals: number
  readonly priceUsd: number
}

export const KNOWN_EVM_TOKENS: Record<string, TokenConfig> = {
  USDC: {
    symbol: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    priceUsd: 1.0,
  },
  MON: {
    symbol: 'MON',
    address: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    priceUsd: 3.5, // $3.50 per Monad baseline
  },
  AVU: {
    symbol: 'AVU',
    address: '0xa000000000000000000000000000000000000A70',
    decimals: 18,
    priceUsd: 0.084, // $0.084 per AVU energy anchor (1 AVU = 1 kWh)
  },
  ETH: {
    symbol: 'ETH',
    address: '0x0000000000000000000000000000000000000000',
    decimals: 18,
    priceUsd: 2600.0,
  },
  WETH: {
    symbol: 'WETH',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    priceUsd: 2600.0,
  },
  USDT: {
    symbol: 'USDT',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    priceUsd: 1.0,
  },
}

export interface DecodedUniversalRouterCall {
  readonly commands: string
  readonly deadline: bigint
  readonly feeRecipient?: string
  readonly feeBps?: number
  readonly swapRecipient?: string
  readonly amountIn?: bigint
  readonly amountOutMin?: bigint
  readonly path?: string
  readonly payerIsUser?: boolean
}

export class UniswapDAppPlugin implements DAppPlugin {
  readonly id = 'uniswap-universal-router'
  readonly name = 'Uniswap Universal Router'
  readonly chainType = 'evm' as const

  constructor(
    readonly routerAddress: string = DEFAULT_UNISWAP_ROUTER_ADDRESS,
    readonly defaultFeeRecipient: string = DEFAULT_UNISWAP_FEE_RECIPIENT,
    readonly defaultFeeBps: number = DEFAULT_PROTOCOL_FEE_BPS,
    private readonly customTokens: Record<string, TokenConfig> = {},
  ) {}

  getMetadata(): DAppPluginMetadata {
    return {
      id: this.id,
      name: this.name,
      version: '1.0.0',
      description:
        'Uniswap EVM DEX Swapping via Universal Router with 8.75 bps partner fee sharing and HD change settlement',
      chainType: this.chainType,
      icon: 'https://app.uniswap.org/favicon.ico',
    }
  }

  /**
   * Resolves token info from symbol or contract address.
   */
  resolveToken(tokenOrSymbol: string): TokenConfig {
    const upper = tokenOrSymbol.toUpperCase()
    if (this.customTokens[upper]) return this.customTokens[upper]
    if (KNOWN_EVM_TOKENS[upper]) return KNOWN_EVM_TOKENS[upper]

    const lower = tokenOrSymbol.toLowerCase()
    for (const token of Object.values({
      ...KNOWN_EVM_TOKENS,
      ...this.customTokens,
    })) {
      if (token.address.toLowerCase() === lower) return token
    }

    // Default fallback token
    return {
      symbol: tokenOrSymbol,
      address: tokenOrSymbol.startsWith('0x')
        ? tokenOrSymbol
        : '0x0000000000000000000000000000000000000000',
      decimals: 18,
      priceUsd: 1.0,
    }
  }

  /**
   * Calculates protocol fee: default 8.75 bps = 0.0875% = 0.000875.
   * feeAmount = (amount * 875) / 1,000,000.
   */
  calculateFeeAmount(amount: bigint, feeBps: number): bigint {
    const scaledBps = BigInt(Math.round(feeBps * 100))
    return (amount * scaledBps) / 1_000_000n
  }

  /**
   * Encodes a Uniswap V3 packed path: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes)...
   */
  encodeV3Path(tokens: string[], fees: number[] = [3000]): string {
    if (tokens.length < 2) {
      throw new Error('Path must contain at least 2 tokens')
    }
    const parts: Uint8Array[] = []
    for (let i = 0; i < tokens.length; i++) {
      const addrBytes = getBytes(zeroPadValue(tokens[i], 20))
      parts.push(addrBytes)
      if (i < tokens.length - 1) {
        const fee = fees[i] ?? 3000
        const feeBytes = new Uint8Array(3)
        feeBytes[0] = (fee >> 16) & 0xff
        feeBytes[1] = (fee >> 8) & 0xff
        feeBytes[2] = fee & 0xff
        parts.push(feeBytes)
      }
    }
    return hexlify(concat(parts))
  }

  /**
   * Computes a swap quote with protocol convenience fee deducted from input.
   */
  async getQuote(params: DAppQuoteRequest): Promise<DAppQuoteResponse> {
    const inputAmount =
      typeof params.inputAmount === 'bigint'
        ? params.inputAmount
        : BigInt(params.inputAmount)

    if (inputAmount <= 0n) {
      throw new RangeError('inputAmount must be greater than zero')
    }

    const inToken = this.resolveToken(params.inputToken)
    const outToken = this.resolveToken(params.outputToken)

    const feeBps = params.feeBps ?? this.defaultFeeBps
    const feeRecipient = params.feeRecipient ?? this.defaultFeeRecipient
    const feeAmount = this.calculateFeeAmount(inputAmount, feeBps)
    const netInputAmount = inputAmount - feeAmount

    // High-precision output calculation:
    // (netInput / 10^inDecimals) * (inPrice / outPrice) * 10^outDecimals
    const inDecFactor = 10n ** BigInt(inToken.decimals)
    const outDecFactor = 10n ** BigInt(outToken.decimals)
    const scale = 10n ** 12n
    const rateScaled = BigInt(
      Math.round((inToken.priceUsd / outToken.priceUsd) * 1e12),
    )

    const expectedOutputAmount =
      (netInputAmount * rateScaled * outDecFactor) / (inDecFactor * scale)

    const slippageBps = params.slippageBps ?? 50 // default 0.5% (50 bps)
    const minOutputAmount =
      (expectedOutputAmount * (10_000n - BigInt(slippageBps))) / 10_000n

    return {
      pluginId: this.id,
      inputToken: inToken.symbol,
      outputToken: outToken.symbol,
      inputAmount,
      expectedOutputAmount,
      minOutputAmount,
      feeAmount,
      feeBps,
      feeRecipient,
      priceImpact: 0.0005, // 0.05%
      estimatedGas: 165_000n,
      route: {
        type: 'Uniswap_V3',
        inputAddress: inToken.address,
        outputAddress: outToken.address,
        poolFee: 3000,
      },
      metadata: {
        netInputAmount: netInputAmount.toString(),
        rate: inToken.priceUsd / outToken.priceUsd,
      },
    }
  }

  /**
   * Builds the Universal Router swap transaction settling to destinationChangeAddress.
   */
  async buildTransaction(
    params: DAppBuildTxRequest,
  ): Promise<DAppPreparedTransaction> {
    if (!params.destinationAddress) {
      throw new Error(
        'destinationAddress (HD change address) is required for Universal Router settlement.',
      )
    }
    const destinationAddress = getAddress(params.destinationAddress)

    const quote = params.quote
    const inToken = this.resolveToken(quote.inputToken)
    const outToken = this.resolveToken(quote.outputToken)
    const feeRecipient = getAddress(
      quote.feeRecipient ?? this.defaultFeeRecipient,
    )
    const feeBps = quote.feeBps ?? this.defaultFeeBps

    const abiCoder = AbiCoder.defaultAbiCoder()
    const inTokenAddress = inToken.address.startsWith('0x')
      ? getAddress(inToken.address)
      : inToken.address
    const outTokenAddress = outToken.address.startsWith('0x')
      ? getAddress(outToken.address)
      : outToken.address
    const pathBytes = this.encodeV3Path([inTokenAddress, outTokenAddress])

    // Command 0x06: PAY_PORTION(address token, address recipient, uint256 bips)
    // Universal Router PAY_PORTION expects basis points (where 10000 = 100%).
    // For 8.75 bps, we encode 875 as scaled or standard integer basis points.
    const feeBipsInt = BigInt(Math.round(feeBps * 100))
    const inputFee = abiCoder.encode(
      ['address', 'address', 'uint256'],
      [inTokenAddress, feeRecipient, feeBipsInt],
    )

    // Command 0x00: V3_SWAP_EXACT_IN(address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
    // Recipient is explicitly set to destinationAddress (HD change address).
    const netInputAmount = quote.inputAmount - quote.feeAmount
    const inputSwap = abiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [
        destinationAddress,
        netInputAmount,
        quote.minOutputAmount,
        pathBytes,
        true,
      ],
    )

    // Commands string: 0x06 (PAY_PORTION) + 0x00 (V3_SWAP_EXACT_IN)
    const commandsHex = '0x0600'
    const inputs = [inputFee, inputSwap]
    const deadline = params.deadline ?? Math.floor(Date.now() / 1000) + 1800 // 30 min deadline

    const calldata = universalRouterInterface.encodeFunctionData(
      'execute(bytes,bytes[],uint256)',
      [commandsHex, inputs, BigInt(deadline)],
    )

    const isNativeIn =
      inToken.symbol === 'ETH' ||
      inToken.symbol === 'MON' ||
      inToken.address === '0x0000000000000000000000000000000000000000'

    return {
      pluginId: this.id,
      chainType: this.chainType,
      recipient: destinationAddress,
      to: this.routerAddress,
      data: calldata,
      value: isNativeIn ? quote.inputAmount : 0n,
      chainId: params.chainId ? Number(params.chainId) : 10143,
      metadata: {
        destinationChangeAddress: destinationAddress,
        feeAmount: quote.feeAmount.toString(),
        feeRecipient,
        feeBps,
        commands: commandsHex,
        deadline,
      },
    }
  }

  /**
   * Helper to inspect and decode a generated execute() calldata.
   */
  decodeExecuteCalldata(calldata: string): DecodedUniversalRouterCall {
    const decoded = universalRouterInterface.decodeFunctionData(
      'execute(bytes,bytes[],uint256)',
      calldata,
    )
    const commands = decoded[0] as string
    const inputs = decoded[1] as string[]
    const deadline = decoded[2] as bigint

    const abiCoder = AbiCoder.defaultAbiCoder()
    let feeRecipient: string | undefined
    let feeBps: number | undefined
    let swapRecipient: string | undefined
    let amountIn: bigint | undefined
    let amountOutMin: bigint | undefined
    let path: string | undefined
    let payerIsUser: boolean | undefined

    if (inputs.length >= 2) {
      const feeDecoded = abiCoder.decode(
        ['address', 'address', 'uint256'],
        inputs[0],
      )
      feeRecipient = feeDecoded[1]
      feeBps = Number(feeDecoded[2]) / 100

      const swapDecoded = abiCoder.decode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        inputs[1],
      )
      swapRecipient = swapDecoded[0]
      amountIn = swapDecoded[1]
      amountOutMin = swapDecoded[2]
      path = swapDecoded[3]
      payerIsUser = swapDecoded[4]
    }

    return {
      commands,
      deadline,
      feeRecipient,
      feeBps,
      swapRecipient,
      amountIn,
      amountOutMin,
      path,
      payerIsUser,
    }
  }
}
