import {
  approveScreenerConversation,
  dismissScreenerConversation,
  formatScreenerStampValue,
  getConversationStampValueWei,
  getMessageStampValueWei,
  getScreenerSenderAddress,
  getScreenerSenderLabel,
  isScreenerConversation,
  rankScreenerConversations,
  summarizeScreenerQueue,
} from './screener-triage'
import { splitQuotedEmailBody } from '../components/chat/email/EmailThreadView.vue'
import type { ChatMessage, Conversation } from '../stores/chats'

function makeMessage(
  overrides: Partial<ChatMessage> & {
    stampValue?: number | bigint | string
  } = {},
): ChatMessage {
  return {
    outbound: false,
    status: 'confirmed',
    items: overrides.items ?? [{ type: 'text', text: 'Paid stranger pitch' }],
    firstSeen: new Date('2026-03-10T10:00:00Z'),
    serverTime: new Date('2026-03-10T10:00:00Z'),
    timestamp: new Date('2026-03-10T10:00:00Z'),
    payloadDigest: overrides.payloadDigest ?? 'msg-1',
    senderAddress:
      overrides.senderAddress ?? 'lotus_16PSJ2eStranger11111111111111111111111',
    totalValue: overrides.totalValue ?? 0,
    ...overrides,
  }
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? overrides.address ?? 'conv-stranger-1'
  return {
    id,
    kind: overrides.kind ?? 'direct',
    address:
      overrides.address ?? 'lotus_16PSJ2eStranger11111111111111111111111',
    messages: overrides.messages ?? [
      makeMessage({ stampValueWei: 100_000_000n }),
    ],
    unreadCount: overrides.unreadCount ?? 1,
    totalValue: overrides.totalValue ?? 100_000_000,
    totalUnreadValue: overrides.totalUnreadValue ?? 100_000_000,
    lastActivityAt: overrides.lastActivityAt ?? 1_700_000_000_000,
    lastMessageId: null,
    active: false,
    ...overrides,
  }
}

describe('screener-triage ("The Tollbooth")', () => {
  describe('getMessageStampValueWei and getConversationStampValueWei', () => {
    it('extracts stamp value from stampValueWei, stampPayments, stampValue, and outpoints', () => {
      expect(getMessageStampValueWei(null)).toBe(0n)

      expect(
        getMessageStampValueWei(makeMessage({ stampValueWei: 250_000_000n })),
      ).toBe(250_000_000n)

      expect(
        getMessageStampValueWei(
          makeMessage({
            stampValueWei: undefined,
            stampPayments: [
              { txHash: '0x1', valueWei: 120_000_000n },
              { txHash: '0x2', valueWei: 80_000_000n },
            ],
          }),
        ),
      ).toBe(200_000_000n)

      expect(
        getMessageStampValueWei(
          makeMessage({
            stampValueWei: undefined,
            stampValue: 75_000_000,
          }),
        ),
      ).toBe(75_000_000n)

      expect(
        getMessageStampValueWei(
          makeMessage({
            stampValueWei: undefined,
            outpoints: [
              { amount: 30_000_000 } as never,
              { satoshis: 20_000_000 } as never,
            ],
          }),
        ),
      ).toBe(50_000_000n)
    })

    it('sums inbound message stamps and falls back to conversation totalValue', () => {
      const conv = makeConversation({
        totalValue: 0,
        totalUnreadValue: 0,
        messages: [
          makeMessage({
            payloadDigest: 'm1',
            outbound: false,
            stampValueWei: 150_000_000n,
          }),
          makeMessage({
            payloadDigest: 'm2',
            outbound: false,
            stampValueWei: 50_000_000n,
          }),
          makeMessage({
            payloadDigest: 'm3',
            outbound: true,
            stampValueWei: 999_000_000n,
          }),
        ],
      })
      expect(getConversationStampValueWei(conv)).toBe(200_000_000n)

      const fallbackConv = makeConversation({
        messages: [],
        totalValue: 400_000_000,
      })
      expect(getConversationStampValueWei(fallbackConv)).toBe(400_000_000n)
    })
  })

  describe('isScreenerConversation', () => {
    it('identifies inbound-only conversations from non-contacts with positive stamp value', () => {
      const strangerConv = makeConversation({
        address: 'lotus_16PSJ2eStranger11111111111111111111111',
        messages: [
          makeMessage({
            outbound: false,
            stampValueWei: 100_000_000n,
          }),
        ],
      })

      expect(isScreenerConversation(strangerConv, () => false)).toBe(true)
    })

    it('excludes conversations from known contacts', () => {
      const contactAddr = 'lotus_16PSJ2eKnownContact1111111111111111111'
      const conv = makeConversation({
        address: contactAddr,
        messages: [
          makeMessage({
            senderAddress: contactAddr,
            outbound: false,
            stampValueWei: 100_000_000n,
          }),
        ],
      })

      expect(isScreenerConversation(conv, addr => addr === contactAddr)).toBe(
        false,
      )
      expect(
        isScreenerConversation(conv, {
          contacts: { [contactAddr]: { profile: { name: 'Friend' } } },
        }),
      ).toBe(false)
    })

    it('excludes conversations that already have outbound replies', () => {
      const repliedConv = makeConversation({
        messages: [
          makeMessage({
            payloadDigest: 'in-1',
            outbound: false,
            stampValueWei: 100_000_000n,
          }),
          makeMessage({
            payloadDigest: 'out-1',
            outbound: true,
            stampValueWei: 0n,
          }),
        ],
      })

      expect(isScreenerConversation(repliedConv, () => false)).toBe(false)
    })

    it('excludes zero-stamp, approved, dismissed, or deleted conversations', () => {
      const zeroStamp = makeConversation({
        totalValue: 0,
        totalUnreadValue: 0,
        messages: [makeMessage({ stampValueWei: 0n })],
      })
      expect(isScreenerConversation(zeroStamp, () => false)).toBe(false)

      const approved = makeConversation({ screenerStatus: 'approved' })
      expect(isScreenerConversation(approved, () => false)).toBe(false)

      const dismissed = makeConversation({ screenerStatus: 'dismissed' })
      expect(isScreenerConversation(dismissed, () => false)).toBe(false)

      const deleted = makeConversation({ deletedAt: Date.now() })
      expect(isScreenerConversation(deleted, () => false)).toBe(false)
    })

    it('inspects external email sender for verified gateway email threads', () => {
      const gatewayAddr = 'lotus_16PSJ2eGateway111111111111111111111111'
      const emailConv = makeConversation({
        id: 'email:stranger',
        kind: 'email',
        verifiedGateway: true,
        address: gatewayAddr,
        messages: [
          makeMessage({
            senderAddress: gatewayAddr,
            stampValueWei: 300_000_000n,
            items: [
              {
                type: 'email',
                subject: 'Partnership Inquiry',
                from: {
                  name: 'Venture Partner',
                  address: 'partner@vc.example.com',
                },
                to: [{ address: 'me@frank.org' }],
                bodyText: 'Would love to connect.',
              },
            ],
          }),
        ],
      })

      expect(getScreenerSenderAddress(emailConv)).toBe('partner@vc.example.com')
      expect(getScreenerSenderLabel(emailConv)).toBe(
        'Venture Partner <partner@vc.example.com>',
      )
      // Even if gateway is in contacts, the external email sender is not
      expect(
        isScreenerConversation(emailConv, addr => addr === gatewayAddr),
      ).toBe(true)
      // Once the external email sender is in contacts, it leaves the screener queue
      expect(
        isScreenerConversation(
          emailConv,
          addr => addr === 'partner@vc.example.com',
        ),
      ).toBe(false)
    })
  })

  describe('rankScreenerConversations and summarizeScreenerQueue', () => {
    it('sorts screener queue descending by verified stamp value attached, then by recency', () => {
      const lowStamp = makeConversation({
        id: 'conv-low',
        address: 'lotus_16PSJ2eLow111111111111111111111111111',
        totalValue: 50_000_000,
        lastActivityAt: 3000,
        messages: [makeMessage({ stampValueWei: 50_000_000n })],
      })
      const highStamp = makeConversation({
        id: 'conv-high',
        address: 'lotus_16PSJ2eHigh11111111111111111111111111',
        totalValue: 500_000_000,
        lastActivityAt: 1000,
        messages: [makeMessage({ stampValueWei: 500_000_000n })],
      })
      const midStamp = makeConversation({
        id: 'conv-mid',
        address: 'lotus_16PSJ2eMid111111111111111111111111111',
        totalValue: 150_000_000,
        lastActivityAt: 2000,
        messages: [makeMessage({ stampValueWei: 150_000_000n })],
      })
      const knownContact = makeConversation({
        id: 'conv-contact',
        address: 'lotus_16PSJ2eContact11111111111111111111111',
        totalValue: 9_000_000_000,
        messages: [
          makeMessage({
            senderAddress: 'lotus_16PSJ2eContact11111111111111111111111',
            stampValueWei: 9_000_000_000n,
          }),
        ],
      })

      const ranked = rankScreenerConversations(
        [lowStamp, knownContact, midStamp, highStamp],
        addr => addr === 'lotus_16PSJ2eContact11111111111111111111111',
      )

      expect(ranked.map(c => c.id)).toEqual([
        'conv-high',
        'conv-mid',
        'conv-low',
      ])

      const summary = summarizeScreenerQueue(
        [lowStamp, knownContact, midStamp, highStamp],
        addr => addr === 'lotus_16PSJ2eContact11111111111111111111111',
        2.0,
      )
      expect(summary.count).toBe(3)
      expect(summary.unreadCount).toBe(3)
      expect(summary.totalValueWei).toBe(700_000_000n)
      expect(summary.formattedTotal.combinedDisplay).toContain('AVU')
    })
  })

  describe('formatScreenerStampValue', () => {
    it('formats stamp values in both native chain units and AVU', () => {
      // 100 XPI = 100_000_000 satoshis (6 decimals on Lotus)
      const formatted = formatScreenerStampValue(100_000_000n, {
        chain: {
          chainIdentifier: 'lotus',
          unit: 'XPI',
          toDisplayAmount: (raw: bigint) => (Number(raw) / 1e6).toString(),
          fromDisplayAmount: (d: string) => BigInt(Math.round(Number(d) * 1e6)),
        },
        asset: 'XPI',
        avuRate: 0.05, // 100 XPI * 0.05 = 5 AVU
      })

      expect(formatted.nativeDisplay).toBe('100 XPI')
      expect(formatted.avuDisplay).toBe('~5.00 AVU')
      expect(formatted.combinedDisplay).toBe('100 XPI (~5.00 AVU)')
      expect(String(formatted)).toBe('100 XPI (~5.00 AVU)')
    })
  })

  describe('approveScreenerConversation and dismissScreenerConversation', () => {
    it('marks conversation approved and adds sender to contacts on approve', () => {
      const conv = makeConversation({
        id: 'conv-approve',
        address: 'lotus_16PSJ2eApprove1111111111111111111111',
      })
      const setScreenerStatus = jest.fn()
      const addDefaultContact = jest.fn()

      approveScreenerConversation(
        conv,
        { setScreenerStatus },
        { addDefaultContact },
      )

      expect(conv.screenerStatus).toBe('approved')
      expect(setScreenerStatus).toHaveBeenCalledWith({
        conversationId: 'conv-approve',
        status: 'approved',
      })
      expect(addDefaultContact).toHaveBeenCalledWith(
        'lotus_16PSJ2eApprove1111111111111111111111',
      )
    })

    it('marks conversation dismissed and clears unread count while keeping stamp value', () => {
      const msg = makeMessage({ stampValueWei: 250_000_000n })
      const conv = makeConversation({
        id: 'conv-dismiss',
        unreadCount: 2,
        totalUnreadValue: 250_000_000,
        messages: [msg],
      })
      const setScreenerStatus = jest.fn()
      const readAll = jest.fn()

      dismissScreenerConversation(conv, { setScreenerStatus, readAll })

      expect(conv.screenerStatus).toBe('dismissed')
      expect(conv.unreadCount).toBe(0)
      expect(getMessageStampValueWei(msg)).toBe(250_000_000n)
      expect(setScreenerStatus).toHaveBeenCalledWith({
        conversationId: 'conv-dismiss',
        status: 'dismissed',
      })
      expect(readAll).toHaveBeenCalledWith('conv-dismiss')
    })
  })

  describe('splitQuotedEmailBody (EmailThreadView quote folding)', () => {
    it('separates visible reply body from trailing "> " quoted history', () => {
      const body = [
        'Sounds good, let us finalize the contract tomorrow.',
        '',
        'On Tue, Mar 10, 2026 at 9:00 AM Alice <alice@example.com> wrote:',
        '> Please review the attached draft.',
        '> Let me know if you have questions.',
      ].join('\n')

      const parts = splitQuotedEmailBody(body)
      expect(parts.visibleBody).toBe(
        'Sounds good, let us finalize the contract tomorrow.',
      )
      expect(parts.quotedBody).toContain('On Tue, Mar 10, 2026')
      expect(parts.quotedBody).toContain('> Please review the attached draft.')
    })

    it('returns full body as visibleBody when no trailing quote block exists', () => {
      const body = 'Just a clean single-paragraph message with no quotes.'
      const parts = splitQuotedEmailBody(body)
      expect(parts.visibleBody).toBe(body)
      expect(parts.quotedBody).toBe('')
    })
  })
})
