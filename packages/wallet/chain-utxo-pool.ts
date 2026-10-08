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
import { Blockhash, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js'
import { getBase58Encoder } from '@solana/codecs-strings'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import {
  computeGeometricRadixChangeSplits,
  orderOfMagnitude2,
} from './monad-change-distribution'

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
  /** Composite key: `${chain}:${family}:${address}:${nonceOrOutpoint}` */
  readonly id: string
  readonly chain: string // 'monad' | 'solana' | 'ecash' | string
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

// Aliases for backwards compatibility with AccountUtxoPool
export type AccountChain = string
export type AccountUtxoOrigin = ChainUtxoOrigin
export type AccountUtxoStatus = ChainUtxoStatus
export type AccountUtxo = ChainUtxoCoin

export interface SelectCoinsParams {
  readonly chain: string
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
}

export interface CoinSelectionResult {
  readonly selected: ChainUtxoCoin[]
  readonly totalSelectedWei: bigint
  readonly changeWei: bigint
  /** Suggested geometric radix change splits conforming to monad-change-distribution */
  readonly suggestedChangeSplits: bigint[]
}

export interface RegisterSubAccountParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface RegisterChangeAccountParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface RegisterChangeParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly derivationPath?: string
  readonly label?: string
}

export interface RegisterStealthParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly ephemeralPubKey?: string
  readonly txHash?: string
  readonly label?: string
}

export interface ImportKeyParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly balanceWei?: bigint
  readonly family?: ChainFamily
  readonly nonce?: number
  readonly origin?: ChainUtxoOrigin
  readonly label?: string
}

export interface RegisterUtxoOutpointParams {
  readonly chain: string
  readonly address: string
  readonly privateKey: string
  readonly txid: string
  readonly vout: number
  readonly balanceWei: bigint
  readonly family?: ChainFamily
  readonly origin?: ChainUtxoOrigin
  readonly label?: string
}

/**
 * Infers the ChainFamily from a chain identifier string.
 */
export function inferChainFamily(chain: string): ChainFamily {
  const c = chain.toLowerCase()
  if (c.includes('solana')) return 'solana'
  if (
    c.includes('ecash') ||
    c.includes('xec') ||
    c.includes('bitcoin') ||
    c.includes('btc') ||
    c.includes('bch') ||
    c.includes('doge') ||
    c === 'utxo'
  ) {
    return 'utxo'
  }
  return 'evm'
}

/**
 * Normalizes an address string for dictionary/set keys.
 */
export function normalizeUtxoAddress(
  address: string,
  chain?: string,
  family?: ChainFamily,
): string {
  const fam = family ?? (chain ? inferChainFamily(chain) : 'evm')
  if (fam === 'evm' || address.startsWith('0x')) {
    return address.toLowerCase().trim()
  }
  if (fam === 'utxo') {
    return address.toLowerCase().trim()
  }
  // Solana addresses are base58 and case-sensitive
  return address.trim()
}

/**
 * Formats an address string for display and storage.
 */
export function formatUtxoAddress(
  address: string,
  chain?: string,
  family?: ChainFamily,
): string {
  const fam = family ?? (chain ? inferChainFamily(chain) : 'evm')
  if (fam === 'evm' || address.startsWith('0x')) {
    try {
      return getAddress(address)
    } catch {
      return address.toLowerCase().trim()
    }
  }
  if (fam === 'solana') {
    try {
      return new PublicKey(address).toBase58()
    } catch {
      return address.trim()
    }
  }
  return address.trim()
}

/**
 * Formats a canonical UTXO id: `${chain}:${family}:${address}:${nonceOrOutpoint}`.
 */
export function makeUtxoId(
  chain: string,
  address: string,
  nonceOrOutpoint: number | { txid: string; vout: number } = 0,
  family?: ChainFamily,
): string {
  const fam = family ?? inferChainFamily(chain)
  const normAddr = normalizeUtxoAddress(address, chain, fam)
  const tail =
    typeof nonceOrOutpoint === 'object' && nonceOrOutpoint !== null
      ? `${nonceOrOutpoint.txid.toLowerCase()}:${nonceOrOutpoint.vout}`
      : `${nonceOrOutpoint}`
  return `${chain.toLowerCase()}:${fam}:${normAddr}:${tail}`
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
    return this.pool.registerSubAccount({ ...params, family: 'evm' })
  }

  registerChangeAccount(params: RegisterChangeAccountParams): ChainUtxoCoin {
    return this.pool.registerChangeAccount({ ...params, family: 'evm' })
  }

  registerChangeOutput(params: RegisterChangeParams): ChainUtxoCoin {
    return this.pool.registerChangeOutput({ ...params, family: 'evm' })
  }

  registerStealthAccount(params: RegisterStealthParams): ChainUtxoCoin {
    return this.pool.registerStealthAccount({ ...params, family: 'evm' })
  }

  importPrivateKey(params: ImportKeyParams): ChainUtxoCoin {
    return this.pool.importPrivateKey({ ...params, family: 'evm' })
  }

  createSigner(
    coinOrId: ChainUtxoCoin | string,
    provider?: Provider,
    httpClient?: MonadTxSubmitter,
  ): MonadAccountTxSigner {
    return this.pool.createSigner(coinOrId, provider, httpClient)
  }

  createSweepPlan(params: {
    chain: string
    dirtyUtxoId: string
    changeAddresses: string[]
    dustThresholdWei?: bigint
    minFeeWei?: bigint
  }) {
    return this.pool.createSweepPlan(params)
  }

  createBatchSweepPlan(params: {
    chain: string
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
    chain: string
    address: string
    privateKey: string
    balanceWei: bigint
    origin?: ChainUtxoOrigin
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chain: params.chain,
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
    chain: string
    address: string
    privateKey: string
    balanceWei: bigint
    ephemeralPubKey?: string
    txHash?: string
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chain: params.chain,
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
    chain: string
    address: string
    privateKey: string
    balanceWei: bigint
    derivationPath?: string
    index?: number
    origin?: 'subaccount' | 'change'
    label?: string
  }): ChainUtxoCoin {
    return this.pool.registerCoin({
      chain: params.chain,
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
    } = params

    if (inputs.length === 0) {
      throw new Error('At least one input coin is required')
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

    transaction.sign(...signers)

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
    chain: string
    address: string
    privateKey: string
    txId: string
    outputIndex: number
    satoshis: bigint
    origin?: ChainUtxoOrigin
    label?: string
  }): ChainUtxoCoin {
    return this.registerOutpoint({
      chain: params.chain,
      address: params.address,
      privateKey: params.privateKey,
      txid: params.txId,
      vout: params.outputIndex,
      balanceWei: params.satoshis,
      origin: params.origin,
      label: params.label,
    })
  }

  markOutpointSpent(
    txid: string,
    vout: number,
    chain?: string,
  ): ChainUtxoCoin | undefined {
    return this.pool.markOutpointSpent(txid, vout, chain)
  }

  trackSpentOutpoints(
    outpoints: Array<{ txid: string; vout: number }>,
    chain?: string,
  ): ChainUtxoCoin[] {
    return this.pool.trackSpentOutpoints(outpoints, chain)
  }

  getOutpoint(
    txid: string,
    vout: number,
    chain?: string,
  ): ChainUtxoCoin | undefined {
    return this.pool.getUtxoByOutpoint(txid, vout, chain)
  }

  isOutpointSpent(txid: string, vout: number, chain?: string): boolean {
    return this.pool.isOutpointSpent(txid, vout, chain)
  }
}

/**
 * Unified Chain UTXO Pool.
 *
 * Holds, indexes, selects, and tracks spendable accounts and coins across all
 * chains, families, keys, and derivation origins.
 */
export class ChainUtxoPool {
  private readonly coinsById = new Map<string, ChainUtxoCoin>()
  private readonly coinsByAddress = new Map<string, Set<string>>()
  private readonly cleanCoinIdsByChain = new Map<string, Set<string>>()
  private readonly pendingCoinIdsByChain = new Map<string, Set<string>>()
  private readonly coinsByOutpoint = new Map<string, string>()
  private readonly spentOutpointKeys = new Set<string>()

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

  chainKey(chain: string): string {
    return chain.toLowerCase()
  }

  private outpointKey(txid: string, vout: number, chain?: string): string {
    const base = `${txid.toLowerCase()}:${vout}`
    return chain ? `${this.chainKey(chain)}:${base}` : base
  }

  /**
   * Registers a coin directly into the inventory.
   */
  registerCoin(
    coin: Partial<ChainUtxoCoin> & {
      chain: string
      address: string
      privateKey: string
    },
  ): ChainUtxoCoin {
    const family = coin.family ?? inferChainFamily(coin.chain)
    const canonicalAddress = formatUtxoAddress(coin.address, coin.chain, family)
    const nonceOrOutpoint = coin.outpoint ?? coin.nonce ?? 0
    const id = coin.id ?? makeUtxoId(coin.chain, canonicalAddress, nonceOrOutpoint, family)

    // Check if this outpoint was already recorded as spent
    let status = coin.status ?? 'clean'
    let isSpentOutpoint = false
    if (coin.outpoint) {
      const opScoped = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout, coin.chain)
      const opGlobal = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout)
      if (this.spentOutpointKeys.has(opScoped) || this.spentOutpointKeys.has(opGlobal)) {
        status = 'spent'
        isSpentOutpoint = true
      }
    }

    const record: ChainUtxoCoin = {
      id,
      chain: coin.chain,
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
    }

    // Clean up previous indices if overwriting
    const existing = this.coinsById.get(id)
    if (existing) {
      this.removeFromIndices(existing)
    }

    this.coinsById.set(id, record)

    // Index by address
    const addrKey = normalizeUtxoAddress(canonicalAddress, coin.chain, family)
    let addrSet = this.coinsByAddress.get(addrKey)
    if (!addrSet) {
      addrSet = new Set<string>()
      this.coinsByAddress.set(addrKey, addrSet)
    }
    addrSet.add(id)

    // Index by status & chain
    const cKey = this.chainKey(coin.chain)
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
      const opScoped = this.outpointKey(record.outpoint.txid, record.outpoint.vout, record.chain)
      const opGlobal = this.outpointKey(record.outpoint.txid, record.outpoint.vout)
      this.coinsByOutpoint.set(opScoped, id)
      this.coinsByOutpoint.set(opGlobal, id)
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
    const cKey = this.chainKey(record.chain)
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
    const addrKey = normalizeUtxoAddress(record.address, record.chain, record.family)
    const addrSet = this.coinsByAddress.get(addrKey)
    if (addrSet) {
      addrSet.delete(record.id)
      if (addrSet.size === 0) {
        this.coinsByAddress.delete(addrKey)
      }
    }

    this.removeFromStatusIndices(record)

    if (record.outpoint) {
      const opScoped = this.outpointKey(record.outpoint.txid, record.outpoint.vout, record.chain)
      const opGlobal = this.outpointKey(record.outpoint.txid, record.outpoint.vout)
      this.coinsByOutpoint.delete(opScoped)
      this.coinsByOutpoint.delete(opGlobal)
    }
  }

  /**
   * Registers a native UTXO outpoint.
   */
  registerUtxoOutpoint(params: RegisterUtxoOutpointParams): ChainUtxoCoin {
    const family = params.family ?? 'utxo'
    const outpoint = { txid: params.txid, vout: params.vout }
    const canonicalAddress = formatUtxoAddress(params.address, params.chain, family)
    const id = makeUtxoId(params.chain, canonicalAddress, outpoint, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
    })
  }

  /**
   * Registers a stealth account.
   */
  registerStealthAccount(params: RegisterStealthParams): ChainUtxoCoin {
    const family = params.family ?? inferChainFamily(params.chain)
    const formattedAddress = formatUtxoAddress(params.address, params.chain, family)
    const id = makeUtxoId(params.chain, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
    const family = params.family ?? inferChainFamily(params.chain)
    const formattedAddress = formatUtxoAddress(params.address, params.chain, family)
    const id = makeUtxoId(params.chain, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
    const family = params.family ?? inferChainFamily(params.chain)
    const formattedAddress = formatUtxoAddress(params.address, params.chain, family)
    const id = makeUtxoId(params.chain, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
    const family = params.family ?? inferChainFamily(params.chain)
    const formattedAddress = formatUtxoAddress(params.address, params.chain, family)
    const id = makeUtxoId(params.chain, formattedAddress, 0, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
    const family = params.family ?? inferChainFamily(params.chain)
    const formattedAddress = formatUtxoAddress(params.address, params.chain, family)
    const nonce = params.nonce ?? 0
    const id = makeUtxoId(params.chain, formattedAddress, nonce, family)

    return this.registerCoin({
      id,
      chain: params.chain,
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
  getCoin(id: string): ChainUtxoCoin | undefined {
    return this.coinsById.get(id)
  }

  /**
   * Backwards-compatible alias for getCoin.
   */
  getUtxo(id: string): ChainUtxoCoin | undefined {
    return this.getCoin(id)
  }

  /**
   * Retrieves a coin by outpoint (txid and vout).
   */
  getUtxoByOutpoint(
    txid: string,
    vout: number,
    chain?: string,
  ): ChainUtxoCoin | undefined {
    const key = this.outpointKey(txid, vout, chain)
    const id = this.coinsByOutpoint.get(key)
    if (id) {
      return this.coinsById.get(id)
    }
    // Try global outpoint key fallback
    const globalKey = this.outpointKey(txid, vout)
    const globalId = this.coinsByOutpoint.get(globalKey)
    return globalId ? this.coinsById.get(globalId) : undefined
  }

  /**
   * Checks if an outpoint is marked spent.
   */
  isOutpointSpent(txid: string, vout: number, chain?: string): boolean {
    const keyScoped = this.outpointKey(txid, vout, chain)
    const keyGlobal = this.outpointKey(txid, vout)
    return this.spentOutpointKeys.has(keyScoped) || this.spentOutpointKeys.has(keyGlobal)
  }

  /**
   * Retrieves all coins associated with a specific address.
   */
  getCoinsByAddress(address: string, chain?: string): ChainUtxoCoin[] {
    const addrKey = normalizeUtxoAddress(address, chain)
    const ids = this.coinsByAddress.get(addrKey)
    if (!ids) return []
    const results: ChainUtxoCoin[] = []
    for (const id of ids) {
      const item = this.coinsById.get(id)
      if (item) {
        if (!chain || this.chainKey(item.chain) === this.chainKey(chain)) {
          results.push(item)
        }
      }
    }
    return results
  }

  /**
   * Backwards-compatible alias for getCoinsByAddress.
   */
  getUtxosByAddress(address: string, chain: string): ChainUtxoCoin[] {
    return this.getCoinsByAddress(address, chain)
  }

  /**
   * Retrieves all clean (unspent) coins for a given chain.
   */
  getCleanCoins(chain: string): ChainUtxoCoin[] {
    const cKey = this.chainKey(chain)
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
  getCleanUtxos(chain: string): ChainUtxoCoin[] {
    return this.getCleanCoins(chain)
  }

  /**
   * Retrieves all pending coins for a given chain.
   */
  getPendingCoins(chain: string): ChainUtxoCoin[] {
    const cKey = this.chainKey(chain)
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
  getPendingUtxos(chain: string): ChainUtxoCoin[] {
    return this.getPendingCoins(chain)
  }

  /**
   * Retrieves all coins in the pool, optionally filtered by chain.
   */
  getAllCoins(chain?: string): ChainUtxoCoin[] {
    const all = Array.from(this.coinsById.values())
    if (!chain) return all
    const cKey = this.chainKey(chain)
    return all.filter(u => this.chainKey(u.chain) === cKey)
  }

  /**
   * Backwards-compatible alias for getAllCoins.
   */
  getAllUtxos(chain?: string): ChainUtxoCoin[] {
    return this.getAllCoins(chain)
  }

  /**
   * Retrieves dirty accounts (nonce > 0 or status != 'clean' that still hold positive balance).
   */
  getDirtyCoins(chain: string): ChainUtxoCoin[] {
    const all = this.getAllCoins(chain)
    return all.filter(
      u =>
        u.balanceWei > 0n &&
        ((u.nonce !== undefined && u.nonce > 0) || u.status === 'spent'),
    )
  }

  /**
   * Backwards-compatible alias for getDirtyCoins.
   */
  getDirtyUtxos(chain: string): ChainUtxoCoin[] {
    return this.getDirtyCoins(chain)
  }

  /**
   * Computes total spendable balance for a chain.
   */
  getTotalBalance(chain: string, statusFilter: ChainUtxoStatus = 'clean'): bigint {
    let total = 0n
    for (const coin of this.getAllCoins(chain)) {
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

    const cKey = this.chainKey(coin.chain)
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

    const cKey = this.chainKey(coin.chain)
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
      const opScoped = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout, coin.chain)
      const opGlobal = this.outpointKey(coin.outpoint.txid, coin.outpoint.vout)
      this.spentOutpointKeys.add(opScoped)
      this.spentOutpointKeys.add(opGlobal)
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

    const cKey = this.chainKey(coin.chain)
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
    chain?: string,
  ): ChainUtxoCoin | undefined {
    const opScoped = this.outpointKey(txid, vout, chain)
    const opGlobal = this.outpointKey(txid, vout)
    this.spentOutpointKeys.add(opScoped)
    this.spentOutpointKeys.add(opGlobal)

    const coin = this.getUtxoByOutpoint(txid, vout, chain)
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
    chain?: string,
  ): ChainUtxoCoin[] {
    const spentCoins: ChainUtxoCoin[] = []
    for (const op of outpoints) {
      const spent = this.markOutpointSpent(op.txid, op.vout, chain)
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
      chain,
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

    const family = explicitFamily ?? inferChainFamily(chain)
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
      candidates = this.getAllCoins(chain).filter(
        u => u.status !== 'pending' && u.balanceWei > 0n,
      )
    } else {
      candidates = this.getCleanCoins(chain).filter(u => u.balanceWei > 0n)
    }

    if (!allowUnconfirmedDependencies) {
      candidates = candidates.filter(u => !u.requiresConfirmation)
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
        `Insufficient funds in AccountUtxoPool for ${chain}: no spendable coins found`,
      )
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
          `Insufficient funds in AccountUtxoPool for ${chain}: needed ${neededWei} wei, available ${totalSelectedWei} wei across ${candidates.length} coins`,
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
   * Executes atomic coin selection and state advance with automatic rollback on error.
   */
  async withAtomicSelection<T>(
    params: SelectCoinsParams,
    action: (selection: CoinSelectionResult) => Promise<T>,
  ): Promise<{ result: T; selection: CoinSelectionResult }> {
    const selection = this.selectCoins(params)
    for (const coin of selection.selected) {
      this.markPending(coin.id)
    }

    try {
      const result = await action(selection)
      return { result, selection }
    } catch (err) {
      for (const coin of selection.selected) {
        this.releasePending(coin.id)
      }
      throw err
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
    if (!coin.privateKey) {
      throw new Error(`UTXO ${coin.id} has no privateKey attached`)
    }
    return resolveSolanaKeypair(coin.privateKey)
  }

  /**
   * Creates a sweep plan for a dirty UTXO using geometric radix distribution.
   */
  createSweepPlan(params: {
    chain: string
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
      chain,
      dirtyUtxoId,
      changeAddresses,
      dustThresholdWei = 1_000n,
      minFeeWei = 21_000n,
    } = params

    const utxo = this.getCoin(dirtyUtxoId)
    if (!utxo) {
      throw new Error(`Dirty UTXO not found: ${dirtyUtxoId}`)
    }
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
        address: formatUtxoAddress(addr, chain, utxo.family),
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
    chain: string
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
      chain,
      dirtyUtxoIds,
      destinationAddresses,
      dustThresholdWei = 1_000n,
      minFeePerTxWei = 21_000n,
      maxChangeOutputs = destinationAddresses.length,
    } = params

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
        address: formatUtxoAddress(addr, chain, dirtyUtxos[0]?.family),
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

  /**
   * Creates a transactional View over this UTXO pool.
   * Enables staging unconfirmed change outputs, chaining child transactions off parents,
   * selecting from chained change outputs, and committing or rolling back atomically.
   */
  createView(): ChainUtxoView {
    return new ChainUtxoView(this)
  }
}

export interface ApplyTransactionParams {
  readonly chain: string
  readonly inputs: Array<ChainUtxoCoin | string>
  readonly changeOutputs?: Array<{
    readonly address: string
    readonly privateKey: string
    readonly balanceWei: bigint
    readonly family?: ChainFamily
    readonly nonce?: number
    readonly outpoint?: { txid: string; vout: number }
    readonly origin?: ChainUtxoOrigin
    readonly label?: string
    readonly parentTxHash?: string
    readonly requiresConfirmation?: boolean
  }>
  /** For EVM accounts that spent some balance: update the existing coin with new nonce and remaining balance */
  readonly updatedAccounts?: Array<{
    readonly id: string
    readonly remainingBalanceWei: bigint
    readonly nextNonce: number
  }>
}

/**
 * Transactional View over ChainUtxoPool.
 *
 * Implements a copy-on-write overlay over the underlying UTXO inventory:
 * - Selected/spent inputs are marked spent in the view without mutating the base pool.
 * - Change outputs and updated account balances are staged in the view.
 * - Subsequent transactions constructed in the same session can chain off staged change outputs.
 * - On success, commit() applies the changes to the base pool.
 * - On failure or cancellation, rollback() discards all staged changes.
 */
export class ChainUtxoView {
  private readonly spentCoinIds: Set<string> = new Set()
  private readonly stagedCoinsById: Map<string, ChainUtxoCoin> = new Map()

  constructor(private readonly basePool: ChainUtxoPool) {}

  /**
   * Returns all clean coins available in this view:
   * (Base pool clean coins NOT marked spent in this view) + (Clean coins created in this view)
   */
  getCleanCoins(chain: string): ChainUtxoCoin[] {
    const fromBase = this.basePool
      .getCleanCoins(chain)
      .filter(coin => !this.spentCoinIds.has(coin.id))
    const fromStaged = Array.from(this.stagedCoinsById.values()).filter(
      coin =>
        this.basePool.chainKey(coin.chain) === this.basePool.chainKey(chain) &&
        coin.status === 'clean' &&
        !this.spentCoinIds.has(coin.id),
    )
    return [...fromBase, ...fromStaged]
  }

  /**
   * Retrieves a coin by ID from this view (checking staged coins first, then base pool).
   */
  getCoin(id: string): ChainUtxoCoin | undefined {
    if (this.spentCoinIds.has(id)) {
      const staged = this.stagedCoinsById.get(id)
      return staged ?? this.basePool.getCoin(id)
    }
    return this.stagedCoinsById.get(id) ?? this.basePool.getCoin(id)
  }

  /**
   * Selects coins from the view's available inventory for transaction construction.
   * Can select from change outputs or accounts updated by earlier transactions in this view!
   */
  selectCoins(params: SelectCoinsParams): CoinSelectionResult {
    const {
      chain,
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

    const family = explicitFamily ?? inferChainFamily(chain)
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
      const baseAll = this.basePool
        .getAllCoins(chain)
        .filter(u => !this.spentCoinIds.has(u.id))
      const stagedAll = Array.from(this.stagedCoinsById.values()).filter(
        u =>
          this.basePool.chainKey(u.chain) === this.basePool.chainKey(chain) &&
          !this.spentCoinIds.has(u.id),
      )
      candidates = [...baseAll, ...stagedAll].filter(
        u => u.status !== 'pending' && u.balanceWei > 0n,
      )
    } else {
      candidates = this.getCleanCoins(chain).filter(u => u.balanceWei > 0n)
    }

    if (!allowUnconfirmedDependencies) {
      candidates = candidates.filter(u => !u.requiresConfirmation)
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
        `Insufficient funds in ChainUtxoView for ${chain}: no spendable coins found`,
      )
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
          `Insufficient funds in ChainUtxoView for ${chain}: needed ${neededWei} wei, available ${totalSelectedWei} wei across ${candidates.length} coins`,
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
   * Applies a newly constructed transaction to this view.
   * Consumes input coins and registers created change outputs / updated account states.
   */
  applyTransaction(params: ApplyTransactionParams): void {
    const { chain, inputs, changeOutputs = [], updatedAccounts = [] } = params

    // 1. Mark inputs as spent in this view
    for (const input of inputs) {
      const id = typeof input === 'string' ? input : input.id
      this.spentCoinIds.add(id)
      this.stagedCoinsById.delete(id)
    }

    // 2. Register fresh change outputs into stagedCoinsById
    for (const change of changeOutputs) {
      const family = change.family ?? inferChainFamily(chain)
      const formattedAddress = formatUtxoAddress(change.address, chain, family)
      const nonceOrOutpoint = change.outpoint ?? change.nonce ?? 0
      const id = makeUtxoId(chain, formattedAddress, nonceOrOutpoint, family)

      // Native UTXO mempools automatically chain unconfirmed outpoints (CPFP).
      // EVM nodes reject transactions from 0-balance child accounts until the funding tx confirms.
      const requiresConfirmation =
        change.requiresConfirmation ??
        (family === 'utxo'
          ? false
          : family === 'evm'
          ? true
          : true)

      const coin: ChainUtxoCoin = {
        id,
        chain,
        family,
        address: formattedAddress,
        privateKey: change.privateKey,
        balanceWei: change.balanceWei,
        nonce: change.nonce ?? (change.outpoint ? undefined : 0),
        outpoint: change.outpoint,
        status: 'clean',
        origin: change.origin ?? 'change',
        label: change.label ?? 'Chained Transaction Change Output',
        discoveredAt: Date.now(),
        lastUpdatedMs: Date.now(),
        parentTxHash: change.parentTxHash,
        requiresConfirmation,
      }
      this.stagedCoinsById.set(id, coin)
    }

    // 3. For EVM accounts whose balance was partially spent: update nonce & remaining balance
    for (const update of updatedAccounts) {
      const existing = this.getCoin(update.id)
      if (existing) {
        const family = existing.family
        const formattedAddress = existing.address
        const nextId = makeUtxoId(chain, formattedAddress, update.nextNonce, family)
        const updatedCoin: ChainUtxoCoin = {
          ...existing,
          id: nextId,
          nonce: update.nextNonce,
          balanceWei: update.remainingBalanceWei,
          status: 'clean',
          // Sequential nonces from the SAME EVM account are accepted and chained in the mempool automatically!
          requiresConfirmation: false,
          lastUpdatedMs: Date.now(),
        }
        this.stagedCoinsById.set(nextId, updatedCoin)
      }
    }
  }

  /**
   * Commits all changes staged in this view into the underlying ChainUtxoPool.
   * Consumed coins become 'pending', and created change outputs are registered.
   */
  commit(): void {
    for (const spentId of this.spentCoinIds) {
      if (this.basePool.getCoin(spentId)) {
        this.basePool.markPending(spentId)
      }
    }
    for (const stagedCoin of this.stagedCoinsById.values()) {
      this.basePool.registerCoin(stagedCoin)
    }
  }

  /**
   * Rolls back all staged changes in this view, leaving the base pool unaffected.
   */
  rollback(): void {
    this.spentCoinIds.clear()
    this.stagedCoinsById.clear()
  }

  /**
   * Helper to check if a coin ID has been spent within this view.
   */
  isSpentInView(id: string): boolean {
    return this.spentCoinIds.has(id)
  }

  /**
   * Retrieves all newly created coins staged in this view.
   */
  getStagedCoins(): ChainUtxoCoin[] {
    return Array.from(this.stagedCoinsById.values())
  }
}

/**
 * Backwards compatibility export alias for AccountUtxoPool.
 */
export const AccountUtxoPool = ChainUtxoPool

