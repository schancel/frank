/** @jest-environment jsdom */
// Wiring tests for Chat.vue's follow-up sends and its blackjack methods: the real component
// methods run against a minimal `this`.

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
    nativeTransfers: { getBalance: jest.fn() },
    toDisplayAmount: (n: bigint) => n.toString(),
  },
}))
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
  sameCanonicalAddress: (a: string, b: string) => a === b,
}))

import ChatPage from './Chat.vue'
import { errorNotify } from '../utils/notifications'
import { activeChain } from '@frank/wallet/chain'
import {
  commitmentOf,
  dealerStep,
  foldHand,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import {
  HAND_FEE_RESERVE_WEI,
  loadSeed,
  saveSeed,
} from '../utils/blackjack-hand'

const methods = (ChatPage as unknown as { methods: Record<string, any> })
  .methods
const items = [{ type: 'blackjack-hand', gameId: 'g', action: 'bet' }]

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
})

describe('Chat.vue blackjack challenge', () => {
  const balance = jest.mocked(activeChain.nativeTransfers.getBalance)
  const challengeThis = (over: Record<string, unknown> = {}) => {
    const self = fakeThis({ blackjackDialog: true, ...over })
    self.sendFollowUpItems = jest.fn().mockResolvedValue(true)
    return self
  }
  beforeEach(() => {
    jest.mocked(errorNotify).mockReset()
    balance.mockReset()
  })

  it('sends a dealer challenge with a commitment, keeps the seed, and pays only the ordinary stamp', async () => {
    balance.mockResolvedValue(HAND_FEE_RESERVE_WEI + 4_000n)
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'dealer',
      maxBetWei: 1_000n,
    })
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    const sent = self.sendFollowUpItems.mock.calls[0][0]
    // No stamp override: a challenge carries no money.
    expect(sent.stampValueWei).toBeUndefined()
    const [item] = sent.items
    expect(item).toMatchObject({
      type: 'blackjack-hand',
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '1000',
    })
    // The seed behind the commitment is on this device and never in the message.
    const seed = loadSeed('0xDealer', item.gameId)!
    expect(commitmentOf(seed)).toBe(item.commitment)
    expect(JSON.stringify(item)).not.toContain(seed)
    expect(self.blackjackDialog).toBe(false)
  })

  it('sends a player challenge with no commitment and no seed', async () => {
    balance.mockResolvedValue(HAND_FEE_RESERVE_WEI + 1_000n)
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'player',
      maxBetWei: 1_000n,
    })
    const [item] = self.sendFollowUpItems.mock.calls[0][0].items
    expect(item).toEqual({
      type: 'blackjack-hand',
      gameId: item.gameId,
      action: 'challenge',
      role: 'player',
      maxBetWei: '1000',
    })
    expect(loadSeed('0xDealer', item.gameId)).toBeUndefined()
  })

  it.each([
    ['dealer', 1_001n, HAND_FEE_RESERVE_WEI + 4_000n],
    ['player', 1_001n, HAND_FEE_RESERVE_WEI + 1_000n],
    ['dealer', 1n, HAND_FEE_RESERVE_WEI],
  ] as const)(
    'refuses a %s challenge of %s that the balance does not cover, and sends nothing',
    async (role, maxBetWei, spendable) => {
      balance.mockResolvedValue(spendable)
      const self = challengeThis()
      await methods.sendBlackjackChallenge.call(self, { role, maxBetWei })
      expect(self.sendFollowUpItems).not.toHaveBeenCalled()
      expect(errorNotify).toHaveBeenCalled()
    },
  )

  it('sends nothing when the balance cannot be read', async () => {
    balance.mockRejectedValue(new Error('rpc down'))
    const self = challengeThis()
    await methods.sendBlackjackChallenge.call(self, {
      role: 'player',
      maxBetWei: 1n,
    })
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })
})

describe('Chat.vue automatic dealer steps', () => {
  const SEED = 'cd'.repeat(32)
  const GAME = '0123456789abcdef0123456789abcdef'
  const hand = (...fields: [boolean, Record<string, unknown>, bigint][]) =>
    fields.map(([outbound, item, stampValueWei], i) => ({
      outbound,
      items: [{ type: 'blackjack-hand', gameId: GAME, ...item }],
      stampValueWei,
      payloadDigest: `${i}`.padStart(64, 'a'),
    }))
  const challenge: [boolean, Record<string, unknown>, bigint] = [
    true,
    {
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '500',
      commitment: commitmentOf(SEED),
    },
    1n,
  ]
  const dealerThis = (
    messages: unknown[],
    over: Record<string, unknown> = {},
  ) => {
    const self = fakeThis({
      address: '0xPeer',
      messages,
      blackjackAttempted: new Set<string>(),
      ...over,
    })
    self.sendFollowUpItems = jest.fn().mockResolvedValue(true)
    return self
  }
  beforeAll(() => saveSeed('0xPeer', GAME, SEED))

  it('deals as soon as the bet is in, once', async () => {
    const self = dealerThis(hand(challenge, [false, { action: 'bet' }, 300n]))
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    const sent = self.sendFollowUpItems.mock.calls[0][0]
    expect(sent.items[0].action).toBe('deal')
    expect(sent.stampValueWei).toBeUndefined()
    // The same position is never attempted twice, even if the send left no message behind.
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
  })

  it('does not send while another message is being sent', async () => {
    const self = dealerThis(hand(challenge, [false, { action: 'bet' }, 300n]), {
      sendingMessage: true,
    })
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })

  it('never pays without the dealer: a refund and a paying reveal wait for a button', async () => {
    // A bet above the max is owed back.
    const refundOwed = dealerThis(
      hand(challenge, [false, { action: 'bet' }, 501n]),
    )
    await methods.runBlackjackDealer.call(refundOwed)
    expect(refundOwed.sendFollowUpItems).not.toHaveBeenCalled()

    // Play a hand to the reveal; if the player is owed anything the reveal is not automatic.
    const events = [
      {
        item: { type: 'blackjack-hand', gameId: GAME, ...challenge[1] },
        from: '0xMe',
        to: '0xPeer',
        stampWei: 1n,
        digest: 'c',
      },
      {
        item: { type: 'blackjack-hand', gameId: GAME, action: 'bet' },
        from: '0xPeer',
        to: '0xMe',
        stampWei: 300n,
        digest: 'b',
      },
    ] as Parameters<typeof foldHand>[0]
    const rows: [boolean, Record<string, unknown>, bigint][] = [
      challenge,
      [false, { action: 'bet' }, 300n],
    ]
    for (;;) {
      const state = foldHand(events).state
      const step = dealerStep(state, SEED)
      if (!step && state?.phase === 'player_turn') {
        events.push({
          item: { type: 'blackjack-hand', gameId: GAME, action: 'stand' },
          from: '0xPeer',
          to: '0xMe',
          stampWei: 1n,
          digest: 's',
        })
        rows.push([false, { action: 'stand' }, 1n])
        continue
      }
      if (!step || step.item.action === 'reveal') break
      events.push({
        item: step.item,
        from: '0xMe',
        to: '0xPeer',
        stampWei: 1n,
        digest: `d${events.length}`,
      })
      rows.push([true, step.item as unknown as Record<string, unknown>, 1n])
    }
    // The digests must match those the events used.
    const messages = rows.map(([outbound, item, stampValueWei], i) => ({
      outbound,
      items: [{ type: 'blackjack-hand', gameId: GAME, ...item }],
      stampValueWei,
      payloadDigest: events[i].digest,
    }))
    const reveal = dealerStep(foldHand(events).state, SEED)!
    expect(reveal.item.action).toBe('reveal')
    const self = dealerThis(messages)
    await methods.runBlackjackDealer.call(self)
    if (reveal.payWei === undefined) {
      expect(self.sendFollowUpItems.mock.calls[0][0].items[0].action).toBe(
        'reveal',
      )
    } else {
      expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    }
  })
})
