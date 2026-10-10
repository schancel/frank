/** @jest-environment jsdom */
// PARKED (#1377): the liar's dice card code is kept for the rebuild and is not registered anywhere. These
// tests describe its pre-rebuild behaviour (no commitment, no buy-in, a malformed emit from the
// card); they keep it compiling and are not a statement that it is fair or playable.

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import type { LiarsDiceItem } from '@frank/cashweb/types/messages'
import ChatMessageLiarsDice from './ChatMessageLiarsDice.vue'

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
      },
    })

    expect(wrapper.text()).toContain("Liar's Dice (Perudo)")
    expect(wrapper.text()).toContain('0.1 MONT Pot')
    expect(wrapper.text()).toContain('0xAlic')
    expect(wrapper.text()).toContain('0xBob')

    const joinBtn = wrapper.find('[data-testid="join-table-btn"]')
    expect(joinBtn.exists()).toBe(true)
    await joinBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      type: 'text',
      text: '/table join',
    })
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
      type: 'text',
      text: '/liar',
    })

    // Submit bid button
    const submitBidBtn = wrapper.find('[data-testid="submit-bid-btn"]')
    expect(submitBidBtn.exists()).toBe(true)
    await submitBidBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(2)
    expect((wrapper.emitted('sendFollowUp')![1][0] as any).text).toContain(
      '/bid',
    )
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
