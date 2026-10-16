/**
 * Chain-Agnostic UTXO & Account Pool (Issue #1184 & Multi-Chain Expansion).
 *
 * Unifies EVM (Monad/Ethereum), Solana, and UTXO-native (eCash / XEC, Bitcoin) chains
 * across all spendable coin origins:
 * - Pre-derived HD sub-accounts
 * - Derived HD change accounts
 * - Non-HD ephemeral stealth accounts
 * - Imported / main sweep accounts
 * - Native UTXO unspent transaction outputs (txid:vout, satoshis)
 *
 * Core architectural guarantees:
 * 1. Attached Private Keys: Every ChainUtxoCoin directly holds its privateKey hex
 *    or base58 string for instantaneous O(1) signing without secondary keystore queries.
 * 2. Instant In-Memory Selection: Zero-network best-fit and greedy coin selection in O(1) memory time.
 * 3. Decoy Magnitude Pairing & Radix Splits: Change calculations use continuous
 *    geometric radix splitting with entropy jitter and decoy avoidance.
 * 4. Atomic State Advance: When a transaction broadcasts, selected coins are immediately
 *    marked 'pending' to eliminate concurrent send races. Fresh change outputs are registered
 *    as 'clean', and failed sends rollback cleanly.
 * 5. Chain Family Adapters: Dedicated adapters for EVM, Solana, and UTXO families.
 */

import { getAddress, Provider } from 'ethers'
import { PROTOCOL_CHAINS } from './chain/chains-registry'
import {
  Blockhash,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import { getBase58Encoder } from '@solana/codecs-strings'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './evm-account-tx'
import {
  computeGeometricRadixChangeSplits,
  orderOfMagnitude2,
  calculateDecoyJitterDelayMs,
} from './evm-change-distribution'

export { calculateDecoyJitterDelayMs }


export type ChainFamily = 'evm' | 'solana' | 'utxo'

export type ChainUtxoOrigin =
  | 'subaccount'
  | 'change'
  | 'stealth'
  | 'main'
  | 'utxo'

export type ChainUtxoStatus = 'clean' | 'pending' | 'spent'

export interface ChainUtxoOutpoint {
  readonly txid: string
  readonly vout: number
}

export interface ChainUtxoCoin {
  /** Composite key: `${chainIdentifier}:${family}:${address}:${nonceOrOutpoint}` */
  readonly id: string
  readonly chainIdentifier: string
  readonly family: ChainFamily
  readonly address: string
  readonly privateKey: string // attached private key for immediate signing
  balanceWei: bigint // standard base amount (wei, lamports, satoshis)
  nonce?: number // for evm / solana account UTXOs
  outpoint?: { txid: string; vout: number } // for native UTXO family
  status: ChainUtxoStatus
  readonly origin: ChainUtxoOrigin
  lastUpdatedMs: number

  // Optional metadata
  readonly discoveredAt?: number
  label?: string
  readonly derivationPath?: string
  readonly ephemeralPubKey?: string
  readonly txHash?: string
  readonly parentTxHash?: string
  readonly requiresConfirmation?: boolean
  readonly index?: number
}

export interface SelectCoinsParams {
  readonly chainIdentifier: string
  readonly family?: ChainFamily
  readonly targetAmountWei: bigint
  readonly feeReserveWei?: bigint
  /** If true, allow accounts with nonce > 0 (dirty accounts). Defaults to false (clean only). */
  readonly allowDirty?: boolean
  /** Filter by origin: 'stealth' | 'subaccount' | 'change' | 'main' | 'utxo' */
  readonly originPreference?: ChainUtxoOrigin
  /**
   * Decoy pairing / Avoidance strategy:
   * When paying V, generate change splits avoiding order-of-magnitude collision with V.
   * Defaults to true.
   */
  readonly decoyAvoidance?: boolean
  /** Minimum output amount to avoid dust creation. Defaults to 1_000n. */
  readonly dustThresholdWei?: bigint
  /** Estimated transaction fee per change output. Defaults to 21_000n for EVM, 5_000n for Solana, 500n for UTXO. */
  readonly minFeePerTxWei?: bigint
  /** Maximum number of change split outputs. Defaults to 5. */
  readonly maxChangeOutputs?: number
  /**
   * If true, allows selecting coins that depend on unconfirmed parent transactions requiring on-chain confirmation.
   * Defaults to false (only selects immediately spendable coins without block confirmation gates).
   */
  readonly allowUnconfirmedDependencies?: boolean
  /**
   * Maximum unconfirmed mempool ancestor limit (e.g. 25 transactions, standard across Bitcoin Core / Chronik / Lotus).
   * Spends exceeding this limit are rejected. Defaults to 25.
   */
  readonly maxAncestors?: number
}

/**
 * Standard maximum unconfirmed mempool ancestor limit across Bitcoin Core, Chronik, and Lotus.
 */
export const MAX_UNCONFIRMED_MEMPOOL_ANCESTORS = 25

export interface OutpointDependencyParams {
  readonly outpoint: { txid: string; vout: number }
  readonly parentTxHash: string | string[]
  readonly chainIdentifier: string
}

export interface CoinSelectionResult {
  readonly selected: ChainUtxoCoin[]
  readonly totalSelectedWei: bigint
  readonly changeWei: bigint
  /** Suggested geometric radix change splits conforming to evm-change-distribution */
  readonly suggestedChangeSplits: bigint[]
}

export interface RegisterSubAccountParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface RegisterChangeAccountParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface RegisterChangeParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly label?: string
}

export interface RegisterStealthParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly ephemeralPubKey?: string
  readonly txHash?: string
  readonly label?: string
}

export interface ImportKeyParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei?: bigint
  readonly family?: ChainFamily
  readonly nonce?: number
  readonly origin?: ChainUtxoOrigin
  readonly label?: string
}

export interface RegisterUtxoOutpointParams {
  readonly chainIdentifier: string
  readonly address: string
  readonly privateKey: string
  readonly txid: string
  readonly vout: number
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly origin?: ChainUtxoOrigin
  readonly label?: string
  readonly parentTxHash?: string
  readonly requiresConfirmation?: boolean
}

export interface ArchiveSpentCoinsParams {
  readonly maxAgeMs?: number
  readonly chainIdentifier?: string
}

/**
 * Infers the ChainFamily from a chain identifier string.
 */
export function inferChainFamily(chainIdentifier: string, explicitFamily?: ChainFamily): ChainFamily {
  const facts = PROTOCOL_CHAINS[chainIdentifier]
  if (!facts) throw new Error(`Unknown canonical chainIdentifier: ${chainIdentifier}`)
  const family = facts.family === 'bitcoin' ? 'utxo' : facts.family
  if (explicitFamily !== undefined && explicitFamily !== family) {
    throw new Error(`Chain family mismatch for ${chainIdentifier}: ${explicitFamily}`)
  }
  return family
}

export function normalizeUtxoAddress(address: string, chainIdentifier: string, family?: ChainFamily): string {
  return inferChainFamily(chainIdentifier, family) === 'evm' ? address.toLowerCase().trim() : address.trim()
}

export function formatUtxoAddress(address: string, chainIdentifier: string, family?: ChainFamily): string {
  const resolved = inferChainFamily(chainIdentifier, family)
  if (resolved === 'evm') {
    try { return getAddress(address) } catch { return address.toLowerCase().trim() }
  }
  if (resolved === 'solana') {
    try { return new PublicKey(address).toBase58() } catch { return address.trim() }
  }
  return address.trim()
}

export function makeUtxoId(chainIdentifier: string, address: string,
  nonceOrOutpoint: number | { txid: string; vout: number } = 0, family?: ChainFamily): string {
  const resolved = inferChainFamily(chainIdentifier, family)
  const normAddr = normalizeUtxoAddress(address, chainIdentifier, resolved)
  const tail = typeof nonceOrOutpoint === 'object'
    ? `${nonceOrOutpoint.txid.toLowerCase()}:${nonceOrOutpoint.vout}` : `${nonceOrOutpoint}`
  return `${chainIdentifier}:${resolved}:${normAddr}:${tail}`
}

/**
 * Resolves an Ed25519 Keypair from an attached private key (hex seed, hex secret key, or base58).
 */
export async function resolveSolanaKeypair(privateKey: string): Promise<Keypair> {
  const clean = privateKey.trim().replace(/^0x/, '')
  const base58Encoder = getBase58Encoder()

  // 1. Check if hex-encoded
  if (/^[0-9a-fA-F]+$/.test(clean)) {
    const bytes = Buffer.from(clean, 'hex')
    if (bytes.length === 32) {
      return Keypair.fromSeed(bytes)
    }
    if (bytes.length === 64) {
      return Keypair.fromSecretKey(bytes)
    }
  }

  // 2. Base58 encoded
  try {
    const rawBytes = base58Encoder.encode(privateKey.trim())
    const bytes = new Uint8Array(rawBytes)
    if (bytes.length === 32) {
      return Keypair.fromSeed(bytes)
    }
    if (bytes.length === 64) {
      return Keypair.fromSecretKey(bytes)
    }
  } catch {}

  throw new Error(`Unable to resolve Solana Ed25519 keypair from provided private key`)
}

/**
 * EVM Chain Family Adapter.
 */
export class EvmChainFamilyAdapter {
  constructor(private readonly pool: ChainUtxoPool) {}

  registerSubAccount(params: RegisterSubAccountParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'evm')
    return this.pool.registerSubAccount({ ...params, family: params.family ?? 'evm' })
  }

  registerChangeAccount(params: RegisterChangeAccountParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'evm')
    return this.pool.registerChangeAccount({ ...params, family: params.family ?? 'evm' })
  }

  registerChangeOutput(params: RegisterChangeParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'evm')
    return this.pool.registerChangeOutput({ ...params, family: params.family ?? 'evm' })
  }

  registerStealthAccount(params: RegisterStealthParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'evm')
    return this.pool.registerStealthAccount({ ...params, family: params.family ?? 'evm' })
  }

  importPrivateKey(params: ImportKeyParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'evm')
    return this.pool.importPrivateKey({ ...params, family: params.family ?? 'evm' })
  }

  createSigner(
    coinOrId: ChainUtxoCoin | string,
    provider?: Provider,
    httpClient?: MonadTxSubmitter,
  ): MonadAccountTxSigner {
    return this.pool.createSigner(coinOrId, provider, httpClient)
  }

  createSweepPlan(params: {
    chainIdentifier: string
    dirtyUtxoId: string
    changeAddresses: string[]
    dustThresholdWei?: bigint
    minFeeWei?: bigint
  }) {
    return this.pool.createSweepPlan(params)
  }

  createBatchSweepPlan(params: {
    chainIdentifier: string
    dirtyUtxoIds: string[]
    destinationAddresses: string[]
    dustThresholdWei?: bigint
    minFeePerTxWei?: bigint
    maxChangeOutputs?: number
  }) {
    return this.pool.createBatchSweepPlan(params)
  }
}

/**
 * Solana Chain Family Adapter.
 */
export class SolanaChainFamilyAdapter {
  constructor(private readonly pool: ChainUtxoPool) {}

  registerAccount(params: {
    chainIdentifier: string
    address: string
    privateKey: string
    balanceWei: bigint
    origin?: ChainUtxoOrigin
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chainIdentifier: params.chainIdentifier,
      family: 'solana',
      address: params.address,
      privateKey: params.privateKey,
      balanceWei: params.balanceWei,
      nonce: 0,
      origin: params.origin ?? 'main',
      status: 'clean',
      label: params.label ?? 'Solana Account',
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
    })
  }

  registerStealthAccount(params: {
    chainIdentifier: string
    address: string
    privateKey: string
    balanceWei: bigint
    ephemeralPubKey?: string
    txHash?: string
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chainIdentifier: params.chainIdentifier,
      family: 'solana',
      address: params.address,
      privateKey: params.privateKey,
      balanceWei: params.balanceWei,
      nonce: 0,
      origin: 'stealth',
      status: 'clean',
      label: params.label ?? 'Solana Stealth Payment',
      ephemeralPubKey: params.ephemeralPubKey,
      txHash: params.txHash,
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
    })
  }

  registerDerivedAccount(params: {
    chainIdentifier: string
    address: string
    privateKey: string
    balanceWei: bigint
    derivationPath?: string
    index?: number
    origin?: 'subaccount' | 'change'
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chainIdentifier: params.chainIdentifier,
      family: 'solana',
      address: params.address,
      privateKey: params.privateKey,
      balanceWei: params.balanceWei,
      nonce: 0,
      origin: params.origin ?? 'subaccount',
      status: 'clean',
      label: params.label ?? `Solana Account ${params.index ?? 0}`,
      derivationPath: params.derivationPath,
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
    })
  }

  async createSigner(coinOrId: ChainUtxoCoin | string): Promise<Keypair> {
    return this.pool.createSolanaSigner(coinOrId)
  }

  /**
   * Constructs and signs a single atomic multi-input Solana transaction.
   * Unlike EVM which requires multi-block confirmation staging, Solana natively supports
   * multiple transfer instructions from distinct sub-accounts in ONE single transaction.
   */
  async buildMultiInputTransfer(params: {
    inputs: ChainUtxoCoin[]
    recipientAddress: string
    targetAmountLamports: bigint
    changeAddress?: string
    recentBlockhash: string
    feeLamports?: bigint
    priorityFeeMicroLamports?: bigint
  }): Promise<{
    transaction: Transaction
    signers: Keypair[]
    changeLamports: bigint
  }> {
    const {
      inputs,
      recipientAddress,
      targetAmountLamports,
      changeAddress,
      recentBlockhash,
      feeLamports = 5_000n,
      priorityFeeMicroLamports,
    } = params

    if (inputs.length === 0) {
      throw new Error('At least one input coin is required')
    }

    for (const input of inputs) {
      inferChainFamily(input.chainIdentifier, input.family)
      if (input.family !== 'solana' || input.chainIdentifier !== inputs[0].chainIdentifier) {
        throw new Error('Solana inputs must belong to one canonical chain')
      }
    }
    const signers: Keypair[] = []
    let totalLamports = 0n
    for (const input of inputs) {
      signers.push(await this.pool.createSolanaSigner(input))
      totalLamports += input.balanceWei
    }

    const totalNeeded = targetAmountLamports + feeLamports
    if (totalLamports < totalNeeded) {
      throw new Error(
        `Insufficient funds: total inputs ${totalLamports} lamports < needed ${totalNeeded} lamports`,
      )
    }

    const transaction = new Transaction()
    transaction.recentBlockhash = recentBlockhash as unknown as Blockhash
    transaction.feePayer = signers[0].publicKey

    const units = Math.max(2000, 1000 * inputs.length + 5000)
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units }))

    if (
      priorityFeeMicroLamports !== undefined &&
      priorityFeeMicroLamports > 0n
    ) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicroLamports,
        }),
      )
    }

    let remainingToPay = targetAmountLamports
    const recipientPubkey = new PublicKey(recipientAddress)

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      const signer = signers[i]
      const availableFromInput =
        i === 0 ? input.balanceWei - feeLamports : input.balanceWei

      if (remainingToPay > 0n) {
        const transferAmount =
          availableFromInput >= remainingToPay
            ? remainingToPay
            : availableFromInput
        if (transferAmount > 0n) {
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: signer.publicKey,
              toPubkey: recipientPubkey,
              lamports: transferAmount,
            }),
          )
          remainingToPay -= transferAmount
        }

        const leftover = availableFromInput - transferAmount
        if (leftover > 0n && changeAddress) {
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: signer.publicKey,
              toPubkey: new PublicKey(changeAddress),
              lamports: leftover,
            }),
          )
        }
      } else if (availableFromInput > 0n && changeAddress) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: signer.publicKey,
            toPubkey: new PublicKey(changeAddress),
            lamports: availableFromInput,
          }),
        )
      }
    }

    await transaction.sign(...signers)

    return {
      transaction,
      signers,
      changeLamports: totalLamports - totalNeeded,
    }
  }
}

/**
 * UTXO Chain Family Adapter (eCash / XEC, Bitcoin, etc.).
 */
export class UtxoChainFamilyAdapter {
  constructor(private readonly pool: ChainUtxoPool) {}

  registerOutpoint(params: RegisterUtxoOutpointParams): ChainUtxoCoin {
    return this.pool.registerUtxoOutpoint(params)
  }

  registerUtxoItem(params: {
    chainIdentifier: string
    address: string
    privateKey: string
    txId: string
    outputIndex: number
    satoshis: bigint
    origin?: ChainUtxoOrigin
    label?: string
    parentTxHash?: string
    requiresConfirmation?: boolean
  }): ChainUtxoCoin {
    return this.registerOutpoint({
      chainIdentifier: params.chainIdentifier,
      address: params.address,
      privateKey: params.privateKey,
      txid: params.txId,
      vout: params.outputIndex,
      balanceWei: params.satoshis,
      origin: params.origin,
      label: params.label,
      parentTxHash: params.parentTxHash,
      requiresConfirmation: params.requiresConfirmation,
    })
  }

  /**
   * Registers a mempool DAG outpoint dependency where outpoint ({ txid, vout })
   * depends on one or more parent transaction hashes (parentTxHash).
   */
  registerOutpointDependency(
    outpointOrParams:
      | { txid: string; vout: number }
      | OutpointDependencyParams
      | string,
    parentTxHash?: string | string[],
    chainIdentifier?: string,
  ): void {
    inferChainFamily(typeof outpointOrParams === 'object' && 'outpoint' in outpointOrParams
      ? outpointOrParams.chainIdentifier : chainIdentifier!, 'utxo')
    if (typeof outpointOrParams === 'string') {
      if (!parentTxHash) {
        throw new Error('parentTxHash is required when registering transaction dependency')
      }
      const parents = Array.isArray(parentTxHash) ? parentTxHash : [parentTxHash]
      for (const p of parents) {
        this.pool.registerTxDependency(outpointOrParams, p, chainIdentifier!)
      }
    } else if ('outpoint' in outpointOrParams) {
      this.pool.registerOutpointDependency(outpointOrParams)
    } else {
      if (!parentTxHash) {
        throw new Error('parentTxHash is required when passing outpoint directly')
      }
      this.pool.registerOutpointDependency({
        outpoint: outpointOrParams,
        parentTxHash,
        chainIdentifier: this.pool.chainKey(chainIdentifier!),
      })
    }
  }

  /**
   * Backwards-compatible alias for registerOutpointDependency.
   */
  registerDependency(
    outpointOrParams:
      | { txid: string; vout: number }
      | OutpointDependencyParams
      | string,
    parentTxHash?: string | string[],
    chainIdentifier?: string,
  ): void {
    this.registerOutpointDependency(outpointOrParams, parentTxHash, chainIdentifier)
  }

  /**
   * Retrieves immediate parent tx hashes for a given outpoint or txid.
   */
  getOutpointDependencies(
    txidOrOutpoint: { txid: string; vout: number } | string,
    voutOrChain: number | string,
    chainIdentifier?: string,
  ): string[] {
    return this.pool.getOutpointDependencies(txidOrOutpoint, voutOrChain, chainIdentifier)
  }

  /**
   * Traverses the mempool DAG to return the full set of transitive unconfirmed ancestor tx hashes.
   */
  getMempoolAncestors(
    coinOrOutpointOrTxid: ChainUtxoCoin | { txid: string; vout: number } | string,
    chainIdentifier?: string,
    vout?: number,
  ): Set<string> {
    return this.pool.getMempoolAncestors(coinOrOutpointOrTxid, chainIdentifier, vout)
  }

  /**
   * Returns the count of unconfirmed ancestors in the mempool DAG.
   */
  getAncestorCount(
    coinOrOutpointOrTxid: ChainUtxoCoin | { txid: string; vout: number } | string,
    chainIdentifier?: string,
    vout?: number,
  ): number {
    return this.pool.getAncestorCount(coinOrOutpointOrTxid, chainIdentifier, vout)
  }

  /**
   * Marks a transaction hash as confirmed on-chain, removing it from unconfirmed mempool DAG tracking.
   */
  markTransactionConfirmed(txHash: string, chainIdentifier: string): void {
    this.pool.markTransactionConfirmed(txHash, chainIdentifier)
  }

  /**
   * Checks whether a transaction hash has been confirmed.
   */
  isTransactionConfirmed(txHash: string, chainIdentifier: string): boolean {
    return this.pool.isTransactionConfirmed(txHash, chainIdentifier)
  }

  markOutpointSpent(
    txid: string,
    vout: number,
    chainIdentifier: string,
  ): ChainUtxoCoin | undefined {
    return this.pool.markOutpointSpent(txid, vout, chainIdentifier)
  }

  trackSpentOutpoints(
    outpoints: Array<{ txid: string; vout: number }>,
    chainIdentifier: string,
  ): ChainUtxoCoin[] {
    return this.pool.trackSpentOutpoints(outpoints, chainIdentifier)
  }

  getOutpoint(
    txid: string,
    vout: number,
    chainIdentifier: string,
  ): ChainUtxoCoin | undefined {
    return this.pool.getUtxoByOutpoint(txid, vout, chainIdentifier)
  }

  isOutpointSpent(txid: string, vout: number, chainIdentifier: string): boolean {
    return this.pool.isOutpointSpent(txid, vout, chainIdentifier)
  }
}

/**
 * Unified Chain UTXO Pool.
 *
 * Derived in-memory construction/selection view, rebuilt by wallet composition and direct
 * producers. HD/change lifecycle stores, received holdings and operation journals retain
 * durable authority; this pool has no persistence serializer or reorg recovery authority.
 *
 * Holds, indexes, selects, and tracks spendable accounts and coins across all
 * chains, families, keys, and derivation origins.
 */
export class ChainUtxoPool {
  private readonly coinsById = new Map<string, ChainUtxoCoin>()
  private readonly archivedCoinsById = new Map<string, ChainUtxoCoin>()
  private readonly coinsByAddress = new Map<string, Set<string>>()
  private readonly cleanCoinIdsByChain = new Map<string, Set<string>>()
  private readonly pendingCoinIdsByChain = new Map<string, Set<string>>()
  private readonly coinsByOutpoint = new Map<string, string>()
  private readonly spentOutpointKeys = new Set<string>()

  private readonly outpointDependencies = new Map<string, Set<string>>()
  private readonly txDependencies = new Map<string, Set<string>>()
  private readonly unconfirmedTxHashes = new Set<string>()
  private readonly confirmedTxHashes = new Set<string>()

  readonly evm: EvmChainFamilyAdapter
  readonly solana: SolanaChainFamilyAdapter
  readonly utxo: UtxoChainFamilyAdapter

  constructor(initialCoins: ChainUtxoCoin[] = []) {
    this.evm = new EvmChainFamilyAdapter(this)
    this.solana = new SolanaChainFamilyAdapter(this)
    this.utxo = new UtxoChainFamilyAdapter(this)

    for (const coin of initialCoins) {
      this.registerCoin(coin)
    }
  }

  chainKey(chainIdentifier: string): string {
    inferChainFamily(chainIdentifier)
    return chainIdentifier
  }

  private transactionKey(txHash: string, chainIdentifier: string): string {
    return `${this.chainKey(chainIdentifier)}:${txHash.toLowerCase()}`
  }

  outpointKey(txid: string, vout: number, chainIdentifier: string): string {
    return `${this.chainKey(chainIdentifier!)}:${txid.toLowerCase()}:${vout}`
  }

  /**
   * Registers an outpoint dependency in the mempool DAG.
   */
  registerOutpointDependency(params: OutpointDependencyParams): void {
    const { outpoint, parentTxHash, chainIdentifier } = params
    const parents = Array.isArray(parentTxHash) ? parentTxHash : [parentTxHash]
    const opScoped = this.outpointKey(outpoint.txid, outpoint.vout, chainIdentifier)
    const childTx = outpoint.txid.toLowerCase()

    this.markTxUnconfirmed(childTx, chainIdentifier!)

    for (const p of parents) {
      const parentLower = p.toLowerCase()
      this.markTxUnconfirmed(parentLower, chainIdentifier!)

      let setScoped = this.outpointDependencies.get(opScoped)
      if (!setScoped) {
        setScoped = new Set<string>()
        this.outpointDependencies.set(opScoped, setScoped)
      }
      setScoped.add(parentLower)

      let txSet = this.txDependencies.get(this.transactionKey(childTx, chainIdentifier!))
      if (!txSet) {
        txSet = new Set<string>()
        this.txDependencies.set(this.transactionKey(childTx, chainIdentifier!), txSet)
      }
      txSet.add(parentLower)
    }
  }

  /**
   * Registers a direct transaction-level dependency in the mempool DAG.
   */
  registerTxDependency(txid: string, parentTxHash: string, chainIdentifier: string): void {
    const childLower = txid.toLowerCase()
    const parentLower = parentTxHash.toLowerCase()
    this.markTxUnconfirmed(childLower, chainIdentifier)
    this.markTxUnconfirmed(parentLower, chainIdentifier!)

    let txSet = this.txDependencies.get(this.transactionKey(childLower, chainIdentifier!))
    if (!txSet) {
      txSet = new Set<string>()
      this.txDependencies.set(this.transactionKey(childLower, chainIdentifier!), txSet)
    }
    txSet.add(parentLower)
  }

  /**
   * Retrieves immediate parent tx hashes for an outpoint or txid.
   */
  getOutpointDependencies(
    txidOrOutpoint: { txid: string; vout: number } | string,
    voutOrChain: number | string,
    chainIdentifier?: string,
  ): string[] {
    let txid: string
    let vout: number
    let c: string | undefined

    if (typeof txidOrOutpoint === 'object') {
      txid = txidOrOutpoint.txid
      vout = txidOrOutpoint.vout
      c = typeof voutOrChain === 'string' ? voutOrChain : chainIdentifier
    } else {
      txid = txidOrOutpoint
      vout = typeof voutOrChain === 'number' ? voutOrChain : 0
      c = typeof voutOrChain === 'string' ? voutOrChain : chainIdentifier
    }

    const opScoped = this.outpointKey(txid, vout, c!)
    const deps = new Set<string>()

    const scoped = this.outpointDependencies.get(opScoped)
    if (scoped) {
      for (const d of scoped) deps.add(d)
    }
    const txDeps = this.txDependencies.get(this.transactionKey(txid, c!))
    if (txDeps) {
      for (const d of txDeps) deps.add(d)
    }

    return Array.from(deps)
  }

  /**
   * Retrieves immediate parent tx hashes registered for a transaction hash.
   */
  getTransactionDependencies(txHash: string, chainIdentifier: string): string[] {
    const deps = this.txDependencies.get(this.transactionKey(txHash, chainIdentifier))
    return deps ? Array.from(deps) : []
  }

  /**
   * Marks a transaction hash as confirmed on-chain, removing it from unconfirmed mempool tracking.
   */
  markTransactionConfirmed(txHash: string, chainIdentifier: string): void {
    const lower = this.transactionKey(txHash, chainIdentifier)
    this.confirmedTxHashes.add(lower)
    this.unconfirmedTxHashes.delete(lower)
  }

  /**
   * Checks whether a transaction hash has been confirmed.
   */
  isTransactionConfirmed(txHash: string, chainIdentifier: string): boolean {
    return this.confirmedTxHashes.has(this.transactionKey(txHash, chainIdentifier))
  }

  /**
   * Marks a transaction hash as an unconfirmed mempool transaction.
   */
  markTxUnconfirmed(txHash: string, chainIdentifier: string): void {
    const lower = this.transactionKey(txHash, chainIdentifier)
    if (!this.confirmedTxHashes.has(lower)) {
      this.unconfirmedTxHashes.add(lower)
    }
  }

  /**
   * Checks whether a transaction hash is considered unconfirmed in the mempool.
   */
  isUnconfirmedTx(txHash: string, chainIdentifier: string): boolean {
    const lower = this.transactionKey(txHash, chainIdentifier)
    if (this.confirmedTxHashes.has(lower)) return false
    return this.unconfirmedTxHashes.has(lower)
  }

  hasMempoolDependencies(): boolean {
    return this.unconfirmedTxHashes.size > 0 || this.outpointDependencies.size > 0
  }

  /**
   * Traverses the mempool DAG to return all unique transitive unconfirmed ancestor tx hashes.
   */
  getMempoolAncestors(
    target: ChainUtxoCoin | { txid: string; vout: number } | string,
    chainIdentifier?: string,
    vout?: number,
  ): Set<string> {
    const ancestors = new Set<string>()
    const visited = new Set<string>()
    const queue: string[] = []

    let targetTxid: string | undefined
    let targetVout: number | undefined
    let coinChain: string | undefined = chainIdentifier

    if (typeof target === 'object' && 'address' in target) {
      inferChainFamily(target.chainIdentifier, target.family)
      coinChain = target.chainIdentifier
      if (target.outpoint) {
        targetTxid = target.outpoint.txid.toLowerCase()
        targetVout = target.outpoint.vout
      }
      if (target.parentTxHash) {
        queue.push(target.parentTxHash.toLowerCase())
      }
    } else if (typeof target === 'object' && 'txid' in target) {
      targetTxid = target.txid.toLowerCase()
      targetVout = target.vout
      coinChain = chainIdentifier
    } else if (typeof target === 'string') {
      targetTxid = target.toLowerCase()
      targetVout = typeof vout === 'number' ? vout : undefined
      coinChain = chainIdentifier
    }

    this.chainKey(coinChain!)
    if (chainIdentifier !== undefined && coinChain !== chainIdentifier) throw new Error("Chain affinity mismatch")
    if (targetTxid !== undefined) {
      if (targetVout !== undefined) {
        const outDeps = this.getOutpointDependencies(targetTxid, targetVout, coinChain)
        for (const p of outDeps) queue.push(p.toLowerCase())
      }
      const txDeps = this.txDependencies.get(this.transactionKey(targetTxid, coinChain!))
      if (txDeps) {
        for (const p of txDeps) queue.push(p.toLowerCase())
      }
      if (this.unconfirmedTxHashes.has(this.transactionKey(targetTxid, coinChain!)) && !this.confirmedTxHashes.has(this.transactionKey(targetTxid, coinChain!))) {
        ancestors.add(targetTxid)
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!
      const currentLower = current.toLowerCase()

      if (visited.has(currentLower)) continue
      visited.add(currentLower)

      if (this.confirmedTxHashes.has(this.transactionKey(currentLower, coinChain!))) continue

      ancestors.add(currentLower)

      const parentDeps = this.txDependencies.get(this.transactionKey(currentLower, coinChain!))
      if (parentDeps) {
        for (const p of parentDeps) {
          if (!visited.has(p)) queue.push(p)
        }
      }

      const matchedCoin = this.getUtxoByOutpoint(currentLower, 0, coinChain!)
      if (matchedCoin?.parentTxHash && !visited.has(matchedCoin.parentTxHash.toLowerCase())) {
        queue.push(matchedCoin.parentTxHash.toLowerCase())
      }
    }

    return ancestors
  }

  /**
   * Returns the number of unconfirmed mempool ancestors for a given target coin, outpoint, or txid.
   */
  getAncestorCount(
    target: ChainUtxoCoin | { txid: string; vout: number } | string,
    chainIdentifier?: string,
    vout?: number,
  ): number {
    return this.getMempoolAncestors(target, chainIdentifier, vout).size
  }

  /**
   * Registers a coin directly into the inventory.
   */
  registerCoin(
    coin: Partial<ChainUtxoCoin> & {
      chainIdentifier: string
      address: string
      privateKey: string
    },
  ): ChainUtxoCoin {
    const family = inferChainFamily(coin.chainIdentifier, coin.family)
    const canonicalAddress = formatUtxoAddress(coin.address, coin.chainIdentifier, family)
    const nonceOrOutpoint = coin.outpoint ?? coin.nonce ?? 0
    const id = coin.id ?? makeUtxoId(coin.chainIdentifier, canonicalAddress, nonceOrOutpoint, family)

    if (coin.outpoint) {
      const outpointId = this.coinsByOutpoint.get(this.outpointKey(coin.outpoint.txid, coin.outpoint.vout, coin.chainIdentifier))
      if (outpointId !== undefined && outpointId !== id) throw new Error('Outpoint already registered under a different coin ID')
    }
    if (!id.startsWith(`${coin.chainIdentifier}:`)) throw new Error('Coin ID must carry canonical chain scope')
    const previous = this.coinsById.get(id) ?? this.archivedCoinsById.get(id)
    if (previous && (previous.chainIdentifier !== coin.chainIdentifier || previous.family !== family ||
      normalizeUtxoAddress(previous.address, previous.chainIdentifier) !== normalizeUtxoAddress(canonicalAddress, coin.chainIdentifier) ||
      previous.outpoint?.txid.toLowerCase() !== coin.outpoint?.txid.toLowerCase() || previous.outpoint?.vout !== coin.outpoint?.vout)) {
      throw new Error('Coin ID already belongs to a different coin')
    }

    // Check if this outpoint was already recorded as spent
    let status = coin.status ?? 'clean'
    let isSpentOutpoint = false
    if (coin.outpoint) {
      const opScoped = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout, coin.chainIdentifier)
      if (this.spentOutpointKeys.has(opScoped)) {
        status = 'spent'
        isSpentOutpoint = true
      }
    }

    const record: ChainUtxoCoin = {
      id,
      chainIdentifier: coin.chainIdentifier,
      family,
      address: canonicalAddress,
      privateKey: coin.privateKey,
      balanceWei: isSpentOutpoint ? 0n : (coin.balanceWei ?? 0n),
      nonce: coin.nonce ?? (family !== 'utxo' ? 0 : undefined),
      outpoint: coin.outpoint,
      status,
      origin: coin.origin ?? (coin.outpoint ? 'utxo' : 'main'),
      lastUpdatedMs: coin.lastUpdatedMs ?? Date.now(),
      discoveredAt: coin.discoveredAt ?? Date.now(),
      label: coin.label,
      derivationPath: coin.derivationPath,
      ephemeralPubKey: coin.ephemeralPubKey,
      txHash: coin.txHash,
      parentTxHash: coin.parentTxHash,
      requiresConfirmation: coin.requiresConfirmation,
      index: coin.index,
    }

    // Clean up previous indices if overwriting
    const existing = this.coinsById.get(id)
    if (existing) {
      this.removeFromIndices(existing)
    }
    this.archivedCoinsById.delete(id)

    this.coinsById.set(id, record)

    // Register mempool DAG outpoint dependency if parentTxHash is attached
    if (record.parentTxHash && record.outpoint) {
      this.registerOutpointDependency({
        outpoint: record.outpoint,
        parentTxHash: record.parentTxHash,
        chainIdentifier: record.chainIdentifier,
      })
    }

    // Index by address
    const addrKey = `${coin.chainIdentifier}:${normalizeUtxoAddress(canonicalAddress, coin.chainIdentifier, family)}`
    let addrSet = this.coinsByAddress.get(addrKey)
    if (!addrSet) {
      addrSet = new Set<string>()
      this.coinsByAddress.set(addrKey, addrSet)
    }
    addrSet.add(id)

    // Index by status & chainIdentifier
    const cKey = this.chainKey(coin.chainIdentifier)
    if (record.status === 'clean') {
      let cleanSet = this.cleanCoinIdsByChain.get(cKey)
      if (!cleanSet) {
        cleanSet = new Set<string>()
        this.cleanCoinIdsByChain.set(cKey, cleanSet)
      }
      cleanSet.add(id)
    } else if (record.status === 'pending') {
      let pendingSet = this.pendingCoinIdsByChain.get(cKey)
      if (!pendingSet) {
        pendingSet = new Set<string>()
        this.pendingCoinIdsByChain.set(cKey, pendingSet)
      }
      pendingSet.add(id)
    }

    // Index outpoint if present
    if (record.outpoint) {
      const opScoped = this.outpointKey(record.outpoint.txid, record.outpoint.vout, record.chainIdentifier)
      this.coinsByOutpoint.set(opScoped, id)
    }

    return record
  }

  /**
   * Backwards-compatible alias for registerCoin.
   */
  registerUtxo(utxo: ChainUtxoCoin): ChainUtxoCoin {
    return this.registerCoin(utxo)
  }

  private removeFromStatusIndices(record: ChainUtxoCoin): void {
    const cKey = this.chainKey(record.chainIdentifier)
    const cleanSet = this.cleanCoinIdsByChain.get(cKey)
    if (cleanSet) {
      cleanSet.delete(record.id)
    }
    const pendingSet = this.pendingCoinIdsByChain.get(cKey)
    if (pendingSet) {
      pendingSet.delete(record.id)
    }
  }

  private removeFromIndices(record: ChainUtxoCoin): void {
    const addrKey = `${record.chainIdentifier}:${normalizeUtxoAddress(record.address, record.chainIdentifier, record.family)}`
    const addrSet = this.coinsByAddress.get(addrKey)
    if (addrSet) {
      addrSet.delete(record.id)
      if (addrSet.size === 0) {
        this.coinsByAddress.delete(addrKey)
      }
    }

    this.removeFromStatusIndices(record)

    if (record.outpoint) {
      const opScoped = this.outpointKey(record.outpoint.txid, record.outpoint.vout, record.chainIdentifier)
      this.coinsByOutpoint.delete(opScoped)
    }
  }

  /**
   * Registers a native UTXO outpoint.
   */
  registerUtxoOutpoint(params: RegisterUtxoOutpointParams): ChainUtxoCoin {
    inferChainFamily(params.chainIdentifier, 'utxo')
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const outpoint = { txid: params.txid, vout: params.vout }
    const canonicalAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const id = makeUtxoId(params.chainIdentifier, canonicalAddress, outpoint, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: canonicalAddress,
      privateKey: params.privateKey,
      balanceWei: params.balanceWei,
      outpoint,
      origin: params.origin ?? 'utxo',
      status: 'clean',
      label: params.label ?? `UTXO ${params.txid.slice(0, 8)}:${params.vout}`,
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
      parentTxHash: params.parentTxHash,
      requiresConfirmation: params.requiresConfirmation ?? false,
    })
  }

  /**
   * Registers a stealth account.
   */
  registerStealthAccount(params: RegisterStealthParams): ChainUtxoCoin {
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const formattedAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const id = makeUtxoId(params.chainIdentifier, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce: 0,
      balanceWei: params.balanceWei,
      origin: 'stealth',
      status: 'clean',
      label: params.label ?? 'Stealth Inbound Payment',
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
      ephemeralPubKey: params.ephemeralPubKey,
      txHash: params.txHash,
    })
  }

  /**
   * Registers a pre-derived HD sub-account.
   */
  registerSubAccount(params: RegisterSubAccountParams): ChainUtxoCoin {
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const formattedAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const id = makeUtxoId(params.chainIdentifier, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce: 0,
      balanceWei: params.balanceWei,
      origin: 'subaccount',
      status: 'clean',
      label: params.label ?? `SubAccount ${params.index ?? 0}`,
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
      derivationPath: params.derivationPath,
      index: params.index,
    })
  }

  /**
   * Registers an HD change account.
   */
  registerChangeAccount(params: RegisterChangeAccountParams): ChainUtxoCoin {
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const formattedAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const id = makeUtxoId(params.chainIdentifier, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce: 0,
      balanceWei: params.balanceWei,
      origin: 'change',
      status: 'clean',
      label: params.label ?? `ChangeAccount ${params.index ?? 0}`,
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
      derivationPath: params.derivationPath,
      index: params.index,
    })
  }

  /**
   * Registers a fresh change output resulting from a spend transaction.
   */
  registerChangeOutput(params: RegisterChangeParams): ChainUtxoCoin {
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const formattedAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const id = makeUtxoId(params.chainIdentifier, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce: 0,
      balanceWei: params.balanceWei,
      origin: 'change',
      status: 'clean',
      label: params.label ?? 'Transaction Change Output',
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
      derivationPath: params.derivationPath,
    })
  }

  /**
   * Imports an arbitrary private key into the pool.
   */
  importPrivateKey(params: ImportKeyParams): ChainUtxoCoin {
    const family = inferChainFamily(params.chainIdentifier, params.family)
    const formattedAddress = formatUtxoAddress(params.address, params.chainIdentifier, family)
    const nonce = params.nonce ?? 0
    const id = makeUtxoId(params.chainIdentifier, formattedAddress, nonce, family)

    return this.registerCoin({
      id,
      chainIdentifier: params.chainIdentifier,
      family,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce,
      balanceWei: params.balanceWei ?? 0n,
      origin: params.origin ?? 'main',
      status: nonce === 0 ? 'clean' : 'spent',
      label: params.label ?? 'Imported Account',
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
    })
  }

  /**
   * Retrieves a coin by its unique composite id.
   */
  getCoin(id: string, options?: { includeArchived?: boolean }): ChainUtxoCoin | undefined {
    const coin = this.coinsById.get(id)
    if (coin || !options?.includeArchived) return coin
    return this.archivedCoinsById.get(id)
  }

  /**
   * Backwards-compatible alias for getCoin.
   */
  getUtxo(id: string, options?: { includeArchived?: boolean }): ChainUtxoCoin | undefined {
    return this.getCoin(id, options)
  }

  /**
   * Queries cold archived spent coins on demand, optionally filtered by chain.
   */
  getArchivedCoins(chainIdentifier?: string): ChainUtxoCoin[] {
    const all = Array.from(this.archivedCoinsById.values())
    if (chainIdentifier === undefined) return all
    const cKey = this.chainKey(chainIdentifier)
    return all.filter(u => this.chainKey(u.chainIdentifier) === cKey)
  }

  /**
   * Retrieves a specific archived coin by its composite id.
   */
  getArchivedCoin(id: string): ChainUtxoCoin | undefined {
    return this.archivedCoinsById.get(id)
  }

  /**
   * Two-tier storage archiving:
   * Moves fully drained ($0 wei) and spent coins older than maxAgeMs (default 1 hour)
   * from the active coinsById map into an archived map/collection archivedCoinsById,
   * keeping the hot active memory index small.
   */
  archiveSpentCoins(params?: ArchiveSpentCoinsParams): ChainUtxoCoin[] {
    if (params?.chainIdentifier !== undefined) this.chainKey(params.chainIdentifier)
    const maxAgeMs = params?.maxAgeMs ?? 3_600_000
    const now = Date.now()
    const archived: ChainUtxoCoin[] = []
    const coins = Array.from(this.coinsById.values())

    for (const coin of coins) {
      if (params?.chainIdentifier && this.chainKey(coin.chainIdentifier) !== this.chainKey(params.chainIdentifier)) {
        continue
      }
      if (
        coin.status === 'spent' &&
        coin.balanceWei === 0n &&
        now - coin.lastUpdatedMs >= maxAgeMs
      ) {
        this.coinsById.delete(coin.id)
        this.removeFromIndices(coin)
        this.archivedCoinsById.set(coin.id, coin)
        archived.push(coin)
      }
    }

    return archived
  }

  /**
   * Retrieves a coin by outpoint (txid and vout).
   */
  getUtxoByOutpoint(
    txid: string,
    vout: number,
    chainIdentifier: string,
  ): ChainUtxoCoin | undefined {
    const key = this.outpointKey(txid, vout, chainIdentifier)
    const id = this.coinsByOutpoint.get(key)
    if (id) {
      return this.coinsById.get(id)
    }
    return undefined
  }

  /**
   * Checks if an outpoint is marked spent.
   */
  isOutpointSpent(txid: string, vout: number, chainIdentifier: string): boolean {
    const keyScoped = this.outpointKey(txid, vout, chainIdentifier)
    return this.spentOutpointKeys.has(keyScoped)
  }

  /**
   * Retrieves all coins associated with a specific address.
   */
  getCoinsByAddress(address: string, chainIdentifier: string): ChainUtxoCoin[] {
    const addrKey = `${this.chainKey(chainIdentifier!)}:${normalizeUtxoAddress(address, chainIdentifier!)}`
    const ids = this.coinsByAddress.get(addrKey)
    if (!ids) return []
    const results: ChainUtxoCoin[] = []
    for (const id of ids) {
      const item = this.coinsById.get(id)
      if (item) {
        if (!chainIdentifier || this.chainKey(item.chainIdentifier) === this.chainKey(chainIdentifier)) {
          results.push(item)
        }
      }
    }
    return results
  }

  /**
   * Backwards-compatible alias for getCoinsByAddress.
   */
  getUtxosByAddress(address: string, chainIdentifier: string): ChainUtxoCoin[] {
    return this.getCoinsByAddress(address, chainIdentifier)
  }

  /**
   * Retrieves all clean (unspent) coins for a given chain.
   */
  getCleanCoins(chainIdentifier: string): ChainUtxoCoin[] {
    const cKey = this.chainKey(chainIdentifier)
    const ids = this.cleanCoinIdsByChain.get(cKey)
    if (!ids) return []
    const results: ChainUtxoCoin[] = []
    for (const id of ids) {
      const item = this.coinsById.get(id)
      if (item && item.status === 'clean') {
        results.push(item)
      }
    }
    return results
  }

  /**
   * Backwards-compatible alias for getCleanCoins.
   */
  getCleanUtxos(chainIdentifier: string): ChainUtxoCoin[] {
    return this.getCleanCoins(chainIdentifier)
  }

  /**
   * Retrieves all pending coins for a given chain.
   */
  getPendingCoins(chainIdentifier: string): ChainUtxoCoin[] {
    const cKey = this.chainKey(chainIdentifier)
    const ids = this.pendingCoinIdsByChain.get(cKey)
    if (!ids) return []
    const results: ChainUtxoCoin[] = []
    for (const id of ids) {
      const item = this.coinsById.get(id)
      if (item && item.status === 'pending') {
        results.push(item)
      }
    }
    return results
  }

  /**
   * Backwards-compatible alias for getPendingCoins.
   */
  getPendingUtxos(chainIdentifier: string): ChainUtxoCoin[] {
    return this.getPendingCoins(chainIdentifier)
  }

  /**
   * Retrieves all coins in the pool, optionally filtered by chain.
   */
  getAllCoins(chainIdentifier?: string): ChainUtxoCoin[] {
    const all = Array.from(this.coinsById.values())
    if (chainIdentifier === undefined) return all
    const cKey = this.chainKey(chainIdentifier)
    return all.filter(u => this.chainKey(u.chainIdentifier) === cKey)
  }

  /**
   * Backwards-compatible alias for getAllCoins.
   */
  getAllUtxos(chainIdentifier?: string): ChainUtxoCoin[] {
    return this.getAllCoins(chainIdentifier)
  }

  /**
   * Retrieves dirty accounts (nonce > 0 or status != 'clean' that still hold positive balance).
   */
  getDirtyCoins(chainIdentifier: string): ChainUtxoCoin[] {
    const all = this.getAllCoins(chainIdentifier)
    return all.filter(
      u =>
        u.balanceWei > 0n &&
        ((u.nonce !== undefined && u.nonce > 0) || u.status === 'spent'),
    )
  }

  /**
   * Backwards-compatible alias for getDirtyCoins.
   */
  getDirtyUtxos(chainIdentifier: string): ChainUtxoCoin[] {
    return this.getDirtyCoins(chainIdentifier)
  }

  /**
   * Computes total spendable balance for a chain.
   */
  getTotalBalance(chainIdentifier: string, statusFilter: ChainUtxoStatus = 'clean'): bigint {
    let total = 0n
    for (const coin of this.getAllCoins(chainIdentifier)) {
      if (coin.status === statusFilter) {
        total += coin.balanceWei
      }
    }
    return total
  }

  /**
   * Atomically marks a coin as 'pending' upon transaction broadcast.
   */
  markPending(id: string): ChainUtxoCoin {
    const coin = this.coinsById.get(id)
    if (!coin) {
      throw new Error(`UTXO not found: ${id}`)
    }
    if (coin.status === 'spent') {
      throw new Error(`Cannot mark already spent UTXO as pending: ${id}`)
    }

    const cKey = this.chainKey(coin.chainIdentifier)
    const cleanSet = this.cleanCoinIdsByChain.get(cKey)
    if (cleanSet) cleanSet.delete(id)

    coin.status = 'pending'
    coin.lastUpdatedMs = Date.now()

    let pendingSet = this.pendingCoinIdsByChain.get(cKey)
    if (!pendingSet) {
      pendingSet = new Set<string>()
      this.pendingCoinIdsByChain.set(cKey, pendingSet)
    }
    pendingSet.add(id)

    return coin
  }

  /**
   * Marks a coin as permanently spent after confirmation.
   */
  markSpent(id: string, finalNonce?: number): ChainUtxoCoin {
    const coin = this.coinsById.get(id)
    if (!coin) {
      throw new Error(`UTXO not found: ${id}`)
    }

    const cKey = this.chainKey(coin.chainIdentifier)
    const cleanSet = this.cleanCoinIdsByChain.get(cKey)
    if (cleanSet) cleanSet.delete(id)
    const pendingSet = this.pendingCoinIdsByChain.get(cKey)
    if (pendingSet) pendingSet.delete(id)

    coin.status = 'spent'
    if (finalNonce !== undefined) {
      coin.nonce = finalNonce
    } else if (coin.nonce !== undefined) {
      coin.nonce = Math.max(1, coin.nonce + 1)
    }
    coin.balanceWei = 0n
    coin.lastUpdatedMs = Date.now()

    if (coin.outpoint) {
      const opScoped = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout, coin.chainIdentifier)
      this.spentOutpointKeys.add(opScoped)
    }

    return coin
  }

  /**
   * Releases a pending coin back to 'clean' if transaction broadcast failed.
   */
  releasePending(id: string): ChainUtxoCoin {
    const coin = this.coinsById.get(id)
    if (!coin) {
      throw new Error(`UTXO not found: ${id}`)
    }
    if (coin.status !== 'pending') {
      return coin
    }

    const cKey = this.chainKey(coin.chainIdentifier)
    const pendingSet = this.pendingCoinIdsByChain.get(cKey)
    if (pendingSet) pendingSet.delete(id)

    coin.status = 'clean'
    coin.lastUpdatedMs = Date.now()

    let cleanSet = this.cleanCoinIdsByChain.get(cKey)
    if (!cleanSet) {
      cleanSet = new Set<string>()
      this.cleanCoinIdsByChain.set(cKey, cleanSet)
    }
    cleanSet.add(id)

    return coin
  }

  /**
   * Marks an outpoint as spent by txid:vout.
   */
  markOutpointSpent(
    txid: string,
    vout: number,
    chainIdentifier: string,
  ): ChainUtxoCoin | undefined {
    const opScoped = this.outpointKey(txid, vout, chainIdentifier)
    this.spentOutpointKeys.add(opScoped)

    const coin = this.getUtxoByOutpoint(txid, vout, chainIdentifier)
    if (coin) {
      return this.markSpent(coin.id)
    }
    return undefined
  }

  /**
   * Tracks an array of spent outpoints.
   */
  trackSpentOutpoints(
    outpoints: Array<{ txid: string; vout: number }>,
    chainIdentifier: string,
  ): ChainUtxoCoin[] {
    const spentCoins: ChainUtxoCoin[] = []
    for (const op of outpoints) {
      const spent = this.markOutpointSpent(op.txid, op.vout, chainIdentifier)
      if (spent) spentCoins.push(spent)
    }
    return spentCoins
  }

  /**
   * Updates balance and nonce for an existing coin.
   */
  updateBalanceAndNonce(params: {
    id: string
    balanceWei: bigint
    nonce: number
  }): ChainUtxoCoin {
    const coin = this.coinsById.get(params.id)
    if (!coin) {
      throw new Error(`UTXO not found: ${params.id}`)
    }

    coin.balanceWei = params.balanceWei
    coin.nonce = params.nonce
    coin.lastUpdatedMs = Date.now()

    if (params.nonce > 0 && coin.status === 'clean') {
      this.removeFromStatusIndices(coin)
      coin.status = 'spent'
    }

    return coin
  }

  /**
   * Standardized Pure In-Memory Coin Selection across EVM, Solana, and UTXO families.
   *
   * Zero blocking network calls: operates completely in memory.
   *
   * Strategy:
   * 1. Query clean coins for the specified chain and family.
   * 2. Attempt best single-coin fit: find the smallest coin >= (targetAmount + feeReserve).
   * 3. If no single coin covers the amount, use greedy largest-first combination fallback.
   * 4. Calculate change outputs using geometric radix splitting with entropy jitter,
   *    avoiding order-of-magnitude collision with recipient payment amount.
   */
  selectCoins(params: SelectCoinsParams): CoinSelectionResult {
    const {
      chainIdentifier,
      family: explicitFamily,
      targetAmountWei,
      feeReserveWei = 0n,
      allowDirty = false,
      originPreference,
      decoyAvoidance = true,
      dustThresholdWei = 1_000n,
      maxChangeOutputs = 5,
      allowUnconfirmedDependencies = false,
    } = params

    const family = inferChainFamily(chainIdentifier, explicitFamily)
    const defaultFee =
      family === 'solana' ? 5_000n : family === 'utxo' ? 500n : 21_000n
    const minFeePerTxWei = params.minFeePerTxWei ?? defaultFee

    const neededWei = targetAmountWei + feeReserveWei
    if (neededWei <= 0n) {
      return {
        selected: [],
        totalSelectedWei: 0n,
        changeWei: 0n,
        suggestedChangeSplits: [],
      }
    }

    let candidates: ChainUtxoCoin[] = []
    if (allowDirty) {
      candidates = this.getAllCoins(chainIdentifier).filter(
        u => u.status !== 'pending' && u.balanceWei > 0n,
      )
    } else {
      candidates = this.getCleanCoins(chainIdentifier).filter(u => u.balanceWei > 0n)
    }

    if (!allowUnconfirmedDependencies) {
      if (family === 'utxo') {
        // Native UTXO mempools (Lotus, eCash, Bitcoin) allow selecting unconfirmed change outputs
        // directly in the mempool where requiresConfirmation is not explicitly true.
        candidates = candidates.filter(u => u.requiresConfirmation !== true)
      } else {
        candidates = candidates.filter(u => !u.requiresConfirmation)
      }
    }

    if (explicitFamily) {
      candidates = candidates.filter(u => u.family === explicitFamily)
    }

    if (originPreference) {
      const preferred = candidates.filter(u => u.origin === originPreference)
      if (preferred.length > 0) {
        candidates = preferred
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        `Insufficient funds in ChainUtxoPool for ${chainIdentifier}: no spendable coins found`,
      )
    }

    // Enforce mempool ancestor limit (e.g. 25 transactions, standard across Bitcoin Core / Chronik / Lotus)
    const maxAncestors = params.maxAncestors ?? MAX_UNCONFIRMED_MEMPOOL_ANCESTORS
    if (family === 'utxo' && this.hasMempoolDependencies()) {
      let exceededAncestorCount = 0
      let maxFoundAncestors = 0
      const validCandidates: ChainUtxoCoin[] = []

      for (const coin of candidates) {
        const count = this.getAncestorCount(coin, chainIdentifier)
        if (count > maxAncestors) {
          exceededAncestorCount++
          if (count > maxFoundAncestors) maxFoundAncestors = count
        } else {
          validCandidates.push(coin)
        }
      }

      if (validCandidates.length === 0) {
        if (exceededAncestorCount > 0) {
          throw new Error(
            `Mempool ancestor limit exceeded: spend would have ${maxFoundAncestors} unconfirmed ancestors (limit: ${maxAncestors})`,
          )
        }
        throw new Error(
          `Insufficient funds in ChainUtxoPool for ${chainIdentifier}: no spendable coins found within ancestor limit`,
        )
      }

      candidates = validCandidates
    }

    // 1. Single coin best-fit: smallest coin >= neededWei
    const singleCovers = candidates
      .filter(u => u.balanceWei >= neededWei)
      .sort((a, b) =>
        a.balanceWei < b.balanceWei ? -1 : a.balanceWei > b.balanceWei ? 1 : 0,
      )

    let selected: ChainUtxoCoin[] = []
    let totalSelectedWei = 0n

    if (singleCovers.length > 0) {
      selected = [singleCovers[0]]
      totalSelectedWei = singleCovers[0].balanceWei
    } else {
      // 2. Greedy largest-first combination
      const sortedDesc = [...candidates].sort((a, b) =>
        a.balanceWei > b.balanceWei ? -1 : a.balanceWei < b.balanceWei ? 1 : 0,
      )

      for (const coin of sortedDesc) {
        selected.push(coin)
        totalSelectedWei += coin.balanceWei
        if (totalSelectedWei >= neededWei) {
          break
        }
      }

      if (totalSelectedWei < neededWei) {
        throw new Error(
          `Insufficient funds in ChainUtxoPool for ${chainIdentifier}: needed ${neededWei} wei, available ${totalSelectedWei} wei across ${candidates.length} coins`,
        )
      }
    }

    // Verify combined selected coins do not exceed maxAncestors package limit
    if (family === 'utxo' && this.hasMempoolDependencies()) {
      const combinedAncestors = new Set<string>()
      for (const coin of selected) {
        for (const anc of this.getMempoolAncestors(coin, chainIdentifier)) {
          combinedAncestors.add(anc)
        }
      }
      if (combinedAncestors.size > maxAncestors) {
        throw new Error(
          `Mempool ancestor limit exceeded: selected coins combine to ${combinedAncestors.size} unconfirmed ancestors (limit: ${maxAncestors})`,
        )
      }
    }

    const changeWei = totalSelectedWei - neededWei
    let suggestedChangeSplits: bigint[] = []

    if (changeWei >= dustThresholdWei + minFeePerTxWei) {
      suggestedChangeSplits = computeGeometricRadixChangeSplits({
        totalAvailableWei: changeWei,
        recipientAmountWei: decoyAvoidance ? targetAmountWei : undefined,
        dustThresholdWei,
        minFeePerTxWei,
        maxOutputs: maxChangeOutputs,
      })
    } else if (changeWei >= dustThresholdWei) {
      suggestedChangeSplits = [changeWei]
    }

    return {
      selected,
      totalSelectedWei,
      changeWei,
      suggestedChangeSplits,
    }
  }

  /**
   * Instantiates a MonadAccountTxSigner directly from the attached private key.
   * O(1) instantaneous operation without secondary keyring queries.
   */
  createSigner(
    coinOrId: ChainUtxoCoin | string,
    provider?: Provider,
    httpClient?: MonadTxSubmitter,
  ): MonadAccountTxSigner {
    const coin =
      typeof coinOrId === 'string' ? this.getCoin(coinOrId) : coinOrId
    if (!coin) {
      throw new Error(`UTXO not found: ${coinOrId}`)
    }
    inferChainFamily(coin.chainIdentifier, coin.family)
    if (coin.family !== 'evm') throw new Error('EVM signer requires an EVM coin')
    if (!coin.privateKey) {
      throw new Error(`UTXO ${coin.id} has no privateKey attached`)
    }

    const defaultSubmitter: MonadTxSubmitter = {
      submitRawTransaction: async () => '0xmock',
      getTransactionReceipt: async () => undefined,
    }

    return new MonadAccountTxSigner({
      privateKey: coin.privateKey,
      provider: (provider ?? ({} as any)) as Provider,
      httpClient: httpClient ?? defaultSubmitter,
    })
  }

  /**
   * Resolves a Solana Ed25519 Keypair directly from the attached private key.
   */
  async createSolanaSigner(coinOrId: ChainUtxoCoin | string): Promise<Keypair> {
    const coin =
      typeof coinOrId === 'string' ? this.getCoin(coinOrId) : coinOrId
    if (!coin) {
      throw new Error(`UTXO not found: ${coinOrId}`)
    }
    inferChainFamily(coin.chainIdentifier, coin.family)
    if (coin.family !== 'solana') throw new Error('Solana signer requires a Solana coin')
    if (!coin.privateKey) {
      throw new Error(`UTXO ${coin.id} has no privateKey attached`)
    }
    return resolveSolanaKeypair(coin.privateKey)
  }

  /**
   * Creates a sweep plan for a dirty UTXO using geometric radix distribution.
   */
  createSweepPlan(params: {
    chainIdentifier: string
    dirtyUtxoId: string
    changeAddresses: string[]
    dustThresholdWei?: bigint
    minFeeWei?: bigint
  }): {
    dirtyUtxo: ChainUtxoCoin
    totalSweepableWei: bigint
    changeOutputs: Array<{ address: string; amountWei: bigint }>
  } {
    const {
      chainIdentifier,
      dirtyUtxoId,
      changeAddresses,
      dustThresholdWei = 1_000n,
      minFeeWei = 21_000n,
    } = params

    this.chainKey(chainIdentifier)
    const utxo = this.getCoin(dirtyUtxoId)
    if (!utxo) {
      throw new Error(`Dirty UTXO not found: ${dirtyUtxoId}`)
    }
    if (utxo.chainIdentifier !== chainIdentifier) throw new Error("Chain affinity mismatch")
    if (utxo.balanceWei <= dustThresholdWei + minFeeWei) {
      throw new Error(
        `UTXO balance (${utxo.balanceWei}) is below dust + fee threshold`,
      )
    }
    if (changeAddresses.length === 0) {
      throw new Error('At least one clean change address is required to sweep')
    }

    const availableWei = utxo.balanceWei - minFeeWei
    const splits = computeGeometricRadixChangeSplits({
      totalAvailableWei: availableWei,
      dustThresholdWei,
      minFeePerTxWei: 0n,
      maxOutputs: changeAddresses.length,
    })

    const changeOutputs: Array<{ address: string; amountWei: bigint }> = []
    for (let i = 0; i < splits.length; i++) {
      const addr = changeAddresses[i % changeAddresses.length]
      changeOutputs.push({
        address: formatUtxoAddress(addr, chainIdentifier, utxo.family),
        amountWei: splits[i],
      })
    }

    return {
      dirtyUtxo: utxo,
      totalSweepableWei: availableWei,
      changeOutputs,
    }
  }

  /**
   * Plans a multi-UTXO consolidation sweep.
   * Aggregates multiple small or dirty coins into clean change accounts or a designated existing account.
   * Enforces healthy output thresholds (each output >= 2 * minFeeWei) to prevent generating dust accounts.
   */
  createBatchSweepPlan(params: {
    chainIdentifier: string
    dirtyUtxoIds: string[]
    destinationAddresses: string[]
    dustThresholdWei?: bigint
    minFeePerTxWei?: bigint
    maxChangeOutputs?: number
  }): {
    dirtyUtxos: ChainUtxoCoin[]
    totalGrossWei: bigint
    totalFeesWei: bigint
    totalNetWei: bigint
    consolidationOutputs: Array<{ address: string; amountWei: bigint }>
  } {
    const {
      chainIdentifier,
      dirtyUtxoIds,
      destinationAddresses,
      dustThresholdWei = 1_000n,
      minFeePerTxWei = 21_000n,
      maxChangeOutputs = destinationAddresses.length,
    } = params

    this.chainKey(chainIdentifier)
    if (dirtyUtxoIds.length === 0) {
      throw new Error('At least one dirty UTXO id is required to batch sweep')
    }
    if (destinationAddresses.length === 0) {
      throw new Error('At least one destination address is required')
    }

    const dirtyUtxos: ChainUtxoCoin[] = []
    let totalGrossWei = 0n
    for (const id of dirtyUtxoIds) {
      const coin = this.getCoin(id)
      if (!coin) {
        throw new Error(`Dirty UTXO not found: ${id}`)
      }
      if (coin.chainIdentifier !== this.chainKey(chainIdentifier)) throw new Error("Chain affinity mismatch")
      dirtyUtxos.push(coin)
      totalGrossWei += coin.balanceWei
    }

    const totalFeesWei = BigInt(dirtyUtxos.length) * minFeePerTxWei
    if (totalGrossWei <= totalFeesWei + dustThresholdWei) {
      throw new Error(
        `Total gross balance (${totalGrossWei} wei) across ${dirtyUtxos.length} coins is insufficient to cover sweep fees (${totalFeesWei} wei) plus dust threshold`,
      )
    }

    const totalNetWei = totalGrossWei - totalFeesWei
    // Enforce that change outputs are substantial enough (at least 2 * minFeePerTxWei) so they never become unspendable dust
    const minHealthyOutput =
      minFeePerTxWei * 2n > dustThresholdWei ? minFeePerTxWei * 2n : dustThresholdWei

    const splits = computeGeometricRadixChangeSplits({
      totalAvailableWei: totalNetWei,
      dustThresholdWei: minHealthyOutput,
      minFeePerTxWei: 0n,
      maxOutputs: Math.min(destinationAddresses.length, maxChangeOutputs),
    })

    const consolidationOutputs: Array<{ address: string; amountWei: bigint }> = []
    for (let i = 0; i < splits.length; i++) {
      const addr = destinationAddresses[i % destinationAddresses.length]
      consolidationOutputs.push({
        address: formatUtxoAddress(addr, chainIdentifier, dirtyUtxos[0]?.family),
        amountWei: splits[i],
      })
    }

    return {
      dirtyUtxos,
      totalGrossWei,
      totalFeesWei,
      totalNetWei,
      consolidationOutputs,
    }
  }
}
