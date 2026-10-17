import type {
  InvoiceReceiptPayload,
  InvoiceRequestPayload,
} from './index'

export type InvoiceLifecycleStatus =
  | 'open'
  | 'signing_or_broadcasting'
  | 'outcome_unknown'
  | 'paid_confirmed'
  | 'expired'
  | 'exception_manual_review'

export type InvoiceExceptionReason =
  | 'partial_payment'
  | 'excess_payment'
  | 'wrong_chain'
  | 'wrong_network'
  | 'wrong_recipient'
  | 'wrong_asset'
  | 'transaction_failed'
  | 'transaction_reorged'

export interface InvoicePaymentAttemptRecord {
  readonly invoiceId: string
  readonly status: InvoiceLifecycleStatus
  readonly signedTxId?: string
  readonly chainKey: string
  readonly networkId: string
  readonly receiveAddress: string
  readonly amountBaseUnits: string
  readonly updatedAtMs: number
  readonly errorReason?: string
  readonly exceptionReason?: InvoiceExceptionReason
  readonly observedAmountBaseUnits?: string
}

export interface InvoiceStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultBrowserStorage(): InvoiceStorageLike | undefined {
  const host = globalThis as {
    window?: unknown
    localStorage?: InvoiceStorageLike
  }
  if (host.window === undefined) return undefined
  try {
    return host.localStorage
  } catch {
    return undefined
  }
}

export class InvoiceDuplicateAttemptBlockedError extends Error {
  readonly invoiceId: string
  readonly existingAttempt: InvoicePaymentAttemptRecord

  constructor(existingAttempt: InvoicePaymentAttemptRecord) {
    super(
      `Cannot start a new payment attempt for invoice '${existingAttempt.invoiceId}' while prior attempt is '${existingAttempt.status}'`,
    )
    this.name = 'InvoiceDuplicateAttemptBlockedError'
    this.invoiceId = existingAttempt.invoiceId
    this.existingAttempt = existingAttempt
    Object.setPrototypeOf(this, InvoiceDuplicateAttemptBlockedError.prototype)
  }
}

const ATTEMPT_STORAGE_PREFIX = 'frank:invoice-attempt:v1:'
const PRIVATE_TAGS_STORAGE_PREFIX = 'frank:invoice-private-tags:v1:'

/**
 * Durable pre-broadcast attempt store for invoice payments.
 *
 * Persists `{ invoiceId, status, signedTxId, chainKey, networkId, receiveAddress, amountBaseUnits, updatedAtMs }`
 * BEFORE any transaction bytes are broadcast, ensuring an unknown broadcast outcome or restart blocks
 * creating a duplicate replacement payment until the prior attempt is reconciled against the chain.
 */
export class InvoiceAttemptStore {
  private readonly records = new Map<string, InvoicePaymentAttemptRecord>()
  private readonly storage?: InvoiceStorageLike
  private readonly prefix: string

  constructor(options?: {
    storage?: InvoiceStorageLike | null
    prefix?: string
  }) {
    this.storage =
      options?.storage === null
        ? undefined
        : options?.storage ?? defaultBrowserStorage()
    this.prefix = options?.prefix ?? ATTEMPT_STORAGE_PREFIX
  }

  private storageKey(invoiceId: string): string {
    return `${this.prefix}${invoiceId}`
  }

  private writeRecord(record: InvoicePaymentAttemptRecord): void {
    this.records.set(record.invoiceId, record)
    if (this.storage) {
      try {
        this.storage.setItem(
          this.storageKey(record.invoiceId),
          JSON.stringify(record),
        )
      } catch {
        // Retain in-memory record even if browser storage quota/sandbox fails.
      }
    }
  }

  get(invoiceId: string): InvoicePaymentAttemptRecord | undefined {
    const cached = this.records.get(invoiceId)
    if (cached) return cached
    if (!this.storage) return undefined
    try {
      const raw = this.storage.getItem(this.storageKey(invoiceId))
      if (!raw) return undefined
      const parsed = JSON.parse(raw) as Partial<InvoicePaymentAttemptRecord>
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.invoiceId !== 'string' ||
        typeof parsed.status !== 'string' ||
        typeof parsed.chainKey !== 'string' ||
        typeof parsed.networkId !== 'string' ||
        typeof parsed.receiveAddress !== 'string' ||
        typeof parsed.amountBaseUnits !== 'string' ||
        typeof parsed.updatedAtMs !== 'number'
      ) {
        return undefined
      }
      const hydrated: InvoicePaymentAttemptRecord = {
        invoiceId: parsed.invoiceId,
        status: parsed.status as InvoiceLifecycleStatus,
        chainKey: parsed.chainKey,
        networkId: parsed.networkId,
        receiveAddress: parsed.receiveAddress,
        amountBaseUnits: parsed.amountBaseUnits,
        updatedAtMs: parsed.updatedAtMs,
        ...(typeof parsed.signedTxId === 'string'
          ? { signedTxId: parsed.signedTxId }
          : {}),
        ...(typeof parsed.errorReason === 'string'
          ? { errorReason: parsed.errorReason }
          : {}),
        ...(typeof parsed.exceptionReason === 'string'
          ? {
              exceptionReason:
                parsed.exceptionReason as InvoiceExceptionReason,
            }
          : {}),
        ...(typeof parsed.observedAmountBaseUnits === 'string'
          ? { observedAmountBaseUnits: parsed.observedAmountBaseUnits }
          : {}),
      }
      this.records.set(invoiceId, hydrated)
      return hydrated
    } catch {
      return undefined
    }
  }

  canCreateNewPaymentAttempt(invoiceId: string): {
    allowed: boolean
    reason?: string
    existingAttempt?: InvoicePaymentAttemptRecord
  } {
    const existing = this.get(invoiceId)
    if (!existing) {
      return { allowed: true }
    }
    if (existing.status === 'outcome_unknown') {
      return {
        allowed: false,
        reason:
          'Previous payment attempt has an unknown network outcome. Reconcile the existing transaction before retrying.',
        existingAttempt: existing,
      }
    }
    if (existing.status === 'signing_or_broadcasting') {
      return {
        allowed: false,
        reason: 'A payment attempt for this invoice is already in progress.',
        existingAttempt: existing,
      }
    }
    if (existing.status === 'paid_confirmed') {
      return {
        allowed: false,
        reason: 'This invoice has already been paid and confirmed on-chain.',
        existingAttempt: existing,
      }
    }
    if (existing.status === 'exception_manual_review') {
      return {
        allowed: false,
        reason: `Invoice requires manual review (${
          existing.exceptionReason ?? 'payment exception'
        }).`,
        existingAttempt: existing,
      }
    }
    return { allowed: true, existingAttempt: existing }
  }

  /**
   * Records a pre-broadcast attempt. Throws `InvoiceDuplicateAttemptBlockedError` if an existing
   * attempt is in `'signing_or_broadcasting'`, `'outcome_unknown'`, `'paid_confirmed'`, or `'exception_manual_review'`.
   */
  recordPreBroadcast(params: {
    invoiceId: string
    signedTxId?: string
    chainKey: string
    networkId: string
    receiveAddress: string
    amountBaseUnits: string
    nowMs?: number
  }): InvoicePaymentAttemptRecord {
    const check = this.canCreateNewPaymentAttempt(params.invoiceId)
    if (!check.allowed && check.existingAttempt) {
      throw new InvoiceDuplicateAttemptBlockedError(check.existingAttempt)
    }

    const record: InvoicePaymentAttemptRecord = {
      invoiceId: params.invoiceId,
      status: 'signing_or_broadcasting',
      ...(params.signedTxId ? { signedTxId: params.signedTxId } : {}),
      chainKey: params.chainKey,
      networkId: params.networkId,
      receiveAddress: params.receiveAddress,
      amountBaseUnits: params.amountBaseUnits,
      updatedAtMs: params.nowMs ?? Date.now(),
    }
    this.writeRecord(record)
    return record
  }

  attachSignedTxId(
    invoiceId: string,
    signedTxId: string,
    nowMs = Date.now(),
  ): InvoicePaymentAttemptRecord {
    const existing = this.get(invoiceId)
    if (!existing) {
      throw new Error(`No pre-broadcast attempt found for invoice ${invoiceId}`)
    }
    const updated: InvoicePaymentAttemptRecord = {
      ...existing,
      signedTxId,
      updatedAtMs: nowMs,
    }
    this.writeRecord(updated)
    return updated
  }

  markOutcomeUnknown(
    invoiceId: string,
    params?: {
      signedTxId?: string
      errorReason?: string
      nowMs?: number
    },
  ): InvoicePaymentAttemptRecord {
    const existing = this.get(invoiceId)
    const updated: InvoicePaymentAttemptRecord = {
      invoiceId,
      status: 'outcome_unknown',
      chainKey: existing?.chainKey ?? '',
      networkId: existing?.networkId ?? '',
      receiveAddress: existing?.receiveAddress ?? '',
      amountBaseUnits: existing?.amountBaseUnits ?? '0',
      ...(params?.signedTxId ?? existing?.signedTxId
        ? { signedTxId: params?.signedTxId ?? existing?.signedTxId }
        : {}),
      ...(params?.errorReason ? { errorReason: params.errorReason } : {}),
      updatedAtMs: params?.nowMs ?? Date.now(),
    }
    this.writeRecord(updated)
    return updated
  }

  markConfirmed(
    invoiceId: string,
    params: {
      signedTxId: string
      nowMs?: number
    },
  ): InvoicePaymentAttemptRecord {
    const existing = this.get(invoiceId)
    const updated: InvoicePaymentAttemptRecord = {
      invoiceId,
      status: 'paid_confirmed',
      signedTxId: params.signedTxId,
      chainKey: existing?.chainKey ?? '',
      networkId: existing?.networkId ?? '',
      receiveAddress: existing?.receiveAddress ?? '',
      amountBaseUnits: existing?.amountBaseUnits ?? '0',
      updatedAtMs: params.nowMs ?? Date.now(),
    }
    this.writeRecord(updated)
    return updated
  }

  markException(
    invoiceId: string,
    params: {
      reason: InvoiceExceptionReason
      signedTxId?: string
      observedAmountBaseUnits?: string
      nowMs?: number
    },
  ): InvoicePaymentAttemptRecord {
    const existing = this.get(invoiceId)
    const updated: InvoicePaymentAttemptRecord = {
      invoiceId,
      status: 'exception_manual_review',
      chainKey: existing?.chainKey ?? '',
      networkId: existing?.networkId ?? '',
      receiveAddress: existing?.receiveAddress ?? '',
      amountBaseUnits: existing?.amountBaseUnits ?? '0',
      exceptionReason: params.reason,
      ...(params.signedTxId ?? existing?.signedTxId
        ? { signedTxId: params.signedTxId ?? existing?.signedTxId }
        : {}),
      ...(params.observedAmountBaseUnits
        ? { observedAmountBaseUnits: params.observedAmountBaseUnits }
        : {}),
      updatedAtMs: params.nowMs ?? Date.now(),
    }
    this.writeRecord(updated)
    return updated
  }

  /**
   * Clears an unresolved attempt ONLY after the caller has reconciled with the chain
   * that the prior transaction was never accepted/submitted.
   */
  reconcileNotSubmitted(invoiceId: string): void {
    this.records.delete(invoiceId)
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey(invoiceId))
      } catch {
        // Ignore storage removal failure.
      }
    }
  }

  list(): InvoicePaymentAttemptRecord[] {
    return Array.from(this.records.values())
  }

  clear(): void {
    const keys = Array.from(this.records.keys())
    this.records.clear()
    if (this.storage) {
      for (const id of keys) {
        try {
          this.storage.removeItem(this.storageKey(id))
        } catch {}
      }
    }
  }
}

export const defaultInvoiceAttemptStore = new InvoiceAttemptStore()

export const MAX_PRIVATE_TAGS_PER_INVOICE = 16
export const MAX_PRIVATE_TAG_LENGTH = 48

function normalizePrivateTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.length > MAX_PRIVATE_TAG_LENGTH) {
      throw new RangeError(
        `Private invoice tag exceeds maximum length of ${MAX_PRIVATE_TAG_LENGTH} chars`,
      )
    }
    const lower = trimmed.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      normalized.push(trimmed)
      if (normalized.length > MAX_PRIVATE_TAGS_PER_INVOICE) {
        throw new RangeError(
          `At most ${MAX_PRIVATE_TAGS_PER_INVOICE} private tags are allowed per invoice`,
        )
      }
    }
  }
  return normalized
}

/**
 * Local-only private reporting tag store per `invoiceId`.
 *
 * Private tags are stored exclusively in local storage / memory on the user's device and are
 * NEVER included in `InvoicePayload` wire messages or on-chain transactions.
 */
export class InvoicePrivateTagStore {
  private readonly tagsByInvoice = new Map<string, string[]>()
  private readonly storage?: InvoiceStorageLike
  private readonly prefix: string

  constructor(options?: {
    storage?: InvoiceStorageLike | null
    prefix?: string
  }) {
    this.storage =
      options?.storage === null
        ? undefined
        : options?.storage ?? defaultBrowserStorage()
    this.prefix = options?.prefix ?? PRIVATE_TAGS_STORAGE_PREFIX
  }

  private storageKey(invoiceId: string): string {
    return `${this.prefix}${invoiceId}`
  }

  getTags(invoiceId: string): string[] {
    const cached = this.tagsByInvoice.get(invoiceId)
    if (cached) return [...cached]
    if (!this.storage) return []
    try {
      const raw = this.storage.getItem(this.storageKey(invoiceId))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      const normalized = normalizePrivateTags(
        parsed.filter((item): item is string => typeof item === 'string'),
      )
      this.tagsByInvoice.set(invoiceId, normalized)
      return [...normalized]
    } catch {
      return []
    }
  }

  setTags(invoiceId: string, tags: readonly string[]): string[] {
    const normalized = normalizePrivateTags(tags)
    if (normalized.length === 0) {
      this.tagsByInvoice.delete(invoiceId)
      if (this.storage) {
        try {
          this.storage.removeItem(this.storageKey(invoiceId))
        } catch {}
      }
      return []
    }
    this.tagsByInvoice.set(invoiceId, normalized)
    if (this.storage) {
      try {
        this.storage.setItem(
          this.storageKey(invoiceId),
          JSON.stringify(normalized),
        )
      } catch {}
    }
    return [...normalized]
  }

  addTag(invoiceId: string, tag: string): string[] {
    const current = this.getTags(invoiceId)
    return this.setTags(invoiceId, [...current, tag])
  }

  removeTag(invoiceId: string, tag: string): string[] {
    const targetLower = tag.trim().toLowerCase()
    const current = this.getTags(invoiceId).filter(
      existing => existing.toLowerCase() !== targetLower,
    )
    return this.setTags(invoiceId, current)
  }

  clear(invoiceId?: string): void {
    if (invoiceId !== undefined) {
      this.tagsByInvoice.delete(invoiceId)
      if (this.storage) {
        try {
          this.storage.removeItem(this.storageKey(invoiceId))
        } catch {}
      }
      return
    }
    const keys = Array.from(this.tagsByInvoice.keys())
    this.tagsByInvoice.clear()
    if (this.storage) {
      for (const id of keys) {
        try {
          this.storage.removeItem(this.storageKey(id))
        } catch {}
      }
    }
  }
}

export const defaultInvoicePrivateTagStore = new InvoicePrivateTagStore()

export interface ObservedNativeTransfer {
  readonly txHash: string
  readonly chainKey: string
  readonly networkId: string
  readonly toAddress: string
  readonly fromAddress?: string
  readonly amountBaseUnits: string | bigint
  readonly isNativeAsset?: boolean
  readonly assetType?: 'native' | 'token'
  readonly status:
    | 'confirmed'
    | 'finalized'
    | 'pending'
    | 'failed'
    | 'reorged'
    | 'unknown'
  readonly confirmations?: number
}

export interface ActiveChainInvoiceContext {
  readonly activeChainKey?: string
  readonly activeNetworkId?: string
  readonly nowMs?: number
  readonly attemptRecord?: InvoicePaymentAttemptRecord
  readonly attemptStore?: InvoiceAttemptStore
  readonly receiptHints?: ReadonlyArray<InvoiceReceiptPayload>
}

export interface InvoiceResolution {
  readonly invoiceId: string
  readonly status: InvoiceLifecycleStatus
  readonly verifiedTxHash?: string
  readonly exceptionReason?: InvoiceExceptionReason
  readonly observedAmountBaseUnits?: string
  readonly expectedAmountBaseUnits: string
  readonly receiptHintTxHashes: string[]
  readonly paymentBlocked: boolean
  readonly paymentBlockedReason?: string
}

function normalizeAddressForComparison(
  address: string,
  chainKey: string,
): string {
  const trimmed = address.trim()
  if (
    trimmed.startsWith('0x') ||
    trimmed.startsWith('0X') ||
    chainKey.toLowerCase().includes('monad') ||
    chainKey.toLowerCase().includes('eth') ||
    chainKey.toLowerCase().includes('sepolia') ||
    chainKey.toLowerCase().includes('evm')
  ) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

function deduplicateReceiptHintTxHashes(
  invoiceId: string,
  receipts?: ReadonlyArray<InvoiceReceiptPayload>,
): string[] {
  if (!receipts || receipts.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const r of receipts) {
    if (!r || r.action !== 'receipt' || r.invoiceId !== invoiceId) continue
    const hash = r.txHash.trim()
    if (!hash || seen.has(hash)) continue
    seen.add(hash)
    result.push(hash)
  }
  return result
}

/**
 * Independently verifies an invoice's lifecycle resolution against canonical on-chain transfer
 * evidence, local pre-broadcast attempt state, expiry, and active chain/network context.
 *
 * Security invariants:
 * 1. Peer `receipt` messages are treated purely as correlation hints (`receiptHintTxHashes`) and
 *    NEVER mark an invoice `'paid_confirmed'` without canonical `observedTransfer` chain evidence.
 * 2. Partial payments (`transferAmount < expectedAmount`), overpayments (`transferAmount > expectedAmount`),
 *    wrong chain/network/recipient/asset, failed transactions, and reorged transactions transition to
 *    `'exception_manual_review'` with a specific `exceptionReason`.
 * 3. Only a confirmed/finalized native transfer matching `chainKey`, `networkId`, `receiveAddress`,
 *    and exact `amountBaseUnits` transitions the invoice to `'paid_confirmed'`.
 */
export function verifyCanonicalInvoicePayment(
  invoice: InvoiceRequestPayload,
  observedTransfer?: ObservedNativeTransfer | null,
  context?: ActiveChainInvoiceContext,
): InvoiceResolution {
  const receiptHintTxHashes = deduplicateReceiptHintTxHashes(
    invoice.invoiceId,
    context?.receiptHints,
  )
  const expectedAmount = BigInt(invoice.amountBaseUnits)
  const attemptRecord =
    context?.attemptRecord ?? context?.attemptStore?.get(invoice.invoiceId)

  if (observedTransfer) {
    const observedAmountStr =
      typeof observedTransfer.amountBaseUnits === 'bigint'
        ? observedTransfer.amountBaseUnits.toString(10)
        : String(observedTransfer.amountBaseUnits).trim()
    const observedAmount = /^\d+$/.test(observedAmountStr)
      ? BigInt(observedAmountStr)
      : -1n

    if (
      observedTransfer.chainKey.trim().toLowerCase() !==
      invoice.chainKey.trim().toLowerCase()
    ) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'wrong_chain',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'wrong_chain',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: `Transfer occurred on wrong chain (${observedTransfer.chainKey} instead of ${invoice.chainKey})`,
      }
    }

    if (
      String(observedTransfer.networkId).trim().toLowerCase() !==
      String(invoice.networkId).trim().toLowerCase()
    ) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'wrong_network',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'wrong_network',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: `Transfer occurred on wrong network (${observedTransfer.networkId} instead of ${invoice.networkId})`,
      }
    }

    if (
      observedTransfer.isNativeAsset === false ||
      observedTransfer.assetType === 'token'
    ) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'wrong_asset',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'wrong_asset',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          'Transfer used a non-native token instead of the required native chain asset',
      }
    }

    const expectedRecipient = normalizeAddressForComparison(
      invoice.receiveAddress,
      invoice.chainKey,
    )
    const actualRecipient = normalizeAddressForComparison(
      observedTransfer.toAddress,
      observedTransfer.chainKey,
    )
    if (expectedRecipient !== actualRecipient) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'wrong_recipient',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'wrong_recipient',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          'Transfer destination address does not match the invoice receiveAddress',
      }
    }

    if (observedTransfer.status === 'failed') {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'transaction_failed',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'transaction_failed',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: 'The on-chain payment transaction failed',
      }
    }

    if (observedTransfer.status === 'reorged') {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'transaction_reorged',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'transaction_reorged',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          'The payment transaction was invalidated by a chain reorganization; manual review required',
      }
    }

    if (observedAmount < expectedAmount) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'partial_payment',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'partial_payment',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: `Partial payment observed (${observedAmountStr} < ${invoice.amountBaseUnits} base units)`,
      }
    }

    if (observedAmount > expectedAmount) {
      context?.attemptStore?.markException(invoice.invoiceId, {
        reason: 'excess_payment',
        signedTxId: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: 'excess_payment',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: `Excess overpayment observed (${observedAmountStr} > ${invoice.amountBaseUnits} base units)`,
      }
    }

    if (
      observedTransfer.status === 'confirmed' ||
      observedTransfer.status === 'finalized'
    ) {
      context?.attemptStore?.markConfirmed(invoice.invoiceId, {
        signedTxId: observedTransfer.txHash,
      })
      return {
        invoiceId: invoice.invoiceId,
        status: 'paid_confirmed',
        verifiedTxHash: observedTransfer.txHash,
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: 'Invoice is already paid and confirmed on-chain',
      }
    }

    if (observedTransfer.status === 'pending') {
      return {
        invoiceId: invoice.invoiceId,
        status: 'signing_or_broadcasting',
        observedAmountBaseUnits: observedAmountStr,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          'Payment transaction is pending on-chain confirmation',
      }
    }

    return {
      invoiceId: invoice.invoiceId,
      status: 'outcome_unknown',
      observedAmountBaseUnits: observedAmountStr,
      expectedAmountBaseUnits: invoice.amountBaseUnits,
      receiptHintTxHashes,
      paymentBlocked: true,
      paymentBlockedReason:
        'Payment transaction outcome is unknown; reconcile before retrying',
    }
  }

  // No canonical observed transfer yet: check durable local attempt state first
  if (attemptRecord) {
    if (attemptRecord.status === 'outcome_unknown') {
      return {
        invoiceId: invoice.invoiceId,
        status: 'outcome_unknown',
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          attemptRecord.errorReason ??
          'Previous payment attempt has an unknown network outcome; reconcile before retrying',
      }
    }
    if (attemptRecord.status === 'signing_or_broadcasting') {
      return {
        invoiceId: invoice.invoiceId,
        status: 'signing_or_broadcasting',
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason:
          'A payment attempt for this invoice is already in progress',
      }
    }
    if (attemptRecord.status === 'exception_manual_review') {
      return {
        invoiceId: invoice.invoiceId,
        status: 'exception_manual_review',
        exceptionReason: attemptRecord.exceptionReason,
        observedAmountBaseUnits: attemptRecord.observedAmountBaseUnits,
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: `Invoice requires manual review (${
          attemptRecord.exceptionReason ?? 'exception'
        })`,
      }
    }
  }

  // Check invoice expiration
  if (invoice.expiresAtIso) {
    const expiresAtMs = Date.parse(invoice.expiresAtIso)
    const nowMs = context?.nowMs ?? Date.now()
    if (!Number.isNaN(expiresAtMs) && nowMs >= expiresAtMs) {
      return {
        invoiceId: invoice.invoiceId,
        status: 'expired',
        expectedAmountBaseUnits: invoice.amountBaseUnits,
        receiptHintTxHashes,
        paymentBlocked: true,
        paymentBlockedReason: 'Invoice has expired',
      }
    }
  }

  // Check if active chain/network mismatches invoice requirements
  const hasChainMismatch =
    Boolean(context?.activeChainKey) &&
    context!.activeChainKey!.trim().toLowerCase() !==
      invoice.chainKey.trim().toLowerCase()
  const hasNetworkMismatch =
    Boolean(context?.activeNetworkId) &&
    context!.activeNetworkId!.trim().toLowerCase() !==
      String(invoice.networkId).trim().toLowerCase()

  if (hasChainMismatch || hasNetworkMismatch) {
    return {
      invoiceId: invoice.invoiceId,
      status: 'open',
      expectedAmountBaseUnits: invoice.amountBaseUnits,
      receiptHintTxHashes,
      paymentBlocked: true,
      paymentBlockedReason: `Switch active wallet network to ${invoice.chainKey} (${invoice.networkId}) to pay this invoice`,
    }
  }

  return {
    invoiceId: invoice.invoiceId,
    status: 'open',
    expectedAmountBaseUnits: invoice.amountBaseUnits,
    receiptHintTxHashes,
    paymentBlocked: false,
  }
}
