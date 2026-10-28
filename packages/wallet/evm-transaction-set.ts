import { computeAddress, getAddress, SigningKey, Transaction } from 'ethers'
import { createCooperativeBatchYielder, type CooperativeBatchYielder } from './chain/event-loop-yield'
import { computeGeometricRadixChangeSplits } from './evm-change-distribution'
import { EvmChangeBand, countPoolCoins } from './evm-coin-distribution'
import type {
  CoinPart,
  EvmListCoin,
  EvmCoinAccountProjection,
  TransactionSetSelection,
} from './evm-coin-list'
import type {
  EvmNativeMemberPlan,
  EvmNativeMember,
  EvmTransactionSetStage,
  EvmNativeOperation,
  EvmNativeObservation,
  EvmNativeAccountObservation,
} from './storage/evm-native-operation-journal'
import { EVM_TRANSACTION_SET_SOURCE_ORDER, EvmTransactionSetInsufficientFundsError, FundsInPendingSendError } from './evm-transaction-set-types'
import { EvmNativeJournalError, nativeMemberAbandoned, nativeMemberEnded, nativeMemberNeedsOwnMoveRecovery, nativeMemberSuperseded } from './storage/evm-native-operation-journal'
import { predecessorConsumedAt } from './evm-transaction-set-lifecycle'
import { resignedTransaction } from './chain/evm-refused-resign'
import { fundsSettleBlocks } from './chain/evm-spend-rule'
import { evmPaymentFloorWei } from './chain/payment-floor'
import type {
  ConstructEvmTransactionSetRequest,
  ConstructLegacySubAccountRequest,
  EvmTransactionSetPreparerOptions,
  EvmChangeDestination,
  EvmTransactionSetPolicy,
  PreparedEvmTransaction,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
export type {
  ConstructEvmTransactionSetRequest,
  ConstructLegacySubAccountRequest,
  EvmTransactionSetPreparerOptions,
  EvmTransactionSetPolicy,
  PreparedEvmTransaction,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'

const prefix = 'evm-transaction-set:'
const MAX_TRANSACTION_SET_MEMBERS = 64

/** Optional change uses only the slots left after recipient transfers and required reserves. */
function optionalChangeAllowance(allowance: number, memberBudget: number, payments: number, changes: number, reserve = 0): number {
  return Math.min(allowance, Math.max(0, memberBudget - payments - changes - reserve))
}
interface PaymentContext {
  destination: string
  gas: bigint
  feeIsExact: boolean
}
interface LocalMember {
  plan: EvmNativeMemberPlan
  raw: string
}

/** See `EvmTransactionSetPreparer.quoteTransactionSet`. All fees in wei. */
export interface EvmTransactionSetQuote {
  readonly amountWei: bigint
  /** Coins the transfer draws on. */
  readonly inputCount: number
  /** Moving several coins to one fresh account first (0 when one coin pays directly). */
  readonly consolidationFeeWei: bigint
  /** The transfer to the recipient. */
  readonly deliveryFeeWei: bigint
  /** Splitting what is left over into fresh change accounts. */
  readonly changeFeeWei: bigint
  /** Everything the transfer pays: the sum of the three. */
  readonly feeWei: bigint
}

/** The set would pay more than the fee it was authorized with. Nothing was signed or kept;
 * `feeWei` is what it would pay now. */
export class EvmTransactionSetFeeExceededError extends Error {
  constructor(readonly feeWei: bigint) {
    super('Transaction-set fee exceeds authorized bound')
    this.name = 'EvmTransactionSetFeeExceededError'
  }
}

export class EvmTransactionSetSourceHeldError extends Error {
  constructor() {
    super('Account is reserved by a shared EVM transaction set')
    this.name = 'EvmTransactionSetSourceHeldError'
  }
}

/** One family adapter: inventory owns reservations; the journal owns signed attempt bytes.
 * No provider is accepted here. Fee/gas observations and inclusion evidence arrive from outside. */
/** Whether `member` comes after a payment of its set on its own account (a higher nonce). */
function behindPayment(
  members: readonly Pick<EvmNativeOperation['members'][number], 'source' | 'unsignedTransaction' | 'transactionSet'>[],
  member: Pick<EvmNativeOperation['members'][number], 'source' | 'unsignedTransaction'>,
): boolean {
  const nonce = Transaction.from(member.unsignedTransaction).nonce
  return members.some(other =>
    other.transactionSet?.role === 'payment' &&
    other.source.address === member.source.address &&
    Transaction.from(other.unsignedTransaction).nonce < nonce)
}

/** A source counted as leaving a coin whatever it holds (a fan-in's merged coin, a change-only
 * input): the band never assumes it is spent out. */
const BIG_RESIDUAL = 2n ** 255n

export class EvmTransactionSetPreparer {
  private readonly recoverySpendRule: EvmTransactionSetPolicy['spendRule']
  constructor(private readonly options: EvmTransactionSetPreparerOptions) {
    const rule = options.recoverySpendRule
    if (
      rule &&
      (rule.belowWei < 0n ||
        !Number.isSafeInteger(rule.waitBlocks) ||
        rule.waitBlocks < 0)
    )
      throw new Error('Invalid static EVM recovery spend rule')
    this.recoverySpendRule =
      rule === undefined ? undefined : Object.freeze({ ...rule })
    this.restoreReservations()
  }

  restoreReservations(): void {
    for (const row of this.options.journal.list())
      if (row.kind === 'transaction-set') {
        if (row.cancelled) {
          const logicalId = row.preparationId!.slice(prefix.length)
          for (const member of row.members)
            if (member.transactionSet!.role !== 'payment')
              this.options.coins.reserveChangeTarget(logicalId, member.transactionSet!.changeIndex!, Transaction.from(member.unsignedTransaction).to!)
          this.options.coins.restoreTransactionSetCancellation(logicalId, this.cancellationSources(row))
        }
        else this.restoreRow(row)
      }
  }

  getOperation(operationId: string): EvmNativeOperation | undefined {
    return this.options.journal
      .list()
      .find(
        row =>
          row.kind === 'transaction-set' &&
          row.preparationId === prefix + operationId,
      )
  }

  /** Resolve the original signed graph in active storage or immutable completed history. */
  async readOperation(operationId: string): Promise<EvmNativeOperation | undefined> {
    return this.options.journal.refreshPreparation(prefix + operationId)
  }

  async readTransactionSet(operationId: string): Promise<PreparedEvmTransactionSet> {
    const row = await this.readOperation(operationId)
    if (!row || row.cancelled) throw new Error('Unknown transaction set')
    return this.result(row, null)
  }

  /** Complete graph snapshot for the wallet submission boundary; never signs or broadcasts. */
  getTransactionSet(operationId: string): PreparedEvmTransactionSet {
    const row = this.getOperation(operationId)
    if (!row || row.cancelled) throw new Error('Unknown active transaction set')
    return this.result(row, null)
  }

  async authorizeSubmission(operationId: string, expectedRawTransactions?: readonly string[]): Promise<void> {
    const row = await this.readOperation(operationId)
    if (!row || row.cancelled || row.members.some(member => !member.signed))
      throw new Error('Unknown transaction-set operation')
    if (expectedRawTransactions && JSON.stringify([...expectedRawTransactions].sort()) !==
        JSON.stringify(row.members.map(member => member.signed!.rawTransaction).sort()))
      throw new Error('Transaction-set signed bytes conflict with original operation')
    if (row.submissionAuthorized) return
    // A completed historical row must never acquire new submission authorization.
    if (!this.getOperation(operationId)) throw new Error('Completed transaction set is not authorized')
    await this.options.journal.authorizeTransactionSet(row.operationId, expectedRawTransactions)
  }

  transactionSetPolicy(): EvmTransactionSetPolicy {
    return this.options.policy()
  }

  /** Uses the same logical ID as construction. Authorization/exposure is never cancelled. */
  releaseUnexposed(operationId: string): Promise<boolean> {
    return this.releaseUnexposedWithin(operationId, false)
  }

  /** `releaseUnexposed`, where a set of that ID that was never written counts as released:
   * nothing of it exists to hold anything. The journal is read inside the set's own exclusive
   * section, so no construction of that ID lands between the read and the answer. */
  releaseUnexposedOrUnwritten(operationId: string): Promise<boolean> {
    return this.releaseUnexposedWithin(operationId, true)
  }

  private releaseUnexposedWithin(operationId: string, unwrittenIsReleased: boolean): Promise<boolean> {
    return this.options.coins.runTransactionSetExclusive(operationId, async () => {
      let row = await this.options.journal.refreshPreparation(prefix + operationId)
      if (!row) return unwrittenIsReleased
      if (row.submissionAuthorized || row.members.some(member => member.exposed || nativeMemberSuperseded(member) || !['unknown', 'missing'].includes(member.observation.state))) return false
      if (row.cancelled && !this.getOperation(operationId)) return true
      const originals = this.cancellationSources(row)
      if (!row.cancelled) row = await this.options.journal.discardUnexposed(row.operationId)
      this.options.coins.restoreTransactionSetCancellation(operationId, originals)
      await this.options.coins.checkpointTransactionSetCancellation(operationId, originals)
      await this.options.onCancellationCheckpoint?.(row)
      return true
    })
  }

  /** A set whose first relay handoff was refused before the relay stored or broadcast anything
   * (`discardRefusedBeforeBroadcast`): its coins are free again. False, and nothing changes,
   * when any of its own moves went to the node or the chain knows any member. */
  releaseRefusedBeforeBroadcast(operationId: string): Promise<boolean> {
    return this.options.coins.runTransactionSetExclusive(operationId, async () => {
      let row = await this.options.journal.refreshPreparation(prefix + operationId)
      if (!row) return false
      if (row.cancelled && !this.getOperation(operationId)) return true
      if (!row.cancelled && row.members.some(member =>
        (member.exposed && member.transactionSet?.role !== 'payment') ||
        nativeMemberSuperseded(member) ||
        !['unknown', 'missing'].includes(member.observation.state)))
        return false
      const originals = this.cancellationSources(row)
      if (!row.cancelled) row = await this.options.journal.discardRefusedBeforeBroadcast(row.operationId)
      this.options.coins.restoreTransactionSetCancellation(operationId, originals)
      await this.options.coins.checkpointTransactionSetCancellation(operationId, originals)
      await this.options.onCancellationCheckpoint?.(row)
      return true
    })
  }

  /** Authorized-mutation compaction only; opening remains read-only. A crash after the
   * cancellation row or projection write retries the same cleanup before retirement. */
  async recoverCancelledOperations(excludeOperationId?: string): Promise<void> {
    if (!this.options.onCancellationCheckpoint) return
    const cancelled = this.options.journal.list().filter(row => row.kind === 'transaction-set' && row.cancelled && row.preparationId !== prefix + excludeOperationId).slice(0, 100)
    for (const row of cancelled)
      await this.releaseUnexposed(row.preparationId!.slice(prefix.length))
  }

  private cancellationSources(row: EvmNativeOperation): EvmListCoin[] {
    const privateAccounts = new Set(row.members.filter(member => member.transactionSet?.role !== 'payment').map(member => Transaction.from(member.unsignedTransaction).to!.toLowerCase()))
    const first = new Set<string>(), originals: EvmListCoin[] = []
    for (const member of row.members) {
      const account = member.source.address
      if (first.has(account) || privateAccounts.has(account)) continue
      first.add(account)
      const source = this.options.coins.all().find(coin => coin.account === account)
      if (!source) continue // Already reconciled and pruned; never resurrect a prior nonce.
      originals.push({ ...source, nonce: Transaction.from(member.unsignedTransaction).nonce,
        valueWei: BigInt(member.transactionSet!.balanceBeforeWei), state: 'unspent' })
    }
    return originals
  }

  /** Active sets with superseded dependencies still to decide, or durable abandonment whose
   * inventory projection was interrupted. Logical IDs for the recovery pass; read only. */
  undecidedSupersededOperations(): string[] {
    return this.options.journal.list().flatMap(row =>
      row.kind === 'transaction-set' && !row.cancelled && row.preparationId?.startsWith(prefix) &&
      ((row.members.some(nativeMemberSuperseded) &&
        row.members.some(member =>
          member.observation.state !== 'included-success' &&
          member.observation.state !== 'included-revert' &&
          (!nativeMemberEnded(member) || nativeMemberNeedsOwnMoveRecovery(member)))) ||
        row.members.some(member => nativeMemberAbandoned(member) &&
          member.transactionSet?.inventoryApplied !== true))
        ? [row.preparationId.slice(prefix.length)]
        : [])
  }

  /** RPC-free admission view for account-based maintenance. Inventory owns provisional
   * construction/projection; the journal retains every pending signed nonce across reopen. */
  isSourceReserved(account: string): boolean {
    const key = account.toLowerCase()
    return this.options.coins.isAccountReserved(key) || this.options.journal.list().some(row =>
      row.kind === 'transaction-set' && !row.cancelled && row.members.some(member =>
        member.source.address === key &&
        member.observation.state !== 'included-success' &&
        member.observation.state !== 'included-revert' &&
        (!nativeMemberEnded(member) || nativeMemberNeedsOwnMoveRecovery(member)),
      ),
    )
  }

  private async archivedMemberComplete(operationId: string, memberIndex: number, allowAbandoned = true): Promise<boolean> {
    const row = await this.readOperation(operationId)
    if (!row || this.getOperation(operationId) || row.cancelled) return false
    const member = row.members[memberIndex]
    if (member && !allowAbandoned && nativeMemberAbandoned(member)) return false
    return !!member && member.transactionSet?.inventoryApplied === true &&
      (member.observation.state === 'included-success' ||
       member.observation.state === 'included-revert' || nativeMemberEnded(member))
  }

  async markExposed(operationId: string, memberIndex: number): Promise<void> {
    const row = this.getOperation(operationId)
    if (!row) {
      if (await this.archivedMemberComplete(operationId, memberIndex, false)) return
      throw new Error('Unknown transaction-set operation')
    }
    const member = row.members[memberIndex]
    if (!member) throw new Error('Unknown transaction-set member')
    const wait = member.transactionSet?.predecessorWaitBlocks
    if (wait !== undefined) {
      const consumed = predecessorConsumedAt(row.members[member.dependencies[0]!]!)
      if (
        consumed === undefined ||
        this.options.policy().head < consumed + wait
      )
        throw new Error(
          'Transaction-set predecessor quiet window is not satisfied',
        )
    }
    if (member.transactionSet?.fundingWaitBlocks !== undefined && member.dependencies.some(index => {
      const prior = row.members[index]!
      return prior.observation.state !== 'included-success' || this.options.policy().head < prior.observation.blockNumber + member.transactionSet!.fundingWaitBlocks!
    })) throw new Error('Transaction-set funding maturity is not satisfied')
    try {
      await this.options.journal.markExposed(row.operationId, memberIndex)
    } catch (error) {
      if (error instanceof EvmNativeJournalError && ['invalid', 'conflict'].includes(error.code) && await this.archivedMemberComplete(operationId, memberIndex, false)) return
      throw error
    }
  }

  async recordObservation(
    operationId: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    expectedMember?: EvmNativeMember,
  ): Promise<boolean> {
    const row = this.getOperation(operationId)
    const member = row?.members[memberIndex]
    if (!member) {
      if (await this.archivedMemberComplete(operationId, memberIndex)) return false
      throw new Error('Unknown transaction-set member')
    }
    const frozenObservation = { ...observation }
    const frozenAccount = account === null ? null : { ...account }
    const frozenExpected = expectedMember === undefined ? undefined : structuredClone(expectedMember)
    try {
      const recorded = await this.options.coins.projectTransactionSetAccount(
        member.source.address,
        `${row!.operationId}:${memberIndex}`,
        writer =>
          this.applyObservation(
            operationId,
            memberIndex,
            frozenObservation,
            frozenAccount,
            writer,
            frozenExpected,
          ),
      )
      if (!recorded) return false
      const current = this.getOperation(operationId)
      if (!current || current.members[memberIndex]!.transactionSet!.inventoryApplied) return true
      // Shared sync can be waiting to write this source. Never join its RPC/mutation queue
      // while holding the source account mutation; its local projection remains incomplete.
      const target = this.mergeTargetToObserve(current)
      if (!target) return true
      if (!this.options.observeMergeTarget)
        throw new Error('Merge target observation capability required')
      await this.options.observeMergeTarget(target)
      await this.options.coins.projectTransactionSetAccount(
        member.source.address,
        `${row!.operationId}:${memberIndex}`,
        async () => {
          const latest = this.getOperation(operationId)
          const projected = latest?.members[memberIndex]
          if (!projected || projected.transactionSet!.inventoryApplied) return true
          // A newer observation may have projected this source while target RPC was pending.
          // Only the exact evidence applied by this call may complete its durable checkpoint.
          if (JSON.stringify(projected.observation) !== JSON.stringify(frozenObservation) ||
              JSON.stringify(projected.account) !== JSON.stringify(frozenAccount)) return false
          const tx = Transaction.from(projected.unsignedTransaction)
          if (frozenAccount && frozenAccount.nonce > tx.nonce &&
              (frozenObservation.state === 'included-success' ||
               frozenObservation.state === 'included-revert' || nativeMemberSuperseded(projected))) {
            await this.options.journal.markTransactionSetInventoryApplied(latest!.operationId, memberIndex)
            this.options.coins.settleTransactionSetKeyReference(member.source.address, tx.nonce)
            this.options.coins.completeTransactionSetProjection(member.source.address, `${row!.operationId}:${memberIndex}`)
          }
          return true
        },
      )
      return true
    } catch (error) {
      if (error instanceof EvmNativeJournalError && ['invalid', 'conflict'].includes(error.code) && await this.archivedMemberComplete(operationId, memberIndex)) return false
      throw error
    }
  }

  /**
   * Once every member of `address` in `row` is decided (landed, superseded or abandoned) and at
   * least one was abandoned: the coins this operation holds of that account from the first
   * abandoned nonce on leave the list, and what `account` (a chain read) shows the account
   * holding is listed at the chain's nonce, as for any account the chain moved. Nothing is listed
   * when a later coin of the account belongs to something else, or the account holds nothing.
   */
  private async relistPastAbandoned(
    row: EvmNativeOperation,
    holder: string,
    address: string,
    account: EvmNativeAccountObservation,
    source: EvmListCoin,
    writer: EvmCoinAccountProjection,
  ): Promise<void> {
    const { coins } = this.options
    const members = row.members.filter(member => member.source.address === address)
    const abandoned = members.filter(member => nativeMemberAbandoned(member) && !nativeMemberNeedsOwnMoveRecovery(member))
    if (
      abandoned.length === 0 ||
      !members.every(member =>
        member.observation.state === 'included-success' ||
        member.observation.state === 'included-revert' ||
        (nativeMemberEnded(member) && !nativeMemberNeedsOwnMoveRecovery(member)))
    )
      return
    const from = Math.min(...abandoned.map(member => Transaction.from(member.unsignedTransaction).nonce))
    for (const coin of coins.all())
      if (coin.account === address && coin.nonce >= from && coin.holder === holder && coin.state !== 'spent')
        await writer.recordGone(coin)
    if (account.nonce < from || coins.all().some(coin => coin.account === address && coin.nonce > account.nonce))
      return
    const existing = coins.get(address, account.nonce)
    if ((existing && existing.state !== 'unspent') || BigInt(account.balanceWei) === 0n) return
    const rule = this.recoverySpendRule
    await writer.put({
      account: address,
      nonce: account.nonce,
      lastSpentInBlock: existing?.lastSpentInBlock ?? account.blockNumber,
      privateKey: source.privateKey,
      valueWei: BigInt(account.balanceWei),
      origin: source.origin,
      listedInBlock: account.blockNumber,
      ...(source.changeIndex === undefined ? {} : { changeIndex: source.changeIndex }),
      ...(rule && BigInt(account.balanceWei) < rule.belowWei
        ? { spendableFromBlock: account.blockNumber + rule.waitBlocks }
        : {}),
    })
  }

  private async applyObservation(
    operationId: string,
    memberIndex: number,
    observation: EvmNativeObservation,
    account: EvmNativeAccountObservation | null,
    writer: EvmCoinAccountProjection,
    expectedMember?: EvmNativeMember,
  ): Promise<boolean> {
    const { journal, coins } = this.options
    const row = this.getOperation(operationId)
    if (!row) {
      if (await this.archivedMemberComplete(operationId, memberIndex)) return false
      throw new Error('Unknown transaction-set operation')
    }
    const recoveringOwnMove = nativeMemberNeedsOwnMoveRecovery(row.members[memberIndex]!)
    const restoringHold = recoveringOwnMove && observation.state !== 'included-success' &&
      observation.state !== 'included-revert' && account !== null &&
      account.nonce <= Transaction.from(row.members[memberIndex]!.unsignedTransaction).nonce
    if (restoringHold && coins.all().some(coin =>
        coin.account === row.members[memberIndex]!.source.address && coin.holder &&
        coin.holder !== operationId && coin.state !== 'spent'))
      throw new Error('Exposed own move conflicts with another operation reservation')
    const capture = await journal.beginCapture(row.operationId, memberIndex)
    const recorded = await journal.recordObservation(
      capture,
      observation,
      account,
      undefined,
      expectedMember,
    )
    if (!recorded) return false
    const current = journal.get(row.operationId),
      member = current.members[memberIndex]!
    const tx = Transaction.from(member.unsignedTransaction),
      meta = member.transactionSet!
    if (restoringHold && observation.state !== 'abandoned') {
      const source = this.sourceOf(current, member)
      if (!source) throw new Error('Transaction-set source key restoration required')
      coins.requireTransactionSetProjection(member.source.address, `${row.operationId}:${memberIndex}`)
      coins.restoreTransactionSetCoin(operationId, {
        account: member.source.address, nonce: tx.nonce, privateKey: source.privateKey,
        origin: source.origin, valueWei: BigInt(meta.balanceBeforeWei), state: 'pending_receipt',
        spendingTx: member.signed!.rawTransaction,
        ...(source.changeIndex === undefined ? {} : { changeIndex: source.changeIndex }),
      })
      await coins.checkpointTransactionSetReservations(operationId)
      coins.completeTransactionSetProjection(member.source.address, `${row.operationId}:${memberIndex}`)
    }

    if (meta.inventoryApplied === true) {
      coins.completeTransactionSetProjection(
        member.source.address,
        `${row.operationId}:${memberIndex}`,
      )
      return true
    }
    if (
      observation.state === 'included-success' ||
      observation.state === 'included-revert' ||
      (observation.state === 'missing' &&
        account !== null &&
        account.nonce > tx.nonce)
    )
      coins.requireTransactionSetProjection(
        member.source.address,
        `${row.operationId}:${memberIndex}`,
      )
    const source = coins
      .all()
      .find(coin => coin.account === member.source.address)
    if (!source)
      throw new Error('Transaction-set source key restoration required')
    const superseded =
      observation.state === 'missing' &&
      account !== null &&
      account.nonce > tx.nonce
    // Given up on chain evidence (`evm-transaction-set-taken.ts`): its coin leaves the list once
    // every member of its account is decided, and the account is listed at what the chain shows.
    if (observation.state === 'abandoned') {
      if (account === null) throw new Error('An abandoned member needs its account observation')
      coins.requireTransactionSetProjection(member.source.address, `${row.operationId}:${memberIndex}`)
      await this.relistPastAbandoned(current, operationId, member.source.address, account, source, writer)
      await journal.markTransactionSetInventoryApplied(row.operationId, memberIndex)
      coins.settleTransactionSetKeyReference(member.source.address, tx.nonce)
      coins.completeTransactionSetProjection(member.source.address, `${row.operationId}:${memberIndex}`)
      return true
    }
    if (
      observation.state === 'included-success' ||
      observation.state === 'included-revert' ||
      superseded
    ) {
      const block =
        'blockNumber' in observation
          ? observation.blockNumber
          : account!.blockNumber
      await writer.recordMined(
        { account: member.source.address, nonce: tx.nonce },
        { block },
      )
      if (observation.state === 'included-success' && meta.role === 'change') {
        const target = this.options.deriveChange(meta.changeIndex!)
        if (
          target.account.toLowerCase() !== tx.to!.toLowerCase() ||
          computeAddress(target.privateKey).toLowerCase() !==
            target.account.toLowerCase()
        )
          throw new Error('Change derivation does not match signed transaction')
        if (!coins.latestOf(target.account)) {
          const rule = this.recoverySpendRule
          await coins.put({
            account: target.account,
            nonce: 0,
            privateKey: target.privateKey,
            valueWei: tx.value,
            origin: 'change',
            changeIndex: meta.changeIndex,
            listedInBlock: observation.blockNumber,
            // Fresh money, whatever its amount: the node admits a transfer out of it only
            // `fundsSettleBlocks` after the block that brought it (Monad: 4).
            ...(rule && fundsSettleBlocks(rule.waitBlocks) > 0
              ? {
                  spendableFromBlock:
                    observation.blockNumber + fundsSettleBlocks(rule.waitBlocks),
                  fundsVisibleFromBlock:
                    observation.blockNumber + fundsSettleBlocks(rule.waitBlocks),
                }
              : {}),
          })
        }
      }
      // A payment to one of the wallet's own accounts (a sweep or a merge into a fresh account)
      // is money the list learns from a chain read of that account, like any deposit.
      if (observation.state === 'included-success' && meta.role === 'payment')
        this.options.onPaymentIncluded?.(tx.to!.toLowerCase())
      const ofSource = current.members.filter(
        candidate => candidate.source.address === member.source.address,
      )
      const lastOfSource = ofSource.at(-1)!
      const finalNonce = Transaction.from(
        lastOfSource.unsignedTransaction,
      ).nonce
      if (account && ofSource.some(nativeMemberAbandoned))
        await this.relistPastAbandoned(current, operationId, member.source.address, account, source, writer)
      else if (
        account &&
        account.nonce > finalNonce &&
        (coins.latestOf(source.account)?.nonce ?? 0) <= account.nonce
      ) {
        const existing = coins.get(member.source.address, account.nonce)
        if (!existing || existing.state === 'unspent') {
          const rule = this.recoverySpendRule
          // More than this set left the account holding is money that arrived since: fresh, by
          // the block this read was at, whatever the reserve. `balanceAfterWei` counts each fee
          // at its ceiling, so a fee that came in under it also reads as fresh: a wait, never an
          // early spend.
          const expectedAfter = lastOfSource.transactionSet?.balanceAfterWei
          const fresh =
            rule !== undefined &&
            fundsSettleBlocks(rule.waitBlocks) > 0 &&
            (expectedAfter === undefined ||
              BigInt(account.balanceWei) > BigInt(expectedAfter))
              ? account.blockNumber + fundsSettleBlocks(rule.waitBlocks)
              : undefined
          const quiet =
            rule && BigInt(account.balanceWei) < rule.belowWei
              ? account.blockNumber + rule.waitBlocks
              : undefined
          await writer.put({
            account: source.account,
            nonce: account.nonce,
            lastSpentInBlock: existing?.lastSpentInBlock ?? account.blockNumber,
            privateKey: source.privateKey,
            valueWei: BigInt(account.balanceWei),
            origin: source.origin,
            listedInBlock: account.blockNumber,
            ...(source.changeIndex === undefined
              ? {}
              : { changeIndex: source.changeIndex }),
            ...(fresh === undefined && quiet === undefined
              ? {}
              : { spendableFromBlock: Math.max(fresh ?? 0, quiet ?? 0) }),
            ...(fresh === undefined && quiet === undefined
              ? {}
              : { fundsVisibleFromBlock: fresh ?? account.blockNumber }),
          })
        }
      }
      // Only a completed merge needs an out-of-lock target read before the checkpoint.
      if (account && account.nonce > tx.nonce && !this.mergeTargetToObserve(current)) {
        await journal.markTransactionSetInventoryApplied(row.operationId, memberIndex)
        coins.settleTransactionSetKeyReference(member.source.address, tx.nonce)
        coins.completeTransactionSetProjection(member.source.address, `${row.operationId}:${memberIndex}`)
      }
    }
    return true
  }

  /** Validate the target that needs observation, without any RPC or shared sync wait. */
  private mergeTargetToObserve(row: EvmNativeOperation): EvmChangeDestination | undefined {
    const target = this.options.mergeTarget?.(row)
    if (!target) return
    const settled = (member: EvmNativeOperation['members'][number]) =>
      member.observation.state === 'included-success' ||
      member.observation.state === 'included-revert' ||
      nativeMemberSuperseded(member)
    if (!row.members.every(settled)) return
    const landed = row.members.filter(
      member => member.observation.state === 'included-success' && member.transactionSet?.role === 'payment',
    )
    if (landed.length === 0) return
    const account = target.account.toLowerCase()
    if (
      computeAddress(target.privateKey).toLowerCase() !== account ||
      landed.some(member => Transaction.from(member.unsignedTransaction).to?.toLowerCase() !== account)
    )
      throw new Error('Merge target derivation does not match signed transaction')
    return target
  }

  constructTransactionSet(request: ConstructEvmTransactionSetRequest): Promise<PreparedEvmTransactionSet> {
    return this.buildOnce(request)
  }

  appendTransactionSet(request: ConstructEvmTransactionSetRequest & { stageId: string }): Promise<PreparedEvmTransactionSet> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.stageId)) return Promise.reject(new Error('Invalid transaction-set stage ID'))
    return this.buildOnce(request, request.stageId)
  }

  constructLegacyTransactionSet(request: ConstructEvmTransactionSetRequest): Promise<PreparedEvmTransactionSet> {
    return this.buildOnce(request, undefined, true)
  }

  /** A dApp/legacy subaccount spends only its own current coin. The signed member uses the
   * existing transaction-set journal and submission path, with no separate nonce or retry log. */
  constructLegacySubAccountTransaction(request: ConstructLegacySubAccountRequest): Promise<PreparedEvmTransactionSet> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId))
      return Promise.reject(new Error('Invalid legacy subaccount operation ID'))
    return this.options.coins.constructTransactionSetOnce(request.operationId, async () => {
      const { coins, journal } = this.options
      const sourceAddress = getAddress(request.sourceAddress).toLowerCase()
      const destination = getAddress(request.destination).toLowerCase()
      const data = (request.calldata ?? '0x').toLowerCase()
      if (!/^0x(?:[0-9a-f]{2})*$/.test(data) || request.valueWei < 0n ||
          (request.valueWei === 0n && data === '0x'))
        throw new Error('Invalid legacy subaccount transaction')
      const prior = await journal.refreshPreparation(prefix + request.operationId)
      if (prior) {
        this.validateLegacySubAccountReplay(request, prior, sourceAddress, destination, data)
        if (this.getOperation(request.operationId)) this.restoreRow(prior)
        return this.result(prior, null)
      }
      await this.recoverCancelledOperations(request.operationId)
      const policy = this.options.policy()
      const gasLimit = request.gasLimit ?? policy.paymentGasLimit(data, destination)
      this.validatePolicy(policy, gasLimit, data)
      const type = request.type ?? (request.maxFeePerGasWei !== undefined ||
        request.maxPriorityFeePerGasWei !== undefined ? 2 : 0)
      if (type === 0 && (request.maxFeePerGasWei !== undefined || request.maxPriorityFeePerGasWei !== undefined))
        throw new Error('Legacy gas price conflicts with EIP-1559 fees')
      if (type === 2 && request.gasPriceWei !== undefined)
        throw new Error('EIP-1559 fees conflict with legacy gas price')
      const gasPrice = request.gasPriceWei ?? policy.gasPriceWei
      const maxFeePerGas = request.maxFeePerGasWei ?? policy.gasPriceWei
      const priorityFee = request.maxPriorityFeePerGasWei ?? maxFeePerGas
      const feeCap = type === 2 ? maxFeePerGas : gasPrice
      if (gasLimit <= 0n || feeCap <= 0n || priorityFee < 0n || priorityFee > maxFeePerGas)
        throw new Error('Invalid legacy subaccount fee')
      const maximumFee = gasLimit * feeCap
      if (request.maxFeeWei !== undefined && maximumFee > request.maxFeeWei)
        throw new Error('Legacy subaccount fee exceeds authorized bound')
      const beforeSelection = coins.all()
      const selected = coins.reserveTransactionSetSources({
        holder: request.operationId,
        amountWei: request.valueWei,
        feeWei: maximumFee,
        head: policy.head,
        sourceOrder: ['legacy-subaccount'],
        maxCoins: 1,
        canSelect: coin => coin.account === sourceAddress && journal.canSelect(coin.account, coin.nonce) &&
          (this.options.canSelectCoin?.(coin) ?? true) && this.dependencyReady(coin, policy),
      })
      if (!selected || selected.length !== 1)
        throw new EvmTransactionSetInsufficientFundsError()
      const source = selected[0]!.coin
      try {
        if (request.nonce !== undefined && request.nonce !== source.nonce)
          throw new Error('Requested nonce differs from the wallet subaccount nonce')
        const tx = Transaction.from({
          type,
          chainId: BigInt(journal.binding.nativeChainId),
          nonce: source.nonce,
          to: destination,
          value: request.valueWei,
          data,
          gasLimit,
          ...(type === 2
            ? { maxFeePerGas, maxPriorityFeePerGas: priorityFee }
            : { gasPrice }),
        })
        const member: EvmNativeMemberPlan = {
          source: { kind: 'coin', address: source.account },
          unsignedTransaction: tx.unsignedSerialized,
          dependencies: [],
          transactionSet: {
            role: 'payment', logicalIndex: 0,
            intendedValueWei: request.valueWei.toString(),
            balanceBeforeWei: source.valueWei.toString(),
            balanceAfterWei: (source.valueWei - request.valueWei - maximumFee).toString(),
            refundPending: true,
          },
        }
        tx.signature = new SigningKey(source.privateKey).sign(tx.unsignedHash)
        const stage: EvmTransactionSetStage = {
          startIndex: 0, memberCount: 1, intendedValueWei: request.valueWei.toString(),
          calldata: data, destinations: [destination], legacy: true,
          ...(request.maxFeeWei === undefined ? {} : { maxFeeWei: request.maxFeeWei.toString() }),
        }
        const row = await journal.prepare({
          kind: 'transaction-set', preparationId: prefix + request.operationId,
          recipient: destination, intendedValueWei: request.valueWei.toString(),
          transactionSetStages: [stage], members: [member],
        }, [tx.serialized])
        this.restoreRow(row)
        await coins.checkpointTransactionSetReservations(request.operationId)
        return this.result(row, null)
      } catch (error) {
        const retained = await journal.refreshPreparation(prefix + request.operationId).catch(() => undefined)
        if (retained) this.restoreRow(retained)
        else coins.abandonTransactionSetSources(request.operationId, [source], beforeSelection)
        throw error
      }
    }).then(async result => {
      const row = await this.readOperation(request.operationId)
      if (!row) throw new Error('Missing durable legacy subaccount operation')
      this.validateLegacySubAccountReplay(request, row,
        getAddress(request.sourceAddress).toLowerCase(),
        getAddress(request.destination).toLowerCase(),
        (request.calldata ?? '0x').toLowerCase())
      return result
    })
  }

  private validateLegacySubAccountReplay(request: ConstructLegacySubAccountRequest,
    row: EvmNativeOperation, source: string, destination: string, data: string): void {
    const member = row.members[0]
    if (row.cancelled || row.kind !== 'transaction-set' || row.members.length !== 1 ||
        member?.transactionSet?.role !== 'payment' || member.source.address !== source ||
        !member.signed || !row.transactionSetStages?.[0]?.legacy ||
        row.intendedValueWei !== request.valueWei.toString())
      throw new Error('Legacy subaccount operation ID conflicts with original intent')
    const tx = Transaction.from(member.unsignedTransaction)
    if (tx.to?.toLowerCase() !== destination || tx.data !== data ||
        (request.nonce !== undefined && tx.nonce !== request.nonce) ||
        (request.gasLimit !== undefined && tx.gasLimit !== request.gasLimit) ||
        (request.type !== undefined && tx.type !== request.type) ||
        (request.gasPriceWei !== undefined && tx.gasPrice !== request.gasPriceWei) ||
        (request.maxFeePerGasWei !== undefined && tx.maxFeePerGas !== request.maxFeePerGasWei) ||
        (request.maxPriorityFeePerGasWei !== undefined && tx.maxPriorityFeePerGas !== request.maxPriorityFeePerGasWei) ||
        (request.maxFeeWei !== undefined && BigInt(row.maximumFeeWei) > request.maxFeeWei))
      throw new Error('Legacy subaccount operation ID conflicts with original intent')
  }

  private buildOnce(request: ConstructEvmTransactionSetRequest, stageId?: string, legacy = false): Promise<PreparedEvmTransactionSet> {
    const suppliedKdf = request.kdf, destinations = new Map<number, string>()
    request = { ...request, kdf: index => {
      const known = destinations.get(index)
      if (known !== undefined) return known
      const destination = suppliedKdf(index)
      destinations.set(index, destination)
      return destination
    } }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)) return Promise.reject(new Error('Invalid transaction-set operation ID'))
    return this.options.coins.constructTransactionSetOnce(request.operationId,
      () => this.construct(request, stageId, legacy), stageId).then(async result => {
        const row = await this.readOperation(request.operationId)
        if (!row) throw new Error('Missing durable transaction set')
        this.validateReplay(request, row, stageId, legacy)
        return result
      })
  }

  private validateReplay(request: ConstructEvmTransactionSetRequest, row: EvmNativeOperation, stageId?: string, legacy = false): void {
    const stage = row.transactionSetStages?.find(item => item.stageId === stageId)
    const members = row.members.filter(member => member.transactionSet?.stageId === stageId)
    const payments = members.filter(member => member.transactionSet!.role === 'payment')
    if (row.cancelled || !payments.length ||
        (stage?.intendedValueWei ?? row.intendedValueWei) !== request.amountWei.toString() ||
        (stage?.minimumPaymentWei ?? '0') !== (request.minimumPaymentWei ?? 0n).toString() ||
        (stage?.reserveForContinuationWei ?? '0') !== (request.reserveForContinuationWei ?? 0n).toString() ||
        (stage !== undefined && Boolean(stage.legacy) !== legacy) ||
        (request.maxPaymentParts !== undefined && payments.length > request.maxPaymentParts) ||
        payments.some(member => {
          const tx = Transaction.from(member.unsignedTransaction)
          return tx.data !== (request.calldata ?? '0x').toLowerCase() ||
            tx.to!.toLowerCase() !== getAddress(request.kdf(member.transactionSet!.logicalIndex)).toLowerCase()
        }) || (request.maxFeeWei !== undefined && BigInt(row.maximumFeeWei) > request.maxFeeWei))
      throw new Error('Transaction-set operation ID conflicts with original intent')
  }

  /** The set's own change a later stage may be paid from. A move that comes after a payment of
   * the set on the same account is left out: a message's payments reach the chain only after
   * the relay stores it, and the relay stores it only once a stage's funding is on the chain,
   * so funding behind a payment could never land first. */
  private privateOutputs(row: EvmNativeOperation): EvmListCoin[] {
    const sources = new Set(row.members.map(member => member.source.address))
    return row.members.flatMap(member => {
      const meta = member.transactionSet!, tx = Transaction.from(member.unsignedTransaction)
      if (meta.role !== 'change' || sources.has(tx.to!.toLowerCase())) return []
      if (behindPayment(row.members, member)) return []
      const key = this.options.deriveChange(meta.changeIndex!)
      if (key.account.toLowerCase() !== tx.to!.toLowerCase()) throw new Error('Private change ownership mismatch')
      return [{ account: key.account.toLowerCase(), privateKey: key.privateKey, origin: 'change' as const,
        changeIndex: meta.changeIndex!, nonce: 0, valueWei: tx.value, state: 'unspent' as const,
        holder: row.preparationId!.slice(prefix.length), after: { account: member.source.address, nonce: tx.nonce } }]
    })
  }

  private async construct(request: ConstructEvmTransactionSetRequest, stageId?: string, legacy = false): Promise<PreparedEvmTransactionSet> {
    const { journal, coins } = this.options
    const existing = await journal.refreshPreparation(prefix + request.operationId)
    if (existing && (stageId === undefined || existing.transactionSetStages?.some(stage => stage.stageId === stageId))) {
      this.validateReplay(request, existing, stageId, legacy)
      if (existing.members.some(member => !member.signed)) throw new Error('Incomplete transaction-set journal record')
      // History is evidence of the original operation, never a construction inventory.
      if (this.getOperation(request.operationId)) this.restoreRow(existing)
      return this.result(existing, stageId)
    }
    if (stageId !== undefined && (!existing || !existing.transactionSetStages || existing.cancelled || existing.submissionAuthorized || existing.members.some(member => member.exposed || nativeMemberSuperseded(member) || !['unknown', 'missing'].includes(member.observation.state))))
      throw new Error('Cannot append to an exposed or unavailable operation')
    const data = request.calldata ?? '0x', reserve = request.reserveForContinuationWei ?? 0n
    const minimum = request.minimumPaymentWei ?? 0n
    this.validateRequest(request)
    // This operation has been proved non-cancelled before taking any other cancelled
    // operation's queue, preserving append/release ordering without cross-queue cycles.
    await this.recoverCancelledOperations(request.operationId)
    const admittedInput = await journal.captureInputSelection?.()
    const policy = this.options.policy()
    const { context, eligible, capacityWei, selection } =
      this.selectionRules(request, policy, legacy, existing, admittedInput)
    const select = (fanIn: boolean, continuation?: { deficit: bigint; maxCoins: number }, oneSource = false) =>
      coins.reserveTransactionSetSources(selection(fanIn, continuation, oneSource))
    // The fee the user authorized bounds the whole operation, every stage included. Payments
    // are what the authorization is for; fresh change is optional. Change outputs are only
    // planned while their fees fit under what the payments leave of the bound, and a residual
    // that does not get them stays with its sender on the account's next nonce.
    const bound = [request.maxFeeWei, ...(existing?.transactionSetStages ?? []).map(stage =>
      stage.maxFeeWei === undefined ? undefined : BigInt(stage.maxFeeWei))]
      .reduce<bigint | undefined>((least, value) =>
        value === undefined || (least !== undefined && least <= value) ? least : value, undefined)
    const changeFee = policy.changeGasLimit * policy.gasPriceWei
    // A one-transfer continuation: the reserve is kept as one fresh account of exactly
    // `reserve` (its own transfer, `changeFee`), and the bound holds the continuation's fee.
    // Neither is ever spent on change.
    const carve = this.continuationCarve(request)
    const heldForContinuation = carve ? carve.feeWei + changeFee : 0n
    const memberFee = (unsigned: string) => {
      const tx = Transaction.from(unsigned)
      return tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!)
    }
    const committed = (existing?.members ?? []).reduce((sum, member) => sum + memberFee(member.unsignedTransaction), 0n)
    // Every stage signs at least its first payment. When that alone does not fit under what the
    // bound leaves, no coins could make the stage fit: it is refused for the fee before any coin
    // is chosen, whatever the wallet holds (a stamp whose reviewed fee no longer covers its
    // transfer is a fee to review again, not missing funds).
    if (bound !== undefined && committed + context(0).gas * policy.gasPriceWei + heldForContinuation > bound)
      throw new EvmTransactionSetFeeExceededError(committed + context(0).gas * policy.gasPriceWei + heldForContinuation)
    const beforeSelection = coins.all()
    // The continuation an earlier stage kept a reserve for pays from one source when one covers
    // it: the transfer it was reserved and bounded for, not one more for each smaller output.
    const reservedFor = stageId !== undefined &&
      existing?.transactionSetStages?.some(stage => stage.reserveForContinuationWei !== undefined) === true
    let parts = (reservedFor ? select(false, undefined, true) : undefined) ?? select(false), fanIn = false
    if (!parts && legacy) { parts = select(true); fanIn = true }
    if (!parts) {
      this.options.assertFundingObserved?.()
      const capacity = (coin: EvmListCoin) => capacityWei(false)(coin, context(0).gas * policy.gasPriceWei)
      const later = this.spendableLater(policy, eligible, request.amountWei, capacity)
      throw later !== undefined ? new EvmTransactionSetInsufficientFundsError(later)
        : this.refusal(request.operationId, policy, eligible, request.amountWei, capacity)
    }
    let members: LocalMember[]
    const yielder = createCooperativeBatchYielder()
    const carved: { member?: LocalMember } = {}
    let changeBudget: bigint | undefined
    // The coin distribution's band: change only as far as the pool stays within it (the same
    // count the quote makes, `changeBand`).
    // A fan-in's sources all move whole into one coin, which pays: that coin is the one source.
    const residuals = fanIn ? [BIG_RESIDUAL] : this.sourceResiduals(parts, request.amountWei, data, index => context(index).gas * policy.gasPriceWei)
    const band = this.changeBand(policy, parts, residuals)
    // A continuation not carved into its own account is carried by this set's change: the band
    // never takes that away (a send is never refused for it).
    const needsChange = reserve > 0n && !carve
    const changeAllowance = (residual: bigint, atLeastOne = needsChange) => band.allowance(changeBudget === undefined ? policy.maxChangeOutputs
      : Math.min(policy.maxChangeOutputs, Number(changeBudget / changeFee)), residual, atLeastOne)
    const spendChange = (planned: LocalMember[], residual: bigint) => {
      band.planned(planned.filter(member =>
        member.plan.transactionSet!.role === 'change' && member !== carved.member).length, residual)
      if (changeBudget === undefined) return
      for (const member of planned)
        if (member.plan.transactionSet!.role === 'change' && member !== carved.member)
          changeBudget -= memberFee(member.plan.unsignedTransaction)
    }
    try {
      if (fanIn) {
        members = await this.prepareFanIn(request, policy, context(0), parts, yielder, carve && { wei: carve.reserveWei, carved },
          optionalChangeAllowance(changeAllowance(BIG_RESIDUAL), MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0),
            parts.length + 1, 0, carve ? 1 : 0))
        spendChange(members, BIG_RESIDUAL)
      }
      else {
        let remaining = request.amountWei, paymentIndex = 0
        const planned = parts.map(part => {
          const payment = part.paymentValueWei < remaining ? part.paymentValueWei : remaining
          remaining -= payment
          // Only recipient-bearing sources execute calldata. A genuine zero-value
          // call executes once; additional inputs exist solely to fund private change.
          const hasPayment = payment > 0n || (request.amountWei === 0n && paymentIndex === 0 && data !== '0x')
          const index = paymentIndex
          if (hasPayment) paymentIndex++
          return { part, payment, hasPayment, index }
        })
        if (bound !== undefined) {
          const paymentFees = planned.reduce((sum, item) =>
            item.hasPayment ? sum + context(item.index).gas * policy.gasPriceWei : sum, 0n)
          if (committed + paymentFees + heldForContinuation > bound)
            throw new EvmTransactionSetFeeExceededError(committed + paymentFees + heldForContinuation)
          changeBudget = bound - committed - paymentFees - heldForContinuation
        }
        members = []
        const paymentMembers = planned.filter(item => item.hasPayment).length
        const memberBudget = MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0)
        let changeMembers = 0
        for (const [position, { part, payment, hasPayment, index }] of planned.entries()) {
          const residual = residuals[position]!
          const source = await this.prepareSource(
            hasPayment ? request : { ...request, calldata: undefined },
            policy, context(hasPayment ? index : 0),
            { ...part, paymentValueWei: payment }, index, yielder,
            optionalChangeAllowance(changeAllowance(residual), memberBudget, paymentMembers, changeMembers,
              carve && !carved.member ? 1 : 0),
            carve && !carved.member ? { wei: carve.reserveWei, carved } : undefined,
          )
          changeMembers += source.filter(member => member.plan.transactionSet!.role === 'change').length
          spendChange(source, residual)
          members.push(...source)
        }
      }
      // Selection budgets the recipient transfer first. Geometric change has its own
      // actual fees, so a nominal continuation balance is not yet a usable reserve.
      // Keep the completed source plans and add change-only sources for any shortfall;
      // never replace their destinations or expose a partly constructed operation.
      // Only change a later stage can be paid from counts (see `privateOutputs`).
      const privateValue = () => members.reduce((sum, member) =>
        member.plan.transactionSet!.role === 'change' &&
        !behindPayment(members.map(item => item.plan), member.plan)
          ? sum + Transaction.from(member.raw).value : sum, 0n)
      if (carve && !carved.member) {
        // No payment source had the reserve left over: one other coin that holds it moves it
        // to its fresh account (selection: the first that covers it alone). What that coin
        // holds beyond it is change under the bound, or stays with it on its next nonce.
        const remainingMembers = MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0) - members.length
        if (remainingMembers < 1) throw new Error('Insufficient private change for continuation')
        const additional = select(false, { deficit: carve.reserveWei, maxCoins: 1 })
        if (!additional) {
          this.options.assertFundingObserved?.()
          throw this.refusal(request.operationId, policy, eligible, carve.reserveWei,
            coin => capacityWei(false, true)(coin, policy.changeGasLimit * policy.gasPriceWei))
        }
        parts.push(...additional)
        const extraResidual = additional[0]!.coin.valueWei
        band.addSource(extraResidual)
        const source = await this.prepareSource(
          { ...request, calldata: undefined }, policy, context(0),
          { ...additional[0]!, paymentValueWei: 0n }, 0, yielder,
          optionalChangeAllowance(changeAllowance(extraResidual), remainingMembers, 0, 0, 1),
          { wei: carve.reserveWei, carved },
        )
        if (!carved.member) throw new Error('Insufficient private change for continuation')
        spendChange(source, extraResidual)
        members.push(...source)
      }
      while (privateValue() < reserve) {
        const remainingMembers = MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0) - members.length
        const maxCoins = Math.min(remainingMembers, (request.maxPaymentParts ?? MAX_TRANSACTION_SET_MEMBERS) - parts.length)
        if (maxCoins <= 0) throw new Error('Insufficient private change for continuation')
        // A change-only source moves value by change alone: with no change fee left under the
        // bound there is nothing it may sign.
        if (changeAllowance(BIG_RESIDUAL, true) < 1) throw new EvmTransactionSetFeeExceededError(bound! - changeBudget! + changeFee)
        const deficit = reserve - privateValue()
        const additional = select(false, { deficit, maxCoins })
        if (!additional) {
          this.options.assertFundingObserved?.()
          throw this.refusal(request.operationId, policy, eligible, deficit,
            coin => capacityWei(false, true)(coin, policy.changeGasLimit * policy.gasPriceWei))
        }
        parts.push(...additional)
        for (const [position, part] of additional.entries()) {
          const residual = part.coin.valueWei
          band.addSource(residual)
          if (changeAllowance(residual, true) < 1) throw new EvmTransactionSetFeeExceededError(bound! - changeBudget! + changeFee)
          const source = await this.prepareSource(
            { ...request, calldata: undefined }, policy, context(0),
            { ...part, paymentValueWei: 0n }, 0, yielder,
            optionalChangeAllowance(changeAllowance(residual, true), MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0),
              0, members.length, additional.length - position - 1),
          )
          spendChange(source, residual)
          members.push(...source)
        }
      }
      const offset = existing?.members.length ?? 0
      const all = [...(existing?.members.map(member => ({ plan: member })) ?? []), ...members]
      const previous = new Map<string, number>(), incoming = new Map<string, number[]>()
      all.forEach((member, index) => {
        const meta = member.plan.transactionSet!, tx = Transaction.from(member.plan.unsignedTransaction)
        if (index >= offset) {
          const prior = previous.get(member.plan.source.address), funding = incoming.get(member.plan.source.address)
          member.plan.dependencies = prior !== undefined ? [prior] : funding ?? []
          if (prior === undefined && funding) meta.fundingWaitBlocks = fundsSettleBlocks(policy.spendRule?.waitBlocks)
          if (stageId !== undefined) meta.stageId = stageId
        }
        previous.set(member.plan.source.address, index)
        if (meta.role !== 'payment') incoming.set(tx.to!.toLowerCase(), [...(incoming.get(tx.to!.toLowerCase()) ?? []), index])
      })
      const totalFee = all.reduce((sum, member) => { const tx = Transaction.from(member.plan.unsignedTransaction); return sum + tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!) }, 0n)
      // The continuation's own transfer is counted too: it is paid under this same bound.
      const authorizedFee = totalFee + (carve?.feeWei ?? 0n)
      if ((request.maxFeeWei !== undefined && authorizedFee > request.maxFeeWei) || existing?.transactionSetStages?.some(stage => stage.maxFeeWei !== undefined && authorizedFee > BigInt(stage.maxFeeWei))) throw new EvmTransactionSetFeeExceededError(authorizedFee)
      if (all.length > MAX_TRANSACTION_SET_MEMBERS) throw new Error('Transaction-set exceeds member capacity')
      if (privateValue() < reserve) throw new Error('Insufficient private change for continuation')
    } catch (error) {
      coins.abandonTransactionSetSources(request.operationId, parts.map(part => part.coin), beforeSelection)
      throw error
    }
    const payments = members.filter(member => member.plan.transactionSet!.role === 'payment').sort((a,b) => a.plan.transactionSet!.logicalIndex - b.plan.transactionSet!.logicalIndex)
    const stage: EvmTransactionSetStage = {
      ...(stageId === undefined ? {} : { stageId }), startIndex: existing?.members.length ?? 0, memberCount: members.length,
      intendedValueWei: request.amountWei.toString(), calldata: data.toLowerCase(), destinations: payments.map(member => Transaction.from(member.raw).to!.toLowerCase()),
      ...(request.maxFeeWei === undefined ? {} : { maxFeeWei: request.maxFeeWei.toString() }),
      ...(request.minimumPaymentWei === undefined ? {} : { minimumPaymentWei: minimum.toString() }),
      ...(request.reserveForContinuationWei === undefined ? {} : { reserveForContinuationWei: reserve.toString() }),
      ...(legacy ? { legacy: true } : {}),
    }
    let row: EvmNativeOperation
    try {
      row = existing ? await journal.appendTransactionSet(existing.operationId, stage, members.map(member => member.plan), members.map(member => member.raw)) : await journal.prepare({
      kind: 'transaction-set', preparationId: prefix + request.operationId, recipient: stage.destinations[0]!, intendedValueWei: request.amountWei.toString(),
      transactionSetStages: [stage], members: members.map(member => member.plan),
    }, members.map(member => member.raw))
    } catch (error) {
      let authority: EvmNativeOperation | undefined
      try { authority = await journal.refreshPreparation(prefix + request.operationId) }
      catch { throw error } // Uncertain writes keep every reservation fenced until reopen.
      if (authority && (stageId === undefined || authority.transactionSetStages?.some(stage => stage.stageId === stageId))) {
        if (this.getOperation(request.operationId)) this.restoreRow(authority) // Commit-then-throw: the original durable signed bytes win.
      } else
        coins.abandonTransactionSetSources(request.operationId, parts.map(part => part.coin), beforeSelection)
      throw error
    }
    this.restoreRow(row)
    await coins.checkpointTransactionSetReservations(request.operationId)
    return this.result(row, stageId)
  }

  /** A one-transfer continuation's reserve (`continuationFeeWei` set): the value of the fresh
   * account kept for it, and its transfer's fee. */
  private continuationCarve(request: Pick<ConstructEvmTransactionSetRequest, 'reserveForContinuationWei' | 'continuationFeeWei'>):
    { reserveWei: bigint; feeWei: bigint } | undefined {
    const reserve = request.reserveForContinuationWei ?? 0n
    if (request.continuationFeeWei === undefined) return undefined
    if (reserve <= 0n || request.continuationFeeWei < 0n || request.continuationFeeWei >= reserve)
      throw new Error('Invalid transaction-set continuation')
    return { reserveWei: reserve, feeWei: request.continuationFeeWei }
  }

  private validateRequest(request: ConstructEvmTransactionSetRequest): void {
    const data = request.calldata ?? '0x', reserve = request.reserveForContinuationWei ?? 0n
    const minimum = request.minimumPaymentWei ?? 0n
    if (minimum < 0n || request.amountWei < minimum) throw new Error('Invalid transaction-set minimum payment')
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || request.amountWei < 0n || reserve < 0n ||
        request.amountWei + reserve >= 1n << 256n || (request.amountWei === 0n && data === '0x')) throw new Error('Invalid transaction-set payment')
  }

  /** The rules one transaction set selects its coins by. Construction reserves with them and a
   * quote only plans with them, so a quote is the construction's own decision. */
  private selectionRules(
    request: ConstructEvmTransactionSetRequest,
    policy: EvmTransactionSetPolicy,
    legacy: boolean,
    existing: EvmNativeOperation | undefined,
    admittedInput: ((source: string, nonce: number) => boolean) | undefined,
  ) {
    const { journal } = this.options
    const data = request.calldata ?? '0x', reserve = request.reserveForContinuationWei ?? 0n
    const minimum = request.minimumPaymentWei ?? 0n
    const contexts = new Map<number, PaymentContext>()
    const context = (index: number): PaymentContext => {
      const known = contexts.get(index)
      if (known) return known
      const destination = getAddress(request.kdf(index)).toLowerCase(), gas = policy.paymentGasLimit(data, destination)
      this.validatePolicy(policy, gas, data)
      const feeIsExact = typeof policy.paymentFeeIsExact === 'function' ? policy.paymentFeeIsExact(destination, data) : policy.paymentFeeIsExact
      if (typeof feeIsExact !== 'boolean') throw new Error('Invalid reviewed fee semantics')
      const value = { destination, gas, feeIsExact }; contexts.set(index, value); return value
    }
    context(0)
    const remainingMemberBudget = MAX_TRANSACTION_SET_MEMBERS - (existing?.members.length ?? 0)
    const only = request.sourceAccounts === undefined ? undefined
      : new Set(request.sourceAccounts.map(account => getAddress(account).toLowerCase()))
    const excluded = new Set((request.excludedSourceAccounts ?? []).map(account => getAddress(account).toLowerCase()))
    const eligible = (coin: EvmListCoin) =>
      (only === undefined || only.has(coin.account)) && !excluded.has(coin.account) &&
      (admittedInput?.(coin.account, coin.nonce) ?? true) &&
      journal.canSelect(coin.account, coin.nonce) &&
      (this.options.canSelectCoin?.(coin) ?? true) &&
      this.dependencyReady(coin, policy)
    // The chain's spend rule (Monad: an account that sent within `waitBlocks` blocks may not go
    // below `belowWei`) decides how much of a coin one more transaction may move.
    const capacityWei = (fanIn: boolean, continuation?: unknown) => (coin: EvmListCoin, fee: bigint) => {
      const capacity = coin.valueWei - fee, rule = policy.spendRule
      if (continuation && capacity < policy.dustWei) return 0n
      if (!rule?.waitBlocks || coin.nonce === 0 || (coin.lastSpentInBlock !== undefined && policy.head >= coin.lastSpentInBlock + rule.waitBlocks)) return capacity
      // Fan-in and change-only continuation move the complete source; partial capacity is insufficient.
      if (fanIn || continuation) return 0n
      return capacity > rule.belowWei ? capacity - rule.belowWei : 0n
    }
    const carveFee = request.continuationFeeWei === undefined ? 0n : policy.changeGasLimit * policy.gasPriceWei
    const selection = (fanIn: boolean, continuation?: { deficit: bigint; maxCoins: number }, oneSource = false): TransactionSetSelection => ({
      holder: request.operationId, ownedCandidates: existing ? this.privateOutputs(existing) : undefined,
      // Independent selection funds recipients only. Actual private change determines the
      // later continuation deficit; reserve-only inputs use full-source eligibility there.
      amountWei: continuation?.deficit ?? (request.amountWei + (fanIn ? reserve + carveFee + context(0).gas * policy.gasPriceWei : 0n)),
      minimumPaymentWei: fanIn || continuation ? undefined : minimum,
      feeWei: index => (fanIn || continuation ? policy.changeGasLimit : context(index).gas) * policy.gasPriceWei,
      head: policy.head, sourceOrder: policy.sourceOrder,
      // Every selected source requires at least one member. Fan-in also needs its
      // final recipient transaction; actual change members are checked after planning.
      maxCoins: Math.min(remainingMemberBudget - (fanIn ? 1 : 0),
        oneSource ? 1 : continuation?.maxCoins ?? (legacy && !fanIn ? 1 : request.maxPaymentParts ?? remainingMemberBudget)),
      canSelect: eligible,
      capacityWei: capacityWei(fanIn, continuation),
    })
    return { context, eligible, capacityWei, selection, remainingMemberBudget }
  }

  /** The coin distribution's band for one set whose sources are `parts` (planned or taken),
   * with these residuals: the pool coins outside them are what the set's change is counted
   * against. Construction and quotes count the same way, so a quote is the construction's
   * decision. */
  private changeBand(policy: EvmTransactionSetPolicy, parts: readonly CoinPart[], residualsWei: readonly bigint[]): EvmChangeBand {
    const distribution = policy.coinDistribution
    if (distribution === undefined) return new EvmChangeBand(undefined, 0, residualsWei)
    const excluded = new Set(parts.map(part => part.coin.account))
    return new EvmChangeBand(distribution,
      countPoolCoins(this.options.coins.liveUnspent(), distribution, excluded), residualsWei)
  }

  /** What each source holds beyond its share of `amountWei` and that payment's fee, the shares
   * split as construction splits them (each pays up to its `paymentValueWei`, in order). */
  private sourceResiduals(parts: readonly CoinPart[], amountWei: bigint, data: string,
    paymentFee: (paymentIndex: number) => bigint): bigint[] {
    let remaining = amountWei, paymentIndex = 0
    return parts.map(part => {
      const payment = part.paymentValueWei < remaining ? part.paymentValueWei : remaining
      remaining -= payment
      const hasPayment = payment > 0n || (amountWei === 0n && paymentIndex === 0 && data !== '0x')
      const fee = hasPayment ? paymentFee(paymentIndex++) : 0n
      return part.coin.valueWei - payment - fee
    })
  }

  /** The fresh change outputs a source's residual is split into (none when the radix split
   * cannot carry it: the residual then stays with the sender on the account's next nonce).
   * How many there are depends only on the residual and the payment, never on the entropy. */
  private changeOutputs(policy: EvmTransactionSetPolicy, remainder: bigint, recipientAmountWei: bigint,
    maxOutputs = policy.maxChangeOutputs): bigint[] {
    const changeFee = policy.changeGasLimit * policy.gasPriceWei
    if (remainder < policy.dustWei + changeFee || maxOutputs < 1) return []
    try {
      return computeGeometricRadixChangeSplits({
        totalAvailableWei: remainder,
        recipientAmountWei,
        dustThresholdWei: policy.dustWei,
        minFeePerTxWei: changeFee,
        maxOutputs: Math.min(maxOutputs, policy.maxChangeOutputs),
        radix: policy.radix,
        jitterBps: policy.jitterBps,
        random: () => this.entropy(),
      })
    } catch (error) {
      // No partition satisfies the dust and magnitude limits (for example a residual
      // just above dust whose only legal size would sit at the payment's magnitude).
      // That is no reason to refuse the payment: keep the residual on the successor.
      if (!(error instanceof RangeError)) throw error
      return []
    }
  }

  /**
   * What a single-recipient (legacy) transfer to `destination` would pay now: the coins the same
   * selection would take, the same change split, and so the exact fee of every transaction it
   * would sign (`feeWei`). Nothing is reserved, derived or signed. With no `amountWei`, the
   * transfer is the largest one transfer can send now: every coin selection can draw on, less
   * the fees of moving it (`amountWei` in the answer). Construction with `maxFeeWei: feeWei`
   * makes the same decision while the coin list is unchanged; if another payment took a coin
   * meanwhile it refuses rather than pay more.
   */
  async quoteLegacyTransactionSet(request: {
    destination: string
    amountWei?: bigint
    excludedSourceAccounts?: readonly string[]
    /** A one-transfer continuation kept back as construction keeps it (see
     * `ConstructEvmTransactionSetRequest.continuationFeeWei`): its fresh account's transfer and
     * the continuation's own fee are part of `feeWei`. Only with `amountWei`. */
    continuation?: { reserveWei: bigint; feeWei: bigint }
  }): Promise<EvmTransactionSetQuote> {
    const { journal, coins } = this.options
    const destination = getAddress(request.destination).toLowerCase()
    const admittedInput = await journal.captureInputSelection?.()
    const policy = this.options.policy()
    const changeFee = policy.changeGasLimit * policy.gasPriceWei
    if (request.continuation && request.amountWei === undefined)
      throw new Error('A continuation is quoted only with its amount')
    const continuation = request.continuation === undefined ? {} : {
      reserveForContinuationWei: request.continuation.reserveWei,
      continuationFeeWei: request.continuation.feeWei,
    }
    const carve = this.continuationCarve(continuation)
    const rulesFor = (amountWei: bigint) => {
      const quoteRequest: ConstructEvmTransactionSetRequest = {
        operationId: 'quote', amountWei, kdf: () => destination,
        ...(request.excludedSourceAccounts ? { excludedSourceAccounts: request.excludedSourceAccounts } : {}),
        ...(request.amountWei === undefined ? {} : continuation),
      }
      this.validateRequest(quoteRequest)
      return this.selectionRules(quoteRequest, policy, true, undefined, admittedInput)
    }
    const insufficient = (): never => {
      this.options.assertFundingObserved?.()
      throw new EvmTransactionSetInsufficientFundsError()
    }
    let amountWei = request.amountWei
    if (amountWei === undefined) {
      const rules = rulesFor(1n), paymentFee = rules.context(0).gas * policy.gasPriceWei
      const candidates = coins.transactionSetCandidates(rules.selection(true))
      // One coin pays the recipient itself: what the best one can move after its fee.
      const single = candidates.reduce((best, coin) => {
        if (coin.valueWei < paymentFee) return best
        const capacity = rules.capacityWei(false)(coin, paymentFee)
        return capacity > best ? capacity : best
      }, 0n)
      // Or every coin moves to one fresh account, which pays the recipient: what they hold less
      // a transfer fee each, and the payment's own fee. Selection walks them in this order.
      const fanIn = candidates
        .filter(coin => coin.valueWei >= changeFee && rules.capacityWei(true)(coin, changeFee) > 0n)
        .slice(0, rules.remainingMemberBudget - 1)
        .reduce((sum, coin) => sum + rules.capacityWei(true)(coin, changeFee), 0n) - paymentFee
      amountWei = single > fanIn ? single : fanIn
      if (amountWei <= 0n) insufficient()
    }
    const rules = rulesFor(amountWei!)
    const paymentFee = rules.context(0).gas * policy.gasPriceWei
    const single = coins.planTransactionSetSources(rules.selection(false))
    if (single) return { amountWei: amountWei!, ...this.continuedFee(single, amountWei!, undefined, policy, rules, carve) }
    const parts = coins.planTransactionSetSources(rules.selection(true))
    if (!parts) {
      this.options.assertFundingObserved?.()
      throw this.refusal(undefined, policy, rules.eligible, amountWei!,
        coin => rules.capacityWei(false)(coin, paymentFee))
    }
    const balance = parts.reduce((sum, part) => sum + part.coin.valueWei - changeFee, 0n)
    const kept = carve ? carve.reserveWei + changeFee : 0n
    const allowance = optionalChangeAllowance(this.changeBand(policy, parts, [BIG_RESIDUAL]).allowance(policy.maxChangeOutputs, BIG_RESIDUAL),
      rules.remainingMemberBudget, parts.length + 1, 0, carve ? 1 : 0)
    const outputs = this.changeOutputs(policy, balance - amountWei! - paymentFee - kept, amountWei!,
      carve ? Math.min(allowance, policy.maxChangeOutputs - 1) : allowance)
    if (parts.length + 1 + outputs.length + (carve ? 1 : 0) > rules.remainingMemberBudget)
      throw new Error('Transaction-set exceeds member capacity')
    const consolidationFeeWei = BigInt(parts.length) * changeFee
    const changeFeeWei = BigInt(outputs.length + (carve ? 1 : 0)) * changeFee
    return { amountWei: amountWei!, inputCount: parts.length, consolidationFeeWei, deliveryFeeWei: paymentFee,
      changeFeeWei, feeWei: consolidationFeeWei + paymentFee + changeFeeWei + (carve?.feeWei ?? 0n) }
  }

  /**
   * What moving everything the coins of `sourceAccounts` hold to `destination` (an account of
   * this wallet) would move and pay now: each coin one transfer of its whole value less that
   * transfer's fee, and no change. A coin whose transfer would cost as much as it moves, one
   * another operation holds, and one the chain's spend rule keeps (Monad: an account that sent
   * within the last blocks) is not counted, and is not in `sourceAccounts` of the answer.
   * Constructing `amountWei` with the answer's `sourceAccounts`, `maxPaymentParts` of their
   * count and `maxFeeWei: feeWei` makes the same decision while the coin list is unchanged.
   * Nothing is reserved, derived or signed.
   */
  async quoteSweepTransactionSet(request: {
    destination: string
    sourceAccounts: readonly string[]
  }): Promise<EvmTransactionSetQuote & { readonly sourceAccounts: readonly string[] }> {
    const { journal, coins } = this.options
    const destination = getAddress(request.destination).toLowerCase()
    const admittedInput = await journal.captureInputSelection?.()
    const policy = this.options.policy()
    const quoteRequest: ConstructEvmTransactionSetRequest = {
      operationId: 'quote', amountWei: 1n, kdf: () => destination,
      sourceAccounts: request.sourceAccounts,
    }
    this.validateRequest(quoteRequest)
    const rules = this.selectionRules(quoteRequest, policy, false, undefined, admittedInput)
    const fee = rules.context(0).gas * policy.gasPriceWei
    const seen = new Set<string>()
    const moved: { account: string; value: bigint }[] = []
    for (const coin of coins.transactionSetCandidates(rules.selection(false))) {
      if (seen.has(coin.account) || coin.account === destination) continue
      seen.add(coin.account)
      if (coin.valueWei < fee) continue
      const capacity = rules.capacityWei(false)(coin, fee)
      // Only a coin that moves more than its own transfer costs is worth moving.
      if (capacity > fee && capacity === coin.valueWei - fee)
        moved.push({ account: coin.account, value: capacity })
    }
    if (moved.length === 0 || moved.length > rules.remainingMemberBudget) {
      this.options.assertFundingObserved?.()
      throw new EvmTransactionSetInsufficientFundsError()
    }
    const feeWei = BigInt(moved.length) * fee
    return {
      amountWei: moved.reduce((sum, coin) => sum + coin.value, 0n),
      inputCount: moved.length, consolidationFeeWei: 0n, deliveryFeeWei: feeWei,
      changeFeeWei: 0n, feeWei, sourceAccounts: moved.map(coin => coin.account),
    }
  }

  /**
   * What a transaction set paying `amountWei` to `kdf`'s recipients (a contact or stealth
   * payment) would pay now: the coins the same selection would take, the same per-source
   * payments and change split, and so the exact fee of every transaction it would sign. Only
   * the inputs this amount needs are counted. Nothing is reserved, derived or signed. With a
   * one-transfer continuation (`reserveForContinuationWei` and `continuationFeeWei`), its
   * reserve is kept as construction keeps it and its transfer is counted: construction under
   * `maxFeeWei: feeWei` then makes the same decision.
   */
  async quoteTransactionSet(request: Pick<ConstructEvmTransactionSetRequest, 'amountWei' | 'kdf' | 'calldata' | 'maxPaymentParts' | 'minimumPaymentWei' | 'reserveForContinuationWei' | 'continuationFeeWei'>): Promise<EvmTransactionSetQuote> {
    const { journal, coins } = this.options
    const quoteRequest: ConstructEvmTransactionSetRequest = { ...request, operationId: 'quote' }
    this.validateRequest(quoteRequest)
    const carve = this.continuationCarve(quoteRequest)
    if (!carve && (request.reserveForContinuationWei ?? 0n) > 0n)
      throw new Error('Only a one-transfer continuation is quoted with its payment')
    const admittedInput = await journal.captureInputSelection?.()
    const policy = this.options.policy()
    const rules = this.selectionRules(quoteRequest, policy, false, undefined, admittedInput)
    const parts = coins.planTransactionSetSources(rules.selection(false))
    if (!parts) {
      this.options.assertFundingObserved?.()
      throw this.refusal(undefined, policy, rules.eligible, request.amountWei,
        coin => rules.capacityWei(false)(coin, rules.context(0).gas * policy.gasPriceWei))
    }
    return { amountWei: request.amountWei, ...this.continuedFee(parts, request.amountWei, request.calldata, policy, rules, carve) }
  }

  /** The fee of paying `amountWei` from `parts` (`independentFee`) and, for a one-transfer
   * continuation (`carve`), keeping its reserve as construction keeps it: from the first part
   * whose residual holds it, else moved by one other coin that covers it alone (what that coin
   * holds beyond it split as change); and the continuation's own transfer. */
  private continuedFee(
    parts: readonly CoinPart[], amountWei: bigint, calldata: string | undefined,
    policy: EvmTransactionSetPolicy, rules: ReturnType<EvmTransactionSetPreparer['selectionRules']>,
    carve: { reserveWei: bigint; feeWei: bigint } | undefined,
  ): Omit<EvmTransactionSetQuote, 'amountWei'> {
    const band = this.changeBand(policy, parts, this.sourceResiduals(parts, amountWei, calldata ?? '0x',
      index => rules.context(index).gas * policy.gasPriceWei))
    const { carved, memberCount, ...fee } = this.independentFee(parts, amountWei, calldata, policy, rules.context, carve?.reserveWei, band)
    if (!carve) return fee
    const changeFee = policy.changeGasLimit * policy.gasPriceWei
    let changeFeeWei = fee.changeFeeWei, inputCount = fee.inputCount, totalMembers = memberCount
    if (!carved) {
      const taken = new Set(parts.map(part => part.coin.account))
      const selection = rules.selection(false, { deficit: carve.reserveWei, maxCoins: 1 })
      const extra = this.options.coins.planTransactionSetSources({ ...selection,
        canSelect: coin => !taken.has(coin.account) && (selection.canSelect?.(coin) ?? true) })
      if (!extra) {
        this.options.assertFundingObserved?.()
        throw new EvmTransactionSetInsufficientFundsError()
      }
      band.addSource(extra[0]!.coin.valueWei)
      const outputs = this.changeOutputs(policy, extra[0]!.coin.valueWei - carve.reserveWei - changeFee, amountWei,
        optionalChangeAllowance(Math.min(band.allowance(policy.maxChangeOutputs, extra[0]!.coin.valueWei), policy.maxChangeOutputs - 1),
          MAX_TRANSACTION_SET_MEMBERS, totalMembers, 0, 1))
      changeFeeWei += BigInt(1 + outputs.length) * changeFee
      totalMembers += 1 + outputs.length
      inputCount++
    }
    if (totalMembers > MAX_TRANSACTION_SET_MEMBERS) throw new Error('Transaction-set exceeds member capacity')
    return { inputCount, consolidationFeeWei: fee.consolidationFeeWei, deliveryFeeWei: fee.deliveryFeeWei,
      changeFeeWei, feeWei: fee.deliveryFeeWei + changeFeeWei + carve.feeWei }
  }

  /** The fee of paying `amountWei` from these sources, each paying its share directly, split
   * exactly as construction splits it (see `construct` and `prepareSource`). */
  private independentFee(
    parts: readonly CoinPart[], amountWei: bigint, calldata: string | undefined,
    policy: EvmTransactionSetPolicy, context: (index: number) => PaymentContext,
    /** A one-transfer continuation's reserve, kept from the first residual that holds it and
     * its transfer, as `prepareSource` keeps it. */
    carveWei?: bigint,
    /** The coin distribution's band, as construction applies it. */
    band: EvmChangeBand = this.changeBand(policy, parts, this.sourceResiduals(parts, amountWei, calldata ?? '0x',
      index => context(index).gas * policy.gasPriceWei)),
  ): Omit<EvmTransactionSetQuote, 'amountWei'> & { carved: boolean; memberCount: number } {
    const data = calldata ?? '0x', changeFee = policy.changeGasLimit * policy.gasPriceWei
    let remaining = amountWei, paymentIndex = 0, deliveryFeeWei = 0n, outputs = 0, carved = false
    const paymentMembers = amountWei === 0n && data !== '0x' ? 1 : parts.filter(part => part.paymentValueWei > 0n).length
    for (const part of parts) {
      const payment = part.paymentValueWei < remaining ? part.paymentValueWei : remaining
      remaining -= payment
      const hasPayment = payment > 0n || (amountWei === 0n && paymentIndex === 0 && data !== '0x')
      const fee = hasPayment ? context(paymentIndex).gas * policy.gasPriceWei : 0n
      let residual = part.coin.valueWei - payment - fee
      const before = residual
      const allowance = optionalChangeAllowance(band.allowance(policy.maxChangeOutputs, before),
        MAX_TRANSACTION_SET_MEMBERS, paymentMembers, outputs, carveWei !== undefined && !carved ? 1 : 0)
      let made: number
      if (carveWei !== undefined && !carved && residual >= carveWei + changeFee) {
        carved = true
        outputs++
        residual -= carveWei + changeFee
        made = this.changeOutputs(policy, residual, hasPayment ? payment : amountWei, Math.min(allowance, policy.maxChangeOutputs - 1)).length
      } else
        made = this.changeOutputs(policy, residual, hasPayment ? payment : amountWei, allowance).length
      outputs += made
      band.planned(made, before)
      deliveryFeeWei += fee
      if (hasPayment) paymentIndex++
    }
    const changeFeeWei = BigInt(outputs) * changeFee, memberCount = paymentMembers + outputs
    if (memberCount > MAX_TRANSACTION_SET_MEMBERS) throw new Error('Transaction-set exceeds member capacity')
    return { inputCount: parts.length, consolidationFeeWei: 0n, deliveryFeeWei, changeFeeWei, feeWei: deliveryFeeWei + changeFeeWei, carved, memberCount }
  }

  private async prepareFanIn(request: ConstructEvmTransactionSetRequest, policy: EvmTransactionSetPolicy, context: PaymentContext, parts: CoinPart[], yielder: CooperativeBatchYielder,
    carve?: { wei: bigint; carved: { member?: LocalMember } }, maxChangeOutputs = policy.maxChangeOutputs): Promise<LocalMember[]> {
    const { coins } = this.options, minimum = coins.nextChangeIndex()
    const target = this.options.reserveChange ? await this.options.reserveChange(request.operationId, minimum) : this.options.deriveChange(minimum)
    if (!Number.isSafeInteger(target.changeIndex) || target.changeIndex < minimum || target.changeIndex >= 0x80000000 || target.account.toLowerCase() === context.destination || computeAddress(target.privateKey).toLowerCase() !== target.account.toLowerCase()) throw new Error('Invalid fan-in destination')
    coins.reserveChangeTarget(request.operationId, target.changeIndex, target.account)
    let balance = 0n
    const members: LocalMember[] = []
    for (const [index, part] of parts.entries()) {
      const value = part.coin.valueWei - policy.changeGasLimit * policy.gasPriceWei
      balance += value
      const tx = Transaction.from({ type: 0, chainId: BigInt(this.options.journal.binding.nativeChainId), nonce: part.coin.nonce,
        to: target.account, value, gasLimit: policy.changeGasLimit, gasPrice: policy.gasPriceWei })
      tx.signature = new SigningKey(part.coin.privateKey).sign(tx.unsignedHash)
      members.push({ raw: tx.serialized, plan: { source: { kind: 'coin', address: part.coin.account }, unsignedTransaction: tx.unsignedSerialized, dependencies: [], transactionSet: {
        role: 'funding', logicalIndex: index, changeIndex: target.changeIndex, balanceBeforeWei: part.coin.valueWei.toString(), balanceAfterWei: '0',
      } } })
      await yielder.maybeYield()
    }
    const coin: EvmListCoin = { account: target.account.toLowerCase(), privateKey: target.privateKey, changeIndex: target.changeIndex, origin: 'change', nonce: 0, valueWei: balance, state: 'spend_pending', holder: request.operationId }
    members.push(...await this.prepareSource(request, policy, context, { coin, paymentValueWei: request.amountWei }, 0, yielder, maxChangeOutputs, carve))
    return members
  }

  private validatePolicy(
    policy: EvmTransactionSetPolicy,
    gas: bigint,
    data: string,
  ): void {
    const staticRule = this.recoverySpendRule,
      economicRule = policy.spendRule
    if (
      (staticRule === undefined) !== (economicRule === undefined) ||
      (staticRule &&
        economicRule &&
        (staticRule.belowWei !== economicRule.belowWei ||
          staticRule.waitBlocks !== economicRule.waitBlocks))
    )
      throw new Error(
        'Construction spend rule must match the static network recovery rule',
      )
    let intrinsic = 21000n
    for (let index = 2; index < data.length; index += 2)
      intrinsic += data.slice(index, index + 2) === '00' ? 4n : 16n
    if (
      typeof gas !== 'bigint' ||
      gas < intrinsic ||
      policy.gasPriceWei <= 0n ||
      policy.changeGasLimit !== 21000n ||
      policy.dustWei <= 0n ||
      !Number.isSafeInteger(policy.head) ||
      policy.head < 0 ||
      !Number.isSafeInteger(policy.radix) ||
      policy.radix < 2 ||
      !Number.isSafeInteger(policy.maxChangeOutputs) ||
      policy.maxChangeOutputs < 1 ||
      policy.maxChangeOutputs > 63 ||
      !Number.isSafeInteger(policy.jitterBps) ||
      policy.jitterBps < 0 ||
      policy.jitterBps > 9999 ||
      JSON.stringify(policy.sourceOrder) !==
        JSON.stringify(EVM_TRANSACTION_SET_SOURCE_ORDER) ||
      (policy.spendRule &&
        (policy.spendRule.belowWei < 0n ||
          !Number.isSafeInteger(policy.spendRule.waitBlocks) ||
          policy.spendRule.waitBlocks < 0))
    )
      throw new Error('Invalid reviewed EVM transaction-set policy')
  }

  /** Public-address projection of current signed graphs, never a spend inventory. Destination
   * ownership must be derived locally; arbitrary recipient addresses are never included. */
  ownedBalanceProjection(): { accounts: readonly string[]; pendingOperations: number; generation: string } {
    const accounts = new Set<string>(), generations: unknown[] = []
    const sources = new Map(this.options.coins.all().map(coin => [coin.account, coin]))
    let pendingOperations = 0
    for (const row of this.options.journal.list()) {
      if (row.cancelled) continue
      const signed = row.members.filter(member => member.signed)
      if (!signed.length) continue
      if (signed.some(member => member.transactionSet
          ? member.transactionSet.inventoryApplied !== true
          : !['included-success', 'included-revert'].includes(member.observation.state) && !nativeMemberSuperseded(member)))
        pendingOperations++
      generations.push([row.operationId, signed.map(member => [member.signed!.transactionHash,
        member.observation.state, member.transactionSet?.inventoryApplied])])
      if (row.kind !== 'transaction-set' || signed.every(member => member.transactionSet?.inventoryApplied === true)) continue
      const merge = this.options.mergeTarget?.(row)
      if (merge && computeAddress(merge.privateKey).toLowerCase() !== merge.account.toLowerCase())
        throw new Error('Merge balance ownership mismatch')
      for (const member of signed) {
        const source = sources.get(member.source.address) ?? this.sourceOf(row, member)
        if (!source || computeAddress(source.privateKey).toLowerCase() !== source.account)
          throw new Error('Transaction-set balance source ownership unavailable')
        accounts.add(source.account)
        const tx = Transaction.from(member.unsignedTransaction), meta = member.transactionSet!
        if (meta.role === 'change' || meta.role === 'funding') {
          const target = this.options.deriveChange(meta.changeIndex!)
          if (target.account.toLowerCase() !== tx.to?.toLowerCase() ||
              computeAddress(target.privateKey).toLowerCase() !== target.account.toLowerCase())
            throw new Error('Change balance ownership mismatch')
          accounts.add(target.account.toLowerCase())
        } else if (merge) {
          if (tx.to?.toLowerCase() !== merge.account.toLowerCase()) throw new Error('Merge balance destination mismatch')
          accounts.add(merge.account.toLowerCase())
        }
      }
    }
    return { accounts: [...accounts].sort(), pendingOperations, generation: JSON.stringify(generations) }
  }

  /**
   * The largest plain independent payment the current free coins can produce: construction's
   * source eligibility, protocol output floor, chain reserve and transaction-member budget.
   * Requires complete observations from the caller's refresh. Reads only; reserves nothing.
   */
  async spendableNowWei(): Promise<bigint> {
    // A balance used to offer a payable wager requires complete current observations. Ordinary
    // construction may still use trusted inventory and a cached quote while a node recovers.
    this.options.assertFundingObserved?.()
    const admittedInput = await this.options.journal.captureInputSelection?.()
    // Admission may await durable reservation owners; do not use observations that failed
    // while it was being captured. The capture is read-only and is reused for the whole pass.
    this.options.assertFundingObserved?.()
    const policy = this.options.policy(), minimum = evmPaymentFloorWei(policy.gasPriceWei)
    const rules = this.selectionRules({
      operationId: '', amountWei: minimum, minimumPaymentWei: minimum,
      // Plain recipient transfers have no destination-dependent calldata cost.
      kdf: () => '0x0000000000000000000000000000000000000000',
    }, policy, false, undefined, admittedInput)
    const selection = rules.selection(false)
    const fee = rules.context(0).gas * policy.gasPriceWei
    const capacity = rules.capacityWei(false)
    const amountWei = this.options.coins.transactionSetCandidates(selection)
      .map(coin => capacity(coin, fee))
      .filter(value => value >= minimum && value > 0n)
      .sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
      .slice(0, selection.maxCoins)
      .reduce((sum, value) => sum + value, 0n)
    if (amountWei === 0n) return 0n
    // Use construction's own planner to verify the bound in its actual source order. Nothing
    // is reserved. The bound is for recipient transfers; any retained reserve stays on its
    // source, under construction's existing optional-change rules.
    const parts = this.options.coins.planTransactionSetSources({ ...selection, amountWei })
    if (!parts) throw new Error('Spendable balance does not match transaction-set selection')
    return parts.reduce((sum, part) => sum + part.paymentValueWei, 0n)
  }

  /**
   * The refusal for a send the free coins do not cover. When what the wallet's own unfinished
   * sends will hand back to it (`pendingOwnValue`) would cover what is missing, it says the
   * money is tied up in a previous send (owner ruling 2026-10-26: refuse, the user tries again);
   * otherwise the funds are simply not there. Reads only; nothing is reserved or recorded.
   */
  private refusal(
    holder: string | undefined,
    policy: EvmTransactionSetPolicy,
    eligible: (coin: EvmListCoin) => boolean,
    amountWei: bigint,
    capacity: (coin: EvmListCoin) => bigint,
  ): EvmTransactionSetInsufficientFundsError {
    const free = this.options.coins
      .selectableAt({ sourceOrder: policy.sourceOrder, canSelect: eligible, head: policy.head })
      .reduce((sum, coin) => {
        const part = capacity(coin)
        return part > 0n ? sum + part : sum
      }, 0n)
    const shortfall = amountWei - free
    if (shortfall <= 0n) return new EvmTransactionSetInsufficientFundsError()
    const outputs = this.pendingOwnValue(holder)
    const tiedUp = outputs.reduce((sum, value) => sum + value, 0n)
    // Each of those outputs is a coin with its own fee to move again.
    const usable = outputs.reduce((sum, valueWei) => {
      const part = capacity({ account: '', nonce: 0, privateKey: '', origin: 'change', valueWei, state: 'unspent' })
      return part > 0n ? sum + part : sum
    }, 0n)
    return usable >= shortfall
      ? new FundsInPendingSendError(tiedUp, shortfall)
      : new EvmTransactionSetInsufficientFundsError()
  }

  /**
   * The wallet's own money that its unfinished transaction sets (other than `holder`'s) hand
   * back to it once they reach the chain: each change move not yet included, and what stays with
   * a sending account after its last move of the set while that move is not yet included. Read
   * from the journal, which owns those signed moves until they land; landed ones are coins in
   * the list and are counted there, never here.
   */
  private pendingOwnValue(holder: string | undefined): bigint[] {
    const values: bigint[] = []
    for (const row of this.options.journal.list()) {
      if (row.kind !== 'transaction-set' || row.cancelled) continue
      if (holder !== undefined && row.preparationId === prefix + holder) continue
      const sources = new Set(row.members.map(member => member.source.address))
      const landed = (member: EvmNativeOperation['members'][number]) =>
        member.transactionSet!.inventoryApplied === true ||
        member.observation.state === 'included-success' ||
        member.observation.state === 'included-revert' ||
        // Superseded or abandoned: it hands nothing back, now or later.
        nativeMemberEnded(member)
      row.members.forEach((member, index) => {
        if (!member.signed || landed(member)) return
        const meta = member.transactionSet!, tx = Transaction.from(member.unsignedTransaction)
        // Change to an account the same set spends from is spent again by that set.
        if (meta.role !== 'payment' && !sources.has(tx.to!.toLowerCase())) values.push(tx.value)
        const last = !row.members.slice(index + 1).some(other =>
          other.source.address === member.source.address && !nativeMemberAbandoned(other))
        if (last && BigInt(meta.balanceAfterWei) > 0n) values.push(BigInt(meta.balanceAfterWei))
      })
    }
    return values
  }

  /** The block from which every coin selection passed over only for the chain's spacing rule
   * may be spent, when what selection could then draw on covers `amountWei`; otherwise
   * undefined (nothing is waiting, or waiting would not be enough). */
  private spendableLater(
    policy: EvmTransactionSetPolicy,
    eligible: (coin: EvmListCoin) => boolean,
    amountWei: bigint,
    capacity: (coin: EvmListCoin) => bigint,
  ): number | undefined {
    const { coins } = this.options
    const query = { sourceOrder: policy.sourceOrder, canSelect: eligible }
    let block: number | undefined
    for (const coin of coins.selectableAt({
      ...query,
      head: Number.MAX_SAFE_INTEGER,
    }))
      if (
        coin.spendableFromBlock !== undefined &&
        coin.spendableFromBlock > policy.head
      )
        block = Math.max(block ?? 0, coin.spendableFromBlock)
    if (block === undefined) return undefined
    const then = coins
      .selectableAt({ ...query, head: block })
      .reduce((sum, coin) => {
        // A coin worth less than its fee adds nothing; it never takes from the others.
        const part = capacity(coin)
        return part > 0n ? sum + part : sum
      }, 0n)
    return then >= amountWei ? block : undefined
  }

  private dependencyReady(
    coin: EvmListCoin,
    policy: EvmTransactionSetPolicy,
  ): boolean {
    if (!coin.after) return true
    for (const row of this.options.journal.list())
      for (const member of row.members) {
        const tx = Transaction.from(member.unsignedTransaction)
        if (
          member.source.address === coin.after.account &&
          tx.nonce === coin.after.nonce &&
          member.observation.state === 'included-success'
        )
          // The account's own next coin waits the reserve rule's quiet window; a coin another
          // account funded is fresh money and waits until the node judges it (`fundsSettleBlocks`).
          return (
            policy.head >=
            member.observation.blockNumber +
              (coin.after.account === coin.account
                ? (policy.spendRule?.waitBlocks ?? 0)
                : fundsSettleBlocks(policy.spendRule?.waitBlocks))
          )
      }
    return false
  }

  private async prepareSource(
    request: ConstructEvmTransactionSetRequest,
    policy: EvmTransactionSetPolicy,
    context: PaymentContext,
    part: CoinPart,
    paymentIndex: number,
    yielder: CooperativeBatchYielder,
    /** At most this many fresh change outputs: what the operation's fee bound leaves for them. */
    maxChangeOutputs = policy.maxChangeOutputs,
    /** Keep `wei` of the residual as one fresh account of its own (a one-transfer continuation's
     * reserve), when the residual holds it and its transfer; the member is put in `carved`. */
    carve?: { wei: bigint; carved: { member?: LocalMember } },
  ): Promise<LocalMember[]> {
    const { coins, deriveChange } = this.options
    const paymentGas = context.gas
    const paymentFee = paymentGas * policy.gasPriceWei,
      changeFee = policy.changeGasLimit * policy.gasPriceWei
    // The recipient receives exactly what selection assigned to this source. Residual
    // value is never added to the payment: it is split into fresh change accounts when
    // the radix split can carry it, and otherwise stays with the sender on this account's
    // next nonce (settlement projects `balanceAfterWei` as the successor coin).
    const payment = part.paymentValueWei
    const hasPayment = payment > 0n || (request.calldata ?? '0x') !== '0x'
    // Initial selection can also reserve a whole input solely for continuation. Its
    // above-reserve partial capacity never authorizes a first change that drains below
    // the threshold before this source's own quiet window has elapsed.
    const rule = policy.spendRule
    if (!hasPayment && rule?.waitBlocks && part.coin.nonce > 0 &&
        (part.coin.lastSpentInBlock === undefined || policy.head < part.coin.lastSpentInBlock + rule.waitBlocks))
      throw new EvmTransactionSetInsufficientFundsError()
    const residual = part.coin.valueWei - payment - (hasPayment ? paymentFee : 0n)
    const carving = carve !== undefined && residual >= carve.wei + changeFee
    const remainder = carving ? residual - carve!.wei - changeFee : residual
    const destination = context.destination
    // The reserve's account is one of the source's change outputs: the rest is split into the
    // others, so keeping it costs no transfer a large residual would not pay anyway.
    const outputs = this.changeOutputs(policy, remainder, hasPayment ? payment : request.amountWei,
      carving ? Math.min(maxChangeOutputs, policy.maxChangeOutputs - 1) : maxChangeOutputs)
    if (!hasPayment && !outputs.length && !carving) throw new Error('Insufficient private change for continuation')
    type Move = {
      role: 'payment' | 'change'
      logicalIndex: number
      to: string
      value: bigint
      gas: bigint
      data: string
      changeIndex?: number
      carve?: true
    }
    let moves: Move[] = hasPayment ? [
      {
        role: 'payment',
        logicalIndex: paymentIndex,
        to: destination,
        value: payment,
        gas: paymentGas,
        data: request.calldata ?? '0x',
      },
    ] : []
    const planned = outputs.map(value => ({
      role: 'change' as const,
      logicalIndex: 0,
      to: '',
      value,
      gas: policy.changeGasLimit,
      data: '0x',
    }))
    moves.push(...planned)
    if (carving)
      moves.push({ role: 'change', logicalIndex: 0, to: '', value: carve!.wei, gas: policy.changeGasLimit, data: '0x', carve: true })
    for (let index = moves.length - 1; index > 0; index--) {
      const other = Math.floor(this.entropy() * (index + 1))
      ;[moves[index], moves[other]] = [moves[other]!, moves[index]!]
    }
    // The relay/recipient can rebroadcast payment bytes. A below-reserve final drain
    // requiring a quiet window must therefore remain a private, wallet-scheduled change.
    if (policy.spendRule?.waitBlocks && moves.length > 1) {
      let largest = -1
      for (const [index, move] of moves.entries())
        if (
          move.role === 'change' &&
          (largest < 0 || move.value > moves[largest]!.value)
        )
          largest = index
      if (largest >= 0) moves.push(moves.splice(largest, 1)[0]!)
    }
    // Recipient bytes can be broadcast independently. If shuffling would make their
    // execution require a quiet window after our own change, put the payment first.
    // Keep every change movement; its durable predecessor controls delayed execution.
    if (policy.spendRule?.waitBlocks && moves.length > 1) {
      let balance = part.coin.valueWei
      const delayedPayment = moves.some((move, index) => {
        balance -= move.value + move.gas * policy.gasPriceWei
        return move.role === 'payment' && index > 0 && balance < policy.spendRule!.belowWei
      })
      if (delayedPayment) {
        const paymentIndex = moves.findIndex(move => move.role === 'payment')
        moves.unshift(moves.splice(paymentIndex, 1)[0]!)
      }
    }
    // A continuation (the stamp of the message this payment travels in) is paid from this
    // set's own change. Its funding goes to the chain before the relay has the message; the
    // payment (a carried payment) only after the relay stored it. So the change that carries
    // the continuation is signed on this account directly ahead of the payment, at the nonce
    // below it: never behind it, where it could land only after the payment and the message
    // could never be stored. Under a reserve rule this is the account's first move and the
    // payment the next nonce: a payment it leaves below the reserve waits its quiet window
    // after the funding (`predecessorWaitBlocks`), which has passed before the relay can have
    // the message (the continuation's stage waits `fundingWaitBlocks`, one block more). Nothing
    // else of the set comes between the two. The rest of the account's change follows the
    // payment as above.
    const continuation = request.reserveForContinuationWei ?? 0n
    if (hasPayment && continuation > 0n) {
      const paymentAt = moves.findIndex(move => move.role === 'payment')
      const carries = (move: Move) => move.role === 'change' && move.value >= continuation
      // A one-transfer continuation is paid from its carved account; otherwise any change that
      // holds it will do, and one already ahead of the payment needs no move.
      const carrier = request.continuationFeeWei !== undefined
        ? moves.findIndex(move => move.carve === true)
        : moves.slice(0, paymentAt).some(carries) ? -1 : moves.findIndex(carries)
      if (carrier > paymentAt) moves.splice(paymentAt, 0, moves.splice(carrier, 1)[0]!)
    }
    let changeLogicalIndex = 0
    for (const move of moves)
      if (move.role === 'change') {
        const minimumIndex = coins.nextChangeIndex()
        const target = this.options.reserveChange
          ? await this.options.reserveChange(request.operationId, minimumIndex)
          : deriveChange(minimumIndex)
        const index = target.changeIndex
        if (
          !Number.isSafeInteger(index) ||
          index < minimumIndex ||
          index >= 0x80000000 ||
          computeAddress(target.privateKey).toLowerCase() !==
            target.account.toLowerCase() ||
          target.account.toLowerCase() === destination
        )
          throw new Error('Invalid fresh change destination')
        coins.reserveChangeTarget(request.operationId, index, target.account)
        move.to = target.account.toLowerCase()
        move.changeIndex = index
        move.logicalIndex = changeLogicalIndex++
        await yielder.maybeYield()
      }
    let balance = part.coin.valueWei
    const signed: LocalMember[] = []
    for (const [index, move] of moves.entries()) {
      const before = balance
      balance -= move.value + move.gas * policy.gasPriceWei
      const tx = Transaction.from({
        type: 0,
        chainId: BigInt(this.options.journal.binding.nativeChainId),
        nonce: part.coin.nonce + index,
        to: move.to,
        value: move.value,
        data: move.data,
        gasLimit: move.gas,
        gasPrice: policy.gasPriceWei,
      })
      const plan: EvmNativeMemberPlan = {
        source: { kind: 'coin', address: part.coin.account },
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: [],
        transactionSet: {
          role: move.role,
          ...(move.role === 'payment' ? { intendedValueWei: part.paymentValueWei.toString() } : {}),
          logicalIndex: move.logicalIndex,
          ...(move.changeIndex === undefined
            ? {}
            : { changeIndex: move.changeIndex }),
          balanceBeforeWei: before.toString(),
          balanceAfterWei: balance.toString(),
          ...(index > 0 &&
          policy.spendRule?.waitBlocks &&
          balance < policy.spendRule.belowWei
            ? { predecessorWaitBlocks: policy.spendRule.waitBlocks }
            : {}),
          ...(index === moves.length - 1 && !context.feeIsExact
            ? { refundPending: true }
            : {}),
        },
      }
      tx.signature = new SigningKey(part.coin.privateKey).sign(tx.unsignedHash)
      const local = { plan, raw: tx.serialized }
      if (move.carve) carve!.carved.member = local
      signed.push(local)
      // Sources and fresh derivations remain reserved by this operation across host turns.
      // Awaiting cached promises alone cannot let the browser process input or paint.
      await yielder.maybeYield()
    }
    return signed
  }

  private entropy(): number {
    const value = (this.options.random ?? Math.random)()
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new Error('Invalid transaction-set entropy')
    return value
  }

  /** The coin `member` spends, with its key: in the coin list, or (a private change account the
   * same set funds) derived again. Undefined when neither holds it. */
  private sourceOf(row: EvmNativeOperation, member: EvmNativeOperation['members'][number]): EvmListCoin | undefined {
    const source = this.options.coins.all().find(coin => coin.account === member.source.address)
    if (source) return source
    const creator = row.members.find(candidate => candidate.transactionSet?.role !== 'payment' && Transaction.from(candidate.unsignedTransaction).to!.toLowerCase() === member.source.address)
    if (!creator) return undefined
    const key = this.options.deriveChange(creator.transactionSet!.changeIndex!)
    if (key.account.toLowerCase() !== member.source.address) throw new Error('Private source key restoration mismatch')
    return { account: member.source.address, nonce: Transaction.from(member.unsignedTransaction).nonce, privateKey: key.privateKey, origin: 'change', changeIndex: key.changeIndex, valueWei: BigInt(member.transactionSet!.balanceBeforeWei), state: 'unspent' }
  }

  /**
   * A member of a Send to Address set (`legacy-` operation) that the node keeps refusing is
   * signed again at its nonce under the one re-signing rule (`chain/evm-refused-resign.ts`:
   * the same transaction, only the tip one wei lower) and recorded as the member's current
   * signing, durably, before anything hands it to the node; the bytes it replaces stay recorded
   * and are looked for until one of them lands. False, and nothing changes, for any other set
   * (a payment a message carries or a dApp asked for is known to others by its hash) or a member
   * that cannot be signed again.
   */
  resignRefused(operationId: string, memberIndex: number): Promise<boolean> {
    if (!operationId.startsWith('legacy-')) return Promise.resolve(false)
    return this.options.coins.runTransactionSetExclusive(operationId, async () => {
      const row = this.getOperation(operationId)
      const member = row?.members[memberIndex]
      if (!row || row.cancelled || !row.submissionAuthorized || !member?.signed || !member.exposed) return false
      const source = this.sourceOf(row, member)
      if (!source) return false
      let tx: Transaction
      try {
        tx = resignedTransaction(Transaction.from(member.signed.rawTransaction))
      } catch {
        return false
      }
      tx.signature = new SigningKey(source.privateKey).sign(tx.unsignedHash)
      this.restoreRow(await this.options.journal.recordResigned(row.operationId, memberIndex, tx.serialized))
      return true
    })
  }

  private restoreRow(row: EvmNativeOperation): void {
    const logicalId = row.preparationId!.slice(prefix.length)
    const { coins } = this.options
    for (const [index, member] of row.members.entries()) {
      if (!member.signed) continue
      const tx = Transaction.from(member.signed.rawTransaction),
        meta = member.transactionSet!
      if (meta.role !== 'payment')
        coins.reserveChangeTarget(
          logicalId,
          meta.changeIndex!,
          tx.to!.toLowerCase(),
        )
      const source = this.sourceOf(row, member)
      const reconciled = meta.inventoryApplied === true
      if (nativeMemberNeedsOwnMoveRecovery(member) && coins.all().some(coin =>
          coin.account === member.source.address && coin.holder && coin.holder !== logicalId &&
          coin.state !== 'spent'))
        throw new Error('Exposed own move conflicts with another operation reservation')
      // Given up and already taken out of the list: its account was listed again at what the
      // chain showed, and nothing of it is held.
      if (reconciled && nativeMemberAbandoned(member) && !nativeMemberNeedsOwnMoveRecovery(member)) continue
      if (
        !reconciled &&
        (member.observation.state === 'abandoned' ||
          member.observation.state === 'included-success' ||
          member.observation.state === 'included-revert' ||
          (member.observation.state === 'missing' &&
            member.account !== null &&
            member.account.nonce > tx.nonce))
      )
        coins.requireTransactionSetProjection(
          member.source.address,
          `${row.operationId}:${index}`,
        )
      if (!source && reconciled) continue
      if (!source)
        throw new Error('Transaction-set source key restoration required')
      coins.restoreTransactionSetCoin(
        logicalId,
        {
          account: member.source.address,
          nonce: tx.nonce,
          privateKey: source.privateKey,
          origin: source.origin,
          ...(source.lastSpentInBlock === undefined
            ? {}
            : { lastSpentInBlock: source.lastSpentInBlock }),
          ...(source.changeIndex === undefined
            ? {}
            : { changeIndex: source.changeIndex }),
          valueWei: BigInt(meta.balanceBeforeWei),
          state:
            member.observation.state === 'included-success' ||
            member.observation.state === 'included-revert'
              ? 'spent'
              : 'pending_receipt',
          spendingTx: member.signed.rawTransaction,
          ...('blockNumber' in member.observation
            ? { spentInBlock: member.observation.blockNumber }
            : {}),
        },
        !reconciled || nativeMemberNeedsOwnMoveRecovery(member),
      )
      const next = row.members[index + 1]
      if (
        (!next || next.source.address !== member.source.address) &&
        BigInt(meta.balanceAfterWei) > 0n &&
        !meta.refundPending &&
        !reconciled &&
        member.observation.state !== 'included-success' &&
        member.observation.state !== 'included-revert' &&
        (coins.latestOf(source.account)?.nonce ?? 0) <= tx.nonce + 1 &&
        (!coins.get(source.account, tx.nonce + 1) ||
          coins.get(source.account, tx.nonce + 1)?.after !== undefined)
      ) {
        coins.restoreTransactionSetCoin(
          logicalId,
          {
            account: source.account,
            nonce: tx.nonce + 1,
            privateKey: source.privateKey,
            origin: source.origin,
            valueWei: BigInt(meta.balanceAfterWei),
            state: 'unspent',
            after: { account: source.account, nonce: tx.nonce },
            ...(source.changeIndex === undefined
              ? {}
              : { changeIndex: source.changeIndex }),
            ...(meta.remainderSpendableFromBlock === undefined
              ? {}
              : { spendableFromBlock: meta.remainderSpendableFromBlock }),
          },
          false,
        )
      }
    }
  }

  private result(row: EvmNativeOperation, stageId?: string | null): PreparedEvmTransactionSet {
    const entries = row.members.map((member): PreparedEvmTransaction => {
      if (!member.signed) throw new Error('Incomplete signed transaction set')
      const tx = Transaction.from(member.signed.rawTransaction)
      return {
        logicalIndex: member.transactionSet!.logicalIndex,
        sourceAccount: member.source.address,
        nonce: tx.nonce,
        destination: tx.to!.toLowerCase(),
        valueWei: tx.value,
        gasLimit: tx.gasLimit,
        rawTransaction: member.signed.rawTransaction,
        txHash: member.signed.transactionHash,
        ...(member.dependencies.length
          ? {
              predecessor: {
                account: row.members[member.dependencies[0]!]!.source.address,
                nonce: Transaction.from(row.members[member.dependencies[0]!]!.unsignedTransaction).nonce,
              },
            }
          : {}),
      }
    })
    return {
      operationId: row.preparationId!.slice(prefix.length),
      chainIdentifier: row.binding.chainIdentifier,
      bundle: entries
        .filter(
          (_, index) => row.members[index]!.transactionSet!.role === 'payment' && (stageId === null || row.members[index]!.transactionSet!.stageId === stageId),
        )
        .sort((a, b) => a.logicalIndex - b.logicalIndex),
      otherTransactions: entries.filter(
        (_, index) => row.members[index]!.transactionSet!.role !== 'payment' && (stageId === null || row.members[index]!.transactionSet!.stageId === stageId),
      ),
    }
  }
}

/**
 * Runs a construction. When selection had to pass over coins the chain lets be spent only from a
 * later block (on Monad, money that arrived a few blocks ago), waits for that block once,
 * refreshes the wallet's observations and runs the construction again. Nothing is reserved while
 * it waits, so other sends go on meanwhile; a second refusal is the answer.
 */
export async function constructWhenSpendable<T>(
  construct: () => Promise<T>,
  chain: {
    untilBlock(block: number): Promise<unknown>
    refresh(): Promise<void>
  },
): Promise<T> {
  try {
    return await construct()
  } catch (error) {
    if (
      !(error instanceof EvmTransactionSetInsufficientFundsError) ||
      error.spendableFromBlock === undefined
    )
      throw error
    await chain.untilBlock(error.spendableFromBlock)
    await chain.refresh()
    return construct()
  }
}
