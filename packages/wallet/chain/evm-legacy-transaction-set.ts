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
import { EvmNativeOperationPendingError } from './evm-legacy-consolidator'
import { evmPaymentFloorWei } from './payment-floor'
import {
  ContactPaymentBelowFloorError,
  NativeFeeExceededError,
  type ChainAddress,
  type LegacySendProgress,
  type ChainTransaction,
  type LegacyFeeEstimate,
  type LegacyMaxEstimate,
  type LegacySendResult,
} from './chain-wallet'

const preparationPrefix = 'evm-transaction-set:legacy-'

/** One transfer of `value` to `recipient`, built from the wallet's coin list. */
export interface SendLegacyParams {
  recipient: ChainAddress
  value: bigint
  operationId?: string
  /** The fee the user reviewed, as a ceiling: construction refuses rather than pay more. */
  maxFee?: bigint
  onProgress?: (progress: LegacySendProgress) => void
  onSigned?: (signed: ChainTransaction) => Promise<void>
  /** Accepted for the shared transfer contract; a coin-list transfer never waits on the main
   * account, so it is ignored. */
  mainAccountWaitMs?: number
  /** The recipient is an account of this wallet (funding its main account): the wallet moves
   * its own value, so the payment floor does not apply. Only the wallet's composition sets
   * it; a transfer a host or bot asks for is to someone else and is held to the floor. */
  recipientOwned?: boolean
}

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
  /** A transfer to someone else is never below the payment floor (`evmPaymentFloorWei` at the
   * policy's gas price, which is the policy's `dustWei` in the wallet): its recipient could not
   * move the coin it makes for less than a tenth of its value. Refused before anything is
   * reserved or signed, as Send to Contact and chat stealth payments refuse it. Call after
   * `refresh`, so the floor is at the live price. */
  const requireAtFloor = (valueWei: bigint, recipientOwned: boolean | undefined) => {
    if (recipientOwned) return
    const floorWei = evmPaymentFloorWei(options.preparer.transactionSetPolicy().gasPriceWei)
    if (valueWei < floorWei) throw new ContactPaymentBelowFloorError(valueWei, floorWei)
  }
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
     * construction makes (`EvmTransactionSetPreparer.quoteLegacyTransactionSet`). Refused
     * below the payment floor, as `sendLegacy` is, unless the recipient is the wallet's own. */
    async estimateLegacyFee(
      params: Pick<SendLegacyParams, 'recipient' | 'value' | 'recipientOwned'>,
    ): Promise<LegacyFeeEstimate> {
      if (params.value <= 0n)
        throw new RangeError('Transfer value must be positive')
      await options.refresh()
      requireAtFloor(params.value, params.recipientOwned)
      return feeEstimate(
        await options.preparer.quoteLegacyTransactionSet({
          destination: params.recipient.raw,
          amountWei: params.value,
        }),
      )
    },
    /** The most one transfer can send now (every coin selection can draw on, less the fees of
     * moving it) and the exact fee it pays. Refused (`ContactPaymentBelowFloorError`, naming the
     * most and the floor) when that is below the payment floor and the recipient is not the
     * wallet's own. */
    async estimateLegacyMax(
      params: Pick<SendLegacyParams, 'recipient' | 'recipientOwned'> & {
        excludedSourceAccounts?: readonly string[]
      },
    ): Promise<LegacyMaxEstimate> {
      await options.refresh()
      const quote = await options.preparer.quoteLegacyTransactionSet({
        destination: params.recipient.raw,
        ...(params.excludedSourceAccounts
          ? { excludedSourceAccounts: params.excludedSourceAccounts }
          : {}),
      })
      requireAtFloor(quote.amountWei, params.recipientOwned)
      return { value: quote.amountWei, ...feeEstimate(quote) }
    },
    /**
     * Moves everything the coins of `sourceAccounts` hold, less each transfer's fee, to
     * `destination`, an account of this wallet: one transaction set through the same coin list,
     * reservation, journal and submission as every payment, one transfer per coin and no
     * change (`EvmTransactionSetPreparer.quoteSweepTransactionSet`). A coin that would cost as
     * much to move as it holds, or that is held by another operation or by the chain's spend
     * rule, is not moved; `moved` names the accounts that are. Nothing is signed when no coin
     * can be moved. A coin already in a sweep is `pending_receipt` and never selected again, so
     * asking again never signs a second sweep of it.
     */
    async sweepToOwnAccount(params: {
      sourceAccounts: readonly string[]
      destination: string
    }): Promise<{
      operationId: string
      moved: readonly string[]
      submission: TransactionSetSubmission
    }> {
      await options.refresh()
      const quote = await options.preparer.quoteSweepTransactionSet({
        destination: params.destination,
        sourceAccounts: params.sourceAccounts,
      })
      const operationId = `sweep-${hexlify(randomBytes(16)).slice(2)}`
      const prepared = await options.preparer.constructTransactionSet({
        operationId,
        amountWei: quote.amountWei,
        kdf: () => params.destination,
        sourceAccounts: quote.sourceAccounts,
        maxPaymentParts: quote.sourceAccounts.length,
        maxFeeWei: quote.feeWei,
      })
      return {
        operationId,
        moved: quote.sourceAccounts,
        submission: await options.sendTransaction(prepared),
      }
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
        | 'recipientOwned'
      > & {
        /** Accounts whose coins this transfer must not spend: funding the main account never
         * pays out of the main account. */
        excludedSourceAccounts?: readonly string[]
      },
    ): Promise<LegacySendResult> {
      const request = { ...params, recipient: { ...params.recipient } }
      request.onProgress?.({ status: { stage: 'planning' } })
      await options.refresh()
      const operationId = request.operationId ?? `legacy-${hexlify(randomBytes(16)).slice(2)}`
      if (!/^legacy-[a-zA-Z0-9_-]{1,121}$/.test(operationId))
        throw new Error('Invalid legacy send operation ID')
      // A caller replaying its own operation (the same `operationId`) gets that operation back,
      // whatever the floor is now; only a new transfer is held to it.
      if (!(await options.preparer.readOperation(operationId)))
        requireAtFloor(request.value, request.recipientOwned)
      let prepared
      try {
        prepared = await options.preparer.constructLegacyTransactionSet({
          operationId,
          amountWei: request.value,
          kdf: () => request.recipient.raw,
          maxFeeWei: request.maxFee,
          ...(request.excludedSourceAccounts
            ? { excludedSourceAccounts: request.excludedSourceAccounts }
            : {}),
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
