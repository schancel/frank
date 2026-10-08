/**
 * Prediction Escrow DAppPlugin (Ticket #1154).
 *
 * Implements non-DEX conditional outcome agreements (e.g. Polymarket-style binary
 * prediction markets and Frank peer escrows) using EIP-712 structured typed data signing
 * (eth_signTypedData_v4) and signature verification.
 */

import {
  getBytes,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
  zeroPadValue,
} from 'ethers'
import type {
  DAppBuildTxRequest,
  DAppPlugin,
  DAppPluginMetadata,
  DAppPreparedTransaction,
  DAppQuoteRequest,
  DAppQuoteResponse,
  EIP712Domain,
  EIP712TypedData,
  EIP712Types,
  PredictionOrder,
} from './types'
import { DEFAULT_PROTOCOL_FEE_BPS } from './types'

export const DEFAULT_PREDICTION_ESCROW_CONTRACT =
  '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57'

export const DEFAULT_PREDICTION_ESCROW_DOMAIN: EIP712Domain = {
  name: 'FrankPredictionEscrow',
  version: '1',
  chainId: 10143, // Monad testnet default
  verifyingContract: DEFAULT_PREDICTION_ESCROW_CONTRACT,
}

export const PREDICTION_ORDER_PRIMARY_TYPE = 'PredictionOrder'

export const PREDICTION_ORDER_EIP712_TYPES = {
  PredictionOrder: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'outcomeIndex', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'salt', type: 'uint256' },
  ],
}

/**
 * Normalizes market ID to 32-byte hex string (hash if plain text, zero-pad if hex).
 */
export function normalizeMarketId(marketId: string): string {
  if (marketId.startsWith('0x')) {
    if (marketId.length === 66) return marketId
    return zeroPadValue(marketId, 32)
  }
  return keccak256(toUtf8Bytes(marketId))
}

/**
 * Normalizes a PredictionOrder so marketId is a 32-byte hex string and values are BigInts.
 */
export function normalizeOrder(order: PredictionOrder): PredictionOrder {
  return {
    marketId: normalizeMarketId(order.marketId),
    outcomeIndex: order.outcomeIndex,
    amount: BigInt(order.amount),
    price: BigInt(order.price),
    expiration: Number(order.expiration),
    salt: BigInt(order.salt),
    ...(order.maker ? { maker: order.maker } : {}),
  }
}

/**
 * Strips EIP712Domain from types record if present, since ethers expects domain types omitted.
 */
export function sanitizeTypesForEthers(
  types: EIP712Types,
): Record<string, { name: string; type: string }[]> {
  const sanitized = { ...types }
  delete sanitized.EIP712Domain
  return sanitized
}

export class PredictionEscrowDAppPlugin implements DAppPlugin {
  readonly id = 'prediction-escrow'
  readonly name = 'Prediction Escrow'
  readonly chainType = 'evm' as const

  constructor(
    readonly defaultDomain: EIP712Domain = DEFAULT_PREDICTION_ESCROW_DOMAIN,
    readonly defaultFeeBps: number = DEFAULT_PROTOCOL_FEE_BPS,
  ) {}

  getMetadata(): DAppPluginMetadata {
    return {
      id: this.id,
      name: this.name,
      version: '1.0.0',
      description:
        'Conditional outcome escrow and binary prediction orders with EIP-712 structured typed data signing',
      chainType: this.chainType,
      icon: 'https://polymarket.com/favicon.ico',
    }
  }

  /**
   * Returns standard EIP-712 types dictionary for PredictionOrder.
   */
  getEIP712Types(): typeof PREDICTION_ORDER_EIP712_TYPES {
    return PREDICTION_ORDER_EIP712_TYPES
  }

  /**
   * Normalizes an order and signs it via a typed data signer.
   */
  async signOrder(
    signer: {
      signTypedData(
        domain: EIP712Domain,
        types: Record<string, { name: string; type: string }[]>,
        value: Record<string, any>,
      ): Promise<string>
    },
    order: PredictionOrder,
    domain: EIP712Domain = this.defaultDomain,
  ): Promise<string> {
    const norm = normalizeOrder(order)
    return await signer.signTypedData(
      domain,
      PREDICTION_ORDER_EIP712_TYPES,
      norm as any,
    )
  }

  /**
   * Builds an EIP-712 typed data payload ready for eth_signTypedData_v4.
   */
  buildOrderTypedData(
    order: PredictionOrder,
    domain: EIP712Domain = this.defaultDomain,
  ): EIP712TypedData {
    const norm = normalizeOrder(order)

    const payload = TypedDataEncoder.getPayload(
      domain,
      PREDICTION_ORDER_EIP712_TYPES,
      norm as any,
    )

    return {
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message,
    }
  }

  /**
   * Computes the 32-byte EIP-712 message hash:
   * keccak256("\x19\x01" || hashStruct(domain) || hashStruct(message))
   */
  hashOrder(
    order: PredictionOrder,
    domain: EIP712Domain = this.defaultDomain,
  ): string {
    const norm = normalizeOrder(order)

    return TypedDataEncoder.hash(
      domain,
      PREDICTION_ORDER_EIP712_TYPES,
      norm as any,
    )
  }

  /**
   * Verifies an EIP-712 signature over a PredictionOrder against expected signer address.
   */
  verifyOrderSignature(
    order: PredictionOrder,
    signature: string,
    expectedSigner: string,
    domain: EIP712Domain = this.defaultDomain,
  ): boolean {
    const norm = normalizeOrder(order)

    try {
      const recovered = verifyTypedData(
        domain,
        PREDICTION_ORDER_EIP712_TYPES,
        norm as any,
        signature,
      )
      return recovered.toLowerCase() === expectedSigner.toLowerCase()
    } catch {
      return false
    }
  }

  /**
   * Validates an arbitrary EIP712TypedData payload and signature against an expected signer.
   */
  validateSignature(
    typedData: EIP712TypedData,
    signature: string,
    expectedSigner: string,
  ): boolean {
    try {
      const sanitizedTypes = sanitizeTypesForEthers(typedData.types)
      const recovered = verifyTypedData(
        typedData.domain,
        sanitizedTypes,
        typedData.message,
        signature,
      )
      return recovered.toLowerCase() === expectedSigner.toLowerCase()
    } catch {
      return false
    }
  }

  /**
   * Calculates required collateral and protocol fee for prediction order.
   */
  async getQuote(params: DAppQuoteRequest): Promise<DAppQuoteResponse> {
    const amount =
      typeof params.inputAmount === 'bigint'
        ? params.inputAmount
        : BigInt(params.inputAmount)

    if (amount <= 0n) {
      throw new RangeError('inputAmount must be greater than zero')
    }

    // Default price is 50% (0.50 USDC = 500_000 micro-units or 5_000 bps)
    const price = BigInt(
      (params.extra?.price as number | string | bigint | undefined) ?? 500_000,
    )
    const priceDenominator = BigInt(
      (params.extra?.priceDenominator as
        | number
        | string
        | bigint
        | undefined) ?? 1_000_000,
    )

    // Required collateral = (amount * price) / priceDenominator
    const collateral = (amount * price) / priceDenominator
    const feeBps = params.feeBps ?? this.defaultFeeBps
    const feeAmount =
      (collateral * BigInt(Math.round(feeBps * 100))) / 1_000_000n

    return {
      pluginId: this.id,
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      inputAmount: amount,
      expectedOutputAmount: collateral,
      minOutputAmount: collateral,
      feeAmount,
      feeBps,
      feeRecipient:
        (params.extra?.verifyingContract as string | undefined) ??
        this.defaultDomain.verifyingContract,
      metadata: {
        price: price.toString(),
        priceDenominator: priceDenominator.toString(),
        collateral: collateral.toString(),
      },
    }
  }

  /**
   * Builds the EIP-712 prepared transaction structure for signing and submission.
   */
  async buildTransaction(
    params: DAppBuildTxRequest,
  ): Promise<DAppPreparedTransaction> {
    const domain: EIP712Domain = {
      ...this.defaultDomain,
      ...(params.chainId ? { chainId: Number(params.chainId) } : {}),
    }

    const marketId = normalizeMarketId(
      (params.extra?.marketId as string | undefined) ??
        'default-prediction-market',
    )
    const outcomeIndex = Number(params.extra?.outcomeIndex ?? 1)
    const price = BigInt((params.extra?.price as number | bigint) ?? 500_000)
    const expiration = Number(
      params.deadline ??
        params.extra?.expiration ??
        Math.floor(Date.now() / 1000) + 86400 * 7,
    ) // 7 days default
    const salt = BigInt(
      (params.extra?.salt as number | string | bigint | undefined) ??
        Date.now(),
    )

    const order: PredictionOrder = {
      marketId,
      outcomeIndex,
      amount: params.quote.inputAmount,
      price,
      expiration,
      salt,
      maker: params.userAddress,
    }

    const typedData = this.buildOrderTypedData(order, domain)

    return {
      pluginId: this.id,
      chainType: this.chainType,
      recipient: params.destinationAddress ?? params.userAddress,
      to: domain.verifyingContract,
      chainId: typeof domain.chainId === 'number' ? domain.chainId : undefined,
      typedData,
      metadata: {
        order,
        orderHash: this.hashOrder(order, domain),
        verifyingContract: domain.verifyingContract,
      },
    }
  }
}
