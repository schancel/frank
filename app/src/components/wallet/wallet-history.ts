import {
  notedSendGroupKeys,
  summarizeEvmNativeOperation,
  summarizeEvmNativeStampStages,
  type ContactPaymentInfo,
  type EvmNativeOperationStatus,
  type NativeWalletHandle,
  type NotedSendPurpose,
  type NotedSendStatus,
  type ReceivedPayment,
} from '@frank/wallet/chain'
import type { SwapActivityRow } from 'src/swap/useSwapActivity'

/**
 * The wallet page's History: a derived view, never a store of its own.
 *
 * Owners of the facts it shows:
 * - sends and contract calls made on this device: the wallet's native operation journal. A
 *   message stamp paid in the same transaction set as a contact payment is its own row;
 *   Operations still being reconciled are its active rows (`getNativeOperations`); finished ones
 *   are archived to its completed history (`getNativeOperationHistory`). Both are read, so a
 *   reload shows the same activity as before it;
 * - sends made on any device of the account: the account's notes to itself
 *   (`getNotedSends`). Every device reads them from the account's mailbox, and a device restored
 *   from the seed reads them again, so every device shows the account's sends. A transaction this
 *   device's journal also has is shown once, from the journal. Each send is one row on every
 *   device, grouped and named from the operation its transactions' notes name, as the sending
 *   device's journal groups and names it, with the network fee of all its transactions;
 * - an attempt of this device that never landed because another device's transaction took its
 *   nonce (the chain shows that transaction): no row, since it moved nothing and cost nothing;
 * - a contact payment's own outcome: the wallet's contact payments (`getContactPayments`), the
 *   same record the chat's payment card reads;
 * - received payments: the wallet's coin list (`getReceivedPayments`). The coins one message
 *   paid (a stamp or payment split over several transactions) are one row;
 * - swaps: swap activity (`useSwapActivity`);
 * - dates: the chain. A sent transaction is dated by the block that included it
 *   (`readBlockTimes`, or the noted send's own block); a received payment by when the wallet
 *   learned of it.
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
      /** The contact payment's own record, when it ended without paying: what the chat says. */
      contactOutcome?: 'failed' | 'released'
      /** The time of the block that included the payment; absent until it is in one. */
      timeMs?: number
      /** Network fees the chain charged for this send's transactions so far, wei. */
      feeWei: string
    }
  | {
      kind: 'noted'
      id: string
      purpose: NotedSendPurpose
      /** Lower-case 0x destination; absent for a contract creation. */
      recipient?: string
      /** What the transactions carried to the recipient, wei. */
      valueWei: string
      /** The transactions of this send, as noted: those to the recipient. */
      sends: readonly NotedSendStatus[]
      /** Network fees the chain charged for all of its transactions (with those that moved
       * value between the wallet's own accounts), wei. */
      feeWei: string
      state: 'included' | 'reverted' | 'partial' | 'pending' | 'unknown'
      /** The latest block time among its transactions, else when it was noted. */
      timeMs: number
    }
  | {
      kind: 'received'
      id: string
      payment: ReceivedPayment
      /** Every coin of the payment: more than one when one message paid several. */
      payments: readonly ReceivedPayment[]
      timeMs: number
    }

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
      /** Sends of every device of the account, from its notes to itself. */
      noted: readonly NotedSendStatus[]
      /** The wallet's contact payments, for the outcome the chat shows. */
      contactPayments: readonly Pick<
        ContactPaymentInfo,
        'messageId' | 'state'
      >[]
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
    // A contact payment's message stamp is a stage of the payment's operation: it is shown as
    // its own send (a message stamp), as the chat card shows it apart from the payment.
    const operations = rows.flatMap(row => {
      const syncFailed =
        wallet.nativeOperationSyncFailed?.(row.operationId) ?? false
      return [
        summarizeEvmNativeOperation(row, syncFailed),
        ...summarizeEvmNativeStampStages(row, syncFailed),
      ]
    })
    const blocks = operations.flatMap(operation =>
      operation.members.flatMap(member =>
        member.blockHash !== undefined && member.blockNumber !== undefined
          ? [{ blockHash: member.blockHash, blockNumber: member.blockNumber }]
          : [],
      ),
    )
    const [blockTimes, received, noted] = await Promise.all([
      wallet.readBlockTimes && blocks.length
        ? wallet.readBlockTimes(blocks).catch(() => new Map())
        : Promise.resolve(new Map<string, number>()),
      Promise.resolve(wallet.getReceivedPayments?.() ?? []),
      // Unreadable notes leave this device's own history in place.
      wallet.getNotedSends
        ? wallet.getNotedSends().catch(() => [])
        : Promise.resolve([]),
    ])
    const contactPayments = (wallet.getContactPayments?.() ?? []).map(
      payment => ({ messageId: payment.messageId, state: payment.state }),
    )
    return {
      status: 'available',
      operations,
      received,
      noted,
      contactPayments,
      blockTimes,
    }
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

/** When the operation's payment was included: the latest block among the transactions that
 * paid its recipient (not those of a stamp appended to it, which is a row of its own; not those
 * that moved value between the wallet's own accounts). Another device dates the same send by
 * the same transactions. */
function operationTime(
  operation: EvmNativeOperationStatus,
  blockTimes: ReadonlyMap<string, number>,
): number | undefined {
  let time: number | undefined
  for (const member of ownMembers(operation).filter(
    member => member.role === 'payment',
  )) {
    const at = member.blockHash
      ? blockTimes.get(member.blockHash.toLowerCase())
      : undefined
    if (at !== undefined && (time === undefined || at > time)) time = at
  }
  return time
}

function finished(row: WalletHistoryRow): boolean {
  if (row.kind === 'swap') return row.swap.status !== 'pending'
  if (row.kind === 'received') return row.payment.status !== 'pending'
  if (row.kind === 'noted')
    return row.state !== 'pending' && row.state !== 'unknown'
  if (row.contactOutcome !== undefined) return true
  return ['included', 'reverted', 'cancelled', 'superseded'].includes(
    row.operation.payment,
  )
}

/** One status for the coins one message paid: all arrived, any failed, else still arriving. */
function combinedPayment(coins: readonly ReceivedPayment[]): ReceivedPayment {
  if (coins.length === 1) return coins[0]!
  const sum = (value: (coin: ReceivedPayment) => bigint) =>
    coins.reduce((total, coin) => total + value(coin), 0n)
  const statuses = new Set(coins.map(coin => coin.status))
  const status = statuses.has('failed')
    ? 'failed'
    : statuses.has('pending')
    ? 'pending'
    : statuses.has('unverifiable')
    ? 'unverifiable'
    : statuses.has('not-received')
    ? statuses.has('received')
      ? 'pending'
      : 'not-received'
    : 'received'
  const received = coins.some(coin => coin.receivedAmountWei !== undefined)
  const first = coins.reduce((earliest, coin) =>
    coin.discoveredAtMs < earliest.discoveredAtMs ? coin : earliest,
  )
  return {
    ...first,
    status,
    amountWei: sum(coin => coin.amountWei),
    claimedAmountWei: sum(coin => coin.claimedAmountWei),
    ...(received
      ? { receivedAmountWei: sum(coin => coin.receivedAmountWei ?? 0n) }
      : {}),
    // Some of the message's coins arrived and some did not (yet).
    partial:
      coins.some(coin => coin.partial) ||
      (status !== 'received' && coins.some(coin => coin.status === 'received')),
    spendable: coins.some(coin => coin.spendable),
    discoveredAtMs: first.discoveredAtMs,
  }
}

/** The state of one send of several noted transactions. */
function notedState(
  sends: readonly NotedSendStatus[],
): 'included' | 'reverted' | 'partial' | 'pending' | 'unknown' {
  const states = sends.map(send => send.state)
  if (states.every(state => state === 'included')) return 'included'
  if (states.every(state => state === 'reverted')) return 'reverted'
  if (states.some(state => state === 'included')) return 'partial'
  if (states.some(state => state === 'pending')) return 'pending'
  return 'unknown'
}

/** What one send of several noted transactions was for: the most specific any of them says. */
function notedGroupPurpose(
  sends: readonly NotedSendStatus[],
): NotedSendPurpose {
  return sends.find(send => send.purpose !== 'transfer')?.purpose ?? 'transfer'
}

/**
 * The members whose fees belong to this row: a payment's own transactions, without the stamp
 * stages appended to it (each is a row of its own, with its own fee).
 */
function ownMembers(operation: EvmNativeOperationStatus) {
  const unstaged = operation.members.filter(
    member => member.stageId === undefined || !/^stamp-/.test(member.stageId),
  )
  // A stamp stage's own row: every member is the stage's.
  return unstaged.length ? unstaged : operation.members
}

/**
 * An attempt that never landed and took nothing: the chain gave every one of its payment
 * transactions' nonces to another transaction of the account (another device's, which won the
 * race for the same coin). It moved no money and charged no fee, so it is no row of History.
 */
function lostToAnother(
  operation: EvmNativeOperationStatus,
  included: ReadonlyMap<string, string>,
): boolean {
  if (operation.payment !== 'superseded') return false
  return (
    operation.members.length > 0 &&
    operation.members.every(member => {
      const taker = included.get(`${member.account}:${member.nonce}`)
      return (
        member.state === 'superseded' &&
        taker !== undefined &&
        taker !== member.transactionHash?.toLowerCase()
      )
    })
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
  const contactOutcomes = new Map(
    (load.status === 'available' ? load.contactPayments : []).flatMap(payment =>
      payment.state === 'failed' || payment.state === 'released'
        ? [[payment.messageId.replace(/-/g, '').toLowerCase(), payment.state]]
        : [],
    ),
  )
  const noted = load.status === 'available' ? load.noted : []
  // Who took each account's nonce, of the transactions the chain included.
  const included = new Map<string, string>()
  for (const send of noted)
    if (send.state === 'included' || send.state === 'reverted')
      included.set(`${send.from}:${send.nonce}`, send.txHash.toLowerCase())
  for (const operation of operations)
    for (const member of operation.members)
      if (
        member.transactionHash &&
        (member.state === 'included-success' ||
          member.state === 'included-revert')
      )
        included.set(
          `${member.account}:${member.nonce}`,
          member.transactionHash.toLowerCase(),
        )
  for (const operation of operations)
    if (
      !attached.has(operation.operationId) &&
      !lostToAnother(operation, included)
    ) {
      // The chain's answer stands once it showed the payment; before that, a contact payment
      // that ended without paying reads as the chat's card does.
      const outcome =
        operation.purpose === 'contact-payment' &&
        operation.messageId !== undefined &&
        operation.payment !== 'included' &&
        operation.payment !== 'partial'
          ? contactOutcomes.get(operation.messageId)
          : undefined
      rows.push({
        kind: 'native',
        id: `native:${operation.operationId}`,
        operation,
        ...(outcome === 'failed' || outcome === 'released'
          ? { contactOutcome: outcome }
          : {}),
        timeMs: operationTime(operation, blockTimes),
        feeWei: observedFees(ownMembers(operation)).feeWei,
      })
    }
  if (load.status === 'available') {
    // A transaction this device's journal or a swap row already shows is not shown again.
    const shown = new Set<string>()
    for (const operation of operations)
      for (const member of operation.members)
        if (member.transactionHash)
          shown.add(member.transactionHash.toLowerCase())
    for (const swap of input.swaps)
      if (swap.txHash) shown.add(swap.txHash.toLowerCase())
    // One send of the account is one row on every device: its transactions are grouped by the
    // operation and message their notes name (`notedSendGroupKeys`), as the sending device's
    // journal groups them.
    const parent = new Map<string, string>()
    const root = (key: string): string => {
      let at = key
      while (parent.get(at) !== at) at = parent.get(at)!
      return at
    }
    const ordered = [...noted]
      .filter(send => !shown.has(send.txHash.toLowerCase()))
      .sort(
        (a, b) =>
          a.notedAtMs - b.notedAtMs ||
          a.noteIndex - b.noteIndex ||
          a.txHash.localeCompare(b.txHash),
      )
    const keysOf = new Map(
      ordered.map(send => [send.txHash, notedSendGroupKeys(send)]),
    )
    for (const keys of keysOf.values())
      for (const key of keys) if (!parent.has(key)) parent.set(key, key)
    for (const keys of keysOf.values())
      for (const key of keys.slice(1)) {
        const [a, b] = [root(keys[0]!), root(key)].sort()
        parent.set(b!, a!)
      }
    const sends = new Map<string, NotedSendStatus[]>()
    for (const send of ordered) {
      const key = root(keysOf.get(send.txHash)![0]!)
      const group = sends.get(key)
      if (group) group.push(send)
      else sends.set(key, [send])
    }
    for (const [key, all] of sends) {
      // What moved between the wallet's own accounts is no send of its own: only its fee is.
      const group = all.filter(send => !send.toOwnAccount)
      if (group.length === 0) continue
      const times = group.flatMap(send =>
        send.inclusion?.blockTimeMs !== undefined
          ? [send.inclusion.blockTimeMs]
          : [],
      )
      rows.push({
        kind: 'noted',
        id: `noted:${key}`,
        purpose: notedGroupPurpose(group),
        ...(group[0]!.to === undefined ? {} : { recipient: group[0]!.to }),
        valueWei: group
          .reduce((total, send) => total + BigInt(send.valueWei), 0n)
          .toString(),
        sends: group,
        feeWei: all
          .reduce(
            (total, send) => total + BigInt(send.inclusion?.feeWei ?? '0'),
            0n,
          )
          .toString(),
        state: notedState(group),
        timeMs: times.length
          ? Math.max(...times)
          : Math.min(...group.map(send => send.notedAtMs)),
      })
    }
    // The coins one message paid, of one kind, are one payment.
    const payments = new Map<string, ReceivedPayment[]>()
    for (const payment of load.received) {
      const key = payment.payloadDigest
        ? `${payment.origin}:${payment.payloadDigest}`
        : payment.address
      const group = payments.get(key)
      if (group) group.push(payment)
      else payments.set(key, [payment])
    }
    for (const group of payments.values()) {
      const payment = combinedPayment(group)
      rows.push({
        kind: 'received',
        id: `received:${
          group.length === 1
            ? payment.address
            : `${payment.origin}:${payment.payloadDigest}`
        }`,
        payment,
        payments: group,
        timeMs: payment.discoveredAtMs,
      })
    }
  }
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
