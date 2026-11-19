/**
 * Carries a planned swap out through the wallet's recorded spend path and reports what the chain
 * did with it. Nothing here signs or broadcasts on its own: every transaction goes through
 * `sendContractCall`, which journals the operation before signing and the signed bytes before
 * broadcast, so a crash or a timeout leaves a record that `reconcileSwap` finishes from.
 */

import type { UniswapV4Deployment } from '../chain/dex-deployments'
import type { EvmSwapCallRecord } from '../storage/evm-native-operation-journal'
import { SwapRecordMismatchError, type EvmDexPlan } from './evm-dex'
import {
  chargedGasPrice,
  estimateCallFee,
  readTokenBalance,
  swapRevertReasonOf,
  type GasChargedOn,
  type NetworkFeeEstimate,
  type SwapChainReader,
} from './evm-swap'
import type { EncodedCall, ReceiptLog } from './evm-swap-call'
import {
  readSwapOutcome,
  universalRouterInterface,
  type PoolRoute,
  type SwapRevertReason,
} from './uniswap-v4'

export interface SwapReceipt {
  /** Who sent the transaction and what it called, as the node reports them. */
  readonly from?: string
  readonly to?: string | null
  readonly status: number | null
  readonly blockNumber: number
  readonly gasUsed: bigint
  readonly gasPrice: bigint
  readonly logs: readonly ReceiptLog[]
}

export interface SwapExecutionReader extends SwapChainReader {
  getTransactionReceipt(hash: string): Promise<SwapReceipt | null>
  getTransaction(hash: string): Promise<unknown | null>
}

/** The wallet capabilities a swap uses. The EVM wallet handle provides them. */
export interface SwapWallet {
  sendContractCall(params: {
    to: { raw: string }
    data: string
    value: bigint
    gasLimit?: bigint
    /**
     * What this call is, for the wallet to record with it. The wallet keeps the record with the
     * signed transaction before it broadcasts, and writes the note to self that carries it;
     * the caller never does either.
     */
    record?: ContractCallRecord
    /** The deadline the call carries (block-time seconds): the wallet gives the call up rather
     * than hand it out again once the chain is past it. None for an approval. */
    deadline?: number
    onSigned?: (signed: {
      operationId: string
      txHash: string
    }) => Promise<void>
  }): Promise<{ operationId: string; txHash: string }>
  getContractCallFunds(): Promise<{
    mainAddress: string
    mainBalance: bigint
    otherBalance: bigint
    mainBusy: boolean
  }>
  fundMainAccount?(params: { value: bigint }): Promise<unknown>
  /** How many transfers a consolidation of `value` into the main account takes. */
  estimateLegacyFee?(params: {
    recipient: { raw: string }
    value: bigint
  }): Promise<{ inputCount: number }>
  resumeLegacySend?(operationId: string): Promise<unknown>
  /** Re-submits the same signed bytes of a recorded operation, then observes it. */
  resumeNativeOperation?(operationId: string): Promise<unknown>
  /** Contract calls this wallet signed that are not yet seen in a block. */
  getUnresolvedContractCalls?(): { operationId: string; txHash: string }[]
  /**
   * Gives up a call that was handed out and is not in a block: a transfer of nothing to itself
   * at the call's nonce, recorded before it is broadcast. Not proof the call did not land.
   */
  cancelContractCall?(
    operationId: string,
  ): Promise<
    | { state: 'call-included' }
    | { state: 'nonce-taken' }
    | { state: 'cancelling'; cancelTxHash: string }
  >
  reobserveNativeOperations?(): Promise<void>
}

/**
 * The record a swap's contract send carries: what goes in, what was quoted and the least that
 * may come out, the fees, the route. The wallet writes it to its journal with the call, before
 * anything is signed, and its note to self carries it once the call is included (or, for a call
 * given up past its deadline, once its cancellation is). The chain is
 * the wallet's own; the transaction id is the wallet's to add; what the swap then did is read
 * from the chain and is not part of the record.
 */
export type ContractCallRecord = EvmSwapCallRecord

export type SwapFailure =
  | SwapRevertReason
  | 'insufficient-native'
  | 'account-busy'
  | 'approval-failed'
  | 'insufficient-token'

export class SwapRefusedError extends Error {
  constructor(readonly reason: SwapFailure, message: string) {
    super(message)
    this.name = 'SwapRefusedError'
  }
}

export type SwapProgress =
  | { stage: 'recovering' }
  | { stage: 'consolidating' }
  | { stage: 'approving'; step: number; of: number; txHash?: string }
  | { stage: 'submitting' }
  | { stage: 'submitted'; txHash: string }

export type SwapResult =
  | {
      status: 'confirmed'
      txHash: string
      operationId: string
      /** From the receipt's logs. Undefined when the logs did not contain the swap. */
      amountIn?: bigint
      amountOut?: bigint
      /** Charged for the swap transaction itself, from its receipt. */
      feeWei: bigint
      /** Charged for every transaction this swap needed: consolidation, approvals, the swap. */
      totalFeeWei: bigint
    }
  | {
      status: 'reverted'
      txHash: string
      operationId: string
      reason?: SwapRevertReason
      feeWei: bigint
      totalFeeWei: bigint
    }
  /**
   * Never landed and never can: its deadline passed before it was in a block, and its nonce went
   * to the wallet's cancellation (`cancelTxHash`, whose fee is `feeWei`) or, without one, to
   * another transaction of the account (`feeWei` 0). Nothing was swapped.
   */
  | {
      status: 'cancelled'
      txHash: string
      operationId: string
      cancelTxHash?: string
      feeWei: bigint
      totalFeeWei: bigint
    }
  /** Handed to the network and not yet seen in a block. It may still land. */
  | { status: 'pending'; txHash: string; operationId: string }

/**
 * What the chain says of a recorded swap's cancellation (`SwapRecordItem.cancelTxHash`), for a
 * device of the account that did not make it. Sends nothing. `cancelled` once the chain shows
 * the cancellation in a block as what the wallet sends: a successful transfer of nothing from
 * `account` to itself; its fee is what the cancellation charged. `pending` while the node
 * returns no receipt (it is asked again later). Throws `SwapRecordMismatchError` when the chain
 * shows anything else under that hash: the record is not believed over the chain.
 */
export async function observeSwapCancellation(
  reader: Pick<SwapExecutionReader, 'getTransactionReceipt' | 'getTransaction'>,
  input: { cancelTxHash: string; account: string },
): Promise<{ status: 'cancelled'; feeWei: bigint } | { status: 'pending' }> {
  const receipt = await reader.getTransactionReceipt(input.cancelTxHash)
  if (!receipt) return { status: 'pending' }
  const same = (a: string | null | undefined) =>
    typeof a === 'string' && a.toLowerCase() === input.account.toLowerCase()
  const tx = (await reader.getTransaction(input.cancelTxHash)) as {
    value?: bigint
  } | null
  if (
    receipt.status !== 1 ||
    !same(receipt.from) ||
    !same(receipt.to) ||
    !tx ||
    tx.value !== 0n
  )
    throw new SwapRecordMismatchError()
  return { status: 'cancelled', feeWei: receipt.gasUsed * receipt.gasPrice }
}

export interface SwapTiming {
  /** How long to watch for a transaction's inclusion before reporting it pending. */
  inclusionTimeoutMs: number
  pollMs: number
  sleep: (ms: number) => Promise<void>
}

export const DEFAULT_SWAP_TIMING: SwapTiming = {
  inclusionTimeoutMs: 90_000,
  pollMs: 1_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

type Handle = { operationId: string; txHash: string }

/** Multiples of `pollMs` between receipt reads: quick at first, then every five. */
const RECEIPT_BACKOFF = [1, 1, 2, 3, 5]

async function awaitReceipt(
  reader: SwapExecutionReader,
  txHash: string,
  timing: SwapTiming,
): Promise<SwapReceipt | undefined> {
  for (let waited = 0, attempt = 0; ; attempt++) {
    const receipt = await reader.getTransactionReceipt(txHash).catch(() => null)
    if (receipt) return receipt
    if (waited >= timing.inclusionTimeoutMs) return undefined
    const wait =
      timing.pollMs *
      RECEIPT_BACKOFF[Math.min(attempt, RECEIPT_BACKOFF.length - 1)]!
    await timing.sleep(wait)
    waited += wait
  }
}

/**
 * Watches a submitted transaction to its receipt. If none arrives and the node does not know the
 * transaction at all (the broadcast was lost), the wallet re-submits the same recorded operation
 * (the same signed bytes, never a new transaction) and the watch starts again, once.
 */
export async function settle(
  reader: SwapExecutionReader,
  wallet: Pick<SwapWallet, 'resumeNativeOperation'>,
  handle: Handle,
  timing: SwapTiming,
  firstWait: SwapTiming = timing,
): Promise<SwapReceipt | undefined> {
  const receipt = await awaitReceipt(reader, handle.txHash, firstWait)
  if (receipt || !wallet.resumeNativeOperation) return receipt
  // A node that could not answer is not a node that does not know the transaction.
  const known = await reader
    .getTransaction(handle.txHash)
    .catch(() => 'unknown')
  if (known !== null) return undefined
  await wallet.resumeNativeOperation(handle.operationId).catch(() => {
    /* Still unresolved: the caller reports it pending and it is looked at again later. */
  })
  return awaitReceipt(reader, handle.txHash, timing)
}

/** What watching a swap found: its own receipt, or that it was given up past its deadline. */
type SwapSettlement =
  | { receipt: SwapReceipt }
  | { cancelled: { cancelTxHash?: string; feeWei: bigint } }
  | undefined

/** Whether the chain's newest block is past `deadline` (seconds): a swap still unmined then is
 * certain to revert (the router refuses once `block.timestamp > deadline`). */
async function deadlinePassed(
  reader: SwapExecutionReader,
  deadline: number | undefined,
): Promise<boolean> {
  if (deadline === undefined || !reader.getBlock) return false
  const block = await reader.getBlock('latest').catch(() => null)
  return typeof block?.timestamp === 'number' && block.timestamp > deadline
}

/** The first of `hashes` the chain shows in a block, watched as `awaitReceipt` watches one. */
async function awaitFirstReceipt(
  reader: SwapExecutionReader,
  hashes: readonly string[],
  timing: SwapTiming,
): Promise<{ hash: string; receipt: SwapReceipt } | undefined> {
  for (let waited = 0, attempt = 0; ; attempt++) {
    for (const hash of hashes) {
      const receipt = await reader.getTransactionReceipt(hash).catch(() => null)
      if (receipt) return { hash, receipt }
    }
    if (waited >= timing.inclusionTimeoutMs) return undefined
    const wait =
      timing.pollMs *
      RECEIPT_BACKOFF[Math.min(attempt, RECEIPT_BACKOFF.length - 1)]!
    await timing.sleep(wait)
    waited += wait
  }
}

/**
 * A swap past its deadline, not in a block: re-sending it would only buy a revert at the full
 * swap fee. It is cancelled instead (the wallet's transfer of nothing to itself at the same
 * nonce), and both are watched: what the chain includes is what is reported. When the wallet
 * cannot cancel (it would cost more than the swap was allowed to, or the account cannot pay)
 * the swap is left as it is, neither re-sent nor given up, and reported pending.
 */
async function cancelExpired(
  reader: SwapExecutionReader,
  cancel: NonNullable<SwapWallet['cancelContractCall']>,
  handle: Handle,
  timing: SwapTiming,
): Promise<SwapSettlement> {
  const own = async (): Promise<SwapSettlement> => {
    const receipt = await reader.getTransactionReceipt(handle.txHash).catch(() => null)
    return receipt ? { receipt } : undefined
  }
  let outcome: Awaited<ReturnType<typeof cancel>>
  try {
    outcome = await cancel(handle.operationId)
  } catch {
    return own()
  }
  if (outcome.state === 'call-included') return own()
  // The wallet saw the nonce taken and no receipt of the swap's: it can never land.
  if (outcome.state === 'nonce-taken')
    return (await own()) ?? { cancelled: { feeWei: 0n } }
  const landed = await awaitFirstReceipt(
    reader,
    [handle.txHash, outcome.cancelTxHash],
    timing,
  )
  if (!landed) return undefined
  if (landed.hash === handle.txHash) return { receipt: landed.receipt }
  return {
    cancelled: {
      cancelTxHash: outcome.cancelTxHash,
      feeWei: landed.receipt.gasUsed * landed.receipt.gasPrice,
    },
  }
}

/**
 * Watches a submitted swap as `settle` does, except once its deadline (`deadline`, seconds, by
 * the chain's block time) has passed: then it is not re-sent but cancelled (`cancelExpired`).
 */
export async function settleSwap(
  reader: SwapExecutionReader,
  wallet: Pick<SwapWallet, 'resumeNativeOperation' | 'cancelContractCall'>,
  handle: Handle,
  deadline: number | undefined,
  timing: SwapTiming,
  firstWait: SwapTiming = timing,
): Promise<SwapSettlement> {
  const receipt = await awaitReceipt(reader, handle.txHash, firstWait)
  if (receipt) return { receipt }
  if (wallet.cancelContractCall && (await deadlinePassed(reader, deadline)))
    return cancelExpired(reader, wallet.cancelContractCall, handle, timing)
  if (!wallet.resumeNativeOperation) return undefined
  // A node that could not answer is not a node that does not know the transaction.
  const known = await reader
    .getTransaction(handle.txHash)
    .catch(() => 'unknown')
  if (known !== null) return undefined
  await wallet.resumeNativeOperation(handle.operationId).catch(() => {
    /* Still unresolved: the caller reports it pending and it is looked at again later. */
  })
  const again = await awaitReceipt(reader, handle.txHash, timing)
  return again ? { receipt: again } : undefined
}

/** The deadline (seconds) a Universal Router `execute` call carries; undefined for any other. */
export function swapDeadlineOf(data: string): number | undefined {
  try {
    const deadline = universalRouterInterface.decodeFunctionData('execute', data)[2] as bigint
    return deadline <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(deadline) : undefined
  } catch {
    return undefined
  }
}

/** A submission whose outcome the wallet could not learn still names the exact transaction. */
function submittedHandle(error: unknown): Handle | undefined {
  const e = error as {
    transaction?: { txHash?: unknown }
    operation?: { operationId?: unknown }
  } | null
  return typeof e?.transaction?.txHash === 'string' &&
    e.transaction.txHash.length > 0 &&
    typeof e.operation?.operationId === 'string'
    ? { txHash: e.transaction.txHash, operationId: e.operation.operationId }
    : undefined
}

/**
 * The main account's funds, after first driving any earlier contract call of this wallet that is
 * still unresolved (a lost approval, a swap from a closed page) to an end: each is re-submitted
 * as recorded and watched. Refuses while one of them is still not in a block.
 */
async function readyFunds(
  reader: SwapExecutionReader,
  wallet: SwapWallet,
  account: string,
  timing: SwapTiming,
  onProgress?: (progress: SwapProgress) => void,
) {
  let funds = await wallet.getContractCallFunds()
  // The quote, the allowance and the balances were read for `account`; the wallet signs from
  // its main account. They must be the same account.
  if (funds.mainAddress.toLowerCase() !== account.toLowerCase())
    throw new Error('The swap account is not the wallet main account')
  if (funds.mainBusy) {
    const unresolved = wallet.getUnresolvedContractCalls?.() ?? []
    if (unresolved.length > 0 && wallet.resumeNativeOperation) {
      onProgress?.({ stage: 'recovering' })
      for (const handle of unresolved) {
        await wallet.resumeNativeOperation(handle.operationId).catch(() => {
          /* Reported below if it is still unresolved. */
        })
        await awaitReceipt(reader, handle.txHash, timing)
      }
      funds = await wallet.getContractCallFunds()
    }
  }
  if (funds.mainBusy)
    throw new SwapRefusedError(
      'account-busy',
      'An earlier transaction from this account has not confirmed yet',
    )
  return funds
}

const insufficient = () =>
  new SwapRefusedError(
    'insufficient-native',
    'Not enough of the native coin for this amount and its network fee',
  )

/**
 * Gas allowed for when a call cannot be estimated yet because the account does not hold its
 * value. Used only to size the one consolidation into the user's own main account; the gas limit
 * that is signed always comes from `eth_estimateGas`. Real single-pool swaps on Monad testnet
 * estimated 190,000 to 217,000 gas, an approval up to 105,000.
 */
export const UNESTIMATED_SWAP_GAS = 400_000n
export const UNESTIMATED_APPROVAL_GAS = 150_000n

export interface ConsolidationNeed {
  /** What must be moved from the wallet's other accounts into the main account first. */
  readonly moveWei: bigint
  /** False when the wallet's other accounts cannot cover it. */
  readonly possible: boolean
}

/**
 * Whether the main account can pay for this plan alone and, if not, how much has to be moved in
 * from the wallet's other accounts first. That move is the wallet's consolidation for a contract
 * call (fund one owned account, wait, then send the external transaction); it happens at most
 * once per swap and only for the amount returned here, which the user is shown and confirms.
 */
export async function consolidationNeeded(params: {
  reader: SwapChainReader
  wallet: Pick<SwapWallet, 'getContractCallFunds'>
  plan: Pick<EvmDexPlan, 'approvals' | 'swap'>
  /** The swap's fee when it could already be estimated. */
  swapFee?: NetworkFeeEstimate
}): Promise<ConsolidationNeed> {
  const { plan } = params
  const funds = await params.wallet.getContractCallFunds()
  let maxFeePerGas = params.swapFee?.maxFeePerGas
  if (maxFeePerGas === undefined) {
    const fees = await params.reader.getFeeData()
    maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? undefined
    if (maxFeePerGas === undefined)
      throw new Error('Network fee quote unavailable')
  }
  const gas =
    BigInt(plan.approvals.length) * UNESTIMATED_APPROVAL_GAS +
    (params.swapFee?.gasLimit ?? UNESTIMATED_SWAP_GAS)
  const needed = plan.swap.value + gas * maxFeePerGas
  const moveWei = needed > funds.mainBalance ? needed - funds.mainBalance : 0n
  return { moveWei, possible: moveWei <= funds.otherBalance }
}

/** The network fee a finished consolidation reports, when it reports one. */
const feePaid = (result: unknown): bigint => {
  const fee = (result as { totalFeePaid?: unknown } | null)?.totalFeePaid
  return typeof fee === 'bigint' ? fee : 0n
}

export interface SwapCostLine {
  readonly kind: 'consolidation' | 'approval' | 'swap'
  /** What the network will charge for it; undefined when it cannot be known yet. */
  readonly feeWei?: bigint
}

export interface SwapCost {
  /** Every transaction the swap needs, in the order they are sent. */
  readonly transactions: readonly SwapCostLine[]
  /** The sum of the fees that are known. */
  readonly networkFeeWei: bigint
  /**
   * False when a fee is not known yet: a token swap cannot be gas-estimated until its approvals
   * have confirmed. The total is then a floor, and the form says so instead of guessing.
   */
  readonly complete: boolean
  /** The swap transaction's own estimate, when it could be made. */
  readonly swapFee?: NetworkFeeEstimate
}

/**
 * What the whole swap will cost in network fees: the transfer(s) of a consolidation, each
 * approval, and the swap, each as the network will charge it (see `gasChargedOn`): what leaves
 * the account, not an upper bound.
 */
export async function estimateSwapCost(params: {
  reader: SwapChainReader
  wallet: Pick<SwapWallet, 'estimateLegacyFee'>
  plan: Pick<EvmDexPlan, 'approvals' | 'swap'>
  account: string
  /** What `consolidationNeeded` said must be moved in first. */
  moveWei?: bigint
  /** The network's rule, from its registry row. */
  gasChargedOn?: GasChargedOn
}): Promise<SwapCost> {
  const { reader, plan, account } = params
  const transactions: SwapCostLine[] = []
  let complete = true
  if (params.moveWei && params.moveWei > 0n) {
    let feeWei: bigint | undefined
    try {
      const [{ inputCount }, price] = await Promise.all([
        params.wallet.estimateLegacyFee!({
          recipient: { raw: account },
          value: params.moveWei,
        }),
        chargedGasPrice(reader),
      ])
      feeWei = 21_000n * BigInt(inputCount) * price.chargedPerGas
    } catch {
      complete = false
    }
    transactions.push({ kind: 'consolidation', feeWei })
  }
  for (const { call } of plan.approvals) {
    const fee = await estimateCallFee(
      reader,
      call,
      account,
      params.gasChargedOn,
    ).catch(() => undefined)
    if (!fee) complete = false
    transactions.push({ kind: 'approval', feeWei: fee?.chargedFeeWei })
  }
  // The swap pulls the token through the allowance, so until that exists it cannot be estimated.
  const swapFee =
    plan.approvals.length === 0
      ? await estimateCallFee(
          reader,
          plan.swap,
          account,
          params.gasChargedOn,
        ).catch(() => undefined)
      : undefined
  if (!swapFee) complete = false
  transactions.push({ kind: 'swap', feeWei: swapFee?.chargedFeeWei })
  return {
    transactions,
    networkFeeWei: transactions.reduce((sum, t) => sum + (t.feeWei ?? 0n), 0n),
    complete,
    swapFee,
  }
}

/**
 * How large the network fee is beside the amount being swapped, in percent, when the two are in
 * the same asset (the native coin is paid in, or paid out). Undefined otherwise: no conversion
 * between assets is invented.
 */
export function networkFeeShare(params: {
  networkFeeWei: bigint
  quote: {
    tokenIn: { address: string | null }
    tokenOut: { address: string | null }
    amountIn: bigint
    amountOut: bigint
  }
}): number | undefined {
  const { quote } = params
  const amount =
    quote.tokenIn.address === null
      ? quote.amountIn
      : quote.tokenOut.address === null
      ? quote.amountOut
      : undefined
  if (amount === undefined || amount <= 0n) return undefined
  return Number((params.networkFeeWei * 10_000n) / amount) / 100
}

async function consolidate(
  wallet: SwapWallet,
  value: bigint,
  timing: SwapTiming,
): Promise<bigint> {
  if (!wallet.fundMainAccount) throw insufficient()
  try {
    return feePaid(await wallet.fundMainAccount({ value }))
  } catch (error) {
    // The consolidation was signed and submitted but not yet seen included: finish that same
    // operation, never start another.
    const pending = submittedHandle(error)
    if (!pending || !wallet.resumeLegacySend) throw error
    for (let waited = 0; ; waited += timing.pollMs) {
      await timing.sleep(timing.pollMs)
      try {
        return feePaid(await wallet.resumeLegacySend(pending.operationId))
      } catch (again) {
        if (!submittedHandle(again) || waited >= timing.inclusionTimeoutMs)
          throw again
      }
    }
  }
}

async function feeOrRefusal(
  reader: SwapChainReader,
  call: EncodedCall,
  account: string,
  gasChargedOn?: GasChargedOn,
): Promise<NetworkFeeEstimate> {
  try {
    return await estimateCallFee(reader, call, account, gasChargedOn)
  } catch (error) {
    const reason = swapRevertReasonOf(error)
    if (reason)
      throw new SwapRefusedError(reason, 'The swap would fail if sent now')
    throw error
  }
}

async function send(
  wallet: SwapWallet,
  call: EncodedCall,
  gasLimit: bigint,
  onSigned?: (signed: Handle) => Promise<void>,
  record?: ContractCallRecord,
  deadline?: number,
): Promise<Handle> {
  try {
    return await wallet.sendContractCall({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      gasLimit,
      ...(record ? { record } : {}),
      ...(deadline === undefined ? {} : { deadline }),
      onSigned,
    })
  } catch (error) {
    const submitted = submittedHandle(error)
    if (submitted) return submitted
    throw error
  }
}

/** What a confirmed swap paid in and what the account received, read from its receipt's logs. */
export type SwapOutcomeReader = (
  logs: readonly ReceiptLog[],
) => { amountIn: bigint; amountOut: bigint } | undefined

/**
 * How a swap's outcome is read from its receipt: an exchange's own reader, or, for Uniswap v4,
 * its deployment and the pool route the swap took.
 */
export type SwapOutcomeSource =
  | { deployment: UniswapV4Deployment; route: PoolRoute }
  | { readOutcome: SwapOutcomeReader }

function outcomeReaderOf(
  source: SwapOutcomeSource,
  account: string,
): SwapOutcomeReader {
  if ('readOutcome' in source) return source.readOutcome
  return logs =>
    readSwapOutcome({
      deployment: source.deployment,
      route: source.route,
      account,
      logs,
    })
}

/** What the chain says a submitted swap did. Never falls back to the quote. */
export async function readSwapResult(params: SwapOutcomeSource & {
  reader: SwapExecutionReader
  account: string
  /** The call that was sent, when known: a reverted swap is asked why with it. */
  swap?: EncodedCall
  handle: Handle
  receipt: SwapReceipt
  /** Fees already charged for this swap's earlier transactions. */
  earlierFeesWei?: bigint
}): Promise<SwapResult> {
  const { receipt, handle } = params
  const feeWei = receipt.gasUsed * receipt.gasPrice
  const totalFeeWei = feeWei + (params.earlierFeesWei ?? 0n)
  if (receipt.status === 1) {
    const outcome = outcomeReaderOf(params, params.account)(receipt.logs)
    return { status: 'confirmed', ...handle, ...outcome, feeWei, totalFeeWei }
  }
  // The receipt carries no revert data: ask the node what the same call does at the block it
  // failed in (that block's time and prices). Asked later, at the latest block, every expired
  // swap would read as "deadline" whatever actually stopped it.
  let reason: SwapRevertReason | undefined
  if (!params.swap)
    return { status: 'reverted', ...handle, feeWei, totalFeeWei }
  try {
    await params.reader.call({
      ...params.swap,
      from: params.account,
      blockTag: receipt.blockNumber,
    })
  } catch (error) {
    reason = swapRevertReasonOf(error)
  }
  return { status: 'reverted', ...handle, reason, feeWei, totalFeeWei }
}

/**
 * Carries out a confirmed plan: first, at most once and only for the amount the user confirmed,
 * the move of native coin from the wallet's other accounts into the main account; then any
 * approvals (each for the exact amount, each watched into a block); then the swap, watched to
 * its receipt. `onSigned` is called with the swap's operation and transaction ids after it is
 * signed and journaled and before it is broadcast: record them durably there. If `onSigned`
 * throws, nothing is broadcast.
 */
export async function executeSwap(params: (
  | { deployment: UniswapV4Deployment }
  | { readOutcome: SwapOutcomeReader }
) & {
  reader: SwapExecutionReader
  wallet: SwapWallet
  plan: EvmDexPlan
  account: string
  /** The amount the user confirmed may be moved into the main account first; none by default. */
  consolidateWei?: bigint
  /** Passed to the wallet with the swap transaction (never with an approval). `networkFeeWei`
   * is filled in here from the fee the transaction is sent with. */
  record?: Omit<ContractCallRecord, 'networkFeeWei'>
  /** The network's rule, from its registry row; decides the fee the record states. */
  gasChargedOn?: GasChargedOn
  onProgress?: (progress: SwapProgress) => void
  onSigned?: (signed: Handle) => Promise<void>
  timing?: SwapTiming
}): Promise<SwapResult> {
  const { reader, wallet, plan, account, onProgress } = params
  const timing = params.timing ?? DEFAULT_SWAP_TIMING
  // One read of the wallet's funds per swap. From here on the wallet's own check, made when
  // each call is planned, is what refuses a call the main account cannot pay for.
  const funds = await readyFunds(reader, wallet, account, timing, onProgress)
  // A token paid in must be in the account now: otherwise the swap cannot succeed, and nothing
  // (no consolidation, no approval) is paid for. The native coin is covered by the funds above.
  const { tokenIn, amountIn } = plan.quote
  if (
    tokenIn.address !== null &&
    (await readTokenBalance(reader, tokenIn, account)) < amountIn
  )
    throw new SwapRefusedError(
      'insufficient-token',
      `The account holds less ${tokenIn.symbol} than this swap pays in`,
    )
  const move = params.consolidateWei ?? 0n
  let earlierFeesWei = 0n
  if (move > 0n) {
    if (funds.otherBalance < move) throw insufficient()
    onProgress?.({ stage: 'consolidating' })
    earlierFeesWei += await consolidate(wallet, move, timing)
  }

  for (let i = 0; i < plan.approvals.length; i++) {
    const { call } = plan.approvals[i]!
    onProgress?.({ stage: 'approving', step: i + 1, of: plan.approvals.length })
    const fee = await feeOrRefusal(reader, call, account)
    const handle = await send(wallet, call, fee.gasLimit)
    onProgress?.({
      stage: 'approving',
      step: i + 1,
      of: plan.approvals.length,
      txHash: handle.txHash,
    })
    const receipt = await settle(reader, wallet, handle, timing)
    await wallet.reobserveNativeOperations?.()
    if (receipt) earlierFeesWei += receipt.gasUsed * receipt.gasPrice
    if (receipt?.status !== 1)
      throw new SwapRefusedError(
        'approval-failed',
        receipt
          ? 'The approval transaction failed'
          : 'The approval has not confirmed yet',
      )
  }

  const fee = await feeOrRefusal(
    reader,
    plan.swap,
    account,
    params.gasChargedOn,
  )
  onProgress?.({ stage: 'submitting' })
  const handle = await send(
    wallet,
    plan.swap,
    fee.gasLimit,
    params.onSigned,
    params.record
      ? { ...params.record, networkFeeWei: fee.chargedFeeWei.toString() }
      : undefined,
    plan.deadline,
  )
  onProgress?.({ stage: 'submitted', txHash: handle.txHash })
  const settled = await settleSwap(reader, wallet, handle, plan.deadline, timing)
  if (settled && 'cancelled' in settled) {
    await wallet.reobserveNativeOperations?.()
    return cancelledResult(handle, settled.cancelled, earlierFeesWei)
  }
  const receipt = settled?.receipt
  // The wallet now reads the same inclusion into its journal and starts the note to self that
  // carries the swap's record. Nothing is re-sent for a transaction already in a block, and
  // the note is the wallet's to retry: neither can change what the swap did.
  if (receipt)
    try {
      await wallet.resumeNativeOperation?.(handle.operationId)
    } catch {
      /* A reverted call, or a note not sent yet: the result below is still the chain's. */
    }
  else await wallet.reobserveNativeOperations?.()
  if (!receipt) return { status: 'pending', ...handle }
  return readSwapResult({
    ...('readOutcome' in params
      ? { readOutcome: params.readOutcome }
      : {
          deployment: params.deployment,
          route: plan.quote.route as PoolRoute,
        }),
    reader,
    account,
    swap: plan.swap,
    handle,
    receipt,
    earlierFeesWei,
  })
}

/**
 * Finishes a swap that was recorded as submitted but whose outcome is unknown (the page closed,
 * the node timed out). If the chain has it, reports what it did. If the chain has never seen it,
 * re-submits the same signed transaction through the wallet (never a new one) and watches again;
 * past the swap's deadline it is cancelled instead (`settleSwap`), and what lands is reported.
 */
export async function reconcileSwap(params: SwapOutcomeSource & {
  reader: SwapExecutionReader
  wallet: Pick<
    SwapWallet,
    'resumeNativeOperation' | 'reobserveNativeOperations' | 'cancelContractCall'
  >
  account: string
  swap: EncodedCall
  handle: Handle
  /** The deadline the swap call carries (seconds); read from a Universal Router call if absent. */
  deadline?: number
  timing?: SwapTiming
}): Promise<SwapResult> {
  const timing = params.timing ?? DEFAULT_SWAP_TIMING
  const settled = await settleSwap(
    params.reader,
    params.wallet,
    params.handle,
    params.deadline ?? swapDeadlineOf(params.swap.data),
    timing,
    { ...timing, inclusionTimeoutMs: 0 },
  )
  await params.wallet.reobserveNativeOperations?.()
  if (!settled) return { status: 'pending', ...params.handle }
  if ('cancelled' in settled)
    return cancelledResult(params.handle, settled.cancelled)
  return readSwapResult({ ...params, receipt: settled.receipt })
}

function cancelledResult(
  handle: Handle,
  cancelled: { cancelTxHash?: string; feeWei: bigint },
  earlierFeesWei = 0n,
): SwapResult {
  return {
    status: 'cancelled',
    ...handle,
    ...(cancelled.cancelTxHash ? { cancelTxHash: cancelled.cancelTxHash } : {}),
    feeWei: cancelled.feeWei,
    totalFeeWei: cancelled.feeWei + earlierFeesWei,
  }
}
