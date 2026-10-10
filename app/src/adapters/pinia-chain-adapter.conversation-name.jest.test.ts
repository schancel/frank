/** The adapter hands the chat store the conversation subject a received message carries. */
// Loaded before the `document` stub below, as in `pinia-chain-adapter.jest.test.ts`.
import 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { toReceivedMessageWrapper } from './pinia-chain-adapter'
import type { DirectMessageReceived } from '@frank/wallet/chain'

jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({ store: Promise.resolve({}) }))

const record = (
  overrides: Partial<DirectMessageReceived>,
): DirectMessageReceived => ({
  senderAddress: { raw: '0x4C4C4C4C4C4c4C4C4C4C4c4C4C4c4C4c4C4C4c4C' },
  senderPublicKey: Uint8Array.from(
    Buffer.from(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'hex',
    ),
  ),
  recipientAddress: { raw: '0x5d5d5d5D5D5D5d5d5d5d5D5d5D5D5d5D5D5d5d5D' },
  items: [{ type: 'text', text: 'hi' }],
  conversationId: '11111111-2222-4333-8444-555555555555',
  payloadDigest: 'digest-1',
  stampValueWei: 1n,
  stampPayments: [],
  receivedTime: 1_700_000_000_000,
  ...overrides,
})

describe('toReceivedMessageWrapper: the conversation subject', () => {
  it('passes a carried subject through, and nothing when the message carries none', async () => {
    const opening = await toReceivedMessageWrapper(
      record({ conversationName: 'Weekend plans' }),
    )
    expect(opening?.message.conversationName).toBe('Weekend plans')
    const ordinary = await toReceivedMessageWrapper(record({}))
    expect(ordinary).toBeDefined()
    expect('conversationName' in (ordinary?.message ?? {})).toBe(false)
  })
})
