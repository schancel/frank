/**
 * Operator refund of entrant money that reached the raffle identity but was not credited to a round
 * (#363): an entry over the payment cap, or one that swept less than the price. Each record is
 * refunded AT MOST ONCE: the signed bytes are persisted (fsynced) before the first broadcast, every
 * retry re-broadcasts the same bytes, and completion is reconciled by hash.
 *
 * The refund pays from the same identity account as raffle payouts (shared nonce and balance, the
 * design problem tracked in #218), so it is refused while any draw is unsettled, and the CLI
 * (`yarn raffle:refund`) must be run with the raffle bot stopped (it owns the state database).
 */
import { RaffleBotStateStore, RaffleUnclaimedRecord } from './raffle-bot-state'

export interface RaffleRefundPorts {
  getBalanceWei(): Promise<bigint>
  signTransfer(
    to: string,
    valueWei: bigint,
  ): Promise<{ rawTx: string; txHash: string }>
  broadcast(rawTx: string, txHash: string): Promise<void>
  getStatus(txHash: string): Promise<'pending' | 'confirmed' | 'failed'>
}

export type RefundOutcome =
  | { status: 'refunded'; txHash: string }
  | { status: 'already-refunded'; txHash: string }
  | { status: 'pending'; txHash: string }
  | { status: 'refused'; reason: string }

export async function refundUnclaimed(params: {
  state: RaffleBotStateStore
  ports: RaffleRefundPorts
  id: string
  now?: () => number
}): Promise<RefundOutcome> {
  const { state, ports } = params
  const now = params.now ?? Date.now
  let rec: RaffleUnclaimedRecord | undefined = state
    .getUnclaimed()
    .find(r => r.id === params.id)
  if (!rec)
    return { status: 'refused', reason: `no unclaimed record ${params.id}` }
  if (rec.refundedTxHash) {
    return { status: 'already-refunded', txHash: rec.refundedTxHash }
  }
  if (state.getDraws().length > 0) {
    return {
      status: 'refused',
      reason:
        'a raffle draw is unsettled; the refund shares its account and nonce, so finish or fund it first',
    }
  }
  if (!rec.refund) {
    const amount = BigInt(rec.sweptWei)
    if ((await ports.getBalanceWei()) < amount) {
      return {
        status: 'refused',
        reason: `the raffle identity holds less than the ${amount} wei to refund`,
      }
    }
    const signed = await ports.signTransfer(rec.entrant, amount)
    // Durable BEFORE the first broadcast: a crash resumes with these exact bytes.
    rec = { ...rec, refund: { ...signed, signedAtMs: now() } }
    await state.putUnclaimed(rec)
  }
  const refund = rec.refund as NonNullable<RaffleUnclaimedRecord['refund']>
  let status = await ports.getStatus(refund.txHash)
  if (status === 'failed') {
    // Mined and reverted: nothing moved, so a fresh refund can be signed on the next run.
    await state.putUnclaimed({ ...rec, refund: undefined })
    return {
      status: 'refused',
      reason: `refund ${refund.txHash} reverted; run again to re-sign`,
    }
  }
  if (status === 'pending') {
    try {
      await ports.broadcast(refund.rawTx, refund.txHash)
    } catch {
      // e.g. already known: reconcile by hash below
    }
    status = await ports.getStatus(refund.txHash)
  }
  if (status !== 'confirmed')
    return { status: 'pending', txHash: refund.txHash }
  await state.putUnclaimed({ ...rec, refundedTxHash: refund.txHash })
  return { status: 'refunded', txHash: refund.txHash }
}
