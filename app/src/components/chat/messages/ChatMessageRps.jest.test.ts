/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import type { RpsItem } from '@frank/cashweb/types/messages'
import ChatMessageRps from './ChatMessageRps.vue'

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
          [props.label as string | undefined, slots.default?.()],
        )
    },
  })
}

const quasarStubs: Record<string, any> = Object.fromEntries(
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

quasarStubs.QBtn = defineComponent({
  inheritAttrs: false,
  props: { label: null, disable: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, disabled: !!props.disable },
        props.label ? [props.label as string] : slots.default?.(),
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

describe('ChatMessageRps.vue', () => {
  test('renders match start with commitment and allows move selection', async () => {
    const item: RpsItem = {
      type: 'rps',
      action: 'start',
      commitHash: 'deadbeef12345678',
      wagerWei: '50000000000000000',
    }

    const wrapper = mount(ChatMessageRps, {
      props: {
        item,
        address: '0x123',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('Rock-Paper-Scissors Arena')
    expect(wrapper.text()).toContain('0xdeadbeef12345678')
    expect(wrapper.text()).toContain('Wager: 0.05 MON')

    // Click Rock
    const rockBtn = wrapper.find('[data-testid="rps-rock"]')
    expect(rockBtn.exists()).toBe(true)
    await rockBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/rock' }],
    })
  })

  test('renders resolved match with outcome and allows Play Again with selectable wager', async () => {
    const item: RpsItem = {
      type: 'rps',
      action: 'resolve',
      playerMove: 'rock',
      botMove: 'scissors',
      outcome: 'win',
      commitHash: 'deadbeef',
      secretSalt: 'salt123',
      wagerWei: '50000000000000000',
      txHash: '0xabcdef987654321',
    }

    const wrapper = mount(ChatMessageRps, {
      props: {
        item,
        address: '0x123',
      },
      global: {
        stubs: quasarStubs,
      },
    })

    expect(wrapper.text()).toContain('YOU WIN!')
    expect(wrapper.text()).toContain('🪨 Rock')
    expect(wrapper.text()).toContain('✂️ Scissors')
    expect(wrapper.text()).toContain('Payout sent!')

    // Select 0.1 MON chip
    const chip01 = wrapper.find('[data-testid="rps-chip-0.1"]')
    expect(chip01.exists()).toBe(true)
    await chip01.trigger('click')

    // Click Play Again
    const playAgainBtn = wrapper.find('[data-testid="rps-play-again"]')
    expect(playAgainBtn.exists()).toBe(true)
    await playAgainBtn.trigger('click')

    expect(wrapper.emitted('sendFollowUp')).toHaveLength(1)
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/rps 0.1' }],
    })
  })
})
