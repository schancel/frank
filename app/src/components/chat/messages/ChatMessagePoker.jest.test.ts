/** @jest-environment jsdom */
// The poker card's table view and its text commands. Joining (the buy-in lock and the structured
// join) and the refund are covered in TableBuyInPanel.jest.test.ts.

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive, ref } from 'vue'

import type { PokerItem } from '@frank/cashweb/types/messages'
import ChatMessagePoker from './ChatMessagePoker.vue'

const own = ref<string | null>('0xAlice')
jest.mock('../../../utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () => own,
}))
const chatStore = reactive({ activeConversation: { messages: [] as any[] } })
jest.mock('../../../stores/chats', () => ({ useChatStore: () => chatStore }))
jest.mock('../../../stores/table-locks', () => ({
  useTableLockStore: () => ({ locksAt: () => [] }),
}))
jest.mock('../../../games/table-buy-in-session', () => ({
  openTableBuyInSession: () => new Promise(() => undefined),
}))

const quasarStubs: Record<string, any> = Object.fromEntries(
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

quasarStubs.QBadge = defineComponent({
  inheritAttrs: false,
  props: { label: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'span',
        attrs,
        props.label ? [props.label as string] : slots.default?.(),
      ),
})

quasarStubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label ? [props.label as string] : slots.default?.(),
      ),
})

describe('ChatMessagePoker.vue', () => {
  it('renders waiting table, joined players, and triggers join and start actions', async () => {
    const item: PokerItem = {
      type: 'poker',
      tableId: 'poker_tab1',
      action: 'create',
      smallBlind: 10,
      bigBlind: 20,
      pot: 0,
      street: 'waiting',
      players: [
        {
          address: '0xAlice',
          chips: 1000,
          currentStreetBet: 0,
          totalHandBet: 0,
          folded: false,
          isAllIn: false,
          isDealerButton: true,
          isSmallBlind: true,
          isBigBlind: false,
        },
        {
          address: '0xBob',
          chips: 1000,
          currentStreetBet: 0,
          totalHandBet: 0,
          folded: false,
          isAllIn: false,
          isDealerButton: false,
          isSmallBlind: false,
          isBigBlind: true,
        },
      ],
    }

    const wrapper = mount(ChatMessagePoker, {
      props: {
        item,
        address: '0xCharlie',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain("Texas Hold'em Poker")
    expect(wrapper.text()).toContain('0 Chips Pot')
    expect(wrapper.text()).toContain('0xAlic')
    expect(wrapper.text()).toContain('0xBob')

    // A table without an escrow offers no join: the bot seats only a locked buy-in.
    expect(wrapper.find('[data-testid="table-join-btn"]').exists()).toBe(false)

    // Start button
    const startBtn = wrapper.find('[data-testid="poker-start-btn"]')
    expect(startBtn.exists()).toBe(true)
    await startBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/poker start' }],
      stampValueWei: 0n,
    })
  })

  it('renders active betting round with board, hole cards, and action buttons', async () => {
    const item: PokerItem = {
      type: 'poker',
      tableId: 'poker_tab1',
      action: 'action',
      smallBlind: 10,
      bigBlind: 20,
      pot: 80,
      currentBet: 20,
      minRaise: 20,
      street: 'flop',
      boardCards: [51, 38, 25], // A♠, A♥, A♦
      myHoleCards: [12, 11], // A♣, K♣
      activePlayer: '0xAlice',
      players: [
        {
          address: '0xAlice',
          chips: 960,
          currentStreetBet: 0,
          totalHandBet: 20,
          folded: false,
          isAllIn: false,
          isDealerButton: true,
          isSmallBlind: true,
          isBigBlind: false,
        },
        {
          address: '0xBob',
          chips: 960,
          currentStreetBet: 20,
          totalHandBet: 40,
          folded: false,
          isAllIn: false,
          isDealerButton: false,
          isSmallBlind: false,
          isBigBlind: true,
        },
      ],
    }

    const wrapper = mount(ChatMessagePoker, {
      props: {
        item,
        address: '0xAlice', // It is Alice's turn
      },
      global: {
        stubs: quasarStubs,
      },
    })

    // Community cards
    const board = wrapper.find('[data-testid="board-cards-container"]')
    expect(board.exists()).toBe(true)
    expect(board.text()).toContain('A♠')
    expect(board.text()).toContain('A♥')

    // Hole cards
    const holeCards = wrapper.find('[data-testid="my-hole-cards"]')
    expect(holeCards.exists()).toBe(true)
    expect(holeCards.text()).toContain('A♣')
    expect(holeCards.text()).toContain('K♣')

    // Action buttons
    const callBtn = wrapper.find('[data-testid="poker-check-call-btn"]')
    expect(callBtn.exists()).toBe(true)
    expect(callBtn.text()).toContain('Call 20')
    await callBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/call' }],
      stampValueWei: 0n,
    })

    // Fold button
    const foldBtn = wrapper.find('[data-testid="poker-fold-btn"]')
    expect(foldBtn.exists()).toBe(true)
    await foldBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(2)
    expect(wrapper.emitted('sendFollowUp')![1][0]).toEqual({
      items: [{ type: 'text', text: '/fold' }],
      stampValueWei: 0n,
    })

    // Raise button
    const raiseBtn = wrapper.find('[data-testid="poker-raise-btn"]')
    expect(raiseBtn.exists()).toBe(true)
    await raiseBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(3)
    expect(
      (wrapper.emitted('sendFollowUp')![2][0] as any).items[0].text,
    ).toContain('/raise')
  })

  it('renders settled showdown with winner details', () => {
    const item: PokerItem = {
      type: 'poker',
      tableId: 'poker_tab1',
      action: 'settle',
      smallBlind: 10,
      bigBlind: 20,
      pot: 0,
      street: 'settled',
      boardCards: [51, 38, 25, 0, 1],
      players: [
        {
          address: '0xAlice',
          chips: 1500,
          currentStreetBet: 0,
          totalHandBet: 500,
          folded: false,
          isAllIn: false,
          isDealerButton: true,
          isSmallBlind: true,
          isBigBlind: false,
        },
      ],
      winners: [
        {
          address: '0xAlice',
          amount: 500,
          handDescription: 'Four of a Kind, Aces',
        },
      ],
    }

    const wrapper = mount(ChatMessagePoker, {
      props: {
        item,
        address: '0xAlice',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    const banner = wrapper.find('[data-testid="poker-winners-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('HAND SETTLED')
    expect(banner.text()).toContain('0xAlice')
    expect(banner.text()).toContain('500 chips')
    expect(banner.text()).toContain('Four of a Kind, Aces')
  })
})
