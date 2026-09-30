/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h } from 'vue'

import BlackjackUnsentWagers from './BlackjackUnsentWagers.vue'
import enUS from '../../i18n/en-us'
import { useUnsentWagersStore } from '../../stores/unsent-wagers'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
  },
}))

jest.mock('../../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

const DEALER = '0x1234567890abcdef1234567890abcdef1234abcd'
const HASH = `0x${'ab'.repeat(32)}`
const QBtn = defineComponent({
  props: {
    label: { type: String, default: '' },
    disable: { type: Boolean, default: false },
  },
  setup: props => () => h('button', { disabled: props.disable }, props.label),
})
const tt = (key: string, params: Record<string, string> = {}) => {
  const v = key
    .split('.')
    .reduce((o: any, k) => o?.[k], enUS as Record<string, any>) as string
  return v.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '')
}

function setup(submit: jest.Mock) {
  const pinia = createPinia()
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const store = useUnsentWagersStore()
  store.add({
    gameId: 'bj-1',
    wagerTxHash: HASH,
    dealerAddress: DEALER,
    amountWei: '100000000000000000',
    createdAt: 1,
  })
  const wrapper = mount(BlackjackUnsentWagers, {
    props: { address: DEALER, name: 'Blackjack Dealer', submit },
    global: {
      plugins: [pinia],
      components: { QBtn },
      mocks: { $t: tt },
    },
  })
  return { wrapper, store }
}
const retryBtn = (w: ReturnType<typeof setup>['wrapper']) =>
  w.find('[data-testid="blackjack-unsent-retry"]')

describe('BlackjackUnsentWagers (#310)', () => {
  it('shows what was paid, to whom, and the transaction hash', () => {
    const { wrapper } = setup(jest.fn())
    const text = wrapper.text()
    expect(text).toContain('Wager paid, bet not delivered')
    expect(text).toContain('0.1 MON wager to Blackjack Dealer (0x1234...abcd)')
    expect(text).toContain(HASH)
  })

  it('shows nothing while the bet message is in flight, and for other chats', () => {
    const { wrapper, store } = setup(jest.fn())
    store.setInFlight(HASH, true)
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('[data-testid="blackjack-unsent"]').exists()).toBe(
        false,
      )
    })
  })

  it('Retry re-sends the bet for the SAME game and wager hash (never a new transfer), then clears the record', async () => {
    const submit = jest.fn().mockResolvedValue(undefined)
    const { wrapper, store } = setup(submit)
    await retryBtn(wrapper).trigger('click')
    await flushPromises()
    expect(submit).toHaveBeenCalledTimes(1)
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
    expect(store.wagers).toEqual([])
  })

  it('a failed Retry keeps the record and says so; a double click sends once at a time', async () => {
    let fail!: (e: Error) => void
    const submit = jest.fn(() => new Promise<void>((_r, rej) => (fail = rej)))
    const { wrapper, store } = setup(submit)
    void retryBtn(wrapper).trigger('click')
    void retryBtn(wrapper).trigger('click')
    await flushPromises()
    expect(submit).toHaveBeenCalledTimes(1)
    fail(new Error('relay down'))
    await flushPromises()
    expect(store.wagers).toHaveLength(1)
    expect(wrapper.find('[data-testid="blackjack-unsent-status"]').text()).toBe(
      'Still not delivered: relay down',
    )
    expect(retryBtn(wrapper).attributes('disabled')).toBeUndefined()
  })
})
