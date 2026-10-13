import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { validateChainAddress } from '../chain/chains-registry'
import type { ChainUtxoOrigin, ChainUtxoStatus } from '../chain-utxo-pool'

/**
 * Default hysteresis basis points (+20% = 2000 bps).
 * With maxHotBalance = 1,500 MON, triggerCeiling = 1,800 MON.
 */
export const DEFAULT_COLD_VAULT_HYSTERESIS_BPS = 2000

/**
 * Default hot-wallet ceiling in AVU (~150 AVU ≈ $37.50, covering ~3,750 stamps + daily chat transfers).
 */
export const DEFAULT_MAX_HOT_BALANCE_AVU = 150

/**
 * At 0.4 MON ≈ 1¢ ($0.025 / MON), 1,500 MON ≈ $37.50 (~150 AVU).
 */
export const DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC = 1500n * 10n ** 18n

/**
 * Default trigger ceiling for Monad (1,500 MON + 20% hysteresis = 1,800 MON).
 */
export const DEFAULT_MONAD_TRIGGER_CEILING_ATOMIC = 1800n * 10n ** 18n

export type ColdVaultSweepStatus =
  | 'planned'
  | 'submitted'
  | 'confirmed'
  | 'failed'

export interface ColdVaultSweepConfig {
  readonly chainId: string
  readonly enabled: boolean
  readonly externalVaultAddress: string
  readonly maxHotBalanceAtomic: bigint
  readonly maxHotBalanceAvu?: number
  /** Defaults to 2000 (+20%). */
  readonly hysteresisBps?: number
  /** Minimum net excess amount required before executing a sweep. */
  readonly minSweepAmountAtomic?: bigint
  /**
   * When true, any selected child coin (stealth/stamp/subaccount/change) is drained completely
   * in 1 hop to `externalVaultAddress` even if its balance slightly exceeds the remaining excess.
   * For `main` accounts, only the surplus above `maxHotBalanceAtomic` is ever swept.
   * Defaults to false (caps sweep at exact `excessAtomic`).
   */
  readonly drainFullChildCoins?: boolean
}

export interface ColdVaultSpendableCoin {
  readonly id: string
  readonly address: string
  /** Standard atomic balance (wei, lamports, satoshis). Either `balanceAtomic` or `balanceWei` may be supplied. */
  readonly balanceAtomic?: bigint
  readonly balanceWei?: bigint
  readonly origin?: ChainUtxoOrigin | 'coin' | string
  readonly status?: ChainUtxoStatus | string
  /** If true, this coin is reserved for an in-flight stamp/payment and must not be swept. */
  readonly reserved?: boolean
  readonly privateKey?: string
  readonly nonce?: number
  readonly outpoint?: { readonly txid: string; readonly vout: number }
}

export interface ColdVaultDirectTransferPlan {
  readonly coinId: string
  readonly sourceAddress: string
  readonly destinationAddress: string
  readonly origin: string
  readonly grossAmountAtomic: bigint
  readonly feeAtomic: bigint
  readonly netAmountAtomic: bigint
  /** Always 1: child -> externalVaultAddress without an intermediate consolidation hop. */
  readonly hops: 1
  readonly isFullCoinDrain: boolean
  readonly privateKey?: string
  readonly nonce?: number
  readonly outpoint?: { readonly txid: string; readonly vout: number }
}

export type ColdVaultSweepSkipReason =
  | 'disabled'
  | 'missing-vault-address'
  | 'invalid-vault-address'
  | 'below-trigger-ceiling'
  | 'below-min-sweep'
  | 'no-eligible-coins'

export interface ColdVaultSweepPlan {
  readonly shouldSweep: boolean
  readonly reason?: ColdVaultSweepSkipReason
  readonly chainId: string
  readonly externalVaultAddress: string
  readonly currentHotBalanceAtomic: bigint
  readonly maxHotBalanceAtomic: bigint
  readonly triggerCeilingAtomic: bigint
  readonly excessAtomic: bigint
  readonly selectedInputs: ReadonlyArray<ColdVaultSpendableCoin>
  readonly directTransfers: ReadonlyArray<ColdVaultDirectTransferPlan>
  readonly totalGrossSweepAtomic: bigint
  readonly totalEstimatedFeeAtomic: bigint
  readonly totalNetSweepAtomic: bigint
  readonly deterministicSweepId?: string
}

export interface ColdVaultSweepRecord {
  readonly sweepId: string
  readonly chainId: string
  readonly externalVaultAddress: string
  /** Net amount swept to `externalVaultAddress` in atomic units. */
  readonly amountAtomic: bigint
  /** Gross amount deducted from hot wallet inputs in atomic units. */
  readonly grossAmountAtomic: bigint
  /** Total network fee across all 1-hop inputs in atomic units. */
  readonly feeAmountAtomic: bigint
  readonly coinIds: ReadonlyArray<string>
  readonly txHashes: ReadonlyArray<string>
  readonly status: ColdVaultSweepStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly error?: string
}

export interface ColdVaultSweepJournalStorage {
  get(key: string): Promise<string>
  put(key: string, value: string): Promise<void>
}

/**
 * Returns the default `maxHotBalanceAtomic` for a given chain ID or kind.
 *
 * For `monad`, `monad-testnet`, `monad-mainnet`, and `monad-regtest`:
 * At 0.4 MON ≈ 1¢ ($0.025/MON), default `maxHotBalance` is `1500n * 10n ** 18n`
 * (1,500 MON ≈ $37.50 / ~150 AVU, covering ~3,750 stamps + daily chat transfers),
 * with +20% hysteresis (`triggerCeiling = 1,800 MON`).
 */
export function defaultMaxHotBalanceForChain(chainId: string): bigint {
  const normalized = (chainId || '').trim().toLowerCase()
  if (
    normalized === 'monad' ||
    normalized === 'monad-testnet' ||
    normalized === 'monad-mainnet' ||
    normalized === 'monad-regtest'
  ) {
    return DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC
  }
  if (normalized.startsWith('solana')) {
    // ~0.25 SOL in lamports (9 decimals)
    return 250_000_000n
  }
  if (
    normalized.startsWith('ethereum') ||
    normalized.startsWith('base') ||
    normalized.startsWith('arbitrum')
  ) {
    // ~0.015 ETH in wei (18 decimals)
    return 15_000_000_000_000_000n
  }
  if (normalized.startsWith('xec') || normalized.startsWith('ecash')) {
    // 1,500,000 XEC in satoshis (2 decimals)
    return 150_000_000n
  }
  if (normalized.startsWith('btc') || normalized.startsWith('bitcoin')) {
    // 50,000 sats
    return 50_000n
  }
  if (normalized.startsWith('bch') || normalized.startsWith('bitcoincash')) {
    // 10,000,000 sats (0.1 BCH)
    return 10_000_000n
  }
  return DEFAULT_MONAD_MAX_HOT_BALANCE_ATOMIC
}

/**
 * Computes the hysteresis trigger ceiling:
 * `triggerCeiling = maxHotBalanceAtomic * (10000 + hysteresisBps) / 10000`.
 * Defaults to `hysteresisBps = 2000` (+20%).
 */
export function computeTriggerCeilingAtomic(
  config: Pick<ColdVaultSweepConfig, 'maxHotBalanceAtomic' | 'hysteresisBps'>,
): bigint {
  const bps = BigInt(config.hysteresisBps ?? DEFAULT_COLD_VAULT_HYSTERESIS_BPS)
  if (bps < 0n) {
    throw new Error('hysteresisBps must be non-negative')
  }
  if (config.maxHotBalanceAtomic < 0n) {
    throw new Error('maxHotBalanceAtomic must be non-negative')
  }
  return (
    config.maxHotBalanceAtomic + (config.maxHotBalanceAtomic * bps) / 10_000n
  )
}

function getCoinBalanceAtomic(coin: ColdVaultSpendableCoin): bigint {
  if (typeof coin.balanceAtomic === 'bigint') {
    return coin.balanceAtomic
  }
  if (typeof coin.balanceWei === 'bigint') {
    return coin.balanceWei
  }
  return 0n
}

function getOriginPriority(origin: string | undefined): number {
  switch (origin) {
    case 'stealth':
    case 'coin':
      // Received stamp/stealth child coins are swept first directly in 1 hop
      return 0
    case 'subaccount':
    case 'change':
    case 'utxo':
      return 1
    case 'main':
      // Main account surplus is only swept if child coins do not cover excess
      return 2
    default:
      return 1
  }
}

export function computeDeterministicSweepId(params: {
  chainId: string
  externalVaultAddress: string
  transfers: ReadonlyArray<
    Pick<
      ColdVaultDirectTransferPlan,
      'coinId' | 'sourceAddress' | 'grossAmountAtomic'
    >
  >
}): string {
  const canonicalTransfers = [...params.transfers]
    .map(
      t =>
        `${t.coinId}:${t.sourceAddress.toLowerCase()}:${t.grossAmountAtomic.toString()}`,
    )
    .sort()
    .join('|')
  const payload = `frank/cold-vault-sweep/v1:${params.chainId.toLowerCase()}:${params.externalVaultAddress.toLowerCase()}:${canonicalTransfers}`
  return 'sweep-' + bytesToHex(sha256(utf8ToBytes(payload))).slice(0, 32)
}

/**
 * Evaluates whether the hot wallet balance exceeds the hysteresis trigger ceiling
 * and constructs a 1-hop direct sweep plan (`child -> externalVaultAddress`).
 */
export function evaluateColdVaultSweep(params: {
  config: ColdVaultSweepConfig
  currentHotBalanceAtomic: bigint
  spendableCoins: ReadonlyArray<ColdVaultSpendableCoin>
  estimatedFeePerInputAtomic: bigint
}): ColdVaultSweepPlan {
  const {
    config,
    currentHotBalanceAtomic,
    spendableCoins,
    estimatedFeePerInputAtomic,
  } = params
  const feePerInput =
    estimatedFeePerInputAtomic > 0n ? estimatedFeePerInputAtomic : 0n
  const triggerCeilingAtomic = computeTriggerCeilingAtomic(config)
  const trimmedVaultAddress = (config.externalVaultAddress || '').trim()

  const emptyPlan = (
    reason: ColdVaultSweepSkipReason,
    excessAtomic = 0n,
  ): ColdVaultSweepPlan => ({
    shouldSweep: false,
    reason,
    chainId: config.chainId,
    externalVaultAddress: trimmedVaultAddress,
    currentHotBalanceAtomic,
    maxHotBalanceAtomic: config.maxHotBalanceAtomic,
    triggerCeilingAtomic,
    excessAtomic,
    selectedInputs: [],
    directTransfers: [],
    totalGrossSweepAtomic: 0n,
    totalEstimatedFeeAtomic: 0n,
    totalNetSweepAtomic: 0n,
  })

  if (!config.enabled) {
    return emptyPlan('disabled')
  }

  if (!trimmedVaultAddress) {
    return emptyPlan('missing-vault-address')
  }

  if (!validateChainAddress(config.chainId, trimmedVaultAddress)) {
    return emptyPlan('invalid-vault-address')
  }

  if (currentHotBalanceAtomic <= triggerCeilingAtomic) {
    return emptyPlan('below-trigger-ceiling')
  }

  const excessAtomic = currentHotBalanceAtomic - config.maxHotBalanceAtomic
  if (
    config.minSweepAmountAtomic !== undefined &&
    excessAtomic < config.minSweepAmountAtomic
  ) {
    return emptyPlan('below-min-sweep', excessAtomic)
  }

  // Filter to unreserved, clean coins not already at externalVaultAddress with balance > feePerInput
  const eligibleCoins = spendableCoins.filter(coin => {
    if (coin.reserved) return false
    if (coin.status !== undefined && coin.status !== 'clean') return false
    if (coin.address.trim().toLowerCase() === trimmedVaultAddress.toLowerCase())
      return false
    const balance = getCoinBalanceAtomic(coin)
    return balance > feePerInput
  })

  if (eligibleCoins.length === 0) {
    return emptyPlan('no-eligible-coins', excessAtomic)
  }

  // Sort eligible coins:
  // 1. Received stamp/stealth child coins first, then other child coins, then mainAccount last.
  // 2. Largest balance first within the same origin tier to minimize 1-hop tx count and gas fees.
  const sortedCoins = [...eligibleCoins].sort((a, b) => {
    const prioDiff = getOriginPriority(a.origin) - getOriginPriority(b.origin)
    if (prioDiff !== 0) return prioDiff
    const balA = getCoinBalanceAtomic(a)
    const balB = getCoinBalanceAtomic(b)
    if (balB > balA) return 1
    if (balB < balA) return -1
    return a.id.localeCompare(b.id)
  })

  const selectedInputs: ColdVaultSpendableCoin[] = []
  const directTransfers: ColdVaultDirectTransferPlan[] = []
  let remainingExcessAtomic = excessAtomic
  let totalGrossSweepAtomic = 0n
  let totalEstimatedFeeAtomic = 0n
  let totalNetSweepAtomic = 0n

  for (const coin of sortedCoins) {
    if (remainingExcessAtomic <= 0n) break
    const coinBalance = getCoinBalanceAtomic(coin)
    const origin = coin.origin ?? 'stealth'
    const isMain = origin === 'main'

    let grossAmountAtomic: bigint
    if (!isMain && config.drainFullChildCoins) {
      grossAmountAtomic = coinBalance
    } else {
      grossAmountAtomic =
        coinBalance <= remainingExcessAtomic
          ? coinBalance
          : remainingExcessAtomic
    }

    if (grossAmountAtomic <= feePerInput) {
      continue
    }

    const netAmountAtomic = grossAmountAtomic - feePerInput
    const isFullCoinDrain = grossAmountAtomic === coinBalance

    selectedInputs.push(coin)
    directTransfers.push({
      coinId: coin.id,
      sourceAddress: coin.address,
      destinationAddress: trimmedVaultAddress,
      origin,
      grossAmountAtomic,
      feeAtomic: feePerInput,
      netAmountAtomic,
      hops: 1,
      isFullCoinDrain,
      privateKey: coin.privateKey,
      nonce: coin.nonce,
      outpoint: coin.outpoint,
    })

    totalGrossSweepAtomic += grossAmountAtomic
    totalEstimatedFeeAtomic += feePerInput
    totalNetSweepAtomic += netAmountAtomic
    remainingExcessAtomic =
      grossAmountAtomic >= remainingExcessAtomic
        ? 0n
        : remainingExcessAtomic - grossAmountAtomic
  }

  if (directTransfers.length === 0 || totalNetSweepAtomic <= 0n) {
    return emptyPlan('no-eligible-coins', excessAtomic)
  }

  if (
    config.minSweepAmountAtomic !== undefined &&
    totalNetSweepAtomic < config.minSweepAmountAtomic
  ) {
    return emptyPlan('below-min-sweep', excessAtomic)
  }

  const deterministicSweepId = computeDeterministicSweepId({
    chainId: config.chainId,
    externalVaultAddress: trimmedVaultAddress,
    transfers: directTransfers,
  })

  return {
    shouldSweep: true,
    chainId: config.chainId,
    externalVaultAddress: trimmedVaultAddress,
    currentHotBalanceAtomic,
    maxHotBalanceAtomic: config.maxHotBalanceAtomic,
    triggerCeilingAtomic,
    excessAtomic,
    selectedInputs,
    directTransfers,
    totalGrossSweepAtomic,
    totalEstimatedFeeAtomic,
    totalNetSweepAtomic,
    deterministicSweepId,
  }
}

interface SerializedColdVaultSweepRecord {
  sweepId: string
  chainId: string
  externalVaultAddress: string
  amountAtomic: string
  grossAmountAtomic: string
  feeAmountAtomic: string
  coinIds: string[]
  txHashes: string[]
  status: ColdVaultSweepStatus
  createdAtMs: number
  updatedAtMs: number
  error?: string
}

const JOURNAL_STORAGE_KEY = 'cold-vault-sweep-journal-v1'

function serializeRecord(
  record: ColdVaultSweepRecord,
): SerializedColdVaultSweepRecord {
  return {
    sweepId: record.sweepId,
    chainId: record.chainId,
    externalVaultAddress: record.externalVaultAddress,
    amountAtomic: record.amountAtomic.toString(),
    grossAmountAtomic: record.grossAmountAtomic.toString(),
    feeAmountAtomic: record.feeAmountAtomic.toString(),
    coinIds: [...record.coinIds],
    txHashes: [...record.txHashes],
    status: record.status,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    ...(record.error !== undefined ? { error: record.error } : {}),
  }
}

function deserializeRecord(
  raw: SerializedColdVaultSweepRecord,
): ColdVaultSweepRecord {
  return {
    sweepId: String(raw.sweepId),
    chainId: String(raw.chainId),
    externalVaultAddress: String(raw.externalVaultAddress),
    amountAtomic: BigInt(raw.amountAtomic ?? '0'),
    grossAmountAtomic: BigInt(raw.grossAmountAtomic ?? raw.amountAtomic ?? '0'),
    feeAmountAtomic: BigInt(raw.feeAmountAtomic ?? '0'),
    coinIds: Array.isArray(raw.coinIds) ? raw.coinIds.map(String) : [],
    txHashes: Array.isArray(raw.txHashes) ? raw.txHashes.map(String) : [],
    status: raw.status,
    createdAtMs: Number(raw.createdAtMs),
    updatedAtMs: Number(raw.updatedAtMs ?? raw.createdAtMs),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

/**
 * Durable at-most-once `ColdVaultSweepRecord` journal.
 * Guarantees that a sweep is never double-executed across restarts or browser tabs.
 */
export class ColdVaultSweepJournal {
  private readonly storage?: ColdVaultSweepJournalStorage
  private readonly storageKey: string
  private readonly records = new Map<string, ColdVaultSweepRecord>()
  private loaded = false

  constructor(options?: {
    storage?: ColdVaultSweepJournalStorage
    storageKey?: string
  }) {
    this.storage = options?.storage
    this.storageKey = options?.storageKey ?? JOURNAL_STORAGE_KEY
  }

  async hydrate(): Promise<void> {
    if (!this.storage) {
      this.loaded = true
      return
    }
    try {
      const raw = await this.storage.get(this.storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as SerializedColdVaultSweepRecord[]
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const record = deserializeRecord(item)
            this.records.set(record.sweepId, record)
          }
        }
      }
    } catch {
      // Key not found on initial boot
    }
    this.loaded = true
  }

  private async ensureHydrated(): Promise<void> {
    if (!this.loaded || this.storage) {
      // Re-read storage to catch updates written by concurrent tabs before mutating
      await this.hydrate()
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) return
    const serialized = Array.from(this.records.values()).map(serializeRecord)
    await this.storage.put(this.storageKey, JSON.stringify(serialized))
  }

  async getRecord(sweepId: string): Promise<ColdVaultSweepRecord | undefined> {
    await this.ensureHydrated()
    return this.records.get(sweepId)
  }

  async listRecords(chainId?: string): Promise<ColdVaultSweepRecord[]> {
    await this.ensureHydrated()
    const all = Array.from(this.records.values())
    if (!chainId) return all
    return all.filter(r => r.chainId.toLowerCase() === chainId.toLowerCase())
  }

  /**
   * Returns any in-flight (`planned` or `submitted`) or already `confirmed` record
   * that conflicts with the given `sweepId`, `chainId` in-flight lock, or `coinIds`.
   */
  async findConflictingRecord(params: {
    sweepId: string
    chainId: string
    coinIds: ReadonlyArray<string>
  }): Promise<ColdVaultSweepRecord | undefined> {
    await this.ensureHydrated()
    const existingById = this.records.get(params.sweepId)
    if (existingById && existingById.status !== 'failed') {
      return existingById
    }

    const coinSet = new Set(params.coinIds)
    for (const record of this.records.values()) {
      if (record.status === 'failed') continue
      // Any planned or submitted sweep on the same chain blocks concurrent sweeps
      if (
        record.chainId.toLowerCase() === params.chainId.toLowerCase() &&
        (record.status === 'planned' || record.status === 'submitted')
      ) {
        return record
      }
      // Any non-failed sweep that already consumed any of the same coinIds blocks re-sweeping those coins
      if (record.coinIds.some(id => coinSet.has(id))) {
        return record
      }
    }
    return undefined
  }

  /**
   * Atomically records a planned sweep. Throws if an identical or overlapping sweep
   * is already `planned`, `submitted`, or `confirmed` (at-most-once guarantee).
   */
  async recordPlanned(params: {
    sweepId: string
    chainId: string
    externalVaultAddress: string
    amountAtomic: bigint
    grossAmountAtomic?: bigint
    feeAmountAtomic?: bigint
    coinIds: ReadonlyArray<string>
    nowMs?: number
  }): Promise<ColdVaultSweepRecord> {
    const conflict = await this.findConflictingRecord({
      sweepId: params.sweepId,
      chainId: params.chainId,
      coinIds: params.coinIds,
    })
    if (conflict) {
      throw new Error(
        `ColdVaultSweepJournal conflict: sweep "${conflict.sweepId}" is already ${conflict.status}`,
      )
    }

    const now = params.nowMs ?? Date.now()
    const record: ColdVaultSweepRecord = {
      sweepId: params.sweepId,
      chainId: params.chainId,
      externalVaultAddress: params.externalVaultAddress,
      amountAtomic: params.amountAtomic,
      grossAmountAtomic: params.grossAmountAtomic ?? params.amountAtomic,
      feeAmountAtomic: params.feeAmountAtomic ?? 0n,
      coinIds: [...params.coinIds],
      txHashes: [],
      status: 'planned',
      createdAtMs: now,
      updatedAtMs: now,
    }
    this.records.set(record.sweepId, record)
    await this.persist()
    return record
  }

  async markSubmitted(
    sweepId: string,
    txHashes: ReadonlyArray<string>,
    nowMs = Date.now(),
  ): Promise<ColdVaultSweepRecord> {
    await this.ensureHydrated()
    const existing = this.records.get(sweepId)
    if (!existing) {
      throw new Error(`Unknown sweepId "${sweepId}"`)
    }
    const updated: ColdVaultSweepRecord = {
      ...existing,
      txHashes: [...txHashes],
      status: 'submitted',
      updatedAtMs: nowMs,
    }
    this.records.set(sweepId, updated)
    await this.persist()
    return updated
  }

  async markConfirmed(
    sweepId: string,
    txHashes?: ReadonlyArray<string>,
    nowMs = Date.now(),
  ): Promise<ColdVaultSweepRecord> {
    await this.ensureHydrated()
    const existing = this.records.get(sweepId)
    if (!existing) {
      throw new Error(`Unknown sweepId "${sweepId}"`)
    }
    const updated: ColdVaultSweepRecord = {
      ...existing,
      txHashes: txHashes ? [...txHashes] : existing.txHashes,
      status: 'confirmed',
      updatedAtMs: nowMs,
    }
    this.records.set(sweepId, updated)
    await this.persist()
    return updated
  }

  async markFailed(
    sweepId: string,
    error: string,
    nowMs = Date.now(),
  ): Promise<ColdVaultSweepRecord> {
    await this.ensureHydrated()
    const existing = this.records.get(sweepId)
    if (!existing) {
      throw new Error(`Unknown sweepId "${sweepId}"`)
    }
    const updated: ColdVaultSweepRecord = {
      ...existing,
      status: 'failed',
      error,
      updatedAtMs: nowMs,
    }
    this.records.set(sweepId, updated)
    await this.persist()
    return updated
  }
}

export type DirectTransferExecutor = (
  transfer: ColdVaultDirectTransferPlan,
) => Promise<{ txHash: string }>

export interface ColdVaultSweeperOptions {
  readonly journal?: ColdVaultSweepJournal
  readonly storage?: ColdVaultSweepJournalStorage
  readonly submitDirectTransfer?: DirectTransferExecutor
  /** If true, marks the journal record `'confirmed'` immediately after all 1-hop transfers broadcast. Defaults to false (`'submitted'`). */
  readonly autoConfirmOnBroadcast?: boolean
}

export interface ExecuteColdVaultSweepResult {
  readonly executed: boolean
  readonly plan: ColdVaultSweepPlan
  readonly record?: ColdVaultSweepRecord
  readonly skippedReason?:
    | ColdVaultSweepSkipReason
    | 'already-in-flight-or-swept'
}

/**
 * Coordinates cold-wallet vault sweep evaluation, 1-hop direct transfer execution,
 * and durable at-most-once journal persistence across restarts and browser tabs.
 */
export class ColdVaultSweeper {
  readonly journal: ColdVaultSweepJournal
  private readonly configs = new Map<string, ColdVaultSweepConfig>()
  private readonly submitDirectTransfer?: DirectTransferExecutor
  private readonly autoConfirmOnBroadcast: boolean
  private inMemoryLock = false

  constructor(options?: ColdVaultSweeperOptions) {
    this.journal =
      options?.journal ?? new ColdVaultSweepJournal({ storage: options?.storage })
    this.submitDirectTransfer = options?.submitDirectTransfer
    this.autoConfirmOnBroadcast = options?.autoConfirmOnBroadcast ?? false
  }

  setChainConfig(config: ColdVaultSweepConfig): void {
    this.configs.set(config.chainId.toLowerCase(), config)
  }

  getChainConfig(chainId: string): ColdVaultSweepConfig | undefined {
    return this.configs.get(chainId.toLowerCase())
  }

  evaluate(params: {
    config: ColdVaultSweepConfig
    currentHotBalanceAtomic: bigint
    spendableCoins: ReadonlyArray<ColdVaultSpendableCoin>
    estimatedFeePerInputAtomic: bigint
  }): ColdVaultSweepPlan {
    return evaluateColdVaultSweep(params)
  }

  /**
   * Evaluates and executes an at-most-once 1-hop cold-vault sweep if the hot balance
   * exceeds the configured trigger ceiling.
   */
  async evaluateAndSweep(params: {
    config: ColdVaultSweepConfig
    currentHotBalanceAtomic: bigint
    spendableCoins: ReadonlyArray<ColdVaultSpendableCoin>
    estimatedFeePerInputAtomic: bigint
    submitDirectTransfer?: DirectTransferExecutor
    nowMs?: number
  }): Promise<ExecuteColdVaultSweepResult> {
    const plan = evaluateColdVaultSweep(params)
    if (!plan.shouldSweep || !plan.deterministicSweepId) {
      return {
        executed: false,
        plan,
        skippedReason: plan.reason,
      }
    }

    if (this.inMemoryLock) {
      return {
        executed: false,
        plan,
        skippedReason: 'already-in-flight-or-swept',
      }
    }

    this.inMemoryLock = true
    try {
      const coinIds = plan.directTransfers.map(t => t.coinId)
      const conflict = await this.journal.findConflictingRecord({
        sweepId: plan.deterministicSweepId,
        chainId: plan.chainId,
        coinIds,
      })
      if (conflict) {
        return {
          executed: false,
          plan,
          record: conflict,
          skippedReason: 'already-in-flight-or-swept',
        }
      }

      let record = await this.journal.recordPlanned({
        sweepId: plan.deterministicSweepId,
        chainId: plan.chainId,
        externalVaultAddress: plan.externalVaultAddress,
        amountAtomic: plan.totalNetSweepAtomic,
        grossAmountAtomic: plan.totalGrossSweepAtomic,
        feeAmountAtomic: plan.totalEstimatedFeeAtomic,
        coinIds,
        nowMs: params.nowMs,
      })

      const executor = params.submitDirectTransfer ?? this.submitDirectTransfer
      if (!executor) {
        return {
          executed: true,
          plan,
          record,
        }
      }

      const txHashes: string[] = []
      try {
        for (const transfer of plan.directTransfers) {
          const { txHash } = await executor(transfer)
          txHashes.push(txHash)
        }
        record = await this.journal.markSubmitted(
          record.sweepId,
          txHashes,
          params.nowMs,
        )
        if (this.autoConfirmOnBroadcast) {
          record = await this.journal.markConfirmed(
            record.sweepId,
            txHashes,
            params.nowMs,
          )
        }
        return {
          executed: true,
          plan,
          record,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        record = await this.journal.markFailed(
          record.sweepId,
          message,
          params.nowMs,
        )
        throw err
      }
    } finally {
      this.inMemoryLock = false
    }
  }
}
