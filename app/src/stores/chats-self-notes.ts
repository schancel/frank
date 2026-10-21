import {
  CanonicalRecipientNotPublishedError,
  DirectMessageStampBelowFeeError,
} from '@frank/wallet/chain'
import {
  MonadStampAbandonedError,
  MonadStampRecoveredAttemptError,
  MonadStampRejectedError,
  MonadStampTerminalError,
  StampBlockedError,
} from '@frank/wallet/evm-stamp-client'
import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/mailbox-client'
import type {
  MessageItem,
  OutgoingFailureReason,
  SwapRecordItem,
  ConversationStateItem,
  OutboxMessageItem,
  MessageTombstoneItem,
  JournalCheckpointItem,
} from '@frank/cashweb/types/messages'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { safeChainDisplayAddress } from '../utils/chain-address'
import { sameCanonicalAddress } from '../utils/own-address'

/**
 * The swap records of a row the account sent to itself. A swap record in anyone else's row, or
 * in our own row to someone else, says nothing about this account's swaps and is not handed on.
 * The wallet's receive rule already refuses those rows; this does not rely on it.
 */
export function ownSwapRecords(
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
export function ownConversationStates(
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

export function ownMessageTombstones(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): MessageTombstoneItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is MessageTombstoneItem =>
      !!item && item.type === 'message-tombstone',
  )
}

export function ownJournalCheckpoints(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): JournalCheckpointItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is JournalCheckpointItem =>
      !!item && item.type === 'journal-checkpoint',
  )
}

export function normalizeOutboxWrapper(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): ReceivedMessageWrapper {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items) ||
    wrapper.message.items.length !== 1 ||
    wrapper.message.items[0]?.type !== 'outbox-message'
  ) {
    return wrapper
  }
  const outbox = wrapper.message.items[0] as OutboxMessageItem & {
    recipient?: string
    payloadHash?: string
    subject?: string
    items?: MessageItem[]
  }
  const rawRecipient = outbox.recipientAddress || outbox.recipient || ''
  const recipient = safeChainDisplayAddress(rawRecipient) || rawRecipient
  const index = outbox.payloadDigest || outbox.payloadHash || wrapper.index
  const conversationId =
    outbox.conversationId ??
    wrapper.message.conversationId ??
    wrapper.conversationId
  const conversationName = outbox.conversationName ?? outbox.subject
  const stampValueWei =
    outbox.stampValueWei !== undefined
      ? BigInt(outbox.stampValueWei)
      : wrapper.message.stampValueWei
  const items: MessageItem[] = Array.isArray(outbox.items)
    ? outbox.items
    : outbox.text !== undefined
    ? [{ type: 'text', text: outbox.text }]
    : []
  // This projection changes the message identity: the self-note's authenticated digest is
  // about the note, not the outbound content it describes. The original digest is unavailable.
  const noteMessage = { ...wrapper.message }
  delete noteMessage.contentDigest
  return {
    ...wrapper,
    ...(conversationId === undefined ? {} : { conversationId }),
    outbound: true,
    copartyAddress: recipient,
    index,
    message: {
      ...noteMessage,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(conversationName === undefined ? {} : { conversationName }),
      ...(outbox.messageId === undefined
        ? {}
        : { logicalMessageId: outbox.messageId }),
      ...(stampValueWei === undefined ? {} : { stampValueWei }),
      ...(outbox.sentAt > 0 && !(wrapper.message.serverTime > 0)
        ? { serverTime: outbox.sentAt }
        : {}),
      outbound: true,
      status: 'confirmed',
      senderAddress: wrapper.senderAddress,
      destinationAddress: recipient,
      items,
    },
  }
}

export function errorDetail(error: unknown): string {
  // A send blocked by an earlier message keeps that message's payload digest, so the bubble can
  // name it (`blockingMessage`).
  if (error instanceof StampBlockedError) return error.blockingPayloadDigest
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** The sent message a blocked send waits for, found by the digest its failure kept: the
 * message whose own payload digest or payment attempt it is. */
export function blockingMessage<
  M extends {
    outbound: boolean
    payloadDigest?: string
    delivery?: { attemptDigest?: string }
  },
>(messages: Iterable<M | undefined>, digest: string): M | undefined {
  if (!/^[0-9a-f]{64}$/.test(digest)) return undefined
  for (const message of messages)
    if (
      message?.outbound &&
      (message.payloadDigest === digest ||
        message.delivery?.attemptDigest === digest)
    )
      return message
  return undefined
}

export function isNoResponseError(error: unknown): boolean {
  const candidate = error as {
    isAxiosError?: boolean
    response?: unknown
    name?: unknown
    code?: unknown
  }
  return (
    (candidate?.isAxiosError === true && candidate.response === undefined) ||
    (error instanceof Error && error.name === 'MonadMailboxRetryableError') ||
    (candidate?.name === 'OpenDirectoryError' &&
      candidate.code === 'unreachable')
  )
}

export function isInsufficientFundsError(error: unknown): boolean {
  const kind =
    error !== null && typeof error === 'object' && 'kind' in error
      ? (error as { kind?: unknown }).kind
      : undefined
  return (
    kind === 'insufficient-funds' ||
    (error instanceof Error &&
      (error.name === 'InsufficientStampFundsError' ||
        /insufficient (?:main account )?(?:balance|funds)|insufficient stamp-account capacity|no funds cover a stamp/i.test(
          error.message,
        )))
  )
}

/** Maps a failed send to the reason class shown to the user, and says whether the message must
 * keep its payment attempt (so a later retry asks the wallet about it instead of paying again). */
export function classifySendFailure(
  error: unknown,
  ownDigest: string | undefined,
): { reason: OutgoingFailureReason; keepDigest?: string } {
  if (error instanceof MonadStampRecoveredAttemptError) {
    return { reason: 'recovered' }
  }
  // Nothing was taken or signed for this message: it is not an attempt to keep.
  if (
    error instanceof StampBlockedError ||
    (error instanceof Error && error.name === 'StampBlockedError')
  ) {
    return { reason: 'blocked' }
  }
  if (error instanceof MonadStampAbandonedError) {
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
    ((error as { name?: unknown; code?: unknown })?.name ===
      'OpenDirectoryError' &&
      (error as { code?: unknown }).code === 'not-published')
  ) {
    return { reason: 'recipient-unregistered' }
  }
  if (isInsufficientFundsError(error)) {
    return { reason: 'insufficient-funds' }
  }
  if (
    error instanceof DirectMessageStampBelowFeeError ||
    (error instanceof Error && error.name === 'DirectMessageStampBelowFeeError')
  ) {
    return { reason: 'stamp-below-fee' }
  }
  return {
    reason: isNoResponseError(error) ? 'unreachable' : 'error',
    keepDigest: ownDigest,
  }
}
