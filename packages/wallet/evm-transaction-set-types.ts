import type {
  EvmCoinList,
  EvmCoinListOrigin,
  EvmListCoin,
} from './evm-coin-list'
import type {
  EvmNativeOperationJournal,
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
  beginCapture(
    operationId: string,
    memberIndex: number,
  ): EvmNativeCapture | Promise<EvmNativeCapture>
}

export interface EvmTransactionSetPreparerOptions {
  readonly coins: EvmCoinList
  readonly journal: EvmTransactionSetJournal
  readonly canSelectCoin?: (coin: EvmListCoin) => boolean
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
