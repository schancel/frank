/** @jest-environment jsdom */
// Chat.vue's minimum stamp: read from the wallet (`directMessages.minimumStamp`), and what the
// composer shows and sends is never below it. The real component methods and computed run
// against a minimal `this`.

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
const mockWallet = { id: 'wallet' }
jest.mock('../utils/clients', () => ({ useMonadWallet: () => mockWallet }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    fromDisplayAmount: (s: string) => BigInt(s),
    toDisplayAmount: (n: bigint) => n.toString(),
    unit: 'MON',
    defaultStampValue: 1_000n,
    nativeTransfers: { getBalance: jest.fn() },
    directMessages: { minimumStamp: jest.fn() },
  },
}))
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
const minimumStamp = activeChain.directMessages.minimumStamp as jest.Mock

function fakeThis(over: Record<string, unknown> = {}) {
  return {
    minimumStampWei: activeChain.defaultStampValue,
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
  beforeEach(() => minimumStamp.mockReset())

  it('asks the wallet, with the open wallet, and keeps its answer', async () => {
    minimumStamp.mockResolvedValue(42_000n)
    const self = fakeThis()
    await page.methods.refreshMinimumStamp.call(self)
    expect(minimumStamp).toHaveBeenCalledWith({ wallet: mockWallet })
    expect(self.minimumStampWei).toBe(42_000n)
  })

  it('keeps the last known minimum when the wallet cannot say', async () => {
    minimumStamp.mockRejectedValue(new Error('node did not answer'))
    const self = fakeThis({ minimumStampWei: 42_000n })
    await page.methods.refreshMinimumStamp.call(self)
    expect(self.minimumStampWei).toBe(42_000n)
  })

  it('shows, and so sends, no less than the minimum for a paid stamp: a stored choice below it is raised; zero stays zero, a free message', () => {
    const chosen = (stampWei: bigint) =>
      fakeThis({
        minimumStampWei: 42_000n,
        chatStore: { getStampWei: () => stampWei },
      })
    expect(page.computed.stampAmount.get.call(chosen(5_000n))).toBe('42000')
    // A choice above the minimum is left as it is.
    expect(page.computed.stampAmount.get.call(chosen(90_000n))).toBe('90000')
    // No stamp at all is the user's choice of a free message: never raised.
    expect(page.computed.stampAmount.get.call(chosen(0n))).toBe('0')
  })
})
