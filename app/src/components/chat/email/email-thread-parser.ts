import type { Conversation, ChatMessage } from 'src/stores/chats'
import type { EmailItem, MessageItem } from '@frank/cashweb/types/messages'
import type { EmailParty, EmailAttachment } from '@frank/codec'
import { formatConversationTimestamp } from 'src/utils/formatting'
import { isChainAddress } from 'src/utils/chain-address'
import { cleanEmailSnippet } from 'src/utils/markdown-plain-text'
import { contentIdKey } from 'src/utils/markdown'

export const THREAD_REPLY_ALIAS_LOCAL_RE = /^m[0-9a-f]{30}$/i
export const GATEWAY_USERNAME_LOCAL_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i

export interface ParsedEmailCard {
  id: string
  payloadDigest?: string
  fromAddress: string
  fromName?: string
  to: EmailParty[]
  cc?: EmailParty[]
  bcc?: EmailParty[]
  subject: string
  textBody: string
  mainBody: string
  quotedBody: string
  snippet: string
  formattedDate: string
  timestamp: number
  isOutbound: boolean
  isUnread: boolean
  status?: ChatMessage['status']
  failureReason?: string
  attachments?: EmailAttachment[]
  rawEmail?: EmailItem
  isDkimVerified?: boolean
}

export interface EmailReply {
  conversationId: string
  items: MessageItem[]
  fallbackText: string
  targetAddress?: string
}

export function isValidRecipientAddress(
  addr: string | undefined | null,
): boolean {
  if (!addr) return false
  const trimmed = addr.trim()
  if (!trimmed) return false
  if (trimmed.length < 3 || trimmed.length > 320) return false
  if (trimmed.toLowerCase() === 'me') return false
  if (trimmed.includes('@')) return true
  if (isChainAddress(trimmed)) return true
  return false
}

export function extractPartyFromRaw(
  input: string | EmailParty | undefined | null,
): { address: string; name?: string } | null {
  if (!input) return null
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/)
    if (angleMatch) {
      const rawName = angleMatch[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim()
      const address = angleMatch[2].trim()
      if (!isValidRecipientAddress(address)) return null
      return {
        address,
        ...(rawName ? { name: rawName } : {}),
      }
    }
    if (!isValidRecipientAddress(trimmed)) return null
    return { address: trimmed }
  }
  const parsedFromAddr = extractPartyFromRaw(input.address)
  if (!parsedFromAddr) return null
  const explicitName = input.name?.trim()
  return {
    address: parsedFromAddr.address,
    ...(explicitName
      ? { name: explicitName }
      : parsedFromAddr.name
      ? { name: parsedFromAddr.name }
      : {}),
  }
}

export function decodeQuotedPrintableIfNeeded(text: string): string {
  if (!text) return ''
  const hasSoftLineBreak = /=\r?\n/.test(text)
  const hasUtf8QpSequence =
    /=[C-Fc-f][0-9A-Fa-f](?:=[89ABab][0-9A-Fa-f])+/.test(text)
  const hasCommonQpEscape = /=(?:3D|20(?=\r?\n|$)|09)/i.test(text)
  if (!hasSoftLineBreak && !hasUtf8QpSequence && !hasCommonQpEscape) {
    return text
  }

  const withoutSoftBreaks = text.replace(/=\r?\n/g, '')

  return withoutSoftBreaks.replace(/(?:=[0-9A-Fa-f]{2})+/g, match => {
    try {
      const hexParts = match.slice(1).split('=')
      const bytes = new Uint8Array(hexParts.map(h => parseInt(h, 16)))
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return match
    }
  })
}

export function splitQuotedEmailBody(text: string): {
  mainBody: string
  visibleBody: string
  quotedBody: string
} {
  if (!text) return { mainBody: '', visibleBody: '', quotedBody: '' }
  const decoded = decodeQuotedPrintableIfNeeded(text)
  const lines = decoded.split(/\r?\n/)
  let quoteStartIdx = -1

  // Look for a trailing block of `>` quoted lines (optionally preceded by `On ... wrote:`)
  let idx = lines.length - 1
  while (idx >= 0 && lines[idx].trim() === '') {
    idx--
  }

  let hasTrailingQuoteLines = false
  while (idx >= 0 && /^\s*>/.test(lines[idx])) {
    hasTrailingQuoteLines = true
    quoteStartIdx = idx
    idx--
  }

  if (hasTrailingQuoteLines) {
    // Check if the line(s) immediately preceding the `>` block (skipping blank lines) are an attribution header like `On ..., ... wrote:`
    let attrIdx = quoteStartIdx - 1
    while (attrIdx >= 0 && lines[attrIdx].trim() === '') {
      attrIdx--
    }
    if (attrIdx >= 0) {
      if (/^on\s+.+wrote:\s*$/i.test(lines[attrIdx].trim())) {
        quoteStartIdx = attrIdx
      } else if (/wrote:\s*$/i.test(lines[attrIdx].trim())) {
        for (
          let startIdx = attrIdx - 1;
          startIdx >= Math.max(0, attrIdx - 3);
          startIdx--
        ) {
          const joined = lines
            .slice(startIdx, attrIdx + 1)
            .map(l => l.trim())
            .join(' ')
          if (/^on\s+.+wrote:\s*$/i.test(joined)) {
            quoteStartIdx = startIdx
            break
          }
        }
      }
    }

    const mainBody = lines.slice(0, quoteStartIdx).join('\n').trim()
    const quotedBody = lines.slice(quoteStartIdx).join('\n').trim()
    if (mainBody.length > 0 && quotedBody.length > 0) {
      return { mainBody, visibleBody: mainBody, quotedBody }
    }
  }

  return { mainBody: decoded, visibleBody: decoded, quotedBody: '' }
}

export function getSenderInitials(nameOrAddress: string): string {
  if (!nameOrAddress) return '?'
  const clean = nameOrAddress.replace(/<[^>]+>/g, '').trim()
  const parts = clean.split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

export function formatEmailParties(parties: EmailParty[]): string {
  return parties
    .filter(p => isValidRecipientAddress(p.address))
    .map(p => (p.name ? `${p.name} <${p.address}>` : p.address))
    .join(', ')
}

export function formatAttachmentBytes(bytes: number | undefined): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function parseEmailCardsFromMessages(params: {
  messages: ChatMessage[]
  conversation: Conversation | null
  recipientAddress: string
  threadSubject: string
}): ParsedEmailCard[] {
  const { messages, conversation, recipientAddress, threadSubject } = params
  const cards: ParsedEmailCard[] = []
  const lastRead = conversation?.lastRead ?? 0
  const hasLastRead =
    conversation !== null &&
    conversation !== undefined &&
    conversation.lastRead !== undefined

  for (const msg of messages) {
    const emailItem = msg.items?.find(it => it.type === 'email') as
      | EmailItem
      | undefined
    const timestamp =
      msg.serverTime || msg.receivedTime || (msg as any).localTime || 0
    const formattedDate = formatConversationTimestamp(timestamp)
    const isUnread =
      !msg.outbound &&
      ((hasLastRead && timestamp > lastRead) ||
        (!hasLastRead && (conversation?.totalUnreadMessages ?? 0) > 0))

    if (emailItem) {
      const fromAddr = emailItem.from?.address || msg.senderAddress
      const fromName = emailItem.from?.name
      const text = decodeQuotedPrintableIfNeeded(emailItem.textBody || '')
      const { mainBody, quotedBody } = splitQuotedEmailBody(text)
      const snippetSource = mainBody || text
      const snippet = snippetSource.replace(/\s+/g, ' ').slice(0, 100)

      cards.push({
        id: emailItem.messageId || msg.payloadDigest,
        payloadDigest: msg.payloadDigest,
        fromAddress: fromAddr,
        fromName,
        to: emailItem.to || [],
        cc: emailItem.cc || [],
        subject: emailItem.subject || 'No Subject',
        textBody: text,
        mainBody,
        quotedBody,
        snippet,
        formattedDate,
        timestamp,
        isOutbound: msg.outbound,
        isUnread,
        status: msg.status,
        ...(msg.delivery?.failureReason || (msg as any).failureReason
          ? {
              failureReason:
                msg.delivery?.failureReason || (msg as any).failureReason,
            }
          : {}),
        attachments: emailItem.attachments,
        rawEmail: emailItem,
        isDkimVerified: Boolean(
          (emailItem as any).dkim || (emailItem as any).dkimVerified,
        ),
      })
    } else {
      const textItem = msg.items?.find(it => it.type === 'text') as
        | { text?: string }
        | undefined
      const text = textItem?.text || ''
      const cleanText = decodeQuotedPrintableIfNeeded(cleanEmailSnippet(text))
      const { mainBody, quotedBody } = splitQuotedEmailBody(cleanText)
      const snippetSource = mainBody || cleanText
      const snippet = snippetSource.replace(/\s+/g, ' ').slice(0, 100)

      cards.push({
        id: msg.payloadDigest,
        payloadDigest: msg.payloadDigest,
        fromAddress: msg.senderAddress,
        to: [{ address: msg.destinationAddress || recipientAddress }],
        subject: threadSubject,
        textBody: cleanText,
        mainBody,
        quotedBody,
        snippet,
        formattedDate,
        timestamp,
        isOutbound: msg.outbound,
        isUnread,
        status: msg.status,
        ...(msg.delivery?.failureReason || (msg as any).failureReason
          ? {
              failureReason:
                msg.delivery?.failureReason || (msg as any).failureReason,
            }
          : {}),
      })
    }
  }

  cards.sort((a, b) => a.timestamp - b.timestamp)
  return cards
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * The email's own pictures by Content-ID (without angle brackets), as `data:image` URIs, for its
 * HTML's `cid:` references. An email item carries its MIME parts as `attachments`, each with
 * the part's Content-ID (`contentId`, wire field 3) when it has one; only image parts are
 * pictures. (The mail gateway does not yet split inbound MIME into parts, so today such parts
 * come only from senders that fill `attachments` themselves.)
 */
export function emailContentIds(
  attachments: readonly EmailAttachment[] = [],
): Map<string, string> {
  const pictures = new Map<string, string>()
  for (const attachment of attachments) {
    const type = attachment.contentType?.trim().toLowerCase() ?? ''
    if (!attachment.contentId || !/^image\/[a-z0-9.+-]+$/.test(type)) continue
    const base64 = attachment.content?.length
      ? bytesToBase64(attachment.content)
      : attachment.dataBase64?.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    if (!base64) continue
    pictures.set(
      contentIdKey(attachment.contentId),
      `data:${type};base64,${base64}`,
    )
  }
  return pictures
}
