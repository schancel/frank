/** @jest-environment jsdom */
// The challenge form: role and max bet, limited by what the challenger can actually spend.
import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, ref } from 'vue'

import enUS from '../../i18n/en-us'
import { HAND_FEE_RESERVE_WEI } from '../../utils/blackjack-hand'
import BlackjackChallengeForm from './BlackjackChallengeForm.vue'

const mockBalance = ref<bigint | null>(null)
const mockAvailable = ref<bigint | null>(null)
const mockAvailableLoaded = ref(true)
const mockAvailableError = ref(false)
const mockAvailableSupported = ref(true)
jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    balance: mockBalance,
    available: mockAvailable,
    availableLoaded: mockAvailableLoaded,
    availableError: mockAvailableError,
    availableSupported: mockAvailableSupported,
  }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => n.toString(),
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))
const stubs: Record<string, any> = Object.fromEntries(
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
stubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null },
  setup:
    (props, { attrs }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label as string,
      ),
})
stubs.QInput = defineComponent({
  inheritAttrs: false,
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (e: Event) =>
          emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
})
const t = (key: string, params: Record<string, unknown> = {}) =>
  String(key.split('.').reduce<any>((o, k) => o?.[k], enUS) ?? key).replace(
    /\{(\w+)\}/g,
    (_, name) => String(params[name]),
  )
const mountForm = (floorWei = 0n) =>
  mount(BlackjackChallengeForm as never, {
    global: {
      components: stubs,
      mocks: { $t: t },
      provide: { paymentFloorWei: () => floorWei },
    },
  })
const send = (w: ReturnType<typeof mountForm>) =>
  w.find('[data-testid="blackjack-challenge-send"]')
const error = (w: ReturnType<typeof mountForm>) =>
  w.find('[data-testid="blackjack-challenge-error"]')

describe('BlackjackChallengeForm', () => {
  beforeEach(() => {
    mockBalance.value = HAND_FEE_RESERVE_WEI + 40_000n
    mockAvailable.value = HAND_FEE_RESERVE_WEI + 4_000n
    mockAvailableLoaded.value = true
    mockAvailableError.value = false
    mockAvailableSupported.value = true
  })

  it('distinguishes the table limit from the later paid bet and makes pending preparation cancellable', async () => {
    const w = mountForm()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('100')
    expect(
      w.find('[data-testid="blackjack-challenge-review"]').text(),
    ).toContain('confirm your bet after')
    await w.setProps({ busy: true })
    expect(
      w.find('[data-testid="blackjack-challenge-pending"]').attributes('role'),
    ).toBe('status')
    expect(send(w).attributes('disabled')).toBeDefined()
    ;(w.vm as any).submit()
    expect(w.emitted('submit')).toBeUndefined()
    await w.find('[data-testid="blackjack-challenge-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    w.unmount()
  })

  it('a max bet below twice the payment floor is refused, naming the smallest bet', async () => {
    // Payment floor 300, so the smallest bet is 600: the rule the dealer bot applies too.
    const w = mountForm(300n)
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('599')
    expect(error(w).text()).toBe(
      'A bet cannot be below the smallest bet of 600 MON.',
    )
    expect(send(w).attributes('disabled')).toBeDefined()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('600')
    expect(error(w).exists()).toBe(false)
  })

  it('starts on the player role, the one a dealer bot can answer', () => {
    expect((mountForm().vm as any).role).toBe('player')
  })

  it('lets a dealer offer at most a quarter of its spendable balance', async () => {
    const w = mountForm()
    ;(w.vm as any).role = 'dealer'
    await w.vm.$nextTick()
    expect(
      w.find('[data-testid="blackjack-challenge-limit"]').text(),
    ).toContain('1000 MON')
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('1001')
    expect(error(w).text()).toContain('at most 1000')
    expect(send(w).attributes('disabled')).toBeDefined()
    await send(w).trigger('click')
    expect(w.emitted('submit')).toBeUndefined()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('1000')
    expect(error(w).exists()).toBe(false)
    await send(w).trigger('click')
    expect(w.emitted('submit')).toEqual([
      [{ role: 'dealer', maxBetWei: 1000n }],
    ])
  })

  it('lets a player name at most what it can send', async () => {
    const w = mountForm()
    ;(w.vm as any).role = 'player'
    await w.vm.$nextTick()
    expect(
      w.find('[data-testid="blackjack-challenge-limit"]').text(),
    ).toContain('4000 MON')
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('4001')
    expect(send(w).attributes('disabled')).toBeDefined()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('4000')
    await send(w).trigger('click')
    expect(w.emitted('submit')).toEqual([
      [{ role: 'player', maxBetWei: 4000n }],
    ])
  })

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['not a number', 'ten'],
    ['below the smallest bet', '9'],
  ])('refuses a max bet that is %s', async (_n, value) => {
    const w = mountForm(5n)
    await w.find('[data-testid="blackjack-challenge-max"]').setValue(value)
    expect(error(w).exists()).toBe(true)
    expect(send(w).attributes('disabled')).toBeDefined()
  })

  it('refuses everything while the balance is unknown or only covers the reserve', async () => {
    mockAvailable.value = null
    const w = mountForm()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('10')
    expect(send(w).attributes('disabled')).toBeDefined()
    mockAvailable.value = HAND_FEE_RESERVE_WEI
    await w.vm.$nextTick()
    expect(error(w).text()).toContain('at most 0')
  })
  it.each(['loading', 'error', 'unsupported'] as const)(
    'refuses %s capacity despite a large owned balance',
    async state => {
      mockAvailableLoaded.value = state !== 'loading'
      mockAvailableError.value = state === 'error'
      mockAvailableSupported.value = state !== 'unsupported'
      const w = mountForm()
      await w.find('[data-testid="blackjack-challenge-max"]').setValue('10')
      expect(send(w).attributes('disabled')).toBeDefined()
      ;(w.vm as any).submit()
      expect(w.emitted('submit')).toBeUndefined()
      w.unmount()
    },
  )
})
