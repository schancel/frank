/** User-requested single-recipient payments. The shared graph owns all signed funds. */
import { hexlify, randomBytes, Transaction } from 'ethers'
import {
  EvmTransactionSetFeeExceededError,
  type EvmTransactionSetQuote,
  type EvmTransactionSetPreparer,
} from '../evm-transaction-set'
import type { PreparedEvmTransactionSet } from '../evm-transaction-set-types'
import type { TransactionSetSubmission } from '../transaction-set'
import {
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from '../storage/evm-native-operation-journal'
import {
  EvmNativeOperationPendingError,
  type SendLegacyParams,
} from './evm-legacy-consolidator'
import {
  NativeFeeExceededError,
  type ChainTransaction,
  type LegacyFeeEstimate,
  type LegacyMaxEstimate,
  type LegacySendResult,
} from './chain-wallet'

const preparationPrefix = 'evm-transaction-set:legacy-'

export class LegacyTransactionSetFailedError extends Error {
  constructor(readonly operation: EvmNativeOperation) {
    super(
      'The original legacy transaction set has a confirmed failure; no replacement payment was authorized',
    )
    this.name = 'LegacyTransactionSetFailedError'
  }
}

/** Shared graphs may place owned change after the recipient; public identity is the payment. */
export class LegacyTransactionSetPendingError extends EvmNativeOperationPendingError {
  override readonly transaction: ChainTransaction
  constructor(operation: EvmNativeOperation, reason: unknown) {
    super(operation, reason)
    const payment = operation.members.find(
      member => member.transactionSet?.role === 'payment',
    )
    this.transaction = {
      txHash: payment?.signed?.transactionHash ?? '',
      relatedTxHashes: operation.members
        .filter(member => member !== payment)
        .flatMap(member =>
          member.signed ? [member.signed.transactionHash] : [],
        ),
    }
    this.message = `Legacy transaction set retained pending for ${this.transaction.txHash}`
    this.name = 'LegacyTransactionSetPendingError'
  }
}

const feeEstimate = (quote: EvmTransactionSetQuote): LegacyFeeEstimate => ({
  inputCount: quote.inputCount,
  deliveryFee: quote.deliveryFeeWei,
  consolidationFee: quote.consolidationFeeWei + quote.changeFeeWei,
  totalFee: quote.feeWei,
})

export function createLegacyTransactionSetPayments(options: {
  preparer: EvmTransactionSetPreparer
  sendTransaction(
    prepared: PreparedEvmTransactionSet,
  ): Promise<TransactionSetSubmission>
  refresh(): Promise<void>
  operations(): readonly EvmNativeOperation[]
  readOperation(operationId: string): Promise<EvmNativeOperation | undefined>
}) {
  const isSharedLegacy = (row: EvmNativeOperation | undefined): row is EvmNativeOperation =>
    row?.kind === 'transaction-set' && row.preparationId?.startsWith(preparationPrefix) === true
  const isSharedLegacyOperation = async (operationId: string): Promise<boolean> =>
    isSharedLegacy(await options.readOperation(operationId))
  const read = async (operationId: string): Promise<EvmNativeOperation> => {
    const row = await options.readOperation(operationId)
    if (!isSharedLegacy(row)) throw new Error('Unknown shared legacy operation')
    if (row.cancelled) throw new Error('Legacy operation was cancelled')
    return row
  }
  const recipient = (row: EvmNativeOperation) => {
    const members = row.members.filter(
      member => member.transactionSet?.role === 'payment',
    )
    if (members.length !== 1 || !members[0]!.signed)
      throw new Error(
        'Legacy operation must have one signed recipient transaction',
      )
    return members[0]!
  }
  const failed = (row: EvmNativeOperation) =>
    row.members.some(
      member =>
        member.observation.state === 'included-revert' ||
        nativeMemberSuperseded(member),
    )
  const resumeLegacySend = async (
    operationId: string,
  ): Promise<LegacySendResult> => {
    const original = await read(operationId)
    const id = original.preparationId!.slice('evm-transaction-set:'.length)
    // Completed history already carries the original financial result. Active rows still
    // pass through submission so pending owned change and inventory projection can finish.
    if (options.operations().some(row => row.operationId === operationId)) {
      try {
        await options.sendTransaction(await options.preparer.readTransactionSet(id))
      } catch (error) {
        throw new LegacyTransactionSetPendingError(await read(operationId), error)
      }
    }
    const row = await read(operationId)
    if (failed(row)) throw new LegacyTransactionSetFailedError(row)
    if (
      row.members.some(
        member => member.observation.state !== 'included-success',
      )
    )
      throw new LegacyTransactionSetPendingError(
        row,
        new Error('Original legacy payment or owned redistribution is pending'),
      )
    const final = recipient(row)
    return {
      txHash: final.signed!.transactionHash,
      intermediateTxHashes: row.members
        .filter(member => member !== final)
        .map(member => member.signed!.transactionHash),
      totalValueSent: Transaction.from(final.signed!.rawTransaction).value,
      totalFeePaid: row.members.reduce(
        (sum, member) =>
          sum +
          BigInt(
            'feeWei' in member.observation ? member.observation.feeWei : '0',
          ),
        0n,
      ),
    }
  }
  const getUnresolvedLegacySend = (): readonly EvmNativeOperation[] =>
    options
      .operations()
      .filter(
        row =>
          row.kind === 'transaction-set' &&
          row.preparationId?.startsWith(preparationPrefix) &&
          !row.cancelled &&
          row.members.some(
            member => member.observation.state !== 'included-success',
          ),
      )
  return {
    isSharedLegacyOperation,
    getUnresolvedLegacySend,
    /** Host-driven recovery; no timer or proactive funding is installed here. */
    async reconcileLegacySends(): Promise<readonly EvmNativeOperation[]> {
      const results = await Promise.allSettled(
        getUnresolvedLegacySend()
          .filter(row => row.submissionAuthorized)
          .map(row => resumeLegacySend(row.operationId)),
      )
      const failure = results.find(
        result =>
          result.status === 'rejected' &&
          !(result.reason instanceof EvmNativeOperationPendingError),
      )
      if (failure?.status === 'rejected') throw failure.reason
      return getUnresolvedLegacySend()
    },
    resumeLegacySend,
    /** The exact fee the transfer pays: the same selection, change split and member count the
     * construction makes (`EvmTransactionSetPreparer.quoteLegacyTransactionSet`). */
    async estimateLegacyFee(
      params: Pick<SendLegacyParams, 'recipient' | 'value'>,
    ): Promise<LegacyFeeEstimate> {
      if (params.value <= 0n)
        throw new RangeError('Transfer value must be positive')
      await options.refresh()
      return feeEstimate(
        await options.preparer.quoteLegacyTransactionSet({
          destination: params.recipient.raw,
          amountWei: params.value,
        }),
      )
    },
    /** The most one transfer can send now (every coin selection can draw on, less the fees of
     * moving it) and the exact fee it pays. */
    async estimateLegacyMax(
      params: Pick<SendLegacyParams, 'recipient'>,
    ): Promise<LegacyMaxEstimate> {
      await options.refresh()
      const quote = await options.preparer.quoteLegacyTransactionSet({
        destination: params.recipient.raw,
      })
      return { value: quote.amountWei, ...feeEstimate(quote) }
    },
    async sendLegacy(
      params: Pick<
        SendLegacyParams,
        | 'recipient'
        | 'value'
        | 'operationId'
        | 'maxFee'
        | 'onProgress'
        | 'onSigned'
        | 'mainAccountWaitMs'
      >,
    ): Promise<LegacySendResult> {
      const request = { ...params, recipient: { ...params.recipient } }
      request.onProgress?.({ status: { stage: 'planning' } })
      await options.refresh()
      const operationId = request.operationId ?? `legacy-${hexlify(randomBytes(16)).slice(2)}`
      if (!/^legacy-[a-zA-Z0-9_-]{1,121}$/.test(operationId))
        throw new Error('Invalid legacy send operation ID')
      let prepared
      try {
        prepared = await options.preparer.constructLegacyTransactionSet({
          operationId,
          amountWei: request.value,
          kdf: () => request.recipient.raw,
          maxFeeWei: request.maxFee,
        })
      } catch (error) {
        const retained = await options.preparer.readOperation(operationId)
        if (retained)
          throw new LegacyTransactionSetPendingError(retained, error)
        // Nothing was signed: the reviewed fee no longer covers the transfer.
        if (error instanceof EvmTransactionSetFeeExceededError)
          throw new NativeFeeExceededError(error.feeWei)
        throw error
      }
      const row = await options.preparer.readOperation(operationId)
      if (!row) throw new Error('Missing durable shared legacy operation')
      const final = recipient(row)
      // The complete graph is already durable. A callback failure cannot authorize a new payment.
      try {
        await request.onSigned?.({
          txHash: final.signed!.transactionHash,
          relatedTxHashes: prepared.otherTransactions.map(tx => tx.txHash),
        })
      } catch (error) {
        throw new LegacyTransactionSetPendingError(row, error)
      }
      request.onProgress?.({
        status: {
          stage: 'consolidating',
          completed: 0,
          total: prepared.otherTransactions.length,
          stagingTxHashes: prepared.otherTransactions.map(tx => tx.txHash),
        },
      })
      const result = await resumeLegacySend(row.operationId)
      request.onProgress?.({
        status: { stage: 'confirmed', txHash: result.txHash },
      })
      return result
    },
  }
}
