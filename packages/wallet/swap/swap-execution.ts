/**
 * Carries a planned swap out through the wallet's recorded spend path and reports what the chain
 * did with it. Nothing here signs or broadcasts on its own: every transaction goes through
 * `sendContractCall`, which journals the operation before signing and the signed bytes before
 * broadcast, so a crash or a timeout leaves a record that `reconcileSwap` finishes from.
 */

import type { UniswapV4Deployment } from '../chain/dex-deployments'
import {
  chargedGasPrice,
  estimateCallFee,
  swapRevertReasonOf,
  type GasChargedOn,
  type NetworkFeeEstimate,
  type SwapChainReader,
  type SwapPlan,
} from './evm-swap'
import {
  readSwapOutcome,
  type EncodedCall,
  type PoolRoute,
  type ReceiptLog,
  type SwapRevertReason,
} from './uniswap-v4'

export interface SwapReceipt {
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
  reobserveNativeOperations?(): Promise<void>
}

/**
 * The record a swap's contract send carries. The same fields on every chain family: where, on
 * which exchange, what goes in, what was quoted and the least that may come out, the fees. The
 * transaction id is the wallet's to add once it has signed; what the swap then did is read
 * from the chain by that id and is not part of the record.
 */
export interface ContractCallRecord {
  readonly kind: 'swap'
  readonly chainIdentifier: string
  readonly venueId: string
  readonly account: string
  readonly assetIn: { symbol: string; address: string | null; decimals: number }
  readonly amountIn: bigint
  readonly assetOut: {
    symbol: string
    address: string | null
    decimals: number
  }
  readonly quotedAmountOut: bigint
  readonly minimumAmountOut: bigint
  /** Frank's fee, in the output asset; zero when the exchange has none. */
  readonly interfaceFeeAmount: bigint
  /** The network fee the swap transaction reserves, in the chain's native coin. */
  readonly networkFeeWei: bigint
  /** The exchange's own description of the route; needed to read the outcome later. */
  readonly route: unknown
}

export type SwapFailure =
  | SwapRevertReason
  | 'insufficient-native'
  | 'account-busy'
  | 'approval-failed'

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
  | { stage: 'signing' }
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
  /** Handed to the network and not yet seen in a block. It may still land. */
  | { status: 'pending'; txHash: string; operationId: string }

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
async function settle(
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
  plan: SwapPlan
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
  plan: SwapPlan
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
): Promise<Handle> {
  try {
    return await wallet.sendContractCall({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      gasLimit,
      ...(record ? { record } : {}),
      onSigned,
    })
  } catch (error) {
    const submitted = submittedHandle(error)
    if (submitted) return submitted
    throw error
  }
}

/** What the chain says a submitted swap did. Never falls back to the quote. */
export async function readSwapResult(params: {
  reader: SwapExecutionReader
  deployment: UniswapV4Deployment
  route: PoolRoute
  account: string
  swap: EncodedCall
  handle: Handle
  receipt: SwapReceipt
  /** Fees already charged for this swap's earlier transactions. */
  earlierFeesWei?: bigint
}): Promise<SwapResult> {
  const { receipt, handle } = params
  const feeWei = receipt.gasUsed * receipt.gasPrice
  const totalFeeWei = feeWei + (params.earlierFeesWei ?? 0n)
  if (receipt.status === 1) {
    const outcome = readSwapOutcome({
      deployment: params.deployment,
      route: params.route,
      account: params.account,
      logs: receipt.logs,
    })
    return { status: 'confirmed', ...handle, ...outcome, feeWei, totalFeeWei }
  }
  // The receipt carries no revert data: ask the node what the same call does at the block it
  // failed in (that block's time and prices). Asked later, at the latest block, every expired
  // swap would read as "deadline" whatever actually stopped it.
  let reason: SwapRevertReason | undefined
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
export async function executeSwap(params: {
  reader: SwapExecutionReader
  wallet: SwapWallet
  deployment: UniswapV4Deployment
  plan: SwapPlan
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
  onProgress?.({ stage: 'signing' })
  const handle = await send(
    wallet,
    plan.swap,
    fee.gasLimit,
    params.onSigned,
    params.record
      ? { ...params.record, networkFeeWei: fee.chargedFeeWei }
      : undefined,
  )
  onProgress?.({ stage: 'submitted', txHash: handle.txHash })
  const receipt = await settle(reader, wallet, handle, timing)
  await wallet.reobserveNativeOperations?.()
  if (!receipt) return { status: 'pending', ...handle }
  return readSwapResult({
    reader,
    deployment: params.deployment,
    route: plan.quote.route,
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
 * re-submits the same signed transaction through the wallet (never a new one) and watches again.
 */
export async function reconcileSwap(params: {
  reader: SwapExecutionReader
  wallet: Pick<
    SwapWallet,
    'resumeNativeOperation' | 'reobserveNativeOperations'
  >
  deployment: UniswapV4Deployment
  route: PoolRoute
  account: string
  swap: EncodedCall
  handle: Handle
  timing?: SwapTiming
}): Promise<SwapResult> {
  const timing = params.timing ?? DEFAULT_SWAP_TIMING
  const receipt = await settle(
    params.reader,
    params.wallet,
    params.handle,
    timing,
    { ...timing, inclusionTimeoutMs: 0 },
  )
  await params.wallet.reobserveNativeOperations?.()
  if (!receipt) return { status: 'pending', ...params.handle }
  return readSwapResult({ ...params, receipt })
}
