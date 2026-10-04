/** @jest-environment jsdom */
// The blackjack bubble: each message says what it was, and the LATEST message of a hand shows the
// buttons valid for the viewer's role in the hand's current state. Every amount of money a button
// sends is the stamp of the message it sends.
import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive, ref } from 'vue'

import {
  commitmentOf,
  dealerStep,
  foldHand,
  type HandEvent,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import {
  deriveDeck,
  handValue,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import { playOutDealer } from '@frank/wallet/message-item-plugins/blackjack/game'
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
const store: { chats: Record<string, { messages: any[] }> } = reactive({
  chats: {},
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
/** Finds a seed (with the fixed bet digest) whose stand-pat hand has the wanted outcome. */
function seedFor(want: (deck: number[]) => boolean): string {
  for (let i = 1; i < 5000; i++) {
    const seed = i.toString(16).padStart(64, '0')
    if (want(deriveDeck(seed, BET_DIGEST, 0))) return seed
  }
  throw new Error('no seed')
}
const stand = (deck: number[]) =>
  playOutDealer(deck, [deck[0], deck[2]], 4).outcome
const plain = (deck: number[]) => !handValue([deck[0], deck[2]]).blackjack
const WIN = seedFor(d => plain(d) && stand(d) === 'player_win')
const LOSS = seedFor(d => plain(d) && stand(d) === 'dealer_win')

/** A hand where `dealerIsMe` deals with `seed`; the player's `moves` are applied in order. */
function hand(
  dealerIsMe: boolean,
  seed: string,
  wager: bigint,
  moves: string[],
  upTo?: 'reveal',
) {
  const dealer = dealerIsMe ? ME : PEER
  const player = dealerIsMe ? PEER : ME
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
  const dealerActs = (stopBeforeReveal: boolean) => {
    for (;;) {
      const step = dealerStep(foldHand(events).state, seed)
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
    role: 'dealer',
    maxBetWei: '1000',
    commitment: commitmentOf(seed),
  })
  if (wager > 0n) {
    push(player, { action: 'bet' }, wager, BET_DIGEST)
    dealerActs(true)
    for (const move of moves) {
      push(player, { action: move }, move === 'double' ? wager : 10n)
      dealerActs(true)
    }
    if (upTo === 'reveal') dealerActs(false)
  }
  return rows.map(toMessage)
}

async function mountLast(
  messages: ReturnType<typeof toMessage>[],
  index = messages.length - 1,
) {
  store.chats[PEER] = { messages }
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
  store.chats = {}
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
    expect(followUp(wrapper)).toEqual([
      {
        items: [{ type: 'blackjack-hand', gameId: GAME, action: 'bet' }],
        stampValueWei: 400n,
        settled: expect.any(Function),
      },
    ])
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
    store.chats[PEER].messages.push({
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
    expect(wrapper.findAll('button')).toHaveLength(0)
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
      toMessage({ outbound: true, item: { action: 'bet' }, stamp: 1001n }),
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
        item: { action: 'bet' },
        stamp: 1001n,
        digest: 'over',
      }),
      toMessage({
        outbound: false,
        item: { action: 'refund', ref: 'over' },
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
        item: { action: 'bet' },
        stamp: 400n,
        digest: BET_DIGEST,
      }),
      toMessage({
        outbound: false,
        item: { action: 'refund', ref: BET_DIGEST },
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
    const honest = dealerStep(
      foldHand(
        messages.map(m => ({
          item: m.items[0] as HandEvent['item'],
          from: m.outbound ? ME : PEER,
          to: m.outbound ? PEER : ME,
          stampWei: m.stampValueWei,
          digest: m.payloadDigest,
        })),
      ).state,
      WIN,
    )!
    messages.push(
      toMessage({
        outbound: false,
        item: { ...honest.item, outcome: 'dealer_win' } as never,
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
  beforeEach(() => {
    saveSeed(PEER, GAME, WIN)
  })

  it('accepts a player’s challenge with a max bet it can cover, and keeps the seed', async () => {
    // Four times the bet must be spendable: 2000 above the reserve covers a max bet of 500.
    mockBalance.value = RESERVE + 2_000n
    const wrapper = await mountLast([
      toMessage({
        outbound: false,
        item: { action: 'challenge', role: 'player', maxBetWei: '1000' },
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
    expect(commitmentOf(loadSeed(PEER, GAME)!)).toBe(sent.items[0].commitment)
  })

  it('confirms a payout: the reveal’s stamp is exactly what is owed', async () => {
    const wrapper = await mountLast(hand(true, WIN, 400n, ['stand']))
    const pay = button(wrapper, 'pay')
    expect(pay.text()).toBe('Pay 800 MON and reveal')
    await pay.trigger('click')
    expect(followUp(wrapper)[0]).toMatchObject({
      items: [{ action: 'reveal', seed: WIN, outcome: 'player_win' }],
      stampValueWei: 800n,
    })
  })

  it('has no pay button when the player lost (that reveal is sent automatically)', async () => {
    saveSeed(PEER, GAME, LOSS)
    const wrapper = await mountLast(hand(true, LOSS, 400n, ['stand']))
    expect(button(wrapper, 'pay').exists()).toBe(false)
  })

  it('confirms a refund of money the hand did not accept', async () => {
    const messages = hand(true, WIN, 0n, [])
    messages.push(
      toMessage({
        outbound: false,
        item: { action: 'bet' },
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
        item: { action: 'bet' },
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
})
