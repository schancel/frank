/**
 * Unified Account UTXO Pool (Issue #1184).
 *
 * Unifies Monad, EVM, and multi-chain spendable accounts across all key origins:
 * - Pre-derived HD sub-accounts (BIP-44 m/44'/60'/0'/0/i)
 * - Derived HD change accounts (BIP-44 m/44'/60'/0'/1/k)
 * - Non-HD ephemeral stealth accounts derived via DKSAP / ECDH
 * - Imported / main sweep accounts
 *
 * Core architectural guarantees (matching Stamp):
 * 1. Attached Private Keys: Every AccountUtxo directly holds its privateKey hex
 *    for instantaneous O(1) signing without secondary keystore queries or re-derivation.
 * 2. Instant In-Memory Selection: Outbound transactions select best-fit coins in O(1)
 *    memory time with zero blocking network RPCs.
 * 3. Decoy Magnitude Pairing & Radix Splits: Change calculations use continuous
 *    geometric radix splitting with +/-15% entropy jitter and recipient OOM avoidance.
 * 4. Atomic State Advance: When a transaction broadcasts, the spent UTXO is immediately
 *    marked 'pending' to eliminate concurrent send nonce races. Fresh change outputs
 *    ([changeAccount, 0]) are registered with status 'clean'.
 * 5. Autonomous Sweeper Compatibility: Integrates seamlessly with MonadAccountHygieneEngine
 *    for sweeping dirty (nonce > 0) or fragmented dust coins into clean change accounts.
 */

import { getAddress, Provider } from 'ethers'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import {
  computeGeometricRadixChangeSplits,
  orderOfMagnitude2,
} from './monad-change-distribution'

export type AccountChain = 'monad' | 'solana' | 'evm' | (string & {})

export type AccountUtxoOrigin = 'stealth' | 'subaccount' | 'change' | 'main'

export type AccountUtxoStatus = 'clean' | 'pending' | 'spent'

export interface AccountUtxo {
  /** Composite key: `${chain}:${address}:${nonce}` */
  readonly id: string
  readonly chain: AccountChain
  /** Formatted chain address (checksummed for EVM/Monad, base58 for Solana) */
  readonly address: string
  /**
   * Private key hex (or bs58/hex secret key) attached directly to the UTXO record.
   * Enables instant O(1) signing without secondary keystore lookups.
   */
  readonly privateKey: string
  /** On-chain or tracked transaction count (nonce). */
  nonce: number
  /** Balance in atomic units (wei for EVM/Monad, lamports for Solana). */
  balanceWei: bigint
  /** Origin source of this spendable key */
  readonly origin: AccountUtxoOrigin
  /**
   * Lifecycle status:
   * - 'clean': Nonce == 0 and unspent, ready for single-use transactions
   * - 'pending': Broadcast submitted, transaction in flight, coin temporarily locked
   * - 'spent': Confirmed spent (nonce advanced), never reused as a clean single-use account
   */
  status: AccountUtxoStatus
  /** Optional human or protocol label */
  label?: string
  /** Milliseconds epoch when this UTXO was derived or discovered */
  discoveredAt: number
  /** Milliseconds epoch when this UTXO was last updated or refreshed */
  lastUpdatedMs?: number
  /** Derivation path if derived from an HD tree */
  derivationPath?: string
  /** Ephemeral public key if derived from stealth ECDH */
  ephemeralPubKey?: string
  /** Transaction hash that funded this UTXO (if known) */
  txHash?: string
}

export interface SelectCoinsParams {
  readonly chain: AccountChain
  readonly targetAmountWei: bigint
  readonly feeReserveWei?: bigint
  /** If true, allow accounts with nonce > 0 (dirty accounts). Defaults to false (clean only). */
  readonly allowDirty?: boolean
  /** Filter by origin: 'stealth' | 'subaccount' | 'change' | 'main' (any if omitted) */
  readonly originPreference?: AccountUtxoOrigin
  /**
   * Decoy pairing / Avoidance strategy:
   * When paying V, generate change splits avoiding order-of-magnitude collision with V.
   * Defaults to true.
   */
  readonly decoyAvoidance?: boolean
  /** Minimum output amount to avoid dust creation. Defaults to 1_000n. */
  readonly dustThresholdWei?: bigint
  /** Estimated transaction fee per change output. Defaults to 21_000n. */
  readonly minFeePerTxWei?: bigint
  /** Maximum number of change split outputs. Defaults to 5. */
  readonly maxChangeOutputs?: number
}

export interface CoinSelectionResult {
  readonly selected: AccountUtxo[]
  readonly totalSelectedWei: bigint
  readonly changeWei: bigint
  /** Suggested geometric radix change splits conforming to monad-change-distribution */
  readonly suggestedChangeSplits: bigint[]
}

export interface RegisterChangeParams {
  readonly chain: AccountChain
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly derivationPath?: string
  readonly label?: string
}

export interface RegisterStealthParams {
  readonly chain: AccountChain
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly ephemeralPubKey?: string
  readonly txHash?: string
  readonly label?: string
}

export interface RegisterSubAccountParams {
  readonly chain: AccountChain
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface RegisterChangeAccountParams {
  readonly chain: AccountChain
  readonly address: string
  readonly privateKey: string
  readonly balanceWei: bigint
  readonly derivationPath?: string
  readonly index?: number
  readonly label?: string
}

export interface ImportKeyParams {
  readonly chain: AccountChain
  readonly address: string
  readonly privateKey: string
  readonly balanceWei?: bigint
  readonly nonce?: number
  readonly origin?: AccountUtxoOrigin
  readonly label?: string
}

/**
 * Normalizes an address string for dictionary/set keys.
 */
export function normalizeUtxoAddress(
  address: string,
  chain: AccountChain,
): string {
  const c = chain.toLowerCase()
  if (c === 'monad' || c === 'evm' || address.startsWith('0x')) {
    return address.toLowerCase()
  }
  return address.trim()
}

/**
 * Formats an address string for display/storage.
 */
export function formatUtxoAddress(
  address: string,
  chain: AccountChain,
): string {
  const c = chain.toLowerCase()
  if (c === 'monad' || c === 'evm' || address.startsWith('0x')) {
    try {
      return getAddress(address)
    } catch {
      return address.toLowerCase()
    }
  }
  return address.trim()
}

/**
 * Formats a canonical UTXO id: `${chain}:${address}:${nonce}`.
 */
export function makeUtxoId(
  chain: AccountChain,
  address: string,
  nonce: number,
): string {
  return `${chain.toLowerCase()}:${normalizeUtxoAddress(
    address,
    chain,
  )}:${nonce}`
}

/**
 * Unified Account UTXO Pool.
 *
 * Holds, indexes, selects, and tracks spendable accounts and nonces across all
 * keys and derivation origins.
 */
export class AccountUtxoPool {
  private readonly utxosById = new Map<string, AccountUtxo>()
  private readonly utxosByAddress = new Map<string, Set<string>>()
  private readonly cleanUtxoIdsByChain = new Map<string, Set<string>>()
  private readonly pendingUtxoIdsByChain = new Map<string, Set<string>>()

  constructor(initialUtxos: AccountUtxo[] = []) {
    for (const utxo of initialUtxos) {
      this.registerUtxo(utxo)
    }
  }

  private chainKey(chain: AccountChain): string {
    return chain.toLowerCase()
  }

  /**
   * Registers an AccountUtxo directly into the inventory.
   */
  registerUtxo(utxo: AccountUtxo): AccountUtxo {
    const canonicalAddress = formatUtxoAddress(utxo.address, utxo.chain)
    const id = makeUtxoId(utxo.chain, canonicalAddress, utxo.nonce)

    const record: AccountUtxo = {
      ...utxo,
      id,
      address: canonicalAddress,
    }

    // If overwriting an existing record, clean up indices first
    const existing = this.utxosById.get(id)
    if (existing) {
      this.removeFromIndices(existing)
    }

    this.utxosById.set(id, record)

    // Index by address
    const addrKey = normalizeUtxoAddress(canonicalAddress, utxo.chain)
    let addrSet = this.utxosByAddress.get(addrKey)
    if (!addrSet) {
      addrSet = new Set<string>()
      this.utxosByAddress.set(addrKey, addrSet)
    }
    addrSet.add(id)

    // Index by status & chain
    const cKey = this.chainKey(utxo.chain)
    if (record.status === 'clean') {
      let cleanSet = this.cleanUtxoIdsByChain.get(cKey)
      if (!cleanSet) {
        cleanSet = new Set<string>()
        this.cleanUtxoIdsByChain.set(cKey, cleanSet)
      }
      cleanSet.add(id)
    } else if (record.status === 'pending') {
      let pendingSet = this.pendingUtxoIdsByChain.get(cKey)
      if (!pendingSet) {
        pendingSet = new Set<string>()
        this.pendingUtxoIdsByChain.set(cKey, pendingSet)
      }
      pendingSet.add(id)
    }

    return record
  }

  private removeFromStatusIndices(record: AccountUtxo): void {
    const cKey = this.chainKey(record.chain)
    const cleanSet = this.cleanUtxoIdsByChain.get(cKey)
    if (cleanSet) {
      cleanSet.delete(record.id)
    }
    const pendingSet = this.pendingUtxoIdsByChain.get(cKey)
    if (pendingSet) {
      pendingSet.delete(record.id)
    }
  }

  private removeFromIndices(record: AccountUtxo): void {
    const addrKey = normalizeUtxoAddress(record.address, record.chain)
    const addrSet = this.utxosByAddress.get(addrKey)
    if (addrSet) {
      addrSet.delete(record.id)
      if (addrSet.size === 0) {
        this.utxosByAddress.delete(addrKey)
      }
    }

    this.removeFromStatusIndices(record)
  }

  /**
   * Registers a discovered stealth account into the UTXO pool.
   */
  registerStealthAccount(params: RegisterStealthParams): AccountUtxo {
    const formattedAddress = formatUtxoAddress(params.address, params.chain)
    const utxo: AccountUtxo = {
      id: makeUtxoId(params.chain, formattedAddress, 0),
      chain: params.chain,
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
    }
    return this.registerUtxo(utxo)
  }

  /**
   * Registers a pre-derived HD sub-account into the UTXO pool.
   */
  registerSubAccount(params: RegisterSubAccountParams): AccountUtxo {
    const formattedAddress = formatUtxoAddress(params.address, params.chain)
    const utxo: AccountUtxo = {
      id: makeUtxoId(params.chain, formattedAddress, 0),
      chain: params.chain,
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
    }
    return this.registerUtxo(utxo)
  }

  /**
   * Registers an HD change account into the UTXO pool.
   */
  registerChangeAccount(params: RegisterChangeAccountParams): AccountUtxo {
    const formattedAddress = formatUtxoAddress(params.address, params.chain)
    const utxo: AccountUtxo = {
      id: makeUtxoId(params.chain, formattedAddress, 0),
      chain: params.chain,
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
    }
    return this.registerUtxo(utxo)
  }

  /**
   * Registers a fresh change output resulting from a spend transaction.
   */
  registerChangeOutput(params: RegisterChangeParams): AccountUtxo {
    const formattedAddress = formatUtxoAddress(params.address, params.chain)
    const utxo: AccountUtxo = {
      id: makeUtxoId(params.chain, formattedAddress, 0),
      chain: params.chain,
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
    }
    return this.registerUtxo(utxo)
  }

  /**
   * Imports an arbitrary private key into the pool.
   */
  importPrivateKey(params: ImportKeyParams): AccountUtxo {
    const formattedAddress = formatUtxoAddress(params.address, params.chain)
    const nonce = params.nonce ?? 0
    const utxo: AccountUtxo = {
      id: makeUtxoId(params.chain, formattedAddress, nonce),
      chain: params.chain,
      address: formattedAddress,
      privateKey: params.privateKey,
      nonce,
      balanceWei: params.balanceWei ?? 0n,
      origin: params.origin ?? 'main',
      status: nonce === 0 ? 'clean' : 'spent',
      label: params.label ?? 'Imported Account',
      discoveredAt: Date.now(),
      lastUpdatedMs: Date.now(),
    }
    return this.registerUtxo(utxo)
  }

  /**
   * Retrieves a UTXO by its unique composite id.
   */
  getUtxo(id: string): AccountUtxo | undefined {
    return this.utxosById.get(id)
  }

  /**
   * Retrieves all UTXOs associated with a specific address.
   */
  getUtxosByAddress(address: string, chain: AccountChain): AccountUtxo[] {
    const addrKey = normalizeUtxoAddress(address, chain)
    const ids = this.utxosByAddress.get(addrKey)
    if (!ids) return []
    const results: AccountUtxo[] = []
    for (const id of ids) {
      const item = this.utxosById.get(id)
      if (item) results.push(item)
    }
    return results
  }

  /**
   * Retrieves all clean (unspent, nonce == 0) UTXOs for a given chain.
   */
  getCleanUtxos(chain: AccountChain): AccountUtxo[] {
    const cKey = this.chainKey(chain)
    const ids = this.cleanUtxoIdsByChain.get(cKey)
    if (!ids) return []
    const results: AccountUtxo[] = []
    for (const id of ids) {
      const item = this.utxosById.get(id)
      if (item && item.status === 'clean') {
        results.push(item)
      }
    }
    return results
  }

  /**
   * Retrieves all pending UTXOs for a given chain.
   */
  getPendingUtxos(chain: AccountChain): AccountUtxo[] {
    const cKey = this.chainKey(chain)
    const ids = this.pendingUtxoIdsByChain.get(cKey)
    if (!ids) return []
    const results: AccountUtxo[] = []
    for (const id of ids) {
      const item = this.utxosById.get(id)
      if (item && item.status === 'pending') {
        results.push(item)
      }
    }
    return results
  }

  /**
   * Retrieves all UTXOs in the pool, optionally filtered by chain.
   */
  getAllUtxos(chain?: AccountChain): AccountUtxo[] {
    const all = Array.from(this.utxosById.values())
    if (!chain) return all
    const cKey = this.chainKey(chain)
    return all.filter(u => this.chainKey(u.chain) === cKey)
  }

  /**
   * Retrieves dirty accounts (accounts with nonce > 0 or status != 'clean' that still hold balance).
   */
  getDirtyUtxos(chain: AccountChain): AccountUtxo[] {
    const all = this.getAllUtxos(chain)
    return all.filter(
      u => u.balanceWei > 0n && (u.nonce > 0 || u.status === 'spent'),
    )
  }

  /**
   * Computes the total spendable balance for a chain.
   */
  getTotalBalance(
    chain: AccountChain,
    statusFilter: AccountUtxoStatus = 'clean',
  ): bigint {
    let total = 0n
    for (const utxo of this.getAllUtxos(chain)) {
      if (utxo.status === statusFilter) {
        total += utxo.balanceWei
      }
    }
    return total
  }

  /**
   * Atomically marks a UTXO as 'pending' upon transaction broadcast.
   * Immediately prevents the coin from being selected by any concurrent send.
   */
  markPending(id: string): AccountUtxo {
    const utxo = this.utxosById.get(id)
    if (!utxo) {
      throw new Error(`UTXO not found: ${id}`)
    }
    if (utxo.status === 'spent') {
      throw new Error(`Cannot mark already spent UTXO as pending: ${id}`)
    }

    const cKey = this.chainKey(utxo.chain)
    const cleanSet = this.cleanUtxoIdsByChain.get(cKey)
    if (cleanSet) cleanSet.delete(id)

    utxo.status = 'pending'
    utxo.lastUpdatedMs = Date.now()

    let pendingSet = this.pendingUtxoIdsByChain.get(cKey)
    if (!pendingSet) {
      pendingSet = new Set<string>()
      this.pendingUtxoIdsByChain.set(cKey, pendingSet)
    }
    pendingSet.add(id)

    return utxo
  }

  /**
   * Marks a UTXO as permanently spent after on-chain confirmation.
   */
  markSpent(id: string, finalNonce?: number): AccountUtxo {
    const utxo = this.utxosById.get(id)
    if (!utxo) {
      throw new Error(`UTXO not found: ${id}`)
    }

    const cKey = this.chainKey(utxo.chain)
    const cleanSet = this.cleanUtxoIdsByChain.get(cKey)
    if (cleanSet) cleanSet.delete(id)
    const pendingSet = this.pendingUtxoIdsByChain.get(cKey)
    if (pendingSet) pendingSet.delete(id)

    utxo.status = 'spent'
    if (finalNonce !== undefined) {
      utxo.nonce = finalNonce
    } else {
      utxo.nonce = Math.max(1, utxo.nonce + 1)
    }
    utxo.balanceWei = 0n
    utxo.lastUpdatedMs = Date.now()

    return utxo
  }

  /**
   * Releases a pending UTXO back to 'clean' if a transaction broadcast failed.
   */
  releasePending(id: string): AccountUtxo {
    const utxo = this.utxosById.get(id)
    if (!utxo) {
      throw new Error(`UTXO not found: ${id}`)
    }
    if (utxo.status !== 'pending') {
      return utxo
    }

    const cKey = this.chainKey(utxo.chain)
    const pendingSet = this.pendingUtxoIdsByChain.get(cKey)
    if (pendingSet) pendingSet.delete(id)

    utxo.status = 'clean'
    utxo.lastUpdatedMs = Date.now()

    let cleanSet = this.cleanUtxoIdsByChain.get(cKey)
    if (!cleanSet) {
      cleanSet = new Set<string>()
      this.cleanUtxoIdsByChain.set(cKey, cleanSet)
    }
    cleanSet.add(id)

    return utxo
  }

  /**
   * Updates balance and nonce for an existing UTXO.
   */
  updateBalanceAndNonce(params: {
    id: string
    balanceWei: bigint
    nonce: number
  }): AccountUtxo {
    const utxo = this.utxosById.get(params.id)
    if (!utxo) {
      throw new Error(`UTXO not found: ${params.id}`)
    }

    utxo.balanceWei = params.balanceWei
    utxo.nonce = params.nonce
    utxo.lastUpdatedMs = Date.now()

    if (params.nonce > 0 && utxo.status === 'clean') {
      // Nonce incremented externally -> transition to spent/dirty
      this.removeFromStatusIndices(utxo)
      utxo.status = 'spent'
    }

    return utxo
  }

  /**
   * Selects best-fit spendable coins in O(1) memory time without network roundtrips.
   *
   * Strategy:
   * 1. Query clean UTXOs conforming to origin preference and allowDirty options.
   * 2. Attempt best single-coin fit: find the smallest UTXO >= (targetAmount + feeReserve).
   * 3. If no single coin covers the amount, use greedy largest-first combination.
   * 4. Calculate change outputs using geometric radix splitting with entropy jitter,
   *    avoiding order-of-magnitude collision with recipient payment amount.
   */
  selectCoins(params: SelectCoinsParams): CoinSelectionResult {
    const {
      chain,
      targetAmountWei,
      feeReserveWei = 0n,
      allowDirty = false,
      originPreference,
      decoyAvoidance = true,
      dustThresholdWei = 1_000n,
      minFeePerTxWei = 21_000n,
      maxChangeOutputs = 5,
    } = params

    const neededWei = targetAmountWei + feeReserveWei
    if (neededWei <= 0n) {
      return {
        selected: [],
        totalSelectedWei: 0n,
        changeWei: 0n,
        suggestedChangeSplits: [],
      }
    }

    let candidates: AccountUtxo[] = []
    if (allowDirty) {
      candidates = this.getAllUtxos(chain).filter(
        u => u.status !== 'pending' && u.balanceWei > 0n,
      )
    } else {
      candidates = this.getCleanUtxos(chain).filter(u => u.balanceWei > 0n)
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

    // 1. Check for single coin best-fit: smallest coin >= neededWei
    const singleCovers = candidates
      .filter(u => u.balanceWei >= neededWei)
      .sort((a, b) =>
        a.balanceWei < b.balanceWei ? -1 : a.balanceWei > b.balanceWei ? 1 : 0,
      )

    let selected: AccountUtxo[] = []
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
   * Instantiates a MonadAccountTxSigner directly from the attached private key.
   * O(1) instantaneous operation without secondary keyring queries.
   */
  createSigner(
    utxoOrId: AccountUtxo | string,
    provider?: Provider,
    httpClient?: MonadTxSubmitter,
  ): MonadAccountTxSigner {
    const utxo =
      typeof utxoOrId === 'string' ? this.getUtxo(utxoOrId) : utxoOrId
    if (!utxo) {
      throw new Error(`UTXO not found: ${utxoOrId}`)
    }
    if (!utxo.privateKey) {
      throw new Error(`UTXO ${utxo.id} has no privateKey attached`)
    }

    const defaultSubmitter: MonadTxSubmitter = {
      submitRawTransaction: async () => '0xmock',
      getTransactionReceipt: async () => undefined,
    }

    return new MonadAccountTxSigner({
      privateKey: utxo.privateKey,
      provider: (provider ?? ({} as any)) as Provider,
      httpClient: httpClient ?? defaultSubmitter,
    })
  }

  /**
   * Creates a sweep plan for a dirty UTXO using geometric radix distribution.
   */
  createSweepPlan(params: {
    chain: AccountChain
    dirtyUtxoId: string
    changeAddresses: string[]
    dustThresholdWei?: bigint
    minFeeWei?: bigint
  }): {
    dirtyUtxo: AccountUtxo
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

    const utxo = this.getUtxo(dirtyUtxoId)
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
        address: formatUtxoAddress(addr, chain),
        amountWei: splits[i],
      })
    }

    return {
      dirtyUtxo: utxo,
      totalSweepableWei: availableWei,
      changeOutputs,
    }
  }
}
