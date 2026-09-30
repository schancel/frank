/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import BlackjackBetPicker from './BlackjackBetPicker.vue'
import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'

const DEALER = '0xDealer'
const balance = ref<bigint | null>(null)

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({ balance }),
}))
const mockGetWallet = jest.fn()
jest.mock('../../composables/useActiveWallet', () => ({
  useActiveWallet: () => mockGetWallet(),
}))
const mockErrorNotify = jest.fn()
jest.mock('../../utils/notifications', () => ({
  errorNotify: (e: unknown) => mockErrorNotify(e),
}))
const mockSend = jest.fn()
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => {
      const s = n.toString().padStart(19, '0')
      return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '')
    },
    fromDisplayAmount: (s: string) => {
      const [whole, frac = ''] = s.split('.')
      if (frac.length > 18) throw new Error('too many decimals')
      return BigInt((whole || '0') + frac.padEnd(18, '0'))
    },
    nativeTransfers: { send: (args: unknown) => mockSend(args) },
  },
}))

function t(
  messages: unknown,
  key: string,
  params: Record<string, string> = {},
) {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`)
    : key
}

// Quasar renders nothing under the SSR build Jest aliases to: minimal real-element stand-ins that
// keep the attributes the component's behavior and accessibility depend on.
const QInput = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    label: { type: String, default: '' },
    hint: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    error: { type: Boolean, default: false },
    disable: { type: Boolean, default: false },
    inputAttrs: { type: Object, default: () => ({}) },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('div', [
        h('label', props.label),
        h('input', {
          value: props.modelValue,
          disabled: props.disable,
          ...props.inputAttrs,
          onInput: (e: Event) =>
            emit('update:modelValue', (e.target as HTMLInputElement).value),
        }),
        h('div', { class: 'hint' }, props.hint),
        props.error ? h('div', { role: 'alert' }, props.errorMessage) : null,
      ])
  },
})
const QBtn = defineComponent({
  props: {
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: 'button' },
  },
  setup(props) {
    return () =>
      h(
        'button',
        {
          'type': props.type,
          'disabled': props.disable,
          'aria-busy': props.loading ? 'true' : 'false',
        },
        props.label,
      )
  },
})

function mountPicker(
  overrides: {
    submit?: jest.Mock
    busy?: boolean
    messages?: unknown
  } = {},
) {
  const submit = overrides.submit ?? jest.fn().mockResolvedValue(undefined)
  const wrapper = mount(BlackjackBetPicker, {
    attachTo: document.body,
    props: { address: DEALER, submit, busy: overrides.busy ?? false },
    global: {
      components: { QInput, QBtn },
      mocks: {
        $t: (key: string, params?: Record<string, string>) =>
          t(overrides.messages ?? enUS, key, params),
      },
    },
  })
  return { wrapper, submit }
}

const setAmount = async (
  w: ReturnType<typeof mountPicker>['wrapper'],
  v: string,
) => {
  await w.find('input').setValue(v)
}
const button = (w: ReturnType<typeof mountPicker>['wrapper']) =>
  w.find('[data-testid="blackjack-bet-submit"]')
const status = (w: ReturnType<typeof mountPicker>['wrapper']) =>
  w.find('[role="status"]').text()

describe('BlackjackBetPicker (ticket #310: first bet entry point)', () => {
  beforeEach(() => {
    balance.value = null
    mockGetWallet.mockReset().mockResolvedValue({ wallet: true })
    mockSend.mockReset().mockResolvedValue({ txHash: `0x${'ab'.repeat(32)}` })
    mockErrorNotify.mockReset()
    document.body.innerHTML = ''
  })

  it('is labelled, shows the table limits in MON with decimals (never wei) and has a live region', () => {
    const { wrapper } = mountPicker()
    expect(wrapper.find('label').text()).toBe('Bet amount')
    expect(wrapper.find('input').attributes('aria-label')).toBe(
      'Bet amount in MON',
    )
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.01 to 1 MON')
    expect(wrapper.text()).not.toMatch(/\d{9,}/)
    const live = wrapper.find('[role="status"]')
    expect(live.attributes('aria-live')).toBe('polite')
    expect(button(wrapper).text()).toBe('Deal me in (0.1 MON)')
  })

  it('places the first bet: one wager transfer to the dealer, then one bet item naming it', async () => {
    const { wrapper, submit } = mountPicker()
    await setAmount(wrapper, '0.25')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith({
      wallet: { wallet: true },
      recipient: { raw: DEALER },
      value: 250000000000000000n,
    })
    expect(submit).toHaveBeenCalledTimes(1)
    const payload = submit.mock.calls[0][0]
    expect(payload.address).toBe(DEALER)
    expect(payload.items).toEqual([
      {
        type: 'blackjack-move',
        gameId: expect.stringMatching(/^bj-\d+-[a-z0-9]+$/),
        action: 'bet',
        wagerTxHash: `0x${'ab'.repeat(32)}`,
      },
    ])
    expect(wrapper.emitted('placed')).toHaveLength(1)
    expect(status(wrapper)).toBe('Bet sent. Waiting for the dealer to deal.')
  })

  it('does not double-submit: repeated submits and clicks while pending send one transfer', async () => {
    let release!: (v: { txHash: string }) => void
    mockSend.mockReturnValue(new Promise(r => (release = r)))
    const { wrapper, submit } = mountPicker()
    const form = wrapper.find('form')
    void form.trigger('submit')
    void form.trigger('submit')
    await button(wrapper).trigger('click')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(status(wrapper)).toBe('Sending your bet…')
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('form').attributes('aria-busy')).toBe('true')
    void form.trigger('submit')
    release({ txHash: `0x${'cd'.repeat(32)}` })
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('pendingChange')).toEqual([[true], [false]])
  })

  it('stays locked while the message send itself is pending', async () => {
    let finish!: () => void
    const submit = jest.fn(() => new Promise<void>(r => (finish = r)))
    const { wrapper } = mountPicker({ submit })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(submit).toHaveBeenCalledTimes(1)
    await wrapper.find('form').trigger('submit')
    expect(mockSend).toHaveBeenCalledTimes(1)
    finish()
    await flushPromises()
    expect(wrapper.emitted('placed')).toHaveLength(1)
  })

  it('still delivers the bet message if the picker unmounts while the transfer confirms', async () => {
    let release!: (v: { txHash: string }) => void
    mockSend.mockReturnValue(new Promise(r => (release = r)))
    const { wrapper, submit } = mountPicker()
    await wrapper.find('form').trigger('submit')
    wrapper.unmount()
    release({ txHash: `0x${'ef'.repeat(32)}` })
    await flushPromises()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0].items[0].wagerTxHash).toBe(
      `0x${'ef'.repeat(32)}`,
    )
  })

  it.each([
    ['0', 'Bet must be greater than zero'],
    ['0.005', 'Bet is below the table minimum (0.01 MON)'],
    ['1.5', 'Bet is above the table maximum (1 MON)'],
    ['abc', 'Enter a bet as a plain decimal number'],
    ['', 'Enter a bet as a plain decimal number'],
    ['0.1234567890123456789', 'Enter a valid MON amount to bet'],
  ])(
    'refuses %j before any value leaves the wallet',
    async (amount, message) => {
      const { wrapper, submit } = mountPicker()
      await setAmount(wrapper, amount)
      expect(wrapper.find('[role="alert"]').text()).toBe(message)
      expect(button(wrapper).attributes('disabled')).toBeDefined()
      await wrapper.find('form').trigger('submit')
      await flushPromises()
      expect(mockSend).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    },
  )

  it('refuses a bet larger than the known balance, allows one when the balance is unknown', async () => {
    balance.value = 50000000000000000n // 0.05
    const { wrapper } = mountPicker()
    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Bet is more than your balance',
    )
    await wrapper.find('form').trigger('submit')
    expect(mockSend).not.toHaveBeenCalled()
    await setAmount(wrapper, '0.05')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    balance.value = null
    await setAmount(wrapper, '0.9')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('announces an insufficient-funds failure, sends no bet, and a retry makes a fresh transfer', async () => {
    mockSend.mockRejectedValueOnce(new Error('insufficient funds for gas'))
    const { wrapper, submit } = mountPicker()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(status(wrapper)).toBe(
      'Insufficient funds: insufficient funds for gas',
    )
    expect(wrapper.find('[role="status"]').classes()).toContain('text-negative')
    expect(submit).not.toHaveBeenCalled()
    expect(mockErrorNotify).toHaveBeenCalledTimes(1)
    expect(button(wrapper).attributes('disabled')).toBeUndefined()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(status(wrapper)).toBe('Bet sent. Waiting for the dealer to deal.')
  })

  it('announces a send failure after the wager was paid', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('relay down'))
    const { wrapper } = mountPicker({ submit })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(status(wrapper)).toBe('Could not place the bet: relay down')
    expect(wrapper.emitted('placed')).toBeUndefined()
  })

  it('does not start a transfer while the chat is busy sending', async () => {
    const { wrapper, submit } = mountPicker({ busy: true })
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mockSend).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('renders in French with no untranslated keys', () => {
    const { wrapper } = mountPicker({ messages: frFR })
    expect(wrapper.find('label').text()).toBe('Montant de la mise')
    expect(wrapper.find('.hint').text()).toBe(
      'Limites de la table : 0.01 à 1 MON',
    )
    expect(wrapper.text()).not.toContain('blackjackBet.')
    expect(button(wrapper).text()).toBe('Distribuez-moi (0.1 MON)')
  })
})
