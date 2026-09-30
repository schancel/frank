/** @jest-environment jsdom */
// Wiring tests for Chat.vue's blackjack bet delivery (#310): the real component methods run
// against a minimal `this`, so removing the idle wait or the chat-change guard fails here.

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
    unit: 'MON',
    defaultStampValue: 1n,
    toDisplayAmount: (n: bigint) => n.toString(),
  },
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

import ChatPage from './Chat.vue'
import { errorNotify } from '../utils/notifications'

const methods = (ChatPage as unknown as { methods: Record<string, any> })
  .methods
const items = [
  { type: 'blackjack-move', gameId: 'g', action: 'bet', wagerTxHash: '0xh' },
]

function fakeThis(over: Record<string, unknown> = {}) {
  const self: Record<string, any> = {
    address: '0xDealer',
    sendingMessage: false,
    bottom: true,
    stampAmount: '0.01',
    stampPreparationStatus: null,
    sendDirectMessage: jest.fn().mockResolvedValue(undefined),
    $nextTick: jest.fn(),
    buttonScrollBottom: jest.fn(),
    ...over,
  }
  self.sendFollowUpItems = (p: unknown) =>
    methods.sendFollowUpItems.call(self, p)
  return self
}

describe('Chat.vue sendFollowUpItems outcome (#310)', () => {
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it('reports true only when the message was actually sent', async () => {
    const self = fakeThis()
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      true,
    )
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)
  })

  it('reports false when the send fails (error toast, not a silent success)', async () => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockRejectedValue(new Error('relay down')),
    })
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      false,
    )
    expect(errorNotify).toHaveBeenCalled()
  })

  it('reports false when another send is in flight (the call is dropped)', async () => {
    const self = fakeThis({ sendingMessage: true })
    await expect(methods.sendFollowUpItems.call(self, { items })).resolves.toBe(
      false,
    )
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
  })
})

describe('Chat.vue sendFollowUpWhenIdle wiring (#310)', () => {
  it('waits while the chat is sending, then sends once', async () => {
    const self = fakeThis({ sendingMessage: true })
    const done = methods.sendFollowUpWhenIdle.call(self, {
      items,
      address: '0xDealer',
    })
    await new Promise(r => setTimeout(r, 250))
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    self.sendingMessage = false
    await done
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses to deliver to a different chat than the one paid, before and while waiting', async () => {
    const before = fakeThis({ address: '0xOther' })
    await expect(
      methods.sendFollowUpWhenIdle.call(before, { items, address: '0xDealer' }),
    ).rejects.toThrow(/chat changed/)
    expect(before.sendDirectMessage).not.toHaveBeenCalled()

    const during = fakeThis({ sendingMessage: true })
    const p = methods.sendFollowUpWhenIdle.call(during, {
      items,
      address: '0xDealer',
    })
    during.address = '0xOther'
    during.sendingMessage = false
    await expect(p).rejects.toThrow(/chat changed/)
    expect(during.sendDirectMessage).not.toHaveBeenCalled()
  })

  it('throws (not delivered) when the underlying send fails', async () => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockRejectedValue(new Error('relay down')),
    })
    await expect(
      methods.sendFollowUpWhenIdle.call(self, { items, address: '0xDealer' }),
    ).rejects.toThrow(/could not be sent/)
  })
})

describe('Chat.vue peer bot gate (#310)', () => {
  const computed = (ChatPage as unknown as { computed: Record<string, any> })
    .computed
  const peer = (profile: Record<string, unknown> | undefined) => ({
    address: '0xDealer',
    getContactVuex: () => (profile ? { profile } : undefined),
  })

  it('is true only for an explicit bot marker; unknown/unmarked/missing profiles are not bots', () => {
    expect(computed.peerIsBot.call(peer({ isBot: true }))).toBe(true)
    expect(computed.peerIsBot.call(peer({ isBot: false }))).toBe(false)
    expect(computed.peerIsBot.call(peer({}))).toBe(false)
    expect(computed.peerIsBot.call(peer(undefined))).toBe(false)
  })
})
