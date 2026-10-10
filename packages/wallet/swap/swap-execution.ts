/**
 * Carries a planned swap out through the wallet's recorded spend path and reports what the chain
 * did with it. Nothing here signs or broadcasts on its own: every transaction goes through
 * `sendContractCall`, which journals the operation before signing and the signed bytes before
 * broadcast, so a crash or a timeout leaves a record that `reconcileSwap` finishes from.
 */

import type { UniswapV4Deployment } from '../chain/dex-deployments'
import {
  estimateCallFee,
  swapRevertReasonOf,
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
  resumeLegacySend?(operationId: string): Promise<unknown>
  /** Re-submits the same signed bytes of a recorded operation, then observes it. */
  resumeNativeOperation?(operationId: string): Promise<unknown>
  /** Contract calls this wallet signed that are not yet seen in a block. */
  getUnresolvedContractCalls?(): { operationId: string; txHash: string }[]
  reobserveNativeOperations?(): Promise<void>
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
      feeWei: bigint
    }
  | {
      status: 'reverted'
      txHash: string
      operationId: string
      reason?: SwapRevertReason
      feeWei: bigint
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

async function awaitReceipt(
  reader: SwapExecutionReader,
  txHash: string,
  timing: SwapTiming,
): Promise<SwapReceipt | undefined> {
  for (let waited = 0; ; waited += timing.pollMs) {
    const receipt = await reader.getTransactionReceipt(txHash).catch(() => null)
    if (receipt) return receipt
    if (waited >= timing.inclusionTimeoutMs) return undefined
    await timing.sleep(timing.pollMs)
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

async function consolidate(
  wallet: SwapWallet,
  value: bigint,
  timing: SwapTiming,
): Promise<void> {
  if (!wallet.fundMainAccount) throw insufficient()
  try {
    await wallet.fundMainAccount({ value })
  } catch (error) {
    // The consolidation was signed and submitted but not yet seen included: finish that same
    // operation, never start another.
    const pending = submittedHandle(error)
    if (!pending || !wallet.resumeLegacySend) throw error
    for (let waited = 0; ; waited += timing.pollMs) {
      await timing.sleep(timing.pollMs)
      try {
        await wallet.resumeLegacySend(pending.operationId)
        break
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
): Promise<NetworkFeeEstimate> {
  try {
    return await estimateCallFee(reader, call, account)
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
): Promise<Handle> {
  try {
    return await wallet.sendContractCall({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      gasLimit,
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
}): Promise<SwapResult> {
  const { receipt, handle } = params
  const feeWei = receipt.gasUsed * receipt.gasPrice
  if (receipt.status === 1) {
    const outcome = readSwapOutcome({
      deployment: params.deployment,
      route: params.route,
      account: params.account,
      logs: receipt.logs,
    })
    return { status: 'confirmed', ...handle, ...outcome, feeWei }
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
  return { status: 'reverted', ...handle, reason, feeWei }
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
  if (move > 0n) {
    if (funds.otherBalance < move) throw insufficient()
    onProgress?.({ stage: 'consolidating' })
    await consolidate(wallet, move, timing)
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
    if (receipt?.status !== 1)
      throw new SwapRefusedError(
        'approval-failed',
        receipt
          ? 'The approval transaction failed'
          : 'The approval has not confirmed yet',
      )
  }

  const fee = await feeOrRefusal(reader, plan.swap, account)
  onProgress?.({ stage: 'signing' })
  const handle = await send(wallet, plan.swap, fee.gasLimit, params.onSigned)
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
