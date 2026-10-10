/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'

import BlackjackCards from './BlackjackCards.vue'

// Card index = suit * 13 + rank, suits ♠ ♥ ♦ ♣, ranks A 2 … 10 J Q K.
const ACE_OF_SPADES = 0
const TEN_OF_HEARTS = 13 + 9
const KING_OF_DIAMONDS = 26 + 12
const FOUR_OF_CLUBS = 39 + 3

describe('BlackjackCards', () => {
  it('draws each card as a chip with its rank and suit, red for hearts and diamonds', () => {
    const wrapper = mount(BlackjackCards, {
      props: {
        label: 'Player',
        cards: [ACE_OF_SPADES, TEN_OF_HEARTS, KING_OF_DIAMONDS, FOUR_OF_CLUBS],
        total: 25,
        sentence: 'Player: A♠ 10♥ K♦ 4♣ (25)',
        totalTestid: 'blackjack-player-total',
      },
    })
    const chips = wrapper.findAll('[data-testid="blackjack-card"]')
    expect(chips.map(chip => chip.find('.bj-card__rank').text())).toEqual([
      'A',
      '10',
      'K',
      '4',
    ])
    expect(chips.map(chip => chip.find('.bj-card__suit').text())).toEqual([
      '♠',
      '♥',
      '♦',
      '♣',
    ])
    expect(chips.map(chip => chip.classes().includes('bj-card--red'))).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(wrapper.get('[data-testid="blackjack-player-total"]').text()).toBe(
      '25',
    )
  })

  it('reads as one sentence to assistive technology and hides the picture from it', () => {
    const wrapper = mount(BlackjackCards, {
      props: {
        label: 'Dealer',
        cards: [ACE_OF_SPADES],
        hidden: 1,
        sentence: 'Dealer shows: A♠',
      },
    })
    expect(wrapper.get('.q-sr-only').text()).toBe('Dealer shows: A♠')
    expect(wrapper.get('.bj-row__label').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.bj-row__cards').attributes('aria-hidden')).toBe('true')
    expect(wrapper.findAll('[data-testid="blackjack-card-back"]')).toHaveLength(
      1,
    )
    // No total while the hand's value is not known.
    expect(wrapper.find('.bj-row__total').exists()).toBe(false)
  })
})
