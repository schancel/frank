import {
  ChatSearchIndex,
  extractSearchSnippet,
  normalizeSearchText,
  parseSearchQuery,
  searchConversationsAndMessages,
  tokenizeSearchText,
} from './chat-search-index'
import type { ChatMessage, Conversation } from '../stores/chats'

function createMockMessage(
  overrides: Partial<ChatMessage> & {
    id?: string
    body?: string
    subject?: string
  } = {},
): ChatMessage {
  const id = overrides.id ?? overrides.payloadDigest ?? 'msg-1'
  return {
    outbound: false,
    status: 'confirmed',
    items: overrides.items ?? [
      {
        type: 'text',
        text: overrides.body ?? 'Hello from decentralized chat',
      },
    ],
     firstSeen: overrides.firstSeen ?? new Date('2026-03-01T12:00:00Z'),
    serverTime: overrides.serverTime ?? new Date('2026-03-01T12:00:00Z'),
    timestamp: overrides.timestamp ?? new Date('2026-03-01T12:00:00Z'),
    payloadDigest: id,
    senderAddress: overrides.senderAddress ?? 'lotus_16PSJ2estranger111111111111111111111111',
    totalValue: overrides.totalValue ?? 0,
    ...overrides,
  }
}

function createMockConversation(
  overrides: Partial<Conversation> = {},
): Conversation {
  const id = overrides.id ?? overrides.address ?? 'conv-1'
  return {
    id,
    kind: overrides.kind ?? 'direct',
    address: overrides.address ?? id,
    messages: overrides.messages ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    totalValue: overrides.totalValue ?? 0,
    totalUnreadValue: overrides.totalUnreadValue ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    lastMessageId: null,
    active: false,
    ...overrides,
  }
}

describe('chat-search-index', () => {
  describe('normalizeSearchText and tokenizeSearchText', () => {
    it('normalizes case, strips diacritics, and splits on punctuation', () => {
      expect(normalizeSearchText('Café Résumé — Naïve!')).toBe(
        'cafe resume — naive!',
      )
      expect(tokenizeSearchText('Café Résumé — Naïve! 2026')).toEqual([
        'cafe',
        'resume',
        'naive',
        '2026',
      ])
    })

    it('filters common English stop words when filterStopWords is enabled', () => {
      const tokens = tokenizeSearchText(
        'The quick brown fox is in the garden with an invoice',
        { filterStopWords: true },
      )
      expect(tokens).toEqual(['quick', 'brown', 'fox', 'garden', 'invoice'])
    })
  })

  describe('parseSearchQuery', () => {
    it('extracts structured operators, phrases, and free-text terms', () => {
      const parsed = parseSearchQuery(
        'from:alice@example.com subject:proposal "quarterly report" has:attachment has:calendar is:unread is:email is:screened min-stamp:250 budget',
      )

      expect(parsed.from).toEqual(['alice@example.com'])
      expect(parsed.subject).toEqual(['proposal'])
      expect(parsed.phrases).toEqual(['quarterly report'])
      expect(parsed.hasAttachment).toBe(true)
      expect(parsed.hasCalendar).toBe(true)
      expect(parsed.isUnread).toBe(true)
      expect(parsed.isEmail).toBe(true)
      expect(parsed.isScreened).toBe(true)
      expect(parsed.minStamp).toBe(250)
      expect(parsed.terms).toEqual(['budget'])
    })

    it('supports in:screener and in:unread shorthand filters', () => {
      const screenerQuery = parseSearchQuery('in:screener pitch')
      expect(screenerQuery.isScreened).toBe(true)
      expect(screenerQuery.terms).toEqual(['pitch'])

      const unreadQuery = parseSearchQuery('in:unread')
      expect(unreadQuery.isUnread).toBe(true)
    })
  })

  describe('extractSearchSnippet', () => {
    it('produces a snippet centered around the match with <mark> highlights and escaped HTML', () => {
      const body =
        'Hello team, please review the attached <script>alert(1)</script> quarterly invoice for March 2026 before Friday.'
      const snippet = extractSearchSnippet(body, ['invoice'], [], 120)

      expect(snippet.text).toContain('quarterly invoice for March')
      expect(snippet.html).toContain('<mark>invoice</mark>')
      expect(snippet.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(snippet.highlights.length).toBeGreaterThan(0)
      expect(snippet.highlights[0].match.toLowerCase()).toBe('invoice')
    })

    it('matches prefix tokens in snippet highlights', () => {
      const snippet = extractSearchSnippet(
        'Sending the cryptographic architecture specification today.',
        ['arch'],
      )
      expect(snippet.html).toContain('<mark>architecture</mark>')
    })
  })

  describe('ChatSearchIndex indexing, querying, filters, and ranking', () => {
    it('indexes conversations and messages across subjects, bodies, contacts, and attachments', () => {
      const index = new ChatSearchIndex()

      const aliceAddr = 'lotus_16PSJ2eAliceAddress11111111111111111111'
      const bobAddr = 'lotus_16PSJ2eBobAddress2222222222222222222222'

      const emailConv = createMockConversation({
        id: 'email-thread-1',
        kind: 'email',
        address: aliceAddr,
        subject: 'Q3 Tokenomics Proposal',
        unreadCount: 1,
        lastActivityAt: new Date('2026-03-10T10:00:00Z').getTime(),
        messages: [
          createMockMessage({
            payloadDigest: 'msg-email-1',
            senderAddress: aliceAddr,
            timestamp: new Date('2026-03-10T10:00:00Z'),
            stampValueWei: 500_000_000n,
            items: [
              {
                type: 'email',
                subject: 'Q3 Tokenomics Proposal',
                from: { address: 'alice@frank.org', name: 'Alice Vance' },
                to: [{ address: 'me@frank.org' }],
                bodyText:
                  'Here is the updated financial model.\n\n> On Mar 9, Bob wrote:\n> Old quoted text',
                attachments: [
                  {
                    filename: 'tokenomics-v3.pdf',
                    mimeType: 'application/pdf',
                    size: 4096,
                    content: new Uint8Array([1, 2, 3]),
                  },
                ],
              },
            ],
          }),
        ],
      })

      const chatConv = createMockConversation({
        id: 'chat-thread-2',
        kind: 'direct',
        address: bobAddr,
        unreadCount: 0,
        lastActivityAt: new Date('2026-03-09T08:00:00Z').getTime(),
        messages: [
          createMockMessage({
            payloadDigest: 'msg-chat-1',
            senderAddress: bobAddr,
            timestamp: new Date('2026-03-09T08:00:00Z'),
            stampValueWei: 50_000_000n,
            items: [
              {
                type: 'text',
                text: 'Can we discuss the tokenomics details over a call?',
              },
              {
                type: 'calendar_event',
                uid: 'cal-1',
                title: 'Tokenomics Sync',
                startTime: '2026-03-12T15:00:00Z',
                endTime: '2026-03-12T15:30:00Z',
              } as never,
            ],
          }),
        ],
      })

      index.indexAll([emailConv, chatConv], {
        contacts: {
          [aliceAddr]: { name: 'Alice Vance', username: 'alice_v' },
          [bobAddr]: { name: 'Bob Builder', username: 'bobby' },
        },
      })

      // Prefix search "token" matches both conversations, ranking subject match higher
      const tokenResults = index.search('token')
      expect(tokenResults.length).toBe(2)
      expect(tokenResults[0].conversationId).toBe('email-thread-1')
      expect(tokenResults[0].matchedFields).toContain('subject')

      // Attachment filename match
      const pdfResults = index.search('tokenomics-v3')
      expect(pdfResults.length).toBe(1)
      expect(pdfResults[0].conversationId).toBe('email-thread-1')
      expect(pdfResults[0].matchedFields).toContain('attachment')

      // Structured filter: has:attachment
      const withAttach = index.search('has:attachment')
      expect(withAttach.map(r => r.conversationId)).toEqual(['email-thread-1'])

      // Structured filter: has:calendar
      const withCal = index.search('has:calendar')
      expect(withCal.map(r => r.conversationId)).toEqual(['chat-thread-2'])

      // Structured filter: is:unread
      const unreadOnly = index.search('is:unread')
      expect(unreadOnly.map(r => r.conversationId)).toEqual(['email-thread-1'])

      // Structured filter: is:email
      const emailOnly = index.search('is:email')
      expect(emailOnly.map(r => r.conversationId)).toEqual(['email-thread-1'])

      // Structured filter: from:alice
      const fromAlice = index.search('from:alice')
      expect(fromAlice.map(r => r.conversationId)).toEqual(['email-thread-1'])

      // Structured filter: subject:proposal
      const subjProposal = index.search('subject:proposal')
      expect(subjProposal.map(r => r.conversationId)).toEqual(['email-thread-1'])

      // Structured filter: min-stamp
      const highStamp = index.search('min-stamp:100000000')
      expect(highStamp.map(r => r.conversationId)).toEqual(['email-thread-1'])
    })

    it('supports incremental updates, removals, and snapshot serialization', () => {
      const index = new ChatSearchIndex()
      const conv = createMockConversation({
        id: 'conv-inc',
        address: 'lotus_16PSJ2eInc11111111111111111111111111111',
        messages: [
          createMockMessage({
            payloadDigest: 'm1',
            body: 'First encrypted note about supernova',
          }),
        ],
      })

      index.indexConversation(conv)
      expect(index.search('supernova')).toHaveLength(1)

      // Incrementally add a second message
      const msg2 = createMockMessage({
        payloadDigest: 'm2',
        body: 'Second message mentioning hyperdrive',
      })
      index.addMessage(conv, msg2)
      expect(index.search('hyperdrive')).toHaveLength(1)

      // Serialize & restore into a fresh index instance
      const snapshot = index.serialize()
      const restored = ChatSearchIndex.fromSnapshot(snapshot)
      expect(restored.search('hyperdrive')).toHaveLength(1)
      expect(restored.search('supernova')).toHaveLength(1)

      // Remove single message
      restored.removeMessage('conv-inc', 'm2')
      expect(restored.search('hyperdrive')).toHaveLength(0)
      expect(restored.search('supernova')).toHaveLength(1)

      // Remove entire conversation
      restored.removeConversation('conv-inc')
      expect(restored.search('supernova')).toHaveLength(0)
    })

    it('executes multi-token prefix search across 5,000 messages well within the latency budget', () => {
      const index = new ChatSearchIndex()
      const conversations: Conversation[] = []
      const now = Date.now()

      for (let c = 0; c < 100; c++) {
        const messages: ChatMessage[] = []
        for (let m = 0; m < 50; m++) {
          const idx = c * 50 + m
          const isTarget = idx === 2499 || idx === 4100
          messages.push(
            createMockMessage({
              payloadDigest: `digest-${idx}`,
              timestamp: new Date(now - idx * 60_000),
              body: isTarget
                ? `Confidential settlement ledger entry #${idx} for project zephyr`
                : `Routine status update ${idx} regarding general operations and sync`,
            }),
          )
        }
        conversations.push(
          createMockConversation({
            id: `conv-${c}`,
            address: `lotus_16PSJ2eBenchAddr${c}`,
            messages,
            lastActivityAt: now - c * 60_000,
          }),
        )
      }

      index.indexAll(conversations)
      expect(index.size).toBe(5100) // 5000 messages + 100 conversation docs

      const start = performance.now()
      const results = index.search('confidential zeph')
      const elapsedMs = performance.now() - start

      expect(results).toHaveLength(2)
      expect(results[0].snippet.html).toContain('<mark>Confidential</mark>')
      expect(results[0].snippet.html).toContain('<mark>zephyr</mark>')
      expect(elapsedMs).toBeLessThan(50)
    })

    it('provides standalone searchConversationsAndMessages helper', () => {
      const conv = createMockConversation({
        id: 'conv-helper',
        subject: 'Standalone Search Verification',
        messages: [
          createMockMessage({
            payloadDigest: 'msg-h1',
            body: 'Verifying helper function execution',
          }),
        ],
      })
      const hits = searchConversationsAndMessages([conv], 'standalone verif')
      expect(hits).toHaveLength(1)
      expect(hits[0].conversationId).toBe('conv-helper')
    })
  })
})
