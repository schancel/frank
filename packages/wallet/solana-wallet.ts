import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'
import { install as installEd25519Polyfill } from '@solana/webcrypto-ed25519-polyfill'

import {
  SubmittedWalletTransaction,
  StealthTransactionBundleCapability,
  SubmitTransactionBundleOptions,
  TransactionBundleSubmissionError,
  TransactionBundleCapability,
  WalletBundleSubmission,
  WalletTransaction,
  WalletTransactionBundle,
} from './transaction-bundle-wallet'
import type {
  AccountHygieneEngine,
  AccountHygieneOptions,
} from './account-hygiene'
import {
  ChainAddress,
  ChainTransaction,
  defaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  NativeWalletHandle,
  runNativeTransactionExclusive,
  sameChainTransaction,
} from './chain/chain-wallet'
import { SolanaStealthKeyring } from './solana-stealth'
import {
  Ed25519DerivedAccount,
  SolanaChangeKeyring,
  SolanaHdKeyring,
} from './ed25519-hd-keyring'
import { SolanaAccountHygieneEngine } from './solana-account-hygiene'
import type { ChainUtxoPool, ChainUtxoCoin } from './chain-utxo-pool'
import {
  createSolanaLegacySender,
  type PreparedLegacyTransaction,
  type SolanaLegacyJournal,
  type SolanaLegacySync,
  type SolanaSwapIntent,
  type SolanaSwapOutcome,
  type SolanaSwapRecord,
  type SolanaSwapSender,
} from './solana-swap/execute'

/**
 * Minimum transfer amount for a Solana stealth address.
 * 890,880 lamports (0.00089088 SOL) is the standard rent-exemption minimum
 * required for an empty (0 byte) account in Solana runtime.
 */
export const SOLANA_MIN_STEALTH_LAMPORTS = 890_880n

// Capacitor still targets pre-iOS-17 WebViews, which lack native WebCrypto Ed25519. Probe once so
// modern runtimes stay entirely native and older secure WebViews receive the upstream polyfill.
let ed25519Ready: Promise<void> | undefined

function ensureEd25519Support(): Promise<void> {
  ed25519Ready ??= (async () => {
    try {
      const runtimeCrypto = (
        globalThis as unknown as {
          crypto?: {
            subtle: {
              generateKey(
                algorithm: { name: string },
                extractable: boolean,
                usages: string[],
              ): Promise<unknown>
            }
          }
        }
      ).crypto
      if (runtimeCrypto === undefined) throw new Error('WebCrypto unavailable')
      await runtimeCrypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
      ])
    } catch {
      installEd25519Polyfill()
    }
  })()
  return ed25519Ready
}

/** The small RPC boundary needed by this wallet. A real web3.js Connection satisfies it. */
export interface SolanaWalletConnection {
  getGenesisHash(): Promise<string>
  getSignatureStatus(
    signature: string,
    config?: { searchTransactionHistory: boolean },
  ): Promise<{
    value: {
      err: unknown
      confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null
    } | null
  }>
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
  /**
   * Durable 32-byte payment-operation id used for reconciliation. Rebuilding can change txids
   * when the blockhash changes; never resend an accepted index or reuse this id for a new intent.
   */
  intentId: Uint8Array
  transfers: ReadonlyArray<SolanaTransfer>
  signer?: Keypair
  fromAddress?: string
}

export interface SolanaStealthDestination<TMetadata> {
  address: PublicKey
  /** Scheme-owned public data needed by a recipient to discover/spend the payment. */
  metadata: TMetadata
}

/**
 * Deliberately injected: ticket #385 requires the ed25519 stealth construction to be specified
 * and independently reviewed. SolanaStealthWallet can process that construction without
 * pretending a naive public-key tweak is safe.
 */
export interface SolanaStealthAddressStrategy<TMetadata> {
  createDestination(params: {
    recipient: PublicKey
    paymentIndex: number
    context: Uint8Array
  }): Promise<SolanaStealthDestination<TMetadata>>
}

export interface BuildSolanaStealthTransactionBundleParams {
  /**
   * Durable 32-byte payment-operation id used for reconciliation. Rebuilding can change txids
   * when the blockhash changes; never resend an accepted index or reuse this id for a new intent.
   */
  intentId: Uint8Array
  recipient: PublicKey | string
  lamports: ReadonlyArray<bigint>
  /** Domain-separated message/payment context consumed by the reviewed strategy. */
  context: Uint8Array
}

export interface SolanaStealthTransactionMetadata<TMetadata> {
  stealth: TMetadata
}

export type SolanaTransactionBundle<TMetadata = never> =
  WalletTransactionBundle<string, Uint8Array, TMetadata> & {
    /** Retained so an expired bundle can be refreshed without re-deriving stealth destinations. */
    readonly intentId: Uint8Array
  }

const base58Decoder = getBase58Decoder()
const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
)
const PAYMENT_INTENT_PREFIX_TEXT = 'frank:solana-payment:v1:'
const PAYMENT_INTENT_PREFIX = new TextEncoder().encode(
  PAYMENT_INTENT_PREFIX_TEXT,
)
const PAYMENT_INTENT_ID_LENGTH = 32
const PAYMENT_PLAN_COMMITMENT_LENGTH = 32
const PAYMENT_INTENT_INDEX_LENGTH = 8
const PAYMENT_INTENT_DATA_LENGTH =
  PAYMENT_INTENT_PREFIX.length +
  PAYMENT_INTENT_ID_LENGTH * 2 +
  1 +
  PAYMENT_PLAN_COMMITMENT_LENGTH * 2 +
  1 +
  PAYMENT_INTENT_INDEX_LENGTH
const MAX_U64 = (1n << 64n) - 1n
const PAYMENT_PLAN_DOMAIN = new TextEncoder().encode(
  'frank:solana-payment-plan:v1:',
)

function bytesKey(bytes: Uint8Array): string {
  let key = ''
  for (const byte of bytes) key += byte.toString(16).padStart(2, '0')
  return key
}

function parsePublicKey(value: PublicKey | string): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value)
}

function assertTransfers(transfers: ReadonlyArray<SolanaTransfer>): void {
  if (transfers.length === 0) {
    throw new RangeError(
      'a transaction bundle must contain at least one transfer',
    )
  }
  for (const [index, transfer] of transfers.entries()) {
    if (transfer.lamports <= 0n) {
      throw new RangeError(`transfer ${index} must contain positive lamports`)
    }
    if (transfer.lamports > MAX_U64) {
      throw new RangeError(
        `transfer ${index} exceeds Solana's u64 lamport limit`,
      )
    }
  }
}

function assertIntentId(intentId: Uint8Array): void {
  if (intentId.length !== PAYMENT_INTENT_ID_LENGTH) {
    throw new RangeError(
      `Solana payment intent id must be ${PAYMENT_INTENT_ID_LENGTH} bytes`,
    )
  }
}

function paymentIntentData(
  intentId: Uint8Array,
  planCommitment: Uint8Array,
  paymentIndex: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${PAYMENT_INTENT_PREFIX_TEXT}${bytesKey(intentId)}:${bytesKey(
      planCommitment,
    )}:${paymentIndex.toString(16).padStart(PAYMENT_INTENT_INDEX_LENGTH, '0')}`,
  )
}

function intentInstruction(
  intentId: Uint8Array,
  planCommitment: Uint8Array,
  paymentIndex: number,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: paymentIntentData(intentId, planCommitment, paymentIndex),
  })
}

async function paymentPlanCommitment(
  transfers: ReadonlyArray<{ destination: PublicKey; lamports: bigint }>,
): Promise<Uint8Array> {
  const encoded = new Uint8Array(
    PAYMENT_PLAN_DOMAIN.length + 4 + transfers.length * 40,
  )
  encoded.set(PAYMENT_PLAN_DOMAIN)
  const view = new DataView(encoded.buffer)
  view.setUint32(PAYMENT_PLAN_DOMAIN.length, transfers.length, false)
  transfers.forEach((transfer, index) => {
    const offset = PAYMENT_PLAN_DOMAIN.length + 4 + index * 40
    encoded.set(transfer.destination.toBytes(), offset)
    view.setBigUint64(offset + 32, transfer.lamports, false)
  })
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: {
        subtle: {
          digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
        }
      }
    }
  ).crypto
  if (runtimeCrypto === undefined) throw new Error('WebCrypto unavailable')
  return new Uint8Array(await runtimeCrypto.subtle.digest('SHA-256', encoded))
}

function randomIntentId(): Uint8Array {
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: { getRandomValues<T extends Uint8Array>(bytes: T): T }
    }
  ).crypto
  if (runtimeCrypto === undefined) throw new Error('WebCrypto unavailable')
  return runtimeCrypto.getRandomValues(new Uint8Array(PAYMENT_INTENT_ID_LENGTH))
}

/**
 * An in-memory native-SOL wallet with ordered transaction-set support.
 *
 * Each requested payment is signed as its own v0 transaction. This preserves the existing
 * wallet's transaction-set semantics and gives every stealth payment an independently observable
 * destination. Submission is ordered and reports the accepted prefix if an RPC call fails.
 */
export class SolanaWallet
  implements
    NativeWalletHandle,
    TransactionBundleCapability<
      string,
      Uint8Array,
      BuildSolanaTransactionBundleParams,
      never
    >
{
  readonly family = 'solana' as const
  readonly chainIdentifier: string
  readonly networkId: string
  readonly stealthKeyring: SolanaStealthKeyring
  readonly hygiene?: AccountHygieneEngine<string>
  readonly hdKeyring?: SolanaHdKeyring
  readonly changeKeyring?: SolanaChangeKeyring
  readonly chainUtxoPool?: ChainUtxoPool
  private lastSubmittedNative: ChainTransaction | undefined
  private unresolvedNative:
    | {
        bundle?: SolanaTransactionBundle
        error: NativeTransactionSubmissionError
      }
    | undefined
  readonly connection: SolanaWalletConnection
  protected readonly signer: Keypair
  private readonly nativeAttemptStore: NativeTransactionAttemptStore
  private readonly getTransactionStatus: (
    transaction: ChainTransaction,
  ) => Promise<'confirmed' | 'failed' | 'pending' | 'unknown'>
  private readonly nativeAttemptKey: string
  private networkVerification: Promise<void> | undefined
  private readonly expectedGenesisHash: string
  private readonly legacy:
    | { journal: SolanaLegacyJournal; onSync?: SolanaLegacySync }
    | undefined

  constructor(params: {
    connection: SolanaWalletConnection
    signer: Keypair
    chainIdentifier?: string
    networkId: string
    /** Expected RPC genesis hash. Every operation waits for this identity check. */
    genesisHash: string
    nativeAttemptStore?: NativeTransactionAttemptStore
    getTransactionStatus?: (
      transaction: ChainTransaction,
    ) => Promise<'confirmed' | 'failed' | 'pending' | 'unknown'>
    stealthKeyring?: SolanaStealthKeyring
    hygiene?: AccountHygieneEngine<string>
    hdKeyring?: SolanaHdKeyring
    changeKeyring?: SolanaChangeKeyring
    chainUtxoPool?: ChainUtxoPool
    /**
     * Where this wallet journals the legacy transactions it signs (calls to a program, such
     * as a swap), and its sync event for them. Without a journal the wallet refuses to send one.
     */
    legacy?: { journal: SolanaLegacyJournal; onSync?: SolanaLegacySync }
  }) {
    this.legacy = params.legacy
    this.connection = params.connection
    this.signer = params.signer
    this.chainIdentifier = params.chainIdentifier ?? params.genesisHash
    this.networkId = params.networkId
    this.expectedGenesisHash = params.genesisHash
    this.stealthKeyring = params.stealthKeyring ?? new SolanaStealthKeyring()
    this.hygiene = params.hygiene
    this.hdKeyring = params.hdKeyring
    this.changeKeyring = params.changeKeyring
    this.chainUtxoPool = params.chainUtxoPool
    this.nativeAttemptStore =
      params.nativeAttemptStore ?? defaultNativeTransactionAttemptStore
    this.getTransactionStatus =
      params.getTransactionStatus ??
      (async transaction => {
        const response = await this.connection.getSignatureStatus(
          transaction.txHash,
          { searchTransactionHistory: true },
        )
        if (response.value === null) return 'unknown'
        if (response.value.err !== null) return 'failed'
        return response.value.confirmationStatus === 'confirmed' ||
          response.value.confirmationStatus === 'finalized'
          ? 'confirmed'
          : 'pending'
      })
    this.nativeAttemptKey = nativeTransactionAttemptKey({
      family: 'solana',
      chainIdentifier: this.chainIdentifier,
      address: this.address,
    })
    const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey)
    if (persisted !== undefined) {
      this.unresolvedNative = {
        error: new NativeTransactionSubmissionError({
          transaction: persisted,
          reason: new Error('Recovered unresolved native transaction'),
        }),
      }
    }
  }

  static async generate(params: {
    connection: SolanaWalletConnection
    chainIdentifier?: string
    networkId: string
    /** Independently configured expected genesis hash. */
    genesisHash: string
    nativeAttemptStore?: NativeTransactionAttemptStore
    stealthKeyring?: SolanaStealthKeyring
  }): Promise<SolanaWallet> {
    await ensureEd25519Support()
    return new SolanaWallet({
      ...params,
      signer: await Keypair.generate(),
    })
  }

  static async fromSeed(params: {
    connection: SolanaWalletConnection
    chainIdentifier?: string
    networkId: string
    /** Independently configured expected genesis hash. */
    genesisHash: string
    seed: Uint8Array
    nativeAttemptStore?: NativeTransactionAttemptStore
    stealthKeyring?: SolanaStealthKeyring
    hdKeyring?: SolanaHdKeyring
    changeKeyring?: SolanaChangeKeyring
    hygiene?: AccountHygieneEngine<string>
    legacy?: { journal: SolanaLegacyJournal; onSync?: SolanaLegacySync }
  }): Promise<SolanaWallet> {
    const stableSeed = params.seed.slice()
    await ensureEd25519Support()
    return new SolanaWallet({
      legacy: params.legacy,
      connection: params.connection,
      signer: await Keypair.fromSeed(stableSeed),
      chainIdentifier: params.chainIdentifier,
      networkId: params.networkId,
      genesisHash: params.genesisHash,
      nativeAttemptStore: params.nativeAttemptStore,
      stealthKeyring: params.stealthKeyring,
      hdKeyring: params.hdKeyring,
      changeKeyring: params.changeKeyring,
      hygiene: params.hygiene,
    })
  }

  /**
   * Initializes a deterministic Solana wallet from a BIP-39 mnemonic phrase.
   * Derives primary signer from m/44'/501'/0'/0'/0' and sets up deterministic
   * SolanaHdKeyring and SolanaChangeKeyring for sub-account rotation and hygiene.
   */
  static async fromMnemonic(params: {
    connection: SolanaWalletConnection
    mnemonic: string
    passphrase?: string
    chainIdentifier?: string
    networkId: string
    genesisHash: string
    nativeAttemptStore?: NativeTransactionAttemptStore
    stealthKeyring?: SolanaStealthKeyring
    enableHygiene?: boolean
    hygieneOptions?: AccountHygieneOptions
  }): Promise<SolanaWallet> {
    await ensureEd25519Support()
    const hdKeyring = await SolanaHdKeyring.fromMnemonic(
      params.mnemonic,
      params.passphrase,
    )
    const changeKeyring = await SolanaChangeKeyring.fromMnemonic(
      params.mnemonic,
      params.passphrase,
    )
    const primaryAccount = await hdKeyring.deriveSubAccount(0)

    const hygiene =
      params.enableHygiene !== false
        ? new SolanaAccountHygieneEngine({
            connection: params.connection,
            hdKeyring,
            changeKeyring,
            options: params.hygieneOptions,
          })
        : undefined

    return new SolanaWallet({
      connection: params.connection,
      signer: primaryAccount.keypair,
      chainIdentifier: params.chainIdentifier,
      networkId: params.networkId,
      genesisHash: params.genesisHash,
      nativeAttemptStore: params.nativeAttemptStore,
      stealthKeyring: params.stealthKeyring,
      hdKeyring,
      changeKeyring,
      hygiene,
    })
  }

  /** Deterministically derives a sub-account at m/44'/501'/0'/0'/index'. */
  async deriveSubAccount(index: number): Promise<Ed25519DerivedAccount> {
    if (!this.hdKeyring) {
      throw new Error('SolanaWallet was not initialized with an HD keyring')
    }
    return this.hdKeyring.deriveSubAccount(index)
  }

  /** Deterministically derives a change account at m/44'/501'/0'/1'/index'. */
  async deriveChangeAccount(index: number): Promise<Ed25519DerivedAccount> {
    if (!this.changeKeyring) {
      throw new Error('SolanaWallet was not initialized with a change keyring')
    }
    return this.changeKeyring.deriveChangeAccount(index)
  }

  get spendSeed(): Uint8Array {
    return this.signer.secretKey.slice(0, 32)
  }

  get signerKeypair(): Keypair {
    return this.signer
  }

  get address(): string {
    return this.signer.publicKey.toBase58()
  }

  get identity(): NativeWalletHandle['identity'] {
    return {
      address: { raw: this.address },
      displayAddress: this.address,
    }
  }

  getChainUtxoPool(): ChainUtxoPool | undefined {
    return this.chainUtxoPool
  }

  registerInUtxoPool(pool?: ChainUtxoPool, balanceWei: bigint = 0n): ChainUtxoCoin {
    const targetPool = pool ?? this.chainUtxoPool
    if (!targetPool) {
      throw new Error('No ChainUtxoPool provided or attached to SolanaWallet')
    }
    const secretHex = Buffer.from(this.signer.secretKey).toString('hex')
    return targetPool.solana.registerAccount({
      chain: this.chainIdentifier,
      address: this.address,
      privateKey: secretHex,
      balanceWei,
      origin: 'main',
      label: 'Solana Primary Signer',
    })
  }

  registerStealthInUtxoPool(
    params: {
      address: string
      privateKey: string
      balanceWei: bigint
      ephemeralPubKey?: string
      label?: string
    },
    pool?: ChainUtxoPool,
  ): ChainUtxoCoin {
    const targetPool = pool ?? this.chainUtxoPool
    if (!targetPool) {
      throw new Error('No ChainUtxoPool provided or attached to SolanaWallet')
    }
    return targetPool.solana.registerStealthAccount({
      chain: this.chainIdentifier,
      address: params.address,
      privateKey: params.privateKey,
      balanceWei: params.balanceWei,
      ephemeralPubKey: params.ephemeralPubKey,
      label: params.label,
    })
  }

  async getReceiveAddress(): Promise<ChainAddress> {
    return this.identity.address
  }

  protected verifyNetwork(): Promise<void> {
    if (this.networkVerification === undefined) {
      const verification = this.connection
        .getGenesisHash()
        .then(actualGenesisHash => {
          if (actualGenesisHash !== this.expectedGenesisHash) {
            throw new Error(
              `Solana RPC genesis mismatch: expected ${this.expectedGenesisHash}, got ${actualGenesisHash}`,
            )
          }
        })
      this.networkVerification = verification
      void verification.catch(() => {
        if (this.networkVerification === verification) {
          this.networkVerification = undefined
        }
      })
    }
    return this.networkVerification
  }

  async getBalance(): Promise<bigint> {
    await this.verifyNetwork()
    const primary = BigInt(
      await this.connection.getBalance(this.signer.publicKey),
    )
    const stealth = await this.stealthKeyring.getTotalBalance(
      this.connection,
      this.networkId,
    )
    return primary + stealth
  }

  async getPrimaryBalance(): Promise<bigint> {
    await this.verifyNetwork()
    return BigInt(await this.connection.getBalance(this.signer.publicKey))
  }

  /**
   * Signs a prepared swap transaction with this wallet's key. The transaction must be paid for
   * by this wallet and need no other signature, so a transaction built elsewhere (a swap
   * aggregator's) cannot make the wallet sign on anyone else's behalf.
   */
  async signSwapTransaction(
    transaction: VersionedTransaction,
    lastValidBlockHeight: bigint,
  ): Promise<{ signature: string; rawTransaction: Uint8Array }> {
    await this.verifyNetwork()
    const { header, staticAccountKeys } = transaction.message
    if (
      header.numRequiredSignatures !== 1 ||
      !staticAccountKeys[0]?.equals(this.signer.publicKey)
    ) {
      throw new Error('Swap transaction is not paid and signed by this wallet alone')
    }
    await transaction.sign([this.signer], { lastValidBlockHeight })
    return {
      signature: base58Decoder.decode(transaction.signatures[0]),
      rawTransaction: transaction.serialize(),
    }
  }

  /**
   * The wallet's legacy send, for a transaction that calls a program rather than paying another
   * Frank user. Takes the transaction and the record of what it is for; checks it once more,
   * signs it, journals the signed bytes with the record BEFORE broadcasting, sends, and follows
   * it to its outcome. When the chain has finalised it, the wallet's sync event carries the
   * record to the account's other frontends.
   */
  async sendLegacyTransaction(
    prepared: PreparedLegacyTransaction,
    intent: SolanaSwapIntent,
    onSubmitted?: (record: SolanaSwapRecord) => void,
  ): Promise<SolanaSwapOutcome> {
    if (!this.legacy) {
      throw new Error('This wallet has no journal for legacy transactions')
    }
    return createSolanaLegacySender({
      // A real Connection has these calls; the wallet's own type lists only what sends need.
      connection: this.connection as unknown as SolanaSwapSender,
      signer: async () => this,
      journal: this.legacy.journal,
      track: { onSync: this.legacy.onSync },
    }).sendLegacyTransaction(prepared, intent, onSubmitted)
  }

  getUnresolvedNativeTransaction(): ChainTransaction | undefined {
    return this.unresolvedNative?.error.transaction
  }

  async retryUnresolvedNativeTransaction(): Promise<ChainTransaction> {
    await this.verifyNetwork()
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      async () => {
        const unresolved = this.unresolvedNative
        if (unresolved === undefined) {
          throw new Error('No unresolved native transaction to retry')
        }
        if (unresolved.bundle === undefined) {
          throw new Error(
            'Recovered unresolved transaction must be reconciled by id before sending again',
          )
        }
        const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey)
        if (
          persisted === undefined ||
          !sameChainTransaction(persisted, unresolved.error.transaction)
        ) {
          this.unresolvedNative =
            persisted === undefined
              ? undefined
              : {
                  error: new NativeTransactionSubmissionError({
                    transaction: persisted,
                    reason: new Error(
                      'Recovered unresolved native transaction',
                    ),
                  }),
                }
          throw new Error('Unresolved native transaction changed before retry')
        }
        return this.submitNativeBundle(unresolved.bundle)
      },
    )
  }

  async resolveUnresolvedNativeTransaction(params: {
    transaction: ChainTransaction
    outcome: 'submitted' | 'not-submitted'
  }): Promise<void> {
    await this.verifyNetwork()
    await runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      async () => {
        const expected =
          this.unresolvedNative?.error.transaction ?? this.lastSubmittedNative
        const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey)
        if (
          expected === undefined ||
          !sameChainTransaction(expected, params.transaction) ||
          persisted === undefined ||
          !sameChainTransaction(persisted, params.transaction)
        ) {
          throw new Error(
            'Transaction does not match the unresolved native attempt',
          )
        }
        this.nativeAttemptStore.delete(this.nativeAttemptKey)
        this.unresolvedNative = undefined
        this.lastSubmittedNative = undefined
      },
    )
  }

  async sendNative(params: {
    recipient: ChainAddress
    value: bigint
    onSigned?: (signed: ChainTransaction) => Promise<void>
    fromAddress?: string
  }): Promise<ChainTransaction> {
    await this.verifyNetwork()
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      async () => {
        const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey)
        if (persisted === undefined) {
          this.unresolvedNative = undefined
        } else if (
          persisted !== undefined &&
          (this.lastSubmittedNative === undefined ||
            !sameChainTransaction(persisted, this.lastSubmittedNative)) &&
          (this.unresolvedNative === undefined ||
            this.unresolvedNative.bundle === undefined ||
            !sameChainTransaction(
              persisted,
              this.unresolvedNative.error.transaction,
            ))
        ) {
          const status = await this.getTransactionStatus(persisted)
          if (status === 'confirmed' || status === 'failed') {
            this.nativeAttemptStore.delete(this.nativeAttemptKey)
            this.unresolvedNative = undefined
          } else {
            this.unresolvedNative ??= {
              error: new NativeTransactionSubmissionError({
                transaction: persisted,
                reason: new Error('Recovered unresolved native transaction'),
              }),
            }
          }
        }
        if (this.unresolvedNative !== undefined) {
          throw this.unresolvedNative.error
        }
        let activeSigner = this.signer
        let spendingStealthAddress: string | undefined
        if (params.fromAddress) {
          if (params.fromAddress === this.address) {
            activeSigner = this.signer
          } else {
            const acc = this.stealthKeyring.getAccount(params.fromAddress)
            if (!acc) {
              throw new Error(
                `Account ${params.fromAddress} not found in wallet`,
              )
            }
            activeSigner = acc.keypair
            spendingStealthAddress = acc.address
          }
        } else {
          try {
            const primaryBal = BigInt(
              await this.connection.getBalance(this.signer.publicKey),
            )
            if (primaryBal < params.value) {
              const selected = await this.stealthKeyring.selectAccountForSpend(
                params.value,
                this.connection,
                this.networkId,
              )
              if (selected) {
                activeSigner = selected.keypair
                spendingStealthAddress = selected.address
              }
            }
          } catch {
            // fallback to primary signer
          }
        }
        const bundle = await this.buildTransactionBundle({
          intentId: randomIntentId(),
          transfers: [
            { destination: params.recipient.raw, lamports: params.value },
          ],
          signer: activeSigner,
        })
        const submitted = await this.submitNativeBundle(
          bundle,
          params.onSigned,
          activeSigner,
        )
        if (spendingStealthAddress) {
          await this.stealthKeyring.recordSpend(spendingStealthAddress, {
            valueLamports: params.value,
            txHash: submitted.txHash,
          })
        }
        return submitted
      },
    )
  }

  private async submitNativeBundle(
    bundle: SolanaTransactionBundle,
    onSigned?: (signed: ChainTransaction) => Promise<void>,
    signerOverride?: Keypair,
  ): Promise<ChainTransaction> {
    const validated = await this.validateBundle(bundle)
    const txHash = validated.canonicalTransactions[0]?.txId
    if (txHash === undefined) {
      throw new Error('Native transaction bundle is empty')
    }
    if (onSigned !== undefined) await onSigned({ txHash })
    const pendingError = new NativeTransactionSubmissionError({
      transaction: { txHash },
      reason: new Error('Native transaction submission is in progress'),
    })
    const attemptKey =
      signerOverride && !signerOverride.publicKey.equals(this.signer.publicKey)
        ? nativeTransactionAttemptKey({
            family: 'solana',
            chainIdentifier: this.chainIdentifier,
            address: signerOverride.publicKey.toBase58(),
          })
        : this.nativeAttemptKey
    this.nativeAttemptStore.put(attemptKey, pendingError.transaction)
    this.unresolvedNative = { bundle, error: pendingError }
    try {
      const result = await this.submitTransactionBundle(bundle)
      const submitted = { txHash: result.submitted[0].txId }
      this.lastSubmittedNative = submitted
      this.unresolvedNative = undefined
      if (this.hygiene) {
        const activeSigner = signerOverride ?? this.signer
        this.hygiene.markDirty(
          activeSigner.publicKey.toBase58(),
          'transaction-signed',
          { txHash: submitted.txHash },
        )
      }
      return submitted
    } catch (reason) {
      if (reason instanceof TransactionBundleSubmissionError) {
        const error = new NativeTransactionSubmissionError({
          transaction: { txHash: reason.attempted.txId },
          reason,
        })
        this.unresolvedNative = { bundle, error }
        throw error
      }
      throw reason
    }
  }

  async buildTransactionBundle(
    params: BuildSolanaTransactionBundleParams,
  ): Promise<SolanaTransactionBundle> {
    const stableTransfers = params.transfers.map(transfer => ({
      destination: transfer.destination,
      lamports: transfer.lamports,
    }))
    const stableIntentId = params.intentId.slice()
    await this.verifyNetwork()
    let signer = params.signer
    if (!signer && params.fromAddress) {
      if (params.fromAddress === this.address) {
        signer = this.signer
      } else {
        const account = this.stealthKeyring.getAccount(params.fromAddress)
        if (!account) {
          throw new Error(`Account ${params.fromAddress} not found in wallet`)
        }
        signer = account.keypair
      }
    }
    return this.buildSignedBundle(
      stableTransfers,
      stableIntentId,
      undefined,
      signer,
    )
  }

  async submitTransactionBundle<TMetadata = never>(
    bundle: WalletTransactionBundle<string, Uint8Array, TMetadata>,
    options: SubmitTransactionBundleOptions = {},
  ): Promise<WalletBundleSubmission<string>> {
    await this.verifyNetwork()
    const startIndex = options.startIndex ?? 0
    if (
      !Number.isSafeInteger(startIndex) ||
      startIndex < 0 ||
      startIndex > bundle.transactions.length
    ) {
      throw new RangeError('bundle start index is out of range')
    }
    if (startIndex > 0 && options.expectedBundleId === undefined) {
      throw new Error('resuming a bundle requires its reconciled bundle id')
    }
    const { snapshots, canonicalTransactions, canonicalBundleId } =
      await this.validateBundle(bundle)
    if (startIndex > 0 && options.expectedBundleId !== canonicalBundleId) {
      throw new Error(
        'resumed bundle does not match the reconciled payment plan',
      )
    }
    const submitted: SubmittedWalletTransaction<string>[] = []
    for (
      let position = startIndex;
      position < snapshots.length;
      position += 1
    ) {
      const transaction = snapshots[position]
      try {
        const canonical = canonicalTransactions[position]
        const rpcTxId = await this.connection.sendRawTransaction(
          transaction.rawTransaction.slice(),
        )
        if (rpcTxId !== canonical.txId) {
          throw new Error(
            `RPC returned transaction id ${rpcTxId}, expected ${canonical.txId}`,
          )
        }
        submitted.push({
          index: position,
          destination: canonical.destination,
          value: canonical.value,
          txId: canonical.txId,
        })
      } catch (reason) {
        throw new TransactionBundleSubmissionError({
          submitted,
          attempted: {
            index: position,
            destination: canonicalTransactions[position].destination,
            value: canonicalTransactions[position].value,
            txId: canonicalTransactions[position].txId,
          },
          reason,
        })
      }
    }
    return { submitted }
  }

  private async validateBundle<TMetadata>(
    bundle: WalletTransactionBundle<string, Uint8Array, TMetadata>,
  ): Promise<{
    snapshots: Array<
      Pick<
        WalletTransaction<string, Uint8Array>,
        'index' | 'destination' | 'value' | 'rawTransaction'
      >
    >
    canonicalTransactions: Array<{
      destination: string
      value: bigint
      messageKey: string
      txId: string
      intentId: string
      planCommitment: string
      recentBlockhash: string
    }>
    bundleIntentId: string
    canonicalBundleId: string
  }> {
    if (
      bundle.source !== this.address &&
      !this.stealthKeyring?.hasAccount(bundle.source)
    ) {
      throw new Error('transaction bundle source does not match wallet')
    }
    if (bundle.transactions.length === 0) {
      throw new RangeError(
        'a transaction bundle must contain at least one transfer',
      )
    }
    const claimedBundleId = bundle.bundleId
    const claimedIntentId =
      'intentId' in bundle && bundle.intentId instanceof Uint8Array
        ? bundle.intentId.slice()
        : undefined
    const snapshots = bundle.transactions.map(transaction => ({
      index: transaction.index,
      destination: transaction.destination,
      value: transaction.value,
      rawTransaction: transaction.rawTransaction.slice(),
    }))
    const transactionMessages = new Set<string>()
    const canonicalTransactions = [] as Array<{
      destination: string
      value: bigint
      messageKey: string
      txId: string
      intentId: string
      planCommitment: string
      recentBlockhash: string
    }>
    for (const [position, transaction] of snapshots.entries()) {
      const canonical = await this.validateTransaction(transaction, position)
      if (transactionMessages.has(canonical.messageKey)) {
        throw new Error('transaction bundle contains duplicate signed messages')
      }
      transactionMessages.add(canonical.messageKey)
      canonicalTransactions.push(canonical)
    }
    const bundleIntentId = canonicalTransactions[0].intentId
    const bundleBlockhash = canonicalTransactions[0].recentBlockhash
    const expectedPlanCommitment = bytesKey(
      await paymentPlanCommitment(
        canonicalTransactions.map(transaction => ({
          destination: new PublicKey(transaction.destination),
          lamports: transaction.value,
        })),
      ),
    )
    const canonicalBundleId = `${bundleIntentId}:${expectedPlanCommitment}`
    if (claimedBundleId !== canonicalBundleId) {
      throw new Error(
        'transaction bundle id does not match its signed payment plan',
      )
    }
    if (
      claimedIntentId !== undefined &&
      bytesKey(claimedIntentId) !== bundleIntentId
    ) {
      throw new Error(
        'transaction bundle intent id does not match signed bytes',
      )
    }
    if (
      canonicalTransactions.some(
        transaction =>
          transaction.intentId !== bundleIntentId ||
          transaction.planCommitment !== expectedPlanCommitment ||
          transaction.recentBlockhash !== bundleBlockhash,
      )
    ) {
      throw new Error(
        'transaction bundle members do not share one signed payment plan and lifetime',
      )
    }
    return {
      snapshots,
      canonicalTransactions,
      bundleIntentId,
      canonicalBundleId,
    }
  }

  protected async buildSignedBundle<TMetadata = never>(
    transfers: ReadonlyArray<SolanaTransfer>,
    intentId: Uint8Array,
    metadata?: ReadonlyArray<TMetadata>,
    signerOverride?: Keypair,
  ): Promise<SolanaTransactionBundle<TMetadata>> {
    assertTransfers(transfers)
    assertIntentId(intentId)
    const activeSigner = signerOverride ?? this.signer
    const stableIntentId = intentId.slice()
    if (metadata !== undefined && metadata.length !== transfers.length) {
      throw new Error('transaction metadata length does not match transfers')
    }
    const stableTransfers = transfers.map(transfer => ({
      destination: parsePublicKey(transfer.destination),
      lamports: transfer.lamports,
    }))
    const stableMetadata = metadata?.slice()
    await ensureEd25519Support()
    const planCommitment = await paymentPlanCommitment(stableTransfers)

    const lifetime = await this.connection.getLatestBlockhash()
    const lastValidBlockHeight = BigInt(lifetime.lastValidBlockHeight)
    const transactions: Array<
      WalletTransaction<string, Uint8Array, TMetadata>
    > = []
    const transactionMessages = new Set<string>()
    for (const [index, transfer] of stableTransfers.entries()) {
      const destination = transfer.destination
      const message = new TransactionMessage({
        payerKey: activeSigner.publicKey,
        recentBlockhash: lifetime.blockhash as ConstructorParameters<
          typeof TransactionMessage
        >[0]['recentBlockhash'],
        instructions: [
          SystemProgram.transfer({
            fromPubkey: activeSigner.publicKey,
            toPubkey: destination,
            lamports: transfer.lamports,
          }),
          intentInstruction(stableIntentId, planCommitment, index),
        ],
      }).compileToV0Message()
      const messageKey = bytesKey(message.serialize())
      if (transactionMessages.has(messageKey)) {
        throw new Error('transaction bundle contains duplicate signed messages')
      }
      transactionMessages.add(messageKey)
      const transaction = new VersionedTransaction(message)
      await transaction.sign([activeSigner], { lastValidBlockHeight })
      const rawTransaction = transaction.serialize()
      transactions.push({
        index,
        destination: destination.toBase58(),
        value: transfer.lamports,
        rawTransaction,
        ...(stableMetadata === undefined
          ? {}
          : { metadata: stableMetadata[index] }),
      } as WalletTransaction<string, Uint8Array, TMetadata>)
    }

    return {
      bundleId: `${bytesKey(stableIntentId)}:${bytesKey(planCommitment)}`,
      intentId: stableIntentId.slice(),
      source: activeSigner.publicKey.toBase58(),
      transactions,
    }
  }

  private async validateTransaction(
    bundled: Pick<
      WalletTransaction<string, Uint8Array>,
      'index' | 'destination' | 'value' | 'rawTransaction'
    >,
    position: number,
  ): Promise<{
    destination: string
    value: bigint
    messageKey: string
    txId: string
    intentId: string
    planCommitment: string
    recentBlockhash: string
  }> {
    if (bundled.index !== position) {
      throw new Error(`transaction index ${bundled.index} is out of order`)
    }
    const transaction = VersionedTransaction.deserialize(bundled.rawTransaction)
    if (transaction.signatures.length !== 1) {
      throw new Error('bundle transaction must have exactly one signature')
    }
    const message = TransactionMessage.decompile(transaction.message)
    const stealthAccount = this.stealthKeyring?.getAccount(
      message.payerKey.toBase58(),
    )
    const expectedSignerPubkey = stealthAccount
      ? stealthAccount.keypair.publicKey
      : this.signer.publicKey

    const signatureIsValid = await expectedSignerPubkey.verifySignature(
      transaction.signatures[0],
      transaction.message.serialize(),
    )
    if (!signatureIsValid) {
      throw new Error('bundle transaction signature is invalid')
    }
    const messageKey = bytesKey(transaction.message.serialize())
    const txId = base58Decoder.decode(transaction.signatures[0])
    if (!message.payerKey.equals(expectedSignerPubkey)) {
      throw new Error('bundle transaction payer does not match wallet')
    }
    if (message.instructions.length !== 2) {
      throw new Error(
        'bundle transaction must contain one transfer and one intent instruction',
      )
    }
    const transfer = SystemInstruction.decodeTransfer(message.instructions[0])
    if (!transfer.fromPubkey.equals(expectedSignerPubkey)) {
      throw new Error('bundle transfer source does not match wallet')
    }
    const destination = transfer.toPubkey.toBase58()
    const value = BigInt(transfer.lamports)
    if (bundled.destination !== destination || bundled.value !== value) {
      throw new Error(
        'bundle transaction description does not match signed bytes',
      )
    }
    const intent = message.instructions[1]
    let intentText: string
    try {
      intentText = new TextDecoder('utf-8', { fatal: true }).decode(intent.data)
    } catch {
      throw new Error('bundle transaction intent instruction is invalid')
    }
    if (
      !intent.programId.equals(MEMO_PROGRAM_ID) ||
      intent.keys.length !== 0 ||
      !bytesKey(intent.data).startsWith(bytesKey(PAYMENT_INTENT_PREFIX)) ||
      intent.data.length !== PAYMENT_INTENT_DATA_LENGTH ||
      !/^frank:solana-payment:v1:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{8}$/.test(
        intentText,
      )
    ) {
      throw new Error('bundle transaction intent instruction is invalid')
    }
    const signedIndex = Number.parseInt(
      intentText.slice(-PAYMENT_INTENT_INDEX_LENGTH),
      16,
    )
    if (signedIndex !== position) {
      throw new Error(`signed payment index ${signedIndex} is out of order`)
    }
    const intentId = intentText.slice(
      PAYMENT_INTENT_PREFIX_TEXT.length,
      PAYMENT_INTENT_PREFIX_TEXT.length + PAYMENT_INTENT_ID_LENGTH * 2,
    )
    const planCommitmentStart =
      PAYMENT_INTENT_PREFIX_TEXT.length + PAYMENT_INTENT_ID_LENGTH * 2 + 1
    const planCommitment = intentText.slice(
      planCommitmentStart,
      planCommitmentStart + PAYMENT_PLAN_COMMITMENT_LENGTH * 2,
    )
    return {
      destination,
      value,
      messageKey,
      txId,
      intentId,
      planCommitment,
      recentBlockhash: transaction.message.recentBlockhash,
    }
  }
}

/** Solana wallet capability available only when a reviewed stealth strategy is supplied. */
export class SolanaStealthWallet<TStealthMetadata extends {}>
  extends SolanaWallet
  implements
    StealthTransactionBundleCapability<
      string,
      Uint8Array,
      BuildSolanaTransactionBundleParams,
      BuildSolanaStealthTransactionBundleParams,
      SolanaStealthTransactionMetadata<TStealthMetadata>
    >
{
  private readonly stealthStrategy: SolanaStealthAddressStrategy<TStealthMetadata>
  private readonly minTransferLamports: bigint

  constructor(params: {
    connection: SolanaWalletConnection
    signer: Keypair
    networkId: string
    genesisHash: string
    stealthStrategy: SolanaStealthAddressStrategy<TStealthMetadata>
    minTransferLamports?: bigint
    stealthKeyring?: SolanaStealthKeyring
  }) {
    super(params)
    this.stealthStrategy = params.stealthStrategy
    this.minTransferLamports =
      params.minTransferLamports ?? SOLANA_MIN_STEALTH_LAMPORTS
  }

  /** Use generateStealth; the inherited base factory cannot supply a stealth strategy. */
  static override async generate(_params: {
    connection: SolanaWalletConnection
    networkId: string
  }): Promise<never> {
    throw new Error('use SolanaStealthWallet.generateStealth with a strategy')
  }

  /** Use fromSeedWithStealth; the inherited base factory cannot supply a stealth strategy. */
  static override async fromSeed(_params: {
    connection: SolanaWalletConnection
    networkId: string
    seed: Uint8Array
  }): Promise<never> {
    throw new Error(
      'use SolanaStealthWallet.fromSeedWithStealth with a strategy',
    )
  }

  static async generateStealth<TStealthMetadata extends {}>(params: {
    connection: SolanaWalletConnection
    networkId: string
    genesisHash: string
    stealthStrategy: SolanaStealthAddressStrategy<TStealthMetadata>
    minTransferLamports?: bigint
    stealthKeyring?: SolanaStealthKeyring
  }): Promise<SolanaStealthWallet<TStealthMetadata>> {
    await ensureEd25519Support()
    return new SolanaStealthWallet({
      ...params,
      signer: await Keypair.generate(),
    })
  }

  static async fromSeedWithStealth<TStealthMetadata extends {}>(params: {
    connection: SolanaWalletConnection
    networkId: string
    genesisHash: string
    seed: Uint8Array
    stealthStrategy: SolanaStealthAddressStrategy<TStealthMetadata>
    minTransferLamports?: bigint
    stealthKeyring?: SolanaStealthKeyring
  }): Promise<SolanaStealthWallet<TStealthMetadata>> {
    const stableSeed = params.seed.slice()
    await ensureEd25519Support()
    return new SolanaStealthWallet({
      connection: params.connection,
      signer: await Keypair.fromSeed(stableSeed),
      networkId: params.networkId,
      genesisHash: params.genesisHash,
      stealthStrategy: params.stealthStrategy,
      minTransferLamports: params.minTransferLamports,
      stealthKeyring: params.stealthKeyring,
    })
  }

  async buildStealthTransactionBundle(
    params: BuildSolanaStealthTransactionBundleParams,
  ): Promise<
    SolanaTransactionBundle<SolanaStealthTransactionMetadata<TStealthMetadata>>
  > {
    const stableLamports = params.lamports.slice()
    const stableIntentId = params.intentId.slice()
    const stableContext = params.context.slice()
    await this.verifyNetwork()
    const recipient = parsePublicKey(params.recipient)
    if (stableLamports.length === 0) {
      throw new RangeError('a stealth bundle must contain at least one payment')
    }
    stableLamports.forEach((lamports, index) => {
      if (lamports <= 0n) {
        throw new RangeError(`transfer ${index} must contain positive lamports`)
      }
      if (lamports > MAX_U64) {
        throw new RangeError(
          `transfer ${index} exceeds Solana's u64 lamport limit`,
        )
      }
    })
    if (this.minTransferLamports > 0n) {
      stableLamports.forEach((lamports, index) => {
        if (lamports < this.minTransferLamports) {
          throw new RangeError(
            `transfer ${index} must be at least ${this.minTransferLamports} lamports (rent exemption dust limit)`,
          )
        }
      })
    }
    assertIntentId(stableIntentId)
    const destinations = await Promise.all(
      stableLamports.map(async (lamports, paymentIndex) => ({
        lamports,
        destination: await this.stealthStrategy.createDestination({
          recipient,
          paymentIndex,
          context: stableContext.slice(),
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
      stableIntentId,
      destinations.map(item => ({ stealth: item.destination.metadata })),
    )
  }
}
