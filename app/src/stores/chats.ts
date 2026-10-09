import assert from 'assert'
import { defineStore } from 'pinia'

import {
  defaultEmailGatewayAddress,
  defaultStampAmount,
  displayNetwork,
} from '../utils/constants'
import { sha1 } from '@noble/hashes/sha1'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { desktopNotify } from '../utils/notifications'
import { store } from '../adapters/level-message-store'
import {
  isChainAddress,
  safeChainDisplayAddress,
  toChainDisplayAddress,
} from '../utils/chain-address'
import { formatBalance } from '../utils/formatting'
import { acquireOutgoingLock, withOutgoingLock } from '../utils/outgoing-lock'
import { activeChain } from '@frank/wallet/chain'
import {
  getMessageItemPreview,
  tallyMessageItemsValue,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import {
  computeGeometricStampSuggestion,
  derivePeerStampMetrics,
  type PeerStampMetrics,
} from '@frank/wallet/stamp-suggestion'

// Sidebar/notification previews (`getMessageItemPreview` above) need every registered type's
// plugin loaded here too, not just `built-in` -- found live (CDP-driven testing while building the
// raffle bot, 2026-09-28): a chat list item for a bot conversation can render before that bot's own
// `ChatMessage.vue` (the only other place these side-effect imports lived) ever mounts, e.g. the
// very first incoming message from a bot type the user hasn't opened a chat with yet. Before this
// fix, `getMessageItemPreview` threw "No message item plugin registered," which crashed the whole
// app (an uncaught error mid-render-effect left Vue's tree inconsistent, cascading into unrelated
// component updates). Pre-existing gap for blackjack/digital-goods, closed here for all three while
// fixing it for `raffle`.
import '@frank/wallet/message-item-plugins/blackjack/plugin'
import '@frank/wallet/message-item-plugins/digital-goods/plugin'
import '@frank/wallet/message-item-plugins/raffle/plugin'
import {
  CanonicalMessagingHoldError,
  CanonicalRecipientNotPublishedError,
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
import { routeWalletSyncItem } from '@frank/wallet/sync-router'
import { messagingWallet } from '../utils/monad-identity-session'
import { appMultiChainResolver } from '../accounts/sync-router'
import type {
  Message,
  MessageWrapper,
  MessageItem,
  OutgoingDelivery,
  OutgoingFailureReason,
  TextItem,
  ImageItem,
  StealthItem,
  WalletSyncItem,
  SwapRecordItem,
  EmailItem,
} from '@frank/cashweb/types/messages'
import {
  isSafeRelayTimestamp,
  type RelayDeliverySuppression,
  type RelayReceiptIdentity,
} from '@frank/cashweb/relay/storage/storage'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { accountSession } from '../accounts/session'
import { useProfileStore } from './my-profile'
import { useSettingsStore } from './settings'
import { useContactStore } from './contacts'
import { useBalance } from '../composables/useBalance'
import { mapObjIndexed, pathOr } from 'ramda'
import { STORE_SCHEMA_VERSION } from 'src/boot/pinia'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
} from '../utils/own-address'
import { sweepMessageFundsOnDelete } from '../utils/sweep-on-delete'

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
  /** Outgoing messages that are not yet confirmed (#269/#270); see `Message.delivery`. */
  delivery?: OutgoingDelivery
  /** Ticket #69: Conversation and logical message identifiers */
  conversationId?: string
  logicalMessageId?: string
  revisionDigest?: string
  deliveryDigest?: string
}

/**
 * # Pinia Chat Store Schema (Ticket #69)
 *
 * Decouples chat storage from 1:1 contact address indexing to support group-ready,
 * conversation-oriented state.
 *
 * ## Entity Model:
 *
 * 1. Conversation (`Conversation`):
 *    - `id`: Stable identifier (string UUID). Deterministically derived via RFC 4122 UUIDv5
 *      from a null namespace UUID and sorted participants key (and optional topic identifier).
 *      For group chats: group UUID or topic identifier.
 *    - `kind`: `'direct' | 'group'`
 *    - `name`?: Display subject/title of the conversation.
 *    - `topic`?: Optional topic thread identifier.
 *    - `participants`: Sorted canonical addresses of all members.
 *    - `members`: Record<string, ConversationMember> (membership registry).
 *    - `epoch`?: ConversationEpoch (cryptographic epoch reference placeholder; no crypto claimed).
 *    - `messages`: ChatMessage[] (ordered message list for this conversation).
 *    - `totalUnreadMessages`: number
 *    - `totalUnreadValue`: number
 *    - `totalValue`: number
 *    - `lastReceived`: number
 *    - `lastRead`: number
 *    - `stampAmount`: number
 *    - `address`: string (for direct chats: the coparty address; for group: the conversation id).
 *    - `createdAt`?: number
 *    - `updatedAt`?: number
 *    - `deletedAt`?: number (tombstone timestamp for delete/reopen semantics).
 *
 * 2. Conversation Member (`ConversationMember`):
 *    - `address`: Canonical member address.
 *    - `role`: `'owner' | 'admin' | 'member'`
 *    - `joinedAt`?: Timestamp when member joined.
 *    - `alias`?: Local display nickname for the member.
 *
 * 3. Logical Message (`LogicalMessageRecord`):
 *    - `messageId`: Stable logical message identifier (UUID / type 6 message_id).
 *    - `conversationId`: Parent conversation identifier.
 *    - `senderAddress`: Author's canonical address.
 *    - `createdAt`: Creation timestamp.
 *    - `activeRevisionDigest`: Latest/active revision content digest.
 *    - `revisions`: RevisionRecord[]
 *
 * 4. Message Revision (`RevisionRecord`):
 *    - `revisionDigest`: Content digest (T1a / type 8 revision digest).
 *    - `items`: MessageItem[]
 *    - `timestamp`: Timestamp of revision.
 *    - `deliveries`: DeliveryRecord[]
 *
 * 5. Delivery Record (`DeliveryRecord`):
 *    - `deliveryDigest`: Recipient-specific payload digest (T3 / type 5 payload digest).
 *    - `recipientAddress`?: Recipient address.
 *    - `status`: Delivery status ('pending' | 'payment-pending' | 'confirmed' | 'error').
 *    - `attemptDigest`?: Outbound payment attempt digest.
 *    - `timestamp`: Timestamp of delivery receipt/send.
 */

export type ConversationKind = 'direct' | 'group' | 'email'
export type ConversationRole = 'owner' | 'admin' | 'member'

export interface ConversationMember {
  address: string
  role?: ConversationRole
  joinedAt?: number
  alias?: string
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
  stampAmount: number
  stampOverrideWei?: bigint
  address: string
  createdAt?: number
  updatedAt?: number
  deletedAt?: number
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

export function uuidv5(namespaceUuid: string, name: string): string {
  const cleanNs = namespaceUuid.replace(/-/g, '')
  const nsBytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    nsBytes[i] = parseInt(cleanNs.slice(i * 2, i * 2 + 2), 16)
  }
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(nsBytes.length + nameBytes.length)
  input.set(nsBytes, 0)
  input.set(nameBytes, nsBytes.length)

  const digest = sha1(input)
  digest[6] = (digest[6] & 0x0f) | 0x50 // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80 // RFC 4122 variant

  const hex = Array.from(digest.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function makeConversationId(
  participants: string[],
  topicId?: string,
): string {
  const pKey = makeParticipantsKey(participants)
  const name = topicId ? `${pKey}#${topicId}` : pKey
  return uuidv5(NULL_CONVERSATION_NAMESPACE, name)
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

function accountedMessageValue(message: {
  status: string
  items: MessageItem[]
  outpoints: Utxo[]
  stampValueWei?: bigint
}): number {
  if (message.status !== 'confirmed') return 0
  return messageStampPrice(message) + tallyMessageItemsValue(message.items)
}

const defaultContactObject = {
  kind: 'direct' as const,
  stampAmount: defaultStampAmount,
  totalUnreadMessages: 0,
  totalUnreadValue: 0,
  totalValue: 0,
  lastReceived: 0,
  lastRead: 0,
}

export interface State {
  activeChatAddr: string | null
  activeConversationId: string | null
  conversations: Record<string, Conversation>
  chats: Record<string, ChatState | undefined>
  messages: Record<string, Message | undefined>
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
    chats: {},
    conversations: {},
    messages: {},
    logicalMessages: {},
    lastReceived: null,
    activeChatAddr: null,
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

// Incoming message indexes whose notification is being decided right now. The `index in
// this.messages` check only sees a message once it is stored, which happens after several awaits
// (persisting it, loading an unknown contact), so two overlapping receiveMessages calls for the
// same message would both pass it and both notify. An index is claimed synchronously, before the
// first await, and released once the call has stored it (or failed, so a retry can still notify).
const notifyingIncoming = new Set<string>()

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

/** Called inside the delivery mutation boundary, immediately before changing an attributed row. */
async function assertDurableAttemptAssociation(
  id: string,
  expectedDigest: string | undefined,
): Promise<void> {
  if (expectedDigest === undefined) return
  const messageStore = await store
  if (typeof messageStore.getMessage !== 'function') return
  const persisted = await messageStore.getMessage(id)
  const storedDigest = persisted?.message.delivery?.attemptDigest
  if (storedDigest !== undefined && storedDigest !== expectedDigest) {
    throw new Error(`conflicting stored payment attempt for ${id}`)
  }
}

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
      /insufficient (?:main account )?(?:balance|funds)|insufficient stamp-account capacity/i.test(
        error.message,
      ))
  )
}

/** The original failure a `CanonicalMessagingHoldError` was raised for, if it carries one. */
function heldCause(error: unknown): unknown {
  return error instanceof Error && error.name === 'CanonicalMessagingHoldError'
    ? (error as { cause?: unknown }).cause
    : undefined
}

/** Maps a failed send to the reason class shown to the user, and says whether the message must
 * keep its payment attempt (so a later retry asks the wallet about it instead of paying again). */
function classifySendFailure(
  error: unknown,
  ownDigest: string | undefined,
): { reason: OutgoingFailureReason; keepDigest?: string } {
  const held = heldCause(error)
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
      error.name === 'CanonicalRecipientNotPublishedError') ||
    held instanceof CanonicalRecipientNotPublishedError ||
    (held instanceof Error &&
      held.name === 'CanonicalRecipientNotPublishedError')
  ) {
    return { reason: 'recipient-unregistered' }
  }
  if (isInsufficientFundsError(error)) {
    return { reason: 'insufficient-funds' }
  }
  // An earlier payment that could not be finished holds this send. Show why it could not be
  // finished; whatever payment set this message already has stays on it.
  if (isInsufficientFundsError(held)) {
    return { reason: 'insufficient-funds', keepDigest: ownDigest }
  }
  return {
    reason:
      isNoResponseError(error) || isNoResponseError(held)
        ? 'unreachable'
        : 'error',
    // Any failure after the payment set was journaled leaves that set on the message.
    keepDigest: ownDigest,
  }
}

type OutboundDeliveryMatch = {
  oldIndex: string
  chatAddress: string
  message: Message & { destinationAddress?: string }
}

type OutboundDeliveryOwner = {
  chatAddress: string
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
      const owner = { chatAddress, index, message }
      byPayload.set(index, owner)
      const attempt = message.delivery?.attemptDigest
      if (attempt !== undefined) byAttempt.set(attempt, owner)
    }
  }
  return { byPayload, byAttempt }
}

function recomputeChatAccounting(
  chat: ChatState,
  activeChatAddr: string | null,
): void {
  chat.totalValue = 0
  chat.totalUnreadMessages = 0
  chat.totalUnreadValue = 0
  for (const message of chat.messages) {
    const value = accountedMessageValue(message)
    chat.totalValue += value
    if (
      !message.outbound &&
      chat.address !== activeChatAddr &&
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
  activeChatAddr: string | null
  activeConversationId?: string | null
  conversations?: Record<string, Conversation | undefined>
  chats?: Record<string, ChatState | undefined>
  messages?: Record<string, Message | undefined>
  logicalMessages?: Record<string, LogicalMessageRecord | undefined>
  lastReceived: number | null
}

export function extractDirectPeerAddress(
  conv: Conversation,
  ownAddr: string | null,
): string | null {
  if (conv.kind !== 'direct' || conv.topic) return null

  let peer: string | null = null
  if (conv.participants && conv.participants.length > 0) {
    const peers = ownAddr
      ? conv.participants.filter(p => !sameCanonicalAddress(p, ownAddr))
      : conv.participants
    if (peers.length === 1) {
      peer = peers[0]
    } else if (
      peers.length > 1 &&
      conv.address &&
      peers.some(p => sameCanonicalAddress(p, conv.address))
    ) {
      peer = conv.address
    } else if (conv.address && conv.address !== conv.id) {
      peer = conv.address
    }
  } else if (conv.address && conv.address !== conv.id) {
    peer = conv.address
  }

  // Multiple participants without an explicit recipient or a resolved own identity
  // do not identify a peer. Guessing one lets list/hydration dedup merge other owners.
  if (!peer) return null
  try {
    return toChainDisplayAddress(peer)
  } catch {
    return peer
  }
}

export function autoHealDuplicateDirectConversations({
  conversations,
  chats,
  ownAddress,
  activeChatAddr = null,
  activeConversationId = null,
  messages,
  logicalMessages,
}: {
  conversations: Record<string, Conversation>
  chats: Record<string, ChatState>
  ownAddress: string | null
  activeChatAddr?: string | null
  activeConversationId?: string | null
  messages?: Record<string, Message>
  logicalMessages?: Record<string, LogicalMessageRecord>
}): void {
  const directConvsByPeer = new Map<string, Conversation[]>()
  for (const conv of Object.values(conversations)) {
    const peer = extractDirectPeerAddress(conv, ownAddress)
    if (!peer) continue
    let list = directConvsByPeer.get(peer)
    if (!list) {
      list = []
      directConvsByPeer.set(peer, list)
    }
    list.push(conv)
  }

  for (const [peer, list] of directConvsByPeer.entries()) {
    if (list.length <= 1) continue

    const canonicalParticipants = ownAddress
      ? Array.from(new Set([ownAddress, peer])).sort()
      : [peer]
    const canonicalId = makeConversationId(canonicalParticipants)

    const primary =
      list.find(c => c.id === canonicalId) ||
      list.find(c => (c.messages?.length ?? 0) > 0) ||
      list.find(c => chats[peer] && chats[peer].id === c.id) ||
      list[0]

    for (const dup of list) {
      if (dup === primary) continue

      // Merge messages arrays, deduplicating by payloadDigest and sorting by serverTime / receivedTime
      const msgMap = new Map<string, ChatMessage>()
      for (const msg of primary.messages) {
        const digest = msg.payloadDigest || (msg as any).index
        if (digest) {
          msgMap.set(digest, { ...msg, conversationId: primary.id })
        }
      }
      for (const msg of dup.messages) {
        const digest = msg.payloadDigest || (msg as any).index
        if (!digest) continue
        if (!msgMap.has(digest)) {
          msgMap.set(digest, { ...msg, conversationId: primary.id })
        } else {
          const existing = msgMap.get(digest)!
          msgMap.set(
            digest,
            Object.assign({}, existing, msg, { conversationId: primary.id }),
          )
        }
      }
      primary.messages = Array.from(msgMap.values()).sort((a, b) => {
        const timeA = a.serverTime ?? a.receivedTime ?? 0
        const timeB = b.serverTime ?? b.receivedTime ?? 0
        return timeA - timeB
      })

      // Merge metadata
      primary.lastRead = Math.max(primary.lastRead ?? 0, dup.lastRead ?? 0)
      primary.lastReceived = Math.max(
        primary.lastReceived ?? 0,
        dup.lastReceived ?? 0,
      )
      if (
        dup.createdAt &&
        (!primary.createdAt || dup.createdAt < primary.createdAt)
      ) {
        primary.createdAt = dup.createdAt
      }
      if (
        dup.updatedAt &&
        (!primary.updatedAt || dup.updatedAt > primary.updatedAt)
      ) {
        primary.updatedAt = dup.updatedAt
      }
      if (!primary.name && dup.name) {
        primary.name = dup.name
      }
      if (primary.stampAmount === undefined && dup.stampAmount !== undefined) {
        primary.stampAmount = dup.stampAmount
      }

      // Delete orphaned duplicate conversation key from conversations
      delete conversations[dup.id]
      if (dup.address) {
        chats[dup.address] = primary
        try {
          chats[toChainDisplayAddress(dup.address)] = primary
        } catch {
          // ignore
        }
      }
    }

    if (ownAddress) {
      primary.participants = canonicalParticipants
    } else if (!primary.participants.includes(peer)) {
      primary.participants = [peer]
    }
    primary.address = peer

    // Recompute accounting: unread counts, total values, lastReceived, lastRead
    for (const msg of primary.messages) {
      const msgTime = msg.serverTime ?? msg.receivedTime ?? 0
      primary.lastReceived = Math.max(primary.lastReceived, msgTime)
    }

    primary.totalValue = 0
    primary.totalUnreadMessages = 0
    primary.totalUnreadValue = 0
    for (const message of primary.messages) {
      const value = accountedMessageValue(message)
      primary.totalValue += value
      const msgTime = message.serverTime ?? message.receivedTime ?? 0
      if (
        !message.outbound &&
        primary.address !== activeChatAddr &&
        primary.id !== activeConversationId &&
        primary.lastRead < msgTime
      ) {
        primary.totalUnreadMessages += 1
        primary.totalUnreadValue += value
      }
    }

    // Update chats[copartyAddress] to point to the canonical conversation
    chats[peer] = primary
    try {
      chats[toChainDisplayAddress(peer)] = primary
    } catch {
      // ignore
    }
    if (primary.address) {
      chats[primary.address] = primary
      try {
        chats[toChainDisplayAddress(primary.address)] = primary
      } catch {
        // ignore
      }
    }

    if (messages || logicalMessages) {
      for (const msg of primary.messages) {
        if (msg.payloadDigest) {
          if (messages) {
            messages[msg.payloadDigest] = msg
          }
          if (logicalMessages) {
            recordLogicalMessage(logicalMessages, msg, primary.id)
          }
        }
      }
    }
  }
}

/**
 * Deduplicates direct and email conversations sharing the same peer address.
 * Prioritizes conversations containing messages over empty placeholders.
 */
export function deduplicateDirectConversations(
  conversations: Iterable<Conversation>,
): Conversation[] {
  const result: Conversation[] = []
  const directConvsByPeer = new Map<string, Conversation>()

  for (const conv of conversations) {
    if (!conv || conv.deletedAt) continue
    const peer = extractDirectPeerAddress(conv, null)
    if (peer && !conv.topic) {
      const existing = directConvsByPeer.get(peer)
      if (!existing) {
        directConvsByPeer.set(peer, conv)
      } else {
        const existingMsgCount = existing.messages?.length ?? 0
        const currentMsgCount = conv.messages?.length ?? 0

        // If one has messages and the other is empty, the one with messages wins.
        if (currentMsgCount > 0 && existingMsgCount === 0) {
          directConvsByPeer.set(peer, conv)
        } else if (currentMsgCount > 0 && existingMsgCount > 0) {
          const existingTime =
            existing.lastReceived ||
            existing.updatedAt ||
            existing.createdAt ||
            0
          const currentTime =
            conv.lastReceived || conv.updatedAt || conv.createdAt || 0
          if (currentTime > existingTime) {
            directConvsByPeer.set(peer, conv)
          }
        } else if (currentMsgCount === 0 && existingMsgCount === 0) {
          if (!existing.address && conv.address) {
            directConvsByPeer.set(peer, conv)
          }
        }
      }
    } else {
      result.push(conv)
    }
  }

  for (const conv of directConvsByPeer.values()) {
    result.push(conv)
  }

  return result
}

export async function rehydateChat(chatState: RestorableState): Promise<State> {
  if (!chatState) {
    return freshChatsState()
  }

  const conversations: Record<string, Conversation> = {}
  const chats: Record<string, ChatState> = {}
  const messages: Record<string, Message> = {}
  const logicalMessages: Record<string, LogicalMessageRecord> = {}

  // Restoration must not open custody. Preserve explicit public participants without
  // inventing a self identity; unresolved records retain the existing unresolved-self path.
  const ownAddress: string | null = null

  // 1. Restore any explicit conversations
  if (chatState.conversations) {
    for (const [id, rawConv] of Object.entries(chatState.conversations)) {
      if (!rawConv) continue
      const conv: Conversation = {
        id,
        kind: rawConv.kind || 'direct',
        name: rawConv.name,
        topic: rawConv.topic,
        emailRecipient: rawConv.emailRecipient,
        participants: rawConv.participants || [],
        members: rawConv.members || {},
        epoch: rawConv.epoch,
        address: rawConv.address || id,
        messages: Array.isArray(rawConv.messages) ? [...rawConv.messages] : [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: rawConv.lastReceived ?? 0,
        lastRead: rawConv.lastRead ?? 0,
        stampAmount: rawConv.stampAmount ?? defaultStampAmount,
        createdAt: rawConv.createdAt,
        updatedAt: rawConv.updatedAt,
        deletedAt: rawConv.deletedAt,
        verifiedGateway: rawConv.verifiedGateway,
      }
      conversations[id] = conv
      if ((conv.kind === 'direct' || conv.kind === 'email') && conv.address) {
        try {
          const displayAddress = toChainDisplayAddress(conv.address)
          chats[displayAddress] = conv
        } catch {
          chats[conv.address] = conv
        }
      }
    }

    // Auto-heal duplicate direct conversations sharing the same peer address
    autoHealDuplicateDirectConversations({
      conversations,
      chats,
      ownAddress,
      activeChatAddr: chatState.activeChatAddr,
      activeConversationId: chatState.activeConversationId ?? null,
      messages,
      logicalMessages,
    })
  }

  // Exported alias for rehydateChat

  // 2. Migrate legacy chats into conversations if not already restored
  if (chatState.chats) {
    for (const [contactAddress, contact] of Object.entries(chatState.chats)) {
      if (!contact) continue
      let displayAddress = contactAddress
      try {
        displayAddress = toChainDisplayAddress(contactAddress)
      } catch {
        //
      }
      const participants = ownAddress
        ? Array.from(new Set([ownAddress, displayAddress])).sort()
        : [displayAddress]
      const convId = (contact as any).id || makeConversationId(participants)

      let conv = conversations[convId]
      if (!conv) {
        const members: Record<string, ConversationMember> = {}
        for (const p of participants) {
          members[p] = { address: p, role: 'member' }
        }
        conv = {
          id: convId,
          kind: (contact as any).kind || 'direct',
          name: (contact as any).name,
          topic: (contact as any).topic,
          address: displayAddress,
          participants,
          members,
          messages: [],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: contact.lastReceived ?? 0,
          lastRead: contact.lastRead ?? 0,
          stampAmount: contact.stampAmount ?? defaultStampAmount,
        }
        conversations[convId] = conv
      }
      // Persisted participant aliases are derived lookups, not additional owners.
      // In particular a self alias must not route loopback messages to a remote peer.
      if (
        conv.address !== displayAddress &&
        !sameCanonicalAddress(conv.address, displayAddress)
      ) {
        continue
      }
      chats[displayAddress] = conv
      chats[contactAddress] = conv
    }
  }

  const localStore = await store

  const messageIterator = await localStore.getIterator()
  let lastReceived = Math.max(
    chatState.lastReceived ?? 0,
    await localStore.mostRecentMessageTime(),
  )

  // Todo, this rehydrate stuff is common to receiveMessage
  const wrappers: MessageWrapper[] = []
  for await (const messageWrapper of messageIterator) {
    if (messageWrapper.message) wrappers.push(messageWrapper)
  }
  // A message that was delivered after being re-keyed from its local id to its payload hash can
  // leave its old local record behind if the app stopped between the two writes. The confirmed
  // record wins (reconcile by payload hash: never show it twice); drop the leftover.
  const confirmedDigests = new Set(
    wrappers
      .filter(({ message }) => message.status === 'confirmed')
      .map(({ index }) => index),
  )
  for (const messageWrapper of wrappers) {
    const { index, message: newMsg, copartyAddress } = messageWrapper
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
      // payment attempt it is recoverable (the same bytes are re-sent); without one nothing was
      // paid, so it is an ordinary failed message the user can retry.
      if (newMsg.delivery?.attemptDigest !== undefined) {
        newMsg.status = 'payment-pending'
      } else {
        newMsg.status = 'error'
        newMsg.delivery = { ...newMsg.delivery, failureReason: 'interrupted' }
      }
    }
    assert(newMsg.outbound !== undefined, 'outbound is not defined')
    assert(newMsg.status !== undefined, 'status is not defined')
    assert(newMsg.receivedTime !== undefined, 'receivedTime is not defined')
    assert(newMsg.serverTime !== undefined, 'serverTime is not defined')
    assert(newMsg.items !== undefined, 'items is not defined')
    assert(newMsg.outpoints !== undefined, 'outpoints is not defined')
    assert(newMsg.senderAddress !== undefined, 'senderAddress is not defined')

    const message: ChatMessage = { payloadDigest: index, ...newMsg }
    const emailItem = message.items?.find(it => it.type === 'email') as
      | EmailItem
      | undefined
    const isEmail = !!emailItem
    const displayAddress =
      safeChainDisplayAddress(copartyAddress) || copartyAddress
    const rawConvId =
      (newMsg as any).conversationId || (messageWrapper as any).conversationId
    const participants = ownAddress
      ? Array.from(new Set([ownAddress, displayAddress])).sort()
      : [displayAddress]
    const convId = isEmail
      ? rawConvId
        ? makeConversationId(participants, rawConvId)
        : makeConversationId(participants)
      : makeConversationId(participants)

    let conv =
      chats[displayAddress] ||
      (copartyAddress ? chats[copartyAddress] : undefined) ||
      conversations[convId]
    if (!conv) {
      const members: Record<string, ConversationMember> = {}
      for (const p of participants) members[p] = { address: p, role: 'member' }
      conv = {
        ...defaultContactObject,
        id: convId,
        kind: isEmail ? 'email' : 'direct',
        address: displayAddress,
        participants,
        members,
        messages: [],
      }
      conversations[convId] = conv
    }
    chats[displayAddress] = conv
    chats[copartyAddress] = conv

    message.conversationId = conv.id
    messages[index] = message
    if (!conv.messages.some(m => m.payloadDigest === message.payloadDigest)) {
      conv.messages.push(message)
    }
    if (emailItem) {
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
      !newMsg.outbound &&
      conv.address !== chatState.activeChatAddr &&
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
    conv.messages.sort(
      (messageA, messageB) =>
        (messageA.serverTime ?? messageA.receivedTime ?? 0) -
        (messageB.serverTime ?? messageB.receivedTime ?? 0),
    )
    conv.totalUnreadMessages = 0
    conv.totalUnreadValue = 0
    conv.totalValue = 0
    for (const msg of conv.messages) {
      const val = accountedMessageValue(msg)
      conv.totalValue += val
      const msgTime = msg.serverTime ?? msg.receivedTime ?? 0
      conv.lastReceived = Math.max(conv.lastReceived ?? 0, msgTime)
      if (
        !msg.outbound &&
        conv.address !== chatState.activeChatAddr &&
        conv.id !== chatState.activeConversationId &&
        conv.lastRead < msgTime
      ) {
        conv.totalUnreadMessages += 1
        conv.totalUnreadValue += val
      }
    }
  }

  // Auto-heal duplicate direct conversations across all hydration sources
  autoHealDuplicateDirectConversations({
    conversations,
    chats,
    ownAddress,
    activeChatAddr: chatState.activeChatAddr,
    activeConversationId: chatState.activeConversationId ?? null,
    messages,
    logicalMessages,
  })

  return {
    conversations,
    chats,
    messages,
    logicalMessages,
    activeChatAddr: chatState.activeChatAddr,
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
    activeConversation(state): Conversation | null {
      if (
        state.activeConversationId &&
        state.conversations?.[state.activeConversationId]
      ) {
        return state.conversations[state.activeConversationId]
      }
      if (state.activeChatAddr && state.chats?.[state.activeChatAddr]) {
        return state.chats[state.activeChatAddr] ?? null
      }
      if (
        state.activeConversationId &&
        state.chats?.[state.activeConversationId]
      ) {
        return state.chats[state.activeConversationId] ?? null
      }
      return null
    },
    getNumUnread: state => (addressOrId: string) => {
      if (state.conversations && addressOrId in state.conversations) {
        return state.conversations[addressOrId]?.totalUnreadMessages ?? 0
      }
      try {
        const displayAddress = toChainDisplayAddress(addressOrId)
        return state.chats[displayAddress]
          ? state.chats[displayAddress]?.totalUnreadMessages ?? 0
          : 0
      } catch {
        return 0
      }
    },
    totalUnread(state) {
      const allConversations = new Map<string, Conversation>()
      if (state.conversations) {
        for (const [id, c] of Object.entries(state.conversations)) {
          if (c && !c.deletedAt) allConversations.set(id, c)
        }
      }
      if (state.chats) {
        for (const [addr, c] of Object.entries(state.chats)) {
          if (c && !c.deletedAt) {
            const key = c.id || addr
            if (!allConversations.has(key)) {
              allConversations.set(key, c)
            }
          }
        }
      }
      return deduplicateDirectConversations(allConversations.values())
        .map(chat => chat?.totalUnreadMessages ?? 0)
        .reduce((acc, val) => acc + val, 0)
    },
    getSortedChatOrder(state) {
      const allConversations = new Map<string, Conversation>()
      if (state.conversations) {
        for (const [id, c] of Object.entries(state.conversations)) {
          if (c && !c.deletedAt) allConversations.set(id, c)
        }
      }
      if (state.chats) {
        for (const [addr, c] of Object.entries(state.chats)) {
          if (c && !c.deletedAt) {
            const key = c.id || addr
            if (!allConversations.has(key)) {
              allConversations.set(key, c)
            }
          }
        }
      }
      const all = deduplicateDirectConversations(allConversations.values())
      const sortedOrder = all.sort((contactA, contactB) => {
        assert(contactA && contactB, 'Make typescript happy')
        if (contactB.totalUnreadValue - contactA.totalUnreadValue !== 0) {
          return contactB.totalUnreadValue - contactA.totalUnreadValue
        }

        if (contactB.totalValue - contactA.totalValue !== 0) {
          return contactB.totalValue - contactA.totalValue
        }

        if (contactB.lastRead !== contactA.lastRead) {
          return (contactB.lastRead ?? 0) - (contactA.lastRead ?? 0)
        }

        if (contactB.totalUnreadMessages - contactA.totalUnreadMessages !== 0) {
          return contactB.totalUnreadMessages - contactA.totalUnreadMessages
        }

        const timeB =
          contactB.lastReceived || contactB.updatedAt || contactB.createdAt || 0
        const timeA =
          contactA.lastReceived || contactA.updatedAt || contactA.createdAt || 0
        if (timeB !== timeA) {
          return timeB - timeA
        }

        // No other tiebreakers
        return 0
      })
      return sortedOrder
    },
    lastRead: state => (addressOrId: string) => {
      if (state.conversations && addressOrId in state.conversations) {
        return state.conversations[addressOrId]?.lastRead ?? 0
      }
      try {
        const displayAddress = toChainDisplayAddress(addressOrId)
        return state.chats[displayAddress]?.lastRead ?? 0
      } catch {
        return 0
      }
    },
    getPeerStampSuggestion:
      state =>
      (addressOrId: string): bigint => {
        let chat: Conversation | undefined
        if (state.conversations && addressOrId in state.conversations) {
          chat = state.conversations[addressOrId]
        } else {
          try {
            const displayAddress = toChainDisplayAddress(addressOrId)
            chat = state.chats[displayAddress]
          } catch {
            // ignore
          }
        }
        const messages = chat?.messages ?? []
        const metrics = derivePeerStampMetrics(messages)
        return computeGeometricStampSuggestion({
          lastSentWei: metrics.lastSentWei,
          lastReceivedWei: metrics.lastReceivedWei,
          netReceivedWei: metrics.netReceivedWei,
          defaultStampWei: activeChain.defaultStampValue,
        })
      },
    getPeerStampMetrics:
      state =>
      (addressOrId: string): PeerStampMetrics => {
        let chat: Conversation | undefined
        if (state.conversations && addressOrId in state.conversations) {
          chat = state.conversations[addressOrId]
        } else {
          try {
            const displayAddress = toChainDisplayAddress(addressOrId)
            chat = state.chats[displayAddress]
          } catch {
            // ignore
          }
        }
        return derivePeerStampMetrics(chat?.messages ?? [])
      },
    getStampOverrideWei:
      state =>
      (addressOrId: string): bigint | undefined => {
        if (state.conversations && addressOrId in state.conversations) {
          return state.conversations[addressOrId]?.stampOverrideWei
        }
        try {
          const displayAddress = toChainDisplayAddress(addressOrId)
          return state.chats[displayAddress]?.stampOverrideWei
        } catch {
          return undefined
        }
      },
    getStampAmount: state => (addressOrId: string) => {
      if (state.conversations && addressOrId in state.conversations) {
        return (
          state.conversations[addressOrId]?.stampAmount ?? defaultStampAmount
        )
      }
      try {
        const displayAddress = toChainDisplayAddress(addressOrId)
        const chat = state.chats[displayAddress]
        if (!chat) {
          return defaultStampAmount
        }
        return chat.stampAmount ?? defaultStampAmount
      } catch {
        return defaultStampAmount
      }
    },
    getLatestMessage: state => (addressOrId: string) => {
      let chat: Conversation | undefined
      if (state.conversations && addressOrId in state.conversations) {
        chat = state.conversations[addressOrId]
      } else {
        try {
          const displayAddress = toChainDisplayAddress(addressOrId)
          chat = state.chats[displayAddress]
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

      return {
        outbound: lastMessage.outbound,
        text: getMessageItemPreview(lastItem),
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
      } catch {
        // no-op if unparseable address or mock store lacking quarantine
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
        if (!message && this.chats) {
          for (const conv of Object.values(this.chats)) {
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
      // Relay inboxes are recipient-indexed. An ordinary outbound row can never return to the
      // sender's mailbox, so only a self-route needs a durable delayed-receipt suppression.
      const recipientAddress = message
        ? message.outbound
          ? sameCanonicalAddress(address, message.senderAddress)
            ? message.senderAddress
            : null
          : messageDestinationAddress(message)
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
          const allChats = [
            ...Object.values(this.conversations ?? {}),
            ...Object.values(this.chats ?? {}),
          ]
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
        if (!message && this.chats) {
          for (const conv of Object.values(this.chats)) {
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
        const receivedTime = observedRelayReceiptTime(message)
        suppressions.push({
          payloadDigest,
          ...(receivedTime === undefined ? {} : { receivedTime }),
        })
      }
      const installedReceivedTime = observedRelayReceiptTime(installedDelivery)
      if (installedReceivedTime !== undefined && attemptDigest) {
        suppressions.splice(0, 1, {
          payloadDigest: attemptDigest,
          receivedTime: installedReceivedTime,
        })
      }
      if (message && !message.outbound) {
        try {
          await sweepMessageFundsOnDelete({ message })
        } catch (sweepErr) {
          console.warn(
            'Failed to sweep message funds during deleteMessage:',
            sweepErr,
          )
        }
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
      if (this.chats) {
        for (const c of Object.values(this.chats)) {
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
            conv.messages.splice(0, conv.messages.length, ...remaining)
            conv.messages = remaining
            recomputeChatAccounting(conv, this.activeChatAddr)
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
      const values = chat.messages
      if (values.length === 0) {
        chat.lastRead = 0
      } else {
        chat.lastRead = Math.max(
          values[values.length - 1].serverTime,
          chat.lastRead ?? 0,
        )
      }
      chat.totalUnreadMessages = 0
      chat.totalUnreadValue = 0
    },
    reset() {
      this.chats = Object.fromEntries(
        Object.entries(this.chats).map(([address, chatData]) => {
          assert(chatData, 'Not possible')
          return [
            address,
            {
              ...chatData,
              messages: [],
              totalUnreadMessages: 0,
              totalUnreadValue: 0,
              totalValue: 0,
            },
          ]
        }),
      )
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
      this.activeChatAddr = null
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

      let conv: Conversation | undefined
      if (conversationId && this.conversations[conversationId]) {
        conv = this.conversations[conversationId]
      } else if (this.chats[displayAddress]) {
        conv = this.chats[displayAddress]
      }

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
          recomputeChatAccounting(conv, this.activeChatAddr)
          recordLogicalMessage(this.logicalMessages, message, conv.id)
        }
        return
      }

      const isInternalSyncOnly =
        items.length > 0 &&
        items.every(
          it =>
            it.type === 'swap-record' ||
            it.type === 'wallet-sync' ||
            it.type === 'payment-transfer',
        )

      if (isInternalSyncOnly) {
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
        conv = this.createConversation({
          kind: emailItem ? 'email' : 'direct',
          participants: [senderAddress, displayAddress],
          conversationId,
          address: displayAddress,
          verifiedGateway: emailItem ? isGateway : undefined,
        })
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
      conv.lastRead = Date.now()
      conv.lastReceived = Math.max(conv.lastReceived, timestamp)
      recomputeChatAccounting(conv, this.activeChatAddr)
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
      let ownAddress = await getOwnCanonicalAddress()
      if (!ownAddress) {
        ownAddress = 'self'
      }
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
        senderAddress: ownAddress,
        index: messageId,
        items,
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
        timestamp,
      })

      try {
        const messageStore = await store
        await messageStore.saveMessage({
          index: messageId,
          copartyAddress: ownAddress,
          senderAddress: ownAddress,
          message: {
            outbound: true,
            status: 'confirmed',
            receivedTime: timestamp,
            serverTime: timestamp,
            items,
            outpoints: [],
            senderAddress: ownAddress,
          },
        })
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

      let conv: Conversation | undefined
      if (conversationId && this.conversations[conversationId]) {
        conv = this.conversations[conversationId]
      } else if (this.chats[displayAddress]) {
        conv = this.chats[displayAddress]
      } else {
        conv = this.createConversation({
          kind: 'direct',
          participants: [wallet.identity.displayAddress, displayAddress],
          conversationId,
          address: displayAddress,
        })
      }

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
      await assertDurableAttemptAssociation(id, payloadDigest)
      const { items, senderAddress, serverTime } = message
      const value = stampValueWei ?? message.stampValueWei
      const payments = stampPayments ?? message.stampPayments
      this.sendMessageLocal({
        address,
        senderAddress,
        index: payloadDigest,
        items,
        outpoints: [],
        stampValueWei: value,
        stampPayments: payments,
        status: 'confirmed',
        previousHash: id,
        timestamp: serverTime,
      })
      const chatKey = safeChainDisplayAddress(address) || address
      const chat = this.chats[chatKey] || this.conversations[address]
      if (chat) recomputeChatAccounting(chat, this.activeChatAddr)
      const messageStore = await store
      await messageStore.saveMessage(
        {
          message: {
            outbound: true,
            status: 'confirmed',
            items,
            serverTime,
            receivedTime: serverTime,
            outpoints: [],
            stampValueWei: value,
            stampPayments: payments,
            senderAddress,
          },
          index: payloadDigest,
          outbound: true,
          senderAddress,
          copartyAddress: address,
        },
        { advanceCursor: false },
      )
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
              recomputeChatAccounting(c, this.activeChatAddr)
            }
          }
          for (const c of Object.values(this.chats ?? {})) {
            if (c?.messages?.some(m => m.payloadDigest === id)) {
              c.messages = c.messages.filter(m => m.payloadDigest !== id)
              recomputeChatAccounting(c, this.activeChatAddr)
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
              this.activeChatAddr,
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
          const allChats = [
            ...Object.values(this.conversations ?? {}),
            ...Object.values(this.chats ?? {}),
          ]
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
      await this.setOutgoingState(address, id, 'pending', {})
      if (!stillCurrent()) return { state: 'busy' }
      let ownDigest: string | undefined
      let result: DirectMessageSendResult | undefined
      let lastSendError: unknown
      const maxSendAttempts = 3

      for (let sendAttempt = 1; sendAttempt <= maxSendAttempts; sendAttempt++) {
        if (!stillCurrent()) return { state: 'busy' }
        try {
          result = await activeChain.directMessages.send({
            wallet,
            recipient,
            items: message.items,
            ...(message.stampValueWei === undefined
              ? {}
              : { stampValue: message.stampValueWei }),
            ...(onPreparationProgress === undefined
              ? {}
              : { onPreparationProgress }),
            onAttemptCreated: async attemptDigest => {
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
          break
        } catch (error) {
          lastSendError = error
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
      const allChats = [
        ...Object.entries(this.conversations ?? {}),
        ...Object.entries(this.chats ?? {}),
      ]
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
              chat.address ||
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
      const allChatValues = [
        ...Object.values(this.conversations ?? {}),
        ...Object.values(this.chats ?? {}),
      ]
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
    async clearChatExclusive(address: string): Promise<void> {
      let chat: Conversation | undefined
      if (this.conversations && address in this.conversations) {
        chat = this.conversations[address]
      } else {
        try {
          const displayAddress = toChainDisplayAddress(address)
          chat = this.chats[displayAddress]
        } catch {
          chat = this.chats[address]
        }
      }
      if (!chat) return
      const messageStore = await store
      // This is Clear's atomic cutoff. Composer sends invoked while its durable deletes are in
      // flight may appear optimistically, but are queued after this mutation and must survive.
      const clearingMessages = [...chat.messages]
      const groups = new Map<
        string,
        { digests: Set<string>; suppressions: RelayDeliverySuppression[] }
      >()
      const unscopedDigests = new Set<string>()
      for (const message of clearingMessages) {
        // As above, peer-directed outbound history has no receipt in our mailbox to suppress.
        const recipientAddress = message.outbound
          ? sameCanonicalAddress(address, message.senderAddress)
            ? message.senderAddress
            : null
          : messageDestinationAddress(message)
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
          const receivedTime = observedRelayReceiptTime(message)
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
      const clearedPayloads = new Set<string>()
      for (const message of clearingMessages) {
        clearedPayloads.add(message.payloadDigest)
        delete this.messages[message.payloadDigest]
        const attempt = message.delivery?.attemptDigest
        if (attempt) delete this.messages[attempt]
      }
      chat.messages = chat.messages.filter(
        message => !clearedPayloads.has(message.payloadDigest),
      )
      recomputeChatAccounting(chat, this.activeChatAddr)
    },
    createConversation({
      kind = 'direct',
      name,
      topic,
      emailRecipient,
      participants,
      conversationId,
      initialRole = 'member',
      stampAmount = defaultStampAmount,
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
      stampAmount?: number
      address?: string
      verifiedGateway?: boolean
    }): Conversation {
      const normalizedParticipants = Array.from(
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

      const id =
        conversationId || makeConversationId(normalizedParticipants, topic)
      let conv = this.conversations[id]
      if (!conv && kind === 'direct' && !conversationId) {
        const candidates = Object.values(this.conversations).filter(c => {
          if (c.kind !== 'direct' || c.topic !== topic) return false
          if (
            address &&
            c.address !== address &&
            !sameCanonicalAddress(c.address, address)
          ) {
            return false
          }
          const candidateParticipants = Array.from(
            new Set(
              (c.participants || []).map(p => {
                try {
                  return toChainDisplayAddress(p)
                } catch {
                  return p
                }
              }),
            ),
          ).sort()
          if (
            candidateParticipants.length === normalizedParticipants.length &&
            candidateParticipants.every(
              (p, i) => p === normalizedParticipants[i],
            )
          ) {
            return true
          }
          // Opening a peer before the wallet identity is known creates a one-peer
          // placeholder. Only that explicit recipient can connect it to a full pair;
          // sharing a participant (particularly self) never establishes ownership.
          return (
            !!address &&
            ((candidateParticipants.length === 1 &&
              sameCanonicalAddress(candidateParticipants[0], address) &&
              normalizedParticipants.length <= 2 &&
              normalizedParticipants.some(p =>
                sameCanonicalAddress(p, address),
              )) ||
              (normalizedParticipants.length === 1 &&
                sameCanonicalAddress(normalizedParticipants[0], address) &&
                candidateParticipants.length <= 2 &&
                candidateParticipants.some(p =>
                  sameCanonicalAddress(p, address),
                )))
          )
        })
        conv = candidates.find(c => c.messages.length > 0) || candidates[0]
      }
      if (conv) {
        if (name !== undefined) conv.name = name
        if (topic !== undefined) conv.topic = topic
        if (verifiedGateway !== undefined)
          conv.verifiedGateway = verifiedGateway
        if (emailRecipient !== undefined) conv.emailRecipient = emailRecipient
        conv.deletedAt = undefined
        conv.updatedAt = Date.now()
        if (
          (kind === 'direct' || kind === 'email') &&
          conv.address &&
          conv.address !== conv.id
        ) {
          this.chats[conv.address] = conv
        }
        if (address) {
          this.chats[address] = conv
          try {
            this.chats[toChainDisplayAddress(address)] = conv
          } catch {
            // ignore
          }
        }
        return conv
      }

      const members: Record<string, ConversationMember> = {}
      for (const p of normalizedParticipants) {
        members[p] = { address: p, role: initialRole, joinedAt: Date.now() }
      }

      const displayAddress =
        address ||
        ((kind === 'direct' || kind === 'email') &&
        normalizedParticipants.length === 1
          ? normalizedParticipants[0]
          : id)

      conv = {
        ...defaultContactObject,
        id,
        kind,
        name,
        topic,
        emailRecipient,
        participants: normalizedParticipants,
        members,
        address: displayAddress,
        messages: [],
        stampAmount,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        verifiedGateway,
      }

      this.conversations[id] = conv
      if ((kind === 'direct' || kind === 'email') && displayAddress !== id) {
        try {
          const canonical = toChainDisplayAddress(displayAddress)
          this.chats[canonical] = conv
        } catch {
          this.chats[displayAddress] = conv
        }
      }
      return conv
    },
    createOrOpenEmailConversation({
      recipientEmail,
      subject,
      gatewayAddress = defaultEmailGatewayAddress,
    }: {
      recipientEmail: string
      subject?: string
      gatewayAddress?: string
    }): Conversation {
      const normalizedEmail = recipientEmail.toLowerCase().trim()
      let canonicalGateway = gatewayAddress
      try {
        canonicalGateway = toChainDisplayAddress(gatewayAddress)
      } catch {
        // keep gatewayAddress as is
      }

      // Check if an existing email conversation to this recipient already exists
      const existing = Object.values(this.conversations).find(
        c =>
          c &&
          !c.deletedAt &&
          c.kind === 'email' &&
          (c.emailRecipient?.toLowerCase().trim() === normalizedEmail ||
            c.topic?.toLowerCase().trim() === normalizedEmail ||
            (c.messages.length === 0 &&
              c.name?.toLowerCase().trim() === normalizedEmail)),
      )

      if (existing) {
        if (subject && (!existing.name || existing.name === normalizedEmail)) {
          existing.name = subject
        }
        if (!existing.emailRecipient) {
          existing.emailRecipient = recipientEmail.trim()
        }
        if (existing.verifiedGateway === undefined) {
          existing.verifiedGateway = true
        }
        return existing
      }

      const convId = uuidv5(
        NULL_CONVERSATION_NAMESPACE,
        `email:${normalizedEmail}:${Date.now()}:${Math.random()
          .toString(36)
          .slice(2)}`,
      )

      return this.createConversation({
        kind: 'email',
        conversationId: convId,
        name: subject || recipientEmail.trim(),
        topic: recipientEmail.trim(),
        emailRecipient: recipientEmail.trim(),
        address: canonicalGateway,
        participants: [canonicalGateway],
        verifiedGateway: true,
      })
    },
    async deleteChat(address: string, deletedAt = Date.now()) {
      let displayAddress = address
      try {
        displayAddress = toChainDisplayAddress(address)
      } catch {
        //
      }
      const chat = this.chats[displayAddress] || this.conversations[address]
      await this.clearChat(displayAddress)
      if (this.activeChatAddr === displayAddress) {
        this.activeChatAddr = null
      }
      if (chat) {
        if (this.activeConversationId === chat.id) {
          this.activeConversationId = null
        }
        chat.deletedAt = deletedAt
      }
      delete this.chats[displayAddress]
    },
    async deleteConversation(conversationId: string, deletedAt = Date.now()) {
      const conv = this.conversations[conversationId]
      if (!conv) return
      conv.deletedAt = deletedAt
      if (conv.address && this.chats[conv.address]) {
        await this.clearChat(conv.address)
        delete this.chats[conv.address]
      } else {
        await this.clearChat(conversationId)
      }
      if (this.activeConversationId === conversationId) {
        this.activeConversationId = null
      }
      if (this.activeChatAddr === conv.address) {
        this.activeChatAddr = null
      }
    },
    async clearConversation(conversationId: string): Promise<void> {
      return serializeDeliveryMutation(() =>
        this.clearChatExclusive(conversationId),
      )
    },
    setStampOverride({
      address,
      overrideWei,
    }: {
      address: string
      overrideWei: bigint | undefined
    }) {
      const chat = this.chats[address] || this.conversations[address]
      if (chat) {
        chat.stampOverrideWei = overrideWei
      }
    },
    clearStampOverride(address: string) {
      const chat = this.chats[address] || this.conversations[address]
      if (chat) {
        chat.stampOverrideWei = undefined
      }
    },
    setStampAmount({
      address,
      stampAmount,
    }: {
      address: string
      stampAmount: number
    }) {
      const chat = this.chats[address] || this.conversations[address]
      if (!chat) {
        console.error('attempting to set stamp amount for non-existant contact')
        return
      }
      chat.stampAmount = Math.trunc(stampAmount)
    },
    setActiveChat(address: string | null) {
      // make sure address is defined, e.g. Forum is undefined
      if (!address) {
        this.activeChatAddr = null
        this.activeConversationId = null
        return
      }

      // If address is already a conversation ID in this.conversations:
      if (this.conversations && address in this.conversations) {
        this.activeConversationId = address
        const conv = this.conversations[address]
        this.activeChatAddr = conv?.address || null
        this.readAll(address)
        return
      }

      // make sure address is defined, e.g. Forum is undefined
      if (address) {
        if (isChainAddress(address)) {
          const contacts = useContactStore()
          contacts.refresh(address)
        }
        this.readAll(address)
      }

      let displayAddress: string
      try {
        displayAddress = toChainDisplayAddress(address)
      } catch {
        displayAddress = address
      }
      let conv = this.chats[displayAddress]
      const peerConvs = this.getConversationsForAddress(displayAddress).filter(
        c =>
          c.kind === 'direct' &&
          !c.topic &&
          sameCanonicalAddress(c.address, displayAddress),
      )
      const withMessages = peerConvs.find(c => (c.messages?.length ?? 0) > 0)
      if (withMessages) {
        conv = withMessages
        this.chats[displayAddress] = conv
      } else if (!conv && peerConvs.length > 0) {
        conv = peerConvs[0]
        this.chats[displayAddress] = conv
      }
      if (!conv) {
        conv = this.createConversation({
          kind: 'direct',
          participants: [displayAddress],
          address: displayAddress,
        })
      }
      this.activeChatAddr = displayAddress
      this.activeConversationId = conv.id
    },
    setActiveConversation(conversationId: string | null) {
      if (!conversationId) {
        this.activeConversationId = null
        this.activeChatAddr = null
        return
      }
      let conv = this.conversations[conversationId]
      let activatedByContactAddress: string | null = null
      try {
        const displayAddress = toChainDisplayAddress(conversationId)
        activatedByContactAddress = displayAddress
        const peerConvs = this.getConversationsForAddress(
          displayAddress,
        ).filter(
          c =>
            c.kind === 'direct' &&
            !c.topic &&
            sameCanonicalAddress(c.address, displayAddress),
        )
        const withMessages = peerConvs.find(c => (c.messages?.length ?? 0) > 0)
        if (withMessages) {
          conv = withMessages
          this.chats[displayAddress] = conv
        } else if (!conv) {
          conv = this.chats[displayAddress] || peerConvs[0]
          if (!conv) {
            conv = this.createConversation({
              kind: 'direct',
              participants: [displayAddress],
              address: displayAddress,
            })
          }
        }
      } catch {
        // not a valid chain address and not in conversations
      }
      if (!conv) {
        this.activeConversationId = conversationId
        this.activeChatAddr = null
        return
      }
      this.activeConversationId = conv.id
      if (
        activatedByContactAddress &&
        (conv.kind === 'direct' || conv.kind === 'email')
      ) {
        conv.address = activatedByContactAddress
        this.chats[activatedByContactAddress] = conv
      }
      if ((conv.kind === 'direct' || conv.kind === 'email') && conv.address) {
        this.activeChatAddr = conv.address
        const contacts = useContactStore()
        contacts.refresh(conv.address)
        this.readAll(conv.address)
      } else {
        this.activeChatAddr = null
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
    ): Promise<{
      suppressedReceipts: RelayReceiptIdentity[]
      cancelled: boolean
    }> {
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
      const deliverableWrappers = messageWrappers.filter(wrapper => {
        if (!suppressedDigests.has(wrapper.index)) return true
        toNotify.delete(wrapper.index)
        return false
      })
      const outboundMatches = new Map<string, OutboundDeliveryMatch>()
      const replacedAccountCollisions = new Map<
        string,
        { chatAddress: string; oldIndex: string }
      >()

      const owners = indexOutboundDeliveryOwners({
        ...(this.conversations ?? {}),
        ...(this.chats ?? {}),
      })

      for (const wrapper of deliverableWrappers) {
        const confirmed = owners.byPayload.get(wrapper.index)
        const owner = confirmed ?? owners.byAttempt.get(wrapper.index)
        if (!owner) continue
        const { chatAddress, index: oldIndex, message: existing } = owner
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
          // The local outbox owns content/direction. The relay owns only delivery time and the
          // observed stamp metadata; never spread an inbox wrapper over the outbound record.
          outboundMatches.set(wrapper.index, {
            oldIndex,
            chatAddress,
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
              delivery: undefined,
            },
          })
        } else {
          // A payload from an earlier account can legitimately arrive after Replace Account.
          // It is a new inbound record for the current identity, not the old account's outbox.
          replacedAccountCollisions.set(wrapper.index, {
            chatAddress,
            oldIndex,
          })
          toNotify.add(wrapper.index)
        }
      }

      for (const wrapper of deliverableWrappers) {
        // An index this call did not claim belongs to an overlapping receive.
        // Do not persist it: if the claimer fails before storing, a later poll
        // must still be able to notify.
        if (!toNotify.has(wrapper.index) && !(wrapper.index in this.messages)) {
          continue
        }
        const loopback = outboundMatches.get(wrapper.index)
        const persisted: MessageWrapper = {
          message: loopback?.message ?? { ...wrapper.message },
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
        const mutation = mutationFor(loopback.chatAddress)
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
        mutationFor(collision.chatAddress).removals.add(collision.oldIndex)
        delete this.messages[collision.oldIndex]
      }
      for (const [chatAddress, mutation] of chatMutations) {
        const chat = this.chats[chatAddress]
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
        recomputeChatAccounting(chat, this.activeChatAddr)
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
        const rawConvId =
          (newMsg as any).conversationId ||
          (wrapper as any).conversationId ||
          (newMsg as any).topicId
        const convName =
          (newMsg as any).conversationName ||
          (newMsg as any).subject ||
          emailItem?.subject ||
          (newMsg as any).name
        const isEmail = !!emailItem
        const kind = isEmail ? 'email' : 'direct'
        const participants = ownAddress
          ? Array.from(new Set([ownAddress, displayAddress])).sort()
          : [displayAddress]

        let conv: Conversation | undefined
        if (rawConvId) {
          const topicConvId = makeConversationId(participants, rawConvId)
          if (this.conversations[rawConvId]) {
            conv = this.conversations[rawConvId]
          } else if (this.conversations[topicConvId]) {
            conv = this.conversations[topicConvId]
          }
        }

        const convId =
          kind === 'direct'
            ? makeConversationId(participants)
            : rawConvId
            ? makeConversationId(participants, rawConvId)
            : makeConversationId(participants)

        const trustedGateway = getTrustedEmailGatewayAddress()
        const isVerifiedGateway = newMsg.outbound
          ? sameCanonicalAddress(copartyAddress, trustedGateway) ||
            sameCanonicalAddress(displayAddress, trustedGateway)
          : sameCanonicalAddress(newMsg.senderAddress, trustedGateway)

        if (!conv) {
          conv =
            this.chats[displayAddress] ||
            (copartyAddress ? this.chats[copartyAddress] : undefined) ||
            this.conversations[convId]
        }

        if (!conv) {
          conv = this.createConversation({
            kind,
            participants,
            conversationId: convId,
            name: convName,
            address: displayAddress,
            verifiedGateway: emailItem ? isVerifiedGateway : undefined,
          })
        }

        this.conversations[conv.id] = conv
        this.chats[displayAddress] = conv
        if (copartyAddress) {
          this.chats[copartyAddress] = conv
        }

        // Tombstone check: ignore replayed/older messages for a deleted conversation
        if (conv.deletedAt !== undefined) {
          if (newMsg.serverTime <= conv.deletedAt) {
            continue
          }
          // Newer message: reopen the conversation!
          conv.deletedAt = undefined
          this.chats[displayAddress] = conv
        }

        // Renaming: update conversation name if provided
        if (
          convName !== undefined &&
          typeof convName === 'string' &&
          convName.trim().length > 0
        ) {
          conv.name = convName
          conv.updatedAt = Date.now()
        }

        ;(newMsg as any).conversationId = conv.id
        const message: ChatMessage = {
          ...newMsg,
          payloadDigest: index,
          conversationId: conv.id,
          logicalMessageId: (newMsg as any).logicalMessageId || index,
          revisionDigest: (newMsg as any).revisionDigest || index,
          deliveryDigest: index,
        }

        if (newMsg.items && Array.isArray(newMsg.items)) {
          for (const item of newMsg.items) {
            if (
              item &&
              (item.type === 'wallet-sync' || item.type === 'payment-transfer')
            ) {
              try {
                void routeWalletSyncItem(item as WalletSyncItem, {
                  resolver: appMultiChainResolver,
                }).catch(err => {
                  console.warn('[chats] failed to route wallet sync item:', err)
                })
              } catch {
                // ignore
              }
            } else if (item && item.type === 'swap-record') {
              try {
                void import('./swaps').then(({ useSwapStore }) => {
                  useSwapStore().handleSwapItem(item as SwapRecordItem)
                })
              } catch {
                // ignore
              }
            }
          }
        }

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
            conv.messages.sort(
              (a, b) =>
                (a.serverTime ?? a.receivedTime ?? 0) -
                (b.serverTime ?? b.receivedTime ?? 0),
            )
          }
          if (emailItem) {
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
        this.chats[displayAddress] = conv
        if (!conv.messages.some(m => m.payloadDigest === index)) {
          conv.messages.push(message)
          conv.messages.sort(
            (a, b) =>
              (a.serverTime ?? a.receivedTime ?? 0) -
              (b.serverTime ?? b.receivedTime ?? 0),
          )
        }

        if (emailItem) {
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
          displayAddress !== this.activeChatAddr &&
          conv.id !== this.activeConversationId &&
          conv.lastRead < message.serverTime
        ) {
          conv.totalUnreadValue += messageValue
          conv.totalUnreadMessages += 1
        } else if (
          displayAddress === this.activeChatAddr ||
          conv.id === this.activeConversationId
        ) {
          // The receipt was visible while this chat was active. Persist that read decision so
          // navigating elsewhere and reloading cannot reconstruct it as unread.
          conv.lastRead = Math.max(conv.lastRead, message.serverTime)
        }
        this.lastReceived = message.serverTime
        conv.totalValue += messageValue
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
        if (!contacts.isContact(copartyAddress)) {
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
          this.lastRead(copartyAddress) > newMsg.serverTime ||
          messageWrappers.length !== 1
        ) {
          continue
        }

        const contact = contacts.getContact(copartyAddress)
        const textItem: TextItem = (newMsg.items.find(
          item => item.type === 'text',
        ) as TextItem) ?? { text: '' }
        const stealthItem: StealthItem = (newMsg.items.find(
          item => item.type === 'stealth',
        ) as StealthItem) ?? { amount: 0 }
        const imageItem: ImageItem = (newMsg.items.find(
          item => item.type === 'image',
        ) as ImageItem) ?? { image: '' }
        let body = ''
        if (stealthItem.amount > 0) {
          body = `[${formatBalance(stealthItem.amount)}] `
        }
        if (imageItem.image.length > 0) body += '[Image] '
        body += textItem.text
        if (contact?.notify) {
          desktopNotify(
            contact.profile.name ?? 'Unknown',
            body,
            contact.profile.avatar ?? '',
            async () => (this.activeChatAddr = copartyAddress),
            index,
          )
        }
      }
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const serializedConversations = state.conversations
        ? mapObjIndexed((convData: Record<string, unknown>) => {
            return {
              ...convData,
              messages: [],
            }
          }, state.conversations)
        : {}
      const chats = {
        activeChatAddr: pathOr(undefined, ['activeChatAddr'], state),
        activeConversationId: pathOr(
          undefined,
          ['activeConversationId'],
          state,
        ),
        conversations: serializedConversations,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        chats: mapObjIndexed((addressData: Record<string, unknown>) => {
          return {
            ...addressData,
            // Overwrite messages because storing them would be prohibitive.
            messages: [],
          }
        }, state.chats),
        messages: {},
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
      if (invalidStore) {
        return freshChatsState()
      }

      const rehydratedChat = await rehydateChat(deserializedChats)

      return rehydratedChat
    },
  },
})
