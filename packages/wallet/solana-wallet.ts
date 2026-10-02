import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import {
  SubmittedWalletTransaction,
  TransactionBundleSubmissionError,
  TransactionBundleWallet,
  WalletBundleSubmission,
  WalletTransaction,
  WalletTransactionBundle,
} from './transaction-bundle-wallet'

/** The small RPC boundary needed by this wallet. A real web3.js Connection satisfies it. */
export interface SolanaWalletConnection {
  getBalance(address: PublicKey): Promise<number | bigint>
  getLatestBlockhash(): Promise<{
    blockhash: string
    lastValidBlockHeight: number | bigint
  }>
  sendRawTransaction(rawTransaction: Uint8Array): Promise<string>
}

export interface SolanaTransfer {
  destination: PublicKey | string
  lamports: bigint
}

export interface BuildSolanaTransactionBundleParams {
  transfers: ReadonlyArray<SolanaTransfer>
}

export interface SolanaStealthDestination<TMetadata> {
  address: PublicKey
  /** Scheme-owned public data needed by a recipient to discover/spend the payment. */
  metadata: TMetadata
}

/**
 * Deliberately injected: ticket #385 requires the ed25519 stealth construction to be specified
 * and independently reviewed. SolanaWallet can process that construction without pretending a
 * naive public-key tweak is safe.
 */
export interface SolanaStealthAddressStrategy<TMetadata> {
  createDestination(params: {
    recipient: PublicKey
    paymentIndex: number
    context: Uint8Array
  }): Promise<SolanaStealthDestination<TMetadata>>
}

export interface BuildSolanaStealthTransactionBundleParams {
  recipient: PublicKey | string
  lamports: ReadonlyArray<bigint>
  /** Domain-separated message/payment context consumed by the reviewed strategy. */
  context: Uint8Array
}

export interface SolanaStealthTransactionMetadata<TMetadata> {
  stealth: TMetadata
}

export interface SolanaTransactionBundle<TMetadata = never>
  extends WalletTransactionBundle<string, Uint8Array, TMetadata> {
  recentBlockhash: string
  lastValidBlockHeight: bigint
}

export class SolanaStealthUnavailableError extends Error {
  constructor() {
    super(
      'Solana stealth transfers require a reviewed SolanaStealthAddressStrategy',
    )
    this.name = 'SolanaStealthUnavailableError'
  }
}

function parsePublicKey(value: PublicKey | string): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value)
}

function assertTransfers(transfers: ReadonlyArray<SolanaTransfer>): void {
  if (transfers.length === 0) {
    throw new RangeError('a transaction bundle must contain at least one transfer')
  }
  for (const [index, transfer] of transfers.entries()) {
    if (transfer.lamports <= 0n) {
      throw new RangeError(`transfer ${index} must contain positive lamports`)
    }
  }
}

/**
 * An in-memory native-SOL wallet with ordered transaction-set support.
 *
 * Each requested payment is signed as its own v0 transaction. This preserves the existing
 * wallet's transaction-set semantics and gives every stealth payment an independently observable
 * destination. Submission is ordered and reports the accepted prefix if an RPC call fails.
 */
export class SolanaWallet<TStealthMetadata = never>
  implements
    TransactionBundleWallet<
      string,
      Uint8Array,
      BuildSolanaTransactionBundleParams,
      BuildSolanaStealthTransactionBundleParams,
      never,
      SolanaStealthTransactionMetadata<TStealthMetadata>
    >
{
  private readonly connection: SolanaWalletConnection
  private readonly signer: Keypair
  private readonly stealthStrategy:
    | SolanaStealthAddressStrategy<TStealthMetadata>
    | undefined

  constructor(params: {
    connection: SolanaWalletConnection
    signer: Keypair
    stealthStrategy?: SolanaStealthAddressStrategy<TStealthMetadata>
  }) {
    this.connection = params.connection
    this.signer = params.signer
    this.stealthStrategy = params.stealthStrategy
  }

  static async generate<TStealthMetadata = never>(params: {
    connection: SolanaWalletConnection
    stealthStrategy?: SolanaStealthAddressStrategy<TStealthMetadata>
  }): Promise<SolanaWallet<TStealthMetadata>> {
    return new SolanaWallet({
      ...params,
      signer: await Keypair.generate(),
    })
  }

  static async fromSeed<TStealthMetadata = never>(params: {
    connection: SolanaWalletConnection
    seed: Uint8Array
    stealthStrategy?: SolanaStealthAddressStrategy<TStealthMetadata>
  }): Promise<SolanaWallet<TStealthMetadata>> {
    return new SolanaWallet({
      connection: params.connection,
      signer: await Keypair.fromSeed(params.seed),
      stealthStrategy: params.stealthStrategy,
    })
  }

  get address(): string {
    return this.signer.publicKey.toBase58()
  }

  async getBalance(): Promise<bigint> {
    return BigInt(await this.connection.getBalance(this.signer.publicKey))
  }

  async buildTransactionBundle(
    params: BuildSolanaTransactionBundleParams,
  ): Promise<SolanaTransactionBundle> {
    return this.buildSignedBundle(params.transfers)
  }

  async buildStealthTransactionBundle(
    params: BuildSolanaStealthTransactionBundleParams,
  ): Promise<
    SolanaTransactionBundle<SolanaStealthTransactionMetadata<TStealthMetadata>>
  > {
    const strategy = this.stealthStrategy
    if (strategy === undefined) {
      throw new SolanaStealthUnavailableError()
    }
    if (params.lamports.length === 0) {
      throw new RangeError('a stealth bundle must contain at least one payment')
    }

    const recipient = parsePublicKey(params.recipient)
    const destinations = await Promise.all(
      params.lamports.map(async (lamports, paymentIndex) => ({
        lamports,
        destination: await strategy.createDestination({
          recipient,
          paymentIndex,
          context: params.context.slice(),
        }),
      })),
    )
    const uniqueAddresses = new Set(
      destinations.map(item => item.destination.address.toBase58()),
    )
    if (uniqueAddresses.size !== destinations.length) {
      throw new Error('stealth strategy returned duplicate destinations')
    }

    return this.buildSignedBundle(
      destinations.map(item => ({
        destination: item.destination.address,
        lamports: item.lamports,
      })),
      destinations.map(item => ({ stealth: item.destination.metadata })),
    )
  }

  async submitTransactionBundle(
    bundle: WalletTransactionBundle<
      string,
      Uint8Array,
      never | SolanaStealthTransactionMetadata<TStealthMetadata>
    >,
  ): Promise<WalletBundleSubmission<string>> {
    const submitted: SubmittedWalletTransaction<string>[] = []
    for (const transaction of bundle.transactions) {
      try {
        const txId = await this.connection.sendRawTransaction(
          transaction.rawTransaction.slice(),
        )
        submitted.push({
          index: transaction.index,
          destination: transaction.destination,
          value: transaction.value,
          txId,
        })
      } catch (reason) {
        throw new TransactionBundleSubmissionError({
          submitted,
          failedIndex: transaction.index,
          reason,
        })
      }
    }
    return { submitted }
  }

  private async buildSignedBundle<TMetadata = never>(
    transfers: ReadonlyArray<SolanaTransfer>,
    metadata?: ReadonlyArray<TMetadata>,
  ): Promise<SolanaTransactionBundle<TMetadata>> {
    assertTransfers(transfers)
    if (metadata !== undefined && metadata.length !== transfers.length) {
      throw new Error('transaction metadata length does not match transfers')
    }

    const lifetime = await this.connection.getLatestBlockhash()
    const lastValidBlockHeight = BigInt(lifetime.lastValidBlockHeight)
    const transactions: Array<
      WalletTransaction<string, Uint8Array, TMetadata>
    > = []
    for (const [index, transfer] of transfers.entries()) {
      const destination = parsePublicKey(transfer.destination)
      const message = new TransactionMessage({
        payerKey: this.signer.publicKey,
        recentBlockhash: lifetime.blockhash as ConstructorParameters<
          typeof TransactionMessage
        >[0]['recentBlockhash'],
        instructions: [
          SystemProgram.transfer({
            fromPubkey: this.signer.publicKey,
            toPubkey: destination,
            lamports: transfer.lamports,
          }),
        ],
      }).compileToV0Message()
      const transaction = new VersionedTransaction(message)
      await transaction.sign([this.signer], { lastValidBlockHeight })
      transactions.push({
        index,
        destination: destination.toBase58(),
        value: transfer.lamports,
        rawTransaction: transaction.serialize(),
        ...(metadata === undefined ? {} : { metadata: metadata[index] }),
      })
    }

    return {
      source: this.address,
      recentBlockhash: lifetime.blockhash,
      lastValidBlockHeight,
      transactions,
    }
  }
}
