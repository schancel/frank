/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import { formatBlackjackError } from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  deriveDeck,
  handValue,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/blackjack/deck'
import { resolveOutcome } from '@frank/wallet/message-item-plugins/blackjack/game'
import enUS from '../../../i18n/en-us'
import ChatMessageBlackjack from './ChatMessageBlackjack.vue'

const DEALER = '0xDealer'
const PLAYER = '0xPlayer'
beforeEach(() => setActivePinia(createPinia()))
jest.mock('../../../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => PLAYER,
}))
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
quasarStubs.QBtn = defineComponent({
  props: { label: null, disable: null },
  setup(props, { slots, attrs }) {
    return () =>
      h('button', { ...attrs, disabled: !!props.disable }, [
        props.label as string | undefined,
        slots.default?.(),
      ])
  },
})
quasarStubs.QCheckbox = defineComponent({
  inheritAttrs: false,
  props: { modelValue: null, label: null },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () =>
      h('label', {}, [
        h('input', {
          ...attrs,
          type: 'checkbox',
          checked: !!props.modelValue,
          onChange: (e: Event) =>
            emit('update:modelValue', (e.target as HTMLInputElement).checked),
        }),
        props.label as string | undefined,
      ])
  },
})

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

// Every mounted bubble keeps watching the shared store, so unmount them between tests.
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})

async function mountItem(messages: any[], index: number) {
  store.chats[DEALER] = { messages }
  const item = (store.chats[DEALER].messages[index] as any).items[0]
  const wrapper = mount(ChatMessageBlackjack, {
    props: { item, address: DEALER },
    global: {
      components: quasarStubs,
      directives: { ripple: {} },
      mocks: { $q: {}, $t: (key: string) => key },
    },
  })
  mounted.push(wrapper)
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
        mocks: { $q: {}, $t: (key: string) => key },
      },
    })
    mounted.push(w)
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

describe('ChatMessageBlackjack bet and payout lines (ticket #368)', () => {
  // The real en-us messages, {name} placeholders substituted.
  const $t = (key: string, params: Record<string, unknown> = {}) => {
    const value = key
      .split('.')
      .reduce<any>((o, k) => o?.[k], enUS as Record<string, unknown>)
    return typeof value === 'string'
      ? value.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
      : key
  }
  const TENTH = 100_000_000_000_000_000n // 0.1 MON

  async function mountWithT(messages: any[], index: number) {
    store.chats[DEALER] = { messages }
    const item = (store.chats[DEALER].messages[index] as any).items[0]
    const wrapper = mount(ChatMessageBlackjack, {
      props: { item, address: DEALER },
      global: {
        components: quasarStubs,
        directives: { ripple: {} },
        mocks: { $q: {}, $t },
      },
    })
    mounted.push(wrapper)
    for (let i = 0; i < 50 && wrapper.text().includes('Loading'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await flushPromises()
    }
    return wrapper
  }
  const stand = () =>
    msg(true, { type: 'blackjack-move', gameId: 'g1', action: 'stand' })
  beforeEach(() => {
    mockProvider = {
      getTransaction: jest.fn(async () => ({
        from: PLAYER,
        to: DEALER,
        value: TENTH,
      })),
      getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
    }
    for (const k of Object.keys(store.chats)) delete store.chats[k]
  })

  it('the opening bet bubble names the verified bet instead of "Your hand: -"', async () => {
    const w = await mountWithT([bet()], 0)
    expect(w.text()).toContain('Your bet: 0.1 MON')
    expect(w.text()).toContain('Waiting for the dealer to deal.')
    expect(w.text()).not.toContain('Your hand')
  })

  it('an unverifiable wager is not put in the bubble: it says only "Your bet"', async () => {
    mockProvider.getTransaction = jest.fn(async () => null)
    const w = await mountWithT([bet()], 0)
    expect(w.text()).toContain('Your bet')
    expect(w.text()).not.toContain('MON')
  })

  it('once dealt, the bubble shows the hand again', async () => {
    const w = await mountWithT([bet(), deal()], 1)
    expect(w.text()).toContain('Your hand:')
    expect(w.text()).not.toContain('Your bet:')
  })

  // A genuinely fair hand (the seed's commitment, deck and outcome all check out), so the
  // fairness line passes; a stand right after the deal means no hits.
  function honestHand(wanted: string, dealerUnder17 = false) {
    for (let i = 0; i < 5000; i++) {
      const seed = `seed-${i}`
      const deck = deriveDeck(seed, HASH, 0)
      const player = [deck[0], deck[2]]
      let dealer = [deck[1], deck[3]]
      let next = 4
      if (!handValue(player).blackjack) {
        while (handValue(dealer).total < 17) dealer = [...dealer, deck[next++]]
      }
      const outcome = resolveOutcome(handValue(player), handValue(dealer))
      if (outcome !== wanted || handValue(player).bust) continue
      if (dealerUnder17 && handValue([deck[1], deck[3]]).total >= 17) continue
      return {
        dealMsg: msg(false, {
          type: 'blackjack-move',
          gameId: 'g1',
          action: 'deal',
          serverSeedHash: sha256Hex(seed),
          playerCards: player,
          dealerUpCard: deck[1],
        }),
        revealMsg: msg(false, {
          type: 'blackjack-move',
          gameId: 'g1',
          action: 'reveal',
          dealerCards: dealer,
          serverSeed: seed,
          outcome,
        }),
      }
    }
    throw new Error(`no seed found for ${wanted}`)
  }

  it.each([
    ['player_win', 'You win!', '0.2'],
    ['player_blackjack', 'Blackjack! You win 3:2.', '0.25'],
    ['push', 'Push', '0.1'],
  ])(
    'a fair resolved %s shows the payout as a promise from the dealer',
    async (outcome, text, amount) => {
      const { dealMsg, revealMsg } = honestHand(outcome)
      const w = await mountWithT([bet(), dealMsg, stand(), revealMsg], 3)
      expect(w.text()).toContain('Verified fair')
      expect(w.text()).toContain(text)
      const line = w.find('[data-testid="blackjack-payout"]').text()
      expect(line).toContain(`Payout: ${amount} MON`)
      expect(line).toContain('sent by the dealer after it reveals the hand')
    },
  )

  it('a fair natural against a dealer under 17 shows Verified fair (ticket #378)', async () => {
    const { dealMsg, revealMsg } = honestHand('player_blackjack', true)
    const w = await mountWithT([bet(), dealMsg, stand(), revealMsg], 3)
    expect(w.text()).toContain('Verified fair')
    expect(w.text()).not.toContain('Verification failed')
  })

  it('hides the payout when the fairness check failed', async () => {
    // Same outcome claim as a win, but the revealed seed does not match the commitment.
    const { dealMsg, revealMsg } = honestHand('player_win')
    const forged = {
      ...revealMsg,
      items: [{ ...(revealMsg.items[0] as object), serverSeed: 'forged' }],
    }
    const w = await mountWithT([bet(), dealMsg, stand(), forged], 3)
    expect(w.text()).toContain('Verification failed')
    expect(w.find('[data-testid="blackjack-payout"]').exists()).toBe(false)
  })

  it('a loss shows no payout line', async () => {
    const { dealMsg, revealMsg } = honestHand('dealer_win')
    const w = await mountWithT([bet(), dealMsg, stand(), revealMsg], 3)
    expect(w.text()).toContain('Dealer wins.')
    expect(w.find('[data-testid="blackjack-payout"]').exists()).toBe(false)
  })
})

describe('ChatMessageBlackjack unanswered dealer (ticket #366)', () => {
  const T0 = Date.parse('2026-09-30T12:00:00Z')
  const TIMEOUT = 45_000
  const SILENT = '[data-testid="dealer-silent"]'
  const sentAt = (m: any, time: number) => ({ ...m, serverTime: time })
  const stand = (time: number, g = 'g1') =>
    sentAt(
      msg(true, { type: 'blackjack-move', gameId: g, action: 'stand' }),
      time,
    )
  const dealerReply = (time: number, g = 'g1') =>
    sentAt(
      msg(false, {
        type: 'blackjack-move',
        gameId: g,
        action: 'reveal',
        dealerCards: [5, 6],
        serverSeed: 'x',
      }),
      time,
    )

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    jest.setSystemTime(T0)
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
  afterEach(() => {
    jest.useRealTimers()
  })

  const history = () => [
    sentAt(bet(), T0 - 20_000),
    sentAt(deal(), T0 - 10_000),
    stand(T0),
  ]

  it('shows nothing while a fresh move is still within the wait, then the not-answered state', async () => {
    const w = await mountItem(history(), 2)
    expect(w.find(SILENT).exists()).toBe(false)

    jest.advanceTimersByTime(TIMEOUT - 1)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)

    jest.advanceTimersByTime(1)
    await flushPromises()
    const box = w.find(SILENT)
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('blackjackDealer.silentTitle')
    expect(box.text()).toContain('blackjackDealer.silentWait')
    expect(box.text()).toContain('blackjackDealer.silentRefund')
  })

  it('offers a resend of a hit/stand only behind an explicit confirmation, once per consent', async () => {
    const w = await mountItem(history(), 2)
    jest.advanceTimersByTime(TIMEOUT)
    await flushPromises()
    const resend = () => w.find('[data-testid="dealer-resend"]')
    expect(resend().exists()).toBe(true)
    expect(resend().attributes('disabled')).toBeDefined()

    // Not consented: neither the disabled button nor the handler itself sends anything.
    ;(w.vm as any).onResend()
    await resend().trigger('click')
    expect(w.emitted('sendFollowUp')).toBeUndefined()

    await w.find('[data-testid="dealer-resend-confirm"]').setValue(true)
    expect(resend().attributes('disabled')).toBeUndefined()
    await resend().trigger('click')
    await resend().trigger('click')
    await flushPromises()
    expect(w.emitted('sendFollowUp')).toEqual([
      [
        {
          items: [{ type: 'blackjack-move', gameId: 'g1', action: 'stand' }],
        },
      ],
    ])
  })

  it('never lets a silent hit be pressed again without the confirmation', async () => {
    const hit = sentAt(
      msg(true, { type: 'blackjack-move', gameId: 'g1', action: 'hit' }),
      T0,
    )
    const w = await mountItem(
      [sentAt(bet(), T0 - 20_000), sentAt(deal(), T0 - 10_000), hit],
      2,
    )
    expect(buttons(w)).toEqual(['Hit', 'Stand'])
    jest.advanceTimersByTime(TIMEOUT)
    await flushPromises()
    const plain = w
      .findAll('button')
      .filter((b: any) => ['Hit', 'Stand'].includes(b.text()))
    expect(plain).toHaveLength(2)
    for (const b of plain) expect(b.attributes('disabled')).toBeDefined()
  })

  it('a wager (bet/double) cannot be re-sent: no resend control, an explanation instead', async () => {
    const w = await mountItem([sentAt(bet(), T0)], 0)
    jest.advanceTimersByTime(TIMEOUT)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(true)
    expect(w.find('[data-testid="dealer-resend"]').exists()).toBe(false)
    expect(w.find(SILENT).text()).toContain('blackjackDealer.silentNoResend')
  })

  it('is shown immediately when reloaded after the wait has already passed', async () => {
    jest.setSystemTime(T0 + 10 * 60_000)
    const w = await mountItem(history(), 2)
    expect(w.find(SILENT).exists()).toBe(true)
  })

  it('is silent from exactly the timeout boundary when mounted then', async () => {
    jest.setSystemTime(T0 + TIMEOUT)
    const w = await mountItem(history(), 2)
    expect(w.find(SILENT).exists()).toBe(true)
  })

  it('clears when the dealer answers late', async () => {
    const w = await mountItem(history(), 2)
    jest.advanceTimersByTime(TIMEOUT)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(true)

    store.chats[DEALER].messages.push(dealerReply(T0 + TIMEOUT + 5_000))
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)
  })

  it('does not fire after an answer arrives inside the wait', async () => {
    const w = await mountItem(history(), 2)
    store.chats[DEALER].messages.push(dealerReply(T0 + 5_000))
    await flushPromises()
    jest.advanceTimersByTime(TIMEOUT * 2)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)
  })

  it('an older bubble of the game does not claim the dealer is silent', async () => {
    const w = await mountItem(history(), 1)
    jest.advanceTimersByTime(TIMEOUT * 2)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)
  })

  it('a move that was never delivered (status error) is not reported as unanswered', async () => {
    const failed = { ...stand(T0), status: 'error' }
    const w = await mountItem(
      [sentAt(bet(), T0 - 20_000), sentAt(deal(), T0 - 10_000), failed],
      2,
    )
    jest.advanceTimersByTime(TIMEOUT * 2)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)
  })

  it('a stuck pending send (status pending) is not reported as unanswered', async () => {
    const pending = { ...stand(T0), status: 'pending' }
    const w = await mountItem(
      [sentAt(bet(), T0 - 20_000), sentAt(deal(), T0 - 10_000), pending],
      2,
    )
    jest.advanceTimersByTime(TIMEOUT * 2)
    await flushPromises()
    expect(w.find(SILENT).exists()).toBe(false)
  })

  it('the consent label interpolates the lower-case verb, not the button caption', async () => {
    store.chats[DEALER] = { messages: history() }
    const item = (store.chats[DEALER].messages[2] as any).items[0]
    const w = mount(ChatMessageBlackjack, {
      props: { item, address: DEALER },
      global: {
        components: quasarStubs,
        directives: { ripple: {} },
        mocks: {
          $q: {},
          $t: (key: string, p?: Record<string, unknown>) =>
            p?.action ? `${key}|${p.action}` : key,
        },
      },
    })
    mounted.push(w)
    await flushPromises()
    jest.advanceTimersByTime(TIMEOUT)
    await flushPromises()
    expect(
      w.find('[data-testid="dealer-resend-confirm"]').element.parentElement
        ?.textContent,
    ).toContain('blackjackDealer.resendConfirm|stand')
  })

  it('cancels its timer on unmount', async () => {
    const w = await mountItem(history(), 2)
    w.unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})
