/**
 * Chain-Agnostic HD Address Inventory (Ticket #955).
 *
 * Provides single-use address allocation, clean/dirty account state management,
 * dynamic account selection, and change rotation across cryptographic curves:
 * - `EvmAddressInventory`: Specialization for EVM chains (secp256k1, coin 60),
 *   powering Monad, Ethereum, Hyperliquid, Tempo.
 * - `SolanaAddressInventory`: Specialization for Solana (ed25519, coin 501).
 * - `HdAddressInventory<TAccount>`: Generic core parameterized by account type and derivation curve.
 */

import { Provider, getAddress } from 'ethers'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  EvmHdKeyring,
  EvmChangeKeyring,
  type DerivedSubAccount,
  type DerivedChangeAccount,
  subAccountPathFor,
} from './secp256k1-hd-keyring'
import {
  SolanaHdKeyring,
  SolanaChangeKeyring,
  type Ed25519DerivedAccount,
} from './ed25519-hd-keyring'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import type { MonadDomainRoot } from './monad-domain-root'
import type { SolanaWalletConnection } from './solana-wallet'
import type {
  SubAccountRecord,
  SubAccountStatus,
} from './storage/sub-account-pool-storage'

export type HDAddressBranch = 'spend' | 'change'

export interface InventoryAccountRecord<TAccount = unknown> {
  /** BIP-44 branch: 'spend' or 'change'. */
  readonly branch: HDAddressBranch
  /** Sequential BIP-44 address index on this branch. */
  readonly index: number
  /** Formatted chain address (checksummed for EVM, base58 for Solana). */
  readonly address: string
  /** Full derivation path. */
  readonly path: string
  /** Ephemeral account keypair or details if already derived. */
  readonly account?: TAccount
  /** On-chain or cached balance in atomic units (wei, lamports, satoshis). */
  balanceWei: bigint
  /** On-chain or tracked transaction count (nonce). */
  nonce: number
  /** Whether the account has never been spent from (nonce === 0). */
  isClean: boolean
  /** Whether the account has been spent from (nonce > 0). */
  isSpent: boolean
  /** Milliseconds epoch of the last balance/nonce sync. */
  lastUpdatedMs?: number
}

export interface AccountSelectionOptions {
  /** Optional branch preference ('spend' or 'change'). If unspecified, selects the best fit across both. */
  branchPreference?: HDAddressBranch
  /** Allow selection of accounts with nonce > 0 (dirty accounts). Defaults to false (clean only). */
  allowDirty?: boolean
}

export type InventoryKeyringParams = {
  spendKeyring: EvmHdKeyring
  changeKeyring: EvmChangeKeyring
  initialLookahead?: number
}

export interface HdKeyringLike<TAccount> {
  deriveSubAccount(index: number): TAccount | Promise<TAccount>
  subAccountPath?(index: number): string
  deriveChangeAccount?(index: number): TAccount | Promise<TAccount>
}

export interface AddressDerivationResult<TAccount> {
  address: string
  path: string
  account?: TAccount
}

export interface HdAddressInventoryParams<TAccount> {
  spendKeyring: HdKeyringLike<TAccount>
  changeKeyring: HdKeyringLike<TAccount>
  initialLookahead?: number
  normalizeAddress?: (address: string) => string
  formatAddress?: (address: string) => string
  addressDeriver?: (
    branch: HDAddressBranch,
    index: number,
  ) => AddressDerivationResult<TAccount>
}

/**
 * Generic Hierarchical Deterministic Address Inventory.
 */
export class HdAddressInventory<TAccount = unknown> {
  readonly spendKeyring: HdKeyringLike<TAccount>
  readonly changeKeyring: HdKeyringLike<TAccount>

  protected readonly accountsByAddress = new Map<
    string,
    InventoryAccountRecord<TAccount>
  >()
  protected readonly accountsByKey = new Map<
    string,
    InventoryAccountRecord<TAccount>
  >()

  protected nextSpendIndex = 0
  protected nextChangeIndex = 0

  protected readonly normalizeAddress: (address: string) => string
  protected readonly formatAddress: (address: string) => string
  protected readonly addressDeriver: (
    branch: HDAddressBranch,
    index: number,
  ) => AddressDerivationResult<TAccount>

  constructor(params: HdAddressInventoryParams<TAccount>) {
    this.spendKeyring = params.spendKeyring
    this.changeKeyring = params.changeKeyring
    this.normalizeAddress = params.normalizeAddress ?? (addr => addr)
    this.formatAddress = params.formatAddress ?? (addr => addr)

    if (params.addressDeriver) {
      this.addressDeriver = params.addressDeriver
    } else {
      this.addressDeriver = (branch: HDAddressBranch, index: number) => {
        const keyring =
          branch === 'spend' ? this.spendKeyring : this.changeKeyring
        const k = keyring as unknown as {
          deriveNode?(path: string): { base58Address: string }
          subAccountPath?(i: number): string
          deriveSubAccount(i: number): TAccount
          deriveChangeAccount?(i: number): TAccount
        }

        if (
          typeof k.deriveNode === 'function' &&
          typeof k.subAccountPath === 'function'
        ) {
          const path = k.subAccountPath(index)
          const node = k.deriveNode(path)
          return { address: node.base58Address, path }
        }

        const derived =
          branch === 'change' && typeof k.deriveChangeAccount === 'function'
            ? k.deriveChangeAccount(index)
            : k.deriveSubAccount(index)

        const acc = derived as unknown as { address: string; path?: string }
        const path =
          typeof k.subAccountPath === 'function'
            ? k.subAccountPath(index)
            : acc.path ?? `${branch}/${index}`

        return { address: acc.address, path, account: derived }
      }
    }

    const lookahead = params.initialLookahead ?? 10
    this.ensureIndexed('spend', lookahead)
    this.ensureIndexed('change', lookahead)
  }

  protected static key(branch: HDAddressBranch, index: number): string {
    return `${branch}:${index}`
  }

  /**
   * Pre-derives and registers addresses up to `count` indices on the given branch.
   */
  ensureIndexed(branch: HDAddressBranch, count: number): void {
    if (count <= 0) return
    for (let i = 0; i < count; i++) {
      const key = HdAddressInventory.key(branch, i)
      if (this.accountsByKey.has(key)) continue

      const derived = this.addressDeriver(branch, i)
      const formatted = this.formatAddress(derived.address)
      const normalized = this.normalizeAddress(formatted)

      const record: InventoryAccountRecord<TAccount> = {
        branch,
        index: i,
        address: formatted,
        path: derived.path,
        account: derived.account,
        balanceWei: 0n,
        nonce: 0,
        isClean: true,
        isSpent: false,
      }

      this.accountsByKey.set(key, record)
      this.accountsByAddress.set(normalized, record)

      if (branch === 'spend') {
        if (i >= this.nextSpendIndex) this.nextSpendIndex = i + 1
      } else {
        if (i >= this.nextChangeIndex) this.nextChangeIndex = i + 1
      }
    }
  }

  /** Allocates the next fresh spend address. */
  allocateNextSpendAddress(): InventoryAccountRecord<TAccount> {
    const index = this.nextSpendIndex
    this.ensureIndexed('spend', index + 1)
    const record = this.accountsByKey.get(
      HdAddressInventory.key('spend', index),
    )!
    this.nextSpendIndex = index + 1
    return record
  }

  /** Allocates the next fresh change address. */
  allocateNextChangeAddress(): InventoryAccountRecord<TAccount> {
    const index = this.nextChangeIndex
    this.ensureIndexed('change', index + 1)
    const record = this.accountsByKey.get(
      HdAddressInventory.key('change', index),
    )!
    this.nextChangeIndex = index + 1
    return record
  }

  /** Lookup an account by formatted, checksummed, or raw address. */
  getAccount(address: string): InventoryAccountRecord<TAccount> | undefined {
    return this.accountsByAddress.get(this.normalizeAddress(address))
  }

  /** Lookup an account by branch and index. */
  getByIndex(
    branch: HDAddressBranch,
    index: number,
  ): InventoryAccountRecord<TAccount> | undefined {
    this.ensureIndexed(branch, index + 1)
    return this.accountsByKey.get(HdAddressInventory.key(branch, index))
  }

  /** All accounts currently tracked by this inventory. */
  getAllAccounts(): InventoryAccountRecord<TAccount>[] {
    return Array.from(this.accountsByKey.values())
  }

  /** All spend branch accounts. */
  getSpendAccounts(): InventoryAccountRecord<TAccount>[] {
    return this.getAllAccounts().filter(acc => acc.branch === 'spend')
  }

  /** All change branch accounts. */
  getChangeAccounts(): InventoryAccountRecord<TAccount>[] {
    return this.getAllAccounts().filter(acc => acc.branch === 'change')
  }

  /** Updates the local balance record for an address. */
  updateBalance(address: string, balanceWei: bigint): void {
    const record = this.getAccount(address)
    if (record) {
      record.balanceWei = balanceWei
      record.lastUpdatedMs = Date.now()
    }
  }

  /** Updates the local nonce record for an address. */
  updateNonce(address: string, nonce: number): void {
    const record = this.getAccount(address)
    if (record) {
      record.nonce = nonce
      record.isClean = nonce === 0
      record.isSpent = nonce > 0
      record.lastUpdatedMs = Date.now()
    }
  }

  /** Records that an account has been spent from, updating its nonce and deducted balance. */
  recordSpend(
    address: string,
    details?: { txHash?: string; valueWei?: bigint },
  ): void {
    const record = this.getAccount(address)
    if (record) {
      record.nonce += 1
      record.isClean = false
      record.isSpent = true
      if (
        details?.valueWei !== undefined &&
        record.balanceWei >= details.valueWei
      ) {
        record.balanceWei -= details.valueWei
      }
      record.lastUpdatedMs = Date.now()
    }
  }

  /**
   * Ingests a generic transaction sync item (Ticket #1115), immediately updating local
   * account nonces, clean/spent flags, and balances across devices without waiting for RPC scans.
   */
  processSyncTransaction(item: {
    direction: 'in' | 'out'
    txHash?: string
    spentInputs?: ReadonlyArray<{
      address: string
      nonce?: number
      valueWei?: string | bigint
    }>
    createdOutputs?: ReadonlyArray<{
      address: string
      valueWei?: string | bigint
      branch?: HDAddressBranch | string
      index?: number
    }>
    transfer?: {
      destination: string
      value: string | bigint
    }
    timestamp?: number
  }): { affectedAccounts: string[] } {
    const affected: string[] = []
    const now = item.timestamp ?? Date.now()

    if (item.direction === 'out') {
      if (item.spentInputs) {
        for (const input of item.spentInputs) {
          const record = this.getAccount(input.address)
          if (record) {
            if (input.nonce !== undefined) {
              record.nonce = Math.max(record.nonce, input.nonce + 1)
            } else {
              record.nonce += 1
            }
            record.isClean = false
            record.isSpent = true
            if (input.valueWei !== undefined) {
              const val = BigInt(input.valueWei)
              if (record.balanceWei >= val) {
                record.balanceWei -= val
              } else {
                record.balanceWei = 0n
              }
            }
            record.lastUpdatedMs = now
            affected.push(record.address)
          }
        }
      }

      if (item.createdOutputs) {
        for (const output of item.createdOutputs) {
          const record = this.getAccount(output.address)
          if (record && output.valueWei !== undefined) {
            record.balanceWei += BigInt(output.valueWei)
            record.lastUpdatedMs = now
            affected.push(record.address)
          }
        }
      }
    } else if (item.direction === 'in') {
      if (item.createdOutputs) {
        for (const output of item.createdOutputs) {
          const record = this.getAccount(output.address)
          if (record && output.valueWei !== undefined) {
            record.balanceWei += BigInt(output.valueWei)
            record.lastUpdatedMs = now
            affected.push(record.address)
          }
        }
      }
      if (item.transfer) {
        const record = this.getAccount(item.transfer.destination)
        if (record && item.transfer.value !== undefined) {
          record.balanceWei += BigInt(item.transfer.value)
          record.lastUpdatedMs = now
          affected.push(record.address)
        }
      }
    }

    return { affectedAccounts: affected }
  }

  /**
   * Dynamic Account Selection:
   * Selects clean accounts (nonce === 0) covering the target amount + fee reserve.
   */
  selectAccountForSpend(
    amountWei: bigint,
    gasReserveWei: bigint,
    options?: AccountSelectionOptions,
  ): InventoryAccountRecord<TAccount> | undefined {
    const totalRequired = amountWei + gasReserveWei
    const candidates = this.getAllAccounts().filter(acc => {
      if (!options?.allowDirty && (!acc.isClean || acc.nonce > 0)) {
        return false
      }
      return acc.balanceWei >= totalRequired
    })

    if (candidates.length === 0) {
      return undefined
    }

    candidates.sort((a, b) => {
      if (options?.branchPreference) {
        if (
          a.branch === options.branchPreference &&
          b.branch !== options.branchPreference
        )
          return -1
        if (
          a.branch !== options.branchPreference &&
          b.branch === options.branchPreference
        )
          return 1
      }
      const excessA = a.balanceWei - totalRequired
      const excessB = b.balanceWei - totalRequired
      if (excessA < excessB) return -1
      if (excessA > excessB) return 1
      return a.index - b.index
    })

    return candidates[0]
  }

  /**
   * Finds a minimal set of clean accounts whose aggregated balance covers `targetAmountWei`.
   */
  findConsolidationCandidates(targetAmountWei: bigint): {
    accounts: InventoryAccountRecord<TAccount>[]
    totalBalanceWei: bigint
    coversTarget: boolean
  } {
    const cleanAccounts = this.getAllAccounts()
      .filter(acc => acc.isClean && acc.nonce === 0 && acc.balanceWei > 0n)
      .sort((a, b) =>
        b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0,
      )

    const selected: InventoryAccountRecord<TAccount>[] = []
    let total = 0n

    for (const acc of cleanAccounts) {
      selected.push(acc)
      total += acc.balanceWei
      if (total >= targetAmountWei) {
        break
      }
    }

    return {
      accounts: selected,
      totalBalanceWei: total,
      coversTarget: total >= targetAmountWei,
    }
  }
}

/**
 * EVM Specialization of HD Address Inventory (secp256k1, coin 60).
 * Powers Monad, Ethereum L1, Sepolia, Holesky, Base, Hyperliquid, Tempo.
 */
export class EvmAddressInventory extends HdAddressInventory<DerivedSubAccount> {
  override readonly spendKeyring: EvmHdKeyring
  override readonly changeKeyring: EvmChangeKeyring

  constructor(params: {
    spendKeyring: EvmHdKeyring
    changeKeyring: EvmChangeKeyring
    initialLookahead?: number
  }) {
    super({
      spendKeyring: params.spendKeyring,
      changeKeyring: params.changeKeyring,
      initialLookahead: params.initialLookahead,
      normalizeAddress: addr => addr.toLowerCase(),
      formatAddress: addr => getAddress(addr),
    })
    this.spendKeyring = params.spendKeyring
    this.changeKeyring = params.changeKeyring
  }

  static fromKeyrings(params: {
    spendKeyring: EvmHdKeyring
    changeKeyring: EvmChangeKeyring
    initialLookahead?: number
  }): EvmAddressInventory {
    return new EvmAddressInventory(params)
  }

  static fromDomainRoot(
    domainRoot: MonadDomainRoot<'evm-wallet'>,
    initialLookahead = 10,
  ): EvmAddressInventory {
    return new EvmAddressInventory({
      spendKeyring: EvmHdKeyring.fromDomainRoot(domainRoot),
      changeKeyring: EvmChangeKeyring.fromDomainRoot(domainRoot),
      initialLookahead,
    })
  }

  static fromMnemonic(
    mnemonic: string,
    passphrase = '',
    initialLookahead = 10,
  ): EvmAddressInventory {
    return new EvmAddressInventory({
      spendKeyring: EvmHdKeyring.fromMnemonic(mnemonic, passphrase),
      changeKeyring: EvmChangeKeyring.fromMnemonic(mnemonic, passphrase),
      initialLookahead,
    })
  }

  /**
   * Instantiates an EVM signer for the given account address or lookup tuple.
   */
  getSigner(
    addressOrLookup: string | { branch: HDAddressBranch; index: number },
    params: { provider: Provider; httpClient: MonadTxSubmitter },
  ): MonadAccountTxSigner {
    let branch: HDAddressBranch
    let index: number

    if (typeof addressOrLookup === 'string') {
      const record = this.getAccount(addressOrLookup)
      if (!record) {
        throw new Error(
          `Address ${addressOrLookup} is not part of this inventory`,
        )
      }
      branch = record.branch
      index = record.index
    } else {
      branch = addressOrLookup.branch
      index = addressOrLookup.index
    }

    const privateKey =
      branch === 'spend'
        ? this.spendKeyring.deriveSubAccount(index).privateKey
        : this.changeKeyring.deriveChangeAccount(index).privateKey

    return new MonadAccountTxSigner({
      privateKey,
      provider: params.provider,
      httpClient: params.httpClient,
    })
  }

  /**
   * Scans on-chain balances and nonces for all indexed accounts up to `lookahead`.
   */
  async scanBalances(
    provider: Provider,
    lookahead = 10,
  ): Promise<InventoryAccountRecord<DerivedSubAccount>[]> {
    this.ensureIndexed('spend', lookahead)
    this.ensureIndexed('change', lookahead)

    const accounts = this.getAllAccounts().filter(acc => acc.index < lookahead)
    await Promise.all(
      accounts.map(async account => {
        try {
          const [balance, nonce] = await Promise.all([
            provider.getBalance(account.address),
            provider.getTransactionCount(account.address, 'pending'),
          ])
          account.balanceWei = balance
          account.nonce = nonce
          account.isClean = nonce === 0
          account.isSpent = nonce > 0
          account.lastUpdatedMs = Date.now()
        } catch {
          // If network query fails, keep existing record
        }
      }),
    )
    return accounts
  }

  /**
   * Converts an inventory account to legacy SubAccountRecord format.
   */
  toSubAccountRecord(
    record: InventoryAccountRecord<DerivedSubAccount>,
  ): SubAccountRecord {
    const status: SubAccountStatus = record.isSpent
      ? 'spent'
      : record.balanceWei > 0n
      ? 'available'
      : 'unfunded'

    return {
      index: record.index,
      address: record.address,
      status,
      lifecycle: record.isSpent
        ? {
            spend: {
              rawTx: '0x',
              txHash: '0x',
              valueWei: '0',
            },
          }
        : undefined,
    }
  }
}

/**
 * Solana Specialization of HD Address Inventory (ed25519, coin 501).
 * Powers deterministic Solana sub-account allocation and change rotation.
 */
export class SolanaAddressInventory extends HdAddressInventory<Ed25519DerivedAccount> {
  override readonly spendKeyring: SolanaHdKeyring
  override readonly changeKeyring: SolanaChangeKeyring

  constructor(params: {
    spendKeyring: SolanaHdKeyring
    changeKeyring: SolanaChangeKeyring
    initialLookahead?: number
  }) {
    super({
      spendKeyring: params.spendKeyring,
      changeKeyring: params.changeKeyring,
      initialLookahead: params.initialLookahead,
      normalizeAddress: addr => addr, // Solana Base58 is case-sensitive!
      formatAddress: addr => addr,
      addressDeriver: (branch, index) => {
        const keyring =
          branch === 'spend' ? params.spendKeyring : params.changeKeyring
        const path = keyring.subAccountPath(index)
        const node = keyring.deriveNode(path)
        return { address: node.base58Address, path }
      },
    })
    this.spendKeyring = params.spendKeyring
    this.changeKeyring = params.changeKeyring
  }

  static fromKeyrings(params: {
    spendKeyring: SolanaHdKeyring
    changeKeyring: SolanaChangeKeyring
    initialLookahead?: number
  }): SolanaAddressInventory {
    return new SolanaAddressInventory(params)
  }

  static async fromMnemonic(
    mnemonic: string,
    passphrase = '',
    initialLookahead = 10,
  ): Promise<SolanaAddressInventory> {
    const spendKeyring = await SolanaHdKeyring.fromMnemonic(
      mnemonic,
      passphrase,
    )
    const changeKeyring = await SolanaChangeKeyring.fromMnemonic(
      mnemonic,
      passphrase,
    )
    return new SolanaAddressInventory({
      spendKeyring,
      changeKeyring,
      initialLookahead,
    })
  }

  static fromSeed(
    seed: Uint8Array,
    initialLookahead = 10,
  ): SolanaAddressInventory {
    const spendKeyring = SolanaHdKeyring.fromSeed(seed)
    const changeKeyring = SolanaChangeKeyring.fromSeed(seed)
    return new SolanaAddressInventory({
      spendKeyring,
      changeKeyring,
      initialLookahead,
    })
  }

  /**
   * Resolves the full Keypair for an account address or index tuple.
   */
  async getSignerKeypair(
    addressOrLookup: string | { branch: HDAddressBranch; index: number },
  ): Promise<Keypair> {
    let branch: HDAddressBranch
    let index: number

    if (typeof addressOrLookup === 'string') {
      const record = this.getAccount(addressOrLookup)
      if (!record) {
        throw new Error(
          `Address ${addressOrLookup} is not part of this inventory`,
        )
      }
      branch = record.branch
      index = record.index
    } else {
      branch = addressOrLookup.branch
      index = addressOrLookup.index
    }

    const keyring = branch === 'spend' ? this.spendKeyring : this.changeKeyring
    const derived = await keyring.deriveSubAccount(index)
    return derived.keypair
  }

  /**
   * Scans on-chain balances for all indexed accounts up to lookahead.
   */
  async scanBalances(
    connection: SolanaWalletConnection,
    lookahead = 10,
  ): Promise<InventoryAccountRecord<Ed25519DerivedAccount>[]> {
    this.ensureIndexed('spend', lookahead)
    this.ensureIndexed('change', lookahead)

    const accounts = this.getAllAccounts().filter(acc => acc.index < lookahead)
    await Promise.all(
      accounts.map(async account => {
        try {
          const bal = await connection.getBalance(
            new PublicKey(account.address),
          )
          account.balanceWei = BigInt(bal)
          account.lastUpdatedMs = Date.now()
        } catch {
          // If network query fails, keep existing balance
        }
      }),
    )
    return accounts
  }
}
