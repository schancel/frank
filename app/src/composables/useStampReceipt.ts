import { onBeforeUnmount, ref, type Ref } from 'vue'
import { useMonadWallet } from '../utils/clients'
import { RECEIVED_PAYMENT_RECHECK_MS } from './useReceivedPayment'

/**
 * Whether the stamp a received message carried has landed on chain, as the messaging wallet
 * saw it: one evidence for every place that shows that money. The message footer uses it to
 * stop calling an amount "claimed", and a game card uses it to call a payout verified.
 *
 * Received stamps still waiting to settle, across every mounted reader. One wallet read per
 * tick serves them all: `refreshReceivedPayments` is the wallet's own pass, which keeps its
 * backoff for coins long overdue, instead of a chain check per message. Each waiter then reads
 * its message from memory and says whether it is done.
 */
const stampWaiters = new Set<() => boolean>()
/** How long a reader keeps reading a stamp the wallet holds no coin for yet. */
export const STAMP_NONE_PATIENCE_MS = 5 * 60_000
let stampTick: ReturnType<typeof setTimeout> | undefined
function scheduleStampTick(): void {
  if (stampTick !== undefined || stampWaiters.size === 0) return
  stampTick = setTimeout(() => {
    void (async () => {
      try {
        // Every reader that waited may have gone meanwhile: then nothing is read.
        if (stampWaiters.size > 0)
          await useMonadWallet().refreshReceivedPayments?.()
      } catch {
        // No wallet or node now: read again on the next tick.
      }
      stampTick = undefined
      for (const waiter of Array.from(stampWaiters))
        if (waiter()) stampWaiters.delete(waiter)
      scheduleStampTick()
    })()
  }, RECEIVED_PAYMENT_RECHECK_MS)
  ;(stampTick as { unref?: () => void }).unref?.()
}

/** The message whose stamp is read: its digest, what it says it carried, and its direction. */
export interface StampedMessage {
  payloadDigest?: string
  stampValueWei?: bigint
  outbound?: boolean
}

/** What the wallet saw of a received message's stamp. `received`: on chain, `receivedWei` of
 * it at this wallet's account. */
export interface StampReceipt {
  status: 'none' | 'pending' | 'received' | 'not-received' | 'failed'
  receivedWei: bigint
}

/**
 * The stamp receipt of `message()` (undefined while the wallet has none for it, or for a message
 * that is outbound or carried no stamp). Read from memory now, then on the shared tick until it
 * has settled. `none` (no coin for the message) is also what the wallet answers before it has
 * recorded the message's coin, or right after a reload before it has read its coins again. Taken
 * as final, a payout already on chain stayed "claimed" until it was drawn again; so it is read
 * again for a while before it is believed.
 */
export function useStampReceipt(
  message: () => StampedMessage | undefined,
): Ref<StampReceipt | undefined> {
  const receipt = ref<StampReceipt | undefined>()
  const noneUntilMs = Date.now() + STAMP_NONE_PATIENCE_MS
  const read = (): boolean => {
    const target = message()
    if (
      !target ||
      target.outbound ||
      !target.payloadDigest ||
      !((target.stampValueWei ?? 0n) > 0n)
    )
      return true
    let payment:
      | { stampStatus: StampReceipt['status']; stampReceivedWei?: bigint }
      | undefined
    try {
      payment = useMonadWallet().getMessagePayment?.(target.payloadDigest)
    } catch {
      // No wallet now: the stamp stays claimed and is read again.
    }
    receipt.value = payment
      ? {
          status: payment.stampStatus,
          receivedWei: payment.stampReceivedWei ?? 0n,
        }
      : undefined
    const status = payment?.stampStatus
    // Settled, never landing, or (after a while) no coin for it in this wallet: nothing more
    // to wait for.
    return (
      status === 'received' ||
      status === 'failed' ||
      (status === 'none' && Date.now() >= noneUntilMs)
    )
  }
  if (!read()) {
    stampWaiters.add(read)
    scheduleStampTick()
  }
  onBeforeUnmount(() => stampWaiters.delete(read))
  return receipt
}
