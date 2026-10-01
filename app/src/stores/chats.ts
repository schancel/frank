import assert from 'assert'
import { defineStore } from 'pinia'

import { defaultStampAmount, displayNetwork } from '../utils/constants'
import { stampPrice } from '@frank/cashweb/legacy-wallet/helpers'
import { desktopNotify } from '../utils/notifications'
import { store } from '../adapters/level-message-store'
import { toChainDisplayAddress } from '../utils/chain-address'
import { formatBalance } from '../utils/formatting'
import { activeChain } from '@frank/wallet/chain'
import {
  getMessageItemPreview,
  tallyMessageItemsValue,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
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
import type {
  DirectMessageAttemptStatus,
  DirectMessagePreparationProgress,
  DirectMessageSendResult,
  WalletHandle,
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
import type {
  Message,
  MessageWrapper,
  MessageItem,
  OutgoingDelivery,
  OutgoingFailureReason,
  TextItem,
  ImageItem,
  StealthItem,
} from '@frank/cashweb/types/messages'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { useProfileStore } from './my-profile'
import { useContactStore } from './contacts'
import { mapObjIndexed, pathOr } from 'ramda'
import { STORE_SCHEMA_VERSION } from 'src/boot/pinia'
import {
  getOwnCanonicalAddress,
  sameCanonicalAddress,
} from '../utils/own-address'

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
  payloadDigest: string
  /** Outgoing messages that are not yet confirmed (#269/#270); see `Message.delivery`. */
  delivery?: OutgoingDelivery
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

type ChatState = {
  address: string
  messages: ChatMessage[]
  totalUnreadMessages: number
  totalUnreadValue: number
  totalValue: number
  lastReceived: number
  lastRead: number
  stampAmount: number
}

const defaultContactObject: Omit<ChatState, 'messages' | 'address'> = {
  stampAmount: defaultStampAmount,
  totalUnreadMessages: 0,
  totalUnreadValue: 0,
  totalValue: 0,
  lastReceived: 0,
  lastRead: 0,
}

export interface State {
  activeChatAddr: string | null
  chats: Record<string, ChatState | undefined>
  messages: Record<string, Message | undefined>
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
    messages: {},
    lastReceived: null,
    activeChatAddr: null,
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
  if (isInsufficientFundsError(error)) {
    return { reason: 'insufficient-funds' }
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
  message: Message
}

export type RestorableState = {
  activeChatAddr: string | null
  chats: Record<string, ChatState | undefined>
  messages: Record<string, Message | undefined>
  lastReceived: number | null
}

export async function rehydateChat(chatState: RestorableState): Promise<State> {
  if (!chatState) {
    return freshChatsState()
  }

  const chats: Record<string, ChatState> = {}
  const messages: Record<string, Message> = {}

  if (chatState.chats) {
    for (const [contactAddress, contact] of Object.entries(chatState.chats)) {
      assert(
        contact,
        'This is impossible, but typescript has a type hole that has to be asserted around',
      )
      chats[contactAddress] = {
        address: contactAddress,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: contact.lastReceived,
        lastRead: contact.lastRead,
        stampAmount: contact.stampAmount,
      }
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
      void localStore.deleteMessage(index).catch(err => console.warn(err))
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

    const message = { payloadDigest: index, ...newMsg }
    if (!chats[copartyAddress]) {
      chats[copartyAddress] = {
        ...defaultContactObject,
        messages: [],
        address: copartyAddress,
      }
    }
    const chat = chats[copartyAddress]
    messages[index] = message
    assert(chat, 'Missing chat for message')
    chat.messages.push(message)
    chat.lastReceived = message.serverTime
    const messageValue =
      messageStampPrice(message) + tallyMessageItemsValue(message.items)
    if (
      !newMsg.outbound &&
      chat.lastRead &&
      chat.lastRead < message.serverTime
    ) {
      chat.totalUnreadValue += messageValue
      chat.totalUnreadMessages += 1
    }
    lastReceived = Math.max(lastReceived, message.serverTime)
    chat.totalValue += messageValue
  }

  // Resort chats
  for (const chat of Object.values(chats)) {
    chat.messages.sort(
      (messageA, messageB) => messageA.serverTime - messageB.serverTime,
    )
  }
  return {
    chats,
    messages,
    activeChatAddr: chatState.activeChatAddr,
    lastReceived,
  }
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
    getNumUnread: state => (address: string) => {
      const displayAddress = toChainDisplayAddress(address)

      return state.chats[displayAddress]
        ? state.chats[displayAddress]?.totalUnreadMessages
        : 0
    },
    totalUnread(state) {
      return Object.values(state.chats)
        .map(chat => chat?.totalUnreadMessages ?? 0)
        .reduce((acc, val) => acc + val, 0)
    },
    getSortedChatOrder(state) {
      const sortedOrder = Object.values(state.chats).sort(
        (contactA, contactB) => {
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

          if (
            contactB.totalUnreadMessages - contactA.totalUnreadMessages !==
            0
          ) {
            return contactB.totalUnreadMessages - contactA.totalUnreadMessages
          }

          // No other tiebreakers
          return 0
        },
      )
      return sortedOrder
    },
    lastRead: state => (address: string) => {
      const displayAddress = toChainDisplayAddress(address)

      return state.chats[displayAddress]?.lastRead ?? 0
    },
    getStampAmount: state => (address: string) => {
      const displayAddress = toChainDisplayAddress(address)
      const chat = state.chats[displayAddress]
      if (!chat) {
        return defaultStampAmount
      }

      return chat.stampAmount ?? defaultStampAmount
    },
    getLatestMessage: state => (address: string) => {
      // Real bug found live: this used to return a placeholder `{ outbound: false, text: '' }`
      // object (named `nopInfo`, i.e. "nothing to show") for both "no chat exists yet" and "chat
      // exists but has zero messages" -- but `ChatListItem.vue`'s only caller checks `info ===
      // null` to decide whether to render anything, and a non-null object with an empty `text`
      // doesn't match that check. Net effect: `latestMessageBody` still built `'Them: ' +
      // slicedText` (with `outbound: false` always meaning "Them", regardless of there being no
      // real message at all), producing a literal "Them: " with nothing after it in the chat
      // list -- exactly what a freshly-added contact with no messages yet showed. Returning
      // `null` here instead, matching the sibling `!lastItem` case a few lines below (which
      // already correctly returns `null` for its own "nothing to render" case) and the caller's
      // existing, correct `null` handling.
      const displayAddress = toChainDisplayAddress(address)
      const chat = state.chats[displayAddress]
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
        console.error(displayAddress)
        return null
      }

      // Previously a hand-written if-chain here (text/image/stealth only) that fell through to a
      // dangling `nopInfo` reference for `reply`/`p2pkh` -- a live ReferenceError, since an earlier
      // fix removed `nopInfo`'s declaration without noticing this third use site. Routed through the
      // registry instead: every registered type gets real preview text, not a crash.
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
    async deleteMessage({
      address,
      payloadDigest,
    }: {
      address: string
      payloadDigest: string
    }) {
      await (await store).deleteMessage(payloadDigest)
      const displayAddress = toChainDisplayAddress(address)

      delete this.messages[payloadDigest]
      const chat = this.chats[displayAddress]
      if (!chat) {
        return
      }
      const msgIndex = chat.messages.findIndex(
        msg => msg.payloadDigest === payloadDigest,
      )
      if (msgIndex >= 0) {
        chat.messages.splice(msgIndex, 1)
      }
    },
    readAll(address: string) {
      const displayAddress = toChainDisplayAddress(address)
      const chat = this.chats[displayAddress]
      if (!chat) {
        // Opening a chat with nobody yet (no message either way) is normal, not an error.
        console.debug('readAll: no chat yet for', displayAddress)
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
            },
          ]
        }),
      )
      this.messages = {}
      this.lastReceived = null
    },
    sendMessageLocal({
      address,
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
    }: {
      address: string
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
    }) {
      const displayAddress = toChainDisplayAddress(address)
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
      }
      assert(newMsg.outbound !== undefined, 'outbound is not defined')
      assert(newMsg.status !== undefined, 'status is not defined')
      assert(newMsg.receivedTime !== undefined, 'receivedTime is not defined')
      assert(newMsg.serverTime !== undefined, 'serverTime is not defined')
      assert(newMsg.items !== undefined, 'items is not defined')
      assert(newMsg.outpoints !== undefined, 'outpoints is not defined')
      assert(newMsg.senderAddress !== undefined, 'senderAddress is not defined')

      const message = { payloadDigest: payloadDigest, ...newMsg }
      if (payloadDigest in this.messages) {
        const existingMessage = this.messages[payloadDigest]
        assert(existingMessage, 'For great typescript')
        // we have the message already, just need to update some fields and return
        this.messages[payloadDigest] = Object.assign(existingMessage, message)
        return
      }

      // Chat may be null if it is a self send
      const chat = this.chats[displayAddress]
      if (!chat) {
        // This was a self send, we don't want to update any particular chats.
        return
      }

      if (previousHash && previousHash in this.messages) {
        // Replace an optimistic/retried message with the newly keyed message. Monad cannot know
        // the final payload digest until its stamp payments have been submitted, so pending UI
        // entries use a local id and reconcile through this path once the real digest exists.
        const msgIndex = chat.messages.findIndex(
          msg => msg.payloadDigest === previousHash,
        )
        if (msgIndex >= 0) {
          chat.messages.splice(msgIndex, 1)
        }
        delete this.messages[previousHash]
      }

      this.messages[payloadDigest] = message
      if (displayAddress in this.chats) {
        chat.messages.push(message)
        chat.lastRead = Date.now()
        return
      }
      this.chats[displayAddress] = {
        ...defaultContactObject,
        messages: [message],
        address: displayAddress,
      }
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
     * for that message (automatic or manual) first asks the wallet what became of that set
     * (`directMessages.reconcileAttempts`): while it is `live` the identical bytes are re-sent,
     * which is free and idempotent; only when it is `dead` (the relay ended it for good) is a
     * *new* payment built, and only by an explicit manual Retry. If its fate is `unknown`, the user
     * must confirm first.
     */
    async sendMessage({
      wallet,
      address,
      items,
      stampValue,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      items: MessageItem[]
      stampValue?: bigint
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const recipient = activeChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const displayAddress = toChainDisplayAddress(address)

      // Ensure the chat exists before sending -- sendMessageLocal (see above) silently no-ops a
      // 'self send' if `this.chats[displayAddress]` isn't already present, mirroring the same
      // chat-creation shape `setActiveChat` uses.
      if (!(displayAddress in this.chats)) {
        this.chats[displayAddress] = {
          ...defaultContactObject,
          messages: [],
          address: displayAddress,
        }
      }

      const timestamp = Date.now()
      const pendingMessageId = nextPendingMessageId(timestamp)
      this.sendMessageLocal({
        address: displayAddress,
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
      // Durable before anything can go wrong: the typed text must survive a reload (#269).
      await this.saveOutgoing(displayAddress, pendingMessageId)
      return this.runOutgoing({
        wallet,
        address: displayAddress,
        id: pendingMessageId,
        manual: false,
        onPreparationProgress,
      })
    },
    /** Manual Retry of a failed outgoing message (`status: 'error'`). See `sendMessage` for the
     * no-double-payment rule this follows. */
    async retryOutgoing({
      wallet,
      address,
      payloadDigest,
      confirmed = false,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      /** The message's key in the store (`ChatMessage.payloadDigest`). */
      payloadDigest: string
      /** The user accepted that this retry may pay a second time. */
      confirmed?: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const message = this.messages[payloadDigest]
      if (!message || !message.outbound || message.status !== 'error') {
        return { state: 'busy' }
      }
      return this.runOutgoing({
        wallet,
        address: toChainDisplayAddress(address),
        id: payloadDigest,
        manual: true,
        confirmed,
        onPreparationProgress,
      })
    },
    /** Best-effort durable write of one outgoing message's current state. */
    async saveOutgoing(
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
      const message = this.messages[id]
      if (!message) {
        if (options.strict) {
          throw new Error(`outgoing message ${id} no longer exists`)
        }
        return
      }
      message.status = status
      message.delivery = delivery
      await this.saveOutgoing(address, id, options)
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
    }) {
      const message = this.messages[id]
      if (!message) return
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
      confirmed = false,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      confirmed?: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      if (inflightOutgoing.has(id) || !this.messages[id]) {
        return { state: 'busy' }
      }
      inflightOutgoing.add(id)
      let recoveredOthers = false
      try {
        const outcome = await this.runOutgoingExclusive({
          wallet,
          address,
          id,
          manual,
          confirmed,
          onPreparationProgress,
        })
        recoveredOthers =
          outcome.state === 'failed' && outcome.reason === 'recovered'
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
      confirmed,
      onPreparationProgress,
    }: {
      wallet: WalletHandle
      address: string
      id: string
      manual: boolean
      confirmed: boolean
      onPreparationProgress?: (
        progress: DirectMessagePreparationProgress,
      ) => void
    }): Promise<OutgoingOutcome> {
      const message = this.messages[id]
      assert(message, 'outgoing message vanished')
      const recipient = activeChain.parseAddress(address)
      assert(recipient, `Invalid recipient address: ${address}`)
      const previous = message.delivery
      const digest = previous?.attemptDigest

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
        const status = statuses[digest] ?? 'unknown'
        const applied = await this.applyAttemptStatus({ address, id, status })
        if (applied === 'sent') return { state: 'sent', payloadDigest: digest }
        if (applied === 'live') return { state: 'payment-pending' }
        if (applied === 'unknown') {
          if (!manual || !confirmed) {
            await this.setOutgoingState(address, id, 'error', {
              attemptDigest: digest,
              failureReason: 'unverified',
            })
            return manual
              ? { state: 'needs-confirmation', reason: 'unverified' }
              : { state: 'failed', reason: 'unverified' }
          }
        } else if (!manual) {
          // The old payment can never land. Building a new one is the user's decision (Retry).
          await this.setOutgoingState(address, id, 'error', {
            failureReason: 'rejected',
            detail: previous?.detail,
          })
          return { state: 'failed', reason: 'rejected' }
        }
        // Manual retry of a dead (or user-confirmed unknown) attempt: fall through, new payment.
      } else if (
        manual &&
        !confirmed &&
        previous?.failureReason === 'recovered'
      ) {
        return { state: 'needs-confirmation', reason: 'recovered' }
      } else if (
        manual &&
        !confirmed &&
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
        let orphans: string[]
        try {
          orphans = await activeChain.directMessages.unattributedAttempts({
            wallet,
            knownDigests: [...known],
          })
        } catch (error) {
          console.warn('could not check for an unattributed payment', error)
          orphans = ['unchecked']
        }
        if (orphans.length > 0) {
          // Leave the message 'interrupted': every unconfirmed Retry must hit this check again.
          return { state: 'needs-confirmation', reason: 'unverified' }
        }
      }

      // 2. Build and send a new payment set.
      await this.setOutgoingState(address, id, 'pending', {})
      let ownDigest: string | undefined
      let result: DirectMessageSendResult
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
            // If it fails, the wallet aborts the send and rolls the attempt back.
            await this.setOutgoingState(
              address,
              id,
              'pending',
              { attemptDigest },
              { strict: true },
            )
          },
        })
      } catch (error) {
        if (error instanceof MonadStampPendingAttemptError) {
          // Own payment set journaled but not yet confirmed: keep it, keep re-sending the same
          // bytes. Without an own set, an earlier attempt is still pending and this message has
          // not been paid for yet; it is sent once that clears.
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
      for (const [address, chat] of Object.entries(this.chats)) {
        for (const message of chat?.messages ?? []) {
          if (
            message.outbound &&
            message.status === 'payment-pending' &&
            !inflightOutgoing.has(message.payloadDigest)
          ) {
            waiting.push({
              address,
              id: message.payloadDigest,
              digest: message.delivery?.attemptDigest,
            })
          }
        }
      }
      const withAttempt = waiting.filter(entry => entry.digest !== undefined)
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
                ...(applied === 'unknown'
                  ? { attemptDigest: entry.digest }
                  : {}),
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
      for (const chat of Object.values(this.chats)) {
        pending +=
          chat?.messages.filter(
            message => message.outbound && message.status === 'payment-pending',
          ).length ?? 0
      }
      return { pending }
    },
    async clearChat(address: string) {
      const displayAddress = toChainDisplayAddress(address)

      const chat = this.chats[displayAddress]
      if (!chat) {
        return
      }
      const messageStore = await store
      for (const message of chat.messages) {
        await messageStore.deleteMessage(message.payloadDigest)
        delete this.messages[message.payloadDigest]
      }
      chat.messages = []
    },
    async deleteChat(address: string) {
      const displayAddress = toChainDisplayAddress(address)
      await this.clearChat(displayAddress)
      if (this.activeChatAddr === displayAddress) {
        this.activeChatAddr = null
      }
      delete this.chats[displayAddress]
    },
    setStampAmount({
      address,
      stampAmount,
    }: {
      address: string
      stampAmount: number
    }) {
      const chat = this.chats[address]
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
        return
      }

      // make sure address is defined, e.g. Forum is undefined
      if (address) {
        const contacts = useContactStore()
        contacts.refresh(address)
        this.readAll(address)
      }

      const displayAddress = toChainDisplayAddress(address)
      if (!(displayAddress in this.chats)) {
        this.chats[displayAddress] = {
          ...defaultContactObject,
          messages: [],
          address: displayAddress,
        }
      }
      this.activeChatAddr = displayAddress
    },
    async receiveMessages(messageWrappers: ReceivedMessageWrapper[]) {
      const toNotify = new Set<string>()
      for (const { index } of messageWrappers) {
        if (!(index in this.messages) && !notifyingIncoming.has(index)) {
          toNotify.add(index)
          notifyingIncoming.add(index)
        }
      }
      try {
        await this.storeReceivedMessages(messageWrappers, toNotify)
      } finally {
        for (const index of toNotify) {
          notifyingIncoming.delete(index)
        }
      }
    },
    async storeReceivedMessages(
      messageWrappers: ReceivedMessageWrapper[],
      toNotify: Set<string>,
    ) {
      console.log('receiving messages')
      const messageStore = await store
      const ownAddress = await getOwnCanonicalAddress()
      const outboundMatches = new Map<string, OutboundDeliveryMatch>()
      const replacedAccountCollisions = new Map<
        string,
        { chatAddress: string }
      >()

      for (const wrapper of messageWrappers) {
        const confirmed = this.messages[wrapper.index]
        const pendingEntry = Object.entries(this.messages).find(
          ([, candidate]) =>
            candidate?.outbound === true &&
            candidate.delivery?.attemptDigest === wrapper.index,
        )
        const oldIndex = confirmed ? wrapper.index : pendingEntry?.[0]
        const existing = confirmed ?? pendingEntry?.[1]
        if (!oldIndex || !existing?.outbound) continue

        const chatEntry = Object.entries(this.chats).find(([, chat]) =>
          chat?.messages.some(message => message.payloadDigest === oldIndex),
        )
        if (!chatEntry) continue
        const [chatAddress] = chatEntry
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
              delivery: undefined,
            },
          })
        } else if (confirmed) {
          // A payload from an earlier account can legitimately arrive after Replace Account.
          // It is a new inbound record for the current identity, not the old account's outbox.
          replacedAccountCollisions.set(wrapper.index, {
            chatAddress,
          })
          toNotify.add(wrapper.index)
        }
      }

      for (const wrapper of messageWrappers) {
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
        await messageStore.saveMessage(persisted)
        if (loopback && loopback.oldIndex !== wrapper.index) {
          try {
            await messageStore.deleteMessage(loopback.oldIndex)
          } catch (err) {
            // The confirmed digest wins during reload if a crash leaves the pending record.
            console.warn('could not remove the looped-back pending record', err)
          }
        }
      }

      // Apply persistence-backed reconciliations before notification/accounting. This makes a
      // poll that wins the race with `directMessages.send` completion indistinguishable from the
      // send completing first: one outbound object, one key, and no inbound value/unread effects.
      for (const [index, loopback] of outboundMatches) {
        const chat = this.chats[loopback.chatAddress]
        const position = chat?.messages.findIndex(
          message => message.payloadDigest === loopback.oldIndex,
        )
        const reconciled: ChatMessage = {
          payloadDigest: index,
          ...loopback.message,
        }
        if (chat && position !== undefined && position >= 0) {
          chat.messages.splice(position, 1, reconciled)
          chat.lastReceived = Math.max(chat.lastReceived, reconciled.serverTime)
        }
        delete this.messages[loopback.oldIndex]
        this.messages[index] = reconciled
        this.lastReceived = Math.max(
          this.lastReceived ?? 0,
          reconciled.serverTime,
        )
      }

      for (const [index, collision] of replacedAccountCollisions) {
        const chat = this.chats[collision.chatAddress]
        const position = chat?.messages.findIndex(
          message => message.payloadDigest === index,
        )
        if (chat && position !== undefined && position >= 0) {
          chat.messages.splice(position, 1)
        }
        delete this.messages[index]
      }
      // Ensure contacts are all setup
      for (const messageWrapper of messageWrappers) {
        const {
          outbound,
          copartyAddress,
          copartyPubKey,
          index,
          message: newMsg,
          stampValue,
        } = messageWrapper
        if (index in this.messages || !toNotify.has(index)) {
          continue
        }
        // Check whether contact exists
        const contacts = useContactStore()
        if (!contacts.isContact(copartyAddress)) {
          // Add dummy contact

          contacts.addLoadingContact({
            address: copartyAddress,
            pubKey: copartyPubKey,
          })

          // Load contact
          await contacts.refresh(copartyAddress)
        }

        const profileStore = useProfileStore()

        // Ignore messages below acceptance price
        const acceptancePrice = profileStore.inbox.acceptancePrice ?? 0
        const lastRead = this.lastRead(copartyAddress)

        const acceptable = stampValue >= acceptancePrice
        // If not focused (and not outbox message) then notify
        if (
          document.hasFocus() ||
          outbound ||
          !acceptable ||
          lastRead > newMsg.serverTime ||
          // Don't notify or reset active chat if we are bulk loading messages
          messageWrappers.length !== 1
        ) {
          continue
        }

        const contactStore = useContactStore()

        const contact = contactStore.getContact(copartyAddress)
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
          const formatted = formatBalance(stealthItem.amount)
          body = `[${formatted}] ` + body
        }
        if (imageItem.image.length > 0) {
          body = '[Image] ' + body
        }
        body = body + textItem.text
        if (contact && contact.notify) {
          desktopNotify(
            contact.profile.name ?? 'Unknown',
            body,
            contact.profile.avatar ?? '',
            async () => (this.activeChatAddr = copartyAddress),
            index,
          )
        }
      }

      for (const wrapper of messageWrappers) {
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
        const displayAddress = toChainDisplayAddress(copartyAddress)

        const message = { payloadDigest: index, ...newMsg }
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
          })
          if (wasOutbound) {
            const chat = this.chats[displayAddress]
            if (chat) {
              chat.lastReceived = Math.max(
                chat.lastReceived,
                message.serverTime,
              )
            }
            this.lastReceived = Math.max(
              this.lastReceived ?? 0,
              message.serverTime,
            )
          }
          // We should already have created the chat if we have the message. Continue so one
          // replayed item cannot hide later, genuinely new messages from this same poll batch.
          continue
        }
        // We don't need reactivity here
        this.messages[index] = message
        if (!(displayAddress in this.chats)) {
          // We do need reactivity to create a new chat
          this.chats[displayAddress] = {
            ...defaultContactObject,
            messages: [],
            address: displayAddress,
          }
        }
        const chat = this.chats[displayAddress]
        assert(chat, 'not possible')

        // TODO: Better indexing
        chat.messages.push(message)
        chat.lastReceived = message.serverTime
        const messageValue =
          messageStampPrice(message) + tallyMessageItemsValue(message.items)
        if (
          displayAddress !== this.activeChatAddr &&
          chat.lastRead < message.serverTime
        ) {
          chat.totalUnreadValue += messageValue
          chat.totalUnreadMessages += 1
        }
        this.lastReceived = message.serverTime
        chat.totalValue += messageValue
      }
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      const chats = {
        activeChatAddr: pathOr(undefined, ['activeChatAddr'], state),
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
