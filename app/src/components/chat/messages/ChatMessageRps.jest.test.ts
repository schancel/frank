/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import type { RpsItem } from '@frank/cashweb/types/messages'
import { rpsCommitment } from '@frank/wallet/message-item-plugins/rps/fair'
import enUS from '../../../i18n/en-us'
import ChatMessageRps from './ChatMessageRps.vue'

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
const start: RpsItem = {
  type: 'rps',
  action: 'start',
  matchId: 'm1',
  commitHash,
}
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
    global: { stubs: quasarStubs, mocks: { $t: t } },
  })
}

function chat(
  ...messages: {
    outbound: boolean
    item: RpsItem
    paid?: bigint
    status?: string
  }[]
) {
  store.activeConversation = {
    messages: messages.map(m => ({
      outbound: m.outbound,
      status: m.status ?? 'confirmed',
      items: [m.item],
      stampValueWei: m.paid ?? 0n,
    })),
  }
}

describe('ChatMessageRps.vue', () => {
  beforeEach(() => chat())

  test('a move answers the commitment the bot sent and carries the stake as its value', async () => {
    const wrapper = mountCard(start)
    // The commitment is a long hash: it is not printed on the card, and is there on hover.
    expect(wrapper.text()).not.toContain(commitHash)
    expect(
      wrapper.get('[data-testid="rps-committed"]').attributes('title'),
    ).toBe(commitHash)
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

  test('a free move carries no stake and no stamp', async () => {
    const wrapper = mountCard(start)
    await wrapper.find('[data-testid="rps-rock"]').trigger('click')
    const [payload] = wrapper.emitted('sendFollowUp')![0] as [any]
    // An explicit zero: left out, the chat's ordinary stamp was charged for a free game.
    expect(payload.stampValueWei).toBe(0n)
    expect(payload.items[0].wagerWei).toBe('0')
  })

  test('a move whose send failed is shown as not sent, not as moved or awaited', () => {
    chat({ outbound: true, item: mine, status: 'error' })
    const card = mountCard(start)
    expect(card.find('[data-testid="rps-move-not-sent"]').text()).toBe(
      enUS.gameFairness.moveNotSent,
    )
    expect(card.find('[data-testid="rps-moved"]').exists()).toBe(false)
    // The failed message is in the chat with its Retry: no second move is offered beside it.
    expect(card.find('[data-testid="rps-rock"]').exists()).toBe(false)
    // The move's own bubble does not count seconds for an answer that cannot come.
    const bubble = mountCard(store.activeConversation.messages[0].items[0])
    expect(bubble.find('[data-testid="rps-waiting"]').exists()).toBe(false)
  })

  test('a move that went out reads as moved', () => {
    chat({ outbound: true, item: mine })
    const card = mountCard(start)
    expect(card.find('[data-testid="rps-moved"]').exists()).toBe(true)
    expect(card.find('[data-testid="rps-move-not-sent"]').exists()).toBe(false)
  })

  test('a match already played offers no second move', () => {
    chat({ outbound: true, item: mine })
    expect(mountCard(start).find('[data-testid="rps-rock"]').exists()).toBe(
      false,
    )
  })

  test('an honest reveal of a match the player moved in shows as verified', () => {
    chat(
      { outbound: true, item: mine },
      { outbound: false, item: resolved, paid: STAKE * 2n },
    )
    const wrapper = mountCard(resolved)
    expect(wrapper.find('[data-testid="rps-verified"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rps-not-verified"]').exists()).toBe(
      false,
    )
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

  test('a win is verified as an outcome; its payout is shown as claimed, or as short, never as verified', () => {
    chat(
      { outbound: true, item: mine },
      { outbound: false, item: resolved, paid: STAKE * 2n },
    )
    const paid = mountCard(resolved)
    expect(paid.find('[data-testid="rps-verified"]').exists()).toBe(true)
    expect(paid.find('[data-testid="rps-payout"]').text()).toContain(
      'not yet verified on chain',
    )
    chat(
      { outbound: true, item: mine },
      { outbound: false, item: resolved, paid: STAKE },
    )
    const short = mountCard(resolved)
    expect(short.find('[data-testid="rps-verified"]').exists()).toBe(true)
    expect(short.find('[data-testid="rps-payout"]').text()).toContain(
      'not been paid in full',
    )
  })

  test('a free match played by typing is checked against the commitment the bot sent first', () => {
    const typed: RpsItem = { ...resolved, wagerWei: '0' }
    chat({ outbound: false, item: start }, { outbound: false, item: typed })
    const wrapper = mountCard(typed)
    expect(wrapper.find('[data-testid="rps-verified"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rps-not-verified"]').exists()).toBe(
      false,
    )
    // A typed match whose reveal does not open that commitment is still caught.
    const forged: RpsItem = { ...typed, botMove: 'paper', outcome: 'lose' }
    chat({ outbound: false, item: start }, { outbound: false, item: forged })
    expect(
      mountCard(forged).find('[data-testid="rps-not-verified"]').exists(),
    ).toBe(true)
  })

  test('a move shows that it is waiting for the reveal, then that the bot has not answered', () => {
    store.activeConversation = {
      messages: [
        { outbound: true, items: [mine], serverTime: Date.now() - 3_000 },
      ],
    }
    const fresh = mountCard(store.activeConversation.messages[0].items[0])
    expect(fresh.find('[data-testid="rps-waiting"]').text()).toContain(
      'Waiting for the bot',
    )
    fresh.unmount()
    store.activeConversation.messages[0].serverTime = Date.now() - 200_000
    const late = mountCard(store.activeConversation.messages[0].items[0])
    expect(late.find('[data-testid="rps-waiting"]').text()).toContain(
      'has not answered',
    )
    late.unmount()
  })

  test('play again asks the bot for a new match, with no stamp', async () => {
    chat(
      { outbound: true, item: mine },
      { outbound: false, item: resolved, paid: STAKE * 2n },
    )
    const wrapper = mountCard(resolved)
    await wrapper.find('[data-testid="rps-play-again"]').trigger('click')
    expect(wrapper.emitted('sendFollowUp')![0][0]).toEqual({
      items: [{ type: 'text', text: '/rps' }],
      stampValueWei: 0n,
    })
  })
})
