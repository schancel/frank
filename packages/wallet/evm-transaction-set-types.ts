import type {
  EvmCoinList,
  EvmCoinListOrigin,
  EvmListCoin,
} from './evm-coin-list'
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
  /** Internal protocol constraint for consumers that require one on-chain payment. */
  readonly maxPaymentParts?: number
  /** Captured minimum for each recipient transaction; never recomputed during replay. */
  readonly minimumPaymentWei?: bigint
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
  constructor() {
    super('Insufficient available EVM coins')
    this.name = 'EvmTransactionSetInsufficientFundsError'
  }
}
