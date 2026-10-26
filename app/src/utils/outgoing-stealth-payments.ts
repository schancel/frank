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
  /** Read-only node access on that chain: how a payment this device's journal does not hold
   * (one another device of the account sent) is checked. */
  readonly evmReader?: {
    getTransactionReceipt(hash: string): Promise<{
      readonly to?: string | null
      readonly status: number | null
    } | null>
  }
}

interface SentTransfer {
  readonly chainIdentifier: string
  readonly txId: string
  readonly destination: string
  readonly amountAtomic: string
  readonly asset: { readonly kind: string }
}

interface SentMessage {
  outbound: boolean
  payloadDigest: string
  delivery?: { attemptDigest?: string }
  items: readonly { type: string; transfers?: readonly SentTransfer[] }[]
}

/** Most transfers one refresh looks up on the chain for payments sent from another device. */
const CHAIN_LOOKUPS_PER_REFRESH = 32

const prefixed = (hash: string) =>
  /^0x/i.test(hash) ? hash.toLowerCase() : '0x' + hash.toLowerCase()

/**
 * A payment another device of the account sent: this device's journal has no record of it, but
 * the message carries each transfer's hash, recipient and amount. Its state is what the chain
 * shows by those hashes: a receipt of success to the stated recipient is landed, a reverted one
 * failed; a transfer without a receipt is pending. Undefined when the chain shows none of them
 * yet, or a receipt does not match the transfer: nothing is claimed, and it is asked again.
 */
async function chainStatusOf(
  reader: NonNullable<StealthPaymentOwner['evmReader']>,
  transfers: readonly SentTransfer[],
): Promise<StealthPaymentStatus | undefined> {
  const members: StealthPaymentStatus['members'][number][] = []
  let any = false
  for (const transfer of transfers) {
    const txHash = prefixed(transfer.txId)
    const receipt = await reader.getTransactionReceipt(txHash)
    if (receipt) {
      if (
        prefixed(receipt.to ?? '') !== prefixed(transfer.destination) ||
        (receipt.status !== 0 && receipt.status !== 1)
      )
        return undefined
      any = true
    }
    members.push({
      txHash,
      recipientAmountAtomic: BigInt(transfer.amountAtomic),
      ...(receipt === null
        ? { state: 'pending' as const }
        : receipt.status === 1
        ? { state: 'landed' as const }
        : { state: 'failed' as const, failure: 'reverted' as const }),
    })
  }
  if (!any) return undefined
  const landed = members.filter(member => member.state === 'landed')
  return {
    status:
      landed.length === members.length
        ? 'succeeded'
        : landed.length > 0
        ? 'partial'
        : members.every(member => member.state === 'failed')
        ? 'failed'
        : 'pending',
    intendedAmountAtomic: members.reduce(
      (sum, member) => sum + member.recipientAmountAtomic,
      0n,
    ),
    ...(landed.length
      ? {
          verifiedReceivedAmountAtomic: landed.reduce(
            (sum, member) => sum + member.recipientAmountAtomic,
            0n,
          ),
        }
      : {}),
    submitted: true,
    members,
  }
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
  const transfersOf = new Map<string, readonly SentTransfer[]>()
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
    const items = message.items.filter(item => item.type === 'stealth-asset')
    if (items.length === 1 && items[0]!.transfers?.length)
      transfersOf.set(digest, items[0]!.transfers!)
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
  // No journal here holds it: another device of the account sent it (or it is not bound yet).
  // The chain answers for its transfers, read by their hashes on the chain they were sent on.
  let lookups = 0
  for (const digest of wanted) {
    if (found.has(digest)) continue
    const transfers = transfersOf.get(digest)
    const first = transfers?.[0]
    if (
      !transfers ||
      !first ||
      lookups + transfers.length > CHAIN_LOOKUPS_PER_REFRESH ||
      transfers.some(
        transfer =>
          transfer.chainIdentifier !== first.chainIdentifier ||
          transfer.asset.kind !== 'native' ||
          !/^(0x)?[0-9a-fA-F]{64}$/.test(transfer.txId) ||
          !/^(0x)?[0-9a-fA-F]{40}$/.test(transfer.destination) ||
          !/^[1-9][0-9]*$/.test(transfer.amountAtomic),
      )
    )
      continue
    const owner = owners.find(
      candidate =>
        candidate.chainIdentifier === first.chainIdentifier &&
        candidate.evmReader !== undefined,
    )
    if (!owner) continue
    lookups += transfers.length
    try {
      const status = await chainStatusOf(owner.evmReader!, transfers)
      if (status)
        found.set(digest, [
          {
            chainIdentifier: owner.chainIdentifier,
            operationId: `chain:${digest}`,
            status,
          },
        ])
    } catch (error) {
      console.warn('Sent stealth payment status unavailable', error)
    }
  }
  let open = 0
  for (const digest of wanted) {
    const payments = found.get(digest)
    if (payments === undefined) continue
    outgoingStealthPayments.set(digest, payments)
    if (!payments.every(payment => stealthPaymentFinal(payment.status))) open++
  }
  return open
}
