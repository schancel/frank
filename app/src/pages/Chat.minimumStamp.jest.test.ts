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
jest.mock('../utils/messaging-state', () => ({
  messagingState: { status: 'ready' },
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

  it('keeps the observed subsidy-only basis with the native default', async () => {
    defaultStampQuote.mockResolvedValue({
      status: 'available',
      amount: 50_000n,
      minimumStamp: 42_000n,
      rateFeeCoverage: 'subsidy-only',
    })
    const self = fakeThis({ $t: (key: string) => key })
    await page.methods.refreshMinimumStamp.call(self)
    expect(self.defaultStampWei).toBe(50_000n)
    expect(self.defaultStampBasisNote).toBe('walletPanel.avuFeesExcluded')
  })

  it('labels a fixed native-unit fallback without claiming an AVU conversion', async () => {
    defaultStampQuote.mockResolvedValue({
      status: 'available',
      amount: 10n ** 16n,
      minimumStamp: 1n,
      pricingBasis: 'configured-fallback',
    })
    const self = fakeThis({ $t: (key: string) => key })
    await page.methods.refreshMinimumStamp.call(self)
    expect(self.defaultStampWei).toBe(10n ** 16n)
    expect(self.defaultStampBasisNote).toBe('chatInput.fixedStampFallback')
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

it('does not let an older fee failure replace a newer successful quote', async () => {
  let rejectOld!: (error: Error) => void
  defaultStampQuote.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectOld = reject
    }),
  )
  const self = fakeThis()
  const first = page.methods.refreshMinimumStamp.call(self)
  defaultStampQuote.mockResolvedValueOnce({
    status: 'available',
    amount: 50_000n,
    minimumStamp: 42_000n,
  })
  await page.methods.refreshMinimumStamp.call(self)
  rejectOld(new Error('old fee lookup failed'))
  await first
  expect(self.defaultStampWei).toBe(50_000n)
  expect(self.defaultStampFailure).toBe('')
})

it('a real fee failure stays unavailable until a later fresh quote succeeds', async () => {
  const self = fakeThis()
  defaultStampQuote.mockRejectedValueOnce(new Error('RPC unavailable'))
  await page.methods.refreshMinimumStamp.call(self)
  expect(self.defaultStampWei).toBeUndefined()
  expect(self.defaultStampFailure).toBe('missing-fee')
  defaultStampQuote.mockResolvedValueOnce({
    status: 'available',
    amount: 60_000n,
    minimumStamp: 45_000n,
  })
  await page.methods.refreshMinimumStamp.call(self)
  expect(self.defaultStampWei).toBe(60_000n)
  expect(self.minimumStampWei).toBe(45_000n)
})

describe('Chat.vue converged geometric stamp suggestion and per-message override (#820)', () => {
  it('pre-fills the geometric suggestion from verified peer stamp history and marks upward adjustments', () => {
    const self = fakeThis({
      defaultStampWei: 1_000n,
      minimumStampWei: 500n,
      chatStore: { getStampWei: () => undefined },
      peerMessages: [
        { outbound: true, stampValueWei: 1_000n },
        {
          outbound: false,
          stampValueWei: 4_000n,
          stampPaymentStatus: 'received',
        },
      ],
    })
    self.isDefaultStampMode = page.computed.isDefaultStampMode.call(self)
    self.peerStampSuggestion = page.computed.peerStampSuggestion.call(self)
    self.suggestedStampWei = page.computed.suggestedStampWei.call(self)
    self.lastPeerStampWei = page.computed.lastPeerStampWei.call(self)
    self.isSuggestedIncrease = page.computed.isSuggestedIncrease.call(self)

    // isqrt(1000 * 4000) = 2000; netReceived = 3000 so upward cap (1000 + 3000 = 4000) allows 2000
    expect(self.suggestedStampWei).toBe(2_000n)
    expect(self.lastPeerStampWei).toBe(4_000n)
    expect(self.isSuggestedIncrease).toBe(true)
    expect(page.computed.stampAmount.get.call(self)).toBe('2000')
  })

  it('resets a per-message stamp override back to the suggestion after sending a message', async () => {
    let storedOverride: bigint | undefined = 5_000n
    const setStampWei = jest.fn(
      ({ stampWei }: { address: string; stampWei?: bigint }) => {
        storedOverride = stampWei
      },
    )
    const sendDirectMessage = jest.fn(async () => ({ state: 'sent' }))
    const self = fakeThis({
      defaultStampWei: 1_000n,
      minimumStampWei: 500n,
      stampUnavailable: '',
      address: '0xPeer',
      recipientAddress: '0xPeer',
      conversation: { id: 'conv-peer' },
      attachments: [],
      message: 'hello',
      replyDigest: null,
      activeSendCount: 0,
      sendingMessage: false,
      bottom: true,
      getAcceptancePrice: () => 0,
      showStampPreparation: jest.fn(),
      sendDirectMessage,
      chatStore: {
        getStampWei: () => storedOverride,
        setStampWei,
      },
      peerMessages: [
        { outbound: true, stampValueWei: 1_000n },
        {
          outbound: false,
          stampValueWei: 4_000n,
          stampPaymentStatus: 'received',
        },
      ],
    })
    Object.defineProperty(self, 'isDefaultStampMode', {
      get: () => page.computed.isDefaultStampMode.call(self),
    })
    Object.defineProperty(self, 'stampAmount', {
      get: () => page.computed.stampAmount.get.call(self),
    })
    self.resetStampDefault = () => page.methods.resetStampDefault.call(self)

    // Before send: uses explicit override 5000
    expect(self.isDefaultStampMode).toBe(false)
    expect(self.stampAmount).toBe('5000')

    await page.methods.sendMessage.call(self, 'hello')

    expect(sendDirectMessage).toHaveBeenCalledWith(
      expect.objectContaining({ stampValue: 5_000n }),
    )
    // After send: override is cleared and composer returns to the converged suggestion (2000)
    expect(setStampWei).toHaveBeenCalledWith({
      address: 'conv-peer',
      stampWei: undefined,
    })
    expect(self.isDefaultStampMode).toBe(true)
    expect(self.stampAmount).toBe('2000')
  })
})

