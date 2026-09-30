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
  props: ['address', 'submit', 'busy', 'dealerName', 'stampWei'],
  emits: ['pendingChange', 'placed'],
  setup:
    (props, { emit }) =>
    () =>
      h('div', {
        'data-testid': 'picker',
        'data-address': props.address,
        'data-name': props.dealerName,
        'data-busy': String(props.busy),
        'onClick': () => emit('pendingChange', true),
      }),
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
  it('offers a labelled Play blackjack control for a bot peer, wired to its address and name', () => {
    const submit = jest.fn()
    const w = mountInput({
      address: '0xDealer',
      blackjackEnabled: true,
      peerName: 'Dealer',
      submitFollowUp: submit,
    })
    const btn = w.find('[data-testid="blackjack-menu-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('aria-label')).toBe('Play blackjack')
    const picker = w.find('[data-testid="picker"]')
    expect(picker.attributes('data-address')).toBe('0xDealer')
    expect(picker.attributes('data-name')).toBe('Dealer')
  })

  it('hides the control for a peer without the bot marker (default) and with no address', () => {
    expect(
      mountInput({ address: '0xPerson' })
        .find('[data-testid="blackjack-menu-button"]')
        .exists(),
    ).toBe(false)
    expect(
      mountInput({ blackjackEnabled: true })
        .find('[data-testid="blackjack-menu-button"]')
        .exists(),
    ).toBe(false)
  })

  it('keeps the menu open (persistent) only while a bet is pending', async () => {
    const w = mountInput({ address: '0xDealer', blackjackEnabled: true })
    const persistent = () =>
      w
        .find('[data-testid="blackjack-menu-button"] div')
        .attributes('persistent')
    expect(['false', undefined]).toContain(persistent())
    await w.find('[data-testid="picker"]').trigger('click') // picker reports pending
    expect(['', 'true']).toContain(persistent())
  })
})
