/** User-requested single-recipient payments. The shared graph owns all signed funds. */
import { hexlify, randomBytes, Transaction } from 'ethers'
import type { EvmTransactionSetPreparer } from '../evm-transaction-set'
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
import type { EvmListCoin } from '../evm-coin-list'
import type {
  ChainTransaction,
  LegacyFeeEstimate,
  LegacySendResult,
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

export function createLegacyTransactionSetPayments(options: {
  preparer: EvmTransactionSetPreparer
  sendTransaction(
    prepared: PreparedEvmTransactionSet,
  ): Promise<TransactionSetSubmission>
  refresh(): Promise<void>
  operations(): readonly EvmNativeOperation[]
  readOperation(operationId: string): Promise<EvmNativeOperation | undefined>
  /** Snapshot already filtered by journal/owned staging admission. No key derivation. */
  getCoins(): readonly EvmListCoin[]
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
    /** Conservative reviewed-policy upper bound, not the exact eventual selected fee. */
    async estimateLegacyFee(
      params: Pick<SendLegacyParams, 'recipient' | 'value'>,
    ): Promise<LegacyFeeEstimate> {
      if (params.value <= 0n)
        throw new RangeError('Transfer value must be positive')
      await options.refresh()
      const policy = options.preparer.transactionSetPolicy()
      const deliveryFee =
        policy.paymentGasLimit('0x', params.recipient.raw) * policy.gasPriceWei
      const inputFee = policy.changeGasLimit * policy.gasPriceWei
      const coins = options
        .getCoins()
        .filter(
          coin =>
            coin.state === 'unspent' &&
            !coin.holder &&
            (coin.spendableFromBlock === undefined ||
              coin.spendableFromBlock <= policy.head),
        )
      // A sufficient existing account bypasses consolidation. Otherwise bound every potentially
      // selected input; the constructor may choose fewer, but the quote never promises that.
      const spendable = (coin: EvmListCoin) => {
        const rule = policy.spendRule
        return rule?.waitBlocks &&
          coin.nonce > 0 &&
          (coin.lastSpentInBlock === undefined ||
            policy.head < coin.lastSpentInBlock + rule.waitBlocks)
          ? coin.valueWei - rule.belowWei
          : coin.valueWei
      }
      const sufficient = coins.some(
        coin => spendable(coin) >= params.value + deliveryFee,
      )
      const funded = coins.filter(coin => spendable(coin) > inputFee)
      const inputCount = sufficient ? 1 : Math.min(funded.length, 63)
      if (
        !inputCount ||
        (!sufficient &&
          funded.reduce((sum, coin) => sum + spendable(coin) - inputFee, 0n) <
            params.value + deliveryFee)
      )
        throw new RangeError('Insufficient unreserved native funds')
      const changeBound = BigInt(policy.maxChangeOutputs) * inputFee
      const consolidationFee = sufficient
        ? changeBound
        : BigInt(inputCount) * (inputFee + changeBound) + changeBound
      return {
        inputCount,
        deliveryFee,
        consolidationFee,
        totalFee: deliveryFee + consolidationFee,
      }
    },
    async sendLegacy(
      params: Pick<
        SendLegacyParams,
        | 'recipient'
        | 'value'
        | 'maxFee'
        | 'onProgress'
        | 'onSigned'
        | 'mainAccountWaitMs'
      >,
    ): Promise<LegacySendResult> {
      const request = { ...params, recipient: { ...params.recipient } }
      request.onProgress?.({ status: { stage: 'planning' } })
      await options.refresh()
      const operationId = `legacy-${hexlify(randomBytes(16)).slice(2)}`
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
