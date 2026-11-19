/**
 * Headless HTLC swap runner (docs/plans/htlc-swaps/README.md, "Ownership"): watches every
 * accepted negotiation of one account, re-derives each swap's state from the journal, its swap
 * record and the chains on every tick, and takes the next step `nextAction` names. It runs
 * independently of any UI; a host starts it at session activation and may `poke` it on block
 * events.
 *
 * Ownership: the negotiation journal owns the signed terms; the swap record (this package's
 * store) owns what only this device knows (the funding authorization, A's lock operation id and
 * the signed eCash spend, written before broadcast); the wallets own keys, the eCash funding
 * operation and the EVM call journal (`htlc` records); the chains own lock state, the revealed
 * preimage and the outcome. Nothing chain-derived is persisted.
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  htlcSwapCutoffs,
  storedXecSpendOf,
  htlcSwapTermsOf,
  nextAction,
  parseHtlcSwapRecord,
  resolveHtlcSwapRole,
  serializeHtlcSwapRecord,
  xecLockOperationIdOf,
  type Clock,
  type EvmHtlcCapability,
  type HtlcSwapAction,
  type HtlcSwapDecision,
  type HtlcSwapPhase,
  type HtlcSwapRecord,
  type HtlcSwapRole,
  type HtlcSwapTerms,
  type HtlcSwapWarning,
  type OfferSwapIdKeyedHash,
  type SwapSecretCapability,
  type XecHtlcCapability,
} from './htlc-swap'
import type { NegotiationContext, NegotiationReduction } from './negotiation'

/** Revision-CAS storage of swap records (the IndexedDB adapter is storage/htlc-swap-browser). */
export interface HtlcSwapRecordStore {
  getRecord(key: string): Promise<{ revision: number; raw: string } | undefined>
  listRecords(): Promise<
    readonly { key: string; revision: number; raw: string }[]
  >
  /** Writes `nextRaw` at revision `expectedRevision + 1` only if the stored revision (0 when
   * absent) is `expectedRevision`; false when another writer won. */
  compareAndSwap(
    key: string,
    expectedRevision: number,
    nextRaw: string,
  ): Promise<boolean>
}

/** A single-process store: for tests and hosts whose process is the whole lifetime. */
export class MemoryHtlcSwapRecordStore implements HtlcSwapRecordStore {
  private readonly rows = new Map<string, { revision: number; raw: string }>()
  async getRecord(key: string) {
    const row = this.rows.get(key)
    return row ? { ...row } : undefined
  }
  async listRecords() {
    return [...this.rows].map(([key, row]) => ({ key, ...row }))
  }
  async compareAndSwap(key: string, expectedRevision: number, nextRaw: string) {
    if ((this.rows.get(key)?.revision ?? 0) !== expectedRevision) return false
    this.rows.set(key, { revision: expectedRevision + 1, raw: nextRaw })
    return true
  }
}

/** One authenticated negotiation of the account, as its journal reduces it. */
export interface HtlcSwapNegotiation {
  readonly context: NegotiationContext
  readonly reduction: NegotiationReduction
}
export interface HtlcSwapNegotiationSource {
  list(): Promise<readonly HtlcSwapNegotiation[]>
}

export interface HtlcSwapView {
  readonly swapId: string
  readonly conversationId: string
  readonly role: HtlcSwapRole | null
  /** `invalid`: the terms cannot be executed by this account (detail says why);
   * `unsupported`: the swap is on networks this runner was not composed for; `checking`: no
   * pass over this swap has finished yet (the last one failed, see `error`; it is retried). */
  readonly phase: HtlcSwapPhase | 'invalid' | 'unsupported' | 'checking'
  readonly detail?: string
  readonly warnings: readonly HtlcSwapWarning[]
  /** With `lock-funds-low`: how much more the EVM main account needs, and by when. */
  readonly lockFunds?: {
    readonly shortfallWei: bigint
    readonly lockBy: number
  }
  readonly deadlines?: {
    readonly acceptBy: number
    readonly evmExpiry: number
    readonly xecRefundTime: number
  }
  readonly lockId?: string
  readonly funding?: { readonly txid: string; readonly vout: number }
  /** The signed eCash spends in the record, one per funding output. */
  readonly xecSpends?: readonly {
    readonly funding: { readonly txid: string; readonly vout: number }
    readonly branch: string
    readonly txid: string
  }[]
  /** The step taken on the last tick, if any. */
  readonly lastAction?: HtlcSwapAction['kind']
  /** Why the last tick could not observe or act (it is retried on the next). */
  readonly error?: string
  readonly updatedAt: number
}

export interface HtlcSwapRunnerOptions {
  readonly owner: {
    readonly accountIncarnation: string
    readonly localPublicKey: Uint8Array
  }
  readonly negotiations: HtlcSwapNegotiationSource
  readonly store: HtlcSwapRecordStore
  readonly xec: XecHtlcCapability
  readonly evm: EvmHtlcCapability
  readonly secrets: SwapSecretCapability
  /** The account's keyed hash of offer swapId transcripts (re-derivation proves authorship). */
  readonly offerSwapId: OfferSwapIdKeyedHash
  readonly clock: Clock
  /** Whether this is the account's active device; only it starts anything. Default: yes. */
  readonly isActiveDevice?: () => boolean
  readonly onError?: (swapId: string, error: unknown) => void
}

/** The host's timers (this package compiles without DOM or Node types). */
const timers = globalThis as unknown as {
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const CAS_ATTEMPTS = 8
/** A claimOwed call is not repeated within this many seconds. */
const CLAIM_OWED_BACKOFF = 600

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export class HtlcSwapRunner {
  private readonly options: HtlcSwapRunnerOptions
  private readonly localKeyHex: string
  private views = new Map<string, HtlcSwapView>()
  private listeners = new Set<(views: readonly HtlcSwapView[]) => void>()
  private running: Promise<readonly HtlcSwapView[]> | undefined
  private again = false
  private timer: unknown
  private stopped = false
  private readonly claimOwedAt = new Map<string, number>()

  constructor(options: HtlcSwapRunnerOptions) {
    this.options = options
    this.localKeyHex = bytesToHex(options.owner.localPublicKey)
  }

  snapshot(): readonly HtlcSwapView[] {
    return [...this.views.values()]
  }

  subscribe(listener: (views: readonly HtlcSwapView[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ticks every `intervalMs` (plan: ~15 s) until `stop`. */
  start(intervalMs = 15_000): void {
    if (this.timer !== undefined || this.stopped) return
    this.timer = timers.setInterval(() => this.poke(), intervalMs)
    this.poke()
  }

  /** A tick soon (a new block, a new negotiation event); coalesced with one in progress. */
  poke(): void {
    if (this.stopped) return
    this.tick().catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) timers.clearInterval(this.timer)
    this.timer = undefined
    await this.running?.catch(() => undefined)
  }

  /** One pass over every negotiation. Ticks never overlap: a call during one runs after it. */
  tick(): Promise<readonly HtlcSwapView[]> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again && !this.stopped)
        return this.snapshot()
      } finally {
        this.running = undefined
      }
    })()
    this.running = run
    return run
  }

  private async pass(): Promise<void> {
    const negotiations = await this.options.negotiations.list()
    for (const negotiation of negotiations) {
      // A stop during a pass ends it: nothing more is observed or done after `stop`.
      if (this.stopped) return
      const swapId = bytesToHex(negotiation.context.swapId)
      let view: HtlcSwapView | undefined
      try {
        view = await this.step(negotiation)
      } catch (error) {
        this.options.onError?.(swapId, error)
        const previous = this.views.get(swapId)
        view = {
          swapId,
          conversationId: bytesToHex(negotiation.context.conversationId),
          role: previous?.role ?? null,
          phase: previous?.phase ?? 'checking',
          warnings: previous?.warnings ?? [],
          ...(previous?.lockFunds ? { lockFunds: previous.lockFunds } : {}),
          ...(previous?.deadlines ? { deadlines: previous.deadlines } : {}),
          ...(previous?.lockId ? { lockId: previous.lockId } : {}),
          error: message(error),
          updatedAt: this.options.clock.now(),
        }
      }
      if (view) this.views.set(swapId, view)
    }
    const views = this.snapshot()
    for (const listener of this.listeners) listener(views)
  }

  private async step(
    negotiation: HtlcSwapNegotiation,
  ): Promise<HtlcSwapView | undefined> {
    const { context, reduction } = negotiation
    const { xec, evm, clock } = this.options
    const swapId = bytesToHex(context.swapId)
    const base = {
      swapId,
      conversationId: bytesToHex(context.conversationId),
      warnings: [] as HtlcSwapWarning[],
    }
    const offer = reduction.history.offer
    if (!offer) return undefined
    const invalid = (
      role: HtlcSwapRole | null,
      detail: string,
    ): HtlcSwapView => ({
      ...base,
      role,
      phase: 'invalid',
      detail,
      updatedAt: clock.now(),
    })
    if (reduction.violation)
      return invalid(
        null,
        reduction.violation.detail ?? reduction.violation.code,
      )
    const resolved = resolveHtlcSwapRole({
      context,
      offer: offer.terms,
      localPublicKey: this.options.owner.localPublicKey,
      offerSwapId: this.options.offerSwapId,
    })
    if (resolved.role === null) {
      if (!context.parties.some(p => bytesToHex(p) === this.localKeyHex))
        return undefined
      return invalid(null, resolved.reason)
    }
    const role = resolved.role
    if (
      context.policy.xecChainIdentifier !== xec.chainIdentifier ||
      context.policy.evmChainIdentifier !== evm.chainIdentifier
    )
      return {
        ...base,
        role,
        phase: 'unsupported',
        updatedAt: clock.now(),
      }
    const deadlines = {
      acceptBy: Number(offer.terms.expiry),
      evmExpiry: Number(offer.terms.evmExpiry),
      xecRefundTime: Number(offer.terms.xecRefundTime),
    }
    if (
      `0x${bytesToHex(offer.terms.evmHtlcContract)}` !==
      evm.htlcContract().toLowerCase()
    )
      return invalid(
        role,
        "The offer names another contract than this network's GenericHTLC",
      )
    if (role === 'A') {
      if (
        bytesToHex(offer.terms.xecRefundPublicKey) !==
        bytesToHex(xec.htlcPublicKey(swapId, 'refund'))
      )
        return invalid(
          role,
          'The offer’s eCash refund key is not this account’s',
        )
      if (
        `0x${bytesToHex(offer.terms.evmRecipient)}` !==
        evm.mainAccount().toLowerCase()
      )
        return invalid(
          role,
          'The offer’s EVM recipient is not this account’s main account',
        )
      const preimage = this.preimage(context)
      const matches =
        bytesToHex(sha256(preimage)) === bytesToHex(offer.terms.hashLock)
      preimage.fill(0)
      if (!matches)
        return invalid(role, 'The hash lock is not this account’s secret')
    }
    const record = await this.readRecord(swapId)
    const now = clock.now()
    const activeDevice = this.options.isActiveDevice?.() ?? true
    if (!reduction.usableAcceptance) {
      const decision = nextAction(
        reduction.history.decision === 'reject'
          ? { role, now, activeDevice, record, negotiation: 'rejected' }
          : {
              role,
              now,
              activeDevice,
              record,
              negotiation: 'offered',
              acceptBy: deadlines.acceptBy,
            },
      )
      return { ...base, role, phase: decision.phase, deadlines, updatedAt: now }
    }
    const terms = htlcSwapTermsOf({ context, reduction })
    if (role === 'B') {
      if (terms.evm.sender !== evm.mainAccount().toLowerCase())
        return invalid(
          role,
          'The accept’s EVM sender is not this account’s main account',
        )
      if (
        bytesToHex(terms.xec.terms.claimPublicKey) !==
        bytesToHex(xec.htlcPublicKey(swapId, 'claim'))
      )
        return invalid(
          role,
          'The accept’s eCash claim key is not this account’s',
        )
    }
    if (
      record &&
      (record.role !== role ||
        record.termsHash !== terms.termsHash ||
        record.owner.accountIncarnation !==
          this.options.owner.accountIncarnation ||
        record.owner.localPublicKey !== this.localKeyHex)
    )
      return invalid(
        role,
        'The stored swap record belongs to other terms or another account',
      )

    const [xecObservation, evmObservation, evmCalls, xecLockOperation] =
      await Promise.all([
        xec.observe(terms.xec.terms),
        evm.observe(terms.evm.lockId),
        evm.ownCalls(swapId),
        role === 'A' ? xec.lockOperation(swapId) : Promise.resolve(undefined),
      ])
    const decision = nextAction({
      role,
      now: clock.now(),
      activeDevice,
      record,
      negotiation: 'accepted',
      terms,
      observations: {
        xec: xecObservation,
        evm: evmObservation,
        evmCalls,
        ...(xecLockOperation ? { xecLockOperation } : {}),
      },
    })
    let error: string | undefined
    try {
      // The observations above took network round trips: a stop meanwhile acts on nothing.
      if (!this.stopped) await this.act(context, terms, role, decision, record)
    } catch (reason) {
      this.options.onError?.(swapId, reason)
      error = message(reason)
    }
    const stored = (await this.readRecord(swapId)) ?? record
    return {
      ...base,
      role,
      phase: decision.phase,
      warnings: decision.warnings,
      ...(decision.lockFunds ? { lockFunds: decision.lockFunds } : {}),
      deadlines,
      lockId: terms.evm.lockId,
      ...(decision.funding ? { funding: decision.funding } : {}),
      ...(stored?.xecSpends
        ? {
            xecSpends: stored.xecSpends.map(spend => ({
              funding: spend.funding,
              branch: spend.branch,
              txid: spend.txid,
            })),
          }
        : {}),
      ...(decision.action.kind === 'none'
        ? {}
        : { lastAction: decision.action.kind }),
      ...(error ? { error } : {}),
      updatedAt: clock.now(),
    }
  }

  /** A's preimage; only ever called after `resolveHtlcSwapRole` proved this account wrote the
   * offer (its swapId re-derives under the account's keyed hash). */
  private preimage(context: NegotiationContext): Uint8Array {
    const preimage = this.options.secrets.swapPreimage({
      policyName: context.policy.name,
      swapId: new Uint8Array(context.swapId),
    })
    if (!(preimage instanceof Uint8Array) || preimage.length !== 32)
      throw new Error('Swap secret capability returned a malformed preimage')
    return preimage
  }

  private async act(
    context: NegotiationContext,
    terms: HtlcSwapTerms,
    role: HtlcSwapRole,
    decision: HtlcSwapDecision,
    record: HtlcSwapRecord | undefined,
  ): Promise<void> {
    const { xec, evm, clock } = this.options
    const action = decision.action
    const swapId = terms.swapId
    switch (action.kind) {
      case 'none':
        return
      case 'fund-xec': {
        // Re-check the cutoff on a fresh clock unless the lock is already exposed (it is then
        // resumed: the same bytes may land either way).
        if (!action.resume && clock.now() > htlcSwapCutoffs(terms).xecFundBy)
          return
        const operationId = xecLockOperationIdOf(swapId)
        await this.writeRecord(terms, role, current => ({
          ...current,
          fundingAuthorizedAt: current.fundingAuthorizedAt ?? clock.now(),
          xecLockOperationId: operationId,
        }))
        await xec.fund({
          swapId,
          terms: terms.xec.terms,
          principalSats: terms.xec.principalSats,
        })
        return
      }
      case 'release-xec-lock':
        await xec.releaseLock(swapId)
        return
      case 'lock-evm': {
        if (clock.now() > htlcSwapCutoffs(terms).evmLockBy) return
        await this.writeRecord(terms, role, current => ({
          ...current,
          fundingAuthorizedAt: current.fundingAuthorizedAt ?? clock.now(),
        }))
        await evm.lock({
          swapId,
          lockId: terms.evm.lockId,
          terms: terms.evm.terms,
          deadline: action.deadline,
        })
        return
      }
      case 'withdraw-evm': {
        if (clock.now() > action.deadline) return
        const preimage = this.preimage(context)
        try {
          await evm.withdraw({
            swapId,
            lockId: terms.evm.lockId,
            preimage,
            deadline: action.deadline,
          })
        } finally {
          preimage.fill(0)
        }
        return
      }
      case 'refund-evm':
        await evm.refund({ swapId, lockId: terms.evm.lockId })
        return
      case 'sign-xec-spend': {
        if (
          action.branch === 'claim' &&
          (!action.preimage ||
            bytesToHex(sha256(action.preimage)) !==
              bytesToHex(terms.xec.terms.hashLock))
        )
          throw new Error(
            'The EVM lock’s preimage does not open the eCash HTLC',
          )
        const spend = await xec.signSpend({
          swapId,
          terms: terms.xec.terms,
          funding: action.funding,
          principalSats: terms.xec.principalSats,
          branch: action.branch,
          ...(action.branch === 'claim' ? { preimage: action.preimage } : {}),
        })
        // Write-ahead: the signed spend is durable before any broadcaster sees it.
        // An outpoint keeps the first spend written for it.
        const written = await this.writeRecord(terms, role, current =>
          storedXecSpendOf(current, action.funding)
            ? current
            : {
                ...current,
                xecSpends: [
                  ...(current.xecSpends ?? []),
                  {
                    funding: action.funding,
                    branch: action.branch,
                    rawTx: spend.rawTx,
                    txid: spend.txid,
                  },
                ],
              },
        )
        await xec.broadcast(storedXecSpendOf(written, action.funding)!.rawTx)
        return
      }
      case 'broadcast-xec-spend': {
        const stored = storedXecSpendOf(record, action.funding)
        if (stored) await xec.broadcast(stored.rawTx)
        return
      }
      case 'claim-owed': {
        const last = this.claimOwedAt.get(swapId)
        if (last !== undefined && clock.now() - last < CLAIM_OWED_BACKOFF)
          return
        this.claimOwedAt.set(swapId, clock.now())
        await evm.claimOwed()
        return
      }
    }
  }

  private async readRecord(
    swapId: string,
  ): Promise<HtlcSwapRecord | undefined> {
    const row = await this.options.store.getRecord(swapId)
    return row ? parseHtlcSwapRecord(row.raw) : undefined
  }

  /** Read-modify-write under CAS. */
  private async writeRecord(
    terms: HtlcSwapTerms,
    role: HtlcSwapRole,
    change: (current: HtlcSwapRecord) => HtlcSwapRecord,
  ): Promise<HtlcSwapRecord> {
    const { store, owner } = this.options
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const row = await store.getRecord(terms.swapId)
      const current: HtlcSwapRecord = row
        ? parseHtlcSwapRecord(row.raw)
        : {
            version: 1,
            swapId: terms.swapId,
            conversationId: terms.conversationId,
            owner: {
              accountIncarnation: owner.accountIncarnation,
              localPublicKey: this.localKeyHex,
            },
            role,
            termsHash: terms.termsHash,
          }
      const next = change(current)
      const raw = serializeHtlcSwapRecord(next)
      if (row?.raw === raw) return next
      if (await store.compareAndSwap(terms.swapId, row?.revision ?? 0, raw))
        return next
    }
    throw new Error('Swap record write contention')
  }
}
