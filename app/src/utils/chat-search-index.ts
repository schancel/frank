import type { ChatMessage, Conversation } from '../stores/chats'
import type { ContactState } from '../stores/contacts'
import type { EmailItem, MessageItem } from '@frank/cashweb/types/messages'
import { cleanEmailSnippet, decodeHtmlEntities } from './markdown-plain-text'

export type MatchedSearchField =
  | 'subject'
  | 'body'
  | 'sender'
  | 'attachment'
  | 'contact'

export interface ParsedSearchQuery {
  raw: string
  terms: string[]
  phrases: string[]
  from: string[]
  subject: string[]
  inFilter: string[]
  hasAttachment?: boolean
  hasCalendar?: boolean
  isUnread?: boolean
  isEmail?: boolean
  isScreened?: boolean
  minStamp?: number
}

export interface SearchHighlightSpan {
  start: number
  end: number
  match: string
}

export interface SearchSnippet {
  text: string
  html: string
  highlights: SearchHighlightSpan[]
  matchedTerms: string[]
  toString(): string
}

export interface IndexedDocument {
  id: string
  kind: 'message' | 'conversation'
  conversationId: string
  messageId?: string
  payloadDigest?: string
  subject: string
  senderAddress: string
  senderName: string
  senderUsername: string
  contactText: string
  recipientAddresses: string[]
  bodyText: string
  attachmentNames: string[]
  timestamp: number
  isUnread: boolean
  isEmail: boolean
  isScreened: boolean
  isGroup: boolean
  hasAttachment: boolean
  hasCalendar: boolean
  stampValue: number
}

export interface SearchResult {
  id: string
  kind: 'message' | 'conversation'
  conversationId: string
  messageId?: string
  payloadDigest?: string
  score: number
  timestamp: number
  subject: string
  senderName: string
  senderUsername: string
  senderAddress: string
  snippet: SearchSnippet
  matchedFields: MatchedSearchField[]
  attachmentNames: string[]
  isUnread: boolean
  isEmail: boolean
  isScreened: boolean
}

export interface SearchIndexSnapshot {
  version: 1
  documents: IndexedDocument[]
}

export interface ContactLookupInfo {
  name?: string | null
  signedName?: string | null
  username?: string | null
  address?: string | null
}

export interface IndexContactOptions {
  getContact?: (
    address: string,
  ) => ContactState | ContactLookupInfo | null | undefined
  contacts?: Record<string, ContactState | ContactLookupInfo | undefined>
  isScreened?: (conversation: Partial<Conversation>) => boolean
  ownAddress?: string | null
}

export interface SearchOptions {
  limit?: number
  collapseByConversation?: boolean
  now?: number
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
])

/**
 * Normalizes text for search by decoding HTML entities, stripping diacritics, and lowercasing.
 */
export function normalizeSearchText(text: string): string {
  if (!text) return ''
  return decodeHtmlEntities(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/**
 * Tokenizes text into normalized lowercase search tokens.
 * Splits both on whitespace/punctuation and sub-tokens separated by `.`, `_`, `-`, `@`, `/`
 * so queries like `report`, `pdf`, `q4_report.pdf`, `alice`, or `example.com` all index and match.
 */
export function tokenizeSearchText(
  text: string,
  options?: { filterStopWords?: boolean },
): string[] {
  if (!text) return []
  const normalized = normalizeSearchText(text)
  const rawTokens = normalized
    .split(/[^a-z0-9@._+-]+/i)
    .map(t => t.replace(/^[._+-]+|[._+-]+$/g, ''))
    .filter(Boolean)

  const result = new Set<string>()
  for (const token of rawTokens) {
    if (options?.filterStopWords && STOP_WORDS.has(token)) {
      continue
    }
    result.add(token)
    if (token.startsWith('@') && token.length > 1) {
      const stripped = token.slice(1)
      if (!options?.filterStopWords || !STOP_WORDS.has(stripped)) {
        result.add(stripped)
      }
    }
    const subParts = token.split(/[@._+-]+/).filter(Boolean)
    if (subParts.length > 1) {
      for (const part of subParts) {
        if (!options?.filterStopWords || !STOP_WORDS.has(part)) {
          result.add(part)
        }
      }
    }
  }
  return Array.from(result)
}

/**
 * Parses a raw user search query into structured field filters (`from:`, `subject:`,
 * `has:attachment`, `is:unread`, `is:email`, `is:screened`, `min-stamp:`) and prefix terms.
 */
export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    raw: rawQuery ?? '',
    terms: [],
    phrases: [],
    from: [],
    subject: [],
    inFilter: [],
  }
  if (!rawQuery || !rawQuery.trim()) {
    return parsed
  }

  let working = rawQuery.trim()

  // Extract structured operator:value or operator:"quoted value"
  const operatorRegex =
    /\b(from|subject|in|has|is|min-stamp):(?:"([^"]+)"|'([^']+)'|(\S+))/gi
  working = working.replace(
    operatorRegex,
    (_full, rawOp: string, q1?: string, q2?: string, unquoted?: string) => {
      const op = rawOp.toLowerCase()
      const val = (q1 ?? q2 ?? unquoted ?? '').trim().toLowerCase()
      if (!val) return ' '

      switch (op) {
        case 'from':
          parsed.from.push(val)
          break
        case 'subject':
          parsed.subject.push(val)
          break
        case 'in':
          parsed.inFilter.push(val)
          if (
            val === 'screener' ||
            val === 'screened' ||
            val === 'stranger' ||
            val === 'tollbooth'
          ) {
            parsed.isScreened = true
          } else if (val === 'unread') {
            parsed.isUnread = true
          } else if (val === 'email' || val === 'emails') {
            parsed.isEmail = true
          }
          break
        case 'has':
          if (
            val === 'attachment' ||
            val === 'attachments' ||
            val === 'file' ||
            val === 'files'
          ) {
            parsed.hasAttachment = true
          } else if (val === 'calendar' || val === 'invite') {
            parsed.hasCalendar = true
          }
          break
        case 'is':
          if (val === 'unread') {
            parsed.isUnread = true
          } else if (val === 'read') {
            parsed.isUnread = false
          } else if (val === 'email' || val === 'mail') {
            parsed.isEmail = true
          } else if (
            val === 'screened' ||
            val === 'screener' ||
            val === 'stranger' ||
            val === 'tollbooth'
          ) {
            parsed.isScreened = true
          }
          break
        case 'min-stamp': {
          const num = Number(val)
          if (Number.isFinite(num) && num >= 0) {
            parsed.minStamp = num
          }
          break
        }
      }
      return ' '
    },
  )

  // Extract remaining quoted phrases
  const phraseRegex = /"([^"]+)"/g
  working = working.replace(phraseRegex, (_full, phrase: string) => {
    const clean = phrase.trim().toLowerCase()
    if (clean) {
      parsed.phrases.push(clean)
    }
    return ' '
  })

  // Extract remaining free-text tokens
  for (const token of tokenizeSearchText(working)) {
    if (!parsed.terms.includes(token)) {
      parsed.terms.push(token)
    }
  }

  return parsed
}

/**
 * Extracts a contextual snippet around the matched search terms with highlight spans and `<mark>` HTML.
 */
export function extractSearchSnippet(
  rawText: string,
  queryOrTerms: string | string[],
  phrasesOrMaxLength?: string[] | number,
  maxLengthArg = 120,
): SearchSnippet {
  const maxLength =
    typeof phrasesOrMaxLength === 'number' ? phrasesOrMaxLength : maxLengthArg
  const extraPhrases = Array.isArray(phrasesOrMaxLength)
    ? phrasesOrMaxLength
    : []

  const cleanText = cleanEmailSnippet(rawText || '')
    .replace(/\s+/g, ' ')
    .trim()

  const rawTerms =
    typeof queryOrTerms === 'string'
      ? (() => {
          const q = parseSearchQuery(queryOrTerms)
          return [...q.terms, ...q.subject, ...q.from, ...q.phrases]
        })()
      : [
          ...queryOrTerms.flatMap(t => tokenizeSearchText(t)),
          ...extraPhrases.flatMap(p => tokenizeSearchText(p)),
        ]

  const terms = Array.from(
    new Set(rawTerms.map(t => t.toLowerCase().trim()).filter(Boolean)),
  )

  if (!cleanText) {
    return {
      text: '',
      html: '',
      highlights: [],
      matchedTerms: [],
      toString() {
        return ''
      },
    }
  }

  const lowerText = cleanText.toLowerCase()
  const allMatches: Array<{ start: number; end: number; term: string }> = []
  const matchedTermsSet = new Set<string>()

  for (const term of terms) {
    if (!term) continue
    let searchFrom = 0
    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(term, searchFrom)
      if (idx === -1) break
      // Extend match to full word boundary if prefix match
      let end = idx + term.length
      while (end < cleanText.length && /[a-z0-9_]/i.test(cleanText[end])) {
        end++
      }
      allMatches.push({ start: idx, end, term })
      matchedTermsSet.add(term)
      searchFrom = idx + term.length
    }
  }

  allMatches.sort((a, b) => a.start - b.start || b.end - a.end)

  // Determine window [winStart, winEnd]
  let winStart = 0
  let winEnd = Math.min(cleanText.length, maxLength)

  if (allMatches.length > 0 && cleanText.length > maxLength) {
    const firstMatch = allMatches[0]
    const matchCenter = Math.floor((firstMatch.start + firstMatch.end) / 2)
    const halfWindow = Math.floor(maxLength / 2)
    winStart = Math.max(0, matchCenter - halfWindow)
    winEnd = Math.min(cleanText.length, winStart + maxLength)
    if (winEnd - winStart < maxLength) {
      winStart = Math.max(0, winEnd - maxLength)
    }

    // Snap window boundaries to word boundaries where possible
    if (winStart > 0) {
      const nextSpace = cleanText.indexOf(' ', winStart)
      if (nextSpace !== -1 && nextSpace - winStart <= 12) {
        winStart = nextSpace + 1
      }
    }
    if (winEnd < cleanText.length) {
      const prevSpace = cleanText.lastIndexOf(' ', winEnd)
      if (prevSpace !== -1 && winEnd - prevSpace <= 12 && prevSpace > winStart) {
        winEnd = prevSpace
      }
    }
  }

  const prefixEllipsis = winStart > 0 ? '…' : ''
  const suffixEllipsis = winEnd < cleanText.length ? '…' : ''
  const sliceText = cleanText.slice(winStart, winEnd)
  const finalText = `${prefixEllipsis}${sliceText}${suffixEllipsis}`
  const offsetShift = prefixEllipsis.length - winStart

  // Merge overlapping highlight spans within the window
  const windowSpans: SearchHighlightSpan[] = []
  for (const m of allMatches) {
    if (m.end <= winStart || m.start >= winEnd) continue
    const clampedStart = Math.max(winStart, m.start) + offsetShift
    const clampedEnd = Math.min(winEnd, m.end) + offsetShift
    if (clampedEnd <= clampedStart) continue

    const prev = windowSpans[windowSpans.length - 1]
    if (prev && clampedStart <= prev.end) {
      prev.end = Math.max(prev.end, clampedEnd)
      prev.match = finalText.slice(prev.start, prev.end)
    } else {
      windowSpans.push({
        start: clampedStart,
        end: clampedEnd,
        match: finalText.slice(clampedStart, clampedEnd),
      })
    }
  }

  // Build HTML with <mark> tags
  let html = ''
  let cursor = 0
  for (const span of windowSpans) {
    if (span.start > cursor) {
      html += escapeHtml(finalText.slice(cursor, span.start))
    }
    html += `<mark>${escapeHtml(finalText.slice(span.start, span.end))}</mark>`
    cursor = span.end
  }
  if (cursor < finalText.length) {
    html += escapeHtml(finalText.slice(cursor))
  }

  const matchedTerms = Array.from(matchedTermsSet)
  return {
    text: finalText,
    html,
    highlights: windowSpans,
    matchedTerms,
    toString() {
      return finalText
    },
  }
}

function resolveContactInfo(
  address: string | undefined,
  options?: IndexContactOptions,
): ContactLookupInfo {
  if (!address) return {}
  if (options?.getContact) {
    try {
      const c = options.getContact(address)
      if (c) {
        if ('profile' in c && c.profile) {
          return {
            name: c.profile.name,
            signedName: c.profile.signedName,
            username: c.profile.username,
            address,
          }
        }
        return c as ContactLookupInfo
      }
    } catch {
      // ignore
    }
  }
  if (options?.contacts && address in options.contacts) {
    const c = options.contacts[address]
    if (c) {
      if ('profile' in c && c.profile) {
        return {
          name: c.profile.name,
          signedName: c.profile.signedName,
          username: c.profile.username,
          address,
        }
      }
      return c as ContactLookupInfo
    }
  }
  return { address }
}

function toTimestampMs(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (val instanceof Date) return val.getTime()
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function getConversationSubject(conversation: Partial<Conversation>): string {
  const anyConv = conversation as Record<string, any>
  return (
    conversation.name ||
    anyConv.subject ||
    conversation.nameOnWire ||
    conversation.topic ||
    ''
  )
}

function getConversationUnreadCount(
  conversation: Partial<Conversation>,
): number {
  const anyConv = conversation as Record<string, any>
  return conversation.totalUnreadMessages ?? anyConv.unreadCount ?? 0
}

function extractMessageFields(
  conversation: Partial<Conversation>,
  message: Partial<ChatMessage>,
  options?: IndexContactOptions,
): {
  subject: string
  senderAddress: string
  senderName: string
  senderUsername: string
  contactText: string
  recipientAddresses: string[]
  bodyText: string
  attachmentNames: string[]
  isEmail: boolean
  hasAttachment: boolean
  hasCalendar: boolean
  stampValue: number
} {
  const items: MessageItem[] = Array.isArray(message.items) ? message.items : []
  const bodyParts: string[] = []
  const attachmentNames: string[] = []
  const recipientAddresses = new Set<string>()
  let subject = getConversationSubject(conversation)
  let senderAddress = message.senderAddress || conversation.address || ''
  let senderName = ''
  let senderUsername = ''
  let isEmail = conversation.kind === 'email'
  let hasAttachment = false
  let hasCalendar = false

  if (conversation.emailRecipient) {
    recipientAddresses.add(conversation.emailRecipient)
  }
  if (message.destinationAddress) {
    recipientAddresses.add(message.destinationAddress)
  }
  for (const p of conversation.participants || []) {
    if (p) recipientAddresses.add(p)
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const anyItem = item as Record<string, any>
    if (item.type === 'email') {
      isEmail = true
      const email = item as EmailItem
      if (email.subject && email.subject !== 'No Subject') {
        subject = email.subject
      }
      if (email.from?.address) {
        senderAddress = email.from.address
      }
      if (email.from?.name) {
        senderName = email.from.name
      }
      const rawBody =
        email.textBody || (anyItem.bodyText as string) || (anyItem.body as string) || ''
      if (rawBody) {
        bodyParts.push(cleanEmailSnippet(rawBody))
      }
      for (const party of email.to || []) {
        if (party.address) recipientAddresses.add(party.address)
        if (party.name) recipientAddresses.add(party.name)
      }
      for (const party of email.cc || []) {
        if (party.address) recipientAddresses.add(party.address)
        if (party.name) recipientAddresses.add(party.name)
      }
      if (Array.isArray(email.attachments) && email.attachments.length > 0) {
        hasAttachment = true
        for (const att of email.attachments) {
          if (att?.filename) attachmentNames.push(att.filename)
        }
      }
    } else if (item.type === 'text') {
      const text = (anyItem.text as string) || ''
      const cleaned = cleanEmailSnippet(text)
      if (cleaned) bodyParts.push(cleaned)
    } else if (anyItem.type === 'article') {
      if (anyItem.title) {
        subject = subject || String(anyItem.title)
        bodyParts.push(String(anyItem.title))
      }
      if (anyItem.bodyMarkdown || anyItem.text) {
        bodyParts.push(String(anyItem.bodyMarkdown || anyItem.text))
      }
    } else if (
      anyItem.type === 'calendar' ||
      anyItem.type === 'calendar-invite' ||
      anyItem.type === 'calendar_event'
    ) {
      hasCalendar = true
      if (anyItem.title) bodyParts.push(String(anyItem.title))
      if (anyItem.summary) bodyParts.push(String(anyItem.summary))
      if (anyItem.description) bodyParts.push(String(anyItem.description))
    } else if (
      anyItem.type === 'image' ||
      anyItem.type === 'attachment' ||
      anyItem.type === 'blob'
    ) {
      hasAttachment = true
      const filename =
        anyItem.filename ||
        anyItem.blobManifest?.filename ||
        anyItem.name ||
        (anyItem.type === 'image' ? 'image' : '')
      if (filename) attachmentNames.push(String(filename))
    }

    if (anyItem.blobManifest?.filename) {
      hasAttachment = true
      if (!attachmentNames.includes(anyItem.blobManifest.filename)) {
        attachmentNames.push(String(anyItem.blobManifest.filename))
      }
    }
  }

  // Contact resolution for sender and conversation peer
  const senderContact = resolveContactInfo(
    message.senderAddress || conversation.address,
    options,
  )
  const peerContact = resolveContactInfo(conversation.address, options)
  if (!senderName) {
    senderName =
      (senderContact.name && senderContact.name !== 'Loading...'
        ? senderContact.name
        : '') ||
      senderContact.signedName ||
      (peerContact.name && peerContact.name !== 'Loading...'
        ? peerContact.name
        : '') ||
      ''
  }
  senderUsername = senderContact.username || peerContact.username || ''

  const contactParts = [
    senderName,
    senderContact.signedName,
    senderUsername,
    peerContact.name !== 'Loading...' ? peerContact.name : '',
    peerContact.signedName,
    peerContact.username,
    conversation.address,
    conversation.emailRecipient,
    message.senderAddress,
    senderAddress,
  ]
    .filter(Boolean)
    .join(' ')

  let stampValue = 0
  if (typeof message.stampValueWei === 'bigint') {
    stampValue = Number(message.stampValueWei)
  } else if (typeof (message as any).stampValue === 'number') {
    stampValue = (message as any).stampValue
  } else if (typeof (message as any).totalValue === 'number') {
    stampValue = (message as any).totalValue
  } else if (Array.isArray(message.outpoints) && message.outpoints.length > 0) {
    stampValue = message.outpoints.reduce(
      (sum, u: any) => sum + Number(u?.amount ?? u?.value ?? u?.satoshis ?? 0),
      0,
    )
  }

  return {
    subject,
    senderAddress,
    senderName,
    senderUsername,
    contactText: contactParts,
    recipientAddresses: Array.from(recipientAddresses),
    bodyText: Array.from(new Set(bodyParts)).join('\n').trim(),
    attachmentNames,
    isEmail,
    hasAttachment,
    hasCalendar,
    stampValue,
  }
}

interface FieldTokenPostings {
  subject: Set<string>
  body: Set<string>
  sender: Set<string>
  attachment: Set<string>
  contact: Set<string>
}

/**
 * Fast, zero-dependency in-memory/persistent inverted full-text search index
 * over decrypted E2EE conversations, messages, subjects, contacts, and attachments.
 */
export class ChatSearchIndex {
  private documents = new Map<string, IndexedDocument>()
  private conversationDocs = new Map<string, Set<string>>()
  private invertedIndex = new Map<string, Set<string>>()
  private docFieldTokens = new Map<string, FieldTokenPostings>()

  static fromSnapshot(
    snapshot: SearchIndexSnapshot | null | undefined,
  ): ChatSearchIndex {
    const index = new ChatSearchIndex()
    index.restore(snapshot)
    return index
  }

  get size(): number {
    return this.documents.size
  }

  clear(): void {
    this.documents.clear()
    this.conversationDocs.clear()
    this.invertedIndex.clear()
    this.docFieldTokens.clear()
  }

  private addDocumentInternal(doc: IndexedDocument): void {
    if (this.documents.has(doc.id)) {
      this.removeDocumentById(doc.id)
    }
    this.documents.set(doc.id, doc)

    let convSet = this.conversationDocs.get(doc.conversationId)
    if (!convSet) {
      convSet = new Set<string>()
      this.conversationDocs.set(doc.conversationId, convSet)
    }
    convSet.add(doc.id)

    const subjectTokens = new Set(tokenizeSearchText(doc.subject))
    const bodyTokens = new Set(tokenizeSearchText(doc.bodyText))
    const senderTokens = new Set(
      tokenizeSearchText(
        `${doc.senderName} ${doc.senderUsername} ${doc.senderAddress}`,
      ),
    )
    const attachmentTokens = new Set(
      tokenizeSearchText(doc.attachmentNames.join(' ')),
    )
    const contactTokens = new Set(
      tokenizeSearchText(
        `${doc.contactText} ${doc.recipientAddresses.join(' ')}`,
      ),
    )

    this.docFieldTokens.set(doc.id, {
      subject: subjectTokens,
      body: bodyTokens,
      sender: senderTokens,
      attachment: attachmentTokens,
      contact: contactTokens,
    })

    const allTokens = new Set<string>([
      ...subjectTokens,
      ...bodyTokens,
      ...senderTokens,
      ...attachmentTokens,
      ...contactTokens,
    ])

    for (const token of allTokens) {
      let postings = this.invertedIndex.get(token)
      if (!postings) {
        postings = new Set<string>()
        this.invertedIndex.set(token, postings)
      }
      postings.add(doc.id)
    }
  }

  private removeDocumentById(docId: string): void {
    const existing = this.documents.get(docId)
    if (!existing) return
    this.documents.delete(docId)

    const convSet = this.conversationDocs.get(existing.conversationId)
    if (convSet) {
      convSet.delete(docId)
      if (convSet.size === 0) {
        this.conversationDocs.delete(existing.conversationId)
      }
    }

    const fields = this.docFieldTokens.get(docId)
    if (fields) {
      const allTokens = new Set<string>([
        ...fields.subject,
        ...fields.body,
        ...fields.sender,
        ...fields.attachment,
        ...fields.contact,
      ])
      for (const token of allTokens) {
        const postings = this.invertedIndex.get(token)
        if (postings) {
          postings.delete(docId)
          if (postings.size === 0) {
            this.invertedIndex.delete(token)
          }
        }
      }
      this.docFieldTokens.delete(docId)
    }
  }

  /**
   * Indexes or updates a single message within a conversation.
   */
  indexMessage(
    conversation: Partial<Conversation>,
    message: Partial<ChatMessage>,
    options?: IndexContactOptions,
  ): void {
    const conversationId =
      conversation.id || conversation.address || message.conversationId || ''
    if (!conversationId) return

    const anyMsg = message as Record<string, any>
    const rawTs =
      anyMsg.timestamp ??
      message.serverTime ??
      message.receivedTime ??
      anyMsg.firstSeen ??
      0
    const timestamp = toTimestampMs(rawTs)

    const messageKey =
      message.logicalMessageId ||
      message.payloadDigest ||
      message.messageHash ||
      anyMsg.id ||
      `${timestamp}`
    const docId = `msg:${conversationId}:${messageKey}`

    const extracted = extractMessageFields(conversation, message, options)
    const lastRead = conversation.lastRead ?? 0
    const convUnreadCount = getConversationUnreadCount(conversation)
    const hasExplicitUnreadCount =
      conversation.totalUnreadMessages !== undefined ||
      (conversation as any).unreadCount !== undefined
    const isUnread =
      !message.outbound &&
      (hasExplicitUnreadCount
        ? convUnreadCount > 0 && (lastRead === 0 || timestamp > lastRead)
        : lastRead > 0 && timestamp > lastRead)
    const isScreened = options?.isScreened
      ? options.isScreened(conversation)
      : conversation.screenerStatus === 'pending'

    const doc: IndexedDocument = {
      id: docId,
      kind: 'message',
      conversationId,
      messageId: message.logicalMessageId || message.payloadDigest || anyMsg.id,
      payloadDigest: message.payloadDigest,
      subject: extracted.subject,
      senderAddress: extracted.senderAddress,
      senderName: extracted.senderName,
      senderUsername: extracted.senderUsername,
      contactText: extracted.contactText,
      recipientAddresses: extracted.recipientAddresses,
      bodyText: extracted.bodyText,
      attachmentNames: extracted.attachmentNames,
      timestamp,
      isUnread,
      isEmail: extracted.isEmail,
      isScreened,
      isGroup:
        conversation.kind === 'group' ||
        (conversation.participants?.length ?? 0) > 2,
      hasAttachment: extracted.hasAttachment,
      hasCalendar: extracted.hasCalendar,
      stampValue: extracted.stampValue || (conversation.totalValue ?? 0),
    }

    this.addDocumentInternal(doc)
  }

  /**
   * Alias for `indexMessage` for incremental message indexing.
   */
  addMessage(
    conversation: Partial<Conversation>,
    message: Partial<ChatMessage>,
    options?: IndexContactOptions,
  ): void {
    this.indexMessage(conversation, message, options)
  }

  /**
   * Indexes a conversation's metadata (subject, contact names/usernames/addresses)
   * and all of its non-deleted messages.
   */
  indexConversation(
    conversation: Partial<Conversation>,
    options?: IndexContactOptions,
  ): void {
    const conversationId = conversation.id || conversation.address || ''
    if (!conversationId) return

    if (conversation.deletedAt) {
      this.removeConversation(conversationId)
      return
    }

    this.removeConversation(conversationId)

    const peerAddress =
      conversation.address || conversation.participants?.[0] || ''
    const contactInfo = resolveContactInfo(peerAddress, options)
    const senderName =
      (contactInfo.name && contactInfo.name !== 'Loading...'
        ? contactInfo.name
        : '') ||
      contactInfo.signedName ||
      ''
    const senderUsername = contactInfo.username || ''
    const subject = getConversationSubject(conversation)
    const isScreened = options?.isScreened
      ? options.isScreened(conversation)
      : conversation.screenerStatus === 'pending'

    const messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : []

    const allAttachmentNames: string[] = []
    let hasCalendar = false
    let isEmail = conversation.kind === 'email'
    const bodySnippets: string[] = []
    let maxMsgStamp = 0

    for (const msg of messages) {
      this.indexMessage(conversation, msg, options)
      const extracted = extractMessageFields(conversation, msg, options)
      if (extracted.isEmail) isEmail = true
      if (extracted.hasCalendar) hasCalendar = true
      if (extracted.stampValue > maxMsgStamp) {
        maxMsgStamp = extracted.stampValue
      }
      for (const att of extracted.attachmentNames) {
        if (!allAttachmentNames.includes(att)) allAttachmentNames.push(att)
      }
      if (extracted.bodyText) {
        bodySnippets.push(extracted.bodyText)
      }
    }

    const participantContacts = (conversation.participants || [])
      .map(p => {
        const info = resolveContactInfo(p, options)
        return [
          p,
          info.name !== 'Loading...' ? info.name : '',
          info.signedName,
          info.username,
        ]
          .filter(Boolean)
          .join(' ')
      })
      .join(' ')

    const anyConv = conversation as Record<string, any>
    const convDoc: IndexedDocument = {
      id: `conv:${conversationId}`,
      kind: 'conversation',
      conversationId,
      subject,
      senderAddress: peerAddress || conversation.emailRecipient || '',
      senderName,
      senderUsername,
      contactText: [
        senderName,
        contactInfo.signedName,
        senderUsername,
        peerAddress,
        conversation.emailRecipient,
        participantContacts,
      ]
        .filter(Boolean)
        .join(' '),
      recipientAddresses: [
        ...(conversation.participants || []),
        ...(conversation.emailRecipient ? [conversation.emailRecipient] : []),
      ],
      bodyText:
        bodySnippets.length > 0
          ? bodySnippets[bodySnippets.length - 1]
          : subject,
      attachmentNames: allAttachmentNames,
      timestamp: toTimestampMs(
        anyConv.lastActivityAt ||
          conversation.lastReceived ||
          conversation.updatedAt ||
          conversation.createdAt ||
          0,
      ),
      isUnread: getConversationUnreadCount(conversation) > 0,
      isEmail,
      isScreened,
      isGroup:
        conversation.kind === 'group' ||
        (conversation.participants?.length ?? 0) > 2,
      hasAttachment: allAttachmentNames.length > 0,
      hasCalendar,
      stampValue: Math.max(conversation.totalValue ?? 0, maxMsgStamp),
    }

    this.addDocumentInternal(convDoc)
  }

  /**
   * Bulk indexes a collection of conversations.
   */
  indexConversations(
    conversations: Iterable<Partial<Conversation>>,
    options?: IndexContactOptions,
  ): void {
    for (const conv of conversations) {
      if (conv) {
        this.indexConversation(conv, options)
      }
    }
  }

  /**
   * Alias for `indexConversations` to bulk-index all conversations and messages.
   */
  indexAll(
    conversations: Iterable<Partial<Conversation>>,
    options?: IndexContactOptions,
  ): void {
    this.indexConversations(conversations, options)
  }

  /**
   * Removes all indexed documents belonging to a conversation.
   */
  removeConversation(conversationId: string): void {
    const docIds = this.conversationDocs.get(conversationId)
    if (!docIds) return
    for (const docId of Array.from(docIds)) {
      this.removeDocumentById(docId)
    }
  }

  /**
   * Removes a single message from the index by its logicalMessageId or payloadDigest.
   */
  removeMessage(conversationId: string, messageIdOrDigest: string): void {
    const docIds = this.conversationDocs.get(conversationId)
    if (!docIds) return
    for (const docId of Array.from(docIds)) {
      const doc = this.documents.get(docId)
      if (
        doc &&
        doc.kind === 'message' &&
        (doc.messageId === messageIdOrDigest ||
          doc.payloadDigest === messageIdOrDigest ||
          doc.id === `msg:${conversationId}:${messageIdOrDigest}`)
      ) {
        this.removeDocumentById(docId)
      }
    }
    // Refresh the conversation summary document's bodyText from remaining messages
    const convDocId = `conv:${conversationId}`
    const convDoc = this.documents.get(convDocId)
    if (convDoc) {
      const remainingDocIds = this.conversationDocs.get(conversationId)
      let latestBody = convDoc.subject
      if (remainingDocIds) {
        for (const remId of remainingDocIds) {
          if (remId === convDocId) continue
          const remDoc = this.documents.get(remId)
          if (remDoc?.bodyText) {
            latestBody = remDoc.bodyText
          }
        }
      }
      this.addDocumentInternal({
        ...convDoc,
        bodyText: latestBody,
      })
    }
  }

  /**
   * Serializes the index into a compact JSON snapshot for persistence.
   */
  serialize(): SearchIndexSnapshot {
    return {
      version: 1,
      documents: Array.from(this.documents.values()),
    }
  }

  /**
   * Restores the inverted index from a serialized snapshot.
   */
  restore(snapshot: SearchIndexSnapshot | null | undefined): void {
    this.clear()
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.documents))
      return
    for (const doc of snapshot.documents) {
      this.addDocumentInternal(doc)
    }
  }

  /**
   * Finds all document IDs matching a token or prefix.
   */
  private findDocsForTerm(term: string): Set<string> {
    const matchedDocs = new Set<string>()
    const exact = this.invertedIndex.get(term)
    if (exact) {
      for (const id of exact) matchedDocs.add(id)
    }
    for (const [indexedToken, docIds] of this.invertedIndex.entries()) {
      if (indexedToken !== term && indexedToken.startsWith(term)) {
        for (const id of docIds) matchedDocs.add(id)
      }
    }
    return matchedDocs
  }

  /**
   * Executes a multi-token prefix and field-filtered search across all indexed documents.
   * Designed to complete in < 10 ms on thousands of local decrypted messages.
   */
  search(rawQuery: string, options: SearchOptions = {}): SearchResult[] {
    const parsed = parseSearchQuery(rawQuery)
    const hasStructuredFilters =
      parsed.from.length > 0 ||
      parsed.subject.length > 0 ||
      parsed.inFilter.length > 0 ||
      parsed.hasAttachment !== undefined ||
      parsed.hasCalendar !== undefined ||
      parsed.isUnread !== undefined ||
      parsed.isEmail !== undefined ||
      parsed.isScreened !== undefined ||
      parsed.minStamp !== undefined

    if (
      parsed.terms.length === 0 &&
      parsed.phrases.length === 0 &&
      !hasStructuredFilters
    ) {
      return []
    }

    // Intersect candidate sets across query terms using the inverted index
    let candidateIds: Set<string> | null = null
    for (const term of parsed.terms) {
      const termDocs = this.findDocsForTerm(term)
      if (candidateIds === null) {
        candidateIds = termDocs
      } else {
        const next = new Set<string>()
        for (const id of candidateIds) {
          if (termDocs.has(id)) next.add(id)
        }
        candidateIds = next
      }
      if (candidateIds.size === 0) return []
    }

    const pool: Iterable<string> =
      candidateIds !== null ? candidateIds : this.documents.keys()

    const now = options.now ?? Date.now()
    const results: SearchResult[] = []

    for (const docId of pool) {
      const doc = this.documents.get(docId)
      if (!doc) continue

      // Structured filter checks
      if (parsed.hasAttachment !== undefined) {
        if (doc.hasAttachment !== parsed.hasAttachment) continue
      }
      if (parsed.hasCalendar !== undefined) {
        if (doc.hasCalendar !== parsed.hasCalendar) continue
      }
      if (parsed.isUnread !== undefined) {
        if (doc.isUnread !== parsed.isUnread) continue
      }
      if (parsed.isEmail !== undefined) {
        if (doc.isEmail !== parsed.isEmail) continue
      }
      if (parsed.isScreened !== undefined) {
        if (doc.isScreened !== parsed.isScreened) continue
      }
      if (parsed.minStamp !== undefined) {
        if (doc.stampValue < parsed.minStamp) continue
      }

      if (parsed.inFilter.length > 0) {
        const inMatched = parsed.inFilter.every(f => {
          if (f === 'group' || f === 'groups') return doc.isGroup
          if (f === 'email' || f === 'emails') return doc.isEmail
          if (f === 'screener' || f === 'screened') return doc.isScreened
          return (
            doc.conversationId.toLowerCase().includes(f) ||
            doc.subject.toLowerCase().includes(f)
          )
        })
        if (!inMatched) continue
      }

      if (parsed.from.length > 0) {
        const senderHaystack =
          `${doc.senderName} ${doc.senderUsername} ${doc.senderAddress} ${doc.contactText}`.toLowerCase()
        const fromMatched = parsed.from.every(f =>
          senderHaystack.includes(f.replace(/^@/, '')),
        )
        if (!fromMatched) continue
      }

      if (parsed.subject.length > 0) {
        const subjectHaystack = doc.subject.toLowerCase()
        const subjMatched = parsed.subject.every(s =>
          subjectHaystack.includes(s),
        )
        if (!subjMatched) continue
      }

      if (parsed.phrases.length > 0) {
        const fullHaystack =
          `${doc.subject} ${doc.bodyText} ${doc.senderName} ${doc.attachmentNames.join(' ')}`.toLowerCase()
        const phrasesMatched = parsed.phrases.every(p =>
          fullHaystack.includes(p),
        )
        if (!phrasesMatched) continue
      }

      // Compute relevance score: match quality + field weight + recency
      const fields = this.docFieldTokens.get(docId)
      const matchedFields = new Set<MatchedSearchField>()
      let score = 0

      if (parsed.from.length > 0) {
        matchedFields.add('sender')
        score += 25
      }
      if (parsed.subject.length > 0) {
        matchedFields.add('subject')
        score += 30
      }

      for (const term of parsed.terms) {
        if (!fields) continue
        const checkSet = (
          tokenSet: Set<string>,
          field: MatchedSearchField,
          exactWeight: number,
          prefixWeight: number,
        ) => {
          if (tokenSet.has(term)) {
            matchedFields.add(field)
            score += exactWeight
          } else {
            for (const tok of tokenSet) {
              if (tok.startsWith(term)) {
                matchedFields.add(field)
                score += prefixWeight
                break
              }
            }
          }
        }

        checkSet(fields.subject, 'subject', 40, 25)
        checkSet(fields.sender, 'sender', 35, 22)
        checkSet(fields.contact, 'contact', 30, 18)
        checkSet(fields.attachment, 'attachment', 30, 20)
        checkSet(fields.body, 'body', 20, 12)
      }

      // Phrase match bonus
      if (parsed.phrases.length > 0) {
        score += 25 * parsed.phrases.length
      }

      // Unread / email / attachment filter base score if query only had filters
      if (score === 0 && hasStructuredFilters) {
        score = 10
      }

      // Prefer specific message matches over synthetic conversation summary docs
      if (doc.kind === 'message') {
        score += 8
      }

      // Recency boost (0 to 15 points based on age)
      if (doc.timestamp > 0) {
        const ageHours = Math.max(0, (now - doc.timestamp) / (1000 * 3600))
        const recencyBoost = 15 / (1 + ageHours / 24)
        score += recencyBoost
      }

      const snippetSource =
        doc.bodyText ||
        doc.subject ||
        doc.attachmentNames.join(', ') ||
        doc.senderName ||
        doc.senderAddress
      const snippetTerms = [
        ...parsed.terms,
        ...parsed.subject,
        ...parsed.from,
      ]
      const snippet = extractSearchSnippet(snippetSource, snippetTerms)

      results.push({
        id: doc.id,
        kind: doc.kind,
        conversationId: doc.conversationId,
        messageId: doc.messageId,
        payloadDigest: doc.payloadDigest,
        score,
        timestamp: doc.timestamp,
        subject: doc.subject,
        senderName: doc.senderName,
        senderUsername: doc.senderUsername,
        senderAddress: doc.senderAddress,
        snippet,
        matchedFields: Array.from(matchedFields),
        attachmentNames: doc.attachmentNames,
        isUnread: doc.isUnread,
        isEmail: doc.isEmail,
        isScreened: doc.isScreened,
      })
    }

    // Sort by score descending, then timestamp descending
    results.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)

    const shouldCollapse = options.collapseByConversation ?? true
    if (shouldCollapse) {
      const seenConversations = new Set<string>()
      const collapsed: SearchResult[] = []
      for (const r of results) {
        if (seenConversations.has(r.conversationId)) continue
        seenConversations.add(r.conversationId)
        collapsed.push(r)
      }
      return options.limit ? collapsed.slice(0, options.limit) : collapsed
    }

    return options.limit ? results.slice(0, options.limit) : results
  }

  /**
   * Convenience helper returning one top-ranked result per conversation.
   */
  searchConversations(
    rawQuery: string,
    options: Omit<SearchOptions, 'collapseByConversation'> = {},
  ): SearchResult[] {
    return this.search(rawQuery, { ...options, collapseByConversation: true })
  }
}

/**
 * Stateless helper to build an index and search across a list of conversations and contacts.
 */
export function searchConversationsAndMessages(
  conversations: readonly Partial<Conversation>[],
  rawQuery: string,
  options?: IndexContactOptions & SearchOptions,
): SearchResult[] {
  const index = new ChatSearchIndex()
  index.indexConversations(conversations, options)
  return index.search(rawQuery, options)
}
