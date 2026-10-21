import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import {
  isChainAddress,
  safeChainDisplayAddress,
  toChainDisplayAddress,
} from '../utils/chain-address'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import type {
  Message,
  OutgoingDelivery,
  OutgoingFailureReason,
} from '@frank/cashweb/types/messages'
import {
  joinDeliveryStatus,
  toDeliveryStatus,
} from '@frank/wallet/journal/semilattice-state'
import {
  formatConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { useSettingsStore } from './settings'
import { sameCanonicalAddress } from '../utils/own-address'
import type {
  ChatMessage,
  ChatState,
  Conversation,
  ConversationEpoch,
  ConversationMember,
  DeliveryRecord,
  LogicalMessageRecord,
} from './chats'

export type ChatState = Conversation

export function getTrustedEmailGatewayAddress(): string {
  try {
    const settings = useSettingsStore()
    return settings.emailGatewayAddress
  } catch {
    return ''
  }
}

export function makeParticipantsKey(participants: string[]): string {
  const normalized = Array.from(
    new Set(
      participants.filter(Boolean).map(p => {
        try {
          return toChainDisplayAddress(p)
        } catch {
          return p
        }
      }),
    ),
  ).sort()
  return normalized.join(':')
}

export const NULL_CONVERSATION_NAMESPACE =
  '00000000-0000-0000-0000-000000000000'

/** A UUIDv5 as text. The one implementation is shared with the sending layer
 * (`@frank/cashweb/relay/conversation-id`). */
export function uuidv5(namespaceUuid: string, name: string): string {
  const hex = namespaceUuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex))
    throw new Error('UUID namespace must contain exactly 16 bytes')
  const namespace = new Uint8Array(16)
  for (let i = 0; i < 16; i++)
    namespace[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return formatConversationId(uuidv5Bytes(namespace, name))
}

/** A message ID is chosen by its sender, so two different messages can arrive with the same
 * one (a buggy client, or someone reusing another person's ID). The first keeps the ID. A later,
 * different message is filed under an ID derived from the one it named and its own payload hash:
 * the same on every device and every re-read of the mailbox. Replies that name the shared ID
 * resolve to the first holder. */
export function collidedMessageId(
  messageId: string,
  payloadDigest: string,
): string {
  return uuidv5(NULL_CONVERSATION_NAMESPACE, `${messageId}:${payloadDigest}`)
}

/**
 * The ID a message is filed under: the one it named, unless a different message already holds
 * it, in which case the derived one, and so on while the derived ID is itself held. The same
 * routine decides on receive and on reload, and always returns an ID nothing else holds.
 */
export function freeMessageId(
  named: string,
  payloadDigest: string,
  heldByAnother: (id: string) => boolean,
): string {
  let id = named
  for (let round = 0; round < 8 && heldByAnother(id); round++)
    id = collidedMessageId(id, payloadDigest)
  if (!heldByAnother(id)) return id
  // No sender's own ID has this shape. Each try can be held only by a distinct existing
  // message, so this ends.
  for (let n = 0; ; n++) {
    const fallback = `collided:${payloadDigest}:${n}`
    if (!heldByAnother(fallback)) return fallback
  }
}

/** Whether a holder of a message ID is a different message from one in this conversation by
 * this sender. (The same sender using the ID again in the same conversation is a revision.) */
export function isAnotherMessage(
  holder: { conversationId: string; senderAddress: string } | undefined,
  conversationId: string,
  senderAddress: string,
): boolean {
  return (
    holder !== undefined &&
    (holder.conversationId !== conversationId ||
      !sameCanonicalAddress(holder.senderAddress, senderAddress))
  )
}

/**
 * What a message means for a conversation the user has deleted, now or earlier. Deleting means
 * its old messages do not come back: a message no newer than a deletion is gone, whoever sent
 * it and even after the conversation was opened again. While the conversation is deleted,
 * anything from someone other than us or its peer is gone too, and a newer message from us or
 * the peer reopens it. The same rule decides on receive (before anything is saved) and on
 * reload.
 */
export function inDeletedConversation(
  conversation: Conversation,
  message: Pick<
    ChatMessage,
    'outbound' | 'senderAddress' | 'serverTime' | 'status' | 'localTime'
  >,
  reopenedAlready = false,
): 'live' | 'reopens' | 'gone' {
  const deletedAt = reopenedAlready ? undefined : conversation.deletedAt
  const clearedBefore = Math.max(
    conversation.clearedBefore ?? -Infinity,
    conversation.deletedAt ?? -Infinity,
  )
  if (!isUntimedOutgoing(message) && message.serverTime <= clearedBefore)
    return 'gone'
  if (deletedAt === undefined) return 'live'
  return speaksForConversation(conversation, message) ? 'reopens' : 'gone'
}

/** Brings a deleted conversation back, without the messages it was deleted with. */
export function reopenConversation(conversation: Conversation): void {
  if (conversation.deletedAt === undefined) return
  conversation.clearedBefore = Math.max(
    conversation.clearedBefore ?? -Infinity,
    conversation.deletedAt,
  )
  conversation.deletedAt = undefined
}

/** Relay time, then payload hash: one order for a conversation's messages, however they came. */
export function byRelayTime(
  a: { serverTime?: number; receivedTime?: number; payloadDigest: string },
  b: { serverTime?: number; receivedTime?: number; payloadDigest: string },
): number {
  const aPending =
    typeof a.payloadDigest === 'string' &&
    a.payloadDigest.startsWith('pending:')
  const bPending =
    typeof b.payloadDigest === 'string' &&
    b.payloadDigest.startsWith('pending:')
  if (aPending !== bPending) return aPending ? 1 : -1
  return (
    (a.serverTime ?? a.receivedTime ?? 0) -
      (b.serverTime ?? b.receivedTime ?? 0) ||
    (a.payloadDigest < b.payloadDigest
      ? -1
      : a.payloadDigest > b.payloadDigest
      ? 1
      : 0)
  )
}

/** Our own messages, including a note to self that arrives as an inbound row (it is addressed
 * to its own sender). They never count as unread. */
export function isOwnMessage(message: {
  outbound: boolean
  senderAddress: string
  destinationAddress?: string
}): boolean {
  return (
    message.outbound ||
    (!!message.destinationAddress &&
      sameCanonicalAddress(message.senderAddress, message.destinationAddress))
  )
}

/** Whether a message may change the conversation itself (its kind, subject, gateway status, or
 * bring it back after deletion) and not merely be added to it: only what we sent and what the
 * conversation's own peer sent. Anyone else's message is stored and shown, nothing more. */
export function speaksForConversation(
  conversation: Conversation,
  message: { outbound: boolean; senderAddress: string },
): boolean {
  return (
    message.outbound ||
    !isChainAddress(conversation.address) ||
    sameCanonicalAddress(message.senderAddress, conversation.address)
  )
}

export function recordLogicalMessage(
  logicalMessages: Record<string, LogicalMessageRecord | undefined>,
  message: ChatMessage,
  conversationId: string,
): void {
  const logicalId = message.logicalMessageId || message.payloadDigest
  const revisionDigest = message.revisionDigest || message.payloadDigest
  const deliveryDigest = message.deliveryDigest || message.payloadDigest
  const msgTime = message.serverTime ?? message.receivedTime ?? 0
  const deliveryTime = message.receivedTime ?? message.serverTime ?? 0

  let record = logicalMessages[logicalId]
  if (record && record.conversationId !== conversationId) {
    throw new Error(
      `Logical message ${logicalId} already belongs to another conversation`,
    )
  }
  if (!record) {
    record = {
      messageId: logicalId,
      conversationId,
      senderAddress: message.senderAddress,
      createdAt: msgTime,
      activeRevisionDigest: revisionDigest,
      revisions: [],
    }
    logicalMessages[logicalId] = record
  } else {
    record.createdAt =
      record.createdAt > 0 && msgTime > 0
        ? Math.min(record.createdAt, msgTime)
        : Math.max(record.createdAt, msgTime)
  }

  let rev = record.revisions.find(r => r.revisionDigest === revisionDigest)
  if (!rev) {
    rev = {
      revisionDigest,
      items: message.items,
      timestamp: msgTime,
      deliveries: [],
    }
    record.revisions.push(rev)
  } else {
    rev.timestamp =
      rev.timestamp > 0 && msgTime > 0
        ? Math.min(rev.timestamp, msgTime)
        : Math.max(rev.timestamp, msgTime)
  }
  record.revisions.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      (a.revisionDigest < b.revisionDigest
        ? -1
        : a.revisionDigest > b.revisionDigest
        ? 1
        : 0),
  )
  if (record.revisions.length > 0) {
    record.activeRevisionDigest =
      record.revisions[record.revisions.length - 1].revisionDigest
  }

  const existingDelivery = rev.deliveries.find(
    d => d.deliveryDigest === deliveryDigest,
  )
  if (!existingDelivery) {
    rev.deliveries.push({
      deliveryDigest,
      recipientAddress: message.destinationAddress,
      status: message.status,
      attemptDigest: message.delivery?.attemptDigest,
      timestamp: deliveryTime,
    })
  } else {
    existingDelivery.status = joinDeliveryStatus(
      toDeliveryStatus(existingDelivery.status),
      toDeliveryStatus(message.status),
    )
    if (message.delivery?.attemptDigest) {
      existingDelivery.attemptDigest = message.delivery.attemptDigest
    }
    if (message.destinationAddress && !existingDelivery.recipientAddress) {
      existingDelivery.recipientAddress = message.destinationAddress
    }
    existingDelivery.timestamp =
      existingDelivery.timestamp > 0 && deliveryTime > 0
        ? Math.min(existingDelivery.timestamp, deliveryTime)
        : Math.max(existingDelivery.timestamp, deliveryTime)
  }
  rev.deliveries.sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      (a.deliveryDigest < b.deliveryDigest
        ? -1
        : a.deliveryDigest > b.deliveryDigest
        ? 1
        : 0),
  )
}

/**
 * ## Decision (#42): `stampValueWei` added alongside `outpoints`, not in place of it
 *
 * `ChatMessage`/`Message`/`ReceivedMessage`'s `outpoints: Utxo[]` (used by `stampPrice` below, for
 * unread-badge sort value) has no Monad equivalent -- Monad's stamp payment is represented as an aggregate scalar
 * (`DirectMessageSendResult.stampValueWei`/`DirectMessageReceived.stampValueWei`,
 * `@frank/wallet/chain/active-chain.ts`), never UTXOs. Chosen: add `stampValueWei?: bigint` as a new,
 * optional field alongside `outpoints` (which stays required, defaulted to `[]` for Monad-sourced
 * messages) rather than replacing `outpoints` outright. Why: `outpoints` is still read outside this
 * file's scope (`components/chat/messages/ChatMessage.vue`'s own `stampPrice(this.message.outpoints)`
 * call, for its stamp-price display) -- replacing the field would force touching that component
 * (and the Lotus-still-wired `pinia-relay-adapter.ts`/leveldb `MessageWrapper` persistence path)
 * as part of this ticket, well outside its stated file scope (`stores/chats.ts`/`contacts.ts`).
 * Leaving `outpoints` alone and adding `stampValueWei` additively is strictly less invasive and
 * keeps both chains' messages structurally valid at every existing call site; `ChatMessage.vue`'s
 * stamp-price display simply continues to show 0 for Monad-received messages until ticket #44
 * (PLAN.md's own scope for "remaining hardcoded XPI/Lotus-address UI spots") updates it.
 *
 * `messageStampPrice` below is the narrow adapter needed on this file's own two `stampPrice(...)`
 * call sites so Monad messages sort/badge correctly using their real payment value instead of always
 * reading as 0 (`stampPrice([])` for a message with no `outpoints`).
 */
export function messageStampPrice(message: {
  outpoints: Utxo[]
  stampValueWei?: bigint
}) {
  if (message.stampValueWei !== undefined) {
    // Wei -> plain number for sort/badge purposes only, matching Lotus's own pre-existing
    // sort-value use of `stampPrice` (satoshis as a plain number). Default stamp values
    // (CASHWEB_STAMP_MIN_BURN_VALUE_WEI, e.g. 1e12) are far below Number.MAX_SAFE_INTEGER
    // (~9e15), so this is lossless in practice; a pathologically large payment would only ever
    // affect display sort order, never a financial computation.
    return Number(message.stampValueWei)
  }
  return stampPrice(message.outpoints)
}

/** Relay receipts carry the recipient identity at runtime, but legacy/local Message rows predate it. */
export function messageDestinationAddress(
  message: Message,
): string | undefined {
  return (message as Message & { destinationAddress?: string })
    .destinationAddress
}

/** A confirmed local outbox row is not proof that its relay receipt was observed. */
export function observedRelayReceiptTime(
  message: Message | undefined,
): number | undefined {
  return message?.status === 'confirmed' && messageDestinationAddress(message)
    ? message.receivedTime
    : undefined
}

/**
 * Deleting a message leaves a TOMBSTONE: its content (text, items, attachments) is dropped from
 * this device's store and from the screen, and its payload hash stays recorded as deleted, so the
 * relay handing the row back does not bring the message back. Nothing else is kept, and nothing
 * else is needed: money a message brought is the wallet's coin from the moment the message was
 * read (key and all, with its derivation noted to self), so a delete never asks the wallet
 * anything, never moves money and never waits for a chain.
 *
 * The tombstone is kept under the mailbox the row is read from, which is always this account's
 * own: a received message was sent to us, and the relay keeps our own sent messages in our
 * mailbox too. Undefined when the message names neither.
 */
export function tombstoneMailbox(message: Message): string | undefined {
  return message.outbound
    ? message.senderAddress
    : messageDestinationAddress(message)
}

/**
 * The relay time a tombstone may anchor the mailbox's read position at: only a time the relay
 * itself gave. A message we sent to someone else carries this device's own clock until its row
 * is read back, so its tombstone has no time; the relay's row gives it one when it arrives.
 */
export function tombstoneReceiptTime(
  message: Message | undefined,
): number | undefined {
  if (
    message?.outbound &&
    !sameCanonicalAddress(
      message.senderAddress,
      messageDestinationAddress(message) ?? '',
    )
  )
    return undefined
  return observedRelayReceiptTime(message)
}

/**
 * A message whose payment the wallet released keeps the bubble and loses the signed transfer:
 * the stealth items stay (amount, memo) with no transaction in them. Such an item cannot be
 * encoded, so the message can never be sent again, by a retry or otherwise; the only copies of a
 * released transfer are then ones that never existed outside this device.
 */
export function stripReleasedPayments(message: ChatMessage): void {
  message.items = message.items.map(item =>
    item.type === 'stealth' ? { ...item, transactions: [] } : item,
  )
}

/**
 * What a confirmed message counts for in a conversation's stored `totalValue` /
 * `totalUnreadValue`: its stamp, whose destination and amount the relay verified, in the
 * messaging chain's base unit. Never an amount a message item states: a stealth item's amount
 * is the sender's claim, and money it brought is counted only once the wallet saw it arrive
 * (`receivedMessageAmounts`).
 */
export function accountedMessageValue(message: {
  status: string
  outpoints: Utxo[]
  stampValueWei?: bigint
}): number {
  if (message.status !== 'confirmed') return 0
  return messageStampPrice(message)
}

/** An amount in one canonical chain's native base unit (wei, lamports, satoshis). */
export interface ChainAmount {
  readonly chainIdentifier: string
  readonly baseUnits: bigint
}

/** What the account's wallets saw arrive on chain for a message (its payloadDigest), beyond its
 * stamp: one entry per wallet, on that wallet's canonical chain. Never what the message states. */
export type VerifiedMessageReceipts = (
  payloadDigest: string,
) => readonly ChainAmount[]

/** A native amount's AVU value; undefined when the chain's coin has no price. */
export type AmountInAvu = (
  chainIdentifier: string,
  baseUnits: bigint,
) => number | undefined

/** A received message that is still unread in its conversation. */
export function isUnreadReceived(
  chat: Pick<ChatState, 'id' | 'lastRead'>,
  message: ChatMessage,
  activeConversationId: string | null,
): boolean {
  return (
    !isOwnMessage(message) &&
    chat.id !== activeConversationId &&
    chat.lastRead < message.serverTime
  )
}

/**
 * What a received message brought, per canonical chain: its relay-verified stamp on the
 * messaging chain, plus what the wallets verified as received for it, matched by payloadDigest
 * on each wallet's chain. A payment the message only claims adds nothing.
 */
export function receivedMessageAmounts(
  message: ChatMessage,
  stampChainIdentifier: string,
  verifiedReceipts: VerifiedMessageReceipts,
): ChainAmount[] {
  if (message.status !== 'confirmed' || isOwnMessage(message)) return []
  const amounts: ChainAmount[] = []
  if (message.stampValueWei !== undefined && message.stampValueWei > 0n)
    amounts.push({
      chainIdentifier: stampChainIdentifier,
      baseUnits: message.stampValueWei,
    })
  if (message.payloadDigest)
    for (const receipt of verifiedReceipts(message.payloadDigest))
      if (receipt.baseUnits > 0n) amounts.push(receipt)
  return amounts
}

/**
 * The sum of amounts on any chains, in AVU: each chain's amount is converted at its own price
 * before adding, never raw units summed across chains. Undefined when any of them has no price:
 * a total that silently left part out would be a made-up number.
 */
export function amountsInAvu(
  amounts: readonly ChainAmount[],
  toAvu: AmountInAvu,
): number | undefined {
  let total = 0
  for (const amount of amounts) {
    if (amount.baseUnits <= 0n) continue
    const avu = toAvu(amount.chainIdentifier, amount.baseUnits)
    if (avu === undefined || !Number.isFinite(avu)) return undefined
    total += avu
  }
  return total
}

/** What a conversation's unread received messages brought, in AVU (see `amountsInAvu`). */
export function unreadValueAvu(
  chat: Pick<ChatState, 'id' | 'lastRead' | 'messages'>,
  activeConversationId: string | null,
  value: {
    stampChainIdentifier: string
    verifiedReceipts: VerifiedMessageReceipts
    toAvu: AmountInAvu
  },
): number | undefined {
  const amounts = (chat.messages ?? []).flatMap(message =>
    isUnreadReceived(chat, message, activeConversationId)
      ? receivedMessageAmounts(
          message,
          value.stampChainIdentifier,
          value.verifiedReceipts,
        )
      : [],
  )
  return amountsInAvu(amounts, value.toAvu)
}

export const defaultContactObject = {
  kind: 'direct' as const,
  totalUnreadMessages: 0,
  totalUnreadValue: 0,
  totalValue: 0,
  lastReceived: 0,
  lastRead: 0,
}

export interface ComposeFocusRequest {
  conversationId: string | null
  nonce: number
}

/** A message of ours the relay has not timed yet: its time is this device's clock, which no
 * other device sees. No deletion time is taken from it, and a deletion noted from elsewhere
 * never covers it. */
export function isUntimedOutgoing(
  message: Pick<ChatMessage, 'outbound' | 'status' | 'localTime'>,
): boolean {
  return (
    message.outbound &&
    (message.status !== 'confirmed' || message.localTime === true)
  )
}

/** The newest relay time in these messages; zero when the relay has timed none of them. */
export function newestRelayTime(messages: readonly ChatMessage[]): number {
  let newest = 0
  for (const message of messages)
    if (!isUntimedOutgoing(message) && message.serverTime > newest)
      newest = message.serverTime
  return newest
}

/** The time up to which a conversation's messages are gone, if it was ever deleted. */
export function clearedUpTo(conversation: Conversation): number | undefined {
  const cleared = Math.max(
    conversation.clearedBefore ?? -Infinity,
    conversation.deletedAt ?? -Infinity,
  )
  return Number.isFinite(cleared) ? cleared : undefined
}

export type OutboundDeliveryMatch = {
  oldIndex: string
  chatAddress: string
  conversationId: string
  message: Message & { destinationAddress?: string; localTime?: boolean }
}

export const tombstonedTargetsByConversations = new WeakMap<
  Record<string, Conversation>,
  Set<string>
>()

export function tombstonedTargetsFor(
  conversations: Record<string, Conversation>,
): Set<string> {
  let set = tombstonedTargetsByConversations.get(conversations)
  if (!set) {
    set = new Set<string>()
    tombstonedTargetsByConversations.set(conversations, set)
  }
  return set
}

export type OutboundDeliveryOwner = {
  chatAddress: string
  conversationId: string
  index: string
  message: Message
}

export function indexOutboundDeliveryOwners(
  chats: Record<
    string,
    { messages: Array<ChatMessage | Message>; address?: string } | undefined
  >,
): {
  byPayload: Map<string, OutboundDeliveryOwner>
  byAttempt: Map<string, OutboundDeliveryOwner>
} {
  const byPayload = new Map<string, OutboundDeliveryOwner>()
  const byAttempt = new Map<string, OutboundDeliveryOwner>()
  for (const [key, chat] of Object.entries(chats)) {
    if (!chat) continue
    const chatAddress = 'address' in chat && chat.address ? chat.address : key
    for (const message of chat?.messages ?? []) {
      if (!message.outbound) continue
      const index =
        'payloadDigest' in message ? message.payloadDigest : undefined
      if (!index) continue
      const owner = {
        chatAddress,
        conversationId: message.conversationId || key,
        index,
        message,
      }
      byPayload.set(index, owner)
      const attempt = message.delivery?.attemptDigest
      if (attempt !== undefined) byAttempt.set(attempt, owner)
    }
  }
  return { byPayload, byAttempt }
}

export function recomputeChatAccounting(
  chat: ChatState,
  activeConversationId: string | null,
): void {
  chat.totalValue = 0
  chat.totalUnreadMessages = 0
  chat.totalUnreadValue = 0
  for (const message of chat.messages) {
    const value = accountedMessageValue(message)
    chat.totalValue += value
    if (isUnreadReceived(chat, message, activeConversationId)) {
      chat.totalUnreadMessages += 1
      chat.totalUnreadValue += value
    }
  }
}

export function walletOwnsMessage(
  wallet: WalletHandle,
  message: { senderAddress: string },
): boolean {
  return sameCanonicalAddress(
    activeChain.formatAddress(wallet.identity.address),
    message.senderAddress,
  )
}
