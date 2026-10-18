/** Installed headless recovery. Only original authenticated envelopes cross this boundary. */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { standaloneItemBudget } from '@frank/codec'
import {
  createNegotiationMessagePlugin,
  NEGOTIATION_ITEM_TYPE,
} from './message-plugin'
import {
  decodeNegotiationEventSchema,
  validateAuthenticatedNegotiationEvent,
  type NegotiationContext,
  type NegotiationPairPolicy,
} from './negotiation'
import {
  NegotiationJournal,
  NegotiationJournalError,
  inspectNegotiationJournalRecord,
  type NegotiationJournalInspection,
  type NegotiationJournalOwner,
} from './negotiation-journal'
import type { OwnedNegotiationJournalStore } from './storage/negotiation-common'

export type NegotiationRecoveryState =
  | 'restoring'
  | 'scanning'
  | 'ready'
  | 'unsupported'
  | 'incomplete'
  | 'capacity'
  | 'storage-error'
export interface NegotiationRecoverySnapshot {
  readonly state: NegotiationRecoveryState
  readonly coverage: number | undefined
  readonly journals: readonly NegotiationJournalInspection[]
}
export interface NegotiationEnvelope {
  readonly chainIdentifier: string
  readonly senderPublicKey: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly direction: 'incoming' | 'outbound'
  readonly payloadDigest: string
  readonly conversationId?: string
  readonly messageId?: string
  readonly items: readonly {
    readonly type: string
    readonly itemType?: string
    readonly value?: unknown
  }[]
}
export interface NegotiationScan {
  readonly records: readonly NegotiationEnvelope[]
  readonly resumeFromInclusive: number
  /** Any incomplete scan: a page cutoff/failure or unresolved timestamp group.
   * False includes complete empty reads with an unchanged inclusive position. */
  readonly truncated: boolean
}
export interface NegotiationRecoveryOptions {
  readonly owner: NegotiationJournalOwner
  readonly policy: NegotiationPairPolicy
  readonly openStore: () => Promise<OwnedNegotiationJournalStore>
  readonly scan: (sinceMs: number) => Promise<NegotiationScan>
  readonly schedule: (work: () => void, delayMs: number) => () => void
  readonly publish: (snapshot: NegotiationRecoverySnapshot) => void
  readonly scanTimeoutMs?: number
  readonly retryDelayMs?: (attempt: number) => number
}
const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b)
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const uuidBytes = (value: string) => hexToBytes(value.replace(/-/g, ''))
const identity = (value: unknown, size: number): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value)

/** Derived snapshots have no write API. Storage remains the sole durable evidence owner. */
export class NegotiationRecovery {
  private active = true
  private store?: OwnedNegotiationJournalStore
  private opening?: Promise<OwnedNegotiationJournalStore>
  private cleanup: Promise<void> = Promise.resolve()
  private cancelTimer?: () => void
  private cancelScanTimer?: () => void
  private closing?: Promise<void>
  private work?: Promise<void>
  /** Timeout revokes a pass result; it does not cancel the underlying network request. */
  private outstandingScan?: Promise<NegotiationScan>
  private failures = 0
  private state: NegotiationRecoveryState = 'restoring'
  private coverage: number | undefined
  private rows: readonly { key: string; raw: string }[] = []
  private readonly owner: NegotiationJournalOwner
  private readonly policy: NegotiationPairPolicy
  private readonly plugin: ReturnType<typeof createNegotiationMessagePlugin>
  private readonly options: NegotiationRecoveryOptions
  constructor(options: NegotiationRecoveryOptions) {
    this.options = { ...options }
    this.owner = {
      ...options.owner,
      localPublicKey: new Uint8Array(options.owner.localPublicKey),
    }
    this.policy = { ...options.policy }
    this.plugin = createNegotiationMessagePlugin(this.policy)
  }
  get snapshot(): NegotiationRecoverySnapshot {
    return Object.freeze({
      state: this.state,
      coverage: this.coverage,
      journals: Object.freeze(
        this.rows.map(row => inspectNegotiationJournalRecord(row.raw)),
      ),
    })
  }
  private publish(state: NegotiationRecoveryState): void {
    if (!this.active) return
    this.state = state
    this.options.publish(this.snapshot)
  }
  private async restore(): Promise<void> {
    this.opening = this.options.openStore()
    const store = await this.opening
    if (!this.active) {
      await store.close()
      return
    }
    this.store = store
    await this.refresh()
  }
  private async refresh(): Promise<void> {
    if (!this.active || !this.store) return
    const rows = await this.store.listRecords()
    const selected = rows.filter(row => {
      const checked = inspectNegotiationJournalRecord(row.raw)
      if (
        checked.rowKey !== row.key ||
        checked.owner.accountIncarnation !== this.owner.accountIncarnation ||
        !same(checked.owner.localPublicKey, this.owner.localPublicKey)
      )
        throw new Error('Negotiation restoration affinity')
      return (
        checked.owner.messagingChainIdentifier ===
          this.owner.messagingChainIdentifier &&
        checked.context.policy.name === this.policy.name
      )
    })
    if (!this.active) return
    this.rows = selected.map(row => ({ ...row }))
    this.coverage = await this.store.readCoverage(
      this.owner.messagingChainIdentifier,
    )
  }
  /** Starts independent work; callers never await network scanning. */
  start(): void {
    this.launch()
  }
  private launch(): void {
    if (!this.active || this.work) return
    const work = this.pass()
    this.work = work
    void work
      .finally(() => {
        if (this.work === work) this.work = undefined
        if (this.active)
          this.cancelTimer = this.options.schedule(
            () => this.launch(),
            this.failures
              ? this.options.retryDelayMs?.(this.failures) ??
                  Math.min(3000 * 2 ** (this.failures - 1), 60000)
              : 3000,
          )
      })
      .catch(() => {
        // Observe task failures even if a host publication callback itself failed.
        if (this.active) this.state = 'storage-error'
      })
  }
  private async pass(): Promise<void> {
    try {
      if (this.outstandingScan) throw new ScanUnavailable()
      if (!this.store) {
        this.publish('restoring')
        await this.restore()
      }
      if (!this.active || !this.store) return
      const expected = await this.store.readCoverage(
        this.owner.messagingChainIdentifier,
      )
      if (!this.active) return
      if (this.state !== 'ready') this.publish('scanning')
      const result = await this.scan(expected ?? 0)
      if (!this.active) return
      if (
        !Number.isSafeInteger(result.resumeFromInclusive) ||
        result.resumeFromInclusive < (expected ?? 0)
      )
        throw new Error('Invalid scanner coverage')
      // Copy all caller-owned records before the first asynchronous admission.
      const records = result.records.map(record => ({
        ...record,
        senderPublicKey: new Uint8Array(record.senderPublicKey),
        recipientPublicKey: new Uint8Array(record.recipientPublicKey),
        items: record.items.map(item => ({
          ...item,
          value:
            item.type === 'application' &&
            item.itemType === NEGOTIATION_ITEM_TYPE
              ? this.projection(item.value)
              : undefined,
        })),
      }))
      for (const record of records) {
        for (const item of record.items) {
          if (!this.active) return
          if (
            item.type !== 'application' ||
            item.itemType !== NEGOTIATION_ITEM_TYPE ||
            !item.value
          )
            continue
          const admission = this.admission(record, item.value)
          if (!admission) continue
          // Track the entire journal operation, including its read/CAS sequence, for shutdown.
          const owned = admission.journal.admit(admission.input)
          this.ownedWrite = owned.then(
            () => undefined,
            () => undefined,
          )
          await owned
        }
      }
      if (!this.active) return
      const commit = this.store.compareAndSwapCoverage(
        this.owner.messagingChainIdentifier,
        expected,
        result.resumeFromInclusive,
      )
      this.ownedWrite = commit.then(
        () => undefined,
        () => undefined,
      )
      await commit // A lost CAS is reconciled by the committed read below.
      if (!this.active) return
      await this.refresh()
      this.failures = 0
      this.publish(result.truncated ? 'incomplete' : 'ready')
    } catch (error) {
      if (!this.active) return
      this.failures++
      this.publish(
        error instanceof ScanUnavailable
          ? 'incomplete'
          : error instanceof NegotiationJournalError &&
            error.code === 'capacity'
          ? 'capacity'
          : 'storage-error',
      )
      const store = this.store
      this.store = undefined
      if (store) {
        this.cleanup = store.close().catch(() => {
          /* Next bounded attempt reopens and reconciles. */
        })
        await this.cleanup
      }
    }
  }
  private async scan(sinceMs: number): Promise<NegotiationScan> {
    const request = this.options.scan(sinceMs)
    this.outstandingScan = request
    const settled = () => {
      if (this.outstandingScan === request) this.outstandingScan = undefined
    }
    // Observe either outcome even after timeout/stop. A late result is never reused.
    void request.then(settled, settled)
    let cancel: (() => void) | undefined
    const timeout = new Promise<never>((_, reject) => {
      cancel = this.options.schedule(
        () => reject(new ScanUnavailable()),
        this.options.scanTimeoutMs ?? 30000,
      )
      this.cancelScanTimer = cancel
    })
    try {
      return await Promise.race([
        request.catch(() => {
          throw new ScanUnavailable()
        }),
        timeout,
      ])
    } finally {
      cancel?.()
      if (this.cancelScanTimer === cancel) this.cancelScanTimer = undefined
    }
  }
  private projection(value: unknown): string | undefined {
    // Only plugin input errors are terminal content. Storage/programming exceptions propagate.
    try {
      return this.plugin.read(value).eventHex
    } catch (error) {
      if (error instanceof TypeError) return undefined
      throw error
    }
  }
  private admission(record: NegotiationEnvelope, eventHex: string) {
    if (
      record.chainIdentifier !== this.owner.messagingChainIdentifier ||
      !uuid(record.conversationId) ||
      !uuid(record.messageId) ||
      !identity(record.payloadDigest, 32) ||
      (record.direction !== 'incoming' && record.direction !== 'outbound')
    )
      return
    const eventBytes = hexToBytes(eventHex)
    const decoded = decodeNegotiationEventSchema(
      eventBytes,
      this.policy,
      standaloneItemBudget(),
    )
    if (!decoded.ok) return
    const event = decoded.value
    const context: NegotiationContext = {
      swapId: event.event.swapId,
      conversationId: uuidBytes(record.conversationId),
      parties:
        event.kind === 'offer'
          ? event.terms.parties
          : [record.recipientPublicKey, record.senderPublicKey],
      policy: this.policy,
    }
    const authenticated = {
      direction:
        record.direction === 'outbound'
          ? ('outbound-replay' as const)
          : ('incoming' as const),
      localPublicKey: this.owner.localPublicKey,
      senderPublicKey: record.senderPublicKey,
      recipientPublicKey: record.recipientPublicKey,
      conversationId: context.conversationId,
      messagingChainIdentifier: this.owner.messagingChainIdentifier,
    }
    if (
      !validateAuthenticatedNegotiationEvent(
        eventBytes,
        context,
        authenticated,
        standaloneItemBudget(),
      ).ok
    )
      return
    return {
      journal: new NegotiationJournal({
        owner: this.owner,
        context,
        store: this.store!,
      }),
      input: {
        eventBytes,
        authenticated,
        messageId: uuidBytes(record.messageId),
        stampedPayloadDigest: hexToBytes(record.payloadDigest),
      },
    }
  }
  private ownedWrite: Promise<void> = Promise.resolve()
  /** Revoke synchronously. Never wait for a hanging scanner; drain already admitted writes. */
  stop(): Promise<void> {
    this.active = false
    this.cancelTimer?.()
    this.cancelScanTimer?.()
    return (this.closing ??= Promise.all([
      this.ownedWrite,
      this.cleanup,
      this.opening?.catch(() => undefined),
    ]).then(async () => {
      await this.store?.close()
      await (await this.opening?.catch(() => undefined))?.close()
    }))
  }
}

class ScanUnavailable extends Error {}
