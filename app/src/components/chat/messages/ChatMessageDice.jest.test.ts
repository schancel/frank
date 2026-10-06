/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'
import ChatMessageDice from './ChatMessageDice.vue'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
  },
}))

function passthrough(tag: string) {
  return defineComponent({
    props: { modelValue: null, label: null },
    emits: ['click'],
    setup(props, { slots, emit }) {
      return () =>
        h(
          tag,
          {
            onClick: () => emit('click'),
          },
          [props.label as string | undefined, slots.default?.()]
        )
    },
  })
}

const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter((n) => /^Q[A-Z]/.test(n))
    .map((n) => [
      n,
      defineComponent({
        setup:
          (_, { slots }) =>
          () =>
            h('div', slots.default?.()),
      }),
    ])
)

quasarStubs.QBadge = defineComponent({
  inheritAttrs: false,
  props: { label: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'span',
        attrs,
        props.label ? [props.label as string] : slots.default?.()
      ),
})

quasarStubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label ? [props.label as string] : slots.default?.()
      ),
})

quasarStubs.QInput = defineComponent({
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

describe('ChatMessageDice.vue', () => {
  test('renders interactive roll controls with selectable wager and odds', async () => {
    const item: SatoshiDiceItem = {
      type: 'dice',
      action: 'table',
    }

    const wrapper = mount(ChatMessageDice, {
      props: {
        item,
        address: '0x123',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Satoshi Dice')
    expect(wrapper.text()).toContain('1.9% House Edge')
    expect(wrapper.text()).toContain('Select Target & Odds')
    expect(wrapper.text()).toContain('Select Wager')

    // Select 4-to-1 preset (16384)
    const preset4to1 = wrapper.find('[data-testid="dice-preset-16384"]')
    expect(preset4to1.exists()).toBe(true)
    await preset4to1.trigger('click')

    // Select 0.05 MON wager chip
    const chip005 = wrapper.find('[data-testid="dice-chip-0.05"]')
    expect(chip005.exists()).toBe(true)
    await chip005.trigger('click')

    // Click Roll Satoshi Dice
    const rollBtn = wrapper.find('[data-testid="dice-roll-btn"]')
    expect(rollBtn.exists()).toBe(true)
    await rollBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/roll 0.05 16384' }],
    })
  })

  test('renders roll result with lucky number, outcome, and fairness proof', async () => {
    const item: SatoshiDiceItem = {
      type: 'dice',
      action: 'result',
      target: 32768,
      luckyNumber: 12345,
      isWin: true,
      payoutWei: '19620000000000000',
      serverSecret: 'secretabc',
      userNonce: 'noncexyz',
      txHash: '0xmockhash123',
    }

    const wrapper = mount(ChatMessageDice, {
      props: {
        item,
        address: '0x123',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('YOU WIN!')
    expect(wrapper.text()).toContain('12345')
    expect(wrapper.text()).toContain('Payout: 0.01962 MON')
    expect(wrapper.text()).toContain('secretabc')
    expect(wrapper.text()).toContain('noncexyz')
  })
})
