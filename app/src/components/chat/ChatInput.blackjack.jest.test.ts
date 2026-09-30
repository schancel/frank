/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

import ChatInput from './ChatInput.vue'
import enUS from '../../i18n/en-us'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n ** 16n,
    toDisplayAmount: (n: bigint) => n.toString(),
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))
jest.mock('../../utils/chat', () => ({ processInput: jest.fn() }))

const slotted = (tag: string) =>
  defineComponent({
    inheritAttrs: false,
    setup(_, { slots, attrs }) {
      return () => h(tag, attrs, slots.default?.())
    },
  })
const Picker = defineComponent({
  props: ['address', 'submit', 'busy'],
  setup: props => () =>
    h('div', { 'data-testid': 'picker', 'data-address': props.address }),
})

function mountInput(props: Record<string, unknown>) {
  return mount(ChatInput, {
    props,
    global: {
      components: {
        QToolbar: slotted('div'),
        QBtn: slotted('button'),
        QMenu: slotted('div'),
        QTooltip: slotted('span'),
        QList: slotted('div'),
        QItem: slotted('div'),
        QItemSection: slotted('div'),
        QIcon: slotted('i'),
        QInput: slotted('input'),
        QSlider: slotted('div'),
        QSpace: slotted('div'),
        BlackjackBetPicker: Picker,
      },
      directives: { 'close-popup': {} },
      mocks: {
        $t: (k: string) =>
          k
            .split('.')
            .reduce((o: any, p) => o?.[p], enUS as Record<string, any>) ?? k,
      },
    },
  })
}

describe('ChatInput blackjack entry point (ticket #310)', () => {
  it('offers a labelled Play blackjack control in a chat, wired to the counterpart address', () => {
    const w = mountInput({ address: '0xDealer' })
    const btn = w.find('[data-testid="blackjack-menu-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('Play blackjack')
    expect(w.find('[data-testid="picker"]').attributes('data-address')).toBe(
      '0xDealer',
    )
  })

  it('offers nothing when there is no chat address', () => {
    const w = mountInput({})
    expect(w.find('[data-testid="blackjack-menu-button"]').exists()).toBe(false)
  })
})
