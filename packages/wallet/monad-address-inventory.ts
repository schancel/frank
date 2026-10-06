/**
 * Unified HD Address Inventory for Monad / EVM (Ticket #924).
 *
 * Deprecates the rigid "Burn Pool", "Change Pool", and multi-phase "Promotion"
 * states in favor of a single, unified HD address inventory that manages both
 * spend (m/44'/60'/0'/0/i) and change (m/44'/60'/0'/1/i) addresses dynamically.
 *
 * ## Architecture: Autonomous Mixing Without Custody
 * Every user's wallet operates as its own independent UTXO-style mixing node on standard EVM accounts:
 * - Single-use spend accounts (m/44'/60'/0'/0/i) and change accounts (m/44'/60'/0'/1/i).
 * - No explicit "promotion" transactions: funds deposited or swept into ANY derived address
 *   (spend or change branch) are immediately spendable once confirmed.
 * - Dynamic Account Selection: query inventory for any clean address (nonce === 0)
 *   whose balance covers `amount + gasReserve`.
 * - Shatters on-chain clustering heuristics by exploding the search space of ambiguous directed edges.
 */

import { Provider, getAddress } from 'ethers'
import {
  MonadHdKeyring,
  DerivedSubAccount,
  subAccountPath,
} from './monad-hd-keyring'
import {
  MonadChangeKeyring,
  DerivedChangeAccount,
  changeAccountPath,
} from './monad-change-keyring'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import type { MonadDomainRoot } from './monad-domain-root'
import type {
  SubAccountRecord,
  SubAccountStatus,
} from './storage/sub-account-pool-storage'

export type HDAddressBranch = 'spend' | 'change'

export interface InventoryAccountRecord {
  /** BIP-44 branch: 'spend' (m/44'/60'/0'/0/i) or 'change' (m/44'/60'/0'/1/i). */
  readonly branch: HDAddressBranch
  /** Sequential BIP-44 address index on this branch. */
  readonly index: number
  /** Checksummed Ethereum address. */
  readonly address: string
  /** Full BIP-44 derivation path. */
  readonly path: string
  /** On-chain or cached balance in Wei. */
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

export interface InventoryKeyringParams {
  spendKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  initialLookahead?: number
}

export class MonadAddressInventory {
  readonly spendKeyring: MonadHdKeyring
  readonly changeKeyring: MonadChangeKeyring

  private readonly accountsByAddress = new Map<string, InventoryAccountRecord>()
  private readonly accountsByKey = new Map<string, InventoryAccountRecord>()

  private nextSpendIndex = 0
  private nextChangeIndex = 0

  constructor(params: InventoryKeyringParams) {
    this.spendKeyring = params.spendKeyring
    this.changeKeyring = params.changeKeyring

    const lookahead = params.initialLookahead ?? 10
    this.ensureIndexed('spend', lookahead)
    this.ensureIndexed('change', lookahead)
  }

  static fromKeyrings(params: InventoryKeyringParams): MonadAddressInventory {
    return new MonadAddressInventory(params)
  }

  static fromDomainRoot(
    domainRoot: MonadDomainRoot<'evm-wallet'>,
    initialLookahead = 10,
  ): MonadAddressInventory {
    return new MonadAddressInventory({
      spendKeyring: MonadHdKeyring.fromDomainRoot(domainRoot),
      changeKeyring: MonadChangeKeyring.fromDomainRoot(domainRoot),
      initialLookahead,
    })
  }

  static fromMnemonic(
    mnemonic: string,
    passphrase = '',
    initialLookahead = 10,
  ): MonadAddressInventory {
    return new MonadAddressInventory({
      spendKeyring: MonadHdKeyring.fromMnemonic(mnemonic, passphrase),
      changeKeyring: MonadChangeKeyring.fromMnemonic(mnemonic, passphrase),
      initialLookahead,
    })
  }

  private static key(branch: HDAddressBranch, index: number): string {
    return `${branch}:${index}`
  }

  /**
   * Pre-derives and registers addresses up to `count` indices on the given branch.
   */
  ensureIndexed(branch: HDAddressBranch, count: number): void {
    if (count <= 0) return
    for (let i = 0; i < count; i++) {
      const key = MonadAddressInventory.key(branch, i)
      if (this.accountsByKey.has(key)) continue

      if (branch === 'spend') {
        const derived = this.spendKeyring.deriveSubAccount(i)
        const checksum = getAddress(derived.address)
        const record: InventoryAccountRecord = {
          branch: 'spend',
          index: i,
          address: checksum,
          path: subAccountPath(i),
          balanceWei: 0n,
          nonce: 0,
          isClean: true,
          isSpent: false,
        }
        this.accountsByKey.set(key, record)
        this.accountsByAddress.set(checksum.toLowerCase(), record)
        if (i >= this.nextSpendIndex) this.nextSpendIndex = i + 1
      } else {
        const derived = this.changeKeyring.deriveChangeAccount(i)
        const checksum = getAddress(derived.address)
        const record: InventoryAccountRecord = {
          branch: 'change',
          index: i,
          address: checksum,
          path: changeAccountPath(i),
          balanceWei: 0n,
          nonce: 0,
          isClean: true,
          isSpent: false,
        }
        this.accountsByKey.set(key, record)
        this.accountsByAddress.set(checksum.toLowerCase(), record)
        if (i >= this.nextChangeIndex) this.nextChangeIndex = i + 1
      }
    }
  }

  /** Allocates the next fresh spend address (m/44'/60'/0'/0/k). */
  allocateNextSpendAddress(): InventoryAccountRecord {
    const index = this.nextSpendIndex
    this.ensureIndexed('spend', index + 1)
    const record = this.accountsByKey.get(
      MonadAddressInventory.key('spend', index),
    )!
    this.nextSpendIndex = index + 1
    return record
  }

  /** Allocates the next fresh change address (m/44'/60'/0'/1/k). */
  allocateNextChangeAddress(): InventoryAccountRecord {
    const index = this.nextChangeIndex
    this.ensureIndexed('change', index + 1)
    const record = this.accountsByKey.get(
      MonadAddressInventory.key('change', index),
    )!
    this.nextChangeIndex = index + 1
    return record
  }

  /** Lookup an account by checksummed or lowercased address. */
  getAccount(address: string): InventoryAccountRecord | undefined {
    return this.accountsByAddress.get(address.toLowerCase())
  }

  /** Lookup an account by branch and index. */
  getByIndex(
    branch: HDAddressBranch,
    index: number,
  ): InventoryAccountRecord | undefined {
    this.ensureIndexed(branch, index + 1)
    return this.accountsByKey.get(MonadAddressInventory.key(branch, index))
  }

  /** All accounts currently tracked by this inventory. */
  getAllAccounts(): InventoryAccountRecord[] {
    return Array.from(this.accountsByKey.values())
  }

  /** All spend branch accounts (m/44'/60'/0'/0/i). */
  getSpendAccounts(): InventoryAccountRecord[] {
    return this.getAllAccounts().filter(acc => acc.branch === 'spend')
  }

  /** All change branch accounts (m/44'/60'/0'/1/i). */
  getChangeAccounts(): InventoryAccountRecord[] {
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
   * Scans on-chain balances and nonces for all indexed accounts up to `lookahead`.
   */
  async scanBalances(
    provider: Provider,
    lookahead = 10,
  ): Promise<InventoryAccountRecord[]> {
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
   * Dynamic Account Selection (Ticket #924).
   *
   * Query inventory for any clean address (nonce === 0) whose balance covers `amountWei + gasReserveWei`.
   * Evaluates across BOTH spend and change branches without requiring arbitrary "promotion" steps.
   *
   * Selection strategy:
   * 1. Filters by cleanliness and balance sufficiency.
   * 2. Selects "best fit" (minimum balance surplus to minimize leftover change fragmentation).
   * 3. Breaks ties deterministically by index and branch preference.
   */
  selectAccountForSpend(
    amountWei: bigint,
    gasReserveWei: bigint,
    options?: AccountSelectionOptions,
  ): InventoryAccountRecord | undefined {
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

    // Sort by:
    // 1. Branch preference (if specified)
    // 2. Best fit: smallest excess balance
    // 3. Lowest index
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
   * Useful for bundle transactions or triggering background balance consolidation.
   */
  findConsolidationCandidates(targetAmountWei: bigint): {
    accounts: InventoryAccountRecord[]
    totalBalanceWei: bigint
    coversTarget: boolean
  } {
    const cleanAccounts = this.getAllAccounts()
      .filter(acc => acc.isClean && acc.nonce === 0 && acc.balanceWei > 0n)
      .sort((a, b) =>
        b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0,
      )

    const selected: InventoryAccountRecord[] = []
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

  /**
   * Instantiates a signer for the given account address or lookup tuple.
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
   * Converts an inventory account to the legacy `SubAccountRecord` shape for compatibility.
   */
  toSubAccountRecord(record: InventoryAccountRecord): SubAccountRecord {
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
