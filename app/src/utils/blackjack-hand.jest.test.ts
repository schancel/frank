import {
  commitmentOf,
  dealerStep,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  automaticDealerSteps,
  chatHandEvents,
  chatHands,
  loadSeed,
  newGameId,
  newSeed,
  saveSeed,
  type HandChatMessage,
} from './blackjack-hand'

const ME = '0x1111111111111111111111111111111111111111'
const PEER = '0x2222222222222222222222222222222222222222'
const SEED = 'ab'.repeat(32)
let n = 0
const message = (
  outbound: boolean,
  fields: Record<string, unknown>,
  stampValueWei = 10n,
  gameId = 'g1',
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
    expect(chatHandEvents(messages, ME, PEER, 'other')).toEqual([])
  })

  it('credits nothing when one message carries more than one hand item', () => {
    const challenge = (gameId: string) =>
      message(false, { action: 'challenge', role: 'dealer', maxBetWei: '500', commitment: commitmentOf(SEED) }, 10n, gameId)
    const double = message(true, { action: 'bet' }, 500n, 'x')
    double.items.push({ type: 'blackjack-hand', gameId: 'y', action: 'bet' } as MessageItem)
    const hands = chatHands([challenge('x'), challenge('y'), double], ME, PEER)
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
        'a',
      ),
      message(
        false,
        { action: 'challenge', role: 'player', maxBetWei: '7' },
        10n,
        'b',
      ),
      message(false, { action: 'bet' }, 5n, 'a'),
    ]
    const hands = chatHands(messages, ME, PEER)
    expect(
      hands.map(h => [h.state.gameId, h.state.phase, h.state.player]),
    ).toEqual([
      ['a', 'challenged', ME],
      ['b', 'challenged', PEER],
    ])
    // The peer's stray bet on a hand where it is the dealer is simply rejected.
    expect(hands[0].rejected).toEqual(['wrong-sender'])
  })
})

describe('dealer seeds on this device', () => {
  it('keeps a seed for the page session when storage is unavailable', () => {
    saveSeed(PEER, 'session-only', SEED)
    expect(loadSeed(PEER, 'session-only')).toBe(SEED)
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
    expect(loadSeed(PEER, 'nope')).toBeUndefined()
    saveSeed(PEER, 'g-seed', SEED)
    expect(loadSeed(PEER, 'g-seed')).toBe(SEED)
    expect(stored.get(`frank.blackjack.seed.${PEER}|g-seed`)).toBe(SEED)
    // Another chat with the same game id does not get this seed.
    expect(loadSeed(ME, 'g-seed')).toBeUndefined()
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
    saveSeed(PEER, 'auto', SEED)
    const messages = opened('auto')
    const steps = automaticDealerSteps(messages, ME, PEER)
    expect(steps).toHaveLength(1)
    expect(steps[0].item.action).toBe('deal')
    // Once the deal is in the chat (even while it is still sending) nothing more is offered.
    messages.push({
      ...message(true, {}, 10n, 'auto'),
      items: [steps[0].item],
      payloadDigest: 'pending:1',
    })
    expect(automaticDealerSteps(messages, ME, PEER)).toEqual([])
  })

  it('never sends a paying message automatically', () => {
    saveSeed(PEER, 'pay', SEED)
    // A bet above the max: the dealer owes a refund, which needs the dealer's confirmation.
    const messages = [
      opened('pay')[0],
      message(false, { action: 'bet' }, 501n, 'pay'),
    ]
    const [hand] = chatHands(messages, ME, PEER)
    expect(dealerStep(hand.state, SEED)).toMatchObject({
      item: { action: 'refund' },
      payWei: 501n,
    })
    expect(automaticDealerSteps(messages, ME, PEER)).toEqual([])
  })

  it('does nothing as the player, or as a dealer without the seed', () => {
    saveSeed(PEER, 'mine', SEED)
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
        'mine',
      ),
      message(true, { action: 'bet' }, 300n, 'mine'),
    ]
    expect(automaticDealerSteps(asPlayer, ME, PEER)).toEqual([])
    expect(automaticDealerSteps(opened('no-seed'), ME, PEER)).toEqual([])
  })
})
