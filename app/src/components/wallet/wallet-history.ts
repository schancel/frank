import {
  notedSendGroupKeys,
  summarizeEvmNativeOperation,
  summarizeEvmNativeStampStages,
  type ContactPaymentInfo,
  type EvmExternalDeposit,
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
 * - sends and contract calls made on this device: the wallet's native operation journal. One
 *   user action is one row: a message's payment and its stamp (a stage appended to the
 *   payment's transaction set, or an operation of its own for the same message) are one row
 *   that shows the amount paid to the recipient, the stamp as a figure of its own and the
 *   network fee of every transaction. Operations still being reconciled are its active rows
 *   (`getNativeOperations`); finished ones are archived to its completed history
 *   (`getNativeOperationHistory`). Both are read, so a reload shows the same activity as
 *   before it;
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
 * - deposits from outside Frank (a faucet, an exchange, a plain transfer) to the wallet's own
 *   addresses: the chain itself, read by the wallet's deposit scan (`refreshExternalDeposits`,
 *   `getExternalDeposits`). One row per transfer, keyed by its transaction (and log), so every
 *   device shows the same rows. A transfer the coin list or a send already shows is not one;
 * - swaps: swap activity (`useSwapActivity`);
 * - dates: the chain. A sent transaction is dated by the block that included it
 *   (`readBlockTimes`, or the noted send's own block), a deposit by its block; a received
 *   payment by when the wallet learned of it.
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
      /** The message's stamp paid with it (its stamp stages and stamp operations), wei; '0'
       * when there is none or the row is the stamp itself. */
      stampWei: string
      /** Network fees the chain charged for this send's transactions so far (its stamps' with
       * them, and those that returned change), wei. The card and its details show this one
       * figure. */
      feeWei: string
      /** Whether `feeWei` covers every one of those transactions yet. */
      feeCoverage: EvmNativeOperationStatus['feeCoverage']
    }
  | {
      kind: 'noted'
      id: string
      purpose: NotedSendPurpose
      /** Lower-case 0x destination; absent for a contract creation. */
      recipient?: string
      /** What the transactions carried to the recipient, wei: not the message's stamp, unless
       * the row is the stamp itself. */
      valueWei: string
      /** The message's stamp paid with it, wei; '0' when there is none or the row is the stamp
       * itself. */
      stampWei: string
      /** The transactions of this send, as noted: those to the recipient and the stamp's. */
      sends: readonly NotedSendStatus[]
      /** Network fees the chain charged for all of its transactions (with those that moved
       * value between the wallet's own accounts), wei. */
      feeWei: string
      state: 'included' | 'reverted' | 'partial' | 'pending' | 'unknown'
      /** The latest block time among its transactions, else when it was noted. */
      timeMs: number
    }
  | {
      kind: 'deposit'
      id: string
      deposit: EvmExternalDeposit
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
      /** Stamps appended as stages to an operation (`of`, its operation ID): shown in its row. */
      stampStages: readonly {
        of: string
        stamp: EvmNativeOperationStatus
      }[]
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
      /** Deposits from outside Frank the chain shows. Absent: the wallet has no deposit scan. */
      deposits?: readonly EvmExternalDeposit[]
      /** The chain could not be read for deposits this time: those found before are shown. */
      depositsUnread?: boolean
    }
  | { status: 'unsupported' | 'unavailable' }

/** Archived operations read per page, and the most pages one load reads. */
const HISTORY_PAGE = 100
const HISTORY_PAGES = 20

/**
 * Reads everything History shows for one wallet on one network. Read only: it never opens
 * custody, signs, resumes or sends anything. Deposits are those the wallet's deposit scan has
 * found so far (`readWalletDeposits` reads the chain for more); `depositsUnread` says the last
 * such read failed.
 */
export async function loadWalletHistory(
  wallet: NativeWalletHandle,
  chainIdentifier: string,
  options: { depositsUnread?: boolean } = {},
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
    // A message's stamp appended to its payment's transaction set is a stage of the payment's
    // operation: shown in the payment's row, as its own figure.
    const stampStages = rows.flatMap(row =>
      summarizeEvmNativeStampStages(
        row,
        wallet.nativeOperationSyncFailed?.(row.operationId) ?? false,
      ).map(stamp => ({ of: row.operationId, stamp })),
    )
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
    const deposits = (wallet.getExternalDeposits?.() ?? []).filter(
      deposit => deposit.chainIdentifier === chainIdentifier,
    )
    const contactPayments = (wallet.getContactPayments?.() ?? []).map(
      payment => ({ messageId: payment.messageId, state: payment.state }),
    )
    return {
      status: 'available',
      operations,
      stampStages,
      received,
      noted,
      contactPayments,
      blockTimes,
      deposits,
      depositsUnread: options.depositsUnread ?? false,
    }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * Reads the chain's node for deposits from outside Frank up to its head (the wallet's deposit
 * scan). Chain reads only: nothing is signed or sent. Resolves false when the node could not be
 * read (what was found before stays), true otherwise, and true for a wallet with no such scan.
 */
export async function readWalletDeposits(
  wallet: NativeWalletHandle,
  chainIdentifier: string,
): Promise<boolean> {
  if (
    wallet.chainIdentifier !== chainIdentifier ||
    !wallet.refreshExternalDeposits
  )
    return true
  try {
    await wallet.refreshExternalDeposits()
    return true
  } catch {
    return false
  }
}

/** How many coins a background merge moved into one account: its row reads "Merged N coins".
 * Undefined for any other row. */
export function mergedCoins(row: WalletHistoryRow): number | undefined {
  if (row.kind === 'native' && row.operation.purpose === 'consolidation')
    return paymentMembers(row.operation).length
  if (row.kind === 'noted' && row.purpose === 'consolidation')
    return row.sends.length
  return undefined
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
 * paid its recipient (not those of a stamp appended to it; not those that moved value between
 * the wallet's own accounts). Another device dates the same send by the same transactions. */
function operationTime(
  operation: EvmNativeOperationStatus,
  blockTimes: ReadonlyMap<string, number>,
): number | undefined {
  let time: number | undefined
  const unstaged = operation.members.filter(
    member => member.stageId === undefined || !/^stamp-/.test(member.stageId),
  )
  // A stamp operation of its own: every member is the stamp's.
  for (const member of (unstaged.length ? unstaged : operation.members).filter(
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
  if (row.kind === 'deposit') return true
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

/** Every transaction of these operations once, by hash: an operation's stamp stage repeats
 * members of the operation itself. */
function uniqueMembers(operations: readonly EvmNativeOperationStatus[]) {
  const seen = new Set<string>()
  return operations.flatMap(operation =>
    operation.members.filter(member => {
      if (member.transactionHash === undefined) return true
      const hash = member.transactionHash.toLowerCase()
      if (seen.has(hash)) return false
      seen.add(hash)
      return true
    }),
  )
}

/**
 * The network fee History shows for one send of this device's journal: every transaction of its
 * operation and of the stamps paid with it (`stamps`: its stamp stages and stamp operations for
 * the same message), each once. A sent payment's card in a chat shows the same figure.
 */
export function sendFees(
  operation: EvmNativeOperationStatus,
  stamps: readonly EvmNativeOperationStatus[] = [],
): ReturnType<typeof observedFees> {
  return observedFees(uniqueMembers([operation, ...stamps]))
}

/**
 * The account's noted sends as History groups them: one user action each, its transactions
 * sharing any name `notedSendGroupKeys` gives (the sending wallet's operation with its stages,
 * and the message it was for), in note order, by the group's first key. The sending device's
 * journal groups the same transactions the same way.
 */
export function groupNotedSends(
  noted: readonly NotedSendStatus[],
): Map<string, NotedSendStatus[]> {
  const parent = new Map<string, string>()
  const root = (key: string): string => {
    let at = key
    while (parent.get(at) !== at) at = parent.get(at)!
    return at
  }
  const ordered = [...noted].sort(
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
  return sends
}

/** The network fee History shows for one noted send (a group of `groupNotedSends`): every one
 * of its transactions the chain charged so far, those to the wallet's own accounts included. A
 * sent payment's card on another device of the account shows the same figure. */
export function notedSendFeeWei(group: readonly NotedSendStatus[]): string {
  return group
    .reduce((total, send) => total + BigInt(send.inclusion?.feeWei ?? '0'), 0n)
    .toString()
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
  // One user action is one row: a message's stamp goes with the operation that paid the
  // message's payment, as a stage of it or as an operation of its own for the same message, as
  // another device groups the same transactions from its notes (`notedSendGroupKeys`).
  const stampsOf = new Map<string, EvmNativeOperationStatus[]>()
  const addStamp = (of: string, stamp: EvmNativeOperationStatus) => {
    const list = stampsOf.get(of)
    if (list) list.push(stamp)
    else stampsOf.set(of, [stamp])
  }
  for (const { of, stamp } of load.status === 'available'
    ? load.stampStages
    : [])
    addStamp(of, stamp)
  const messageOwners = new Map<string, string[]>()
  for (const operation of operations)
    if (operation.purpose !== 'stamp')
      for (const messageId of new Set([
        ...(operation.messageId === undefined ? [] : [operation.messageId]),
        ...(stampsOf.get(operation.operationId) ?? []).flatMap(stamp =>
          stamp.messageId === undefined ? [] : [stamp.messageId],
        ),
      ]))
        messageOwners.set(messageId, [
          ...(messageOwners.get(messageId) ?? []),
          operation.operationId,
        ])
  const shownWith = new Set<string>()
  for (const operation of operations) {
    if (operation.purpose !== 'stamp' || operation.messageId === undefined)
      continue
    const owners = messageOwners.get(operation.messageId)
    if (owners?.length !== 1) continue
    addStamp(owners[0]!, operation)
    shownWith.add(operation.operationId)
  }
  for (const operation of operations)
    if (
      !attached.has(operation.operationId) &&
      !shownWith.has(operation.operationId) &&
      !lostToAnother(operation, included)
    ) {
      const stamps = (stampsOf.get(operation.operationId) ?? []).filter(
        stamp => !lostToAnother(stamp, included),
      )
      // The chain's answer stands once it showed the payment; before that, a contact payment
      // that ended without paying reads as the chat's card does.
      const outcome =
        operation.purpose === 'contact-payment' &&
        operation.messageId !== undefined &&
        operation.payment !== 'included' &&
        operation.payment !== 'partial'
          ? contactOutcomes.get(operation.messageId)
          : undefined
      const fees = sendFees(operation, stamps)
      rows.push({
        kind: 'native',
        id: `native:${operation.operationId}`,
        operation,
        ...(outcome === 'failed' || outcome === 'released'
          ? { contactOutcome: outcome }
          : {}),
        timeMs: operationTime(operation, blockTimes),
        stampWei: stamps
          .reduce((total, stamp) => total + BigInt(stamp.intendedValueWei), 0n)
          .toString(),
        feeWei: fees.feeWei,
        feeCoverage: fees.coverage,
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
    const sends = groupNotedSends(
      noted.filter(send => !shown.has(send.txHash.toLowerCase())),
    )
    for (const [key, all] of sends) {
      // What moved between the wallet's own accounts is no send of its own: only its fee is.
      // A background merge of coins is the exception: it is one row of its own ("Merged N
      // coins"), so every device shows what it cost.
      const group =
        notedGroupPurpose(all) === 'consolidation'
          ? all
          : all.filter(send => !send.toOwnAccount)
      if (group.length === 0) continue
      // What the recipient was paid, apart from the message's stamp; a stamp alone is the row.
      const paid = group.filter(send => send.purpose !== 'stamp')
      const stamps = group.filter(send => send.purpose === 'stamp')
      const primary = paid.length ? paid : stamps
      const sum = (list: readonly NotedSendStatus[]) =>
        list
          .reduce((total, send) => total + BigInt(send.valueWei), 0n)
          .toString()
      const times = primary.flatMap(send =>
        send.inclusion?.blockTimeMs !== undefined
          ? [send.inclusion.blockTimeMs]
          : [],
      )
      rows.push({
        kind: 'noted',
        id: `noted:${key}`,
        purpose: notedGroupPurpose(primary),
        ...(primary[0]!.to === undefined ? {} : { recipient: primary[0]!.to }),
        valueWei: sum(primary),
        stampWei: paid.length ? sum(stamps) : '0',
        sends: group,
        feeWei: notedSendFeeWei(all),
        state: notedState(primary),
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
    // Deposits from outside Frank: a transaction a send or a received coin already shows is not
    // shown again (the deposit scan leaves out the wallet's own transfers and its coins' ones).
    const coinTransactions = new Set(
      load.received.flatMap(payment => [
        ...(payment.nativeStampRecovery?.receipts.map(
          receipt => receipt.txHash,
        ) ?? []),
        ...(payment.settledTransactions ?? []).map(
          hash => `0x${hash.replace(/^0x/, '').toLowerCase()}`,
        ),
      ]),
    )
    for (const send of noted) shown.add(send.txHash.toLowerCase())
    const listed = new Set<string>()
    for (const deposit of load.deposits ?? [])
      if (
        !listed.has(deposit.id) &&
        !shown.has(deposit.txHash) &&
        !coinTransactions.has(deposit.txHash) &&
        listed.add(deposit.id)
      )
        rows.push({
          kind: 'deposit',
          id: `deposit:${deposit.id}`,
          deposit,
          timeMs: deposit.blockTimeMs,
        })
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
