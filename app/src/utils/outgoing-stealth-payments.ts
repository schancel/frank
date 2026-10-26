import { reactive } from 'vue'
import { Transaction } from 'ethers'
import { resolveChainIdentifier } from '@frank/wallet/chain/chains-registry'
import {
  summarizeEvmNativeOperation,
  summarizeEvmNativeStampStages,
  type ContactPaymentInfo,
  type EvmNativeOperation,
  type NotedSendStatus,
} from '@frank/wallet/chain'
import {
  groupNotedSends,
  notedSendFeeWei,
  sendFees,
} from 'src/components/wallet/wallet-history'
import type {
  StealthPaymentCapability,
  StealthPaymentStatus,
} from '@frank/wallet/stealth-payment'

/** One payment a sent message carries, as the paying wallet's journal last showed it. */
export interface SentStealthPayment {
  readonly chainIdentifier: string
  readonly operationId: string
  readonly status: StealthPaymentStatus
  /** Sent from another device and nothing here can tell its network fee: the account's notes
   * to itself do not name the operation that paid it (or cannot be read on this wallet). */
  readonly feeUnknowable?: true
}

/** Nothing more will be learnt of it (`stealthPaymentFinal`), or all that can be has been: it
 * landed and its fee cannot be known here. */
function settled(payment: SentStealthPayment): boolean {
  return (
    stealthPaymentFinal(payment.status) ||
    (payment.feeUnknowable === true &&
      payment.status.members.length > 0 &&
      payment.status.members.every(
        member => member.state === 'landed' || member.state === 'failed',
      ))
  )
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
  /** The account's sends as its notes to itself record them, with what the chain showed of
   * each (`NotedSendStatus`): how the network fee of a payment another device sent is read. */
  readonly getNotedSends?: () => Promise<readonly NotedSendStatus[]>
  /** The wallet's own contact payments (Send to Contact), with the journal operation each was
   * paid by: how the network fee of one this device sent is read. */
  readonly getContactPayments?: () => readonly Pick<
    ContactPaymentInfo,
    'ephemeralPubKey' | 'operationId'
  >[]
  /** One journal operation, active or completed. */
  readonly readNativeOperation?: (
    operationId: string,
  ) => Promise<EvmNativeOperation | undefined>
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
  items: readonly {
    type: string
    transfers?: readonly SentTransfer[]
    /** A `stealth` item's signed transfers (Send to Contact). */
    transactions?: readonly string[]
    networkTag?: string
    chainId?: string
    /** A `stealth` item's one-time key: what its contact payment is found by. */
    ephemeralPubKey?: string
  }[]
}

/** The transfers a sent `stealth` item carries, from its signed transactions; undefined when
 * any is only a hash or does not decode (nothing is claimed for it then). */
function stealthItemTransfers(
  item: SentMessage['items'][number],
): SentTransfer[] | undefined {
  const chainIdentifier = resolveChainIdentifier(
    item.networkTag || item.chainId || '',
  )?.id
  if (chainIdentifier === undefined || !item.transactions?.length)
    return undefined
  const transfers: SentTransfer[] = []
  for (const raw of item.transactions) {
    const hex = raw.replace(/^0x/i, '')
    if (/^[0-9a-f]{64}$/i.test(hex)) return undefined
    try {
      const tx = Transaction.from(`0x${hex}`)
      if (!tx.hash || !tx.to) return undefined
      transfers.push({
        chainIdentifier,
        txId: tx.hash,
        destination: tx.to,
        amountAtomic: tx.value.toString(),
        asset: { kind: 'native' },
      })
    } catch {
      return undefined
    }
  }
  return transfers
}

/** The sent payments' items a message carries: `stealth-asset` (a payment in a chat) or
 * `stealth` (Send to Contact). */
const paymentItem = (item: { type: string }) =>
  item.type === 'stealth-asset' || item.type === 'stealth'

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

/**
 * The network fee of a payment another device of the account sent, as the account's notes to
 * itself show it: the fee History shows for the same send (`notedSendFeeWei` of the group of
 * noted sends these transfers are in), every transaction of the operation that paid them and of
 * the message's stamp. Undefined until the chain showed each of them; `unnamed` when no note
 * names the operation that paid them.
 */
function notedFeeOf(
  noted: readonly NotedSendStatus[],
  transfers: readonly SentTransfer[],
): bigint | 'unnamed' | undefined {
  const hashes = new Set(transfers.map(transfer => prefixed(transfer.txId)))
  if (
    !noted.some(
      send => hashes.has(prefixed(send.txHash)) && send.operation !== undefined,
    )
  )
    return 'unnamed'
  const group = [...groupNotedSends(noted).values()].find(sends =>
    sends.some(send => hashes.has(prefixed(send.txHash))),
  )
  if (
    !group ||
    [...hashes].some(
      hash => !group.some(send => prefixed(send.txHash) === hash),
    ) ||
    group.some(send => send.inclusion === undefined)
  )
    return undefined
  return BigInt(notedSendFeeWei(group))
}

/**
 * The network fee of a contact payment this device sent, from its journal operation: the fee
 * History shows for the same send (`sendFees`), every transaction of the operation, its
 * message's stamp stage included. Undefined until every one of them is final; `unnamed` when
 * this wallet holds no such payment.
 */
async function journalFeeOf(
  owner: StealthPaymentOwner,
  ephemeralPubKey: string | undefined,
): Promise<bigint | 'unnamed' | undefined> {
  if (
    !ephemeralPubKey ||
    !owner.getContactPayments ||
    !owner.readNativeOperation
  )
    return 'unnamed'
  const operationId = owner
    .getContactPayments()
    .find(
      payment =>
        payment.ephemeralPubKey.toLowerCase() === ephemeralPubKey.toLowerCase(),
    )?.operationId
  if (operationId === undefined) return 'unnamed'
  const row = await owner.readNativeOperation(operationId)
  if (row === undefined) return undefined
  const operation = summarizeEvmNativeOperation(row)
  if (
    !operation.members.every(
      member => member.feeWei !== undefined || member.state === 'superseded',
    )
  )
    return undefined
  return BigInt(sendFees(operation, summarizeEvmNativeStampStages(row)).feeWei)
}

/**
 * Nothing more can happen to it, and nothing more will be learnt: every transfer landed or can
 * never land and its network fee is known, or it was cancelled. A payment whose transfers landed
 * before its change did is read again until the fee is known, so the card does not say "not
 * known yet" for good.
 */
export function stealthPaymentFinal(status: StealthPaymentStatus): boolean {
  return (
    status.released === true ||
    (status.members.length > 0 &&
      status.members.every(
        member => member.state === 'landed' || member.state === 'failed',
      ) &&
      (status.nativeFeeAtomic !== undefined ||
        status.members.every(member => member.state === 'failed')))
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
  // The one-time key of a message's `stealth` item (Send to Contact).
  const contactKeyOf = new Map<string, string>()
  for (const message of messages) {
    if (!message.outbound) continue
    if (!message.items.some(paymentItem)) continue
    const digest = sentMessageDigest(message).toLowerCase()
    if (digest.startsWith('pending:')) continue
    const known = outgoingStealthPayments.get(digest)
    if (known?.length && known.every(settled)) continue
    wanted.add(digest)
    const items = message.items.filter(paymentItem)
    const transfers =
      items.length !== 1
        ? undefined
        : items[0]!.type === 'stealth'
        ? stealthItemTransfers(items[0]!)
        : items[0]!.transfers
    if (transfers?.length) transfersOf.set(digest, transfers)
    if (items.length === 1 && items[0]!.type === 'stealth')
      contactKeyOf.set(digest, items[0]!.ephemeralPubKey ?? '')
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
  // The account's notes, read once per refresh for each wallet asked.
  const notedOf = new Map<
    StealthPaymentOwner,
    Promise<readonly NotedSendStatus[]>
  >()
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
      let status = await chainStatusOf(owner.evmReader!, transfers)
      let feeUnknowable = true
      // A contact payment this device sent: its journal operation names the fee.
      const journalFee = status
        ? await journalFeeOf(owner, contactKeyOf.get(digest))
        : 'unnamed'
      if (status && journalFee !== 'unnamed') {
        feeUnknowable = false
        if (journalFee !== undefined)
          status = { ...status, nativeFeeAtomic: journalFee }
      } else if (status && owner.getNotedSends) {
        let noted = notedOf.get(owner)
        if (noted === undefined) {
          noted = owner.getNotedSends().catch(() => [])
          notedOf.set(owner, noted)
        }
        const fee = notedFeeOf(await noted, transfers)
        feeUnknowable = fee === 'unnamed'
        if (typeof fee === 'bigint')
          status = { ...status, nativeFeeAtomic: fee }
      }
      if (status)
        found.set(digest, [
          {
            chainIdentifier: owner.chainIdentifier,
            operationId: `chain:${digest}`,
            status,
            ...(feeUnknowable ? { feeUnknowable: true as const } : {}),
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
    if (!payments.every(settled)) open++
  }
  return open
}
