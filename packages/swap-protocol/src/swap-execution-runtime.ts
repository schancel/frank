/**
 * Headless durable swap operation owner and execution runtime (S3, S4, S6).
 *
 * Composes custody retention holds, narrow family funding/claim/refund capabilities,
 * write-ahead artifact persistence, and 10-block finality / reorg reconciliation.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha256.js'

export const SWAP_FINALITY_CONFIRMATIONS = 10

export type SwapRole = 'initiator' | 'responder'

export type SwapExecutionPhase =
  | 'prepared'
  | 'funding'
  | 'funded'
  | 'claiming'
  | 'complete'
  | 'refund-pending'
  | 'refunded'
  | 'recovery-required'
  | 'cancelled'

export interface ReservedXecOutpoint {
  readonly txid: string
  readonly vout: number
  readonly valueSats: string
}

export interface ReservedEvmInput {
  readonly address: string
  readonly nonce: number
  readonly feeBudgetWei: string
}

export interface LegFundingObservation {
  readonly status: 'unseen' | 'included' | 'final'
  readonly txId?: string
  readonly confirmations: number
  readonly blockHeight?: number
  readonly blockHash?: string
  readonly revertedDepth?: number
}

export interface LegSettlementObservation {
  readonly effect: 'none' | 'claim' | 'refund'
  readonly status: 'unseen' | 'included' | 'final'
  readonly txId?: string
  readonly confirmations: number
  readonly revertedDepth?: number
  readonly extractedSecretHex?: string
}

export interface SwapExecutionRecord {
  readonly version: 1
  readonly revision: number
  readonly swapId: string
  readonly conversationId: string
  readonly accountIncarnation: string
  readonly localPublicKey: string
  readonly peerPublicKey: string
  readonly role: SwapRole
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
  readonly xecPrincipal: string
  readonly evmPrincipal: string
  readonly xecFeeSats: string
  readonly evmFeeBudgetWei: string
  readonly expiry: number
  readonly xecRefundTimestamp: number
  readonly evmOpeningTimestamp: number
  readonly evmChallengeDuration: number
  readonly jointPublicKey: string
  readonly adaptorPoint: string
  readonly contextBindingHex: string
  readonly retentionOperationId: string
  readonly retentionReleased: boolean
  readonly secretReceiptId?: string
  readonly adaptorSecretHex?: string
  readonly xecInputs: readonly ReservedXecOutpoint[]
  readonly evmInput: ReservedEvmInput
  readonly xecFundingTxHex: string
  readonly xecFundingTxid: string
  readonly evmFundingTxHex: string
  readonly evmFundingTxHash: string
  readonly xecClaimTxHex: string
  readonly xecClaimTxid: string
  readonly evmClaimTxHex: string
  readonly evmClaimTxHash: string
  readonly xecRefundTxHex: string
  readonly xecRefundTxid: string
  readonly evmRefundTxHex: string
  readonly evmRefundTxHash: string
  readonly fundingAuthorized: boolean
  readonly phase: SwapExecutionPhase
  readonly xecFunding: LegFundingObservation
  readonly evmFunding: LegFundingObservation
  readonly xecSettlement: LegSettlementObservation
  readonly evmSettlement: LegSettlementObservation
  readonly maxObservedReorgDepth: number
  readonly reorgWarning?: string
}

export interface SwapExecutionStore {
  getRecord(key: string): Promise<{ revision: number; raw: string } | undefined>
  listRecords(): Promise<
    readonly { key: string; revision: number; raw: string }[]
  >
  compareAndSwap(
    key: string,
    expectedRevision: number,
    nextRaw: string,
  ): Promise<boolean>
}

export class InMemorySwapExecutionStore implements SwapExecutionStore {
  private readonly records = new Map<
    string,
    { revision: number; raw: string }
  >()

  async getRecord(
    key: string,
  ): Promise<{ revision: number; raw: string } | undefined> {
    const entry = this.records.get(key)
    return entry ? { ...entry } : undefined
  }

  async listRecords(): Promise<
    readonly { key: string; revision: number; raw: string }[]
  > {
    return Array.from(this.records.entries()).map(([key, value]) => ({
      key,
      revision: value.revision,
      raw: value.raw,
    }))
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number,
    nextRaw: string,
  ): Promise<boolean> {
    const current = this.records.get(key)
    const actualRevision = current?.revision ?? 0
    if (actualRevision !== expectedRevision) return false
    this.records.set(key, { revision: expectedRevision + 1, raw: nextRaw })
    return true
  }
}

export interface SwapCustodyHoldCapability {
  acquireHold(operationId: string): Promise<{ operationId: string }>
  releaseHold(operationId: string): Promise<void>
}

export interface SwapSecretVaultCapability {
  sealSecret(input: {
    accountIncarnation: string
    operationId: string
    contextBindingHex: string
    secret: Uint8Array
  }): Promise<{ receiptId: string }>
  openSecret(input: {
    accountIncarnation: string
    operationId: string
    contextBindingHex: string
    receiptId: string
  }): Promise<Uint8Array>
  retireSecret?(receiptId: string): Promise<void>
}

export interface XecSwapCapability {
  reserveInputs(input: { swapId: string; principalSats: bigint }): Promise<{
    inputs: readonly ReservedXecOutpoint[]
    feeSats: bigint
    fundingTxHex: string
    fundingTxid: string
    claimTxHex: string
    claimTxid: string
    refundTxHex: string
    refundTxid: string
  }>
  broadcastTransaction(txHex: string): Promise<{ txid: string }>
  observeFunding(txid: string): Promise<LegFundingObservation>
  observeSettlement(input: {
    fundingTxid: string
    claimTxid: string
    refundTxid: string
  }): Promise<LegSettlementObservation>
  releaseInputs(swapId: string): Promise<void>
}

export interface EvmSwapCapability {
  reserveInput(input: { swapId: string; principalWei: bigint }): Promise<{
    input: ReservedEvmInput
    fundingTxHex: string
    fundingTxHash: string
    claimTxHex: string
    claimTxHash: string
    refundTxHex: string
    refundTxHash: string
  }>
  broadcastTransaction(txHex: string): Promise<{ txHash: string }>
  observeFunding(txHash: string): Promise<LegFundingObservation>
  observeSettlement(input: {
    fundingTxHash: string
    claimTxHash: string
    refundTxHash: string
  }): Promise<LegSettlementObservation>
  releaseInput(swapId: string): Promise<void>
}

export function computeSwapContextBindingHex(input: {
  accountIncarnation: string
  swapId: string
  conversationId: string
  role: SwapRole
  xecPrincipal: string
  evmPrincipal: string
  jointPublicKey: string
  adaptorPoint: string
}): string {
  const preimage = utf8ToBytes(
    [
      'frank/swap-execution-context/v1',
      input.accountIncarnation,
      input.swapId.toLowerCase(),
      input.conversationId.toLowerCase(),
      input.role,
      input.xecPrincipal,
      input.evmPrincipal,
      input.jointPublicKey.toLowerCase(),
      input.adaptorPoint.toLowerCase(),
    ].join('|'),
  )
  return bytesToHex(sha256(preimage))
}

export function swapOperationKey(
  accountIncarnation: string,
  localPublicKey: string,
  swapId: string,
): string {
  return `${accountIncarnation}:${localPublicKey.toLowerCase()}:${swapId.toLowerCase()}`
}

function normalizeConfirmations(
  obs: LegFundingObservation,
): LegFundingObservation {
  const status =
    obs.confirmations >= SWAP_FINALITY_CONFIRMATIONS
      ? 'final'
      : obs.confirmations > 0 || obs.status === 'included'
      ? 'included'
      : 'unseen'
  return { ...obs, status }
}

function normalizeSettlement(
  obs: LegSettlementObservation,
): LegSettlementObservation {
  if (obs.effect === 'none') {
    return { ...obs, status: 'unseen', confirmations: 0 }
  }
  const status =
    obs.confirmations >= SWAP_FINALITY_CONFIRMATIONS
      ? 'final'
      : obs.confirmations > 0 || obs.status === 'included'
      ? 'included'
      : 'unseen'
  return { ...obs, status }
}

export interface SwapExecutionCoordinatorOptions {
  readonly store: SwapExecutionStore
  readonly custody: SwapCustodyHoldCapability
  readonly secretVault?: SwapSecretVaultCapability
  readonly xec: XecSwapCapability
  readonly evm: EvmSwapCapability
  readonly verifySecretMatchesPoint?: (
    secret: Uint8Array,
    adaptorPointHex: string,
  ) => boolean
  readonly onUpdate?: (records: readonly SwapExecutionRecord[]) => void
}

export interface PrepareSwapInput {
  readonly swapId: string
  readonly conversationId: string
  readonly accountIncarnation: string
  readonly localPublicKey: string
  readonly peerPublicKey: string
  readonly role: SwapRole
  readonly xecChainIdentifier: string
  readonly evmChainIdentifier: string
  readonly xecPrincipal: bigint
  readonly evmPrincipal: bigint
  readonly expiry: number
  readonly nowSec: number
  readonly xecRefundTimestamp?: number
  readonly evmOpeningTimestamp?: number
  readonly evmChallengeDuration?: number
  readonly jointPublicKey?: string
  readonly adaptorPoint?: string
  readonly adaptorSecret?: Uint8Array
}

export class SwapExecutionCoordinator {
  private readonly options: SwapExecutionCoordinatorOptions

  constructor(options: SwapExecutionCoordinatorOptions) {
    this.options = options
  }

  async listOperations(filter?: {
    accountIncarnation?: string
    localPublicKey?: string
  }): Promise<readonly SwapExecutionRecord[]> {
    const rows = await this.options.store.listRecords()
    const parsed = rows.map(row => {
      const record = JSON.parse(row.raw) as SwapExecutionRecord
      if (record.version !== 1) {
        throw new Error('Unsupported swap execution record version')
      }
      return record
    })
    return parsed.filter(
      r =>
        (!filter?.accountIncarnation ||
          r.accountIncarnation === filter.accountIncarnation) &&
        (!filter?.localPublicKey ||
          r.localPublicKey.toLowerCase() ===
            filter.localPublicKey.toLowerCase()),
    )
  }

  async getOperation(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
  ): Promise<SwapExecutionRecord | undefined> {
    const key = swapOperationKey(accountIncarnation, localPublicKey, swapId)
    const row = await this.options.store.getRecord(key)
    if (!row) return undefined
    return JSON.parse(row.raw) as SwapExecutionRecord
  }

  private async saveRecord(
    expectedRevision: number,
    record: SwapExecutionRecord,
  ): Promise<SwapExecutionRecord> {
    const key = swapOperationKey(
      record.accountIncarnation,
      record.localPublicKey,
      record.swapId,
    )
    const next: SwapExecutionRecord = {
      ...record,
      revision: expectedRevision + 1,
    }
    const ok = await this.options.store.compareAndSwap(
      key,
      expectedRevision,
      JSON.stringify(next),
    )
    if (!ok) {
      throw new Error('Swap execution record conflict')
    }
    if (this.options.onUpdate) {
      const all = await this.listOperations({
        accountIncarnation: record.accountIncarnation,
        localPublicKey: record.localPublicKey,
      })
      this.options.onUpdate(all)
    }
    return next
  }

  /**
   * Acquires a custody retention hold, reserves exact XEC and EVM inputs, seals any local
   * adaptor secret, and persists the prepared operation write-ahead before any funding broadcast.
   */
  async prepare(input: PrepareSwapInput): Promise<SwapExecutionRecord> {
    const existing = await this.getOperation(
      input.accountIncarnation,
      input.localPublicKey,
      input.swapId,
    )
    if (existing) return existing
    if (input.nowSec >= input.expiry) {
      throw new Error('Negotiation expired before execution preparation')
    }
    if (input.xecPrincipal <= 0n || input.evmPrincipal <= 0n) {
      throw new Error('Swap principals must be positive')
    }

    const retentionOperationId = `swap:${input.swapId.toLowerCase()}`
    await this.options.custody.acquireHold(retentionOperationId)

    let xecReserved = false
    let evmReserved = false
    try {
      const [xecReservation, evmReservation] = await Promise.all([
        this.options.xec.reserveInputs({
          swapId: input.swapId,
          principalSats: input.xecPrincipal,
        }),
        this.options.evm.reserveInput({
          swapId: input.swapId,
          principalWei: input.evmPrincipal,
        }),
      ])
      xecReserved = true
      evmReserved = true

      const jointPublicKey =
        input.jointPublicKey ?? '0x02' + input.swapId.toLowerCase().slice(0, 64)
      const adaptorPoint =
        input.adaptorPoint ?? '0x03' + input.swapId.toLowerCase().slice(0, 64)
      const contextBindingHex = computeSwapContextBindingHex({
        accountIncarnation: input.accountIncarnation,
        swapId: input.swapId,
        conversationId: input.conversationId,
        role: input.role,
        xecPrincipal: input.xecPrincipal.toString(),
        evmPrincipal: input.evmPrincipal.toString(),
        jointPublicKey,
        adaptorPoint,
      })

      let secretReceiptId: string | undefined
      let adaptorSecretHex: string | undefined
      if (input.adaptorSecret) {
        const secretCopy = new Uint8Array(input.adaptorSecret)
        if (
          this.options.verifySecretMatchesPoint &&
          !this.options.verifySecretMatchesPoint(secretCopy, adaptorPoint)
        ) {
          throw new Error('Adaptor secret does not match adaptor point')
        }
        if (this.options.secretVault) {
          const sealed = await this.options.secretVault.sealSecret({
            accountIncarnation: input.accountIncarnation,
            operationId: retentionOperationId,
            contextBindingHex,
            secret: secretCopy,
          })
          secretReceiptId = sealed.receiptId
        } else {
          adaptorSecretHex = bytesToHex(secretCopy)
        }
      }

      const xecRefundTimestamp = input.xecRefundTimestamp ?? input.nowSec + 3600
      const evmOpeningTimestamp = input.evmOpeningTimestamp ?? input.nowSec
      const evmChallengeDuration = input.evmChallengeDuration ?? 7200

      const initial: SwapExecutionRecord = {
        version: 1,
        revision: 0,
        swapId: input.swapId.toLowerCase(),
        conversationId: input.conversationId,
        accountIncarnation: input.accountIncarnation,
        localPublicKey: input.localPublicKey.toLowerCase(),
        peerPublicKey: input.peerPublicKey.toLowerCase(),
        role: input.role,
        xecChainIdentifier: input.xecChainIdentifier,
        evmChainIdentifier: input.evmChainIdentifier,
        xecPrincipal: input.xecPrincipal.toString(),
        evmPrincipal: input.evmPrincipal.toString(),
        xecFeeSats: xecReservation.feeSats.toString(),
        evmFeeBudgetWei: evmReservation.input.feeBudgetWei,
        expiry: input.expiry,
        xecRefundTimestamp,
        evmOpeningTimestamp,
        evmChallengeDuration,
        jointPublicKey,
        adaptorPoint,
        contextBindingHex,
        retentionOperationId,
        retentionReleased: false,
        secretReceiptId,
        adaptorSecretHex,
        xecInputs: xecReservation.inputs.map(i => ({ ...i })),
        evmInput: { ...evmReservation.input },
        xecFundingTxHex: xecReservation.fundingTxHex,
        xecFundingTxid: xecReservation.fundingTxid,
        evmFundingTxHex: evmReservation.fundingTxHex,
        evmFundingTxHash: evmReservation.fundingTxHash,
        xecClaimTxHex: xecReservation.claimTxHex,
        xecClaimTxid: xecReservation.claimTxid,
        evmClaimTxHex: evmReservation.claimTxHex,
        evmClaimTxHash: evmReservation.claimTxHash,
        xecRefundTxHex: xecReservation.refundTxHex,
        xecRefundTxid: xecReservation.refundTxid,
        evmRefundTxHex: evmReservation.refundTxHex,
        evmRefundTxHash: evmReservation.refundTxHash,
        fundingAuthorized: false,
        phase: 'prepared',
        xecFunding: { status: 'unseen', confirmations: 0 },
        evmFunding: { status: 'unseen', confirmations: 0 },
        xecSettlement: { effect: 'none', status: 'unseen', confirmations: 0 },
        evmSettlement: { effect: 'none', status: 'unseen', confirmations: 0 },
        maxObservedReorgDepth: 0,
      }
      return await this.saveRecord(0, initial)
    } catch (error) {
      if (xecReserved) {
        await this.options.xec.releaseInputs(input.swapId).catch(() => {})
      }
      if (evmReserved) {
        await this.options.evm.releaseInput(input.swapId).catch(() => {})
      }
      await this.options.custody
        .releaseHold(retentionOperationId)
        .catch(() => {})
      throw error
    }
  }

  /**
   * Persists explicit local funding authorization write-ahead, then broadcasts the
   * exact pre-signed funding transactions. Re-entrant calls replay the original signed bytes.
   */
  async fund(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
  ): Promise<SwapExecutionRecord> {
    let record = await this.getOperation(
      accountIncarnation,
      localPublicKey,
      swapId,
    )
    if (!record) {
      throw new Error('Swap operation not prepared')
    }
    if (record.phase === 'cancelled') {
      throw new Error('Cancelled swap operation cannot be funded')
    }
    if (!record.fundingAuthorized) {
      record = await this.saveRecord(record.revision, {
        ...record,
        fundingAuthorized: true,
        phase: record.phase === 'prepared' ? 'funding' : record.phase,
      })
    }
    await Promise.all([
      this.options.xec.broadcastTransaction(record.xecFundingTxHex),
      this.options.evm.broadcastTransaction(record.evmFundingTxHex),
    ])
    return await this.reconcile(accountIncarnation, localPublicKey, swapId)
  }

  /**
   * Cancels a prepared swap before funding authorization is released.
   * Refuses after funding cutoff (`fundingAuthorized === true`).
   */
  async cancelBeforeExposure(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
  ): Promise<SwapExecutionRecord> {
    const record = await this.getOperation(
      accountIncarnation,
      localPublicKey,
      swapId,
    )
    if (!record) {
      throw new Error('Swap operation not found')
    }
    if (record.fundingAuthorized || record.phase !== 'prepared') {
      throw new Error('Cannot cancel swap after funding exposure cutoff')
    }
    await this.options.xec.releaseInputs(record.swapId)
    await this.options.evm.releaseInput(record.swapId)
    await this.options.custody.releaseHold(record.retentionOperationId)
    return await this.saveRecord(record.revision, {
      ...record,
      retentionReleased: true,
      phase: 'cancelled',
    })
  }

  /**
   * Broadcasts the claim transaction(s) once funding is final on both legs (or when the
   * adaptor secret has been revealed by the counterparty's claim).
   */
  async claim(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
  ): Promise<SwapExecutionRecord> {
    let record = await this.reconcile(
      accountIncarnation,
      localPublicKey,
      swapId,
    )
    if (
      record.phase !== 'funded' &&
      record.phase !== 'claiming' &&
      record.phase !== 'complete' &&
      !record.adaptorSecretHex
    ) {
      throw new Error('Swap is not ready to claim')
    }
    if (
      record.secretReceiptId &&
      !record.retentionReleased &&
      !record.adaptorSecretHex &&
      this.options.secretVault
    ) {
      const opened = await this.options.secretVault.openSecret({
        accountIncarnation: record.accountIncarnation,
        operationId: record.retentionOperationId,
        contextBindingHex: record.contextBindingHex,
        receiptId: record.secretReceiptId,
      })
      if (
        this.options.verifySecretMatchesPoint &&
        !this.options.verifySecretMatchesPoint(opened, record.adaptorPoint)
      ) {
        throw new Error('Recovered adaptor secret failed point verification')
      }
      record = await this.saveRecord(record.revision, {
        ...record,
        adaptorSecretHex: bytesToHex(opened),
      })
    }
    if (record.phase !== 'claiming' && record.phase !== 'complete') {
      record = await this.saveRecord(record.revision, {
        ...record,
        phase: 'claiming',
      })
    }
    await Promise.all([
      this.options.xec.broadcastTransaction(record.xecClaimTxHex),
      this.options.evm.broadcastTransaction(record.evmClaimTxHex),
    ])
    return await this.reconcile(accountIncarnation, localPublicKey, swapId)
  }

  /**
   * Broadcasts the pre-signed independent refund transaction(s) once the refund window
   * is reached or recovery is required.
   */
  async refund(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<SwapExecutionRecord> {
    let record = await this.reconcile(
      accountIncarnation,
      localPublicKey,
      swapId,
    )
    const evmRefundReady =
      nowSec >= record.evmOpeningTimestamp + record.evmChallengeDuration
    const xecRefundReady = nowSec >= record.xecRefundTimestamp
    if (
      !xecRefundReady &&
      !evmRefundReady &&
      record.phase !== 'recovery-required' &&
      record.phase !== 'refund-pending'
    ) {
      throw new Error('Refund timelock has not matured yet')
    }
    if (record.phase !== 'refund-pending' && record.phase !== 'refunded') {
      record = await this.saveRecord(record.revision, {
        ...record,
        phase: 'refund-pending',
      })
    }
    await Promise.all([
      this.options.xec.broadcastTransaction(record.xecRefundTxHex),
      this.options.evm.broadcastTransaction(record.evmRefundTxHex),
    ])
    return await this.reconcile(accountIncarnation, localPublicKey, swapId)
  }

  /**
   * Re-observes both chains, replays displaced signed transactions, retains learned
   * adaptor secrets across reorgs, surfaces warnings on >10-block reorgs or contradicted
   * states, and releases custody retention holds only after terminal finality.
   */
  async reconcile(
    accountIncarnation: string,
    localPublicKey: string,
    swapId: string,
  ): Promise<SwapExecutionRecord> {
    const record = await this.getOperation(
      accountIncarnation,
      localPublicKey,
      swapId,
    )
    if (!record) {
      throw new Error('Swap operation not found')
    }
    if (record.phase === 'cancelled') return record

    const [rawXecFunding, rawEvmFunding, rawXecSettlement, rawEvmSettlement] =
      await Promise.all([
        this.options.xec.observeFunding(record.xecFundingTxid),
        this.options.evm.observeFunding(record.evmFundingTxHash),
        this.options.xec.observeSettlement({
          fundingTxid: record.xecFundingTxid,
          claimTxid: record.xecClaimTxid,
          refundTxid: record.xecRefundTxid,
        }),
        this.options.evm.observeSettlement({
          fundingTxHash: record.evmFundingTxHash,
          claimTxHash: record.evmClaimTxHash,
          refundTxHash: record.evmRefundTxHash,
        }),
      ])

    const xecFunding = normalizeConfirmations(rawXecFunding)
    const evmFunding = normalizeConfirmations(rawEvmFunding)
    const xecSettlement = normalizeSettlement(rawXecSettlement)
    const evmSettlement = normalizeSettlement(rawEvmSettlement)

    // Replay original signed transactions if funding was authorized but displaced on-chain
    if (record.fundingAuthorized) {
      if (xecFunding.status === 'unseen') {
        await this.options.xec.broadcastTransaction(record.xecFundingTxHex)
      }
      if (evmFunding.status === 'unseen') {
        await this.options.evm.broadcastTransaction(record.evmFundingTxHex)
      }
    }
    if (record.phase === 'claiming') {
      if (xecSettlement.status === 'unseen') {
        await this.options.xec.broadcastTransaction(record.xecClaimTxHex)
      }
      if (evmSettlement.status === 'unseen') {
        await this.options.evm.broadcastTransaction(record.evmClaimTxHex)
      }
    }
    if (record.phase === 'refund-pending') {
      if (xecSettlement.status === 'unseen') {
        await this.options.xec.broadcastTransaction(record.xecRefundTxHex)
      }
      if (evmSettlement.status === 'unseen') {
        await this.options.evm.broadcastTransaction(record.evmRefundTxHex)
      }
    }

    // Secret knowledge never rolls back across reorgs
    const adaptorSecretHex =
      record.adaptorSecretHex ?? xecSettlement.extractedSecretHex
    if (
      adaptorSecretHex &&
      this.options.verifySecretMatchesPoint &&
      !this.options.verifySecretMatchesPoint(
        hexToBytes(adaptorSecretHex),
        record.adaptorPoint,
      )
    ) {
      throw new Error('Observed adaptor secret failed point verification')
    }

    const maxObservedReorgDepth = Math.max(
      record.maxObservedReorgDepth,
      xecFunding.revertedDepth ?? 0,
      evmFunding.revertedDepth ?? 0,
      xecSettlement.revertedDepth ?? 0,
      evmSettlement.revertedDepth ?? 0,
    )

    const contradicted =
      (xecSettlement.effect === 'claim' && evmSettlement.effect === 'refund') ||
      (xecSettlement.effect === 'refund' && evmSettlement.effect === 'claim')
    const deepReorg = maxObservedReorgDepth > SWAP_FINALITY_CONFIRMATIONS

    let reorgWarning = record.reorgWarning
    if (contradicted) {
      reorgWarning = 'contradicted-settlement'
    } else if (deepReorg) {
      reorgWarning = 'deep-reorg-exceeded-finality'
    }

    let phase: SwapExecutionPhase = record.phase
    if (contradicted) {
      phase = 'recovery-required'
    } else if (
      xecSettlement.effect === 'claim' &&
      evmSettlement.effect === 'claim' &&
      xecSettlement.status === 'final' &&
      evmSettlement.status === 'final'
    ) {
      phase = 'complete'
    } else if (
      xecSettlement.effect === 'refund' &&
      evmSettlement.effect === 'refund' &&
      xecSettlement.status === 'final' &&
      evmSettlement.status === 'final'
    ) {
      phase = 'refunded'
    } else if (
      xecSettlement.effect === 'refund' ||
      evmSettlement.effect === 'refund'
    ) {
      phase = 'refund-pending'
    } else if (deepReorg) {
      phase = 'recovery-required'
    } else if (
      xecSettlement.effect === 'claim' ||
      evmSettlement.effect === 'claim'
    ) {
      phase = 'claiming'
    } else if (xecFunding.status === 'final' && evmFunding.status === 'final') {
      phase = 'funded'
    } else if (record.fundingAuthorized) {
      phase = 'funding'
    }

    let retentionReleased = record.retentionReleased
    if (
      (phase === 'complete' || phase === 'refunded') &&
      !retentionReleased &&
      !reorgWarning
    ) {
      if (record.secretReceiptId && this.options.secretVault?.retireSecret) {
        await this.options.secretVault.retireSecret(record.secretReceiptId)
      }
      await this.options.xec.releaseInputs(record.swapId)
      await this.options.evm.releaseInput(record.swapId)
      await this.options.custody.releaseHold(record.retentionOperationId)
      retentionReleased = true
    }

    return await this.saveRecord(record.revision, {
      ...record,
      adaptorSecretHex,
      xecFunding,
      evmFunding,
      xecSettlement,
      evmSettlement,
      maxObservedReorgDepth,
      reorgWarning,
      phase,
      retentionReleased,
    })
  }
}
