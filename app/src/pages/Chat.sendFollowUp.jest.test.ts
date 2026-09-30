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
    $t: (key: string) => key,
    showStampPreparation: (p: unknown) =>
      methods.showStampPreparation.call(self, p),
    sendDirectMessage: jest
      .fn()
      .mockResolvedValue({ state: 'sent', payloadDigest: 'd' }),
    $nextTick: jest.fn(),
    buttonScrollBottom: jest.fn(),
    ...over,
  }
  self.sendFollowUpItemsUnsettled = (p: unknown) =>
    methods.sendFollowUpItemsUnsettled.call(self, p)
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

describe('Chat.vue sendFollowUpItems settled callback (#368)', () => {
  it.each([
    ['sent', {}, true],
    [
      'failed',
      { sendDirectMessage: jest.fn().mockRejectedValue(new Error('x')) },
      false,
    ],
    ['dropped (busy)', { sendingMessage: true }, false],
  ])('calls settled exactly once when %s', async (_n, over, expected) => {
    const self = fakeThis(over)
    const settled = jest.fn()
    await methods.sendFollowUpItems.call(self, { items, settled })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(expected)
  })

  it('calls settled(false) exactly once, and still rejects, when the send itself throws', async () => {
    const boom = new Error('unexpected')
    const self = fakeThis()
    self.sendFollowUpItemsUnsettled = jest.fn().mockRejectedValue(boom)
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(self, { items, settled }),
    ).rejects.toBe(boom)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(false)
  })

  it('does not report a purchase as settled while its send is still in flight', async () => {
    let finish!: () => void
    const self = fakeThis({
      sendDirectMessage: jest.fn(
        () =>
          new Promise<unknown>(
            r => (finish = () => r({ state: 'sent', payloadDigest: 'd' })),
          ),
      ),
    })
    const settled = jest.fn()
    const pending = methods.sendFollowUpItems.call(self, { items, settled })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish()
    await pending
    expect(settled).toHaveBeenCalledWith(true)
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

describe('Chat.vue sendFollowUpItems vs the no-throw send outcome (#269/#270)', () => {
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it.each([
    [{ state: 'sent', payloadDigest: 'd' }, true],
    // Payment safely pending: the message is stored and delivers on its own.
    [{ state: 'payment-pending' }, true],
    // A failed send stays in the chat (Retry), but it was NOT sent: the bet keeps its unsent-wager
    // record and a purchase does not look settled.
    [{ state: 'failed', reason: 'unreachable' }, false],
    [{ state: 'needs-confirmation', reason: 'unverified' }, false],
    [{ state: 'busy' }, false],
  ] as const)('outcome %j reports %s', async (outcome, expected) => {
    const self = fakeThis({
      sendDirectMessage: jest.fn().mockResolvedValue(outcome),
    })
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(self, { items, settled }),
    ).resolves.toBe(expected)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(expected)
  })

  it('a bet whose message failed is not delivered: deliverBetWhenReady throws so the wager record stays', async () => {
    const { deliverBetWhenReady } = jest.requireActual('../utils/blackjack-bet')
    const self = fakeThis({
      sendDirectMessage: jest
        .fn()
        .mockResolvedValue({ state: 'failed', reason: 'unreachable' }),
    })
    await expect(
      deliverBetWhenReady({
        betAddress: '0xDealer',
        currentAddress: () => '0xDealer',
        isBusy: () => false,
        send: () => methods.sendFollowUpItems.call(self, { items }),
      }),
    ).rejects.toThrow(/could not be sent/)
  })
})
