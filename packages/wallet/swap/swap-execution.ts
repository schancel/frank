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
    onSigned?: (signed: { operationId: string; txHash: string }) => Promise<void>
  }): Promise<{ operationId: string; txHash: string }>
  getContractCallFunds(): Promise<{
    mainAddress: string
    mainBalance: bigint
    otherBalance: bigint
    mainBusy: boolean
  }>
  fundMainAccount?(params: { value: bigint }): Promise<unknown>
  resumeLegacySend?(operationId: string): Promise<unknown>
  resumeNativeOperation?(operationId: string): Promise<unknown>
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

async function awaitReceipt(
  reader: SwapExecutionReader,
  txHash: string,
  timing: SwapTiming,
): Promise<SwapReceipt | undefined> {
  for (let waited = 0; ; waited += timing.pollMs) {
    const receipt = await reader
      .getTransactionReceipt(txHash)
      .catch(() => null)
    if (receipt) return receipt
    if (waited >= timing.inclusionTimeoutMs) return undefined
    await timing.sleep(timing.pollMs)
  }
}

/** A submission whose outcome the wallet could not learn still names the exact transaction. */
function submittedHandle(
  error: unknown,
): { operationId: string; txHash: string } | undefined {
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
 * Makes sure the main account holds `needed` of the native coin, moving the shortfall in from
 * the wallet's other accounts when it does not. That is the wallet's existing consolidation for
 * a contract call: fund one owned account, wait for it, then send the external transaction.
 */
async function ensureMainHolds(
  wallet: SwapWallet,
  needed: bigint,
  timing: SwapTiming,
  onProgress?: (progress: SwapProgress) => void,
): Promise<void> {
  const funds = await wallet.getContractCallFunds()
  if (funds.mainBusy)
    throw new SwapRefusedError(
      'account-busy',
      'An earlier transaction from this account has not confirmed yet',
    )
  if (funds.mainBalance >= needed) return
  const shortfall = needed - funds.mainBalance
  if (!wallet.fundMainAccount || funds.otherBalance < shortfall)
    throw new SwapRefusedError(
      'insufficient-native',
      'Not enough of the native coin for this amount and its network fee',
    )
  onProgress?.({ stage: 'consolidating' })
  try {
    await wallet.fundMainAccount({ value: shortfall })
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
  const after = await wallet.getContractCallFunds()
  if (after.mainBalance < needed)
    throw new SwapRefusedError(
      'insufficient-native',
      'Not enough of the native coin for this amount and its network fee',
    )
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
  onSigned?: (signed: { operationId: string; txHash: string }) => Promise<void>,
): Promise<{ operationId: string; txHash: string }> {
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
  handle: { operationId: string; txHash: string }
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
  // The receipt carries no revert data: ask the node what the same call does now. A swap that
  // failed on its minimum or its deadline fails the same way again.
  let reason: SwapRevertReason | undefined
  try {
    await params.reader.call({ ...params.swap, from: params.account })
  } catch (error) {
    reason = swapRevertReasonOf(error)
  }
  return { status: 'reverted', ...handle, reason, feeWei }
}

/**
 * Sends any approvals the plan needs (each for the exact amount), then the swap, and watches for
 * its inclusion. `onSigned` is called with the swap's operation and transaction ids after it is
 * signed and journaled and before it is broadcast: record them durably there.
 */
export async function executeSwap(params: {
  reader: SwapExecutionReader
  wallet: SwapWallet
  deployment: UniswapV4Deployment
  plan: SwapPlan
  account: string
  onProgress?: (progress: SwapProgress) => void
  onSigned?: (signed: { operationId: string; txHash: string }) => Promise<void>
  timing?: SwapTiming
}): Promise<SwapResult> {
  const { reader, wallet, plan, account, onProgress } = params
  const timing = params.timing ?? DEFAULT_SWAP_TIMING

  for (let i = 0; i < plan.approvals.length; i++) {
    const { call } = plan.approvals[i]!
    onProgress?.({ stage: 'approving', step: i + 1, of: plan.approvals.length })
    const fee = await feeOrRefusal(reader, call, account)
    await ensureMainHolds(wallet, fee.maximumFeeWei, timing, onProgress)
    const handle = await send(wallet, call, fee.gasLimit)
    onProgress?.({
      stage: 'approving',
      step: i + 1,
      of: plan.approvals.length,
      txHash: handle.txHash,
    })
    const receipt = await awaitReceipt(reader, handle.txHash, timing)
    await wallet.reobserveNativeOperations?.()
    if (receipt?.status !== 1)
      throw new SwapRefusedError(
        'approval-failed',
        receipt
          ? 'The approval transaction failed'
          : 'The approval has not confirmed yet',
      )
  }

  // The gas estimate needs the value in the account, so the value is consolidated first and the
  // fee, once known, second.
  await ensureMainHolds(wallet, plan.swap.value, timing, onProgress)
  const fee = await feeOrRefusal(reader, plan.swap, account)
  await ensureMainHolds(
    wallet,
    plan.swap.value + fee.maximumFeeWei,
    timing,
    onProgress,
  )
  onProgress?.({ stage: 'signing' })
  const handle = await send(wallet, plan.swap, fee.gasLimit, params.onSigned)
  onProgress?.({ stage: 'submitted', txHash: handle.txHash })
  const receipt = await awaitReceipt(reader, handle.txHash, timing)
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
  wallet: Pick<SwapWallet, 'resumeNativeOperation' | 'reobserveNativeOperations'>
  deployment: UniswapV4Deployment
  route: PoolRoute
  account: string
  swap: EncodedCall
  handle: { operationId: string; txHash: string }
  timing?: SwapTiming
}): Promise<SwapResult> {
  const timing = params.timing ?? { ...DEFAULT_SWAP_TIMING, inclusionTimeoutMs: 0 }
  const { reader, handle } = params
  let receipt = await awaitReceipt(reader, handle.txHash, timing)
  if (!receipt) {
    const known = await reader.getTransaction(handle.txHash).catch(() => 'unknown')
    if (known === null && params.wallet.resumeNativeOperation) {
      await params.wallet.resumeNativeOperation(handle.operationId).catch(() => {
        /* Still unresolved: the record stays pending and is looked at again later. */
      })
      receipt = await awaitReceipt(reader, handle.txHash, {
        ...timing,
        inclusionTimeoutMs: DEFAULT_SWAP_TIMING.inclusionTimeoutMs,
      })
    }
  }
  await params.wallet.reobserveNativeOperations?.()
  if (!receipt) return { status: 'pending', ...handle }
  return readSwapResult({ ...params, receipt })
}
