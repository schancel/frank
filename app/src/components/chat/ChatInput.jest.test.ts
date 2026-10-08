/** @jest-environment jsdom */
// ChatInput: a blackjack challenge is an entry in the existing message-type menu, in every chat,
// with no dealer or bot gate (there is no separate toolbar button), and the compose box does not
// steal focus back (#405), so controls inside a bubble stay usable.
import fs from 'fs'
import path from 'path'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

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
// Every button exposes its icon so a casino (blackjack) button cannot hide.
const QBtn = defineComponent({
  inheritAttrs: false,
  props: ['icon'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, 'data-icon': props.icon }, slots.default?.()),
})
// Like Quasar's QInput: a real input element that also exposes `focus()` on the component.
const QInput = defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(props, { emit, expose }) {
    const el = ref<HTMLInputElement>()
    expose({ focus: () => el.value?.focus() })
    return () =>
      h('input', {
        ref: el,
        value: props.modelValue,
        onInput: (e: Event) =>
          emit('update:modelValue', (e.target as HTMLInputElement).value),
      })
  },
})

const globalOptions = {
  components: {
    QToolbar: slotted('div'),
    QBtn,
    QMenu: slotted('div'),
    QTooltip: slotted('span'),
    QList: slotted('div'),
    QItem: slotted('div'),
    QItemSection: slotted('div'),
    QIcon: slotted('i'),
    QInput,
    QSlider: slotted('div'),
    QBadge: slotted('span'),
    QSpace: slotted('div'),
    QSpinnerDots: slotted('span'),
  },
  directives: { 'close-popup': {} },
  mocks: {
    $t: (k: string) =>
      k.split('.').reduce((o: any, p) => o?.[p], enUS as Record<string, any>) ??
      k,
  },
}

describe('ChatInput offers a blackjack challenge in the message-type menu', () => {
  it.each([
    ['no extra props', {}],
    ['a chat that is being sent to', { disable: true }],
  ])(
    'has the menu entry next to Attach Image for %s, and it asks the page for the form',
    async (_n, props) => {
      const w = mount(ChatInput, { props, global: globalOptions })
      const entry = w.find('[data-testid="blackjack-menu-item"]')
      expect(entry.exists()).toBe(true)
      expect(entry.text()).toBe(enUS.chatInput.blackjackChallenge)
      await entry.trigger('click')
      expect(w.emitted('blackjackClicked')).toHaveLength(1)
    },
  )
})

describe('ChatInput offers Send Stealth in the message-type menu', () => {
  it.each([
    ['no extra props', {}],
    ['a chat that is being sent to', { disable: true }],
  ])(
    'has the stealth menu entry next to Attach Image for %s, and it asks the page for the stealth dialog',
    async (_n, props) => {
      const w = mount(ChatInput, { props, global: globalOptions })
      const entry = w.find('[data-testid="send-stealth-menu-item"]')
      expect(entry.exists()).toBe(true)
      expect(entry.text()).toBe(enUS.chatInput.sendStealth)
      await entry.trigger('click')
      expect(w.emitted('sendStealthClicked')).toHaveLength(1)
    },
  )
})

describe('ChatInput offers atomic swap in the message-type menu', () => {
  it.each([
    ['no extra props', {}],
    ['a chat that is being sent to', { disable: true }],
  ])(
    'has the swap menu entry in message menu for %s, and emits offerSwapClicked',
    async (_n, props) => {
      const w = mount(ChatInput, { props, global: globalOptions })
      const entry = w.find('[data-testid="offer-swap-menu-item"]')
      expect(entry.exists()).toBe(true)
      expect(entry.text()).toBe(enUS.chatInput.offerSwap)
      await entry.trigger('click')
      expect(w.emitted('offerSwapClicked')).toHaveLength(1)
    },
  )
})

describe('ChatInput has no separate blackjack toolbar button (#395)', () => {
  it.each([
    ['no extra props', {}],
    [
      'the props the removed toolbar button used (a bot-marked dealer chat)',
      {
        address: '0xDealer',
        blackjackEnabled: true,
        peerName: 'Dealer',
        submitFollowUp: jest.fn(),
      },
    ],
  ])('renders no casino button and no menu for %s', (_name, props) => {
    const w = mount(ChatInput, { props, global: globalOptions })
    expect(w.find('[data-testid="blackjack-menu-button"]').exists()).toBe(false)
    expect(w.find('[data-icon="casino"]').exists()).toBe(false)
    // The rest of the toolbar is untouched: attach, stamp payment and send.
    expect(w.find('[data-icon="unfold_more"]').exists()).toBe(true)
    expect(w.find('[data-icon="local_post_office"]').exists()).toBe(true)
    expect(w.find('[data-icon="send"]').exists()).toBe(true)
  })
})

describe('compose box next to controls inside a chat bubble (#395)', () => {
  // A sibling "bubble" with an amount input and a button, next to the real compose bar.
  function mountPage() {
    const onBet = jest.fn()
    const emitted: string[] = []
    const Page = defineComponent({
      components: { ChatInput },
      data: () => ({ message: '' }),
      render() {
        return h('div', [
          h('div', { class: 'bubble' }, [
            h('input', { id: 'bubble-amount', value: '0.1' }),
            h('input', { id: 'bubble-confirm', type: 'checkbox' }),
            h('button', { id: 'bubble-bet', onClick: onBet }, 'Bet'),
          ]),
          h(ChatInput, {
            'message': this.message,
            'onUpdate:message': (v: string) => {
              emitted.push(v)
              this.message = v
            },
          }),
        ])
      },
    })
    const w = mount(Page, { attachTo: document.body, global: globalOptions })
    const compose = () =>
      w.findAll('input').find(i => i.element.id === '')!.element
    return { w, onBet, emitted, compose }
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('an amount input in the bubble keeps focus and can be typed into while the compose box was focused', async () => {
    const { compose } = mountPage()
    const amount = document.getElementById('bubble-amount') as HTMLInputElement
    compose().focus()
    expect(document.activeElement).toBe(compose())
    amount.focus() // the user clicks into the bubble's amount field
    expect(document.activeElement).toBe(amount)
    amount.value = '0.25'
    amount.dispatchEvent(new Event('input'))
    expect(amount.value).toBe('0.25')
    expect(document.activeElement).toBe(amount)
  })

  it('clicking a bubble button works with the compose box empty AND focused', async () => {
    const { onBet, compose } = mountPage()
    const bet = document.getElementById('bubble-bet') as HTMLButtonElement

    // Compose empty and not focused: a plain click.
    bet.focus()
    bet.click()
    expect(onBet).toHaveBeenCalledTimes(1)

    // Compose focused: pressing the button moves focus to it and the click lands; compose does
    // not take focus back.
    compose().focus()
    bet.focus()
    bet.click()
    expect(onBet).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(bet)
  })

  it('a checkbox inside the bubble can be toggled with the compose box focused', () => {
    const { compose } = mountPage()
    const box = document.getElementById('bubble-confirm') as HTMLInputElement
    compose().focus()
    box.focus()
    expect(document.activeElement).toBe(box)
    box.click()
    expect(box.checked).toBe(true)
  })

  it('typing in the compose box is unaffected', async () => {
    const { compose, emitted } = mountPage()
    const el = compose() as HTMLInputElement
    el.focus()
    el.value = 'hi?'
    el.dispatchEvent(new Event('input'))
    expect(emitted).toEqual(['hi?'])
    expect(document.activeElement).toBe(el)
  })
})

describe('stable chat-level focus target (#429)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exposes the real compose input as its public focus target', () => {
    const wrapper = mount(ChatInput, {
      attachTo: document.body,
      global: globalOptions,
    })
    ;(wrapper.vm as unknown as { focus: () => void }).focus()
    expect(document.activeElement).toBe(wrapper.find('input').element)
    wrapper.unmount()
  })
})

describe('modernized chat input interface (#1003)', () => {
  it('renders the encapsulated input capsule and styled primary send button', () => {
    const wrapper = mount(ChatInput, {
      global: globalOptions,
    })
    expect(wrapper.find('.chat-input-container').exists()).toBe(true)
    expect(wrapper.find('.chat-input-field').exists()).toBe(true)

    // Stamp multiplier pill shows initial multiplier
    const stampBtn = wrapper.find('.chat-stamp-btn')
    expect(stampBtn.exists()).toBe(true)
    expect(wrapper.find('.chat-stamp-pill-text').text()).toBe('1×')

    // Send button has primary color and modern send class
    const sendBtn = wrapper.find('.chat-send-btn')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('color')).toBe('primary')
  })

  it('updates stamp multiplier pill text when stampAmount changes', async () => {
    const wrapper = mount(ChatInput, {
      props: { stampAmount: '20000000000000000' }, // 2x defaultStampValue (10^16)
      global: globalOptions,
    })
    expect(wrapper.find('.chat-stamp-pill-text').text()).toBe('2×')
  })

  it('does not render bottom stamp status bar to prevent scroll bounce glitches and loads send button when disabled', () => {
    const wrapper = mount(ChatInput, {
      props: {
        disable: true,
      },
      global: globalOptions,
    })
    expect(
      wrapper.find('[data-testid="chat-input-stamp-status"]').exists(),
    ).toBe(false)
    const sendBtn = wrapper.find('.chat-send-btn')
    expect(sendBtn.attributes('loading')).toBe('true')
    expect(sendBtn.attributes('disable')).toBe('true')
  })
})

describe('ChatInput toolbar alignment and layout (#1009)', () => {
  it('defines vertical centering and balanced padding without sagging or edge clipping', () => {
    const sfc = fs.readFileSync(path.join(__dirname, 'ChatInput.vue'), 'utf8')
    expect(sfc).toMatch(/\.chat-input-toolbar\s*\{[^}]*align-items:\s*center/)
    expect(sfc).toMatch(/\.chat-input-toolbar\s*\{[^}]*padding:\s*8px 14px/)
    expect(sfc).toMatch(/\.chat-send-btn\s*\{[^}]*padding:\s*0 !important/)
    expect(sfc).toMatch(/\.chat-send-btn\s*\{[^}]*flex-shrink:\s*0/)
    expect(sfc).toMatch(/\.chat-input-container\s*\{[^}]*min-width:\s*0/)
  })
})

describe('orders-of-magnitude stamp slider and geometric suggestion lifecycle (Issues #819 & #820)', () => {
  it('correctly maps multipliers across 4 orders of magnitude in decadeIndex', async () => {
    const wrapper = mount(ChatInput, {
      props: { stampAmount: (10n ** 16n).toString() },
      global: globalOptions,
    })
    const vm = wrapper.vm as any
    // 1x default -> index 0
    expect(vm.decadeIndex).toBe(0)

    // Set to 10x (index 3)
    vm.decadeIndex = 3
    const emitted = wrapper.emitted('update:stampAmount')
    expect(emitted).toBeTruthy()
    // 10x of default stamp = 10^17 wei in test mock
    expect(emitted[0][0]).toBe((10n ** 17n).toString())
  })

  it('renders converged badge when suggestedStampAmount matches and not overridden', () => {
    const wrapper = mount(ChatInput, {
      props: {
        stampAmount: '0.71',
        suggestedStampAmount: '0.71',
        isOverridden: false,
      },
      global: globalOptions,
    })
    expect(wrapper.find('[data-testid="stamp-converged-badge"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="stamp-override-badge"]').exists()).toBe(
      false,
    )
  })

  it('renders override badge and reset button when isOverridden is true', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        stampAmount: '1.0',
        suggestedStampAmount: '0.71',
        isOverridden: true,
      },
      global: globalOptions,
    })
    expect(wrapper.find('[data-testid="stamp-override-badge"]').exists()).toBe(
      true,
    )
    const resetBtn = wrapper.find('[data-testid="chat-input-reset-suggested"]')
    expect(resetBtn.exists()).toBe(true)

    await resetBtn.trigger('click')
    expect(wrapper.emitted('resetStampToSuggested')).toBeTruthy()
  })
})
