import { reactive } from 'vue'
import type {
  StealthPaymentCapability,
  StealthPaymentStatus,
} from '@frank/wallet/stealth-payment'

/** One payment a sent message carries, as the paying wallet's journal last showed it. */
export interface SentStealthPayment {
  readonly chainIdentifier: string
  readonly operationId: string
  readonly status: StealthPaymentStatus
}

/**
 * What the paying wallet's journal shows of the stealth payments each sent message carries, by
 * the message's payload digest (the digest the payment was bound to before the message left).
 * A view refreshed by the outgoing tick; nothing here is saved and nothing decides anything from
 * it. After a reload the first tick reads it again from the journal.
 */
export const outgoingStealthPayments = reactive(
  new Map<string, SentStealthPayment[]>(),
)

/** A wallet that pays stealth payments on one chain. */
export interface StealthPaymentOwner {
  readonly chainIdentifier: string
  readonly stealthPayments?: Pick<StealthPaymentCapability, 'list' | 'status'>
}

interface SentMessage {
  outbound: boolean
  payloadDigest: string
  delivery?: { attemptDigest?: string }
  items: readonly { type: string }[]
}

/** Nothing more can happen to it: every transfer landed or can never land, or it was cancelled. */
export function stealthPaymentFinal(status: StealthPaymentStatus): boolean {
  return (
    status.released === true ||
    (status.members.length > 0 &&
      status.members.every(
        member => member.state === 'landed' || member.state === 'failed',
      ))
  )
}

/** The digest a sent message's payment is bound to. */
export function sentMessageDigest(message: {
  payloadDigest: string
  delivery?: { attemptDigest?: string }
}): string {
  return message.delivery?.attemptDigest ?? message.payloadDigest
}

/**
 * Reads, from each owner's journal, the payments of every sent message carrying a
 * `stealth-asset` item that is not final yet. Returns how many found are not final. Never throws:
 * an owner that cannot answer changes nothing and is asked again on the next tick.
 */
export async function refreshOutgoingStealthPayments(
  owners: readonly StealthPaymentOwner[],
  messages: Iterable<SentMessage>,
): Promise<number> {
  const wanted = new Set<string>()
  for (const message of messages) {
    if (!message.outbound) continue
    if (!message.items.some(item => item.type === 'stealth-asset')) continue
    const digest = sentMessageDigest(message).toLowerCase()
    if (digest.startsWith('pending:')) continue
    const known = outgoingStealthPayments.get(digest)
    if (
      known?.length &&
      known.every(payment => stealthPaymentFinal(payment.status))
    )
      continue
    wanted.add(digest)
  }
  if (wanted.size === 0) return 0
  const found = new Map<string, SentStealthPayment[]>()
  const seen = new Set<object>()
  for (const owner of owners) {
    const payments = owner.stealthPayments
    if (!payments?.status || seen.has(owner)) continue
    seen.add(owner)
    try {
      for (const operation of await payments.list()) {
        const digest = operation.payloadDigest?.toLowerCase()
        if (digest === undefined || !wanted.has(digest)) continue
        const status = await payments.status(operation.operationId)
        if (status === undefined) continue
        const list = found.get(digest) ?? []
        list.push({
          chainIdentifier: owner.chainIdentifier,
          operationId: operation.operationId,
          status,
        })
        found.set(digest, list)
      }
    } catch (error) {
      console.warn('Sent stealth payment status unavailable', error)
    }
  }
  let open = 0
  for (const digest of wanted) {
    // No owner here holds it (another device's payment, or not bound yet): nothing to follow.
    const payments = found.get(digest)
    if (payments === undefined) continue
    outgoingStealthPayments.set(digest, payments)
    if (!payments.every(payment => stealthPaymentFinal(payment.status))) open++
  }
  return open
}
