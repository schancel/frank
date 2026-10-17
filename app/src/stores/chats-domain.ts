import { shallowRef } from 'vue'
import { randomBytes } from '@noble/hashes/utils'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import {
  isChainAddress,
  safeChainDisplayAddress,
  toChainDisplayAddress,
} from '../utils/chain-address'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import { messageItems } from '../utils/message-items'
import type { Utxo } from '@frank/cashweb/types/utxo'
import type {
  Message,
  MessageWrapper,
  MessageItem,
  OutgoingDelivery,
  OutgoingFinancialOperation,
  OutgoingFailureReason,
  ConversationStateItem,
} from '@frank/cashweb/types/messages'
import {
  joinDeliveryStatus,
  toDeliveryStatus,
} from '@frank/wallet/journal/semilattice-state'
import type { RelayReceiptIdentity } from '@frank/cashweb/relay/storage/storage'
import {
  allocateOpeningConversationId,
  formatConversationId,
  isOpeningConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { useSettingsStore } from './settings'
import { sameCanonicalAddress } from '../utils/own-address'

export type ChatMessage = {
  sealedMessageId?: string
  applicationAuthorization?: Message['applicationAuthorization']
  financialOperations?: OutgoingFinancialOperation[]
  outbound: boolean
  status: string
  receivedTime: number
  serverTime: number
  items: MessageItem[]
  outpoints: Utxo[]
  /** See this file's header decision note: additive Monad-side value field, alongside
   * `outpoints` rather than replacing it (ticket #42). */
  stampValueWei?: bigint
  stampPayments?: Array<{
    txHash: string
    destinationAddress: string
    valueWei: bigint
  }>
  senderAddress: string
  destinationAddress?: string
  payloadDigest: string
  messageHash?: string
  /** Outgoing messages that are not yet confirmed (#269/#270); see `Message.delivery`. */
  delivery?: OutgoingDelivery
  /** Ticket #69: Conversation and logical message identifiers */
  conversationId?: string
  logicalMessageId?: string
  /** Authenticated original canonical content frame, when the producer supplied its digest. */
  contentDigest?: string
  revisionDigest?: string
  deliveryDigest?: string
  /** `serverTime` is this device's clock: the message was written here and its row has not
   * been read back from the relay, which is what gives it the time every device sees. */
  localTime?: boolean
}

/** Conversation metadata is owned by conversations[id]; messages are owned by the message store.
 * Peer lookup, message membership/accounting and logical revision indexes are derived views.
 * Stable 16-byte conversation IDs cross the authenticated wire unchanged. Subjects are presentation.
 */
export type ConversationKind = 'direct' | 'group' | 'email'
export type ConversationRole = 'owner' | 'admin' | 'member'

export interface ConversationMember {
  address: string
  role?: ConversationRole
  joinedAt?: number
  alias?: string
  /** Hex of the key this member's first message here was verified against. It gives someone
   * who is not a contact the same colour a contact gets from their key. */
  pubKeyHex?: string
}

export interface ConversationEpoch {
  epochId?: string
  generation?: number
  updatedAt?: number
}

export interface DeliveryRecord {
  deliveryDigest: string
  recipientAddress?: string
  status: string
  attemptDigest?: string
  timestamp: number
}

export interface RevisionRecord {
  revisionDigest: string
  items: MessageItem[]
  timestamp: number
  deliveries: DeliveryRecord[]
}

export interface LogicalMessageRecord {
  messageId: string
  conversationId: string
  senderAddress: string
  createdAt: number
  activeRevisionDigest: string
  revisions: RevisionRecord[]
}

export interface Conversation {
  id: string
  kind: ConversationKind
  name?: string
  /** The subject last carried by a message in this conversation, sent by this account or by the
   * peer. A message carries the subject only when it differs from this: the first message of a
   * conversation that has a subject, and a message after a rename. */
  nameOnWire?: string
  /** Relay time of the message whose subject this conversation currently has, when a message
   * set it. A carried subject replaces the current one only if its message is not older. */
  nameSetAt?: number
  topic?: string
  emailRecipient?: string
  participants: string[]
  members?: Record<string, ConversationMember>
  epoch?: ConversationEpoch
  messages: ChatMessage[]
  totalUnreadMessages: number
  totalUnreadValue: number
  totalValue: number
  lastReceived: number
  lastRead: number
  /** The stamp this user chose for this conversation, in the chain's base units, as a decimal
   * string so it is saved with the conversation. Unset: the chain's configured default. */
  stampWei?: string
  address: string
  createdAt?: number
  updatedAt?: number
  deletedAt?: number
  /** Messages no newer than this are gone for good: the latest time the conversation was
   * deleted at. It outlives the conversation being opened again, so that old messages do not
   * come back with it. */
  clearedBefore?: number
  /** Highest relay time removed on this device by Clear or message deletion. Kept with
   * conversation metadata so a later conversation Delete can cover that history after reload.
   * This is a UI deletion boundary only; coin recovery remains owned by mailbox tombstones. */
  removedRelayTime?: number
  /** What the account's own mailbox is known to say about this conversation: the facts this
   * device has noted to the account's other devices, or read from a note of theirs. A fact
   * beyond these is noted by the next pass of `noteConversationStates`. */
  noted?: { clearedBefore?: number; readUpTo?: number }
  /** The user set or removed the subject here (`name`, at `nameSetAt`) and the account's
   * mailbox does not say so yet. Cleared once the note is sent, or a later subject replaces
   * this one. */
  subjectToNote?: boolean
  /** The account whose user last deleted, named or created this conversation on this device
   * (`accountTag`). Only that account notes the deletion and the subject: the store can still
   * hold conversations of an account that was replaced here. */
  actedBy?: string
  verifiedGateway?: boolean
  screenerStatus?: 'pending' | 'approved' | 'dismissed'
}

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

export function messageStampPrice(message: {
  outpoints: Utxo[]
  stampValueWei?: bigint
}) {
  if (message.stampValueWei !== undefined) {
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
 * relay handing the row back does not bring the message back.
 */
export function tombstoneMailbox(message: Message): string | undefined {
  return message.outbound
    ? message.senderAddress
    : messageDestinationAddress(message)
}

/**
 * The relay time a tombstone may anchor the mailbox's read position at: only a time the relay
 * itself gave.
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
 * the stealth items stay (amount, memo) with no transaction in them.
 */
export function stripReleasedPayments(message: ChatMessage): void {
  message.items = message.items.map(item =>
    item.type === 'stealth' ? { ...item, transactions: [] } : item,
  )
}

export function accountedMessageValue(message: {
  status: string
  items: MessageItem[]
  outpoints: Utxo[]
  stampValueWei?: bigint
}): number {
  if (message.status !== 'confirmed') return 0
  return messageStampPrice(message) + messageItems.tallyValue(message.items)
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

export interface SetActiveConversationOptions {
  requestFocus?: boolean
}

export interface State {
  activeConversationId: string | null
  conversations: Record<string, Conversation>
  messages: Record<string, ChatMessage | undefined>
  logicalMessages: Record<string, LogicalMessageRecord | undefined>
  lastReceived: number | null
  composeFocusRequest: ComposeFocusRequest | null
}

export function freshChatsState(): State {
  return {
    conversations: {},
    messages: {},
    logicalMessages: {},
    lastReceived: null,
    activeConversationId: null,
    composeFocusRequest: null,
  }
}

let pendingMessageSequence = 0

/** Local key of an outgoing message until its payload hash is known. Persisted (#269), so it must
 * stay unique across reloads, where the in-memory sequence restarts. */
export function nextPendingMessageId(timestamp: number): string {
  pendingMessageSequence += 1
  const nonce = Math.random().toString(36).slice(2, 8)
  return `pending:${timestamp}:${pendingMessageSequence}:${nonce}`
}

/**
 * The ID an outgoing message is sent under: fixed by the message's local key, which is saved
 * with its row before the send starts and survives a reload.
 */
export function outgoingMessageId(localKey: string): string {
  return uuidv5(NULL_CONVERSATION_NAMESPACE, `frank-outgoing:${localKey}`)
}

export function matchesOutgoingOwner(
  row: MessageWrapper,
  message: Message,
  address: string,
): boolean {
  return (
    sameCanonicalAddress(row.senderAddress, message.senderAddress) &&
    sameCanonicalAddress(row.copartyAddress, address) &&
    (!row.message.conversationId ||
      !message.conversationId ||
      row.message.conversationId === message.conversationId) &&
    (!row.message.logicalMessageId ||
      !message.logicalMessageId ||
      row.message.logicalMessageId === message.logicalMessageId)
  )
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

/**
 * A private mark of the active account, the same on each of its devices and unknown to anyone
 * else: what a conversation is tagged with when the account's user acts on it. `undefined`
 * while no account is active.
 */
export function accountTag(): string | undefined {
  const salt = conversationIdSalt.value
  return salt
    ? formatConversationId(
        allocateOpeningConversationId(salt, 'frank:conversation-notes'),
      )
    : undefined
}

/** While a conversation is open, its read mark is noted at most this often. It is noted at
 * once when the conversation is closed. */
export const READ_NOTE_INTERVAL_MS = 10_000
/** When this session last noted a read mark for each conversation. */
export const readNotedAt = new Map<string, number>()

/** The time up to which a conversation's messages are gone, if it was ever deleted. */
export function clearedUpTo(conversation: Conversation): number | undefined {
  const cleared = Math.max(
    conversation.clearedBefore ?? -Infinity,
    conversation.deletedAt ?? -Infinity,
  )
  return Number.isFinite(cleared) ? cleared : undefined
}

/**
 * What this device still has to note to the account's other devices about a conversation: the
 * facts it holds beyond what the account's mailbox is known to say. `undefined` when there is
 * nothing to say, and for a conversation with no peer address (a group): only conversations
 * with one peer are noted.
 */
export function conversationStateToNote(
  conversation: Conversation,
  ownAddress: string,
  activeConversationId: string | null,
): ConversationStateItem | undefined {
  if (!isChainAddress(conversation.address)) return undefined
  const note: ConversationStateItem = {
    type: 'conversation-state',
    conversationId: conversation.id,
    peer: conversation.address,
  }
  // A deletion and a subject are noted by the account whose user made them.
  const ours =
    conversation.actedBy !== undefined && conversation.actedBy === accountTag()
  const cleared = clearedUpTo(conversation)
  if (
    ours &&
    cleared !== undefined &&
    cleared > (conversation.noted?.clearedBefore ?? -1)
  )
    note.clearedBefore = Math.trunc(cleared)
  // A read mark moves with every message that arrives in an open conversation: there it is
  // noted once per interval, and when the conversation is closed.
  const read = readUpTo(conversation, ownAddress)
  if (
    read > (conversation.noted?.readUpTo ?? 0) &&
    (conversation.id !== activeConversationId ||
      Date.now() - (readNotedAt.get(conversation.id) ?? -Infinity) >=
        READ_NOTE_INTERVAL_MS)
  )
    note.readUpTo = read
  if (ours && conversation.subjectToNote && conversation.kind === 'direct') {
    note.subject = usableSubject(conversation.name) ?? ''
    note.subjectSetAt = conversation.nameSetAt ?? 0
  }
  return note.clearedBefore === undefined &&
    note.readUpTo === undefined &&
    note.subject === undefined
    ? undefined
    : note
}

export function readUpTo(
  conversation: Conversation,
  ownAddress: string,
): number {
  let read = 0
  for (const message of conversation.messages)
    if (
      !isOwnMessage(message) &&
      !!message.destinationAddress &&
      sameCanonicalAddress(message.destinationAddress, ownAddress) &&
      message.serverTime <= conversation.lastRead &&
      message.serverTime > read
    )
      read = message.serverTime
  return read
}

/** A note's facts are now in the account's mailbox (this device sent it, or read it there). */
export function recordNoted(
  conversation: Conversation,
  note: ConversationStateItem,
): void {
  const noted = { ...conversation.noted }
  if (note.clearedBefore !== undefined)
    noted.clearedBefore = Math.max(
      noted.clearedBefore ?? -1,
      note.clearedBefore,
    )
  if (note.readUpTo !== undefined)
    noted.readUpTo = Math.max(noted.readUpTo ?? 0, note.readUpTo)
  conversation.noted = noted
  if (
    note.subject !== undefined &&
    note.subjectSetAt === (conversation.nameSetAt ?? 0) &&
    note.subject === (usableSubject(conversation.name) ?? '')
  )
    conversation.subjectToNote = undefined
}

/** The ID of the note stating exactly these facts: the same on every device, so two devices
 * noting the same thing write the same message. */
export function conversationNoteId(note: ConversationStateItem): Uint8Array {
  return uuidv5Bytes(
    new Uint8Array(16),
    `frank-conversation-state:${note.conversationId}:${
      note.clearedBefore ?? ''
    }:${note.readUpTo ?? ''}:${note.subjectSetAt ?? ''}:${note.subject ?? ''}`,
  )
}

export type DeliveryLease = { isCancelled: () => boolean }

export type ReceivedDeliveryResult = {
  suppressedReceipts: RelayReceiptIdentity[]
  cancelled: boolean
}

export type OutgoingOutcome =
  | { state: 'sent'; payloadDigest: string }
  | { state: 'payment-pending' }
  | { state: 'failed'; reason: OutgoingFailureReason }
  | { state: 'needs-confirmation'; reason: OutgoingFailureReason }
  | { state: 'busy' }

export type OutboundDeliveryMatch = {
  oldIndex: string
  chatAddress: string
  conversationId: string
  message: Message & { destinationAddress?: string; localTime?: boolean }
}

const tombstonedTargetsByConversations = new WeakMap<
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
    if (
      !isOwnMessage(message) &&
      chat.id !== activeConversationId &&
      chat.lastRead < message.serverTime
    ) {
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

export type RestorableState = {
  activeConversationId?: string | null
  conversations?: Record<string, Conversation | undefined>
  messages?: Record<string, Message | undefined>
  logicalMessages?: Record<string, LogicalMessageRecord | undefined>
  lastReceived: number | null
}

export function earliestMessage(
  conversation: Conversation,
): ChatMessage | undefined {
  let first: ChatMessage | undefined
  for (const message of conversation.messages) {
    if (message.outbound && message.status !== 'confirmed') continue
    if (!first) first = message
    else if (message.serverTime > first.serverTime) break
    else if (byRelayTime(message, first) < 0) first = message
  }
  return first
}

export function peerThread(
  conversations: Record<string, Conversation | undefined>,
  peer: string,
): Conversation | undefined {
  let thread: Conversation | undefined
  let threadStart: ChatMessage | undefined
  for (const conversation of Object.values(conversations)) {
    if (
      !conversation ||
      conversation.kind === 'group' ||
      conversation.kind === 'email' ||
      !isOpeningConversationId(conversation.id) ||
      !sameCanonicalAddress(conversation.address, peer)
    )
      continue
    const start = earliestMessage(conversation)
    if (
      !start ||
      !(
        start.outbound ||
        sameCanonicalAddress(start.senderAddress, conversation.address)
      )
    )
      continue
    if (!threadStart || byRelayTime(start, threadStart) < 0) {
      thread = conversation
      threadStart = start
    }
  }
  if (thread || !conversationIdSalt.value) return thread
  const opened = conversations[allocateOpeningConversationIdFor(peer)]
  return opened && sameCanonicalAddress(opened.address, peer)
    ? opened
    : undefined
}

export function peerThreadId(
  conversations: Record<string, Conversation | undefined>,
  peer: string,
): string {
  return (
    peerThread(conversations, peer)?.id ??
    allocateOpeningConversationIdFor(peer)
  )
}

export function defaultChats(
  conversations: Record<string, Conversation>,
): Readonly<Record<string, Conversation | undefined>> {
  const peers = new Set(
    Object.values(conversations)
      .filter(c => c.kind !== 'group' && c.address)
      .map(c => c.address),
  )
  return Object.fromEntries(
    [...peers]
      .map(peer => [peer, peerThread(conversations, peer)] as const)
      .filter(([, thread]) => thread !== undefined),
  )
}

export function usableSubject(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const subject = value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '').trim()
  if (
    subject.length === 0 ||
    new TextEncoder().encode(subject).length > 512 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(subject)
  )
    return undefined
  return subject
}

export function applyCarriedSubject(
  conversation: Conversation,
  message: {
    outbound: boolean
    senderAddress: string
    serverTime: number
    items?: MessageItem[]
    conversationName?: string
  },
): void {
  const subject = usableSubject(message.conversationName)
  if (
    subject === undefined ||
    conversation.kind === 'email' ||
    conversation.kind === 'group' ||
    message.items?.some(item => item.type === 'email') ||
    !(
      message.outbound ||
      sameCanonicalAddress(message.senderAddress, conversation.address)
    ) ||
    !subjectReplaces(conversation, subject, message.serverTime)
  )
    return
  setSubject(conversation, subject, message.serverTime)
  conversation.nameOnWire = subject
}

export function subjectReplaces(
  conversation: Conversation,
  subject: string | undefined,
  setAt: number,
): boolean {
  const current = conversation.nameSetAt ?? 0
  if (setAt !== current) return setAt > current
  return (subject ?? '') >= (usableSubject(conversation.name) ?? '')
}

export function setSubject(
  conversation: Conversation,
  subject: string | undefined,
  setAt: number,
): void {
  if (conversation.name !== subject) {
    conversation.updatedAt = Date.now()
    conversation.subjectToNote = undefined
  }
  conversation.name = subject
  conversation.nameSetAt = setAt
}

export function subjectToCarry(
  conversation: Conversation | undefined,
): string | undefined {
  if (!conversation || conversation.kind === 'email') return undefined
  const subject = usableSubject(conversation.name)
  return subject === conversation.nameOnWire ? undefined : subject
}

export function canonicalConversationId(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex))
    throw new Error('Conversation identity must contain exactly 16 bytes')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const conversationIdSalt = shallowRef<Uint8Array | null>(null)

export function hasConversationIdSalt(): boolean {
  return conversationIdSalt.value !== null
}

export function setConversationIdSalt(salt?: Uint8Array | null): void {
  conversationIdSalt.value = salt ? Uint8Array.from(salt) : null
}

export const replacedConversations = new Map<string, string>()

export function resolveConversation(
  conversations: Record<string, Conversation | undefined>,
  id: string,
): Conversation | undefined {
  if (Object.prototype.hasOwnProperty.call(conversations, id))
    return conversations[id]
  const replacement = replacedConversations.get(id)
  return replacement === undefined
    ? undefined
    : resolveConversation(conversations, replacement)
}

export function allocateOpeningConversationIdFor(peer: string): string {
  const salt = conversationIdSalt.value
  if (!salt)
    throw new Error(
      'No conversation-ID salt is installed: a chat can be opened only once the account is active',
    )
  return formatConversationId(
    allocateOpeningConversationId(salt, peer.toLowerCase()),
  )
}

export function openAllocatedConversation(
  conversations: Record<string, Conversation>,
  peer: string,
  participants: string[],
): Conversation {
  const id = allocateOpeningConversationIdFor(peer)
  const allocated = conversations[id]
  if (allocated) {
    assertConversationPeer(allocated, peer)
    return allocated
  }
  const conversation = newConversation({ id, address: peer, participants })
  conversations[id] = conversation
  return conversation
}

export function freshConversationId(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  return canonicalConversationId(
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
  )
}

export function assertConversationPeer(
  conversation: Conversation,
  address: string,
): void {
  const explicitMember =
    conversation.address === conversation.id &&
    conversation.participants.some(p => sameCanonicalAddress(p, address))
  const groupMember =
    conversation.kind === 'group' &&
    conversation.participants.some(p => sameCanonicalAddress(p, address))
  if (
    !explicitMember &&
    !groupMember &&
    conversation.address !== address &&
    !sameCanonicalAddress(conversation.address, address)
  ) {
    throw new Error(
      `Conversation ${conversation.id} belongs to a different recipient`,
    )
  }
}

export function addParticipant(
  conversation: Conversation,
  address: string,
  pubKeyHex?: string,
): void {
  const member = safeChainDisplayAddress(address) || address
  if (conversation.participants.some(p => sameCanonicalAddress(p, member)))
    return
  conversation.participants = [...conversation.participants, member].sort()
  conversation.members = {
    ...conversation.members,
    [member]: {
      address: member,
      role: 'member',
      joinedAt: Date.now(),
      pubKeyHex,
    },
  }
}

export function newConversation({
  id,
  participants,
  address,
  ...metadata
}: Partial<Conversation> & {
  id: string
  participants: string[]
  address: string
}): Conversation {
  const normalized = Array.from(
    new Set(participants.map(p => safeChainDisplayAddress(p) || p)),
  ).sort()
  return {
    ...defaultContactObject,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...metadata,
    id: canonicalConversationId(id),
    address: safeChainDisplayAddress(address) || address,
    participants: normalized,
    members:
      metadata.members ??
      Object.fromEntries(
        normalized.map(p => [p, { address: p, role: 'member' as const }]),
      ),
    messages: [],
  }
}

export function openDefaultConversation(
  conversations: Record<string, Conversation>,
  address: string,
  participants: string[],
): Conversation {
  const peer = toChainDisplayAddress(address)
  const members = Array.from(
    new Set(participants.map(toChainDisplayAddress)),
  ).sort()
  if (members.length > 2 || !members.includes(peer)) {
    throw new Error(
      'Default direct conversation requires the explicit recipient and at most one other participant',
    )
  }
  const existing = peerThread(conversations, peer)
  if (existing) {
    if (
      members.length === 2 &&
      existing.participants.length === 2 &&
      makeParticipantsKey(existing.participants) !==
        makeParticipantsKey(members)
    ) {
      throw new Error(`Conversation ${existing.id} has different participants`)
    }
    if (existing.participants.length === 1 && members.length === 2) {
      existing.participants = members
      existing.members = Object.fromEntries(
        members.map(member => [
          member,
          existing.members?.[member] ?? {
            address: member,
            role: 'member' as const,
          },
        ]),
      )
    }
    reopenConversation(existing)
    return existing
  }
  const opened = openAllocatedConversation(conversations, peer, participants)
  reopenConversation(opened)
  return opened
}

export function isInternalMessage(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      item =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item.type === 'swap-record' ||
          item.type === 'wallet-sync' ||
          item.type === 'received-coin' ||
          item.type === 'conversation-state' ||
          item.type === 'message-tombstone' ||
          item.type === 'journal-checkpoint' ||
          item.type === 'outbox-message' ||
          item.type === 'payment-transfer'),
    )
  )
}
