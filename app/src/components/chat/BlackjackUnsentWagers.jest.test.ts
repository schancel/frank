/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h, reactive } from 'vue'

import BlackjackUnsentWagers from './BlackjackUnsentWagers.vue'
import enUS from '../../i18n/en-us'
import { formatBlackjackError } from '@frank/wallet/message-item-plugins/blackjack/game'
import { UnsentWager, useUnsentWagersStore } from '../../stores/unsent-wagers'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
    nativeTransfers: { getTransactionStatus: (a: unknown) => mockStatus(a) },
  },
}))
jest.mock('../../composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ wallet: 1 }),
}))
jest.mock('../../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => WALLET,
}))
const chatStore: { chats: Record<string, { messages: any[] }> } = reactive({
  chats: {},
}) as any
jest.mock('../../stores/chats', () => ({ useChatStore: () => chatStore }))
const mockStatus = jest.fn()

const WALLET = '0xWallet'
const DEALER = '0x1234567890abcdef1234567890abcdef1234abcd'
const HASH = `0x${'ab'.repeat(32)}`
const QBtn = defineComponent({
  props: {
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
  },
  setup:
    (props, { attrs }) =>
    () =>
      h('button', { ...attrs, disabled: props.disable }, props.label),
})
const tt = (key: string, params: Record<string, string> = {}) => {
  const v = key
    .split('.')
    .reduce((o: any, k) => o?.[k], enUS as Record<string, any>) as string
  return v.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '')
}
const record = (over: Partial<UnsentWager> = {}): UnsentWager => ({
  gameId: 'bj-1',
  wagerTxHash: HASH,
  dealerAddress: DEALER,
  walletAddress: WALLET,
  amountWei: '100000000000000000',
  createdAt: 1,
  state: 'paid',
  ...over,
})
const inbound = (item: Record<string, unknown>) => ({
  outbound: false,
  items: [item],
})

async function setup(submit: jest.Mock, wager: UnsentWager = record()) {
  const pinia = createPinia()
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const store = useUnsentWagersStore()
  store.add(wager)
  const wrapper = mount(BlackjackUnsentWagers, {
    props: { address: DEALER, name: 'Blackjack Dealer', submit },
    global: { plugins: [pinia], components: { QBtn }, mocks: { $t: tt } },
  })
  await flushPromises()
  return { wrapper, store }
}
type W = Awaited<ReturnType<typeof setup>>['wrapper']
const q = (w: W, id: string) => w.find(`[data-testid="${id}"]`)

describe('BlackjackUnsentWagers (#310)', () => {
  beforeEach(() => {
    mockStatus.mockReset().mockResolvedValue('confirmed')
    for (const k of Object.keys(chatStore.chats)) delete chatStore.chats[k]
    chatStore.chats[DEALER] = { messages: [] }
  })

  it('shows what was paid, to whom, and the transaction hash', async () => {
    const { wrapper } = await setup(jest.fn())
    const text = wrapper.text()
    expect(text).toContain('Wager paid, bet not delivered')
    expect(text).toContain('0.1 MON wager to Blackjack Dealer (0x1234...abcd)')
    expect(text).toContain(HASH)
  })

  it('shows nothing for other wallets or dealers, or while a flow is in flight', async () => {
    const { wrapper, store } = await setup(
      jest.fn(),
      record({ walletAddress: '0xOther' }),
    )
    expect(q(wrapper, 'blackjack-unsent').exists()).toBe(false)
    store.add(record({ wagerTxHash: '0xmine' }))
    store.setInFlight('0xmine', true)
    await flushPromises()
    expect(q(wrapper, 'blackjack-unsent').exists()).toBe(false)
  })

  it('Retry re-sends the bet for the SAME game and hash, never a new transfer; the record stays (sent) until the dealer replies', async () => {
    const submit = jest.fn().mockResolvedValue(undefined)
    const { wrapper, store } = await setup(submit)
    await q(wrapper, 'blackjack-unsent-retry').trigger('click')
    await flushPromises()
    expect(submit).toHaveBeenCalledWith({
      address: DEALER,
      items: [
        {
          type: 'blackjack-move',
          gameId: 'bj-1',
          action: 'bet',
          wagerTxHash: HASH,
        },
      ],
    })
    expect(store.wagers).toEqual([expect.objectContaining({ state: 'sent' })])
    expect(q(wrapper, 'blackjack-unsent').exists()).toBe(false) // waiting, not yet stale
  })

  it('a failed Retry keeps the record and says so; a double click sends once at a time', async () => {
    let fail!: (e: Error) => void
    const submit = jest.fn(() => new Promise<void>((_r, rej) => (fail = rej)))
    const { wrapper, store } = await setup(submit)
    void q(wrapper, 'blackjack-unsent-retry').trigger('click')
    void q(wrapper, 'blackjack-unsent-retry').trigger('click')
    await flushPromises()
    expect(submit).toHaveBeenCalledTimes(1)
    fail(new Error('relay down'))
    await flushPromises()
    expect(store.wagers).toEqual([expect.objectContaining({ state: 'paid' })])
    expect(q(wrapper, 'blackjack-unsent-status').text()).toBe(
      'Still not delivered: relay down',
    )
  })

  describe('a delivered bet (state sent) is forgotten only when the dealer replies', () => {
    const sent = () => record({ state: 'sent', sentAt: Date.now() })
    it('dealt hand -> removed', async () => {
      const { store } = await setup(jest.fn(), sent())
      chatStore.chats[DEALER].messages.push(
        inbound({ type: 'blackjack-move', gameId: 'bj-1', action: 'deal' }),
      )
      await flushPromises()
      expect(store.wagers).toEqual([])
    })
    it('"already authorized" (a duplicate of an accepted wager) -> removed', async () => {
      const { store } = await setup(jest.fn(), sent())
      chatStore.chats[DEALER].messages.push(
        inbound({
          type: 'text',
          text: formatBlackjackError(
            'bj-1',
            'this wager transaction has already authorized a blackjack game',
          ),
        }),
      )
      await flushPromises()
      expect(store.wagers).toEqual([])
    })
    it('a rejection (stake refunded) -> removed', async () => {
      const { store } = await setup(jest.fn(), sent())
      chatStore.chats[DEALER].messages.push(
        inbound({
          type: 'text',
          text: formatBlackjackError(
            'bj-1',
            'wager is below the table minimum',
          ),
        }),
      )
      await flushPromises()
      expect(store.wagers).toEqual([])
    })
    it('F2: "could not verify (unconfirmed)" keeps the record and offers Retry', async () => {
      const { wrapper, store } = await setup(jest.fn(), sent())
      chatStore.chats[DEALER].messages.push(
        inbound({
          type: 'text',
          text: formatBlackjackError(
            'bj-1',
            'could not verify your wager transaction on-chain (unconfirmed, or the hash was wrong)',
          ),
        }),
      )
      await flushPromises()
      expect(store.wagers).toHaveLength(1)
      expect(wrapper.text()).toContain('could not verify your payment yet')
      expect(q(wrapper, 'blackjack-unsent-retry').exists()).toBe(true)
    })
    it('a reply to another game does not clear it', async () => {
      const { store } = await setup(jest.fn(), sent())
      chatStore.chats[DEALER].messages.push(
        inbound({ type: 'blackjack-move', gameId: 'other', action: 'deal' }),
      )
      await flushPromises()
      expect(store.wagers).toHaveLength(1)
    })
    it('silence past the window offers Retry', async () => {
      const { wrapper } = await setup(
        jest.fn(),
        record({ state: 'sent', sentAt: Date.now() - 10 * 60_000 }),
      )
      expect(wrapper.text()).toContain('Waiting for the dealer')
      expect(q(wrapper, 'blackjack-unsent-retry').exists()).toBe(true)
    })
    it('a Retry is only answered by replies that arrive after it (an old "unconfirmed" does not count)', async () => {
      chatStore.chats[DEALER].messages.push(
        inbound({
          type: 'text',
          text: formatBlackjackError('bj-1', 'could not verify (unconfirmed)'),
        }),
      )
      const submit = jest.fn().mockResolvedValue(undefined)
      const { wrapper } = await setup(
        submit,
        record({ state: 'sent', sentAt: Date.now() }),
      )
      await q(wrapper, 'blackjack-unsent-retry').trigger('click')
      await flushPromises()
      expect(q(wrapper, 'blackjack-unsent').exists()).toBe(false)
    })
  })

  describe('a signed payment (may not be on chain) is reconciled with the node', () => {
    const signed = () => record({ state: 'signed' })
    it('after a reload it checks automatically: mined -> paid, offers Retry of the bet', async () => {
      const { wrapper, store } = await setup(jest.fn(), signed())
      expect(mockStatus).toHaveBeenCalledWith(
        expect.objectContaining({ txHash: HASH }),
      )
      expect(store.wagers).toEqual([expect.objectContaining({ state: 'paid' })])
      expect(q(wrapper, 'blackjack-unsent-retry').exists()).toBe(true)
    })
    it('failed on chain -> removed with a notice', async () => {
      mockStatus.mockResolvedValue('failed')
      const { wrapper, store } = await setup(jest.fn(), signed())
      expect(store.wagers).toEqual([])
      expect(q(wrapper, 'blackjack-unsent-notice').text()).toContain(
        'nothing was paid',
      )
    })
    it('unknown -> never auto-removed; explains and offers only a warned, explicit discard', async () => {
      mockStatus.mockResolvedValue('unknown')
      const { wrapper, store } = await setup(jest.fn(), signed())
      expect(store.wagers).toHaveLength(1)
      expect(q(wrapper, 'blackjack-unsent-status').text()).toContain(
        'does not know this payment',
      )
      expect(q(wrapper, 'blackjack-unsent-retry').exists()).toBe(false) // no bet before payment is proven
      await q(wrapper, 'blackjack-unsent-dismiss').trigger('click')
      expect(wrapper.text()).toContain('can lose the money')
      expect(store.wagers).toHaveLength(1) // still there until confirmed
      await q(wrapper, 'blackjack-unsent-dismiss-confirm').trigger('click')
      expect(store.wagers).toEqual([])
    })
    it('pending -> keeps waiting, and Check payment re-asks the node', async () => {
      mockStatus.mockResolvedValue('pending')
      const { wrapper, store } = await setup(jest.fn(), signed())
      expect(q(wrapper, 'blackjack-unsent-status').text()).toContain(
        'still pending',
      )
      mockStatus.mockResolvedValue('confirmed')
      await q(wrapper, 'blackjack-unsent-check').trigger('click')
      await flushPromises()
      expect(store.wagers).toEqual([expect.objectContaining({ state: 'paid' })])
    })
  })

  it('surfaces an unreadable saved-records error', async () => {
    const { wrapper, store } = await setup(jest.fn())
    store.loadError = 'boom'
    await flushPromises()
    expect(q(wrapper, 'blackjack-unsent-load-error').text()).toContain('boom')
  })
})
