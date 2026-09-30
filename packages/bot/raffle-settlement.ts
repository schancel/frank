/**
 * Raffle draw settlement (#363): the money-moving half of a raffle round, kept out of the
 * `.livecheck.ts` script so it is unit-testable with fake ports and crash injection.
 *
 * ## Root cause this replaces
 *
 * An entry is swept from its stamp child address into the bot identity NET of the sweep's gas
 * (`sweepRecoveredMonadStampPayment` moves `balance - dustThreshold`), so an identity that holds
 * only entry money is always short of the gross pot (`entryPrice * n`) by the sweep costs. The old
 * draw path sent the draw DM (winner and seed) to every entrant first, then compared the identity
 * balance to the pot and THREW when it was short: the winner was announced, never paid, the round
 * was lost and the process exited.
 *
 * ## Order (each step is durable before the next; a crash resumes from the record)
 *
 *  1. `beginDraw` -- one atomic write: the draw record (`awaiting-funds`), the fresh next round
 *     and its fresh commitment. The full round can no longer be lost, and new entries go to a
 *     round whose commitment was made before it had entrants.
 *  2. Verify the pot is available: identity balance >= pot + payout gas. The swept-entry gas
 *     shortfall is covered from the operator wallet, but only within (a) the plausible gas dust for
 *     this round size (a bigger gap means an under-paying entry, not gas), (b) a persisted
 *     per-round cap and (c) a persisted per-day ceiling. Otherwise the draw is HELD
 *     (`awaiting-funds`): never thrown, never announced, retried each tick.
 *  3. Sign the payout once and persist the exact bytes (`signed`) BEFORE the first broadcast.
 *  4. Broadcast (and re-broadcast on every retry) THE SAME BYTES: same nonce, same hash, so a
 *     retry can never pay twice. Reconcile by hash: `confirmed` -> `paid`. A tx that mined and
 *     reverted is final, so only then is the intent re-signed.
 *  5. Only when `paid`: announce (reveal the seed) to each entrant, recording each send.
 *     Announcements are independent of payouts: a failing DM never delays any payout (payouts are
 *     the only strictly sequential part) and is retried per recipient with backoff.
 *  6. A signed payout stuck for a long time is reported at error level (STUCK). Only if the node
 *     does not know the tx at all is it re-signed with the SAME nonce and a higher fee, so at most
 *     one of the attempts can ever mine (a replacement, never a second payment).
 *
 * Every entry credited to a round was verified by `recoverAndSweepEntryPayment` to carry at least
 * the round's entry price in on-chain stamp payments to the bot's derived child addresses, so the
 * pot is backed by verified payments; the identity balance differs from it only by sweep gas.
 *
 * Insufficient funds deliberately do NOT refund entrants here: a refund shares the identity's
 * nonce and balance with the payout, which is exactly the design problem tracked in #218. The
 * round is held with a loud, deduplicated owner-facing message and pays as soon as the operator
 * wallet is funded; other rounds keep filling meanwhile. No refund is ever sent, so none can be
 * sent twice.
 */
import { RaffleItem } from '@frank/cashweb/types/messages'
import {
  buildRaffleDrawItem,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/raffle/draw'

import {
  RaffleDrawRecord,
  RaffleBotStateStore,
  RaffleRoundRecord,
} from './raffle-bot-state'

/** Bot defaults, shared with the launcher's docs/tests so they cannot drift (#363). The launcher
 * keeps the default price and overrides only the round size (3) so a demo round fills quickly. */
export const RAFFLE_DEFAULT_ENTRY_PRICE_WEI = '20000000000000000' // 0.02 MON
export const RAFFLE_DEFAULT_MAX_ENTRIES = 5
export const RAFFLE_DEFAULT_MAX_TOPUP_WEI = '50000000000000000' // 0.05 MON, per round
export const RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI = '250000000000000000' // 5x per round

const MINUTE_MS = 60_000

export interface PayoutAttempt {
  rawTx: string
  txHash: string
}

export interface RaffleSettlementPorts {
  /** The bot identity's current on-chain balance. */
  getBalanceWei(): Promise<bigint>
  /** The operator wallet's balance (a top-up is only attempted when it can pay it). */
  operatorBalanceWei(): Promise<bigint>
  /** Worst-case gas the payout transfer itself costs (paid from the identity). */
  payoutGasReserveWei(): Promise<bigint>
  /** Current per-sweep gas cost (the amount an entry loses on its way to the identity). */
  sweepDustWei(): Promise<bigint>
  /** Operator wallet -> identity transfer of `shortfallWei`, confirmed. Throws if it cannot. */
  topUpIdentity(shortfallWei: bigint): Promise<void>
  signPayout(to: string, valueWei: bigint): Promise<PayoutAttempt>
  /** Re-sign `previousRawTx` with the SAME nonce, to, value and a higher fee. */
  repricePayout(previousRawTx: string): Promise<PayoutAttempt>
  /** Broadcast exactly these bytes (idempotent by hash). */
  broadcast(rawTx: string, txHash: string): Promise<void>
  getStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
  /** Whether the node knows the tx at all (mempool or mined). */
  isTxKnown(txHash: string): Promise<boolean>
  /** Send the draw item to one entrant. Throw to have it retried; return normally when sent or
   * when the entrant is permanently unreachable. */
  announce(entrantAddress: string, draw: RaffleItem): Promise<void>
  log(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type DrawSettleStatus =
  | 'held'
  | 'queued'
  | 'pending'
  | 'announce-incomplete'
  | 'done'

export interface RaffleSettleResult {
  raffleId: string
  status: DrawSettleStatus
  /** True when this pass changed durable state for the draw (phase, announcement, completion). */
  progressed: boolean
}

/** Opens the draw for a full current round (idempotent): records draw + rotation atomically.
 * Returns whether a draw was recorded. Also the restart path for a full persisted round. */
export async function beginDrawIfFull(params: {
  state: RaffleBotStateStore
  newServerSeed: () => string
  newRaffleId: () => string
  entryPriceWei: string
  maxEntries: number
  log?: (message: string) => void
}): Promise<boolean> {
  const round = params.state.getCurrentRound()
  if (!round || round.entrants.length < round.maxEntries) return false
  const commitment = params.state.getPendingCommitment()
  if (!commitment || commitment.serverSeedHash !== round.serverSeedHash) {
    throw new Error(
      `[raffle-bot] internal error: no matching pending commitment for full round ${round.raffleId}`,
    )
  }
  const drawItem = buildRaffleDrawItem({
    raffleId: round.raffleId,
    entryPriceWei: round.entryPriceWei,
    serverSeed: commitment.serverSeed,
    entrants: round.entrants.map(e => e.address),
    entryTxHashes: round.entrants.map(e => e.txHash),
  })
  const nextSeed = params.newServerSeed()
  const nextHash = sha256Hex(nextSeed)
  const nextRound: RaffleRoundRecord = {
    raffleId: params.newRaffleId(),
    entryPriceWei: params.entryPriceWei,
    maxEntries: params.maxEntries,
    serverSeedHash: nextHash,
    entrants: [],
  }
  await params.state.beginDraw({
    draw: {
      raffleId: round.raffleId,
      drawItem,
      phase: 'awaiting-funds',
      announcedTo: [],
      topUpWei: '0',
    },
    nextRound,
    nextCommitment: { serverSeed: nextSeed, serverSeedHash: nextHash },
  })
  params.log?.(
    `[raffle-bot] round ${round.raffleId} is full: draw recorded (winner ${drawItem.winnerAddress}, pot ${drawItem.potWei} wei); settling before any announcement. Next round ${nextRound.raffleId}.`,
  )
  return true
}

/** Settles recorded draws. Payouts are strictly sequential (oldest first, one identity nonce
 * sequence): the first draw whose payout is not confirmed blocks later PAYOUTS only. Announcements
 * of already-paid draws proceed independently and are retried per recipient with backoff. Never
 * throws for a port failure: it logs and leaves the record at its last durable phase. */
export function createRaffleSettler(params: {
  state: RaffleBotStateStore
  ports: RaffleSettlementPorts
  /** Cumulative operator top-up allowed per round. */
  maxTopUpPerRoundWei: bigint
  /** Cumulative operator top-up allowed per trailing 24 hours across all rounds. */
  maxTopUpPerDayWei: bigint
  now?: () => number
  stuckAfterMs?: number
  repriceAfterMs?: number
  maxReprices?: number
}): () => Promise<RaffleSettleResult[]> {
  const { state, ports } = params
  const now = params.now ?? Date.now
  const stuckAfterMs = params.stuckAfterMs ?? 10 * MINUTE_MS
  const repriceAfterMs = params.repriceAfterMs ?? 15 * MINUTE_MS
  const maxReprices = params.maxReprices ?? 3
  const lastMessage = new Map<string, string>()
  const alert = (
    key: string,
    message: string,
    level: 'warn' | 'error' = 'warn',
  ) => {
    if (lastMessage.get(key) === message) return
    lastMessage.set(key, message)
    ports[level](message)
  }
  const errText = (err: unknown) =>
    err instanceof Error ? err.message : String(err)
  const announceFailures = new Map<
    string,
    { count: number; nextAtMs: number }
  >()

  /** Advances the payout as far as it can; returns the updated record and whether it is `paid`. */
  async function advancePayout(
    initial: RaffleDrawRecord,
  ): Promise<{
    draw: RaffleDrawRecord
    status: DrawSettleStatus
    progressed: boolean
  }> {
    let draw = initial
    let progressed = false
    const { raffleId } = draw
    const pot = BigInt(draw.drawItem.potWei)
    const tag = `[raffle-bot] round ${raffleId}`
    const held = (message: string) => {
      alert(raffleId, `${tag} HELD: ${message} Winner NOT announced or paid.`)
      return { draw, status: 'held' as const, progressed }
    }

    if (draw.phase === 'awaiting-funds') {
      const gas = await ports.payoutGasReserveWei()
      const required = pot + gas
      const balance = await ports.getBalanceWei()
      if (balance < required) {
        const shortfall = required - balance
        const entrants = BigInt(draw.drawItem.entrants?.length ?? 0)
        const dust = await ports.sweepDustWei()
        const plausible = entrants * dust * 2n + gas * 2n
        if (shortfall > plausible) {
          return held(
            `identity holds ${balance} wei, needs ${required} (pot ${pot} + payout gas ${gas}); the ${shortfall} wei gap exceeds the plausible sweep-gas dust for ${entrants} entrants (${plausible}), so an entry probably paid less than the entry price. Investigate; no operator funds moved.`,
          )
        }
        const spent = BigInt(draw.topUpWei ?? '0')
        if (spent + shortfall > params.maxTopUpPerRoundWei) {
          return held(
            `top-up of ${shortfall} wei would take this round's operator top-ups to ${
              spent + shortfall
            }, over the per-round limit ${
              params.maxTopUpPerRoundWei
            } (RAFFLE_BOT_MAX_TOPUP_WEI).`,
          )
        }
        const today = state.topUpTotalSince(now())
        if (today + shortfall > params.maxTopUpPerDayWei) {
          return held(
            `top-up of ${shortfall} wei would take today's operator top-ups to ${
              today + shortfall
            }, over the per-day limit ${
              params.maxTopUpPerDayWei
            } (RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI).`,
          )
        }
        if ((await ports.operatorBalanceWei()) < shortfall + gas) {
          return held(
            `the operator wallet cannot cover the ${shortfall} wei top-up. Fund it; this retries automatically.`,
          )
        }
        // Record the spend durably BEFORE moving money, so a restart cannot top up beyond the caps.
        draw = { ...draw, topUpWei: (spent + shortfall).toString() }
        await state.putDraw(draw)
        await state.recordTopUp(now(), shortfall)
        progressed = true
        try {
          await ports.topUpIdentity(shortfall)
        } catch (err) {
          return held(
            `could not top up the raffle identity by ${shortfall} wei from the operator wallet (${errText(
              err,
            )}); the attempt counts against the limits.`,
          )
        }
        if ((await ports.getBalanceWei()) < required) {
          return held(
            `identity balance is still below the required ${required} after top-up (funding not yet visible). Retrying.`,
          )
        }
      }
      // Sign ONCE and persist the exact bytes (fsynced) before the first broadcast.
      const signed = await ports.signPayout(draw.drawItem.winnerAddress, pot)
      draw = {
        ...draw,
        phase: 'signed',
        payout: { ...signed, signedAtMs: now(), previousTxHashes: [] },
      }
      await state.putDraw(draw)
      progressed = true
    }

    if (draw.phase === 'signed') {
      const payout = draw.payout as NonNullable<RaffleDrawRecord['payout']>
      const hashes = [payout.txHash, ...payout.previousTxHashes]
      const statuses = await Promise.all(hashes.map(h => ports.getStatus(h)))
      if (statuses.some(s => s === 'failed')) {
        // Mined and reverted consumes the nonce, so no other attempt can mine: final.
        alert(raffleId, `${tag} payout attempt reverted on-chain; re-signing.`)
        await state.putDraw({
          ...draw,
          phase: 'awaiting-funds',
          payout: undefined,
        })
        return { draw, status: 'pending', progressed: true }
      }
      if (!statuses.some(s => s === 'confirmed')) {
        const ageMs = now() - payout.signedAtMs
        const known = await ports.isTxKnown(payout.txHash)
        if (
          !known &&
          ageMs >= repriceAfterMs &&
          payout.previousTxHashes.length < maxReprices
        ) {
          // Receipt missing AND unknown to the node for a long time: replace it at the SAME
          // nonce with a higher fee. One nonce, so at most one of the attempts can ever mine.
          const bumped = await ports.repricePayout(payout.rawTx)
          draw = {
            ...draw,
            payout: {
              ...bumped,
              signedAtMs: now(),
              previousTxHashes: [...hashes],
            },
          }
          await state.putDraw(draw)
          progressed = true
          ports.warn(
            `${tag} payout ${
              payout.txHash
            } unknown to the node for ${Math.round(
              ageMs / MINUTE_MS,
            )} min; replaced at the same nonce by ${bumped.txHash}.`,
          )
        }
        const current = draw.payout as NonNullable<RaffleDrawRecord['payout']>
        try {
          await ports.broadcast(current.rawTx, current.txHash)
        } catch (err) {
          alert(
            raffleId,
            `${tag} payout ${current.txHash} broadcast failed (${errText(
              err,
            )}); will retry the same signed tx.`,
          )
        }
        const after = await Promise.all(
          [current.txHash, ...current.previousTxHashes].map(h =>
            ports.getStatus(h),
          ),
        )
        if (!after.some(s => s === 'confirmed')) {
          const stuckMin = Math.floor((now() - current.signedAtMs) / MINUTE_MS)
          if (stuckMin >= stuckAfterMs / MINUTE_MS) {
            alert(
              `${raffleId}:stuck`,
              `${tag} STUCK payout ${current.txHash}: signed ${stuckMin} min ago, still unconfirmed (fee cap too low, or the identity lacks gas). The winner is NOT announced. Recovery: see packages/bot/README.md "Stuck payout".`,
              'error',
            )
          } else {
            alert(
              raffleId,
              `${tag} payout ${current.txHash} not yet confirmed; winner not announced yet.`,
            )
          }
          return { draw, status: 'pending', progressed }
        }
      }
      draw = { ...draw, phase: 'paid' }
      await state.putDraw(draw)
      progressed = true
      ports.log(`${tag} payout confirmed`)
    }
    return { draw, status: 'done', progressed }
  }

  /** phase === 'paid': the pot is with the winner, so the seed may now be revealed. */
  async function announce(
    initial: RaffleDrawRecord,
  ): Promise<{ status: DrawSettleStatus; progressed: boolean }> {
    let draw = initial
    let progressed = false
    const tag = `[raffle-bot] round ${draw.raffleId}`
    for (const entrant of draw.drawItem.entrants ?? []) {
      if (draw.announcedTo.includes(entrant)) continue
      const key = `${draw.raffleId}:${entrant}`
      const fail = announceFailures.get(key)
      if (fail && now() < fail.nextAtMs) continue
      try {
        await ports.announce(entrant, draw.drawItem)
      } catch (err) {
        const count = (fail?.count ?? 0) + 1
        announceFailures.set(key, {
          count,
          nextAtMs: now() + Math.min(5_000 * 2 ** count, 5 * MINUTE_MS),
        })
        alert(
          key,
          `${tag} announcing to ${entrant} failed (${errText(
            err,
          )}); retrying with backoff. Payout is already confirmed.`,
        )
        continue
      }
      announceFailures.delete(key)
      draw = { ...draw, announcedTo: [...draw.announcedTo, entrant] }
      await state.putDraw(draw)
      progressed = true
    }
    if (
      (draw.drawItem.entrants ?? []).every(e => draw.announcedTo.includes(e))
    ) {
      await state.removeDraw(draw.raffleId)
      ports.log(`${tag} settled: paid and announced`)
      return { status: 'done', progressed: true }
    }
    return { status: 'announce-incomplete', progressed }
  }

  return async () => {
    const results: RaffleSettleResult[] = []
    let payoutsBlocked = false
    for (const initial of state.getDraws()) {
      let draw = initial
      let progressed = false
      if (draw.phase !== 'paid') {
        if (payoutsBlocked) {
          results.push({
            raffleId: draw.raffleId,
            status: 'queued',
            progressed: false,
          })
          continue
        }
        let step
        try {
          step = await advancePayout(draw)
        } catch (err) {
          alert(
            draw.raffleId,
            `[raffle-bot] round ${draw.raffleId} settlement error (${errText(
              err,
            )}); will retry.`,
          )
          payoutsBlocked = true
          results.push({
            raffleId: draw.raffleId,
            status: 'held',
            progressed: false,
          })
          continue
        }
        draw = step.draw
        progressed = step.progressed
        if (draw.phase !== 'paid') {
          payoutsBlocked = true
          results.push({
            raffleId: draw.raffleId,
            status: step.status,
            progressed,
          })
          continue
        }
      }
      try {
        const a = await announce(draw)
        results.push({
          raffleId: draw.raffleId,
          status: a.status,
          progressed: progressed || a.progressed,
        })
      } catch (err) {
        alert(
          draw.raffleId,
          `[raffle-bot] round ${
            draw.raffleId
          } announcement bookkeeping error (${errText(err)}); will retry.`,
        )
        results.push({
          raffleId: draw.raffleId,
          status: 'announce-incomplete',
          progressed,
        })
      }
    }
    return results
  }
}

/** One loop step (extracted from the bot's main loop so its wiring is tested): opens a draw for a
 * full round, settles, and decides whether the idle timeout may end the process. The process must
 * NEVER idle-exit while any draw is unsettled (a held round would otherwise never be paid), and
 * settlement progress counts as activity. */
export async function raffleTick(params: {
  state: RaffleBotStateStore
  openDrawIfFull: () => Promise<boolean>
  settle: () => Promise<RaffleSettleResult[]>
  nowMs: number
  lastActivityAtMs: number
  idleTimeoutMs: number
}): Promise<{ exit: boolean; lastActivityAtMs: number; drawsOpened: number }> {
  let lastActivityAtMs = params.lastActivityAtMs
  const exit =
    params.state.getDraws().length === 0 &&
    params.nowMs - lastActivityAtMs > params.idleTimeoutMs
  if (exit) return { exit, lastActivityAtMs, drawsOpened: 0 }
  const drawsOpened = (await params.openDrawIfFull()) ? 1 : 0
  const results = await params.settle()
  if (drawsOpened > 0 || results.some(r => r.progressed)) {
    lastActivityAtMs = params.nowMs
  }
  return { exit: false, lastActivityAtMs, drawsOpened }
}
