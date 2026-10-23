import { getAddress, getBytes, hexlify } from 'ethers'
import type {
  ConstructEvmTransactionSetRequest,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
import type {
  TransactionSetCapability,
  PreparedTransactionSet,
  TransactionSetSubmission,
} from './transaction-set'

function project(result: PreparedEvmTransactionSet): PreparedTransactionSet {
  return {
    operationId: result.operationId,
    chainIdentifier: result.chainIdentifier,
    bundle: result.bundle.map(member => ({
      index: member.logicalIndex,
      rawTransaction: getBytes(member.rawTransaction),
      txId: member.txHash,
      recipientOutputs: [
        {
          outputIndex: 0,
          destination: getBytes(member.destination),
          amountAtomic: member.valueWei,
        },
      ],
    })),
    otherTransactions: result.otherTransactions.map(member => ({
      rawTransaction: getBytes(member.rawTransaction),
      txId: member.txHash,
    })),
  }
}
function assertPublicWrapper(
  actual: PreparedTransactionSet,
  expected: PreparedTransactionSet,
): void {
  if (
    actual.operationId !== expected.operationId ||
    actual.chainIdentifier !== expected.chainIdentifier ||
    actual.bundle.length !== expected.bundle.length ||
    actual.otherTransactions.length !== expected.otherTransactions.length
  )
    throw new Error('Prepared wrapper differs from complete wallet operation')
  const members = [...actual.bundle, ...actual.otherTransactions]
  if (
    new Set(members.map(member => hexlify(member.rawTransaction))).size !==
      members.length ||
    new Set(members.map(member => member.txId)).size !== members.length
  )
    throw new Error('Prepared wrapper contains duplicate transactions')
  actual.bundle.forEach((member, index) => {
    const wanted = expected.bundle[index]!
    if (
      member.index !== wanted.index ||
      member.txId !== wanted.txId ||
      hexlify(member.rawTransaction) !== hexlify(wanted.rawTransaction) ||
      member.recipientOutputs.length !== 1 ||
      member.recipientOutputs[0]!.outputIndex !== 0 ||
      member.recipientOutputs[0]!.amountAtomic !==
        wanted.recipientOutputs[0]!.amountAtomic ||
      hexlify(member.recipientOutputs[0]!.destination) !==
        hexlify(wanted.recipientOutputs[0]!.destination)
    )
      throw new Error('Prepared recipient differs from wallet authority')
  })
  actual.otherTransactions.forEach((member, index) => {
    const wanted = expected.otherTransactions[index]!
    if (
      member.txId !== wanted.txId ||
      hexlify(member.rawTransaction) !== hexlify(wanted.rawTransaction)
    )
      throw new Error(
        'Prepared owned transaction differs from wallet authority',
      )
  })
}

/** Chain-neutral host boundary. Submission consumes the whole authoritative signed graph. */
export function evmTransactionSetCapability(
  preparer: {
    constructTransactionSet(
      request: ConstructEvmTransactionSetRequest,
    ): Promise<PreparedEvmTransactionSet>
    readTransactionSet?(operationId: string): Promise<PreparedEvmTransactionSet>
  },
  submit?: (
    prepared: PreparedEvmTransactionSet,
  ) => Promise<TransactionSetSubmission>,
): TransactionSetCapability {
  return {
    async constructTransactionSet(request): Promise<PreparedTransactionSet> {
      const kdf = request.kdf
      const result = await preparer.constructTransactionSet({
        operationId: request.operationId,
        amountWei: request.amountAtomic,
        kdf(index) {
          const destination = kdf(index, 0)
          if (destination.length !== 20)
            throw new Error(
              'EVM transaction-set destination must be exactly 20 bytes',
            )
          return getAddress(hexlify(destination))
        },
        ...(request.calldata === undefined
          ? {}
          : { calldata: hexlify(request.calldata) }),
        ...(request.maxNativeFeeAtomic === undefined
          ? {}
          : { maxFeeWei: request.maxNativeFeeAtomic }),
      })
      return project(result)
    },
    async sendTransaction(prepared): Promise<TransactionSetSubmission> {
      if (!submit || !preparer.readTransactionSet)
        throw new Error(
          'Transaction-set submission is unavailable for this wallet',
        )
      const authoritative = await preparer.readTransactionSet(prepared.operationId)
      assertPublicWrapper(prepared, project(authoritative))
      return submit(authoritative)
    },
  }
}
