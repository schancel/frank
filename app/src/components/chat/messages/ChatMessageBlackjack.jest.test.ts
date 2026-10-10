/** @jest-environment jsdom */
// The blackjack bubble: each message says what it was, and the LATEST message of a hand shows the
// buttons valid for the viewer's role in the hand's current state. Every amount of money a button
// sends is the stamp of the message it sends.
import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive, ref } from 'vue'

import {
  buildBet,
  commitmentOf,
  dealerStep,
  foldHand,
  handView,
  playerStep,
  type HandEvent,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import {
  cardLabel,
  handValue,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  CHAIN_LENGTH,
  entropyChain,
} from '@frank/wallet/message-item-plugins/blackjack/entropy'
import enUS from '../../../i18n/en-us'
import {
  HAND_FEE_RESERVE_WEI,
  loadSeed,
  saveSeed,
} from '../../../utils/blackjack-hand'
import ChatMessageBlackjack from './ChatMessageBlackjack.vue'

const ME = '0xMe'
const PEER = '0xPeer'
const RESERVE = HAND_FEE_RESERVE_WEI
jest.mock('../../../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
}))
const store: { activeConversation: { messages: any[] } } = reactive({
  activeConversation: { messages: [] },
}) as any
jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))
const mockBalance = ref<bigint | null>(null)
jest.mock('../../../composables/useBalance', () => ({
  useBalance: () => ({ balance: mockBalance }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n,
    toDisplayAmount: (n: bigint) => n.toString(),
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))

const stubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [
      n,
      defineComponent({
        setup:
          (_, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
    ]),
)
stubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null },
  setup:
    (props, { attrs }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label as string,
      ),
})
stubs.QInput = defineComponent({
  inheritAttrs: false,
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (e: Event) =>
          emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
})
const t = (key: string, params: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<any>((o, k) => o?.[k], enUS) as string
  return String(text ?? key).replace(/\{(\w+)\}/g, (_, name) =>
    String(params[name]),
  )
}

const GAME = '0123456789abcdef0123456789abcdef'
const BET_DIGEST = 'be'.repeat(32)
let n = 0
type Row = {
  outbound: boolean
  item: Record<string, unknown>
  stamp?: bigint
  digest?: string
  status?: string
}
const toMessage = (row: Row) => ({
  outbound: row.outbound,
  status: row.status ?? 'confirmed',
  items: [{ type: 'blackjack-hand', gameId: GAME, ...row.item }],
  stampValueWei: row.stamp ?? 10n,
  payloadDigest: row.digest ?? `m${++n}`,
})
/** The fold of a list of stored messages, as the component computes it. */
const eventsOf = (messages: ReturnType<typeof toMessage>[]): HandEvent[] =>
  messages.map(m => ({
    item: m.items[0] as HandEvent['item'],
    from: m.outbound ? ME : PEER,
    to: m.outbound ? PEER : ME,
    stampWei: m.stampValueWei,
    digest: m.payloadDigest,
  }))
const stateOf = (messages: ReturnType<typeof toMessage>[]) =>
  foldHand(eventsOf(messages)).state
/** The chain fields of the hand's next message, for a message a test writes by hand. */
const next = (messages: ReturnType<typeof toMessage>[]) => {
  const state = stateOf(messages) as HandState
  return { seq: state.count, prev: state.head }
}

/** The dealer's seed in every hand here; the player's seed decides the cards. */
const DEALER = 'd0'.repeat(32)

/** A hand where `dealerIsMe` deals; the player plays with `seed`, its `moves` applied in order.
 * This user's own seed is kept on the device, as the component keeps it. */
function hand(
  dealerIsMe: boolean,
  seed: string,
  wager: bigint,
  moves: ('hit' | 'stand' | 'double')[],
  upTo?: 'reveal',
) {
  const dealer = dealerIsMe ? ME : PEER
  const player = dealerIsMe ? PEER : ME
  saveSeed(ME, PEER, GAME, dealerIsMe ? DEALER : seed)
  const rows: Row[] = []
  const events: HandEvent[] = []
  const push = (
    from: string,
    item: Record<string, unknown>,
    stamp = 10n,
    digest = `m${++n}`,
  ) => {
    rows.push({ outbound: from === ME, item, stamp, digest })
    events.push({
      item: {
        type: 'blackjack-hand',
        gameId: GAME,
        ...item,
      } as HandEvent['item'],
      from,
      to: from === ME ? PEER : ME,
      stampWei: stamp,
      digest,
    })
  }
  const state = () => foldHand(events).state
  const dealerActs = (stopBeforeReveal: boolean) => {
    for (;;) {
      const step = dealerStep(state(), DEALER)
      if (!step || (stopBeforeReveal && step.item.action === 'reveal')) return
      push(
        dealer,
        step.item as unknown as Record<string, unknown>,
        step.payWei ?? 10n,
      )
    }
  }
  push(dealer, {
    action: 'challenge',
    seq: 0,
    role: 'dealer',
    maxBetWei: '1000',
    commitment: commitmentOf(DEALER),
  })
  if (wager > 0n) {
    push(player, { ...buildBet(state(), seed) }, wager, BET_DIGEST)
    dealerActs(true)
    for (const move of moves) {
      const item = playerStep(state(), move, seed)
      if (!item) throw new Error(`cannot ${move}`)
      push(player, { ...item }, move === 'double' ? wager : 10n)
      dealerActs(true)
    }
    if (upTo === 'reveal') dealerActs(false)
  }
  return rows.map(toMessage)
}

/** Finds a player seed whose first two cards, stood on, give the wanted result. */
function seedFor(want: (state: HandState, cards: number[]) => boolean): string {
  for (let i = 1; i < 5000; i++) {
    const seed = i.toString(16).padStart(64, '0')
    const dealt = stateOf(hand(false, seed, 400n, []))
    const cards = handView(dealt, seed).playerCards
    if (handValue(cards).blackjack) {
      if (want(dealt as HandState, cards)) return seed
      continue
    }
    const final = stateOf(
      hand(false, seed, 400n, ['stand'], 'reveal'),
    ) as HandState
    if (want(final, cards)) return seed
  }
  throw new Error('no seed')
}
const WIN = seedFor(state => state.outcome === 'player_win')
const LOSS = seedFor(state => state.outcome === 'dealer_win')
const NATURAL = seedFor((_state, cards) => handValue(cards).blackjack)

function seedForMoves(moves: ('hit' | 'stand' | 'double')[]): string {
  for (let i = 1; i < 5000; i++) {
    const seed = i.toString(16).padStart(64, '0')
    try {
      const final = stateOf(hand(true, seed, 400n, moves, 'reveal'))
      if (final && (final as HandState).phase === 'resolved') return seed
    } catch {
      continue
    }
  }
  throw new Error('no seed for moves')
}
const HIT_SEED = seedForMoves(['hit', 'stand'])

async function mountLast(
  messages: ReturnType<typeof toMessage>[],
  index = messages.length - 1,
) {
  store.activeConversation = { messages }
  const wrapper = mount(ChatMessageBlackjack as never, {
    props: {
      item: messages[index].items[0],
      address: PEER,
      payloadDigest: messages[index].payloadDigest,
    },
    global: { components: stubs, mocks: { $t: t } },
  })
  await flushPromises()
  return wrapper
}
const followUp = (wrapper: Awaited<ReturnType<typeof mountLast>>) =>
  (wrapper.emitted('sendFollowUp') ?? []).map(([payload]) => payload as any)
const button = (wrapper: Awaited<ReturnType<typeof mountLast>>, id: string) =>
  wrapper.find(`[data-testid="blackjack-${id}"]`)

beforeEach(() => {
  store.activeConversation = { messages: [] }
  mockBalance.value = RESERVE + 100_000n
})

describe('the player', () => {
  it('bets from the challenge bubble: the amount is the stamp of the bet message', async () => {
    const wrapper = await mountLast(hand(false, WIN, 0n, []))
    expect(wrapper.find('[data-testid="blackjack-line"]').text()).toContain(
      'the sender deals',
    )
    const input = wrapper.find('[data-testid="blackjack-bet-amount"]')
    // Suggested: the most this user may bet, here the hand's max.
    expect((input.element as HTMLInputElement).value).toBe('1000')
    await input.setValue('400')
    await button(wrapper, 'bet').trigger('click')
    // The bet carries the commitment to a fresh seed of the player's own, kept on this device
    // before it leaves, and its place in the hand's chain.
    const kept = loadSeed(ME, PEER, GAME) as string
    expect(kept).not.toBe(WIN)
    expect(followUp(wrapper)).toEqual([
      {
        items: [
          {
            type: 'blackjack-hand',
            gameId: GAME,
            action: 'bet',
            commitment: commitmentOf(kept),
            seq: 1,
            prev: expect.any(String),
          },
        ],
        stampValueWei: 400n,
        settled: expect.any(Function),
      },
    ])
  })

  it('sees its first cards right after the deal, before the dealer can', async () => {
    const messages = hand(false, WIN, 400n, [])
    // No message carries a card and the hand's shared state has none yet.
    expect(stateOf(messages)).toMatchObject({
      phase: 'player_turn',
      playerCards: [],
    })
    const mine = handView(stateOf(messages), WIN)
    const wrapper = await mountLast(messages)
    expect(wrapper.text()).toContain(mine.playerCards.map(cardLabel).join(' '))
    expect(wrapper.text()).toContain(cardLabel(mine.dealerUpCard as number))
    // The same messages on the dealer's device show no card until the player moves.
    saveSeed(ME, PEER, GAME, DEALER)
    const dealer = await mountLast(
      messages.map(m => ({ ...m, outbound: !m.outbound })),
    )
    expect(dealer.text()).not.toContain(
      mine.playerCards.map(cardLabel).join(' '),
    )
    expect(dealer.find('[data-testid="blackjack-status"]').text()).toContain(
      'player',
    )
  })

  it('opens the link of the card it asks for with a hit, and the rest of its chain to stand', async () => {
    const messages = hand(false, WIN, 400n, [])
    const hit = await mountLast(messages)
    await button(hit, 'hit').trigger('click')
    expect(followUp(hit)[0].items[0]).toEqual({
      type: 'blackjack-hand',
      gameId: GAME,
      action: 'hit',
      link: entropyChain(WIN)[4],
      ...next(messages),
    })
    const stand = await mountLast(messages)
    await button(stand, 'stand').trigger('click')
    expect(followUp(stand)[0].items[0]).toMatchObject({
      action: 'stand',
      link: entropyChain(WIN)[CHAIN_LENGTH],
    })
  })

  it('has no buttons on a natural: standing on it is sent without asking', async () => {
    const wrapper = await mountLast(hand(false, NATURAL, 400n, []))
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).toContain('21')
  })

  it('is told when this device does not hold its seed, and gets no buttons', async () => {
    const messages = hand(false, WIN, 400n, []).map(m => ({
      ...m,
      items: [{ ...m.items[0], gameId: 'e'.repeat(32) }],
    }))
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      'does not hold your seed',
    )
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it.each([
    [
      'above the max bet of the hand',
      '1001',
      RESERVE + 100_000n,
      'above the maximum bet',
    ],
    [
      'more than the player can spend',
      '600',
      RESERVE + 500n,
      'more than you can cover',
    ],
    ['below the minimum stamp', '9', RESERVE + 100_000n, 'minimum stamp'],
    ['not a number', 'lots', RESERVE + 100_000n, 'greater than zero'],
  ])('cannot bet %s', async (_n, amount, balance, message) => {
    mockBalance.value = balance
    const wrapper = await mountLast(hand(false, WIN, 0n, []))
    await wrapper.find('[data-testid="blackjack-bet-amount"]').setValue(amount)
    expect(
      wrapper.find('[data-testid="blackjack-amount-error"]').text(),
    ).toContain(message)
    expect(button(wrapper, 'bet').attributes('disabled')).toBeDefined()
    await button(wrapper, 'bet').trigger('click')
    expect(followUp(wrapper)).toEqual([])
  })

  it('cannot bet while the balance is unknown', async () => {
    mockBalance.value = null
    const wrapper = await mountLast(hand(false, WIN, 0n, []))
    expect(button(wrapper, 'bet').attributes('disabled')).toBeDefined()
  })

  it('gets hit, stand and double on its turn; double sends the wager again as its stamp', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, []))
    expect(wrapper.find('[data-testid="blackjack-wager"]').text()).toContain(
      '400 MON',
    )
    expect(button(wrapper, 'hit').exists()).toBe(true)
    expect(button(wrapper, 'stand').exists()).toBe(true)
    expect(button(wrapper, 'double').text()).toContain('400 MON')
    await button(wrapper, 'double').trigger('click')
    expect(followUp(wrapper)[0]).toMatchObject({
      items: [{ type: 'blackjack-hand', gameId: GAME, action: 'double' }],
      stampValueWei: 400n,
    })
    // While that move is on its way every button is visibly disabled and a second click sends nothing.
    await wrapper.vm.$nextTick()
    expect(button(wrapper, 'hit').attributes('disabled')).toBeDefined()
    await button(wrapper, 'hit').trigger('click')
    expect(followUp(wrapper)).toHaveLength(1)
  })

  it('sends hit and stand with the ordinary stamp', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, []))
    await button(wrapper, 'stand').trigger('click')
    expect(followUp(wrapper)[0].items[0].action).toBe('stand')
    expect(followUp(wrapper)[0].stampValueWei).toBeUndefined()
  })

  it('cannot double without the money for a second wager', async () => {
    mockBalance.value = RESERVE + 399n
    const wrapper = await mountLast(hand(false, WIN, 400n, []))
    expect(button(wrapper, 'double').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'hit').attributes('disabled')).toBeUndefined()
  })

  it('has its buttons disabled while a message of the chat is still sending', async () => {
    const messages = hand(false, WIN, 400n, [])
    const wrapper = await mountLast(messages)
    store.activeConversation.messages.push({
      outbound: true,
      status: 'pending',
      items: [{ type: 'text', text: 'hi' }],
      payloadDigest: 'pending:1',
    })
    await wrapper.vm.$nextTick()
    expect(button(wrapper, 'hit').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'stand').attributes('disabled')).toBeDefined()
  })

  it('waits, with no buttons, while it is the dealer’s turn', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, ['stand']))
    expect(wrapper.find('[data-testid="blackjack-status"]').text()).toContain(
      'reveal and pay',
    )
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('sees a win and what the dealer paid', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, ['stand'], 'reveal'))
    expect(wrapper.find('[data-testid="blackjack-outcome"]').text()).toBe(
      'You win.',
    )
    expect(wrapper.find('[data-testid="blackjack-payout"]').text()).toBe(
      'The dealer paid 800 MON.',
    )
    expect(button(wrapper, 'play-again').exists()).toBe(true)
    await button(wrapper, 'play-again').trigger('click')
    expect(wrapper.emitted('playAgain')).toHaveLength(1)
  })

  it('shows a resolved hand as rows of card chips with totals and a result block', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, ['stand'], 'reveal'))
    const rows = wrapper.findAll('[data-testid="blackjack-row"]')
    expect(rows).toHaveLength(2)
    // Dealer over player, each a sentence for screen readers plus its chips and total.
    expect(rows[0].find('.q-sr-only').text()).toMatch(/^Dealer: .+ \(\d+\)$/)
    expect(rows[1].find('.q-sr-only').text()).toMatch(/^Player: .+ \(\d+\)$/)
    for (const row of rows) {
      expect(
        row.findAll('[data-testid="blackjack-card"]').length,
      ).toBeGreaterThanOrEqual(2)
      expect(row.find('[data-testid="blackjack-card-back"]').exists()).toBe(
        false,
      )
    }
    const total = wrapper.get('[data-testid="blackjack-player-total"]').text()
    expect(rows[1].find('.q-sr-only').text()).toContain(`(${total})`)
    const result = wrapper.get('.bj-result')
    expect(result.classes()).toContain('bj-result--win')
    expect(result.find('[data-testid="blackjack-outcome"]').exists()).toBe(true)
    expect(result.find('[data-testid="blackjack-payout"]').exists()).toBe(true)
  })

  it('shows the dealer one card and one face-down card while the hand is open', async () => {
    const wrapper = await mountLast(hand(false, WIN, 400n, []))
    const dealer = wrapper.findAll('[data-testid="blackjack-row"]')[0]
    expect(dealer.find('.q-sr-only').text()).toContain('Dealer shows:')
    expect(dealer.findAll('[data-testid="blackjack-card"]')).toHaveLength(1)
    expect(dealer.findAll('[data-testid="blackjack-card-back"]')).toHaveLength(
      1,
    )
    expect(
      wrapper.find('[data-testid="blackjack-dealer-total"]').exists(),
    ).toBe(false)
  })

  it('sees a short payment as such', async () => {
    const messages = hand(false, WIN, 400n, ['stand'], 'reveal')
    messages[messages.length - 1].stampValueWei = 10n
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-payout"]').text()).toBe(
      'The dealer owed 800 MON but paid 10 MON.',
    )
  })

  it('is told when the dealer owes a refund', async () => {
    const messages = hand(false, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: true,
        item: { ...buildBet(stateOf(messages), WIN) },
        stamp: 1001n,
      }),
    )
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      '1001 MON',
    )
  })

  it('still sees a refund as owed when the dealer sent only part of it', async () => {
    const messages = hand(false, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: true,
        item: { ...buildBet(stateOf(messages), WIN) },
        stamp: 1001n,
        digest: 'over',
      }),
      toMessage({
        outbound: false,
        item: { action: 'refund', ref: 'over', ...next(messages) },
        stamp: 1n,
      }),
    )
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      '1000 MON',
    )
  })

  it('sees a bet that was returned short as short', async () => {
    const messages = hand(false, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: true,
        item: { ...buildBet(stateOf(messages), WIN) },
        stamp: 400n,
        digest: BET_DIGEST,
      }),
      toMessage({
        outbound: false,
        item: { action: 'refund', ref: BET_DIGEST, seq: 2, prev: BET_DIGEST },
        stamp: 3n,
      }),
    )
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-refunded"]').text()).toBe(
      'The dealer returned the bet (3 MON).',
    )
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      '397 MON',
    )
  })

  it('is told when the dealer’s reveal does not match its commitment', async () => {
    const messages = hand(false, WIN, 400n, ['stand'])
    const honest = dealerStep(stateOf(messages), DEALER)!
    // A link of another chain: it would give other cards than the ones committed to.
    messages.push(
      toMessage({
        outbound: false,
        item: { ...honest.item, link: 'f'.repeat(64) } as never,
        stamp: 800n,
      }),
    )
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      'does not match its commitment',
    )
    expect(wrapper.find('[data-testid="blackjack-outcome"]').exists()).toBe(
      false,
    )
  })
})

describe('the dealer', () => {
  it('accepts a player’s challenge with a max bet it can cover, and keeps the seed', async () => {
    // Four times the bet must be spendable: 2000 above the reserve covers a max bet of 500.
    mockBalance.value = RESERVE + 2_000n
    const wrapper = await mountLast([
      toMessage({
        outbound: false,
        item: {
          action: 'challenge',
          seq: 0,
          role: 'player',
          maxBetWei: '1000',
        },
      }),
    ])
    expect(wrapper.find('[data-testid="blackjack-line"]').text()).toContain(
      'you deal',
    )
    const input = wrapper.find('[data-testid="blackjack-accept-max"]')
    expect((input.element as HTMLInputElement).value).toBe('500')
    await input.setValue('501')
    expect(
      wrapper.find('[data-testid="blackjack-amount-error"]').text(),
    ).toContain('at most 500 MON')
    expect(button(wrapper, 'accept').attributes('disabled')).toBeDefined()
    await input.setValue('300')
    await button(wrapper, 'accept').trigger('click')
    const [sent] = followUp(wrapper)
    expect(sent.stampValueWei).toBeUndefined()
    expect(sent.items[0]).toMatchObject({ action: 'accept', maxBetWei: '300' })
    expect(commitmentOf(loadSeed(ME, PEER, GAME)!)).toBe(
      sent.items[0].commitment,
    )
  })

  it('confirms a payout: the reveal’s stamp is exactly what is owed', async () => {
    const wrapper = await mountLast(hand(true, WIN, 400n, ['stand']))
    const pay = button(wrapper, 'pay')
    expect(pay.text()).toBe('Pay 800 MON and reveal')
    await pay.trigger('click')
    expect(followUp(wrapper)[0]).toMatchObject({
      items: [{ action: 'reveal', link: entropyChain(DEALER)[CHAIN_LENGTH] }],
      stampValueWei: 800n,
    })
  })

  it('has no pay button when the player lost (that reveal is sent automatically)', async () => {
    const wrapper = await mountLast(hand(true, LOSS, 400n, ['stand']))
    expect(button(wrapper, 'pay').exists()).toBe(false)
  })

  it('confirms a refund of money the hand did not accept', async () => {
    const messages = hand(true, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: false,
        item: { ...buildBet(stateOf(messages), WIN) },
        stamp: 1001n,
        digest: 'over',
      }),
    )
    const wrapper = await mountLast(messages)
    expect(button(wrapper, 'pay').text()).toBe('Refund 1001 MON')
    await button(wrapper, 'pay').trigger('click')
    expect(followUp(wrapper)[0]).toMatchObject({
      items: [{ action: 'refund', ref: 'over' }],
      stampValueWei: 1001n,
    })
  })

  it('may return the bet instead of dealing', async () => {
    const messages = hand(true, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: false,
        item: { ...buildBet(stateOf(messages), WIN) },
        stamp: 400n,
        digest: BET_DIGEST,
      }),
    )
    const wrapper = await mountLast(messages)
    await button(wrapper, 'refund-bet').trigger('click')
    expect(followUp(wrapper)[0]).toMatchObject({
      items: [{ action: 'refund', ref: BET_DIGEST }],
      stampValueWei: 400n,
    })
  })

  it('is told when this device does not hold the seed', async () => {
    const messages = hand(true, LOSS, 400n, ['stand']).map(m => ({
      ...m,
      items: [{ ...m.items[0], gameId: 'e'.repeat(32) }],
    }))
    const wrapper = await mountLast(messages)
    expect(wrapper.find('[data-testid="blackjack-problem"]').text()).toContain(
      'does not hold the seed',
    )
  })

  it('sees the result from its side', async () => {
    const wrapper = await mountLast(hand(true, WIN, 400n, ['stand'], 'reveal'))
    expect(wrapper.find('[data-testid="blackjack-outcome"]').text()).toBe(
      'The player wins.',
    )
    // The same result is a loss on the dealer's side.
    expect(wrapper.get('.bj-result').classes()).toContain('bj-result--lose')
  })
})

describe('older bubbles', () => {
  it('say what they were and offer nothing', async () => {
    const messages = hand(false, WIN, 400n, [])
    const wrapper = await mountLast(messages, 0)
    expect(wrapper.find('[data-testid="blackjack-line"]').text()).toContain(
      'Blackjack challenge',
    )
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.find('[data-testid="blackjack-status"]').exists()).toBe(
      false,
    )
  })

  it('the latest bubble works even when the hand’s earlier messages are not rendered', async () => {
    // Only the last message is mounted; the state comes from the store's full message list.
    const wrapper = await mountLast(hand(false, WIN, 400n, ['hit']))
    expect(wrapper.find('[data-testid="blackjack-wager"]').text()).toContain(
      '400 MON',
    )
  })

  it('an older deal bubble permanently shows the cards dealt and upcard', async () => {
    saveSeed(ME, PEER, GAME, WIN)
    const messages = hand(true, WIN, 400n, ['stand'], 'reveal')
    const dealIndex = messages.findIndex(m => m.items[0].action === 'deal')
    expect(dealIndex).toBeGreaterThan(-1)
    const wrapper = await mountLast(messages, dealIndex)
    expect(wrapper.find('[data-testid="blackjack-line"]').text()).toBe(
      'Cards dealt.',
    )
    expect(wrapper.text()).toContain('Player:')
    expect(wrapper.text()).toContain('Dealer shows:')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('an older hit/card bubble permanently shows the card dealt', async () => {
    saveSeed(ME, PEER, GAME, HIT_SEED)
    const messages = hand(true, HIT_SEED, 400n, ['hit', 'stand'], 'reveal')
    const cardIndex = messages.findIndex(m => m.items[0].action === 'card')
    expect(cardIndex).toBeGreaterThan(-1)
    const wrapper = await mountLast(messages, cardIndex)
    expect(wrapper.find('[data-testid="blackjack-line"]').text()).toBe(
      'Card dealt.',
    )
    expect(wrapper.text()).toContain('Card: ')
    expect(wrapper.text()).toContain('Player: ')
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})

describe('a message of the hand that the other side does not have', () => {
  const status = (wrapper: Awaited<ReturnType<typeof mountLast>>) =>
    wrapper.find('[data-testid="blackjack-status"]').text()

  it('a deal cut off before it was sent does not read as dealt and waiting for the player', async () => {
    saveSeed(ME, PEER, GAME, WIN)
    const messages = hand(true, WIN, 400n, []) as any[]
    const deal = messages[messages.length - 1]
    expect(deal.items[0].action).toBe('deal')
    // What a reload leaves of a send that the closing window cut off.
    deal.status = 'error'
    deal.delivery = { failureReason: 'interrupted' }
    const wrapper = await mountLast(messages)
    expect(status(wrapper)).toBe(
      'The other side does not have this message: it was not sent. It was interrupted before it was sent.',
    )
    expect(wrapper.text()).not.toContain("Waiting for the player's move.")
    await button(wrapper, 'retry').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('says so while the message is still being sent, and offers no Retry', async () => {
    saveSeed(ME, PEER, GAME, WIN)
    const messages = hand(true, WIN, 400n, []) as any[]
    for (const state of ['pending', 'payment-pending']) {
      messages[messages.length - 1].status = state
      const wrapper = await mountLast(messages)
      expect(status(wrapper)).toBe(
        'The other side does not have this message yet: it is still being sent.',
      )
      expect(button(wrapper, 'retry').exists()).toBe(false)
    }
  })

  it('a player’s bet that failed is shown as not sent, with its reason', async () => {
    const messages = hand(false, WIN, 400n, []).slice(0, 2) as any[]
    expect(messages[1].items[0].action).toBe('bet')
    messages[1].status = 'error'
    messages[1].delivery = { failureReason: 'unverified', attemptDigest: 'aa' }
    const wrapper = await mountLast(messages)
    expect(status(wrapper)).toContain('Delivery could not be confirmed.')
    expect(wrapper.text()).not.toContain('Waiting for the dealer.')
    expect(button(wrapper, 'retry').exists()).toBe(true)
  })

  it('a delivered message reads as before', async () => {
    saveSeed(ME, PEER, GAME, WIN)
    const wrapper = await mountLast(hand(true, WIN, 400n, []))
    expect(status(wrapper)).toBe("Waiting for the player's move.")
    expect(button(wrapper, 'retry').exists()).toBe(false)
  })
})
