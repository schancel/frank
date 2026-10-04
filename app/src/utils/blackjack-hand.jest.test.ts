import {
  commitmentOf,
  dealerStep,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  automaticDealerSteps,
  chatHandEvents,
  chatHands,
  handItemStillNext,
  loadSeed,
  newGameId,
  newSeed,
  saveSeed,
  type HandChatMessage,
} from './blackjack-hand'

const ME = '0x1111111111111111111111111111111111111111'
const PEER = '0x2222222222222222222222222222222222222222'
const SEED = 'ab'.repeat(32)
/** A well-formed game id (32 lowercase hex characters) for a readable name. */
const gid = (name: string) =>
  Array.from(name, c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32)
let n = 0
const message = (
  outbound: boolean,
  fields: Record<string, unknown>,
  stampValueWei = 10n,
  gameId = gid('g1'),
): HandChatMessage => ({
  outbound,
  items: [{ type: 'blackjack-hand', gameId, ...fields } as MessageItem],
  stampValueWei,
  payloadDigest: (++n).toString(16).padStart(64, '0'),
})

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
      type: 'blackjack-hand',
      gameId: gid('y'),
      action: 'bet',
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

describe('dealer seeds on this device', () => {
  it('keeps a seed for the page session when storage is unavailable', () => {
    saveSeed(ME, PEER, gid('session-only'), SEED)
    expect(loadSeed(ME, PEER, gid('session-only'))).toBe(SEED)
  })

  it('saves and loads a seed, and makes fresh ones', () => {
    const stored = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
    })
    expect(loadSeed(ME, PEER, gid('nope'))).toBeUndefined()
    saveSeed(ME, PEER, gid('g-seed'), SEED)
    expect(loadSeed(ME, PEER, gid('g-seed'))).toBe(SEED)
    expect(
      stored.get(
        `frank.blackjack.seed.${ME.toLowerCase()}|${PEER.toLowerCase()}|${gid(
          'g-seed',
        )}`,
      ),
    ).toBe(SEED)
    // Another chat with the same game id does not get this seed.
    expect(loadSeed(ME, ME, gid('g-seed'))).toBeUndefined()
    // Another account on this browser does not get it either.
    expect(loadSeed(PEER, PEER, gid('g-seed'))).toBeUndefined()
    expect(loadSeed('0xOtherAccount', PEER, gid('g-seed'))).toBeUndefined()
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

  it('does nothing as the player, or as a dealer without the seed', () => {
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
    const bet = { type: 'blackjack-hand', gameId: GAME, action: 'bet' } as const
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
