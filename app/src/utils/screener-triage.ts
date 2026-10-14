import type { ChatMessage, Conversation } from '../stores/chats'
import type { EmailItem } from '@frank/cashweb/types/messages'
import { activeChain, type ActiveChain } from '@frank/wallet/chain'
import {
  convertRawToAvu,
  DEFAULT_STAMP_TARGET_AVU,
  defaultStaticStampForChain,
  type SupportedAsset,
} from '@frank/wallet/oracle'
import { formatCompactAmount, formatDisplayAmount } from './chain-amount'
import { formatAvu } from './avu-units'
import { sameCanonicalAddress } from './own-address'

export type ScreenerStatus = 'pending' | 'approved' | 'dismissed'

export interface ScreenerTriageOptions {
  /** Lookup whether an address is already in the user's contact book. */
  isContact?: (address: string) => boolean
  /** Map of contacts if `isContact` function is not directly provided. */
  contacts?: Record<string, unknown>
  /** The current user's own canonical address. */
  ownAddress?: string | null
  /** Trusted email gateway address (so gateway-bridged emails check external sender). */
  trustedGatewayAddress?: string | null
}

export type ChainDisplayAdapter = Pick<
  ActiveChain,
  'unit' | 'toDisplayAmount' | 'fromDisplayAmount'
> & {
  chainIdentifier?: string
}

export interface FormatScreenerStampOptions {
  chain?: ChainDisplayAdapter
  asset?: SupportedAsset
  avuRate?: number
}

export interface FormattedScreenerStamp {
  valueWei: bigint
  nativeDisplay: string
  compactNativeDisplay: string
  avuValue: number
  avuDisplay: string
  combinedDisplay: string
  toString(): string
}

export interface ScreenerQueueSummary {
  count: number
  unreadCount: number
  totalValueWei: bigint
  formattedTotal: FormattedScreenerStamp
  conversations: Partial<Conversation>[]
}

function safeBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') return val >= 0n ? val : 0n
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return BigInt(Math.trunc(val))
  }
  if (typeof val === 'string' && val.trim() !== '') {
    try {
      const parsed = BigInt(val.trim())
      return parsed >= 0n ? parsed : 0n
    } catch {
      const num = Number(val)
      if (Number.isFinite(num) && num > 0) {
        return BigInt(Math.trunc(num))
      }
    }
  }
  return 0n
}

/**
 * Computes the verified stamp value attached to a single message in base chain units (wei / satoshis).
 */
export function getMessageStampValueWei(
  message:
    | (Partial<ChatMessage> & { stampValue?: number | bigint | string })
    | null
    | undefined,
): bigint {
  if (!message) return 0n

  if (
    typeof message.stampValueWei === 'bigint' &&
    message.stampValueWei >= 0n
  ) {
    return message.stampValueWei
  }

  if (
    Array.isArray(message.stampPayments) &&
    message.stampPayments.length > 0
  ) {
    let paymentSum = 0n
    for (const p of message.stampPayments) {
      paymentSum += safeBigInt(p?.valueWei)
    }
    if (paymentSum > 0n) return paymentSum
  }

  if (message.stampValue !== undefined) {
    const direct = safeBigInt(message.stampValue)
    if (direct > 0n) return direct
  }

  if (Array.isArray(message.outpoints) && message.outpoints.length > 0) {
    let utxoSum = 0n
    for (const u of message.outpoints) {
      if (!u || typeof u !== 'object') continue
      const amount = 'amount' in u ? u.amount : undefined
      const value = 'value' in u ? u.value : undefined
      utxoSum += safeBigInt(amount ?? value ?? u.satoshis)
    }
    if (utxoSum > 0n) return utxoSum
  }

  return 0n
}

/**
 * Computes the total verified inbound stamp value received in a conversation.
 * Combines message-level `stampValueWei` / `stampPayments` / `stampValue` / `outpoints`
 * and conversation-level `totalValue` / `totalUnreadValue`.
 */
export function getConversationStampValueWei(
  conversation: Partial<Conversation> | null | undefined,
): bigint {
  if (!conversation) return 0n

  let inboundMessageSum = 0n
  if (Array.isArray(conversation.messages)) {
    for (const msg of conversation.messages) {
      if (msg && !msg.outbound) {
        inboundMessageSum += getMessageStampValueWei(msg)
      }
    }
  }

  if (inboundMessageSum > 0n) {
    return inboundMessageSum
  }

  const convTotal = safeBigInt(conversation.totalValue)
  const convUnread = safeBigInt(conversation.totalUnreadValue)
  return convTotal >= convUnread ? convTotal : convUnread
}

/**
 * Resolves the effective sender address for a conversation (handling both direct P2P and email).
 */
export function getScreenerSenderAddress(
  conversation: Partial<Conversation> | null | undefined,
  ownAddress?: string | null,
): string {
  if (!conversation) return ''

  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
    : []
  const inbound = messages.find(m => m && !m.outbound)

  if (conversation.kind === 'email' && conversation.verifiedGateway) {
    if (inbound?.items) {
      const emailItem = inbound.items.find(it => it.type === 'email') as
        | EmailItem
        | undefined
      if (emailItem?.from?.address) {
        return emailItem.from.address
      }
    }
    if (conversation.emailRecipient) {
      return conversation.emailRecipient
    }
  }

  if (inbound?.senderAddress) {
    return inbound.senderAddress
  }

  if (conversation.address) {
    return conversation.address
  }

  if (Array.isArray(conversation.participants)) {
    const other = conversation.participants.find(
      p => p && (!ownAddress || !sameCanonicalAddress(p, ownAddress)),
    )
    if (other) return other
  }

  return ''
}

/**
 * Resolves a human-readable sender label for the screener banner.
 */
export function getScreenerSenderLabel(
  conversation: Partial<Conversation> | null | undefined,
  ownAddress?: string | null,
): string {
  if (!conversation) return ''
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
    : []
  const inbound = messages.find(m => m && !m.outbound)
  if (inbound?.items) {
    const emailItem = inbound.items.find(it => it.type === 'email') as
      | EmailItem
      | undefined
    if (emailItem?.from?.name && emailItem.from.address) {
      return `${emailItem.from.name} <${emailItem.from.address}>`
    }
    if (emailItem?.from?.address) {
      return emailItem.from.address
    }
  }
  return getScreenerSenderAddress(conversation, ownAddress)
}

function checkIsContact(
  address: string,
  options?: ScreenerTriageOptions,
): boolean {
  if (!address) return false
  if (options?.isContact) {
    try {
      if (options.isContact(address)) return true
    } catch {
      // ignore
    }
  }
  if (options?.contacts && typeof options.contacts === 'object') {
    if (address in options.contacts && Boolean(options.contacts[address])) {
      return true
    }
    const lower = address.toLowerCase()
    for (const [k, v] of Object.entries(options.contacts)) {
      if (
        v &&
        (k.toLowerCase() === lower || sameCanonicalAddress(k, address))
      ) {
        return true
      }
    }
  }
  return false
}

export type ScreenerContactOption =
  | ScreenerTriageOptions
  | ((address: string) => boolean)

function normalizeTriageOptions(
  optionsOrFn?: ScreenerContactOption,
  ownAddressArg?: string | null,
): ScreenerTriageOptions {
  if (typeof optionsOrFn === 'function') {
    return {
      isContact: optionsOrFn,
      ownAddress: ownAddressArg,
    }
  }
  if (optionsOrFn && typeof optionsOrFn === 'object') {
    return {
      ...optionsOrFn,
      ownAddress: optionsOrFn.ownAddress ?? ownAddressArg,
    }
  }
  return {
    ownAddress: ownAddressArg,
  }
}

/**
 * Determines whether a conversation belongs in the Paid-Stranger Screener Queue ("The Tollbooth"):
 * - Must not be deleted (`!conversation.deletedAt`).
 * - Must not be explicitly approved or dismissed (`screenerStatus !== 'approved' && screenerStatus !== 'dismissed'`).
 * - Must have at least one inbound message (`!m.outbound`) and no outbound replies (`!m.outbound`).
 * - Must have a positive verified stamp value attached (`stampValue > 0`).
 * - The sender must not be the user's own address and must not already be in `useContactStore()`.
 */
export function isScreenerConversation(
  conversation: Partial<Conversation> | null | undefined,
  optionsOrFn?: ScreenerContactOption,
  ownAddressArg?: string | null,
): boolean {
  if (!conversation || conversation.deletedAt) return false

  const status = conversation.screenerStatus
  if (status === 'approved' || status === 'dismissed') {
    return false
  }

  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
    : []

  // If the user has already replied in this conversation, it is no longer a screener thread
  if (messages.some(m => m && m.outbound)) {
    return false
  }

  const hasInboundMessage = messages.some(m => m && !m.outbound)
  if (!hasInboundMessage && status !== 'pending') {
    return false
  }

  // Must have attached a valid positive stamp
  if (getConversationStampValueWei(conversation) <= 0n) {
    return false
  }

  const options = normalizeTriageOptions(optionsOrFn, ownAddressArg)
  const ownAddress = options.ownAddress
  const senderAddress = getScreenerSenderAddress(conversation, ownAddress)
  const peerAddress = conversation.address || senderAddress

  // Self-chats are never stranger screener threads
  if (
    ownAddress &&
    ((peerAddress && sameCanonicalAddress(peerAddress, ownAddress)) ||
      (senderAddress && sameCanonicalAddress(senderAddress, ownAddress)))
  ) {
    return false
  }

  // If the sender or peer is already in contacts, it is not a stranger thread
  if (
    (senderAddress && checkIsContact(senderAddress, options)) ||
    (peerAddress &&
      (!conversation.verifiedGateway || peerAddress === senderAddress) &&
      checkIsContact(peerAddress, options))
  ) {
    return false
  }

  return true
}

/**
 * Filters and ranks Screener conversations by total verified stamp value received (descending),
 * tie-breaking by most recent message timestamp (descending).
 */
export function rankScreenerConversations<T extends Partial<Conversation>>(
  conversations: readonly T[],
  optionsOrFn?: ScreenerContactOption,
  ownAddressArg?: string | null,
): T[] {
  const options = normalizeTriageOptions(optionsOrFn, ownAddressArg)
  const screened = conversations.filter(c => isScreenerConversation(c, options))

  return screened.sort((a, b) => {
    const valA = getConversationStampValueWei(a)
    const valB = getConversationStampValueWei(b)
    if (valB !== valA) {
      return valB > valA ? 1 : -1
    }
    const timeA =
      (a as any).lastActivityAt ||
      a.lastReceived ||
      a.updatedAt ||
      a.createdAt ||
      0
    const timeB =
      (b as any).lastActivityAt ||
      b.lastReceived ||
      b.updatedAt ||
      b.createdAt ||
      0
    return timeB - timeA
  })
}

function inferImpliedAvuRate(chain: ChainDisplayAdapter): number {
  try {
    const chainId = chain.chainIdentifier || 'monad-testnet'
    const fallbackCoinStr = defaultStaticStampForChain(chainId)
    const fallbackCoin = Number(fallbackCoinStr)
    const targetAvu = Number(DEFAULT_STAMP_TARGET_AVU)
    if (
      Number.isFinite(fallbackCoin) &&
      fallbackCoin > 0 &&
      Number.isFinite(targetAvu) &&
      targetAvu > 0
    ) {
      return targetAvu / fallbackCoin
    }
  } catch {
    // ignore
  }
  return 10 // 0.1 AVU per 0.01 MON = 10 AVU / MON
}

/**
 * Formats a stamp value in both native chain units (e.g. `0.05 MON` / `100 XPI`)
 * and AVU (e.g. `~5.00 AVU`), so the user can immediately evaluate the economic stake.
 */
export function formatScreenerStampValue(
  rawValue: bigint | number | string | null | undefined,
  optionsOrRate:
    | (Omit<FormatScreenerStampOptions, 'asset'> & { asset?: string })
    | number
    | undefined = {},
): FormattedScreenerStamp {
  const options: Omit<FormatScreenerStampOptions, 'asset'> & {
    asset?: string
  } =
    typeof optionsOrRate === 'number'
      ? { avuRate: optionsOrRate }
      : optionsOrRate ?? {}
  const valueWei = safeBigInt(rawValue)
  const chain: ChainDisplayAdapter = options.chain ?? activeChain
  const asset = (options.asset ?? 'monad') as SupportedAsset

  let nativeDisplay = `0 ${chain.unit}`
  let compactNativeDisplay = `0 ${chain.unit}`
  try {
    nativeDisplay = formatDisplayAmount(chain, valueWei)
    compactNativeDisplay = formatCompactAmount(chain, valueWei)
  } catch {
    nativeDisplay = `${valueWei.toString()} ${chain.unit}`
    compactNativeDisplay = nativeDisplay
  }

  const effectiveRate =
    options.avuRate !== undefined &&
    Number.isFinite(options.avuRate) &&
    options.avuRate > 0
      ? options.avuRate
      : inferImpliedAvuRate(chain)

  let avuValue = 0
  if (valueWei > 0n) {
    let converted: number | undefined
    // If custom chain adapter is passed, compute directly from its display amount first
    if (options.chain) {
      try {
        const displayNum = Number(chain.toDisplayAmount(valueWei))
        if (Number.isFinite(displayNum) && displayNum > 0) {
          converted = displayNum * effectiveRate
        }
      } catch {
        // fallback below
      }
    }
    if (converted === undefined) {
      try {
        converted = convertRawToAvu(valueWei, asset, effectiveRate)
      } catch {
        converted = undefined
      }
    }
    if (converted !== undefined && converted > 0) {
      avuValue = converted
    } else {
      try {
        const displayNum = Number(chain.toDisplayAmount(valueWei))
        if (Number.isFinite(displayNum) && displayNum > 0) {
          avuValue = displayNum * effectiveRate
        }
      } catch {
        avuValue = 0
      }
    }
  }

  let avuDisplay = '0 AVU'
  if (valueWei > 0n && avuValue > 0) {
    if (avuValue >= 0.01) {
      avuDisplay = `~${avuValue.toFixed(2)} AVU`
    } else {
      const formatted = formatAvu(avuValue)
      avuDisplay = formatted ? `~${formatted}` : '~0.00 AVU'
    }
  }
  const combinedDisplay =
    valueWei > 0n
      ? `${nativeDisplay} (${avuDisplay})`
      : `${nativeDisplay} (0 AVU)`

  return {
    valueWei,
    nativeDisplay,
    compactNativeDisplay,
    avuValue,
    avuDisplay,
    combinedDisplay,
    toString() {
      return combinedDisplay
    },
  }
}

/**
 * Summarizes the Paid-Stranger Screener queue: total waiting conversations, unread count,
 * and total verified stamp value formatted in native units + AVU.
 */
export function summarizeScreenerQueue(
  conversations: readonly Partial<Conversation>[],
  optionsOrFn:
    | (ScreenerTriageOptions & FormatScreenerStampOptions)
    | ((address: string) => boolean) = {},
  avuRateArg?: number,
): ScreenerQueueSummary {
  const triageOptions = normalizeTriageOptions(optionsOrFn)
  const formatOptions: FormatScreenerStampOptions =
    typeof optionsOrFn === 'object' && optionsOrFn !== null
      ? { ...optionsOrFn, avuRate: optionsOrFn.avuRate ?? avuRateArg }
      : { avuRate: avuRateArg }

  const ranked = rankScreenerConversations(conversations, triageOptions)
  let totalValueWei = 0n
  let unreadCount = 0

  for (const conv of ranked) {
    totalValueWei += getConversationStampValueWei(conv)
    const convUnread =
      (conv as any).unreadCount ?? conv.totalUnreadMessages ?? 0
    if (convUnread > 0) {
      unreadCount += 1
    }
  }

  const formattedTotal = formatScreenerStampValue(totalValueWei, formatOptions)

  return {
    count: ranked.length,
    unreadCount,
    totalValueWei,
    formattedTotal,
    conversations: ranked,
  }
}

function invokeSetScreenerStatus(
  chatStore: any,
  conversationId: string,
  status: ScreenerStatus,
) {
  if (!chatStore || typeof chatStore.setScreenerStatus !== 'function') return
  try {
    if (chatStore.setScreenerStatus.length >= 2) {
      chatStore.setScreenerStatus(conversationId, status)
    } else {
      chatStore.setScreenerStatus({ conversationId, status })
    }
  } catch {
    try {
      chatStore.setScreenerStatus(conversationId, status)
    } catch {
      // ignore
    }
  }
}

/**
 * Approves a Screener thread and adds its sender to the contact store.
 */
export function approveScreenerConversation(
  conversation: Conversation,
  storesOrChatStore: any = {},
  contactStoreArg?: any,
  ownAddressArg?: string | null,
): string {
  const isWrapperObject =
    storesOrChatStore &&
    typeof storesOrChatStore === 'object' &&
    ('chatStore' in storesOrChatStore || 'contactStore' in storesOrChatStore)
  const chatStore = isWrapperObject
    ? storesOrChatStore.chatStore
    : storesOrChatStore
  const contactStore = isWrapperObject
    ? storesOrChatStore.contactStore
    : contactStoreArg
  const ownAddress = isWrapperObject
    ? storesOrChatStore.ownAddress
    : ownAddressArg

  conversation.screenerStatus = 'approved'
  invokeSetScreenerStatus(chatStore, conversation.id, 'approved')

  const senderAddr =
    conversation.address && !conversation.verifiedGateway
      ? conversation.address
      : getScreenerSenderAddress(conversation, ownAddress)
  const contactAddr = senderAddr || conversation.address

  if (contactAddr && contactStore) {
    const alreadyContact = contactStore.isContact?.(contactAddr) ?? false
    if (!alreadyContact && !contactAddr.includes('@')) {
      if (typeof contactStore.addDefaultContact === 'function') {
        contactStore.addDefaultContact(contactAddr)
      } else if (typeof contactStore.addContact === 'function') {
        const displayName =
          conversation.name && !conversation.name.includes('@')
            ? conversation.name
            : null
        contactStore.addContact({
          address: contactAddr,
          contact: {
            lastUpdateTime: Date.now(),
            notify: true,
            relayURL: null,
            profile: {
              name: displayName,
              bio: null,
              avatar: null,
              pubKey: null,
            },
            inbox: {},
          },
        })
      }
    }
  }

  return contactAddr
}

/**
 * Dismisses a Screener thread and clears/archives its unread status while keeping all received stamp coins in the wallet.
 */
export async function dismissScreenerConversation(
  conversation: Conversation,
  storesOrChatStore: any = {},
): Promise<void> {
  const isWrapperObject =
    storesOrChatStore &&
    typeof storesOrChatStore === 'object' &&
    'chatStore' in storesOrChatStore
  const chatStore = isWrapperObject
    ? storesOrChatStore.chatStore
    : storesOrChatStore

  conversation.screenerStatus = 'dismissed'
  if ('unreadCount' in conversation) {
    ;(conversation as any).unreadCount = 0
  }
  if ('totalUnreadMessages' in conversation) {
    conversation.totalUnreadMessages = 0
  }
  conversation.totalUnreadValue = 0

  invokeSetScreenerStatus(chatStore, conversation.id, 'dismissed')

  if (typeof chatStore?.readAll === 'function') {
    await chatStore.readAll(conversation.id)
  }
  if (typeof chatStore?.deleteConversation === 'function') {
    await chatStore.deleteConversation(conversation.id)
  } else if (typeof chatStore?.clearConversation === 'function') {
    await chatStore.clearConversation(conversation.id)
  }
}
