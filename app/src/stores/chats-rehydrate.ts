import type { EmailItem, MessageWrapper } from '@frank/cashweb/types/messages'
import { store } from '../adapters/level-message-store'
import { safeChainDisplayAddress } from '../utils/chain-address'
import { sameCanonicalAddress } from '../utils/own-address'
import {
  accountedMessageValue,
  addParticipant,
  assertConversationPeer,
  byRelayTime,
  canonicalConversationId,
  freeMessageId,
  freshChatsState,
  getTrustedEmailGatewayAddress,
  inDeletedConversation,
  isAnotherMessage,
  isInternalMessage,
  isOwnMessage,
  newConversation,
  recordLogicalMessage,
  reopenConversation,
  speaksForConversation,
  type ChatMessage,
  type Conversation,
  type LogicalMessageRecord,
  type RestorableState,
  type State,
} from './chats-domain'

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

  const orderedRows = [...validatedRows].sort((a, b) =>
    byRelayTime(
      { ...a.wrapper.message, payloadDigest: a.wrapper.index },
      { ...b.wrapper.message, payloadDigest: b.wrapper.index },
    ),
  )
  for (const { wrapper, conversationId, internal } of [
    ...orderedRows.filter(row => row.wrapper.message.outbound),
    ...orderedRows.filter(row => !row.wrapper.message.outbound),
  ]) {
    const { message, copartyAddress } = wrapper
    const peer = safeChainDisplayAddress(copartyAddress) || copartyAddress
    const existing = conversationId ? conversations[conversationId] : undefined
    if (internal) continue
    if (existing && message.outbound) assertConversationPeer(existing, peer)
    const id = conversationId!
    conversations[id] ??= newConversation({
      id,
      address: peer,
      participants: [peer],
      kind: message.items?.some(item => item.type === 'email')
        ? 'email'
        : 'direct',
    })
  }

  for (const { wrapper, conversationId, internal } of validatedRows) {
    if (!internal || !conversationId || !wrapper.message.outbound) continue
    const owner = conversations[conversationId]
    if (owner) assertConversationPeer(owner, wrapper.copartyAddress)
  }

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

  if (!canReconstruct) return freshChatsState()

  let lastReceived = Math.max(
    chatState.lastReceived ?? 0,
    await localStore.mostRecentMessageTime(),
  )
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
      continue
    }
    if (newMsg.outbound && newMsg.status === 'pending') {
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
