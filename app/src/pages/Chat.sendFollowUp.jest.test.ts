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
  playerStep,
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
    const seed = loadSeed('0xMe', '0xDealer', item.gameId)!
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
      seq: 0,
      role: 'player',
      maxBetWei: '1000',
    })
    expect(loadSeed('0xMe', '0xDealer', item.gameId)).toBeUndefined()
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

describe('Chat.vue sends a hand message only while it is still the next one', () => {
  const GAME = 'feedfacefeedfacefeedfacefeedface'
  const challenge = {
    outbound: false,
    items: [
      {
        type: 'blackjack-hand',
        gameId: GAME,
        action: 'challenge',
        seq: 0,
        role: 'dealer',
        maxBetWei: '500',
        commitment: 'c'.repeat(64),
      },
    ],
    stampValueWei: 1n,
    payloadDigest: 'challenge',
  }
  // The hand's second message: it names the challenge as the one before it.
  const bet = {
    type: 'blackjack-hand',
    gameId: GAME,
    action: 'bet',
    seq: 1,
    prev: 'challenge',
    commitment: 'b'.repeat(64),
  }
  beforeEach(() => jest.mocked(errorNotify).mockReset())

  it('sends a bet once: with the bet already in the chat a second click sends nothing', async () => {
    const self = fakeThis({ address: '0xPeer', messages: [challenge] })
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [bet],
        stampValueWei: 300n,
      }),
    ).resolves.toBe(true)
    expect(self.sendDirectMessage).toHaveBeenCalledTimes(1)

    const again = fakeThis({
      address: '0xPeer',
      messages: [
        challenge,
        {
          outbound: true,
          items: [bet],
          stampValueWei: 300n,
          payloadDigest: 'pending:1',
          status: 'error',
        },
      ],
    })
    const settled = jest.fn()
    await expect(
      methods.sendFollowUpItems.call(again, {
        items: [bet],
        stampValueWei: 300n,
        settled,
      }),
    ).resolves.toBe(false)
    expect(again.sendDirectMessage).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledWith(false)
    expect(errorNotify).toHaveBeenCalled()
  })

  it('sends nothing for a move that is not legal in the hand as saved', async () => {
    const self = fakeThis({ address: '0xPeer', messages: [challenge] })
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [
          {
            type: 'blackjack-hand',
            gameId: GAME,
            action: 'stand',
            seq: 1,
            prev: 'challenge',
            link: 'a'.repeat(64),
          },
        ],
      }),
    ).resolves.toBe(false)
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
    // Nor for a message that names another place in the hand than the next one: a second tab
    // that has not seen the latest message builds on a stale one.
    await expect(
      methods.sendFollowUpItems.call(self, {
        items: [{ ...bet, prev: 'something older' }],
        stampValueWei: 300n,
      }),
    ).resolves.toBe(false)
    expect(self.sendDirectMessage).not.toHaveBeenCalled()
  })
})

describe('Chat.vue automatic dealer steps', () => {
  const SEED = 'cd'.repeat(32)
  const GAME = '0123456789abcdef0123456789abcdef'
  const PLAYER_SEED = 'ef'.repeat(32)
  const digestOf = (i: number) => `${i}`.padStart(64, 'a')
  const hand = (...fields: [boolean, Record<string, unknown>, bigint][]) =>
    fields.map(([outbound, item, stampValueWei], i) => ({
      outbound,
      items: [{ type: 'blackjack-hand', gameId: GAME, ...item }],
      stampValueWei,
      payloadDigest: digestOf(i),
    }))
  /** The player's bet as the hand's second message. */
  const betItem = {
    action: 'bet',
    seq: 1,
    prev: digestOf(0),
    commitment: commitmentOf(PLAYER_SEED),
  }
  const challenge: [boolean, Record<string, unknown>, bigint] = [
    true,
    {
      action: 'challenge',
      seq: 0,
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
  beforeAll(() => saveSeed('0xMe', '0xPeer', GAME, SEED))

  it('deals as soon as the bet is in, once', async () => {
    const self = dealerThis(hand(challenge, [false, betItem, 300n]))
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    const sent = self.sendFollowUpItems.mock.calls[0][0]
    expect(sent.items[0].action).toBe('deal')
    expect(sent.stampValueWei).toBeUndefined()
    // The same position is never attempted twice, even if the send left no message behind.
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
  })

  it('on opening the chat, sends a deal that was cut off again instead of leaving the hand stuck', async () => {
    const bet = hand(challenge, [false, { action: 'bet' }, 300n])
    const step = dealerStep(
      foldHand(
        bet.map(m => ({
          item: m.items[0] as never,
          from: m.outbound ? '0xMe' : '0xPeer',
          to: m.outbound ? '0xPeer' : '0xMe',
          stampWei: m.stampValueWei,
          digest: m.payloadDigest,
        })),
      ).state,
      SEED,
    )
    // What a reload leaves of a deal whose send the closing window cut off.
    const messages = [
      ...bet.map(m => ({ ...m, status: 'confirmed' })),
      {
        outbound: true,
        status: 'error',
        delivery: { failureReason: 'interrupted' },
        items: [step?.item],
        stampValueWei: 1n,
        payloadDigest: 'pending:1:1:',
      },
    ]
    const chatStore = {
      retryOutgoing: jest.fn().mockResolvedValue({ state: 'sent' }),
      resumeOutgoing: jest.fn(),
    }
    const self = dealerThis(messages, { chatStore })
    self.runBlackjackDealer = () => methods.runBlackjackDealer.call(self)
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    await methods.runBlackjackDealer.call(self)
    await new Promise(resolve => setTimeout(resolve, 0))
    info.mockRestore()
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    expect(chatStore.retryOutgoing).toHaveBeenCalledWith({
      wallet: {},
      address: '0xPeer',
      payloadDigest: 'pending:1:1:',
      automatic: true,
    })
    // The cut-off deal is the hand's deal: no second one is built.
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    expect(chatStore.resumeOutgoing).not.toHaveBeenCalled()
  })

  it('while a message is being resumed no other trigger sends a step, and the hand waits until it is delivered', async () => {
    // An own failed message of the hand that the fold does not advance on (a dealer cannot
    // stand): the deal is still the hand's next step, so only the resume guard and the
    // undelivered-message rule keep it from going out ahead of the resumed message.
    const messages = [
      ...hand(challenge, [false, { action: 'bet' }, 300n]).map(m => ({
        ...m,
        status: 'confirmed',
      })),
      {
        outbound: true,
        status: 'error',
        delivery: { failureReason: 'interrupted' },
        items: [{ type: 'blackjack-hand', gameId: GAME, action: 'stand' }],
        stampValueWei: 1n,
        payloadDigest: 'pending:2:1:',
      },
    ]
    let finish: (outcome: { state: string }) => void = () => undefined
    const chatStore = {
      retryOutgoing: jest.fn(
        () =>
          new Promise<{ state: string }>(resolve => {
            finish = resolve
          }),
      ),
      resumeOutgoing: jest.fn(),
    }
    const self = dealerThis(messages, { chatStore, resumingHand: false })
    self.runBlackjackDealer = () => methods.runBlackjackDealer.call(self)
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const first = methods.runBlackjackDealer.call(self)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    expect(self.resumingHand).toBe(true)
    // A watcher fires meanwhile (a message arrived, a send finished).
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    // The resume ends with the message still not delivered (e.g. its payment is pending).
    finish({ state: 'payment-pending' })
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(self.resumingHand).toBe(false)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
    // Once it is delivered the hand moves on.
    messages[messages.length - 1].status = 'confirmed'
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).toHaveBeenCalledTimes(1)
    expect(self.sendFollowUpItems.mock.calls[0][0].items[0].action).toBe('deal')
    expect(chatStore.retryOutgoing).toHaveBeenCalledTimes(1)
    info.mockRestore()
  })

  it('does not send while another message is being sent', async () => {
    const self = dealerThis(hand(challenge, [false, betItem, 300n]), {
      sendingMessage: true,
    })
    await methods.runBlackjackDealer.call(self)
    expect(self.sendFollowUpItems).not.toHaveBeenCalled()
  })

  it('never pays without the dealer: a refund and a paying reveal wait for a button', async () => {
    // A bet above the max is owed back.
    const refundOwed = dealerThis(
      hand(challenge, [false, betItem, 501n]),
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
        digest: digestOf(0),
      },
      {
        item: { type: 'blackjack-hand', gameId: GAME, ...betItem },
        from: '0xPeer',
        to: '0xMe',
        stampWei: 300n,
        digest: 'b',
      },
    ] as Parameters<typeof foldHand>[0]
    const rows: [boolean, Record<string, unknown>, bigint][] = [
      challenge,
      [false, betItem, 300n],
    ]
    for (;;) {
      const state = foldHand(events).state
      const step = dealerStep(state, SEED)
      if (!step && state?.phase === 'player_turn') {
        const stand = playerStep(state, 'stand', PLAYER_SEED)!
        events.push({
          item: stand,
          from: '0xPeer',
          to: '0xMe',
          stampWei: 1n,
          digest: 's',
        })
        rows.push([false, stand as unknown as Record<string, unknown>, 1n])
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
