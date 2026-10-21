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
    chainIdentifier: 'monad-testnet',
    unit: 'MON',
    // Most tests here pass amounts as whole base units; the chip tests switch to real decimals.
    toDisplayAmount: (n: bigint) =>
      mockDecimals ? jest.requireActual('ethers').formatEther(n) : n.toString(),
    fromDisplayAmount: (s: string) => {
      if (mockDecimals) return jest.requireActual('ethers').parseEther(s)
      try {
        return BigInt(s)
      } catch {
        return BigInt(Math.round(Number(s) * 1000))
      }
    },
  },
  getChainRegistryEntry: (id: string) =>
    id === 'monad-testnet' ? { kind: 'monad' } : undefined,
}))
let mockDecimals = false
// The oracle's AVU value of a stamp: no rate (0) unless a test sets one.
let mockAvu = 0
let mockStaleAgeMs: number | undefined
jest.mock('../../stores/oracle', () => ({
  useSafeOracleStore: () => ({
    getAvu: (asset: string, raw: bigint) =>
      asset === 'monad' && raw > 0n ? mockAvu : 0,
    formatAvuAmount: (asset: string, raw: bigint) =>
      asset === 'monad' && raw > 0n && mockAvu
        ? `≈ 50 mAVU · testnet${mockStaleAgeMs ? ' (45 min old)' : ''}`
        : '',
    valueStaleAgeMs: () => mockStaleAgeMs,
  }),
}))

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
    $t: (k: string, params: Record<string, unknown> = {}) =>
      String(
        k
          .split('.')
          .reduce((o: any, p) => o?.[p], enUS as Record<string, any>) ?? k,
      ).replace(/\{(\w+)\}/g, (m, name) =>
        name in params ? String(params[name]) : m,
      ),
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

describe('ChatInput does not offer atomic swaps, which are turned off until rebuilt on HTLC', () => {
  it.each([
    ['no extra props', {}],
    ['a chat that is being sent to', { disable: true }],
  ])('has no swap entry in the message menu for %s', (_n, props) => {
    const w = mount(ChatInput, { props, global: globalOptions })
    // The submenu renders (stubbed QMenu), so the absence below is not vacuous.
    expect(w.find('[data-testid="invoice-menu-item"]').exists()).toBe(true)
    expect(w.find('[data-testid="swap-menu-item"]').exists()).toBe(false)
    expect(w.text()).not.toContain(enUS.signedSwap.title)
    expect(w.text()).not.toContain(enUS.chatInput.offerSwap)
  })
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

    const stampBtn = wrapper.find('.chat-stamp-btn')
    expect(stampBtn.exists()).toBe(true)

    // Send button has primary color and modern send class
    const sendBtn = wrapper.find('.chat-send-btn')
    expect(sendBtn.exists()).toBe(true)
    expect(sendBtn.attributes('color')).toBe('primary')
  })

  describe('the stamp chip says what it is', () => {
    beforeEach(() => {
      mockDecimals = true
    })
    afterEach(() => {
      mockDecimals = false
    })

    it('shows the stamp as an amount in the chain’s unit, not a bare multiplier', () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.01',
        },
        global: globalOptions,
      })
      expect(wrapper.find('.chat-stamp-pill-text').text()).toBe('10 mMON')
      // At the minimum there is no multiple to show.
      expect(wrapper.find('[data-testid="stamp-pill-multiple"]').exists()).toBe(
        false,
      )
      expect(wrapper.get('[data-testid="stamp-tooltip-amount"]').text()).toBe(
        'Stamp: 0.01 MON',
      )
    })

    it('shows the multiple of the default as secondary text', () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.014142135623730950',
        },
        global: globalOptions,
      })
      expect(wrapper.find('.chat-stamp-pill-text').text()).toBe('14.14 mMON')
      expect(wrapper.get('[data-testid="stamp-pill-multiple"]').text()).toBe(
        '≈1.4142×',
      )
      expect(wrapper.get('[data-testid="stamp-tooltip-amount"]').text()).toBe(
        'Stamp: 0.01414 MON, ≈1.4142× the default',
      )
    })

    const avuStamp = () =>
      mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.014142135623730950',
        },
        global: globalOptions,
      })

    it('leads with the stamp’s AVU value, the coin amount beside it', () => {
      mockAvu = 0.05
      try {
        const wrapper = avuStamp()
        const pill = wrapper.get('.chat-stamp-btn')
        // Short on the pill: no testnet marker or age (those are in the hover line).
        expect(pill.get('[data-testid="stamp-pill-avu"]').text()).toBe(
          '≈ 50 mAVU',
        )
        expect(pill.find('[data-testid="stamp-pill-avu-stale"]').exists()).toBe(
          false,
        )
        expect(pill.get('.chat-stamp-pill-text').text()).toBe('14.14 mMON')
        expect(pill.get('.chat-stamp-pill-text').classes()).toContain(
          'chat-stamp-pill-text--secondary',
        )
        // AVU is the figure people read; the multiple stays in the hover line.
        expect(pill.find('[data-testid="stamp-pill-multiple"]').exists()).toBe(
          false,
        )
        expect(wrapper.get('[data-testid="stamp-tooltip-amount"]').text()).toBe(
          'Stamp: 0.01414 MON, ≈1.4142× the default',
        )
        expect(wrapper.get('[data-testid="stamp-tooltip-avu"]').text()).toBe(
          'Worth ≈ 50 mAVU · testnet (1 AVU = 1 kWh)',
        )
      } finally {
        mockAvu = 0
      }
    })

    it('never shows a stale AVU figure unmarked', () => {
      mockAvu = 0.05
      mockStaleAgeMs = 45 * 60_000
      try {
        const wrapper = avuStamp()
        const avu = wrapper.get('[data-testid="stamp-pill-avu"]')
        expect(avu.classes()).toContain('chat-stamp-pill-avu--stale')
        expect(avu.find('[data-testid="stamp-pill-avu-stale"]').exists()).toBe(
          true,
        )
        expect(avu.text()).toBe('≈ 50 mAVU')
        expect(wrapper.get('[data-testid="stamp-tooltip-avu"]').text()).toBe(
          'Worth ≈ 50 mAVU · testnet (45 min old) (1 AVU = 1 kWh)',
        )
      } finally {
        mockAvu = 0
        mockStaleAgeMs = undefined
      }
    })

    it('without an AVU rate shows the coin amount alone, no AVU figure', () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.01',
        },
        global: globalOptions,
      })
      expect(wrapper.find('[data-testid="stamp-pill-avu"]').exists()).toBe(
        false,
      )
      expect(wrapper.find('[data-testid="stamp-tooltip-avu"]').exists()).toBe(
        false,
      )
      expect(wrapper.get('.chat-stamp-pill-text').text()).toBe('10 mMON')
    })

    it('a stamp of 0 reads "Free" on the chip and in its hover line', () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.0',
        },
        global: globalOptions,
      })
      expect(wrapper.find('.chat-stamp-pill-text').text()).toBe('Free')
      expect(wrapper.get('[data-testid="stamp-tooltip-amount"]').text()).toBe(
        enUS.chatInput.stampChipFree,
      )
    })

    it('allows a native amount and an explicit free choice without an AVU default', async () => {
      const wrapper = mount(ChatInput, {
        props: {
          stampAmount: '',
          defaultStampMode: true,
          stampUnavailable: 'The conversion rate is unavailable',
        },
        global: globalOptions,
      })
      const amount = wrapper.get('[data-testid="chat-input-stamp-amount"]')
      expect(amount.attributes('disabled')).toBeUndefined()
      await amount.setValue('0.4')
      expect(wrapper.emitted('update:stampAmount')?.[0]).toEqual(['0.4'])
      await wrapper.setProps({
        stampAmount: '0.4',
        defaultStampMode: false,
        stampUnavailable: '',
      })
      expect((amount.element as HTMLInputElement).value).toBe('0.4')
      // The slider is always visible and functional using network static fallback.
      expect(
        wrapper.find('[data-testid="chat-input-stamp-slider"]').exists(),
      ).toBe(true)
      await wrapper
        .get('[data-testid="chat-input-stamp-free"]')
        .trigger('click')
      expect(wrapper.emitted('update:stampAmount')?.[1]).toEqual(['0'])
      await wrapper.setProps({ stampAmount: '0.0' })
      expect(
        wrapper.get('[data-testid="chat-input-stamp-selection"]').text(),
      ).toBe('Free')
    })

    it('does not change the stamp through the Free action while busy', async () => {
      const wrapper = mount(ChatInput, {
        props: { stampAmount: '0.4', disable: true },
        global: globalOptions,
      })
      expect(
        wrapper
          .get('[data-testid="chat-input-stamp-free"]')
          .attributes('disable'),
      ).toBe('true')
      await wrapper
        .get('[data-testid="chat-input-stamp-free"]')
        .trigger('click')
      expect(wrapper.emitted('update:stampAmount')).toBeUndefined()
    })

    it('the amount box takes 0, and keeps what was typed while it is the chosen amount', async () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.01',
        },
        global: globalOptions,
      })
      const vm = wrapper.vm as any
      // The chain's own text for an amount is not shown raw ("0.010000000000000000").
      expect(vm.innerStampAmount).toBe('0.01')
      vm.innerStampAmount = '0'
      expect(wrapper.emitted('update:stampAmount')?.[0]).toEqual(['0'])
      // The page answers with the chain's text for the amount: the box still shows "0".
      await wrapper.setProps({ stampAmount: '0.0' })
      expect(vm.innerStampAmount).toBe('0')
      // The clear button gives null: passed on as no amount, never thrown on.
      vm.innerStampAmount = null
      expect(wrapper.emitted('update:stampAmount')?.[1]).toEqual([''])
    })

    it('offers the default again once another amount is chosen', async () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.0',
        },
        global: globalOptions,
      })
      const reset = wrapper.get('[data-testid="chat-input-reset-default"]')
      await reset.trigger('click')
      expect(wrapper.emitted('resetStampDefault')).toEqual([[]])
      expect(wrapper.emitted('update:stampAmount')).toBeUndefined()
      await wrapper.setProps({ stampAmount: '0.01', defaultStampMode: true })
      expect(
        wrapper.find('[data-testid="chat-input-reset-default"]').exists(),
      ).toBe(false)
    })

    it('explains what a stamp is and how its amount is chosen, where the amount is set', () => {
      const wrapper = mount(ChatInput, {
        props: {
          minimumStampWei: 10n ** 16n,
          defaultStampWei: 10n ** 16n,
          defaultStampMode: false,
          stampAmount: '0.01',
        },
        global: globalOptions,
      })
      const text = wrapper.get('[data-testid="stamp-explanation"]').text()
      expect(text).toContain(enUS.chatInput.stampWhat)
      expect(text).toContain(enUS.chatInput.stampWhy)
    })
  })

  it('uses the agreed AVU quote as 1× even when its fee floor is much lower', async () => {
    const quote = 402708123456789123n
    const wrapper = mount(ChatInput, {
      props: {
        defaultStampWei: quote,
        minimumStampWei: 2142000000000000n,
        stampAmount: quote.toString(),
      },
      global: globalOptions,
    })
    const vm = wrapper.vm as any
    expect(vm.stampMultiplier).toBe('1')
    expect(
      wrapper.get('[data-testid="chat-input-stamp-selection"]').text(),
    ).toBe(`1× default (${quote} MON)`)
    expect(wrapper.find('[data-testid="stamp-pill-multiple"]').exists()).toBe(
      false,
    )
    for (const [index, tenths] of [
      [3, 5n],
      [4, 9n],
      [5, 10n],
    ] as const) {
      vm.decadeIndex = index
      const expected = (quote * tenths) / 10n
      expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual([
        expected.toString(),
      ])
      await wrapper.setProps({ stampAmount: expected.toString() })
      expect(
        wrapper.get('[data-testid="chat-input-stamp-selection"]').text(),
      ).toContain(`(${expected} MON)`)
    }
    const custom = quote + 12345n
    await wrapper.setProps({ stampAmount: custom.toString() })
    expect(vm.sliderLabelValue).toContain(`(${custom} MON)`)
    expect(vm.stampMultiplier).toBe('≈1')
    vm.decadeIndex = 0
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['0'])
  })

  it('retains the live paid floor, explicit free choice, and no slider when the quote is unavailable', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        defaultStampWei: 1000n,
        minimumStampWei: 900n,
        stampAmount: '1000',
      },
      global: globalOptions,
    })
    const vm = wrapper.vm as any
    vm.decadeIndex = 3
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['900'])
    vm.decadeIndex = 0
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['0'])
    await wrapper.setProps({ defaultStampWei: undefined, stampAmount: '777' })
    expect(vm.sliderLabelValue).toContain('777 MON')
    expect(vm.stampMultiplier).toBe('77.7')
    vm.decadeIndex = 5
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['900'])
    vm.decadeIndex = 11
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['1000'])
    vm.innerStampAmount = '0'
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['0'])
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

describe('orders-of-magnitude stamp slider (Issue #819)', () => {
  it('correctly maps multipliers across 4 orders of magnitude in decadeIndex', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        minimumStampWei: 10n ** 16n,
        defaultStampWei: 10n ** 16n,
        defaultStampMode: false,
        stampAmount: (10n ** 16n).toString(),
      },
      global: globalOptions,
    })
    const vm = wrapper.vm as any
    // 1x default -> index 5
    expect(vm.decadeIndex).toBe(5)

    // Set to 10x (index 8)
    vm.decadeIndex = 8
    const emitted = wrapper.emitted('update:stampAmount')
    expect(emitted).toBeTruthy()
    // 10x of default stamp = 10^17 wei in test mock
    expect(emitted[0][0]).toBe((10n ** 17n).toString())
  })
})

it('discloses the basis of the AVU default stamp without attaching it to an explicit amount', async () => {
  const wrapper = mount(ChatInput, {
    props: {
      stampBasisNote: enUS.walletPanel.avuFeesExcluded,
      defaultStampMode: true,
    },
    global: globalOptions,
  })
  expect(wrapper.get('[data-testid="stamp-basis-note"]').text()).toBe(
    enUS.walletPanel.avuFeesExcluded,
  )
  await wrapper.setProps({ defaultStampMode: false })
  expect(wrapper.find('[data-testid="stamp-basis-note"]').exists()).toBe(false)
  wrapper.unmount()
})

describe('converged stamp suggestion and per-message override indicators (#820)', () => {
  beforeEach(() => {
    mockDecimals = true
  })
  afterEach(() => {
    mockDecimals = false
  })

  it('shows suggested vs overridden mode, peer last paid amount, upward adjustment marker, and clears typedStamp on send', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        message: 'Hello peer',
        minimumStampWei: 10n ** 16n,
        defaultStampWei: 10n ** 16n,
        suggestedStampWei: 2n * 10n ** 16n,
        lastPeerStampWei: 4n * 10n ** 16n,
        suggestedIncrease: true,
        defaultStampMode: true,
        stampAmount: '0.02',
      },
      global: globalOptions,
    })

    expect(wrapper.find('[data-testid="stamp-pill-increase"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.get('[data-testid="stamp-suggested-increase"]').text(),
    ).toContain(enUS.chatInput.stampSuggestedIncreaseNotice)
    expect(wrapper.get('[data-testid="stamp-mode-status"]').text()).toBe(
      enUS.chatInput.stampSuggestedMode,
    )
    expect(wrapper.get('[data-testid="stamp-last-peer-paid"]').text()).toBe(
      'Peer last paid: 40 mMON',
    )

    // User overrides the stamp for this message
    const vm = wrapper.vm as any
    vm.innerStampAmount = '0.05'
    expect(wrapper.emitted('update:stampAmount')?.at(-1)).toEqual(['0.05'])
    await wrapper.setProps({
      stampAmount: '0.05',
      defaultStampMode: false,
    })
    expect(wrapper.get('[data-testid="stamp-mode-status"]').text()).toBe(
      enUS.chatInput.stampOverriddenMode,
    )
    expect(wrapper.find('[data-testid="stamp-pill-increase"]').exists()).toBe(
      false,
    )

    // Sending clears typedStamp so the field reflects the reset suggestion for the next message
    vm.sendMessage()
    expect(wrapper.emitted('sendMessage')).toEqual([['Hello peer']])
    expect(vm.typedStamp).toBeNull()
    wrapper.unmount()
  })
})

describe('WebRTC call actions live in the menu and do not crowd the mobile input bar', () => {
  it('places audio and video call actions in the attachment menu without inline toolbar buttons, and marks empty input with chat-input-field--empty', async () => {
    const wrapper = mount(ChatInput, {
      props: { message: '' },
      global: globalOptions,
    })

    expect(wrapper.find('[data-testid="webrtc-audio-call-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="webrtc-video-call-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-icon="call"]').exists()).toBe(false)
    expect(wrapper.find('[data-icon="videocam"]').exists()).toBe(false)

    const inputField = wrapper.find('.chat-input-field')
    expect(inputField.classes()).toContain('chat-input-field--empty')

    await wrapper.setProps({ message: 'Hi' })
    expect(wrapper.find('.chat-input-field').classes()).not.toContain(
      'chat-input-field--empty',
    )

    const audioMenu = wrapper.find('[data-testid="webrtc-call-menu-item"]')
    const videoMenu = wrapper.find(
      '[data-testid="webrtc-video-call-menu-item"]',
    )
    expect(audioMenu.exists()).toBe(true)
    expect(videoMenu.exists()).toBe(true)

    await audioMenu.trigger('click')
    expect(wrapper.emitted('webrtcCallClicked')?.[0]).toEqual([
      { withVideo: false },
    ])

    await videoMenu.trigger('click')
    expect(wrapper.emitted('webrtcCallClicked')?.[1]).toEqual([
      { withVideo: true },
    ])

    expect(audioMenu.text()).toBe(enUS.chatInput.phoneCall)
    expect(
      wrapper.find('[data-testid="attach-calendar-vcard-menu-item"]').text(),
    ).toBe(enUS.chatInput.attachFile)
    expect(wrapper.find('[data-testid="games-submenu-item"]').exists()).toBe(
      true,
    )
    expect(
      wrapper.find('[data-testid="more-actions-submenu-item"]').exists(),
    ).toBe(true)
    wrapper.unmount()
  })
})
