/** @jest-environment jsdom */
// The challenge form: role and max bet, limited by what the challenger can actually spend.
import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, ref } from 'vue'

import enUS from '../../i18n/en-us'
import { HAND_FEE_RESERVE_WEI } from '../../utils/blackjack-hand'
import BlackjackChallengeForm from './BlackjackChallengeForm.vue'

const mockBalance = ref<bigint | null>(null)
jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({ balance: mockBalance }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultStampValue: 10n,
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
const mountForm = () =>
  mount(BlackjackChallengeForm as never, {
    global: { components: stubs, mocks: { $t: t } },
  })
const send = (w: ReturnType<typeof mountForm>) =>
  w.find('[data-testid="blackjack-challenge-send"]')
const error = (w: ReturnType<typeof mountForm>) =>
  w.find('[data-testid="blackjack-challenge-error"]')

describe('BlackjackChallengeForm', () => {
  beforeEach(() => {
    mockBalance.value = HAND_FEE_RESERVE_WEI + 4_000n
  })

  it('lets a dealer offer at most a quarter of its spendable balance', async () => {
    const w = mountForm()
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
    ['below the minimum stamp', '9'],
  ])('refuses a max bet that is %s', async (_n, value) => {
    const w = mountForm()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue(value)
    expect(error(w).exists()).toBe(true)
    expect(send(w).attributes('disabled')).toBeDefined()
  })

  it('refuses everything while the balance is unknown or only covers the reserve', async () => {
    mockBalance.value = null
    const w = mountForm()
    await w.find('[data-testid="blackjack-challenge-max"]').setValue('10')
    expect(send(w).attributes('disabled')).toBeDefined()
    mockBalance.value = HAND_FEE_RESERVE_WEI
    await w.vm.$nextTick()
    expect(error(w).text()).toContain('at most 0')
  })
})
