import assert from 'assert'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import { defaultEmailGatewayAddress, displayNetwork } from '../utils/constants'
import { randomBytes } from '@noble/hashes/utils'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { picturePreview, picturePreviewText } from '../utils/chat-attachments'
import { desktopNotify } from '../utils/notifications'
import { store } from '../adapters/level-message-store'
import {
  isChainAddress,
  safeChainDisplayAddress,
  toChainDisplayAddress,
} from '../utils/chain-address'
import { acquireOutgoingLock, withOutgoingLock } from '../utils/outgoing-lock'
import {
  cancelWaitingSend,
  cancellableSend,
  endWaitingSend,
  sendsWaitingForChain,
  sendsWaitingForPreviousPayment,
} from '../utils/outgoing-waiting'
import { activeChain } from '@frank/wallet/chain'
import { sendsWaitingBlocks } from '../utils/outgoing-payments'
import { messageItems } from '../utils/message-items'

import {
  CanonicalRecipientNotPublishedError,
  ContactPaymentReleasedError,
  DirectMessageAlreadyAttemptedError,
  DirectMessageStampBelowFeeError,
  type DirectMessageAttemptStatus,
  type DirectMessagePreparationProgress,
  type DirectMessageSendResult,
  type WalletHandle,
} from '@frank/wallet/chain'
import { Utxo } from '@frank/cashweb/types/utxo'
import {
  MonadStampAbandonedError,
  MonadStampPendingAttemptError,
  MonadStampRecoveredAttemptError,
  MonadStampRejectedError,
  MonadStampTerminalError,
} from '@frank/wallet/monad-stamp-client'
import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/monad-mailbox-client'
import { messagingWallet } from '../utils/monad-identity-session'
import type {
  Message,
  MessageWrapper,
  MessageItem,
  OutgoingDelivery,
  OutgoingFailureReason,
  TextItem,
  StealthItem,
  SwapRecordItem,
  EmailItem,
  ConversationStateItem,
} from '@frank/cashweb/types/messages'
import {
  isSafeRelayTimestamp,
  type RelayDeliverySuppression,
  type RelayReceiptIdentity,
} from '@frank/cashweb/relay/storage/storage'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import {
  allocateOpeningConversationId,
  formatConversationId,
  isOpeningConversationId,
  uuidv5Bytes,
} from '@frank/cashweb/relay/conversation-id'
import { accountSession } from '../accounts/session'
import { useProfileStore } from './my-profile'
import { useSettingsStore } from './settings'
import { useContactStore } from './contacts'
import { useBalance } from '../composables/useBalance'
import { STORE_SCHEMA_VERSION } from 'src/boot/pinia'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
} from '../utils/own-address'
import { shortAddress } from '../utils/short-address'

export type ChatMessage = {
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
}

export type ChatState = Conversation

export function getTrustedEmailGatewayAddress(): string {
  try {
    const profile = useProfileStore()
    if (profile.emailBridgeGatewayAddress) {
      return profile.emailBridgeGatewayAddress
    }
  } catch {
    //
  }
  try {
    const settings = useSettingsStore()
    if (settings.emailGatewayAddress) {
      return settings.emailGatewayAddress
    }
  } catch {
    //
  }
  return defaultEmailGatewayAddress
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
function freeMessageId(
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
function isAnotherMessage(
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
function inDeletedConversation(
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
function reopenConversation(conversation: Conversation): void {
  if (conversation.deletedAt === undefined) return
  conversation.clearedBefore = Math.max(
    conversation.clearedBefore ?? -Infinity,
    conversation.deletedAt,
  )
  conversation.deletedAt = undefined
}

/** Relay time, then payload hash: one order for a conversation's messages, however they came. */
function byRelayTime(
  a: { serverTime?: number; receivedTime?: number; payloadDigest: string },
  b: { serverTime?: number; receivedTime?: number; payloadDigest: string },
): number {
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
function isOwnMessage(message: {
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
function speaksForConversation(
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
      createdAt: message.serverTime || Date.now(),
      activeRevisionDigest: revisionDigest,
      revisions: [],
    }
    logicalMessages[logicalId] = record
  }

  let rev = record.revisions.find(r => r.revisionDigest === revisionDigest)
  if (!rev) {
    rev = {
      revisionDigest,
      items: message.items,
      timestamp: message.serverTime || Date.now(),
      deliveries: [],
    }
    record.revisions.push(rev)
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
      timestamp: message.receivedTime || Date.now(),
    })
  } else {
    existingDelivery.status = message.status
    if (message.delivery?.attemptDigest) {
      existingDelivery.attemptDigest = message.delivery.attemptDigest
    }
  }
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
function messageStampPrice(message: {
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
function messageDestinationAddress(message: Message): string | undefined {
  return (message as Message & { destinationAddress?: string })
    .destinationAddress
}

/** A confirmed local outbox row is not proof that its relay receipt was observed. */
function observedRelayReceiptTime(
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
function tombstoneMailbox(message: Message): string | undefined {
  return message.outbound
    ? message.senderAddress
    : messageDestinationAddress(message)
}

/**
 * The relay time a tombstone may anchor the mailbox's read position at: only a time the relay
 * itself gave. A message we sent to someone else carries this device's own clock until its row
 * is read back, so its tombstone has no time; the relay's row gives it one when it arrives.
 */
function tombstoneReceiptTime(
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

function accountedMessageValue(message: {
  status: string
  items: MessageItem[]
  outpoints: Utxo[]
  stampValueWei?: bigint
}): number {
  if (message.status !== 'confirmed') return 0
  return messageStampPrice(message) + messageItems.tallyValue(message.items)
}

const defaultContactObject = {
  kind: 'direct' as const,
  totalUnreadMessages: 0,
  totalUnreadValue: 0,
  totalValue: 0,
  lastReceived: 0,
  lastRead: 0,
}

export interface State {
  activeConversationId: string | null
  conversations: Record<string, Conversation>
  messages: Record<string, ChatMessage | undefined>
  logicalMessages: Record<string, LogicalMessageRecord | undefined>
  lastReceived: number | null
}

/**
 * Bugfix found while writing this ticket's (#42) first-ever `stores/*.ts` jest tests: this used to
 * be a single module-level `const defaultChatsState: State = { chats: {}, ... }` object, spread
 * (`{ ...defaultChatsState }`) at each of its 3 use sites below. A shallow spread only copies the
 * *top-level* keys -- `chats`/`messages` themselves stayed the exact same shared object reference
 * across every call, so every `useChatStore()` instance in the same JS process (e.g. two Pinia
 * instances in the same test run, or any `$reset()` call) silently aliased the same mutable
 * `chats`/`messages` objects instead of getting an independent empty state. Harmless in production
 * today (exactly one `Pinia` instance is ever created per app lifetime, and nothing calls
 * `$reset()`), but a real correctness bug the moment either assumption changes -- and it made this
 * ticket's own tests (fresh `createPinia()` per test) silently leak state between tests. Fixed by
 * making a fresh, independent state object each call instead of spreading a shared constant.
 */
function freshChatsState(): State {
  return {
    conversations: {},
    messages: {},
    logicalMessages: {},
    lastReceived: null,
    activeConversationId: null,
  }
}

let pendingMessageSequence = 0

/** Local key of an outgoing message until its payload hash is known. Persisted (#269), so it must
 * stay unique across reloads, where the in-memory sequence restarts. */
function nextPendingMessageId(timestamp: number): string {
  pendingMessageSequence += 1
  const nonce = Math.random().toString(36).slice(2, 8)
  return `pending:${timestamp}:${pendingMessageSequence}:${nonce}`
}

/** Outgoing sends currently being worked on in this process, by local message key. */
const inflightOutgoing = new Set<string>()
/** Messages whose first send has begun in this tab and has not reached `runOutgoing` yet (their
 * row is being saved). Nothing else may judge them cut off. */
const startingOutgoing = new Set<string>()

/**
 * The ID an outgoing message is sent under: fixed by the message's local key, which is saved
 * with its row before the send starts and survives a reload. The wallet keeps one attempt per
 * message ID, ever: every send and retry of one message names the same ID, so a message whose
 * send was cut off (a reload) is found again in the wallet by it (`attemptOf`) and can never be
 * paid for twice.
 */
export function outgoingMessageId(localKey: string): string {
  return uuidv5(NULL_CONVERSATION_NAMESPACE, `frank-outgoing:${localKey}`)
}

// Incoming message indexes whose notification is being decided right now. The `index in
// this.messages` check only sees a message once it is stored, which happens after several awaits
// (persisting it, loading an unknown contact), so two overlapping receiveMessages calls for the
// same message would both pass it and both notify. An index is claimed synchronously, before the
// first await, and released once the call has stored it (or failed, so a retry can still notify).
const notifyingIncoming = new Set<string>()
/** Relay rows this session refused to file. Each is quarantined and reported when refused; if
 * the relay hands one back before the cursor has moved past it, it is not looked at again. */
const refusedIncoming = new Set<string>()

// Inbox delivery and local send completion can both confirm/re-key the same payload. Enqueue the
// mutation synchronously, before either path's first await, so relay-authored metadata always wins
// when a poll overlaps `directMessages.send` completion.
let deliveryMutationTail: Promise<void> = Promise.resolve()

async function serializeDeliveryMutation<T>(
  work: () => Promise<T>,
): Promise<T> {
  const predecessor = deliveryMutationTail
  let release = () => undefined
  deliveryMutationTail = new Promise<void>(resolve => {
    release = resolve
  })
  await predecessor
  try {
    return await work()
  } finally {
    release()
  }
}

function matchesOutgoingOwner(
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

/** Called inside the delivery mutation boundary, immediately before changing an attributed row. */
async function assertDurableAttemptAssociation(
  id: string,
  expectedDigest: string | undefined,
  message: Message,
  address: string,
): Promise<void> {
  if (expectedDigest === undefined) return
  const messageStore = await store
  if (typeof messageStore.getMessage !== 'function') return
  const persisted = await messageStore.getMessage(id)
  if (persisted && !matchesOutgoingOwner(persisted, message, address)) {
    throw new Error(`conflicting stored conversation owner for ${id}`)
  }
  const storedDigest = persisted?.message.delivery?.attemptDigest
  if (storedDigest !== undefined && storedDigest !== expectedDigest) {
    throw new Error(`conflicting stored payment attempt for ${id}`)
  }
}

/** A wallet's own records (`wallet-sync`, `payment-transfer`) are never taken from a mailbox row
 * here. The wallet's receive rule already keeps them from arriving as such; if one does, that
 * row alone is refused, uninterpreted, like any other row that cannot be filed. */
function carriesWalletRecord(wrapper: ReceivedMessageWrapper): boolean {
  return !!wrapper.message.items?.some(
    item =>
      item && (item.type === 'wallet-sync' || item.type === 'payment-transfer'),
  )
}

/**
 * A received row that carries nothing but records (today: a swap's note to self) is not a
 * message. It is never filed into a conversation and never saved as one, in the session or on a
 * reload: its records go to the store that owns them and the row is left in the mailbox.
 */
function carriesOnlyRecords(wrapper: ReceivedMessageWrapper): boolean {
  return (
    isInternalMessage(wrapper.message.items) && !carriesWalletRecord(wrapper)
  )
}

/**
 * The swap records of a row the account sent to itself. A swap record in anyone else's row, or
 * in our own row to someone else, says nothing about this account's swaps and is not handed on.
 * The wallet's receive rule already refuses those rows; this does not rely on it.
 */
function ownSwapRecords(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): SwapRecordItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is SwapRecordItem => !!item && item.type === 'swap-record',
  )
}

/**
 * The conversation notes of a row the account sent to itself: what one of its devices says
 * about a conversation, for the others. Anyone else's row carries none (the wallet's receive
 * rule already refuses those; this does not rely on it).
 */
function ownConversationStates(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): ConversationStateItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is ConversationStateItem =>
      !!item && item.type === 'conversation-state',
  )
}

/** A message of ours the relay has not timed yet: its time is this device's clock, which no
 * other device sees. No deletion time is taken from it, and a deletion noted from elsewhere
 * never covers it. */
function isUntimedOutgoing(
  message: Pick<ChatMessage, 'outbound' | 'status' | 'localTime'>,
): boolean {
  return (
    message.outbound &&
    (message.status !== 'confirmed' || message.localTime === true)
  )
}

/** The newest relay time in these messages; zero when the relay has timed none of them. */
function newestRelayTime(messages: readonly ChatMessage[]): number {
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
function accountTag(): string | undefined {
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
const readNotedAt = new Map<string, number>()

/** The time up to which a conversation's messages are gone, if it was ever deleted. */
function clearedUpTo(conversation: Conversation): number | undefined {
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
function conversationStateToNote(
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

/**
 * How far this device has read a conversation, as every device of the account can state it: the
 * relay time of the newest message from someone else that has been read here. (Our own messages
 * are never unread, and one still on its way carries this device's clock, so `lastRead` itself
 * is not a time the other devices share.) Zero when nothing of the peer's has been read.
 *
 * Only messages sent to `ownAddress` count: this device's store can still hold conversations of
 * an account that was replaced here, and what was read there is not this account's to note.
 */
function readUpTo(conversation: Conversation, ownAddress: string): number {
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
function recordNoted(
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
  // The mailbox says exactly what the user set here: nothing is left to note. (A subject set
  // again while the note was on its way is still to be noted.)
  if (
    note.subject !== undefined &&
    note.subjectSetAt === (conversation.nameSetAt ?? 0) &&
    note.subject === (usableSubject(conversation.name) ?? '')
  )
    conversation.subjectToNote = undefined
}

/** The ID of the note stating exactly these facts: the same on every device, so two devices
 * noting the same thing write the same message. */
function conversationNoteId(note: ConversationStateItem): Uint8Array {
  return uuidv5Bytes(
    new Uint8Array(16),
    `frank-conversation-state:${note.conversationId}:${
      note.clearedBefore ?? ''
    }:${note.readUpTo ?? ''}:${note.subjectSetAt ?? ''}:${note.subject ?? ''}`,
  )
}

/** One pass of `noteConversationStates` at a time; a change made during it starts another. */
let notingConversations: Promise<void> | undefined
let noteConversationsAgain = false

/**
 * Cancellation identity of one delivery attempt (e.g. one direct-message poller generation).
 * Whether to notify is decided synchronously, but the delivery mutation itself is queued behind
 * the module-global serialized boundary -- when account replacement stops the old poller and
 * starts a new session, a queued delivery must re-check the guard AT the boundary and again
 * before every notification step, so an old generation never persists into the message store,
 * mutates the shared chats state, or notifies through the current session's stores.
 */
export type DeliveryLease = { isCancelled: () => boolean }

export type ReceivedDeliveryResult = {
  suppressedReceipts: RelayReceiptIdentity[]
  /** True when the lease was cancelled at or after the delivery boundary: nothing was
   * persisted, mutated, or notified, and the caller must not treat the batch as consumed. */
  cancelled: boolean
}

export type OutgoingOutcome =
  /** Delivered; the local copy is now keyed by its real payload hash. */
  | { state: 'sent'; payloadDigest: string }
  /** Payment not yet confirmed. The same payment is re-sent automatically; nothing new is paid. */
  | { state: 'payment-pending' }
  /** Failed; kept in the conversation with a manual Retry and Discard. */
  | { state: 'failed'; reason: OutgoingFailureReason }
  /** A retry could pay a second time; the caller must ask the user, then retry with
   * `confirmed: true`. */
  | { state: 'needs-confirmation'; reason: OutgoingFailureReason }
  /** This message is already being worked on, or no longer exists. */
  | { state: 'busy' }

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function isNoResponseError(error: unknown): boolean {
  const candidate = error as { isAxiosError?: boolean; response?: unknown }
  return (
    (candidate?.isAxiosError === true && candidate.response === undefined) ||
    (error instanceof Error && error.name === 'MonadMailboxRetryableError')
  )
}

function isInsufficientFundsError(error: unknown): boolean {
  const kind =
    error !== null && typeof error === 'object' && 'kind' in error
      ? (error as { kind?: unknown }).kind
      : undefined
  return (
    kind === 'insufficient-funds' ||
    (error instanceof Error &&
      // The wallet's own answer when nothing it holds covers the stamp and its fee.
      (error.name === 'InsufficientStampFundsError' ||
        /insufficient (?:main account )?(?:balance|funds)|insufficient stamp-account capacity|no funds cover a stamp/i.test(
          error.message,
        )))
  )
}

/** Maps a failed send to the reason class shown to the user, and says whether the message must
 * keep its payment attempt (so a later retry asks the wallet about it instead of paying again). */
function classifySendFailure(
  error: unknown,
  ownDigest: string | undefined,
): { reason: OutgoingFailureReason; keepDigest?: string } {
  if (error instanceof MonadStampRecoveredAttemptError) {
    return { reason: 'recovered' }
  }
  if (error instanceof MonadStampAbandonedError) {
    // The exact set may still be owned by the relay but is no longer resumable here.
    return { reason: 'unverified', keepDigest: error.payloadHashHex }
  }
  if (
    error instanceof MonadStampTerminalError ||
    error instanceof MonadStampRejectedError
  ) {
    return { reason: 'rejected' }
  }
  if (error instanceof MonadMailboxUnavailableError) {
    return { reason: 'unavailable' }
  }
  if (
    error instanceof CanonicalRecipientNotPublishedError ||
    (error instanceof Error &&
      error.name === 'CanonicalRecipientNotPublishedError')
  ) {
    return { reason: 'recipient-unregistered' }
  }
  if (isInsufficientFundsError(error)) {
    return { reason: 'insufficient-funds' }
  }
  // The chain's fee rose above the stamp the composer showed when the user sent. The wallet
  // paid and sent nothing. The app never pays more than was shown: the message fails, saying
  // so, and sending it again takes the stamp now shown.
  if (
    error instanceof DirectMessageStampBelowFeeError ||
    (error instanceof Error && error.name === 'DirectMessageStampBelowFeeError')
  ) {
    return { reason: 'stamp-below-fee' }
  }
  return {
    reason: isNoResponseError(error) ? 'unreachable' : 'error',
    // Any failure after the payment set was journaled leaves that set on the message.
    keepDigest: ownDigest,
  }
}

type OutboundDeliveryMatch = {
  oldIndex: string
  chatAddress: string
  conversationId: string
  message: Message & { destinationAddress?: string }
}

type OutboundDeliveryOwner = {
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

function recomputeChatAccounting(
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

/**
 * A conversation's earliest message that the relay has timed: relay time, then payload hash.
 * A message of ours that is still pending or failed carries this device's clock, which no other
 * device sees, so it does not count until the relay has it. `messages` is kept in relay order,
 * so the first timed one is the earliest; only rows of the same time are compared by hash.
 */
function earliestMessage(conversation: Conversation): ChatMessage | undefined {
  let first: ChatMessage | undefined
  for (const message of conversation.messages) {
    if (message.outbound && message.status !== 'confirmed') continue
    if (!first) first = message
    else if (message.serverTime > first.serverTime) break
    else if (byRelayTime(message, first) < 0) first = message
  }
  return first
}

/**
 * The peer's thread: the one conversation Contacts opens for `peer`.
 *
 * It is derived from facts every device of the account sees, never from which device opened
 * what first: of the conversations with this peer (email threads aside) that carry an opening ID (a UUIDv5, what an
 * account allocates when it opens a chat; an explicitly created further conversation is a
 * UUIDv4 and never becomes the peer's thread) and that the peer or this account started (their
 * earliest message is from one of the two, not from a third party), the one whose earliest
 * message is the earliest, by relay time and then payload hash. With no such message yet it is
 * the conversation this account opens with the peer, the ID allocated from its private salt, if
 * that exists. A thread opened here and still empty therefore yields to the peer's own
 * conversation when the peer's first message arrives, on every device alike, and a reload
 * computes the same answer from the same messages.
 */
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
      // An email thread's ID is the gateway's own; it is never anybody's opening thread,
      // whatever its bytes happen to look like.
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

/** The ID of the peer's thread, whether or not that conversation has been opened on this
 * device yet: with no message exchanged, the ID this account allocates for the peer. */
export function peerThreadId(
  conversations: Record<string, Conversation | undefined>,
  peer: string,
): string {
  return (
    peerThread(conversations, peer)?.id ??
    allocateOpeningConversationIdFor(peer)
  )
}

/** Every peer's thread by peer address: a derived view, never a writer. */
function defaultChats(
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

/** A subject as the wire accepts it (1 to 512 characters, not only whitespace, no control
 * characters), trimmed; `undefined` for anything else. */
function usableSubject(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Direction overrides and isolates would let a subject reorder the text shown around it.
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

/**
 * A subject carried by a message sets or replaces the conversation's subject when the message is
 * from the conversation's peer or from this account itself (its own message read back from the
 * mailbox: a rename made on another of its devices). Nobody else's message changes it. Of two
 * renames the one with the later relay time wins, whatever order they are read in, so every
 * device of the account ends with the same subject. An email thread's subject is the email's;
 * a carried subject does not override it.
 */
function applyCarriedSubject(
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

/**
 * Whether a subject set at `setAt` replaces the conversation's current one. One rule for every
 * way a subject arrives (carried by a message, at the message's relay time; noted by another
 * device of this account, at the time the user set it): the later one wins, whatever order they
 * are read in; of two set at the same time, the greater text. So every device of the account
 * ends with the same subject, and reading the same one again changes nothing.
 */
function subjectReplaces(
  conversation: Conversation,
  subject: string | undefined,
  setAt: number,
): boolean {
  const current = conversation.nameSetAt ?? 0
  if (setAt !== current) return setAt > current
  return (subject ?? '') >= (usableSubject(conversation.name) ?? '')
}

/** Gives the conversation a subject that {@link subjectReplaces} its current one. A subject
 * the user set here and has not noted yet is replaced with it: there is nothing left to note. */
function setSubject(
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

/** The subject the next message sent in `conversation` must carry, if any: its subject when no
 * message has carried that subject yet (a new conversation with a subject, or a rename). */
function subjectToCarry(
  conversation: Conversation | undefined,
): string | undefined {
  if (!conversation || conversation.kind === 'email') return undefined
  const subject = usableSubject(conversation.name)
  return subject === conversation.nameOnWire ? undefined : subject
}

function canonicalConversationId(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex))
    throw new Error('Conversation identity must contain exactly 16 bytes')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The active account's private conversation-ID salt. Installed by the host when a wallet
 * becomes active and cleared when it goes ({@link setConversationIdSalt}); never persisted, so
 * it is not store state. It is reactive: a peer's thread read before the salt arrived is read
 * again when it does. */
const conversationIdSalt = shallowRef<Uint8Array | null>(null)

/** Whether the active account's conversation-ID salt is installed: a chat can be opened. */
export function hasConversationIdSalt(): boolean {
  return conversationIdSalt.value !== null
}

/** Installs (or, with nothing, removes) the active account's conversation-ID salt. */
export function setConversationIdSalt(salt?: Uint8Array | null): void {
  conversationIdSalt.value = salt ? Uint8Array.from(salt) : null
}

/** Threads dropped this session because the peer's own conversation replaced them, and what
 * replaced each: a view, a dialog or a route still holding the old ID is led to the new one. */
const replacedConversations = new Map<string, string>()

/** The conversation `id` names, or the one that replaced it if it was dropped. */
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

/**
 * The ID of the conversation this account opens with `peer`, and the ID a message from `peer`
 * that carries none is filed under. From the account's private salt it is the same on every
 * device and unknown to everyone else.
 *
 * It needs the salt. An account that can open a chat has one (it is installed as soon as the
 * account's wallet is, before any chat can be opened), so a missing salt is a defect and is
 * refused: a random ID here would differ on every device, for good.
 */
function allocateOpeningConversationIdFor(peer: string): string {
  const salt = conversationIdSalt.value
  if (!salt)
    throw new Error(
      'No conversation-ID salt is installed: a chat can be opened only once the account is active',
    )
  return formatConversationId(
    allocateOpeningConversationId(salt, peer.toLowerCase()),
  )
}

/** The conversation this account opens with `peer` (its salted ID), created if it is not there. */
function openAllocatedConversation(
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

function freshConversationId(): string {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  return canonicalConversationId(
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
  )
}

function assertConversationPeer(
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

/** Whoever posts into a conversation is one of its participants from then on. A message is
 * filed under the conversation ID it carries, so this can be someone other than the peer the
 * conversation was opened with; recording them is what lets the chat show who said what. */
function addParticipant(
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

function newConversation({
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

function openDefaultConversation(
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
  // No message with this peer yet: the conversation this account opens with it.
  const opened = openAllocatedConversation(conversations, peer, participants)
  reopenConversation(opened)
  return opened
}

function isInternalMessage(items: unknown): boolean {
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
          item.type === 'payment-transfer'),
    )
  )
}

export async function rehydateChat(
  chatState: RestorableState,
  metadataCompatible = true,
): Promise<State> {
  const localStore = await store
  const messageIterator = await localStore.getIterator()
  const wrappers: MessageWrapper[] = []
  for await (const wrapper of messageIterator) {
    if (
      !wrapper ||
      typeof wrapper !== 'object' ||
      Array.isArray(wrapper) ||
      !wrapper.message ||
      typeof wrapper.message !== 'object' ||
      Array.isArray(wrapper.message)
    )
      throw new Error('Invalid stored message envelope: message body required')
    wrappers.push(wrapper)
  }

  // Validate the complete durable collection before normalizing statuses, excluding leftovers,
  // or publishing any owner. Old ownerless conversational rows are not a default-thread hint.
  const validatedRows = wrappers.map(wrapper => {
    const { index, message } = wrapper
    if (
      typeof index !== 'string' ||
      !index.trim() ||
      typeof message.outbound !== 'boolean' ||
      typeof message.status !== 'string' ||
      !message.status.trim() ||
      !Number.isFinite(message.receivedTime) ||
      !Number.isFinite(message.serverTime) ||
      !Array.isArray(message.items) ||
      !Array.isArray(message.outpoints) ||
      typeof wrapper.copartyAddress !== 'string' ||
      !wrapper.copartyAddress.trim() ||
      (wrapper.outbound !== undefined &&
        wrapper.outbound !== message.outbound) ||
      typeof wrapper.senderAddress !== 'string' ||
      !wrapper.senderAddress ||
      typeof message.senderAddress !== 'string' ||
      !message.senderAddress ||
      (wrapper.senderAddress !== message.senderAddress &&
        !sameCanonicalAddress(wrapper.senderAddress, message.senderAddress))
    )
      throw new Error(`Invalid stored message envelope for ${index}`)
    const internal = isInternalMessage(message.items)
    let conversationId: string | undefined
    if (message.conversationId !== undefined) {
      try {
        if (typeof message.conversationId !== 'string')
          throw new Error('Invalid ID')
        conversationId = canonicalConversationId(message.conversationId)
      } catch {
        throw new Error(
          `Unsupported stored conversation format for ${index}: valid conversation ID required`,
        )
      }
    }
    if (!internal && !conversationId) {
      throw new Error(
        `Unsupported stored conversation format for ${index}: explicit conversation ID required`,
      )
    }
    return { wrapper, conversationId, internal }
  })

  const hasChatMetadata =
    chatState !== null &&
    typeof chatState === 'object' &&
    !Array.isArray(chatState)
  const canReconstruct = metadataCompatible && hasChatMetadata
  if (!canReconstruct && validatedRows.some(row => !row.internal)) {
    throw new Error(
      'Unsupported stored conversation format: conversational rows require compatible chat metadata',
    )
  }

  const conversations: Record<string, Conversation> = {}
  const messages: Record<string, ChatMessage> = {}
  const logicalMessages: Record<string, LogicalMessageRecord> = {}
  // Available metadata still constrains explicit internal owners even when this context
  // cannot reconstruct conversations. Never substitute current metadata for a mismatch.
  for (const [id, raw] of Object.entries(
    hasChatMetadata ? chatState.conversations ?? {} : {},
  )) {
    if (!raw) continue
    const conversation = newConversation({
      ...raw,
      id,
      address: raw.address,
      participants: raw.participants,
    })
    conversations[conversation.id] = conversation
  }

  // Rows are read in the order they were received in: relay time, then payload hash.
  const orderedRows = [...validatedRows].sort((a, b) =>
    byRelayTime(
      { ...a.wrapper.message, payloadDigest: a.wrapper.index },
      { ...b.wrapper.message, payloadDigest: b.wrapper.index },
    ),
  )
  // A conversation the saved metadata does not know is rebuilt from its rows. Our own rows say
  // who it is with, so they are read first: whoever else wrote into it, and whenever, cannot
  // make it theirs and then contradict our own outbox.
  for (const { wrapper, conversationId, internal } of [
    ...orderedRows.filter(row => row.wrapper.message.outbound),
    ...orderedRows.filter(row => !row.wrapper.message.outbound),
  ]) {
    const { message, copartyAddress } = wrapper
    const peer = safeChainDisplayAddress(copartyAddress) || copartyAddress
    const existing = conversationId ? conversations[conversationId] : undefined
    // Internal records never reconstruct a chat or dispatch item effects. Check any explicit
    // owner reference below, after all conversational owners have been prepared.
    if (internal) continue
    // Only our own messages are bound to the conversation's peer. An inbound message is filed
    // under the ID it carries, whoever sent it.
    if (existing && message.outbound) assertConversationPeer(existing, peer)
    const id = conversationId!
    conversations[id] ??= newConversation({
      id,
      address: peer,
      // Restore only persisted peer evidence; hydration must not open custody for self.
      participants: [peer],
      kind: message.items?.some(item => item.type === 'email')
        ? 'email'
        : 'direct',
    })
  }

  // Only our own records are bound to the conversation's peer, as with conversational rows.
  for (const { wrapper, conversationId, internal } of validatedRows) {
    if (!internal || !conversationId || !wrapper.message.outbound) continue
    const owner = conversations[conversationId]
    if (owner) assertConversationPeer(owner, wrapper.copartyAddress)
  }

  // An attempt digest links an outgoing leftover to its confirmed row. Validate that
  // association before deduplication can hide contradictory persisted ownership.
  const confirmedOutboundRows = new Map(
    validatedRows
      .filter(
        ({ wrapper, internal }) =>
          !internal &&
          wrapper.message.outbound &&
          wrapper.message.status === 'confirmed',
      )
      .map(row => [row.wrapper.index, row]),
  )
  for (const { wrapper, conversationId, internal } of validatedRows) {
    const { message, index, copartyAddress, senderAddress } = wrapper
    const attemptDigest = message.delivery?.attemptDigest
    if (
      internal ||
      !message.outbound ||
      message.status === 'confirmed' ||
      attemptDigest === undefined ||
      attemptDigest === index
    )
      continue
    const confirmed = confirmedOutboundRows.get(attemptDigest)
    if (!confirmed) continue
    const other = confirmed.wrapper
    if (
      (senderAddress !== other.senderAddress &&
        !sameCanonicalAddress(senderAddress, other.senderAddress)) ||
      (copartyAddress !== other.copartyAddress &&
        !sameCanonicalAddress(copartyAddress, other.copartyAddress))
    )
      continue
    if (
      conversationId !== confirmed.conversationId ||
      (message.logicalMessageId !== undefined &&
        other.message.logicalMessageId !== undefined &&
        message.logicalMessageId !== other.message.logicalMessageId)
    ) {
      throw new Error(`Conflicting stored attempt ownership for ${index}`)
    }
  }

  // Two different stored messages that name one message ID never stop the store from loading.
  // The routine is the one receive uses: the earlier keeps the ID, the later is read under a
  // derived one.
  const logicalOwners = new Map<
    string,
    { conversationId: string; senderAddress: string }
  >()
  for (const { wrapper, conversationId, internal } of orderedRows) {
    if (internal) continue
    const { message, index } = wrapper
    const named = message.logicalMessageId || index
    const logicalId = freeMessageId(named, index, id =>
      isAnotherMessage(
        logicalOwners.get(id),
        conversationId!,
        message.senderAddress,
      ),
    )
    if (logicalId !== named) message.logicalMessageId = logicalId
    if (!logicalOwners.has(logicalId))
      logicalOwners.set(logicalId, {
        conversationId: conversationId!,
        senderAddress: message.senderAddress,
      })
  }

  // An internal row may precede the conversational row that establishes its explicit owner.
  // Check that reference against the complete prepared owner set, independent of iterator order.
  // Only an admitted empty/internal-only collection may take a fresh-state exit.
  // Raw internal records remain in MessageStore without conversation indexes or effects.
  if (!canReconstruct) return freshChatsState()

  let lastReceived = Math.max(
    chatState.lastReceived ?? 0,
    await localStore.mostRecentMessageTime(),
  )
  // A message that was delivered after being re-keyed from its local id to its payload hash can
  // leave its old local record behind if the app stopped between the two writes. The confirmed
  // record wins in the derived view; retain both durable records for recovery.
  const confirmedDigests = new Set(
    wrappers
      .filter(({ message }) => message.status === 'confirmed')
      .map(row => row.index),
  )
  for (const { wrapper, conversationId, internal } of orderedRows) {
    const { index, message: newMsg, copartyAddress } = wrapper
    if (internal) {
      messages[index] = { payloadDigest: index, ...newMsg }
      continue
    }
    const leftoverOf = newMsg.delivery?.attemptDigest
    if (
      newMsg.status !== 'confirmed' &&
      leftoverOf !== undefined &&
      index !== leftoverOf &&
      confirmedDigests.has(leftoverOf)
    ) {
      // Rebuild the deduplicated view without deleting durable recovery evidence.
      continue
    }
    if (newMsg.outbound && newMsg.status === 'pending') {
      // A send that was in flight when the app stopped is no longer running. With a recorded
      // payment attempt it is recoverable (the same bytes are re-sent). Without one this row
      // cannot say: the wallet may have stored the complete signed message a moment before the
      // app stopped. It stays "sending" until the wallet is asked (`resumeCutOffOutgoing`, on
      // the first reconciliation): what the wallet stored is finished with the same bytes, and
      // only a message it holds nothing for is shown as interrupted.
      if (newMsg.delivery?.attemptDigest !== undefined)
        newMsg.status = 'payment-pending'
    }
    const message: ChatMessage = { payloadDigest: index, ...newMsg }
    const emailItem = message.items?.find(it => it.type === 'email') as
      | EmailItem
      | undefined
    const conv = conversations[conversationId!]

    message.conversationId = conv.id
    const deleted = inDeletedConversation(conv, message)
    if (deleted === 'gone') {
      // Receive never saves such a row. One that is on disk all the same is not shown or
      // counted and joins nobody; only its ID is held, so a later message naming the same ID
      // is told apart from it.
      recordLogicalMessage(logicalMessages, message, conv.id)
      continue
    }
    if (deleted === 'reopens') reopenConversation(conv)
    messages[index] = message
    if (!conv.messages.some(m => m.payloadDigest === message.payloadDigest)) {
      conv.messages.push(message)
    }
    if (!message.outbound) addParticipant(conv, message.senderAddress)
    if (emailItem && speaksForConversation(conv, message)) {
      conv.kind = 'email'
      if (!conv.name && emailItem.subject) {
        conv.name = emailItem.subject
      }
      const trustedGateway = getTrustedEmailGatewayAddress()
      const isGateway = message.outbound
        ? sameCanonicalAddress(conv.address, trustedGateway) ||
          sameCanonicalAddress(copartyAddress, trustedGateway)
        : sameCanonicalAddress(message.senderAddress, trustedGateway)
      conv.verifiedGateway = isGateway
    }
    recordLogicalMessage(logicalMessages, message, conv.id)

    conv.lastReceived = Math.max(conv.lastReceived, message.serverTime)
    const messageValue = accountedMessageValue(message)
    if (
      !isOwnMessage(message) &&
      conv.id !== chatState.activeConversationId &&
      conv.lastRead < message.serverTime
    ) {
      conv.totalUnreadValue += messageValue
      conv.totalUnreadMessages += 1
    }
    lastReceived = Math.max(lastReceived, message.serverTime)
    conv.totalValue += messageValue
  }

  // Resort conversations and recompute deterministic accounting from deduplicated messages
  for (const conv of Object.values(conversations)) {
    conv.messages.sort(byRelayTime)
    conv.totalUnreadMessages = 0
    conv.totalUnreadValue = 0
    conv.totalValue = 0
    for (const msg of conv.messages) {
      const val = accountedMessageValue(msg)
      conv.totalValue += val
      const msgTime = msg.serverTime ?? msg.receivedTime ?? 0
      conv.lastReceived = Math.max(conv.lastReceived ?? 0, msgTime)
      if (
        !isOwnMessage(msg) &&
        conv.id !== chatState.activeConversationId &&
        conv.lastRead < msgTime
      ) {
        conv.totalUnreadMessages += 1
        conv.totalUnreadValue += val
      }
    }
  }

  return {
    conversations,
    messages,
    logicalMessages,
    activeConversationId: chatState.activeConversationId ?? null,
    lastReceived,
  }
}

export const rehydrateState = rehydateChat

export const useChatStore = defineStore('chats', {
  state: (): State => freshChatsState(),
  getters: {
    getMessageByPayload: state => (payloadDigest: string) => {
      if (!state.messages) {
        return null
      }
      return state.messages[payloadDigest]
    },
    getConversation: state => (id: string) => {
      return state.conversations[id]
    },
    getConversationsForAddress: state => (address: string) => {
      try {
        const canonical = toChainDisplayAddress(address)
        return Object.values(state.conversations).filter(c =>
          c.participants.some(p => sameCanonicalAddress(p, canonical)),
        )
      } catch {
        return []
      }
    },
    chats: state => defaultChats(state.conversations),
    activeChatAddr(state): string | null {
      return state.activeConversationId
        ? state.conversations[state.activeConversationId]?.address ?? null
        : null
    },
    activeConversation(state): Conversation | null {
      return state.activeConversationId
        ? state.conversations[state.activeConversationId] ?? null
        : null
    },
    getNumUnread: state => (addressOrId: string) => {
      if (state.conversations && addressOrId in state.conversations) {
        return state.conversations[addressOrId]?.totalUnreadMessages ?? 0
      }
      try {
        const displayAddress = toChainDisplayAddress(addressOrId)
        return peerThread(state.conversations, displayAddress)
          ? peerThread(state.conversations, displayAddress)
              ?.totalUnreadMessages ?? 0
          : 0
      } catch {
        return 0
      }
    },
    totalUnread(state) {
      return Object.values(state.conversations)
        .filter(c => !c.deletedAt)
        .reduce((total, c) => total + c.totalUnreadMessages, 0)
    },
    /** Newest message first. The order changes only when a message is sent or received:
     * reading a conversation does not move it. */
    getSortedChatOrder(state) {
      const latest = (conversation: Conversation) =>
        conversation.lastReceived || conversation.createdAt || 0
      return Object.values(state.conversations)
        .filter(c => !c.deletedAt)
        .sort((a, b) => latest(b) - latest(a))
    },
    lastRead: state => (addressOrId: string) => {
      if (state.conversations && addressOrId in state.conversations) {
        return state.conversations[addressOrId]?.lastRead ?? 0
      }
      try {
        const displayAddress = toChainDisplayAddress(addressOrId)
        return peerThread(state.conversations, displayAddress)?.lastRead ?? 0
      } catch {
        return 0
      }
    },
    /** The stamp a message in this conversation carries: what the user chose for it, else the
     * chain's configured default. What the peer pays does not change it. Zero is a free message. */
    getStampWei:
      state =>
      (addressOrId: string): bigint | undefined => {
        let chat: Conversation | undefined = state.conversations?.[addressOrId]
        if (!chat) {
          try {
            chat = peerThread(
              state.conversations,
              toChainDisplayAddress(addressOrId),
            )
          } catch {
            chat = undefined
          }
        }
        return chat?.stampWei === undefined ? undefined : BigInt(chat.stampWei)
      },
    getLatestMessage: state => (addressOrId: string) => {
      let chat: Conversation | undefined
      if (state.conversations && addressOrId in state.conversations) {
        chat = state.conversations[addressOrId]
      } else {
        try {
          const displayAddress = toChainDisplayAddress(addressOrId)
          chat = peerThread(state.conversations, displayAddress)
        } catch {
          chat = undefined
        }
      }
      if (!chat) {
        return null
      }

      const nMessages = Object.keys(chat.messages).length
      if (nMessages === 0) {
        return null
      }

      const lastMessage = chat.messages[chat.messages.length - 1]
      const items = lastMessage.items
      const lastItem = items[items.length - 1]

      if (!lastItem) {
        console.error(chat.address || addressOrId)
        return null
      }

      // A message with pictures is previewed as its picture count and its text, not as the
      // attachment references the text carries. `photos` is 0 for any other message.
      const pictures = picturePreview(items)
      return {
        outbound: lastMessage.outbound,
        senderAddress: lastMessage.senderAddress,
        photos: pictures?.photos ?? 0,
        text: pictures ? pictures.text : messageItems.previewText(lastItem),
      }
    },
    getLastReceived(state) {
      return state.lastReceived
    },
  },
  actions: {
    async relayCursor(recipientAddress: string): Promise<number> {
      try {
        const canonical = toChainDisplayAddress(recipientAddress)
        const messageStore = await store
        if (typeof messageStore?.relayCursor === 'function') {
          return await messageStore.relayCursor(canonical)
        }
      } catch {
        // Fall back to 0 for unparseable addresses or mock stores lacking relayCursor
      }
      return 0
    },
    async quarantineRelayReceipts(
      recipientAddress: string,
      receipts: RelayReceiptIdentity[],
    ): Promise<void> {
      try {
        const canonical = toChainDisplayAddress(recipientAddress)
        const messageStore = await store
        if (typeof messageStore?.quarantineRelayReceipts === 'function') {
          await messageStore.quarantineRelayReceipts(canonical, receipts)
        }
      } catch (err) {
        // The rows stay unanchored: a restart may fetch them again.
        console.error('could not quarantine relay receipts', err)
      }
    },
    async deleteMessage({
      address,
      payloadDigest,
      attemptDigest: explicitAttemptDigest,
      wallet,
    }: {
      address: string
      payloadDigest: string
      attemptDigest?: string
      wallet?: WalletHandle
    }): Promise<void> {
      // A send of this message that is still waiting is cancelled: nothing was signed for it.
      cancelWaitingSend(payloadDigest)
      let message = this.messages[payloadDigest]
      if (!message) {
        if (this.conversations) {
          for (const conv of Object.values(this.conversations)) {
            const found = conv?.messages?.find(
              m =>
                m.payloadDigest === payloadDigest ||
                m.delivery?.attemptDigest === payloadDigest ||
                m.messageHash === payloadDigest ||
                (m as any).index === payloadDigest,
            )
            if (found) {
              message = found
              break
            }
          }
        }
      }
      const attemptDigest =
        explicitAttemptDigest || message?.delivery?.attemptDigest
      // The tombstone goes under this account's own mailbox, whichever way the message went:
      // the relay keeps our sent messages there too, and hands them back like received ones.
      // The wallet is not asked anything: a delete moves no money and waits for no chain. A
      // payment to a contact the message carried stays the wallet's to finish, and stays listed
      // under the Wallet page's unfinished payments until it is.
      const recipientAddress = message
        ? tombstoneMailbox(message) ?? null
        : null
      await serializeDeliveryMutation(() =>
        this.deleteMessageExclusive({
          address,
          payloadDigest,
          recipientAddress,
          attemptDigest,
          wallet,
        }),
      )
      if (message?.outbound) {
        const resolvedWallet = wallet || messagingWallet()
        if (resolvedWallet) {
          const allChats = [...Object.values(this.conversations ?? {})]
          const hasQueued = allChats.some(c =>
            c?.messages?.some(
              m =>
                m.outbound &&
                m.status === 'payment-pending' &&
                m.delivery?.attemptDigest === undefined &&
                walletOwnsMessage(resolvedWallet, m),
            ),
          )
          if (hasQueued) {
            try {
              await this.reconcileOutgoing({ wallet: resolvedWallet })
            } catch (err) {
              console.warn(
                'could not reconcile outgoing after deleteMessage:',
                err,
              )
            }
          }
        }
      }
    },
    async deleteMessageExclusive({
      address,
      payloadDigest,
      recipientAddress,
      attemptDigest,
      wallet: explicitWallet,
    }: {
      address: string
      payloadDigest: string
      recipientAddress: string | null
      attemptDigest?: string
      wallet?: WalletHandle
    }): Promise<void> {
      const messageStore = await store
      let message = this.messages[payloadDigest]
      if (!message) {
        if (this.conversations) {
          for (const conv of Object.values(this.conversations)) {
            const found = conv?.messages?.find(
              m =>
                m.payloadDigest === payloadDigest ||
                m.delivery?.attemptDigest === payloadDigest ||
                m.messageHash === payloadDigest ||
                (m as any).index === payloadDigest,
            )
            if (found) {
              message = found
              break
            }
          }
        }
      }
      const installedDelivery = attemptDigest
        ? this.messages[attemptDigest]
        : undefined
      const digests = new Set([payloadDigest, attemptDigest].filter(Boolean))
      if (message?.delivery?.attemptDigest) {
        digests.add(message.delivery.attemptDigest)
      }
      if (message?.messageHash) {
        digests.add(message.messageHash)
      }
      if (message?.deliveryDigest) {
        digests.add(message.deliveryDigest)
      }
      if (message?.revisionDigest) {
        digests.add(message.revisionDigest)
      }
      if ((message as any)?.index) {
        digests.add((message as any).index)
      }
      const suppressions: RelayDeliverySuppression[] = []
      if (attemptDigest) suppressions.push({ payloadDigest: attemptDigest })
      if (!payloadDigest.startsWith('pending:')) {
        const receivedTime = tombstoneReceiptTime(message)
        suppressions.push({
          payloadDigest,
          ...(receivedTime === undefined ? {} : { receivedTime }),
        })
      }
      const installedReceivedTime = tombstoneReceiptTime(installedDelivery)
      if (installedReceivedTime !== undefined && attemptDigest) {
        suppressions.splice(0, 1, {
          payloadDigest: attemptDigest,
          receivedTime: installedReceivedTime,
        })
      }
      if (recipientAddress) {
        await messageStore.suppressAndDelete(
          recipientAddress,
          [...digests] as string[],
          suppressions,
        )
      } else {
        for (const digest of digests) {
          await messageStore.deleteMessage(digest as string)
        }
      }
      for (const digest of digests) {
        delete this.messages[digest as string]
      }
      const allConvs = new Set<Conversation>()
      if (this.conversations) {
        for (const c of Object.values(this.conversations)) {
          if (c) allConvs.add(c)
        }
      }
      if (this.activeConversation) {
        allConvs.add(this.activeConversation)
      }
      for (const conv of allConvs) {
        if (conv?.messages) {
          const hasMatch = conv.messages.some(
            m =>
              digests.has(m.payloadDigest) ||
              (m.delivery?.attemptDigest &&
                digests.has(m.delivery.attemptDigest)) ||
              (m.messageHash && digests.has(m.messageHash)) ||
              Boolean((m as any).index && digests.has((m as any).index)),
          )
          if (hasMatch) {
            const remaining = conv.messages.filter(
              m =>
                !digests.has(m.payloadDigest) &&
                !(
                  m.delivery?.attemptDigest &&
                  digests.has(m.delivery.attemptDigest)
                ) &&
                !(m.messageHash && digests.has(m.messageHash)) &&
                !((m as any).index && digests.has((m as any).index)),
            )
            const kept = new Set(remaining)
            conv.removedRelayTime = Math.max(
              conv.removedRelayTime ?? 0,
              newestRelayTime(conv.messages.filter(m => !kept.has(m))),
            )
            conv.messages.splice(0, conv.messages.length, ...remaining)
            conv.messages = remaining
            recomputeChatAccounting(conv, this.activeConversationId)
          }
        }
      }
      if (message) {
        const logicalId = message.logicalMessageId || payloadDigest
        const logRecord = this.logicalMessages[logicalId]
        if (logRecord) {
          for (const rev of logRecord.revisions) {
            rev.deliveries = rev.deliveries.filter(
              d => !digests.has(d.deliveryDigest),
            )
          }
          logRecord.revisions = logRecord.revisions.filter(
            rev => rev.deliveries.length > 0,
          )
          if (logRecord.revisions.length === 0) {
            delete this.logicalMessages[logicalId]
          }
        }
      }
      if (message?.outbound) {
        const digestsToDiscard = new Set<string>()
        if (attemptDigest) digestsToDiscard.add(attemptDigest)
        if (message?.delivery?.attemptDigest) {
          digestsToDiscard.add(message.delivery.attemptDigest)
        }
        if (!payloadDigest.startsWith('pending:')) {
          digestsToDiscard.add(payloadDigest)
        }
        const wallet = explicitWallet || messagingWallet()
        if (wallet) {
          try {
            const orphans =
              await activeChain.directMessages?.unattributedAttempts?.({
                wallet,
                knownDigests: Object.keys(this.messages).filter(
                  k => !k.startsWith('pending:'),
                ),
              })
            if (orphans && orphans.length > 0) {
              for (const orphan of orphans) {
                digestsToDiscard.add(orphan)
              }
            }
          } catch {
            // ignore
          }
          for (const d of digestsToDiscard) {
            try {
              await activeChain.directMessages?.discardAttempt?.({
                wallet,
                payloadDigest: d,
              })
            } catch (err) {
              console.warn(
                'could not discard attempt during deleteMessage:',
                err,
              )
            }
          }
        }
      }
    },
    readAll(addressOrId: string) {
      let chat: Conversation | undefined
      if (this.conversations && addressOrId in this.conversations) {
        chat = this.conversations[addressOrId]
      } else {
        try {
          const displayAddress = toChainDisplayAddress(addressOrId)
          chat = this.chats[displayAddress]
        } catch {
          chat = undefined
        }
      }
      if (!chat) {
        // Opening a chat with nobody yet (no message either way) is normal, not an error.
        console.debug('readAll: no chat yet for', addressOrId)
        return
      }
      chat.lastRead = Math.max(
        newestRelayTime(chat.messages),
        chat.lastRead ?? 0,
      )
      chat.totalUnreadMessages = 0
      chat.totalUnreadValue = 0
      // The account's other devices show it read too.
      void this.noteConversationStates()
    },
    reset() {
      this.conversations = Object.fromEntries(
        Object.entries(this.conversations).map(([id, convData]) => {
          return [
            id,
            {
              ...convData,
              messages: [],
              totalUnreadMessages: 0,
              totalUnreadValue: 0,
              totalValue: 0,
            },
          ]
        }),
      )
      this.messages = {}
      this.logicalMessages = {}
      this.lastReceived = null
      this.activeConversationId = null
    },
    sendMessageLocal({
      address,
      conversationId,
      senderAddress,
      index: payloadDigest,
      items,
      outpoints = [],
      stampValueWei,
      stampPayments,
      status = 'pending',
      previousHash = null,
      timestamp = Date.now(),
      delivery,
      logicalMessageId,
      revisionDigest,
    }: {
      address: string
      conversationId?: string
      senderAddress: string
      index: string
      items: MessageItem[]
      outpoints: Utxo[]
      /** See this file's header decision note (ticket #42) -- additive Monad-side value,
       * alongside `outpoints`. `undefined` for Lotus-origin sends. */
      stampValueWei?: bigint
      stampPayments?: Array<{
        txHash: string
        destinationAddress: string
        valueWei: bigint
      }>
      status: string
      previousHash: string | null
      timestamp?: number
      delivery?: OutgoingDelivery
      logicalMessageId?: string
      revisionDigest?: string
    }) {
      let displayAddress: string = address
      try {
        displayAddress = toChainDisplayAddress(address)
      } catch {
        //
      }

      let conv = conversationId
        ? this.conversations[canonicalConversationId(conversationId)]
        : this.chats[displayAddress]
      if (conv) assertConversationPeer(conv, displayAddress)

      const newMsg = {
        outbound: true,
        status,
        items,
        serverTime: timestamp,
        receivedTime: timestamp,
        outpoints,
        stampValueWei,
        stampPayments,
        senderAddress,
        destinationAddress: displayAddress,
        localTime: true,
        messageHash: payloadDigest,
        delivery,
        conversationId: conv?.id || conversationId,
        logicalMessageId: logicalMessageId || payloadDigest,
        revisionDigest: revisionDigest || payloadDigest,
        deliveryDigest: payloadDigest,
      }
      assert(newMsg.outbound !== undefined, 'outbound is not defined')
      assert(newMsg.status !== undefined, 'status is not defined')
      assert(newMsg.receivedTime !== undefined, 'receivedTime is not defined')
      assert(newMsg.serverTime !== undefined, 'serverTime is not defined')
      assert(newMsg.items !== undefined, 'items is not defined')
      assert(newMsg.outpoints !== undefined, 'outpoints is not defined')
      assert(newMsg.senderAddress !== undefined, 'senderAddress is not defined')

      const message: ChatMessage = { payloadDigest: payloadDigest, ...newMsg }
      if (payloadDigest in this.messages) {
        const existingMessage = this.messages[payloadDigest]
        assert(existingMessage, 'For great typescript')
        // we have the message already, just need to update some fields and return
        this.messages[payloadDigest] = Object.assign(existingMessage, message)
        if (conv) {
          recomputeChatAccounting(conv, this.activeConversationId)
          recordLogicalMessage(this.logicalMessages, message, conv.id)
        }
        return
      }

      if (isInternalMessage(items)) {
        this.messages[payloadDigest] = message
        return
      }

      // Chat may be null if it is a self send
      if (!conv) {
        if (
          !conversationId &&
          sameCanonicalAddress(senderAddress, displayAddress)
        ) {
          // This was a self send, we don't want to update any particular chats.
          return
        }
        const emailItem = items?.find(it => it.type === 'email') as
          | EmailItem
          | undefined
        const trustedGateway = getTrustedEmailGatewayAddress()
        const isGateway = sameCanonicalAddress(displayAddress, trustedGateway)
        conv = conversationId
          ? this.createConversation({
              kind: emailItem ? 'email' : 'direct',
              participants: [senderAddress, displayAddress],
              conversationId,
              address: displayAddress,
              verifiedGateway: emailItem ? isGateway : undefined,
            })
          : this.openDirectConversation(displayAddress, [
              senderAddress,
              displayAddress,
            ])
      }

      message.conversationId = conv.id

      if (previousHash && previousHash in this.messages) {
        // Replace an optimistic/retried message with the newly keyed message. Monad cannot know
        // the final payload digest until its stamp payments have been submitted, so pending UI
        // entries use a local id and reconcile through this path once the real digest exists.
        const msgIndex = conv.messages.findIndex(
          msg => msg.payloadDigest === previousHash,
        )
        if (msgIndex >= 0) {
          conv.messages.splice(msgIndex, 1)
        }
        delete this.messages[previousHash]
      }

      this.messages[payloadDigest] = message
      conv.messages.push(message)
      const emailItem = message.items?.find(it => it.type === 'email') as
        | EmailItem
        | undefined
      if (emailItem) {
        conv.kind = 'email'
        if (!conv.name && emailItem.subject) {
          conv.name = emailItem.subject
        }
        const trustedGateway = getTrustedEmailGatewayAddress()
        conv.verifiedGateway =
          sameCanonicalAddress(displayAddress, trustedGateway) ||
          sameCanonicalAddress(conv.address, trustedGateway)
      }
      conv.lastReceived = Math.max(conv.lastReceived, timestamp)
      recomputeChatAccounting(conv, this.activeConversationId)
      recordLogicalMessage(this.logicalMessages, message, conv.id)
    },
    /**
     * Records a local self-message (such as swap transaction logs or saved notes)
     * addressed to the user's own canonical identity address.
     * Persists directly to the durable message store without requiring an external relay trip.
     */
    async selfSendMessage({
      items,
      type = 'system',
      meta,
    }: {
      items: MessageItem[]
      type?: string
      meta?: Record<string, any>
    }): Promise<string> {
      const internal = isInternalMessage(items)
      const canonicalSelf = await getOwnCanonicalAddress()
      if (!internal && (!canonicalSelf || !isChainAddress(canonicalSelf))) {
        throw new Error('Canonical self identity is required for a saved note')
      }
      const ownAddress = canonicalSelf || 'self'
      const conversation = internal
        ? undefined
        : this.openDirectConversation(ownAddress)
      const messageId =
        'msg-self-' +
        Date.now() +
        '-' +
        Math.random().toString(36).substring(2, 9)
      const timestamp = Date.now()

      // Handle typed swap records
      for (const item of items) {
        if (item && item.type === 'swap-record') {
          try {
            const { useSwapStore } = await import('./swaps')
            useSwapStore().handleSwapItem(item as SwapRecordItem)
          } catch (err) {
            console.warn('[chats] failed to handle swap record item:', err)
          }
        }
      }

      this.sendMessageLocal({
        address: ownAddress,
        conversationId: conversation?.id,
        senderAddress: ownAddress,
        index: messageId,
        items,
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
        timestamp,
      })

      try {
        await this.saveOutgoing(ownAddress, messageId, { strict: true })
      } catch (err) {
        console.warn('Failed to persist selfSendMessage to messageStore', err)
      }

      return messageId
    },

    /**
     * Sends a direct message like iMessage does (#269/#270): the message appears in the
     * conversation at once and is stored durably with its text; if the send fails it stays
     * visible, marked failed with the reason, and the user can Retry or Discard it, also after a
     * reload. A failure is therefore reported through the returned outcome and the message's
     * `status`, not by throwing. Only precondition errors (an invalid recipient) and a failure to
     * store an already delivered message throw.
     *
     * ## Never pay twice for one message
     *
     * Once a message's exact signed payment set exists, its payload hash is recorded on the
     * message (`delivery.attemptDigest`) before the set is first submitted. Every later attempt
     * for that message (background, automatic or manual) first asks the wallet what became of
     * that set (`directMessages.reconcileAttempts`): while it is `live` the identical bytes are
     * re-sent, which is free and idempotent. `dead` and `unknown` do not establish that the signed
     * transactions cannot land: retain the original association and reconcile it again later.
     * A retry nobody clicked (`retryOutgoing({ automatic: true })`) builds a first payment
     * only for a failed message cut off mid-send (`interrupted`) that has no recorded attempt,
     * after the wallet has shown that it holds no payment nobody points at.
     *
     * Each send or retry of a message holds a Web Lock on it for its whole run, shared by all
     * tabs of the profile; a tab that finds it held reports `busy` and leaves the message alone.
     */
    async sendMessage({
      wallet,
      address,
      conversationId,
      items,
      stampValue,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      conversationId?: string
      items: MessageItem[]
      stampValue?: bigint
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const recipient = activeChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const displayAddress = toChainDisplayAddress(address)

      const conv = conversationId
        ? this.conversations[canonicalConversationId(conversationId)] ??
          this.createConversation({
            participants: [wallet.identity.displayAddress, displayAddress],
            address: displayAddress,
            conversationId,
          })
        : this.openDirectConversation(displayAddress, [
            wallet.identity.displayAddress,
            displayAddress,
          ])
      assertConversationPeer(conv, displayAddress)
      if (conv.address === conv.id) conv.address = displayAddress

      const timestamp = Date.now()
      const pendingMessageId = nextPendingMessageId(timestamp)
      this.sendMessageLocal({
        address: displayAddress,
        conversationId: conv.id,
        senderAddress: wallet.identity.displayAddress,
        index: pendingMessageId,
        items,
        outpoints: [],
        stampValueWei: stampValue,
        status: 'pending',
        previousHash: null,
        timestamp,
        delivery: {},
      })
      // Enqueue the first durable save synchronously. Clear called after this composer action is
      // therefore ordered after the row, while the optimistic bubble remains visible immediately.
      // The message's lock is asked for first and the row is written only once it is held, so
      // another tab that loads the row always finds the send locked (see `runOutgoing`).
      const lock = acquireOutgoingLock(pendingMessageId)
      startingOutgoing.add(pendingMessageId)
      try {
        await serializeDeliveryMutation(async () => {
          await lock.held
          return this.saveOutgoingExclusive(displayAddress, pendingMessageId)
        })
        return await this.runOutgoing({
          wallet,
          address: displayAddress,
          id: pendingMessageId,
          manual: false,
          // A fresh id is never locked by anyone else; if the lock could not be had at all the
          // send takes it the ordinary way.
          lockHeld: await lock.held,
          onPreparationProgress,
        })
      } finally {
        startingOutgoing.delete(pendingMessageId)
        await lock.release()
      }
    },
    /** Retry of a failed outgoing message (`status: 'error'`): the user's Retry, or with
     * `automatic` a retry nobody clicked. See `sendMessage` for the no-double-payment rule this
     * follows. */
    async retryOutgoing({
      wallet,
      address,
      payloadDigest,
      confirmed = false,
      automatic = false,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      /** The message's key in the store (`ChatMessage.payloadDigest`). */
      payloadDigest: string
      /** Confirmation for unattributed/recovered drafts. Never replaces a recorded attempt. */
      confirmed?: boolean
      /** Nobody clicked: an earlier payment is only settled, and a payment is built only for a
       * message cut off mid-send (`interrupted`) that provably has none yet. */
      automatic?: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const message = this.messages[payloadDigest]
      if (
        !message ||
        !message.outbound ||
        message.status !== 'error' ||
        !walletOwnsMessage(wallet, message)
      ) {
        return { state: 'busy' }
      }
      return this.runOutgoing({
        wallet,
        address: toChainDisplayAddress(address),
        id: payloadDigest,
        manual: true,
        automatic,
        confirmed: confirmed && !automatic,
        onPreparationProgress,
      })
    },
    /**
     * Settles a failed outgoing message's recorded payment without the user: asks the wallet
     * what became of it and re-sends the same bytes while it is still live at the relay. It
     * never builds a new payment; a message with no recorded payment is left as it is.
     */
    async resumeOutgoing({
      wallet,
      address,
      payloadDigest,
    }: {
      wallet: WalletHandle
      address: string
      payloadDigest: string
    }): Promise<OutgoingOutcome> {
      const message = this.messages[payloadDigest]
      if (
        !message ||
        !message.outbound ||
        message.status !== 'error' ||
        !walletOwnsMessage(wallet, message)
      ) {
        return { state: 'busy' }
      }
      if (message.delivery?.attemptDigest === undefined) {
        return {
          state: 'failed',
          reason: message.delivery?.failureReason ?? 'error',
        }
      }
      return this.runOutgoing({
        wallet,
        address: toChainDisplayAddress(address),
        id: payloadDigest,
        manual: false,
      })
    },
    /** Best-effort durable write of one outgoing message's current state. */
    async saveOutgoing(
      address: string,
      id: string,
      { strict = false }: { strict?: boolean } = {},
    ) {
      return serializeDeliveryMutation(() =>
        this.saveOutgoingExclusive(address, id, { strict }),
      )
    },
    async saveOutgoingExclusive(
      address: string,
      id: string,
      { strict = false }: { strict?: boolean } = {},
    ) {
      const message = this.messages[id]
      if (!message) {
        // Strict callers are attributing a payment to this message: a vanished record means the
        // attribution cannot be durable, so that is a failure (the wallet rolls the attempt back).
        if (strict) throw new Error(`outgoing message ${id} no longer exists`)
        return
      }
      // `payloadDigest`/`messageHash` are in-memory bookkeeping, not part of the stored record.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { payloadDigest, messageHash, ...withLive } = message as Message & {
        payloadDigest?: string
        messageHash?: string
      }
      const persistable: Message = { ...withLive }
      if (withLive.delivery !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { live, ...durableDelivery } = withLive.delivery
        persistable.delivery = durableDelivery
      }
      try {
        await (
          await store
        ).saveMessage(
          {
            message: persistable,
            index: id,
            outbound: true,
            senderAddress: message.senderAddress,
            copartyAddress: address,
          },
          { advanceCursor: false },
        )
      } catch (err) {
        // Best effort, except where the caller must know the write is durable (a payment attempt
        // being attributed to this message): there the failure aborts the send.
        if (strict) throw err
        console.warn('could not persist outgoing message state', err)
      }
    },
    /** Updates an unconfirmed outgoing message's status and delivery details, and persists it. */
    async setOutgoingState(
      address: string,
      id: string,
      status: 'pending' | 'payment-pending' | 'error',
      delivery: OutgoingDelivery,
      options: { strict?: boolean } = {},
    ) {
      return serializeDeliveryMutation(() =>
        this.setOutgoingStateExclusive(address, id, status, delivery, options),
      )
    },
    async setOutgoingStateExclusive(
      address: string,
      id: string,
      status: 'pending' | 'payment-pending' | 'error',
      delivery: OutgoingDelivery,
      options: { strict?: boolean } = {},
    ) {
      const message = this.messages[id]
      if (!message) {
        if (options.strict) {
          throw new Error(`outgoing message ${id} no longer exists`)
        }
        return
      }
      const recordedDigest = message.delivery?.attemptDigest
      if (
        recordedDigest !== undefined &&
        delivery.attemptDigest !== undefined &&
        delivery.attemptDigest !== recordedDigest
      ) {
        throw new Error(`cannot replace recorded payment attempt for ${id}`)
      }
      await assertDurableAttemptAssociation(
        id,
        recordedDigest ?? delivery.attemptDigest,
        message,
        address,
      )
      message.status = status
      // Presentation changes cannot revoke an already attributed signed payment.
      message.delivery = {
        ...delivery,
        ...(recordedDigest === undefined
          ? {}
          : { attemptDigest: recordedDigest }),
      }
      await this.saveOutgoingExclusive(address, id, options)
    },
    /** The exact payment set of this message was delivered: re-key the local copy by its payload
     * hash (unless already so), persist it, and drop the local-id record. The UI is reconciled
     * before storage, because delivery is irreversible: a storage failure must not make a
     * delivered message look retryable. */
    async confirmOutgoing({
      address,
      id,
      payloadDigest,
      stampValueWei,
      stampPayments,
    }: {
      address: string
      id: string
      payloadDigest: string
      stampValueWei?: bigint
      stampPayments?: DirectMessageSendResult['stampPayments']
    }): Promise<void> {
      return serializeDeliveryMutation(() =>
        this.confirmOutgoingExclusive({
          address,
          id,
          payloadDigest,
          stampValueWei,
          stampPayments,
        }),
      )
    },
    async confirmOutgoingExclusive({
      address,
      id,
      payloadDigest,
      stampValueWei,
      stampPayments,
    }: {
      address: string
      id: string
      payloadDigest: string
      stampValueWei?: bigint
      stampPayments?: DirectMessageSendResult['stampPayments']
    }): Promise<void> {
      const message = this.messages[id]
      if (!message) return
      const recordedDigest = message.delivery?.attemptDigest
      if (recordedDigest !== undefined && recordedDigest !== payloadDigest) {
        throw new Error(`cannot confirm a different payment attempt for ${id}`)
      }
      await assertDurableAttemptAssociation(id, payloadDigest, message, address)
      const { items, senderAddress, serverTime } = message
      const value = stampValueWei ?? message.stampValueWei
      const payments = stampPayments ?? message.stampPayments
      const conversation = message.conversationId
        ? this.conversations[message.conversationId]
        : undefined
      if (!conversation)
        throw new Error(`Missing conversation owner for outgoing message ${id}`)
      assertConversationPeer(conversation, address)
      this.sendMessageLocal({
        address,
        conversationId: conversation.id,
        logicalMessageId: message.logicalMessageId,
        senderAddress,
        index: payloadDigest,
        items,
        outpoints: [],
        stampValueWei: value,
        stampPayments: payments,
        status: 'confirmed',
        previousHash: id,
        timestamp: serverTime,
        delivery: message.delivery,
        revisionDigest: message.revisionDigest,
      })
      recomputeChatAccounting(conversation, this.activeConversationId)
      const messageStore = await store
      await this.saveOutgoingExclusive(address, payloadDigest, { strict: true })
      if (id !== payloadDigest) {
        try {
          await messageStore.deleteMessage(id)
        } catch (err) {
          // Harmless: the confirmed record wins when the store is next loaded.
          console.warn('could not remove the local outgoing record', err)
        }
      }
    },
    /**
     * Brings this tab's copy of an outgoing message in line with its durable row, read after every
     * queued write of this tab. `gone`: the row no longer exists or is delivered (another tab
     * sent it, or it was discarded); the local copy is dropped. `changed`: the row's state differs
     * (another tab recorded a payment, or failed differently); the local copy now has the row's
     * state. `unreadable`: the store could not be read; nothing is changed. A store without point
     * reads (test doubles) is taken as `same`.
     */
    async refreshOutgoingFromStore(
      address: string,
      id: string,
    ): Promise<'same' | 'changed' | 'gone' | 'unreadable'> {
      return serializeDeliveryMutation(async () => {
        const messageStore = await store
        if (typeof messageStore?.getMessage !== 'function') return 'same'
        let row: MessageWrapper | undefined
        try {
          row = await messageStore.getMessage(id)
        } catch (error) {
          console.warn('could not read the stored outgoing message', error)
          return 'unreadable'
        }
        const message = this.messages[id]
        if (!message) return 'gone'
        if (row && !matchesOutgoingOwner(row, message, address)) {
          console.warn(
            'conflicting conversation ownership for outgoing message',
            id,
          )
          return 'unreadable'
        }
        const stored = row?.message
        const storedDigest = stored?.delivery?.attemptDigest
        const localDigest = message.delivery?.attemptDigest
        if (
          storedDigest !== undefined &&
          localDigest !== undefined &&
          storedDigest !== localDigest
        ) {
          console.warn(
            'conflicting payment attempt ownership for outgoing message',
            id,
          )
          return 'unreadable'
        }
        if (!stored || stored.status === 'confirmed') {
          delete this.messages[id]
          for (const c of Object.values(this.conversations ?? {})) {
            if (c?.messages?.some(m => m.payloadDigest === id)) {
              c.messages = c.messages.filter(m => m.payloadDigest !== id)
              recomputeChatAccounting(c, this.activeConversationId)
            }
          }
          if (
            this.activeConversation?.messages?.some(m => m.payloadDigest === id)
          ) {
            this.activeConversation.messages =
              this.activeConversation.messages.filter(
                m => m.payloadDigest !== id,
              )
            recomputeChatAccounting(
              this.activeConversation,
              this.activeConversationId,
            )
          }
          return 'gone'
        }
        // A payment recorded here but not on disk (its write failed) is never forgotten, and a row
        // still 'pending' without a payment only says a send was started, which this copy knows.
        if (storedDigest === undefined) {
          if (localDigest !== undefined || stored.status === 'pending')
            return 'same'
        } else if (storedDigest === localDigest) return 'same'
        // The same reading of a stored row as on load: a send that is not running any more is
        // pending with a recorded payment.
        const status =
          stored.status === 'pending' ? 'payment-pending' : stored.status
        const delivery: OutgoingDelivery = { ...stored.delivery }
        if (
          status === message.status &&
          storedDigest === localDigest &&
          delivery.failureReason === message.delivery?.failureReason
        )
          return 'same'
        message.status = status
        message.delivery = delivery
        return 'changed'
      })
    },
    /** Applies what the wallet knows about a message's earlier payment attempt. */
    async applyAttemptStatus({
      address,
      id,
      status,
    }: {
      address: string
      id: string
      status: DirectMessageAttemptStatus
    }): Promise<'sent' | 'live' | 'dead' | 'unknown'> {
      const message = this.messages[id]
      const digest = message?.delivery?.attemptDigest
      if (!message || digest === undefined) return 'dead'
      if (status === 'delivered') {
        await this.confirmOutgoing({ address, id, payloadDigest: digest })
        return 'sent'
      }
      if (
        status === 'live' &&
        (message.status !== 'payment-pending' || !message.delivery?.live)
      ) {
        await this.setOutgoingState(address, id, 'payment-pending', {
          attemptDigest: digest,
          live: true,
        })
      }
      return status
    },
    async runOutgoing({
      wallet,
      address,
      id,
      manual,
      automatic = false,
      confirmed = false,
      lockHeld = false,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      /** A retry nobody clicked (see `retryOutgoing`): it may only build a message's first payment. */
      automatic?: boolean
      confirmed?: boolean
      /** The caller already holds this message's lock (see `sendMessage`). */
      lockHeld?: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const message = this.messages[id]
      if (
        inflightOutgoing.has(id) ||
        !message ||
        !walletOwnsMessage(wallet, message)
      ) {
        return { state: 'busy' }
      }
      inflightOutgoing.add(id)
      let recoveredOthers = false
      try {
        // Another tab of this profile may be sending this very message (its row is saved before
        // the send starts, and this tab's copy may call it interrupted). Its lock is held for the
        // whole send: then this tab leaves the message as it is and pays nothing.
        const run = () =>
          this.runOutgoingExclusive({
            wallet,
            address,
            id,
            manual,
            automatic: automatic && manual,
            confirmed: confirmed && !automatic,
            onPreparationProgress,
          })
        const locked = lockHeld
          ? { result: await run() }
          : await withOutgoingLock(id, run)
        if (!locked) return { state: 'busy' }
        const outcome = locked.result
        recoveredOthers =
          outcome.state === 'failed' && outcome.reason === 'recovered'
        if (outcome.state === 'sent') {
          const allChats = [...Object.values(this.conversations ?? {})]
          const hasQueued = allChats.some(chat =>
            chat?.messages?.some(
              m =>
                m.outbound &&
                m.payloadDigest !== id &&
                m.status === 'payment-pending' &&
                m.delivery?.attemptDigest === undefined &&
                walletOwnsMessage(wallet, m),
            ),
          )
          if (hasQueued) void this.reconcileOutgoing({ wallet })
        }
        return outcome
      } finally {
        inflightOutgoing.delete(id)
        // Another attempt was just recovered: settle its message now instead of at the next tick.
        if (recoveredOthers) void this.reconcileOutgoing({ wallet })
      }
    },
    async runOutgoingExclusive({
      wallet,
      address,
      id,
      manual,
      automatic,
      confirmed,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      automatic: boolean
      confirmed: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      // A Retry (clicked or automatic) acts on this tab's copy of the message, which can be stale:
      // another tab may have sent it (and removed its row) or recorded a payment for it since
      // this tab loaded. Read the durable row first, under the lock, and never act on an old copy.
      if (manual) {
        const fresh = await this.refreshOutgoingFromStore(address, id)
        if (fresh === 'gone' || fresh === 'unreadable') return { state: 'busy' }
        if (
          fresh === 'changed' &&
          this.messages[id]?.delivery?.attemptDigest === undefined
        )
          return { state: 'busy' }
        // 'changed' with a recorded payment now: go on, and settle that payment below.
      }
      const message = this.messages[id]
      // Read again under the lock: the message may have changed while it was awaited.
      if (!message || !walletOwnsMessage(wallet, message))
        return { state: 'busy' }
      if (automatic && (!message.outbound || message.status !== 'error'))
        return { state: 'busy' }
      const recipient = activeChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const previous = message.delivery
      const digest = previous?.attemptDigest
      const stillCurrent = () =>
        this.messages[id] === message && walletOwnsMessage(wallet, message)

      // 1. An earlier payment attempt exists: ask what became of it BEFORE anything else.
      if (digest !== undefined) {
        let statuses: Record<string, DirectMessageAttemptStatus>
        try {
          statuses = await activeChain.directMessages.reconcileAttempts({
            wallet,
            payloadDigests: [digest],
            maxPutAttempts: manual ? 3 : 1,
          })
        } catch (error) {
          // Cannot tell. Keep the attempt on the message; never guess in favour of a new payment.
          console.warn('could not reconcile the earlier payment attempt', error)
          if (manual) {
            await this.setOutgoingState(address, id, 'error', {
              attemptDigest: digest,
              failureReason: 'error',
              detail: errorDetail(error),
            })
            return { state: 'failed', reason: 'error' }
          }
          return { state: 'payment-pending' }
        }
        if (!stillCurrent()) return { state: 'busy' }
        const status = statuses[digest] ?? 'unknown'
        const applied = await this.applyAttemptStatus({ address, id, status })
        if (applied === 'sent') {
          const confirmed = this.messages[digest]
          return confirmed && walletOwnsMessage(wallet, confirmed)
            ? { state: 'sent', payloadDigest: digest }
            : { state: 'busy' }
        }
        if (!stillCurrent()) return { state: 'busy' }
        if (applied === 'live') return { state: 'payment-pending' }
        // A relay terminal status or an exhausted local attempt is not financial nonexecution
        // proof. Even a confirmed Retry must settle the original authorized payment.
        const failureReason = applied === 'dead' ? 'rejected' : 'unverified'
        await this.setOutgoingState(address, id, 'error', {
          attemptDigest: digest,
          failureReason,
          detail: previous?.detail,
        })
        return { state: 'failed', reason: failureReason }
      } else if (automatic && previous?.failureReason !== 'interrupted') {
        // No attempt recorded and not cut off mid-send: an earlier payment for it was given up
        // (dead) or the send failed for a reason the user must see. Only a click sends it again.
        return { state: 'failed', reason: previous?.failureReason ?? 'error' }
      } else if (
        manual &&
        !confirmed &&
        previous?.failureReason === 'recovered'
      ) {
        return { state: 'needs-confirmation', reason: 'recovered' }
      } else if (manual && previous?.failureReason === 'interrupted') {
        // No attempt is recorded on this message, but the app stopped mid-send: the wallet may
        // hold (or already have resumed) a payment nobody points at. Do not pay again unless
        // there is provably none, or the user says so.
        const known = new Set<string>()
        for (const [key, other] of Object.entries(this.messages)) {
          if (other && !key.startsWith('pending:')) known.add(key)
          const attempt = other?.delivery?.attemptDigest
          if (attempt !== undefined) known.add(attempt)
        }
        let orphans: string[] | undefined
        try {
          orphans = await activeChain.directMessages.unattributedAttempts({
            wallet,
            knownDigests: [...known],
          })
        } catch (error) {
          console.warn('could not check for an unattributed payment', error)
        }
        if (!confirmed && (orphans === undefined || orphans.length > 0)) {
          // Leave the message 'interrupted': every unconfirmed Retry must hit this check again,
          // in this session and after a reload. Only the user's answer below ends that.
          return { state: 'needs-confirmation', reason: 'unverified' }
        }
        if (orphans !== undefined && orphans.length > 0) {
          // The user chose to pay again. Save that answer for the payments it was about, so they
          // stop blocking later retries. If it cannot be saved, the wallet keeps reporting them
          // and the next interrupted message asks again; that never pays without a prompt.
          try {
            await activeChain.directMessages.resolveUnattributedAttempts({
              wallet,
              payloadDigests: orphans,
            })
          } catch (error) {
            console.warn(
              'could not save the answer for an unattributed payment',
              error,
            )
          }
          if (!stillCurrent()) return { state: 'busy' }
        }
      }

      // 2. Build and send a new payment set.
      if (!stillCurrent()) return { state: 'busy' }
      // The user's own Retry of a message that failed because the fee had risen above its
      // stamp: the failure said so, and the retry is sent at the wallet's minimum now. Never
      // on an automatic retry.
      if (
        manual &&
        !automatic &&
        message.delivery?.failureReason === 'stamp-below-fee' &&
        message.stampValueWei !== undefined
      ) {
        const minimum = await activeChain.directMessages
          .minimumStamp?.({ wallet })
          .catch(() => undefined)
        if (minimum !== undefined && minimum > message.stampValueWei)
          message.stampValueWei = minimum
      }
      await this.setOutgoingState(address, id, 'pending', {})
      if (!stillCurrent()) return { state: 'busy' }
      let ownDigest: string | undefined
      let result: DirectMessageSendResult | undefined
      let lastSendError: unknown
      const maxSendAttempts = 3

      for (let sendAttempt = 1; sendAttempt <= maxSendAttempts; sendAttempt++) {
        if (!stillCurrent()) return { state: 'busy' }
        const cancellable = cancellableSend(id)
        try {
          // The subject rides only on the first message of a conversation that has one and on
          // the first message after a rename; ordinary messages omit it.
          const subject = subjectToCarry(
            message.conversationId === undefined
              ? undefined
              : this.conversations[message.conversationId],
          )
          result = await activeChain.directMessages.send({
            wallet,
            recipient,
            // One ID for this message, whatever attempt this is: the wallet makes one payment
            // per ID, ever, and answers a repeat with the attempt it already holds.
            messageId: outgoingMessageId(id),
            conversationId: message.conversationId,
            ...(subject === undefined ? {} : { conversationName: subject }),
            items: message.items,
            ...(message.stampValueWei === undefined
              ? {}
              : { stampValue: message.stampValueWei }),
            // Deleting the bubble while its send still waits cancels the send: nothing was
            // signed for it.
            signal: cancellable.signal,
            onPreparationProgress: progress => {
              // Its payment waits for the previous one to be mined, or the chain cannot be
              // reached and the send is queued: the bubble says which.
              if (progress.stage === 'waiting-for-payment') {
                sendsWaitingForPreviousPayment.add(id)
                if (progress.blocksRemaining === undefined)
                  sendsWaitingBlocks.delete(id)
                else sendsWaitingBlocks.set(id, progress.blocksRemaining)
              }
              if (progress.stage === 'waiting-for-chain')
                sendsWaitingForChain.add(id)
              onPreparationProgress?.(progress)
            },
            onAttemptCreated: async attemptDigest => {
              sendsWaitingBlocks.delete(id)
              sendsWaitingForPreviousPayment.delete(id)
              sendsWaitingForChain.delete(id)
              ownDigest = attemptDigest
              // Strict: this write must be durable before the relay sees any byte of the set.
              // If it fails, the send stops before any relay request. The wallet does NOT roll the
              // attempt back: its payment intent stays journaled, later sends wait behind it, and
              // reconciliation finishes and delivers those same bytes. `ownDigest` is therefore
              // kept on the message by the failure path below whenever that later write succeeds.
              await this.setOutgoingState(
                address,
                id,
                'pending',
                { attemptDigest },
                { strict: true },
              )
            },
          })
          if (subject !== undefined && message.conversationId !== undefined) {
            const carriedIn = this.conversations[message.conversationId]
            if (carriedIn) carriedIn.nameOnWire = subject
          }
          break
        } catch (error) {
          lastSendError = error
          cancellable.done()
          if (
            error instanceof DirectMessageAlreadyAttemptedError ||
            (error instanceof Error &&
              error.name === 'DirectMessageAlreadyAttemptedError')
          ) {
            // The wallet already holds this message's one attempt (this row had not learned
            // its digest: the app stopped between the wallet's record and this row's). Nothing
            // new was paid or sent. The row now points at that attempt and the reconciliation
            // finishes it with the same bytes.
            const attemptDigest = (error as DirectMessageAlreadyAttemptedError)
              .payloadDigest
            endWaitingSend(id)
            await this.setOutgoingState(address, id, 'payment-pending', {
              attemptDigest,
            })
            return { state: 'payment-pending' }
          }
          if (error instanceof MonadStampPendingAttemptError) {
            // Own payment set journaled but not yet confirmed: keep it, keep re-sending the same
            // bytes. Without an own set, an earlier attempt is still pending and this message has
            // not been paid for yet; it is sent once that clears.
            console.info('[sendDirectMessage pending]:', error)
            await this.setOutgoingState(
              address,
              id,
              'payment-pending',
              ownDigest === undefined
                ? {}
                : { attemptDigest: ownDigest, live: true },
            )
            return { state: 'payment-pending' }
          }

          const errorStr =
            String(error) +
            (error instanceof Error ? ' ' + error.message : '') +
            (typeof error === 'object' && error !== null && 'info' in error
              ? ' ' + JSON.stringify((error as any).info)
              : '')
          const isTransientRpc =
            errorStr.includes('502') ||
            errorStr.includes('503') ||
            errorStr.includes('504') ||
            errorStr.includes('429') ||
            errorStr.includes('SERVER_ERROR') ||
            errorStr.includes('TIMEOUT') ||
            errorStr.includes('invalid_rpc_upstream_response') ||
            errorStr.includes('rpc_upstream_unavailable') ||
            errorStr.includes('network') ||
            errorStr.includes('failed to fetch') ||
            errorStr.includes('Failed to fetch')

          if (
            isTransientRpc &&
            ownDigest === undefined &&
            sendAttempt < maxSendAttempts &&
            stillCurrent()
          ) {
            console.warn(
              `[sendDirectMessage transient rpc error (attempt ${sendAttempt}/${maxSendAttempts})]:`,
              error,
            )
            await new Promise(r => setTimeout(r, sendAttempt * 500))
            continue
          }

          console.error('[sendDirectMessage error]:', error)
          // The wallet released the payment this message carried (nothing of it was ever
          // sent): the saved message must not keep a sendable copy of its signed transfer. The
          // row is saved by the state change just below.
          if (error instanceof ContactPaymentReleasedError && this.messages[id])
            stripReleasedPayments(this.messages[id])
          const failure = classifySendFailure(error, ownDigest)
          await this.setOutgoingState(address, id, 'error', {
            ...(failure.keepDigest === undefined
              ? {}
              : { attemptDigest: failure.keepDigest }),
            failureReason: failure.reason,
            detail: errorDetail(error),
          })
          return { state: 'failed', reason: failure.reason }
        }
      }

      endWaitingSend(id)
      if (!result) {
        const failure = classifySendFailure(lastSendError, ownDigest)
        await this.setOutgoingState(address, id, 'error', {
          ...(failure.keepDigest === undefined
            ? {}
            : { attemptDigest: failure.keepDigest }),
          failureReason: failure.reason,
          detail: errorDetail(lastSendError),
        })
        return { state: 'failed', reason: failure.reason }
      }

      await this.confirmOutgoing({
        address,
        id,
        payloadDigest: result.payloadDigest,
        stampValueWei: result.stampValueWei,
        stampPayments: result.stampPayments,
      })
      return { state: 'sent', payloadDigest: result.payloadDigest }
    },
    /**
     * A message found "sending" with no recorded attempt and nobody sending it: its send was cut
     * off (the page was reloaded or closed). The wallet is asked, by the message's ID, what it
     * stored for it:
     * - a paid attempt: the complete signed message is in the wallet. The row is pointed at it
     *   and it is finished with those same bytes (`reconcileOutgoing`), never a new payment;
     * - the kept envelope of a free message: the same bytes are sent again;
     * - nothing: nothing of it was signed or handed out. Only then is it shown as interrupted;
     *   a Retry sends it under the same ID, so it cannot be paid for twice either.
     * When the wallet cannot be asked the message is left as it is and asked about again.
     * Holds the message's lock: a tab that is still sending it is left alone.
     */
    async resumeCutOffOutgoing({
      wallet,
      address,
      id,
    }: {
      wallet: WalletHandle
      address: string
      id: string
    }): Promise<void> {
      if (inflightOutgoing.has(id) || startingOutgoing.has(id)) return
      inflightOutgoing.add(id)
      try {
        await withOutgoingLock(id, async () => {
          const fresh = await this.refreshOutgoingFromStore(address, id)
          const message = this.messages[id]
          if (
            fresh === 'gone' ||
            fresh === 'unreadable' ||
            !message ||
            !message.outbound ||
            message.status !== 'pending' ||
            message.delivery?.attemptDigest !== undefined ||
            !walletOwnsMessage(wallet, message)
          )
            return
          let held: { payloadDigest: string; paid: boolean } | undefined
          try {
            held = await activeChain.directMessages.attemptOf?.({
              wallet,
              messageId: outgoingMessageId(id),
            })
          } catch (error) {
            console.warn('could not ask the wallet about a cut-off send', error)
            return
          }
          if (this.messages[id] !== message) return
          if (held?.paid) {
            await this.setOutgoingState(address, id, 'payment-pending', {
              attemptDigest: held.payloadDigest,
            })
          } else if (held) {
            // A free message the relay may or may not hold: the same envelope goes again.
            await this.runOutgoingExclusive({
              wallet,
              address: toChainDisplayAddress(address),
              id,
              manual: false,
              automatic: false,
              confirmed: false,
            })
          } else {
            await this.setOutgoingState(address, id, 'error', {
              failureReason: 'interrupted',
            })
          }
        })
      } catch (error) {
        console.warn('could not resume a cut-off send', error)
      } finally {
        inflightOutgoing.delete(id)
      }
    },
    /**
     * Background settling of messages whose payment is pending: re-sends the SAME bytes of each
     * live attempt (through `reconcileAttempts`, never building a payment) and flips a message to
     * sent when it finally delivers. Messages that were only waiting behind another pending
     * attempt (no payment of their own yet) are sent now. Returns how many are still pending.
     * Call it on a backoff timer (see `startOutgoingReconciliation`).
     */
    async reconcileOutgoing({
      wallet,
    }: {
      wallet: WalletHandle
    }): Promise<{ pending: number }> {
      const waiting: Array<{ address: string; id: string; digest?: string }> =
        []
      const seenChats = new Set<ChatState>()
      const allChats = [...Object.entries(this.conversations ?? {})]
      // First: messages whose send was cut off (a reload) and whose row has no attempt. The
      // wallet says what it stored for each; what it stored joins the settling below.
      const cutOffSeen = new Set<ChatState>()
      for (const [key, chat] of allChats) {
        if (!chat || cutOffSeen.has(chat)) continue
        cutOffSeen.add(chat)
        for (const message of [...(chat.messages ?? [])]) {
          if (
            !message.outbound ||
            message.status !== 'pending' ||
            message.delivery?.attemptDigest !== undefined ||
            !walletOwnsMessage(wallet, message) ||
            inflightOutgoing.has(message.payloadDigest) ||
            startingOutgoing.has(message.payloadDigest)
          )
            continue
          const address =
            (isChainAddress(chat.address) ? chat.address : undefined) ||
            message.destinationAddress ||
            (activeChain.parseAddress(key) ? key : '')
          if (!address) continue
          await this.resumeCutOffOutgoing({
            wallet,
            address,
            id: message.payloadDigest,
          })
        }
      }
      for (const [key, chat] of allChats) {
        if (!chat || seenChats.has(chat)) continue
        seenChats.add(chat)
        for (const message of chat.messages ?? []) {
          if (
            message.outbound &&
            (message.status === 'payment-pending' ||
              (message.status === 'error' &&
                message.delivery?.attemptDigest !== undefined)) &&
            walletOwnsMessage(wallet, message) &&
            !inflightOutgoing.has(message.payloadDigest)
          ) {
            const address =
              (isChainAddress(chat.address) ? chat.address : undefined) ||
              message.destinationAddress ||
              (activeChain.parseAddress(key) ? key : '')
            if (!address) continue
            waiting.push({
              address,
              id: message.payloadDigest,
              digest: message.delivery?.attemptDigest,
            })
          }
        }
      }
      const withAttempt: typeof waiting = []
      for (const entry of waiting.filter(entry => entry.digest !== undefined)) {
        const fresh = await this.refreshOutgoingFromStore(
          entry.address,
          entry.id,
        )
        const current = this.messages[entry.id]
        if (
          fresh === 'gone' ||
          fresh === 'unreadable' ||
          !current ||
          current.delivery?.attemptDigest !== entry.digest ||
          !walletOwnsMessage(wallet, current)
        ) {
          continue
        }
        withAttempt.push(entry)
      }
      if (withAttempt.length > 0) {
        try {
          const statuses = await activeChain.directMessages.reconcileAttempts({
            wallet,
            payloadDigests: withAttempt.map(entry => entry.digest as string),
            maxPutAttempts: 1,
          })
          for (const entry of withAttempt) {
            const applied = await this.applyAttemptStatus({
              address: entry.address,
              id: entry.id,
              status: statuses[entry.digest as string] ?? 'unknown',
            })
            if (applied === 'dead' || applied === 'unknown') {
              await this.setOutgoingState(entry.address, entry.id, 'error', {
                attemptDigest: entry.digest,
                failureReason: applied === 'dead' ? 'rejected' : 'unverified',
              })
            }
          }
        } catch (error) {
          console.warn('could not reconcile pending payment attempts', error)
        }
      }
      for (const entry of waiting.filter(entry => entry.digest === undefined)) {
        await this.runOutgoing({
          wallet,
          address: entry.address,
          id: entry.id,
          manual: false,
        })
      }
      let pending = 0
      const countedChats = new Set<ChatState>()
      const allChatValues = [...Object.values(this.conversations ?? {})]
      for (const chat of allChatValues) {
        if (!chat || countedChats.has(chat)) continue
        countedChats.add(chat)
        pending +=
          chat.messages?.filter(
            message =>
              message.outbound &&
              message.status === 'payment-pending' &&
              walletOwnsMessage(wallet, message),
          ).length ?? 0
      }
      return { pending }
    },
    async clearChat(address: string): Promise<void> {
      let displayAddress: string = address
      try {
        displayAddress = toChainDisplayAddress(address)
      } catch {
        //
      }
      return serializeDeliveryMutation(() =>
        this.clearChatExclusive(displayAddress),
      )
    },
    /** The conversation stored under an address or a conversation ID, if any. */
    conversationToClear(address: string): Conversation | undefined {
      if (this.conversations && address in this.conversations)
        return this.conversations[address]
      try {
        return this.chats[toChainDisplayAddress(address)]
      } catch {
        return this.chats[address]
      }
    },
    /** Tombstones, inside the mutation queue, every message the conversation holds now. Like
     * deleting one message, it asks the wallet nothing and moves no money. */
    async clearChatExclusive(address: string): Promise<void> {
      const chat = this.conversationToClear(address)
      if (!chat) return
      // This is Clear's atomic cutoff: everything in the conversation now goes. Composer sends
      // invoked while the durable deletes are in flight may appear optimistically, but are
      // queued after this mutation and must survive.
      await this.tombstoneMessagesExclusive(chat, [...chat.messages])
    },
    /** Tombstones these messages of `chat`, inside the mutation queue. */
    async tombstoneMessagesExclusive(
      chat: Conversation,
      clearingMessages: ChatMessage[],
    ): Promise<void> {
      if (clearingMessages.length === 0) return
      const messageStore = await store
      const groups = new Map<
        string,
        { digests: Set<string>; suppressions: RelayDeliverySuppression[] }
      >()
      const unscopedDigests = new Set<string>()
      for (const message of clearingMessages) {
        // Whichever way the message went, its row is read from this account's own mailbox.
        const recipientAddress = tombstoneMailbox(message)
        const digests = [
          message.payloadDigest,
          message.delivery?.attemptDigest,
        ].filter((digest): digest is string => digest !== undefined)
        if (!recipientAddress) {
          digests.forEach(digest => unscopedDigests.add(digest))
          continue
        }
        const group = groups.get(recipientAddress) ?? {
          digests: new Set<string>(),
          suppressions: [],
        }
        digests.forEach(digest => group.digests.add(digest))
        if (message.delivery?.attemptDigest) {
          group.suppressions.push({
            payloadDigest: message.delivery.attemptDigest,
          })
        }
        if (!message.payloadDigest.startsWith('pending:')) {
          const receivedTime = tombstoneReceiptTime(message)
          group.suppressions.push({
            payloadDigest: message.payloadDigest,
            ...(receivedTime === undefined ? {} : { receivedTime }),
          })
        }
        groups.set(recipientAddress, group)
      }
      for (const [recipientAddress, group] of groups) {
        await messageStore.suppressAndDelete(
          recipientAddress,
          [...group.digests],
          group.suppressions,
        )
      }
      for (const digest of unscopedDigests) {
        await messageStore.deleteMessage(digest)
      }
      chat.removedRelayTime = Math.max(
        chat.removedRelayTime ?? 0,
        newestRelayTime(clearingMessages),
      )
      const clearedPayloads = new Set<string>()
      for (const message of clearingMessages) {
        clearedPayloads.add(message.payloadDigest)
        // A cleared message no longer holds its ID, as after a reload.
        const logicalId = message.logicalMessageId || message.payloadDigest
        if (this.logicalMessages[logicalId]?.conversationId === chat.id)
          delete this.logicalMessages[logicalId]
        delete this.messages[message.payloadDigest]
        const attempt = message.delivery?.attemptDigest
        if (attempt) delete this.messages[attempt]
      }
      chat.messages = chat.messages.filter(
        message => !clearedPayloads.has(message.payloadDigest),
      )
      recomputeChatAccounting(chat, this.activeConversationId)
    },
    openDirectConversation(
      address: string,
      participants: string[] = [address],
    ): Conversation {
      const conv = openDefaultConversation(
        this.conversations,
        address,
        participants,
      )
      return this.conversations[conv.id]
    },
    createConversation({
      kind = 'direct',
      name,
      topic,
      emailRecipient,
      participants,
      conversationId,
      initialRole = 'member',
      address,
      verifiedGateway,
    }: {
      kind?: ConversationKind
      name?: string
      topic?: string
      emailRecipient?: string
      participants: string[]
      conversationId?: string
      initialRole?: ConversationRole
      address?: string
      verifiedGateway?: boolean
    }): Conversation {
      const id = conversationId
        ? canonicalConversationId(conversationId)
        : freshConversationId()
      const peer = address || (participants.length === 1 ? participants[0] : id)
      const existing = this.conversations[id]
      if (existing) {
        assertConversationPeer(existing, peer)
        if (
          makeParticipantsKey(existing.participants) !==
          makeParticipantsKey(participants)
        ) {
          throw new Error(`Conversation ${id} has different participants`)
        }
        return existing
      }
      const conv = newConversation({
        id,
        kind,
        name,
        topic,
        emailRecipient,
        participants,
        address: peer,
        verifiedGateway,
      })
      for (const member of Object.values(conv.members ?? {}))
        member.role = initialRole
      this.conversations[id] = conv
      // A conversation the user created with a subject: the account's other devices learn
      // of it, and of its subject, now, and not only once a message is sent in it.
      if (kind === 'direct' && usableSubject(name) !== undefined) {
        this.conversations[id].nameSetAt = Date.now()
        this.conversations[id].subjectToNote = true
        this.conversations[id].actedBy = accountTag()
        void this.noteConversationStates()
      }
      return this.conversations[id]
    },
    renameConversation(id: string, subject: string): void {
      // A thread dropped while its subject was being edited: the one that replaced it.
      const conversation = resolveConversation(this.conversations, id)
      if (!conversation) throw new Error(`Unknown conversation ${id}`)
      // Reject invalid nonempty subjects before mutating: every device keeps the same previous
      // subject. A blank one intentionally removes it.
      const normalized = usableSubject(subject)
      if (subject.trim() && normalized === undefined)
        throw new Error('Invalid conversation subject')
      conversation.name = normalized
      conversation.updatedAt = Date.now()
      // The user's subject is the newest one this device knows of, and the account's other
      // devices are told. (The peer is told by the next message, which carries it.)
      conversation.nameSetAt = Math.max(
        Date.now(),
        (conversation.nameSetAt ?? 0) + 1,
      )
      conversation.subjectToNote = true
      conversation.actedBy = accountTag()
      void this.noteConversationStates()
    },
    createEmailConversation({
      recipientEmail,
      subject,
      gatewayAddress = defaultEmailGatewayAddress,
    }: {
      recipientEmail: string
      subject?: string
      gatewayAddress?: string
    }): Conversation {
      const normalizedEmail = recipientEmail.toLowerCase().trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('Invalid email recipient')
      }
      const canonicalGateway = toChainDisplayAddress(gatewayAddress)
      return this.createConversation({
        kind: 'email',
        name: subject?.trim() || undefined,
        emailRecipient: normalizedEmail,
        address: canonicalGateway,
        participants: [canonicalGateway],
        verifiedGateway: true,
      })
    },
    async deleteChat(addressOrId: string) {
      const conversation =
        this.conversations[addressOrId] ??
        this.chats[safeChainDisplayAddress(addressOrId) || addressOrId]
      if (conversation) await this.deleteConversation(conversation.id)
    },
    /**
     * Deletes a conversation's relay-timed history. Untimed own sends stay visible until their
     * relay echo, so every frontend applies the same cutoff to them.
     *
     * The deletion is timed by the RELAY's clock, never this device's: it reaches exactly as
     * far as the newest removed message the relay has timed, including history removed earlier
     * on this device by Clear or message deletion. So it covers what the user
     * saw and nothing else: a message the relay times later, on any device, is newer than the
     * deletion and brings the conversation back, however wrong this device's clock is. (The
     * relay hands a mailbox over in the order of its times, so a message this device has not
     * seen yet is newer than every one it has.)
     *
     * An empty conversation is deleted "up to" its retained removal boundary, where it was
     * already cleared, or time 1 when it held no relay history. The next newer message brings
     * it back.
     */
    async deleteConversation(conversationId: string) {
      if (!this.conversations[conversationId]) return
      return serializeDeliveryMutation(async () => {
        const conv = this.conversations[conversationId]
        if (!conv) return
        const deletedAt = Math.max(
          newestRelayTime(conv.messages),
          conv.removedRelayTime ?? 0,
          clearedUpTo(conv) ?? 0,
          1,
        )
        // Apply the same boundary as the account's other devices. A send the relay has not
        // timed remains visible and can reopen the conversation identically when echoed.
        await this.applyClearedBeforeExclusive(conv, deletedAt)
        if (conv.messages.length === 0) conv.deletedAt = deletedAt
        conv.actedBy = accountTag()
        if (this.activeConversationId === conversationId)
          this.activeConversationId = null
        // The account's other devices, and one restored later, delete it too.
        void this.noteConversationStates()
      })
    },
    /**
     * Applies, inside the mutation queue, what a note this account wrote to itself says about
     * one conversation. Applying a note again changes nothing, and notes may be applied in any
     * order, before or after the messages they are about.
     */
    async applyConversationStateExclusive(
      note: ConversationStateItem,
      ownAddress: string | null,
    ): Promise<void> {
      let peer: string
      let id: string
      try {
        peer = toChainDisplayAddress(note.peer)
        id = canonicalConversationId(note.conversationId)
      } catch {
        console.warn('conversation note: not a conversation of one peer', note)
        return
      }
      let conv = this.conversations[id]
      if (conv && !sameCanonicalAddress(conv.address, peer)) {
        console.warn(`conversation note: ${id} is with another peer; ignored`)
        return
      }
      if (!conv) {
        // A conversation this device has not seen yet: the fact is recorded for it, and its
        // messages are judged by it when they arrive.
        this.conversations[id] = newConversation({
          id,
          address: peer,
          participants: ownAddress ? [ownAddress, peer] : [peer],
        })
        conv = this.conversations[id]
      }
      if (note.clearedBefore !== undefined)
        await this.applyClearedBeforeExclusive(conv, note.clearedBefore)
      // The subject set on another device: the later one wins (`subjectReplaces`). An email
      // thread's subject is the email's, and a group's is not one person's to set.
      if (
        note.subject !== undefined &&
        note.subjectSetAt !== undefined &&
        conv.kind === 'direct'
      ) {
        const subject =
          note.subject === '' ? undefined : usableSubject(note.subject)
        if (
          (note.subject === '' || subject !== undefined) &&
          subjectReplaces(conv, subject, note.subjectSetAt)
        )
          setSubject(conv, subject, note.subjectSetAt)
      }
      // Read on another device: the highest mark wins, and what is unread is counted again.
      if (note.readUpTo !== undefined && note.readUpTo > conv.lastRead) {
        conv.lastRead = note.readUpTo
        recomputeChatAccounting(conv, this.activeConversationId)
      }
      recordNoted(conv, note)
    },
    /**
     * The conversation was deleted, on another device of this account, with everything up to
     * `clearedBefore`. The same rule as a deletion made here: those messages are gone; if the
     * peer or this account has said something since, the conversation stays, without them;
     * otherwise it is deleted here too. An earlier deletion than one already known changes
     * nothing.
     */
    async applyClearedBeforeExclusive(
      conv: Conversation,
      clearedBefore: number,
    ): Promise<void> {
      if (clearedBefore <= (clearedUpTo(conv) ?? -Infinity)) return
      const kept = conv.messages.filter(
        message =>
          isUntimedOutgoing(message) || message.serverTime > clearedBefore,
      )
      // While a conversation is deleted, only its peer or this account brings it back: what
      // anyone else sent before that is gone with it.
      const revivedAt = kept.findIndex(message =>
        speaksForConversation(conv, message),
      )
      const surviving = new Set(revivedAt < 0 ? [] : kept.slice(revivedAt))
      await this.tombstoneMessagesExclusive(
        conv,
        conv.messages.filter(message => !surviving.has(message)),
      )
      if (surviving.size > 0) {
        conv.clearedBefore = clearedBefore
        conv.deletedAt = undefined
        return
      }
      conv.deletedAt = clearedBefore
      if (this.activeConversationId === conv.id)
        this.activeConversationId = null
    },
    /**
     * Notes to the account's own mailbox what this device knows about its conversations and
     * the mailbox does not say yet (deleted up to when, read up to when, its subject): a free
     * message to self per conversation, read by the
     * account's other devices and by one restored later from the seed. A note that could not
     * be sent is sent by a later pass (the mailbox poll starts one every time the relay
     * answers). Nothing is paid, and nothing is sent when there is nothing to say.
     */
    noteConversationStates(
      wallet: WalletHandle | undefined = messagingWallet(),
    ): Promise<void> {
      if (!wallet) return Promise.resolve()
      if (notingConversations) {
        noteConversationsAgain = true
        return notingConversations
      }
      const ownAddress = activeChain.formatAddress(wallet.identity.address)
      const pass = async (): Promise<void> => {
        // A note that cannot be sent is left for a later pass and the others go on: one
        // conversation's failure never holds back another's note. It is not tried again in
        // this pass, so a change made meanwhile does not turn a failure into a loop.
        const failed = new Set<string>()
        do {
          noteConversationsAgain = false
          for (const id of Object.keys(this.conversations)) {
            const conv = this.conversations[id]
            const note =
              conv && !failed.has(id)
                ? conversationStateToNote(
                    conv,
                    ownAddress,
                    this.activeConversationId,
                  )
                : undefined
            if (!note) continue
            try {
              await activeChain.directMessages.send({
                wallet,
                recipient: wallet.identity.address,
                items: [note],
                stampValue: 0n,
                messageId: conversationNoteId(note),
              })
            } catch (error) {
              failed.add(id)
              console.warn(
                `conversation note for ${id} not sent; will retry:`,
                error,
              )
              continue
            }
            if (note.readUpTo !== undefined) readNotedAt.set(id, Date.now())
            const current = this.conversations[id]
            if (current) recordNoted(current, note)
          }
        } while (noteConversationsAgain)
      }
      notingConversations = pass().finally(() => {
        notingConversations = undefined
      })
      return notingConversations
    },
    async clearConversation(conversationId: string): Promise<void> {
      return serializeDeliveryMutation(() =>
        this.clearChatExclusive(conversationId),
      )
    },
    /** Sets the stamp the user chose for a conversation; `undefined` returns it to the default. */
    setStampWei({
      address,
      stampWei,
    }: {
      address: string
      stampWei: bigint | undefined
    }) {
      const chat = this.chats[address] || this.conversations[address]
      if (chat) chat.stampWei = stampWei?.toString()
    },
    setActiveChat(address: string | null): void {
      if (!address) return this.setActiveConversation(null)
      if (this.conversations[address])
        return this.setActiveConversation(address)
      const conv = this.openDirectConversation(address)
      this.setActiveConversation(conv.id)
    },
    setActiveConversation(conversationId: string | null): void {
      if (conversationId && isChainAddress(conversationId)) {
        return this.setActiveChat(conversationId)
      }
      const conv = conversationId
        ? resolveConversation(this.conversations, conversationId)
        : undefined
      if (conversationId && !conv)
        throw new Error(`Unknown conversation ${conversationId}`)
      const closed = this.activeConversationId
      this.activeConversationId = conv?.id ?? null
      // What was read in the conversation just closed is noted now.
      if (closed !== null && closed !== this.activeConversationId)
        void this.noteConversationStates()
      if (conv) {
        if (isChainAddress(conv.address))
          useContactStore().refresh(conv.address)
        this.readAll(conv.id)
      }
    },
    async receiveMessages(
      messageWrappers: ReceivedMessageWrapper[],
      ownAddressOverride?: string,
      lease?: DeliveryLease,
    ): Promise<ReceivedDeliveryResult> {
      const toNotify = new Set<string>()
      for (const { index } of messageWrappers) {
        if (!(index in this.messages) && !notifyingIncoming.has(index)) {
          toNotify.add(index)
          notifyingIncoming.add(index)
        }
      }
      try {
        return await this.storeReceivedMessages(
          messageWrappers,
          toNotify,
          ownAddressOverride,
          lease,
        )
      } finally {
        for (const index of toNotify) {
          notifyingIncoming.delete(index)
        }
      }
    },
    async storeReceivedMessages(
      messageWrappers: ReceivedMessageWrapper[],
      toNotify: Set<string>,
      ownAddressOverride?: string,
      lease?: DeliveryLease,
    ): Promise<ReceivedDeliveryResult> {
      let ownAddress: string | null = null
      if (ownAddressOverride !== undefined) {
        try {
          ownAddress = toChainDisplayAddress(ownAddressOverride)
        } catch {
          ownAddress = ownAddressOverride
        }
      } else {
        ownAddress = await getOwnCanonicalAddress()
      }
      const { suppressedReceipts, cancelled } = await serializeDeliveryMutation(
        () =>
          this.storeReceivedMessagesExclusive(
            messageWrappers,
            toNotify,
            ownAddress,
            lease,
          ),
      )
      // A generation that lost its wallet while queued behind the boundary must not notify
      // either: the notification path mutates the contacts store and uses the current
      // session's profile/active-chat state.
      if (!cancelled) {
        await this.notifyReceivedMessages(messageWrappers, toNotify, lease)
      }
      return { suppressedReceipts, cancelled }
    },
    async storeReceivedMessagesExclusive(
      messageWrappers: ReceivedMessageWrapper[],
      toNotify: Set<string>,
      ownAddress: string | null,
      lease?: DeliveryLease,
    ): Promise<ReceivedDeliveryResult> {
      // The lease is checked HERE, after the serialized boundary has been acquired: a
      // replacement that stopped this poller while the delivery was queued leaves the queue
      // holding this work, and only this check prevents the old generation from persisting.
      if (lease?.isCancelled()) {
        return { suppressedReceipts: [], cancelled: true }
      }
      console.log('receiving messages')
      const messageStore = await store
      if (
        messageWrappers.some(
          wrapper => !isSafeRelayTimestamp(wrapper.message.receivedTime),
        )
      ) {
        throw new Error('Unsafe relay receipt timestamp')
      }
      const receipts = messageWrappers.map(wrapper => ({
        payloadDigest: wrapper.index,
        receivedTime: wrapper.message.receivedTime,
      }))
      const suppressedDigests =
        ownAddress &&
        typeof messageStore?.suppressedRelayReceipts === 'function'
          ? await messageStore.suppressedRelayReceipts(ownAddress, receipts)
          : new Set<string>()
      let deliverableWrappers = messageWrappers.filter(wrapper => {
        // A row refused earlier in this session is not looked at again.
        if (
          !suppressedDigests.has(wrapper.index) &&
          !refusedIncoming.has(wrapper.index)
        )
          return true
        toNotify.delete(wrapper.index)
        return false
      })
      // Rows of records only are taken out here, before anything is filed or saved: what the
      // session shows and what a reload shows are then the same, because neither has the row.
      const recordRows = deliverableWrappers.filter(carriesOnlyRecords)
      if (recordRows.length > 0) {
        deliverableWrappers = deliverableWrappers.filter(
          wrapper => !carriesOnlyRecords(wrapper),
        )
        const swaps = recordRows.flatMap(wrapper => {
          toNotify.delete(wrapper.index)
          return ownSwapRecords(wrapper, ownAddress)
        })
        if (swaps.length > 0) {
          const { useSwapStore } = await import('./swaps')
          for (const item of swaps) useSwapStore().handleSwapItem(item)
        }
      }
      // What the account's other devices noted about its conversations.
      const conversationNotes = recordRows.flatMap(wrapper =>
        ownConversationStates(wrapper, ownAddress),
      )
      // A later durable receipt is a restart frontier even before the poll advances its
      // cursor. Commit authenticated note effects first, through the existing metadata
      // owner, so a crash cannot skip a note whose raw row is intentionally not stored.
      for (const note of conversationNotes)
        await this.applyConversationStateExclusive(note, ownAddress)
      if (conversationNotes.length > 0) await this.flushPersistence?.()
      const outboundMatches = new Map<string, OutboundDeliveryMatch>()
      const replacedAccountCollisions = new Map<
        string,
        { conversationId: string; oldIndex: string }
      >()

      const owners = indexOutboundDeliveryOwners({
        ...(this.conversations ?? {}),
      })

      for (const wrapper of deliverableWrappers) {
        const confirmed = owners.byPayload.get(wrapper.index)
        const owner = confirmed ?? owners.byAttempt.get(wrapper.index)
        if (!owner) continue
        const {
          chatAddress,
          conversationId,
          index: oldIndex,
          message: existing,
        } = owner
        const isCurrentSender =
          sameCanonicalAddress(existing.senderAddress, ownAddress) &&
          sameCanonicalAddress(wrapper.senderAddress, ownAddress)
        const isMatchingOutboxRoute =
          wrapper.outbound === true &&
          sameCanonicalAddress(chatAddress, wrapper.copartyAddress)
        const isCurrentSelfRoute =
          wrapper.outbound === false &&
          sameCanonicalAddress(chatAddress, ownAddress) &&
          sameCanonicalAddress(wrapper.copartyAddress, ownAddress)
        const isSameIdentityAndRoute =
          isCurrentSender && (isMatchingOutboxRoute || isCurrentSelfRoute)

        if (isSameIdentityAndRoute) {
          await assertDurableAttemptAssociation(
            oldIndex,
            existing.delivery?.attemptDigest ?? wrapper.index,
            existing,
            chatAddress,
          )
          // The local outbox owns content/direction. The relay owns only delivery time and the
          // observed stamp metadata; never spread an inbox wrapper over the outbound record.
          outboundMatches.set(wrapper.index, {
            oldIndex,
            chatAddress,
            conversationId,
            message: {
              outbound: true,
              status: 'confirmed',
              items: existing.items,
              serverTime: wrapper.message.serverTime,
              receivedTime: wrapper.message.receivedTime,
              outpoints: wrapper.message.outpoints,
              stampValueWei:
                wrapper.message.stampValueWei ?? existing.stampValueWei,
              stampPayments:
                wrapper.message.stampPayments ?? existing.stampPayments,
              senderAddress: existing.senderAddress,
              destinationAddress: wrapper.message.destinationAddress,
              delivery: existing.delivery,
              conversationId,
              logicalMessageId: existing.logicalMessageId,
            },
          })
        } else {
          // A payload from an earlier account can legitimately arrive after Replace Account.
          // It is a new inbound record for the current identity, not the old account's outbox.
          replacedAccountCollisions.set(wrapper.index, {
            conversationId,
            oldIndex,
          })
          toNotify.add(wrapper.index)
        }
      }

      const receivedConversations = new Map<string, Conversation>()
      const receivedLogicalOwners = new Map<
        string,
        { conversationId: string; senderAddress: string }
      >()
      // The ID each received row is filed under: the one it named, or the derived one.
      const receivedLogicalIds = new Map<string, string>()
      // Deleted conversations a row of this batch brings back.
      const reopened = new Set<string>()
      const preparedConversations = { ...this.conversations }
      // One row that cannot be filed must never stop the rest: a refused row is skipped,
      // quarantined so the mailbox cursor moves past it, and reported once.
      const refused: RelayReceiptIdentity[] = []
      const prepareRow = (wrapper: ReceivedMessageWrapper): void => {
        if (carriesWalletRecord(wrapper)) {
          throw Object.assign(new Error('Unsupported incoming wallet sync'), {
            code: 'unsupported_incoming_wallet_sync',
          })
        }
        const peer = toChainDisplayAddress(wrapper.copartyAddress)
        const rawId = wrapper.message.conversationId || wrapper.conversationId
        const loopback = outboundMatches.get(wrapper.index)
        const id = rawId
          ? canonicalConversationId(rawId)
          : loopback?.conversationId
        if (loopback && id && id !== loopback.conversationId) {
          throw new Error(
            'Conversation identity differs from the original outgoing message',
          )
        }
        // A message is filed under the ID it carries. One that carries none (a client that
        // sent none) is filed under the ID this account allocates for its sender: always the
        // same conversation, whatever else has arrived and in whatever order.
        let conv = id
          ? preparedConversations[id]
          : conversationIdSalt.value
          ? preparedConversations[allocateOpeningConversationIdFor(peer)]
          : undefined
        // Only our own messages are bound to the conversation's peer. An inbound message is
        // filed under the ID it carries, whoever sent it; its sender joins the participants
        // when the message is stored below.
        if (conv && (loopback || wrapper.outbound))
          assertConversationPeer(conv, peer)
        const existing = this.messages[wrapper.index]
        if (
          existing?.conversationId &&
          id &&
          existing.conversationId !== id &&
          !replacedAccountCollisions.has(wrapper.index)
        ) {
          throw new Error(
            'Conversation identity differs from the existing message owner',
          )
        }
        const created = !conv
        if (!conv) {
          const participants = ownAddress ? [ownAddress, peer] : [peer]
          conv = id
            ? newConversation({ id, address: peer, participants })
            : openAllocatedConversation(
                preparedConversations,
                peer,
                participants,
              )
        }
        // What deleting a conversation means is decided here, before anything is saved: a row
        // that would not be shown is not kept at all.
        if (!loopback) {
          const deleted = inDeletedConversation(
            conv,
            wrapper.message,
            reopened.has(conv.id),
          )
          if (deleted === 'gone') {
            if (created) delete preparedConversations[conv.id]
            throw new Error(
              `Conversation ${conv.id} was deleted; this message does not reopen it`,
            )
          }
          if (deleted === 'reopens') reopened.add(conv.id)
        }
        const sender = loopback?.message.senderAddress ?? wrapper.senderAddress
        const named =
          loopback?.message.logicalMessageId ||
          wrapper.message.logicalMessageId ||
          wrapper.index
        const conversationId = conv.id
        const heldByAnother = (id: string): boolean =>
          isAnotherMessage(
            receivedLogicalOwners.get(id),
            conversationId,
            sender,
          ) ||
          (!replacedAccountCollisions.has(wrapper.index) &&
            isAnotherMessage(this.logicalMessages[id], conversationId, sender))
        // Our own outbox message keeps the ID it was sent under, and a row we already hold
        // keeps the ID it was filed under the first time.
        const filedAs = replacedAccountCollisions.has(wrapper.index)
          ? undefined
          : existing?.logicalMessageId
        const logicalId = loopback
          ? named
          : filedAs ?? freeMessageId(named, wrapper.index, heldByAnother)
        if (heldByAnother(logicalId)) {
          if (created) delete preparedConversations[conv.id]
          throw new Error(
            `Logical message ${logicalId} already belongs to another conversation`,
          )
        }
        preparedConversations[conv.id] = conv
        receivedLogicalOwners.set(logicalId, {
          conversationId: conv.id,
          senderAddress: sender,
        })
        receivedLogicalIds.set(wrapper.index, logicalId)
        receivedConversations.set(wrapper.index, conv)
      }
      for (const wrapper of deliverableWrappers) {
        try {
          prepareRow(wrapper)
        } catch (err) {
          console.warn(
            `direct messages: skipping message ${wrapper.index} that cannot be filed:`,
            err,
          )
          refused.push({
            payloadDigest: wrapper.index,
            receivedTime: wrapper.message.receivedTime,
          })
          refusedIncoming.add(wrapper.index)
          outboundMatches.delete(wrapper.index)
          replacedAccountCollisions.delete(wrapper.index)
          toNotify.delete(wrapper.index)
        }
      }
      if (refused.length > 0) {
        deliverableWrappers = deliverableWrappers.filter(
          wrapper => !refusedIncoming.has(wrapper.index),
        )
        if (ownAddress) await this.quarantineRelayReceipts(ownAddress, refused)
      }
      // From here on each row is filed into the store's own conversation object. A conversation
      // this batch created is a plain object until it is installed; writing to that one would
      // change the data without telling the screen (the list kept an empty preview).
      for (const [index, conv] of receivedConversations) {
        this.conversations[conv.id] ??= conv
        receivedConversations.set(index, this.conversations[conv.id])
      }

      // A local send has no relay time until its echo arrives. Once it does, apply the
      // same deletion boundary as any other mailbox row, including a note received in
      // an earlier poll. Tombstone both the local row and its receipt before installing
      // anything, retaining the wallet's independent submission/recovery evidence.
      const coveredEchoes = new Set<string>()
      for (const [index, loopback] of outboundMatches) {
        const conv = receivedConversations.get(index)!
        if (inDeletedConversation(conv, loopback.message) !== 'gone') continue
        const original = this.messages[loopback.oldIndex]
        await this.tombstoneMessagesExclusive(conv, [
          ...(original ? [original] : []),
          { payloadDigest: index, ...loopback.message },
        ])
        if (conv.messages.length === 0) {
          conv.deletedAt = clearedUpTo(conv)
          if (this.activeConversationId === conv.id)
            this.activeConversationId = null
        }
        coveredEchoes.add(index)
        suppressedDigests.add(index)
        toNotify.delete(index)
        outboundMatches.delete(index)
      }
      deliverableWrappers = deliverableWrappers.filter(
        wrapper => !coveredEchoes.has(wrapper.index),
      )

      for (const wrapper of deliverableWrappers) {
        // An index this call did not claim belongs to an overlapping receive.
        // Do not persist it: if the claimer fails before storing, a later poll
        // must still be able to notify.
        if (!toNotify.has(wrapper.index) && !(wrapper.index in this.messages)) {
          continue
        }
        const loopback = outboundMatches.get(wrapper.index)
        const persisted: MessageWrapper = {
          message: loopback?.message ?? {
            ...wrapper.message,
            conversationId: receivedConversations.get(wrapper.index)!.id,
            logicalMessageId: receivedLogicalIds.get(wrapper.index),
          },
          index: wrapper.index,
          outbound: loopback ? true : wrapper.outbound,
          senderAddress:
            loopback?.message.senderAddress ?? wrapper.senderAddress,
          copartyAddress: loopback?.chatAddress ?? wrapper.copartyAddress,
        }
        // Mailbox progress is advanced separately, after this durable relay receipt. Never let
        // local/outbound timestamps participate in the recipient-scoped cursor.
        await messageStore.saveMessage(persisted, { advanceCursor: false })
        const collision = replacedAccountCollisions.get(wrapper.index)
        if (loopback && loopback.oldIndex !== wrapper.index) {
          try {
            await messageStore.deleteMessage(loopback.oldIndex)
          } catch (err) {
            // The confirmed digest wins during reload if a crash leaves the pending record.
            console.warn('could not remove the looped-back pending record', err)
          }
        } else if (collision && collision.oldIndex !== wrapper.index) {
          try {
            await messageStore.deleteMessage(collision.oldIndex)
          } catch (err) {
            // Reload drops the stale pending record when it sees the confirmed digest.
            console.warn(
              'could not remove the replaced-account pending record',
              err,
            )
          }
        }
      }

      // Apply persistence-backed reconciliations before notification/accounting. This makes a
      // poll that wins the race with `directMessages.send` completion indistinguishable from the
      // send completing first: one outbound object, one key, and no inbound value/unread effects.
      const chatMutations = new Map<
        string,
        {
          replacements: Map<string, ChatMessage>
          removals: Set<string>
        }
      >()
      const mutationFor = (chatAddress: string) => {
        const existing = chatMutations.get(chatAddress)
        if (existing) return existing
        const created = {
          replacements: new Map<string, ChatMessage>(),
          removals: new Set<string>(),
        }
        chatMutations.set(chatAddress, created)
        return created
      }

      for (const [index, loopback] of outboundMatches) {
        const reconciled: ChatMessage = {
          payloadDigest: index,
          ...loopback.message,
        }
        const mutation = mutationFor(loopback.conversationId)
        mutation.replacements.set(loopback.oldIndex, reconciled)
        mutation.replacements.set(index, reconciled)
        delete this.messages[loopback.oldIndex]
        this.messages[index] = reconciled
        this.lastReceived = Math.max(
          this.lastReceived ?? 0,
          reconciled.serverTime,
        )
      }

      for (const collision of replacedAccountCollisions.values()) {
        const original = this.messages[collision.oldIndex]
        if (original)
          delete this.logicalMessages[
            original.logicalMessageId || collision.oldIndex
          ]
        mutationFor(collision.conversationId).removals.add(collision.oldIndex)
        delete this.messages[collision.oldIndex]
      }
      for (const [conversationId, mutation] of chatMutations) {
        const chat = this.conversations[conversationId]
        if (!chat) continue
        const installedReplacements = new Set<string>()
        chat.messages = chat.messages.flatMap(message => {
          const replacement = mutation.replacements.get(message.payloadDigest)
          if (replacement) {
            if (installedReplacements.has(replacement.payloadDigest)) return []
            installedReplacements.add(replacement.payloadDigest)
            return [replacement]
          }
          return mutation.removals.has(message.payloadDigest) ? [] : [message]
        })
        if (installedReplacements.size > 0) {
          chat.lastReceived = Math.max(
            chat.lastReceived,
            ...[...mutation.replacements.values()].map(
              message => message.serverTime,
            ),
          )
        }
        recomputeChatAccounting(chat, this.activeConversationId)
        for (const replacement of mutation.replacements.values()) {
          recordLogicalMessage(this.logicalMessages, replacement, chat.id)
        }
      }
      for (const wrapper of deliverableWrappers) {
        const {
          copartyAddress,
          index,
          message: newMsg,
        }: { copartyAddress: string; index: string; message: Message } = wrapper

        if (outboundMatches.has(index)) {
          // Our own message, read back from the mailbox: its content is already here, but the
          // relay time of a rename it carried decides against a rename by the peer, the same
          // way it does on this account's other devices.
          const sentIn = receivedConversations.get(index)
          if (sentIn)
            applyCarriedSubject(sentIn, { ...wrapper.message, outbound: true })
          continue
        }

        assert(newMsg.outbound !== undefined, 'outbound is not defined')
        assert(newMsg.status !== undefined, 'status is not defined')
        assert(newMsg.receivedTime !== undefined, 'receivedTime is not defined')
        assert(newMsg.serverTime !== undefined, 'serverTime is not defined')
        assert(newMsg.items !== undefined, 'items is not defined')
        assert(newMsg.outpoints !== undefined, 'outpoints is not defined')
        assert(
          newMsg.senderAddress !== undefined,
          'senderAddress is not defined',
        )
        assert(copartyAddress !== undefined, 'address is not defined')
        assert(index !== undefined, 'index is not defined')
        if (!toNotify.has(index) && !(index in this.messages)) {
          continue
        }
        const displayAddress =
          safeChainDisplayAddress(copartyAddress) || copartyAddress

        const emailItem = newMsg.items?.find(
          (it: any) => it.type === 'email',
        ) as EmailItem | undefined
        const conv = receivedConversations.get(index)!
        const convName = emailItem?.subject
        const trustedGateway = getTrustedEmailGatewayAddress()
        const isVerifiedGateway = newMsg.outbound
          ? sameCanonicalAddress(copartyAddress, trustedGateway)
          : sameCanonicalAddress(newMsg.senderAddress, trustedGateway)

        // What this message may change about the conversation itself, beyond being added to
        // it: nothing, unless we or the conversation's own peer sent it.
        const speaks = speaksForConversation(conv, newMsg)

        // Every row that reaches this point was saved above and is recorded in full below:
        // nothing here may skip it. A row into a deleted conversation got this far only
        // because it reopens the conversation.
        reopenConversation(conv)

        // Renaming: update conversation name if provided
        if (
          speaks &&
          convName !== undefined &&
          typeof convName === 'string' &&
          convName.trim().length > 0
        ) {
          conv.name = convName
          conv.updatedAt = Date.now()
        }

        applyCarriedSubject(conv, wrapper.message)

        const message: ChatMessage = {
          ...newMsg,
          payloadDigest: index,
          conversationId: conv.id,
          logicalMessageId: receivedLogicalIds.get(index) ?? index,
          revisionDigest: (newMsg as any).revisionDigest || index,
          deliveryDigest: index,
        }

        // A note to self that carries a swap record beside something to show.
        const swaps = ownSwapRecords(wrapper, ownAddress)
        if (swaps.length > 0)
          void import('./swaps').then(({ useSwapStore }) => {
            for (const item of swaps) useSwapStore().handleSwapItem(item)
          })

        if (index in this.messages) {
          const existingMessage = this.messages[index]
          assert(existingMessage, 'For great typescript')
          const wasOutbound = existingMessage.outbound
          const senderAddress = existingMessage.senderAddress
          // Mutate the object so that it triggers reactivity. A loopback is still the outbox
          // message the user sent; only its relay-authored time/stamp metadata is refreshed.
          this.messages[index] = Object.assign(existingMessage, message, {
            outbound: wasOutbound,
            senderAddress,
            conversationId: conv.id,
          })
          if (!conv.messages.some(m => m.payloadDigest === index)) {
            conv.messages.push(this.messages[index])
            conv.messages.sort(byRelayTime)
          }
          if (emailItem && speaks) {
            conv.kind = 'email'
            if (!conv.name && emailItem.subject) {
              conv.name = emailItem.subject
            }
            conv.verifiedGateway = isVerifiedGateway
          }
          if (wasOutbound) {
            conv.lastReceived = Math.max(conv.lastReceived, message.serverTime)
            this.lastReceived = Math.max(
              this.lastReceived ?? 0,
              message.serverTime,
            )
          }
          recordLogicalMessage(this.logicalMessages, message, conv.id)
          // We should already have created the chat if we have the message. Continue so one
          // replayed item cannot hide later, genuinely new messages from this same poll batch.
          continue
        }

        this.messages[index] = message
        if (!conv.messages.some(m => m.payloadDigest === index)) {
          conv.messages.push(message)
          conv.messages.sort(byRelayTime)
        }
        if (!message.outbound) {
          const key = wrapper.copartyPubKey?.toBuffer?.()
          addParticipant(
            conv,
            message.senderAddress,
            key
              ? Array.from(key, byte =>
                  byte.toString(16).padStart(2, '0'),
                ).join('')
              : undefined,
          )
        }

        if (emailItem && speaks) {
          conv.kind = 'email'
          if (!conv.name && emailItem.subject) {
            conv.name = emailItem.subject
          }
          conv.verifiedGateway = isVerifiedGateway
        }
        conv.lastReceived = message.serverTime
        recordLogicalMessage(this.logicalMessages, message, conv.id)

        const messageValue = accountedMessageValue(message)
        if (
          !isOwnMessage(message) &&
          conv.id !== this.activeConversationId &&
          conv.lastRead < message.serverTime
        ) {
          conv.totalUnreadValue += messageValue
          conv.totalUnreadMessages += 1
        } else if (conv.id === this.activeConversationId) {
          // The receipt was visible while this chat was active. Persist that read decision so
          // navigating elsewhere and reloading cannot reconstruct it as unread.
          conv.lastRead = Math.max(conv.lastRead, message.serverTime)
        }
        this.lastReceived = message.serverTime
        conv.totalValue += messageValue
      }
      // A thread opened here and never used yields to the peer's own conversation once that
      // is the peer's thread: it is dropped rather than left as a second, empty thread, and
      // whoever had it open is shown the peer's thread instead.
      if (conversationIdSalt.value) {
        for (const peer of new Set(
          [...receivedConversations.values()].map(c => c.address),
        )) {
          if (!isChainAddress(peer)) continue
          const opened =
            this.conversations[allocateOpeningConversationIdFor(peer)]
          const thread = peerThread(this.conversations, peer)
          if (
            opened &&
            thread &&
            opened !== thread &&
            opened.messages.length === 0 &&
            !opened.name &&
            !opened.deletedAt
          ) {
            delete this.conversations[opened.id]
            replacedConversations.set(opened.id, thread.id)
            if (this.activeConversationId === opened.id)
              this.activeConversationId = thread.id
          }
        }
      }
      const hasIncomingConfirmedStamps = deliverableWrappers.some(wrapper => {
        if (outboundMatches.has(wrapper.index) || wrapper.outbound) {
          return false
        }
        return (
          (wrapper.message.stampValueWei !== undefined &&
            wrapper.message.stampValueWei > 0n) ||
          (wrapper.message.stampPayments !== undefined &&
            wrapper.message.stampPayments.length > 0) ||
          (wrapper.stampValue !== undefined && wrapper.stampValue > 0)
        )
      })
      if (hasIncomingConfirmedStamps) {
        try {
          void useBalance().refresh()
        } catch {
          // ignore
        }
      }
      return {
        suppressedReceipts: receipts.filter(receipt =>
          suppressedDigests.has(receipt.payloadDigest),
        ),
        cancelled: false,
      }
    },
    async notifyReceivedMessages(
      messageWrappers: ReceivedMessageWrapper[],
      toNotify: Set<string>,
      lease?: DeliveryLease,
    ): Promise<void> {
      for (const messageWrapper of messageWrappers) {
        const {
          copartyAddress,
          copartyPubKey,
          index,
          message: newMsg,
          stampValue,
        } = messageWrapper
        const stored = this.messages[index]
        if (!toNotify.has(index) || !stored || stored.outbound) continue
        // The notification decision may predate a stop() that lands while earlier wrappers of
        // this batch are still being notified. Contacts refresh and desktop notifications act on
        // whatever generation currently owns the stores, so a cancelled lease must not run them.
        if (lease?.isCancelled()) return

        const contacts = useContactStore()
        // The peer of a conversation becomes a contact when they write. Someone else who posts
        // into that conversation does not: they stay marked as not in the contacts.
        const conversation = this.conversations[stored.conversationId ?? '']
        const isPeer =
          !conversation ||
          !isChainAddress(conversation.address) ||
          sameCanonicalAddress(conversation.address, copartyAddress)
        if (isPeer && !contacts.isContact(copartyAddress)) {
          contacts.addLoadingContact({
            address: copartyAddress,
            pubKey: copartyPubKey,
          })
          await contacts.refresh(copartyAddress)
        }

        const acceptancePrice = useProfileStore().inbox.acceptancePrice ?? 0
        if (
          document.hasFocus() ||
          stampValue < acceptancePrice ||
          this.lastRead(stored.conversationId!) > newMsg.serverTime ||
          messageWrappers.length !== 1
        ) {
          continue
        }

        const contact = contacts.getContact(copartyAddress)
        const senderName = contacts.isContact(copartyAddress)
          ? contact.profile.name ?? 'Unknown'
          : shortAddress(copartyAddress)
        const textItem: TextItem = (newMsg.items.find(
          item => item.type === 'text',
        ) as TextItem) ?? { text: '' }
        const stealthItem: StealthItem = (newMsg.items.find(
          item => item.type === 'stealth',
        ) as StealthItem) ?? { amount: 0 }
        const pictures = picturePreview(newMsg.items)
        let body = ''
        if (stealthItem.amount > 0) {
          // The item's amount is the sender's claim: nothing here has seen it on the chain,
          // so it is not announced as money received. The message shows what the wallet verifies.
          body = '[Payment, not yet verified] '
        }
        // This store has no translator (the name fallback below is English too).
        body += pictures
          ? picturePreviewText(pictures, (key, params) =>
              key === 'chatImage.onePhoto'
                ? '\u{1F4F7} Photo'
                : `\u{1F4F7} ${params?.count} photos`,
            )
          : textItem.text
        if (contact?.notify) {
          desktopNotify(
            senderName,
            body,
            contact.profile.avatar ?? '',
            async () => this.setActiveConversation(stored.conversationId!),
            index,
          )
        }
      }
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const chats = {
        activeConversationId: state.activeConversationId,
        conversations: Object.fromEntries(
          Object.entries(state.conversations).map(([id, conv]) => [
            id,
            { ...conv, messages: [] },
          ]),
        ),
        lastReceived: state.lastReceived ?? 0,
      }
      return storage.put('chats', JSON.stringify(chats))
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async restore(storage, metadata): Promise<Partial<State>> {
      let chats = '{}'
      try {
        chats = await storage.get('chats')
      } catch (err) {
        //
      }
      const deserializedChats = JSON.parse(chats) as RestorableState

      const invalidStore =
        metadata.networkName !== displayNetwork ||
        metadata.version !== STORE_SCHEMA_VERSION
      return rehydateChat(deserializedChats, !invalidStore)
    },
  },
})
