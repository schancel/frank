/**
 * The user's own "Reconcile wallet" pass: reads everything again and records what it finds.
 *
 * Nothing in the ordinary wallet runs this; a person starts it (the app keeps it in a hidden
 * Developer section). It does three things, in order:
 *
 *  1. Reads the whole mailbox from the start and records every coin the messages pay this
 *     wallet (`stealth`, `stealth-asset` and `received-coin` items) through the same boundary
 *     every mailbox read uses. Messages are not handed to the app again and no note is applied
 *     to another chain.
 *  2. Walks the seed's branches for accounts the chain shows in use and reads every account
 *     of the coin list again (`EvmCoinListSync.refresh({ all: true })`).
 *  3. Reads, from the chain, the state of every signed operation in the wallet's journal
 *     (`EvmTransactionSetLifecycle.observe`), and records it.
 *
 * It only reads and records. It signs nothing, broadcasts nothing, sends no message, reserves no
 * coin and releases no reservation, so it can run beside sends and the wallet's own background
 * passes; those take and keep their reservations as usual. Recording is idempotent: a second run
 * finds nothing new. A step that fails is reported in the summary and the next step still runs.
 */
import type { DirectMessageReceived } from './chain/active-chain'
import type { EvmNativeOperation } from './storage/evm-native-operation-journal'
import type { EvmCoin } from './storage/evm-coin-store'

export type WalletReconcileStep = 'mailbox' | 'seed' | 'operations'

export interface WalletReconcileProgress {
  readonly step: WalletReconcileStep
  /** Mailbox messages read so far. */
  readonly messagesRead: number
  /** Journal operations read so far, and how many there are. */
  readonly operationsObserved: number
  readonly operationsTotal: number
}

export interface WalletReconcileSummary {
  readonly chainIdentifier: string
  readonly messagesRead: number
  /** False when the relay cut the read short: what came after was not read. */
  readonly mailboxComplete: boolean
  /** Received coins this pass recorded that the wallet did not have. */
  readonly receivedCoinsAdded: readonly {
    readonly address: string
    readonly claimedAmountWei: string
    readonly state: EvmCoin['state']
  }[]
  /** Received coins whose recorded state the pass changed. */
  readonly receivedCoinsChanged: number
  /** Accounts the coin list did not have before (found by the seed walk or a payment). */
  readonly accountsAdded: readonly string[]
  readonly operationsObserved: number
  /** Operations whose recorded chain state changed: one state per member, before and after. */
  readonly operationsChanged: readonly {
    readonly operationId: string
    readonly before: readonly string[]
    readonly after: readonly string[]
  }[]
  readonly failures: readonly {
    readonly step: WalletReconcileStep
    readonly message: string
  }[]
}

export interface WalletReconcileDeps {
  readonly chainIdentifier: string
  /** One read of the mailbox from `sinceMs`, inclusive. Calls `onTruncated` if it stops early. */
  readMailbox(
    sinceMs: number,
    onTruncated: (reason: Error) => void,
  ): Promise<readonly DirectMessageReceived[]>
  /** The boundary every mailbox read records coins through. Records only. */
  recordReceivedCoins(messages: readonly DirectMessageReceived[]): Promise<void>
  receivedCoins(): readonly EvmCoin[]
  coinListAccounts(): readonly string[]
  /** Walk the seed and read every coin-list account again; rejects if any read failed. */
  walkSeed(): Promise<void>
  operations(): readonly EvmNativeOperation[]
  /** Read one operation's members from the chain and record what it shows. */
  observeOperation(operation: EvmNativeOperation): Promise<void>
  assertOpen(): void
}

const MAX_MAILBOX_READS = 1_000

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const memberStates = (operation: EvmNativeOperation | undefined) =>
  operation?.members.map(member => member.observation.state) ?? []

/** An operation whose signed members the chain may say more about. */
const observable = (operation: EvmNativeOperation) =>
  operation.kind === 'transaction-set' &&
  !operation.cancelled &&
  operation.members.length > 0 &&
  operation.members.every(member => member.signed !== undefined) &&
  operation.members.some(
    member =>
      member.observation.state !== 'included-success' &&
      member.observation.state !== 'included-revert',
  )

export async function runWalletReconcile(
  deps: WalletReconcileDeps,
  onProgress?: (progress: WalletReconcileProgress) => void,
): Promise<WalletReconcileSummary> {
  deps.assertOpen()
  const failures: { step: WalletReconcileStep; message: string }[] = []
  const coinsBefore = new Map(
    deps.receivedCoins().map(coin => [coin.address, coin]),
  )
  const accountsBefore = new Set(
    deps.coinListAccounts().map(account => account.toLowerCase()),
  )
  let messagesRead = 0
  let operationsObserved = 0
  let operationsTotal = 0
  const report = (step: WalletReconcileStep) =>
    onProgress?.({ step, messagesRead, operationsObserved, operationsTotal })

  // 1. The mailbox from the start. A read the relay cut short goes on from the last timestamp
  // it returned (inclusive, so nothing at that instant is skipped; recording is idempotent).
  let mailboxComplete = false
  report('mailbox')
  try {
    let sinceMs = 0
    for (let reads = 0; reads < MAX_MAILBOX_READS; reads++) {
      deps.assertOpen()
      let truncated: Error | undefined
      const messages = await deps.readMailbox(sinceMs, reason => {
        truncated = reason
      })
      await deps.recordReceivedCoins(messages)
      messagesRead += messages.length
      report('mailbox')
      if (truncated === undefined) {
        mailboxComplete = true
        break
      }
      const latest = messages.reduce(
        (max, row) => Math.max(max, row.receivedTime ?? 0),
        sinceMs,
      )
      if (latest <= sinceMs) {
        failures.push({ step: 'mailbox', message: message(truncated) })
        break
      }
      sinceMs = latest
    }
    if (!mailboxComplete && failures.every(f => f.step !== 'mailbox'))
      failures.push({ step: 'mailbox', message: 'The mailbox read did not finish' })
  } catch (error) {
    failures.push({ step: 'mailbox', message: message(error) })
  }

  // 2. The seed, and every account of the coin list.
  report('seed')
  try {
    deps.assertOpen()
    await deps.walkSeed()
  } catch (error) {
    failures.push({ step: 'seed', message: message(error) })
  }

  // 3. What the chain shows of every signed operation still open in the journal.
  const operationsChanged: {
    operationId: string
    before: string[]
    after: string[]
  }[] = []
  try {
    deps.assertOpen()
    const open = deps.operations().filter(observable)
    operationsTotal = open.length
    report('operations')
    for (const operation of open) {
      deps.assertOpen()
      const before = memberStates(operation)
      try {
        await deps.observeOperation(operation)
      } catch (error) {
        failures.push({
          step: 'operations',
          message: `${operation.operationId}: ${message(error)}`,
        })
      }
      operationsObserved++
      report('operations')
      const after = memberStates(
        deps
          .operations()
          .find(row => row.operationId === operation.operationId),
      )
      if (
        after.length > 0 &&
        (after.length !== before.length ||
          after.some((state, index) => state !== before[index]))
      )
        operationsChanged.push({
          operationId: operation.operationId,
          before,
          after,
        })
    }
  } catch (error) {
    failures.push({ step: 'operations', message: message(error) })
  }

  const coinsAfter = deps.receivedCoins()
  return {
    chainIdentifier: deps.chainIdentifier,
    messagesRead,
    mailboxComplete,
    receivedCoinsAdded: coinsAfter
      .filter(coin => !coinsBefore.has(coin.address))
      .map(coin => ({
        address: coin.address,
        claimedAmountWei: coin.claimedAmountWei,
        state: coin.state,
      })),
    receivedCoinsChanged: coinsAfter.filter(coin => {
      const before = coinsBefore.get(coin.address)
      return before !== undefined && before.state !== coin.state
    }).length,
    accountsAdded: deps
      .coinListAccounts()
      .map(account => account.toLowerCase())
      .filter(account => !accountsBefore.has(account))
      .filter((account, index, all) => all.indexOf(account) === index),
    operationsObserved,
    operationsChanged,
    failures,
  }
}
