/**
 * DAppPlugin Host Abstraction & Typed Data Interfaces (Ticket #1154).
 *
 * Provides a chain-agnostic dApp interface boundary for DEX aggregators,
 * swap routers, prediction markets, and escrow protocols across EVM and Solana.
 */

export type DAppChainType = 'evm' | 'solana' | 'bitcoin' | 'ecash' | 'multi'

export interface DAppPluginMetadata {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly chainType: DAppChainType
  readonly icon?: string
}

export interface DAppQuoteRequest {
  readonly inputToken: string
  readonly outputToken: string
  readonly inputAmount: bigint | string | number
  readonly slippageBps?: number
  readonly userAddress?: string
  readonly destinationAddress?: string
  readonly feeBps?: number
  readonly feeRecipient?: string
  readonly chainId?: number | string
  readonly extra?: Record<string, unknown>
}

export interface DAppQuoteResponse {
  readonly pluginId: string
  readonly inputToken: string
  readonly outputToken: string
  readonly inputAmount: bigint
  readonly expectedOutputAmount: bigint
  readonly minOutputAmount: bigint
  readonly feeAmount: bigint
  readonly feeBps: number
  readonly feeRecipient?: string
  readonly priceImpact?: number
  readonly estimatedGas?: bigint
  readonly route?: unknown
  readonly rawQuote?: unknown
  readonly metadata?: Record<string, unknown>
}

export interface DAppBuildTxRequest {
  readonly quote: DAppQuoteResponse
  readonly userAddress: string
  readonly destinationAddress?: string
  readonly deadline?: number
  readonly chainId?: number | string
  readonly extra?: Record<string, unknown>
}

export interface EIP712Domain {
  name?: string
  version?: string
  chainId?: number | bigint | string
  verifyingContract?: string
  salt?: string
}

export interface EIP712TypeProperty {
  name: string
  type: string
}

export type EIP712Types = Record<string, EIP712TypeProperty[]>

export interface EIP712TypedData {
  domain: EIP712Domain
  types: EIP712Types
  primaryType: string
  message: Record<string, unknown>
}

export interface DAppPreparedTransaction {
  readonly pluginId: string
  readonly chainType: DAppChainType
  readonly recipient: string
  readonly to?: string
  readonly data?: string
  readonly value?: bigint
  readonly chainId?: number
  readonly instructions?: unknown[]
  readonly signers?: unknown[]
  readonly typedData?: EIP712TypedData
  readonly rawTx?: unknown
  readonly metadata?: Record<string, unknown>
}

export interface PredictionOrder {
  readonly marketId: string
  readonly outcomeIndex: number
  readonly amount: bigint
  readonly price: bigint
  readonly expiration: number
  readonly salt: bigint | string
  readonly maker?: string
}

export interface DAppPlugin {
  readonly id: string
  readonly name: string
  readonly chainType: DAppChainType
  getMetadata(): DAppPluginMetadata
  getQuote(params: DAppQuoteRequest): Promise<DAppQuoteResponse>
  buildTransaction(params: DAppBuildTxRequest): Promise<DAppPreparedTransaction>
}

export const DEFAULT_PROTOCOL_FEE_BPS = 8.75 // 8.75 bps = 0.0875% = 0.000875
