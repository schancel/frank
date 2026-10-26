/** @jest-environment jsdom */
// The rock-paper-scissors challenge form: a stake below the smallest stake is said on the form,
// keeps Send challenge disabled, and a refused send names the minimum instead of a generic error.
import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import enUS from '../../i18n/en-us'
import RpsChallengeForm from './RpsChallengeForm.vue'

const notified: Error[] = []
/** What each notification shows: `safeMessage`, or the generic text when there is none. */
const shown: (string | undefined)[] = []
jest.mock('../../utils/notifications', () => ({
  errorNotify: (error: Error, options?: { safeMessage?: string }) => {
    notified.push(error)
    shown.push(options?.safeMessage)
  },
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
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
/** The floor in the lab on 2026-10-26: ten transfers at 102 gwei, 0.02142 MON. */
const LAB_FLOOR = 10n * 21_000n * 102_000_000_000n
const mountForm = () =>
  mount(RpsChallengeForm as never, {
    global: {
      components: stubs,
      mocks: { $t: t },
      provide: { paymentFloorWei: () => LAB_FLOOR },
    },
  })
const send = (w: ReturnType<typeof mountForm>) =>
  w.get('[data-testid="rps-challenge-send"]')
const stakeError = (w: ReturnType<typeof mountForm>) =>
  w.find('[data-testid="rps-challenge-stake-error"]')

beforeEach(() => {
  notified.length = 0
  shown.length = 0
})

describe('RpsChallengeForm', () => {
  it('starts at the smallest stake, which may be sent', async () => {
    const w = mountForm()
    expect(stakeError(w).exists()).toBe(false)
    expect(send(w).attributes('disabled')).toBeUndefined()
    await send(w).trigger('click')
    expect(w.emitted('submit')).toEqual([
      [{ move: 'rock', wagerWei: 2n * LAB_FLOOR }],
    ])
  })

  it('a stake below the smallest is said on the form, disables Send challenge, and a refused send names the minimum', async () => {
    const w = mountForm()
    const why = t('gameFairness.stakeBelowMinimum', { amount: '0.04284 MON' })
    await w.get('[data-testid="rps-challenge-wager-input"]').setValue('0.03')
    expect(stakeError(w).text()).toBe(why)
    expect(send(w).attributes('disabled')).toBeDefined()
    ;(w.vm as any).submit()
    expect(w.emitted('submit')).toBeUndefined()
    expect(notified.map(error => error.message)).toEqual([why])
    expect(shown).toEqual([why])
  })

  it('a stake that is not a number is said as such and cannot be sent', async () => {
    const w = mountForm()
    await w.get('[data-testid="rps-challenge-wager-input"]').setValue('lots')
    expect(stakeError(w).text()).toBe(t('gameFairness.rpsInvalidStake'))
    expect(send(w).attributes('disabled')).toBeDefined()
  })

  it('a free match is allowed', async () => {
    const w = mountForm()
    await w.get('[data-testid="rps-challenge-chip-free"]').trigger('click')
    expect(stakeError(w).exists()).toBe(false)
    await send(w).trigger('click')
    expect(w.emitted('submit')).toEqual([[{ move: 'rock', wagerWei: 0n }]])
  })
})
