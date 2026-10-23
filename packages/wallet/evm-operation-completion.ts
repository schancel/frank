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

/** Successful members own a self-sync obligation until its transport checkpoint is
 * durable. Failed/superseded members have no success note in the existing sync policy.
 * Delivery remains active in the canonical or host outbox; this receipt does not say
 * that the user's message was delivered or the full intended payment succeeded. */
export function transactionSetFinancialCompletionReceipt(
  operation: EvmNativeOperation,
): EvmNativeCompletionReceipt | undefined {
  if (!transactionSetFinanciallyComplete(operation) || operation.members.some(member =>
    member.observation.state === 'included-success' && !member.syncApplied)) return undefined
  return {
    expectedOperationHash: evmNativeOperationDigest(operation),
    ownerReference: `wallet-financial-sync:${operation.operationId}`,
    sync: 'complete', delivery: 'not-required', dependencies: 'complete',
  }
}
