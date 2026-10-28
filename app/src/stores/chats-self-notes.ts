import {
  CanonicalRecipientNotPublishedError,
  DirectMessageStampBelowFeeError,
  NativeFeeExceededError,
} from '@frank/wallet/chain'
import {
  MonadStampAbandonedError,
  MonadStampRecoveredAttemptError,
  MonadStampRejectedError,
  MonadStampTerminalError,
  StampBlockedError,
} from '@frank/wallet/evm-stamp-client'
import {
  MonadMailboxRetryableError,
  MonadMailboxUnavailableError,
} from '@frank/cashweb/relay/mailbox-client'
import { OpenDirectoryError } from '@frank/cashweb/relay/open-directory'
import { unencodableReason } from '@frank/wallet/chain/direct-message-refusal'
import { describeWalletFailure } from '@frank/wallet/wallet-failure'
import { fundsInPendingSend } from '@frank/wallet/evm-transaction-set-types'
import type {
  MessageItem,
  OutgoingFailureReason,
  SwapRecordItem,
  ConversationStateItem,
  ContactStateItem,
  DeviceClaimItem,
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

/** The contact notes of a row the account sent to itself: a contact its user added or removed on
 * another device. Anyone else's row carries none. */
export function ownContactStates(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): ContactStateItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is ContactStateItem => !!item && item.type === 'contact-state',
  )
}

/** The device claims of a row the account sent to itself: which of its devices the user acts on
 * now. Anyone else's row carries none. */
export function ownDeviceClaims(
  wrapper: ReceivedMessageWrapper,
  ownAddress: string | null,
): DeviceClaimItem[] {
  if (
    !ownAddress ||
    !sameCanonicalAddress(wrapper.senderAddress, ownAddress) ||
    !sameCanonicalAddress(wrapper.copartyAddress, ownAddress) ||
    !Array.isArray(wrapper.message.items)
  )
    return []
  return wrapper.message.items.filter(
    (item): item is DeviceClaimItem => !!item && item.type === 'device-claim',
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
  // A payment below the floor keeps the floor (wei, decimal), so the bubble can say what the
  // minimum is.
  if (error instanceof DirectMessageStampBelowFeeError)
    return error.floorWei.toString()
  // Money held by an earlier send keeps that amount (wei, decimal), so the bubble can say it.
  const tiedUp = fundsInPendingSend(error)
  if (tiedUp) return tiedUp.tiedUpWei.toString()
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
  try {
    const candidate = error as { isAxiosError?: unknown; response?: unknown }
    return (
      (candidate?.isAxiosError === true && candidate.response === undefined) ||
      error instanceof MonadMailboxRetryableError ||
      (error instanceof OpenDirectoryError && error.code === 'unreachable')
    )
  } catch {
    return false
  }
}

export function isInsufficientFundsError(error: unknown): boolean {
  return describeWalletFailure(error).kind === 'insufficient-funds'
}

/** Why a send refused before anything was paid can never succeed as it is (the wallet's own
 * reading, shared with the bot host). */
export { unencodableReason }

/** Maps a failed send to the reason class shown to the user, and says whether the message must
 * keep its payment attempt (so a later retry asks the wallet about it instead of paying again). */
export function classifySendFailure(
  error: unknown,
  ownDigest: string | undefined,
): { reason: OutgoingFailureReason; keepDigest?: string } {
  try {
    if (error instanceof MonadStampRecoveredAttemptError)
      return { reason: 'recovered' }
    // Nothing was taken or signed for this message: it is not an attempt to keep.
    if (error instanceof StampBlockedError) return { reason: 'blocked' }
    if (error instanceof MonadStampAbandonedError)
      return { reason: 'unverified', keepDigest: error.payloadHashHex }
    if (
      error instanceof MonadStampTerminalError ||
      error instanceof MonadStampRejectedError
    )
      return { reason: 'rejected' }
    if (error instanceof MonadMailboxUnavailableError)
      return { reason: 'unavailable' }
    if (
      error instanceof CanonicalRecipientNotPublishedError ||
      (error instanceof OpenDirectoryError && error.code === 'not-published')
    )
      return { reason: 'recipient-unregistered' }
    // Free funds short, but an earlier send's change not on the chain yet would cover it: said
    // as such, and sent again only on the user's Retry (owner ruling 2026-10-26).
    if (fundsInPendingSend(error)) return { reason: 'funds-in-pending-send' }
    if (isInsufficientFundsError(error)) return { reason: 'insufficient-funds' }
    if (error instanceof DirectMessageStampBelowFeeError)
      return { reason: 'stamp-below-fee' }
    if (error instanceof NativeFeeExceededError)
      return { reason: 'fee-exceeded' }
    // Refused before anything was paid or handed out, and the same message is refused again:
    // larger than a message carries, or an item no plugin can encode.
    const unencodable = unencodableReason(error)
    if (unencodable) return { reason: unencodable }
  } catch {
    // Hostile unknown values have no presentation classification authority.
  }
  return {
    reason: isNoResponseError(error) ? 'unreachable' : 'error',
    keepDigest: ownDigest,
  }
}
