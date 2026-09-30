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
 * What backs the pot: `recoverAndSweepEntryPayment` requires (a) the entry's verified payments to
 * the bot's derived child addresses to total at least the entry price, and (b) the amount ACTUALLY
 * swept into the identity, plus the sweep gas tolerance (one dust threshold per payment), to be at
 * least the entry price; an entry failing either is not credited. The identity balance therefore
 * differs from the pot only by roughly the sweep gas.
 *
 * Insufficient funds deliberately do NOT refund entrants here: a refund shares the identity's
 * nonce and balance with the payout, which is exactly the design problem tracked in #218. The
 * round is held with a loud, deduplicated owner-facing message and pays as soon as the operator
 * wallet is funded; other rounds keep filling meanwhile. No refund is ever sent, so none can be
 * sent twice.
 */
import { Transaction } from 'ethers'

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
 * keeps the default price; its round size is the launcher table's default. */
export const RAFFLE_DEFAULT_ENTRY_PRICE_WEI = '20000000000000000' // 0.02 MON
export const RAFFLE_DEFAULT_MAX_ENTRIES = 5
export const RAFFLE_DEFAULT_MAX_TOPUP_WEI = '50000000000000000' // 0.05 MON, per round
export const RAFFLE_DEFAULT_MAX_TOPUP_PER_DAY_WEI = '250000000000000000' // 5x per round

const MINUTE_MS = 60_000

export interface PayoutAttempt {
  rawTx: string
  txHash: string
}

/** Margin on the plausible-dust bound: the real gap is `entrants x sweep gas + payout gas`; the
 * estimate at draw time can drift a little from what each sweep actually cost (fee changes), so
 * 30% covers that. A larger gap is treated as an under-paying entry, not gas. */
export const PLAUSIBLE_DUST_MARGIN_NUM = 13n
export const PLAUSIBLE_DUST_MARGIN_DEN = 10n

export interface RaffleSettlementPorts {
  /** The bot identity's current on-chain balance. */
  getBalanceWei(): Promise<bigint>
  /** The operator wallet's balance (a top-up is only attempted when it can pay it). */
  operatorBalanceWei(): Promise<bigint>
  /** Gas the payout transfer itself costs at the current fee (paid from the identity). */
  payoutGasReserveWei(): Promise<bigint>
  /** Current per-sweep gas cost (the amount an entry loses on its way to the identity). */
  sweepDustWei(): Promise<bigint>
  /** Sign an operator wallet -> identity transfer (not broadcast; the bytes are persisted first). */
  signTopUp(amountWei: bigint): Promise<PayoutAttempt>
  broadcastTopUp(rawTx: string, txHash: string): Promise<void>
  getTopUpStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
  signPayout(to: string, valueWei: bigint): Promise<PayoutAttempt>
  /** Re-sign `previousRawTx` with the SAME nonce, to and value and a higher fee whose maximum cost
   * fits in `gasBudgetWei` (the identity balance above the pot). `undefined` when no valid
   * replacement is affordable. */
  repricePayout(
    previousRawTx: string,
    gasBudgetWei: bigint,
  ): Promise<PayoutAttempt | undefined>
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

/** Pure fee-bump math for a same-nonce replacement, used by the bot's real `repricePayout` port
 * (extracted so it is tested): keeps nonce, recipient, value and gas limit; multiplies both fee
 * fields by `factor`, but never beyond what `gasBudgetWei` can pay for at the gas limit; returns
 * `undefined` when even the minimum valid replacement (>= 12.5% above the previous fee, the
 * usual replacement rule) does not fit. */
export async function repriceSignedPayout(params: {
  previousRawTx: string
  gasBudgetWei: bigint
  factor?: bigint
  sign: (
    to: string,
    valueWei: bigint,
    overrides: {
      nonce: number
      gasLimit: bigint
      maxFeePerGas: bigint
      maxPriorityFeePerGas: bigint
    },
  ) => Promise<PayoutAttempt>
}): Promise<PayoutAttempt | undefined> {
  const prev = Transaction.from(params.previousRawTx)
  const prevFee = prev.maxFeePerGas ?? prev.gasPrice ?? 0n
  const prevTip = prev.maxPriorityFeePerGas ?? prevFee
  const affordableFee = params.gasBudgetWei / prev.gasLimit
  let fee = prevFee * (params.factor ?? 2n)
  if (fee > affordableFee) fee = affordableFee
  const minFee = (prevFee * 1125n) / 1000n + 1n
  if (fee < minFee) return undefined
  const tip = (prevTip * fee) / (prevFee === 0n ? 1n : prevFee)
  return params.sign(prev.to as string, prev.value, {
    nonce: prev.nonce,
    gasLimit: prev.gasLimit,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: tip > fee ? fee : tip,
  })
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
  /** A persisted top-up the node has never heard of for this long is abandoned (its nonce may
   * have been consumed elsewhere); its spend still counts against the limits. */
  topUpAbandonAfterMs?: number
}): () => Promise<RaffleSettleResult[]> {
  const { state, ports } = params
  const now = params.now ?? Date.now
  const stuckAfterMs = params.stuckAfterMs ?? 10 * MINUTE_MS
  const repriceAfterMs = params.repriceAfterMs ?? 15 * MINUTE_MS
  const maxReprices = params.maxReprices ?? 3
  const topUpAbandonAfterMs = params.topUpAbandonAfterMs ?? 30 * MINUTE_MS
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

  /** Resolves a persisted top-up by hash before anything else may top up again. */
  async function resolveTopUp(
    initial: RaffleDrawRecord,
  ): Promise<{ draw: RaffleDrawRecord; pending: boolean }> {
    const t = initial.pendingTopUp
    if (!t) return { draw: initial, pending: false }
    const clear = async () => {
      const draw = { ...initial, pendingTopUp: undefined }
      await state.putDraw(draw)
      return { draw, pending: false }
    }
    if ((await ports.getTopUpStatus(t.txHash)) !== 'pending') return clear()
    if (
      !(await ports.isTxKnown(t.txHash)) &&
      now() - t.signedAtMs >= topUpAbandonAfterMs
    ) {
      ports.warn(
        `[raffle-bot] round ${initial.raffleId}: abandoning operator top-up ${
          t.txHash
        } (unknown to the node for ${Math.round(
          (now() - t.signedAtMs) / MINUTE_MS,
        )} min); its ${t.amountWei} wei stays counted against the limits.`,
      )
      return clear()
    }
    try {
      await ports.broadcastTopUp(t.rawTx, t.txHash) // same bytes, never a second top-up
    } catch (err) {
      alert(
        `${initial.raffleId}:topup`,
        `[raffle-bot] round ${
          initial.raffleId
        }: re-broadcast of operator top-up ${t.txHash} failed (${errText(
          err,
        )}).`,
      )
    }
    if ((await ports.getTopUpStatus(t.txHash)) !== 'pending') return clear()
    return { draw: initial, pending: true }
  }

  /** Tops up `shortfallWei` from the operator wallet within the per-round and per-day limits.
   * The signed bytes and their hash are persisted BEFORE broadcast. */
  async function fundIdentity(
    initial: RaffleDrawRecord,
    shortfallWei: bigint,
    gasWei: bigint,
  ): Promise<{
    draw: RaffleDrawRecord
    outcome: 'funded' | 'pending' | 'held'
    message?: string
  }> {
    let draw = initial
    const spent = BigInt(draw.topUpWei ?? '0')
    if (spent + shortfallWei > params.maxTopUpPerRoundWei) {
      return {
        draw,
        outcome: 'held',
        message: `top-up of ${shortfallWei} wei would take this round's operator top-ups to ${
          spent + shortfallWei
        }, over the per-round limit ${
          params.maxTopUpPerRoundWei
        } (RAFFLE_BOT_MAX_TOPUP_WEI).`,
      }
    }
    const today = state.topUpTotalSince(now())
    if (today + shortfallWei > params.maxTopUpPerDayWei) {
      return {
        draw,
        outcome: 'held',
        message: `top-up of ${shortfallWei} wei would take today's operator top-ups to ${
          today + shortfallWei
        }, over the per-day limit ${
          params.maxTopUpPerDayWei
        } (RAFFLE_BOT_MAX_TOPUP_PER_DAY_WEI).`,
      }
    }
    if ((await ports.operatorBalanceWei()) < shortfallWei + gasWei) {
      return {
        draw,
        outcome: 'held',
        message: `the operator wallet cannot cover the ${shortfallWei} wei top-up. Fund it; this retries automatically.`,
      }
    }
    let signed: PayoutAttempt
    try {
      signed = await ports.signTopUp(shortfallWei)
    } catch (err) {
      return {
        draw,
        outcome: 'held',
        message: `could not sign the ${shortfallWei} wei operator top-up (${errText(
          err,
        )}).`,
      }
    }
    // Durable BEFORE broadcast: a restart finds this hash and never tops up a second time.
    draw = {
      ...draw,
      topUpWei: (spent + shortfallWei).toString(),
      pendingTopUp: {
        ...signed,
        amountWei: shortfallWei.toString(),
        signedAtMs: now(),
      },
    }
    await state.putDraw(draw)
    await state.recordTopUp(now(), shortfallWei)
    try {
      await ports.broadcastTopUp(signed.rawTx, signed.txHash)
    } catch (err) {
      alert(
        `${draw.raffleId}:topup`,
        `[raffle-bot] round ${draw.raffleId}: broadcast of operator top-up ${
          signed.txHash
        } failed (${errText(err)}); will retry the same signed tx.`,
      )
    }
    const resolved = await resolveTopUp(draw)
    return {
      draw: resolved.draw,
      outcome: resolved.pending ? 'pending' : 'funded',
      message: resolved.pending
        ? `operator top-up ${signed.txHash} is not yet confirmed.`
        : undefined,
    }
  }

  async function advancePayout(initial: RaffleDrawRecord): Promise<{
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

    const topUpState = await resolveTopUp(draw)
    draw = topUpState.draw
    let topUpPending = topUpState.pending

    if (draw.phase === 'awaiting-funds') {
      if (topUpPending) {
        return held(
          `operator top-up ${draw.pendingTopUp?.txHash} is not yet confirmed.`,
        )
      }
      const gas = await ports.payoutGasReserveWei()
      const required = pot + gas
      let balance = await ports.getBalanceWei()
      if (balance < required) {
        const shortfall = required - balance
        const entrants =
          BigInt(draw.drawItem.entrants?.length ?? 0) +
          BigInt(state.getCarriedDustEntrants())
        const dust = await ports.sweepDustWei()
        const plausible =
          ((entrants * dust + gas) * PLAUSIBLE_DUST_MARGIN_NUM) /
          PLAUSIBLE_DUST_MARGIN_DEN
        if (shortfall > plausible) {
          return held(
            `identity holds ${balance} wei, needs ${required} (pot ${pot} + payout gas ${gas}); the ${shortfall} wei gap exceeds the plausible sweep-gas dust for ${entrants} entrants (${plausible}), so an entry probably paid less than the entry price. Investigate; no operator funds moved.`,
          )
        }
        const funded = await fundIdentity(draw, shortfall, gas)
        draw = funded.draw
        progressed = true
        if (funded.outcome !== 'funded') {
          return held(funded.message as string)
        }
        balance = await ports.getBalanceWei()
        if (balance < required) {
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
        payout: { ...signed, signedAtMs: now(), previous: [] },
      }
      await state.putDraw(draw)
      progressed = true
    }

    if (draw.phase === 'signed') {
      const attemptsOf = (d: RaffleDrawRecord) => {
        const p = d.payout as NonNullable<RaffleDrawRecord['payout']>
        return [{ rawTx: p.rawTx, txHash: p.txHash }, ...p.previous]
      }
      const payout = draw.payout as NonNullable<RaffleDrawRecord['payout']>
      const statuses = await Promise.all(
        attemptsOf(draw).map(a => ports.getStatus(a.txHash)),
      )
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
        const sinceLastAttempt =
          now() - (payout.repricedAtMs ?? payout.signedAtMs)
        if (
          sinceLastAttempt >= repriceAfterMs &&
          payout.previous.length < maxReprices &&
          !topUpPending &&
          !(await ports.isTxKnown(payout.txHash))
        ) {
          // Receipt missing AND unknown to the node for a long time: replace it at the SAME nonce
          // with a higher fee that fits the gas actually held. One nonce mines at most once.
          const attempt = async () =>
            ports.repricePayout(
              payout.rawTx,
              (await ports.getBalanceWei()) - pot,
            )
          let bumped = await attempt()
          if (!bumped) {
            const reserve = await ports.payoutGasReserveWei()
            const funded = await fundIdentity(draw, reserve, reserve)
            draw = funded.draw
            progressed = true
            topUpPending = funded.outcome === 'pending'
            if (funded.outcome === 'funded') bumped = await attempt()
            else
              alert(
                `${raffleId}:reprice`,
                `${tag} cannot afford a replacement payout fee: ${funded.message}`,
              )
          }
          if (bumped) {
            draw = {
              ...draw,
              payout: {
                ...bumped,
                signedAtMs: payout.signedAtMs,
                repricedAtMs: now(),
                previous: attemptsOf(draw),
              },
            }
            await state.putDraw(draw)
            progressed = true
            ports.warn(
              `${tag} payout ${
                payout.txHash
              } unknown to the node for ${Math.round(
                sinceLastAttempt / MINUTE_MS,
              )} min; replaced at the same nonce by ${bumped.txHash}.`,
            )
          }
        }
        // Newest first; if it is rejected (underpriced, insufficient funds) fall back to the
        // earlier attempts' bytes. All share one nonce, so at most one can ever mine.
        const attempts = attemptsOf(draw)
        for (const a of attempts) {
          try {
            await ports.broadcast(a.rawTx, a.txHash)
            break
          } catch (err) {
            alert(
              `${raffleId}:${a.txHash}`,
              `${tag} payout ${a.txHash} broadcast failed (${errText(err)}); ${
                a === attempts[attempts.length - 1]
                  ? 'will retry'
                  : 'trying the earlier signed attempt'
              }.`,
            )
          }
        }
        const current = draw.payout as NonNullable<RaffleDrawRecord['payout']>
        const after = await Promise.all(
          attemptsOf(draw).map(a => ports.getStatus(a.txHash)),
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
      // Remember whether this round's sweep-gas deficit was covered by an operator top-up or
      // silently absorbed by other funds (which a later round's shortfall then includes).
      await state.setCarriedDustEntrants(
        BigInt(draw.topUpWei ?? '0') > 0n
          ? 0
          : state.getCarriedDustEntrants() +
              (draw.drawItem.entrants?.length ?? 0),
      )
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

/** The bot's main loop, extracted so its wiring is tested: each iteration runs `raffleTick`
 * (open a draw for a full round, settle, idle decision), then one inbox pass (`pollOnce`), then
 * sleeps. It continues while rounds remain OR any draw is unsettled, and only idle-exits when
 * nothing is unsettled. */
export async function runRaffleLoop(params: {
  state: RaffleBotStateStore
  openDrawIfFull: () => Promise<boolean>
  settle: () => Promise<RaffleSettleResult[]>
  pollOnce: (ctx: {
    markActivity(): void
    drawOpened(): void
    roundsDrawn(): number
  }) => Promise<void>
  sleep: () => Promise<void>
  now: () => number
  idleTimeoutMs: number
  maxRounds: number
  onIdleExit?: () => void
}): Promise<{ roundsDrawn: number }> {
  let roundsDrawn = 0
  let lastActivityAtMs = params.now()
  const ctx = {
    markActivity: () => {
      lastActivityAtMs = params.now()
    },
    drawOpened: () => {
      roundsDrawn++
    },
    roundsDrawn: () => roundsDrawn,
  }
  while (roundsDrawn < params.maxRounds || params.state.getDraws().length > 0) {
    const tick = await raffleTick({
      state: params.state,
      openDrawIfFull: params.openDrawIfFull,
      settle: params.settle,
      nowMs: params.now(),
      lastActivityAtMs,
      idleTimeoutMs: params.idleTimeoutMs,
    })
    if (tick.exit) {
      params.onIdleExit?.()
      break
    }
    lastActivityAtMs = tick.lastActivityAtMs
    roundsDrawn += tick.drawsOpened
    await params.pollOnce(ctx)
    await params.sleep()
  }
  return { roundsDrawn }
}
