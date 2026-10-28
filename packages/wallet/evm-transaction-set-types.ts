import { describeWalletFailure, recordWalletFailure } from './wallet-failure'
import type {
  EvmCoinList,
  EvmCoinListOrigin,
  EvmListCoin,
} from './evm-coin-list'
import type { EvmCoinDistribution } from './evm-coin-distribution'
import type {
  EvmNativeOperationJournal,
  EvmNativeOperation,
  EvmNativeCapture,
} from './storage/evm-native-operation-journal'

/** Plain data. No signing material or lifecycle methods cross this boundary. */
export interface PreparedEvmTransaction {
  readonly logicalIndex: number
  readonly sourceAccount: string
  readonly nonce: number
  readonly destination: string
  readonly valueWei: bigint
  readonly gasLimit: bigint
  readonly rawTransaction: string
  readonly txHash: string
  readonly predecessor?: { readonly account: string; readonly nonce: number }
}
export interface ConstructEvmTransactionSetRequest {
  readonly operationId: string
  readonly amountWei: bigint
  readonly kdf: (paymentIndex: number) => string
  readonly calldata?: string
  readonly maxFeeWei?: bigint
  /** Value kept in private change for a later leg of this same operation. */
  readonly reserveForContinuationWei?: bigint
  /** The continuation is one transfer, and this is its fee (part of the reserve). The reserve is
   * then kept as one fresh account holding exactly `reserveForContinuationWei`, which that one
   * transfer spends whole, and the fee bound (`maxFeeWei`) counts this fee: change is never
   * planned from it, and a set whose continuation would not fit under the bound is refused here,
   * before anything is signed, instead of at the continuation. */
  readonly continuationFeeWei?: bigint
  /** Internal protocol constraint for consumers that require one on-chain payment. */
  readonly maxPaymentParts?: number
  /** Captured minimum for each recipient transaction; never recomputed during replay. */
  readonly minimumPaymentWei?: bigint
  /** Spend only coins of these accounts (a sweep of named coins). */
  readonly sourceAccounts?: readonly string[]
  /** Never spend coins of these accounts (funding the main account never pays out of it). */
  readonly excludedSourceAccounts?: readonly string[]
}
/** One approved transaction from an owned legacy subaccount. Its source is never in ordinary
 * bundle selection; the wallet reserves exactly this account and nonce. */
export interface ConstructLegacySubAccountRequest {
  readonly operationId: string
  readonly sourceAddress: string
  readonly destination: string
  readonly valueWei: bigint
  readonly calldata?: string
  readonly nonce?: number
  readonly gasLimit?: bigint
  readonly type?: 0 | 2
  readonly gasPriceWei?: bigint
  readonly maxFeePerGasWei?: bigint
  readonly maxPriorityFeePerGasWei?: bigint
  readonly maxFeeWei?: bigint
}
export interface PreparedEvmTransactionSet {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly bundle: readonly PreparedEvmTransaction[]
  readonly otherTransactions: readonly PreparedEvmTransaction[]
}
export const EVM_TRANSACTION_SET_SOURCE_ORDER: readonly EvmCoinListOrigin[] = [
  'stealth',
  'stamp',
  'change',
  'deterministic',
  'root',
  'identity',
]

export interface EvmTransactionSetPolicy {
  readonly sourceOrder: readonly EvmCoinListOrigin[]
  readonly gasPriceWei: bigint
  /** Reviewed bound for the exact call data/destination; no network I/O here. */
  readonly paymentGasLimit: (calldata: string, destination?: string) => bigint
  readonly changeGasLimit: bigint
  /** True only for exact intrinsic gas, or a chain that charges the gas limit. */
  readonly paymentFeeIsExact:
    | boolean
    | ((destination: string, calldata: string) => boolean)
  readonly dustWei: bigint
  readonly radix: number
  readonly jitterBps: number
  readonly maxChangeOutputs: number
  /** The coin distribution (`evm-coin-distribution.ts`) the splitter and background
   * consolidation both read. When present, a payment makes only as many change coins as keep
   * the wallet's pool within its band. The production policy always sets it, with `dustWei` and
   * `maxChangeOutputs` taken from it. */
  readonly coinDistribution?: EvmCoinDistribution
  readonly head: number
  readonly spendRule?: {
    readonly belowWei: bigint
    readonly waitBlocks: number
  }
}
export interface EvmChangeDestination {
  readonly account: string
  readonly privateKey: string
  readonly changeIndex: number
}
export type EvmTransactionSetJournal = Pick<
  EvmNativeOperationJournal,
  | 'binding'
  | 'list'
  | 'get'
  | 'canSelect'
  | 'refreshPreparation'
  | 'prepare'
  | 'appendTransactionSet'
  | 'authorizeTransactionSet'
  | 'markExposed'
  | 'markSyncApplied'
  | 'markTransactionSetInventoryApplied'
  | 'discardUnexposed'
  | 'discardRefusedBeforeBroadcast'
  | 'recordResigned'
  | 'recordObservation'
> & {
  /** Snapshot other authorization owners once per selection, never once per coin. */
  captureInputSelection?(): Promise<(source: string, nonce: number) => boolean>
  beginCapture(
    operationId: string,
    memberIndex: number,
  ): EvmNativeCapture | Promise<EvmNativeCapture>
}

export interface EvmTransactionSetPreparerOptions {
  readonly coins: EvmCoinList
  readonly journal: EvmTransactionSetJournal
  /** Called only after cancellation inventory cleanup is durable. Composition retains
   * independent durable derivation ownership before it retires the tombstone. */
  readonly onCancellationCheckpoint?: (operation: EvmNativeOperation) => Promise<void>
  readonly canSelectCoin?: (coin: EvmListCoin) => boolean
  /** A payment of a set was seen included. Synchronous, no I/O: composition marks the
   * destination for a chain read when it is one of the wallet's own fresh accounts. */
  readonly onPaymentIncluded?: (destination: string) => void
  /** The fresh account a background merge's set moves its coins to (`evm-merge-targets.ts`,
   * derived from the coins the set spends), with its key; undefined for every other set.
   * Derivation only; target state is observed through observeMergeTarget after settlement. */
  readonly mergeTarget?: (row: EvmNativeOperation) => EvmChangeDestination | undefined
  /** Registers owned target discovery and observes current chain state through the inventory
   * owner. Rejects incomplete observation so settlement can retry after interruption. */
  readonly observeMergeTarget?: (target: EvmChangeDestination) => Promise<void>
  /** Synchronous cached observation check, only after insufficient selection. Never performs
   * RPC or changes reservations; throws the retained observation error when funding is unknown. */
  readonly assertFundingObserved?: () => void
  /** Snapshot must already be cached/reviewed; construction never calls RPC. */
  readonly policy: () => EvmTransactionSetPolicy
  /** Static network execution rule, available during recovery before fee observations. */
  readonly recoverySpendRule?: EvmTransactionSetPolicy['spendRule']
  /** Derive by index; inventory/journal reserve destinations even before funding settles. */
  readonly deriveChange: (index: number) => EvmChangeDestination
  /** Production composition supplies the single durable allocator shared with maintenance.
   * Only local storage/derivation work is permitted; source selection has already completed. */
  readonly reserveChange?: (
    operationId: string,
    minimumIndex: number,
  ) => Promise<EvmChangeDestination>
  readonly random?: () => number
}

/** Construction found no eligible inputs; no signed operation is created by this refusal. */
export class EvmTransactionSetInsufficientFundsError extends Error {
  /**
   * Selection passed over coins that the chain lets be spent only from a later block (on Monad,
   * money that arrived or an account that sent a few blocks ago). From this block every one of
   * them may be spent. Undefined when no coin was waiting: the funds are simply not there.
   */
  readonly spendableFromBlock?: number
  constructor(spendableFromBlock?: number) {
    super('Insufficient available EVM coins')
    if (spendableFromBlock !== undefined)
      this.spendableFromBlock = spendableFromBlock
    this.name = 'EvmTransactionSetInsufficientFundsError'
    recordWalletFailure(this, { diagnosis: 'insufficient-funds' })
  }
}

/**
 * The wallet's free coins do not cover this send, but money of its own earlier sends that has
 * not reached the chain yet would: change those sends split off and what stays with a sending
 * account after them (on Monad, change behind a payment goes out only after the relay stored
 * that message, on later ticks). Owner ruling 2026-10-26: refuse right away with this reason
 * and let the user try again; never queue the send and never reorder the earlier set. Nothing
 * was signed, reserved or recorded. It is still an insufficient-funds refusal for every caller
 * that asks only that.
 */
export class FundsInPendingSendError extends EvmTransactionSetInsufficientFundsError {
  constructor(
    /** What the wallet's own unfinished sends hand back to it once they reach the chain. */
    readonly tiedUpWei: bigint,
    /** What the free coins lack for this send. */
    readonly shortfallWei: bigint,
  ) {
    super()
    this.message = `Insufficient available EVM coins: ${tiedUpWei} wei is tied up in a previous send that has not reached the chain yet; try again in a moment`
    this.name = 'FundsInPendingSendError'
  }
}

/** The tied-up refusal itself, or the one a wrapping refusal recorded as its cause (a stamp
 * refusal wraps it). Identity lookups only, as `describeWalletFailure`. */
export function fundsInPendingSend(error: unknown): FundsInPendingSendError | undefined {
  if (error instanceof FundsInPendingSendError) return error
  const { cause } = describeWalletFailure(error)
  return cause instanceof FundsInPendingSendError ? cause : undefined
}
