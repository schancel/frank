/**
 * Background coin consolidation for one EVM wallet: when stamps and payouts have left more small
 * coins than the coin distribution's band allows (`evm-coin-distribution.ts`), merge the smallest
 * eligible ones into one fresh change account.
 *
 * A merge is an ordinary transaction set: the same selection, reservation, journal, submission
 * and recovery as every payment (`EvmTransactionSetPreparer.quoteSweepTransactionSet`, then a set
 * restricted to the chosen coins, each moved whole to the fresh account). So:
 * - it takes only coins no operation holds, and a payment built meanwhile selects other coins;
 *   nothing here holds a wallet-wide lock, and a network wait never blocks a send;
 * - its signed transactions are journalled before any of them is broadcast, and a restart
 *   resumes the same set (the same bytes), never a second merge of the same coins;
 * - its transactions note themselves to the account's other devices like any send (composition
 *   wires the notes; this module has no transport);
 * - the fresh account is derived from the coins it merges (`evm-merge-targets.ts`): every device
 *   of the account that plans the same merge signs the same transactions to the same account,
 *   and nothing is allocated. Once a move to it has landed it is watched as the wallet's own
 *   (`listTarget`); another device finds it from the accounts the merge emptied.
 *
 * One merge at a time: while one is still on its way, the next call only resumes it.
 * Composition calls `maintain` from a host's idle tick (no message being sent or reconciled); a
 * host that may not start merges (not the account's active device) calls it with
 * `startNew: false`, which still finishes the merges already signed.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { ZeroAddress } from 'ethers'
import type { EvmCoinList, EvmListCoin } from './evm-coin-list'
import { EVM_MAX_POOL_COINS, EVM_POOL_COIN_ORIGINS, planEvmCoinMerge } from './evm-coin-distribution'
import type { EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EvmTransactionSetInsufficientFundsError,
  type PreparedEvmTransactionSet,
} from './evm-transaction-set-types'
import {
  nativeMemberSuperseded,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'
import type { TransactionSetSubmission } from './transaction-set'
import { Transaction } from 'ethers'
import { evmMergeAnchor, type EvmMergeAnchor } from './evm-merge-targets'
import {
  NativeTransactionSubmissionError,
  type CoinMaintenanceResult,
} from './chain/chain-wallet'

/** A handoff whose outcome is not known yet is no failure of the merge: the journal keeps the
 * set and the next tick offers the same bytes again. Anything else is the caller's to see. */
const pendingHandoff = (error: unknown): undefined => {
  if (error instanceof NativeTransactionSubmissionError) return undefined
  throw error
}

/** The logical ID of every merge: `consolidate-<32 hex>` (History names it from this prefix). */
export const EVM_CONSOLIDATION_PREFIX = 'consolidate-'
const PREPARATION_PREFIX = 'evm-transaction-set:'

export type EvmCoinMaintenance = CoinMaintenanceResult

export interface EvmCoinConsolidatorDeps {
  readonly chainIdentifier: string
  readonly coins: EvmCoinList
  readonly preparer: EvmTransactionSetPreparer
  /** The wallet's active journal rows (no request). */
  readonly operations: () => readonly EvmNativeOperation[]
  /** The fresh account a merge with this anchor goes to (`EvmMergeTargets.targetFor`). */
  readonly targetFor: (anchor: EvmMergeAnchor) => { account: string; changeIndex: number }
  /** Hands a journalled set to the network (the wallet's transaction-set submission). */
  readonly submit: (prepared: PreparedEvmTransactionSet) => Promise<TransactionSetSubmission>
  /** A merge's fresh account that a move has reached: list it as the wallet's own and read it
   * into the coin list from the chain (nothing when the chain shows it unused yet). */
  readonly listTarget?: (target: { account: string; changeIndex: number }) => Promise<void>
  /** Reads the wallet's coins and what its fee quote needs (gas price, head) from the node. */
  readonly refresh?: () => Promise<void>
}

/** The merge's logical ID: from the chain, the fresh account and the coins it moves, so the same
 * merge has the same name on every device that sees it. */
export function consolidationId(
  chainIdentifier: string,
  target: string,
  coins: readonly Pick<EvmListCoin, 'account' | 'nonce'>[],
): string {
  const keys = coins.map(coin => `${coin.account.toLowerCase()}:${coin.nonce}`).sort()
  const digest = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([chainIdentifier, target.toLowerCase(), keys]))),
  )
  return EVM_CONSOLIDATION_PREFIX + digest.slice(0, 32)
}

export function isConsolidation(row: Pick<EvmNativeOperation, 'preparationId'>): boolean {
  return row.preparationId?.startsWith(PREPARATION_PREFIX + EVM_CONSOLIDATION_PREFIX) === true
}

const settled = (member: EvmNativeOperation['members'][number]) =>
  member.observation.state === 'included-success' ||
  member.observation.state === 'included-revert' ||
  nativeMemberSuperseded(member)

export function createEvmCoinConsolidator(deps: EvmCoinConsolidatorDeps) {
  let running: Promise<EvmCoinMaintenance> | undefined

  const unfinished = () =>
    deps
      .operations()
      .filter(row => !row.cancelled && isConsolidation(row) && !row.members.every(settled))

  /** Whether a merge may move this coin whole now. The quote checks the rest (the journal's
   * claims, the wallet's selection rules, the chain's spend rule for this exact coin). */
  const movable = (head: number, waitBlocks: number | undefined) => (coin: EvmListCoin) =>
    !deps.preparer.isSourceReserved(coin.account) &&
    (coin.spendableFromBlock === undefined || coin.spendableFromBlock <= head) &&
    (!waitBlocks ||
      coin.nonce === 0 ||
      (coin.lastSpentInBlock !== undefined && head >= coin.lastSpentInBlock + waitBlocks))

  /** A journalled merge's target, from the coins it spends. */
  const targetOf = (row: EvmNativeOperation) =>
    deps.targetFor(
      evmMergeAnchor(
        row.members.map(member => ({
          account: member.source.address,
          nonce: Transaction.from(member.unsignedTransaction).nonce,
        })),
      ),
    )

  /** Merges a move of which has landed whose fresh account is not a coin of the list yet. */
  const unlisted = () =>
    deps
      .operations()
      .filter(
        row =>
          !row.cancelled &&
          isConsolidation(row) &&
          deps.coins.latestOf(row.recipient) === undefined &&
          row.members.some(member => member.observation.state === 'included-success'),
      )

  const once = async (startNew: boolean): Promise<EvmCoinMaintenance> => {
    for (const row of unlisted()) await deps.listTarget?.(targetOf(row)).catch(() => undefined)
    const open = unfinished()
    if (open.length > 0) {
      const row = open[0]!
      const logicalId = row.preparationId!.slice(PREPARATION_PREFIX.length)
      // The same signed set again, never a new one.
      await deps.submit(await deps.preparer.readTransactionSet(logicalId)).catch(pendingHandoff)
      await deps.listTarget?.(targetOf(row)).catch(() => undefined)
      return { outcome: 'waiting', operationId: logicalId }
    }
    // Listing a merge's money and offering a signed merge again finish what was already signed;
    // planning a new merge is left to the caller that may start one.
    if (!startNew) return { outcome: 'idle' }
    // Without more pool coins than the band's top, whatever their value, there is nothing to
    // merge: an idle wallet's step ends here, with no node request.
    const pooled = deps.coins.liveUnspent().filter(coin => EVM_POOL_COIN_ORIGINS.has(coin.origin)).length
    if (pooled <= EVM_MAX_POOL_COINS) return { outcome: 'idle' }
    // There may be: read the coins, the head and the gas price now (a merge planned on a stale
    // head could take a coin listed fewer than the confirmation depth ago).
    await deps.refresh?.()
    const policy = deps.preparer.transactionSetPolicy()
    const distribution = policy.coinDistribution
    if (distribution === undefined) return { outcome: 'idle' }
    const plan = planEvmCoinMerge({
      coins: deps.coins.liveUnspent(),
      distribution,
      head: policy.head,
      movable: movable(policy.head, policy.spendRule?.waitBlocks),
    })
    if (!plan) return { outcome: 'idle' }
    // What the merge would move. The destination only names whose coin is not moved; the fresh
    // account has none.
    let quote
    try {
      quote = await deps.preparer.quoteSweepTransactionSet({
        destination: ZeroAddress,
        sourceAccounts: plan.map(coin => coin.account),
      })
    } catch (error) {
      if (error instanceof EvmTransactionSetInsufficientFundsError) return { outcome: 'idle' }
      throw error
    }
    if (quote.sourceAccounts.length < 2) return { outcome: 'idle' }
    const moved = new Set(quote.sourceAccounts)
    const coins = plan.filter(coin => moved.has(coin.account))
    // Everything below is a function of these coins: the same merge on every device.
    const target = deps.targetFor(evmMergeAnchor(coins))
    const operationId = consolidationId(deps.chainIdentifier, target.account, coins)
    const sourceAccounts = coins.map(coin => coin.account).sort()
    let prepared: PreparedEvmTransactionSet
    try {
      prepared = await deps.preparer.constructTransactionSet({
        operationId,
        amountWei: quote.amountWei,
        kdf: () => target.account,
        sourceAccounts,
        maxPaymentParts: sourceAccounts.length,
        maxFeeWei: quote.feeWei,
      })
    } catch (error) {
      // A payment took one of the coins between the quote and the construction: nothing was
      // signed. The next idle tick plans again.
      if (error instanceof EvmTransactionSetInsufficientFundsError) return { outcome: 'idle' }
      throw error
    }
    // Journalled: from here a failed handoff is resumed on the next tick, never rebuilt.
    await deps.submit(prepared).catch(pendingHandoff)
    return {
      outcome: 'merged',
      operationId,
      coins: quote.sourceAccounts.length,
      feeWei: quote.feeWei,
      target: target.account.toLowerCase(),
    }
  }

  return {
    /**
     * One maintenance step; concurrent callers share it. With `startNew: false` it only finishes
     * merges already signed (lists their target, offers their signed set again) and plans none:
     * a host that is not the account's active device calls it so.
     */
    maintain({ startNew = true }: { startNew?: boolean } = {}): Promise<EvmCoinMaintenance> {
      return (running ??= once(startNew).finally(() => {
        running = undefined
      }))
    },
    /** Merges still on their way (journal rows), by logical ID. */
    pending(): string[] {
      return unfinished().map(row => row.preparationId!.slice(PREPARATION_PREFIX.length))
    },
  }
}

export type EvmCoinConsolidator = ReturnType<typeof createEvmCoinConsolidator>
