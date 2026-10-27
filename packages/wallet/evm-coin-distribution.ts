/**
 * How an EVM wallet keeps its free money spread over coins: one policy, read by both the change
 * splitter (every payment, `EvmTransactionSetPreparer`) and background consolidation
 * (`evm-coin-consolidator.ts`), so neither can undo what the other did.
 *
 * Owner rulings this follows:
 * - a payment splits what it leaves over at most 4 fresh change coins, so repeated sends grow the
 *   set of spendable coins a few at a time;
 * - no coin is ever made below the payment floor (10 plain transfers' fees), and a move that costs
 *   more than the value it moves is not made;
 * - background consolidation merges the many small coins stamps and payouts leave (2026-10-26),
 *   and it "doesn't sweep shit we just created as change ... designed with the same thresholds in
 *   mind" (2026-10-27).
 *
 * The band, all derived from those two numbers (the change cap and the floor):
 *
 * - A pool coin is a coin of the shared spending pool (stealth, stamp, change, HD sub-account;
 *   not the main or identity account, which hold deposits and contract balances) worth at least
 *   the payment floor. Only pool coins are counted or merged: a coin below the floor is not
 *   spendable money in the wallet's sense (`payment-floor.ts`), and merging it would cost more
 *   than a tenth of it.
 * - The band's top is `maxCoins` = 2 x the change cap = 8 pool coins: one payment's change plus as
 *   much again of room for parallel sends. The splitter never takes the pool above it: a
 *   payment makes only as many change coins as fit under it, and with no room its residual stays
 *   with its source on the next nonce. So sends alone never start a consolidation. (The one
 *   exception: a set that needs private change for a later leg of the same operation still gets
 *   one change coin; a send is never refused for the band.)
 * - Consolidation starts only above the top (stamps and payouts pushed the pool over) and merges
 *   the smallest eligible coins into ONE fresh account until the pool is back at
 *   `mergeDownToCoins` = change cap + 1 = 5: the newest change-cap's worth of coins plus the
 *   merged one. That is the hysteresis: the next payment's change fits under the top again.
 * - It never merges what was just made: the newest `keepNewestCoins` (= the change cap, as many
 *   as one payment can have just created) pool coins are kept, and so is any coin listed fewer
 *   than `confirmationBlocks` blocks ago (`EVM_FAILURE_CONFIRMATIONS`, the wallet's own depth
 *   for trusting a transaction's outcome).
 * - It never touches a coin an operation holds, a coin selection may not use (unverified
 *   receipts are not coins at all), or one the chain's spend rule keeps (Monad: an account that
 *   sent within the last blocks may not empty itself); every one of its moves goes through the
 *   same selection, reservation, journal and submission as a payment.
 *
 * Pure: no I/O, no clock. The gas price is the caller's cached quote.
 */
import { EVM_FAILURE_CONFIRMATIONS } from './chain/evm-settlement'
import { EVM_TRANSFER_GAS, evmPaymentFloorWei } from './chain/payment-floor'
import type { EvmCoinListOrigin, EvmListCoin } from './evm-coin-list'

/** Owner ruling: at most this many fresh change coins per payment. */
export const EVM_MAX_CHANGE_OUTPUTS = 4

/** The band's top: no more than this many pool coins after a payment's change. */
export const EVM_MAX_POOL_COINS = 2 * EVM_MAX_CHANGE_OUTPUTS

/** The journal's member capacity per transaction set: one merge moves at most this many coins. */
const MAX_SET_MEMBERS = 64

export interface EvmCoinDistribution {
  /** The payment floor at the quoted gas price: no coin is made below it, and only coins at or
   * above it are counted and merged. */
  readonly floorWei: bigint
  /** What moving one coin costs: one plain transfer. */
  readonly moveFeeWei: bigint
  /** The most fresh change coins one payment makes. */
  readonly maxChangeOutputs: number
  /** The band's top: the most pool coins the splitter leaves, and above which a merge starts. */
  readonly maxCoins: number
  /** What a merge brings the pool back to. */
  readonly mergeDownToCoins: number
  /** The newest pool coins a merge never takes. */
  readonly keepNewestCoins: number
  /** A coin listed fewer blocks ago than this is never merged. */
  readonly confirmationBlocks: number
  /** The most coins one merge moves (one transaction set). */
  readonly maxMergeInputs: number
}

export function evmCoinDistribution(gasPriceWei: bigint): EvmCoinDistribution {
  return {
    floorWei: evmPaymentFloorWei(gasPriceWei),
    moveFeeWei: EVM_TRANSFER_GAS * gasPriceWei,
    maxChangeOutputs: EVM_MAX_CHANGE_OUTPUTS,
    maxCoins: EVM_MAX_POOL_COINS,
    mergeDownToCoins: EVM_MAX_CHANGE_OUTPUTS + 1,
    keepNewestCoins: EVM_MAX_CHANGE_OUTPUTS,
    confirmationBlocks: EVM_FAILURE_CONFIRMATIONS,
    maxMergeInputs: MAX_SET_MEMBERS,
  }
}

/** The origins of the shared spending pool: what the band counts and a merge may move. */
export const EVM_POOL_COIN_ORIGINS: ReadonlySet<EvmCoinListOrigin> = new Set<EvmCoinListOrigin>([
  'stealth',
  'stamp',
  'change',
  'deterministic',
])

export function isPoolCoin(
  coin: Pick<EvmListCoin, 'origin' | 'valueWei'>,
  distribution: EvmCoinDistribution,
): boolean {
  return EVM_POOL_COIN_ORIGINS.has(coin.origin) && coin.valueWei >= distribution.floorWei
}

/** The pool coins among `coins` (the list's live unspent coins), less those of `excluded`
 * accounts (a payment's own sources, which it spends). */
export function countPoolCoins(
  coins: readonly EvmListCoin[],
  distribution: EvmCoinDistribution,
  excluded: ReadonlySet<string> = new Set(),
): number {
  return coins.filter(coin => !excluded.has(coin.account) && isPoolCoin(coin, distribution))
    .length
}

/**
 * The splitter's side of the band for one transaction set: how many change coins each of its
 * sources may make so the pool stays at or under `maxCoins`. A source whose residual (what it
 * holds beyond its payment and that payment's fee) is at least the floor leaves at least one
 * coin: its change, or what stays with it on its next nonce. A source spent down below the
 * floor leaves none and is not counted. With no room left a source makes no change and its
 * residual stays with it on its next nonce (AGENTS.md: residual value need not move to fresh
 * change), unless the set needs private change to carry a later leg of the same operation
 * (`atLeastOne`): a send is never refused for the band. Sources are planned in order;
 * `planned` records what each made.
 */
export class EvmChangeBand {
  private left: number
  private sourcesLeft: number
  private readonly floorWei: bigint
  constructor(
    distribution: EvmCoinDistribution | undefined,
    otherPoolCoins: number,
    /** The residuals of the set's sources, in planning order. */
    residualsWei: readonly bigint[],
  ) {
    this.left = distribution === undefined ? Infinity : distribution.maxCoins - otherPoolCoins
    this.floorWei = distribution?.floorWei ?? 0n
    this.sourcesLeft = residualsWei.filter(residual => this.leaves(residual)).length
  }

  /** Whether a source with this residual leaves a pool coin behind. */
  leaves(residualWei: bigint): boolean {
    return residualWei >= this.floorWei
  }

  /** The most change coins the next source (with this residual) may make, given what else
   * limits it (`base`). */
  allowance(base: number, residualWei: bigint, atLeastOne = false): number {
    if (base < 1 || this.left === Infinity || !this.leaves(residualWei)) return base
    const room = this.left - Math.max(0, this.sourcesLeft - 1)
    return Math.max(atLeastOne ? 1 : 0, Math.min(base, room))
  }

  /** The source just planned (with this residual) made `outputs` change coins (none: what is
   * left stays with it). */
  planned(outputs: number, residualWei: bigint): void {
    if (this.left === Infinity) return
    if (!this.leaves(residualWei)) {
      this.left -= outputs
      return
    }
    this.left -= Math.max(1, outputs)
    this.sourcesLeft = Math.max(0, this.sourcesLeft - 1)
  }

  /** One more source joins the set (a continuation's change-only input), with this residual. */
  addSource(residualWei: bigint): void {
    if (this.leaves(residualWei)) this.sourcesLeft++
  }
}

/** Whether a merge may take this coin now: never one listed within the confirmation depth. */
function settledEnough(coin: EvmListCoin, head: number, distribution: EvmCoinDistribution): boolean {
  return coin.listedInBlock === undefined || head - coin.listedInBlock >= distribution.confirmationBlocks
}

/** Newest first: by the block the coin was listed in, then by change allocation order. */
function newestFirst(a: EvmListCoin, b: EvmListCoin): number {
  return (
    (b.listedInBlock ?? -1) - (a.listedInBlock ?? -1) ||
    (b.changeIndex ?? -1) - (a.changeIndex ?? -1) ||
    a.account.localeCompare(b.account)
  )
}

/**
 * The coins one background merge should move into a fresh account, smallest first, or
 * undefined when the pool is inside the band or fewer than two coins may be merged.
 *
 * `coins` are the list's live unspent coins (`EvmCoinList.liveUnspent`); `movable` says whether
 * the wallet may move a coin whole right now (no operation holds it, selection may use it, the
 * chain's spend rule lets it empty). Kept out, whatever they are worth: the newest
 * `keepNewestCoins` pool coins and every coin listed within `confirmationBlocks` of `head`.
 */
export function planEvmCoinMerge(params: {
  readonly coins: readonly EvmListCoin[]
  readonly distribution: EvmCoinDistribution
  readonly head: number
  readonly movable: (coin: EvmListCoin) => boolean
}): EvmListCoin[] | undefined {
  const { distribution, head } = params
  const pool = params.coins.filter(coin => isPoolCoin(coin, distribution))
  if (pool.length <= distribution.maxCoins) return undefined
  const kept = new Set(
    [...pool].sort(newestFirst).slice(0, distribution.keepNewestCoins).map(coin => coin.account),
  )
  const candidates = pool
    .filter(
      coin => !kept.has(coin.account) && settledEnough(coin, head, distribution) && params.movable(coin),
    )
    .sort((a, b) =>
      a.valueWei < b.valueWei ? -1 : a.valueWei > b.valueWei ? 1 : a.account.localeCompare(b.account),
    )
  // n coins merged leave pool - n + 1.
  const needed = pool.length - distribution.mergeDownToCoins + 1
  const take = Math.min(needed, candidates.length, distribution.maxMergeInputs)
  return take < 2 ? undefined : candidates.slice(0, take)
}
