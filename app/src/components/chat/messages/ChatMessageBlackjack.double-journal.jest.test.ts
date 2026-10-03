/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createApp, defineComponent, h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { LevelDB } from 'level'

import ChatMessageBlackjack from './ChatMessageBlackjack.vue'
import BlackjackUnsentWagers from '../BlackjackUnsentWagers.vue'
import { createStoragePlugin } from '../../../boot/pinia'
import { useUnsentWagersStore } from '../../../stores/unsent-wagers'
import { formatBlackjackError } from '@frank/wallet/message-item-plugins/blackjack/game'

const PLAYER = '0xPlayer'
const DEALER = '0xDealer'
const ORIGINAL = `0x${'ab'.repeat(32)}`
const DOUBLE = `0x${'cd'.repeat(32)}`
const mockSend = jest.fn()
const mockStatus = jest.fn()
const mockBroadcast = jest.fn()
const mockGetWallet = jest.fn()
let mockOwnAddress = PLAYER
let mockProvider: any
const chat = reactive({ chats: {} as Record<string, { messages: any[] }> })
jest.mock('../../../stores/chats', () => ({ useChatStore: () => chat }))
jest.mock('../../../utils/clients', () => ({
  useMonadWallet: () => ({ provider: mockProvider }),
}))
jest.mock('../../../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => mockOwnAddress,
}))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: () => mockGetWallet(),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    toDisplayAmount: (n: bigint) => n.toString(),
    formatAddress: (a: { raw: string }) => a.raw,
    nativeTransfers: {
      send: (args: unknown) => mockSend(args),
      getTransactionStatus: (args: unknown) => mockStatus(args),
    },
  },
}))
const QBtn = defineComponent({
  props: ['label', 'disable'],
  setup: props => () => h('button', { disabled: props.disable }, props.label),
})
const wrappers: Array<{ unmount: () => void }> = []
let data: Record<string, string>
let rejectWrite: boolean
let holdWrite: Promise<void> | undefined
const submit = jest.fn()

async function boot() {
  const storage = {
    get: async (key: string) => {
      if (!(key in data)) throw new Error('not found')
      return data[key]
    },
    put: async (key: string, value: string) => {
      if (rejectWrite) throw new Error('disk full')
      await holdWrite
      data[key] = value
    },
  } as unknown as LevelDB
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage,
      Promise.resolve({ networkName: 'n', version: 1 }),
    ),
  )
  createApp({}).use(pinia)
  setActivePinia(pinia)
  const store = useUnsentWagersStore()
  await store.restored
  return { pinia, store }
}
async function bubble() {
  const { pinia, store } = await boot()
  const wrapper = mount(ChatMessageBlackjack, {
    props: { address: DEALER, item: chat.chats[DEALER].messages[1].items[0] },
    global: {
      plugins: [pinia],
      components: { QBtn },
      mocks: { $t: (key: string) => key },
      provide: { blackjackChat: { submit, stampWei: () => 0n } },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, store }
}
async function banner() {
  const { pinia, store } = await boot()
  const wrapper = mount(BlackjackUnsentWagers, {
    props: { address: DEALER, submit },
    global: {
      plugins: [pinia],
      components: { QBtn },
      mocks: { $t: (key: string) => key },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, store }
}
const doubleButton = (wrapper: any) =>
  wrapper.findAll('button').find((b: any) => b.text().startsWith('Double down'))
const stored = () => JSON.parse(data.unsentWagers).wagers
const expected = {
  gameId: 'game',
  kind: 'double',
  wagerTxHash: DOUBLE,
  originalWagerTxHash: ORIGINAL,
  originalAmountWei: '100',
  amountWei: '100',
  walletAddress: PLAYER,
  dealerAddress: DEALER,
}
const move = {
  address: DEALER,
  items: [
    {
      type: 'blackjack-move',
      gameId: 'game',
      action: 'double',
      doubleWagerTxHash: DOUBLE,
    },
  ],
}

beforeEach(() => {
  data = {}
  rejectWrite = false
  holdWrite = undefined
  mockOwnAddress = PLAYER
  mockGetWallet
    .mockReset()
    .mockResolvedValue({ identity: { address: { raw: PLAYER } } })
  submit.mockReset().mockResolvedValue(undefined)
  mockBroadcast.mockReset()
  mockStatus.mockReset().mockResolvedValue('confirmed')
  mockProvider = {
    getTransaction: jest.fn(async () => ({
      from: PLAYER,
      to: DEALER,
      value: 100n,
    })),
    getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
  }
  mockSend.mockReset().mockImplementation(async args => {
    await args.onSigned?.({ txHash: DOUBLE })
    mockBroadcast()
    return { txHash: DOUBLE }
  })
  chat.chats[DEALER] = {
    messages: [
      {
        outbound: true,
        senderAddress: PLAYER,
        items: [
          {
            type: 'blackjack-move',
            gameId: 'game',
            action: 'bet',
            wagerTxHash: ORIGINAL,
          },
        ],
      },
      {
        outbound: false,
        senderAddress: DEALER,
        items: [
          {
            type: 'blackjack-move',
            gameId: 'game',
            action: 'deal',
            serverSeedHash: 'h',
            playerCards: [9, 10],
            dealerUpCard: 0,
          },
        ],
      },
    ],
  }
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})

it('mounted double waits for the durable signed record before broadcasting and for receipt before relay delivery', async () => {
  const { wrapper, store } = await bubble()
  let release!: () => void
  holdWrite = new Promise<void>(resolve => {
    release = resolve
  })
  let confirm!: (status: string) => void
  mockStatus.mockImplementation(
    () =>
      new Promise(resolve => {
        confirm = resolve
      }),
  )
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(store.wagers).toEqual([
    expect.objectContaining({ ...expected, state: 'signed' }),
  ])
  expect(mockBroadcast).not.toHaveBeenCalled()
  release()
  await flushPromises()
  expect(stored()).toEqual([
    expect.objectContaining({ ...expected, state: 'signed' }),
  ])
  expect(mockBroadcast).toHaveBeenCalledTimes(1)
  expect(submit).not.toHaveBeenCalled()
  confirm('confirmed')
  await flushPromises()
  await store.flushPersistence()
  expect(submit).toHaveBeenCalledWith(move)
  expect(stored()).toEqual([
    expect.objectContaining({ ...expected, state: 'sent' }),
  ])
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(mockSend).toHaveBeenCalledTimes(1)
})

it('rejected journal write aborts before broadcast or relay delivery', async () => {
  const { wrapper, store } = await bubble()
  rejectWrite = true
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(mockBroadcast).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(store.wagers).toEqual([])
})

it('a lost broadcast response reconciles the same hash without a second transfer', async () => {
  mockSend.mockImplementation(async args => {
    await args.onSigned({ txHash: DOUBLE })
    mockBroadcast()
    throw new Error('response lost')
  })
  const { wrapper } = await bubble()
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(mockStatus).toHaveBeenCalledWith(
    expect.objectContaining({ transaction: { txHash: DOUBLE } }),
  )
  expect(submit).toHaveBeenCalledWith(move)
  expect(mockSend).toHaveBeenCalledTimes(1)
})

it.each(['signed', 'paid', 'sent'])(
  'reload at %s retries the exact double and never pays again',
  async state => {
    data.unsentWagers = JSON.stringify({
      wagers: [
        { ...expected, state, createdAt: 1, sentAt: 1, seenMessages: 2 },
      ],
    })
    const { wrapper, store } = await banner()
    await wrapper.get('[data-testid="blackjack-unsent-retry"]').trigger('click')
    await flushPromises()
    expect(submit).toHaveBeenCalledWith(move)
    expect(mockSend).not.toHaveBeenCalled()
    expect(store.wagers).toHaveLength(1)
    // A delayed first-bet reply must not clear a double, even after a retry.
    chat.chats[DEALER].messages.push({
      outbound: false,
      items: [{ type: 'blackjack-move', gameId: 'game', action: 'deal' }],
    })
    await flushPromises()
    expect(store.wagers).toHaveLength(1)
    chat.chats[DEALER].messages.push({
      outbound: false,
      items: [
        {
          type: 'blackjack-move',
          gameId: 'game',
          action: 'double',
          playerCards: [9, 10, 3],
        },
      ],
    })
    await flushPromises()
    expect(store.wagers).toEqual([])
  },
)

it('a reloaded hand with an unresolved double cannot sign a second stake', async () => {
  data.unsentWagers = JSON.stringify({
    wagers: [{ ...expected, state: 'signed', createdAt: 1 }],
  })
  const { wrapper } = await bubble()
  expect(doubleButton(wrapper).attributes('disabled')).toBeDefined()
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(mockSend).not.toHaveBeenCalled()
})

it('a relay failure retains the durable paid intent for retry', async () => {
  submit.mockRejectedValueOnce(new Error('relay offline'))
  const { wrapper, store } = await bubble()
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  await store.flushPersistence()
  expect(stored()).toEqual([
    expect.objectContaining({ ...expected, state: 'paid' }),
  ])
  wrapper.unmount()
  const recovery = await banner()
  await recovery.wrapper
    .get('[data-testid="blackjack-unsent-retry"]')
    .trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenNthCalledWith(2, move)
  expect(mockSend).toHaveBeenCalledTimes(1)
})

it('a reply received before submit resolves is not skipped; ambiguous game errors never clear a double', async () => {
  data.unsentWagers = JSON.stringify({
    wagers: [{ ...expected, state: 'paid', createdAt: 1, seenMessages: 2 }],
  })
  let resolve!: () => void
  submit.mockImplementation(
    () =>
      new Promise<void>(r => {
        resolve = r
      }),
  )
  const { wrapper, store } = await banner()
  await wrapper.get('[data-testid="blackjack-unsent-retry"]').trigger('click')
  await flushPromises()
  expect(submit).toHaveBeenCalledTimes(1)
  for (const text of [
    'this wager transaction has already authorized a blackjack game',
    'wager is below the table minimum',
    'this hand has already been doubled',
  ]) {
    chat.chats[DEALER].messages.push({
      outbound: false,
      items: [{ type: 'text', text: formatBlackjackError('game', text) }],
    })
  }
  resolve()
  await flushPromises()
  expect(store.wagers).toHaveLength(1)
  store.setState(DOUBLE, 'sent', 1, 2)
  await flushPromises()
  await wrapper.get('[data-testid="blackjack-unsent-retry"]').trigger('click')
  await flushPromises()
  chat.chats[DEALER].messages.push({
    outbound: false,
    items: [
      {
        type: 'blackjack-move',
        gameId: 'game',
        action: 'double',
        playerCards: [9, 10, 3],
      },
    ],
  })
  resolve()
  await flushPromises()
  expect(store.wagers).toEqual([])
  expect(mockSend).not.toHaveBeenCalled()
})

it('a definitively failed payment is removed without submitting a move', async () => {
  mockStatus.mockResolvedValue('failed')
  const { wrapper, store } = await bubble()
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(submit).not.toHaveBeenCalled()
  expect(store.wagers).toEqual([])
  expect(wrapper.text()).toContain('blackjackBet.errorPaymentFailed')
})

it('an account switch before signing aborts the double without broadcasting', async () => {
  mockGetWallet
    .mockResolvedValueOnce({ identity: { address: { raw: PLAYER } } })
    .mockResolvedValue({ identity: { address: { raw: '0xOther' } } })
  const { wrapper, store } = await bubble()
  await doubleButton(wrapper).trigger('click')
  await flushPromises()
  expect(mockBroadcast).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(store.wagers).toEqual([])
})

it('retry refuses an account changed since the banner mounted', async () => {
  data.unsentWagers = JSON.stringify({
    wagers: [{ ...expected, state: 'paid', createdAt: 1 }],
  })
  const { wrapper, store } = await banner()
  mockOwnAddress = '0xOther'
  await wrapper.get('[data-testid="blackjack-unsent-retry"]').trigger('click')
  await flushPromises()
  expect(submit).not.toHaveBeenCalled()
  expect(mockSend).not.toHaveBeenCalled()
  expect(store.wagers).toHaveLength(1)
})
