import {
  EvmInputAdmissionError,
  nativeAdmissionJournal,
  type EvmInputAdmission,
  type WalletOperationLifetime,
  type NativeExecutionJournal,
  type NativeJournalReader,
  type PoolSpendApplication,
  type PoolSpendMemberClass,
} from '../evm-input-admission'
import {
  getAddress,
  hexlify,
  resolveAddress,
  Transaction,
  type Provider,
  type TransactionRequest,
} from 'ethers'
import type {
  ChainAddress,
  ChainTransaction,
  LegacyFeeEstimate,
  LegacySendProgress,
  LegacySendResult,
} from './chain-wallet'
import { NativeTransactionSubmissionError } from './chain-wallet'
import type { EvmTransactionBuilder } from './evm-transaction-builder'
import type { WalletSyncItem } from '@frank/cashweb/types/messages'
import {
  EvmNativeOperationJournal,
  nativeMaximumFee,
  type EvmNativeSource,
  type EvmNativeMemberPlan,
  type EvmNativeOperation,
  type EvmNativeAccountObservation,
  type EvmNativeObservation,
} from '../storage/evm-native-operation-journal'

export interface SendLegacyParams {
  recipient: ChainAddress
  value: bigint
  onProgress?: (progress: LegacySendProgress) => void
  onSigned?: (signed: ChainTransaction) => Promise<void>
}
export interface EvmLegacyConsolidatorConfig {
  provider: Provider
  journal: NativeJournalReader | EvmNativeOperationJournal
  inputAdmission?: EvmInputAdmission
  runLifetime?: <T>(
    operation: (lifetime: WalletOperationLifetime) => Promise<T>,
  ) => Promise<T>
  transactionBuilder: EvmTransactionBuilder
  getSources: () => Promise<EvmNativeSource[]>
  sign: (
    source: EvmNativeSource,
    unsignedTransaction: string,
  ) => Promise<string>
  /** Records one included member's spend on this device's own state (`poolSpendAdmission`). It is
   * called from inside the wallet queue the send holds, so it must go to the admission directly:
   * a route through `applyWalletSyncItem` re-enters that queue and waits for itself. */
  applyLocalMember?: (
    operationId: string,
    memberIndex: number,
    lifetime?: WalletOperationLifetime,
  ) => Promise<PoolSpendApplication>
  /** Read-only, from the pass's journal snapshot: whether `applyLocalMember` is worth calling. */
  classifyLocalMember?: (
    row: EvmNativeOperation,
    memberIndex: number,
    lifetime?: WalletOperationLifetime,
  ) => PoolSpendMemberClass
  /** Transport only. The item carries the member's complete signed transaction. */
  onSyncTransaction?: (item: WalletSyncItem) => Promise<void>
  /** Clock for the re-observation bounds (`reobservePending`), in milliseconds. Defaults to
   * `Date.now`. */
  now?: () => number
}
export class EvmNativeOperationPendingError extends NativeTransactionSubmissionError {
  constructor(readonly operation: EvmNativeOperation, reason: unknown) {
    const signed = operation.members.flatMap(m =>
      m.signed ? [m.signed.transactionHash] : [],
    )
    super({
      transaction: {
        txHash: signed[signed.length - 1] ?? '',
        relatedTxHashes: signed.slice(0, -1),
      },
      reason,
    })
    this.name = 'EvmNativeOperationPendingError'
  }
}
interface AvailableSource {
  source: EvmNativeSource
  account: EvmNativeAccountObservation
  spendableValue: bigint
}
/** A hold the local pass remembers. `basis` is the journal state it was held under. */
interface RememberedHold {
  readonly reason: string
  readonly basis: string
  skipped: number
}
/** How many consecutive passes skip a remembered hold whose journal basis has not changed before
 * it is tried once more. What can end a hold without a journal change (a canonical or topic
 * operation finishing, a lease released, a pool row changing) is invisible from here, so this
 * bounds how long such a hold outlives its cause: at most this many native sends or resumes. */
const HELD_RETRY_PASSES = 16
/** The reason of a refusal that states what the wallet's own records say: the admission's
 * (`conflicting-authorization`, `invalid-provenance`) or the pool's
 * (`SubAccountSpendRefusedError`). Anything else (a write that failed, a lifetime that ended, an
 * unknown throw) is not known to be a hold and is not remembered as one. */
function refusalReason(error: unknown): string | undefined {
  if (error instanceof EvmInputAdmissionError)
    return error.reason === 'conflicting-authorization' ||
      error.reason === 'invalid-provenance'
      ? error.reason
      : undefined
  if (
    error instanceof Error &&
    error.name === 'SubAccountSpendRefusedError' &&
    typeof (error as { code?: unknown }).code === 'string'
  )
    return `pool:${(error as unknown as { code: string }).code}`
  return undefined
}

/** Re-observation (`reobservePending`): the most receipt probes one pass may make. */
export const REOBSERVE_MAX_PROBES = 8
/** Re-observation: the least time between the end of one evaluation and the next, and the wait
 * after a member's first probe that learned nothing. */
export const REOBSERVE_MIN_INTERVAL_MS = 15_000
/** Re-observation: the longest wait between two probes of one member. */
export const REOBSERVE_MAX_BACKOFF_MS = 600_000
const REOBSERVE_STOPPED = Symbol('re-observation stopped')
interface ReobserveCandidate {
  readonly operationId: string
  readonly index: number
  readonly key: string
}

/** Wallet-lifetime native executor. Journal owns recovery; this module owns dependencies. */
export class EvmLegacyConsolidator {
  private tail: Promise<unknown> = Promise.resolve()
  /** Tasks on the executor queue that have not settled: a send, a resume or a local pass. */
  private queued = 0
  private syncTail: Promise<void> = Promise.resolve()
  private readonly active = new Map<string, Promise<EvmNativeOperation>>()
  /** This session's local result per member (`operationId:memberIndex`), written only by the
   * local pass. In memory on purpose: it gates transport, and the pool row is the record. */
  private readonly localResults = new Map<string, 'applied' | 'held'>()
  /**
   * Holds the local pass remembers, per member (`operationId:memberIndex`), so a member that was
   * refused is not classified and applied again by every later pass. Process memory only: never
   * persisted, gone on reopen.
   *
   * Only a HOLD is ever remembered. Nothing here records "applied", "no pool row" or "not
   * reserved", and a remembered hold only ever skips work that would have been refused: it can
   * delay a write, never stand in for one, and it takes no part in any selection.
   *
   * A remembered hold is dropped, and the member classified and applied afresh, when
   * - the journal state of its source address changes: any non-cancelled operation's member on
   *   that address is added, cancelled, signed, or observed in another state. That covers the
   *   member itself and every native member that can hold the address against it (a later member
   *   pending, an unsigned plan); or
   * - `HELD_RETRY_PASSES` passes have skipped it. Every other owner that can hold the row (a
   *   canonical or topic operation, a lease, a funding attempt) changes without the journal
   *   changing, and the consolidator cannot see it.
   */
  private holds = new Map<string, RememberedHold>()
  /** The whole pass, held: the admission's projection was not ready (conflicting, invalid or
   * uncertain), which holds every member alike. Its basis is the whole journal's state, because
   * a change to any operation (a cancelled plan, an observation) can make the projection ready. */
  private admissionHold?: RememberedHold
  /**
   * Re-observation state (`reobservePending`). All of it is process memory: nothing is persisted,
   * and a reopened wallet starts with none of it.
   */
  /** The pass whose network reads are in flight, if any. Never rejects. */
  private reobserving?: Promise<void>
  /** When the last evaluation started or, after a pass, when that pass ended. */
  private reobservedAt?: number
  /** The member probed last: the next pass starts after it, so no member is starved. */
  private reobserveCursor?: ReobserveCandidate
  /** Per member, the last probe that learned nothing and the wait it must be followed by. */
  private readonly reobserveBackoff = new Map<
    string,
    { probedAt: number; waitMs: number }
  >()
  /** A pass recorded a successful inclusion and the local pass has not run for it yet, or ran
   * and left an included member it may still apply (`localPassIncomplete`). */
  private localPassOwed = false
  /** Set by each local pass: it left an included, unapplied member that a later pass may apply
   * (held by the admission or by a remembered hold, refused, or failed), or could not read the
   * journal. Not set for a member that can never apply (`held-terminal`). */
  private localPassIncomplete = false
  private applyingRecorded = false
  private reobserveStopped = false
  private readonly reobserveStops = new Set<() => void>()
  constructor(private readonly config: EvmLegacyConsolidatorConfig) {}
  private run<T>(task: () => Promise<T>): Promise<T> {
    this.queued++
    const run = this.tail.then(task).finally(() => {
      this.queued--
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  async drain(): Promise<void> {
    await this.tail
    await this.syncTail
  }
  private journal(lifetime?: WalletOperationLifetime): NativeExecutionJournal {
    if (this.config.inputAdmission) {
      if (!lifetime)
        throw new Error('Native operation requires its captured lifetime')
      return nativeAdmissionJournal(this.config.inputAdmission, lifetime)
    }
    // An uncomposed executor may own an isolated journal. Composed wallets expose only readers.
    if (!('prepare' in this.config.journal))
      throw new Error('Native admission owner unavailable')
    return this.config.journal
  }
  listOperations(): EvmNativeOperation[] {
    return this.config.journal.list()
  }
  getUnresolvedLegacySend(): EvmNativeOperation[] {
    return this.listOperations().filter(
      r =>
        r.kind === 'legacy' &&
        !r.cancelled &&
        r.members[r.members.length - 1]!.observation.state !==
          'included-success',
    )
  }
  private async account(address: string): Promise<EvmNativeAccountObservation> {
    const { provider } = this.config
    const block = await provider.getBlock('latest')
    if (!block?.hash) throw new Error('Native account block unavailable')
    const [balance, nonce, checked] = await Promise.all([
      provider.getBalance(address, block.number),
      provider.getTransactionCount(address, block.number),
      provider.getBlock(block.number),
    ])
    if (checked?.hash !== block.hash)
      throw new Error('Native account block changed')
    return {
      blockHash: block.hash.toLowerCase(),
      blockNumber: block.number,
      nonce,
      balanceWei: balance.toString(),
    }
  }
  /** `wanted`, when given, is asked once the reads are in and before anything is recorded: an
   * observer that was stopped while it waited for the node records nothing. */
  async observe(
    operationId: string,
    index: number,
    lifetime?: WalletOperationLifetime,
    wanted?: () => boolean,
  ): Promise<void> {
    const journal = this.journal(lifetime),
      { provider } = this.config
    const member = journal.get(operationId).members[index]!
    if (!member.signed) return
    const capture = journal.beginCapture(operationId, index)
    let observation: EvmNativeObservation = { state: 'unknown' }
    let account: EvmNativeAccountObservation | null = null
    try {
      const expected = Transaction.from(member.signed.rawTransaction)
      const [transaction, receipt, state] = await Promise.all([
        provider.getTransaction(member.signed.transactionHash),
        provider.getTransactionReceipt(member.signed.transactionHash),
        this.account(member.source.address),
      ])
      account = state
      if (transaction === null && receipt === null)
        observation = { state: 'missing' }
      else if (
        transaction &&
        transaction.hash.toLowerCase() === expected.hash &&
        transaction.from.toLowerCase() === member.source.address &&
        Transaction.from(transaction).serialized === expected.serialized
      ) {
        if (receipt === null) observation = { state: 'pending' }
        else if (
          receipt.hash.toLowerCase() === expected.hash &&
          receipt.from.toLowerCase() === member.source.address &&
          receipt.to?.toLowerCase() === expected.to?.toLowerCase() &&
          transaction.blockHash?.toLowerCase() ===
            receipt.blockHash.toLowerCase() &&
          transaction.blockNumber === receipt.blockNumber &&
          transaction.index === receipt.index &&
          (receipt.status === 0 || receipt.status === 1)
        ) {
          const block = await provider.getBlock(receipt.blockNumber)
          if (
            block?.hash?.toLowerCase() === receipt.blockHash.toLowerCase() &&
            receipt.blockNumber <= account.blockNumber
          )
            observation = {
              state:
                receipt.status === 1 ? 'included-success' : 'included-revert',
              transactionHash: member.signed.transactionHash,
              blockHash: receipt.blockHash.toLowerCase(),
              blockNumber: receipt.blockNumber,
              transactionIndex: receipt.index,
              feeWei: (receipt.gasUsed * receipt.gasPrice).toString(),
            }
        }
      }
    } catch {
      /* Missing/unavailable/inconsistent evidence never proves nonexecution. */
    }
    if (wanted && !wanted()) return
    await journal.recordObservation(capture, observation, account)
  }
  private async sources(
    lifetime?: WalletOperationLifetime,
  ): Promise<AvailableSource[]> {
    const journal = this.journal(lifetime)
    const sources = new Map<string, EvmNativeSource>()
    for (const source of [
      ...(await this.config.getSources()),
      ...journal.sourceReferences(),
    ])
      sources.set(source.address, source)
    // Revalidate evidence used for source/dependent eligibility; observations do not release rows.
    for (const row of journal.list())
      if (!row.cancelled)
        for (let i = 0; i < row.members.length; i++) {
          if (
            row.members[i]!.signed &&
            sources.has(row.members[i]!.source.address)
          )
            await this.observe(row.operationId, i, lifetime)
        }
    const result: AvailableSource[] = []
    for (const source of sources.values()) {
      const account = await this.account(source.address)
      if (!journal.canSelect(source.address, account.nonce)) continue
      const spendableValue =
        this.config.transactionBuilder.supportsNativeConsolidation === true
          ? BigInt(account.balanceWei)
          : await this.config.transactionBuilder.getBalance({
              address: source.address,
              provider: this.config.provider,
            })
      if (spendableValue > 0n) result.push({ source, account, spendableValue })
    }
    return result
  }
  private async transaction(
    source: AvailableSource,
    recipient: string,
    amount: bigint,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ): Promise<string> {
    const request = await this.config.transactionBuilder.buildTransfer({
      from: source.source.address,
      recipient,
      amount,
      overrides: { nonce: source.account.nonce, ...fees },
    })
    if (
      request.from &&
      getAddress(String(request.from)).toLowerCase() !== source.source.address
    )
      throw new Error('Builder changed native source')
    if (request.nonce != null && request.nonce !== source.account.nonce)
      throw new Error('Builder changed native nonce')
    if (
      request.chainId != null &&
      BigInt(request.chainId) !==
        BigInt(this.config.journal.binding.nativeChainId)
    )
      throw new Error('Builder changed native chain')
    const unsigned: TransactionRequest = {
      ...request,
      from: source.source.address,
      nonce: source.account.nonce,
      chainId: BigInt(this.config.journal.binding.nativeChainId),
      type: request.type ?? 2,
    }
    if (unsigned.type === 0 || unsigned.type === 1) {
      unsigned.gasPrice ??= fees.maxFeePerGas
      delete unsigned.maxFeePerGas
      delete unsigned.maxPriorityFeePerGas
    } else {
      unsigned.maxFeePerGas ??= fees.maxFeePerGas
      unsigned.maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas
    }
    unsigned.gasLimit ??= await this.config.provider.estimateGas(unsigned)
    // Transaction.from deliberately excludes the custody-only `from` request property.
    if (
      unsigned.authorizationList?.length ||
      unsigned.blobs?.length ||
      unsigned.blobVersionedHashes?.length
    )
      throw new Error('Unsupported native transaction envelope')
    return Transaction.from({
      type: unsigned.type,
      to: await resolveAddress(unsigned.to ?? recipient),
      chainId: unsigned.chainId,
      nonce: unsigned.nonce,
      value: unsigned.value,
      data: hexlify(unsigned.data ?? '0x'),
      gasLimit: unsigned.gasLimit,
      gasPrice: unsigned.gasPrice,
      maxFeePerGas: unsigned.maxFeePerGas,
      maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas,
      accessList: unsigned.accessList,
    }).unsignedSerialized
  }
  private async plan(
    params: SendLegacyParams,
    kind: 'native' | 'legacy',
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const recipient = getAddress(params.recipient.raw).toLowerCase()
    if (params.value <= 0n)
      throw new RangeError('Transfer value must be positive')
    if (
      kind === 'legacy' &&
      this.config.transactionBuilder.supportsNativeConsolidation !== true
    )
      throw new Error('Builder does not support native consolidation')
    const accounts = await this.sources(lifetime)
    const fee = await this.config.provider.getFeeData()
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice
    if (maxFeePerGas == null) throw new Error('Native fee quote unavailable')
    const fees = {
      maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? maxFeePerGas,
    }
    if (fees.maxPriorityFeePerGas > maxFeePerGas)
      throw new Error('Invalid native fee quote')
    accounts.sort((a, b) =>
      a.spendableValue === b.spendableValue
        ? a.source.address.localeCompare(b.source.address)
        : a.spendableValue > b.spendableValue
        ? -1
        : 1,
    )
    for (const account of accounts) {
      if (account.spendableValue < params.value) continue
      const raw = await this.transaction(account, recipient, params.value, fees)
      const tx = Transaction.from(raw)
      const maximumFee = nativeMaximumFee(tx)
      if (
        this.config.transactionBuilder.feeAsset === 'transfer'
          ? BigInt(account.account.balanceWei) < tx.value ||
            account.spendableValue < params.value + maximumFee
          : BigInt(account.account.balanceWei) < tx.value + maximumFee
      )
        continue
      return this.journal(lifetime).prepare({
        kind,
        recipient,
        intendedValueWei: params.value.toString(),
        members: [
          {
            source: account.source,
            unsignedTransaction: raw,
            dependencies: [],
          },
        ],
      })
    }
    if (kind === 'native' || accounts.length < 2)
      throw new RangeError('Insufficient unreserved native funds')
    const leader = accounts[0]!
    const drain = await this.transaction(leader, recipient, params.value, fees)
    const drainTx = Transaction.from(drain)
    let funded = BigInt(leader.account.balanceWei)
    const members: EvmNativeMemberPlan[] = []
    for (const peer of accounts.slice(1)) {
      if (funded >= params.value + nativeMaximumFee(drainTx)) break
      const quote = Transaction.from(
        await this.transaction(peer, leader.source.address, 0n, fees),
      )
      const available =
        BigInt(peer.account.balanceWei) - nativeMaximumFee(quote)
      if (available <= 0n) continue
      const raw = await this.transaction(
        peer,
        leader.source.address,
        available,
        fees,
      )
      const tx = Transaction.from(raw)
      if (
        tx.to?.toLowerCase() !== leader.source.address ||
        tx.value !== available ||
        tx.data !== '0x' ||
        tx.value + nativeMaximumFee(tx) > BigInt(peer.account.balanceWei)
      )
        throw new Error('Unsupported native consolidation economics')
      members.push({
        source: peer.source,
        unsignedTransaction: raw,
        dependencies: [],
      })
      funded += available
      if (members.length >= 64)
        throw new Error('Native operation member capacity')
    }
    if (funded < params.value + nativeMaximumFee(drainTx))
      throw new RangeError('Insufficient unreserved native funds')
    if (
      drainTx.to?.toLowerCase() !== recipient ||
      drainTx.value !== params.value ||
      drainTx.data !== '0x'
    )
      throw new Error('Unsupported native drain economics')
    members.push({
      source: leader.source,
      unsignedTransaction: drain,
      dependencies: members.map((_, i) => i),
    })
    return this.journal(lifetime).prepare({
      kind,
      recipient,
      intendedValueWei: params.value.toString(),
      members,
    })
  }
  private async sign(
    row: EvmNativeOperation,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    if (this.config.inputAdmission) {
      if (!lifetime) throw new Error('Native signing lifetime unavailable')
      row = await this.config.inputAdmission.authorizeNativeSigning(
        lifetime,
        row.operationId,
      )
    }
    for (let i = 0; i < row.members.length; i++) {
      const member = this.config.journal.get(row.operationId).members[i]!
      if (!member.signed)
        await this.journal(lifetime).checkpointSigned(
          row.operationId,
          i,
          await this.config.sign(member.source, member.unsignedTransaction),
        )
    }
    return this.config.journal.get(row.operationId)
  }
  private transactionHandle(row: EvmNativeOperation): ChainTransaction {
    const hashes = row.members.map(m => m.signed!.transactionHash)
    return {
      txHash: hashes[hashes.length - 1]!,
      ...(hashes.length > 1 ? { relatedTxHashes: hashes.slice(0, -1) } : {}),
    }
  }
  private async execute(
    id: string,
    onSigned?: SendLegacyParams['onSigned'],
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const journal = this.journal(lifetime),
      { provider } = this.config
    let row = journal.get(id)
    if (row.cancelled) throw new Error('Native operation was cancelled')
    row = await this.sign(row, lifetime)
    await onSigned?.(this.transactionHandle(row))
    for (let i = 0; i < row.members.length; i++) {
      await this.observe(id, i, lifetime)
      row = journal.get(id)
      let member = row.members[i]!
      if (member.observation.state === 'included-revert')
        throw new EvmNativeOperationPendingError(
          row,
          new Error(
            'Original native member reverted; retained for disposition',
          ),
        )
      if (
        member.dependencies.some(
          d => row.members[d]!.observation.state !== 'included-success',
        )
      )
        throw new EvmNativeOperationPendingError(
          row,
          new Error('Original native prerequisites are pending'),
        )
      if (member.observation.state !== 'included-success') {
        await journal.markExposed(id, i)
        try {
          const response = await provider.broadcastTransaction(
            member.signed!.rawTransaction,
          )
          if (response.hash.toLowerCase() !== member.signed!.transactionHash)
            throw new Error('Unexpected native transaction hash')
        } catch (reason) {
          throw new EvmNativeOperationPendingError(journal.get(id), reason)
        }
        if (row.kind === 'native') return journal.get(id)
        await this.observe(id, i, lifetime)
        row = journal.get(id)
        member = row.members[i]!
        if (member.observation.state !== 'included-success')
          throw new EvmNativeOperationPendingError(
            row,
            new Error(
              'Original native member has not been observed successful',
            ),
          )
      }
    }
    return journal.get(id)
  }
  /**
   * The local pass: applies every included member of EVERY operation in the journal to this
   * device's own state, from one journal snapshot. It runs at the end of each native send and
   * resume, inside the wallet queue that call holds, so an operation whose inclusion was seen
   * only later (by a later send's planning) is applied by that later send.
   *
   * It makes no network request and asks for no signature. A member that is applied, has no pool
   * row, or can never apply costs one classification from the snapshot; only `needs-apply`
   * enters the admission, and a member (or a whole pass) that was refused is not tried again
   * until its remembered hold is dropped (`holds`). It never throws: nothing here may replace
   * the send's own outcome.
   */
  private async localPass(lifetime?: WalletOperationLifetime): Promise<void> {
    this.localPassIncomplete = true
    try {
      let incomplete = false
      const { classifyLocalMember: classify, applyLocalMember: apply } =
        this.config
      const rows = this.config.journal.list()
      // The journal state a hold was taken under: per source address, and for the whole journal.
      const byAddress = new Map<string, string>()
      let whole = ''
      for (const row of rows) {
        if (row.cancelled) continue
        row.members.forEach((member, i) => {
          const state = `${row.operationId}:${i}:${member.signed ? 1 : 0}:${
            member.observation.state
          };`
          whole += state
          byAddress.set(
            member.source.address,
            (byAddress.get(member.source.address) ?? '') + state,
          )
        })
      }
      const stillHeld = (hold: RememberedHold | undefined, basis: string) => {
        if (
          !hold ||
          hold.basis !== basis ||
          hold.skipped >= HELD_RETRY_PASSES
        )
          return false
        hold.skipped++
        return true
      }
      if (stillHeld(this.admissionHold, whole)) return
      this.admissionHold = undefined
      const holds = new Map<string, RememberedHold>()
      for (const row of rows) {
        if (row.cancelled) continue
        for (let i = 0; i < row.members.length; i++) {
          const member = row.members[i]!
          if (
            !member.signed ||
            member.observation.state !== 'included-success' ||
            member.syncApplied
          )
            continue
          const key = `${row.operationId}:${i}`
          const basis = byAddress.get(member.source.address)!
          let result: 'applied' | 'held' = 'held'
          const remembered = this.holds.get(key)
          if (this.admissionHold) {
            /* The projection is not ready: nothing more is classified or applied in this pass. */
            incomplete = true
          } else if (stillHeld(remembered, basis)) {
            holds.set(key, remembered!)
            incomplete = true
          } else
            try {
              // With no local callback there is nothing to record on, and so no local result:
              // held, so transport and `markSyncApplied` cannot proceed without one.
              const kind = classify
                ? classify(row, i, lifetime)
                : apply
                ? 'needs-apply'
                : 'held-terminal'
              if (kind === 'applied' || kind === 'no-pool-row')
                result = 'applied'
              else if (kind === 'needs-apply' && apply) {
                await apply(row.operationId, i, lifetime)
                result = 'applied'
              } else if (kind === 'not-eligible') {
                // The snapshot says this member is eligible, so the refusal is the admission's.
                this.admissionHold = {
                  reason: 'admission-not-ready',
                  basis: whole,
                  skipped: 0,
                }
                incomplete = true
              }
            } catch (error) {
              incomplete = true
              const reason = refusalReason(error)
              if (reason !== undefined)
                holds.set(key, { reason, basis, skipped: 0 })
              /* Otherwise held for this pass only: retried by the next one. */
            }
          this.localResults.set(key, result)
        }
      }
      this.holds = holds
      this.localPassIncomplete = incomplete
    } catch {
      /* An unreadable journal leaves every result as it was. */
    }
  }
  /**
   * Cancels an operation when the journal says no member of it was ever signed or exposed: a
   * plan that failed before its first signature. Such a plan can never land, yet while it stands
   * it reserves its pool accounts and freezes its source address, the main account included, for
   * every later native send. The journal's own rule decides (`cancelUnsigned` refuses anything
   * signed or exposed) and the row is retained, cancelled. `read` is the current row. Never throws.
   */
  private async cancelIfNeverSigned(
    read: () => EvmNativeOperation,
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    try {
      const row = read()
      if (row.cancelled || row.members.some(m => m.signed || m.exposed)) return
      await this.journal(lifetime).cancelUnsigned(row.operationId)
    } catch {
      /* Left as it was: the next wallet open cancels it. */
    }
  }
  /**
   * Wallet open: cancels every operation no member of which was ever signed or exposed (a crash
   * or failure between `prepare` and the first signature). Local only: it reads and writes the
   * journal, makes no network request, asks for no signature, and never throws.
   */
  cancelUnsignedOperations(lifetime?: WalletOperationLifetime): Promise<void> {
    return this.run(async () => {
      try {
        for (const row of this.config.journal.list())
          await this.cancelIfNeverSigned(() => row, lifetime)
      } catch {
        /* An unreadable journal cancels nothing. */
      }
    })
  }
  /**
   * Wallet open: the local pass, once, on the executor queue, for members whose successful
   * inclusion is ALREADY recorded in the journal. Journal only: it reaches the journal snapshot
   * and the two local callbacks (`classifyLocalMember`, `applyLocalMember`) and nothing else, so
   * it makes no network request, never observes a member, asks for no signature and transports
   * nothing. A member recorded pending, missing, unknown or reverted is left exactly as it is.
   * A refused member is remembered as held like any other pass's; a member whose apply failed is
   * left for the next pass. Never throws.
   */
  applyRecordedEvidence(lifetime?: WalletOperationLifetime): Promise<void> {
    return this.run(() => this.localPass(lifetime))
  }
  private now(): number {
    return (this.config.now ?? Date.now)()
  }
  /** The members worth looking up now, from the journal's memory alone: at most
   * `REOBSERVE_MAX_PROBES`, oldest first, starting after the member probed last. */
  private reobserveDue(now: number): ReobserveCandidate[] {
    const candidates: ReobserveCandidate[] = []
    for (const row of this.config.journal.list()) {
      if (row.cancelled) continue
      row.members.forEach((member, index) => {
        const state = member.observation.state
        if (
          member.signed &&
          member.exposed &&
          (state === 'unknown' || state === 'missing' || state === 'pending')
        )
          candidates.push({
            operationId: row.operationId,
            index,
            key: `${row.operationId}:${index}`,
          })
      })
    }
    const live = new Set(candidates.map(candidate => candidate.key))
    for (const key of [...this.reobserveBackoff.keys()])
      if (!live.has(key)) this.reobserveBackoff.delete(key)
    const after = (a: ReobserveCandidate, b: ReobserveCandidate) =>
      a.operationId === b.operationId
        ? a.index > b.index
        : a.operationId > b.operationId
    const eligible = candidates
      .filter(candidate => {
        const waited = this.reobserveBackoff.get(candidate.key)
        return (
          !waited ||
          now < waited.probedAt ||
          now - waited.probedAt >= waited.waitMs
        )
      })
      .sort((a, b) => (after(a, b) ? 1 : after(b, a) ? -1 : 0))
    const cursor = this.reobserveCursor
    const start = cursor
      ? Math.max(
          0,
          eligible.findIndex(candidate => after(candidate, cursor)),
        )
      : 0
    return [...eligible.slice(start), ...eligible.slice(0, start)].slice(
      0,
      REOBSERVE_MAX_PROBES,
    )
  }
  /** `work`, or `REOBSERVE_STOPPED` as soon as re-observation is stopped. `work` is left to
   * settle on its own; its rejection is always handled here. */
  private untilStopped<T>(
    work: Promise<T>,
  ): Promise<T | typeof REOBSERVE_STOPPED> {
    return new Promise((resolve, reject) => {
      const stop = () => resolve(REOBSERVE_STOPPED)
      if (this.reobserveStopped) stop()
      else this.reobserveStops.add(stop)
      work.then(
        value => {
          this.reobserveStops.delete(stop)
          resolve(value)
        },
        error => {
          this.reobserveStops.delete(stop)
          reject(error)
        },
      )
    })
  }
  /** The member, read from the journal now, if it is still one to look up: its operation not
   * cancelled, signed and exposed, recorded `unknown`, `missing` or `pending`. */
  private reobservable(candidate: ReobserveCandidate) {
    const row = this.config.journal.get(candidate.operationId)
    const member = row.members[candidate.index]
    const state = member?.observation.state
    return !row.cancelled &&
      member?.signed &&
      member.exposed &&
      (state === 'unknown' || state === 'missing' || state === 'pending')
      ? member
      : undefined
  }
  /** One pass over `due`: one receipt request per member, and `observe` only for a member whose
   * receipt exists. Runs outside the executor queue; `observe` records through the journal's own
   * short mutation. */
  private async reobservePass(
    due: readonly ReobserveCandidate[],
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    const { provider, journal } = this.config
    for (const candidate of due) {
      if (this.reobserveStopped) return
      // A send or an estimate may have observed it since the candidates were listed.
      const member = this.reobservable(candidate)
      if (!member?.signed) continue
      this.reobserveCursor = candidate
      let receipt: unknown = null
      try {
        receipt = await this.untilStopped(
          provider.getTransactionReceipt(member.signed.transactionHash),
        )
      } catch {
        /* A probe that failed learned nothing: nothing is written, and it waits like an empty one. */
      }
      if (receipt === REOBSERVE_STOPPED) return
      // The probe took time. If a send, a resume or a fee estimate recorded this member included
      // or reverted meanwhile (or it is otherwise no longer one to look up), that record stands:
      // an observation begun now could, on one failed read, write `unknown` over it. Read again
      // here, in the same step as the queue check below and the start of `observe`, and leave
      // it. It carries no wait: it is not a candidate any more.
      if (!this.reobservable(candidate)) {
        this.reobserveBackoff.delete(candidate.key)
        continue
      }
      // The journal keeps the observation that began last. A send or resume in the executor
      // queue observes for itself and decides on what it recorded, so no observation is begun
      // here while one is queued: this pass never discards theirs, and the member is looked up
      // again by the next pass. One that starts afterwards discards this one instead.
      if (receipt != null && this.queued > 0) continue
      if (receipt != null)
        try {
          if (
            (await this.untilStopped(
              this.observe(
                candidate.operationId,
                candidate.index,
                lifetime,
                () => !this.reobserveStopped,
              ),
            )) === REOBSERVE_STOPPED
          )
            return
        } catch {
          /* Nothing recorded: the member stays as it was. */
        }
      if (this.reobserveStopped) return
      const state = journal.get(candidate.operationId).members[candidate.index]!
        .observation.state
      if (state === 'included-success') this.localPassOwed = true
      if (state === 'included-success' || state === 'included-revert')
        this.reobserveBackoff.delete(candidate.key)
      else {
        const waited = this.reobserveBackoff.get(candidate.key)
        this.reobserveBackoff.set(candidate.key, {
          probedAt: this.now(),
          waitMs: waited
            ? Math.min(waited.waitMs * 2, REOBSERVE_MAX_BACKOFF_MS)
            : REOBSERVE_MIN_INTERVAL_MS,
        })
      }
    }
  }
  /**
   * Looks again for members that were broadcast and whose inclusion nothing has observed: on a
   * real network the observation made inside the send's own call usually reads pending, and no
   * other caller looks unless a later native send is made. Meant to be called from a host's
   * existing poll, as often as that poll ticks; the bounds are enforced here.
   *
   * Who is looked up: a member of a non-cancelled operation that is signed AND exposed and whose
   * recorded observation is `unknown`, `missing` or `pending`. Nobody else, ever: not an unsigned
   * or unexposed member, not a cancelled operation, not an included or reverted member.
   *
   * Bounds, all in process memory:
   * - the candidates are computed from the journal's memory first, and with none this makes NO
   *   request at all;
   * - one `getTransactionReceipt` per member. No receipt, or a failed request: nothing is
   *   written and nothing is downgraded. Only when a receipt exists does the existing `observe`
   *   run for that member (seven reads) and record what it verifies, and not while a send or
   *   resume is on the executor queue, whose own observation must stand;
   * - at most `REOBSERVE_MAX_PROBES` members per pass, oldest first, continuing after the member
   *   probed last so every candidate is reached;
   * - so the hard ceiling per wallet is 8 receipt lookups per 15 s (1,920 an hour) plus seven
   *   further reads for each lookup that finds a receipt: 64 requests per 15 s (15,360 an hour)
   *   if every lookup of every pass found one. A member is observed once it is verified, so in
   *   practice the seven reads are paid once per landed member. Zero when nothing is pending;
   * - at most one evaluation per `REOBSERVE_MIN_INTERVAL_MS`, measured from the end of the last
   *   pass, whatever the caller's tick rate; a call while a pass is in flight starts nothing;
   * - a member whose probe learned nothing waits `REOBSERVE_MIN_INTERVAL_MS`, doubling per such
   *   probe to `REOBSERVE_MAX_BACKOFF_MS`.
   *
   * Locks: the network reads run under the wallet lifetime only, outside the executor queue and
   * outside the wallet queue, so a slow node never delays a send. When a pass recorded a
   * successful inclusion, `applyRecorded` (composition: the local pass inside the wallet queue,
   * local only) is called once; if it is refused, or the local pass left an included member it
   * may still apply, it is owed and called again by a later evaluation (no request), and the
   * observation stays recorded for the next send or the next open as well.
   *
   * It never signs, broadcasts, resubmits, replaces or cancels, never marks a member dropped and
   * has no timeout: a member that never lands stays pending and reserved. It never rejects.
   */
  async reobservePending(applyRecorded?: () => Promise<void>): Promise<void> {
    try {
      if (this.reobserveStopped || this.reobserving) return
      const now = this.now()
      if (
        this.reobservedAt !== undefined &&
        now >= this.reobservedAt &&
        now - this.reobservedAt < REOBSERVE_MIN_INTERVAL_MS
      )
        return
      this.reobservedAt = now
      const due = this.reobserveDue(now)
      if (due.length) {
        const { runLifetime } = this.config
        this.reobserving = (async () => {
          try {
            await (runLifetime
              ? runLifetime(lifetime => this.reobservePass(due, lifetime))
              : this.reobservePass(due))
          } catch {
            /* A lifetime that ended or a journal that closed ends the pass. */
          } finally {
            this.reobservedAt = this.now()
            this.reobserving = undefined
          }
        })()
        await this.reobserving
      }
      if (
        !this.localPassOwed ||
        !applyRecorded ||
        this.applyingRecorded ||
        this.reobserveStopped
      )
        return
      this.applyingRecorded = true
      this.localPassOwed = false
      this.localPassIncomplete = false
      try {
        await applyRecorded()
        // The local pass never throws: it reports what it left. A member it held or failed on
        // is tried again by the next evaluation (under the pass's own hold memory), not only
        // by the next send or the next open.
        if (this.localPassIncomplete) this.localPassOwed = true
      } catch {
        this.localPassOwed = true
      } finally {
        this.applyingRecorded = false
      }
    } catch {
      /* Re-observation never fails its caller. */
    }
  }
  /** Wallet close: ends re-observation for good. A pass in flight stops waiting for the node at
   * once and records nothing more; resolves when it has returned. Never rejects. */
  stopReobservation(): Promise<void> {
    this.reobserveStopped = true
    for (const stop of [...this.reobserveStops]) stop()
    this.reobserveStops.clear()
    return this.reobserving ?? Promise.resolve()
  }
  /** Runs `body` on the executor queue, then in the same hold: if `body` threw, cancels the
   * operation it names when that operation never signed; then the local pass. Neither can change
   * what `body` returned or threw. */
  private runWithLocalPass<T>(
    lifetime: WalletOperationLifetime | undefined,
    body: (planned: (operationId: string) => void) => Promise<T>,
  ): Promise<T> {
    return this.run(async () => {
      let operationId: string | undefined
      let failed = true
      try {
        const result = await body(id => {
          operationId = id
        })
        failed = false
        return result
      } finally {
        if (failed && operationId !== undefined) {
          const id = operationId
          await this.cancelIfNeverSigned(
            () => this.config.journal.get(id),
            lifetime,
          )
        }
        await this.localPass(lifetime).catch(() => undefined)
      }
    })
  }
  /** Composition invokes this outside its financial queue; transport may itself need admission.
   * Transport only: a member is sent, and then marked sync-applied, only when this session's local
   * pass recorded it applied. */
  flushSync(operationId?: string): Promise<void> {
    const run = this.syncTail.then(() =>
      this.config.runLifetime
        ? this.config.runLifetime(lifetime =>
            this.applySync(operationId, lifetime),
          )
        : this.applySync(operationId),
    )
    this.syncTail = run.catch(() => undefined)
    return run
  }
  private async applySync(
    operationId?: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    const journal = this.journal(lifetime)
    if (!this.config.onSyncTransaction) return
    // The first operation, in journal order, with a member the local pass has not applied.
    let unapplied: string | undefined
    for (const row of journal
      .list()
      .filter(
        row => operationId === undefined || row.operationId === operationId,
      ))
      for (let i = 0; i < row.members.length; i++) {
        const member = row.members[i]!
        const id = row.operationId
        if (
          !row.cancelled &&
          member.signed &&
          member.observation.state === 'included-success' &&
          !member.syncApplied &&
          this.config.onSyncTransaction
        ) {
          if (this.localResults.get(`${id}:${i}`) !== 'applied') {
            unapplied ??= id
            continue
          }
          const tx = Transaction.from(member.signed!.rawTransaction)
          const observation = member.observation
          if (observation.state === 'included-success') {
            try {
              await this.config.onSyncTransaction({
                type: 'wallet-sync',
                direction: 'out',
                chainIdentifier: journal.binding.chainIdentifier,
                txHash: member.signed!.transactionHash,
                rawTx: member.signed!.rawTransaction,
                spentInputs: [
                  {
                    address: member.source.address,
                    nonce: tx.nonce,
                    valueWei: (
                      tx.value + BigInt(observation.feeWei)
                    ).toString(),
                  },
                ],
                createdOutputs: [
                  { address: tx.to!, valueWei: tx.value.toString() },
                ],
                timestamp: Date.now(),
              })
            } catch (reason) {
              throw new EvmNativeOperationPendingError(journal.get(id), reason)
            }
            await journal.markSyncApplied(id, i)
          }
        }
      }
    if (unapplied !== undefined)
      throw new EvmNativeOperationPendingError(
        journal.get(unapplied),
        new Error('Native member has no local spend record in this session'),
      )
  }
  resumeOperation(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const existing = this.active.get(operationId)
    if (existing) return existing
    const run = this.runWithLocalPass(lifetime, planned => {
      planned(operationId)
      return this.execute(operationId, undefined, lifetime)
    })
    this.active.set(operationId, run)
    void run
      .finally(() => {
        if (this.active.get(operationId) === run)
          this.active.delete(operationId)
      })
      .catch(() => undefined)
    return run
  }
  sendNative(
    params: SendLegacyParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<ChainTransaction> {
    params = { ...params, recipient: { ...params.recipient } }
    return this.runWithLocalPass(lifetime, async planned => {
      const row = await this.plan(params, 'native', lifetime)
      planned(row.operationId)
      return this.transactionHandle(
        await this.execute(row.operationId, params.onSigned, lifetime),
      )
    })
  }
  sendLegacy(
    params: SendLegacyParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<LegacySendResult> {
    params = { ...params, recipient: { ...params.recipient } }
    return this.runWithLocalPass(lifetime, async planned => {
      params.onProgress?.({ status: { stage: 'planning' } })
      const row = await this.plan(params, 'legacy', lifetime)
      planned(row.operationId)
      const completed = await this.execute(
        row.operationId,
        params.onSigned,
        lifetime,
      )
      const result = this.legacyResult(completed)
      params.onProgress?.({
        status: { stage: 'confirmed', txHash: result.txHash },
      })
      return result
    })
  }
  private legacyResult(row: EvmNativeOperation): LegacySendResult {
    if (
      row.kind !== 'legacy' ||
      row.members.some(m => m.observation.state !== 'included-success')
    )
      throw new EvmNativeOperationPendingError(
        row,
        new Error('Original legacy payment pending'),
      )
    return {
      txHash: row.members[row.members.length - 1]!.signed!.transactionHash,
      intermediateTxHashes: row.members
        .slice(0, -1)
        .map(m => m.signed!.transactionHash),
      totalValueSent: BigInt(row.intendedValueWei),
      totalFeePaid: row.members.reduce(
        (sum, m) =>
          sum + BigInt('feeWei' in m.observation ? m.observation.feeWei : '0'),
        0n,
      ),
    }
  }
  async resumeLegacySend(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<LegacySendResult> {
    return this.legacyResult(await this.resumeOperation(operationId, lifetime))
  }
  async estimateLegacyFee(
    _recipient: ChainAddress,
    value: bigint,
    lifetime?: WalletOperationLifetime,
  ): Promise<LegacyFeeEstimate> {
    if (this.config.inputAdmission && !lifetime) {
      if (!this.config.runLifetime)
        throw new Error('Native lifetime owner unavailable')
      return this.config.runLifetime(token =>
        this.estimateLegacyFee(_recipient, value, token),
      )
    }
    if (
      value <= 0n ||
      this.config.transactionBuilder.supportsNativeConsolidation !== true
    )
      throw new Error('Native consolidation unavailable')
    const accounts = await this.sources(lifetime)
    const fees = await this.config.provider.getFeeData()
    const price = fees.maxFeePerGas ?? fees.gasPrice
    if (price == null) throw new Error('Native fee quote unavailable')
    const fee = 21000n * price
    accounts.sort((a, b) => (a.spendableValue > b.spendableValue ? -1 : 1))
    let balance = 0n
    let count = 0
    for (const a of accounts) {
      balance += a.spendableValue
      count++
      if (balance >= value + BigInt(count) * fee) break
    }
    if (!count || count > 64 || balance < value + BigInt(count) * fee)
      throw new RangeError('Insufficient native funds')
    return {
      inputCount: count,
      deliveryFee: fee,
      consolidationFee: BigInt(count - 1) * fee,
      totalFee: BigInt(count) * fee,
    }
  }
}
