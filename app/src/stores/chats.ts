import type { GroupEpochCertificate } from '@frank/cashweb/groups/types'
import type {
  GroupWelcomeItem,
  GroupControlItem,
} from '@frank/group-messaging/types'
import { encodeItemFrames } from '@frank/wallet/message-item-plugins/wire'
import {
  encodeGroupItems,
  decodeGroupItems,
} from '../utils/group-message-items'
import { fetchContactProfile } from '../utils/directory-peer'
import { directoryAddress } from '@frank/cashweb/relay/open-directory'
import assert from 'assert'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

import { displayNetwork } from '../utils/constants'
import { randomBytes } from '@noble/hashes/utils'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { picturePreview, picturePreviewText } from '../utils/chat-attachments'
import { desktopNotify } from '../utils/notifications'
import {
  acknowledgeServiceWorkerWakeupHandled,
  deriveLocalPeerWakeupCapabilitySync,
} from '../utils/webpush-sync'
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
import { createCooperativeBatchYielder } from '@frank/wallet/chain/event-loop-yield'
import { sendsWaitingBlocks } from '../utils/outgoing-payments'
import { messageItems } from '../utils/message-items'

import {
  CanonicalMessagingPendingError,
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
} from '@frank/wallet/evm-stamp-client'
import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/mailbox-client'
import {
  messagingWallet,
  waitForMessagingReady,
} from '../utils/identity-session'
import type {
  Message,
  MessageWrapper,
  MessageItem,
  OutgoingDelivery,
  OutgoingFinancialOperation,
  OutgoingFailureReason,
  TextItem,
  StealthItem,
  SwapRecordItem,
  EmailItem,
  ConversationStateItem,
  OutboxMessageItem,
  MessageTombstoneItem,
  JournalCheckpointItem,
} from '@frank/cashweb/types/messages'
import {
  bytesToHex,
  decryptGroupRoster,
  computeInnerMessageSigningHash,
  deriveEpochKeys,
  formatGroupIdentifier,
  groupConversationUuid,
  isGroupConversationId,
  hexToBytes,
  isGroupIdentifier,
  openGroupMessage,
  verifyEpochFrame,
  verifyGroupMessageWriteSignature,
  parseGroupIdentifier,
  sealGroupMessage,
  type GroupRosterMember,
  type SealedGroupMessageEnvelope,
} from '@frank/cashweb/groups/group-crypto'
import {
  GroupRelayClient,
  normalizeGroupRelayOrigin,
  prepareGroupCreation,
  prepareGroupEpochRotation,
  groupEpochCertificate,
  openGroupEpochCertificate,
  groupAdminSecretMatches,
  deriveAdminEpochSecret,
  type CreateGroupOnRelayMemberInput,
} from '@frank/cashweb/groups/group-relay-client'
import { sha256 } from '@noble/hashes/sha256.js'
import {
  joinDeliveryStatus,
  joinMessageTimestamp,
  toDeliveryStatus,
} from '@frank/wallet/journal/semilattice-state'
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
import { captureOutgoingApplicationAuthorization } from '../utils/outgoing-application-authorization'
import { captureOutgoingFinancialOperations } from '../stealth-payments/outgoing'

export type ChatMessage = {
  requestedConversationId?: string
  groupEnvelope?: SealedGroupMessageEnvelope
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
export type GroupMembershipStatus = 'invited' | 'joined' | 'declined' | 'left'

export interface PendingParticipantRequest {
  senderAddress: string
  senderConversationId: string
  referencedConversationId: string
  payloadDigest: string
  receivedAt: number
}

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

/** A membership change the user asked for: the member it adds or removes. */
export interface GroupMemberChange {
  action: 'add-member' | 'remove-member'
  address: string
}

type GroupMemberDeliveries = Record<
  string,
  { items: MessageItem[]; operationId: string }[]
>

export interface GroupConversationState {
  groupIdHex: string
  groupPubKeyHex: string
  groupSecretKeyHex?: string
  homeRelay: string
  epoch: number
  epochSecretHex: string
  prevEpochHashHex: string
  memberIndex: number
  pendingControls?: Record<
    number,
    { item: GroupControlItem; senderAddress: string; serverTime: number }
  >
  /** A prepared epoch persisted before its relay publication. At creation it is the current
   * epoch 0. A rotation is the successor of the current epoch and is not applied locally until
   * the relay acknowledges it, so a lost CAS race leaves the current epoch intact. */
  pendingEpoch?: {
    certificate: GroupEpochCertificate
    expectedPreviousHash?: string
    /** Rotation only: the prepared successor's secret. */
    epochSecretHex?: string
    /** Rotation only: deliveries that are queued once the successor is published. */
    memberDeliveries?: GroupMemberDeliveries
    /** Rotation only: the change it makes. Queued deliveries to a removed member are dropped
     * on publication. */
    memberChange?: GroupMemberChange
  }
  /** A membership change the user asked for that another device of this administrator
   * account superseded: it was never published. Shown until the roster holds it or the user
   * dismisses it; it is retried only by the user. */
  supersededMemberChange?: GroupMemberChange
  pendingMessages?: Record<string, true>
  pendingMemberDeliveries?: GroupMemberDeliveries
  /** Highest epoch of an accepted mailbox row; a later row of an older epoch is not accepted. */
  highestSyncedEpoch?: number
  syncFailed?: boolean
  epochFrame: GroupEpochCertificate
  epochHistory: Record<
    number,
    {
      epochSecretHex: string
      roster: GroupRosterMember[]
      epochFrame: GroupEpochCertificate
    }
  >
  lastSyncedSeq: number
  roster: GroupRosterMember[]
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
  pendingParticipantRequests?: Record<string, PendingParticipantRequest>
  dismissedParticipantRequests?: Record<string, number>
  /** Issue #70 / #1365: Shared group mailbox metadata and invitation gate state. */
  membershipStatus?: GroupMembershipStatus
  invitedBy?: string
  groupId?: string
  groupPubKey?: string
  groupRelayUrl?: string
  groupEpochSecretHex?: string
  groupMemberIndex?: number
  groupState?: GroupConversationState
  /** Issue #1365: Third-party senders who referenced this 1:1 direct conversation ID. */
  messages: ChatMessage[]
  totalUnreadMessages: number
  /** Relay-verified stamps only, in the messaging chain's base unit (`accountedMessageValue`).
   * Never a claimed payment. The list's unread value in AVU is `unreadValueAvu`. */
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

import {
  type ChatState,
  NULL_CONVERSATION_NAMESPACE,
  type OutboundDeliveryMatch,
  type OutboundDeliveryOwner,
  accountedMessageValue,
  byRelayTime,
  clearedUpTo,
  collidedMessageId,
  defaultContactObject,
  freeMessageId,
  getTrustedEmailGatewayAddress,
  inDeletedConversation,
  indexOutboundDeliveryOwners,
  isAnotherMessage,
  isOwnMessage,
  isUntimedOutgoing,
  makeParticipantsKey,
  messageDestinationAddress,
  messageStampPrice,
  newestRelayTime,
  observedRelayReceiptTime,
  recomputeChatAccounting,
  recordLogicalMessage,
  reopenConversation,
  speaksForConversation,
  stripReleasedPayments,
  tombstoneMailbox,
  tombstoneReceiptTime,
  tombstonedTargetsFor,
  uuidv5,
  walletOwnsMessage,
} from './chats-domain'
import {
  classifySendFailure,
  errorDetail,
  isInsufficientFundsError,
  isNoResponseError,
  normalizeOutboxWrapper,
  ownConversationStates,
  ownJournalCheckpoints,
  ownMessageTombstones,
  ownSwapRecords,
} from './chats-self-notes'
export {
  type ChatState,
  NULL_CONVERSATION_NAMESPACE,
  collidedMessageId,
  getTrustedEmailGatewayAddress,
  indexOutboundDeliveryOwners,
  makeParticipantsKey,
  recordLogicalMessage,
  stripReleasedPayments,
  uuidv5,
  walletOwnsMessage,
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
    composeFocusRequest: null,
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
  let release: () => void = () => undefined
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
    note.subject = usableSubject(conversation.name ?? conversation.topic) ?? ''
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
    note.subject ===
      (usableSubject(conversation.name ?? conversation.topic) ?? '')
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
      .filter(c => c.kind !== 'group' && c.address && isChainAddress(c.address))
      .map(c => safeChainDisplayAddress(c.address) || c.address),
  )
  return Object.fromEntries(
    [...peers]
      .map(peer => [peer, peerThread(conversations, peer)] as const)
      .filter(([, thread]) => thread !== undefined),
  )
}

/**
 * Heals only genuine legacy address-keyed duplicate entries for a peer's default direct thread.
 * Preserves all conversations with explicit canonical conversation IDs (UUIDv4, UUIDv5, conv:...),
 * email/bot/group threads, and conversations carrying a topic/subject, and never aliases `self`
 * to a remote peer's conversation.
 */
export function autoHealDuplicateDirectConversations(
  arg1:
    | {
        conversations: Record<string, Conversation>
        chats?: Record<string, ChatState | undefined>
        ownAddress?: string | null
        activeChatAddr?: string | null
        activeConversationId?: string | null
        messages?: Record<string, ChatMessage | Message | undefined>
        logicalMessages?: Record<string, LogicalMessageRecord | undefined>
      }
    | Record<string, Conversation>,
  arg2?: Record<string, LogicalMessageRecord | undefined>,
  arg3?: string | null,
): void {
  const isOptionsObj =
    arg1 !== null &&
    typeof arg1 === 'object' &&
    'conversations' in arg1 &&
    typeof arg1.conversations === 'object' &&
    arg1.conversations !== null &&
    !('kind' in (arg1.conversations as Record<string, unknown>))
  const conversations = isOptionsObj
    ? (arg1 as { conversations: Record<string, Conversation> }).conversations
    : (arg1 as Record<string, Conversation>)
  const ownAddress = isOptionsObj
    ? (arg1 as { ownAddress?: string | null }).ownAddress ?? null
    : getOwnCanonicalAddress()
  const activeConversationId = isOptionsObj
    ? (arg1 as { activeConversationId?: string | null }).activeConversationId ??
      null
    : arg3 ?? null
  const messages = isOptionsObj
    ? (
        arg1 as {
          messages?: Record<string, ChatMessage | Message | undefined>
        }
      ).messages
    : undefined
  const logicalMessages = isOptionsObj
    ? (
        arg1 as {
          logicalMessages?: Record<string, LogicalMessageRecord | undefined>
        }
      ).logicalMessages
    : arg2

  const isExplicitIdentity = (conv: Conversation, key: string): boolean => {
    if (conv.kind === 'email' || conv.kind === 'group') return true
    if (usableSubject(conv.name ?? conv.topic) !== undefined) return true
    if (key.startsWith('conv:') || conv.id.startsWith('conv:')) return true
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        conv.id,
      ) &&
      key === conv.id
    ) {
      return true
    }
    return false
  }

  for (const [key, conv] of Object.entries(conversations)) {
    if (!conv || isExplicitIdentity(conv, key)) continue
    if (!isChainAddress(conv.address)) continue
    const peer = safeChainDisplayAddress(conv.address) || conv.address
    if (
      ownAddress &&
      sameCanonicalAddress(peer, ownAddress) &&
      conv.participants.some(p => !sameCanonicalAddress(p, ownAddress))
    ) {
      continue
    }
    const primary =
      peerThread(conversations, peer) ??
      Object.values(conversations).find(
        c =>
          c &&
          c !== conv &&
          c.kind === 'direct' &&
          isOpeningConversationId(c.id) &&
          sameCanonicalAddress(c.address, peer) &&
          usableSubject(c.name ?? c.topic) === undefined,
      )
    if (!primary || primary === conv) continue
    if (
      makeParticipantsKey(primary.participants) !==
        makeParticipantsKey(conv.participants) &&
      primary.participants.length > 1 &&
      conv.participants.length > 1
    ) {
      continue
    }
    for (const msg of conv.messages ?? []) {
      msg.conversationId = primary.id
      if (!primary.messages.some(m => m.payloadDigest === msg.payloadDigest)) {
        primary.messages.push(msg)
      }
      if (messages && messages[msg.payloadDigest]) {
        messages[msg.payloadDigest]!.conversationId = primary.id
      }
      const logicalId = msg.logicalMessageId || msg.payloadDigest
      if (
        logicalMessages?.[logicalId] &&
        logicalMessages[logicalId]?.conversationId === conv.id
      ) {
        logicalMessages[logicalId]!.conversationId = primary.id
      }
    }
    primary.messages.sort(byRelayTime)
    primary.lastRead = Math.max(primary.lastRead ?? 0, conv.lastRead ?? 0)
    primary.lastReceived = Math.max(
      primary.lastReceived ?? 0,
      conv.lastReceived ?? 0,
    )
    recomputeChatAccounting(primary, activeConversationId)
    delete conversations[key]
  }
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
  return (
    (subject ?? '') >=
    (usableSubject(conversation.name ?? conversation.topic) ?? '')
  )
}

/** Gives the conversation a subject that {@link subjectReplaces} its current one. A subject
 * the user set here and has not noted yet is replaced with it: there is nothing left to note. */
function setSubject(
  conversation: Conversation,
  subject: string | undefined,
  setAt: number,
): void {
  const current = conversation.name ?? conversation.topic
  if (current !== subject) {
    conversation.updatedAt = Date.now()
    conversation.subjectToNote = undefined
  }
  conversation.name = subject
  if (conversation.topic !== undefined) {
    conversation.topic = subject
  }
  conversation.nameSetAt = setAt
}

/** The subject the next message sent in `conversation` must carry, if any: its subject when no
 * message has carried that subject yet (a new conversation with a subject, or a rename). */
function subjectToCarry(
  conversation: Conversation | undefined,
): string | undefined {
  if (!conversation || conversation.kind === 'email') return undefined
  const subject = usableSubject(conversation.name ?? conversation.topic)
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
    conversation.kind === 'group' && conversation.address === address
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
  if (conversation.kind === 'group') return
  const member = safeChainDisplayAddress(address) || address
  if (
    conversation.kind === 'direct' &&
    isChainAddress(conversation.address) &&
    !sameCanonicalAddress(member, conversation.address)
  )
    return
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

function verifyStoredGroupMessage(
  conv: Conversation,
  message: Message,
  index: string,
): void {
  const state = conv.groupState
  const envelope = message.groupEnvelope
  if (!state || !envelope)
    throw new Error(
      'Stored group message requires its original signed envelope',
    )
  const epoch =
    envelope.epoch === state.epoch ? state : state.epochHistory[envelope.epoch]
  if (!epoch) throw new Error('Stored group message epoch is not authorized')
  const keys = deriveEpochKeys(
    hexToBytes(epoch.epochSecretHex),
    state.groupIdHex,
    envelope.epoch,
  )
  const opened = openGroupMessage({
    envelope,
    epochKeys: keys,
    roster: epoch.roster,
  })
  if (opened.innerDigestHex !== index)
    throw new Error(
      'Stored group message requires its original signed envelope',
    )
  if (
    !sameCanonicalAddress(opened.senderAddress, message.senderAddress) ||
    JSON.stringify(decodeGroupItems(opened.payload)) !==
      JSON.stringify(message.items)
  )
    throw new Error(
      'Stored group message content or sender differs from its signature',
    )
}

function isThirdPartyDirectClaim(
  conv: Conversation,
  message: Pick<Message, 'outbound' | 'senderAddress'>,
  ownAddress: string | null,
): boolean {
  return (
    conv.kind === 'direct' &&
    isChainAddress(conv.address) &&
    !message.outbound &&
    !sameCanonicalAddress(message.senderAddress, ownAddress) &&
    !sameCanonicalAddress(message.senderAddress, conv.address)
  )
}
function recordParticipantRequest(
  conv: Conversation | undefined,
  request: PendingParticipantRequest,
): void {
  if (
    !conv ||
    conv.kind !== 'direct' ||
    conv.deletedAt ||
    request.receivedAt <=
      (conv.dismissedParticipantRequests?.[request.senderAddress] ?? -1)
  )
    return
  const existing = conv.pendingParticipantRequests?.[request.senderAddress]
  if (existing && existing.receivedAt >= request.receivedAt) return
  conv.pendingParticipantRequests = {
    ...conv.pendingParticipantRequests,
    [request.senderAddress]: request,
  }
}

/** Read-only validation of the new group baseline; never reset or rewrite saved key material. */
function validateStoredGroupConversation(conv: Conversation): void {
  const state = conv.groupState
  if (
    !state ||
    !state.epochFrame ||
    !state.epochHistory ||
    conv.id !== groupConversationUuid(state.groupIdHex) ||
    conv.address !== formatGroupIdentifier(state.groupIdHex) ||
    conv.groupPubKey !== state.groupPubKeyHex ||
    state.prevEpochHashHex !== state.epochFrame.epoch_hash ||
    !Number.isSafeInteger(state.lastSyncedSeq) ||
    state.lastSyncedSeq < 0 ||
    !['invited', 'joined', 'declined', 'left'].includes(
      conv.membershipStatus ?? '',
    )
  )
    throw new Error(
      'Unsupported stored group format: signed epoch metadata required',
    )
  const epochs = { ...state.epochHistory, [state.epoch]: state }
  for (const [epoch, record] of Object.entries(epochs)) {
    const { roster } = openGroupEpochCertificate({
      groupIdHex: state.groupIdHex,
      groupPubKeyHex: state.groupPubKeyHex,
      epochSecretHex: record.epochSecretHex,
      certificate: record.epochFrame,
      expectedEpoch: Number(epoch),
    })
    if (JSON.stringify(record.roster) !== JSON.stringify(roster.members))
      throw new Error('Stored group roster differs from signed certificate')
    if (
      Number(epoch) === state.epoch &&
      (conv.name !== roster.groupName || state.homeRelay !== roster.homeRelay)
    )
      throw new Error(
        'Stored group presentation differs from signed certificate',
      )
  }
  const ordered = Object.entries(epochs).sort(
    ([a], [b]) => Number(a) - Number(b),
  )
  for (let index = 1; index < ordered.length; index += 1) {
    const [previousEpoch, previous] = ordered[index - 1]
    const [epoch, record] = ordered[index]
    if (
      Number(epoch) !== Number(previousEpoch) + 1 ||
      record.epochFrame.prev_epoch_hash !== previous.epochFrame.epoch_hash
    )
      throw new Error('Stored group epoch lineage is incomplete')
  }
  if (
    state.groupSecretKeyHex &&
    !groupAdminSecretMatches(state.groupSecretKeyHex, state.groupPubKeyHex)
  )
    throw new Error('Invalid stored group administrative secret')
  const pending = state.pendingEpoch
  if (
    pending &&
    pending.certificate.epoch_hash !== state.epochFrame.epoch_hash
  ) {
    if (
      !pending.epochSecretHex ||
      !state.groupSecretKeyHex ||
      pending.expectedPreviousHash !== state.epochFrame.epoch_hash
    )
      throw new Error('Stored pending group epoch mismatch')
    openGroupEpochCertificate({
      groupIdHex: state.groupIdHex,
      groupPubKeyHex: state.groupPubKeyHex,
      epochSecretHex: pending.epochSecretHex,
      certificate: pending.certificate,
      expectedPreviousHash: state.epochFrame.epoch_hash,
      expectedEpoch: state.epoch + 1,
    })
  }
}

/** Rebuild presentation from the signed roster; the certificate is the authority. */
function applyAuthenticatedGroupEpoch(
  conv: Conversation,
  certificate: GroupEpochCertificate,
  epochSecretHex: string,
  ownAddress: string | null,
  serverTime: number,
): void {
  const previous = conv.groupState
  const { roster } = openGroupEpochCertificate({
    groupIdHex: conv.groupId!,
    groupPubKeyHex: conv.groupPubKey!,
    epochSecretHex,
    certificate,
    ...(previous
      ? {
          expectedPreviousHash: previous.prevEpochHashHex,
          expectedEpoch: previous.epoch + 1,
        }
      : {}),
  })
  if (
    previous &&
    previous.roster.find(member => member.role === 'admin')?.address !==
      roster.members.find(member => member.role === 'admin')?.address
  )
    throw new Error('Group founding administrator cannot change')
  const own = roster.members.find(
    member => ownAddress && sameCanonicalAddress(member.address, ownAddress),
  )
  // A prepared rotation names the epoch it follows. Applying it publishes its queued
  // deliveries; applying any other successor means it can never be published, and its
  // deliveries, which were never sent, are dropped with it.
  const rotation = previous?.pendingEpoch?.epochSecretHex
    ? previous.pendingEpoch
    : undefined
  let pendingMemberDeliveries = previous?.pendingMemberDeliveries
  let supersededMemberChange = previous?.supersededMemberChange
  if (
    rotation?.memberChange &&
    rotation.certificate.epoch_hash !== certificate.epoch_hash
  )
    supersededMemberChange = rotation.memberChange
  // The roster already holds the change, whoever made it: nothing is left to retry.
  const change = supersededMemberChange
  const isMember =
    change &&
    roster.members.some(member =>
      sameCanonicalAddress(member.address, change.address),
    )
  if (change && isMember === (change.action === 'add-member'))
    supersededMemberChange = undefined
  if (rotation && rotation.certificate.epoch_hash === certificate.epoch_hash) {
    const removed =
      rotation.memberChange?.action === 'remove-member'
        ? rotation.memberChange.address
        : undefined
    pendingMemberDeliveries = Object.fromEntries(
      Object.entries(pendingMemberDeliveries ?? {}).filter(
        ([address]) => !removed || !sameCanonicalAddress(address, removed),
      ),
    )
    for (const [address, deliveries] of Object.entries(
      rotation.memberDeliveries ?? {},
    ))
      pendingMemberDeliveries[address] = [
        ...(pendingMemberDeliveries[address] ?? []),
        ...deliveries,
      ]
  }
  const history = { ...previous?.epochHistory }
  if (previous)
    history[previous.epoch] = {
      epochSecretHex: previous.epochSecretHex,
      roster: previous.roster,
      epochFrame: previous.epochFrame,
    }
  conv.groupState = {
    groupIdHex: conv.groupId!,
    groupPubKeyHex: conv.groupPubKey!,
    groupSecretKeyHex: previous?.groupSecretKeyHex,
    homeRelay: roster.homeRelay,
    epoch: certificate.epoch,
    epochSecretHex,
    prevEpochHashHex: certificate.epoch_hash,
    memberIndex: own?.index ?? -1,
    lastSyncedSeq: previous?.lastSyncedSeq ?? 0,
    roster: [...roster.members],
    epochFrame: certificate,
    epochHistory: history,
    pendingMessages: previous?.pendingMessages,
    pendingEpoch: rotation ? undefined : previous?.pendingEpoch,
    pendingControls: previous?.pendingControls,
    pendingMemberDeliveries,
    highestSyncedEpoch: previous?.highestSyncedEpoch,
    supersededMemberChange,
  }
  conv.groupEpochSecretHex = epochSecretHex
  conv.groupMemberIndex = own?.index
  conv.groupRelayUrl = roster.homeRelay
  conv.name = roster.groupName
  conv.participants = roster.members.map(member => member.address).sort()
  conv.members = Object.fromEntries(
    roster.members.map(member => [
      member.address,
      {
        address: member.address,
        role: member.role ?? 'member',
        pubKeyHex: member.epochSigningPubKeyHex,
      },
    ]),
  )
  conv.epoch = {
    epochId: certificate.epoch_hash,
    generation: certificate.epoch,
    updatedAt: serverTime,
  }
  if (!own) conv.membershipStatus = 'left'
}

/** Invitations are authenticated DMs carrying a root-signed epoch certificate. */
function applyGroupWelcomeItem(
  conversations: Record<string, Conversation>,
  welcome: GroupWelcomeItem,
  message: {
    outbound: boolean
    senderAddress: string
    destinationAddress?: string
    serverTime: number
  },
  ownAddress: string | null,
): Conversation {
  const groupId = parseGroupIdentifier(formatGroupIdentifier(welcome.groupId))!
  const id = groupConversationUuid(groupId)
  const existing = conversations[id]
  if (
    welcome.adminSecretKeyHex &&
    (!ownAddress ||
      !isOwnMessage(message) ||
      !sameCanonicalAddress(message.senderAddress, ownAddress) ||
      !groupAdminSecretMatches(welcome.adminSecretKeyHex, welcome.groupPubKey))
  )
    throw new Error(
      'Group administrative secret requires authenticated self delivery',
    )
  const { roster } = openGroupEpochCertificate({
    groupIdHex: groupId,
    groupPubKeyHex: welcome.groupPubKey,
    epochSecretHex: welcome.epochSecretHex,
    certificate: welcome.epochFrame,
    expectedEpoch: welcome.epoch,
  })
  const inviter = roster.members.find(member =>
    sameCanonicalAddress(member.address, message.senderAddress),
  )
  const own = roster.members.find(
    member => ownAddress && sameCanonicalAddress(member.address, ownAddress),
  )
  if (
    !inviter ||
    inviter.role !== 'admin' ||
    !own ||
    own.index !== welcome.memberIndex ||
    (welcome.inviterAddress &&
      !sameCanonicalAddress(welcome.inviterAddress, message.senderAddress)) ||
    roster.groupName !== welcome.groupName ||
    roster.homeRelay !== welcome.homeRelay
  )
    throw new Error('Invalid group invitation')
  if (existing) {
    if (existing.groupPubKey !== welcome.groupPubKey)
      throw new Error('Group authority mismatch')
    const admin = existing.groupState?.roster.find(
      member => member.role === 'admin',
    )
    if (!admin || !sameCanonicalAddress(admin.address, message.senderAddress))
      throw new Error('Unauthorized group invitation update')
    if (welcome.epoch <= (existing.groupState?.epoch ?? -1)) {
      if (
        welcome.epoch === existing.groupState?.epoch &&
        welcome.epochFrame.epoch_hash !==
          existing.groupState.epochFrame.epoch_hash
      )
        throw new Error('Conflicting group epoch')
      if (welcome.adminSecretKeyHex)
        existing.groupState!.groupSecretKeyHex = welcome.adminSecretKeyHex
      return existing
    }
    applyAuthenticatedGroupEpoch(
      existing,
      welcome.epochFrame,
      welcome.epochSecretHex,
      ownAddress,
      message.serverTime,
    )
    if (welcome.adminSecretKeyHex)
      existing.groupState!.groupSecretKeyHex = welcome.adminSecretKeyHex
    return existing
  }
  const conv = newConversation({
    id,
    kind: 'group',
    address: formatGroupIdentifier(groupId),
    groupId,
    groupPubKey: welcome.groupPubKey,
    invitedBy: message.senderAddress,
    membershipStatus: isOwnMessage(message) ? 'joined' : 'invited',
    participants: [],
    members: {},
  })
  applyAuthenticatedGroupEpoch(
    conv,
    welcome.epochFrame,
    welcome.epochSecretHex,
    ownAddress,
    message.serverTime,
  )
  if (welcome.adminSecretKeyHex)
    conv.groupState!.groupSecretKeyHex = welcome.adminSecretKeyHex
  conversations[id] = conv
  return conv
}

/** Only the prior administrator may deliver a root-signed consecutive epoch. */
function applyGroupControlItem(
  conversations: Record<string, Conversation>,
  control: GroupControlItem,
  message: {
    outbound: boolean
    senderAddress: string
    destinationAddress?: string
    serverTime: number
  },
  ownAddress: string | null,
): void {
  const conv = conversations[groupConversationUuid(control.groupId)]
  if (!conv || conv.kind !== 'group' || !conv.groupState) return
  if (control.epoch <= conv.groupState.epoch) {
    const known =
      control.epoch === conv.groupState.epoch
        ? conv.groupState.epochFrame
        : conv.groupState.epochHistory[control.epoch]?.epochFrame
    if (known && known.epoch_hash !== control.epochFrame.epoch_hash)
      throw new Error('Conflicting group epoch')
    return
  }
  const admin = conv.groupState.roster.find(member => member.role === 'admin')
  if (!admin || !sameCanonicalAddress(admin.address, message.senderAddress))
    throw new Error('Unauthorized group control')
  if (
    !control.epochSecretHex ||
    control.epochFrame.epoch !== control.epoch ||
    control.authoritySigHex !== control.epochFrame.authority_sig
  )
    throw new Error('Invalid group control certificate')
  openGroupEpochCertificate({
    groupIdHex: conv.groupState.groupIdHex,
    groupPubKeyHex: conv.groupState.groupPubKeyHex,
    epochSecretHex: control.epochSecretHex,
    certificate: control.epochFrame,
    expectedEpoch: control.epoch,
  })
  if (control.epoch > conv.groupState.epoch + 1) {
    conv.groupState.pendingControls ??= {}
    if (Object.keys(conv.groupState.pendingControls).length >= 256)
      throw new Error('Too many pending group epochs')
    conv.groupState.pendingControls[control.epoch] = {
      item: control,
      senderAddress: message.senderAddress,
      serverTime: message.serverTime,
    }
    conv.groupState.syncFailed = true
    return
  }
  if (control.prevEpochHash !== conv.groupState.prevEpochHashHex)
    throw new Error('Group epoch predecessor mismatch')
  applyAuthenticatedGroupEpoch(
    conv,
    control.epochFrame,
    control.epochSecretHex,
    ownAddress,
    message.serverTime,
  )
  const pending = conv.groupState!.pendingControls?.[conv.groupState!.epoch + 1]
  if (pending) {
    delete conv.groupState!.pendingControls![pending.item.epoch]
    try {
      applyGroupControlItem(
        conversations,
        pending.item,
        {
          outbound: false,
          senderAddress: pending.senderAddress,
          serverTime: pending.serverTime,
        },
        ownAddress,
      )
    } catch {
      conv.groupState!.syncFailed = true
    }
  }
}

/** The user's membership change lost to a different change from another device of the same
 * administrator account. Nothing was sent; the user may retry on top of the adopted epoch. */
export const GROUP_EPOCH_SUPERSEDED =
  'Group membership changed on another device; try again'

function sameMemberChange(
  a: GroupMemberChange | undefined,
  b: GroupMemberChange,
): boolean {
  return (
    !!a && a.action === b.action && sameCanonicalAddress(a.address, b.address)
  )
}

function hasAppliedGroupEpoch(
  conv: Conversation,
  certificate: GroupEpochCertificate,
): boolean {
  const state = conv.groupState
  if (!state) return false
  const known =
    certificate.epoch === state.epoch
      ? state.epochFrame
      : state.epochHistory[certificate.epoch]?.epochFrame
  return known?.epoch_hash === certificate.epoch_hash
}

/**
 * An administrator device catches up with epochs another device of the same account published.
 * Every administrator device derives the same successor secret ({@link deriveAdminEpochSecret}),
 * and each certificate is applied only after the full signed-roster verification of
 * {@link applyAuthenticatedGroupEpoch} against its verified predecessor. Returns whether
 * anything was adopted. Non-administrator devices learn new epochs from group-control items.
 */
async function adoptPublishedAdminEpochs(
  conv: Conversation,
  client: GroupRelayClient,
  ownAddress: string | null,
  checkGroup: () => void,
  observed?: GroupEpochCertificate,
): Promise<boolean> {
  if (!conv.groupState?.groupSecretKeyHex) return false
  const latest =
    observed ??
    groupEpochCertificate(
      await client.getLatestEpoch(conv.groupState.groupIdHex),
    )
  checkGroup()
  if (hasAppliedGroupEpoch(conv, latest)) return false
  if (latest.epoch <= conv.groupState.epoch)
    throw new Error('Conflicting group epoch')
  while (conv.groupState.epoch < latest.epoch) {
    const state = conv.groupState
    const nextEpoch = state.epoch + 1
    const next =
      nextEpoch === latest.epoch
        ? latest
        : groupEpochCertificate(
            await client.getEpoch(state.groupIdHex, nextEpoch),
          )
    checkGroup()
    if (conv.groupState !== state) continue
    const epochSecretHex = bytesToHex(
      deriveAdminEpochSecret({
        authorityPrivateKey: hexToBytes(state.groupSecretKeyHex!),
        groupIdHex: state.groupIdHex,
        prevEpochSecret: hexToBytes(state.epochSecretHex),
        prevEpochHashHex: state.epochFrame.epoch_hash,
        nextEpoch,
      }),
    )
    applyAuthenticatedGroupEpoch(
      conv,
      next,
      epochSecretHex,
      ownAddress,
      Date.now(),
    )
  }
  if (!hasAppliedGroupEpoch(conv, latest))
    throw new Error('Conflicting group epoch')
  const pendingControls = conv.groupState.pendingControls
  for (const epoch of Object.keys(pendingControls ?? {}))
    if (Number(epoch) <= conv.groupState.epoch)
      delete pendingControls![Number(epoch)]
  return true
}

function applyGroupFeatureItem(
  conversations: Record<string, Conversation>,
  item: MessageItem,
  message: {
    outbound: boolean
    senderAddress: string
    destinationAddress?: string
    serverTime: number
    items: MessageItem[]
  },
  ownAddress: string | null,
): void {
  if (item.type !== 'group-welcome' && item.type !== 'group-control') return
  try {
    if (item.type === 'group-welcome')
      applyGroupWelcomeItem(conversations, item, message, ownAddress)
    else applyGroupControlItem(conversations, item, message, ownAddress)
  } catch {
    const frame = encodeItemFrames(messageItems, [item])[0]
    const index = message.items.indexOf(item)
    if (index >= 0)
      message.items[index] = {
        type: 'unsupported',
        reason: 'malformed',
        itemType: item.type,
        frame: bytesToHex(frame),
      }
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
          item.type === 'message-tombstone' ||
          item.type === 'journal-checkpoint' ||
          item.type === 'outbox-message' ||
          item.type === 'payment-transfer'),
    )
  )
}

export async function rehydrateChat(
  chatState: RestorableState,
  metadataCompatible = true,
): Promise<State> {
  const localStore = await store
  if (!metadataCompatible) {
    console.warn(
      '[chats] Schema version mismatch or incompatible metadata; resetting local conversation state for clean relay re-sync',
    )
    return {
      ...freshChatsState(),
      conversations: {},
      messages: {},
      logicalMessages: {},
    }
  }

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
    if (raw.kind === 'group') validateStoredGroupConversation(raw)
    const conversation = newConversation({
      ...raw,
      id,
      address: raw.address,
      participants: raw.participants,
      ...(raw.kind === 'group'
        ? { groupState: { ...raw.groupState!, pendingMessages: {} } }
        : {}),
    })
    conversations[conversation.id] = conversation
  }
  const establishedDirectConversations = new Set<string>(
    Object.keys(conversations),
  )

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
    if (isGroupConversationId(id) && existing?.kind !== 'group')
      throw new Error('Unsupported stored group admission format')
    conversations[id] ??= newConversation({
      id,
      address: peer,
      // Restore only persisted peer evidence; hydration must not open custody for self.
      participants: [peer],
      kind:
        !message.requestedConversationId &&
        message.items?.some(item => item.type === 'email')
          ? 'email'
          : 'direct',
    })
    if (
      message.outbound ||
      sameCanonicalAddress(message.senderAddress, conversations[id].address)
    ) {
      establishedDirectConversations.add(id)
    }
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

  for (const row of orderedRows) {
    const conv = row.conversationId
      ? conversations[row.conversationId]
      : undefined
    if (
      conv &&
      !row.internal &&
      isThirdPartyDirectClaim(
        conv,
        row.wrapper.message,
        messageDestinationAddress(row.wrapper.message) ?? null,
      )
    )
      throw new Error(
        'Unsupported stored direct admission format: original third-party claim requires a persisted local owner',
      )
    const requested = row.wrapper.message.requestedConversationId
    if (requested && conv) {
      if (
        conv.kind !== 'direct' ||
        !sameCanonicalAddress(conv.address, row.wrapper.message.senderAddress)
      )
        throw new Error('Invalid persisted participant-request owner')
      recordParticipantRequest(conversations[requested], {
        senderAddress: conv.address,
        senderConversationId: conv.id,
        referencedConversationId: requested,
        payloadDigest: row.wrapper.index,
        receivedAt: row.wrapper.message.serverTime,
      })
    }
    if (conv?.kind === 'group' && !row.internal) {
      verifyStoredGroupMessage(conv, row.wrapper.message, row.wrapper.index)
      if (
        row.wrapper.message.outbound &&
        row.wrapper.message.status !== 'confirmed'
      )
        conv.groupState!.pendingMessages![row.wrapper.index] = true
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
    // Hydration does not open custody. Our own address is the sender of our own rows and the
    // destination of rows sent to us; an outbound row's destination is the peer.
    const ownAddr = message.outbound
      ? message.senderAddress
      : messageDestinationAddress(message) ?? null
    for (const item of message.items ?? []) {
      applyGroupFeatureItem(conversations, item, message, ownAddr)
    }
    if (
      emailItem &&
      !message.requestedConversationId &&
      speaksForConversation(conv, message)
    ) {
      conv.kind = 'email'
      if (!conv.name && emailItem.subject) {
        conv.name = emailItem.subject
      }
      const trustedGateway = getTrustedEmailGatewayAddress()
      if (trustedGateway) {
        const isGateway = message.outbound
          ? sameCanonicalAddress(conv.address, trustedGateway) ||
            sameCanonicalAddress(copartyAddress, trustedGateway)
          : sameCanonicalAddress(message.senderAddress, trustedGateway)
        conv.verifiedGateway = isGateway
      }
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
    composeFocusRequest: null,
  }
}

export const rehydateChat = rehydrateChat
export const rehydrateState = rehydrateChat
export const freshChatState = freshChatsState

const groupRuns = new WeakMap<object, Map<string, Promise<unknown>>>()
function groupRun<T>(
  owner: object,
  key: string,
  operation: () => Promise<T>,
  join = true,
): Promise<T> {
  let running = groupRuns.get(owner)
  if (!running) {
    running = new Map()
    groupRuns.set(owner, running)
  }
  const existing = running.get(key)
  if (existing)
    return join
      ? (existing as Promise<T>)
      : Promise.reject(new Error('Group operation already in progress'))
  const promise = Promise.resolve().then(operation)
  running.set(key, promise)
  void promise
    .finally(() => {
      if (running!.get(key) === promise) running!.delete(key)
    })
    .catch(() => undefined)
  return promise
}
function captureGroupContext(
  owner: { conversations: Record<string, Conversation> },
  conversation?: Conversation,
): () => void {
  const revision = accountSession.state.revision
  const account = accountSession.state.account
  const chainIdentifier = activeChain.chainIdentifier
  return () => {
    if (
      accountSession.state.revision !== revision ||
      accountSession.state.account !== account ||
      activeChain.chainIdentifier !== chainIdentifier ||
      (conversation && owner.conversations[conversation.id] !== conversation)
    )
      throw new Error('Group operation account or conversation changed')
  }
}

const groupHomeRelays = new WeakMap<object, string>()
const groupRelayClientRegistries = new WeakMap<
  object,
  Map<string, GroupRelayClient>
>()
function groupRelayClients(owner: object): Map<string, GroupRelayClient> {
  let clients = groupRelayClientRegistries.get(owner)
  if (!clients) {
    clients = new Map()
    groupRelayClientRegistries.set(owner, clients)
  }
  return clients
}

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
      // If the message contains a structured email item, prioritize it over wire fallback text items
      const emailItem = items.find(it => it.type === 'email')
      const previewItem = emailItem || lastItem
      return {
        outbound: lastMessage.outbound,
        senderAddress: lastMessage.senderAddress,
        photos: pictures?.photos ?? 0,
        text: pictures ? pictures.text : messageItems.previewText(previewItem),
      }
    },
    getLastReceived(state) {
      return state.lastReceived
    },
  },
  actions: {
    reverifyEmailGateways(gatewayAddress?: string): void {
      const trusted = (
        gatewayAddress || getTrustedEmailGatewayAddress()
      )?.trim()
      if (!trusted) return
      for (const conv of Object.values(this.conversations)) {
        if (conv.kind === 'email' || conv.emailRecipient) {
          const isGateway =
            sameCanonicalAddress(conv.address, trusted) ||
            conv.participants?.some(p => sameCanonicalAddress(p, trusted)) ===
              true
          conv.verifiedGateway = isGateway
        }
      }
    },
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
      sealedMessageId,
      applicationAuthorization,
      financialOperations,
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
      sealedMessageId?: string
      applicationAuthorization?: Message['applicationAuthorization']
      financialOperations?: OutgoingFinancialOperation[]
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
        sealedMessageId,
        applicationAuthorization,
        financialOperations,
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
        const joinedTime = joinMessageTimestamp(
          {
            serverTime: existingMessage.serverTime,
            receivedTime: existingMessage.receivedTime,
            localTime: existingMessage.localTime,
          },
          {
            serverTime: message.serverTime,
            receivedTime: message.receivedTime,
            localTime: message.localTime,
          },
        )
        const joinedStatus = joinDeliveryStatus(
          toDeliveryStatus(existingMessage.status),
          toDeliveryStatus(message.status),
        )
        this.messages[payloadDigest] = Object.assign(existingMessage, message, {
          status: joinedStatus,
          serverTime: joinedTime.serverTime,
          receivedTime: joinedTime.receivedTime,
          localTime: joinedTime.localTime,
          stampValueWei: existingMessage.stampValueWei ?? message.stampValueWei,
          stampPayments: existingMessage.stampPayments?.length
            ? existingMessage.stampPayments
            : message.stampPayments,
          outpoints: existingMessage.outpoints?.length
            ? existingMessage.outpoints
            : message.outpoints,
        })
        if (
          previousHash &&
          previousHash !== payloadDigest &&
          previousHash in this.messages
        ) {
          if (conv) {
            const msgIndex = conv.messages.findIndex(
              msg => msg.payloadDigest === previousHash,
            )
            if (msgIndex >= 0) {
              conv.messages.splice(msgIndex, 1)
            }
          }
          delete this.messages[previousHash]
        }
        if (conv) {
          if (!conv.messages.some(m => m.payloadDigest === payloadDigest)) {
            conv.messages.push(this.messages[payloadDigest]!)
          }
          conv.messages.sort(byRelayTime)
          recomputeChatAccounting(conv, this.activeConversationId)
          recordLogicalMessage(
            this.logicalMessages,
            this.messages[payloadDigest]!,
            conv.id,
          )
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
      financialOperations,
      operationId,
    }: {
      wallet: WalletHandle
      address: string
      conversationId?: string
      items: MessageItem[]
      financialOperations?: OutgoingFinancialOperation[]
      operationId?: string
      stampValue?: bigint
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const maybeGroupConv = conversationId
        ? this.conversations[canonicalConversationId(conversationId)]
        : undefined
      if (maybeGroupConv?.kind === 'group' || isGroupIdentifier(address)) {
        if ((stampValue ?? 0n) !== 0n || financialOperations?.length)
          throw new Error('Group payments are unsupported')
        return this.sendGroupMessage({
          wallet,
          conversationId: maybeGroupConv?.id ?? conversationId,
          address,
          items,
        })
      }
      if (
        conversationId &&
        isGroupConversationId(canonicalConversationId(conversationId))
      )
        throw new Error('Reserved group conversation identifier')
      if (
        financialOperations?.length &&
        (stampValue === undefined || stampValue < 0n)
      )
        throw new Error(
          'Financial messages require an explicit nonnegative stamp value',
        )
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
      const pendingMessageId = operationId ?? nextPendingMessageId(timestamp)
      if (operationId) {
        const existing = Object.values(this.messages).find(
          message => message?.logicalMessageId === operationId,
        )
        if (existing) {
          if (
            !walletOwnsMessage(wallet, existing) ||
            !sameCanonicalAddress(
              existing.destinationAddress,
              displayAddress,
            ) ||
            JSON.stringify(existing.items) !== JSON.stringify(items) ||
            existing.stampValueWei !== (stampValue ?? 0n)
          )
            throw new Error('Outgoing operation intent mismatch')
          if (existing.status === 'confirmed')
            return { state: 'sent', payloadDigest: existing.payloadDigest }
          if (existing.status === 'error')
            return this.retryOutgoing({
              wallet,
              address: displayAddress,
              payloadDigest: existing.payloadDigest,
              automatic: true,
            })
          return { state: 'payment-pending' }
        }
      }
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
        ...(financialOperations?.length
          ? {
              sealedMessageId: outgoingMessageId(pendingMessageId),
              financialOperations: financialOperations.map(reference => ({
                ...reference,
              })),
            }
          : {}),
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
          return this.saveOutgoingExclusive(displayAddress, pendingMessageId, {
            strict: !!financialOperations?.length,
          })
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
    /** Resume an application authorization by its original sealed identity, including deleted rows.
     * Application bytes are validated by the caller; transport owns envelope/payment recovery. */
    async deliverPersistedApplicationMessage(input: {
      wallet: WalletHandle
      address: string
      conversationId: string
      localMessageKey: string
      messageId: string
      applicationAuthorization: NonNullable<Message['applicationAuthorization']>
      stampValue: bigint
      items: MessageItem[]
      assertCurrent(): void
    }): Promise<OutgoingOutcome> {
      input.assertCurrent()
      if (input.localMessageKey !== `pending:application:${input.messageId}`)
        throw new Error('Application message key differs')
      const { wallet, address, conversationId, messageId, stampValue, items } =
        input
      const locked = await withOutgoingLock(input.localMessageKey, async () => {
        input.assertCurrent()
        const owner = await store
        input.assertCurrent()
        // Presentation may have been re-keyed to its digest. Inspect durable rows before rebuilding.
        let id = input.localMessageKey
        let persisted: MessageWrapper | undefined
        for await (const row of await owner.getIterator()) {
          input.assertCurrent()
          if (row.outbound && row.message.sealedMessageId === messageId) {
            persisted = row
            id = row.index
            break
          }
        }
        input.assertCurrent()
        if (persisted) {
          const m = persisted.message
          if (
            toChainDisplayAddress(persisted.copartyAddress) !==
              toChainDisplayAddress(address) ||
            !sameCanonicalAddress(
              persisted.senderAddress,
              wallet.identity.displayAddress,
            ) ||
            m.applicationAuthorization?.accountId !==
              input.applicationAuthorization.accountId ||
            m.applicationAuthorization?.intentKey !==
              input.applicationAuthorization.intentKey ||
            m.conversationId !== conversationId ||
            m.stampValueWei !== stampValue ||
            JSON.stringify(m.items) !== JSON.stringify(items) ||
            !walletOwnsMessage(wallet, m)
          )
            throw new Error('Application presentation conflicts')
          if (m.status === 'confirmed')
            return { state: 'sent' as const, payloadDigest: id }
          if (!this.messages[id])
            this.sendMessageLocal({
              ...m,
              address,
              conversationId,
              senderAddress: wallet.identity.displayAddress,
              index: id,
              items,
              outpoints: m.outpoints ?? [],
              previousHash: null,
              timestamp: m.serverTime,
              delivery: m.delivery ?? {},
            })
        } else {
          // Lookup is required even for a missing bubble: its original paid/free attempt survives deletion.
          const attemptOf = activeChain.directMessages.attemptOf
          if (!attemptOf)
            throw new Error('Original message recovery unavailable')
          const held = await attemptOf({ wallet, messageId })
          input.assertCurrent()
          this.sendMessageLocal({
            address,
            conversationId,
            senderAddress: wallet.identity.displayAddress,
            index: id,
            items,
            outpoints: [],
            stampValueWei: stampValue,
            sealedMessageId: messageId,
            applicationAuthorization: input.applicationAuthorization,
            status: held?.paid ? 'payment-pending' : 'pending',
            previousHash: null,
            timestamp: Date.now(),
            delivery: held?.paid ? { attemptDigest: held.payloadDigest } : {},
          })
          await this.saveOutgoingExclusive(address, id, { strict: true })
          input.assertCurrent()
        }
        return this.runOutgoingExclusive({
          wallet,
          address,
          id,
          manual: false,
          automatic: false,
          confirmed: false,
        })
      })
      input.assertCurrent()
      return locked?.result ?? { state: 'busy' }
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
      const group = message?.conversationId
        ? this.conversations[message.conversationId]
        : undefined
      if (group?.kind === 'group')
        return this.retryGroupMessage(group.id, payloadDigest)
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
        sealedMessageId: message.sealedMessageId,
        applicationAuthorization: message.applicationAuthorization,
        financialOperations: message.financialOperations,
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
      const messagingChain = { ...activeChain }
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
      const recipient = messagingChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const previous = message.delivery
      const digest = previous?.attemptDigest
      const stillCurrent = () =>
        this.messages[id] === message && walletOwnsMessage(wallet, message)

      const financial = message.financialOperations?.length
        ? await captureOutgoingFinancialOperations(
            wallet,
            message.financialOperations,
          )
        : undefined
      if (financial && !message.sealedMessageId)
        throw new Error('Financial message has no durable sealed identity')
      const onEnvelopeDurable =
        financial &&
        (async (attemptDigest: string) => {
          await this.setOutgoingState(
            address,
            id,
            'pending',
            { attemptDigest },
            { strict: true },
          )
          await financial.expose(attemptDigest)
        })
      // Free envelopes have their own durable replay owner; paid reconciliation cannot find them.
      const replayFreeFinancial = !!financial && message.stampValueWei === 0n

      // 1. An earlier payment attempt exists: ask what became of it BEFORE anything else.
      if (digest !== undefined && !replayFreeFinancial) {
        let statuses: Record<string, DirectMessageAttemptStatus>
        try {
          statuses = await messagingChain.directMessages.reconcileAttempts({
            wallet,
            payloadDigests: [digest],
            maxPutAttempts: manual ? 3 : 1,
            ...(onEnvelopeDurable ? { onEnvelopeDurable } : {}),
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
        if (status === 'delivered' && financial) {
          try {
            await financial.submit()
          } catch (error) {
            // Delivered, but its payment is not on chain yet: never shown as sent. The next
            // reconciliation submits the same stored signed bytes again.
            console.warn('Financial submission remains pending', error)
            await this.setOutgoingState(address, id, 'payment-pending', {
              attemptDigest: digest,
            })
            return { state: 'payment-pending' }
          }
        }
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
      } else if (
        digest === undefined &&
        automatic &&
        previous?.failureReason !== 'interrupted'
      ) {
        // No attempt recorded and not cut off mid-send: an earlier payment for it was given up
        // (dead) or the send failed for a reason the user must see. Only a click sends it again.
        return { state: 'failed', reason: previous?.failureReason ?? 'error' }
      } else if (
        digest === undefined &&
        manual &&
        !confirmed &&
        previous?.failureReason === 'recovered'
      ) {
        return { state: 'needs-confirmation', reason: 'recovered' }
      } else if (
        digest === undefined &&
        manual &&
        previous?.failureReason === 'interrupted'
      ) {
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
          orphans = await messagingChain.directMessages.unattributedAttempts({
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
            await messagingChain.directMessages.resolveUnattributedAttempts({
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
      if (
        id.startsWith('pending:application:') &&
        !message.applicationAuthorization
      )
        throw new Error('Application delivery authorization reference missing')
      const application = await captureOutgoingApplicationAuthorization(
        wallet,
        address,
        message,
      )
      if (!stillCurrent()) return { state: 'busy' }
      application?.assertCurrent()
      // Ordinary chat's manual Retry can use the current minimum. A retained application
      // authorization fixes its stamp for every retry, including interrupted automatic sends.
      if (
        !application &&
        manual &&
        !automatic &&
        message.delivery?.failureReason === 'stamp-below-fee' &&
        message.stampValueWei !== undefined
      ) {
        const minimum = await messagingChain.directMessages
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
          let wireItems = message.items
          try {
            const contactsStore = useContactStore()
            const hasContactCard = message.items.some(
              it => it && it.type === 'contact-card',
            )
            const needsSidecar =
              contactsStore.isContact(address) &&
              contactsStore.getNotify(address) &&
              !contactsStore.getInboundWakeupToken(address)
            if (hasContactCard || needsSidecar) {
              const capability = deriveLocalPeerWakeupCapabilitySync(
                address,
                (wallet as unknown as { identity?: any })?.identity ?? null,
              )
              if (capability) {
                contactsStore.setInboundWakeupToken({
                  address,
                  token: capability.preimageHex,
                })
                if (hasContactCard) {
                  wireItems = message.items.map(it =>
                    it && it.type === 'contact-card' && !it.wakeupTokenHex
                      ? { ...it, wakeupTokenHex: capability.preimageHex }
                      : it,
                  )
                } else {
                  wireItems = [
                    ...message.items,
                    {
                      type: 'contact-card',
                      uid: 'frank-wakeup-capability',
                      fullName: 'Wakeup Capability',
                      frankAddress: wallet.identity.displayAddress,
                      wakeupTokenHex: capability.preimageHex,
                    },
                  ]
                }
              }
            }
          } catch {
            // Best-effort wakeup token exchange
          }
          application?.assertCurrent()
          result = await messagingChain.directMessages.send({
            wallet,
            recipient,
            // One ID for this message, whatever attempt this is: the wallet makes one payment
            // per ID, ever, and answers a repeat with the attempt it already holds.
            messageId: message.sealedMessageId ?? outgoingMessageId(id),
            ...(onEnvelopeDurable ? { onEnvelopeDurable } : {}),
            conversationId: message.conversationId,
            ...(subject === undefined ? {} : { conversationName: subject }),
            items: wireItems,
            ...(message.stampValueWei === undefined
              ? {}
              : {
                  stampValue: application?.stampValue ?? message.stampValueWei,
                }),
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

          const isPendingMessaging =
            (typeof CanonicalMessagingPendingError === 'function' &&
              error instanceof CanonicalMessagingPendingError) ||
            (error instanceof Error &&
              (error.name === 'CanonicalMessagingPendingError' ||
                error.name === 'CanonicalMessageItemsNotInstalledError'))
          if (
            isPendingMessaging &&
            ownDigest === undefined &&
            sendAttempt < maxSendAttempts &&
            stillCurrent()
          ) {
            const ready =
              typeof waitForMessagingReady === 'function'
                ? await waitForMessagingReady(5_000)
                : false
            if (!ready) {
              await new Promise(r => setTimeout(r, sendAttempt * 500))
            }
            continue
          }

          const errorStr =
            String(error) +
            (error instanceof Error ? ' ' + error.message : '') +
            (typeof error === 'object' && error !== null && 'info' in error
              ? ' ' + JSON.stringify((error as any).info)
              : '')
          const isDirectoryUnreachable =
            typeof error === 'object' &&
            error !== null &&
            (error as { name?: unknown }).name === 'OpenDirectoryError' &&
            (error as { code?: unknown }).code === 'unreachable'
          const isTransientRpc =
            isDirectoryUnreachable ||
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
          if (
            error instanceof ContactPaymentReleasedError &&
            this.messages[id] &&
            !financial
          )
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

      if (financial) {
        try {
          await financial.submit()
        } catch (error) {
          // The message was delivered (the recipient is told of the payment), but the payment
          // is not on chain yet. It stays payment-pending, and reconciliation submits the same
          // stored signed bytes again; never a new payment.
          console.warn('Financial submission remains pending', error)
          await this.setOutgoingState(address, id, 'payment-pending', {
            attemptDigest: result.payloadDigest,
          })
          return { state: 'payment-pending' }
        }
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
              messageId: message.sealedMessageId ?? outgoingMessageId(id),
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
            if (message.financialOperations?.length) {
              await this.runOutgoing({
                wallet,
                address,
                id: message.payloadDigest,
                manual: false,
              })
              continue
            }
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
      assertCurrent?: () => void,
    ): Promise<void> {
      assertCurrent?.()
      if (clearingMessages.length === 0) return
      const messageStore = await store
      assertCurrent?.()
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
        assertCurrent?.()
        await messageStore.suppressAndDelete(
          recipientAddress,
          [...group.digests],
          group.suppressions,
        )
        assertCurrent?.()
      }
      for (const digest of unscopedDigests) {
        assertCurrent?.()
        await messageStore.deleteMessage(digest)
        assertCurrent?.()
      }
      assertCurrent?.()
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
      if (kind !== 'group' && isGroupConversationId(id))
        throw new Error('Reserved group conversation identifier')
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
      if (kind === 'direct' && usableSubject(name ?? topic) !== undefined) {
        this.conversations[id].nameSetAt = Date.now()
        this.conversations[id].subjectToNote = true
        this.conversations[id].actedBy = accountTag()
        void this.noteConversationStates()
      }
      return this.conversations[id]
    },
    autoHealDuplicateDirectConversations(): void {
      autoHealDuplicateDirectConversations({
        conversations: this.conversations,
        logicalMessages: this.logicalMessages,
        activeConversationId: this.activeConversationId,
        ownAddress: getOwnCanonicalAddress(),
      })
    },
    renameConversation(id: string, subject: string): void {
      // A thread dropped while its subject was being edited: the one that replaced it.
      const conversation = resolveConversation(this.conversations, id)
      if (!conversation) throw new Error(`Unknown conversation ${id}`)
      if (conversation.kind === 'group')
        throw new Error('Group names require an authenticated epoch update')
      // Reject invalid nonempty subjects before mutating: every device keeps the same previous
      // subject. A blank one intentionally removes it.
      const normalized = usableSubject(subject)
      if (subject.trim() && normalized === undefined)
        throw new Error('Invalid conversation subject')
      conversation.name = normalized
      if (conversation.topic !== undefined) {
        conversation.topic = normalized
      }
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
      gatewayAddress,
    }: {
      recipientEmail: string
      subject?: string
      gatewayAddress?: string
    }): Conversation {
      const normalizedEmail = recipientEmail.toLowerCase().trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('Invalid email recipient')
      }
      if (!gatewayAddress)
        throw new Error('No email gateway is available for this relay')
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
      const conv = this.conversations[conversationId]
      if (!conv) return
      // Admit against this exact account and store before waiting for any older mutation.
      const revision = accountSession.state.revision
      const account = accountSession.state.account
      const salt = conversationIdSalt.value
      const conversations = this.conversations
      const messages = this.messages
      const assertCurrent = () => {
        if (
          accountSession.state.revision !== revision ||
          accountSession.state.account !== account ||
          conversationIdSalt.value !== salt ||
          this.conversations !== conversations ||
          this.messages !== messages ||
          this.conversations[conversationId] !== conv
        )
          throw new Error('Account changed during conversation deletion')
      }
      return serializeDeliveryMutation(async () => {
        assertCurrent()
        const deletedAt = Math.max(
          newestRelayTime(conv.messages),
          conv.removedRelayTime ?? 0,
          clearedUpTo(conv) ?? 0,
          1,
        )
        await this.applyClearedBeforeExclusive(conv, deletedAt, assertCurrent)
        assertCurrent()
        if (conv.messages.length === 0) conv.deletedAt = deletedAt
        conv.actedBy = accountTag()
        if (this.activeConversationId === conversationId)
          this.activeConversationId = null
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
      assertCurrent?: () => void,
    ): Promise<void> {
      assertCurrent?.()
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
        assertCurrent,
      )
      assertCurrent?.()
      if (surviving.size > 0) {
        conv.clearedBefore = clearedBefore
        conv.deletedAt = undefined
        return
      }
      conv.deletedAt = clearedBefore
      if (this.activeConversationId === conv.id)
        this.activeConversationId = null
    },
    async applyMessageTombstoneExclusive(
      tombstone: MessageTombstoneItem & {
        targetMessageId?: string
        targetPayloadHash?: string
      },
      ownAddress: string | null,
    ): Promise<void> {
      const targetPayloadHash =
        tombstone.payloadDigest || tombstone.targetPayloadHash
      const targetMessageId =
        tombstone.targetMessageId || tombstone.payloadDigest
      const targets = tombstonedTargetsFor(this.conversations)
      if (targetMessageId) targets.add(targetMessageId)
      if (targetPayloadHash) targets.add(targetPayloadHash)

      const matchingDigests = new Set<string>()
      if (targetPayloadHash && targetPayloadHash in this.messages) {
        matchingDigests.add(targetPayloadHash)
      }
      if (targetMessageId && targetMessageId in this.messages) {
        matchingDigests.add(targetMessageId)
      }
      for (const [digest, msg] of Object.entries(this.messages)) {
        if (!msg) continue
        if (
          (targetMessageId &&
            (msg.logicalMessageId === targetMessageId ||
              msg.payloadDigest === targetMessageId)) ||
          (targetPayloadHash &&
            (msg.payloadDigest === targetPayloadHash ||
              msg.delivery?.attemptDigest === targetPayloadHash))
        ) {
          matchingDigests.add(digest)
        }
      }

      for (const digest of matchingDigests) {
        const msg = this.messages[digest]
        const conv = msg?.conversationId
          ? this.conversations[msg.conversationId]
          : undefined
        const address =
          conv?.address ||
          tombstone.peer ||
          msg?.destinationAddress ||
          msg?.senderAddress ||
          ''
        const recipientAddress = msg
          ? tombstoneMailbox(msg) ?? ownAddress
          : ownAddress
        await this.deleteMessageExclusive({
          address,
          payloadDigest: digest,
          recipientAddress,
          attemptDigest: msg?.delivery?.attemptDigest,
        })
      }

      if (matchingDigests.size === 0 && ownAddress) {
        const messageStore = await store
        const suppressDigests = Array.from(
          new Set(
            [targetPayloadHash, targetMessageId].filter((d): d is string =>
              Boolean(d),
            ),
          ),
        )
        if (
          suppressDigests.length > 0 &&
          typeof messageStore?.suppressAndDelete === 'function'
        ) {
          await messageStore.suppressAndDelete(
            ownAddress,
            suppressDigests,
            suppressDigests.map(payloadDigest => ({
              payloadDigest,
              ...(tombstone.deletedAt === undefined
                ? {}
                : { receivedTime: tombstone.deletedAt }),
            })),
          )
        }
      }
    },
    async applyJournalCheckpointExclusive(
      checkpoint: JournalCheckpointItem & {
        upToTimestamp?: number
        suppressedIds?: string[]
      },
      ownAddress: string | null,
    ): Promise<void> {
      for (const entry of checkpoint.conversations ?? []) {
        await this.applyConversationStateExclusive(
          {
            type: 'conversation-state',
            conversationId: entry.conversationId,
            peer: entry.peer,
            ...(entry.clearedBefore === undefined
              ? {}
              : { clearedBefore: entry.clearedBefore }),
            ...(entry.readUpTo === undefined
              ? {}
              : { readUpTo: entry.readUpTo }),
            ...(entry.subject === undefined ? {} : { subject: entry.subject }),
            ...(entry.subjectSetAt === undefined
              ? {}
              : { subjectSetAt: entry.subjectSetAt }),
          },
          ownAddress,
        )
        if (entry.tombstones) {
          for (const [digest, deletedAt] of Object.entries(entry.tombstones)) {
            await this.applyMessageTombstoneExclusive(
              {
                type: 'message-tombstone',
                conversationId: entry.conversationId,
                peer: entry.peer,
                payloadDigest: digest,
                deletedAt,
              },
              ownAddress,
            )
          }
        }
      }
      for (const id of checkpoint.suppressedIds ?? []) {
        await this.applyMessageTombstoneExclusive(
          {
            type: 'message-tombstone',
            conversationId: '0'.repeat(64),
            peer: ownAddress ?? '',
            payloadDigest: id,
            deletedAt:
              checkpoint.checkpointTimestamp ?? checkpoint.upToTimestamp ?? 1,
            targetMessageId: id,
            ...(id && /^[0-9a-f]{64}$/i.test(id)
              ? { targetPayloadHash: id.toLowerCase() }
              : {}),
          },
          ownAddress,
        )
      }
      const checkpointTs =
        checkpoint.checkpointTimestamp ?? checkpoint.upToTimestamp ?? 0
      if (checkpointTs > 0) {
        this.lastReceived = Math.max(this.lastReceived ?? 0, checkpointTs)
      }
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
    setScreenerStatus(
      addressOrId: string,
      status: 'pending' | 'approved' | 'dismissed',
    ) {
      const chat =
        this.conversations[addressOrId] ||
        this.chats[safeChainDisplayAddress(addressOrId) || addressOrId]
      if (chat) {
        chat.screenerStatus = status
      }
    },
    requestComposeFocus(conversationId?: string | null): void {
      const targetId =
        conversationId !== undefined
          ? conversationId
          : this.activeConversationId
      const currentNonce = this.composeFocusRequest?.nonce ?? 0
      this.composeFocusRequest = {
        conversationId: targetId,
        nonce: currentNonce + 1,
      }
    },
    setActiveChat(
      address: string | null,
      options: SetActiveConversationOptions = {},
    ): void {
      if (!address) return this.setActiveConversation(null, options)
      if (this.conversations[address])
        return this.setActiveConversation(address, options)
      const conv = this.openDirectConversation(address)
      this.setActiveConversation(conv.id, options)
    },
    setActiveConversation(
      conversationId: string | null,
      options: SetActiveConversationOptions = {},
    ): void {
      if (conversationId && isChainAddress(conversationId)) {
        return this.setActiveChat(conversationId, options)
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
        if (conv.kind === 'group' && this.shouldPollGroupMailbox(conv.id)) {
          void this.syncGroupConversation(conv.id).catch(() => undefined)
        }
        this.readAll(conv.id)
      }
      if (options.requestFocus && (conv || conversationId)) {
        this.requestComposeFocus(conv?.id ?? conversationId)
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
      rawMessageWrappers: ReceivedMessageWrapper[],
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
      const messageWrappers = rawMessageWrappers.map(wrapper => {
        const normalized = normalizeOutboxWrapper(wrapper, ownAddress)
        if (normalized.index !== wrapper.index && toNotify.has(wrapper.index)) {
          toNotify.delete(wrapper.index)
          notifyingIncoming.delete(wrapper.index)
          if (
            !(normalized.index in this.messages) &&
            !notifyingIncoming.has(normalized.index)
          ) {
            toNotify.add(normalized.index)
            notifyingIncoming.add(normalized.index)
          }
        }
        return normalized
      })
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
      // What the account's other devices noted about its conversations, tombstones, and checkpoints.
      const checkpointNotes = recordRows.flatMap(wrapper =>
        ownJournalCheckpoints(wrapper, ownAddress),
      )
      const conversationNotes = recordRows.flatMap(wrapper =>
        ownConversationStates(wrapper, ownAddress),
      )
      const tombstoneNotes = recordRows.flatMap(wrapper =>
        ownMessageTombstones(wrapper, ownAddress),
      )
      // A later durable receipt is a restart frontier even before the poll advances its
      // cursor. Commit authenticated note effects first, through the existing metadata
      // owner, so a crash cannot skip a note whose raw row is intentionally not stored.
      for (const checkpoint of checkpointNotes)
        await this.applyJournalCheckpointExclusive(checkpoint, ownAddress)
      for (const note of conversationNotes)
        await this.applyConversationStateExclusive(note, ownAddress)
      for (const tombstone of tombstoneNotes)
        await this.applyMessageTombstoneExclusive(tombstone, ownAddress)
      if (
        checkpointNotes.length > 0 ||
        conversationNotes.length > 0 ||
        tombstoneNotes.length > 0
      ) {
        await this.flushPersistence?.()
      }

      const tombstonedTargets = tombstonedTargetsFor(this.conversations)
      if (tombstonedTargets.size > 0) {
        const newlySuppressed: ReceivedMessageWrapper[] = []
        deliverableWrappers = deliverableWrappers.filter(wrapper => {
          const logicalId = wrapper.message.logicalMessageId
          if (
            tombstonedTargets.has(wrapper.index) ||
            (logicalId !== undefined && tombstonedTargets.has(logicalId))
          ) {
            suppressedDigests.add(wrapper.index)
            toNotify.delete(wrapper.index)
            newlySuppressed.push(wrapper)
            return false
          }
          return true
        })
        if (
          newlySuppressed.length > 0 &&
          ownAddress &&
          typeof messageStore?.suppressAndDelete === 'function'
        ) {
          await messageStore.suppressAndDelete(
            ownAddress,
            newlySuppressed.map(w => w.index),
            newlySuppressed.map(w => ({
              payloadDigest: w.index,
              receivedTime: w.message.receivedTime,
            })),
          )
        }
      }

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
          const joinedTime = joinMessageTimestamp(
            {
              serverTime: existing.serverTime,
              receivedTime: existing.receivedTime,
              localTime: (existing as ChatMessage).localTime ?? true,
            },
            {
              serverTime: wrapper.message.serverTime,
              receivedTime: wrapper.message.receivedTime,
              localTime: false,
            },
          )
          const incomingStatus = toDeliveryStatus(
            wrapper.message.status || 'confirmed',
          )
          const joinedStatus =
            incomingStatus === 'confirmed'
              ? 'confirmed'
              : joinDeliveryStatus(
                  toDeliveryStatus(existing.status),
                  incomingStatus,
                )
          const contentDigest =
            wrapper.message.contentDigest ?? existing.contentDigest
          // The local outbox owns content/direction. The relay owns only delivery time and the
          // observed stamp metadata; never spread an inbox wrapper over the outbound record.
          outboundMatches.set(wrapper.index, {
            oldIndex,
            chatAddress,
            conversationId,
            message: {
              outbound: true,
              status: joinedStatus,
              items: existing.items,
              serverTime: joinedTime.serverTime,
              receivedTime: joinedTime.receivedTime,
              localTime: joinedTime.localTime,
              outpoints: wrapper.message.outpoints,
              stampValueWei:
                wrapper.message.stampValueWei ?? existing.stampValueWei,
              stampPayments:
                wrapper.message.stampPayments ?? existing.stampPayments,
              senderAddress: existing.senderAddress,
              destinationAddress: wrapper.message.destinationAddress,
              delivery: existing.delivery,
              sealedMessageId: existing.sealedMessageId,
              applicationAuthorization: existing.applicationAuthorization,
              financialOperations: existing.financialOperations,
              conversationId,
              logicalMessageId: existing.logicalMessageId,
              ...(contentDigest === undefined ? {} : { contentDigest }),
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
      const participantRequests = new Map<string, PendingParticipantRequest>()
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
          existing.requestedConversationId !== id &&
          !replacedAccountCollisions.has(wrapper.index)
        ) {
          throw new Error(
            'Conversation identity differs from the existing message owner',
          )
        }
        if (
          !loopback &&
          !wrapper.outbound &&
          ((id && isGroupConversationId(id)) ||
            (conv &&
              isThirdPartyDirectClaim(conv, wrapper.message, ownAddress)))
        ) {
          const sender =
            safeChainDisplayAddress(wrapper.message.senderAddress) ||
            wrapper.message.senderAddress
          conv = openAllocatedConversation(
            preparedConversations,
            sender,
            ownAddress ? [ownAddress, sender] : [sender],
          )
          if (id)
            participantRequests.set(wrapper.index, {
              senderAddress: sender,
              senderConversationId: conv.id,
              referencedConversationId: id,
              payloadDigest: wrapper.index,
              receivedAt: wrapper.message.serverTime,
            })
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

      const persistYielder = createCooperativeBatchYielder()
      let persistStarted = false
      for (const wrapper of deliverableWrappers) {
        // An index this call did not claim belongs to an overlapping receive.
        // Do not persist it: if the claimer fails before storing, a later poll
        // must still be able to notify.
        if (!toNotify.has(wrapper.index) && !(wrapper.index in this.messages)) {
          continue
        }
        if (persistStarted) {
          await persistYielder.maybeYield()
        } else {
          persistStarted = true
        }
        const loopback = outboundMatches.get(wrapper.index)
        const persisted: MessageWrapper = {
          message: loopback?.message ?? {
            ...wrapper.message,
            conversationId: receivedConversations.get(wrapper.index)!.id,
            ...(participantRequests.has(wrapper.index)
              ? {
                  requestedConversationId: participantRequests.get(
                    wrapper.index,
                  )!.referencedConversationId,
                }
              : {}),
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
        const request = participantRequests.get(wrapper.index)
        if (request)
          recordParticipantRequest(
            this.conversations[request.referencedConversationId],
            request,
          )
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
        chat.messages.sort(byRelayTime)
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
      const dirtyConversations = new Set<Conversation>()
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
          ...(participantRequests.has(index)
            ? {
                requestedConversationId:
                  participantRequests.get(index)!.referencedConversationId,
              }
            : {}),
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

        for (const item of message.items ?? []) {
          applyGroupFeatureItem(this.conversations, item, message, ownAddress)
        }

        if (index in this.messages) {
          const existingMessage = this.messages[index]
          assert(existingMessage, 'For great typescript')
          const wasOutbound = existingMessage.outbound
          const senderAddress = existingMessage.senderAddress
          const joinedTime = joinMessageTimestamp(
            {
              serverTime: existingMessage.serverTime,
              receivedTime: existingMessage.receivedTime,
              localTime: existingMessage.localTime,
            },
            {
              serverTime: message.serverTime,
              receivedTime: message.receivedTime,
              localTime: message.localTime ?? false,
            },
          )
          const joinedStatus = joinDeliveryStatus(
            toDeliveryStatus(existingMessage.status),
            toDeliveryStatus(message.status),
          )
          // Mutate the object so that it triggers reactivity. A loopback is still the outbox
          // message the user sent; only its relay-authored time/stamp metadata is refreshed.
          this.messages[index] = Object.assign(existingMessage, message, {
            ...(participantRequests.has(index)
              ? {
                  requestedConversationId:
                    participantRequests.get(index)!.referencedConversationId,
                }
              : {}),
            outbound: wasOutbound,
            senderAddress,
            conversationId: conv.id,
            status: joinedStatus,
            serverTime: joinedTime.serverTime,
            receivedTime: joinedTime.receivedTime,
            localTime: joinedTime.localTime,
          })
          if (!conv.messages.some(m => m.payloadDigest === index)) {
            conv.messages.push(this.messages[index]!)
          }
          if (emailItem && speaks && !message.requestedConversationId) {
            conv.kind = 'email'
            if (!conv.name && emailItem.subject) {
              conv.name = emailItem.subject
            }
            conv.verifiedGateway = isVerifiedGateway
          }
          conv.lastReceived = Math.max(
            conv.lastReceived ?? 0,
            existingMessage.serverTime,
          )
          this.lastReceived = Math.max(
            this.lastReceived ?? 0,
            existingMessage.serverTime,
          )
          if (
            conv.id === this.activeConversationId &&
            !isOwnMessage(existingMessage)
          ) {
            conv.lastRead = Math.max(conv.lastRead, existingMessage.serverTime)
          }
          dirtyConversations.add(conv)
          recordLogicalMessage(this.logicalMessages, existingMessage, conv.id)
          // We should already have created the chat if we have the message. Continue so one
          // replayed item cannot hide later, genuinely new messages from this same poll batch.
          continue
        }

        if (!message.outbound && Array.isArray(message.items)) {
          for (const item of message.items) {
            if (
              item &&
              item.type === 'contact-card' &&
              typeof item.wakeupTokenHex === 'string' &&
              item.wakeupTokenHex.length > 0 &&
              message.senderAddress
            ) {
              try {
                useContactStore().setOutboundWakeupToken({
                  address: message.senderAddress,
                  token: item.wakeupTokenHex,
                })
              } catch {
                // ignore
              }
            }
          }
          if (
            message.items.length > 1 &&
            message.items.some(
              it =>
                it &&
                it.type === 'contact-card' &&
                it.uid === 'frank-wakeup-capability',
            )
          ) {
            message.items = message.items.filter(
              it =>
                !(
                  it &&
                  it.type === 'contact-card' &&
                  it.uid === 'frank-wakeup-capability'
                ),
            )
          }
        }

        this.messages[index] = message
        if (!conv.messages.some(m => m.payloadDigest === index)) {
          conv.messages.push(message)
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

        if (emailItem && speaks && !message.requestedConversationId) {
          conv.kind = 'email'
          if (!conv.name && emailItem.subject) {
            conv.name = emailItem.subject
          }
          conv.verifiedGateway = isVerifiedGateway
        }
        conv.lastReceived = Math.max(conv.lastReceived ?? 0, message.serverTime)
        recordLogicalMessage(this.logicalMessages, message, conv.id)

        if (conv.id === this.activeConversationId) {
          // The receipt was visible while this chat was active. Persist that read decision so
          // navigating elsewhere and reloading cannot reconstruct it as unread.
          conv.lastRead = Math.max(conv.lastRead, message.serverTime)
        }
        dirtyConversations.add(conv)
        this.lastReceived = Math.max(this.lastReceived ?? 0, message.serverTime)
      }
      for (const conv of dirtyConversations) {
        conv.messages.sort(byRelayTime)
        recomputeChatAccounting(conv, this.activeConversationId)
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
            !opened.topic &&
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
    /** Issue #70 & #1365: Transitions an invited group conversation to `'joined'` so the client
     * can begin polling the shared group mailbox. */
    approveGroupInvite(conversationId: string): Conversation | undefined {
      const conv = this.conversations[conversationId]
      if (!conv || conv.kind !== 'group' || conv.membershipStatus !== 'invited')
        return undefined
      conv.membershipStatus = 'joined'
      conv.deletedAt = undefined
      conv.updatedAt = Date.now()
      void this.syncGroupConversation(conversationId).catch(() => undefined)
      return conv
    },
    /** Issue #70 & #1365: Declines an invited group conversation and hides it from active chat lists. */
    declineGroupInvite(conversationId: string): Conversation | undefined {
      const conv = this.conversations[conversationId]
      if (!conv || conv.kind !== 'group' || conv.membershipStatus !== 'invited')
        return undefined
      conv.membershipStatus = 'declined'
      conv.deletedAt = Math.max(
        newestRelayTime(conv.messages),
        conv.removedRelayTime ?? 0,
        1,
      )
      conv.totalUnreadMessages = 0
      conv.totalUnreadValue = 0
      conv.updatedAt = Date.now()
      if (this.activeConversationId === conversationId) {
        this.activeConversationId = null
      }
      return conv
    },
    dismissPendingParticipantRequest(
      conversationId: string,
      senderAddress: string,
    ): void {
      const conv = this.conversations[conversationId]
      const key = Object.keys(conv?.pendingParticipantRequests ?? {}).find(
        address => sameCanonicalAddress(address, senderAddress),
      )
      if (!conv || !key) return
      const request = conv.pendingParticipantRequests![key]
      conv.dismissedParticipantRequests = {
        ...conv.dismissedParticipantRequests,
        [key]: Math.max(
          conv.dismissedParticipantRequests?.[key] ?? 0,
          request.receivedAt,
        ),
      }
      const remaining = { ...conv.pendingParticipantRequests }
      delete remaining[key]
      conv.pendingParticipantRequests = Object.keys(remaining).length
        ? remaining
        : undefined
    },
    /** Issue #70 & #1365: Whether this device should poll the shared group mailbox for `conversationId`.
     * Never polls while `membershipStatus === 'invited'`, `'declined'`, or `'left'`. */
    shouldPollGroupMailbox(conversationId: string): boolean {
      const conv = this.conversations[conversationId]
      return Boolean(
        conv &&
          conv.kind === 'group' &&
          conv.membershipStatus === 'joined' &&
          !conv.deletedAt &&
          (conv.groupId || conv.groupState?.groupIdHex) &&
          (conv.groupEpochSecretHex || conv.groupState?.epochSecretHex),
      )
    },
    setGroupRelayClient(relayUrl: string, client: GroupRelayClient): void {
      const key = relayUrl.trim().replace(/\/+$/, '')
      groupRelayClients(this).set(key, client)
    },
    configureGroupHomeRelay(homeRelayUrl: string): () => void {
      const url = normalizeGroupRelayOrigin(homeRelayUrl)
      groupHomeRelays.set(this, url)
      return () => {
        if (groupHomeRelays.get(this) === url) {
          groupHomeRelays.delete(this)
          groupRelayClientRegistries.delete(this)
        }
      }
    },
    getGroupHomeRelay(): string {
      const url = groupHomeRelays.get(this)
      if (!url) throw new Error('Group messaging is not configured')
      return url
    },
    getGroupRelayClient(relayUrl?: string): GroupRelayClient {
      const injected = relayUrl
        ? groupRelayClients(this).get(relayUrl.trim().replace(/\/+$/, ''))
        : undefined
      if (injected) return injected
      const homeRelayUrl = this.getGroupHomeRelay()
      const resolvedUrl = (relayUrl || homeRelayUrl).trim().replace(/\/+$/, '')
      const key = `${homeRelayUrl}|${resolvedUrl}|${accountSession.state.revision}`
      const existing = groupRelayClients(this).get(key)
      if (existing) return existing
      const revision = accountSession.state.revision
      const account = accountSession.state.account
      const requireAccount = () => {
        if (
          accountSession.state.revision !== revision ||
          accountSession.state.account !== account
        )
          throw new Error('Group relay client account changed')
      }
      const created = new GroupRelayClient(resolvedUrl, {
        homeRelayUrl,
        subscriberTag: async groupIdHex => {
          requireAccount()
          const signer = await accountSession.getGroupSigner(groupIdHex, 0)
          const digest = sha256(
            new TextEncoder().encode(
              `frank-group-subscriber-v1:${homeRelayUrl}:${groupIdHex}`,
            ),
          )
          const signature = await signer.signDigest(digest)
          requireAccount()
          return bytesToHex(sha256(signature))
        },
      })
      groupRelayClients(this).set(key, created)
      return created
    },

    /**
     * Issue #70 & #1365: Creates a new group on the relay (`epoch: 0`), persists the
     * `kind: 'group'` conversation in `'joined'` status for the creator, and sends
     * 1:1 `GroupWelcomeItem` DMs to each invited member.
     */
    async createGroupConversation(input: {
      wallet?: WalletHandle
      groupName: string
      memberAddresses: string[]
      relayUrl?: string
      relayClient?: GroupRelayClient
      creatorAddress?: string
    }): Promise<Conversation> {
      return groupRun(
        this,
        'create-group',
        () => this.createGroupConversationOnce(input),
        false,
      )
    },
    async createGroupConversationOnce({
      wallet,
      groupName,
      memberAddresses,
      relayUrl,
      relayClient,
      creatorAddress,
    }: {
      wallet?: WalletHandle
      groupName: string
      memberAddresses: string[]
      relayUrl?: string
      relayClient?: GroupRelayClient
      creatorAddress?: string
    }): Promise<Conversation> {
      const checkGroup = captureGroupContext(this)
      const trimmedName = groupName.trim()
      if (!trimmedName) {
        throw new Error('Group name is required')
      }
      const resolvedWallet = wallet || messagingWallet()
      const ownRaw =
        creatorAddress ||
        resolvedWallet?.identity?.displayAddress ||
        (await getOwnCanonicalAddress())
      if (!ownRaw) {
        throw new Error('Active account address is required to create a group')
      }
      const identityPubKeyHex = bytesToHex(
        await accountSession.getCurvePublicKey('secp256k1'),
      )
      const ownAddress = directoryAddress(identityPubKeyHex)
      if (!ownAddress) throw new Error('Invalid active group identity')
      if (!sameCanonicalAddress(ownRaw, ownAddress))
        throw new Error('Group creation requires the active messaging identity')
      const normalizedMembers = Array.from(
        new Set(
          memberAddresses
            .map(a => a.trim())
            .filter(Boolean)
            .map(a => safeChainDisplayAddress(a) || a)
            .filter(a => !sameCanonicalAddress(a, ownAddress)),
        ),
      )
      const client = relayClient ?? this.getGroupRelayClient(relayUrl)
      const created = prepareGroupCreation({
        client,
        groupName: trimmedName,
        creatorAddress: ownAddress,
        creatorIdentityPubKeyHex: identityPubKeyHex,
        members: await Promise.all(
          normalizedMembers.map(async address => {
            const parsed = activeChain.parseAddress(address)
            if (!parsed) throw new Error('Invalid group member address')
            const profile = await fetchContactProfile(parsed)
            if (!profile?.pubKey)
              throw new Error('Group member has no authenticated identity')
            const identityPubKeyHex = bytesToHex(profile.pubKey)
            if (
              !sameCanonicalAddress(
                directoryAddress(identityPubKeyHex),
                address,
              )
            )
              throw new Error('Group member identity mismatch')
            return {
              address: directoryAddress(identityPubKeyHex)!,
              identityPubKeyHex,
            }
          }),
        ),
      })

      checkGroup()
      const participants = Array.from(
        new Set([ownAddress, ...normalizedMembers]),
      ).sort()
      const members: Record<string, ConversationMember> = {}
      for (const rMember of created.roster.members) {
        const displayAddr =
          safeChainDisplayAddress(rMember.address) || rMember.address
        members[displayAddr] = {
          address: displayAddr,
          role: rMember.role ?? 'member',
          joinedAt: Date.now(),
          pubKeyHex: rMember.epochSigningPubKeyHex,
        }
      }

      const groupState: GroupConversationState = {
        groupIdHex: created.identity.groupIdHex,
        groupPubKeyHex: created.identity.groupPubKeyHex,
        groupSecretKeyHex: created.identity.groupSecretKeyHex,
        homeRelay: client.relayUrl,
        epoch: 0,
        epochSecretHex: created.epochKeys.epochSecretHex,
        prevEpochHashHex: created.epochHash,
        memberIndex: 0,
        lastSyncedSeq: 0,
        roster: [...created.roster.members],
        epochFrame: groupEpochCertificate(created.epochFrame),
        epochHistory: {},
        pendingEpoch: {
          certificate: groupEpochCertificate(created.epochFrame),
        },
      }

      const conv = newConversation({
        id: created.identity.conversationId,
        kind: 'group',
        name: created.roster.groupName,
        address: created.identity.groupIdentifier,
        participants,
        members,
        membershipStatus: 'joined',
        invitedBy: ownAddress,
        groupId: created.identity.groupIdHex,
        groupPubKey: created.identity.groupPubKeyHex,
        groupRelayUrl: client.relayUrl,
        groupEpochSecretHex: created.epochKeys.epochSecretHex,
        groupMemberIndex: 0,
        groupState,
        epoch: {
          epochId: created.epochHash,
          generation: 0,
          updatedAt: Date.now(),
        },
      })
      this.conversations[conv.id] = conv

      conv.groupState!.pendingMemberDeliveries = {}
      // Persist membership deliveries before handing any invitation to transport.
      for (const rMember of created.roster.members) {
        const welcomeItem: GroupWelcomeItem = {
          type: 'group-welcome',
          epochFrame: groupEpochCertificate(created.epochFrame),
          ...(rMember.index === 0
            ? { adminSecretKeyHex: created.identity.groupSecretKeyHex }
            : {}),
          groupId: created.identity.groupIdHex,
          groupPubKey: created.identity.groupPubKeyHex,
          groupName: created.roster.groupName,
          homeRelay: client.relayUrl,
          epoch: 0,
          epochSecretHex: created.epochKeys.epochSecretHex,
          memberIndex: rMember.index,
          inviterAddress: ownAddress,
        }
        conv.groupState!.pendingMemberDeliveries![rMember.address] = [
          {
            items: [welcomeItem],
            operationId: nextPendingMessageId(Date.now()),
          },
        ]
      }
      await this.flushPersistence?.()
      try {
        await this.retryGroupEpochPublication(conv.id, client)
        await this.retryGroupMemberDeliveries(conv.id, resolvedWallet)
      } catch {
        checkGroup()
        conv.groupState!.syncFailed = true
        await this.flushPersistence?.()
      }

      return this.conversations[conv.id]
    },
    /**
     * Issue #70: Seals an outbound group message using the sender's per-epoch signing key
     * and the shared epoch encryption + write keys, then posts it to `PUT /groups/:group_id/messages`.
     */
    async sendGroupMessage({
      wallet,
      conversationId,
      address,
      items,
      relayClient,
      senderAddress: explicitSenderAddress,
    }: {
      wallet?: WalletHandle
      conversationId?: string
      address?: string
      items: MessageItem[]
      relayClient?: GroupRelayClient
      senderAddress?: string
    }): Promise<OutgoingOutcome> {
      const targetGroupId = address ? parseGroupIdentifier(address) : null
      const conv =
        (conversationId
          ? this.conversations[canonicalConversationId(conversationId)]
          : undefined) ??
        Object.values(this.conversations).find(
          c =>
            c.kind === 'group' &&
            ((address && c.address === address) ||
              (targetGroupId && c.groupId === targetGroupId)),
        )
      if (!conv || conv.kind !== 'group') {
        throw new Error('Group conversation not found')
      }
      if (address && address !== conv.address)
        throw new Error('Group conversation address mismatch')
      const checkGroup = captureGroupContext(this, conv)
      if (conv.membershipStatus !== 'joined') {
        throw new Error(
          `Cannot send message to group in '${
            conv.membershipStatus ?? 'unknown'
          }' state`,
        )
      }
      if (conv.groupState?.pendingEpoch)
        throw new Error('Group epoch publication is pending')
      const groupIdHex = conv.groupState?.groupIdHex ?? conv.groupId
      const epochSecretHex =
        conv.groupState?.epochSecretHex ?? conv.groupEpochSecretHex
      const epoch = conv.groupState?.epoch ?? conv.epoch?.generation ?? 0
      if (!groupIdHex || !epochSecretHex) {
        throw new Error('Group conversation is missing epoch key material')
      }

      const resolvedWallet = wallet || messagingWallet()
      const rawSender =
        explicitSenderAddress ||
        resolvedWallet?.identity?.displayAddress ||
        (await getOwnCanonicalAddress()) ||
        ''
      const senderAddress = safeChainDisplayAddress(rawSender) || rawSender

      const epochKeys = deriveEpochKeys(
        hexToBytes(epochSecretHex),
        groupIdHex,
        epoch,
      )
      const rosterMember = conv.groupState?.roster?.find(m =>
        sameCanonicalAddress(m.address, senderAddress),
      )
      if (!rosterMember)
        throw new Error('Sender is not in the authenticated group roster')
      const senderIndex = rosterMember.index
      const signer = await accountSession.getGroupSigner(groupIdHex, epoch)
      if (bytesToHex(signer.publicKey) !== rosterMember.epochSigningPubKeyHex)
        throw new Error('Group sender does not match active account')
      checkGroup()
      const timestampMs = Date.now()
      const payload = encodeGroupItems(items)
      const innerDigest = computeInnerMessageSigningHash({
        groupIdHex,
        epoch,
        senderIndex,
        senderEpochPubKey: signer.publicKey,
        timestampMs,
        payload,
      })
      const signature = await signer.signDigest(innerDigest)
      checkGroup()
      const sealed = sealGroupMessage({
        epochKeys,
        senderIndex,
        senderEpochPublicKey: signer.publicKey,
        senderSignature: signature,
        senderAddress,
        payload,
        timestampMs,
      })
      // The member-signed digest names the message, not its ciphertext (see openGroupMessage).
      const payloadDigest = bytesToHex(innerDigest)

      this.sendMessageLocal({
        address: conv.address,
        conversationId: conv.id,
        senderAddress,
        index: payloadDigest,
        items,
        outpoints: [],
        status: 'pending',
        previousHash: null,
        timestamp: timestampMs,
      })

      conv.groupState!.pendingMessages ??= {}
      conv.groupState!.pendingMessages[payloadDigest] = true
      this.messages[payloadDigest]!.groupEnvelope = sealed
      await this.saveOutgoing(conv.address, payloadDigest, { strict: true })
      checkGroup()
      await this.flushPersistence?.()
      return this.retryGroupMessage(conv.id, payloadDigest, relayClient)
    },
    /** Retries the exact signed envelope; never constructs new content for an uncertain send. */
    async retryGroupMessage(
      conversationId: string,
      payloadDigest: string,
      relayClient?: GroupRelayClient,
    ): Promise<OutgoingOutcome> {
      return groupRun(this, `message:${payloadDigest}`, () =>
        this.retryGroupMessageOnce(conversationId, payloadDigest, relayClient),
      )
    },
    async retryGroupMessageOnce(
      conversationId: string,
      payloadDigest: string,
      relayClient?: GroupRelayClient,
    ): Promise<OutgoingOutcome> {
      const conv = this.conversations[conversationId]
      const pending = conv?.groupState?.pendingMessages?.[payloadDigest]
      const message = this.messages[payloadDigest]
      const envelope = message?.groupEnvelope
      if (
        !conv?.groupState ||
        !pending ||
        !envelope ||
        !message ||
        conv.membershipStatus !== 'joined'
      )
        return { state: 'failed', reason: 'unreachable' }
      const checkGroup = captureGroupContext(this, conv)
      const state = conv.groupState
      const signer = await accountSession.getGroupSigner(
        state.groupIdHex,
        envelope.epoch,
      )
      const epoch =
        envelope.epoch === state.epoch
          ? state
          : state.epochHistory[envelope.epoch]
      if (!epoch) throw new Error('Missing group send authority')
      const owner = epoch.roster.find(
        member => member.epochSigningPubKeyHex === bytesToHex(signer.publicKey),
      )
      if (!owner || !sameCanonicalAddress(owner.address, message.senderAddress))
        throw new Error('Group send belongs to another account')
      const client = relayClient ?? this.getGroupRelayClient(state.homeRelay)
      // Retry may follow a rejected initial receipt write. Re-establish durability before transport.
      await this.saveOutgoing(conv.address, payloadDigest, { strict: true })
      checkGroup()
      await this.flushPersistence?.()
      checkGroup()
      try {
        const res = await client.sendGroupMessage(state.groupIdHex, envelope)
        checkGroup()
        message.status = 'confirmed'
        // The relay time replaces this device's clock, as it does for every member; an
        // acknowledgement of a retried copy never moves an earlier accepted row's time.
        const relayTime = message.localTime
          ? res.server_time_ms
          : Math.min(message.serverTime, res.server_time_ms)
        message.serverTime = relayTime
        message.receivedTime = relayTime
        message.localTime = false
        conv.messages.sort(byRelayTime)
        await this.saveOutgoing(conv.address, payloadDigest, { strict: true })
        checkGroup()
        delete state.pendingMessages![payloadDigest]
        conv.lastReceived = Math.max(conv.lastReceived ?? 0, res.server_time_ms)
        recomputeChatAccounting(conv, this.activeConversationId)
        checkGroup()
        await this.flushPersistence?.()
        return { state: 'sent', payloadDigest }
      } catch (error) {
        checkGroup()
        state.pendingMessages ??= {}
        state.pendingMessages[payloadDigest] = true
        message.status = 'error'
        message.delivery = {
          failureReason: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
        }
        await this.saveOutgoing(conv.address, payloadDigest, { strict: true })
        return { state: 'failed', reason: 'unreachable' }
      }
    },
    /** Reconcile the original signed epoch after timeout/restart before delivering its secret.
     * 'superseded' means another device of this administrator account published a different
     * successor first: it was adopted, and the prepared one was dropped unsent. */
    async retryGroupEpochPublication(
      conversationId: string,
      relayClient?: GroupRelayClient,
    ): Promise<'published' | 'superseded'> {
      return groupRun(this, `publish:${conversationId}`, () =>
        this.retryGroupEpochPublicationOnce(conversationId, relayClient),
      )
    },
    async retryGroupEpochPublicationOnce(
      conversationId: string,
      relayClient?: GroupRelayClient,
    ): Promise<'published' | 'superseded'> {
      const conv = this.conversations[conversationId]
      const state = conv?.groupState
      const pending = state?.pendingEpoch
      if (!state || !pending) return 'published'
      const checkGroup = captureGroupContext(this, conv)
      const client = relayClient ?? this.getGroupRelayClient(state.homeRelay)
      const certificate = pending.certificate
      // A rotation is the prepared successor; at creation the pending epoch is already current.
      const rotation = certificate.epoch_hash !== state.epochFrame.epoch_hash
      const identity = directoryAddress(
        bytesToHex(await accountSession.getCurvePublicKey('secp256k1')),
      )
      checkGroup()
      if (
        !state.roster.some(
          member => member.role === 'admin' && member.address === identity,
        )
      )
        throw new Error('Pending group epoch belongs to another account')
      await this.flushPersistence?.()
      checkGroup()
      try {
        await client.publishEpoch(
          state.groupIdHex,
          certificate,
          pending.expectedPreviousHash,
        )
      } catch (error) {
        const observed = groupEpochCertificate(
          await client.getLatestEpoch(state.groupIdHex),
        )
        checkGroup()
        if (observed.epoch_hash !== certificate.epoch_hash) {
          // The relay still holds the predecessor: the outcome is uncertain, retry later.
          if (!rotation || observed.epoch_hash === state.epochFrame.epoch_hash)
            throw error
          // Another device of this administrator account won the CAS race with a different
          // successor. Adopting it drops the prepared epoch and its never-sent deliveries.
          await adoptPublishedAdminEpochs(
            conv,
            client,
            identity,
            checkGroup,
            observed,
          )
          await this.flushPersistence?.()
          return hasAppliedGroupEpoch(conv, certificate)
            ? 'published'
            : 'superseded'
        }
        if (!rotation)
          openGroupEpochCertificate({
            groupIdHex: state.groupIdHex,
            groupPubKeyHex: state.groupPubKeyHex,
            epochSecretHex: state.epochSecretHex,
            certificate: observed,
            expectedEpoch: state.epoch,
          })
      }
      checkGroup()
      if (conv.groupState === state && state.pendingEpoch === pending) {
        if (rotation)
          // Verifies the certificate against its secret and queues its deliveries.
          applyAuthenticatedGroupEpoch(
            conv,
            certificate,
            pending.epochSecretHex!,
            identity,
            Date.now(),
          )
        else state.pendingEpoch = undefined
      }
      checkGroup()
      await this.flushPersistence?.()
      return hasAppliedGroupEpoch(conv, certificate)
        ? 'published'
        : 'superseded'
    },
    /** Queued certificate deliveries retain recipients and content across restart. */
    async retryGroupMemberDeliveries(
      conversationId: string,
      wallet: WalletHandle | undefined = messagingWallet(),
    ): Promise<void> {
      return groupRun(this, `deliveries:${conversationId}`, () =>
        this.retryGroupMemberDeliveriesOnce(conversationId, wallet),
      )
    },
    async retryGroupMemberDeliveriesOnce(
      conversationId: string,
      wallet: WalletHandle | undefined = messagingWallet(),
    ): Promise<void> {
      const conv = this.conversations[conversationId]
      const pending = conv?.groupState?.pendingMemberDeliveries
      if (!conv?.groupState || !pending || conv.groupState.pendingEpoch) return
      const checkGroup = captureGroupContext(this, conv)
      if (
        wallet &&
        !conv.groupState.roster.some(
          member =>
            member.role === 'admin' &&
            sameCanonicalAddress(
              member.address,
              wallet.identity.displayAddress,
            ),
        )
      )
        throw new Error(
          'Pending group membership deliveries belong to another account',
        )
      for (const [address, deliveries] of Object.entries(pending)) {
        if (!wallet) break
        while (deliveries.length) {
          if (
            deliveries[0].items.some(
              item => item.type === 'group-welcome' && item.adminSecretKeyHex,
            ) &&
            !sameCanonicalAddress(address, wallet.identity.displayAddress)
          )
            throw new Error(
              'Administrative group secret cannot be delivered to a peer',
            )
          try {
            const outcome = await this.sendMessage({
              wallet,
              address,
              items: deliveries[0].items,
              operationId: deliveries[0].operationId,
              stampValue: 0n,
            })
            checkGroup()
            if (outcome.state !== 'sent') break
            deliveries.shift()
            checkGroup()
            await this.flushPersistence?.()
          } catch {
            break /* Retained for account-bound recovery. */
          }
        }
        if (!deliveries.length) delete pending[address]
      }
      conv.groupState.syncFailed = Object.keys(pending).length > 0
      checkGroup()
      await this.flushPersistence?.()
    },

    /**
     * Issue #70: Polls the shared group mailbox (`GET /groups/:group_id/epochs` and
     * `GET /groups/:group_id/messages?after_seq=`) for a joined group conversation,
     * decrypts and verifies inner member signatures, and appends new messages.
     */
    async syncGroupConversation(
      conversationId: string,
      options: { relayClient?: GroupRelayClient; ownAddress?: string } = {},
    ): Promise<number> {
      return groupRun(this, `sync:${conversationId}`, async () => {
        const conv = this.conversations[conversationId]
        try {
          const count = await this.syncGroupConversationOnce(
            conversationId,
            options,
          )
          if (conv?.groupState)
            conv.groupState.syncFailed = Boolean(
              Object.keys(conv.groupState.pendingMemberDeliveries ?? {})
                .length ||
                Object.keys(conv.groupState.pendingControls ?? {}).length ||
                Object.keys(conv.groupState.pendingMessages ?? {}).length,
            )
          return count
        } catch (error) {
          if (conv?.groupState) conv.groupState.syncFailed = true
          throw error
        }
      })
    },
    async syncGroupConversationOnce(
      conversationId: string,
      options: { relayClient?: GroupRelayClient; ownAddress?: string } = {},
    ): Promise<number> {
      if (!this.shouldPollGroupMailbox(conversationId)) return 0
      await this.retryGroupEpochPublication(conversationId, options.relayClient)
      await this.retryGroupMemberDeliveries(conversationId)
      const conv = this.conversations[conversationId]
      if (!conv || conv.kind !== 'group') return 0

      const checkGroup = captureGroupContext(this, conv)
      const homeRelay =
        conv.groupState?.homeRelay ??
        conv.groupRelayUrl ??
        this.getGroupHomeRelay()
      const client = options.relayClient ?? this.getGroupRelayClient(homeRelay)
      const ownRaw =
        options.ownAddress ||
        messagingWallet()?.identity?.displayAddress ||
        (await getOwnCanonicalAddress())
      const ownAddress = ownRaw
        ? safeChainDisplayAddress(ownRaw) || ownRaw
        : null
      checkGroup()
      // An administrator device adopts epochs another device of the account published.
      if (!conv.groupState?.pendingEpoch)
        await adoptPublishedAdminEpochs(conv, client, ownAddress, checkGroup)
      const groupIdHex = conv.groupState?.groupIdHex ?? conv.groupId!
      const epochSecretHex =
        conv.groupState?.epochSecretHex ?? conv.groupEpochSecretHex!
      const epoch = conv.groupState?.epoch ?? conv.epoch?.generation ?? 0

      const epochKeys = deriveEpochKeys(
        hexToBytes(epochSecretHex),
        groupIdHex,
        epoch,
      )

      if (!conv.groupState) throw new Error('Missing authenticated group state')
      const currentCertificate = groupEpochCertificate(
        await client.getLatestEpoch(groupIdHex),
      )
      if (
        currentCertificate.epoch_hash !== conv.groupState.epochFrame.epoch_hash
      )
        throw new Error('Group epoch changed; membership update required')
      openGroupEpochCertificate({
        groupIdHex,
        groupPubKeyHex: conv.groupPubKey!,
        epochSecretHex,
        certificate: currentCertificate,
        expectedEpoch: epoch,
      })

      // Pending indexes are rebuilt from original durable receipts on restore. Recover those
      // exact authorizations independently of the direct-message wallet attempt journal.
      for (const digest of Object.keys(conv.groupState.pendingMessages ?? {})) {
        await this.retryGroupMessage(conv.id, digest, client)
        checkGroup()
      }

      // 2. Fetch ordered messages after lastSyncedSeq
      const afterSeq = conv.groupState?.lastSyncedSeq ?? 0
      const fetched = await client.fetchGroupMessages(
        groupIdHex,
        epochKeys.readTokenHex,
        afterSeq,
      )
      if (fetched.epoch !== epoch)
        throw new Error(
          'Group mailbox epoch differs from authenticated certificate',
        )
      let addedCount = 0

      checkGroup()
      for (const row of fetched.messages) {
        if (
          row.group_id !== groupIdHex ||
          !Number.isSafeInteger(row.epoch) ||
          row.epoch < 0 ||
          !Number.isSafeInteger(row.server_seq) ||
          row.server_seq <= conv.groupState.lastSyncedSeq
        )
          throw new Error('Invalid group mailbox sequence')
        // The relay appends only at its current epoch, so once a row of a later epoch was
        // accepted an older-epoch row after it was not written by a member of that epoch (for
        // example a removed member posting through a colluding relay). It is not accepted.
        if (row.epoch < (conv.groupState.highestSyncedEpoch ?? 0)) {
          conv.groupState.lastSyncedSeq = row.server_seq
          continue
        }
        const rowState =
          row.epoch === conv.groupState.epoch
            ? conv.groupState
            : conv.groupState.epochHistory[row.epoch]
        if (!rowState) {
          // An invitation grants the current epoch, never the history before joining.
          const earliestKnown = Math.min(
            conv.groupState.epoch,
            ...Object.keys(conv.groupState.epochHistory).map(Number),
          )
          if (row.epoch < earliestKnown) {
            const certificate = await client.getEpoch(groupIdHex, row.epoch)
            checkGroup()
            if (!verifyEpochFrame(certificate, groupIdHex, conv.groupPubKey!))
              throw new Error('Invalid pre-join epoch certificate')
            verifyGroupMessageWriteSignature(
              row,
              groupIdHex,
              certificate.write_pubkey,
            )
            conv.groupState.lastSyncedSeq = row.server_seq
            conv.groupState.highestSyncedEpoch = row.epoch
            continue
          }
          throw new Error('Unknown group message epoch')
        }
        const { epochKeys: rowEpochKeys } = openGroupEpochCertificate({
          groupIdHex,
          groupPubKeyHex: conv.groupPubKey!,
          epochSecretHex: rowState.epochSecretHex,
          certificate: rowState.epochFrame,
          expectedEpoch: row.epoch,
        })
        const opened = openGroupMessage({
          envelope: row,
          epochKeys: rowEpochKeys,
          roster: rowState.roster,
        })
        const items = decodeGroupItems(opened.payload)
        conv.groupState.highestSyncedEpoch = row.epoch

        // The member-signed digest names the message. A member can re-encrypt another
        // member's signed frame under a new nonce; that replay has the same digest and
        // collapses into the original instead of showing as a new authenticated message.
        const payloadDigest = opened.innerDigestHex
        const rawSender = opened.senderAddress
        const senderAddress = safeChainDisplayAddress(rawSender) || rawSender
        const isOutbound = Boolean(
          ownAddress && sameCanonicalAddress(senderAddress, ownAddress),
        )
        // Ordered and read by the relay time of the first accepted row, which every device
        // sees alike. The member-signed time is the sender's clock and orders nothing; a replay
        // under a new nonce collapses into that first row by its digest.
        const serverTime = row.server_time_ms

        const existingMsg = this.messages[payloadDigest]
        if (existingMsg) {
          if (existingMsg.groupEnvelope?.ciphertext !== row.ciphertext) {
            conv.groupState.lastSyncedSeq = row.server_seq
            continue
          }
          // Our own send: its local time, or the acknowledgement of a retried copy, gives way
          // to the earliest row holding this envelope.
          const relayTime = existingMsg.localTime
            ? serverTime
            : Math.min(existingMsg.serverTime, serverTime)
          existingMsg.status = 'confirmed'
          existingMsg.serverTime = relayTime
          existingMsg.receivedTime = relayTime
          existingMsg.localTime = false
          conv.messages.sort(byRelayTime)
          await (
            await store
          ).saveMessage(
            {
              message: existingMsg,
              index: payloadDigest,
              outbound: existingMsg.outbound,
              senderAddress: existingMsg.senderAddress,
              copartyAddress: conv.address,
            },
            { advanceCursor: false },
          )
          if (conv.groupState.pendingMessages)
            delete conv.groupState.pendingMessages[payloadDigest]
          conv.groupState.lastSyncedSeq = row.server_seq
          continue
        }

        const chatMsg: ChatMessage = {
          groupEnvelope: {
            epoch: row.epoch,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            write_sig: row.write_sig,
          },
          outbound: isOutbound,
          status: 'confirmed',
          receivedTime: row.server_time_ms,
          serverTime,
          localTime: false,
          items,
          outpoints: [],
          senderAddress,
          destinationAddress: conv.address,
          payloadDigest,
          messageHash: payloadDigest,
          conversationId: conv.id,
          logicalMessageId: payloadDigest,
          revisionDigest: payloadDigest,
          deliveryDigest: payloadDigest,
        }
        await (
          await store
        ).saveMessage(
          {
            message: chatMsg,
            index: payloadDigest,
            outbound: isOutbound,
            senderAddress,
            copartyAddress: conv.address,
          },
          { advanceCursor: false },
        )
        checkGroup()
        this.messages[payloadDigest] = chatMsg
        if (!conv.messages.some(m => m.payloadDigest === payloadDigest)) {
          conv.messages.push(chatMsg)
          conv.messages.sort(byRelayTime)
        }
        conv.lastReceived = Math.max(conv.lastReceived ?? 0, row.server_time_ms)
        if (conv.id === this.activeConversationId && !isOutbound) {
          conv.lastRead = Math.max(conv.lastRead ?? 0, serverTime)
        }
        recordLogicalMessage(this.logicalMessages, chatMsg, conv.id)
        recomputeChatAccounting(conv, this.activeConversationId)
        this.lastReceived = Math.max(this.lastReceived ?? 0, row.server_time_ms)
        conv.groupState.lastSyncedSeq = row.server_seq
        addedCount += 1
      }

      checkGroup()
      await this.flushPersistence?.()
      return addedCount
    },
    /**
     * Issue #70: Polls all joined group conversations on the account.
     */
    async syncAllJoinedGroups(
      options: { relayClient?: GroupRelayClient; ownAddress?: string } = {},
    ): Promise<number> {
      let total = 0
      for (const conv of Object.values(this.conversations)) {
        if (conv && this.shouldPollGroupMailbox(conv.id)) {
          try {
            total += await this.syncGroupConversation(conv.id, options)
          } catch (err) {
            console.warn(
              `[chats] Failed to sync group conversation ${conv.id}:`,
              err,
            )
          }
        }
      }
      return total
    },
    /**
     * Issue #70: Invites a new member to an existing group conversation by ratcheting the
     * group epoch on the relay (`rotateGroupEpochOnRelay`), broadcasting an in-band
     * `GroupControlItem`, and sending a 1:1 `GroupWelcomeItem` DM to the new member.
     */
    async inviteMemberToGroup(input: {
      conversationId: string
      memberAddress: string
      wallet?: WalletHandle
      relayClient?: GroupRelayClient
      /** Applies the change only while it is still the superseded one on record. */
      retrying?: GroupMemberChange
    }): Promise<Conversation> {
      return groupRun(
        this,
        `membership:${input.conversationId}`,
        () => this.inviteMemberToGroupOnce(input),
        false,
      )
    },
    async inviteMemberToGroupOnce({
      conversationId,
      memberAddress,
      wallet,
      relayClient,
      retrying,
    }: {
      conversationId: string
      memberAddress: string
      wallet?: WalletHandle
      relayClient?: GroupRelayClient
      retrying?: GroupMemberChange
    }): Promise<Conversation> {
      const { conv, state, client, checkGroup } = await this.beginGroupRotation(
        conversationId,
        relayClient,
      )
      // The adopted epochs may have settled or undone the change since the user saw it.
      if (retrying && !sameMemberChange(state.supersededMemberChange, retrying))
        return conv
      const groupIdHex = state.groupIdHex
      const prevEpochHashHex = state.epochFrame.epoch_hash
      const canonicalNewMember =
        safeChainDisplayAddress(memberAddress.trim()) || memberAddress.trim()
      const updatedAddresses = Array.from(
        new Set([
          ...state.roster.map(
            m => safeChainDisplayAddress(m.address) || m.address,
          ),
          canonicalNewMember,
        ]),
      )
      const members = await Promise.all(
        updatedAddresses.map(async address => {
          const existingMember = state.roster.find(member =>
            sameCanonicalAddress(member.address, address),
          )
          if (existingMember) return existingMember
          const parsed = activeChain.parseAddress(address)
          if (!parsed) throw new Error('Invalid group member address')
          const profile = await fetchContactProfile(parsed)
          if (!profile?.pubKey)
            throw new Error('Group member has no authenticated identity')
          const identityPubKeyHex = bytesToHex(profile.pubKey)
          if (
            !sameCanonicalAddress(directoryAddress(identityPubKeyHex), address)
          )
            throw new Error('Group member identity mismatch')
          return {
            address: directoryAddress(identityPubKeyHex)!,
            identityPubKeyHex,
            role: 'member' as const,
          }
        }),
      )
      checkGroup()
      const rotated = this.prepareGroupRotation(conv, state, client, members)
      const newRosterEntry = rotated.roster.members.find(m =>
        sameCanonicalAddress(m.address, canonicalNewMember),
      )
      const resolvedWallet = wallet || messagingWallet()
      const ownAddress =
        resolvedWallet?.identity?.displayAddress ||
        (await getOwnCanonicalAddress()) ||
        conv.invitedBy ||
        ''
      checkGroup()
      const welcomeItem: GroupWelcomeItem = {
        type: 'group-welcome',
        epochFrame: groupEpochCertificate(rotated.epochFrame),
        groupId: groupIdHex,
        groupPubKey: conv.groupPubKey ?? '',
        groupName: conv.name || 'Group',
        homeRelay: client.relayUrl,
        epoch: rotated.epoch,
        epochSecretHex: rotated.epochSecretHex,
        memberIndex: newRosterEntry?.index ?? rotated.roster.members.length - 1,
        inviterAddress: ownAddress,
      }
      const control: GroupControlItem = {
        type: 'group-control',
        groupId: groupIdHex,
        epochFrame: groupEpochCertificate(rotated.epochFrame),
        action: 'add-member',
        epoch: rotated.epoch,
        prevEpochHash: prevEpochHashHex,
        epochSecretHex: rotated.epochSecretHex,
        targetAddress: canonicalNewMember,
        authoritySigHex: rotated.epochFrame.authority_sig,
      }
      return this.publishGroupRotation({
        conv,
        state,
        client,
        checkGroup,
        rotated,
        wallet: resolvedWallet,
        itemFor: address =>
          sameCanonicalAddress(address, canonicalNewMember)
            ? welcomeItem
            : control,
        memberChange: { action: 'add-member', address: canonicalNewMember },
      })
    },
    /** Rotations start from the epoch the relay holds: whatever another device of this
     * administrator account already published is adopted first. */
    async beginGroupRotation(
      conversationId: string,
      relayClient?: GroupRelayClient,
    ): Promise<{
      conv: Conversation
      state: GroupConversationState
      client: GroupRelayClient
      checkGroup: () => void
    }> {
      const conv = this.conversations[conversationId]
      if (!conv || conv.kind !== 'group' || !conv.groupState) {
        throw new Error('Group conversation not found')
      }
      const checkGroup = captureGroupContext(this, conv)
      if (conv.groupState.pendingEpoch)
        throw new Error('Group epoch publication is pending')
      if (
        conv.membershipStatus !== 'joined' ||
        !conv.groupState.groupSecretKeyHex
      )
        throw new Error(
          'Only the founding administrator can change group membership',
        )
      const client =
        relayClient ?? this.getGroupRelayClient(conv.groupState.homeRelay)
      const ownAddress = await getOwnCanonicalAddress()
      checkGroup()
      if (await adoptPublishedAdminEpochs(conv, client, ownAddress, checkGroup))
        await this.flushPersistence?.()
      checkGroup()
      return { conv, state: conv.groupState, client, checkGroup }
    },
    prepareGroupRotation(
      conv: Conversation,
      state: GroupConversationState,
      client: GroupRelayClient,
      members: CreateGroupOnRelayMemberInput[],
    ): ReturnType<typeof prepareGroupEpochRotation> {
      if (conv.groupState !== state || state.pendingEpoch)
        throw new Error(GROUP_EPOCH_SUPERSEDED)
      return prepareGroupEpochRotation({
        client,
        groupIdHex: state.groupIdHex,
        groupPubKeyHex: state.groupPubKeyHex,
        prevEpoch: state.epoch,
        prevEpochHashHex: state.epochFrame.epoch_hash,
        prevEpochSecret: hexToBytes(state.epochSecretHex),
        groupName: conv.name || 'Group',
        members,
        authorityPrivateKey: hexToBytes(state.groupSecretKeyHex!),
      })
    },
    /** Persist the prepared successor with its deliveries, then publish it. The local epoch
     * changes only once the relay holds it; deliveries are sent only after that. */
    async publishGroupRotation({
      conv,
      state,
      client,
      checkGroup,
      rotated,
      wallet,
      itemFor,
      memberChange,
    }: {
      conv: Conversation
      state: GroupConversationState
      client: GroupRelayClient
      checkGroup: () => void
      rotated: ReturnType<typeof prepareGroupEpochRotation>
      wallet: WalletHandle | undefined
      itemFor: (address: string) => MessageItem
      memberChange: GroupMemberChange
    }): Promise<Conversation> {
      checkGroup()
      if (conv.groupState !== state || state.pendingEpoch)
        throw new Error(GROUP_EPOCH_SUPERSEDED)
      const certificate = groupEpochCertificate(rotated.epochFrame)
      const memberDeliveries: GroupMemberDeliveries = {}
      for (const member of rotated.roster.members)
        memberDeliveries[member.address] = [
          {
            items: [itemFor(member.address)],
            operationId: nextPendingMessageId(Date.now()),
          },
        ]
      state.pendingEpoch = {
        certificate,
        expectedPreviousHash: state.epochFrame.epoch_hash,
        epochSecretHex: rotated.epochSecretHex,
        memberDeliveries,
        memberChange,
      }
      await this.flushPersistence?.()
      try {
        await this.retryGroupEpochPublication(conv.id, client)
      } catch {
        // Uncertain: the prepared epoch stays pending and is reconciled on the next sync.
        checkGroup()
        conv.groupState!.syncFailed = true
        await this.flushPersistence?.()
        return conv
      }
      checkGroup()
      if (!hasAppliedGroupEpoch(conv, certificate)) {
        // The user is told by this error; the record is for a change no one was told about.
        const current = conv.groupState!
        if (sameMemberChange(current.supersededMemberChange, memberChange)) {
          current.supersededMemberChange = undefined
          await this.flushPersistence?.()
        }
        throw new Error(GROUP_EPOCH_SUPERSEDED)
      }
      try {
        await this.retryGroupMemberDeliveries(conv.id, wallet)
      } catch {
        checkGroup()
        conv.groupState!.syncFailed = true
        await this.flushPersistence?.()
      }
      return conv
    },
    /**
     * Issue #70: Removes a member from a group conversation with forward-secret key rotation
     * (the new epoch secret mixes in administrator-only entropy, so the removed member
     * cannot derive the new epoch keys or read/write subsequent messages).
     */
    async removeMemberFromGroup(input: {
      conversationId: string
      memberAddress: string
      wallet?: WalletHandle
      relayClient?: GroupRelayClient
      /** Applies the change only while it is still the superseded one on record. */
      retrying?: GroupMemberChange
    }): Promise<Conversation> {
      return groupRun(
        this,
        `membership:${input.conversationId}`,
        () => this.removeMemberFromGroupOnce(input),
        false,
      )
    },
    async removeMemberFromGroupOnce({
      conversationId,
      memberAddress,
      wallet,
      relayClient,
      retrying,
    }: {
      conversationId: string
      memberAddress: string
      wallet?: WalletHandle
      relayClient?: GroupRelayClient
      retrying?: GroupMemberChange
    }): Promise<Conversation> {
      const { conv, state, client, checkGroup } = await this.beginGroupRotation(
        conversationId,
        relayClient,
      )
      // The adopted epochs may have settled or undone the change since the user saw it.
      if (retrying && !sameMemberChange(state.supersededMemberChange, retrying))
        return conv
      const removedAddress =
        safeChainDisplayAddress(memberAddress) || memberAddress
      const rotated = this.prepareGroupRotation(
        conv,
        state,
        client,
        state.roster.filter(
          member => !sameCanonicalAddress(member.address, memberAddress),
        ),
      )
      const controlItem: GroupControlItem = {
        type: 'group-control',
        epochFrame: groupEpochCertificate(rotated.epochFrame),
        groupId: state.groupIdHex,
        action: 'remove-member',
        epoch: rotated.epoch,
        prevEpochHash: state.epochFrame.epoch_hash,
        epochSecretHex: rotated.epochSecretHex,
        targetAddress: removedAddress,
        authoritySigHex: rotated.epochFrame.authority_sig,
      }
      return this.publishGroupRotation({
        conv,
        state,
        client,
        checkGroup,
        rotated,
        wallet: wallet || messagingWallet(),
        itemFor: () => controlItem,
        memberChange: { action: 'remove-member', address: removedAddress },
      })
    },
    /** Applies the user's superseded membership change again, on top of the current epoch. */
    async retrySupersededMemberChange(
      conversationId: string,
      relayClient?: GroupRelayClient,
    ): Promise<Conversation> {
      const change =
        this.conversations[conversationId]?.groupState?.supersededMemberChange
      if (!change) throw new Error('No superseded group membership change')
      const input = {
        conversationId,
        memberAddress: change.address,
        relayClient,
        retrying: change,
      }
      return change.action === 'add-member'
        ? this.inviteMemberToGroup(input)
        : this.removeMemberFromGroup(input)
    },
    async dismissSupersededMemberChange(conversationId: string): Promise<void> {
      const state = this.conversations[conversationId]?.groupState
      if (!state?.supersededMemberChange) return
      state.supersededMemberChange = undefined
      await this.flushPersistence?.()
    },
    /**
     * Issue #70: Leaves a group conversation locally and stops polling its shared mailbox.
     */
    leaveGroupConversation(conversationId: string): Conversation | undefined {
      const conv = this.conversations[conversationId]
      if (!conv || conv.kind !== 'group') return undefined
      conv.membershipStatus = 'left'
      conv.updatedAt = Date.now()
      if (this.activeConversationId === conversationId) {
        this.activeConversationId = null
      }
      return conv
    },
    async notifyReceivedMessages(
      messageWrappers: ReceivedMessageWrapper[],
      toNotify: Set<string>,
      lease?: DeliveryLease,
    ): Promise<void> {
      const notifiableInboundCount = messageWrappers.filter(wrapper => {
        const stored = this.messages[wrapper.index]
        return toNotify.has(wrapper.index) && !!stored && !stored.outbound
      }).length
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
        const rawClaimedId =
          messageWrapper.message.conversationId || messageWrapper.conversationId
        let claimedConv: Conversation | undefined
        if (rawClaimedId) {
          try {
            claimedConv =
              this.conversations[canonicalConversationId(rawClaimedId)]
          } catch {
            claimedConv = undefined
          }
        }
        const conversation = this.conversations[stored.conversationId ?? '']
        const isPeer =
          (!conversation ||
            !isChainAddress(conversation.address) ||
            sameCanonicalAddress(conversation.address, copartyAddress)) &&
          (!claimedConv ||
            !isChainAddress(claimedConv.address) ||
            sameCanonicalAddress(claimedConv.address, copartyAddress))
        if (isPeer && !contacts.isContact(copartyAddress)) {
          contacts.addLoadingContact({
            address: copartyAddress,
            pubKey: copartyPubKey,
          })
          await contacts.refresh(copartyAddress)
        }

        const acceptancePrice = useProfileStore().inbox.acceptancePrice ?? 0
        if (document.hasFocus()) {
          acknowledgeServiceWorkerWakeupHandled()
          continue
        }
        if (
          stampValue < acceptancePrice ||
          this.lastRead(stored.conversationId!) > newMsg.serverTime ||
          notifiableInboundCount !== 1
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
          acknowledgeServiceWorkerWakeupHandled()
          desktopNotify(
            senderName,
            body,
            contact.profile.avatar ?? '',
            async () =>
              this.setActiveConversation(stored.conversationId!, {
                requestFocus: true,
              }),
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
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('notFound' in error) ||
          error.notFound !== true
        )
          throw error
      }
      const deserializedChats = JSON.parse(chats) as RestorableState

      const invalidStore =
        metadata.networkName !== displayNetwork ||
        metadata.version !== STORE_SCHEMA_VERSION
      if (invalidStore) {
        await rehydrateChat(deserializedChats, false)
        return freshChatState()
      }
      return rehydrateChat(deserializedChats, true)
    },
  },
})
