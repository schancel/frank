/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import type { RpsItem } from '@frank/cashweb/types/messages'
import { rpsCommitment } from '@frank/wallet/message-item-plugins/rps/fair'
import ChatMessageRps from './ChatMessageRps.vue'

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

const salt = '5a'.repeat(16)
const commitHash = rpsCommitment('scissors', salt)
const STAKE = 10n ** 16n
const start: RpsItem = { type: 'rps', action: 'start', matchId: 'm1', commitHash }
const mine: RpsItem = {
  type: 'rps',
  action: 'move',
  matchId: 'm1',
  commitHash,
  playerMove: 'rock',
  wagerWei: STAKE.toString(),
}
const resolved: RpsItem = {
  type: 'rps',
  action: 'resolve',
  matchId: 'm1',
  commitHash,
  playerMove: 'rock',
  botMove: 'scissors',
  secretSalt: salt,
  wagerWei: STAKE.toString(),
  outcome: 'win',
}

function mountCard(item: RpsItem) {
  return mount(ChatMessageRps, {
    props: { item, address: '0x123' },
    global: { stubs: quasarStubs },
  })
}

function chat(...messages: { outbound: boolean; item: RpsItem; paid?: bigint }[]) {
  store.activeConversation = {
    messages: messages.map(m => ({
      outbound: m.outbound,
      items: [m.item],
      stampValueWei: m.paid ?? 0n,
    })),
  }
}

describe('ChatMessageRps.vue', () => {
  beforeEach(() => chat())

  test('a move answers the commitment the bot sent and carries the stake as its value', async () => {
    const wrapper = mountCard(start)
    expect(wrapper.text()).toContain(commitHash)
    await wrapper.find('[data-testid="rps-chip-0.05"]').trigger('click')
    await wrapper.find('[data-testid="rps-paper"]').trigger('click')
    const [payload] = wrapper.emitted('sendFollowUp')![0] as [any]
    expect(payload.stampValueWei).toBe(5n * 10n ** 16n)
    expect(payload.items).toEqual([
      {
        type: 'rps',
        action: 'move',
        matchId: 'm1',
        commitHash,
        playerMove: 'paper',
        wagerWei: (5n * 10n ** 16n).toString(),
      },
    ])
  })

  test('a free move carries no stake', async () => {
    const wrapper = mountCard(start)
    await wrapper.find('[data-testid="rps-rock"]').trigger('click')
    const [payload] = wrapper.emitted('sendFollowUp')![0] as [any]
    expect(payload.stampValueWei).toBeUndefined()
    expect(payload.items[0].wagerWei).toBe('0')
  })

  test('a match already played offers no second move', () => {
    chat({ outbound: true, item: mine })
    expect(mountCard(start).find('[data-testid="rps-rock"]').exists()).toBe(false)
  })

  test('an honest reveal of a match the player moved in shows as verified', () => {
    chat({ outbound: true, item: mine }, { outbound: false, item: resolved, paid: STAKE * 2n })
    const wrapper = mountCard(resolved)
    expect(wrapper.find('[data-testid="rps-verified"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rps-not-verified"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('YOU WIN')
  })

  test('a reveal that does not open the commitment shows NOT VERIFIED', () => {
    const forged: RpsItem = { ...resolved, botMove: 'paper', outcome: 'lose' }
    chat({ outbound: true, item: mine }, { outbound: false, item: forged })
    const wrapper = mountCard(forged)
    expect(wrapper.find('[data-testid="rps-verified"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="rps-not-verified"]').text()).toContain(
      'NOT VERIFIED',
    )
  })

  test('a result with no move of the player shows NOT VERIFIED', () => {
    chat({ outbound: false, item: resolved, paid: STAKE * 2n })
    expect(
      mountCard(resolved).find('[data-testid="rps-not-verified"]').exists(),
    ).toBe(true)
  })

  test('a win the message did not pay shows NOT VERIFIED', () => {
    chat({ outbound: true, item: mine }, { outbound: false, item: resolved, paid: STAKE })
    expect(
      mountCard(resolved).find('[data-testid="rps-not-verified"]').text(),
    ).toContain('not paid')
  })

  test('play again asks the bot for a new match', async () => {
    chat({ outbound: true, item: mine }, { outbound: false, item: resolved, paid: STAKE * 2n })
    const wrapper = mountCard(resolved)
    await wrapper.find('[data-testid="rps-play-again"]').trigger('click')
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/rps' }],
    })
  })
})
