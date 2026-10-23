/** Explicit wallet submission for a complete, durably signed recipient/change graph. */
import { Transaction, type Provider } from 'ethers'
import type { EvmTransactionSetPreparer } from './evm-transaction-set'
import type { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import type {
  PreparedEvmTransaction,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
import {
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'
import type { TransactionSetSubmission } from './transaction-set'

function assertMember(
  actual: PreparedEvmTransaction,
  expected: PreparedEvmTransaction,
  chainId: bigint,
): void {
  const transaction = Transaction.from(actual.rawTransaction)
  if (
    !transaction.isSigned() ||
    transaction.chainId !== chainId ||
    actual.rawTransaction !== expected.rawTransaction ||
    actual.txHash !== expected.txHash ||
    transaction.hash !== actual.txHash ||
    transaction.serialized !== actual.rawTransaction ||
    actual.logicalIndex !== expected.logicalIndex ||
    actual.nonce !== expected.nonce ||
    actual.sourceAccount !== expected.sourceAccount ||
    actual.destination !== expected.destination ||
    actual.valueWei !== expected.valueWei ||
    actual.gasLimit !== expected.gasLimit ||
    actual.predecessor?.account !== expected.predecessor?.account ||
    actual.predecessor?.nonce !== expected.predecessor?.nonce ||
    transaction.from!.toLowerCase() !== actual.sourceAccount.toLowerCase() ||
    transaction.to?.toLowerCase() !== actual.destination.toLowerCase() ||
    transaction.nonce !== actual.nonce ||
    transaction.value !== actual.valueWei ||
    transaction.gasLimit !== actual.gasLimit
  )
    throw new Error(
      'Prepared transaction metadata or signed bytes differ from wallet authority',
    )
}

/** Exact lists, order and metadata; duplicates/omissions never turn a partial wrapper into consent. */
function assertComplete(
  prepared: PreparedEvmTransactionSet,
  expected: PreparedEvmTransactionSet,
  row: EvmNativeOperation,
): void {
  if (
    prepared.operationId !== expected.operationId ||
    prepared.chainIdentifier !== expected.chainIdentifier ||
    prepared.chainIdentifier !== row.binding.chainIdentifier ||
    prepared.bundle.length !== expected.bundle.length ||
    prepared.otherTransactions.length !== expected.otherTransactions.length
  )
    throw new Error(
      'Prepared transaction set does not match the complete wallet operation',
    )
  const all = [...prepared.bundle, ...prepared.otherTransactions]
  if (
    new Set(all.map(member => member.rawTransaction)).size !== all.length ||
    new Set(all.map(member => member.txHash)).size !== all.length
  )
    throw new Error('Prepared transaction set contains duplicate transactions')
  prepared.bundle.forEach((member, index) =>
    assertMember(
      member,
      expected.bundle[index]!,
      BigInt(row.binding.nativeChainId),
    ),
  )
  prepared.otherTransactions.forEach((member, index) =>
    assertMember(
      member,
      expected.otherTransactions[index]!,
      BigInt(row.binding.nativeChainId),
    ),
  )
}

export function createEvmTransactionSetSubmission(options: {
  preparer: EvmTransactionSetPreparer
  lifecycle: EvmTransactionSetLifecycle
  provider: Provider
  refresh(): Promise<void>
  operations(): readonly EvmNativeOperation[]
}) {
  const row = (id: string): EvmNativeOperation => {
    const operation = options.preparer.getOperation(id)
    if (!operation || operation.cancelled)
      throw new Error('Unknown active transaction set')
    return operation
  }
  const report = (
    id: string,
    reason: TransactionSetSubmission['pendingReason'] = 'dependency-pending',
  ): TransactionSetSubmission => {
    const operation = row(id)
    const failed = operation.members.filter(
      member =>
        member.observation.state === 'included-revert' ||
        nativeMemberSuperseded(member),
    )
    const pending = operation.members.filter(
      member =>
        member.observation.state !== 'included-success' &&
        !failed.includes(member),
    )
    const status = pending.length
      ? 'pending'
      : failed.length
      ? 'failed'
      : 'confirmed'
    return {
      operationId: id,
      chainIdentifier: operation.binding.chainIdentifier,
      status,
      pendingTransactionIds: pending.map(
        member => member.signed!.transactionHash,
      ),
      failedTransactionIds: failed.map(
        member => member.signed!.transactionHash,
      ),
      ...(status === 'pending' ? { pendingReason: reason } : {}),
    }
  }
  const resume = async (id: string): Promise<TransactionSetSubmission> => {
    if (!row(id).submissionAuthorized)
      throw new Error('Transaction set has not been authorized for submission')
    let observationUnavailable = false
    try {
      await options.refresh()
      await options.lifecycle.observe(id, options.provider)
    } catch {
      // Readiness still gates unknown dependencies; unrelated signed inputs can progress.
      observationUnavailable = true
    }
    let submissionUncertain = false
    try {
      await options.lifecycle.replay(id, { payments: true })
    } catch {
      submissionUncertain = true
    }
    try {
      await options.lifecycle.observe(id, options.provider)
    } catch {
      return report(
        id,
        submissionUncertain
          ? 'submission-uncertain'
          : 'observation-unavailable',
      )
    }
    return report(
      id,
      submissionUncertain
        ? 'submission-uncertain'
        : observationUnavailable
        ? 'observation-unavailable'
        : 'dependency-pending',
    )
  }
  return {
    async sendTransaction(
      prepared: PreparedEvmTransactionSet,
    ): Promise<TransactionSetSubmission> {
      const id = prepared.operationId
      const expected = options.preparer.getTransactionSet(id)
      assertComplete(prepared, expected, row(id))
      // Atomic journal comparison rejects any concurrent append between validation and this write.
      await options.preparer.authorizeSubmission(
        id,
        [...prepared.bundle, ...prepared.otherTransactions].map(
          member => member.rawTransaction,
        ),
      )
      return resume(id)
    },
    async reconcileAuthorized(): Promise<readonly TransactionSetSubmission[]> {
      const operations = options
        .operations()
        .filter(
          operation =>
            operation.kind === 'transaction-set' &&
            operation.submissionAuthorized &&
            !operation.cancelled &&
            operation.members.some(
              member =>
                member.observation.state !== 'included-success' &&
                member.observation.state !== 'included-revert' &&
                !nativeMemberSuperseded(member),
            ),
        )
      // No wallet-wide queue: one slow operation never prevents another from entering replay.
      return Promise.all(
        operations.map(operation =>
          resume(operation.preparationId!.slice('evm-transaction-set:'.length)),
        ),
      )
    },
  }
}

export type EvmTransactionSetSubmission = ReturnType<
  typeof createEvmTransactionSetSubmission
>
