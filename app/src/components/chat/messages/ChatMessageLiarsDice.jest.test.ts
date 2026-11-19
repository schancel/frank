/** @jest-environment jsdom */
// The liar's dice card's table view and its text commands. Joining (the buy-in lock and the structured
// join) and the refund are covered in TableBuyInPanel.jest.test.ts.

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive, ref } from 'vue'

import type { LiarsDiceItem } from '@frank/cashweb/types/messages'
import ChatMessageLiarsDice from './ChatMessageLiarsDice.vue'

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

describe('ChatMessageLiarsDice.vue', () => {
  it('renders table info, joined players, and join button', async () => {
    const item: LiarsDiceItem = {
      type: 'liars-dice',
      tableId: 'tab12345',
      action: 'create',
      buyInWei: '50000000000000000',
      maxPlayers: 4,
      dicePerPlayer: 5,
      players: ['0xAlice', '0xBob'],
      diceCounts: [5, 5],
      potWei: '100000000000000000',
    }

    const wrapper = mount(ChatMessageLiarsDice, {
      props: {
        item,
        address: '0x123',
      },
      global: {
        stubs: quasarStubs,
        mocks: { $t: (key: string) => key },
      },
    })

    expect(wrapper.text()).toContain("Liar's Dice (Perudo)")
    expect(wrapper.text()).toContain('0.1 MONT Pot')
    expect(wrapper.text()).toContain('0xAlic')
    expect(wrapper.text()).toContain('0xBob')

    // A table without an escrow offers no join: the bot seats only a locked buy-in.
    expect(wrapper.find('[data-testid="table-join-btn"]').exists()).toBe(false)
    expect(wrapper.emitted('sendFollowUp')).toBeUndefined()
  })

  it('renders current bid banner, secret cup, and emits raise / call liar actions', async () => {
    const item: LiarsDiceItem = {
      type: 'liars-dice',
      tableId: 'tab12345',
      action: 'bid',
      roundNumber: 1,
      players: ['0xAlice', '0xBob'],
      diceCounts: [5, 4],
      activePlayer: '0xAlice',
      currentBid: {
        bidder: '0xBob',
        quantity: 3,
        face: 4,
      },
      myDice: [1, 2, 4, 4, 6],
    }

    const wrapper = mount(ChatMessageLiarsDice, {
      props: {
        item,
        address: '0xAlice',
      },
      global: {
        stubs: quasarStubs,
        mocks: { $t: (key: string) => key },
      },
    })

    // Current bid
    const bidBanner = wrapper.find('[data-testid="current-bid-banner"]')
    expect(bidBanner.exists()).toBe(true)
    expect(bidBanner.text()).toContain('3x')
    expect(bidBanner.text()).toContain('(4s)')

    // Secret cup
    const cup = wrapper.find('[data-testid="my-dice-cup"]')
    expect(cup.exists()).toBe(true)

    // Call Liar button
    const liarBtn = wrapper.find('[data-testid="call-liar-btn"]')
    expect(liarBtn.exists()).toBe(true)
    await liarBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/liar' }],
      stampValueWei: 0n,
    })

    // Submit bid button
    const submitBidBtn = wrapper.find('[data-testid="submit-bid-btn"]')
    expect(submitBidBtn.exists()).toBe(true)
    await submitBidBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(2)
    expect(
      (wrapper.emitted('sendFollowUp')![1][0] as any).items[0].text,
    ).toContain('/bid')
  })

  it('renders showdown result with matching dice and eliminated players', async () => {
    const item: LiarsDiceItem = {
      type: 'liars-dice',
      tableId: 'tab12345',
      action: 'showdown',
      roundNumber: 2,
      players: ['0xAlice', '0xBob'],
      diceCounts: [3, 0],
      revealedCups: {
        '0xAlice': [1, 2, 4],
        '0xBob': [3, 5],
      },
      challengeResult: {
        bidQuantity: 4,
        bidFace: 4,
        actualCount: 2,
        wildAcesCount: 1,
        challengerWon: true,
        loserAddress: '0xBob',
        eliminated: true,
      },
      winnerAddress: '0xAlice',
      potWei: '200000000000000000',
    }

    const wrapper = mount(ChatMessageLiarsDice, {
      props: {
        item,
        address: '0xAlice',
      },
      global: {
        stubs: quasarStubs,
        mocks: { $t: (key: string) => key },
      },
    })

    const showdown = wrapper.find('[data-testid="showdown-results"]')
    expect(showdown.exists()).toBe(true)
    expect(showdown.text()).toContain('SHOWDOWN RESULT')
    expect(showdown.text()).toContain('Total Matching: 2')
    expect(showdown.text()).toContain('Challenger was Right!')
    expect(showdown.text()).toContain('ELIMINATED')

    const winner = wrapper.find('[data-testid="winner-banner"]')
    expect(winner.exists()).toBe(true)
    expect(winner.text()).toContain('VICTORY')
    expect(winner.text()).toContain('0xAlice')
  })
})
