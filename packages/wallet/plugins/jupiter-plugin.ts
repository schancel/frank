/**
 * Jupiter Aggregator DAppPlugin (Ticket #1154).
 *
 * Implements Solana SPL token swaps via Jupiter Aggregator API specs with
 * platform fee sharing (default: 8.75 bps / 0.0875%) and destination ATA setup
 * for a fresh HD change address (SLIP-0010 path m/44'/501'/0'/1'/i').
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import type {
  DAppBuildTxRequest,
  DAppPlugin,
  DAppPluginMetadata,
  DAppPreparedTransaction,
  DAppQuoteRequest,
  DAppQuoteResponse,
} from './types'
import { DEFAULT_PROTOCOL_FEE_BPS } from './types'

export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

export const ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

export const DEFAULT_JUPITER_FEE_ACCOUNT =
  'JUP4FB2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'

export interface SolanaTokenConfig {
  readonly symbol: string
  readonly mint: string
  readonly decimals: number
  readonly priceUsd: number
}

export const KNOWN_SOLANA_TOKENS: Record<string, SolanaTokenConfig> = {
  SOL: {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    priceUsd: 150.0,
  },
  WSOL: {
    symbol: 'WSOL',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    priceUsd: 150.0,
  },
  USDC: {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    priceUsd: 1.0,
  },
  USDT: {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    priceUsd: 1.0,
  },
  JUP: {
    symbol: 'JUP',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    priceUsd: 1.2,
  },
}

/**
 * Derives the Associated Token Account (ATA) PDA for a wallet and SPL token mint.
 */
export async function findAssociatedTokenAddress(
  walletAddress: PublicKey | string,
  tokenMint: PublicKey | string,
  tokenProgramId: PublicKey | string = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey | string = ASSOCIATED_TOKEN_PROGRAM_ID,
): Promise<[PublicKey, number]> {
  const walletPubkey =
    typeof walletAddress === 'string'
      ? new PublicKey(walletAddress)
      : walletAddress
  const mintPubkey =
    typeof tokenMint === 'string' ? new PublicKey(tokenMint) : tokenMint
  const tokenProg =
    typeof tokenProgramId === 'string'
      ? new PublicKey(tokenProgramId)
      : tokenProgramId
  const ataProg =
    typeof associatedTokenProgramId === 'string'
      ? new PublicKey(associatedTokenProgramId)
      : associatedTokenProgramId

  return await PublicKey.findProgramAddress(
    [walletPubkey.toBytes(), tokenProg.toBytes(), mintPubkey.toBytes()],
    ataProg,
  )
}

/**
 * Constructs the instruction to create an Associated Token Account.
 */
export function createAssociatedTokenAccountInstruction(
  payer: PublicKey | string,
  associatedToken: PublicKey | string,
  owner: PublicKey | string,
  mint: PublicKey | string,
  tokenProgramId: PublicKey | string = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey | string = ASSOCIATED_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const payerPubkey = typeof payer === 'string' ? new PublicKey(payer) : payer
  const ataPubkey =
    typeof associatedToken === 'string'
      ? new PublicKey(associatedToken)
      : associatedToken
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint
  const tokenProg =
    typeof tokenProgramId === 'string'
      ? new PublicKey(tokenProgramId)
      : tokenProgramId
  const ataProg =
    typeof associatedTokenProgramId === 'string'
      ? new PublicKey(associatedTokenProgramId)
      : associatedTokenProgramId

  return new TransactionInstruction({
    programId: ataProg,
    keys: [
      { pubkey: payerPubkey, isSigner: true, isWritable: true },
      { pubkey: ataPubkey, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: false, isWritable: false },
      { pubkey: mintPubkey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProg, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  })
}

/**
 * Constructs an SPL token Transfer instruction (opcode 3).
 */
export function buildSplTransferInstruction(params: {
  source: PublicKey | string
  destination: PublicKey | string
  owner: PublicKey | string
  amount: bigint
  tokenProgramId?: PublicKey | string
}): TransactionInstruction {
  const source =
    typeof params.source === 'string'
      ? new PublicKey(params.source)
      : params.source
  const destination =
    typeof params.destination === 'string'
      ? new PublicKey(params.destination)
      : params.destination
  const owner =
    typeof params.owner === 'string'
      ? new PublicKey(params.owner)
      : params.owner
  const tokenProg =
    typeof params.tokenProgramId === 'string'
      ? new PublicKey(params.tokenProgramId)
      : params.tokenProgramId ?? new PublicKey(TOKEN_PROGRAM_ID)

  const data = Buffer.alloc(9)
  data.writeUInt8(3, 0) // SPL Transfer instruction opcode = 3
  data.writeBigUInt64LE(params.amount, 1)

  return new TransactionInstruction({
    programId: tokenProg,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

/**
 * Constructs a Jupiter route swap instruction.
 */
export function buildJupiterSwapInstruction(params: {
  user: PublicKey | string
  destinationTokenAccount: PublicKey | string
  sourceTokenAccount?: PublicKey | string
  inputMint: PublicKey | string
  outputMint: PublicKey | string
  amountIn: bigint
  minAmountOut: bigint
  feeAccount?: PublicKey | string
  jupiterProgramId?: PublicKey | string
}): TransactionInstruction {
  const user =
    typeof params.user === 'string' ? new PublicKey(params.user) : params.user
  const destinationAta =
    typeof params.destinationTokenAccount === 'string'
      ? new PublicKey(params.destinationTokenAccount)
      : params.destinationTokenAccount
  const inputMint =
    typeof params.inputMint === 'string'
      ? new PublicKey(params.inputMint)
      : params.inputMint
  const outputMint =
    typeof params.outputMint === 'string'
      ? new PublicKey(params.outputMint)
      : params.outputMint
  const jupProgram =
    typeof params.jupiterProgramId === 'string'
      ? new PublicKey(params.jupiterProgramId)
      : params.jupiterProgramId ?? new PublicKey(JUPITER_PROGRAM_ID)

  // Jupiter v6 swap instruction data layout:
  // Discriminator (8 bytes) + inAmount (8 bytes) + minOutAmount (8 bytes) + flags (1 byte)
  const data = Buffer.alloc(25)
  data.writeBigUInt64LE(0xe517cb977da34f82n, 0) // Jupiter swap discriminator
  data.writeBigUInt64LE(params.amountIn, 8)
  data.writeBigUInt64LE(params.minAmountOut, 16)
  data.writeUInt8(0, 24)

  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: destinationAta, isSigner: false, isWritable: true },
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    {
      pubkey: new PublicKey(TOKEN_PROGRAM_ID),
      isSigner: false,
      isWritable: false,
    },
  ]

  if (params.feeAccount) {
    const feeAcc =
      typeof params.feeAccount === 'string'
        ? new PublicKey(params.feeAccount)
        : params.feeAccount
    keys.push({ pubkey: feeAcc, isSigner: false, isWritable: true })
  }

  return new TransactionInstruction({
    programId: jupProgram,
    keys,
    data,
  })
}

export class JupiterDAppPlugin implements DAppPlugin {
  readonly id = 'jupiter-aggregator'
  readonly name = 'Jupiter Aggregator'
  readonly chainType = 'solana' as const

  constructor(
    readonly jupiterProgramId: string = JUPITER_PROGRAM_ID,
    readonly defaultFeeAccount: string = DEFAULT_JUPITER_FEE_ACCOUNT,
    readonly defaultFeeBps: number = DEFAULT_PROTOCOL_FEE_BPS,
    private readonly customTokens: Record<string, SolanaTokenConfig> = {},
  ) {}

  getMetadata(): DAppPluginMetadata {
    return {
      id: this.id,
      name: this.name,
      version: '6.0.0',
      description:
        'Jupiter Solana SPL DEX Aggregator with 8.75 bps platform fee sharing and HD change address destination ATA setup',
      chainType: this.chainType,
      icon: 'https://jup.ag/favicon.ico',
    }
  }

  /**
   * Resolves token info from symbol or mint address.
   */
  resolveToken(tokenOrMint: string): SolanaTokenConfig {
    const upper = tokenOrMint.toUpperCase()
    if (this.customTokens[upper]) return this.customTokens[upper]
    if (KNOWN_SOLANA_TOKENS[upper]) return KNOWN_SOLANA_TOKENS[upper]

    for (const token of Object.values({
      ...KNOWN_SOLANA_TOKENS,
      ...this.customTokens,
    })) {
      if (token.mint === tokenOrMint) return token
    }

    return {
      symbol: tokenOrMint,
      mint: tokenOrMint,
      decimals: 6,
      priceUsd: 1.0,
    }
  }

  /**
   * Calculates protocol fee: default 8.75 bps = 0.0875% = 0.000875.
   */
  calculateFeeAmount(amount: bigint, feeBps: number): bigint {
    const scaledBps = BigInt(Math.round(feeBps * 100))
    return (amount * scaledBps) / 1_000_000n
  }

  /**
   * Generates quote following Jupiter API specifications with platform fee sharing.
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
    const feeRecipient = params.feeRecipient ?? this.defaultFeeAccount
    const feeAmount = this.calculateFeeAmount(inputAmount, feeBps)
    const netInputAmount = inputAmount - feeAmount

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
      priceImpact: 0.0004,
      estimatedGas: 45_000n, // ~45k compute units
      route: {
        marketInfos: [
          {
            id: 'orca-whirlpool',
            label: 'Orca Whirlpool',
            inputMint: inToken.mint,
            outputMint: outToken.mint,
            feeBps,
          },
        ],
      },
      rawQuote: {
        inAmount: inputAmount.toString(),
        outAmount: expectedOutputAmount.toString(),
        priceImpactPct: 0.04,
        platformFee: {
          amount: feeAmount.toString(),
          feeBps,
          feeAccount: feeRecipient,
        },
      },
      metadata: {
        inputMint: inToken.mint,
        outputMint: outToken.mint,
        netInputAmount: netInputAmount.toString(),
      },
    }
  }

  /**
   * Builds the Solana transaction instructions with destination ATA setup for a fresh HD change address.
   */
  async buildTransaction(
    params: DAppBuildTxRequest,
  ): Promise<DAppPreparedTransaction> {
    const destinationAddress = params.destinationAddress
    if (!destinationAddress) {
      throw new Error(
        'destinationAddress (fresh HD change address) is required for Jupiter settlement.',
      )
    }

    const quote = params.quote
    const inToken = this.resolveToken(quote.inputToken)
    const outToken = this.resolveToken(quote.outputToken)
    const feeAccount = quote.feeRecipient ?? this.defaultFeeAccount

    // Derive destination ATA for the fresh change address
    const [destinationAta, ataBump] = await findAssociatedTokenAddress(
      destinationAddress,
      outToken.mint,
    )

    // 1. Setup instruction: Create destination ATA for the HD change address
    const createAtaIx = createAssociatedTokenAccountInstruction(
      params.userAddress,
      destinationAta,
      destinationAddress,
      outToken.mint,
    )

    // 2. Swap instruction: Execute Jupiter swap with destination set to destinationAta
    const netInputAmount = quote.inputAmount - quote.feeAmount
    const swapIx = buildJupiterSwapInstruction({
      user: params.userAddress,
      destinationTokenAccount: destinationAta,
      inputMint: inToken.mint,
      outputMint: outToken.mint,
      amountIn: netInputAmount,
      minAmountOut: quote.minOutputAmount,
      feeAccount,
      jupiterProgramId: this.jupiterProgramId,
    })

    const instructions: TransactionInstruction[] = [createAtaIx, swapIx]

    // 3. Fee transfer instruction: If platform fee applies and fee account is configured
    if (quote.feeAmount > 0n && feeAccount) {
      const [sourceUserAta] = await findAssociatedTokenAddress(
        params.userAddress,
        inToken.mint,
      )
      const feeIx = buildSplTransferInstruction({
        source: sourceUserAta,
        destination: feeAccount,
        owner: params.userAddress,
        amount: quote.feeAmount,
      })
      instructions.push(feeIx)
    }

    return {
      pluginId: this.id,
      chainType: this.chainType,
      recipient: destinationAddress,
      instructions,
      metadata: {
        destinationChangeAddress: destinationAddress,
        destinationAta: destinationAta.toBase58(),
        destinationAtaBump: ataBump,
        feeAmount: quote.feeAmount.toString(),
        feeAccount,
        feeBps: quote.feeBps,
        outputMint: outToken.mint,
      },
    }
  }
}
