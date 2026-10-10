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
  keccak256,
  toUtf8Bytes,
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
import type {
  SwapRecordItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import {
  EvmNativeOperationJournal,
  type EvmContractCallRecord,
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
  /**
   * The main account is one coin: while an earlier payment from it has not been seen on chain
   * this send waits its turn. By default it waits however long that takes; with this, it gives
   * up after so many milliseconds, having signed nothing.
   */
  mainAccountWaitMs?: number
}
/** One call to a contract from the main account, recorded and recovered like a native send. */
export interface ContractCallParams {
  to: ChainAddress
  /** ABI-encoded calldata. A call without calldata is a transfer: use `sendNative`. */
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
  /** As `SendLegacyParams.mainAccountWaitMs`. */
  mainAccountWaitMs?: number
}
export interface ContractCallResult {
  operationId: string
  txHash: string
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
  /** Transport only. The item carries the member's complete signed transaction. When composition
   * wires none, nothing is transported: a locally recorded member stays not sync-applied and the
   * send is not failed for it. A transport that rejects does not fail anything either: the member
   * stays not sync-applied and a later flush sends it again. */
  onSyncTransaction?: (
    item: WalletSyncItem,
    /** The swap this transaction made, when its contract call carried a record. */
    record?: SwapRecordItem,
  ) => Promise<void>
  /** Clock for the re-observation bounds (`reobservePending`), in milliseconds. Defaults to
   * `Date.now`. */
  now?: () => number
  /** Resolves at the wallet's next look at the chain (its one block watcher). With it, a
   * transfer that was just broadcast is watched until the chain shows it in a block, for at most
   * `inclusionWaitMs`. Without it (an executor on its own) the transfer is looked at once. */
  nextLook?: () => Promise<unknown>
  /** How long a send watches its own broadcast transfer for a block. Default 30 s. After it
   * the transfer stays in the journal, holding its account, and is watched from outside
   * (`lookAtOperation`). */
  inclusionWaitMs?: number
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
  /** Transports run one after another, outside the flush that started them. */
  private transportTail: Promise<void> = Promise.resolve()
  /** Members (`operationId:memberIndex`) whose transport has started and not yet settled. */
  private readonly transporting = new Set<string>()
  /** Operations whose last transport in this session failed. In memory on purpose: it is only
   * what a host shows until the next flush tries again; the journal's flag is the record. */
  private readonly transportFailed = new Set<string>()
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
      const hash = member.signed.transactionHash
      let [transaction, receipt] = await Promise.all([
        provider.getTransaction(hash),
        provider.getTransactionReceipt(hash),
      ])
      // Blocks come faster than these reads: a transaction mined between two of them was read
      // unmined by one and mined by the other. That is not an inconsistency of the chain, so
      // the transaction is read again, and the account is read AFTER the receipt (its block is
      // then never behind the receipt's). Without this a mined transfer was recorded `unknown`.
      if (receipt !== null && (transaction === null || !transaction.blockHash))
        transaction = await provider.getTransaction(hash)
      if (receipt === null && transaction?.blockHash)
        receipt = await provider.getTransactionReceipt(hash)
      account = await this.account(member.source.address)
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
            // Bytes that never left this device cannot land: only a member handed to the
            // network holds its account.
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
   * True while a signed transaction of this journal spends `address` and the chain has not shown
   * what became of it (mined, or its nonce consumed by another). Journal only: no request. This
   * is what holds the main or identity account in the wallet's one claim after a native send, a
   * contract call or a consolidation returns; a discarded or cancelled operation holds nothing.
   */
  holdsSource(address: string): boolean {
    try {
      return this.unsettledAt(address).length > 0
    } catch {
      // A journal that cannot be read frees nothing.
      return true
    }
  }
  /** One look at the chain for each transaction `holdsSource(address)` is true for; one the node
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
      if (this.config.sourceHeld?.(source)) continue
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
  private async transaction(
    source: AvailableSource,
    recipient: string,
    amount: bigint,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    /** The recipient is the address the user entered, not an account of this wallet. */
    toUserAddress = false,
  ): Promise<string> {
    const request = await this.config.transactionBuilder.buildTransfer({
      from: source.source.address,
      recipient,
      amount,
      overrides: {
        nonce: source.account.nonce,
        ...fees,
        ...(toUserAddress &&
        this.config.transactionBuilder.supportsNativeConsolidation === true
          ? {
              gasLimit: await this.recipientGasLimit(
                source.source.address,
                recipient,
                amount,
              ),
            }
          : {}),
      },
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
    /** An address that must not pay: the account a consolidation is funding. */
    excludedSource?: string,
  ): Promise<EvmNativeOperation> {
    const recipient = getAddress(params.recipient.raw).toLowerCase()
    if (params.value <= 0n)
      throw new RangeError('Transfer value must be positive')
    if (
      kind === 'legacy' &&
      this.config.transactionBuilder.supportsNativeConsolidation !== true
    )
      throw new Error('Builder does not support native consolidation')
    const accounts = (await this.sources(lifetime)).filter(
      account => account.source.address !== excludedSource,
    )
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
      const raw = await this.transaction(
        account,
        recipient,
        params.value,
        fees,
        excludedSource === undefined,
      )
      const tx = Transaction.from(raw)
      const maximumFee = nativeMaximumFee(tx)
      if (
        this.config.transactionBuilder.feeAsset === 'transfer'
          ? BigInt(account.account.balanceWei) < tx.value ||
            account.spendableValue < params.value + maximumFee
          : BigInt(account.account.balanceWei) < tx.value + maximumFee
      )
        continue
      return this.reserve(lifetime, {
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
    const drain = await this.transaction(
      leader,
      recipient,
      params.value,
      fees,
      excludedSource === undefined,
    )
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
    return this.reserve(lifetime, {
      kind,
      recipient,
      intendedValueWei: params.value.toString(),
      members,
    })
  }
  /** Records the plan. Its source accounts are claimed (synchronously, through the wallet's one
   * claim) from before the journal write until the write is done; from then on the journal row
   * itself keeps every other spender off them. */
  private async reserve(
    lifetime: WalletOperationLifetime | undefined,
    plan: Parameters<ReturnType<EvmLegacyConsolidator['journal']>['prepare']>[0],
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
        if (row.kind !== 'legacy') return journal.get(id)
        await this.watchForInclusion(id, i, lifetime)
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
   * After a member was handed to the network: looks at it now and at each look of the wallet's
   * block watcher until the chain shows it in a block (succeeded or reverted), for at most
   * `inclusionWaitMs`. A transfer the node does not know on two looks running is handed to it
   * again, the same bytes. Returns with whatever was last recorded; the caller decides on that.
   * A node asked the instant after a broadcast answers "pending" or "not known" for a transfer
   * that is mined a block later: one look was not enough to learn that it was sent.
   */
  private async watchForInclusion(
    id: string,
    index: number,
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    const { nextLook } = this.config
    const until =
      Date.now() + (nextLook ? this.config.inclusionWaitMs ?? 30_000 : 0)
    let missed = false
    for (;;) {
      await this.observe(id, index, lifetime)
      const member = this.config.journal.get(id).members[index]!
      const state = member.observation.state
      if (state === 'included-success' || state === 'included-revert') return
      if (!nextLook || this.reobserveStopped || Date.now() >= until) return
      if (state === 'missing' && missed && member.signed)
        await this.config.provider
          .broadcastTransaction(member.signed.rawTransaction)
          .catch(() => undefined)
      missed = state === 'missing'
      try {
        await nextLook()
      } catch {
        // The watcher was stopped: the wallet is closing.
        return
      }
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
        if (member.observation.state === 'included-success')
          // Applied to this device's own state by the next re-observation tick or send.
          this.localPassOwed = true
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
        if (!hold || hold.basis !== basis || hold.skipped >= HELD_RETRY_PASSES)
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
  /** Ends a contract call that was signed and never exposed. Never throws. */
  private async discardIfUnexposed(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<void> {
    try {
      const row = this.config.journal.get(operationId)
      if (
        row.kind === 'contract' &&
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
   * signed but never exposed (a crash between the signature and the broadcast: its record may
   * not have been kept, so it must not be sent later). Local only: it reads and writes the
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
    // With no local callback there is no local record to wait for and nothing to transport.
    if (!this.config.onSyncTransaction && !this.config.applyLocalMember)
      return { transported: Promise.resolve() }
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
          !member.syncApplied
        ) {
          if (this.localResults.get(`${id}:${i}`) !== 'applied') {
            unapplied ??= id
            continue
          }
          // Not transported: composition wired no transport. The member's local record stands
          // and it stays not sync-applied; that is an outcome, not a failure of the send.
          if (!this.config.onSyncTransaction) continue
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
  /**
   * Plans and signs one native transfer exactly as `sendNative` does (same sources, same journal,
   * same reservation) and stops before the broadcast. The signed transaction is journalled and
   * NOT marked exposed: the caller hands it to someone else (a message to the payee) and keeps
   * its own durable record of whether that hand-off began. `resumeOperation` broadcasts the same
   * bytes (and marks them exposed); `releaseUnexposed` cancels an operation whose bytes never
   * left. Nothing ever signs another transfer for the same operation.
   */
  signNative(
    params: SendLegacyParams,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    params = { ...params, recipient: { ...params.recipient } }
    return this.runWithLocalPass(lifetime, async planned => {
      const row = await this.plan(params, 'native', lifetime)
      planned(row.operationId)
      return this.sign(row, lifetime)
    })
  }
  /** Cancels a signed operation whose bytes were handed to nobody, freeing its source. The
   * journal refuses if any member was exposed. */
  releaseUnexposed(
    operationId: string,
    lifetime?: WalletOperationLifetime,
  ): Promise<EvmNativeOperation> {
    return this.run(() => this.journal(lifetime).discardUnexposed(operationId))
  }
  /**
   * Moves everything each of `sources` holds, less its own fee, to `recipient`: one journalled
   * native operation per source (planned, signed, checkpointed and broadcast exactly as
   * `sendNative` does), each a single transfer straight to the recipient. A source whose move
   * would cost more than it moves is left alone and named in `left`; one another operation holds
   * is named in `held`. `pending` says a broadcast move is not in a block yet; `resumeOperation` re-observes
   * it. Nothing is ever signed twice for a source: the journal holds the source while its
   * operation is unresolved.
   */
  sweepSources(
    params: { sources: readonly EvmNativeSource[]; recipient: ChainAddress },
    lifetime?: WalletOperationLifetime,
  ): Promise<{
    operationIds: string[]
    left: string[]
    held: string[]
    pending: boolean
  }> {
    const recipient = getAddress(params.recipient.raw).toLowerCase()
    const sources = params.sources.map(source => ({ ...source }))
    return this.runWithLocalPass(lifetime, async planned => {
      const journal = this.journal(lifetime)
      const fee = await this.config.provider.getFeeData()
      const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice
      if (maxFeePerGas == null) throw new Error('Native fee quote unavailable')
      const fees = {
        maxFeePerGas,
        maxPriorityFeePerGas:
          fee.maxPriorityFeePerGas != null &&
          fee.maxPriorityFeePerGas <= maxFeePerGas
            ? fee.maxPriorityFeePerGas
            : maxFeePerGas,
      }
      const operationIds: string[] = []
      const left: string[] = []
      const held: string[] = []
      let pending = false
      // What earlier operations on these accounts came to: an included one no longer holds it.
      const wanted = new Set(sources.map(source => source.address))
      for (const row of journal.list())
        if (!row.cancelled)
          for (let i = 0; i < row.members.length; i++)
            if (row.members[i]!.signed && wanted.has(row.members[i]!.source.address))
              await this.observe(row.operationId, i, lifetime)
      for (const source of sources) {
        const account = await this.account(source.address)
        const balance = BigInt(account.balanceWei)
        const available: AvailableSource = {
          source,
          account,
          spendableValue: balance,
        }
        if (balance === 0n) {
          left.push(source.address)
          continue
        }
        if (!journal.canSelect(source.address, account.nonce)) {
          held.push(source.address)
          continue
        }
        const cost = nativeMaximumFee(
          Transaction.from(await this.transaction(available, recipient, 0n, fees)),
        )
        // A move that costs more than it moves.
        if (balance - cost <= cost) {
          left.push(source.address)
          continue
        }
        // Through the same claim as every other plan: a coin a stamp is being paid from at
        // this moment is not swept under it.
        let row: EvmNativeOperation
        try {
          row = await this.reserve(lifetime, {
          kind: 'native',
          recipient,
          intendedValueWei: (balance - cost).toString(),
          members: [
            {
              source,
              unsignedTransaction: await this.transaction(
                available,
                recipient,
                balance - cost,
                fees,
              ),
              dependencies: [],
            },
          ],
        })
        } catch (reason) {
          // Claimed by another operation at this very moment: held, like a journal hold.
          if (!(reason instanceof RangeError)) throw reason
          held.push(source.address)
          continue
        }
        planned(row.operationId)
        operationIds.push(row.operationId)
        try {
          await this.execute(row.operationId, undefined, lifetime)
          await this.observe(row.operationId, 0, lifetime)
        } catch (reason) {
          // Signed and possibly broadcast: the journal keeps it, and the next source goes on.
          if (!(reason instanceof EvmNativeOperationPendingError)) throw reason
        }
        if (
          journal.get(row.operationId).members[0]!.observation.state !==
          'included-success'
        )
          pending = true
      }
      return { operationIds, left, held, pending }
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
        if (this.reobserveStopped || handled >= REOBSERVE_MAX_PROBES) return
        const key = listed.operationId
        const unresolved = (row: EvmNativeOperation) =>
          row.kind === 'contract' &&
          !row.cancelled &&
          row.members[0]!.signed !== null &&
          row.members[0]!.exposed &&
          !('transactionHash' in row.members[0]!.observation)
        if (!unresolved(listed)) {
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
        await this.observe(key, 0, lifetime, () => !this.reobserveStopped)
        const member = this.config.journal.get(key).members[0]!
        if (member.observation.state === 'missing' && member.signed)
          await this.config.provider
            .broadcastTransaction(member.signed.rawTransaction)
            .catch(() => undefined)
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
      row.kind === 'contract' &&
      !row.cancelled &&
      row.members[0]!.signed &&
      // Only a call that was handed to the network: one that never was is ended, not resumed.
      row.members[0]!.exposed &&
      !('transactionHash' in row.members[0]!.observation)
        ? [
            {
              operationId: row.operationId,
              txHash: row.members[0]!.signed.transactionHash,
            },
          ]
        : [],
    )
  }
  /** The main account: it makes contract calls and holds the tokens they move. */
  private async mainSource(): Promise<EvmNativeSource> {
    const main = (await this.config.getSources()).find(
      source => source.kind === 'main',
    )
    if (!main) throw new Error('Wallet has no main account')
    return main
  }
  /**
   * Native value a contract call can use: what the main account can spend now, and what the
   * wallet's other accounts could move into it first (`fundMainAccount`). `mainBusy` is true
   * while an earlier transaction from the main account has not been seen included.
   */
  async contractCallFunds(lifetime?: WalletOperationLifetime): Promise<{
    mainAddress: string
    mainBalance: bigint
    otherBalance: bigint
    mainBusy: boolean
  }> {
    if (this.config.inputAdmission && !lifetime) {
      if (!this.config.runLifetime)
        throw new Error('Native lifetime owner unavailable')
      return this.config.runLifetime(token => this.contractCallFunds(token))
    }
    const main = await this.mainSource()
    const accounts = await this.sources(lifetime)
    const own = accounts.find(a => a.source.address === main.address)
    const mainAccount = own?.account ?? (await this.account(main.address))
    return {
      mainAddress: main.address,
      mainBalance: BigInt(mainAccount.balanceWei),
      otherBalance: accounts
        .filter(a => a.source.address !== main.address)
        .reduce((sum, a) => sum + a.spendableValue, 0n),
      mainBusy: !this.journal(lifetime).canSelect(
        main.address,
        mainAccount.nonce,
      ),
    }
  }
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
    const main = await this.mainSource()
    const source = (await this.sources(lifetime)).find(
      a => a.source.address === main.address,
    )
    // Absent when it holds nothing, or while an earlier transaction of its own is unresolved.
    if (!source) throw new RangeError('Insufficient unreserved native funds')
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
        from: source.source.address,
        to,
        data,
        value: params.value,
      })) *
        115n) /
        100n
    if (
      BigInt(source.account.balanceWei) <
      params.value + gasLimit * maxFeePerGas
    )
      throw new RangeError('Insufficient unreserved native funds')
    return this.journal(lifetime).prepare({
      kind: 'contract',
      recipient: to,
      intendedValueWei: params.value.toString(),
      ...(params.record ? { record: params.record } : {}),
      members: [
        {
          source: source.source,
          unsignedTransaction: Transaction.from({
            type: 2,
            to,
            chainId: BigInt(this.config.journal.binding.nativeChainId),
            nonce: source.account.nonce,
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
    return this.runWithLocalPass(lifetime, async planned => {
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
  /**
   * Moves `value` from the wallet's other accounts into the main account, as one recorded
   * consolidation, so a contract call that needs more than the main account holds can follow.
   * The main account never pays into itself.
   */
  fundMainAccount(
    params: Omit<SendLegacyParams, 'recipient'>,
    lifetime?: WalletOperationLifetime,
  ): Promise<LegacySendResult> {
    return this.runWithLocalPass(lifetime, async planned => {
      const main = await this.mainSource()
      params.onProgress?.({ status: { stage: 'planning' } })
      const row = await this.plan(
        { ...params, recipient: { raw: main.address } },
        'legacy',
        lifetime,
        main.address,
      )
      planned(row.operationId)
      const result = this.legacyResult(
        await this.execute(row.operationId, params.onSigned, lifetime),
      )
      params.onProgress?.({
        status: { stage: 'confirmed', txHash: result.txHash },
      })
      return result
    })
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
    // What a transaction must be able to pay (the fee CAP) decides how many accounts are needed.
    const fee = 21000n * price
    // What it is charged is the node's current price (base fee plus tip), times the gas limit:
    // that is the fee quoted. (The cap, about twice that, was quoted before: 0.004242 MON for a
    // transfer that was charged 0.002142.)
    const charged = fees.gasPrice ?? price
    accounts.sort((a, b) => (a.spendableValue > b.spendableValue ? -1 : 1))
    // The transfer to the recipient is charged its gas LIMIT, which is the node's estimate for
    // that address (it may have code). The review shows that, not a flat 21,000. An estimate
    // that cannot be made here is made again, and decides, when the transfer is planned.
    const deliveryGas =
      accounts.length > 0
        ? await this.recipientGasLimit(
            accounts[0]!.source.address,
            getAddress(_recipient.raw),
            value,
          ).catch(() => 21000n)
        : 21000n
    const deliveryFee = deliveryGas * price
    let balance = 0n
    let count = 0
    for (const a of accounts) {
      balance += a.spendableValue
      count++
      if (balance >= value + deliveryFee + BigInt(count - 1) * fee) break
    }
    if (
      !count ||
      count > 64 ||
      balance < value + deliveryFee + BigInt(count - 1) * fee
    )
      throw new RangeError('Insufficient native funds')
    return {
      inputCount: count,
      deliveryFee: deliveryGas * charged,
      consolidationFee: BigInt(count - 1) * 21000n * charged,
      totalFee: (deliveryGas + BigInt(count - 1) * 21000n) * charged,
    }
  }
}
