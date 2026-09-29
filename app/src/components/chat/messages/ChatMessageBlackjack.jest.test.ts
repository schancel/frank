/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import { formatBlackjackError } from '@frank/wallet/message-item-plugins/blackjack/game'
import ChatMessageBlackjack from './ChatMessageBlackjack.vue'

const DEALER = '0xDealer'
const PLAYER = '0xPlayer'
const store: { chats: Record<string, { messages: any[] }> } = reactive({
  chats: {},
}) as any

jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))
// A fresh provider per test: successful verifications are cached per provider object.
let mockProvider: {
  getTransaction: jest.Mock
  getTransactionReceipt: jest.Mock
}
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ provider: mockProvider }),
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
    fromDisplayAmount: (s: string) => BigInt(Math.round(Number(s) * 1e18)),
    nativeTransfers: { send: jest.fn() },
  },
}))

// Quasar renders nothing under the SSR build Jest aliases to: stub every Q* as a plain element.
function passthrough(tag: string) {
  return defineComponent({
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, {}, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, passthrough('div')]),
)
quasarStubs.QBtn = passthrough('button')

let ts = 0
const msg = (outbound: boolean, item: any) => ({
  outbound,
  status: 'ok',
  receivedTime: ++ts,
  serverTime: ts,
  outpoints: [],
  senderAddress: outbound ? PLAYER : DEALER,
  items: [item],
})
const HASH = `0x${'ab'.repeat(32)}`
const HASH2 = `0x${'cd'.repeat(32)}`
const bet = (g = 'g1') =>
  msg(true, {
    type: 'blackjack-move',
    gameId: g,
    action: 'bet',
    wagerTxHash: HASH,
  })
const deal = (g = 'g1') =>
  msg(false, {
    type: 'blackjack-move',
    gameId: g,
    action: 'deal',
    serverSeedHash: 'h',
    playerCards: [9, 10],
    dealerUpCard: 0,
  })
const dbl = (g = 'g1') =>
  msg(true, {
    type: 'blackjack-move',
    gameId: g,
    action: 'double',
    doubleWagerTxHash: HASH2,
  })
const card = (g = 'g1') =>
  msg(false, {
    type: 'blackjack-move',
    gameId: g,
    action: 'double',
    playerCards: [9, 10, 3],
  })
const err = (g: string, text = 'this hand has already been doubled') =>
  msg(false, { type: 'text', text: formatBlackjackError(g, text) })

async function mountItem(messages: any[], index: number) {
  store.chats[DEALER] = { messages }
  const item = (store.chats[DEALER].messages[index] as any).items[0]
  const wrapper = mount(ChatMessageBlackjack, {
    props: { item, address: DEALER },
    global: {
      components: quasarStubs,
      directives: { ripple: {} },
      mocks: { $q: {} },
    },
  })
  await flushPromises()
  return wrapper
}
const buttons = (w: any) => w.findAll('button').map((b: any) => b.text())

describe('ChatMessageBlackjack double lockout', () => {
  beforeEach(() => {
    mockProvider = {
      getTransaction: jest.fn(async () => ({
        from: '0xPlayer',
        to: '0xDealer',
        value: 100n,
      })),
      getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
    }
    for (const k of Object.keys(store.chats)) delete store.chats[k]
  })

  it('shows hit/stand and the dealer error on the double item once the error for this game arrives', async () => {
    const w = await mountItem([bet(), deal(), dbl(), err('g1')], 2)
    expect(buttons(w)).toEqual(['Hit', 'Stand'])
    expect(w.text()).toContain('this hand has already been doubled')
  })

  it('stays locked for an error naming a different game', async () => {
    const w = await mountItem([bet(), deal(), dbl(), err('other-game')], 2)
    expect(buttons(w)).toEqual([])
    expect(w.text()).not.toContain('already been doubled')
  })

  it('ignores an untagged "Blackjack: ..." text', async () => {
    const w = await mountItem(
      [
        bet(),
        deal(),
        dbl(),
        msg(false, { type: 'text', text: 'Blackjack: nope' }),
      ],
      2,
    )
    expect(buttons(w)).toEqual([])
  })

  it('stays locked while the double is pending with no reply', async () => {
    const w = await mountItem([bet(), deal(), dbl()], 2)
    expect(buttons(w)).toEqual([])
  })

  it('recomputes when the error arrives after mount (live update)', async () => {
    const w = await mountItem([bet(), deal(), dbl()], 2)
    expect(buttons(w)).toEqual([])
    store.chats[DEALER].messages.push(err('g1'))
    await flushPromises()
    expect(buttons(w)).toEqual(['Hit', 'Stand'])
    expect(w.text()).toContain('already been doubled')
  })

  it('accepted double: the card arrives, no unlock, older item is read-only', async () => {
    const messages = [bet(), deal(), dbl(), card()]
    const oldItem = await mountItem(messages, 2)
    expect(buttons(oldItem)).toEqual([])
    const latest = await mountItem(messages, 3)
    expect(buttons(latest)).toEqual([])
    expect(latest.text()).toContain('(24)')
  })

  it('error then card: the authoritative card wins over the earlier unlock', async () => {
    const w = await mountItem([bet(), deal(), dbl(), err('g1'), card()], 4)
    expect(buttons(w)).toEqual([])
    expect(w.text()).toContain('(24)')
    expect(w.text()).not.toContain('already been doubled')
  })

  it('a card followed by a stale error does not unlock', async () => {
    const w = await mountItem([bet(), deal(), dbl(), card(), err('g1')], 3)
    expect(buttons(w)).toEqual([])
    expect(w.find('[role="status"]').text()).toBe('')
    expect(w.text()).not.toContain('already been doubled')
  })

  it('reload: a fresh mount over the same history shows the unlocked hand', async () => {
    const history = [bet(), deal(), dbl(), err('g1')]
    const first = await mountItem(history, 2)
    first.unmount()
    const reloaded = await mountItem(history, 2)
    expect(buttons(reloaded)).toEqual(['Hit', 'Stand'])
  })

  it('only the latest item of a game offers actions', async () => {
    const w = await mountItem([bet(), deal()], 0)
    expect(buttons(w)).toEqual([])
    const latest = await mountItem([bet(), deal()], 1)
    expect(buttons(latest)).toEqual([
      'Hit',
      'Stand',
      expect.stringMatching(/^Double down/),
    ])
  })

  it('a stale load resolving after a newer one does not overwrite it', async () => {
    let releaseStale!: () => void
    const gate = new Promise<void>(r => (releaseStale = r))
    mockProvider.getTransaction = jest
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return { from: '0xPlayer', to: '0xDealer', value: 100n }
      })
      .mockImplementation(async () => ({
        from: '0xPlayer',
        to: '0xDealer',
        value: 500n,
      }))
    store.chats[DEALER] = { messages: [bet(), deal()] }
    const item = (store.chats[DEALER].messages[1] as any).items[0]
    const w = mount(ChatMessageBlackjack, {
      props: { item, address: DEALER },
      global: {
        components: quasarStubs,
        directives: { ripple: {} },
        mocks: { $q: {} },
      },
    })
    await flushPromises() // load 1 is parked on the gate
    store.chats[DEALER].messages.push(msg(false, { type: 'text', text: 'hi' }))
    await flushPromises() // load 2 completes with the fresh 500n value
    expect(buttons(w)[2]).toContain('5e-16')
    releaseStale()
    await flushPromises() // stale load 1 finishes last
    expect(buttons(w)[2]).toContain('5e-16')
    expect(buttons(w)[2]).not.toContain('1e-16')
  })
})
