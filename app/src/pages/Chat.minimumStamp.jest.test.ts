/** @jest-environment jsdom */
// Default quotes use the adapter floor; explicit choices are shown unchanged.

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))
let mockWallet = { id: 'wallet' }
jest.mock('../accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => mockWallet }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => {
  const chain = {
    activeChain: {
      fromDisplayAmount: (s: string) => BigInt(s),
      toDisplayAmount: (n: bigint) => n.toString(),
      unit: 'MON',
      nativeTransfers: { getBalance: jest.fn() },
      directMessages: { defaultStampQuote: jest.fn() },
    },
  }
  return { ...chain, getActiveChain: () => chain.activeChain }
})
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('../utils/own-address', () => ({
  getOwnCanonicalAddress: async () => '0xMe',
  sameCanonicalAddress: (a: string, b: string) => a === b,
  useReactiveOwnCanonicalAddress: () => ({ value: '0xMe' }),
}))

import ChatPage from './Chat.vue'
import { activeChain } from '@frank/wallet/chain'

const page = ChatPage as unknown as {
  methods: Record<string, any>
  computed: Record<string, any>
}
const defaultStampQuote = activeChain.directMessages
  .defaultStampQuote as jest.Mock

function fakeThis(over: Record<string, unknown> = {}) {
  return {
    minimumStampWei: 0n,
    defaultStampWei: 1_000n,
    stampQuoteSequence: 0,
    recipientAddress: '0xPeer',
    conversation: undefined,
    chatStore: {
      getStampWei: () => 1_000n,
    },
    getStampAmount: () => '1000',
    ...over,
  } as Record<string, any>
}

describe('Chat.vue minimum stamp', () => {
  beforeEach(() => defaultStampQuote.mockReset())

  it('asks the wallet, with the open wallet, and keeps its answer', async () => {
    defaultStampQuote.mockResolvedValue({
      status: 'available',
      amount: 50_000n,
      minimumStamp: 42_000n,
    })
    const self = fakeThis()
    await page.methods.refreshMinimumStamp.call(self)
    expect(defaultStampQuote).toHaveBeenCalledWith({ wallet: mockWallet })
    expect(self.minimumStampWei).toBe(42_000n)
    expect(self.defaultStampWei).toBe(50_000n)
  })

  it('makes the default unavailable when the wallet cannot quote', async () => {
    defaultStampQuote.mockRejectedValue(new Error('node did not answer'))
    const self = fakeThis({ minimumStampWei: 42_000n })
    await page.methods.refreshMinimumStamp.call(self)
    expect(self.minimumStampWei).toBe(42_000n)
    expect(self.defaultStampWei).toBeUndefined()
    expect(self.defaultStampFailure).toBe('missing-fee')
  })

  it('preserves explicit amounts below the floor and zero free messages', () => {
    const chosen = (stampWei: bigint) =>
      fakeThis({
        minimumStampWei: 42_000n,
        chatStore: { getStampWei: () => stampWei },
      })
    expect(page.computed.stampAmount.get.call(chosen(5_000n))).toBe('5000')
    // A choice above the minimum is left as it is.
    expect(page.computed.stampAmount.get.call(chosen(90_000n))).toBe('90000')
    // No stamp at all is the user's choice of a free message: never raised.
    expect(page.computed.stampAmount.get.call(chosen(0n))).toBe('0')
  })
})

it('only explicit reset clears a conversation choice; matching the quote stays explicit', () => {
  const setStampWei = jest.fn()
  const self = fakeThis({ defaultStampWei: 1000n, chatStore: { setStampWei } })
  page.computed.stampAmount.set.call(self, '1000')
  expect(setStampWei).toHaveBeenLastCalledWith({
    address: '0xPeer',
    stampWei: 1000n,
  })
  page.methods.resetStampDefault.call(self)
  expect(setStampWei).toHaveBeenLastCalledWith({
    address: '0xPeer',
    stampWei: undefined,
  })
})

it('discards a quote that resolves after its messaging wallet changes', async () => {
  const original = mockWallet
  let finish!: (quote: unknown) => void
  defaultStampQuote.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    }),
  )
  const self = fakeThis({ defaultStampWei: 1_000n })
  const waiting = page.methods.refreshMinimumStamp.call(self)
  mockWallet = { id: 'replacement' }
  finish({ status: 'available', amount: 50_000n, minimumStamp: 42_000n })
  await waiting
  expect(self.defaultStampWei).toBeUndefined()
  mockWallet = original
})
