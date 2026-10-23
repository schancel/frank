/** Local completion bookkeeping. A receipt never asserts atomic external settlement. */
import {
  evmNativeOperationDigest,
  nativeMemberSuperseded,
  type EvmNativeCompletionReceipt,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'

/** Financial and inventory obligations are independent of delivery and self-sync. */
export function transactionSetFinanciallyComplete(operation: EvmNativeOperation): boolean {
  return operation.kind === 'transaction-set' && !operation.cancelled &&
    operation.members.length > 0 && operation.members.every(member =>
      member.transactionSet?.inventoryApplied === true && (
        member.observation.state === 'included-success' ||
        member.observation.state === 'included-revert' ||
        nativeMemberSuperseded(member)))
}

/** The caller supplies a durable owner's positive checkpoint, never an absent-record guess. */
export function transactionSetCompletionReceipt(
  operation: EvmNativeOperation,
  checkpoint: Omit<EvmNativeCompletionReceipt, 'expectedOperationHash'>,
): EvmNativeCompletionReceipt | undefined {
  if (!transactionSetFinanciallyComplete(operation)) return undefined
  return { ...checkpoint, expectedOperationHash: evmNativeOperationDigest(operation) }
}
