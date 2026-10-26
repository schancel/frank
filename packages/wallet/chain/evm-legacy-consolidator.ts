import {
  nativeAdmissionJournal,
  type EvmInputAdmission,
  type WalletOperationLifetime,
  type NativeExecutionJournal,
  type NativeJournalReader,
} from '../evm-input-admission'
import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  Transaction,
  type Provider,
} from 'ethers'
import type { ChainAddress, ChainTransaction } from './chain-wallet'
import {
  NativeTransactionSubmissionError,
  runNativeTransactionExclusive,
} from './chain-wallet'
import type { EvmTransactionBuilder } from './evm-transaction-builder'
import type {
  SwapRecordItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import {
  EvmNativeOperationJournal,
  type EvmContractCallRecord,
  nativeMaximumFee,
  nativeMemberSuperseded,
  type EvmNativeSource,
  type EvmNativePlan,
  type EvmNativeOperation,
  type EvmNativeAccountObservation,
  type EvmNativeObservation,
  type EvmNativeInclusionContradiction,
} from '../storage/evm-native-operation-journal'

/** One call to a contract from the main account, recorded and recovered like a native send. */
export interface ContractCallParams {
  to: ChainAddress
  /** ABI-encoded calldata. A call without calldata is a transfer: use the wallet's `sendLegacy`. */
  data: string
  /** Native value sent with the call; zero for a call that only moves tokens. */
  value: bigint
  /** The gas limit the caller quoted to the user. Estimated here when omitted. */
  gasLimit?: bigint
  /**
   * What this call is (a swap's record). It is written to the journal with the plan, so before
   * anything is signed or broadcast, and once the call is included the sync event carries it:
   * composition sends it in the account's note to itself. The caller records nothing itself.
   */
  record?: EvmContractCallRecord
  /** After signing and before broadcast, so the caller can record the exact operation first. */
  onSigned?: (signed: ContractCallResult) => Promise<void>
  /** While an earlier transaction from the main account is unresolved this call waits its turn;
   * with this it gives up after so many milliseconds, having signed nothing. */
  mainAccountWaitMs?: number
}
export interface ContractCallResult {
  operationId: string
  txHash: string
}
/** Fixed independent terms. No fan-in, dependent funding, or source reselection. */
export interface IndependentPaymentTerms {
  kind: 'native' | 'contract'
  recipient: ChainAddress
  members: readonly {
    sourceAddress: string
    value: bigint
    data?: string
    gasLimit?: bigint
  }[]
}
export interface PreparedIndependentPaymentParams
  extends IndependentPaymentTerms {
  preparationId: string
  /** One ceiling for the entire set, never multiplied by member count. */
  maxNativeFeeWei: bigint
}
export interface EvmLegacyConsolidatorConfig {
  provider: Provider
  journal: NativeJournalReader | EvmNativeOperationJournal
  inputAdmission?: EvmInputAdmission
  runLifetime?: <T>(
    operation: (lifetime: WalletOperationLifetime) => Promise<T>,
  ) => Promise<T>
  transactionBuilder: EvmTransactionBuilder
  /** The main account: contract calls are made from it. */
  mainSource: EvmNativeSource
  /** This wallet's custody reference for an account that can pay a token (main, identity, a
   * received coin), or undefined when the wallet does not own it. */
  ownedSource: (address: string) => EvmNativeSource | undefined
  /** True while another operation of the wallet (a message paying its stamp, a topic burn)
   * holds this source in the wallet's one claim: it is not offered to a plan. */
  sourceHeld?: (source: EvmNativeSource) => boolean
  /** Claims the plan's source accounts in the wallet's one claim, synchronously, or throws when
   * another operation holds one. Returns the release, called once the plan is in the journal. */
  claimSources?: (sources: readonly EvmNativeSource[]) => () => void
  sign: (
    source: EvmNativeSource,
    unsignedTransaction: string,
  ) => Promise<string>
  /** Transport only. The item carries the member's complete signed transaction. When composition
   * wires none, nothing is transported: a locally recorded member stays not sync-applied and the
   * send is not failed for it. A transport that rejects does not fail anything either: the member
   * stays not sync-applied and a later flush sends it again. */
  /** Retryable local completion after durable sync checkpoints; never a delivery receipt. */
  onSyncCheckpoint?: () => Promise<void>
  onSyncTransaction?: (
    item: WalletSyncItem,
    /** The swap this transaction made, when its contract call carried a record. */
    record?: SwapRecordItem,
  ) => Promise<void>
  /** Clock for the re-observation bounds (`reobservePending`), in milliseconds. Defaults to
   * `Date.now`. */
  now?: () => number
  /** Wall-clock budget for one background chain-evidence lookup, not financial finality. */
  reobservationLookupTimeoutMs?: number
  /** Resolves at the wallet's next look at the chain (its one block watcher): what the
   * funds-settle wait below waits on. */
  nextLook?: () => Promise<unknown>
  /** How many blocks back the node looks for the balance a transaction spends (Monad: the
   * spacing + 1, measured: a transfer offered sooner after its account was funded is refused,
   * and those bytes stay refused). With `nextLook`, a member is not handed to the network until
   * its account held what it spends that many blocks ago. Absent or 0: no such rule. */
  fundsSettleBlocks?: number
}
/**
 * The id every frontend of the account derives for a swap: from its chain and the transaction
 * id, hashed exactly as given. A Solana signature is case-sensitive; a caller with an EVM hash
 * passes it in lower case.
 */
export function swapRecordId(
  chainIdentifier: string,
  transactionId: string,
): string {
  return keccak256(
    toUtf8Bytes(`frank-swap:${chainIdentifier}:${transactionId}`),
  ).slice(2)
}

/** The swap-record item of an included contract call that carried a record, else undefined. */
export function swapRecordItemOf(
  row: EvmNativeOperation,
): SwapRecordItem | undefined {
  const signed = row.members[0]?.signed
  const { record } = row
  if (row.kind !== 'contract' || !record || !signed) return undefined
  const asset = (a: EvmContractCallRecord['assetIn']) => ({
    symbol: a.symbol,
    ...(a.address === null ? {} : { address: a.address }),
    decimals: a.decimals,
  })
  const route = JSON.stringify(record.route)
  return {
    type: 'swap-record',
    swapId: swapRecordId(
      row.binding.chainIdentifier,
      signed.transactionHash.toLowerCase(),
    ),
    chainIdentifier: row.binding.chainIdentifier,
    venueId: record.venueId,
    txHash: signed.transactionHash,
    account: record.account,
    assetIn: asset(record.assetIn),
    amountIn: record.amountIn,
    assetOut: asset(record.assetOut),
    quotedAmountOut: record.quotedAmountOut,
    minimumAmountOut: record.minimumAmountOut,
    interfaceFee: record.interfaceFeeAmount,
    networkFee: record.networkFeeWei,
    ...(route !== undefined && route.length <= 1024 ? { route } : {}),
    timestamp: Date.now(),
  }
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
/** A hold the local pass remembers. `basis` is the journal state it was held under. */
/** Re-observation (`reobservePending`): the most receipt probes one pass may make. */
export const REOBSERVE_MAX_PROBES = 8
/** Re-observation: the least time between the end of one evaluation and the next, and the wait
 * after a member's first probe that learned nothing. */
export const REOBSERVE_MIN_INTERVAL_MS = 15_000
/** Re-observation: the longest wait between two probes of one member. */
export const REOBSERVE_MAX_BACKOFF_MS = 600_000
/** One background lookup I/O budget; expiry says nothing about transaction settlement. */
export const REOBSERVE_LOOKUP_TIMEOUT_MS = 30_000
const REOBSERVE_STOPPED = Symbol('re-observation stopped')
/** Convert synchronous provider throws into settled siblings for guarded background reads. */
function evidenceRead<T>(
  read: () => Promise<T>,
  wanted?: () => boolean,
): Promise<T> {
  if (!wanted) return read()
  return Promise.resolve().then(() => {
    if (!wanted()) throw REOBSERVE_STOPPED
    return read()
  })
}
/** Preserve physical single-flight even when one parallel read rejects before its siblings. */
async function settledEvidence<T extends readonly unknown[]>(reads: {
  [K in keyof T]: Promise<T[K]>
}) {
  await Promise.allSettled(reads)
  return Promise.all(reads)
}
interface ReobserveCandidate {
  readonly operationId: string
  readonly index: number
  readonly key: string
}

/** Wallet-lifetime native executor. Journal owns recovery; this module owns dependencies. */
export class EvmLegacyConsolidator {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly independentJobs = new Set<Promise<unknown>>()
  /** Tasks on the executor queue that have not settled: a send or a resume. */
  private queued = 0
  private syncTail: Promise<void> = Promise.resolve()
  /** Transports run one after another, outside the flush that started them. */
  private transportTail: Promise<void> = Promise.resolve()
  /** Members (`operationId:memberIndex`) whose transport has started and not yet settled. */
  private readonly transporting = new Set<string>()
  /** Operations whose last transport in this session failed. In memory on purpose: it is only
   * what a host shows until the next flush tries again; the journal's flag is the record. */
  private readonly transportFailed = new Set<string>()
  private readonly active = new Map<string, Promise<EvmNativeOperation>>()
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
  private reobserveStopped = false
  private readonly reobserveStops = new Set<() => void>()
  private readonly reobserveLookups = new Map<string, Promise<void>>()
  private readonly reobservationLookupTimeoutMs: number
  constructor(private readonly config: EvmLegacyConsolidatorConfig) {
    const timeout =
      config.reobservationLookupTimeoutMs === undefined
        ? REOBSERVE_LOOKUP_TIMEOUT_MS
        : config.reobservationLookupTimeoutMs
    if (
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > 2_147_483_647
    )
      throw new Error('Invalid re-observation lookup timeout')
    this.reobservationLookupTimeoutMs = timeout
  }
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
    await Promise.allSettled([...this.independentJobs])
    await this.syncTail
    await this.transportTail
  }
  /** Whether the last attempt in this session to transport this operation's sync item failed. */
  syncTransportFailed(operationId: string): boolean {
    return this.transportFailed.has(operationId)
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
  private async account(
    address: string,
    wanted?: () => boolean,
  ): Promise<EvmNativeAccountObservation> {
    const { provider } = this.config
    // The balance and the nonce are read at one block, and that block is read again to see it
    // is still the block at its height. On a chain whose newest block is only proposed (Monad:
    // seen on a local chain, a send that needed two accounts failed here on its first read)
    // the newest block is often replaced a moment later: then the read is simply made again.
    for (let attempt = 0; ; attempt++) {
      if (wanted && !wanted()) throw REOBSERVE_STOPPED
      const block = await provider.getBlock('latest')
      if (wanted && !wanted()) throw REOBSERVE_STOPPED
      if (!block?.hash) throw new Error('Native account block unavailable')
      const reads = [
        evidenceRead(() => provider.getBalance(address, block.number), wanted),
        evidenceRead(
          () => provider.getTransactionCount(address, block.number),
          wanted,
        ),
        evidenceRead(() => provider.getBlock(block.number), wanted),
      ] as const
      const [balance, nonce, checked] = await (wanted
        ? settledEvidence(reads)
        : Promise.all(reads))
      if (checked?.hash === block.hash)
        return {
          blockHash: block.hash.toLowerCase(),
          blockNumber: block.number,
          nonce,
          balanceWei: balance.toString(),
        }
      if (attempt >= 5) throw new Error('Native account block changed')
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
    let contradiction: EvmNativeInclusionContradiction | undefined
    try {
      if (
        member.observation.state === 'included-success' ||
        member.observation.state === 'included-revert'
      ) {
        const canonical = await provider.getBlock(
          member.observation.blockNumber,
        )
        const canonicalHash = canonical?.hash?.toLowerCase()
        if (
          canonicalHash &&
          canonical?.number === member.observation.blockNumber &&
          /^0x[0-9a-f]{64}$/.test(canonicalHash) &&
          canonicalHash !== member.observation.blockHash
        )
          contradiction = {
            blockNumber: member.observation.blockNumber,
            orphanedBlockHash: member.observation.blockHash,
            canonicalBlockHash: canonicalHash,
          }
      }
      if (wanted && !wanted()) return
      const expected = Transaction.from(member.signed.rawTransaction)
      const hash = member.signed.transactionHash
      const reads = [
        evidenceRead(() => provider.getTransaction(hash), wanted),
        evidenceRead(() => provider.getTransactionReceipt(hash), wanted),
      ] as const
      let [transaction, receipt] = await (wanted
        ? settledEvidence(reads)
        : Promise.all(reads))
      if (wanted && !wanted()) return
      // Blocks come faster than these reads: a transaction mined between two of them was read
      // unmined by one and mined by the other. That is not an inconsistency of the chain, so
      // the transaction is read again, and the account is read AFTER the receipt (its block is
      // then never behind the receipt's). Without this a mined transfer was recorded `unknown`.
      if (receipt !== null && (transaction === null || !transaction.blockHash))
        transaction = await provider.getTransaction(hash)
      if (wanted && !wanted()) return
      if (receipt === null && transaction?.blockHash)
        receipt = await provider.getTransactionReceipt(hash)
      if (wanted && !wanted()) return
      account = await this.account(member.source.address, wanted)
      if (wanted && !wanted()) return
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
    await journal.recordObservation(
      capture,
      observation,
      account,
      contradiction,
    )
  }
  /** The signed, exposed members spending `address` that the chain has not answered for: not seen in a
   * block (successful or reverted), and the account's nonce not seen past theirs. */
  private unsettledAt(
    address: string,
  ): { operationId: string; index: number }[] {
    const key = address.toLowerCase()
    return this.config.journal.list().flatMap(row =>
      row.cancelled
        ? []
        : row.members.flatMap((member, index) =>
            member.source.address === key &&
            member.signed !== null &&
            // Only bytes already handed to the network may be re-broadcast by lookAtSource.
            // A preparation reserves its source separately, without submission eligibility.
            member.exposed &&
            member.observation.state !== 'included-success' &&
            member.observation.state !== 'included-revert' &&
            // The nonce consumed by another transaction: this one can never land, and the
            // account is at its next nonce either way.
            !(
              member.account !== null &&
              member.account.nonce >
                Transaction.from(member.unsignedTransaction).nonce
            )
              ? [{ operationId: row.operationId, index }]
              : [],
          ),
    )
  }
  /**
   * True while a signed transaction of this journal reserves `address` and the chain has not shown
   * what became of it (mined, or its nonce consumed by another). Journal only: no request. This
   * is what holds the main or identity account in the wallet's one claim after a native send, a
   * contract call or a consolidation returns. An explicitly prepared call holds its source
   * before exposure too; a discarded or cancelled operation holds nothing.
   */
  holdsSource(address: string): boolean {
    try {
      if (this.unsettledAt(address).length > 0) return true
      const key = address.toLowerCase()
      return this.config.journal
        .list()
        .some(
          row =>
            row.submissionPolicy === 'explicit' &&
            !row.cancelled &&
            row.members.some(
              member =>
                member.source.address === key &&
                member.signed !== null &&
                !member.exposed &&
                member.observation.state !== 'included-success' &&
                member.observation.state !== 'included-revert' &&
                !(
                  member.account !== null &&
                  member.account.nonce >
                    Transaction.from(member.unsignedTransaction).nonce
                ),
            ),
        )
    } catch {
      // A journal that cannot be read frees nothing.
      return true
    }
  }
  /** One look at the chain for each exposed unsettled transaction from `address`; one the node
   * does not know is handed to it again (the same bytes). Never rejects: a read that fails
   * records nothing and the account stays held. */
  async lookAtSource(address: string): Promise<void> {
    const pass = async (lifetime?: WalletOperationLifetime) => {
      for (const { operationId, index } of this.unsettledAt(address)) {
        await this.observe(operationId, index, lifetime)
        // The node knows neither the transaction nor a receipt: the same signed bytes are
        // handed to it again, so a lost broadcast cannot hold the account for good.
        const member = this.config.journal.get(operationId).members[index]!
        const key = `${operationId}:${index}`
        if (member.observation.state !== 'missing' || !member.signed) {
          this.missedOnce.delete(key)
          continue
        }
        // Missing twice running: a node asked the moment after a broadcast often does not
        // know the transaction yet, and that is not a lost broadcast.
        if (!this.missedOnce.has(key)) {
          this.missedOnce.add(key)
          continue
        }
        await this.config.provider
          .broadcastTransaction(member.signed.rawTransaction)
          .catch(() => undefined)
      }
    }
    try {
      await (this.config.runLifetime ? this.config.runLifetime(pass) : pass())
    } catch {
      /* Closed, or the chain could not be read: nothing is known, nothing changes. */
    }
  }
  /**
   * The gas limit of a plain transfer to an address the USER entered: the node's estimate for
   * it, made now. The recipient may have code, and then 21,000 is not enough: the transfer is
   * mined, reverted, and (on a chain that charges the gas limit, as Monad does) its whole fee is
   * paid for nothing. A transfer to an account this wallet derives needs no estimate: it is
   * exactly 21,000. When the paying account does not hold the amount yet (it is funded by this
   * same operation first) the estimate is made for one wei. A recipient that refuses the
   * transfer makes this throw: nothing is planned or signed.
   */
  private async recipientGasLimit(
    from: string,
    recipient: string,
    amount: bigint,
  ): Promise<bigint> {
    const { provider } = this.config
    try {
      return await provider.estimateGas({ from, to: recipient, value: amount })
    } catch (error) {
      if (amount <= 1n) throw error
      return provider.estimateGas({ from, to: recipient, value: 1n })
    }
  }
  /** Records the plan. Its source accounts are claimed (synchronously, through the wallet's one
   * claim) from before the journal write until the write is done; from then on the journal row
   * itself keeps every other spender off them. */
  private async reserve(
    lifetime: WalletOperationLifetime | undefined,
    plan: Parameters<
      ReturnType<EvmLegacyConsolidator['journal']>['prepare']
    >[0],
  ): Promise<EvmNativeOperation> {
    const release = this.config.claimSources?.(
      plan.members.map(member => member.source),
    )
    try {
      return await this.journal(lifetime).prepare(plan)
    } finally {
      release?.()
    }
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
    onSigned?: (signed: ChainTransaction) => Promise<void>,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const journal = this.journal(lifetime),
      { provider } = this.config
    let row = journal.get(id)
    if (row.cancelled) throw new Error('Native operation was cancelled')
    row = await this.sign(row, lifetime)
    await onSigned?.(this.transactionHandle(row))
    if (row.kind !== 'legacy' && row.members.length > 1) {
      let failure: unknown
      for (let i = 0; i < row.members.length; i++) {
        try {
          await this.observe(id, i, lifetime)
          const member = journal.get(id).members[i]!
          if (member.observation.state === 'included-success') continue
          if (
            member.observation.state === 'included-revert' ||
            nativeMemberSuperseded(member)
          ) {
            failure ??= new Error(
              'Original independent member consumed; retained for disposition',
            )
            continue
          }
          await this.untilFundsSettled(member)
          await journal.markExposed(id, i)
          const response = await provider.broadcastTransaction(
            member.signed!.rawTransaction,
          )
          if (response.hash.toLowerCase() !== member.signed!.transactionHash)
            throw new Error('Unexpected independent transaction hash')
        } catch (reason) {
          failure ??= reason
        }
      }
      if (failure !== undefined)
        throw new EvmNativeOperationPendingError(journal.get(id), failure)
      return journal.get(id)
    }
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
        await this.untilFundsSettled(member)
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
        // A transfer or a contract call is one transaction: once handed to the network the
        // journal holds it, and the caller watches for its inclusion.
        return journal.get(id)
      }
    }
    return journal.get(id)
  }
  /**
   * Before a member is handed to the network: waits, at the block watcher's looks, until its
   * account already held what the member spends `fundsSettleBlocks` blocks ago. The transfer
   * that pays the recipient out of an account this same operation has just funded is the case:
   * offered at once it was refused by the node and never sent (seen on Monad testnet: the
   * funding transfer mined, the payment unknown to the node eight minutes later). Gives up
   * waiting after 30 looks and hands it over as it is. Never throws.
   */
  private async untilFundsSettled(member: {
    source: EvmNativeSource
    unsignedTransaction: string
  }): Promise<void> {
    const { nextLook, fundsSettleBlocks, provider } = this.config
    if (!nextLook || !fundsSettleBlocks) return
    try {
      const tx = Transaction.from(member.unsignedTransaction)
      const needed = tx.value + nativeMaximumFee(tx)
      for (let looks = 0; looks < 30 && !this.reobserveStopped; looks++) {
        const head = await provider.getBlockNumber()
        if (head < fundsSettleBlocks) return
        if (
          (await provider.getBalance(
            member.source.address,
            head - fundsSettleBlocks,
          )) >= needed
        )
          return
        await nextLook()
      }
    } catch {
      /* A node that cannot answer for an earlier block is not waited on. */
    }
  }
  /**
   * One look at the chain for each transaction of one operation that was handed to the network
   * and is not yet seen in a block; one the node does not know on two looks running is handed
   * to it again (the same bytes). What a host calls, at each look of the block watcher, while
   * it shows a transfer that is not final. Never rejects: a read that fails records nothing.
   */
  async lookAtOperation(operationId: string): Promise<void> {
    const pass = async (lifetime?: WalletOperationLifetime) => {
      const row = this.config.journal.get(operationId)
      if (row.cancelled) return
      for (let index = 0; index < row.members.length; index++) {
        const before = this.config.journal.get(operationId).members[index]!
        if (
          !before.signed ||
          !before.exposed ||
          before.observation.state === 'included-success' ||
          before.observation.state === 'included-revert'
        )
          continue
        await this.observe(
          operationId,
          index,
          lifetime,
          () => !this.reobserveStopped,
        )
        const member = this.config.journal.get(operationId).members[index]!
        const key = `${operationId}:${index}`
        if (member.observation.state !== 'missing' || !member.signed) {
          this.missedOnce.delete(key)
          continue
        }
        if (!this.missedOnce.has(key)) {
          this.missedOnce.add(key)
          continue
        }
        await this.config.provider
          .broadcastTransaction(member.signed.rawTransaction)
          .catch(() => undefined)
      }
    }
    try {
      if (this.reobserveStopped) return
      await (this.config.runLifetime ? this.config.runLifetime(pass) : pass())
    } catch {
      /* Closed, or the chain could not be read: nothing is known, nothing changes. */
    }
  }
  /**
   * Cancels an operation when the journal says no member of it was ever signed or exposed: a
   * plan that failed before its first signature. Such a plan can never land, yet while it stands
   * it holds its source account, the main account included, for every later operation. The journal's own rule decides (`cancelUnsigned` refuses anything
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
  /** Ends a contract call that was signed and never exposed. Never throws. */
  private async discardIfUnexposed(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    try {
      const row = this.config.journal.get(operationId)
      if (
        row.kind === 'contract' &&
        row.submissionPolicy !== 'explicit' &&
        !row.cancelled &&
        row.members.some(m => m.signed) &&
        !row.members.some(m => m.exposed)
      )
        await this.journal(lifetime).discardUnexposed(operationId)
    } catch {
      /* Left as it was: the next wallet open ends it. */
    }
  }
  /**
   * Wallet open: cancels every operation no member of which was ever signed or exposed (a crash
   * or failure between `prepare` and the first signature), and ends every contract call that was
   * signed but never exposed, except an explicitly prepared call. An ordinary call interrupted
   * between its signature and broadcast may not have kept its record, so it must not be sent
   * later. Local only: it reads and writes the
   * journal, makes no network request, asks for no signature, and never throws.
   */
  cancelUnsignedOperations(lifetime?: WalletOperationLifetime): Promise<void> {
    return this.run(async () => {
      try {
        for (const row of this.config.journal.list()) {
          await this.discardIfUnexposed(row.operationId, lifetime)
          await this.cancelIfNeverSigned(
            () => this.config.journal.get(row.operationId),
            lifetime,
          )
        }
      } catch {
        /* An unreadable journal cancels nothing. */
      }
    })
  }
  private now(): number {
    return (this.config.now ?? Date.now)()
  }
  /** The members worth looking up now, from the journal's memory alone: at most
   * `REOBSERVE_MAX_PROBES`, oldest first, starting after the member probed last. */
  private reobserveDue(now: number): ReobserveCandidate[] {
    const candidates: ReobserveCandidate[] = []
    for (const row of this.config.journal.list()) {
      if (row.cancelled || row.kind === 'transaction-set') continue
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
        if (this.reobserveLookups.has(candidate.key)) return false
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
      let active = true
      let observationStarted = false
      let skippedForQueue = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let stop!: () => void
      const expired = new Promise<void>(resolve => {
        stop = () => {
          active = false
          resolve()
        }
        this.reobserveStops.add(stop)
        timer = setTimeout(stop, this.reobservationLookupTimeoutMs)
      })
      const wanted = () => active && !this.reobserveStopped
      // Retain physical work until the provider settles. A timeout frees this pass, but never
      // starts another unresolved provider chain for the same member.
      const work = (async () => {
        try {
          const receipt = await provider.getTransactionReceipt(
            member.signed!.transactionHash,
          )
          // A send or estimate may have finalized this member during the probe. Leave its
          // evidence intact; queued sends own their captures and must not be superseded here.
          if (!wanted() || receipt == null || !this.reobservable(candidate))
            return
          if (this.queued > 0) {
            skippedForQueue = true
            return
          }
          observationStarted = true
          await this.observe(
            candidate.operationId,
            candidate.index,
            lifetime,
            wanted,
          )
        } catch {
          /* Unavailable evidence leaves the original operation and its claims intact. */
        }
      })()
      this.reobserveLookups.set(candidate.key, work)
      void work.finally(() => {
        this.reobserveLookups.delete(candidate.key)
      })
      try {
        await Promise.race([work, expired])
      } finally {
        active = false
        clearTimeout(timer)
        this.reobserveStops.delete(stop)
      }
      if (this.reobserveStopped) return
      if (skippedForQueue) continue
      if (!observationStarted && !this.reobservable(candidate)) {
        this.reobserveBackoff.delete(candidate.key)
        continue
      }
      const state = journal.get(candidate.operationId).members[candidate.index]!
        .observation.state
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
   * outside the wallet queue, so a slow node never delays a send. The observation it records
   * stays in the journal for the next send, flush or open.
   *
   * It never signs, broadcasts, resubmits, replaces or cancels, never marks a member dropped and
   * has no settlement timeout: a member that never lands stays pending and reserved. Each
   * background evidence lookup has a finite I/O budget; an unanswered physical lookup suppresses
   * further probes of that member until it settles. It never rejects.
   */
  async reobservePending(): Promise<void> {
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
   * operation it names when that operation never signed. That cannot change what `body`
   * returned or threw. */
  private runCancellingUnsigned<T>(
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
      }
    })
  }
  /** Composition invokes this outside its financial queue; transport may itself need admission.
   * Transport only: a member is sent, and then marked sync-applied, only when this session's local
   * pass recorded it applied. Resolves when the transports it started have settled. A transport
   * that fails rejects nothing: its member stays not sync-applied for a later flush. */
  flushSync(operationId?: string): Promise<void> {
    return this.startSync(operationId).then(
      started => started.transported,
      async reason => {
        await this.transportTail
        throw reason
      },
    )
  }
  /** As `flushSync`, but resolves as soon as the local check is done, with the transports started
   * and not waited for: `transported` settles (never rejects) when they have. */
  startSync(operationId?: string): Promise<{ transported: Promise<void> }> {
    const run = this.syncTail.then(() =>
      this.config.runLifetime
        ? this.config.runLifetime(lifetime =>
            this.applySync(operationId, lifetime),
          )
        : this.applySync(operationId),
    )
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  private async applySync(
    operationId?: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<{ transported: Promise<void> }> {
    const journal = this.journal(lifetime)
    // With no transport wired there is nothing to send.
    if (!this.config.onSyncTransaction)
      return { transported: Promise.resolve() }
    // The first transaction set, in journal order, whose inventory projection has not applied a
    // member yet. A contract call or token payment has no local record to wait for: the coin
    // list learns its source account's next nonce from the chain.
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
          !member.syncApplied
        ) {
          if (
            row.kind === 'transaction-set' &&
            member.transactionSet?.inventoryApplied !== true
          ) {
            unapplied ??= id
            continue
          }
          const tx = Transaction.from(member.signed!.rawTransaction)
          this.transport(
            id,
            i,
            {
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
                    tx.value + BigInt(member.observation.feeWei)
                  ).toString(),
                },
              ],
              createdOutputs: [
                { address: tx.to!, valueWei: tx.value.toString() },
              ],
              timestamp: Date.now(),
            },
            swapRecordItemOf(row),
          )
        }
      }
    if (unapplied !== undefined)
      throw new EvmNativeOperationPendingError(
        journal.get(unapplied),
        new Error('Native member has no local spend record in this session'),
      )
    // Also retries a crash/failure between the durable sync mark and archival.
    await this.config.onSyncCheckpoint?.()
    for (const id of this.transportFailed) {
      const row = journal.list().find(candidate => candidate.operationId === id)
      if (!row || row.members.every(member => member.observation.state !== 'included-success' || member.syncApplied))
        this.transportFailed.delete(id)
    }
    return { transported: this.transportTail }
  }
  /** Queues one member's transport, once while it is under way. Delivered: the member is marked
   * sync-applied. Failed, or the wallet closed meanwhile: it is left as it was and remembered as
   * failed for this session. Never rejects and never touches the payment's own outcome. */
  private transport(
    operationId: string,
    memberIndex: number,
    item: WalletSyncItem,
    record?: SwapRecordItem,
  ): void {
    const key = `${operationId}:${memberIndex}`
    if (this.transporting.has(key)) return
    this.transporting.add(key)
    const mark = (lifetime?: WalletOperationLifetime) =>
      this.journal(lifetime).markSyncApplied(operationId, memberIndex)
    this.transportTail = this.transportTail
      .then(async () => {
        await this.config.onSyncTransaction!(item, record)
        await (this.config.runLifetime
          ? this.config.runLifetime(lifetime => mark(lifetime))
          : mark())
        await this.config.onSyncCheckpoint?.()
        this.transportFailed.delete(operationId)
      })
      .catch(() => {
        this.transportFailed.add(operationId)
      })
      .finally(() => {
        this.transporting.delete(key)
      })
  }
  resumeOperation(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const row = this.config.journal.get(operationId)
    if (row.kind !== 'legacy' && row.members.length > 1)
      return this.resumeIndependentPayment(operationId, lifetime)
    const existing = this.active.get(operationId)
    if (existing) return existing
    const run = this.runCancellingUnsigned(lifetime, planned => {
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
  /** Cancels a signed operation whose bytes were handed to nobody, freeing its source. The
   * journal refuses if any member was exposed. */
  releaseUnexposed(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    return this.run(() => this.journal(lifetime).discardUnexposed(operationId))
  }
  private contractResendAt = new Map<string, { at: number; waitMs: number }>()
  private readonly missedOnce = new Set<string>()
  /**
   * Drives an exposed contract call that is not yet in a block. Each due call is first looked
   * at once (`observe`: recorded `missing` when the node knows neither the transaction nor a
   * receipt, `pending` when it holds it, included when it landed). One recorded `missing` is
   * then handed back to the network: the same signed bytes, never a new transaction. Without
   * this a call whose broadcast was lost, or that the node dropped, would hold its account's
   * nonce with nothing driving it to an end.
   *
   * Bounds: one invocation handles at most `REOBSERVE_MAX_PROBES` calls, and a given call is
   * handled at most once per wait, which starts at `REOBSERVE_MIN_INTERVAL_MS` and doubles to
   * `REOBSERVE_MAX_BACKOFF_MS`. There is no limit on how many times in total a call is re-sent:
   * it is re-sent, ever more rarely, until the chain shows it. Never rejects.
   */
  async resendMissingContractCalls(): Promise<void> {
    const pass = async (lifetime?: WalletOperationLifetime) => {
      const now = this.now()
      let handled = 0
      for (const listed of this.config.journal.list()) {
        if (listed.kind !== 'contract' || listed.cancelled) continue
        for (let index = 0; index < listed.members.length; index++) {
          if (this.reobserveStopped || handled >= REOBSERVE_MAX_PROBES) return
          const key = `${listed.operationId}:${index}`
          const member = listed.members[index]!
          if (
            !member.signed ||
            !member.exposed ||
            'transactionHash' in member.observation ||
            nativeMemberSuperseded(member)
          ) {
            this.contractResendAt.delete(key)
            continue
          }
          const last = this.contractResendAt.get(key)
          if (last && now >= last.at && now - last.at < last.waitMs) continue
          handled++
          this.contractResendAt.set(key, {
            at: now,
            waitMs: last
              ? Math.min(last.waitMs * 2, REOBSERVE_MAX_BACKOFF_MS)
              : REOBSERVE_MIN_INTERVAL_MS,
          })
          await this.observe(
            listed.operationId,
            index,
            lifetime,
            () => !this.reobserveStopped,
          )
          const observed = this.config.journal.get(listed.operationId).members[
            index
          ]!
          if (
            !this.reobserveStopped &&
            observed.observation.state === 'missing' &&
            observed.signed &&
            !nativeMemberSuperseded(observed)
          )
            await this.config.provider
              .broadcastTransaction(observed.signed.rawTransaction)
              .catch(() => undefined)
        }
      }
    }
    try {
      if (this.reobserveStopped) return
      await (this.config.runLifetime ? this.config.runLifetime(pass) : pass())
    } catch {
      /* A closed journal or an ended lifetime ends the pass. */
    }
  }
  /** Contract calls that were broadcast and are not yet seen in a block, oldest first. */
  unresolvedContractCalls(): ContractCallResult[] {
    return this.listOperations().flatMap(row =>
      row.kind !== 'contract' || row.cancelled
        ? []
        : row.members.flatMap(member =>
            member.signed &&
            member.exposed &&
            !('transactionHash' in member.observation) &&
            !nativeMemberSuperseded(member)
              ? [
                  {
                    operationId: row.operationId,
                    txHash: member.signed.transactionHash,
                  },
                ]
              : [],
          ),
    )
  }
  /** The main account at its next nonce, when nothing of this journal or another owner holds
   * it. Signed transactions from it are looked at first, so a call that landed frees it. */
  /** Looks once at every signed member that spends from the main account and is not yet in a
   * block, so `holdsSource` answers from what the chain says now (a lost call that landed, a
   * nonce another transaction took). On the executor queue; signs and submits nothing. */
  observeMainAccount(lifetime?: WalletOperationLifetime): Promise<void> {
    return this.run(() => this.observeMain(lifetime))
  }
  private async observeMain(lifetime?: WalletOperationLifetime): Promise<void> {
    const main = this.config.mainSource
    const journal = this.journal(lifetime)
    for (const row of journal.list())
      if (!row.cancelled)
        for (let i = 0; i < row.members.length; i++) {
          const member = row.members[i]!
          if (
            member.signed &&
            member.source.address === main.address &&
            member.observation.state !== 'included-success' &&
            member.observation.state !== 'included-revert'
          )
            await this.observe(row.operationId, i, lifetime)
        }
  }
  private async mainAccount(
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeAccountObservation | undefined> {
    const main = this.config.mainSource
    const journal = this.journal(lifetime)
    await this.observeMain(lifetime)
    if (this.config.sourceHeld?.(main)) return undefined
    const account = await this.account(main.address)
    return journal.canSelect(main.address, account.nonce) ? account : undefined
  }
  /** One call from the main account: it makes contract calls and holds the tokens they move. */
  private async planContractCall(
    params: ContractCallParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const to = getAddress(params.to.raw).toLowerCase()
    if (params.value < 0n)
      throw new RangeError('Call value must not be negative')
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(params.data))
      throw new Error('A contract call needs calldata')
    if (this.config.transactionBuilder.supportsNativeConsolidation !== true)
      throw new Error('Contract calls are unavailable on this network')
    const main = this.config.mainSource
    const account = await this.mainAccount(lifetime)
    // Absent while an earlier transaction of its own is unresolved.
    if (!account || BigInt(account.balanceWei) === 0n)
      throw new RangeError('Insufficient unreserved native funds')
    const fee = await this.config.provider.getFeeData()
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice
    if (maxFeePerGas == null) throw new Error('Native fee quote unavailable')
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? maxFeePerGas
    if (maxPriorityFeePerGas > maxFeePerGas)
      throw new Error('Invalid native fee quote')
    const data = params.data.toLowerCase()
    const gasLimit =
      params.gasLimit ??
      ((await this.config.provider.estimateGas({
        from: main.address,
        to,
        data,
        value: params.value,
      })) *
        115n) /
        100n
    if (BigInt(account.balanceWei) < params.value + gasLimit * maxFeePerGas)
      throw new RangeError('Insufficient unreserved native funds')
    return this.journal(lifetime).prepare({
      kind: 'contract',
      recipient: to,
      intendedValueWei: params.value.toString(),
      ...(params.record ? { record: params.record } : {}),
      members: [
        {
          source: main,
          unsignedTransaction: Transaction.from({
            type: 2,
            to,
            chainId: BigInt(this.config.journal.binding.nativeChainId),
            nonce: account.nonce,
            value: params.value,
            data,
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
          }).unsignedSerialized,
          dependencies: [],
        },
      ],
    })
  }
  private independentTerms(
    params: IndependentPaymentTerms,
  ): IndependentPaymentTerms {
    if (params.kind !== 'native' && params.kind !== 'contract')
      throw new Error('Unsupported independent payment kind')
    if (!params.members.length || params.members.length > 16)
      throw new RangeError('Independent payment requires 1..16 members')
    const recipient = {
      ...params.recipient,
      raw: getAddress(params.recipient.raw).toLowerCase(),
    }
    const seen = new Set<string>()
    const members = params.members.map(member => {
      const sourceAddress = getAddress(member.sourceAddress).toLowerCase()
      if (seen.has(sourceAddress))
        throw new Error('Duplicate independent source')
      seen.add(sourceAddress)
      const data = (member.data ?? '0x').toLowerCase()
      if (
        params.kind === 'native'
          ? member.value <= 0n || data !== '0x'
          : member.value !== 0n || !/^0x(?:[0-9a-f]{2})+$/.test(data)
      )
        throw new Error('Invalid independent payment terms')
      if (member.gasLimit !== undefined && member.gasLimit <= 0n)
        throw new Error('Invalid independent gas limit')
      return { ...member, sourceAddress, data }
    })
    return { kind: params.kind, recipient, members }
  }
  private async independentPlan(
    terms: IndependentPaymentTerms,
    lifetime?: WalletOperationLifetime,
  ): Promise<{
    plan: EvmNativePlan
    sources: {
      sourceAddress: string
      nativeBalanceAtomic: bigint
      estimatedNativeFeeAtomic: bigint
    }[]
  }> {
    if (this.config.transactionBuilder.supportsNativeConsolidation !== true)
      throw new Error('Independent payments unavailable on this network')
    const fee = await this.config.provider.getFeeData()
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? maxFeePerGas
    if (
      maxFeePerGas == null ||
      maxPriorityFeePerGas == null ||
      maxFeePerGas < 0n ||
      maxPriorityFeePerGas < 0n ||
      maxPriorityFeePerGas > maxFeePerGas
    )
      throw new Error('Invalid independent fee quote')
    const members: EvmNativePlan['members'] = []
    const sources: {
      sourceAddress: string
      nativeBalanceAtomic: bigint
      estimatedNativeFeeAtomic: bigint
    }[] = []
    for (const term of terms.members) {
      const source = this.config.ownedSource(term.sourceAddress)
      if (!source)
        throw new Error('Independent source is not owned by this wallet')
      const account = await this.account(source.address)
      if (
        this.config.sourceHeld?.(source) ||
        !this.journal(lifetime).canSelect(source.address, account.nonce)
      )
        throw new Error('Independent source is reserved')
      const gasLimit =
        term.gasLimit ??
        (terms.kind === 'native'
          ? await this.recipientGasLimit(
              source.address,
              terms.recipient.raw,
              term.value,
            )
          : ((await this.config.provider.estimateGas({
              from: source.address,
              to: terms.recipient.raw,
              data: term.data,
              value: 0n,
            })) *
              115n) /
            100n)
      const tx = Transaction.from({
        type: 2,
        chainId: BigInt(this.config.journal.binding.nativeChainId),
        nonce: account.nonce,
        to: terms.recipient.raw,
        value: term.value,
        data: term.data ?? '0x',
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      members.push({
        source,
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: [],
      })
      sources.push({
        sourceAddress: source.address,
        nativeBalanceAtomic: BigInt(account.balanceWei),
        estimatedNativeFeeAtomic: nativeMaximumFee(tx),
      })
    }
    return {
      plan: {
        kind: terms.kind,
        ...(terms.kind === 'contract'
          ? { submissionPolicy: 'explicit' as const }
          : {}),
        recipient: terms.recipient.raw,
        intendedValueWei: terms.members
          .reduce((sum, m) => sum + m.value, 0n)
          .toString(),
        members,
      },
      sources,
    }
  }
  /** Read-only fixed-source facts, including a truthful insufficient gas balance. */
  async quoteIndependentPayment(
    params: IndependentPaymentTerms,
    lifetime?: WalletOperationLifetime,
  ) {
    const { sources } = await this.independentPlan(
      this.independentTerms(params),
      lifetime,
    )
    return {
      sources,
      estimatedNativeFeeAtomic: sources.reduce(
        (sum, source) => sum + source.estimatedNativeFeeAtomic,
        0n,
      ),
    }
  }
  private independentLock<T>(
    identity: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const run = runNativeTransactionExclusive(
      JSON.stringify([
        'evm-independent-payment',
        this.config.journal.binding,
        identity,
      ]),
      'single-realm',
      body,
    )
    this.independentJobs.add(run)
    void run
      .finally(() => this.independentJobs.delete(run))
      .catch(() => undefined)
    return run
  }
  /** Whole-set reservation precedes the first signature. Reopen completes the original plan. */
  signIndependentPayment(
    params: PreparedIndependentPaymentParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    const terms = this.independentTerms(params)
    if (
      !/^stealth-payment:[a-zA-Z0-9_-]{1,128}$/.test(params.preparationId) ||
      params.maxNativeFeeWei < 0n
    )
      throw new Error('Invalid independent authorization')
    const preparationId = params.preparationId,
      ceiling = params.maxNativeFeeWei
    return this.independentLock('prepare:' + preparationId, async () => {
      let row = await this.journal(lifetime).refreshPreparation(preparationId)
      if (row) {
        if (
          row.cancelled ||
          row.kind !== terms.kind ||
          row.recipient !== terms.recipient.raw ||
          row.members.length !== terms.members.length ||
          BigInt(row.maximumFeeWei) > ceiling ||
          (row.kind === 'contract' && row.submissionPolicy !== 'explicit')
        )
          throw new Error(
            'Independent preparation conflicts with original authorization',
          )
        for (let i = 0; i < terms.members.length; i++) {
          const term = terms.members[i]!,
            member = row.members[i]!,
            tx = Transaction.from(member.unsignedTransaction)
          if (
            member.source.address !== term.sourceAddress ||
            tx.value !== term.value ||
            tx.data !== term.data ||
            member.dependencies.length ||
            (term.gasLimit !== undefined && tx.gasLimit !== term.gasLimit)
          )
            throw new Error(
              'Independent preparation conflicts with original authorization',
            )
        }
      } else {
        const { plan, sources } = await this.independentPlan(terms, lifetime)
        if (
          sources.reduce(
            (sum, source) => sum + source.estimatedNativeFeeAtomic,
            0n,
          ) > ceiling
        )
          throw new RangeError(
            'Independent total fee exceeds authorized ceiling',
          )
        if (
          sources.some(
            (source, i) =>
              source.nativeBalanceAtomic <
              terms.members[i]!.value + source.estimatedNativeFeeAtomic,
          )
        )
          throw new RangeError('Insufficient independent native funds')
        row = await this.reserve(lifetime, { ...plan, preparationId })
      }
      return await this.sign(row, lifetime)
    })
  }
  /** Each sibling is independent; one uncertain submission cannot suppress the others. */
  resumeIndependentPayment(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    return this.independentLock('submit:' + operationId, async () => {
      const row = this.journal(lifetime).get(operationId)
      if (
        row.kind === 'legacy' ||
        row.members.some(member => member.dependencies.length)
      )
        throw new Error('Operation is not an independent payment')
      return await this.execute(operationId, undefined, lifetime)
    })
  }
  /**
   * Signs and submits one contract call from the main account through the same journal a native
   * send uses: the operation is written before it is signed, the signed bytes before they are
   * broadcast, and `resumeOperation` re-submits those same bytes. It returns once the call is
   * handed to the network; inclusion (or a revert) is observed afterwards.
   */
  sendContractCall(
    params: ContractCallParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<ContractCallResult> {
    params = { ...params, to: { ...params.to } }
    return this.runCancellingUnsigned(lifetime, async planned => {
      const row = await this.planContractCall(params, lifetime)
      planned(row.operationId)
      let done: EvmNativeOperation
      try {
        done = await this.execute(
          row.operationId,
          signed =>
            params.onSigned?.({
              operationId: row.operationId,
              txHash: signed.txHash,
            }) ?? Promise.resolve(),
          lifetime,
        )
      } catch (error) {
        // Signed but never handed to the network (the caller could not record it, or signing
        // itself stopped): the call is ended here, so it can never be sent later without its
        // record, and the account is free at once.
        await this.discardIfUnexposed(row.operationId, lifetime)
        throw error
      }
      return {
        operationId: row.operationId,
        txHash: done.members[0]!.signed!.transactionHash,
      }
    })
  }
}
