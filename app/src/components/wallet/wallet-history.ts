import {
  summarizeEvmNativeOperation,
  type EvmNativeOperationStatus,
  type NativeWalletHandle,
  type ReceivedPayment,
} from '@frank/wallet/chain'
import type { SwapActivityRow } from 'src/swap/useSwapActivity'

/**
 * The wallet page's History: a derived view, never a store of its own.
 *
 * Owners of the facts it shows:
 * - sends and contract calls: the wallet's native operation journal. Operations still being
 *   reconciled are its active rows (`getNativeOperations`); finished ones are archived to its
 *   completed history (`getNativeOperationHistory`). Both are read, so a reload shows the same
 *   activity as before it;
 * - received payments: the wallet's coin list (`getReceivedPayments`);
 * - swaps: swap activity (`useSwapActivity`);
 * - dates: the chain. A sent transaction is dated by the block that included it
 *   (`readBlockTimes`); a received payment by when the wallet learned of it.
 *
 * The view is rebuilt from those owners each time it is loaded: when the wallet page opens the
 * network's wallet, when the account or network changes, and whenever the History tab is opened.
 */

export type WalletHistoryRow =
  | {
      kind: 'swap'
      id: string
      swap: SwapActivityRow
      operation?: EvmNativeOperationStatus
      timeMs?: number
    }
  | {
      kind: 'native'
      id: string
      operation: EvmNativeOperationStatus
      /** The time of the block that included the payment; absent until it is in one. */
      timeMs?: number
    }
  | { kind: 'received'; id: string; payment: ReceivedPayment; timeMs: number }

export interface WalletHistoryGroup {
  id: string
  label: string
  rows: WalletHistoryRow[]
}

export type WalletHistoryLoad =
  | {
      status: 'available'
      operations: readonly EvmNativeOperationStatus[]
      received: readonly ReceivedPayment[]
      /** Block hash -> epoch ms, for the blocks the operations' transactions are in. */
      blockTimes: ReadonlyMap<string, number>
    }
  | { status: 'unsupported' | 'unavailable' }

/** Archived operations read per page, and the most pages one load reads. */
const HISTORY_PAGE = 100
const HISTORY_PAGES = 20

/**
 * Reads everything History shows for one wallet on one network. Read only: it never opens
 * custody, signs, resumes or sends anything.
 */
export async function loadWalletHistory(
  wallet: NativeWalletHandle,
  chainIdentifier: string,
): Promise<WalletHistoryLoad> {
  if (wallet.chainIdentifier !== chainIdentifier)
    return { status: 'unavailable' }
  if (wallet.family !== 'evm' || !wallet.getNativeOperations)
    return { status: 'unsupported' }
  try {
    const rows = [...wallet.getNativeOperations()]
    const seen = new Set(rows.map(row => row.operationId))
    if (wallet.getNativeOperationHistory) {
      let after: string | undefined
      for (let page = 0; page < HISTORY_PAGES; page++) {
        const { operations, next } = await wallet.getNativeOperationHistory({
          after,
          limit: HISTORY_PAGE,
        })
        for (const row of operations)
          if (!seen.has(row.operationId)) {
            seen.add(row.operationId)
            rows.push(row)
          }
        if (!next) break
        after = next
      }
    }
    if (rows.some(row => row.binding.chainIdentifier !== chainIdentifier))
      return { status: 'unavailable' }
    const operations = rows.map(row =>
      summarizeEvmNativeOperation(
        row,
        wallet.nativeOperationSyncFailed?.(row.operationId) ?? false,
      ),
    )
    const blockHashes = operations.flatMap(operation =>
      operation.members.flatMap(member =>
        member.blockHash ? [member.blockHash] : [],
      ),
    )
    const [blockTimes, received] = await Promise.all([
      wallet.readBlockTimes && blockHashes.length
        ? wallet.readBlockTimes(blockHashes).catch(() => new Map())
        : Promise.resolve(new Map<string, number>()),
      Promise.resolve(wallet.getReceivedPayments?.() ?? []),
    ])
    return { status: 'available', operations, received, blockTimes }
  } catch {
    return { status: 'unavailable' }
  }
}

/** The members that carry the payment itself: what the recipient is paid with. */
export function paymentMembers(operation: EvmNativeOperationStatus) {
  return operation.members.filter(member => member.role !== 'change')
}

/** The members that return what is left to the wallet's own accounts. */
export function changeMembers(operation: EvmNativeOperationStatus) {
  return operation.members.filter(member => member.role === 'change')
}

/** Fees the chain has charged so far for these transactions, and whether that is all of them. */
export function observedFees(members: EvmNativeOperationStatus['members']): {
  feeWei: string
  coverage: EvmNativeOperationStatus['feeCoverage']
} {
  const observed = members.filter(member => member.feeWei !== undefined)
  return {
    feeWei: observed
      .reduce((sum, member) => sum + BigInt(member.feeWei!), 0n)
      .toString(),
    coverage:
      observed.length === members.length && members.length > 0
        ? 'complete'
        : observed.length
        ? 'partial'
        : 'unknown',
  }
}

/** When the operation's payment was included: the latest block among its payment members. */
function operationTime(
  operation: EvmNativeOperationStatus,
  blockTimes: ReadonlyMap<string, number>,
): number | undefined {
  let time: number | undefined
  for (const member of paymentMembers(operation)) {
    const at = member.blockHash ? blockTimes.get(member.blockHash) : undefined
    if (at !== undefined && (time === undefined || at > time)) time = at
  }
  return time
}

function finished(row: WalletHistoryRow): boolean {
  if (row.kind === 'swap') return row.swap.status !== 'pending'
  if (row.kind === 'received') return row.payment.status !== 'pending'
  return ['included', 'reverted', 'cancelled', 'superseded'].includes(
    row.operation.payment,
  )
}

/**
 * The rows History shows for one network, newest first: what is still unresolved, then
 * everything else. A swap and the transfer that carried it are one row.
 */
export function buildWalletHistoryGroups(input: {
  chainIdentifier: string
  load: WalletHistoryLoad
  swaps: readonly SwapActivityRow[]
}): WalletHistoryGroup[] {
  const { load } = input
  const operations = load.status === 'available' ? load.operations : []
  const blockTimes =
    load.status === 'available' ? load.blockTimes : new Map<string, number>()
  const attached = new Set<string>()
  const rows: WalletHistoryRow[] = input.swaps
    .filter(swap => swap.chainIdentifier === input.chainIdentifier)
    .map(swap => {
      const hash = swap.txHash?.toLowerCase()
      const matches = hash
        ? operations.filter(
            operation =>
              operation.chainIdentifier === swap.chainIdentifier &&
              operation.finalTransactionHash?.toLowerCase() === hash,
          )
        : []
      const operation = matches.length === 1 ? matches[0] : undefined
      if (operation) attached.add(operation.operationId)
      return {
        kind: 'swap',
        id: `swap:${swap.id}`,
        swap,
        operation,
        timeMs: swap.timestamp,
      }
    })
  for (const operation of operations)
    if (!attached.has(operation.operationId))
      rows.push({
        kind: 'native',
        id: `native:${operation.operationId}`,
        operation,
        timeMs: operationTime(operation, blockTimes),
      })
  if (load.status === 'available')
    for (const payment of load.received)
      rows.push({
        kind: 'received',
        id: `received:${payment.address}`,
        payment,
        timeMs: payment.discoveredAtMs,
      })
  // Newest first; a finished row the chain has not dated yet goes after the dated ones.
  rows.sort(
    (a, b) =>
      (b.timeMs ?? -Infinity) - (a.timeMs ?? -Infinity) ||
      a.id.localeCompare(b.id),
  )
  return [
    {
      id: 'pending',
      label: 'walletPanel.historyPending',
      rows: rows.filter(row => !finished(row)),
    },
    {
      id: 'activity',
      label: 'walletPanel.tabHistory',
      rows: rows.filter(finished),
    },
  ].filter(group => group.rows.length > 0)
}
