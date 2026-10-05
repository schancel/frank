import { handValue } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  buildBet,
  commitmentOf,
  dealerStep,
  foldHand,
  handView,
  playerStep,
  type HandItem,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  automaticDealerSteps,
  chatHandEvents,
  chatHands,
  deriveBlackjackSeed,
  handItemStillNext,
  loadSeed,
  newGameId,
  newSeed,
  resumeHandMessages,
  saveSeed,
  undeliveredHandMessages,
  type HandChatMessage,
} from './blackjack-hand'
import { messagingWallet } from './monad-identity-session'
import { outgoingLockName } from './outgoing-lock'
import { FakeLockManager } from './__fakes__/web-locks'

jest.mock('./monad-identity-session', () => ({
  messagingWallet: jest.fn(),
}))

const ME = '0x1111111111111111111111111111111111111111'
const PEER = '0x2222222222222222222222222222222222222222'
const SEED = 'ab'.repeat(32)
/** A well-formed game id (32 lowercase hex characters) for a readable name. */
const gid = (name: string) =>
  Array.from(name, c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32)
const PLAYER_SEED = 'cd'.repeat(32)
let n = 0
/** The messages written so far for each game, from its latest challenge on. */
const written = new Map<string, HandChatMessage[]>()
/** One stored message. The fields a client derives from the hand (the message's place in the
 * hand's chain, a bet's commitment) are filled in from the messages written before it for the
 * same game, unless `fields` names them. */
const message = (
  outbound: boolean,
  fields: Record<string, unknown>,
  stampValueWei = 10n,
  gameId = gid('g1'),
): HandChatMessage => {
  if (fields.action === 'challenge') written.set(gameId, [])
  const before = written.get(gameId) ?? []
  const state = foldHand(chatHandEvents(before, ME, PEER, gameId)).state
  const derived: Record<string, unknown> =
    fields.action === 'challenge'
      ? { seq: 0 }
      : { seq: state?.count ?? 1, prev: state?.head ?? '0'.repeat(64) }
  if (fields.action === 'bet') derived.commitment = commitmentOf(PLAYER_SEED)
  const made: HandChatMessage = {
    outbound,
    items: [
      { type: 'blackjack-hand', gameId, ...derived, ...fields } as MessageItem,
    ],
    stampValueWei,
    payloadDigest: (++n).toString(16).padStart(64, '0'),
  }
  written.set(gameId, [...before, made])
  return made
}

describe('a chat as blackjack hand events', () => {
  it('takes the direction from who sent the message and ignores other items', () => {
    const messages: HandChatMessage[] = [
      {
        outbound: true,
        items: [{ type: 'text', text: 'hi' }],
        payloadDigest: 'x',
      },
      message(true, { action: 'challenge', role: 'player', maxBetWei: '500' }),
      message(false, {
        action: 'accept',
        maxBetWei: '400',
        commitment: commitmentOf(SEED),
      }),
      message(true, { action: 'bet' }, 300n),
    ]
    const events = chatHandEvents(messages, ME, PEER)
    expect(events.map(e => [e.from, e.to, e.stampWei])).toEqual([
      [ME, PEER, 10n],
      [PEER, ME, 10n],
      [ME, PEER, 300n],
    ])
    const [hand] = chatHands(messages, ME, PEER)
    expect(hand.state).toMatchObject({
      phase: 'awaiting_deal',
      player: ME,
      dealer: PEER,
      wagerWei: 300n,
      maxBetWei: 400n,
    })
    expect(chatHandEvents(messages, ME, PEER, gid('other'))).toEqual([])
  })

  it('credits nothing when one message carries more than one hand item', () => {
    const challenge = (gameId: string) =>
      message(
        false,
        {
          action: 'challenge',
          role: 'dealer',
          maxBetWei: '500',
          commitment: commitmentOf(SEED),
        },
        10n,
        gameId,
      )
    const double = message(true, { action: 'bet' }, 500n, gid('x'))
    double.items.push({
      ...(double.items[0] as HandItem),
      gameId: gid('y'),
    } as MessageItem)
    const hands = chatHands(
      [challenge(gid('x')), challenge(gid('y')), double],
      ME,
      PEER,
    )
    expect(hands.map(h => [h.state.phase, h.state.wagerWei])).toEqual([
      ['open', 0n],
      ['open', 0n],
    ])
  })

  it('keeps hands of one chat apart', () => {
    const messages = [
      message(
        true,
        { action: 'challenge', role: 'player', maxBetWei: '5' },
        10n,
        gid('a'),
      ),
      message(
        false,
        { action: 'challenge', role: 'player', maxBetWei: '7' },
        10n,
        gid('b'),
      ),
      message(false, { action: 'bet' }, 5n, gid('a')),
    ]
    const hands = chatHands(messages, ME, PEER)
    expect(
      hands.map(h => [h.state.gameId, h.state.phase, h.state.player]),
    ).toEqual([
      [gid('a'), 'challenged', ME],
      [gid('b'), 'challenged', PEER],
    ])
    // The peer's stray bet on a hand where it is the dealer is simply rejected.
    expect(hands[0].rejected).toEqual(['wrong-sender'])
  })
})

describe('deterministic blackjack seeds on this device', () => {
  it('keeps a seed in memory cache', () => {
    saveSeed(ME, PEER, gid('session-only'), SEED)
    expect(loadSeed(ME, PEER, gid('session-only'))).toBe(SEED)
  })

  it('derives seed deterministically from wallet secret and game ID', () => {
    const privKey =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const s1 = deriveBlackjackSeed(gid('game-1'), ME, privKey)
    const s2 = deriveBlackjackSeed(gid('game-1'), ME, privKey)
    expect(s1).toBe(s2)
    expect(s1).toMatch(/^[0-9a-f]{64}$/)

    // Different game ID yields different seed
    const s3 = deriveBlackjackSeed(gid('game-2'), ME, privKey)
    expect(s3).not.toBe(s1)

    // Different own address yields different seed
    const s4 = deriveBlackjackSeed(gid('game-1'), PEER, privKey)
    expect(s4).not.toBe(s1)
  })

  it('saves and loads a seed, and re-derives from wallet if missing in cache', () => {
    expect(loadSeed(ME, PEER, gid('nope'))).toBeUndefined()
    saveSeed(ME, PEER, gid('g-seed'), SEED)
    expect(loadSeed(ME, PEER, gid('g-seed'))).toBe(SEED)

    // Another chat with the same game id does not get this seed from memory cache
    expect(loadSeed(ME, ME, gid('g-seed'))).toBeUndefined()
    // Another account does not get it either
    expect(loadSeed(PEER, PEER, gid('g-seed'))).toBeUndefined()
    expect(loadSeed('0xOtherAccount', PEER, gid('g-seed'))).toBeUndefined()

    // When not in memory, re-derives from wallet
    const fakeKey =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const mockWallet = {
      identity: {
        toPrivateKeyHex: () => fakeKey,
      },
    }
    const mockedMessagingWallet = messagingWallet as jest.Mock
    mockedMessagingWallet.mockReturnValue(mockWallet)

    const expectedSeed = deriveBlackjackSeed(gid('uncached'), ME, fakeKey)
    const loaded = loadSeed(ME, PEER, gid('uncached'))
    expect(loaded).toBe(expectedSeed)
    // Now it is cached in memory
    expect(loadSeed(ME, PEER, gid('uncached'))).toBe(expectedSeed)

    // newSeed with gameId and own derives deterministically
    expect(newSeed(gid('uncached'), ME)).toBe(expectedSeed)

    mockedMessagingWallet.mockReturnValue(undefined)
    expect(newSeed()).toMatch(/^[0-9a-f]{64}$/)
    expect(newSeed()).not.toBe(newSeed())
    expect(newGameId()).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('automatic dealer steps', () => {
  const opened = (gameId: string) => [
    message(
      true,
      {
        action: 'challenge',
        role: 'dealer',
        maxBetWei: '500',
        commitment: commitmentOf(SEED),
      },
      10n,
      gameId,
    ),
    message(false, { action: 'bet' }, 300n, gameId),
  ]

  it('deals without asking when this user is the dealer and holds the seed', () => {
    saveSeed(ME, PEER, gid('auto'), SEED)
    const messages = opened(gid('auto'))
    const steps = automaticDealerSteps(messages, ME, PEER)
    expect(steps).toHaveLength(1)
    expect(steps[0].item.action).toBe('deal')
    // Once the deal is in the chat (even while it is still sending) nothing more is offered.
    messages.push({
      ...message(true, {}, 10n, gid('auto')),
      items: [steps[0].item],
      payloadDigest: 'pending:1',
    })
    expect(automaticDealerSteps(messages, ME, PEER)).toEqual([])
  })

  it('never sends a paying message automatically', () => {
    saveSeed(ME, PEER, gid('pay'), SEED)
    // A bet above the max: the dealer owes a refund, which needs the dealer's confirmation.
    const messages = [
      opened(gid('pay'))[0],
      message(false, { action: 'bet' }, 501n, gid('pay')),
    ]
    const [hand] = chatHands(messages, ME, PEER)
    expect(dealerStep(hand.state, SEED)).toMatchObject({
      item: { action: 'refund' },
      payWei: 501n,
    })
    expect(automaticDealerSteps(messages, ME, PEER)).toEqual([])
  })

  it('stands on a natural without asking when this user is the player', () => {
    // The dealer's links for the first cards are in; only the player can see the cards.
    const play = (seed: string, gameId: string) => {
      saveSeed(ME, PEER, gameId, seed)
      const messages = [
        message(
          false,
          {
            action: 'challenge',
            role: 'dealer',
            maxBetWei: '500',
            commitment: commitmentOf(SEED),
          },
          10n,
          gameId,
        ),
      ]
      const state = () => chatHands(messages, ME, PEER)[0].state
      messages.push(message(true, { ...buildBet(state(), seed) }, 300n, gameId))
      messages.push(
        message(false, { ...dealerStep(state(), SEED)?.item }, 10n, gameId),
      )
      return { messages, cards: handView(state(), seed).playerCards }
    }
    let natural: ReturnType<typeof play> | undefined
    let plain: ReturnType<typeof play> | undefined
    for (let i = 0; i < 2000 && !(natural && plain); i++) {
      const hand = play(i.toString(16).padStart(64, '0'), gid(`n${i}`))
      if (handValue(hand.cards).blackjack) natural ??= hand
      else plain ??= hand
    }
    const steps = automaticDealerSteps(natural!.messages, ME, PEER)
    expect(steps.map(step => step.item.action)).toEqual(['stand'])
    // Any other hand is the player's to play.
    expect(automaticDealerSteps(plain!.messages, ME, PEER)).toEqual([])
  })

  it('does nothing as the player before the deal, or as a dealer without the seed', () => {
    saveSeed(ME, PEER, gid('mine'), SEED)
    const asPlayer = [
      message(
        false,
        {
          action: 'challenge',
          role: 'dealer',
          maxBetWei: '500',
          commitment: commitmentOf(SEED),
        },
        10n,
        gid('mine'),
      ),
      message(true, { action: 'bet' }, 300n, gid('mine')),
    ]
    expect(automaticDealerSteps(asPlayer, ME, PEER)).toEqual([])
    expect(automaticDealerSteps(opened(gid('no-seed')), ME, PEER)).toEqual([])
  })
})

describe('a paying message is sent once across tabs', () => {
  const GAME = gid('tabs')
  // This user deals; the player bet above the max, so a refund of 501 is owed.
  const memory = () => [
    message(
      true,
      {
        action: 'challenge',
        role: 'dealer',
        maxBetWei: '500',
        commitment: commitmentOf(SEED),
      },
      10n,
      GAME,
    ),
    { ...message(false, { action: 'bet' }, 501n, GAME), payloadDigest: 'over' },
  ]
  const refund = {
    type: 'blackjack-hand',
    gameId: GAME,
    action: 'refund',
    ref: 'over',
    seq: 1,
    prev: '0'.repeat(64),
  } as const
  const ask = (
    stored: HandChatMessage[],
    inMemory = memory(),
    item: Parameters<typeof handItemStillNext>[0]['item'] = refund,
    stampWei = 501n,
  ) =>
    handItemStillNext({
      item,
      stampWei,
      own: ME,
      peer: PEER,
      memory: inMemory,
      stored: async () => stored,
    })

  it('allows the refund while nothing has been sent for it', async () => {
    expect(await ask([])).toBe(true)
    // Messages already in memory are not counted twice.
    expect(await ask(memory())).toBe(true)
  })

  it.each(['pending', 'error', 'confirmed'])(
    'refuses it when another tab already saved that refund (%s)',
    async status => {
      const other = {
        ...message(true, refund, 501n, GAME),
        status,
        payloadDigest: 'pending:other-tab',
      }
      expect(await ask([other])).toBe(false)
    },
  )

  it('refuses it when this tab already has that refund in the chat', async () => {
    expect(
      await ask([], [...memory(), message(true, refund, 501n, GAME)]),
    ).toBe(false)
  })

  it('refuses a second deal, card or bet the same way', async () => {
    const asPlayer = [
      message(
        false,
        {
          action: 'challenge',
          role: 'dealer',
          maxBetWei: '500',
          commitment: commitmentOf(SEED),
        },
        10n,
        GAME,
      ),
    ]
    const bet = message(true, { action: 'bet' }, 300n, GAME)
      .items[0] as HandItem
    expect(await ask([], asPlayer, bet, 300n)).toBe(true)
    expect(
      await ask([message(true, bet, 300n, GAME)], asPlayer, bet, 300n),
    ).toBe(false)
  })

  it('refuses when the saved messages cannot be read', async () => {
    await expect(
      handItemStillNext({
        item: refund,
        stampWei: 501n,
        own: ME,
        peer: PEER,
        memory: memory(),
        stored: async () => {
          throw new Error('storage unavailable')
        },
      }),
    ).resolves.toBe(false)
  })
})

describe('own hand messages the other side does not have', () => {
  const seed = SEED
  const dealt = (): HandChatMessage[] => {
    const messages: HandChatMessage[] = [
      {
        ...message(true, {
          action: 'challenge',
          role: 'dealer',
          maxBetWei: '500',
          commitment: commitmentOf(seed),
        }),
        status: 'confirmed',
      },
      { ...message(false, { action: 'bet' }, 300n), status: 'confirmed' },
    ]
    return messages
  }
  const withDeal = (fields: Partial<HandChatMessage>) => {
    const messages = dealt()
    const [hand] = chatHands(messages, ME, PEER)
    const step = dealerStep(hand.state, seed)
    if (!step) throw new Error('no deal')
    messages.push({
      ...message(true, step.item as unknown as Record<string, unknown>),
      ...fields,
    })
    return messages
  }
  const store = () => ({
    retryOutgoing: jest.fn(async () => ({ state: 'sent' })),
    resumeOutgoing: jest.fn(async () => ({ state: 'payment-pending' })),
  })

  it('lists a cut-off deal as failed and free, and nothing once it is delivered', () => {
    const messages = withDeal({
      status: 'error',
      delivery: { failureReason: 'interrupted' },
    })
    expect(undeliveredHandMessages(messages, ME, PEER)).toEqual([
      {
        payloadDigest: messages[2].payloadDigest,
        action: 'deal',
        state: 'failed',
        hasAttempt: false,
        carriesMoney: false,
      },
    ])
    messages[2].status = 'confirmed'
    expect(undeliveredHandMessages(messages, ME, PEER)).toEqual([])
    // The other side's messages and other kinds of message are never listed.
    expect(
      undeliveredHandMessages(
        [
          { ...message(false, { action: 'bet' }, 300n), status: 'error' },
          {
            outbound: true,
            status: 'error',
            items: [{ type: 'text', text: 'hi' }],
            payloadDigest: 'x',
          },
        ],
        ME,
        PEER,
      ),
    ).toEqual([])
  })

  it('knows which messages carry money: bet, double, refund, and a reveal that owes something', () => {
    const own = (fields: Record<string, unknown>, stamp = 10n) => ({
      ...message(true, fields, stamp),
      status: 'error',
    })
    const listed = undeliveredHandMessages(
      [
        own({ action: 'bet' }, 300n),
        own({ action: 'double' }, 300n),
        own({ action: 'refund', ref: 'aa'.repeat(32) }, 300n),
        own({ action: 'hit' }),
        own({ action: 'stand' }),
        own({ action: 'challenge', role: 'player', maxBetWei: '5' }),
      ],
      ME,
      PEER,
    )
    expect(listed.map(m => [m.action, m.carriesMoney])).toEqual([
      ['bet', true],
      ['double', true],
      ['refund', true],
      ['hit', false],
      ['stand', false],
      ['challenge', false],
    ])
  })

  it('sends a cut-off deal again without asking, once per page session', async () => {
    const messages = withDeal({
      status: 'error',
      delivery: { failureReason: 'interrupted' },
    })
    const s = store()
    const attempted = new Set<string>()
    const run = () =>
      resumeHandMessages({
        store: s,
        wallet: 'w',
        address: PEER,
        own: ME,
        messages,
        attempted,
        ordinaryStampWei: 10n,
      })
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    expect(await run()).toBe(1)
    expect(s.retryOutgoing).toHaveBeenCalledWith({
      wallet: 'w',
      address: PEER,
      payloadDigest: messages[2].payloadDigest,
      automatic: true,
    })
    // A stable line the e2e driver asserts on.
    expect(info).toHaveBeenCalledWith(
      `blackjack: resending undelivered deal ${messages[2].payloadDigest}`,
    )
    info.mockRestore()
    expect(await run()).toBe(0)
    expect(s.retryOutgoing).toHaveBeenCalledTimes(1)
    expect(s.resumeOutgoing).not.toHaveBeenCalled()
  })

  it('leaves a message that is still being sent alone', async () => {
    const s = store()
    for (const status of ['pending', 'payment-pending']) {
      expect(
        await resumeHandMessages({
          store: s,
          wallet: 'w',
          address: PEER,
          own: ME,
          messages: withDeal({ status }),
          attempted: new Set(),
          ordinaryStampWei: 10n,
        }),
      ).toBe(0)
    }
    expect(s.retryOutgoing).not.toHaveBeenCalled()
  })

  it('only settles a failed bet that has a recorded payment, and never sends one that has none', async () => {
    const bet = (delivery: HandChatMessage['delivery']): HandChatMessage[] => [
      {
        ...message(false, {
          action: 'challenge',
          role: 'dealer',
          maxBetWei: '500',
          commitment: commitmentOf(seed),
        }),
        status: 'confirmed',
      },
      { ...message(true, { action: 'bet' }, 300n), status: 'error', delivery },
    ]
    const s = store()
    const recorded = bet({ attemptDigest: 'cd'.repeat(32) })
    expect(
      await resumeHandMessages({
        store: s,
        wallet: 'w',
        address: PEER,
        own: ME,
        messages: recorded,
        attempted: new Set(),
        ordinaryStampWei: 10n,
      }),
    ).toBe(1)
    expect(s.resumeOutgoing).toHaveBeenCalledWith({
      wallet: 'w',
      address: PEER,
      payloadDigest: recorded[1].payloadDigest,
    })
    expect(
      await resumeHandMessages({
        store: s,
        wallet: 'w',
        address: PEER,
        own: ME,
        messages: bet({ failureReason: 'interrupted' }),
        attempted: new Set(),
        ordinaryStampWei: 10n,
      }),
    ).toBe(0)
    expect(s.resumeOutgoing).toHaveBeenCalledTimes(1)
    expect(s.retryOutgoing).not.toHaveBeenCalled()
  })

  it('a resume that throws leaves the rest to be tried', async () => {
    const messages = withDeal({ status: 'error' })
    const s = store()
    s.retryOutgoing.mockRejectedValueOnce(new Error('wallet closed'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(
      await resumeHandMessages({
        store: s,
        wallet: 'w',
        address: PEER,
        own: ME,
        messages,
        attempted: new Set(),
        ordinaryStampWei: 10n,
      }),
    ).toBe(0)
    warn.mockRestore()
  })

  const resumeOnce = (
    s: ReturnType<typeof store>,
    messages: HandChatMessage[],
    attempted = new Set<string>(),
  ) =>
    resumeHandMessages({
      store: s,
      wallet: 'w',
      address: PEER,
      own: ME,
      messages,
      attempted,
      ordinaryStampWei: 10n,
    })

  describe('with Web Locks', () => {
    let locks: FakeLockManager
    let uninstall: () => void
    beforeEach(() => {
      locks = new FakeLockManager()
      uninstall = locks.install()
      jest.spyOn(console, 'info').mockImplementation(() => undefined)
    })
    afterEach(() => {
      uninstall()
      jest.restoreAllMocks()
    })

    it('leaves a message another tab is sending alone, uncounted, and resumes it once that tab let go', async () => {
      const messages = withDeal({
        status: 'error',
        delivery: { failureReason: 'interrupted' },
      })
      const digest = messages[2].payloadDigest
      const release = locks.hold(outgoingLockName(digest))
      const s = store()
      const attempted = new Set<string>()
      expect(await resumeOnce(s, messages, attempted)).toBe(0)
      expect(s.retryOutgoing).not.toHaveBeenCalled()
      expect(attempted.size).toBe(0)
      release()
      await new Promise(resolve => setImmediate(resolve))
      expect(await resumeOnce(s, messages, attempted)).toBe(1)
      expect(s.retryOutgoing).toHaveBeenCalledTimes(1)
    })

    it('a resume the store reports busy is not counted and may be tried again', async () => {
      const messages = withDeal({
        status: 'error',
        delivery: { failureReason: 'interrupted' },
      })
      const s = store()
      s.retryOutgoing.mockResolvedValueOnce({ state: 'busy' })
      const attempted = new Set<string>()
      expect(await resumeOnce(s, messages, attempted)).toBe(0)
      expect(await resumeOnce(s, messages, attempted)).toBe(1)
      expect(s.retryOutgoing).toHaveBeenCalledTimes(2)
    })
  })

  describe('only the last own move of a hand that is still going is resumed by itself', () => {
    beforeEach(() =>
      jest.spyOn(console, 'info').mockImplementation(() => undefined),
    )
    afterEach(() => jest.restoreAllMocks())
    const failed = {
      status: 'error',
      delivery: { failureReason: 'interrupted' },
    }

    it('never re-sends a challenge or an accept by itself, but still lists it (the bubble keeps Retry)', async () => {
      const challenge: HandChatMessage = {
        ...message(
          true,
          {
            action: 'challenge',
            role: 'dealer',
            maxBetWei: '500',
            commitment: commitmentOf(seed),
          },
          10n,
          gid('c1'),
        ),
        ...failed,
      }
      const accept: HandChatMessage[] = [
        {
          ...message(
            false,
            { action: 'challenge', role: 'player', maxBetWei: '500' },
            10n,
            gid('a1'),
          ),
          status: 'confirmed',
        },
        {
          ...message(
            true,
            {
              action: 'accept',
              maxBetWei: '500',
              commitment: commitmentOf(seed),
            },
            10n,
            gid('a1'),
          ),
          ...failed,
        },
      ]
      const s = store()
      for (const messages of [[challenge], accept]) {
        expect(undeliveredHandMessages(messages, ME, PEER)).toEqual([
          expect.objectContaining({ state: 'failed', carriesMoney: false }),
        ])
        expect(await resumeOnce(s, messages)).toBe(0)
      }
      expect(s.retryOutgoing).not.toHaveBeenCalled()
    })

    it('does not resume an own message that a later own message of the hand overtook', async () => {
      const messages = withDeal(failed)
      messages.push({
        ...message(true, { action: 'card', card: 7 }),
        status: 'confirmed',
      })
      const s = store()
      expect(await resumeOnce(s, messages)).toBe(0)
      expect(s.retryOutgoing).not.toHaveBeenCalled()
    })

    it('does not resume a message of a hand that is over without it (refunded)', async () => {
      const messages = dealt()
      const betDigest = messages[1].payloadDigest
      messages.push(
        {
          ...message(true, { action: 'refund', ref: betDigest }, 300n),
          status: 'confirmed',
        },
        {
          ...message(true, {
            action: 'deal',
            playerCards: [1, 2],
            dealerUpCard: 3,
          }),
          ...failed,
        },
      )
      expect(chatHands(messages.slice(0, 3), ME, PEER)[0].state.phase).toBe(
        'refunded',
      )
      const s = store()
      expect(await resumeOnce(s, messages)).toBe(0)
      expect(s.retryOutgoing).not.toHaveBeenCalled()
    })

    it('does not resume a message with no hand behind it', async () => {
      const s = store()
      expect(
        await resumeOnce(s, [
          { ...message(true, { action: 'stand' }), ...failed },
        ]),
      ).toBe(0)
      expect(s.retryOutgoing).not.toHaveBeenCalled()
    })
  })

  it('a hand message with more than an ordinary stamp carries money: it is never re-sent, only settled', async () => {
    // A reveal folded as owing nothing, or any other step, sent with more than the ordinary stamp.
    const messages = withDeal({
      status: 'error',
      delivery: { failureReason: 'interrupted' },
    })
    messages[2].stampValueWei = 500n
    expect(undeliveredHandMessages(messages, ME, PEER, 10n)).toEqual([
      expect.objectContaining({ action: 'deal', carriesMoney: true }),
    ])
    // A reveal the hand folds as owing nothing is free with an ordinary stamp, money above it.
    const owesNothing = (): HandChatMessage[] => {
      for (let i = 0; i < 256; i++) {
        const s = i.toString(16).padStart(2, '0').repeat(32)
        const game = gid(`r${i}`)
        const rows: HandChatMessage[] = [
          message(
            true,
            {
              action: 'challenge',
              role: 'dealer',
              maxBetWei: '500',
              commitment: commitmentOf(s),
            },
            10n,
            game,
          ),
          message(false, { action: 'bet' }, 300n, game),
        ]
        let iterations = 0
        for (;;) {
          if (++iterations > 20) break
          const state = chatHands(rows, ME, PEER)[0].state
          const step = dealerStep(state, s)
          if (!step && state.phase === 'player_turn') {
            const stand = playerStep(state, 'stand', PLAYER_SEED)
            if (!stand) break
            rows.push(
              message(
                false,
                stand as unknown as Record<string, unknown>,
                10n,
                game,
              ),
            )
            continue
          }
          if (!step) break
          if (step.item.action === 'reveal') {
            if (step.payWei !== undefined) break
            rows.push({
              ...message(
                true,
                step.item as unknown as Record<string, unknown>,
                10n,
                game,
              ),
              status: 'error',
            })
            return rows
          }
          rows.push(
            message(
              true,
              step.item as unknown as Record<string, unknown>,
              10n,
              game,
            ),
          )
        }
      }
      throw new Error('no seed gives a reveal that owes nothing')
    }
    const revealed = owesNothing()
    expect(undeliveredHandMessages(revealed, ME, PEER, 10n)).toEqual([
      expect.objectContaining({ action: 'reveal', carriesMoney: false }),
    ])
    revealed[revealed.length - 1].stampValueWei = 500n
    expect(undeliveredHandMessages(revealed, ME, PEER, 10n)).toEqual([
      expect.objectContaining({ action: 'reveal', carriesMoney: true }),
    ])
    const s = store()
    expect(await resumeOnce(s, messages)).toBe(0)
    expect(s.retryOutgoing).not.toHaveBeenCalled()
    expect(s.resumeOutgoing).not.toHaveBeenCalled()
  })

  it('no automatic dealer step for a hand while an own message of it is not delivered', () => {
    saveSeed(ME, PEER, gid('g1'), seed)
    // An own message of the hand that the fold does not advance on (a dealer cannot stand), so
    // the deal would still be the next step: it waits until that message is delivered.
    const withOwn = (status: string) => [
      ...dealt(),
      { ...message(true, { action: 'stand' }), status },
    ]
    expect(automaticDealerSteps(withOwn('confirmed'), ME, PEER)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ action: 'deal' }),
      }),
    ])
    for (const status of ['error', 'pending', 'payment-pending']) {
      expect(automaticDealerSteps(withOwn(status), ME, PEER)).toEqual([])
    }
    // Another hand's undelivered message does not hold this one up.
    const other = {
      ...message(true, { action: 'stand' }, 10n, gid('g2')),
      status: 'error',
    }
    expect(automaticDealerSteps([...dealt(), other], ME, PEER)).toHaveLength(1)
  })
})
