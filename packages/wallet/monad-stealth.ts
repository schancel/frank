/**
 * Monad and EVM stealth direct payment engine (STEALTH-4).
 *
 * Implements DKSAP / secp256k1 ECDH stealth address derivation, transaction creation,
 * and recipient spendable keyring indexing without sweeping on receipt.
 */
import {
  computeAddress,
  getBytes,
  hexlify,
  randomBytes,
  SigningKey,
  Wallet,
  type Provider,
} from 'ethers'
import { fromHex, toHex } from '@frank/codec'
import { stealthSharedPoint } from '@frank/cashweb/relay/stealth-shared'
import { stealthPointDigest } from '@frank/cashweb/relay/stealth-point-digest'
import { stealthParentPublicKey } from '@frank/cashweb/relay/stealth-public'
import { stealthParentSecret } from '@frank/cashweb/relay/stealth-parent'
import type { StealthItem } from '@frank/cashweb/types/messages'
import { MonadAccountTxSigner, type MonadTxSubmitter } from './monad-account-tx'
import type { MonadChainWalletHandle } from './chain/monad-chain'

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export interface EvmStealthDestination {
  readonly ephemeralPubKey: Uint8Array
  readonly ephemeralSecret?: Uint8Array
  readonly stealthAddress: string
  readonly stealthPublicKey: Uint8Array
}

export interface EvmStealthDerivedAccount {
  readonly ephemeralPubKey: Uint8Array
  readonly stealthAddress: string
  readonly stealthPrivateKey: string
  readonly stealthPublicKey: Uint8Array
}

export interface StealthAccountRecord {
  readonly address: string
  readonly privateKey: string
  readonly ephemeralPubKey: string
  readonly networkTag: string
  readonly discoveredAtMs: number
  readonly initialAmountWei?: bigint
  readonly txHash?: string
  readonly nonce?: number
  readonly isClean?: boolean
  readonly isSpent?: boolean
  readonly balanceWei?: bigint
  readonly lastUpdatedMs?: number
}

function randomScalar(): Uint8Array {
  while (true) {
    const bytes = randomBytes(32)
    let val = 0n
    for (const b of bytes) {
      val = (val << 8n) | BigInt(b)
    }
    if (val > 0n && val < SECP256K1_ORDER) {
      return getBytes(bytes)
    }
  }
}

/**
 * Sender derivation: derive an ephemeral one-time EVM address using recipient's secp256k1 spend public key.
 */
export function deriveEvmStealthAddress(params: {
  recipientSpendPubKey: Uint8Array
  ephemeralSecret?: Uint8Array
}): EvmStealthDestination {
  const recipientPubKey = params.recipientSpendPubKey
  if (recipientPubKey.length !== 33 && recipientPubKey.length !== 65) {
    throw new Error(
      `recipientSpendPubKey must be 33 or 65 bytes, got ${recipientPubKey.length}`,
    )
  }

  const ephemeralSecret = params.ephemeralSecret ?? randomScalar()
  if (ephemeralSecret.length !== 32) {
    throw new Error(
      `ephemeralSecret must be 32 bytes, got ${ephemeralSecret.length}`,
    )
  }

  const ephemeralPubKey = getBytes(
    SigningKey.computePublicKey(ephemeralSecret, true),
  )
  const sharedPoint = stealthSharedPoint(ephemeralSecret, recipientPubKey)
  const digest = stealthPointDigest(sharedPoint)
  const stealthPublicKey = stealthParentPublicKey(recipientPubKey, digest)
  const stealthAddress = computeAddress(hexlify(stealthPublicKey))

  return {
    ephemeralPubKey,
    ephemeralSecret: params.ephemeralSecret,
    stealthAddress,
    stealthPublicKey,
  }
}

/**
 * Recipient derivation: derive the one-time private key and EVM address using recipient's spend secret
 * and the ephemeral public key from the incoming stealth item.
 */
export function deriveEvmStealthPrivateKey(params: {
  recipientSpendSecret: Uint8Array | string
  ephemeralPubKey: Uint8Array
}): EvmStealthDerivedAccount {
  const secretBytes =
    typeof params.recipientSpendSecret === 'string'
      ? fromHex(
          params.recipientSpendSecret.startsWith('0x')
            ? params.recipientSpendSecret.slice(2)
            : params.recipientSpendSecret,
        )
      : params.recipientSpendSecret

  if (secretBytes.length !== 32) {
    throw new Error(
      `recipientSpendSecret must be 32 bytes, got ${secretBytes.length}`,
    )
  }

  const ephemeralPubKey = params.ephemeralPubKey
  if (ephemeralPubKey.length !== 33 && ephemeralPubKey.length !== 65) {
    throw new Error(
      `ephemeralPubKey must be 33 or 65 bytes, got ${ephemeralPubKey.length}`,
    )
  }

  const { secret } = stealthParentSecret(secretBytes, ephemeralPubKey)
  const stealthPublicKey = getBytes(SigningKey.computePublicKey(secret, true))
  const stealthAddress = computeAddress(hexlify(stealthPublicKey))

  return {
    ephemeralPubKey,
    stealthAddress,
    stealthPrivateKey: '0x' + toHex(secret),
    stealthPublicKey,
  }
}

export interface MonadStealthKeyringStore {
  get(address: string): StealthAccountRecord | undefined
  put(record: StealthAccountRecord): Promise<void> | void
  all(): StealthAccountRecord[]
  close?(): Promise<void> | void
}

export class MemoryMonadStealthKeyringStore implements MonadStealthKeyringStore {
  private readonly records = new Map<string, StealthAccountRecord>()

  get(address: string): StealthAccountRecord | undefined {
    return this.records.get(address.toLowerCase())
  }

  put(record: StealthAccountRecord): void {
    this.records.set(record.address.toLowerCase(), { ...record })
  }

  all(): StealthAccountRecord[] {
    return [...this.records.values()]
  }
}

export const DEFAULT_STEALTH_BALANCE_CACHE_TTL_MS = 45_000

export interface MonadStealthKeyringOptions {
  balanceCacheTtlMs?: number
  onAccountAdded?: (record: StealthAccountRecord) => void
  onSpendRecorded?: (record: StealthAccountRecord) => void
  onBalanceUpdated?: (record: StealthAccountRecord) => void
}

/**
 * Keyring managing discovered stealth accounts without sweeping.
 * Funds stay in individual stealth accounts; the wallet spends directly from them.
 */
export class MonadStealthKeyring {
  private readonly store: MonadStealthKeyringStore
  private readonly balanceCacheTtlMs: number
  private readonly options?: MonadStealthKeyringOptions
  private readonly balanceCache = new Map<
    string,
    { balance: bigint; cachedAtMs: number }
  >()
  private readonly inFlightQueries = new Map<string, Promise<bigint>>()

  constructor(
    store?: MonadStealthKeyringStore,
    options?: MonadStealthKeyringOptions,
  ) {
    this.store = store ?? new MemoryMonadStealthKeyringStore()
    this.balanceCacheTtlMs =
      options?.balanceCacheTtlMs ?? DEFAULT_STEALTH_BALANCE_CACHE_TTL_MS
    this.options = options
  }

  private normalizeTag(networkTag?: string): string {
    return networkTag ? networkTag.toLowerCase() : '__all__'
  }

  /**
   * Invalidate in-memory total balance cache for a given networkTag or all tags.
   */
  invalidateBalanceCache(networkTag?: string): void {
    if (networkTag) {
      this.balanceCache.delete(networkTag.toLowerCase())
      this.balanceCache.delete('__all__')
      this.inFlightQueries.delete(networkTag.toLowerCase())
      this.inFlightQueries.delete('__all__')
    } else {
      this.balanceCache.clear()
      this.inFlightQueries.clear()
    }
  }

  async addAccount(record: StealthAccountRecord): Promise<boolean> {
    const existing = this.store.get(record.address)
    if (existing !== undefined) {
      return false
    }
    const fullRecord: StealthAccountRecord = {
      ...record,
      nonce: record.nonce ?? 0,
      isClean: record.isClean ?? true,
      isSpent: record.isSpent ?? false,
      balanceWei: record.balanceWei ?? record.initialAmountWei ?? 0n,
      lastUpdatedMs:
        record.lastUpdatedMs ?? record.discoveredAtMs ?? Date.now(),
    }
    await this.store.put(fullRecord)
    this.invalidateBalanceCache(record.networkTag)
    this.options?.onAccountAdded?.(fullRecord)
    return true
  }

  async recordSpend(
    address: string,
    details?: { valueWei?: bigint; txHash?: string },
  ): Promise<StealthAccountRecord | undefined> {
    const record = this.store.get(address)
    if (!record) {
      return undefined
    }
    const deduct = details?.valueWei ?? 0n
    const currentBalance = record.balanceWei ?? 0n
    const newBalance = currentBalance >= deduct ? currentBalance - deduct : 0n
    const updated: StealthAccountRecord = {
      ...record,
      isSpent: true,
      isClean: false,
      nonce: (record.nonce ?? 0) + 1,
      balanceWei: newBalance,
      lastUpdatedMs: Date.now(),
      ...(details?.txHash ? { txHash: details.txHash } : {}),
    }
    await this.store.put(updated)
    this.invalidateBalanceCache(record.networkTag)
    this.options?.onSpendRecorded?.(updated)
    return updated
  }

  async updateBalance(
    address: string,
    balance: bigint,
  ): Promise<StealthAccountRecord | undefined> {
    const record = this.store.get(address)
    if (!record) {
      return undefined
    }
    const updated: StealthAccountRecord = {
      ...record,
      balanceWei: balance,
      lastUpdatedMs: Date.now(),
    }
    await this.store.put(updated)
    this.invalidateBalanceCache(record.networkTag)
    this.options?.onBalanceUpdated?.(updated)
    return updated
  }

  hasAccount(address: string): boolean {
    return this.store.get(address) !== undefined
  }

  getAccount(address: string): StealthAccountRecord | undefined {
    return this.store.get(address)
  }

  getAccounts(networkTag?: string): StealthAccountRecord[] {
    const all = this.store.all()
    if (!networkTag) return all
    return all.filter(
      r => r.networkTag.toLowerCase() === networkTag.toLowerCase(),
    )
  }

  /**
   * Sums the spendable on-chain balance of all registered stealth accounts for a given network.
   * Skips spent accounts. Caches result in-memory with a TTL per networkTag.
   */
  async getTotalBalance(
    provider: Provider,
    networkTag?: string,
  ): Promise<bigint> {
    const cacheKey = this.normalizeTag(networkTag)
    const cached = this.balanceCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAtMs < this.balanceCacheTtlMs) {
      return cached.balance
    }

    const running = this.inFlightQueries.get(cacheKey)
    if (running) {
      return running
    }

    const queryPromise = (async () => {
      try {
        const accounts = this.getAccounts(networkTag).filter(a => !a.isSpent)
        if (accounts.length === 0) {
          this.balanceCache.set(cacheKey, { balance: 0n, cachedAtMs: Date.now() })
          return 0n
        }

        const balances = await Promise.all(
          accounts.map(async account => {
            try {
              const bal = await provider.getBalance(account.address)
              await this.updateBalance(account.address, bal)
              return bal
            } catch {
              return 0n
            }
          }),
        )

        const total = balances.reduce((sum, b) => sum + b, 0n)
        this.balanceCache.set(cacheKey, { balance: total, cachedAtMs: Date.now() })
        return total
      } finally {
        this.inFlightQueries.delete(cacheKey)
      }
    })()

    this.inFlightQueries.set(cacheKey, queryPromise)
    return queryPromise
  }

  /**
   * Discovers and indexes a stealth account from an incoming StealthItem (keyType === 1).
   */
  async registerFromStealthItem(params: {
    item: StealthItem
    recipientSpendSecret: Uint8Array | string
    timestampMs?: number
  }): Promise<EvmStealthDerivedAccount | undefined> {
    if (params.item.keyType !== 1 || !params.item.ephemeralPubKey) {
      return undefined
    }
    const ephPubBytes = fromHex(
      params.item.ephemeralPubKey.startsWith('0x')
        ? params.item.ephemeralPubKey.slice(2)
        : params.item.ephemeralPubKey,
    )
    const derived = deriveEvmStealthPrivateKey({
      recipientSpendSecret: params.recipientSpendSecret,
      ephemeralPubKey: ephPubBytes,
    })
    await this.addAccount({
      address: derived.stealthAddress,
      privateKey: derived.stealthPrivateKey,
      ephemeralPubKey: params.item.ephemeralPubKey,
      networkTag: params.item.networkTag ?? 'MONT',
      discoveredAtMs: params.timestampMs ?? Date.now(),
      initialAmountWei:
        params.item.amount !== undefined ? BigInt(params.item.amount) : undefined,
      txHash: params.item.transactions?.[0],
    })
    return derived
  }

  /**
   * Selects a single stealth account with sufficient balance to cover `neededWei`.
   * First pass: in-memory O(1) selection against unspent accounts with cached balance >= neededWei.
   * Second pass: bounded parallel verification of remaining unspent accounts.
   */
  async selectAccountForSpend(
    neededWei: bigint,
    provider: Provider,
    networkTag?: string,
  ): Promise<StealthAccountRecord | undefined> {
    const accounts = this.getAccounts(networkTag)

    // First pass (In-Memory O(1) selection): check all accounts for networkTag.
    // If an account has !account.isSpent && (account.balanceWei ?? 0n) >= neededWei,
    // select and return it immediately without any network calls!
    for (const account of accounts) {
      if (!account.isSpent && (account.balanceWei ?? 0n) >= neededWei) {
        return account
      }
    }

    // Second pass (Parallel Bounded Verification): if no cached account has enough balance,
    // filter out accounts where isSpent === true.
    const candidateAccounts = accounts.filter(account => !account.isSpent)
    if (candidateAccounts.length === 0) {
      return undefined
    }

    // Query balances concurrently in chunks of 6 using Promise.all
    const CHUNK_SIZE = 6
    for (let i = 0; i < candidateAccounts.length; i += CHUNK_SIZE) {
      const chunk = candidateAccounts.slice(i, i + CHUNK_SIZE)
      const results = await Promise.all(
        chunk.map(async account => {
          try {
            const bal = await provider.getBalance(account.address)
            await this.updateBalance(account.address, bal)
            return { account, balance: bal }
          } catch {
            return { account, balance: 0n }
          }
        }),
      )

      for (const res of results) {
        if (res.balance >= neededWei) {
          return (
            this.getAccount(res.account.address) ?? {
              ...res.account,
              balanceWei: res.balance,
            }
          )
        }
      }
    }

    return undefined
  }
}

export interface BuildEvmStealthPaymentParams {
  wallet: MonadChainWalletHandle
  recipientSpendPubKey: Uint8Array
  amountWei: bigint
  networkTag?: string
  memo?: string
  fromAddress?: string
}

export interface EvmStealthPaymentResult {
  stealthDestination: EvmStealthDestination
  txHash: string
  rawTransaction: string
  stealthItem: StealthItem
}

/**
 * Builds, signs, and broadcasts an on-chain EVM transfer to an ephemeral DKSAP stealth address.
 * Generates the corresponding StealthItem to include in direct messages.
 */
export async function buildEvmStealthPayment(
  params: BuildEvmStealthPaymentParams,
): Promise<EvmStealthPaymentResult> {
  const { wallet, recipientSpendPubKey, amountWei } = params
  if (amountWei <= 0n) {
    throw new Error('Transfer amount must be positive')
  }

  // 1. Derive one-time stealth destination address
  const stealthDestination = deriveEvmStealthAddress({ recipientSpendPubKey })

  // 2. Select funding account (main account or an un-swept stealth account)
  let fundingPrivateKey =
    wallet.identity?.toPrivateKeyHex() ??
    (wallet as any).mainAccount?.privateKey
  let selectedStealthAddress: string | undefined
  if (params.fromAddress) {
    const custom = wallet.stealthKeyring?.getAccount(params.fromAddress)
    if (custom) {
      fundingPrivateKey = custom.privateKey
      selectedStealthAddress = custom.address
    } else if (
      params.fromAddress.toLowerCase() !==
      (
        wallet.identity?.address.raw ??
        (wallet as any).mainAccount?.address
      )?.toLowerCase()
    ) {
      throw new Error(`Account ${params.fromAddress} not found in wallet`)
    }
  } else if (wallet.stealthKeyring) {
    // If main account has insufficient funds, try selecting a funded stealth account
    const mainAddress =
      wallet.identity?.address.raw ?? (wallet as any).mainAccount?.address
    const mainBal = mainAddress
      ? await wallet.provider.getBalance(mainAddress)
      : 0n
    if (mainBal < amountWei) {
      const selected = await wallet.stealthKeyring.selectAccountForSpend(
        amountWei,
        wallet.provider,
        params.networkTag,
      )
      if (selected) {
        fundingPrivateKey = selected.privateKey
        selectedStealthAddress = selected.address
      }
    }
  }

  // 3. Build and sign transaction
  const signer = new MonadAccountTxSigner({
    privateKey: fundingPrivateKey,
    provider: wallet.provider,
    httpClient: wallet.httpClient,
  })

  const signed = await signer.buildAndSignTransfer(
    stealthDestination.stealthAddress,
    amountWei,
  )

  // 4. Submit transaction to RPC
  const txHash = await wallet.httpClient.submitRawTransaction(
    signed.rawTx,
  )

  if (selectedStealthAddress && wallet.stealthKeyring) {
    await wallet.stealthKeyring.recordSpend(selectedStealthAddress, {
      valueWei: amountWei,
      txHash,
    })
  }

  // 5. Construct StealthItem
  const stealthItem: StealthItem = {
    type: 'stealth',
    networkTag: params.networkTag ?? 'MONT',
    keyType: 1,
    ephemeralPubKey: toHex(stealthDestination.ephemeralPubKey),
    transactions: [txHash],
    amount: Number(amountWei),
    ...(params.memo ? { memo: params.memo } : {}),
    // Compatibility fields
    chainId: params.networkTag ?? 'MONT',
  }

  return {
    stealthDestination,
    txHash,
    rawTransaction: signed.rawTx,
    stealthItem,
  }
}
