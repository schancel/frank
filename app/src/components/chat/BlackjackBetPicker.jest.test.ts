/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createApp, defineComponent, h, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { LevelDB } from 'level'

import BlackjackBetPicker from './BlackjackBetPicker.vue'
import enUS from '../../i18n/en-us'
import frFR from '../../i18n/fr-fr'
import { createStoragePlugin } from '../../boot/pinia'
import { useUnsentWagersStore } from '../../stores/unsent-wagers'

const DEALER = '0x1234567890abcdef1234567890abcdef1234abcd'
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
    defaultStampValue: 10n ** 16n,
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
const QCheckbox = defineComponent({
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('label', [
        h('input', {
          type: 'checkbox',
          checked: props.modelValue,
          disabled: props.disable,
          onChange: (e: Event) =>
            emit('update:modelValue', (e.target as HTMLInputElement).checked),
        }),
        props.label,
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

type Wrapper = ReturnType<typeof mountPicker>['wrapper']

let storageData: Record<string, string>
let failPut = false
function fakeStorage(): LevelDB {
  return {
    put: (k: string, v: string) =>
      failPut
        ? Promise.reject(new Error('disk full'))
        : ((storageData[k] = v), Promise.resolve()),
    get: (k: string) =>
      k in storageData
        ? Promise.resolve(storageData[k])
        : Promise.reject(new Error('not found')),
  } as unknown as LevelDB
}
function installPinia() {
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      fakeStorage(),
      Promise.resolve({ networkName: 'n', version: 1 }),
    ),
  )
  // Pinia only runs plugins once it is installed in an app.
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}

function mountPicker(
  overrides: {
    submit?: jest.Mock
    busy?: boolean
    messages?: unknown
    pinia?: ReturnType<typeof createPinia>
  } = {},
) {
  const submit = overrides.submit ?? jest.fn().mockResolvedValue(undefined)
  const wrapper = mount(BlackjackBetPicker, {
    attachTo: document.body,
    props: {
      address: DEALER,
      dealerName: 'Blackjack Dealer',
      submit,
      busy: overrides.busy ?? false,
    },
    global: {
      plugins: [overrides.pinia ?? installPinia()],
      components: { QInput, QBtn, QCheckbox },
      mocks: {
        $t: (key: string, params?: Record<string, string>) =>
          t(overrides.messages ?? enUS, key, params),
      },
    },
  })
  return { wrapper, submit }
}

const setAmount = async (w: Wrapper, v: string) => {
  await w.find('input:not([type="checkbox"])').setValue(v)
}
const confirm = async (w: Wrapper) => {
  await w.find('input[type="checkbox"]').setValue(true)
}
const button = (w: Wrapper) => w.find('[data-testid="blackjack-bet-submit"]')
const status = (w: Wrapper) => w.find('[role="status"]').text()
const flush = () => flushPromises()
const stored = () =>
  JSON.parse(storageData.unsentWagers ?? '{"wagers":[]}').wagers
async function place(w: Wrapper, amount?: string) {
  if (amount) await setAmount(w, amount)
  await confirm(w)
  await w.find('form').trigger('submit')
  await flush()
}

describe('BlackjackBetPicker (ticket #310: first bet entry point)', () => {
  beforeEach(() => {
    balance.value = 5n * 10n ** 18n
    storageData = {}
    failPut = false
    mockGetWallet.mockReset().mockResolvedValue({ wallet: true })
    mockSend.mockReset().mockResolvedValue({ txHash: `0x${'ab'.repeat(32)}` })
    mockErrorNotify.mockReset()
    document.body.innerHTML = ''
  })

  it('is labelled, names the recipient, shows limits in MON (never wei), has a live region and no autofocus', () => {
    const { wrapper } = mountPicker()
    expect(wrapper.find('label').text()).toBe('Bet amount')
    expect(
      wrapper.find('input:not([type="checkbox"])').attributes('aria-label'),
    ).toBe('Bet amount in MON')
    expect(wrapper.find('.hint').text()).toBe('Table limits: 0.01 to 1 MON')
    expect(wrapper.text()).toContain(
      'transfer of MON to Blackjack Dealer (0x1234...abcd)',
    )
    expect(wrapper.text()).not.toMatch(/\d{9,}/)
    expect(wrapper.find('[role="status"]').attributes('aria-live')).toBe(
      'polite',
    )
    expect(button(wrapper).text()).toBe(
      'Deal me in with Blackjack Dealer 0x1234...abcd (0.1 MON)',
    )
    expect(wrapper.find('input').attributes('autofocus')).toBeUndefined()
  })

  it('requires an explicit confirmation: Enter or a click before it sends nothing', async () => {
    const { wrapper, submit } = mountPicker()
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit') // what Enter in the input does
    await button(wrapper).trigger('click')
    await flush()
    expect(mockSend).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    await confirm(wrapper)
    expect(wrapper.text()).toContain(
      'I understand 0.1 MON will be sent to Blackjack Dealer (0x1234...abcd)',
    )
    expect(button(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('changing the amount withdraws the confirmation', async () => {
    const { wrapper } = mountPicker()
    await confirm(wrapper)
    await setAmount(wrapper, '0.2')
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    await flush()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('places the first bet: one transfer, a durable record first, then one bet item, then the record is removed', async () => {
    const pinia = installPinia()
    const store = useUnsentWagersStore()
    await store.restored
    let recordedBeforeSend: unknown[] = []
    const submit = jest.fn(async () => {
      recordedBeforeSend = stored()
    })
    const { wrapper } = mountPicker({ submit, pinia })
    await place(wrapper, '0.25')
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith({
      wallet: { wallet: true },
      recipient: { raw: DEALER },
      value: 250000000000000000n,
    })
    expect(recordedBeforeSend).toEqual([
      expect.objectContaining({
        wagerTxHash: `0x${'ab'.repeat(32)}`,
        dealerAddress: DEALER,
        amountWei: '250000000000000000',
      }),
    ])
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
    expect(stored()).toEqual([])
    expect(wrapper.emitted('placed')).toHaveLength(1)
    expect(status(wrapper)).toBe('Bet sent. Waiting for the dealer to deal.')
  })

  it('does not double-submit: repeated submits and clicks while pending send one transfer', async () => {
    let release!: (v: { txHash: string }) => void
    mockSend.mockReturnValue(new Promise(r => (release = r)))
    const { wrapper, submit } = mountPicker()
    await confirm(wrapper)
    const form = wrapper.find('form')
    void form.trigger('submit')
    void form.trigger('submit')
    await button(wrapper).trigger('click')
    await flush()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(status(wrapper)).toBe('Sending your bet…')
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('form').attributes('aria-busy')).toBe('true')
    void form.trigger('submit')
    release({ txHash: `0x${'cd'.repeat(32)}` })
    await flush()
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('pendingChange')).toEqual([[true], [false]])
  })

  it('stays locked while the message send itself is pending', async () => {
    let finish!: () => void
    const submit = jest.fn(() => new Promise<void>(r => (finish = r)))
    const { wrapper } = mountPicker({ submit })
    await place(wrapper)
    expect(submit).toHaveBeenCalledTimes(1)
    // The record exists but is "in flight": no stranded-wager alarm during a normal send.
    expect(useUnsentWagersStore().wagers).toHaveLength(1)
    expect(useUnsentWagersStore().stranded(DEALER)).toHaveLength(0)
    await wrapper.find('form').trigger('submit')
    expect(mockSend).toHaveBeenCalledTimes(1)
    finish()
    await flush()
    expect(wrapper.emitted('placed')).toHaveLength(1)
  })

  it('still delivers the bet message if the picker unmounts while the transfer confirms', async () => {
    let release!: (v: { txHash: string }) => void
    mockSend.mockReturnValue(new Promise(r => (release = r)))
    const { wrapper, submit } = mountPicker()
    await confirm(wrapper)
    await wrapper.find('form').trigger('submit')
    wrapper.unmount()
    release({ txHash: `0x${'ef'.repeat(32)}` })
    await flush()
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
      await confirm(wrapper)
      expect(wrapper.find('[role="alert"]').text()).toBe(message)
      expect(button(wrapper).attributes('disabled')).toBeDefined()
      await wrapper.find('form').trigger('submit')
      await flush()
      expect(mockSend).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    },
  )

  it('requires balance >= bet + stamp + fee reserve (a bet just under the balance is refused)', async () => {
    // 0.1 bet + 0.01 default stamp + 0.05 reserve = 0.16 MON needed
    balance.value = 159999999999999999n
    const { wrapper } = mountPicker()
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'this bet needs 0.16 MON',
    )
    await confirm(wrapper)
    await wrapper.find('form').trigger('submit')
    await flush()
    expect(mockSend).not.toHaveBeenCalled()
    balance.value = 160000000000000000n
    await flush()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('counts the stamp the player configured, not just the default', async () => {
    balance.value = 200000000000000000n // 0.2: enough with the 0.01 default stamp
    const pinia = installPinia()
    const wrapper = mount(BlackjackBetPicker, {
      props: {
        address: DEALER,
        dealerName: 'D',
        submit: jest.fn(),
        stampWei: 10n ** 17n, // 0.1 stamp -> 0.1 + 0.1 + 0.05 = 0.25 needed
      },
      global: {
        plugins: [pinia],
        components: { QInput, QBtn, QCheckbox },
        mocks: { $t: (k: string, p?: Record<string, string>) => t(enUS, k, p) },
      },
    })
    expect(wrapper.find('[role="alert"]').text()).toContain('needs 0.25 MON')
  })

  it('blocks with a clear message while the balance is unknown', async () => {
    balance.value = null
    const { wrapper } = mountPicker()
    expect(wrapper.find('[role="alert"]').text()).toBe(
      'Your balance is not loaded yet. Try again in a moment.',
    )
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('announces an insufficient-funds failure with no record and no bet; a retry makes a fresh transfer', async () => {
    mockSend.mockRejectedValueOnce(new Error('insufficient funds for gas'))
    const { wrapper, submit } = mountPicker()
    await place(wrapper)
    expect(status(wrapper)).toBe(
      'Insufficient funds: insufficient funds for gas',
    )
    expect(wrapper.find('[role="status"]').classes()).toContain('text-negative')
    expect(submit).not.toHaveBeenCalled()
    expect(stored()).toEqual([])
    expect(mockErrorNotify).toHaveBeenCalledTimes(1)
    // The confirmation does not carry over to a second attempt.
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await place(wrapper)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(status(wrapper)).toBe('Bet sent. Waiting for the dealer to deal.')
  })

  it('never says sent when delivery fails: the wager stays recorded as unsent and the menu is releasable', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('relay down'))
    const { wrapper } = mountPicker({ submit })
    await place(wrapper)
    expect(status(wrapper)).toContain(
      'Wager paid, bet not delivered: relay down',
    )
    expect(status(wrapper)).not.toContain('Bet sent')
    expect(wrapper.emitted('placed')).toBeUndefined()
    expect(wrapper.emitted('pendingChange')).toEqual([[true], [false]])
    expect(stored()).toEqual([
      expect.objectContaining({ wagerTxHash: `0x${'ab'.repeat(32)}` }),
    ])
    expect(useUnsentWagersStore().stranded(DEALER)).toHaveLength(1)
  })

  it('an unsent record blocks a NEW wager to that dealer (no second transfer without action on the record)', async () => {
    const submit = jest.fn().mockRejectedValue(new Error('relay down'))
    const { wrapper } = mountPicker({ submit })
    await place(wrapper)
    await setAmount(wrapper, '0.2')
    await confirm(wrapper)
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    await flush()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('a storage failure after payment still attempts delivery and reports the tx hash', async () => {
    failPut = true
    const submit = jest.fn().mockRejectedValue(new Error('relay down'))
    const { wrapper } = mountPicker({ submit })
    await place(wrapper)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(status(wrapper)).toContain(`0x${'ab'.repeat(32)}`)
  })

  it('does not start a transfer while the chat is busy sending', async () => {
    const { wrapper, submit } = mountPicker({ busy: true })
    expect(button(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    await flush()
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
    expect(button(wrapper).text()).toBe(
      'Distribuez-moi avec Blackjack Dealer 0x1234...abcd (0.1 MON)',
    )
  })
})
