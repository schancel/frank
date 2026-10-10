/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'
import {
  diceCommitment,
  dicePayoutWei,
  diceRoll,
} from '@frank/wallet/message-item-plugins/dice/fair'
import enUS from '../../../i18n/en-us'
import ChatMessageDice from './ChatMessageDice.vue'

const t = (key: string, params: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<any>((o, k) => o?.[k], enUS) as string
  return String(text ?? key).replace(/\{(\w+)\}/g, (_, name) =>
    String(params[name]),
  )
}

const store: { activeConversation: { messages: any[] } } = reactive({
  activeConversation: { messages: [] },
})
jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
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

quasarStubs.QBadge = defineComponent({
  inheritAttrs: false,
  props: { label: null },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'span',
        attrs,
        props.label ? [props.label as string] : slots.default?.(),
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

const secret = '5a'.repeat(32)
const commitment = diceCommitment(secret)
const STAKE = 10n ** 16n

function mountCard(item: SatoshiDiceItem) {
  return mount(ChatMessageDice, {
    props: { item, address: '0x123' },
    global: { stubs: quasarStubs, mocks: { $t: t } },
  })
}

/** A bet of the player's on roll `r1` and the bot's honest result for it. */
function played(seed = 'c3'.repeat(16)) {
  const bet: SatoshiDiceItem = {
    type: 'dice',
    action: 'roll',
    rollId: 'r1',
    commitment,
    clientSeed: seed,
    target: 65535,
    wagerWei: STAKE.toString(),
  }
  const luckyNumber = diceRoll(secret, seed)
  const isWin = luckyNumber < 65535
  const payout = isWin ? dicePayoutWei(STAKE, 65535) : 0n
  const result: SatoshiDiceItem = {
    type: 'dice',
    action: 'result',
    rollId: 'r1',
    commitment,
    clientSeed: seed,
    target: 65535,
    wagerWei: STAKE.toString(),
    serverSecret: secret,
    luckyNumber,
    isWin,
    payoutWei: payout.toString(),
    nextRollId: 'r2',
    nextCommitment: diceCommitment('6b'.repeat(32)),
  }
  return { bet, result, payout }
}

function chat(
  ...messages: { outbound: boolean; item: SatoshiDiceItem; paid?: bigint }[]
) {
  store.activeConversation = {
    messages: messages.map(m => ({
      outbound: m.outbound,
      items: [m.item],
      stampValueWei: m.paid ?? 0n,
    })),
  }
}

describe('ChatMessageDice.vue', () => {
  beforeEach(() => chat())

  test('a bet names the commitment the bot published, adds a random value, and carries the stake as its value', async () => {
    const wrapper = mountCard({
      type: 'dice',
      action: 'table',
      rollId: 'r1',
      commitment,
    })
    await wrapper.find('[data-testid="dice-preset-16384"]').trigger('click')
    await wrapper.find('[data-testid="dice-chip-0.05"]').trigger('click')
    await wrapper.find('[data-testid="dice-roll-btn"]').trigger('click')

    const [payload] = wrapper.emitted('sendFollowUp')![0] as [any]
    expect(payload.stampValueWei).toBe(5n * 10n ** 16n)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      type: 'dice',
      action: 'roll',
      rollId: 'r1',
      commitment,
      target: 16384,
      wagerWei: (5n * 10n ** 16n).toString(),
    })
    expect(payload.items[0].clientSeed).toMatch(/^[0-9a-f]{32}$/)
  })

  test('a table with no commitment offers nothing to bet on', () => {
    const wrapper = mountCard({ type: 'dice', action: 'table' })
    expect(wrapper.find('[data-testid="dice-roll-btn"]').exists()).toBe(false)
  })

  test('an honest result of a bet the player made shows as verified', () => {
    const { bet, result, payout } = played()
    chat(
      { outbound: true, item: bet, paid: STAKE },
      { outbound: false, item: result, paid: payout },
    )
    const wrapper = mountCard(result)
    expect(wrapper.find('[data-testid="dice-verified"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="dice-not-verified"]').exists()).toBe(
      false,
    )
    expect(wrapper.text()).toContain(String(result.luckyNumber))
  })

  test('a forged reveal shows NOT VERIFIED', () => {
    const { bet, result, payout } = played()
    const forged = { ...result, serverSecret: '7c'.repeat(32) }
    chat(
      { outbound: true, item: bet },
      { outbound: false, item: forged, paid: payout },
    )
    const wrapper = mountCard(forged)
    expect(wrapper.find('[data-testid="dice-verified"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dice-not-verified"]').text()).toContain(
      'NOT VERIFIED',
    )
  })

  test('a result for a bet the player never made shows NOT VERIFIED', () => {
    const { result } = played()
    chat({ outbound: false, item: result })
    expect(
      mountCard(result).find('[data-testid="dice-not-verified"]').exists(),
    ).toBe(true)
  })

  test('a commitment the bot used for two rolls shows NOT VERIFIED', () => {
    const { bet, result, payout } = played()
    chat(
      { outbound: true, item: bet },
      { outbound: false, item: result, paid: payout },
      { outbound: false, item: { ...result, rollId: 'r9' }, paid: payout },
    )
    expect(
      mountCard(result).find('[data-testid="dice-not-verified"]').text(),
    ).toContain('more than one roll')
  })

  test('a payout the message did not carry shows NOT VERIFIED', () => {
    const { bet, result } = played()
    chat(
      { outbound: true, item: bet },
      { outbound: false, item: result, paid: 0n },
    )
    expect(
      mountCard(result).find('[data-testid="dice-not-verified"]').text(),
    ).toContain('not paid')
  })

  test('a roll already bet on cannot be bet on again from the card', () => {
    const { bet } = played()
    chat({ outbound: true, item: bet })
    const wrapper = mountCard({
      type: 'dice',
      action: 'table',
      rollId: 'r1',
      commitment,
    })
    expect(
      wrapper.find('[data-testid="dice-roll-btn"]').attributes('disabled'),
    ).toBeDefined()
  })
})
