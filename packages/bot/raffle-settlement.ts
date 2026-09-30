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
 *     shortfall (bounded by `maxTopUpWei`) is covered from the operator wallet; if that cannot be
 *     done the draw is HELD (`awaiting-funds`), never thrown, never announced, retried each tick.
 *  3. Sign the payout once and persist the exact bytes (`signed`) BEFORE the first broadcast.
 *  4. Broadcast (and re-broadcast on every retry) THE SAME BYTES: same nonce, same hash, so a
 *     retry can never pay twice. Reconcile by hash: `confirmed` -> `paid`. A tx that mined and
 *     reverted is final, so only then is the intent re-signed.
 *  5. Only when `paid`: announce (reveal the seed) to each entrant, recording each send.
 *
 * Insufficient funds deliberately do NOT refund entrants here: a refund shares the identity's
 * nonce and balance with the payout, which is exactly the design problem tracked in #218. The
 * round is held with a loud, deduplicated owner-facing message and pays as soon as the operator
 * wallet is funded; other rounds keep filling meanwhile. No refund is ever sent, so none can be
 * sent twice.
 */
import { RaffleItem } from '@frank/cashweb/types/messages'
import { buildRaffleDrawItem, sha256Hex } from '@frank/wallet/message-item-plugins/raffle/draw'

import {
  RaffleDrawRecord,
  RaffleBotStateStore,
  RaffleRoundRecord,
} from './raffle-bot-state'

/** Bot defaults, shared with the launcher's docs/tests so they cannot drift (#363). The launcher
 * keeps the default price and overrides only the round size (3) so a demo round fills quickly. */
export const RAFFLE_DEFAULT_ENTRY_PRICE_WEI = '20000000000000000' // 0.02 MON
export const RAFFLE_DEFAULT_MAX_ENTRIES = 5
export const RAFFLE_DEFAULT_MAX_TOPUP_WEI = '50000000000000000' // 0.05 MON

export interface RaffleSettlementPorts {
  /** The bot identity's current on-chain balance. */
  getBalanceWei(): Promise<bigint>
  /** Worst-case gas the payout transfer itself costs (paid from the identity). */
  payoutGasReserveWei(): Promise<bigint>
  /** Operator wallet -> identity transfer of `shortfallWei`, confirmed. Throws if it cannot. */
  topUpIdentity(shortfallWei: bigint): Promise<void>
  signPayout(
    to: string,
    valueWei: bigint,
  ): Promise<{ rawTx: string; txHash: string }>
  /** Broadcast exactly these bytes (idempotent by hash). */
  broadcast(rawTx: string, txHash: string): Promise<void>
  getStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
  /** Send the draw item to one entrant. Throw to have it retried; return normally when sent or
   * when the entrant is permanently unreachable. */
  announce(entrantAddress: string, draw: RaffleItem): Promise<void>
  log(message: string): void
  warn(message: string): void
}

export type DrawSettleStatus =
  | 'held'
  | 'pending'
  | 'announce-incomplete'
  | 'done'

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
    },
    nextRound,
    nextCommitment: { serverSeed: nextSeed, serverSeedHash: nextHash },
  })
  params.log?.(
    `[raffle-bot] round ${round.raffleId} is full: draw recorded (winner ${drawItem.winnerAddress}, pot ${drawItem.potWei} wei); settling before any announcement. Next round ${nextRound.raffleId}.`,
  )
  return true
}

/** Settles recorded draws oldest first, one step machine per draw. Never throws for a port
 * failure: it logs and leaves the record at its last durable phase for the next tick. Stops at the
 * first draw that is not finished so the identity's payouts stay strictly sequential. */
export function createRaffleSettler(params: {
  state: RaffleBotStateStore
  ports: RaffleSettlementPorts
  /** Largest operator top-up accepted to cover swept-entry gas + payout gas. A bigger shortfall
   * means something other than sweep dust is wrong, so the draw is held instead. */
  maxTopUpWei: bigint
}): () => Promise<Array<{ raffleId: string; status: DrawSettleStatus }>> {
  const { state, ports } = params
  const lastMessage = new Map<string, string>()
  const alert = (raffleId: string, message: string) => {
    if (lastMessage.get(raffleId) === message) return
    lastMessage.set(raffleId, message)
    ports.warn(message)
  }

  async function settleOne(
    initial: RaffleDrawRecord,
  ): Promise<DrawSettleStatus> {
    let draw = initial
    const { raffleId } = draw
    const pot = BigInt(draw.drawItem.potWei)
    const tag = `[raffle-bot] round ${raffleId}`

    if (draw.phase === 'awaiting-funds') {
      const gas = await ports.payoutGasReserveWei()
      const required = pot + gas
      let balance = await ports.getBalanceWei()
      if (balance < required) {
        const shortfall = required - balance
        if (shortfall > params.maxTopUpWei) {
          alert(
            raffleId,
            `${tag} HELD: identity holds ${balance} wei, needs ${required} (pot ${pot} + payout gas ${gas}); shortfall ${shortfall} exceeds the ${params.maxTopUpWei} wei operator top-up limit. Winner NOT announced or paid. Fund the raffle identity; it retries automatically.`,
          )
          return 'held'
        }
        try {
          await ports.topUpIdentity(shortfall)
        } catch (err) {
          alert(
            raffleId,
            `${tag} HELD: could not top up the raffle identity by ${shortfall} wei from the operator wallet (${err instanceof Error ? err.message : String(err)}). Winner NOT announced or paid; retrying.`,
          )
          return 'held'
        }
        balance = await ports.getBalanceWei()
        if (balance < required) {
          alert(
            raffleId,
            `${tag} HELD: identity balance ${balance} wei is still below the required ${required} after top-up (funding not yet visible). Retrying.`,
          )
          return 'held'
        }
      }
      // Sign ONCE and persist the exact bytes before the first broadcast.
      const payout = await ports.signPayout(draw.drawItem.winnerAddress, pot)
      draw = { ...draw, phase: 'signed', payout }
      await state.putDraw(draw)
    }

    if (draw.phase === 'signed') {
      const payout = draw.payout as { rawTx: string; txHash: string }
      let status = await ports.getStatus(payout.txHash)
      if (status === 'pending') {
        // Same bytes every time; an "already known"/duplicate answer is not an error.
        try {
          await ports.broadcast(payout.rawTx, payout.txHash)
        } catch (err) {
          alert(
            raffleId,
            `${tag} payout ${payout.txHash} broadcast failed (${err instanceof Error ? err.message : String(err)}); will retry the same signed tx.`,
          )
        }
        status = await ports.getStatus(payout.txHash)
      }
      if (status === 'failed') {
        // Mined and reverted: final, so a new intent cannot double pay.
        alert(raffleId, `${tag} payout ${payout.txHash} reverted on-chain; re-signing.`)
        await state.putDraw({ ...draw, phase: 'awaiting-funds', payout: undefined })
        return 'pending'
      }
      if (status === 'pending') {
        alert(raffleId, `${tag} payout ${payout.txHash} not yet confirmed; winner not announced yet.`)
        return 'pending'
      }
      draw = { ...draw, phase: 'paid' }
      await state.putDraw(draw)
      ports.log(`${tag} payout ${payout.txHash} confirmed`)
    }

    // phase === 'paid': the pot is safely with the winner, so the seed may now be revealed.
    for (const entrant of draw.drawItem.entrants ?? []) {
      if (draw.announcedTo.includes(entrant)) continue
      try {
        await ports.announce(entrant, draw.drawItem)
      } catch (err) {
        alert(
          raffleId,
          `${tag} announcing to ${entrant} failed (${err instanceof Error ? err.message : String(err)}); will retry.`,
        )
        return 'announce-incomplete'
      }
      draw = { ...draw, announcedTo: [...draw.announcedTo, entrant] }
      await state.putDraw(draw)
    }
    await state.removeDraw(raffleId)
    lastMessage.delete(raffleId)
    ports.log(`${tag} settled: paid and announced`)
    return 'done'
  }

  return async () => {
    const results: Array<{ raffleId: string; status: DrawSettleStatus }> = []
    for (const draw of state.getDraws()) {
      let status: DrawSettleStatus
      try {
        status = await settleOne(draw)
      } catch (err) {
        // Includes a crash-style failure of a durable write: the record is at its last durable
        // phase, so the next tick (or restart) resumes correctly.
        alert(
          draw.raffleId,
          `[raffle-bot] round ${draw.raffleId} settlement error (${err instanceof Error ? err.message : String(err)}); will retry.`,
        )
        status = 'held'
      }
      results.push({ raffleId: draw.raffleId, status })
      if (status !== 'done') break
    }
    return results
  }
}
